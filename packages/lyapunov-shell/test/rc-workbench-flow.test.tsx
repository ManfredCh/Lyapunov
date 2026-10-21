/**
 * RC P1（R-001/R-002/R-003/R-009）：真实 `Workbench` 的入口与目标上下文。
 *
 * 用已发布 SDK 的 jsdom、真实 React 组件、真实 `Workbench` 与注入的 viewer/HTTP 端口；不接触产品窗口、
 * 物理引擎或真实服务。覆盖验收要求的关键路径：
 *  · 工具轨点击 Objects/Environment/Physics 打开对应面板；Physics 在 Scene 首屏不再出现；
 *  · Objects 首屏是清单，行尾 Properties 进入同栏二级 Inspector，顶部可返回；
 *  · 未提交草稿在返回清单、切工具后仍在同一个 EntityEditor owner 里（不新建第二份）；
 *  · Environment 首屏是资源/Lighting 清单，进入 Lighting 才显示参数页，返回后又回到清单；
 *  · 各域本地导入表单只在点开时出现（全局 Library 已退出）。
 *
 * 边界：这不是浏览器真机截图验收，也不验证真实资源传输；它是行为回归，防止结构回退。
 */
import {test, expect, mock} from "bun:test"
import * as THREE from "three"
import {projectSceneCameraRigs} from "../../viewer/src/scene-camera-rigs.ts"

let viewerFactory: (...args: unknown[]) => any = () => ({})
let capturedViewerOptions: any
let capturedDisplaySettings: any[] = []
mock.module("@lyapunov/viewer/client", () => ({
  projectSceneCameraRigs,
  createViewer: (...args: unknown[]) => { capturedViewerOptions = args[0]; return viewerFactory(...args) },
  WebGLUnavailableError: class extends Error {},
}))

function sceneFixture() {
  return {
    sceneId: "rc-flow-scene", revision: 3,
    coordinates: {units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw"},
    entities: [
      {entityId: "alpha", name: "alpha", transform: {position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1]}, resources: [], components: {}},
      {entityId: "alpha:source", parentId: "alpha", name: "源坐标转换", transform: {position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1]}, resources: [], components: {}},
      {entityId: "beta", name: "beta", transform: {position: [1, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1]}, resources: [], components: {}},
      {entityId: "robot-1", name: "Panda", transform: {position: [0, 2, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1]}, resources: [], components: {articulation: {}}},
      {entityId: "robot-1/wrist", parentId: "robot-1", name: "Wrist camera", transform: {position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1]}, resources: [], components: {camera: {}}},
    ],
  }
}

