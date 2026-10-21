/**
 * RC P2（R-011）：Components 面板、展示层采集元数据与观察载荷的行为回归。
 *
 * 用的是**真 React 组件 + 真 DOM**（上游 jsdom 夹具）与注入的 Viewer/采集端口：
 *  · `ComponentsPanel` 的部件树、双向选中、展开/合拢按钮真的驱动 Viewer 端口；
 *  · `presentation-capture.ts` 的白名单整形拒绝缺 `displayOnly` 的载荷，不给"看起来核过"的假读数；
 *  · `captureForObserver` 把同帧 `presentation` 原样带进观察载荷（不是右栏另写一段说明）。
 *
 * 边界：这不是浏览器真机 WebGL 截图验收；展示层炸开本身由 `packages/viewer/test/robot-visual.test.ts`
 * 对着真实 THREE 节点矩阵证明。
 */
import {test, expect} from "bun:test"
import {createRequire} from "node:module"
import {createElement, act, useState} from "react"
import {createRoot} from "react-dom/client"
import type {ViewerPart, ViewerPartSelection} from "@lyapunov/viewer/client"
import {ComponentsPanel, useStableExtractionPort, type ComponentsExtractionPort, type ComponentsViewer} from "../src/components-panel.tsx"
import {presentationFaceFrom, presentationFaceNote} from "../src/presentation-capture.ts"
import {captureForObserver} from "../src/workbench-observe.ts"

type FakeCall = string
function partRows(): ViewerPart[] {
  return [
    {entityId: "robot-1", partId: "body:0", name: "base", kind: "body", path: ["base"], resource: "r1@2", resourceSignature: "r1@2", granularity: "hierarchy", separable: true, selected: false},
    {entityId: "robot-1", partId: "body:0.0", name: "link1", kind: "body", path: ["base", "link1"], resource: "r1@2", resourceSignature: "r1@2", granularity: "hierarchy", separable: true, selected: false},
    {entityId: "robot-1", partId: "body:0.0.0", name: "hand", kind: "body", path: ["base", "link1", "hand"], resource: "r1@2", resourceSignature: "r1@2", granularity: "hierarchy", separable: true, selected: false},
  ]
}
function fakeViewer(calls: FakeCall[], options: { blockedReason?: string } = {}): ComponentsViewer {
  let selected: ViewerPartSelection | undefined
  return {
    listParts: (entityId?: string) => entityId === "robot-1" ? partRows() : [],
    selectedPartRef: () => selected,
    selectPart: (entityId, partId) => { calls.push(`select:${entityId ?? "-"}:${partId ?? "-"}`); selected = entityId !== undefined && partId !== undefined ? {entityId, partId} : undefined },
    setPartExplode: (entityId, spread) => { calls.push(`explode:${entityId}:${spread}`); return options.blockedReason ? {spread: 0, reason: options.blockedReason} : {spread} },
    restorePartExplode: () => { calls.push("restore") },
    partExplodeStatus: () => ({spread: 0}),
  }
}

