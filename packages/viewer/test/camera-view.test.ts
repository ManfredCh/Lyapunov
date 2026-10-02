/**
 * "把指定相机摆进原生 Viewer / 按指定相机出图"的**真实几何行为**测试。
 *
 * 判据不是"序列化往返一致"，而是**真实 three 的投影**：每个用例都把归一化后的视角写进一台真实的
 * `THREE.PerspectiveCamera`（+ 真实 `OrbitControls`，它的 `domElement` 用最小 stub），然后
 *   · 用 `Vector3.project` 把若干世界点投到像素，与解析内参公式 `projectToPixel` 逐点比；
 *   · 用 `describeCameraView` 从**相机里量出来**的 K / roll / 投影矩阵，与请求（按画布缩放后）比。
 * 于是"内参、宽高比、roll、窗口 resize 都真的落到了投影上"是量出来的，不是声明的。
 *
 * 生产与测试调用的是**同一份实现**，测试里没有重写调用顺序（否则量到的只是测试自己）：
 *   · `writeViewToCamera` —— 写相机 + 转心 + `controls.update()` 复算 + 当场核对（`SceneViewer.writeCameraView`
 *     与"按指定相机出图"的专用相机都走它）；
 *   · `cameraStateFromView` —— `getViewState` 的量法；
 *   · `cameraRequestFromState` —— `setViewState` / 命名相机恢复的映射；
 *   · `setCameraIntrinsics` —— `resizeCanvas` 的 resize 分支；
 *   · `normalizeCameraRequest` —— 请求归一化（含冲突拒绝）。
 *
 * 相机应用/部分更新那两条走的是**真 `SceneViewer` 原型 + 假画布**（`viewerRig`）：`applyCameraView`
 * 连同它用来读"此刻是什么样"的 `cameraCurrent()` 都是产品代码，只有画布不是真的。
 *
 * 边界（不冒充已完成）：这里**没有** WebGL、没有真实浏览器画布，所以下面这些没有在这里跑，
 * 需要真实 WebGL 上下文与浏览器：`SceneViewer.renderCameraImage` 的"换画布尺寸 → render → toDataURL →
 * 还原"、`resizeCanvas` 的 ResizeObserver 触发、以及"窗口里那个 Viewer 实例"本身（含它的真实画面像素）。
 * 这里跑的是它们每一步用的**同一份相机数学与同一份写入顺序**（出图那一半用一台独立的真实
 * `PerspectiveCamera` 按出图尺寸复现）。真浏览器 / 真实模型里的整条路径由根在模型侧验收。
 * 运行：`bun test packages/viewer/test/camera-view.test.ts`
 */
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import * as THREE from "three"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import {
  applyViewToCamera, assertRenderSize, cameraPointToWorld, cameraRequestFromState, cameraStateFromView, describeCameraView,
  fovXFromIntrinsics, fovYFromIntrinsics, isPlainLens, normalizeCameraRequest, normalizeIntrinsics, principalPointOffsetPx,
  projectToPixel, projectionMatrixFromIntrinsics, quaternionAngleDeg, rotationMatrixColumnsFromQuaternion, scaleIntrinsics,
  setCameraIntrinsics, verifyAppliedView, writeViewToCamera, ViewerCameraError,
  type MeasurableCamera, type ViewerCameraIntrinsics, type ViewerCameraMeasurement, type ViewerCameraRequest, type ViewerVec3, type ViewerQuat,
} from "../src/camera-view.ts"
import { SceneViewer } from "../src/index.ts"
import { FrameProjection } from "../src/projection.ts"

const DEG = Math.PI / 180

/**
 * OrbitControls 的 `domElement` stub：只提供它构造/连接/断开时真正会碰到的成员。
 * 为什么用**真** OrbitControls 而不是替身：正是它每帧 `lookAt(转心)` 会按 `camera.up` 重写姿态，
 * 这一块要量的就是"我们的写法能不能让真实 OrbitControls 复现同一个姿态"。
 */
const stubDocument = { addEventListener() {}, removeEventListener() {} }
;(globalThis as Record<string, unknown>).document = stubDocument
const stubElement = () => ({
  style: {} as Record<string, string>,
  addEventListener() {}, removeEventListener() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 }),
  clientWidth: 1280, clientHeight: 720,
  setPointerCapture() {}, releasePointerCapture() {},
  ownerDocument: stubDocument, getRootNode: () => stubDocument,
} as unknown as HTMLElement)

interface Size { width: number; height: number }

/** 与 `SceneViewer` 构造时同一套起步状态（Z-up 相机 + 真实 OrbitControls + 同一初始机位）。 */
function rig(size: Size) {
  const camera = new THREE.PerspectiveCamera(50, size.width / size.height, 0.1, 1000)
  camera.up.set(0, 0, 1)
  camera.position.set(5, -6, 4)
  const controls = new OrbitControls(camera, stubElement())
  controls.target.set(0, 0, 0.7)
  controls.update()
  return { camera, controls, size }
}

const v3 = (value: readonly number[]): THREE.Vector3 => new THREE.Vector3(value[0]!, value[1]!, value[2]!)
const q4 = (value: ViewerQuat): THREE.Quaternion => new THREE.Quaternion(value[0], value[1], value[2], value[3])
const cameraUpOf = (quaternion: ViewerQuat): ViewerVec3 => new THREE.Vector3(0, 1, 0).applyQuaternion(q4(quaternion)).toArray() as ViewerVec3

/** 驱动真原型要用到的那些"缝"：相机应用/读数 + resize（`resizeCanvas` 是产品方法，只是私有）。 */
interface SceneViewerRig {
  applyCameraView(request: ViewerCameraRequest): ViewerCameraMeasurement
  cameraView(): ViewerCameraMeasurement
  resizeCanvas(): void
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  options: { container: { clientWidth: number; clientHeight: number } }
}
/**
 * 一台"**真 `SceneViewer` 原型 + 假画布**"的实例：`applyCameraView` / `cameraView` / `resizeCanvas`
 * 用的都是产品那一份方法，只有画布（`renderer.domElement`）是假的（没有 WebGL 上下文）。
 *
 * 为什么必须走真原型：`applyCameraView` 归一化时的"此刻是什么样"来自 `SceneViewer.cameraCurrent()`——
 * 它有没有把**姿态（含 roll）**报出来，正是"只给 fov 的部分更新会不会把 roll 抹平"的答案。
 * 自己手写一份 current 再测，测的只是测试自己那份；`Object.create` 拿到的实例上跑的是产品代码。
 */
function viewerRig(size: Size) {
  const viewer: any = Object.create(SceneViewer.prototype)
  const canvas = { width: size.width, height: size.height, toDataURL: () => "data:image/png;base64," }
  viewer.renderer = {
    domElement: canvas, toneMappingExposure: 1, pixelRatio: 1,
    getPixelRatio() { return viewer.renderer.pixelRatio as number },
    setPixelRatio(value: number) { viewer.renderer.pixelRatio = value },
    // 与 three 的 `setSize` 同一件事：改的是**着色缓冲**像素（`canvasPixels()` 读的就是它）。
    setSize(width: number, height: number) { canvas.width = Math.round(width * viewer.renderer.pixelRatio); canvas.height = Math.round(height * viewer.renderer.pixelRatio) },
    render() {},
  }
  viewer.options = {
    container: { clientWidth: size.width, clientHeight: size.height },
    resolveResource: () => Promise.reject(new Error("FAKE_VIEWER_NO_RESOURCES: 这个替身没有资源可解析")),
    onError() {},
  }
  viewer.scene = new THREE.Scene()
  viewer.scene.environmentIntensity = 1
  viewer.projection = new FrameProjection()
  viewer.objects = new Map()
  viewer.camera = new THREE.PerspectiveCamera(50, size.width / size.height, 0.1, 1000)
  viewer.camera.up.set(0, 0, 1)
  viewer.camera.position.set(5, -6, 4)
  viewer.controls = new OrbitControls(viewer.camera, stubElement())
  viewer.controls.target.set(0, 0, 0.7)
  viewer.controls.update()
  viewer.disposed = false
  viewer.editing = false
  viewer.display = { grid: true, axes: true, background: "#121a24", wireframe: false, splats: true, collision: false }
  viewer.environmentDiagnostics = []
  viewer.environmentClock = { playing: false, offsetHours: 0, advancedSeconds: 0 }
  viewer.hemisphere = { intensity: 1 }
  viewer.sun = { castShadow: true, intensity: 1 }
  return viewer as SceneViewerRig
}

/** 真实 three 投影 → 像素（**像素中心口径**，与 `projectToPixel` 同一套坐标：col 向右、row 向下）。 */
function realPixel(camera: THREE.PerspectiveCamera, world: ViewerVec3, size: Size): [number, number] {
  camera.updateMatrixWorld(true)
  const ndc = v3(world).project(camera)
  return [(ndc.x + 1) / 2 * size.width - 0.5, (1 - ndc.y) / 2 * size.height - 0.5]
}
/** 相机系采样点：不同深度、含画面边缘之外，避免只测主点附近。 */
const PROBE_POINTS: readonly ViewerVec3[] = [[0, 0, -3], [1.2, 0.4, -5], [-0.7, -0.9, -2.5], [0.35, -1.6, -6.5], [-1.15, 1.3, -4.2], [2.4, 2.1, -9]]
/** 相机系采样点 → 世界系（用**相机里量出来的**位姿，投影差里才不掺位姿差）。 */
const worldOf = (camera: THREE.PerspectiveCamera, point: ViewerVec3): ViewerVec3 =>
  cameraPointToWorld(camera.position.toArray() as ViewerVec3, camera.quaternion.toArray() as ViewerQuat, point)

