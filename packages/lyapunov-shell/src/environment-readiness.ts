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
import { accessSync, closeSync, constants, existsSync, lstatSync, openSync, readFileSync, readdirSync, readSync, rmdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import {resolveSdkPython, SDK_PYTHON_ENV, SDK_PYTHON_PACKAGE_PATH, type SdkPythonSource} from "../../lyapunov-product-bundle/src/sdk-python.mjs"
import {inspectIsaacPythonSync} from "../../lyapunov-product-bundle/src/isaac-sdk-probe.mjs"

/** 契约版本：形状变了就 +1；宿主与界面都读它，避免"字段悄悄换了名字"而编译期不报。 */
export const ENVIRONMENT_CONTRACT_VERSION = 1
/** D4：钉住本契约判据的回归测试（每行的 `contractTest` 都指向它，便于"判据↔测试"互相追溯）。 */
export const ENVIRONMENT_CONTRACT_TEST = "packages/lyapunov-shell/test/environment-readiness.test.ts"

// ───────────────────────────── D1–D4 的字段形状 ─────────────────────────────

export type EnvironmentStatus = "ready" | "degraded" | "missing" | "broken" | "unknown"

/** 状态的人话标签：界面直接用这一份，避免每个面板各译一遍。 */
export const ENVIRONMENT_STATUS_LABEL: Record<EnvironmentStatus, string> = {
  ready: "就绪", degraded: "降级", missing: "缺失", broken: "损坏", unknown: "未知",
}

export type EnvironmentKind = "gpu" | "runtime" | "graphics" | "network" | "quota" | "desktop" | "device" | "tool"

/** D3 的"可执行的下一步"：装什么、去哪装、需要什么权限。**不许**只写"环境有问题"。 */
export interface EnvironmentRemedy {
  summary: string
  steps: readonly string[]
  permission?: string
  docUrl?: string
}

/** D2 的降级路径：有替代就走替代，并讲清"在走什么、为什么、怎么改回"。 */
export interface EnvironmentDegradation {
  /** 替代路径是什么（"回退 MuJoCo 跑 CPU 物理"）。 */
  path: string
  /** 现在是否**已经**在走这条路（"装好后自动改回"的另一半）。 */
  active: boolean
  /** 怎么改回完整能力。 */
  restore: string
}

/** 一行依赖的完整状态：D1 读数 + 影响面 + D2 降级 + D3 处置。 */
export interface EnvironmentRow {
  id: string
  kind: EnvironmentKind
  label: string
  status: EnvironmentStatus
  /** 细分态（GPU 五态、运行时空壳…）；无细分时为 null。 */
  state: string | null
  /** 一句话实测读数，界面直接显示。 */
  reading: string
  /** 影响面：缺了**具体**会怎样（说到功能，不写"可能有问题"）。 */
  impact: string
  /** 这个判定是否**不确定**（读数可能有误/不完整/只是启发式）。true 时话术必须原样带出下面的说明。 */
  uncertain: boolean
  /**
   * 这一行**自己的**不确定性说明（`uncertain === true` 时由通用话术原样带出）。
   *
   * 为什么放行数据里而不是话术函数里：不同依赖"不确定"的原因完全不同——GPU 是"可能是沙箱/容器误报"，
   * 宿主 GL 是"无显示≠用户浏览器没有 WebGL"，HTML 预检是"只扫了前 N 字节"。把某一方的句子硬编码进
   * 通用分支，别的调用方就只能**绕开** `uncertain`（等于没有这个机制）——这正是 2026-09-26 修掉的那个错。
   * 缺省（不给）= 通用分支只说中性的"这个判定不确定，别据此下结论"。
   */
  uncertaintyNote?: string | null
  /** 原始证据行（不含凭据），可原样贴进回执。 */
  evidence: readonly string[]
  /** D2：有替代路径就给；`null` = 无替代 → 由 D3 明确拒绝。 */
  degradation: EnvironmentDegradation | null
  /** D3：处置建议。 */
  remedy: EnvironmentRemedy
  /**
   * 这一行怎么参与总评（三种语义，界面也可以按它分组）：
   *  · `overall` 必答项：缺了且无降级路径 → 总评 `unusable`；缺了 → `degraded`；
   *  · `detail` 必答明细（单引擎运行时）：缺了 → `degraded`，但永远不判 `unusable`；
   *  · `optional` 按需能力（真机/额度/安装前置/浏览器 WebGL）：只登记不降总评——
   *    "没插机器人"不许被报成"这台机器不可用"。
   */
  scope: "overall" | "detail" | "optional"
  /** D4：钉住这一行判据的回归测试。 */
  contractTest: string
}

/** N1：用户可见的**一屏**（GPU/驱动、各引擎运行时、WebGL、网络、额度…）。 */
export interface EnvironmentPanel {
  schema: typeof ENVIRONMENT_CONTRACT_VERSION
  generatedAt: string
  /** 总评：`unusable` 只给"必答项缺失且无替代路径"（例如三个模拟引擎一个都没装）。 */
  overall: "ready" | "degraded" | "unusable"
  summary: string
  /** 读不到的依赖 id。unknown ≠ ready，界面必须显式列出而不是留空。 */
  unknown: readonly string[]
  /** 明细里不可用的依赖 id（按需能力：真机/额度/单引擎）。 */
  unavailable: readonly string[]
  rows: readonly EnvironmentRow[]
}

export function environmentRowById(panel: EnvironmentPanel, id: string): EnvironmentRow | undefined {
  return panel.rows.find(row => row.id === id)
}

// ───────────────────────────── 统一话术（D2/D3） ─────────────────────────────

/**
 * 一行依赖的**统一话术**：状态 → 影响 → 现在怎么办 → 怎么改回。
 *
 * 四个功能（引擎回退、Provider 安装、Provider 运行、界面呈现）都说这四句，界面直接逐行渲染即可；
 * 需要换措辞时改这一处——这正是 N4"统一话术"的落点。
 */
export function environmentRowWording(row: EnvironmentRow): string[] {
  // 通用分支**不塞任何调用方专属的句子**：行自己给了 uncertaintyNote 就原样带出，没给就说中性那句。
  const note = row.uncertaintyNote ?? null
  const uncertainty = row.uncertain
    ? note !== null && note !== undefined && note.trim() !== ""
      ? `（${note.trim()}）`
      : "（**这个判定不确定**：不得据此下结论，按下面的步骤复核后再行动）"
    : ""
  const head = `[${row.label}] ${ENVIRONMENT_STATUS_LABEL[row.status]}：${row.reading}${uncertainty}`
  const impact = `影响：${row.impact}`
  if (row.status === "unknown") {
    // 读不到时**只**说"怎么把它测清楚"：既不放行也不阻断，绝不拿降级路径冒充"已经查清"。
    return [head, impact, "现在：未知不等于可用，先按下面的步骤把读数测清楚（既不放行、也不阻断）", `怎么测清楚：${row.remedy.summary}`, ...row.remedy.steps.map(step => `· ${step}`)]
  }
  const current = row.degradation
    ? `现在：${row.degradation.path}${row.degradation.active ? "（已在走这条路）" : "（可用时自动切换）"}`
    : row.status === "ready"
      ? "现在：无需处置"
      : "现在：**无替代路径**，该能力将被明确拒绝（不会静默留空）"
  const fix = row.degradation ? `怎么改回：${row.degradation.restore}` : `怎么解决：${row.remedy.summary}`
  return [head, impact, current, fix, ...row.remedy.steps.map(step => `· ${step}`)]
}

/** 整屏话术：总述 + 每个非就绪行的四句话（就绪行不刷屏）。 */
export function environmentPanelWording(panel: EnvironmentPanel): string[] {
  const lines = [`环境就绪：${panel.summary}`]
  for (const row of panel.rows) if (row.status !== "ready") lines.push("", ...environmentRowWording(row))
  return lines
}

// ───────────────────────── N2：GPU 缺失/损坏的分型与话术 ─────────────────────────

/**
 * GPU 状态分型。清单里点名的是五类：无卡／驱动没装／驱动挂了／容器不可见／显存不足；
 * 另加本机真的会遇到、且话术必须不同的：驱动过旧（有卡有驱动但低于能力要求）、读不到（不猜）、
 * **诊断工具缺失**（`smi-missing`：设备与驱动都在，只是没装 `nvidia-smi`）与
 * **卡的有无未能确认**（`card-unknown`：驱动在，但 PCI 与驱动挂载都没读到卡）。
 * `ready` 是唯一"可以用"的状态。
 *
 * 后两个状态是 2026-09-26 验收拿真容器实测出来的**反向误诊**（`VERIFY-ENV-READINESS-GPU-20260926.md` A1/A3）：
 *  · A1：`--gpus all` 下设备 5 个字符节点全可见、驱动已注册，只因镜像里没有 `nvidia-smi`，
 *    读数里**自己就写着**"nvidia-smi 未安装"，却被判成 `driver-broken`、处置写"先重启…重装与内核匹配的驱动"
 *    —— 用户被叫去重装一个**好着的**驱动，与原始缺陷同一形状；
 *  · A3：驱动模块在、卡不在 ⇒ 判成 `device-hidden` 并断言"卡是好的"，而同一条解释链第 2 段刚说
 *    "没有认到任何 GPU"——自相矛盾且反向误导（叫用户"不要换卡"）。
 * ⇒ 铁律：**缺诊断工具 ≠ 驱动坏了**；**「声称有卡」必须有 PCI 或驱动挂载证据**；**读不到 ≠ 没有**。
 */
export type GpuState =
  | "ready" | "no-device" | "driver-missing" | "driver-broken" | "device-hidden"
  | "vram-insufficient" | "driver-outdated" | "unknown"
  /**
   * 设备节点与驱动都在，但 `nvidia-smi` **给不出可用读数**（未安装 / 装了跑不起来 / 调用方关掉了探测）：
   * 缺的是**工具或工具的运行条件**，不是驱动。三种原因在这一个态里用 `smi.reason` + 取证分开（见 `SmiAbsenceReason`）。
   */
  | "smi-missing"
  /** 驱动已注册，但 PCI 与驱动挂载都**没有**读到卡：不能声称有卡，也不能断言没有卡。 */
  | "card-unknown"

/**
 * `nvidia-smi` 不可用时的**原因**（A1 的判据：缺工具 ≠ 驱动坏了）。
 *
 * ⚠️ 三条原因**必须分得开**，因为处置各不相同，而且**`ENOENT` 一个人证明不了其中任何一条**
 * （2026-09-26 二级验收在 A1 自己的证据容器里实测到的复发）：
 * ```
 * docker run --gpus all oven/bun:1.3.13-alpine
 *   command -v nvidia-smi        ⇒ /usr/bin/nvidia-smi   （在 PATH 里）
 *   文件 1259616 B / -rwxr-xr-x / ELF x86-64 / 可读
 *   execFileSync("nvidia-smi")   ⇒ ENOENT: posix_spawn   （绝对路径同样）
 *   PT_INTERP = /lib64/ld-linux-x86-64.so.2，而 musl 底座没有 /lib64
 * ```
 * ⇒ 那个容器里工具**装着、也在 PATH 里，只是加载不了**；`ENOENT` 只说明"执行不了"。
 *
 *  · `not-installed`：**PATH（或显式路径）上没有任何这个文件**——`ENOENT` **且**扫描不到候选；
 *  · `not-runnable`：候选**在盘上**（可读、有可执行位），`ENOENT` 仍发生 ⇒ 内核加载不了
 *    （缺 ELF 解释器/loader——glibc 二进制落在 musl/distroless 底座上最常见；脚本则是 shebang 解释器不存在）；
 *  · `not-probed`：调用方显式关掉了该探测（`GpuProbeOptions.smi=false`）；
 *  · 缺省（`undefined`）：原因未记录（旧调用方/合成事实）——读数按 `error` 原样带出，**不编造**具体原因。
 */
export type SmiAbsenceReason = "not-installed" | "not-runnable" | "not-probed"

/**
 * `nvidia-smi` 不可用时**取证到的现场**（探测在 ENOENT 之后自己去盘上读的，不是推断）。
 * 存在理由与 `GpuFacts.deviceExtras` 那条一样：**判定要能被第三方拿着同一份证据复核**——
 * 只有 `ENOENT` 一个错误码时，"没装"与"装了跑不起来"在读数里长得一模一样，而处置相反。
 */
export interface SmiAbsenceEvidence {
  /** 解析可执行名得到的候选路径（按 PATH 顺序；目录项存在即算，**含悬空符号链接**），最多 `SMI_PATH_SCAN_LIMIT` 条。 */
  candidates: readonly string[]
  /** 取证对象 = 第一个候选（内核会先试它）；没有候选时为 `null`（⇒ `not-installed`）。 */
  path: string | null
  /** 目录项在、但目标解析不到（悬空符号链接）。 */
  danglingSymlink: boolean
  /** 目标存在且是**常规文件**。 */
  regularFile: boolean
  /** `accessSync(R_OK)` 通过（读不到时，连"它需要哪个解释器"都取不到证）。 */
  readable: boolean
  /** `accessSync(X_OK)` 通过（**有可执行位**；`ENOENT` 发生时它照样可能是 true，这正是三态的分界）。 */
  executable: boolean
  /** 内核加载它时要用的解释器（ELF 的 `PT_INTERP` 或脚本的 shebang），读不出为 `null`。 */
  interpreter: string | null
  /** 解释器在不在盘上；`null` = 没读到解释器（**无法判断**，不是"不缺"）。 */
  interpreterPresent: boolean | null
}

export interface GpuFacts {
  probeError: string | null
  /** `/proc/driver/nvidia/version` 首行：驱动在本命名空间里**已注册**的判据。 */
  driverVersion: string | null
  /** `/proc/driver/nvidia/gpus/<busid>`：驱动**已挂载**的 GPU（比 `/dev` 更强——证明驱动认到了卡）。 */
  driverGpuEntries: readonly string[]
  /** 本会话真实存在、**且是字符设备**的 `/dev/nvidia*`（能打开的才算"设备可见"）。 */
  deviceNodes: readonly string[]
  /**
   * `/dev` 下其它 `nvidia*` 条目（如 `nvidia-caps` 目录）。
   * 实测教训（本机 2026-09-26）：`nvidia-caps` 目录可能在**首次跑过 nvidia-smi 之后才出现**，
   * 目录存在≠设备可打开（nvidia-smi 仍然打不开 `/dev/nvidiactl`）。只看"有没有 nvidia*"会
   * 让同一台机器在"设备被会话隐藏"和"驱动坏了"之间跳变——两句话术的处置完全相反，必须按类型分。
   * ⚠️ 这个条目可能是 `nvidia-smi` **自己创建**的（跑一次就凭空建目录，见下）。所以 `probeGpuFacts()` 做两件事：
   * ① **先跑 nvidia-smi、后枚举 `/dev`**（顺序固定 ⇒ 读数与"探测被调用过几次"无关）；
   * ② 枚举之后把**本次窗口内新出现 + 是目录 + 空**的条目**收回去**再读一次
   *    （⇒ 证据是这台机器本来的样子，不是"探测跑过没有"的函数；撤不掉的照实留下并上报）。
   * 这两条不变式由 `environment-readiness.test.ts` 的「探测顺序无关」用例与
   * `gpu-misdiagnosis-guard.test.ts` 的「探测不把自造条目写进证据」用例钉住，改动前先读它们。
   */
  deviceExtras: readonly string[]
  /** `/sys/bus/pci/devices` 里 vendor=`0x10de` 的设备（卡在不在**本命名空间**里的判据）。 */
  pciDevices: readonly string[]
  /**
   * 每张卡的**可核对身份**：`0000:02:00.0 10de:2c58 class=0x030000`。
   * 用户/回执拿这一行就能用 `lspci -nn` 对上（解释链的第一环：**卡是好的**）。
   */
  pciIds: readonly string[]
  /**
   * 驱动**已挂载**的 GPU 型号：`0000:02:00.0 NVIDIA GeForce RTX 5090 Laptop GPU`
   * （取自 `/proc/driver/nvidia/gpus/<busid>/information` 的 `Model:` 行）。
   * **只取型号**：同一份文件里的 GPU UUID 与 serial 不进内存、不进面板、不进浏览器（面板会下发到前端）。
   */
  driverGpuModels: readonly string[]
  smi: { present: boolean; ok: boolean; output: string; error: string; reason?: SmiAbsenceReason; absence?: SmiAbsenceEvidence }
  /**
   * 下面三个标记区分**读不到**与**确实没有**（2026-09-26 验收 A2：`/sys` 与 `/proc/driver` 都被遮蔽时，
   * 旧判据照样断言"本机确实没有卡——不是看不见，是没有"，与原缺陷同形）。
   *
   * `false` = 那个来源**读不到**（`readdirSync` 失败：gVisor/显式 mask `/proc`/受限沙箱/非 Linux）；
   * `true` = 读到了，于是"里面没有 nvidia/0x10de"才是"确实没有"的证据。
   *
   * 缺省（`undefined`）按**可读**处理：旧调用方与 JSON 反序列化拿不到这两个字段，那时只能沿用旧口径
   * （`probeGpuFacts` 自己**总是**显式给值，所以真实探测路径永远有这一层区分）。
   */
  pciReadable?: boolean
  driverReadable?: boolean
  devReadable?: boolean
  /** 从 nvidia-smi 读到的显存（MiB）；读不到为 null。 */
  capacity: { totalMiB: number; freeMiB: number } | null
  /** 本次能力需要的可用显存；缺省用一个"几乎满了就算不足"的下限，见 `MIN_FREE_VRAM_MIB`。 */
  requiredVramMiB: number | null
  /** 该能力声明的最低驱动主版本；未声明则不判"驱动过旧"。 */
  minDriverMajor: number | null
}

/** 未声明需求时判定"显存不足"的可用显存下限（MiB）：低于它任何 RTX/大场景都会 OOM。 */
export const MIN_FREE_VRAM_MIB = 512

export interface GpuClassification {
  state: GpuState
  reading: string
  uncertain: boolean
  evidence: string[]
  /**
   * **解释链**（用户/回执要能顺着读下来）：卡 → 驱动 → 设备 → 结论 → 处置。
   * 与 `evidence`（原始读数）分开：这一份是给人读的因果链，`device-hidden` 时它必须让用户看清
   * "卡和驱动都是好的，只是这个会话看不见设备"，而不是笼统的"GPU 不可用"。
   */
  explanation: string[]
}

/**
 * GPU 分型：只看**本机真实读到的五件事**（卡/驱动注册/驱动挂载/设备节点可见/nvidia-smi 能不能用），
 * 不猜、不合并。分型的意义在于**话术不同**——"客户机没卡"和"本会话看不到卡"的处置完全相反。
 *
 * 三条不许破的铁律（2026-09-26 验收 A1–A3 的实测误诊，每条都有真容器/合成复现）：
 *  1. **缺诊断工具 ≠ 驱动坏了**：`smi.present === false`（没装 `nvidia-smi`）时**不得**落进
 *     `driver && nodes → driver-broken`，那条路径的处置是"重启/重装驱动"，而这里驱动是好的；
 *  2. **「声称有卡」必须有 PCI 或驱动挂载证据**：两者都没有时不得说"卡是好的"（`device-hidden` 的门）；
 *  3. **读不到 ≠ 没有**：来源读不到（`*Readable === false`）时不得断言"本机确实没有卡"。
 */
export function classifyGpu(facts: GpuFacts): GpuClassification {
  const detail = smiFailureDetail(facts)
  // 兜底 `?? []`：facts 可能来自旧版本调用方或 JSON 反序列化（少字段）。少字段只能让读数变少，
  // **不许**把判定打成异常——那会让"环境缺东西"变成用户看不懂的崩溃。
  const pciIds = facts.pciIds ?? []
  const driverGpuModels = facts.driverGpuModels ?? []
  const deviceExtras = facts.deviceExtras ?? []
  // 铁律 3：三个来源"读到了吗"。缺省（少字段）按旧口径视为可读，见 GpuFacts 的字段说明。
  const pciReadable = facts.pciReadable ?? true
  const driverReadable = facts.driverReadable ?? true
  const devReadable = facts.devReadable ?? true
  const unreadable = [!pciReadable ? "/sys/bus/pci/devices" : null, !driverReadable ? "/proc/driver" : null, !devReadable ? "/dev" : null].filter((what): what is string => what !== null)
  // 设备可见性只认**这一份**判据（只有字符设备算——`/dev/nvidia-caps` 目录不算）。
  // 装配点（sim-isaac plugin）走同一个函数，两处不再各写一套（C1 实测分叉过）。
  const visibility = gpuDeviceVisibility(facts)
  const nodes = visibility.visible
  const evidence: string[] = [
    `/proc/driver/nvidia/version: ${driverReadable ? (facts.driverVersion ?? "不存在") : "读不到（/proc/driver 不可读）"}`,
    `/proc/driver/nvidia/gpus: ${driverReadable ? (facts.driverGpuEntries.length > 0 ? facts.driverGpuEntries.join(", ") : "无挂载记录") : "读不到（/proc/driver 不可读）"}`,
    `/dev/nvidia*: ${devReadable ? `${facts.deviceNodes.length > 0 ? facts.deviceNodes.join(", ") : "无字符设备（不可打开）"}${deviceExtras.length > 0 ? `；另有非字符设备条目 ${deviceExtras.join(", ")}（不算设备可见）` : ""}` : "读不到（/dev 不可读——**不是**“没有设备节点”）"}`,
    `PCI vendor=0x10de: ${pciReadable ? (facts.pciDevices.length > 0 ? facts.pciDevices.join(", ") : "无") : "读不到（/sys/bus/pci/devices 不可读——**不是**“没有卡”）"}`,
    `nvidia-smi: ${facts.smi.present ? `${facts.smi.ok ? "可用" : "失败"} ${(facts.smi.output || facts.smi.error).slice(0, 300)}`.trim() : `不可用（${smiAbsenceDetail(facts)}）`}`,
  ]
  const chain = (card: string, driver: string, device: string, conclusion: string, remedy: string): string[] =>
    [`1. 卡：${card}`, `2. 驱动：${driver}`, `3. 设备：${device}`, `4. 结论：${conclusion}`, `5. 处置：${remedy}`]
  const cardLine = pciIds.length > 0
    ? pciIds.join("、")
    : facts.driverGpuEntries.length > 0
      ? `内核已挂载 ${facts.driverGpuEntries.join("、")}（无 sysfs PCI 读数）`
      : pciReadable ? "本命名空间内没有 NVIDIA PCI 设备" : "PCI 读数不可得（/sys/bus/pci/devices 读不到）"
  const driverLine = facts.driverVersion === null
    ? driverReadable ? "未注册（无 /proc/driver/nvidia/version）" : "读不到（/proc/driver 不可读——不能据此说驱动没装）"
    : `已注册 ${compactDriverVersion(facts.driverVersion)}${driverGpuModels.length > 0 ? `，认到 ${driverGpuModels.join("、")}` : facts.driverGpuEntries.length > 0 ? `，认到 ${facts.driverGpuEntries.join("、")}` : "，但没有认到任何 GPU"}`
  const deviceLine = nodes
    ? `本会话可见字符设备 ${facts.deviceNodes.join("、")}`
    : devReadable
      ? `本会话 /dev 下没有任何 nvidia* 字符设备${deviceExtras.length > 0 ? `（只有 ${deviceExtras.join("、")}，不是可打开的字符设备）` : ""}`
      : "本会话读不到 /dev（无法确认设备节点有没有——不能据此说不可见）"
  const probe = (state: GpuState, reading: string, explanation?: string[], uncertain = false): GpuClassification =>
    ({ state, reading, uncertain, evidence, explanation: explanation ?? chain(cardLine, driverLine, deviceLine, `判型：${state}`, "见该状态的话术") })
  if (facts.probeError) {
    // 探测中断 ⇒ 判定**不确定**（"读不到就不下结论"这句话必须同时体现在数据里，而不只在文案里）。
    return probe("unknown", `探测未完成：${facts.probeError}`,
      chain("未知（探测中断）", "未知", "未知", "**读不到就不下结论**：既不能说有 GPU，也不能说没有", "手工复核：`nvidia-smi -q`、`ls /dev/nvidia*`、`ls /proc/driver/nvidia/gpus`"), true)
  }

  const driver = facts.driverVersion !== null
  const attached = facts.driverGpuEntries.length > 0
  // 铁律 2：「有卡」的证据只有两个——PCI 上有 0x10de，或驱动已挂载 GPU。别的都不算。
  const card = facts.pciDevices.length > 0 || attached
  const smiOut = facts.smi.output.trim()
  const smiErr = detail

  if (facts.smi.present && facts.smi.ok) {
    const capacity = facts.capacity
    const required = facts.requiredVramMiB ?? MIN_FREE_VRAM_MIB
    if (capacity && capacity.freeMiB < required) {
      return probe("vram-insufficient", `${smiOut}；可用显存 ${capacity.freeMiB}/${capacity.totalMiB} MiB，低于本次需要的 ${required} MiB`)
    }
    const major = Number(facts.driverVersion?.match(/\s(\d+)\.\d+/)?.[1])
    if (facts.minDriverMajor !== null && Number.isFinite(major) && major < facts.minDriverMajor) {
      return probe("driver-outdated", `${compactDriverVersion(facts.driverVersion)} 的主版本 ${major} 低于该能力要求的最低 ${facts.minDriverMajor}；nvidia-smi 可用但 RTX/CUDA 初始化可能直接失败`)
    }
    return probe("ready", smiOut || `驱动可用（${compactDriverVersion(facts.driverVersion)}）`)
  }

  // 从这里往下：「nvidia-smi 没能给出可用读数」成立（未安装 / 被关掉 / 通信失败）。
  // 剩下的依据只有**证据**：卡在不在（PCI/挂载）、驱动注册没有、设备节点可见没有、各来源读得到没有。

  // A2（铁律 3）：什么都读不到、又没有任何证据 ⇒ **读不到就不下结论**。
  // 必须排在 no-device 之前：三个来源都读不到时，"里面是空的"只说明"没读到"，不说明"没有卡"。
  if (!card && !driver && !nodes && unreadable.length > 0) {
    return probe("unknown", `读数不可得（${unreadable.join("、")} 读不到）：既不能说有 GPU，也不能说没有`,
      chain(cardLine, driverLine, deviceLine,
        "**读不到 ≠ 没有**：能判断“有没有卡”的来源都读不到——不许据此断言本机没有卡（也不许断言有卡）",
        "先把读数测清楚：在能读 /sys、/proc/driver 与 /dev 的会话里重跑；容器核对 `--gpus all`/设备透传，沙箱核对 /proc 是否被 mask"), true)
  }

  // A1（铁律 1）：驱动在、设备节点也看得见，唯独 nvidia-smi 给不出可用读数 ⇒ 缺的是**诊断工具**。
  // 这条曾经落进下面的 driver-broken（"先重启…重装与内核匹配的驱动"），而驱动是好的。
  // `smiAbsenceDetail` 再把"没装"与"装了跑不起来"分开——后者照"装包"走是死胡同（2026-09-26 二级验收实测）。
  if (driver && nodes && !facts.smi.present) {
    return probe("smi-missing",
      `驱动已注册（${compactDriverVersion(facts.driverVersion)}）且设备节点可见（${facts.deviceNodes.join("、")}），但${smiAbsenceDetail(facts)}——缺的是诊断工具，无法核实设备能不能真的打开`,
      chain(cardLine, driverLine, deviceLine,
        "**缺的是诊断工具（nvidia-smi），不是驱动坏了**：设备可见、驱动已注册，这条链上没有任何“打开设备失败”的证据",
        "**先确认工具在不在、能不能跑**（`command -v nvidia-smi` ＋ 直接跑一次），再按结论走：不在 PATH ⇒ 装工具包；在 PATH 却跑不起来 ⇒ 换 glibc 底座或从宿主挂一个能跑的进来——两种情况都**不要**据此重启、**不要**重装驱动"), true)
  }

  if (!card && !driver && !nodes) {
    return probe("no-device", "本机没有 NVIDIA 设备：PCI 无 0x10de、无 /proc/driver/nvidia/version、无 /dev/nvidia*",
      chain("本机没有 NVIDIA PCI 设备（本命名空间内）", "未注册（也没有可驱动的卡）", "无", "**本机确实没有 NVIDIA 卡**——不是看不见，是没有", "要用 GPU 就得加卡或用带 GPU 的机器；不加卡就按 CPU 物理 + 软件渲染跑（MuJoCo/Isaac 纯 CPU 都可用）"))
  }
  if (card && !driver) {
    const detected = facts.pciIds.join("、") || facts.pciDevices.join(", ") || facts.driverGpuEntries.join(", ")
    return probe("driver-missing",
      `检测到 NVIDIA 设备（${detected}），${driverReadable ? "但没有驱动注册（/proc/driver/nvidia/version 不存在）" : "但驱动状态读不到（/proc/driver 不可读）"}`,
      chain(cardLine, driverLine, deviceLine,
        driverReadable
          ? `**卡在，但驱动没加载**${nodes ? "（设备节点还在，驱动状态读不到）" : "——设备节点也因此不存在"}`
          : "**卡在，但读不到驱动状态**：可能是驱动没装，也可能只是 /proc 对本会话被遮蔽——两者处置不同，先复核",
        driverReadable
          ? "装/修 NVIDIA 驱动并**重启**（新内核模块要重新加载）；重启后 `nvidia-smi` 能列出 GPU 才算好"
          : "先复核：`cat /proc/driver/nvidia/version`、`nvidia-smi`；容器/沙箱里 /proc 常被 mask——**读数不可得时不要重装驱动**"),
      !driverReadable)
  }
  if (driver && !nodes) {
    // A3（铁律 2）：驱动在，却**没有任何"有卡"的证据**。这里曾经无条件走 device-hidden 并断言
    // "卡是好的"——而同一份解释链第 2 段刚写完"但没有认到任何 GPU"，自相矛盾且反向误导（叫用户"不要换卡"）。
    if (!card) {
      return probe("card-unknown",
        `驱动已注册（${compactDriverVersion(facts.driverVersion)}）但没有认到任何 GPU；PCI ${pciReadable ? "也没有 0x10de 设备" : "读数不可得"}，本会话也看不到设备节点：无法确认有卡`,
        chain(cardLine, driverLine, deviceLine,
          "**驱动在，但没有任何“有卡”的证据**（PCI 与驱动挂载都没读到 GPU）——既不能说卡是好的，也不能说没有卡（读不到 ≠ 没有）",
          "先查卡的有无：`lspci -nn | grep -i 10de`、BIOS/虚拟化直通、容器 `--gpus all`；**不要**据此重装驱动；确认卡确实不在时才按无卡处置"), true)
    }
    // 驱动已注册、设备节点不可见，但**有**卡证据（驱动挂载/PCI）。这是**容器/沙箱隐藏 /dev** 的
    // 典型形态——本机 2026-09-26 实测就是这一态：NVRM 595.91.07 已挂载 0000:02:00.0，PCI 上卡也在，
    // 只有 /dev/nvidia* 不在。此时断"驱动挂了"是误判，所以标记 uncertain 并走"device-hidden"话术。
    return probe("device-hidden",
      `驱动已注册（${compactDriverVersion(facts.driverVersion)}）${attached ? `且已挂载 ${facts.driverGpuEntries.join(", ")}` : ""}，但本会话看不到 /dev/nvidia*。${smiErr}`.trim(),
      chain(cardLine, driverLine, deviceLine,
        "**卡是好的、驱动是好的**——唯一的问题是**这个会话看不见设备**（不是没有卡，也不是驱动坏了）",
        "让**这个会话**能访问设备：容器加 `--gpus all`（或 `--device` 暴露 `/dev/nvidia*`）、改用非沙箱会话、检查设备透传/远程桌面；**不要**重装驱动、**不要**换卡"), true)
  }
  if (driver && nodes) {
    // 走到这里 `smi.present === true`（`false` 已被上面的 smi-missing 接走），所以是**真的通信失败**。
    return probe("driver-broken", `驱动已注册（${compactDriverVersion(facts.driverVersion)}）且设备节点可见，但 nvidia-smi 打不开设备：${smiErr}`,
      chain(cardLine, driverLine, deviceLine, "设备**看得见**但通信失败（不是可见性问题）", "`nvidia-smi` 看真实报错 + `dmesg | grep -i nvrm`；先重启，仍失败则重装与内核匹配的驱动"))
  }
  return probe("unknown",
    `读数自相矛盾（驱动=${driver} 卡=${card} 设备节点=${nodes}${unreadable.length > 0 ? `；读不到：${unreadable.join("、")}` : ""}），不猜测`,
    chain(cardLine, driverLine, deviceLine,
      "**读数自相矛盾**：有设备节点却没有驱动状态（或反过来）——先把读数测清楚，不猜",
      "复核：`nvidia-smi`、`cat /proc/driver/nvidia/version`、`ls -l /dev/nvidia*`、`lspci -nn | grep -i 10de`，并把输出贴进回执"))
}

/**
 * 驱动版本行压缩成一望可读的一段：`/proc/driver/nvidia/version` 的首行很长（含构建机与日期），
 * 整行塞进面板读数会把真正的版本号淹掉。证据行仍保留原始首行。
 */
export function compactDriverVersion(driverVersion: string | null): string {
  if (driverVersion === null) return "未知"
  const version = driverVersion.match(/NVRM version:.*?(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? driverVersion.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1]
  return version ? `NVRM ${version}` : driverVersion.slice(0, 80)
}

/** nvidia-smi 失败时的可读原因：它把失败信息写在 **stdout**（本机实测 exit 9 + stdout），不只 stderr。 */
export function smiFailureDetail(facts: GpuFacts): string {
  const first = (facts.smi.error || facts.smi.output || "").trim().split("\n")[0]?.trim() ?? ""
  if (first === "") return "nvidia-smi 退出非 0 且无输出"
  // 只带第一句：整段 nvidia-smi 提示会把面板读数淹掉；完整原文留在证据行里。
  const sentence = first.split(/(?<=\.)\s/)[0] ?? first
  return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence
}

/**
 * `nvidia-smi` **不在**（`smi.present === false`）时的可读原因——A1 的判据就在这里：
 * "没装工具"、"装了但跑不起来"与"驱动打不开设备"是三条完全不同的处置（装工具 / 换底座 / 修驱动），
 * 而旧读数把前两者混成同一句"nvidia-smi 未安装（PATH 里没有这个工具）"、又把它们与第三者混成
 * "nvidia-smi 打不开设备"，于是把人导向重装驱动或去装一个**已经装着**的工具。
 */
export function smiAbsenceDetail(facts: GpuFacts): string {
  if (facts.smi.reason === "not-probed") return "本会话没有探测 nvidia-smi（调用方关闭了该探测）"
  if (facts.smi.reason === "not-installed") return "nvidia-smi 未安装（PATH 里没有这个工具）"
  if (facts.smi.reason === "not-runnable") {
    const absence = facts.smi.absence
    const where = absence?.path ? `（${absence.path}）` : ""
    return `nvidia-smi **装着但跑不起来**${where}：${smiNotRunnableWhy(absence)}——**不是**没装（照"装包/修 PATH"走是死胡同）`
  }
  // 原因未记录（旧调用方/合成事实）：按 error 原样带出，**不编造**具体原因。
  const recorded = (facts.smi.error || facts.smi.output || "").trim().split("\n")[0]?.trim() ?? ""
  return recorded === "" ? "nvidia-smi 不可用（原因未记录）" : `nvidia-smi 不可用：${recorded}`
}

/**
 * "装着但跑不起来"的可读原因：解释器取到证时**指名道姓**（那是最常见的根因，也是唯一能被用户直接核对的一条）；
 * 悬空符号链接、非常规文件、没有可执行位各自单说；都取不到证时就只说"加载被内核拒绝"
 * —— 每一句都对应 `SmiAbsenceEvidence` 里的一个真实读数字段，**不编造**缺哪个库。
 */
function smiNotRunnableWhy(absence: SmiAbsenceEvidence | undefined): string {
  const interpreter = absence?.interpreter ?? null
  if (interpreter !== null && absence?.interpreterPresent === false) {
    return `缺 loader/glibc：它需要的解释器 \`${interpreter}\` 在盘上不存在`
  }
  if (absence?.danglingSymlink) return "PATH 上那一条是**悬空符号链接**（目标文件不存在）"
  if (absence && !absence.regularFile) return "PATH 上那一条**不是常规文件**（目录/设备/管道之类）"
  if (absence && (!absence.readable || !absence.executable)) {
    return `文件在，但**${absence.readable ? "没有可执行位" : "读不到"}**`
  }
  return "文件在、可读、有可执行位，但**内核拒绝加载**（缺 loader/glibc 之类）"
}

interface GpuStateWording {
  impact: string
  degradation: EnvironmentDegradation | null
  remedy: EnvironmentRemedy
  contractTest: string
  /** 这一态的判定不确定时要说的话（`device-hidden`／`smi-missing`／`card-unknown` 三态用）。 */
  uncertaintyNote?: string
}

const GPU_TEST = `${ENVIRONMENT_CONTRACT_TEST} › GPU 分型：${"{state}"}`

/**
 * 每种 GPU 状态的**不同话术**（N2 的正文）。改这里之前先想清楚：客户按这段话去修机器。
 * `device-hidden` 与 `no-device` 必须能被用户区分开——前者是可见性问题，后者才要买卡。
 */
export const GPU_STATE_WORDING: Record<GpuState, GpuStateWording> = {
  ready: {
    impact: "无：Isaac RTX 渲染/相机族（RGB-D、首帧）、CUDA 物理、大场景预览都能走硬件路径。",
    degradation: null,
    remedy: { summary: "无需处置；驱动升级后重跑一次对表即可。", steps: ["驱动升级或换卡后：`bun run script/doctor-env.ts` 复核", "客户端面板会在下次读取时刷新（宿主读数有 TTL 缓存）"] },
    contractTest: GPU_TEST.replace("{state}", "ready"),
  },
  "no-device": {
    impact: "Isaac 的 RTX 渲染/相机族、CUDA 物理与算力类功能不可用；MuJoCo、Newton（自动退 cpu）、Isaac 6.0.1.0 纯 CPU 物理**不受影响**。",
    degradation: { path: "回退 MuJoCo/Isaac CPU 物理与软件渲染（engine-preference.ts 的默认回退路径）", active: true, restore: "接入 NVIDIA GPU 并装好驱动后重启 Host；Isaac 条件具备且仍为自动时才会再次优先 isaac（手动偏好不被改动）" },
    remedy: {
      summary: "本机确实没有 NVIDIA 卡：要用 RTX/CUDA 就得加卡或用带 GPU 的机器；不加卡就把渲染类需求改走软件渲染。",
      steps: ["先确认不是可见性问题：`lspci -nn | grep -i 10de`、`ls /dev/nvidia*`", "无卡时不要选 `rendering:rtx`/`physicsDevice:cuda:0`，选 `mujoco` 或 Isaac 纯 CPU", "需要像素证据时用软件渲染：`LIBGL_ALWAYS_SOFTWARE=1`（慢，但能出图）"],
    },
    contractTest: GPU_TEST.replace("{state}", "no-device"),
  },
  "driver-missing": {
    impact: "卡在但驱动没装，GPU 完全用不了；Isaac 的 RTX/CUDA 绑定能力不可用，CPU 路径仍可用。",
    degradation: { path: "回退 CPU 物理与软件渲染，直到驱动装好", active: true, restore: "装好驱动并**重启**后自动恢复（新内核模块必须重新加载）" },
    remedy: {
      summary: "装 NVIDIA 驱动：卡已经在，缺的只是驱动。",
      steps: ["确认卡在：`lspci -nn | grep -i 10de`", "发行版方式：`sudo ubuntu-drivers autoinstall`（或 `apt install nvidia-driver-<版本>`）；官方 `.run` 亦可", "**装完必须重启**——升级/新装驱动后不重启是最常见的“装好了还是不能用”", "重启后 `nvidia-smi` 能列出 GPU 才算装好"],
      permission: "root/sudo（安装内核模块）",
      docUrl: "https://docs.nvidia.com/datacenter/tesla/driver-installation-guide/",
    },
    contractTest: GPU_TEST.replace("{state}", "driver-missing"),
  },
  "driver-broken": {
    impact: "GPU 不可用。常见于驱动升级后未重启、内核模块未加载、或设备节点权限不足；Isaac RTX/CUDA 能力不可用，CPU 路径仍可用。",
    degradation: { path: "回退 CPU 物理与软件渲染，直到驱动恢复", active: true, restore: "驱动恢复后自动回到硬件路径" },
    remedy: {
      summary: "驱动已注册但设备打不开：先重启，再按内核侧报错修驱动。",
      steps: ["看真实报错：`nvidia-smi`，以及 `dmesg | grep -i nvrm`", "先重启一次（驱动升级后模块未重载是最常见原因）", "仍失败：重装与内核匹配的驱动并核对 `uname -r` 与 `dkms status`", "容器/虚拟机需装与宿主一致的驱动或 vGPU 驱动；权限问题看 `/dev/nvidia*` 的属主与 660 root:video"],
      permission: "root/sudo",
    },
    contractTest: GPU_TEST.replace("{state}", "driver-broken"),
  },
  "device-hidden": {
    impact: "**只有当前会话/容器看不到 GPU**，宿主可能是完全正常的。按“客户机没有 GPU”处置会误判，也会把能修的可见性问题报成硬件故障。",
    degradation: { path: "本次会话按无 GPU 运行（CPU 物理 + 软件渲染），功能不静默丢失但性能与像素证据受限", active: true, restore: "在能访问 GPU 的会话里重启 Host；容器用 `--gpus all`（或 `--device` 逐个暴露）" },
    uncertaintyNote: "**可能是沙箱/容器误报**：驱动已注册且已挂载 GPU、PCI 上也有卡，只有本会话看不到 /dev——不得据此断言客户机坏了，须在无沙箱会话复核",
    remedy: {
      summary: "这是**可见性**问题，不是驱动坏了：把 /dev/nvidia* 暴露给本会话，然后在无沙箱会话复核。",
      steps: [
        "读证据：驱动已注册且已挂载 GPU、PCI 上有卡，只有 /dev 里没有 —— 容器/沙箱隐藏 /dev 的典型形态",
        "容器：`docker run --gpus all`，或显式 `--device /dev/nvidia0 --device /dev/nvidiactl --device /dev/nvidia-uvm --device /dev/nvidia-caps`",
        "沙箱会话：改用不带沙箱的会话重跑 `bun run script/doctor-env.ts` 复核",
        "**不要**据此断言客户机 GPU 损坏；本条读数带 `uncertain`，回执里必须原样带出这句",
      ],
      permission: "容器/沙箱启动参数 + `/dev` 访问权",
    },
    contractTest: GPU_TEST.replace("{state}", "device-hidden"),
  },
  "vram-insufficient": {
    impact: "卡与驱动都好，但可用显存不够：大场景、RTX 首帧、3DGS 预览会 OOM 或掉到软件渲染。",
    degradation: { path: "缩小场景/分辨率/高斯数量，或改用 CPU 物理", active: false, restore: "释放显存后自动恢复" },
    remedy: {
      summary: "显存被占满或本来就小：先看谁占着，再考虑降规模或换卡。",
      steps: ["`nvidia-smi --query-compute-apps=pid,used_memory --format=csv` 看占用进程", "结束占卡进程，或换一张空闲卡：`CUDA_VISIBLE_DEVICES=<n>`", "降场景规模/分辨率/高斯数量后重试"],
    },
    contractTest: GPU_TEST.replace("{state}", "vram-insufficient"),
  },
  "driver-outdated": {
    impact: "有卡有驱动但版本低于该能力声明的最低要求：RTX/CUDA 初始化可能直接失败，而不是变慢。",
    degradation: { path: "回退 CPU 物理与软件渲染，直到驱动升级", active: true, restore: "升级驱动并重启后自动恢复" },
    remedy: {
      summary: "升级 NVIDIA 驱动到能力声明的最低版本以上。",
      steps: ["当前版本见 `/proc/driver/nvidia/version`", "按发行版升级驱动（或官方 `.run`）", "**升级后重启**；再用 `nvidia-smi` 确认版本已变"],
      permission: "root/sudo",
    },
    contractTest: GPU_TEST.replace("{state}", "driver-outdated"),
  },
  unknown: {
    impact: "**未知不等于可用**：这行读不到，依赖它的能力必须先确认，不得默认按可用处理（也不许留空）。",
    degradation: null,
    remedy: {
      summary: "手工把读数测清楚，再把输出贴进回执的“差异”一节。",
      steps: ["`nvidia-smi -q` 或 `cat /proc/driver/nvidia/version`", "确认是否在沙箱/容器里：`ls /dev/nvidia*`、`ls /proc/driver/nvidia/gpus`", "把输出贴进 bugfixHistory 回执；不要用推测填空"],
    },
    contractTest: GPU_TEST.replace("{state}", "unknown"),
  },
  // A1（2026-09-26 验收真容器实测）：设备与驱动都好，只是 nvidia-smi 给不出可用读数。
  // 这一态的**全部意义**是不让用户去重装驱动——所以处置第一条就是"确认工具在不在、能不能跑"，最后一条是"不要动驱动"。
  // ⚠️ 这一段的 `remedy` 只是**原因未记录时**的兜底（旧调用方/合成事实）；真实探测路径走
  // `smiMissingRemedy()`，按 `not-installed` / `not-runnable` 分成两套**不同**的下一步
  // （2026-09-26 二级验收：在 A1 自己的证据容器里，工具装着且在 PATH 里，"装包/修 PATH"两条都是死胡同）。
  "smi-missing": {
    impact: "**无法核实 GPU 能不能真的用**：设备节点与驱动这条链上没有任何失败证据，缺的是 `nvidia-smi` 这个诊断工具（没装／装了跑不起来／本次没探测）。需要 GPU 的能力在核实前**不放行**（也不判成驱动损坏）；CPU 路径完全不受影响。",
    degradation: null,
    uncertaintyNote: "**缺的是诊断工具，不是驱动**：设备节点可见、驱动已注册，只是没有一个能用的 `nvidia-smi` 可核实——不得据此重装驱动、也不要重启",
    remedy: {
      summary: "**先确认 `nvidia-smi` 在不在、能不能跑**（本次没记录到原因），再按结论处置：设备与驱动**可能完全正常**。",
      steps: [
        "先确认工具在不在、能不能跑：`command -v nvidia-smi`（空 = 不在 PATH）＋直接跑一次 `nvidia-smi`（`not found` = **在 PATH 里但跑不起来**，缺 loader/glibc；报驱动错 = 通信失败，那是另一态）",
        "不在 PATH ⇒ 装工具包 `apt install nvidia-utils-<驱动主版本>`；在 PATH 却跑不起来 ⇒ **别装包**（已经装了、PATH 里也有），改用 glibc 底座镜像，或从宿主挂一个能跑的 `nvidia-smi` 进来",
        "**不要**因为本行去重启或重装驱动：这里没有任何“驱动打开设备失败”的证据",
      ],
      permission: "root/sudo（装工具包，或换底座/挂载）",
    },
    contractTest: GPU_TEST.replace("{state}", "smi-missing"),
  },
  // A3（同一次验收的合成复现）：驱动模块在、卡不在。旧判据在这里说"卡是好的"——自相矛盾。
  "card-unknown": {
    impact: "**未知不等于可用**：驱动已注册，但读不到任何“有卡”的证据（PCI 无 0x10de、驱动也没挂载 GPU）。需要 GPU 的能力先明确拒绝；CPU 路径不受影响。",
    degradation: null,
    uncertaintyNote: "**既不能说卡是好的，也不能说没有卡**：可能是卡确实不在，也可能是卡对本会话不可见（PCI 被遮蔽/未透传）——不得据此重装驱动，也不要直接换卡",
    remedy: {
      summary: "先查卡的有无（PCI／直通／容器），查清之前别动驱动。",
      steps: [
        "查卡：`lspci -nn | grep -i 10de`（无输出 = 本命名空间里没有 NVIDIA PCI 设备）",
        "查驱动认到了什么：`ls /proc/driver/nvidia/gpus`（空 = 驱动没认到任何 GPU）",
        "容器/虚拟机：卡可能只是没透传（`--gpus all`／PCI 直通／BIOS 里 dGPU 被禁用）——先在能看见卡的会话里复核",
        "**不要**先重装驱动：驱动已注册；只有确认卡确实不在时才按“无卡”处置",
      ],
    },
    contractTest: GPU_TEST.replace("{state}", "card-unknown"),
  },
}

/**
 * A1 的处置——**按取证到的原因分支**（`not-installed` 与 `not-runnable` 的下一步是两件事）：
 *
 * ```
 * ① PATH 里没有这个文件      ⇒ 装工具包 / 把宿主那份挂进来
 * ② 文件在、可读、有可执行位，
 *    但内核加载不了（ENOENT）⇒ **别装包**（已经装了、PATH 里也有）：换 glibc 底座，或从宿主挂一个能跑的进来
 * ```
 *
 * 为什么必须分支：2026-09-26 二级验收在 A1 **自己用作证据的那个容器**里实测——
 * `--gpus all` + `oven/bun:1.3.13-alpine` 里 `nvidia-smi` 在 `/usr/bin`、在 PATH 里、可读可执行，
 * 只是缺 `/lib64/ld-linux-x86-64.so.2`（musl 底座）而加载不了。旧话术对那台机器说"未安装（PATH 里没有
 * 这个工具）"并让用户"装上/让 PATH 能找到它"——**两条都是死胡同**。原因未记录时回落到兜底话术（不猜）。
 */
export function smiMissingRemedy(facts: GpuFacts): EnvironmentRemedy {
  const absence = facts.smi.absence
  const where = absence?.path ? `（${absence.path}）` : ""
  // 三态共用第一条：**先取证**。工具在不在、能不能跑，这一步就能分开"没装"与"装了跑不起来"。
  const confirm = "先确认工具在不在、能不能跑：`command -v nvidia-smi`（空 = 不在 PATH）＋直接跑一次 `nvidia-smi`（`not found` = **在 PATH 里但跑不起来**；报驱动错 = 通信失败，那是另一态）"
  const neverTouchDriver = "**不要**因为本行去重启或重装驱动：这里没有任何“驱动打开设备失败”的证据"
  if (facts.smi.reason === "not-runnable") {
    const why = smiNotRunnableWhy(absence)
    return {
      summary: "`nvidia-smi` **已经装着但跑不起来**（不是没装）：换 glibc 底座或从宿主挂一个能跑的进来——装包与修 PATH 都无效，设备与驱动**可能完全正常**。",
      steps: [
        confirm,
        `取证：PATH 上确实有这一个文件${where}（可读=${absence?.readable === true}、可执行=${absence?.executable === true}、常规文件=${absence?.regularFile === true}），但启动被内核拒绝——${why}`,
        "对「装着跑不起来」有效的只有两条：① 换 glibc 底座镜像（debian/ubuntu 系）；② 从宿主挂一个与底座匹配的 `nvidia-smi` 进来（挂载不改镜像里的任何东西）",
        neverTouchDriver,
      ],
      permission: "root/sudo（换镜像或挂载）",
    }
  }
  if (facts.smi.reason === "not-installed") {
    return {
      summary: "PATH 里确实没有 `nvidia-smi`：装上（或让 PATH 能找到它）后复核——设备与驱动**可能完全正常**。",
      steps: [
        confirm,
        "确实不在 PATH：装工具包 `apt install nvidia-utils-<驱动主版本>`（发行版的 `nvidia-driver-*` 一般不附带 `nvidia-smi`）",
        "精简镜像/容器：`nvidia-smi` 常被裁掉，从宿主挂进来或单独装即可——设备与驱动不受影响",
        neverTouchDriver,
      ],
      permission: "root/sudo（装工具包）",
    }
  }
  // 原因未记录（旧调用方/合成事实）：不许猜是"没装"，回落到兜底那一套（先取证，再按结论走）。
  return GPU_STATE_WORDING["smi-missing"].remedy
}

/** 把 GPU 读数变成面板行（`classifyGpu` + 分型话术）。 */
export function gpuRow(facts: GpuFacts): EnvironmentRow {
  const classification = classifyGpu(facts)
  const wording = GPU_STATE_WORDING[classification.state]
  return {
    id: "gpu", kind: "gpu", label: "GPU/驱动", status: gpuStatus(classification.state), state: classification.state,
    reading: classification.reading, impact: wording.impact, uncertain: classification.uncertain,
    uncertaintyNote: classification.uncertain ? (wording.uncertaintyNote ?? null) : null,
    // 解释链在前、原始读数在后：界面顺着读就是"卡 → 驱动 → 设备 → 结论 → 处置"。
    evidence: [...classification.explanation, ...classification.evidence], degradation: wording.degradation,
    // A1 的处置按**取证到的原因**分支（装包 vs 换底座），所以它不走静态表。
    remedy: classification.state === "smi-missing" ? smiMissingRemedy(facts) : wording.remedy,
    scope: "overall", contractTest: wording.contractTest,
  }
}

/** 分型 → 面板状态：未知就是未知，不并进"降级"里糊弄过去；"设备被会话隐藏"是降级（能修），不是"缺卡"。 */
export function gpuStatus(state: GpuState): EnvironmentStatus {
  if (state === "ready") return "ready"
  // "读不到"、"缺诊断工具"、"卡的有无未能确认"三者都**不是**"这台机器坏了"：报 unknown，
  // 界面必须显示"怎么把它测清楚"，而不是把它塞进 broken/missing 让人去修硬件（A1/A3 的教训）。
  if (state === "unknown" || state === "smi-missing" || state === "card-unknown") return "unknown"
  if (state === "driver-broken") return "broken"
  if (state === "device-hidden" || state === "vram-insufficient" || state === "driver-outdated") return "degraded"
  return "missing"
}

// ─────────────────── 运行时消费：GPU 决策（引擎选择/仿真装配/RTX 功能都问这一份） ───────────────────

/** 加速器可用性的**运行时结论**（刻意与"有没有卡"分开：`session-hidden` ≠ `absent`）。 */
export type GpuAccelerator =
  | "available"        // 硬件路径可用
  | "session-hidden"   // 卡和驱动都好，**本会话看不见设备**（容器/沙箱/远程会话/未透传）
  | "absent"           // 本机确实没有 NVIDIA 卡
  | "driver-missing"   // 有卡但驱动没加载
  | "broken"           // 设备可见但通信失败（驱动异常/权限/升级后未重载）
  | "unknown"          // 读不到，不猜

/**
 * **运行时决策**：引擎选择、仿真装配、需要 RTX 的功能在动手前问这一份，而不是各自去试 `nvidia-smi`。
 *
 * 三条硬约束（W21）：
 *  1. `device-hidden` 绝不许被报成"没有 GPU"或"GPU 不可用"：`accelerator` 是 `session-hidden`，
 *     解释链会先说明"卡是好的、驱动是好的"，处置只谈**让这个会话看见设备**；
 *  2. 走 CPU 路径时必须能说清"在走什么、为什么、怎么改回"（`cpuFallback`），范式同 engine-preference；
 *  3. 需要 GPU 的能力**明确拒绝**：给稳定码 + 处置，不静默失败、不留空白（`gpuRequired`）。
 */
export interface GpuRuntimeDecision {
  state: GpuState
  accelerator: GpuAccelerator
  /** 一句话结论（界面直接显示）。 */
  headline: string
  /** 解释链：卡 → 驱动 → 设备 → 结论 → 处置。 */
  explanation: readonly string[]
  /** 走 CPU 替代路径的说明；`allowed` 恒为 true（CPU 路径始终可用），但必须把理由与改回方式讲出来。 */
  cpuFallback: { allowed: boolean; reason: string; restore: string }
  /** 需要 GPU 的能力：是否必须拒绝 + 稳定码 + 处置 + 四句话。 */
  gpuRequired: { blocked: boolean; code: string | null; remedy: EnvironmentRemedy; wording: string[] }
  /** 稳定指纹：同一份事实永远同一个值（判定不许自己在抖）。 */
  fingerprint: string
}

const ACCELERATOR_OF: Record<GpuState, GpuAccelerator> = {
  ready: "available", "no-device": "absent", "driver-missing": "driver-missing",
  "device-hidden": "session-hidden", "driver-broken": "broken",
  "vram-insufficient": "available", "driver-outdated": "available", unknown: "unknown",
  // 缺诊断工具 / 卡的有无未能确认：**都不能**说成 absent（那是在断言没有卡），也不许说 available。
  "smi-missing": "unknown", "card-unknown": "unknown",
}

const CPU_REASON: Record<GpuState, string> = {
  ready: "GPU 可用，不需要走 CPU 替代路径",
  "no-device": "本机没有 NVIDIA 卡：物理与渲染都走 CPU（MuJoCo / Isaac 纯 CPU / 软件渲染）",
  "driver-missing": "卡在但驱动没加载：先走 CPU，装好驱动并重启后自动改回硬件路径",
  "device-hidden": "**卡是好的、驱动也是好的**，只是**这个会话看不见设备**：本会话按 CPU 物理 + 软件渲染跑，能力不静默丢失",
  "driver-broken": "驱动打不开设备：先走 CPU，修好驱动后自动改回",
  "vram-insufficient": "显存不够：缩小场景/分辨率后重试，或继续用 CPU 物理",
  "driver-outdated": "驱动低于该能力要求：先走 CPU，升级驱动后自动改回",
  unknown: "GPU 读数未知：**未知不等于可用**，需要 GPU 的能力先拒绝；CPU 路径照常可用",
  "smi-missing": "缺 `nvidia-smi`，**无法核实**设备能不能真的打开（缺的是诊断工具，不是驱动）：需要 GPU 的能力先拒绝；CPU 路径照常可用",
  "card-unknown": "驱动在但没有任何“有卡”的证据（**既不能说卡好，也不能说没卡**）：需要 GPU 的能力先拒绝；CPU 路径照常可用",
}

/** `device-hidden` 的处置与"没有卡/驱动坏了"必须分开——这是 W21 的核心区分。 */
export function gpuRuntimeDecision(facts: GpuFacts): GpuRuntimeDecision {
  const classification = classifyGpu(facts)
  const status = gpuStatus(classification.state)
  const wordingData = GPU_STATE_WORDING[classification.state]
  const row = gpuRow(facts)
  const accelerator = ACCELERATOR_OF[classification.state]
  const blocked = classification.state !== "ready"
  return {
    state: classification.state,
    accelerator,
    headline: gpuHeadline(classification),
    explanation: classification.explanation,
    cpuFallback: {
      allowed: true,
      reason: CPU_REASON[classification.state],
      restore: wordingData.degradation?.restore ?? row.remedy.summary,
    },
    gpuRequired: {
      blocked,
      code: blocked ? environmentCode("gpu", classification.state, status) : null,
      remedy: row.remedy,
      wording: environmentRowWording(row),
    },
    fingerprint: stableFingerprint(JSON.stringify([
      classification.state, classification.reading, status,
      facts.pciIds ?? [], facts.driverVersion, facts.driverGpuEntries, facts.driverGpuModels ?? [],
      facts.deviceNodes, facts.deviceExtras ?? [], facts.capacity?.freeMiB ?? null,
    ])),
  }
}

/** 从解释链里取第 n 段的正文（去掉 "1. 卡：" 这类前缀）。 */
function chainBody(classification: GpuClassification, index: number): string {
  return classification.explanation[index]?.replace(/^\d+\.\s*[^：]*：/, "") ?? ""
}

const cardLineOf = (classification: GpuClassification): string => chainBody(classification, 0)

/** 一句话结论：`device-hidden` 说的是"有卡有驱动、会话看不见"，不是"没有 GPU"。 */
export function gpuHeadline(classification: GpuClassification): string {
  const deviceLine = chainBody(classification, 2)
  switch (classification.state) {
    case "ready": return `GPU 可用：${classification.reading}`
    case "device-hidden": return `有卡、有驱动，但**这个会话看不见设备**（不是没有 GPU、也不是驱动坏了）：${deviceLine.replace(/^设备：/, "")}`
    case "no-device": return "本机没有 NVIDIA 卡（PCI 无 0x10de）——不是看不见，是没有"
    case "driver-missing": return `有卡但驱动没加载：${cardLineOf(classification)}`
    case "driver-broken": return `设备可见但驱动通信失败（不是可见性问题）：${classification.reading.slice(0, 120)}`
    case "vram-insufficient": return `卡可用但显存不足：${classification.reading.slice(0, 120)}`
    case "driver-outdated": return `驱动版本低于要求：${classification.reading.slice(0, 120)}`
    // A1/A3：这两句话**都不许**出现"驱动坏了/没有卡"——它们说的是"没能核实"，不是"坏了"。
    case "smi-missing": return `驱动与设备节点都在，但**缺诊断工具**（nvidia-smi 不可用）——不能据此说驱动坏了`
    case "card-unknown": return `驱动已注册，却读不到任何“有卡”的证据（PCI 与驱动挂载都没认到 GPU）——既不能说卡是好的，也不能说没有卡`
    default: return `GPU 读数未知：${classification.reading}`
  }
}

/**
 * **给"需要 GPU 的能力"在抛错点用的一句话包**（W21 的运行时消费入口）。
 *
 * 用途：引擎/仿真装配在发现"拿不到 GPU"时不要自己造句，也不要只喊一句"GPU 不可用"——
 * 调这个函数，把**稳定码 + 完整解释链 + 处置 + 四句话**原样带出去。设备不可见与真的没有卡
 * 得到的 `code`/`message`/`remedy` 完全不同。
 *
 * 消费点（各自属主自取一行）：
 * ```ts
 * const refusal = gpuRefusal("Isaac RTX 渲染", gpuFacts)      // gpuFacts 来自 probeGpuFacts() 或宿主读数缓存
 * if (refusal) throw new Error(`${refusal.code}: ${refusal.message}`)
 * ```
 * 就绪时返回 `null`（没有什么要拒绝的）。
 */
export function gpuRefusal(feature: string, facts: GpuFacts): {
  code: string
  message: string
  remedy: EnvironmentRemedy
  wording: string[]
  decision: GpuRuntimeDecision
} | null {
  const decision = gpuRuntimeDecision(facts)
  if (!decision.gpuRequired.blocked || decision.gpuRequired.code === null) return null
  const code = decision.gpuRequired.code
  const message = `[${feature}] ${decision.headline}｜${decision.explanation.join("；")}｜处置：${decision.gpuRequired.remedy.summary}`
  return { code, message, remedy: decision.gpuRequired.remedy, wording: decision.gpuRequired.wording, decision }
}

/** 稳定指纹（FNV-1a 64 位）：同一份事实永远同一个值——判定"自己抖没抖"一眼可见。 */
export function stableFingerprint(text: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, "0")
}

// ───────────────────────────── 宿主探测（只读、本地、不出网） ─────────────────────────────

export interface GpuProbeOptions {
  devDir?: string
  procDriverDir?: string
  sysBusPciDir?: string
  requiredVramMiB?: number | null
  minDriverMajor?: number | null
  /** 关掉 nvidia-smi 子进程（无该工具的环境/测试）；关掉后 `smi.present = false`。 */
  smi?: boolean
  /**
   * subprocess 探测的实现（默认 `probeSmi`）。**注入缝的存在理由不是"好测"**，而是：
   * `nvidia-smi` 会在 `/dev` 里**留下条目**（本机 2026-09-26 实测：跑一次就凭空多出
   * `/dev/nvidia-caps`，即使它以 exit 9 失败 —— 见 `probeGpuFacts` 里那段顺序说明）。
   * "探测有没有把自己的读数改掉"这件事必须能**离线、换一台机器也复现**，
   * 所以测试要能塞一个"会在 `devDir` 里留下条目"的替身进去。真跑时永远走默认实现。
   */
  smiProbe?: () => GpuFacts["smi"]
  /**
   * `nvidia-smi` 可执行文件（默认按名字走 PATH）。**只给测试/诊断用**：A1 的现场形态就是
   * "PATH 里没有这个工具"，那条路径必须能**离线复核**（不改全局 `process.env.PATH`）。
   */
  smiPath?: string
}

/**
 * PATH 上一个可执行名的**候选**（目录项存在即算，含悬空符号链接——`command -v` 也会把它打出来）。
 * 显式带 `/` 的名字只查它自己（与 `execvp` 的规矩一致：带斜杠就不走 PATH）。
 *
 * ⚠️ 取证读的是 **`process.env.PATH` 的当前值**：如果调用方在运行期改过 PATH，Bun 的裸名 spawn
 * 仍按**进程启动时**的 PATH 解析（本机 2026-09-26 实测：改完后 `execFileSync("nvidia-smi")` 跑的还是
 * 启动时那个），两边可能不一致。产品路径不改 PATH，所以不冲突；这条只是取证的边界，如实登记。
 */
function smiExecutableCandidates(executable: string): string[] {
  const isEntry = (candidate: string): boolean => {
    try { return lstatSync(candidate, { throwIfNoEntry: false }) !== undefined } catch { return false }
  }
  if (executable.includes("/")) return isEntry(executable) ? [executable] : []
  const found: string[] = []
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir === "") continue
    const candidate = join(dir, executable)
    if (!isEntry(candidate)) continue
    found.push(candidate)
    if (found.length >= SMI_PATH_SCAN_LIMIT) break
  }
  return found
}