test("真实 ComponentsPanel：部件树选中、展开/合拢按钮真的驱动 Viewer 端口", async () => {
  const {JSDOM} = createRequire(new URL("../../../.upstream/deepseek-harness-20260911-candidate/package.json", import.meta.url))("jsdom") as {JSDOM: new (html: string, options?: {url?: string}) => {window: Window & typeof globalThis}}
  const dom = new JSDOM('<div id="root"></div>', {url: "http://fixture.invalid"})
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const key of ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as unknown as Record<string, unknown>)[key]})
  }
  const root = createRoot(document.getElementById("root")!)
  const calls: FakeCall[] = []
  try {
    const render = (viewer: ComponentsViewer, selectedPart?: ViewerPartSelection) => act(async () => root.render(createElement(ComponentsPanel, {
      viewer, entityId: "robot-1", entityName: "Robot One", selectedPart, tr: (_zh: string, en: string) => en, viewerVisible: true, onBack: () => calls.push("back"),
    })))
    await render(fakeViewer(calls))
    const rows = [...document.querySelectorAll('[data-testid^="components-row-"]')]
    expect(rows.length).toBe(3)
    expect(document.querySelector('[data-testid="components-panel"]')!.getAttribute("data-entity")).toBe("robot-1")
    // 目录里没有"显示名相同就同一件东西"的口子：身份逐行给出 entityId/partId，真实路径深度进入树语义。
    expect(rows.map(row => row.getAttribute("data-part-id"))).toEqual(["body:0", "body:0.0", "body:0.0.0"])
    expect(rows.map(row => row.getAttribute("data-entity-id"))).toEqual(["robot-1", "robot-1", "robot-1"])
    expect(rows.map(row => row.getAttribute("aria-level"))).toEqual(["1", "2", "3"])
    // V9：默认只显示名称/树；每行不再铺重复的 separable 文案（能力仍在 title/详情）。
    expect(rows[0]!.textContent).not.toContain("separable")
    expect(rows[1]!.textContent).not.toContain("separable")
    // 点部件行 ⇒ Viewer.selectPart（树 → 画布高亮方向）。
    const linkButton = rows[1]!.querySelector("button")!
    await act(async () => linkButton.click())
    expect(calls).toContain("select:robot-1:body:0.0")
    // 选中态由父层回传的 selectedPart 决定（画布 → 树方向），面板只读这一份。
    await render(fakeViewer(calls), {entityId: "robot-1", partId: "body:0.0"})
    expect([...document.querySelectorAll('[data-testid^="components-row-"]')][1]!.getAttribute("aria-selected")).toBe("true")
    // partId 只在实体内唯一：另一实体重用同一个 ID 不能误选此行或显示其详情。
    await render(fakeViewer(calls), {entityId: "robot-2", partId: "body:0.0"})
    expect([...document.querySelectorAll('[data-testid^="components-row-"]')].every(row => row.getAttribute("aria-selected") === "false")).toBe(true)
    expect(document.querySelector('[data-testid="components-selected-empty"]')).not.toBeNull()
    await render(fakeViewer(calls))
    // 开关以 Viewer 实际比例显示，启用到 100%，关闭走显示层 Restore。
    const toggle = document.querySelector('[data-testid="components-explode-toggle"]') as HTMLButtonElement
    expect(toggle.getAttribute("role")).toBe("switch")
    expect(toggle.getAttribute("aria-label")).toBe("Exploded view")
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    expect([...document.querySelectorAll("button")].some(button => ["Collapse", "Half", "Full"].includes(button.textContent ?? ""))).toBe(false)
    await act(async () => toggle.click())
    expect(calls).toContain("explode:robot-1:1")
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    expect(document.querySelector('[data-testid="components-spread-value"]')!.textContent).toBe("100%")
    const slider = document.querySelector('[data-testid="components-spread"] input') as HTMLInputElement
    expect(slider.getAttribute("aria-valuetext")).toBe("100%")
    // 本文件在 jsdom 前导入 React DOM，input 支持检测已固定为 false；用 React 官方事件工具驱动 change。
    // 不把此合成事件检查写成浏览器原生拖动证据。
    const {Simulate} = createRequire(import.meta.url)("react-dom/test-utils")
    await act(async () => {
      slider.value = "0.4"
      Simulate.change(slider)
    })
    expect(calls.at(-1)).toBe("explode:robot-1:0.4")
    expect(document.querySelector('[data-testid="components-spread-value"]')!.textContent).toBe("40%")
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    await act(async () => toggle.click())
    expect(calls.at(-1)).toBe("restore")
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    expect(slider.value).toBe("0")
    // 独立 Restore 为 Display only 之后的中性整行按钮，不与比例控件混排。
    await act(async () => toggle.click())
    const restore = document.querySelector('[data-testid="components-restore"]') as HTMLButtonElement
    expect(restore.classList.contains("lya-primary")).toBe(false)
    expect(restore.classList.contains("lya-wide")).toBe(true)
    expect(restore.parentElement!.getAttribute("data-testid")).toBe("components-restore-row")
    expect(restore.parentElement!.querySelectorAll("button").length).toBe(1)
    expect(restore.parentElement!.previousElementSibling!.getAttribute("data-testid")).toBe("components-display-only")
    await act(async () => restore.click())
    expect(calls.at(-1)).toBe("restore")
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    expect(document.querySelector('[data-testid="components-spread-value"]')!.textContent).toBe("0%")
    await act(async () => {
      slider.value = "0.5"
      Simulate.change(slider)
    })
    expect(calls.at(-1)).toBe("explode:robot-1:0.5")
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    await act(async () => {
      slider.value = "0"
      Simulate.change(slider)
    })
    expect(calls.at(-1)).toBe("explode:robot-1:0")
    expect(toggle.getAttribute("aria-checked")).toBe("false")
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) }
  }
})

