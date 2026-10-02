import type { SimWorlds } from '../../sim-contract/src/index.ts'
import type { Frame, ActionReceipt } from '../../lyapunov-contracts/src/types.ts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createWriteStream, type WriteStream } from 'node:fs'
import { join } from 'node:path'
/** 同一步可以应用新的Scene元数据版本；不能只用不含revision的frameId去重。 */
export function recordingFrameIdentity(frame: Pick<Frame, 'worldId' | 'generation' | 'sceneRevision' | 'stepIndex'>): string { return JSON.stringify([frame.worldId, frame.generation, frame.sceneRevision, frame.stepIndex]) }
export class SimulationRecording {
 private stream?: WriteStream
 private unsubscribe?: () => void
 private last?: Frame
 private count = 0
 private failure?: Error
 constructor(readonly directory: string, readonly sessionRef: string) {}
 get progress() { return { frameCount: this.count, lastFrame: this.last } }
 async start(sim: SimWorlds, worldId: string, onFrame?: (frame: Frame) => void, observed?: Frame) {
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
