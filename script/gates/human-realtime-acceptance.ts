/** 20真人与Panda的独立领域验收。只消费公开Scene/Sim，完整物理帧原样落盘。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { finished } from 'node:stream/promises'
import { SceneOperations } from '../../packages/scene-kit/src/operations.ts'
import { importHuman, spawnCrowd, type HumanImportInput } from '../../packages/human-crowd/src/operations.ts'
import { rocketboxLaneRegion } from '../../packages/human-crowd/src/rocketbox-sample.ts'
import { readRiggedGlb } from '../../packages/human-crowd/src/glb.ts'
import { MuJoCoProvider } from '../../packages/sim-mujoco/src/provider.ts'
import type { RobotDescription, JointTrajectory } from '../../packages/sim-contract/src/index.ts'
import type { ActionReceipt, Frame, HumanRoute, SceneSnapshot, Vec3, WorldHandle } from '../../packages/lyapunov-contracts/src/types.ts'

const argv = process.argv.slice(2)
function arg(name: string, fallback?: string): string {
  const index = argv.indexOf(name)
  if (index < 0) { if (fallback !== undefined) return fallback; throw Error('缺少参数 ' + name) }
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw Error('缺少参数值 ' + name)
  return value
}
function sha(bytes: string | Buffer) { return createHash('sha256').update(bytes).digest('hex') }
function numberArg(name: string, fallback: number) { const value = Number(arg(name, String(fallback))); assert.ok(Number.isFinite(value) && value > 0, name); return value }
async function json(path: string, value: unknown) { await writeFile(path, JSON.stringify(value, null, 2) + '\n') }
function git(...args: string[]) { return execFileSync('git', args, { encoding: 'utf8' }).trim() }
const repo = resolve(import.meta.dirname, '../..')

interface SourceMeta extends Omit<HumanImportInput, 'sceneId' | 'expectedRevision' | 'path'> {
  avatarId: string; glb: string; bytes: number; sha256: string; walkClip: string; walkSpeedMps: number
}
interface ManifestRow { avatarId: string; directory: string; glb: string; bytes: number; sha256: string; sourceSha256: string; definitionSha256: string; walkSpeedMps: number }
interface Manifest { schema: number; avatars: ManifestRow[] }
interface PersonStats { entityId: string; sourceSha256?: string; clip?: string; speedMps: number; travelM: number; blockedS: number; activeS: number; observedS: number; intervals: number; bones: number; segments: number }

/** 验收入口自身的帧准入，不能替代产品Viewer拒收门。 */
export function frameProblems(frame: Frame, world: WorldHandle, people: string[], previousStep?: number): string[] {
  const errors: string[] = []
  if (frame.worldId !== world.worldId) errors.push('worldId')
  if (frame.generation !== world.worldGeneration) errors.push('generation')
  if (frame.sceneRevision !== world.appliedSceneRevision) errors.push('sceneRevision')
  if (!Number.isInteger(frame.stepIndex) || frame.stepIndex < 0 || !Number.isFinite(frame.simTime)) errors.push('step/time')
  if (previousStep !== undefined && frame.stepIndex < previousStep) errors.push('step倒退')
  if (Math.abs(frame.simTime - frame.stepIndex * .002) > 1e-8) errors.push('物理步长')
  for (const id of people) {
    const pose = frame.entities.find(entity => entity.entityId === id)?.humanPose
    if (!pose) { errors.push('缺人体:' + id); continue }
    if (pose.stepIndex !== frame.stepIndex || pose.simTime !== frame.simTime) errors.push('人体错步:' + id)
    if (!['mujoco-site', 'mujoco-body'].includes(pose.source)) errors.push('非Mu原生姿态:' + id)
    if (pose.joints.length !== 81 || pose.segments.length !== 14) errors.push('完整骨段:' + id)
    for (const joint of pose.joints) if (![...joint.positionM, ...joint.quaternionXyzw].every(Number.isFinite)) errors.push('非有限骨:' + id)
  }
  for (const contact of frame.contacts ?? []) if (contact.sourceStep !== undefined && contact.sourceStep !== frame.stepIndex) errors.push('接触错步')
  return errors
}
function selfCheck() {
  const world: WorldHandle = { worldId: 'w', sceneId: 's', engineId: 'mujoco', engineVersion: 'fixture', worldGeneration: 1, appliedSceneRevision: 2, status: 'ready' }
  const frame: Frame = { worldId: 'w', generation: 1, sceneRevision: 2, stepIndex: 0, simTime: 0, frameId: 'f', entities: [] }
  assert.deepEqual(frameProblems(frame, world, []), [])
  for (const changed of [{ ...frame, worldId: 'other' }, { ...frame, generation: 2 }, { ...frame, sceneRevision: 1 }, { ...frame, stepIndex: 1 }]) assert.ok(frameProblems(changed, world, []).length)
  assert.ok(frameProblems(frame, world, ['missing']).length)
  return { status: '完成', scope: 'QA自身准入负例；不代表产品Viewer已拒收', rejectedWrongWorld: true, rejectedWrongGeneration: true, rejectedWrongRevision: true, rejectedWrongStep: true, rejectedMissingHuman: true }
}

