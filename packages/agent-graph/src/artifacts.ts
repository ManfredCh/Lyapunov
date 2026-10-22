/**
 * Run-artifact 收集器 + 预算护栏（契约 §3.1 / §3.3）。
 *
 * 钩子：`ctx.on('tools/execute', waterfall)` —— 与 lyapunov-shell 的 CUA 漏斗、
 * web-fetch-failure 适配器同一条原生 waterfall（签名 `(exec, next) => Promise<ToolExecutionResult>`）。
 * handler 必须 `return next()` 否则断链；拦截 = 不调 next() 直接抛具名错误。
 *
 * 归属：会话里有活动 run（campaign_transition 进入活动状态时开，campaign_record_run 关闭）
 * 的调用才计数/记录；`campaign_*` 编排工具本身不进证据轨迹、不占预算（保证超限后
 * coordinator 仍能 record_run/transition 收尾）。无会话的调用原样放行。
 *
 * 预算：toolCalls 按已执行调用计 1；simSteps 按回执 stepIndex/startStep→endStep 增量累计；
 * wall 按 campaign.used.startedAt 到 now。任一维度超限 → 后续归属该 campaign 的调用在
 * dispatch 前抛 CAMPAIGN_BUDGET_EXCEEDED（**造成超限的当次调用允许完成**，避免半写状态）。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { sessionIdOf } from '../../lyapunov-contracts/src/session-scope.ts'
import type { Campaign, CampaignRun, CampaignTask, RunCallArtifact } from '../../lyapunov-contracts/src/agent-graph.ts'
import { CampaignStore } from './campaign-store.ts'
import { CAMPAIGN_PARTITION_VIOLATION, type RunRole } from './state-machine.ts'

export const CAMPAIGN_BUDGET_EXCEEDED = 'CAMPAIGN_BUDGET_EXCEEDED'
export const CAMPAIGN_VERIFIER_ISOLATION = 'CAMPAIGN_VERIFIER_ISOLATION'

const SCENE_MUTATION_TOOLS = new Set([
  'scene_edit', 'scene_restore', 'scene_import', 'scene_mount', 'scene_bind_physics', 'scene_physics_update',
  'robot_set_base', 'robot_set_tcp', 'robot_assembly_replace', 'robot_assembly_extract', 'robot_assembly_reassemble',
])

/** 内存中的 campaign 句柄：campaign.json 的最新读数 + 其落盘目录（缓存键）。 */
export interface CampaignHandle {
  campaign: Campaign
  dir: string
}

/** 会话里打开中的 run：calls 计数器与 simSteps 累计只在内存推进，文件是镜像。 */
export interface ActiveRun {
  runId: string
  campaignId: string
  taskId: string
  role: RunRole
  runDir: string
  handle: CampaignHandle
  /** 已写 calls.jsonl 的行数（含被预算闸拦截的尝试记录）。 */
  seq: number
  /** 真正 dispatch 过的调用数（run.json summary.toolCalls 的来源）。 */
  executedCalls: number
  simSteps: number
  lastStepIndex?: number
}

export interface BudgetBreach { limit: 'toolCalls' | 'simSteps' | 'wallSeconds'; used: number; max: number }

export class CampaignRuntime {
  private readonly handles = new Map<string, CampaignHandle>()
  private readonly openRuns = new Map<string, ActiveRun[]>()

