/**
 * 环境就绪契约（N1–N4／D1–D4）——"依赖缺了怎么办"的**唯一一份**判据与话术。
 *
 * 命题（docs/CLIENT_CONVERGENCE_20260926.md §4）：客户机上的 GPU／驱动／浏览器／网络／额度都可能
 * **缺失、损坏或被策略禁掉**。客户端的职责不是"环境不对就失败"，而是：
 *   检测（D1 预检） → 降级（D2 降级可解释） → 说不清就明确说清并给处置建议（D3 无替代则明确拒绝），
 *   且上述行为都有回归测试（D4）。
 *
 * 为什么需要这一层：同样四件事在本仓库已经各自做对过一次——
 *   · `script/engine-preference.ts`：Isaac 运行时就绪才默认 isaac，否则回退 mujoco，**并把回退理由打印出来**；
 *   · `packages/sim-newton/src/provider.ts`：设备 `auto` = 有 CUDA 用 `cuda:0`，没有就 `cpu`；
 *   · `packages/sim-isaac/src/provider.ts`：只报告宿主上**真实存在**的设备节点，拿不到就不启动；
 *   · `script/doctor-env.ts` §2：GPU 预检给 PARTIAL，并附"这可能是沙箱误报"的诚实注脚。
 * 差别不在能力，在**有没有统一契约**——`DEV-039`（WebGL 创建失败 → 场景 tab 静默留空座）就是漏网的那一个。
 * 所以这里把 D1–D4 做成**数据 + 纯函数**：新功能**声明**自己的环境依赖（`EnvironmentDeclaration`），
 * 缺依赖时统一走 `featureEnvironmentVerdict()` 的话术与降级路径，不再每个功能各写一遍。
 *
 * 三条硬纪律（本模块的边界，改它之前先读这三条）：
 *  1. **unknown ≠ ready**：读不到就报 `unknown`，并给出"怎么把它测清楚"。绝不静默当可用，也绝不留空
 *     （留空正是 DEV-039 的形态）。
 *  2. **不谎报**：只报本机真实读到的读数；沙箱/容器造成的可见性缺失必须标 `uncertain`，并写明
 *     "这可能是沙箱误报，不得据此断言客户机坏了"——doctor-env §2 的注脚在这里是**结构字段**，不是备注。
 *     **读不到 ≠ 没有**（来源读不到时不许断言"确实没有卡"）、**缺诊断工具 ≠ 坏了**
 *     （没装 `nvidia-smi` 不许判"驱动打不开设备"）、**「声称有卡」必须有 PCI 或驱动挂载证据**。
 *  3. **本模块不出网**：网络与付费额度读数由调用方**注入**（客户端健康检查／设置页上报）。面板在渲染
 *     路径上做出网探测会把界面卡住，也会让"没有网"这件事表现为一个超时而不是一句人话。
 *
 * 客户端（浏览器 bundle）只应 `import type` 本模块的类型——形状会被完全擦除，不会把 `node:fs`
 * 带进浏览器包；**运行时探测只在宿主侧**（`provider-installer.ts`、`script/doctor-env.ts`）。
 */

import { execFileSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import {resolveSdkPython, SDK_PYTHON_ENV, SDK_PYTHON_PACKAGE_PATH, type SdkPythonSource} from "../../lyapunov-product-bundle/src/sdk-python.mjs"
import {inspectIsaacPythonSync} from "../../lyapunov-product-bundle/src/isaac-sdk-probe.mjs"

// ───────────────────────────── D1–D4 的字段形状 ─────────────────────────────

// 环境字段与通用话术的唯一 owner 在共享 contracts；这里保留原导出名以兼容既有调用。
import {
  ENVIRONMENT_CONTRACT_TEST,
  ENVIRONMENT_CONTRACT_VERSION,
  ENVIRONMENT_STATUS_LABEL,
  environmentCode,
  environmentRowById,
  environmentPanelWording,
  environmentRowWording,
  type EnvironmentDegradation,
  type EnvironmentKind,
  type EnvironmentPanel,
  type EnvironmentRemedy,
  type EnvironmentRow,
  type EnvironmentStatus,
} from '../../lyapunov-contracts/src/environment.ts'
export {
  ENVIRONMENT_CONTRACT_TEST,
  ENVIRONMENT_CONTRACT_VERSION,
  ENVIRONMENT_STATUS_LABEL,
  environmentCode,
  environmentRowById,
  environmentPanelWording,
  environmentRowWording,
  type EnvironmentDegradation,
  type EnvironmentKind,
  type EnvironmentPanel,
  type EnvironmentRemedy,
  type EnvironmentRow,
  type EnvironmentStatus,
} from '../../lyapunov-contracts/src/environment.ts'

// GPU 事实/分型/拒绝判定的唯一 owner 在 sim-contract；Provider 不再反向依赖 Shell。
import {
  GPU_STATE_WORDING,
  MIN_FREE_VRAM_MIB,
  classifyGpu,
  compactDriverVersion,
  gpuDeviceVisibility,
  gpuHeadline,
  gpuRefusal,
  gpuRow,
  gpuRuntimeDecision,
  gpuStatus,
  parseSmiCapacity,
  probeGpuDeviceVisibility,
  probeGpuFacts,
  probeSmiAbsenceEvidence,
  scanGpuDevices,
  smiAbsenceDetail,
  smiFailureDetail,
  smiMissingRemedy,
  stableFingerprint,
  type GpuAccelerator,
  type GpuClassification,
  type GpuDeviceScan,
  type GpuDeviceVisibility,
  type GpuFacts,
  type GpuProbeOptions,
  type GpuRuntimeDecision,
  type GpuState,
  type SmiAbsenceEvidence,
  type SmiAbsenceReason,
} from '../../sim-contract/src/gpu-facts.ts'
export {
  GPU_STATE_WORDING,
  MIN_FREE_VRAM_MIB,
  classifyGpu,
  compactDriverVersion,
  gpuDeviceVisibility,
  gpuHeadline,
  gpuRefusal,
  gpuRow,
  gpuRuntimeDecision,
  gpuStatus,
  parseSmiCapacity,
  probeGpuDeviceVisibility,
  probeGpuFacts,
  probeSmiAbsenceEvidence,
  scanGpuDevices,
  smiAbsenceDetail,
  smiFailureDetail,
  smiMissingRemedy,
  stableFingerprint,
  type GpuAccelerator,
  type GpuClassification,
  type GpuDeviceScan,
  type GpuDeviceVisibility,
  type GpuFacts,
  type GpuProbeOptions,
  type GpuRuntimeDecision,
  type GpuState,
  type SmiAbsenceEvidence,
  type SmiAbsenceReason,
} from '../../sim-contract/src/gpu-facts.ts'

export type EngineName = "mujoco" | "isaac" | "newton"
export const ENGINE_NAMES: readonly EngineName[] = ["mujoco", "isaac", "newton"]

/** 与 `packages/lyapunov-product-bundle/src/sdk-python.mjs` 的 `SDK_PYTHON_ENV` 一一对应（有测试钉住两表一致）。 */
export const ENGINE_PYTHON_ENV: Record<EngineName, string> = SDK_PYTHON_ENV
/** 与 `SDK_PYTHON_PACKAGE_PATH` 一一对应（有测试钉住两表一致，防止 SDK 落点漂移后面板报错读数）。 */
export const ENGINE_PYTHON_PACKAGE_PATH: Record<EngineName, string> = SDK_PYTHON_PACKAGE_PATH
/** 各 SDK 在 site-packages 里的包名前缀。 */
export const ENGINE_SDK_MARKER: Record<EngineName, string> = { mujoco: "mujoco", isaac: "isaacsim", newton: "newton" }

export interface EngineRuntimeFacts {
  engine: EngineName
  python: string
  source: SdkPythonSource
  interpreter: boolean
  /**
   * **安装候选**是否命中：该解释器的 site-packages 里有顶层包目录/模块文件（空壳 venv、孤立 dist-info 都不算）。
   * ⚠️ 它不是"可运行"——运行就绪另走 `probeSdkImport()` 的轻量发现探测（引擎选择点已接）。
   */
  sdk: boolean
  /** site-packages 候选（证据行用）。 */
  sitePackages: readonly string[]
}

/** 解释器所在 venv/conda 前缀 → site-packages 候选（覆盖 venv 与 conda 两种布局）。 */
export function sitePackagesCandidates(python: string): string[] {
  const prefix = dirname(dirname(python))
  const candidates: string[] = []
  const lib = join(prefix, "lib")
  try {
    for (const name of readdirSync(lib)) if (/^python3\.\d+$/.test(name) || /^pypy3\.\d+$/.test(name)) candidates.push(join(lib, name, "site-packages"))
  } catch { /* 前缀不存在：候选留空即可，读数会说"解释器不存在" */ }
  candidates.push(join(lib, "site-packages"), join(prefix, "Lib", "site-packages"))
  return candidates
}

/**
 * SDK **安装候选**：site-packages 里存在顶层包目录或模块文件才算命中。
 *
 * ⚠️ 这只是"文件在"，**不等于解释器能发现它、更不等于能运行**：
 *   · **孤立 `*.dist-info` 不算**（包目录已被删、只剩元数据）。旧口径把 `mujoco-3.13.0.dist-info`
 *     这种命中当"装好"，于是一个被清理过/只留元数据的前缀会被误报成就绪——本轮按复核要求收紧；
 *   · 「能运行」另走 `probeSdkImport()` 的**轻量发现探测**（`importlib.util.find_spec`，不导入执行
 *     重 SDK、不启动 Kit），且结果按解释器+模块缓存复用，不在每次设置页刷新时重复起子进程。
 */
export function sdkInstalled(sitePackages: readonly string[], marker: string): boolean {
  const moduleSuffixes = [".py", ".so", ".pyd"] as const
  for (const directory of sitePackages) {
    try {
      if (readdirSync(directory).some(name =>
        name === marker
        || moduleSuffixes.some(suffix => name === `${marker}${suffix}`)
        || (name.startsWith(`${marker}.`) && moduleSuffixes.some(suffix => name.endsWith(suffix))))) return true
    } catch { /* 目录不存在：继续看下一个候选 */ }
  }
  return false
}

// ───────────── SDK「解释器能不能发现模块」的轻量探测（缓存复用，不启动重 SDK） ─────────────

/**
 * `probeSdkImport()` 的结论：
 *  · `importable` —— 选定解释器**能发现**该顶层模块（安装候选之外的第二道核对）；
 *  · `missing`    —— 解释器在，但发现不了（孤立 dist-info / 坏 venv / 装到了别的 Python）；
 *  · `unavailable`—— 解释器根本跑不起来，核对无法完成（EACCES/ENOEXEC/超时…）。
 * ⚠️ 它**只做发现**（`importlib.util.find_spec`），不 `import` 执行模块体，因此不会拉起 Kit/Isaac。
 */
export type SdkImportState = "importable" | "missing" | "unavailable"
export interface SdkImportResult { state: SdkImportState; detail: string }

/** 发现脚本：把模块名作为 argv[1]，找到/找不到/异常分别用固定标记 + 退出码表达。 */
const SDK_IMPORT_SCRIPT = [
  "import importlib.util, sys",
  "name = sys.argv[1]",
  "try:",
  "    spec = importlib.util.find_spec(name)",
  "except Exception as error:",
  "    print('SDK_PROBE_ERROR:' + type(error).__name__ + ':' + str(error)[:200])",
  "    sys.exit(4)",
  "print('SDK_PROBE_FOUND' if spec is not None else 'SDK_PROBE_MISSING')",
  "sys.exit(0 if spec is not None else 3)",
].join("\n")
const SDK_IMPORT_CACHE_TTL_MS = 30_000
const sdkImportCache = new Map<string, { at: number; value: SdkImportResult }>()

/** 安装/修复完成后调用：让下一次读取重新核对（缓存只服务同一安装状态下的重复刷新）。 */
export function clearSdkImportCache(): void { sdkImportCache.clear() }

export function probeSdkImport(python: string, module: string, options: { timeoutMs?: number } = {}): SdkImportResult {
  const key = `${python}\u0000${module}`
  const cached = sdkImportCache.get(key)
  if (cached && Date.now() - cached.at < SDK_IMPORT_CACHE_TTL_MS) return cached.value
  const value = runSdkImportProbe(python, module, options)
  sdkImportCache.set(key, { at: Date.now(), value })
  return value
}

function runSdkImportProbe(python: string, module: string, options: { timeoutMs?: number }): SdkImportResult {
  if (!existsSync(python)) return { state: "missing", detail: `解释器不存在：${python}` }
  const run = (): string => execFileSync(python, ["-c", SDK_IMPORT_SCRIPT, module], { encoding: "utf8", timeout: options.timeoutMs ?? 8000, stdio: ["ignore", "pipe", "pipe"] })
  try {
    const stdout = run()
    return stdout.includes("SDK_PROBE_FOUND")
      ? { state: "importable", detail: `解释器可发现模块 ${module}：${python}` }
      : { state: "missing", detail: `解释器未报告发现模块 ${module}：${python}` }
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string; code?: string; killed?: boolean; signal?: string }
    const stdout = failure.stdout ?? ""
    if (stdout.includes("SDK_PROBE_FOUND")) return { state: "importable", detail: `解释器可发现模块 ${module}：${python}` }
    if (stdout.includes("SDK_PROBE_MISSING") || failure.status === 3) {
      return { state: "missing", detail: `解释器在（${python}），但发现不了模块 ${module}（孤立 dist-info / 坏 venv / 装到了别的 Python）` }
    }
    if (stdout.includes("SDK_PROBE_ERROR")) {
      const reason = stdout.replace(/^.*SDK_PROBE_ERROR:/s, "").trim().slice(0, 200)
      return { state: "missing", detail: `解释器（${python}）发现模块 ${module} 时报错：${reason}` }
    }
    return { state: "unavailable", detail: `无法运行解释器核对模块 ${module}（${failure.code ?? (failure.killed ? "超时" : failure.signal ?? "未知原因")}）：${python}` }
  }
}