async function prepare(out: string) {
  const ops = new SceneOperations(join(out, 'workspace'))
  let scene: SceneSnapshot
  const assets: Record<string, unknown>[] = []
  let manifestIdentity: Record<string, unknown> | undefined
  if (argv.includes('--scene')) {
    const path = resolve(arg('--scene'))
    scene = await ops.open(path, { sceneId: 'human-realtime-acceptance' })
    manifestIdentity = { reopenedScene: path, sourceSceneSha256: sha(await readFile(path)), scope: argv.includes('--legacy') ? '原7d单外观6秒输入，保原路线/停障布局' : '既有portable输入，保原路线' }
  } else {
    const manifestPath = resolve(arg('--manifest')), bytes = await readFile(manifestPath)
    const expected = arg('--manifest-sha256')
    assert.equal(sha(bytes), expected, 'MANIFEST_SHA256_MISMATCH')
    const manifest: Manifest = JSON.parse(bytes.toString())
    assert.equal(manifest.schema, 1); assert.ok(manifest.avatars.length >= 4)
    manifestIdentity = { path: manifestPath, sha256: expected }
    scene = await ops.create({ sceneId: 'human-realtime-acceptance' })
    const templates: string[] = [], routes: Record<string, HumanRoute> = {}
    for (const row of manifest.avatars.slice(0, 4)) {
      const directory = argv.includes('--avatar-root') ? join(resolve(arg('--avatar-root')), row.avatarId) : row.directory
      const metaPath = join(directory, 'source.json'), metaBytes = await readFile(metaPath), meta: SourceMeta = JSON.parse(metaBytes.toString())
      assert.equal(sha(metaBytes), row.sourceSha256, 'SOURCE_META_SHA256_MISMATCH:' + row.avatarId)
      assert.equal(sha(await readFile(join(row.directory, 'definition.json'))), row.definitionSha256, 'DEFINITION_SHA256_MISMATCH:' + row.avatarId)
      const path = join(directory, meta.glb), bytes = await readFile(path)
      assert.equal(bytes.length, row.bytes); assert.equal(sha(bytes), row.sha256); assert.equal(meta.sha256, row.sha256)
      const definition = readRiggedGlb(bytes, meta)
      assert.equal(definition.rig.length, 81); assert.equal(definition.clips.length, 7)
      assert.ok(definition.footCollision?.segments['leftAnkle-leftToe']); assert.ok(definition.footCollision?.segments['rightAnkle-rightToe'])
      assert.ok(definition.clips.some(clip => clip.name === meta.walkClip))
      const imported = await importHuman(ops, { ...meta, sceneId: scene.sceneId, expectedRevision: scene.revision, path, entityId: 'template-' + row.avatarId, templateOnly: true })
      scene = imported.snapshot; templates.push(imported.definitionEntityId)
      routes[imported.definitionEntityId] = { pointsM: [[3, 0, 0], [-3, 0, 0]], behavior: 'walk', loop: true, speedMps: meta.walkSpeedMps, clip: meta.walkClip }
      assets.push({ avatarId: row.avatarId, sha256: row.sha256, bytes: row.bytes, sourceSha256: row.sourceSha256, definitionSha256: row.definitionSha256, bones: definition.rig.length, clips: definition.clips.length, heightM: definition.heightM, walkClip: meta.walkClip, walkSpeedMps: meta.walkSpeedMps, footCollision: definition.footCollision })
    }
    const spawned = await spawnCrowd(ops, { sceneId: scene.sceneId, expectedRevision: scene.revision, templateEntityIds: templates, templateRoutes: routes, count: 20, seed: 42, groupId: 'normal20', collision: 'detailed', region: rocketboxLaneRegion(20) }, { defaultLanes: true })
    scene = spawned.snapshot
    const layout = arg('--layout', 'circles')
    assert.ok(['lanes', 'circles'].includes(layout), '--layout=lanes|circles')
    if (layout === 'circles') {
      const people = scene.entities.filter(entity => entity.components.human)
      scene = await ops.scene.commit({ sceneId: scene.sceneId, expectedRevision: scene.revision, patch: people.map((entity, i) => {
        const radius = 3 + Math.floor(i / 5) * 2, phase = (i % 5) * Math.PI * 2 / 5, theta = phase + Math.PI / 64
        const position: Vec3 = [radius * Math.cos(phase), radius * Math.sin(phase), 0]
        const pointsM: Vec3[] = Array.from({ length: 64 }, (_, j) => { const angle = phase + (j + 1) * Math.PI * 2 / 64; return [radius * Math.cos(angle), radius * Math.sin(angle), 0] })
        return { op: 'update' as const, entityId: entity.entityId, changes: { transform: { ...entity.transform, position, quaternion: [0, 0, Math.sin((theta + Math.PI / 2) / 2), Math.cos((theta + Math.PI / 2) / 2)] as [number, number, number, number] }, components: { ...entity.components, human: { ...entity.components.human!, route: { ...entity.components.human!.route!, pointsM, loop: true } } } } }
      }) })
    }
  }
  const people = scene.entities.filter(entity => entity.components.human)
  assert.equal(people.length, 20)
  assert.ok(people.every(entity => entity.components.human?.collision === 'detailed' && entity.components.human.route?.avoidObstacles !== false))
  assert.ok(argv.includes('--legacy') || new Set(people.map(entity => entity.components.human!.source.sha256)).size >= 4, 'NORMAL_REQUIRES_4_APPEARANCES')
  let panda = scene.entities.find(entity => entity.entityId === 'panda')
  const pandaPath = resolve(repo, 'materials/robots/franka_panda/franka_emika_panda/panda.xml')
  if (!panda) {
    const imported = await ops.import({ path: pandaPath, sceneId: scene.sceneId, category: 'robot', entityId: 'panda', name: 'Panda', physicalize: false, alignBottomToSurface: false, license: { id: 'Apache-2.0', source: 'declared' }, transform: { position: arg('--layout', 'circles') === 'circles' ? [0, 0, 0] : [0, -7, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] } })
    assert.ok(imported.snapshot)
    scene = imported.snapshot; panda = scene.entities.find(entity => entity.entityId === 'panda')!
    assert.ok(panda.components.mujoco && panda.resources.length, 'PANDA_RESOURCE_NOT_IMPORTED')
  }
  await ops.save(scene.sceneId, join(out, 'portable/scene.json'), { portable: true })
  await json(join(out, 'scene.json'), scene)
  const prepared = { status: '完成', scope: '公开SceneOperations导入与portable；未启动World/未验证GPU/画质/产品FPS', scenePath: join(out, 'scene.json'), portablePath: join(out, 'portable/scene.json'), sceneSha256: sha(JSON.stringify(scene, null, 2) + '\n'), manifest: manifestIdentity, assets, people: people.map(entity => ({ entityId: entity.entityId, sourceSha256: entity.components.human!.source.sha256, definition: entity.components.human!.definition, start: entity.transform.position, route: entity.components.human!.route })), layout: argv.includes('--scene') ? 'preserved-input' : arg('--layout', 'circles'), panda: { entityId: panda.entityId, modelPath: pandaPath, sourceSha256: sha(await readFile(pandaPath)), controls: '运行后从describe获取全部受控关节' } }
  await json(join(out, 'prepared.json'), prepared)
  return { scene, prepared }
}