/** 解析内参 vs 真实 three 投影：逐点比像素位置，返回最大像素差。 */
function expectProjectionMatches(camera: THREE.PerspectiveCamera, k: ViewerCameraIntrinsics, size: Size): number {
  let worst = 0
  for (const point of PROBE_POINTS) {
    const analytic = projectToPixel(k, point)
    expect(analytic).toBeDefined()
    const actual = realPixel(camera, worldOf(camera, point), size)
    worst = Math.max(worst, Math.abs(analytic![0] - actual[0]), Math.abs(analytic![1] - actual[1]))
  }
  expect(worst).toBeLessThan(1e-6 * Math.max(size.width, size.height))
  return worst
}
/** 逐元素比对两组内参（像素容差）。 */
function expectIntrinsicsClose(actual: ViewerCameraIntrinsics, expected: ViewerCameraIntrinsics, tolerancePx = 1e-6): void {
  const worst = Math.max(...(["fx", "fy", "cx", "cy"] as const).map(key => Math.abs(actual[key] - expected[key])))
  if (!(worst <= tolerancePx)) throw new Error(`内参不一致：实测 ${JSON.stringify(actual)} vs 期望 ${JSON.stringify(expected)}（最大差 ${worst}）`)
  expect([actual.width, actual.height]).toEqual([expected.width, expected.height])
}
/**
 * 逐个比对一组数（默认容差 1e-12）：`OrbitControls.update()` 会把相机位置经球坐标绕一圈
 * （`position = target + offset`），**它自己**每帧带出 1e-15 量级的漂移，所以这里不能用精确相等。
 */
function expectPointClose(actual: readonly number[], expected: readonly number[], tolerance = 1e-12, label = "点"): void {
  expect(actual.length).toBe(expected.length)
  const worst = Math.max(...actual.map((value, index) => Math.abs(value - expected[index]!)))
  if (!(worst <= tolerance)) throw new Error(`${label}不一致：实测 [${actual.join(", ")}] vs 期望 [${expected.join(", ")}]（最大差 ${worst}）`)
}
/**
 * 一个带 roll 的机位：基准朝向由 lookAt 定（读数 0），再绕**视轴**转 `rollDeg`。
 * 轴取相机 +z（从目标指向相机后方）：`rollDegrees` 在相机自身坐标系里逆时针为正，绕它转 θ 读数就是 +θ。
 */
function rolledRequest(rollDeg: number, extra: ViewerCameraRequest = {}): ViewerCameraRequest {
  const position = new THREE.Vector3(1.4, -2.1, 0.9)
  const target = new THREE.Vector3(0, 0, 0.6)
  const back = position.clone().sub(target).normalize()
  const base = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(position, target, new THREE.Vector3(0, 0, 1)))
  const quaternion = new THREE.Quaternion().setFromAxisAngle(back, rollDeg * DEG).multiply(base)
  return { position: position.toArray(), quaternion: quaternion.toArray(), target: target.toArray(), near: 0.05, far: 500, ...extra }
}
/**
 * 列 = 相机轴的 3×3（**独立于本模块**地用 three 算一遍：核对本模块的旋转矩阵口径）。
 * three 的 `elements` 是**列主序**，`e[0..2]` 就是第一列 = 相机 x 轴，所以行是 `[e0,e4,e8]` 这样取的。
 */
function threeRotationMatrix(quaternion: ViewerQuat): number[][] {
  const e = new THREE.Matrix4().makeRotationFromQuaternion(q4(quaternion)).elements
  return [[e[0]!, e[4]!, e[8]!], [e[1]!, e[5]!, e[9]!], [e[2]!, e[6]!, e[10]!]]
}
/** `ViewerCameraError.code`；不抛或抛别的都如实记下来（不把"没抛"当成通过）。 */
const errorCode = (fn: () => unknown): string => {
  try { fn() } catch (error) { return error instanceof ViewerCameraError ? error.code : `NOT_VIEWER_CAMERA_ERROR:${String(error)}` }
  return "NO_THROW"
}

describe("内参真的落到投影上（真实 three 投影 vs 解析 K）", () => {
  const shapes: Array<{ label: string; intrinsics: ViewerCameraIntrinsics }> = [
    { label: "居中方形像素 960×540", intrinsics: { fx: 700, fy: 700, cx: 479.5, cy: 269.5, width: 960, height: 540 } },
    { label: "非方形像素 fx≠fy（812.5 vs 700）", intrinsics: { fx: 812.5, fy: 700, cx: 479.5, cy: 269.5, width: 960, height: 540 } },
    { label: "主点偏心（430, 300）", intrinsics: { fx: 820, fy: 815, cx: 430, cy: 300, width: 960, height: 540 } },
    { label: "竖构图 1080×1920 + 偏心主点", intrinsics: { fx: 1100, fy: 1090, cx: 520, cy: 1005, width: 1080, height: 1920 } },
  ]
  const canvases: Size[] = [{ width: 960, height: 540 }, { width: 1280, height: 720 }, { width: 800, height: 1200 }]

  for (const shape of shapes) {
    for (const canvas of canvases) {
      it(`${shape.label} → 画布 ${canvas.width}×${canvas.height}：带 roll 的机位逐点投影像素一致`, () => {
        const app = rig(canvas)
        const view = normalizeCameraRequest(rolledRequest(23.5, { intrinsics: shape.intrinsics }), { fovYDeg: 50 })
        const verification = writeViewToCamera(app.camera, app.controls, view, canvas)
        expect(verification.errors).toEqual([])
        // 画布尺寸 ≠ 照片尺寸：按画布等比缩放后的 K 才是"这台相机此刻的内参"。
        const expected = scaleIntrinsics(shape.intrinsics, canvas.width, canvas.height)
        const measured = describeCameraView(app.camera, canvas, view.up)
        expectIntrinsicsClose(measured.intrinsics, expected)
        expectProjectionMatches(app.camera, expected, canvas)
        // 投影矩阵与按 K 的解析式逐元素一致（宿主就是用这条核对回执里的内参）。
        const analytic = projectionMatrixFromIntrinsics(expected, view.near, view.far)
        expect(Math.max(...analytic.map((value, index) => Math.abs(value - measured.projectionMatrix[index]!)))).toBeLessThan(1e-9)
        // roll 既没被 target 抹掉，也没被 controls.update() 抹掉。
        expect(Math.abs(measured.rollDeg - 23.5)).toBeLessThan(1e-3)
        // 而且用真实投影量到的 K 反推内参也回到同一份（`intrinsicsFromProjectionMatrix` 的逆向核验）。
        expect(measured.intrinsics.fx).toBeCloseTo(expected.fx, 3)
      })
    }
  }
})

