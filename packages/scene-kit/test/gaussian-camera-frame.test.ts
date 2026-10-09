/**
 * 首相机坐标标记从 PLY 头 → parsed.metadata → Scene visual → 源坐标适配 → **实际挂载落地**的离线回归。
 *
 * 全部走真实项目函数（parseAsset / ResourceRegistry.import / SceneOperations.mount /
 * applySplatMountFacts / gaussianSourceTransform），文件是临时目录里的**完整** binary little endian
 * 14-float Gaussian PLY（真实顶点正文 + 有效四元数），不是 header-only。核心判据：47 已把画面朝向修对，
 * 但 assetBounds/落地仍按普通 +90 换算会让 CV 件"方向对、高度错"——这里验证两者用的是同一帧。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as THREE from "three"
import { assetBounds, parseAsset, gaussianSourceTransform, sourceTransform } from "../src/formats.ts"
import { SceneOperations, applySplatMountFacts, applySplatPreviewFacts } from "../src/operations.ts"
import type { ResourceRecord } from "../src/resources.ts"
import { GAUSSIAN_CAMERA_FRAME_MARKERS } from "../../lyapunov-contracts/src/gaussian-frame.ts"
import { identityTransform, type Entity, type Transform, type Vec3 } from "../../lyapunov-contracts/src/types.ts"

const V2 = GAUSSIAN_CAMERA_FRAME_MARKERS["first-camera-c2w-v2"]
const V3 = GAUSSIAN_CAMERA_FRAME_MARKERS["first-camera-opengl-v3"]
/** 与生产侧 `gaussian_ply_header` 逐字一致的 14 个 float 属性顺序。 */
const GAUSSIAN_PROPERTIES = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
const YUP = { units: "m", upAxis: "Y", handedness: "right", metersPerUnit: 1 } as const
/** 主控反例的两份等价数据（源坐标 aabb）。 */
const CV_AABB = { min: [-1, -10, -2] as Vec3, max: [1, 1, 5] as Vec3 }
const GL_AABB = { min: [-1, -1, -5] as Vec3, max: [1, 10, 2] as Vec3 }
/** 两份等价数据经正确 frame-aware 源坐标变换后的公共世界（实体本地）aabb。 */
const EXPECTED_SOURCE = { min: [-1, -2, -1] as Vec3, max: [1, 5, 10] as Vec3 }

/** 8 个角点，让 splatBounds 从真实顶点正文解出指定 aabb。 */
function corners(min: Vec3, max: Vec3): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = []
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push([x, y, z])
  return out
}

/** 完整 binary little endian 14-float Gaussian PLY：真实正文 + rot_0=1 的有效四元数。 */
function binaryPly(frame: string | undefined, vertices: Array<[number, number, number]>): Buffer {
  const lines = ["ply", "format binary_little_endian 1.0", "comment Lyapunov idle native Gaussian splat (SH0)"]
  if (frame !== undefined) lines.push(frame)
  lines.push(`element vertex ${vertices.length}`)
  for (const property of GAUSSIAN_PROPERTIES) lines.push(`property float ${property}`)
  lines.push("end_header")
  const header = Buffer.from(lines.join("\n") + "\n", "ascii")
  const body = Buffer.alloc(vertices.length * GAUSSIAN_PROPERTIES.length * 4)
  vertices.forEach((vertex, index) => {
    const base = index * GAUSSIAN_PROPERTIES.length * 4
    const row = [vertex[0], vertex[1], vertex[2], 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0] // rot_0=w=1
    row.forEach((value, slot) => body.writeFloatLE(value, base + slot * 4))
  })
  return Buffer.concat([header, body])
}

/** 把一个源坐标 aabb 经 `entity ∘ sourceTransform` 后的世界 aabb（消费挂载写出的真实事实，不重算源坐标）。 */
function worldBounds(aabb: { min: Vec3; max: Vec3 }, source: Transform, entity: Transform): { min: Vec3; max: Vec3 } {
  const sourceMatrix = new THREE.Matrix4().compose(new THREE.Vector3(...source.position), new THREE.Quaternion(...source.quaternion), new THREE.Vector3(...source.scale))
  const entityMatrix = new THREE.Matrix4().compose(new THREE.Vector3(...entity.position), new THREE.Quaternion(...entity.quaternion), new THREE.Vector3(...entity.scale))
  const matrix = entityMatrix.clone().multiply(sourceMatrix)
  const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  for (const x of [aabb.min[0], aabb.max[0]]) for (const y of [aabb.min[1], aabb.max[1]]) for (const z of [aabb.min[2], aabb.max[2]]) {
    const point = new THREE.Vector3(x, y, z).applyMatrix4(matrix)
    min.min(point); max.max(point)
  }
  return { min: min.toArray() as Vec3, max: max.toArray() as Vec3 }
}

