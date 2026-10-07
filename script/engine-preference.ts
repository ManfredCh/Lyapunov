/**
 * 物理引擎偏好：**唯一 owner**，落 `~/.config/lyapunov/engine.json`。
 *
 * 为什么需要它：`ctx.sim` 的 Provider 在 Host 启动时按 `--engine` 装配（`runtimePluginInsert`
 * 只为选中的引擎插入插件），**运行中的 Host 无法换引擎**——一个世界只能有一个 Provider 独占
 * model/data/clock（合同 §0.2、§2.8）。所以"切换引擎"在物理上是"用另一个引擎重启 Host"。
 *
 * 设计取舍（守合同"最简"约束）：
 *  · **不新建第二套偏好系统**：本文件只是一个键的小读写，UI 与启动器共用它，不复制设置框架。
 *  · **不在 UI 里偷偷重启 Host**：重启会打断活动会话与运行中的动作。UI 只写偏好不容易 + 明示"下次启动生效"。
 *  · 解析优先级（`resolveEngine()`，所有正常启动入口共用这一份）：
 *    `--engine` 显式参数 > `LYAPUNOV_SIM_ENGINE` 环境变量 > 本文件 > 代码默认。
 *
 * 默认值由 `defaultEngine()` 给出：**缺省/自动模式**在 Isaac 的 SDK、许可与 GPU 三项条件都具备时
 * 首选 `isaac`，否则回退 `mujoco`，并**把逐条理由打印出来**（不会静默换引擎）。三项条件各自是
 * **一次可复算的探测**——`sdkRuntimeFacts()` 确认"安装候选命中"且**选定解释器能发现** `isaacsim`
 * （空壳 venv 与孤立 dist-info 都不算），`readEngineLicenses()` 确认用户**显式**接受过 EULA，
 * `gpuRuntimeDecision()` 确认本会话**加速器**可用。缺任何一项都回退，且理由里点名缺的是哪一项、怎么补。
 *
 * ⚠️ **"装好"只是候选事实，不等于打开过世界、也不等于 RTX 就绪**：这里只报可复算的探测事实。
 * GPU 一格复用的是"设备/驱动/CUDA 加速器可用"，**不证明** Isaac RTX 兼容（CUDA-only 卡可能没有
 * RTX）——面板对 isaac 行如实标明这个检测范围；真实能否出图由当前 world 回执决定。
 * ⚠️ **手动偏好优先于自动**：从设置页显式选过引擎（含 `"auto"` 清除偏好）后，按偏好执行；只有
 * 偏好层为自动时，Isaac 条件具备才会在**下次启动**被优先，手动偏好本身不被自动逻辑改写。
 * ⚠️ **显式选择绝不被自动逻辑覆盖**：`--engine isaac`、`LYAPUNOV_SIM_ENGINE=isaac` 与用户手动偏好
 * （非 `"auto"`）优先于自动判定；即使 GPU/许可/SDK 不满足也如实采用，让运行期按真实错误报
 * （**不偷偷换成 MuJoCo**——真实世界的启动失败不能被当成"普通缺 GPU"而静默切引擎）。
 * ⚠️ **运行中的世界不因偏好变化被切换**：偏好只写文件，`resolveEngine()` 对已运行的 `LYAPUNOV_SIM_ENGINE`
 * 始终给出同一个值——换引擎需要重启 Host（一个世界只能有一个 Provider 独占 model/data/clock）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { readRuntimeEnv } from "../packages/lyapunov-product-bundle/src/runtime-paths.ts"
// W21：GPU 处于哪一态（无卡/驱动未加载/设备对本会话不可见/设备可见但通信失败）只有一份判定，
// 引擎选择在给出理由前**问**它，不自己去试 `nvidia-smi`。
import {
  ENGINE_SDK_MARKER,
  gpuRuntimeDecision,
  probeGpuFacts,
  probeSdkImport,
  sdkInstalled,
  sitePackagesCandidates,
  type GpuRuntimeDecision,
  type SdkImportResult,
} from "../packages/lyapunov-shell/src/environment-readiness.ts"
import { resolveSdkPython, sdkPreferenceFile, writeSdkPythonPreference as writeSdkPythonPreferenceImpl, type SdkEngine } from "../packages/lyapunov-product-bundle/src/sdk-python.mjs"
import { inspectIsaacPythonSync } from "../packages/lyapunov-product-bundle/src/isaac-sdk-probe.mjs"

/** 可选引擎与 `launch.ts` 的 `--engine` 取值一一对应。 */
export const ENGINE_CHOICES = ["isaac", "newton", "mujoco", "none", "benchmark"] as const
export type EngineChoice = typeof ENGINE_CHOICES[number]

