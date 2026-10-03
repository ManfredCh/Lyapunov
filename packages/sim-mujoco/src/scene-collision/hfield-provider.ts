import type { CanonicalTriangleSpatialIndex } from "./spatial-index.ts"
import type { Bounds3 } from "./glb-mesh.ts"

export const SCENE_HFIELD_PROVIDER_VERSION = "scene-hfield-support-prototype-v1" as const

export type SceneHfieldNormalMode = "positive-z" | "absolute-z"
export type SceneHfieldHeightMode = "highest" | "lowest"

export interface SceneHeightfieldCollision {
  kind: "scene-heightfield-collision"
  providerVersion: typeof SCENE_HFIELD_PROVIDER_VERSION
  name: string
  frame: "mujoco-z-up-meters"
  nrow: number
  ncol: number
  bounds: Bounds3
  origin: [number, number, number]
  size: [number, number, number, number]
  elevation: Float32Array
  stats: {
    sampledColumns: number
    hitColumns: number
    supportColumns: number
    filledColumns: number
    coverage: number
    minZ: number
    maxZ: number
    sampleStepM: number
    normalMode: SceneHfieldNormalMode
    heightMode: SceneHfieldHeightMode
    /** Columns levelled onto the dominant floor plane, when enabled. */
    flattenedColumns?: number
    dominantGroundZ?: number
  }
  warnings: readonly string[]
}

export interface BuildSceneHeightfieldCollisionInput {
  index: Pick<CanonicalTriangleSpatialIndex, "raycast" | "bounds">
  name?: string
  sampleStepM?: number
  maxRows?: number
  maxCols?: number
  minUpDot?: number
  normalMode?: SceneHfieldNormalMode
  heightMode?: SceneHfieldHeightMode
  marginM?: number
  holeDropM?: number
  baseThicknessM?: number
  maxHitsPerColumn?: number
  supportBasePercentile?: number
  maxSupportHeightAboveBaseM?: number
  maxSupportDepthBelowBaseM?: number
  smoothingRadiusCells?: number
  /** Automatically level a dominant near-horizontal floor band while leaving
   *  ramps, steps and platforms outside this relief band untouched. */
  flattenDominantGroundBandM?: number
  flattenDominantGroundMinFraction?: number
}

/**
 * Read the contact height represented by the hfield that is actually handed to
 * MuJoCo.  Scene placement must not go back to the source Mesh after the
 * provider has filtered, smoothed and filled its columns: those two surfaces
 * can differ substantially, which would initialise a body inside the compiled
 * ground and let the contact solver eject it sideways.
 *
 * The provider stores rows along Y and columns along X in the same row-major
 * order written to MJCF.  Bilinear interpolation keeps placement continuous
 * between samples; MuJoCo triangulates the same cell, so the only possible
 * difference on a non-planar cell is bounded by that cell's local relief.
 */
export function sampleSceneHeightfieldTopZ(
  hfield: SceneHeightfieldCollision,
  x: number,
  y: number,
): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const minX = hfield.bounds.min[0]
  const maxX = hfield.bounds.max[0]
  const minY = hfield.bounds.min[1]
  const maxY = hfield.bounds.max[1]
  if (x < minX || x > maxX || y < minY || y > maxY) return null
  if (hfield.nrow < 2 || hfield.ncol < 2 || hfield.elevation.length !== hfield.nrow * hfield.ncol) return null

  const column = ((x - minX) / (maxX - minX)) * (hfield.ncol - 1)
  const row = ((y - minY) / (maxY - minY)) * (hfield.nrow - 1)
  const col0 = Math.min(hfield.ncol - 1, Math.max(0, Math.floor(column)))
  const row0 = Math.min(hfield.nrow - 1, Math.max(0, Math.floor(row)))
  const col1 = Math.min(hfield.ncol - 1, col0 + 1)
  const row1 = Math.min(hfield.nrow - 1, row0 + 1)
  const tx = column - col0
  const ty = row - row0
  const at = (r: number, c: number) => hfield.elevation[r * hfield.ncol + c]!
  const low = at(row0, col0) * (1 - tx) + at(row0, col1) * tx
  const high = at(row1, col0) * (1 - tx) + at(row1, col1) * tx
  const normalized = low * (1 - ty) + high * ty
  if (!Number.isFinite(normalized)) return null
  return hfield.origin[2] + normalized * hfield.size[2]
}