function pandaTrajectory(description: RobotDescription, frame: Frame, durationS: number): JointTrajectory {
  const names = description.controlledJointNames
  assert.ok(names.length >= 7 && new Set(names).size === names.length, 'PANDA_CONTROL_METADATA_MISSING')
  const observed = frame.entities.find(entity => entity.entityId === 'panda')?.joints
  assert.ok(observed)
  const base = names.map(name => { const i = observed.names.indexOf(name); assert.ok(i >= 0, 'PANDA_JOINT_NOT_OBSERVED:' + name); return observed.positions[i]! })
  const moving = names.findIndex(name => description.joints.find(joint => joint.name === name)?.type === 'hinge')
  assert.ok(moving >= 0)
  const joint = description.joints.find(joint => joint.name === names[moving])!, range = joint.range
  const positiveRoom = range ? range[1] - base[moving]! : .2, negativeRoom = range ? base[moving]! - range[0] : .2
  const direction = positiveRoom >= negativeRoom ? 1 : -1, amplitude = Math.min(.2, (direction > 0 ? positiveRoom : negativeRoom) * .5)
  assert.ok(amplitude >= .05, 'PANDA_NO_SAFE_JOINT_EXCURSION')
  const times = Array.from({ length: Math.ceil(durationS) + 1 }, (_, i) => Math.min(i, durationS)).filter((t, i, all) => i === 0 || t > all[i - 1]!)
  const points = times.map(timeS => ({ timeS, positions: base.map((value, i) => value + (i === moving ? direction * amplitude * (1 - Math.cos(timeS * Math.PI / 2)) / 2 : 0)) }))
  assert.ok(points.every(point => point.positions.length === names.length))
  return { kind: 'trajectory', entityId: 'panda', jointNames: [...names], points, tolerance: .1, settleTimeS: 0 }
}