export function probeEngineRuntimes(productRoot: string, env: NodeJS.ProcessEnv = process.env): EngineRuntimeFacts[] {
  return ENGINE_NAMES.map(engine => {
    const {python, source} = resolveSdkPython(productRoot, engine, env)
    const sitePackages = sitePackagesCandidates(python)
    const localIsaac = engine === "isaac" && (source === "saved-preference" || python.endsWith("/python.sh"))
    const sdk = localIsaac ? inspectIsaacPythonSync(python, {productRoot, env}).compatible : sdkInstalled(sitePackages, ENGINE_SDK_MARKER[engine])
    return { engine, python, source, interpreter: existsSync(python), sdk, sitePackages }
  })
}

export type GraphicsVendor = "nvidia" | "amd" | "intel" | "software" | "unknown"

/** Renderer-family classification is descriptive only; it never selects a vendor or changes launch flags. */
export function classifyGraphicsVendor(renderer: string | null): GraphicsVendor {
  const value = renderer?.toLowerCase() ?? ""
  if (/(llvmpipe|softpipe|swiftshader|software rasterizer)/.test(value)) return "software"
  if (/(nvidia|geforce|quadro|tesla)/.test(value)) return "nvidia"
  if (/(amd|radeon|radeonsi|ati)/.test(value)) return "amd"
  if (/(intel|iris|uhd|arc)/.test(value)) return "intel"
  return "unknown"
}

export interface GraphicsFacts {
  display: string | null
  x11Socket: boolean
  glxRenderer: string | null
  glxAccelerated: boolean | null
  probeError: string | null
  /** Descriptive renderer family only; absent in legacy injected fixtures. */
  vendor?: GraphicsVendor
}

/** 宿主 GL 读数（glxinfo -B）。只在声明了显示时才起子进程，无头机器直接跳过。 */
export function probeGraphicsFacts(env: NodeJS.ProcessEnv = process.env, options: { timeoutMs?: number } = {}): GraphicsFacts {
  const display = env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim() || null
  const x11Socket = existsSync("/tmp/.X11-unix")
  if (display === null) return { display, x11Socket, glxRenderer: null, glxAccelerated: null, probeError: null, vendor: "unknown" }
  try {
    const output = execFileSync("glxinfo", ["-B"], { encoding: "utf8", timeout: options.timeoutMs ?? 4000, stdio: ["ignore", "pipe", "pipe"] })
    const renderer = output.match(/^\s*(?:OpenGL renderer string|Device):\s*(.+)$/m)?.[1]?.trim() ?? null
    const accelerated = output.match(/^\s*Accelerated:\s*(yes|no)\s*$/m)?.[1]
    return { display, x11Socket, glxRenderer: renderer, glxAccelerated: accelerated === undefined ? null : accelerated === "yes", probeError: null, vendor: classifyGraphicsVendor(renderer) }
  } catch (error) {
    const failure = error as { code?: string; stderr?: string }
    if (failure.code === "ENOENT") return { display, x11Socket, glxRenderer: null, glxAccelerated: null, probeError: "glxinfo 未安装", vendor: "unknown" }
    return { display, x11Socket, glxRenderer: null, glxAccelerated: null, probeError: `glxinfo 失败：${(failure.stderr ?? String(error)).trim().slice(0, 200)}`, vendor: "unknown" }
  }
}

/** 真机串口（`/dev/ttyACM*`、`/dev/ttyUSB*`、`/dev/ttyTHS*`）。 */
export function probeSerialDevices(devDir = "/dev"): string[] {
  try {
    return readdirSync(devDir).filter(name => /^tty(ACM|USB|THS)\d+$/.test(name)).map(name => join(devDir, name))
  } catch { return [] }
}

/** 注入型读数：本模块不自己出网/查额度，由宿主（健康检查、设置页、前端上报）给。 */
export interface EnvironmentReport {
  status: EnvironmentStatus
  reading: string
  evidence?: readonly string[]
  uncertain?: boolean
}

export interface EnvironmentFacts {
  gpu: GpuFacts
  runtimes: readonly EngineRuntimeFacts[]
  graphics: GraphicsFacts
  serialDevices: readonly string[]
  /** micromamba 路径（install-provider 前置）；null = 未备。 */
  micromamba: string | null
  /** 出网能力；缺省 unknown（本模块不出网）。 */
  network?: EnvironmentReport
  /** 付费额度；缺省 unknown。 */
  quota?: EnvironmentReport
  /** 浏览器侧 WebGL 上报（DEV-039 的呈现侧回填）；缺省 unknown = 未上报。 */
  webgl?: EnvironmentReport
}

export interface EnvironmentProbeInput {
  /** 产品根：引擎运行时按它解析（开发态即仓库根，发行态即包根）。 */
  productRoot: string
  env?: NodeJS.ProcessEnv
  graphics?: boolean
  gpu?: Omit<GpuProbeOptions, "requiredVramMiB" | "minDriverMajor"> & { requiredVramMiB?: number | null; minDriverMajor?: number | null }
  /** 宿主注入的读数（网络/额度/浏览器 WebGL），面板不自己测这三项。 */
  reports?: Pick<EnvironmentFacts, "network" | "quota" | "webgl">
}

/** 真实宿主读数：全部本地只读 + nvidia-smi/glxinfo 两个子进程（有超时），**不出网**。 */
export function probeEnvironmentFacts(input: EnvironmentProbeInput): EnvironmentFacts {
  const env = input.env ?? process.env
  const micromamba = env.LYAPUNOV_MICROMAMBA?.trim()
  return {
    gpu: probeGpuFacts(input.gpu ?? {}),
    runtimes: probeEngineRuntimes(input.productRoot, env),
    graphics: input.graphics === false ? { display: env.DISPLAY?.trim() || null, x11Socket: false, glxRenderer: null, glxAccelerated: null, probeError: "未探测（已禁用图形探测）" } : probeGraphicsFacts(env),
    serialDevices: probeSerialDevices(),
    micromamba: micromamba && existsSync(micromamba) ? micromamba : null,
    ...(input.reports ?? {}),
  }
}

// ───────────────────────────── N1：就绪面板（一屏） ─────────────────────────────

const unknownReport = (what: string, why: string): EnvironmentReport => ({ status: "unknown", reading: `${what}未测得：${why}` })