const near = (a: Vec3, b: Vec3, epsilon = 1e-6): boolean => a.every((value, axis) => Math.abs(value - b[axis]!) < epsilon)
const sameTransform = (a: Transform, b: Transform): boolean =>
  near(a.position, b.position) && near(a.quaternion as unknown as Vec3, b.quaternion as unknown as Vec3, 1e-9) && near(a.scale, b.scale, 1e-9)

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

const metadata = (frame?: string, count = 1000): Record<string, unknown> => ({ format: "ply", vertexCount: count, gaussianProperties: true, ...(frame ? { gaussianCameraFrame: frame } : {}) })
const resource = (meta: Record<string, unknown>, visualSourceTransform?: unknown): ResourceRecord => ({
  parsed: { kind: "splat", mimeType: "application/x-ply", source: {}, dependencies: [], metadata: meta },
  ref: { resourceId: "r", version: 1, original: { uri: "r.ply", mimeType: "application/x-ply" }, representations: [], source: YUP },
  visualSourceTransform,
  sceneGeometryBinding: undefined,
}) as unknown as ResourceRecord

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "lya-gaussian-flow-"))
  directories.push(root)
  const operations = new SceneOperations(join(root, "data"), { productRoot: root })
  await operations.create({ sceneId: "flow" })
  let sequence = 0
  const register = async (name: string, bytes: Buffer, extra: Record<string, unknown> = {}) => {
    const path = join(root, "materials", name)
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, bytes)
    return operations.resources.import({ path, name, physicalizationRequest: false, ...extra })
  }
  const mount = (input: Record<string, unknown>, imported?: ResourceRecord) => operations.mount({ sceneId: "flow", resourceId: "x", ...input } as never, imported)
  const identityOf = () => `e${++sequence}`
  return { root, operations, register, mount, identityOf }
}

describe("parseAsset 从真实完整 PLY 头读出坐标标记", () => {
  test("v2/v3 标记进入 metadata；无标记头不带字段；正文/属性行都真实", async () => {
    const root = await mkdtemp(join(tmpdir(), "lya-gaussian-frame-")); directories.push(root)
    const path = join(root, "fixture.ply")
    await writeFile(path, binaryPly(V2, corners(CV_AABB.min, CV_AABB.max)))
    const parsed = await parseAsset(path)
    expect(parsed.metadata.gaussianCameraFrame).toBe("first-camera-c2w-v2")
    expect(parsed.metadata.vertexCount).toBe(8)
    expect(parsed.metadata.gaussianProperties).toBe(true)
    expect(parsed.metadata.aabb).toEqual({ min: CV_AABB.min, max: CV_AABB.max })
    await writeFile(path, binaryPly(V3, corners(GL_AABB.min, GL_AABB.max)))
    expect((await parseAsset(path)).metadata.gaussianCameraFrame).toBe("first-camera-opengl-v3")
    await writeFile(path, binaryPly(undefined, corners(CV_AABB.min, CV_AABB.max)))
    expect((await parseAsset(path)).metadata.gaussianCameraFrame).toBeUndefined()
  })

  test("comment 里提 property 不伪造 Gaussian 判据；同标记重复不写字段", async () => {
    const root = await mkdtemp(join(tmpdir(), "lya-gaussian-frame-")); directories.push(root)
    const path = join(root, "fake.ply")
    // 真实属性只有 xyz，Gaussian 只是 comment 的措辞。
    const text = "ply\nformat binary_little_endian 1.0\ncomment Lyapunov idle coordinate_frame first_camera_c2w_v2\ncomment property float f_dc_0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n"
    await writeFile(path, Buffer.from(text, "ascii"))
    const parsed = await parseAsset(path)
    expect(parsed.metadata.gaussianProperties).toBe(false)
    expect(parsed.metadata.gaussianCameraFrame).toBeUndefined()
    // 同标记重复两次：不是"唯一一条"，不写字段。
    const duplicate = binaryPly(V2, corners(CV_AABB.min, CV_AABB.max))
    const duplicateText = duplicate.toString("latin1").replace("comment Lyapunov idle native Gaussian splat (SH0)", `comment Lyapunov idle native Gaussian splat (SH0)\n${V2}`)
    await writeFile(path, Buffer.from(duplicateText, "latin1"))
    expect((await parseAsset(path)).metadata.gaussianCameraFrame).toBeUndefined()
  })
})

