import { randomUUID } from 'node:crypto'
import type { ActionReceipt, Frame } from '../../lyapunov-contracts/src/types.ts'
import type { EntityMotion, SimWorlds } from '../../sim-contract/src/index.ts'
import { planFleetNavigation, fleetNavigationStep, fleetNeedsDirectionChangeBrake } from './fleet/fleet-navigation.ts'
import { FleetTrafficManager, coordinatedHeadOnMotion, type FleetTrajectoryProposal, type FleetHeadOnCoordination } from './fleet/fleet-traffic-manager.ts'
import type { FleetPoint, FleetPathObstacle } from './fleet/fleet-path.ts'
import { confirmStop, executionModeOf, settledObservation, type RequestIdentity, type StopOutcome } from './workflow-evidence.ts'

export interface FleetCargo {
  cargoId: string
  carryLiftM: number
  releaseLiftM: number
  minimumLiftM: number
  expectedPlacement: [number, number, number]
  placementToleranceM: number
  withdrawDurationS: number
  withdrawSpeedMps: number
}
export interface FleetAssignment {
  assignmentId: string
  entityId: string
  goal: FleetPoint
  route?: { points: FleetPoint[]; goalYawRad?: number; curvatureQualifiedPath?: boolean }
  dependsOn?: string[]
  priority?: number
  cargo?: FleetCargo
}
export interface FleetRunInput {
  worldId: string
  expectedGeneration: number
  assignments: FleetAssignment[]
  bounds: { min: FleetPoint; max: FleetPoint }
  obstacles: FleetPathObstacle[]
  clearanceM: number
  speedMps: number
  maxDurationS: number
  toleranceM?: number
  actionPrefix?: string
  trafficMode?: 'serialized' | 'head-on'
}
export interface FleetEvent {
  kind: 'ready' | 'admitted' | 'yield' | 'arrived' | 'cargo-raised' | 'completed' | 'avoidance-active' | 'avoidance-resolved' | 'direction-brake'
  assignmentId: string
  entityId: string
  frameId: string
  stepIndex: number
  simTime: number
  details?: Record<string, unknown>
}
type Job = { input: FleetAssignment; phase: 'queued' | 'navigation' | 'placement' | 'completed'; path: FleetPoint[]; waypoint: number; token?: string; waitFor?: string; controller: any; initialCargo?: Frame['entities'][number]; cargoEffect?: Record<string, unknown>; coordination?: FleetHeadOnCoordination; avoidanceActive?: boolean; avoidanceResolved?: boolean; peerCleared?: boolean; travelDirection?: -1 | 0 | 1 }
const point = (frame: Frame, id: string): FleetPoint => {
  const entity = frame.entities.find(e => e.entityId === id)
  if (!entity) throw new Error(`ENTITY_NOT_FOUND: ${id}`)
  return [entity.transform.position[0], entity.transform.position[1]]
}
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1])
function pointToSegment(p: FleetPoint, a: FleetPoint, b: FleetPoint) {
  const dx = b[0] - a[0], dy = b[1] - a[1], d2 = dx * dx + dy * dy
  const t = d2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / d2))
  return distance(p, [a[0] + t * dx, a[1] + t * dy])
}
function segmentsDistance(a: FleetPoint, b: FleetPoint, c: FleetPoint, d: FleetPoint) {
  const cross = (p: FleetPoint, q: FleetPoint, r: FleetPoint) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0
  return Math.min(pointToSegment(a, c, d), pointToSegment(b, c, d), pointToSegment(c, a, b), pointToSegment(d, a, b))
}
/** 交叉走廊保守串行。许可只活在本次调用；时间预测不冒充车辆已通过。 */
function sharedCorridor(a: FleetPoint[], b: FleetPoint[], clearanceM: number) {
  return a.slice(1).some((end, i) => b.slice(1).some((other, j) => segmentsDistance(a[i]!, end, b[j]!, other) < clearanceM * 2))
}
function validate(input: FleetRunInput) {
  if (!input.worldId || !Number.isInteger(input.expectedGeneration) || input.expectedGeneration < 1 || !input.assignments?.length || input.assignments.length > 32) throw new Error('INVALID_ARGUMENT: world/generation/assignments')
  if (![input.clearanceM, input.speedMps, input.maxDurationS].every(n => Number.isFinite(n) && n > 0) || input.maxDurationS > 300) throw new Error('INVALID_ARGUMENT: 正SI参数，maxDurationS <= 300')
  if (input.trafficMode !== undefined && !['serialized','head-on'].includes(input.trafficMode)) throw new Error('INVALID_ARGUMENT: trafficMode')
  if (input.trafficMode === 'head-on' && (input.assignments.length !== 2 || input.assignments.some(a => a.dependsOn?.length))) throw new Error('INVALID_ARGUMENT: 对向协作需要两个同时执行的分工')
  const ids = new Set(input.assignments.map(a => a.assignmentId)), entities = new Set(input.assignments.map(a => a.entityId)), cargoIds = input.assignments.flatMap(a => a.cargo ? [a.cargo.cargoId] : [])
  if (ids.size !== input.assignments.length || entities.size !== input.assignments.length || new Set(cargoIds).size !== cargoIds.length) throw new Error('INVALID_ARGUMENT: 分工、机器人与货物不得重复')
  const complete = new Set<string>()
  for (let i = 0; i < input.assignments.length; i++) for (const a of input.assignments) if ((a.dependsOn ?? []).every(id => complete.has(id))) complete.add(a.assignmentId)
  if (complete.size !== ids.size) throw new Error('INVALID_ARGUMENT: 未知依赖或依赖环')
  for (const a of input.assignments) {
    if (!a.assignmentId || !a.entityId || a.goal.length !== 2 || !a.goal.every(Number.isFinite)) throw new Error('INVALID_ARGUMENT: 分工ID/坐标')
    const c = a.cargo
    if (c && (!c.cargoId || ![c.carryLiftM, c.releaseLiftM, c.minimumLiftM, c.placementToleranceM, c.withdrawDurationS, c.withdrawSpeedMps, ...c.expectedPlacement].every(Number.isFinite) || c.minimumLiftM <= 0 || c.placementToleranceM <= 0 || c.withdrawDurationS <= 0 || c.withdrawSpeedMps <= 0)) throw new Error('INVALID_ARGUMENT: cargo参数')
  }
}
/** 有界Fleet组合；分工由DSH调用者给定，唯一sim owner负责控制与排时。货物必须已真实位于货叉上。 */
export async function runFleet(sim: SimWorlds, input: FleetRunInput, signal?: AbortSignal, onReceipt?: (receipt: ActionReceipt) => void) {
  validate(input)
  const before = await sim.observe(input.worldId, { contacts: true })
  const identity: RequestIdentity = { worldId: input.worldId, generation: input.expectedGeneration }
  if (before.worldId !== identity.worldId || before.generation !== identity.generation) throw new Error('STALE_GENERATION')
  const frames: Frame[] = [before]
  if ((before as any).executionMode === 'assisted-teleport') throw new Error('ASSISTED_EXECUTION_NOT_PHYSICAL')
  const prefix = input.actionPrefix ?? randomUUID(), actions: ActionReceipt[] = [], events: FleetEvent[] = [], samples: Array<{ frameId: string; stepIndex: number; simTime: number; positions: Record<string, FleetPoint>; minSeparationM: number }> = [], stopOutcomes: StopOutcome[] = []
  let current = before, sequence = 0, activeAction: string | undefined
  const deadline = before.simTime + input.maxDurationS
  const traffic = new FleetTrafficManager(() => current.simTime * 1000, { headOnAvoidance: { enabled: input.trafficMode === 'head-on', extraClearanceM: .24, throughSpeedScale: .65, turningSpeedScale: .45, shoulderStartRatio: .22, shoulderEndRatio: .78 } })
  const jobs: Job[] = await Promise.all(input.assignments.map(async assignment => {
    const description = await sim.describe(input.worldId, assignment.entityId)
    if (description.controller?.type !== 'vehicle') throw new Error(`UNSUPPORTED_CAPABILITY: ${assignment.entityId} 缺少SI车辆配置`)
    point(before, assignment.entityId)
    return { input: assignment, phase: 'queued', path: [], waypoint: 0, controller: description.controller, initialCargo: assignment.cargo ? before.entities.find(e => e.entityId === assignment.cargo!.cargoId) : undefined } as Job
  }))
  for (const job of jobs) if (job.input.cargo && !job.initialCargo) throw new Error(`ENTITY_NOT_FOUND: ${job.input.cargo.cargoId}`)
  const proposal = (j: Job): FleetTrajectoryProposal => {
    let time = current.simTime * 1000
    const maxSteering = j.controller.steering ? Math.max(...(j.controller.steering.rangeRad ?? [-.55, .55]).map((r: number) => Math.abs(r))) : undefined
    return { proposalId: `${prefix}:${j.input.assignmentId}`, goalId: j.input.assignmentId, robotInstanceId: j.input.entityId, worldRevision: String(input.expectedGeneration), envelopeRadiusM: input.clearanceM, minimumTurningRadiusM: input.trafficMode === 'head-on' && maxSteering ? j.controller.wheelbaseM / Math.tan(maxSteering) : undefined, createdAt: time, expiresAt: deadline * 1000, waitPoints: [point(current, j.input.entityId)], priority: { emergencyRecovery: false, carryingPayload: !!j.input.cargo, enteredNarrowZone: false, userPriority: j.input.priority ?? 0, waitedSince: before.simTime * 1000 }, segments: j.path.slice(1).map((to, i) => { const enterAt = time; time += Math.max(1, distance(j.path[i]!, to) / input.speedMps * 1000); return { segmentId: String(i), from: j.path[i]!, to, enterAt, exitAt: time } }) }
  }
  const validatePath = (path: FleetPoint[]) => {
    if (path.some(p => p.length !== 2 || !p.every(Number.isFinite) || p[0] < input.bounds.min[0] || p[0] > input.bounds.max[0] || p[1] < input.bounds.min[1] || p[1] > input.bounds.max[1]) || path.slice(1).some((p, i) => input.obstacles.some(o => pointToSegment(o.center, path[i]!, p) < o.radiusM + input.clearanceM))) throw new Error('INVALID_ROUTE: 路线越界或穿过障碍包络')
  }
  const mark = (job: Job, kind: FleetEvent['kind'], details?: FleetEvent['details']) => events.push({ kind, assignmentId: job.input.assignmentId, entityId: job.input.entityId, frameId: current.frameId, stepIndex: current.stepIndex, simTime: current.simTime, details })
  const hold = (job: Job, durationS: number): EntityMotion => ({ kind: 'vehicle', entityId: job.input.entityId, speedMps: 0, ...(job.controller.steering ? { steeringAngleRad: 0 } : { yawRateRadps: 0 }), durationS })
  const refresh = async () => {
    // 先验证新帧身份再采用：换代帧不得写进 current，否则失败收尾会把错代次帧当成本次最后实际帧（fallback 必须是最后属于本次请求的真实帧）。
    const observed = await sim.observe(input.worldId, { contacts: true })
    if (observed.worldId !== identity.worldId || observed.generation !== identity.generation) throw new Error('STALE_GENERATION')
    current = observed
    frames.push(current)
    if ((current as any).executionMode === 'assisted-teleport') throw new Error('ASSISTED_EXECUTION_NOT_PHYSICAL')
    if (signal?.aborted) throw new Error('CANCELLED')
    if (current.simTime > deadline) throw new Error('FLEET_TIME_LIMIT')
    const positions = Object.fromEntries(jobs.map(j => [j.input.entityId, point(current, j.input.entityId)]))
    let minSeparationM = Infinity
    for (let i = 0; i < jobs.length; i++) for (let k = i + 1; k < jobs.length; k++) minSeparationM = Math.min(minSeparationM, distance(positions[jobs[i]!.input.entityId]!, positions[jobs[k]!.input.entityId]!))
    samples.push({ frameId: current.frameId, stepIndex: current.stepIndex, simTime: current.simTime, positions, minSeparationM })
    const violations = traffic.audit({ worldRevision: String(input.expectedGeneration), positions, occupancies: Object.fromEntries(jobs.map(j => [j.input.entityId, { position: positions[j.input.entityId], envelopeRadiusM: input.clearanceM }])) })
    if (violations.length) throw new Error('TRAFFIC_VIOLATION: ' + JSON.stringify(violations))
    for (const j of jobs) if (j.phase === 'navigation' && j.cargoEffect && j.input.cargo) {
      const cargo = current.entities.find(e => e.entityId === j.input.cargo!.cargoId)
      if (!cargo || cargo.transform.position[2] - j.initialCargo!.transform.position[2] < j.input.cargo.minimumLiftM) throw new Error(`CARGO_SUPPORT_LOST: ${j.input.cargo.cargoId}`)
    }
  }
  const batch = async (motions: EntityMotion[], durationS: number) => {
    await refresh()
    if (current.simTime + durationS > deadline) throw new Error('FLEET_TIME_LIMIT')
    const selected = new Map(motions.map(m => [m.entityId, m]))
    const actionId = `${prefix}-${++sequence}`
    activeAction = actionId
    try {
      const receipt = await sim.execute(input.worldId, { kind: 'batch', actionId, expectedGeneration: input.expectedGeneration, motions: jobs.map(j => selected.get(j.input.entityId) ?? hold(j, durationS)) }, signal)
      actions.push(receipt); onReceipt?.(receipt)
      if (receipt.status !== 'completed') throw new Error(receipt.reason ?? receipt.status)
    } catch (error) { stopOutcomes.push(await confirmStop(sim, input.worldId, { actionId, expectedGeneration: identity.generation })); throw error } finally { activeAction = undefined }
    await refresh()
  }
  try {
    while (jobs.some(j => j.phase !== 'completed')) {
      await refresh()
      const ready = jobs.filter(j => j.phase === 'queued' && (j.input.dependsOn ?? []).every(id => jobs.find(other => other.input.assignmentId === id)?.phase === 'completed'))
      if (ready.length) {
        for (const j of ready) {
          const plan = planFleetNavigation({ start: point(current, j.input.entityId), goal: j.input.goal, bounds: input.bounds, obstacles: input.obstacles, clearanceM: input.clearanceM, gridM: .1 })
          if (!plan.ok) throw new Error(`PATH_BLOCKED: ${j.input.assignmentId} ${plan.reason}`)
          j.path = j.input.route?.points ?? plan.points
          if (j.path.length < 2 || distance(j.path[0]!, point(current, j.input.entityId)) > (input.toleranceM ?? .06) || distance(j.path.at(-1)!, j.input.goal) > (input.toleranceM ?? .06)) throw new Error('INVALID_ROUTE: 起点/终点必须匹配当前位姿与目标')
          validatePath(j.path)
          j.phase = 'navigation'; mark(j, 'ready', { path: j.path })
        }
        const loading = ready.filter(j => j.input.cargo)
        if (loading.length) {
          await batch(loading.map(j => ({ kind: 'lift', entityId: j.input.entityId, positionM: j.input.cargo!.carryLiftM, durationS: 2 })), 2)
          for (const j of loading) {
            const cargo = current.entities.find(e => e.entityId === j.input.cargo!.cargoId)!
            const liftM = cargo.transform.position[2] - j.initialCargo!.transform.position[2]
            const contacts = ((current as any).contacts ?? []).filter((c: any) => [c.geom1, c.geom2].some((g: string) => g.startsWith(j.input.cargo!.cargoId + '/')) && [c.geom1, c.geom2].some((g: string) => g.startsWith(j.input.entityId + '/')))
            if (liftM < j.input.cargo!.minimumLiftM || contacts.length === 0) throw new Error(`CARGO_NOT_SUPPORTED: ${j.input.cargo!.cargoId}`)
            j.cargoEffect = { liftM, carrierContactsAtLift: contacts.length }; mark(j, 'cargo-raised', j.cargoEffect)
          }
        }
      }
      if (input.trafficMode === 'head-on' && ready.length) {
        const pair = [...ready].sort((a, b) => (b.input.priority ?? 0) - (a.input.priority ?? 0) || a.input.entityId.localeCompare(b.input.entityId))
        for (const j of pair) {
          const decision = traffic.propose(proposal(j))
          if (!decision.ok) throw new Error('HEAD_ON_NEGOTIATION_FAILED: ' + decision.reason)
          j.token = decision.reservation.token
        }
        // 第二个提案会更新第一个的让行角色；两份最终预约须一起读取后才开始写目标。
        for (const j of pair) {
          const reservation = traffic.reservation(j.token!)!
          if (!reservation.coordination) throw new Error('HEAD_ON_PAIR_REQUIRED')
          j.path = [reservation.segments[0]!.from, ...reservation.segments.map(segment => segment.to)]
          validatePath(j.path); j.coordination = reservation.coordination
          traffic.activate(j.token!, String(input.expectedGeneration)); mark(j, 'admitted', { reservation })
        }
      }
      const placing = jobs.filter(j => j.phase === 'placement')
      if (placing.length) {
        await batch(placing.map(j => ({ kind: 'lift', entityId: j.input.entityId, positionM: j.input.cargo!.releaseLiftM, durationS: 2 })), 2)
        await batch(placing.map(j => ({ ...hold(j, j.input.cargo!.withdrawDurationS), speedMps: -j.input.cargo!.withdrawSpeedMps } as EntityMotion)), Math.max(...placing.map(j => j.input.cargo!.withdrawDurationS)))
        for (const j of placing) {
          const cfg = j.input.cargo!, cargo = current.entities.find(e => e.entityId === cfg.cargoId)!, p = cargo.transform.position
          const contacts = ((current as any).contacts ?? []).filter((c: any) => [c.geom1, c.geom2].some((g: string) => g.startsWith(cfg.cargoId + '/')))
          const carrier = contacts.filter((c: any) => [c.geom1, c.geom2].some((g: string) => g.startsWith(j.input.entityId + '/')))
          const support = contacts.filter((c: any) => !carrier.includes(c))
          const horizontalErrorM = distance(p, cfg.expectedPlacement), verticalErrorM = Math.abs(p[2] - cfg.expectedPlacement[2])
          j.cargoEffect = { ...j.cargoEffect, finalPosition: p, horizontalErrorM, verticalErrorM, supportContactCount: support.length, carrierContactCount: carrier.length }
          if (horizontalErrorM > cfg.placementToleranceM || verticalErrorM > cfg.placementToleranceM || support.length === 0 || carrier.length !== 0) throw new Error(`CARGO_PLACEMENT_FAILED: ${cfg.cargoId}`)
          if (j.token) traffic.release(j.token)
          j.token = undefined; j.phase = 'completed'; mark(j, 'completed', j.cargoEffect)
        }
        continue
      }
      const movers = jobs.filter(j => j.phase === 'navigation').sort((a, b) => (b.input.priority ?? 0) - (a.input.priority ?? 0) || input.assignments.indexOf(a.input) - input.assignments.indexOf(b.input))
      const motionDurationS = Math.max(.1, Math.min(.5, ...movers.map(j => distance(point(current, j.input.entityId), j.input.goal) / input.speedMps / 2)))
      const motions: EntityMotion[] = []
      for (const j of movers) {
        if (!j.token) {
          const conflict = jobs.find(other => other !== j && other.token && sharedCorridor(j.path, other.path, input.clearanceM))
          if (conflict) {
            if (j.waitFor !== conflict.input.assignmentId) mark(j, 'yield', { conflictWith: conflict.input.assignmentId, reason: 'shared_corridor', position: point(current, j.input.entityId) })
            j.waitFor = conflict.input.assignmentId; continue
          }
          const decision = traffic.propose(proposal(j))
          if (!decision.ok) { if (!j.waitFor) mark(j, 'yield', { reason: decision.reason }); j.waitFor = decision.reason; continue }
          j.token = decision.reservation.token; j.waitFor = undefined
          traffic.activate(j.token, String(input.expectedGeneration)); mark(j, 'admitted', { reservation: decision.reservation })
        }
        const reservation = traffic.reservation(j.token!)!
        const peer = j.coordination ? point(current, j.coordination.peerRobotInstanceId) : undefined
        const coordinated = coordinatedHeadOnMotion({ coordination: j.coordination, ownRoute: reservation.segments, selfPoint: point(current, j.input.entityId), peerPoint: peer, avoidanceActive: j.avoidanceActive ?? false, avoidanceResolved: j.avoidanceResolved ?? false, peerCleared: j.peerCleared ?? false })
        if (coordinated.avoidanceActive && !j.avoidanceActive) mark(j, 'avoidance-active', { ...coordinated, role: j.coordination!.role })
        if (coordinated.avoidanceResolved && !j.avoidanceResolved) mark(j, 'avoidance-resolved', { ...coordinated, role: j.coordination!.role })
        j.avoidanceActive = coordinated.avoidanceActive; j.avoidanceResolved = coordinated.avoidanceResolved; j.peerCleared = coordinated.peerCleared
        const end = j.path.at(-1)!, previous = j.path.at(-2)!
        const goalYawRad = j.input.route?.goalYawRad ?? (j.coordination ? Math.atan2(end[1] - previous[1], end[0] - previous[0]) : undefined)
        const state = current.entities.find(e => e.entityId === j.input.entityId)!, [x, y, z, w] = state.transform.quaternion
        const step = fleetNavigationStep({ pose: { x: state.transform.position[0], y: state.transform.position[1], yaw: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) }, goal: j.input.goal, path: j.path, waypointIndex: j.waypoint, obstacles: input.obstacles, clearanceM: input.clearanceM, speedLimit: coordinated.speedScale, goalToleranceM: input.toleranceM ?? .06, minimumTurningRadiusM: j.controller.steering ? j.controller.wheelbaseM / Math.tan(.55) : undefined, minimumArcForward: .3, goalYawRad, curvatureQualifiedPath: j.coordination?.role === 'turning' || j.input.route?.curvatureQualifiedPath, activeTravelDirection: j.travelDirection, forwardOnly: Boolean(j.coordination && !j.avoidanceResolved) })
        j.waypoint = step.waypointIndex
        if (step.done) {
          mark(j, 'arrived', { position: point(current, j.input.entityId), goalErrorM: distance(point(current, j.input.entityId), j.input.goal) })
          if (j.input.cargo) j.phase = 'placement'
          else { traffic.release(j.token!); j.token = undefined; j.phase = 'completed'; mark(j, 'completed') }
          continue
        }
        if (step.needsReplan) throw new Error(`PATH_BLOCKED: ${step.blockedBy}`)
        if (fleetNeedsDirectionChangeBrake({ activeDirection: j.travelDirection ?? 0, requestedForward: step.forward })) { motions.push(hold(j, motionDurationS)); j.travelDirection = 0; mark(j, 'direction-brake'); continue }
        j.travelDirection = step.forward < -.001 ? -1 : step.forward > .001 ? 1 : 0
        motions.push({ kind: 'vehicle', entityId: j.input.entityId, speedMps: step.forward * input.speedMps, ...(j.controller.steering ? { steeringAngleRad: step.turn * (j.controller.steering.rangeRad?.[1] ?? .55) } : { yawRateRadps: step.turn }), durationS: motionDurationS })
      }
      if (jobs.some(j => j.phase === 'placement')) continue
      if (jobs.every(j => j.phase === 'completed')) break
      await batch(motions, motionDurationS)
    }
    // 执行模式只能由帧/回执证据推导：缺证据为 unknown，绝不硬写 physical；成功同样要求明确物理证据。
    const executionMode = executionModeOf(actions, frames)
    const achieved = executionMode === 'physical-contact'
    return { status: achieved ? 'completed' : 'failed', taskAchieved: achieved, reason: achieved ? undefined : executionMode === 'assisted-teleport' ? 'ASSISTED_EXECUTION_NOT_PHYSICAL' : 'EXECUTION_MODE_UNKNOWN', executionMode, before, after: current, afterSource: 'fresh', assignments: jobs.map(j => ({ ...j.input, status: j.phase, path: j.path, cargoEffect: j.cargoEffect })), events, samples, actions, stops: stopOutcomes }
  } catch (error) {
    // 异常追加观测同样核对本次身份；取不到新观测就退回最后实际帧并注明来源，不冒充新 after。
    const settled = await settledObservation(sim, input.worldId, identity, current, { contacts: true })
    return { status: signal?.aborted ? 'cancelled' : 'failed', taskAchieved: false, reason: error instanceof Error ? error.message : String(error), executionMode: executionModeOf(actions, frames), before, after: settled.after, afterSource: settled.afterSource, ...(settled.observationError ? { observationError: settled.observationError } : {}), assignments: jobs.map(j => ({ ...j.input, status: j.phase, path: j.path, cargoEffect: j.cargoEffect })), events, samples, actions, stops: stopOutcomes }
  } finally {
    if (activeAction) stopOutcomes.push(await confirmStop(sim, input.worldId, { actionId: activeAction, expectedGeneration: identity.generation }))
    for (const j of jobs) if (j.token) traffic.release(j.token)
  }
}