/** `probeSmi` 遇到 ENOENT 时最多扫几条 PATH 候选（够诊断，不至于把面板撑爆）。 */
const SMI_PATH_SCAN_LIMIT = 8
/** 解释器证据的读取上限：ELF program header 与 shebang 都在文件头部，不必把整个二进制读进来。 */
const SMI_HEAD_BYTES = 64 * 1024

/** 只读文件头 `cap` 字节；读不到返回 `null`（**不抛**——取证失败不该把环境探测打成异常）。 */
function readHeadBytes(path: string, cap = SMI_HEAD_BYTES): Buffer | null {
  let fd: number | null = null
  try {
    fd = openSync(path, "r")
    const buffer = Buffer.allocUnsafe(cap)
    const read = readSync(fd, buffer, 0, cap, 0)
    return buffer.subarray(0, read)
  } catch { return null } finally { if (fd !== null) { try { closeSync(fd) } catch { /* 关不上不影响判定 */ } } }
}

/** 内核加载这个文件要用的解释器：ELF 的 `PT_INTERP`，或脚本 shebang 的第一个词；读不出返回 `null`。 */
function readLoaderInterpreter(path: string): string | null {
  const head = readHeadBytes(path)
  if (head === null || head.length < 4) return null
  // 脚本：`#!` 后到行尾的第一个词。
  if (head[0] === 0x23 && head[1] === 0x21) {
    const line = head.subarray(0, Math.min(head.length, 256)).toString("utf8").split("\n")[0] ?? ""
    const token = line.slice(2).trim().split(/\s+/)[0] ?? ""
    return token === "" ? null : token
  }
  // ELF：读 program headers 找 PT_INTERP(3)。
  if (!(head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46)) return null
  if (head.length < 0x40) return null
  const elfClass = head[4]
  const little = head[5] === 1
  if (!little && head[5] !== 2) return null
  const u16 = (offset: number): number => (little ? head.readUInt16LE(offset) : head.readUInt16BE(offset))
  const u32 = (offset: number): number => (little ? head.readUInt32LE(offset) : head.readUInt32BE(offset))
  const u64 = (offset: number): number => Number(little ? head.readBigUInt64LE(offset) : head.readBigUInt64BE(offset))
  if (elfClass !== 1 && elfClass !== 2) return null
  const wide = elfClass === 2
  const phoff = wide ? u64(0x20) : u32(0x1c)
  const phentsize = wide ? u16(0x36) : u16(0x2a)
  const phnum = wide ? u16(0x38) : u16(0x2c)
  for (let index = 0; index < phnum; index++) {
    const base = phoff + index * phentsize
    if (phentsize <= 0 || base + phentsize > head.length) return null
    if (u32(base) !== 3) continue // PT_INTERP
    const offset = wide ? u64(base + 8) : u32(base + 4)
    const size = wide ? u64(base + 32) : u32(base + 16)
    if (size <= 0 || offset + size > head.length) return null
    const value = head.subarray(offset, offset + size).toString("utf8").replace(/\0+$/, "")
    return value === "" ? null : value
  }
  return null
}

