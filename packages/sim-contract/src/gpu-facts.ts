/**
 * GPU 事实、分型与拒绝判定的**唯一 owner**。
 *
 * 为什么在 sim-contract：Isaac Provider 的装配守卫与 Shell 的环境面板问的是同一台机器的
 * 同一组读数（设备节点、驱动、PCI、nvidia-smi）。Provider 不能反向依赖 Shell，因此把
 * 探测/分型/拒绝下沉到这里；Shell 只做兼容 re-export，环境话术仍由共享 contracts 提供。
 */
import {execFileSync} from 'node:child_process'
import {accessSync,closeSync,constants,existsSync,lstatSync,openSync,readFileSync,readdirSync,readSync,rmdirSync,statSync} from 'node:fs'
import {join} from 'node:path'
import {ENVIRONMENT_CONTRACT_TEST,environmentCode,environmentRowWording,type EnvironmentDegradation,type EnvironmentRemedy,type EnvironmentRow,type EnvironmentStatus} from '../../lyapunov-contracts/src/environment.ts'

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


/**
 * WSL2 的 GPU 暴露形态：不是 `/dev/nvidia*`，而是单一字符设备 `/dev/dxg`，CUDA 用户态库
 * 由 Windows 宿主投影在 `/usr/lib/wsl/lib`（`libcuda.so.1`）。**只读**判定，不写 `/dev`。
 * 语义与 `probeGpuDeviceVisibility` 刻意分开：面板/doctor 仍按 NVIDIA 节点如实报"看不见"，
 * 这里只回答"引擎在 WSL2 里要暴露什么"，不冒充"这台机器有 NVIDIA 设备节点"。
 */
export function probeWslGpuDevices(options: {
  devDir?: string
  libDir?: string
  statDevice?: (path: string) => { isCharacterDevice(): boolean } | null
  libExists?: (path: string) => boolean
} = {}): { devices: readonly string[]; libraryDir: string | null } {
  const devDir = options.devDir ?? "/dev"
  const libDir = options.libDir ?? "/usr/lib/wsl/lib"
  const statDevice = options.statDevice ?? ((path: string) => { try { return lstatSync(path) } catch { return null } })
  const libExists = options.libExists ?? existsSync
  const dxg = `${devDir}/dxg`
  if (!statDevice(dxg)?.isCharacterDevice()) return { devices: [], libraryDir: null }
  if (!libExists(`${libDir}/libcuda.so.1`)) return { devices: [], libraryDir: null }
  return { devices: [dxg], libraryDir: libDir }
}
