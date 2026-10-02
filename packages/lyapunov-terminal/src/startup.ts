import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ModelSelection, SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { highestReasoningEffort } from './format.ts'

export interface TerminalStartupConfig {
  cwd?: string
  sessionId?: string
  continueLast?: boolean
  fork?: boolean
  provider?: string
  model?: string
  reasoningEffort?: string
  agentPreset?: string
  prompt?: string
  promptMode?: 'send' | 'prefill'
}

export const TerminalStartupSchema: Schema<TerminalStartupConfig> = Schema.object({
  cwd: Schema.string(), sessionId: Schema.string(), continueLast: Schema.boolean(), fork: Schema.boolean(),
  provider: Schema.string(), model: Schema.string(), reasoningEffort: Schema.string(), agentPreset: Schema.string(), prompt: Schema.string(), promptMode: Schema.union(['send', 'prefill']),
})

export interface TerminalStartupResult {
  sessionId: SessionId
  disposition: 'created' | 'resumed' | 'continued' | 'forked'
  sourceSessionId?: SessionId
  cwd: string
  prompt?: string
  promptMode?: 'send' | 'prefill'
  selectedModel?: ModelSelection
}

async function existingDirectory(path: string): Promise<string> {
  const absolute = await realpath(resolve(path))
  if (!(await stat(absolute)).isDirectory()) throw new Error('项目路径不是目录：' + path)
  return absolute
}

/**
 * 按实际 cwd 在同一个原生 Workspace owner 里定位 Workspace：同路径复用已有注册，
 * 没有才创建（原生 `resolveByPath` + `registry.create`），因此不会为同一目录建第二个
 * Workspace，也不直接改写任何注册表文件。
 */
export async function ensureTerminalWorkspace(ctx: Context, directory: string, signal?: AbortSignal): Promise<WorkspaceId> {
  const controller = ctx.get('workspaceController')
  if (!controller) throw new Error('当前 Host 没有原生 Workspace 控制器，无法为项目目录建立归属。')
  signal?.throwIfAborted()
  // 原生 create 返回 `{ workspace, created }`：归属要用 workspace 自己的 id，不能把整个结果当视图。
  const resolved = await controller.create({ path: directory })
  signal?.throwIfAborted()
  return resolved.workspace.workspaceId
}

/**
 * 已有会话按原生 `attachSession` 挂到某个 Workspace；走的是与新建同一条
 * `session.create({ workspaceId })` 原生通道（含 header cwd 校验），不是第二份归属实现。
 */
export async function attachTerminalSession(ctx: Context, sessionId: SessionId, workspaceId: WorkspaceId, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await ctx.sessionController.create({ sessionId, workspaceId })
  signal?.throwIfAborted()
}

/** 会话是否已在原生 Workspace 的记账里；已归属的保持原样，不重复 attach、不改用户既有归属。 */
function accountedByWorkspace(ctx: Context, sessionId: SessionId): boolean {
  return ctx.get('workspaceRegistry')?.list().some(workspace => workspace.sessionIds.includes(sessionId)) ?? false
}

/** 当前项目的最近普通未归档会话；普通 fork 保留，子代理不参与自动选择。 */
export async function recentTerminalSession(ctx: Context, cwd: string, signal?: AbortSignal): Promise<SessionSummary | undefined> {
  const directory = await existingDirectory(cwd)
  const rows = (await ctx.sessionController.list({}, signal ?? new AbortController().signal)).items
  const archived = new Set(ctx.get('workspaceRegistry')?.archivedSessionIds ?? [])
  const candidates: SessionSummary[] = []
  for (const row of rows) {
    signal?.throwIfAborted()
    if (row.origin === 'subagent' || archived.has(row.sessionId) || row.cwd === undefined) continue
    let candidate: string
    try { candidate = await realpath(resolve(row.cwd)) } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
      throw error
    }
    if (candidate === directory) candidates.push(row)
  }
  return candidates.sort((left, right) => right.updatedAt - left.updatedAt || String(left.sessionId).localeCompare(String(right.sessionId)))[0]
}

/** 分支完全交给原生已完成 turn 前缀规则，不激活或改写父 Session。 */
export async function forkTerminalSession(ctx: Context, sessionId: SessionId, signal?: AbortSignal, atSeq?: number): Promise<{ sessionId: SessionId; sourceSessionId: SessionId }> {
  signal?.throwIfAborted()
  const row = (await ctx.sessionController.list({}, signal ?? new AbortController().signal)).items.find(item => item.sessionId === sessionId)
  if (row?.origin === 'subagent') throw new Error('不能把子代理作为普通终端分支来源。')
  signal?.throwIfAborted()
  const result = await ctx.sessionController.fork({ sessionId, ...(atSeq === undefined ? {} : { atSeq }) })
  return { sessionId: result.sessionId, sourceSessionId: sessionId }
}

