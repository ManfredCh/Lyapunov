export type ForkPocketLoadInterface = {
  kind: "fork_pockets"
  insertionAxisLocalXY: readonly [number, number]
  pocketCentersLocalM: readonly (readonly [number, number, number])[]
  stagingClearanceM: number
}

export type LoadCarrierProfile = {
  anchorSite: string
  tineTipSites: readonly string[]
  anchorForwardOffsetM: number
  shelfEntryClearanceM?: number
  shelfPrepositionClearanceM?: number
}

export type CargoShelfPlacementInterface = {
  kind: "cargo_shelf"
  approachAxisLocalXY: readonly [number, number]
  levels: readonly {
    id: string
    topZLocalM: number
    halfSizeM: readonly [number, number]
  }[]
}

/** In a world with several supports, exact destinations must be known for all
 * support-requesting peers before any one robot receives a lateral lane. */
export function fleetPlacementSupportCohortPending(input: {
  robotInstanceId: string
  supportRequestingGoalRobotInstanceIds: readonly string[]
  registeredPlacementSupportCount: number
  declaredSupportObjectByRobot: ReadonlyMap<string, string>
}) {
  if (input.registeredPlacementSupportCount <= 1) return false
  return [...new Set(input.supportRequestingGoalRobotInstanceIds)]
    .some((robotInstanceId) => robotInstanceId !== input.robotInstanceId && !input.declaredSupportObjectByRobot.has(robotInstanceId))
}

/** Resolve only robots that can actually share this placement support. */
export function resolveCargoShelfPlacementLane(input: {
  robotInstanceId: string
  supportObject: string
  supportRequestingGoalRobotInstanceIds: readonly string[]
  registeredPlacementSupportCount: number
  declaredSupportObjectByRobot: ReadonlyMap<string, string>
}) {
  const eligible = [...new Set([
    input.robotInstanceId,
    ...input.supportRequestingGoalRobotInstanceIds,
  ])].sort()
  const cohort = input.registeredPlacementSupportCount === 1
    ? eligible
    : eligible.filter((robotInstanceId) =>
        robotInstanceId === input.robotInstanceId ||
        input.declaredSupportObjectByRobot.get(robotInstanceId) === input.supportObject)
  if (cohort.length <= 1) return undefined
  return { ordinal: cohort.indexOf(input.robotInstanceId), count: cohort.length }
}

/** Express the carried payload in the live carrier-working frame. Imported
 * vehicles may author chassis +X opposite to their tine direction, so the
 * carrier anchor—not base yaw—is the physical forward authority. */
export function resolvePayloadCenterOffsetInCarrierFrame(input: {
  basePositionM: readonly [number, number]
  carrierAnchorPositionM: readonly [number, number]
  payloadCenterPositionM: readonly [number, number]
  fallbackBaseYawRad: number
}) {
  const values = [
    ...input.basePositionM,
    ...input.carrierAnchorPositionM,
    ...input.payloadCenterPositionM,
    input.fallbackBaseYawRad,
  ]
  if (!values.every(Number.isFinite)) return null
  const anchorDx = input.carrierAnchorPositionM[0] - input.basePositionM[0]
  const anchorDy = input.carrierAnchorPositionM[1] - input.basePositionM[1]
  const anchorDistanceM = Math.hypot(anchorDx, anchorDy)
  const forwardX = anchorDistanceM > 0.05 ? anchorDx / anchorDistanceM : Math.cos(input.fallbackBaseYawRad)
  const forwardY = anchorDistanceM > 0.05 ? anchorDy / anchorDistanceM : Math.sin(input.fallbackBaseYawRad)
  const payloadDx = input.payloadCenterPositionM[0] - input.basePositionM[0]
  const payloadDy = input.payloadCenterPositionM[1] - input.basePositionM[1]
  return [
    payloadDx * forwardX + payloadDy * forwardY,
    -payloadDx * forwardY + payloadDy * forwardX,
  ] as const
}

/** Decide when the final straight shelf-entry segment is close enough to
 * require a fresh vertical-clearance check. The check activates at the
 * Host-derived staging plane, before the carried payload can reach the rack.
 * This function is geometry-only and does not move the chassis or mast. */
export function assessCargoShelfEntryClearance(input: {
  currentBasePositionM: readonly [number, number]
  stagingBasePositionM: readonly [number, number]
  approachAxisWorldXY: readonly [number, number]
  payloadBottomM: number
  supportTopM: number
  requiredClearanceM: number
  stagingActivationMarginM?: number
}) {
  const values = [
    ...input.currentBasePositionM,
    ...input.stagingBasePositionM,
    ...input.approachAxisWorldXY,
    input.payloadBottomM,
    input.supportTopM,
    input.requiredClearanceM,
  ]
  const axisLength = Math.hypot(...input.approachAxisWorldXY)
  if (!values.every(Number.isFinite) || axisLength < 1e-9 || input.requiredClearanceM < 0) return null
  const axis: readonly [number, number] = [
    input.approachAxisWorldXY[0] / axisLength,
    input.approachAxisWorldXY[1] / axisLength,
  ]
  const dx = input.currentBasePositionM[0] - input.stagingBasePositionM[0]
  const dy = input.currentBasePositionM[1] - input.stagingBasePositionM[1]
  const entryProgressM = dx * axis[0] + dy * axis[1]
  const activationMarginM = Math.max(0, input.stagingActivationMarginM ?? 0.03)
  const clearanceM = input.payloadBottomM - input.supportTopM
  const checkRequired = entryProgressM >= -activationMarginM
  return {
    checkRequired,
    sufficient: !checkRequired || clearanceM >= input.requiredClearanceM,
    clearanceM,
    requiredClearanceM: input.requiredClearanceM,
    entryProgressM,
  }
}

/** Resolve one observed rack interface into a reachable, collision-bearing
 * placement pose. The model selects the semantic rack/optional level; all
 * metric lift and chassis targets come from the live poses and registered
 * morphology. */
