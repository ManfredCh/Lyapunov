import type { Context } from '@deepseek-ai/cordis'
import { requireSessionId, sessionNamespace } from '../../lyapunov-contracts/src/session-scope.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { JobId, type JobOutcome } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-commands'
import { simWorldsFor } from '../../sim-contract/src/index.ts'
import type {} from '../../scene-kit/src/plugin.ts'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { Frame, SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import { SimulationRecording } from './recording.ts'
import { captureRecordingScene, captureRecordingResult, exportRecording, listRecordings, readRecording, readRecordingManifest, recordingSummary, recordingDirectory, recordingSegmentMatches, writeRecordingManifest, type RecordingManifest } from './recording-files.ts'
import { worldScene } from './world-scene.ts'
import { RecordingSessionEvents } from './recording-events.ts'
declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { recording: 'recording'; dataset: 'dataset' } }
export interface RecordingConfig { recordingRoot?: string }
const sourceFrame = (f: Frame) => ({ frameId: f.frameId, generation: f.generation, ...(f.sceneRevision === undefined ? {} : { sceneRevision: f.sceneRevision }), stepIndex: f.stepIndex, simTime: f.simTime })

export function applyRecording(ctx: Context, config: RecordingConfig = {}) {
 // 世界服务与场景订阅都按**发起录制的会话**取（同一个 agent 推出来的会话键），
 // 没有会话就明确失败：录制不会读到别的会话的世界，也不订阅别人的场景。
 const sim = (agent: Agent) => simWorldsFor(ctx, agent)
 const sceneOf = (agent: Agent) => ctx.scene.forSession(requireSessionId(agent, '录制场景订阅'))
 const runId = randomUUID(), root = config.recordingRoot ?? (process.env.LYAPUNOV_SCENE_ROOT ? join(process.env.LYAPUNOV_SCENE_ROOT, 'recordings') : undefined)
 // 相对根会被 resolve() 锚到**宿主进程 cwd**（产品安装根），把用户录制写进宿主根——与采集工具的相对
 // outputDir 同一类越界（70 §6.5）。录制根是宿主级配置、没有会话可作基准：相对值明确拒绝，不静默落到 cwd。
 const recordingRoot = () => {
  if (!root) throw new Error('RECORDING_ROOT_REQUIRED')
  if (!isAbsolute(root)) throw new Error(`RECORDING_ROOT_NOT_ABSOLUTE: recordingRoot 必须是绝对路径（收到 ${root}）；相对路径会落到宿主进程工作目录`)
  return resolve(root)
 }
 // 录制归**发起录制的那个会话**所有：目录是 `<recordingRoot>/sessions/<会话键>`，与读取侧
 // （shell 的 recordingDirectory）共用同一份 sessionNamespace 规则。没有会话就明确失败：
 // 既不把 A 的录制写进 B 能看到的地方，也不回落到宿主共享目录。
 const directory = (agent: Agent) => sessionNamespace(recordingRoot(), requireSessionId(agent, '录制目录'))
 const summary = (m: RecordingManifest, agent?: Agent) => recordingSummary(m, agent === undefined ? undefined : requireSessionId(agent, '录制归属'))
 const current = async (agent: Agent, id: string) => {
  const m = await readRecordingManifest(directory(agent), id)
  if (m.status === 'recording' && m.runId !== runId) { m.status = 'interrupted'; m.stopReason = 'host-restarted'; m.stoppedAt = new Date().toISOString(); await writeRecordingManifest(directory(agent), m) }
  return m
 }
 const operations = {
  async recording_start(input: { sceneId: string; worldId: string; expectedGeneration: number; maxDurationS: number; cameraNames?: string[]; width?: number; height?: number; cameraEveryNFrames?: number }, agent?: Agent) {
   if (!agent) throw new Error('RECORDING_AGENT_REQUIRED')
   if (!Number.isFinite(input.maxDurationS) || input.maxDurationS < .1 || input.maxDurationS > 300) throw new Error('INVALID_ARGUMENT: maxDurationS必须在0.1至300之间')
   // 可选多视角采集：给出 cameraNames 时，录制期间按同一物理步一次采集全部命名相机（camera_capture_multi），
   // 不给则与旧录制完全一致（只在会话里采集时记录采集回执）。
   const cameraNames = input.cameraNames === undefined ? undefined : input.cameraNames
   if (cameraNames !== undefined && (!Array.isArray(cameraNames) || cameraNames.length === 0 || cameraNames.some(name => typeof name !== 'string' || !name.trim()) || new Set(cameraNames.map(name => name.trim())).size !== cameraNames.length)) throw new Error('INVALID_ARGUMENT: cameraNames必须是非空且不重复的相机名数组')
   const cameraWidth = input.width ?? 640, cameraHeight = input.height ?? 480
   if (cameraNames !== undefined && (input.width === undefined) !== (input.height === undefined)) throw new Error('INVALID_ARGUMENT: width与height必须同时给出')
   const cameraEveryNFrames = input.cameraEveryNFrames ?? 1
   if (cameraNames !== undefined && (!Number.isInteger(cameraEveryNFrames) || cameraEveryNFrames < 1)) throw new Error('INVALID_ARGUMENT: cameraEveryNFrames必须是正整数')
   const world = (await sim(agent).listWorlds()).find(w => w.worldId === input.worldId)
   if (!world || world.sceneId !== input.sceneId || world.worldGeneration !== input.expectedGeneration) throw new Error('RECORDING_WORLD_GENERATION_MISMATCH')
   const manifest: RecordingManifest = { recordingId: 'recording-' + randomUUID(), sessionRef: agent.id, sceneId: input.sceneId, status: 'recording', createdAt: new Date().toISOString(), runId, maxDurationS: input.maxDurationS, frameCount: 0, eventCount: 0, segments: [], resources: [], missing: [] }
   const source = await worldScene(ctx, sim(agent), world, agent)
   const sourceScene = source.snapshot
   await captureRecordingScene(directory(agent), manifest, world, sourceScene)
   const sourceScenes = new Map<number, SceneSnapshot>([[sourceScene.revision, sourceScene]])
   const sceneOwner = source.owner
   const initial = await sim(agent).observe(input.worldId)
   if (initial.generation !== input.expectedGeneration) throw new Error('RECORDING_WORLD_GENERATION_MISMATCH')
   // firstFrame 与 events.jsonl 里 start 事件的帧必须是同一次真实观察：下面把它原样交给
   // recorder 当种子，recorder 不再单独 observe 一次（否则两次观察之间的世界漂移会让
   // firstFrame 落在帧集之外，02 报告实测 7276 vs 7280）。
   manifest.firstFrame = sourceFrame(initial)
   const recorder = new SimulationRecording(recordingDirectory(directory(agent), manifest.recordingId), agent.id)
   let finish!: (reason: string) => Promise<void>
   const jobId = ctx.jobs.start({ kind: 'recording', label: `录制 ${input.sceneId}`, owner: agent, outputLimitBytes: 4000, run: () => {
    let stopping: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined, saveTimer: ReturnType<typeof setInterval> | undefined, offEvents: (() => void) | undefined, offScene: (() => void) | undefined, observationTimer: ReturnType<typeof setInterval> | undefined, observationBusy = false, queue = Promise.resolve(), elapsedS = 0, lastFrame = initial
    // 多视角采集状态：只记录真实发生的采集与其相对订阅帧的步差，不做任何“已经是同步”的假设。
    const cameraCapture = cameraNames === undefined ? undefined : { cameraNames: [...cameraNames], width: cameraWidth, height: cameraHeight, everyNFrames: cameraEveryNFrames, frames: 0, captures: 0, synchronizedFrames: 0, driftedFrames: 0, maxStepDrift: 0, stopped: undefined as string | undefined }
    const recordSceneFor = async (frame: Pick<Frame, 'worldId' | 'generation' | 'sceneRevision'>) => {
     if (manifest.segments.some(segment => recordingSegmentMatches(segment, frame))) return
     if (frame.sceneRevision === undefined) throw new Error('RECORDING_FRAME_REVISION_REQUIRED')
     const currentWorld = (await sim(agent).listWorlds()).find(world => world.worldId === frame.worldId && world.worldGeneration === frame.generation)
     if (!currentWorld) throw new Error('RECORDING_WORLD_DISAPPEARED')
     const snapshot = sourceScenes.get(frame.sceneRevision) ?? (await worldScene(ctx, sim(agent), currentWorld, agent)).snapshot
     if (snapshot.revision !== frame.sceneRevision) throw new Error('RECORDING_SCENE_REVISION_UNAVAILABLE: ' + frame.sceneRevision)
     // frame确认这个文档版本曾应用于该world；引擎/时钟信息仍来自同代次真实handle。
     await captureRecordingScene(directory(agent), manifest, { ...currentWorld, appliedSceneRevision: frame.sceneRevision }, snapshot)
     await writeRecordingManifest(directory(agent), manifest)
    }
    const done = Promise.withResolvers<JobOutcome>()
    finish = reason => stopping ??= (async () => {
     if (timer) clearTimeout(timer); if (saveTimer) clearInterval(saveTimer); if (observationTimer) clearInterval(observationTimer); offEvents?.(); offScene?.(); recorder.pauseFrames()
     try {
      try { await queue } catch (error) { reason = String(error) }
      const stats = await recorder.stop(); manifest.frameCount = stats.frameCount
      manifest.status = ['recording-stop', 'duration-limit', 'frame-limit', 'wall-time-limit'].includes(reason) ? 'completed' : reason === 'job-killed' || reason.includes('disposed') ? 'killed' : 'failed'
      manifest.stopReason = reason; manifest.stoppedAt = new Date().toISOString(); await writeRecordingManifest(directory(agent), manifest)
      done.resolve({ status: manifest.status === 'completed' ? 'completed' : manifest.status === 'killed' ? 'killed' : 'failed', output: JSON.stringify(summary(manifest, agent)), detail: reason })
     } catch (error) { manifest.status = 'failed'; manifest.stopReason = String(error); await writeRecordingManifest(directory(agent), manifest); done.resolve({ status: 'failed', output: JSON.stringify(summary(manifest, agent)) }) }
    })()
    // 投影拥有的Scene没有SceneStore订阅；新revision在recordSceneFor里按需读同一world投影。
    offScene = sceneOwner === 'scene-store' ? sceneOf(agent).scene.subscribe(input.sceneId, snapshot => { if (!stopping) sourceScenes.set(snapshot.revision, snapshot) }) : undefined
    queue = recorder.start(sim(agent), input.worldId, frame => {
     if (stopping) return
     manifest.frameCount = recorder.progress.frameCount; manifest.lastFrame = sourceFrame(frame)
     elapsedS += frame.generation === lastFrame.generation ? Math.max(0, frame.simTime - lastFrame.simTime) : 0; lastFrame = frame
     if (!manifest.segments.some(segment => recordingSegmentMatches(segment, frame))) {
      queue = queue.then(() => recordSceneFor(frame)).catch(error => { void finish(String(error)); throw error })
     }
     if (cameraCapture && !cameraCapture.stopped) cameraCapture.frames++
     if (cameraCapture && !cameraCapture.stopped && (cameraCapture.frames - 1) % cameraCapture.everyNFrames === 0) {
      if (cameraCapture.captures >= 600) cameraCapture.stopped = 'capture-limit'
      else queue = queue.then(async () => {
       // 一次调用采集全部相机（同一物理步），再按回执自己的帧身份落 Scene；
       // 回执带真实 stepIndex/frameId，与订阅帧的步差如实登记，绝不当作同步。
       const receipt = await sim(agent).captureMulti(input.worldId, { outputDir: join(recordingDirectory(directory(agent), manifest.recordingId), 'captures'), cameraNames: cameraCapture.cameraNames, width: cameraCapture.width, height: cameraCapture.height })
       if (typeof receipt.worldId === 'string' && Number.isInteger(receipt.generation) && Number.isInteger(receipt.sceneRevision)) await recordSceneFor({ worldId: receipt.worldId, generation: receipt.generation as number, sceneRevision: receipt.sceneRevision as number })
       cameraCapture.captures++
       const drift = Number.isInteger(receipt.stepIndex) ? (receipt.stepIndex as number) - frame.stepIndex : 0
       if (drift === 0) cameraCapture.synchronizedFrames++; else { cameraCapture.driftedFrames++; cameraCapture.maxStepDrift = Math.max(cameraCapture.maxStepDrift, drift) }
       manifest.cameraCapture = { ...cameraCapture }
       await captureRecordingResult(directory(agent), manifest, { source: { name: 'camera_capture_multi', callId: String(receipt.captureId), kind: 'provider' }, result: receipt })
       const recorded = manifest.captures![manifest.captures!.length - 1]
       recorded.targetFrameId = frame.frameId; recorded.targetStepIndex = frame.stepIndex; recorded.stepDrift = drift; recorded.synchronized = drift === 0
      }).catch(error => { void finish(String(error)); throw error })
     }
     if (elapsedS >= input.maxDurationS || manifest.frameCount >= 10000) void finish(elapsedS >= input.maxDurationS ? 'duration-limit' : 'frame-limit')
    }, initial)
    const sessionEvents = new RecordingSessionEvents(input.worldId, input.sceneId)
    offEvents = ctx.on('session/event', (session, event) => {
     if (session.id !== agent.id || stopping) return
     const accepted = sessionEvents.accept(event)
     for (const raw of accepted.events) { recorder.event({ kind: 'session-event', event: raw }); manifest.eventCount++ }
     if (accepted.capture) queue = queue.then(async () => {
      const result = accepted.capture!.result
      if (Number.isInteger(result.generation) && Number.isInteger(result.sceneRevision)) await recordSceneFor(result as Frame)
      await captureRecordingResult(directory(agent), manifest, accepted.capture!)
     }).catch(error => { void finish(String(error)); throw error })
    })
    timer = setTimeout(() => void finish('wall-time-limit'), Math.max(10000, input.maxDurationS * 2000))
    observationTimer = setInterval(() => {
     if (stopping || observationBusy) return
     observationBusy = true
     queue = queue.then(async () => { const frame = await sim(agent).observe(input.worldId, { contacts: true, sensors: true }); recorder.event({ kind: 'observation', frame }); manifest.observationCount = (manifest.observationCount ?? 0) + 1 }).catch(error => { void finish(String(error)); throw error }).finally(() => { observationBusy = false })
    }, 250)
    saveTimer = setInterval(() => { queue = queue.then(() => writeRecordingManifest(directory(agent), manifest)).catch(error => { void finish(String(error)); throw error }) }, 1000)
    void queue.catch(error => finish(String(error)))
    return { cancel: reason => { void finish(reason === 'recording-stop' ? reason : 'job-killed') }, done: done.promise }
   } })
   manifest.jobId = jobId; await writeRecordingManifest(directory(agent), manifest); return summary(manifest, agent)
  },
  async recording_stop(input: { recordingId: string }, agent?: Agent) {
   if (!agent) throw new Error('RECORDING_AGENT_REQUIRED')
   const manifest = await current(agent, input.recordingId)
   if (manifest.status === 'recording') { ctx.jobs.kill(JobId(manifest.jobId!), agent, 'recording-stop'); await ctx.jobs.wait(JobId(manifest.jobId!), 10000, agent) }
   return summary(await current(agent, input.recordingId), agent)
  },
  async recording_list(input: { sceneId?: string }, agent?: Agent) {
   if (!agent) throw new Error('RECORDING_AGENT_REQUIRED')
   const rows = await listRecordings(directory(agent), input.sceneId); return Promise.all(rows.map(async r => summary(await current(agent, r.recordingId), agent)))
  },
  async recording_inspect(input: { recordingId: string; generation?: number; sceneRevision?: number; stepIndex?: number }, agent?: Agent) {
   if (!agent) throw new Error('RECORDING_AGENT_REQUIRED')
   const manifest = await current(agent, input.recordingId)
   if (input.generation === undefined && input.sceneRevision === undefined && input.stepIndex === undefined || manifest.status === 'recording') return summary(manifest, agent)
   const replay = await readRecording(directory(agent), input.recordingId)
   if (input.generation === undefined && input.stepIndex !== undefined && new Set(replay.segments.map(segment => segment.world.worldGeneration)).size > 1) throw new Error('RECORDING_GENERATION_REQUIRED: 多代次录制必须同时给原generation与stepIndex')
   let segments = replay.segments.filter(segment => input.generation === undefined || segment.world.worldGeneration === input.generation)
   if (!segments.length) throw new Error('RECORDING_GENERATION_NOT_FOUND')
   if (input.sceneRevision !== undefined) { segments = segments.filter(segment => segment.scene.revision === input.sceneRevision); if (!segments.length) throw new Error('RECORDING_SCENE_REVISION_NOT_FOUND') }
   const selected = segments.flatMap(segment => input.stepIndex === undefined ? segment.frames.slice(0, 1) : segment.frames.filter(frame => frame.stepIndex === input.stepIndex))
   if (selected.length > 1) throw new Error('RECORDING_SCENE_REVISION_REQUIRED: 同代次包含多个文档版本，请指定sceneRevision')
   const frame = selected[0]
   if (!frame) throw new Error('RECORDING_STEP_NOT_FOUND: 仅接受实际已记录步号')
   return { ...summary(manifest, agent), selectedFrame: { ...sourceFrame(frame), worldId: frame.worldId, entityCount: frame.entities.length, entities: frame.entities.slice(0, 8).map(e => ({ entityId: e.entityId, position: e.transform.position, jointCount: e.joints?.names.length ?? 0 })) } }
  },
  async recording_export(input: { recordingId: string }, agent?: Agent) {
   if (!agent) throw new Error('RECORDING_AGENT_REQUIRED')
   const m = await current(agent, input.recordingId); if (m.status === 'recording') throw new Error('RECORDING_NOT_FINISHED')
   const jobId = ctx.jobs.start({ kind: 'dataset', label: `导出录制 ${m.recordingId}`, owner: agent, outputLimitBytes: 4000, run: () => { let cancelled = false; return { cancel: () => { cancelled = true }, done: exportRecording(directory(agent), m.recordingId).then(result => ({ status: cancelled ? 'killed' as const : result.status === 'PARTIAL' ? 'failed' as const : 'completed' as const, output: JSON.stringify(result) }), error => ({ status: 'failed' as const, output: String(error) })) } } })
   return { jobId, recordingId: m.recordingId }
  },
 }
 const descriptions: Record<keyof typeof operations, string> = {
  recording_start: "Start bounded recording of a real world through native Jobs. Save complete frames, the current Scene, original resources and dependencies, and actual robot Tool/Command events from the same session. When cameraNames is supplied, each capture records all named cameras in one call at the same physics step, preserving synchronized multi-view RGB, depth in meters, and calibration. maxDurationS is at most 300 seconds and the recording is limited to 10000 frames. Recording does not control physics.",
  recording_stop: "Stop the current recording Job and confirm that its files were saved; do not stop robots or resend actions.",
  recording_list: "List private recording summaries for the current account. After a Host restart, unfinished recordings are explicitly interrupted; motion is not resumed.",
  recording_inspect: "Inspect recording provenance by actual generation/sceneRevision/stepIndex. Use sceneRevision to distinguish document versions within one generation. A nonexistent step is an error.",
  recording_export: "Export real frame JSONL, native events, Scene versions, resource dependencies, and a dataset manifest through native Jobs. Return output-directory references; recording completion is not task success.",
 }
 const id = { type: 'string' as const, required: true as const, description: "recordingId returned by recording_start/list." }
 const parameters: Record<keyof typeof operations, ParameterSchemaSpec> = {
  recording_start: { input: { type: 'object', required: true, additionalProperties: false, properties: { sceneId: { type: 'string', required: true }, worldId: { type: 'string', required: true }, expectedGeneration: { type: 'integer', required: true }, maxDurationS: { type: 'number', required: true, description: "Recording duration in physical seconds, from 0.1 to 300." }, cameraNames: { type: 'array', items: { type: 'string', description: "Named camera in this world, returned by camera_list." }, description: "Optional multi-view recording. When supplied, each capture during recording calls camera_capture_multi once for all listed cameras at the same physics step, writing per-camera RGB, depth in meters, and calibration into the manifest and exported dataset. Omission preserves the existing recording behavior. Reject the entire request for missing or duplicate names." }, width: { type: 'integer', description: "Multi-view capture width in pixels; must be supplied together with height." }, height: { type: 'integer', description: "Multi-view capture height in pixels; must be supplied together with width." }, cameraEveryNFrames: { type: 'integer', description: "Capture all cameras every N subscribed frames. Defaults to 1, meaning every frame; this does not configure physics steps. Record actual capture/subscription step differences as synchronized/stepDrift instead of combining unsynchronized captures as synchronized data." } } } },
  recording_stop: { input: { type: 'object', required: true, additionalProperties: false, properties: { recordingId: id } } },
  recording_list: { input: { type: 'object', required: true, additionalProperties: false, properties: { sceneId: { type: 'string' } } } },
  recording_inspect: { input: { type: 'object', required: true, additionalProperties: false, properties: { recordingId: id, generation: { type: 'integer' }, sceneRevision: { type: 'integer' }, stepIndex: { type: 'integer' } } } },
  recording_export: { input: { type: 'object', required: true, additionalProperties: false, properties: { recordingId: id } } },
 }
 for (const [name, operation] of Object.entries(operations)) {
  const execute = (input: unknown, agent?: Agent) => (operation as (input: any, agent?: Agent) => Promise<any>)(input, agent)
  ctx.tools.register(defineTool({ name, description: descriptions[name as keyof typeof operations], parameters: parameters[name as keyof typeof operations], output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: (args, execution) => execute(args.input, execution.agent) }))
  ctx.commands.register({ name, description: descriptions[name as keyof typeof operations], input: { hint: "Recording arguments as JSON." }, handler: async invocation => { try { return { kind: 'success', text: JSON.stringify(await execute(JSON.parse(invocation.rawInput || '{}'), invocation.agent)) } } catch (error) { return { kind: 'error', text: String(error) } } } })
 }
}
