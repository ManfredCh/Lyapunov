/**
 * DEV-001／DEV-002 回归：**所有启动入口共用同一份引擎解析**，且缺省/自动模式 Isaac 优先（SDK+许可+GPU）、
 * 缺任何一项才回退 MuJoCo。
 *
 * 这两条缺陷的原始事实是"四个入口各自写死默认（mujoco／none／mujoco）且不读偏好"，
 * 修好后唯一 owner 是 `script/engine-preference.ts` 的 `resolveEngine()`：
 *   显式参数 > `LYAPUNOV_SIM_ENGINE` > 用户偏好 > `defaultEngine()`。
 *
 * 本文件钉住"可从一门复算"：
 *  ① 自动判定只在 **SDK 就绪 + 许可留痕 + GPU 可用** 三项同时具备时选 isaac，否则回退 mujoco 并点名缺项；
 *  ② 优先级四层与 `source` 标签一致，非法显式值明确报错（不静默回退成默认）；
 *  ③ 终端入口的 `none` 是**有意的"不装配"默认**（帮助文本已声明），但在显式/环境/偏好三层必须与
 *     `resolveEngine` 给出同一结论——入口之间的差异只允许出现在"都没配置"这一层。
 *
 * 运行：`bun test packages/sim-isaac/test/engine-selection-consistency.test.ts`
 * 这里**不启动任何引擎**（不拉 Kit/MuJoCo 进程），GPU/许可/运行时都用**合成事实注入**（不碰本机
 * nvidia-smi、不要求真机有卡）——因此它证明的是**判定与理由**，不等于"真实 Isaac 能打开世界"；
 * 真实进程与页面读回证据在回执 `bugfixHistory/DEV001-002-ENGINE-CONSISTENCY-20260922.md` 与后续验收里。
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { ENGINE_CHOICES, defaultEngine, resolveEngine } from "../../../script/engine-preference.ts"
import { gpuRuntimeDecision, type GpuFacts } from "../../lyapunov-shell/src/environment-readiness.ts"
import { terminalEngineChoice } from "../../../script/terminal-options.ts"

const PRODUCT_ROOT = resolve(import.meta.dirname, "../../..")
/** 每个用例一个隔离的偏好文件：绝不动用户主目录下的 `~/.config/lyapunov/engine.json`。 */
function isolatedEnv(engine?: string): NodeJS.ProcessEnv {
  const file = join(mkdtempSync(join(tmpdir(), "n44-engine-")), "engine.json")
  if (engine !== undefined) writeFileSync(file, JSON.stringify({ engine }))
  return { LYAPUNOV_ENGINE_PREFERENCE_FILE: file }
}

/** 合成 GPU 事实（本文件不探测真机）；ready 是"卡、驱动、设备、显存都可用"，hidden 是本机那种会话隐藏形态。 */
const SMI_OK = "NVIDIA GeForce RTX 5090 Laptop GPU, 24463, 1024"
const SMI_FAIL = "NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver."
const gpuFacts = (overrides: Partial<GpuFacts> = {}): GpuFacts => ({
  probeError: null,
  driverVersion: "NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  595.91.07  Release Build",
  driverGpuEntries: ["0000:02:00.0"], deviceNodes: ["/dev/nvidia0"], deviceExtras: [],
  pciDevices: ["0000:02:00.0"], pciIds: ["0000:02:00.0 10de:2c58 class=0x030000"], driverGpuModels: [],
  smi: { present: true, ok: true, output: SMI_OK, error: "" },
  capacity: { totalMiB: 24463, freeMiB: 23439 }, requiredVramMiB: null, minDriverMajor: null,
  ...overrides,
})
const GPU_READY = gpuRuntimeDecision(gpuFacts())
const GPU_HIDDEN = gpuRuntimeDecision(gpuFacts({ deviceNodes: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: "" } }))
/** 三项条件都具备（自动判定的目标态）；`mujocoRuntime` 固定注入以免断言随开发机是否装过 MuJoCo 漂移。 */
const ISAAC_READY = { isaacRuntime: true, isaacLicense: true, gpu: GPU_READY, mujocoRuntime: false } as const