export function resolveCargoShelfPlacement(input: {
  supportPositionM: readonly [number, number, number]
  supportQuaternionWxyz: readonly [number, number, number, number]
  supportInterface: CargoShelfPlacementInterface
  payloadHalfExtentsM: readonly [number, number, number]
  carrier: LoadCarrierProfile
  /** Fresh payload-centre offset in the chassis frame: forward, then left.
   * This includes the real fork insertion depth and must not be replaced by
   * the carrier anchor's nominal transport offset. */
  payloadCenterOffsetBaseLocalM: readonly [number, number]
  currentLiftM: number
  currentPayloadBottomM: number
  liftRangeM: readonly [number, number]
  requestedLevelID?: string
  prepositionClearanceM?: number
  stagingClearanceM?: number
  /** Deterministic lane within one shared support. The Host derives this from
   * the current carrier cohort; the model never supplies coordinates. */
  placementLane?: { ordinal: number; count: number }
}) {
  const values = [
    ...input.supportPositionM,
    ...input.supportQuaternionWxyz,
    ...input.payloadHalfExtentsM,
    input.carrier.anchorForwardOffsetM,
    ...input.payloadCenterOffsetBaseLocalM,
    input.currentLiftM,
    input.currentPayloadBottomM,
    ...input.liftRangeM,
  ]
  if (!values.every(Number.isFinite) || input.liftRangeM[0] > input.liftRangeM[1]) return null
  const localAxisLength = Math.hypot(...input.supportInterface.approachAxisLocalXY)
  if (!Number.isFinite(localAxisLength) || localAxisLength < 1e-6) return null
  const rotatedAxis = rotateByQuaternion([
    input.supportInterface.approachAxisLocalXY[0] / localAxisLength,
    input.supportInterface.approachAxisLocalXY[1] / localAxisLength,
    0,
  ], input.supportQuaternionWxyz)
  const planarLength = Math.hypot(rotatedAxis[0], rotatedAxis[1])
  if (!Number.isFinite(planarLength) || planarLength < 1e-6) return null
  const approachAxisWorldXY: [number, number] = [rotatedAxis[0] / planarLength, rotatedAxis[1] / planarLength]
  const prepositionClearanceM = Math.max(0.003, input.prepositionClearanceM ?? 0.04)
  const stagingClearanceM = Math.max(0.25, input.stagingClearanceM ?? 0.4)
  const candidates = input.supportInterface.levels
    .filter((level) => !input.requestedLevelID || level.id === input.requestedLevelID)
    .flatMap((level) => {
      if (
        !Number.isFinite(level.topZLocalM) || level.halfSizeM.length !== 2 ||
        !level.halfSizeM.every((value) => Number.isFinite(value) && value > 0) ||
        input.payloadHalfExtentsM[0] > level.halfSizeM[0] - 0.02 ||
        input.payloadHalfExtentsM[1] > level.halfSizeM[1] - 0.02
      ) return []
      const topOffset = rotateByQuaternion([0, 0, level.topZLocalM], input.supportQuaternionWxyz)
      const supportTopM = input.supportPositionM[2] + topOffset[2]
      const targetLiftM = input.currentLiftM + supportTopM + prepositionClearanceM - input.currentPayloadBottomM
      if (targetLiftM < input.liftRangeM[0] - 1e-6 || targetLiftM > input.liftRangeM[1] + 1e-6) return []
      return [{ level, supportTopM, targetLiftM }]
    })
    .sort((left, right) => right.supportTopM - left.supportTopM)
  const selected = candidates[0]
  if (!selected) return null
  const approachLeftWorldXY: [number, number] = [-approachAxisWorldXY[1], approachAxisWorldXY[0]]
  const [payloadForwardM, payloadLeftM] = input.payloadCenterOffsetBaseLocalM
  // Stop as soon as the whole payload is safely supported over the front
  // edge. Driving its centre all the way to the support centre can make the
  // carrier or payload contact a rear beam even though placement is already
  // physically complete. Both depths come from the registered support and
  // observed payload geometry, so this remains independent of scene names or
  // authored coordinates.
  const approachAxisLocalX = input.supportInterface.approachAxisLocalXY[0] / localAxisLength
  const approachAxisLocalY = input.supportInterface.approachAxisLocalXY[1] / localAxisLength
  const supportApproachHalfDepthM =
    Math.abs(approachAxisLocalX) * selected.level.halfSizeM[0] +
    Math.abs(approachAxisLocalY) * selected.level.halfSizeM[1]
  // The payload is carried aligned with the insertion axis. Using its larger
  // planar half extent is conservative when the source Mesh has rotated axes.
  const payloadApproachHalfDepthM = Math.max(input.payloadHalfExtentsM[0], input.payloadHalfExtentsM[1])
  const edgeSupportReserveM = Math.max(0.015, Math.min(0.03, payloadApproachHalfDepthM * 0.1))
  const payloadCenterBackoffFromSupportCenterM = Math.max(
    0,
    supportApproachHalfDepthM - payloadApproachHalfDepthM - edgeSupportReserveM,
  )
  const approachLeftLocalX = -approachAxisLocalY
  const approachLeftLocalY = approachAxisLocalX
  const supportLateralHalfWidthM =
    Math.abs(approachLeftLocalX) * selected.level.halfSizeM[0] +
    Math.abs(approachLeftLocalY) * selected.level.halfSizeM[1]
  const payloadLateralHalfWidthM = Math.max(input.payloadHalfExtentsM[0], input.payloadHalfExtentsM[1])
  const availableLateralCenterHalfWidthM = Math.max(
    0,
    supportLateralHalfWidthM - payloadLateralHalfWidthM - edgeSupportReserveM,
  )
  let placementLateralOffsetM = 0
  let neighborSupportReserveM = Number.POSITIVE_INFINITY
  if (input.placementLane) {
    const count = Math.floor(input.placementLane.count)
    const ordinal = Math.floor(input.placementLane.ordinal)
    if (count < 1 || ordinal < 0 || ordinal >= count) return null
    if (count > 1) {
      const minimumLanePitchM = payloadLateralHalfWidthM * 2 + edgeSupportReserveM
      const lanePitchM = availableLateralCenterHalfWidthM * 2 / count
      const requiredLateralCenterHalfWidthM = lanePitchM * (count - 1) / 2
      if (lanePitchM < minimumLanePitchM - 1e-6) return null
      if (requiredLateralCenterHalfWidthM > availableLateralCenterHalfWidthM + 1e-6) return null
      // Divide the usable centre span into equal cells. This balances the
      // inter-load gap with both outer margins instead of either pinning loads
      // to the shelf edges or packing them at the minimum 22.5 mm gap.
      placementLateralOffsetM = (ordinal - (count - 1) / 2) * lanePitchM
      // Adjacent carriers may each consume only half the spare gap while the
      // admission reserve itself remains untouched.
      neighborSupportReserveM = Math.max(
        0,
        (lanePitchM - payloadLateralHalfWidthM * 2 - edgeSupportReserveM) / 2,
      )
    }
  }
  const lateralSupportReserveM = Math.max(
    0,
    Math.min(
      availableLateralCenterHalfWidthM - Math.abs(placementLateralOffsetM),
      neighborSupportReserveM,
    ),
  )
  const placedBasePositionM: [number, number] = [
    input.supportPositionM[0]
      - approachAxisWorldXY[0] * payloadCenterBackoffFromSupportCenterM
      - approachAxisWorldXY[0] * payloadForwardM
      + approachLeftWorldXY[0] * (placementLateralOffsetM - payloadLeftM),
    input.supportPositionM[1]
      - approachAxisWorldXY[1] * payloadCenterBackoffFromSupportCenterM
      - approachAxisWorldXY[1] * payloadForwardM
      + approachLeftWorldXY[1] * (placementLateralOffsetM - payloadLeftM),
  ]
  return {
    levelID: selected.level.id,
    supportTopM: selected.supportTopM,
    targetLiftM: selected.targetLiftM,
    prepositionClearanceM,
    approachAxisWorldXY,
    approachYawRad: Math.atan2(approachAxisWorldXY[1], approachAxisWorldXY[0]),
    payloadCenterBackoffFromSupportCenterM,
    edgeSupportReserveM,
    lateralSupportReserveM,
    placementLateralOffsetM,
    placementLaneOrdinal: input.placementLane?.ordinal ?? 0,
    placementLaneCount: input.placementLane?.count ?? 1,
    placedBasePositionM,
    stagingBasePositionM: [
      placedBasePositionM[0] - approachAxisWorldXY[0] * stagingClearanceM,
      placedBasePositionM[1] - approachAxisWorldXY[1] * stagingClearanceM,
    ] as [number, number],
  }
}

