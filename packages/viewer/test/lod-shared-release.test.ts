/**
 * **共享可视对象的释放归属**（95 号点 1 的窄测试）：真资源、真 `setScene`、真 `release`/`dispose`。
 *
 * 要钉死的是四件事（都问产品代码，而不是问测试自己写的记账）：
 *  1. 同一个资源被多个实体引用时，Viewer 的 GLTF 缓存只解析一次，实例之间**共用同一批 geometry/material**
 *     （three 的 `clone` 只复制节点）；
 *  2. 删掉**其中一个**实例（真实 `setScene` 的增量路径 → `release()`）**不会**释放仍被别的实例使用的
 *     geometry/material——否则还在画面上的那个实体会带着已销毁的 GPU 资源；
 *  3. 该实例**自己的**非共享部件（机器人网格/碰撞线框/LOD 换下来的派生对象这一类）随它离开画面释放**一次**；
 *  4. 缓存里那份 GLTF 是这批几何/材质/贴图的**唯一所有者**：只有 `viewer.dispose()` 才释放它，
 *     且**恰好一次**（含"读取在途时 Viewer 已销毁"的那条路——它解析出来的东西没人会用，留着就是泄漏）。
 *
 * 用**真 GLB 文件**（仓库里的 `materials/mcp-env/assets/kenney-props/...`）走真实 `GLTFLoader`：
 * 共享的是真的解析结果，不是测试拼的一棵树。没有 WebGL 上下文，所以 `renderer` 只是"记一次 render"
 * 的替身（本测试不断言像素——像素归 `harness/` 的真实浏览器验收管）。
 *
 * 用法：`bun test packages/viewer/test/lod-shared-release.test.ts`
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import * as THREE from "three"

import { SceneViewer } from "../src/index.ts"
import { FrameProjection } from "../src/projection.ts"
import type { Entity, SceneSnapshot } from "../../lyapunov-contracts/src/types.ts"

/** three 的 FileLoader 在 bun 里会构造 `ProgressEvent`（浏览器对象，Node 侧没有）：运行环境补齐，不是替身。 */
;(globalThis as any).ProgressEvent ??= class { type: string; constructor(type: string) { this.type = type } }
// 渲染循环的调度器同样是**运行环境**的（浏览器原生、Node 里没有）；`dispose()` 会取消它。
;(globalThis as any).cancelAnimationFrame ??= () => {}
;(globalThis as any).requestAnimationFrame ??= () => 0

const MODEL_PATH = new URL("../../../materials/mcp-env/assets/kenney-props/visual/prop_13_construction-cone.glb", import.meta.url)
const MODEL_PATH_2 = new URL("../../../materials/mcp-env/assets/kenney-props/visual/prop_10_traffic-light.glb", import.meta.url)
const MODEL_URI = "assets/cone.glb"
const MODEL_URI_2 = "assets/traffic-light.glb"
const MODEL_DATA_URL = `data:model/gltf-binary;base64,${readFileSync(MODEL_PATH).toString("base64")}`
const MODEL_DATA_URL_2 = `data:model/gltf-binary;base64,${readFileSync(MODEL_PATH_2).toString("base64")}`