describe("roll / target / up 不互相覆盖（真实 OrbitControls）", () => {
  it("带 roll 的机位经过 controls.update() 仍逐位复现（差 < 1e-3°）", () => {
    const app = rig({ width: 1280, height: 720 })
    const view = normalizeCameraRequest(rolledRequest(23.5), { fovYDeg: 50 })
    expect(Math.abs(view.rollDeg - 23.5)).toBeLessThan(1e-6)
    const verification = writeViewToCamera(app.camera, app.controls, view, app.size)
    expect(verification.errors).toEqual([])
    expect(quaternionAngleDeg(verification.measured.quaternion, view.quaternion)).toBeLessThan(1e-3)
    // 写进相机的 up 是**相机自身 y 轴**（含 roll），不是世界 up。
    const expectedUp = cameraUpOf(view.quaternion)
    expect(Math.max(...expectedUp.map((value, index) => Math.abs(value - verification.measured.up[index]!)))).toBeLessThan(1e-6)
    expect(Math.abs(expectedUp[2]! - 1)).toBeGreaterThan(0.01)
  })

  it("旧行为（camera.up 不跟着姿态走）会把 roll 抹平——本次修的就是这一条", () => {
    const app = rig({ width: 1280, height: 720 })
    const view = normalizeCameraRequest(rolledRequest(23.5), { fovYDeg: 50 })
    applyViewToCamera(app.camera, view, app.size)
    app.camera.up.set(0, 0, 1) // 老实现：只写 position/quaternion/target，up 一直是世界 up
    app.controls.target.set(...view.target)
    app.controls.update()
    const measured = describeCameraView(app.camera, app.size, view.up)
    expect(quaternionAngleDeg(measured.quaternion, view.quaternion)).toBeGreaterThan(20)
    expect(Math.abs(measured.rollDeg)).toBeLessThan(0.5)
    // 而且当场核对会抓住它（不返回"看起来成功"的读数）。
    const verification = verifyAppliedView(app.camera, view, app.size, { target: app.controls.target.toArray() as ViewerVec3 })
    expect(verification.ok).toBe(false)
    expect(verification.errors.join("｜")).toMatch(/姿态没复现|camera\.up/)
  })

  it("target 放在视线上（换个距离）：转心跟着走，姿态与 roll 一字不动", () => {
    const app = rig({ width: 1280, height: 720 })
    const base = rolledRequest(23.5)
    const quaternion = base.quaternion as ViewerQuat
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q4(quaternion))
    const shifted = v3(base.position as ViewerVec3).addScaledVector(forward, 1.25).toArray() as ViewerVec3
    const view = normalizeCameraRequest({ ...base, target: shifted }, { fovYDeg: 50 })
    const verification = writeViewToCamera(app.camera, app.controls, view, app.size)
    expect(verification.errors).toEqual([])
    expect(quaternionAngleDeg(verification.measured.quaternion, view.quaternion)).toBeLessThan(1e-3)
    expect(Math.abs(verification.measured.rollDeg - 23.5)).toBeLessThan(1e-3)
    // 转心确实落在视线上那个新距离处（不是被忽略后留在默认距离）。
    expect(app.controls.target.distanceTo(v3(shifted))).toBeLessThan(1e-6)
    expect(view.targetDistanceM).toBeCloseTo(1.25, 9)
  })

  it("只给 target（没有朝向）：roll 必须是 0，camera.up = 世界 up，且真实 controls 复现", () => {
    const app = rig({ width: 1280, height: 720 })
    const view = normalizeCameraRequest({ position: [3, -3.2, 1.4], target: [0, 0, 0.6], up: [0, 0, 1] }, { fovYDeg: 50 })
    expect(view.orientationSource).toBe("target")
    expect(Math.abs(view.rollDeg)).toBeLessThan(1e-6)
    expect(view.cameraUp[2]).toBeCloseTo(1, 12)
    expect(Math.hypot(view.cameraUp[0], view.cameraUp[1])).toBeLessThan(1e-12)
    expect(writeViewToCamera(app.camera, app.controls, view, app.size).errors).toEqual([])
    expect(Math.abs(describeCameraView(app.camera, app.size, view.up).rollDeg)).toBeLessThan(1e-6)
  })

  it("显式 cameraUp 与姿态一致时照用（命名相机 / 状态恢复那条路）", () => {
    const app = rig({ width: 1280, height: 720 })
    const base = rolledRequest(23.5)
    const view = normalizeCameraRequest({ ...base, cameraUp: cameraUpOf(base.quaternion as ViewerQuat) }, { fovYDeg: 50 })
    const verification = writeViewToCamera(app.camera, app.controls, view, app.size)
    expect(verification.errors).toEqual([])
    expect(Math.abs(verification.measured.rollDeg - 23.5)).toBeLessThan(1e-3)
  })

  it("显式 cameraUp 与姿态矛盾：应用之后当场核对失败（不会静默给出一个被拧过的姿态）", () => {
    const app = rig({ width: 1280, height: 720 })
    // `cameraUp` 是"要写进 camera.up 的东西"，与姿态是否自洽只能在**写进去之后量**（controls.update() 会按它复算）
    const view = normalizeCameraRequest({ ...rolledRequest(23.5), cameraUp: [0, 0, 1] }, { fovYDeg: 50 })
    const verification = writeViewToCamera(app.camera, app.controls, view, app.size)
    expect(verification.ok).toBe(false)
    expect(verification.errors.join("｜")).toMatch(/姿态没复现|camera\.up/)
    expect(quaternionAngleDeg(verification.measured.quaternion, view.quaternion)).toBeGreaterThan(20)
  })
})

describe("部分更新：只给 fov/near 这类字段时沿用当前相机（真 SceneViewer 实例的方法）", () => {
  /** 先把画布摆成一台"照片相机"：竖幅不必要，但带 roll + 偏心 K 才能看出有没有被抹平。 */
  const photo: ViewerCameraIntrinsics = { fx: 745, fy: 736, cx: 600, cy: 350, width: 960, height: 540 }
  const setup = (rollDeg: number) => {
    const app = viewerRig({ width: 1280, height: 720 })
    app.applyCameraView(rolledRequest(rollDeg, { intrinsics: photo }))
    const before = app.cameraView()
    expect(Math.abs(before.rollDeg - rollDeg)).toBeLessThan(1e-3)
    // 归一化那一份要看的"此刻是什么样"：只读一遍说明（姿态那一项在真路径里由 `cameraCurrent()` 给）。
    const current = { position: before.position, quaternion: before.quaternion, cameraUp: before.up, target: app.controls.target.toArray() as ViewerVec3, fovYDeg: before.fovYDeg, intrinsics: before.intrinsics }
    const notesOf = (request: ViewerCameraRequest) => normalizeCameraRequest(request, current)
    return { app, before, targetBefore: app.controls.target.clone(), notesOf }
  }

  it("只给 fovYDeg（含 near）：姿态逐位不变、roll 一字不动，只有镜头换了", () => {
    const { app, before, targetBefore, notesOf } = setup(23.5)
    const after = app.applyCameraView({ fovYDeg: 30, near: 0.08 })
    // 姿态是**沿用**的：位置/四元数/相机 up 都逐位相同（不是"看起来差不多"）。
    expectPointClose(after.position, before.position, 1e-12, "应用后的相机位置")
    // `controls.update()` 会按 (position, target, up) 重新 lookAt 一次，三角运算带出 ~1e-6 度的噪声
    // （实测 2.4e-6°，在任何分辨率下都远不到一个像素）——这就是"沿用姿态"能到的最紧的程度。
    expect(quaternionAngleDeg(after.quaternion, before.quaternion)).toBeLessThan(1e-4)
    expectPointClose(after.up, before.up, 1e-12, "相机 up 轴")
    expect(Math.abs(after.rollDeg - 23.5)).toBeLessThan(1e-3)
    // 转心也在原处（不然下一帧 controls.update() 会按新转心把姿态拧走）。
    expect(app.controls.target.distanceTo(targetBefore)).toBeLessThan(1e-9)
    // 换的只有被点名的那些：fov/near 变了，far 沿用。
    expect(after.fovYDeg).toBeCloseTo(30, 9)
    expect(after.near).toBeCloseTo(0.08, 12)
    expect(after.far).toBeCloseTo(before.far, 12)
    // 这条是部分更新，回执里要如实说清"哪些是沿用的"（不然模型会以为姿态也是请求给的）。
    const view = notesOf({ fovYDeg: 30, near: 0.08 })
    expect(view.orientationSource).toBe("current")
    expect(view.notes.join("｜")).toMatch(/没给朝向：沿用当前相机的姿态/)
  })

  it("只给 near/far（一个投影字段都没给）：内参连同主点偏移/非方形像素一起沿用，姿态也不动", () => {
    const { app, before, targetBefore, notesOf } = setup(23.5)
    const after = app.applyCameraView({ near: 0.05, far: 800 })
    expectPointClose(after.position, before.position, 1e-12, "应用后的相机位置")
    expect(quaternionAngleDeg(after.quaternion, before.quaternion)).toBeLessThan(1e-4)
    expectPointClose(after.up, before.up, 1e-12, "相机 up 轴")
    expect(Math.abs(after.rollDeg - 23.5)).toBeLessThan(1e-3)
    expect(app.controls.target.distanceTo(targetBefore)).toBeLessThan(1e-9)
    // 照片内参（fx≠fy + 偏心主点）没有因为"没给投影"被换成居中针孔：视口偏移与 K 都还在。
    expect(after.viewOffset).not.toBeNull()
    expectIntrinsicsClose(after.intrinsics, before.intrinsics, 1e-9)
    expect([after.near, after.far]).toEqual([0.05, 800])
    const view = notesOf({ near: 0.05, far: 800 })
    expect(view.projectionSource).toBe("keep")
    expect(view.notes.join("｜")).toMatch(/沿用当前内参/)
  })

  it("真原型的 cameraCurrent() 必须把姿态（含 up 轴）报出来——「沿用 roll」这条路的唯一来源", () => {
    const { app, before } = setup(-14.25)
    // 直接把 `applyCameraView` 归一化时的输入面摊开看：current 里有位置/姿态/相机 up/转心/视场。
    const current = { position: before.position, quaternion: before.quaternion, cameraUp: before.up, target: app.controls.target.toArray() as ViewerVec3, fovYDeg: before.fovYDeg }
    const view = normalizeCameraRequest({ fovYDeg: 45 }, current)
    expect(view.orientationSource).toBe("current")
    expect(Math.abs(view.rollDeg + 14.25)).toBeLessThan(1e-6)
    expect(view.cameraUp).toEqual(before.up)
    // 反过来说：current 里**没有**姿态时这条路不会拿转心 + 世界 up 现拍一个（那会把 roll 归零），
    // 而是明确失败——所以 `cameraCurrent()` 少报一个姿态字段，这个功能就整体不成立。
    expect(errorCode(() => normalizeCameraRequest({ fovYDeg: 45 }, { position: before.position, target: app.controls.target.toArray() as ViewerVec3, fovYDeg: before.fovYDeg }))).toBe("VIEWER_CAMERA_INVALID")
  })
})

