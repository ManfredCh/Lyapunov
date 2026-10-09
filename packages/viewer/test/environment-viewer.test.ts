/**
 * 环境光照**落到 Viewer 上**的装配测试：`entity.components.environment` → 曝光/IBL/半球/太阳/背景/阴影，
 * 以及 HDRI 的加载-归属-失败-重试生命周期。
 *
 * 用的是**产品源码本身**（`packages/viewer/src/index.ts`）：`Object.create(SceneViewer.prototype)` +
 * Viewer 本来就有的注入点 `options.resolveResource`（沿用 `packages/lyapunov-shell/test/viewer-observe.ts`
 * 的 BareViewer 做法——`SceneViewer` 的构造函数要真实 WebGL，这个进程里没有）。
 * 于是下面每一条断言都由真代码回答：
 *  · "没有环境组件的旧场景读数是否仍是改造前那组"（不让历史画面被静默改光照）；
 *  · "组件里的值有没有真的写到 renderer/scene/两盏灯上"；
 *  · "昼夜播放有没有碰 projection/snapshot"（渲染时间与物理时间分离）；
 *  · "HDRI 资源缺失/读取失败/迟到结果"分别留下什么状态。
 *
 * 这里**不测像素**：PMREM 需要真实 WebGL，本进程没有（下面的迟到结果用例能在 PMREM 之前就返回，
 * 正因为它走的是归属核对那条提前返回路径）。真实 HDRI 的纹理尺寸与画面由 `script/gates` 的真实浏览器
 * 验收负责（见 REPORT.md）。
 *
 * 用法：`bun test packages/viewer/test/environment-viewer.test.ts`
 */
import { describe, expect, test } from "bun:test"
import * as THREE from "three"
import { TransformControls } from "three/addons/controls/TransformControls.js"

import { SceneViewer } from "../src/index.ts"
import { FrameProjection } from "../src/projection.ts"
import { ENVIRONMENT_COMPONENT_KEY, ENVIRONMENT_KIND } from "../src/environment.ts"
import type { Entity, SceneSnapshot } from "../../lyapunov-contracts/src/types.ts"
import { EntityMaterialOverride, parseMaterialOverride, MATERIAL_OVERRIDE_KIND } from "../src/material-override.ts"
import { buildSceneLight } from "../src/scene-light.ts"

/**
 * three 的 FileLoader 在 bun 里会构造 `ProgressEvent`（浏览器对象，Node 侧没有）。
 * 这是**运行环境的补齐**，不是产品行为的替身：真实浏览器里它是原生的。
 */
;(globalThis as any).ProgressEvent ??= class { type: string; constructor(type: string) { this.type = type } }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
/** `setScene` 要跑过实体加载那一轮 await 才轮到 HDRI 读取：等它真的发起，而不是猜几次微任务。 */
const until = async (predicate: () => boolean, what: string, timeout = 2000) => {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`TIMEOUT: ${what}`)
    await sleep(5)
  }
}

/**
 * 本进程没有 WebGL。PMREM 的最后一跳（真把等距柱面投影烘成 cubeUV）是**渲染器行为**，
 * 这里替换的只有那一跳，产品逻辑（归属核对、精确版本比对、迟到结果丢弃）照原样执行；
 * 真实 PMREM 的像素结果由 `packages/lyapunov-shell/test/environment-lighting-live.ts`
 * 在真 Chrome + SwiftShader 里用一张真 4K HDRI 验证。返回恢复函数。
 */
function stubPmrem(): () => void {
  const original = THREE.PMREMGenerator.prototype.fromEquirectangular
  THREE.PMREMGenerator.prototype.fromEquirectangular = function (this: THREE.PMREMGenerator) {
    return { texture: new THREE.Texture(), dispose() { /* 测试替身没有 GPU 资源 */ } } as unknown as THREE.WebGLRenderTarget
  }
  return () => { THREE.PMREMGenerator.prototype.fromEquirectangular = original }
}

/** 手写一个 2×2 的 **真实 Radiance 文件**（宽度 < 8 时 HDRLoader 走 flat 分支，不需要 RLE）。
 *  用真文件而不是假 texture：`loadAsync` 会真的走 FileLoader→fetch(data: URL)→RGBE 解析。 */
function radianceFile(values: number[]): string {
  const header = Buffer.from("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 2\n", "latin1")
  const pixels = new Uint8Array(values.length * 4)
  values.forEach((value, index) => {
    const exponent = value > 0 ? Math.max(128, Math.floor(Math.log2(value)) + 128) : 0
    const scale = exponent ? Math.pow(2, exponent - 128) / 256 : 0
    for (let channel = 0; channel < 3; channel++) pixels[index * 4 + channel] = Math.min(255, Math.round(value / scale))
    pixels[index * 4 + 3] = exponent
  })
  const bytes = new Uint8Array(header.length + pixels.length)
  bytes.set(header, 0); bytes.set(pixels, header.length)
  return `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`
}

const HDRI_URI = "assets/sky.hdr"
/** 第二张天空（换图在途用）：同一个实体上的另一条资源，和第一张是两个文件。 */
const HDRI_URI_B = "assets/sky-b.hdr"
const transform = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] } as const
const source = { units: "m", upAxis: "Z" as const, handedness: "right" as const, metersPerUnit: 1 }
const hdriRef = { resourceId: "sky-1", version: 1, source, original: { uri: HDRI_URI, mimeType: "image/vnd.radiance", }, representations: [{ uri: HDRI_URI, mimeType: "image/vnd.radiance", }] }
const hdriRef2 = { resourceId: "sky-2", version: 1, source, original: { uri: HDRI_URI_B, mimeType: "image/vnd.radiance", }, representations: [{ uri: HDRI_URI_B, mimeType: "image/vnd.radiance", }] }
const glbRef = { resourceId: "plant-1", version: 1, source, original: { uri: "assets/plant.glb", mimeType: "model/gltf-binary", }, representations: [{ uri: "assets/plant.glb", mimeType: "model/gltf-binary", }] }

/** 承载环境光照的实体：`visual.kind === "source"` 表示"它只是一条记录"（不产生几何）。 */
const carrier = (component: Record<string, unknown>, resources: Entity["resources"] = []) =>
  ({ entityId: "lighting", name: "lighting", parentId: undefined, transform, components: { visual: { kind: "source" }, [ENVIRONMENT_COMPONENT_KEY]: component }, resources }) as unknown as Entity
/** 不加载任何资源的实体（`visual.kind === "group"`）：用来测环境路径而不牵扯模型加载。 */
const plainEntity = () =>
  ({ entityId: "empty", name: "empty", parentId: undefined, transform, components: { visual: { kind: "group" } }, resources: [] }) as unknown as Entity
/** 一个普通网格实体：用来验证阴影开关有没有真的落到 mesh 的 castShadow/receiveShadow 上。 */
const meshEntity = () =>
  ({ entityId: "plant", name: "plant", parentId: undefined, transform, components: { visual: { kind: "mesh" } }, resources: [glbRef] }) as unknown as Entity

