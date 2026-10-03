import { createHash } from "node:crypto"
import { Matrix4, Quaternion, Vector3 } from "three"
import type { ResourceRef, Vec3 } from "../../lyapunov-contracts/src/types.ts"
import { GLTF_SOURCE, glbJSON, sourceTransform } from "./formats.ts"

/**
 * 资源原件的**几何事实**：只读 GLB 字节，把**实际显示出来的**几何——每个网格节点在实体本地
 * 坐标系（米）里的「顶点位置集合 + 三角面多重集合」——量化后哈希。
 *
 * 为什么必须带上节点层级：原件里的顶点是**节点局部坐标**，真正显示出来的位置还要经过该节点
 * 全部内部祖先的 TRS/matrix（以及源坐标轴适配与米换算）。只读原始 POSITION 会把"内部节点
 * 平移/旋转/缩放改了"误判成几何没变——实测反例（`root-103-internal-transform-valid-probe.ts`）：
 * 单位盒的 `node.translation` 从 [0,0,0] 改成 [4,0,0]，真实 GLTFLoader 的画面包围盒
 * [0,0,0]..[1,1,1] → [4,0,0]..[5,1,1]，而只读 POSITION 的判据仍报"一致"，旧碰撞就留在了原地。
 * 绕 X 轴转 90° 的对称件同样有判别力：包围盒逐轴不变、顶点世界位置全变。
 *
 * 判据刻意不是包围盒、也不是"模型自称没改几何"：同包围盒的凹腔/开洞/换面片都能改掉实体上
 * 那份派生碰撞，只有逐面的几何事实能证明它没变。
 *
 * 为什么是集合而不是顶点数组逐字节相等：材质/贴图变化会让导出器把一个网格按材质拆成多个
 * primitive（实测 CaseA→C 的墙件 24 顶点 1 primitive → 20+4 顶点 2 primitive），顶点计数、
 * 访问器布局、面顺序都会变，但位置集合与面片多重集合不变——那才是"同一份几何"。
 *
 * 只接受能可靠读成"静态三角面网格"的形态：外部 .bin、非三角面图元、缺 POSITION、整数/归一化
 * 坐标、压缩扩展（draco/meshopt）、蒙皮、morph targets、会驱动显示节点的动画一律明确报
 * **不可核对**，不猜、不放行。常规 sparse accessor 按规范读真值（three 的 GLTFLoader 也支持），
 * 否则"只改 sparse 变位"的新版本会被当成 base 数组相同而误判一致。
 */
export interface GeometryNodeFacts {
  /** 该节点所有 primitive 合并后的去重顶点数。 */
  vertexCount: number
  triangleCount: number
  /** 该节点几何事实的 sha256（实体本地米制下的顶点集合 + 三角面多重集合）。 */
  digest: string
  /** 量化前的实际包围盒（实体本地、米）：只用于报告与人工核对，判据不看 bbox。 */
  bounds: { min: Vec3; max: Vec3 }
}

export interface GlbGeometryFacts {
  /** glTF node index → 该节点的几何事实；只包含默认场景里实际显示的网格节点。 */
  nodes: Map<number, GeometryNodeFacts>
  /** 整份文件的几何指纹：按 node index 拼接各节点摘要后的 sha256。 */
  digest: string
  vertexCount: number
  triangleCount: number
  /** 米 / 源单位换算（来自引用的源坐标声明）；事实里的坐标已经按它换算成米。 */
  unitScale: number
  /** 事实坐标系的说明（见 `FRAME`）。 */
  frame: string
  /** 全部节点的实际包围盒（实体本地、米）；只用于报告，判据只看逐节点摘要。 */
  bounds: { min: Vec3; max: Vec3 }
}

export interface GeometryComparison { identical: boolean; reason?: string }

export interface GlbGeometryOptions {
  /**
   * 该引用的源坐标声明：轴适配（Y-up → Z-up）与米换算按它做，与 Viewer 包装原件用的
   * `sourceTransform`（`formats.ts`）是同一份换算——事实坐标系因此是**实体本地**，正是
   * collision 等派生组件所在的坐标系。省略时按 GLB 默认（Y-up、米制、右手）。
   */
  source?: ResourceRef["source"]
}