/** Physical contract shared by insertion targeting, terminal navigation and
 * assisted-carry admission. The target keeps a 10 mm depth reserve, while the
 * navigator may consume at most half of it when settling at the endpoint. */
export const FORK_ENGAGEMENT_MIN_AXIAL_DEPTH_M = 0.03
export const FORK_INSERTION_TARGET_AXIAL_DEPTH_M = 0.045
export const FORK_INSERTION_MAX_HEADING_ERROR_RAD = 0.08

/** Coarse chassis guard before the authoritative measured two-tine gate. */
export function forkInsertionHeadingAdmitted(headingErrorRad: number) {
  return Number.isFinite(headingErrorRad) &&
    Math.abs(headingErrorRad) <= FORK_INSERTION_MAX_HEADING_ERROR_RAD
}
export const FORK_INSERTION_TERMINAL_TOLERANCE_M = 0.005
/** The governed pocket leaves only a few millimetres above and below a
 * physical tine. Horizontal insertion is admitted only after live lift
 * feedback is inside this shared geometry tolerance. */
export const FORK_POCKET_VERTICAL_ALIGNMENT_TOLERANCE_M = 0.006

/** Prefer live Mesh height, but keep the compiled support surface authoritative
 * in an EMPTY training world where no background-Mesh sampler exists. */
export function resolvePayloadSupportGroundM(
  meshGroundZM: number | null | undefined,
  registeredSupportTopM: number | null | undefined,
): number | null {
  if (typeof meshGroundZM === "number" && Number.isFinite(meshGroundZM)) return meshGroundZM
  if (typeof registeredSupportTopM === "number" && Number.isFinite(registeredSupportTopM)) {
    return registeredSupportTopM
  }
  return null
}

/** Convert fresh payload-to-ground clearance into one vertical carrier
 * setpoint. A small registered overlap allowance makes MuJoCo produce a real
 * support contact instead of stopping a few millimetres above the Mesh. */
export function resolvePayloadSupportLiftTargetM(input: {
  currentLiftM: number
  bottomGapM: number
  liftRangeM: readonly [number, number]
  contactOverlapM?: number
}) {
  const [lower, upper] = input.liftRangeM
  const values = [input.currentLiftM, input.bottomGapM, lower, upper]
  if (!values.every(Number.isFinite) || lower > upper) return null
  const contactOverlapM = Math.max(0, input.contactOverlapM ?? 0.005)
  return Math.max(
    lower,
    Math.min(upper, input.currentLiftM - Math.max(0, input.bottomGapM) - contactOverlapM),
  )
}

/** Raise an engaged payload by the smallest amount that produces the
 * carrier-qualified transport clearance above its freshly sampled support.
 * The target is derived from live geometry and lift limits; callers never
 * encode a robot-specific joint position or a fixed task sequence. */
export function resolvePayloadTransportLiftTargetM(input: {
  currentLiftM: number
  bottomGapM: number
  transportClearanceM: number
  liftRangeM: readonly [number, number]
}) {
  const [lower, upper] = input.liftRangeM
  const values = [
    input.currentLiftM,
    input.bottomGapM,
    input.transportClearanceM,
    lower,
    upper,
  ]
  if (!values.every(Number.isFinite) || lower > upper || input.transportClearanceM <= 0) return null
  const requiredRiseM = Math.max(0, input.transportClearanceM - input.bottomGapM)
  const unclampedTargetM = input.currentLiftM + requiredRiseM
  const targetM = Math.max(lower, Math.min(upper, unclampedTargetM))
  return {
    targetM,
    requiredRiseM,
    residualM: Math.max(0, unclampedTargetM - targetM),
  }
}

/** Close the slow outer loop around a position-controlled lift after payload
 * mass changes its static sag. MuJoCo's actuator remains the fast servo; this
 * only folds the measured residual back into its control target at a low
 * cadence. The correction is bounded by the registered actuator range and is
 * independent of robot, payload name, mass or task sequence. */
