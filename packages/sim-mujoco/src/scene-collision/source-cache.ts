/**
 * source-cache — 对齐场景网格碰撞源的容量有界 LRU（移植自 History
 * scene-collision/source-cache.ts）。与旧版的差异：
 *  - THREE.Matrix4 → ./mat4.ts 的列主序数组；矩阵来自组合好的 meshWorld，
 *    目标坐标系即 Scene/MuJoCo 世界系（z-up 米），因此旧版需要矩阵求逆的
 *    sourceToTargetFrameMatrix 在本包没有用途，未移植。
 *  - THREE.Object3D 源 → readGlbTriangleSoup 的 GltfTriangleSoup。
 * LRU 语义保持一致：默认 4 项 / 256 MiB，key = `mesh.sha256:revision:matrix(17位)`，
 * 支持 pin/unpin 与 invalidateRevision 强制失效。
 */

import {
  parseSceneGeometryBinding,
  type Matrix4Elements,
  type SceneGeometryBinding,
} from "../../../lyapunov-contracts/src/types.ts"
import type { Bounds3 } from "./contracts.ts"
import { canonicalizeTriangleSoup, type CanonicalTriangleMesh, type GltfTriangleSoup } from "./glb-mesh.ts"
import { applyMat4ToPoint, isFiniteMat4, type Mat4 } from "./mat4.ts"
import { CanonicalTriangleSpatialIndex } from "./spatial-index.ts"

const SHA256 = /^[0-9a-f]{64}$/
const DEFAULT_MAX_ENTRIES = 4
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_LEAF_TRIANGLES = 8
const FIXED_SOURCE_OVERHEAD_BYTES = 256
const ESTIMATED_TRIANGLE_AUX_BYTES = 80
const ESTIMATED_BVH_NODE_BYTES = 80

export class AlignedSceneMeshSourceError extends Error {
  constructor(
    readonly code:
      | "invalid_binding"
      | "invalid_source_key"
      | "invalid_capacity"
      | "invalid_transform"
      | "invalid_canonical_mesh",
    message: string,
  ) {
    super(message)
    this.name = "AlignedSceneMeshSourceError"
  }
}

export interface BuildAlignedSceneMeshSourceInput {
  /** Caller-provided mesh-hash/revision/placement identity. */
  sourceKey: string
  binding: SceneGeometryBinding
  source: GltfTriangleSoup
  sourceToTarget: Mat4
}

export interface AlignedSceneMeshSource {
  readonly sourceKey: string
  readonly sourceMeshHash: string
  readonly alignmentRevision: string
  readonly sourceToTarget: Matrix4Elements
  readonly mesh: CanonicalTriangleMesh
  readonly spatialIndex: CanonicalTriangleSpatialIndex
  /** Deterministic conservative structural estimate, not a JavaScript heap measurement. */
  readonly estimatedBytes: number
}

export interface AlignedSceneMeshSourceCacheOptions {
  maxEntries?: number
  maxBytes?: number
  maxLeafTriangles?: number
}

export interface CacheBuildAlignedSceneMeshSourceInput extends BuildAlignedSceneMeshSourceInput {
  /** Atomically protect a newly built entry from capacity eviction. */
  pin?: boolean
}

interface CacheEntry {
  source: AlignedSceneMeshSource
  pinCount: number
}

function finiteMatrixElements(matrix: Mat4): Matrix4Elements {
  if (!isFiniteMat4(matrix)) {
    throw new AlignedSceneMeshSourceError("invalid_transform", "matrix must contain exactly 16 finite values")
  }
  return Object.freeze([...matrix]) as unknown as Matrix4Elements
}

function canonicalNumber(value: number): string {
  return (Object.is(value, -0) ? 0 : value).toPrecision(17)
}

function detachedBinding(value: SceneGeometryBinding): SceneGeometryBinding {
  const binding = parseSceneGeometryBinding(value)
  if (!binding || !SHA256.test(binding.mesh.sha256) || !SHA256.test(binding.revision)) {
    throw new AlignedSceneMeshSourceError("invalid_binding", "binding must contain valid asset hashes and revision")
  }
  return Object.freeze({
    ...binding,
    splat: Object.freeze({ ...binding.splat }),
    mesh: Object.freeze({ ...binding.mesh }),
    meshToSplat: Object.freeze([...binding.meshToSplat]) as unknown as Matrix4Elements,
  })
}

