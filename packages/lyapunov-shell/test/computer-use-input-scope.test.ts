/**
 * W22 · computer-use 合成输入的作用域/全局快捷键/快照恢复回归（D4）。
 *
 * 用**本机这条真实因果链**做判据（Lead 已复现，不是推测）：
 * ```
 * gsettings get org.gnome.desktop.a11y.applications screen-reader-enabled  →  false
 * xdotool key --clearmodifiers Super+Alt+s                                 →  合成按键进用户活动会话全局层
 * gsettings get … screen-reader-enabled                                    →  true   ← Orca 开始朗读
 * ```
 * 本文件把这条链条装进一个**会记账的假 X/gsettings 执行器**里：
 *   · 真跑 `xdotool key … Super+Alt+s` 时，假桌面会把 `screen-reader-enabled` 翻成 `true`（负对照）；
 *   · 走产品路径（`guardComputerUseInput` / `planComputerUseInput`）时，这个组合**根本不会被交给执行器**，
 *     所以假桌面保持 `false`（修复后同一动作不再产生该副作用）。
 * 负对照（把守卫摘掉、直接发全局 xdotool 命令）**必须精确变红**：它断言假桌面确实被打开——
 * 于是"测试没红"只可能是"命令真的没发出去"，不是因为假执行器坏了。
 *
 * 边界（如实登记）：本文件不向真实 X 服务器发送任何按键（只有只读探测，且用一个开关关掉）；
 * 真机"合成按键会打开屏幕阅读器"的因果链证据是 Lead 的复现记录（见回执 §1）。
 *
 * 机器状态（残留口子⑤ / W22-R3）：假桌面的 gsettings 表里多一条 `org.gnome.desktop.wm.preferences
 * mouse-button-modifier`（默认 `'<Super>'` ＝ 本机形态；产品路径用例可传 `'<Alt>'` 换成另一种真实形态）。
 * `describe("⑥ 拖动修饰键豁免按**机器状态**取反 …")` 给出两个形态的逐条读数；**每一条用例前后都
 * `rememberDesktopMachineFacts(undefined)`**，避免上一条用例读到的机器形态污染下一条。
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import JobsLocal from "@deepseek-ai/dsh-jobs-local"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools"
import { ToolCallId } from "@deepseek-ai/dsh-llm"
import { createScope } from "@deepseek-ai/dsh-scope"
import { SessionId } from "@deepseek-ai/dsh-session"
import { isolateProviderInstaller } from "./fixtures/isolated-provider-installer.ts"
import {
  A11Y_SNAPSHOT_KEYS,
  COMPUTER_USE_INPUT_ERRORS,
  CUA_DRIVER_TOOL_CATALOG,
  CUA_DRIVER_TOOL_NAMES,
  CUA_DRIVER_TOOL_PREFIX,
  CUA_DRIVER_TOOL_REFUSALS,
  CUA_GLOBAL_STATE_TOOL_NAMES,
  CUA_INPUT_TOOL_NAMES,
  CUA_PRIVACY_READ_TOOL_NAMES,
  GLOBAL_SHORTCUT_RULES,
  MOUSE_BUTTON_MODIFIER_KEY,
  MOUSE_BUTTON_MODIFIER_SCHEMA,
  captureDesktopSettingsSnapshot,
  closeComputerUseSession,
  cuaDriverToolPassThrough,
  cuaDriverToolRefusal,
  cuaDriverToolSpec,
  cuaGlobalStateToolName,
  cuaInputToolName,
  cuaPrivacyReadToolName,
  desktopDragModifiersOf,
  desktopMachineFacts,
  enforceVisibleIndicator,
  globalShortcutVerdict,
  guardComputerUseInput,
  inputCombosOf,
  inputSurfaceOf,
  openComputerUseSession,
  parseKeyChord,
  rememberDesktopMachineFacts,
  restoreDesktopSettings,
  type CommandRunner,
  type InputScopeState,
} from "../src/computer-use-input.ts"

const SCREEN_READER = "org.gnome.desktop.a11y.applications screen-reader-enabled"
const STATUS_ICON = "org.gnome.desktop.a11y always-show-universal-access-status"
/** 机器状态那一条只读读数（`gsettings get <schema> <key>`）在假桌面表里的键。 */
const MACHINE_KEY = `${MOUSE_BUTTON_MODIFIER_SCHEMA} ${MOUSE_BUTTON_MODIFIER_KEY}`
/** 本机形态（Ubuntu 22.04 的**编译期 schema 默认值**，只读实测 `'<Super>'`）。 */
const MACHINE_SUPER = "'<Super>'"
/** 另一种真实存在的形态：上游 3.5.2 之前的默认值 / 本机 Ubuntu `:Unity` profile override。 */
const MACHINE_ALT = "'<Alt>'"
/** 守卫层的"这台机器是 `<Super>`"作用域（把作用域/同意/指示都排除干净）。 */
const machineSuper: InputScopeState = { consent: true, indicatorVisible: true, mouseButtonModifier: MACHINE_SUPER }
const machineAlt: InputScopeState = { consent: true, indicatorVisible: true, mouseButtonModifier: MACHINE_ALT }

/**
 * 假桌面：一张 GNOME 风格的 gsettings 表 + 一条"合成按键会触发全局快捷键"的规则。
 * 真按键路径（负对照）会走到 `xdotool`，这里按真实因果链把屏幕阅读器打开。
 * 表里含**机器状态**那一条（`mouse-button-modifier`，默认 ＝ 本机形态 `'<Super>'`）：
 * 会话快照会多读它一次，`drag` 的拖动豁免按它取反（见 `describe("⑥ …")`）。
 */
function fakeDesktop(initial: Record<string, string> = {}) {
  const values = new Map<string, string>([
    [SCREEN_READER, "false"],
    [STATUS_ICON, "false"],
    ["org.gnome.desktop.a11y.applications screen-magnifier-enabled", "false"],
    ["org.gnome.desktop.a11y.applications screen-keyboard-enabled", "false"],
    ["org.gnome.desktop.a11y.keyboard stickykeys-enable", "false"],
    ["org.gnome.desktop.a11y.keyboard slowkeys-enable", "false"],
    ["org.gnome.desktop.a11y.keyboard mousekeys-enable", "false"],
    ["org.gnome.desktop.input-sources sources", "[('xkb', 'us')]"],
    ["org.gnome.desktop.input-sources mru-sources", "[('xkb', 'us')]"],
    [MACHINE_KEY, MACHINE_SUPER],
    ...Object.entries(initial),
  ])
  const calls: string[][] = []
  const runner: CommandRunner = async argv => {
    calls.push([...argv])
    const [program, verb, schema, key, ...rest] = argv
    if (program === "gsettings" && (verb === "get" || verb === "set")) {
      const id = `${schema ?? ""} ${key ?? ""}`
      if (!values.has(id)) return { code: 1, stdout: "", stderr: `未注册的键 ${id}` }
      if (verb === "get") return { code: 0, stdout: values.get(id)! + "\n", stderr: "" }
      values.set(id, rest.join(" "))
      return { code: 0, stdout: "", stderr: "" }
    }
    if (program === "notify-send") return { code: 0, stdout: "", stderr: "" }
    if (program === "xdotool") {
      // **真实因果链的替身**：驱动用 `xdotool key --clearmodifiers <combo>` 发全局按键；
      // Super+Alt+s 会被 GNOME 全局快捷键捕获，把屏幕阅读器打开。
      const combo = argv.at(-1) ?? ""
      if (combo.toLowerCase().replace(/\s/g, "").includes("super+alt+s")) values.set(SCREEN_READER, "true")
      return { code: 0, stdout: "", stderr: "" }
    }
    return { code: 1, stdout: "", stderr: `未知程序 ${program ?? ""}` }
  }
  return {
    runner,
    calls,
    get: (id: string) => values.get(id)!,
    /** 负对照专用的"真发一次全局按键"：完全绕过守卫，命令形状与产品现状/Lead 复现一致。 */
    legacyGlobalKey: async (combo: string) => { await runner(["xdotool", "key", "--clearmodifiers", combo], { env: {}, timeoutMs: 5000 }) },
    commandsTo: (program: string) => calls.filter(call => call[0] === program),
  }
}

let root: string | undefined
// 机器状态是**本模块记下的最近一次只读读数**（产品路径由会话快照写入）：每个用例前后都清掉，
// 否则上一条用例（或产品路径替身）读到的机器形态会污染下一条 ⇒ 读数不再是"这一条用例的"。
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lyapunov-w22-")); rememberDesktopMachineFacts(undefined) })
afterEach(() => { if (root !== undefined) rmSync(root, { recursive: true, force: true }); root = undefined; rememberDesktopMachineFacts(undefined) })

const env = () => ({ DISPLAY: ":1", XDG_SESSION_TYPE: "x11" })

describe("W22 ① 全局快捷键拒绝清单", () => {
  test("必须拒绝的类别逐条命中（Super+*、Ctrl+Alt+*、媒体键、屏幕阅读器、放大镜、粘滞键、输入法切换）", () => {
    const cases: Array<[string, string]> = [
      ["Super+Alt+s", COMPUTER_USE_INPUT_ERRORS.A11Y_TOGGLE],       // 用户投诉的那一个
      ["super+alt+8", COMPUTER_USE_INPUT_ERRORS.A11Y_TOGGLE],       // 放大镜开关
      ["Super+Alt+equal", COMPUTER_USE_INPUT_ERRORS.A11Y_TOGGLE],   // 放大
      ["Shift", COMPUTER_USE_INPUT_ERRORS.BARE_MODIFIER],           // 粘滞键触发序列
      ["XF86AudioRaiseVolume", COMPUTER_USE_INPUT_ERRORS.MEDIA_KEY],
      ["XF86AudioMute", COMPUTER_USE_INPUT_ERRORS.MEDIA_KEY],
      ["XF86MonBrightnessDown", COMPUTER_USE_INPUT_ERRORS.MEDIA_KEY],
      ["XF86Sleep", COMPUTER_USE_INPUT_ERRORS.MEDIA_KEY],
      ["Super+space", COMPUTER_USE_INPUT_ERRORS.IME_SHORTCUT],      // GNOME 输入法切换
      ["ctrl+space", COMPUTER_USE_INPUT_ERRORS.IME_SHORTCUT],
      ["alt+shift", COMPUTER_USE_INPUT_ERRORS.IME_SHORTCUT],
      ["Alt+Tab", COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT],       // WM 窗口切换
      ["ctrl+alt+t", COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT],
      ["ctrl+alt+f1", COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT],   // VT 切换
      ["Super+l", COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT],       // 锁屏
      ["Super+a", COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT],
      ["Print", COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT],
    ]
    const verdicts = cases.map(([combo, code]) => {
      const verdict = globalShortcutVerdict(combo)
      return { combo, refused: verdict.refused, code: verdict.refused ? verdict.code : null, expected: code }
    })
    expect(verdicts.filter(row => !row.refused || row.code !== row.expected)).toEqual([])
    // 每一条拒绝都必须给"为什么 + 用户怎么做"，不是一句干巴巴的 invalid。
    for (const [combo] of cases) {
      const verdict = globalShortcutVerdict(combo)
      if (!verdict.refused) throw new Error(`应当拒绝：${combo}`)
      expect(verdict.why.length).toBeGreaterThan(10)
      expect(verdict.advice.length).toBeGreaterThan(5)
      expect(verdict.rule.length).toBeGreaterThan(0)
    }
    // 规则表覆盖上面每一类（改规则表会立刻反映到用例上）。
    expect(new Set(GLOBAL_SHORTCUT_RULES.map(rule => rule.code))).toEqual(new Set([
      COMPUTER_USE_INPUT_ERRORS.A11Y_TOGGLE,
      COMPUTER_USE_INPUT_ERRORS.BARE_MODIFIER,
      COMPUTER_USE_INPUT_ERRORS.MEDIA_KEY,
      COMPUTER_USE_INPUT_ERRORS.IME_SHORTCUT,
      COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT,
    ]))
  })

  test("正常输入不被误伤：应用内键、文本输入、显式 Ctrl+C 照常放行", () => {
    // 注意：这里**不再**出现 `"alt+F4".toLowerCase() === "x" ? "" : "F5"` 那种恒真死表达式
    // （W22 验收 §6.2 第 4 条：它是"曾把 alt+F4 放进白名单"的编辑残留）。
    for (const combo of ["a", "Return", "ctrl+c", "ctrl+shift+z", "F5"])
      expect(`${combo}:${JSON.stringify(globalShortcutVerdict(combo))}`).toBe(`${combo}:${JSON.stringify({ refused: false })}`)
  })

  test("WM 规则按「Alt + 非字符键」整类覆盖（本机 gsettings 只读枚举到的那 7 条真组合都在内）", () => {
    // 这 7 条是本机 `org.gnome.desktop.wm.keybindings` 里**真实绑定**的 mutter 全局抓取，
    // W22 验收 §2.1 实测当时全部被放行（规则 6 只列了 tab/escape/f1/f2/f4/f10）。
    for (const combo of ["Alt+F7", "Alt+F8", "Alt+F6", "Alt+Shift+F6", "Alt+Space", "Alt+Above_Tab", "Alt+Shift+Above_Tab"]) {
      const verdict = globalShortcutVerdict(combo)
      expect(`${combo}:${String(verdict.refused)}:${verdict.refused ? verdict.rule : ""}`).toBe(`${combo}:true:wm-window-switch`)
    }
    // 整类覆盖：F1–F12 / 方向键 / Delete / Above_Tab 都在内。
    for (const combo of ["Alt+F1", "Alt+F3", "Alt+F5", "Alt+F9", "Alt+F11", "Alt+F12", "Alt+Left", "Alt+Right", "Alt+Up", "Alt+Down", "Alt+Delete"])
      expect(`${combo}:${String(globalShortcutVerdict(combo).refused)}`).toBe(`${combo}:true`)
    // **不误伤**：`Alt+<字符>` 是很多键盘布局输入第三层字符的正常写法，必须照常放行。
    for (const combo of ["Alt+s", "Alt+d", "Alt+t", "Alt+shift+n"])
      expect(`${combo}:${String(globalShortcutVerdict(combo).refused)}`).toBe(`${combo}:false`)
  })

  test("裸修饰键按 keysym/evdev 拼写归一（Shift_L/Control_L/Alt_L/Super_L/Meta_L/KEY_*）", () => {
    // 真实按键流里的名字是 keysym（`Shift_L`…），驱动还能收 evdev 写法（`KEY_LEFTMETA`）。
    // W22 验收 §2.2b 实测：旧实现只认 `shift`/`super` 这类别名 ⇒ 连按 5 次 `Shift_L` 不被拒。
    const bareModifiers = [
      "Shift_L", "Shift_R", "Control_L", "Control_R", "Alt_L", "Alt_R", "Super_L", "Super_R", "Meta_L", "Meta_R",
      "KEY_LEFTMETA", "KEY_RIGHTMETA", "KEY_LEFTCTRL", "KEY_RIGHTCTRL", "KEY_LEFTALT", "KEY_RIGHTSHIFT",
      "key_leftmeta", "<Super_L>", "ISO_Level3_Shift",
    ]
    for (const combo of bareModifiers) {
      const verdict = globalShortcutVerdict(combo)
      expect(`${combo}:${verdict.refused ? verdict.code : "ALLOWED"}`).toBe(`${combo}:${COMPUTER_USE_INPUT_ERRORS.BARE_MODIFIER}`)
    }
    // 归一后落到同一个判定：`KEY_LEFTMETA+s` 与 `super+s` 一样被拒（Super 组合）。
    for (const combo of ["KEY_LEFTMETA+s", "Super_L+s", "<Super_L>+s"])
      expect(`${combo}:${String(globalShortcutVerdict(combo).refused)}`).toBe(`${combo}:true`)
    // 解析层：四种写法归一到同一个 `KeyChord`。
    expect(parseKeyChord("KEY_LEFTMETA")).toEqual({ modifiers: ["super"], key: "", raw: "KEY_LEFTMETA" })
    expect(parseKeyChord("Super_L")).toEqual({ modifiers: ["super"], key: "", raw: "Super_L" })
    expect(parseKeyChord("KEY_LEFTCTRL+c")).toEqual({ modifiers: ["ctrl"], key: "c", raw: "KEY_LEFTCTRL+c" })
  })

  test("XKB AccessX 切换键与 X core 锁键：一律拒绝（gsettings 快照抓不到也恢复不了）", () => {
    const accessx = ["AccessX_Enable", "StickyKeys_Enable", "SlowKeys_Enable", "BounceKeys_Enable", "MouseKeys_Enable", "RepeatKeys_Enable", "Caps_Lock", "Num_Lock"]
    for (const combo of accessx) {
      const verdict = globalShortcutVerdict(combo)
      expect(`${combo}:${verdict.refused ? verdict.code : "ALLOWED"}`).toBe(`${combo}:${COMPUTER_USE_INPUT_ERRORS.A11Y_TOGGLE}`)
    }
    for (const combo of ["Shift+Num_Lock", "Alt+Shift+Num_Lock"])
      expect(`${combo}:${String(globalShortcutVerdict(combo).refused)}`).toBe(`${combo}:true`)
  })

  test("组合键解析：xdotool 写法、大小写、修饰键顺序都归一；写法看不懂的组合 fail-closed", () => {
    expect(parseKeyChord("<ctrl>+<shift>+T")).toEqual({ modifiers: ["ctrl", "shift"], key: "t", raw: "<ctrl>+<shift>+T" })
    expect(parseKeyChord("SHIFT+CTRL+ALT+s")).toEqual({ modifiers: ["ctrl", "alt", "shift"], key: "s", raw: "SHIFT+CTRL+ALT+s" })
    // 一个组合里两个主键 / 空串：不合成（返回拒绝，而不是"猜一个"）。
    expect(globalShortcutVerdict("ctrl+c v").refused).toBe(true)
    expect(globalShortcutVerdict("").refused).toBe(true)
  })
})

