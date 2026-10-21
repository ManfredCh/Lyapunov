import type { SimWorlds } from '../../sim-contract/src/index.ts'
import type { Frame, ActionReceipt } from '../../lyapunov-contracts/src/types.ts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createWriteStream, type WriteStream } from 'node:fs'
import { join } from 'node:path'
/** 同一步可以应用新的Scene元数据版本；不能只用不含revision的frameId去重。 */
export function recordingFrameIdentity(frame: Pick<Frame, 'worldId' | 'generation' | 'sceneRevision' | 'stepIndex'>): string { return JSON.stringify([frame.worldId, frame.generation, frame.sceneRevision, frame.stepIndex]) }
/**
 * 录制**累计已录时长**的唯一累加判据：同一代次只累加正 delta；换代先归零本段（不把另一代次的
 * simTime 差当成本次录制），暂停没有新 frame 时调用方不会调用它。返回的仍是仿真秒，不是墙钟。
 */
export function accumulateRecordingElapsed(elapsedS: number, previous: Pick<Frame, 'generation' | 'simTime'>, current: Pick<Frame, 'generation' | 'simTime'>): number {
 return current.generation === previous.generation ? elapsedS + Math.max(0, current.simTime - previous.simTime) : elapsedS
}
/**
 * 固定来源作业的订阅帧归属门：只有当前帧仍属于开始时绑定的 world/generation 才接收。
 * 被拒帧**不写入 events.jsonl、不计数**——停止边界不会留下没有对应 Scene segment 的帧，
 * 旧的有效录制照旧能读回。旧调用不传门，保持既有的兼容分代语义。
 */
export interface RecordingFrameGate {
 accept(frame: Frame): boolean
 /** 被拒帧的回调（用于终止作业）；调用方自行保证幂等。 */
 onReject?(frame: Frame): void
}
/** 固定来源开始时绑定的真实身份；捕获回执必须与它一致才允许发布为本次来源的成功样本。 */
export interface BoundRecordingSource {
 worldId: string; generation: number; sceneRevision?: number
 parentEntityId?: string; parentBodyName?: string; cameraName: string; resolvedCameraName?: string
}
/**
 * 捕获回执的真实归属是否仍是绑定的固定来源。对不上返回**具体原因**（供作业以准确原因结束），
 * 一致返回 undefined。相机回执逐相机核 parentEntityId/body/camera，LiDAR 回执直接核顶层同名字段。
 * 这是纯判据：不让"原 source=A 收 B 的数据"在回执层漏过。
 */
