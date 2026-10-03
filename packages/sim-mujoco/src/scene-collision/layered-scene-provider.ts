import type { Bounds3, SceneCollisionPart, SceneCollisionPatch } from "./contracts.ts"
import { buildSceneHeightfieldCollision, type SceneHeightfieldCollision } from "./hfield-provider.ts"
import type { CanonicalTriangleSpatialIndex } from "./spatial-index.ts"

export const SCENE_LAYERED_PROVIDER_VERSION = "scene-layered-debug-prototype-v1" as const

export interface SceneLayeredCollision {
  kind: "scene-layered-collision"
  providerVersion: typeof SCENE_LAYERED_PROVIDER_VERSION
  groundHfield: SceneHeightfieldCollision | null
  verticalPatch: SceneCollisionPatch | null
  stats: {
    verticalTriangles: number
    verticalClusters: number
    verticalBoxes: number
  }
  warnings: readonly string[]
}

export interface BuildSceneLayeredCollisionInput {
  index: CanonicalTriangleSpatialIndex
  name?: string
  sourceMeshHash?: string
  alignmentRevision?: string
  groundSampleStepM?: number
  groundSmoothingRadiusCells?: number
  maxRows?: number
  maxCols?: number
  maxVerticalAbsZ?: number
  planeMergeM?: number
  angleMergeDeg?: number
  verticalThicknessM?: number
  verticalPaddingM?: number
  minVerticalHeightM?: number
  minVerticalLengthM?: number
  minVerticalAreaM2?: number
  maxVerticalBottomAboveGroundM?: number
  maxVerticalSegmentGapM?: number
  minVerticalFillRatio?: number
  minVerticalNormalCoherence?: number
  maxVerticalBoxes?: number
}

interface VerticalSample {
  tMin: number
  tMax: number
  area: number
  normalX: number
  normalY: number
  coord: number
  bounds: Bounds3
}

interface VerticalCluster {
  key: string
  weightedCoord: number
  weightedNormalX: number
  weightedNormalY: number
  spanMin: number
  spanMax: number
  area: number
  triangles: number
  bounds: Bounds3
  samples: VerticalSample[]
}

const DEBUG_HASH_SOURCE = "7".repeat(64)
const DEBUG_HASH_ALIGNMENT = "8".repeat(64)
const DEBUG_HASH_REQUEST = "9".repeat(64)

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now()
}

function emptyBounds(): Bounds3 {
  return {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  }
}

function includePoint(bounds: Bounds3, x: number, y: number, z: number): void {
  bounds.min[0] = Math.min(bounds.min[0], x)
  bounds.min[1] = Math.min(bounds.min[1], y)
  bounds.min[2] = Math.min(bounds.min[2], z)
  bounds.max[0] = Math.max(bounds.max[0], x)
  bounds.max[1] = Math.max(bounds.max[1], y)
  bounds.max[2] = Math.max(bounds.max[2], z)
}

function includeBounds(bounds: Bounds3, other: Bounds3): void {
  includePoint(bounds, other.min[0], other.min[1], other.min[2])
  includePoint(bounds, other.max[0], other.max[1], other.max[2])
}

function finiteBounds(bounds: Bounds3 | null): bounds is Bounds3 {
  return !!bounds && [...bounds.min, ...bounds.max].every(Number.isFinite)
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? value! : fallback
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.isFinite(value) ? Math.trunc(value!) : fallback
  return Math.min(max, Math.max(min, parsed))
}

function sanitizeName(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 72) || "scene_layered_debug"
  )
}

function triangle(input: CanonicalTriangleSpatialIndex, triangleIndex: number): number[] {
  const { vertices, indices } = input.mesh
  const out: number[] = []
  for (let corner = 0; corner < 3; corner++) {
    const vertexIndex = indices[triangleIndex * 3 + corner]
    const offset = vertexIndex * 3
    out.push(vertices[offset], vertices[offset + 1], vertices[offset + 2])
  }
  return out
}

function verticalClusterKey(normalX: number, normalY: number, coord: number, mergeM: number, angleMergeRad: number) {
  const angleKey = Math.round(Math.atan2(normalY, normalX) / angleMergeRad)
  const coordKey = Math.round(coord / mergeM)
  return `${angleKey}:${coordKey}`
}

function wallNormal(cluster: VerticalCluster): [number, number] {
  const length = Math.hypot(cluster.weightedNormalX, cluster.weightedNormalY)
  if (length <= 1e-9) return [1, 0]
  return [cluster.weightedNormalX / length, cluster.weightedNormalY / length]
}

function clusterCoord(cluster: VerticalCluster): number {
  return cluster.weightedCoord / Math.max(cluster.area, 1e-9)
}