export function isEngineChoice(value: string): value is EngineChoice {
  return (ENGINE_CHOICES as readonly string[]).includes(value)
}

/**
 * 偏好层的"显式自动"取值：**不指定引擎**，回到 `defaultEngine()` 的缺省/自动判定。
 *
 * 为什么要有它：此前只有"没有偏好"才等于自动，界面里从**已有手动偏好**回不到自动（复核缺陷 3）。
 * 现在设置页多一个显式入口，走**同一个偏好文件、同一个 endpoint**（不另造配置 owner）；
 * 写入 `auto` 时删除 `engine` 键，`readEnginePreference()` 便返回 `undefined` → 落回缺省判定。
 * ⚠️ 它只作用于**偏好层**：CLI `--engine` 与 `LYAPUNOV_SIM_ENGINE` 仍然优先。
 */
export const AUTO_ENGINE = "auto" as const
export type EnginePreferenceValue = EngineChoice | typeof AUTO_ENGINE
export const ENGINE_PREFERENCE_CHOICES = [AUTO_ENGINE, ...ENGINE_CHOICES] as const

export function isEnginePreferenceValue(value: string): value is EnginePreferenceValue {
  return value === AUTO_ENGINE || isEngineChoice(value)
}

/** 偏好文件路径；`LYAPUNOV_ENGINE_PREFERENCE_FILE` 可覆盖（测试与门用它避免动用户主目录）。 */
export function enginePreferenceFile(env: NodeJS.ProcessEnv = process.env): string {
  return sdkPreferenceFile(env)
}

/** 用户主动选定 SDK 时只写同一个 engine.json，不改引擎/许可，也不操作 SDK 目录。 */
export function writeSdkPythonPreference(engine: SdkEngine, python: string | null, env: NodeJS.ProcessEnv = process.env): string {
  // 唯一写入实现在 sdk-python.mjs（安装收尾 helper 也直接 import 它），这里只保留 TS 入口。
  return writeSdkPythonPreferenceImpl(engine, python, env)
}

/** 读取用户偏好；文件不存在、不可读或取值非法时返回 `undefined`（**不猜测、不静默改默认**）。 */
export function readEnginePreference(env: NodeJS.ProcessEnv = process.env): EngineChoice | undefined {
  try {
    const raw = readFileSync(enginePreferenceFile(env), "utf8")
    const parsed = JSON.parse(raw) as { engine?: unknown }
    return typeof parsed.engine === "string" && isEngineChoice(parsed.engine) ? parsed.engine : undefined
  } catch { return undefined }
}

/**
 * 把**这次解析所用的**偏好文件钉进将要交给 Host 的环境（`LYAPUNOV_ENGINE_PREFERENCE_FILE`）。
 *
 * 为什么必须有这一步：`enginePreferenceFile()` 用 `os.homedir()` 展开 `~`，而 `backendEnvironment()`
 * 会把正式／隔离 Host 的 HOME 换成 `<运行根>/private`。不钉的话，**界面里的引擎切换与偏好读回
 * 落在另一个文件上**：界面显示"偏好 X"，下次启动却仍按用户级的 Y 起——"保存偏好、重启生效"当场失效，
 * 而且读回值 ≠ 入口实际采用的值（DEV-002）。钉的只有这一个非秘密的用户级设置键，
 * 不放宽任何隔离白名单（与 `profile.ts` 里逐个搬运供应商键同一纪律）。
 *
 * 返回被钉的绝对路径，便于调用方把它写进回执/日志。
 */
export function pinEnginePreferenceFile(env: NodeJS.ProcessEnv, parent: NodeJS.ProcessEnv = process.env): string {
  const file = enginePreferenceFile(parent)
  env.LYAPUNOV_ENGINE_PREFERENCE_FILE = file
  return file
}

