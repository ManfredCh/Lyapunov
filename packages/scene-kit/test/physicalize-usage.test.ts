/**
 * ENV-79 碰撞派生用途（dynamic/static/environment）的真实行为测试：真的走 asset-bake 的
 * trimesh 子进程、真的 ResourceLibrary 回执、真几何断言（对产出的 OBJ/盒组做实体内部判定），
 * 不 mock 派生结果。夹具是测试自己写的**真实三角网格** GLB（门楼 = 两根门垛 + 门楣 + 地面垫层；
 * 密封房间 = 六块板），用于证明用途语义：环境按独立表面逐节点导出、不填内部、装配为静态体、
 * 凸包/CoACD 被明确拒绝；不代表真实院落/建筑的尺寸或外观。
 *
 * 需要 LYAPUNOV_ALGORITHM_PYTHON 指向带 trimesh 的解释器（与产品同一条 provider 路径）；
 * 没有它就整组跳过——跳过不等于通过，报告里按实际执行情况写。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile,stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import type { ResourceRef } from "../../lyapunov-contracts/src/types.ts"
import { localPath } from "../src/formats.ts"
import { SceneOperations } from "../src/operations.ts"
import { assetAcquisitionParameters } from "../src/asset-acquisition.ts"
import type { ResourceRecord } from "../src/resources.ts"
import { physicalizationVariant, resolvePhysicalization, PHYSICALIZATION_POLICY,schedulePhysicalization,resourcePhysicalizationOptions } from "../src/physicalization.ts"
import { sceneEnvironmentImportParameters, sceneImportParameters } from "../src/tool-schema.ts"

const provider = process.env.LYAPUNOV_ALGORITHM_PYTHON
const withProvider = provider ? describe : describe.skip

type V3 = [number, number, number]
interface Box { min: V3; max: V3 }

/** 源文件声明 Z-up、米制：派生侧不做轴向旋转，产出坐标与夹具坐标逐字一致，断言才谈得上几何。 */
const Z_UP: ResourceRef["source"] = { units: "m", upAxis: "Z", handedness: "right", metersPerUnit: 1 }

/** 一块 AABB 的 12 个三角面，绕序按外向法向（有向体积/内部判定都依赖一致的绕序）。 */
function boxTriangles({ min, max }: Box): V3[] {
  const [x0, y0, z0] = min, [x1, y1, z1] = max
  const v: V3[] = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
  const out: V3[] = []
  for (const [a, b, c, d] of quads) out.push(v[a!]!, v[b!]!, v[c!]!, v[a!]!, v[c!]!, v[d!]!)
  return out
}

/** 真实几何 GLB：每个节点一个 mesh（无索引三角面），POSITION accessor 带 min/max。
 *  几何可以给盒（boxTriangles）也可以直接给三角面（连通凹实体这类夹具要从解析轮廓挤出）。 */
function meshGLB(nodes: Array<{ name: string; boxes?: Box[]; triangles?: V3[] }>, generator: string): Buffer {
  const blobs: Buffer[] = [], bufferViews: Array<Record<string, unknown>> = [], accessors: Array<Record<string, unknown>> = []
  let offset = 0
  const meshes = nodes.map((node, index) => {
    const triangles = node.triangles ?? node.boxes!.flatMap(boxTriangles)
    const blob = Buffer.alloc(triangles.length * 12)
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity]
    triangles.forEach((point, vertex) => {
      for (let axis = 0; axis < 3; axis++) {
        blob.writeFloatLE(point[axis]!, vertex * 12 + axis * 4)
        min[axis] = Math.min(min[axis]!, point[axis]!)
        max[axis] = Math.max(max[axis]!, point[axis]!)
      }
    })
    const padding = (4 - (offset % 4)) % 4
    if (padding) { blobs.push(Buffer.alloc(padding)); offset += padding }
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: blob.length })
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: triangles.length, type: "VEC3", min, max })
    blobs.push(blob)
    offset += blob.length
    return { name: `mesh_${index}`, primitives: [{ attributes: { POSITION: accessors.length - 1 }, mode: 4 }] }
  })
  const binary = Buffer.concat(blobs)
  const json = {
    asset: { version: "2.0", generator },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, index) => index) }],
    nodes: nodes.map((node, index) => ({ name: node.name, mesh: index })),
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binary.length }],
  }
  const payload = Buffer.from(JSON.stringify(json), "utf8")
  const jsonChunk = Buffer.concat([payload, Buffer.alloc((4 - payload.length % 4) % 4, 0x20)])
  const binChunk = Buffer.concat([binary, Buffer.alloc((4 - binary.length % 4) % 4, 0)])
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length
  const header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8)
  jsonHeader.writeUInt32LE(jsonChunk.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  binHeader.writeUInt32LE(binChunk.length, 0); binHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk])
}

/**
 * 门楼：两根门垛 + 门楣，中间留 2 m×2.4 m 的门洞；地面垫层在下面。
 * tag 进 generator：GLB 字节因此不同，避免 ResourceLibrary 的内容去重把两个测试资源合成同一条记录。
 */
const DOORWAY: Box[] = [
  { min: [-3, -0.2, 0], max: [-1, 0.2, 3] },
  { min: [1, -0.2, 0], max: [3, 0.2, 3] },
  { min: [-1, -0.2, 2.4], max: [1, 0.2, 3] },
]
const portalGLB = (tag: string) => meshGLB([
  { name: "门垛西", boxes: [DOORWAY[0]!] },
  { name: "门垛东", boxes: [DOORWAY[1]!] },
  { name: "门楣", boxes: [DOORWAY[2]!] },
  { name: "地面垫层", boxes: [{ min: [-3, -2, -0.2], max: [3, 2, 0] }] },
], `physicalize-usage-portal-${tag}`)