const snapshot = (revision: number, ...entities: Entity[]): SceneSnapshot =>
  ({ sceneId: "scene-env", revision, coordinates: { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" }, entities })

/** 只补 `setScene`/环境路径真正读到的字段；缺的都在这里显式写出来（不是我猜的默认值）。 */
class BareViewer {
  readonly reads: Array<{ uri: string; deliver: (url: string) => void; fail: (error: Error) => void }> = []
  readStarts = 0
  readonly errors: string[] = []
  readonly viewer: any
  constructor() {
    const viewer: any = Object.create(SceneViewer.prototype)
    viewer.options = {
      resolveResource: (uri: string) => new Promise<string>((deliver, fail) => { this.readStarts++; this.reads.push({ uri, deliver, fail }) }),
      onError: (error: Error) => { this.errors.push(error.message) },
    }
    viewer.scene = new THREE.Scene()
    // Object.create不运行构造字段；setScene使用真实相机投影，因此显式补同一个相机根。
    viewer.cameraRigs = new Map()
    viewer.cameraRigRoot = new THREE.Group()
    viewer.scene.add(viewer.cameraRigRoot)
    viewer.scene.environmentIntensity = 1
    viewer.projection = new FrameProjection()
    viewer.renderer = {
      toneMappingExposure: 1, shadowMap: { enabled: false, type: 0 },
      // render/compile 是渲染器行为（本进程没有 WebGL）；capture() 的同步 render 与 PMREM 构造会用到。
      render: () => {}, compile: () => {},
      domElement: { getBoundingClientRect: () => ({ width: 0, height: 0 }), width: 0, height: 0, toDataURL: () => "data:image/png;base64,AAAA" },
    }
    viewer.controls = { target: new THREE.Vector3(), update: () => {} }
    viewer.camera = new THREE.PerspectiveCamera()
    viewer.transformControls = new TransformControls(viewer.camera)
    viewer.materialEnvironment = { texture: new THREE.Texture() }
    viewer.grid = new THREE.Object3D()
    viewer.axes = new THREE.Object3D()
    viewer.hemisphere = new THREE.HemisphereLight(0xe7efff, 0x47515c, 2.4)
    viewer.sun = new THREE.DirectionalLight(0xffffff, 3)
    viewer.environmentClock = { playing: false, offsetHours: 0, advancedSeconds: 0 }
    viewer.environmentDiagnostics = []
    viewer.sunDistance = 50
    viewer.backgroundDaylight = 1
    viewer.geometryRevision = 1
    viewer.annotations = []
    viewer.markers = new Map()
    viewer.objects = new Map()
    viewer.gltfs = new Map()
    // LOD/共享缓存那几个字段：`Object.create` 不会跑字段初始化器，这里显式补上（与上面同一条纪律）。
    viewer.gltfStats = new Map()
    viewer.lodSwitches = 0
    viewer.lodProbe = new THREE.Vector3()
    viewer.lodCamera = new THREE.Vector3()
    viewer.mixers = new Map()
    viewer.splatBounds = new WeakMap()
    viewer.loadingErrors = new Map()
    viewer.visualWarnings = new Map()
    viewer.display = { grid: true, axes: true, background: "#121a24", wireframe: false, splats: true, collision: false }
    viewer.disposed = false
    viewer.generation = 0
    viewer.snapshot = undefined
    viewer.world = undefined
    viewer.sceneLightsVisible = true
    viewer.animationClock = 0
    viewer.selected = undefined
    this.viewer = viewer
  }
  /** 交付真实的 GLB（`gltfs` 是 Viewer 自己的缓存表，塞一棵能挂上去的树即可，不解析真几何）。 */
  deliverModel(uri: string) {
    const model = new THREE.Group()
    model.name = "plant-model"
    model.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial()))
    this.viewer.gltfs.set(uri, Promise.resolve({ scene: model, animations: [] }))
    this.takeRead(uri, "交付").deliver(uri)
  }
  deliverHdri(uri: string, values = [0.5, 0.5, 1, 0.5]) { this.takeRead(uri, "交付").deliver(radianceFile(Array(4).fill(values[0]))) }
  failRead(uri: string, reason: string) { this.takeRead(uri, "失败").fail(new Error(reason)) }
  private takeRead(uri: string, action: string) {
    const index = this.reads.findIndex(read => read.uri === uri)
    const read = index < 0 ? undefined : this.reads.splice(index, 1)[0]
    if (!read) throw new Error(`NO_RESOURCE_READ: 没有在途的资源读取可以${action}（uri=${uri}；在途=${this.reads.map(item => item.uri).join("、") || "无"}）`)
    return read
  }
  get status() { return this.viewer.environmentStatus() }
}

describe("没有环境组件的场景：读数与改造前一致", () => {
  test("曝光/IBL/半球/太阳方向都还是那组硬编码值，且不产生任何资源读取", async () => {
    const harness = new BareViewer()
    await harness.viewer.setScene(snapshot(1, plainEntity()))
    // 场景里没有环境组件 ⇒ 不读任何资源（载体实体也只有一条 visual.kind==="source" 的记录，不加载几何）
    expect(harness.readStarts).toBe(0)
    const status = harness.status
    expect(status.component).toBeUndefined()
    expect(status.carrier).toBeUndefined()
    expect(status.environmentSource).toBe("builtin")
    expect(status.exposure).toBe(1)
    expect(status.environmentIntensity).toBe(0.7)
    expect(status.hemisphereIntensity).toBe(2.4)
    expect(status.shadows).toBe(false)
    expect(harness.viewer.renderer.shadowMap.enabled).toBe(false)
    expect(status.background).toBe("color")
    expect(status.colorBackground).toBe("#121a24")
    expect((harness.viewer.scene.background as THREE.Color).getHexString()).toBe("121a24")
    expect(harness.viewer.scene.environment).toBe(harness.viewer.materialEnvironment.texture)
    expect(harness.viewer.sun.intensity).toBe(3)
    expect(harness.viewer.sun.position.toArray()).toEqual([5 * 50, -4 * 50, 8 * 50].map(value => value / 1))
    expect(status.ignored).toEqual([])
    expect(status.warnings).toEqual([])
    expect(status.hdriMimeTypes).toEqual(["image/vnd.radiance", "image/x-exr"])
  })

  test("没有组件时昼夜开关如实拒绝，不开一条看起来在播的空转路径", async () => {
    const harness = new BareViewer()
    await harness.viewer.setScene(snapshot(1, plainEntity(), carrier({ kind: ENVIRONMENT_KIND })))
    expect(harness.viewer.setDayNightPlaying(true)).toEqual({ playing: false })
    expect(harness.status.clock.playing).toBe(false)
    const before = harness.status.timeHours
    harness.viewer.advanceDayNight()
    await sleep(30)
    harness.viewer.advanceDayNight()
    expect(harness.status.timeHours).toBe(before)
    expect(harness.status.clock.advancedSeconds).toBe(0)
  })

  test("新场景写入组件后读数跟着变；删掉组件（旧版场景）立刻回到内置光照", async () => {
    const harness = new BareViewer()
    await harness.viewer.setScene(snapshot(1, plainEntity()))
    await harness.viewer.setScene(snapshot(2, plainEntity(), carrier({ kind: ENVIRONMENT_KIND, exposure: 2.5, environmentIntensity: 3, hemisphereIntensity: 0.5 })))
    expect(harness.status.carrier).toBe("lighting")
    expect(harness.status.exposure).toBe(2.5)
    expect(harness.status.environmentIntensity).toBe(3)
    expect(harness.status.hemisphereIntensity).toBe(0.5)
    await harness.viewer.setScene(snapshot(3, plainEntity()))
    expect(harness.status.component).toBeUndefined()
    expect(harness.status.exposure).toBe(1)
    expect(harness.status.environmentIntensity).toBe(0.7)
    expect(harness.status.hemisphereIntensity).toBe(2.4)
  })
})

describe("组件生效：值真的写到了渲染对象上", () => {
  test("色调映射和 XYZ 环境方向写到原 renderer/Scene；阴影质量重建旧贴图并保实值",async()=>{
    const harness=new BareViewer(),v=harness.viewer
    const variants={aces:THREE.ACESFilmicToneMapping,agx:THREE.AgXToneMapping,neutral:THREE.NeutralToneMapping,linear:THREE.LinearToneMapping,none:THREE.NoToneMapping}
    let revision=1
    for(const [toneMapping,constant] of Object.entries(variants)){
      await v.setScene(snapshot(revision++,carrier({kind:ENVIRONMENT_KIND,toneMapping,environmentRotationDeg:[90,0,75],shadows:true,shadow:{mapSize:2048,bias:-.002,normalBias:.02}})))
      expect(v.renderer.toneMapping).toBe(constant);expect(harness.status.toneMapping).toBe(toneMapping as any)
      expect(v.scene.environmentRotation.x).toBeCloseTo(Math.PI/2);expect(v.scene.environmentRotation.z).toBeCloseTo(75*Math.PI/180)
      expect(v.scene.backgroundRotation.equals(v.scene.environmentRotation)).toBe(true)
      expect(harness.status.environmentRotationDeg).toEqual([90,0,75])
      expect(v.sun.shadow.mapSize.toArray()).toEqual([2048,2048]);expect(harness.status.shadow).toEqual({mapSize:2048,bias:-.002,normalBias:.02})
    }
    let disposed=0;v.sun.shadow.map={dispose:()=>disposed++}
    await v.setScene(snapshot(revision++,carrier({kind:ENVIRONMENT_KIND,shadows:true,shadow:{mapSize:1024}})))
    expect(disposed).toBe(1);expect(v.sun.shadow.map).toBeNull();expect(v.sun.shadow.mapSize.toArray()).toEqual([1024,1024])
    await v.setScene(snapshot(revision++,plainEntity()))
    expect(v.renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);expect(v.scene.environmentRotation.toArray().slice(0,3)).toEqual([0,0,0])
  })

  test("面积灯是有 LTC 的矩形光源，世界方向只应用一次；其它灯旧换算保留",async()=>{
    const harness=new BareViewer(),entity=plainEntity();entity.entityId="lamp"
    entity.transform={position:[1,2,3],quaternion:new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),Math.PI/2).toArray(),scale:[1,1,1]}
    entity.components={light:{kind:"area",widthM:2,heightM:3,energy:600,direction:[-1,0,0],color:[.5,.6,.7]}}
    await harness.viewer.setScene(snapshot(1,entity,carrier({kind:ENVIRONMENT_KIND,shadows:true})))
    const group=harness.viewer.objects.get("lamp").group,area=group.children[0] as THREE.RectAreaLight
    expect(area).toBeInstanceOf(THREE.RectAreaLight);expect(area.width).toBe(2);expect(area.height).toBe(3);expect(area.power).toBeCloseTo(600)
    expect(area.castShadow).toBe(false);expect(area.color.toArray()).toEqual([.5,.6,.7])
    expect((THREE.UniformsLib as any).LTC_FLOAT_1).toBeInstanceOf(THREE.DataTexture)
    const d=new THREE.Vector3(0,0,-1).applyQuaternion(area.getWorldQuaternion(new THREE.Quaternion()))
    expect(d.x).toBeCloseTo(-1);expect(d.y).toBeCloseTo(0);expect(d.z).toBeCloseTo(0)
    expect(area.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([1,2,3])
    harness.viewer.selected="lamp"
    entity.components.light={...entity.components.light as Record<string,unknown>,energy:300,widthM:4}
    await harness.viewer.setScene(snapshot(2,entity))
    expect(harness.viewer.selected).toBe("lamp");expect(harness.viewer.objects.get("lamp").group).toBe(group)
    expect((group.children[0] as THREE.RectAreaLight).power).toBeCloseTo(300);expect((group.children[0] as THREE.RectAreaLight).width).toBe(4)
    expect((buildSceneLight({kind:"area",sizeM:4}) as THREE.RectAreaLight).width).toBe(4)
    expect(buildSceneLight({kind:"sun",energy:10}).intensity).toBe(6)
    expect(buildSceneLight({kind:"point",energy:500}).intensity).toBe(20)
    expect(buildSceneLight({kind:"spot",energy:500}).intensity).toBe(20)
  })
  test("曝光→renderer、IBL→scene.environmentIntensity、半球/太阳→两盏既有灯（不新开第二套灯）", async () => {
    const harness = new BareViewer()
    const lights = harness.viewer.scene.children.filter((child: THREE.Object3D) => child instanceof THREE.Light).length
    await harness.viewer.setScene(snapshot(1, plainEntity(), carrier({
      kind: ENVIRONMENT_KIND, exposure: 2, environmentIntensity: 1.5, hemisphereIntensity: 1,
      sun: { azimuthDeg: 0, elevationDeg: 0, intensity: 4 },
    })))
    expect(harness.viewer.renderer.toneMappingExposure).toBe(2)
    expect(harness.viewer.scene.environmentIntensity).toBe(1.5)
    expect(harness.viewer.hemisphere.intensity).toBe(1)
    expect(harness.viewer.sun.intensity).toBe(4)
    expect(harness.viewer.sun.position.toArray()).toEqual([50, 0, 0])
    // 环境光照用的就是构造时那两盏灯：没有在场景里新增任何灯
    expect(harness.viewer.scene.children.filter((child: THREE.Object3D) => child instanceof THREE.Light).length).toBe(lights)
    expect(harness.status.sun).toEqual({ azimuthDeg: 0, elevationDeg: 0, intensity: 4, source: "manual" })
  })

  test("sun 方向随方位角/仰角变化，夜间（仰角<0）不再打强光", async () => {
    const harness = new BareViewer()
    await harness.viewer.setScene(snapshot(1, carrier({ kind: ENVIRONMENT_KIND, sun: { azimuthDeg: 180, elevationDeg: 60, intensity: 5 } })))
    const [x, y, z] = harness.viewer.sun.position.toArray().map((value: number) => value / 50)
    expect(x).toBeCloseTo(Math.cos(Math.PI / 3) * Math.cos(Math.PI), 6)
    expect(y).toBeCloseTo(Math.cos(Math.PI / 3) * Math.sin(Math.PI), 6)
    expect(z).toBeCloseTo(Math.sin(Math.PI / 3), 6)
    // 手填方向即使在地平线下也照旧打光（作者说了算，面板上的读数就是它）；昼夜模型才收敛到 0
    await harness.viewer.setScene(snapshot(2, carrier({ kind: ENVIRONMENT_KIND, sun: { azimuthDeg: 180, elevationDeg: -30, intensity: 5 } })))
    expect(harness.viewer.sun.intensity).toBe(5)
  })

  test("阴影：renderer.shadowMap + 太阳 castShadow + mesh 的 cast/receive 三处一起变，视锥按场景包围球取景", async () => {
    const harness = new BareViewer()
    const pending = harness.viewer.setScene(snapshot(1, meshEntity(), carrier({ kind: ENVIRONMENT_KIND, shadows: true })))
    harness.deliverModel("assets/plant.glb")
    await pending
    expect(harness.viewer.renderer.shadowMap.enabled).toBe(true)
    expect(harness.viewer.renderer.shadowMap.type).toBe(THREE.PCFSoftShadowMap)
    expect(harness.viewer.sun.castShadow).toBe(true)
    const camera = harness.viewer.sun.shadow.camera
    // 立方体边长 2 ⇒ 包围球半径 ≈ 1.73；视锥覆盖 1.5 倍半径，光距不小于 50
    expect(camera.left).toBeCloseTo(-camera.right, 6)
    expect(camera.right).toBeGreaterThan(2)
    expect(harness.viewer.sunDistance).toBeGreaterThanOrEqual(50)
    expect(camera.far).toBeGreaterThan(harness.viewer.sunDistance)
    const meshes: THREE.Mesh[] = []
    harness.viewer.objects.get("plant").group.traverse((object: THREE.Object3D) => { if (object instanceof THREE.Mesh) meshes.push(object) })
    expect(meshes.length).toBeGreaterThan(0)
    for (const mesh of meshes) { expect(mesh.castShadow).toBe(true); expect(mesh.receiveShadow).toBe(true) }
    expect(harness.status.shadows).toBe(true)

    await harness.viewer.setScene(snapshot(2, meshEntity(), carrier({ kind: ENVIRONMENT_KIND, shadows: false })))
    expect(harness.viewer.renderer.shadowMap.enabled).toBe(false)
    expect(harness.viewer.sun.castShadow).toBe(false)
    for (const mesh of meshes) { expect(mesh.castShadow).toBe(false); expect(mesh.receiveShadow).toBe(false) }
  })

  test("背景：组件说 skybox 但 HDRI 还没到手时仍是纯色（不猜一张贴图）；纯色是相机面板那一份", async () => {
    const harness = new BareViewer()
    await harness.viewer.setScene(snapshot(1, carrier({ kind: ENVIRONMENT_KIND, background: "environment" })))
    expect(harness.status.background).toBe("environment")
    expect(harness.viewer.scene.background).toBeInstanceOf(THREE.Color)
    expect(harness.status.colorBackground).toBe("#121a24")
    harness.viewer.display.background = "#202020"
    harness.viewer.setDisplaySettings({ background: "#202020" })
    expect((harness.viewer.scene.background as THREE.Color).getHexString()).toBe("202020")
    expect(harness.status.colorBackground).toBe("#202020")
  })

  test("场景自带背景色：随 Scene 组件保存并生效；缺省那一份仍由查看器偏好决定（旧场景不被改色）", async () => {
    const harness = new BareViewer()
    const component = (backgroundColor?: string) => ({
      kind: ENVIRONMENT_KIND, background: "color", backgroundColor, exposure: 1,
    })
    // 场景自己存了颜色：它说了算，而且重开（下一次 setScene）读的还是同一份
    await harness.viewer.setScene(snapshot(1, carrier(component("#204060"))))
    expect(harness.status.backgroundColor).toBe("#204060")
    expect(harness.status.colorBackground).toBe("#204060")
    expect((harness.viewer.scene.background as THREE.Color).getHexString()).toBe("204060")
    // 查看器偏好（相机面板那一份）改了也不影响已存色的场景
    harness.viewer.setDisplaySettings({ background: "#112233" })
    expect(harness.status.backgroundColor).toBe("#204060")
    expect((harness.viewer.scene.background as THREE.Color).getHexString()).toBe("204060")

    // 换一个默认偏好不同的查看器实例重开同一份文档：场景里的颜色不丢
    const other = new BareViewer()
    other.viewer.display = { ...other.viewer.display, background: "#000000" }
    await other.viewer.setScene(snapshot(1, carrier(component("#204060"))))
    expect(other.status.colorBackground).toBe("#204060")
    expect((other.viewer.scene.background as THREE.Color).getHexString()).toBe("204060")

    // 文档里没有这一份（历史场景）：沿用查看器偏好，不被环境光照顺手改色
    await harness.viewer.setScene(snapshot(2, carrier(component())))
    expect(harness.status.backgroundColor).toBeUndefined()
    expect(harness.status.colorBackground).toBe("#112233")
    expect((harness.viewer.scene.background as THREE.Color).getHexString()).toBe("112233")
  })

  test("天空盒优先于纯色：background=environment 且 HDRI 到手时背景是那张贴图，不是颜色", async () => {
    const harness = new BareViewer()
    const restore = stubPmrem()
    try {
      const pending = harness.viewer.setScene(snapshot(1, carrier({ kind: ENVIRONMENT_KIND, background: "environment", backgroundColor: "#204060", hdri: { resourceId: "sky-1", version: 1 } }, [hdriRef])))
      await until(() => harness.reads.length > 0, "HDRI 读取发起")
      harness.deliverHdri(HDRI_URI)
      await pending
      expect(harness.status.background).toBe("environment")
      expect(harness.viewer.scene.background).toBeInstanceOf(THREE.Texture)
      expect(harness.status.backgroundColor).toBe("#204060") // 颜色仍记在组件里，切回纯色就用它
    } finally { restore() }
  })
})