/**
 * `ENOENT` 之后的**取证**：`ENOENT` 只说明"执行不了"，不说明"没安装"——所以判定前先去盘上看。
 * 三条事实各自独立取：① PATH 上有没有候选；② 候选是不是"在盘上、可读、有可执行位"；
 * ③ 内核要的解释器在不在盘上（`PT_INTERP`/shebang）。任何一条取不到证都**如实留空**，不补默认值。
 */
export function probeSmiAbsenceEvidence(executable = "nvidia-smi"): SmiAbsenceEvidence {
  const candidates = smiExecutableCandidates(executable)
  const path = candidates[0] ?? null
  if (path === null) {
    return { candidates, path: null, danglingSymlink: false, regularFile: false, readable: false, executable: false, interpreter: null, interpreterPresent: null }
  }
  let followed: { isFile(): boolean } | undefined
  try { followed = statSync(path, { throwIfNoEntry: false }) ?? undefined } catch { followed = undefined }
  const canAccess = (mode: number): boolean => { try { accessSync(path, mode); return true } catch { return false } }
  const interpreter = readLoaderInterpreter(path)
  const interpreterPresent = interpreter === null
    ? null
    : interpreter.includes("/") ? existsSync(interpreter) : smiExecutableCandidates(interpreter).length > 0
  return {
    candidates, path,
    danglingSymlink: followed === undefined,
    regularFile: followed?.isFile() ?? false,
    readable: canAccess(constants.R_OK),
    executable: canAccess(constants.X_OK),
    interpreter, interpreterPresent,
  }
}

