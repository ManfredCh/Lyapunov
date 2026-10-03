import { planFleetPath, type FleetPathObstacle, type FleetPoint } from "./fleet-path"
import { FORK_INSERTION_TERMINAL_TOLERANCE_M } from "./fleet-load-interface"

export interface FleetNavigationRequest {
  start: FleetPoint
  goal: FleetPoint
  bounds: { min: FleetPoint; max: FleetPoint }
  obstacles: readonly FleetPathObstacle[]
  clearanceM: number
  startClearanceM?: number
  gridM?: number
}

export interface FleetNavigationPose {
  x: number
  y: number
  yaw: number
}

/** A peer obstacle is expressed in the moving robot's centre frame. Include
 * both qualified body envelopes here; the caller's ordinary route margin is
 * added separately by A* and the live follower. */
export function fleetPeerRobotObstacleRadiusM(selfRadiusM: number, peerRadiusM: number) {
  const finiteRadius = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0
  return finiteRadius(selfRadiusM) + finiteRadius(peerRadiusM)
}

/** Keep narrow load-pocket staging strict while allowing a registered shelf
 * lane to use the same finite lateral window already checked at placement. */
export function fleetTerminalApproachStagingLateralToleranceM(
  terminalPlacementWindow?: { maximumLateralErrorM: number },
) {
  const placementToleranceM = terminalPlacementWindow &&
    Number.isFinite(terminalPlacementWindow.maximumLateralErrorM)
    ? Math.max(0, terminalPlacementWindow.maximumLateralErrorM)
    : 0
  return Math.max(0.05, placementToleranceM)
}

/** Resolve a nonholonomic rolling turn from live chassis geometry. This is a
 * physical Host primitive: the caller supplies semantic direction/angle, and
 * the qualified minimum radius determines the world-frame arc and yaw. */
export function resolveFleetRelativeTurnArc(input: {
  pose: FleetNavigationPose
  direction: "left" | "right"
  angleDegrees: number
  minimumTurningRadiusM: number
}) {
  if (!Number.isFinite(input.angleDegrees) || !Number.isFinite(input.minimumTurningRadiusM) ||
    input.angleDegrees < 5 || input.angleDegrees > 180 || input.minimumTurningRadiusM <= 0) return null
  const signedAngleRad = input.angleDegrees * Math.PI / 180 * (input.direction === "left" ? 1 : -1)
  const sampleCount = Math.max(2, Math.ceil(Math.abs(signedAngleRad) / (5 * Math.PI / 180)))
  const waypoints: FleetPoint[] = []
  for (let index = 1; index <= sampleCount; index += 1) {
    const angle = signedAngleRad * index / sampleCount
    const localForwardM = input.minimumTurningRadiusM * Math.sin(Math.abs(angle))
    const localLeftM = Math.sign(angle) * input.minimumTurningRadiusM * (1 - Math.cos(Math.abs(angle)))
    waypoints.push([
      input.pose.x + Math.cos(input.pose.yaw) * localForwardM - Math.sin(input.pose.yaw) * localLeftM,
      input.pose.y + Math.sin(input.pose.yaw) * localForwardM + Math.cos(input.pose.yaw) * localLeftM,
    ])
  }
  return {
    target: waypoints.at(-1)!,
    targetYawRad: Math.atan2(
      Math.sin(input.pose.yaw + signedAngleRad),
      Math.cos(input.pose.yaw + signedAngleRad),
    ),
    waypoints,
  }
}

/** Converts the reservation's already-coordinated schedule back to the
 * uncoordinated semantic speed. The live follower applies the current traffic
 * scale exactly once, including its temporary crawl while a peer turns away. */
export function fleetNavigationBaseSpeedLimit(input: {
  scheduledSpeed: number
  coordinationSpeedScale?: number
  requestedSpeedLimit?: number
}) {
  if (Number.isFinite(input.requestedSpeedLimit)) {
    return clamp(input.requestedSpeedLimit!, 0.05, 0.8)
  }
  const coordinationScale = Number.isFinite(input.coordinationSpeedScale)
    ? clamp(input.coordinationSpeedScale!, 0.05, 1)
    : 1
  return clamp(input.scheduledSpeed / coordinationScale, 0.05, 0.8)
}

/** Convert a traffic-layer schedule into a wall-clock estimate for the
 * physical follower. A strict terminal pose with sampled curvature has more
 * work than traversing the same polyline as an ordinary point destination:
 * the steered chassis must visit the changing tangents and settle its yaw
 * before the contact-sensitive straight segment. The registered route shape,
 * rather than a robot/task name, supplies that bounded complexity. */
export function fleetNavigationPhysicalDurationMs(input: {
  scheduledDurationMs: number
  terminalPoseRequired?: boolean
  terminalApproachWaypointCount?: number
}) {
  const scheduledDurationMs = Number.isFinite(input.scheduledDurationMs)
    ? Math.max(0, input.scheduledDurationMs)
    : 0
  if (!input.terminalPoseRequired) return scheduledDurationMs
  const waypointCount = Number.isFinite(input.terminalApproachWaypointCount)
    ? Math.max(0, Math.floor(input.terminalApproachWaypointCount!))
    : 0
  // A one-point straight approach needs only the ordinary finite window. Each
  // additional curvature sample contributes diminishing settling overhead;
  // the command's existing four-minute ceiling remains the absolute bound.
  const curvatureScale = 1 + Math.sqrt(Math.max(0, waypointCount - 1))
  return scheduledDurationMs * Math.max(1, curvatureScale)
}

/** A route owns a finite deadline, but a curved/slow approved reservation must
 * not inherit the old fixed 60 s wall. Use its scheduled duration with enough
 * physical settling margin, bounded by the Desktop command ceiling. */
export function fleetNavigationTimeoutMs(expectedDurationMs: number) {
  const expected = Number.isFinite(expectedDurationMs) ? Math.max(0, expectedDurationMs) : 0
  // Imported wheel speed/asset scale can make a valid low-speed docking route
  // several times slower than its semantic traffic schedule. Preserve a
  // finite two-minute physical window; live progress can renew it up to the
  // existing four-minute hard ceiling.
  return Math.max(120_000, Math.min(240_000, expected * 2 + 15_000))
}

/** Keep an active reservation valid through the physical command's own
 * bounded deadline. This tolerates a temporarily starved render/event loop;
 * successful and failed commands still release their reservation eagerly. */
export function fleetNavigationReservationExpiresAt(startedAt: number, expectedDurationMs: number) {
  return startedAt + fleetNavigationTimeoutMs(expectedDurationMs) + 15_000
}

/** Keep a moving physical route alive without turning a stalled command into
 * an unbounded wait. Semantic speed is a portable scheduling hint, while
 * wheel radius, gearing, contact and imported asset scale determine measured
 * metres per second. Fresh geometric progress may therefore renew a short
 * rolling window, bounded by the Desktop command ceiling. */
export function fleetNavigationProgressDeadline(input: {
  currentDeadlineMs: number
  hardDeadlineMs: number
  nowMs: number
  madeProgress: boolean
  rollingWindowMs?: number
}) {
  if (!input.madeProgress) return input.currentDeadlineMs
  return Math.min(
    input.hardDeadlineMs,
    Math.max(input.currentDeadlineMs, input.nowMs + Math.max(10_000, input.rollingWindowMs ?? 30_000)),
  )
}