describe("DEV-001 默认引擎：Isaac 优先（SDK+许可+GPU），缺项才回退（可从一门复算）", () => {
  test("三项都具备时默认 isaac；reason 写明判据；候选清单 isaac=ready", () => {
    const decision = defaultEngine(PRODUCT_ROOT, isolatedEnv(), ISAAC_READY)
    expect(decision.engine).toBe("isaac")
    // reason 必须是可复算的判据（含解释器落点 + 三项事实），不是一句"默认"。
    expect(decision.reason).toContain(".runtime/conda/envs/isaac/bin/python")
    expect(decision.reason).toContain("运行时就位")
    expect(decision.reason).toContain("许可已接受")
    expect(decision.reason).toContain("GPU 加速器可用")
    // 复核点 5：GPU 一格只报"加速器可用"，理由里必须同时标明检测范围，不冒充 RTX 就绪。
    expect(decision.reason).toContain("未核 Isaac RTX 兼容")

    const viaResolve = resolveEngine({ productRoot: PRODUCT_ROOT, env: isolatedEnv(), auto: ISAAC_READY })
    expect(viaResolve.engine).toBe(decision.engine)
    expect(viaResolve.source).toBe("default")
    expect(viaResolve.reason).toBe(decision.reason)
    const isaacAssessment = viaResolve.auto?.candidates.find(row => row.engine === "isaac")
    expect(isaacAssessment?.ready).toBe(true)
    expect(isaacAssessment?.scope).toContain("检测范围")
    expect(viaResolve.auto?.candidates.find(row => row.engine === "mujoco")?.ready).toBe(false)
  })

  test("缺 GPU / 许可 / SDK 任一项都回退 mujoco，且理由点名缺的是哪一项", () => {
    const noGpu = defaultEngine(PRODUCT_ROOT, isolatedEnv(), { ...ISAAC_READY, gpu: GPU_HIDDEN })
    expect(noGpu.engine).toBe("mujoco")
    expect(noGpu.reason).toContain("GPU 未确认可用")
    expect(noGpu.candidates.find(row => row.engine === "isaac")?.blockers.join(" ")).toContain("GPU 未确认可用")

    const noLicense = defaultEngine(PRODUCT_ROOT, isolatedEnv(), { ...ISAAC_READY, isaacLicense: false })
    expect(noLicense.engine).toBe("mujoco")
    expect(noLicense.reason).toContain("许可未接受")
    expect(noLicense.reason).toContain("accept-omniverse-eula")

    const noSdk = defaultEngine(PRODUCT_ROOT, isolatedEnv(), { ...ISAAC_READY, isaacRuntime: false })
    expect(noSdk.engine).toBe("mujoco")
    expect(noSdk.reason).toContain("Isaac 运行时未就绪")
    expect(noSdk.reason).toContain("回退 mujoco")
    // 复核点 2：不再写"装好任一引擎后自动改回 isaac"；只有 Isaac 条件补齐且仍为自动时下次启动才优先。
    expect(noSdk.reason).toContain("下次启动才会优先 isaac")
    expect(noSdk.reason).not.toContain("装好后自动改回 isaac")
  })

  test("显式/环境/偏好三层绝不被自动判定替换（显式 isaac 即使条件不满足也保持）", () => {
    // 自动条件全不满足时，显式值仍是用户意图，交给运行期按真实错误报。
    expect(resolveEngine({ explicit: "isaac", productRoot: PRODUCT_ROOT, env: isolatedEnv(), auto: { ...ISAAC_READY, isaacRuntime: false, isaacLicense: false, gpu: GPU_HIDDEN } }))
      .toMatchObject({ engine: "isaac", source: "explicit" })
    expect(resolveEngine({ explicit: "mujoco", productRoot: PRODUCT_ROOT, env: isolatedEnv(), auto: ISAAC_READY }))
      .toMatchObject({ engine: "mujoco", source: "explicit" })
    expect(resolveEngine({ productRoot: PRODUCT_ROOT, env: { ...isolatedEnv("newton"), LYAPUNOV_SIM_ENGINE: "mujoco" }, auto: ISAAC_READY }))
      .toMatchObject({ engine: "mujoco", source: "environment" })
    expect(resolveEngine({ productRoot: PRODUCT_ROOT, env: isolatedEnv("newton"), auto: ISAAC_READY }))
      .toMatchObject({ engine: "newton", source: "preference" })
    // 空白环境变量等于没配（旧入口用 `||` 跳过它），不能被当成非法值卡住启动。
    expect(resolveEngine({ productRoot: PRODUCT_ROOT, env: { ...isolatedEnv(), LYAPUNOV_SIM_ENGINE: "   " }, auto: ISAAC_READY }).source).toBe("default")
  })

  test("非法显式值明确报错，不静默回退成默认；可选引擎表不变", () => {
    expect(() => resolveEngine({ explicit: "triton", productRoot: PRODUCT_ROOT, env: isolatedEnv() })).toThrow(/未知 Provider：triton/)
    expect(() => resolveEngine({ env: { ...isolatedEnv(), LYAPUNOV_SIM_ENGINE: "triton" }, productRoot: PRODUCT_ROOT })).toThrow(/未知 Provider：triton/)
    expect(ENGINE_CHOICES).toEqual(["isaac", "newton", "mujoco", "none", "benchmark"])
  })
})

describe("入口一致：终端与共享解析只在“都没配置”那一层允许不同", () => {
  test("显式/环境/偏好三层，终端与 resolveEngine 给出同一引擎", () => {
    const env = { ...isolatedEnv("newton"), LYAPUNOV_SIM_ENGINE: "mujoco" }
    expect(terminalEngineChoice("benchmark" as never, env).engine).toBe(resolveEngine({ explicit: "benchmark", env, productRoot: PRODUCT_ROOT }).engine)
    expect(terminalEngineChoice(undefined, env).engine).toBe(resolveEngine({ env, productRoot: PRODUCT_ROOT }).engine)
    expect(terminalEngineChoice(undefined, isolatedEnv("newton")).engine).toBe(resolveEngine({ env: isolatedEnv("newton"), productRoot: PRODUCT_ROOT }).engine)
  })

  test("都没配置时：终端是有意的“不装配”（none），其余入口走 Isaac 优先默认", () => {
    // `script/terminal.ts:19` 的帮助文本已经声明"本地引擎默认 none（不装配仿真）"——这是入口语义，不是偷偷换默认。
    expect(terminalEngineChoice(undefined, isolatedEnv())).toEqual({ engine: "none", source: "default" })
    expect(resolveEngine({ productRoot: PRODUCT_ROOT, env: isolatedEnv() }).source).toBe("default")
  })
})