async function runRound(scene: SceneSnapshot, out: string, clock: 'manual' | 'realtime', round: number) {
  await mkdir(out, { recursive: true })
  const legacy = argv.includes('--legacy'), durationS = legacy || clock === 'manual' ? 6 : numberArg('--duration-s', 30)
  const sim = new MuJoCoProvider({ pythonPath: arg('--python', process.env.LYAPUNOV_MUJOCO_PYTHON), workerPath: argv.includes('--worker') ? resolve(arg('--worker')) : undefined })
  let world: WorldHandle | undefined, unsubscribe: (() => void) | undefined, streamError: unknown
  const framesStream = createWriteStream(join(out, 'frames.jsonl')), indexStream = createWriteStream(join(out, 'frame-arrivals.jsonl'))
  framesStream.on('error', error => { streamError = error }); indexStream.on('error', error => { streamError = error })
  const report: Record<string, any> = { status: '阻断', clock, round, durationS, scope: '公开MuJoCoProvider物理/计算门；完整工作台RTX/FPS由产品窗口另验', viewer: { status: '未验证', reason: '该入口不创建Viewer；不能代替完整产品工作台' }, checks: {}, logs: { frames: join(out, 'frames.jsonl'), arrivals: join(out, 'frame-arrivals.jsonl') } }
  const people = scene.entities.filter(entity => entity.components.human), ids = people.map(entity => entity.entityId), stats = new Map<string, PersonStats>()
  for (const entity of people) stats.set(entity.entityId, { entityId: entity.entityId, sourceSha256: entity.components.human!.source.sha256, clip: entity.components.human!.route?.clip, speedMps: entity.components.human!.route!.speedMps, travelM: 0, blockedS: 0, activeS: 0, observedS: 0, intervals: 0, bones: 0, segments: 0 })
  let count = 0, bytes = 0, previous: Frame | undefined, firstArrival: number | undefined, lastArrival: number | undefined, maxBacklogBytes = 0
  const errors: string[] = [], robotPositions = new Map<string, number[]>(), robotVelocities = new Map<string, number>(), timing = performance.now()
  try {
    world = await sim.open(scene, { clock, ground: true, timestepS: .002, frameRateHz: 30, realtimeFactor: 1, startPaused: true })
    report.world = world; report.prepareWallS = (performance.now() - timing) / 1000
    assert.equal(world.clock, clock); assert.equal(world.timestepS, .002)
    const before = await sim.observe(world.worldId, { contacts: true }), description = await sim.describe(world.worldId, 'panda')
    report.pandaDescription = description
    const gpuBefore = await sim.describe(world.worldId, ids[0]!)
    report.humanComputeBefore = gpuBefore.controller?.humanCompute ?? null
    const trajectory = pandaTrajectory(description, before, durationS)
    const action = { kind: 'batch' as const, actionId: `normal20-${clock}-${round}`, expectedGeneration: world.worldGeneration, motions: [...people.map(entity => ({ kind: 'human' as const, entityId: entity.entityId, durationS, route: entity.components.human!.route! })), trajectory] }
    await json(join(out, 'action.json'), action); await json(join(out, 'before.json'), before)
    unsubscribe = sim.subscribeFrames(world.worldId, frame => {
      const now = performance.now(), text = JSON.stringify(frame) + '\n'
      count++; bytes += Buffer.byteLength(text); framesStream.write(text); indexStream.write(JSON.stringify({ frameId: frame.frameId, stepIndex: frame.stepIndex, simTime: frame.simTime, wallMs: now }) + '\n')
      maxBacklogBytes = Math.max(maxBacklogBytes, framesStream.writableLength)
      if (frame.stepIndex > before.stepIndex) { firstArrival ??= now; lastArrival = now }
      errors.push(...frameProblems(frame, world!, ids, previous?.stepIndex).slice(0, 30))
      for (const entity of frame.entities) {
        const stat = stats.get(entity.entityId), pose = entity.humanPose
        if (stat && pose) {
          stat.bones = pose.joints.length; stat.segments = pose.segments.length
          stat.travelM = Math.max(stat.travelM, pose.motion?.distanceM ?? 0); stat.blockedS = Math.max(stat.blockedS, pose.motion?.blockedS ?? 0)
          const old = previous?.entities.find(item => item.entityId === entity.entityId)?.humanPose, dt = frame.simTime - (previous?.simTime ?? frame.simTime)
          if (old && dt > 0) { const travelled = (pose.motion?.distanceM ?? 0) - (old.motion?.distanceM ?? 0); stat.observedS += dt; stat.intervals++; if (travelled > Math.max(1e-6, .05 * dt)) stat.activeS += dt }
        }
        if (entity.entityId === 'panda' && entity.joints) for (const [i, name] of entity.joints.names.entries()) { const values = robotPositions.get(name) ?? []; values.push(entity.joints.positions[i]!); robotPositions.set(name, values); robotVelocities.set(name, Math.max(robotVelocities.get(name) ?? 0, Math.abs(entity.joints.velocities[i]!))) }
      }
      previous = frame
    })
    const started = performance.now(), pending = sim.execute(world.worldId, action)
    await sim.setPaused(world.worldId, false, world.worldGeneration)
    const receipt: ActionReceipt = await pending, activeWallS = (performance.now() - started) / 1000
    await sim.setPaused(world.worldId, true, world.worldGeneration)
    const after = await sim.observe(world.worldId, { contacts: true }), gpuAfter = await sim.describe(world.worldId, ids[0]!)
    report.action = receipt; report.humanComputeAfter = gpuAfter.controller?.humanCompute ?? null
    const simulatedS = ((receipt.endStep ?? after.stepIndex) - (receipt.startStep ?? before.stepIndex + 1) + 1) * .002
    const robot = [...robotPositions].map(([name, values]) => ({ name, samples: values.length, qposRange: Math.max(...values) - Math.min(...values), maxAbsQvel: robotVelocities.get(name) ?? 0 }))
    const measured = [...stats.values()].map(stat => ({ ...stat, activeFraction: stat.observedS ? stat.activeS / stat.observedS : 0, blockedFraction: stat.blockedS / durationS, travelFraction: stat.travelM / (stat.speedMps * durationS) }))
    const activePeople = measured.filter(stat => stat.activeFraction >= .5 && stat.travelM >= stat.speedMps * durationS * .5).length
    const gpu: any = report.humanComputeAfter
    report.measurements = { simulatedS, activeWallS, providerRTF: simulatedS / activeWallS, expectedSteps: Math.round(durationS / .002), drivenSteps: (receipt.endStep ?? 0) - (receipt.startStep ?? 1) + 1, originalWallFrameRateHz: 30, frames: count, frameBytes: bytes, firstToLastArrivalWallS: firstArrival && lastArrival ? (lastArrival - firstArrival) / 1000 : null, maxDiskBacklogBytes: maxBacklogBytes, people: measured, activePeople, robot }
    report.checks = { completed: receipt.status === 'completed', exactDrivenTicks: (receipt.endStep ?? 0) - (receipt.startStep ?? 1) + 1 === Math.round(durationS / .002), allFramesSameSource: errors.length === 0, complete81Bones14Segments: measured.every(stat => stat.bones === 81 && stat.segments === 14), defaultStopPreserved: people.every(entity => entity.components.human!.route?.avoidObstacles !== false), atLeast16Active: legacy ? null : activePeople >= 16, pandaRealJointChange: robot.some(joint => joint.qposRange > .02 && joint.maxAbsQvel > .005), pandaFullControlVector: trajectory.jointNames.length === description.controlledJointNames.length && trajectory.jointNames.every(name => description.controlledJointNames.includes(name)), cudaActuallyUsed: Boolean(gpu && gpu.backend === 'warp-cuda-float64' && gpu.dtype === 'float64' && Number(gpu.kernelCalls) > Number((report.humanComputeBefore as any)?.kernelCalls ?? 0)), rtfAtLeast09: simulatedS / activeWallS >= .9, normalClockApproximatelyOne: clock === 'manual' ? null : simulatedS / activeWallS >= .9 && simulatedS / activeWallS <= 1.05 }
    if (argv.includes('--expected-uuid')) report.checks.deviceUuid = gpu?.uuid === arg('--expected-uuid')
    report.frameAdmissionErrors = errors.slice(0, 100); report.contactsBefore = before.contacts; report.contactsAfter = after.contacts
    await json(join(out, 'after.json'), after)
    const stopped = await sim.stop(world.worldId, { actionId: action.actionId, expectedGeneration: world.worldGeneration })
    report.stopAfterCompleted = stopped
    // 活动段已经结束且世界已暂停：单列取消/停止窗口，不计入RTF/FPS。
    const cancelController = new AbortController(), cancelAction = { ...action, actionId: action.actionId + '-cancel-paused' }
    const cancelPending = sim.execute(world.worldId, cancelAction, cancelController.signal)
    const queued = await sim.receipt(world.worldId, cancelAction.actionId)
    assert.ok(['accepted', 'running'].includes(queued.status), 'CANCEL_ACTION_NOT_QUEUED')
    cancelController.abort()
    const cancelled = await cancelPending, held = await sim.observe(world.worldId)
    report.cancelAfterActivity = { receipt: cancelled, pausedStepBefore: after.stepIndex, pausedStepAfter: held.stepIndex, scope: '同World暂停中排队后经AbortSignal撤销，活动RTF之外' }
    report.checks.signalCancelled = cancelled.status === 'cancelled'
    report.checks.cancelWhilePausedNoExtraTick = after.stepIndex === held.stepIndex
    await sim.close(world.worldId); report.closed = true
    report.checks.closedWorldRemoved = !(await sim.listWorlds()).some(handle => handle.worldId === world!.worldId)
    report.checks.fullFrameDiskNoError = !streamError
    report.status = Object.values(report.checks).every(value => value === true || value === null) ? '完成' : '部分完成'
  } catch (error) { report.status = '阻断'; report.error = String(error); report.stack = error instanceof Error ? error.stack : undefined }
  finally {
    unsubscribe?.()
    try { await sim.dispose(); report.disposed = true } catch (error) { report.disposeError = String(error); report.status = '阻断' }
    framesStream.end(); indexStream.end(); await Promise.all([finished(framesStream), finished(indexStream)]).catch(error => { report.diskError = String(error); report.status = '阻断' })
    report.totalRoundWallS = (performance.now() - timing) / 1000
    await json(join(out, 'receipt.json'), report)
    console.log(JSON.stringify({ status: report.status, clock, round, checks: report.checks, measurements: report.measurements ? { providerRTF: report.measurements.providerRTF, drivenSteps: report.measurements.drivenSteps, activePeople: report.measurements.activePeople, frames: report.measurements.frames } : undefined, error: report.error, out }))
  }
  return report
}

