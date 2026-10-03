/**
 * 测试用的**真几何** GLB 夹具（ENV-29 的几何事实核对要能逐节点读出顶点与面片）。
 *
 * 与各测试里那份"只有 JSON chunk、`primitives: []`"的最小 GLB 不同：这里写真的 POSITION 访问器、
 * 真索引与 BIN 块，形状也刻意造成两种现实中会遇到的差别：
 * - `split(solid, n)`：同一份几何按材质拆成多个 primitive（真实导出器改材质后就是这样，
 *   顶点缓冲按 primitive 各自重排），用于证明"字节不同、几何相同"能被判为一致；
 * - `pocketBox`：与 `box` 包围盒逐轴相同、内部几何不同的凹件，用于证明判据不是 bbox。
 *
 * 只服务测试：不是导出器，法线/材质/动画一概不写。
 */

export type Triangle = [number, number, number]
export interface Solid {
  positions: Array<[number, number, number]>
  triangles: Triangle[]
}

/** 轴对齐立方体（8 顶点、12 三角面），一个角在原点、边长 size。 */
export function box(size = 1): Solid {
  const positions: Array<[number, number, number]> = [
    [0, 0, 0], [size, 0, 0], [size, size, 0], [0, size, 0],
    [0, 0, size], [size, 0, size], [size, size, size], [0, size, size],
  ]
  const quad = (a: number, b: number, c: number, d: number): Triangle[] => [[a, b, c], [a, c, d]]
  return { positions, triangles: [...quad(0, 3, 2, 1), ...quad(4, 5, 6, 7), ...quad(0, 1, 5, 4), ...quad(1, 2, 6, 5), ...quad(2, 3, 7, 6), ...quad(3, 0, 4, 7)] }
}

/** 与 `box(size)` 包围盒逐轴相同的凹件：顶面（y=size，顶点 4-7）内凹成一个四棱锥坑。 */
export function pocketBox(size = 1): Solid {
  const shell = box(size)
  // box() 的面序：0-1 底面、2-3 顶面、4-11 四个侧面。顶面换成四个斜面，坑底是 (size/2, size/2, size/2)。
  const apex = shell.positions.length
  shell.positions.push([size / 2, size / 2, size / 2])
  const slopes = [0, 1, 2, 3].map((corner): Triangle => [4 + corner, 4 + ((corner + 1) % 4), apex])
  return { positions: shell.positions, triangles: [...shell.triangles.slice(0, 2), ...shell.triangles.slice(4), ...slopes] }
}

/** 把一份实体的面片按顺序分成 groups 份（模拟按材质拆 primitive）：顶点缓冲各自重排，几何不变。 */
export function split(solid: Solid, groups: number): Solid[] {
  const per = Math.ceil(solid.triangles.length / groups)
  const parts: Solid[] = []
  for (let start = 0; start < solid.triangles.length; start += per) {
    parts.push({ positions: solid.positions, triangles: solid.triangles.slice(start, start + per) })
  }
  return parts
}

/** 顶点位置的自身包围盒（源坐标系、米）；用于在测试里对"同 bbox"这件事下断言。 */
export function boundsOf(solid: Solid): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const point of solid.positions) for (const axis of [0, 1, 2] as const) {
    min[axis] = Math.min(min[axis], point[axis])
    max[axis] = Math.max(max[axis], point[axis])
  }
  return { min, max }
}

interface Primitive { positions: number[]; indices: number[] }

/** 夹具节点：`mesh` 之外的字段都是真的 glTF 节点字段（内部位姿/层级），`sparse` 只影响 POSITION 访问器。 */
export interface GlbNode {
  name?: string
  /** 省略 = 只承载内部变换/层级的节点（真实导出器里的空组节点）。 */
  mesh?: Solid | Solid[]
  translation?: [number, number, number]
  rotation?: [number, number, number, number]
  scale?: [number, number, number]
  matrix?: number[]
  children?: number[]
  extras?: Record<string, unknown>
  /**
   * 用 `accessor.sparse` 把第 `vertex` 个顶点位移 `offset`：base 顶点数组**不变**，
   * 只有按规范应用 sparse 之后才是真值；`base: false` 时连 bufferView 都不写（sparse-only accessor）。
   */
  sparse?: { vertex: number; offset: [number, number, number]; base?: boolean }
}