/**
 * 写入用户偏好。只动 `engine` 这一个键；其余字段（如 `licenses`）保留。
 *
 * `engine === "auto"` 表示**清除显式偏好**（回到缺省/自动判定）：删掉 `engine` 键而不是写一个
 * 谁都不认识的字符串，于是 `readEnginePreference()` 读回 `undefined`，`resolveEngine()` 落回
 * `defaultEngine()`——不需要任何第二套读取口径。
 */
export function writeEnginePreference(engine: EnginePreferenceValue, env: NodeJS.ProcessEnv = process.env): string {
  const file = enginePreferenceFile(env)
  let existing: Record<string, unknown> = {}
  try { existing = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> } catch { /* 首次写入 */ }
  if (engine === AUTO_ENGINE) delete existing.engine
  else existing.engine = engine
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ ...existing, updatedAt: new Date().toISOString() }, null, 2) + "\n")
  return file
}

/** Isaac 解释器路径：沿用 SDK 解释器契约（`sdk-python.mjs`），不在这里维护第二份落点。 */
export function isaacPythonPath(productRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveSdkPython(productRoot, "isaac", env).python
}

/**
 * 某个 SDK 的**安装候选 + 解释器发现核对**两格事实——判据不只看解释器/目录是否存在。
 *
 * 实测教训：`uv venv` 建出的目录**空壳也带 `bin/python`**（安装还没跑完就有了），
 * 而"装了又清理"的前缀可能只剩一个 `*.dist-info`。只看解释器存在、或只认 dist-info，
 * 都会在"装了一半"时把默认选成 Isaac，然后 `sim_open` 才失败。
 *
 * 因此本函数给出两格**分开**的事实，不把任一个包装成"SDK 真装入并可运行"：
 *   · `installCandidate` ← `sdkInstalled(sitePackagesCandidates(python), marker)`（site-packages 命中，
 *     孤立 dist-info 不算）——这只是"文件在"；
 *   · `importProbe` ← `probeSdkImport(python, marker)`：让**选定解释器自己**用
 *     `importlib.util.find_spec` 发现基础模块（不 import 执行、不启动 Kit），结果按解释器+模块缓存；
 *   · `available` = 两格同时成立。解释器跑不起来（`unavailable`）时**保守判不可用**并如实带出诊断。
 */
export interface SdkRuntimeFacts {
  python: string
  installCandidate: boolean
  importProbe: SdkImportResult
  available: boolean
}

export function sdkRuntimeFacts(productRoot: string, engine: "mujoco" | "isaac" | "newton", env: NodeJS.ProcessEnv = process.env, options: {managed?: boolean} = {}): SdkRuntimeFacts {
  const selected = resolveSdkPython(productRoot, engine, env, options)
  const python = selected.python
  if (!existsSync(python)) {
    return { python, installCandidate: false, importProbe: { state: "missing", detail: `解释器不存在：${python}` }, available: false }
  }
  // standalone 的 python.sh 通过自己的启动脚本设置 SDK 路径，不能用 venv 布局猜 site-packages。
  // 保存的本地选择额外核对 pin/Python；这仍只做 find_spec/metadata，完全不 import Kit。
  if (engine === "isaac" && (selected.source === "saved-preference" || python.endsWith("/python.sh"))) {
    const candidate = inspectIsaacPythonSync(python, {productRoot, env})
    const importProbe: SdkImportResult = {state: candidate.compatible ? "importable" : candidate.state === "unavailable" || candidate.state === "timeout" ? "unavailable" : "missing", detail: candidate.detail}
    return {python, installCandidate: candidate.moduleFound, importProbe, available: candidate.compatible}
  }
  const installCandidate = sdkInstalled(sitePackagesCandidates(python), ENGINE_SDK_MARKER[engine])
  // 候选没命中就不起子进程去核对（省一次探测；诊断里说清是"文件不在"）。
  const importProbe: SdkImportResult = installCandidate
    ? probeSdkImport(python, ENGINE_SDK_MARKER[engine])
    : { state: "missing", detail: `site-packages 未命中 ${ENGINE_SDK_MARKER[engine]}（无顶层包/模块；孤立 dist-info 不算）` }
  return { python, installCandidate, importProbe, available: installCandidate && importProbe.state === "importable" }
}

function sdkRuntimeAvailable(productRoot: string, engine: "mujoco" | "isaac" | "newton", env: NodeJS.ProcessEnv): boolean {
  return sdkRuntimeFacts(productRoot, engine, env).available
}