/** 事实坐标系的一句话说明（会进工具回执，别改口径而不改这里）。 */
export const FRAME = "entity-local meters (all-node TRS/matrix hierarchy + source axis adapter applied)"
/** glTF 的默认源坐标：Y-up、米制、右手（与 `parseAsset` 的 `.glb` 分支同一份）。 */
const DEFAULT_SOURCE: ResourceRef["source"] = GLTF_SOURCE

const COMPONENT_SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }
/** 量化步长（米）：事实坐标已换算成米，源件是 float32，同一次导出的同一顶点不会差过一个微米。 */
const QUANTUM = 1e-6
/**
 * 不影响几何的扩展（材质/纹理/灯光）：只有这些出现在 extensionsUsed/extensionsRequired 里才继续核对。
 * 其余一律不可核对——KHR_draco_mesh_compression/EXT_meshopt_compression 改了顶点数据的存法，
 * KHR_mesh_quantization 改了坐标分量类型，EXT_mesh_gpu_instancing/KHR_materials_variants 改了实际
 * 显示的是哪份顶点。不靠"基准数组看起来一样"放行。
 */
const GEOMETRY_NEUTRAL_EXTENSIONS = new Set(["KHR_texture_transform", "KHR_texture_basisu", "EXT_texture_webp", "EXT_texture_avif", "KHR_lights_punctual", "KHR_xmp_json_ld"])
const GEOMETRY_NEUTRAL_PREFIXES = ["KHR_materials_"]
const geometryNeutralExtension = (name: string): boolean => GEOMETRY_NEUTRAL_EXTENSIONS.has(name) || GEOMETRY_NEUTRAL_PREFIXES.some(prefix => name.startsWith(prefix))

const digestOf = (value: string): string => createHash("sha256").update(value).digest("hex")
const quantized = (value: number): number => {
  if (!Number.isFinite(value)) throw new Error("GEOMETRY_NOT_FINITE")
  return Math.round(value / QUANTUM)
}
/**
 * 报告里回传的坐标压到量化步长：世界变换与源坐标换算会留下 float64 的尾巴
 * （绕轴旋转后的 1 会变成 1.0000000000000002），而 0.5 µm 低于判据自己的分辨率，
 * 压掉不影响任何比较结果，却能让回执里的包围盒是可读的米数。
 */
const snapped = (value: number): number => Number((quantized(value) * QUANTUM).toFixed(6))
const snapBounds = (min: Vector3, max: Vector3): { min: Vec3; max: Vec3 } => ({
  min: [snapped(min.x), snapped(min.y), snapped(min.z)] as Vec3,
  max: [snapped(max.x), snapped(max.y), snapped(max.z)] as Vec3,
})
/** 报告用的短数字：包围盒原值带着 float32→float64 的尾巴，四位小数足够人工核对。 */
const rounded = (value: number): number => (Number.isFinite(value) ? Number(value.toFixed(4)) : value)
const span = (bounds: { min: Vec3; max: Vec3 }): string => `[${bounds.min.map(rounded).join(",")}]..[${bounds.max.map(rounded).join(",")}]`

/** GLB 的二进制块（唯一 chunk type 0x004E4942）；没有 BIN 块时返回 undefined。 */
function glbBinary(buffer: Uint8Array): Uint8Array | undefined {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true)
    if (offset + 8 + length > buffer.length) throw new Error("INVALID_GLB_CHUNK")
    if (type === 0x004e4942) return buffer.subarray(offset + 8, offset + 8 + length)
    offset += 8 + length
  }
  return undefined
}

/**
 * 按 bufferView/byteStride 读出一段分量。只读原件内嵌的 BIN（buffer 0）：外部 .bin 的几何不在
 * 这份字节里，无法按资源版本核对；bufferView 带扩展（meshopt 压缩等）同理。
 */
