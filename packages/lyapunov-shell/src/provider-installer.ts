import { randomUUID } from "node:crypto"
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import type { JobHandle, JobHooks, JobOutcome, JobRegistry } from "@deepseek-ai/dsh-jobs"
import type { SubprocessHandle, SubprocessRuntime } from "@deepseek-ai/dsh-subprocess"
import type { EngineInstallResult, EngineLicenseAcceptance } from "./engine-provider-contract.ts"
import {resolveSdkPython} from "../../lyapunov-product-bundle/src/sdk-python.mjs"
import {inspectIsaacPythonSync} from "../../lyapunov-product-bundle/src/isaac-sdk-probe.mjs"
import {
  declarationRows, environmentPanel, featureEnvironmentVerdict, gpuRuntimeDecision, probeEnvironmentFacts,
  type EnvironmentFacts, type EnvironmentPanel, type EnvironmentRow, type GpuRuntimeDecision,
} from "./environment-readiness.ts"

declare module "@deepseek-ai/dsh-jobs" { interface JobKindMap { provider_install: "provider-install" } }
export const ISAAC_EULA_URL = "https://docs.omniverse.nvidia.com/platform/latest/common/NVIDIA_Omniverse_License_Agreement.html"
const PROVIDERS = ["mujoco", "isaac", "newton", "policy-cpu"] as const
type Provider = typeof PROVIDERS[number]
type Status = "starting" | "running" | "stopping" | "completed" | "failed" | "killed" | "blocked" | "interrupted"
const LIVE = new Set<Status>(["starting", "running", "stopping"])
const STATUSES = new Set<Status>([...LIVE, "completed", "failed", "killed", "blocked", "interrupted"])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** 环境门禁模式。`advisory`=默认：**只报不拦**，把降级与"没有 GPU 会怎样"讲清楚；`strict`=无替代路径的缺失直接拒绝。 */
export type EnvironmentGateMode = "advisory" | "strict"

/**
 * N3：一次安装尝试的环境前置核对结果（`state()`/`dryRun()` 下发、`start()` 记进回执）。
 *
 * 它回答的正是收敛清单 §4.2 那条空档：「在无 GPU 的机器上安装需要 GPU 的 Provider，安装期不会提前警告」。
 * 现在安装前先核对，并把**四句话 + 处置步骤**（`wording`，来自 environment-readiness 的统一话术）原样交给界面。
 */
export interface InstallReadinessGate {
  provider: Provider
  mode: EnvironmentGateMode
  status: "ready" | "degraded" | "blocked"
  /** 非就绪时的稳定错误码（如 `ENVIRONMENT_GPU_DEVICE_HIDDEN`）；就绪为 null。 */
  code: string | null
  /** 这次核对是否会在 `start()` 里真的拒绝（= strict 模式且 `blocked`）。 */
  rejects: boolean
  /** 与该 Provider 相关的环境依赖行（界面只渲染这几行，不必理解整屏）。 */
  rows: EnvironmentRow[]
  /** 统一话术；界面逐行渲染即可，不要自己造句。 */
  wording: string[]
}

/** 回执里记录的环境读数：安装当时**这台机器是什么状态**，事后可复核（D1/D4 的可追溯性）。 */
export interface InstallEnvironmentRecord {
  at: number
  mode: EnvironmentGateMode
  status: InstallReadinessGate["status"]
  code: string | null
  rejected: boolean
  rows: Array<{ id: string; status: string; state: string | null; reading: string; uncertain: boolean }>
}

/** One server-issued attempt; a Job id is only valid in the host that issued it. */
export interface InstallReceipt {
  version: 1
  attemptId: string
  provider: Provider
  status: Status
  startedAt: number
  sequence: number
  finishedAt?: number
  jobId?: string
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  detail?: string
  result?: EngineInstallResult
  eula: { requested: boolean; acceptance: (EngineLicenseAcceptance & { attemptId: string; boundAt: number }) | null }
  /** N3 的环境前置读数（旧回执没有这一项，读取端按可选处理）。 */
  environment?: InstallEnvironmentRecord
}