  constructor(
    readonly store: CampaignStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async handleFor(owner: unknown, campaignId: string): Promise<CampaignHandle> {
    const dir = this.store.campaignDirFor(owner, campaignId)
    const cached = this.handles.get(dir)
    if (cached) return cached
    const campaign = await this.store.loadCampaign(owner, campaignId)
    const handle: CampaignHandle = { campaign, dir }
    this.handles.set(dir, handle)
    return handle
  }

  async createCampaign(owner: unknown, campaign: Campaign): Promise<CampaignHandle> {
    const dir = this.store.campaignDirFor(owner, campaign.campaignId)
    if (await this.store.campaignExists(dir)) {
      throw new Error(`CAMPAIGN_ALREADY_EXISTS: ${dir} 已有 campaign.json`)
    }
    await this.store.saveCampaignAt(dir, campaign)
    const handle: CampaignHandle = { campaign, dir }
    this.handles.set(dir, handle)
    return handle
  }

  /** 会话内当前活动 run（最近打开者优先）：无 → 该会话调用不进证据轨迹。 */
  currentRun(owner: unknown): ActiveRun | undefined {
    const key = sessionIdOf(owner)
    if (!key) return undefined
    const list = this.openRuns.get(key)
    return list?.[list.length - 1]
  }

  currentRunFor(owner: unknown, campaignId: string, taskId: string): ActiveRun | undefined {
    const key = sessionIdOf(owner)
    if (!key) return undefined
    const list = this.openRuns.get(key) ?? []
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.campaignId === campaignId && list[i]!.taskId === taskId) return list[i]
    }
    return undefined
  }

  openRunIds(owner: unknown, campaignId: string): string[] {
    const key = sessionIdOf(owner)
    if (!key) return []
    return (this.openRuns.get(key) ?? []).filter(run => run.campaignId === campaignId).map(run => run.runId)
  }

  /** 开 run：落 runs/<runId>/{run.json,calls.jsonl} 并登记到调用方会话。 */
  async openRun(owner: unknown, handle: CampaignHandle, task: CampaignTask, role: RunRole): Promise<ActiveRun> {
    const key = sessionIdOf(owner)
    if (!key) throw new Error(`SESSION_SCOPE_UNAVAILABLE: 开 run 需要可核实的会话`)
    const runId = `run-${randomUUID()}`
    const runDir = this.store.runDirFor(owner, handle.campaign.campaignId, runId)
    const record: CampaignRun = { runId, campaignId: handle.campaign.campaignId, taskId: task.taskId, role, calls: [] }
    await this.store.openRunAt(runDir, record)
    const active: ActiveRun = { runId, campaignId: record.campaignId, taskId: task.taskId, role, runDir, handle, seq: 0, executedCalls: 0, simSteps: 0 }
    const list = this.openRuns.get(key) ?? []
    list.push(active)
    this.openRuns.set(key, list)
    return active
  }

  /** 关闭会话内指定 (campaignId, taskId) 的活动 run：嵌入 calls 写最终 run.json。 */
  async closeRun(owner: unknown, campaignId: string, taskId: string, summary: NonNullable<CampaignRun['summary']>): Promise<CampaignRun> {
    const key = sessionIdOf(owner)
    const list = key ? this.openRuns.get(key) : undefined
    const index = list?.findIndex(run => run.campaignId === campaignId && run.taskId === taskId) ?? -1
    if (list === undefined || index < 0) {
      throw new Error(`CAMPAIGN_NO_ACTIVE_RUN: 本会话没有 (campaign=${campaignId}, task=${taskId}) 的活动 run 可关闭`)
    }
    const active = list[index]!
    list.splice(index, 1)
    const run: CampaignRun = { runId: active.runId, campaignId, taskId, role: active.role, calls: [], summary }
    await this.store.writeRunAt(active.runDir, run)
    run.calls = await this.store.loadRunAt(active.runDir).then(loaded => loaded?.calls ?? [])
    return run
  }

  /** 预算读数：任一维度达到上限即返回 breach（调用方决定拦截语义）。 */
  budgetExceeded(handle: CampaignHandle): BudgetBreach | undefined {
    const { budget, used } = handle.campaign
    if (used.toolCalls >= budget.maxToolCalls) return { limit: 'toolCalls', used: used.toolCalls, max: budget.maxToolCalls }
    if (used.simSteps >= budget.maxSimSteps) return { limit: 'simSteps', used: used.simSteps, max: budget.maxSimSteps }
    const elapsedSeconds = (this.now() - Date.parse(used.startedAt)) / 1000
    if (Number.isFinite(elapsedSeconds) && elapsedSeconds >= budget.maxWallSeconds) return { limit: 'wallSeconds', used: Math.floor(elapsedSeconds), max: budget.maxWallSeconds }
    return undefined
  }
}

/** result.value 及其内层 value.result（JSON 字符串/对象）里可读的对象层，供回执转录与步数增量共用。 */
function receiptSources(value: unknown): Record<string, unknown>[] {
  const sources: Record<string, unknown>[] = []
  if (value && typeof value === 'object' && !Array.isArray(value)) sources.push(value as Record<string, unknown>)
  const inner = (value as { result?: unknown } | undefined)?.result
  if (typeof inner === 'string') {
    try {
      const parsed = JSON.parse(inner) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) sources.push(parsed as Record<string, unknown>)
    } catch { /* result 不是 JSON：无内层回执可读 */ }
  } else if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    sources.push(inner as Record<string, unknown>)
  }
  return sources
}

/** result.value 里按契约转录的回执字段；value.result 是 JSON 字符串时解析后同样取。 */
export function extractReceipt(value: unknown): RunCallArtifact['receipt'] {
  const receipt: NonNullable<RunCallArtifact['receipt']> = {}
  for (const source of receiptSources(value)) {
    for (const key of ['generation', 'sceneRevision', 'startStep', 'endStep', 'status', 'taskAchieved', 'reason'] as const) {
      if (receipt[key] === undefined && source[key] !== undefined) (receipt as Record<string, unknown>)[key] = source[key]
    }
  }
  return Object.keys(receipt).length ? receipt : undefined
}

