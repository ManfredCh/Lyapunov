/**
 * Campaign 状态投影（`docs/AGENT_GRAPH_CONTRACT.md` §6）。
 *
 * `tools/result` 观察本会话 `campaign_*` 工具回执：
 * - `campaign_init` / `campaign_status` 回执自带完整 `campaign`，直接落成卡片；
 * - `campaign_transition` / `campaign_record_run` 回执只带增量字段（runId/taskId/预算），
 *   由投影在同会话里补发一次 `campaign_status` 读数后落完整卡片；
 * - 拒绝（`CAMPAIGN_*` 错误）同样以一次读数结果为准，卡片 `lastError` 如实记录错误码，
 *   不从增量字段猜中间态。
 *
 * 卡片以 `lyapunov/campaign-state`（ignorable 只读事件）进入会话日志，
 * `sessionProjection 'campaigns'` 折叠成面板读数（task 状态矩阵 + 预算用量），
 * 与 `todos`/`lyapunovGraph` 同一机制——会话级、可回放、无独立主机通道。
 */
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import type {Session,SessionEvent,SessionHeader} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {Campaign,CampaignTask} from '../../lyapunov-contracts/src/agent-graph.ts'
import {z} from 'zod'

/** Campaign 观察事件：一张完整的 campaign 快照卡，按 `campaignId` 整卡替换。 */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'lyapunov/campaign-state': CampaignCard
  }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { campaigns: CampaignsProjection }
  interface SessionProjectionStateMap { campaigns: CampaignsProjection }
}

/** `campaign_status` 读数上限：观测通道不阻塞 agent 主线。 */
const REFRESH_TIMEOUT_MS = 15000
/** 投影自己补发的 `campaign_status` 调用 id 前缀，用于把待附带的 `lastError` 交给回执处理。 */
const REFRESH_CALL_PREFIX = 'campaign-projection-'
/** 本产品插件在 runtime 装配里的条目 id（`script/runtime-patch.ts` 指向 `dist/campaign-projection.js`）。 */
export const name = 'lyapunov-shell-campaigns'
/** 必需服务：会话投影注册表与工具执行面；缺一个时 cordis 在装载期如实拒绝。 */
export const inject = ['sessionProjections', 'tools']

/** `tools/result` 里携带完整 campaign 的读写面（`campaign_init`/`campaign_status` 返回 `{campaign,...}`）。 */
const FULL_CARD_TOOLS = new Set(['campaign_init', 'campaign_status'])
/** 回执只有增量字段、需要补一次读数的 campaign 工具。 */
const MUTATION_TOOLS = new Set(['campaign_transition', 'campaign_record_run'])

export type CampaignTaskStatus = CampaignTask['status']
export type CampaignStatus = Campaign['status']

/** 面板矩阵行：task 卡面只留展示字段，`goal` 谓词不进会话日志卡。 */
export interface CampaignTaskRow {
  readonly taskId: string
  readonly sceneId: string
  readonly partition: CampaignTask['partition']
  readonly status: CampaignTaskStatus
  readonly blockedReason?: string
  readonly heldoutResult?: CampaignTask['heldoutResult']
}

/** `lyapunov/campaign-state` 事件载荷：一次回执之后的完整 campaign 快照。 */
export interface CampaignCard {
  readonly campaignId: string
  readonly createdAt: string
  readonly status: CampaignStatus
  readonly tasks: CampaignTaskRow[]
  readonly budget: Campaign['budget']
  readonly used: Campaign['used']
  /** 本会话当前打开的 campaign run（来自 `campaign_status.openRunIds`；`campaign_init` 回执为空）。 */
  readonly openRunIds: string[]
  /** 最近一次本会话 campaign_* 调用的拒绝原因；随后的成功读数清除。 */
  readonly lastError?: string
}

/** `sessionProjection 'campaigns'` 折叠态：本会话已知 campaign 的卡片表（追加序）。 */
export interface CampaignsProjection {
  readonly sessionId: string
  readonly campaigns: CampaignCard[]
}

