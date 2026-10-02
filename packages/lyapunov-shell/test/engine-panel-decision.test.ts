/**
 * W4 · 引擎面板的"可解释性"回归（W2 条件 D + W5/DEV-008 的能力范围文本）。
 *
 * 三件事必须同时成立：
 *   ① 面板能回答"当前跑的哪个引擎、**为什么是它**（上游 reason 原文）、怎么改回"——
 *      判据全部来自 `script/engine-preference.ts` 的 `resolveEngine()`，插件侧不重新推导；
 *   ② "当前运行"与"已保存偏好"是**两个不同的显示位**（条件 C：偏好已存但本次运行的是另一个引擎时，
 *      面板必须说出"重启后生效"，不能把两者合并成一个值）；
 *   ③ Newton 那一行必须写出**第一切片的能力范围**（状态"已就绪" ≠ 能力与 Isaac/MuJoCo 相当）。
 *      这段措辞由本文件**直接读 `packages/sim-newton/python/worker.py` 的 `CAPABILITIES` 核对**，
 *      且判据**双向**：worker 少一个键要红，**面板少列一个已支持键也要红**——只查"面板提到的
 *      键在 worker 里是不是 True"是单向的，面板把 `list_worlds` 这种已声明、已实现、实测可用的
 *      键排除在"仅 …"之外时它照样绿（DEV-008 复查实测：删掉 `'list_worlds': True` 判据仍 true）。
 *      键集合由本文件**解析** worker.py 得到，不手抄任何清单；Python 侧能力表一变，面板文本就会红
 *      （W5 报的正是"产品说的和实际做的不一致"）。
 *
 * 边界：跑的是真实 `plugin.ts` 路由 + 真实上游判定函数；引擎二进制/解释器是**本机事实**
 * （本环境 isaac-env 不存在、newton-env 存在），所以涉及"哪一档胜出"的断言一律拿
 * `resolveEngine()` 在测试里现算的期望值比对，不写死 isaac/mujoco。
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import JobsLocal from "@deepseek-ai/dsh-jobs-local"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import ToolRuntime from "@deepseek-ai/dsh-tools"
import { ENGINE_CHOICES, resolveEngine, writeEnginePreference } from "../../../script/engine-preference.ts"
import { backendEnvironment } from "../../../script/profile.ts"
import { resolveSdkPython } from "../../lyapunov-product-bundle/src/sdk-python.mjs"
import { runtimePaths } from "../../lyapunov-product-bundle/src/runtime-paths.ts"
import { isolateProviderInstaller } from "./fixtures/isolated-provider-installer.ts"

const PRODUCT_ROOT = resolve(import.meta.dirname, "..", "..", "..")
/** Provider 能力表的权威文件。`LYAPUNOV_NEWTON_WORKER_PATH` 只用于把它指向另一份**副本**
 * （负对照用，不是产品开关；与 `sim-newton/test/supported-surface-truth.test.ts` 同一形态）。 */
const workerPath = () => process.env.LYAPUNOV_NEWTON_WORKER_PATH ?? join(PRODUCT_ROOT, "packages", "sim-newton", "python", "worker.py")
interface ProviderRow { id: string; kind: string; installed: boolean; detail: string; engineChoice: string | null; prefix: string; runtimePython: string; runtimeSource: string; managedStatus: string }
interface EngineCandidate { engine: string; ready: boolean; blockers: string[]; scope?: string }
interface EngineChoice { engine: string; source: string; reason: string; candidates?: EngineCandidate[] }
interface EngineDecision { running: string | null; preference: string | null; runtime: EngineChoice | null; next: EngineChoice | null; gpu: { accelerator: string; state: string; headline: string } | null; restartRequired: boolean; error?: string }
interface ProvidersPayload { runningEngine: string | null; preference: string | null; choices: readonly string[]; engineDecision: EngineDecision; providers: ProviderRow[] }