/** Isaac 运行时事实（安装候选 + 解释器发现核对）。 */
export function isaacRuntimeFacts(productRoot: string, env: NodeJS.ProcessEnv = process.env): SdkRuntimeFacts {
  return sdkRuntimeFacts(productRoot, "isaac", env)
}

/** Isaac 运行时是否就绪（安装候选命中且选定解释器能发现 `isaacsim`）。 */
export function isaacRuntimeAvailable(productRoot: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return sdkRuntimeAvailable(productRoot, "isaac", env)
}

/** MuJoCo 运行时是否就绪（安装候选命中且选定解释器能发现 `mujoco`）。自动回退的第一候选。 */
export function mujocoRuntimeAvailable(productRoot: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return sdkRuntimeAvailable(productRoot, "mujoco", env)
}

/**
 * 自动选择依赖的**四项已登记事实**（不是新的判定层）：
 *   · `isaacRuntime`  ← `isaacRuntimeAvailable()`（安装候选命中**且**选定解释器能发现 `isaacsim`）；
 *   · `isaacLicense`  ← `readEngineLicenses()`（用户显式接受过 NVIDIA Omniverse EULA）；
 *   · `gpu`           ← `gpuRuntimeDecision(probeGpuFacts())`（本会话 GPU 到底可不可用）；
 *   · `mujocoRuntime` ← `mujocoRuntimeAvailable()`（回退候选是否真就绪）。
 * 每一格都来自既有 owner；本文件只做"把事实拼成理由"。
 */
export interface EngineAutoFacts {
  isaacRuntime: boolean
  isaacLicense: boolean
  gpu: GpuRuntimeDecision
  mujocoRuntime: boolean
}
/** 测试注入缝：只覆盖要断言的那几格，其余照常现探（产品路径永远不传）。 */
export type EngineAutoOverrides = Partial<EngineAutoFacts>

/** 现探自动选择事实；`overrides` 只给测试用（合成事实离线跑，不假装真实探针结果）。 */
export function probeEngineAutoFacts(productRoot: string, env: NodeJS.ProcessEnv = process.env, overrides: EngineAutoOverrides = {}): EngineAutoFacts {
  return {
    isaacRuntime: overrides.isaacRuntime ?? isaacRuntimeAvailable(productRoot, env),
    isaacLicense: overrides.isaacLicense ?? readEngineLicenses(env).isaac !== undefined,
    gpu: overrides.gpu ?? gpuRuntimeDecision(probeGpuFacts()),
    mujocoRuntime: overrides.mujocoRuntime ?? mujocoRuntimeAvailable(productRoot, env),
  }
}

/**
 * GPU 一格参与自动判定时的**检测范围**说明（复核点 5）。
 *
 * 复用 `gpuRuntimeDecision()` 的"设备/驱动/CUDA 加速器可用"——它**不证明** Isaac RTX 兼容
 * （CUDA-only 卡可能没有 RTX），也不据"卡型号字符串列表"对任何 GPU 做武断分类。
 * 真实能否出图/打开世界由当前 world 回执决定，候选 `ready` 只覆盖这里列出的几项。
 */
export const GPU_CANDIDATE_SCOPE = "检测范围：设备/驱动/CUDA 加速器可用；未核 Isaac RTX 兼容与打开世界（真实运行以 world 回执为准）"

/** 一个自动候选的逐条判据：`ready=false` 时 `blockers` 至少一条，面板直接展示这些原话。 */
export interface AutoEngineCandidate {
  engine: "isaac" | "mujoco"
  ready: boolean
  blockers: string[]
  /** 该候选 `ready` 的**检测范围**（isaac 用）：只覆盖列出的几项，不冒充更多；面板原样显示。 */
  scope?: string
}
/** 自动选择的结论 + 可解释的候选清单。 */
export interface AutoEngineDecision {
  engine: EngineChoice
  reason: string
  candidates: AutoEngineCandidate[]
}

