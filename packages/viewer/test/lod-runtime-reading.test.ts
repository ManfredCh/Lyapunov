/**
 * ENV-32「LOD 真实读数」的**运行态**测试：真 GLB（仓库真实道具 + 由它真实减面得到的派生件）、
 * 真 `setScene`、真 `updateLod`、真 `lodCaptureFace`。
 *
 * 断言四项（就是采集回执里 `lod.entries` 的那四项）：**级别 / 三角形数 / 距离 / 资源版本**，
 * 外加"比这台相机该用的级别更粗"（`coarser`）的对照——它只在**基础级不可用**时才可达
 * （`index.ts` 的 `LOD_BASE_FALLBACK`：基础件读失败 → 停在派生级；相机再靠近时 `applyBestAvailable`
 * 找不到"不粗于目标"的可用级别，于是 `level > requested`）。
 *
 * 页面侧读数通道（`viewer_capture` 的客户端载荷）需要窗口里的真实采集动作；本测试取的是同一条
 * 产品代码路径（`updateLod` + `lodCaptureFace`）在 Node 里的**API 级**读数，两者共用同一份 owner。
 *
 * 没有 WebGL：`renderer` 是"记一次 render"的替身（本测试不断言像素）。
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import * as THREE from "three"

import { SceneViewer } from "../src/index.ts"
import { FrameProjection } from "../src/projection.ts"
import type { Entity, ResourceRef, SceneSnapshot } from "../../lyapunov-contracts/src/types.ts"

;(globalThis as any).ProgressEvent ??= class { type: string; constructor(type: string) { this.type = type } }
;(globalThis as any).cancelAnimationFrame ??= () => {}
;(globalThis as any).requestAnimationFrame ??= () => 0

const BASE_PATH = new URL("../../../materials/mcp-env/assets/kenney-props/visual/prop_14_dumpster.glb", import.meta.url)
const BASE_URI = "assets/dumpster.glb"
const COARSE_URI = "assets/dumpster-coarse.glb"
const BASE_BYTES = readFileSync(BASE_PATH)
const BASE_DATA_URL = `data:model/gltf-binary;base64,${BASE_BYTES.toString("base64")}`

/**
 * 由真实基件**真的减面**：每个 primitive 的索引里保留每 2 个三角中的 1 个（234 → 117 个三角）。
 * 顶点/材质/节点结构不动，只在 BIN 末尾追加新的索引缓冲——派生件是真实可加载的 GLB。
 */
function decimate(glb: Buffer): Buffer {
  const read = (offset: number) => ({ length: glb.readUInt32LE(offset), type: glb.readUInt32LE(offset + 4), start: offset + 8 })
  const json = read(12), bin = read(json.start + json.length)
  const document = JSON.parse(glb.subarray(json.start, json.start + json.length).toString("utf8").trim())
  let binary = Buffer.from(glb.subarray(bin.start, bin.start + bin.length))
  for (const mesh of document.meshes ?? []) for (const primitive of mesh.primitives ?? []) {
    const accessor = document.accessors[primitive.indices], view = document.bufferViews[accessor.bufferView]
    const stride = view.byteStride ?? (accessor.componentType === 5123 ? 2 : 4)
    const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
    const indices: number[] = []
    for (let index = 0; index < accessor.count; index++) indices.push(accessor.componentType === 5123 ? binary.readUInt16LE(base + index * stride) : binary.readUInt32LE(base + index * stride))
    const triangles: number[][] = []
    for (let index = 0; index + 2 < indices.length; index += 3) triangles.push(indices.slice(index, index + 3))
    const kept = triangles.filter((_triangle, index) => index % 2 === 0).flat()
    const chunk = Buffer.alloc(kept.length * 2 + ((4 - (kept.length * 2) % 4) % 4))
    kept.forEach((value, index) => { chunk.writeUInt16LE(value, index * 2) })
    const offset = binary.length
    binary = Buffer.concat([binary, chunk])
    document.bufferViews.push({ buffer: view.buffer, byteOffset: offset, byteLength: chunk.length })
    document.accessors.push({ bufferView: document.bufferViews.length - 1, componentType: 5123, count: kept.length, type: "SCALAR" })
    primitive.indices = document.accessors.length - 1
  }
  document.asset.generator = "n62-test-decimated-50pct"
  document.buffers[0].byteLength = binary.length
  const payload = Buffer.from(JSON.stringify(document), "utf8")
  const padded = Buffer.concat([payload, Buffer.alloc((4 - payload.length % 4) % 4, 0x20)])
  const head = Buffer.alloc(8); head.writeUInt32LE(padded.length, 0); head.writeUInt32LE(0x4e4f534a, 4)
  const binHead = Buffer.alloc(8); binHead.writeUInt32LE(binary.length, 0); binHead.writeUInt32LE(0x004e4942, 4)
  const body = Buffer.concat([head, padded, binHead, binary])
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + body.length, 8)
  return Buffer.concat([header, body])
}