function runtimeRow(facts: EngineRuntimeFacts, others: readonly EngineRuntimeFacts[]): EnvironmentRow {
  const label = `引擎运行时：${facts.engine}`
  const fallbacks = others.filter(other => other.interpreter && other.sdk).map(other => other.engine)
  const runtimeTest = `${ENVIRONMENT_CONTRACT_TEST} › 引擎运行时三态`
  const common = {
    id: `runtime.${facts.engine}`, kind: "runtime" as const, label, state: facts.engine,
    scope: "detail" as const, contractTest: runtimeTest, uncertain: false,
    evidence: [`PYTHON=${facts.python}（${facts.source === "env-override" ? ENGINE_PYTHON_ENV[facts.engine] : facts.source === "saved-preference" ? "用户保存的本地安装" : "包内落点"}）`, ...facts.sitePackages.map(directory => `site-packages: ${directory}`)],
  }
  if (facts.interpreter && facts.sdk) {
    return { ...common, status: "ready", reading: `就绪（${facts.python}${facts.source === "env-override" ? "，来自环境变量覆盖" : facts.source === "saved-preference" ? "，来自已保存的本地选择" : ""}）`, impact: "无：该引擎的**安装候选**已命中。真实能否装配/出图由实际运行决定（本行不冒充引擎验收）。", degradation: null, remedy: { summary: "无需处置。", steps: [`真实装配读数：\`./lyapunov doctor ${facts.engine}\``] } }
  }
  if (facts.interpreter && !facts.sdk) {
    // 实测教训（engine-preference.ts）：`uv venv` 建出的空壳也带 bin/python，只看解释器会把"装了一半"当装好。
    return {
      ...common, status: "broken", state: `${facts.engine}:empty-interpreter`,
      reading: `解释器在但 SDK 未装入（空壳环境，装了一半的典型形态）：${facts.python}`,
      impact: "该引擎会在 `sim_open` 时才失败；不能按“已就绪”装配（会被启动期的就绪检查拦下）。",
      degradation: { path: fallbacks.length > 0 ? `回退到已装好的引擎：${fallbacks.join("、")}` : "暂无可用引擎，需先装好一个", active: false, restore: "重跑安装器把 SDK 装进这个前缀" },
      remedy: { summary: "重跑该引擎的安装器（空壳环境要装完整）。", steps: [`\`./lyapunov install-provider ${facts.engine}\``, "装完复核：`./lyapunov doctor " + facts.engine + "`"] },
    }
  }
  return {
    ...common, status: "missing", state: `${facts.engine}:absent`,
    reading: `解释器不存在：${facts.python}`,
    impact: "该引擎不能用；选择它时会在启动前被拒绝（不静默降级成别的引擎）。",
    degradation: { path: fallbacks.length > 0 ? `回退到已装好的引擎：${fallbacks.join("、")}（engine-preference 的默认回退会打印理由）` : "暂无可用引擎", active: fallbacks.length > 0, restore: `补齐 ${facts.engine} 的 SDK/许可/GPU 条件且仍为自动时，下次启动会重新优先它（已设置的手动偏好不被改动）` },
    remedy: { summary: `安装 ${facts.engine} 运行时（不需要 GPU 的可以先装 mujoco）。`, steps: [`\`./lyapunov install-provider ${facts.engine}\``, facts.engine === "mujoco" ? "mujoco 是纯 CPU 路径，无 GPU 机器也能用" : "Isaac/Newton 的安装前置见 doctor-env §1d（micromamba）"] },
  }
}

function runtimeSummaryRow(runtimes: readonly EngineRuntimeFacts[]): EnvironmentRow {
  const ready = runtimes.filter(runtime => runtime.interpreter && runtime.sdk).map(runtime => runtime.engine)
  const installed = runtimes.filter(runtime => runtime.interpreter || runtime.sdk)
  const test = `${ENVIRONMENT_CONTRACT_TEST} › 引擎运行时三态`
  if (ready.length > 0) {
    return {
      id: "runtime.simulation", kind: "runtime", label: "模拟运行时（总）", status: "ready", state: `ready:${ready.join("+")}`,
      reading: `可用引擎：${ready.join("、")}${installed.length > ready.length ? `；另外 ${installed.length - ready.length} 个装了但不完整` : ""}`,
      impact: installed.length > ready.length ? "装了一半的引擎会在装配前被拦下（见对应明细行），不影响已就绪的引擎。" : "无。",
      uncertain: false, evidence: runtimes.map(runtime => `${runtime.engine}: interpreter=${runtime.interpreter} sdk=${runtime.sdk}`),
      degradation: null, remedy: { summary: "无需处置。", steps: ["换引擎：设置页切换后**下次启动生效**（一个 Host 只能有一个 Provider 独占世界）"] },
      scope: "overall", contractTest: test,
    }
  }
  return {
    id: "runtime.simulation", kind: "runtime", label: "模拟运行时（总）", status: "missing", state: "none-installed",
    reading: `三个引擎（mujoco/isaac/newton）一个都没装好：${installed.length > 0 ? "存在不完整的前缀" : `落点 ${runtimes[0]?.python ?? "未知"}`}`,
    impact: "**无法打开任何世界**：`sim_open` 无 Provider 可用。这是真正需要拦下的“不可用”，而不是降级。",
    uncertain: false, evidence: runtimes.map(runtime => `${runtime.engine}: interpreter=${runtime.interpreter} sdk=${runtime.sdk}`),
    degradation: null,
    remedy: { summary: "先装一个引擎；无 GPU 的机器从 MuJoCo 开始（纯 CPU）。", steps: ["装 MuJoCo：`./lyapunov install-provider mujoco`（纯 CPU，不需要 GPU）", "装之前先过 doctor-env：`bun run script/doctor-env.ts`", "装完 `./lyapunov doctor mujoco` 看真实装配读数"] },
    scope: "overall", contractTest: test,
  }
}

