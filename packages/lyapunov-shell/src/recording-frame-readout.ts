import type { Frame } from '../../lyapunov-contracts/src/types.ts'
/**
 * 回放帧读数的判据表面：真实回放帧（events.jsonl 经 replayRecording 读出）→ 非空 data-*；
 * 没有帧时只给 data-state="loading"，不渲染任何帧数值属性。UI/驱动判据必须按“属性存在且非空”
 * 判定，不能再出现“探针取到空值也算通过”的口径（02 报告 f2.replay.readonly 即因此无效通过：
 * 回放期间 [data-testid=world-step] 不渲染，探针拿到空串反而满足 || B==="" 的通过条件）。
 */
export function recordingFrameReadoutAttributes(frame: Frame | undefined, index?: number, count?: number): Record<string, string> {
 if (!frame) return { 'data-testid': 'recording-step', 'data-state': 'loading' }
 const attributes: Record<string, string> = {
  'data-testid': 'recording-step',
  'data-state': 'frame',
  'data-frame-id': frame.frameId,
  'data-generation': String(frame.generation),
  'data-step-index': String(frame.stepIndex),
  'data-sim-time': frame.simTime.toFixed(6),
 }
 if (frame.sceneRevision !== undefined) attributes['data-scene-revision'] = String(frame.sceneRevision)
 if (index !== undefined) attributes['data-frame-index'] = String(index)
 if (count !== undefined) attributes['data-frame-count'] = String(count)
 return attributes
}
/** 现有可读文本保持不变（g/step/s）；loading 文案由调用方按语言传入。 */
export function recordingFrameReadoutText(frame: Frame | undefined, loading: string): string {
 return frame ? `g${frame.generation} · step ${frame.stepIndex} · ${frame.simTime.toFixed(3)} s` : loading
}
