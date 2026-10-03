/**
 * W21 · 「有卡、有驱动、但设备对本会话不可见」在**运行时消费点**的话术守卫。
 *
 * 用户原话：「那别人的客户端下载了不也一样不能用？必须解决，而且要软件层面解决。」
 * 现场样本（本机随时可复现）：卡在（`lspci: 10de:2c58`）、驱动在（595.91.07，认了卡）、
 * **但本会话 `/dev/nvidia*` 一个都没有** ⇒ `nvidia-smi` 通信失败。
 *
 * 本文件钉住两件事：
 *  1. **装配点**（`packages/sim-isaac/src/plugin.ts`）拿不到 GPU 时抛出的那句话，必须是
 *     「这个会话看不见设备」而不是「没有任何 NVIDIA 设备节点」——**两者的处置完全不同**：
 *     前者只要让这个会话看见设备（`--gpus all` / 非沙箱会话 / 设备透传），后者才要装卡或重装驱动。
 *  2. **引擎选择点**（`script/engine-preference.ts`）在**缺省/自动**模式下把 GPU 当作 Isaac 的
 *     必备条件之一（SDK+许可+GPU 三项同时具备才默认 isaac），看不见设备就回退 MuJoCo 并把 GPU
 *     那一态原话打印出来；**显式选择**（`--engine`／环境变量／偏好）不受自动逻辑替换。
 *  3. 缺省回退的理由必须同时说清"缺的是 GPU、怎么改回"——不静默换引擎，也不谎报 GPU 可用。
 *     （历史口径"GPU 只影响 reason、不影响 engine"自 2026-09-28 起改为"参与缺省判定"。）
 *
 * ── GATE-AB-20260927 重构：宿主观测与合同测试分清 ───────────────────────────────
 * 原文案下，缺卡/驱动未加载/设备隐藏/设备可见这些**合同分支**都写在"宿主恰好是设备隐藏形态才走"
 * 的 `if` 里：GPU 可见的宿主上 expect 只有 16（< 冻结下限 31），发布门判红。现在分两层：
 *   · **合同层（宿主无关）**：合成 `GpuFacts` + 替身 `probeGpuFacts`（`mock.module`），逐态钉
 *     缺卡 / 驱动未加载 / 设备隐藏 / 设备可见 / card-unknown / 只有 caps 目录的情况；
 *   · **宿主观测层（真机只读、明确标注）**：真机读数自洽 + 设备隐藏形态出现时核对拒绝句。
 *
 * 诚实边界：装配点真实抛错路径的端到端覆盖在 `isaac-entry-lifecycle.test.ts`（可控探针替身）；
 * 本文件钉的是**同一份契约函数**（`gpuRuntimeDecision`/`gpuRefusal`）在这些事实上的输出。
 */