/** Fail closed when a contact-sensitive straight approach keeps commanding
 * forward motion but the measured chassis pose no longer advances. This is a
 * short physical watchdog, separate from the route's generous scheduling
 * timeout, so an unexpected rack/load contact cannot become sustained push. */
export function assessFleetTerminalApproachProgress(input: {
  anchor: FleetPoint
  current: FleetPoint
  anchorAtMs: number
  nowMs: number
  minimumProgressM?: number
  timeoutMs?: number
}) {
  const progressM = Math.hypot(
    input.current[0] - input.anchor[0],
    input.current[1] - input.anchor[1],
  )
  const minimumProgressM = Math.max(0.001, input.minimumProgressM ?? 0.003)
  const refresh = progressM >= minimumProgressM
  return {
    progressM,
    refresh,
    stalled: !refresh && input.nowMs - input.anchorAtMs >= Math.max(500, input.timeoutMs ?? 3_000),
  }
}

/** Terminal tolerance belongs to the semantic destination geometry. A point
 * target keeps the normal precision band; entering a prepared zone or a
 * registered load interface should end the atomic navigator without chasing
 * an arbitrary centre to centimetre precision. */
export function fleetNavigationGoalToleranceM(input: {
  loadInterfaceAlignment?: boolean
  payloadRunwayEntrance?: boolean
  taskZoneRadiusM?: number
  minimumTurningRadiusM?: number
}): number | undefined {
  // Pocket insertion is a geometry terminal, not a semantic destination
  // zone. Its tolerance must remain below the target-depth reserve so a
  // successful navigation cannot still fail the physical engagement gate.
  if (input.loadInterfaceAlignment) return FORK_INSERTION_TERMINAL_TOLERANCE_M
  // The runway entrance is the interface between the generic navigator and
  // the forward-only nonholonomic docking curve. A turning-radius-sized
  // arrival band can report success while the curve start is still behind the
  // chassis, leaving the next atom physically unable to enter it. Keep this
  // hand-off tighter than one ordinary low-speed control step.
  if (input.payloadRunwayEntrance) return 0.02
  if (Number.isFinite(input.taskZoneRadiusM)) return Math.max(0.08, input.taskZoneRadiusM!)
  if (Number.isFinite(input.minimumTurningRadiusM)) {
    return Math.max(0.08, Math.min(0.18, input.minimumTurningRadiusM! * 0.15))
  }
  return undefined
}

/** A relative translation promises measured displacement, not merely arrival
 * inside a semantic destination zone. Scale its terminal band with the
 * requested displacement so a short forward/reverse atom cannot finish at
 * its starting pose just because the chassis has a large turning radius. */
export function fleetRelativeNavigationGoalToleranceM(distanceM: number) {
  const distance = Number.isFinite(distanceM) ? Math.abs(distanceM) : 0
  return Math.max(0.005, Math.min(0.025, distance * 0.1))
}

/** Admission into a contact-sensitive straight segment is morphology-aware.
 * Fork-pocket insertion keeps its millimetre-scale hand-off, while a rack
 * approach only needs the steered chassis to settle inside a small fraction of
 * its registered traffic envelope before driving straight along the support
 * axis. This avoids chasing an 8 mm point with a metre-scale turning radius. */
export function fleetTerminalApproachStartToleranceM(input: {
  supportAlignment?: boolean
  envelopeRadiusM?: number
}) {
  if (!input.supportAlignment) return 0.008
  const envelopeRadiusM = Number.isFinite(input.envelopeRadiusM)
    ? Math.max(0, input.envelopeRadiusM!)
    : 0.35
  return Math.max(0.02, Math.min(0.06, envelopeRadiusM * 0.1))
}

export type FleetNavigationStep =
  | { done: true; waypointIndex: number; forward: 0; turn: 0; distanceToGoalM: number; proximityScale: number; terminalRecoveryActive: false }
  | {
      done: false
      waypointIndex: number
      forward: number
      turn: number
      distanceToGoalM: number
      proximityScale: number
      needsReplan: boolean
      terminalRecoveryActive: boolean
      blockedBy?: string
    }

/** Finds a collision-free point on the straight approach ray behind a goal.
 * A carried-load circumcircle is intentionally conservative while turning,
 * but can cover a terminal pose that is safe at its declared final heading.
 * Navigation stops at this backed-off point; the physical controller then
 * performs the remaining straight, heading-constrained approach. */
export function backoffFleetGoalAlongHeading(input: {
  goal: FleetPoint
  yaw: number
  obstacles: readonly FleetPathObstacle[]
  clearanceM: number
  maxBackoffM?: number
  stepM?: number
}): { point: FleetPoint; backoffM: number } | null {
  const maxBackoffM = Math.max(0, input.maxBackoffM ?? 3)
  const stepM = Math.max(0.02, input.stepM ?? 0.06)
  for (let backoffM = 0; backoffM <= maxBackoffM + 1e-9; backoffM += stepM) {
    const point: FleetPoint = [
      input.goal[0] - Math.cos(input.yaw) * backoffM,
      input.goal[1] - Math.sin(input.yaw) * backoffM,
    ]
    const clear = input.obstacles.every((obstacle) =>
      Math.hypot(point[0] - obstacle.center[0], point[1] - obstacle.center[1]) >= obstacle.radiusM + input.clearanceM,
    )
    if (clear) return { point, backoffM }
  }
  return null
}

/** Resolve a semantic "go to this object" coordinate into a reachable base
 * pose immediately before that object. Object centers are valid perception
 * targets but physically invalid base centers. Other occupied goals (robots,
 * shelves and prohibited zones) remain blocked and are never softened here. */
export function resolveFleetObjectApproachGoal(input: {
  start: FleetPoint
  goal: FleetPoint
  obstacles: readonly FleetPathObstacle[]
  clearanceM: number
}): { point: FleetPoint; objectId?: string; backoffM: number } | null {
  const objectAtGoal = input.obstacles
    .filter((obstacle) => obstacle.id.startsWith("object:"))
    .map((obstacle) => ({
      obstacle,
      distanceM: Math.hypot(input.goal[0] - obstacle.center[0], input.goal[1] - obstacle.center[1]),
    }))
    // Semantic staging points are allowed to sit on the edge of an object's
    // registered no-contact band.  Such a point is outside the object's
    // physical circumcircle but is still rejected by A* once vehicle
    // clearance is applied.  Treat the complete blocked band as an object
    // target and back it off to the nearest reachable approach pose; otherwise
    // a perfectly meaningful "go near the rack" request waits forever at
    // goal_blocked while the later, heading-constrained alignment atom never
    // gets a chance to run.
    .filter(({ obstacle, distanceM }) => distanceM <= obstacle.radiusM + input.clearanceM + 1e-6)
    .sort((left, right) => left.distanceM - right.distanceM)[0]
  if (!objectAtGoal) return { point: [...input.goal], backoffM: 0 }

  const yaw = Math.atan2(input.goal[1] - input.start[1], input.goal[0] - input.start[0])
  const resolved = backoffFleetGoalAlongHeading({
    goal: input.goal,
    yaw,
    obstacles: input.obstacles,
    clearanceM: input.clearanceM,
  })
  return resolved ? { ...resolved, objectId: objectAtGoal.obstacle.id } : null
}

