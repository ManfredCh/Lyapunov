/**
 * R-005/V10：连续视频的**标准独立画布平台流**、真实取帧节奏与清理。
 *
 * 历史缺陷一：`canvas.captureStream(30)` 只在画布重绘时出帧，静止机位退化成极少帧，于是曾改成
 * `captureStream(0)` + `requestFrame()`。历史缺陷二：本机 Chromium 给手动流的帧时间戳按**名义
 * 1/fps 递增**，真实出帧一旦少于 名义fps×实际秒数，WebM 时间轴就被压短（4.6 s 路线只落 2.2 s）。
 * 历史缺陷三：跨录制依赖 `MediaStreamTrackProcessor`/`MediaStreamTrackGenerator` 的实验轨道，
 * 取消后立即重录仍出现 0 B。
 *
 * V10 起生产路径收敛为：独立输出画布 → **先真实渲染/同步复制首帧** → `captureStream(fps)` 平台流
 * → 定时器每 tick 继续真实 clean render + drawImage。平台按真实采集时刻填时间戳；不再手动
 * requestFrame、不再创建实验性 Processor/Generator。
 *
 * V11 补上生命周期：输出画布必须在开流前附着到 Viewer 的真实 DOM 宿主（1×1、透明、pointer-events:none，
 * 不用 display/visibility 隐藏）。本机 Chromium 对离树 canvas 的连续采集会从第二轮起 0 B；下面用结构
 * 替身锁住取帧顺序、静止更新、每轮独立节点的挂载/移除、失败清理与删除回退。
 */
import {test, expect, afterEach} from 'bun:test'
import * as THREE from 'three'
import {SceneViewer} from '../src/index.ts'

const documentCleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of documentCleanups.splice(0)) cleanup() })

function fixture(requestFrame: boolean) {
  let stopped = 0
  const requestFrames: number[] = []
  const captureCalls: number[] = []
  const mainCaptureCalls: number[] = []
  const renders: unknown[] = []
  const events: string[] = []
  const mountEvents: string[] = []
  let atDraw: boolean[] | undefined, atRequest: boolean[] | undefined
  const failures = {capture: false}
  const outputs: any[] = []
  // 真实容器的结构替身：appendChild/removeChild 会维护 parentNode，测试据此判断节点是否还在 DOM。
  const hostChildren: any[] = []
  const host: any = {
    children: hostChildren,
    appendChild(node: any) { if (node.parentNode) node.parentNode.removeChild(node); hostChildren.push(node); node.parentNode = host; mountEvents.push("append"); return node },
    removeChild(node: any) {
      const index = hostChildren.indexOf(node)
      if (index < 0) throw new Error("NOT_A_CHILD")
      hostChildren.splice(index, 1); node.parentNode = null; mountEvents.push("remove"); return node
    },
    contains: (node: any) => hostChildren.includes(node),
  }
  const makeStream = (kind: "main" | "output") => {
    const track = {stop: () => { stopped++ }, ...requestFrame ? {requestFrame: () => {
      atRequest = [Boolean(viewer.captureRouteRoot?.visible), Boolean(viewer.captureRouteCurrentRoot?.visible)]
      events.push("requestFrame")
      requestFrames.push(requestFrames.length)
    }} : {}}
    return {getVideoTracks: () => [track], getTracks: () => [track], kind}
  }
  const mainCanvas = {
    width: 160, height: 120, parentElement: host, parentNode: host,
    removeEventListener: () => {},
    captureStream: (fps: number) => { mainCaptureCalls.push(fps); return makeStream("main") },
  }
  // 输出画布：每次 createElement 都是本轮独立节点；drawImage 就是“同步复制干净帧”的判据点，
  // 平台流只从它打开，且开流/首帧时它必须已经在 host 里。
  const createOutputCanvas = () => {
    const outputCanvas: any = {
      width: 160, height: 120, parentNode: null as any, tabIndex: undefined as number | undefined,
      attrs: {} as Record<string, string>, style: {} as Record<string, string>, mountedAtDraw: false, mountedAtCapture: false,
      setAttribute: (name: string, value: string) => { outputCanvas.attrs[name] = value },
      getContext: (kind: string) => kind === "2d" ? {drawImage: () => {
        outputCanvas.mountedAtDraw = outputCanvas.parentNode === host
        atDraw = [Boolean(viewer.captureRouteRoot?.visible), Boolean(viewer.captureRouteCurrentRoot?.visible)]
        events.push("drawImage")
      }} : null,
      captureStream: (fps: number) => {
        if (failures.capture) throw new Error('OPEN_FAILED')
        outputCanvas.mountedAtCapture = outputCanvas.parentNode === host
        captureCalls.push(fps); events.push("captureStream"); return makeStream("output")
      },
    }
    outputs.push(outputCanvas)
    return outputCanvas
  }
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  Object.defineProperty(globalThis, "document", {configurable: true, value: {createElement: () => createOutputCanvas()}})
  documentCleanups.push(() => { if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else Reflect.deleteProperty(globalThis, "document") })
  const viewer = Object.create(SceneViewer.prototype) as any
  viewer.disposed = false
  viewer.scene = {}
  viewer.camera = {}
  viewer.renderer = {domElement: mainCanvas, render: (_scene: unknown, camera: unknown) => { events.push("render"); renders.push(camera) }}
  viewer.captureStreamStops = new Set<() => void>()
  // helper 默认可见：clean pass 必须先藏它们，再 drawImage；恢复后主画布重绘。
  viewer.captureRouteRoot = {visible: false, children: []}
  viewer.captureRouteCurrentRoot = {visible: false, children: []}
  return {viewer, captureCalls, mainCaptureCalls, requestFrames, renders, events, mountEvents, host, outputs, failures, helperVisibility: () => ({atDraw, atRequest}), counts: () => ({stopped})}
}