describe("assetBounds 与 visual 用同一 frame-aware 源坐标", () => {
  test("原 root negative：直接两参调用 CV/OpenGL 得到相同世界 aabb", () => {
    const cv = { kind: "splat", mimeType: "application/x-ply", source: YUP, dependencies: [], metadata: { gaussianCameraFrame: "first-camera-c2w-v2", aabb: CV_AABB } } as never
    const gl = { kind: "splat", mimeType: "application/x-ply", source: YUP, dependencies: [], metadata: { gaussianCameraFrame: "first-camera-opengl-v3", aabb: GL_AABB } } as never
    const a = assetBounds(cv, YUP)!, b = assetBounds(gl, YUP)!
    expect(near(a.min, EXPECTED_SOURCE.min) && near(a.max, EXPECTED_SOURCE.max)).toBe(true)
    expect(near(b.min, EXPECTED_SOURCE.min) && near(b.max, EXPECTED_SOURCE.max)).toBe(true)
    expect(near(a.min, b.min) && near(a.max, b.max)).toBe(true)
  })

  test("显式 effectiveTransform 优先且不叠加；未标记资产沿用普通 +90", () => {
    const explicit = { position: [1, 2, 3], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] } as Transform
    const cv = { kind: "splat", mimeType: "application/x-ply", source: YUP, dependencies: [], metadata: { gaussianCameraFrame: "first-camera-c2w-v2", aabb: CV_AABB } } as never
    const explicitBounds = assetBounds(cv, YUP, explicit)!
    // identity 旋转 + 平移：min z = -2 + 3 = 1。
    expect(near(explicitBounds.min, [0, -8, 1]) && near(explicitBounds.max, [2, 3, 8])).toBe(true)
    const plain = { kind: "splat", mimeType: "application/x-ply", source: YUP, dependencies: [], metadata: { aabb: { min: [0, 0, 0], max: [1, 2, 3] } } } as never
    const plainBounds = assetBounds(plain, YUP)!
    expect(near(plainBounds.min, [0, -3, 0]) && near(plainBounds.max, [1, 0, 2])).toBe(true)
  })
})

