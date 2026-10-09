import { describe, expect, test } from "bun:test"
import * as THREE from "three"
import { SceneViewer } from "../src/index.ts"
import { gaussianFirstCameraPose } from "../src/gaussian-first-camera.ts"
import { interactiveSplatBudget, recognizedHighSplatVisual } from "../src/splat-runtime.ts"
import { GAUSSIAN_CAMERA_FRAME_MARKERS, parseGaussianPlyFacts, type GaussianCameraFrame } from "../../lyapunov-contracts/src/gaussian-frame.ts"

/** 只取本用例用到的 Loaded 形状；真实字段由 SceneViewer 运行时填入。 */
type Loaded = { group: THREE.Group; signature: string; lodWarnings: string[]; planVisual?: Record<string, unknown>; visual?: THREE.Object3D }

const V2 = "first-camera-c2w-v2"
const V3 = "first-camera-opengl-v3"

/** 生产侧 `gaussian_ply_header` 的 14 个 float 属性（顺序即判据，与 `formats.parseAsset` 同一布局）。 */
const PLY_PROPERTIES = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
/**
 * 造生产约定的真实 14-float binary little endian 头（到 `end_header` 为止）：识别只读头，
 * 声明百万级顶点时不必真的分配正文；标记取生产常量，不复制 `comment` 前缀。
 */
function productionHeader(frame: GaussianCameraFrame, count: number | string, comments: string[] = []): Uint8Array {
  const lines = ["ply", "format binary_little_endian 1.0", GAUSSIAN_CAMERA_FRAME_MARKERS[frame], ...comments, `element vertex ${count}`, ...PLY_PROPERTIES.map(name => `property float ${name}`), "end_header"]
  return new TextEncoder().encode(lines.join("\n") + "\n")
}
/**
 * 文件标签页合成 snapshot 时对 visual 的事实投影：frame 与同源 count 一起来自生产 helper
 * `parseGaussianPlyFacts`（model-preview 的 `splatScene` 就是这两项）。这里只把事实喂给生产
 * 识别器与预算入口，不复制 `recognizedHighSplatVisual`/`interactiveSplatBudget` 的判定逻辑。
 */
function previewVisual(bytes: Uint8Array): Record<string, unknown> {
  const facts = parseGaussianPlyFacts(bytes)
  return { kind: "splat", sourceTransformApplied: false, ...(facts ? { gaussianCameraFrame: facts.frame, sourcePointCount: facts.sourcePointCount } : {}) }
}

/** 造一个"已加载"的可视实体：真实 Group + **真实源坐标 wrapper** + 可选 frame 声明。 */
function loadedSplat(id: string, frame?: string, transform?: (group: THREE.Group) => void): Loaded {
  const group = new THREE.Group()
  group.name = id
  group.userData.entityId = id
  transform?.(group)
  const planVisual: Record<string, unknown> = { kind: "splat", sourceTransformApplied: false }
  if (frame) planVisual.gaussianCameraFrame = frame
  const ref = { resourceId: id, version: 1, original: { uri: `${id}.ply`, mimeType: "application/x-ply" }, representations: [], source: { units: "m", upAxis: "Y", handedness: "right", metersPerUnit: 1 } }
  // 走真实 wrapSourceCoordinates：v2 的 Rx(−90) 与 v3 的 +90 都由产品代码施加，测试不复制这段数学。
  const visual = (SceneViewer.prototype as unknown as { wrapSourceCoordinates: (ref: unknown, visual: unknown, object: THREE.Object3D) => THREE.Object3D }).wrapSourceCoordinates(ref, planVisual, new THREE.Object3D())
  group.add(visual)
  group.updateMatrixWorld(true)
  return { group, signature: id, lodWarnings: [], planVisual, visual } as unknown as Loaded
}

function harness(entries: Array<[string, Loaded]>) {
  const viewer = Object.create(SceneViewer.prototype) as any
  viewer.objects = new Map(entries)
  viewer.snapshot = { sceneId: "s", revision: 1, entities: entries.map(([id]) => ({ entityId: id, name: id, components: {} })) }
  viewer.splatBounds = new WeakMap()
  viewer.splatViewBounds = new WeakMap()
  viewer.camera = new THREE.PerspectiveCamera(60, 1, 0.01, 1000)
  viewer.camera.up.set(0, 0, 1)
  viewer.controls = { target: new THREE.Vector3(), enabled: true, update() {} }
  viewer.firstPerson = { speed: 1 }
  viewer.lastFraming = undefined
  viewer.exitCameraMode = () => {}
  viewer.clearAppliedIntrinsics = () => {}
  viewer.select = () => {}
  const calls = { center: 0, focus: 0, frameAll: 0 }
  viewer.enterSceneCenter = () => { calls.center++ }
  viewer.focus = () => { calls.focus++ }
  viewer.frameAll = () => { calls.frameAll++ }
  return { viewer, calls }
}