/** 把 setInterval 换成可手动 tick 的替身；返回 tick 与清理计数。 */
function stubTimer() {
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval
  let callback: (() => void) | undefined, cleared = 0
  globalThis.setInterval = ((fn: () => void) => { callback = fn; return 1 as unknown as ReturnType<typeof setInterval> }) as typeof setInterval
  globalThis.clearInterval = (() => { cleared++ }) as typeof clearInterval
  return {
    tick: () => { if (!callback) throw new Error('interval callback not registered'); callback() },
    cleared: () => cleared,
    restore: () => { globalThis.setInterval = realSet; globalThis.clearInterval = realClear },
  }
}

test('标准平台流：先把输出画布附到真实宿主并复制首帧，再以 fps 开独立输出画布流，不手动 requestFrame', () => {
  const {viewer, captureCalls, mainCaptureCalls, requestFrames, events, mountEvents, host, outputs} = fixture(true)
  const timer = stubTimer()
  try {
    const target = viewer.captureCanvasStream(60)
    // 顺序是判据：附着 → 首帧 clean render + drawImage → 平台开流；主画布不参与取帧。
    expect(mountEvents).toEqual(["append"])
    expect(events.slice(0, 4)).toEqual(["render", "drawImage", "render", "captureStream"])
    expect(captureCalls).toEqual([60])
    expect(mainCaptureCalls).toEqual([])
    expect(requestFrames.length).toBe(0)
    expect(target.width).toBe(160)
    expect(target.height).toBe(120)
    // 画布在首帧/开流时已在 Viewer host 内，但样式/aria 不形成第二块可见 UI，也不改画布像素尺寸。
    expect(host.children).toEqual([outputs[0]])
    expect(outputs[0].mountedAtDraw).toBe(true)
    expect(outputs[0].mountedAtCapture).toBe(true)
    expect(outputs[0].width).toBe(160)
    expect(outputs[0].height).toBe(120)
    expect(outputs[0].attrs["aria-hidden"]).toBe("true")
    expect(outputs[0].tabIndex).toBe(-1)
    expect(outputs[0].style).toMatchObject({position: "absolute", left: "0", top: "0", width: "1px", height: "1px", opacity: "0", pointerEvents: "none"})
    expect(outputs[0].style.display).toBeUndefined()
    expect(outputs[0].style.visibility).toBeUndefined()
    target.stop()
    // stop 只摘除本轮节点。
    expect(mountEvents).toEqual(["append", "remove"])
    expect(host.children).toEqual([])
    expect(outputs[0].parentNode).toBeNull()
  } finally { timer.restore() }
})