// P16 单例预算：本条是一个 37 断言的多步骤真实 React/DOM 集成流程（jsdom 真渲染 + 真实 Workbench/
// ToolRail + 真实事件 handler + 两次 520ms 轮询等待），完整 CI 实测 5036.03ms，Bun 默认 5000ms/用例
// 预算会截断。仅为这条流程显式声明 20_000ms；全部步骤/断言/DOM 真实 handler 与文件级 120_000ms 上限不动。
test("真实 Workbench：工具轨、Objects 清单/二级 Inspector 与草稿、Environment 二级、独立 Physics", async () => {
  const {createRequire} = await import("node:module")
  const req = createRequire(new URL("../../../.upstream/deepseek-harness-20260911-candidate/package.json", import.meta.url))
  const {JSDOM} = req("jsdom")
  const dom = new JSDOM('<div id="root"></div>', {url: "http://fixture.invalid", pretendToBeVisual: true})
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const key of ["window", "document", "HTMLElement", "Node", "navigator", "localStorage", "sessionStorage", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    const value = key === "IS_REACT_ACT_ENVIRONMENT" ? true : typeof (dom.window as any)[key] === "function" && key.includes("AnimationFrame") ? (dom.window as any)[key].bind(dom.window) : (dom.window as any)[key]
    Object.defineProperty(globalThis, key, {configurable: true, value})
  }
  saved.set("ResizeObserver", Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver"))
  Object.defineProperty(globalThis, "ResizeObserver", {configurable: true, value: class {observe() {} disconnect() {}}})
  saved.set("fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch"))
  const scene = sceneFixture()
  const otherSceneId = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    const data = url.includes("/state?") ? {hostInstanceId: "host-rc", scene, worlds: [], providerAvailable: false}
      : url.includes("/scenes") ? [{sceneId: scene.sceneId}, {sceneId: otherSceneId, name: "Warehouse"}]
      : url.includes("/engine-preference") ? {engine: "mujoco"}
      : url.includes("/selection") ? {updated: true}
      : url.includes("builtin-assets") ? {resources: []}
      : url.includes("/assets") || url.includes("missing-assets") ? []
      : []
    return Response.json(data)
  }) as typeof fetch
  // Viewer 的环境读数是可注入的：测试替换这个对象即可驱动 未启用/HDRI/自定义 三条真实分支，
  // 而不是只检验源码里出现过某段字符串。整体替换（不是原地改字段）才能让 setState 的 JSON 比较生效。
  let environmentStatusFixture: any = {hdriMimeTypes: [], warnings: [], ignored: []}
  capturedDisplaySettings = []
  viewerFactory = (options: any) => {
    const view = {position: [5, -6, 4], quaternion: [0, 0, 0, 1], target: [0, 0, .7], up: [0, 0, 1], fov: 50, near: .1, far: 1000, zoom: 1, navigation: "orbit"}
    // observerState 的返回值必须是稳定引用：useSyncExternalStore 每次渲染都拿它，返回新对象会自激循环。
    const observer = {mode: "free", navigation: "orbit", dirty: false, saving: false, scope: {}}
    const target: any = {
      options, calls: [],
      renderer: {domElement: document.createElement("canvas")},
      getViewState: () => view,
      setScene: () => Promise.resolve(),
      subscribeObserverState: () => () => {},
      observerState: () => observer,
      environmentStatus: () => environmentStatusFixture,
      collisionStatus: () => ({status: "disabled"}),
      animationStatus: () => ({playing: false, clips: []}),
      setDisplaySettings: (value: any) => capturedDisplaySettings.push({...value}),
      dispose: () => {},
    }
    return new Proxy(target, {get(t, key) { if (key in t) return (t as any)[key]; return () => {} }})
  }
  (dom.window as any).HTMLCanvasElement.prototype.getContext = () => null
  const {createElement, act, Fragment} = await import("react")
  const {createRoot} = await import("react-dom/client")
  const {Workbench} = await import("../src/workbench.tsx")
  const {ToolRail} = await import("../src/tool-rail.tsx")
  const root = createRoot(document.getElementById("root")!)
  const tr = (_zh: string, en: string) => en
  const flush = () => act(async () => { await new Promise(done => setTimeout(done, 320)) })
  // 轮询间隔 250ms；等两个间隔再断言，避免时钟抖动把注入结果读成上一帧。
  const flushPoll = () => act(async () => { await new Promise(done => setTimeout(done, 520)) })
  const rail = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".lya-rail-item")].find(button => button.getAttribute("aria-label") === label)
  const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  const click = async (element: Element | undefined | null) => { expect(element).toBeTruthy(); await act(async () => (element as HTMLElement).click()) }
  try {
    // 真渲染同一个 store 的 Workbench 与 ToolRail；nativeTab 只关掉 Workbench 内再渲染一次 rail（避免重复 nav）。
    await act(async () => root.render(createElement(Fragment, null,
      createElement(Workbench, {sessionId: "rc-flow", nativeTab: true, t: (key: string) => key === "open" ? "Scene workbench" : "场景工作台", renderSlot: (_n: any, _p: any, options: any) => options?.fallback ?? null} as any),
      createElement(ToolRail, {tr, engine: "mujoco"}),
    )))
    await flush(); await flush()

    // --- V9：Viewer 默认收起碰撞线框，画布用 V8 底色；网格/坐标仍默认开 ---
    expect(capturedDisplaySettings.at(-1)).toMatchObject({grid: true, axes: true, background: "#242a32", wireframe: false, splats: true, collision: false})

    // --- V9：Scene 按 World/Robots/Objects 分组；计数来自实际根实例；选择器不显示长 UUID ---
    await click(rail("Scene"))
    await flush()
    const worldGroup = byTestId("scene-group-world")!, robotsGroup = byTestId("scene-group-robots")!, objectsGroup = byTestId("scene-group-objects")!
    expect(worldGroup).not.toBeNull(); expect(robotsGroup).not.toBeNull(); expect(objectsGroup).not.toBeNull()
    expect(worldGroup.getAttribute("data-count")).toBe("1")
    expect(robotsGroup.getAttribute("data-count")).toBe("1")
    expect(objectsGroup.getAttribute("data-count")).toBe("2")
    expect(robotsGroup.textContent).toContain("Panda")
    expect(robotsGroup.textContent).not.toContain("Wrist camera")
    await click(robotsGroup.querySelector('[aria-label="Expand or collapse Panda"]'))
    expect(robotsGroup.textContent).toContain("Wrist camera")
    expect(objectsGroup.textContent).toContain("alpha")
    expect(objectsGroup.textContent).not.toContain("Panda")
    const sceneSelect = byTestId("lyapunov-scene-select") as HTMLSelectElement
    const sceneOptions = [...sceneSelect.options].filter(option => option.value)
    expect(sceneOptions.map(option => option.textContent)).toEqual(["Scene 01", "Warehouse"])
    expect(sceneOptions[0]!.title).toBe(scene.sceneId)
    expect(sceneOptions[1]!.value).toBe(otherSceneId)
    expect(sceneOptions[1]!.title).toBe(otherSceneId)
    expect(sceneSelect.title).toBe(scene.sceneId)

    // --- Objects：首屏清单 → 行尾 Properties 进 Inspector → 返回清单 ---
    await click(rail("Objects"))
    expect(byTestId("object-list")).not.toBeNull()
    // 设计稿 objects-list：计数不上首屏；用分组头 + 行数确认清单完整。
    expect(byTestId("object-scene-group")!.textContent).toContain("Scene 01")
    expect(byTestId("object-list")!.querySelectorAll('.lya-tree-row').length).toBe(2)
    expect(byTestId("object-list")!.textContent).not.toContain("Panda")
    expect(byTestId("object-list")!.textContent).not.toContain("Source transform")
    await click(byTestId("object-list")!.querySelector('[aria-label="Expand or collapse alpha"]'))
    expect(byTestId("object-list")!.textContent).toContain("Source transform")
    expect(byTestId("object-list")!.textContent).not.toContain("源坐标转换")
    await click(byTestId("object-list")!.querySelector('[aria-label="Expand or collapse alpha"]'))
    
    const alphaProps = () => document.querySelector<HTMLButtonElement>('[aria-label="Open properties alpha"]')
    expect(alphaProps()).not.toBeNull()
    await click(alphaProps())
    expect(byTestId("object-inspector-header")).not.toBeNull()
    // 同栏 Inspector 只挂载一个 EntityEditor（草稿 owner 唯一）。
    expect(document.querySelectorAll('input[aria-label="Entity name"]').length).toBe(1)
    const nameInput = () => document.querySelector<HTMLInputElement>('input[aria-label="Entity name"]')!
    expect(nameInput().value).toBe("alpha")
    await act(async () => { const {Simulate} = await import("react-dom/test-utils"); Simulate.change(nameInput(), {target: {value: "draft-alpha"}} as any) })
    expect(document.body.textContent).toContain("Unsaved draft")
    await click(byTestId("object-inspector-header")!.querySelector("button"))
    expect(byTestId("object-list")).not.toBeNull()
    // 返回清单后编辑器只是隐藏，owner 与草稿都还在。
    expect(nameInput().closest("[hidden]")).not.toBeNull()

    // --- 目标切换：beta 打开是干净稿，回到 alpha 仍是未提交草稿 ---
    await click(document.querySelector('[aria-label="Open properties beta"]'))
    expect(nameInput().value).toBe("beta")
    await act(async () => { const {Simulate} = await import("react-dom/test-utils"); Simulate.change(nameInput(), {target: {value: "draft-beta"}} as any) })
    await click(byTestId("object-inspector-header")!.querySelector("button"))
    await click(alphaProps())
    expect(nameInput().value).toBe("draft-alpha")
    // 切到别的工具再回到 Objects Inspector，草稿仍在同一个 owner 里。
    await click(rail("Scene"))
    expect(document.querySelectorAll('input[aria-label="Entity name"]').length).toBe(1)
    await click(rail("Objects"))
    expect(nameInput().value).toBe("draft-alpha")

    // --- Physics 独立：Scene 首屏不再挂载物理面板；点 Physics 才出现 ---
    await click(rail("Scene"))
    expect(byTestId("world-physics-panel")).toBeNull()
    await click(rail("Physics"))
    expect(byTestId("world-physics-panel")).not.toBeNull()

    // --- Environment：首屏资源/Lighting 清单，进入 Lighting 才显示参数页 ---
    await click(rail("Environment"))
    expect(byTestId("environment-lighting")).not.toBeNull()
    // 设计稿：`+ Add environment` 行不带资源计数；行本身仍可点。
    expect(byTestId("environment-add")).not.toBeNull()
    // 英文模式下未启用环境组件时，可见状态文本必须是英文（修复前的反向翻译这里是中文）。
    expect(byTestId("environment-lighting-status")!.textContent).toBe("Studio lighting")
    expect(byTestId("environment-detail-header")).toBeNull()
    await click(byTestId("environment-lighting"))
    expect(byTestId("environment-detail-header")).not.toBeNull()
    expect(byTestId("environment-lighting")).toBeNull()
    await click(byTestId("environment-detail-header")!.querySelector("button"))
    expect(byTestId("environment-lighting")).not.toBeNull()
    // World 二级：背景/地面/已导入环境都是具名折叠；没有真实 HDRI 时不造 Environment 选择器。
    await click(byTestId("environment-world"))
    expect(byTestId("environment-world-background")!.hasAttribute("open")).toBe(false)
    expect(byTestId("environment-world-ground")!.hasAttribute("open")).toBe(false)
    expect(byTestId("environment-imported")!.hasAttribute("open")).toBe(false)
    expect(byTestId("environment-imported")!.textContent).toContain("Imported environments")
    expect(byTestId("environment-world-selector")).toBeNull()
    await click(byTestId("environment-world-header")!.querySelector("button"))
    expect(byTestId("environment-lighting")).not.toBeNull()
    // 同一可见位置注入 HDRI/自定义环境组件：轮询重读 Viewer 的 environmentStatus，英文分支必须可见。
    environmentStatusFixture = {hdriMimeTypes: [], warnings: [], ignored: [], component: {kind: "hdri"}, environmentSource: "hdri"}
    await flushPoll()
    expect(byTestId("environment-lighting-status")!.textContent).toBe("HDRI environment lighting")
    environmentStatusFixture = {hdriMimeTypes: [], warnings: [], ignored: [], component: {kind: "custom"}, environmentSource: "builtin"}
    await flushPoll()
    expect(byTestId("environment-lighting-status")!.textContent).toBe("Custom environment lighting")
    // 复位，后续步骤仍按未启用环境运行。
    environmentStatusFixture = {hdriMimeTypes: [], warnings: [], ignored: []}

    // --- V8-07：Add object 进入同栏二级资产选择页，导入表单只在该页点 Import object 后出现 ---
    await click(rail("Objects"))
    expect(byTestId("domain-import")).toBeNull()
    if (byTestId("object-inspector-header")) await click(byTestId("object-inspector-header")!.querySelector("button")!)
    await click(byTestId("object-add-primary"))
    expect(byTestId("object-add-import")).not.toBeNull()
    expect(byTestId("domain-import")).toBeNull()
    await click(byTestId("object-add-import"))
    expect(byTestId("domain-import")).not.toBeNull()

    // --- P17 视觉减法①：视口默认只留一枚可展开帮助；无 Mesh import 选择、无长说明常驻 ---
    const overlays = document.querySelector(".lya-viewport-overlays")
    expect(overlays).not.toBeNull()
    const help = byTestId("viewer-controls-help")
    expect(help).not.toBeNull()
    // 导入用途选择不再铺在画面上（它只在 Objects/Environment 的导入二级界面）。
    expect(overlays!.querySelector('[data-testid="import-purpose-choice"]')).toBeNull()
    // 关闭态：完整键位不在 DOM，不是“CSS 藏起来”；展开出现，再点关闭又消失。
    expect(overlays!.textContent).not.toContain("middle-drag to look")
    const helpToggle = help!.querySelector("button")!
    expect(helpToggle.getAttribute("aria-expanded")).toBe("false")
    await click(helpToggle)
    expect(helpToggle.getAttribute("aria-expanded")).toBe("true")
    expect(overlays!.textContent).toContain("middle-drag to look")
    await click(helpToggle)
    expect(helpToggle.getAttribute("aria-expanded")).toBe("false")
    expect(overlays!.textContent).not.toContain("middle-drag to look")

    // --- P17 视觉减法②：底栏默认只留短状态，rev 收进“运行信息”展开区（仍可查） ---
    const statusMeta = byTestId("workbench-status-meta")
    expect(statusMeta).not.toBeNull()
    expect(statusMeta!.querySelector(".lya-revision")?.textContent).toContain("rev 3")

    // --- P18 C：真实 React effect 的 A→B 右键 —— Viewer 先选中 B 再发 onContextMenu（同事件批），
    //     新菜单自身 scene/revision/entity 与当前选择一致时必须保留；切到别的对象才关闭。 ---
    expect(capturedViewerOptions).toBeTruthy()
    await act(async () => { capturedViewerOptions.onSelection("alpha") })
    await act(async () => {
      capturedViewerOptions.onSelection("beta")
      capturedViewerOptions.onContextMenu({clientX: 40, clientY: 40, sceneId: "rc-flow-scene", sceneRevision: 3, entityId: "beta", annotate: () => {}})
    })
    const contextMenu = () => document.querySelector('[role="menu"]')
    expect(contextMenu()).not.toBeNull()
    expect(contextMenu()!.textContent).toContain("Add to chat")
    // 左键切到另一个对象（没有新菜单）：旧菜单必须关闭。
    await act(async () => { capturedViewerOptions.onSelection("alpha") })
    expect(contextMenu()).toBeNull()
    // --- V9：选中不自动打开碰撞线框；默认只保留细轮廓，不再常驻旧选择条 ---
    await flush()
    expect(document.querySelector(".lya-selection-bar")).toBeNull()
    expect(capturedDisplaySettings.every(row => row.collision === false)).toBe(true)
    await click(rail("Notes"))
    await flush()
    expect(document.querySelector(".lya-notes-bar")).not.toBeNull()
    expect(document.querySelector(".lya-selection-bar")).toBeNull()
    await click(rail("Objects"))
    await flush()
    expect(document.querySelector(".lya-selection-bar")).toBeNull()
    // 显式打开仍工作：只改 Viewer 显示偏好（Inspector 仍停留在 alpha 时不必再点清单行）。
    if (!byTestId("object-inspector-header")) await click(alphaProps())
    const collisionDetails = byTestId("object-collision") as HTMLDetailsElement
    expect(collisionDetails).not.toBeNull()
    collisionDetails.open = true
    await click(collisionDetails.querySelector('input[type="checkbox"]'))
    await flush()
    expect(capturedDisplaySettings.at(-1)?.collision).toBe(true)

    // --- V8-07：进入 Add object 二级页再返回，对象属性草稿仍由同一个 owner 保留 ---
    if (byTestId("object-inspector-header")) await click(byTestId("object-inspector-header")!.querySelector("button")!)
    await click(byTestId("object-add-primary"))
    expect(document.querySelector(".lya-object-add")).not.toBeNull()
    await click(document.querySelector(".lya-object-add .lya-back"))
    await click(alphaProps())
    expect(nameInput().value).toBe("draft-alpha")
  } finally {
    await act(async () => root.unmount())
    viewerFactory = () => ({})
    dom.window.close()
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) }
  }
}, 20000)