/**
 * 代码默认引擎（用户偏好与显式参数都没给时用它）—— 缺省/自动模式的**唯一判定**。
 *
 * 目标行为（用户明确要求）：Isaac 的 **SDK、已有许可、GPU** 三项**同时**具备时首选 `isaac`；
 * 否则回退 `mujoco`（即使 MuJoCo 也未就绪也如实选它，因为界面仍要能起来——sim Provider 是惰性装配，
 * 打开世界时才真正报依赖缺失），并把"缺了哪一项、怎么补"写进 `reason`。
 * **不写"装好任一引擎后自动改回 isaac"**（不准确）：MuJoCo 装好不会让 Isaac 就绪；只有 Isaac 条件补齐
 * 且偏好层仍为自动时，**下次 Host 启动**才会重新优先 isaac；已设置的手动偏好不被改动。
 *
 * 三条纪律：
 *  1. **不把"Python 文件存在"当就绪**：SDK 看安装候选 + 选定解释器发现核对，GPU 看 `gpuRuntimeDecision`，许可看留痕；
 *  2. **不谎报**：GPU `unknown`/`smi-missing` 都只算"未确认可用"（unknown ≠ ready），理由原文带出；
 *  3. **不悄悄换**：这里只决定"缺省值"；显式/环境/偏好由 `resolveEngine()` 在上层优先处理。
 */
export function defaultEngine(productRoot: string, env: NodeJS.ProcessEnv = process.env, overrides: EngineAutoOverrides = {}): AutoEngineDecision {
  const isaacPython = isaacPythonPath(productRoot, env)
  const mujocoPython = resolveSdkPython(productRoot, "mujoco", env).python
  const facts = probeEngineAutoFacts(productRoot, env, overrides)
  const isaacBlockers: string[] = []
  if (!facts.isaacRuntime) isaacBlockers.push(`Isaac 运行时未就绪（${isaacPython}：SDK 安装候选未命中，或选定解释器发现不了 isaacsim）`)
  if (!facts.isaacLicense) isaacBlockers.push("Isaac 许可未接受（NVIDIA Omniverse EULA；在设置里勾选，或运行 install-provider isaac --accept-omniverse-eula）")
  if (facts.gpu.accelerator !== "available") isaacBlockers.push(`GPU 未确认可用（${facts.gpu.headline}）`)
  const isaacReady = isaacBlockers.length === 0
  const candidates: AutoEngineCandidate[] = [
    { engine: "isaac", ready: isaacReady, blockers: isaacBlockers, scope: GPU_CANDIDATE_SCOPE },
    {
      engine: "mujoco", ready: facts.mujocoRuntime,
      blockers: facts.mujocoRuntime ? [] : [`MuJoCo 运行时未就绪（${mujocoPython} 不存在、安装候选未命中或解释器发现不了 mujoco）`],
    },
  ]
  if (isaacReady) {
    return { engine: "isaac", reason: `Isaac 运行时就位（${isaacPython}：安装候选命中且解释器可发现 isaacsim）、许可已接受、GPU 加速器可用（${facts.gpu.headline}），按默认选 isaac；${GPU_CANDIDATE_SCOPE}`, candidates }
  }
  const mujocoNote = facts.mujocoRuntime
    ? `MuJoCo 就绪（${mujocoPython}）`
    : `MuJoCo 也未就绪（${mujocoPython} 不存在、安装候选未命中或解释器发现不了 mujoco；界面仍可启动，打开世界时才按真实依赖报错）`
  return { engine: "mujoco", reason: `${isaacBlockers.join("；")}；默认回退 mujoco；${mujocoNote}；若 Isaac 条件补齐且偏好层仍为自动，下次启动才会优先 isaac（已设置的手动偏好不被改动）`, candidates }
}

/** 引擎选择的来源：启动日志与回执要能说清"这次为什么是这个引擎"。 */
export type EngineSource = "explicit" | "environment" | "preference" | "default"
export interface EngineSelection {
  engine: EngineChoice
  source: EngineSource
  /** 可打印的一句话原因；`default` 时是回退理由，调用方直接打印它。 */
  reason: string
  /** 走到自动判定（`source === "default"`）时附上候选评估，供面板显示"为什么不是 Isaac"。 */
  auto?: AutoEngineDecision
}