/** 写一份带 BIN 块的 glTF 2.0 二进制：每个 primitive 一份 POSITION（含 min/max，合法 glTF）+ 索引访问器。 */
export function solidGlb(options: { generator: string; nodes: GlbNode[]; roots?: number[] }): Buffer {
  const binary: Buffer[] = []
  let binaryLength = 0
  const bufferViews: Array<Record<string, unknown>> = []
  const accessors: Array<Record<string, unknown>> = []
  const materials: Array<Record<string, unknown>> = []
  const append = (payload: Buffer): number => {
    const padding = (4 - binaryLength % 4) % 4
    if (padding) { binary.push(Buffer.alloc(padding)); binaryLength += padding }
    const index = bufferViews.length
    binary.push(payload); bufferViews.push({ buffer: 0, byteOffset: binaryLength, byteLength: payload.length })
    binaryLength += payload.length
    return index
  }
  // mesh 数组只收真正带网格的节点（空组节点不占 mesh 索引），节点用 meshIndex 指回来。
  const meshIndexByNode = new Map<number, number>()
  const meshes: Array<{ primitives: Array<Record<string, unknown>> }> = []
  options.nodes.forEach((node, nodeIndex) => {
    if (node.mesh === undefined) return
    meshIndexByNode.set(nodeIndex, meshes.length)
    meshes.push({
      primitives: (Array.isArray(node.mesh) ? node.mesh : [node.mesh]).map((solid, primitiveIndex) => {
      // 每个 primitive 只带自己用到的顶点（按材质拆分后顶点缓冲就是这么重排的），面片绕向不变。
      const used = new Map<number, number>()
      const parts: Primitive = { positions: [], indices: [] }
      for (const triangle of solid.triangles) for (const corner of triangle) {
        if (!used.has(corner)) { used.set(corner, parts.positions.length / 3); parts.positions.push(...solid.positions[corner]!) }
      }
      for (const triangle of solid.triangles) for (const corner of triangle) parts.indices.push(used.get(corner)!)
      const sparse = (Array.isArray(node.mesh) ? node.mesh.length : 1) > 1 && primitiveIndex > 0 ? undefined : node.sparse
      const positionBytes = Buffer.alloc(parts.positions.length * 4)
      parts.positions.forEach((value, index) => positionBytes.writeFloatLE(value, index * 4))
      const indexBytes = Buffer.alloc(parts.indices.length * 2)
      parts.indices.forEach((value, index) => indexBytes.writeUInt16LE(value, index * 2))
      // min/max 按**应用 sparse 之后**的真值写（spec 要求），这样 GLTFLoader 也不会报缺 min/max。
      const final = sparse ? parts.positions.map((value, index) => (Math.floor(index / 3) === sparse.vertex ? value + sparse.offset[index % 3]! : value)) : parts.positions
      const extent = (pick: (values: number[]) => number) => [0, 1, 2].map(component => pick(final.filter((_, index) => index % 3 === component)))
      const positionAccessor = accessors.push({
        ...(sparse?.base === false ? {} : { bufferView: append(positionBytes) }),
        componentType: 5126, count: parts.positions.length / 3, type: "VEC3",
        min: extent(values => Math.min(...values)), max: extent(values => Math.max(...values)),
        ...(sparse ? {
          sparse: {
            count: 1,
            indices: { bufferView: append(Buffer.from([sparse.vertex & 0xff, (sparse.vertex >> 8) & 0xff])), componentType: 5123 },
            // sparse.values 是**替换值**（规范：覆盖而不是累加），所以写 base + offset；
            // base 缺失（sparse-only）时 base 视为零，这里取 0 也对。
            values: { bufferView: append(Buffer.from(Float32Array.from([0, 1, 2].map(component => ((sparse.base === false ? 0 : parts.positions[sparse.vertex * 3 + component]!) + sparse.offset[component]!))).buffer)), componentType: 5126 },
          },
        } : {}),
      }) - 1
      const indexAccessor = accessors.push({ bufferView: append(indexBytes), componentType: 5123, count: parts.indices.length, type: "SCALAR" }) - 1
      const material = materials.push({ name: `${options.generator}-材质${primitiveIndex}`, pbrMetallicRoughness: { baseColorFactor: [primitiveIndex ? 0.8 : 0.2, 0.4, 0.1, 1] } }) - 1
      return { attributes: { POSITION: positionAccessor }, indices: indexAccessor, material }
      }),
    })
  })
  // 场景根：默认是所有"没有父节点的节点"（写死 [0] 会让第二个网格节点不参与显示，几何事实也就不该把它算进来）。
  const roots = options.roots ?? options.nodes.map((_, index) => index).filter(index => !options.nodes.some(node => node.children?.includes(index)))
  const json = {
    asset: { version: "2.0", generator: options.generator },
    scene: 0,
    scenes: [{ nodes: roots.length ? roots : [0] }],
    nodes: options.nodes.map((node, index) => ({
      ...(node.name ? { name: node.name } : {}),
      ...(node.translation ? { translation: node.translation } : {}),
      ...(node.rotation ? { rotation: node.rotation } : {}),
      ...(node.scale ? { scale: node.scale } : {}),
      ...(node.matrix ? { matrix: node.matrix } : {}),
      ...(node.children ? { children: node.children } : {}),
      ...(node.extras ? { extras: node.extras } : {}),
      ...(meshIndexByNode.has(index) ? { mesh: meshIndexByNode.get(index) } : {}),
    })),
    meshes, materials, accessors, bufferViews,
    buffers: [{ byteLength: binaryLength }],
  }
  const binaryChunk = Buffer.concat(binary)
  const payload = Buffer.from(JSON.stringify(json), "utf8")
  const jsonChunk = Buffer.concat([payload, Buffer.alloc((4 - payload.length % 4) % 4, 0x20)])
  const paddedBinary = Buffer.concat([binaryChunk, Buffer.alloc((4 - binaryChunk.length % 4) % 4)])
  const total = 12 + 8 + jsonChunk.length + (paddedBinary.length ? 8 + paddedBinary.length : 0)
  const header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8)
  jsonHeader.writeUInt32LE(jsonChunk.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  const parts = [header, jsonHeader, jsonChunk]
  if (paddedBinary.length) {
    const binaryHeader = Buffer.alloc(8)
    binaryHeader.writeUInt32LE(paddedBinary.length, 0); binaryHeader.writeUInt32LE(0x004e4942, 4)
    parts.push(binaryHeader, paddedBinary)
  }
  return Buffer.concat(parts)
}

/**
 * 改 JSON chunk 之后重新打包（BIN 原样保留）：用来造"读不出/不该读"的变体（外部 buffer、压缩扩展、
 * morph targets、动画、蒙皮、整数坐标…），也用来只改节点内部位姿。与根反例
 * `root-103-internal-transform-valid-probe.ts` 同一手法，语义等价、写法共享。
 */
export function patchGlb(buffer: Buffer, edit: (json: any) => void): Buffer {
  const jsonLength = buffer.readUInt32LE(12)
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString("utf8"))
  edit(json)
  const payload = Buffer.from(JSON.stringify(json), "utf8")
  const chunk = Buffer.concat([payload, Buffer.alloc((4 - payload.length % 4) % 4, 0x20)])
  const rest = buffer.subarray(20 + jsonLength)
  const header = Buffer.from(buffer.subarray(0, 20))
  header.writeUInt32LE(20 + chunk.length + rest.length, 8)
  header.writeUInt32LE(chunk.length, 12)
  return Buffer.concat([header, chunk, rest])
}