describe("W22 ② 输入作用域：窗口优先；全局层要显式同意 + 可见指示", () => {
  const noScope = { consent: false, indicatorVisible: false }
  const consent = { consent: true, indicatorVisible: true }

  test("没有窗口/进程目标 ⇒ 拒绝（这就是用户投诉那条路径），给 CONSENT_REQUIRED", () => {
    const plan = guardComputerUseInput({ tool: "cua_driver_native__click", arguments: { x: 10, y: 10 }, scope: noScope })
    expect(plan.deliver).toBe(false)
    if (plan.deliver) throw new Error("unreachable")
    expect(plan.code).toBe(COMPUTER_USE_INPUT_ERRORS.CONSENT_REQUIRED)
    expect(plan.reason).toContain("全局")
    expect(plan.advice).toContain("target")
  })

  test("给了窗口目标 ⇒ 走窗口作用域（不需要同意，也不进全局层）", () => {
    const plan = guardComputerUseInput({ tool: "cua_driver_native__click", arguments: { target: { window_id: 4242, pid: 777 }, x: 1, y: 2 }, scope: noScope })
    expect(plan.deliver).toBe(true)
    if (!plan.deliver) throw new Error("unreachable")
    expect(plan.scope).toBe("window")
    expect(plan.surface).toEqual({ windowId: "4242", pid: 777 })
    // 顶层 `target` 字符串与 legacy `window_id` 也认。
    expect(inputSurfaceOf({ target: "0x1a2b" })).toEqual({ windowId: "0x1a2b" })
    expect(inputSurfaceOf({ window_id: 99 })).toEqual({ windowId: "99" })
  })

  test("用户同意 + 可见指示都齐了才允许全局输入；缺指示仍然拒", () => {
    const denied = guardComputerUseInput({ tool: "cua_driver_native__click", arguments: {}, scope: { consent: true, indicatorVisible: false } })
    expect(denied.deliver).toBe(false)
    if (denied.deliver) throw new Error("unreachable")
    expect(denied.code).toBe(COMPUTER_USE_INPUT_ERRORS.INDICATOR_REQUIRED)
    const allowed = guardComputerUseInput({ tool: "cua_driver_native__click", arguments: {}, scope: consent })
    expect(allowed.deliver).toBe(true)
    if (!allowed.deliver) throw new Error("unreachable")
    expect(allowed.scope).toBe("global")
  })

  test("非输入类工具不归本模块管（不误拦）", () => {
    const plan = guardComputerUseInput({ tool: "cua_driver_native__get_window_state", arguments: {pid:777,window_id:4242}, scope: noScope })
    expect(plan.deliver).toBe(false)
    if (plan.deliver) throw new Error("unreachable")
    expect(plan.code).toBe(COMPUTER_USE_INPUT_ERRORS.TOOL_UNKNOWN)
    expect(CUA_INPUT_TOOL_NAMES).toContain("hotkey")
  })

  test("键参数从驱动入参的多个键收出来（key/keys/hotkey/combination），空则没有组合", () => {
    expect(inputCombosOf({ key: "Super+Alt+s" })).toEqual(["Super+Alt+s"])
    expect(inputCombosOf({ input: { hotkey: "ctrl+alt+t" } })).toEqual(["ctrl+alt+t"])
    expect(inputCombosOf({ text: "你好" })).toEqual([])
    // 驱动的**规范形**是修饰键与主键单列的数组（校验文案 `Provide 'keys' array (e.g. ["ctrl","c"])`）：
    // 归一成**一个**组合，而不是拆成两个"裸修饰键"整条误拒（W22 验收 §2.3）。
    expect(inputCombosOf({ keys: ["ctrl", "c"] })).toEqual(["ctrl+c"])
    expect(inputCombosOf({ keys: ["ctrl", "shift", "z"] })).toEqual(["ctrl+shift+z"])
    expect(inputCombosOf({ keys: ["super", "alt", "s"] })).toEqual(["super+alt+s"])
    // 单串写法与规范形归一后**逐字相同** ⇒ 两条写法不可能给出两种判定。
    expect(inputCombosOf({ keys: ["ctrl+c"] })).toEqual(["ctrl+c"])
  })

  test("规范形 `keys:[\"ctrl\",\"c\"]` 照常放行 —— 修好「正常组合键发不出去」这条功能回归", () => {
    // W22 验收 §2.3：旧实现把数组元素逐个当独立组合 ⇒ `["ctrl","c"]` 被当成"单发修饰键"整条拒。
    // 而 W22/DEV-006 的用例只用了**非规范**的 `keys:["Super+Alt+s"]`，恰好躲过这个语义错位。
    for (const keys of [["ctrl", "c"], ["ctrl", "shift", "z"], ["ctrl+c"], ["ctrl+shift+z"]]) {
      const plan = guardComputerUseInput({ tool: "cua_driver_native__hotkey", arguments: { target: { window_id: 4242 }, keys }, scope: { consent: false, indicatorVisible: false } })
      expect(`${JSON.stringify(keys)}:${String(plan.deliver)}`).toBe(`${JSON.stringify(keys)}:true`)
    }
    // 反向：同一条规范形写法的**危险**组合仍然被拒（放行不是放宽，是纠正语义错位）。
    for (const keys of [["super", "alt", "s"], ["alt", "Tab"], ["alt", "F4"], ["super", "l"]]) {
      const plan = guardComputerUseInput({ tool: "cua_driver_native__hotkey", arguments: { target: { window_id: 4242 }, keys }, scope: { consent: true, indicatorVisible: true } })
      expect(`${JSON.stringify(keys)}:${String(plan.deliver)}`).toBe(`${JSON.stringify(keys)}:false`)
    }
  })
})

describe("W22 ⑦ 一号发现回归：`press_key.modifiers` / `drag.modifier` 不能绕过拒绝清单", () => {
  /** 最宽松的作用域：把"作用域"这一层排除掉，剩下的判定只可能来自键与拒绝清单。 */
  const widest = { consent: true, indicatorVisible: true }

  /**
   * W22 验收 §2.2a：驱动契约 `PressKeyInput = {key, modifiers?}`（`DragInput` 用 `modifier`），
   * 而旧 `inputCombosOf` **从不读**这两个字段 ⇒ 用户投诉的 `Super+Alt+S` 原样发得出去。
   * 逐条读数（改前 → 改后）见回执 §1。
   */
  const pressKeyCases: Array<[string, unknown, string]> = [
    // [用例名, 驱动入参, 期望拒绝码]
    ["① press_key {key,modifiers}：用户投诉的那一次按键", { key: "s", modifiers: ["super", "alt"], target: { window_id: 7 }, pid: 9 }, COMPUTER_USE_INPUT_ERRORS.A11Y_TOGGLE],
    ["press_key {key:\"8\",modifiers:[\"super\",\"alt\"]}（放大镜）", { key: "8", modifiers: ["super", "alt"], target: { window_id: 7 }, pid: 9 }, COMPUTER_USE_INPUT_ERRORS.A11Y_TOGGLE],
    ["② press_key {key:\"Tab\",modifiers:[\"alt\"]}", { key: "Tab", modifiers: ["alt"], target: { window_id: 7 }, pid: 9 }, COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT],
    ["press_key {key:\"F4\",modifiers:[\"alt\"]}", { key: "F4", modifiers: ["alt"], target: { window_id: 7 }, pid: 9 }, COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT],
    ["④ press_key {key:\"F7\",modifiers:[\"alt\"]}（begin-move）", { key: "F7", modifiers: ["alt"], target: { window_id: 7 }, pid: 9 }, COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT],
    ["⑤ press_key {key:\"Space\",modifiers:[\"alt\"]}（activate-window-menu）", { key: "Space", modifiers: ["alt"], target: { window_id: 7 }, pid: 9 }, COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT],
    ["press_key {key:\"Above_Tab\",modifiers:[\"alt\"]}（switch-group）", { key: "Above_Tab", modifiers: ["alt"], target: { window_id: 7 }, pid: 9 }, COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT],
    ["press_key {key:\"c\",modifiers:[\"super\"]}（锁屏类 Super 组合）", { key: "c", modifiers: ["super"], target: { window_id: 7 }, pid: 9 }, COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT],
    ["press_key {key:\"l\",modifiers:[\"super\"]}", { key: "l", modifiers: ["super"], target: { window_id: 7 }, pid: 9 }, COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT],
    ["press_key {key:\"x\",modifiers:[\"ctrl\",\"alt\"]}", { key: "x", modifiers: ["ctrl", "alt"], target: { window_id: 7 }, pid: 9 }, COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT],
    ["press_key {key:\"a\",modifiers:[\"XF86AudioRaiseVolume\"]}（修饰键位置塞媒体键）", { key: "a", modifiers: ["XF86AudioRaiseVolume"], target: { window_id: 7 }, pid: 9 }, COMPUTER_USE_INPUT_ERRORS.MEDIA_KEY],
    ["press_key {key:\"Num_Lock\",modifiers:[\"shift\"]}（AccessX 锁键）", { key: "Num_Lock", modifiers: ["shift"], target: { window_id: 7 }, pid: 9 }, COMPUTER_USE_INPUT_ERRORS.A11Y_TOGGLE],
    ["press_key {key:\"s\",modifiers:[\"Shift_L\",\"Meta_L\"]}（keysym 写法的修饰键）", { key: "s", modifiers: ["Shift_L", "Meta_L"], target: { window_id: 7 }, pid: 9 }, COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT],
    ["press_key {key:\"s\",modifiers:[\"KEY_LEFTMETA\",\"KEY_LEFTALT\"]}（evdev 写法）", { key: "s", modifiers: ["KEY_LEFTMETA", "KEY_LEFTALT"], target: { window_id: 7 }, pid: 9 }, COMPUTER_USE_INPUT_ERRORS.A11Y_TOGGLE],
  ]

  test("每一组 `key`+`modifiers` 都必须被拒，且 `combos` 里带的是**合成后的完整组合**", () => {
    for (const [label, args, code] of pressKeyCases) {
      const plan = guardComputerUseInput({ tool: "cua_driver_native__press_key", arguments: args, scope: widest })
      const got = plan.deliver ? "DELIVERED" : plan.code
      expect(`${label} ⇒ ${got}`).toBe(`${label} ⇒ ${code}`)
      expect(plan.combos.length).toBeGreaterThan(0)   // 拒绝理由里必须能读出"被拒的是哪个组合"
    }
    // 合成的组合逐条核对（不是"随便拒了就算"）。
    expect(inputCombosOf({ key: "s", modifiers: ["super", "alt"] })).toEqual(["super+alt+s"])
    expect(inputCombosOf({ key: "Tab", modifiers: ["alt"] })).toEqual(["alt+Tab"])
    expect(inputCombosOf({ key: "F7", modifiers: ["alt"] })).toEqual(["alt+F7"])
    expect(inputCombosOf({ key: "space", modifiers: ["alt"] })).toEqual(["alt+space"])
    expect(inputCombosOf({ key: "Above_Tab", modifiers: ["alt"] })).toEqual(["alt+Above_Tab"])
    expect(inputCombosOf({ key: "s", modifiers: ["KEY_LEFTMETA", "KEY_LEFTALT"] })).toEqual(["super+alt+s"])
    // `modifiers` 嵌套在 `input` 里也认（驱动两种包装都存在）。
    expect(inputCombosOf({ input: { key: "s", modifiers: ["super", "alt"] } })).toEqual(["super+alt+s"])
  })

  test("`drag {modifier:[\"super\"]}` 不能因为「没有主键」就被当成「没有组合」放行", () => {
    // W22 验收 §2.2a 实测：旧实现 `combos=[]` ⇒ 一条规则都不判 ⇒ DELIVERED（Super+拖动＝移动用户窗口）。
    // 现在判成"桌面级组合"而不是"裸修饰键"：Super+拖动是 WM 抓取，不是"单发修饰键"，语义上更准。
    const plan = guardComputerUseInput({ tool: "cua_driver_native__drag", arguments: { fromX: 1, fromY: 1, toX: 200, toY: 200, modifier: ["super"], target: { window_id: 7 } }, scope: widest })
    expect(plan.deliver).toBe(false)
    if (plan.deliver) throw new Error("unreachable")
    expect(plan.code).toBe(COMPUTER_USE_INPUT_ERRORS.GLOBAL_SHORTCUT)
    expect(plan.rule).toBe("super-combos")
    expect(inputCombosOf({ fromX: 1, fromY: 1, toX: 2, toY: 2, modifier: ["super"] })).toEqual(["super"])
    // 反向：不带修饰键的拖拽照常交付（不是把 drag 整体关掉）。
    expect(guardComputerUseInput({ tool: "cua_driver_native__drag", arguments: { fromX: 1, fromY: 1, toX: 200, toY: 200, target: { window_id: 7 } }, scope: widest }).deliver).toBe(true)
    // 反向：`shift`/`ctrl`/`alt` 拖动是**应用内**正常用法（选择、拖放、复制），仍然放行。
    // ⚠️ 这里必须带上**这台机器的读数**（本机 = `'<Super>'`）：`alt` 拖动放不放行是**机器状态**的函数，
    // 不是常量（残留口子⑤）。同一批入参在 `'<Alt>'` 形态下的读数见 `describe("⑥ …")`：
    // 那时 `["alt"]` 变 REFUSED `drag-moves-user-window`，而 `["shift"]`/`["ctrl"]` 照旧放行。
    for (const modifier of [["shift"], ["ctrl"], ["alt"], ["shift", "ctrl"]])
      expect(`${JSON.stringify(modifier)}:${String(guardComputerUseInput({ tool: "cua_driver_native__drag", arguments: { fromX: 1, fromY: 1, toX: 200, toY: 200, modifier, target: { window_id: 7 } }, scope: machineSuper }).deliver)}`).toBe(`${JSON.stringify(modifier)}:true`)
    // `ctrl+alt` 拖动仍然拒（桌面级组合）。
    expect(guardComputerUseInput({ tool: "cua_driver_native__drag", arguments: { fromX: 1, fromY: 1, toX: 200, toY: 200, modifier: ["ctrl", "alt"], target: { window_id: 7 } }, scope: widest }).deliver).toBe(false)
    // 而**按键**通道的单发修饰键照旧被拒（`drag` 的例外没有泄漏到 `press_key`）。
    const bare = guardComputerUseInput({ tool: "cua_driver_native__press_key", arguments: { key: "Shift", target: { window_id: 7 } }, scope: widest })
    expect(bare.deliver).toBe(false)
    if (bare.deliver) throw new Error("unreachable")
    expect(bare.code).toBe(COMPUTER_USE_INPUT_ERRORS.BARE_MODIFIER)
  })

  test("允许的那一类照常放行：`{key:\"s\",modifiers:[\"ctrl\"]}` 与 `{key:\"a\",modifiers:[\"shift\"]}`（打大写）", () => {
    for (const args of [{ key: "a", modifiers: ["shift"] }, { key: "s", modifiers: ["ctrl"] }, { key: "z", modifiers: ["ctrl", "shift"] }, { key: "s" }]) {
      const plan = guardComputerUseInput({ tool: "cua_driver_native__press_key", arguments: { ...args, target: { window_id: 7 } }, scope: widest })
      expect(`${JSON.stringify(args)}:${plan.deliver ? "DELIVERED" : plan.code}`).toBe(`${JSON.stringify(args)}:DELIVERED`)
    }
  })
})

