import type { FleetPoint } from "./fleet-path"
type RobotInstanceId = string

export type FleetTimedRouteSegment = {
  segmentId: string
  from: FleetPoint
  to: FleetPoint
  enterAt: number
  exitAt: number
  zoneId?: string
}

export type FleetTrajectoryProposal = {
  proposalId: string
  goalId: string
  robotInstanceId: RobotInstanceId
  worldRevision: string
  segments: FleetTimedRouteSegment[]
  envelopeRadiusM: number
  /** Optional kinematic hint supplied by the qualified actor profile. It is
   * used to shape any approved route; it never selects a model-specific
   * manoeuvre or decides task success. */
  minimumTurningRadiusM?: number
  priority: {
    emergencyRecovery: boolean
    carryingPayload: boolean
    enteredNarrowZone: boolean
    userPriority: number
    waitedSince: number
  }
  waitPoints: FleetPoint[]
  createdAt: number
  expiresAt: number
}

export type FleetHeadOnCoordination = {
  mode: "head_on_avoidance"
  role: "through" | "turning"
  peerRobotInstanceId: RobotInstanceId
  speedScale: number
  lateralOffsetM: number
  /** Centre-to-centre warning distance derived from both safety envelopes and
   * the qualified turning radius. Crossing it activates one local encounter. */
  activationDistanceM: number
}

export type FleetTrajectoryReservation = FleetTrajectoryProposal & {
  reservationId: string
  token: string
  status: "reserved" | "active" | "yield_required" | "released" | "expired"
  negotiationRound: number
  coordination?: FleetHeadOnCoordination
}

export type FleetTrafficDecision =
  | { ok: true; reservation: FleetTrajectoryReservation; revoked?: FleetTrajectoryReservation }
  | {
      ok: false
      reason: "trajectory_conflict" | "deterministic_retreat" | "proposal_invalid"
      conflictWith?: FleetTrajectoryReservation
      negotiationRound: number
      mustStop: true
      retreatTo?: FleetPoint
      message: string
    }

export type FleetTrafficViolation = {
  robotInstanceId: RobotInstanceId
  reservationToken: string
  reason: "reservation_expired" | "world_revision_stale" | "route_deviation" | "safety_envelope_intrusion" | "robot_pose_unavailable"
  message: string
  otherRobotInstanceId?: RobotInstanceId
}

export type FleetRobotTrafficOccupancy = {
  position: FleetPoint | undefined
  envelopeRadiusM: number
}

/** A through vehicle must not reach the meeting point before a steered peer
 * has physically established its approved shoulder arc. This is continuous
 * coordination (both vehicles still move), not a task-success predicate or
 * emergency stop. Once the peer has cleared the centreline, the decision is
 * sticky for the remainder of this reservation. */
export function coordinatedThroughMotion(input: {
  coordination: FleetHeadOnCoordination | undefined
  throughRoute: readonly FleetTimedRouteSegment[]
  peerPoint: FleetPoint | undefined
  peerCleared: boolean
}): { speedScale: number; peerCleared: boolean; peerLateralDistanceM?: number } {
  const coordination = input.coordination
  if (!coordination || coordination.role !== "through" || input.peerCleared) {
    return { speedScale: coordination?.speedScale ?? 1, peerCleared: input.peerCleared }
  }
  if (!input.peerPoint || input.throughRoute.length === 0) {
    return { speedScale: coordinatedThroughCrawlScale(coordination.speedScale), peerCleared: false }
  }
  const peerLateralDistanceM = Math.min(...input.throughRoute.map((segment) =>
    pointSegmentDistance(input.peerPoint!, segment.from, segment.to)))
  const cleared = peerLateralDistanceM >= Math.max(0.35, coordination.lateralOffsetM * 0.65)
  return {
    speedScale: cleared ? coordination.speedScale : coordinatedThroughCrawlScale(coordination.speedScale),
    peerCleared: cleared,
    peerLateralDistanceM,
  }
}

/** Keep the through vehicle visibly rolling while its peer establishes the
 * lateral shoulder. The crawl is derived from the negotiated through speed,
 * so it remains a slowdown rather than an asset-specific wheel command or a
 * near-stop that a high-friction chassis cannot physically sustain. */