let root: string | undefined
const savedEngine = process.env.LYAPUNOV_SIM_ENGINE
const savedPreferenceFile = process.env.LYAPUNOV_ENGINE_PREFERENCE_FILE
const savedSdkPaths = { mujoco: process.env.LYAPUNOV_MUJOCO_PYTHON, isaac: process.env.LYAPUNOV_ISAAC_PYTHON, newton: process.env.LYAPUNOV_NEWTON_PYTHON }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lyapunov-w4-engine-panel-"))
  // 每条用例使用临时偏好文件，不能读取真人已保存的SDK选择；显式env优先级仍由原断言核验。
  process.env.LYAPUNOV_ENGINE_PREFERENCE_FILE = join(root, "isolated-preference.json")
})
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
  if (savedEngine === undefined) delete process.env.LYAPUNOV_SIM_ENGINE; else process.env.LYAPUNOV_SIM_ENGINE = savedEngine
  if (savedPreferenceFile === undefined) delete process.env.LYAPUNOV_ENGINE_PREFERENCE_FILE; else process.env.LYAPUNOV_ENGINE_PREFERENCE_FILE = savedPreferenceFile
  if (savedSdkPaths.mujoco === undefined) delete process.env.LYAPUNOV_MUJOCO_PYTHON; else process.env.LYAPUNOV_MUJOCO_PYTHON = savedSdkPaths.mujoco
  if (savedSdkPaths.isaac === undefined) delete process.env.LYAPUNOV_ISAAC_PYTHON; else process.env.LYAPUNOV_ISAAC_PYTHON = savedSdkPaths.isaac
  if (savedSdkPaths.newton === undefined) delete process.env.LYAPUNOV_NEWTON_PYTHON; else process.env.LYAPUNOV_NEWTON_PYTHON = savedSdkPaths.newton
})

/** 最薄宿主：真实 cordis/工具注册表；场景/世界/会话面只保留被测代码用到的调用形状。 */
async function boot() {
  const workspace = root!
  const ctx = new Context() as any
  await ctx.plugin(JobsLocal as never)
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const definitions = new Map<string, { name: string; input?: { hint?: string }; description?: string }>()
  const namespaces = new Set<string>()
  ctx.provide("connection", { fetch: { register: (entry: { path: string; fetch: (request: Request) => Promise<Response> }) => { routes.set(entry.path, entry.fetch); return () => routes.delete(entry.path) } } })
  ctx.provide("settings", { register: (ns: string) => { namespaces.add(ns); return () => namespaces.delete(ns) }, describe: () => [...namespaces].map(ns => ({ ns, user: undefined, revision: 1, value: {} })), mutate: async () => undefined, replace: async () => undefined })
  ctx.provide("scene", { forSession: () => ({ scene: { snapshot: async (sceneId: string) => ({ sceneId, revision: 0, entities: [] }) }, list: async () => [] }) })
  ctx.provide("sim", { forSession: () => ({ listWorlds: async () => [], dispose: async () => {} }), has: () => false, sessions: () => [] })
  ctx.provide("agents", { get: () => undefined })
  ctx.provide("sessions", { flush: async () => undefined })
  ctx.provide("sessionController", { resolveAgent: async () => ({ error: new Error("SESSION_NOT_FOUND: fixture") }) })
  ctx.provide("sessionQuery", { observeSession: async () => undefined })
  ctx.provide("commands", { register: (definition: { name: string; input?: { hint?: string } }) => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) }, execute: async () => undefined })
  ctx.provide("attachments", { saveImage: async () => ({}), readImage: async () => ({ data: new Uint8Array() }) })
  await ctx.plugin(SystemPrompt as never, { personaPrefix: "", personaSuffix: "" } as never)
  await ctx.plugin(ToolRuntime as never)

  const installerIsolation = isolateProviderInstaller(workspace)
  try {
    const { apply } = await import("../src/plugin.ts")
    await apply(ctx as never, { captureRoot: join(workspace, "captures"), recordingRoot: join(workspace, "recordings") } as never)
    installerIsolation.assertCalled()
  } finally { installerIsolation.restore() }

  const panel = async (): Promise<ProvidersPayload> => {
    const response = await routes.get("/api/lyapunov/engine-providers")!(new Request("http://test/api/lyapunov/engine-providers"))
    expect(response.status).toBe(200)
    return await response.json() as ProvidersPayload
  }
  /** 走真实 POST endpoint（与设置页同一个）：写偏好 / 写 `"auto"` 清除显式偏好。 */
  const prefer = async (engine: unknown): Promise<Record<string, unknown>> => {
    const response = await routes.get("/api/lyapunov/engine-preference")!(new Request("http://test/api/lyapunov/engine-preference", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine }) }))
    expect(response.status).toBe(200)
    return await response.json() as Record<string, unknown>
  }
  const dispose = async () => { try { await ctx.fiber.dispose() } finally { await rm(workspace, { recursive: true, force: true }) } }
  return { panel, prefer, definitions, dispose }
}

