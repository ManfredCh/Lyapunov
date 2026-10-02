/**
 * glb-mesh — 无依赖的 GLB → 三角形网格读取器，替代参考实现里的
 * THREE.GLTFLoader + extractCanonicalTriangleMesh。
 *
 * 两个阶段：
 *  1. readGlbTriangleSoup：解析 12 字节头 + JSON/BIN chunk，沿 node 层级
 *     （TRS 或 matrix，列主序）把 mesh/primitive（仅 mode 4 TRIANGLES）的
 *     POSITION（VEC3/5126）与可选 indices（5121/5123/5125）展开为
 *     glTF 根坐标系的 Float64 三角形汤。不支持的特性（draco、sparse
 *     accessor、外部 buffer、非三角形模式、实例化扩展等）明确报错。
 *  2. canonicalizeTriangleSoup：把汤按 sourceToTarget 变换为目标坐标系
 *     （米制）的 CanonicalTriangleMesh，语义与旧 extractCanonicalTriangleMesh
 *     一致：每个被接受的三角形独占 3 个顶点、记录确定性 triangleIds、
 *     跳过非有限/退化三角形并统计。
 */

import type { Bounds3, Vec3 } from "./contracts.ts"
import { applyMat4ToPoint, identityMat4, isFiniteMat4, mat4FromTrs, multiplyMat4, type Mat4 } from "./mat4.ts"

export type { Bounds3, Vec3 }

export interface CanonicalTriangleMeshStats {
  visitedMeshes: number
  visitedInstances: number
  sourceTriangles: number
  acceptedTriangles: number
  skippedNonFiniteTriangles: number
  skippedDegenerateTriangles: number
  skippedMissingPositionMeshes: number
}

/**
 * Detached triangle data in the collision target frame.
 *
 * Vertices are expressed in metres. Each accepted triangle owns three
 * vertices, so the output no longer depends on the source GLB bytes.
 * `triangleIds` maps each output triangle back to its deterministic source
 * traversal ID; IDs can have gaps when a source triangle was rejected.
 */
export interface CanonicalTriangleMesh {
  readonly units: "meters"
  readonly vertices: Float64Array
  readonly indices: Uint32Array
  readonly triangleIds: Uint32Array
  readonly bounds: Bounds3 | null
  readonly stats: CanonicalTriangleMeshStats
}

export class GlbMeshError extends Error {
  constructor(
    readonly code:
      | "invalid_glb"
      | "unsupported_feature"
      | "unsupported_primitive_mode"
      | "invalid_accessor"
      | "invalid_node_hierarchy"
      | "invalid_source_to_target"
      | "invalid_min_triangle_area"
      | "triangle_id_overflow",
    message: string,
  ) {
    super(message)
    this.name = "GlbMeshError"
  }
}

export interface GltfTriangleSoupStats {
  visitedMeshes: number
  visitedInstances: number
  sourceTriangles: number
  skippedMissingPositionMeshes: number
}

/** glTF 根坐标系的三角形汤（node 世界变换已应用，顶点共享）。 */
export interface GltfTriangleSoup {
  readonly positions: Float64Array
  readonly indices: Uint32Array
  readonly stats: GltfTriangleSoupStats
}

const GLB_MAGIC = 0x46546c67
const GLB_VERSION = 2
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942
const MODE_TRIANGLES = 4
const COMPONENT_BYTE = 5121
const COMPONENT_USHORT = 5123
const COMPONENT_UINT = 5125
const COMPONENT_FLOAT = 5126
const MAX_UINT32 = 0xffff_ffff

type Json = Record<string, unknown>

function asRecord(value: unknown, label: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GlbMeshError("invalid_glb", `glTF ${label} must be an object`)
  }
  return value as Json
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new GlbMeshError("invalid_glb", `glTF ${label} must be an array`)
  return value
}

function asIndex(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new GlbMeshError("invalid_glb", `glTF ${label} must be a non-negative integer`)
  }
  return value
}

