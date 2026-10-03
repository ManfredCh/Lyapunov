/**
 * W14 · 环境能力（N1–N4／D1–D4）回归测试。
 *
 * 这一份测的就是"**环境缺失那一路**"（收敛清单 §4.3 D4 的完成条件）：GPU 分型、就绪面板、
 * 统一话术、声明→判定、安装期前置检查。判据全部用**合成事实**离线跑，所以 CI 上没有 GPU/驱动/
 * 浏览器也能覆盖；真实宿主只做**结构性**断言（不断言本机具体是哪种卡），真实读数另存回执。
 *
 * 边界：不改任何产品文件之外的写入域；不联网；不起真实子进程（安装器的子进程是 fake）。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { Context } from "@deepseek-ai/cordis"
import JobsLocal from "@deepseek-ai/dsh-jobs-local"
import { JobId } from "@deepseek-ai/dsh-jobs"
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess"
import { SDK_PYTHON_ENV, SDK_PYTHON_PACKAGE_PATH } from "../../lyapunov-product-bundle/src/sdk-python.mjs"
import {
  ENGINE_NAMES, ENGINE_PYTHON_ENV, ENGINE_PYTHON_PACKAGE_PATH, ENVIRONMENT_CONTRACT_TEST, ENVIRONMENT_DECLARATIONS,
  ENVIRONMENT_STATUS_LABEL, classifyGpu, environmentCode, environmentPanel, environmentRowWording,
  environmentRowById, evaluateEnvironment, featureEnvironmentVerdict, gpuRow, parseSmiCapacity, classifyGraphicsVendor,
  probeEngineRuntimes, probeGpuFacts, probeSdkImport, clearSdkImportCache, sdkInstalled, sitePackagesCandidates, smiFailureDetail, gpuRuntimeDecision, gpuRefusal,
  webglNotice, compactDriverVersion, type EngineRuntimeFacts, type EnvironmentFacts, type EnvironmentRow, type GpuFacts, type GpuState,
} from "../src/environment-readiness.ts"
import { createProviderInstaller, invalidateHostReadiness, ISAAC_EULA_URL, type EnvironmentGateMode } from "../src/provider-installer.ts"

const DRIVER_LINE = "NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  595.91.07  Release Build  (dvs-builder@U22-I3-B08-02-2)  Wed Jul 29 03:01:16 UTC 2026"
const SMI_OK = "NVIDIA GeForce RTX 5090 Laptop GPU, 24463, 1024"
const SMI_FAIL = "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver. Make sure that the latest NVIDIA driver is installed and running."

/** 本机 2026-09-26 的真实形态：驱动已注册且已挂载 GPU、PCI 上有卡，只有 /dev 里没有。 */
function gpuFacts(overrides: Partial<GpuFacts> = {}): GpuFacts {
  return {
    probeError: null, driverVersion: DRIVER_LINE, driverGpuEntries: ["0000:02:00.0"], deviceNodes: ["/dev/nvidia0"], deviceExtras: [],
    pciDevices: ["0000:02:00.0"], pciIds: ["0000:02:00.0 10de:2c58 class=0x030000"], driverGpuModels: ["0000:02:00.0 NVIDIA GeForce RTX 5090 Laptop GPU"],
    smi: { present: true, ok: true, output: SMI_OK, error: "" },
    capacity: { totalMiB: 24463, freeMiB: 23439 }, requiredVramMiB: null, minDriverMajor: null,
    ...overrides,
  }
}

const GPU_SHAPES: Record<GpuState, GpuFacts> = {
  ready: gpuFacts(),
  "no-device": gpuFacts({ driverVersion: null, driverGpuEntries: [], deviceNodes: [], pciDevices: [], pciIds: [], driverGpuModels: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } }),
  "driver-missing": gpuFacts({ driverVersion: null, driverGpuEntries: [], deviceNodes: [], driverGpuModels: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } }),
  "driver-broken": gpuFacts({ driverGpuEntries: [], pciDevices: [], pciIds: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } }),
  "device-hidden": gpuFacts({ deviceNodes: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } }),   // 本机形态：卡在、驱动挂载了、/dev 里没有字符设备
  "vram-insufficient": gpuFacts({ capacity: { totalMiB: 24463, freeMiB: 100 }, requiredVramMiB: 512 }),
  "driver-outdated": gpuFacts({ minDriverMajor: 600 }),
  // A1/A3（2026-09-26 验收实测的两条**反向误诊**）：这两条形态也进这张表，
  // 于是"读数两两不同"与"非就绪必须给得出处置"两条既有用例自动覆盖到它们。
  // 现场 A1：真容器 `--gpus all` 下设备 5 个字符节点全可见、驱动已注册，只因镜像里没有 nvidia-smi。
  "smi-missing": gpuFacts({ deviceNodes: ["/dev/nvidia0", "/dev/nvidiactl"], deviceExtras: ["/dev/nvidia-caps"], capacity: null, smi: { present: false, ok: false, output: "", error: "nvidia-smi 未安装", reason: "not-installed" } }),
  // 现场 A3：装了 nvidia 包但机器无卡/卡被摘——驱动在，PCI 与驱动挂载都没有卡。
  "card-unknown": gpuFacts({ driverGpuEntries: [], pciDevices: [], pciIds: [], driverGpuModels: [], deviceNodes: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } }),
  unknown: gpuFacts({ probeError: "readdirSync /proc/driver: EACCES" }),
}

function runtimeFacts(overrides: Partial<EngineRuntimeFacts> = {}, engine: EngineRuntimeFacts["engine"] = "mujoco"): EngineRuntimeFacts {
  return { engine, python: `/opt/${engine}/bin/python`, source: "package-default", interpreter: true, sdk: true, sitePackages: [`/opt/${engine}/lib/python3.12/site-packages`], ...overrides }
}

function facts(overrides: Partial<EnvironmentFacts> = {}): EnvironmentFacts {
  return {
    gpu: gpuFacts(), runtimes: ENGINE_NAMES.map(engine => runtimeFacts({}, engine)),
    graphics: { display: ":1", x11Socket: true, glxRenderer: "NVIDIA GeForce RTX 5090/PCIe/SSE2", glxAccelerated: true, probeError: null },
    serialDevices: [], micromamba: "/usr/local/bin/micromamba", network: { status: "ready", reading: "HTTP 200" }, quota: { status: "ready", reading: "已登录" },
    ...overrides,
  }
}

// ───────────────────────── N2：GPU 分型（四态 + 两个诚实补充态） ─────────────────────────

describe("vendor-neutral graphics renderer classification", () => {
  test("describes NVIDIA, AMD, Intel and software renderers without forcing a vendor", () => {
    expect(classifyGraphicsVendor("NVIDIA GeForce RTX 5090 Laptop GPU/PCIe/SSE2")).toBe("nvidia")
    expect(classifyGraphicsVendor("AMD Radeon RX 7900 XT (radeonsi, gfx1100)")).toBe("amd")
    expect(classifyGraphicsVendor("Mesa Intel(R) Graphics (ARL)")).toBe("intel")
    expect(classifyGraphicsVendor("llvmpipe (LLVM 15.0.7, 256 bits)")).toBe("software")
    expect(classifyGraphicsVendor(null)).toBe("unknown")
  })
})