describe("昼夜：渲染时钟与物理时间分离", () => {
  test("开启昼夜后太阳由时刻推导，强度与 IBL 随日照系数变化（夜里不熄到全黑）", async () => {
    const harness = new BareViewer()
    await harness.viewer.setScene(snapshot(1, carrier({
      kind: ENVIRONMENT_KIND, environmentIntensity: 2, sun: { intensity: 3, azimuthDeg: 10, elevationDeg: 10 },
      dayNight: { enabled: true, timeHours: 12, cycleSeconds: 60 },
    })))
    expect(harness.status.sun.source).toBe("dayNight")
    expect(harness.status.sun.elevationDeg).toBeCloseTo(55, 6)
    expect(harness.status.sun.intensity).toBeCloseTo(3, 6)
    expect(harness.viewer.scene.environmentIntensity).toBeCloseTo(2, 6)

    await harness.viewer.setScene(snapshot(2, carrier({
      kind: ENVIRONMENT_KIND, environmentIntensity: 2, sun: { intensity: 3, azimuthDeg: 10, elevationDeg: 10 },
      dayNight: { enabled: true, timeHours: 0, cycleSeconds: 60 },
    })))
    expect(harness.status.sun.elevationDeg).toBeCloseTo(-55, 6)
    expect(harness.status.sun.intensity).toBe(0)
    expect(harness.viewer.scene.environmentIntensity).toBeCloseTo(2 * 0.12, 6)
    expect(harness.viewer.scene.environmentIntensity).toBeGreaterThan(0)
  })

  test("播放推进渲染时钟：太阳真的动了，而 snapshot 与 projection 一个字节都没变", async () => {
    const harness = new BareViewer()
    const component = { kind: ENVIRONMENT_KIND, sun: { intensity: 3 }, dayNight: { enabled: true, timeHours: 9, cycleSeconds: 20 } }
    await harness.viewer.setScene(snapshot(1, carrier(component)))
    const before = harness.status
    const snapshotBefore = JSON.stringify(harness.viewer.snapshot)
    expect(harness.viewer.setDayNightPlaying(true)).toEqual({ playing: true, timeHours: 9, cycleSeconds: 20 })
    harness.viewer.advanceDayNight() // 第一次只记时刻，不推进（delta=0）
    expect(harness.status.clock.advancedSeconds).toBe(0)
    await sleep(80)
    harness.viewer.advanceDayNight()
    const after = harness.status
    expect(after.clock.playing).toBe(true)
    expect(after.clock.advancedSeconds).toBeGreaterThan(0.05)
    expect(after.clock.advancedSeconds).toBeLessThan(0.5)
    expect(after.timeHours).toBeGreaterThan(before.timeHours!)
    expect(after.sun.azimuthDeg).toBeGreaterThan(before.sun.azimuthDeg)
    // 播放只推进渲染时钟：文档（snapshot）与物理帧投影都没被写过
    expect(JSON.stringify(harness.viewer.snapshot)).toBe(snapshotBefore)
    expect(harness.viewer.projection.current()).toBeUndefined()
    expect(harness.viewer.projection.consume()).toBeUndefined()
    // 暂停后不再推进
    expect(harness.viewer.setDayNightPlaying(false)).toEqual({ playing: false, timeHours: after.timeHours, cycleSeconds: 20 })
    await sleep(40)
    harness.viewer.advanceDayNight()
    expect(harness.status.clock.advancedSeconds).toBe(after.clock.advancedSeconds)
  })

  test("同一个 Scene 上改别的字段（曝光）不会打断播放；改写静态时刻/周期才把偏移归零", async () => {
    const harness = new BareViewer()
    const base = { kind: ENVIRONMENT_KIND, exposure: 1, dayNight: { enabled: true, timeHours: 9, cycleSeconds: 20 } }
    await harness.viewer.setScene(snapshot(1, carrier(base)))
    harness.viewer.setDayNightPlaying(true)
    harness.viewer.advanceDayNight()
    await sleep(60)
    harness.viewer.advanceDayNight()
    const advanced = harness.status.clock.advancedSeconds
    expect(advanced).toBeGreaterThan(0.03)

    await harness.viewer.setScene(snapshot(2, carrier({ ...base, exposure: 3 })))
    const kept = harness.status.clock
    expect(kept.playing).toBe(true)
    expect(kept.advancedSeconds).toBe(advanced)
    expect(harness.status.exposure).toBe(3)

    await harness.viewer.setScene(snapshot(3, carrier({ ...base, exposure: 3, dayNight: { enabled: true, timeHours: 15, cycleSeconds: 20 } })))
    expect(harness.status.clock.offsetHours).toBe(0)
    expect(harness.status.clock.advancedSeconds).toBe(advanced)
    expect(harness.status.timeHours).toBe(15)
  })

  test("组件被移除时时钟归零：不会留着一个「还在播」的假读数", async () => {
    const harness = new BareViewer()
    await harness.viewer.setScene(snapshot(1, carrier({ kind: ENVIRONMENT_KIND, dayNight: { enabled: true, timeHours: 9, cycleSeconds: 20 } })))
    harness.viewer.setDayNightPlaying(true)
    harness.viewer.advanceDayNight()
    await sleep(50)
    harness.viewer.advanceDayNight()
    expect(harness.status.clock.playing).toBe(true)
    await harness.viewer.setScene(snapshot(2, plainEntity()))
    expect(harness.status.clock).toEqual({ playing: false, offsetHours: 0, advancedSeconds: 0 })
    expect(harness.status.timeHours).toBe(0)
  })
})