test('平台流每 tick 继续真实 clean render + 同步 drawImage，静止场景也不会只有首帧', () => {
  const {viewer, captureCalls, events, helperVisibility, counts, host} = fixture(true)
  const timer = stubTimer()
  try {
    viewer.captureRouteRoot.visible = true
    viewer.captureRouteCurrentRoot.visible = true
    const target = viewer.captureCanvasStream(30)
    expect(events.filter(event => event === "drawImage").length).toBe(1)
    expect(events.filter(event => event === "render").length).toBe(2)
    // 场景没有任何变化，但定时器仍每 tick 真实 render + drawImage，平台因此持续收到新画面。
    for (let index = 0; index < 5; index++) timer.tick()
    expect(events.filter(event => event === "drawImage").length).toBe(6)
    expect(events.filter(event => event === "render").length).toBe(12)
    expect(helperVisibility().atDraw).toEqual([false, false])
    expect(viewer.captureRouteRoot.visible).toBe(true)
    expect(viewer.captureRouteCurrentRoot.visible).toBe(true)
    // 平台流只打开一次，不因 tick 重建轨道。
    expect(captureCalls).toEqual([30])
    target.stop()
    expect(timer.cleared()).toBe(1)
    expect(counts().stopped).toBe(1)
    expect(viewer.captureStreamStops.size).toBe(0)
    expect(host.children).toEqual([])
    const frames = events.filter(event => event === "drawImage").length
    timer.tick()
    expect(events.filter(event => event === "drawImage").length).toBe(frames)
  } finally { timer.restore() }
})

test('stop 清定时器、平台流轨道、本次节点与集合，且幂等', () => {
  const {viewer, counts, host, outputs} = fixture(true)
  const timer = stubTimer()
  try {
    const target = viewer.captureCanvasStream(30)
    expect(viewer.captureStreamStops.size).toBe(1)
    expect(host.children.length).toBe(1)
    target.stop()
    expect(timer.cleared()).toBe(1)
    expect(counts().stopped).toBe(1)
    expect(viewer.captureStreamStops.size).toBe(0)
    expect(host.children).toEqual([])
    expect(outputs[0].parentNode).toBeNull()
    target.stop() // 幂等
    expect(timer.cleared()).toBe(1)
    expect(counts().stopped).toBe(1)
    expect(viewer.captureStreamStops.size).toBe(0)
    expect(host.children).toEqual([])
  } finally { timer.restore() }
})

test('Start 后立刻 Stop：首帧已在开流前真实复制，停止仍释放平台轨道并移除本次节点', () => {
  const {viewer, captureCalls, events, counts, host} = fixture(true)
  const timer = stubTimer()
  try {
    const target = viewer.captureCanvasStream(30)
    // 还没有任何 timer tick；平台轨道建立时画布上已经是本次录制的第一张真实干净帧。
    expect(events.filter(event => event === "drawImage").length).toBe(1)
    expect(captureCalls).toEqual([30])
    target.stop()
    expect(timer.cleared()).toBe(1)
    expect(counts().stopped).toBe(1)
    expect(viewer.captureStreamStops.size).toBe(0)
    expect(host.children).toEqual([])
  } finally { timer.restore() }
})

test('取消后立即重录：每次 Start 新建自己的节点/平台流，旧 stop 不清新流的轨道、定时器或节点', () => {
  const {viewer, captureCalls, events, counts, mountEvents, host, outputs} = fixture(true)
  const timer = stubTimer()
  try {
    // 第一段在首帧之后、首次 timer tick 之前 Cancel；它的 1×1 节点必须立刻消失。
    const first = viewer.captureCanvasStream(30)
    expect(host.children).toEqual([outputs[0]])
    first.stop()
    expect(viewer.captureStreamStops.size).toBe(0)
    expect(host.children).toEqual([])
    // 立即重录：新的输出画布平台流与自己的首帧/定时器，不复用旧轨道、旧节点。
    const second = viewer.captureCanvasStream(30)
    expect(captureCalls).toEqual([30, 30])
    expect(viewer.captureStreamStops.size).toBe(1)
    expect(counts().stopped).toBe(1)
    expect(host.children).toEqual([outputs[1]])
    expect(outputs[1]).not.toBe(outputs[0])
    expect(outputs[0].parentNode).toBeNull()
    expect(outputs[1].parentNode).toBe(host)
    const frames = events.filter(event => event === "drawImage").length
    timer.tick()
    expect(events.filter(event => event === "drawImage").length).toBe(frames + 1)
    second.stop()
    expect(timer.cleared()).toBe(2)
    expect(counts().stopped).toBe(2)
    expect(viewer.captureStreamStops.size).toBe(0)
    expect(mountEvents).toEqual(["append", "remove", "append", "remove"])
    expect(host.children).toEqual([])
    expect(outputs.every(output => output.parentNode === null)).toBe(true)
  } finally { timer.restore() }
})