/** nvidia-smi 只查名字与显存：**不查 UUID/serial**（面板读数会下发到浏览器，不搬没必要的信息）。 */
function probeSmi(executable = "nvidia-smi"): GpuFacts["smi"] {
  const query = ["--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"]
  try {
    const out = execFileSync(executable, query, { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "pipe"] }).trim()
    return { present: true, ok: true, output: out, error: "" }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: string }
    // A1：**工具不在**、**工具装着但跑不起来**、**工具在但打不开设备**是三条完全不同的处置
    // （装工具 / 换底座 / 修驱动），别让读数把它们混成同一句"打不开设备"。
    //
    // ⚠️ `ENOENT` 一个人只能证明"执行不了"：装载器（ELF 解释器/shebang）缺失时 `execve` 同样返回 ENOENT，
    // 与"PATH 里没有这个文件"**同一个错误码**。所以先取证（PATH 扫描 + accessSync + 解释器）再定性。
    // 反例（2026-09-26 二级验收，真容器）：`--gpus all` + musl 底座里 `nvidia-smi` 在 PATH 里、
    // 可读可执行，只因缺 `/lib64/ld-linux-x86-64.so.2` 而 ENOENT —— 记成"未安装"是把用户骗去装一个
    // 已经装着的工具。
    if (failure.code === "ENOENT") {
      const absence = probeSmiAbsenceEvidence(executable)
      if (absence.path === null) {
        return { present: false, ok: false, output: "", error: `${executable} 未安装（PATH 里没有这个文件）`, reason: "not-installed", absence }
      }
      return {
        present: false, ok: false, output: "",
        error: `${executable} 在 ${absence.path}，但跑不起来：${smiNotRunnableWhy(absence)}`,
        reason: "not-runnable", absence,
      }
    }
    // 本机实测：设备不可达时 nvidia-smi 把失败原因写在 **stdout** 并以 exit 9 结束，stderr 为空。
    return { present: true, ok: false, output: `${failure.stdout ?? ""}`.trim(), error: `${failure.stderr ?? ""}`.trim() }
  }
}