function unsupported(message: string): GlbMeshError {
  return new GlbMeshError("unsupported_feature", message)
}

interface AccessorView {
  readonly view: DataView
  readonly byteOffset: number
  readonly byteStride: number
  readonly count: number
  readonly componentType: number
}

function accessorView(doc: Json, bin: DataView, accessorIndex: number, label: string): AccessorView {
  const accessors = asArray(doc.accessors, "accessors")
  const accessor = asRecord(accessors[accessorIndex], `accessor ${accessorIndex}`)
  if (accessor.sparse !== undefined) throw unsupported(`glTF sparse accessors are not supported (${label})`)
  if (accessor.normalized === true) throw unsupported(`glTF normalized accessors are not supported (${label})`)
  const componentType = asIndex(accessor.componentType, `accessor ${accessorIndex} componentType`)
  const count = asIndex(accessor.count, `accessor ${accessorIndex} count`)
  const bufferViews = asArray(doc.bufferViews, "bufferViews")
  const bufferViewIndex = asIndex(accessor.bufferView, `accessor ${accessorIndex} bufferView`)
  const bufferView = asRecord(bufferViews[bufferViewIndex], `bufferView ${bufferViewIndex}`)
  if (bufferView.target !== undefined && bufferView.target !== 34962 && bufferView.target !== 34963) {
    throw unsupported(`glTF bufferView target ${String(bufferView.target)} is not supported (${label})`)
  }
  const bufferIndex = asIndex(bufferView.buffer, `bufferView ${bufferViewIndex} buffer`)
  const buffers = asArray(doc.buffers, "buffers")
  const buffer = asRecord(buffers[bufferIndex], `buffer ${bufferIndex}`)
  if (buffer.uri !== undefined) throw unsupported(`glTF external buffers are not supported (${label})`)
  if (bufferIndex !== 0) throw unsupported(`glTF buffer ${bufferIndex} has no BIN chunk data (${label})`)
  const componentSize =
    componentType === COMPONENT_BYTE ? 1 : componentType === COMPONENT_USHORT ? 2 : componentType === COMPONENT_UINT || componentType === COMPONENT_FLOAT ? 4 : 0
  if (!componentSize) throw new GlbMeshError("invalid_accessor", `accessor ${accessorIndex} componentType ${componentType} is not supported (${label})`)
  const componentCount = accessor.type === "SCALAR" ? 1 : accessor.type === "VEC3" ? 3 : 0
  if (!componentCount) throw new GlbMeshError("invalid_accessor", `accessor ${accessorIndex} type ${String(accessor.type)} is not VEC3/SCALAR (${label})`)
  const tightStride = componentSize * componentCount
  const byteStride = bufferView.byteStride === undefined ? tightStride : asIndex(bufferView.byteStride, `bufferView ${bufferViewIndex} byteStride`)
  if (byteStride < tightStride) {
    throw new GlbMeshError("invalid_accessor", `accessor ${accessorIndex} byteStride ${byteStride} < ${tightStride} (${label})`)
  }
  const bufferViewByteOffset = bufferView.byteOffset === undefined ? 0 : asIndex(bufferView.byteOffset, `bufferView ${bufferViewIndex} byteOffset`)
  const bufferViewByteLength = asIndex(bufferView.byteLength, `bufferView ${bufferViewIndex} byteLength`)
  const accessorByteOffset = accessor.byteOffset === undefined ? 0 : asIndex(accessor.byteOffset, `accessor ${accessorIndex} byteOffset`)
  if (count > 0 && accessorByteOffset + (count - 1) * byteStride + tightStride > bufferViewByteLength) {
    throw new GlbMeshError("invalid_accessor", `accessor ${accessorIndex} overruns bufferView ${bufferViewIndex} (${label})`)
  }
  if (bufferViewByteOffset + bufferViewByteLength > bin.byteLength) {
    throw new GlbMeshError("invalid_glb", `bufferView ${bufferViewIndex} overruns the GLB BIN chunk (${label})`)
  }
  return { view: bin, byteOffset: bufferViewByteOffset + accessorByteOffset, byteStride, count, componentType }
}