test('Viewer.dispose 经由 captureStreamStops 清掉平台流定时器、轨道与本次节点', () => {
  const {viewer, counts, host, outputs} = fixture(true)
  const timer = stubTimer()
  const scope = globalThis as Record<string, unknown>
  const realCancel = scope.cancelAnimationFrame
  scope.cancelAnimationFrame = () => {}
  try {
    viewer.captureCanvasStream(30)
    expect(viewer.captureStreamStops.size).toBe(1)
    expect(host.children.length).toBe(1)
    // 只补 dispose 所需的宿主/资源替身；流清理仍走真实 dispose 代码路径。
    viewer.exitCameraMode = () => {}
    viewer.clearRouteCaptureView = () => {}
    viewer.clearPartState = () => {}
    viewer.clearAssemblyPreview = () => {}
    viewer.clearSurfaceMountMarker = () => {}
    viewer.markers = new Map()
    viewer.annotations = []
    viewer.annotationRoot = {clear: () => {}}
    viewer.cameraRigs = new Map()
    viewer.objects = new Map()
    viewer.gltfs = new Map()
    viewer.gltfStats = new Map()
    viewer.materialEnvironment = {dispose: () => {}}
    viewer.resize = {disconnect: () => {}}
    viewer.firstPerson = {dispose: () => {}}
    viewer.controls = {dispose: () => {}}
    viewer.transformControls = {dispose: () => {}}
    viewer.releasePreview = () => {}
    viewer.releaseEnvironmentMap = () => {}
    viewer.renderer.dispose = () => {}
    viewer.renderer.domElement.remove = () => {}
    viewer.dispose()
    expect(timer.cleared()).toBe(1)
    expect(counts().stopped).toBe(1)
    expect(viewer.captureStreamStops.size).toBe(0)
    expect(host.children).toEqual([])
    expect(outputs[0].parentNode).toBeNull()
  } finally {
    if (realCancel) scope.cancelAnimationFrame = realCancel; else Reflect.deleteProperty(scope, "cancelAnimationFrame")
    timer.restore()
  }
})

test('首帧渲染/复制失败时不建立平台流，也移除已附着的本次节点且不留定时器/空轨道', () => {
  const {viewer, captureCalls, mainCaptureCalls, host, outputs, mountEvents, counts} = fixture(true)
  const timer = stubTimer()
  try {
    viewer.drawCleanCaptureFrame = () => { throw new Error('FIRST_FRAME_FAILED') }
    expect(() => viewer.captureCanvasStream(30)).toThrow('FIRST_FRAME_FAILED')
    expect(captureCalls).toEqual([])
    expect(mainCaptureCalls).toEqual([])
    expect(timer.cleared()).toBe(0)
    expect(counts().stopped).toBe(0)
    expect(viewer.captureStreamStops.size).toBe(0)
    expect(mountEvents).toEqual(["append", "remove"])
    expect(host.children).toEqual([])
    expect(outputs[0].parentNode).toBeNull()
  } finally { timer.restore() }
})

test('开流本身失败时停止本次平台流尝试并移除本次节点，不留下半开录制', () => {
  const {viewer, failures, host, outputs, mountEvents, counts} = fixture(true)
  const timer = stubTimer()
  try {
    failures.capture = true
    expect(() => viewer.captureCanvasStream(30)).toThrow('OPEN_FAILED')
    expect(timer.cleared()).toBe(0)
    expect(counts().stopped).toBe(0)
    expect(viewer.captureStreamStops.size).toBe(0)
    expect(mountEvents).toEqual(["append", "remove"])
    expect(host.children).toEqual([])
    expect(outputs[0].parentNode).toBeNull()
  } finally { timer.restore() }
})