/**
 * Stable source identity derived only from mesh content, alignment revision,
 * and the exact placement-bearing sourceToTarget transform.
 */
export function alignedSceneMeshSourceKey(input: {
  binding: SceneGeometryBinding
  sourceToTarget: Mat4
}): string {
  const binding = detachedBinding(input.binding)
  const placement = finiteMatrixElements(input.sourceToTarget).map(canonicalNumber).join(",")
  return `${binding.mesh.sha256}:${binding.revision}:${placement}`
}

function validateSourceKey(input: BuildAlignedSceneMeshSourceInput): void {
  const expected = alignedSceneMeshSourceKey(input)
  if (input.sourceKey !== expected) {
    throw new AlignedSceneMeshSourceError(
      "invalid_source_key",
      "sourceKey must be derived from mesh hash, alignment revision, and sourceToTarget placement",
    )
  }
}

function estimateSourceBytes(mesh: CanonicalTriangleMesh): number {
  const triangleCount = mesh.indices.length / 3
  const bvhNodeUpperBound = triangleCount === 0 ? 0 : triangleCount * 2 - 1
  return (
    FIXED_SOURCE_OVERHEAD_BYTES +
    mesh.vertices.byteLength +
    mesh.indices.byteLength +
    mesh.triangleIds.byteLength +
    triangleCount * ESTIMATED_TRIANGLE_AUX_BYTES +
    bvhNodeUpperBound * ESTIMATED_BVH_NODE_BYTES
  )
}

/** Build a collision source that retains no GLB byte or geometry alias. */
export function buildAlignedSceneMeshSource(
  input: BuildAlignedSceneMeshSourceInput,
  options: { maxLeafTriangles?: number } = {},
): AlignedSceneMeshSource {
  validateSourceKey(input)
  const binding = detachedBinding(input.binding)
  const sourceToTarget = finiteMatrixElements(input.sourceToTarget)
  const mesh = canonicalizeTriangleSoup(input.source, [...sourceToTarget] as Mat4)
  const spatialIndex = new CanonicalTriangleSpatialIndex(mesh, {
    ...(options.maxLeafTriangles === undefined ? {} : { maxLeafTriangles: options.maxLeafTriangles }),
  })
  return {
    sourceKey: input.sourceKey,
    sourceMeshHash: binding.mesh.sha256,
    alignmentRevision: binding.revision,
    sourceToTarget,
    mesh,
    spatialIndex,
    estimatedBytes: estimateSourceBytes(mesh),
  }
}

function includePoint(bounds: Bounds3, point: readonly [number, number, number]): void {
  bounds.min[0] = Math.min(bounds.min[0], point[0])
  bounds.min[1] = Math.min(bounds.min[1], point[1])
  bounds.min[2] = Math.min(bounds.min[2], point[2])
  bounds.max[0] = Math.max(bounds.max[0], point[0])
  bounds.max[1] = Math.max(bounds.max[1], point[1])
  bounds.max[2] = Math.max(bounds.max[2], point[2])
}

/**
 * Copy canonical triangles into another metre-space frame without mutating or
 * aliasing the input mesh. Triangle provenance and extraction stats survive.
 */
export function transformCanonicalTriangleMesh(
  mesh: CanonicalTriangleMesh,
  sourceToTarget: Mat4,
): CanonicalTriangleMesh {
  finiteMatrixElements(sourceToTarget)
  if (mesh.vertices.length % 3 !== 0) {
    throw new AlignedSceneMeshSourceError(
      "invalid_canonical_mesh",
      "canonical mesh vertices length must be divisible by 3",
    )
  }

  const vertices = new Float64Array(mesh.vertices.length)
  const bounds: Bounds3 = {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  }
  const corner: [number, number, number] = [0, 0, 0]
  for (let offset = 0; offset < mesh.vertices.length; offset += 3) {
    corner[0] = mesh.vertices[offset]!
    corner[1] = mesh.vertices[offset + 1]!
    corner[2] = mesh.vertices[offset + 2]!
    const point = applyMat4ToPoint(sourceToTarget, corner)
    if (!point.every(Number.isFinite)) {
      throw new AlignedSceneMeshSourceError("invalid_transform", "frame transform produced non-finite vertices")
    }
    vertices[offset] = point[0]
    vertices[offset + 1] = point[1]
    vertices[offset + 2] = point[2]
    includePoint(bounds, point)
  }

  return {
    units: "meters",
    vertices,
    indices: new Uint32Array(mesh.indices),
    triangleIds: new Uint32Array(mesh.triangleIds),
    bounds: vertices.length === 0 ? null : bounds,
    stats: { ...mesh.stats },
  }
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AlignedSceneMeshSourceError("invalid_capacity", `${label} must be a positive safe integer`)
  }
  return value
}

