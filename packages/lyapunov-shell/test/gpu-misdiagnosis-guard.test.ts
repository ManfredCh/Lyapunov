/**
 * GPU 误诊守卫（A1/A2/A3 + 探测副作用 + C1 装配点判据）· 2026-09-26
 *
 * 来源：`bugfixHistory/VERIFY-ENV-READINESS-GPU-20260926.md`（验收队，只读）§3 一类。W14+W21 把
 * 「有卡、有驱动、但这次会话看不见设备」修对了，**但同一套判据在另外三处仍反向误诊**，每条都把人
 * 导向"重装驱动/换卡"，而真实原因不是那个——与原始缺陷同一形状：
 *
 *  · **A1**（验收队**真容器**实测：`docker run --gpus all`，设备 5 个字符节点全可见、驱动已注册，
 *    镜像里没有 `nvidia-smi`）⇒ 旧判据给 `driver-broken` + "先重启…重装与内核匹配的驱动"，
 *    而读数里**自己就写着**"nvidia-smi 未安装"。命中面很宽：精简镜像 / PATH 里没有它 / 只装内核模块。
 *  · **A2**（`/sys/bus/pci/devices` 与 `/proc/driver` 都被遮蔽）⇒ 旧判据断言
 *    "本机确实没有卡——不是看不见，是没有"，因为 `readdirSync` 的异常被静默吞掉。**读不到 ≠ 没有**。
 *  · **A3**（驱动模块在、卡不在）⇒ 旧判据给 `device-hidden` 并断言"卡是好的"，而**同一条解释链**
 *    第 2 段刚写完"但没有认到任何 GPU"——自相矛盾且反向误导（叫用户"不要换卡"）。
 *
 * 本文件钉四件事：
 *  1. 三条误诊各自的**状态 + 处置话术**（A1 的处置里不许出现任何"重装驱动/重启"的正向指令）；
 *  2. 三条误诊各自的**负对照**（不许把既有正确分型一起改掉：通信失败仍是 `driver-broken`、
 *     读得到且确实没有仍是 `no-device`、有 PCI 或挂载证据仍是 `device-hidden`）；
 *  3. **W21 的主路径不许被这次收紧改掉**（容器没加 `--gpus all` = `device-hidden`，一个字不动）；
 *  4. **C1**：装配点（`packages/sim-isaac/src/plugin.ts`）与契约**共用同一份"设备可见"判据**
 *     （旧状两处判据不同：装配点把"非空目录"也算设备，契约只算字符设备）。
 *
 * 边界（如实登记，别把本文件当成本机做不到的事的证据）：
 *  · 判据用**合成事实**离线跑（CI 上没有 GPU/驱动也能覆盖），真机只做**结构性**断言；
 *  · 本机造不出字符设备（`mknod` 实测"不允许的操作"），所以"设备节点可见"那一格只能合成；
 *  · A4（`/proc/driver` 被遮蔽 + `/sys` 见卡 ⇒ `driver-missing`）本机**无法用真实容器复现**，
 *    只登记判据收紧（读数不可得时不许断言"驱动没加载"）。
 */
import { expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  GPU_STATE_WORDING, classifyGpu, gpuDeviceVisibility, gpuRefusal, gpuRow, gpuRuntimeDecision, gpuStatus,
  probeGpuDeviceVisibility, probeGpuFacts, probeSmiAbsenceEvidence, scanGpuDevices, smiAbsenceDetail, type GpuFacts,
} from "../src/environment-readiness.ts"

const DRIVER_LINE = "NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  595.91.07  Release Build  (dvs-builder@U22-I3-B08-02-2)  Wed Jul 29 03:01:16 UTC 2026"
const SMI_OK = "NVIDIA GeForce RTX 5090 Laptop GPU, 24463, 1024"
const SMI_FAIL = "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver. Make sure that the latest NVIDIA driver is installed and running."

/** 本机 2026-09-26 的真实形态（驱动已注册且已挂载、PCI 上有卡、/dev 里有字符设备）。 */
function gpuFacts(overrides: Partial<GpuFacts> = {}): GpuFacts {
  return {
    probeError: null, driverVersion: DRIVER_LINE, driverGpuEntries: ["0000:02:00.0"], deviceNodes: ["/dev/nvidia0"], deviceExtras: [],
    pciDevices: ["0000:02:00.0"], pciIds: ["0000:02:00.0 10de:2c58 class=0x030000"], driverGpuModels: ["0000:02:00.0 NVIDIA GeForce RTX 5090 Laptop GPU"],
    smi: { present: true, ok: true, output: SMI_OK, error: "" },
    capacity: { totalMiB: 24463, freeMiB: 23439 }, requiredVramMiB: null, minDriverMajor: null,
    ...overrides,
  }
}

/** 一段判定给用户的**全文**：读数 + 解释链 + 一句话结论 + 统一话术 + 处置步骤。 */
function fullText(facts: GpuFacts): string {
  const decision = gpuRuntimeDecision(facts)
  const row = gpuRow(facts)
  return [decision.headline, ...decision.explanation, ...decision.gpuRequired.wording, row.remedy.summary, ...row.remedy.steps].join("\n")
}

/** `driver-broken` 那一套独有的处置/读数：A1 的全文里**一个字都不许出现**（否则就是又把好驱动判坏了）。 */
const DRIVER_BROKEN_ONLY = ["先重启", "重装与内核匹配的驱动", "dmesg | grep -i nvrm", "驱动已损坏", "驱动打不开设备"]

// ───────────────────────────── A1：缺诊断工具 ≠ 驱动坏了 ─────────────────────────────