/** 上游在"没有本次启动参数"时会给的答案（面板的"应该是什么/为什么"就用它，测试也用它算期望）。 */
const upstreamNext = () => resolveEngine({ productRoot: PRODUCT_ROOT, env: { ...process.env, LYAPUNOV_SIM_ENGINE: undefined } })
/** 只模拟解释器的发现/版本回执；不导入 MuJoCo，不写产品的托管安装前缀。 */
function externalMujocoPython(): string {
  const prefix = join(root!, "external-mujoco")
  const python = join(prefix, "bin/python")
  mkdirSync(dirname(python), { recursive: true })
  mkdirSync(join(prefix, "lib/python3.12/site-packages/mujoco"), { recursive: true })
  writeFileSync(python, '#!/bin/sh\nif [ "$3" = "mujoco" ]; then printf "SDK_PROBE_FOUND\\n"; else printf "3.13.0\\n"; fi\n')
  chmodSync(python, 0o755)
  return python
}
/**
 * 面板的 Newton 能力范围文本是否还与 Provider 的能力表一致。**判据是集合相等、且双向**：
 *   · worker `supported` 的键，面板"仅 …"里一个都不能少（**面板少列已支持键 ⇒ 红**）；
 *   · 面板"仅 …"里写着的键，worker 必须真的支持（**worker 少一个键 ⇒ 红**）。
 * 两边的键集合都是**解析**出来的（worker 侧解析 `CAPABILITIES`，面板侧解析渲染出来的 detail），
 * 本文件不手抄任何一份清单 —— 手抄的清单会和它要保护的东西一起过期。
 *
 * 另外两条同族判据（都只钉**语义**，不钉源码怎么写）：
 *   · 面板说"不可用"的键必须真的不在 `supported` 里（"能用却说不能用"的反向假声明）；
 *   · 动作拒绝码取 worker 里**解析出来的值**。旧判据钉的是源码字面量
 *     `'execute': {kind: 'ACTION_UNSUPPORTED' for kind in ACTION_KINDS}`，worker 把码抽成
 *     `ACTION_UNSUPPORTED_CODE` 常量之后，这条判据自己就红了 —— 那是守卫的病，不是产品缺陷；
 *     现在改成解析常量表取**值**：常量改名照样绿，**值**变了才红（面板还写着旧码就是假声明）。
 */
interface WorkerCapabilities {
  /** `supported` 里真值为 True 的键（`CAPABILITIES['supported'][k] = False` 这类后置赋值会把它摘掉）。 */
  supported: string[]
  /** `unsupported` 子表里声明的键。 */
  unsupported: string[]
  /** 动作通道的拒绝码（源码里是常量，这里取解析出来的值）。 */
  refusalCodes: string[]
}

/** 花括号配平取块（跳过单引号字符串与 `#` 注释）：块内还有嵌套的 `{}`，不能用正则一刀切。 */
const bracedBlock = (text: string, from: number): string | undefined => {
  const open = text.indexOf("{", from)
  if (open < 0) return undefined
  let depth = 0
  let quote = false
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (quote) { if (char === "'") quote = false; continue }
    if (char === "'") { quote = true; continue }
    if (char === "#") { const newline = text.indexOf("\n", index); if (newline < 0) return undefined; index = newline; continue }
    if (char === "{") depth += 1
    else if (char === "}") { depth -= 1; if (depth === 0) return text.slice(open, index + 1) }
  }
  return undefined
}

