/**
 * W4 · DEV-006（真实桌面指针与焦点的并发归属）回归：宿主级输入单飞。
 *
 * 事实：computer-use 驱动的是**同一块物理桌面上唯一的指针/活动窗口**，而上游
 * `@deepseek-ai/dsh-computer-use` 只提供具名独占注册、没有调用期互斥/队列
 * （见 `bugfixHistory/COMPUTER-USE-DRIVER-UPSTREAM-CHECK-20260918.md` 与台账 Round 160）。
 * 因此产品侧在 `plugin.ts` 的 `tools/execute` 漏斗上做**宿主级串行**：只串行 `cua_driver_native__*`
 * 的输入类工具，其余工具原样放行；>50ms 打一行单飞日志。
 *
 * 本文件钉住五件事（跑真实 `plugin.ts` 的注册面 + 真实 `@deepseek-ai/dsh-tools` 调度器）：
 *   ① 两个输入类工具同刻发起：真正串行、FIFO，两个都拿到结果（不丢）；
 *   ② 非输入类工具（读窗口状态/枚举窗口/别的域工具）不被这条链挡住；
 *   ③ 前一个输入工具失败不卡死后面的（控制释放，链继续）；
 *   ④ 串行等待 >50ms 时有单飞日志（可观测的占用事实）；
 *   ⑤ 被串行的动作集合在源码里是**闭集**：改动必须显式过本用例（不能悄悄放一个新输入工具出去）。
 *
 * 边界（如实登记）：本环境没有真实 X 指针/焦点可争用（上游驱动包未安装、lane 用 headless 窗口），
 * 所以这里证明的是**宿主侧串行规则**，不是"两台真实桌面并发点击的真机读数"；
 * 真机并发负对照见台账 Round 160 与 `bugfixHistory/` 的 computer-use 回执。
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
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
import { CUA_GLOBAL_STATE_TOOL_NAMES, CUA_INPUT_TOOL_NAMES } from "../src/computer-use-input.ts"

/**
 * 源码里那 10 个输入类驱动的原始工具名（`cua_driver_native__<name>`）。
 *
 * ⚠️ 这份清单**故意**是**手抄的独立字面量**，不许改成"从产品导出派生"：
 * 它就是文件末尾那条闭集断言（产品导出与本表逐名相等）的**见证**。
 * 派生写法会让那条断言变成**恒真**（同一个数组自己等于自己）⇒ 守卫静默失效，
 * 于是"往产品里加一个输入工具名"再也不会被这条用例挡住。手抄带来的摩擦
 * （加名字必须显式过本用例）正是这条守卫**要**的东西，不是它的缺陷。
 * 这条性质本身也有守卫：见文件末尾「手抄常量必须仍是独立字面量」那条断言。
 */
const INPUT_TOOLS = [
  "click", "double_click", "right_click", "drag", "move_cursor", "type_text", "press_key", "hotkey", "scroll", "browser_dialog",
  // W22-R3（驱动工具全表审计）：裸指针原语（`click`/`drag` 的底层）、AT-SPI 写值、菜单调用，
  // 以及浏览器动作族里除 `browser_dialog` 之外的四个。改前它们**不在任何一张表里** ⇒ 从漏斗直接交到驱动：
  // 作用域判定、全局快捷键拒绝清单、宿主级单飞**一条都不生效**。判据与代价见回执 §4/§6。
  "mouse_button_down", "mouse_button_up", "mouse_drag", "parallel_mouse_drag", "set_value", "invoke_menu",
  "browser_click", "browser_type", "browser_pointer", "browser_navigate",
] as const
const FULL = (name: string) => `cua_driver_native__${name}`

interface ToolCallResult { isError: boolean; content?: Array<{ type: string; text?: string }>; error?: { message?: string } }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let installerRoot: string | undefined
beforeEach(() => { installerRoot = mkdtempSync(join(tmpdir(), "lyapunov-w4-cua-")) })
afterEach(() => {
  if (installerRoot !== undefined) rmSync(installerRoot, { recursive: true, force: true })
  installerRoot = undefined
})