describe("相机块里的字段与顶层同名同义（104 报的「块里的 fovYDeg 被静默忽略」）", () => {
  const photo: ViewerCameraIntrinsics = { fx: 745, fy: 736, cx: 600, cy: 350, width: 960, height: 540 }
  /** 一台带 roll 的真原型相机：后面每一问都从"上一次是 60°"这个前情开始（104 的实测就是这条链）。 */
  const rigAtSixty = () => {
    const app = viewerRig({ width: 1280, height: 720 })
    app.applyCameraView(rolledRequest(23.5, { intrinsics: photo }))
    const first = app.applyCameraView({ position: [1.4, -2.1, 0.9], target: [0, 0, 0.6], fovYDeg: 60 })
    expect(first.fovYDeg).toBeCloseTo(60, 9)
    const current = { position: first.position, quaternion: first.quaternion, cameraUp: first.up, target: app.controls.target.toArray() as ViewerVec3, fovYDeg: first.fovYDeg, intrinsics: first.intrinsics }
    return { app, first, notesOf: (request: ViewerCameraRequest) => normalizeCameraRequest(request, current) }
  }

  it("上一次 60° → `camera:{…,fovYDeg:65}`：镜头真换成 65°（连同 near/far），不是沿用上一次", () => {
    const { app, notesOf } = rigAtSixty()
    const block = { position: [3, -3.2, 1.4] as ViewerVec3, target: [0, 0, 0.6] as ViewerVec3, fovYDeg: 65, near: 0.05, far: 500 }
    const after = app.applyCameraView({ camera: block })
    expect(after.fovYDeg).toBeCloseTo(65, 9)
    expect([after.near, after.far]).toEqual([0.05, 500])
    expectPointClose(after.position, block.position, 1e-9, "块里请求的位置")
    // 回执的说明里不能再说"沿用当前垂直视场角"——那正是这次被修掉的静默行为。
    const view = notesOf({ camera: block })
    expect(view.projectionSource).toBe("fov")
    expect(view.fovYDeg).toBeCloseTo(65, 9)
    expect(view.notes.join("｜")).not.toMatch(/沿用当前垂直视场角/)
  })

  it("camera_fit 的拼写 `fov_y_deg` 在块里照旧有效；两种拼写写两个值就拒（不是谁盖谁）", () => {
    const { notesOf } = rigAtSixty()
    expect(notesOf({ camera: { fov_y_deg: 65 } }).fovYDeg).toBeCloseTo(65, 9)
    expect(errorCode(() => notesOf({ camera: { fovYDeg: 65, fov_y_deg: 50 } }))).toBe("VIEWER_CAMERA_CONFLICT")
  })

  it("顶层与块给的是两套说法：对不上就拒，说一样才放过", () => {
    const { notesOf } = rigAtSixty()
    expect(errorCode(() => notesOf({ fovYDeg: 50, camera: { fovYDeg: 65 } }))).toBe("VIEWER_CAMERA_CONFLICT")
    expect(errorCode(() => notesOf({ near: 0.02, camera: { near: 0.05 } }))).toBe("VIEWER_CAMERA_CONFLICT")
    // 块里的 fov 与另一处给的 K 同样要互相核对（不是只看同一个字段的两种写法）。
    expect(errorCode(() => notesOf({ intrinsics: photo, camera: { fovYDeg: 65 } }))).toBe("VIEWER_CAMERA_CONFLICT")
    // 同一件事说两遍（值相同）不算矛盾；各说各的字段（顶层 far + 块里 near）各归各位。
    expect(notesOf({ fovYDeg: 65, camera: { fovYDeg: 65 } }).fovYDeg).toBeCloseTo(65, 9)
    const split = notesOf({ far: 800, camera: { near: 0.05 } })
    expect([split.near, split.far]).toEqual([0.05, 800])
  })

  it("块里的 `cameraUp` 是相机 up 轴（块里只给 `up` 时仍按 camera_fit 旧形状读，两条都钉住）", () => {
    const { notesOf } = rigAtSixty()
    expect(notesOf({ camera: { position: [3, -3.2, 1.4], target: [0, 0, 0.6], cameraUp: [0, 1, 0] } }).cameraUp).toEqual([0, 1, 0])
    // 旧形状：块里只有 `up`（没有 `cameraUp`）时它仍是**相机 up 轴**——既有口径，不因为这次统一而改。
    expect(notesOf({ camera: { position: [3, -3.2, 1.4], target: [0, 0, 0.6], up: [0, 1, 0] } }).cameraUp).toEqual([0, 1, 0])
  })
})

describe("冲突与非法输入：拒绝而不是猜", () => {
  it("位姿来源互相矛盾 → CONFLICT", () => {
    const base = rolledRequest(23.5)
    const other = rolledRequest(40).quaternion as ViewerQuat
    expect(errorCode(() => normalizeCameraRequest({ ...base, rotationMatrix: threeRotationMatrix(other) }, { fovYDeg: 50 }))).toBe("VIEWER_CAMERA_CONFLICT")
  })

  it("target 不在视线上 → CONFLICT", () => {
    expect(errorCode(() => normalizeCameraRequest({ ...rolledRequest(23.5), target: [4, 4, 4] }, { fovYDeg: 50 }))).toBe("VIEWER_CAMERA_CONFLICT")
  })

  it("fov 与内参矛盾 → CONFLICT；自洽时以 K 为准并记一条说明", () => {
    const intrinsics: ViewerCameraIntrinsics = { fx: 700, fy: 700, cx: 479.5, cy: 269.5, width: 960, height: 540 }
    expect(errorCode(() => normalizeCameraRequest(rolledRequest(0, { intrinsics, fovYDeg: 60 }), {}))).toBe("VIEWER_CAMERA_CONFLICT")
    const view = normalizeCameraRequest(rolledRequest(0, { intrinsics, fovYDeg: fovYFromIntrinsics(intrinsics) }), {})
    expect(view.projectionSource).toBe("intrinsics")
    expect(view.notes.join("｜")).toMatch(/自洽/)
  })

  it("没有朝向、near/far 不合法、尺寸不合法都是 INVALID", () => {
    expect(errorCode(() => normalizeCameraRequest({ position: [1, 2, 3], fovYDeg: 50 }, {}))).toBe("VIEWER_CAMERA_INVALID")
    expect(errorCode(() => normalizeCameraRequest({ position: [1, 2, 3], target: [0, 0, 0], near: 5, far: 1 }, {}))).toBe("VIEWER_CAMERA_INVALID")
    expect(errorCode(() => normalizeCameraRequest({ position: [1, 2, 3], target: [1, 2, 3], fovYDeg: 50 }, {}))).toBe("VIEWER_CAMERA_INVALID")
    expect(errorCode(() => normalizeCameraRequest({ position: [1, 2, 3], target: [0, 0, 0], fovYDeg: 200 }, {}))).toBe("VIEWER_CAMERA_INVALID")
    expect(errorCode(() => normalizeIntrinsics({ fx: 700, fy: 700, width: 960.5, height: 540 }))).toBe("VIEWER_CAMERA_INVALID")
    expect(errorCode(() => normalizeIntrinsics({ fx: 0, fy: 700, width: 960, height: 540 }))).toBe("VIEWER_CAMERA_INVALID")
    expect(errorCode(() => normalizeIntrinsics({ fx: 700, fy: 700, cx: 4000, cy: 270, width: 960, height: 540 }))).toBe("VIEWER_CAMERA_INVALID")
    expect(errorCode(() => assertRenderSize(0, 100))).toBe("VIEWER_CAMERA_INVALID")
    expect(errorCode(() => assertRenderSize(1920.5, 1080))).toBe("VIEWER_CAMERA_INVALID")
    expect(errorCode(() => assertRenderSize(9000, 100))).toBe("VIEWER_CAMERA_INVALID")
    expect(errorCode(() => assertRenderSize(8192, 1954))).toBe("VIEWER_CAMERA_INVALID")
    expect(errorCode(() => assertRenderSize(1920, 1080))).toBe("NO_THROW")
  })

  it("内参缺 cx/cy 时取像素中心；主点偏移与 isPlainLens 的判据成型", () => {
    const centred = normalizeIntrinsics({ fx: 700, fy: 700, width: 960, height: 540 })
    expect([centred.cx, centred.cy]).toEqual([479.5, 269.5])
    expect(principalPointOffsetPx(centred)).toEqual({ x: 0, y: 0 })
    expect(isPlainLens(centred)).toBe(true)
    expect(isPlainLens(normalizeIntrinsics({ fx: 700, fy: 690, width: 960, height: 540 }))).toBe(false)
    expect(isPlainLens(normalizeIntrinsics({ fx: 700, fy: 700, cx: 460, cy: 269.5, width: 960, height: 540 }))).toBe(false)
  })
})