const transform = (x: number) => ({ position: [x, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }) as const
const source = { units: "m", upAxis: "Z" as const, handedness: "right" as const, metersPerUnit: 1 }
const ref = { resourceId: "cone-1", version: 1, source, original: { uri: MODEL_URI, mimeType: "model/gltf-binary" }, representations: [{ uri: MODEL_URI, mimeType: "model/gltf-binary" }] }
/** 同一个资源版本的两个实体（盆栽/栏杆这类"同一份资产摆很多份"就是它）。 */
const instance = (entityId: string, x: number) => ({ entityId, name: entityId, transform: transform(x), components: { visual: { kind: "mesh" } }, resources: [ref] }) as unknown as Entity
const snapshot = (revision: number, ...entities: Entity[]): SceneSnapshot => ({ sceneId: "scene-shared", revision, coordinates: { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" }, entities })

/** 只补 `setScene`/`loadGltfObject`/`release`/`dispose` 真正读到的字段（与 shell 侧 BareViewer 同一条纪律）。 */
class Harness {
  readonly renders = 0
  readonly errors: string[] = []
  readonly viewer: any
  constructor() {
    const viewer: any = Object.create(SceneViewer.prototype)
    viewer.cameraRigs = new Map(); viewer.cameraRigRoot = new THREE.Group()
    viewer.options = { resolveResource: (uri: string) => uri === MODEL_URI ? Promise.resolve(MODEL_DATA_URL) : uri === MODEL_URI_2 ? Promise.resolve(MODEL_DATA_URL_2) : Promise.reject(new Error(`NO_RESOURCE_READ: ${uri}`)), onError: (error: Error) => { this.errors.push(error.message) } }
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
  /** 实体组里所有的网格（真实 `loadVisual` 挂上去的那一棵）。 */
  meshes(entityId: string): THREE.Mesh[] {
    const found: THREE.Mesh[] = []
    this.viewer.objects.get(entityId)?.group.traverse((object: THREE.Object3D) => { if (object instanceof THREE.Mesh) found.push(object) })
    return found
  }
}

/** 给几何/材质装一个 dispose 计数器（幂等性由 three 保证，这里数的是"被要求释放了几次"）。 */
function countDisposals(target: { dispose: () => void }): { count: number } {
  const counter = { count: 0 }
  const original = target.dispose.bind(target)
  target.dispose = () => { counter.count++; original() }
  return counter
}

describe("共享资源的释放归属（真 GLB + 真 setScene/release/dispose）", () => {
  test("两个实例共用同一批 geometry/material；删掉一个不释放它们；销毁 Viewer 才释放一次", async () => {
    const harness = new Harness()
    await harness.viewer.setScene(snapshot(1, instance("pot-a", 0), instance("pot-b", 2)))
    const [meshA] = harness.meshes("pot-a"), [meshB] = harness.meshes("pot-b")
    expect(harness.errors).toEqual([])
    expect(meshA && meshB).toBeTruthy()
    // 1) 缓存只解析一次，实例之间共用同一批几何/材质（three 的 clone 只复制节点）。
    expect(meshA!.geometry).toBe(meshB!.geometry)
    expect(meshA!.material).toBe(meshB!.material)
    expect(harness.viewer.gltfs.size).toBe(1)
    expect([...harness.viewer.gltfStats.values()]).toEqual([{ loads: 1, hits: 1 }])

    const geometry = countDisposals(meshA!.geometry)
    const material = countDisposals(meshA!.material as THREE.Material)

    // 2) 真实换场景：新快照里只剩 pot-b ⇒ pot-a 走 `release()` 离开画面。
    await harness.viewer.setScene(snapshot(2, instance("pot-b", 2)))
    expect(harness.viewer.objects.has("pot-a")).toBe(false)
    expect(geometry.count).toBe(0)
    expect(material.count).toBe(0)
    // 留下来的那个实例仍带着同一批几何/材质，画面还能继续渲染（没有已销毁的资源）。
    const [stillThere] = harness.meshes("pot-b")
    expect(stillThere!.geometry).toBe(meshA!.geometry)
    expect(stillThere!.material).toBe(meshA!.material)
    harness.viewer.renderer.render(harness.viewer.scene, harness.viewer.camera)
    expect(harness.renders).toBe(1)
    // 缓存里的那份 GLTF 还是同一个（owner 没被谁顺手扔掉）。
    expect(harness.viewer.gltfs.size).toBe(1)

    // 4) 只有 Viewer 销毁才释放 owner，而且恰好一次。
    const texture = (meshA!.material as THREE.MeshStandardMaterial).map
    const textureCounter = texture ? countDisposals(texture) : undefined
    harness.viewer.dispose()
    await Promise.resolve() // 释放 owner 走的是缓存 promise 的收尾（微任务），等它跑完再看数
    expect(geometry.count).toBe(1)
    expect(material.count).toBe(1)
    if (textureCounter) expect(textureCounter.count).toBe(1)
    expect(harness.viewer.gltfs.size).toBe(0)
    expect(harness.viewer.gltfStats.size).toBe(0)
    expect(harness.viewer.objects.size).toBe(0)
  })

  test("实例自己的非共享部件随它离开画面释放一次（共享的那批仍然不动）", async () => {
    const harness = new Harness()
    await harness.viewer.setScene(snapshot(1, instance("pot-a", 0), instance("pot-b", 2)))
    const [meshA] = harness.meshes("pot-a")
    const geometry = countDisposals(meshA!.geometry)
    // 与产品在实体组下挂"机器人网格 / 碰撞线框 / LOD 换下来的派生对象"是同一类东西：
    // 不带 `userData.sharedVisual` 标记 ⇒ 归这个实体所有，随它一起释放。产品从机器人/碰撞资源里
    // 造这类对象要走 MJCF 装订，这条窄测试不加载那些资源，所以由测试挂一个同样形状的部件。
    const own = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())
    harness.viewer.objects.get("pot-a").group.add(own)
    const ownGeometry = countDisposals(own.geometry)
    const ownMaterial = countDisposals(own.material as THREE.Material)

    await harness.viewer.setScene(snapshot(2, instance("pot-b", 2)))
    expect(ownGeometry.count).toBe(1)
    expect(ownMaterial.count).toBe(1)
    // 同一次 `release()` 里，共享的那批一次都没被碰。
    expect(geometry.count).toBe(0)
    expect(harness.viewer.objects.has("pot-b")).toBe(true)
    harness.viewer.dispose()
  })

  test("读取在途时 Viewer 就被销毁：解析出来的几何照样被释放（不泄漏）", async () => {
    // 真的在途：GLB 的字节停在网络上，由测试决定什么时候放行（这就是"用户关窗口时资源刚好读完"）。
    const bytes = readFileSync(MODEL_PATH)
    let reached: (() => void) | undefined
    const arrived = new Promise<void>(resolve => { reached = resolve })
    let respond: (() => void) | undefined
    const server = createServer((_request, response) => {
      respond = () => { response.writeHead(200, { "content-type": "model/gltf-binary" }); response.end(bytes) }
      reached?.()
    })
    await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve) })
    const port = (server.address() as AddressInfo).port
    try {
      const harness = new Harness()
      harness.viewer.options.resolveResource = () => Promise.resolve(`http://127.0.0.1:${String(port)}/cone.glb`)
      const pending = harness.viewer.setScene(snapshot(1, instance("pot-a", 0)))
      await arrived
      // 读取已经发出、还没回来：缓存里就是这份在途的 promise（销毁的收尾认它）。
      const [inFlight] = [...harness.viewer.gltfs.values()]
      expect(inFlight).toBeTruthy()
      harness.viewer.dispose()
      const disposed = new Set<THREE.BufferGeometry>()
      const originalDispose = THREE.BufferGeometry.prototype.dispose
      THREE.BufferGeometry.prototype.dispose = function (this: THREE.BufferGeometry) { disposed.add(this); return originalDispose.call(this) }
      try {
        respond!()
        const gltf = await inFlight!
        await pending.catch(() => undefined)
        // 解析出来的每一份几何都被释放了（在途那份没有第二个人会用），且没挂到已销毁的 Viewer 上。
        const geometries: THREE.BufferGeometry[] = []
        gltf.scene.traverse((node: THREE.Object3D) => { if (node instanceof THREE.Mesh && node.geometry) geometries.push(node.geometry) })
        expect(geometries.length).toBeGreaterThan(0)
        expect(geometries.every(geometry => disposed.has(geometry))).toBe(true)
        expect(harness.viewer.objects.size).toBe(0)
        expect(harness.viewer.gltfs.size).toBe(0)
      } finally { THREE.BufferGeometry.prototype.dispose = originalDispose }
    } finally { server.close() }
  })

  test("资源解析还没回来就关窗：不再开始新读取（免得解析出一份没人释放的）", async () => {
    const harness = new Harness()
    let deliver: (() => void) | undefined
    harness.viewer.options.resolveResource = () => new Promise<string>(resolve => { deliver = () => { resolve(MODEL_DATA_URL) } })
    const pending = harness.viewer.setScene(snapshot(1, instance("pot-a", 0)))
    harness.viewer.dispose()
    deliver!()
    await pending.catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 50))
    // 这条路上压根没有开始读 GLB：缓存/读数/画面都空着，也没有谁把"销毁了还去读"报成错误。
    expect(harness.viewer.gltfStats.size).toBe(0)
    expect(harness.viewer.gltfs.size).toBe(0)
    expect(harness.viewer.objects.size).toBe(0)
    expect(harness.errors).toEqual([])
  })
})