/** Returns a short radial escape target when the live vehicle is physically
 * clear but already inside a larger route-planning band.  A forklift can
 * reverse to this point before asking A* for a new forward route, avoiding a
 * stop/replan loop caused by a payload envelope growing during a turn. */
export function fleetObstacleEscapeTarget(input: {
  position: FleetPoint
  obstacles: readonly FleetPathObstacle[]
  desiredClearanceM: number
  extraEscapeM?: number
}): { point: FleetPoint; obstacleId: string; currentClearanceM: number } | null {
  const nearest = input.obstacles
    .map((obstacle) => {
      const dx = input.position[0] - obstacle.center[0]
      const dy = input.position[1] - obstacle.center[1]
      const distanceM = Math.hypot(dx, dy)
      return { obstacle, dx, dy, distanceM, clearanceM: distanceM - obstacle.radiusM }
    })
    .sort((left, right) => left.clearanceM - right.clearanceM)[0]
  if (!nearest || nearest.clearanceM >= input.desiredClearanceM) return null
  const norm = Math.max(1e-6, nearest.distanceM)
  const escapeM = input.desiredClearanceM - nearest.clearanceM + Math.max(0.04, input.extraEscapeM ?? 0.12)
  return {
    point: [
      input.position[0] + nearest.dx / norm * escapeM,
      input.position[1] + nearest.dy / norm * escapeM,
    ],
    obstacleId: nearest.obstacle.id,
    currentClearanceM: nearest.clearanceM,
  }
}

/** Low-speed pose-approach intent shared by ordinary and reverse manoeuvres.
 * `turn` is a vehicle-semantic request; each actor adapter owns how steering
 * and wheel differential realise it in reverse. A physically steered chassis
 * must retain a small motion arc because zero wheel speed cannot change yaw. */
export function fleetApproachIntent(input: {
  distanceM: number
  headingErrorRad: number
  speedLimit: number
  reverse: boolean
  steered: boolean
}): { forward: number; turn: number } {
  const direction = input.reverse ? -1 : 1
  const turn = clamp(input.headingErrorRad / 0.65, -0.7, 0.7)
  const highHeadingError = Math.abs(input.headingErrorRad) > 0.8
  const arcSpeed = Math.min(input.speedLimit, Math.max(0.04, Math.min(0.08, input.distanceM * 0.7)))
  const travelSpeed = Math.min(input.speedLimit, Math.max(0.08, input.distanceM * 0.7))
  return {
    forward: direction * (highHeadingError ? (input.steered ? arcSpeed : 0) : travelSpeed),
    turn,
  }
}

/** Planning/runtime/terminal bands for a physical steering radius. The
 * planner receives the widest band, the live follower keeps hysteresis for
 * small physics drift, and terminal backoff reserves its arrival tolerance. */
export function fleetRouteClearances(minimumTurningRadiusM?: number): {
  planningM: number
  runtimeM: number
  terminalM: number
} {
  const radius = Number.isFinite(minimumTurningRadiusM) ? Math.max(0, minimumTurningRadiusM!) : 0
  const planningM = Math.max(0.24, Math.min(0.7, radius * 0.5))
  return { planningM, runtimeM: Math.max(0.12, planningM - 0.12), terminalM: planningM + 0.12 }
}

export function fleetNeedsReverseHeadingEscape(input: {
  headingErrorRad: number
  nearestShelfClearanceM: number
  planningClearanceM: number
}): boolean {
  return Math.abs(input.headingErrorRad) > 0.55
    && input.nearestShelfClearanceM < input.planningClearanceM + 0.4
}

export function planFleetNavigation(request: FleetNavigationRequest) {
  const planned = planFleetPath(request)
  if (!planned.ok) return planned
  const exactPath: FleetPoint[] = [
    [...request.start] as [number, number],
    ...planned.points,
    [...request.goal] as [number, number],
  ]
  return {
    ...planned,
    points: simplifyFleetNavigationPath(exactPath, request.obstacles, request.clearanceM),
  }
}

/** Reach the first point of a morphology-qualified docking curve through the
 * ordinary obstacle-aware planner, then preserve every sampled curve point
 * through the contact-sensitive staging pose.  Connecting the live chassis
 * directly to the curve start can draw a chord straight through the support
 * whenever the vehicle begins on the opposite side of a rack. */
export function planFleetTerminalDockingNavigation(input: {
  request: FleetNavigationRequest
  terminalApproachPath: readonly FleetPoint[]
}) {
  const runwayStart = input.terminalApproachPath[0]
  if (!runwayStart) return planFleetNavigation(input.request)
  const transit = planFleetNavigation({
    ...input.request,
    goal: runwayStart,
  })
  if (!transit.ok) return transit
  const points = [...transit.points]
  for (const point of input.terminalApproachPath) {
    const previous = points.at(-1)
    if (!previous || Math.hypot(previous[0] - point[0], previous[1] - point[1]) > 1e-6)
      points.push([...point] as FleetPoint)
  }
  return {
    ok: true as const,
    message: "已绕开实体障碍到达入架曲线起点，并保留注册末段曲线。",
    points,
  }
}

export type FleetAcceptedRouteSegment = {
  segmentId: string
  from: [number, number]
  to: [number, number]
  enterAt: number
  exitAt: number
  zoneId?: string
}

/** Refine a semantic terminal proposal before traffic admission. The returned
 * segments are the accepted route consumed by traffic, UI and the physical
 * follower; no downstream layer may silently replace them with another A*.
 */
export function refineFleetTerminalDockingReservation(input: {
  proposalId: string
  segments: readonly FleetAcceptedRouteSegment[]
  liveStart: FleetPoint
  terminalRoute: readonly FleetPoint[]
  staging: FleetPoint
  target: FleetPoint
  bounds: { min: FleetPoint; max: FleetPoint }
  obstacles: readonly FleetPathObstacle[]
  clearanceM: number
  maximumSegments?: number
}):
  | { ok: true; segments: FleetAcceptedRouteSegment[]; points: FleetPoint[] }
  | { ok: false; message: string } {
  const first = input.segments[0]
  const last = input.segments.at(-1)
  if (!first || !last) return { ok: false, message: "terminal route has no timed segments" }
  const terminalApproachPath: FleetPoint[] = []
  for (const point of [...input.terminalRoute, input.staging, input.target]) {
    const previous = terminalApproachPath.at(-1)
    if (!previous || Math.hypot(previous[0] - point[0], previous[1] - point[1]) > 1e-6) {
      terminalApproachPath.push([...point] as FleetPoint)
    }
  }
  const planned = planFleetTerminalDockingNavigation({
    request: {
      start: input.liveStart,
      goal: input.target,
      bounds: input.bounds,
      obstacles: input.obstacles,
      clearanceM: input.clearanceM,
      gridM: 0.12,
    },
    terminalApproachPath,
  })
  if (!planned.ok) return { ok: false, message: planned.message }
  const points: FleetPoint[] = []
  for (const point of planned.points) {
    const previous = points.at(-1)
    if (!previous || Math.hypot(previous[0] - point[0], previous[1] - point[1]) > 1e-6) {
      points.push([...point] as FleetPoint)
    }
  }
  const maximumSegments = Math.max(1, input.maximumSegments ?? 256)
  if (points.length < 2 || points.length - 1 > maximumSegments) {
    return { ok: false, message: `accepted terminal route requires ${Math.max(0, points.length - 1)} segments` }
  }
  const distancesM = [0]
  for (let index = 1; index < points.length; index += 1) {
    distancesM.push(distancesM[index - 1]! + Math.hypot(
      points[index]![0] - points[index - 1]![0],
      points[index]![1] - points[index - 1]![1],
    ))
  }
  const totalDistanceM = Math.max(1e-6, distancesM.at(-1)!)
  const enterAt = first.enterAt
  const exitAt = Math.max(enterAt + 1_000, last.exitAt)
  const terminalZoneId = last.zoneId
  const segments = points.slice(1).map((point, index): FleetAcceptedRouteSegment => ({
    segmentId: `${input.proposalId}:accepted:${index + 1}`,
    from: [...points[index]!] as [number, number],
    to: [...point] as [number, number],
    enterAt: enterAt + Math.round(distancesM[index]! / totalDistanceM * (exitAt - enterAt)),
    exitAt: index === points.length - 2
      ? exitAt
      : enterAt + Math.round(distancesM[index + 1]! / totalDistanceM * (exitAt - enterAt)),
    ...(terminalZoneId && index === points.length - 2 ? { zoneId: terminalZoneId } : {}),
  }))
  return { ok: true, segments, points }
}