test("A1 真容器形态：设备 5 节点全可见 + 驱动已注册 + 没有 nvidia-smi ⇒ 不落 driver-broken", () => {
  // 验收队真实容器读数（`--gpus all`，镜像里没有 nvidia-smi）：deviceNodes 5 个、smi.present=false。
  const facts = gpuFacts({
    deviceNodes: ["/dev/nvidia0", "/dev/nvidiactl", "/dev/nvidia-uvm", "/dev/nvidia-uvm-tools", "/dev/nvidia-modeset"],
    deviceExtras: ["/dev/nvidia-caps"], capacity: null,
    smi: { present: false, ok: false, output: "", error: "nvidia-smi 未安装", reason: "not-installed" },
  })
  const classification = classifyGpu(facts)
  expect(classification.state).toBe("smi-missing")
  expect(classification.state).not.toBe("driver-broken")
  // 状态是"未知"，不是"损坏"/"缺失"：这台机器没有任何"坏了"的证据。
  expect(gpuStatus(classification.state)).toBe("unknown")
  expect(classification.uncertain).toBe(true)

  const decision = gpuRuntimeDecision(facts)
  expect(decision.accelerator).toBe("unknown")          // 不是 broken（不许说驱动坏了）、不是 absent（不许说没卡）
  expect(decision.accelerator).not.toBe("broken")
  expect(decision.accelerator).not.toBe("absent")
  expect(decision.gpuRequired.blocked).toBe(true)        // 没核实清楚前，需要 GPU 的能力照样拒绝
  expect(decision.gpuRequired.code).toBe("ENVIRONMENT_GPU_SMI_MISSING")

  const text = fullText(facts)
  expect(text).toContain("nvidia-smi 未安装")            // 读数里那条自己就写着的原因，必须带出来
  expect(text).toContain("缺的是诊断工具")
  expect(text).toContain("**不要**")                     // 明确的反向指令
  expect(text).toContain("重装驱动")
  for (const forbidden of DRIVER_BROKEN_ONLY) expect(text).not.toContain(forbidden)
  // 处置步骤里凡是提到"重装驱动"的那一条，必须是否定句（不许出现"重装驱动"这类正向指令）。
  const row = gpuRow(facts)
  for (const step of row.remedy.steps.filter(candidate => candidate.includes("重装驱动"))) expect(step).toContain("不要")
  expect(row.remedy.summary).toContain("nvidia-smi")
  expect(row.remedy.summary).toContain("可能完全正常")
})

test("A1 负对照：nvidia-smi 在、只是通信失败 ⇒ 必须仍是 driver-broken（不是把 driver-broken 一刀切掉）", () => {
  const commFail = gpuFacts({ capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } })
  const missing = gpuFacts({ capacity: null, smi: { present: false, ok: false, output: "", error: "nvidia-smi 未安装", reason: "not-installed" } })
  expect(classifyGpu(commFail).state).toBe("driver-broken")
  expect(classifyGpu(missing).state).toBe("smi-missing")
  expect(classifyGpu(commFail).state).not.toBe(classifyGpu(missing).state)
  // 反向钉住：driver-broken 那一套处置**仍然在**（否则负对照是空的）。
  expect(fullText(commFail)).toContain("重装与内核匹配的驱动")
  expect(fullText(commFail)).not.toContain("缺的是诊断工具")
  // 两种形态的读数、稳定码、处置两两不同。
  expect(classifyGpu(commFail).reading).not.toBe(classifyGpu(missing).reading)
  expect(gpuRuntimeDecision(commFail).gpuRequired.code).toBe("ENVIRONMENT_GPU_DRIVER_BROKEN")
  expect(gpuRuntimeDecision(commFail).gpuRequired.code).not.toBe(gpuRuntimeDecision(missing).gpuRequired.code)
})

test("A1 探测层：ENOENT 记成「未安装」，与「调用方关掉了探测」分开（都不许说成打不开设备）", () => {
  const root = mkdtempSync(join(tmpdir(), "lyapunov-a1-probe-"))
  try {
    const procDriverDir = join(root, "proc-driver")
    mkdirSync(join(procDriverDir, "nvidia", "gpus", "0000:02:00.0"), { recursive: true })
    writeFileSync(join(procDriverDir, "nvidia", "version"), `${DRIVER_LINE}\n`)
    const devDir = join(root, "dev")
    const sysBusPciDir = join(root, "sys-pci")
    mkdirSync(devDir, { recursive: true })
    mkdirSync(sysBusPciDir, { recursive: true })

    // PATH 里没有 nvidia-smi 这件事，用 `smiPath` 注入复现——**不改全局 process.env.PATH**（那会污染同进程的其它用例）。
    const absent = probeGpuFacts({ devDir, procDriverDir, sysBusPciDir, smiPath: join(root, "nvidia-smi-does-not-exist") })
    expect(absent.smi.present).toBe(false)
    expect(absent.smi.reason).toBe("not-installed")
    expect(absent.smi.error).toContain("未安装")
    expect(smiAbsenceDetail(absent)).toContain("PATH 里没有这个工具")

    // 关掉探测是**另一件事**（原因未探测，不是"未安装"）：两者的话术不许混。
    const notProbed = probeGpuFacts({ devDir, procDriverDir, sysBusPciDir, smi: false })
    expect(notProbed.smi.present).toBe(false)
    expect(notProbed.smi.reason).toBe("not-probed")
    expect(smiAbsenceDetail(notProbed)).toContain("没有探测")
    expect(smiAbsenceDetail(notProbed)).not.toContain("未安装")

    // 现场：设备节点只能合成（本机造不出字符设备），其余字段全部来自**真探测**。
    const live = classifyGpu({ ...absent, deviceNodes: ["/dev/nvidia0", "/dev/nvidiactl"] })
    expect(live.state).toBe("smi-missing")
    expect(live.reading).toContain("nvidia-smi 未安装")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ───────── A1-三态（2026-09-26 二级验收在 A1 自己的证据容器里抓到的复发） ─────────
//
// 复发形状：**`ENOENT` 只证明"执行不了"，不证明"没安装"**，却被写成了确定原因。
// 真容器读数（`docker run --gpus all oven/bun:1.3.13-alpine`，本单复核，逐条与验收一致）：
//   `command -v nvidia-smi` ⇒ /usr/bin/nvidia-smi（在 PATH 里）；文件 1259616 B、-rwxr-xr-x、ELF x86-64、可读；
//   `execFileSync`（裸名与绝对路径都）⇒ ENOENT: posix_spawn；PT_INTERP = /lib64/ld-linux-x86-64.so.2；
//   `ls -la /lib64` ⇒ 不存在（musl 底座只有 /lib/ld-musl-x86_64.so.1）。
// ⇒ 那台机器上"未安装（PATH 里没有这个工具）"与"装上/让 PATH 能找到它"**两句话都是假的**。
//
// 下面这一组把三态钉死（三态各自的**判据**与**话术**都必须不同）：
//   ① 真不在 PATH（连候选文件都没有）      ⇒ `not-installed`，才允许说"未安装"
//   ② 在 PATH、可读、有可执行位，spawn ENOENT ⇒ `not-runnable`，说"装着但跑不起来（缺 loader/glibc）"，**不许**说未安装
//   ③ 能跑、但退出非 0（通信失败）          ⇒ `present: true` ⇒ **仍 `driver-broken`**（负对照，不许被吞）
//
// ②的**可移植复现**（不需要 docker）：一个 755 的脚本，shebang 指向不存在的解释器 ——
// `execve` 与"缺 PT_INTERP"同样是 **ENOENT**（本机 2026-09-26 实测：`code=ENOENT`、`posix_spawn`）。
// 真机 ELF 那一格在容器里复核（回执 §1），这里用脚本形态保证 CI 上也能覆盖。

/** 造一个"在盘上、可读、有可执行位，但内核加载不了"的 `nvidia-smi`（shebang 指向不存在的解释器）。 */
function unloadableSmi(dir: string, interpreter = "/nonexistent/smi-loader-so"): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "nvidia-smi")
  writeFileSync(path, `#!${interpreter}\nnvidia-smi-fake\n`)
  chmodSync(path, 0o755)
  return path
}

/** 造一个"能跑、但打不开设备"的 `nvidia-smi`（真实现把这类失败写在 stdout 并以 exit 9 结束）。 */
function failingSmi(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "nvidia-smi")
  writeFileSync(path, `#!/bin/sh\necho "${SMI_FAIL}"\nexit 9\n`)
  chmodSync(path, 0o755)
  return path
}