/** Median compiled contact height under a circular footprint. */
export function sampleSceneHeightfieldFootprintTopZ(
  hfield: SceneHeightfieldCollision,
  x: number,
  y: number,
  footprintRadiusM = 0,
): number | null {
  const radius = Number.isFinite(footprintRadiusM) && footprintRadiusM > 0 ? footprintRadiusM : 0
  const points: Array<[number, number]> = [[x, y]]
  if (radius > 0) {
    for (let i = 0; i < 8; i++) {
      const angle = (2 * Math.PI * i) / 8
      points.push([x + radius * Math.cos(angle), y + radius * Math.sin(angle)])
    }
  }
  const heights = points
    .map(([sampleX, sampleY]) => sampleSceneHeightfieldTopZ(hfield, sampleX, sampleY))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)
  return heights.length > 0 ? heights[Math.floor((heights.length - 1) / 2)]! : null
}

/** Contact-height range below a rigid rectangular footprint. Sampling the
 * centre, edge midpoints and corners catches Mesh steps that a centre/median
 * probe can hide. A flat-bottom payload must be spawned on the highest sample,
 * and excessive relief must be rejected before it can rock or bounce. */
export function sampleSceneHeightfieldOrientedFootprintRange(
  hfield: SceneHeightfieldCollision,
  x: number,
  y: number,
  yaw: number,
  halfExtents: readonly [number, number],
): { minimumZ: number; maximumZ: number; reliefM: number } | null {
  if (
    ![x, y, yaw, halfExtents[0], halfExtents[1]].every(Number.isFinite) ||
    halfExtents[0] < 0 || halfExtents[1] < 0
  ) return null
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const offsets = [-1, 0, 1] as const
  const heights: number[] = []
  for (const ix of offsets) {
    for (const iy of offsets) {
      const localX = ix * halfExtents[0]
      const localY = iy * halfExtents[1]
      const height = sampleSceneHeightfieldTopZ(
        hfield,
        x + cos * localX - sin * localY,
        y + sin * localX + cos * localY,
      )
      if (height === null) return null
      heights.push(height)
    }
  }
  const minimumZ = Math.min(...heights)
  const maximumZ = Math.max(...heights)
  return { minimumZ, maximumZ, reliefM: maximumZ - minimumZ }
}

/** Resolve a free-base root height from explicit robot-local ground contacts.
 * Unlike the circular median used by noise-tolerant fixed-base placement, a
 * wheeled base cannot admit one high-side wheel below the physical hfield.
 * Every registered point must have support; the highest required root pose
 * keeps all contacts at or above the compiled surface until gravity settles
 * the suspension-free rigid chassis. */
export function sampleSceneHeightfieldContactRootZ(
  hfield: SceneHeightfieldCollision,
  x: number,
  y: number,
  yaw: number,
  localContactPoints: readonly (readonly [x: number, y: number, z: number])[],
): { rootZ: number; minGroundZ: number; maxGroundZ: number; maxPairSlopeDeg: number } | null {
  if (![x, y, yaw].every(Number.isFinite) || localContactPoints.length === 0) return null
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  let rootZ = Number.NEGATIVE_INFINITY
  let minGroundZ = Number.POSITIVE_INFINITY
  let maxGroundZ = Number.NEGATIVE_INFINITY
  const samples: Array<{ x: number; y: number; z: number }> = []
  for (const point of localContactPoints) {
    if (point.length !== 3 || !point.every(Number.isFinite)) return null
    const worldX = x + cos * point[0] - sin * point[1]
    const worldY = y + sin * point[0] + cos * point[1]
    const groundZ = sampleSceneHeightfieldTopZ(hfield, worldX, worldY)
    if (groundZ === null) return null
    rootZ = Math.max(rootZ, groundZ - point[2])
    minGroundZ = Math.min(minGroundZ, groundZ)
    maxGroundZ = Math.max(maxGroundZ, groundZ)
    samples.push({ x: worldX, y: worldY, z: groundZ })
  }
  let maxPairSlopeDeg = 0
  for (let left = 0; left < samples.length; left++) {
    for (let right = left + 1; right < samples.length; right++) {
      const a = samples[left]!
      const b = samples[right]!
      const span = Math.hypot(a.x - b.x, a.y - b.y)
      if (span <= 1e-9) continue
      maxPairSlopeDeg = Math.max(maxPairSlopeDeg, Math.atan(Math.abs(a.z - b.z) / span) * 180 / Math.PI)
    }
  }
  return { rootZ, minGroundZ, maxGroundZ, maxPairSlopeDeg }
}

