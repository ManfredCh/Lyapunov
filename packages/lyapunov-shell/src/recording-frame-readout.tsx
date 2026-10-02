import type { Frame } from '../../lyapunov-contracts/src/types.ts'
import type { Translate } from './entity-editor.tsx'
import { recordingFrameReadoutAttributes, recordingFrameReadoutText } from './recording-frame-readout.ts'
/** 回放帧读数元素：属性语义见 recording-frame-readout.ts（判据只读它，不读加载占位文本）。 */
export function RecordingFrameReadout({ frame, index, count, tr }: { frame?: Frame; index?: number; count?: number; tr: Translate }) {
 const text = recordingFrameReadoutText(frame, tr('读取录制帧', 'Loading recorded frames'))
 return <span {...recordingFrameReadoutAttributes(frame, index, count)} title={frame ? text : undefined}>{text}</span>
}