const taskRowSchema = z.object({
  taskId: z.string(),
  sceneId: z.string(),
  partition: z.enum(['dev', 'heldout']),
  status: z.enum(['pending', 'exploring', 'debugging', 'verifying', 'heldout-eval', 'done', 'blocked', 'rejected']),
  blockedReason: z.string().optional(),
  heldoutResult: z.object({ taskAchieved: z.boolean(), checkedAt: z.string(), runId: z.string() }).strict().optional(),
}).strict()

const campaignCardSchema = z.object({
  campaignId: z.string(),
  createdAt: z.string(),
  status: z.enum(['running', 'completed', 'blocked', 'aborted']),
  tasks: z.array(taskRowSchema),
  budget: z.object({ maxToolCalls: z.number(), maxSimSteps: z.number(), maxWallSeconds: z.number() }).strict(),
  used: z.object({ toolCalls: z.number(), simSteps: z.number(), startedAt: z.string() }).strict(),
  openRunIds: z.array(z.string()),
  lastError: z.string().optional(),
}).strict()

const campaignsSchema = z.object({ sessionId: z.string(), campaigns: z.array(campaignCardSchema) }).strict()

/** 把 `campaign_*` 回执里的完整 `campaign` 折成展示卡（回执字段已在本进程校验过，这里只取展示字段）。 */
export function campaignCardOf(campaign: Campaign, openRunIds: readonly string[], lastError?: string): CampaignCard {
  return {
    campaignId: campaign.campaignId,
    createdAt: campaign.createdAt,
    status: campaign.status,
    tasks: campaign.tasks.map(task => ({
      taskId: task.taskId,
      sceneId: task.sceneId,
      partition: task.partition,
      status: task.status,
      ...(task.blockedReason === undefined ? {} : { blockedReason: task.blockedReason }),
      ...(task.heldoutResult === undefined ? {} : { heldoutResult: task.heldoutResult }),
    })),
    budget: campaign.budget,
    used: campaign.used,
    openRunIds: [...openRunIds],
    ...(lastError === undefined ? {} : { lastError }),
  }
}

/** `sessionProjection 'campaigns'` 初始态：空卡片表。 */
export function initCampaigns(header: SessionHeader): CampaignsProjection {
  return { sessionId: String(header.id), campaigns: [] }
}

/** `lyapunov/campaign-state` 事件折叠：按 `campaignId` 整卡替换或追加。 */
export function foldCampaigns(state: CampaignsProjection, event: SessionEvent): CampaignsProjection {
  if (event.type !== 'lyapunov/campaign-state') return state
  const card = event.data
  const index = state.campaigns.findIndex(existing => existing.campaignId === card.campaignId)
  const campaigns = index < 0
    ? [...state.campaigns, card]
    : state.campaigns.map((existing, i) => i === index ? card : existing)
  return { ...state, campaigns }
}