/** Split one accepted route at the registered staging point. Before docking,
 * follow only the accepted open-space prefix; after the measured stop/yaw
 * gate, follow only its accepted terminal suffix. */
export function fleetPrescribedPathForPhase(input: {
  prescribedPath: readonly FleetPoint[]
  terminalApproachStart?: FleetPoint
  terminalApproachActive: boolean
}): FleetPoint[] {
  if (!input.terminalApproachStart || input.prescribedPath.length === 0) {
    return input.prescribedPath.map((point) => [...point] as FleetPoint)
  }
  let splitIndex = 0
  let splitDistanceM = Number.POSITIVE_INFINITY
  input.prescribedPath.forEach((point, index) => {
    const distanceM = Math.hypot(
      point[0] - input.terminalApproachStart![0],
      point[1] - input.terminalApproachStart![1],
    )
    if (distanceM < splitDistanceM) {
      splitIndex = index
      splitDistanceM = distanceM
    }
  })
  const phasePoints = input.terminalApproachActive
    ? input.prescribedPath.slice(splitIndex)
    : input.prescribedPath.slice(0, splitIndex + 1)
  return phasePoints.map((point) => [...point] as FleetPoint)
}

/** Locate the first Host-authored nonholonomic sample inside an accepted
 * route that may also contain an ordinary A* prefix. */
export function fleetCurvatureQualifiedStartIndex(input: {
  path: readonly FleetPoint[]
  terminalApproachPath: readonly FleetPoint[]
}): number | undefined {
  if (input.terminalApproachPath.length < 2) return undefined
  const first = input.terminalApproachPath[0]!
  const index = input.path.findIndex((point) => Math.hypot(point[0] - first[0], point[1] - first[1]) <= 1e-5)
  return index >= 0 ? index : undefined
}

/** Admit only the already-aligned, front-side runway into a registered
 * terminal interface. This allows A* to reach a staging pose covered by the
 * target support's conservative circumcircle without making that support
 * globally passable or allowing a route from its far side through the rack. */
export function fleetTerminalRunwayAlreadyAligned(input: {
  start: FleetPoint
  staging: FleetPoint
  target: FleetPoint
  maximumLateralErrorM?: number
}) {
  const axisX = input.target[0] - input.staging[0]
  const axisY = input.target[1] - input.staging[1]
  const axisLength = Math.hypot(axisX, axisY)
  if (axisLength <= 1e-6) return false
  const nx = axisX / axisLength
  const ny = axisY / axisLength
  const startX = input.start[0] - input.staging[0]
  const startY = input.start[1] - input.staging[1]
  const axialM = startX * nx + startY * ny
  const lateralM = Math.abs(-startX * ny + startY * nx)
  return axialM <= 1e-6 && lateralM <= Math.max(0.005, input.maximumLateralErrorM ?? 0.025)
}

/** Build only the short, straight runway immediately in front of a terminal
 * support. Open-space transit belongs to A*, not to a current-pose-derived S
 * curve that can start several metres away. The first sample is kept outside
 * the support's conservative obstacle envelope; the remaining samples enter
 * only along the registered approach axis. */
export function fleetTerminalSupportRunway(input: {
  staging: FleetPoint
  target: FleetPoint
  supportObstacles: readonly FleetPathObstacle[]
  clearanceM: number
  minimumLeadM?: number
  sampleSpacingM?: number
}): FleetPoint[] {
  const axisX = input.target[0] - input.staging[0]
  const axisY = input.target[1] - input.staging[1]
  const axisLength = Math.hypot(axisX, axisY)
  if (axisLength <= 1e-6) return [[...input.staging] as FleetPoint]
  const nx = axisX / axisLength
  const ny = axisY / axisLength
  const spacingM = Math.max(0.04, input.sampleSpacingM ?? 0.12)
  let leadM = Math.max(spacingM, input.minimumLeadM ?? 0.45)
  const outsideSupport = (lead: number) => input.supportObstacles.every((obstacle) => {
    const x = input.staging[0] - nx * lead
    const y = input.staging[1] - ny * lead
    return Math.hypot(x - obstacle.center[0], y - obstacle.center[1]) >=
      Math.max(0, obstacle.radiusM) + Math.max(0, input.clearanceM) + 0.02
  })
  while (!outsideSupport(leadM) && leadM < 10) leadM += spacingM
  const sampleCount = Math.max(1, Math.ceil(leadM / spacingM))
  const runway: FleetPoint[] = []
  for (let index = 0; index <= sampleCount; index += 1) {
    const remainingM = leadM * (1 - index / sampleCount)
    runway.push([
      input.staging[0] - nx * remainingM,
      input.staging[1] - ny * remainingM,
    ])
  }
  return runway
}

/** Give the transit planner enough room to pass around the support obstacle
 * and reach the generated docking curve.  Only the selected support obstacle
 * is supplied by the caller; unrelated scene objects must not inflate the
 * planning world. */
export function fleetTerminalDockingBounds(input: {
  bounds: { min: FleetPoint; max: FleetPoint }
  terminalApproachPath: readonly FleetPoint[]
  supportObstacles: readonly FleetPathObstacle[]
  clearanceM: number
  paddingM?: number
}) {
  const paddingM = Math.max(0.12, input.paddingM ?? 0.24)
  let minX = input.bounds.min[0]
  let minY = input.bounds.min[1]
  let maxX = input.bounds.max[0]
  let maxY = input.bounds.max[1]
  for (const point of input.terminalApproachPath) {
    minX = Math.min(minX, point[0] - paddingM)
    minY = Math.min(minY, point[1] - paddingM)
    maxX = Math.max(maxX, point[0] + paddingM)
    maxY = Math.max(maxY, point[1] + paddingM)
  }
  for (const obstacle of input.supportObstacles) {
    const radiusM = Math.max(0, obstacle.radiusM) + Math.max(0, input.clearanceM) + paddingM
    minX = Math.min(minX, obstacle.center[0] - radiusM)
    minY = Math.min(minY, obstacle.center[1] - radiusM)
    maxX = Math.max(maxX, obstacle.center[0] + radiusM)
    maxY = Math.max(maxY, obstacle.center[1] + radiusM)
  }
  return { min: [minX, minY] as FleetPoint, max: [maxX, maxY] as FleetPoint }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0))
}