function graphicsRow(facts: GraphicsFacts): EnvironmentRow {
  const test = `${ENVIRONMENT_CONTRACT_TEST} › 宿主 GL 与 WebGL 行`
  const common = { id: "gl.host", kind: "graphics" as const, label: "宿主 OpenGL（GLX）", scope: "overall" as const, contractTest: test, evidence: [`DISPLAY=${facts.display ?? "未设置"}`, `/tmp/.X11-unix 可见=${facts.x11Socket}`, `renderer=${facts.glxRenderer ?? "未读到"}`, `Accelerated=${facts.glxAccelerated === null ? "未读到" : facts.glxAccelerated}`] }
  if (facts.glxAccelerated === true) {
    return { ...common, status: "ready", state: "hardware", reading: `硬件加速可用${facts.glxRenderer ? `：${facts.glxRenderer}` : ""}`, impact: "无。", uncertain: false, degradation: null, remedy: { summary: "无需处置。", steps: [] } }
  }
  if (facts.glxAccelerated === false) {
    return {
      ...common, status: "degraded", state: "software-rendering",
      reading: `软件渲染（未加速）：${facts.glxRenderer ?? "renderer 未读到"}`,
      impact: "3D 预览/相机出图能跑但明显变慢（首帧与帧率都受影响）；浏览器里的 WebGL 可能退到 SwiftShader，甚至创建上下文失败。",
      uncertain: false,
      degradation: { path: "软件渲染（llvmpipe/SwiftShader）：功能不回退，只降质量与速度", active: true, restore: "让会话能访问 GPU（见 GPU 行）后重启 Host 与浏览器" },
      remedy: { summary: "这是“没有硬件加速”而不是“没有 OpenGL”：要么修 GPU 可见性，要么接受软件渲染。", steps: ["先看 GPU 行：设备被会话隐藏时装好驱动也没用", "确需软件渲染时显式声明：`LIBGL_ALWAYS_SOFTWARE=1`（避免“有时快有时慢”的不确定）", "远程桌面/无头会话下 GL 常不可用，别把宿主读数当成用户浏览器读数"] },
    }
  }
  if (facts.probeError) {
    return {
      ...common, status: "unknown", state: "probe-failed", reading: `GL 读数未取得：${facts.probeError}`,
      impact: "**未知不等于可用**：宿主 GL 读数缺失时不得推断浏览器 WebGL 可用。",
      uncertain: true, uncertaintyNote: "这是**探测失败**（宿主读数没拿到），不是“这台机器没有 GL”：不得据此推断浏览器 WebGL 不可用", degradation: null,
      remedy: { summary: "装 `mesa-utils` 后重测（`glxinfo -B`），或直接以浏览器侧上报为准。", steps: ["`sudo apt install mesa-utils`", "`glxinfo -B` 看 `Accelerated` 与 renderer", "浏览器侧的真实结论由 WebGL 行给出（DEV-039）"], permission: "root/sudo（装 mesa-utils）" },
    }
  }
  return {
    ...common, status: "unknown", state: "headless", reading: facts.display === null ? "本会话没有显示（未设置 DISPLAY/WAYLAND_DISPLAY）" : "有显示声明但 GLX 读数缺失",
    impact: "**宿主无显示 ≠ 用户浏览器无 WebGL**：这一行不能用来判断用户侧的 3D 预览是否可用，只能说明本会话不出图。",
    uncertain: true, uncertaintyNote: "无显示可能只是本会话/容器没暴露显示：这是宿主侧读数，代表不了用户桌面的情况", degradation: null,
    remedy: { summary: "要么在带显示的会话里复核，要么以浏览器侧上报为准。", steps: ["无头/服务器场景：用无头渲染或软件渲染出像素证据", "用户侧结论看 WebGL 行（前端在创建上下文失败时上报）"] },
  }
}

function webglRow(report: EnvironmentReport | undefined): EnvironmentRow {
  const test = `${ENVIRONMENT_CONTRACT_TEST} › 宿主 GL 与 WebGL 行`
  const base = { id: "webgl", kind: "graphics" as const, label: "WebGL（浏览器 3D 上下文）", state: report === undefined || report.status === "unknown" ? "unreported" : report.status, scope: "optional" as const, contractTest: test, evidence: report?.evidence ?? ["尚未收到浏览器侧上报"] }
  const remedy: EnvironmentRemedy = {
    summary: "开启浏览器硬件加速；驱动不可用时先修 GPU 可见性/驱动（见 GPU 行）。",
    steps: [
      "浏览器设置里打开“使用硬件加速”，重启浏览器",
      "远程桌面/虚拟机会话里 WebGL 常被禁用：换本地会话复核",
      "企业策略禁用 WebGL 时需放行（chrome://flags 或组策略）",
      "修复顺序：GPU 行 → 宿主 GL 行 → 本行；宿主装了驱动但会话看不到 GPU 时，浏览器同样拿不到",
    ],
  }
  if (report === undefined || report.status === "unknown") {
    return {
      ...base, status: "unknown", reading: report?.reading ?? "未上报：WebGL 上下文只有浏览器创建时才知道能不能用（宿主进程测不出浏览器能力）",
      impact: "**未知不等于可用**：3D 预览/场景 tab 必须在创建上下文失败时**显式报错并给建议**，不得留空座位（DEV-039 的缺陷形态）。",
      uncertain: false, degradation: null, remedy,
    }
  }
  if (report.status === "ready") {
    return { ...base, status: "ready", reading: report.reading, impact: "无：3D 预览与场景 tab 可渲染。", uncertain: false, degradation: null, remedy: { summary: "无需处置。", steps: [] } }
  }
  return {
    ...base, status: report.status === "degraded" ? "degraded" : "broken", reading: report.reading,
    impact: "3D 预览/场景 tab 不可渲染。**绝不静默留空**：必须显示明确原因 + 处置建议（DEV-039 的修复判据）。",
    uncertain: report.uncertain ?? false,
    degradation: report.status === "degraded" ? { path: "退回软件渲染（SwiftShader/llvmpipe）", active: true, restore: "开启硬件加速或修复 GPU 可见性后重启浏览器" } : null,
    remedy,
  }
}

/**
 * **DEV-039 的契约侧接口**（呈现侧由 W11 做，这里只给判据与话术）。
 *
 * 浏览器在创建 WebGL 上下文失败时，把失败原样包成 `EnvironmentReport` 传进来，就能拿到
 * 统一的状态、错误码（`ENVIRONMENT_WEBGL_<state>`）、影响面与四句话 + 处置步骤——
 * 界面直接渲染，不必自己造句，也就不可能"静默留空座位"。
 *
 * 与 `@lyapunov/viewer` 的诊断码对齐：viewer 抛 `VIEWER_WEBGL_UNAVAILABLE` 时这样上报即可
 *   `webglNotice({ status: "broken", reading: \`WebGL 上下文创建失败：VIEWER_WEBGL_UNAVAILABLE（${原始消息}）\`, evidence: [原始消息] })`
 *
 * 客户端可以 import 这个**纯函数**：本模块的 `probe*` 函数与 `node:` 依赖会被浏览器构建摇掉
 * （本机实测：只引用纯导出时产物里没有 `node:fs`/`node:child_process`）。反之，在客户端引用
 * 任何 `probe*` 函数就会把 node 依赖带进浏览器包——这是本模块唯一的客户端边界纪律。
 */
export function webglNotice(report: EnvironmentReport): {
  status: EnvironmentStatus
  code: string
  reading: string
  impact: string
  wording: string[]
  remedy: EnvironmentRemedy
} {
  const row = webglRow(report)
  return {
    status: row.status, code: environmentCode(row.id, row.state, row.status), reading: row.reading,
    impact: row.impact, wording: environmentRowWording(row), remedy: row.remedy,
  }
}

