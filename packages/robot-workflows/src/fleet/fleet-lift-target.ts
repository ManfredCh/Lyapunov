/** Resolve a registration-authored lift command against the current compiled
 * actuator range. Registrations may expose a portable 0..1 target or the
 * actuator's physical metre unit. The Host owns range clamping in both cases;
 * no robot id, fork geometry or task sequence is encoded here. */
export function resolveFleetLiftTargetM(
  parameters: Record<string, unknown>,
  range: { lower: number; upper: number },
): number | undefined {
  if (![range.lower, range.upper].every(Number.isFinite) || range.upper <= range.lower) return
  if (typeof parameters.target_normalized === "number" && Number.isFinite(parameters.target_normalized)) {
    const normalized = Math.max(0, Math.min(1, parameters.target_normalized))
    return range.lower + normalized * (range.upper - range.lower)
  }
  if (typeof parameters.height_m === "number" && Number.isFinite(parameters.height_m)) {
    return Math.max(range.lower, Math.min(range.upper, parameters.height_m))
  }
}
