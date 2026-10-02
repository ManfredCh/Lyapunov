/**
 * `workbench.tsx` 在宿主侧导入边界（**已登记为未覆盖项**的替代件）。
 *
 * 为什么需要它：`workbench.tsx:127` 的 `viewerResourceURI`（以及 `prepareViewerScene`）在浏览器面，
 * 宿主侧测试 import 它会拉 `@lyapunov/viewer/client` 的浏览器 ModuleLoader 产物；这里补齐其公开导入面。
 * 这份用例用 `mock.module` 只替掉那一个包，于是**产品源码那一句是真的被 import 进来跑的**，
 * 不需要在别处复刻它的正则或逻辑。
 *
 * 边界：**这不是 `prepareViewerScene` 的行为验收**（那属于 P3 的接线层口径）。它只保证
 * "宿主侧能拿到 `workbench.tsx` 里那两句并被测到"。
 *
 * 用法：`bun test packages/lyapunov-shell/test/workbench-import-surface.test.tsx`
 */
import { test, expect, mock } from "bun:test"
import { readFileSync } from "node:fs"

import {projectSceneCameraRigs} from "../../viewer/src/scene-camera-rigs.ts"
mock.module("@lyapunov/viewer/client", () => ({ projectSceneCameraRigs, createViewer: () => ({}), WebGLUnavailableError: class extends Error {} }))

test("`workbench.tsx` 可导入，且 `viewerResourceURI` 是真的产品实现", async () => {
  const mod = await import("../src/workbench.tsx")
  expect(typeof mod.viewerResourceURI).toBe("function")
  expect(typeof mod.prepareViewerScene).toBe("function")
  // 接线层自己写下的形状：`res:<指纹>?ext=.obj` → 标记（媒体路由按标记等值匹配）。
  expect(mod.viewerResourceURI("res:abc?ext=.obj")).toBe("res:abc")
  expect(mod.viewerResourceURI("res:abc")).toBe("res:abc")
  expect(mod.viewerResourceURI("/abs/path/x.stl")).toBe("/abs/path/x.stl")
})

test("漫游帮助写明Q下降/E上升及Shift倍率，视角中心与模型平移合同分开", async () => {
  const mod = await import("../src/workbench.tsx")
  expect(mod.VIEWER_NAVIGATION_HELP.zh).toContain("Q 下降 / E 上升")
  expect(mod.VIEWER_NAVIGATION_HELP.zh).toContain("Shift 加速 5 倍")
  expect(mod.VIEWER_NAVIGATION_HELP.en).toContain("Q down / E up")
  const plugin = readFileSync(new URL('../src/plugin.ts', import.meta.url), 'utf8')
  const start = plugin.indexOf('  name:"ui_action",')
  const contract = plugin.slice(start, plugin.indexOf('  parameters:', start))
  expect(contract).toContain("enterSceneCenter")
  expect(contract).toContain("Neither moves the model")
  expect(contract).toContain("complete transform in scene_edit")
})