/** 从 nvidia-smi 的 `name, total, used` 行里取显存；解析不出就返回 null（不猜）。 */
export function parseSmiCapacity(output: string): GpuFacts["capacity"] {
  for (const line of output.split("\n")) {
    const cells = line.split(",").map(cell => cell.trim())
    if (cells.length < 3) continue
    const totalMiB = Number(cells[cells.length - 2])
    const usedMiB = Number(cells[cells.length - 1])
    if (Number.isFinite(totalMiB) && Number.isFinite(usedMiB) && totalMiB > 0) {
      return { totalMiB, freeMiB: Math.max(0, totalMiB - usedMiB) }
    }
  }
  return null
}

/** `scanGpuDevices()` 的读数形状（装配点与契约共用的那一份边界）。 */
export interface GpuDeviceScan {
  /** 字符设备。**只有它算"设备可见"**（能打开的才算设备——契约的判据）。 */
  deviceNodes: string[]
  /** 其它 `nvidia*` 条目（`nvidia-caps` 目录等）。只作证据，不当设备。 */
  deviceExtras: string[]
  /** 要暴露进沙箱的路径 = 字符设备 + **非空**目录（新驱动 mempool 要 `/dev/nvidia-caps`）。 */
  exposable: string[]
  /** `/dev` 读得到吗：`false` 时"没有 nvidia*"只是"没读到"（A2 的口径）。 */
  readable: boolean
}