function readComponents(json: any, binary: Uint8Array, bufferViewIndex: number, byteOffset: number, count: number, components: number, componentType: number, label: string): number[] {
  const view = json.bufferViews?.[bufferViewIndex]
  if (!view) throw new Error(`GEOMETRY_BUFFER_VIEW_MISSING: ${label} bufferView=${bufferViewIndex}`)
  if (view.extensions && Object.keys(view.extensions).length) throw new Error(`GEOMETRY_BUFFER_VIEW_EXTENSION_UNSUPPORTED: ${label} ${Object.keys(view.extensions).join(", ")}`)
  const buffer = view.buffer ?? 0
  if (buffer !== 0 || json.buffers?.[buffer]?.uri !== undefined) throw new Error(`GEOMETRY_EXTERNAL_BUFFER: ${label}`)
  const size = COMPONENT_SIZE[componentType]
  if (!size) throw new Error(`GEOMETRY_COMPONENT_TYPE_UNSUPPORTED: ${label} componentType=${componentType}`)
  const stride = view.byteStride ?? components * size
  const start = (view.byteOffset ?? 0) + byteOffset
  const data = new DataView(binary.buffer, binary.byteOffset, binary.byteLength)
  const values = new Array<number>(count * components)
  for (let item = 0; item < count; item++) for (let component = 0; component < components; component++) {
    const offset = start + item * stride + component * size
    if (offset < 0 || offset + size > binary.byteLength) throw new Error(`GEOMETRY_ACCESSOR_OUT_OF_RANGE: ${label}`)
    let value: number
    switch (componentType) {
      case 5126: value = data.getFloat32(offset, true); break
      case 5125: value = data.getUint32(offset, true); break
      case 5123: value = data.getUint16(offset, true); break
      case 5122: value = data.getInt16(offset, true); break
      case 5121: value = data.getUint8(offset); break
      default: value = data.getInt8(offset)
    }
    values[item * components + component] = value
  }
  return values
}

/**
 * 读一个 accessor 的分量，**sparse 按规范应用**：`accessor.sparse.indices` 指向的槽位用
 * `sparse.values` 覆盖 base。base bufferView 缺失（sparse-only accessor）时 base 视为全零，
 * 这也是规范允许的写法。归一化/整数坐标不在这里换算：POSITION 只接受 float32 VEC3（见下），
 * 免得把没换算的分量当成真值放行。
 */
function readAccessor(json: any, binary: Uint8Array, index: number): number[] {
  const accessor = json.accessors?.[index]
  if (!accessor) throw new Error(`GEOMETRY_ACCESSOR_MISSING: ${index}`)
  const components = TYPE_COMPONENTS[accessor.type]
  if (!components || !COMPONENT_SIZE[accessor.componentType]) throw new Error(`GEOMETRY_ACCESSOR_UNSUPPORTED: ${index} type=${String(accessor.type)} componentType=${String(accessor.componentType)}`)
  const count = accessor.count
  if (!Number.isInteger(count) || count < 0) throw new Error(`GEOMETRY_ACCESSOR_COUNT_INVALID: ${index}`)
  const values = accessor.bufferView === undefined
    ? new Array<number>(count * components).fill(0)
    : readComponents(json, binary, accessor.bufferView, accessor.byteOffset ?? 0, count, components, accessor.componentType, `accessor ${index}`)
  const sparse = accessor.sparse
  if (sparse === undefined) return values
  if (!Number.isInteger(sparse.count) || sparse.count < 0 || !sparse.indices || !sparse.values) throw new Error(`GEOMETRY_SPARSE_INVALID: ${index}`)
  const indexType = sparse.indices.componentType
  if (![5121, 5123, 5125].includes(indexType)) throw new Error(`GEOMETRY_SPARSE_INDEX_TYPE_UNSUPPORTED: ${index} componentType=${String(indexType)}`)
  const targets = readComponents(json, binary, sparse.indices.bufferView, sparse.indices.byteOffset ?? 0, sparse.count, 1, indexType, `accessor ${index} sparse.indices`)
  const replacement = readComponents(json, binary, sparse.values.bufferView, sparse.values.byteOffset ?? 0, sparse.count, components, accessor.componentType, `accessor ${index} sparse.values`)
  for (let item = 0; item < sparse.count; item++) {
    const target = targets[item]!
    if (!Number.isInteger(target) || target < 0 || target >= count) throw new Error(`GEOMETRY_SPARSE_INDEX_OUT_OF_RANGE: ${index} ${target}`)
    for (let component = 0; component < components; component++) values[target * components + component] = replacement[item * components + component]!
  }
  return values
}

