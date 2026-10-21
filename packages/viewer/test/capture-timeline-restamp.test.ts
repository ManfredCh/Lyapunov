/**
 * R-005/V10 独立回归：连续视频时间轴以**平台真实采集时刻**为准，而不是手动 requestFrame 的名义
 * 1/fps。
 *
 * 真实失败（P23）：4.6 s 的 A→B→C 路线在成品里只剩约 2.2 s（80 包 ×33 ms），因为
 * `captureStream(0)` + `requestFrame()` 的时间戳按名义 1/30 递增，而真实出帧只有 ~15 fps。
 * 上一轮用 MediaStreamTrackProcessor/TrackGenerator 重打墙钟，但跨录制出现 0 B；V10 改为
 * 独立输出画布的 `captureStream(fps)` 平台流：由平台按真实采集时刻填时间戳。
 *
 * 本文件锁定：即使实验性媒体 API 存在也不使用；每 tick 的 clean draw 发生在真实墙钟时刻；立即 Stop
 * 时首帧已经在开流前复制。离线、确定性，不触网不启 GPU。
 */
import {test, expect, afterEach} from 'bun:test'
import {SceneViewer} from '../src/index.ts'

const documentCleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of documentCleanups.splice(0)) cleanup() })

function fixture() {
  const drawTimes: number[] = [], captureCalls: number[] = [], mainCaptureCalls: number[] = []
  const events: string[] = []
  let stopped = 0
  const hostChildren: any[] = []
  const host: any = {
    appendChild(node: any) { hostChildren.push(node); node.parentNode = host; return node },
    removeChild(node: any) { const index = hostChildren.indexOf(node); if (index >= 0) hostChildren.splice(index, 1); node.parentNode = null; return node },
  }
  const makeStream = () => {
    const track = {stop: () => { stopped++ }, requestFrame: () => { events.push("requestFrame") }}
    return {getVideoTracks: () => [track], getTracks: () => [track]}
  }
  const mainCanvas = {width: 64, height: 48, parentElement: host, parentNode: host, captureStream: (fps: number) => { mainCaptureCalls.push(fps); return makeStream() }}
  const outputCanvas = {
    width: 64, height: 48, parentNode: null as any, style: {} as Record<string, string>,
    setAttribute: () => {},
    getContext: (kind: string) => kind === "2d" ? {drawImage: () => { drawTimes.push(performance.now()); events.push("drawImage") }} : null,
    captureStream: (fps: number) => { captureCalls.push(fps); events.push("captureStream"); return makeStream() },
  }
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  Object.defineProperty(globalThis, "document", {configurable: true, value: {createElement: () => outputCanvas}})
  documentCleanups.push(() => { if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else Reflect.deleteProperty(globalThis, "document") })
  const viewer = Object.create(SceneViewer.prototype) as any
  viewer.disposed = false; viewer.scene = {}; viewer.camera = {}
  viewer.renderer = {domElement: mainCanvas, render: () => { events.push("render") }}
  viewer.captureStreamStops = new Set<() => void>()
  viewer.captureRouteRoot = {visible: false, children: []}
  viewer.captureRouteCurrentRoot = {visible: false, children: []}
  return {viewer, drawTimes, captureCalls, mainCaptureCalls, events, host, hostChildren, stopped: () => stopped}
}

/** 实验性媒体 API 替身：只记录是否被构造；生产路径不应碰它们。 */
function withExperimentalGlobals<T>(run: (used: {generator: number; processor: number; frame: number}) => T): T {
  const used = {generator: 0, processor: 0, frame: 0}
  const scope = globalThis as Record<string, unknown>
  const saved = {Generator: scope.MediaStreamTrackGenerator, Processor: scope.MediaStreamTrackProcessor, Frame: scope.VideoFrame}
  scope.MediaStreamTrackGenerator = class { constructor() { used.generator++ } }
  scope.MediaStreamTrackProcessor = class { constructor() { used.processor++ } }
  scope.VideoFrame = class { constructor() { used.frame++ } }
  try { return run(used) } finally {
    scope.MediaStreamTrackGenerator = saved.Generator; scope.MediaStreamTrackProcessor = saved.Processor; scope.VideoFrame = saved.Frame
  }
}

/** 可控时钟 + 手动 timer：验证 draw 发生在真实墙钟时刻，而不是名义 1/fps。 */
function withClock(run: (ctx: {advanceTo: (ms: number) => void; tick: () => void}) => void) {
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval
  let outputTick: (() => void) | undefined
  globalThis.setInterval = ((fn: () => void) => { outputTick = fn; return 1 as unknown as ReturnType<typeof setInterval> }) as typeof setInterval
  globalThis.clearInterval = (() => {}) as typeof clearInterval
  const clock = {now: 1_000}
  const realNow = performance.now
  Object.defineProperty(performance, 'now', {configurable: true, value: () => clock.now})
  try { run({advanceTo: ms => { clock.now = ms }, tick: () => outputTick?.()}) }
  finally {
    Object.defineProperty(performance, 'now', {configurable: true, value: realNow})
    globalThis.setInterval = realSet; globalThis.clearInterval = realClear
  }
}

test('平台流是唯一生产路径：实验性 Processor/Generator/VideoFrame 存在也不使用', () => {
  const {viewer, captureCalls, mainCaptureCalls, events, hostChildren, stopped} = fixture()
  withExperimentalGlobals(used => {
    const target = viewer.captureCanvasStream(30)
    expect(used).toEqual({generator: 0, processor: 0, frame: 0})
    expect(captureCalls).toEqual([30])
    expect(mainCaptureCalls).toEqual([])
    expect(events).not.toContain("requestFrame")
    expect(hostChildren.length).toBe(1)
    target.stop()
    expect(stopped()).toBe(1)
    expect(viewer.captureStreamStops.size).toBe(0)
    expect(hostChildren).toEqual([])
  })
})

test('绘制节奏按墙钟：300/600 ms 的真实间隔照原样送到平台，不是名义 33 ms 序列', () => {
  const {viewer, drawTimes, captureCalls, hostChildren} = fixture()
  withClock(ctx => {
    const target = viewer.captureCanvasStream(30)
    // 开流前的首帧已经在墙钟 1000 ms 真实绘制。
    expect(drawTimes).toEqual([1_000])
    ctx.advanceTo(1_300); ctx.tick()
    ctx.advanceTo(1_900); ctx.tick()
    expect(drawTimes).toEqual([1_000, 1_300, 1_900])
    // 平台按这些真实采集时刻出帧；不是 0/33_333/66_666 µs 的手动名义序列。
    expect(drawTimes[1]! - drawTimes[0]!).toBe(300)
    expect(drawTimes[2]! - drawTimes[1]!).toBe(600)
    expect(captureCalls).toEqual([30])
    target.stop()
    expect(viewer.captureStreamStops.size).toBe(0)
    expect(hostChildren).toEqual([])
  })
})

test('立即 Start→Stop：首帧复制在开流之前，平台轨道被释放，本次节点被移除且不存在手动时间戳链路', () => {
  const {viewer, captureCalls, events, hostChildren, stopped} = fixture()
  const target = viewer.captureCanvasStream(30)
  // 没有 timer tick：开流前已经真实 draw 过首帧。
  expect(events.slice(0, 4)).toEqual(["render", "drawImage", "render", "captureStream"])
  expect(events).not.toContain("requestFrame")
  expect(captureCalls).toEqual([30])
  expect(hostChildren.length).toBe(1)
  target.stop()
  expect(stopped()).toBe(1)
  expect(viewer.captureStreamStops.size).toBe(0)
  expect(hostChildren).toEqual([])
})
