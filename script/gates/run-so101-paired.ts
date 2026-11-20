/** Run with Node 24. Uses the source robot, native tools, MuJoCo, and session recordings. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Commands from '@deepseek-ai/dsh-commands'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Quaternion as ThreeQuaternion, Vector3 } from 'three'
import type { CaptureOptions, SimAction, WorldEvaluation } from '../../packages/sim-contract/src/index.ts'
import type { Frame, Quaternion, Vec3, WorldHandle, Entity } from '../../packages/lyapunov-contracts/src/types.ts'
import { identityTransform } from '../../packages/lyapunov-contracts/src/types.ts'
import type { CampaignTask, PredicateExpr, TaskCheckResult } from '../../packages/lyapunov-contracts/src/agent-graph.ts'
import { SessionSimFactory } from '../../packages/sim-contract/src/session-provider.ts'
import { MuJoCoProvider } from '../../packages/sim-mujoco/src/provider.ts'
import * as scenePlugin from '../../packages/scene-kit/src/plugin.ts'
import * as robotPlugin from '../../packages/robot-tools/src/plugin.ts'
import * as workflows from '../../packages/robot-workflows/src/plugin.ts'
import * as planner from '../../packages/motion-mink/src/plugin.ts'
import * as graph from '../../packages/agent-graph/src/plugin.ts'
import * as check from '../../packages/sim-task-check/src/plugin.ts'
import type { PickResult, PlaceResult } from '../../packages/robot-workflows/src/pick-place.ts'

async function finishRecording(recordingId: string) {
  // 原生停止调用的等待有时间窗。相机写盘较慢时继续等同一 Job 的终态。
  for (let wait = 0; wait < 12; wait++) {
    const recording = await tool<{ status: string; frameCount: number; cameraCapture?: { captures: number } }>('recording_stop', { recordingId })
    if (recording.status !== 'recording') return recording
  }
  throw new Error('原生录制在 12 个等候窗口后仍未写完')
}

const { values } = parseArgs({ options: { model: { type: 'string' }, python: { type: 'string' }, out: { type: 'string' },
  comparison: { type: 'string', default: 'wrist' }, gauntlet: { type: 'string' }, 'known-stress-seeds': { type: 'string', default: '' }, seeds: { type: 'string', default: '1301,1723,2243,3001' }, tiers: { type: 'string', default: 'nominal,shift,stress' } } })
assert(values.model && values.python && values.out, '用法：node --experimental-transform-types script/gates/run-so101-paired.ts --model <SO-101 so101.xml> --python <MuJoCo+Mink Python> --out <新目录>')
const out = resolve(values.out), model = resolve(values.model), python = resolve(values.python)
const seeds = values.seeds.split(',').map(Number), tiers = values.tiers.split(',')
assert(['wrist', 'descent', 'reacquire', 'integrated'].includes(values.comparison), '--comparison 必须为 wrist、descent、reacquire 或 integrated')
interface GauntletCase { id: string; tier: string; seed: number; profile: Record<string, unknown> }
const gauntletCases = values.gauntlet ? JSON.parse(await readFile(resolve(values.gauntlet), 'utf8')) as GauntletCase[] : undefined
if (gauntletCases) {
  assert(Array.isArray(gauntletCases) && gauntletCases.length > 0)
  assert(gauntletCases.every(c => /^T[0-4]-[0-9]+$/.test(c.id) && c.id.startsWith(c.tier + '-') &&
    Number.isSafeInteger(c.seed) && c.profile && typeof c.profile === 'object'))
  assert.equal(new Set(gauntletCases.map(c => c.id)).size, gauntletCases.length)
}
const integrated = values.comparison === 'integrated' || Boolean(gauntletCases)
const knownStress = new Set(values['known-stress-seeds'].split(',').filter(Boolean).map(Number))
assert(!knownStress.size || (integrated && [...knownStress].every(Number.isSafeInteger)))
const compareDescent = values.comparison === 'descent'
const compareReacquire = values.comparison === 'reacquire'
assert(seeds.every(Number.isSafeInteger) && new Set(seeds).size === seeds.length)
assert(tiers.every(tier => ['nominal', 'shift', 'stress'].includes(tier)) && new Set(tiers).size === tiers.length)
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const writeJson = (path: string, data: unknown) => writeFile(path, JSON.stringify(data, null, 2) + '\n')
const sourceXml = await readFile(model)
assert(sourceXml.includes('model="so101"'), '需要带原始碰撞与腕相机的 SO-101 MJCF')
const sourceSha256 = digest(sourceXml)
const sourceMeshes = [...new Set([...sourceXml.toString().matchAll(/<mesh [^>]*file="([^"]+)"/g)].map(match => match[1]!))].sort()
const sourceMeshDigests = await Promise.all(sourceMeshes.map(async file => [file, digest(await readFile(resolve(model, '../assets', file)))]))
const sourceBundleSha256 = digest(JSON.stringify({ sourceSha256, sourceMeshDigests }))
await mkdir(out)
await mkdir(join(out, 'fixtures'))
await mkdir(join(out, 'episodes'))

const source: [number, number] = [.228, -.040]
const bin: [number, number] = [.220, .066]
const half = .0105, floorM = .004
const armJointNames = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll']
// Source collision-sphere gap sampled with mj_forward on the unmodified SO-101 MJCF.
const widthCalibration = [[-.17453,.00263],[-.1,.00716],[0,.01481],[.1,.02268],[.2,.03056],[.35,.04228],[.5,.05377],[.7,.06862],[.9,.08278],[1.2,.10241],[1.74532,.13186]]
const armComponents: Entity['components'] = {
  mujoco: { rootBody: 'base', initialJointPositions: { shoulder_lift: -.1, elbow_flex: .55, wrist_flex: 1.12, gripper: .65 } },
  controller: { type: 'arm', tcp: { body: 'gripper', site: 'gripperframe' },
    gripper: { actuator: 'gripper', jointNames: ['gripper'], maxWidthM: .13186, widthCalibration } },
}
const fixed = (entityId: string, position: Vec3, components: Entity['components']): Entity => ({
  entityId, name: entityId, transform: { ...identityTransform(), position }, resources: [], components,
})
const box = (entityId: string, position: Vec3, halfExtents: Vec3) => fixed(entityId, position, { rigidBody: { type: 'static' }, collision: { shape: 'box', halfExtents } })
function cubeXml(color: string, mass: number, friction: number) {
  return `<mujoco model="sort_cube"><worldbody><body name="cube"><freejoint/><geom name="solid" type="box" size="${half} ${half} ${half}" mass="${mass}" friction="${friction} .02 .003" rgba="${color}"/></body></worldbody></mujoco>`
}
function tcpPose(x: number, y: number, z: number) {
  const yaw = Math.atan2(y, x - .039)
  const q = new ThreeQuaternion().setFromAxisAngle(new Vector3(0, 0, 1), yaw)
    .multiply(new ThreeQuaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2))
    .multiply(new ThreeQuaternion().setFromAxisAngle(new Vector3(1, 0, 0), .0487))
  return { position: [x + .008 * Math.cos(yaw), y + .008 * Math.sin(yaw), z + .0035] as Vec3, quaternion: q.toArray() as Quaternion }
}
const planning = { modelPath: model, tcp: { body: 'gripper', site: 'gripperframe' }, jointNames: armJointNames, durationS: .55,
  positionToleranceM: .0025, orientationToleranceRad: .16, maxIterations: 130 }
const goal: PredicateExpr = { and: [
  { kind: 'entity-in-box', entityId: 'target', center: [bin[0], bin[1], floorM + half], halfExtents: [.026, .029, .007] },
  { kind: 'contact-exists', entityA: 'target', entityB: 'bin-floor' },
  { kind: 'settled', entityId: 'target', maxLinearSpeedMps: .025, maxAngularSpeedRps: .6 },
  { not: { kind: 'contact-exists', entityA: 'target', entityB: 'arm' } },
  { not: { kind: 'entity-in-box', entityId: 'distractor', center: [bin[0], bin[1], floorM + half], halfExtents: [.04, .04, .02] } },
] }
const ctx = new Context()
await ctx.plugin(Timer)
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(Commands)
await ctx.plugin(Jobs)
await ctx.plugin(Subprocess)
ctx.jobs.attachController('so101-paired')
const frozenCamera = new Map<string, { sample: Record<string, unknown>; triggeredStep?: number }>()
class AssessmentProvider extends MuJoCoProvider {
  override async capture(worldId: string, options: CaptureOptions) {
    const frozen = frozenCamera.get(worldId)
    if (frozen && options.cameraName === 'arm/wrist_cam') {
      frozen.triggeredStep ??= (await this.observe(worldId)).stepIndex
      return structuredClone(frozen.sample)
    }
    return super.capture(worldId, options)
  }
}
const factory = new SessionSimFactory({ create: () => new AssessmentProvider({ pythonPath: python, renderBackend: 'egl', labFaults: integrated }) })
ctx.reflect.provide('sim', factory)
await ctx.plugin(scenePlugin, { dataRoot: join(out, 'scene-runtime') })
await ctx.plugin(robotPlugin)
await ctx.plugin(workflows, { recordingRoot: join(out, 'recordings') })
await ctx.plugin(planner, { python })
await ctx.plugin(graph)
await ctx.plugin(check)
const harness = await mountAgentLoopTestHarness(ctx)
const agent = await harness.create(SessionId('so101-paired'), {}, { cwd: out })
const sim = factory.forSession(agent.id)
const ops = ctx.scene.forSession(agent.id)
let counter = 0
async function tool<T>(name: string, input: unknown): Promise<T> {
  const result = await ctx.tools.execute({ name, arguments: { input }, agent, callId: ToolCallId(`so101-${++counter}`), signal: AbortSignal.timeout(90_000) })
  if (result.isError) throw new Error(`${name}: ${result.error.message}`)
  return result.value as T
}
const variants = ['baseline', 'candidate'] as const
const campaignId = gauntletCases ? 'so101-physical-gauntlet' : integrated ? 'so101-native-evaluation' : compareReacquire ? 'so101-wrist-reacquisition' : compareDescent ? 'so101-segmented-descent' : 'so101-tabletop-sort'
const scenarios = []
const limits = { graspForceN: 60, otherForceN: 100, jointSpeedRps: 10 }
const assessment = <T>(world: WorldHandle, request: Omit<WorldEvaluation, 'expectedGeneration'> & Record<string, unknown>) =>
  tool<T>('sim_evaluation', { worldId: world.worldId, request: { ...request, expectedGeneration: world.worldGeneration } })
const checkpointReplay: Array<Record<string, unknown>> = []
let replayAttempted = false
const verificationErrors: string[] = []
const safeOpenPose = tcpPose(source[0], source[1], half + .073)
const carryObstacleIds = ['bin-floor','bin-wall-left','bin-wall-right','bin-wall-front','bin-wall-back']

const tasks: Array<Pick<CampaignTask, 'taskId' | 'sceneId' | 'partition' | 'goal' | 'pair'>> = []
try {
  await ops.resources.import({ path: model, resourceId: 'so101-source', category: 'robot', storage: 'reference', physicalizationRequest: false })
  const plannedCases = gauntletCases ?? tiers.flatMap(tier => [...new Set([...seeds, ...knownStress])]
    .filter(seed => !knownStress.has(seed) || tier === 'stress').map(seed => ({ id: `${tier}-${seed}`, tier, seed, profile: undefined })))
  for (const { id, tier, seed, profile } of plannedCases) {
    const scale = (key: string, nominal = 1) => Number(profile?.[key] ?? nominal)
    const xy = (key: string) => (profile?.[key] as [number, number] | undefined) ?? [0, 0]
    const yaw = scale('target_yaw_deg', 0) * Math.PI / 180
    const tilt = scale('table_tilt_deg', 0) * Math.PI / 180
    const tableRotation = new ThreeQuaternion().setFromAxisAngle(new Vector3(1, 0, 0), tilt)
    const tableOffset = scale('table_dz_m', 0)
    const tablePose = (position: Vec3) => !profile ? position : new Vector3(...position).applyQuaternion(tableRotation).add(new Vector3(0, 0, tableOffset)).toArray() as Vec3
    const perturbedBin = [bin[0] + xy('dest_xy_m')[0], bin[1] + xy('dest_xy_m')[1]] as const
    const sceneId = `so101-${id}`
    const random = createHash('sha256').update(`so101-sort-v1/${seed}/${tier}`).digest()
    const draw = (i: number) => random.readUInt16BE(2 * i) / 65535
    const sign = (i: number) => draw(i) < .5 ? -1 : 1
    const strength = tier === 'nominal' ? 0 : tier === 'shift' ? 1 : 1.6
    const dx = profile ? xy('target_xy_m')[0] : sign(0) * (.006 + .006 * draw(1)) * strength
    const dy = profile ? xy('target_xy_m')[1] : sign(2) * (.009 + .011 * draw(3)) * strength
    const mass = profile ? .022 * scale('mass_scale') : .022 + .018 * draw(4) * strength
    const friction = profile ? scale('friction_scale') : 1 - .3 * draw(5) * strength
    const targetPosition = tablePose([source[0] + dx, source[1] + dy, half + .0001])
    const distractorPosition = tablePose([.287, -.083 + (profile ? 0 : .006 * strength * sign(6)), half + .0001])
    const cubePath = join(out, 'fixtures', `${id}.xml`), distractorPath = join(out, 'fixtures', `${id}-blue.xml`)
    await writeFile(cubePath, cubeXml('1 .025 .025 1', mass, friction))
    await writeFile(distractorPath, cubeXml('.02 .25 .9 1', .025, .9))
    await ops.create({ sceneId })
    const { snapshot: before } = await ops.mount({ sceneId, entityId: 'arm', resourceId: 'so101-source', alignBottomToSurface: false, transform: identityTransform(), components: armComponents })
    const cube = async (entityId: string, path: string, position: Vec3) => fixed(entityId, position, {
      mujoco: { xml: await readFile(path, 'utf8'), rootBody: 'cube' }, rigidBody: { type: 'dynamic' },
    })
    const walls = [.037, .040] as const
    const fixtures = [await cube('target', cubePath, targetPosition), await cube('distractor', distractorPath, distractorPosition), box('table', [.24,0,-.014], [.29,.24,.014]), box('bin-floor', [perturbedBin[0],perturbedBin[1],floorM/2], [.04,.043,floorM/2]),
      box('bin-wall-left', [perturbedBin[0]-walls[0],perturbedBin[1],.014], [.003,.043,.014]), box('bin-wall-right', [perturbedBin[0]+walls[0],perturbedBin[1],.014], [.003,.043,.014]),
      box('bin-wall-front', [perturbedBin[0],perturbedBin[1]-walls[1],.014], [.037,.003,.014]), box('bin-wall-back', [perturbedBin[0],perturbedBin[1]+walls[1],.014], [.037,.003,.014]),
      fixed('overview', [.195,.0,.64], { camera: { name: 'overhead', fovYDeg: 43 } })]
    if (profile) {
      for (const entity of fixtures.filter(e => e.entityId === 'table' || e.entityId.startsWith('bin-'))) {
        entity.transform.position = tablePose(entity.transform.position)
        entity.transform.quaternion = tableRotation.toArray()
      }
      const yawRotation = new ThreeQuaternion().setFromAxisAngle(new Vector3(0, 0, 1), yaw)
      fixtures[0]!.transform.quaternion = tableRotation.clone().multiply(yawRotation).toArray()
      fixtures[1]!.transform.quaternion = tableRotation.toArray()
    }
    const caseGoal: PredicateExpr = { and: goal.and.map(predicate => 'kind' in predicate && predicate.kind === 'entity-in-box'
      ? { ...predicate, center: tablePose([perturbedBin[0], perturbedBin[1], floorM + half]) }
      : 'not' in predicate && 'kind' in predicate.not && predicate.not.kind === 'entity-in-box'
      ? { not: { ...predicate.not, center: tablePose([perturbedBin[0], perturbedBin[1], floorM + half]) } }
      : predicate) }
    const snapshot = await ops.scene.commit({ sceneId, expectedRevision: before.revision, patch: fixtures.map(entity => ({ op: 'add', entity })) })
    const condition = { id, tier, seed, sourceSha256, sourceBundleSha256, sceneRevision: snapshot.revision, nominalPickZM: tablePose([source[0], source[1], half])[2], nominalTopZM: tablePose([source[0], source[1], 2 * half])[2], targetPosition, distractorPosition, mass, friction, dx, dy, ...(profile ? { profile } : {}),
      sceneSha256: digest(JSON.stringify({ sourceBundleSha256, fixtures, armComponents, ...(profile ? { profile } : {}), targetPosition, distractorPosition, targetXmlSha256: digest(await readFile(cubePath)),
        distractorXmlSha256: digest(await readFile(distractorPath)), timestepS: .002 })) }
    scenarios.push({ sceneId, condition, caseGoal, profile })
    for (const variant of variants) tasks.push({ taskId: `${id}-${variant}`, sceneId, partition: 'heldout', goal: caseGoal, pair: { id, tier, seed, sceneSha256: condition.sceneSha256, variant, requirePreflight: true, ...(integrated ? { requireSafety: true } : {}) } })
  }
  if (!gauntletCases && (compareDescent || compareReacquire || integrated)) {
    const template = await ops.scene.snapshot(scenarios[0]!.sceneId)
    const trayZ = floorM + half + .002
    const controls: Array<{ id: string; expected: boolean; target?: Vec3; distractor?: Vec3; settle: boolean }> = [
      { id: 'correct-target', expected: true, target: [bin[0], bin[1], trayZ], settle: true },
      { id: 'hover-target', expected: false, target: [bin[0], bin[1], trayZ + .07], settle: false },
      { id: 'outside-target', expected: false, target: [bin[0], bin[1] + .075, half + .002], settle: true },
      { id: 'wrong-object', expected: false, distractor: [bin[0], bin[1], trayZ], settle: true },
    ]
    const results = []
    for (const fixture of controls) {
      const sceneId = `so101-control-${fixture.id}`
      const scene = await ops.create({ sceneId })
      const entities = structuredClone(template.entities)
      for (const [id, position] of [['target', fixture.target], ['distractor', fixture.distractor]] as const) {
        if (position) entities.find(entity => entity.entityId === id)!.transform.position = position
      }
      await ops.scene.commit({ sceneId, expectedRevision: scene.revision, patch: entities.map(entity => ({ op: 'add', entity })) })
      const world = await tool<WorldHandle>('sim_open', { sceneId, options: { worldId: sceneId, timestepS: .002, realtimeFactor: 4, startPaused: !fixture.settle, ground: false } })
      const { worldId, worldGeneration: expectedGeneration } = world
      try {
        if (fixture.settle) {
          const deadline = Date.now() + 5000
          while ((await sim.observe(worldId)).stepIndex < 200) {
            assert(Date.now() < deadline, `预检世界未推进 ${sceneId}`)
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          await tool('sim_set_paused', { worldId, expectedGeneration, paused: true })
        }
        const observed = await tool<TaskCheckResult>('sim_task_check', { worldId, expectedGeneration, predicates: goal, checkSpec: false })
        results.push({ ...fixture, observed })
        await writeJson(join(out, 'goal-controls.json'), results)
        assert(observed.evaluated && observed.taskAchieved === fixture.expected, `目标判据预检失败 ${sceneId}`)
      } finally { await tool('sim_close', { worldId }) }
    }
  }
  await writeJson(join(out, 'conditions.json'), scenarios)
  await tool('campaign_init', { campaignId, tasks, budget: { maxToolCalls: 20000, maxSimSteps: 5000000, maxWallSeconds: 7200 } })
  for (const [index, { sceneId, condition, caseGoal, profile }] of scenarios.entries()) {
    let initialHash: string | undefined
    // Counterbalance which method goes first, opening a fresh paused world each time.
    for (const variant of index % 2 ? [...variants].reverse() : variants) {
      const taskId = `${condition.id}-${variant}`, dir = join(out, 'episodes', taskId)
      await mkdir(dir)
      const { runId } = await tool<{ runId: string }>('campaign_transition', { campaignId, taskId, to: 'heldout-eval', role: 'coordinator' })
      const failures: string[] = []
      let hasMedia = false
      const evidence: Record<string, unknown> = { taskId, runId, condition, variant, comparison: values.comparison, failures }
      let world: WorldHandle | undefined, recordingId: string | undefined, verdict: TaskCheckResult | undefined
      try {
        world = await tool<WorldHandle>('sim_open', { sceneId, options: { worldId: taskId, timestepS: .002, realtimeFactor: 4, frameRateHz: 20, startPaused: true, ground: false } })
        const worldId = world.worldId, expectedGeneration = world.worldGeneration
        if (profile) {
          evidence.gauntletStart = await assessment(world, { kind: 'gauntlet-configure', robotId: 'arm', targetId: 'target',
            cameraName: 'arm/wrist_cam', actionPrefix: 'sort', seed: condition.seed, profile })
          if (profile.frame_delay === 1 || profile.fault === 'camera_freeze') {
            evidence.cameraPrime = await tool('sensor_capture', { worldId, cameraName: 'arm/wrist_cam',
              outputDir: join(dir, 'wrist'), width: 256, height: 192, geomGroups: [0, 1, 2, 5] })
          }
        }
        const initial = await tool<Frame>('robot_state', { worldId, contacts: true })
        evidence.initial = initial
        assert.equal(initial.stepIndex, 0, '未从同一物理步开始')
        const stateHash = digest(JSON.stringify(initial.entities.map(({ entityId, transform, joints }) => ({ entityId, transform, joints }))))
        evidence.initialStateSha256 = stateHash
        initialHash ??= stateHash
        assert.equal(stateHash, initialHash, '同对两次编译的原生初始状态不同')
        const started = await tool<{ recordingId: string }>('recording_start', { sceneId, worldId, expectedGeneration,
          maxDurationS: 90, cameraNames: ['overview/overhead'], width: 320, height: 240, cameraEveryNFrames: 3 })
        recordingId = started.recordingId
        const initialVerdict = await tool<TaskCheckResult>('sim_task_check', { worldId, expectedGeneration, predicates: caseGoal })
        evidence.preflight = initialVerdict
        assert(initialVerdict.evaluated && !initialVerdict.rejectedBy && !initialVerdict.taskAchieved && initialVerdict.stepIndex === 0 && initialVerdict.frameId === initial.frameId, '目标定义需通过第 0 步初态反例')
        if (integrated) await assessment(world, { kind: 'monitor-start', robotId: 'arm', targetId: 'target', limits })
        if (!integrated || (!profile && variant !== 'candidate')) await tool('sim_set_paused', { worldId, expectedGeneration, paused: false })
        const cameraName = 'arm/wrist_cam'
        const picked = await tool<PickResult>('robot_pick', { worldId, robotId: 'arm', objectId: 'target',
          candidate: { candidateId: 'nominal-calibrated-table', tcpPose: tcpPose(source[0], source[1], condition.nominalPickZM), approach: [0,0,-1] },
          planning, ...(profile ? { actionPrefix: 'sort', gauntletProprio: true } : {}), approachDistanceM: .043, liftHeightM: .046, minimumLiftM: .027, openWidthM: .06, closeWidthM: .00263, holdTimeS: .20,
          ...(variant === 'candidate' || compareDescent || compareReacquire || integrated ? { wristRefinement: { cameraName, estimateXY: source, targetChannel: 'red', targetPlaneZM: condition.nominalTopZM, yawPivotXY: [.039, 0],
            maxCorrectionM: profile ? .08 : .045, outputDir: join(dir, 'wrist'), ...(profile && variant === 'candidate' ? { feedbackPasses: 4 } : {}), ...(compareReacquire && variant === 'candidate' ? { reacquireBackoffM: .03 } : {}) } } : {}),
          ...((compareDescent && variant === 'candidate') || compareReacquire || integrated ? { descentSegments: 4 } : {}),
          ...(profile ? { safeOpenPose, minimumCloseTravelM: .003 } : integrated && variant === 'candidate' ? { safeOpenPose, recordPhaseCheckpoints: true } : {}) })
        evidence.pick = picked
        if (!picked.taskAchieved) failures.push(`抓取 ${picked.reason ?? picked.status}`)
        if (picked.taskAchieved) {
          const placed = await tool<PlaceResult>('robot_place', { worldId, robotId: 'arm', objectId: 'target',
            targetPose: tcpPose(bin[0], bin[1], floorM + half + .002), planning, ...(profile ? { gauntletProprio: true } : {}), openWidthM: .06, expectedSupportZ: floorM + half,
            supportToleranceM: .009, stableSpeedMps: .025, holdTimeS: .32, retreatM: .043, transferClearanceM: .045, ...(integrated ? { carryObstacleIds } : {}) })
          evidence.place = placed
          if (!placed.taskAchieved) failures.push(`放置 ${placed.reason ?? placed.status}`)
        }
      } catch (error) { failures.push(String(error)) }
      finally {
        if (world) {
          try {
            if (!recordingId) throw new Error('原生录制未启动')
            const { worldId, worldGeneration: expectedGeneration } = world
            verdict = await tool<TaskCheckResult>('sim_task_check', { worldId, expectedGeneration, predicates: caseGoal, checkSpec: false })
            evidence.verdict = verdict
            for (const failure of verdict.failed) failures.push(`${failure.reasonCode} ${failure.measured}`)
            evidence.final = (await sim.observe(worldId, { contacts: true, sensors: true })) satisfies Frame
            if (integrated) evidence.safety = await assessment(world, { kind: 'monitor-stop' })
            if (profile) {
              evidence.gauntletEnd = await assessment(world, { kind: 'gauntlet-status' })
            }
          } catch (error) { failures.push(`终态判定 ${error}`) }
          if (recordingId) {
            try {
              const recording = await finishRecording(recordingId)
              evidence.recording = recording
              assert(recording.status === 'completed' && recording.frameCount > 0 && (recording.cameraCapture?.captures ?? 0) > 0, '原生录制缺少可回放帧或实拍 RGB')
              hasMedia = true
            }
            catch (error) { failures.push(`录制 ${error}`) }
          }
          if (!profile && integrated && !replayAttempted && variant === 'candidate' && verdict?.taskAchieved) {
            replayAttempted = true
            try {
              const picked = evidence.pick as PickResult
              const checkpoints = picked.effect.phaseCheckpoints as Record<string, { checkpointId: string; stepIndex: number; stateSha256: string }>
              const phases = { beforeOpen: 'open', beforeDescend: 'descend', beforeClose: 'close', beforeLift: 'lift' }
              for (const [phase, suffix] of Object.entries(phases)) {
                const cp = checkpoints[phase]!
                const chosen = picked.actions.find(action => action.actionId.endsWith('-' + suffix))!
                const request: { action: SimAction; startStep: number; endStep: number } = await assessment(world, { kind: 'command', actionId: chosen.actionId })
                const replicas: Array<{ replay: unknown; final: { stateSha256: string } }> = []
                for (const copy of [1, 2]) {
                  const forkWorldId = `fork-${phase}-${copy}`
                  const fork: { world: WorldHandle; stepIndex: number; stateSha256: string } = await assessment(world, { kind: 'fork', checkpointId: cp.checkpointId, forkWorldId })
                  assert.equal(fork.stateSha256, cp.stateSha256)
                  assert.equal(fork.stepIndex, cp.stepIndex)
                  try {
                    await tool('sim_set_paused', { worldId: forkWorldId, expectedGeneration: fork.world.worldGeneration, paused: false })
                    const replay = await sim.execute(forkWorldId, { ...request.action, startStep: request.startStep, expectedGeneration: fork.world.worldGeneration })
                    assert.equal(replay.status, 'completed')
                    assert.equal(replay.endStep, request.endStep)
                    replicas.push({ replay, final: await assessment(fork.world, { kind: 'checkpoint' }) })
                  } finally { await tool('sim_close', { worldId: forkWorldId }) }
                }
                const finals: string[] = replicas.map(r => r.final.stateSha256)
                assert.equal(finals[0], finals[1], `不一致的原生回放 ${phase}`)
                checkpointReplay.push({ taskId, phase, checkpoint: cp, command: request, replicas })
                await writeJson(join(out, 'checkpoint-replay.json'), checkpointReplay)
              }
            } catch (error) { verificationErrors.push(`原生分叉 ${error}`) }
          }
          await tool('sim_close', { worldId: world.worldId }).catch(error => failures.push(`关闭世界 ${error}`))
        }
        evidence.run = await tool('campaign_record_run', { campaignId, taskId, role: 'coordinator', summary: { outcome: verdict?.taskAchieved ? 'success' : 'failed', notes: failures.join(' · ') } })
        const decision = hasMedia && (evidence.run as { pairResult?: unknown }).pairResult
        await tool('campaign_transition', { campaignId, taskId, to: decision ? 'done' : 'blocked', ...(decision ? {} : { blockedReason: failures.join(' · ') || '判定或录制缺失' }) })
        await writeJson(join(dir, 'episode.json'), evidence)
        console.log(JSON.stringify({ taskId, runId, recordingId, verdict: verdict?.taskAchieved, evidenceRecorded: !!decision, failures }))
      }
    }
  }
  if (integrated && !gauntletCases) {
    if (checkpointReplay.length !== 4) verificationErrors.push('缺少完整的原生四阶段分叉')
    const fixture = scenarios.find(x => x.condition.tier === 'nominal')!
    const faultResults = []
    for (const kind of ['camera-freeze', 'gripper-stall', 'arm-contact-limit'] as const) {
      const worldId = `lab-${kind}`
      const world = await tool<WorldHandle>('sim_open', { sceneId: fixture.sceneId, options: { worldId, timestepS: .002, realtimeFactor: 4, ground: false, startPaused: true } })
      const expectedGeneration = world.worldGeneration
      const cameraName = 'arm/wrist_cam'
      let recordingId: string | undefined
      try {
        const started = await tool<{ recordingId: string }>('recording_start', { sceneId: fixture.sceneId, worldId, expectedGeneration,
          maxDurationS: 90, cameraNames: ['overview/overhead'], width: 320, height: 240, cameraEveryNFrames: 3 })
        recordingId = started.recordingId
        if (kind === 'camera-freeze') {
          const sample = await tool<Record<string, unknown>>('sensor_capture', { worldId, cameraName, outputDir: join(out, 'faults', kind), width: 256, height: 192 })
          frozenCamera.set(worldId, { sample })
        } else if (kind === 'gripper-stall') {
          await assessment(world, { kind, actionId: `${kind}-close` })
        }
        await assessment(world, { kind: 'monitor-start', robotId: 'arm', targetId: 'target', limits: kind === 'arm-contact-limit' ? { ...limits, graspForceN: .001 } : limits })
        const pick = await tool<PickResult>('robot_pick', { worldId, robotId: 'arm', objectId: 'target', actionPrefix: kind,
          candidate: { candidateId: 'fault-calibrated-table', tcpPose: tcpPose(source[0], source[1], half), approach: [0,0,-1] },
          planning, approachDistanceM: .043, liftHeightM: .046, minimumLiftM: .027, openWidthM: .06, closeWidthM: .00263, holdTimeS: .20,
          safeOpenPose, minimumCloseTravelM: .003, descentSegments: 4,
          wristRefinement: { cameraName, estimateXY: source, targetChannel: 'red', targetPlaneZM: 2*half, yawPivotXY: [.039,0],
            maxCorrectionM: .045, outputDir: join(out, 'faults', kind) } })
        const safety = await assessment<{ passed: boolean; violations: string[] }>(world, { kind: 'monitor-stop' })
        const fault = kind === 'camera-freeze' ? frozenCamera.get(worldId) : await assessment<Record<string, unknown> | null>(world, { kind: 'fault-status' })
        const triggeredStep = fault?.triggeredStep
        const stopped = pick.stop?.confirmed === true && pick.actions.every(action => !action.actionId.endsWith('-lift'))
        const detected = kind === 'camera-freeze' ? /WRIST_STALE_FRAME/.test(pick.reason ?? '') : /GRIPPER_STALL/.test(pick.reason ?? '')
        const recording = await finishRecording(recordingId)
        recordingId = undefined
        faultResults.push({ kind, triggeredStep: triggeredStep ?? null, pick, safety, recording, correctStop: Boolean(triggeredStep && detected && stopped) })
        await writeJson(join(out, 'fault-results.json'), faultResults)
        if (kind === 'arm-contact-limit') assert(pick.taskAchieved && !safety.passed && safety.violations.includes('graspForceN'), '同一实测需要独立报告任务达成与力限违规')
        else assert(triggeredStep && detected && stopped && !pick.taskAchieved, `故障识别或停止失败 ${kind}`)
      } catch (error) { verificationErrors.push(`故障与安全评分 ${kind}: ${error}`) } finally {
        frozenCamera.delete(worldId)
        if (recordingId) await tool('recording_stop', { recordingId }).catch(error => verificationErrors.push(String(error)))
        await tool('sim_close', { worldId })
      }
    }
  }
  const report = await tool<{ comparison?: { complete: number; incomplete: number }; campaign: { status: string } }>('campaign_status', { campaignId })
  await writeJson(join(out, 'comparison.json'), report)
  assert.equal(report.comparison?.complete, scenarios.length, '配对结果不完整，原始结果仍保留')
  assert.equal(report.campaign.status, 'completed')
  assert.deepEqual(verificationErrors, [], '集成验收的证据未完整通过')
} finally {
  await factory.dispose()
  await ctx.fiber.dispose()
}