/**
 * ENV-32「共享几何/贴图」的**计数读数**：`resourceReport`（`packages/viewer/src/index.ts:1891`）是产品
 * 自己对"取了几次、命中几次、现在有几份几何/材质/贴图"的读数，这里直接断言它，而不是测试自记账。
 */
describe("共享几何/贴图的计数读数（真 GLB + 真 resourceReport）", () => {
  const shared = (entityId: string, x: number) => instance(entityId, x)
  const otherVersion = (entityId: string, x: number) => ({
    entityId, name: entityId, transform: transform(x), components: { visual: { kind: "mesh" } },
    resources: [{ ...ref, resourceId: "cone-2", version: 2, original: { uri: MODEL_URI_2, mimeType: "model/gltf-binary" }, representations: [{ uri: MODEL_URI_2, mimeType: "model/gltf-binary" }] }],
  }) as unknown as Entity
  const geometryIds = (harness: Harness, entityId: string) => new Set(harness.meshes(entityId).map(mesh => mesh.geometry.uuid))

  test("同一 resourceId@version 的两个实体：loads=1、cacheHits=1、两个实例共用同一批几何 UUID", async () => {
    const harness = new Harness()
    await harness.viewer.setScene(snapshot(1, shared("pot-a", 0), shared("pot-b", 2)))
    const report = harness.viewer.resourceReport
    console.log(`[N62] 同资源两实体 resourceReport=${JSON.stringify({ ...report, urls: report.urls.map((entry: { url: string; loads: number; hits: number }) => ({ url: `${entry.url.slice(0, 24)}…`, loads: entry.loads, hits: entry.hits })) })}`)
    expect(harness.errors).toEqual([])
    expect(report.loads).toBe(1)
    expect(report.cacheHits).toBe(1)
    expect(report.urls).toEqual([{ url: MODEL_DATA_URL, loads: 1, hits: 1 }])
    expect(harness.viewer.gltfs.size).toBe(1)
    // 两个实体上的几何是**同一个对象**（同一批 UUID），且就是读数里那几份几何。
    const a = geometryIds(harness, "pot-a"), b = geometryIds(harness, "pot-b")
    expect(a.size).toBeGreaterThan(0)
    expect([...a].sort()).toEqual([...b].sort())
    expect(a.size).toBe(report.geometries)
    expect(report.meshes).toBe(2)
    harness.viewer.dispose()
  })

  test("负对照：两个不同资源版本 → loads=2、两条 URL、几何不共享", async () => {
    const harness = new Harness()
    await harness.viewer.setScene(snapshot(1, shared("pot-a", 0), otherVersion("pot-b", 2)))
    const report = harness.viewer.resourceReport
    console.log(`[N62] 两资源各一份 resourceReport=${JSON.stringify({ ...report, urls: report.urls.map((entry: { url: string; loads: number; hits: number }) => ({ url: `${entry.url.slice(0, 24)}…`, loads: entry.loads, hits: entry.hits })) })}`)
    expect(harness.errors).toEqual([])
    expect(report.loads).toBe(2)
    expect(report.cacheHits).toBe(0)
    expect(report.urls.map((entry: { url: string }) => entry.url).sort()).toEqual([MODEL_DATA_URL, MODEL_DATA_URL_2].sort())
    expect(harness.viewer.gltfs.size).toBe(2)
    const a = [...geometryIds(harness, "pot-a")], b = [...geometryIds(harness, "pot-b")]
    expect(a.length).toBeGreaterThan(0)
    expect(b.length).toBeGreaterThan(0)
    expect(b.some(uuid => a.includes(uuid))).toBe(false)
    harness.viewer.dispose()
  })
})