/** sim 步数增量：优先 startStep→endStep 区间；否则取 stepIndex 与本 run 上次读数的正差。 */
function simStepsDelta(run: ActiveRun, value: unknown): number {
  let stepIndex: number | undefined
  for (const source of receiptSources(value)) {
    const start = typeof source.startStep === 'number' ? source.startStep : undefined
    const end = typeof source.endStep === 'number' ? source.endStep : undefined
    if (start !== undefined && end !== undefined) {
      if (run.lastStepIndex === undefined || end > run.lastStepIndex) run.lastStepIndex = end
      return Math.max(0, end - start)
    }
    if (stepIndex === undefined && typeof source.stepIndex === 'number') stepIndex = source.stepIndex
  }
  if (stepIndex === undefined) return 0
  const delta = run.lastStepIndex === undefined ? 0 : Math.max(0, stepIndex - run.lastStepIndex)
  if (run.lastStepIndex === undefined || stepIndex > run.lastStepIndex) run.lastStepIndex = stepIndex
  return delta
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function buildArtifact(run: ActiveRun, exec: ToolDispatchExecution, settled: { result?: ToolExecutionResult; error?: unknown }): RunCallArtifact {
  const artifact: RunCallArtifact = {
    seq: ++run.seq,
    callId: String(exec.callId),
    tool: exec.name,
    argsDigest: createHash('sha256').update(JSON.stringify(exec.arguments ?? null)).digest('hex'),
    at: new Date().toISOString(),
  }
  if (settled.error !== undefined) artifact.error = errorMessage(settled.error)
  else if (settled.result?.isError) artifact.error = settled.result.error.message
  else {
    const receipt = extractReceipt(settled.result?.value)
    if (receipt) artifact.receipt = receipt
  }
  return artifact
}

/**
 * 安装 waterfall 拦截器。归属判定 = 调用方会话里是否有活动 run；
 * campaign_* 工具豁免（编排调用不进证据、不占预算）。
 */
export function applyArtifactCollector(ctx: Context, runtime: CampaignRuntime): void {
  ctx.on('tools/execute', async (exec, next) => {
    const run = runtime.currentRun(exec.agent)
    if (run === undefined || exec.name.startsWith('campaign_')) return next()
    if (run.role === 'verifier') {
      const rawArgs = JSON.stringify(exec.arguments ?? null)
      if (rawArgs.includes('.lyapunov/campaigns') || rawArgs.includes('.lyapunov\\campaigns')) {
        const message = `${CAMPAIGN_VERIFIER_ISOLATION}: verifier run ${run.runId} 禁止读取 .lyapunov/campaigns 下的 proposer 产物`
        await runtime.store.appendCallTo(run.runDir, buildArtifact(run, exec, { error: new Error(message) }))
        throw new Error(message)
      }
    }
    if (run.role === 'worker') {
      const raw = exec.arguments as { input?: { sceneId?: unknown }; sceneId?: unknown } | undefined
      const targetSceneId = typeof raw?.input?.sceneId === 'string' ? raw.input.sceneId : typeof raw?.sceneId === 'string' ? raw.sceneId : undefined
      if (targetSceneId !== undefined) {
        const currentTask = run.handle.campaign.tasks.find(t => t.taskId === run.taskId)
        const touchesHeldout = run.handle.campaign.tasks.some(t => t.partition === 'heldout' && t.sceneId === targetSceneId)
        if (touchesHeldout && (targetSceneId !== currentTask?.sceneId || SCENE_MUTATION_TOOLS.has(exec.name))) {
          const message = `${CAMPAIGN_PARTITION_VIOLATION}: worker run ${run.runId} 禁止访问或修改 heldout 场景 ${targetSceneId}`
          await runtime.store.appendCallTo(run.runDir, buildArtifact(run, exec, { error: new Error(message) }))
          throw new Error(message)
        }
      }
    }
    const breach = runtime.budgetExceeded(run.handle)
    if (breach !== undefined) {
      const message = `${CAMPAIGN_BUDGET_EXCEEDED}: campaign ${run.campaignId} 预算 ${breach.limit} 已用尽（${breach.used}/${breach.max}）；本 campaign 名下后续工具调用被拦截，已执行调用不受影响`
      // 拦截尝试本身留证（error 行）：预算闸开过火，谁、在哪个 callId 被挡。
      await runtime.store.appendCallTo(run.runDir, buildArtifact(run, exec, { error: new Error(message) }))
      throw new Error(message)
    }
    let result: ToolExecutionResult
    try {
      result = await next()
    } catch (error) {
      await runtime.store.appendCallTo(run.runDir, buildArtifact(run, exec, { error }))
      throw error
    }
    const artifact = buildArtifact(run, exec, { result })
    run.executedCalls += 1
    const delta = result.isError ? 0 : simStepsDelta(run, result.value)
    run.simSteps += delta
    run.handle.campaign.used.toolCalls += 1
    run.handle.campaign.used.simSteps += delta
    await runtime.store.appendCallTo(run.runDir, artifact)
    await runtime.store.saveCampaignAt(run.handle.dir, run.handle.campaign)
    return result
  })
}