function networkRow(report: EnvironmentReport | undefined): EnvironmentRow {
  const test = `${ENVIRONMENT_CONTRACT_TEST} › 网络/额度/真机行`
  const base = { id: "network", kind: "network" as const, label: "出网能力", scope: "overall" as const, contractTest: test, evidence: report?.evidence ?? ["面板本身不出网：读数由宿主健康检查/doctor-env 注入"] }
  const degradation: EnvironmentDegradation = { path: "镜像站（hf-mirror）/本地缓存/离线导入；安装器失败会给出明确错误码与日志路径", active: true, restore: "恢复出网或配置代理后自动可用" }
  const remedy: EnvironmentRemedy = {
    summary: "网络受限不会让客户端不可用：确认是否必须下载，能用缓存/镜像就走替代路径。",
    steps: [
      "对表两个端点：`bun run script/doctor-env.ts`（§4/§5：api.vorynel.com/health、hf-mirror.com）",
      "有代理时给宿主进程配 `HTTPS_PROXY`/`HTTP_PROXY`（不要在日志里打印凭据）",
      "大件下载失败：改用镜像或先本地准备好缓存，再重试安装",
    ],
  }
  if (report === undefined || report.status === "unknown") {
    return { ...base, status: "unknown", state: "unreported", reading: report?.reading ?? unknownReport("出网能力", "本模块不做出网探测（那会把界面卡住）").reading, impact: "未知不等于没有网，也不等于有网：依赖下载的功能（模型/资产/Provider 安装）在真正下载前无法确认。", uncertain: false, degradation, remedy }
  }
  return { ...base, status: report.status, state: report.status, reading: report.reading, impact: report.status === "ready" ? "无。" : "下载模型/资产、查询远端状态、安装 Provider 会失败或超时；离线路径仍可用（本地资产库/缓存）。", uncertain: report.uncertain ?? false, degradation, remedy }
}

function quotaRow(report: EnvironmentReport | undefined): EnvironmentRow {
  const test = `${ENVIRONMENT_CONTRACT_TEST} › 网络/额度/真机行`
  const base = { id: "quota", kind: "quota" as const, label: "付费额度", scope: "optional" as const, contractTest: test, evidence: report?.evidence ?? ["面板不查额度：无凭据、也不打印凭据"] }
  const remedy: EnvironmentRemedy = {
    summary: "付费生成需要额度：先确认账号状态，再决定是否走本地资产/离线件。",
    steps: ["在设置页确认账号与额度状态（界面只显示状态，不打印 key）", "额度耗尽时改用本地资产库/已下载的离线件", "验收纪律：环境类条目**不自动授权支付**（见收敛清单 §3.3）"],
  }
  if (report === undefined || report.status === "unknown") {
    return { ...base, status: "unknown", state: "unreported", reading: report?.reading ?? unknownReport("付费额度", "未登录或未上报；本模块不探测计费").reading, impact: "未知不等于有额度：付费生成链路（图生/生图类）在真正调用前不能假设可用。", uncertain: false, degradation: null, remedy }
  }
  return { ...base, status: report.status, state: report.status, reading: report.reading, impact: report.status === "ready" ? "无。" : "付费生成类功能不可用；本地资产与离线导入不受影响。", uncertain: report.uncertain ?? false, degradation: null, remedy }
}

function desktopRow(facts: GraphicsFacts): EnvironmentRow {
  const test = `${ENVIRONMENT_CONTRACT_TEST} › 桌面/真机行`
  const available = facts.display !== null
  return {
    id: "desktop", kind: "desktop", label: "桌面会话（X/Wayland）", status: available ? "ready" : "missing", state: available ? "display" : "headless",
    reading: available ? `显示已声明：${facts.display}` : "无显示（无头会话：没有 DISPLAY/WAYLAND_DISPLAY）",
    impact: available ? "无。" : "图形界面/截图类能力在本会话不可用（多显示器变化也会影响窗口归属）；CLI 与无头渲染不受影响。",
    uncertain: !available && !facts.x11Socket,
    uncertaintyNote: !available && !facts.x11Socket ? "无显示也可能是会话/沙箱没暴露 X11 socket：不等于用户桌面没有显示" : null,
    evidence: [`DISPLAY=${facts.display ?? "未设置"}`, `/tmp/.X11-unix 可见=${facts.x11Socket}`],
    degradation: available ? null : { path: "无头/CLI 模式（不出窗口，改用无头渲染与命令行）", active: true, restore: "在有显示的会话里启动，或接上 X/Wayland 后重启 Host" },
    remedy: { summary: available ? "无需处置。" : "无头服务器不是故障：用 CLI/无头路径即可；需要界面时在有显示的会话里启动。", steps: available ? [] : ["服务器场景：`bun run script/launch.ts` 等 CLI 入口不需要显示", "需要像素证据：用无头渲染或软件渲染（见宿主 GL 行）", "远程会话下 X11 socket 常不可见，别把宿主读数当用户桌面读数"] },
    scope: "optional", contractTest: test,
  }
}

function deviceRow(devices: readonly string[]): EnvironmentRow {
  const test = `${ENVIRONMENT_CONTRACT_TEST} › 桌面/真机行`
  return {
    id: "device", kind: "device", label: "真机（串口设备）", status: devices.length > 0 ? "ready" : "missing", state: devices.length > 0 ? "present" : "absent",
    reading: devices.length > 0 ? `检测到 ${devices.length} 个串口设备：${devices.join(", ")}` : "没有检测到 /dev/ttyACM*、/dev/ttyUSB*、/dev/ttyTHS*",
    impact: devices.length > 0 ? "无。" : "真机采集/真机验收不可用。**仿真不能替代真机验收**（DEV-024 明写），所以这里没有降级路径。",
    uncertain: false, evidence: [`设备：${devices.length > 0 ? devices.join(", ") : "无"}`],
    degradation: null,
    remedy: {
      summary: "需要真机就接上并授予串口权限；不需要真机时这条按需即可（不影响仿真路径）。",
      steps: ["接上机器人后确认设备出现：`ls /dev/tty{ACM,USB}*`", "权限：把用户加进 `dialout` 组（`sudo usermod -aG dialout $USER`，需重新登录），或按厂商 udev 规则放行", "设备被别的进程占用时先释放（`fuser /dev/ttyACM0`）"],
      permission: "dialout 组 / udev 规则（root）",
    },
    scope: "optional", contractTest: test,
  }
}

function micromambaRow(path: string | null, installed: boolean): EnvironmentRow {
  const test = `${ENVIRONMENT_CONTRACT_TEST} › 安装前置（N3）`
  return {
    id: "tool.micromamba", kind: "tool", label: "micromamba（Provider 安装前置）", status: path ? "ready" : "missing", state: path ? "present" : "absent",
    reading: path ?? "未找到 micromamba：`install-provider` 会以 PROVIDER_ENV_TOOL_MISSING 拒绝（`doctor-env` §1d 同判据）",
    impact: path ? "无。" : "**装不了 Provider**：`install-provider` 需要 micromamba 建独立前缀；本机未备时安装会在下载前就失败。",
    uncertain: false, evidence: [installed ? `PATH 命中：${path}` : `LYAPUNOV_MICROMAMBA=${path ?? "未设置"}`],
    degradation: null,
    remedy: {
      summary: "先备 micromamba，再装 Provider。",
      steps: ["按发行文档安装 micromamba（离线包亦可）", "把它放进 PATH，或用 `LYAPUNOV_MICROMAMBA` 显式指定路径", "复核：`micromamba --version` 与 `bun run script/doctor-env.ts` §1d"],
      docUrl: "https://mamba.readthedocs.io/en/latest/installation/micromamba-installation.html",
    },
    scope: "optional", contractTest: test,
  }
}