function wallScore(cluster: VerticalCluster): number {
  const height = Math.max(0, cluster.bounds.max[2] - cluster.bounds.min[2])
  const length = Math.max(0, cluster.spanMax - cluster.spanMin)
  return Math.max(0.01, Math.sqrt(Math.max(0.01, height * length)) * verticalFillRatio(cluster))
}

function fraction(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value!)) : fallback
}

function verticalFillRatio(cluster: VerticalCluster): number {
  const height = Math.max(0.001, cluster.bounds.max[2] - cluster.bounds.min[2])
  const length = Math.max(0.001, cluster.spanMax - cluster.spanMin)
  return Math.min(1, cluster.area / (height * length))
}

function verticalNormalCoherence(cluster: VerticalCluster): number {
  return Math.min(1, Math.hypot(cluster.weightedNormalX, cluster.weightedNormalY) / Math.max(cluster.area, 1e-9))
}

function createSegment(seed: VerticalSample, key: string): VerticalCluster {
  const bounds = emptyBounds()
  includeBounds(bounds, seed.bounds)
  return {
    key,
    weightedCoord: seed.coord * seed.area,
    weightedNormalX: seed.normalX * seed.area,
    weightedNormalY: seed.normalY * seed.area,
    spanMin: seed.tMin,
    spanMax: seed.tMax,
    area: seed.area,
    triangles: 1,
    bounds,
    samples: [],
  }
}

function includeSample(segment: VerticalCluster, sample: VerticalSample): void {
  segment.weightedCoord += sample.coord * sample.area
  segment.weightedNormalX += sample.normalX * sample.area
  segment.weightedNormalY += sample.normalY * sample.area
  segment.spanMin = Math.min(segment.spanMin, sample.tMin)
  segment.spanMax = Math.max(segment.spanMax, sample.tMax)
  segment.area += sample.area
  segment.triangles++
  includeBounds(segment.bounds, sample.bounds)
}

function splitVerticalCluster(cluster: VerticalCluster, maxGapM: number): VerticalCluster[] {
  if (cluster.samples.length === 0) return []
  const samples = [...cluster.samples].sort((a, b) => a.tMin - b.tMin)
  const segments: VerticalCluster[] = []
  let current = createSegment(samples[0]!, `${cluster.key}:0`)
  for (let index = 1; index < samples.length; index++) {
    const sample = samples[index]!
    if (sample.tMin > current.spanMax + maxGapM) {
      segments.push(current)
      current = createSegment(sample, `${cluster.key}:${segments.length}`)
      continue
    }
    includeSample(current, sample)
  }
  segments.push(current)
  return segments
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return Number.NaN
  const index = Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * fraction)))
  return values[index]!
}

function estimateGroundZ(index: CanonicalTriangleSpatialIndex): number {
  const values: number[] = []
  const vertices = index.mesh.vertices
  for (let offset = 2; offset < vertices.length; offset += 3) {
    const z = vertices[offset]
    if (Number.isFinite(z)) values.push(z)
  }
  values.sort((a, b) => a - b)
  const fallback = index.bounds?.min?.[2]
  const estimated = percentile(values, 0.08)
  if (Number.isFinite(estimated)) return estimated
  return typeof fallback === "number" && Number.isFinite(fallback) ? fallback : 0
}

function orientedBoxBounds(
  center: [number, number, number],
  halfExtents: [number, number, number],
  yaw: number,
): Bounds3 {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  const extX = Math.abs(c) * halfExtents[0] + Math.abs(s) * halfExtents[1]
  const extY = Math.abs(s) * halfExtents[0] + Math.abs(c) * halfExtents[1]
  return {
    min: [center[0] - extX, center[1] - extY, center[2] - halfExtents[2]],
    max: [center[0] + extX, center[1] + extY, center[2] + halfExtents[2]],
  }
}

function addOrientedPart(
  parts: SceneCollisionPart[],
  partId: string,
  center: [number, number, number],
  halfExtents: [number, number, number],
  yaw: number,
) {
  if (halfExtents.some((value) => value <= 0)) return
  const halfYaw = yaw / 2
  parts.push({
    partId,
    representation: "voxel-box",
    center,
    halfExtents,
    quat: [Math.cos(halfYaw), 0, 0, Math.sin(halfYaw)],
    bounds: orientedBoxBounds(center, halfExtents, yaw),
  })
}