test("不可炸开/无部件时面板如实说明，不给假成功", async () => {
  const {JSDOM} = createRequire(new URL("../../../.upstream/deepseek-harness-20260911-candidate/package.json", import.meta.url))("jsdom") as {JSDOM: new (html: string, options?: {url?: string}) => {window: Window & typeof globalThis}}
  const dom = new JSDOM('<div id="root"></div>', {url: "http://fixture.invalid"})
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const key of ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as unknown as Record<string, unknown>)[key]})
  }
  const root = createRoot(document.getElementById("root")!)
  const calls: FakeCall[] = []
  try {
    const empty: ComponentsViewer = {...fakeViewer(calls), listParts: () => []}
    await act(async () => root.render(createElement(ComponentsPanel, {viewer: empty, entityId: "robot-1", entityName: "Robot One", tr: (_zh: string, en: string) => en, viewerVisible: true, onBack: () => {}})))
    expect(document.querySelector('[data-testid="components-empty"]')).not.toBeNull()
    const viewer = fakeViewer(calls, {blockedReason: "This entity currently shows native dynamic geometry, so it cannot be exploded as a rigid body."})
    await act(async () => root.render(createElement(ComponentsPanel, {viewer, entityId: "robot-1", entityName: "Robot One", tr: (_zh: string, en: string) => en, viewerVisible: true, onBack: () => {}})))
    const toggle = document.querySelector('[data-testid="components-explode-toggle"]') as HTMLButtonElement
    await act(async () => toggle.click())
    expect(document.querySelector('[data-testid="components-explode-blocked"]')!.textContent).toContain("dynamic geometry")
    expect(document.querySelector('[data-testid="components-spread-value"]')!.textContent).toBe("0%")
    expect(toggle.getAttribute("aria-checked")).toBe("false")
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) }
  }
})

test("展示层状态以 Viewer 读数为准：外部合拢/切身份/资源加载完成后滑杆回 0，且无实施批次文案", async () => {
  const {JSDOM} = createRequire(new URL("../../../.upstream/deepseek-harness-20260911-candidate/package.json", import.meta.url))("jsdom") as {JSDOM: new (html: string, options?: {url?: string}) => {window: Window & typeof globalThis}}
  const dom = new JSDOM('<div id="root"></div>', {url: "http://fixture.invalid"})
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const key of ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as unknown as Record<string, unknown>)[key]})
  }
  const root = createRoot(document.getElementById("root")!)
  try {
    const listeners = new Set<() => void>()
    let rows: ViewerPart[] = []
    let status: {entityId?: string; spread: number; reason?: string} = {spread: 0}
    const notify = () => { for (const listener of listeners) listener() }
    const viewer: ComponentsViewer = {
      listParts: () => rows,
      selectedPartRef: () => undefined,
      selectPart: () => {},
      setPartExplode: (entityId, spread) => { status = {entityId, spread}; notify(); return {spread} },
      restorePartExplode: () => { status = {spread: 0}; notify() },
      partExplodeStatus: () => status,
      subscribePresentationState: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    }
    const render = () => act(async () => root.render(createElement(ComponentsPanel, {viewer, entityId: "robot-1", entityName: "Robot One", tr: (_zh: string, en: string) => en, viewerVisible: true, onBack: () => {}})))
    await render()
    // 资源加载完成前目录为空；加载完成后 Viewer 播报，面板应切成真实部件树。
    expect(document.querySelector('[data-testid="components-empty"]')).not.toBeNull()
    await act(async () => { rows = partRows(); notify() })
    expect(document.querySelectorAll('[data-testid^="components-row-"]').length).toBe(3)
    // 用户启用展开到 100%；外部部分展开也要按真实值同步开关和百分比。
    const toggle = document.querySelector('[data-testid="components-explode-toggle"]') as HTMLButtonElement
    await act(async () => toggle.click())
    expect(document.querySelector('[data-testid="components-spread-value"]')!.textContent).toBe("100%")
    await act(async () => viewer.setPartExplode("robot-1", 0.4))
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    expect(document.querySelector('[data-testid="components-spread-value"]')!.textContent).toBe("40%")
    const slider = document.querySelector('[data-testid="components-spread"] input') as HTMLInputElement
    expect(slider.value).toBe("0.4")
    expect(slider.getAttribute("aria-valuetext")).toBe("40%")
    // 外部（Viewer 自己触发的 Restore）：读数回到 0，滑杆和开关不能停在旧值。
    await act(async () => viewer.restorePartExplode())
    expect(document.querySelector('[data-testid="components-spread-value"]')!.textContent).toBe("0%")
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    expect(slider.value).toBe("0")
    // 页面不出现实施批次/R 编号/开发计划说明；显示层文案是产品措辞。
    const text = document.body.textContent ?? ""
    expect(text).not.toContain("R-011")
    expect(text).not.toContain("本批")
    expect(text).not.toContain("后续批次")
    expect(document.querySelector('[data-testid="components-display-only"]')!.textContent).toContain("Display only · Assembly unchanged")
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) }
  }
})