/** 节点局部矩阵：`matrix`（列主序，与 three 的 `fromArray` 同序）优先，否则 TRS 复合（与 `formats.ts` 的 `transformOf` 同口径）。 */
function nodeMatrix(node: any, label: string): Matrix4 {
  if (node.matrix !== undefined) {
    const matrix = node.matrix
    if (!Array.isArray(matrix) || matrix.length !== 16 || matrix.some((value: unknown) => typeof value !== "number" || !Number.isFinite(value))) throw new Error(`GEOMETRY_NODE_MATRIX_INVALID: ${label}`)
    return new Matrix4().fromArray(matrix as number[])
  }
  const tuple = (value: unknown, length: number, fallback: number[], field: string): number[] => {
    if (value === undefined) return fallback
    if (!Array.isArray(value) || value.length !== length || value.some((item: unknown) => typeof item !== "number" || !Number.isFinite(item))) throw new Error(`GEOMETRY_NODE_TRS_INVALID: ${label} ${field}`)
    return value as number[]
  }
  return new Matrix4().compose(
    new Vector3(...(tuple(node.translation, 3, [0, 0, 0], "translation") as [number, number, number])),
    new Quaternion(...(tuple(node.rotation, 4, [0, 0, 0, 1], "rotation") as [number, number, number, number])),
    new Vector3(...(tuple(node.scale, 3, [1, 1, 1], "scale") as [number, number, number])),
  )
}

/** Viewer 包原件用的那份源坐标换算（轴适配 + 米换算）；声明不可换算时直接抛错（调用方报"不可核对"）。 */
function sourceMatrix(source: ResourceRef["source"]): { matrix: Matrix4; unitScale: number } {
  const transform = sourceTransform(source)
  return {
    matrix: new Matrix4().compose(new Vector3(...transform.position), new Quaternion(...transform.quaternion), new Vector3(...transform.scale)),
    unitScale: transform.scale[0]!,
  }
}

/** 三角面按位置三元组表示；旋转到最小位置开头（保留绕向），让面片集合与索引顺序无关。 */
function triangleKey(a: string, b: string, c: string): string {
  if (a <= b && a <= c) return `${a}|${b}|${c}`
  if (b <= c) return `${b}|${c}|${a}`
  return `${c}|${a}|${b}`
}

/**
 * 逐节点几何事实。任一节点读不出**实际显示**的几何（缺 POSITION、非三角面、外部 buffer、非有限
 * 坐标、蒙皮/形态/压缩形态）即整体抛错：调用方据此拒绝"保留旧派生组件"，而不是拿一份读不全的
 * 几何当相同。
 */