describe("W22 ⑧ 残留通道：`move_cursor` 纳入输入守卫，`clipboard_write` 没有可恢复路径 ⇒ 一律拒", () => {
  /** 最宽松：把"作用域/同意/指示"这一层排除掉。 */
  const widest = { consent: true, indicatorVisible: true }
  /** 默认态：没有用户同意、没有可见指示。 */
  const bare = { consent: false, indicatorVisible: false }

  test("`move_cursor` 的契约带 `target`：带窗口目标 ⇒ 窗口作用域；不带 ⇒ 只能算全局层", () => {
    // 契约逐字（`@trycua/cua-driver@0.28.0` 的 `cua_driver_contract.d.ts`）：
    //   MoveCursorInput { x: number; y: number; target?: ActionTarget; scope?: DesktopScope; session?: string }
    // ⇒ 它**能**指名窗口，所以纳入 `CUA_INPUT_TOOL_NAMES` 后两种结果都在正确的一侧。
    expect(CUA_INPUT_TOOL_NAMES).toContain("move_cursor")
    expect(cuaInputToolName("cua_driver_native__move_cursor")).toBe("move_cursor")
    // ① 嵌套 `target`（ActionTarget.Window 的线上形状）。
    const nested = guardComputerUseInput({ tool: "cua_driver_native__move_cursor", arguments: { x: 10, y: 20, target: { window_id: 4242, pid: 777 } }, scope: bare })
    expect(nested.deliver).toBe(true)
    if (!nested.deliver) throw new Error("unreachable")
    expect(nested.scope).toBe("window")
    expect(nested.surface).toEqual({ windowId: "4242", pid: 777 })
    // ② 本产品自己的门用的**扁平**形状（`pid`+`window_id`+`scope:"window"`）也认。
    const flat = guardComputerUseInput({ tool: "cua_driver_native__move_cursor", arguments: { x: 10, y: 20, pid: 777, window_id: 4242, scope: "window" }, scope: bare })
    expect(flat.deliver).toBe(true)
    if (!flat.deliver) throw new Error("unreachable")
    expect(flat.scope).toBe("window")
    expect(flat.surface).toEqual({ windowId: "4242", pid: 777 })
    // ③ 不带目标（默认态）⇒ 拒：这次移动只能作用于用户的活动桌面全局层（真实指针）。
    const none = guardComputerUseInput({ tool: "cua_driver_native__move_cursor", arguments: { x: 10, y: 20 }, scope: bare })
    expect(none.deliver).toBe(false)
    if (none.deliver) throw new Error("unreachable")
    expect(none.code).toBe(COMPUTER_USE_INPUT_ERRORS.CONSENT_REQUIRED)
    expect(none.rule).toBe("global-needs-consent")
    expect(none.combos).toEqual([])         // 坐标入参里没有键字段 ⇒ "没有组合"不是放行理由，作用域判定照走
    // ④ 用户同意 + 可见指示齐了 ⇒ 与 `click` 同一条全局降级路径（不是被静默放行，也不是恒拒）。
    const consented = guardComputerUseInput({ tool: "cua_driver_native__move_cursor", arguments: { x: 10, y: 20 }, scope: widest })
    expect(consented.deliver).toBe(true)
    if (!consented.deliver) throw new Error("unreachable")
    expect(consented.scope).toBe("global")
    // ⑤ 缺可见指示 ⇒ 仍然拒。
    const noIndicator = guardComputerUseInput({ tool: "cua_driver_native__move_cursor", arguments: { x: 10, y: 20 }, scope: { consent: true, indicatorVisible: false } })
    expect(noIndicator.deliver).toBe(false)
    if (noIndicator.deliver) throw new Error("unreachable")
    expect(noIndicator.code).toBe(COMPUTER_USE_INPUT_ERRORS.INDICATOR_REQUIRED)
  })

  test("`ActionTarget` 的 `Desktop` 变体与 legacy `scope` 都**不算**窗口作用域（fail-closed）", () => {
    // `ActionTarget = Window{pid,windowId} | Desktop{displayId}`：**带 target ≠ 带窗口**。
    // Desktop 变体里没有 `window_id`/`pid` ⇒ `inputSurfaceOf` 收不出窗口事实 ⇒ 落到"全局层需同意"，
    // 而不是被判成"有目标就放行"（这正是"带 target 就走窗口作用域"这句话需要修正的地方）。
    const desktopTarget = { x: 10, y: 20, target: { tag: "Desktop", inner: { displayId: "primary" } } }
    expect(inputSurfaceOf(desktopTarget)).toEqual({})
    const plan = guardComputerUseInput({ tool: "cua_driver_native__move_cursor", arguments: desktopTarget, scope: bare })
    expect(plan.deliver).toBe(false)
    if (plan.deliver) throw new Error("unreachable")
    expect(plan.code).toBe("CUA_DESKTOP_SCOPE_REFUSED")
    // 契约里 Deprecated 的扁平 desktop target（`scope?: DesktopScope`）同样不构成窗口事实。
    const legacyScope = guardComputerUseInput({ tool: "cua_driver_native__move_cursor", arguments: { x: 10, y: 20, scope: "desktop" }, scope: bare })
    expect(legacyScope.deliver).toBe(false)
    if (legacyScope.deliver) throw new Error("unreachable")
    expect(legacyScope.code).toBe("CUA_DESKTOP_SCOPE_REFUSED")
    // 反向：legacy 的**扁平 `window_id`** 仍然认（不是把窗口路径整体关掉）。
    expect(inputSurfaceOf({ window_id: 99 })).toEqual({ windowId: "99" })
    expect(inputSurfaceOf({ pid: 99 })).toEqual({ pid: 99 })
  })

  test("`clipboard_write` 一律拒：**同意全局输入 ≠ 同意丢剪贴板**", () => {
    // 契约逐字：ClipboardWriteInput { text?: string; imagePath?: string; filePath?: string; session?: string }
    // ⇒ 没有 `target`/`scope`（不能归到窗口作用域），也不是合成输入（不产生键鼠事件）；
    //   而快照/恢复在这条通道上不成立（读回来只有类型清单 + 可选文本）⇒ 没有可恢复路径 ⇒ 不发。
    // ⚠️ W22-R3（全表审计）：这张表**不再只有一个成员**（补进 11 个同类：`kill_app` / `launch_app` /
    // `replay_trajectory` / `page` …，逐条依据在模块的 `CUA_DRIVER_TOOL_REFUSALS` 与回执 §4）。
    // 下面这份**手抄的独立字面量**是**见证**（与 `cua-input-single-flight.test.ts` 的 `INPUT_TOOLS`
    // 同一条纪律）：加/删一个名字必须显式过本用例，不许靠"从产品导出派生"让断言恒真。
    expect([...CUA_GLOBAL_STATE_TOOL_NAMES].sort().join(",")).toBe([
      "bring_to_front", "browser_download", "browser_prepare", "clipboard_write", "escalate_session",
      "install_ffmpeg", "kill_app", "launch_app", "page", "replay_trajectory", "set_config", "set_window_frame",
    ].sort().join(","))
    expect(cuaGlobalStateToolName("cua_driver_native__clipboard_write")).toBe("clipboard_write")
    // 两张表**互斥**：同一个工具不许既是"合成输入"又是"全局状态变更"（分类只能有一个答案）。
    expect([...CUA_GLOBAL_STATE_TOOL_NAMES].filter(name => (CUA_INPUT_TOOL_NAMES as readonly string[]).includes(name))).toEqual([])
    expect(cuaInputToolName("cua_driver_native__clipboard_write")).toBeUndefined()
    // 三种载荷 + 空入参，在**最宽松**与默认两种作用域下逐条拒：最宽松那一列是重点 ——
    // "用户已同意全局输入、并且有可见指示"也**不**能把这条通道放行。
    for (const args of [{ text: "agent 写入的内容" }, { imagePath: "/tmp/x.png" }, { filePath: "/tmp/x.txt" }, {}]) {
      for (const scope of [bare, widest]) {
        const plan = guardComputerUseInput({ tool: "cua_driver_native__clipboard_write", arguments: args, scope })
        expect(plan.deliver).toBe(false)
        if (plan.deliver) throw new Error("unreachable")
        expect(plan.code).toBe(COMPUTER_USE_INPUT_ERRORS.CLIPBOARD_WRITE_REFUSED)
        expect(plan.rule).toBe("clipboard-not-restorable")
        expect(plan.reason).toContain("剪贴板")
        expect(plan.advice).toContain("type_text")
        expect(plan.combos).toEqual([])
      }
    }
  })

  test("`clipboard_read` 是**隐私通道**：与写侧同一条驱动通道、同样无 target，但读走即泄漏 ⇒ 一律不读", () => {
    // 写侧（`clipboard_write`）的理由是"没有可恢复路径"；读侧的理由更硬：**读是不可撤回的泄漏**。
    // 契约 `ClipboardReadOutput { supported; types; text?; privacySensitive; contentRedactedFromTelemetry }`：
    // `privacySensitive:true` 且明写"不入遥测"（那是驱动对"能不能留"的回答，不是"能不能读"）；
    // `ClipboardReadInput` 里没有 `target`/`scope` ⇒ 没有"窗口作用域"这个安全档位可给。
    // ⚠️ W22-R3（全表审计）：读侧这条通道多了两个同类成员（`get_desktop_state` 整屏像素、
    // `browser_set_input_files` 用户本机文件进页面）。手抄字面量＝见证，同写侧那张表。
    expect([...CUA_PRIVACY_READ_TOOL_NAMES].sort().join(",")).toBe(["browser_set_input_files", "clipboard_read", "get_desktop_state"].sort().join(","))
    expect(cuaPrivacyReadToolName("cua_driver_native__clipboard_read")).toBe("clipboard_read")
    // 三张表**两两互斥**：同一个工具只允许有一个分类答案（写侧、读侧、合成输入各一张）。
    expect([...CUA_PRIVACY_READ_TOOL_NAMES].filter(name => (CUA_INPUT_TOOL_NAMES as readonly string[]).includes(name))).toEqual([])
    expect([...CUA_PRIVACY_READ_TOOL_NAMES].filter(name => (CUA_GLOBAL_STATE_TOOL_NAMES as readonly string[]).includes(name))).toEqual([])
    expect(cuaInputToolName("cua_driver_native__clipboard_read")).toBeUndefined()
    expect(cuaGlobalStateToolName("cua_driver_native__clipboard_read")).toBeUndefined()
    // 三种载荷（要文本 / 只要类型 / 空入参）在最宽松与默认两种作用域下**逐条**拒：
    // "用户已同意全局输入 + 有可见指示"也不放行；`includeText:false` **不是**安全降级
    // （`types` 仍会说出用户复制的是文本/图片/文件）。
    for (const args of [{ includeText: true }, { includeText: false }, {}]) {
      for (const scope of [bare, widest]) {
        const plan = guardComputerUseInput({ tool: "cua_driver_native__clipboard_read", arguments: args, scope })
        expect(plan.deliver).toBe(false)
        if (plan.deliver) throw new Error("unreachable")
        expect(plan.code).toBe(COMPUTER_USE_INPUT_ERRORS.CLIPBOARD_READ_REFUSED)
        expect(plan.rule).toBe("clipboard-read-not-disclosable")
        expect(plan.reason).toContain("剪贴板")
        expect(plan.reason).toContain("privacySensitive")
        expect(plan.advice).toContain("用户自己")
        expect(plan.combos).toEqual([])
      }
    }
  })
})