test("新展开控件真实 Viewer 闭环：身份/显示矩阵隔离、显式 Frame 与禁用态", async () => {
  const {buildRobotVisual} = await import("../../viewer/src/robot.ts")
  const {SceneViewer} = await import("../../viewer/src/index.ts")
  const {FrameProjection} = await import("../../viewer/src/projection.ts")
  const {identityTransform, SCENE_COORDINATES} = await import("../../lyapunov-contracts/src/types.ts")
  const THREE = createRequire(new URL("../../viewer/package.json", import.meta.url))("three")
  const scene = new THREE.Scene(), objects = new Map<string, any>()
  for (const entityId of ["robot-1", "robot-2"]) {
    const robot = await buildRobotVisual({format: "mjcf", baseUri: "file:///components-repair/", document: {
      worldbody: {body: [{name: "base", geom: {type: "box", size: ".1 .1 .1"}, body: [
        {name: "arm", pos: "0 0 .4", geom: {type: "box", size: ".1 .1 .2"}},
      ]}]},
    }} as any, () => {throw Error("本用例禁止外部模型")})
    const group = new THREE.Group(); group.userData.entityId = entityId; group.add(robot.root); scene.add(group)
    objects.set(entityId, {group, robot, visual: robot.root, signature: "repair@1", lodWarnings: [], baseRef: {resourceId: "repair", version: 1}})
  }
  const viewer = Object.create(SceneViewer.prototype) as any
  const frames: any[] = []
  Object.assign(viewer, {
    scene, objects, projection: new FrameProjection(), display: {wireframe: false}, visualWarnings: new Map(),
    splatViewBounds: new WeakMap(), splatBounds: new WeakMap(), camera: new THREE.PerspectiveCamera(),
    snapshot: {sceneId: "repair", revision: 1, coordinates: SCENE_COORDINATES, entities: [...objects.keys()].map(entityId => ({entityId, name: entityId, transform: identityTransform(), resources: [], components: {}}))},
    options: {}, transformControls: {object: undefined, attach() {}, detach() {}},
    updateAnnotationMarkers() {}, syncRobotAnchors() {}, syncCollisionTopology() {},
    frameBounds: (bounds: any) => frames.push(bounds.clone()),
  })
  viewer.projection.setScene(viewer.snapshot)
  const matrices = () => [...objects.values()].flatMap(loaded => loaded.robot.parts.map((part: any) => {
    part.node.updateWorldMatrix(true, true); return [...part.node.matrixWorld.elements]
  }))
  const {JSDOM} = createRequire(new URL("../../../.upstream/deepseek-harness-20260911-candidate/package.json", import.meta.url))("jsdom")
  const dom = new JSDOM('<div id="root"></div>', {url: "http://fixture.invalid"})
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const key of ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[key]})
  }
  let mutations = 0
  const forbidden = async () => {mutations++; throw Error("禁止隐式装配操作")}
  const extraction = {bodies: async () => [], pairing: () => undefined, precheck: forbidden, extract: forbidden, reassemble: forbidden}
  function Harness({visible}: {visible: boolean}) {
    const [selectedPart, setSelectedPart] = useState<ViewerPartSelection>()
    viewer.options.onPartSelect = setSelectedPart
    return createElement(ComponentsPanel, {viewer, entityId: "robot-1", entityName: "Robot One", selectedPart, viewerVisible: visible, extraction, tr: (_zh, en) => en, onBack() {}})
  }
  const root = createRoot(document.getElementById("root")!)
  const query = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement
  const button = (id: string) => query(id) as HTMLButtonElement
  try {
    await act(async () => root.render(createElement(Harness, {visible: true})))
    await act(async () => query("components-row-body:0.0").querySelector("button")!.click())
    const before = matrices(), snapshot = JSON.stringify(viewer.snapshot)
    await act(async () => button("components-explode-toggle").click())
    expect(viewer.partExplodeStatus()).toEqual({entityId: "robot-1", spread: 1})
    expect(query("components-spread-value").textContent).toBe("100%")
    expect(objects.get("robot-1").robot.parts.some((part: any) => part.presentation.position.length() > 0)).toBe(true)
    expect(objects.get("robot-2").robot.parts.every((part: any) => part.presentation.position.length() === 0)).toBe(true)
    expect(frames.length).toBe(0)
    for (const action of ["components-explode-toggle", "components-restore"]) {
      await act(async () => button(action).click())
      expect(viewer.partExplodeStatus()).toEqual({spread: 0})
      expect(button("components-explode-toggle").getAttribute("aria-checked")).toBe("false")
      expect(query("components-selected").textContent).toBe("arm")
      expect(viewer.selectedPartRef()).toEqual({entityId: "robot-1", partId: "body:0.0"})
      expect(objects.get("robot-1").robot.parts.every((part: any) => part.presentation.position.length() === 0)).toBe(true)
      expect(matrices()).toEqual(before)
      expect(JSON.stringify(viewer.snapshot)).toBe(snapshot)
      expect(mutations).toBe(0)
      if (action === "components-explode-toggle") await act(async () => button("components-explode-toggle").click())
    }
    // 设计稿第 32 页没有独立取景按钮：Components 只做树/选择/展开/Restore，不抢镜头。
    expect(query("components-frame-assembly")).toBeNull()
    expect(query("components-frame-part")).toBeNull()
    expect(frames.length).toBe(0)
    await act(async () => root.render(createElement(Harness, {visible: false})))
    for (const id of ["components-explode-toggle", "components-restore"]) {
      expect(button(id).disabled).toBe(true)
      await act(async () => button(id).click())
    }
    expect((query("components-spread").querySelector("input") as HTMLInputElement).disabled).toBe(true)
    expect(viewer.partExplodeStatus()).toEqual({spread: 0})
  } finally {
    await act(async () => root.unmount())
    viewer.selectPart(undefined, undefined)
    for (const loaded of objects.values()) loaded.group.traverse((node: any) => {
      node.geometry?.dispose()
      if (node.material) for (const material of [].concat(node.material)) (material as any).dispose()
    })
    dom.window.close()
    for (const [key, value] of saved) {if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key)}
  }
})