describe("完整 import→mount 数据流：frame、落地与世界 aabb", () => {
  test("CV(v2) 与 OpenGL(v3) 等价件落地后世界 aabb/首相机原点一致，floor 贴 0", async () => {
    const { operations, register, mount } = await setup()
    const cv = await register("cv.ply", binaryPly(V2, corners(CV_AABB.min, CV_AABB.max)), { resourceId: "cv" })
    const gl = await register("gl.ply", binaryPly(V3, corners(GL_AABB.min, GL_AABB.max)), { resourceId: "gl" })
    const mounted: Array<{ entity: Entity; parsed: Awaited<ReturnType<typeof parseAsset>> }> = []
    for (const record of [cv, gl]) {
      const result = await mount({ resourceId: record.ref.resourceId, transform: identityTransform() })
      const entity = result.snapshot.entities.find(item => item.entityId === result.entityId)!
      mounted.push({ entity, parsed: record.parsed })
    }
    const [cvMounted, glMounted] = mounted
    // 两份文件各自读对 frame，并装配同一份 frame-aware 源坐标。
    expect(cvMounted!.entity.components.visual!.gaussianCameraFrame).toBe("first-camera-c2w-v2")
    expect(glMounted!.entity.components.visual!.gaussianCameraFrame).toBe("first-camera-opengl-v3")
    expect(sameTransform(cvMounted!.entity.components.visual!.sourceTransform as Transform, gaussianSourceTransform(YUP, "first-camera-c2w-v2"))).toBe(true)
    expect(sameTransform(glMounted!.entity.components.visual!.sourceTransform as Transform, gaussianSourceTransform(YUP, "first-camera-opengl-v3"))).toBe(true)
    // 源坐标世界 aabb（实体本地）两边都等于期望值——修正前 CV 会得到 min[-1,-5,-10]/max[1,2,1]。
    const cvLocal = worldBounds(cvMounted!.parsed.metadata.aabb as { min: Vec3; max: Vec3 }, cvMounted!.entity.components.visual!.sourceTransform as Transform, identityTransform())
    const glLocal = worldBounds(glMounted!.parsed.metadata.aabb as { min: Vec3; max: Vec3 }, glMounted!.entity.components.visual!.sourceTransform as Transform, identityTransform())
    expect(near(cvLocal.min, EXPECTED_SOURCE.min) && near(cvLocal.max, EXPECTED_SOURCE.max)).toBe(true)
    expect(near(glLocal.min, EXPECTED_SOURCE.min) && near(glLocal.max, EXPECTED_SOURCE.max)).toBe(true)
    // 落地：世界 aabb 底面贴 floor 0，两份一致；首相机世界原点（源原点）也一致。
    const cvWorld = worldBounds(cvMounted!.parsed.metadata.aabb as { min: Vec3; max: Vec3 }, cvMounted!.entity.components.visual!.sourceTransform as Transform, cvMounted!.entity.transform)
    const glWorld = worldBounds(glMounted!.parsed.metadata.aabb as { min: Vec3; max: Vec3 }, glMounted!.entity.components.visual!.sourceTransform as Transform, glMounted!.entity.transform)
    expect(cvWorld.min[2]).toBeCloseTo(0, 9)
    expect(glWorld.min[2]).toBeCloseTo(0, 9)
    expect(near(cvWorld.min, glWorld.min) && near(cvWorld.max, glWorld.max)).toBe(true)
    expect(near(cvMounted!.entity.transform.position, glMounted!.entity.transform.position)).toBe(true)
    // 源原点经实体变换后的世界点（首相机原点）也一致。
    const cvOrigin = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().compose(new THREE.Vector3(...cvMounted!.entity.transform.position), new THREE.Quaternion(...cvMounted!.entity.transform.quaternion), new THREE.Vector3(...cvMounted!.entity.transform.scale)))
    const glOrigin = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().compose(new THREE.Vector3(...glMounted!.entity.transform.position), new THREE.Quaternion(...glMounted!.entity.transform.quaternion), new THREE.Vector3(...glMounted!.entity.transform.scale)))
    expect(cvOrigin.distanceTo(glOrigin)).toBeLessThan(1e-9)
    // 场景里真实落了两条实体。
    expect((await operations.scene.snapshot("flow")).entities.length).toBe(2)
  })

  test("非 identity 实例位姿 + 单位缩放：旋转/缩放保留，落地贴到给定高度", async () => {
    const { register, mount } = await setup()
    const cv = await register("cv.ply", binaryPly(V2, corners(CV_AABB.min, CV_AABB.max)), { resourceId: "cv" })
    const pose: Transform = { position: [2, 3, 4], quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, -0.4, 0.6)).toArray() as Transform["quaternion"], scale: [1, 1, 1] }
    const result = await mount({ resourceId: cv.ref.resourceId, transform: structuredClone(pose) })
    const entity = result.snapshot.entities.find(item => item.entityId === result.entityId)!
    expect(entity.transform.quaternion).toEqual(pose.quaternion)
    expect(entity.transform.scale).toEqual([1, 1, 1])
    expect(entity.transform.position[0]).toBeCloseTo(2, 9)
    expect(entity.transform.position[1]).toBeCloseTo(3, 9)
    const world = worldBounds(cv.parsed.metadata.aabb as { min: Vec3; max: Vec3 }, entity.components.visual!.sourceTransform as Transform, entity.transform)
    expect(world.min[2]).toBeCloseTo(4, 9)
  })

  test("显式 visualSourceTransform 优先：不叠加 v2，落地也按它算", async () => {
    const { register, mount } = await setup()
    const explicit: Transform = { position: [1, 2, 3], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }
    const cv = await register("cv.ply", binaryPly(V2, corners(CV_AABB.min, CV_AABB.max)), { resourceId: "cv", visualSourceTransform: explicit })
    const result = await mount({ resourceId: cv.ref.resourceId, transform: identityTransform() })
    const entity = result.snapshot.entities.find(item => item.entityId === result.entityId)!
    expect(sameTransform(entity.components.visual!.sourceTransform as Transform, explicit)).toBe(true)
    expect(entity.components.visual!.gaussianCameraFrame).toBe("first-camera-c2w-v2")
    // 显式变换下 CV aabb 的 min z = -2 + 3 = 1 ⇒ 落地后 position z = -1，世界 min z = 0。
    const world = worldBounds(cv.parsed.metadata.aabb as { min: Vec3; max: Vec3 }, entity.components.visual!.sourceTransform as Transform, entity.transform)
    expect(world.min[2]).toBeCloseTo(0, 9)
    expect(entity.transform.position[2]).toBeCloseTo(-1, 9)
  })

  test("单位换算进入落地矩阵（source metersPerUnit=0.001）", async () => {
    const { register, mount } = await setup()
    const cv = await register("mm.ply", binaryPly(V2, corners(CV_AABB.min, CV_AABB.max)), { resourceId: "mm", source: { units: "mm", upAxis: "Y", handedness: "right", metersPerUnit: 0.001 } })
    const result = await mount({ resourceId: cv.ref.resourceId, transform: identityTransform() })
    const entity = result.snapshot.entities.find(item => item.entityId === result.entityId)!
    const transform = entity.components.visual!.sourceTransform as Transform
    expect(transform.scale).toEqual([0.001, 0.001, 0.001])
    const world = worldBounds(cv.parsed.metadata.aabb as { min: Vec3; max: Vec3 }, transform, entity.transform)
    expect(world.min[2]).toBeCloseTo(0, 9)
    expect(world.min[0]).toBeCloseTo(-0.001, 9)
    expect(world.max[1]).toBeCloseTo(0.005, 9)
  })

  test("alignBottomToSurface:false：保留原点精确落位，不抬升", async () => {
    const { register, mount } = await setup()
    const cv = await register("cv.ply", binaryPly(V2, corners(CV_AABB.min, CV_AABB.max)), { resourceId: "cv" })
    const pose: Transform = { position: [0, 0, 5], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }
    const result = await mount({ resourceId: cv.ref.resourceId, transform: structuredClone(pose), alignBottomToSurface: false })
    const entity = result.snapshot.entities.find(item => item.entityId === result.entityId)!
    expect(entity.transform.position).toEqual([0, 0, 5])
  })

  test("collisionBounds 优先于视觉 aabb 落地", async () => {
    const { operations, register, mount } = await setup()
    const cv = await register("cv.ply", binaryPly(V2, corners(CV_AABB.min, CV_AABB.max)), { resourceId: "cv" })
    const collision: ResourceRecord = {
      ...cv,
      physicalization: { status: "ok", strategy: "auto", collisionBounds: { min: [-5, -5, -5], max: [5, 5, 5] } },
    }
    const result = await mount({ resourceId: cv.ref.resourceId, transform: identityTransform() }, collision)
    const entity = result.snapshot.entities.find(item => item.entityId === result.entityId)!
    // 碰撞盒 min z = -5 ⇒ position z = 5（视觉 aabb 的 min z = -1 只会给 1）。
    expect(entity.transform.position[2]).toBeCloseTo(5, 9)
    expect((await operations.scene.snapshot("flow")).entities.length).toBe(1)
  })

  test("未知普通 splat asset 原行为不动：无 frame、+90、视觉 aabb 落地", async () => {
    const { register, mount } = await setup()
    const plain = await register("plain.ply", binaryPly(undefined, corners([-1, -10, -2], [1, 1, 5])), { resourceId: "plain" })
    expect(plain.parsed.metadata.gaussianCameraFrame).toBeUndefined()
    const result = await mount({ resourceId: plain.ref.resourceId, transform: identityTransform() })
    const entity = result.snapshot.entities.find(item => item.entityId === result.entityId)!
    expect(entity.components.visual!.gaussianCameraFrame).toBeUndefined()
    expect(sameTransform(entity.components.visual!.sourceTransform as Transform, sourceTransform(YUP))).toBe(true)
    const world = worldBounds(plain.parsed.metadata.aabb as { min: Vec3; max: Vec3 }, entity.components.visual!.sourceTransform as Transform, entity.transform)
    expect(world.min[2]).toBeCloseTo(0, 9)
    expect(world.min[0]).toBeCloseTo(-1, 9)
    // 未知件仍是普通 +90：源 aabb 的 y∈[-10,1]、z∈[-2,5] ⇒ 世界 y∈[-5,2]、z∈[-10,1]；落地再平移 +10。
    expect(world.max[1]).toBeCloseTo(2, 9)
    expect(world.max[2]).toBeCloseTo(11, 9)
  })
})

