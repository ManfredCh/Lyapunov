/**
 * scene-ground — "what is the real floor height at (x, y)?"
 *
 * The aligned scene mesh is the single collision truth (see
 * the world-model mesh collision architecture).
 * Everything that has to put
 * something *down* — a robot base, a spawned object, a placed object — needs the
 * ground Z of a column, not the fake z=0 of the built-in `mj_floor` plane. This
 * module answers that from the canonical BVH, so the viewer, the runtime and the
 * command dispatcher all land on the same surface the patch actually compiles.
 *
 * Rays are cast **upward from below the mesh**, never downward from above: a
 * scanned room has a ceiling, and the winding-derived triangle normals cannot
 * distinguish a ceiling from a floor (both are "level"). The first surface a
 * column meets from underneath is the ground.
 */

import type { CanonicalTriangleSpatialIndex } from "./spatial-index.ts"

export interface SceneGroundSample {
  /** Ground top Z (m, MuJoCo frame) — the height a body rests at. */
  z: number
  /** |n·z| of the ground triangle: 1 = perfectly level. */
  upDot: number
  /** Tilt of the ground triangle away from level. */
  slopeDeg: number
  /** Fraction of the probed columns that found ground (1 = the whole footprint). */
  coverage: number
  /** Ground-Z spread across the footprint (m). 0 when only the centre was probed. */
  spreadM: number
}

export type SceneGroundRejectReason = "no_ground" | "uneven_ground"

export type SceneGroundResult =
  | { ok: true; sample: SceneGroundSample }
  | { ok: false; reason: SceneGroundRejectReason; message: string }

export interface SceneGroundResolver {
  /**
   * Ground under the column at (x, y), in the MuJoCo frame.
   *
   * `footprintRadiusM > 0` probes a ring around the column as well: the answer is
   * then the *median* of the columns that found ground (so one hole in the scan
   * cannot drag the result up onto a table underside), and a footprint straddling
   * a step / ledge is rejected instead of silently averaging across it.
   */
  sample(x: number, y: number, footprintRadiusM?: number): SceneGroundResult
}

export interface SceneGroundResolverOptions {
  /** |n·z| a triangle needs to count as ground at all. Default 0.55 — the same
   *  "roughly level" bar the voxel support builder uses. Callers apply their own,
   *  stricter slope gate (a robot base wants `ROBOT_BASE_MAX_SLOPE_DEG`). */
  minUpDot?: number
  /** How far a column may sit from the footprint's ground height and still be the
   *  same surface. */
  maxStepM?: number
  /** Share of a footprint's columns allowed to disagree with its ground height before
   *  the footprint is called uneven. A scan hole lets one or two columns shoot through
   *  and hit whatever hangs above — that is an artifact and the median already ignores
   *  it. A real step puts *half* the footprint at another height, and that must be
   *  refused. */
  maxOutlierFraction?: number
  /** Ring columns probed around the centre when a footprint radius is given. */
  ringSamples?: number
  /** Fraction of a footprint's columns that must find ground at all. */
  minCoverage?: number
  /** How far below the mesh each upward ray starts. */
  marginM?: number
}

const DEFAULT_MIN_UP_DOT = 0.55
const DEFAULT_MAX_STEP_M = 0.08
const DEFAULT_MAX_OUTLIER_FRACTION = 0.25
const DEFAULT_RING_SAMPLES = 8
const DEFAULT_MIN_COVERAGE = 0.6
const DEFAULT_MARGIN_M = 1

interface ColumnHit {
  z: number
  upDot: number
}

function slopeDegOf(upDot: number): number {
  return (Math.acos(Math.max(-1, Math.min(1, upDot))) * 180) / Math.PI
}

/**
 * Ground resolver backed by the canonical (MuJoCo-frame) triangle BVH of the
 * confirmed aligned mesh. Returns null when the index holds no geometry — the
 * caller must then treat the scene as having no known ground rather than
 * assuming z=0.
 */
export function createAlignedMeshGroundResolver(
  index: Pick<CanonicalTriangleSpatialIndex, "raycast" | "bounds">,
  options: SceneGroundResolverOptions = {},
): SceneGroundResolver | null {
  const bounds = index.bounds
  if (!bounds) return null

  const minUpDot = options.minUpDot ?? DEFAULT_MIN_UP_DOT
  const maxStepM = options.maxStepM ?? DEFAULT_MAX_STEP_M
  const maxOutlierFraction = options.maxOutlierFraction ?? DEFAULT_MAX_OUTLIER_FRACTION
  const ringSamples = Math.max(0, Math.trunc(options.ringSamples ?? DEFAULT_RING_SAMPLES))
  const minCoverage = options.minCoverage ?? DEFAULT_MIN_COVERAGE
  const marginM = options.marginM ?? DEFAULT_MARGIN_M

  const originZ = bounds.min[2] - marginM
  const far = bounds.max[2] - originZ + marginM

  const probeColumn = (x: number, y: number): ColumnHit | null => {
    const hit = index.raycast({ origin: [x, y, originZ], direction: [0, 0, 1], far })
    if (!hit) return null
    const upDot = Math.abs(hit.normal[2])
    if (!Number.isFinite(hit.point[2]) || upDot < minUpDot) return null
    return { z: hit.point[2], upDot }
  }

  return {
    sample(x, y, footprintRadiusM = 0) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, reason: "no_ground", message: "ground query must use finite x/y" }
      }
      const radius = Number.isFinite(footprintRadiusM) && footprintRadiusM > 0 ? footprintRadiusM : 0
      const columns: Array<[number, number]> = [[x, y]]
      if (radius > 0) {
        for (let i = 0; i < ringSamples; i++) {
          const angle = (2 * Math.PI * i) / ringSamples
          columns.push([x + radius * Math.cos(angle), y + radius * Math.sin(angle)])
        }
      }

      const hits = columns.map(([cx, cy]) => probeColumn(cx, cy)).filter((hit): hit is ColumnHit => hit !== null)
      const coverage = hits.length / columns.length
      if (hits.length === 0) {
        return {
          ok: false,
          reason: "no_ground",
          message: `(${x.toFixed(2)}, ${y.toFixed(2)}) 处没有对齐 mesh 地面`,
        }
      }
      if (radius > 0 && coverage < minCoverage) {
        return {
          ok: false,
          reason: "no_ground",
          message: `落点 ${(radius * 100).toFixed(0)}cm 半径内只有 ${(coverage * 100).toFixed(0)}% 有地面`,
        }
      }

      // The median is the footprint's ground: a column that shot through a hole in the
      // scan and hit a table's underside is outvoted by the columns that found floor.
      const sorted = [...hits].sort((left, right) => left.z - right.z)
      const median = sorted[Math.floor((sorted.length - 1) / 2)]
      const spreadM = sorted[sorted.length - 1].z - sorted[0].z
      if (radius > 0) {
        const outliers = hits.filter((hit) => Math.abs(hit.z - median.z) > maxStepM)
        if (outliers.length / hits.length > maxOutlierFraction) {
          return {
            ok: false,
            reason: "uneven_ground",
            message: `落点跨越 ${(spreadM * 100).toFixed(1)}cm 的高低差(台阶/边沿):${outliers.length}/${hits.length} 个采样点不在同一个面上`,
          }
        }
      }

      return {
        ok: true,
        sample: {
          z: median.z,
          upDot: median.upDot,
          slopeDeg: slopeDegOf(median.upDot),
          coverage,
          spreadM,
        },
      }
    },
  }
}