test("展示层整形：缺 displayOnly 一律拒绝；只有真的炸开才给模型一句话", () => {
  expect(presentationFaceFrom({displayOnly: true, exploded: false, spread: 0})).toEqual({displayOnly: true, exploded: false, spread: 0})
  const full = presentationFaceFrom({displayOnly: true, exploded: true, spread: 1.7, entityId: "robot-1", selectedPart: {entityId: "robot-1", partId: "body:0.0", name: "link1", kind: "body"}, catalog: {entityId: "robot-1", resource: "r1@2", signature: "r1@2", parts: 3, separable: 3}})
  expect(full?.spread).toBe(1)
  expect(full?.catalog?.resource).toBe("r1@2")
  // 前端没标 displayOnly 就不是这一面：不补默认值冒充"核过了"。
  expect(presentationFaceFrom({exploded: true, spread: 0.5})).toBeUndefined()
  expect(presentationFaceFrom(null)).toBeUndefined()
  expect(presentationFaceNote(presentationFaceFrom({displayOnly: true, exploded: false, spread: 0}))).toBeUndefined()
  const note = presentationFaceNote(full)
  expect(note).toContain("Exploded view")
  expect(note).toContain("displayOnly=true")
  expect(note).toContain("没有改变")
})

test("停放预览窄面：只有显式 applied:false 且位姿完整才整形；缺位姿/缺 applied 一律拒绝并给模型一句话", () => {
  const full = presentationFaceFrom({displayOnly: true, exploded: false, spread: 0, parkingPreview: {applied: false, entityId: "old-hand", positionM: [0.4, 0.1, 0.2], quaternionXyzw: [0, 0, 0, 1], worldId: "w", sceneRevision: 3, generation: 2}})
  expect(full?.parkingPreview).toEqual({applied: false, entityId: "old-hand", positionM: [0.4, 0.1, 0.2], quaternionXyzw: [0, 0, 0, 1], worldId: "w", sceneRevision: 3, generation: 2})
  // 位姿长度不对或 applied 缺失：不是这一面，绝不补默认值冒充"核过了"。
  expect(presentationFaceFrom({displayOnly: true, exploded: false, spread: 0, parkingPreview: {applied: false, entityId: "old-hand", positionM: [1, 2], quaternionXyzw: [0, 0, 0, 1]}})?.parkingPreview).toBeUndefined()
  expect(presentationFaceFrom({displayOnly: true, exploded: false, spread: 0, parkingPreview: {entityId: "old-hand", positionM: [1, 2, 3], quaternionXyzw: [0, 0, 0, 1]}})?.parkingPreview).toBeUndefined()
  expect(presentationFaceFrom({displayOnly: true, exploded: false, spread: 0, parkingPreview: {applied: false, entityId: "old-hand", positionM: [1, 2, 3], quaternionXyzw: [0, 0, 0, Number.NaN]}})?.parkingPreview).toBeUndefined()
  const note = presentationFaceNote(full)
  expect(note).toContain("未应用停放 ghost")
  expect(note).toContain("old-hand")
  expect(note).toContain("尚未被真正移动或停放")
})