export function coordinatedThroughCrawlScale(negotiatedSpeedScale: number) {
  const negotiated = Math.max(0.05, Math.min(1, Number.isFinite(negotiatedSpeedScale) ? negotiatedSpeedScale : 1))
  return Math.min(negotiated, Math.max(0.2, negotiated * 0.3))
}

/** High-frequency local collaboration for an already-authorized route pair.
 * Both vehicles keep their ordinary forward action before the warning band.
 * Entering the band activates one deterministic role exchange; no LLM call or
 * whole-route replan is needed on each physics frame. */
export function coordinatedHeadOnMotion(input: {
  coordination: FleetHeadOnCoordination | undefined
  ownRoute: readonly FleetTimedRouteSegment[]
  selfPoint: FleetPoint
  peerPoint: FleetPoint | undefined
  avoidanceActive: boolean
  avoidanceResolved: boolean
  peerCleared: boolean
}): {
  speedScale: number
  avoidanceActive: boolean
  avoidanceResolved: boolean
  peerCleared: boolean
  peerDistanceM?: number
  peerLateralDistanceM?: number
} {
  const coordination = input.coordination
  if (!coordination) {
    return { speedScale: 1, avoidanceActive: false, avoidanceResolved: false, peerCleared: input.peerCleared }
  }
  if (input.avoidanceResolved) {
    return { speedScale: 1, avoidanceActive: true, avoidanceResolved: true, peerCleared: input.peerCleared }
  }
  const peerDistanceM = input.peerPoint
    ? Math.hypot(input.peerPoint[0] - input.selfPoint[0], input.peerPoint[1] - input.selfPoint[1])
    : undefined
  const avoidanceActive = input.avoidanceActive ||
    (peerDistanceM !== undefined && peerDistanceM <= coordination.activationDistanceM)
  if (!avoidanceActive) {
    return {
      speedScale: 1,
      avoidanceActive: false,
      avoidanceResolved: false,
      peerCleared: false,
      ...(peerDistanceM !== undefined ? { peerDistanceM } : {}),
    }
  }
  if (!input.peerPoint || input.ownRoute.length === 0) {
    return {
      speedScale: coordinatedThroughCrawlScale(coordination.speedScale),
      avoidanceActive: true,
      avoidanceResolved: false,
      peerCleared: input.peerCleared,
      ...(peerDistanceM !== undefined ? { peerDistanceM } : {}),
    }
  }
  const start = input.ownRoute[0]!.from
  const end = input.ownRoute.at(-1)!.to
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const length = Math.max(1e-9, Math.hypot(dx, dy))
  const peerAheadM = ((input.peerPoint[0] - input.selfPoint[0]) * dx +
    (input.peerPoint[1] - input.selfPoint[1]) * dy) / length
  const lateralDistanceM = pointSegmentDistance(input.peerPoint, start, end)
  const peerCleared = input.peerCleared ||
    lateralDistanceM >= Math.max(0.35, coordination.lateralOffsetM * 0.65)
  const passed = peerAheadM <= -Math.max(0.35, coordination.lateralOffsetM * 0.4)
  const avoidanceResolved = passed && (coordination.role === "turning" || peerCleared)
  const speedScale = avoidanceResolved
    ? 1
    : coordination.role === "through" && !peerCleared
      ? coordinatedThroughCrawlScale(coordination.speedScale)
      : coordination.speedScale
  return {
    speedScale,
    avoidanceActive: true,
    avoidanceResolved,
    peerCleared,
    peerDistanceM,
    peerLateralDistanceM: lateralDistanceM,
  }
}

function overlap(a0: number, a1: number, b0: number, b1: number) {
  return Math.max(a0, b0) < Math.min(a1, b1)
}