function readFloatVec3(view: AccessorView, index: number, out: [number, number, number]): void {
  const offset = view.byteOffset + index * view.byteStride
  out[0] = view.view.getFloat32(offset, true)
  out[1] = view.view.getFloat32(offset + 4, true)
  out[2] = view.view.getFloat32(offset + 8, true)
}

function readScalarIndex(view: AccessorView, index: number): number {
  const offset = view.byteOffset + index * view.byteStride
  if (view.componentType === COMPONENT_BYTE) return view.view.getUint8(offset)
  if (view.componentType === COMPONENT_USHORT) return view.view.getUint16(offset, true)
  return view.view.getUint32(offset, true)
}

function nodeLocalMatrix(node: Json, label: string): Mat4 {
  if (node.matrix !== undefined) {
    const matrix = node.matrix
    if (!Array.isArray(matrix) || matrix.length !== 16 || matrix.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new GlbMeshError("invalid_node_hierarchy", `glTF ${label} matrix must be 16 finite numbers`)
    }
    return [...matrix] as Mat4
  }
  const tuple = (value: unknown, length: number, fallback: number[], field: string): number[] => {
    if (value === undefined) return fallback
    if (!Array.isArray(value) || value.length !== length || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
      throw new GlbMeshError("invalid_node_hierarchy", `glTF ${label} ${field} must be ${length} finite numbers`)
    }
    return [...value] as number[]
  }
  return mat4FromTrs({
    position: tuple(node.translation, 3, [0, 0, 0], "translation") as [number, number, number],
    quaternion: tuple(node.rotation, 4, [0, 0, 0, 1], "rotation") as [number, number, number, number],
    scale: tuple(node.scale, 3, [1, 1, 1], "scale") as [number, number, number],
  })
}

/**
 * Parse a GLB binary into a triangle soup in the glTF root frame.
 * Node hierarchy transforms are applied; metres are assumed (the scene-geometry
 * binding contract records meshToSplat against this same frame).
 */