export interface InstallerOptions {
  root: string
  cwd: string
  scriptPath: string
  env: NodeJS.ProcessEnv
  jobs: Pick<JobRegistry, "start" | "kill">
  subprocess: Pick<SubprocessRuntime, "spawn">
  readLicense: () => EngineLicenseAcceptance | undefined
  onSettled?: () => void
  /** 环境面板来源（测试/宿主注入）。缺省为宿主真实探测，按 `readinessTtlMs` 在进程内共享缓存。 */
  readiness?: () => EnvironmentPanel
  /**
   * 环境门禁模式，默认 `advisory`。为什么默认不拦：用户口径是"环境不对**不是**失败"，安装 SDK 在
   * 无 GPU 机器上也是合法的准备动作（Isaac 纯 CPU 可跑物理）；而且"装 Isaac 前不警告"这个真缺口
   * 靠**报出来**就补上了。要按 D3 硬拒（`tool.micromamba` 缺失这类无替代路径的前置），把这里设 `strict`。
   */
  environmentGate?: EnvironmentGateMode
  /** 真实探测的进程内缓存时长（毫秒，默认 30_000；0 = 每次重读）。读数会在安装结束后自动失效。 */
  readinessTtlMs?: number
}

function providerOf(value: string): Provider {
  if (!(PROVIDERS as readonly string[]).includes(value)) throw new Error(`PROVIDER_UNKNOWN: ${value}`)
  return value as Provider
}

function readTail(path: string, size = 65536): string {
  if (!existsSync(path)) return ""
  const fd = openSync(path, "r")
  try {
    const length = statSync(path).size
    const buffer = Buffer.alloc(Math.min(length, size))
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, Math.max(0, length - size))).toString("utf8")
  } finally { closeSync(fd) }
}

/** Parse the final JSON object, including the pretty-printed doctor result. */
export function installerResult(text: string): EngineInstallResult | undefined {
  const lines = text.trimEnd().split("\n")
  for (let end = lines.length; end > 0; end--) {
    if (!lines[end - 1].trimEnd().endsWith("}")) continue
    for (let start = end - 1; start >= 0; start--) {
      if (!lines[start].startsWith("{")) continue
      try {
        const result = JSON.parse(lines.slice(start, end).join("\n")) as EngineInstallResult
        if (result && typeof result.status === "string") return result
      } catch { /* A diagnostic line may start with a brace. */ }
    }
  }
  return undefined
}