function buildVerticalPatch(input: BuildSceneLayeredCollisionInput, started: number): {
  patch: SceneCollisionPatch | null
  verticalTriangles: number
  verticalClusters: number
} {
  const maxVerticalAbsZ = Math.min(0.65, Math.max(0.01, input.maxVerticalAbsZ ?? 0.16))
  const planeMergeM = positive(input.planeMergeM, 0.32)
  const angleMergeRad = (positive(input.angleMergeDeg, 8) * Math.PI) / 180
  const verticalThicknessM = positive(input.verticalThicknessM, 0.08)
  const verticalPaddingM = positive(input.verticalPaddingM, 0.02)
  const minVerticalHeightM = positive(input.minVerticalHeightM, 1.4)
  const minVerticalLengthM = positive(input.minVerticalLengthM, 1.8)
  const minVerticalAreaM2 = positive(input.minVerticalAreaM2, 2)
  const maxVerticalBottomAboveGroundM = positive(input.maxVerticalBottomAboveGroundM, 0.55)
  const maxVerticalSegmentGapM = positive(input.maxVerticalSegmentGapM, 0.55)
  const minVerticalFillRatio = fraction(input.minVerticalFillRatio, 0.04)
  const minVerticalNormalCoherence = fraction(input.minVerticalNormalCoherence, 0.72)
  const maxVerticalBoxes = clampInt(input.maxVerticalBoxes, 24, 1, 512)
  const groundZ = estimateGroundZ(input.index)
  const clusters = new Map<string, VerticalCluster>()
  let verticalTriangles = 0

  for (let t = 0; t < input.index.triangleCount; t++) {
    const p = triangle(input.index, t)
    const abx = p[3] - p[0]
    const aby = p[4] - p[1]
    const abz = p[5] - p[2]
    const acx = p[6] - p[0]
    const acy = p[7] - p[1]
    const acz = p[8] - p[2]
    const nx = aby * acz - abz * acy
    const ny = abz * acx - abx * acz
    const nz = abx * acy - aby * acx
    const normalLen = Math.hypot(nx, ny, nz)
    if (normalLen <= 1e-9) continue
    const area = normalLen / 2
    const ux = nx / normalLen
    const uy = ny / normalLen
    const uz = nz / normalLen
    const horizontalLen = Math.hypot(ux, uy)
    if (Math.abs(uz) > maxVerticalAbsZ || horizontalLen < 0.65) continue
    verticalTriangles++
    const normalX = ux / horizontalLen
    const normalY = uy / horizontalLen
    const coord = normalX * ((p[0] + p[3] + p[6]) / 3) + normalY * ((p[1] + p[4] + p[7]) / 3)
    const key = verticalClusterKey(normalX, normalY, coord, planeMergeM, angleMergeRad)
    let cluster = clusters.get(key)
    if (!cluster) {
      cluster = {
        key,
        weightedCoord: 0,
        weightedNormalX: 0,
        weightedNormalY: 0,
        spanMin: Number.POSITIVE_INFINITY,
        spanMax: Number.NEGATIVE_INFINITY,
        area: 0,
        triangles: 0,
        bounds: emptyBounds(),
        samples: [],
      }
      clusters.set(key, cluster)
    }
    cluster.weightedCoord += coord * area
    cluster.weightedNormalX += normalX * area
    cluster.weightedNormalY += normalY * area
    cluster.area += area
    cluster.triangles++
    const sampleBounds = emptyBounds()
    let sampleTMin = Number.POSITIVE_INFINITY
    let sampleTMax = Number.NEGATIVE_INFINITY
    for (let corner = 0; corner < 3; corner++) {
      const x = p[corner * 3]
      const y = p[corner * 3 + 1]
      const z = p[corner * 3 + 2]
      const tangent = -normalY * x + normalX * y
      cluster.spanMin = Math.min(cluster.spanMin, tangent)
      cluster.spanMax = Math.max(cluster.spanMax, tangent)
      includePoint(cluster.bounds, x, y, z)
      sampleTMin = Math.min(sampleTMin, tangent)
      sampleTMax = Math.max(sampleTMax, tangent)
      includePoint(sampleBounds, x, y, z)
    }
    cluster.samples.push({
      tMin: sampleTMin,
      tMax: sampleTMax,
      area,
      normalX,
      normalY,
      coord,
      bounds: sampleBounds,
    })
  }

  const candidates = [...clusters.values()]
    .flatMap((cluster) => splitVerticalCluster(cluster, maxVerticalSegmentGapM))
    .filter((cluster) => {
      if (cluster.area < minVerticalAreaM2 || !finiteBounds(cluster.bounds)) return false
      const height = cluster.bounds.max[2] - cluster.bounds.min[2]
      const length = cluster.spanMax - cluster.spanMin
      const bottomAboveGround = cluster.bounds.min[2] - groundZ
      const fillRatio = verticalFillRatio(cluster)
      const normalCoherence = verticalNormalCoherence(cluster)
      return (
        height >= minVerticalHeightM &&
        length >= minVerticalLengthM &&
        bottomAboveGround <= maxVerticalBottomAboveGroundM &&
        fillRatio >= minVerticalFillRatio &&
        normalCoherence >= minVerticalNormalCoherence
      )
    })
    .sort((a, b) => b.area * wallScore(b) - a.area * wallScore(a))
    .slice(0, maxVerticalBoxes)

  const parts: SceneCollisionPart[] = []
  const coverage = emptyBounds()
  for (const [index, cluster] of candidates.entries()) {
    const [normalX, normalY] = wallNormal(cluster)
    const tangentX = -normalY
    const tangentY = normalX
    const coord = clusterCoord(cluster)
    const spanMin = cluster.spanMin - verticalPaddingM
    const spanMax = cluster.spanMax + verticalPaddingM
    const centerT = (spanMin + spanMax) / 2
    const center: [number, number, number] = [
      normalX * coord + tangentX * centerT,
      normalY * coord + tangentY * centerT,
      (cluster.bounds.min[2] + cluster.bounds.max[2]) / 2,
    ]
    const halfExtents: [number, number, number] = [
      Math.max(0.01, (spanMax - spanMin) / 2),
      verticalThicknessM / 2,
      Math.max(0.01, (cluster.bounds.max[2] - cluster.bounds.min[2]) / 2 + verticalPaddingM),
    ]
    const yaw = Math.atan2(tangentY, tangentX)
    addOrientedPart(parts, `vertical_${index.toString().padStart(3, "0")}`, center, halfExtents, yaw)
    includeBounds(coverage, parts[parts.length - 1]!.bounds)
  }

  if (parts.length === 0 || !finiteBounds(coverage)) {
    return { patch: null, verticalTriangles, verticalClusters: clusters.size }
  }

  return {
    patch: {
      patchId: `${sanitizeName(input.name ?? "scene_layered_debug")}_vertical`,
      sourceMeshHash: input.sourceMeshHash ?? DEBUG_HASH_SOURCE,
      alignmentRevision: input.alignmentRevision ?? DEBUG_HASH_ALIGNMENT,
      requestHash: DEBUG_HASH_REQUEST,
      frame: "mujoco-z-up-meters",
      parts,
      coverage,
      provenance: {
        provider: "layered-vertical-box-debug",
        providerVersion: SCENE_LAYERED_PROVIDER_VERSION,
        voxelSizeM: verticalThicknessM,
        sourceTriangleCount: input.index.triangleCount,
        outputTriangleCount: parts.length * 12,
        buildDurationMs: Math.max(0, nowMs() - started),
      },
      warnings: [
        "layered debug vertical boxes are planar approximations for walls, facades, rails and poles",
        "ground is provided by a separate lowest-support hfield; voxel scene collision is not used",
      ],
    },
    verticalTriangles,
    verticalClusters: clusters.size,
  }
}