const COARSE_BYTES = decimate(BASE_BYTES)
const COARSE_DATA_URL = `data:model/gltf-binary;base64,${COARSE_BYTES.toString("base64")}`

const RESOURCE_ID = "res-dumpster"
const source = { units: "m", upAxis: "Z" as const, handedness: "right" as const, metersPerUnit: 1 }
const representation = (uri: string) => ({ uri, mimeType: "model/gltf-binary", role: "visual" })
const baseRef: ResourceRef = { resourceId: RESOURCE_ID, version: 1, source, original: representation(BASE_URI), representations: [representation(BASE_URI)] }
const levelRef: ResourceRef = { resourceId: RESOURCE_ID, version: 2, source, original: representation(COARSE_URI), representations: [representation(COARSE_URI)] }
const entity = (overrides: Partial<Entity> = {}): Entity => ({
  entityId: "dumpster", name: "垃圾箱",
  transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
  resources: [baseRef, levelRef],
  components: { visual: { kind: "mesh", lod: [{ role: "visual", minDistanceM: 5, resourceId: RESOURCE_ID, version: 2 }] } },
  ...overrides,
} as unknown as Entity)
const snapshot = (revision: number, ...entities: Entity[]): SceneSnapshot => ({ sceneId: "scene-lod", revision, coordinates: { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" }, entities })

class Harness {
  readonly renders = 0
  readonly errors: string[] = []
  readonly viewer: any
  constructor(resolve: (uri: string) => Promise<string>) {
    const viewer: any = Object.create(SceneViewer.prototype)
    viewer.cameraRigs = new Map(); viewer.cameraRigRoot = new THREE.Group()
    viewer.options = { resolveResource: resolve, onError: (error: Error) => { this.errors.push(error.message) } }
    viewer.scene = new THREE.Scene()
    viewer.scene.environmentIntensity = 1
    viewer.projection = new FrameProjection()
    // `extensions` 是渲染器的压缩纹理能力口径：KTX2 的转码目标由它决定（`ktx2-decoder.ts` 的
    // `detectKtx2Support(renderer)` 读 `extensions.has/get`）。这个替身如实报「没有任何压缩纹理扩展」。
    viewer.renderer = { extensions: { has: () => false, get: () => ({ getSupportedProfiles: () => [] }) }, toneMappingExposure: 1, shadowMap: { enabled: false, type: 0 }, render: () => { (this as { renders: number }).renders++ }, compile: () => {}, dispose: () => {}, info: { memory: { geometries: 0, textures: 0 }, render: { triangles: 0, calls: 0 }, programs: [] }, domElement: { getBoundingClientRect: () => ({ width: 0, height: 0 }), width: 0, height: 0, toDataURL: () => "data:image/png;base64,AAAA", remove: () => {}, removeEventListener: () => {} } }
    viewer.controls = { target: new THREE.Vector3(), update: () => {}, dispose: () => {} }
    viewer.camera = new THREE.PerspectiveCamera()
    viewer.materialEnvironment = { texture: new THREE.Texture(), dispose: () => {} }
    viewer.grid = new THREE.Object3D(); viewer.axes = new THREE.Object3D()
    viewer.hemisphere = new THREE.HemisphereLight(0xe7efff, 0x47515c, 2.4)
    viewer.sun = new THREE.DirectionalLight(0xffffff, 3)
    viewer.environmentClock = { playing: false, offsetHours: 0, advancedSeconds: 0 }
    viewer.environmentDiagnostics = []; viewer.sunDistance = 50; viewer.backgroundDaylight = 1
    viewer.geometryRevision = 1; viewer.annotations = []; viewer.markers = new Map(); viewer.annotationRoot = new THREE.Group()
    viewer.objects = new Map(); viewer.gltfs = new Map(); viewer.gltfStats = new Map(); viewer.mixers = new Map()
    viewer.lodSwitches = 0; viewer.lodProbe = new THREE.Vector3(); viewer.lodCamera = new THREE.Vector3()
    viewer.splatBounds = new WeakMap(); viewer.loadingErrors = new Map(); viewer.visualWarnings = new Map()
    viewer.display = { grid: true, axes: true, background: "#121a24", wireframe: false, splats: true, collision: false }
    viewer.disposed = false; viewer.generation = 0; viewer.snapshot = undefined; viewer.world = undefined
    viewer.sceneLightsVisible = true; viewer.animationClock = 0; viewer.selected = undefined
    viewer.raf = 0; viewer.resize = { disconnect: () => {} }; viewer.transformControls = { attach: () => {}, detach: () => {}, dispose: () => {} }
    viewer.placeMarker = undefined; viewer.preview = undefined
    this.viewer = viewer
  }
}

/** 等这一次级别加载/回退跑完（`lod.pending` 是产品自己的在途标记）。 */
async function settle(viewer: any, entityId = "dumpster", timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lod = viewer.objects.get(entityId)?.lod
    if (lod && lod.pending === undefined && (lod.levels.size > 0 || lod.lodWarnings?.length || lod.current !== -1 || viewer.objects.get(entityId).lodWarnings?.includes("LOD_SKIPPED_ANIMATED"))) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const reading = (viewer: any, entityId = "dumpster") => (viewer.lodCaptureFace("window") as { planned: number; camera: string; entries: Array<Record<string, unknown>>; skipped: Array<Record<string, unknown>> }).entries.find(entry => entry.entityId === entityId)

describe("LOD 运行态真实读数（真 GLB + 真 updateLod + 真 lodCaptureFace）", () => {
  test("远/近两个距离：级别、三角形数、距离、资源版本四项都来自回执；正常简化与基础件对照", async () => {
    const harness = new Harness(uri => uri === BASE_URI ? Promise.resolve(BASE_DATA_URL) : uri === COARSE_URI ? Promise.resolve(COARSE_DATA_URL) : Promise.reject(new Error(`NO_RESOURCE_READ: ${uri}`)))
    const viewer = harness.viewer
    await viewer.setScene(snapshot(1, entity()))
    await settle(viewer)
    expect(harness.errors).toEqual([])

    // 相机位置按**产品自己的距离参照点**摆：`lod.anchorLocal` 经实体世界矩阵变换后的那个锚点。
    const loaded = viewer.objects.get("dumpster")
    const anchor = new THREE.Vector3().copy(loaded.lod.anchorLocal).applyMatrix4(loaded.group.matrixWorld)
    const place = (distance: number) => { viewer.camera.position.copy(anchor).add(new THREE.Vector3(distance, 0, 0)); viewer.camera.updateMatrixWorld(true) }

    // 近：相机 1 m —— 该用基础件（级别 -1），234 个三角，资源版本 v1。
    place(1)
    viewer.updateLod(viewer.camera, { settle: true })
    const near = reading(viewer)
    console.log(`[N62] LOD 近景读数=${JSON.stringify(near)}`)
    expect(near!.level).toBe(-1)
    expect(near!.requested).toBe(-1)
    expect(near!.simplified).toBe(false)
    expect(near!.resource).toBe(`${RESOURCE_ID}@1`)
    expect(near!.triangles).toBe(234)
    expect(Number(near!.distanceM)).toBeCloseTo(1, 1)
    expect(near!.coarser).toBeUndefined()

    // 远：相机 30 m —— 该用派生级（级别 0），117 个三角，资源版本 v2。
    place(30)
    viewer.updateLod(viewer.camera, { settle: true })
    await settle(viewer)
    viewer.updateLod(viewer.camera, { settle: true })
    const far = reading(viewer)
    console.log(`[N62] LOD 远景读数=${JSON.stringify(far)}`)
    expect(far!.level).toBe(0)
    expect(far!.requested).toBe(0)
    expect(far!.simplified).toBe(true)
    expect(far!.resource).toBe(`${RESOURCE_ID}@2`)
    expect(far!.triangles).toBe(117)
    expect(Number(far!.distanceM)).toBeCloseTo(30, 0)
    expect(near!.triangles).not.toBe(far!.triangles)

    // 回近处：必须切回基础件（不是"停在远景的粗级别"）。
    place(1)
    viewer.updateLod(viewer.camera, { settle: true })
    const back = reading(viewer)
    expect(back!.level).toBe(-1)
    expect(back!.resource).toBe(`${RESOURCE_ID}@1`)
    viewer.dispose()
  })

  test("负对照：基础级读不到时停在派生级，相机靠近 → 回执带 coarser=true（比该用的级别更粗）", async () => {
    // 基础件那条 URI 故意不可读（读失败），派生级可读：走的就是 LOD_BASE_FALLBACK。
    const harness = new Harness(uri => uri === COARSE_URI ? Promise.resolve(COARSE_DATA_URL) : Promise.reject(new Error(`NO_RESOURCE_READ: ${uri}`)))
    const viewer = harness.viewer
    await viewer.setScene(snapshot(1, entity()))
    await settle(viewer)
    const loaded = viewer.objects.get("dumpster")
    expect(loaded.lodWarnings.some((warning: string) => warning.startsWith("LOD_BASE_FALLBACK"))).toBe(true)
    expect(loaded.lod.current).toBe(0)

    // 相机 1 m：这台相机该用级别 -1（基础件），但基础件不可用 ⇒ 只能显示 0 级，比该用的更粗。
    viewer.camera.position.set(1, 0, 0)
    viewer.camera.updateMatrixWorld(true)
    viewer.updateLod(viewer.camera, { settle: true })
    const degraded = reading(viewer)
    console.log(`[N62] LOD 降级读数=${JSON.stringify(degraded)} warnings=${JSON.stringify(loaded.lodWarnings)}`)
    expect(degraded!.level).toBe(0)
    expect(degraded!.requested).toBe(-1)
    expect(degraded!.coarser).toBe(true)
    expect(degraded!.resource).toBe(`${RESOURCE_ID}@2`)
    expect(degraded!.triangles).toBe(117)
    expect(Number(degraded!.distanceM)).toBeCloseTo(1, 1)
    viewer.dispose()
  })
})