function wrapAngle(value: number) {
  let angle = value
  while (angle > Math.PI) angle -= Math.PI * 2
  while (angle < -Math.PI) angle += Math.PI * 2
  return angle
}

/** Admit a vehicle that is already between the staging plane and insertion
 * endpoint into the straight terminal phase. Reversing such a vehicle back to
 * staging can steer tines sideways while they are already inside a pocket. */
export function fleetTerminalApproachAlreadyAdmitted(input: {
  pose: FleetNavigationPose
  staging: FleetPoint
  target: FleetPoint
  goalYawRad: number
  maximumLateralErrorM?: number
  maximumYawErrorRad?: number
}) {
  const dx = input.target[0] - input.staging[0]
  const dy = input.target[1] - input.staging[1]
  const length = Math.hypot(dx, dy)
  if (!Number.isFinite(length) || length < 1e-6) return false
  const nx = dx / length
  const ny = dy / length
  const fromStageX = input.pose.x - input.staging[0]
  const fromStageY = input.pose.y - input.staging[1]
  const axialM = fromStageX * nx + fromStageY * ny
  const lateralM = Math.abs(-fromStageX * ny + fromStageY * nx)
  const yawErrorRad = Math.abs(wrapAngle(input.goalYawRad - input.pose.yaw))
  return axialM >= -0.008 && axialM <= length + 0.04 &&
    lateralM <= (input.maximumLateralErrorM ?? 0.012) &&
    yawErrorRad <= (input.maximumYawErrorRad ?? 0.01)
}

/** A prescribed nonholonomic terminal route may start behind the measured
 * chassis pose because the vehicle still needs to create its turning radius.
 * Let the ordinary follower reverse into that open-space runway entrance.
 * Once the first sampled curve point is admitted, keep the approved curve and
 * the final contact-sensitive segment in forward gear. */
export function fleetTerminalApproachForwardOnly(input: {
  terminalApproachActive: boolean
  hasTerminalApproachStart: boolean
  hasPrescribedTerminalPath: boolean
  waypointIndex: number
}): boolean {
  if (!input.hasTerminalApproachStart) return false
  // Forward-only is a contact-sensitive rule: it begins after the strict
  // staging pose admits the straight insertion segment. The open-space
  // curvature route may need a bounded reverse correction when a physical
  // steered chassis overshoots a sampled tangent; forcing forward there turns
  // a centimetre-scale miss into an unbounded circle.
  return input.terminalApproachActive
}

/** A nonholonomic route may legitimately begin with a short reverse move to
 * create steering room and then continue forward along its approved curve.
 * Do not carry wheel momentum across that direction change: the runtime must
 * command a real stop before admitting the opposite travel direction. */
export function fleetTravelDirection(forward: number): -1 | 0 | 1 {
  if (!Number.isFinite(forward) || Math.abs(forward) <= 1e-3) return 0
  return forward < 0 ? -1 : 1
}

export function fleetNeedsDirectionChangeBrake(input: {
  activeDirection: -1 | 0 | 1
  requestedForward: number
}): boolean {
  const requestedDirection = fleetTravelDirection(input.requestedForward)
  return input.activeDirection !== 0 && requestedDirection !== 0 && requestedDirection !== input.activeDirection
}

/** Resolve an open-space docking runway for a steered vehicle that starts
 * laterally offset from a same-heading terminal axis. A nonholonomic chassis
 * cannot translate sideways at the nominal staging plane. It first reaches
 * this farther, axis-aligned point, then centres steering and travels the
 * remaining segment straight. The lead length comes from two equal,
 * opposite radius arcs; no vehicle/task name or fixed world coordinate is
 * involved. */
export function resolveFleetSteeredDockingRoute(input: {
  current: FleetPoint
  nominalStaging: FleetPoint
  goalYawRad: number
  minimumTurningRadiusM?: number
  lateralToleranceM?: number
  settlingLeadM?: number
  sampleSpacingM?: number
}): {
  staging: [number, number]
  waypoints: [number, number][]
  lateralOffsetM: number
  requiredAxialLeadM: number
} {
  const radiusM = input.minimumTurningRadiusM
  const staging = [...input.nominalStaging] as [number, number]
  if (!Number.isFinite(radiusM) || radiusM! <= 0) {
    return { staging, waypoints: [staging], lateralOffsetM: 0, requiredAxialLeadM: 0 }
  }
  const ax = Math.cos(input.goalYawRad)
  const ay = Math.sin(input.goalYawRad)
  const lx = -ay
  const ly = ax
  const dx = input.current[0] - input.nominalStaging[0]
  const dy = input.current[1] - input.nominalStaging[1]
  const lateralOffsetM = dx * lx + dy * ly
  const lateralM = Math.abs(lateralOffsetM)
  if (lateralM <= (input.lateralToleranceM ?? 0.012)) {
    return { staging, waypoints: [staging], lateralOffsetM, requiredAxialLeadM: 0 }
  }

  // Two equal, opposite-radius arcs translate a same-heading vehicle between
  // parallel lanes. Sampling both arcs gives the follower the changing
  // tangent it needs; one diagonal point makes a rear-steered chassis cut the
  // corner and then hunt for terminal yaw.
  const radius = Math.max(radiusM!, lateralM / 1.9)
  const theta = Math.acos(clamp(1 - lateralM / (2 * radius), -1, 1))
  const halfAdvanceM = radius * Math.sin(theta)
  const curveAdvanceM = 2 * halfAdvanceM
  // Rear steering remains physically deflected after the second lateral arc.
  // Keep a meaningful straight runway before the strict staging/yaw gate so
  // the slew-limited steering can centre before either tine reaches a pocket.
  // A short 15 cm tail let the chassis cross staging while still yawed and it
  // then reverse-hunted around the load instead of entering straight.
  // Steering-centre runway scales with the deflection produced by these
  // actual arcs. A fixed 1.2 radii made a centimetre-scale staging correction
  // reverse more than a metre before moving forward again, exhausting the
  // bounded action deadline on a Mesh. Retain the proven 45 cm minimum while
  // allowing genuinely larger arcs to earn proportionally more settling room.
  const settlingLeadM = Math.max(0.08, input.settlingLeadM ?? Math.max(0.45, radius * theta))
  const requiredAxialLeadM = curveAdvanceM + settlingLeadM
  const shiftSign = lateralOffsetM > 0 ? -1 : 1
  const curveStart: [number, number] = [
    staging[0] - ax * requiredAxialLeadM + lx * lateralOffsetM,
    staging[1] - ay * requiredAxialLeadM + ly * lateralOffsetM,
  ]
  const waypoints: [number, number][] = []
  if (Math.hypot(input.current[0] - curveStart[0], input.current[1] - curveStart[1]) > 0.02) {
    waypoints.push(curveStart)
  }
  const sampleCount = Math.max(2, Math.ceil(radius * theta / Math.max(0.04, input.sampleSpacingM ?? 0.08)))
  for (let index = 1; index <= sampleCount; index += 1) {
    const angle = theta * index / sampleCount
    const axialM = radius * Math.sin(angle)
    const lateralShiftM = shiftSign * radius * (1 - Math.cos(angle))
    waypoints.push([
      curveStart[0] + ax * axialM + lx * lateralShiftM,
      curveStart[1] + ay * axialM + ly * lateralShiftM,
    ])
  }
  const midpoint = waypoints.at(-1)!
  for (let index = 1; index <= sampleCount; index += 1) {
    const angle = theta * index / sampleCount
    const axialM = radius * (Math.sin(theta) - Math.sin(theta - angle))
    const lateralShiftM = shiftSign * radius * (Math.cos(theta - angle) - Math.cos(theta))
    waypoints.push([
      midpoint[0] + ax * axialM + lx * lateralShiftM,
      midpoint[1] + ay * axialM + ly * lateralShiftM,
    ])
  }
  // The settling lead is physical runway, not merely extra distance folded
  // into one final look-ahead point. Sample it so the local controller keeps
  // observing an axis-aligned tangent while the slew-limited rear steering
  // returns to centre before the strict staging pose.
  const curveEnd = waypoints.at(-1)!
  const tailSpacingM = Math.max(0.1, input.sampleSpacingM ?? 0.12)
  const tailCount = Math.max(1, Math.ceil(settlingLeadM / tailSpacingM))
  for (let index = 1; index <= tailCount; index += 1) {
    const progress = index / tailCount
    waypoints.push([
      curveEnd[0] + (staging[0] - curveEnd[0]) * progress,
      curveEnd[1] + (staging[1] - curveEnd[1]) * progress,
    ])
  }
  return { staging, waypoints, lateralOffsetM, requiredAxialLeadM }
}

