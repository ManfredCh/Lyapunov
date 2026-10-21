/**
 * RC P1（R-001/R-009/R-010）：工具轨顺序、独立 Physics 入口、旧 `asset` 迁移与图标/契约一致。
 *
 * 这里测**行为与契约**，不是复述源码字面：
 *  · `RAIL_ENTRIES` 是产品真正渲染的清单——上组内容/采集、下组运行/工作面，Physics 在下组但仍是工具；
 *  · 真渲染 `ToolRail` 后按真实 DOM 点击，断言展示 store 真的切到 `physics`，引擎仍是单击偏好切换；
 *  · 旧 `tool:"asset"` 的白名单迁移（R-008）与未知值回退；
 *  · `plugin.ts` 的 ui_action 工具枚举必须覆盖全部新工具，漏登记会在这里红。
 */
import {describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"
import {createRequire} from "node:module"
import {createElement, act} from "react"
import {createRoot} from "react-dom/client"
import {RAIL_ENTRIES} from "../src/tool-rail.tsx"
import {sanitizeWorkbenchUIState, migrateToolId} from "../src/workbench-ui.ts"

const upper = RAIL_ENTRIES.filter(entry => entry.group === "tool").map(entry => entry.id)
const lower = RAIL_ENTRIES.filter(entry => entry.group === "work").map(entry => entry.id)

describe("RC 工具轨顺序与独立 Physics（R-001/R-009）", () => {
  test("上组依次 Scene/Objects/Env/Robots/Camera/Capture/Recording/Notes；下组 Physics/引擎/Files/Terminal/Outputs", () => {
    expect(upper).toEqual(["scene", "object", "environment", "robot", "camera", "capture", "recording", "annotation"])
    expect(lower).toEqual(["physics", "engine", "file", "terminal", "deliverable"])
    // 泛用 Library 退出一级轨（R-008）；Physics 在下组但行为是工具面板，不是抽屉/偏好。
    expect(RAIL_ENTRIES.some(entry => (entry.id as string) === "asset")).toBe(false)
    expect(RAIL_ENTRIES.find(entry => entry.id === "physics")!.behavior).toBe("tool")
    expect(RAIL_ENTRIES.find(entry => entry.id === "engine")!.behavior).toBe("engine")
    // 每个入口都有完整英文名与可见短标签，且不横向溢出靠的就是这两者分开。
    for (const entry of RAIL_ENTRIES) {
      expect(entry.en.length).toBeGreaterThan(0)
      expect(entry.shortEn.length).toBeGreaterThan(0)
    }
  })

  test("P17 视觉减法：工具轨 13 入口原顺序不变，宽屏也图标化，名称全部走 aria-label/title", () => {
    // 13 项入口是产品契约，不减项、不换序；可见文字不再常驻（CSS 由 .lya-rail-item .lya-rail-label 隐藏）。
    expect(RAIL_ENTRIES.length).toBe(13)
    expect(RAIL_ENTRIES.map(entry => entry.id)).toEqual([
      "scene", "object", "environment", "robot", "camera", "capture", "recording", "annotation",
      "physics", "engine", "file", "terminal", "deliverable",
    ])
    for (const entry of RAIL_ENTRIES) expect(entry.en.trim().length).toBeGreaterThan(0)
  })

  test("旧 tool=asset 迁移到 Objects，原型成员与未知值回退 null，合法工具保持", () => {
    expect(migrateToolId("asset")).toBe("object")
    expect(sanitizeWorkbenchUIState({tool: "asset"} as any).tool).toBe("object")
    for (const tool of ["capture", "recording", "physics"] as const) expect(sanitizeWorkbenchUIState({tool}).tool).toBe(tool)
    // 继承属性必须回 null：用 `in` 判断时 __proto__/constructor 会命中并返回对象/函数，违反 ToolId|null。
    for (const inherited of ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable"]) {
      const result = migrateToolId(inherited)
      expect(typeof result === "string" || result === null).toBe(true)
      expect(result).toBe(null)
    }
    expect(sanitizeWorkbenchUIState({tool: "__proto__"} as any).tool).toBe(null)
    expect(sanitizeWorkbenchUIState({tool: "constructor"} as any).tool).toBe(null)
    // 真正未知的字符串与非法类型同样回 null。
    expect(migrateToolId("asset-library")).toBe(null)
    expect(migrateToolId("nonexistent")).toBe(null)
    expect(migrateToolId(42)).toBe(null)
    expect(migrateToolId(null)).toBe(null)
    expect(migrateToolId({} as any)).toBe(null)
    expect(sanitizeWorkbenchUIState({tool: "asset-library"} as any).tool).toBe(null)
    // 合法工具直通（含旧 asset 迁移目标），localStorage 中坏值经 sanitize 仍回落 null。
    for (const tool of ["scene", "environment", "robot", "object", "camera", "capture", "recording", "annotation", "physics"] as const) expect(migrateToolId(tool)).toBe(tool)
    expect(sanitizeWorkbenchUIState(undefined).tool).toBe(null)
  })

  test("plugin.ts 的 ui_action 工具枚举覆盖全部新工具并保留旧 asset 迁移入口", () => {
    const plugin = readFileSync(new URL("../src/plugin.ts", import.meta.url), "utf8")
    const enumerate = /tool:\{type:"string",enum:\[([^\]]+)\]/.exec(plugin)?.[1] ?? ""
    const listed = [...enumerate.matchAll(/"([a-z]+)"/g)].map(match => match[1]!)
    for (const tool of ["scene", "environment", "robot", "object", "camera", "capture", "recording", "annotation", "physics"]) expect(listed).toContain(tool)
    expect(listed).toContain("asset")
  })

  test("真渲染 ToolRail：点击 Physics 切到独立面板，引擎按钮只切偏好并提供当前名", async () => {
    const {JSDOM} = createRequire(new URL("../../../.upstream/deepseek-harness-20260911-candidate/package.json", import.meta.url))("jsdom") as {JSDOM: new (html: string, options?: {url?: string}) => {window: Window & typeof globalThis}}
    const dom = new JSDOM('<div id="root"></div>', {url: "http://fixture.invalid"})
    const saved = new Map<string, PropertyDescriptor | undefined>()
    for (const key of ["window", "document", "HTMLElement", "Node", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
      Object.defineProperty(globalThis, key, {configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as unknown as Record<string, unknown>)[key]})
    }
    const {ToolRail} = await import("../src/tool-rail.tsx")
    const root = createRoot(document.getElementById("root")!)
    const switched: string[] = []
    try {
      await act(async () => root.render(createElement(ToolRail, {tr: (_zh: string, en: string) => en, engine: "mujoco", onSwitchEngine: (next: "isaac" | "mujoco") => switched.push(next)})))
      const labels = [...document.querySelectorAll<HTMLButtonElement>(".lya-rail-item")].map(button => button.getAttribute("aria-label"))
      expect(labels).toContain("Objects")
      expect(labels).toContain("Physics")
      expect(labels).toContain("Environment")
      // P17：图标化后仍是 13 个完整入口，名称全部走 aria-label/title（不靠图标下常驻文字）。
      const nav = document.querySelector<HTMLElement>(".lya-rail")!
      expect(nav.getAttribute("data-compact")).toBe("icon")
      const items = [...document.querySelectorAll<HTMLButtonElement>(".lya-rail-item")]
      expect(items.length).toBe(13)
      for (const item of items) {
        expect((item.getAttribute("aria-label") ?? "").trim().length).toBeGreaterThan(0)
        expect((item.getAttribute("title") ?? "").trim().length).toBeGreaterThan(0)
      }
      const physics = [...document.querySelectorAll<HTMLButtonElement>(".lya-rail-item")].find(button => button.getAttribute("aria-label") === "Physics")!
      await act(async () => physics.click())
      expect(physics.getAttribute("aria-pressed")).toBe("true")
      // 展示偏好落到 localStorage（跨会话/刷新保留的就是这一份），且只记合法 ToolId。
      expect(JSON.parse(localStorage.getItem("lyapunov.workbench.ui")!).tool).toBe("physics")
      const engine = [...document.querySelectorAll<HTMLButtonElement>(".lya-rail-item")].find(button => (button.getAttribute("aria-label") ?? "").startsWith("Physics engine:"))!
      await act(async () => engine.click())
      expect(switched).toEqual(["isaac"])
      // 引擎切换只写偏好，不改当前工具面板事实：Physics 仍处于打开态。
      expect(physics.getAttribute("aria-pressed")).toBe("true")
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
      for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) }
    }
  })
})

