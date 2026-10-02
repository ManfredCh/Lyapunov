/**
 * `ui_action` 的 `openResource`（自然语言打开指定文件）回归：
 *
 *  1. **行为**（纯判据，真实调用产品实现）：
 *     - `openReceiptVerdict` 只认 `opened=true 且 visible=true` 且带真实标签 `address`/`kind` 的回执；
 *       `expect` 给了之后还要**规范资源地址一致**、**打开 kind 与请求方式一致**（错误文件/错误打开方式
 *       都不算成功）——这是"正负对照"的核心。
 *     - `openExpectationFor`：source 点名 kind（HTML 源码 / 普通文本编辑器），preview 只禁止源码编辑器。
 *     - `openWaiterOwnership` 只认"发起会话 + 被指定窗口"自己的确认。
 *  2. **接线**（静态契约）：工具公开参数含 `path/target`，动作枚举含 `openResource`，
 *     排队走 `queueResourceOpen`（带超时/取消/落队），前端 `drainUiActions` 执行后带 `opened/visible`
 *     回执确认；后台窗口按页面级工作面规则 defer（不抢前台）。
 *
 * 诚实边界：这里没有真实浏览器，也没有起完整 Host；"真窗口里点得到"由主控的运行验收补。
 * 另外"标签已打开可见"与"HTML 页面所有逻辑/资源都成功"是两件事——openResource 只承诺前者。
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { openExpectationFor, openReceiptVerdict, openWaiterOwnership, uiActionModelText } from "../src/ui-action-open.ts"
import { surfaceDisposition } from "../src/workbench-ui.ts"
import { productContextText } from "../src/product-context.ts"
import { EDITOR_KIND, HTML_EDITOR_KIND } from "../../lyapunov-workspace/src/workspace-kinds.ts"

const read = (relative: string) => readFileSync(join(import.meta.dirname, "..", ...relative.split("/")), "utf8")
const plugin = read("src/plugin.ts")
const workbench = read("src/workbench.tsx")
const nativeWorkspace = read("src/native-workspace.tsx")
const workspaceTabs = read("../lyapunov-workspace/src/native-workspace-tabs.tsx")

const session = "session-a"
const htmlAddress = `dsh-resource://file/session/${session}/site/page.html`
const htmlSourceAddress = htmlAddress // source/report 同地址；kind 区分方式

describe("openResource 回执判据（不能假成功）", () => {
  test("正例：opened/visible 且 address/kind 与期望逐项一致，原值带回", () => {
    const expectation = openExpectationFor({ path: "site/page.html", target: "source", address: htmlSourceAddress })
    expect(expectation.expectedKind).toBe(HTML_EDITOR_KIND)
    const receipt = { opened: true, visible: true, address: htmlSourceAddress, kind: HTML_EDITOR_KIND }
    const verdict = openReceiptVerdict(receipt, expectation)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.value).toEqual(receipt)
  })

  test("负例：错误文件（地址不符）与错误打开方式（kind 不符）都不能令请求成功", () => {
    const expectation = openExpectationFor({ path: "site/page.html", target: "source", address: htmlSourceAddress })
    // 打开了另一个文件：即便 opened/visible 都为真，地址对不上就不是被请求的那个文件。
    const wrongFile = openReceiptVerdict({ opened: true, visible: true, address: `dsh-resource://file/session/${session}/site/other.html`, kind: HTML_EDITOR_KIND }, expectation)
    expect(wrongFile.ok).toBe(false)
    if (!wrongFile.ok) expect(wrongFile.reason).toMatch(/^UI_ACTION_OPEN_ADDRESS_MISMATCH:/)
    // 用预览方式打开了要源码的资源：kind 不符。
    const wrongKind = openReceiptVerdict({ opened: true, visible: true, address: htmlSourceAddress, kind: "lyapunov.preview.html" }, expectation)
    expect(wrongKind.ok).toBe(false)
    if (!wrongKind.ok) expect(wrongKind.reason).toMatch(/^UI_ACTION_OPEN_KIND_MISMATCH:/)
    // 请求 preview 却落到 HTML 源码编辑器：同样判失败。
    const preview = openExpectationFor({ path: "site/page.html", target: "preview", address: htmlSourceAddress })
    expect(preview.forbiddenKind).toBe(HTML_EDITOR_KIND)
    const wrongMethod = openReceiptVerdict({ opened: true, visible: true, address: htmlSourceAddress, kind: HTML_EDITOR_KIND }, preview)
    expect(wrongMethod.ok).toBe(false)
    if (!wrongMethod.ok) expect(wrongMethod.reason).toMatch(/^UI_ACTION_OPEN_KIND_MISMATCH:/)
  })

  test("只排队/标签没显示/缺 address 或 kind/形状不对 → 明确失败（不同形状都给稳定错误码）", () => {
    for (const value of [undefined, null, "ok", 42, [], {}, { opened: true }, { visible: true }, { opened: true, visible: false }]) {
      const verdict = openReceiptVerdict(value)
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.reason).toMatch(/^UI_ACTION_OPEN_(RECEIPT_INVALID|NOT_VISIBLE):/)
    }
    // opened/visible 都为真但缺真实标签事实：不能拿请求参数当回执。
    for (const value of [{ opened: true, visible: true }, { opened: true, visible: true, address: "", kind: HTML_EDITOR_KIND }, { opened: true, visible: true, address: htmlAddress, kind: "" }]) {
      const verdict = openReceiptVerdict(value)
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.reason).toMatch(/^UI_ACTION_OPEN_RECEIPT_INVALID:/)
    }
  })

  test("期望 kind：source 点名（HTML 源码 / 普通文本编辑器），preview 只禁源码编辑器", () => {
    expect(openExpectationFor({ path: "a/page.html", target: "source", address: "A" })).toEqual({ address: "A", target: "source", expectedKind: HTML_EDITOR_KIND })
    expect(openExpectationFor({ path: "a/notes.md", target: "source", address: "B" })).toEqual({ address: "B", target: "source", expectedKind: EDITOR_KIND })
    expect(openExpectationFor({ path: "a/page.html", target: "preview", address: "C" })).toEqual({ address: "C", target: "preview", forbiddenKind: HTML_EDITOR_KIND })
  })

  test("归属：只有发起会话 + 被指定窗口自己的确认成立", () => {
    const waiter = { sessionKey: "session-a", clientId: "window-1" }
    expect(openWaiterOwnership(waiter, { sessionKey: "session-a", clientId: "window-1" })).toBeUndefined()
    const foreign = openWaiterOwnership(waiter, { sessionKey: "session-b", clientId: "window-1" })
    expect(foreign?.kind).toBe("foreign")
    expect(foreign?.reason).toContain("UI_ACTION_OPEN_FOREIGN_SESSION")
    const other = openWaiterOwnership(waiter, { sessionKey: "session-a", clientId: "window-2" })
    expect(other?.kind).toBe("client")
    expect(other?.reason).toContain("UI_ACTION_OPEN_CLIENT_MISMATCH")
    const anonymous = openWaiterOwnership(waiter, { sessionKey: "session-a" })
    expect(anonymous?.kind).toBe("client")
  })

  test("模型只收到已核验的文件与打开方式，内部标签回执仍可保留", () => {
    const receipt = { opened: true, visible: true, action: "openResource", path: "site/page.html", target: "preview", address: htmlAddress, kind: "lyapunov.preview.html", expectation: { address: htmlAddress, forbiddenKind: HTML_EDITOR_KIND } }
    expect(uiActionModelText(receipt)).toBe("已在工作台打开「site/page.html」的预览。")
    expect(uiActionModelText({ ...receipt, target: "source", kind: HTML_EDITOR_KIND })).toBe("已在工作台打开「site/page.html」的源码。")
    expect(uiActionModelText({ queued: "a", action: "openFiles" })).toBe('{"queued":"a","action":"openFiles"}')
    expect(openReceiptVerdict(receipt, openExpectationFor({ path: receipt.path, target: "preview", address: htmlAddress })).ok).toBe(true)
  })
})

describe("openResource 接线契约", () => {
  test("宿主动作枚举含 openResource，公开参数含 path/target，模型描述只解释用户动作", () => {
    expect(plugin).toContain('const uiActionNames=["openTool","openFiles","openTerminal","openResource"')
    expect(plugin).toContain("path:{type:\"string\"")
    expect(plugin).toContain('target:{type:"string",enum:["preview","source"]')
    const description = plugin.slice(plugin.indexOf('  name:"ui_action",'), plugin.indexOf('  parameters:', plugin.indexOf('  name:"ui_action",')))
    expect(description).toContain("returns after a window in the current session actually displays that file")
    expect(description).not.toContain("address/kind")
    expect(description).not.toContain("forbiddenKind")
    expect(productContextText).not.toContain("address/kind")
    expect(plugin).toContain("UI_ACTION_PATH_REQUIRED")
    expect(plugin).toContain("UI_ACTION_OPEN_TARGET_AMBIGUOUS")
    expect(plugin).toContain("text:uiActionModelText(value)")
  })

  test("排队带期望（规范地址 + 打开 kind），确认只由目标窗口下结论", () => {
    expect(plugin).toContain("queueResourceOpen")
    expect(plugin).toContain("openExpectationFor")
    expect(plugin).toContain("fileAddressFor")
    expect(plugin).toContain("UI_ACTION_OPEN_TIMEOUT")
    expect(plugin).toContain("UI_ACTION_OPEN_ABORTED")
    expect(plugin).toContain('kind:"open"')
    expect(plugin).toContain("settleOpenAction")
    expect(plugin).toContain("openReceiptVerdict")
    expect(plugin).toContain("openWaiterOwnership")
    // 确认失败也出队（否则同一动作会被每次轮询重试）。
    expect(plugin).toContain("UI_ACTION_OPEN_CLIENT_FAILED")
  })

  test("前端从真实激活标签回读 address/kind（不用请求参数当回执），无所有者时明确失败", () => {
    expect(nativeWorkspace).toContain("openExpectationFor")
    expect(nativeWorkspace).toContain("openReceiptVerdict")
    expect(nativeWorkspace).toContain("active.contentId===address")
    expect(nativeWorkspace).toContain("tab?.kind")
    // 回执字段取标签自身，而不是把请求里的 kind 抄回去。
    expect(nativeWorkspace).toContain("address:tab?.contentId??null,kind:tab?.kind??null")
    expect(workbench).toContain('item.action==="openResource"')
    expect(workbench).toContain("openReceiptVerdict")
    expect(workbench).toContain("UI_ACTION_OPEN_UNAVAILABLE")
    expect(surfaceDisposition("openResource", false)).toBe("defer")
    expect(surfaceDisposition("openResource", true)).toBe("apply")
    expect(workbench).toContain("openResourceRef")
  })

  test("标签所有者复用原生地址与注册表（不另造 iframe/文件页），source 点名工作区 kind", () => {
    expect(workspaceTabs).toContain("HTML_EDITOR_KIND")
    expect(workspaceTabs).toContain("openResourceIn")
    expect(workspaceTabs).not.toContain("<iframe")
    expect(workbench).not.toContain("<iframe")
  })
})