test("A1-② 装了跑不起来：文件在 PATH、可读、有可执行位、spawn 仍 ENOENT ⇒ not-runnable（不是未安装）", () => {
  const root = mkdtempSync(join(tmpdir(), "lyapunov-a1-unloadable-"))
  try {
    const procDriverDir = join(root, "proc-driver")
    mkdirSync(join(procDriverDir, "nvidia", "gpus", "0000:02:00.0"), { recursive: true })
    writeFileSync(join(procDriverDir, "nvidia", "version"), `${DRIVER_LINE}\n`)
    const devDir = join(root, "dev")
    const sysBusPciDir = join(root, "sys-pci")
    mkdirSync(devDir, { recursive: true })
    mkdirSync(sysBusPciDir, { recursive: true })

    const path = unloadableSmi(join(root, "bin"))
    const probed = probeGpuFacts({ devDir, procDriverDir, sysBusPciDir, smiPath: path })

    // 判据：ENOENT + 盘上有文件 ⇒ not-runnable；**取证**四个字段逐个可核。
    expect(probed.smi.present).toBe(false)
    expect(probed.smi.reason).toBe("not-runnable")
    expect(probed.smi.absence?.path).toBe(path)
    expect(probed.smi.absence?.regularFile).toBe(true)
    expect(probed.smi.absence?.readable).toBe(true)
    expect(probed.smi.absence?.executable).toBe(true)          // 有可执行位——这正是"ENOENT ≠ 没装"的分界
    expect(probed.smi.absence?.interpreter).toBe("/nonexistent/smi-loader-so")
    expect(probed.smi.absence?.interpreterPresent).toBe(false)
    // 探测自己记下的 error 也不许再说"未安装"。
    expect(probed.smi.error).not.toContain("未安装")

    const detail = smiAbsenceDetail(probed)
    expect(detail).toContain("装着但跑不起来")
    expect(detail).toContain("/nonexistent/smi-loader-so")     // 指名道姓给出可核对的那一条
    expect(detail).not.toContain("未安装")
    expect(detail).not.toContain("PATH 里没有这个工具")

    // 现场形态（设备节点合成，其余真探测）：仍是 smi-missing，但读数说的是"装了跑不起来"。
    const live = classifyGpu({ ...probed, deviceNodes: ["/dev/nvidia0", "/dev/nvidiactl"], deviceExtras: [] })
    expect(live.state).toBe("smi-missing")
    expect(live.reading).toContain("装着但跑不起来")
    expect(live.reading).not.toContain("未安装")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("A1-② 的处置：不许再让用户去装一个已经装着的工具（装包/修 PATH 是死胡同）", () => {
  const root = mkdtempSync(join(tmpdir(), "lyapunov-a1-unloadable-remedy-"))
  try {
    // 处置分支必须由**真探测**的结果驱动（不是测试自己把 reason 填成 not-runnable）：
    // 还原 probeSmi 那一处判定，这条用例会精确变红（拿到的是装包那一套）。
    const probed = probeGpuFacts({ devDir: "/nonexistent-dev", procDriverDir: "/nonexistent-proc", sysBusPciDir: "/nonexistent-sys", smiPath: unloadableSmi(join(root, "bin")) })
    expect(probed.smi.reason).toBe("not-runnable")
    const facts = gpuFacts({ deviceNodes: ["/dev/nvidia0", "/dev/nvidiactl"], deviceExtras: [], capacity: null, smi: probed.smi })
    const row = gpuRow(facts)
    const text = [row.remedy.summary, ...row.remedy.steps].join("\n")
    // 第一步必须是**取证**（在不在、能不能跑），而不是"装"。
    expect(row.remedy.steps[0]).toContain("先确认工具在不在、能不能跑")
    // 死胡同两条：都不许出现在这一态里。
    expect(text).not.toContain("apt install")
    expect(text).not.toContain("未安装")
    expect(text).not.toContain("让 PATH 能找到它")
    // 真正有效的那两条必须在。
    expect(text).toContain("glibc 底座")
    expect(text).toContain("从宿主挂一个")
    // 一条都不许把人推向驱动（正向指令）。
    expect(text).toContain("**不要**")
    for (const forbidden of DRIVER_BROKEN_ONLY) expect(text).not.toContain(forbidden)
    for (const step of row.remedy.steps.filter(candidate => candidate.includes("重装驱动"))) expect(step).toContain("不要")
    // 面板行/运行时决策拿到的是**同一份**处置（不是两处各写一句）。
    expect(gpuRuntimeDecision(facts).gpuRequired.remedy).toEqual(row.remedy)
    expect(gpuRuntimeDecision(facts).gpuRequired.code).toBe("ENVIRONMENT_GPU_SMI_MISSING")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("A1-③ 负对照（真子进程）：能跑但退出非 0 ⇒ 仍是 driver-broken，且 driver-broken 那套处置**仍在**", () => {
  const root = mkdtempSync(join(tmpdir(), "lyapunov-a1-commfail-"))
  try {
    const procDriverDir = join(root, "proc-driver")
    mkdirSync(join(procDriverDir, "nvidia", "gpus", "0000:02:00.0"), { recursive: true })
    writeFileSync(join(procDriverDir, "nvidia", "version"), `${DRIVER_LINE}\n`)
    const devDir = join(root, "dev")
    const sysBusPciDir = join(root, "sys-pci")
    mkdirSync(devDir, { recursive: true })
    mkdirSync(sysBusPciDir, { recursive: true })

    const probed = probeGpuFacts({ devDir, procDriverDir, sysBusPciDir, smiPath: failingSmi(join(root, "bin")) })
    // 能跑起来 ⇒ present：这一态与"没装/装不上"从根上就不同。
    expect(probed.smi.present).toBe(true)
    expect(probed.smi.ok).toBe(false)
    expect(probed.smi.reason).toBeUndefined()
    expect(probed.smi.output).toContain("couldn't communicate with the NVIDIA driver")

    const live = classifyGpu({ ...probed, deviceNodes: ["/dev/nvidia0", "/dev/nvidiactl"], deviceExtras: [] })
    expect(live.state).toBe("driver-broken")
    const decision = gpuRuntimeDecision({ ...probed, deviceNodes: ["/dev/nvidia0"], deviceExtras: [] })
    expect(decision.accelerator).toBe("broken")
    expect(decision.gpuRequired.code).toBe("ENVIRONMENT_GPU_DRIVER_BROKEN")
    const text = [decision.headline, ...decision.explanation, ...decision.gpuRequired.wording].join("\n")
    expect(text).toContain("重装与内核匹配的驱动")               // 负对照不是空的
    expect(text).not.toContain("缺的是诊断工具")
    expect(text).not.toContain("glibc 底座")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("A1-三态两两可分：判据（reason/取证）与话术（读数/处置）都不许合并", () => {
  // ① 真不在 PATH（绝对路径不存在 ⇒ 扫描不到任何候选）。
  const absent = gpuFacts({
    deviceNodes: ["/dev/nvidia0"], deviceExtras: [], capacity: null,
    smi: { present: false, ok: false, output: "", error: "x", reason: "not-installed", absence: probeSmiAbsenceEvidence("/nonexistent-dir/nvidia-smi") },
  })
  // ② 在 PATH 却跑不起来（本次真跑了一个 spawn：shebang 解释器不存在）。
  const root = mkdtempSync(join(tmpdir(), "lyapunov-a1-tri-"))
  try {
    const unloadable = unloadableSmi(join(root, "bin"))
    const probed = probeGpuFacts({ devDir: "/nonexistent-dev", procDriverDir: "/nonexistent-proc", sysBusPciDir: "/nonexistent-sys", smiPath: unloadable })
    expect(probed.smi.reason).toBe("not-runnable")
    const unloadableFacts = gpuFacts({ deviceNodes: ["/dev/nvidia0"], deviceExtras: [], capacity: null, smi: probed.smi })
    // ③ 能跑但通信失败。
    const commFail = gpuFacts({ deviceNodes: ["/dev/nvidia0"], deviceExtras: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } })

    const three = [absent, unloadableFacts, commFail]
    // 判据：三个 reason 两两不同（①②分开；③根本不是"缺工具"这一态）。
    expect([absent.smi.reason, unloadableFacts.smi.reason, commFail.smi.reason]).toEqual(["not-installed", "not-runnable", undefined])
    expect(classifyGpu(absent).state).toBe("smi-missing")
    expect(classifyGpu(unloadableFacts).state).toBe("smi-missing")
    expect(classifyGpu(commFail).state).toBe("driver-broken")
    // 话术：三条读数、三条处置正文、三句 detail **两两不同**。
    const readings = three.map(facts => classifyGpu(facts).reading)
    expect(new Set(readings).size).toBe(3)
    const details = three.map(facts => smiAbsenceDetail(facts))
    expect(new Set(details).size).toBe(3)
    const remedies = three.map(facts => JSON.stringify(gpuRow(facts).remedy))
    expect(new Set(remedies).size).toBe(3)
    // 逐态点名那句必须说对（这就是"更准"的判据本身）。
    expect(details[0]).toContain("未安装（PATH 里没有这个工具）")
    expect(details[1]).toContain("装着但跑不起来")
    expect(details[1]).not.toContain("未安装")
    expect(readings[1]).not.toContain("PATH 里没有这个工具")
    expect(remedies[0]).toContain("apt install")               // 真没装才给装包
    expect(remedies[1]).not.toContain("apt install")            // 装着跑不起来 ⇒ 不给装包
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("A1 取证层：PATH 扫描按 PATH 顺序认出候选；扫不到候选才算「没装」", () => {
  // `probeSmiAbsenceEvidence` 自己读 `process.env.PATH`（不走 spawn），所以这里可以**直接**喂一条受控 PATH。
  // 注意：Bun 的裸名 spawn 按**进程启动时**的 PATH 解析，运行期改 PATH 只影响本函数的取证，不影响 spawn
  // ——这条边界在源码注释与回执里都登记了（产品路径不改 PATH，所以不冲突）。
  const root = mkdtempSync(join(tmpdir(), "lyapunov-a1-pathscan-"))
  const savedPath = process.env.PATH
  try {
    const first = unloadableSmi(join(root, "first"), "/nonexistent/loader-first")
    const second = unloadableSmi(join(root, "second"), "/nonexistent/loader-second")
    process.env.PATH = `${join(root, "second")}:${join(root, "first")}`   // 故意把 second 放前面
    const found = probeSmiAbsenceEvidence("nvidia-smi")
    expect(found.candidates).toEqual([second, first])           // 按 PATH 顺序，不是目录顺序
    expect(found.path).toBe(second)
    expect(found.interpreter).toBe("/nonexistent/loader-second")

    process.env.PATH = join(root, "empty-dir")
    const none = probeSmiAbsenceEvidence("nvidia-smi")
    expect(none.candidates).toEqual([])
    expect(none.path).toBeNull()
    expect(none.interpreter).toBeNull()
    expect(none.interpreterPresent).toBeNull()                  // 取不到证就是 null，不许写成 false
  } finally { process.env.PATH = savedPath; rmSync(root, { recursive: true, force: true }) }
})

test("A1 兜底：原因未记录时**不许猜**成「没装」（旧调用方/合成事实走这一条）", () => {
  const unknown = gpuFacts({
    deviceNodes: ["/dev/nvidia0"], deviceExtras: [], capacity: null,
    smi: { present: false, ok: false, output: "", error: "", reason: undefined },
  })
  expect(classifyGpu(unknown).state).toBe("smi-missing")
  const row = gpuRow(unknown)
  const text = [row.remedy.summary, ...row.remedy.steps].join("\n")
  expect(text).toContain("先确认")
  expect(text).not.toContain("未安装")
  // 静态兜底那一份（`GPU_STATE_WORDING`）同样不许断言"没装"——它是 render-failure 的对照物。
  const staticText = [GPU_STATE_WORDING["smi-missing"].remedy.summary, ...GPU_STATE_WORDING["smi-missing"].remedy.steps].join("\n")
  expect(staticText).not.toContain("未安装")
  expect(staticText).not.toContain("先确认工具真的不在")
  expect(smiAbsenceDetail(unknown)).toContain("原因未记录")
})

// ───────────────────────────── A2：读不到 ≠ 没有 ─────────────────────────────

test("A2 三个来源都读不到 ⇒ unknown：不许断言「本机确实没有卡」", () => {
  const root = mkdtempSync(join(tmpdir(), "lyapunov-a2-probe-"))
  try {
    const missing = join(root, "not-there")
    // 现场：`/sys` 与 `/proc/driver` 都被遮蔽（gVisor / 显式 mask /proc / 受限沙箱）。
    const probed = probeGpuFacts({ devDir: missing, procDriverDir: missing, sysBusPciDir: missing, smi: false })
    expect(probed.pciReadable).toBe(false)
    expect(probed.driverReadable).toBe(false)
    expect(probed.devReadable).toBe(false)

    const classification = classifyGpu(probed)
    expect(classification.state).toBe("unknown")
    expect(classification.state).not.toBe("no-device")
    expect(classification.uncertain).toBe(true)
    const decision = gpuRuntimeDecision(probed)
    expect(decision.accelerator).toBe("unknown")
    expect(decision.accelerator).not.toBe("absent")
    expect(decision.gpuRequired.code).toBe("ENVIRONMENT_GPU_UNKNOWN")

    const text = fullText(probed)
    expect(text).toContain("读不到")
    expect(text).toContain("读不到 ≠ 没有")
    expect(text).not.toContain("确实没有")
    expect(text).not.toContain("不是看不见，是没有")
    // 证据行也要如实标"读不到"，而不是把空数组写成"无"（那是把"没读到"说成"没有"）。
    expect(classification.evidence.join("\n")).toContain("不可读")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("A2 负对照：读得到、且确实什么都没有 ⇒ 仍是 no-device（不是把 no-device 一刀切掉）", () => {
  const none = gpuFacts({ driverVersion: null, driverGpuEntries: [], deviceNodes: [], deviceExtras: [], pciDevices: [], pciIds: [], driverGpuModels: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } })
  expect(classifyGpu(none).state).toBe("no-device")
  expect(gpuStatus(classifyGpu(none).state)).toBe("missing")          // "确实没有"才配 missing
  expect(gpuRuntimeDecision(none).accelerator).toBe("absent")
  expect(fullText(none)).toContain("确实没有 NVIDIA 卡")
  // 与 A2 的"读不到"必须是两句不同的话、两个不同的面板状态。
  const unreadable = gpuFacts({ driverVersion: null, driverGpuEntries: [], deviceNodes: [], deviceExtras: [], pciDevices: [], pciIds: [], driverGpuModels: [], capacity: null, pciReadable: false, driverReadable: false, smi: { present: false, ok: false, output: "", error: "", reason: "not-probed" } })
  expect(classifyGpu(unreadable).state).toBe("unknown")
  expect(gpuStatus(classifyGpu(unreadable).state)).toBe("unknown")
  expect(classifyGpu(unreadable).reading).not.toBe(classifyGpu(none).reading)
})

// ───────────────────────────── A3：声称有卡必须有证据 ─────────────────────────────

test("A3 驱动在、卡不在 ⇒ 不许说「卡是好的」（旧判据在这里自相矛盾）", () => {
  const facts = gpuFacts({ driverGpuEntries: [], pciDevices: [], pciIds: [], driverGpuModels: [], deviceNodes: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } })
  const classification = classifyGpu(facts)
  expect(classification.state).toBe("card-unknown")
  expect(classification.state).not.toBe("device-hidden")
  expect(classification.uncertain).toBe(true)
  expect(gpuStatus(classification.state)).toBe("unknown")
  expect(gpuRuntimeDecision(facts).accelerator).toBe("unknown")        // 不许说 session-hidden（那是在断言有卡）
  expect(gpuRuntimeDecision(facts).gpuRequired.code).toBe("ENVIRONMENT_GPU_CARD_UNKNOWN")

  const text = fullText(facts)
  expect(text).not.toContain("卡是好的、驱动是好的")                    // 旧判据断言的那一句
  expect(text).not.toContain("--device")                               // 旧处置："把 /dev/nvidia* 暴露给本会话"
  expect(text).toContain("没有任何“有卡”的证据")
  expect(text).toContain("不要")                                       // 仍然明确反向：别先动驱动
})

test("A3 判据不变量：解释链第 2 段说「没有认到任何 GPU」时，第 4 段不许说「卡是好的」", () => {
  // 把 A3 的现场连同它周边的形态一起扫一遍——这条钉的是**不许自相矛盾**这个不变量，不是某个字符串。
  const shapes: GpuFacts[] = [
    gpuFacts({ driverGpuEntries: [], pciDevices: [], pciIds: [], driverGpuModels: [], deviceNodes: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } }),
    gpuFacts({ driverGpuEntries: [], pciDevices: [], pciIds: [], driverGpuModels: [], deviceNodes: [], deviceExtras: ["/dev/nvidia-caps"], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } }),
    gpuFacts({ driverGpuEntries: [], pciDevices: [], pciIds: [], driverGpuModels: [], deviceNodes: [], capacity: null, smi: { present: false, ok: false, output: "", error: "nvidia-smi 未安装", reason: "not-installed" } }),
  ]
  for (const shape of shapes) {
    const { explanation } = classifyGpu(shape)
    expect(explanation).toHaveLength(5)
    // 断言用的原句（`device-hidden` 的结论）是"**卡是好的、驱动是好的**"；撇清句"既不能说卡是好的"里
    // 出现同一个词但**不是断言**，所以这里精确匹配那句完整断言，而不是"卡是好的"这个子串。
    if (explanation[1]!.includes("没有认到任何 GPU")) expect(explanation[3]!).not.toContain("卡是好的、驱动是好的")
  }
})

test("A3 负对照：有 PCI **或** 驱动挂载证据（任一）时，仍必须是 device-hidden", () => {
  // 只有 PCI 读数（/proc 的挂载记录读不到）与只有挂载记录（PCI 被遮蔽）——两者都算"有卡"的证据。
  const pciOnly = gpuFacts({ driverGpuEntries: [], deviceNodes: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } })
  const attachedOnly = gpuFacts({ pciDevices: [], pciIds: [], deviceNodes: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } })
  for (const shape of [pciOnly, attachedOnly]) {
    const classification = classifyGpu(shape)
    expect(classification.state).toBe("device-hidden")
    expect(gpuStatus(classification.state)).toBe("degraded")
    expect(gpuRuntimeDecision(shape).accelerator).toBe("session-hidden")
    expect(gpuRuntimeDecision(shape).gpuRequired.code).toBe("ENVIRONMENT_GPU_DEVICE_HIDDEN")
    expect(fullText(shape)).toContain("卡是好的、驱动是好的")
  }
})

// ───────────────── W21 主路径：这次收紧**不许**把它改掉 ─────────────────

test("W21 主路径锁：容器没加 `--gpus all` ⇒ 仍是 device-hidden（不管有没有 nvidia-smi）", () => {
  const withoutSmi = gpuFacts({ deviceNodes: [], deviceExtras: [], capacity: null, smi: { present: false, ok: false, output: "", error: "nvidia-smi 未安装", reason: "not-installed" } })
  const withFailingSmi = gpuFacts({ deviceNodes: [], deviceExtras: ["/dev/nvidia-caps"], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } })
  for (const shape of [withoutSmi, withFailingSmi]) {
    const decision = gpuRuntimeDecision(shape)
    // A1 的新分支**不许**把"设备不可见"这一态抢走：可见性问题优先，处置指向 `--gpus all`。
    expect(decision.state).toBe("device-hidden")
    expect(decision.accelerator).toBe("session-hidden")
    expect(decision.gpuRequired.code).toBe("ENVIRONMENT_GPU_DEVICE_HIDDEN")
    const text = fullText(shape)
    expect(text).toContain("--gpus all")
    expect(text).toContain("**不要**重装驱动")
    expect(text).toContain("不是没有 GPU")
    for (const forbidden of ["本机没有 NVIDIA 卡", "本机确实没有 NVIDIA 卡", "GPU 不可用"]) expect(text).not.toContain(forbidden)
  }
})

test("W21 真机读数锁（宿主观测）：真机读数落在契约登记的某一态；设备隐藏形态的拒绝句由合同矩阵用夹具覆盖", () => {
  const real = probeGpuFacts()
  // 无条件：真机的分型必须是契约里登记过的状态之一（不许出现"没登记的状态"）。
  expect(["ready", "no-device", "driver-missing", "driver-broken", "device-hidden", "vram-insufficient", "driver-outdated", "unknown", "smi-missing", "card-unknown"])
    .toContain(classifyGpu(real).state)
  // 不依赖宿主形态的结构性断言（设备隐藏那一格的判据与话术在下面的合同矩阵里用合成夹具全覆盖）。
  expect(classifyGpu(real).explanation).toHaveLength(5)
})

/**
 * **合同矩阵（合成事实，宿主无关）** —— GATE-AB-20260927 新增。
 *
 * 原状：`W21 真机读数锁` 的 5 条断言只在"本机恰好是 device-hidden"时才跑，GPU 可见的宿主上
 * 全文件 expect 只有 237（< 冻结下限 242），于是**合同分支的覆盖量由宿主决定**。这里把
 * device-hidden / no-device / driver-missing / ready / card-unknown 五态用合成夹具逐条钉死：
 * 状态、加速器、稳定码、拒绝句（含卡 ID 与禁止话术）。真机那一条退化为"读数落在登记态内"。
 */
test("合同矩阵：五态的状态/加速器/稳定码/拒绝句逐条钉住（device-hidden 含卡 ID 与禁止话术）", () => {
  const hidden = gpuFacts({ deviceNodes: [], deviceExtras: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } })
  const noDevice = gpuFacts({ driverVersion: null, driverGpuEntries: [], driverGpuModels: [], deviceNodes: [], deviceExtras: [], pciDevices: [], pciIds: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } })
  const driverMissing = gpuFacts({ driverVersion: null, driverGpuEntries: [], driverGpuModels: [], deviceNodes: [], deviceExtras: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } })
  const ready = gpuFacts()
  const cardUnknown = gpuFacts({ driverGpuEntries: [], pciDevices: [], pciIds: [], driverGpuModels: [], deviceNodes: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } })
  const matrix = [
    { f: hidden, state: "device-hidden", accelerator: "session-hidden", code: "ENVIRONMENT_GPU_DEVICE_HIDDEN" },
    { f: noDevice, state: "no-device", accelerator: "absent", code: "ENVIRONMENT_GPU_NO_DEVICE" },
    { f: driverMissing, state: "driver-missing", accelerator: "driver-missing", code: "ENVIRONMENT_GPU_DRIVER_MISSING" },
    { f: ready, state: "ready", accelerator: "available", code: null },
    { f: cardUnknown, state: "card-unknown", accelerator: "unknown", code: "ENVIRONMENT_GPU_CARD_UNKNOWN" },
  ] as const
  for (const row of matrix) {
    expect(classifyGpu(row.f).state).toBe(row.state)
    const decision = gpuRuntimeDecision(row.f)
    expect(decision.accelerator).toBe(row.accelerator)
    expect(decision.gpuRequired.code).toBe(row.code)
    const refusal = gpuRefusal("合同矩阵", row.f)
    if (row.code === null) expect(refusal).toBeNull()
    else expect(refusal!.code).toBe(row.code)
  }
  // device-hidden 的拒绝句：卡 ID 可核对 + "这个会话看不见设备"，且禁止把可见性说成"没有"。
  const hiddenRefusal = gpuRefusal("Isaac RTX 渲染", hidden)!
  expect(hiddenRefusal.code).toBe("ENVIRONMENT_GPU_DEVICE_HIDDEN")
  expect(hiddenRefusal.message).toContain("10de:")
  expect(hiddenRefusal.message).toContain("这个会话看不见设备")
  expect(hiddenRefusal.message).not.toContain("本机没有 NVIDIA 卡")
  expect(hiddenRefusal.message).not.toContain("没有任何 NVIDIA 设备节点")
  expect(hiddenRefusal.message).not.toContain("GPU 不可用")
  // ready 不拒绝（确定性：夹具是驱动+设备+smi 全在）。
  expect(gpuRefusal("Isaac RTX 渲染", ready)).toBeNull()
})

// ───────────────── B2 复核：探测的副作用不再改自己的读数 ─────────────────

test("B2 复核（真机）：连读三次 state/headline/指纹/deviceExtras 全一致，且探测不把自己造出来的条目写进证据", () => {
  // 先以**独立观察者**的视角看一眼 `/dev`（探测之前）：探测跑完之后 `deviceExtras` 必须与它一致。
  // 这是"证据说的是这台机器、不是这次探测"的判据，且与机器上有没有真 GPU 无关——
  // 真机（本机）⇒ 探测前是空的，读数就必须是空的；有真 `nvidia-caps` 的机器 ⇒ 照实带上，不隐藏。
  const before = scanGpuDevices("/dev")
  const first = probeGpuFacts()
  const second = probeGpuFacts()
  const third = probeGpuFacts()
  // 旧症状：第 1 次 `deviceExtras=[]`、第 2/3 次多出 `/dev/nvidia-caps` ⇒ 指纹从 0a51d0520c27f937 变 bd4e90915d773047。
  expect(second.deviceExtras).toEqual(first.deviceExtras)
  expect(third.deviceExtras).toEqual(first.deviceExtras)
  expect(gpuRuntimeDecision(second).fingerprint).toBe(gpuRuntimeDecision(first).fingerprint)
  expect(gpuRuntimeDecision(third).fingerprint).toBe(gpuRuntimeDecision(first).fingerprint)
  expect(gpuRuntimeDecision(second).headline).toBe(gpuRuntimeDecision(first).headline)
  expect(classifyGpu(third).reading).toBe(classifyGpu(first).reading)
  // 第二轮（2026-09-26）：`nvidia-smi` 每次跑都会凭空建 `/dev/nvidia-caps`，而**那个条目不是这台
  // 机器的证据**——旧写法（只把副作用排到读 /dev 之前）首读就把它报出去：本机实测 fp=bd4e90915d773047，
  // 而没跑过 nvidia-smi 的观察者（上面那句 `scanGpuDevices`）看到的是空。现在两者必须逐项一致；
  // 同时探测**不许留下**它自己造的条目（`/dev` 里有没有 caps，探测前后必须是同一个答案）。
  expect([...first.deviceExtras]).toEqual([...before.deviceExtras])
  expect(existsSync("/dev/nvidia-caps")).toBe(before.deviceExtras.includes("/dev/nvidia-caps"))
  // 但**目录不算设备可见**：`nvidia-caps` 只可能在 extras 里，永远不在 deviceNodes 里。
  expect(first.deviceNodes).not.toContain("/dev/nvidia-caps")
})

// ───────────────── B3 收口：装配点也走同一条不变式（顺序 ＋ 收口），不再靠"产物恰好为空" ─────────────────

/**
 * 这一组钉的是 ORDER-DEPENDENCY-RECHECK §6.2 的**残留①**：
 * `probeGpuDeviceVisibility()`（装配点）原先直接 `scanGpuDevices`，不跑有副作用的那一步 ⇒
 * 它的读数取决于"这个进程里 `nvidia-smi` 跑过没有"。当时 `visible`/`exposable` 看着免疫，
 * 但那是"`nvidia-smi` 造的是**空**目录"这个**偶然结果**（两道过滤恰好滤掉它），不是不变式。
 * 下面第一条钉真机形态，第二条用**非空** caps（真驱动 mempool 的形态）把那个偶然拆掉。
 */

test("B3 装配点（真机）：连读三次 visible/deviceExtras/exposable 逐次相同，且不留自己造的条目", () => {
  const observer = scanGpuDevices("/dev")
  const first = probeGpuDeviceVisibility()
  const second = probeGpuDeviceVisibility()
  const third = probeGpuDeviceVisibility()
  expect(second.visible).toBe(first.visible)
  expect(third.visible).toBe(first.visible)
  expect(second.deviceExtras).toEqual(first.deviceExtras)
  expect(third.deviceExtras).toEqual(first.deviceExtras)
  expect(second.exposable).toEqual(first.exposable)
  expect(third.exposable).toEqual(first.exposable)
  expect(second.devReadable).toBe(first.devReadable)
  // 收口（与 `probeGpuFacts` 同一条）：装配点也不许把 `nvidia-smi` 造的条目当成"这台机器有什么"报出去。
  expect([...first.deviceExtras]).toEqual([...observer.deviceExtras])
  // 但目录永远不算设备可见。
  expect(first.deviceNodes).not.toContain("/dev/nvidia-caps")
})

test("B3 装配点（注入**非空** caps）：面板先探过一次也照样逐次相同 —— 修前这一格精确变脸", () => {
  const root = mkdtempSync(join(tmpdir(), "lyapunov-b3-assembly-"))
  try {
    const devDir = join(root, "dev")
    mkdirSync(devDir, { recursive: true })
    const caps = join(devDir, "nvidia-caps")
    let injected = 0
    /**
     * 替身造的是**非空**目录——这正是"`nvidia-smi` 造的恰好是空目录"那个偶然失效的形态：
     * 空目录会被 `settleProbeCreatedEntries` 收回去，非空目录**撤不掉**（真驱动的能力节点可能就在里面），
     * 于是它留在 `devDir` 里，谁先跑过谁就改掉后面所有读数的脸。
     */
    const smiProbe = () => {
      injected += 1
      mkdirSync(caps, { recursive: true })
      writeFileSync(join(caps, `cap${injected}`), "")
      return { present: true, ok: false, output: SMI_FAIL, error: "" }
    }
    const first = probeGpuDeviceVisibility(devDir, { smiProbe })
    // 「面板探过一次」（§6.2 里让装配点读数变脸的那一步）：同一条链、同一个 devDir。
    probeGpuFacts({ devDir, smiProbe })
    const second = probeGpuDeviceVisibility(devDir, { smiProbe })
    const third = probeGpuDeviceVisibility(devDir, { smiProbe })
    // ① 副作用已被算进**第一次**读数：稳态，不是"这次调用之前恰好还没有它"。
    expect(first.deviceExtras).toEqual([caps])
    expect(first.exposable).toEqual([caps])                  // 非空目录 ⇒ 必须暴露
    expect(first.visible).toBe(false)                        // 但**不算设备可见**（判据没变）
    // ② 三次逐次相同（修前：#1 = []、#2 = #3 = [caps]）。
    for (const read of [second, third]) {
      expect(read.visible).toBe(first.visible)
      expect(read.deviceExtras).toEqual(first.deviceExtras)
      expect(read.exposable).toEqual(first.exposable)
      expect(read.devReadable).toBe(first.devReadable)
    }
    // ③ 活性对照：替身真的被调用过（否则上面三条会因为"什么都没跑"而平凡通过）。
    expect(injected).toBeGreaterThanOrEqual(3)
    // ④ 判据仍只有一份：装配点是 `gpuDeviceVisibility` 的投影，不是自己数一遍。
    expect(first.deviceNodes).toEqual(gpuDeviceVisibility({ deviceNodes: [], deviceExtras: [caps] }).deviceNodes)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ───────────────── C1：装配点与契约共用同一份「设备可见」判据 ─────────────────

test("C1 `/dev` 扫描：非空 caps 目录不算设备可见，但要暴露；空目录则连暴露都不必", () => {
  const root = mkdtempSync(join(tmpdir(), "lyapunov-c1-dev-"))
  try {
    const devDir = join(root, "dev")
    mkdirSync(join(devDir, "nvidia-caps"), { recursive: true })
    // 空目录：既不是设备，也不进暴露清单（旧装配点也不暴露它）。
    const empty = scanGpuDevices(devDir)
    expect(empty.readable).toBe(true)
    expect(empty.deviceNodes).toEqual([])
    expect(empty.deviceExtras).toEqual([join(devDir, "nvidia-caps")])
    expect(empty.exposable).toEqual([])
    // 非空目录（真驱动 mempool 要它）：仍然**不算设备可见**，但必须暴露。
    writeFileSync(join(devDir, "nvidia-caps", "cap0"), "")
    const nonEmpty = scanGpuDevices(devDir)
    expect(nonEmpty.deviceNodes).toEqual([])                                                     // 判据：只算字符设备
    expect(nonEmpty.exposable).toEqual([join(devDir, "nvidia-caps")])                             // 暴露：算子目录
    const visibility = probeGpuDeviceVisibility(devDir)
    expect(visibility.visible).toBe(false)                                                        // 装配点的守卫必须触发
    expect(visibility.deviceExtras).toEqual([join(devDir, "nvidia-caps")])
    expect(visibility.exposable).toEqual([join(devDir, "nvidia-caps")])
    // 读不到 `/dev` 时不许说"没有设备节点"（A2 的口径也适用于装配点）。
    const gone = probeGpuDeviceVisibility(join(root, "not-there"))
    expect(gone.visible).toBe(false)
    expect(gone.devReadable).toBe(false)
    expect(gone.exposable).toEqual([])
    // 判据只有一份：纯函数与扫描结果、与契约的分类必须一致。
    expect(gpuDeviceVisibility({ deviceNodes: [], deviceExtras: [join(devDir, "nvidia-caps")] }).visible).toBe(false)
    expect(gpuDeviceVisibility({ deviceNodes: ["/dev/nvidia0"], deviceExtras: [] }).visible).toBe(true)
    expect(gpuDeviceVisibility({ deviceNodes: [], deviceExtras: [], devReadable: false }).devReadable).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("C1 装配点源码契约：plugin.ts 用契约的判据，不再自己数一遍「什么算设备」", () => {
  const source = readFileSync(join(import.meta.dirname, "../../sim-isaac/src/plugin.ts"), "utf8")
  // 装配点必须消费**契约的**判据（同一份 `gpuDeviceVisibility`；暴露清单另算）。
  expect(source).toContain("probeGpuDeviceVisibility(")
  expect(source).toContain("gpuRefusal(")
  expect(source).toContain("from '../../lyapunov-shell/src/environment-readiness.ts'")
  // 否定断言只看**代码**：注释里为了说明"旧状是什么"必然要提到旧函数名（这正是可追溯性），
  // 所以先把块注释与行注释剥掉，再钉"代码里不许有第二套判据"。
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter(line => !line.trimStart().startsWith("//")).join("\n")
    .replace(/\s\/\/\s.*$/gm, "")
  expect(code).not.toContain("nvidiaDeviceNodes")
  expect(code).not.toContain("isCharacterDevice")
  expect(code).not.toContain("startsWith('nvidia')")
  expect(code).not.toContain("readdirSync")
  // 仍然拒绝启动（不静默按 CPU 顶替用户明确配置的 GPU 需求）。
  expect(source).toContain("ISAAC_GPU_DEVICE_UNAVAILABLE")
})

// ───────────────── A4（降级为提示）：驱动读数不可得时不许断言「驱动没加载」 ─────────────────

test("A4 提示：/proc/driver 被遮蔽而 /sys 见卡 ⇒ 不再断言「驱动没加载」，标 uncertain 并给复核话术", () => {
  // 验收队声明本条**本机无法用真实容器复现**（只在显式 mask /proc 时成立）⇒ 只作判据收紧登记。
  const masked = gpuFacts({ driverVersion: null, driverGpuEntries: [], driverGpuModels: [], deviceNodes: [], driverReadable: false, capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } })
  const classification = classifyGpu(masked)
  expect(classification.state).toBe("driver-missing")     // 分型不变（卡在、驱动状态读不到）
  expect(classification.uncertain).toBe(true)             // 但**必须**标不确定：可能是遮蔽，不是没装
  expect(classification.explanation[3]).toContain("读不到驱动状态")
  expect(fullText(masked)).toContain("读数不可得时不要重装驱动")
  // 负对照：/proc 读得到、确实没有驱动注册 ⇒ 结论就是"驱动没加载"，不带不确定。
  const registered = gpuFacts({ driverVersion: null, driverGpuEntries: [], driverGpuModels: [], deviceNodes: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } })
  expect(classifyGpu(registered).state).toBe("driver-missing")
  expect(classifyGpu(registered).uncertain).toBe(false)
  expect(classifyGpu(registered).explanation[3]).toContain("卡在，但驱动没加载")
  expect(gpuRow(masked).uncertain).toBe(true)
  expect(gpuRow(registered).uncertain).toBe(false)
})
