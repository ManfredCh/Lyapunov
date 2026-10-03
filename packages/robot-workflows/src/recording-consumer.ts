import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { recordingActions } from './recording-events.ts'
import { readRecordingManifest, readRecordingResource, recordingCaptureObservation, recordingDirectory, recordingResourceKey, recordingSegmentMatches } from './recording-files.ts'

/** 从录制或搬目录后的导出逐份读取真实RGB-D样本；沿用现有PNG/NPY/Frame。 */
export async function* readRecordingCaptureSamples(root: string, recordingId: string) {
 const manifest = await readRecordingManifest(root, recordingId)
 if (manifest.status === 'recording') throw new Error('RECORDING_NOT_FINISHED')
 const directory = recordingDirectory(root, recordingId)
 const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
 const actions = recordingActions(events)
 for (const capture of manifest.captures ?? []) {
  const receiptResource = await readRecordingResource(root, recordingId, recordingResourceKey(capture.receiptPath))
  const receipt = JSON.parse(Buffer.from(receiptResource.data).toString('utf8'))
  const observation = recordingCaptureObservation(receipt, capture)
  if (!observation) throw new Error(`CAPTURE_OBSERVATION_UNAVAILABLE: ${capture.callId}`)
  if (!manifest.segments.some(segment => recordingSegmentMatches(segment, observation))) throw new Error('CAPTURE_SCENE_REVISION_NOT_RECORDED')
  const media = async (kind: 'rgb' | 'depth') => {
   const uri = receipt[kind]?.uri
   if (typeof uri !== 'string' || /^[a-z][a-z+.-]*:/i.test(uri)) throw new Error(`CAPTURE_PORTABLE_MEDIA_REQUIRED: ${kind}`)
   return readRecordingResource(root, recordingId, recordingResourceKey(uri))
  }
  const [rgb, depth] = await Promise.all([media('rgb'), media('depth')])
  const relatedActions = actions.filter(action => action.receipt.worldId === observation.worldId && action.receipt.generation === observation.generation).map(action => ({ ...action, phase: action.receipt.startStep === undefined ? 'unknown' : observation.stepIndex < action.receipt.startStep ? 'before' : action.receipt.endStep !== undefined && observation.stepIndex > action.receipt.endStep ? 'after' : 'during' }))
  yield { capture, receipt, observation, rgb, depth, actions: relatedActions }
 }
}