test("观察载荷携带同帧 presentation（displayOnly/entity/spread/资源版本）", async () => {
  const presentation = {displayOnly: true, exploded: true, spread: 0.5, entityId: "robot-1", catalog: {entityId: "robot-1", resource: "r1@2", signature: "r1@2", parts: 3, separable: 3}}
  let payload: any
  const viewer = {
    capture: () => ({dataURL: "data:image/png;base64,AAAA", sceneId: "s1", sceneRevision: 1, presentation}),
    loadingErrors: new Map<string, string>(),
    visualWarnings: new Map<string, string[]>(),
  }
  await captureForObserver({
    sceneId: "s1", expectedRevision: 1, observeId: "observe-1", clientId: "client-1", viewerVisible: true, viewer,
    displayed: {sceneId: "s1", revision: 1, entityIds: ["robot-1"]},
    loadState: () => ({sceneId: "s1", revision: 1, settled: true}),
    capture: async value => { payload = value; return {captureId: "c1"} },
  })
  expect(payload.presentation).toEqual(presentation)
})

test("R-013：Components 只多一个具名 Extract part 入口；预检按需展开、不支持不给提取、重组在成对存在时可见", async () => {
  const {JSDOM} = createRequire(new URL("../../../.upstream/deepseek-harness-20260911-candidate/package.json", import.meta.url))("jsdom") as {JSDOM: new (html: string, options?: {url?: string}) => {window: Window & typeof globalThis}}
  const dom = new JSDOM('<div id="root"></div>', {url: "http://fixture.invalid"})
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const key of ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as unknown as Record<string, unknown>)[key]})
  }
  const root = createRoot(document.getElementById("root")!)
  const calls: FakeCall[] = []
  let pairingValue: {operationId: string; partEntityId: string} | undefined
  const port = {
    bodies: async () => [{name: "base", root: true}, {name: "link7", root: false, parentName: "link6"}, {name: "hand", root: false, parentName: "link7"}],
    pairing: () => pairingValue,
    precheck: async (_entityId: string, bodyName: string) => ({
      supported: bodyName === "hand", selectedBody: bodyName, selectedBodyParent: bodyName === "hand" ? "link7" : "link6",
      subtree: {bodies: [bodyName], joints: ["finger_joint1"], actuators: ["actuator8"], tendons: ["split"], equalities: [], sensors: []},
      remaining: {bodies: ["base"], joints: ["joint1"], actuators: ["actuator1"], tendons: [], equalities: [], sensors: []},
      crossEdges: bodyName === "hand" ? [] : [{kind: "tendon", name: "cross", reason: "wrap 横跨两侧"}],
      ...(bodyName === "hand" ? {} : {reason: "SUBTREE_CROSS_EDGE_DEPENDENCY: 跨切口引用"}),
    }),
    extract: async (_entityId: string, bodyName: string) => { calls.push(`extract:${bodyName}`); return {remainingEntityId: "robot-1", partEntityId: "part-1"} },
    reassemble: async () => { calls.push("reassemble"); return {partEntityId: "part-1"} },
  }
  try {
    await act(async () => root.render(createElement(ComponentsPanel, {viewer: fakeViewer(calls), entityId: "robot-1", entityName: "Robot One", tr: (_zh: string, en: string) => en, viewerVisible: true, onBack: () => calls.push("back"), extraction: port})))
    // 提取/预检/重组默认收在具名折叠里，不常驻在部件列表之后。
    expect(document.querySelector('[data-testid="components-extraction"]')!.tagName).toBe("DETAILS")
    const select = document.querySelector('[data-testid="components-extract-body"]') as HTMLSelectElement
    // 只列非根真实内部 body；root 不作为候选。
    expect([...select.options].map(option => option.value)).toEqual(["link7", "hand"])
    // 未预检前 Extract 明确禁用（不把"可炸开"当"可拆"）。
    expect((document.querySelector('[data-testid="components-extract"]') as HTMLButtonElement).disabled).toBe(true)
    // 选一个跨切口 body → 预检不通过，Extract 仍禁用，详情给出具体引用。
    select.value = "link7"
    await act(async () => select.dispatchEvent(new dom.window.Event("change", {bubbles: true})))
    await act(async () => (document.querySelector('[data-testid="components-extract-precheck"]') as HTMLButtonElement).click())
    expect((document.querySelector('[data-testid="components-extract"]') as HTMLButtonElement).disabled).toBe(true)
    expect(document.querySelector('[data-testid="components-extract-details"]')!.textContent).toContain("cross")
    // 换成闭合子树 → 预检通过后可提取，回执显示独立件。
    select.value = "hand"
    await act(async () => select.dispatchEvent(new dom.window.Event("change", {bubbles: true})))
    await act(async () => (document.querySelector('[data-testid="components-extract-precheck"]') as HTMLButtonElement).click())
    expect((document.querySelector('[data-testid="components-extract"]') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => (document.querySelector('[data-testid="components-extract"]') as HTMLButtonElement).click())
    expect(calls).toContain("extract:hand")
    expect(document.querySelector('[data-testid="components-extract-status"]')!.textContent).toContain("part-1")
    // 宿主读回成对标记后，Reassemble 才出现并可点击。
    pairingValue = {operationId: "op", partEntityId: "part-1"}
    await act(async () => root.render(createElement(ComponentsPanel, {viewer: fakeViewer(calls), entityId: "robot-1", entityName: "Robot One", tr: (_zh: string, en: string) => en, viewerVisible: true, onBack: () => calls.push("back"), extraction: port})))
    await act(async () => (document.querySelector('[data-testid="components-reassemble"]') as HTMLButtonElement).click())
    expect(calls).toContain("reassemble")
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) }
  }
})