describe("W22 ③ 快照与恢复（含异常退出路径）", () => {
  test("会话前快照、会话中假桌面被改动、会话结束无条件恢复原值", async () => {
    const desktop = fakeDesktop()
    const session = await openComputerUseSession({ env: env(), run: desktop.runner })
    expect(session.snapshot.readableCount).toBe(A11Y_SNAPSHOT_KEYS.length)
    expect(session.snapshot.entries.find(entry => entry.id === "screen-reader-enabled")!.value).toBe("false")
    // 模拟"agent 的输入把用户的屏幕阅读器打开了"（真机上就是 Super+Alt+S 的效果）。
    await desktop.runner(["gsettings", "set", "org.gnome.desktop.a11y.applications", "screen-reader-enabled", "true"], { env: env(), timeoutMs: 5000 })
    expect(desktop.get(SCREEN_READER)).toBe("true")
    const report = await closeComputerUseSession(session, { env: env(), run: desktop.runner })
    expect(desktop.get(SCREEN_READER)).toBe("false")      // 恢复
    expect(report.restored).toContain("screen-reader-enabled")
    expect(report.failed).toEqual([])
    expect(report.note).toContain("恢复")
  })

  test("没动过也要留记录：'检查过这些键、未改动'", async () => {
    const desktop = fakeDesktop()
    const session = await openComputerUseSession({ env: env(), run: desktop.runner })
    const report = await closeComputerUseSession(session, { env: env(), run: desktop.runner })
    expect(report.changed).toBe(false)
    expect(report.restored).toEqual([])
    expect(report.entries.every(entry => entry.action === "unchanged")).toBe(true)
    expect(report.note).toContain("没有被改动")
    // 快照正文本身也带"检查过哪些键"。
    expect(session.snapshot.entries.map(entry => entry.id)).toEqual(A11Y_SNAPSHOT_KEYS.map(key => key.id))
    expect(session.snapshot.note).toContain(`已检查 ${String(A11Y_SNAPSHOT_KEYS.length)} 个键`)
  })

  test("读不到的键如实报告，不假装没动过；恢复时逐条报 skipped", async () => {
    const desktop = fakeDesktop()
    const partial: CommandRunner = async (argv, options) => {
      if (argv[0] === "gsettings" && argv[2] === "org.gnome.desktop.a11y.keyboard") return { code: 1, stdout: "", stderr: "dconf 不可写" }
      return await desktop.runner(argv, options)
    }
    const session = await openComputerUseSession({ env: env(), run: partial })
    expect(session.snapshot.readableCount).toBeLessThan(A11Y_SNAPSHOT_KEYS.length)
    expect(session.snapshot.note).toContain("读不到")
    const report = await restoreDesktopSettings(session.snapshot, { env: env(), run: partial })
    expect(report.entries.filter(entry => entry.id === "stickykeys-enable").every(entry => entry.action === "skipped")).toBe(true)
    expect(report.entries.filter(entry => entry.action === "skipped").every(entry => (entry.error ?? "").includes(COMPUTER_USE_INPUT_ERRORS.SNAPSHOT_UNAVAILABLE))).toBe(true)
  })

  test("恢复失败必须报 RESTORE_FAILED（不把写不回去说成恢复成功）", async () => {
    const desktop = fakeDesktop({ [SCREEN_READER]: "false" })
    const session = await openComputerUseSession({ env: env(), run: desktop.runner })
    await desktop.runner(["gsettings", "set", "org.gnome.desktop.a11y.applications", "screen-reader-enabled", "true"], { env: env(), timeoutMs: 5000 })
    const failing: CommandRunner = async (argv, options) => argv[0] === "gsettings" && argv[1] === "set" ? { code: 1, stdout: "", stderr: "只读文件系统" } : await desktop.runner(argv, options)
    const report = await closeComputerUseSession(session, { env: env(), run: failing })
    expect(report.failed).toContain("screen-reader-enabled")
    expect(report.note).toContain(COMPUTER_USE_INPUT_ERRORS.RESTORE_FAILED)
  })

  test("异常退出路径：不做 close 也要能恢复（调用方在进程收尾里只拿到 snapshot）", async () => {
    const desktop = fakeDesktop()
    const session = await openComputerUseSession({ env: env(), run: desktop.runner })
    await desktop.runner(["gsettings", "set", "org.gnome.desktop.a11y.applications", "screen-reader-enabled", "true"], { env: env(), timeoutMs: 5000 })
    // 异常路径：会话对象还在，直接按快照恢复（这就是 ctx.effect 清理里做的那一件事）。
    const report = await restoreDesktopSettings(session.snapshot, { env: env(), run: desktop.runner })
    expect(desktop.get(SCREEN_READER)).toBe("false")
    expect(report.restored).toContain("screen-reader-enabled")
  })
})

describe("W22 ④ 可见指示", () => {
  test("a11y 开着而状态图标被关掉 ⇒ 把图标打开并记账（结束写回 false）", async () => {
    const desktop = fakeDesktop({ [SCREEN_READER]: "true" })   // 用户自己开着读屏、但看不到状态图标
    const session = await openComputerUseSession({ env: env(), run: desktop.runner, projection: true })
    expect(session.indicator.changedVisibility).toBe(true)
    expect(desktop.get(STATUS_ICON)).toBe("true")
    expect(session.indicator.visible).toBe(true)
    const report = await closeComputerUseSession(session, { env: env(), run: desktop.runner })
    expect(desktop.get(STATUS_ICON)).toBe("false")             // 会话前就是 false，写回去
    expect(report.indicator.projection).toBe(false)
  })

  test("没有 a11y 功能开着时：不误改可见性，靠桌面通知 + 状态投影构成可见指示", async () => {
    const desktop = fakeDesktop()
    const indicator = await enforceVisibleIndicator({ snapshot: await captureDesktopSettingsSnapshot({ env: env(), run: desktop.runner }), projection: true, env: env(), run: desktop.runner })
    expect(indicator.a11yStatusIcon).toBe("not-needed")
    expect(indicator.changedVisibility).toBe(false)
    expect(indicator.notification).toBe("sent")
    expect(indicator.visible).toBe(true)
    expect(desktop.commandsTo("notify-send")).toHaveLength(1)
  })

  test("通知发不出去（无 notify-send）⇒ 如实标 unavailable；没有投影时用户其实看不到", async () => {
    const desktop = fakeDesktop()
    const noNotify: CommandRunner = async (argv, options) => argv[0] === "notify-send" ? { code: 1, stdout: "", stderr: "spawn notify-send ENOENT" } : await desktop.runner(argv, options)
    const indicator = await enforceVisibleIndicator({ snapshot: await captureDesktopSettingsSnapshot({ env: env(), run: noNotify }), projection: false, env: env(), run: noNotify })
    expect(indicator.notification).toBe("unavailable")
    expect(indicator.visible).toBe(false)
    expect(indicator.note).toContain("用户看不到")
  })
})

