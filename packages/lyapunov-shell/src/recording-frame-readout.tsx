import type { Frame } from '../../lyapunov-contracts/src/types.ts'
import type { Translate } from './entity-editor.tsx'
import { recordingFrameReadoutAttributes, recordingFrameReadoutText } from './recording-frame-readout.ts'
/** 回放帧读数元素：属性语义见 recording-frame-readout.ts（判据只读它，不读加载占位文本）。 */
export function RecordingFrameReadout({ frame, index, count, tr, firstTime, lastTime }: { frame?: Frame; index?: number; count?: number; tr: Translate; firstTime?: number; lastTime?: number }) {
 const text = recordingFrameReadoutText(frame, tr('读取录制帧', 'Loading recorded frames'))
 const display=frame&&Number.isFinite(firstTime)&&Number.isFinite(lastTime)
  ? `${Math.max(0,frame.simTime-firstTime!).toFixed(2)} / ${Math.max(0,lastTime!-firstTime!).toFixed(2)} s sim`
  :text
 return <span {...recordingFrameReadoutAttributes(frame, index, count)} title={frame ? text : undefined}>{display}</span>
}
