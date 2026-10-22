/**
 * lyapunov-agent-graph（Agent B，docs/AGENT_GRAPH_CONTRACT.md §3）。
 *
 * 注册四个编排工具 + 同名命令（冻结名，§0.4）：
 *   campaign_init        建 Campaign（校验分区/预算）→ campaign.json，任务全 pending；
 *   campaign_status      Campaign 全量读数 + 本会话活动 runId 列表；
 *   campaign_transition  状态机校验迁移（非法 → CAMPAIGN_ILLEGAL_TRANSITION；
 *                        进活动状态时开/复用 session run；heldout + worker → CAMPAIGN_PARTITION_VIOLATION）；
 *   campaign_record_run  关闭本会话该任务的活动 run，summary 落 run.json。
 *
 * run 的生命周期：transition 进入活动状态（exploring/debugging/verifying/heldout-eval）开 run、
 * record_run 关闭；同会话同任务同角色的连续迁移复用同一 run（角色切换才开新 run）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ParameterSchemaSpec, ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'
import { randomUUID } from 'node:crypto'
import { compatibleToolInput } from '../../lyapunov-contracts/src/tool-input.ts'
import type { Campaign, CampaignTask, PredicateExpr, TaskPartition, TaskStatus } from '../../lyapunov-contracts/src/agent-graph.ts'
import { CampaignStore, defaultSessionWorkDir, assertSafeId } from './campaign-store.ts'
import { CampaignRuntime, applyArtifactCollector } from './artifacts.ts'
import { ACTIVE_STATUSES, TERMINAL_STATUSES, assertRunPartition, assertTransition, defaultRoleFor, RUN_ROLES, type RunRole } from './state-machine.ts'

export const name = 'lyapunov-agent-graph'
export const inject = ['tools', 'commands']

export interface Config {
  /** 会话工作目录解析；默认原生 session.header.cwd。测试夹具用固定 tmpdir 注入。 */
  workDirFor?: (owner: unknown) => string
  /** 时钟注入（预算 wall 维度测试用）。 */
  now?: () => number
}

export const CAMPAIGN_INVALID_TASK = 'CAMPAIGN_INVALID_TASK'
export const CAMPAIGN_INVALID_BUDGET = 'CAMPAIGN_INVALID_BUDGET'
export const CAMPAIGN_INVALID_STATUS = 'CAMPAIGN_INVALID_STATUS'
export const CAMPAIGN_INVALID_ROLE = 'CAMPAIGN_INVALID_ROLE'
export const CAMPAIGN_TASK_NOT_FOUND = 'CAMPAIGN_TASK_NOT_FOUND'

const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'exploring', 'debugging', 'verifying', 'heldout-eval', 'done', 'blocked', 'rejected']
const RUN_OUTCOMES = ['success', 'failed', 'budget-exceeded', 'aborted'] as const
type RunOutcome = typeof RUN_OUTCOMES[number]

interface TaskInput { taskId: string; sceneId: string; partition: TaskPartition; goal: PredicateExpr }

function requireTask(raw: unknown): TaskInput {
  const task = raw as Partial<TaskInput> | undefined
  const taskId = typeof task?.taskId === 'string' ? task.taskId.trim() : ''
  const sceneId = typeof task?.sceneId === 'string' ? task.sceneId.trim() : ''
  if (!taskId || !sceneId) throw new Error(`${CAMPAIGN_INVALID_TASK}: 每个任务需要非空 taskId 与 sceneId（收到 ${JSON.stringify(raw)}）`)
  if (task?.partition !== 'dev' && task?.partition !== 'heldout') throw new Error(`${CAMPAIGN_INVALID_TASK}: 任务 ${taskId} 的 partition 必须是 dev|heldout（收到 ${JSON.stringify(task?.partition)}）`)
  if (!task?.goal || typeof task.goal !== 'object' || Array.isArray(task.goal)) throw new Error(`${CAMPAIGN_INVALID_TASK}: 任务 ${taskId} 需要 goal 谓词对象（PredicateExpr）`)
  return { taskId, sceneId, partition: task.partition, goal: task.goal as PredicateExpr }
}