describe("W22 ⑥ 产品面（plugin.ts 消费点）：拒绝发生在**驱动之前**，会话结束恢复快照", () => {
  /**
   * 驱动替身：`hotkey` 工具体真的会去发全局按键（就是真实驱动做的事）。
   * `mouseButtonModifier` 是**这台机器**的形态（假桌面的 `mouse-button-modifier` 读数）；
   * 缺省 ＝ 本机形态 `'<Super>'`。要读另一种形态就传 `MACHINE_ALT`（见 `describe("⑥ …")` 的产品路径用例）。
   */
  const bootProduct = async (mouseButtonModifier: string = MACHINE_SUPER) => {
    const workspace = root!
    const ctx = new Context() as any
    await ctx.plugin(JobsLocal as never)
    await ctx.plugin(SystemPrompt as never, { personaPrefix: "", personaSuffix: "" } as never)
    await ctx.plugin(ToolRuntime as never)
    const desktop = fakeDesktop({ [MACHINE_KEY]: mouseButtonModifier })
    const routes = new Map<string, (request: Request) => Promise<Response>>()
    const definitions = new Map<string, { handler: (invocation: any) => any }>()
    const namespaces = new Set<string>()
    ctx.provide("connection", { fetch: { register: (entry: { path: string; fetch: (request: Request) => Promise<Response> }) => { routes.set(entry.path, entry.fetch); return () => routes.delete(entry.path) } } })
    ctx.provide("settings", { register: (ns: string) => { namespaces.add(ns); return () => namespaces.delete(ns) }, describe: () => [...namespaces].map(ns => ({ ns, user: undefined, revision: 1, value: {} })), mutate: async () => undefined, replace: async () => undefined })
    ctx.provide("scene", { forSession: () => ({ scene: { snapshot: async (sceneId: string) => ({ sceneId, revision: 0, entities: [] }) }, list: async () => [] }) })
    ctx.provide("sim", { forSession: () => ({ listWorlds: async () => [], dispose: async () => {} }), has: () => false, sessions: () => [] })
    ctx.provide("sessions", { flush: async () => undefined })
    ctx.provide("sessionController", { resolveAgent: async (id: unknown) => ({ agent: { session: { header: { id: String(id) } } } }) })
    ctx.provide("sessionQuery", { observeSession: async () => undefined })
    ctx.provide("commands", {
      register: (definition: { name: string; handler: (invocation: any) => any }) => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) },
      execute: async (agent: unknown, line: string) => {
        const match = /^\/([a-zA-Z0-9_]+)([\s\S]*)$/.exec(line)
        const definition = match ? definitions.get(match[1]!) : undefined
        if (!definition) return undefined
        try { return { commandId: "w22", result: await definition.handler({ commandId: "w22", agent, rawInput: match![2]!, attachments: [], signal: new AbortController().signal }) } }
        catch (error) { return { commandId: "w22", result: { kind: "error", text: error instanceof Error ? error.message : String(error) } } }
      },
    })
    ctx.provide("attachments", { saveImage: async () => ({}), readImage: async () => ({ data: new Uint8Array() }) })
    const agent = { id: SessionId("w22-session"), ctx: createScope(ctx, { session: "w22-session" }).ctx, steer() {}, inject() {}, session: { id: "w22-session", header: { id: "w22-session" }, snapshotEvents: () => [] } } as never
    ctx.provide("agents", { get: (id: unknown) => String(id) === "w22-session" ? agent : undefined })
    const installerIsolation = isolateProviderInstaller(workspace)
    try {
      const { apply } = await import("../src/plugin.ts")
      await apply(ctx as never, { captureRoot: join(workspace, "captures"), recordingRoot: join(workspace, "recordings"), computerUse: { runner: desktop.runner } } as never)
      installerIsolation.assertCalled()
    } finally { installerIsolation.restore() }
    // 驱动替身注册成与真实驱动同名的工具：`hotkey` 的工具体**真的会去发全局按键**（就是真实驱动做的事）。
    // `bodyCalls` 记下工具体被调用了几次 —— 这是"产品路径到底有没有走到驱动"的唯一直接证据。
    // 返回值类型写死成 `{ok:boolean}`：`defineTool` 的 `execute` 要求 `Promise<JsonValue>`，
    // 用 `unknown` 会被 tsc 判成不可赋值（替身只返回这个形状，不需要更宽的签名）。
    const bodyCalls: unknown[] = []
    const registerTool = (name: string, body: () => Promise<{ ok: boolean }> | { ok: boolean }) => ctx.tools.register(defineTool({
      name, description: "driver stand-in", parameters: {},
      output: { schema: { type: "json" }, render: (_args: unknown, value: unknown) => [{ type: "text", text: JSON.stringify(value) }] },
      execute: async (invocation: unknown) => { bodyCalls.push(invocation); return await body() },
    }))
    const registerHotkey = (sendKeys: boolean) => registerTool("cua_driver_native__hotkey", async () => { if (sendKeys) await desktop.legacyGlobalKey("Super+Alt+s"); return { ok: true } })
    let callSeq = 0
    const call = async (args: unknown, tool = "cua_driver_native__hotkey"): Promise<{ isError: boolean; error?: { message?: string } }> =>
      await ctx.get("tools").execute({ callId: ToolCallId(`w22-${String(++callSeq)}`), name: tool, arguments: args, agent, signal: new AbortController().signal }) as never
    const end = async () => {
      const definition = definitions.get("ui_computer_use_end")!
      return await definition.handler({ commandId: "w22-end", agent, rawInput: "{}", attachments: [], signal: new AbortController().signal }) as { kind: string; text: string }
    }
    /** 用户显式同意/收回全局层输入（`ui_computer_use_consent`：同意只能由用户动作产生，不由模型自称）。 */
    const consent = async (value: boolean) => {
      const definition = definitions.get("ui_computer_use_consent")!
      return await definition.handler({ commandId: "w22-consent", agent, rawInput: JSON.stringify({ consent: value, reason: "残留口子④回归" }), attachments: [], signal: new AbortController().signal }) as { kind: string; text: string }
    }
    const dispose = async () => { try { await ctx.fiber.dispose() } finally { await rm(workspace, { recursive: true, force: true }) } }
    return { call, end, consent, dispose, desktop, registerTool, registerHotkey, bodyCalls }
  }

  test("修复后：`Super+Alt+S` 走产品路径被拒，驱动工具体一次都没跑 ⇒ 屏幕阅读器保持 false", async () => {
    process.env.LYAPUNOV_SIM_ENGINE = "mujoco"
    const host = await bootProduct()
    try {
      host.registerHotkey(true)
      const refused = await host.call({ target: { window_id: 4242 }, keys: ["Super+Alt+s"] })
      expect(refused.isError).toBe(true)
      expect(refused.error?.message ?? "").toContain(COMPUTER_USE_INPUT_ERRORS.A11Y_TOGGLE)
      expect(host.desktop.commandsTo("xdotool")).toEqual([])     // 命令根本没发出去
      expect(host.desktop.get(SCREEN_READER)).toBe("false")       // 用户投诉的副作用没有发生
    } finally { await host.dispose() }
  })

  test("负对照（现状）：同一个动作绕过守卫直接发全局按键 ⇒ 屏幕阅读器被打开（精确变红）", async () => {
    const host = await bootProduct()
    try {
      host.registerHotkey(true)
      // 这正是修复前的产品路径：工具体无条件把驱动请求发到用户的活动会话。
      await host.desktop.legacyGlobalKey("Super+Alt+s")
      expect(host.desktop.get(SCREEN_READER)).toBe("true")
      expect(host.desktop.commandsTo("xdotool")).toHaveLength(1)
    } finally { await host.dispose() }
  })

  test("产品面负对照（W22 验收 §6.1 第 1 条要求的补测）：摘掉键判定 ⇒ **工具体真的被调用**且副作用发生", async () => {
    // W22 验收查出的问题：原来那条"负对照（现状）"用例**从未调用工具体**，只直接调了假桌面的
    // `legacyGlobalKey` ⇒ 它断言的是测试替身自己的行为，不是"修复前的产品路径"。
    // 这里改成真的走 `tools/execute` 产品路径，只把**键判定**这一层摘掉（`globalShortcutVerdict` 桩成"不拒"）：
    //   · 桩在场 ⇒ 走完中间件、工具体被调用、假桌面上的屏幕阅读器被打开；
    //   · 桩撤掉 ⇒ 同一条调用在产品路径上被拒、工具体 0 次、屏幕阅读器保持 false。
    // 两次读数合起来才证明"拒绝发生在驱动之前"这句话在**产品路径**上成立。
    process.env.LYAPUNOV_SIM_ENGINE = "mujoco"
    const guardModule = await import("../src/computer-use-input.ts")
    const host = await bootProduct()
    const neutralize = spyOn(guardModule, "shortcutVerdictForTool").mockImplementation(() => ({ refused: false }))
    try {
      host.registerHotkey(true)
      const withGuardRemoved = await host.call({ target: { window_id: 4242 }, keys: ["Super+Alt+s"] })
      expect(host.bodyCalls).toHaveLength(1)                       // ← 工具体真的被调用了（原用例缺的这一步）
      expect(withGuardRemoved.isError).toBe(false)
      expect(host.desktop.get(SCREEN_READER)).toBe("true")         // 副作用真的会发生
      expect(host.desktop.commandsTo("xdotool")).toHaveLength(1)
      neutralize.mockRestore()
      // 同一台宿主、同一份入参，只是把守卫放回去：
      const withGuard = await host.call({ target: { window_id: 4242 }, keys: ["Super+Alt+s"] })
      expect(withGuard.isError).toBe(true)
      expect(withGuard.error?.message ?? "").toContain(COMPUTER_USE_INPUT_ERRORS.A11Y_TOGGLE)
      expect(host.bodyCalls).toHaveLength(1)                       // 没有第二次调用：守卫在驱动之前
      expect(host.desktop.commandsTo("xdotool")).toHaveLength(1)   // 也没有第二条命令
    } finally {
      neutralize.mockRestore()
      await host.dispose()
    }
  })

  test("一号发现的产品面：`press_key {key,modifiers}` 走产品路径也被拒（驱动工具体 0 次）", async () => {
    process.env.LYAPUNOV_SIM_ENGINE = "mujoco"
    const host = await bootProduct()
    try {
      host.registerHotkey(true)
      // 这一次走的是 `press_key` 的**一等参数** `modifiers`，不是 `keys` 数组的写法。
      const refused = await host.call({ key: "s", modifiers: ["super", "alt"], target: { window_id: 4242 } }, "cua_driver_native__press_key")
      expect(refused.isError).toBe(true)
      expect(refused.error?.message ?? "").toContain(COMPUTER_USE_INPUT_ERRORS.A11Y_TOGGLE)
      expect(host.bodyCalls).toHaveLength(0)
      expect(host.desktop.get(SCREEN_READER)).toBe("false")
    } finally { await host.dispose() }
  })

  test("被拒的输入**不开会话**：不动桌面设置、不发通知、也不留一个不会被自动结束的会话", async () => {
    // W22 验收 §3.3：旧实现把 `global-needs-consent`/`global-needs-indicator` 也算作"要开会话"，
    // 于是注定被拒的输入仍然 9 次 `gsettings get` + 一条 notify-send，而且那个会话没有空闲计时器。
    process.env.LYAPUNOV_SIM_ENGINE = "mujoco"
    const host = await bootProduct()
    try {
      host.registerHotkey(true)
      // ① 无窗口目标 ⇒ `global-needs-consent`（旧实现会在这里开会话）。
      const noTarget = await host.call({ keys: ["a"] })
      expect(noTarget.isError).toBe(true)
      expect(noTarget.error?.message ?? "").toContain(COMPUTER_USE_INPUT_ERRORS.CONSENT_REQUIRED)
      expect(host.desktop.commandsTo("gsettings")).toEqual([])      // 一次设置都没读、没写
      expect(host.desktop.commandsTo("notify-send")).toEqual([])    // 也没有"正在控制输入"的假通知
      expect(host.bodyCalls).toHaveLength(0)
      // ② 全局快捷键被拒 —— 同样一个字节都不动。
      const combo = await host.call({ target: { window_id: 4242 }, keys: ["Super+Alt+s"] })
      expect(combo.isError).toBe(true)
      expect(host.desktop.commandsTo("gsettings")).toEqual([])
      expect(host.desktop.commandsTo("notify-send")).toEqual([])
      // ③ `ui_computer_use_end` 如实回答"没有会话可结束"。
      const receipt = await host.end()
      const body = JSON.parse(receipt.text) as { ended: boolean; report: unknown }
      expect(body.ended).toBe(false)
      expect(body.report).toBeNull()
      // ④ 反向对照：**允许**的输入照旧开会话（上一条不是"会话彻底开不出来了"）。
      const allowed = await host.call({ target: { window_id: 4242 }, keys: ["ctrl+c"] })
      expect(allowed.isError).toBe(false)
      expect(host.desktop.commandsTo("gsettings").filter(call => call[1] === "get")).toHaveLength(A11Y_SNAPSHOT_KEYS.length + 1)   // +1 ＝ 机器状态那一条（`mouse-button-modifier`）
      expect(host.desktop.commandsTo("notify-send")).toHaveLength(1)
    } finally { await host.dispose() }
  })

  test("会话开始快照、结束恢复：外部改动的 a11y 键被写回，回执里带「检查过/恢复了什么」", async () => {
    process.env.LYAPUNOV_SIM_ENGINE = "mujoco"
    const host = await bootProduct()
    try {
      // 允许的输入（带窗口目标）会开一次 computer-use 会话：先快照（这里全是 gsettings get）。
      host.registerHotkey(false)   // 这个替身只走"允许"那一条，不发任何有害按键
      const allowed = await host.call({ target: { window_id: 4242 }, keys: ["ctrl+c"] })
      expect(allowed.isError).toBe(false)
      expect(host.desktop.commandsTo("gsettings").filter(call => call[1] === "get")).toHaveLength(A11Y_SNAPSHOT_KEYS.length + 1)   // +1 ＝ 机器状态那一条（`mouse-button-modifier`）
      // 会话期间桌面被改动（真机上就是某次合成按键触发了全局快捷键）。
      await host.desktop.runner(["gsettings", "set", "org.gnome.desktop.a11y.applications", "screen-reader-enabled", "true"], { env: {}, timeoutMs: 5000 })
      expect(host.desktop.get(SCREEN_READER)).toBe("true")
      const receipt = await host.end()
      expect(receipt.kind).toBe("success")
      const body = JSON.parse(receipt.text) as { ended: boolean; report: { restored: string[]; failed: string[]; note: string } }
      expect(body.ended).toBe(true)
      expect(body.report.restored).toContain("screen-reader-enabled")
      expect(body.report.failed).toEqual([])
      expect(host.desktop.get(SCREEN_READER)).toBe("false")       // 无条件恢复
      expect(body.report.note.length).toBeGreaterThan(5)
    } finally { await host.dispose() }
  })

  test("W22-R：`clipboard_write` 走产品路径被拒 —— 被拒的输入**不开会话**、用户剪贴板原封不动", async () => {
    // "改前/改后用户能观察到什么"的产品面读数：改前这条调用在漏斗里 `return next()`（原样交给驱动），
    // 于是工具体真的会写剪贴板；改后它在**第一判**就被拒，工具体 0 次。
    process.env.LYAPUNOV_SIM_ENGINE = "mujoco"
    const host = await bootProduct()
    try {
      const clipboard = { value: "用户刚复制的密码" }        // 假剪贴板：用户能观察到的那一份状态
      const writeClipboard = () => { clipboard.value = "agent 写入的内容"; return { ok: true } }
      host.registerTool("cua_driver_native__clipboard_write", writeClipboard)
      const refused = await host.call({ text: "agent 写入的内容" }, "cua_driver_native__clipboard_write")
      expect(refused.isError).toBe(true)
      expect(refused.error?.message ?? "").toContain(COMPUTER_USE_INPUT_ERRORS.CLIPBOARD_WRITE_REFUSED)
      expect(host.bodyCalls).toHaveLength(0)                      // 驱动工具体一次都没跑
      expect(clipboard.value).toBe("用户刚复制的密码")             // ⇒ 用户的剪贴板没有被替换
      expect(host.desktop.commandsTo("gsettings")).toEqual([])    // 也不开会话：没读没写桌面设置
      expect(host.desktop.commandsTo("notify-send")).toEqual([])  // 更没有那条"正在控制输入"的假通知
      // 见证是活的：同一个假剪贴板在**允许**的工具真的执行时会变（否则上一条断言可能只是因为见证是死的）。
      host.registerTool("cua_driver_native__hotkey", writeClipboard)
      expect((await host.call({ target: { window_id: 4242 }, keys: ["ctrl+c"] })).isError).toBe(false)
      expect(clipboard.value).toBe("agent 写入的内容")
    } finally { await host.dispose() }
  })

  test("W22-R2：`clipboard_read` 走产品路径被拒 —— 工具体 0 次、剪贴板**一次都没被读**、内容没进任何回执", async () => {
    // "改前/改后用户能观察到什么"的产品面读数。改前这个名字**不在漏斗的任何一张表里** ⇒ `return next()`
    // ⇒ 工具体真的会读用户剪贴板，内容原样回到调用方（并进模型上下文）；改后在**第一判**（第二次判定
    // 之前、开会话之前）就被拒，工具体 0 次、readCalls 0 次。
    process.env.LYAPUNOV_SIM_ENGINE = "mujoco"
    const host = await bootProduct()
    try {
      /** 假剪贴板：`text` 是用户能观察到的那一份状态；`readCalls` 是"到底有没有人读过它"的唯一直接证据。 */
      const clipboard = { value: "用户刚复制的密码 hunter2", readCalls: 0 }
      const readClipboard = () => { clipboard.readCalls += 1; return { ok: true, text: clipboard.value, types: ["text/plain"], privacySensitive: true } }
      host.registerTool("cua_driver_native__clipboard_read", readClipboard)
      const refused = await host.call({ includeText: true }, "cua_driver_native__clipboard_read")
      expect(refused.isError).toBe(true)
      expect(refused.error?.message ?? "").toContain(COMPUTER_USE_INPUT_ERRORS.CLIPBOARD_READ_REFUSED)
      // 拒绝回执里**不能**带上剪贴板内容（否则拒绝本身就成了泄露出路）。
      expect(JSON.stringify(refused)).not.toContain("hunter2")
      expect(host.bodyCalls).toHaveLength(0)                       // 驱动工具体一次都没跑
      expect(clipboard.readCalls).toBe(0)                          // ⇒ 用户的剪贴板一次都没被读
      expect(host.desktop.commandsTo("gsettings")).toEqual([])     // 也不开会话：没读没写桌面设置
      expect(host.desktop.commandsTo("notify-send")).toEqual([])   // 更没有那条"正在控制输入"的假通知
      // 见证是活的：同一个假读者的内容确实会**回到调用方**（否则上一条断言可能只是因为见证是死的）。
      // `hotkey` 是允许的工具，走完守卫（窗口目标）后真的执行 —— 用它证明"读得到"这件事本身是真的。
      host.registerTool("cua_driver_native__hotkey", readClipboard)
      const allowed = await host.call({ target: { window_id: 4242 }, keys: ["ctrl+c"] })
      expect(allowed.isError).toBe(false)
      expect(clipboard.readCalls).toBe(1)
    } finally { await host.dispose() }
  })

  test("VERIFY2 残留口子④ 产品面：用户同意后，第一次全局输入能走通（旧实现在这里永久全哑）", async () => {
    // 旧行为：`scope()` 的 `indicatorVisible` **只可能**来自会话，而会话只在首个输入被放行之后才开
    // ⇒ 用户已同意的全局输入仍被 `global-needs-indicator` 拒 ⇒ 会话永远开不出来 ⇒ computer-use 输入全哑。
    // 现在：第一判把这条标成 `provisional`，先开会话（那正是点亮指示的动作），第二判用会话里
    // **真实**的指示状态再判一次。判据一条都没放宽：第二判仍是同一个 `planComputerUseInput`。
    process.env.LYAPUNOV_SIM_ENGINE = "mujoco"
    const host = await bootProduct()
    try {
      host.registerHotkey(false)   // 替身不发任何按键：本用例只验"判定链能不能走通"
      // ① 没同意：依旧是**终局**的 `global-needs-consent`，且一个字节都不动桌面。
      const before = await host.call({ keys: ["a"] })
      expect(before.isError).toBe(true)
      expect(before.error?.message ?? "").toContain(COMPUTER_USE_INPUT_ERRORS.CONSENT_REQUIRED)
      expect(host.desktop.commandsTo("gsettings")).toEqual([])
      expect(host.desktop.commandsTo("notify-send")).toEqual([])
      // ② 用户显式同意（用户动作，不由模型自称）。
      await host.consent(true)
      // ③ 同一个全局输入：会话开出来（9 次快照 get + 一次可见指示通知），第二判用会话里**真实**的
      //    指示状态 ⇒ 放行。旧实现这里被 `global-needs-indicator` 拒 ⇒ 会话永远开不出来 ⇒ 全哑。
      const global = await host.call({ keys: ["a"] })
      expect(global.isError).toBe(false)
      expect(host.bodyCalls).toHaveLength(1)                         // 真的走到了驱动那一层
      expect(host.desktop.commandsTo("gsettings").filter(call => call[1] === "get")).toHaveLength(A11Y_SNAPSHOT_KEYS.length + 1)   // +1 ＝ 机器状态那一条（`mouse-button-modifier`）
      expect(host.desktop.commandsTo("notify-send")).toHaveLength(1) // 可见指示真的点亮了（不是"嘴上说可见"）
      expect(host.desktop.commandsTo("xdotool")).toEqual([])         // 全程没有向活桌面发过任何键
      // ④ 契约 tagged 形状的窗口目标：现在也能走通（判据要求的"consent:true 的安全输入必须能走通"）。
      const tagged = await host.call({ keys: ["b"], target: { tag: "Window", inner: { pid: 9, windowId: 7 } } })
      expect(tagged.isError).toBe(false)
      // ⑤ 收尾：结束会话，把可能被触碰的桌面设置按快照恢复。
      const receipt = await host.end()
      expect(JSON.parse(receipt.text).ended).toBe(true)
    } finally { await host.dispose() }
  })

  test("残留口子⑤ 产品面（形态 A ＝ 本机 `'<Super>'`）：`drag {modifier:[\"alt\"]}` 照旧发得出去（本机形态不许被改红）", async () => {
    // 产品路径的 scope() 逐字是 `{consent, indicatorVisible, sessionOpen}`（`plugin.ts:286/325`），
    // **没有**机器状态字段 ⇒ 第一判必然走"还没读过"那一支：fail-closed + `provisional`。
    // 见到 `provisional` ⇒ 开会话（会话快照里读一次 `mouse-button-modifier`）⇒ 第二判拿**实测**读数重判：
    // 本机读到 `'<Super>'` ⇒ `alt` 不是"移动窗口"的修饰键 ⇒ 放行。⇒ 本机产品路径行为不变。
    process.env.LYAPUNOV_SIM_ENGINE = "mujoco"
    const host = await bootProduct(MACHINE_SUPER)
    try {
      host.registerTool("cua_driver_native__drag", () => ({ ok: true }))
      const delivered = await host.call({ fromX: 1, fromY: 1, toX: 2, toY: 2, modifier: ["alt"], target: { window_id: 4242 } }, "cua_driver_native__drag")
      expect(delivered.isError).toBe(false)
      expect(host.bodyCalls).toHaveLength(1)                          // 真的走到了驱动那一层
      // 会话开出来了一次：九键快照 + **多读一次**机器状态；这一次是 `provisional` 换来的（放行本来也会开会话）。
      expect(host.desktop.commandsTo("gsettings").filter(call => call[1] === "get")).toHaveLength(A11Y_SNAPSHOT_KEYS.length + 1)
      const get = host.desktop.commandsTo("gsettings").filter(call => call[1] === "get").map(call => `${call[2] ?? ""} ${call[3] ?? ""}`)
      expect(get).toContain(MACHINE_KEY)
      expect(host.desktop.commandsTo("gsettings").filter(call => call[1] === "set")).toEqual([])   // 机器状态**只读**：一次都没写
      expect(host.desktop.commandsTo("xdotool")).toEqual([])          // 没有向活桌面发过任何键
      await host.end()
    } finally { await host.dispose() }
  })

  test("残留口子⑤ 产品面（形态 B ＝ `'<Alt>'`）：同一次拖动被拒、驱动工具体 0 次（改前它会走到驱动）", async () => {
    process.env.LYAPUNOV_SIM_ENGINE = "mujoco"
    const host = await bootProduct(MACHINE_ALT)
    try {
      host.registerTool("cua_driver_native__drag", () => ({ ok: true }))
      const refused = await host.call({ fromX: 1, fromY: 1, toX: 2, toY: 2, modifier: ["alt"], target: { window_id: 4242 } }, "cua_driver_native__drag")
      expect(refused.isError).toBe(true)
      expect(refused.error?.message ?? "").toContain(COMPUTER_USE_INPUT_ERRORS.DRAG_WINDOW_MOVE)   // CUA_DRAG_WINDOW_MOVE_REFUSED
      // 产品路径的报错文案是 `${code}: ${reason}${advice}`（`plugin.ts` 的 `refuse()`，不含 rule 名——
      // rule 进的是 `computerUseFacts().refusals`）⇒ 这里断言"理由里带这次**实测**的读数"。
      expect(refused.error?.message ?? "").toContain("mouse-button-modifier")
      expect(refused.error?.message ?? "").toContain(MACHINE_ALT)     // 理由里带**这次实测**的读数
      expect(refused.error?.message ?? "").toContain("移动")
      expect(host.bodyCalls).toHaveLength(0)                          // 一个字节都没到驱动
      expect(host.desktop.commandsTo("xdotool")).toEqual([])
      // ⚠️ 如实记下这条路径的代价（不是"应该没有"）：形态 B 下**第一次**拖动会先开会话（读机器状态）——
      // 那一次多了一条"Lyapunov 正在控制输入"的通知，而这次输入最终被拒。之后同一进程里读数已在，
      // 第一判就是终局 ⇒ 不再开会话。（要消掉这一次，只需产品侧把读数一并传进 scope；见回执。）
      expect(host.desktop.commandsTo("notify-send")).toHaveLength(1)
      expect(host.desktop.commandsTo("gsettings").filter(call => call[1] === "get")).toHaveLength(A11Y_SNAPSHOT_KEYS.length + 1)
      expect(host.desktop.commandsTo("gsettings").filter(call => call[1] === "set")).toEqual([])
      await host.end()
    } finally { await host.dispose() }
  })
})