describe("首相机位姿：文件 frame + 真实 matrixWorld", () => {
  test("单位矩阵下 v2 朝 +Z/up −Y，v3 朝 −Z/up +Y", () => {
    const identity = new THREE.Matrix4()
    const v2 = gaussianFirstCameraPose(V2, identity)!
    expect(v2.position.toArray()).toEqual([0, 0, 0])
    expect(v2.forward.toArray()).toEqual([0, 0, 1])
    expect(v2.up.toArray()).toEqual([0, -1, 0])
    const v3 = gaussianFirstCameraPose(V3, identity)!
    expect(v3.forward.toArray()).toEqual([0, 0, -1])
    expect(v3.up.toArray()).toEqual([0, 1, 0])
  })

  test("非单位矩阵/缩放下前向与上向仍随真实世界矩阵；未知 frame、退化与非有限拒绝", () => {
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(5, 6, 7),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.4, 0.5)),
      new THREE.Vector3(2, 3, 4),
    )
    const pose = gaussianFirstCameraPose(V2, matrix)!
    expect(pose.position.toArray()).toEqual([5, 6, 7]) // 缩放不作用于平移列
    expect(pose.forward.distanceTo(new THREE.Vector3(0, 0, 1).transformDirection(matrix))).toBeLessThan(1e-12)
    expect(pose.up.distanceTo(new THREE.Vector3(0, -1, 0).transformDirection(matrix))).toBeLessThan(1e-12)
    expect(pose.forward.length()).toBeCloseTo(1)
    expect(gaussianFirstCameraPose("not-a-frame", matrix)).toBeUndefined()
    expect(gaussianFirstCameraPose(V2, new THREE.Matrix4().makeScale(0, 0, 0))).toBeUndefined()
    const nan = new THREE.Matrix4().makeTranslation(Number.NaN, 0, 0)
    expect(gaussianFirstCameraPose(V2, nan)).toBeUndefined()
  })
})

describe("默认打开用首相机而不是 bbox 中心", () => {
  test("唯一已识别实体：相机落在其首帧位姿，含实体放置与缩放；不调用 enterSceneCenter", () => {
    const { viewer, calls } = harness([["hall", loadedSplat("hall", V2, group => {
      group.position.set(5, 6, 7)
      group.rotation.set(0.2, -0.5, 0.9)
      group.scale.setScalar(2)
    })]])
    viewer.openDefaultView()
    expect(calls.center).toBe(0)
    const loaded = viewer.objects.get("hall") as Loaded
    const matrix = loaded.visual!.matrixWorld
    const expected = new THREE.Vector3().setFromMatrixPosition(matrix)
    expect(viewer.camera.position.distanceTo(expected)).toBeLessThan(1e-12)
    const direction = viewer.controls.target.clone().sub(viewer.camera.position).normalize()
    expect(direction.distanceTo(new THREE.Vector3(0, 0, 1).transformDirection(matrix))).toBeLessThan(1e-12)
    // up 与视线正交（不退化），且等于文件 up 经世界矩阵后的方向。
    expect(Math.abs(viewer.camera.up.dot(direction))).toBeLessThan(1e-9)
    expect(viewer.camera.up.distanceTo(new THREE.Vector3(0, -1, 0).transformDirection(matrix))).toBeLessThan(1e-12)
    expect(viewer.camera.far).toBeGreaterThanOrEqual(100)
    expect(Number.isFinite(viewer.firstPerson.speed)).toBe(true)
  })

  test("v3 标记同样走首相机（新标准 High 的默认朝向无需手工纠正）", () => {
    const { viewer, calls } = harness([["hall", loadedSplat("hall", V3)]])
    viewer.openDefaultView()
    expect(calls.center).toBe(0)
    expect(Math.abs(viewer.camera.up.x)).toBeLessThan(1e-9)
    expect(Math.abs(viewer.camera.up.y)).toBeLessThan(1e-9)
    expect(viewer.camera.up.z).toBeCloseTo(1)
    expect(viewer.camera.getWorldDirection(new THREE.Vector3()).y).toBeCloseTo(1)
  })

  test("entityId 只命中指定实体；未指定且存在多个已识别实体时保留既有行为", () => {
    const entries: Array<[string, Loaded]> = [
      ["a", loadedSplat("a", V2, group => group.position.set(1, 0, 0))],
      ["b", loadedSplat("b", V3, group => group.position.set(-1, 0, 0))],
    ]
    const targeted = harness(entries)
    targeted.viewer.openDefaultView("b")
    expect(targeted.calls.center).toBe(0)
    expect(targeted.viewer.camera.position.x).toBeCloseTo(-1)
    // 多环境无指定实体 = 歧义：不跳，交回既有默认（此处非环境体 ⇒ frameAll）。
    const ambiguous = harness(entries)
    ambiguous.viewer.openDefaultView()
    expect(ambiguous.calls.center).toBe(0)
    expect(ambiguous.calls.frameAll).toBe(1)
  })

  test("普通/未知 splat 没有标记时仍走既有默认行为（不跳首相机）", () => {
    const { viewer, calls } = harness([["plain", loadedSplat("plain")]])
    viewer.openDefaultView()
    expect(calls.center).toBe(0)
    expect(calls.frameAll).toBe(1)
  })
})