/**
 * 单节点**连通凹实体**：U 形截面（门洞 x∈[-1,1]、z∈[0,2.4] 直通地面；墙 x∈[-3,3]、高 3、厚 0.4）
 * 挤出成的一根三棱柱——一个水密、绕序一致、只有一个 mesh 节点的凹实体。79 的两份庭院素材分别
 * 是"多节点"与"合并单节点但内部是多块、非连通"，都盖不到这一档；而"凸包把门洞封死"这条限制只在
 * 连通凹实体上才成立（凸包 = 一整面墙）。轮廓三角化自己算（耳切），不引几何库。
 */
const U_OUTLINE: Array<[number, number]> = [[-3, 0], [-1, 0], [-1, 2.4], [1, 2.4], [1, 0], [3, 0], [3, 3], [-3, 3]]
const U_THICKNESS = 0.4
/** 局部点与三角形：叉积同号即在三角形内（耳切的可见性判据，够用且不依赖浮点容差的极端情形）。 */
function cross2(o: [number, number], a: [number, number], b: [number, number]): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}
function insideTriangle2(p: [number, number], a: [number, number], b: [number, number], c: [number, number]): boolean {
  const d1 = cross2(a, b, p), d2 = cross2(b, c, p), d3 = cross2(c, a, p)
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
}
function earClip(outline: Array<[number, number]>): Array<[number, number, number]> {
  const indices = outline.map((_, index) => index)
  const area = outline.reduce((sum, [x, y], index) => {
    const [nx, ny] = outline[(index + 1) % outline.length]!
    return sum + (x * ny - nx * y)
  }, 0)
  if (area < 0) indices.reverse()
  const triangles: Array<[number, number, number]> = []
  while (indices.length > 3) {
    const ear = indices.findIndex((_, position) => {
      const previous = indices[(position + indices.length - 1) % indices.length]!, current = indices[position]!, following = indices[(position + 1) % indices.length]!
      const a = outline[previous]!, b = outline[current]!, c = outline[following]!
      if (cross2(a, b, c) <= 0) return false
      return !indices.some(other => other !== previous && other !== current && other !== following && insideTriangle2(outline[other]!, a, b, c))
    })
    if (ear < 0) throw new Error("EAR_CLIPPING_STUCK: 轮廓不是简单多边形")
    triangles.push([indices[(ear + indices.length - 1) % indices.length]!, indices[ear]!, indices[(ear + 1) % indices.length]!])
    indices.splice(ear, 1)
  }
  triangles.push([indices[0]!, indices[1]!, indices[2]!])
  return triangles
}
/** 挤出：盖面按耳切三角化（底面朝 -z、顶面朝 +z），侧壁逐段成对且外向；caps=false 时去掉盖面（开放壳）。 */
function extrudePrism(outline: Array<[number, number]>, thickness: number, caps = true): V3[] {
  const triangles: V3[] = []
  if (caps) for (const [a, b, c] of earClip(outline)) {
    triangles.push([outline[a]![0], outline[a]![1], 0], [outline[c]![0], outline[c]![1], 0], [outline[b]![0], outline[b]![1], 0])
    triangles.push([outline[a]![0], outline[a]![1], thickness], [outline[b]![0], outline[b]![1], thickness], [outline[c]![0], outline[c]![1], thickness])
  }
  for (let index = 0; index < outline.length; index++) {
    const [px, py] = outline[index]!, [qx, qy] = outline[(index + 1) % outline.length]!
    triangles.push([px, py, 0], [qx, qy, 0], [qx, qy, thickness])
    triangles.push([px, py, 0], [qx, qy, thickness], [px, py, thickness])
  }
  return triangles
}
const portalSolidGLB = (tag: string) => meshGLB([{ name: "门洞墙", triangles: extrudePrism(U_OUTLINE, U_THICKNESS) }], `physicalize-usage-portal-solid-${tag}`)
const portalShellGLB = (tag: string) => meshGLB([{ name: "门洞墙壳", triangles: extrudePrism(U_OUTLINE, U_THICKNESS, false) }], `physicalize-usage-portal-shell-${tag}`)

/** 密封房间：六块板围出的封闭空腔（4 m×4 m×3 m，板厚 0.2 m），没有任何开口。 */
const ROOM_CENTER: V3 = [2, 2, 1.5]
const roomGLB = (tag: string) => meshGLB([{
  name: "密封房间",
  boxes: [
    { min: [0, 0, -0.2], max: [4, 4, 0] },
    { min: [0, 0, 3], max: [4, 4, 3.2] },
    { min: [0, 0, 0], max: [0.2, 4, 3] },
    { min: [3.8, 0, 0], max: [4, 4, 3] },
    { min: [0, 0, 0], max: [4, 0.2, 3] },
    { min: [0, 3.8, 0], max: [4, 4, 3] },
  ],
}], `physicalize-usage-room-${tag}`)

let base: string, dataRoot: string, fixtures: string, operations: SceneOperations

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "lyapunov-physicalize-usage-"))
  dataRoot = join(base, "data")
  fixtures = join(base, "fixtures")
  await mkdir(fixtures, { recursive: true })
  operations = new SceneOperations(dataRoot)
})

afterEach(async () => { await rm(base, { recursive: true, force: true }) })

async function fixture(name: string, content: Buffer): Promise<string> {
  const path = join(fixtures, name)
  await writeFile(path, content)
  return path
}

/**
 * 派生是 fire-and-forget 队列：轮询资源记录直到**第 attempts 次**尝试落定。
 * 只等"状态不是 pending"会在换用途重派生时读到上一次的终态（回执还是旧的），
 * 因此这里按入队序号等——每次 schedule 都会把 attempts +1，序号是本次派生的身份。
 */
