import { randomUUID } from 'node:crypto'
import type { ActionReceipt, Entity, Frame, SceneSnapshot, Vec3 } from '../../lyapunov-contracts/src/types.ts'
import type { EntityMotion, SimWorlds } from '../../sim-contract/src/index.ts'
import { fleetNavigationStep, fleetNeedsDirectionChangeBrake, planFleetNavigation, resolveFleetSteeredDockingRoute, resolveFleetRelativeTurnArc, fleetTerminalApproachAlreadyAdmitted } from './fleet/fleet-navigation.ts'
import { admitForkPocketEngagement, assessForkInsertionProgress, assessPayloadReleaseSupport, assessReleasedPayloadForkClearance, resolveCargoShelfPlacement, resolveCargoShelfPlacementLane, resolveForkInsertionNavigationTargets, resolveForkPocketInsertion, resolveForkPocketLiftTarget, resolveLoadCompensatedLiftControlM, resolvePayloadCenterOffsetInCarrierFrame, resolvePayloadSupportLiftTargetM, resolvePayloadTransportLiftTargetM, type CargoShelfPlacementInterface, type ForkPocketLoadInterface, type LoadCarrierProfile } from './fleet/fleet-load-interface.ts'
import { evaluateForkliftCargoLoad, forkliftCarriedSweptRadius } from './fleet/fleet-cargo.ts'
import { confirmStop, executionModeOf, type StopOutcome } from './workflow-evidence.ts'
import type { FleetPathObstacle, FleetPoint } from './fleet/fleet-path.ts'
export interface CargoTransferInput {
 worldId: string; expectedGeneration: number; vehicleId: string; cargoId: string; supportId: string
 levelId?: string; slotId?: string; supportAssignments?: Array<{ vehicleId: string; supportId: string }>
 bounds?: { min: FleetPoint; max: FleetPoint }; obstacles?: FleetPathObstacle[]
 speedMps?: number; carryClearanceM?: number; minimumLiftM?: number; placementToleranceM?: number; maxDurationS?: number; actionPrefix?: string
}
type Site = { positionM: Vec3; quaternionXyzw: [number, number, number, number] }
type LoadInterface = ForkPocketLoadInterface & { halfExtentsM: Vec3 }
type SupportInterface = CargoShelfPlacementInterface & { halfExtentsM?: Vec3; slots?: Array<{ id: string; levelId: string; ordinal: number; count: number }> }
const yaw = (q: readonly number[]) => Math.atan2(2 * (q[3]! * q[2]! + q[0]! * q[1]!), 1 - 2 * (q[1]! ** 2 + q[2]! ** 2))
const wrap = (v: number) => Math.atan2(Math.sin(v), Math.cos(v))
const xy = (p: readonly number[]): [number, number] => [p[0]!, p[1]!]
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!)
const norm = (v: unknown) => Array.isArray(v) ? Math.hypot(...v) : Infinity
const wxyz = (q: readonly number[]) => [q[3]!, q[0]!, q[1]!, q[2]!] as const
/** 真实货叉接口组合。规划使用刚体几何；所有插入、承载、放置与退出门槛只消费新鲜引擎观察。 */
export async function transferCargo(sim: SimWorlds, scene: SceneSnapshot, input: CargoTransferInput, signal?: AbortSignal) {
 const settings = { speedMps: input.speedMps ?? .2, carryClearanceM: input.carryClearanceM ?? .25, minimumLiftM: input.minimumLiftM ?? .1, placementToleranceM: input.placementToleranceM ?? .09, maxDurationS: input.maxDurationS ?? 240 }
 if (![settings.speedMps, settings.carryClearanceM, settings.minimumLiftM, settings.placementToleranceM, settings.maxDurationS].every(n => Number.isFinite(n) && n > 0) || settings.maxDurationS > 300) throw new Error('INVALID_ARGUMENT: 有界正SI参数；最多300秒')
 const entity = (id: string): Entity => { const e = scene.entities.find(e => e.entityId === id); if (!e) throw new Error('ENTITY_NOT_FOUND: ' + id); return e }
 const vehicle = entity(input.vehicleId), cargoEntity = entity(input.cargoId), supportEntity = entity(input.supportId), cfg = vehicle.components.controller as any
 const carrier = cfg?.loadCarrier as LoadCarrierProfile, load = cargoEntity.components.loadInterface as LoadInterface, support = supportEntity.components.placementSupport as SupportInterface
 if (cfg?.type !== 'vehicle' || !cfg.steering?.actuators?.length || !cfg.lift?.joint || !carrier?.anchorSite || carrier.tineTipSites?.length < 2) throw new Error('UNSUPPORTED_CAPABILITY: 需要车辆升降与实际载货site映射')
 if (load?.kind !== 'fork_pockets' || !load.halfExtentsM?.every(n => n > 0) || support?.kind !== 'cargo_shelf') throw new Error('UNSUPPORTED_CAPABILITY: 需要货物fork_pockets和支撑cargo_shelf几何')
 const slot = input.slotId ? support.slots?.find(s => s.id === input.slotId) : undefined
 if (input.slotId && !slot) throw new Error('SUPPORT_SLOT_NOT_FOUND: ' + input.slotId)
 if (slot && input.levelId && slot.levelId !== input.levelId) throw new Error('SUPPORT_SLOT_LEVEL_MISMATCH')
 const prefix = input.actionPrefix ?? randomUUID(), actions: ActionReceipt[] = [], phases: any[] = [], observations: Frame[] = [], stops: StopOutcome[] = []
 let externallyStopped = false, entityBusy = false
 // 首帧先核验身份再采用（与 fleet-run 同约定）：换代/换world的首帧不得写成 before/current，据此不派发任何动作或停止。
 const initial = await sim.observe(input.worldId, { contacts: true, sensors: true })
 if (initial.worldId !== input.worldId || initial.generation !== input.expectedGeneration) throw new Error('STALE_GENERATION')
 let current = initial, phase = 'inspect', sequence = 0, liftRequest: number | undefined, activeAction: string | undefined
 const description = await sim.describe(input.worldId, input.vehicleId)
 const steeringJoints = description.joints.filter(j => cfg.steering.actuators.includes(j.actuator)).map(j => j.name)
 const wheelJoints = cfg.wheels.map((wheel: any) => ({ name: description.joints.find(j => j.actuator === wheel.actuator)?.name, radiusM: wheel.radiusM }))
 if (steeringJoints.length !== cfg.steering.actuators.length || wheelJoints.some((wheel: any) => !wheel.name)) throw new Error('DRIVE_TELEMETRY_MAPPING_REQUIRED')
 const before = current, deadline = before.simTime + settings.maxDurationS
 const state = (id: string) => { const e = current.entities.find(e => e.entityId === id); if (!e) throw new Error('ENTITY_NOT_FOUND: ' + id); return e }
 const robot = () => state(input.vehicleId), cargo = () => state(input.cargoId)
 const liftPosition = () => { const joints = robot().joints!, at = joints.names.indexOf(cfg.lift.joint); if (at < 0) throw new Error('LIFT_JOINT_NOT_FOUND'); return joints.positions[at]! }
 const site = (name: string): Site => { const value = (robot().sensors?.sites as Record<string, Site> | undefined)?.[name]; if (!value?.positionM?.every(Number.isFinite)) throw new Error('SITE_TELEMETRY_UNAVAILABLE: ' + name); return value }
 const tips = () => carrier.tineTipSites.map(name => site(name).positionM)
 const anchor = () => site(carrier.anchorSite).positionM
 const contacts = () => ((current as any).contacts ?? []) as Array<{ geom1: string; geom2: string; distanceM: number }>
 const between = (a: string, b: string) => contacts().filter(c => (c.geom1?.startsWith(a + '/') && c.geom2?.startsWith(b + '/')) || (c.geom2?.startsWith(a + '/') && c.geom1?.startsWith(b + '/')))
 const loadGeometry = () => { const c = cargo(); const value = resolveForkPocketInsertion({ objectPositionM: c.transform.position, objectQuaternionWxyz: wxyz(c.transform.quaternion), loadInterface: load, carrier }); if (!value || value.uprightCosine < .9) throw new Error('INVALID_LOAD_INTERFACE_POSE'); return value }
 const engagement = () => { const g = loadGeometry(); return { geometry: g, measurements: measure(g) } }
 const measure = (g: ReturnType<typeof loadGeometry>) => importMeasure({ insertionAxisWorldXY: g.insertionAxisWorldXY, pocketCentersWorldM: g.pocketCentersWorldM, tineTipPositionsM: tips() })
 const read = async () => {
  // 先验证新帧身份再采用：换代帧不得写进 current/observations，否则失败收尾会把错代次帧当成本次最后实际帧（fallback 必须是最后属于本次请求的真实帧）。
  const observed = await sim.observe(input.worldId, { contacts: true, sensors: true })
  if (observed.worldId !== input.worldId || observed.generation !== input.expectedGeneration) throw new Error('STALE_GENERATION')
  current = observed; observations.push(current)
  if ((current as any).executionMode === 'assisted-teleport') throw new Error('ASSISTED_EXECUTION_NOT_PHYSICAL')
  if (signal?.aborted) throw new Error('CANCELLED')
  if (current.simTime >= deadline) throw new Error('CARGO_TRANSFER_TIME_LIMIT')
  return current
 }
 const mark = (name: string, detail?: any) => { phase = name; phases.push({ phase, frameId: current.frameId, stepIndex: current.stepIndex, simTime: current.simTime, cargoPosition: cargo().transform.position, basePosition: robot().transform.position, detail }) }
 const execute = async (motion: Omit<EntityMotion, 'entityId'> | any) => {
  await read(); if (current.simTime + motion.durationS > deadline) throw new Error('CARGO_TRANSFER_TIME_LIMIT')
  const actionId = `${prefix}:${phase}:${++sequence}`; activeAction = actionId
  try { const r = await sim.execute(input.worldId, { ...motion, entityId: input.vehicleId, actionId, expectedGeneration: input.expectedGeneration }, signal); actions.push(r); if (r.status === 'cancelled') externallyStopped = true; if (r.status !== 'completed') throw new Error(r.reason ?? r.status) }
  catch (error) { if ((error as any).code === 'ENTITY_BUSY') entityBusy = true; throw error }
  finally { activeAction = undefined }
  await read()
 }
 const settleDrive = async (angle = 0) => {
  const expected = angle * (cfg.steering.axle === 'rear' ? -1 : 1) * (cfg.steering.sign ?? 1)
  // 零速回执只说明动作结束；轮胎静摩擦下，转向仍需要实际收敛时间。
  for (let i = 0; i < 20; i++) {
   await execute({ kind: 'vehicle', speedMps: 0, steeringAngleRad: angle, durationS: .25 })
   const j = robot().joints!, aligned = steeringJoints.every(name => Math.abs(j.positions[j.names.indexOf(name)]! - expected) <= .01), stopped = wheelJoints.every((wheel: any) => Math.abs(j.velocities![j.names.indexOf(wheel.name)]! * wheel.radiusM) <= .01)
   if (aligned && stopped) return
  }
  throw new Error('STEERING_OR_WHEELS_NOT_SETTLED')
 }
 const hold = (durationS = .4) => execute({ kind: 'vehicle', speedMps: 0, steeringAngleRad: 0, durationS })
 const liftTo = async (name: string, goal: () => number, reached: () => boolean, limit = 7) => {
  mark(name)
  for (let i = 0; i < limit; i++) {
   await read(); if (reached()) return
   const target = goal(), measured = liftPosition(), oldControl = liftRequest ?? measured
   if (!Number.isFinite(target) || target < cfg.lift.rangeM[0] || target > cfg.lift.rangeM[1]) throw new Error('LIFT_TARGET_UNREACHABLE')
   liftRequest = resolveLoadCompensatedLiftControlM({ currentControlM: oldControl, currentLiftM: measured, targetLiftM: target, controlRangeM: cfg.lift.rangeM, maximumCorrectionM: i === 0 ? Math.max(.05, Math.abs(target - measured)) : .05 })!
   await execute({ kind: 'lift', positionM: liftRequest, durationS: 1.5 })
  }
  if (!reached()) throw new Error(name === 'raise-load' ? 'CARGO_NOT_LIFTED' : 'LIFT_ALIGNMENT_NOT_REACHED: ' + name)
 }
 let workingYawOffset = 0, driveSign = 1
 const bodyYawFor = (workingYaw: number) => wrap(workingYaw - workingYawOffset)
 const bounds = input.bounds ?? { min: [Math.min(...current.entities.map(e => e.transform.position[0])) - 3, Math.min(...current.entities.map(e => e.transform.position[1])) - 3] as FleetPoint, max: [Math.max(...current.entities.map(e => e.transform.position[0])) + 3, Math.max(...current.entities.map(e => e.transform.position[1])) + 3] as FleetPoint }
 const obstacles = input.obstacles ?? []
 const navigate = async (name: string, target: FleetPoint, goalBodyYaw: number, options: { loaded?: boolean; path?: FleetPoint[]; toleranceM?: number; headingOnly?: boolean; admitted?: () => boolean } = {}) => {
  await read(); mark(name, { target, goalBodyYaw })
  const start = xy(robot().transform.position), plan = options.path ? { ok: true as const, points: options.path } : planFleetNavigation({ start, goal: target, bounds, obstacles, clearanceM: .7, gridM: .1 })
  if (!plan.ok) throw new Error('PATH_BLOCKED: ' + plan.reason)
  let waypoint = 0, direction: -1 | 0 | 1 = 0, recovery = false, lastProgress = current.simTime, lastPosition = start, bestCost = Infinity, phaseDeadline = current.simTime + 60
  const maxAngle = Math.max(...(cfg.steering.rangeRad ?? [-.55, .55]).map(Math.abs)), radius = cfg.wheelbaseM / Math.tan(maxAngle)
  for (let i = 0; i < 1000; i++) {
   await read(); const p = xy(robot().transform.position), q = robot().transform.quaternion
   if (current.simTime > phaseDeadline) throw new Error('NAVIGATION_PHASE_TIME_LIMIT: ' + name)
   if (options.admitted?.()) { await hold(); return }
   const cost = distance(p, target) + radius * Math.abs(wrap(goalBodyYaw - yaw(q)))
   if (cost < bestCost - .002) { bestCost = cost; lastProgress = current.simTime }
   if (options.headingOnly && Math.abs(wrap(goalBodyYaw - yaw(q))) <= .01) { await hold(); return }
   if (options.loaded && cargo().transform.position[2] - load.halfExtentsM[2] < .04) throw new Error('CARGO_SUPPORT_LOST')
   if (distance(p, lastPosition) > .008) lastPosition = p
   if (current.simTime - lastProgress > 8) throw new Error('NAVIGATION_STALLED: ' + name)
   const step = fleetNavigationStep({ pose: { x: p[0], y: p[1], yaw: yaw(q) }, goal: target, goalYawRad: goalBodyYaw, goalYawToleranceRad: .08, terminalRecoveryYawToleranceRad: .08, path: plan.points, waypointIndex: waypoint, obstacles, clearanceM: .7, speedLimit: 1, headingFeedbackGain: cfg.loadCarrier.navigationFeedbackGain ?? 2, goalToleranceM: options.toleranceM ?? .008, minimumTurningRadiusM: radius, minimumArcForward: .3, curvatureQualifiedPath: Boolean(options.path), activeTravelDirection: direction, terminalRecoveryActive: recovery })
   waypoint = step.waypointIndex; recovery = step.terminalRecoveryActive
   if (step.done) { await hold(); return }
   if (step.needsReplan) throw new Error('PATH_BLOCKED: ' + step.blockedBy)
   const durationS = Math.max(.1, Math.min(.4, step.distanceToGoalM / settings.speedMps / 2))
   if (fleetNeedsDirectionChangeBrake({ activeDirection: direction, requestedForward: step.forward })) { await settleDrive(step.turn * maxAngle); direction = 0; continue }
   direction = step.forward < 0 ? -1 : 1
   await execute({ kind: 'vehicle', speedMps: step.forward * Math.min(settings.speedMps, options.loaded ? .18 : .25), steeringAngleRad: step.turn * maxAngle, durationS })
  }
  throw new Error('NAVIGATION_TIME_LIMIT: ' + name)
 }
 const straight = async (name: string, axis: readonly [number, number], done: () => boolean, speed: number, guard?: () => void, limitS = 25) => {
  mark(name); await settleDrive(); const start = current.simTime, targetYaw = bodyYawFor(Math.atan2(axis[1], axis[0]))
  while (current.simTime - start < limitS) {
   await read(); guard?.(); if (done()) { await hold(); return }
   const error = wrap(targetYaw - yaw(robot().transform.quaternion))
   if (Math.abs(error) > .08) throw new Error('INSERTION_HEADING_CHANGED')
   await execute({ kind: 'vehicle', speedMps: speed * driveSign, steeringAngleRad: Math.max(-.18, Math.min(.18, error * 1.6 * Math.sign(speed * driveSign))), durationS: .15 })
  }
  throw new Error('STRAIGHT_TIME_LIMIT: ' + name)
 }
 const refineStaging = async (name: string, target: FleetPoint, workingYaw: number) => {
  mark(name, { target, workingYaw }); const targetYaw = bodyYawFor(workingYaw), until = current.simTime + 20
  while (Math.abs(wrap(targetYaw - yaw(robot().transform.quaternion))) > .008) {
   if (current.simTime > until) throw new Error('STAGING_HEADING_TIME_LIMIT')
   const error = wrap(targetYaw - yaw(robot().transform.quaternion)), angle = Math.sign(error) * .55
   await settleDrive(angle)
   await execute({ kind: 'vehicle', speedMps: .1, steeringAngleRad: angle, durationS: Math.max(.06, Math.min(.25, Math.abs(error) / (.1 * Math.tan(.55) / cfg.wheelbaseM) * .6)) })
  }
  await settleDrive()
  const axis: [number, number] = [Math.cos(workingYaw), Math.sin(workingYaw)], delta = (target[0] - robot().transform.position[0]) * axis[0] + (target[1] - robot().transform.position[1]) * axis[1]
  if (Math.abs(delta) > .005) await straight(name + '-plane', axis, () => Math.sign(delta) * ((target[0] - robot().transform.position[0]) * axis[0] + (target[1] - robot().transform.position[1]) * axis[1]) <= .005, Math.sign(delta) * .08, undefined, 15)
  if (distance(robot().transform.position, target) > .06 || Math.abs(wrap(targetYaw - yaw(robot().transform.quaternion))) > .01) throw new Error('STAGING_POSE_NOT_REACHED')
 }
 let entered = false, loadVerified = false, insertionAxis: readonly [number, number] | undefined, outcome: any
 try {
  await read(); const world = (await sim.listWorlds()).find(w => w.worldId === input.worldId)
  if (!world || world.sceneId !== scene.sceneId || world.appliedSceneRevision !== scene.revision) throw new Error('SCENE_REVISION_MISMATCH')
  const initialCargo = structuredClone(cargo()), initialAnchor = [...anchor()] as Vec3
  if (between(input.vehicleId, input.cargoId).length) throw new Error('CARGO_ALREADY_IN_CONTACT: 预载货物请继续用原cargo工作流')
  const a = anchor(), b = robot().transform.position, workingYaw = Math.atan2(a[1] - b[1], a[0] - b[0]); workingYawOffset = wrap(workingYaw - yaw(robot().transform.quaternion))
  if (Math.abs(Math.sin(workingYawOffset)) > .1) throw new Error('UNSUPPORTED_CARRIER_DRIVE_AXIS')
  driveSign = Math.cos(workingYawOffset) >= 0 ? 1 : -1
  const insertion = loadGeometry(); insertionAxis = insertion.insertionAxisWorldXY
  const headingDifference = wrap(bodyYawFor(insertion.insertionYawRad) - yaw(robot().transform.quaternion))
  if (Math.abs(headingDifference) >= 5 * Math.PI / 180) {
   const p = robot().transform.position, arc = resolveFleetRelativeTurnArc({ pose: { x: p[0], y: p[1], yaw: yaw(robot().transform.quaternion) }, direction: headingDifference > 0 ? 'left' : 'right', angleDegrees: Math.abs(headingDifference) * 180 / Math.PI, minimumTurningRadiusM: cfg.wheelbaseM / Math.tan(.55) })!
   mark('align-working-heading', { arc })
   const turnDeadline = current.simTime + 15
   while (Math.abs(wrap(arc.targetYawRad - yaw(robot().transform.quaternion))) > .01) {
    if (current.simTime > turnDeadline) throw new Error('HEADING_ALIGNMENT_TIME_LIMIT')
    const error = wrap(arc.targetYawRad - yaw(robot().transform.quaternion)), angle = Math.sign(error) * Math.min(.55, Math.max(.2, Math.abs(error) * 3))
    await execute({ kind: 'vehicle', speedMps: .12, steeringAngleRad: angle, durationS: Math.max(.06, Math.min(.3, Math.abs(error) / (.12 * Math.tan(Math.abs(angle)) / cfg.wheelbaseM) * .65)) })
   }
   await hold()
  }
  const planningBase = robot().transform.position
  // 仅用于规划朝向改变后的刚体位置；后面的插入门槛重新读取实际site，绝不把预测充作传感器。
  const rotation = bodyYawFor(insertion.insertionYawRad) - yaw(robot().transform.quaternion)
  const predictedTips = tips().map(t => { const dx = t[0] - planningBase[0], dy = t[1] - planningBase[1]; return [planningBase[0] + Math.cos(rotation) * dx - Math.sin(rotation) * dy, planningBase[1] + Math.sin(rotation) * dx + Math.cos(rotation) * dy, t[2]] as Vec3 })
  const targets = resolveForkInsertionNavigationTargets({ currentBasePositionM: xy(planningBase), insertionAxisWorldXY: insertionAxis, pocketCentersWorldM: insertion.pocketCentersWorldM, tineTipPositionsM: predictedTips, stagingClearanceM: load.stagingClearanceM })!
  const docking = resolveFleetSteeredDockingRoute({ current: xy(planningBase), nominalStaging: targets.stagingBasePositionM, goalYawRad: bodyYawFor(insertion.insertionYawRad), minimumTurningRadiusM: cfg.wheelbaseM / Math.tan(.55), settlingLeadM: cfg.wheelbaseM / Math.tan(.55), lateralToleranceM: .008 })
  mark('pickup-plan', { targets, docking, initialCargo: initialCargo.transform, currentSites: tips(), slot: slot?.id })
  const pickupPrefix = docking.waypoints[0]!, pickupDelta = (pickupPrefix[0] - robot().transform.position[0]) * insertionAxis[0] + (pickupPrefix[1] - robot().transform.position[1]) * insertionAxis[1]
  if (docking.waypoints.length > 1 && Math.abs(pickupDelta) > .025) await straight('pickup-runway', insertionAxis, () => Math.sign(pickupDelta) * ((pickupPrefix[0] - robot().transform.position[0]) * insertionAxis![0] + (pickupPrefix[1] - robot().transform.position[1]) * insertionAxis![1]) <= .012, Math.sign(pickupDelta) * .12)
  await navigate('pickup-align', docking.staging, bodyYawFor(insertion.insertionYawRad), { path: [xy(robot().transform.position), ...(docking.waypoints.length > 1 ? docking.waypoints.slice(1) : docking.waypoints)], admitted: () => fleetTerminalApproachAlreadyAdmitted({ pose: { x: robot().transform.position[0], y: robot().transform.position[1], yaw: yaw(robot().transform.quaternion) }, staging: targets.stagingBasePositionM, target: targets.insertedBasePositionM, goalYawRad: bodyYawFor(insertion.insertionYawRad) }) })
  await refineStaging('pickup-fine-align', targets.stagingBasePositionM, insertion.insertionYawRad)
  await liftTo('pocket-height', () => { const g = loadGeometry(), r = resolveForkPocketLiftTarget({ pocketCentersWorldM: g.pocketCentersWorldM, tineTipPositionsM: tips(), currentLiftM: liftPosition(), liftRangeM: cfg.lift.rangeM }); if (!r || Math.abs(r.residualM) > .006) throw new Error('POCKET_HEIGHT_UNREACHABLE'); return r.targetM }, () => engagement().measurements.every(m => m && Math.abs(m.vertical_error_m) <= .006))
  const atStart = engagement(), startCargo = structuredClone(cargo().transform.position)
  await straight('insert', atStart.geometry.insertionAxisWorldXY, () => { const m = engagement().measurements; const admitted = admitForkPocketEngagement(m, { minimumAxialDepthM: .045 }); if (admitted.admitted) entered = true; return admitted.admitted }, .08, () => { const now = engagement(), progress = assessForkInsertionProgress({ initialPayloadPositionM: startCargo, currentPayloadPositionM: cargo().transform.position, initialInsertionAxisWorldXY: atStart.geometry.insertionAxisWorldXY, currentInsertionAxisWorldXY: now.geometry.insertionAxisWorldXY, initialMeasurements: atStart.measurements, currentMeasurements: now.measurements }); if (progress.pushed || progress.poseChanged) throw new Error('PAYLOAD_PUSH_OR_POSE_CHANGE'); if (now.measurements.some(m => m && m.axial_depth_m > -.15)) entered = true })
  const insertedCargo = structuredClone(cargo().transform.position), anchorBeforeLift = [...anchor()] as Vec3
  mark('engaged', { measurements: engagement().measurements })
  await liftTo('raise-load', () => { const r = resolvePayloadTransportLiftTargetM({ currentLiftM: liftPosition(), bottomGapM: cargo().transform.position[2] - load.halfExtentsM[2], transportClearanceM: settings.carryClearanceM, liftRangeM: cfg.lift.rangeM }); if (!r || r.residualM > .006) throw new Error('TRANSPORT_HEIGHT_UNREACHABLE'); return r.targetM }, () => cargo().transform.position[2] - load.halfExtentsM[2] >= settings.carryClearanceM - .005)
  const loadResult = evaluateForkliftCargoLoad({ cargoBefore: insertedCargo, cargoAfter: cargo().transform.position, loadSiteBefore: anchorBeforeLift, loadSiteAfter: anchor(), contactObserved: between(input.vehicleId, input.cargoId).length > 0 })
  if (!loadResult.loaded || loadResult.evidence.cargoLiftM < settings.minimumLiftM || between(input.vehicleId, input.cargoId).length === 0) throw new Error('CARGO_NOT_SUPPORTED')
  loadVerified = true; mark('loaded', loadResult)
  const retreatStart = xy(robot().transform.position)
  await straight('withdraw-loaded', insertionAxis, () => (retreatStart[0] - robot().transform.position[0]) * insertionAxis![0] + (retreatStart[1] - robot().transform.position[1]) * insertionAxis![1] >= .25, -.1)
  const payloadOffset = resolvePayloadCenterOffsetInCarrierFrame({ basePositionM: xy(robot().transform.position), carrierAnchorPositionM: xy(anchor()), payloadCenterPositionM: xy(cargo().transform.position), fallbackBaseYawRad: yaw(robot().transform.quaternion) })!
  const assignments = input.supportAssignments ?? [{ vehicleId: input.vehicleId, supportId: input.supportId }]
  const lane = slot ? { ordinal: slot.ordinal, count: slot.count } : resolveCargoShelfPlacementLane({ robotInstanceId: input.vehicleId, supportObject: input.supportId, supportRequestingGoalRobotInstanceIds: assignments.map(a => a.vehicleId), registeredPlacementSupportCount: scene.entities.filter(e => e.components.placementSupport).length, declaredSupportObjectByRobot: new Map(assignments.map(a => [a.vehicleId, a.supportId])) })
  const supportState = state(input.supportId), placement = resolveCargoShelfPlacement({ supportPositionM: supportState.transform.position, supportQuaternionWxyz: wxyz(supportState.transform.quaternion), supportInterface: support, payloadHalfExtentsM: load.halfExtentsM, carrier, payloadCenterOffsetBaseLocalM: payloadOffset, currentLiftM: liftPosition(), currentPayloadBottomM: cargo().transform.position[2] - load.halfExtentsM[2], liftRangeM: cfg.lift.rangeM, requestedLevelID: slot?.levelId ?? input.levelId, placementLane: lane })
  if (!placement) throw new Error('SUPPORT_LEVEL_OR_SLOT_UNREACHABLE')
  const expectedCargoXY: FleetPoint = [placement.placedBasePositionM[0] + placement.approachAxisWorldXY[0] * payloadOffset[0] - placement.approachAxisWorldXY[1] * payloadOffset[1], placement.placedBasePositionM[1] + placement.approachAxisWorldXY[1] * payloadOffset[0] + placement.approachAxisWorldXY[0] * payloadOffset[1]]
  mark('support-slot-plan', { supportId: input.supportId, slotId: slot?.id, placement, expectedCargoXY, carriedEnvelopeM: forkliftCarriedSweptRadius({ base: xy(robot().transform.position), cargo: xy(cargo().transform.position), cargoHalfExtents: load.halfExtentsM, robotRadiusM: .7 }) })
  await liftTo('shelf-clearance', () => liftPosition() + Math.max(0, placement.supportTopM + .04 - (cargo().transform.position[2] - load.halfExtentsM[2])), () => cargo().transform.position[2] - load.halfExtentsM[2] >= placement.supportTopM + .035)
  const route = resolveFleetSteeredDockingRoute({ current: xy(robot().transform.position), nominalStaging: placement.stagingBasePositionM, goalYawRad: bodyYawFor(placement.approachYawRad), minimumTurningRadiusM: cfg.wheelbaseM / Math.tan(.55), settlingLeadM: cfg.wheelbaseM / Math.tan(.55), lateralToleranceM: .015 })
  const supportPrefix = route.waypoints[0]!, supportDelta = (supportPrefix[0] - robot().transform.position[0]) * placement.approachAxisWorldXY[0] + (supportPrefix[1] - robot().transform.position[1]) * placement.approachAxisWorldXY[1]
  if (route.waypoints.length > 1 && Math.abs(supportDelta) > .025) await straight('support-runway', placement.approachAxisWorldXY, () => Math.sign(supportDelta) * ((supportPrefix[0] - robot().transform.position[0]) * placement.approachAxisWorldXY[0] + (supportPrefix[1] - robot().transform.position[1]) * placement.approachAxisWorldXY[1]) <= .012, Math.sign(supportDelta) * .12, () => { if (cargo().transform.position[2] - load.halfExtentsM[2] < .04) throw new Error('CARGO_SUPPORT_LOST') }, 40)
  await navigate('transport-to-slot', route.staging, bodyYawFor(placement.approachYawRad), { loaded: true, path: [xy(robot().transform.position), ...(route.waypoints.length > 1 ? route.waypoints.slice(1) : route.waypoints)], toleranceM: .02 })
  await refineStaging('support-fine-align', placement.stagingBasePositionM, placement.approachYawRad)
  await straight('enter-support', placement.approachAxisWorldXY, () => distance(cargo().transform.position, expectedCargoXY) <= .035, .08, () => { if (cargo().transform.position[2] - load.halfExtentsM[2] < placement.supportTopM + .03) throw new Error('SUPPORT_ENTRY_CLEARANCE_LOST') })
  const supported = () => assessPayloadReleaseSupport({ objectCenterZM: cargo().transform.position[2], objectHalfHeightM: load.halfExtentsM[2], groundZM: placement.supportTopM, supportContactCount: between(input.cargoId, input.supportId).length, linearSpeedMps: norm(cargo().sensors?.bodyLinearVelocityMps), angularSpeedRadps: norm(cargo().sensors?.bodyAngularVelocityRadps) }).supported
  await liftTo('lower-to-support', () => resolvePayloadSupportLiftTargetM({ currentLiftM: liftPosition(), bottomGapM: cargo().transform.position[2] - load.halfExtentsM[2] - placement.supportTopM, liftRangeM: cfg.lift.rangeM })!, supported)
  await liftTo('clear-fork-height', () => resolveForkPocketLiftTarget({ pocketCentersWorldM: loadGeometry().pocketCentersWorldM, tineTipPositionsM: tips(), currentLiftM: liftPosition(), liftRangeM: cfg.lift.rangeM })!.targetM, () => between(input.vehicleId, input.cargoId).length === 0 && engagement().measurements.every(m => m && Math.abs(m.vertical_error_m) <= .006))
  const clearance = () => assessReleasedPayloadForkClearance({ payloadCenterM: cargo().transform.position, payloadHalfExtentsM: load.halfExtentsM, insertionAxisWorldXY: placement.approachAxisWorldXY, tineTipPositionsM: tips() })
  await straight('withdraw-released', placement.approachAxisWorldXY, () => clearance().cleared, -.1)
  await hold(.6); const executionMode = executionModeOf(actions, observations)
  // 任务效果由真实末态判定，但执行模式必须来自明确证据：缺证据为 unknown，不得硬写 physical；成功要求明确物理执行。
  const achieved = executionMode === 'physical-contact' && supported() && between(input.vehicleId, input.cargoId).length === 0 && clearance().cleared && distance(cargo().transform.position, expectedCargoXY) <= settings.placementToleranceM
  mark('complete', { taskAchieved: achieved, clearance: clearance(), supportContacts: between(input.cargoId, input.supportId).length, carrierContacts: between(input.vehicleId, input.cargoId).length })
  outcome = { status: achieved ? 'completed' : 'failed', taskAchieved: achieved, reason: achieved ? undefined : executionMode === 'assisted-teleport' ? 'ASSISTED_EXECUTION_NOT_PHYSICAL' : executionMode === 'unknown' ? 'EXECUTION_MODE_UNKNOWN' : 'FINAL_PLACEMENT_NOT_CONFIRMED', executionMode, source: { sceneId: scene.sceneId, sceneRevision: scene.revision, worldId: input.worldId, generation: input.expectedGeneration }, before, after: current, afterSource: 'fresh', phases, actions, observations, effect: { liftM: loadResult.evidence.cargoLiftM, initialCargoPosition: initialCargo.transform.position, finalCargoPosition: cargo().transform.position, expectedCargoXY, horizontalErrorM: distance(cargo().transform.position, expectedCargoXY), verticalErrorM: Math.abs(cargo().transform.position[2] - load.halfExtentsM[2] - placement.supportTopM), supportId: input.supportId, levelId: placement.levelID, slotId: slot?.id, slotOrdinal: placement.placementLaneOrdinal, supportContactCount: between(input.cargoId, input.supportId).length, carrierContactCount: between(input.vehicleId, input.cargoId).length, clearance: clearance() } }
 } catch (error) {
  const failedPhase = phase, reason = error instanceof Error ? error.message : String(error); let recovery: any
  // 停止带本次 expectedGeneration：世界已换代时由引擎按代次拒绝（绝不去停止新一代动作），拒绝结果同样计入 stops。
  if (actions.length && !entityBusy) stops.push(await confirmStop(sim, input.worldId, { entityIds: [input.vehicleId], expectedGeneration: input.expectedGeneration }))
  if (entered && !loadVerified && insertionAxis && !externallyStopped && !entityBusy && !signal?.aborted && current.generation === input.expectedGeneration && current.simTime + 15 < deadline) {
   try { await straight('failure-retreat', insertionAxis, () => assessReleasedPayloadForkClearance({ payloadCenterM: cargo().transform.position, payloadHalfExtentsM: load.halfExtentsM, insertionAxisWorldXY: insertionAxis!, tineTipPositionsM: tips() }).cleared, -.1, undefined, 15); recovery = { attempted: true, cleared: true } }
   catch (escape) { recovery = { attempted: true, cleared: false, reason: String(escape) } }
  }
  // current 是最后一次经 read() 核对过身份的观测；失败收尾未重新观测，after 来源如实标 last-known。
  outcome = { status: signal?.aborted || externallyStopped ? 'cancelled' : 'failed', taskAchieved: false, reason, failedPhase, recovery, executionMode: executionModeOf(actions, observations), before, after: current, afterSource: 'last-known', phases, actions, observations }
 }
 // 收尾停止（原 finally 语义）：带本次 expectedGeneration；世界已换代时由引擎按代次拒绝，结果如实记录。
 if (activeAction) stops.push(await confirmStop(sim, input.worldId, { actionId: activeAction, entityIds: [input.vehicleId], expectedGeneration: input.expectedGeneration }))
 if (actions.length && !entityBusy) stops.push(await confirmStop(sim, input.worldId, { entityIds: [input.vehicleId], expectedGeneration: input.expectedGeneration }))
 // 成功不能靠吞 stop 错误：收尾停止未被确认时不得继续报告完成任务。
 if (outcome.status === 'completed' && stops.some(stop => !stop.confirmed)) outcome = { ...outcome, status: 'failed', taskAchieved: false, reason: 'STOP_NOT_CONFIRMED' }
 return { ...outcome, stops }
}
import { measureForkPocketEngagement as importMeasure } from './fleet/fleet-load-interface.ts'
