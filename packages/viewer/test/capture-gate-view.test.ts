/**
 * 取景框（用户反馈④）的**viewer 胶水与生命周期**真行为测试：`SceneViewer.setCaptureGate/updateCaptureGate/
 * resizeCanvas/renderLoop` 这一段。判据只有两条，且都是"看得见的那块 SVG"：
 *
 *   1. **一份口径**：画出来的矩形＝整块画布（因为投影按 `scaleIntrinsics` 各向异性填满画布，图像边缘就落在
 *      画布边缘），说明文字与线框同读一份 K（照片尺寸 + 真实垂直 FOV + "视口即整幅照片"，宽高比不同就
 *      如实说像素被拉伸——**不写"线外拍不进"**）。
 *   2. **生命周期**：框只对"画框时那台相机、那份投影"成立。用户一导航（`OrbitControls.update()` 每帧都可能
 *      改相机）／换相机（投影变了）／`setCaptureGate(undefined)`，旧的框必须消失；而 resize/DPR 只改画布
 *      尺寸，框要**留着并重画**（投影矩阵对这套缩放不变，不能误清）。
 *
 * 走的是**真 `SceneViewer` 原型**（`Object.create`，与 `camera-view.test.ts` 的 `viewerRig` 同一手法）：
 * 画框这段逻辑本身就是被测量的东西，自己手写一份"应该画在哪"再断言，测的只是测试自己。真实 DOM 用
 * 等价的**最小 SVG 替身**（记录 tag/属性/文本），Bun 没有 DOM；这里不量像素，量的是"框落在哪、什么时候消失"。
 *
 * 边界（不冒充已完成）：没有真实浏览器渲染——SVG 的实际像素外观、取景框叠在真画面上的观感不在这里，
 * 需要真机 computer-use 验收。本文件量与断言的是产品代码写进 DOM 的那份几何与生命周期。
 * 运行：`bun test packages/viewer/test/capture-gate-view.test.ts`
 */
import { describe, expect, it } from "bun:test"
import * as THREE from "three"
import { SceneViewer } from "../src/index.ts"
import { fovYFromIntrinsics, normalizeIntrinsics, setCameraIntrinsics, scaleIntrinsics, type ViewerCameraIntrinsics } from "../src/camera-view.ts"

/** 最小 SVG 元素替身：只实现产品代码用到的那几个成员（属性表、子节点、文本）。 */
class FakeElement {
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []
  textContent = ""
  style: Record<string, string> = {}
  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  appendChild(child: FakeElement): FakeElement { this.children.push(child); return child }
  removeChild(child: FakeElement): FakeElement { const index = this.children.indexOf(child); if (index >= 0) this.children.splice(index, 1); return child }
  get firstChild(): FakeElement | null { return this.children[0] ?? null }
  addEventListener(): void {}
  removeEventListener(): void {}
}

/** 4:3 照片、主点偏置、fx≠fy 的一份 K（取景框映射对这些都要成立）。 */
const K: ViewerCameraIntrinsics = normalizeIntrinsics({ fx: 600, fy: 610, cx: 360, cy: 200, width: 640, height: 480 })