export function glbGeometryFacts(buffer: Uint8Array, options: GlbGeometryOptions = {}): GlbGeometryFacts {
  const json = glbJSON(buffer)
  const binary = glbBinary(buffer)
  for (const name of [...json.extensionsUsed ?? [], ...json.extensionsRequired ?? []]) if (!geometryNeutralExtension(String(name))) throw new Error(`GEOMETRY_EXTENSION_UNSUPPORTED: ${name}`)
  const nodes: any[] = json.nodes ?? []
  const meshes: any[] = json.meshes ?? []
  const scenes: any[] = json.scenes ?? []
  // 只核对**默认场景里实际显示**的节点：Viewer 加载的就是 gltf.scene（`viewer/src/index.ts`）。
  // 场景列表缺失时按"没有父节点的节点"推论，与 `formats.ts` 的 glbSceneBounds 同一口径。
  const sceneNodes = scenes[Number(json.scene ?? 0)]?.nodes
  const roots: number[] = (Array.isArray(sceneNodes) ? sceneNodes : nodes.map((_, index) => index).filter(index => !nodes.some(node => node.children?.includes(index)))).map(Number)
  const displayed = new Set<number>()
  const placed = new Map<number, Matrix4>()
  const place = (index: number, parent: Matrix4): void => {
    if (placed.has(index)) throw new Error(`GEOMETRY_NODE_CYCLE_OR_MULTI_PARENT: ${index}`)
    const node = nodes[index]
    if (!node) throw new Error(`GEOMETRY_NODE_MISSING: ${index}`)
    if (node.skin !== undefined) throw new Error(`GEOMETRY_SKINNED_MESH_UNSUPPORTED: node ${index} 用蒙皮驱动顶点，静态几何不等于实际画面`)
    const matrix = parent.clone().multiply(nodeMatrix(node, `node ${index}`))
    placed.set(index, matrix); displayed.add(index)
    for (const child of node.children ?? []) place(Number(child), matrix)
  }
  for (const root of roots) place(root, new Matrix4())
  // 会驱动显示节点（或其祖先）的动画：Viewer 为命中的 clip 建 AnimationMixer 并 play
  // （`viewer/src/index.ts`），静态几何与实际画面不再是一回事。
  for (const animation of json.animations ?? []) for (const channel of animation?.channels ?? []) {
    if (displayed.has(channel?.target?.node)) throw new Error(`GEOMETRY_ANIMATION_UNSUPPORTED: node ${channel.target.node} 被动画驱动，静态几何不等于实际画面`)
  }
  const source = options.source ?? DEFAULT_SOURCE
  const adapter = sourceMatrix(source)
  const facts = new Map<number, GeometryNodeFacts>()
  let vertexCount = 0, triangleCount = 0
  const boundsMin = new Vector3(Infinity, Infinity, Infinity), boundsMax = new Vector3(-Infinity, -Infinity, -Infinity)
  for (const [index, node] of nodes.entries()) {
    if (!displayed.has(index) || node?.mesh === undefined || node.mesh === null) continue
    const primitives = meshes[Number(node.mesh)]?.primitives
    if (!Array.isArray(primitives) || !primitives.length) throw new Error(`GEOMETRY_MESH_MISSING: node ${index}`)
    // 实体本地坐标 = 源坐标适配 ∘ 节点世界变换；实体自己的位姿（用户可编辑）不进来。
    const placement = adapter.matrix.clone().multiply(placed.get(index)!)
    const vertices = new Set<string>(), triangles: string[] = []
    const nodeMin = new Vector3(Infinity, Infinity, Infinity), nodeMax = new Vector3(-Infinity, -Infinity, -Infinity)
    for (const [primitiveIndex, primitive] of primitives.entries()) {
      const label = `node ${index} primitive ${primitiveIndex}`
      if (!binary) throw new Error(`GEOMETRY_BINARY_CHUNK_MISSING: ${label}`)
      if (primitive?.extensions && Object.keys(primitive.extensions).length) throw new Error(`GEOMETRY_PRIMITIVE_EXTENSION_UNSUPPORTED: ${label} ${Object.keys(primitive.extensions).join(", ")}`)
      if (primitive?.targets?.length) throw new Error(`GEOMETRY_MORPH_TARGETS_UNSUPPORTED: ${label}`)
      if ((primitive?.mode ?? 4) !== 4) throw new Error(`GEOMETRY_PRIMITIVE_MODE_UNSUPPORTED: ${label} mode=${String(primitive?.mode)}`)
      const accessorIndex = primitive?.attributes?.POSITION
      if (accessorIndex === undefined) throw new Error(`GEOMETRY_POSITION_MISSING: ${label}`)
      const accessor = json.accessors?.[accessorIndex]
      // 整数/归一化坐标要先按扩展语义还原才是真值；读不了就别拿原分量当几何。
      if (accessor?.componentType !== 5126 || accessor?.type !== "VEC3" || accessor?.normalized === true) throw new Error(`GEOMETRY_POSITION_UNSUPPORTED: ${label} componentType=${String(accessor?.componentType)} type=${String(accessor?.type)} normalized=${String(accessor?.normalized)}`)
      const flat = readAccessor(json, binary, accessorIndex)
      const points: string[] = []
      for (let point = 0; point + 2 < flat.length; point += 3) {
        const world = new Vector3(flat[point]!, flat[point + 1]!, flat[point + 2]!).applyMatrix4(placement)
        if (!Number.isFinite(world.x) || !Number.isFinite(world.y) || !Number.isFinite(world.z)) throw new Error(`GEOMETRY_NOT_FINITE: ${label}`)
        nodeMin.min(world); nodeMax.max(world); boundsMin.min(world); boundsMax.max(world)
        const key = `${quantized(world.x)},${quantized(world.y)},${quantized(world.z)}`
        points.push(key); vertices.add(key)
      }
      const indices = primitive.indices === undefined ? points.map((_, point) => point) : readAccessor(json, binary, primitive.indices)
      if (indices.length % 3 !== 0) throw new Error(`GEOMETRY_INDICES_UNSUPPORTED: ${label} count=${indices.length}`)
      for (let face = 0; face + 2 < indices.length; face += 3) {
        const corners = [indices[face]!, indices[face + 1]!, indices[face + 2]!]
        if (corners.some(corner => !Number.isInteger(corner) || corner < 0 || corner >= points.length)) throw new Error(`GEOMETRY_INDEX_OUT_OF_RANGE: ${label}`)
        triangles.push(triangleKey(points[corners[0]!]!, points[corners[1]!]!, points[corners[2]!]!))
      }
    }
    if (!triangles.length) throw new Error(`GEOMETRY_MESH_EMPTY: node ${index} 没有任何三角面（显示不出几何，不能当"几何一致"）`)
    const fact: GeometryNodeFacts = {
      vertexCount: vertices.size,
      triangleCount: triangles.length,
      digest: digestOf(JSON.stringify({ vertices: [...vertices].sort(), triangles: triangles.sort() })),
      bounds: snapBounds(nodeMin, nodeMax),
    }
    facts.set(index, fact); vertexCount += fact.vertexCount; triangleCount += fact.triangleCount
  }
  if (!facts.size) throw new Error("GEOMETRY_NO_MESH_NODE: 原件里没有可核对的网格节点")
  return {
    nodes: facts,
    digest: digestOf([...facts.entries()].map(([index, fact]) => `${index}:${fact.digest}`).join("\n")),
    vertexCount,
    triangleCount,
    unitScale: adapter.unitScale,
    frame: FRAME,
    bounds: snapBounds(boundsMin, boundsMax),
  }
}

