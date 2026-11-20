import type { ActionReceipt, Frame, GraspCandidate, MotionPlan, Vec3 } from '../../lyapunov-contracts/src/types.ts'
import type { ObservationSelection, SimAction, SimWorlds } from '../../sim-contract/src/index.ts'
import { ToolArgsError, validateArgs, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { ActionReceiptError, assertIdentity, confirmStop, executionModeOf, identityOf, settledObservation, type ExecutionMode, type ObservationFreshness, type RequestIdentity, type StopOutcome } from './workflow-evidence.ts'
import { randomUUID } from 'node:crypto'
import { correctedGraspPose, type WristRefinementInput, type wristCorrection } from './wrist-refinement.ts'
export interface PlanRequest { worldId: string; entityId: string; start: Frame; targetPose: GraspCandidate['tcpPose']; signal?: AbortSignal; cartesianSegments?: number }
export type Planner = (request: PlanRequest) => Promise<MotionPlan>
type RefinePick = (identity: RequestIdentity, captureAttempt?: number, minimumStep?: number) => ReturnType<typeof wristCorrection>
export interface PickInput { worldId: string; robotId: string; objectId: string; candidate: GraspCandidate; approachDistanceM: number; liftHeightM: number; minimumLiftM: number; holdTimeS: number; openWidthM: number; closeWidthM: number; actionPrefix?: string; wristRefinement?: WristRefinementInput; descentSegments?: number; safeOpenPose?: GraspCandidate['tcpPose']; recordPhaseCheckpoints?: boolean; minimumCloseTravelM?: number }
export interface PickResult { status: 'completed' | 'failed' | 'cancelled'; taskAchieved: boolean; executionMode: ExecutionMode; reason?: string; candidate: GraspCandidate; actions: ActionReceipt[]; before: Frame; after: Frame; afterSource?: ObservationFreshness; observationError?: string; stop?: StopOutcome; effect: Record<string, unknown> }
export interface PlaceInput { worldId: string; robotId: string; objectId: string; targetPose: GraspCandidate['tcpPose']; openWidthM: number; expectedSupportZ: number; supportToleranceM: number; stableSpeedMps: number; holdTimeS: number; retreatM: number; transferClearanceM?: number; carryObstacleIds?: string[]; actionPrefix?: string }
export interface PlaceResult { status: 'completed' | 'failed' | 'cancelled'; taskAchieved: boolean; executionMode: ExecutionMode; reason?: string; actions: ActionReceipt[]; before: Frame; after: Frame; afterSource?: ObservationFreshness; observationError?: string; stop?: StopOutcome; effect: Record<string, unknown> }
// ---- 模型可见入参与分层守卫：字段按上面两个接口与 `plugin.ts` 的 planner 真实解引用面写全 ----
const num = { type: 'number' } as const
const vec3 = { type: 'array', items: num, description: "Three components [x,y,z] in meters." } as const
const vec4 = { type: 'array', items: num, description: "Quaternion [x,y,z,w]." } as const
const required = <const T extends object>(value: T) => ({ ...value, required: true as const })
const poseSchema = { type: 'object', additionalProperties: false, description: "TCP world pose: meters, Z-up, xyzw quaternion.", properties: { position: required(vec3), quaternion: required(vec4) } } as const
const tcpPose = required(poseSchema)
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
    safeOpenPose: { ...poseSchema, description: 'Optional verified open staging pose. Prevent opening on target contact; use native sampled clearance for the approach.' },
    recordPhaseCheckpoints: { type: 'boolean', description: 'Save native MuJoCo checkpoints before the four grasp stages.' },
    minimumCloseTravelM: { ...num, description: 'Optional native measured gripper travel required before lifting (meters).' },
    descentSegments: { type: 'integer', description: 'Optional number of Cartesian descent segments (2–8); requires a planner that reports that effort. Other grasp stages retain their existing paths.' },
    approachDistanceM: required({ ...num, description: "Approach back-off distance along candidate.approach, in meters." }),
    liftHeightM: required({ ...num, description: "Lifting height after closing, in meters." }),
    minimumLiftM: required({ ...num, description: "Minimum measured displacement for grasp success, in meters; must be >0 and ≤liftHeightM." }),
    holdTimeS: required({ ...num, description: "Observation hold time after lifting, in seconds; must be >0." }),
    openWidthM: required({ ...num, description: "Initial open-gripper width, in meters." }),
    closeWidthM: required({ ...num, description: "Target closed-gripper width, in meters." }),
    actionPrefix: { type: 'string', description: "Optional action ID prefix; omission generates a random prefix." },
    wristRefinement: { type: 'object', additionalProperties: false, description: 'Optional MuJoCo mounted RGB-D camera correction at approach height. Target is a known color on a calibrated horizontal plane.', properties: {
      cameraName: required({ type: 'string' }), outputDir: required({ type: 'string' }),
      targetChannel: required({ type: 'string', enum: ['red', 'green', 'blue'] }),
      estimateXY: required({ type: 'array', items: num }), targetPlaneZM: required(num), maxCorrectionM: required(num),
      reacquireBackoffM: { ...num, description: 'Optional one-time retreat along the approach axis, at most 0.05 m, when the target is absent or clipped.' },
      feedbackPasses: { type: 'integer', description: 'Opt in to 2–6 fresh wrist measurements with physical corrections between them. Stop before descent if convergence fails.' },
      feedbackToleranceM: { ...num, description: 'Maximum XY residual for feedback, in metres. Default 0.0015.' },
      yawPivotXY: { type: 'array', items: num, description: 'Optional world XY position of the radial approach pivot.' },
    } },
    gauntletProprio: { type: 'boolean', description: 'Opt in to the current MuJoCo laboratory profile joint observations for motion planning.' },
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
    carryObstacleIds: { type: 'array', items: { type: 'string' }, description: 'Explicit obstacle entities for native sampled arm and carried-object clearance during raised transfer.' },
    transferClearanceM: { ...num, description: "Optional positive height above the placement pose to reach before lowering into a container." },
    actionPrefix: { type: 'string', description: "Optional action ID prefix; omission generates a random prefix." },
    gauntletProprio: { type: 'boolean', description: 'Opt in to the current MuJoCo laboratory profile joint observations for motion planning.' },
    planning,
  },
} }
/** 值语义：JSON Schema 只声明"是数组"，分量长度在这一层判（`candidate.tcpPose.position.map` 一类的解引用点）。 */
const isVectorOfNumbers = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) && value.length === length && value.every(item => typeof item === 'number' && Number.isFinite(item))
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
  const record = input as { candidate?: { tcpPose?: { position?: unknown; quaternion?: unknown }; approach?: unknown }; targetPose?: { position?: unknown; quaternion?: unknown }; wristRefinement?: WristRefinementInput; transferClearanceM?: number; descentSegments?: number; safeOpenPose?: PickInput['safeOpenPose']; minimumCloseTravelM?: number; carryObstacleIds?: string[] }
  const malformed: string[] = []
  if (name === 'robot_pick') {
    if (!isVectorOfNumbers(record.candidate?.tcpPose?.position, 3)) malformed.push('candidate.tcpPose.position')
    if (!isVectorOfNumbers(record.candidate?.tcpPose?.quaternion, 4)) malformed.push('candidate.tcpPose.quaternion')
    const approach = record.candidate?.approach
    if (!isVectorOfNumbers(approach, 3)) malformed.push('candidate.approach')
    if (record.descentSegments !== undefined && (!Number.isInteger(record.descentSegments) || record.descentSegments < 2 || record.descentSegments > 8)) throw new Error('ROBOT_ARGS_INVALID: descentSegments 必须是 2–8 的整数')
    if (record.safeOpenPose && (!isVectorOfNumbers(record.safeOpenPose.position, 3) || !isVectorOfNumbers(record.safeOpenPose.quaternion, 4))) malformed.push('safeOpenPose')
    if (record.minimumCloseTravelM !== undefined && !(record.minimumCloseTravelM > 0 && record.minimumCloseTravelM <= .05)) throw new Error('ROBOT_ARGS_INVALID: minimumCloseTravelM 需要大于 0 且不超过 0.05 米')
    const vision = record.wristRefinement
    if (vision && (!isVectorOfNumbers(vision.estimateXY, 2)
      || !Number.isFinite(vision.targetPlaneZM) || !(vision.maxCorrectionM > 0 && vision.maxCorrectionM <= .1)
      || vision.feedbackPasses !== undefined && (!Number.isInteger(vision.feedbackPasses) || vision.feedbackPasses < 2 || vision.feedbackPasses > 6)
      || vision.feedbackToleranceM !== undefined && (vision.feedbackPasses === undefined || !(vision.feedbackToleranceM >= .0001 && vision.feedbackToleranceM <= .01))
      || vision.reacquireBackoffM !== undefined && (!(vision.reacquireBackoffM > 0 && vision.reacquireBackoffM <= .05)
        || !isVectorOfNumbers(approach, 3) || Math.abs(Math.hypot(...approach) - 1) > 1e-6)
      || vision.yawPivotXY !== undefined && !isVectorOfNumbers(vision.yawPivotXY, 2))) {
      throw new Error('ROBOT_ARGS_INVALID: wristRefinement 需要有限的估计 XY、平面高度和 (0, 0.1] 米的纠偏上限')
    }
  } else {
    if (!isVectorOfNumbers(record.targetPose?.position, 3)) malformed.push('targetPose.position')
    if (!isVectorOfNumbers(record.targetPose?.quaternion, 4)) malformed.push('targetPose.quaternion')
    if (record.carryObstacleIds && (!record.transferClearanceM || !record.carryObstacleIds.length || record.carryObstacleIds.length > 12
      || new Set(record.carryObstacleIds).size !== record.carryObstacleIds.length)) throw new Error('ROBOT_ARGS_INVALID: 携物净空需要抬高转运和 1–12 个不同障碍实体')
    if (record.transferClearanceM !== undefined && !(Number.isFinite(record.transferClearanceM) && record.transferClearanceM > 0)) throw new Error('ROBOT_ARGS_INVALID: transferClearanceM 需要正数（米）')
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
export async function executePose(sim: SimWorlds, planner: Planner, worldId: string, robotId: string, targetPose: GraspCandidate['tcpPose'], actionId: string, signal?: AbortSignal, identity?: RequestIdentity, cartesianSegments?: number, clearance?: Extract<SimAction, { kind: 'trajectory' }>['clearance']) {
  const start = await sim.observe(worldId)
  if (identity) assertIdentity('起始观测', start, identity)
  const request = identity ?? identityOf(start)
  const plan = await planner({ worldId, entityId: robotId, start, targetPose, signal, ...(cartesianSegments === undefined ? {} : { cartesianSegments }) })
  if (cartesianSegments !== undefined && plan.cartesianSegments !== cartesianSegments) throw new Error('MOTION_PLAN_SEGMENTS_UNSUPPORTED: 规划器没有提供请求的笛卡尔分段')
  // planner 依据刚读到的 start 规划；计划代次必须仍是本次请求代次，fresh observe 不得自动更换本次目标代次。
  if (plan.expectedGeneration !== request.generation) throw new Error(`STALE_GENERATION: 规划代次与本次请求不一致（${plan.expectedGeneration} != ${request.generation}）`)
  // 手臂相位只规划非夹爪关节（见 plugin.ts 的 planner），因此这条轨迹覆盖的是受控关节的**子集**；
  // 用 provider 的显式 opt-in 声明它：未列出的关节（这里是夹爪关节）保持上一次 ctrl ——
  // 不是"不动"也不是"归零"，这样夹爪动作建立的夹持力不会被手臂轨迹覆盖。
  // 该字段目前只在 MuJoCo provider 落地（`packages/sim-mujoco/python/worker.py` 的 `partialJointVector`）。
  const action: SimAction = { kind: 'trajectory', entityId: robotId, actionId, expectedGeneration: request.generation, jointNames: plan.jointNames, points: plan.points, plan, settleTimeS: .5, partialJointVector: true, ...(clearance ? { clearance } : {}) }
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
export async function pick(sim: SimWorlds, planner: Planner, input: PickInput, signal?: AbortSignal, refine?: RefinePick): Promise<PickResult> {
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
  let refinement: Awaited<ReturnType<RefinePick>> | undefined
  const wristFeedback: Array<{ measurement: Awaited<ReturnType<RefinePick>>; residualM: number; actionId?: string }> = []
  let wristReacquisition: { backoffM: number; reason: string } | undefined
  const phaseCheckpoints: Record<string, unknown> = {}
  const savePhase = async (phase: string) => {
    if (input.recordPhaseCheckpoints) {
      signal?.throwIfAborted()
      if (!sim.assess) throw new Error('PHASE_CHECKPOINT_UNSUPPORTED')
      phaseCheckpoints[phase] = await sim.assess(input.worldId, { kind: 'checkpoint', expectedGeneration: identity.generation })
    }
  }
  const canOpen = (frame: Frame) => {
    if (!frame.contacts) throw new Error('SAFE_OPEN_CONTACT_OBSERVATION_REQUIRED')
    if (contactsFor(frame, input.objectId).some(c => c.geom1.startsWith(input.robotId + '/') || c.geom2.startsWith(input.robotId + '/'))) {
      throw new Error('SAFE_OPEN_TARGET_CONTACT')
    }
  }
  const widthOf = (receipt: ActionReceipt) => (receipt.effect as { motions?: Array<{ actualWidthM?: unknown }> } | undefined)?.motions?.[0]?.actualWidthM
  try {
    if (input.safeOpenPose) {
      if (!sim.assess) throw new Error('SAFE_OPEN_NATIVE_REQUIRED')
      canOpen(before)
      await run(executePose(sim, planner, input.worldId, input.robotId, input.safeOpenPose, prefix + '-safe-open-approach', signal, identity, undefined,
        { obstacleIds: [input.objectId], minimumDistanceM: 0, ...(before.worldStatus === 'paused' ? { resumeFromPause: true as const } : {}) }))
      canOpen(await observeRequest({ contacts: true }))
    }
    await savePhase('beforeOpen')
    const opened = await run(sim.execute(input.worldId, { kind: 'gripper', actionId: prefix + '-open', expectedGeneration: identity.generation, entityId: input.robotId, widthM: input.openWidthM, durationS: .5 }, signal))
    let tcp = input.candidate.tcpPose
    const approachPose = { ...tcp, position: tcp.position.map((v, i) => v - input.candidate.approach[i]! * input.approachDistanceM) as Vec3 }
    const approached = await run(executePose(sim, planner, input.worldId, input.robotId, approachPose, prefix + '-approach', signal, identity))
    if (refine && input.wristRefinement) {
      const vision = input.wristRefinement
      signal?.throwIfAborted()
      let captureAttempt = 1
      try {
        refinement = await refine(identity, captureAttempt, approached.endStep)
      } catch (error) {
        const backoffM = input.wristRefinement.reacquireBackoffM
        if (!backoffM || !(error instanceof Error) || !error.message.startsWith('WRIST_TARGET_UNRELIABLE:')) throw error
        signal?.throwIfAborted()
        wristReacquisition = { backoffM, reason: error.message }
        const backup = approachPose.position.map((v, i) => v - input.candidate.approach[i]! * backoffM) as Vec3
        const backedOff = await run(executePose(sim, planner, input.worldId, input.robotId, { ...approachPose, position: backup }, prefix + '-wrist-backoff', signal, identity))
        refinement = await refine(identity, ++captureAttempt, backedOff.endStep)
      }
      if (vision.feedbackPasses !== undefined) {
        let applied: Vec3 = [0, 0, 0]
        let converged = false
        for (let pass = 1; pass <= vision.feedbackPasses; pass++) {
          const measurement = refinement
          const residualM = Math.hypot(measurement.deltaM[0] - applied[0], measurement.deltaM[1] - applied[1])
          const sample: (typeof wristFeedback)[number] = { measurement, residualM }
          wristFeedback.push(sample)
          if (pass > 1 && residualM <= (vision.feedbackToleranceM ?? .0015)) {
            converged = true
            break
          }
          if (pass === vision.feedbackPasses) break
          sample.actionId = prefix + '-wrist-feedback-' + pass
          const correction = await run(executePose(sim, planner, input.worldId, input.robotId,
            correctedGraspPose(approachPose, vision, measurement), sample.actionId, signal, identity))
          const motions = (correction.effect as { motions?: Array<{ targetReached?: boolean }> } | undefined)?.motions
          if (motions?.some(motion => motion.targetReached === false) || correction.endStep === undefined) throw new Error('WRIST_FEEDBACK_MOTION_NOT_REACHED')
          applied = measurement.deltaM
          signal?.throwIfAborted()
          refinement = await refine(identity, ++captureAttempt, Math.max(correction.endStep, measurement.stepIndex + 1))
          if (refinement.captureId === measurement.captureId || refinement.stepIndex <= measurement.stepIndex) throw new Error('WRIST_STALE_FRAME')
        }
        if (!converged) throw new Error('WRIST_FEEDBACK_NOT_CONVERGED')
        tcp = correctedGraspPose(tcp, vision, { ...refinement, deltaM: applied })
      } else {
        tcp = correctedGraspPose(tcp, vision, refinement)
        if (wristReacquisition || Math.hypot(...refinement.deltaM) > .001) {
          await run(executePose(sim, planner, input.worldId, input.robotId, correctedGraspPose(approachPose, vision, refinement), prefix + '-wrist-correct', signal, identity))
        }
      }
    }
    await savePhase('beforeDescend')
    await run(executePose(sim, planner, input.worldId, input.robotId, tcp, prefix + '-descend', signal, identity, input.descentSegments))
    await savePhase('beforeClose')
    const closeReceipt = await run(sim.execute(input.worldId, { kind: 'gripper', actionId: prefix + '-close', expectedGeneration: identity.generation, entityId: input.robotId, widthM: input.closeWidthM, durationS: .7, settleTimeS: .5 }, signal))
    if (input.minimumCloseTravelM !== undefined) {
      const opening = widthOf(opened), closing = widthOf(closeReceipt)
      if (typeof opening !== 'number' || typeof closing !== 'number' || !Number.isFinite(opening) || !Number.isFinite(closing)) {
        throw new Error('GRIPPER_TRAVEL_OBSERVATION_REQUIRED')
      }
      if (opening - closing < input.minimumCloseTravelM) throw new Error('GRIPPER_STALL')
    }
    await savePhase('beforeLift')
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
    return { status: achieved ? 'completed' : 'failed', taskAchieved: achieved, executionMode, reason, candidate: input.candidate, actions, before, after, afterSource: 'fresh', effect: { ...(input.recordPhaseCheckpoints ? { phaseCheckpoints } : {}), ...(refinement ? { refinement } : {}), ...(wristFeedback.length ? { wristFeedback } : {}), ...(wristReacquisition ? { wristReacquisition } : {}), displacementM, liftStartDisplacementM, holdTimeS: after.simTime - afterLift.simTime, minimumLiftM: input.minimumLiftM, robotContactCount: robotContacts.length, supportContactCount: supportContacts.length, closedObservation: closed } }
  } catch (error) {
    // 收尾：停止必须带本次 expectedGeneration 并显式记录结果；追加观测失败不冒充新 after。
    const stop = await confirmStop(sim, input.worldId, { entityIds: [input.robotId], expectedGeneration: identity.generation })
    const settled = await settledObservation(sim, input.worldId, identity, last, { contacts: true })
    if (settled.afterSource === 'fresh') { seen.push(settled.after); last = settled.after }
    let displacementM: number | undefined
    try { displacementM = entity(settled.after, input.objectId).transform.position[2] - initialZ } catch { displacementM = undefined }
    const cancelled = signal?.aborted === true || error instanceof ActionReceiptError && error.receipt.status === 'cancelled'
    return { status: cancelled ? 'cancelled' : 'failed', taskAchieved: false, executionMode: executionModeOf(actions, seen), reason: String(error), candidate: input.candidate, actions, before, after: settled.after, afterSource: settled.afterSource, ...(settled.observationError ? { observationError: settled.observationError } : {}), stop, effect: { ...(input.recordPhaseCheckpoints ? { phaseCheckpoints } : {}), ...(refinement ? { refinement } : {}), ...(wristFeedback.length ? { wristFeedback } : {}), ...(wristReacquisition ? { wristReacquisition } : {}), ...(displacementM === undefined ? {} : { displacementM }) } }
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
    if (input.transferClearanceM !== undefined) {
      if (input.carryObstacleIds && !sim.assess) throw new Error('CARRY_CLEARANCE_NATIVE_REQUIRED')
      const [x, y, z] = input.targetPose.position
      const above = { ...input.targetPose, position: [x, y, z + input.transferClearanceM] as Vec3 }
      await run(executePose(sim, planner, input.worldId, input.robotId, above, prefix + '-transfer', signal, identity, undefined,
        input.carryObstacleIds ? { obstacleIds: input.carryObstacleIds, carriedObjectId: input.objectId } : undefined))
    }
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