/**
 * 最小宿主：真实 cordis + 真实工具调度器（`tools/execute` 漏斗就是产品里那一条）。
 * 场景/世界服务只提供被测代码真正用到的调用形状——本文件不碰场景语义。
 */
async function boot() {
  const root = installerRoot!
  const ctx = new Context() as any
  await ctx.plugin(JobsLocal as never)
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const namespaces = new Set<string>()
  const definitions = new Map<string, { handler: (invocation: any) => any }>()
  ctx.provide("connection", { fetch: { register: (entry: { path: string; fetch: (request: Request) => Promise<Response> }) => { routes.set(entry.path, entry.fetch); return () => routes.delete(entry.path) } } })
  ctx.provide("settings", { register: (ns: string) => { namespaces.add(ns); return () => namespaces.delete(ns) }, describe: () => [...namespaces].map(ns => ({ ns, user: undefined, revision: 1, value: {} })), mutate: async () => undefined, replace: async () => undefined })
  ctx.provide("scene", { forSession: () => ({ scene: { snapshot: async (sceneId: string) => ({ sceneId, revision: 0, entities: [] }) }, list: async () => [], create: async () => { throw new Error("SCENE_CREATE_UNUSED") } }) })
  ctx.provide("sim", { forSession: () => ({ listWorlds: async () => [], dispose: async () => {} }), has: () => false, sessions: () => [] })
  ctx.provide("agents", { get: () => undefined })
  ctx.provide("sessions", { flush: async () => undefined })
  ctx.provide("sessionController", { resolveAgent: async () => ({ error: new Error("SESSION_NOT_FOUND: fixture") }) })
  ctx.provide("sessionQuery", { observeSession: async () => undefined })
  ctx.provide("commands", {
    register: (definition: { name: string; handler: (invocation: any) => any }) => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) },
    execute: async () => undefined,
  })
  ctx.provide("attachments", { saveImage: async () => ({}), readImage: async () => ({ data: new Uint8Array() }) })
  await ctx.plugin(SystemPrompt as never, { personaPrefix: "", personaSuffix: "" } as never)
  await ctx.plugin(ToolRuntime as never)

  const installerIsolation = isolateProviderInstaller(root)
  /** W22：桌面设置后端换成**只读替身** —— 测试绝不能真的读写用户桌面的 a11y 设置，更不能弹真通知。 */
  const desktopCalls: string[][] = []
  const desktopRunner = async (argv: readonly string[]) => { desktopCalls.push([...argv]); return { code: 1, stdout: "", stderr: "test fixture: 不触碰真实桌面" } }
  try {
    const { apply } = await import("../src/plugin.ts")
    await apply(ctx as never, { captureRoot: join(root, "captures"), recordingRoot: join(root, "recordings"), computerUse: { runner: desktopRunner } } as never)
    installerIsolation.assertCalled()
  } finally {
    installerIsolation.restore()
  }
  /** 调用轨迹：本文件只按"谁在什么时候开始/结束"判定串行，不看实现细节。 */
  const trace: Array<{ name: string; phase: "start" | "end"; at: number }> = []
  const started = (name: string) => trace.filter(row => row.name === name && row.phase === "start").length
  const agent = { id: SessionId("w4-cua-session"), ctx: createScope(ctx, { session: "w4-cua-session" }).ctx, steer() {}, inject() {}, session: { id: "w4-cua-session", header: { id: "w4-cua-session" }, snapshotEvents: () => [] } } as never
  let callSeq = 0
  /** W22 起：输入必须指名窗口（`target`/`pid`），否则被判"要进用户的活动会话全局层"而拒绝。 */
  const call = async (name: string, body: () => Promise<unknown>, args: unknown = { target: { window_id: 4242, pid: 777 } }): Promise<ToolCallResult> =>
    await ctx.get("tools").execute({ callId: ToolCallId(`w4-cua-${String(++callSeq)}`), name, agent, arguments: args, signal: new AbortController().signal }) as ToolCallResult

  /**
   * 输入类工具：记录轨迹，可选地卡在一道闸门上（测试掌握"占用中"这段在途时间）。
   * `onCall` 是"工具体真的跑了"时才会发生的**副作用**（替身自己的见证，例如改一块假剪贴板）——
   * 用它把"没被调用"与"副作用没发生"两件事分开断言，而不是只看返回码。
   */
  const registerInput = (name: string, options: { hold?: () => Promise<void>; fail?: string; onCall?: () => void } = {}) => ctx.tools.register(defineTool({
    name: FULL(name), description: `fixture input tool ${name}`, parameters: {},
    output: { schema: { type: "json" }, render: (_args: unknown, value: unknown) => [{ type: "text", text: JSON.stringify(value) }] },
    execute: async () => {
      trace.push({ name, phase: "start", at: performance.now() })
      options.onCall?.()
      if (options.hold) await options.hold()
      if (options.fail) { trace.push({ name, phase: "end", at: performance.now() }); throw new Error(options.fail) }
      trace.push({ name, phase: "end", at: performance.now() })
      return { ok: true, tool: name }
    },
  }))
  /** 非输入类工具（只读）：上游驱动里 `get_window_state` / 枚举类不该被串行挡住。 */
  const registerReadonly = (fullName: string) => ctx.tools.register(defineTool({
    name: fullName, description: `fixture read-only tool ${fullName}`, parameters: {},
    output: { schema: { type: "json" }, render: (_args: unknown, value: unknown) => [{ type: "text", text: JSON.stringify(value) }] },
    execute: async () => { trace.push({ name: fullName, phase: "start", at: performance.now() }); await sleep(1); trace.push({ name: fullName, phase: "end", at: performance.now() }); return { ok: true, tool: fullName } },
  }))

  const dispose = async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } }
  return { call, dispose, trace, started, registerInput, registerReadonly, desktopCalls }
}