describe("W22 ⑤ 真实因果链：同一动作修复前/后的前后对照（负对照必须精确变红）", () => {
  test("负对照（现状/Lead 复现路径）：直接发全局 xdotool → 屏幕阅读器被打开，正是用户投诉的副作用", async () => {
    const desktop = fakeDesktop()
    expect(desktop.get(SCREEN_READER)).toBe("false")
    // 这一行就是产品现状：合成按键无作用域地发进用户的活动会话。
    await desktop.legacyGlobalKey("Super+Alt+s")
    expect(desktop.get(SCREEN_READER)).toBe("true")            // ← 精确变红：副作用真的会发生
    expect(desktop.commandsTo("xdotool")).toHaveLength(1)
  })

  test("修复后：同一个请求走守卫 → 一个 xdotool 都不发，屏幕阅读器保持 false", async () => {
    const desktop = fakeDesktop()
    const plan = guardComputerUseInput({ tool: "cua_driver_native__hotkey", arguments: { keys: ["Super+Alt+s"] }, scope: { consent: true, indicatorVisible: true } })
    expect(plan.deliver).toBe(false)
    if (plan.deliver) throw new Error("unreachable")
    expect(plan.code).toBe(COMPUTER_USE_INPUT_ERRORS.A11Y_TOGGLE)
    // 守卫不给"交付计划"时，调用方没有可执行的 argv —— 用它证明"命令根本没发出去"。
    expect(desktop.commandsTo("xdotool")).toEqual([])
    expect(desktop.get(SCREEN_READER)).toBe("false")
    expect(plan.combos).toEqual(["Super+Alt+s"])   // 被拒的是哪一个组合，回执里是可核对的
  })

  test("端到端：窗口作用域的普通点击照常交付；同一路径下 Super+Alt+S 被拒且无副作用", async () => {
    const desktop = fakeDesktop()
    const click = guardComputerUseInput({ tool: "cua_driver_native__click", arguments: { target: { window_id: 7 }, x: 3, y: 4 }, scope: { consent: false, indicatorVisible: false } })
    expect(click.deliver).toBe(true)
    const combo = guardComputerUseInput({ tool: "cua_driver_native__hotkey", arguments: { target: { window_id: 7 }, keys: ["Super+Alt+s"] }, scope: { consent: false, indicatorVisible: false } })
    expect(combo.deliver).toBe(false)
    if (combo.deliver) throw new Error("unreachable")
    expect(combo.code).toBe(COMPUTER_USE_INPUT_ERRORS.A11Y_TOGGLE)
    expect(desktop.get(SCREEN_READER)).toBe("false")
    // 会话结束后快照恢复：即使外部把读屏打开，也会被写回。
    const session = await openComputerUseSession({ env: env(), run: desktop.runner })
    await desktop.runner(["gsettings", "set", "org.gnome.desktop.a11y.applications", "screen-reader-enabled", "true"], { env: env(), timeoutMs: 5000 })
    await closeComputerUseSession(session, { env: env(), run: desktop.runner })
    expect(desktop.get(SCREEN_READER)).toBe("false")
  })
})

/**
 * 两级二级验收队（`VERIFY2-COMPUTER-USE-20260926.md` §6.1/§6.2、`VERIFY2-COMPUTER-USE-MODIFIERS-20260926.md` §5.2/§6.1/§6.2）
 * 独立查出的**同一处残留**的四条。前一版交付（`computer-use-input.ts` = `2134518e…`）在四条上逐位复现，本块把它们钉死。
 *
 * 纪律：本块**不向活桌面发任何键**（全部走纯函数 + 假执行器）；② 的"能不能真发出去"无法实测
 * （实测就得发键），所以判据是"守卫**无法证明**它只会进 agent 自己的窗口" ⇒ fail-closed。
 */
describe("VERIFY2 残留口子回归（① drag 混名 / ② GNOME 绑定语法 / ③ 键字段取不出 / ④ 先有鸡先有蛋）", () => {
  /** 窗口作用域：把作用域判据排除干净，剩下的只可能来自键与拒绝清单。 */
  const windowScope = { consent: false, indicatorVisible: false }
  /** 最宽的全局层：同意 + 指示都齐。 */
  const widest = { consent: true, indicatorVisible: true }
  const plan = (tool: string, args: Record<string, unknown>, scope: typeof windowScope | typeof widest = windowScope) =>
    guardComputerUseInput({ tool: `cua_driver_native__${tool}`, arguments: { ...args, target: { window_id: 7 }, pid: 9 }, scope })
  const outcome = (tool: string, args: Record<string, unknown>, scope: typeof windowScope | typeof widest = windowScope) => {
    const value = plan(tool, args, scope)
    return value.deliver ? "DELIVERED" : value.rule
  }

  test("① `modifier`/`modifiers` 里混进非修饰键名字，不许把**真修饰键**挤掉（复发点）", () => {
    // 改前（`2134518e…` 与 `91792abf…` 两个哈希上读数一致）：`["super","x"]` → `combos=["x"]` ⇒ DELIVERED；
    // 根因是杂名把判定集占成非空 ⇒「只有修饰键字段」那条兜底永不执行 ⇒ 被静默丢掉的是 `super`。
    // `drag` 是契约里**唯一**没有 `key` 字段来强制合并的工具 ⇒ 这条路通到底（Super+拖动＝移动用户窗口）。
    expect(inputCombosOf({ modifier: ["super"] })).toEqual(["super"])
    expect(inputCombosOf({ modifier: ["super", "x"] })).toEqual(["super", "x"])
    expect(inputCombosOf({ modifier: ["x", "super"] })).toEqual(["super", "x"])
    expect(inputCombosOf({ modifiers: ["super", "alt", "s"] })).toEqual(["super+alt", "s"])
    for (const modifier of [["super", "x"], ["x", "super"], ["super", "ZZZ"], ["super", "x", "y"]]) {
      expect(`${JSON.stringify(modifier)}:${outcome("drag", { fromX: 1, fromY: 1, toX: 200, toY: 200, modifier }, widest)}`)
        .toBe(`${JSON.stringify(modifier)}:super-combos`)
    }
    // `modifiers`（复数）通道同样：契约里 `PressKeyInput.modifiers` 与 `DragInput.modifier` 都读。
    expect(outcome("drag", { fromX: 1, fromY: 1, toX: 2, toY: 2, modifiers: ["super", "x"] }, widest)).toBe("super-combos")
    // 主键塞进修饰键通道、`key` 整个缺失：`super`/`alt` 不许被 `s` 挤掉（旧实现只判到 `s` ⇒ DELIVERED）。
    expect(outcome("press_key", { modifiers: ["super", "alt", "s"] }, widest)).toBe("a11y-sticky-keys")
    // 合并**不成立**的两种写法下修饰键同样没被吸收，旧实现一样会把它们丢掉：
    // `key` 是多 token（空白分隔的序列）、或 `key` 自己已经带修饰键（合成被跳过）。
    for (const args of [{ key: "a b", modifiers: ["super", "alt"] }, { key: "ctrl+c", modifiers: ["super"] }]) {
      expect(`${JSON.stringify(args)}:${outcome("press_key", args, widest)}`).toBe(`${JSON.stringify(args)}:a11y-sticky-keys`)
    }
  })

  test("① 的反向：这一行改动**不许**收紧已经放行的正常写法（两份验收报告都点名必须放行）", () => {
    // 验收队给的**字面**一行级改动（种子改成 `[...(normalizedModifiers.length?[…]:[]), ...stray…]`）会把
    // `{key:"a",modifiers:["shift"]}`（打大写，正常用法）判成"单发修饰键"⇒ 误拒；
    // 还会把投诉那一次的**规则**从 `a11y-screen-reader` 改成泛规则 `a11y-sticky-keys`（理由失准）。
    // 落地的写法是"真修饰键**永远**进判定、杂名**额外追加**"，但**合成成立时不重复判裸修饰键**。
    for (const args of [{ key: "a", modifiers: ["shift"] }, { key: "c", modifiers: ["ctrl"] }, { key: "z", modifiers: ["ctrl", "shift"] }, { key: "s" }]) {
      expect(`${JSON.stringify(args)}:${String(plan("press_key", args, widest).deliver)}`).toBe(`${JSON.stringify(args)}:true`)
    }
    // 投诉那一次仍然报**精确**的规则，且 `combos` 里没有多出一条裸 `super+alt`。
    const flagship = plan("press_key", { key: "s", modifiers: ["super", "alt"] }, widest)
    expect(flagship.deliver).toBe(false)
    if (flagship.deliver) throw new Error("unreachable")
    expect(flagship.rule).toBe("a11y-screen-reader")
    expect(flagship.combos).toEqual(["super+alt+s"])
    expect(inputCombosOf({ key: "s", modifiers: ["super", "alt"] })).toEqual(["super+alt+s"])
    // 拖动通道的两条正常用法也不许被这条改动碰掉（同样要带**本机读数**：`alt` 拖动是机器状态的函数）。
    for (const modifier of [["shift"], ["ctrl"], ["alt"], ["shift", "ctrl"]])
      expect(`${JSON.stringify(modifier)}:${String(plan("drag", { fromX: 1, fromY: 1, toX: 2, toY: 2, modifier }, machineSuper).deliver)}`).toBe(`${JSON.stringify(modifier)}:true`)
  })

  test("② GNOME 绑定语法（`<Alt>F7` 这种尖括号前缀、无 `+`）不再被当成主键名放行", () => {
    // `gsettings` 里 `<Alt>F7` 逐字就是 mutter 的 `begin-move`（**移动用户的窗口**）。
    // 旧实现只按 `+` 切分，`normalizeKeyName` 又只剥**开头 `<` 与结尾 `>`** ⇒ `"<Alt>F7"` 变成
    // "名叫 `alt>f7` 的主键" ⇒ 溜过 `unparsable` 兜底并放行。是否真能发到桌面**无法实测**（禁止发键），
    // 所以按模块自己的纪律"认不出来的组合 agent 不发"一律拒 —— 判据不是"它一定危险"，
    // 而是"守卫**无法证明**它只会进 agent 自己的窗口"。
    for (const key of ["<Alt>F7", "<Alt>space", "<Alt>Tab", "<Alt>F4", "<Alt>Escape", "<Alt>F10", "<Alt>Above_Tab", "<Alt>F2", "<Super>s", "<Alt><F7>", "<Shift><Alt>Tab"]) {
      expect(`${key}:${outcome("press_key", { key }, widest)}`).toBe(`${key}:unparsable`)
    }
    expect(parseKeyChord("<Alt>F7")).toBeUndefined()
    // 拒绝理由必须点名"未识别语法"，而不是一句干巴巴的解析失败。
    const verdict = globalShortcutVerdict("<Alt>F7")
    expect(verdict.refused).toBe(true)
    if (!verdict.refused) throw new Error("unreachable")
    expect(verdict.why).toContain("未识别语法")
    expect(verdict.advice.length).toBeGreaterThan(5)
  })

  test("② 的反向：xdotool 写法与正常键一个都没被误伤；真正是 WM 抓取的那两条语义不变", () => {
    // `<ctrl>+c` 是模块**明确支持**的 xdotool 写法（尖括号在**修饰键**位置上被整段吃掉，不是残留）。
    expect(parseKeyChord("<ctrl>+c")).toEqual({ modifiers: ["ctrl"], key: "c", raw: "<ctrl>+c" })
    expect(parseKeyChord("<ctrl>+<shift>+T")).toEqual({ modifiers: ["ctrl", "shift"], key: "t", raw: "<ctrl>+<shift>+T" })
    for (const key of ["ctrl+c", "<ctrl>+c", "<ctrl>+<shift>+T", "Return", "F5", "a"])
      expect(`${key}:${String(plan("press_key", { key }, widest).deliver)}`).toBe(`${key}:true`)
    // 带 `+` 的那两条仍然是 `wm-window-switch`（不是被新的解析兜底顺手接住）。
    for (const key of ["alt+F7", "<Alt>+F7"])
      expect(`${key}:${outcome("press_key", { key }, widest)}`).toBe(`${key}:wm-window-switch`)
  })

  test("③ 契约里**必填**的键字段取不出组合 ⇒ 拒（不再 `combos=[]` 直接 DELIVERED）", () => {
    // 旧读数：`{keys:[1,2]}` / `{keys:[{k:"s"}]}` / `{keys:[]}` / `{key:123}` / `{key:null}` /
    // `{key:"  "}` / `{}` **全部 DELIVERED**（`stringsOf` 静默过滤 ⇒ 判定集为空 ⇒ 无规则可命中）。
    const unusable: Array<[string, string, Record<string, unknown>]> = [
      ["press_key", "键缺失", {}],
      ["press_key", "key 是数字", { key: 123 }],
      ["press_key", "key 是 null", { key: null }],
      ["press_key", "key 是布尔", { key: true }],
      ["press_key", "key 是空白串", { key: "  " }],
      ["hotkey", "keys 是数字项", { keys: [1, 2] }],
      ["hotkey", "keys 是对象项", { keys: [{ k: "s" }] }],
      ["hotkey", "keys 是空数组", { keys: [] }],
    ]
    for (const [tool, label, args] of unusable) {
      const value = plan(tool, args, widest)
      // 先窄化再逐项断言（`advice` 只在拒绝分支上存在）。
      expect(`${tool} ${label}:${value.deliver ? "DELIVERED" : value.code}`).toBe(`${tool} ${label}:${COMPUTER_USE_INPUT_ERRORS.KEY_FIELD_UNUSABLE}`)
      if (value.deliver) throw new Error("unreachable")
      expect(value.code).toBe(COMPUTER_USE_INPUT_ERRORS.KEY_FIELD_UNUSABLE)
      expect(value.combos).toEqual([])
      expect(value.advice.length).toBeGreaterThan(5)
    }
    // 这一条**不是**放宽：它是把"守卫拿不到要发什么"从放行改成不发（fail-closed）。
    expect(COMPUTER_USE_INPUT_ERRORS.KEY_FIELD_UNUSABLE).toBe("CUA_KEY_FIELD_UNUSABLE")
  })

  test("③ 的反向：没有键字段的工具 `combos=[]` 是正常形态，一个都不许被这条接住", () => {
    const noKeyField: Array<[string, Record<string, unknown>]> = [
      ["click", { x: 1, y: 2 }], ["click", {}], ["double_click", { x: 1, y: 2 }], ["right_click", { x: 1, y: 2 }],
      ["move_cursor", { x: 1, y: 2 }], ["type_text", { text: "hi" }], ["scroll", { x: 1, y: 1 }],
      ["browser_dialog", {}], ["drag", { fromX: 0, fromY: 0, toX: 9, toY: 9 }],
    ]
    for (const [tool, args] of noKeyField)
      expect(`${tool} ${JSON.stringify(args)}:${String(plan(tool, args, widest).deliver)}`).toBe(`${tool} ${JSON.stringify(args)}:true`)
    // 正常键字段照常放行：单串、规范形数组、甚至把数组写成字符串。
    for (const [tool, args] of [["press_key", { key: "a" }], ["hotkey", { keys: ["ctrl", "c"] }], ["hotkey", { keys: "ctrl+c" }]] as Array<[string, Record<string, unknown>]>)
      expect(`${tool} ${JSON.stringify(args)}:${String(plan(tool, args, windowScope).deliver)}`).toBe(`${tool} ${JSON.stringify(args)}:true`)
  })

  test("④ 守卫层：`sessionOpen:false` 时 `global-needs-indicator` 是 provisional，不是终局", () => {
    // 「先有鸡先有蛋」：可见指示是**会话的产物**，会话只在首个输入被放行后才开 ⇒ 会话还没开时
    // `indicatorVisible:false` 的含义是"还没有会话去点亮它"，把它当终局 ⇒ 全局输入永久全哑。
    const args = { key: "a" }
    const noTarget = (scope: { consent: boolean; indicatorVisible: boolean; sessionOpen?: boolean }) =>
      guardComputerUseInput({ tool: "cua_driver_native__press_key", arguments: args, scope })
    const notOpen = noTarget({ consent: true, indicatorVisible: false, sessionOpen: false })
    expect(notOpen.deliver).toBe(false)
    if (notOpen.deliver) throw new Error("unreachable")
    expect(notOpen.rule).toBe("global-needs-indicator")
    expect(notOpen.provisional).toBe(true)
    // 会话已开（或调用方没表态 ＝ 旧行为）：终局，**没有** provisional。
    for (const scope of [{ consent: true, indicatorVisible: false, sessionOpen: true }, { consent: true, indicatorVisible: false }]) {
      const value = noTarget(scope)
      expect(value.deliver).toBe(false)
      if (value.deliver) throw new Error("unreachable")
      expect(value.rule).toBe("global-needs-indicator")
      expect(value.provisional).toBeUndefined()
    }
    // 同意这一层与会话**无关**：没同意时依旧是终局的 CONSENT_REQUIRED（不许被 provisional 顺手放过）。
    const noConsent = noTarget({ consent: false, indicatorVisible: false, sessionOpen: false })
    expect(noConsent.deliver).toBe(false)
    if (noConsent.deliver) throw new Error("unreachable")
    expect(noConsent.rule).toBe("global-needs-consent")
    expect(noConsent.provisional).toBeUndefined()
    // 快捷键拒绝在会话之外就定型：永远没有 provisional。
    const combo = guardComputerUseInput({ tool: "cua_driver_native__hotkey", arguments: { keys: ["Super+Alt+s"] }, scope: { consent: true, indicatorVisible: false, sessionOpen: false } })
    expect(combo.deliver).toBe(false)
    if (combo.deliver) throw new Error("unreachable")
    expect(combo.provisional).toBeUndefined()
    // 登记（**未修**）：驱动契约的 tagged `ActionTarget`（`{tag:"Window",inner:{…}}`）仍不被
    // `inputSurfaceOf` 认出 ⇒ 它落进"全局层"，要同意 + 可见指示。这一层是**有意的保守**（不是放宽）：
    // 模型面真实形状未能定死（驱动包 dist 里没有模型面 schema），所以不拿"模型自称的 tag"去换 window 作用域。
    expect(inputSurfaceOf({ target: { tag: "Window", inner: { pid: 9, windowId: 7 } } })).toEqual({})
    expect(inputSurfaceOf({ target: { window_id: 7, pid: 9 } })).toEqual({ windowId: "7", pid: 9 })
  })

  test("⑤ 已登记的两条边界：行为**钉住**，不许无声无息地漂移（不是期望语义）", () => {
    // (a) `drag {modifier:["alt"]}`：**本单已改**（残留口子⑤ 的收口）。判据不是"本机是 `<Super>` 所以放行"
    //     （那是硬编码），也不是"GNOME 默认是 `<Alt>` 所以一律拒"（那会在本机形态误拒），而是**机器读数**：
    //       · 读数 `'<Super>'`（本机）⇒ DELIVERED（与本单之前逐字相同，不许被改红）；
    //       · 读数 `'<Alt>'`（上游 3.5.2 之前的默认 / 本机 Ubuntu `:Unity` profile）⇒ REFUSED；
    //       · 还没读过 ⇒ fail-closed + `provisional`（开会话会去读一次）。
    //     逐条读数见 `describe("⑥ …")`，这里只钉住"它已经不再是一个常量"。
    expect(plan("drag", { fromX: 1, fromY: 1, toX: 2, toY: 2, modifier: ["alt"] }, machineSuper).deliver).toBe(true)
    expect(plan("drag", { fromX: 1, fromY: 1, toX: 2, toY: 2, modifier: ["alt"] }, machineAlt).deliver).toBe(false)
    // (b) `WM_ALT_KEYS` 整类里本机无对应全局绑定的那些仍被拒（过宽拒绝，fail-closed 非安全问题）——
    //     本单**不收窄清单**（收窄＝放宽），只把 reason 文案改成与实测一致；
    //     GNOME 的 `<Primary>`（=Ctrl）写法仍不被识别 ⇒ 走 `unparsable` 兜底被拒（本单**未改**，理由见回执）。
    const primary = globalShortcutVerdict("<Primary>+c")
    expect(primary.refused).toBe(true)
    if (!primary.refused) throw new Error("unreachable")
    expect(primary.rule).toBe("unparsable")
    for (const key of ["alt+Left", "alt+Right", "alt+BackSpace", "alt+Home", "alt+F12"])
      expect(`${key}:${outcome("press_key", { key }, widest)}`).toBe(`${key}:wm-window-switch`)
    // reason 文案必须与**实测**一致（本单修正）：这五个键本机**没有** Alt-only 绑定 ⇒ 文案里不许出现
    // "本机实测由 WM 全局抓取"这种说法，必须点名"整类保守拒绝 + 本机这次枚举里没有绑定"。
    const unbound = globalShortcutVerdict("alt+Left")
    expect(unbound.refused).toBe(true)
    if (!unbound.refused) throw new Error("unreachable")
    expect(unbound.why).toContain("整类保守拒绝")
    expect(unbound.why).toContain("本机这次枚举里")
    expect(unbound.why).toContain("Alt+方向键")
    // 而实测有绑定的那 11 个键：文案里给出绑定名（switch-windows / begin-move…），不是一句"由 WM 抓取"。
    const bound = globalShortcutVerdict("alt+F7")
    expect(bound.refused).toBe(true)
    if (!bound.refused) throw new Error("unreachable")
    expect(bound.why).toContain("begin-move")
    expect(bound.why).toContain("Alt+Tab")
    expect(globalShortcutVerdict("alt+Tab").refused && (globalShortcutVerdict("alt+Tab") as { why: string }).why).toContain("switch-windows")
  })
})