export interface PanelOptions {
  generatedAt?: string
}

/** N1 一屏：把上面的行拼成面板，并算出总评（unknown 永不等于 ready）。**纯函数**，便于离线测试。 */
export function environmentPanel(facts: EnvironmentFacts, options: PanelOptions = {}): EnvironmentPanel {
  const rows: EnvironmentRow[] = [
    gpuRow(facts.gpu),
    runtimeSummaryRow(facts.runtimes),
    ...facts.runtimes.map(runtime => runtimeRow(runtime, facts.runtimes)),
    graphicsRow(facts.graphics),
    webglRow(facts.webgl),
    networkRow(facts.network),
    quotaRow(facts.quota),
    desktopRow(facts.graphics),
    deviceRow(facts.serialDevices),
    micromambaRow(facts.micromamba, facts.micromamba !== null),
  ]
  const overall = panelOverall(rows)
  const unknown = rows.filter(row => row.status === "unknown").map(row => row.id)
  const unavailable = rows.filter(row => row.status === "missing" || row.status === "broken").map(row => row.id)
  const overallIssues = rows.filter(row => row.scope === "overall" && row.status !== "ready")
  const missingDetails = rows.filter(row => row.scope === "detail" && (row.status === "missing" || row.status === "broken"))
  const optionalUnavailable = rows.filter(row => row.scope === "optional" && (row.status === "missing" || row.status === "broken"))
  const summary = overall === "ready" && unknown.length === 0 && missingDetails.length === 0 && optionalUnavailable.length === 0
    ? `全部就绪（${rows.length} 项）`
    : `${overall === "unusable" ? "不可用" : overall === "degraded" ? "降级" : "就绪"}：${overallIssues.map(row => `${row.label}=${ENVIRONMENT_STATUS_LABEL[row.status]}`).join("、") || "必答项无问题"}` +
      `${missingDetails.length > 0 ? `；${missingDetails.length} 项必答明细不可用（${missingDetails.map(row => row.id).join("、")}）` : ""}` +
      `${unknown.length > 0 ? `；${unknown.length} 项未知（unknown ≠ ready：${unknown.join("、")}）` : ""}` +
      `${optionalUnavailable.length > 0 ? `；${optionalUnavailable.length} 项按需能力不可用（${optionalUnavailable.map(row => row.id).join("、")}，不影响本机可用性）` : ""}`
  return { schema: ENVIRONMENT_CONTRACT_VERSION, generatedAt: options.generatedAt ?? new Date().toISOString(), overall, summary, unknown, unavailable, rows }
}

/**
 * 总评：`unusable` 只给"必答项缺失且**无替代路径**"（三个引擎一个都没装）；
 * 必答明细（单引擎运行时）缺了只降级；按需能力（真机/额度/安装前置/浏览器 WebGL）不参与总评——
 * "没插机器人"不许被报成"这台机器不可用"。
 */
export function panelOverall(rows: readonly EnvironmentRow[]): EnvironmentPanel["overall"] {
  const overall = rows.filter(row => row.scope === "overall")
  const detail = rows.filter(row => row.scope === "detail")
  if (overall.some(row => (row.status === "missing" || row.status === "broken") && row.degradation === null)) return "unusable"
  if (overall.some(row => row.status !== "ready")) return "degraded"
  if (detail.some(row => row.status === "missing" || row.status === "broken")) return "degraded"
  return "ready"
}

/** 真实探测 + 组面板（宿主侧入口；测试用 `environmentPanel(合成 facts)` 走纯函数）。 */
export function environmentReadiness(input: EnvironmentProbeInput): EnvironmentPanel {
  return environmentPanel(probeEnvironmentFacts(input))
}

// ───────────────────────── N4：声明式环境依赖契约（D1–D4 通用化） ─────────────────────────

export interface EnvironmentRequirement {
  /** 面板行的 id（`gpu`、`runtime.isaac`、`webgl`…）。 */
  id: string
  /** `required` = 缺了功能不成立；`preferred` = 缺了功能还在，只是质量/覆盖变差（永不阻断）。 */
  mode: "required" | "preferred"
  /**
   * 该功能**自己**的降级路径；缺省用依赖行的降级路径。显式 `null` = 该功能无替代路径
   * → 走 D3：明确拒绝并给处置建议（这正是 DEV-039 需要的判据）。
   */
  degradation?: EnvironmentDegradation | null
}

export interface EnvironmentDeclaration {
  feature: string
  label: string
  requires: readonly EnvironmentRequirement[]
}

export type EnvironmentVerdict =
  | { feature: string; status: "ready"; code: null; wording: string[] }
  | { feature: string; status: "degraded"; code: string; degradation: EnvironmentDegradation; wording: string[] }
  | { feature: string; status: "blocked"; code: string; remedy: EnvironmentRemedy; wording: string[] }


/** 依赖行的降级路径为空（无替代）时是否必须拒绝：`required` 且解析后无降级。 */
export function resolvedDegradation(requirement: EnvironmentRequirement, row: EnvironmentRow): EnvironmentDegradation | null {
  return requirement.degradation === undefined ? row.degradation : requirement.degradation
}

/**
 * N4 的核心：**声明 + 面板 → 统一判定**。
 *
 * 规则（四种依赖状态 × 两种模式，穷尽即可测）：
 *  · 行就绪 → `ready`；
 *  · 行未知 → `degraded`（unknown ≠ ready：给"怎么测清楚"，不阻断也不放行）；
 *  · 行缺失/损坏且**有**降级路径 → `degraded`（D2：把在走什么、怎么改回讲清楚）；
 *  · 行缺失/损坏且**无**降级路径 → `blocked` + 错误码 + 处置步骤（D3）；
 *  · `preferred` 永不 `blocked`（功能还在，只是覆盖变差）。
 * 声明引用了面板里没有的 id → `blocked`（fail-closed：契约漂移必须响，不许静默放过）。
 */