describe("camera_fit（任务 40）的输出可以直接喂进来", () => {
  const K: ViewerCameraIntrinsics = { fx: 812.5, fy: 806.2, cx: 470.3, cy: 301.7, width: 960, height: 540 }
  const fitBlock = () => {
    const base = rolledRequest(12.5)
    const quaternion = base.quaternion as ViewerQuat
    const position = base.position as ViewerVec3
    const target = base.target as ViewerVec3
    return {
      worldFromCamera: { positionM: position, rotationMatrix: threeRotationMatrix(quaternion), quaternionXyzw: quaternion },
      // 兄弟块：带 camera_fit 自己的额外键（schema 是开放对象，多出来的键不该影响判定）。
      intrinsics: {
        ...K, distortion: [0, 0, 0, 0, 0], calibrated: true, fovxDeg: fovXFromIntrinsics(K), fovyDeg: fovYFromIntrinsics(K),
        principalPointOffsetPx: { x: K.cx - (K.width - 1) / 2, y: K.cy - (K.height - 1) / 2 }, principalPointCentred: false,
        reproducibleByFovAlone: false, note: "从照片解出", squarePixelModel: false,
      },
      viewer: {
        position, quaternion, up: cameraUpOf(quaternion), sceneUp: [0, 0, 1], target,
        focusDistance: v3(position).distanceTo(v3(target)), fov_y_deg: fovYFromIntrinsics(K), fov_x_deg: fovXFromIntrinsics(K),
        aspect: K.width / K.height, intrinsics: K, units: { metric: true },
        principalPointOffsetPx: { x: K.cx - (K.width - 1) / 2, y: K.cy - (K.height - 1) / 2 }, principalPointCentred: false,
      },
    }
  }

  it("三位姿来源（位姿矩阵 / 四元数 / rotationMatrix）说的是同一个姿态：原样喂进去，位姿与 K 都复现", () => {
    const app = rig({ width: 1600, height: 900 })
    const block = fitBlock()
    const quaternion = block.worldFromCamera.quaternionXyzw
    // 本模块的旋转矩阵口径先与 three 独立算一遍的对齐（列 = 相机轴）。
    const expectedMatrix = threeRotationMatrix(quaternion)
    const ours = rotationMatrixColumnsFromQuaternion(quaternion)
    expect(Math.max(...expectedMatrix.flat().map((value, index) => Math.abs(value - ours.flat()[index]!)))).toBeLessThan(1e-12)

    const view = normalizeCameraRequest({ camera: block }, { fovYDeg: 50 })
    expect(view.orientationSource).toBe("quaternion")
    expect(view.projectionSource).toBe("intrinsics")
    expect(Math.abs(view.rollDeg - 12.5)).toBeLessThan(1e-6)
    // viewer.up 是相机 up（含 roll），不能被当成世界 up 提示（否则 roll 会算成别的值）。
    expect(view.up).toEqual([0, 0, 1])
    const verification = writeViewToCamera(app.camera, app.controls, view, app.size)
    expect(verification.errors).toEqual([])
    expectIntrinsicsClose(verification.measured.intrinsics, scaleIntrinsics(K, app.size.width, app.size.height))
    expectProjectionMatches(app.camera, scaleIntrinsics(K, app.size.width, app.size.height), app.size)
    expect(Math.abs(verification.measured.rollDeg - 12.5)).toBeLessThan(1e-3)
  })

  it("worldFromCamera 的 rotationMatrix 与 quaternionXyzw 必须是同一个姿态，矛盾即拒", () => {
    const block = fitBlock()
    const other = rolledRequest(50).quaternion as ViewerQuat
    expect(errorCode(() => normalizeCameraRequest({ camera: { ...block, worldFromCamera: { positionM: block.worldFromCamera.positionM, rotationMatrix: threeRotationMatrix(other), quaternionXyzw: block.worldFromCamera.quaternionXyzw } } }, {}))).toBe("VIEWER_CAMERA_CONFLICT")
  })

  it("量出来的 worldFromCamera 可以回喂（同机位再应用一次仍是同一台相机）", () => {
    const app = rig({ width: 1280, height: 720 })
    const first = normalizeCameraRequest({ camera: fitBlock() }, { fovYDeg: 50 })
    expect(writeViewToCamera(app.camera, app.controls, first, app.size).errors).toEqual([])
    const measured = describeCameraView(app.camera, app.size, first.up)
    const again = normalizeCameraRequest({ worldFromCamera: measured.worldFromCamera, intrinsics: measured.intrinsics, near: measured.near, far: measured.far, cameraUp: measured.up }, { fovYDeg: 50 })
    expect(writeViewToCamera(app.camera, app.controls, again, app.size).errors).toEqual([])
    const second = describeCameraView(app.camera, app.size, again.up)
    expect(quaternionAngleDeg(second.quaternion, measured.quaternion)).toBeLessThan(1e-6)
    expectIntrinsicsClose(second.intrinsics, measured.intrinsics, 1e-9)
  })

  it("畸变系数如实进 notes（没复现的就说没复现），而且不许悄悄改掉 K", () => {
    const block = fitBlock()
    const distorted = { fx: K.fx, fy: K.fy, cx: K.cx, cy: K.cy, width: K.width, height: K.height, distortion: [0.12, -0.31, 0, 0, 0] }
    const view = normalizeCameraRequest({ camera: { ...block, intrinsics: distorted, viewer: { ...block.viewer, intrinsics: distorted } } }, {})
    expect(view.notes.join("｜")).toMatch(/畸变/)
    expect(view.notes.join("｜")).toMatch(/针孔/)
    // 畸变系数不能悄悄改变"这就是一台 pinhole"这件事：K 的四个数与非畸变那份一致。
    expect({ fx: view.intrinsics!.fx, fy: view.intrinsics!.fy, cx: view.intrinsics!.cx, cy: view.intrinsics!.cy }).toEqual({ fx: K.fx, fy: K.fy, cx: K.cx, cy: K.cy })
  })
})

/**
 * 任务 40 的真夹具（`packages/blender/test/fixtures/camera-fit/portrait-crop.json` 那次渲染 + 任务 55 的求解输出）
 * 拷进本包：竖幅 540×960、主点偏心 (+30.5, −77) 像素、fx≠fy（780 / 1050，像素长宽比 1.346）、roll 7.48°，
 * 并且带着 15 个标记点的世界坐标与两种像素读数（`pixelProjected` = Blender 相机矩阵的解析投影，
 * `pixelMeasured` = 渲染图里量出来的质心）。
 *
 * 为什么用这份真夹具而不是自己造一个旧形状：这台相机的 K 与位姿是**别人从照片解出来的**，
 * 竖幅 + 偏心主点 + 非方形像素 + roll 四件事同时在场，而且有独立的世界点/像素点对——
 * 于是"应用之后相机真的复现了照片那台相机"可以逐点量，而不是只看一串自洽的读数。
 * 像素口径与夹具的 `provenance.pixelConvention` 同一条：`u = (ndc.x+1)/2·W − 0.5`（像素中心，原点左上）。
 */
interface PortraitFixture {
  provenance: { fixture: string; why: string; pixelConvention: string }
  view: { name: string; resolution: Size; rollDeg: number; targetIntrinsics: ViewerCameraIntrinsics }
  cameraFitBlock: {
    metric: boolean
    positionUnits: string
    worldFromCamera: { positionM: ViewerVec3; rotationMatrix: number[][]; quaternionXyzw: ViewerQuat }
    viewer: {
      positionM: ViewerVec3; quaternion: ViewerQuat; up: ViewerVec3; sceneUp: ViewerVec3; target: ViewerVec3
      focusDistance: number; fov_y_deg: number; fov_x_deg: number; aspect: number; rollDeg: number
      units: { metric: boolean; name: string; note: string }
      intrinsics: ViewerCameraIntrinsics
    }
  }
  reprojection: { fitRmsPx: number; checkRmsPx: number; maxCheckPx: number; scale: { determined: boolean; worldUnit: string; metresPerInputUnit: number | null } }
  points: Array<{ id: string; role: string; worldM: ViewerVec3; pixelProjected: number[]; pixelMeasured: number[] }>
  selfCheck: { visibleMarkers: number; fitPoints: number; checkPoints: number; maxProjectionDeltaPx: number; meanProjectionDeltaPx: number }
}
const loadPortraitFixture = (): PortraitFixture => JSON.parse(readFileSync(new URL("./fixtures/portrait-crop-camera-fit.json", import.meta.url), "utf8")) as PortraitFixture
/** 两组像素的逐点最大差（列/行分别差多少）。 */
const pixelGap = (a: readonly number[], b: readonly number[]): number => Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!))