describe("⑥ 拖动修饰键豁免按**机器状态**取反（残留口子⑤ 的收口；不许放宽、也不许把本机形态改红）", () => {
  const windowScope: InputScopeState = { consent: false, indicatorVisible: false }
  const widest: InputScopeState = { consent: true, indicatorVisible: true }
  const drag = (scope: InputScopeState, modifier?: unknown, extra: Record<string, unknown> = {}) =>
    guardComputerUseInput({ tool: "cua_driver_native__drag", arguments: { fromX: 1, fromY: 1, toX: 2, toY: 2, ...modifier === undefined ? {} : { modifier }, target: { window_id: 7 }, pid: 9, ...extra }, scope })

  test("形态 A（读数 `'<Super>'`，本机）：`drag {modifier:[\"alt\"]}` 照旧 DELIVERED —— 本机形态行为不变", () => {
    const plan = drag(machineSuper, ["alt"])
    expect(plan.deliver).toBe(true)
    if (!plan.deliver) throw new Error("unreachable")
    expect(plan.combos).toEqual(["alt"])           // 判定集与改前逐字相同
    expect(plan.scope).toBe("window")
    // 无修饰键的拖动、`shift`/`ctrl` 拖动也一样（豁免**没有**被删掉）。
    for (const modifier of [undefined, ["shift"], ["ctrl"], ["shift", "ctrl"]])
      expect(`${JSON.stringify(modifier)}:${String(drag(machineSuper, modifier).deliver)}`).toBe(`${JSON.stringify(modifier)}:true`)
  })

  test("形态 B（读数 `'<Alt>'`）：同一条入参变 REFUSED `drag-moves-user-window`（判据核心）", () => {
    const plan = drag(machineAlt, ["alt"])
    expect(plan.deliver).toBe(false)
    if (plan.deliver) throw new Error("unreachable")
    expect(plan.code).toBe(COMPUTER_USE_INPUT_ERRORS.DRAG_WINDOW_MOVE)
    expect(plan.code).toBe("CUA_DRAG_WINDOW_MOVE_REFUSED")
    expect(plan.rule).toBe("drag-moves-user-window")
    expect(plan.combos).toEqual(["alt"])
    expect(plan.provisional).toBeUndefined()        // 实测到了 ⇒ **终局**，不是 provisional
    // reason 必须写清"用的是哪一次读数"，并点名这台机器的读数原文与窗口移动语义。
    expect(plan.reason).toContain("mouse-button-modifier")
    expect(plan.reason).toContain(MACHINE_ALT)
    expect(plan.reason).toContain("移动")
    expect(plan.advice).toContain("shift")
    // 窗口作用域也算在内：这条拒绝比作用域判据**先**发生（拖动那一下作用在指针下的窗口上）。
    expect(drag({ consent: false, indicatorVisible: false, mouseButtonModifier: MACHINE_ALT }, ["alt"]).deliver).toBe(false)
  })

  test("形态 B 的反向：`shift`/`ctrl` 拖动与无修饰键拖动**一条都不许**被这条收紧", () => {
    for (const modifier of [undefined, ["shift"], ["ctrl"], ["shift", "ctrl"]])
      expect(`${JSON.stringify(modifier)}:${String(drag(machineAlt, modifier).deliver)}`).toBe(`${JSON.stringify(modifier)}:true`)
    // 按键通道的裸修饰键照旧由 `a11y-sticky-keys` 拒（`drag` 的例外没有泄漏出去），理由也不许被换掉。
    const bare = guardComputerUseInput({ tool: "cua_driver_native__press_key", arguments: { key: "Alt", target: { window_id: 7 } }, scope: machineAlt })
    expect(bare.deliver).toBe(false)
    if (bare.deliver) throw new Error("unreachable")
    expect(bare.rule).toBe("a11y-sticky-keys")
    // 既有拒绝的**理由不变**（新检查放在规则表之后）：super / ctrl+alt / alt+shift。
    for (const [modifier, rule] of [[["super"], "super-combos"], [["ctrl", "alt"], "vt-switch-and-desktop"], [["alt", "shift"], "ime-switch"]] as Array<[string[], string]>)
      expect(`${JSON.stringify(modifier)}:${(drag(machineAlt, modifier) as { rule?: string }).rule}`).toBe(`${JSON.stringify(modifier)}:${rule}`)
  })

  test("机器读数说 `'<Control>'` 时 `ctrl` 拖动被拒 —— 判据跟着**读数**走，不是跟着 `alt` 这个名字走", () => {
    // 这就是"按机器状态取反"与"把 alt 加进黑名单"的区别：读数指向哪个修饰键，就拒哪个。
    const control = { consent: true, indicatorVisible: true, mouseButtonModifier: "'<Control>'" }
    const plan = drag(control, ["ctrl"])
    expect(plan.deliver).toBe(false)
    if (plan.deliver) throw new Error("unreachable")
    expect(plan.rule).toBe("drag-moves-user-window")
    expect(drag(control, ["alt"]).deliver).toBe(true)      // 这台机器上 alt 不是拖动修饰键 ⇒ 照旧放行
    expect(drag(control, ["shift"]).deliver).toBe(true)
  })

  test("调用方没表态且会话没开过 ⇒ fail-closed REFUSED + `provisional`（不是终局）；会话已开仍是未知 ⇒ 终局", () => {
    // `scope` 里没有 `mouseButtonModifier`，模块里也没有最近读数（每条用例前后都清）。
    const notOpen = drag({ consent: true, indicatorVisible: true, sessionOpen: false }, ["alt"])
    expect(notOpen.deliver).toBe(false)
    if (notOpen.deliver) throw new Error("unreachable")
    expect(notOpen.rule).toBe("drag-moves-user-window")
    expect(notOpen.provisional).toBe(true)                 // 开会话＝本模块会去读一次 ⇒ 那次才是终局
    expect(notOpen.reason).toContain("不知道")              // 不许把兜底写成"这台机器是…"
    expect(notOpen.reason).toContain("3.5.2")               // 兜底口径的出处写在理由里
    // 会话已开（调用方明示）却仍旧没有读数 ⇒ 终局，没有 provisional（不许无限期地"再判一次"）。
    const open = drag({ consent: true, indicatorVisible: true, sessionOpen: true }, ["alt"])
    expect(open.deliver).toBe(false)
    if (open.deliver) throw new Error("unreachable")
    expect(open.provisional).toBeUndefined()
    // 显式说"读不到"（`null`）与"读到但认不出来"是同一侧：fail-closed，理由点名调用方给的读数。
    for (const reading of [null, "disabled", "garbage"] as Array<string | null>) {
      const value = drag({ consent: true, indicatorVisible: true, sessionOpen: true, mouseButtonModifier: reading }, ["alt"])
      expect(value.deliver).toBe(false)
      if (value.deliver) throw new Error("unreachable")
      expect(value.rule).toBe("drag-moves-user-window")
    }
    // 反向：调用方明示"这台机器没有绑定"（空读数）⇒ 不拒（这是**实测**，不是放宽：空值＝mutter 不会移动窗口）。
    expect(drag({ consent: true, indicatorVisible: true, mouseButtonModifier: "" }, ["alt"]).deliver).toBe(true)
  })

  test("产品路径的读法：机器读数由**会话快照**读进模块，旧 scope 形状照样按形态判（plugin.ts 不用改）", async () => {
    // 形态 A：`openComputerUseSession` 读一次 `mouse-button-modifier` ⇒ 记进会话快照与模块。
    const desktopA = fakeDesktop()
    const sessionA = await openComputerUseSession({ run: desktopA.runner, env: env() })
    expect(sessionA.snapshot.machine?.readable).toBe(true)
    expect(sessionA.snapshot.machine?.mouseButtonModifierRaw).toBe(MACHINE_SUPER)
    expect(sessionA.snapshot.machine?.desktopDragModifiers).toEqual(["super"])
    // 机器状态**不进** `entries`（它从不被写，也不参与恢复）：九键口径不变。
    expect(sessionA.snapshot.entries.map(entry => entry.id)).toEqual(A11Y_SNAPSHOT_KEYS.map(key => key.id))
    expect(desktopMachineFacts()?.desktopDragModifiers).toEqual(["super"])
    expect(widest).toEqual({ consent: true, indicatorVisible: true })
    expect(drag(widest, ["alt"]).deliver).toBe(true)        // ← 旧 scope 形状（`plugin.ts:325` 逐字如此）
    // 形态 B：同一段代码，读数是 `'<Alt>'` ⇒ 同一条拖动被拒，理由里带的是**这次实测**的原文。
    rememberDesktopMachineFacts(undefined)
    const desktopB = fakeDesktop({ [MACHINE_KEY]: MACHINE_ALT })
    await openComputerUseSession({ run: desktopB.runner, env: env() })
    expect(desktopMachineFacts()?.desktopDragModifiers).toEqual(["alt"])
    const refused = drag(widest, ["alt"])
    expect(refused.deliver).toBe(false)
    if (refused.deliver) throw new Error("unreachable")
    expect(refused.rule).toBe("drag-moves-user-window")
    expect(refused.reason).toContain(MACHINE_ALT)
    expect(String(refused.reason)).toContain("移动")
  })

  test("读数读不到/认不出来：快照如实记 `readable:false` + 原因，判定侧 fail-closed（不填默认值）", async () => {
    // ① `gsettings` 对这条键失败（例如 dconf 不可读）⇒ 快照记 error，模块里没有可用读数。
    const failing = fakeDesktop()
    const failingRunner: CommandRunner = async (argv, options) => argv.includes(MOUSE_BUTTON_MODIFIER_KEY)
      ? { code: 1, stdout: "", stderr: "dconf 不可读" }
      : await failing.runner(argv, options)
    const broken = await openComputerUseSession({ run: failingRunner, env: env() })
    expect(broken.snapshot.machine?.readable).toBe(false)
    expect(broken.snapshot.machine?.desktopDragModifiers).toBeNull()
    expect(broken.snapshot.machine?.error).toContain(COMPUTER_USE_INPUT_ERRORS.SNAPSHOT_UNAVAILABLE)
    const unknownReading = drag({ consent: true, indicatorVisible: true, sessionOpen: true }, ["alt"])
    expect(unknownReading.deliver).toBe(false)
    // ② 值本身认不出来（`disabled` 之类）也按"不知道"，不按"没有绑定"。
    const weird = await openComputerUseSession({ run: fakeDesktop({ [MACHINE_KEY]: "disabled" }).runner, env: env() })
    expect(weird.snapshot.machine?.readable).toBe(false)
    expect(weird.snapshot.machine?.mouseButtonModifierRaw).toBe("disabled")
    expect(drag({ consent: true, indicatorVisible: true, sessionOpen: true }, ["alt"]).deliver).toBe(false)
  })

  test("`desktopDragModifiersOf` 的读数表（纯函数，只读原文 → 归一修饰键）", () => {
    // gsettings 的 stdout 带单引号；两种写法都收。
    expect(desktopDragModifiersOf(MACHINE_SUPER)).toEqual(["super"])
    expect(desktopDragModifiersOf(MACHINE_ALT)).toEqual(["alt"])
    expect(desktopDragModifiersOf("<Alt>")).toEqual(["alt"])
    expect(desktopDragModifiersOf("<Control>")).toEqual(["ctrl"])
    expect(desktopDragModifiersOf("'<Meta>'")).toEqual(["super"])
    expect(desktopDragModifiersOf("Alt")).toEqual(["alt"])
    // 空值 ＝ 明确知道"没有绑定"（`[]`）；认不出来 ＝ 不知道（`null`）—— 两者语义不同，不许混。
    expect(desktopDragModifiersOf("''")).toEqual([])
    expect(desktopDragModifiersOf("")).toEqual([])
    expect(desktopDragModifiersOf("disabled")).toBeNull()
    expect(desktopDragModifiersOf("none")).toBeNull()
    expect(desktopDragModifiersOf("garbage")).toBeNull()
    expect(desktopDragModifiersOf(null)).toBeNull()
    expect(desktopDragModifiersOf(undefined)).toBeNull()
  })
})