describe("N2 · GPU 缺失/损坏分型与话术", () => {
  test("五种点名形态各自分到不同状态（不是“能用/不能用”两态）", () => {
    const states = Object.fromEntries(Object.entries(GPU_SHAPES).map(([name, shape]) => [name, classifyGpu(shape).state]))
    expect(states["ready"]).toBe("ready")
    expect(states["no-device"]).toBe("no-device")
    expect(states["driver-missing"]).toBe("driver-missing")
    expect(states["driver-broken"]).toBe("driver-broken")
    expect(states["device-hidden"]).toBe("device-hidden")
    expect(states["vram-insufficient"]).toBe("vram-insufficient")
    // 五种形态的读数必须**两两不同**——话术相同就等于没分型。
    const readings = Object.values(GPU_SHAPES).map(shape => classifyGpu(shape).reading)
    expect(new Set(readings).size).toBe(readings.length)
  })

  test("device-hidden：有卡有驱动但 /dev 不可见 → 带 uncertain，且读数明说“可能是误报”", () => {
    const classification = classifyGpu(GPU_SHAPES["device-hidden"])
    expect(classification.state).toBe("device-hidden")
    expect(classification.uncertain).toBe(true)
    expect(gpuRow(GPU_SHAPES["device-hidden"]).status).toBe("degraded")
    const wording = environmentRowWording(gpuRow(GPU_SHAPES["device-hidden"])).join("\n")
    expect(wording).toContain("可能是沙箱/容器误报")
    expect(wording).toContain("不得据此断言客户机坏了")
    // 处置必须指向"可见性"，不是"买卡/重装驱动"。
    expect(wording).toContain("--gpus all")
  })

  test("no-device 与 driver-missing/driver-broken 是三种不同处置（不得混成一句“GPU 不可用”）", () => {
    const noDevice = environmentRowWording(gpuRow(GPU_SHAPES["no-device"])).join("\n")
    const driverMissing = environmentRowWording(gpuRow(GPU_SHAPES["driver-missing"])).join("\n")
    const driverBroken = environmentRowWording(gpuRow(GPU_SHAPES["driver-broken"])).join("\n")
    expect(noDevice).toContain("lspci -nn")
    expect(driverMissing).toContain("ubuntu-drivers autoinstall")
    expect(driverMissing).toContain("必须重启")
    expect(driverBroken).toContain("dmesg | grep -i nvrm")
    expect(new Set([noDevice, driverMissing, driverBroken]).size).toBe(3)
  })

  test("显存不足与驱动过旧都算降级（卡是好的，只是这次用不了/版本不够）", () => {
    expect(gpuRow(GPU_SHAPES["vram-insufficient"]).status).toBe("degraded")
    expect(gpuRow(GPU_SHAPES["vram-insufficient"]).reading).toContain("可用显存")
    expect(gpuRow(GPU_SHAPES["driver-outdated"]).status).toBe("degraded")
    expect(gpuRow(GPU_SHAPES["driver-outdated"]).reading).toContain("最低 600")
    // 未声明最低版本时不判"过旧"（不凭空造要求）。
    expect(classifyGpu(gpuFacts({ minDriverMajor: null })).state).toBe("ready")
  })

  test("驱动不可用但又能启动 CPU 路径：每条 GPU 状态都给得出降级路径（绝不静默失败）", () => {
    for (const shape of Object.values(GPU_SHAPES)) {
      const row = gpuRow(shape)
      if (row.status === "ready") continue
      if (row.status === "unknown") {
        expect(row.degradation).toBeNull()
        expect(row.remedy.steps.length).toBeGreaterThan(0)
        continue
      }
      expect(row.degradation).not.toBeNull()
      expect(row.degradation!.restore.length).toBeGreaterThan(0)
    }
  })

  test("不确定话术下移到行数据：通用分支只说中性的那句，GPU 专属句子只出现在 GPU 行", () => {
    // GPU 行：自己的说明（含"可能是沙箱/容器误报"）来自行数据，不是话术函数。
    const gpu = gpuRow(GPU_SHAPES["device-hidden"])
    expect(gpu.uncertain).toBe(true)
    expect(gpu.uncertaintyNote).toContain("可能是沙箱/容器误报")
    expect(environmentRowWording(gpu).join("\n")).toContain("可能是沙箱/容器误报")

    // 别的行：无头会话下 gl.host / desktop 各自带自己的说明 → 出现的是它们自己的，不是 GPU 那句。
    const headless = environmentPanel(facts({ graphics: { display: null, x11Socket: false, glxRenderer: null, glxAccelerated: null, probeError: null } }))
    const glText = environmentRowWording(headless.rows.find(row => row.id === "gl.host")!).join("\n")
    expect(glText).not.toContain("可能是沙箱/容器误报")
    expect(glText).toContain("代表不了用户桌面的情况")
    const desktopRow = headless.rows.find(row => row.id === "desktop")!
    expect(desktopRow.uncertain).toBe(true)
    const desktopText = environmentRowWording(desktopRow).join("\n")
    expect(desktopText).toContain("不等于用户桌面没有显示")
    expect(desktopText).not.toContain("可能是沙箱/容器误报")

    // 完全没给说明 → 只出中性那句（既不放行也不武断）。
    const bare: EnvironmentRow = { ...gpu, uncertaintyNote: null }
    const bareText = environmentRowWording(bare).join("\n")
    expect(bareText).toContain("这个判定不确定")
    expect(bareText).not.toContain("可能是沙箱/容器误报")
  })

  test("unknown 绝不等于 ready：探不到就报 unknown 并给复核步骤", () => {
    const row = gpuRow(GPU_SHAPES.unknown)
    expect(row.status).toBe("unknown")
    expect(ENVIRONMENT_STATUS_LABEL[row.status]).toBe("未知")
    expect(environmentRowWording(row).join("\n")).toContain("未知不等于可用")
  })

  test("回归（本机实测）：/dev/nvidia-caps 这类目录不算“设备可见”，否则同一台机器会在两种话术间跳变", () => {
    // 实测：首次跑过 nvidia-smi 之后 /dev 里会多出 nvidia-caps 目录，而字符设备仍然没有。
    const withCaps = gpuFacts({ deviceNodes: [], deviceExtras: ["/dev/nvidia-caps"], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } })
    const classification = classifyGpu(withCaps)
    expect(classification.state).toBe("device-hidden")
    expect(classification.uncertain).toBe(true)
    expect(classification.evidence.join("\n")).toContain("不算设备可见")
    // 连续两次分类必须一致（不确定性来自宿主，不来自判据）。
    expect(classifyGpu(withCaps).state).toBe(classifyGpu(withCaps).state)
    // 真的有字符设备时才算"设备可见但驱动打不开"。
    const charNode = gpuFacts({ deviceExtras: ["/dev/nvidia-caps"], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } })
    expect(classifyGpu(charNode).state).toBe("driver-broken")
  })

  test("nvidia-smi 的失败原因取 stdout（实测它写在 stdout 而不是 stderr）", () => {
    expect(smiFailureDetail(GPU_SHAPES["device-hidden"])).toContain("couldn't communicate with the NVIDIA driver")
    expect(parseSmiCapacity("NVIDIA GeForce RTX 5090 Laptop GPU, 24463, 1024")).toEqual({ totalMiB: 24463, freeMiB: 23439 })
    expect(parseSmiCapacity("no numbers here")).toBeNull()
  })

  test("W21 四态必须分得开：无卡 / 驱动未加载 / 驱动已加载但设备不可见 / 设备可见但通信失败", () => {
    const shape = (overrides: Partial<GpuFacts>) => gpuFacts({ capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" }, ...overrides })
    const noCard = shape({ driverVersion: null, driverGpuEntries: [], deviceNodes: [], pciDevices: [], pciIds: [], driverGpuModels: [] })
    const noDriver = shape({ driverVersion: null, driverGpuEntries: [], deviceNodes: [], driverGpuModels: [] })
    const hidden = shape({ deviceNodes: [] })
    const commFail = shape({ deviceNodes: ["/dev/nvidia0"] })
    expect(classifyGpu(noCard).state).toBe("no-device")
    expect(classifyGpu(noDriver).state).toBe("driver-missing")
    expect(classifyGpu(hidden).state).toBe("device-hidden")
    expect(classifyGpu(commFail).state).toBe("driver-broken")
    // 四态的结论与处置**两两不同**（混成一句"GPU 不可用"就是这次要修的缺陷）。
    const headlines = [noCard, noDriver, hidden, commFail].map(facts => gpuRuntimeDecision(facts).headline)
    expect(new Set(headlines).size).toBe(4)
    const remedies = [noCard, noDriver, hidden, commFail].map(facts => gpuRuntimeDecision(facts).gpuRequired.remedy.summary)
    expect(new Set(remedies).size).toBe(4)
  })

  test("W21 device-hidden ≠ 没有 GPU：结论/处置只说“这个会话看不见设备”，绝不说“没有 GPU/GPU 不可用”", () => {
    const facts = gpuFacts({ deviceNodes: [], deviceExtras: ["/dev/nvidia-caps"], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } })
    const decision = gpuRuntimeDecision(facts)
    expect(decision.state).toBe("device-hidden")
    expect(decision.accelerator).toBe("session-hidden")          // 不是 absent、不是 broken
    expect(decision.accelerator).not.toBe("absent")
    const text = [decision.headline, ...decision.explanation, ...decision.gpuRequired.wording].join("\n")
    // 明确说"卡是好的、驱动是好的"，且把"看不见"与"没有"分开。
    expect(text).toContain("卡是好的、驱动是好的")
    expect(text).toContain("这个会话看不见设备")
    // 禁用词针对的是**诊断口吻**（"没有卡/没有驱动/GPU 不可用"），不是那句撇清用的"不是没有 GPU"：
    // 这两句话的处置完全不同，混用就是把问题推给用户。
    for (const forbidden of ["本机没有 NVIDIA 卡", "本机确实没有 NVIDIA 卡", "没有安装 NVIDIA 驱动", "GPU 不可用", "驱动已损坏"]) {
      expect(text).not.toContain(forbidden)
      expect(decision.headline).not.toContain(forbidden)
    }
    expect(text).toContain("不是没有 GPU")     // 必须**显式撇清**，而不是模棱两可
    expect(text).toContain("重装驱动")          // 但只出现在"不要重装驱动"里
    expect(text).toContain("**不要**重装驱动")
    // 处置只谈"让这个会话看见设备"。
    expect(text).toContain("--gpus all")
    expect(text).toContain("非沙箱会话")
  })

  test("W21 解释链完整：卡（PCI ID）→ 驱动（版本+型号）→ 设备（不可见）→ 结论 → 处置", () => {
    const facts = gpuFacts({ deviceNodes: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } })
    const { explanation } = classifyGpu(facts)
    expect(explanation).toHaveLength(5)
    expect(explanation[0]).toContain("0000:02:00.0 10de:2c58")          // 卡：可用 lspci -nn 对上的 ID
    expect(explanation[1]).toContain("595.91.07")                        // 驱动：版本
    expect(explanation[1]).toContain("NVIDIA GeForce RTX 5090 Laptop GPU") // 驱动认到的型号
    expect(explanation[2]).toContain("没有任何 nvidia* 字符设备")          // 设备：不可见
    expect(explanation[3]).toContain("这个会话看不见设备")                 // 结论
    expect(explanation[4]).toContain("--gpus all")                        // 处置
    // 链也进了面板行的证据（界面/安装器/doctor-env 都读它）。
    const row = gpuRow(facts)
    expect(row.evidence[0]).toContain("1. 卡：")
    expect(row.evidence[4]).toContain("5. 处置：")
  })

  test("W21 运行时决策：CPU 替代路径必须说清“在走什么、为什么、怎么改回”；需要 GPU 的能力明确拒绝", () => {
    const hidden = gpuRuntimeDecision(gpuFacts({ deviceNodes: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } }))
    expect(hidden.cpuFallback.allowed).toBe(true)
    expect(hidden.cpuFallback.reason).toContain("卡是好的")
    expect(hidden.cpuFallback.reason).toContain("这个会话看不见设备")
    expect(hidden.cpuFallback.restore).toContain("--gpus all")
    expect(hidden.gpuRequired.blocked).toBe(true)
    expect(hidden.gpuRequired.code).toBe("ENVIRONMENT_GPU_DEVICE_HIDDEN")
    expect(hidden.gpuRequired.wording.length).toBeGreaterThanOrEqual(4)
    // 就绪时不该拒绝、也不该说要走 CPU 替代。
    const ready = gpuRuntimeDecision(gpuFacts())
    expect(ready.accelerator).toBe("available")
    expect(ready.gpuRequired.blocked).toBe(false)
    expect(ready.gpuRequired.code).toBeNull()
    expect(ready.cpuFallback.reason).toContain("不需要走 CPU")
  })

  test("W21 抛错点适配器：需要 GPU 的能力拿到的是“设备不可见”的话，不是“GPU 不可用”", () => {
    const hidden = gpuRefusal("Isaac RTX 渲染", gpuFacts({ deviceNodes: [], deviceExtras: ["/dev/nvidia-caps"], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } }))!
    expect(hidden.code).toBe("ENVIRONMENT_GPU_DEVICE_HIDDEN")
    expect(hidden.message).toContain("这个会话看不见设备")
    expect(hidden.message).toContain("10de:2c58")           // 解释链带上了卡 ID
    expect(hidden.message).not.toContain("GPU 不可用")
    expect(hidden.message).not.toContain("本机没有 NVIDIA 卡")
    expect(hidden.wording.length).toBeGreaterThanOrEqual(4)
    // 真的没有卡时是**另一个**码与另一套处置。
    const absent = gpuRefusal("Isaac RTX 渲染", gpuFacts({ driverVersion: null, driverGpuEntries: [], deviceNodes: [], pciDevices: [], pciIds: [], driverGpuModels: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } }))!
    expect(absent.code).toBe("ENVIRONMENT_GPU_NO_DEVICE")
    expect(absent.code).not.toBe(hidden.code)
    expect(absent.message).toContain("确实没有 NVIDIA 卡")
    // 就绪时没有要拒绝的。
    expect(gpuRefusal("Isaac RTX 渲染", gpuFacts())).toBeNull()
  })

  test("W21 判据对“字段不全的 facts”免疫：少字段只让读数变少，不许把判定打成异常", () => {
    // 旧版本调用方或 JSON 反序列化可能没有 pciIds/driverGpuModels/deviceExtras：
    // 少字段只能让解释链少一环，绝不能抛异常（"环境缺东西"不许变成看不懂的崩溃）。
    const partial = { ...gpuFacts({ deviceNodes: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } }) } as GpuFacts
    delete (partial as { pciIds?: unknown }).pciIds
    delete (partial as { driverGpuModels?: unknown }).driverGpuModels
    delete (partial as { deviceExtras?: unknown }).deviceExtras
    const classification = classifyGpu(partial)
    expect(classification.state).toBe("device-hidden")
    expect(classification.explanation).toHaveLength(5)
    expect(classification.explanation[1]).toContain("595.91.07")     // 驱动版本仍在（不因缺字段而丢）
    expect(gpuRuntimeDecision(partial).gpuRequired.code).toBe("ENVIRONMENT_GPU_DEVICE_HIDDEN")
    expect(gpuRuntimeDecision(partial).fingerprint).toMatch(/^[0-9a-f]{16}$/)
  })

  test("W21 负对照：把设备可见性判定改回旧行为（任何 nvidia* 条目都算可见）必须给出**相反**结论", () => {
    // 本机实测：`/dev/nvidia-caps` 目录会在首次跑过 nvidia-smi 之后出现，而字符设备始终没有。
    const realShape = gpuFacts({ deviceNodes: [], deviceExtras: ["/dev/nvidia-caps"], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } })
    expect(classifyGpu(realShape).state).toBe("device-hidden")
    // 旧行为：把 extras 也当设备节点 → 判成"设备可见但通信失败"，话术与处置完全相反。
    const legacyVisible = classifyGpu({ ...realShape, deviceNodes: [...realShape.deviceNodes, ...realShape.deviceExtras] }).state
    expect(legacyVisible).toBe("driver-broken")
    expect(legacyVisible).not.toBe(classifyGpu(realShape).state)
    // 反向也钉住：真的有字符设备时，新判据仍必须给出 driver-broken（不是把 device-hidden 一刀切）。
    expect(classifyGpu({ ...realShape, deviceNodes: ["/dev/nvidia0"] }).state).toBe("driver-broken")
  })

  test("W21 判定稳定：四扰动下同一结论、同一指纹", () => {
    const facts = gpuFacts({ deviceNodes: [], deviceExtras: ["/dev/nvidia-caps"], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } })
    const baseline = gpuRuntimeDecision(facts)
    const shuffled: GpuFacts = { ...facts, pciDevices: [...facts.pciDevices].reverse(), pciIds: [...facts.pciIds].reverse(), driverGpuEntries: [...facts.driverGpuEntries].reverse(), driverGpuModels: [...facts.driverGpuModels].reverse(), deviceExtras: [...facts.deviceExtras].reverse() }
    const variants = [gpuRuntimeDecision({ ...facts }), gpuRuntimeDecision(shuffled), gpuRuntimeDecision({ ...facts, deviceExtras: [...facts.deviceExtras] }), gpuRuntimeDecision({ ...facts })]
    for (const variant of variants) {
      expect(variant.state).toBe(baseline.state)
      expect(variant.accelerator).toBe(baseline.accelerator)
      expect(variant.headline).toBe(baseline.headline)
      expect(variant.fingerprint).toBe(baseline.fingerprint)
    }
    expect(gpuRuntimeDecision(facts).fingerprint).toBe(baseline.fingerprint)
  })

  test("W21 真机读数（可复现的现场样本）：卡在 + 驱动在 + 设备不可见 ⇒ device-hidden", () => {
    const real = probeGpuFacts()
    const decision = gpuRuntimeDecision(real)
    // 现场样本的前置条件（本机 2026-09-26 实测满足；换一台设备可见的机器这段自动跳过，
    // 但下面的合成断言与负对照仍然钉住判据本身）。
    const liveShape = real.driverVersion !== null && real.driverGpuEntries.length > 0 && real.deviceNodes.length === 0
    if (liveShape) {
      expect(decision.state).toBe("device-hidden")
      expect(decision.accelerator).toBe("session-hidden")
      expect(decision.explanation[0]).toMatch(/10de:/)                 // 卡的可核对 ID
      expect(decision.explanation[1]).toContain(compactDriverVersion(real.driverVersion))
      expect(decision.explanation[3]).toContain("这个会话看不见设备")
      expect(decision.gpuRequired.code).toBe("ENVIRONMENT_GPU_DEVICE_HIDDEN")
    }
    // 无条件：解释链永远是五段，且结论与读数自洽。
    expect(decision.explanation).toHaveLength(5)
    expect(decision.explanation[3]).toContain("结论：")
    expect(decision.headline.length).toBeGreaterThan(0)
  })

  test("真实宿主探测：给出五项证据且不搬 GPU UUID/serial（面板会下发到浏览器）", () => {
    const real = probeGpuFacts()
    const classification = classifyGpu(real)
    expect([...Object.keys(GPU_SHAPES)]).toContain(classification.state)
    expect(classification.evidence.length).toBeGreaterThanOrEqual(5)
    expect(JSON.stringify(real)).not.toMatch(/GPU-[0-9a-f]{8}-[0-9a-f]{4}/)
    expect(JSON.stringify(classification.evidence)).not.toMatch(/[Ss]erial/)
  })

  /**
   * 顺序无关 **＋ 自造条目不进证据**（2026-09-26，两轮）—— 这条钉的是**探测既不能改变自己的读数，
   * 也不能把自己的产物当成"这台机器"的证据**。
   *
   * 现场（第一轮）：`nvidia-smi` 会在 `/dev` 里留下条目（本机实测：跑一次就凭空创建 `/dev/nvidia-caps`，
   * 即使它 exit 9 失败）。旧实现**先枚举 `/dev`、后跑 nvidia-smi** ⇒ 同一进程里
   * "第一次探测"与"之后的探测"对同一台机器给出不同的 `deviceExtras`：
   * 产品面板探一次、用例再探一次就得到两句不同的理由（`engine-panel-decision` 冷启动 4P/1F），
   * 而 release-gate 是**顺序 spawn** ⇒ 绿灯会依赖"前面哪个用例先跑过"。
   * 第一轮的修法是把有副作用的那一步排到读 `/dev` **之前** ⇒ 读数稳定了，**但首读照样把
   * `nvidia-smi` 刚造出来的 `nvidia-caps` 当成证据**（第二轮复核：新挂载的空 `/dev` 上首读就带它，
   * 而任何没跑过 `nvidia-smi` 的观察者看到的都是空 —— 同一台机器两句话，证据还不可被独立复现）。
   *
   * 现在的不变式是**两条，缺一不可**：
   *  ① 第 N 次探测的读数与第 1 次**逐字段相同**（不许是"探测被调用过几次"的函数）；
   *  ② 探测自己造出来的条目**既不进证据、也不留在盘上**（`deviceExtras` 里只有这台机器本来就有的东西）。
   *
   * 这里用注入替身**离线复现那个副作用**（不依赖本机有没有 GPU、也不依赖 /dev 可不可写）：
   * 替身每次被调用都会往注入的 devDir 里留下一个条目，正如真 nvidia-smi 所做。
   */
  test("探测顺序无关 + 自造条目不入证据：nvidia-smi 在 devDir 里留下的条目既不许进读数、也不许留在盘上", () => {
    const dir = mkdtempSync(join(tmpdir(), "lyapunov-gpu-probe-order-"))
    try {
      const devDir = join(dir, "dev")
      mkdirSync(devDir, { recursive: true })
      const artifact = join(devDir, "nvidia-caps")
      let calls = 0
      /** 真 nvidia-smi 的替身：**带副作用**（凭空多出一个 nvidia* 条目）+ 通信失败的读数。 */
      const smiProbe = (): GpuFacts["smi"] => {
        calls += 1
        mkdirSync(artifact, { recursive: true })
        return { present: true, ok: false, output: SMI_FAIL, error: "" }
      }
      const options = { devDir, procDriverDir: join(dir, "no-proc"), sysBusPciDir: join(dir, "no-sys"), smiProbe }
      const first = probeGpuFacts(options)
      const second = probeGpuFacts(options)
      expect(calls).toBe(2)
      expect(first).toEqual(second)                                             // ① 读数不是"第几次探测"的函数
      expect(first.deviceExtras).toEqual([])                                     // ② 自造条目不许进证据
      expect(existsSync(artifact)).toBe(false)                                   // ② 也不许留在盘上（探测不留痕）
      expect(first.deviceNodes).toEqual([])                                      // 目录不算"设备可见"
      // 判定面也必须稳定：同一个探测结果不允许在两次分型之间换话术。
      expect(gpuRuntimeDecision(second).fingerprint).toBe(gpuRuntimeDecision(first).fingerprint)
      expect(gpuRuntimeDecision(second).headline).toBe(gpuRuntimeDecision(first).headline)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  /**
   * 负对照（与上一条成对）：撤销**只**针对"本次窗口内新出现 + 是目录 + 空"的那一种。
   * 机器本来就有的条目（含**空**目录）、非空目录、普通文件一律照原样上报 ——
   * **不许为了让读数干净而去删真东西**；撤不掉的（这里用"非空"代表）也如实留在读数里，不藏。
   */
  test("撤销的边界：本来就有的条目与非空目录都不撤，且照实出现在读数里", () => {
    const dir = mkdtempSync(join(tmpdir(), "lyapunov-gpu-probe-undo-boundary-"))
    try {
      const devDir = join(dir, "dev")
      const preexisting = join(devDir, "nvidia-caps")            // 机器本来就有（非空：真驱动的能力节点）
      const preexistingEmpty = join(devDir, "nvidia-legacy")     // 机器本来就有（空目录）
      const plainFile = join(devDir, "nvidia-legacy-note")       // 机器本来就有（普通文件）
      mkdirSync(preexisting, { recursive: true })
      writeFileSync(join(preexisting, "cap0"), "")
      mkdirSync(preexistingEmpty, { recursive: true })
      writeFileSync(plainFile, "")
      const createdNonEmpty = join(devDir, "nvidia-smi-mempool") // 探测造出来的，但**非空** ⇒ 不敢动
      const createdEmpty = join(devDir, "nvidia-smi-scratch")    // 探测造出来的，空 ⇒ 唯一该被收回去的那种
      const smiProbe = (): GpuFacts["smi"] => {
        mkdirSync(createdNonEmpty, { recursive: true })
        writeFileSync(join(createdNonEmpty, "cap1"), "")
        mkdirSync(createdEmpty, { recursive: true })
        return { present: true, ok: false, output: SMI_FAIL, error: "" }
      }
      const facts = probeGpuFacts({ devDir, procDriverDir: join(dir, "no-proc"), sysBusPciDir: join(dir, "no-sys"), smiProbe })
      expect(facts.deviceExtras).toEqual([preexisting, preexistingEmpty, plainFile, createdNonEmpty].sort())
      for (const kept of [preexisting, preexistingEmpty, plainFile, createdNonEmpty]) expect(existsSync(kept)).toBe(true)
      expect(existsSync(createdEmpty)).toBe(false)
      expect(facts.deviceNodes).toEqual([])                      // 目录/文件都不算"设备可见"
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// ───────────────────────── N1：就绪面板（一屏） ─────────────────────────

describe("N1 · 环境就绪面板", () => {
  test("一屏覆盖 GPU/驱动、各引擎运行时、WebGL、网络、额度，每项都有状态+影响+处置", () => {
    const panel = environmentPanel(facts(), { generatedAt: "2026-09-26T00:00:00.000Z" })
    const ids = panel.rows.map(row => row.id)
    for (const required of ["gpu", "runtime.simulation", "runtime.mujoco", "runtime.isaac", "runtime.newton", "gl.host", "webgl", "network", "quota", "desktop", "device", "tool.micromamba"]) {
      expect(ids).toContain(required)
    }
    for (const row of panel.rows) {
      expect(row.impact.trim().length).toBeGreaterThan(0)
      expect(row.remedy.summary.trim().length).toBeGreaterThan(0)
      expect(row.contractTest.trim().length).toBeGreaterThan(0)
      expect(environmentRowWording(row).length).toBeGreaterThanOrEqual(4)
    }
    expect(panel.schema).toBe(1)
    expect(panel.overall).toBe("ready")
  })

  test("unknown 必须被显式列出（不留空），且不得把总评判成 ready", () => {
    const panel = environmentPanel(facts({ webgl: undefined, quota: undefined, network: undefined }))
    expect(panel.unknown).toEqual(["webgl", "network", "quota"])
    expect(panel.overall).toBe("degraded")
    for (const row of panel.rows.filter(candidate => candidate.status === "unknown")) {
      expect(row.reading.length).toBeGreaterThan(0)
      const wording = environmentRowWording(row).join("\n")
      expect(wording).toContain("未知不等于可用")
      expect(wording).toContain("怎么测清楚")
      expect(wording).toContain("既不放行、也不阻断")
    }
  })

  test("三个引擎一个都没装才叫 unusable；只缺个别引擎只是 degraded（不虚报整机不可用）", () => {
    const none = ENGINE_NAMES.map(engine => runtimeFacts({ interpreter: false, sdk: false }, engine))
    const unusable = environmentPanel(facts({ runtimes: none }))
    expect(unusable.overall).toBe("unusable")
    expect(environmentRowById(unusable, "runtime.simulation")!.status).toBe("missing")
    expect(environmentRowById(unusable, "runtime.simulation")!.remedy.steps.join("\n")).toContain("install-provider mujoco")
    const partial = environmentPanel(facts({ runtimes: [runtimeFacts(), runtimeFacts({ interpreter: false, sdk: false }, "isaac"), runtimeFacts({ interpreter: false, sdk: false }, "newton")] }))
    expect(partial.overall).toBe("degraded")
  })

  test("没插机器人/没登录额度不把整机判死（按需能力只登记，不进总评）", () => {
    const panel = environmentPanel(facts({ serialDevices: [], quota: { status: "missing", reading: "未充值" } }))
    expect(environmentRowById(panel, "device")!.scope).toBe("optional")
    expect(environmentRowById(panel, "quota")!.scope).toBe("optional")
    // 就绪 ≠ 全部能力都在：按需能力缺失只登记在 unavailable 与 summary 里。
    expect(panel.overall).toBe("ready")
    expect(panel.unavailable).toContain("device")
    expect(panel.unavailable).toContain("quota")
    expect(panel.summary).toContain("按需能力不可用")
  })

  test("宿主 GL 读数与浏览器 WebGL 是两行：宿主无头 ≠ 用户浏览器没有 WebGL", () => {
    const headless = environmentPanel(facts({ graphics: { display: null, x11Socket: false, glxRenderer: null, glxAccelerated: null, probeError: null } }))
    expect(environmentRowById(headless, "gl.host")!.status).toBe("unknown")
    expect(environmentRowById(headless, "gl.host")!.uncertain).toBe(true)
    expect(environmentRowById(headless, "webgl")!.status).toBe("unknown")
    const software = environmentPanel(facts({ graphics: { display: ":1", x11Socket: true, glxRenderer: "llvmpipe (LLVM 15.0.7, 256 bits)", glxAccelerated: false, probeError: null } }))
    expect(environmentRowById(software, "gl.host")!.status).toBe("degraded")
    expect(environmentRowById(software, "gl.host")!.reading).toContain("llvmpipe")
  })
})

// ───────────────────────── 引擎运行时三态（空壳 venv 不算装好） ─────────────────────────

describe("引擎运行时三态", () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  function fakeRuntime(engine: string, sitePackages: boolean, installed: boolean): string {
    const root = mkdtempSync(join(tmpdir(), "w14-runtime-"))
    roots.push(root)
    const python = join(root, "bin", "python")
    mkdirSync(join(root, "bin"), { recursive: true })
    writeFileSync(python, "# fake\n")
    if (sitePackages) {
      const directory = join(root, "lib", "python3.12", "site-packages")
      mkdirSync(directory, { recursive: true })
      // 复核点 4 起：安装候选只认**顶层包目录/模块文件**，孤立 dist-info 不算。
      if (installed) {
        mkdirSync(join(directory, engine), { recursive: true })
        mkdirSync(join(directory, `${engine}-1.0.0.dist-info`), { recursive: true })
      }
    }
    return python
  }

  test("解释器在但 SDK 不在 = broken（空壳 venv 的实测教训），不是 ready", () => {
    const shell = fakeRuntime("isaacsim", true, false)
    expect(sitePackagesCandidates(shell).some(directory => directory.includes("site-packages"))).toBe(true)
    expect(sdkInstalled(sitePackagesCandidates(shell), "isaacsim")).toBe(false)
    const runtimes = probeEngineRuntimes("/nonexistent", { LYAPUNOV_ISAAC_PYTHON: shell } as NodeJS.ProcessEnv)
    const isaac = runtimes.find(runtime => runtime.engine === "isaac")!
    expect(isaac.source).toBe("env-override")
    expect(isaac.interpreter).toBe(true)
    expect(isaac.sdk).toBe(false)
    const row = environmentRowById(environmentPanel(facts({ runtimes })), "runtime.isaac")!
    expect(row.status).toBe("broken")
    expect(row.state).toBe("isaac:empty-interpreter")
    expect(environmentRowWording(row).join("\n")).toContain("装了一半")
  })

  test("装好 = ready；不存在 = missing 并给出安装命令", () => {
    const installed = fakeRuntime("isaacsim", true, true)
    expect(sdkInstalled(sitePackagesCandidates(installed), "isaacsim")).toBe(true)
    const panel = environmentPanel(facts({ runtimes: probeEngineRuntimes("/nonexistent", { LYAPUNOV_ISAAC_PYTHON: installed } as NodeJS.ProcessEnv) }))
    expect(environmentRowById(panel, "runtime.isaac")!.status).toBe("ready")
    const missing = environmentPanel(facts({ runtimes: probeEngineRuntimes("/nonexistent", {} as NodeJS.ProcessEnv) }))
    expect(environmentRowById(missing, "runtime.isaac")!.status).toBe("missing")
    expect(environmentRowById(missing, "runtime.isaac")!.remedy.steps.join("\n")).toContain("install-provider isaac")
  })

  test("解释器落点与环境变量名和 sdk-python.mjs 的契约逐字一致（防两处漂移）", () => {
    for (const engine of ENGINE_NAMES) {
      expect(ENGINE_PYTHON_ENV[engine]).toBe(SDK_PYTHON_ENV[engine])
      expect(ENGINE_PYTHON_PACKAGE_PATH[engine]).toBe(SDK_PYTHON_PACKAGE_PATH[engine])
    }
  })

  // ── 复核点 4：安装候选 vs 解释器发现核对（两格分开；孤立 dist-info 不算；探测缓存复用） ──
  test("SDK 安装候选只认顶层包/模块：孤立 dist-info（包目录已被清理）不算", () => {
    const root = mkdtempSync(join(tmpdir(), "w14-orphan-"))
    roots.push(root)
    const python = join(root, "bin", "python")
    mkdirSync(join(root, "bin"), { recursive: true })
    writeFileSync(python, "# fake\n")
    const directory = join(root, "lib", "python3.12", "site-packages")
    mkdirSync(join(directory, "isaacsim-6.0.1.0.dist-info"), { recursive: true })
    expect(sdkInstalled(sitePackagesCandidates(python), "isaacsim")).toBe(false)
    // 顶层包目录出现后才算命中。
    mkdirSync(join(directory, "isaacsim"), { recursive: true })
    expect(sdkInstalled(sitePackagesCandidates(python), "isaacsim")).toBe(true)
  })

  test("轻量发现探测：解释器能发现=importable、找不到=missing、跑不起来=unavailable（不 import 重 SDK）", () => {
    const root = mkdtempSync(join(tmpdir(), "w14-probe-"))
    roots.push(root)
    const stub = join(root, "python-found")
    writeFileSync(stub, "#!/bin/sh\necho SDK_PROBE_FOUND\nexit 0\n", { mode: 0o755 })
    chmodSync(stub, 0o755)
    const missingStub = join(root, "python-missing")
    writeFileSync(missingStub, "#!/bin/sh\necho SDK_PROBE_MISSING\nexit 3\n", { mode: 0o755 })
    chmodSync(missingStub, 0o755)
    const shell = join(root, "python-shell")
    writeFileSync(shell, "# 不可执行\n")

    clearSdkImportCache()
    expect(probeSdkImport(stub, "isaacsim").state).toBe("importable")
    clearSdkImportCache()
    expect(probeSdkImport(missingStub, "isaacsim").state).toBe("missing")
    clearSdkImportCache()
    const unavailable = probeSdkImport(shell, "isaacsim")
    expect(unavailable.state).toBe("unavailable")
    expect(unavailable.detail).toContain("无法运行解释器核对")
    // 缓存复用：同一事实重复探仍稳定（产品路径不在每次设置页刷新时重复起子进程）。
    clearSdkImportCache()
    expect(probeSdkImport(stub, "isaacsim").state).toBe("importable")
  })
})

// ───────────────────────── N4/D2/D3：声明 → 统一判定 ─────────────────────────

describe("N4 · 声明式环境依赖契约（D2/D3）", () => {
  test("就绪 → ready；未知 → degraded（unknown ≠ ready，既不阻断也不放行）", () => {
    expect(evaluateEnvironment({ feature: "t", label: "T", requires: [{ id: "gpu", mode: "required" }] }, environmentPanel(facts())).status).toBe("ready")
    const unknown = evaluateEnvironment({ feature: "t", label: "T", requires: [{ id: "webgl", mode: "required" }] }, environmentPanel(facts({ webgl: undefined })))
    expect(unknown.status).toBe("degraded")
    expect(unknown.code).toBe("ENVIRONMENT_WEBGL_UNREPORTED")
  })

  test("D2：有降级路径就走降级，并把“在走什么/怎么改回”讲出来", () => {
    const panel = environmentPanel(facts({ gpu: GPU_SHAPES["device-hidden"] }))
    const verdict = evaluateEnvironment({ feature: "t", label: "Isaac CPU", requires: [{ id: "gpu", mode: "required" }] }, panel)
    expect(verdict.status).toBe("degraded")
    const text = verdict.wording.join("\n")
    expect(text).toContain("降级运行")
    expect(text).toContain("已在走这条路")
    expect(text).toContain("怎么改回")
  })

  test("D3：无替代路径 → blocked + 稳定错误码 + 可执行的下一步（不是“环境有问题”）", () => {
    const panel = environmentPanel(facts({ gpu: GPU_SHAPES["no-device"] }))
    const verdict = evaluateEnvironment({ feature: "rtx", label: "RTX 渲染", requires: [{ id: "gpu", mode: "required", degradation: null }] }, panel)
    expect(verdict.status).toBe("blocked")
    if (verdict.status !== "blocked") throw new Error("unreachable")
    expect(verdict.code).toBe("ENVIRONMENT_GPU_NO_DEVICE")
    expect(verdict.remedy.steps.length).toBeGreaterThan(0)
    expect(verdict.wording.join("\n")).toContain("无替代路径")
    expect(verdict.wording.join("\n")).toContain("不会静默留空")
  })

  test("preferred 永不阻断：缺了只是覆盖变差（Newton 无 CUDA 自动退 cpu 的既有行为）", () => {
    const panel = environmentPanel(facts({ gpu: GPU_SHAPES["no-device"] }))
    const verdict = evaluateEnvironment({ feature: "newton", label: "Newton", requires: [{ id: "gpu", mode: "preferred", degradation: null }] }, panel)
    expect(verdict.status).toBe("degraded")
  })

  test("声明了面板里没有的依赖 = 契约漂移，fail-closed 报出来", () => {
    const verdict = evaluateEnvironment({ feature: "x", label: "X", requires: [{ id: "quantum-gpu", mode: "required" }] }, environmentPanel(facts()))
    expect(verdict.status).toBe("blocked")
    expect(verdict.status === "blocked" && verdict.code).toBe("ENVIRONMENT_DEPENDENCY_NOT_DECLARED:quantum-gpu")
  })

  test("内置声明表自洽：每条依赖都能在面板里找到行，判定三态齐全", () => {
    const panel = environmentPanel(facts({ gpu: GPU_SHAPES["no-device"], micromamba: null, webgl: { status: "broken", reading: "WebGL 上下文创建失败：VIEWER_WEBGL_UNAVAILABLE" }, serialDevices: [] }))
    const verdicts = ENVIRONMENT_DECLARATIONS.map(declaration => evaluateEnvironment(declaration, panel))
    expect(verdicts.every(verdict => ["ready", "degraded", "blocked"].includes(verdict.status))).toBe(true)
    expect(verdicts.some(verdict => verdict.status === "ready")).toBe(true)
    expect(verdicts.some(verdict => verdict.status === "degraded")).toBe(true)
    expect(verdicts.some(verdict => verdict.status === "blocked")).toBe(true)
    for (const declaration of ENVIRONMENT_DECLARATIONS) {
      for (const requirement of declaration.requires) expect(environmentRowById(panel, requirement.id)).toBeDefined()
    }
  })

  test("DEV-039 契约侧：WebGL 未上报=降级；浏览器报创建失败=明确拒绝 + 建议", () => {
    const unreported = featureEnvironmentVerdict("preview.webgl", environmentPanel(facts({ webgl: undefined })))
    expect(unreported.status).toBe("degraded")
    const broken = featureEnvironmentVerdict("preview.webgl", environmentPanel(facts({ webgl: { status: "broken", reading: "WebGL 上下文创建失败：VIEWER_WEBGL_UNAVAILABLE（浏览器上报）" } })))
    expect(broken.status).toBe("blocked")
    if (broken.status !== "blocked") throw new Error("unreachable")
    expect(broken.code).toBe("ENVIRONMENT_WEBGL_BROKEN")
    const text = broken.wording.join("\n")
    expect(text).toContain("硬件加速")
    expect(text).toContain("绝不静默留空")
  })

  test("W11 接口：webglNotice 把浏览器上报直接变成状态+错误码+四句话（呈现侧不必自己造句）", () => {
    const broken = webglNotice({ status: "broken", reading: "WebGL 上下文创建失败：VIEWER_WEBGL_UNAVAILABLE（Chrome 上报）", evidence: ["VIEWER_WEBGL_UNAVAILABLE"] })
    expect(broken.status).toBe("broken")
    expect(broken.code).toBe("ENVIRONMENT_WEBGL_BROKEN")
    expect(broken.wording.length).toBeGreaterThanOrEqual(4)
    expect(broken.wording.join("\n")).toContain("硬件加速")
    expect(broken.remedy.steps.length).toBeGreaterThan(0)
    const unreported = webglNotice({ status: "unknown", reading: "尚未上报" })
    expect(unreported.code).toBe("ENVIRONMENT_WEBGL_UNREPORTED")
    expect(unreported.wording.join("\n")).toContain("怎么测清楚")
  })

  test("真机与付费额度按 D3 拒绝（仿真不能替代真机；验收不自动授权支付）", () => {
    const panel = environmentPanel(facts({ serialDevices: [], quota: { status: "missing", reading: "额度耗尽" } }))
    expect(featureEnvironmentVerdict("robot.real", panel).status).toBe("blocked")
    expect(featureEnvironmentVerdict("generate.paid", panel).status).toBe("blocked")
  })

  test("错误码稳定且可 grep：ENVIRONMENT_<依赖>_<细分态>", () => {
    expect(environmentCode("gpu", "device-hidden", "degraded")).toBe("ENVIRONMENT_GPU_DEVICE_HIDDEN")
    expect(environmentCode("tool.micromamba", "absent", "missing")).toBe("ENVIRONMENT_TOOL_MICROMAMBA_ABSENT")
    expect(ENVIRONMENT_CONTRACT_TEST).toBe("packages/lyapunov-shell/test/environment-readiness.test.ts")
  })
})

// ───────────────────────── N3：Provider 安装期前置检查 ─────────────────────────

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

/** 离线假子进程：本文件不启动任何真实进程（D4 的"环境缺失"路径在 strict 下根本不 spawn）。 */
function fakeProcess() {
  const exit = deferred<SubprocessOutcome>()
  const range = deferred<boolean>()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let terminations = 0
  const handle: SubprocessHandle = {
    stdin: undefined, stdout, stderr, control: undefined, collected: {}, done: exit.promise,
    terminate() { terminations++ }, waitForExit() { return range.promise },
  }
  return {
    handle, get terminations() { return terminations },
    finish(exitCode: number | null = 0) { stdout.write('{"status":"OK"}\n'); stdout.end(); stderr.end(); exit.resolve({ exitCode, signal: null }); range.resolve(true) },
  }
}

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

async function harness(input: { mode?: EnvironmentGateMode; panel?: ReturnType<typeof environmentPanel>; script?: boolean; accept?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "w14-installer-"))
  const scriptPath = join(directory, "installer fixture.sh")
  writeFileSync(scriptPath, "# offline fixture; never executed for real\n")
  const ctx = new Context()
  const jobsFiber = await ctx.plugin(JobsLocal)
  const detach = ctx.jobs.attachController("w14-env-tests")
  const processes: ReturnType<typeof fakeProcess>[] = []
  const spawns: SubprocessSpawnSpec[] = []
  let acceptance = input.accept ? { acceptedAt: "2026-09-26T00:00:00.000Z", eulaUrl: ISAAC_EULA_URL } : undefined
  let readinessCalls = 0
  const installer = createProviderInstaller({
    root: join(directory, "attempts"), cwd: directory, scriptPath, env: { LYAPUNOV_MICROMAMBA: "/missing/micromamba" },
    jobs: ctx.jobs, subprocess: { spawn(spec: SubprocessSpawnSpec) { spawns.push(spec); const process = fakeProcess(); processes.push(process); return process.handle } },
    readLicense: () => acceptance,
    readinessTtlMs: 0,
    ...(input.mode === undefined ? {} : { environmentGate: input.mode }),
    ...(input.panel === undefined ? {} : { readiness: () => { readinessCalls++; return input.panel! } }),
  })
  cleanup.push(async () => {
    for (const process of processes) process.finish(0)
    await installer.dispose()
    detach()
    await jobsFiber.dispose()
    invalidateHostReadiness()
    rmSync(directory, { recursive: true, force: true })
  })
  return { installer, spawns, processes, directory, get readinessCalls() { return readinessCalls }, setLicense(value: typeof acceptance) { acceptance = value } }
}

describe("N3 · 安装前置检查（provider-installer）", () => {
  const ready = environmentPanel(facts())
  const degradedNoGpu = environmentPanel(facts({ gpu: GPU_SHAPES["device-hidden"] }))
  const missingTool = environmentPanel(facts({ micromamba: null, gpu: GPU_SHAPES["device-hidden"] }))

  test("state() 每个 Provider 都带同一份就绪面板 + 本 Provider 的前置核对（界面不需要新端点）", async () => {
    const h = await harness({ panel: ready })
    const isaac = h.installer.state("isaac")
    expect(isaac.readiness.panel.rows.length).toBeGreaterThanOrEqual(10)
    expect(isaac.readiness.gate.rows.map(row => row.id)).toContain("gpu")
    expect(isaac.readiness.gate.rows.map(row => row.id)).toContain("tool.micromamba")
    expect(h.installer.state("mujoco").readiness.panel.schema).toBe(1)
    expect(h.installer.state("newton").readiness.gate.provider).toBe("newton")
  })

  test("N3 正文：装 Isaac 前说明“没有 GPU 会怎样”，默认只报不拦", async () => {
    const h = await harness({ panel: degradedNoGpu, accept: true })
    const dry = h.installer.dryRun("isaac", true)
    expect(dry.wouldStart).toBe(true)
    expect(dry.code).toBeNull()
    expect(dry.readiness.gate.status).toBe("degraded")
    expect(dry.readiness.gate.rejects).toBe(false)
    expect(dry.readiness.gate.code).toBe("ENVIRONMENT_GPU_DEVICE_HIDDEN")
    const text = dry.readiness.gate.wording.join("\n")
    expect(text).toContain("纯 CPU")
    expect(text).toContain("RTX/CUDA")
  })

  test("默认（advisory）在缺前置时仍然发起安装，但把降级理由记进回执", async () => {
    const h = await harness({ panel: missingTool })
    const started = h.installer.start("mujoco", false)
    await flush()
    expect(h.spawns).toHaveLength(1)
    expect(started.status).not.toBe("blocked")
    const recorded = h.installer.receipts()[0]!.environment!
    expect(recorded.status).toBe("blocked")
    expect(recorded.rejected).toBe(false)
    expect(recorded.code).toBe("ENVIRONMENT_TOOL_MICROMAMBA_ABSENT")
    expect(recorded.rows.map(row => row.id)).toContain("tool.micromamba")
    expect(h.installer.state("mujoco").readiness.attempt?.code).toBe("ENVIRONMENT_TOOL_MICROMAMBA_ABSENT")
    h.processes[0]!.finish()
  })

  test("strict：无替代路径的前置缺失 → 明确拒绝（错误码 + 处置），且不产生任何进程", async () => {
    const h = await harness({ mode: "strict", panel: missingTool })
    const dry = h.installer.dryRun("mujoco", false)
    expect(dry.wouldStart).toBe(false)
    expect(dry.code).toBe("ENVIRONMENT_TOOL_MICROMAMBA_ABSENT")
    const start = h.installer.start("mujoco", false)
    expect(start.status).toBe("blocked")
    expect(start.result?.code).toBe("ENVIRONMENT_TOOL_MICROMAMBA_ABSENT")
    expect(start.result?.status).toBe("BLOCKED")
    expect(h.spawns).toHaveLength(0)
    expect(h.installer.receipts()[0]!.environment?.rejected).toBe(true)
    expect(h.installer.state("mujoco").readiness.gate.rejects).toBe(true)
  })

  test("strict 但环境就绪时照常安装（拒绝只发生在无替代路径那一项）", async () => {
    const h = await harness({ mode: "strict", panel: ready })
    const started = h.installer.start("newton", false)
    expect(started.status).not.toBe("blocked")
    await flush()
    expect(h.spawns).toHaveLength(1)
    expect(h.installer.receipts()[0]!.environment?.status).toBe("ready")
    expect(h.installer.receipts()[0]!.environment?.rejected).toBe(false)
    h.processes[0]!.finish()
  })

  test("许可检查仍先于环境门禁（Isaac 未接受 EULA 时给的是 LICENSE_CONFIRMATION_REQUIRED）", async () => {
    const h = await harness({ mode: "strict", panel: missingTool })
    const started = h.installer.start("isaac", true)
    expect(started.status).toBe("blocked")
    expect(started.result?.code).toBe("LICENSE_CONFIRMATION_REQUIRED")
    expect(h.spawns).toHaveLength(0)
  })

  test("回执里的环境记录 fail-closed：写坏了就必须报错，不能静默读成“没有记录”", async () => {
    const h = await harness({ panel: ready })
    const started = h.installer.start("mujoco", false)
    await flush()
    h.processes[0]!.finish()
    await ctx_jobs_wait(h)
    const receiptPath = started.receiptPath!
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>
    receipt.environment = { at: "not a number", mode: "loose", status: "maybe", rows: "nope" }
    writeFileSync(receiptPath, JSON.stringify(receipt))
    expect(() => h.installer.receipts()).toThrow("INSTALL_RECEIPT_INVALID")
  })

  test("注入的读数被真正使用（宿主读数是可替代的依赖，不是写死的全局）", async () => {
    const h = await harness({ panel: ready })
    h.installer.state("mujoco")
    expect(h.readinessCalls).toBeGreaterThan(0)
  })
})

/** 等安装 Job 收尾（回执里才有 environment 记录）。 */
async function ctx_jobs_wait(h: { installer: ReturnType<typeof createProviderInstaller>; processes: ReturnType<typeof fakeProcess>[] }): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (h.installer.receipts()[0]?.status === "completed" || h.installer.receipts()[0]?.status === "failed") return
    await flush()
  }
}