test('宿主不可用：明确报错且不创建离树输出画布', () => {
  const {viewer, outputs, counts} = fixture(true)
  const timer = stubTimer()
  try {
    viewer.renderer.domElement.parentElement = null
    expect(() => viewer.captureCanvasStream(30)).toThrow('VIEWER_CAPTURE_SURFACE_HOST_UNAVAILABLE')
    expect(outputs).toEqual([])
    expect(counts().stopped).toBe(0)
    expect(viewer.captureStreamStops.size).toBe(0)
  } finally { timer.restore() }
})

test('后续 clean draw 抛错时停止平台流、释放轨道并移除本次节点，不留下半开录制', () => {
  const {viewer, counts, host, outputs, mountEvents} = fixture(true)
  const timer = stubTimer()
  try {
    const target = viewer.captureCanvasStream(30)
    viewer.drawCleanCaptureFrame = () => { throw new Error('DRAW_FAILED') }
    timer.tick()
    expect(timer.cleared()).toBe(1)
    expect(counts().stopped).toBe(1)
    expect(viewer.captureStreamStops.size).toBe(0)
    expect(mountEvents).toEqual(["append", "remove"])
    expect(host.children).toEqual([])
    expect(outputs[0].parentNode).toBeNull()
    target.stop()
    expect(counts().stopped).toBe(1)
    expect(host.children).toEqual([])
  } finally { timer.restore() }
})

test('干净副本顺序：隐藏 helper → render → 同步 drawImage 输出画布 → 恢复 → 再开平台流', () => {
  const {viewer, events, helperVisibility, captureCalls} = fixture(true)
  const timer = stubTimer()
  try {
    viewer.captureRouteRoot.visible = true
    viewer.captureRouteCurrentRoot.visible = true
    const target = viewer.captureCanvasStream(30)
    expect(events.slice(0, 4)).toEqual(["render", "drawImage", "render", "captureStream"])
    expect(helperVisibility().atDraw).toEqual([false, false])
    // helper 在平台开流之前已恢复；输出画布里的内容仍是刚才复制好的干净帧。
    expect(viewer.captureRouteRoot.visible).toBe(true)
    expect(viewer.captureRouteCurrentRoot.visible).toBe(true)
    expect(captureCalls).toEqual([30])
    target.stop()
    expect(viewer.captureStreamStops.size).toBe(0)
  } finally { timer.restore() }
})

test('临时 route capture view：首帧视频用临时相机渲染，主相机不被移动；清理后不再激活', () => {
  const {viewer, renders} = fixture(true)
  const timer = stubTimer()
  try {
    viewer.camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 100)
    viewer.camera.position.set(5, -6, 4)
    viewer.updateLod = () => {}
    const before = viewer.camera.position.toArray()
    viewer.setRouteCaptureView({position: [1, 2, 3], quaternion: [0, 0, 0, 1], target: [1, 2, 2], up: [0, 1, 0], fovDeg: 50, near: 0.1, far: 100})
    expect(viewer.routeCaptureViewActive()).toBe(true)
    const target = viewer.captureCanvasStream(30)
    // 开流前的首帧来自路线临时相机 A；随后恢复主相机重绘屏幕。
    expect(renders.length).toBe(2)
    expect(renders[0]).not.toBe(viewer.camera)
    expect(renders[1]).toBe(viewer.camera)
    expect(viewer.camera.position.toArray()).toEqual(before)
    viewer.clearRouteCaptureView()
    expect(viewer.routeCaptureViewActive()).toBe(false)
    target.stop()
  } finally { timer.restore() }
})