/**
 * 根因回归（主控 GUI 实测 ROOT_GUI_REVIEW）：Workbench 每次 render 新建 extractionPort，
 * `describe` 的 setState 触发父重渲染 → ComponentsPanel 的按需预检 effect cleanup 取消请求 →
 * 内部 body 选择框永不出现。这里用 Workbench 的同一条 `useStableExtractionPort`：父级重渲染时
 * 端口身份必须逐字不变，且真实 ComponentsPanel 必须出现 `components-extract-body`。
 */
test("useStableExtractionPort：父级重渲染不换端口身份，真实内部 body 选择框出现", async () => {
  const {JSDOM} = createRequire(new URL("../../../.upstream/deepseek-harness-20260911-candidate/package.json", import.meta.url))("jsdom") as {JSDOM: new (html: string, options?: {url?: string}) => {window: Window & typeof globalThis}}
  const dom = new JSDOM('<div id="root"></div>', {url: "http://fixture.invalid"})
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const key of ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as unknown as Record<string, unknown>)[key]})
  }
  const root = createRoot(document.getElementById("root")!)
  const ports: ComponentsExtractionPort[] = []
  let renders = 0
  function Harness() {
    const [, setTick] = useState(0)
    const port = useStableExtractionPort({
      // 模拟真实 Workbench：`describe` 完成后 setState 触发父级重渲染（这正是 bug 的触发源）。
      bodies: async () => { setTick(value => value + 1); return [{name: "link0", root: true}, {name: "link7", root: false, parentName: "link6"}] },
      pairing: () => undefined,
      precheck: async () => ({supported: true, selectedBody: "link7", selectedBodyParent: "link6", subtree: {bodies: ["link7"], joints: [], actuators: [], tendons: [], equalities: [], sensors: []}, remaining: {bodies: ["link0"], joints: [], actuators: [], tendons: [], equalities: [], sensors: []}, crossEdges: []}),
      extract: async () => ({remainingEntityId: "robot-1", partEntityId: "part-1"}),
      reassemble: async () => ({partEntityId: "part-1"}),
    })
    ports.push(port); renders++
    return createElement(ComponentsPanel, {viewer: fakeViewer([]), entityId: "robot-1", entityName: "Robot One", tr: (_zh: string, en: string) => en, viewerVisible: true, onBack: () => {}, extraction: port})
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await act(async () => { await new Promise(done => setTimeout(done, 30)) })
    // `bodies` 里的 setState 已触发至少一次父级重渲染……
    expect(renders).toBeGreaterThan(1)
    // ……但端口身份逐字不变（修复前每次 render 都是新对象，effect 会反复 cleanup 并取消请求）。
    expect(new Set(ports).size).toBe(1)
    const select = document.querySelector('[data-testid="components-extract-body"]') as HTMLSelectElement | null
    expect(select).not.toBeNull()
    expect([...select!.options].map(option => option.value)).toEqual(["link7"])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) }
  }
})

