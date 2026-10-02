import { randomUUID } from 'node:crypto'
import { Matrix4, Quaternion, Vector3 } from 'three'
import type { ActionReceipt, Entity, Frame, MotionPlan, SceneSnapshot, Vec3 } from '../../lyapunov-contracts/src/types.ts'
import type { SimWorlds } from '../../sim-contract/src/index.ts'
import type { RobotTcpDefinition, RobotBaseState } from '../../lyapunov-contracts/src/robot-authoring.ts'
import { validRobotPose } from '../../lyapunov-contracts/src/robot-authoring.ts'
import { tcpArrival } from './tcp-tracking.ts'

export interface TcpMoveInput { worldId: string; robotId: string; expectedGeneration: number; deltaM: Vec3; durationS?: number; actionId?: string }
export type TcpPlanner = (request: Record<string, unknown>, signal?: AbortSignal) => Promise<{ plan?: MotionPlan | null; collisionChecked?: boolean }>
type SitePose = { positionM: Vec3; quaternionXyzw: [number, number, number, number] }
function tcpPose(frame: Frame, entityId: string, tcp: RobotTcpDefinition): SitePose {
  const sensors = frame.entities.find(e => e.entityId === entityId)?.sensors
  const native = sensors?.tcp as SitePose & { bodyName?: string; site?: string } | undefined
  const site = tcp.site ? (sensors?.sites as Record<string, SitePose> | undefined)?.[tcp.site] : undefined
  const pose = native?.bodyName === tcp.body && native.site === tcp.site ? native : site
  if (!validRobotPose(pose)) throw new Error(`TCP_OBSERVATION_MISSING: 当前引擎尚无所选末端的真实位姿；请在侧栏重新选择 TCP 连杆/site 并同步。`)
  return pose
}
const poseMatrix = (pose: SitePose) => new Matrix4().compose(new Vector3(...pose.positionM), new Quaternion(...pose.quaternionXyzw), new Vector3(1, 1, 1))
function sceneMatrix(scene: SceneSnapshot, entity: Entity): Matrix4 {
  const t = entity.transform
  const local = new Matrix4().compose(new Vector3(...t.position), new Quaternion(...t.quaternion), new Vector3(...t.scale))
  return entity.parentId ? sceneMatrix(scene, scene.entities.find(e => e.entityId === entity.parentId)!).multiply(local) : local
}
/** 笛卡尔相对动作仅从当前物理 site/关节观测出发，IK 仍用既有 motion_plan；不编辑 Scene 根位姿。 */
export async function moveTcp(sim: SimWorlds, scene: SceneSnapshot, input: TcpMoveInput, planner: TcpPlanner, signal?: AbortSignal) {
  if (!Array.isArray(input.deltaM) || input.deltaM.length !== 3 || !input.deltaM.every(Number.isFinite) || Math.hypot(...input.deltaM) <= 0 || Math.hypot(...input.deltaM) > .15) throw new Error('TCP_DELTA_INVALID: deltaM 必须是三个米制分量，长度大于0且不超过0.15m')
  const durationS = input.durationS ?? 1
  if (!Number.isFinite(durationS) || durationS <= 0 || durationS > 5) throw new Error('TCP_DURATION_INVALID: durationS 必须在0至5秒内')
  const world = (await sim.listWorlds()).find(w => w.worldId === input.worldId)
  if (!world || world.sceneId !== scene.sceneId || world.appliedSceneRevision !== scene.revision || !['ready', 'running', 'paused'].includes(world.status)) throw new Error('WORLD_SCENE_MISMATCH: 先为当前场景启动并同步可用物理世界')
  if (world.worldGeneration !== input.expectedGeneration) throw new Error('STALE_GENERATION: world 已更新，请重新观察后再决定动作')
  const entity = scene.entities.find(e => e.entityId === input.robotId)
  if (!entity) throw new Error('ROBOT_ENTITY_MISSING')
  const tcp = entity.components.controller?.tcp as RobotTcpDefinition | undefined
  const modelPath = (entity.components.mujoco as { sourcePath?: string } | undefined)?.sourcePath
  if (!modelPath || !tcp?.body) throw new Error('TCP_MAPPING_REQUIRED: 请在机器人侧栏选择真实末端连杆或已有 site，保存 TCP 后重试；需要 MJCF 原件，无需下载策略')
  let root = sceneMatrix(scene, entity)
  const rootPosition = new Vector3(), rootQ = new Quaternion(), rootScale = new Vector3()
  root.decompose(rootPosition, rootQ, rootScale)
  if (rootScale.toArray().some(v => Math.abs(v - 1) > 1e-8) || entity.components.rigidBody?.dynamic === true) throw new Error('TCP_MODEL_FRAME_UNSUPPORTED: 当前独立 IK 只支持米制、不缩放的固定基座机器人')
  const description = await sim.describe(input.worldId, input.robotId)
  const before = await sim.observe(input.worldId, { entityIds: [input.robotId], sensors: true, contacts: true })
  if (before.generation !== input.expectedGeneration || before.sceneRevision !== scene.revision) throw new Error('STALE_OBSERVATION: 世界代次或已加载场景版本发生变化')
  const base = before.entities.find(e => e.entityId === input.robotId)?.sensors?.robotBase as RobotBaseState | undefined
  if (base) {
    if (base.mode !== 'fixed' || base.target?.entityId) throw new Error('TCP_MODEL_FRAME_UNSUPPORTED: 当前小步 IK 需要固定世界基座；可先在侧栏固定世界，或直接手调关节')
    if (!validRobotPose(base.worldFromBody) || !validRobotPose(base.modelFromBase)) throw new Error('TCP_MODEL_FRAME_UNAVAILABLE: 当前引擎缺少真实基座与源模型安装位姿')
    root = poseMatrix(base.worldFromBody).multiply(poseMatrix(base.modelFromBase).invert())
    root.decompose(rootPosition, rootQ, rootScale)
  }
  const from = tcpPose(before, input.robotId, tcp)
  const joints = before.entities.find(e => e.entityId === input.robotId)?.joints
  if (!joints) throw new Error('JOINT_OBSERVATION_MISSING: 需要真实有序关节观测')
  const gripper = (entity.components.controller?.gripper as { jointNames?: string[] } | undefined)?.jointNames ?? []
  const names = description.controlledJointNames.filter(n => !gripper.includes(n))
  const starts = names.map(n => joints.positions[joints.names.indexOf(n)])
  if (!names.length || starts.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new Error('JOINT_MAPPING_MISSING: 受控关节与实测关节不完整匹配')
  const target = from.positionM.map((v, i) => v + input.deltaM[i]!) as Vec3
  const modelTarget = new Vector3(...target).applyMatrix4(root.clone().invert()).toArray()
  const modelQ = rootQ.clone().invert().multiply(new Quaternion(...from.quaternionXyzw)).normalize().toArray()
  const actionId = input.actionId ?? `tcp-${randomUUID()}`
  const stopController = new AbortController(), operationSignal = signal ? AbortSignal.any([signal, stopController.signal]) : stopController.signal
  const issuedIds = new Set([actionId])
  const unsubscribeStop = sim.subscribeStops?.(input.worldId, selection => {
    if (selection.expectedGeneration !== undefined && selection.expectedGeneration !== input.expectedGeneration) return
    if (selection.entityIds?.length && !selection.entityIds.includes(input.robotId)) return
    if (selection.actionId && !issuedIds.has(selection.actionId)) return
    stopController.abort(new Error('TCP_STOP_CONFIRMED: 已停止机器人，取消后续末端修正'))
  })
  const contactKey = (a: string, b: string) => JSON.stringify([a, b].sort())
  const robotContact = (a: string, b: string) => a.startsWith(input.robotId + '/') || b.startsWith(input.robotId + '/')
  const initialContacts = new Set((before.contacts ?? []).filter(contact => robotContact(contact.geom1, contact.geom2)).map(contact => contactKey(contact.geom1, contact.geom2)))
  const attempts: Array<{ actionId: string; status: string; startStep?: number; endStep?: number; targetErrorM: number; measuredDeltaM: Vec3; maxJointBias: number }> = []
  let after = before, to = from, afterPositions = starts, receipt: ActionReceipt | undefined, collisionChecked = true
  let reason = 'TCP_TARGET_NOT_REACHED', previousErrorM = Math.hypot(...input.deltaM), stagnant = 0
  const bias = names.map(() => 0)
  const maximumAttempts = 4
  try {
    for (let attempt = 0; attempt < maximumAttempts; attempt++) {
      operationSignal.throwIfAborted()
      const currentWorld = (await sim.listWorlds()).find(world => world.worldId === input.worldId)
      if (!currentWorld || currentWorld.sceneId !== scene.sceneId || currentWorld.worldGeneration !== input.expectedGeneration || currentWorld.appliedSceneRevision !== scene.revision || !['ready', 'running', 'paused'].includes(currentWorld.status)) throw new Error('STALE_OBSERVATION: 末端跟踪期间世界/场景已变化')
      const observedJoints = after.entities.find(entity => entity.entityId === input.robotId)?.joints
      if (!observedJoints) throw new Error('JOINT_OBSERVATION_MISSING')
      const fixedJoints = Object.fromEntries(observedJoints.names.filter(name => !names.includes(name)).map(name => [name, observedJoints.positions[observedJoints.names.indexOf(name)]]))
      const toleranceM = tcpArrival(input.deltaM, [0, 0, 0]).toleranceM
      const planned = await planner({ modelPath, entityId: input.robotId, modelVersion: description.modelVersion, collisionContextVersion: description.collisionContextVersion, expectedGeneration: input.expectedGeneration, tcp, jointNames: names, startPositions: afterPositions, fixedJoints, targetPose: { position: modelTarget, quaternion: modelQ }, durationS, positionToleranceM: toleranceM * .25 }, operationSignal)
      collisionChecked &&= planned.collisionChecked === true
      operationSignal.throwIfAborted()
      if (!planned.plan) {
        if (!attempt) throw new Error('MOTION_NO_SOLUTION: 当前末端目标未得到 IK 解；没有执行运动')
        reason = 'TCP_TRACKING_NO_SOLUTION'; break
      }
      const solution = planned.plan
      if (solution.expectedGeneration !== input.expectedGeneration || solution.entityId !== input.robotId || solution.modelVersion !== description.modelVersion || solution.collisionContextVersion !== description.collisionContextVersion || solution.jointNames.length !== names.length || solution.jointNames.some((name, index) => name !== names[index])) throw new Error('MOTION_PLAN_IDENTITY_MISMATCH')
      const totalS = solution.points.at(-1)?.timeS
      if (!totalS || !Number.isFinite(totalS)) throw new Error('MOTION_PLAN_INVALID')
      const points = solution.points.map(point => ({ ...point, positions: point.positions.map((value, index) => value + bias[index]! * point.timeS / totalS) }))
      // 原规划检查只覆盖原points；反馈改变轨迹后没有重新验证，不能沿用其碰撞检查结论。
      if (bias.some(value => value !== 0)) collisionChecked = false
      const limitsValid = points.every(point => point.positions.every((value, index) => {
        const range = description.joints.find(joint => joint.name === names[index])?.range
        return Number.isFinite(value) && (!range || value >= range[0] && value <= range[1])
      }))
      if (!limitsValid) { reason = 'TCP_TRACKING_JOINT_LIMIT'; break }
      const plan = { ...solution, planId: attempt ? `${solution.planId}:feedback-${attempt}` : solution.planId, points }
      const attemptId = attempt ? `${actionId}:tracking-${attempt}` : actionId
      issuedIds.add(attemptId)
      receipt = await sim.execute(input.worldId, { kind: 'trajectory', entityId: input.robotId, actionId: attemptId, expectedGeneration: input.expectedGeneration, jointNames: plan.jointNames, points, plan, settleTimeS: .5, partialJointVector: true }, operationSignal)
      after = await sim.observe(input.worldId, { entityIds: [input.robotId], sensors: true, contacts: true })
      if (after.worldId !== before.worldId || after.generation !== before.generation || after.sceneRevision !== before.sceneRevision) throw new Error('STALE_OBSERVATION: 动作后观测不属于原世界/场景版本')
      if (typeof receipt.endStep === 'number' && after.stepIndex < receipt.endStep) throw new Error('STALE_OBSERVATION: 末端读回早于本次动作终态，不能签到达')
      to = tcpPose(after, input.robotId, tcp)
      const actualJoints = after.entities.find(entity => entity.entityId === input.robotId)?.joints
      const positions = names.map(name => actualJoints?.positions[actualJoints.names.indexOf(name)])
      if (positions.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('JOINT_OBSERVATION_MISSING: 动作后关节读数不完整')
      afterPositions = positions as number[]
      const measuredDeltaM = to.positionM.map((value, index) => value - from.positionM[index]!) as Vec3
      const arrival = tcpArrival(input.deltaM, measuredDeltaM)
      attempts.push({ actionId: attemptId, status: receipt.status, startStep: receipt.startStep, endStep: receipt.endStep, targetErrorM: arrival.targetErrorM, measuredDeltaM, maxJointBias: Math.max(...bias.map(Math.abs)) })
      if (receipt.status !== 'completed') { reason = receipt.status === 'cancelled' ? 'TCP_STOP_CONFIRMED' : 'TCP_ACTION_FAILED'; break }
      if (after.executionMode !== 'physical-contact') { reason = 'TCP_PHYSICAL_OBSERVATION_REQUIRED'; break }
      if (arrival.reached) break
      // 新增接触且末端未达标，停止保持当前实测状态；不以补偿目标持续推入障碍。
      const contacts = (after.contacts ?? []).filter(contact => robotContact(contact.geom1, contact.geom2))
      if (contacts.some(contact => !initialContacts.has(contactKey(contact.geom1, contact.geom2))) || attempt > 0 && contacts.length > 0 && previousErrorM - arrival.targetErrorM < arrival.toleranceM * .1) { reason = 'TCP_BLOCKED_BY_CONTACT'; break }
      if (attempt && previousErrorM - arrival.targetErrorM < arrival.toleranceM * .1) stagnant++
      else stagnant = 0
      if (stagnant >= 2) { reason = 'TCP_TRACKING_NO_PROGRESS'; break }
      previousErrorM = arrival.targetErrorM
      // 用当前原生关节误差消除执行器的静态跟踪偏差；不改源增益、质量、重力或Scene根。
      // 每个关节的累计补偿最多为该源限位跨度的2%；限位不可核则不进入自动补偿。
      const reference = points.at(-1)!.positions
      const nextBias = bias.map((value, index) => value + reference[index]! - afterPositions[index]!)
      const biasValid = nextBias.every((value, index) => {
        const range = description.joints.find(joint => joint.name === names[index])?.range
        return range?.every(Number.isFinite) && Math.abs(value) <= (range[1] - range[0]) * .02
      })
      if (!biasValid) { reason = 'TCP_TRACKING_REFERENCE_LIMIT'; break }
      bias.splice(0, bias.length, ...nextBias)
    }
  } catch (error) {
    await sim.stop(input.worldId, { entityIds: [input.robotId], expectedGeneration: input.expectedGeneration })
    throw error
  } finally {
    unsubscribeStop?.()
  }
  const measuredDeltaM = to.positionM.map((value, index) => value - from.positionM[index]!) as Vec3
  const arrival = tcpArrival(input.deltaM, measuredDeltaM)
  const taskAchieved = receipt?.status === 'completed' && after.executionMode === 'physical-contact' && arrival.reached
  if (!taskAchieved) await sim.stop(input.worldId, { entityIds: [input.robotId], expectedGeneration: input.expectedGeneration })
  return { status: taskAchieved ? 'completed' : receipt?.status === 'cancelled' ? 'cancelled' : 'failed', taskAchieved, ...(taskAchieved ? {} : { reason }), executionMode: after.executionMode ?? 'unknown', site: tcp.site, bodyName: tcp.body, requestedDeltaM: input.deltaM, measuredDeltaM, targetErrorM: arrival.targetErrorM, beforeTcp: from, afterTcp: to, action: { actionId: receipt?.actionId ?? actionId, status: receipt?.status ?? 'not-started' }, beforeStep: before.stepIndex, afterStep: after.stepIndex, jointNames: names, beforePositions: starts, afterPositions, contacts: (after.contacts ?? []).filter(contact => robotContact(contact.geom1, contact.geom2)), collisionChecked, tracking: { mode: 'native-frame-feedback', maximumAttempts, attempts, toleranceM: arrival.toleranceM, directionMatches: arrival.directionMatches, progressM: arrival.progressM, lateralErrorM: arrival.lateralErrorM } }
}