/**
 * **所有正常启动入口共用的引擎解析**（唯一一份优先级）：
 *   显式参数（`--engine`／调用方传入） > `LYAPUNOV_SIM_ENGINE`（空值视为未配置） > 用户偏好 > `defaultEngine()`。
 *
 * 各入口曾各自写死默认（`mujoco`／`none`／`mujoco`）且不读偏好，同一个用户在四个入口会拿到不同引擎；
 * 显式值仍最优先，非法值一律报错、不静默回退成默认。
 * **显式/环境/偏好一旦命中就原样采用**，即使自动判定会得到另一个引擎也不替换（不偷偷换引擎）；
 * 自动判定只发生在"三层都没配置"这一层。
 * `productRoot` 由调用方传入：本文件会被卷进 Shell 插件，不宜再拖上 `profile.ts` 的依赖。
 * `auto` 只给测试注入合成事实（`EngineAutoOverrides`）；产品调用不传。
 */
export function resolveEngine(input: { explicit?: string; env?: NodeJS.ProcessEnv; productRoot: string; auto?: EngineAutoOverrides }): EngineSelection {
  const env = input.env ?? process.env
  if (input.explicit !== undefined) {
    if (!isEngineChoice(input.explicit)) throw new Error(`未知 Provider：${input.explicit}（可选 ${ENGINE_CHOICES.join("/")}）`)
    return { engine: input.explicit, source: "explicit", reason: "来源：显式参数" }
  }
  // 空/空白的环境变量等于没配（旧入口用 `||` 跳过它），不能被当成非法值卡住启动。
  const environment = readRuntimeEnv(env, "simEngine")?.trim()
  if (environment !== undefined && environment.length > 0) {
    if (!isEngineChoice(environment)) throw new Error(`未知 Provider：${environment}（可选 ${ENGINE_CHOICES.join("/")}）`)
    return { engine: environment, source: "environment", reason: "来源：LYAPUNOV_SIM_ENGINE" }
  }
  const preference = readEnginePreference(env)
  if (preference !== undefined) return { engine: preference, source: "preference", reason: "来源：用户偏好" }
  const fallback = defaultEngine(input.productRoot, env, input.auto ?? {})
  return { engine: fallback.engine, source: "default", reason: fallback.reason, auto: fallback }
}

/** 已接受的第三方许可（目前只有 Isaac 的 NVIDIA Omniverse）。 */
export interface LicenseAcceptance { acceptedAt: string; eulaUrl: string }
export interface EngineLicenses { isaac?: LicenseAcceptance }

/**
 * 读取已记录的许可接受情况。
 *
 * 为什么需要它：Isaac 的安装/运行要求用户先接受 NVIDIA Omniverse 许可（安装器会硬拦）。
 * "接受"必须是**用户显式动作**并留痕（时间 + 当时看到的许可链接），而不是点一下安装就默认同意；
 * 记录下来之后，界面可以显示"已于某时接受"并允许直接安装，而不是每次重新勾选。
 * 存储仍是同一个偏好文件（单 owner），只多一个键。
 */
export function readEngineLicenses(env: NodeJS.ProcessEnv = process.env): EngineLicenses {
  try {
    const parsed = JSON.parse(readFileSync(enginePreferenceFile(env), "utf8")) as { licenses?: EngineLicenses }
    const isaac = parsed.licenses?.isaac
    return isaac && typeof isaac.acceptedAt === "string" && typeof isaac.eulaUrl === "string" ? { isaac } : {}
  } catch { return {} }
}

/** 记录/撤销一次许可接受。撤销是显式动作（`accepted:false`），只删这一个键。 */
export function recordEngineLicense(engine: "isaac", accepted: boolean, eulaUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const file = enginePreferenceFile(env)
  let existing: Record<string, unknown> = {}
  try { existing = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> } catch { /* 首次写入 */ }
  const licenses = { ...(existing.licenses as Record<string, unknown> | undefined) }
  if (accepted) licenses[engine] = { acceptedAt: new Date().toISOString(), eulaUrl } satisfies LicenseAcceptance
  else delete licenses[engine]
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ ...existing, licenses, updatedAt: new Date().toISOString() }, null, 2) + "\n")
  return file
}

/** Newton 解释器路径：独立环境（Newton 自带 `mujoco~=3.12.0` pin，与产品 mujoco 冲突），落点仍归 `sdk-python.mjs`。 */
export function newtonPythonPath(productRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveSdkPython(productRoot, "newton", env).python
}

/** Newton 运行时是否可用：解释器在且 `newton` 真的装进去了（空壳 venv 不算）。 */
export function newtonRuntimeAvailable(productRoot: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return sdkRuntimeAvailable(productRoot, "newton", env)
}