export function resolveLoadCompensatedLiftControlM(input: {
  currentControlM: number
  currentLiftM: number
  targetLiftM: number
  controlRangeM: readonly [number, number]
  maximumCorrectionM?: number
}) {
  const [lower, upper] = input.controlRangeM
  const values = [input.currentControlM, input.currentLiftM, input.targetLiftM, lower, upper]
  if (!values.every(Number.isFinite) || lower > upper) return null
  const maximumCorrectionM = Math.max(0.001, input.maximumCorrectionM ?? 0.05)
  const residualM = input.targetLiftM - input.currentLiftM
  const correctionM = Math.max(-maximumCorrectionM, Math.min(maximumCorrectionM, residualM))
  return Math.max(lower, Math.min(upper, input.currentControlM + correctionM))
}

/** Recompute the remaining lift from the carried payload's measured bottom,
 * rather than assuming mast joint motion and loaded payload motion are
 * identical. This closes the pre-placement loop after suspension/contact sag
 * without encoding a payload mass or a shelf-specific height. */
export function resolvePayloadPrepositionLiftTargetM(input: {
  currentLiftM: number
  currentPayloadBottomM: number
  supportTopM: number
  requiredClearanceM: number
  liftRangeM: readonly [number, number]
}) {
  const [lower, upper] = input.liftRangeM
  const values = [
    input.currentLiftM,
    input.currentPayloadBottomM,
    input.supportTopM,
    input.requiredClearanceM,
    lower,
    upper,
  ]
  if (!values.every(Number.isFinite) || lower > upper || input.requiredClearanceM < 0) return null
  const clearanceM = input.currentPayloadBottomM - input.supportTopM
  const requiredRiseM = Math.max(0, input.requiredClearanceM - clearanceM)
  const unclampedTargetM = input.currentLiftM + requiredRiseM
  const targetM = Math.max(lower, Math.min(upper, unclampedTargetM))
  return { targetM, clearanceM, requiredRiseM, residualM: Math.max(0, unclampedTargetM - targetM) }
}

/** Only ordinary navigation to a carrier-compatible payload resolves to its
 * no-contact staging pose. Dedicated alignment and post-release clearance
 * already carry Host-derived physical endpoints and must keep them verbatim. */
export function fleetNavigationUsesPayloadStaging(operationID: string, hasExcludedObject: boolean) {
  return operationID === "navigate_reserved" && !hasExcludedObject
}

/** Resolve a model-authored support description against Host-qualified
 * placement-support candidates. Exact identity wins; a single compatible
 * candidate is unambiguous even when the VLM used a descriptive level label.
 * Multiple candidates remain unresolved so policy choice stays with the VLM. */
export function resolveUniquePlacementSupportLabel(input: {
  requestedLabel?: string
  candidates: readonly { name: string; catalogKey?: string; semanticRole?: string }[]
}) {
  const exact = input.requestedLabel
    ? input.candidates.filter((candidate) =>
        candidate.name === input.requestedLabel ||
        candidate.catalogKey === input.requestedLabel ||
        candidate.semanticRole === input.requestedLabel)
    : []
  if (exact.length === 1) return exact[0]!.name
  return input.candidates.length === 1 ? input.candidates[0]!.name : input.requestedLabel
}

/** Resolve the released payload even when the VLM describes the destination
 * shelf in its final retreat request. Exact identity still wins; the fallback
 * is only valid when this robot owns one and only one registered load carrier
 * payload, so Host never guesses between multiple pieces of cargo. */
export function resolveUniqueLoadInterfaceLabel(input: {
  requestedLabel?: string
  candidates: readonly { name: string; catalogKey?: string; semanticRole?: string }[]
}) {
  const exact = input.requestedLabel
    ? input.candidates.filter((candidate) =>
        candidate.name === input.requestedLabel ||
        candidate.catalogKey === input.requestedLabel ||
        candidate.semanticRole === input.requestedLabel)
    : []
  if (exact.length === 1) return exact[0]!.name
  return input.candidates.length === 1 ? input.candidates[0]!.name : input.requestedLabel
}

function rotateByQuaternion(
  vector: readonly [number, number, number],
  quaternionWxyz: readonly [number, number, number, number],
): [number, number, number] {
  const [w, x, y, z] = quaternionWxyz
  const [vx, vy, vz] = vector
  const tx = 2 * (y * vz - z * vy)
  const ty = 2 * (z * vx - x * vz)
  const tz = 2 * (x * vy - y * vx)
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ]
}

/** Resolves an asset-declared fork-pocket frame into the current world.
 * This is geometry data, not a task recipe: any load and any carrier can use
 * it when their registry revisions expose compatible interfaces. */
export function resolveForkPocketInsertion(input: {
  objectPositionM: readonly [number, number, number]
  objectQuaternionWxyz: readonly [number, number, number, number]
  loadInterface: ForkPocketLoadInterface
  carrier: LoadCarrierProfile
}) {
  const localAxisLength = Math.hypot(...input.loadInterface.insertionAxisLocalXY)
  if (!Number.isFinite(localAxisLength) || localAxisLength < 1e-6) return null
  const localAxis: [number, number, number] = [
    input.loadInterface.insertionAxisLocalXY[0] / localAxisLength,
    input.loadInterface.insertionAxisLocalXY[1] / localAxisLength,
    0,
  ]
  const rotatedAxis = rotateByQuaternion(localAxis, input.objectQuaternionWxyz)
  const planarLength = Math.hypot(rotatedAxis[0], rotatedAxis[1])
  if (!Number.isFinite(planarLength) || planarLength < 1e-6) return null
  const axisWorldXY: [number, number] = [rotatedAxis[0] / planarLength, rotatedAxis[1] / planarLength]
  const anchor = Math.max(0.05, input.carrier.anchorForwardOffsetM)
  const staging = anchor + Math.max(0.05, input.loadInterface.stagingClearanceM)
  const transformPoint = (local: readonly [number, number, number]): [number, number, number] => {
    const rotated = rotateByQuaternion(local, input.objectQuaternionWxyz)
    return [
      input.objectPositionM[0] + rotated[0],
      input.objectPositionM[1] + rotated[1],
      input.objectPositionM[2] + rotated[2],
    ]
  }
  const upright = rotateByQuaternion([0, 0, 1], input.objectQuaternionWxyz)
  return {
    insertionAxisWorldXY: axisWorldXY,
    insertionYawRad: Math.atan2(axisWorldXY[1], axisWorldXY[0]),
    insertedBasePositionM: [
      input.objectPositionM[0] - axisWorldXY[0] * anchor,
      input.objectPositionM[1] - axisWorldXY[1] * anchor,
    ] as [number, number],
    stagingBasePositionM: [
      input.objectPositionM[0] - axisWorldXY[0] * staging,
      input.objectPositionM[1] - axisWorldXY[1] * staging,
    ] as [number, number],
    pocketCentersWorldM: input.loadInterface.pocketCentersLocalM.map(transformPoint),
    uprightCosine: upright[2],
  }
}

