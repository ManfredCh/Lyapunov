/**
 * DEV-011（W13 scene-kit 侧）①②：建筑件的**已知实测尺寸对照绝对误差**与**动画不被当作物理**。
 *
 * 判据来源：`DEVELOPMENT_TODO.md` §DEV-011 完成条件 ①「已知实测尺寸对照绝对误差」、
 * ②「动画若要求驱动物理则用真实关节／碰撞验证」。本轮把这两条落在 scene-kit 自己的能力面上：
 *
 * ① 尺寸：夹具是一块**真实三角网格**的门板（glTF Y-up、米制，POSITION/索引访问器都是真的），
 *    声明尺寸 = 作者值 0.9 m（宽）× 0.06 m（厚）× 2.0 m（高）。读数取自两条**互相独立**的路径：
 *    · `glbGeometryFacts`（产品几何事实，实体本地、米）；
 *    · three 的真实 `GLTFLoader` + `sourceTransform`（Viewer 用的同一个加载器与同一份源坐标换算）。
 *    误差按**米**记；再验世界系（`worldMatrix`＝Unity 交换用的同一份层级折算）里旋转后的真实包围盒。
 *    负对照两条：把 Y-up 源当 Z-up（跳过源适配）、把实体本地当世界（跳过场景变换）——都必须明显错。
 *
 * ② 动画：夹具是一份**真的带动画**的同一门板 GLB（真 sampler/accessor，three 的 GLTFLoader 能读出
 *    clip），scene-kit 对"被动画驱动的显示节点"要静态几何时**明确拒绝**（`GEOMETRY_ANIMATION_UNSUPPORTED`），
 *    而不是给一份不等于实际画面的几何。负对照：同字节去掉动画后必须成功，且包围盒与静态件逐轴相同
 *    （证明拒绝的原因是动画本身，不是夹具坏了）。
 *    物理侧：物理化（真 asset-bake 子进程）只产出碰撞/刚体，**不产出任何关节通道**——要让建筑被物理驱动，
 *    件必须以带 `<joint>` 的原生 MJCF 导入（`articulation` 派生），动画不会被自动升级成物理。
 *
 * 需要 `LYAPUNOV_ALGORITHM_PYTHON` 指向带 trimesh 的解释器（与产品同一条 provider 路径）时物理化用例才跑；
 * 缺它按实际执行情况写回执，不把跳过当通过。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Box3, Matrix4, Quaternion, Vector3 } from "three"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import type { ResourceRef, Vec3 } from "../../lyapunov-contracts/src/types.ts"
import { GLTF_SOURCE, sourceTransform } from "../src/formats.ts"
import { glbGeometryFacts } from "../src/mesh-geometry.ts"
import { SceneOperations } from "../src/operations.ts"
import type { ResourceRecord } from "../src/resources.ts"
import { worldMatrix } from "../src/unity-exchange.ts"

/** 已知实测尺寸（米）：作者声明的门板宽/厚/高。 */
const MEASURED_M: Vec3 = [0.9, 0.06, 2.0]
/** 门板在 glTF 源坐标系里的范围：X=宽、Y=高、Z=厚（glTF 规范 Y-up、源单位=米）。 */
const DOOR_SOURCE_BOUNDS = { min: [-0.45, 0, -0.03] as Vec3, max: [0.45, 2.0, 0.03] as Vec3 }

interface GlbOptions { generator: string; animation: boolean }

