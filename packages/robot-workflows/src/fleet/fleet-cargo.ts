import type { FleetPoint } from "./fleet-path"

export interface ForkliftCargoPlan {
  pickupYaw: number
  dropYaw: number
  pickupStagingBase: FleetPoint
  pickupBase: FleetPoint
  dropStagingBase: FleetPoint
  dropBase: FleetPoint
}

function finite(value: number, label: string) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`)
  return value
}

function wrapAngle(value: number) {
  let angle = value
  while (angle > Math.PI) angle -= Math.PI * 2
  while (angle < -Math.PI) angle += Math.PI * 2
  return angle
}

function behind(target: FleetPoint, yaw: number, distanceM: number): FleetPoint {
  return [target[0] - Math.cos(yaw) * distanceM, target[1] - Math.sin(yaw) * distanceM]
}

/** Converts a semantic cargo target into base poses. The product API names an
 * object and its desired cargo centre; raw wheel/lift actuator values remain
 * private to the sim Provider. */
export function planForkliftCargo(input: {
  base: FleetPoint
  cargo: FleetPoint
  dropTarget: FleetPoint
  pickupYaw?: number
  dropYaw?: number
  loadCenterOffsetM?: number
  stagingClearanceM?: number
}): ForkliftCargoPlan {
  const base: FleetPoint = [finite(input.base[0], "base.x"), finite(input.base[1], "base.y")]
  const cargo: FleetPoint = [finite(input.cargo[0], "cargo.x"), finite(input.cargo[1], "cargo.y")]
  const drop: FleetPoint = [finite(input.dropTarget[0], "drop.x"), finite(input.dropTarget[1], "drop.y")]
  const inferredYaw = Math.atan2(cargo[1] - base[1], cargo[0] - base[0])
  const pickupYaw = wrapAngle(input.pickupYaw === undefined ? inferredYaw : finite(input.pickupYaw, "pickupYaw"))
  const dropYaw = wrapAngle(input.dropYaw === undefined ? pickupYaw : finite(input.dropYaw, "dropYaw"))
  const loadCenterOffsetM = Math.max(0.2, Math.min(1, input.loadCenterOffsetM ?? 0.44))
  const stagingClearanceM = Math.max(0.18, Math.min(1, input.stagingClearanceM ?? 0.34))
  return {
    pickupYaw,
    dropYaw,
    pickupBase: behind(cargo, pickupYaw, loadCenterOffsetM),
    pickupStagingBase: behind(cargo, pickupYaw, loadCenterOffsetM + stagingClearanceM),
    dropBase: behind(drop, dropYaw, loadCenterOffsetM),
    dropStagingBase: behind(drop, dropYaw, loadCenterOffsetM + stagingClearanceM),
  }
}

export function forkliftLiftTargetForSurface(input: {
  currentLiftM: number
  currentLoadSiteZ: number
  surfaceZ: number
  siteAboveForkTopM?: number
  lower: number
  upper: number
}) {
  const siteAboveForkTopM = input.siteAboveForkTopM ?? 0.006
  const targetSiteZ = finite(input.surfaceZ, "surfaceZ") + siteAboveForkTopM
  const raw = finite(input.currentLiftM, "currentLiftM") + targetSiteZ - finite(input.currentLoadSiteZ, "currentLoadSiteZ")
  return Math.max(input.lower, Math.min(input.upper, raw))
}

/** Returns a post-load retreat pose that leaves enough room for the carried
 * object's swept planar radius. The ordinary staging point only clears the
 * vehicle body; a long pallet can otherwise clip the rack as steering begins. */
export function forkliftLoadedRetreatTarget(input: {
  stagingBase: FleetPoint
  pickupYaw: number
  cargoHalfExtents: readonly [number, number, number]
}): { target: FleetPoint; extraClearanceM: number } {
  const radius = Math.hypot(
    finite(input.cargoHalfExtents[0], "cargoHalfExtents.x"),
    finite(input.cargoHalfExtents[1], "cargoHalfExtents.y"),
  )
  const extraClearanceM = Math.max(0.6, Math.min(1.5, radius + 0.75))
  return {
    target: [
      input.stagingBase[0] - Math.cos(input.pickupYaw) * extraClearanceM,
      input.stagingBase[1] - Math.sin(input.pickupYaw) * extraClearanceM,
    ],
    extraClearanceM,
  }
}

/** Conservative planar envelope for a carried load around the vehicle base.
 * Cargo is supported in front of a forklift rather than centred on its base,
 * so using only the cargo radius underestimates the swept corner by the whole
 * base-to-load offset.  The circumradius keeps this valid while either the
 * vehicle or an arbitrarily-oriented imported payload is turning. */
export function forkliftCarriedSweptRadius(input: {
  base: FleetPoint
  cargo: FleetPoint
  cargoHalfExtents: readonly [number, number, number]
  robotRadiusM: number
}): number {
  const baseToCargoM = Math.hypot(
    finite(input.cargo[0], "cargo.x") - finite(input.base[0], "base.x"),
    finite(input.cargo[1], "cargo.y") - finite(input.base[1], "base.y"),
  )
  const cargoRadiusM = Math.hypot(
    finite(input.cargoHalfExtents[0], "cargoHalfExtents.x"),
    finite(input.cargoHalfExtents[1], "cargoHalfExtents.y"),
  )
  return Math.max(Math.max(0, finite(input.robotRadiusM, "robotRadiusM")), baseToCargoM + cargoRadiusM)
}

/** Desktop MuJoCo can run below real time while rendering large imported mesh
 * assets. Give the physical position servo enough wall time to accumulate its
 * required simulation seconds without removing the finite timeout. */
export function forkliftLiftWaitBudgetMs(travelM: number): number {
  const distance = Math.max(0, Number.isFinite(travelM) ? Math.abs(travelM) : 0)
  return Math.max(45_000, Math.min(120_000, 30_000 + distance * 180_000))
}

export interface ForkliftNavigationBudget {
  simulationSeconds: number
  wallMs: number
  stallSimulationSeconds: number
}

/** Cargo navigation is a physics operation, so its useful deadline must be
 * measured primarily in simulation time. Imported mesh scenes can run at
 * 0.2x real time while the Desktop is visible; a short wall-clock-only gate
 * otherwise aborts a forklift that is still making measurable progress. The
 * independent wall cap still catches a paused or dead runtime. */
export function forkliftNavigationBudget(distanceM: number): ForkliftNavigationBudget {
  const distance = Math.max(0, Number.isFinite(distanceM) ? Math.abs(distanceM) : 0)
  return {
    simulationSeconds: Math.max(30, Math.min(180, 25 + distance * 35)),
    wallMs: Math.max(120_000, Math.min(480_000, 90_000 + distance * 150_000)),
    stallSimulationSeconds: Math.max(12, Math.min(30, 10 + distance * 8)),
  }
}

export interface ForkliftCargoEvidence {
  horizontalErrorM: number
  cargoLiftM: number
  forkLiftM: number
  followedLiftErrorM: number
  contactObserved: boolean | null
}

/** Permissive physical evidence gate. Contact is retained as evidence when the
 * WASM build exposes it, but observable cargo motion remains sufficient so an
 * imported model is not rejected solely by a missing contact API. */
export function evaluateForkliftCargoLoad(input: {
  cargoBefore: readonly [number, number, number]
  cargoAfter: readonly [number, number, number]
  loadSiteBefore: readonly [number, number, number]
  loadSiteAfter: readonly [number, number, number]
  contactObserved: boolean | null
}): { loaded: boolean; evidence: ForkliftCargoEvidence } {
  const cargoLiftM = input.cargoAfter[2] - input.cargoBefore[2]
  const forkLiftM = input.loadSiteAfter[2] - input.loadSiteBefore[2]
  const horizontalErrorM = Math.hypot(
    input.cargoAfter[0] - input.loadSiteAfter[0],
    input.cargoAfter[1] - input.loadSiteAfter[1],
  )
  const followedLiftErrorM = Math.abs(cargoLiftM - forkLiftM)
  const evidence = { horizontalErrorM, cargoLiftM, forkLiftM, followedLiftErrorM, contactObserved: input.contactObserved }
  return {
    loaded:
      cargoLiftM >= 0.02 &&
      forkLiftM >= 0.02 &&
      horizontalErrorM <= 0.32 &&
      followedLiftErrorM <= 0.16 &&
      input.cargoAfter.every(Number.isFinite),
    evidence,
  }
}

export function evaluateForkliftCargoDrop(input: {
  cargo: readonly [number, number, number]
  dropTarget: FleetPoint
  expectedCenterZ: number
  cargoTravelM: number
}): { delivered: boolean; horizontalErrorM: number; verticalErrorM: number } {
  const horizontalErrorM = Math.hypot(input.cargo[0] - input.dropTarget[0], input.cargo[1] - input.dropTarget[1])
  const verticalErrorM = Math.abs(input.cargo[2] - input.expectedCenterZ)
  return {
    delivered:
      input.cargo.every(Number.isFinite) &&
      horizontalErrorM <= 0.28 &&
      verticalErrorM <= 0.1 &&
      input.cargoTravelM >= 0.2,
    horizontalErrorM,
    verticalErrorM,
  }
}

/** Permissive hand-off from chassis approach to cargo placement. The payload
 * position is the user-visible objective; an imported forklift need not hit a
 * synthetic base pose exactly before it may lower a load already in the drop
 * area. Final settlement remains separately observed after fork withdrawal. */
export function forkliftCargoWithinDropApproach(input: {
  cargo: readonly [number, number, number]
  dropTarget: FleetPoint
  toleranceM?: number
}): { within: boolean; horizontalErrorM: number } {
  const horizontalErrorM = Math.hypot(input.cargo[0] - input.dropTarget[0], input.cargo[1] - input.dropTarget[1])
  return {
    within: input.cargo.every(Number.isFinite) && horizontalErrorM <= (input.toleranceM ?? 0.4),
    horizontalErrorM,
  }
}