if (argv.includes('--self-check')) {
  console.log(JSON.stringify(selfCheck()))
} else {
  const out = resolve(arg('--out')); await mkdir(out, { recursive: true })
  const identity = { testedAtSingapore: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Singapore', dateStyle: 'short', timeStyle: 'long' }).format(new Date()), repo, head: git('rev-parse', 'HEAD'), workingTree: git('status', '--short'), command: process.argv, sources: Object.fromEntries(await Promise.all(['script/gates/human-realtime-acceptance.ts', 'packages/sim-mujoco/python/worker.py', 'packages/sim-mujoco/python/human.py', 'packages/sim-mujoco/python/human_gpu.py'].map(async path => [path, sha(await readFile(join(repo, path)))]))) }
  await json(join(out, 'identity.json'), identity)
  const prepared = await prepare(out)
  if (argv.includes('--prepare-only')) console.log(JSON.stringify({ status: '完成', scope: '只准备场景；物理/GPU/产品FPS未运行', out, scene: prepared.prepared.scenePath }))
  else {
    assert.ok(!argv.includes('--legacy') || !argv.includes('--clock') || arg('--clock') === 'manual', '原6秒基准只测manual')
    const requested = argv.includes('--legacy') ? 'manual' : arg('--clock', 'both')
    assert.ok(['manual', 'realtime', 'both'].includes(requested))
    const rounds = numberArg('--rounds', 3); assert.ok(Number.isInteger(rounds))
    const clocks: Array<'manual' | 'realtime'> = requested === 'both' ? ['manual', 'realtime'] : [requested as 'manual' | 'realtime']
    const reports = []
    for (const clock of clocks) for (let round = 1; round <= rounds; round++) reports.push(await runRound(prepared.scene, join(out, clock + '-' + round), clock, round))
    const report = { status: reports.every(result => result.status === '完成') ? '完成' : '部分完成', scope: '公开Provider物理/计算门；所有轮保留，不能宣布完整产品验收', identity, prepared: prepared.prepared, results: reports.map(result => ({ status: result.status, clock: result.clock, round: result.round, checks: result.checks, measurements: result.measurements })), viewer: { status: '未验证', reason: '须Root在完整产品RTX工作台独立采活动fps/帧到达应用/末屏；此入口不创建替代Viewer' } }
    await json(join(out, 'summary.json'), report)
    if (report.status !== '完成') process.exitCode = 1
  }
}