describe("任务 40 的真夹具（竖幅 + 偏心主点 + fx≠fy + roll）原样应用", () => {
  const fixture = loadPortraitFixture()
  const size = fixture.view.resolution
  const truth = fixture.cameraFitBlock.worldFromCamera

  it("camera_fit 的块喂进真 SceneViewer：位姿逐位复现、K 逐项复现、15 个标记点落回照片像素", () => {
    const app = viewerRig(size)
    const measured = app.applyCameraView({ camera: fixture.cameraFitBlock })
    // ① 位姿：与求解器给的四元数/位置一致到浮点噪声（观测到 ~1e-16 度 / ~1e-13 米）。
    expect(quaternionAngleDeg(measured.quaternion, truth.quaternionXyzw)).toBeLessThan(1e-9)
    expect(Math.max(...measured.position.map((value, index) => Math.abs(value - truth.positionM[index]!)))).toBeLessThan(1e-12)
    // 相机 up 轴 = 姿态自身的 y 轴（含 roll），不是世界 up——夹具的 `viewer.upNote` 也是这个口径。
    const upAxis = cameraUpOf(truth.quaternionXyzw)
    expect(Math.max(...measured.up.map((value, index) => Math.abs(value - upAxis[index]!)))).toBeLessThan(1e-6)
    expect(Math.abs(upAxis[2]! - 1)).toBeGreaterThan(0.01)
    // 转心用的是读数给的那个 target（不是默认原点，也不是 40 夹具里 Blender 的瞄点）。
    expect(app.controls.target.distanceTo(v3(fixture.cameraFitBlock.viewer.target))).toBeLessThan(1e-6)
    expect(app.controls.target.distanceTo(v3(truth.positionM))).toBeCloseTo(fixture.cameraFitBlock.viewer.focusDistance, 6)
    // ② K：fx≠fy 与偏心主点逐项复现（夹具里按 float32 存，容差 1e-6 px）。
    expectIntrinsicsClose(measured.intrinsics, fixture.cameraFitBlock.viewer.intrinsics, 1e-6)
    // 偏心主点是**真的用视口偏移表达的**（不是只在读数里报了一个偏移量）。
    expect(measured.viewOffset).not.toBeNull()
    // ③ roll：大小与 55 的 `viewer.rollDeg` 一致、方向与 40 夹具的意图（+7.5°）一致。
    //   55 那个字段是"按 worldUp 调一次 controls.update() 会把 roll 抹掉多少"，与我们的读数差一个符号
    //   （它自己的 `rollNote` 就是这么说的）；40 夹具的 groundTruth 是 Blender 里真滚了 +7.5°，与我们同号。
    expect(Math.abs(Math.abs(measured.rollDeg) - Math.abs(fixture.cameraFitBlock.viewer.rollDeg))).toBeLessThan(1e-6)
    expect(measured.rollDeg).toBeGreaterThan(0)
    expect(Math.abs(measured.rollDeg - fixture.view.rollDeg)).toBeLessThan(0.05)
    // ④ 逐点：先把"相机的投影就是这份 K"钉死（解析式 vs 真实 three 投影，同一台相机），再与照片上的像素比。
    const toCamera = new THREE.Matrix4().copy(app.camera.matrixWorld).invert()
    let worstAnalytic = 0, worstProjected = 0, worstCentroid = 0
    for (const point of fixture.points) {
      const pixel = realPixel(app.camera, point.worldM, size)
      const cameraPoint = v3(point.worldM).applyMatrix4(toCamera).toArray() as ViewerVec3
      const analytic = projectToPixel(measured.intrinsics, cameraPoint)
      expect(analytic).toBeDefined()
      worstAnalytic = Math.max(worstAnalytic, pixelGap(analytic!, pixel))
      worstProjected = Math.max(worstProjected, pixelGap(point.pixelProjected, pixel))
      worstCentroid = Math.max(worstCentroid, pixelGap(point.pixelMeasured, pixel))
      // 15 个点都真的落在画面里（不是靠"点跑到画面外"混过去的）。
      expect(point.pixelMeasured[0]!).toBeGreaterThanOrEqual(0)
      expect(point.pixelMeasured[0]!).toBeLessThan(size.width)
      expect(point.pixelMeasured[1]!).toBeGreaterThanOrEqual(0)
      expect(point.pixelMeasured[1]!).toBeLessThan(size.height)
    }
    expect(fixture.points.length).toBe(15)
    expect(worstAnalytic).toBeLessThan(1e-6)
    // 与照片比：夹具自己的差就摆在那（自检差最大 0.175 px、拟合 check 残差 0.18 px，
    // 观测到我们这边 0.11 px（解析投影）/ 0.15 px（质心））。容差按**夹具的量级**取 0.25 px——
    // 不能声称比夹具本身还准。
    expect(fixture.selfCheck.maxProjectionDeltaPx).toBeLessThan(0.25)
    expect(worstProjected).toBeLessThan(0.25)
    expect(worstCentroid).toBeLessThan(0.25)
  })

  it("resize（真 resizeCanvas：容器尺寸变 → 画布像素变）后姿态不动、K 按新尺寸等比缩放、构图不变", () => {
    const app = viewerRig(size)
    app.applyCameraView({ camera: fixture.cameraFitBlock })
    const before = app.cameraView()
    // 归一化用**像素边界**口径 `(col+0.5)/width`：这才是"同一个画面比例位置"（像素中心口径差半像素）。
    const composition = fixture.points.map(point => { const [x, y] = realPixel(app.camera, point.worldM, size); return [(x + 0.5) / size.width, (y + 0.5) / size.height] as [number, number] })
    const resized = { width: 810, height: 480 }
    app.options.container.clientWidth = resized.width
    app.options.container.clientHeight = resized.height
    app.resizeCanvas()
    const after = app.cameraView()
    // 姿态与相机 up 一字不动（resize 只改像素尺度）。
    expect(after.position).toEqual(before.position)
    expect(quaternionAngleDeg(after.quaternion, before.quaternion)).toBeLessThan(1e-12)
    expect(after.up).toEqual(before.up)
    expect(Math.abs(after.rollDeg - before.rollDeg)).toBeLessThan(1e-9)
    // K 按新画布等比缩放：视场与主点/焦距的**占比**逐项不变（偏心主点没有在 resize 后漂回中心）。
    const photo = fixture.cameraFitBlock.viewer.intrinsics
    expectIntrinsicsClose(after.intrinsics, scaleIntrinsics(photo, resized.width, resized.height), 1e-6)
    expect((after.intrinsics.cx + 0.5) / resized.width).toBeCloseTo((photo.cx + 0.5) / photo.width, 12)
    expect((after.intrinsics.cy + 0.5) / resized.height).toBeCloseTo((photo.cy + 0.5) / photo.height, 12)
    expect(after.intrinsics.fx / resized.width).toBeCloseTo(photo.fx / photo.width, 12)
    // 构图不变：同一台相机、同一份画面，只是像素尺度变了。
    fixture.points.forEach((point, index) => {
      const [x, y] = realPixel(app.camera, point.worldM, resized)
      expect(Math.abs((x + 0.5) / resized.width - composition[index]![0]!)).toBeLessThan(1e-9)
      expect(Math.abs((y + 0.5) / resized.height - composition[index]![1]!)).toBeLessThan(1e-9)
    })
    // 而且 resize 之后当场核对**依然通过**（核对会按新画布尺寸复算请求里那份 K）。
    const view = normalizeCameraRequest({ camera: fixture.cameraFitBlock }, { near: after.near, far: after.far })
    expect(verifyAppliedView(app.camera, view, resized).errors).toEqual([])
  })
})

/**
 * 55 的未知尺度读数（`camera.metric=false`，位置只给 `positionInputUnits`）：**不能**当米用，
 * 也不能落回当前相机的位置装成应用成功；只有调用方显式给出换算才应用。
 *
 * 块是从上面那份真夹具派生的：把米制数除以 2 当成"输入单位"（本次的输入单位 = 2 米）。于是"给了换算之后
 * 应当**正好**回到夹具那台相机"可以逐项核对——不是自己编一个位置来量换算对不对。
 * 换算按 55 的口径由**调用方**给出（55 只声明尺度未定，它不发这个比值）。
 */
describe("尺度未定的相机（camera_fit 的 positionInputUnits）：没有换算就拒，给了换算才应用", () => {
  const fixture = loadPortraitFixture()
  const truth = fixture.cameraFitBlock.worldFromCamera
  const metresPerInputUnit = 2
  const toInputUnits = (metres: ReadonlyArray<number>) => metres.map(value => value / metresPerInputUnit)
  const unknownScaleBlock = (conversion?: number) => ({
    metric: false,
    positionUnits: "inputUnits",
    worldFromCamera: { positionInputUnits: toInputUnits(truth.positionM), rotationMatrix: truth.rotationMatrix, quaternionXyzw: truth.quaternionXyzw },
    viewer: {
      quaternion: fixture.cameraFitBlock.viewer.quaternion, up: fixture.cameraFitBlock.viewer.up,
      sceneUp: fixture.cameraFitBlock.viewer.sceneUp, forward: [0, 0, 1],
      // 55 的读数里 target = position + forward·focusDistance：与位置在同一个空间 ⇒ 同一个单位（输入单位）。
      target: toInputUnits(fixture.cameraFitBlock.viewer.target),
      focusDistance: fixture.cameraFitBlock.viewer.focusDistance / metresPerInputUnit,
      fov_y_deg: fixture.cameraFitBlock.viewer.fov_y_deg, fov_x_deg: fixture.cameraFitBlock.viewer.fov_x_deg,
      aspect: fixture.cameraFitBlock.viewer.aspect, intrinsics: fixture.cameraFitBlock.viewer.intrinsics,
      units: { metric: false, name: "input-units(unknown-scale)", note: "尺度未定：位置不是米。", ...conversion === undefined ? {} : { metersPerInputUnit: conversion } },
    },
  })

  it("没有换算：明确拒（不当米用、也不落回当前相机的位置），并说清两条出路", () => {
    const current = { position: [5, -6, 4] as ViewerVec3, quaternion: [0, 0, 0, 1] as ViewerQuat, target: [0, 0, 0.7] as ViewerVec3, targetDistanceM: 8 }
    let message = ""
    try { normalizeCameraRequest({ camera: unknownScaleBlock() }, current) } catch (error) { message = String(error) }
    expect(errorCode(() => normalizeCameraRequest({ camera: unknownScaleBlock() }, current))).toBe("VIEWER_CAMERA_SCALE_UNKNOWN")
    expect(message).toContain("metersPerInputUnit")
    expect(message).toContain("worldUnit=unknown")
    // 修的就是这一条：以前会落回 `current.position` 并回一个"应用成功"的读数。
    expect(message).toMatch(/不会按当前相机的位置顶替/)
    // 摊平形状（位置直接给在请求上）走同一条判据。
    expect(errorCode(() => normalizeCameraRequest({ positionInputUnits: toInputUnits(truth.positionM), quaternion: truth.quaternionXyzw, fovYDeg: 30 }, current))).toBe("VIEWER_CAMERA_SCALE_UNKNOWN")
    // 对照：同一份读数**声明成米**（metric=true）就照常应用——说明拒的不是"这台相机"，而是"没有换算的输入单位"。
    expect(errorCode(() => normalizeCameraRequest({ camera: fixture.cameraFitBlock }, current))).toBe("NO_THROW")
  })

  it("给了换算才应用：位置 = 输入单位 × 换算，正好回到夹具那台米制相机（含转心与焦距）", () => {
    const app = viewerRig(fixture.view.resolution)
    const measured = app.applyCameraView({ camera: unknownScaleBlock(metresPerInputUnit) })
    expect(Math.max(...measured.position.map((value, index) => Math.abs(value - truth.positionM[index]!)))).toBeLessThan(1e-9)
    expect(quaternionAngleDeg(measured.quaternion, truth.quaternionXyzw)).toBeLessThan(1e-12)
    expectIntrinsicsClose(measured.intrinsics, fixture.cameraFitBlock.viewer.intrinsics, 1e-6)
    // 块里的 target/focusDistance 与位置**同尺度**：只换算位置、放着 target 不管的话，这里会变成
    // "target 与朝向说的不是同一个方向"的 CONFLICT（真发生过：差 4.816°）。
    expect(app.controls.target.distanceTo(v3(fixture.cameraFitBlock.viewer.target))).toBeLessThan(1e-6)
    expect(app.controls.target.distanceTo(v3(measured.position))).toBeCloseTo(fixture.cameraFitBlock.viewer.focusDistance, 6)
    // 回执里如实写明尺度来自这次换算（不是读数自带的），并点名 target/focusDistance 一起换了。
    const notes = normalizeCameraRequest({ camera: unknownScaleBlock(metresPerInputUnit) }, {}).notes.join("｜")
    expect(notes).toMatch(/换算/)
    expect(notes).toMatch(/target\/focusDistance 与它同尺度/)
    // 换算给在顶层（`metersPerInputUnit`）与给在块里等价——调用方不必去改读数。
    const flat = normalizeCameraRequest({ camera: unknownScaleBlock(), metersPerInputUnit: metresPerInputUnit }, {})
    expect(Math.max(...flat.position.map((value, index) => Math.abs(value - truth.positionM[index]!)))).toBeLessThan(1e-9)
    expect(flat.targetDistanceM).toBeCloseTo(fixture.cameraFitBlock.viewer.focusDistance, 6)
  })

  it("尺度未定 + 只给朝向/投影（没给位置）：只摆朝向，位置如实说仍是当前相机的", () => {
    const block = unknownScaleBlock(metresPerInputUnit).viewer
    const view = normalizeCameraRequest(
      { camera: { metric: false, viewer: { quaternion: block.quaternion, fov_y_deg: block.fov_y_deg, intrinsics: block.intrinsics, units: block.units } } },
      { position: [5, -6, 4], quaternion: [0, 0, 0, 1], cameraUp: [0, 0, 1], target: [0, 0, 0.7], targetDistanceM: 8 },
    )
    expect(view.position).toEqual([5, -6, 4])
    expect(view.orientationSource).toBe("quaternion")
    // 朝向确实是照片那台相机的（不是当前相机的 [0,0,0,1]），roll 也在。
    expect(quaternionAngleDeg(view.quaternion, truth.quaternionXyzw)).toBeLessThan(1e-6)
    expect(Math.abs(Math.abs(view.rollDeg) - Math.abs(fixture.cameraFitBlock.viewer.rollDeg))).toBeLessThan(1e-5)
    expect(view.notes.join("｜")).toMatch(/位置仍是当前相机的/)
  })

  it("55 的 `target: null` / `focusDistance: null` 是「没给」，不是非法值", () => {
    const block = unknownScaleBlock(metresPerInputUnit)
    const view = normalizeCameraRequest({ camera: { ...block, viewer: { ...block.viewer, target: null, focusDistance: null } } }, { targetDistanceM: 3 })
    expect(Math.max(...view.position.map((value, index) => Math.abs(value - truth.positionM[index]!)))).toBeLessThan(1e-9)
    // 没给就按"没给"处理：转心落在视线上、距离用调用方给的那个，而不是拿 null 去算。
    expect(view.targetDistanceM).toBeCloseTo(3, 9)
    expect(view.notes.join("｜")).not.toMatch(/target\/focusDistance 与它同尺度/)
  })

  it("尺度声明与位置字段打架：metric=false + 米制位置字段 → CONFLICT（反之亦然）", () => {
    expect(errorCode(() => normalizeCameraRequest({ camera: { ...fixture.cameraFitBlock, metric: false } }, {}))).toBe("VIEWER_CAMERA_CONFLICT")
    const inputUnits = unknownScaleBlock()
    expect(errorCode(() => normalizeCameraRequest({ camera: { ...inputUnits, metric: true, viewer: { ...inputUnits.viewer, units: { metric: true } } } }, {}))).toBe("VIEWER_CAMERA_CONFLICT")
  })
})