/**
 * 两个原件的几何事实是否同一份几何：米制换算、网格节点集合与逐节点摘要都要逐条对上。
 * 摘要里已经包含节点层级的世界变换，所以"只改了内部位姿/缩放"的目标版本在这里必然不同。
 */
export function compareGlbGeometry(from: GlbGeometryFacts, to: GlbGeometryFacts): GeometryComparison {
  if (from.unitScale !== to.unitScale) return { identical: false, reason: `源坐标单位换算不同（旧 ${from.unitScale} 米/单位，新 ${to.unitScale} 米/单位），同一份顶点在场景里的实际尺寸不同` }
  for (const [index, fact] of from.nodes) {
    const other = to.nodes.get(index)
    if (!other) return { identical: false, reason: `节点 ${index} 在目标版本里没有网格（旧 ${fact.vertexCount} 顶点 / ${fact.triangleCount} 三角面，位于 ${span(fact.bounds)}）` }
    if (fact.digest !== other.digest) return { identical: false, reason: `节点 ${index} 的实际几何不同（旧 ${fact.vertexCount} 顶点 / ${fact.triangleCount} 三角面，位于 ${span(fact.bounds)}；新 ${other.vertexCount} 顶点 / ${other.triangleCount} 三角面，位于 ${span(other.bounds)}），世界变换已计入` }
  }
  for (const index of to.nodes.keys()) if (!from.nodes.has(index)) return { identical: false, reason: `目标版本多出网格节点 ${index}（位于 ${span(to.nodes.get(index)!.bounds)}）` }
  return { identical: true }
}