import { expect, mock, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as realEnvironment from '../../lyapunov-shell/src/environment-readiness.ts'
import type { GpuFacts } from '../../lyapunov-shell/src/environment-readiness.ts'

const { classifyGpu, gpuRefusal, gpuRuntimeDecision, gpuStatus, probeGpuFacts: realProbeGpuFacts } = realEnvironment

const isaacPluginSource = readFileSync(join(import.meta.dirname, '../src/plugin.ts'), 'utf8')
const enginePreferenceSource = readFileSync(join(import.meta.dirname, '../../../script/engine-preference.ts'), 'utf8')

const DRIVER_LINE = 'NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  595.91.07  Release Build  (dvs-builder@U22-I3-B08-02-2)  Wed Jul 29 03:01:16 UTC 2026'
const SMI_OK = 'NVIDIA GeForce RTX 5090 Laptop GPU, 24463, 1024'

/**
 * 合成事实：与 W21 现场同形（卡在、驱动在、驱动认了卡），默认**设备不可见**（`deviceNodes: []`）。
 * 每个合同用例只改自己关心的字段，其余保持同一份底座（避免"顺手把别的变量也改了"）。
 */
function facts(over: Partial<GpuFacts> = {}): GpuFacts {
  return {
    probeError: null, driverVersion: DRIVER_LINE, driverGpuEntries: ['0000:02:00.0'], deviceNodes: [], deviceExtras: [],
    pciDevices: ['0000:02:00.0'], pciIds: ['0000:02:00.0 10de:2c58 class=0x030000'],
    driverGpuModels: ['0000:02:00.0 NVIDIA GeForce RTX 5090 Laptop GPU'],
    smi: { present: true, ok: false, output: '', error: '' },
    capacity: null, requiredVramMiB: null, minDriverMajor: null,
    ...over,
  }
}

/**
 * 测试专用替身：只管 `probeGpuFacts`，其余（`gpuRuntimeDecision`/`gpuRefusal`/…）原样是真实现 ——
 * 这样 `defaultEngine()` 的宿主探测可控（合同层的引擎选择用例），而本文件的**合同函数**仍是产品真代码。
 * `forcedFacts=null` 时原样委托真探测，宿主观测层拿到的是真机读数。
 */
let forcedFacts: GpuFacts | null = null
mock.module('../../lyapunov-shell/src/environment-readiness.ts', () => ({
  ...realEnvironment,
  probeGpuFacts: (...args: Parameters<typeof realProbeGpuFacts>) => forcedFacts ?? realProbeGpuFacts(...args),
}))
// mock **之后**动态 import：engine-preference 拿到的是替身探针。
const { defaultEngine, isaacRuntimeAvailable, resolveEngine } = await import('../../../script/engine-preference.ts')

/** 造一个"Isaac 运行时就位"的产品根：解释器在 + `isaacsim` 装进 site-packages + 解释器能发现它。
 *  复核点 4 起：安装候选看**顶层包目录**（孤立 dist-info 不算），且要过解释器发现核对，
 *  所以这里用一个可执行桩替身（真实路径是 `importlib.util.find_spec`，不 import 执行）。 */
function rootWithIsaac(): string {
  const root = mkdtempSync(join(tmpdir(), 'w21-isaac-root-'))
  const python = join(root, '.runtime/conda/envs/isaac/bin/python')
  mkdirSync(join(root, '.runtime/conda/envs/isaac/bin'), { recursive: true })
  writeFileSync(python, '#!/bin/sh\necho SDK_PROBE_FOUND\nexit 0\n', { mode: 0o755 })
  chmodSync(python, 0o755)
  mkdirSync(join(root, '.runtime/conda/envs/isaac/lib/python3.12/site-packages/isaacsim'), { recursive: true })
  return root
}

// ───────────────────────── 合同层（宿主无关，合成事实） ─────────────────────────

test('合同·device-hidden（有卡有驱动、会话无设备）：拒绝句说"这个会话看不见设备"，处置指向 --gpus all', () => {
  const f = facts()
  expect(classifyGpu(f).state).toBe('device-hidden')
  expect(gpuStatus(classifyGpu(f).state)).toBe('degraded')
  const decision = gpuRuntimeDecision(f)
  expect(decision.accelerator).toBe('session-hidden')
  expect(decision.gpuRequired.blocked).toBe(true)
  expect(decision.gpuRequired.code).toBe('ENVIRONMENT_GPU_DEVICE_HIDDEN')
  const refusal = gpuRefusal('Isaac 配置要求 GPU（physicsDevice=cuda:0，rendering=rtx）', f)
  expect(refusal).not.toBeNull()
  expect(refusal!.code).toBe('ENVIRONMENT_GPU_DEVICE_HIDDEN')
  // 必须说清"卡是好的、驱动是好的，只是这个会话看不见设备"。
  expect(refusal!.message).toContain('这个会话看不见设备')
  expect(refusal!.message).toContain('卡是好的、驱动是好的')
  expect(refusal!.message).toContain('10de:')                 // 卡 ID 可核对
  // 禁止诊断口吻（用户会照着这句去重装驱动/换卡，而那是白费功夫）。
  expect(refusal!.message).not.toContain('没有任何 NVIDIA 设备节点')
  expect(refusal!.message).not.toContain('GPU 不可用')
  expect(refusal!.message).not.toContain('本机没有 NVIDIA 卡')
  // 处置必须指向"让这个会话看见设备"。
  expect(refusal!.message).toContain('--gpus all')
})

test('合同·no-device（读得到、确实没卡）：拒绝句说"没有卡"，不许说成设备不可见', () => {
  const f = facts({ driverVersion: null, driverGpuEntries: [], driverGpuModels: [], deviceNodes: [], deviceExtras: [], pciDevices: [], pciIds: [] })
  expect(classifyGpu(f).state).toBe('no-device')
  expect(gpuStatus(classifyGpu(f).state)).toBe('missing')
  const decision = gpuRuntimeDecision(f)
  expect(decision.accelerator).toBe('absent')
  expect(decision.gpuRequired.code).toBe('ENVIRONMENT_GPU_NO_DEVICE')
  const refusal = gpuRefusal('Isaac RTX 渲染', f)
  expect(refusal!.message).toContain('本机没有 NVIDIA 卡')
  expect(refusal!.message).not.toContain('这个会话看不见设备')
})

test('合同·driver-missing（卡在、驱动未加载）：拒绝句说"驱动没加载"，不说"没有卡"', () => {
  const f = facts({ driverVersion: null, driverGpuEntries: [], driverGpuModels: [], deviceNodes: [], deviceExtras: [] })
  expect(classifyGpu(f).state).toBe('driver-missing')
  const decision = gpuRuntimeDecision(f)
  expect(decision.accelerator).toBe('driver-missing')
  expect(decision.gpuRequired.code).toBe('ENVIRONMENT_GPU_DRIVER_MISSING')
  const refusal = gpuRefusal('Isaac cuda:0', f)
  expect(refusal!.message).toContain('驱动没加载')
  expect(refusal!.message).not.toContain('这个会话看不见设备')
})

test('合同·device-visible（驱动+设备+smi 全在）：不需要拒绝，判就绪', () => {
  const f = facts({ deviceNodes: ['/dev/nvidia0'], deviceExtras: [], smi: { present: true, ok: true, output: SMI_OK, error: '' }, capacity: { totalMiB: 24463, freeMiB: 23439 } })
  expect(classifyGpu(f).state).toBe('ready')
  expect(gpuStatus(classifyGpu(f).state)).toBe('ready')
  const decision = gpuRuntimeDecision(f)
  expect(decision.accelerator).toBe('available')
  expect(decision.gpuRequired.blocked).toBe(false)
  expect(decision.gpuRequired.code).toBeNull()
  expect(gpuRefusal('Isaac RTX 渲染', f)).toBeNull()
})

test('合同·只有 nvidia-caps 目录（非字符设备）：仍判 device-hidden，不算设备可见', () => {
  const f = facts({ deviceExtras: ['/dev/nvidia-caps'] })
  expect(classifyGpu(f).state).toBe('device-hidden')
  expect(gpuRuntimeDecision(f).accelerator).toBe('session-hidden')
  const refusal = gpuRefusal('Isaac RTX 渲染', f)
  expect(refusal!.code).toBe('ENVIRONMENT_GPU_DEVICE_HIDDEN')
  expect(refusal!.message).toContain('--gpus all')
})

test('合同·card-unknown（驱动在但没有任何"有卡"证据）：不许说"卡是好的"', () => {
  const f = facts({ driverGpuEntries: [], pciDevices: [], pciIds: [], driverGpuModels: [], deviceNodes: [], deviceExtras: [] })
  expect(classifyGpu(f).state).toBe('card-unknown')
  expect(gpuStatus(classifyGpu(f).state)).toBe('unknown')
  const refusal = gpuRefusal('Isaac RTX 渲染', f)
  expect(refusal!.code).toBe('ENVIRONMENT_GPU_CARD_UNKNOWN')
  expect(refusal!.message).not.toContain('卡是好的、驱动是好的')
  expect(refusal!.message).toContain('没有任何“有卡”的证据')
})

// ───────────────────────── 装配点源码契约 ─────────────────────────

test('装配点源码契约：调用同一份判定，旧那句"没有任何 NVIDIA 设备节点"已不在', () => {
  expect(isaacPluginSource).toContain('gpuRefusal(')
  expect(isaacPluginSource).toContain('probeGpuFacts()')
  expect(isaacPluginSource).toContain("from '../../lyapunov-shell/src/environment-readiness.ts'")
  // 就是把不可见说成没有的那句话——必须消失。
  expect(isaacPluginSource).not.toContain('没有任何 NVIDIA 设备节点可暴露')
  expect(isaacPluginSource).not.toContain('拿不到 GPU 的 worker')
  // 但仍然拒绝启动（不静默按 CPU 顶替用户明确配置的 GPU 需求）。
  expect(isaacPluginSource).toContain('ISAAC_GPU_DEVICE_UNAVAILABLE')
})

// ───────────────────────── 合同层 · 引擎选择（替身探针，宿主无关） ─────────────────────────

test('合同·引擎选择：session-hidden 不满足 GPU 条件 ⇒ 缺省回退 mujoco 并打印 GPU 那一态；显式 isaac 不受影响', () => {
  const root = rootWithIsaac()
  forcedFacts = facts()                                        // device-hidden
  try {
    expect(isaacRuntimeAvailable(root, {} as NodeJS.ProcessEnv)).toBe(true)
    // 本轮起：GPU 条件参与**缺省/自动**判定——看不见设备就不算"GPU 具备"，回退 MuJoCo。
    const selection = defaultEngine(root, {} as NodeJS.ProcessEnv, { isaacLicense: true })
    expect(selection.engine).toBe('mujoco')
    expect(selection.reason).toContain('GPU 未确认可用')       // 理由里必须打印出来
    expect(selection.reason).toContain('这个会话看不见设备')
    expect(selection.reason).not.toContain('没有任何 NVIDIA 设备节点')
    // 显式选择仍不被自动逻辑替换（引擎是用户意图）。
    const explicit = resolveEngine({ explicit: 'isaac', productRoot: root, env: {} as NodeJS.ProcessEnv, auto: { isaacRuntime: true, isaacLicense: true, gpu: gpuRuntimeDecision(facts()) } })
    expect(explicit.engine).toBe('isaac')
    expect(explicit.source).toBe('explicit')
  } finally { forcedFacts = null; rmSync(root, { recursive: true, force: true }) }
})

test('合同·引擎选择：Isaac 未就绪仍回退 mujoco，并把 GPU 那一态一并打出来（两条理由都可见）', () => {
  const empty = mkdtempSync(join(tmpdir(), 'w21-empty-root-'))
  forcedFacts = facts()                                        // device-hidden
  try {
    const selection = defaultEngine(empty, {} as NodeJS.ProcessEnv)
    expect(selection.engine).toBe('mujoco')
    expect(selection.reason).toContain('回退 mujoco')          // 既有范式：不静默换引擎
    // 复核点 2：不写"装好任一引擎后自动改回 isaac"（MuJoCo 装好不会让 Isaac 就绪）。
    expect(selection.reason).toContain('若 Isaac 条件补齐且偏好层仍为自动，下次启动才会优先 isaac')
    expect(selection.reason).not.toContain('装好后自动改回 isaac')
    expect(selection.reason).toContain('GPU 未确认可用')
    expect(selection.reason).toContain('下次启动才会优先 isaac')
  } finally { forcedFacts = null; rmSync(empty, { recursive: true, force: true }) }
})

test('引擎选择源码契约：判定来自契约模块，且 GPU 条件参与缺省/自动判定', () => {
  expect(enginePreferenceSource).toContain('gpuRuntimeDecision(probeGpuFacts())')
  expect(enginePreferenceSource).toContain("from \"../packages/lyapunov-shell/src/environment-readiness.ts\"")
  // 缺省/自动的关键判据：SDK + 许可 + GPU 三项同时具备才选 isaac（GPU 不再是"只影响理由"）。
  expect(enginePreferenceSource).toContain('facts.gpu.accelerator !== "available"')
  expect(enginePreferenceSource).toContain('facts.isaacLicense')
  expect(enginePreferenceSource).toContain('facts.isaacRuntime')
  // 复核点 5：不对 GPU 型号做武断分类——缺省判定只看 `accelerator` 这一格，不读型号/PCI 字符串列表。
  expect(enginePreferenceSource).not.toContain('driverGpuModels')
  expect(enginePreferenceSource).not.toContain('pciIds')
})

// ───────────────────────── 宿主观测层（真机只读，明确标注） ─────────────────────────

test('宿主观测（真机只读）：真机读数自洽；出现"设备隐藏"形态时才核对拒绝句（合同层已用夹具全覆盖）', () => {
  const real = realProbeGpuFacts()
  const decision = gpuRuntimeDecision(real)
  const refusal = gpuRefusal('Isaac 配置要求 GPU（physicsDevice=cuda:0，rendering=rtx）', real)
  // 现场样本（本机可复现）：驱动在、驱动认了卡、本会话没有字符设备。
  const liveShape = real.driverVersion !== null && real.driverGpuEntries.length > 0 && real.deviceNodes.length === 0
  if (liveShape) {
    expect(decision.state).toBe('device-hidden')
    expect(decision.accelerator).toBe('session-hidden')
    expect(refusal).not.toBeNull()
    expect(refusal!.code).toBe('ENVIRONMENT_GPU_DEVICE_HIDDEN')
    expect(refusal!.message).toContain('这个会话看不见设备')
    expect(refusal!.message).toContain('卡是好的、驱动是好的')
    expect(refusal!.message).not.toContain('没有任何 NVIDIA 设备节点')
    expect(refusal!.message).not.toContain('GPU 不可用')
    expect(refusal!.message).not.toContain('本机没有 NVIDIA 卡')
    expect(refusal!.message).toContain('--gpus all')
  }
  // 无条件：探针不得抛错；解释链永远是 5 段。
  const fallback = (): unknown => gpuRefusal('Isaac RTX', { ...real, driverVersion: null, driverGpuEntries: [], deviceNodes: ['/dev/nvidia0'] })
  expect(fallback).not.toThrow()
  expect(decision.explanation).toHaveLength(5)
})