describe("源坐标适配：v2 默认改为 Rx(−90)，显式变换与已烘焙标记保留", () => {
  const ref = { resourceId: "r", version: 1, original: { uri: "a.ply", mimeType: "application/x-ply" }, representations: [], source: { units: "m", upAxis: "Y", handedness: "right", metersPerUnit: 1 } } as const

  test("v2 标记让 up −Y→+Z、forward +Z→+Y；无标记/v3 沿用既有 +90", () => {
    const viewer = Object.create(SceneViewer.prototype) as any
    const v2 = viewer.wrapSourceCoordinates(ref, { gaussianCameraFrame: V2 }, new THREE.Object3D())
    expect(v2.localToWorld(new THREE.Vector3(0, -1, 0)).distanceTo(new THREE.Vector3(0, 0, 1))).toBeLessThan(1e-9)
    expect(v2.localToWorld(new THREE.Vector3(0, 0, 1)).distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-9)
    const plain = viewer.wrapSourceCoordinates(ref, {}, new THREE.Object3D())
    expect(plain.localToWorld(new THREE.Vector3(0, -1, 0)).distanceTo(new THREE.Vector3(0, 0, -1))).toBeLessThan(1e-9)
    const v3 = viewer.wrapSourceCoordinates(ref, { gaussianCameraFrame: V3 }, new THREE.Object3D())
    expect(v3.localToWorld(new THREE.Vector3(0, 1, 0)).distanceTo(new THREE.Vector3(0, 0, 1))).toBeLessThan(1e-9)
    expect(v3.localToWorld(new THREE.Vector3(0, 0, -1)).distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-9)
  })

  test("调用方显式 sourceTransform 优先且不叠加；sourceTransformApplied 原样返回", () => {
    const viewer = Object.create(SceneViewer.prototype) as any
    const cloud = new THREE.Object3D()
    const explicit = { position: [3, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }
    const wrapper = viewer.wrapSourceCoordinates(ref, { gaussianCameraFrame: V2, sourceTransform: explicit }, cloud)
    // 显式变换只含平移：不叠加 v2 的 −90。
    expect(wrapper.localToWorld(new THREE.Vector3(0, -1, 0)).distanceTo(new THREE.Vector3(3, -1, 0))).toBeLessThan(1e-9)
    expect(viewer.wrapSourceCoordinates(ref, { gaussianCameraFrame: V2, sourceTransformApplied: true }, cloud)).toBe(cloud)
  })
})

describe("auto 画质默认预算：已识别高精场景才提上限，用户显式画质与软件渲染优先", () => {
  test("已识别高精把非软件设备的 auto 上限提到既有 500k；普通资产与软件渲染不变", () => {
    expect(interactiveSplatBudget("intel").lodSplatCount).toBe(100000)
    expect(interactiveSplatBudget("intel", "auto", { recognizedHighScene: true }).lodSplatCount).toBe(500000)
    expect(interactiveSplatBudget("amd", "auto", { recognizedHighScene: true }).lodSplatCount).toBe(500000)
    expect(interactiveSplatBudget("unknown", "auto", { recognizedHighScene: true }).lodSplatCount).toBe(500000)
    expect(interactiveSplatBudget("software", "auto", { recognizedHighScene: true }).lodSplatCount).toBe(50000)
    expect(interactiveSplatBudget("intel", "fast", { recognizedHighScene: true }).lodSplatCount).toBe(100000)
    expect(interactiveSplatBudget("intel", "balanced", { recognizedHighScene: true }).lodSplatCount).toBe(250000)
    expect(interactiveSplatBudget("intel", "quality", { recognizedHighScene: true }).lodSplatCount).toBe(500000)
  })

  test("高精判据：v3 总是；v2 仅大型（≥100 万点）；未知/无点数不置位", () => {
    expect(recognizedHighSplatVisual({ gaussianCameraFrame: V3 })).toBe(true)
    expect(recognizedHighSplatVisual({ gaussianCameraFrame: V2, sourcePointCount: 5_418_490 })).toBe(true)
    expect(recognizedHighSplatVisual({ gaussianCameraFrame: V2, sourcePointCount: 999_999 })).toBe(false)
    expect(recognizedHighSplatVisual({ gaussianCameraFrame: V2 })).toBe(false)
    expect(recognizedHighSplatVisual({ kind: "splat" })).toBe(false)
    expect(recognizedHighSplatVisual(undefined)).toBe(false)
  })

  test("Viewer 的预算唯一写入口按 recognizedHighSplat + 用户画质刷新；spark 在场时同步", () => {
    const viewer = Object.create(SceneViewer.prototype) as any
    const gl = {
      VENDOR: 1, RENDERER: 2, VERSION: 3, SAMPLES: 0, drawingBufferWidth: 1280, drawingBufferHeight: 720,
      isContextLost: () => false, getContextAttributes: () => ({}),
      getExtension: () => ({ UNMASKED_VENDOR_WEBGL: 4, UNMASKED_RENDERER_WEBGL: 5 }),
      getParameter: (parameter: number) => parameter === 4 ? "Intel Inc." : parameter === 5 ? "Mesa Intel" : parameter === 3 ? "WebGL 2.0" : 0,
    }
    viewer.renderer = { getContext: () => gl, domElement: {} }
    viewer.display = { grid: true, axes: true, background: "#000", wireframe: false, splats: true }
    viewer.spark = { lodSplatCount: 0, lodRenderScale: 0 }
    viewer.recognizedHighSplat = true
    viewer.refreshSplatBudget()
    expect(viewer.splatBudget.lodSplatCount).toBe(500000)
    expect(viewer.spark.lodSplatCount).toBe(500000)
    viewer.display = { ...viewer.display, splatQuality: "fast" }
    viewer.refreshSplatBudget()
    expect(viewer.splatBudget.lodSplatCount).toBe(100000)
    viewer.recognizedHighSplat = false
    viewer.display = { ...viewer.display, splatQuality: "auto" }
    viewer.refreshSplatBudget()
    expect(viewer.splatBudget.lodSplatCount).toBe(100000)
  })
})

describe("文件预览事实链：真实 PLY 头 → recognizedHigh → auto 预算", () => {
  test("旧 v2 百万级：文件标签页与工作台同判据，Intel/AMD/unknown auto 提到 500k；软件与显式画质仍优先", () => {
    const largeV2 = previewVisual(productionHeader(V2, 5_418_490))
    expect(recognizedHighSplatVisual(largeV2)).toBe(true)
    const budget = (vendor: string, quality: "auto" | "fast" | "balanced" | "quality" = "auto") =>
      interactiveSplatBudget(vendor, quality, { recognizedHighScene: recognizedHighSplatVisual(largeV2) }).lodSplatCount
    expect(budget("intel")).toBe(500000)
    expect(budget("amd")).toBe(500000)
    expect(budget("unknown")).toBe(500000)
    expect(budget("software")).toBe(50000)
    expect(budget("intel", "fast")).toBe(100000)
    expect(budget("intel", "balanced")).toBe(250000)
    expect(budget("intel", "quality")).toBe(500000)
  })

  test("新标准 v3 无论点数按高精；旧小 v2 与普通无标记保持既有 auto 预算", () => {
    expect(recognizedHighSplatVisual(previewVisual(productionHeader(V3, 1)))).toBe(true)
    const smallV2 = previewVisual(productionHeader(V2, 999_999))
    expect(recognizedHighSplatVisual(smallV2)).toBe(false)
    expect(interactiveSplatBudget("intel", "auto", { recognizedHighScene: recognizedHighSplatVisual(smallV2) }).lodSplatCount).toBe(100000)
    const plain = { kind: "splat", sourceTransformApplied: false }
    expect(recognizedHighSplatVisual(plain)).toBe(false)
    expect(interactiveSplatBudget("intel", "auto", { recognizedHighScene: recognizedHighSplatVisual(plain) }).lodSplatCount).toBe(100000)
  })

  test("0/unsafe count、重复/冲突/未知 frame 的头不给出可升级事实", () => {
    expect(previewVisual(productionHeader(V2, 0))).toEqual({ kind: "splat", sourceTransformApplied: false })
    expect(previewVisual(productionHeader(V2, "99999999999999999999"))).toEqual({ kind: "splat", sourceTransformApplied: false })
    const duplicate = productionHeader(V2, 2_000_000, [GAUSSIAN_CAMERA_FRAME_MARKERS[V2]])
    const conflict = productionHeader(V2, 2_000_000, [GAUSSIAN_CAMERA_FRAME_MARKERS[V3]])
    const unknownMixed = productionHeader(V2, 2_000_000, ["comment Lyapunov idle coordinate_frame future_v9"])
    for (const bytes of [duplicate, conflict, unknownMixed]) {
      expect(previewVisual(bytes)).toEqual({ kind: "splat", sourceTransformApplied: false })
      expect(recognizedHighSplatVisual(previewVisual(bytes))).toBe(false)
    }
  })
})