async function derived(resourceId: string, version: number, attempts: number, timeoutMs = 180_000): Promise<ResourceRecord> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const record = await operations.resources.get(resourceId, version)
    const receipt = record.physicalization
    if (receipt && (receipt.attempts ?? 0) >= attempts && receipt.status !== "pending") return record
    if (Date.now() > deadline) throw new Error(`physicalization 超时：第 ${attempts} 次尝试仍停在 ${receipt?.status ?? "无回执"}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

function collisionParts(record: ResourceRecord, extension: string): string[] {
  return record.ref.representations
    .filter(rep => rep.role === "collision" && localPath(rep.uri).endsWith(extension))
    .map(rep => localPath(rep.uri))
}

/** 读取碰撞产出的三角面（OBJ）拼成一份顶点/面列表：用于对派生几何做实体内部判定。 */
async function collisionTriangles(record: ResourceRecord): Promise<number[]> {
  const parts = collisionParts(record, ".obj")
  expect(parts.length).toBeGreaterThan(0)
  const triangles: number[] = []
  for (const path of parts) {
    const vertices: number[] = []
    for (const line of (await readFile(path, "utf8")).split("\n")) {
      if (line.startsWith("v ")) vertices.push(...line.slice(2).trim().split(/\s+/).map(Number))
      else if (line.startsWith("f ")) {
        const face = line.slice(2).trim().split(/\s+/).map(item => Number(item.split("/")[0]) - 1)
        for (let i = 1; i + 1 < face.length; i++) triangles.push(...vertices.slice(face[0]! * 3, face[0]! * 3 + 3), ...vertices.slice(face[i]! * 3, face[i]! * 3 + 3), ...vertices.slice(face[i + 1]! * 3, face[i + 1]! * 3 + 3))
      }
    }
  }
  return triangles
}

/**
 * 射线奇偶判定：与全部三角面求交（Möller–Trumbore），交点数为奇数即在实体内。
 * 射线方向**不能**取轴向：门楣与门垛共面（x=±1）时，同一 t 上会有两个反向面，按深度去重会
 * 把"从一个实体直接进入另一个实体"误算成一次穿越。改用一条不与夹具任何棱边平行的斜射线，
 * 每个面各算一次，奇偶才成立。
 */
const RAY: V3 = [1, 0.0173, 0.0271]
function insideSolid(triangles: number[], point: V3): boolean {
  let crossings = 0
  for (let i = 0; i + 8 < triangles.length; i += 9) {
    const ax = triangles[i]!, ay = triangles[i + 1]!, az = triangles[i + 2]!
    const bx = triangles[i + 3]!, by = triangles[i + 4]!, bz = triangles[i + 5]!
    const cx = triangles[i + 6]!, cy = triangles[i + 7]!, cz = triangles[i + 8]!
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az
    const px = RAY[1] * e2z - RAY[2] * e2y, py = RAY[2] * e2x - RAY[0] * e2z, pz = RAY[0] * e2y - RAY[1] * e2x
    const determinant = e1x * px + e1y * py + e1z * pz
    if (Math.abs(determinant) < 1e-12) continue
    const tx = point[0] - ax, ty = point[1] - ay, tz = point[2] - az
    const u = (tx * px + ty * py + tz * pz) / determinant
    if (u < -1e-9 || u > 1 + 1e-9) continue
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
    const v = (RAY[0] * qx + RAY[1] * qy + RAY[2] * qz) / determinant
    if (v < -1e-9 || u + v > 1 + 1e-9) continue
    const t = (e2x * qx + e2y * qy + e2z * qz) / determinant
    if (t > 1e-9) crossings += 1
  }
  return crossings % 2 === 1
}

interface DerivedBox { center: V3; halfExtents: V3 }

/** 读取体素盒组产物（voxel-*.json）：盒中心/半长与 receipt 里的 boxes 计数同源。 */
async function collisionBoxes(record: ResourceRecord): Promise<DerivedBox[]> {
  const parts = collisionParts(record, ".json").filter(path => basename(path).startsWith("voxel-"))
  expect(parts.length).toBeGreaterThan(0)
  const boxes: DerivedBox[] = []
  for (const path of parts) boxes.push(...(JSON.parse(await readFile(path, "utf8")) as { boxes: DerivedBox[] }).boxes)
  return boxes
}

/** 目录内容指纹：文件名 → sha256 前缀。用来证明"旧的参数变体产物字节没被动过"（比 mtime 硬）。 */
async function digest(directory: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue
    out[entry.name] = createHash("sha256").update(await readFile(join(directory, entry.name))).digest("hex").slice(0, 16)
  }
  return out
}

/** 点是否落在盒内（inset 是要求盒在点周围保留的余量：inset 越大判定越严）。 */
function insideBox(box: DerivedBox, point: V3, inset = 0): boolean {
  return [0, 1, 2].every(axis => Math.abs(point[axis]! - box.center[axis]!) <= box.halfExtents[axis]! - inset)
}

describe("用途/策略解析与产物变体落位", () => {
  test("缺省与显式 auto 同义（都是“没钉死表示”），显式策略原样透传；变体目录名含策略+体素+口径", () => {
    // 97 起 environment 缺省不再等价于 triangle_mesh：请求侧记 auto，由 asset-bake 逐节点挑保空腔的表示。
    expect(resolvePhysicalization("environment")).toBe("auto")
    expect(resolvePhysicalization("environment", "auto")).toBe("auto")
    expect(resolvePhysicalization("environment", "voxel_boxes")).toBe("voxel_boxes")
    expect(resolvePhysicalization("environment", "triangle_mesh")).toBe("triangle_mesh")
    expect(resolvePhysicalization("dynamic")).toBe("auto")
    expect(resolvePhysicalization("dynamic", "voxel_boxes")).toBe("voxel_boxes")
    expect(resolvePhysicalization("static")).toBe("auto")
    // 变体目录名是产物身份：策略/体素/口径任一变了就是另一个目录（旧引用文件因此不会被改写）。
    expect(physicalizationVariant("auto")).toBe("auto@cavity-safe-5")
    expect(physicalizationVariant("auto")).not.toBe(physicalizationVariant("auto",undefined,"cavity-safe-4"))
    expect(physicalizationVariant("auto", undefined, "other")).toBe("auto@other")
    expect(physicalizationVariant("voxel_boxes", 0.5)).toBe("voxel_boxes-voxel0.5@cavity-safe-5")
    expect(physicalizationVariant("auto")).not.toBe(physicalizationVariant("triangle_mesh"))
  }, 120_000)

  test("scene_import / scene_environment_import / scene_asset_acquire 三处工具面都暴露同一个用途枚举", () => {
    const usages = ["dynamic", "static", "environment"]
    for (const [label, parameters] of [
      ["scene_import", sceneImportParameters],
      ["scene_environment_import", sceneEnvironmentImportParameters],
      ["scene_asset_acquire", assetAcquisitionParameters],
    ] as const) {
      const spec = parameters.input as { additionalProperties?: unknown; properties?: Record<string, { oneOf?: Array<{ const?: string }> }> }
      const property = spec.properties?.physicalizeUsage
      expect(`${label}:${property?.oneOf?.map(item => item.const).join("/")}`).toBe(`${label}:${usages.join("/")}`)
      // 工具面必须拒绝未知字段：多写一个用途拼写错误要被 schema 挡住，而不是静默按 dynamic 跑。
      expect(spec.additionalProperties).toBe(false)
    }
    // 可选体素边长只对 voxel_boxes 有意义，但必须在三处都能传下去（环境保空腔要固定通行精度）。
    for (const parameters of [sceneImportParameters, sceneEnvironmentImportParameters, assetAcquisitionParameters]) {
      const spec = parameters.input as { properties?: Record<string, unknown> }
      expect(Object.keys(spec.properties ?? {})).toContain("physicalizeVoxelSizeM")
    }
  })
})

withProvider("环境碰撞用途（真实 asset-bake 派生）", () => {
  test('密集默认环境原三角声明进入真实资源/Scene绑定与独立variant，体素失败保持可审',async()=>{
    const triangles:V3[]=[]
    for(let y=0;y<46;y++)for(let x=0;x<46;x++){
      const px=2+x*.1,py=2+y*.1;triangles.push([px,py,0],[px+.004,py,0],[px,py+.004,0])
    }
    const path=await fixture('dense-native.glb',meshGLB([{name:'dense-surfaces',triangles},{name:'convex-source',boxes:[{min:[-.2,-.2,0],max:[.2,.2,.2]}]}],'native-static-contract'))
    await operations.create({sceneId:'native-static'})
    const placed=await operations.import({path,sceneId:'native-static',entityId:'dense',resourceId:'res_dense',source:Z_UP,physicalizeUsage:'environment'})
    const record=await derived(placed.resource.ref.resourceId,1,1)
    expect(record.physicalization).toMatchObject({status:'ok',strategy:'auto',usage:'environment',policy:'cavity-safe-5',interiorPreserved:true,passageVerified:false,selection:{triangle_surface:2}})
    expect(record.physicalization!.staticTriangleSurfaces).toHaveLength(2)
    expect(record.physicalization!.staticTriangleSurfaces![0]!.voxelAttempt).toMatchObject({status:'failed',reason:'BOX_BUDGET'})
    expect(record.componentDefaults!.collision).toMatchObject({shape:'mesh',meshTopology:'static-triangles',surfaceRadiusM:1e-9})
    await operations.reconcilePhysics({sceneId:'native-static',waitForPending:true})
    const entity=(await operations.scene.snapshot('native-static')).entities.find(entity=>entity.entityId==='dense')!
    expect(entity.components.physicsBinding).toMatchObject({status:'BOUND',strategy:'auto',usage:'environment'})
    expect(entity.components.collision).toMatchObject({meshTopology:'static-triangles',surfaceRadiusM:1e-9})
    expect(entity.components.rigidBody?.type).toBe('static')
    const before=await collisionTriangles(record)
    expect(before.length/9).toBe(2116+12)
    const attempt=record.physicalization!.attempts
    await schedulePhysicalization(operations.resources,record.ref,{usage:'environment',strategy:'auto'})
    expect((await operations.resources.get('res_dense',1)).physicalization!.attempts).toBe(attempt)
    expect(await collisionTriangles(record)).toEqual(before)
  },120000)
  test("两个排队用途各自返回实际派生快照，不把后续request的用途套给先前实例",async()=>{
    const path=await fixture("queue-portal.glb",portalGLB("queue"))
    const record=await operations.resources.import({path,resourceId:"res_queue",source:Z_UP,physicalizationRequest:{usage:"environment",strategy:"triangle_mesh"}})
    const first=schedulePhysicalization(operations.resources,record.ref,resourcePhysicalizationOptions(record))
    const changed=await operations.resources.import({path,resourceId:"res_queue",source:Z_UP,physicalizationRequest:{usage:"dynamic",strategy:"voxel_boxes",voxelSizeM:.2}})
    const second=schedulePhysicalization(operations.resources,changed.ref,resourcePhysicalizationOptions(changed))
    const [environment,dynamic]=await Promise.all([first,second])
    expect(environment!.physicalization!.usage).toBe("environment")
    expect(environment!.componentDefaults!.rigidBody?.type).toBe("static")
    expect(dynamic!.physicalization!.usage).toBe("dynamic")
    expect(dynamic!.componentDefaults!.rigidBody?.type).toBe("dynamic")
    expect(environment!.componentDefaults!.collision?.source).toBe("asset-bake-surface")
    expect(dynamic!.componentDefaults!.collision?.source).toBe("asset-bake-voxel")
  },120_000)
  test("自动改派保护显式资产碰撞和质量定义",async()=>{
    const path=await fixture("declared-portal.glb",portalGLB("declared"))
    const declared={collision:{shape:"box",halfExtents:[2,3,4],source:"declared"},rigidBody:{type:"dynamic",massKg:7}}
    await operations.import({path,resourceId:"res_declared",source:Z_UP,components:declared,physicalizeUsage:"dynamic"})
    await derived("res_declared",1,1)
    await operations.import({path,resourceId:"res_declared",source:Z_UP,physicalizeUsage:"environment",physicalizeStrategy:"triangle_mesh"})
    const changed=await derived("res_declared",1,2)
    expect(changed.componentDefaults).toEqual(declared)
    expect(changed.explicitComponentDefaultKeys).toEqual(["collision","rigidBody"])
  },120_000)
  test("同版本显式改派只改资源当前默认，既有实例和已发布旧变体字节/mtime保持；重选旧变体只读复用",async()=>{
    const path=await fixture("immutable-portal.glb",portalGLB("immutable"))
    await operations.import({path,resourceId:"res_immutable",source:Z_UP,physicalizeUsage:"environment",physicalizeStrategy:"triangle_mesh"})
    const environment=await derived("res_immutable",1,1)
    await operations.create({sceneId:"immutable"})
    const placed=await operations.mount({sceneId:"immutable",resourceId:"res_immutable",version:1,entityId:"environment"})
    const oldFiles=environment.ref.representations.filter(rep=>rep.role==="collision")
    const before=await Promise.all(oldFiles.map(async rep=>({path:localPath(rep.uri),bytes:await readFile(localPath(rep.uri)),mtime:(await stat(localPath(rep.uri))).mtimeMs})))
    await operations.import({path,resourceId:"res_immutable",source:Z_UP,physicalizeUsage:"dynamic",physicalizeStrategy:"voxel_boxes",physicalizeVoxelSizeM:.2})
    const dynamic=await derived("res_immutable",1,2)
    expect(dynamic.physicalization!.usage).toBe("dynamic")
    expect((await operations.inspect("immutable")).entities).toEqual(placed.snapshot.entities)
    const withDynamic=await operations.mount({sceneId:"immutable",resourceId:"res_immutable",version:1,entityId:"dynamic"})
    expect(withDynamic.snapshot.entities.find(e=>e.entityId==="environment")!.components.rigidBody?.type).toBe("static")
    expect(withDynamic.snapshot.entities.find(e=>e.entityId==="dynamic")!.components.rigidBody?.type).toBe("dynamic")
    await operations.import({path,resourceId:"res_immutable",source:Z_UP,physicalizeUsage:"environment",physicalizeStrategy:"triangle_mesh"})
    const restored=await derived("res_immutable",1,3)
    expect(restored.physicalization!.usage).toBe("environment")
    expect(await operations.inspect("immutable")).toEqual(withDynamic.snapshot)
    for(const file of before){
      expect(await readFile(file.path)).toEqual(file.bytes)
      expect((await stat(file.path)).mtimeMs).toBe(file.mtime)
    }
  },120_000)
  test("旧调用不给用途：仍是 dynamic + auto、产物落 collision/dynamic/<变体>/、装配成动态体并带质量", async () => {
    const path = await fixture("portal.glb", portalGLB("default"))
    const { resource } = await operations.import({ path, resourceId: "res_portal", source: Z_UP })
    // 同步导入路径不等派生：函数返回时还没有回执。
    expect(resource.physicalization).toBeUndefined()
    const record = await derived("res_portal", 1, 1)
    const receipt = record.physicalization!
    expect(receipt.status).toBe("ok")
    expect(receipt.usage).toBe("dynamic")
    expect(receipt.strategy).toBe("auto")
    expect(receipt.derivedStrategy).toBeUndefined()
    expect(receipt.interiorPreserved).toBe(false)
    expect(receipt.attempts).toBe(1)
    const collision = record.componentDefaults!.collision as Record<string, unknown>
    // 四个节点都是盒件：auto 走近原生形状，装配为动态体并按实测体积给质量（旧行为不变）。
    expect(collision.source).toBe("asset-bake-primitive")
    expect(collision.shape).toBe("box")
    // 走近原生形状时 parts/boxes 都是 0，装配里却有 4 个盒：回执必须数得到（primitives），
    // 否则回执与实体组件对不上（真实原生回合实测到过这个矛盾）。
    expect(receipt.parts).toBe(0)
    expect(receipt.boxes).toBe(0)
    expect(receipt.primitives).toBe(4)
    // 回执数到的盒数与装配里实际挂上的盒数一致（这就是"回执不许与组件对不上"这条）。
    expect((collision.shapes as unknown[]).length).toBe(4)
    expect((record.componentDefaults!.rigidBody as { type: string }).type).toBe("dynamic")
    expect((record.componentDefaults!.rigidBody as { massKg: number }).massKg).toBeGreaterThan(0)
    const json = collisionParts(record, ".json")
    expect(json).toHaveLength(1)
    expect(json[0]!.endsWith(join("v1", "collision", "dynamic", physicalizationVariant("auto"), "physicalization.json"))).toBe(true)
  }, 120_000)

  test("显式 environment：缺省不钉死表示（凸包即自身的节点仍逐表面导出）、静态体不带质量，门洞在导出几何里仍是空的", async () => {
    const path = await fixture("portal.glb", portalGLB("environment"))
    await operations.import({ path, resourceId: "res_portal_env", source: Z_UP, physicalizeUsage: "environment" })
    const record = await derived("res_portal_env", 1, 1)
    const receipt = record.physicalization!
    expect(receipt.status).toBe("ok")
    expect(receipt.usage).toBe("environment")
    // 请求侧记 auto（没钉死表示）；这四个节点都是凸盒 → 凸包即自身 → 逐节点选了精确表面。
    expect(receipt.strategy).toBe("auto")
    // 目录/去重/记录同一个值（auto）；asset-bake 自己的缺省口径另记一笔，好对上产物内嵌的 strategy。
    expect(receipt.derivedStrategy).toBe("triangle_mesh")
    expect(receipt.selection).toEqual({ triangle_mesh: 4 })
    expect(receipt.routed ?? []).toEqual([])
    expect(receipt.interiorPreserved).toBe(true)
    expect(receipt.policy).toBe(PHYSICALIZATION_POLICY)
    expect(receipt.nodes).toBe(4)
    expect(receipt.parts).toBe(4)
    expect(receipt.boxes).toBe(0)
    expect(receipt.primitives).toBe(0)
    expect(receipt.sourcePath).toBe(localPath(record.ref.original.uri))
    const components = record.componentDefaults!
    expect(components.rigidBody).toEqual({ type: "static" })
    const collision = components.collision as { shape: string; source: string; parts: string[]; friction: number[] }
    expect(collision.source).toBe("asset-bake-surface")
    expect(collision.shape).toBe("mesh")
    expect(collision.parts).toHaveLength(4)
    // 用途 + 参数变体双重隔离：environment 的产物既不与 dynamic 同名文件互相覆盖，
    // 也不与同用途下别的参数变体（策略/体素边长/口径）互相覆盖。
    expect(collision.parts.every(part => localPath(part).includes(join("collision", "environment", physicalizationVariant("auto"))))).toBe(true)

    const triangles = await collisionTriangles(record)
    // 门洞中心（x=0, y=0, z=1.2）在门洞里：导出几何必须真的没有盖住它。
    expect(insideSolid(triangles, [0, 0, 1.2])).toBe(false)
    // 同一份几何里，门楣与门垛内部仍然被判为实体（说明"空"不是判定本身失灵）。
    expect(insideSolid(triangles, [0, 0, 2.7])).toBe(true)
    expect(insideSolid(triangles, [-2, 0, 1.5])).toBe(true)
  }, 120_000)

  test("environment + 凸包/CoACD 被明确拒绝；改回可用策略后 attempts=2 且 previous 记着那次失败", async () => {
    const path = await fixture("portal.glb", portalGLB("guard"))
    await operations.import({ path, resourceId: "res_guard", source: Z_UP, physicalizeUsage: "environment", physicalizeStrategy: "convex_hull" })
    const failed = await derived("res_guard", 1, 1)
    expect(failed.physicalization!.status).toBe("failed")
    expect(failed.physicalization!.error).toContain("凸包会把房间或通道封死")
    expect(failed.physicalization!.usage).toBe("environment")
    // 失败不留半个碰撞产物：没有 collision 组件、没有 collision 表示。
    expect(failed.componentDefaults?.collision).toBeUndefined()
    expect(failed.ref.representations.some(rep => rep.role === "collision")).toBe(false)
    // 同一版本重试（同一份字节 → 同一条记录）：失败账进 previous，产物按 voxel_boxes 落地。
    await operations.import({ path, resourceId: "res_guard", source: Z_UP, physicalizeUsage: "environment", physicalizeStrategy: "voxel_boxes", physicalizeVoxelSizeM: 0.2 })
    const recovered = await derived("res_guard", 1, 2)
    expect(recovered.ref.version).toBe(1)
    expect(recovered.physicalization!.status).toBe("ok")
    expect(recovered.physicalization!.attempts).toBe(2)
    expect(recovered.physicalization!.previous?.status).toBe("failed")
    expect(recovered.physicalization!.previous?.error).toContain("凸包会把房间或通道封死")
    expect(recovered.physicalization!.voxelSizeM).toBe(0.2)
    expect(recovered.physicalization!.boxes).toBeGreaterThan(0)
    // 表面体素盒组同样不许占用门洞：盒中心不得落在门洞内部（留出体素余量）。
    const boxes = await collisionBoxes(recovered)
    const trespassing = boxes.filter(box => Math.abs(box.center[0]) < 0.6 && Math.abs(box.center[1]) < 1.4 && box.center[2] > 0.4 && box.center[2] < 2.0)
    expect(trespassing).toEqual([])
  }, 120_000)

  test("同一条几何：物体用途（填实）把密封房间填成实心，环境用途（逐表面）保留空腔", async () => {
    const path = await fixture("room-solid.glb", roomGLB("solid"))
    await operations.import({ path, resourceId: "res_room_solid", source: Z_UP, physicalizeStrategy: "voxel_boxes", physicalizeVoxelSizeM: 0.2 })
    const solid = await derived("res_room_solid", 1, 1)
    expect(solid.physicalization!.usage).toBe("dynamic")
    expect(solid.physicalization!.interiorPreserved).toBe(false)
    // dynamic 的 fillInterior 语义：密封内腔被填实——房间中心落在某个体素盒里。
    expect((await collisionBoxes(solid)).some(box => insideBox(box, ROOM_CENTER))).toBe(true)

    await operations.import({ path: await fixture("room-hollow.glb", roomGLB("hollow")), resourceId: "res_room_hollow", source: Z_UP, physicalizeUsage: "environment", physicalizeStrategy: "voxel_boxes", physicalizeVoxelSizeM: 0.2 })
    const hollow = await derived("res_room_hollow", 1, 1)
    expect(hollow.physicalization!.interiorPreserved).toBe(true)
    expect(hollow.physicalization!.boxes).toBeGreaterThan(0)
    // 表面模式：盒只贴着墙面，房间内部（收缩 0.5 m 后）没有任何盒占据。
    expect((await collisionBoxes(hollow)).filter(box => insideBox(box, ROOM_CENTER, 0.5))).toEqual([])
    // 装配差异同样落在回执里：环境是静态体、没有质量字段。
    expect(hollow.componentDefaults!.rigidBody).toEqual({ type: "static" })
    expect((solid.componentDefaults!.rigidBody as { type: string }).type).toBe("dynamic")
  }, 120_000)

  test("换用途重派生：supersedes 让默认组件整体替换（不会把上一次的碰撞留下来说谎）", async () => {
    const path = await fixture("portal.glb", portalGLB("switch"))
    await operations.import({ path, resourceId: "res_switch", source: Z_UP, physicalizeUsage: "environment" })
    const environment = await derived("res_switch", 1, 1)
    expect((environment.componentDefaults!.rigidBody as { type: string }).type).toBe("static")
    // 同一份字节 = 同一条记录（内容去重），这里请求的是另一种用途：必须重派生并替换默认组件。
    await operations.import({ path, resourceId: "res_switch", source: Z_UP, physicalizeStrategy: "voxel_boxes", physicalizeVoxelSizeM: 0.2 })
    const dynamic = await derived("res_switch", 1, 2)
    expect(dynamic.ref.version).toBe(1)
    expect(dynamic.physicalization!.usage).toBe("dynamic")
    expect(dynamic.physicalization!.supersedes).toBe(true)
    expect(dynamic.physicalization!.previous?.usage).toBe("environment")
    expect(dynamic.physicalization!.attempts).toBe(2)
    const collision = dynamic.componentDefaults!.collision as { source: string; shapes: unknown[] }
    expect(collision.source).toBe("asset-bake-voxel")
    expect((dynamic.componentDefaults!.rigidBody as { type: string }).type).toBe("dynamic")
    // 上一次 environment 的静态装配必须已被替换：旧的 collision 表示仍在（历史产物），但不再是默认组件。
    await operations.import({ path, resourceId: "res_switch", source: Z_UP, physicalizeUsage: "environment" })
    const back = await derived("res_switch", 1, 3)
    expect(back.physicalization!.usage).toBe("environment")
    expect(back.componentDefaults!.rigidBody).toEqual({ type: "static" })
    expect((back.componentDefaults!.collision as { source: string }).source).toBe("asset-bake-surface")
    expect(back.ref.representations.filter(rep => rep.role === "collision").length).toBeGreaterThan(1)
  }, 120_000)

  test("physicalize:false 只对没有派生状态的版本落 skipped 标记，不覆盖已成功的派生", async () => {
    const path = await fixture("portal.glb", portalGLB("skip-fresh"))
    await operations.import({ path, resourceId: "res_skip_fresh", source: Z_UP, physicalize: false })
    const skipped = await operations.resources.get("res_skip_fresh", 1)
    expect(skipped.physicalization).toEqual({ status: "skipped", attempts: 1, finishedAt: expect.any(String) })

    await operations.import({ path: await fixture("portal-env.glb", portalGLB("skip-done")), resourceId: "res_skip_done", source: Z_UP, physicalizeUsage: "environment" })
    const ok = await derived("res_skip_done", 1, 1)
    expect(ok.physicalization!.status).toBe("ok")
    // 同一份字节再按 physicalize:false 走一次：既有 ok 回执不被降级成 skipped。
    await operations.import({ path: await fixture("portal-env.glb", portalGLB("skip-done")), resourceId: "res_skip_done", source: Z_UP, physicalize: false })
    const again = await operations.resources.get("res_skip_done", 1)
    expect(again.physicalization!.status).toBe("ok")
    expect(again.physicalization!.usage).toBe("environment")
  }, 120_000)

  test("单个连通凹实体的 environment 缺省：全部源面改未填充表面盒，门洞为空且源墙面有碰撞", async () => {
    const path = await fixture("portal-solid.glb", portalSolidGLB("concave"))
    await operations.import({ path, resourceId: "res_portal_solid", source: Z_UP, physicalizeUsage: "environment" })
    const record = await derived("res_portal_solid", 1, 1)
    const receipt = record.physicalization!
    expect(receipt.status).toBe("ok")
    // 一个 mesh 节点、水密、明显凹：不需要猜shell包含关系，全部源面进入未填充表面盒。
    expect(receipt.strategy).toBe("auto")
    // 请求与真实表示分别记账。
    expect(receipt.derivedStrategy).toBe("triangle_mesh")
    expect(receipt.nodes).toBe(1)
    expect(Object.keys(receipt.selection ?? {})).toEqual(["voxel_boxes"])
    expect(receipt.routed?.map(entry => entry.node)).toEqual(["门洞墙"])
    expect(receipt.routed?.[0]!.selected).toBe("voxel_boxes")
    expect(receipt.routed?.[0]!.reason).toContain("CONCAVE")
    expect(receipt.cavityLostNodes ?? []).toEqual([])
    expect(receipt.interiorPreserved).toBe(true)
    // 表面精度是实际pitch；源实体材料内部不等于表面盒，不按材料体积声称精确重建。
    expect(receipt.volumeRatios??[]).toHaveLength(0);expect(receipt.voxelResolutionM).toEqual([.03])
    const boxes=await collisionBoxes(record)
    expect(boxes.some(box=>insideBox(box,[0,.8,.2]))).toBe(false)
    // 原门垛/门楣正面 z=0 是明确源三角表面；两处均有实际派生碰撞。
    expect(boxes.some(box=>insideBox(box,[-2,1.5,0],-1e-8))).toBe(true)
    expect(boxes.some(box=>insideBox(box,[0,2.7,0],-1e-8))).toBe(true)
    expect(record.componentDefaults!.collision!.shape).toBe('box')
  }, 180_000)

  test("同一份连通凹实体显式 triangle_mesh：产物仍是精确表面，但回执如实记下目标引擎会把它凸化封门", async () => {
    const path = await fixture("portal-solid-tri.glb", portalSolidGLB("tri"))
    await operations.import({ path, resourceId: "res_portal_solid_tri", source: Z_UP, physicalizeUsage: "environment", physicalizeStrategy: "triangle_mesh" })
    const record = await derived("res_portal_solid_tri", 1, 1)
    const receipt = record.physicalization!
    expect(receipt.status).toBe("ok")
    expect(receipt.strategy).toBe("triangle_mesh")
    // 请求侧与执行口径一致时不重复记第二笔。
    expect(receipt.derivedStrategy).toBeUndefined()
    // 显式策略被尊重：逐面导出，节点没有被改派。
    expect(receipt.selection).toEqual({ triangle_mesh: 1 })
    expect(receipt.routed ?? []).toEqual([])
    // 但引擎侧会把这个 mesh geom 当凸包 → 门洞被封。回执不许再说"空腔已保留"。
    expect(receipt.cavityLostNodes).toHaveLength(1)
    expect(receipt.cavityLostNodes![0]!.node).toBe("门洞墙")
    expect(receipt.cavityLostNodes![0]!.notice).toContain("CONSUMER_CONVEXIFIES")
    expect(receipt.interiorPreserved).toBe(false)
    // 导出几何本身仍是精确表面（门洞是空的）——"限制在消费端"这件事必须能被区分出来。
    expect(insideSolid(await collisionTriangles(record), [0, 0.8, 0.2])).toBe(false)
  }, 180_000)

  test("同一份连通凹实体的开放壳（无水密实心）：缺省改体素表面盒组，盒不占门洞", async () => {
    const path = await fixture("portal-shell.glb", portalShellGLB("shell"))
    await operations.import({ path, resourceId: "res_portal_shell", source: Z_UP, physicalizeUsage: "environment" })
    const record = await derived("res_portal_shell", 1, 1)
    const receipt = record.physicalization!
    expect(receipt.status).toBe("ok")
    expect(receipt.strategy).toBe("auto")
    expect(Object.keys(receipt.selection ?? {})).toEqual(["voxel_boxes"])
    expect(receipt.routed?.[0]!.reason).toContain("OPEN_SURFACE")
    expect(receipt.interiorPreserved).toBe(true)
    // 体素实际分辨率记进回执（近似误差来源），盒组不落进门洞内部。
    expect(receipt.voxelResolutionM).toHaveLength(1)
    expect(receipt.boxes).toBeGreaterThan(0)
    const boxes = await collisionBoxes(record)
    expect(boxes.filter(box => Math.abs(box.center[0]) < 0.6 && box.center[1] > 0.3 && box.center[1] < 2.1)).toEqual([])
  }, 180_000)

  test("同 resource@version 换参数重派生：新参数落自己的变体目录、旧引用文件字节不变、失败只清本次尝试的中间件", async () => {
    const path = await fixture("variant-portal.glb", portalGLB("variant"))
    const request = (voxelSizeM?: number, strategy: "voxel_boxes" | "convex_hull" = "voxel_boxes") => ({
      path, resourceId: "res_variant", source: Z_UP, physicalizeUsage: "environment" as const, physicalizeStrategy: strategy,
      ...(voxelSizeM !== undefined ? { physicalizeVoxelSizeM: voxelSizeM } : {}),
    })
    await operations.import(request(0.4))
    const coarser = await derived("res_variant", 1, 1)
    const coarseDirectory = join(dataRoot, "assets/derived/res_variant/v1/collision/environment", physicalizationVariant("voxel_boxes", 0.4))
    expect(coarseDirectory.endsWith(physicalizationVariant("voxel_boxes", 0.4))).toBe(true)
    const coarseFiles = await digest(coarseDirectory)
    // 体素盒组的装配是**内联盒**（collision.shape=box + shapes），不是文件 parts；"产物落在哪个目录"的
    // 证据在 ref.representations 上——这条引用记的碰撞表示就该落在 0.4 那个变体目录里。
    const coarseCollision = coarser.componentDefaults!.collision as { source: string; shape: string; shapes: unknown[] }
    expect(coarseCollision.source).toBe("asset-bake-environment")
    expect(coarseCollision.shape).toBe("box")
    expect(coarseCollision.shapes.length).toBeGreaterThan(0)
    const coarsePaths = coarser.ref.representations.filter(rep => rep.role === "collision").map(rep => localPath(rep.uri))
    expect(coarsePaths.length).toBeGreaterThan(0)
    expect(coarsePaths.every(file => dirname(file) === coarseDirectory)).toBe(true)
    // 盒组不写 OBJ：这份变体的产物是 voxel-*.json + physicalization.json。
    expect(Object.keys(coarseFiles).length).toBeGreaterThan(0)
    expect((coarser.physicalization!.voxelResolutionM ?? [])[0]).toBe(0.4)

    // 同一份字节 = 同一 resource@version；只换体素边长 → 重派生，但落在另一个变体目录里。
    await operations.import(request(0.2))
    const finer = await derived("res_variant", 1, 2)
    expect(finer.ref.version).toBe(1)
    expect(finer.physicalization!.attempts).toBe(2)
    expect(finer.physicalization!.previous?.status).toBe("ok")
    const fineDirectory = join(dataRoot, "assets/derived/res_variant/v1/collision/environment", physicalizationVariant("voxel_boxes", 0.2))
    expect(fineDirectory).not.toBe(coarseDirectory)
    expect((finer.physicalization!.voxelResolutionM ?? [])[0]).toBe(0.2)
    // 新声明用新产物，且回执里的路径与实际落位一致（旧变体的引用仍在记录里，所以按目录筛）。
    const finePaths = finer.ref.representations.filter(rep => rep.role === "collision").map(rep => localPath(rep.uri))
    expect(finePaths.filter(file => dirname(file) === fineDirectory).length).toBeGreaterThan(0)
    // 旧参数的文件字节一个都没动（旧 scene 的引用仍然读到原来的字节）。
    expect(await digest(coarseDirectory)).toEqual(coarseFiles)
    // 旧引用仍在记录里（represents 累积而不是被覆盖），旧文件名也还在。
    expect(finer.ref.representations.some(rep => localPath(rep.uri) === join(coarseDirectory, "physicalization.json"))).toBe(true)

    // 同一版本再来一次会被明确拒绝的请求：失败不许破坏前面两次成功。
    await operations.import(request(undefined, "convex_hull"))
    const failed = await derived("res_variant", 1, 3)
    expect(failed.physicalization!.status).toBe("failed")
    expect(failed.physicalization!.error).toContain("凸包会把房间或通道封死")
    expect(failed.physicalization!.previous?.status).toBe("ok")
    expect(await digest(coarseDirectory)).toEqual(coarseFiles)
    expect(Object.keys(await digest(fineDirectory)).length).toBeGreaterThan(0)
    // 失败只清本次尝试新建的字节：被拒的变体目录要么不存在、要么是空的（旧成功产物绝不递归删除）。
    const rejected = join(dataRoot, "assets/derived/res_variant/v1/collision/environment", physicalizationVariant("convex_hull"))
    expect(Object.keys(await digest(rejected)).length).toBe(0)
  }, 240_000)
})