export function evaluateEnvironment(declaration: EnvironmentDeclaration, panel: EnvironmentPanel): EnvironmentVerdict {
  const degradedRows: EnvironmentRow[] = []
  for (const requirement of declaration.requires) {
    const row = environmentRowById(panel, requirement.id)
    if (row === undefined) {
      return {
        feature: declaration.feature, status: "blocked", code: `ENVIRONMENT_DEPENDENCY_NOT_DECLARED:${requirement.id}`,
        remedy: { summary: `环境契约漂移：依赖 ${requirement.id} 没有对应的面板行。`, steps: ["把这个依赖登记进 environment-readiness 的面板行（否则它永远不会被预检）", "契约漂移按缺陷处理，不许静默放过"] },
        wording: [`[${declaration.label}] 不可用：环境契约里没有 ${requirement.id} 这一行（ENVIRONMENT_DEPENDENCY_NOT_DECLARED:${requirement.id}）`],
      }
    }
    if (row.status === "ready") continue
    const degradation = resolvedDegradation(requirement, row)
    if (row.status !== "unknown" && requirement.mode === "required" && degradation === null) {
      return {
        feature: declaration.feature, status: "blocked", code: environmentCode(row.id, row.state, row.status), remedy: row.remedy,
        wording: [
          `[${declaration.label}] 不可用：${row.reading}（${environmentCode(row.id, row.state, row.status)}）`,
          `影响：${row.impact}`,
          "现在：**无替代路径**，该能力被明确拒绝——不会静默留空、也不会假装成功。",
          `怎么解决：${row.remedy.summary}`,
          ...row.remedy.steps.map(step => `· ${step}`),
        ],
      }
    }
    degradedRows.push(row)
  }
  if (degradedRows.length === 0) {
    return { feature: declaration.feature, status: "ready", code: null, wording: [`[${declaration.label}] 就绪：环境依赖全部满足。`] }
  }
  const first = degradedRows[0]!
  const path = resolvedDegradation(declaration.requires.find(requirement => requirement.id === first.id)!, first)
  const wording = [
    `[${declaration.label}] 降级运行：${first.reading}（${environmentCode(first.id, first.state, first.status)}）`,
    `影响：${first.impact}`,
    path ? `现在：${path.path}${path.active ? "（已在走这条路）" : "（可用时自动切换）"}` : "现在：未知不等于可用，先按下面的步骤把读数测清楚。",
    path ? `怎么改回：${path.restore}` : `怎么解决：${first.remedy.summary}`,
    ...first.remedy.steps.map(step => `· ${step}`),
  ]
  return { feature: declaration.feature, status: "degraded", code: environmentCode(first.id, first.state, first.status), degradation: path ?? { path: "未知依赖按“先确认再使用”处理", active: false, restore: first.remedy.summary }, wording }
}

/**
 * 内置声明表：**产品里现有的环境相关功能都在这里声明依赖**，新功能照抄一条即可。
 * 这张表就是 D1–D4 从"散落的行为"变成契约的地方（N4）。
 */
export const ENVIRONMENT_DECLARATIONS: readonly EnvironmentDeclaration[] = [
  { feature: "sim.mujoco.cpu", label: "MuJoCo（CPU 物理）", requires: [{ id: "runtime.mujoco", mode: "required" }] },
  { feature: "sim.isaac.cpu", label: "Isaac 纯 CPU 物理/适配层", requires: [{ id: "runtime.isaac", mode: "required" }, { id: "gpu", mode: "preferred" }] },
  // RTX 渲染没有替代路径：无 GPU（或 GPU 对本会话不可见）就必须明确拒绝，而不是出一张假图/空图。
  { feature: "sim.isaac.rtx", label: "Isaac RTX 渲染/相机族（RGB-D、首帧）", requires: [{ id: "runtime.isaac", mode: "required" }, { id: "gpu", mode: "required", degradation: null }] },
  // Newton 的设备 `auto` 自带降级（sim-newton：有 CUDA 用 cuda:0，没有就 cpu），所以 GPU 是 preferred。
  { feature: "sim.newton.cuda", label: "Newton（Warp）物理", requires: [{ id: "runtime.newton", mode: "required" }, { id: "gpu", mode: "preferred" }] },
  // DEV-039 的契约侧：3D 预览无 WebGL 时没有替代路径 → 显式错误 + 建议，绝不静默留空。
  { feature: "preview.webgl", label: "3D 预览/场景 tab", requires: [{ id: "webgl", mode: "required", degradation: null }] },
  { feature: "asset.download", label: "模型/资产下载", requires: [{ id: "network", mode: "required" }] },
  { feature: "generate.paid", label: "付费生成链路", requires: [{ id: "quota", mode: "required", degradation: null }] },
  // DEV-024 明写"仿真不能替代真机"：真机验收无降级路径，缺设备就明确拒绝。
  { feature: "robot.real", label: "真机采集/验收", requires: [{ id: "device", mode: "required", degradation: null }] },
  // N3：安装期前置检查。`tool.micromamba` 无替代路径（install-provider 靠它建独立前缀，doctor-env §1d），
  // 所以它是 required；GPU 是 preferred 且**降级话术写明"没有 GPU 会怎样"**——Isaac 6.0.1.0 纯 CPU 可跑
  // 物理与适配层，装是能装的，只是装完 RTX/CUDA 绑定能力不可用。安装器默认只报不拦（见 provider-installer
  // 的 `environmentGate`），strict 模式下 required 且无降级的那一项才会拒绝。
  {
    feature: "install.mujoco", label: "安装 MuJoCo Provider",
    requires: [{ id: "tool.micromamba", mode: "required" }, { id: "network", mode: "preferred" }, { id: "runtime.simulation", mode: "preferred" }],
  },
  {
    feature: "install.policy-cpu", label: "准备独立 CPU 策略运行环境",
    requires: [{ id: "tool.micromamba", mode: "required" }, { id: "network", mode: "preferred" }],
  },
  {
    feature: "install.isaac", label: "安装 Isaac Provider",
    requires: [
      { id: "tool.micromamba", mode: "required" },
      { id: "gpu", mode: "preferred", degradation: { path: "照装不误：Isaac 6.0.1.0 纯 CPU 可跑物理与适配层；装完后 RTX/CUDA 绑定能力（RGB-D、首帧、rendering:rtx）不可用", active: true, restore: "GPU 可用后 RTX/CUDA 自动可用，不需要重装" } },
      { id: "network", mode: "preferred" },
    ],
  },
  {
    feature: "install.newton", label: "安装 Newton Provider",
    requires: [
      { id: "tool.micromamba", mode: "required" },
      { id: "gpu", mode: "preferred", degradation: { path: "照装不误：Newton/Warp 设备 `auto` 无 CUDA 时自动用 cpu（sim-newton 的既有行为）", active: true, restore: "GPU 可用后自动用 cuda:0，不需要重装" } },
      { id: "network", mode: "preferred" },
    ],
  },
]

/** 取某个功能的声明；取不到就抛（新增功能必须显式登记依赖，不许"忘了声明"就上线）。 */
export function environmentDeclarationOf(feature: string): EnvironmentDeclaration {
  const declaration = ENVIRONMENT_DECLARATIONS.find(candidate => candidate.feature === feature)
  if (!declaration) throw new Error(`ENVIRONMENT_DECLARATION_NOT_FOUND: ${feature}（新功能必须声明环境依赖，见 environment-readiness.ts）`)
  return declaration
}

/** 按功能名判定（宿主与界面共用的入口）。 */
export function featureEnvironmentVerdict(feature: string, panel: EnvironmentPanel): EnvironmentVerdict {
  return evaluateEnvironment(environmentDeclarationOf(feature), panel)
}

/** 某功能声明的依赖行（界面只需要渲染这几行，不用把整屏塞进每个功能里）。 */
export function declarationRows(feature: string, panel: EnvironmentPanel): EnvironmentRow[] {
  return environmentDeclarationOf(feature).requires.map(requirement => environmentRowById(panel, requirement.id)).filter((row): row is EnvironmentRow => row !== undefined)
}