/** 本会话当前 campaign 投影读数；投影未注册或无该会话时为 `undefined`。 */
export function campaignsOf(ctx: Context, session: Session): CampaignsProjection | undefined {
  return ctx.get('sessionProjections')?.stateOf(session, 'campaigns')
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** 从工具调用实参里取 `campaignId`（`{input:{campaignId}}` 与裸 `{campaignId}` 两种调用约定都认）。 */
export function campaignIdOf(args: unknown): string | undefined {
  const record = object(args)
  if (typeof record.campaignId === 'string') return record.campaignId
  const input = object(record.input)
  return typeof input.campaignId === 'string' ? input.campaignId : undefined
}

/** `tools/result` 回执值里的完整 campaign（仅 `campaign_init`/`campaign_status` 成功回执携带）。 */
function campaignOf(value: unknown): Campaign | undefined {
  const campaign = object(object(value).campaign)
  return typeof campaign.campaignId === 'string' && Array.isArray(campaign.tasks) ? campaign as unknown as Campaign : undefined
}

/**
 * 注册 `campaigns` 会话投影并挂 `tools/result` 观察者。
 * @returns `settle()` 等本观察者已发出的补读数回执全部落卡——测试等待点；`stateOf` 读当前投影。
 */
export function applyCampaignProjection(ctx: Context): { stateOf: (session: Session) => CampaignsProjection | undefined; settle: () => Promise<void> } {
  const registry = ctx.get('sessionProjections')
  if (registry === undefined) throw new Error('SESSION_PROJECTION_REQUIRED: campaign 投影需要原生会话投影，不回落进程态')
  const pendingErrors = new Map<string, string>()
  const inFlight = new Set<Promise<void>>()
  ctx.effect(() => registry.register({
    key: 'campaigns',
    stateSchema: campaignsSchema,
    stateVersion: 1,
    wire: { viewSchema: campaignsSchema, view: state => state },
    init: initCampaigns,
    apply: foldCampaigns,
  }), 'campaign 投影注册')
  const append = (session: Session, card: CampaignCard): void => {
    session.append('lyapunov/campaign-state', card, { ignorable: true })
  }
  /** `campaign_transition`/`campaign_record_run` 之后补一次 `campaign_status`，让回执自己把完整卡片写进投影。 */
  const refresh = (agent: Agent, campaignId: string, lastError?: string): void => {
    const callId = ToolCallId(`${REFRESH_CALL_PREFIX}${crypto.randomUUID()}`)
    if (lastError !== undefined) pendingErrors.set(callId, lastError)
    const settled = Promise.resolve(ctx.tools.execute({
      name: 'campaign_status',
      arguments: { input: { campaignId } },
      callId,
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      agent,
    })).then(result => {
      if (result.isError && lastError !== undefined) {
        // 读数也拿不到（如 campaign 已不存在）：在既有卡片上如实标出最后一次拒绝，不造新卡。
        const existing = registry.stateOf(agent.session, 'campaigns')?.campaigns.find(card => card.campaignId === campaignId)
        if (existing !== undefined) append(agent.session, { ...existing, lastError })
      }
    }).catch((error: unknown) => {
      ctx.logger.warn(`campaign 投影刷新失败：${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      pendingErrors.delete(callId)
      inFlight.delete(settled)
    })
    inFlight.add(settled)
  }
  ctx.on('tools/result', (exec, result) => {
    try {
      const agent = exec.agent
      if (agent === undefined) return
      const callId = String(exec.callId)
      const campaign = result.isError ? undefined : campaignOf(result.value)
      if (FULL_CARD_TOOLS.has(exec.name)) {
        if (campaign !== undefined) {
          const openRunIds = Array.isArray(object(result.value).openRunIds)
            ? (object(result.value).openRunIds as unknown[]).filter((id): id is string => typeof id === 'string')
            : []
          append(agent.session, campaignCardOf(campaign, openRunIds, pendingErrors.get(callId)))
        }
        // `campaign_status` 失败不补读数——否则一次拒绝会自我续命成读数循环。
        return
      }
      if (!MUTATION_TOOLS.has(exec.name)) return
      const campaignId = campaignOf(result.value)?.campaignId ?? campaignIdOf(exec.arguments)
      if (campaignId === undefined) return
      refresh(agent, campaignId, result.isError ? String(result.error.message).slice(0, 500) : undefined)
    } catch (error) {
      ctx.logger.warn(`campaign 投影观察失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })
  return {
    stateOf: session => registry.stateOf(session, 'campaigns'),
    settle: () => Promise.allSettled([...inFlight]).then(() => undefined),
  }
}

/** Cordis 插件入口：`dist/campaign-projection.js` 作为 `lyapunov-shell-campaigns` 挂进产品装配。 */
export function apply(ctx: Context): void {
  applyCampaignProjection(ctx)
}
