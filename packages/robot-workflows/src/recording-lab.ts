import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { recordingDirectory, type RecordingManifest } from './recording-files.ts'

export function labExportJob(subprocess: Context['subprocess'] | undefined, root: string, manifest: RecordingManifest, python: string | undefined) {
 const samples = manifest.controlSamples
 if (!samples?.completeCount || samples.completeCount !== samples.sampleCount || manifest.status !== 'completed') {
  throw new Error('LAB_EXPORT_INCOMPLETE_EPISODE: 需要完整的原生控制步录制')
 }
 if (!python || !isAbsolute(python) || !subprocess) {
  throw new Error('LAB_EXPORT_RUNTIME_UNAVAILABLE: 请配置独立的 LYAPUNOV_LAB_EXPORT_PYTHON')
 }
 const controller = new AbortController()
 const done = (async () => {
  const datasets = join(root, 'datasets')
  await mkdir(datasets, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(datasets, '.isaac-lab-'))
  try {
   controller.signal.throwIfAborted()
   const request = { source: join(recordingDirectory(root, manifest.recordingId), 'control-samples.jsonl'), output: staging, sessionRef: manifest.sessionRef, sceneId: manifest.sceneId, recordingId: manifest.recordingId, controlSamples: samples }
   const child = subprocess.spawn({
    argv: [python, fileURLToPath(new URL('../python/export_lab_recording.py', import.meta.url))],
    cwd: staging, signal: controller.signal, graceMs: 2000,
    stdio: { stdin: { data: JSON.stringify(request) }, stdout: { maxBytes: 32_768 }, stderr: { maxBytes: 32_768 } },
   })
   const outcome = await child.done
   controller.signal.throwIfAborted()
   if (outcome.exitCode !== 0) throw new Error(child.collected.stderr?.readFrom(0).text || `LAB_EXPORT_FAILED: ${outcome.exitCode}`)
   const report = JSON.parse(child.collected.stdout?.readFrom(0).text ?? '')
   const target = join(datasets, `${manifest.recordingId}-lab-${staging.split('-').at(-1)}`)
   await rename(staging, target)
   return { status: 'completed' as const, result: JSON.stringify({ ...report, outputDir: target }) }
  } finally { await rm(staging, { recursive: true, force: true }) }
 })().catch(error => ({ status: controller.signal.aborted ? 'killed' as const : 'failed' as const, result: String(error) }))
 return { cancel: () => controller.abort(), done }
}