describe("gaussianSourceTransform：v2 CV 用 Rx(−90)，v3/普通沿用既有 +90", () => {
  const yUp = { units: "m", upAxis: "Y", handedness: "right", metersPerUnit: 2 } as const
  const rotate = (transform: { quaternion: readonly number[] }, vector: THREE.Vector3) => vector.clone().applyQuaternion(new THREE.Quaternion().fromArray([...transform.quaternion]))

  test("v2 让 up −Y→+Z、forward +Z→+Y；v3 与无标记仍是 +90", () => {
    const v2 = gaussianSourceTransform(yUp, "first-camera-c2w-v2")
    expect(rotate(v2, new THREE.Vector3(0, -1, 0)).distanceTo(new THREE.Vector3(0, 0, 1))).toBeLessThan(1e-9)
    expect(rotate(v2, new THREE.Vector3(0, 0, 1)).distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-9)
    expect(v2.scale).toEqual([2, 2, 2])
    const v3 = gaussianSourceTransform(yUp, "first-camera-opengl-v3")
    expect(rotate(v3, new THREE.Vector3(0, 1, 0)).distanceTo(new THREE.Vector3(0, 0, 1))).toBeLessThan(1e-9)
    expect(rotate(v3, new THREE.Vector3(0, 0, -1)).distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-9)
    expect(gaussianSourceTransform(yUp, undefined)).toEqual(sourceTransform(yUp))
  })

  test("显式 override 别的 upAxis 时不替它做 v2 决定", () => {
    const zUp = { units: "m", upAxis: "Z", handedness: "right", metersPerUnit: 1 } as const
    expect(gaussianSourceTransform(zUp, "first-camera-c2w-v2")).toEqual(sourceTransform(zUp))
  })
})