const DEFAULT_SAMPLE_STEP_M = 0.05
const DEFAULT_MAX_ROWS = 192
const DEFAULT_MAX_COLS = 192
const DEFAULT_MIN_UP_DOT = 0.55
const DEFAULT_MARGIN_M = 1
const DEFAULT_HOLE_DROP_M = 0.25
const DEFAULT_BASE_THICKNESS_M = 0.08
const DEFAULT_MAX_HITS_PER_COLUMN = 64
const RAY_EPSILON_M = 0.003

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.isFinite(value) ? Math.trunc(value!) : fallback
  return Math.min(max, Math.max(min, parsed))
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? value! : fallback
}

function finiteOrUndefined(value: number | undefined): number | undefined {
  return Number.isFinite(value) ? value : undefined
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return Number.NaN
  const index = Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * fraction)))
  return values[index]!
}

/** Remove cell-scale scan noise without flattening broad ramps. Missing
 * columns remain missing and are filled by the ordinary low fallback later. */
export function smoothSceneSupportHeights(
  source: Float64Array,
  nrow: number,
  ncol: number,
  radiusCells: number,
): Float64Array {
  const radius = Math.max(0, Math.trunc(radiusCells))
  const result = source.slice()
  if (!radius || nrow < 2 || ncol < 2 || source.length !== nrow * ncol) return result
  for (let row = 0; row < nrow; row++) {
    for (let col = 0; col < ncol; col++) {
      const offset = row * ncol + col
      if (!Number.isFinite(source[offset])) continue
      const neighbors: number[] = []
      for (let y = Math.max(0, row - radius); y <= Math.min(nrow - 1, row + radius); y++) {
        for (let x = Math.max(0, col - radius); x <= Math.min(ncol - 1, col + radius); x++) {
          const value = source[y * ncol + x]
          if (Number.isFinite(value)) neighbors.push(value)
        }
      }
      if (neighbors.length < 3) continue
      neighbors.sort((left, right) => left - right)
      result[offset] = percentile(neighbors, 0.5)
    }
  }
  return result
}

/**
 * Remove scan relief from a floor only when that floor is demonstrably the
 * dominant support layer. A genuine ramp distributes heights across a broad
 * range and fails the fraction gate; a warehouse slab with millimetre-scale
 * reconstruction noise passes and becomes one stable physical plane.
 */
export function flattenDominantSceneGroundBand(
  source: Float64Array,
  bandM: number,
  minFraction: number,
): { heights: Float64Array; flattenedColumns: number; groundZ: number | null } {
  const result = source.slice()
  const finite = Array.from(source).filter(Number.isFinite).sort((left, right) => left - right)
  if (finite.length === 0 || !Number.isFinite(bandM) || bandM <= 0) {
    return { heights: result, flattenedColumns: 0, groundZ: null }
  }
  const center = percentile(finite, 0.5)
  const band = finite.filter((value) => Math.abs(value - center) <= bandM)
  const requiredFraction = Math.min(1, Math.max(0, minFraction))
  if (band.length / finite.length < requiredFraction) {
    return { heights: result, flattenedColumns: 0, groundZ: null }
  }
  const groundZ = percentile(band, 0.5)
  let flattenedColumns = 0
  for (let i = 0; i < result.length; i++) {
    const value = result[i]
    if (!Number.isFinite(value) || Math.abs(value - center) > bandM) continue
    if (Math.abs(value - groundZ) > 1e-9) flattenedColumns++
    result[i] = groundZ
  }
  return { heights: result, flattenedColumns, groundZ }
}

function finiteBounds(bounds: Bounds3 | null): bounds is Bounds3 {
  return (
    !!bounds &&
    [...bounds.min, ...bounds.max].every(Number.isFinite) &&
    bounds.min[0] < bounds.max[0] &&
    bounds.min[1] < bounds.max[1] &&
    bounds.min[2] <= bounds.max[2]
  )
}

function sanitizeName(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "scene_hfield_debug"
  )
}

function gridCount(span: number, step: number, max: number): number {
  return Math.max(2, Math.min(max, Math.ceil(span / step) + 1))
}

function supportHit(
  hitNormalZ: number,
  minUpDot: number,
  normalMode: SceneHfieldNormalMode,
): boolean {
  const upDot = normalMode === "absolute-z" ? Math.abs(hitNormalZ) : hitNormalZ
  return upDot >= minUpDot
}