/**
 * `/dev` 的**一次**遍历拿到三件事——**全仓唯一一份实现**（装配点与契约共用，C1）：
 *  · `deviceNodes`：字符设备。**只有它算"设备可见"**（能打开的才算设备——契约的判据）；
 *  · `deviceExtras`：其它 `nvidia*` 条目（`nvidia-caps` 目录等）。只作证据，不当设备；
 *  · `exposable`：要暴露进沙箱的路径 = 字符设备 + **非空目录**（新驱动 mempool 要 `/dev/nvidia-caps`）。
 *
 * 「设备可见吗」与「要暴露什么」**是两件事**：混成一个函数会让装配点与面板各说一套——
 * 2026-09-26 验收实测分叉过（装配点把非空目录也算设备，契约只算字符设备）。
 * `readable=false` = `/dev` 读不到：此时"没有 nvidia*"只是"没读到"（A2 的口径）。
 * 这个函数**只读**：它自己从不往 `/dev` 里写东西（会写的只有 `nvidia-smi`，见 `probeGpuFacts`）。
 */
export function scanGpuDevices(devDir = "/dev"): GpuDeviceScan {
  const deviceNodes: string[] = []
  const deviceExtras: string[] = []
  const exposable: string[] = []
  let names: string[]
  try { names = readdirSync(devDir) } catch { return { deviceNodes, deviceExtras, exposable, readable: false } }
  for (const name of names.filter(candidate => candidate.startsWith("nvidia"))) {
    const node = join(devDir, name)
    try {
      const stats = statSync(node)
      if (stats.isCharacterDevice()) { deviceNodes.push(node); exposable.push(node); continue }
      deviceExtras.push(node)   // 目录/其它类型：只作证据，不当"设备可用"
      if (stats.isDirectory() && readdirSync(node).length > 0) exposable.push(node)
    } catch { /* 读不到的条目不猜 */ }
  }
  // 排序只为"同一台机器两次读数一致"：`readdirSync` 的顺序不保证稳定，而它进指纹。
  return { deviceNodes: deviceNodes.sort(), deviceExtras: deviceExtras.sort(), exposable: exposable.sort(), readable: true }
}