function requireBudget(raw: unknown): Campaign['budget'] {
  const budget = raw as Partial<Campaign['budget']> | undefined
  for (const key of ['maxToolCalls', 'maxSimSteps', 'maxWallSeconds'] as const) {
    const value = budget?.[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`${CAMPAIGN_INVALID_BUDGET}: budget.${key} 必须是正数（收到 ${JSON.stringify(value)}）`)
    }
  }
  return { maxToolCalls: budget!.maxToolCalls!, maxSimSteps: budget!.maxSimSteps!, maxWallSeconds: budget!.maxWallSeconds! }
}

function requireStatus(raw: unknown): TaskStatus {
  if (typeof raw === 'string' && (TASK_STATUSES as readonly string[]).includes(raw)) return raw as TaskStatus
  throw new Error(`${CAMPAIGN_INVALID_STATUS}: to 必须是 ${TASK_STATUSES.join('|')}（收到 ${JSON.stringify(raw)}）`)
}

function normalizeRole(raw: unknown): RunRole | undefined {
  if (raw === undefined) return undefined
  if (typeof raw === 'string' && (RUN_ROLES as readonly string[]).includes(raw)) return raw as RunRole
  throw new Error(`${CAMPAIGN_INVALID_ROLE}: role 必须是 ${RUN_ROLES.join('|')}（收到 ${JSON.stringify(raw)}）`)
}

function requireOutcome(raw: unknown): RunOutcome {
  if (typeof raw === 'string' && (RUN_OUTCOMES as readonly string[]).includes(raw)) return raw as RunOutcome
  throw new Error(`CAMPAIGN_INVALID_SUMMARY: summary.outcome 必须是 ${RUN_OUTCOMES.join('|')}（收到 ${JSON.stringify(raw)}）`)
}

/** 全部任务进终局时收拢 campaign.status：全 done → completed，否则 blocked；未收拢保持 running。 */
function refreshCampaignStatus(campaign: Campaign): void {
  if (!campaign.tasks.every(task => TERMINAL_STATUSES.includes(task.status))) return
  campaign.status = campaign.tasks.every(task => task.status === 'done') ? 'completed' : 'blocked'
}