function columnSupportZ(input: {
  index: Pick<CanonicalTriangleSpatialIndex, "raycast" | "bounds">
  x: number
  y: number
  originZ: number
  far: number
  minUpDot: number
  normalMode: SceneHfieldNormalMode
  heightMode: SceneHfieldHeightMode
  maxHits: number
}): { z: number | null; hit: boolean } {
  let z = input.originZ
  let support: number | null = null
  let sawHit = false
  for (let hitCount = 0; hitCount < input.maxHits; hitCount++) {
    const hit = input.index.raycast({
      origin: [input.x, input.y, z],
      direction: [0, 0, 1],
      near: RAY_EPSILON_M,
      far: Math.max(RAY_EPSILON_M, input.originZ + input.far - z),
    })
    if (!hit) break
    sawHit = true
    if (supportHit(hit.normal[2], input.minUpDot, input.normalMode)) {
      // hfield has one height per (x,y). Indoor/table debug wants the highest
      // support; street terrain wants the lowest support so walls do not fold
      // into fake ramps.
      support =
        support === null
          ? hit.point[2]
          : input.heightMode === "lowest"
            ? Math.min(support, hit.point[2])
            : Math.max(support, hit.point[2])
    }
    z = hit.point[2] + RAY_EPSILON_M
    if (z >= input.originZ + input.far) break
  }
  return { z: support, hit: sawHit }
}

