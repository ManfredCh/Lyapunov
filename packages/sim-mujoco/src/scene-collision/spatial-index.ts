import type { Bounds3, CanonicalTriangleMesh, Vec3 } from "./glb-mesh.ts"

export interface CanonicalTriangleRef {
  /** Dense triangle position in CanonicalTriangleMesh.indices. */
  triangleIndex: number
  /** Stable source traversal ID retained by the canonical mesh extractor. */
  triangleId: number
}

export interface CanonicalRay {
  origin: Vec3
  direction: Vec3
  near?: number
  far?: number
}

export interface CanonicalRaycastHit extends CanonicalTriangleRef {
  point: [number, number, number]
  /** Winding-derived unit normal in the canonical target frame. */
  normal: [number, number, number]
  /** Metres from origin because ray direction is normalized internally. */
  distance: number
}

export interface CanonicalTriangleSpatialIndexOptions {
  maxLeafTriangles?: number
}

interface BvhNode {
  bounds: Bounds3
  start: number
  end: number
  left?: BvhNode
  right?: BvhNode
}

interface MutableVec3 {
  x: number
  y: number
  z: number
}

const DEFAULT_MAX_LEAF_TRIANGLES = 8
const RAY_EPSILON = 1e-12

function createEmptyBounds(): Bounds3 {
  return {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  }
}

function includeBounds(target: Bounds3, source: Bounds3): void {
  target.min[0] = Math.min(target.min[0], source.min[0])
  target.min[1] = Math.min(target.min[1], source.min[1])
  target.min[2] = Math.min(target.min[2], source.min[2])
  target.max[0] = Math.max(target.max[0], source.max[0])
  target.max[1] = Math.max(target.max[1], source.max[1])
  target.max[2] = Math.max(target.max[2], source.max[2])
}

function finiteVec3(value: Vec3): boolean {
  return value.length === 3 && value.every(Number.isFinite)
}

function validBounds(bounds: Bounds3): boolean {
  return (
    finiteVec3(bounds.min) &&
    finiteVec3(bounds.max) &&
    bounds.min[0] <= bounds.max[0] &&
    bounds.min[1] <= bounds.max[1] &&
    bounds.min[2] <= bounds.max[2]
  )
}

function overlaps(a: Bounds3, b: Bounds3): boolean {
  return !(
    a.max[0] < b.min[0] || a.min[0] > b.max[0] ||
    a.max[1] < b.min[1] || a.min[1] > b.max[1] ||
    a.max[2] < b.min[2] || a.min[2] > b.max[2]
  )
}

function rayIntersectsBounds(
  origin: Vec3,
  direction: Vec3,
  bounds: Bounds3,
  near: number,
  far: number,
): boolean {
  let tMin = near
  let tMax = far
  for (let axis = 0; axis < 3; axis++) {
    const o = origin[axis]
    const d = direction[axis]
    const min = bounds.min[axis]
    const max = bounds.max[axis]
    if (Math.abs(d) <= RAY_EPSILON) {
      if (o < min || o > max) return false
      continue
    }
    let first = (min - o) / d
    let second = (max - o) / d
    if (first > second) [first, second] = [second, first]
    tMin = Math.max(tMin, first)
    tMax = Math.min(tMax, second)
    if (tMax < tMin) return false
  }
  return true
}

function subtract(out: MutableVec3, a: MutableVec3, b: MutableVec3): MutableVec3 {
  out.x = a.x - b.x
  out.y = a.y - b.y
  out.z = a.z - b.z
  return out
}

function cross(out: MutableVec3, a: MutableVec3, b: MutableVec3): MutableVec3 {
  const x = a.y * b.z - a.z * b.y
  const y = a.z * b.x - a.x * b.z
  const z = a.x * b.y - a.y * b.x
  out.x = x
  out.y = y
  out.z = z
  return out
}