describe("HDRI：资源登记、加载、失败与归属", () => {
  test("组件指向的资源不在承载实体上 ⇒ 报资源缺失，且不去读任何 URI", async () => {
    const harness = new BareViewer()
    await harness.viewer.setScene(snapshot(1, carrier({ kind: ENVIRONMENT_KIND, hdri: { resourceId: "sky-1", version: 1 } })))
    expect(harness.readStarts).toBe(0)
    expect(harness.status.error).toContain("ENVIRONMENT_HDRI_RESOURCE_MISSING: sky-1@1")
    expect(harness.status.environmentSource).toBe("builtin")
    expect(harness.status.hdri).toEqual({ resourceId: "sky-1", version: 1, loaded: false, loading: false })
    expect(harness.viewer.scene.environment).toBe(harness.viewer.materialEnvironment.texture)
  })

  test("请求 v2 而实体上只有 v1：报缺版本（列出实际版本），不拿 v1 顶替、不读任何 URI", async () => {
    const harness = new BareViewer()
    const restore = stubPmrem()
    try {
      // 先让 v1 真的装上：否则"v1 被顶替"这件事无从观察
      const first = harness.viewer.setScene(snapshot(1, carrier({ kind: ENVIRONMENT_KIND, background: "environment", hdri: { resourceId: "sky-1", version: 1 } }, [hdriRef])))
      await until(() => harness.reads.length > 0, "v1 的 HDRI 读取发起")
      harness.deliverHdri(HDRI_URI)
      await first
      expect(harness.status.hdri?.loaded).toBe(true)

      // 文档改成请求 v2：实体上仍然只有 v1（同 id、别的版本）
      const readsBefore = harness.readStarts
      await harness.viewer.setScene(snapshot(2, carrier({ kind: ENVIRONMENT_KIND, background: "environment", hdri: { resourceId: "sky-1", version: 2 } }, [hdriRef])))
      const status = harness.status
      expect(status.error).toContain("ENVIRONMENT_HDRI_VERSION_MISSING: sky-1@2")
      expect(status.error).toContain("只有 sky-1@1")
      expect(harness.readStarts).toBe(readsBefore) // 没有偷偷去读 v1 的字节来充数
      expect(status.hdri).toEqual({ resourceId: "sky-1", version: 2, loaded: false, loading: false })
      expect(status.environmentSource).toBe("builtin")
      // 旧图被放下：画面不再用 v1，也就不会"显示着 v1 却说自己是 v2"
      expect(harness.viewer.scene.environment).toBe(harness.viewer.materialEnvironment.texture)
      // 采集回执里的窄面必须带着这条事实（不能只是一张看起来正常的图）
      expect(harness.viewer.capture().environment).toEqual({ source: "builtin", requested: "sky-1@2", loaded: false, loading: false, error: String(status.error) })
    } finally { restore() }
  })

  test("换图在途 A→B：loaded 只在 applied 与 requested 一致时为真，不许拿还在显示的 A 说 B 已载入", async () => {
    const harness = new BareViewer()
    const restore = stubPmrem()
    try {
      const switchable = () => carrier({ kind: ENVIRONMENT_KIND, background: "environment", hdri: { resourceId: "sky-2", version: 1 } }, [hdriRef, hdriRef2])
      const first = harness.viewer.setScene(snapshot(1, carrier({ kind: ENVIRONMENT_KIND, background: "environment", hdri: { resourceId: "sky-1", version: 1 } }, [hdriRef])))
      await until(() => harness.reads.length > 0, "A 的 HDRI 读取发起")
      harness.deliverHdri(HDRI_URI)
      await first
      expect(harness.status.hdri).toEqual({ resourceId: "sky-1", version: 1, loaded: true, loading: false, uri: HDRI_URI, size: [2, 2] })
      const textureA = harness.viewer.scene.environment

      // 同一个 Scene 的下一次编辑换成 B：B 的字节还没到，画面这一会儿还是 A
      const switching = harness.viewer.setScene(snapshot(2, switchable()))
      await until(() => harness.reads.some(read => read.uri === HDRI_URI_B), "B 的 HDRI 读取发起")
      const during = harness.status
      expect(during.hdri).toEqual({ resourceId: "sky-2", version: 1, loaded: false, loading: true, applied: { resourceId: "sky-1", version: 1 } })
      expect(during.environmentSource).toBe("hdri") // 画面确实是 HDRI（A），不是内置光——但也不是请求的 B
      expect(harness.viewer.scene.environment).toBe(textureA)
      expect(harness.viewer.capture().environment).toEqual({ source: "hdri", requested: "sky-2@1", applied: "sky-1@1", loaded: false, loading: true })

      harness.deliverHdri(HDRI_URI_B)
      await switching
      const after = harness.status
      expect(after.hdri).toEqual({ resourceId: "sky-2", version: 1, loaded: true, loading: false, uri: HDRI_URI_B, size: [2, 2] })
      expect(after.error).toBeUndefined()
      expect(harness.viewer.scene.environment).not.toBe(textureA)
      expect(harness.viewer.capture().environment).toEqual({ source: "hdri", requested: "sky-2@1", applied: "sky-2@1", loaded: true, loading: false })
    } finally { restore() }
  })

  test("HDRI 由实体的 ResourceRef 交付（组件里只有 resourceId@version，没有绝对路径）", async () => {
    const harness = new BareViewer()
    const pending = harness.viewer.setScene(snapshot(1, carrier({ kind: ENVIRONMENT_KIND, hdri: { resourceId: "sky-1", version: 1 } }, [hdriRef])))
    await until(() => harness.reads.length > 0, "HDRI 读取发起")
    expect(harness.reads.map(read => read.uri)).toEqual([HDRI_URI])
    harness.failRead(HDRI_URI, "ENVIRONMENT_HDRI_LOAD_FAILED: 只测试失败路径")
    await pending
  })

  test("读取失败 ⇒ 台账 + onError + 回到内置环境光，下一次 setScene 会重试", async () => {
    const harness = new BareViewer()
    const component = { kind: ENVIRONMENT_KIND, exposure: 2, hdri: { resourceId: "sky-1", version: 1 } }
    const first = harness.viewer.setScene(snapshot(1, carrier(component, [hdriRef])))
    await until(() => harness.reads.length > 0, "第一次 HDRI 读取发起")
    harness.failRead(HDRI_URI, "ENVIRONMENT_HDRI_LOAD_FAILED: 读不到这张贴图")
    await first
    expect(harness.status.error).toBe("ENVIRONMENT_HDRI_LOAD_FAILED: 读不到这张贴图")
    expect(harness.status.environmentSource).toBe("builtin")
    expect(harness.status.hdri?.loaded).toBe(false)
    expect(harness.errors).toEqual(["ENVIRONMENT_HDRI_LOAD_FAILED: 读不到这张贴图"])
    expect(harness.viewer.scene.environment).toBe(harness.viewer.materialEnvironment.texture)
    expect(harness.viewer.renderer.toneMappingExposure).toBe(2) // 失败不影响同一组件里别的字段
    // 重试：资源可重试是既有纪律（失败不留"永不再试"的标记）
    const second = harness.viewer.setScene(snapshot(2, carrier(component, [hdriRef])))
    await until(() => harness.reads.length > 0, "重试的 HDRI 读取发起")
    expect(harness.reads.map(read => read.uri)).toEqual([HDRI_URI])
    harness.failRead(HDRI_URI, "ENVIRONMENT_HDRI_LOAD_FAILED: 还是读不到")
    await second
    expect(harness.errors).toHaveLength(2)
    expect(harness.status.error).toBe("ENVIRONMENT_HDRI_LOAD_FAILED: 还是读不到")
  })

  test("迟到的旧 HDRI 结果不会挂到当前环境上：就地释放、不写台账、不当成「已加载」", async () => {
    const harness = new BareViewer()
    const dispose = THREE.Texture.prototype.dispose
    const disposed: THREE.Texture[] = []
    THREE.Texture.prototype.dispose = function (this: THREE.Texture) { disposed.push(this); return dispose.call(this) }
    try {
      const stale = harness.viewer.setScene(snapshot(1, carrier({ kind: ENVIRONMENT_KIND, hdri: { resourceId: "sky-1", version: 1 } }, [hdriRef])))
      await until(() => harness.reads.length > 0, "旧 HDRI 读取发起")
      // 还没回来就换成了不带 HDRI 的新版本（同一场景的下一次编辑）
      await harness.viewer.setScene(snapshot(2, carrier({ kind: ENVIRONMENT_KIND })))
      expect(harness.status.hdri).toBeUndefined()
      harness.deliverHdri(HDRI_URI) // 旧请求现在才成功
      await stale
      expect(harness.status.hdri).toBeUndefined()
      expect(harness.status.environmentSource).toBe("builtin")
      // 归属核对在 PMREM 之前就返回：既没有采纳，也没有因为"失败"写台账
      expect(harness.status.error).toBeUndefined()
      expect(harness.errors).toEqual([])
      expect(disposed).toHaveLength(1) // 迟到的纹理被就地释放，不泄漏
    } finally { THREE.Texture.prototype.dispose = dispose }
  })

  test("迟到的失败也不会写进新环境的台账（失败侧与成功侧同一条归属判据）", async () => {
    const harness = new BareViewer()
    const stale = harness.viewer.setScene(snapshot(1, carrier({ kind: ENVIRONMENT_KIND, hdri: { resourceId: "sky-1", version: 1 } }, [hdriRef])))
    await until(() => harness.reads.length > 0, "旧 HDRI 读取发起")
    await harness.viewer.setScene(snapshot(2, carrier({ kind: ENVIRONMENT_KIND })))
    harness.failRead(HDRI_URI, "ENVIRONMENT_HDRI_LOAD_FAILED: 迟到的失败")
    await stale
    expect(harness.status.error).toBeUndefined()
    expect(harness.errors).toEqual([])
  })

  test("被浅合并写坏的 environment 记录（丢了 kind、只剩 hdri）⇒ 整条被忽略并记进 diagnostics，读数回到 builtin", async () => {
    const harness = new BareViewer()
    // `scene_edit` 的 update 是**实体级浅合并**（packages/scene-kit/src/store.ts:158-160）：
    // `changes.components` 会整块替换组件表，所以只发 `{environment:{hdri:…}}` 会丢掉 kind。
    // 这不是合法环境记录 ⇒ 被忽略（带原因），读数回到内置环境光。ENV-20 Round 5 复现 R4 那次观察的根因。
    await harness.viewer.setScene(snapshot(1, carrier({ hdri: { resourceId: "sky-1", version: 1 } }, [hdriRef])))
    expect(harness.readStarts).toBe(0)
    expect(harness.status.component).toBeUndefined()
    expect(harness.status.hdri).toBeUndefined()
    expect(harness.status.environmentSource).toBe("builtin")
    expect(harness.status.ignored).toEqual([{ entityId: "lighting", reason: "ENVIRONMENT_KIND_UNSUPPORTED: undefined" }])
    expect(harness.viewer.capture().environment).toEqual({ source: "builtin", loaded: false, loading: false })
  })

  test("移除引用后再写回**逐字段相同**的引用 ⇒ 重新发起读取并回到 loaded:true（旧贴图不留「已加载」缓存）", async () => {
    const harness = new BareViewer()
    const restore = stubPmrem()
    try {
      const component = { kind: ENVIRONMENT_KIND, hdri: { resourceId: "sky-1", version: 1 } }
      // ① 挂上
      const mounted = harness.viewer.setScene(snapshot(1, carrier(component, [hdriRef])))
      await until(() => harness.reads.length > 0, "① 的 HDRI 读取发起")
      harness.deliverHdri(HDRI_URI)
      await mounted
      expect(harness.status.hdri?.loaded).toBe(true)
      expect(harness.viewer.capture().environment).toEqual({ source: "hdri", requested: "sky-1@1", applied: "sky-1@1", loaded: true, loading: false })
      const firstTexture = harness.viewer.scene.environment

      // ② 移除引用：**合法的**环境记录，只是没有 hdri 这一项（`hdri:null` 不是合法组件，那是 ENVIRONMENT_HDRI_INVALID）
      await harness.viewer.setScene(snapshot(2, carrier({ kind: ENVIRONMENT_KIND, exposure: 2 })))
      expect(harness.status.hdri).toBeUndefined()
      expect(harness.status.environmentSource).toBe("builtin")
      expect(harness.viewer.scene.environment).toBe(harness.viewer.materialEnvironment.texture)

      // ③ 写回逐字段相同的那一条引用：必须重新读一次，而不是复用①的旧贴图说"已加载"
      const remounted = harness.viewer.setScene(snapshot(3, carrier(component, [hdriRef])))
      await until(() => harness.reads.length > 0, "③ 写回后的 HDRI 重新读取")
      expect(harness.reads.map(read => read.uri)).toEqual([HDRI_URI])
      expect(harness.viewer.capture().environment).toEqual({ source: "builtin", requested: "sky-1@1", loaded: false, loading: true })
      harness.deliverHdri(HDRI_URI)
      await remounted
      expect(harness.status.hdri?.loaded).toBe(true)
      expect(harness.status.environmentSource).toBe("hdri")
      expect(harness.viewer.scene.environment).not.toBe(harness.viewer.materialEnvironment.texture)
      expect(harness.viewer.scene.environment).not.toBe(firstTexture)
      expect(harness.viewer.capture().environment).toEqual({ source: "hdri", requested: "sky-1@1", applied: "sky-1@1", loaded: true, loading: false })
    } finally { restore() }
  })
})