/** 解析 worker.py 的 `CAPABILITIES`。解析不出来一律返回 undefined ⇒ 判据转红（守卫不许静默失效）。 */
const parseWorkerCapabilities = (worker: string): WorkerCapabilities | undefined => {
  const anchor = worker.search(/^CAPABILITIES\s*=\s*\{/m)
  if (anchor < 0) return undefined
  const block = bracedBlock(worker, anchor)
  if (block === undefined) return undefined
  const subBlock = (name: string) => {
    const at = new RegExp(`'${name}'\\s*:\\s*\\{`).exec(block)
    return at === null ? undefined : bracedBlock(block, at.index)
  }
  const supportedBlock = subBlock("supported")
  const unsupportedBlock = subBlock("unsupported")
  if (supportedBlock === undefined || unsupportedBlock === undefined) return undefined
  const keysOf = (text: string) => [...text.matchAll(/'([^']+)':/g)].map(match => match[1]!)
  // 真值为 True 的键才算 supported（`unsupported` 子表里被改成 True 的键也算 —— 那等于提前支持了）。
  const declaredTrue = [...new Set([...block.matchAll(/'([^']+)':\s*True\b/g)].map(match => match[1]!))]
  const assigned = new Map<string, boolean>()
  for (const match of worker.matchAll(/CAPABILITIES\['supported'\]\['([^']+)'\]\s*=\s*(True|False)/g)) assigned.set(match[1]!, match[2] === "True")
  const supported = declaredTrue.filter(key => assigned.get(key) !== false)
  const constants = new Map([...worker.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*'([^']*)'\s*$/gm)].map(match => [match[1]!, match[2]!]))
  const executeEntry = /'execute':\s*(\{[^\n]*\}|'[^']*')/.exec(unsupportedBlock)?.[1] ?? ""
  const refusalCodes = [...new Set([
    ...[...executeEntry.matchAll(/'([^']*)'/g)].map(match => match[1]!),
    ...[...executeEntry.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)].map(match => constants.get(match[1]!)).filter((value): value is string => value !== undefined),
  ])]
  return { supported, unsupported: keysOf(unsupportedBlock), refusalCodes }
}

/** 面板措辞的骨架：`第一切片能力范围：仅 <键>/<键>/…；<不可用说明>不可用`（见 plugin.ts 的 NEWTON_SLICE）。 */
const PANEL_SLICE = /第一切片能力范围：仅 ([^；]+)；/

/** 面板文案里**声明为可用**的键集合。骨架被改坏 ⇒ 返回 undefined ⇒ 判据转红（不静默放过）。 */
const panelSliceKeys = (panelText: string): string[] | undefined => {
  const clause = PANEL_SLICE.exec(panelText)?.[1]
  if (clause === undefined) return undefined
  const keys = clause.split("/").map(key => key.trim()).filter(Boolean)
  return keys.length === 0 ? undefined : keys
}

/** 面板文案里"不可用"那半句（"仅 …；" 之后到 `不可用` 之前）。 */
const panelUnavailableClause = (panelText: string): string => {
  const match = PANEL_SLICE.exec(panelText)
  const after = panelText.slice(match === null ? 0 : match.index + match[0].length)
  const end = after.indexOf("不可用")
  return end < 0 ? after : after.slice(0, end)
}

const sameKeySet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && [...left].sort().join("\u0000") === [...right].sort().join("\u0000")

/** 正向用例与全部负对照共用**同一份**判据（避免"负对照验的不是正例那条"）。 */
const panelSliceMatchesWorker = (worker: string, panelText: string): boolean => {
  const capabilities = parseWorkerCapabilities(worker)
  const claimed = panelSliceKeys(panelText)
  if (capabilities === undefined || claimed === undefined) return false
  // ① 双向集合相等：面板少列已支持键 ⇒ 红；worker 少一个键（或把键挪走）⇒ 红。
  if (!sameKeySet(claimed, capabilities.supported)) return false
  // ② 面板说"不可用"的键必须真的不在 supported 里（能用却说不能用）。
  const declared = new Set([...capabilities.supported, ...capabilities.unsupported])
  for (const token of panelUnavailableClause(panelText).match(/[A-Za-z_][A-Za-z0-9_.]*/g) ?? []) {
    if (declared.has(token) && capabilities.supported.includes(token)) return false
  }
  // ③ 面板写出的动作拒绝码必须等于 worker 解析出来的值。
  if (capabilities.refusalCodes.length === 0) return false
  return capabilities.refusalCodes.every(code => panelText.includes(code))
}

describe("引擎面板必须能解释'为什么是它'（W2 条件 D）", () => {
  test("local 子 Host 的有界环境进入真实设置页后，外置解释器来源仍与父进程一致", async () => {
    const external = externalMujocoPython()
    const parent: NodeJS.ProcessEnv = { PATH: process.env.PATH, LYAPUNOV_MUJOCO_PYTHON: external, LYAPUNOV_ISAAC_PYTHON: join(root!, "external/isaac/bin/python"), LYAPUNOV_NEWTON_PYTHON: join(root!, "external/newton/bin/python"), DEEPSEEK_API_KEY: "fake-parent-secret" }
    const env = await backendEnvironment("local", runtimePaths({ mode: "local", root: join(root!, "runtime") }), { parent })
    expect(env.DEEPSEEK_API_KEY).toBeUndefined()
    const savedMode = process.env.LYAPUNOV_MODE, savedSecret = process.env.DEEPSEEK_API_KEY
    try {
      process.env.LYAPUNOV_MODE = env.LYAPUNOV_MODE
      delete process.env.DEEPSEEK_API_KEY
      for (const key of ["LYAPUNOV_MUJOCO_PYTHON", "LYAPUNOV_ISAAC_PYTHON", "LYAPUNOV_NEWTON_PYTHON"] as const) process.env[key] = env[key]
      process.env.LYAPUNOV_SIM_ENGINE = "mujoco"
      process.env.LYAPUNOV_ENGINE_PREFERENCE_FILE = join(root!, "local-preference.json")
      const host = await boot()
      try {
        const row = (await host.panel()).providers.find(item => item.id === "mujoco")!
        expect(row).toMatchObject({ installed: true, runtimePython: external, runtimeSource: "env-override", managedStatus: "missing" })
        expect(row.detail).not.toContain("未安装（前缀不存在）")
      } finally { await host.dispose() }
    } finally {
      if (savedMode === undefined) delete process.env.LYAPUNOV_MODE; else process.env.LYAPUNOV_MODE = savedMode
      if (savedSecret === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = savedSecret
    }
  })

  test("外置 MuJoCo 可发现而托管前缀缺失：两种状态分列，切回 Auto 不热切当前 Host", async () => {
    const managedPython = resolveSdkPython(PRODUCT_ROOT, "mujoco", { ...process.env, LYAPUNOV_MUJOCO_PYTHON: undefined }).python
    expect(existsSync(dirname(dirname(managedPython)))).toBe(false)
    const external = externalMujocoPython()
    process.env.LYAPUNOV_MUJOCO_PYTHON = external
    process.env.LYAPUNOV_SIM_ENGINE = "mujoco"
    process.env.LYAPUNOV_ENGINE_PREFERENCE_FILE = join(root!, "engine-external.json")
    const host = await boot()
    try {
      const before = await host.panel()
      const row = before.providers.find(item => item.id === "mujoco")!
      expect(before.runningEngine).toBe("mujoco")
      expect(before.engineDecision.next!.candidates?.find(item => item.engine === "mujoco")?.ready).toBe(true)
      expect(row).toMatchObject({ installed: true, version: "3.13.0", runtimePython: external, runtimeSource: "env-override", prefix: dirname(dirname(managedPython)), managedStatus: "missing" })
      expect(row.detail).toContain("当前解释器可发现 mujoco")
      expect(row.detail).not.toContain("未安装（前缀不存在）")
      expect((await host.prefer("isaac")).runningEngine).toBe("mujoco")
      expect((await host.panel()).providers.find(item => item.id === "mujoco")?.detail).toContain("来源：用户偏好")
      expect((await host.prefer("auto")).preference).toBeNull()
      const after = await host.panel()
      expect(after.runningEngine).toBe("mujoco")
      expect(after.preference).toBeNull()
      expect(after.engineDecision.next?.source).toBe("default")
      expect(after.providers.find(item => item.id === "mujoco")?.installed).toBe(true)
      expect(after.providers.find(item => item.id === "mujoco")?.detail).not.toContain("来源：用户偏好")
    } finally { await host.dispose() }
  })

  test("没有外置覆盖且托管前缀缺失：当前解释器与托管安装均明确不可用", async () => {
    delete process.env.LYAPUNOV_MUJOCO_PYTHON
    process.env.LYAPUNOV_ENGINE_PREFERENCE_FILE = join(root!, "engine-missing.json")
    const managedPython = resolveSdkPython(PRODUCT_ROOT, "mujoco", process.env).python
    expect(existsSync(dirname(dirname(managedPython)))).toBe(false)
    const host = await boot()
    try {
      const row = (await host.panel()).providers.find(item => item.id === "mujoco")!
      expect(row).toMatchObject({ installed: false, runtimePython: managedPython, runtimeSource: "package-default", prefix: dirname(dirname(managedPython)), managedStatus: "missing" })
      expect(row.detail).toContain("解释器不存在")
    } finally { await host.dispose() }
  })

  test("当前运行的引擎那一行带上游 reason 原文；running 与 preference 是两个显示位", async () => {
    process.env.LYAPUNOV_SIM_ENGINE = "mujoco"
    // 偏好文件指到一个不存在的临时路径：不读用户主目录里真实的偏好（否则断言会随开发机漂移）。
    process.env.LYAPUNOV_ENGINE_PREFERENCE_FILE = join(root!, "absent-engine.json")
    const host = await boot()
    try {
      const payload = await host.panel()
      const expected = upstreamNext()
      // ① "当前运行"与"偏好"分开两个字段（面板页头分别渲染），没有被合并成一个值。
      expect(payload.runningEngine).toBe("mujoco")
      expect(payload.preference).toBeNull()
      // ② 判定对（上游原话）：runtime=本次进程实际装配值，next=清掉启动参数后按偏好/默认会选谁。
      expect(payload.engineDecision.running).toBe("mujoco")
      expect(payload.engineDecision.runtime).toEqual({ engine: "mujoco", source: "environment", reason: "来源：LYAPUNOV_SIM_ENGINE" })
      expect(payload.engineDecision.next!.engine).toBe(expected.engine)
      expect(payload.engineDecision.next!.reason).toBe(expected.reason)
      // ③ 面板那一行（运行中的引擎）真的带出了上游 reason 原文——不是一个插件自己编的说法。
      const runningRow = payload.providers.find(row => row.engineChoice === "mujoco")!
      expect(runningRow.detail).toContain(expected.reason)
      // ④ 条件 D（Isaac 未就绪 ⇒ 默认回退 mujoco）时，回退理由里要有解释器落点与"怎么改回"。
      if (expected.source === "default" && expected.engine === "mujoco") {
        const isaac=expected.auto!.candidates.find(candidate=>candidate.engine==="isaac")!
        expect(isaac.ready).toBe(false)
        expect(isaac.blockers.length).toBeGreaterThan(0)
        for(const blocker of isaac.blockers) expect(expected.reason).toContain(blocker)
        expect(expected.reason).toContain("下次启动才会优先 isaac")
        expect(expected.reason).not.toContain("装好后自动改回 isaac")
        expect(runningRow.detail).toContain("下次启动才会优先 isaac")
      }
      // ⑤ **顺序无关**（2026-09-26，W21 探测副作用的回归）：上面的等值断言要求"面板探一次"与
      //    "测试再探一次"给出同一句话。这里把该前提**显式钉住**，而不是默默依赖它 ——
      //    `upstreamNext()` 内部走的 `probeGpuFacts()` 会跑 nvidia-smi，而 nvidia-smi 自己
      //    会在 /dev 里留下条目（本机实测：凭空创建 /dev/nvidia-caps，**失败也创建**）。
      //    若探测又变成"第几次调用决定读数"，第 3 次探测立刻在这里红，
      //    而不是只在某个用例顺序下红（见 environment-readiness.test.ts 的探测顺序无关用例）。
      const again = upstreamNext()
      expect(again.reason).toBe(expected.reason)
      expect(again.engine).toBe(expected.engine)
      expect(again.source).toBe(expected.source)
    } finally { await host.dispose() }
  })

  test("已存偏好与本次运行不同（条件 C）：面板说清'重启后生效'，且偏好读回值不被合并进运行值", async () => {
    const preferenceFile = join(root!, "engine.json")
    process.env.LYAPUNOV_ENGINE_PREFERENCE_FILE = preferenceFile
    writeEnginePreference("isaac", { ...process.env, LYAPUNOV_ENGINE_PREFERENCE_FILE: preferenceFile })
    process.env.LYAPUNOV_SIM_ENGINE = "mujoco"
    const host = await boot()
    try {
      const payload = await host.panel()
      // 偏好是 isaac，但本次装配的是 mujoco：两个显示位各自如实。
      expect(payload.runningEngine).toBe("mujoco")
      expect(payload.preference).toBe("isaac")
      expect(payload.engineDecision.next!.engine).toBe("isaac")
      expect(payload.engineDecision.next!.source).toBe("preference")
      expect(payload.engineDecision.next!.reason).toBe("来源：用户偏好")
      expect(payload.engineDecision.restartRequired).toBe(true)
      // isaac 那一行：上游 reason 原文 + "重启后生效"（用户问"我明明设了 Isaac 怎么在跑 MuJoCo"的答案）。
      const isaacRow = payload.providers.find(row => row.engineChoice === "isaac")!
      expect(isaacRow.detail).toContain("来源：用户偏好")
      expect(isaacRow.detail).toContain("重启后生效")
      expect(isaacRow.detail).toContain("mujoco")
    } finally { await host.dispose() }
  })

  test("缺省/自动模式：面板给出候选与回退理由，且 isaac 行只报安装候选/许可/GPU 候选事实（无 UNVERIFIED 推断）", async () => {
    process.env.LYAPUNOV_SIM_ENGINE = "mujoco"
    process.env.LYAPUNOV_ENGINE_PREFERENCE_FILE = join(root!, "absent-engine.json")
    const host = await boot()
    try {
      const payload = await host.panel()
      const expected = upstreamNext()
      // ① GPU 事实与自动判定**同一份读数**随决策下发（不是面板另探一遍或另编一句）。
      expect(payload.engineDecision.gpu).not.toBeNull()
      expect(typeof payload.engineDecision.gpu!.headline).toBe("string")
      // ② 自动判定（三层都没配置）时，next 必须是上游原话 + 两格候选逐条判据。
      if (expected.source === "default") {
        expect(payload.engineDecision.next!.engine).toBe(expected.engine)
        expect(payload.engineDecision.next!.reason).toBe(expected.reason)
        expect(payload.engineDecision.next!.candidates?.map(row => row.engine).sort()).toEqual(["isaac", "mujoco"])
        // Isaac 只要没被选中，就至少要有一条 blocker（不静默）。
        const isaacCandidate = payload.engineDecision.next!.candidates!.find(row => row.engine === "isaac")!
        if (expected.engine !== "isaac") expect(isaacCandidate.ready).toBe(false)
      }
      // ③ isaac 行把"安装候选 / 解释器发现核对 / 许可留痕 / GPU 候选事实（含检测范围）"分开写。
      //    **不写"尚未打开过世界"**（复核点 1：安装器无权推断用户从未打开过），也不把文件存在当 RTX 验收。
      const isaacRow = payload.providers.find(row => row.id === "isaac")!
      expect(isaacRow.detail).toContain("许可")
      expect(isaacRow.detail).toContain("GPU 候选")
      expect(isaacRow.detail).toContain("检测范围")
      expect(isaacRow.detail).not.toContain("尚未打开过世界")
      expect(isaacRow.detail).not.toContain("UNVERIFIED")
    } finally { await host.dispose() }
  })

  test("复核点 3：显式 auto 清除手动偏好并可读回；CLI/env 显式引擎仍优先", async () => {
    const preferenceFile = join(root!, "engine-auto.json")
    process.env.LYAPUNOV_ENGINE_PREFERENCE_FILE = preferenceFile
    process.env.LYAPUNOV_SIM_ENGINE = "mujoco"
    const host = await boot()
    try {
      // 先写一个手动偏好并读回。
      const manual = await host.prefer("mujoco")
      expect(manual.preference).toBe("mujoco")
      expect((await host.panel()).preference).toBe("mujoco")
      // 再显式回到 auto：同一 endpoint / 同一偏好文件，清除 `engine` 键。
      const auto = await host.prefer("auto")
      expect(auto.preference).toBeNull()
      expect(auto.restartRequired).toBe(true)
      expect(String(auto.restartHint)).toContain("自动")
      const after = await host.panel()
      expect(after.preference).toBeNull()
      // 回落缺省/自动判定：本次运行（mujoco，由环境变量决定）不变，next 才是缺省判定。
      expect(after.engineDecision.running).toBe("mujoco")
      expect(after.engineDecision.next!.source).toBe("default")
    } finally { await host.dispose() }
  })

  test("复核点 4：isaac 行的 SDK 状态区分安装候选与解释器发现核对，不再自称'SDK 已装入'", async () => {
    process.env.LYAPUNOV_SIM_ENGINE = "mujoco"
    process.env.LYAPUNOV_ENGINE_PREFERENCE_FILE = join(root!, "absent-engine.json")
    const host = await boot()
    try {
      const isaacRow = (await host.panel()).providers.find(row => row.id === "isaac")!
      // 无论本机装没装：措辞里不能出现旧的"SDK 已装入（可运行）"式断言；三态各自说清。
      expect(isaacRow.detail).not.toContain("SDK 已装入")
      if (!existsSync(isaacRow.runtimePython)) expect(isaacRow.detail).toContain(`解释器不存在：${isaacRow.runtimePython}`)
      else expect(isaacRow.detail).toMatch(/安装候选|未命中/)
    } finally { await host.dispose() }
  })

  test("`ui_engine_switch` 的 input.hint 列出全部真实取值（与 ENGINE_CHOICES 同源，不再手抄）", async () => {
    const host = await boot()
    try {
      const definition = host.definitions.get("ui_engine_switch")
      expect(definition).toBeDefined()
      const hint = definition!.input?.hint ?? ""
      // 每一个真实取值都出现在 hint 里（含 newton/none/benchmark——旧文案只写了 isaac|mujoco）。
      expect(ENGINE_CHOICES.filter(choice => !hint.includes(choice))).toEqual([])
      expect(hint).toContain("omitting engine is read-only")
    } finally { await host.dispose() }
  })
})

describe("Newton 面板文本与实际能力范围同源（W5/DEV-008）", () => {
  test("newton 行写明第一切片范围，且与 worker.py 的 CAPABILITIES **双向**一致", async () => {
    const host = await boot()
    try {
      const payload = await host.panel()
      const row = payload.providers.find(item => item.id === "newton")!
      expect(row.detail).toContain("第一切片能力范围")
      expect(row.detail).toContain("不可用")
      const worker = readFileSync(workerPath(), "utf8")
      const capabilities = parseWorkerCapabilities(worker)
      // 解析失败 ⇒ 守卫失效，必须先红（而不是把"解析不出来"当成"一致"）。
      expect(capabilities).toBeDefined()
      // ① 面板文案里提到的键集合 == worker supported 里与面板相关的键集合（两边都是解析出来的）。
      expect(panelSliceKeys(row.detail)?.slice().sort()).toEqual([...capabilities!.supported].sort())
      // ② 合起来的判据（含"不可用"半句与动作拒绝码）也必须成立。
      expect(panelSliceMatchesWorker(worker, row.detail)).toBe(true)
    } finally { await host.dispose() }
  })

  test("双向守卫的两个方向都必须红：worker 少一个键、面板少列一个已支持键（负对照以文本变异模拟）", async () => {
    const host = await boot()
    try {
      const panelText = (await host.panel()).providers.find(item => item.id === "newton")!.detail
      const worker = readFileSync(workerPath(), "utf8")
      // 基线：真文件 + 真面板文案必须绿（否则下面的"变红"可能只是环境噪声）。
      expect(panelSliceMatchesWorker(worker, panelText)).toBe(true)

      // 方向 ①：**worker 少一个键**（面板仍写着它）⇒ 红。
      const workerLost = worker.replace("        'list_worlds': True,\n", "")
      expect(workerLost).not.toBe(worker)
      expect(panelSliceMatchesWorker(workerLost, panelText)).toBe(false)

      // 方向 ②：**面板少列一个已支持键**（worker 仍支持它）⇒ 必须红。
      // 这正是旧判据缺的方向：旧判据只问"面板提到的键在 worker 里是不是 True"，
      // 面板少写一个键它照样绿（DEV-008 复查实测：删 `'list_worlds': True` ⇒ 旧判据仍 true）。
      expect(panelText).toContain("/list_worlds") // 变异点必须真的存在，否则下面那条是空真
      const panelShort = panelText.replace("/list_worlds", "")
      expect(panelShort).not.toBe(panelText)
      expect(panelSliceMatchesWorker(worker, panelShort)).toBe(false)

      // 方向 ③：**worker 多一个键**（能力表前进一格、面板还没写）⇒ 也红（同族：面板少列已支持键）。
      const workerExtra = worker.replace("        'urdf': True,\n", "        'urdf': True,\n        'teleport': True,\n")
      expect(workerExtra).not.toBe(worker)
      expect(panelSliceMatchesWorker(workerExtra, panelText)).toBe(false)

      // 方向 ④：**反向假声明**——worker 把 capture 提前变成可用 ⇒ 面板还说"相机…不可用" ⇒ 红。
      // （旧用例只验了这一族方向，所以"面板少列"那半边没人看着。）
      const workerAdvanced = worker.replace("'capture': 'UNSUPPORTED_CAPABILITY'", "'capture': True")
      expect(workerAdvanced).not.toBe(worker)
      expect(panelSliceMatchesWorker(workerAdvanced, panelText)).toBe(false)

      // 方向 ⑤：**动作拒绝码的"值"变了** ⇒ 面板还写着旧码 ⇒ 红。
      // 注意这里变的是**值**不是写法：worker 把码抽成常量（`ACTION_UNSUPPORTED_CODE`）时本判据
      // 不该红——旧判据就是在那里红的（它钉的是源码字面量）。
      const workerRecoded = worker.replace("ACTION_UNSUPPORTED_CODE = 'ACTION_UNSUPPORTED'", "ACTION_UNSUPPORTED_CODE = 'ACTION_UNSUPPORTED_V2'")
      expect(workerRecoded).not.toBe(worker)
      expect(panelSliceMatchesWorker(workerRecoded, panelText)).toBe(false)

      // 方向 ⑥：**面板措辞骨架被改坏**（解析不出来）⇒ 红，不静默放过。
      const panelBroken = panelText.replace("；", "，")
      expect(panelBroken).not.toBe(panelText)
      expect(panelSliceMatchesWorker(worker, panelBroken)).toBe(false)
    } finally { await host.dispose() }
  })
})