export function readGlbTriangleSoup(bytes: Uint8Array): GltfTriangleSoup {
  if (bytes.length < 20) throw new GlbMeshError("invalid_glb", "GLB payload is too small for header and JSON chunk")
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = header.getUint32(0, true)
  const version = header.getUint32(4, true)
  const totalLength = header.getUint32(8, true)
  if (magic !== GLB_MAGIC) throw new GlbMeshError("invalid_glb", "GLB magic mismatch")
  if (version !== GLB_VERSION) throw new GlbMeshError("invalid_glb", `GLB version ${version} is not 2`)
  if (totalLength > bytes.length) throw new GlbMeshError("invalid_glb", "GLB declared length exceeds the buffer")

  let jsonText: string | undefined
  let bin: DataView | undefined
  let offset = 12
  while (offset + 8 <= totalLength) {
    const chunkLength = header.getUint32(offset, true)
    const chunkType = header.getUint32(offset + 4, true)
    const start = offset + 8
    if (start + chunkLength > totalLength) throw new GlbMeshError("invalid_glb", "GLB chunk overruns the declared length")
    if (chunkType === CHUNK_JSON) {
      if (jsonText !== undefined) throw new GlbMeshError("invalid_glb", "GLB contains more than one JSON chunk")
      jsonText = new TextDecoder().decode(bytes.subarray(start, start + chunkLength))
    } else if (chunkType === CHUNK_BIN) {
      if (bin !== undefined) throw new GlbMeshError("invalid_glb", "GLB contains more than one BIN chunk")
      bin = new DataView(bytes.buffer, bytes.byteOffset + start, chunkLength)
    }
    offset = start + chunkLength + (chunkLength % 4 === 0 ? 0 : 4 - (chunkLength % 4))
  }
  if (jsonText === undefined) throw new GlbMeshError("invalid_glb", "GLB has no JSON chunk")

  let doc: Json
  try {
    doc = asRecord(JSON.parse(jsonText), "document")
  } catch (error) {
    if (error instanceof GlbMeshError) throw error
    throw new GlbMeshError("invalid_glb", `GLB JSON chunk does not parse: ${error instanceof Error ? error.message : String(error)}`)
  }

  const extensionsRequired = doc.extensionsRequired === undefined ? [] : asArray(doc.extensionsRequired, "extensionsRequired")
  if (extensionsRequired.length > 0) {
    throw unsupported(`glTF extensionsRequired are not supported: ${extensionsRequired.join(", ")}`)
  }
  const extensionsUsed = doc.extensionsUsed === undefined ? [] : asArray(doc.extensionsUsed, "extensionsUsed")
  if (extensionsUsed.some((name) => name === "KHR_draco_mesh_compression")) {
    throw unsupported("glTF KHR_draco_mesh_compression is not supported")
  }

  const nodes = doc.nodes === undefined ? [] : asArray(doc.nodes, "nodes").map((node, index) => asRecord(node, `node ${index}`))
  const meshes = doc.meshes === undefined ? [] : asArray(doc.meshes, "meshes").map((mesh, index) => asRecord(mesh, `mesh ${index}`))
  const scenes = asArray(doc.scenes ?? [], "scenes")
  const sceneIndex = doc.scene === undefined ? 0 : asIndex(doc.scene, "scene")
  const scene = asRecord(scenes[sceneIndex] ?? { nodes: [] }, `scene ${sceneIndex}`)
  const roots = scene.nodes === undefined ? [] : asArray(scene.nodes, `scene ${sceneIndex} nodes`).map((node) => asIndex(node, "scene node"))
  if (nodes.length > 0 && bin === undefined) throw new GlbMeshError("invalid_glb", "GLB has nodes but no BIN chunk")

  const positions: number[] = []
  const indices: number[] = []
  const stats: GltfTriangleSoupStats = {
    visitedMeshes: 0,
    visitedInstances: 0,
    sourceTriangles: 0,
    skippedMissingPositionMeshes: 0,
  }
  const visited = new Set<number>()
  const point: [number, number, number] = [0, 0, 0]

  const visitMesh = (meshIndex: number, nodeToRoot: Mat4): void => {
    const mesh = meshes[meshIndex]
    if (!mesh) throw new GlbMeshError("invalid_glb", `glTF mesh ${meshIndex} is missing`)
    stats.visitedMeshes++
    const primitives = asArray(mesh.primitives ?? [], `mesh ${meshIndex} primitives`)
    for (const [primitiveIndex, rawPrimitive] of primitives.entries()) {
      const primitive = asRecord(rawPrimitive, `mesh ${meshIndex} primitive ${primitiveIndex}`)
      const label = `mesh ${meshIndex} primitive ${primitiveIndex}`
      if (primitive.extensions !== undefined) {
        const extensions = asRecord(primitive.extensions, `${label} extensions`)
        if (extensions.KHR_draco_mesh_compression !== undefined) {
          throw unsupported(`glTF KHR_draco_mesh_compression is not supported (${label})`)
        }
      }
      const mode = primitive.mode === undefined ? MODE_TRIANGLES : asIndex(primitive.mode, `${label} mode`)
      if (mode !== MODE_TRIANGLES) {
        throw new GlbMeshError("unsupported_primitive_mode", `glTF ${label} mode ${mode} is not TRIANGLES(4)`)
      }
      const attributes = asRecord(primitive.attributes ?? {}, `${label} attributes`)
      if (attributes.POSITION === undefined) {
        stats.skippedMissingPositionMeshes++
        continue
      }
      const positionView = accessorView(doc, bin!, asIndex(attributes.POSITION, `${label} POSITION`), `${label} POSITION`)
      if (positionView.componentType !== COMPONENT_FLOAT) {
        throw new GlbMeshError("invalid_accessor", `glTF ${label} POSITION must be float32 VEC3`)
      }
      const indexView =
        primitive.indices === undefined
          ? undefined
          : accessorView(doc, bin!, asIndex(primitive.indices, `${label} indices`), `${label} indices`)
      if (indexView && indexView.componentType !== COMPONENT_BYTE && indexView.componentType !== COMPONENT_USHORT && indexView.componentType !== COMPONENT_UINT) {
        throw new GlbMeshError("invalid_accessor", `glTF ${label} indices must be u8/u16/u32 SCALAR`)
      }
      stats.visitedInstances++
      const elementCount = indexView?.count ?? positionView.count
      const triangleCount = Math.floor(elementCount / 3)
      const baseVertex = positions.length / 3
      for (let vertex = 0; vertex < positionView.count; vertex++) {
        readFloatVec3(positionView, vertex, point)
        const [x, y, z] = applyMat4ToPoint(nodeToRoot, point)
        positions.push(x, y, z)
      }
      for (let element = 0; element < triangleCount * 3; element++) {
        const sourceIndex = indexView ? readScalarIndex(indexView, element) : element
        if (sourceIndex >= positionView.count) {
          throw new GlbMeshError("invalid_accessor", `glTF ${label} index ${sourceIndex} exceeds POSITION count ${positionView.count}`)
        }
        indices.push(baseVertex + sourceIndex)
      }
      stats.sourceTriangles += triangleCount
    }
  }

  const walk = (nodeIndex: number, parentToRoot: Mat4): void => {
    if (visited.has(nodeIndex)) {
      throw new GlbMeshError("invalid_node_hierarchy", `GLTF_NODE_CYCLE_OR_MULTI_PARENT: ${nodeIndex}`)
    }
    visited.add(nodeIndex)
    const node = nodes[nodeIndex]
    if (!node) throw new GlbMeshError("invalid_glb", `GLTF_NODE_MISSING: ${nodeIndex}`)
    const nodeToRoot = multiplyMat4(parentToRoot, nodeLocalMatrix(node, `node ${nodeIndex}`))
    if (node.mesh !== undefined) visitMesh(asIndex(node.mesh, `node ${nodeIndex} mesh`), nodeToRoot)
    const children = node.children === undefined ? [] : asArray(node.children, `node ${nodeIndex} children`)
    for (const child of children) walk(asIndex(child, `node ${nodeIndex} child`), nodeToRoot)
  }
  for (const root of roots) walk(root, identityMat4())

  return {
    positions: new Float64Array(positions),
    indices: new Uint32Array(indices),
    stats,
  }
}