/** Put a carrier on the payload's physical pocket centreline. Preserve extra
 * axial stand-off selected by scene planning, remove lateral error, and face
 * the insertion axis so initial pickup needs straight driving only. */
export function resolveLoadCarrierRunwaySpawn(input: {
  requestedBasePositionM: readonly [number, number]
  objectPositionM: readonly [number, number]
  insertionAxisWorldXY: readonly [number, number]
  minimumBehindDistanceM: number
}): { positionM: [number, number]; yawRad: number; behindDistanceM: number } | null {
  const axisLength = Math.hypot(...input.insertionAxisWorldXY)
  if (
    axisLength < 1e-6 ||
    !input.requestedBasePositionM.every(Number.isFinite) ||
    !input.objectPositionM.every(Number.isFinite) ||
    !Number.isFinite(input.minimumBehindDistanceM) ||
    input.minimumBehindDistanceM <= 0
  ) return null
  const axis: [number, number] = [
    input.insertionAxisWorldXY[0] / axisLength,
    input.insertionAxisWorldXY[1] / axisLength,
  ]
  const requestedDelta: [number, number] = [
    input.requestedBasePositionM[0] - input.objectPositionM[0],
    input.requestedBasePositionM[1] - input.objectPositionM[1],
  ]
  const requestedBehindDistanceM = -(requestedDelta[0] * axis[0] + requestedDelta[1] * axis[1])
  const behindDistanceM = Math.max(input.minimumBehindDistanceM, requestedBehindDistanceM)
  return {
    positionM: [
      input.objectPositionM[0] - axis[0] * behindDistanceM,
      input.objectPositionM[1] - axis[1] * behindDistanceM,
    ],
    yawRad: Math.atan2(axis[1], axis[0]),
    behindDistanceM,
  }
}

/** Measure carrier engagement in the interface frame. A tine tip is expected
 * to pass beyond a pocket centre along the insertion axis, so Euclidean
 * tip-to-centre distance is not an alignment error. Only the perpendicular
 * residual and the signed axial depth are meaningful. */
export function measureForkPocketEngagement(input: {
  insertionAxisWorldXY: readonly [number, number]
  pocketCentersWorldM: readonly (readonly [number, number, number])[]
  tineTipPositionsM: readonly (readonly [number, number, number])[]
}) {
  const [ax, ay] = input.insertionAxisWorldXY
  const axisLength = Math.hypot(ax, ay)
  if (!Number.isFinite(axisLength) || axisLength < 1e-6) return []
  const nx = ax / axisLength
  const ny = ay / axisLength
  return input.tineTipPositionsM.map((tip, index) => {
    const pocket = input.pocketCentersWorldM[index]
    if (!pocket) return null
    const dx = tip[0] - pocket[0]
    const dy = tip[1] - pocket[1]
    const dz = tip[2] - pocket[2]
    const axialDepthM = dx * nx + dy * ny
    // 侧向分量只作为 `transverse_error_m` 的被加数出现：**不外发**（D5，2026-09-27）。
    // 它原先另有一个自己的键（带符号侧向误差），全仓 **0 个读取点**（写点只有这里），
    // 而唯一"带出去"的路径（`cargo-transfer.ts` 的 `mark('engaged', { measurements })`）在
    // 工具出口被 `cargo-transfer-plugin.ts` 的 render 裁成 `{phase,frameId,stepIndex}`（`detail` 整段丢）
    // ⇒ 它**既没有消费点、也到不了用户/模型**；幅值已被 `transverse_error_m = hypot(侧向, 垂直)` 覆盖。
    // 要用它得**先给它一条真正的交付面**（那是一件新增可见性的活，不是这里的清理）。
    // 依据与复算：`bugfixHistory/ZERO-CONSUMER-FIELD-AUDIT-20260926.md` D5。
    const lateralErrorM = -dx * ny + dy * nx
    return {
      axial_depth_m: axialDepthM,
      vertical_error_m: dz,
      transverse_error_m: Math.hypot(lateralErrorM, dz),
    }
  })
}

/** Resolve the chassis XY that places the *measured tine tips* just beyond
 * their matching pocket centres. The carrier anchor is the load centre used
 * while transporting; it is not the fork-tip insertion endpoint. */
export function resolveForkInsertionBaseTarget(input: {
  currentBasePositionM: readonly [number, number]
  insertionAxisWorldXY: readonly [number, number]
  pocketCentersWorldM: readonly (readonly [number, number, number])[]
  tineTipPositionsM: readonly (readonly [number, number, number])[]
  minimumAxialDepthM?: number
}) {
  const [ax, ay] = input.insertionAxisWorldXY
  const length = Math.hypot(ax, ay)
  const depth = input.minimumAxialDepthM ?? FORK_INSERTION_TARGET_AXIAL_DEPTH_M
  if (!Number.isFinite(length) || length < 1e-6 || !Number.isFinite(depth) || depth < 0) return null
  const nx = ax / length
  const ny = ay / length
  const offsets = input.pocketCentersWorldM.flatMap((pocket, index) => {
    const tip = input.tineTipPositionsM[index]
    if (!tip) return []
    return [{
      x: pocket[0] + nx * depth - tip[0],
      y: pocket[1] + ny * depth - tip[1],
    }]
  })
  if (offsets.length < 2) return null
  const dx = offsets.reduce((sum, offset) => sum + offset.x, 0) / offsets.length
  const dy = offsets.reduce((sum, offset) => sum + offset.y, 0) / offsets.length
  return [input.currentBasePositionM[0] + dx, input.currentBasePositionM[1] + dy] as [number, number]
}

/** Resolve the open-space pose from which the carrier may begin its final
 * insertion. This is measured from the physical fork-tip endpoint, not the
 * catalog transport anchor. */
