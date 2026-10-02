import type { ActionReceipt } from '../../lyapunov-contracts/src/types.ts'
/** 原生 Session envelope 的窄解析；原事件始终原样写入录制日志。 */
type DomainEvent = { type: string; data?: any }
type Call = { name: string; callId: string; kind: 'command' | 'tool'; event: DomainEvent; input?: Record<string, any> }
export interface RecordingCaptureSource { name: string; callId: string; kind: 'command' | 'tool' | 'provider' }
export interface RecordingCapture { source: RecordingCaptureSource; result: Record<string, any> }
/** 采集类工具：只有它们的回执才作为 capture 记进 manifest。多视角采集与单相机采集同级，绝不拆成多次采集。 */
const captureNames = new Set(['sensor_capture', 'sensor_capture_ui', 'viewer_capture', 'camera_capture_multi'])
const parse = (text: unknown): Record<string, any> | undefined => {
 if (typeof text !== 'string') return undefined
 try {
  let value = JSON.parse(text)
  if (typeof value?.result === 'string') value = JSON.parse(value.result)
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
 } catch { return undefined }
}

/** 回执容器形状：单条 result.actionId、result.receipts[]（停止确认）与工作流 result.actions[]。 */
const receiptCandidates = (value: Record<string, any> | undefined): any[] => {
 if (!value) return []
 const found: any[] = []
 if (typeof value.actionId === 'string') found.push(value)
 for (const key of ['receipts', 'actions'] as const) if (Array.isArray(value[key])) found.push(...value[key])
 return found
}

export function recordingEventResult(event: DomainEvent): Record<string, any> | undefined {
 if (event.type === 'command/done') {
  const parsed = parse(event.data?.text)
  if (!parsed) return undefined
  if (event.data?.kind === 'success') return parsed
  // 失败/取消命令文本若是含真实动作回执的结构化工作流结果则不可丢弃；纯错误文本解析不出回执。
  return receiptCandidates(parsed).length ? parsed : undefined
 }
 if (event.type !== 'tool/result') return undefined
 const data = event.data, callId = data?.message?.source?.callId
 const block = data?.message?.content?.find((item: any) => item.type === 'tool-result' && item.toolCallId === callId)
 return block && !block.isError ? parse(block.content?.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n')) : undefined
}
export interface RecordedAction { receipt: ActionReceipt; source: Record<string, unknown> }
/** 仅从已有原始动作/Session回执提取，不根据目标位置合成动作成功；工具私有 meta（presentationMeta）同样承载真实回执。 */
export function recordingActions(events: Array<Record<string, any>>): RecordedAction[] {
 const actions = new Map<string, RecordedAction>()
 for (const event of events) {
  const raw = event.kind === 'session-event' ? event.event : undefined
  const result = raw ? recordingEventResult(raw) : event.kind === 'action' ? event.receipt : undefined
  const meta = raw?.type === 'tool/result' ? raw.data?.meta : undefined
  const receipts = [...receiptCandidates(result), ...receiptCandidates(meta)]
  if (!receipts.length) continue
  for (const receipt of receipts) {
   if (typeof receipt?.worldId !== 'string' || !Number.isInteger(receipt.generation) || typeof receipt.actionId !== 'string' || typeof receipt.status !== 'string') continue
   const key = `${receipt.worldId}:${receipt.generation}:${receipt.actionId}`, previous = actions.get(key)
   if (previous && receipt.status === 'accepted' && previous.receipt.status !== 'accepted') continue
   const source = raw ? { kind: raw.type === 'command/done' ? 'command' : 'tool', callId: raw.data.commandId ?? raw.data.message?.source?.callId, eventSeq: raw.seq } : event.source
   actions.set(key, { receipt: receipt as ActionReceipt, source: previous?.source ?? source ?? {} })
  }
 }
 return [...actions.values()]
}

export class RecordingSessionEvents {
 private readonly calls = new Map<string, Call>()
 constructor(private readonly worldId: string, private readonly sceneId: string) {}
 private belongs(value?: Record<string, any>): boolean | undefined {
  if (!value) return undefined
  if (typeof value.worldId === 'string') return value.worldId === this.worldId && (value.sceneId === undefined || value.sceneId === this.sceneId)
  if (typeof value.sceneId === 'string') return value.sceneId === this.sceneId
  return undefined
 }
 accept(event: DomainEvent): { events: DomainEvent[]; capture?: RecordingCapture } {
  const data = event.data
  const kind = event.type.startsWith('command/') ? 'command' : 'tool'
  const callId = kind === 'command' ? data?.commandId : event.type === 'tool/result' ? data?.message?.source?.callId : data?.callId
  if (typeof callId !== 'string') return { events: [] }
  const key = kind + ':' + callId
  if (event.type === 'command/run' || event.type === 'tool/call') {
   if (typeof data.name !== 'string' || !/^(scene_|sim_|robot_|vehicle_|joint_|sensor_|viewer_|camera_)/.test(data.name)) return { events: [] }
   const args = parse(kind === 'command' ? data.args : data.arguments), input = args?.input ?? args
   if (this.belongs(input) === false) return { events: [] }
   this.calls.set(key, { name: data.name, callId, kind, event, input })
   // UI capture 不记录输入。先等待真实回执确认 world，再保存原始调用对。
   return { events: captureNames.has(data.name) ? [] : [event] }
  }
  if (event.type !== 'command/done' && event.type !== 'tool/result') return { events: [] }
  const call = this.calls.get(key)
  if (!call) return { events: [] }
  this.calls.delete(key)
  if (!captureNames.has(call.name)) return { events: [event] }
  const result = recordingEventResult(event)
  if (result && this.belongs(result) === false) return { events: [] }
  // 两个 world 可来自同一 Scene；采集必须由明确 world 归属，不能只靠 Scene。
  const scoped = result?.worldId === this.worldId || call.input?.worldId === this.worldId
  if (!scoped) return { events: [] }
  return { events: [call.event, event], ...result?.worldId === this.worldId ? { capture: { source: { name: call.name, callId, kind }, result } } : {} }
 }
}