/** Capacity-bounded in-memory LRU for detached canonical scene geometry. */
export class AlignedSceneMeshSourceCache {
  readonly maxEntries: number
  readonly maxBytes: number
  readonly maxLeafTriangles: number

  #entries = new Map<string, CacheEntry>()
  #estimatedBytes = 0

  constructor(options: AlignedSceneMeshSourceCacheOptions = {}) {
    this.maxEntries = positiveSafeInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, "maxEntries")
    this.maxBytes = positiveSafeInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, "maxBytes")
    this.maxLeafTriangles = positiveSafeInteger(
      options.maxLeafTriangles ?? DEFAULT_MAX_LEAF_TRIANGLES,
      "maxLeafTriangles",
    )
  }

  get size(): number {
    return this.#entries.size
  }

  get estimatedBytes(): number {
    return this.#estimatedBytes
  }

  get pinnedEntries(): number {
    let count = 0
    for (const entry of this.#entries.values()) if (entry.pinCount > 0) count++
    return count
  }

  has(sourceKey: string): boolean {
    return this.#entries.has(sourceKey)
  }

  get(sourceKey: string): AlignedSceneMeshSource | undefined {
    const entry = this.#entries.get(sourceKey)
    if (!entry) return
    this.#touch(sourceKey, entry)
    return entry.source
  }

  build(input: CacheBuildAlignedSceneMeshSourceInput): AlignedSceneMeshSource {
    validateSourceKey(input)
    const hit = this.#entries.get(input.sourceKey)
    if (hit) {
      if (input.pin) hit.pinCount++
      this.#touch(input.sourceKey, hit)
      return hit.source
    }

    const source = buildAlignedSceneMeshSource(input, { maxLeafTriangles: this.maxLeafTriangles })
    const entry: CacheEntry = { source, pinCount: input.pin ? 1 : 0 }
    this.#entries.set(input.sourceKey, entry)
    this.#estimatedBytes += source.estimatedBytes
    this.#evict()
    return source
  }

  pin(sourceKey: string): boolean {
    const entry = this.#entries.get(sourceKey)
    if (!entry) return false
    entry.pinCount++
    this.#touch(sourceKey, entry)
    return true
  }

  unpin(sourceKey: string): boolean {
    const entry = this.#entries.get(sourceKey)
    if (!entry || entry.pinCount === 0) return false
    entry.pinCount--
    this.#evict()
    return true
  }

  /** Explicit correctness invalidation removes matching entries even if pinned. */
  invalidateRevision(alignmentRevision: string): number {
    let removed = 0
    for (const [sourceKey, entry] of [...this.#entries]) {
      if (entry.source.alignmentRevision !== alignmentRevision) continue
      this.#remove(sourceKey, entry)
      removed++
    }
    return removed
  }

  /** Explicit lifecycle invalidation removes all entries, including pinned. */
  clear(): void {
    this.#entries.clear()
    this.#estimatedBytes = 0
  }

  #touch(sourceKey: string, entry: CacheEntry): void {
    this.#entries.delete(sourceKey)
    this.#entries.set(sourceKey, entry)
  }

  #remove(sourceKey: string, entry: CacheEntry): void {
    if (!this.#entries.delete(sourceKey)) return
    this.#estimatedBytes -= entry.source.estimatedBytes
  }

  #evict(): void {
    while (this.#entries.size > this.maxEntries || this.#estimatedBytes > this.maxBytes) {
      const victim = [...this.#entries].find(([, entry]) => entry.pinCount === 0)
      if (!victim) return
      this.#remove(victim[0], victim[1])
    }
  }
}