describe("R-009 引擎偏好往返：下一次动作按最新 preference，不按运行中 engine", () => {
  test("运行中引擎不变时，连续点击按保存偏好 MuJoCo→Isaac→MuJoCo→Isaac 请求", async () => {
    const {JSDOM} = createRequire(new URL("../../../.upstream/deepseek-harness-20260911-candidate/package.json", import.meta.url))("jsdom") as {JSDOM: new (html: string, options?: {url?: string}) => {window: Window & typeof globalThis}}
    const dom = new JSDOM('<div id="root"></div>', {url: "http://fixture.invalid"})
    const saved = new Map<string, PropertyDescriptor | undefined>()
    for (const key of ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"]) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
      Object.defineProperty(globalThis, key, {configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as unknown as Record<string, unknown>)[key]})
    }
    const {ToolRail} = await import("../src/tool-rail.tsx")
    const root = createRoot(document.getElementById("root")!)
    const switched: string[] = []
    const engineButton = () => [...document.querySelectorAll<HTMLButtonElement>(".lya-rail-item")].find(button => (button.getAttribute("aria-label") ?? "").startsWith("Physics engine:"))!
    // 运行中的 engine 始终是 mujoco；偏好由父组件（hook 的乐观更新）逐次推进。
    const render = (preference: string) => act(async () => root.render(createElement(ToolRail, {tr: (_zh: string, en: string) => en, engine: "mujoco", preference, onSwitchEngine: (next: string) => switched.push(next)})))
    try {
      await render("mujoco")
      expect(engineButton().getAttribute("data-engine")).toBe("mujoco")
      expect(engineButton().getAttribute("data-engine-preference")).toBe("mujoco")
      expect(engineButton().getAttribute("aria-label")).toContain("saved preference MuJoCo")
      await act(async () => engineButton().click())
      await render("isaac")
      await act(async () => engineButton().click())
      await render("mujoco")
      await act(async () => engineButton().click())
      await render("isaac")
      await act(async () => engineButton().click())
      expect(switched).toEqual(["isaac", "mujoco", "isaac", "mujoco"])
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
      for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) }
    }
  })

  test("两个挂载面都把运行 engine 与保存 preference 分开传给 ToolRail", () => {
    for (const file of ["../src/workbench.tsx", "../src/native-workspace.tsx"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8")
      expect(source).toMatch(/<ToolRail[^>]*preference=\{engineState\.preference\?\?undefined\}/)
      expect(source).toMatch(/<ToolRail[^>]*engine=\{engineState\.engine\?\?undefined\}/)
      expect(source).not.toMatch(/engine=\{engineState\.engine\?\?engineState\.preference/)
    }
  })
})