/** 门板 8 顶点、12 面（外向绕序），再加一条**真的**旋转动画（input=SCALAR 秒，output=VEC4 xyzw 四元数）。 */
function doorGlb(options: GlbOptions): Buffer {
  const { min, max } = DOOR_SOURCE_BOUNDS
  const [x0, y0, z0] = min, [x1, y1, z1] = max
  const positions: Vec3[] = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
  const indices: number[] = []
  for (const [a, b, c, d] of quads) indices.push(a!, b!, c!, d!, a!, c!, d!)
  const blobs: Buffer[] = []
  const bufferViews: Array<Record<string, unknown>> = []
  let offset = 0
  const append = (payload: Buffer): number => {
    const padding = (4 - (offset % 4)) % 4
    if (padding) { blobs.push(Buffer.alloc(padding)); offset += padding }
    const index = bufferViews.length
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: payload.length })
    blobs.push(payload); offset += payload.length
    return index
  }
  const accessors: Array<Record<string, unknown>> = []
  const positionBytes = Buffer.alloc(positions.length * 12)
  positions.forEach((point, vertex) => point.forEach((value, axis) => positionBytes.writeFloatLE(value, vertex * 12 + axis * 4)))
  accessors.push({
    bufferView: append(positionBytes), componentType: 5126, count: positions.length, type: "VEC3",
    min: [0, 1, 2].map(axis => Math.min(...positions.map(point => point[axis]!))),
    max: [0, 1, 2].map(axis => Math.max(...positions.map(point => point[axis]!))),
  })
  const indexBytes = Buffer.alloc(indices.length * 2)
  indices.forEach((value, position) => indexBytes.writeUInt16LE(value, position * 2))
  accessors.push({ bufferView: append(indexBytes), componentType: 5123, count: indices.length, type: "SCALAR" })
  const json: Record<string, unknown> = {
    asset: { version: "2.0", generator: options.generator },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "门板", mesh: 0 }],
    meshes: [{ name: "门板网格", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ name: "门板材质", pbrMetallicRoughness: { baseColorFactor: [0.42, 0.24, 0.1, 1] } }],
    accessors, bufferViews, buffers: [{ byteLength: 0 }],
  }
  if (options.animation) {
    // 真实动画：绕 Y 轴（glTF 门轴）从 0° 摆到 90°，两个关键帧。
    const times = Buffer.alloc(8)
    times.writeFloatLE(0, 0); times.writeFloatLE(1, 4)
    const half = Math.sin(Math.PI / 4), quarter = Math.cos(Math.PI / 4)
    const rotations = Buffer.alloc(32)
    const keys: Array<[number, number, number, number]> = [[0, 0, 0, 1], [0, half, 0, quarter]]
    keys.forEach((key, frame) => key.forEach((value, axis) => rotations.writeFloatLE(value, frame * 16 + axis * 4)))
    accessors.push({ bufferView: append(times), componentType: 5126, count: 2, type: "SCALAR", min: [0], max: [1] })
    accessors.push({ bufferView: append(rotations), componentType: 5126, count: 2, type: "VEC4" })
    json.animations = [{ name: "door-swing", samplers: [{ input: 2, output: 3, interpolation: "LINEAR" }], channels: [{ sampler: 0, target: { node: 0, path: "rotation" } }] }]
  }
  const binary = Buffer.concat(blobs)
  ;(json.buffers as Array<Record<string, unknown>>)[0]!.byteLength = binary.length
  const payload = Buffer.from(JSON.stringify(json), "utf8")
  const jsonChunk = Buffer.concat([payload, Buffer.alloc((4 - (payload.length % 4)) % 4, 0x20)])
  const total = 12 + 8 + jsonChunk.length + (binary.length ? 8 + binary.length : 0)
  const header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8)
  jsonHeader.writeUInt32LE(jsonChunk.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  const parts = [header, jsonHeader, jsonChunk]
  if (binary.length) {
    const binaryHeader = Buffer.alloc(8)
    binaryHeader.writeUInt32LE(binary.length, 0); binaryHeader.writeUInt32LE(0x004e4942, 4)
    parts.push(binaryHeader, binary)
  }
  return Buffer.concat(parts)
}

const extents = (bounds: { min: Vec3; max: Vec3 }): Vec3 => [0, 1, 2].map(axis => bounds.max[axis]! - bounds.min[axis]!) as Vec3
/** 绝对误差（米）与相对误差（%）；相对误差按声明尺寸归一，声明为 0 的轴不给百分比。 */
const absoluteError = (measured: Vec3, truth: Vec3): Vec3 => [0, 1, 2].map(axis => measured[axis]! - truth[axis]!) as Vec3
const percent = (measured: Vec3, truth: Vec3): Array<number | null> => [0, 1, 2].map(axis => truth[axis] === 0 ? null : (measured[axis]! - truth[axis]!) / truth[axis]! * 100)

/** 独立读数：three 的真实 GLTFLoader 量出画面包围盒，再按产品同一份 `sourceTransform` 换算到实体本地。 */
async function loaderLocalBounds(bytes: Buffer): Promise<{ min: Vec3; max: Vec3 }> {
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer, "")
  gltf.scene.updateMatrixWorld(true)
  const raw = new Box3().setFromObject(gltf.scene, true)
  const transform = sourceTransform(GLTF_SOURCE)
  const matrix = new Matrix4().compose(new Vector3(...transform.position), new Quaternion(...transform.quaternion), new Vector3(...transform.scale))
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity)
  for (const x of [raw.min.x, raw.max.x]) for (const y of [raw.min.y, raw.max.y]) for (const z of [raw.min.z, raw.max.z]) {
    const corner = new Vector3(x, y, z).applyMatrix4(matrix)
    min.min(corner); max.max(corner)
  }
  return { min: min.toArray() as Vec3, max: max.toArray() as Vec3 }
}