interface GateRig {
  viewer: any
  canvas: any
  svg: FakeElement
  /** 改画布/CSS 尺寸（模拟窗口 resize 与设备像素比变化）。 */
  setLayout(css: { width: number; height: number }, dpr?: number): void
  /** 走一次产品的那一帧（fake rAF 不递归）。 */
  frame(): void
  /** 当前画出来的矩形（没画东西时 undefined）。 */
  rect(): { x: number; y: number; width: number; height: number } | undefined
  label(): string | undefined
}
function gateRig(css: { width: number; height: number }): GateRig {
  // document 在**取夹具时**装：本文件量的是这段产品代码，不受其它测试文件先后顺序影响。
  ;(globalThis as Record<string, unknown>).document = {
    addEventListener() {}, removeEventListener() {},
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
  }
  ;(globalThis as Record<string, unknown>).requestAnimationFrame = () => 0
  const viewer: any = Object.create(SceneViewer.prototype)
  const layout = { width: css.width, height: css.height }
  const canvas = {
    width: layout.width, height: layout.height,
    style: {} as Record<string, string>,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: layout.width, bottom: layout.height, width: layout.width, height: layout.height }),
    addEventListener() {}, removeEventListener() {}, setPointerCapture() {}, releasePointerCapture() {},
  }
  viewer.renderer = {
    domElement: canvas, pixelRatio: 1, toneMappingExposure: 1,
    getPixelRatio() { return viewer.renderer.pixelRatio as number },
    setPixelRatio(value: number) { viewer.renderer.pixelRatio = value },
    // 与 three 的 `setSize` 同一件事：改的是**着色缓冲**像素（`canvasPixels()` 读它）。
    setSize(width: number, height: number) { canvas.width = Math.round(width * viewer.renderer.pixelRatio); canvas.height = Math.round(height * viewer.renderer.pixelRatio) },
    render() {},
  }
  viewer.options = { container: { clientWidth: layout.width, clientHeight: layout.height, appendChild() {} }, onError() {} }
  viewer.scene = new THREE.Scene()
  viewer.camera = new THREE.PerspectiveCamera(50, layout.width / layout.height, 0.1, 1000)
  viewer.camera.up.set(0, 0, 1)
  viewer.camera.position.set(5, -6, 4)
  // 极简 controls 替身：本文件量的是"取景框什么时候收起"，不是 OrbitControls 复现姿态（那在 camera-view.test.ts）。
  viewer.controls = { target: new THREE.Vector3(0, 0, 0.7), update() {} }
  viewer.projection = { consume: () => undefined }
  viewer.objects = new Map()
  viewer.disposed = false
  viewer.editing = false
  viewer.updateLod = () => {}
  viewer.advanceAnimations = () => {}
  viewer.advanceDayNight = () => {}
  viewer.updateAnnotationMarkers = () => {}
  // 构造器没跑（`Object.create`），这里按同一形状补上 SVG 层。
  const svg = new FakeElement("svg")
  viewer.captureGateSvg = svg
  viewer.options.container.appendChild(svg)
  return {
    viewer, canvas, svg,
    setLayout(next, dpr) {
      layout.width = next.width; layout.height = next.height
      viewer.options.container.clientWidth = next.width; viewer.options.container.clientHeight = next.height
      if (dpr !== undefined) viewer.renderer.pixelRatio = dpr
    },
    frame() { viewer.renderFrame() },   // 产品那一帧的实际工作（`renderLoop` 只负责排下一帧）
    rect() {
      const rect = svg.children.find(child => child.tagName === "rect")
      return rect ? { x: Number(rect.attributes.get("x")), y: Number(rect.attributes.get("y")), width: Number(rect.attributes.get("width")), height: Number(rect.attributes.get("height")) } : undefined
    },
    label() { return svg.children.find(child => child.tagName === "text")?.textContent },
  }
}

describe("取景框（胶水）：框＝整块画布，说明与线框一份口径", () => {
  it("画出来的矩形＝整块画布（线外即画布外），viewBox 同一尺寸，角标 4 个", () => {
    const rig = gateRig({ width: 1280, height: 720 })
    rig.viewer.setCaptureGate({ intrinsics: K })
    const rect = rig.rect()!
    expect(rect.x).toBeCloseTo(0, 9)
    expect(rect.y).toBeCloseTo(0, 9)
    expect(rect.width).toBeCloseTo(1280, 9)
    expect(rect.height).toBeCloseTo(720, 9)
    expect(rig.svg.getAttribute("viewBox")).toBe("0 0 1280 720")
    expect(rig.svg.children.filter(child => child.tagName === "path")).toHaveLength(4)
  })
  it("说明读同一份 K（照片尺寸＋真实垂直 FOV），并如实标注宽高比不同＝各向异性拉伸", () => {
    const rig = gateRig({ width: 1280, height: 720 })   // 16:9 ≠ 4:3
    rig.viewer.setCaptureGate({ intrinsics: K })
    const label = rig.label()!
    expect(label).toContain("640×480")
    expect(label).toContain("视口即整幅照片")
    expect(label).toContain("各向异性拉伸")
    expect(label).not.toContain("线外拍不进")            // 旧口径的假结论不能出现在任何一处
    expect(label).toContain(`垂直FOV ${fovYFromIntrinsics(K).toFixed(1)}°`)   // 与"按指定相机出图"同一份 K→FOV
  })
  it("画布与照片同宽高比：只说明「视口即整幅照片」，不写拉伸", () => {
    const rig = gateRig({ width: 1280, height: 960 })   // 4:3 ＝ K 的宽高比
    rig.viewer.setCaptureGate({ intrinsics: K })
    const label = rig.label()!
    expect(label).toContain("视口即整幅照片")
    expect(label).not.toContain("拉伸")
  })
  it("画布还没有尺寸（容器隐藏/未布局）⇒ 不画、也不编一个框，且不抛错", () => {
    const rig = gateRig({ width: 0, height: 0 })
    rig.viewer.setCaptureGate({ intrinsics: K })
    expect(rig.rect()).toBeUndefined()
    expect(rig.svg.children).toHaveLength(0)
  })
})