function atomicReceipt(path: string, receipt: InstallReceipt): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temporary, "wx", 0o600)
  try {
    try { writeFileSync(fd, JSON.stringify(receipt) + "\n"); fsyncSync(fd) }
    finally { closeSync(fd) }
    renameSync(temporary, path)
    const directory = openSync(dirname(path), "r")
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

/**
 * 宿主环境读数的**进程内共享缓存**：`GET /api/lyapunov/engine-providers` 会对三个 Provider 各调一次
 * `state()`，而每次真实探测都要 fork `nvidia-smi`/`glxinfo`。按 `productRoot + 相关环境变量` 做键、按 TTL
 * 复用；安装结束（`onSettled` 之后）与 `dispose()` 时失效——装完可能刚好把某个运行时从"缺失"改成"就绪"。
 */
let hostReadinessCache: { key: string; at: number; panel: EnvironmentPanel; facts: EnvironmentFacts } | undefined
export function invalidateHostReadiness(): void { hostReadinessCache = undefined }

/** Host-global engine installs use unowned native Jobs, matching the settings API. */
export function createProviderInstaller(options: InstallerOptions) {
  let disposed = false
  const active = new Map<string, { receipt: InstallReceipt; hooks: JobHooks }>()
  const receiptPath = (id: string) => join(options.root, `${id}.json`)
  const logPath = (id: string) => join(options.root, `${id}.log`)
  const persist = (receipt: InstallReceipt) => atomicReceipt(receiptPath(receipt.attemptId), receipt)
  const gateMode: EnvironmentGateMode = options.environmentGate ?? "advisory"
  /** 最近一次宿主读数（面板 + 原始事实）：运行时决策（如 GPU）要问它，不再各自去试 nvidia-smi。 */
  let probedHost: { panel: EnvironmentPanel; facts: EnvironmentFacts } | undefined
  const readiness = (): EnvironmentPanel => {
    if (options.readiness) return options.readiness()
    const ttl = options.readinessTtlMs ?? 30_000
    // 面板描述的是**宿主**能力（DISPLAY、SDK 解释器覆盖…），所以用进程环境打底；但安装器真正交给
    // install-provider 的那几个变量（如 LYAPUNOV_MICROMAMBA）要覆盖在上面——面板说的必须和脚本拿到的一致。
    const env = { ...process.env, ...options.env }
    const key = [options.cwd, env.LYAPUNOV_MICROMAMBA ?? "", env.LYAPUNOV_MUJOCO_PYTHON ?? "", env.LYAPUNOV_ISAAC_PYTHON ?? "", env.LYAPUNOV_NEWTON_PYTHON ?? "", env.DISPLAY ?? ""].join("\u0000")
    const now = Date.now()
    if (ttl > 0 && hostReadinessCache && hostReadinessCache.key === key && now - hostReadinessCache.at < ttl) {
      probedHost = { panel: hostReadinessCache.panel, facts: hostReadinessCache.facts }
      return hostReadinessCache.panel
    }
    const facts = probeEnvironmentFacts({ productRoot: options.cwd, env })
    const panel = environmentPanel(facts)
    hostReadinessCache = { key, at: now, panel, facts }
    probedHost = { panel, facts }
    return panel
  }
  /**
   * W21 的**运行时消费点**：GPU 决策只从这一份读数来。
   * `device-hidden` 时它会明确说明"卡和驱动都好、只是本会话看不见设备"，并给出 CPU 替代路径的理由
   * 与 RTX 能力的拒绝码——界面与其它消费点读它即可，不要自己再判一次。
   */
  const gpuDecision = (): GpuRuntimeDecision | null => probedHost === undefined ? null : gpuRuntimeDecision(probedHost.facts.gpu)
  /**
   * N3：安装前置核对。判据来自统一契约（`install.<provider>` 声明 + 就绪面板），不在这里另写一套。
   * 无论哪种模式，界面都能拿到「没有 GPU 会怎样」的四句话；`strict` 只是让无替代路径的那一项真的拒绝。
   */
  const readinessGate = (provider: Provider): InstallReadinessGate => {
    const panel = readiness()
    const verdict = featureEnvironmentVerdict(`install.${provider}`, panel)
    return {
      provider, mode: gateMode, status: verdict.status, code: verdict.code,
      rejects: gateMode === "strict" && verdict.status === "blocked",
      rows: declarationRows(`install.${provider}`, panel), wording: verdict.wording,
    }
  }
  const readinessRecord = (gate: InstallReadinessGate): InstallEnvironmentRecord => ({
    at: Date.now(), mode: gate.mode, status: gate.status, code: gate.code, rejected: gate.rejects,
    rows: gate.rows.map(row => ({ id: row.id, status: row.status, state: row.state, reading: row.reading, uncertain: row.uncertain })),
  })
  const receipts = (): InstallReceipt[] => {
    if (!existsSync(options.root)) return []
    return readdirSync(options.root).filter(name => name.endsWith(".json")).map(name => {
      const row = JSON.parse(readFileSync(join(options.root, name), "utf8")) as InstallReceipt
      if (!row || row.version !== 1 || !UUID.test(row.attemptId) || name !== `${row.attemptId}.json` ||
          !(PROVIDERS as readonly string[]).includes(row.provider) || !STATUSES.has(row.status) ||
          !Number.isFinite(row.startedAt) || !Number.isSafeInteger(row.sequence) || row.sequence < 1 ||
          typeof row.eula?.requested !== "boolean" || (row.eula.acceptance !== null &&
            (!row.eula.acceptance || row.provider !== "isaac" || !row.eula.requested ||
             row.eula.acceptance.attemptId !== row.attemptId || row.eula.acceptance.eulaUrl !== ISAAC_EULA_URL ||
             !Number.isFinite(Date.parse(row.eula.acceptance.acceptedAt))))) {
        throw new Error(`INSTALL_RECEIPT_INVALID: ${name}`)
      }
      // 环境读数按可选处理（旧回执没有），但**写了就必须自洽**：坏掉的环境记录比没有记录更坏。
      if (row.environment !== undefined && (typeof row.environment !== "object" || row.environment === null ||
          !Number.isFinite(row.environment.at) || !["advisory", "strict"].includes(row.environment.mode) ||
          !["ready", "degraded", "blocked"].includes(row.environment.status) || !Array.isArray(row.environment.rows))) {
        throw new Error(`INSTALL_RECEIPT_INVALID: ${name}`)
      }
      return row
    })
  }
  const blockedAttempt = (provider: Provider) => receipts().find(row => row.provider === provider && (LIVE.has(row.status) || row.status === "interrupted"))
  const license = () => {
    const value = options.readLicense()
    return value?.eulaUrl === ISAAC_EULA_URL && Number.isFinite(Date.parse(value.acceptedAt)) ? value : undefined
  }
  const savedLocalSdk = (provider: Provider) => {
    if (provider !== "isaac") return undefined
    const env = {...process.env, ...options.env}
    const selected = resolveSdkPython(options.cwd, "isaac", env)
    if (selected.source !== "saved-preference") return undefined
    const candidate = inspectIsaacPythonSync(selected.python, {productRoot: options.cwd, env})
    return {code: candidate.compatible ? "LOCAL_SDK_SELECTED" : "LOCAL_SDK_INVALID",
      message: candidate.compatible ? "已选择兼容的本地 Isaac Sim，无需重复下载安装。选择物理引擎并重启后使用；许可与运行能力仍需检查。"
        : `已保存的本地 SDK 不可用：${candidate.detail} 请检查路径，或在设置中恢复产品默认后安装。`}
  }
  const argv = (provider: Provider, accept: boolean) => ["/bin/sh", options.scriptPath, provider, ...(provider === "isaac" && accept ? ["--accept-omniverse-eula"] : [])]
  const stateFor = (provider: Provider, receipt?: InstallReceipt) => {
    const tail = receipt ? readTail(logPath(receipt.attemptId)) : ""
    const gate = readinessGate(provider)
    return {
      provider, running: receipt ? LIVE.has(receipt.status) : false,
      startedAt: receipt?.startedAt ?? null, attemptId: receipt?.attemptId ?? null,
      jobId: receipt?.jobId ?? null, status: receipt?.status ?? null,
      logPath: receipt ? logPath(receipt.attemptId) : "", tail: tail.slice(-4000),
      result: receipt?.result ?? installerResult(tail) ?? null,
      detail: receipt?.detail ?? null, receiptPath: receipt ? receiptPath(receipt.attemptId) : null,
      cli: `./lyapunov install-provider ${provider}`,
      /**
       * N1/N3：环境就绪面板 + 本次安装的前置核对。`GET /api/lyapunov/engine-providers` 已经把三行
       * `state()` 原样下发，所以界面**不需要新增端点**就能渲染这一屏（三行里的面板是同一份，任取一行）。
       */
      readiness: {
        panel: readiness(),
        gate,
        /** W21 运行时决策：GPU 处于哪一态、为什么走 CPU、需要 GPU 的能力是否被拒绝。 */
        gpu: gpuDecision(),
        /** 这次尝试**当时**的环境读数（回执里记着的）；没有尝试过则为 null。 */
        attempt: receipt?.environment ?? null,
      },
    }
  }
  const state = (value: string) => {
    const provider = providerOf(value)
    const receipt = blockedAttempt(provider) ?? receipts().filter(row => row.provider === provider).sort((a, b) => b.sequence - a.sequence)[0]
    return stateFor(provider, receipt)
  }
  const finish = (receipt: InstallReceipt, status: Status, code: string, message: string, result?: EngineInstallResult) => {
    receipt.status = status
    receipt.finishedAt = Date.now()
    receipt.detail = message
    // Process failures override stale OK output; the raw script output stays in the log.
    receipt.result = result ?? { status: status === "completed" ? "OK" : status === "blocked" ? "BLOCKED" : "FAILED", code, message }
    persist(receipt)
  }
  const run = (receipt: InstallReceipt, job: JobHandle): JobHooks => {
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") }
    let child: SubprocessHandle | undefined
    let cancelled = false
    let finished = false
    let terminated = false
    let rangeSettled = false
    let ioError: unknown
    const terminate = () => {
      if (child && !terminated) { child.terminate(); terminated = true }
    }
    const cancel = (reason = "cancel requested") => {
      if (finished || cancelled) return
      // A throwing provider must allow a later retry rather than latch a false stop.
      terminate()
      cancelled = true
      receipt.status = "stopping"
      receipt.detail = reason
      try { persist(receipt) } catch (error) { ioError = error }
    }
    // Jobs requires a non-rejecting completion promise; all provider failures are classified below.
    const done: Promise<JobOutcome> = Promise.resolve().then(async (): Promise<JobOutcome> => {
      let outcome: JobOutcome
      const outputError = (error: Error) => {
        ioError = error
        try { terminate() } catch (terminationError) { ioError = terminationError }
      }
      const append = (channel: "stdout" | "stderr") => (data: Buffer | string) => {
        try {
          appendFileSync(logPath(receipt.attemptId), data, { mode: 0o600 })
          job.append(typeof data === "string" ? data : decoders[channel].write(data), { channel })
        }
        catch (error) { outputError(error instanceof Error ? error : new Error(String(error))) }
      }
      try {
        if (!cancelled && receipt.provider === "isaac") {
          const current = license()
          if (!current || current.acceptedAt !== receipt.eula.acceptance?.acceptedAt) {
            finish(receipt, "blocked", "LICENSE_CONFIRMATION_REQUIRED", "Server EULA acceptance changed before launch")
            return { status: "failed", detail: receipt.detail, result: JSON.stringify(receipt) }
          }
        }
        if (cancelled) {
          finish(receipt, "killed", "INSTALL_CANCELLED", "Cancelled before launch")
          return { status: "killed", detail: receipt.detail, result: JSON.stringify(receipt) }
        }
        receipt.status = "running"
        persist(receipt)
        child = options.subprocess.spawn({
          argv: argv(receipt.provider, receipt.eula.acceptance !== null), cwd: options.cwd, env: options.env,
          stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" }, graceMs: 2000,
        })
        child.stdout?.on("data", append("stdout")).on("error", outputError)
        child.stderr?.on("data", append("stderr")).on("error", outputError)
        const exit = await child.done
        receipt.exitCode = exit.exitCode
        receipt.signal = exit.signal
        // The shell may exit before a downloader descendant; Jobs settles only after range teardown.
        terminate()
        rangeSettled = await child.waitForExit()
        if (!rangeSettled) throw new Error("INSTALLER_PROCESS_RANGE_NOT_EMPTY")
        if (ioError) throw ioError
        const result = installerResult(readTail(logPath(receipt.attemptId)))
        if (cancelled) {
          finish(receipt, "killed", "INSTALL_CANCELLED", "Installer cancelled")
          outcome = { status: "killed", detail: receipt.detail }
        } else if (exit.signal !== null || exit.exitCode !== 0) {
          const failedResult = result && !["OK", "AVAILABLE", "COMPLETED"].includes(result.status ?? "") ? result : undefined
          finish(receipt, "failed", "INSTALL_PROCESS_FAILED", `exit code: ${exit.exitCode}; signal: ${exit.signal}`, failedResult)
          outcome = { status: "failed", detail: receipt.detail }
        } else if (result && !["OK", "AVAILABLE", "COMPLETED"].includes(result.status ?? "")) {
          finish(receipt, "failed", "INSTALL_REPORTED_FAILURE", result.code ?? `installer status: ${result.status}`, result)
          outcome = { status: "failed", detail: receipt.detail }
        } else {
          finish(receipt, "completed", "INSTALL_COMPLETED", "exit code: 0", result)
          outcome = { status: "completed", detail: receipt.detail }
        }
      } catch (error) {
        let message = String(error)
        if (child) {
          try { terminate(); await child.done.catch(() => undefined); rangeSettled = await child.waitForExit() }
          catch (cleanupError) { message += `; teardown: ${String(cleanupError)}` }
        }
        const finalStatus: Status = child && !rangeSettled ? "interrupted" : cancelled ? "killed" : "failed"
        const finalCode = finalStatus === "killed" ? "INSTALL_CANCELLED" : "INSTALL_EXECUTION_FAILED"
        try { finish(receipt, finalStatus, finalCode, message) }
        catch (storageError) { message += `; receipt persistence failed: ${String(storageError)}` }
        outcome = { status: finalStatus === "killed" ? "killed" : "failed", detail: message }
      } finally {
        for (const channel of ["stdout", "stderr"] as const) job.append(decoders[channel].end(), { channel })
        finished = true
        active.delete(receipt.attemptId)
        // 安装可能刚把某个运行时装好：下一次 `state()` 必须重新读，而不是继续回放安装前的缓存。
        invalidateHostReadiness()
        try { options.onSettled?.() }
        catch { /* Cache invalidation must not change the recorded install outcome. */ }
      }
      return { ...outcome, result: JSON.stringify(receipt) }
    }).catch(error => ({ status: "failed", detail: String(error), result: JSON.stringify(receipt) }))
    return { cancel, done }
  }

  return {
    state,
    receipts,
    /** Recover unknown outcomes, without reattaching process-local IDs or signalling old PIDs. */
    recover() {
      for (const receipt of receipts()) {
        if (LIVE.has(receipt.status) && !active.has(receipt.attemptId)) {
          finish(receipt, "interrupted", "INSTALLER_HOST_RESTARTED", "Host restarted; process outcome unknown. Inspect the installation before retrying.")
        }
      }
    },
    dryRun(value: string, requested: boolean) {
      const provider = providerOf(value)
      const serverAcceptance = provider === "isaac" ? license() : undefined
      const accepted = requested ? serverAcceptance : undefined
      const pending = blockedAttempt(provider)
      const locked = existsSync(join(options.root, `${provider}.lock`))
      const local = !pending && !locked ? savedLocalSdk(provider) : undefined
      const reason = disposed ? "INSTALLER_DISPOSED" : pending ? pending.status === "interrupted" ? "INSTALL_RECONCILIATION_REQUIRED" : "INSTALL_ALREADY_RUNNING" : locked ? "INSTALL_START_LOCKED" : local ? local.code : provider === "isaac" && !accepted ? "LICENSE_CONFIRMATION_REQUIRED" : !existsSync(options.scriptPath) ? "PROVIDER_INSTALLER_MISSING" : null
      const gate = readinessGate(provider)
      const args = argv(provider, Boolean(accepted))
      return {
        status: "dry-run", provider, requestedEula: requested, serverEulaAccepted: Boolean(serverAcceptance),
        acceptedForAttempt: false, wouldAcceptEula: Boolean(accepted), wouldStart: reason === null && !gate.rejects,
        // 只有 strict 下的拒绝才占用 `code`：advisory 模式仍然 `wouldStart=true`，此时把环境提示放在
        // `readiness.gate.code` 里，避免"给了错误码又说能启动"的自相矛盾。
        code: reason ?? (gate.rejects ? gate.code : null), ...local ? {message: local.message} : {},
        attemptId: null, jobId: null, logPath: null, argv: args,
        command: args.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(" "),
        readiness: { panel: readiness(), gate, gpu: gpuDecision(), attempt: null },
      }
    },
    start(value: string, requested: boolean) {
      if (disposed) throw new Error("INSTALLER_DISPOSED")
      const provider = providerOf(value)
      const pending = blockedAttempt(provider)
      if (pending) return { ...stateFor(provider, pending), code: pending.status === "interrupted" ? "INSTALL_RECONCILIATION_REQUIRED" : "INSTALL_ALREADY_RUNNING" }
      const local = savedLocalSdk(provider)
      if (local) return {...stateFor(provider), running: false, status: "blocked" as const, code: local.code, detail: local.message, result: {status: "BLOCKED", code: local.code, message: local.message}}
      mkdirSync(options.root, { recursive: true, mode: 0o700 })
      // Serialize host-global starts across hosts sharing this receipt directory.
      const lock = join(options.root, `${provider}.lock`)
      const fd = openSync(lock, "wx", 0o600)
      try {
        const again = blockedAttempt(provider)
        if (again) return { ...stateFor(provider, again), code: "INSTALL_RECONCILIATION_REQUIRED" }
        const attemptId = randomUUID()
        const accepted = provider === "isaac" && requested ? license() : undefined
        const gate = readinessGate(provider)
        const receipt: InstallReceipt = {
          version: 1, attemptId, provider, status: "starting", startedAt: Date.now(),
          sequence: 1 + receipts().filter(row => row.provider === provider).reduce((max, row) => Math.max(max, row.sequence), 0),
          eula: { requested, acceptance: accepted ? { ...accepted, attemptId, boundAt: Date.now() } : null },
          environment: readinessRecord(gate),
        }
        persist(receipt)
        if (provider === "isaac" && !accepted) {
          finish(receipt, "blocked", "LICENSE_CONFIRMATION_REQUIRED", "Explicit acceptance and the server license record are required", { status: "BLOCKED", code: "LICENSE_CONFIRMATION_REQUIRED", eulaUrl: ISAAC_EULA_URL })
        } else if (gate.rejects) {
          // D3：无替代路径的前置缺失 → 明确拒绝 + 可执行处置（`wording` 就是那四句话 + 步骤）。
          finish(receipt, "blocked", gate.code ?? "ENVIRONMENT_PREREQUISITE_MISSING", gate.wording.join("\n"),
            { status: "BLOCKED", code: gate.code ?? "ENVIRONMENT_PREREQUISITE_MISSING", message: gate.wording[0] })
        } else if (!existsSync(options.scriptPath)) {
          finish(receipt, "failed", "PROVIDER_INSTALLER_MISSING", "Installer script is missing")
        } else {
          try {
            receipt.jobId = options.jobs.start({
              kind: "provider-install", label: `Install ${provider} (${attemptId})`, outputLimitBytes: 8000,
              run: job => {
                const hooks = run(receipt, job)
                active.set(attemptId, { receipt, hooks })
                return hooks
              },
            })
            persist(receipt)
          } catch (error) {
            const live = active.get(attemptId)
            if (live) live.hooks.cancel("Job registration or receipt persistence failed")
            else finish(receipt, "failed", "INSTALL_JOB_UNAVAILABLE", String(error))
          }
        }
        return stateFor(provider, receipt)
      } finally { closeSync(fd); unlinkSync(lock) }
    },
    cancel(value: string, attemptId: string) {
      const provider = providerOf(value)
      const live = active.get(attemptId)
      if (!live) {
        const receipt = receipts().find(row => row.attemptId === attemptId && row.provider === provider)
        if (receipt && !LIVE.has(receipt.status) && receipt.status !== "interrupted") return stateFor(provider, receipt)
        throw new Error("INSTALL_JOB_NOT_LIVE: cannot cancel a recovered or foreign attempt")
      }
      if (live.receipt.provider !== provider || !live.receipt.jobId) throw new Error("INSTALL_JOB_NOT_LIVE: cannot cancel a recovered or foreign attempt")
      options.jobs.kill(live.receipt.jobId as Parameters<JobRegistry["kill"]>[0], undefined, "Cancelled from engine settings")
      return stateFor(provider, live.receipt)
    },
    async dispose() {
      disposed = true
      invalidateHostReadiness()
      const results = await Promise.allSettled([...active.values()].map(async ({ hooks }) => {
        hooks.cancel("Installer plugin disposed")
        await hooks.done
      }))
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Installer teardown incomplete")
    },
  }
}
