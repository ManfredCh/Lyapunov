import { createWriteStream, type WriteStream } from 'node:fs'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { join } from 'node:path'
import type { SimWorlds, ControlSamplingOptions, ControlSample } from '../../sim-contract/src/index.ts'
import { validControlSample } from '../../sim-contract/src/control-samples.ts'

export interface RecordedControlSamples {
 profile: 'joint-position-reference-v1'; episodeId: string; entityId: string
 samplesFile: 'control-samples.jsonl'; sampleCount: number; completeCount: number
}

/** 现有录制作业的一条控制数据通道，不拥有物理步进或机器人控制。 */
export class ControlSampleRecording {
 private stream?: WriteStream
 private off?: () => void
 private disable?: () => Promise<unknown>
 private failure?: Error
 private readonly directory: string
 private readonly sessionRef: string
 private readonly options: ControlSamplingOptions
 readonly summary: RecordedControlSamples
 constructor(directory: string, sessionRef: string, options: ControlSamplingOptions) {
  this.directory = directory
  this.sessionRef = sessionRef
  this.options = options
  this.summary = { profile: 'joint-position-reference-v1', episodeId: options.episodeId, entityId: options.entityId, samplesFile: 'control-samples.jsonl', sampleCount: 0, completeCount: 0 }
 }
 async start(sim: SimWorlds, worldId: string, onError: (error: Error) => void) {
  if (!sim.configureControlSampling || !sim.subscribeControlSamples) throw new Error('UNSUPPORTED_CAPABILITY: Provider 没有控制步采样')
  const reject = (error: Error) => { this.failure ??= error; onError(error) }
  this.stream = createWriteStream(join(this.directory, this.summary.samplesFile), { flags: 'ax', mode: 0o600 })
  this.stream.on('error', reject)
  await once(this.stream, 'open')
  this.off = sim.subscribeControlSamples(worldId, (sample: ControlSample) => {
   if (this.failure || !this.stream) return
   if (!validControlSample(sample) || sample.worldId !== worldId || sample.generation !== this.options.expectedGeneration || sample.episodeId !== this.options.episodeId || sample.entityId !== this.options.entityId || sample.controlCycleIndex !== this.summary.sampleCount) {
    reject(new Error('CONTROL_SAMPLE_SOURCE_OR_SEQUENCE_MISMATCH')); return
   }
   if (this.stream.writableLength > 16 * 1024 * 1024) { reject(new Error('CONTROL_SAMPLE_WRITE_BACKLOG')); return }
   this.stream.write(JSON.stringify({ kind: 'control-sample', sessionRef: this.sessionRef, sample })+'\n')
   this.summary.sampleCount++
   if (sample.complete) this.summary.completeCount++
  })
  try {
   await sim.configureControlSampling(worldId, this.options)
   this.disable = () => sim.configureControlSampling!(worldId, { ...this.options, enabled: false })
  } catch (error) {
   this.off(); this.off = undefined
   const stream = this.stream; this.stream = undefined
   stream.end(); await finished(stream)
   throw error
  }
 }
 async stop() {
  try { await this.disable?.() } catch (error) { this.failure ??= error instanceof Error ? error : new Error(String(error)) }
  this.disable = undefined; this.off?.(); this.off = undefined
  if (this.stream) {
   const stream = this.stream; this.stream = undefined
   stream.end(); await finished(stream)
  }
  if (this.failure) throw this.failure
  return { ...this.summary }
 }
}
