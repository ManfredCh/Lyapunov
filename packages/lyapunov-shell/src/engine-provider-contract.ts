/**
 * 引擎状态投影的**线上形状**（宿主 `plugin.ts` 与界面 `engine-settings.tsx` 共用这一份声明）。
 *
 * 为什么单独一个文件：这两端原本各写了一遍同名结构（`EngineProviderStatus` / `ProviderRow`），
 * 字段一改就得改两处，漂移时**编译期不会报**（各自都能自洽），只会在运行时表现为"界面少显示一个字段"。
 * 类型只有这一份来源，任一端改形状都会立刻影响另一端。
 *
 * 只放类型：不引入运行时依赖，客户端 bundle 里会被完全擦除。
 */

/** 由 `--engine` 可选值决定的引擎类别；基准测试（评测负载）不属于这里。 */
export type EngineProviderKind = "engine"|"runtime"

/** 单个引擎的运行时候选与产品托管安装状态。`engineChoice` 为 null 表示它不能在启动时被装配。 */
export interface EngineProviderStatus {
  id: string
  label: string
  kind: EngineProviderKind
  /** `install-provider` 唯一管理的产品前缀；外置解释器绝不作为安装目标。 */
  prefix: string
  /** 本次启动会选用的解释器与来源，均由 SDK 唯一解析器给出。 */
  runtimePython: string
  runtimeSource: "env-override" | "saved-preference" | "package-default"
  /** 托管前缀的 SDK 状态，独立于当前是否选用了外置解释器。 */
  managedStatus: "missing" | "partial" | "ready"
  /** 当前选定解释器能发现 SDK 模块；不等于世界/物理/RTX 已验收。 */
  installed: boolean
  version: string | null
  /** 面向人的当前运行时诊断与引擎选择原因，界面直接显示。 */
  detail: string
  /** 是否由 `install-provider` 支持安装/修复。 */
  installable: boolean
  /** 可写进偏好的引擎取值（`--engine <值>`）；不为 null 时界面才给"切换到此引擎"。 */
  engineChoice: string | null
}

/** `install-provider` 结束时输出的 JSON 结局（BLOCKED/OK 等），由日志最后一段解析得到。 */
export interface EngineInstallResult { status?: string; code?: string; message?: string; eulaUrl?: string }

/** 一次安装的状态：`running`/`startedAt` 描述**这次调用**，`result` 是脚本输出的 JSON，两者不混用。 */
export interface EngineInstallState {
  provider: string
  running: boolean
  startedAt: number | null
  logPath: string
  /** 日志尾部（供界面显示），已截断。 */
  tail: string
  result: EngineInstallResult | null
  /** 命令行等价入口，供无界面/远程场景复制。 */
  cli: string
}

/** 一次第三方许可的接受记录（目前只有 Isaac 的 NVIDIA Omniverse）。 */
export interface EngineLicenseAcceptance { acceptedAt: string; eulaUrl: string }
export interface EngineLicenses { isaac?: EngineLicenseAcceptance }

/**
 * 自动选择的一格候选判据：`blockers` 是**逐条**缺什么（面板直接显示这些原话，不另编"默认"）。
 * 形状与上游 `script/engine-preference.ts` 的 `AutoEngineCandidate` 一致。
 */
export interface EngineCandidateAssessment {
  engine: string
  ready: boolean
  blockers: readonly string[]
  /** 该候选 `ready` 的**检测范围**（isaac 用）：只覆盖列出的几项，不冒充 RTX/世界验收。 */
  scope?: string
}

/** 面板"为什么是它/下次启动是谁"的只读投影：字段全部来自上游 `resolveEngine()` 的原话。 */
export interface EnginePanelChoice {
  engine: string
  source: string
  reason: string
  /** 走到自动判定时给出 isaac/mujoco 两格候选的逐条判据；显式/环境/偏好时不带这个键。 */
  candidates?: readonly EngineCandidateAssessment[]
}
export interface EnginePanelDecision {
  running: string | null
  preference: string | null
  runtime: EnginePanelChoice | null
  next: EnginePanelChoice | null
  /** 本次探测到的 GPU 事实（与自动判定同一份读数；探测不可用时为 null）。 */
  gpu: { accelerator: string; state: string; headline: string } | null
  restartRequired: boolean
  error?: string
}

/** `GET /api/lyapunov/engine-providers` 的完整响应（`runtime-info` 里只内联 `providers` 一段）。 */
export interface EngineProvidersPayload {
  runningEngine: string | null
  preference: string | null
  choices: readonly string[]
  providers: EngineProviderStatus[]
  installs: EngineInstallState[]
  licenses: EngineLicenses
  /** 缺省/显式选择的判定与回退理由（旧宿主可能没有这个键，故为可选）。 */
  engineDecision?: EnginePanelDecision
}

export interface IsaacLocalCandidate {
  python: string
  kind: "python" | "standalone"
  state: "candidate" | "missing" | "incompatible" | "unavailable" | "timeout"
  moduleFound: boolean
  sdkVersion: string | null
  pythonVersion: string | null
  sdkRoot: string | null
  compatible: boolean
  detail: string
}
export interface IsaacLocalSelection {
  savedPython: string | null
  nextPython: string
  nextSource: EngineProviderStatus["runtimeSource"]
  restartRequired: boolean
  detail: string
}
export interface IsaacLocalDiscovery {
  candidates: IsaacLocalCandidate[]
  selection: IsaacLocalSelection
  scanned: number
  limited: boolean
  detail: string
}