/**
 * W22-R3 · 驱动工具**全表**审计（回执 `bugfixHistory/CUA-DRIVER-TOOL-AUDIT-20260927.md`）。
 *
 * 这一块钉五件事：
 *   ① 全表是**闭集**、且"表 + 明确放行的观测类"**恰好铺满**它（两边各写一份清单会漂移，这里钉住）；
 *   ② **表外的默认语义**：在册的观测类原样放行；**不在全表里的**驱动工具名一律不发
 *      （`CUA_DRIVER_TOOL_UNCLASSIFIED`）—— 这是本单的核心（改前它连判定都不做，直接交给驱动）；
 *   ③ 新进拒绝表的 14 条在**最宽松作用域**下仍然拒，且各有各的稳定码/rule（不合并成一条"操作不允许"）；
 *   ④ 新进输入表的每一条：没有窗口目标 ⇒ `CONSENT_REQUIRED`（全局层需同意）；带窗口目标 ⇒ 交付；
 *   ⑤ 读数由代码算：全表 N / 三张表覆盖 M / 表外 N−M / 其中能碰到用户对象的 K。
 */
describe("W22-R3 驱动工具全表审计：表外不再等于放行", () => {
  const bare: InputScopeState = { consent: false, indicatorVisible: false }
  const widest: InputScopeState = { consent: true, indicatorVisible: true }
  const full = (raw: string) => `${CUA_DRIVER_TOOL_PREFIX}${raw}`

  test("① 全表闭集：类别与三张表逐条一致，且两两互斥、并集恰好是全表", () => {
    expect(CUA_DRIVER_TOOL_NAMES.length).toBe(59)
    expect(new Set(CUA_DRIVER_TOOL_NAMES).size).toBe(59)
    const input = new Set<string>(CUA_INPUT_TOOL_NAMES)
    const state = new Set<string>(CUA_GLOBAL_STATE_TOOL_NAMES)
    const read = new Set<string>(CUA_PRIVACY_READ_TOOL_NAMES)
    const pass = new Set(CUA_DRIVER_TOOL_CATALOG.filter(entry => entry.klass === "pass").map(entry => entry.tool))
    const inconsistent: string[] = []
    for (const entry of CUA_DRIVER_TOOL_CATALOG) {
      const inTables = [input.has(entry.tool), state.has(entry.tool), read.has(entry.tool)].filter(Boolean).length
      if (inTables > 1) inconsistent.push(`${entry.tool}:多张表`)
      const expected = entry.klass === "input" ? input.has(entry.tool) : entry.klass === "state" ? state.has(entry.tool) : entry.klass === "read" ? read.has(entry.tool) : pass.has(entry.tool)
      if (!expected) inconsistent.push(`${entry.tool}:${entry.klass}`)
    }
    for (const name of [...input, ...state, ...read]) if (!CUA_DRIVER_TOOL_NAMES.includes(name)) inconsistent.push(`${name}:不在全表`)
    expect(`不一致：${inconsistent.join(",")}`).toBe("不一致：")
    // 每一条都必须对"能碰到什么用户对象"有读数（空字符串不算判过）。
    expect(CUA_DRIVER_TOOL_CATALOG.filter(entry => !entry.object.trim() || !entry.why.trim()).map(entry => entry.tool)).toEqual([])
  })

  test("② 表外语义：在册的观测类放行；**不在全表里的**驱动工具名一律不发", () => {
    // 在册的观测类 —— 含既有用例当作"表外见证"的 `get_window_state` / `list_windows`。
    for (const raw of ["get_window_state", "list_windows", "list_apps", "get_browser_state", "check_permissions", "start_recording", "stop_recording"]) {
      expect(`${raw}:${String(cuaDriverToolPassThrough(full(raw)))}`).toBe(`${raw}:true`)
    }
    // 三张表里的名字**不**放行（它们要进漏斗）。
    for (const raw of [...CUA_INPUT_TOOL_NAMES, ...CUA_GLOBAL_STATE_TOOL_NAMES, ...CUA_PRIVACY_READ_TOOL_NAMES]) {
      expect(`${raw}:${String(cuaDriverToolPassThrough(full(raw)))}`).toBe(`${raw}:false`)
    }
    // 不是驱动工具 ⇒ 放行（本模块不管别的域的工具体）。
    expect(cuaDriverToolPassThrough("scene_list")).toBe(true)
    expect(cuaDriverToolPassThrough("bash")).toBe(true)
    // **不在全表里的驱动工具名**（驱动升级新增/改名）⇒ 不放行，且守卫明确拒、给稳定码。
    const unknown = full("brand_new_driver_tool")
    expect(cuaDriverToolPassThrough(unknown)).toBe(false)
    expect(cuaDriverToolSpec(unknown)).toBeUndefined()
    for (const scope of [bare, widest]) {
      const plan = guardComputerUseInput({ tool: unknown, arguments: {}, scope })
      expect(plan.deliver).toBe(false)
      if (plan.deliver) throw new Error("unreachable")
      expect(plan.code).toBe(COMPUTER_USE_INPUT_ERRORS.DRIVER_TOOL_UNCLASSIFIED)
      expect(plan.rule).toBe("driver-tool-unclassified")
      expect(plan.reason).toContain("CUA_DRIVER_TOOL_CATALOG")
      expect(plan.combos).toEqual([])
    }
    // 反向：既有语义一个字没动 —— 在册的非输入类工具仍是 TOOL_UNKNOWN（不被新码顶掉）。
    const known = guardComputerUseInput({ tool: full("get_window_state"), arguments: {pid:777,window_id:4242}, scope: bare })
    expect(known.deliver).toBe(false)
    if (known.deliver) throw new Error("unreachable")
    expect(known.code).toBe(COMPUTER_USE_INPUT_ERRORS.TOOL_UNKNOWN)
  })

  test("③ 新进拒绝表的每一条：最宽松作用域下仍然拒，且各自的码/rule 不合并", () => {
    const codes = new Set<string>()
    for (const raw of [...CUA_GLOBAL_STATE_TOOL_NAMES, ...CUA_PRIVACY_READ_TOOL_NAMES]) {
      const entry = cuaDriverToolRefusal(full(raw))
      expect(`${raw}:${entry === undefined ? "缺条目" : "有"}`).toBe(`${raw}:有`)
      for (const scope of [bare, widest]) {
        const plan = guardComputerUseInput({ tool: full(raw), arguments: {}, scope })
        expect(`${raw}:${String(plan.deliver)}`).toBe(`${raw}:false`)
        if (plan.deliver) throw new Error("unreachable")
        expect(`${raw}:${plan.code}`).toBe(`${raw}:${entry!.code}`)
        expect(`${raw}:${plan.rule}`).toBe(`${raw}:${entry!.rule}`)
        expect(plan.reason.length).toBeGreaterThan(20)
        expect(plan.advice.length).toBeGreaterThan(10)
        expect(plan.combos).toEqual([])
      }
      codes.add(entry!.code)
    }
    // 每一条各有各的稳定码（15 条 → 15 个码），rule 也两两不同。
    expect(codes.size).toBe(CUA_GLOBAL_STATE_TOOL_NAMES.length + CUA_PRIVACY_READ_TOOL_NAMES.length)
    expect(Object.keys(CUA_DRIVER_TOOL_REFUSALS).length).toBe(15)
    expect(new Set(Object.values(CUA_DRIVER_TOOL_REFUSALS).map(entry => entry.rule)).size).toBe(15)
  })

  test("④ 新进输入表的每一条：没窗口目标 ⇒ 拒（全局层需同意）；带窗口目标 ⇒ 交付", () => {
    const withWindow = (raw: string) => raw === "invoke_menu"
      ? { target: { window_id: 4242 }, pid: 777, path: ["File"] }
      : raw === "set_value"
        ? { target: { window_id: 4242 }, pid: 777, value: "x" }
        : { target: { window_id: 4242 }, x: 1, y: 2 }
    for (const raw of ["mouse_button_down", "mouse_button_up", "mouse_drag", "set_value", "invoke_menu"]) {
      const refused = guardComputerUseInput({ tool: full(raw), arguments: {}, scope: bare })
      expect(`${raw}:${String(refused.deliver)}`).toBe(`${raw}:false`)
      if (refused.deliver) throw new Error("unreachable")
      expect(`${raw}:${refused.code}`).toBe(`${raw}:${COMPUTER_USE_INPUT_ERRORS.CONSENT_REQUIRED}`)
      const allowed = guardComputerUseInput({ tool: full(raw), arguments: withWindow(raw), scope: bare })
      expect(`${raw}:${String(allowed.deliver)}`).toBe(`${raw}:true`)
    }
    // 浏览器动作族：参数里**没有** pid/window_id（只有不透明句柄）⇒ 即使给了 target_id/tab_id 也落全局层，
    // 需要用户显式同意 + 可见指示（与既有成员 `browser_dialog` 同一条判据 —— 不是本单新发明的口径）。
    for (const raw of ["browser_click", "browser_type", "browser_pointer", "browser_navigate"]) {
      const refused = guardComputerUseInput({ tool: full(raw), arguments: { target_id: "t", tab_id: "b" }, scope: bare })
      expect(`${raw}:${String(refused.deliver)}`).toBe(`${raw}:false`)
      if (refused.deliver) throw new Error("unreachable")
      expect(`${raw}:${refused.code}`).toBe(`${raw}:${COMPUTER_USE_INPUT_ERRORS.CONSENT_REQUIRED}`)
      const allowed = guardComputerUseInput({ tool: full(raw), arguments: { target_id: "t", tab_id: "b" }, scope: widest })
      expect(`${raw}:${String(allowed.deliver)}`).toBe(`${raw}:true`)
      if (!allowed.deliver) throw new Error("unreachable")
      expect(allowed.scope).toBe("global")
    }
    // 对照组：`browser_dialog` 在本单之前就在输入表里（同族判据的既有先例）。
    expect(CUA_INPUT_TOOL_NAMES).toContain("browser_dialog")
  })

  test("⑤ 读数：全表 N / 三张表覆盖 M / 表外 N−M / 其中能碰到用户对象的 K", () => {
    const N = CUA_DRIVER_TOOL_NAMES.length
    const M = CUA_INPUT_TOOL_NAMES.length + CUA_GLOBAL_STATE_TOOL_NAMES.length + CUA_PRIVACY_READ_TOOL_NAMES.length
    // "能碰到用户对象"的口径写在每条的 `object` 里：以「无」开头的那些是"碰不到（或只碰会话/驱动自己的东西）"。
    const touched = CUA_DRIVER_TOOL_CATALOG.filter(entry => !entry.object.startsWith("无"))
    const outsideTouched = touched.filter(entry => entry.klass === "pass")
    // 改前的三张表只覆盖 12 个（10 输入 + clipboard_write + clipboard_read）⇒ 表外 47、其中 K0=36 个能碰用户对象。
    expect(`${String(N)}/${String(M)}/${String(N - M)}/${String(touched.length)}/${String(outsideTouched.length)}`).toBe("59/35/24/48/13")
    expect(M - 12).toBe(23)
    // 表外那 13 个"能碰到用户对象"的观测类**逐个**写了理由（不是靠"名字看着安全"）。
    expect(outsideTouched.filter(entry => entry.why.length < 30).map(entry => entry.tool)).toEqual([])
  })
})