/** 世界系包围盒：实体本地 8 角过 `worldMatrix`（含父链）后取 AABB。 */
function worldBoundsOf(local: { min: Vec3; max: Vec3 }, matrix: Matrix4): { min: Vec3; max: Vec3 } {
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity)
  for (const x of [local.min[0], local.max[0]]) for (const y of [local.min[1], local.max[1]]) for (const z of [local.min[2], local.max[2]]) {
    const corner = new Vector3(x, y, z).applyMatrix4(matrix)
    min.min(corner); max.max(corner)
  }
  return { min: min.toArray() as Vec3, max: max.toArray() as Vec3 }
}

const nearZero = (values: Vec3, tolerance: number): boolean => values.every(value => Math.abs(value) < tolerance)

describe("DEV-011①：已知实测尺寸对照绝对误差（门板 0.9×0.06×2.0 m）", () => {
  test("产品几何事实的实体本地米制尺寸与声明尺寸逐轴相等（误差 < 1e-6 m）", () => {
    const bytes = doorGlb({ generator: "g19-door-static", animation: false })
    const facts = glbGeometryFacts(bytes)
    const measured = extents(facts.bounds)
    expect(absoluteError(measured, MEASURED_M).map(value => Number(value.toFixed(9)))).toEqual([0, 0, 0])
    expect(nearZero(absoluteError(measured, MEASURED_M), 1e-6)).toBe(true)
    expect(facts.frame).toContain("entity-local")
  })

  test("独立读数（three GLTFLoader + sourceTransform）与产品事实逐轴一致（不拿本仓自己互证）", async () => {
    const bytes = doorGlb({ generator: "g19-door-static", animation: false })
    const facts = glbGeometryFacts(bytes)
    const oracle = await loaderLocalBounds(bytes)
    const measured = extents(oracle)
    // 画面量出来的尺寸同样等于声明尺寸（浮点存储 float32，容差 1e-6 m）。
    expect(nearZero(absoluteError(measured, MEASURED_M), 1e-6)).toBe(true)
    expect(nearZero(absoluteError(measured, extents(facts.bounds)), 1e-6)).toBe(true)
  })

  test("负对照：把 Y-up 源当 Z-up（跳过源坐标适配）→ 逐轴错 1.94 m，不是「看起来差不多」", () => {
    const bytes = doorGlb({ generator: "g19-door-static", animation: false })
    const wrongSource: ResourceRef["source"] = { units: "m", upAxis: "Z", handedness: "right", metersPerUnit: 1 }
    const wrong = extents(glbGeometryFacts(bytes, { source: wrongSource }).bounds)
    // 轴错配：宽 0.9 恰好一样，厚/高互换 ⇒ 各错 1.94 m。
    expect(Math.abs(absoluteError(wrong, MEASURED_M)[0]!)).toBeLessThan(1e-6)
    expect(Math.abs(absoluteError(wrong, MEASURED_M)[1]!)).toBeGreaterThan(1.9)
    expect(Math.abs(absoluteError(wrong, MEASURED_M)[2]!)).toBeGreaterThan(1.9)
  })

  test("世界系：实体绕 Z 转 90° 后真实世界包围盒是 0.06×0.9×2.0；把本地当世界即错 0.84 m", async () => {
    const base = await mkdtemp(join(tmpdir(), "g19-scale-"))
    try {
      const path = join(base, "door.glb")
      await writeFile(path, doorGlb({ generator: "g19-door-static", animation: false }))
      const operations = new SceneOperations(join(base, "data"))
      const scene = await operations.create({ sceneId: "g19-scale" })
      expect(scene.sceneId).toBe("g19-scale")
      // 90° 绕 Z：本地 (x,y,z) → 世界 (−y,x,z)；取 90° 的精确四元数，读数才谈得上逐位。
      const half = Math.SQRT1_2
      const mounted = await operations.import({
        path, sceneId: "g19-scale", resourceId: "res_g19_door", entityId: "door_panel",
        transform: { position: [3, 0, 0], quaternion: [0, 0, half, half], scale: [1, 1, 1] },
        alignBottomToSurface: false, physicalize: false,
      })
      expect(mounted.entityId).toBe("door_panel")
      const snapshot = await operations.inspect("g19-scale")
      const matrix = worldMatrix(snapshot, "door_panel")
      const facts = glbGeometryFacts(doorGlb({ generator: "g19-door-static", animation: false }))
      const world = worldBoundsOf(facts.bounds, matrix)
      expect(nearZero(absoluteError(extents(world), [0.06, 0.9, 2.0]), 1e-5)).toBe(true)
      // 位置也说清：底面贴地与 X 轴落位都是变换的实际结果。
      expect(Math.abs(world.min[0]! - 2.97)).toBeLessThan(1e-5)
      expect(Math.abs(world.min[2]! - 0)).toBeLessThan(1e-5)
      // 负对照：把实体本地尺寸当世界尺寸 ⇒ X/Y 各错 0.84 m（相对 1400% / 93.3%）。
      const localAsWorld = absoluteError(extents(facts.bounds), extents(world))
      expect(Math.abs(localAsWorld[0]!)).toBeGreaterThan(0.83)
      expect(Math.abs(localAsWorld[1]!)).toBeGreaterThan(0.83)
      expect(Math.abs(localAsWorld[2]!)).toBeLessThan(1e-5)
      expect(percent(extents(facts.bounds), extents(world))[0]!).toBeGreaterThan(1000)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

describe("DEV-011②：动画只驱动显示，不被当成物理（scene-kit 侧的明确边界）", () => {
  test("真动画夹具：three 的 GLTFLoader 读出 clip —— 拒绝不是夹具坏了", async () => {
    const bytes = doorGlb({ generator: "g19-door-animated", animation: true })
    const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer, "")
    expect(gltf.animations.map(clip => clip.name)).toEqual(["door-swing"])
    expect(gltf.animations[0]!.duration).toBeCloseTo(1, 6)
    expect(gltf.animations[0]!.tracks.length).toBeGreaterThan(0)
  })

  test("被动画驱动的显示节点要静态几何 → GEOMETRY_ANIMATION_UNSUPPORTED（拒绝，不给不等价几何）", () => {
    const bytes = doorGlb({ generator: "g19-door-animated", animation: true })
    expect(() => glbGeometryFacts(bytes)).toThrow(/GEOMETRY_ANIMATION_UNSUPPORTED/)
  })

  test("负对照：同字节去掉动画即成功，且包围盒与静态件逐轴相同（拒绝的原因是动画本身）", () => {
    const staticFacts = glbGeometryFacts(doorGlb({ generator: "g19-door-static", animation: false }))
    const strippedFacts = glbGeometryFacts(doorGlb({ generator: "g19-door-animated", animation: false }))
    expect(nearZero(absoluteError(extents(strippedFacts.bounds), extents(staticFacts.bounds)), 1e-9)).toBe(true)
  })
})

const provider = process.env.LYAPUNOV_ALGORITHM_PYTHON
const withProvider = provider ? describe : describe.skip

withProvider("DEV-011②（物理侧）：物理化只产出碰撞，不产出关节通道", () => {
  let base: string
  beforeEach(async () => { base = await mkdtemp(join(tmpdir(), "g19-anim-physics-")) })
  afterEach(async () => { await rm(base, { recursive: true, force: true }) })

  /** 派生是 fire-and-forget：轮询到本次尝试落定（attempts 是这次派生的身份）。 */
  async function settled(operations: SceneOperations, resourceId: string, version: number, attempts = 1, timeoutMs = 180_000): Promise<ResourceRecord> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const record = await operations.resources.get(resourceId, version)
      if (record.physicalization && (record.physicalization.attempts ?? 0) >= attempts && record.physicalization.status !== "pending") return record
      if (Date.now() > deadline) throw new Error(`physicalization 超时：${record.physicalization?.status ?? "无回执"}`)
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  test("带动画的建筑 GLB：碰撞派生落 ok，组件里没有任何关节/引擎控制通道", async () => {
    const path = join(base, "building-animated.glb")
    await writeFile(path, doorGlb({ generator: "g19-door-animated", animation: true }))
    const operations = new SceneOperations(join(base, "data"))
    await operations.import({ path, resourceId: "res_anim_door", physicalizeUsage: "environment" })
    const record = await settled(operations, "res_anim_door", 1)
    expect(record.physicalization!.status).toBe("ok")
    expect(record.physicalization!.usage).toBe("environment")
    // 视觉件仍然带动画（Viewer 侧照旧能播），但物理侧只有碰撞/刚体：
    const components = record.componentDefaults ?? {}
    expect(components.collision).toBeDefined()
    expect(components.rigidBody?.type).toBe("static")
    expect(components.articulation).toBeUndefined()
    expect(components.mujoco).toBeUndefined()
    // 结论写成可核对的形态：表示里没有关节，派生回执里也没有关节计数（本工具不产关节）。
    expect(JSON.stringify(record.physicalization).includes("joint")).toBe(false)
  }, 240_000)
})