function pointSegmentDistance(point: FleetPoint, from: FleetPoint, to: FleetPoint) {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const length2 = dx * dx + dy * dy
  if (length2 === 0) return Math.hypot(point[0] - from[0], point[1] - from[1])
  const t = Math.max(0, Math.min(1, ((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / length2))
  return Math.hypot(point[0] - (from[0] + t * dx), point[1] - (from[1] + t * dy))
}

function positionAt(segment: FleetTimedRouteSegment, time: number): FleetPoint {
  const ratio = Math.max(0, Math.min(1, (time - segment.enterAt) / (segment.exitAt - segment.enterAt)))
  return [
    segment.from[0] + (segment.to[0] - segment.from[0]) * ratio,
    segment.from[1] + (segment.to[1] - segment.from[1]) * ratio,
  ]
}

/** Exact closest approach for two constant-velocity timed segments. The old
 * geometric intersection check treated an entire segment as occupied for its
 * whole time window, so two vehicles could not safely pass on curved routes
 * even when they reached the crossing at different times. */
function timedSegmentConflict(a: FleetTimedRouteSegment, b: FleetTimedRouteSegment, clearance: number) {
  const start = Math.max(a.enterAt, b.enterAt)
  const end = Math.min(a.exitAt, b.exitAt)
  if (start >= end) return false
  if (a.zoneId && b.zoneId && a.zoneId === b.zoneId) return true
  const a0 = positionAt(a, start)
  const b0 = positionAt(b, start)
  const duration = end - start
  const aEnd = positionAt(a, end)
  const bEnd = positionAt(b, end)
  const relativePosition: FleetPoint = [a0[0] - b0[0], a0[1] - b0[1]]
  const relativeVelocity: FleetPoint = [
    (aEnd[0] - bEnd[0] - relativePosition[0]) / duration,
    (aEnd[1] - bEnd[1] - relativePosition[1]) / duration,
  ]
  const velocity2 = relativeVelocity[0] ** 2 + relativeVelocity[1] ** 2
  const closestTime = velocity2 <= 1e-18
    ? 0
    : Math.max(0, Math.min(duration,
        -(relativePosition[0] * relativeVelocity[0] + relativePosition[1] * relativeVelocity[1]) / velocity2))
  return Math.hypot(
    relativePosition[0] + relativeVelocity[0] * closestTime,
    relativePosition[1] + relativeVelocity[1] * closestTime,
  ) < clearance
}

function proposalConflict(a: FleetTrajectoryProposal, b: FleetTrajectoryProposal) {
  const clearance = a.envelopeRadiusM + b.envelopeRadiusM
  return a.segments.some((left) => b.segments.some((right) =>
    overlap(left.enterAt, left.exitAt, right.enterAt, right.exitAt) && timedSegmentConflict(left, right, clearance)))
}

function routeDistance(point: FleetPoint, reservation: FleetTrajectoryReservation) {
  return Math.min(...reservation.segments.map((segment) => pointSegmentDistance(point, segment.from, segment.to)))
}

/** A route reservation is a navigable corridor, not a perfect-path validator.
 * A physically steered chassis cuts and overshoots sampled curves while its
 * local controller converges back to the route. Derive a broad lost-route
 * guard from the qualified chassis geometry; robot-to-robot emergency spacing
 * remains the independent, strict stop authority in audit(). */
export function fleetRouteTrackingToleranceM(reservation: Pick<
  FleetTrajectoryReservation,
  "envelopeRadiusM" | "minimumTurningRadiusM" | "coordination"
>) {
  const steeringAllowance = Number.isFinite(reservation.minimumTurningRadiusM)
    ? Math.min(reservation.envelopeRadiusM * 3, Math.max(0, reservation.minimumTurningRadiusM!) * 1.25)
    : 0
  const coordinatedAllowance = reservation.coordination?.role === "turning"
    ? Math.min(reservation.envelopeRadiusM * 3, reservation.coordination.lateralOffsetM)
    : 0
  return reservation.envelopeRadiusM + Math.max(steeringAllowance, coordinatedAllowance)
}

/** Positive means a has deterministic right-of-way over b. */
export function compareFleetTrafficPriority(a: FleetTrajectoryProposal, b: FleetTrajectoryProposal) {
  const fields: Array<[number, number]> = [
    [Number(a.priority.emergencyRecovery), Number(b.priority.emergencyRecovery)],
    [Number(a.priority.carryingPayload), Number(b.priority.carryingPayload)],
    [Number(a.priority.enteredNarrowZone), Number(b.priority.enteredNarrowZone)],
    [a.priority.userPriority, b.priority.userPriority],
    [a.createdAt - a.priority.waitedSince, b.createdAt - b.priority.waitedSince],
  ]
  for (const [left, right] of fields) if (left !== right) return left > right ? 1 : -1
  return a.robotInstanceId === b.robotInstanceId ? 0 : a.robotInstanceId < b.robotInstanceId ? 1 : -1
}

export type FleetTrafficPolicy = {
  headOnAvoidance: {
    enabled: boolean
    extraClearanceM: number
    throughSpeedScale: number
    turningSpeedScale: number
    shoulderStartRatio: number
    shoulderEndRatio: number
  }
}

const DEFAULT_FLEET_TRAFFIC_POLICY: FleetTrafficPolicy = {
  headOnAvoidance: {
    enabled: true,
    extraClearanceM: 0.24,
    throughSpeedScale: 0.65,
    turningSpeedScale: 0.45,
    shoulderStartRatio: 0.22,
    shoulderEndRatio: 0.78,
  },
}

function routeEndpoints(proposal: FleetTrajectoryProposal) {
  return { start: proposal.segments[0]!.from, end: proposal.segments.at(-1)!.to }
}

function isHeadOnPair(incoming: FleetTrajectoryProposal, existing: FleetTrajectoryProposal) {
  const a = routeEndpoints(incoming)
  const b = routeEndpoints(existing)
  const ax = a.end[0] - a.start[0]
  const ay = a.end[1] - a.start[1]
  const bx = b.end[0] - b.start[0]
  const by = b.end[1] - b.start[1]
  const lengths = Math.hypot(ax, ay) * Math.hypot(bx, by)
  if (lengths <= 1e-9 || (ax * bx + ay * by) / lengths > -0.85) return false
  const exclusiveZone = incoming.segments.some((left) => existing.segments.some((right) =>
    left.zoneId && right.zoneId && left.zoneId === right.zoneId))
  if (exclusiveZone) return false
  const endpointBand = incoming.envelopeRadiusM + existing.envelopeRadiusM
  return pointSegmentDistance(a.start, b.start, b.end) <= endpointBand &&
    pointSegmentDistance(a.end, b.start, b.end) <= endpointBand
}

function routeLength(points: readonly FleetPoint[]) {
  let length = 0
  for (let index = 1; index < points.length; index += 1) {
    length += Math.hypot(points[index]![0] - points[index - 1]![0], points[index]![1] - points[index - 1]![1])
  }
  return length
}

function headOnDetour(
  proposal: FleetTrajectoryProposal,
  conflict: FleetTrajectoryReservation,
  policy: FleetTrafficPolicy["headOnAvoidance"],
  input: {
    startAt: number
    side: -1 | 1
    offsetScale: number
    shoulderStartRatio: number
    shoulderEndRatio: number
  },
): FleetTrajectoryProposal & { coordination: FleetHeadOnCoordination } {
  const { start, end } = routeEndpoints(proposal)
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const length = Math.hypot(dx, dy)
  const normal: FleetPoint = [-dy / length, dx / length]
  const lateralOffsetM =
    (proposal.envelopeRadiusM + conflict.envelopeRadiusM + policy.extraClearanceM) * input.offsetScale
  const turningRadiusM = Math.max(0, proposal.minimumTurningRadiusM ?? 0)
  // A raised-cosine ramp has zero lateral slope at both ends. The vehicle first
  // keeps an ordinary straight approach; the remaining centre span is sized
  // from the actor's qualified radius and both safety envelopes. This gives
  // the live warning event a real straight-before-turn boundary.
  const curvatureRampM = turningRadiusM > 0
    ? Math.PI * Math.sqrt(lateralOffsetM * turningRadiusM / 2)
    : length * input.shoulderStartRatio
  const centreClearanceM = proposal.envelopeRadiusM + conflict.envelopeRadiusM
  const activationDistanceM = Math.min(length, Math.max(centreClearanceM, 2 * curvatureRampM + centreClearanceM))
  const straightApproachM = Math.max(0, (length - activationDistanceM) / 2)
  const approachRatio = turningRadiusM > 0
    ? straightApproachM / length
    : Math.min(input.shoulderStartRatio, 0.24)
  const availableRampM = Math.max(0.01, (length - 2 * straightApproachM - centreClearanceM) / 2)
  const rampRatio = Math.min(
    Math.max(0.01, 0.49 - approachRatio),
    Math.max(0.01, Math.min(curvatureRampM, availableRampM) / length),
  )
  const rampEndRatio = approachRatio + rampRatio
  const returnStartRatio = 1 - approachRatio - rampRatio
  const returnEndRatio = 1 - approachRatio
  const sampleSpacingM = turningRadiusM > 0
    ? Math.max(0.12, Math.min(0.3, turningRadiusM * 0.2))
    : 0.24
  const sampleCount = Math.max(8, Math.min(64, Math.ceil(length / sampleSpacingM)))
  const lateralScale = (ratio: number) => {
    if (ratio <= approachRatio) return 0
    if (ratio <= rampEndRatio) {
      const progress = (ratio - approachRatio) / Math.max(1e-6, rampRatio)
      return 0.5 - 0.5 * Math.cos(Math.PI * progress)
    }
    if (ratio >= returnEndRatio) return 0
    if (ratio >= returnStartRatio) {
      const progress = (ratio - returnStartRatio) / Math.max(1e-6, rampRatio)
      return 0.5 + 0.5 * Math.cos(Math.PI * progress)
    }
    return 1
  }
  const points: FleetPoint[] = Array.from({ length: sampleCount + 1 }, (_, index) => {
    const ratio = index / sampleCount
    const offset = lateralOffsetM * input.side * lateralScale(ratio)
    return [
      start[0] + dx * ratio + normal[0] * offset,
      start[1] + dy * ratio + normal[1] * offset,
    ]
  })
  const originalDuration = Math.max(1, proposal.segments.at(-1)!.exitAt - proposal.segments[0]!.enterAt)
  const detourDuration = originalDuration * Math.max(1, routeLength(points) / length) / policy.turningSpeedScale
  const totalLength = routeLength(points)
  let elapsed = 0
  const segments: FleetTimedRouteSegment[] = points.slice(1).map((to, index) => {
    const from = points[index]!
    const segmentLength = Math.hypot(to[0] - from[0], to[1] - from[1])
    const enterAt = input.startAt + elapsed
    elapsed += detourDuration * segmentLength / totalLength
    return {
      segmentId: `${proposal.proposalId}:head-on-${index + 1}`,
      from,
      to,
      enterAt,
      exitAt: input.startAt + elapsed,
    }
  })
  return {
    ...proposal,
    segments,
    expiresAt: Math.max(proposal.expiresAt, segments.at(-1)!.exitAt + 10_000),
    coordination: {
      mode: "head_on_avoidance",
      role: "turning",
      peerRobotInstanceId: conflict.robotInstanceId,
      speedScale: policy.turningSpeedScale,
      lateralOffsetM,
      activationDistanceM,
    },
  }
}

function slowedReservation(
  reservation: FleetTrajectoryReservation,
  speedScale: number,
  startAt: number,
): FleetTrajectoryReservation {
  const scale = Math.max(0.05, Math.min(1, speedScale))
  let cursor = startAt
  const segments = reservation.segments.map((segment) => {
    const duration = (segment.exitAt - segment.enterAt) / scale
    const slowed = { ...segment, enterAt: cursor, exitAt: cursor + duration }
    cursor += duration
    return slowed
  })
  return {
    ...reservation,
    segments,
    expiresAt: Math.max(reservation.expiresAt, cursor + 10_000),
  }
}

export class FleetTrafficManager {
  #reservations = new Map<string, FleetTrajectoryReservation>()
  #byToken = new Map<string, FleetTrajectoryReservation>()
  #negotiations = new Map<string, number>()
  #sequence = 0

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly policy: FleetTrafficPolicy = DEFAULT_FLEET_TRAFFIC_POLICY,
  ) {}

  propose(proposal: FleetTrajectoryProposal): FleetTrafficDecision {
    if (
      proposal.segments.length === 0 ||
      proposal.envelopeRadiusM <= 0 ||
      proposal.expiresAt <= this.now() ||
      proposal.segments.some((segment) => segment.exitAt <= segment.enterAt)
    ) {
      return { ok: false, reason: "proposal_invalid", negotiationRound: 0, mustStop: true, message: "路线提案无效；车辆保持停车。" }
    }
    this.expire()
    const conflict = [...this.#reservations.values()].find((reservation) =>
      reservation.robotInstanceId !== proposal.robotInstanceId &&
      ["reserved", "active"].includes(reservation.status) &&
      (proposalConflict(proposal, reservation) ||
        (this.policy.headOnAvoidance.enabled && isHeadOnPair(proposal, reservation))))
    if (!conflict) return { ok: true, reservation: this.#grant(proposal, 0) }

    const headOnPair = this.policy.headOnAvoidance.enabled && isHeadOnPair(proposal, conflict)
    if (headOnPair) {
      // A late second proposal means the first robot may still be physically
      // waiting at its route start. Rebase both reservations onto one shared
      // coordination epoch instead of pretending the first vehicle has
      // followed an old wall-clock schedule while it was blocked.
      const coordinationStart = Math.max(this.now(), proposal.segments[0]!.enterAt)
      const slowedThrough = slowedReservation(
        conflict,
        this.policy.headOnAvoidance.throughSpeedScale,
        coordinationStart,
      )
      const preferredSide: -1 | 1 = proposal.robotInstanceId.localeCompare(conflict.robotInstanceId) < 0 ? -1 : 1
      const candidates = [
        { side: preferredSide, offsetScale: 1, shoulderStartRatio: this.policy.headOnAvoidance.shoulderStartRatio, shoulderEndRatio: this.policy.headOnAvoidance.shoulderEndRatio },
        { side: preferredSide, offsetScale: 1.3, shoulderStartRatio: 0.12, shoulderEndRatio: 0.88 },
        { side: (preferredSide === 1 ? -1 : 1) as -1 | 1, offsetScale: 1.3, shoulderStartRatio: 0.12, shoulderEndRatio: 0.88 },
      ]
      const detour = candidates
        .map((candidate) => headOnDetour(proposal, slowedThrough, this.policy.headOnAvoidance, {
          startAt: coordinationStart,
          ...candidate,
        }))
        .find((candidate) => !proposalConflict(candidate, slowedThrough))
      if (detour) {
        conflict.segments = slowedThrough.segments
        conflict.expiresAt = slowedThrough.expiresAt
        conflict.coordination = {
          mode: "head_on_avoidance",
          role: "through",
          peerRobotInstanceId: proposal.robotInstanceId,
          speedScale: this.policy.headOnAvoidance.throughSpeedScale,
          lateralOffsetM: detour.coordination.lateralOffsetM,
          activationDistanceM: detour.coordination.activationDistanceM,
        }
        return { ok: true, reservation: this.#grant(detour, conflict.negotiationRound + 1) }
      }
      // An already admitted route must never be revoked merely because a
      // later ordinary head-on proposal could not produce a proven-safe bend.
      // Keep the first vehicle's authority intact and let the newcomer wait
      // and reobserve instead of converting normal avoidance into an abrupt
      // stop for the vehicle that already owns the route.
      const pair = [proposal.robotInstanceId, conflict.robotInstanceId].sort().join(":")
      const round = (this.#negotiations.get(pair) ?? 0) + 1
      this.#negotiations.set(pair, round)
      return {
        ok: false,
        reason: "trajectory_conflict",
        conflictWith: conflict,
        negotiationRound: round,
        mustStop: true,
        message: `${proposal.robotInstanceId} 暂未生成可证明安全的转弯路线；保留 ${conflict.robotInstanceId} 的既有预约并等待重试。`,
      }
    }

    const pair = [proposal.robotInstanceId, conflict.robotInstanceId].sort().join(":")
    const round = (this.#negotiations.get(pair) ?? 0) + 1
    this.#negotiations.set(pair, round)
    // Priority may select between queued routes, but it must never revoke a
    // route whose physical command is already moving. The newcomer waits or
    // retreats while the active owner finishes and releases normally.
    const incomingWins = conflict.status !== "active" && compareFleetTrafficPriority(proposal, conflict) > 0
    // A decision always describes the robot that issued this proposal. Right of
    // way over a merely queued route therefore resolves as a grant to the
    // newcomer plus the reported revocation of the queued holder, on every
    // round: the round counter only escalates the side that keeps losing from
    // waiting in place to a deterministic retreat at its own wait point. The
    // loser is never addressed through the winner's decision.
    if (incomingWins) {
      conflict.status = "yield_required"
      this.#reservations.delete(conflict.reservationId)
      this.#byToken.delete(conflict.token)
      return { ok: true, reservation: this.#grant(proposal, round), revoked: conflict }
    }
    if (round >= 3) {
      return {
        ok: false,
        reason: "deterministic_retreat",
        conflictWith: conflict,
        negotiationRound: round,
        mustStop: true,
        retreatTo: proposal.waitPoints[0],
        message: `协商已达 ${round} 轮；${proposal.robotInstanceId} 必须退到确定性安全等待点。`,
      }
    }
    return {
      ok: false,
      reason: "trajectory_conflict",
      conflictWith: conflict,
      negotiationRound: round,
      mustStop: true,
      message: `${proposal.robotInstanceId} 等待 ${conflict.robotInstanceId} 释放冲突路线。`,
    }
  }

  activate(token: string, worldRevision: string) {
    const reservation = this.#byToken.get(token)
    if (!reservation || reservation.worldRevision !== worldRevision || reservation.expiresAt <= this.now()) return false
    reservation.status = "active"
    return true
  }

  renew(
    token: string,
    input: { robotInstanceId: RobotInstanceId; goalId: string; worldRevision: string },
    minimumExpiresAt: number,
  ) {
    const reservation = this.#byToken.get(token)
    if (
      !reservation ||
      !["reserved", "active"].includes(reservation.status) ||
      reservation.robotInstanceId !== input.robotInstanceId ||
      reservation.goalId !== input.goalId ||
      reservation.worldRevision !== input.worldRevision ||
      reservation.expiresAt <= this.now() ||
      !Number.isFinite(minimumExpiresAt) ||
      minimumExpiresAt <= this.now()
    ) return false
    reservation.expiresAt = Math.max(reservation.expiresAt, minimumExpiresAt)
    return true
  }

  reservation(token: string) {
    const reservation = this.#byToken.get(token)
    return reservation ? structuredClone(reservation) : undefined
  }

  validate(token: string, input: { robotInstanceId: RobotInstanceId; goalId: string; worldRevision: string }) {
    const reservation = this.#byToken.get(token)
    return Boolean(
      reservation &&
      ["reserved", "active"].includes(reservation.status) &&
      reservation.robotInstanceId === input.robotInstanceId &&
      reservation.goalId === input.goalId &&
      reservation.worldRevision === input.worldRevision &&
      reservation.expiresAt > this.now(),
    )
  }

  release(token: string) {
    const reservation = this.#byToken.get(token)
    if (!reservation) return false
    reservation.status = "released"
    this.#byToken.delete(token)
    this.#reservations.delete(reservation.reservationId)
    return true
  }

  expire() {
    const expired: FleetTrajectoryReservation[] = []
    for (const reservation of this.#reservations.values()) {
      if (reservation.expiresAt > this.now()) continue
      reservation.status = "expired"
      this.#reservations.delete(reservation.reservationId)
      this.#byToken.delete(reservation.token)
      expired.push(reservation)
    }
    return expired
  }

  audit(input: {
    worldRevision: string
    positions: Readonly<Record<string, FleetPoint | undefined>>
    occupancies?: Readonly<Record<string, FleetRobotTrafficOccupancy>>
  }): FleetTrafficViolation[] {
    const violations: FleetTrafficViolation[] = []
    for (const expired of this.expire()) {
      violations.push({
        robotInstanceId: expired.robotInstanceId,
        reservationToken: expired.token,
        reason: "reservation_expired",
        message: `${expired.robotInstanceId} 的路线预约已过期，必须停车并重新观察。`,
      })
    }
    const active = [...this.#reservations.values()].filter((reservation) =>
      reservation.status === "reserved" || reservation.status === "active")
    for (const reservation of active) {
      if (reservation.worldRevision !== input.worldRevision) {
        violations.push({
          robotInstanceId: reservation.robotInstanceId,
          reservationToken: reservation.token,
          reason: "world_revision_stale",
          message: `${reservation.robotInstanceId} 的预约属于旧世界版本，必须停车。`,
        })
        this.#invalidate(reservation)
        continue
      }
      const point = input.positions[reservation.robotInstanceId]
      if (!point) {
        violations.push({
          robotInstanceId: reservation.robotInstanceId,
          reservationToken: reservation.token,
          reason: "robot_pose_unavailable",
          message: `${reservation.robotInstanceId} 当前位姿不可确认，必须停车。`,
        })
        this.#invalidate(reservation)
        continue
      }
      if (routeDistance(point, reservation) > fleetRouteTrackingToleranceM(reservation)) {
        violations.push({
          robotInstanceId: reservation.robotInstanceId,
          reservationToken: reservation.token,
          reason: "route_deviation",
          message: `${reservation.robotInstanceId} 已偏离预约路线安全包络，必须停车。`,
        })
        this.#invalidate(reservation)
      }
    }
    const remaining = [...this.#reservations.values()].filter((reservation) =>
      reservation.status === "reserved" || reservation.status === "active")
    for (let leftIndex = 0; leftIndex < remaining.length; leftIndex += 1) {
      const left = remaining[leftIndex]!
      const leftPoint = input.positions[left.robotInstanceId]
      if (!leftPoint) continue
      for (let rightIndex = leftIndex + 1; rightIndex < remaining.length; rightIndex += 1) {
        const right = remaining[rightIndex]!
        const rightPoint = input.positions[right.robotInstanceId]
        if (!rightPoint) continue
        if (Math.hypot(leftPoint[0] - rightPoint[0], leftPoint[1] - rightPoint[1]) >=
          left.envelopeRadiusM + right.envelopeRadiusM) continue
        violations.push(
          {
            robotInstanceId: left.robotInstanceId,
            reservationToken: left.token,
            reason: "safety_envelope_intrusion",
            otherRobotInstanceId: right.robotInstanceId,
            message: `${left.robotInstanceId} 与 ${right.robotInstanceId} 的安全包络发生侵入，双方必须停车。`,
          },
          {
            robotInstanceId: right.robotInstanceId,
            reservationToken: right.token,
            reason: "safety_envelope_intrusion",
            otherRobotInstanceId: left.robotInstanceId,
            message: `${right.robotInstanceId} 与 ${left.robotInstanceId} 的安全包络发生侵入，双方必须停车。`,
          },
        )
        this.#invalidate(left)
        this.#invalidate(right)
      }
    }
    // A route token reserves time and corridor authority; releasing it does
    // not make the physical robot disappear. Audit every still-authorized
    // mover against peers that currently have no live reservation, including
    // completed and parked robots. Only the moving reservation is invalidated
    // because the peer has no motion authority to revoke.
    const reservedRobotIDs = new Set(remaining.map((reservation) => reservation.robotInstanceId))
    for (const reservation of remaining) {
      if (!this.#reservations.has(reservation.reservationId)) continue
      const ownPoint = input.occupancies?.[reservation.robotInstanceId]?.position ??
        input.positions[reservation.robotInstanceId]
      if (!ownPoint) continue
      for (const [peerRobotInstanceId, occupancy] of Object.entries(input.occupancies ?? {})) {
        if (peerRobotInstanceId === reservation.robotInstanceId ||
          reservedRobotIDs.has(peerRobotInstanceId as RobotInstanceId)) continue
        const peerPoint = occupancy.position
        if (!peerPoint) continue
        const peerRadiusM = Number.isFinite(occupancy.envelopeRadiusM)
          ? Math.max(0, occupancy.envelopeRadiusM)
          : 0
        if (Math.hypot(ownPoint[0] - peerPoint[0], ownPoint[1] - peerPoint[1]) >=
          reservation.envelopeRadiusM + peerRadiusM) continue
        violations.push({
          robotInstanceId: reservation.robotInstanceId,
          reservationToken: reservation.token,
          reason: "safety_envelope_intrusion",
          otherRobotInstanceId: peerRobotInstanceId as RobotInstanceId,
          message: `${reservation.robotInstanceId} 与无活动预约的 ${peerRobotInstanceId} 安全包络发生侵入，活动车辆必须停车。`,
        })
        this.#invalidate(reservation)
        break
      }
    }
    return violations
  }

  snapshot() {
    return [...this.#reservations.values()].map((reservation) => ({ ...reservation, segments: reservation.segments.map((segment) => ({ ...segment })) }))
  }

  #grant(proposal: FleetTrajectoryProposal & { coordination?: FleetHeadOnCoordination }, negotiationRound: number) {
    const sequence = ++this.#sequence
    const reservation: FleetTrajectoryReservation = {
      ...proposal,
      reservationId: `fleet_reservation_${sequence}`,
      token: `fleet_route_${sequence}_${proposal.robotInstanceId}`,
      status: "reserved",
      negotiationRound,
    }
    this.#reservations.set(reservation.reservationId, reservation)
    this.#byToken.set(reservation.token, reservation)
    return reservation
  }

  #invalidate(reservation: FleetTrajectoryReservation) {
    reservation.status = "yield_required"
    this.#byToken.delete(reservation.token)
    this.#reservations.delete(reservation.reservationId)
  }
}