export function buildSceneHeightfieldCollision(
  input: BuildSceneHeightfieldCollisionInput,
): SceneHeightfieldCollision | null {
  const bounds = input.index.bounds
  if (!finiteBounds(bounds)) return null

  const step = positive(input.sampleStepM, DEFAULT_SAMPLE_STEP_M)
  const maxRows = clampInt(input.maxRows, DEFAULT_MAX_ROWS, 2, 512)
  const maxCols = clampInt(input.maxCols, DEFAULT_MAX_COLS, 2, 512)
  const ncol = gridCount(bounds.max[0] - bounds.min[0], step, maxCols)
  const nrow = gridCount(bounds.max[1] - bounds.min[1], step, maxRows)
  const actualStepX = (bounds.max[0] - bounds.min[0]) / (ncol - 1)
  const actualStepY = (bounds.max[1] - bounds.min[1]) / (nrow - 1)
  const actualStep = Math.max(actualStepX, actualStepY)
  const minUpDot = positive(input.minUpDot, DEFAULT_MIN_UP_DOT)
  const normalMode = input.normalMode ?? "positive-z"
  const heightMode = input.heightMode ?? "highest"
  const marginM = positive(input.marginM, DEFAULT_MARGIN_M)
  const holeDropM = positive(input.holeDropM, DEFAULT_HOLE_DROP_M)
  const baseThicknessM = positive(input.baseThicknessM, DEFAULT_BASE_THICKNESS_M)
  const maxHits = clampInt(input.maxHitsPerColumn, DEFAULT_MAX_HITS_PER_COLUMN, 1, 256)
  const originZ = bounds.min[2] - marginM
  const far = bounds.max[2] - originZ + marginM

  const raw = new Float64Array(nrow * ncol)
  raw.fill(Number.NaN)
  let hitColumns = 0
  let supportColumns = 0
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (let row = 0; row < nrow; row++) {
    const y = bounds.min[1] + row * actualStepY
    for (let col = 0; col < ncol; col++) {
      const x = bounds.min[0] + col * actualStepX
      const sample = columnSupportZ({ index: input.index, x, y, originZ, far, minUpDot, normalMode, heightMode, maxHits })
      if (sample.hit) hitColumns++
      if (sample.z === null) continue
      const offset = row * ncol + col
      raw[offset] = sample.z
      supportColumns++
      minZ = Math.min(minZ, sample.z)
      maxZ = Math.max(maxZ, sample.z)
    }
  }
  if (supportColumns === 0 || !Number.isFinite(minZ) || !Number.isFinite(maxZ)) return null

  const maxAboveBase = finiteOrUndefined(input.maxSupportHeightAboveBaseM)
  const maxBelowBase = finiteOrUndefined(input.maxSupportDepthBelowBaseM)
  if (maxAboveBase !== undefined || maxBelowBase !== undefined) {
    const samples = Array.from(raw).filter(Number.isFinite).sort((a, b) => a - b)
    const basePercentile = Math.min(0.5, Math.max(0, input.supportBasePercentile ?? 0))
    const baseZ = percentile(samples, basePercentile)
    const minAllowed = maxBelowBase === undefined ? Number.NEGATIVE_INFINITY : baseZ - Math.max(0, maxBelowBase)
    const maxAllowed = maxAboveBase === undefined ? Number.POSITIVE_INFINITY : baseZ + Math.max(0, maxAboveBase)
    supportColumns = 0
    minZ = Number.POSITIVE_INFINITY
    maxZ = Number.NEGATIVE_INFINITY
    for (let i = 0; i < raw.length; i++) {
      const value = raw[i]
      if (!Number.isFinite(value)) continue
      if (value < minAllowed || value > maxAllowed) {
        raw[i] = Number.NaN
        continue
      }
      supportColumns++
      minZ = Math.min(minZ, value)
      maxZ = Math.max(maxZ, value)
    }
    if (supportColumns === 0 || !Number.isFinite(minZ) || !Number.isFinite(maxZ)) return null
  }

  let flattenedColumns = 0
  let dominantGroundZ: number | null = null
  const flattenBandM = finiteOrUndefined(input.flattenDominantGroundBandM)
  if (flattenBandM !== undefined && flattenBandM > 0) {
    const flattened = flattenDominantSceneGroundBand(
      raw,
      flattenBandM,
      input.flattenDominantGroundMinFraction ?? 0.6,
    )
    raw.set(flattened.heights)
    flattenedColumns = flattened.flattenedColumns
    dominantGroundZ = flattened.groundZ
    if (dominantGroundZ !== null) {
      minZ = Number.POSITIVE_INFINITY
      maxZ = Number.NEGATIVE_INFINITY
      for (const value of raw) {
        if (!Number.isFinite(value)) continue
        minZ = Math.min(minZ, value)
        maxZ = Math.max(maxZ, value)
      }
    }
  }

  const smoothingRadiusCells = clampInt(input.smoothingRadiusCells, 0, 0, 8)
  if (smoothingRadiusCells > 0) {
    raw.set(smoothSceneSupportHeights(raw, nrow, ncol, smoothingRadiusCells))
    supportColumns = 0
    minZ = Number.POSITIVE_INFINITY
    maxZ = Number.NEGATIVE_INFINITY
    for (const value of raw) {
      if (!Number.isFinite(value)) continue
      supportColumns++
      minZ = Math.min(minZ, value)
      maxZ = Math.max(maxZ, value)
    }
  }

  // The lowest-support field is the actual landing surface for spawned
  // objects.  Dropping missing columns by `holeDropM` turns a harmless scan
  // hole into a hidden shaft: an object snapped above the visible floor can
  // fall through the hfield and disappear below the scene.  Keep lowest-mode
  // holes on the conservative representative ground level; the lowered
  // fallback remains available for non-landing preview projections.
  const fillZ = heightMode === "lowest" ? minZ : minZ - holeDropM
  let filledColumns = 0
  for (let i = 0; i < raw.length; i++) {
    if (Number.isFinite(raw[i])) continue
    raw[i] = fillZ
    filledColumns++
  }
  if (filledColumns > 0) minZ = Math.min(minZ, fillZ)
  const zRange = Math.max(0.001, maxZ - minZ)
  const elevation = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i++) {
    elevation[i] = (raw[i] - minZ) / zRange
  }

  return {
    kind: "scene-heightfield-collision",
    providerVersion: SCENE_HFIELD_PROVIDER_VERSION,
    name: sanitizeName(input.name ?? "scene_hfield_debug"),
    frame: "mujoco-z-up-meters",
    nrow,
    ncol,
    bounds: { min: [...bounds.min], max: [...bounds.max] },
    origin: [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, minZ],
    size: [(bounds.max[0] - bounds.min[0]) / 2, (bounds.max[1] - bounds.min[1]) / 2, zRange, baseThicknessM],
    elevation,
    stats: {
      sampledColumns: nrow * ncol,
      hitColumns,
      supportColumns,
      filledColumns,
      coverage: supportColumns / (nrow * ncol),
      minZ,
      maxZ,
      sampleStepM: actualStep,
      normalMode,
      heightMode,
      flattenedColumns,
      ...(dominantGroundZ === null ? {} : { dominantGroundZ }),
    },
    warnings: [
      "debug hfield is a single-height projection: vertical walls, table legs, undersides and lower surfaces are not represented",
      ...(filledColumns > 0
        ? [heightMode === "lowest"
          ? "columns without support hits were filled at the representative landing height"
          : "columns without support hits were filled with a low fallback height"]
        : []),
      ...(smoothingRadiusCells > 0 ? [`ground support used a ${smoothingRadiusCells}-cell median noise filter`] : []),
      ...(dominantGroundZ === null
        ? []
        : [`dominant ground band levelled ${flattenedColumns} columns at z=${dominantGroundZ.toFixed(4)}`]),
    ],
  }
}