export function recordingAttributionMismatch(receipt: any, bound: BoundRecordingSource): string | undefined {
 if (typeof receipt?.worldId === 'string' && receipt.worldId !== bound.worldId) return 'source-attribution-mismatch'
 if (Number.isInteger(receipt?.generation) && receipt.generation !== bound.generation) return 'source-generation-changed'
 const entries: any[] = Array.isArray(receipt?.cameras) ? receipt.cameras : [receipt]
 for (const entry of entries) {
  if (!entry || typeof entry !== 'object') continue
  if (bound.parentEntityId !== undefined && entry.parentEntityId !== undefined && entry.parentEntityId !== bound.parentEntityId) return 'source-attribution-mismatch'
  if (bound.parentBodyName !== undefined && entry.parentBodyName !== undefined && entry.parentBodyName !== bound.parentBodyName) return 'source-attribution-mismatch'
  const name = typeof entry.cameraName === 'string' ? entry.cameraName : typeof entry.resolvedCameraName === 'string' ? entry.resolvedCameraName : undefined
  if (name !== undefined && name !== bound.cameraName && name !== bound.resolvedCameraName) return 'source-attribution-mismatch'
 }
 return undefined
}
export class SimulationRecording {
 private stream?: WriteStream
 private unsubscribe?: () => void
 private last?: Frame
 private count = 0
 private failure?: Error
 constructor(readonly directory: string, readonly sessionRef: string) {}
 get progress() { return { frameCount: this.count, lastFrame: this.last } }
 async start(sim: SimWorlds, worldId: string, onFrame?: (frame: Frame) => void, observed?: Frame, gate?: RecordingFrameGate) {
  if (this.stream) throw new Error('RECORDING_ALREADY_ACTIVE')
 await mkdir(this.directory, { recursive: true })
 this.stream = createWriteStream(join(this.directory, 'events.jsonl'), { flags: 'ax', mode: 0o600 })
 this.stream.on('error', error => { this.failure = error })
  // 调用方（recording_start）已经为同一世界观察过一帧时复用它：events.jsonl 的 start
  // 事件必须与录制清单 firstFrame 是同一帧，否则按 first/lastFrame 配对的消费者会拿到
  // 一个不在帧集里的起点（02 报告记录 firstFrame=7276 而首帧=7280，即两次 observe 之间的漂移）。
  const first = observed ?? await sim.observe(worldId)
  // The transport immediately replays its cached latest frame when a
  // subscription is added.  That cached frame can be older than the explicit
  // observation above (the request and the frame event use different queues),
  // so seed the recorder with the observation and reject stale callbacks.
  this.last = first
  this.count = 1
  this.event({ kind: 'start', frame: first })
  onFrame?.(first)
  this.unsubscribe = sim.subscribeFrames(worldId, frame => {
   if (!this.last || frame.worldId !== this.last.worldId || frame.generation < this.last.generation || frame.generation === this.last.generation && ((frame.sceneRevision ?? -1) < (this.last.sceneRevision ?? -1) || frame.stepIndex < this.last.stepIndex || frame.stepIndex === this.last.stepIndex && frame.sceneRevision === this.last.sceneRevision)) return
   // 固定来源：先把不属于本代次的帧挡在 events.jsonl 之外（并通知终止），再按真实帧计数。
   if (gate && !gate.accept(frame)) { gate.onReject?.(frame); return }
   this.last = frame; this.count++
   this.event({ kind: 'frame', frame }); onFrame?.(frame)
  })
 }
 event(event: Record<string, unknown>) {
  if (!this.stream) throw new Error('RECORDING_NOT_ACTIVE')
  if (this.failure) throw this.failure
  this.stream.write(JSON.stringify({ ...event, sessionRef: this.sessionRef }) + '\n')
 }
 action(receipt: ActionReceipt, source: { kind: 'tool' | 'command'; id: string }) { this.event({ kind: 'action', source, receipt }) }
 pauseFrames() { this.unsubscribe?.(); this.unsubscribe = undefined }
 async stop() {
  this.pauseFrames()
  const stream = this.stream; this.stream = undefined
  if (stream) await new Promise<void>((resolve, reject) => { if (this.failure) return reject(this.failure); stream.once('error', reject); stream.end(resolve) })
  const summary = { sessionRef: this.sessionRef, frameCount: this.count, lastFrameId: this.last?.frameId, worldId: this.last?.worldId, generation: this.last?.generation, eventsFile: 'events.jsonl' }
  await writeFile(join(this.directory, 'manifest.json'), JSON.stringify(summary, null, 2), { mode: 0o600 }); return summary
 }
}
export async function replayRecording(path: string, onFrame: (frame: Frame) => void) {
 const text = (await readFile(path, 'utf8')).trim(); if (!text) return { frameCount: 0, lastFrameId: undefined }
 const lines = text.split('\n'); let count = 0; let previous: Frame | undefined; let previousKind: string | undefined; const seen = new Set<string>()
 for (const line of lines) {
  const event = JSON.parse(line); if (event.kind !== 'frame' && event.kind !== 'start') continue
  const frame = event.frame as Frame
  if (!frame?.frameId || seen.has(recordingFrameIdentity(frame))) continue
  // Older recordings wrote a stale cached frame immediately after `start`.
  // Keep those files readable while rejecting any later out-of-order frame.
  if (previous && (frame.worldId !== previous.worldId || frame.generation < previous.generation || frame.generation === previous.generation && (frame.stepIndex < previous.stepIndex || (frame.sceneRevision ?? -1) < (previous.sceneRevision ?? -1)))) {
   if (previousKind === 'start' && frame.worldId === previous.worldId && frame.generation === previous.generation) continue
   throw new Error('INVALID_FRAME_ORDER')
  }
  if (previous && frame.generation === previous.generation && frame.stepIndex === previous.stepIndex && frame.sceneRevision === previous.sceneRevision) continue
  onFrame(frame); previous = frame; count++
  seen.add(recordingFrameIdentity(frame)); previousKind = event.kind
 }
 return { frameCount: count, lastFrameId: previous?.frameId }
}