describe("挂载/预览事实投影与清理", () => {
  test("v2 挂载：frame 与 Rx(−90) 源坐标适配一起写入 visual；v3/普通沿用默认适配", () => {
    const v2: Entity["components"] = {}
    applySplatMountFacts(resource(metadata("first-camera-c2w-v2")), v2)
    expect(v2.visual!.kind).toBe("splat")
    expect(v2.visual!.gaussianCameraFrame).toBe("first-camera-c2w-v2")
    expect(v2.visual!.sourceTransform).toEqual(gaussianSourceTransform(YUP, "first-camera-c2w-v2"))
    const plain: Entity["components"] = {}
    applySplatMountFacts(resource(metadata()), plain)
    expect(plain.visual!.gaussianCameraFrame).toBeUndefined()
    expect(plain.visual!.sourceTransform).toEqual(sourceTransform(YUP))
  })

  test("调用方显式 visualSourceTransform 优先，不被 v2 覆盖", () => {
    const explicit = { position: [1, 2, 3], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }
    const components: Entity["components"] = {}
    applySplatMountFacts(resource(metadata("first-camera-c2w-v2"), explicit), components)
    expect(components.visual!.sourceTransform).toEqual(explicit)
    // 但 frame 仍如实透传，供默认机位判断文件坐标。
    expect(components.visual!.gaussianCameraFrame).toBe("first-camera-c2w-v2")
  })

  test("换到未知/另一版本时旧 frame hint 被清掉，不继承上一版", () => {
    const visual: Record<string, unknown> = { kind: "splat", gaussianCameraFrame: "first-camera-c2w-v2", sourceBounds: { min: [0, 0, 0], max: [1, 1, 1] }, sourcePointCount: 5_418_490 }
    applySplatPreviewFacts(resource(metadata()), visual)
    expect(visual.gaussianCameraFrame).toBeUndefined()
    expect(visual.sourcePointCount).toBe(1000)
    applySplatPreviewFacts(resource(metadata("first-camera-opengl-v3")), visual)
    expect(visual.gaussianCameraFrame).toBe("first-camera-opengl-v3")
  })
})