export function apply(ctx: Context, config: Config = {}) {
  const workDirFor = (owner: unknown) => config.workDirFor?.(owner) ?? defaultSessionWorkDir(owner)
  const store = new CampaignStore(workDirFor)
  const runtime = new CampaignRuntime(store, config.now ?? (() => Date.now()))
  applyArtifactCollector(ctx, runtime)

  const findTask = (campaign: Campaign, taskId: unknown): CampaignTask => {
    const task = campaign.tasks.find(row => row.taskId === taskId)
    if (!task) throw new Error(`${CAMPAIGN_TASK_NOT_FOUND}: campaign ${campaign.campaignId} 没有任务 ${JSON.stringify(taskId)}`)
    return task
  }

  const predicateAtomCount = (expr: PredicateExpr): number =>
    'and' in expr ? expr.and.reduce((n, c) => n + predicateAtomCount(c), 0)
    : 'or' in expr ? expr.or.reduce((n, c) => n + predicateAtomCount(c), 0)
    : 'not' in expr ? predicateAtomCount(expr.not) : 1

  /** Curriculum 下一跳：优先最简 pending dev 任务；dev 全部收束后才推 pending heldout 任务。 */
  const recommendedNextTaskId = (campaign: Campaign): string | undefined => {
    const devPending = campaign.tasks.filter(t => t.partition === 'dev' && t.status === 'pending')
      .sort((a, b) => predicateAtomCount(a.goal) - predicateAtomCount(b.goal))
    if (devPending.length) return devPending[0]!.taskId
    if (campaign.tasks.some(t => t.partition === 'dev' && ACTIVE_STATUSES.includes(t.status))) return undefined
    return campaign.tasks.find(t => t.partition === 'heldout' && t.status === 'pending')?.taskId
  }

  const operations = {
    async campaign_init(input: { campaignId?: string; tasks?: unknown[]; budget?: unknown }, owner: unknown) {
      if (!Array.isArray(input.tasks) || input.tasks.length === 0) throw new Error(`${CAMPAIGN_INVALID_TASK}: tasks 必须是非空数组`)
      const tasks = input.tasks.map(requireTask)
      if (new Set(tasks.map(task => task.taskId)).size !== tasks.length) throw new Error(`${CAMPAIGN_INVALID_TASK}: taskId 重复`)
      const campaignId = input.campaignId === undefined ? `campaign-${randomUUID()}` : assertSafeId(input.campaignId, 'campaignId')
      const campaign: Campaign = {
        campaignId,
        createdAt: new Date().toISOString(),
        tasks: tasks.map(task => ({ ...task, status: 'pending', workerRunIds: [] })),
        budget: requireBudget(input.budget),
        used: { toolCalls: 0, simSteps: 0, startedAt: new Date().toISOString() },
        status: 'running',
      }
      const handle = await runtime.createCampaign(owner, campaign)
      const nextTaskId = recommendedNextTaskId(handle.campaign)
      return { campaignId, campaign: handle.campaign, ...(nextTaskId ? { recommendedNextTaskId: nextTaskId } : {}) }
    },

    async campaign_status(input: { campaignId?: string }, owner: unknown) {
      const handle = await runtime.handleFor(owner, assertSafeId(input.campaignId, 'campaignId'))
      const nextTaskId = recommendedNextTaskId(handle.campaign)
      return {
        campaign: handle.campaign,
        openRunIds: runtime.openRunIds(owner, handle.campaign.campaignId),
        ...(nextTaskId ? { recommendedNextTaskId: nextTaskId } : {}),
      }
    },

    async campaign_transition(input: { campaignId?: string; taskId?: string; to?: unknown; role?: unknown; blockedReason?: unknown }, owner: unknown) {
      const handle = await runtime.handleFor(owner, assertSafeId(input.campaignId, 'campaignId'))
      const task = findTask(handle.campaign, input.taskId)
      const to = requireStatus(input.to)
      const from = assertTransition(task, to)
      let runId: string | undefined
      if (ACTIVE_STATUSES.includes(to)) {
        const role = normalizeRole(input.role) ?? defaultRoleFor(to)
        assertRunPartition(task, role)
        const existing = runtime.currentRunFor(owner, handle.campaign.campaignId, task.taskId)
        if (existing && existing.role === role) runId = existing.runId
        else {
          const active = await runtime.openRun(owner, handle, task, role)
          runId = active.runId
          if (role === 'worker') task.workerRunIds.push(runId)
        }
      }
      task.status = to
      if (to === 'blocked') task.blockedReason = typeof input.blockedReason === 'string' && input.blockedReason.trim() ? input.blockedReason : 'blocked'
      refreshCampaignStatus(handle.campaign)
      await store.saveCampaignAt(handle.dir, handle.campaign)
      return { campaignId: handle.campaign.campaignId, taskId: task.taskId, from, to, ...(runId === undefined ? {} : { runId }) }
    },

    async campaign_record_run(input: { campaignId?: string; taskId?: string; role?: unknown; summary?: { outcome?: unknown; notes?: unknown } }, owner: unknown) {
      const handle = await runtime.handleFor(owner, assertSafeId(input.campaignId, 'campaignId'))
      const task = findTask(handle.campaign, input.taskId)
      const role = normalizeRole(input.role)
      if (role === undefined) throw new Error(`${CAMPAIGN_INVALID_ROLE}: record_run 需要显式 role（${RUN_ROLES.join('|')}）`)
      assertRunPartition(task, role)
      const outcome = requireOutcome(input.summary?.outcome)
      const active = runtime.currentRunFor(owner, handle.campaign.campaignId, task.taskId)
      if (!active) throw new Error(`CAMPAIGN_NO_ACTIVE_RUN: 本会话没有 (campaign=${handle.campaign.campaignId}, task=${task.taskId}) 的活动 run 可关闭`)
      const summary = {
        toolCalls: active.executedCalls,
        simSteps: active.simSteps,
        outcome,
        ...(typeof input.summary?.notes === 'string' && input.summary.notes ? { notes: input.summary.notes } : {}),
      }
      const run = await runtime.closeRun(owner, handle.campaign.campaignId, task.taskId, summary)
      if (task.status === 'heldout-eval') {
        task.heldoutResult = { taskAchieved: outcome === 'success', checkedAt: new Date().toISOString(), runId: run.runId }
      }
      refreshCampaignStatus(handle.campaign)
      await store.saveCampaignAt(handle.dir, handle.campaign)
      return { campaignId: handle.campaign.campaignId, taskId: task.taskId, runId: run.runId, summary: run.summary }
    },
  }

  const register = (toolName: keyof typeof operations, description: string, inner: ParameterSchemaSpec, hint: string) => {
    const perform = operations[toolName]
    const parameters: ParameterSchemaSpec = { input: { type: 'object', required: true, additionalProperties: false, properties: inner } }
    ctx.tools.register(compatibleToolInput(defineTool({
      name: toolName, description, parameters,
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec) => await perform((args as { input: never }).input, exec.agent) as never,
    })))
    // 命令是同名工具的 UI 别名：走 ctx.tools.execute 同一条 dispatch——tools/result 观察者
    // （campaign 投影、证据链 waterfall）才能看到与模型直呼一致的回执；参数按工具的 {input} 包络校验。
    ctx.commands.register({ name: toolName, description, input: { hint }, handler: async invocation => {
      try {
        const result = await ctx.tools.execute({
          name: toolName,
          arguments: { input: JSON.parse(invocation.rawInput) },
          callId: `campaign-command-${randomUUID()}` as ToolExecutionInput['callId'],
          ...(invocation.agent !== undefined ? { agent: invocation.agent as ToolExecutionInput['agent'] } : {}),
          signal: invocation.signal ?? new AbortController().signal,
        })
        const text = result.content.filter(block => block.type === 'text').map(block => (block as { text?: string }).text ?? '').join('\n')
        return { kind: result.isError ? 'error' as const : 'success' as const, text: text || JSON.stringify(result.value) }
      } catch (error) { return { kind: 'error' as const, text: String(error) } }
    } })
  }

  register('campaign_init',
    'Create a campaign: validate task partitions and budget, persist .lyapunov/campaigns/<campaignId>/campaign.json under the session working directory, all tasks start pending. Input: {campaignId?, tasks:[{taskId,sceneId,partition,goal}], budget:{maxToolCalls,maxSimSteps,maxWallSeconds}}.',
    {
      campaignId: { type: 'string' },
      tasks: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        taskId: { type: 'string', required: true }, sceneId: { type: 'string', required: true },
        partition: { type: 'string', required: true }, goal: { type: 'json', required: true },
      } } },
      budget: { type: 'object', required: true, additionalProperties: false, properties: {
        maxToolCalls: { type: 'integer', required: true }, maxSimSteps: { type: 'integer', required: true }, maxWallSeconds: { type: 'number', required: true },
      } },
    }, 'campaignId?/tasks/budget JSON')

  register('campaign_status',
    'Read one campaign in full (tasks, status, budget usage) plus this session’s open run ids. Input: {campaignId}.',
    { campaignId: { type: 'string', required: true } }, 'campaignId')

  register('campaign_transition',
    'Move a campaign task along the state machine pending→exploring→debugging→verifying→heldout-eval→done|blocked|rejected. Illegal moves raise CAMPAIGN_ILLEGAL_TRANSITION; a worker role on a heldout task raises CAMPAIGN_PARTITION_VIOLATION. Entering an active status opens (or reuses) a run for this session. Input: {campaignId,taskId,to,role?,blockedReason?}.',
    {
      campaignId: { type: 'string', required: true }, taskId: { type: 'string', required: true },
      to: { type: 'string', required: true }, role: { type: 'string' }, blockedReason: { type: 'string' },
    }, 'campaignId/taskId/to/role?/blockedReason? JSON')

  register('campaign_record_run',
    'Close this session’s active run for a task: writes runs/<runId>/run.json with the real toolCalls/simSteps counters and the declared outcome. Input: {campaignId,taskId,role,summary:{outcome,notes?}}.',
    {
      campaignId: { type: 'string', required: true }, taskId: { type: 'string', required: true },
      role: { type: 'string', required: true },
      summary: { type: 'object', required: true, additionalProperties: false, properties: {
        outcome: { type: 'string', required: true }, notes: { type: 'string' },
      } },
    }, 'campaignId/taskId/role/summary JSON')
}