export interface GpuDeviceVisibility {
  /** **唯一判据**：本会话有没有看得见的 NVIDIA 字符设备。 */
  visible: boolean
  deviceNodes: readonly string[]
  deviceExtras: readonly string[]
  /** `/dev` 读得到吗：`false` 时上面的"没有节点"只是"没读到"。 */
  devReadable: boolean
}

/** 契约侧的"设备可见"判据（纯函数）：只有**字符设备**算（`/dev/nvidia-caps` 目录不算）。 */
export function gpuDeviceVisibility(readings: Pick<GpuFacts, "deviceNodes" | "deviceExtras" | "devReadable">): GpuDeviceVisibility {
  const deviceNodes = readings.deviceNodes ?? []
  const deviceExtras = readings.deviceExtras ?? []
  return { visible: deviceNodes.length > 0, deviceNodes, deviceExtras, devReadable: readings.devReadable ?? true }
}

/**
 * **装配点入口**（C1）：本会话看得见设备吗（与 `classifyGpu` **同一份判据**）+ 要把哪些路径暴露进沙箱。
 *
 * 装配点**不许**再有自己的一套"什么算设备"：C1 实测它是"字符设备**或非空目录**"，
 * 于是"只暴露了 `nvidia-caps`、没有 `nvidia0`"的容器里守卫不触发，把 caps 当设备交下去，
 * 而同一台机器在面板里仍显示"会话看不见设备"——同一件事两个判据，迟早分叉。
 *
 * **它也不许再有自己的一套"什么时候读 `/dev`"**（2026-09-27 收口）：本函数原先直接
 * `scanGpuDevices`（不跑有副作用的那一步），于是它的读数取决于"这个进程里 `nvidia-smi` 跑过没有"——
 * ORDER-DEPENDENCY-RECHECK §6.2 冷启动实测：装配点第 1 次 `deviceExtras=[]`、面板探过一次之后第 2 次
 * `["/dev/nvidia-caps"]`，**不等**。当时 `visible`/`exposable` 看着没事，但那是
 * "`nvidia-smi` 造的是**空**目录"这个**偶然结果**（两道过滤恰好滤掉它），不是不变式：
 * 换成真驱动的**非空** mempool 形态（`exposable` 认非空目录）当场就会抖。
 * ⇒ 现在与 `probeGpuFacts` 走**同一份** `settledDeviceScan`：先跑完有副作用的那一步、再把它自己
 * 造出来的条目收回去，读数只跟**这台机器**有关，与调用次数、与谁先跑过无关。
 *
 * `options` 与 `probeGpuFacts` 的注入缝同一形状（`smi` / `smiProbe` / `smiPath`）；
 * 省略 = 真跑 `nvidia-smi`（与面板同价，约 25ms），**不是**"跳过"。
 */