describe("取景框（生命周期）：导航/换相机收起，resize/DPR 留着重画", () => {
  it("相机被导航改掉（位置/姿态）⇒ 下一帧收起，不再冒充当前相机", () => {
    const rig = gateRig({ width: 1280, height: 720 })
    rig.viewer.setCaptureGate({ intrinsics: K })
    expect(rig.rect()).toBeDefined()
    rig.viewer.camera.position.set(1, -2, 2)
    rig.viewer.camera.lookAt(0, 0, 0.7)
    rig.frame()
    expect(rig.viewer.captureGateSpec).toBeUndefined()
    expect(rig.rect()).toBeUndefined()
    expect(rig.svg.children).toHaveLength(0)
  })
  it("换到另一台相机（投影变了）⇒ 下一帧收起", () => {
    const rig = gateRig({ width: 1280, height: 720 })
    rig.viewer.setCaptureGate({ intrinsics: K })
    rig.viewer.camera.fov = 25                       // 另一台相机的镜头
    rig.viewer.camera.updateProjectionMatrix()
    rig.frame()
    expect(rig.viewer.captureGateSpec).toBeUndefined()
    expect(rig.rect()).toBeUndefined()
  })
  it("同一台相机、没动过 ⇒ 每帧都还在（不会自己掉）", () => {
    const rig = gateRig({ width: 1280, height: 720 })
    rig.viewer.setCaptureGate({ intrinsics: K })
    for (let index = 0; index < 3; index++) rig.frame()
    expect(rig.viewer.captureGateSpec).toBeDefined()
    expect(rig.rect()!.width).toBeCloseTo(1280, 9)
  })
  it("窗口 resize＋DPR 变化：框留着并按新画布重画（不是误清，也不是旧尺寸）", () => {
    const rig = gateRig({ width: 1280, height: 720 })
    // 先按"照片内参已应用"起手（resizeCanvas 的 resize 分支要真的走 setCameraIntrinsics）。
    rig.viewer.appliedIntrinsics = K
    setCameraIntrinsics(rig.viewer.camera, scaleIntrinsics(K, 1280, 720))
    rig.viewer.setCaptureGate({ intrinsics: K })
    rig.setLayout({ width: 1600, height: 900 }, 2)
    rig.viewer.resizeCanvas()                        // 产品那条 resize 路径（ResizeObserver 的回调）
    expect(rig.viewer.captureGateSpec).toBeDefined()
    expect(rig.viewer.camera.projectionMatrix.toArray().every(Number.isFinite)).toBe(true)
    const rect = rig.rect()!
    expect(rect.x).toBeCloseTo(0, 9)
    expect(rect.width).toBeCloseTo(1600, 9)
    expect(rect.height).toBeCloseTo(900, 9)
    expect(rig.svg.getAttribute("viewBox")).toBe("0 0 1600 900")
    rig.frame()                                      // resize 之后的一帧不能把它清掉
    expect(rig.viewer.captureGateSpec).toBeDefined()
    expect(rig.rect()!.width).toBeCloseTo(1600, 9)
  })
  it("setCaptureGate(undefined) 当场收起；重复设同一台相机只重画不叠加", () => {
    const rig = gateRig({ width: 1280, height: 720 })
    rig.viewer.setCaptureGate({ intrinsics: K })
    rig.viewer.setCaptureGate({ intrinsics: K })
    expect(rig.svg.children.filter(child => child.tagName === "rect")).toHaveLength(1)   // 全量重画，不叠框
    rig.viewer.setCaptureGate(undefined)
    expect(rig.svg.children).toHaveLength(0)
    expect(rig.rect()).toBeUndefined()
  })
})