test('drawCleanCaptureFrame：临时 POV 的同步 copy 抛错时 finally 恢复主相机屏幕与 LOD，helper 也恢复', () => {
  const { viewer } = fixture(true)
  const renders: unknown[] = [], lods: unknown[] = []
  viewer.camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 100)
  viewer.updateLod = (camera: unknown) => { lods.push(camera) }
  viewer.renderer = { domElement: { width: 160, height: 120 }, render: (_scene: unknown, camera: unknown) => { renders.push(camera) } }
  viewer.captureRouteRoot.visible = true
  viewer.captureRouteCurrentRoot.visible = true
  viewer.setRouteCaptureView({ position: [1, 2, 3], quaternion: [0, 0, 0, 1], target: [1, 2, 2], up: [0, 1, 0], fovDeg: 50, near: 0.1, far: 100 })
  const output = { width: 160, height: 120, getContext: () => ({ drawImage: () => { throw new Error('COPY_FAILED') } }) }
  expect(() => viewer.drawCleanCaptureFrame(output)).toThrow('COPY_FAILED')
  // 临时 POV 渲染后 copy 失败：主画布不能被留在 POV；LOD 也按主相机恢复。
  expect(renders.at(-1)).toBe(viewer.camera)
  expect(lods.at(-1)).toBe(viewer.camera)
  expect(viewer.captureRouteRoot.visible).toBe(true)
  expect(viewer.captureRouteCurrentRoot.visible).toBe(true)
  // 临时 POV **render 本身**失败也在 finally 恢复主画面与 LOD。
  renders.length = 0
  viewer.renderer = { domElement: { width: 160, height: 120 }, render: (_scene: unknown, camera: unknown) => { if (camera !== viewer.camera) throw new Error('ROUTE_RENDER_FAILED'); renders.push(camera) } }
  const output2 = { width: 160, height: 120, getContext: () => ({ drawImage: () => {} }) }
  expect(() => viewer.drawCleanCaptureFrame(output2)).toThrow('ROUTE_RENDER_FAILED')
  expect(renders.at(-1)).toBe(viewer.camera)
  expect(lods.at(-1)).toBe(viewer.camera)
})

test('renderRouteCapturePreview：临时相机渲染/同步 copy 抛错时返回 false 且 finally 用主相机重绘', () => {
  const { viewer } = fixture(true)
  const renders: unknown[] = []
  viewer.camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 100)
  viewer.updateLod = () => {}
  viewer.renderer = { domElement: { width: 160, height: 120 }, render: (_scene: unknown, camera: unknown) => { renders.push(camera) } }
  viewer.captureRouteRoot.visible = true
  viewer.captureRouteCurrentRoot.visible = true
  viewer.setRouteCaptureView({ position: [1, 2, 3], quaternion: [0, 0, 0, 1], target: [1, 2, 2], up: [0, 1, 0], fovDeg: 50, near: 0.1, far: 100 })
  const target = { width: 0, height: 0, getContext: () => ({ drawImage: () => { throw new Error('COPY_FAILED') } }) }
  expect(viewer.renderRouteCapturePreview(target as never, 96)).toBe(false)
  expect(renders.length).toBe(2)
  expect(renders[0]).not.toBe(viewer.camera)
  expect(renders[1]).toBe(viewer.camera)
  expect(viewer.captureRouteRoot.visible).toBe(true)
  expect(viewer.captureRouteCurrentRoot.visible).toBe(true)
  // 临时相机 render 抛错：同样返回 false，且 finally 仍用主相机重绘。
  renders.length = 0
  viewer.renderer = { domElement: { width: 160, height: 120 }, render: (_scene: unknown, camera: unknown) => { if (camera !== viewer.camera) throw new Error('ROUTE_RENDER_FAILED'); renders.push(camera) } }
  expect(viewer.renderRouteCapturePreview(target as never, 96)).toBe(false)
  expect(renders.at(-1)).toBe(viewer.camera)
})

test('clean capture：未提交的 placement ghost 与既有 authoring ghost 一起隐藏，渲染后原样恢复', () => {
  const {viewer} = fixture(false)
  const placement = {visible: true}, assembly = {visible: true}, parking = {visible: true}
  viewer.assemblyGhost = {root: assembly, marker: {visible: true}}
  viewer.parkingGhost = {root: parking}
  viewer.placementGhost = {root: placement, token: 'p', materials: [], dispose: () => {}}
  const seen = viewer.withoutCaptureHelpers(() => ({placement: placement.visible, assembly: assembly.visible, parking: parking.visible}))
  expect(seen).toEqual({placement: false, assembly: false, parking: false})
  expect([placement.visible, assembly.visible, parking.visible]).toEqual([true, true, true])
})