export function probeGpuDeviceVisibility(
  devDir = "/dev",
  options: Pick<GpuProbeOptions, "smi" | "smiProbe" | "smiPath"> = {},
): GpuDeviceVisibility & { exposable: readonly string[] } {
  const { scan } = settledDeviceScan(devDir, options)
  return { ...gpuDeviceVisibility({ deviceNodes: scan.deviceNodes, deviceExtras: scan.deviceExtras, devReadable: scan.readable }), exposable: scan.exposable }
}

/**
 * 把**这次探测自己造出来的条目**收回去，返回撤销之后的 `/dev` 读数。
 *
 * 为什么必须撤销（2026-09-26 复核实测）：`nvidia-smi` 跑一次就凭空建 `/dev/nvidia-caps`
 * （失败、exit 9 也照样建）。**顺序固定**（见 `probeGpuFacts` 里的顺序说明）只保证**读数稳定**，
 * 不保证**证据是真话**——那个条目是探测自己造的，却被当成"这台机器 `/dev` 里有什么"写进证据与指纹：
 * 实测新挂载的空 `/dev` 上，首读就带 `/dev/nvidia-caps`，而任何没跑过 `nvidia-smi` 的观察者
 * （用户 `ls /dev`、别的工具）看到的都是空 ⇒ **同一台机器两句话，证据不可被独立复现**。
 *
 * 为什么不用"探测前先记快照、拿快照当证据"：那会把冷/热顺序差**原样引回来**（实测同一挂载下
 * 第 1 个进程证据 `[]`、第 2 个进程 `["/dev/nvidia-caps"]`，等于 B2 那条缺陷换个位置复发）；
 * 而"进程内记住第一次快照"又会把长驻 Host 的读数**冻住**，之后 `/dev` 真变了也看不见。
 *
 * 收口的判据只有一条：**只撤"本次窗口内新出现 + 是目录 + 空"的那一种，撤不掉就如实留着**——
 *  · 非空目录不撤（真驱动的 mempool 能力节点可能就在里面）；
 *  · 字符设备/普通文件不撤（撤设备节点是另一件事，探测不做；真的多出设备节点时读数会照实带上）；
 *  · `rmdir` 失败（无权限/别人刚放东西进去）⇒ 留在原地并**照实上报**，不假装看不见。
 * 于是"探测前"与"探测后"是同一个状态：证据既是这台机器本来的样子，也与独立观察者一致。
 */
function settleProbeCreatedEntries(before: GpuDeviceScan, devDir: string): GpuDeviceScan {
  const after = scanGpuDevices(devDir)
  const known = new Set([...before.deviceNodes, ...before.deviceExtras])
  const created = [...after.deviceNodes, ...after.deviceExtras].filter(node => !known.has(node))
  let undone = 0
  for (const node of created) {
    try {
      if (!statSync(node).isDirectory()) continue
      if (readdirSync(node).length > 0) continue
      rmdirSync(node)
      undone += 1
    } catch { /* 撤不掉（无权限等）⇒ 如实留着：读数会带上它，不猜也不藏 */ }
  }
  // 撤销过就重读一次：读数是**撤销之后**的 `/dev`，不是一个我们刚改过的中间态。
  return undone === 0 ? after : scanGpuDevices(devDir)
}

/**
 * **读 `/dev` 的唯一入口**（装配点与面板共用这一份实现）—— 它把两件事绑成**一条**不变式：
 *   ① **顺序**：有副作用的那一步（`nvidia-smi` 会在 `/dev` 里凭空建条目）**先跑完**，再报读数；
 *   ② **收口**：把这一步**自己造出来**的条目收回去（判据与理由见 `settleProbeCreatedEntries`）。
 * ⇒ 读数既是**稳态**（与调用次数、与用例顺序无关），又是**这台机器本来的样子**（与独立观察者一致）。
 *
 * 为什么必须共用：`probeGpuDeviceVisibility`（装配点）与 `probeGpuFacts`（面板）都在报
 * `deviceExtras`/`exposable`，两边各写一遍顺序就会分叉 —— 2026-09-27 之前正是这样：
 * 面板修好了"先跑副作用再读"，装配点没修，冷启动同进程两次调用**实测不等**
 * （`[]` → `["/dev/nvidia-caps"]`，`bugfixHistory/ORDER-DEPENDENCY-RECHECK-20260926.md` §6.2）。
 * 返回 `smi` 供需要显存/型号的调用方复用（装配点不需要它，但一样要付这一步的代价 —— 那正是不变式）。
 */
function settledDeviceScan(
  devDir: string,
  options: Pick<GpuProbeOptions, "smi" | "smiProbe" | "smiPath">,
): { scan: GpuDeviceScan; smi: GpuFacts["smi"] } {
  // 先记快照（认领"本次探测自己造出来的条目"），再跑有副作用的那一步，最后收回并重读。
  const before = scanGpuDevices(devDir)
  const smi = options.smi === false
    ? { present: false, ok: false, output: "", error: "未探测（已禁用 nvidia-smi）", reason: "not-probed" as const }
    : (options.smiProbe ?? (() => probeSmi(options.smiPath)))()
  return { scan: settleProbeCreatedEntries(before, devDir), smi }
}

/** 宿主 GPU 读数（真实 IO；目录可注入，测试离线跑）。 */
export function probeGpuFacts(options: GpuProbeOptions = {}): GpuFacts {
  const devDir = options.devDir ?? "/dev"
  const procDriverDir = options.procDriverDir ?? "/proc/driver"
  const sysBusPciDir = options.sysBusPciDir ?? "/sys/bus/pci/devices"
  try {
    const versionPath = join(procDriverDir, "nvidia", "version")
    // A2：先记"这个来源读得到吗"。`/proc/driver` 本身读不到（gVisor / 显式 mask /proc / 受限沙箱）
    // 与"读到了、但里面没有 nvidia"是两件事：**后者才是"驱动没注册"的证据**。
    let driverReadable = true
    try { readdirSync(procDriverDir) } catch { driverReadable = false }
    const driverVersion = existsSync(versionPath) ? (readFileSync(versionPath, "utf8").split("\n")[0] ?? "").trim() || null : null
    let driverGpuEntries: string[] = []
    try { driverGpuEntries = readdirSync(join(procDriverDir, "nvidia", "gpus")) } catch { /* 未加载驱动时目录不存在 */ }
    // ⚠️ 这一步的顺序**是判据的一部分，不是风格**（2026-09-26 实测）：
    //   `nvidia-smi` 自己会在 `/dev` 里留下条目 —— 本机跑一次它就凭空创建 `/dev/nvidia-caps`
    //   （失败、exit 9 也照样创建；`ls /dev | grep nvidia` 跑前为空、跑后为 `nvidia-caps`）。
    //   先枚举 `/dev` 再跑它 ⇒ 「本进程第一次探测」看不到那个条目、「之后的探测」看得到
    //   ⇒ `deviceExtras` 变成"这个探测被调用过几次"的函数，而不是"这台机器什么样"的函数。
    //   后果不是理论上的：同一进程里产品面板探一次、用例再探一次，同一台机器会得到**两句不同的理由**
    //   （`engine-panel-decision` 冷启动 4 pass / 1 fail 就是这么来的），
    //   而 release-gate 顺序 spawn 用例 ⇒ 门的绿灯会依赖"前面哪个用例先跑过"。
    // ⇒ 把**有副作用的那一步先做完**，再读 `/dev`：每次探测都看到同一个稳态，
    //   读数与调用次数、与用例顺序全都无关。
    // ⚠️ 但"顺序固定"只买到**稳定**，买不到**真话**：那个凭空造出来的条目仍会被当成"这台机器
    //   `/dev` 里有什么"写进证据（2026-09-26 复核实测：新挂载的空 `/dev` 首读就带 `/dev/nvidia-caps`，
    //   而没跑过 nvidia-smi 的观察者看到的是空）。下面这份快照**不是**用来当证据的
    //   （那会把冷/热顺序差引回来），它只有一个用途：认领"这次探测自己造出来的条目"，
    //   好在枚举 `/dev` 之后把它们收回去——收口判据与理由见 `settleProbeCreatedEntries`。
    // ⇒ 顺序 + 收口这条不变式**只有一份实现**（`settledDeviceScan`），装配点 `probeGpuDeviceVisibility`
    //   走的就是它 —— 两边各写一遍就会分叉，2026-09-27 之前正是这样（§6.2 的残留①）。
    const { scan, smi } = settledDeviceScan(devDir, options)
    const deviceNodes = scan.deviceNodes
    const deviceExtras = scan.deviceExtras
    const pciDevices: string[] = []
    const pciIds: string[] = []
    let pciReadable = true
    try {
      for (const slot of readdirSync(sysBusPciDir).sort()) {
        try {
          const vendor = readFileSync(join(sysBusPciDir, slot, "vendor"), "utf8").trim().toLowerCase()
          if (vendor !== "0x10de") continue
          pciDevices.push(slot)
          const read = (name: string) => { try { return readFileSync(join(sysBusPciDir, slot, name), "utf8").trim().toLowerCase() } catch { return "" } }
          const device = read("device").replace(/^0x/, "")
          const klass = read("class")
          pciIds.push(`${slot} ${vendor.replace(/^0x/, "")}:${device || "?"}${klass === "" ? "" : ` class=${klass}`}`)
        } catch { /* 单个设备读失败不致命 */ }
      }
    } catch { /* A2：读不到 ≠ 没有——留 `pciReadable=false`，分类器据此**不下结论**，不谎报"无卡" */ pciReadable = false }
    // 驱动认了哪些卡、型号是什么：只取 `Model:` 行（UUID/serial 绝不读取进内存）。
    const driverGpuModels: string[] = []
    for (const busid of driverGpuEntries) {
      try {
        const information = readFileSync(join(procDriverDir, "nvidia", "gpus", busid, "information"), "utf8")
        const model = information.match(/^\s*Model:\s*(.+)$/mi)?.[1]?.trim()
        if (model !== undefined && model !== "") driverGpuModels.push(`${busid} ${model}`)
      } catch { /* 读不到就不写型号，不猜 */ }
    }
    return {
      probeError: null, driverVersion, driverGpuEntries, deviceNodes, deviceExtras, pciDevices, pciIds, driverGpuModels, smi,
      pciReadable, driverReadable, devReadable: scan.readable,
      capacity: smi.ok ? parseSmiCapacity(smi.output) : null,
      requiredVramMiB: options.requiredVramMiB ?? null,
      minDriverMajor: options.minDriverMajor ?? null,
    }
  } catch (error) {
    return {
      probeError: error instanceof Error ? error.message : String(error),
      driverVersion: null, driverGpuEntries: [], deviceNodes: [], deviceExtras: [], pciDevices: [], pciIds: [], driverGpuModels: [],
      smi: { present: false, ok: false, output: "", error: "" }, capacity: null,
      requiredVramMiB: options.requiredVramMiB ?? null, minDriverMajor: options.minDriverMajor ?? null,
    }
  }
}

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

/** 稳定错误码：`ENVIRONMENT_<依赖ID>_<状态>`——可 grep、可进回执、界面可直接显示。 */
export function environmentCode(dependencyId: string, state: string | null, status: EnvironmentStatus): string {
  const id = dependencyId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")
  const detail = (state ?? status).toUpperCase().replace(/[^A-Z0-9]+/g, "_")
  return `ENVIRONMENT_${id}_${detail}`
}

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
