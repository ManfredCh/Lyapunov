import { open, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-tool-todo'
import {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  readSessionLogText,
  sessionLogExportDeps,
  sessionLogZipFilename,
  streamSessionLogZip,
} from '@deepseek-ai/dsh-session-log-export'
import { terminalText } from './format.ts'
import { firstFrame, handleWorkspaceAction } from './workspace-actions.ts'
import type { HistoryOperationResult } from '../../lyapunov-session-undo/src/types.ts'

export interface TerminalActionInput {
  ctx: Context
  sessionId?: SessionId
  text: string
  signal: AbortSignal
}
export type TerminalActionResult =
  | { handled: false }
  | { handled: true; lines: string[]; selection?: SessionId | null; history?: HistoryOperationResult }

const verbs = new Set(['actions', 'rename', 'archive', 'queue', 'jobs', 'goal', 'todo', 'todos', 'workspace', 'workspaces', 'compact', 'undo', 'redo', 'undo_status', 'export'])
const commandNavigation = new Set(['compact', 'undo', 'redo', 'goal', 'export'])
const shown = (...lines: string[]): TerminalActionResult => ({ handled: true, lines: lines.map(terminalText) })
const json = (label: string, value: unknown) => shown(`[${label}]\n${JSON.stringify(value, null, 2)}`)
function selected(id: SessionId | undefined): SessionId {
  if (!id) throw new Error('请先 :new 或 :open 一个会话。')
  return id
}
function noArguments(value: string, verb: string): void {
  if (value) throw new Error(`用法：:${verb}（查看原生状态）。`)
}
async function agentFor(ctx: Context, id: SessionId): Promise<Agent> {
  const resolved = await ctx.sessionController.resolveAgent(id)
  if ('error' in resolved) throw resolved.error
  return resolved.agent
}
/** 将原生导出器的完整ZIP流写入新文件；不重写JSONL、不自建压缩格式。 */
async function exportArchive(input: TerminalActionInput, target: string): Promise<TerminalActionResult> {
  const id = selected(input.sessionId), deps = sessionLogExportDeps(input.ctx)
  if (!deps.sessionQuery || !deps.sessionPersistence || !deps.attachments) throw new Error('当前 Profile 未加载完整的原生会话导出服务。')
  const info = await input.ctx.sessionController.inspect(id, input.signal)
  const rawPath = target && /^("[\s\S]*"|'[\s\S]*')$/.test(target) ? target.slice(1, -1) : target
  const path = resolve(info.meta.cwd ?? process.cwd(), rawPath || sessionLogZipFilename(id))
  await flushLiveSessionLog(deps, id, input.signal)
  const content = await readSessionLogText(deps.sessionPersistence, id, input.signal)
  if (content === undefined) throw new Error('会话不存在，无法导出。')
  input.signal.throwIfAborted()
  const file = await open(path, 'wx', 0o600)
  let complete = false, bytes = 0
  try {
    const stream = streamSessionLogZip({ ...deps, sessionQuery: deps.sessionQuery, sessionPersistence: deps.sessionPersistence, attachments: deps.attachments }, content, id, true, DEFAULT_SESSION_LOG_COMPRESSION_LEVEL, input.signal)
    await stream.pipeTo(new WritableStream<Uint8Array>({
      async write(chunk) { await file.writeFile(chunk); bytes += chunk.byteLength },
    }), { signal: input.signal })
    complete = true
  } finally {
    await file.close()
    if (!complete) await unlink(path)
  }
  return shown(`[ZIP 已导出] ${path}`, `${bytes} 字节；原生会话日志、子会话与引用附件。`)
}

/** 用户可见的现成操作；仅组合原生公开服务，未知输入交回终端主入口。 */
export async function handleTerminalAction(input: TerminalActionInput): Promise<TerminalActionResult> {
  const parsed = /^:([^\s]+)(?:\s+([\s\S]*))?$/.exec(input.text.trim())
  if (!parsed || !verbs.has(parsed[1]!)) return { handled: false }
  input.signal.throwIfAborted()
  const verb = parsed[1]!, argument = parsed[2]?.trim() ?? '', { ctx } = input
  if (verb === 'actions') {
    noArguments(argument, verb)
    const commands = input.sessionId ? ctx.commands.list(await agentFor(ctx, input.sessionId)) : []
    const lines = [':rename <标题>  :archive [会话ID]  :queue  :jobs  :goal  :todo', ':workspaces（原生顺序）  :workspace <#序号|ID|前缀|标题> [top|end|up|down|before <锚点>]', ':export [ZIP文件路径]']
    const available = commands.filter(command => commandNavigation.has(command.name) || /(?:^|_)(?:undo|redo)$/.test(command.name))
    lines.push(available.length ? '当前原生命令：\n' + available.map(command => `/${command.name}${command.input?.hint ? ' ' + command.input.hint : ''} — ${command.description}`).join('\n') : '当前没有可显示的上述原生命令；选择会话后可用 :commands 查看实际注册表。')
    return shown(...lines)
  }
  if (verb === 'rename') {
    if (!argument) throw new Error('用法：:rename <新标题>。')
    const id = selected(input.sessionId), result = await ctx.sessionController.rename({ sessionId: id, title: argument })
    const live = ctx.sessions.get(id)
    if (live) await ctx.sessions.flush(live)
    return shown(`[已改名] ${result.title}`)
  }
  if (verb === 'archive') {
    const controller = ctx.get('workspaceController')
    if (!controller) return shown('当前 Profile 未提供原生 Workspace 归档服务。')
    const id = argument ? SessionId(argument) : selected(input.sessionId)
    const result = await controller.archiveSession({ sessionId: id })
    return shown(`[已归档] ${id}`, `[原生归档集合] ${JSON.stringify(result.archivedSessionIds)}`)
  }
  if (verb === 'workspaces' || verb === 'workspace') {
    const order = ctx.get('workspaceController')
    if (!order) return shown('当前 Profile 未提供原生 Workspace 服务。')
    // 顺序、选择与移动都由同一原生 Workspace owner 承担；远端 attach 传入同一结构接口，复用同一实现。
    return shown(...await handleWorkspaceAction(verb === 'workspaces' ? 'workspaces' : 'workspace', { order, sessionId: input.sessionId, argument, signal: input.signal }))
  }
  if (verb === 'queue') {
    noArguments(argument, verb)
    const id = selected(input.sessionId), frame = await firstFrame(ctx.sessionController.control(input.signal))
    if (frame.type !== 'baseline') throw new Error('原生会话控制流缺少 baseline。')
    return json('待处理队列', frame.value.queues[id] ?? [])
  }
  if (verb === 'jobs') {
    noArguments(argument, verb)
    const jobs = ctx.get('jobs')
    if (!jobs) return shown('当前 Profile 未加载原生 Jobs 服务。')
    return json('Jobs', jobs.list(await agentFor(ctx, selected(input.sessionId))))
  }
  if (verb === 'goal') {
    noArguments(argument, verb)
    const goals = ctx.get('goals')
    if (!goals) return shown('当前 Profile 未加载原生 Goal 服务。')
    const goal = goals.get(await agentFor(ctx, selected(input.sessionId)))
    return goal ? json('Goal', goal) : shown('当前会话没有 Goal。')
  }
  if (verb === 'todo' || verb === 'todos') {
    noArguments(argument, verb)
    const projections = ctx.get('sessionProjections')
    if (!projections) return shown('当前 Profile 未加载原生会话投影服务。')
    const agent = await agentFor(ctx, selected(input.sessionId)), values = projections.snapshot(agent.session, ['todos']).values
    if (!Object.hasOwn(values, 'todos')) return shown('当前会话没有注册 Todo 投影。')
    return values.todos === null ? shown('当前会话没有待办清单。') : json('Todo', values.todos)
  }
  if (verb === 'export') return exportArchive(input, argument)
  const agent = await agentFor(ctx, selected(input.sessionId))
  if (!ctx.commands.find(agent, verb)) return shown(`当前 Profile 未注册 /${verb}。`, '输入 :actions 或 :commands 查看实际可用命令。')
  const execution = await ctx.commands.execute(agent, '/' + verb + (argument ? ' ' + argument : ''), [], input.signal)
  if (!execution) return shown(`/${verb} 已不可用。`)
  await ctx.sessions.flush(agent.session)
  if (['undo', 'redo', 'undo_status'].includes(verb) && execution.result.kind === 'success' && execution.result.text) {
    const result = JSON.parse(execution.result.text) as HistoryOperationResult
    if (result.schema === 'lyapunov-history-v1' && result.sessionId === agent.id) return { handled: true, lines: [execution.result.text], history: result }
  }
  return shown(`[原生命令 /${verb} ${execution.result.kind}] ${execution.result.text ?? ''}`)
}