describe("按指定相机出图（renderCameraImage 的数学：独立相机 + 独立尺寸）", () => {
  const K: ViewerCameraIntrinsics = { fx: 640.4, fy: 638.1, cx: 500.2, cy: 255.9, width: 960, height: 540 }

  it("出图尺寸 = 照片尺寸：出图相机的 K 与投影逐点对得上，主相机一字未动", () => {
    const app = rig({ width: 1280, height: 720 })
    const mainView = normalizeCameraRequest({ position: [3, -3, 2], target: [0, 0, 0.6], fovYDeg: 40 }, { fovYDeg: 50 })
    expect(writeViewToCamera(app.camera, app.controls, mainView, app.size).errors).toEqual([])
    const before = describeCameraView(app.camera, app.size)

    const view = normalizeCameraRequest(rolledRequest(-9.4, { intrinsics: K }), { fovYDeg: 50 })
    const size = { width: K.width, height: K.height }
    const renderCamera = new THREE.PerspectiveCamera(view.fovYDeg, size.width / size.height, view.near, view.far)
    // 出图相机没有 controls（它只出这一张图，不需要每帧重算姿态）：同一份写入 + 当场核对。
    const verification = writeViewToCamera(renderCamera, undefined, view, size)
    expect(verification.errors).toEqual([])
    expectIntrinsicsClose(verification.measured.intrinsics, K)
    expectProjectionMatches(renderCamera, K, size)
    expect(Math.abs(verification.measured.rollDeg + 9.4)).toBeLessThan(1e-3)
    const after = describeCameraView(app.camera, app.size)
    expect(after.quaternion).toEqual(before.quaternion)
    expect(after.position).toEqual(before.position)
    expectIntrinsicsClose(after.intrinsics, before.intrinsics, 0)
  })

  it("出图尺寸 ≠ 照片尺寸：按出图尺寸缩放 K（归一化构图不变，不是拉伸）", () => {
    const view = normalizeCameraRequest(rolledRequest(-9.4, { intrinsics: K }), { fovYDeg: 50 })
    const small: Size = { width: 960, height: 540 }, large: Size = { width: 1920, height: 1080 }
    const normalized = new Map<string, Array<[number, number]>>()
    for (const size of [small, large]) {
      const camera = new THREE.PerspectiveCamera(view.fovYDeg, size.width / size.height, view.near, view.far)
      expect(writeViewToCamera(camera, undefined, view, size).errors).toEqual([])
      const expected = scaleIntrinsics(K, size.width, size.height)
      expectIntrinsicsClose(describeCameraView(camera, size, view.up).intrinsics, expected)
      expectProjectionMatches(camera, expected, size)
      // 归一化用**像素边界**口径 `(col+0.5)/width`：这正是"同一个画面比例位置"的定义（像素中心口径差半像素）。
      normalized.set(`${size.width}x${size.height}`, PROBE_POINTS.map(point => { const [x, y] = realPixel(camera, worldOf(camera, point), size); return [(x + 0.5) / size.width, (y + 0.5) / size.height] as [number, number] }))
    }
    // 同一台相机、两种出图尺寸：每个点在画面里的**相对位置**不变（同构图），只是像素尺度不同。
    normalized.get("960x540")!.forEach(([x, y], index) => {
      const [otherX, otherY] = normalized.get("1920x1080")![index]!
      expect(Math.abs(x - otherX)).toBeLessThan(1e-9)
      expect(Math.abs(y - otherY)).toBeLessThan(1e-9)
    })
  })

  it("出图尺寸缺省时以 K 自己的尺寸为依据（Viewer 侧的选择，这里钉住 K 就是那份依据）", () => {
    const view = normalizeCameraRequest(rolledRequest(4, { intrinsics: K }), { fovYDeg: 50 })
    expect([view.intrinsics!.width, view.intrinsics!.height]).toEqual([960, 540])
    expect(errorCode(() => assertRenderSize(view.intrinsics!.width, view.intrinsics!.height))).toBe("NO_THROW")
  })
})

describe("窗口 resize 不丢相机设置", () => {
  it("同一台相机换画布尺寸：K 按新尺寸等比缩放，新旧尺寸下点的归一化像素位置一致", () => {
    const first: Size = { width: 1280, height: 720 }
    const app = rig(first)
    const photo: ViewerCameraIntrinsics = { fx: 812.5, fy: 806.2, cx: 470.3, cy: 301.7, width: 960, height: 540 }
    const view = normalizeCameraRequest(rolledRequest(17.2, { intrinsics: photo }), { fovYDeg: 50 })
    expect(writeViewToCamera(app.camera, app.controls, view, first).errors).toEqual([])
    const worlds = PROBE_POINTS.map(point => worldOf(app.camera, point))
    // 归一化用**像素边界**口径 `(col+0.5)/width`：这才是"同一个画面比例位置"，与画布尺寸无关。
    const before = worlds.map(world => { const [x, y] = realPixel(app.camera, world, first); return [(x + 0.5) / first.width, (y + 0.5) / first.height] as [number, number] })
    const poseBefore = app.camera.quaternion.toArray()

    // 与 `SceneViewer.resizeCanvas` 的 resize 分支同一串：先改画布宽高比，再按**请求时那份内参**缩放到新尺寸。
    const second: Size = { width: 1600, height: 900 }
    app.camera.aspect = second.width / second.height
    setCameraIntrinsics(app.camera, scaleIntrinsics(photo, second.width, second.height))

    expectIntrinsicsClose(describeCameraView(app.camera, second, view.up).intrinsics, scaleIntrinsics(photo, second.width, second.height))
    expectProjectionMatches(app.camera, scaleIntrinsics(photo, second.width, second.height), second)
    worlds.forEach((world, index) => {
      const [x, y] = realPixel(app.camera, world, second)
      expect(Math.abs((x + 0.5) / second.width - before[index]![0]!)).toBeLessThan(1e-9)
      expect(Math.abs((y + 0.5) / second.height - before[index]![1]!)).toBeLessThan(1e-9)
    })
    // 相机位姿没被 resize 改动（只有像素尺度变了），视场与主点占比也不变：等比缩放的定义。
    expect(app.camera.quaternion.toArray()).toEqual(poseBefore)
    const scaled = scaleIntrinsics(photo, second.width, second.height)
    expect(scaled.fx / scaled.width).toBeCloseTo(photo.fx / photo.width, 12)
    expect((scaled.cx + 0.5) / scaled.width).toBeCloseTo((photo.cx + 0.5) / photo.width, 12)
    // resize 之后当场核对**依然通过**：请求里那份 K 会按新画布尺寸复算，所以尺寸一变不等于设置丢了。
    const rescaleCheck = verifyAppliedView(app.camera, view, second)
    expect(rescaleCheck.errors).toEqual([])
    expect(rescaleCheck.ok).toBe(true)
  })
})

