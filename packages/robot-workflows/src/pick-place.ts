import type { ActionReceipt, Frame, GraspCandidate, MotionPlan, Vec3 } from '../../lyapunov-contracts/src/types.ts'
import type { ObservationSelection, SimAction, SimWorlds } from '../../sim-contract/src/index.ts'
import { ToolArgsError, validateArgs, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { ActionReceiptError, assertIdentity, confirmStop, executionModeOf, identityOf, settledObservation, type ExecutionMode, type ObservationFreshness, type RequestIdentity, type StopOutcome } from './workflow-evidence.ts'
import { randomUUID } from 'node:crypto'
export interface PlanRequest { worldId: string; entityId: string; start: Frame; targetPose: GraspCandidate['tcpPose']; signal?: AbortSignal }
export type Planner = (request: PlanRequest) => Promise<MotionPlan>
export interface PickInput { worldId: string; robotId: string; objectId: string; candidate: GraspCandidate; approachDistanceM: number; liftHeightM: number; minimumLiftM: number; holdTimeS: number; openWidthM: number; closeWidthM: number; actionPrefix?: string }
export interface PickResult { status: 'completed' | 'failed' | 'cancelled'; taskAchieved: boolean; executionMode: ExecutionMode; reason?: string; candidate: GraspCandidate; actions: ActionReceipt[]; before: Frame; after: Frame; afterSource?: ObservationFreshness; observationError?: string; stop?: StopOutcome; effect: Record<string, unknown> }
export interface PlaceInput { worldId: string; robotId: string; objectId: string; targetPose: GraspCandidate['tcpPose']; openWidthM: number; expectedSupportZ: number; supportToleranceM: number; stableSpeedMps: number; holdTimeS: number; retreatM: number; actionPrefix?: string }
export interface PlaceResult { status: 'completed' | 'failed' | 'cancelled'; taskAchieved: boolean; executionMode: ExecutionMode; reason?: string; actions: ActionReceipt[]; before: Frame; after: Frame; afterSource?: ObservationFreshness; observationError?: string; stop?: StopOutcome; effect: Record<string, unknown> }
// ---- 模型可见入参与分层守卫：字段按上面两个接口与 `plugin.ts` 的 planner 真实解引用面写全 ----
const num = { type: 'number' } as const
const vec3 = { type: 'array', items: num, description: "Three components [x,y,z] in meters." } as const
const vec4 = { type: 'array', items: num, description: "Quaternion [x,y,z,w]." } as const
const required = <const T extends object>(value: T) => ({ ...value, required: true as const })
const tcpPose = required({ type: 'object', additionalProperties: false, description: "TCP world pose: meters, Z-up, xyzw quaternion.", properties: { position: required(vec3), quaternion: required(vec4) } })
/**
 * `candidate` 用 `additionalProperties:true`：它是 grasp_propose 回执里的对象**原样传回**，
 * 工作流只读 tcpPose/approach（`pick()` 的 `input.candidate.tcpPose` / `input.candidate.approach`），
 * 其余字段原样透传、不改写也不校验——schema 不谎称读过它们。
 */
const candidate = required({ type: 'object', additionalProperties: true, description: "Pass the grasp_propose candidate unchanged, including candidateId/provider/widthM/score and other fields. The workflow reads only tcpPose and approach.", properties: {
  tcpPose,
  approach: required({ ...vec3, description: "Unit approach-direction vector. Back off along it by approachDistanceM, then descend to the TCP." }),
} })
/**
 * `planning` 是工作流自己消费的运动规划配置：`planning.modelPath` 与 `planning.tcp.body` 是
 * motion-mink `solve.py:12-14` 的硬必需字段（`request['modelPath']`、`request['tcp']['body']`），
 * 其余字段（durationS/maxIterations/容差/seeds/fixedJoints…）原样透传给 motion_plan，
 * 不在这里逐个声明；entityId/modelVersion/collisionContextVersion/expectedGeneration/jointNames/
 * startPositions/targetPose 由 `plugin.ts` 的 planner 按当前世界与机器人读数自己补齐，不必给。
 */
const planning = required({ type: 'object', additionalProperties: true, description: "Motion-planning configuration, passed unchanged to motion_plan.", properties: {
  modelPath: required({ type: 'string', description: "Original robot model path (MJCF/URDF), required by the motion_plan solver." }),
  tcp: required({ type: 'object', additionalProperties: true, description: "TCP definition: source-model body and optional local translation.", properties: {
    body: required({ type: 'string', description: "Source-model body used as TCP, without an entity prefix." }),
    offsetM: vec3,
  } }),
  jointNames: { type: 'array', items: { type: 'string' }, description: "Ordered IK joint names. Omission uses Provider-reported controlled joints, excluding gripper joints." },
} })
export const robotPickParameters: ParameterSchemaSpec = { input: {
  type: 'object', required: true, additionalProperties: false,
  description: "One bounded contact grasp: candidate, thresholds, and motion-planning configuration. Actual object displacement/support determines success, not joint arrival.",
  properties: {
    worldId: required({ type: 'string', description: "Simulation world ID returned by sim_open/sim_sync." }),
    robotId: required({ type: 'string' }), objectId: required({ type: 'string' }),
    candidate,
    approachDistanceM: required({ ...num, description: "Approach back-off distance along candidate.approach, in meters." }),
    liftHeightM: required({ ...num, description: "Lifting height after closing, in meters." }),
    minimumLiftM: required({ ...num, description: "Minimum measured displacement for grasp success, in meters; must be >0 and ≤liftHeightM." }),
    holdTimeS: required({ ...num, description: "Observation hold time after lifting, in seconds; must be >0." }),
    openWidthM: required({ ...num, description: "Initial open-gripper width, in meters." }),
    closeWidthM: required({ ...num, description: "Target closed-gripper width, in meters." }),
    actionPrefix: { type: 'string', description: "Optional action ID prefix; omission generates a random prefix." },
    planning,
  },
} }
export const robotPlaceParameters: ParameterSchemaSpec = { input: {
  type: 'object', required: true, additionalProperties: false,
  description: "One bounded placement: target TCP pose, thresholds, and motion-planning configuration. Actual support height/velocity and release evidence determine success.",
  properties: {
    worldId: required({ type: 'string', description: "Simulation world ID returned by sim_open/sim_sync." }),
    robotId: required({ type: 'string' }), objectId: required({ type: 'string' }),
    targetPose: tcpPose,
    openWidthM: required({ ...num, description: "Target gripper width when releasing, in meters." }),
    expectedSupportZ: required({ ...num, description: "Expected support-surface height, in meters." }),
    supportToleranceM: required({ ...num, description: "Support-height tolerance, in meters." }),
    stableSpeedMps: required({ ...num, description: "Maximum velocity for considering the object stationary, in m/s." }),
    holdTimeS: required({ ...num, description: "Observation hold time after withdrawal, in seconds; must be >0." }),
    retreatM: required({ ...num, description: "Withdrawal distance along +Z after release, in meters." }),
    actionPrefix: { type: 'string', description: "Optional action ID prefix; omission generates a random prefix." },
    planning,
  },
} }
/** 值语义：JSON Schema 只声明"是数组"，分量长度在这一层判（`candidate.tcpPose.position.map` 一类的解引用点）。 */
const isVectorOfNumbers = (value: unknown, length: number): boolean =>
  Array.isArray(value) && value.length === length && value.every(item => typeof item === 'number')
/**
 * 入参守卫：命令面与 operation 面共用（`plugin.ts` 的 `perform` 第一步）。
 *
 * 为什么需要第二层：模型面的强制力只住在 `defineTool` 的 execute 包装里，命令桥
 * （`commands.register` 的 handler 直接 `JSON.parse(rawInput)` 后交给 operation）不过 schema
 * （L381 判定；真机会话 `command/run` 35 条 / `tool/call` 0 条）。两层用的是**同一条判据**——
 * 都调框架的 `validateArgs` 与同一份 `parameters`，所以命令面与工具面得到逐字相同的错误文本与错误码
 * （`ToolArgsError` / `INVALID_ARGS`）；本函数再补 JSON Schema 表达不了的**值语义**（三个数值分量的
 * 点/四元数长度），这类以前落到 `candidate.tcpPose.position.map` 上就是原生 TypeError。
 * 消息只点名缺了哪个字段/哪个分量，不反吐入参值（值里可能带调用方自己的路径）。
 */
export function assertWorkflowArguments(name: 'robot_pick' | 'robot_place', input: unknown): void {
  const violations = validateArgs(name === 'robot_pick' ? robotPickParameters : robotPlaceParameters, { input })
  if (violations.length > 0) throw new ToolArgsError(violations)
  const record = input as { candidate?: { tcpPose?: { position?: unknown; quaternion?: unknown }; approach?: unknown }; targetPose?: { position?: unknown; quaternion?: unknown } }
  const malformed: string[] = []
  if (name === 'robot_pick') {
    if (!isVectorOfNumbers(record.candidate?.tcpPose?.position, 3)) malformed.push('candidate.tcpPose.position')
    if (!isVectorOfNumbers(record.candidate?.tcpPose?.quaternion, 4)) malformed.push('candidate.tcpPose.quaternion')
    if (!isVectorOfNumbers(record.candidate?.approach, 3)) malformed.push('candidate.approach')
  } else {
    if (!isVectorOfNumbers(record.targetPose?.position, 3)) malformed.push('targetPose.position')
    if (!isVectorOfNumbers(record.targetPose?.quaternion, 4)) malformed.push('targetPose.quaternion')
  }
  if (malformed.length > 0) throw new Error(`ROBOT_ARGS_INVALID: ${name} 的 ${malformed.join('、')} 必须是数值数组（三个位置分量、四个四元数分量）`)
}
const entity = (f: Frame, id: string) => { const e = f.entities.find(x => x.entityId === id); if (!e) throw new Error(`ENTITY_NOT_FOUND: ${id}`); return e }
/**
 * place 松手前的抬起量（米）：物体压在支撑面上时夹爪开不满（真机实测 release 目标 0.08 只到 0.043~0.047），
 * 先抬到物体只靠夹爪悬吊再松手，同一窗口同一命令即可开满（实测 0.0799）。只改机械条件，不改任何判据与容差。
 */
const RELEASE_CLEARANCE_M = 0.012
function contactsFor(frame: Frame, id: string) { return ((frame as Frame & { contacts?: any[] }).contacts ?? []).filter(c => c.geom1.startsWith(id + '/') || c.geom2.startsWith(id + '/')) }
/** 规划的 start 观测与执行回执都必须属于本次请求身份；外部直接调用（无 identity）时以 start 帧自带代次为本次身份。 */
export async function executePose(sim: SimWorlds, planner: Planner, worldId: string, robotId: string, targetPose: GraspCandidate['tcpPose'], actionId: string, signal?: AbortSignal, identity?: RequestIdentity) {
  const start = await sim.observe(worldId)
  if (identity) assertIdentity('起始观测', start, identity)
  const request = identity ?? identityOf(start)
  const plan = await planner({ worldId, entityId: robotId, start, targetPose, signal })
  // planner 依据刚读到的 start 规划；计划代次必须仍是本次请求代次，fresh observe 不得自动更换本次目标代次。
  if (plan.expectedGeneration !== request.generation) throw new Error(`STALE_GENERATION: 规划代次与本次请求不一致（${plan.expectedGeneration} != ${request.generation}）`)
  // 手臂相位只规划非夹爪关节（见 plugin.ts 的 planner），因此这条轨迹覆盖的是受控关节的**子集**；
  // 用 provider 的显式 opt-in 声明它：未列出的关节（这里是夹爪关节）保持上一次 ctrl ——
  // 不是"不动"也不是"归零"，这样夹爪动作建立的夹持力不会被手臂轨迹覆盖。
  // 该字段目前只在 MuJoCo provider 落地（`packages/sim-mujoco/python/worker.py` 的 `partialJointVector`）。
  const action: SimAction = { kind: 'trajectory', entityId: robotId, actionId, expectedGeneration: request.generation, jointNames: plan.jointNames, points: plan.points, plan, settleTimeS: .5, partialJointVector: true }
  const receipt = await sim.execute(worldId, action, signal)
  assertIdentity('动作回执', receipt, request)
  return receipt
}
/** 保持：begin 与每次观测都必须仍是本次请求身份；发现换代即失败，不自动改用新代次。 */
async function hold(sim: SimWorlds, worldId: string, identity: RequestIdentity, seconds: number, signal?: AbortSignal) {
  const begin = await sim.observe(worldId, { contacts: true }); assertIdentity('保持起始观测', begin, identity)
  let now = begin
  while (now.simTime - begin.simTime < seconds) {
    if (signal?.aborted) throw new Error('CANCELLED')
    await new Promise(resolve => setTimeout(resolve, 20)); now = await sim.observe(worldId, { contacts: true })
    assertIdentity('保持观测', now, identity)
  }
  return now
}
/** 释放三态：只消费释放回执里 gripper 动作真实报告的 targetReached；未报告就是未报告，绝不用缺失推 true。 */
function releaseStatement(release: ActionReceipt) {
  const motions = (release.effect as { motions?: unknown } | undefined)?.motions
  const gripperMotions = Array.isArray(motions) ? motions.filter(motion => (motion as { kind?: unknown } | null | undefined)?.kind === 'gripper') as Array<{ targetReached?: unknown }> : []
  if (gripperMotions.some(motion => motion.targetReached === false)) return { releaseReached: false as boolean | null, releaseEvidence: 'reported-not-reached' as const }
  if (gripperMotions.some(motion => motion.targetReached === true)) return { releaseReached: true as boolean | null, releaseEvidence: 'reported-reached' as const }
  return { releaseReached: null as boolean | null, releaseEvidence: 'not-reported' as const }
}
/** 有界一次接触抓取。候选和计划由公开函数提供；不自带 Agent、Goal Store、预演或无限重试。 */
export async function pick(sim: SimWorlds, planner: Planner, input: PickInput, signal?: AbortSignal): Promise<PickResult> {
  const before = await sim.observe(input.worldId, { contacts: true })
  const identity: RequestIdentity = { worldId: input.worldId, generation: before.generation }
  const seen: Frame[] = [before]
  let last = before
  const initialZ = entity(before, input.objectId).transform.position[2]
  const actions: ActionReceipt[] = []
  const prefix = input.actionPrefix ?? randomUUID()
  if (!(input.minimumLiftM > 0 && input.liftHeightM >= input.minimumLiftM && input.holdTimeS > 0)) throw new Error('INVALID_PICK_THRESHOLDS')
  // 每个观测与回执都要与 before 的 world/generation 核对；新鲜观测发现换代即结构化失败并保留已收集证据。
  const observeRequest = async (selection?: ObservationSelection) => { const frame = await sim.observe(input.worldId, selection); assertIdentity('观测', frame, identity); seen.push(frame); last = frame; return frame }
  const run = async (receipt: Promise<ActionReceipt>) => { const r = await receipt; actions.push(r); assertIdentity('动作回执', r, identity); if (r.status !== 'completed') throw new ActionReceiptError(r); return r }
  try {
    await run(sim.execute(input.worldId, { kind: 'gripper', actionId: prefix + '-open', expectedGeneration: identity.generation, entityId: input.robotId, widthM: input.openWidthM, durationS: .5 }, signal))
    const tcp = input.candidate.tcpPose
    const approachPose = { ...tcp, position: tcp.position.map((v, i) => v - input.candidate.approach[i]! * input.approachDistanceM) as Vec3 }
    await run(executePose(sim, planner, input.worldId, input.robotId, approachPose, prefix + '-approach', signal, identity))
    await run(executePose(sim, planner, input.worldId, input.robotId, tcp, prefix + '-descend', signal, identity))
    await run(sim.execute(input.worldId, { kind: 'gripper', actionId: prefix + '-close', expectedGeneration: identity.generation, entityId: input.robotId, widthM: input.closeWidthM, durationS: .7, settleTimeS: .5 }, signal))
    const closed = await observeRequest({ contacts: true })
    const liftPose = { ...tcp, position: [tcp.position[0], tcp.position[1], tcp.position[2] + input.liftHeightM] as Vec3 }
    await run(executePose(sim, planner, input.worldId, input.robotId, liftPose, prefix + '-lift', signal, identity))
    const afterLift = await observeRequest({ contacts: true })
    const after = await hold(sim, input.worldId, identity, input.holdTimeS, signal); seen.push(after); last = after
    const displacementM = entity(after, input.objectId).transform.position[2] - initialZ
    const liftStartDisplacementM = entity(afterLift, input.objectId).transform.position[2] - initialZ
    const contacts = contactsFor(after, input.objectId)
    const robotContacts = contacts.filter(c => c.geom1.startsWith(input.robotId + '/') || c.geom2.startsWith(input.robotId + '/'))
    const supportContacts = contacts.filter(c => !c.geom1.startsWith(input.robotId + '/') && !c.geom2.startsWith(input.robotId + '/'))
    const executionMode = executionModeOf(actions, seen)
    const achieved = executionMode === 'physical-contact' && displacementM >= input.minimumLiftM && liftStartDisplacementM >= input.minimumLiftM && robotContacts.length > 0 && supportContacts.length === 0
    const reason = achieved ? undefined : executionMode === 'assisted-teleport' ? 'ASSISTED_EXECUTION_NOT_PHYSICAL' : executionMode === 'unknown' ? 'EXECUTION_MODE_UNKNOWN' : 'LIFT_NOT_ACHIEVED'
    return { status: achieved ? 'completed' : 'failed', taskAchieved: achieved, executionMode, reason, candidate: input.candidate, actions, before, after, afterSource: 'fresh', effect: { displacementM, liftStartDisplacementM, holdTimeS: after.simTime - afterLift.simTime, minimumLiftM: input.minimumLiftM, robotContactCount: robotContacts.length, supportContactCount: supportContacts.length, closedObservation: closed } }
  } catch (error) {
    // 收尾：停止必须带本次 expectedGeneration 并显式记录结果；追加观测失败不冒充新 after。
    const stop = await confirmStop(sim, input.worldId, { entityIds: [input.robotId], expectedGeneration: identity.generation })
    const settled = await settledObservation(sim, input.worldId, identity, last, { contacts: true })
    if (settled.afterSource === 'fresh') { seen.push(settled.after); last = settled.after }
    let displacementM: number | undefined
    try { displacementM = entity(settled.after, input.objectId).transform.position[2] - initialZ } catch { displacementM = undefined }
    const cancelled = signal?.aborted === true || error instanceof ActionReceiptError && error.receipt.status === 'cancelled'
    return { status: cancelled ? 'cancelled' : 'failed', taskAchieved: false, executionMode: executionModeOf(actions, seen), reason: String(error), candidate: input.candidate, actions, before, after: settled.after, afterSource: settled.afterSource, ...(settled.observationError ? { observationError: settled.observationError } : {}), stop, effect: displacementM === undefined ? {} : { displacementM } }
  }
}
/** 有界放置：下降→松夹爪→退离→保持。成功必须有明确物理执行证据、释放证据未被否决（明确 targetReached=false 仍否决）与末态脱离机器人接触；releaseReached 保留三态。 */
export async function place(sim: SimWorlds, planner: Planner, input: PlaceInput, signal?: AbortSignal): Promise<PlaceResult> {
  const prefix = input.actionPrefix ?? randomUUID(), before = await sim.observe(input.worldId, { contacts: true })
  const identity: RequestIdentity = { worldId: input.worldId, generation: before.generation }
  const seen: Frame[] = [before]
  let last = before
  const actions: ActionReceipt[] = []
  const observeRequest = async (selection?: ObservationSelection) => { const frame = await sim.observe(input.worldId, selection); assertIdentity('观测', frame, identity); seen.push(frame); last = frame; return frame }
  const run = async (receipt: Promise<ActionReceipt>) => { const r = await receipt; actions.push(r); assertIdentity('动作回执', r, identity); if (r.status !== 'completed') throw new ActionReceiptError(r); return r }
  try {
    await run(executePose(sim, planner, input.worldId, input.robotId, input.targetPose, prefix + '-lower', signal, identity))
    // 松手前先抬起 RELEASE_CLEARANCE_M（两段式）：物体压在支撑面上时，夹爪被"物体重量+支撑面"顶住、开不满
    // ——真机实测：release 目标 0.08 只到 0.043~0.047（`targetReached=false` ⇒ `reported-not-reached`），
    // 同一窗口同一条命令在物体只靠夹爪悬吊时开满 0.0799（`reached=true`，三次对照）。
    // 判据、容差、三态语义都不变：这里只改"松手时物体是否还压在支撑面上"的机械条件。
    const clearancePose = { ...input.targetPose, position: [input.targetPose.position[0], input.targetPose.position[1], input.targetPose.position[2] + RELEASE_CLEARANCE_M] as Vec3 }
    await run(executePose(sim, planner, input.worldId, input.robotId, clearancePose, prefix + '-clearance', signal, identity))
    const release = await run(sim.execute(input.worldId, { kind: 'gripper', entityId: input.robotId, actionId: prefix + '-release', expectedGeneration: identity.generation, widthM: input.openWidthM, durationS: .7 }, signal))
    const pose = { ...input.targetPose, position: [input.targetPose.position[0], input.targetPose.position[1], input.targetPose.position[2] + input.retreatM] as Vec3 }
    await run(executePose(sim, planner, input.worldId, input.robotId, pose, prefix + '-retreat', signal, identity))
    const after = await hold(sim, input.worldId, identity, input.holdTimeS, signal); seen.push(after); last = after
    const object = entity(after, input.objectId), z = object.transform.position[2]
    const speed = Math.hypot(...((object.sensors?.bodyLinearVelocityMps as number[] | undefined) ?? [Infinity]))
    const contacts = contactsFor(after, input.objectId)
    const robotContacts = contacts.filter(c => c.geom1.startsWith(input.robotId + '/') || c.geom2.startsWith(input.robotId + '/'))
    const supportContacts = contacts.filter(c => !c.geom1.startsWith(input.robotId + '/') && !c.geom2.startsWith(input.robotId + '/'))
    const executionMode = executionModeOf(actions, seen)
    const { releaseReached, releaseEvidence } = releaseStatement(release)
    const geometryPlaced = Math.abs(z - input.expectedSupportZ) <= input.supportToleranceM && speed <= input.stableSpeedMps && supportContacts.length > 0
    const achieved = executionMode === 'physical-contact' && actions.every(a => a.status === 'completed') && releaseEvidence !== 'reported-not-reached' && robotContacts.length === 0 && geometryPlaced
    const reason = achieved ? undefined : executionMode === 'assisted-teleport' ? 'ASSISTED_EXECUTION_NOT_PHYSICAL' : executionMode === 'unknown' ? 'EXECUTION_MODE_UNKNOWN' : releaseEvidence === 'reported-not-reached' ? 'RELEASE_NOT_CONFIRMED' : robotContacts.length > 0 ? 'OBJECT_STILL_HELD' : 'PLACE_NOT_ACHIEVED'
    return { status: achieved ? 'completed' : 'failed', taskAchieved: achieved, executionMode, reason, actions, before, after, afterSource: 'fresh', effect: { objectZ: z, expectedSupportZ: input.expectedSupportZ, speedMps: speed, supportContactCount: supportContacts.length, robotContactCount: robotContacts.length, releaseReached, releaseEvidence } }
  } catch (error) {
    const stop = await confirmStop(sim, input.worldId, { entityIds: [input.robotId], expectedGeneration: identity.generation })
    const settled = await settledObservation(sim, input.worldId, identity, last, { contacts: true })
    if (settled.afterSource === 'fresh') { seen.push(settled.after); last = settled.after }
    const cancelled = signal?.aborted === true || error instanceof ActionReceiptError && error.receipt.status === 'cancelled'
    return { status: cancelled ? 'cancelled' : 'failed', taskAchieved: false, executionMode: executionModeOf(actions, seen), reason: String(error), actions, before, after: settled.after, afterSource: settled.afterSource, ...(settled.observationError ? { observationError: settled.observationError } : {}), stop, effect: {} }
  }
}