/**
 * 根因回归（ROOT_GUI_REVIEW.requiredExistingContractEntries.reassembleWhenRootOnly / savedSync）：
 * Reassemble 只由成对标记决定——remaining 只剩 root 时也必须可达；提取/重组的短反馈按真实回执分层，
 * 未确认 sync 时不得显示 "Native ready"。
 */
test("Reassemble 由成对标记决定：remaining 只剩 root 仍可重组，sync 反馈不虚称原生已就绪", async () => {
  const {JSDOM} = createRequire(new URL("../../../.upstream/deepseek-harness-20260911-candidate/package.json", import.meta.url))("jsdom") as {JSDOM: new (html: string, options?: {url?: string}) => {window: Window & typeof globalThis}}
  const dom = new JSDOM('<div id="root"></div>', {url: "http://fixture.invalid"})
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const key of ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as unknown as Record<string, unknown>)[key]})
  }
  const root = createRoot(document.getElementById("root")!)
  const calls: FakeCall[] = []
  let reassembleResult: {partEntityId: string; sync?: 'SYNCED' | 'REQUIRED'; syncRequired?: boolean; reason?: string} = {partEntityId: "part-1", sync: "REQUIRED", syncRequired: true, reason: "world offline"}
  const port = {
    // remaining 侧只剩根：没有任何非根候选内部 body。
    bodies: async () => [{name: "base", root: true}],
    pairing: () => ({operationId: "op", partEntityId: "part-1"}),
    precheck: async () => ({supported: false, selectedBody: "none", selectedBodyParent: "", subtree: {bodies: [], joints: [], actuators: [], tendons: [], equalities: [], sensors: []}, remaining: {bodies: ["base"], joints: [], actuators: [], tendons: [], equalities: [], sensors: []}, crossEdges: []}),
    extract: async () => { calls.push("extract"); return {remainingEntityId: "robot-1", partEntityId: "part-1"} },
    reassemble: async () => { calls.push("reassemble"); return reassembleResult },
  }
  const render = async () => { await act(async () => root.render(createElement(ComponentsPanel, {viewer: fakeViewer(calls), entityId: "robot-1", entityName: "Robot One", tr: (_zh: string, en: string) => en, viewerVisible: true, onBack: () => {}, extraction: port}))) }
  try {
    await render()
    await act(async () => { await new Promise(done => setTimeout(done, 0)) })
    // 没有候选内部 body：Extract 入口不存在，但 Reassemble 仍必须可达（不嵌在 candidates.length>0 里）。
    expect(document.querySelector('[data-testid="components-extract-body"]')).toBeNull()
    expect(document.querySelector('[data-testid="components-extract-unavailable"]')).not.toBeNull()
    const button = document.querySelector('[data-testid="components-reassemble"]') as HTMLButtonElement | null
    expect(button).not.toBeNull()
    expect(button!.disabled).toBe(false)
    await act(async () => button!.click())
    expect(calls).toContain("reassemble")
    let status = document.querySelector('[data-testid="components-extract-status"]')!.textContent ?? ""
    expect(status).toContain("Physics sync required")
    expect(status).not.toContain("Native ready")
    // 真实回执确认已同步后，才允许显示 Native ready。
    reassembleResult = {partEntityId: "part-1", sync: "SYNCED", syncRequired: false}
    await render()
    await act(async () => (document.querySelector('[data-testid="components-reassemble"]') as HTMLButtonElement).click())
    status = document.querySelector('[data-testid="components-extract-status"]')!.textContent ?? ""
    expect(status).toContain("Native ready")
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) }
  }
})
