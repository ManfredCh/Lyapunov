/**
 * V10 Scene focus 真实 DOM 接线：宽窗也有紧凑入口；窄窗首次到达自动进入；用户手动退出后
 * 同一轮 resize 不再抢回。只用公开 `sceneFocus` 回调（真实接线由 native-workspace 的
 * `commandTarget/toggleFullscreen` 提供），不伪造 DOM click/键盘。
 */
import { test, expect, mock } from "bun:test"
import { projectSceneCameraRigs } from "../../viewer/src/scene-camera-rigs.ts"

let viewerFactory: (...args: unknown[]) => any = () => ({})
mock.module("@lyapunov/viewer/client", () => ({
  projectSceneCameraRigs,
  createViewer: (...args: unknown[]) => viewerFactory(...args),
  WebGLUnavailableError: class extends Error {},
}))

const wait = (ms: number) => new Promise(done => setTimeout(done, ms))

test("宽窗有 Scene focus 入口；窄窗首次自动进入；手动退出后本轮 resize 不抢回", async () => {
  const { createRequire } = await import("node:module")
  const req = createRequire(new URL("../../../.upstream/deepseek-harness-20260911-candidate/package.json", import.meta.url))
  const { JSDOM } = req("jsdom")
  const dom = new JSDOM('<div id="root"></div>', { url: "http://fixture.invalid", pretendToBeVisual: true })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const key of ["window", "document", "HTMLElement", "Node", "navigator", "localStorage", "sessionStorage", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    const value = key === "IS_REACT_ACT_ENVIRONMENT" ? true : typeof (dom.window as any)[key] === "function" && key.includes("AnimationFrame") ? (dom.window as any)[key].bind(dom.window) : (dom.window as any)[key]
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  saved.set("ResizeObserver", Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver"))
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class { observe() {} disconnect() {} } })
  saved.set("fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch"))
  const scene = { sceneId: "focus-scene", revision: 1, coordinates: { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" }, entities: [] }
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    const data = url.includes("/state?") ? { hostInstanceId: "host-focus", scene, worlds: [], providerAvailable: false }
      : url.includes("/scenes") ? [{ sceneId: scene.sceneId }]
      : url.includes("/engine-preference") ? { engine: "mujoco" }
      : url.includes("builtin-assets") ? { resources: [] }
      : url.includes("/assets") || url.includes("missing-assets") ? []
      : []
    return Response.json(data)
  }) as typeof fetch
  viewerFactory = (options: any) => {
    const view = { position: [5, -6, 4], quaternion: [0, 0, 0, 1], target: [0, 0, .7], up: [0, 0, 1], fov: 50, near: .1, far: 1000, zoom: 1, navigation: "orbit" }
    const observer = { mode: "free", navigation: "orbit", dirty: false, saving: false, scope: {} }
    const target: any = { options, getViewState: () => view, setScene: () => Promise.resolve(), subscribeObserverState: () => () => {}, observerState: () => observer, environmentStatus: () => ({ hdriMimeTypes: [], warnings: [], ignored: [] }), collisionStatus: () => ({ status: "disabled" }), animationStatus: () => ({ playing: false, clips: [] }), renderer: { domElement: document.createElement("canvas") }, dispose: () => {} }
    return new Proxy(target, { get(t, key) { if (key in t) return (t as any)[key]; return () => {} } })
  }
  ;(dom.window as any).HTMLCanvasElement.prototype.getContext = () => null
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return 984 } })
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, writable: true, value: 1440 })
  const { createElement, useState, act } = await import("react")
  const { createRoot } = await import("react-dom/client")
  const { Workbench } = await import("../src/workbench.tsx")
  const root = createRoot(document.getElementById("root")!)
  const tr = (_zh: string, en: string) => en
  const flush = (ms = 340) => act(async () => { await wait(ms) })
  const calls: string[] = []
  function Host() {
    const [active, setActive] = useState(false)
    return createElement(Workbench, {
      sessionId: "focus-flow", nativeTab: true, t: (key: string) => key === "open" ? "Scene workbench" : "场景工作台",
      renderSlot: (_n: any, _p: any, options: any) => options?.fallback ?? null,
      sceneFocus: () => { calls.push(active ? "exit" : "focus"); setActive(value => !value) },
      sceneFocusActive: active,
    } as any)
  }
  try {
    await act(async () => root.render(createElement(Host)))
    await flush(); await flush()
    // 宽窗也有入口（不是只有 <=1100 才渲染）。
    const wideButton = document.querySelector<HTMLButtonElement>('[data-testid="scene-focus"]')
    expect(wideButton).not.toBeNull()
    expect(wideButton!.getAttribute("aria-label")).toBe("Scene focus")
    expect(wideButton!.textContent).toBe("⛶")
    expect(calls).toHaveLength(0)
    // V10：Controls、Frame selection/Frame scene 与 Scene focus 在同一 Lyapunov 自有 flex 行里，
    // 不再各自绝对定位到画布左上角。
    const toolbar=document.querySelector('.lya-canvas-toolbar')!
    expect(toolbar).not.toBeNull()
    expect(toolbar.querySelector('[data-testid="viewer-controls-help"]')).not.toBeNull()
    expect(toolbar.querySelector('[data-testid="frame-selection"]')!.closest('.lya-frame-actions')).not.toBeNull()
    expect(toolbar.querySelector('[data-testid="frame-scene"]')!.closest('.lya-frame-actions')).not.toBeNull()
    expect(wideButton!.closest('.lya-canvas-toolbar')).toBe(toolbar)
    expect(document.querySelector('[data-testid="frame-placement"]')).toBeNull()
    // Controls 展开后仍在同一行，不挤压/遮住 Frame 与 Scene focus 的 DOM 兄弟关系。
    await act(async () => (toolbar.querySelector('[data-testid="viewer-controls-help"] button') as HTMLButtonElement).click())
    expect(toolbar.querySelector('.lya-viewport-help-body')).not.toBeNull()
    expect(toolbar.contains(document.querySelector('[data-testid="frame-scene"]'))).toBe(true)
    expect(toolbar.contains(wideButton)).toBe(true)
    // 窄窗首次到达：真实 resize 后自动调用公开 focus。
    Object.defineProperty(dom.window, "innerWidth", { configurable: true, writable: true, value: 974 })
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("resize")) })
    await flush()
    expect(calls).toEqual(["focus"])
    const narrowButton = document.querySelector<HTMLButtonElement>('[data-testid="scene-focus"]')!
    expect(narrowButton.getAttribute("aria-label")).toBe("Exit Scene focus")
    // 用户手动退出：再来一次 resize/轮询不得抢回。
    await act(async () => narrowButton.click())
    expect(calls).toEqual(["focus", "exit"])
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("resize")) })
    await flush()
    expect(calls).toEqual(["focus", "exit"])
    // 宽窗恢复：自动进入的全屏必须退出，否则 Chat 永远回不来（设计稿宽窗页都带 Chat）。
    // 回到宽窗（重置本轮自动标记）→ 再进窄窗（自动 focus）→ 放大（自动 exit）。
    Object.defineProperty(dom.window, "innerWidth", { configurable: true, writable: true, value: 1440 })
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("resize")) })
    await flush()
    expect(calls).toEqual(["focus", "exit"])
    Object.defineProperty(dom.window, "innerWidth", { configurable: true, writable: true, value: 974 })
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("resize")) })
    await flush()
    expect(calls).toEqual(["focus", "exit", "focus"])
    Object.defineProperty(dom.window, "innerWidth", { configurable: true, writable: true, value: 1440 })
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("resize")) })
    await flush()
    expect(calls).toEqual(["focus", "exit", "focus", "exit"])
    expect(document.querySelector<HTMLButtonElement>('[data-testid="scene-focus"]')!.getAttribute("aria-label")).toBe("Scene focus")
    // 三态闭环：宽→窄(自动进) → 宽(自动退) → 窄(必须**再**自动进)。
    Object.defineProperty(dom.window, "innerWidth", { configurable: true, writable: true, value: 974 })
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("resize")) })
    await flush()
    expect(calls).toEqual(["focus", "exit", "focus", "exit", "focus"])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) }
  }
}, 20000)