export function resolveForkInsertionStagingTarget(input: {
  insertedBasePositionM: readonly [number, number]
  insertionAxisWorldXY: readonly [number, number]
  stagingClearanceM: number
}) {
  const [ax, ay] = input.insertionAxisWorldXY
  const length = Math.hypot(ax, ay)
  if (!Number.isFinite(length) || length < 1e-6 || !Number.isFinite(input.stagingClearanceM)) return null
  const clearanceM = Math.max(0.18, input.stagingClearanceM)
  return [
    input.insertedBasePositionM[0] - ax / length * clearanceM,
    input.insertedBasePositionM[1] - ay / length * clearanceM,
  ] as [number, number]
}

/** Resolve the two chassis endpoints shared by scene observation, traffic
 * reservation and physical execution. Keeping this as one geometry contract
 * prevents the planner from reserving a catalog/asset-centre pose while the
 * Host later drives toward a different pose derived from the live tine tips. */
export function resolveForkInsertionNavigationTargets(input: {
  currentBasePositionM: readonly [number, number]
  insertionAxisWorldXY: readonly [number, number]
  pocketCentersWorldM: readonly (readonly [number, number, number])[]
  tineTipPositionsM: readonly (readonly [number, number, number])[]
  stagingClearanceM: number
  minimumAxialDepthM?: number
}) {
  const insertedBasePositionM = resolveForkInsertionBaseTarget(input)
  if (!insertedBasePositionM) return null
  const stagingBasePositionM = resolveForkInsertionStagingTarget({
    insertedBasePositionM,
    insertionAxisWorldXY: input.insertionAxisWorldXY,
    stagingClearanceM: input.stagingClearanceM,
  })
  if (!stagingBasePositionM) return null
  return { insertedBasePositionM, stagingBasePositionM }
}

/** Translate the registered pocket entrance height into the carrier's lift
 * joint coordinate using fresh world-space tine tips. This keeps the object
 * interface authoritative: the caller never guesses a crate-specific height,
 * and the same calculation works on an elevated Mesh floor or shelf. */
export function resolveForkPocketLiftTarget(input: {
  pocketCentersWorldM: readonly (readonly [number, number, number])[]
  tineTipPositionsM: readonly (readonly [number, number, number])[]
  currentLiftM: number
  liftRangeM: readonly [number, number]
}) {
  const pairs = input.pocketCentersWorldM.flatMap((pocket, index) => {
    const tip = input.tineTipPositionsM[index]
    if (!tip || ![pocket[2], tip[2]].every(Number.isFinite)) return []
    return [{ pocketZ: pocket[2], tipZ: tip[2] }]
  })
  const [lower, upper] = input.liftRangeM
  if (!pairs.length || ![input.currentLiftM, lower, upper].every(Number.isFinite) || upper <= lower) return null
  const deltaM = pairs.reduce((sum, pair) => sum + pair.pocketZ - pair.tipZ, 0) / pairs.length
  const unclampedTargetM = input.currentLiftM + deltaM
  const targetM = Math.max(lower, Math.min(upper, unclampedTargetM))
  const residualM = unclampedTargetM - targetM
  return { targetM, deltaM, residualM }
}

/** Close the imported position actuator's load- and contact-dependent static
 * error from measured joint feedback. The actuator command is not itself a
 * trustworthy lift height: its sag varies across Mesh contacts and payload
 * states. Each correction is bounded to one small step and the authored
 * control range remains the final fail-closed limit. */
export function resolveMeasuredLiftControlCorrection(input: {
  targetM: number
  measuredM: number
  currentControlM: number
  controlRangeM: readonly [number, number]
  maximumStepM?: number
}) {
  const [lower, upper] = input.controlRangeM
  if (![input.targetM, input.measuredM, input.currentControlM, lower, upper].every(Number.isFinite) || upper <= lower) {
    return null
  }
  const maximumStepM = Math.max(0.005, input.maximumStepM ?? 0.04)
  const errorM = input.targetM - input.measuredM
  const correctionM = Math.max(-maximumStepM, Math.min(maximumStepM, errorM))
  return Math.max(lower, Math.min(upper, input.currentControlM + correctionM))
}

/** Tool-level physical admission for assisted carrying. The Robot VLM still
 * decides whether the semantic task is complete; this gate only prevents the
 * Host from inventing a carry constraint while the forks are beside, above,
 * or merely pushing the payload. */
export function admitForkPocketEngagement(
  measurements: readonly ({ axial_depth_m: number; transverse_error_m: number } | null)[],
  limits: { minimumAxialDepthM?: number; maximumTransverseErrorM?: number } = {},
) {
  const minimumAxialDepthM = limits.minimumAxialDepthM ?? FORK_ENGAGEMENT_MIN_AXIAL_DEPTH_M
  const maximumTransverseErrorM = limits.maximumTransverseErrorM ?? 0.035
  const valid = measurements.filter((measurement): measurement is NonNullable<typeof measurement> =>
    Boolean(measurement) &&
    Number.isFinite(measurement!.axial_depth_m) &&
    Number.isFinite(measurement!.transverse_error_m))
  const admitted = valid.length >= 2 && valid.every((measurement) =>
    measurement.axial_depth_m >= minimumAxialDepthM &&
    measurement.transverse_error_m <= maximumTransverseErrorM)
  return {
    admitted,
    minimumAxialDepthM,
    maximumTransverseErrorM,
    validTineCount: valid.length,
  }
}

export const FORK_INSERTION_MAX_SPEED_MPS = 0.12
export const FORK_TERMINAL_TRANSIT_MIN_SPEED_MPS = 0.12

/** Keep the open-space leg of a load/support docking action above the
 * qualified Mesh chassis breakaway speed. The final pocket/support runway
 * still switches to `forkInsertionSpeedLimit`; this floor applies only while
 * reaching its measured staging pose. */
export function forkTerminalTransitSpeedLimit(requestedSpeedMps: number): number {
  const requested = Number.isFinite(requestedSpeedMps)
    ? requestedSpeedMps
    : FORK_TERMINAL_TRANSIT_MIN_SPEED_MPS
  return Math.max(FORK_TERMINAL_TRANSIT_MIN_SPEED_MPS, Math.min(0.8, requested))
}