const DEFAULT_MIN_TRIANGLE_AREA_M2 = 1e-12

function includePoint(bounds: Bounds3, point: readonly [number, number, number]): void {
  bounds.min[0] = Math.min(bounds.min[0], point[0])
  bounds.min[1] = Math.min(bounds.min[1], point[1])
  bounds.min[2] = Math.min(bounds.min[2], point[2])
  bounds.max[0] = Math.max(bounds.max[0], point[0])
  bounds.max[1] = Math.max(bounds.max[1], point[1])
  bounds.max[2] = Math.max(bounds.max[2], point[2])
}

/**
 * Transform a glTF-root-frame soup into the collision target frame, retaining
 * no alias to the soup. Port of the per-triangle accept/reject semantics of the
 * old THREE-based extractCanonicalTriangleMesh.
 */
export function canonicalizeTriangleSoup(
  soup: GltfTriangleSoup,
  sourceToTarget: Mat4,
  minTriangleAreaM2: number = DEFAULT_MIN_TRIANGLE_AREA_M2,
): CanonicalTriangleMesh {
  if (!isFiniteMat4(sourceToTarget)) {
    throw new GlbMeshError("invalid_source_to_target", "sourceToTarget must contain 16 finite values")
  }
  if (!Number.isFinite(minTriangleAreaM2) || minTriangleAreaM2 < 0) {
    throw new GlbMeshError("invalid_min_triangle_area", "minTriangleAreaM2 must be finite and non-negative")
  }
  if (soup.indices.length % 3 !== 0) throw new GlbMeshError("invalid_glb", "soup indices length must be divisible by 3")

  const vertices: number[] = []
  const indices: number[] = []
  const triangleIds: number[] = []
  const bounds: Bounds3 = {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  }
  const stats: CanonicalTriangleMeshStats = {
    visitedMeshes: soup.stats.visitedMeshes,
    visitedInstances: soup.stats.visitedInstances,
    sourceTriangles: 0,
    acceptedTriangles: 0,
    skippedNonFiniteTriangles: 0,
    skippedDegenerateTriangles: 0,
    skippedMissingPositionMeshes: soup.stats.skippedMissingPositionMeshes,
  }

  const minDoubleArea = minTriangleAreaM2 * 2
  const minDoubleAreaSq = minDoubleArea * minDoubleArea
  const triangleCount = soup.indices.length / 3
  const corner: [number, number, number] = [0, 0, 0]
  const transformed: [number, number, number][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  let nextTriangleId = 0

  for (let triangle = 0; triangle < triangleCount; triangle++) {
    if (nextTriangleId > MAX_UINT32) {
      throw new GlbMeshError("triangle_id_overflow", "source contains more than uint32-addressable triangles")
    }
    const triangleId = nextTriangleId++
    stats.sourceTriangles++
    let finite = true
    for (let c = 0; c < 3; c++) {
      const vertexIndex = soup.indices[triangle * 3 + c]!
      corner[0] = soup.positions[vertexIndex * 3]!
      corner[1] = soup.positions[vertexIndex * 3 + 1]!
      corner[2] = soup.positions[vertexIndex * 3 + 2]!
      const out = applyMat4ToPoint(sourceToTarget, corner)
      if (!out.every(Number.isFinite)) finite = false
      transformed[c] = out
    }
    if (!finite) {
      stats.skippedNonFiniteTriangles++
      continue
    }
    const [a, b, c] = transformed as [[number, number, number], [number, number, number], [number, number, number]]
    const abx = b[0] - a[0]
    const aby = b[1] - a[1]
    const abz = b[2] - a[2]
    const acx = c[0] - a[0]
    const acy = c[1] - a[1]
    const acz = c[2] - a[2]
    const cx = aby * acz - abz * acy
    const cy = abz * acx - abx * acz
    const cz = abx * acy - aby * acx
    const doubleAreaSq = cx * cx + cy * cy + cz * cz
    if (!Number.isFinite(doubleAreaSq) || doubleAreaSq <= minDoubleAreaSq) {
      stats.skippedDegenerateTriangles++
      continue
    }

    const baseVertex = vertices.length / 3
    vertices.push(...a, ...b, ...c)
    indices.push(baseVertex, baseVertex + 1, baseVertex + 2)
    triangleIds.push(triangleId)
    includePoint(bounds, a)
    includePoint(bounds, b)
    includePoint(bounds, c)
    stats.acceptedTriangles++
  }

  return {
    units: "meters",
    vertices: new Float64Array(vertices),
    indices: new Uint32Array(indices),
    triangleIds: new Uint32Array(triangleIds),
    bounds: stats.acceptedTriangles > 0 ? bounds : null,
    stats,
  }
}

/** Convenience: GLB bytes → canonical target-frame mesh in one call. */
export function canonicalTriangleMeshFromGlb(
  bytes: Uint8Array,
  sourceToTarget: Mat4,
  minTriangleAreaM2?: number,
): CanonicalTriangleMesh {
  return canonicalizeTriangleSoup(readGlbTriangleSoup(bytes), sourceToTarget, minTriangleAreaM2)
}
