import type { ActionReceipt, Frame } from '../../lyapunov-contracts/src/types.ts'
import type { ObservationSelection, SimWorlds, StopSelection } from '../../sim-contract/src/index.ts'
export type ExecutionMode = 'physical-contact' | 'assisted-teleport' | 'unknown'
/**
 * 帧区间内的真实辅助推进：只比较本次起止帧（frames 首末，调用方保证按时间收集）在同 world/generation 上的
 * assistAdvanceCount 差值。差值 > 0 即本区间内确有真实辅助写回——即使区间内没有工作流自己的动作
 * （如最终 hold），attach/release 往返发生在帧之间也不会漏；差值按本次起止计算，过去的辅助不污染后续独立工作流。
 * 字段缺失（旧持久化帧/旧 Provider）、首末帧身份不一致或不足两帧时不作推断。
 */
function assistAdvancedWithin(frames: readonly Frame[]): boolean {
  const first = frames[0], last = frames[frames.length - 1]
  if (!first || !last || first === last || first.worldId !== last.worldId || first.generation !== last.generation) return false
  const count = (frame: Frame) => (frame as { assistAdvanceCount?: unknown }).assistAdvanceCount
  const from = count(first), to = count(last)
  return typeof from === 'number' && typeof to === 'number' && to > from
}
/**
 * 执行模式只能由明确的执行证据推导（帧/回执上的 executionMode，语义见 sim-mujoco worker.py:375/684，
 * 以及帧上随真实辅助写回推进的 assistAdvanceCount）：
 * - 任一 assisted 证据优先（含本次起止帧之间的真实辅助推进）；
 * - physical-contact 要求每条真实执行回执都明确声明 physical-contact，且帧上不得出现其他声明，起止帧之间不得有辅助推进；
 * - 缺失或不支持的 mode 一律 unknown——绝不把“没有反例”当正证据宣称物理。
 */
export function executionModeOf(actions: readonly ActionReceipt[], frames: readonly Frame[]): ExecutionMode {
  const declared = (value: unknown) => (value as { executionMode?: unknown } | undefined)?.executionMode
  const frameModes = frames.map(frame => declared(frame))
  if (assistAdvancedWithin(frames) || frameModes.includes('assisted-teleport') || actions.some(action => declared(action.effect) === 'assisted-teleport')) return 'assisted-teleport'
  if (frameModes.some(mode => mode !== undefined && mode !== 'physical-contact')) return 'unknown'
  if (actions.length === 0 || actions.some(action => declared(action.effect) !== 'physical-contact')) return 'unknown'
  return 'physical-contact'
}
/** 非 completed 回执必须停止后续提交；具体收尾（停止确认/结构化失败）由工作流负责。 */
export class ActionReceiptError extends Error { constructor(readonly receipt: ActionReceipt) { super(receipt.reason ?? receipt.status) } }
/** 本次请求身份：world + 起始 generation。所有观测/回执都必须与之核对，fresh observe 不得自动更换本次目标代次。 */
export interface RequestIdentity { worldId: string; generation: number }
/** after 的来源：fresh = 本次新观测；last-known = 退回本次已持有的最后实际帧（不得冒充新 after）。 */
export type ObservationFreshness = 'fresh' | 'last-known'
/** 停止请求的结果：只有 sim.stop 成功返回才是“停止已确认”；拒绝/错误必须如实记录。 */
export interface StopOutcome { confirmed: boolean; selection: StopSelection; stepIndex?: number; error?: string }
export function identityOf(frame: Frame): RequestIdentity { return { worldId: frame.worldId, generation: frame.generation } }
/** 返回不一致描述；一致时为 undefined。缺少来源视为不一致（无来源不能充作本次证据）。 */
export function identityMismatch(source: { worldId?: string; generation?: number } | undefined | null, identity: RequestIdentity): string | undefined {
  if (!source) return '缺少来源'
  if (source.worldId !== identity.worldId) return `worldId ${source.worldId} != ${identity.worldId}`
  if (source.generation !== identity.generation) return `generation ${source.generation} != ${identity.generation}`
  return undefined
}
export function assertIdentity(kind: string, source: { worldId?: string; generation?: number } | undefined | null, identity: RequestIdentity) {
  const mismatch = identityMismatch(source, identity)
  if (mismatch) throw new Error(`STALE_GENERATION: ${kind}与本次请求不一致（${mismatch}）`)
}
/** 停止必须携带本次请求的 expectedGeneration：世界已换代时停止会被拒绝，绝不能去停止新一代的动作。 */
export async function confirmStop(sim: SimWorlds, worldId: string, selection: StopSelection): Promise<StopOutcome> {
  try { const result = await sim.stop(worldId, selection); return { confirmed: result?.stopped === true, selection, stepIndex: result?.stepIndex } }
  catch (error) { return { confirmed: false, selection, error: error instanceof Error ? error.message : String(error) } }
}
/** 失败/收尾追加观测：只有与本次身份一致的新观测才算 fresh；否则退回 last-known 并显式记录观察错误。 */
export async function settledObservation(sim: SimWorlds, worldId: string, identity: RequestIdentity, fallback: Frame, selection?: ObservationSelection): Promise<{ after: Frame; afterSource: ObservationFreshness; observationError?: string }> {
  try {
    const frame = await sim.observe(worldId, selection)
    const mismatch = identityMismatch(frame, identity)
    if (mismatch) return { after: fallback, afterSource: 'last-known', observationError: `STALE_GENERATION: 追加观测与本次请求不一致（${mismatch}）` }
    return { after: frame, afterSource: 'fresh' }
  } catch (error) { return { after: fallback, afterSource: 'last-known', observationError: error instanceof Error ? error.message : String(error) } }
}
/** 工作流工具在会话日志中承载的最小动作证据：剥离 finalState 大帧，保留标识/状态/步号/效果与真实 reason。 */
export function actionEvidence(actions: unknown): ActionReceipt[] {
  if (!Array.isArray(actions)) return []
  return actions.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const receipt = value as Record<string, unknown>
    if (typeof receipt.actionId !== 'string' || typeof receipt.status !== 'string') return []
    const { finalState, ...rest } = receipt
    return [rest as unknown as ActionReceipt]
  })
}
/** 原生 ToolOutputDefinition.presentationMeta 载荷：模型 render 继续给摘要，逐条回执从这里进入会话日志。 */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export function workflowPresentationMeta(_args: unknown, value: unknown): Json {
  const actions = actionEvidence((value as { actions?: unknown } | null | undefined)?.actions)
  return actions.length ? { actions: actions as unknown as Json } : {}
}
/** 摘要用的来源帧投影：不带实体/接触大数组。 */
export function frameSource(frame: unknown) {
  const value = frame as Frame | undefined
  return value && typeof value === 'object' ? { worldId: value.worldId, generation: value.generation, stepIndex: value.stepIndex, frameId: value.frameId } : undefined
}
/** 摘要用的动作清单投影。 */
export function actionSummary(actions: unknown) {
  const list = Array.isArray(actions) ? actions : []
  return { count: list.length, actionIds: list.map(receipt => (receipt as { actionId?: unknown } | null | undefined)?.actionId ?? null) }
}