export function buildSceneLayeredCollision(input: BuildSceneLayeredCollisionInput): SceneLayeredCollision | null {
  const started = nowMs()
  const groundHfield = buildSceneHeightfieldCollision({
    index: input.index,
    name: `${sanitizeName(input.name ?? "scene_layered_debug")}_ground`,
    sampleStepM: input.groundSampleStepM ?? 0.05,
    smoothingRadiusCells: input.groundSmoothingRadiusCells ?? 2,
    maxRows: input.maxRows,
    maxCols: input.maxCols,
    heightMode: "lowest",
    normalMode: "positive-z",
    minUpDot: 0.55,
    supportBasePercentile: 0.1,
    maxSupportHeightAboveBaseM: 0.45,
    maxSupportDepthBelowBaseM: 0.3,
    // Indoor scans commonly leave a physically flat slab with a few
    // millimetres of reconstruction tilt/noise. Level it only when one narrow
    // band owns most support columns; ramps and platforms fail that dominance
    // test and retain their geometry.
    flattenDominantGroundBandM: 0.04,
    flattenDominantGroundMinFraction: 0.55,
    holeDropM: 0.08,
    baseThicknessM: 0.06,
  })
  const vertical = buildVerticalPatch(input, started)
  if (!groundHfield && !vertical.patch) return null
  return {
    kind: "scene-layered-collision",
    providerVersion: SCENE_LAYERED_PROVIDER_VERSION,
    groundHfield,
    verticalPatch: vertical.patch,
    stats: {
      verticalTriangles: vertical.verticalTriangles,
      verticalClusters: vertical.verticalClusters,
      verticalBoxes: vertical.patch?.parts.length ?? 0,
    },
    warnings: [
      ...(groundHfield?.warnings ?? ["no ground hfield was produced"]),
      ...(vertical.patch?.warnings ?? ["no vertical boxes were produced"]),
    ],
  }
}