/** The final pocket approach is a contact-sensitive insertion, not ordinary
 * route travel. Keep it slow even when the traffic reservation or VLM asks
 * for a higher route speed. */
export function forkInsertionSpeedLimit(requestedSpeedMps: number): number {
  const requested = Number.isFinite(requestedSpeedMps) ? requestedSpeedMps : FORK_INSERTION_MAX_SPEED_MPS
  return Math.max(0.05, Math.min(FORK_INSERTION_MAX_SPEED_MPS, requested))
}

type ForkEngagementMeasurement = { axial_depth_m: number; transverse_error_m: number } | null

function minimumFiniteDepth(measurements: readonly ForkEngagementMeasurement[]): number | null {
  const values = measurements
    .flatMap((measurement) => measurement && Number.isFinite(measurement.axial_depth_m)
      ? [measurement.axial_depth_m]
      : [])
  return values.length >= 2 ? Math.min(...values) : null
}

/** Detect the characteristic failure where the payload moves across the floor
 * but both tine tips fail to make corresponding progress inside the pockets. */
export function assessForkInsertionProgress(input: {
  initialPayloadPositionM: readonly [number, number, number]
  currentPayloadPositionM: readonly [number, number, number]
  initialInsertionAxisWorldXY?: readonly [number, number]
  currentInsertionAxisWorldXY?: readonly [number, number]
  initialMeasurements: readonly ForkEngagementMeasurement[]
  currentMeasurements: readonly ForkEngagementMeasurement[]
  maximumPayloadPushM?: number
  maximumPayloadPoseTranslationM?: number
  maximumPayloadHeadingChangeRad?: number
  minimumDepthGainM?: number
}) {
  const payloadDisplacementM = Math.hypot(
    input.currentPayloadPositionM[0] - input.initialPayloadPositionM[0],
    input.currentPayloadPositionM[1] - input.initialPayloadPositionM[1],
  )
  const initialDepthM = minimumFiniteDepth(input.initialMeasurements)
  const currentDepthM = minimumFiniteDepth(input.currentMeasurements)
  const depthGainM = initialDepthM === null || currentDepthM === null
    ? 0
    : currentDepthM - initialDepthM
  const admission = admitForkPocketEngagement(input.currentMeasurements)
  const maximumPayloadPushM = input.maximumPayloadPushM ?? 0.025
  const maximumPayloadPoseTranslationM = input.maximumPayloadPoseTranslationM ?? 0.04
  const initialAxis = input.initialInsertionAxisWorldXY
  const currentAxis = input.currentInsertionAxisWorldXY
  const payloadHeadingChangeRad = initialAxis && currentAxis
    ? Math.abs(Math.atan2(
        initialAxis[0] * currentAxis[1] - initialAxis[1] * currentAxis[0],
        initialAxis[0] * currentAxis[0] + initialAxis[1] * currentAxis[1],
      ))
    : 0
  // A light two-tine contact can yaw a freely resting crate by roughly 3.5°
  // while remaining inside the measured 35 mm transverse pocket envelope.
  // Stop before the stale frame becomes unsafe, but do not abort at that
  // qualified contact boundary; 0.08 rad is about 4.6°.
  const maximumPayloadHeadingChangeRad = input.maximumPayloadHeadingChangeRad ?? 0.08
  const minimumDepthGainM = input.minimumDepthGainM ?? 0.01
  return {
    pushed: !admission.admitted && payloadDisplacementM > maximumPayloadPushM && depthGainM < minimumDepthGainM,
    poseChanged: payloadDisplacementM > maximumPayloadPoseTranslationM || payloadHeadingChangeRad > maximumPayloadHeadingChangeRad,
    payloadDisplacementM,
    payloadHeadingChangeRad,
    depthGainM,
    admission,
  }
}

/** Release is safe only after the payload bottom is at the sampled Mesh
 * support, a real support contact exists, and residual motion is settled. */
export function assessPayloadReleaseSupport(input: {
  objectCenterZM: number
  objectHalfHeightM: number
  groundZM: number
  supportContactCount: number
  linearSpeedMps: number
  angularSpeedRadps: number
  maximumBottomGapM?: number
}) {
  const bottomGapM = input.objectCenterZM - input.objectHalfHeightM - input.groundZM
  // Imported support meshes often have a few centimetres of visual/collision
  // surface disagreement. Real contact plus a settled payload is stronger
  // placement evidence than a tight height-only match, so tolerate up to
  // 40 mm while retaining the contact and motion gates below.
  const maximumBottomGapM = input.maximumBottomGapM ?? 0.04
  const finite = [
    bottomGapM,
    input.supportContactCount,
    input.linearSpeedMps,
    input.angularSpeedRadps,
  ].every(Number.isFinite)
  const supported = finite &&
    input.supportContactCount > 0 &&
    Math.abs(bottomGapM) <= maximumBottomGapM &&
    input.linearSpeedMps <= 0.05 &&
    input.angularSpeedRadps <= 0.2
  return { supported, bottomGapM, maximumBottomGapM }
}

/** A push failure remains latched until the chassis has moved backwards far
 * enough along the exact insertion axis recorded at failure time. Lateral or
 * forward motion cannot accidentally clear the recovery gate. */
export function assessForkRetreatClearance(input: {
  failureBasePositionM: readonly [number, number]
  currentBasePositionM: readonly [number, number]
  insertionAxisWorldXY: readonly [number, number]
  minimumRetreatM?: number
}) {
  const axisLength = Math.hypot(input.insertionAxisWorldXY[0], input.insertionAxisWorldXY[1])
  const axis: readonly [number, number] = axisLength > 1e-9
    ? [input.insertionAxisWorldXY[0] / axisLength, input.insertionAxisWorldXY[1] / axisLength]
    : [1, 0]
  const deltaX = input.currentBasePositionM[0] - input.failureBasePositionM[0]
  const deltaY = input.currentBasePositionM[1] - input.failureBasePositionM[1]
  const retreatDistanceM = Math.max(0, -(deltaX * axis[0] + deltaY * axis[1]))
  const minimumRetreatM = input.minimumRetreatM ?? 0.12
  return {
    cleared: retreatDistanceM >= minimumRetreatM,
    retreatDistanceM,
    remainingRetreatM: Math.max(0, minimumRetreatM - retreatDistanceM),
    minimumRetreatM,
  }
}