describe("补丁经 Viewer 合成：界面上的当前值就是解析出来的那一份", () => {
  test("没有组件时补丁从默认值起；有组件时只改补丁点到的字段", async () => {
    const harness = new BareViewer()
    await harness.viewer.setScene(snapshot(1, plainEntity()))
    const created = harness.viewer.composeEnvironment({ exposure: 2 })
    expect(created.component.exposure).toBe(2)
    expect(created.component.environmentIntensity).toBe(0.7)
    expect(created.warnings).toEqual([])

    await harness.viewer.setScene(snapshot(2, carrier({ kind: ENVIRONMENT_KIND, exposure: 2, sun: { azimuthDeg: 200, elevationDeg: 12, intensity: 1 } })))
    const patched = harness.viewer.composeEnvironment({ sun: { intensity: 6 } })
    expect(patched.component.sun).toEqual({ azimuthDeg: 200, elevationDeg: 12, intensity: 6 })
    expect(patched.component.exposure).toBe(2)
    expect(harness.viewer.composeEnvironment({ exposure: 99 }).warnings[0]).toContain("ENVIRONMENT_FIELD_CLAMPED")
  })
})

describe("Scene PBR 材质覆盖与资源所有权",()=>{
  test("只克隆覆盖实体的材质；保纹理/UV，复原与删除释放克隆而不释放共享资源",async()=>{
    const harness=new BareViewer(),v=harness.viewer,a=meshEntity(),b=structuredClone(a);b.entityId="other-instance"
    const texture=new THREE.Texture(),normal=new THREE.Texture(),sourceMaterial=new THREE.MeshStandardMaterial({color:"#ffffff",roughness:.38,metalness:.1,map:texture,normalMap:normal})
    sourceMaterial.normalScale.set(2,-3)
    const geometry=new THREE.BoxGeometry(1,1,1),model=new THREE.Group();model.add(new THREE.Mesh(geometry,sourceMaterial))
    let texturesDisposed=0,geometryDisposed=0,sourceDisposed=0,cloneDisposed=0
    texture.addEventListener("dispose",()=>texturesDisposed++);normal.addEventListener("dispose",()=>texturesDisposed++);geometry.addEventListener("dispose",()=>geometryDisposed++);sourceMaterial.addEventListener("dispose",()=>sourceDisposed++)
    const pending=v.setScene(snapshot(1,a,b));await until(()=>harness.reads.length===2,"同资源两个实体请求")
    v.gltfs.set(glbRef.original.uri,Promise.resolve({scene:model,animations:[]}))
    for(const read of harness.reads.splice(0))read.deliver(glbRef.original.uri)
    await pending
    const mesh=(id:string)=>{let found!:THREE.Mesh;v.objects.get(id).visual.traverse((child:THREE.Object3D)=>{if(child instanceof THREE.Mesh)found=child});return found}
    const ma=mesh(a.entityId),mb=mesh(b.entityId),original=ma.material
    expect(ma.material).toBe(sourceMaterial);expect(mb.material).toBe(sourceMaterial)
    const reads=harness.readStarts,component=v.composeMaterial(a.entityId,{baseColor:"#66aaee",roughness:.75,metalness:.8,emissive:"#ffaa00",emissiveIntensity:3,opacity:.4,normalScale:.5}).component
    const modified=structuredClone(a);modified.components.materialOverride=component
    await v.setScene(snapshot(2,modified,b))
    const copied=ma.material as THREE.MeshStandardMaterial;copied.addEventListener("dispose",()=>cloneDisposed++)
    expect(copied).not.toBe(original);expect(mb.material).toBe(original);expect(harness.readStarts).toBe(reads)
    expect(copied.map).toBe(texture);expect(copied.normalMap).toBe(normal);expect(copied.normalScale.toArray()).toEqual([1,-1.5])
    expect(copied.roughness).toBe(.75);expect(copied.metalness).toBe(.8);expect(copied.emissiveIntensity).toBe(3);expect(copied.opacity).toBe(.4);expect(copied.transparent).toBe(true)
    expect(copied.color.getHexString(THREE.SRGBColorSpace)).toBe("66aaee")
    expect(sourceMaterial.roughness).toBe(.38);expect(sourceMaterial.metalness).toBe(.1);expect(sourceMaterial.opacity).toBe(1)
    expect(ma.geometry).toBe(geometry);expect(ma.geometry.attributes.uv).toBe(geometry.attributes.uv)
    const status=v.materialStatus(a.entityId)
    expect(status.supported).toBe(1);expect(status.materials[0]).toMatchObject({baseColor:"#66aaee",roughness:.75,metalness:.8,opacity:.4,hasTextures:true,hasNormalMap:true,normalScale:[1,-1.5]})
    expect(v.materialStatus(b.entityId).component).toBeUndefined();expect(v.materialStatus(b.entityId).materials[0].roughness).toBe(.38)
    await v.setScene(snapshot(3,a,b))
    expect(ma.material).toBe(original);expect(cloneDisposed).toBe(1)
    modified.components.materialOverride={...component,textures:false}
    await v.setScene(snapshot(4,modified,b))
    const noTextures=ma.material as THREE.MeshStandardMaterial;noTextures.addEventListener("dispose",()=>cloneDisposed++)
    expect(noTextures.map).toBeNull();expect(noTextures.normalMap).toBeNull();expect(mb.material).toBe(original)
    await v.setScene(snapshot(5,b))
    expect(cloneDisposed).toBe(2);expect(texturesDisposed).toBe(0);expect(geometryDisposed).toBe(0);expect(sourceDisposed).toBe(0)
  })

  test("空组件/非 PBR/无源法线不伪造作用，非法输入明示忽略",()=>{
    const root=new THREE.Group(),pbr=new THREE.MeshStandardMaterial(),basic=new THREE.MeshBasicMaterial(),mesh=new THREE.Mesh(new THREE.BoxGeometry(),pbr)
    root.add(mesh,new THREE.Mesh(new THREE.BoxGeometry(),basic));const owner=new EntityMaterialOverride()
    owner.apply([root],{kind:MATERIAL_OVERRIDE_KIND});expect(mesh.material).toBe(pbr)
    const parsed=parseMaterialOverride({kind:MATERIAL_OVERRIDE_KIND,roughness:4,opacity:"",baseColor:"red",normalScale:2})
    expect(parsed.warnings).toHaveLength(3);expect(parsed.component?.roughness).toBe(1);expect(parsed.component?.opacity).toBeUndefined()
    owner.apply([root],parsed.component);expect((mesh.material as THREE.MeshStandardMaterial).normalScale.toArray()).toEqual([1,1])
    expect(owner.readings([root])).toMatchObject({supported:1,unsupported:1});expect(owner.readings([root]).materials[0].hasNormalMap).toBe(false)
    owner.reset();expect(mesh.material).toBe(pbr)
    const harness=new BareViewer(),entity=plainEntity();entity.components.materialOverride=parsed.component
    root.userData.entityId=entity.entityId;root.userData.loaded=true
    const loaded={group:root,visual:root,lodWarnings:[],signature:"test"}
    harness.viewer.snapshot=snapshot(1,entity);harness.viewer.objects.set(entity.entityId,loaded)
    harness.viewer.applyEntityMaterial(loaded)
    expect(harness.viewer.materialStatus(entity.entityId).warnings.some((warning:string)=>warning.startsWith("MATERIAL_NORMAL_MAP_MISSING"))).toBe(true)
    expect(harness.viewer.visualWarnings.get(entity.entityId).some((warning:string)=>warning.startsWith("MATERIAL_NORMAL_MAP_MISSING"))).toBe(true)
    entity.components.materialOverride={kind:"invalid"};harness.viewer.snapshot=snapshot(2,entity);harness.viewer.applyEntityMaterial(loaded)
    expect(harness.viewer.materialStatus(entity.entityId).declared).toBe(true)
    delete entity.components.materialOverride;harness.viewer.snapshot=snapshot(3,entity);harness.viewer.applyEntityMaterial(loaded)
    expect(harness.viewer.visualWarnings.has(entity.entityId)).toBe(false)
  })

  test("原 SceneStore CAS、历史、scene_save/open 持久化同一环境/材质组件",async()=>{
    const {mkdtemp,rm}=await import("node:fs/promises"),{join}=await import("node:path"),{tmpdir}=await import("node:os")
    const {SceneOperations}=await import("../../scene-kit/src/operations.ts"),root=await mkdtemp(join(tmpdir(),"render-controls-scene-"))
    try{
      const ops=new SceneOperations(join(root,"owner")),created=await ops.create({sceneId:"render-control-scene"})
      const entity=plainEntity();entity.entityId="pbr-object";entity.components.materialOverride={kind:MATERIAL_OVERRIDE_KIND,roughness:.42,metalness:.75,textures:true}
      const lighting=carrier({kind:ENVIRONMENT_KIND,toneMapping:"agx",environmentRotationDeg:[90,0,35],exposure:1,hemisphereIntensity:0,sun:{intensity:0},shadow:{mapSize:1024,bias:-.001}})
      delete entity.parentId;delete lighting.parentId
      const committed=await ops.scene.commit({sceneId:created.sceneId,expectedRevision:0,patch:[{op:"add",entity},{op:"add",entity:lighting}]})
      await expect(ops.scene.commit({sceneId:created.sceneId,expectedRevision:0,patch:[]})).rejects.toThrow()
      const path=join(root,"scene.json");await ops.save(created.sceneId,path)
      const other=new SceneOperations(join(root,"reopened")),reopened=await other.open(path)
      expect(reopened.entities.map((item:Entity)=>item.components)).toEqual(committed.entities.map((item:Entity)=>item.components))
      const reset=structuredClone(entity.components);delete reset.materialOverride
      const next=await ops.scene.commit({sceneId:created.sceneId,expectedRevision:committed.revision,patch:[{op:"update",entityId:entity.entityId,changes:{components:reset}}]})
      expect(next.entities[0]!.components.materialOverride).toBeUndefined()
      expect((await ops.scene.version(created.sceneId,committed.revision)).entities[0]!.components.materialOverride).toEqual(entity.components.materialOverride)
    }finally{await rm(root,{recursive:true,force:true})}
  })
})