/** 只准备原生会话和选择；返回初始 prompt，由已挂好监听的终端呈现层处理。 */
export async function startTerminalSession(ctx: Context, config: TerminalStartupConfig = {}, signal?: AbortSignal): Promise<TerminalStartupResult> {
  signal?.throwIfAborted()
  if (config.promptMode !== undefined && config.promptMode !== 'send' && config.promptMode !== 'prefill') throw new Error('promptMode 只接受 send 或 prefill。')
  if ((config.provider === undefined) !== (config.model === undefined)) throw new Error('启动模型需要同时提供 provider 和 model。')
  if (config.fork && !config.sessionId && !config.continueLast) throw new Error('--fork 需要继续一个既有会话。')
  const cwd = await existingDirectory(config.cwd ?? process.cwd())
  const recent = config.sessionId === undefined && config.continueLast ? await recentTerminalSession(ctx, cwd, signal) : undefined
  const source = config.sessionId === undefined ? recent?.sessionId : SessionId(config.sessionId)
  signal?.throwIfAborted()
  let sessionId: SessionId, disposition: TerminalStartupResult['disposition'], sourceSessionId: SessionId | undefined
  if (config.fork) {
    if (source === undefined) throw new Error('当前项目没有可分支的会话。')
    const result = await forkTerminalSession(ctx, source, signal)
    sessionId = result.sessionId; sourceSessionId = result.sourceSessionId; disposition = 'forked'
  } else if (source !== undefined) {
    sessionId = source; disposition = config.sessionId === undefined ? 'continued' : 'resumed'
  } else {
    // 新建会话先按实际 cwd 定位/创建原生 Workspace，再让原生 create 的 workspaceId 分支
    // 给出 cwd 并 attachSession：终端自己的会话因此从一开始就在 Workspace 导航里。
    const workspaceId = await ensureTerminalWorkspace(ctx, cwd, signal)
    const created = await ctx.sessionController.create({ workspaceId, ...(config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset }) })
    sessionId = created.sessionId; disposition = 'created'
  }
  signal?.throwIfAborted()
  const resolved = await ctx.sessionController.resolveAgent(sessionId)
  if ('error' in resolved) throw resolved.error
  const agent = resolved.agent
  // 继续/恢复/分支的会话按它自己的实际 cwd 归属：与新建同一条原生 attach 通道，但用会话自己的
  // header.cwd 定位 Workspace，而不是本次终端目录——原生 attach 通道要求 workspace.path 与 header cwd
  // 逐字相同（dsh-api-session-controller/src/agent.ts ensureSession），替用户改归属会直接失败。
  if (disposition !== 'created' && !accountedByWorkspace(ctx, sessionId)) {
    const directory = agent.session.header.cwd
    if (directory === undefined) throw new Error('会话没有 cwd，无法归属 Workspace。')
    await attachTerminalSession(ctx, sessionId, await ensureTerminalWorkspace(ctx, directory, signal), signal)
  }
  if (config.agentPreset !== undefined && disposition !== 'created') {
    const presets = ctx.get('agentPresets')
    if (!presets) throw new Error('当前 Host 没有 Agent preset 服务。')
    const existing = ctx.sessionProjections.stateOf(agent.session, 'agentPreset') ?? agent.session.header.agentPreset
    if (existing !== config.agentPreset) await presets.select(agent, config.agentPreset)
  }
  const selection = ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
  const previous = selection?.pending ?? selection?.lastUsed ?? ctx.agentDefaultModel.currentSelection()
  let selectedModel: ModelSelection | undefined = previous
  if (disposition === 'created' || config.model !== undefined || config.reasoningEffort !== undefined) {
    const route = config.model === undefined ? previous : { provider: config.provider!, model: config.model }
    const catalog = await ctx.sessionController.modelCatalog()
    const reasoningEffort = config.reasoningEffort ?? highestReasoningEffort(catalog, route.provider, route.model)
    selectedModel = (await ctx.sessionController.selectModel({ sessionId, provider: route.provider, model: route.model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })).selected
  }
  return {
    sessionId, disposition, cwd: agent.session.header.cwd ?? cwd,
    ...(sourceSessionId === undefined ? {} : { sourceSessionId }),
    ...(config.prompt === undefined ? {} : { prompt: config.prompt, promptMode: config.promptMode ?? (disposition === 'created' ? 'send' : 'prefill') }),
    ...(selectedModel === undefined ? {} : { selectedModel }),
  }
}