/** Verify the physical post-release terminal state from fresh geometry. Both
 * tine tips must be behind a conservative planar bound of the released load,
 * measured along its registered insertion axis. This is deliberately stricter
 * than merely deleting the assisted hold or reaching a chassis waypoint. */
export function assessReleasedPayloadForkClearance(input: {
  payloadCenterM: readonly [number, number, number]
  payloadHalfExtentsM: readonly [number, number, number]
  insertionAxisWorldXY: readonly [number, number]
  tineTipPositionsM: readonly (readonly [number, number, number])[]
  marginM?: number
}) {
  const axisLength = Math.hypot(input.insertionAxisWorldXY[0], input.insertionAxisWorldXY[1])
  const finite = [
    ...input.payloadCenterM,
    ...input.payloadHalfExtentsM,
    ...input.insertionAxisWorldXY,
    ...input.tineTipPositionsM.flat(),
  ].every(Number.isFinite)
  if (!finite || axisLength < 1e-9 || input.tineTipPositionsM.length < 2) {
    return { cleared: false, minimumAxialClearanceM: Number.NEGATIVE_INFINITY, requiredAxialClearanceM: 0 }
  }
  const axis: readonly [number, number] = [
    input.insertionAxisWorldXY[0] / axisLength,
    input.insertionAxisWorldXY[1] / axisLength,
  ]
  const requiredAxialClearanceM = Math.hypot(input.payloadHalfExtentsM[0], input.payloadHalfExtentsM[1]) +
    Math.max(0.01, input.marginM ?? 0.02)
  const axialClearancesM = input.tineTipPositionsM.map((tip) =>
    -((tip[0] - input.payloadCenterM[0]) * axis[0] + (tip[1] - input.payloadCenterM[1]) * axis[1]))
  const minimumAxialClearanceM = Math.min(...axialClearancesM)
  return {
    cleared: minimumAxialClearanceM >= requiredAxialClearanceM,
    minimumAxialClearanceM,
    requiredAxialClearanceM,
  }
}

export function forkRetreatRecoveryActionAllowed(hostPrimitive: string, operationId: string): boolean {
  if (hostPrimitive === "stop_motion") return true
  if (hostPrimitive === "navigate_reserved" && operationId === "clear_released_payload") return true
  return hostPrimitive === "adapter_program" &&
    ["drive_reverse", "stop_drive", "read_full_state"].includes(operationId)
}

/** Bind a shelf-clearance retreat to the same support and insertion axis that
 * produced the failure. Only this reverse escape may omit that support from
 * path obstacles; later forward motion restores ordinary collision checks. */
export function resolveSupportClearanceRetreatNavigation(input: {
  operationID: string
  direction: unknown
  reason?: string
  supportObject?: string
  insertionAxisWorldXY?: readonly [number, number]
}) {
  const axis = input.insertionAxisWorldXY
  if (
    input.operationID !== "navigate_relative_reserved" ||
    input.direction !== "backward" ||
    input.reason !== "placement_support_clearance_insufficient" ||
    typeof input.supportObject !== "string" || !input.supportObject ||
    !axis || !axis.every(Number.isFinite) || Math.hypot(axis[0], axis[1]) < 1e-9
  ) return null
  return {
    supportObject: input.supportObject,
    straightReverseAxis: [axis[0], axis[1]] as [number, number],
  }
}

/** Resolve whether navigation is physically carrying a payload. A recovery
 * from a failed pre-engagement insertion is necessarily unloaded even when a
 * model repeats a stale carrying_payload flag. Shelf-clearance recovery occurs
 * after engagement and therefore keeps the ordinary carrying contract. */
export function resolveLoadCarrierNavigationCarriesPayload(input: {
  operationID: string
  requestedCarryingPayload: boolean
  retreatDirection?: unknown
  retreatRequirementReason?: string
}) {
  const unengagedInsertionRetreat =
    input.operationID === "navigate_relative_reserved" &&
    input.retreatDirection === "backward" &&
    typeof input.retreatRequirementReason === "string" &&
    input.retreatRequirementReason !== "placement_support_clearance_insufficient"
  return !unengagedInsertionRetreat && (
    input.requestedCarryingPayload || input.operationID === "align_load_carrier_with_support"
  )
}

/** Select the physical exit axis for a clearance retreat. A push can rotate a
 * free payload after the failure is observed, so an active recovery must keep
 * the insertion axis captured at failure time instead of chasing the newly
 * rotated payload frame. Ordinary post-release clearance has no recorded axis
 * and continues to use the fresh registered load-interface geometry. */
export function resolveForkClearanceExitAxis(input: {
  liveInsertionAxisWorldXY?: readonly [number, number]
  recordedFailureAxisWorldXY?: readonly [number, number]
}): [number, number] | null {
  const candidate = input.recordedFailureAxisWorldXY ?? input.liveInsertionAxisWorldXY
  if (!candidate || !candidate.every(Number.isFinite)) return null
  const length = Math.hypot(candidate[0], candidate[1])
  if (length < 1e-9) return null
  return [candidate[0] / length, candidate[1] / length]
}

export function forkRetreatNavigationAllowed(input: {
  currentBasePositionM: readonly [number, number]
  targetBasePositionM: readonly [number, number]
  insertionAxisWorldXY: readonly [number, number]
  direction?: unknown
  minimumReverseProjectionM?: number
  maximumLateralErrorM?: number
}): boolean {
  if (input.direction !== "backward") return false
  const axisLength = Math.hypot(input.insertionAxisWorldXY[0], input.insertionAxisWorldXY[1])
  if (axisLength < 1e-9) return false
  const axisX = input.insertionAxisWorldXY[0] / axisLength
  const axisY = input.insertionAxisWorldXY[1] / axisLength
  const dx = input.targetBasePositionM[0] - input.currentBasePositionM[0]
  const dy = input.targetBasePositionM[1] - input.currentBasePositionM[1]
  const reverseProjectionM = -(dx * axisX + dy * axisY)
  const lateralErrorM = Math.abs(dx * -axisY + dy * axisX)
  return reverseProjectionM >= (input.minimumReverseProjectionM ?? 0.1) &&
    lateralErrorM <= (input.maximumLateralErrorM ?? 0.05)
}