/** Compatibility projection for callers that only need the first open-space
 * pose. New navigation code should consume the sampled docking route. */
export function resolveFleetSteeredDockingStaging(
  input: Parameters<typeof resolveFleetSteeredDockingRoute>[0],
): [number, number] {
  return resolveFleetSteeredDockingRoute(input).waypoints[0]!
}

function pointSegmentDistance(point: FleetPoint, start: FleetPoint, end: FleetPoint) {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared < 1e-12) return Math.hypot(point[0] - start[0], point[1] - start[1])
  const t = clamp(((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared, 0, 1)
  return Math.hypot(point[0] - (start[0] + dx * t), point[1] - (start[1] + dy * t))
}

/** Removes grid stair-steps while preserving circular obstacle clearance.
 * Long steered vehicles can then follow a stable look-ahead segment instead
 * of chasing every 12 cm A* cell and oscillating across the route. */
export function simplifyFleetNavigationPath(
  path: readonly FleetPoint[],
  obstacles: readonly FleetPathObstacle[],
  clearanceM: number,
): FleetPoint[] {
  if (path.length <= 2) return path.map((point) => [...point] as [number, number])
  const simplified: FleetPoint[] = [[...path[0]!] as [number, number]]
  let anchor = 0
  while (anchor < path.length - 1) {
    let next = anchor + 1
    for (let candidate = path.length - 1; candidate > anchor + 1; candidate -= 1) {
      const clear = obstacles.every((obstacle) =>
        pointSegmentDistance(obstacle.center, path[anchor]!, path[candidate]!) >= obstacle.radiusM + clearanceM,
      )
      if (!clear) continue
      next = candidate
      break
    }
    simplified.push([...path[next]!] as [number, number])
    anchor = next
  }
  return simplified
}

/** Pure local follower. It never writes ctrl: the runtime applies the returned
 * bounded intent at the shared per-frame control barrier. */
export function fleetNavigationStep(input: {
  pose: FleetNavigationPose
  goal: FleetPoint
  path: readonly FleetPoint[]
  waypointIndex: number
  obstacles: readonly FleetPathObstacle[]
  clearanceM: number
  speedLimit: number
  /** 精密接口可增强航向反馈；默认保持原控制行为，转角仍受资产范围限制。 */
  headingFeedbackGain?: number
  goalToleranceM?: number
  goalYawRad?: number
  goalYawToleranceRad?: number
  /** Coarser yaw band that may keep approaching an open-space staging plane.
   * The caller must still apply its own measured staging admission before a
   * contact-sensitive terminal segment begins. */
  terminalRecoveryYawToleranceRad?: number
  /** Coarse cross-track band paired with the caller's measured staging gate. */
  terminalRecoveryLateralToleranceM?: number
  /** A contact-sensitive straight segment has already passed the strict
   * staging yaw gate and deliberately keeps steering centred. At its endpoint
   * yaw can no longer be corrected without sweeping the carrier sideways, so
   * positional completion owns the stop while the load/support guard verifies
   * the physical interface. */
  headingRequiredForCompletion?: boolean
  minimumArcForward?: number
  minimumTurningRadiusM?: number
  /** True only for a Host-generated nonholonomic curve whose samples are
   * physical gates. Ordinary A* paths may contain many grid waypoints but are
   * not curvature-qualified merely because the actor is steered. */
  curvatureQualifiedPath?: boolean
  /** First Host-authored curve sample when the accepted path has an ordinary
   * A* prefix. Samples before this index retain ordinary look-ahead rules. */
  curvatureQualifiedFromWaypointIndex?: number
  /** Settled travel direction used to add hysteresis around side-on points. */
  activeTravelDirection?: -1 | 0 | 1
  /** Persistent open-space terminal recovery phase owned by the caller. */
  terminalRecoveryActive?: boolean
  /** Directional completion window for a registered placement support. The
   * nominal point is the shallowest full-footprint pose; a small measured
   * overshoot remains valid while the payload still has registered support
   * under both its front/rear and lateral edges. */
  terminalPlacementWindow?: {
    maximumForwardOvershootM: number
    maximumLateralErrorM: number
  }
  /** An already-coordinated through route owns a continuous forward pass.
   * Do not turn a temporarily side/rear look-ahead point into a reverse gear
   * command while the steering chassis converges onto that approved arc. */
  forwardOnly?: boolean
}): FleetNavigationStep {
  if (input.path.length === 0) throw new Error("navigation path must not be empty")
  const position: FleetPoint = [input.pose.x, input.pose.y]
  const distanceToGoalM = Math.hypot(input.goal[0] - input.pose.x, input.goal[1] - input.pose.y)
  const terminalHeadingError = typeof input.goalYawRad === "number"
    ? wrapAngle(input.goalYawRad - input.pose.yaw)
    : 0
  let waypointIndex = Math.max(0, Math.min(input.path.length - 1, input.waypointIndex))
  const curvatureQualifiedAt = (index: number) => (
    input.curvatureQualifiedPath === true || (
      Number.isInteger(input.curvatureQualifiedFromWaypointIndex) &&
      index >= input.curvatureQualifiedFromWaypointIndex!
    )
  ) && input.minimumArcForward !== undefined && typeof input.goalYawRad === "number" && input.path.length > 2
  while (waypointIndex < input.path.length - 1) {
    const curvatureQualifiedWaypoint = curvatureQualifiedAt(waypointIndex)
    const waypoint = input.path[waypointIndex]!
    const previous = input.path[Math.max(0, waypointIndex - 1)]!
    const segmentX = waypoint[0] - previous[0]
    const segmentY = waypoint[1] - previous[1]
    const segmentLength = Math.hypot(segmentX, segmentY)
    const passedWaypoint =
      segmentX * (input.pose.x - waypoint[0]) + segmentY * (input.pose.y - waypoint[1]) >= 0
    const segmentLateralErrorM = segmentLength > 1e-6
      ? Math.abs(-((input.pose.x - waypoint[0]) * segmentY) + ((input.pose.y - waypoint[1]) * segmentX)) / segmentLength
      : Number.POSITIVE_INFINITY
    // Ordinary A* points are coarse hints and keep the forgiving look-ahead
    // band. Curvature samples for a steered terminal pose are the changing
    // tangents themselves (typically spaced about 8 cm apart); a 14 cm band
    // skipped several samples at once and made the chassis cut the S curve,
    // arriving at the straight runway with an uncorrectable lateral offset.
    const closeToWaypoint = Math.hypot(waypoint[0] - input.pose.x, waypoint[1] - input.pose.y) <
      (curvatureQualifiedWaypoint ? (waypointIndex <= 1 ? 0.04 : 0.06) : 0.14)
    // Crossing a sample's tangent plane is sufficient for an ordinary A*
    // hint, but not for a curvature-qualified vehicle route. A rear-steered
    // chassis can cross that plane while still a lane-width away, causing the
    // follower to skip the counter-steer half of an S curve and arrive at the
    // load interface diagonally. Curvature samples are physical path gates and
    // must be entered spatially.
    const curvaturePlaneAdmitted = curvatureQualifiedWaypoint && passedWaypoint && segmentLateralErrorM <= 0.12
    if (!closeToWaypoint && !curvaturePlaneAdmitted && (curvatureQualifiedWaypoint || !passedWaypoint)) break
    waypointIndex += 1
    // Curvature samples are control-cycle gates, not a bag of nearby A*
    // hints. Admit at most one per control tick so a stopped or slowly
    // steering chassis cannot consume several changing tangents at once.
    if (curvatureQualifiedWaypoint) break
  }
  const curvatureQualifiedPoseRoute = curvatureQualifiedAt(waypointIndex)
  const goalToleranceM = input.goalToleranceM ?? 0.08
  const headingSatisfied = typeof input.goalYawRad !== "number"
    || Math.abs(terminalHeadingError) <= (input.goalYawToleranceRad ?? 0.08)
  const recoveryHeadingSatisfied = typeof input.goalYawRad !== "number"
    || Math.abs(terminalHeadingError) <= (
      input.terminalRecoveryYawToleranceRad ?? input.goalYawToleranceRad ?? 0.08
    )
  const completionHeadingSatisfied = input.headingRequiredForCompletion === false || headingSatisfied
  const terminalAxisX = typeof input.goalYawRad === "number" ? Math.cos(input.goalYawRad) : 1
  const terminalAxisY = typeof input.goalYawRad === "number" ? Math.sin(input.goalYawRad) : 0
  const terminalAxialErrorM = (input.pose.x - input.goal[0]) * terminalAxisX +
    (input.pose.y - input.goal[1]) * terminalAxisY
  const terminalLateralErrorM = typeof input.goalYawRad === "number"
    ? Math.abs(
        -(input.pose.x - input.goal[0]) * Math.sin(input.goalYawRad) +
        (input.pose.y - input.goal[1]) * Math.cos(input.goalYawRad),
      )
    : 0
  const placementWindow = input.terminalPlacementWindow
  const placementSatisfied = Boolean(
    placementWindow &&
    completionHeadingSatisfied &&
    terminalAxialErrorM >= -goalToleranceM &&
    terminalAxialErrorM <= Math.max(0, placementWindow.maximumForwardOvershootM) &&
    terminalLateralErrorM <= Math.max(0, placementWindow.maximumLateralErrorM),
  )
  if ((distanceToGoalM <= goalToleranceM && completionHeadingSatisfied) || placementSatisfied) {
    return { done: true, waypointIndex, forward: 0, turn: 0, distanceToGoalM, proximityScale: 1, terminalRecoveryActive: false }
  }
  const waypoint = input.path[waypointIndex]!
  const blocking = input.obstacles
    .map((obstacle) => ({
      obstacle,
      distance: pointSegmentDistance(obstacle.center, position, waypoint) - obstacle.radiusM,
    }))
    .sort((left, right) => left.distance - right.distance)[0]
  const needsReplan = Boolean(blocking && blocking.distance < input.clearanceM)
  const nearestClearance = input.obstacles.reduce(
    (nearest, obstacle) => Math.min(nearest, Math.hypot(obstacle.center[0] - input.pose.x, obstacle.center[1] - input.pose.y) - obstacle.radiusM),
    Number.POSITIVE_INFINITY,
  )
  const proximityScale = Number.isFinite(nearestClearance)
    ? clamp((nearestClearance - input.clearanceM) / 0.45, 0.12, 1)
    : 1
  const terminalAxisAdmitted = terminalLateralErrorM <= Math.max(
    0.02,
    goalToleranceM * 2,
    input.terminalRecoveryLateralToleranceM ?? 0,
  )
  // Do not lock to the final yaw merely because the vehicle entered a 25 cm
  // radius around the endpoint. A laterally overshooting rear-steered chassis
  // must first steer back onto the terminal axis; early yaw lock drove it
  // straight past staging on a parallel line and caused reverse hunting.
  const previousWaypoint = input.path[Math.max(0, waypointIndex - 1)]!
  const segmentX = waypoint[0] - previousWaypoint[0]
  const segmentY = waypoint[1] - previousWaypoint[1]
  const segmentLength = Math.hypot(segmentX, segmentY)
  const sampledPathYaw = segmentLength > 1e-6
    ? (() => {
        const tangentX = segmentX / segmentLength
        const tangentY = segmentY / segmentLength
        const crossTrackM = -(input.pose.x - previousWaypoint[0]) * tangentY +
          (input.pose.y - previousWaypoint[1]) * tangentX
        const correction = clamp(Math.atan2(crossTrackM, 0.32), -0.5, 0.5)
        return wrapAngle(Math.atan2(tangentY, tangentX) - correction)
      })()
    : Math.atan2(waypoint[1] - input.pose.y, waypoint[0] - input.pose.x)
  const finalWaypointPassed = waypointIndex === input.path.length - 1 && segmentLength > 1e-6 &&
    segmentX * (input.pose.x - waypoint[0]) + segmentY * (input.pose.y - waypoint[1]) > segmentLength * 0.02
  const terminalRecoveryRequestDistanceM = Math.max(
    0.04,
    goalToleranceM * 2,
    Math.min(0.18, Math.max(0.5, input.minimumTurningRadiusM ?? 0.5) * 0.15),
  )
  const terminalRecoveryRequested = waypointIndex === input.path.length - 1 && (
    finalWaypointPassed || distanceToGoalM <= terminalRecoveryRequestDistanceM
  ) && (!recoveryHeadingSatisfied || !terminalAxisAdmitted)
  // Reverse only long enough to regain the requested heading and steering
  // room. A rear-steered chassis naturally accumulates some lateral offset
  // during that arc; requiring it to become axis-centred while continuing to
  // reverse makes the escape unbounded. Once heading is recovered, the normal
  // forward follower owns lateral convergence back to staging.
  // The escape distance is the arc length needed to remove the measured
  // heading error, with finite lower/upper bounds. A fixed 45 cm retreat made
  // a 3-degree correction traverse several times its physical requirement and
  // then stall at the gear-change point on sloped Mesh.
  const terminalRecoveryDistanceM = clamp(
    Math.abs(terminalHeadingError) * Math.max(0.5, input.minimumTurningRadiusM ?? 1) * 2,
    0.1,
    0.45,
  )
  const terminalRecoveryComplete = terminalAxialErrorM <= -0.1 && (
    headingSatisfied || terminalAxialErrorM <= -terminalRecoveryDistanceM
  )
  // Once a contact-sensitive straight segment has passed its staging gate,
  // the carrier must keep advancing along the admitted runway. Re-entering a
  // chassis-yaw recovery here made an already aligned pair of tines reverse
  // roughly 70 cm and repeat until timeout. The measured load/support guard
  // owns acceptance at this point; yaw recovery belongs before the gate.
  const terminalReverseRecovery = input.headingRequiredForCompletion !== false &&
    (input.terminalRecoveryActive === true || terminalRecoveryRequested) &&
    !terminalRecoveryComplete
  const terminalRecoveryAxialM = Math.min(-0.1, terminalAxialErrorM - 0.2)
  const terminalRecoveryYaw = Math.atan2(
    input.goal[1] + terminalAxisY * terminalRecoveryAxialM - input.pose.y,
    input.goal[0] + terminalAxisX * terminalRecoveryAxialM - input.pose.x,
  )
  const waypointYaw = Math.atan2(waypoint[1] - input.pose.y, waypoint[0] - input.pose.x)
  const finalYawFacesWaypoint = typeof input.goalYawRad !== "number" ||
    Math.cos(wrapAngle(waypointYaw - input.goalYawRad)) >= 0
  const finalYawSettling = finalWaypointPassed && terminalAxisAdmitted &&
    typeof input.goalYawRad === "number" && !headingSatisfied
  const desiredYaw = terminalReverseRecovery
    ? terminalRecoveryYaw
    : finalYawSettling
    ? input.goalYawRad!
    : finalWaypointPassed
      ? waypointYaw
      : typeof input.goalYawRad === "number" && terminalAxisAdmitted &&
    finalYawFacesWaypoint && distanceToGoalM <= Math.max(0.25, goalToleranceM * 4)
    ? input.goalYawRad
    : curvatureQualifiedPoseRoute
      ? sampledPathYaw
      : waypointYaw
  const directHeadingError = wrapAngle(desiredYaw - input.pose.yaw)
  // A steered chassis cannot rotate in place. When the next reachable point
  // is behind it, use ordinary reverse motion instead of forcing a wide
  // forward circle. The choice comes from live route geometry for every
  // steered robot; it is not tied to a forklift or task macro.
  const absoluteDirectHeadingError = Math.abs(directHeadingError)
  const reverse = terminalReverseRecovery || (input.forwardOnly !== true && input.minimumArcForward !== undefined && (
    input.activeTravelDirection === -1
      ? absoluteDirectHeadingError > Math.PI / 3
      : input.activeTravelDirection === 1
        ? absoluteDirectHeadingError > Math.PI * 2 / 3
        : absoluteDirectHeadingError > Math.PI / 2
  ))
  const headingError = reverse
    ? wrapAngle(desiredYaw + Math.PI - input.pose.yaw)
    : directHeadingError
  // The same steering angle creates the opposite yaw rate while reversing.
  const nextWaypoint = input.path[Math.min(input.path.length - 1, waypointIndex + 1)]!
  const nextSegmentX = nextWaypoint[0] - waypoint[0]
  const nextSegmentY = nextWaypoint[1] - waypoint[1]
  const nextSegmentLength = Math.hypot(nextSegmentX, nextSegmentY)
  const segmentDirectionDot = segmentLength > 1e-6 && nextSegmentLength > 1e-6
    ? (segmentX * nextSegmentX + segmentY * nextSegmentY) / (segmentLength * nextSegmentLength)
    : 1
  const curvatureFeedforward = curvatureQualifiedPoseRoute && segmentLength > 1e-6 &&
    nextSegmentLength > 1e-6 && segmentDirectionDot > 0 && Number.isFinite(input.minimumTurningRadiusM)
    ? clamp(
        wrapAngle(Math.atan2(nextSegmentY, nextSegmentX) - Math.atan2(segmentY, segmentX)) /
          nextSegmentLength * input.minimumTurningRadiusM!,
        -1,
        1,
      )
    : 0
  const feedbackTurn = (reverse ? -headingError : headingError) / 0.7 * clamp(input.headingFeedbackGain ?? 1, 0.2, 5)
  const turn = clamp((reverse ? -curvatureFeedforward : curvatureFeedforward) + feedbackTurn, -1, 1)
  const steeredArc = input.minimumArcForward !== undefined
  const steeredHeadingCorrection = steeredArc && typeof input.goalYawRad === "number" && !headingSatisfied
  const approachScale = clamp(distanceToGoalM / 0.55, steeredHeadingCorrection ? 0.35 : 0.18, 1)
  const headingScale = steeredArc && Math.abs(headingError) > 0.3
    ? clamp(input.minimumArcForward ?? 0.5, 0.16, 1)
    : Math.abs(headingError) > 1.15
      ? clamp(input.minimumArcForward ?? 0, 0, 0.5)
      : clamp(Math.cos(headingError), 0.12, 1)
  const requestedSpeed = clamp(input.speedLimit, 0.05, 1)
  const scaledForwardMagnitude = requestedSpeed * proximityScale * approachScale * headingScale
  // `minimumArcForward` is a morphology-qualified rolling floor, not merely a
  // heading multiplier. Applying distance slowdown afterwards used to erase
  // it: the imported forklift fell below its contact breakaway speed near a
  // staging pose, leaving spinning wheel actuators but an almost stationary
  // chassis. Retain the declared fraction in open space, then continuously
  // taper it across the final few goal-tolerance widths so the parking stop
  // remains precise and contact-sensitive insertion is still slow.
  const rollingEnvelope = steeredArc
    ? clamp((distanceToGoalM - goalToleranceM) / Math.max(0.02, goalToleranceM * 4), 0, 1)
    : 0
  const minimumRollingMagnitude = steeredArc
    ? requestedSpeed * clamp(input.minimumArcForward ?? 0, 0, 1) * proximityScale * rollingEnvelope
    : 0
  const forwardMagnitude = needsReplan
    ? 0
    // This bounded reverse leg moves away from the contact-sensitive target.
    // Distance-to-goal tapering is inverted here: it previously reduced the
    // wheel request below Mesh breakaway exactly when recovery began at the
    // staging point, so 45 cm of safe retreat exhausted a four-minute limit.
    : terminalReverseRecovery
      ? requestedSpeed * proximityScale
      : Math.max(scaledForwardMagnitude, minimumRollingMagnitude)
  const forward = reverse ? -forwardMagnitude : forwardMagnitude
  return {
    done: false,
    waypointIndex,
    forward,
    turn,
    distanceToGoalM,
    proximityScale,
    needsReplan,
    terminalRecoveryActive: terminalReverseRecovery,
    ...(needsReplan && blocking ? { blockedBy: blocking.obstacle.id } : {}),
  }
}