function dot(a: MutableVec3, b: MutableVec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

/** Double-sided Möller–Trumbore intersection. */
function intersectTriangle(
  origin: MutableVec3,
  direction: MutableVec3,
  a: MutableVec3,
  b: MutableVec3,
  c: MutableVec3,
  near: number,
  far: number,
): number | undefined {
  const edgeAB = subtract({ x: 0, y: 0, z: 0 }, b, a)
  const edgeAC = subtract({ x: 0, y: 0, z: 0 }, c, a)
  const p = cross({ x: 0, y: 0, z: 0 }, direction, edgeAC)
  const determinant = dot(edgeAB, p)
  if (Math.abs(determinant) <= RAY_EPSILON) return
  const inverse = 1 / determinant
  const fromA = subtract({ x: 0, y: 0, z: 0 }, origin, a)
  const u = dot(fromA, p) * inverse
  if (u < 0 || u > 1) return
  const q = cross({ x: 0, y: 0, z: 0 }, fromA, edgeAB)
  const v = dot(direction, q) * inverse
  if (v < 0 || u + v > 1) return
  const distance = dot(edgeAC, q) * inverse
  if (distance < near || distance > far) return
  return distance
}

/**
 * A detached median-split AABB BVH over canonical triangles.
 *
 * AABB queries are broad-phase and return triangles whose triangle bounds
 * overlap the ROI. Raycasts perform exact triangle intersection and return the
 * nearest hit. No THREE Object3D or BufferGeometry reference is retained.
 */
export class CanonicalTriangleSpatialIndex {
  readonly triangleCount: number
  readonly bounds: Bounds3 | null

  #order: number[]
  #triangleBounds: Bounds3[]
  #triangleCentroids: Float64Array
  #root: BvhNode | null

  constructor(
    readonly mesh: CanonicalTriangleMesh,
    options: CanonicalTriangleSpatialIndexOptions = {},
  ) {
    if (mesh.indices.length % 3 !== 0) throw new Error("canonical mesh indices length must be divisible by 3")
    this.triangleCount = mesh.indices.length / 3
    if (mesh.triangleIds.length !== this.triangleCount) {
      throw new Error("canonical mesh triangleIds must contain one ID per triangle")
    }
    const vertexCount = mesh.vertices.length / 3
    for (const index of mesh.indices) {
      if (!Number.isInteger(index) || index < 0 || index >= vertexCount) {
        throw new Error(`canonical mesh index ${index} is outside vertex range ${vertexCount}`)
      }
    }
    const maxLeafTriangles = options.maxLeafTriangles ?? DEFAULT_MAX_LEAF_TRIANGLES
    if (!Number.isInteger(maxLeafTriangles) || maxLeafTriangles <= 0) {
      throw new Error("maxLeafTriangles must be a positive integer")
    }

    this.#order = Array.from({ length: this.triangleCount }, (_, index) => index)
    this.#triangleBounds = new Array(this.triangleCount)
    this.#triangleCentroids = new Float64Array(this.triangleCount * 3)
    for (let triangle = 0; triangle < this.triangleCount; triangle++) {
      const bounds = this.#computeTriangleBounds(triangle)
      this.#triangleBounds[triangle] = bounds
      const offset = triangle * 3
      this.#triangleCentroids[offset] = (bounds.min[0] + bounds.max[0]) / 2
      this.#triangleCentroids[offset + 1] = (bounds.min[1] + bounds.max[1]) / 2
      this.#triangleCentroids[offset + 2] = (bounds.min[2] + bounds.max[2]) / 2
    }
    this.#root = this.triangleCount > 0 ? this.#buildNode(0, this.triangleCount, maxLeafTriangles) : null
    this.bounds = this.#root ? this.#cloneBounds(this.#root.bounds) : null
  }

  /** Broad-phase AABB overlap query, ordered by canonical triangle index. */
  queryAabb(roi: Bounds3): CanonicalTriangleRef[] {
    if (!validBounds(roi)) throw new Error("ROI bounds must be finite and min <= max")
    if (!this.#root) return []
    const triangleIndexes: number[] = []
    const visit = (node: BvhNode) => {
      if (!overlaps(node.bounds, roi)) return
      if (!node.left && !node.right) {
        for (let position = node.start; position < node.end; position++) {
          const triangleIndex = this.#order[position]
          if (overlaps(this.#triangleBounds[triangleIndex], roi)) triangleIndexes.push(triangleIndex)
        }
        return
      }
      if (node.left) visit(node.left)
      if (node.right) visit(node.right)
    }
    visit(this.#root)
    triangleIndexes.sort((a, b) => a - b)
    return triangleIndexes.map((triangleIndex) => ({
      triangleIndex,
      triangleId: this.mesh.triangleIds[triangleIndex],
    }))
  }

  raycast(ray: CanonicalRay): CanonicalRaycastHit | null {
    if (!finiteVec3(ray.origin) || !finiteVec3(ray.direction)) {
      throw new Error("ray origin and direction must contain finite values")
    }
    const directionLength = Math.hypot(ray.direction[0], ray.direction[1], ray.direction[2])
    if (directionLength <= RAY_EPSILON) throw new Error("ray direction must be non-zero")
    const direction: [number, number, number] = [
      ray.direction[0] / directionLength,
      ray.direction[1] / directionLength,
      ray.direction[2] / directionLength,
    ]
    const near = ray.near ?? 0
    const far = ray.far ?? Number.POSITIVE_INFINITY
    if (!Number.isFinite(near) || near < 0 || Number.isNaN(far) || far < near) {
      throw new Error("ray range must satisfy 0 <= near <= far")
    }
    if (!this.#root || !rayIntersectsBounds(ray.origin, direction, this.#root.bounds, near, far)) return null

    const originVec = { x: ray.origin[0], y: ray.origin[1], z: ray.origin[2] }
    const directionVec = { x: direction[0], y: direction[1], z: direction[2] }
    let nearestDistance = far
    let nearestTriangle = -1
    const a = { x: 0, y: 0, z: 0 }
    const b = { x: 0, y: 0, z: 0 }
    const c = { x: 0, y: 0, z: 0 }

    const visit = (node: BvhNode) => {
      if (!rayIntersectsBounds(ray.origin, direction, node.bounds, near, nearestDistance)) return
      if (!node.left && !node.right) {
        for (let position = node.start; position < node.end; position++) {
          const triangleIndex = this.#order[position]
          this.#readTriangle(triangleIndex, a, b, c)
          const distance = intersectTriangle(originVec, directionVec, a, b, c, near, nearestDistance)
          if (distance === undefined) continue
          if (
            nearestTriangle < 0 ||
            distance < nearestDistance ||
            (distance === nearestDistance && triangleIndex < nearestTriangle)
          ) {
            nearestDistance = distance
            nearestTriangle = triangleIndex
          }
        }
        return
      }
      if (node.left) visit(node.left)
      if (node.right) visit(node.right)
    }
    visit(this.#root)
    if (nearestTriangle < 0) return null

    this.#readTriangle(nearestTriangle, a, b, c)
    const edgeAB = subtract({ x: 0, y: 0, z: 0 }, b, a)
    const edgeAC = subtract({ x: 0, y: 0, z: 0 }, c, a)
    const normal = cross({ x: 0, y: 0, z: 0 }, edgeAB, edgeAC)
    const normalLength = Math.hypot(normal.x, normal.y, normal.z)
    const unitNormal: [number, number, number] = [
      normal.x / normalLength,
      normal.y / normalLength,
      normal.z / normalLength,
    ]
    return {
      triangleIndex: nearestTriangle,
      triangleId: this.mesh.triangleIds[nearestTriangle],
      point: [
        ray.origin[0] + direction[0] * nearestDistance,
        ray.origin[1] + direction[1] * nearestDistance,
        ray.origin[2] + direction[2] * nearestDistance,
      ],
      normal: unitNormal,
      distance: nearestDistance,
    }
  }

  #cloneBounds(bounds: Bounds3): Bounds3 {
    return { min: [...bounds.min], max: [...bounds.max] }
  }

  #computeTriangleBounds(triangleIndex: number): Bounds3 {
    const bounds = createEmptyBounds()
    const indexOffset = triangleIndex * 3
    for (let corner = 0; corner < 3; corner++) {
      const vertexIndex = this.mesh.indices[indexOffset + corner]
      const vertexOffset = vertexIndex * 3
      const x = this.mesh.vertices[vertexOffset]
      const y = this.mesh.vertices[vertexOffset + 1]
      const z = this.mesh.vertices[vertexOffset + 2]
      bounds.min[0] = Math.min(bounds.min[0], x)
      bounds.min[1] = Math.min(bounds.min[1], y)
      bounds.min[2] = Math.min(bounds.min[2], z)
      bounds.max[0] = Math.max(bounds.max[0], x)
      bounds.max[1] = Math.max(bounds.max[1], y)
      bounds.max[2] = Math.max(bounds.max[2], z)
    }
    return bounds
  }

  #buildNode(start: number, end: number, maxLeafTriangles: number): BvhNode {
    const bounds = createEmptyBounds()
    const centroidBounds = createEmptyBounds()
    for (let position = start; position < end; position++) {
      const triangle = this.#order[position]
      includeBounds(bounds, this.#triangleBounds[triangle])
      const offset = triangle * 3
      const x = this.#triangleCentroids[offset]
      const y = this.#triangleCentroids[offset + 1]
      const z = this.#triangleCentroids[offset + 2]
      centroidBounds.min[0] = Math.min(centroidBounds.min[0], x)
      centroidBounds.min[1] = Math.min(centroidBounds.min[1], y)
      centroidBounds.min[2] = Math.min(centroidBounds.min[2], z)
      centroidBounds.max[0] = Math.max(centroidBounds.max[0], x)
      centroidBounds.max[1] = Math.max(centroidBounds.max[1], y)
      centroidBounds.max[2] = Math.max(centroidBounds.max[2], z)
    }
    const node: BvhNode = { bounds, start, end }
    if (end - start <= maxLeafTriangles) return node

    const extents = [
      centroidBounds.max[0] - centroidBounds.min[0],
      centroidBounds.max[1] - centroidBounds.min[1],
      centroidBounds.max[2] - centroidBounds.min[2],
    ]
    const axis = extents[1] > extents[0] ? (extents[2] > extents[1] ? 2 : 1) : extents[2] > extents[0] ? 2 : 0
    const sorted = this.#order.slice(start, end).sort((first, second) => {
      const delta = this.#triangleCentroids[first * 3 + axis] - this.#triangleCentroids[second * 3 + axis]
      return delta || first - second
    })
    // Write the sorted slice back in place without spreading it as arguments:
    // `splice(start, n, ...sorted)` spreads every element onto the call stack, so
    // a large root slice (a big scene mesh has 10^5+ triangles) overflows with
    // "Maximum call stack size exceeded" and the whole source build fails.
    for (let position = 0; position < sorted.length; position++) {
      this.#order[start + position] = sorted[position]
    }
    const middle = start + Math.floor((end - start) / 2)
    node.left = this.#buildNode(start, middle, maxLeafTriangles)
    node.right = this.#buildNode(middle, end, maxLeafTriangles)
    return node
  }

  #readTriangle(triangleIndex: number, a: MutableVec3, b: MutableVec3, c: MutableVec3): void {
    const output = [a, b, c]
    const indexOffset = triangleIndex * 3
    for (let corner = 0; corner < 3; corner++) {
      const vertexIndex = this.mesh.indices[indexOffset + corner]
      const vertexOffset = vertexIndex * 3
      const point = output[corner]
      point.x = this.mesh.vertices[vertexOffset]
      point.y = this.mesh.vertices[vertexOffset + 1]
      point.z = this.mesh.vertices[vertexOffset + 2]
    }
  }
}