describe("相机状态往返（getViewState / setViewState 的同一份写法）", () => {
  const size: Size = { width: 1280, height: 720 }

  it("带 roll + 偏心 K 的机位：存下来（含 JSON 往返）再恢复是同一台相机；非普通镜头才带 intrinsics", () => {
    const app = rig(size)
    const photo: ViewerCameraIntrinsics = { fx: 745, fy: 736, cx: 600, cy: 350, width: 960, height: 540 }
    const view = normalizeCameraRequest(rolledRequest(31.7, { intrinsics: photo }), { fovYDeg: 50 })
    expect(writeViewToCamera(app.camera, app.controls, view, size).errors).toEqual([])

    const state = cameraStateFromView(app.camera, size, app.controls.target.toArray() as ViewerVec3)
    expect(state.intrinsics).toBeDefined() // 主点偏心 + fx≠fy：普通镜头装不下，必须带上
    // 命名相机是这样进场景文档的（`entity.components.viewerCamera` 里一格 JSON，随工程移动、别的客户端也读得到）：
    // 状态经一次 JSON 往返再读回来，仍能恢复成同一台相机。
    const stored = JSON.parse(JSON.stringify(state)) as typeof state
    const restored = normalizeCameraRequest(cameraRequestFromState(stored), { fovYDeg: 50 })
    expect(restored.projectionSource).toBe("intrinsics")
    // 先挪到别处，确认恢复真的把相机搬回来了（而不是"本来就在那"）。
    expect(writeViewToCamera(app.camera, app.controls, normalizeCameraRequest({ position: [9, 9, 3], target: [0, 0, 0], fovYDeg: 60 }, {}), size).errors).toEqual([])
    expect(writeViewToCamera(app.camera, app.controls, restored, size).errors).toEqual([])
    const measured = describeCameraView(app.camera, size, restored.up)
    expect(quaternionAngleDeg(measured.quaternion, view.quaternion)).toBeLessThan(1e-3)
    expect(Math.abs(measured.rollDeg - 31.7)).toBeLessThan(1e-3)
    expectIntrinsicsClose(measured.intrinsics, scaleIntrinsics(photo, size.width, size.height))
    // 再量一份状态：与存取前那份一致（roll/视场/裁剪面/内参都在，没有随恢复丢东西）。
    const again = cameraStateFromView(app.camera, size, app.controls.target.toArray() as ViewerVec3)
    expect(again.fovDeg).toBeCloseTo(state.fovDeg!, 9)
    expect(again.up).toEqual(state.up)
    expectIntrinsicsClose(again.intrinsics!, state.intrinsics!, 1e-9)
  })

  it("居中方形像素：状态里不出现 intrinsics，恢复后视场/姿态不变且没有残留视口偏移", () => {
    const app = rig(size)
    const plain: ViewerCameraIntrinsics = { fx: 812.5, fy: 812.5, cx: 639.5, cy: 359.5, width: 1280, height: 720 }
    const view = normalizeCameraRequest(rolledRequest(-14.3, { intrinsics: plain }), { fovYDeg: 50 })
    expect(writeViewToCamera(app.camera, app.controls, view, size).errors).toEqual([])
    const state = cameraStateFromView(app.camera, size, app.controls.target.toArray() as ViewerVec3)
    expect(state.intrinsics).toBeUndefined()
    const restored = normalizeCameraRequest(cameraRequestFromState(state), { fovYDeg: 50 })
    expect(restored.projectionSource).toBe("fov")
    expect(writeViewToCamera(app.camera, app.controls, restored, size).errors).toEqual([])
    const measured = describeCameraView(app.camera, size, restored.up)
    expect(quaternionAngleDeg(measured.quaternion, view.quaternion)).toBeLessThan(1e-3)
    expect(measured.fovYDeg).toBeCloseTo(view.fovYDeg, 9)
    expect(measured.viewOffset).toBeNull()
  })

  it("老的三字段状态（只有 position/quaternion/target）照常可用，且不再抹平 roll", () => {
    const app = rig(size)
    const view = normalizeCameraRequest(rolledRequest(23.5), { fovYDeg: 50 })
    const request = cameraRequestFromState({ position: view.position, quaternion: view.quaternion, target: view.target })
    expect(request.cameraUp).toBeUndefined()
    expect(request.fovYDeg).toBeUndefined()
    const restored = normalizeCameraRequest(request, { fovYDeg: 50 })
    expect(restored.projectionSource).toBe("keep")
    expect(writeViewToCamera(app.camera, app.controls, restored, size).errors).toEqual([])
    const measured = describeCameraView(app.camera, size, restored.up)
    expect(quaternionAngleDeg(measured.quaternion, view.quaternion)).toBeLessThan(1e-3)
    expect(Math.abs(measured.rollDeg - 23.5)).toBeLessThan(1e-3)
  })
})

describe("当场核对抓得住坏实现（verifyAppliedView 的意义）", () => {
  /** 一个**故意坏掉**的实现：`setViewOffset` 什么都不做（等价"只按 fov 画、忽略主点与像素长宽比"）。 */
  const withoutViewOffset = (camera: THREE.PerspectiveCamera): MeasurableCamera => ({
    position: camera.position, quaternion: camera.quaternion, up: camera.up,
    get fov() { return camera.fov }, set fov(value: number) { camera.fov = value },
    get aspect() { return camera.aspect }, set aspect(value: number) { camera.aspect = value },
    get near() { return camera.near }, set near(value: number) { camera.near = value },
    get far() { return camera.far }, set far(value: number) { camera.far = value },
    get zoom() { return camera.zoom }, set zoom(value: number) { camera.zoom = value },
    setViewOffset() { /* 坏：什么都没做 */ },
    clearViewOffset() { camera.clearViewOffset() },
    updateProjectionMatrix() { camera.updateProjectionMatrix() },
    get projectionMatrix() { return camera.projectionMatrix },
    get view() { return camera.view },
  })
  /** 另一个坏的实现：写了视口偏移，但**没有把 aspect 改回画布宽高比**（fx 会被 fullWidth/fullHeight 带偏）。 */
  const withoutAspectRestore = (camera: THREE.PerspectiveCamera): MeasurableCamera => ({ ...withoutViewOffset(camera), setViewOffset: (fullWidth: number, fullHeight: number, x: number, y: number, width: number, height: number) => camera.setViewOffset(fullWidth, fullHeight, x, y, width, height) })
  const badK: ViewerCameraIntrinsics = { fx: 745, fy: 736, cx: 600, cy: 350, width: 960, height: 540 }

  it("忽略视口偏移的实现：核对失败并指出内参不符", () => {
    const size: Size = { width: 1280, height: 720 }
    const camera = new THREE.PerspectiveCamera(50, size.width / size.height, 0.1, 500)
    const view = normalizeCameraRequest(rolledRequest(8, { intrinsics: badK }), { fovYDeg: 50 })
    applyViewToCamera(withoutViewOffset(camera), view, size)
    const verification = verifyAppliedView(camera, view, size)
    expect(verification.ok).toBe(false)
    expect(verification.errors.join("｜")).toMatch(/内参|投影矩阵/)
  })

  it("不回写 aspect 的实现：核对失败（fx 被 fullWidth/fullHeight 带偏）", () => {
    const size: Size = { width: 1280, height: 720 }
    const camera = new THREE.PerspectiveCamera(50, size.width / size.height, 0.1, 500)
    const view = normalizeCameraRequest(rolledRequest(8, { intrinsics: { ...badK, fx: 812.5, fy: 700 } }), { fovYDeg: 50 })
    applyViewToCamera(withoutAspectRestore(camera), view, size)
    const verification = verifyAppliedView(camera, view, size)
    expect(verification.ok).toBe(false)
    expect(verification.errors.join("｜")).toMatch(/内参 fx|投影矩阵/)
  })

  it("同一台相机上，正常实现相反：核对通过", () => {
    const size: Size = { width: 1280, height: 720 }
    const app = rig(size)
    const view = normalizeCameraRequest(rolledRequest(8, { intrinsics: badK }), { fovYDeg: 50 })
    expect(writeViewToCamera(app.camera, app.controls, view, size).errors).toEqual([])
    expect(describeCameraView(app.camera, size, view.up).intrinsics.fx).toBeCloseTo(scaleIntrinsics(badK, size.width, size.height).fx, 6)
  })
})