/** 手动闸门：测试决定"这一刻输入工具还占着桌面"。 */
function gate() {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

describe("DEV-006 宿主级输入单飞", () => {
  test("两个输入类工具同刻发起：真正串行、FIFO，两个都拿到结果", async () => {
    const host = await boot()
    try {
      const held = gate()
      let released = false
      host.registerInput("click", { hold: () => held.promise })
      host.registerInput("type_text", { hold: () => held.promise })
      const first = host.call(FULL("click"), async () => undefined)
      await sleep(20)
      expect(host.started("click")).toBe(1)
      const second = host.call(FULL("type_text"), async () => undefined)
      // 第一个还占着桌面：第二个**还没有开始**（不是"开始了再排队"）。
      expect(host.started("type_text")).toBe(0)
      await sleep(20)
      expect(host.started("type_text")).toBe(0)
      released = true
      held.open()
      const results = await Promise.all([first, second])
      expect(released).toBe(true)
      expect(results.filter(result => result.isError)).toEqual([])
      const endClick = host.trace.find(row => row.name === "click" && row.phase === "end")!.at
      const startType = host.trace.find(row => row.name === "type_text" && row.phase === "start")!.at
      // 串行的定义：前一个结束之前，后一个不开始（区间不相交），且顺序是先到先得。
      expect(endClick).toBeLessThanOrEqual(startType)
    } finally { await host.dispose() }
  })

  test("三个输入工具按发起顺序 FIFO 执行", async () => {
    const host = await boot()
    try {
      const held = gate()
      host.registerInput("click", { hold: () => held.promise })
      host.registerInput("type_text")
      host.registerInput("press_key")
      const calls = [
        host.call(FULL("click"), async () => undefined),
        host.call(FULL("type_text"), async () => undefined),
        // 另一条 lane 的 `CUA_KEY_FIELD_UNUSABLE`（键字段取不出组合 ⇒ 不发）落地后，
        // `press_key` 只用默认入参（只有 `target`）会被**正确**拒掉。本用例判的是**排队顺序**，
        // 不是"缺字段也放行"，所以这里按驱动契约把必填的 `key` 补上；断言一个字没改。
        host.call(FULL("press_key"), async () => undefined, { target: { window_id: 4242 }, key: "Return" }),
      ]
      await sleep(20)
      held.open()
      const results = await Promise.all(calls)
      expect(results.filter(result => result.isError)).toEqual([])
      // trace 的 start 顺序 = 发起顺序；且每个 end 都在下一个 start 之前。
      const starts = host.trace.filter(row => row.phase === "start").map(row => row.name)
      expect(starts).toEqual(["click", "type_text", "press_key"])
      const ends = host.trace.filter(row => row.phase === "end").map(row => row.name)
      expect(ends).toEqual(["click", "type_text", "press_key"])
      const timeline = host.trace.map(row => `${row.name}:${row.phase}`)
      expect(timeline).toEqual(["click:start", "click:end", "type_text:start", "type_text:end", "press_key:start", "press_key:end"])
    } finally { await host.dispose() }
  })

  test("非输入类工具不被这条链挡住：占着桌面时照样能读窗口状态/枚举/用别的域工具", async () => {
    const host = await boot()
    try {
      const held = gate()
      host.registerInput("click", { hold: () => held.promise })
      host.registerReadonly(FULL("get_window_state"))
      host.registerReadonly(FULL("list_windows"))
      host.registerReadonly("scene_list")
      const click = host.call(FULL("click"), async () => undefined)
      await sleep(20)
      expect(host.started("click")).toBe(1)
      // 任一个非输入类工具都不需要等 click 释放：用"先于闸门放行完成"来判，而不是靠时间猜测。
      const readonly = await Promise.race([
        Promise.all([host.call(FULL("get_window_state"), async () => undefined), host.call(FULL("list_windows"), async () => undefined), host.call("scene_list", async () => undefined)]),
        sleep(500).then(() => "TIMED_OUT" as const),
      ])
      expect(readonly).not.toBe("TIMED_OUT")
      expect((readonly as ToolCallResult[]).filter(result => result.isError)).toEqual([])
      expect(host.started("click")).toBe(1)
      held.open()
      expect((await click).isError).toBe(false)
    } finally { await host.dispose() }
  })

  test("前一个输入工具失败不卡死后面的：错误如实返回，控制释放后链继续", async () => {
    const host = await boot()
    try {
      host.registerInput("type_text", { fail: "CUA_INPUT_FAILED: fixture 断言失败" })
      host.registerInput("click")
      const failed = await host.call(FULL("type_text"), async () => undefined)
      expect(failed.isError).toBe(true)
      expect(failed.error?.message ?? "").toContain("CUA_INPUT_FAILED")
      const next = await host.call(FULL("click"), async () => undefined)
      expect(next.isError).toBe(false)
      expect(host.started("click")).toBe(1)
      // 失败那次也走完了 start→end（轨迹完整，不是被吞掉的半截）。
      expect(host.trace.filter(row => row.name === "type_text").map(row => row.phase)).toEqual(["start", "end"])
    } finally { await host.dispose() }
  })

  test("串行等待 >50ms 打一行单飞日志（可观测的占用事实）", async () => {
    const host = await boot()
    try {
      const held = gate()
      host.registerInput("click", { hold: () => held.promise })
      host.registerInput("scroll")
      const logs: string[] = []
      const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")) })
      try {
        const first = host.call(FULL("click"), async () => undefined)
        await sleep(20)
        const second = host.call(FULL("scroll"), async () => undefined)
        await sleep(120)
        held.open()
        await Promise.all([first, second])
      } finally { spy.mockRestore() }
      const singleFlight = logs.filter(line => line.includes("[computer-use-single-flight]"))
      expect(singleFlight.length).toBe(1)
      // 等待时长只算**排队**那段：第一个 click 自己占着桌面 120ms，但它一秒都没排队 —— 不该有它的日志。
      // 修前 waited 在整条链结束后才算，会把 click 的执行耗时记成"串行等待"，于是这里会多出一行假等待。
      expect(singleFlight[0]).toContain(FULL("scroll"))
      expect(singleFlight[0]).not.toContain(FULL("click"))
      expect(singleFlight[0]).toMatch(/串行等待 \d+ms 后执行/)
      // 日志同时给出：本次占用多久、释放后还有几个输入动作在等（"控制释放"可读）。
      expect(singleFlight[0]).toMatch(/本次占用 \d+ms/)
      expect(singleFlight[0]).toContain("释放后仍有 0 个输入动作在等")
    } finally { await host.dispose() }
  })

  test("W22 接线：没有窗口目标的输入在**执行前**就被拒（一个字节都不发）", async () => {
    const host = await boot()
    try {
      host.registerInput("click")
      // 不带 `target`/`pid`：这次输入只能进用户的活动桌面会话全局层 —— 必须拒绝，且工具体从不执行。
      const refused = await host.call(FULL("click"), async () => undefined, {})
      expect(refused.isError).toBe(true)
      expect(refused.error?.message ?? "").toContain("CUA_GLOBAL_INPUT_CONSENT_REQUIRED")
      expect(host.started("click")).toBe(0)                 // 工具体一次都没跑 ⇒ 没有任何输入被合成
      expect(host.trace).toEqual([])
      // 正例对照：同一个工具带上窗口目标后照常执行（不是把输入能力整体关掉）。
      const allowed = await host.call(FULL("click"), async () => undefined)
      expect(allowed.isError).toBe(false)
      expect(host.started("click")).toBe(1)
    } finally { await host.dispose() }
  })

  test("W22 接线：被全局捕获的按键组合在执行前被拒（Super+Alt+S 这类一律不发）", async () => {
    const host = await boot()
    try {
      host.registerInput("hotkey")
      const refused = await host.call(FULL("hotkey"), async () => undefined, { target: { window_id: 4242 }, keys: ["Super+Alt+s"] })
      expect(refused.isError).toBe(true)
      expect(refused.error?.message ?? "").toContain("CUA_A11Y_TOGGLE_REFUSED")
      expect(host.started("hotkey")).toBe(0)
      expect(host.trace).toEqual([])
      // 同一路径下应用内组合照常放行。
      const allowed = await host.call(FULL("hotkey"), async () => undefined, { target: { window_id: 4242 }, keys: ["ctrl+c"] })
      expect(allowed.isError).toBe(false)
      expect(host.started("hotkey")).toBe(1)
    } finally { await host.dispose() }
  })

  test("被串行的动作集合是源码里的闭集：唯一 owner 是 computer-use-input.ts 的 CUA_INPUT_TOOL_NAMES", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "src", "plugin.ts"), "utf8")
    // 这一份列表不再在 plugin.ts 里重抄（重抄正是它会变旧的根因）：plugin.ts 从模块取。
    expect(source).toContain("CUA_INPUT_TOOL_NAMES.map(tool=>`cua_driver_native__${tool}`)")
    expect(source).not.toMatch(/const cuaInputTools=new Set\(\["/)
    expect(source).toContain('ctx.on("tools/execute"')
    // W22-R：`clipboard_write` 这类"没有可恢复路径的全局状态变更"清单也必须从模块取（同一条纪律）。
    expect(source).toContain("CUA_GLOBAL_STATE_TOOL_NAMES.map(tool=>`cua_driver_native__${tool}`)")
    expect(source).not.toMatch(/const cuaGlobalStateTools=new Set\(\["/)
    // 模块里的名字逐个核对：删一个（漏挡真实指针）或加一个（多挡了只读工具）都会红。
    // 两个方向分开断言，红的时候能直接读出"是哪一个名字"。
    const onlyInProduct = [...CUA_INPUT_TOOL_NAMES].filter(name => !(INPUT_TOOLS as readonly string[]).includes(name))
    const onlyInWitness = [...INPUT_TOOLS].filter(name => !(CUA_INPUT_TOOL_NAMES as readonly string[]).includes(name))
    expect(`产品多出：${onlyInProduct.join(",")}`).toBe("产品多出：")
    expect(`见证多出：${onlyInWitness.join(",")}`).toBe("见证多出：")
    expect([...CUA_INPUT_TOOL_NAMES].sort()).toEqual([...INPUT_TOOLS].sort())
  })

  test("手抄常量必须仍是**独立字面量**：改成「从产品导出派生」会让上面那条闭集断言变成恒真", () => {
    // 这条守卫保护的是**守卫本身**（与上一条读 plugin.ts 源码同一种做法）。
    // 派生写法（展开产品导出、或直接赋成产品导出）⇒ 上一条的"逐名相等"就成了同一个数组自己等于自己，
    // 于是"加了工具名忘了改常量"这个场景**再也不会红**——正是派单里担心的那个同类缺陷换了张脸回来。
    const own = readFileSync(join(import.meta.dirname, "cua-input-single-flight.test.ts"), "utf8")
    expect(own).toMatch(/const INPUT_TOOLS = \[/)
    expect(own).not.toMatch(/const\s+INPUT_TOOLS\s*=\s*[^\n]*CUA_INPUT_TOOL_NAMES/)
  })

  test("W22-R3：**不在全表里的**驱动工具名在产品路径上被拒（工具体 0 次、连会话都不开）", async () => {
    const host = await boot()
    try {
      // 模拟"驱动升级后新增了一个工具名"：它带前缀、能被注册，但不在 `CUA_DRIVER_TOOL_CATALOG` 里。
      // 改前这条路径是**第一行 `return next()`** ⇒ 工具体照跑（这就是"表外一律放行"的形状）。
      host.registerInput("brand_new_driver_tool")
      const refused = await host.call(FULL("brand_new_driver_tool"), async () => undefined)
      expect(refused.isError).toBe(true)
      expect(refused.error?.message ?? "").toContain("CUA_DRIVER_TOOL_UNCLASSIFIED")
      expect(host.started("brand_new_driver_tool")).toBe(0)
      expect(host.trace).toEqual([])
      expect(host.desktopCalls).toEqual([])          // 被拒就是被拒：不动桌面设置、不发通知
      // 见证是活的 + 拦截是**精确**的：在册的观测类照旧原样交给驱动。
      host.registerInput("get_window_state")
      const passthrough = await host.call(FULL("get_window_state"), async () => undefined)
      expect(passthrough.isError).toBe(false)
      expect(host.started("get_window_state")).toBe(1)
    } finally { await host.dispose() }
  })

  test("W22-R3：新进拒绝表的两类工具走产品路径被拒（kill_app / get_desktop_state）", async () => {
    const host = await boot()
    try {
      // `kill_app`：没有可恢复路径（kill -9 等价，未保存状态直接丢）⇒ 一条字节都不发。
      host.registerInput("kill_app")
      const killed = await host.call(FULL("kill_app"), async () => undefined, { pid: 4242 })
      expect(killed.isError).toBe(true)
      expect(killed.error?.message ?? "").toContain("CUA_PROCESS_TERMINATION_REFUSED")
      expect(host.started("kill_app")).toBe(0)
      // `get_desktop_state`：整屏像素（含用户其它所有窗口）⇒ 隐私通道，默认不读。
      host.registerInput("get_desktop_state")
      const captured = await host.call(FULL("get_desktop_state"), async () => undefined, {})
      expect(captured.isError).toBe(true)
      expect(captured.error?.message ?? "").toContain("CUA_DESKTOP_CAPTURE_REFUSED")
      expect(host.started("get_desktop_state")).toBe(0)
      expect(host.trace).toEqual([])
      expect(host.desktopCalls).toEqual([])          // 两条都在"开会话之前"就被拒
      // 窗口作用域的替代品照旧可用（不是把观察面整体关掉）。
      host.registerInput("get_window_state")
      expect((await host.call(FULL("get_window_state"), async () => undefined)).isError).toBe(false)
      expect(host.started("get_window_state")).toBe(1)
    } finally { await host.dispose() }
  })

  test("W22-R3：新进输入表的裸指针原语与 `click` 抢同一把锁（宿主级单飞）", async () => {
    const host = await boot()
    try {
      const held = gate()
      host.registerInput("mouse_button_down", { hold: () => held.promise })
      host.registerInput("click")
      const down = host.call(FULL("mouse_button_down"), async () => undefined, { target: { window_id: 4242 }, pid: 777, x: 1, y: 2 })
      await sleep(20)
      expect(host.started("mouse_button_down")).toBe(1)
      const click = host.call(FULL("click"), async () => undefined)
      await sleep(20)
      // 指针还按着（`mouse_button_down` 没释放）：第二个输入动作**还没有开始**。
      expect(host.started("click")).toBe(0)
      held.open()
      const results = await Promise.all([down, click])
      expect(results.filter(result => result.isError)).toEqual([])
      const endDown = host.trace.find(row => row.name === "mouse_button_down" && row.phase === "end")!.at
      const startClick = host.trace.find(row => row.name === "click" && row.phase === "start")!.at
      expect(endDown).toBeLessThanOrEqual(startClick)
    } finally { await host.dispose() }
  })

  test("W22-R：`move_cursor` 进单飞链 —— 它动的是**同一块桌面上唯一的那一个指针**", async () => {
    const host = await boot()
    try {
      const held = gate()
      // `move_cursor` 自带**窗口目标**（驱动契约 `MoveCursorInput.target?` / 扁平 `pid`+`window_id`），
      // 所以它走窗口作用域、照常交付 —— 但必须与 `click` 抢同一把锁（否则"排队点"与"挪指针"会互相踩）。
      host.registerInput("move_cursor", { hold: () => held.promise })
      host.registerInput("click")
      const move = host.call(FULL("move_cursor"), async () => undefined, { target: { window_id: 4242 }, x: 10, y: 20 })
      await sleep(20)
      expect(host.started("move_cursor")).toBe(1)
      const click = host.call(FULL("click"), async () => undefined)
      await sleep(20)
      expect(host.started("click")).toBe(0)          // 指针还占着：第二个输入动作**还没有开始**
      held.open()
      const results = await Promise.all([move, click])
      expect(results.filter(result => result.isError)).toEqual([])
      const endMove = host.trace.find(row => row.name === "move_cursor" && row.phase === "end")!.at
      const startClick = host.trace.find(row => row.name === "click" && row.phase === "start")!.at
      expect(endMove).toBeLessThanOrEqual(startClick)
    } finally { await host.dispose() }
  })

  test("W22-R：`move_cursor` 没有窗口目标时在**执行前**被拒（一个字节都不发）", async () => {
    const host = await boot()
    try {
      host.registerInput("move_cursor")
      // 不带 `target`/`pid`：这次移动只能作用于**用户的活动桌面全局层**（真实指针），必须拒绝。
      const refused = await host.call(FULL("move_cursor"), async () => undefined, { x: 10, y: 20 })
      expect(refused.isError).toBe(true)
      expect(refused.error?.message ?? "").toContain("CUA_GLOBAL_INPUT_CONSENT_REQUIRED")
      expect(host.started("move_cursor")).toBe(0)
      expect(host.trace).toEqual([])
      // 正例对照：同一个工具带上窗口目标后照常执行（不是把 `move_cursor` 整体关掉）。
      const allowed = await host.call(FULL("move_cursor"), async () => undefined, { target: { window_id: 4242 }, x: 10, y: 20 })
      expect(allowed.isError).toBe(false)
      expect(host.started("move_cursor")).toBe(1)
    } finally { await host.dispose() }
  })

  test("W22-R：`clipboard_write` 走产品路径被拒 —— 驱动工具体 0 次、假剪贴板原封不动", async () => {
    const host = await boot()
    try {
      // 假剪贴板：这就是"用户能观察到什么"的见证。**工具体真的跑起来时它会变**（用下面的对照证明），
      // 所以"它没变"只能是因为工具体没被调用，而不是因为这个见证本身是死的。
      const clipboard = { value: "用户刚复制的密码" }
      const writeClipboard = () => { clipboard.value = "agent 写入的内容" }
      host.registerInput("clipboard_write", { onCall: writeClipboard })
      const refused = await host.call(FULL("clipboard_write"), async () => undefined, { text: "agent 写入的内容" })
      expect(refused.isError).toBe(true)
      expect(refused.error?.message ?? "").toContain("CUA_CLIPBOARD_WRITE_REFUSED")
      expect(host.started("clipboard_write")).toBe(0)      // 工具体一次都没跑 ⇒ 没有剪贴板写入
      expect(clipboard.value).toBe("用户刚复制的密码")
      expect(host.desktopCalls).toEqual([])                // 被拒就是被拒：连会话都不开（不动桌面设置、不发通知）
      // 见证是活的：同一个假剪贴板在"允许的工具真的执行"时确实会变。
      host.registerInput("click", { onCall: writeClipboard })
      expect((await host.call(FULL("click"), async () => undefined)).isError).toBe(false)
      expect(clipboard.value).toBe("agent 写入的内容")
      // 而且拦截是**精确**的：既不改用户状态、也不读用户隐私的驱动工具（`get_window_state`）
      // **不在任何一张闭集里**，照旧原样交给驱动 —— 这里只用来证明漏斗不是
      // "凡 `cua_driver_native__*` 一律拦"（改前这条见证用的是 `clipboard_read`；
      // W22-R2 把读侧也收口之后它不再合适，换成表外的工具，见证的语义不变）。
      host.registerInput("get_window_state")
      const passthrough = await host.call(FULL("get_window_state"), async () => undefined)
      expect(passthrough.isError).toBe(false)
      expect(host.started("get_window_state")).toBe(1)
      // 读侧（W22-R2）：`clipboard_read` 是**隐私通道**（读用户剪贴板进 agent 上下文），
      // 与写侧走**同一条漏斗**、同一处 fail-closed（第一判、开会话之前），只是稳定码不同。
      // 注意此刻会话**已经**因为上面那次 `click` 开出来了（`desktopCalls` 非空），所以这里的读数
      // 只能是"这次读**没有新增**任何桌面调用"，不能用"`desktopCalls === []`"。
      const desktopCallsBeforeRead = host.desktopCalls.length
      host.registerInput("clipboard_read")
      const read = await host.call(FULL("clipboard_read"), async () => undefined, { includeText: true })
      expect(read.isError).toBe(true)
      expect(read.error?.message ?? "").toContain("CUA_CLIPBOARD_READ_REFUSED")
      expect(host.started("clipboard_read")).toBe(0)
      expect(host.desktopCalls.length).toBe(desktopCallsBeforeRead)   // 读侧一个字节都没发
    } finally { await host.dispose() }
  })
})


describe("桌面边界在驱动调用前执行", () => {
  test("桌面枚举、伪装为窗口的桌面输入与前台重试不会到达驱动，也不改桌面设置", async () => {
    const host = await boot()
    try {
      host.registerInput("click")
      for (const tool of ["list_windows", "get_accessibility_tree", "get_window_state"]) host.registerReadonly(FULL(tool))
      const cases = [
        ["click", {target:{window_id:4242},scope:"desktop"}],
        ["click", {target:{type:"desktop",display_id:"primary"},window_id:4242,pid:777}],
        ["click", {target:{window_id:4242},delivery_mode:"foreground"}],
        ["list_windows", {}],
        ["get_accessibility_tree", {}],
        ["get_window_state", {window_id:4242}],
      ] as const
      for (const [tool,args] of cases) {
        expect((await host.call(FULL(tool), async()=>undefined, args)).isError).toBe(true)
      }
      expect(host.trace).toEqual([])
      expect(host.desktopCalls).toEqual([])
      expect((await host.call(FULL("list_windows"),async()=>undefined,{pid:777})).isError).toBe(false)
      expect((await host.call(FULL("get_window_state"),async()=>undefined,{pid:777,window_id:4242})).isError).toBe(false)
    } finally { await host.dispose() }
  })
})
