import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pathWithin as writablePathWithin } from '../../lyapunov-contracts/src/writable-boundary.ts'
import { SimError, type SimWorlds, type WorldOptions, type ObservationSelection, type StopSelection, type SimAction, type RobotDescription, type CaptureOptions, type MultiCaptureOptions, type CameraAdjustOptions, type CameraAnnotationOptions, type CameraDatasetExportOptions } from './index.ts'
import type { SceneSnapshot, WorldHandle, Frame, ActionReceipt } from '../../lyapunov-contracts/src/types.ts'

/**
 * 一次 worker 启动**实际取得**的执行事实：所属会话、生效文件效果模式、生效工作区根与
 * 会话运行根。装配方注入 {@link ProcessSimConfig.launch} 时由它给出（原生 policy/sandbox 解析结果）；
 * 不注入时为空，表示这次启动没有经过会话沙箱接线（历史直连行为），调用方不得据此声称沙箱已生效。
 */
export interface SimWorkerLaunchFacts {
  /** 所属原生会话（worker 收到的身份，与场景/资产/world 的归属键同一个）。 */
  sessionId: string
  /** 生效文件效果模式。 */
  mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** 生效策略的工作区根（`workspace-write` 的授予根）。 */
  workspaceRoot: string
  /** 本次执行的授予根：`workspace-write` 下就是 workspaceRoot；`danger-full-access` 无约束（取值仅为事实记录）。 */
  writableRoot: string
  /** 本会话的运行根（worker 的会话级可写空间；位于授予根之内）。 */
  runtimeRoot: string
  /** 原生沙箱执行器（包裹后 argv[0]）；不受文件效果约束时为空。 */
  runner?: string
  /** 原生后端自报的强制程度（`full`/`partial`）。 */
  enforcement?: string
  /**
   * 本会话自己的产品产物根（captureRoot/recordingRoot 下的会话目录）。只有落在这些根内的
   * worker 产物才由宿主中转；其余越界写入一律让 worker 的真实拒绝原样上报。
   */
  productRoots?: string[]
  /**
   * 会话私有运行目录在 **OS 层**的边界：`os-bind` = 封装时把运行根父目录挂成只读、只把自己这条会话的
   * 目录挂回可写（同一 workspace 里的其它会话写不进来）；`none` = 本次封装没有这一层（别的原生后端、
   * 只读模式或显式不受文件约束），此时同 workspace 的会话私有目录只有**应用层归属**在隔离，
   * 报告里必须按这个区别写，不能拿应用层说成 OS 隔离。
   */
  privateRootBoundary?: 'os-bind' | 'none'
  /** 为临时安装恢复只读可见性的宿主声明运行依赖根。 */
  runtimeReadRoots?: string[]
  /**
   * 本次执行给**受信引擎自己**保留的内部可写目录（会话私有；例如 Kit portable root 与导入缓存）。
   * 由装配方按会话唯一归属解析、在原生封装里单独挂回可写；模型/HTTP 不能指定。**用户模式不受影响**：
   * `mode` 仍是会话的有效策略，用户的截图/数据集落盘不落进这些目录（见 `requireUserFacingWrite`）。
   * 未配置内部目录的引擎上不出现这个字段。
   */
  internalWritableRoots?: string[]
  /**
   * 上面那些内部目录在 **OS 层**的边界：`os-bind` = 本层把它们（或包含它们的会话私有目录）真的挂回可写；
   * `none` = 本层没有为它加挂载（原生后端表达不了，或不受文件约束）——此时可写与否取决于原生后端，
   * 不能报告成"引擎内部缓存已可写"。
   */
  internalWritableBoundary?: 'os-bind' | 'none'
  /**
   * 本次执行显式暴露给引擎的**设备节点**（`/dev` 下的字符设备或承载它们的子目录）。原生封装的
   * `--dev /dev` 只给一个空挂载点：GPU 物理/RTX 需要的 `/dev/nvidia*` 不在里面，引擎在沙箱里
   * 初始化 GPU 会当场失败（实测 NVML_ERROR_DRIVER_NOT_LOADED → 无物理设备 → 引擎自己的
   * "Invalid device specification (cuda:0)"）。声明由装配方按引擎配置给出（模型/HTTP 不能指定），
   * 文件效果模式**不因此改变**：这里放开的只有设备访问，没有多出任何可写文件面。
   * 未配置设备的引擎上不出现这个字段。
   */
  engineDevices?: string[]
  /**
   * 上面那些设备在 **OS 层**的边界：`device-bind` = 本层真的把它们挂进了沙箱；`none` = 本层没挂
   * （原生后端表达不了，或本次不受文件效果约束——那时设备本来就可见）。不能把声明本身报成"已暴露"。
   */
  engineDeviceBoundary?: 'device-bind' | 'none'
}

/**
 * 一次核对读到的会话**当前**有效策略（模式 + 授权根）。用户产物落盘边界只依据这份**当前**授权决定
 * 这次写入允不允许——不是依据 worker 启动那一刻的旧 facts。
 */
export interface SimWorkerPolicySnapshot {
  mode: SimWorkerLaunchFacts['mode']
  workspaceRoot: string
}
/** 策略核对结论：`stale` 表示这只 worker 启动时携带的沙箱许可已经不再被会话现值包含；`current` 是最新解析出的现值。 */
export type SimWorkerPolicyVerdict =
  | { stale: false; current: SimWorkerPolicySnapshot }
  | { stale: true; detail: string; current: SimWorkerPolicySnapshot }
/**
 * 已启动 worker 的**当前策略核对**（装配方按会话给出，与启动同一份接线）：worker 的沙箱在启动时绑定，
 * 会话模式可以在运行中被改。它**只**服务于用户产物落盘边界（`capture`/`captureMulti`/`exportCameraDataset`）：
 * 在真正派发/发布写入前回答"该会话**当前**授权允不允许这次用户产物落盘，以及这只 worker 的旧许可还包不包含在现值里"。
 * 返回 `{stale:true}` 表示这只 worker 带着比现值更宽的旧许可（收紧过）；**抛错**表示核不出来（例如会话已不在）。
 * 两者都只拒绝本次写入、**不**结束 worker、**不**销毁世界——物理生命周期与 Agent 模式互切解耦：
 * 模式变化改变的是下一次写入的授权判定，不是世界的生死（真正结束走显式 close/stop 与引擎故障）。
 */
export type SimWorkerPolicyCheck = (facts: SimWorkerLaunchFacts) => Promise<SimWorkerPolicyVerdict>

/** 装配方注入的启动接线：给出**实际要 spawn 的 argv**（已按原生策略包裹）与本次执行事实。 */
export interface SimWorkerLaunchSpec {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  facts: SimWorkerLaunchFacts
  /** 本次执行的策略现值核对（可选）；不给出时写类操作不做这一层核对（未接线 Provider 的历史行为）。 */
  check?: SimWorkerPolicyCheck
}
export interface SimWorkerLaunchInput {
  pythonPath: string
  workerPath: string
  /** 历史行为下的完整环境（父进程环境 + 配置 env + HF 镜像）；接线方在其上追加会话事实。 */
  env: Record<string, string>
  signal?: AbortSignal
}
export type SimWorkerLaunchHook = (input: SimWorkerLaunchInput) => Promise<SimWorkerLaunchSpec>

export interface ProcessSimConfig {
  pythonPath: string; workerPath: string; engineName: string; env?: Record<string, string>
  /**
   * **显式配置**的启动预算（毫秒）。只在配置了值时才生效：到期仍未收到 worker 的 `ready`
   * 就按 failProvider 语义登记终态错误、终止本 Provider 自己的 worker、拒绝本次启动的 Promise，
   * 错误里带阶段轨迹/pid/已有 stderr 摘要。不配置 = 保持“一直等到 ready”的原有语义
   * （Isaac RTX 冷缓存实测需要约 270s，不能拿一个大小未知的默认超时去杀有效启动）。
   * 这是显式预算，不是按“多久没有输出”判死：静默但有效的启动不会被终止。
   */
  startupBudgetMs?: number
  /**
   * 每次启动 worker 前的执行接线（可选）：产品装配注入原生 `sandboxPolicy.resolve → sandbox.confine`
   * 的结果，让实际仿真执行带着**所属会话的身份、会话运行根与生效权限策略**启动。
   * 不注入 = 保持历史直连 spawn 行为（改由装配方决定，不在 provider 里猜一个模式）。
   */
  launch?: SimWorkerLaunchHook
}
/** Python 的接触力会输出 -0.0。物理 DTO 的零统一为 +0，以符合 DSH 的无损 JSON 值域。
 * 只处理有符号零；非零数值、非法 JSON 和非有限数不会被 stringify 或替换掩盖。
 */
export function decodePythonMessage(line: string): any {
  return JSON.parse(line, (_key, value) => Object.is(value, -0) ? 0 : value)
}
/**
 * 路径是否落在某个根之内（含根本身）：两边都走**规范路径**（`canonicalTargetPath`——符号链接按真实目标
 * 解析，末端还不存在时按上游 fs 的缺失后缀规则回填），与场景/资产工具那条宿主代写边界同一份规则。
 * 词法比较会把「根里的链接指向根外」当成根内，Host 中转于是照着链接替会话写到许可根外去。
 */
export function pathWithin(root: string, path: string): boolean {
  return writablePathWithin(root, path)
}
/** 把暂存目录里的真实产物搬进最终目录：先按重命名（同设备零拷贝），跨设备/已存在再退回复制。 */
async function publishDirectory(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from)) {
    const source = join(from, entry), target = join(to, entry)
    try {
      await rename(source, target)
    } catch {
      await rm(target, { recursive: true, force: true })
      await cp(source, target, { recursive: true, preserveTimestamps: true })
      await rm(source, { recursive: true, force: true })
    }
  }
}
/** 深度改写回执里指向暂存目录的路径/URI（先改 `file://` 形式，再改裸路径形式）。 */
function rewriteStagedUris<T>(value: T, from: string, to: string): T {
  const fromHref = pathToFileURL(from).href, toHref = pathToFileURL(to).href
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return node.split(fromHref).join(toHref).split(from).join(to)
    if (Array.isArray(node)) return node.map(walk)
    if (node !== null && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, walk(item)]))
    return node
  }
  return walk(value) as T
}
export class ProcessSimProvider implements SimWorlds {
  private process?: ChildProcessWithoutNullStreams
  private starting?: Promise<void>
  private serial = 0
  private pending = new Map<number, { resolve: (value: any) => void; reject: (reason: unknown) => void }>()
  private listeners = new Map<string, Set<(frame: Frame) => void>>()
  private latest = new Map<string, Frame>()
  private generations = new Map<string, number>()
  private revisions = new Map<string, number>()
  /**
   * The worker accepts line requests in one process, but callers can still
   * issue sync() concurrently (for example, a Scene edit and a reconnect).
   * Keep the ordering guarantee at the Sim owner instead of relying on the
   * worker's incidental pipe scheduling.
   */
  private handles = new Map<string, WorldHandle>()
  private syncQueues = new Map<string, Promise<void>>()
  private worlds = new Set<string>()
  /**
   * A close request stops active actions before the worker destroys the world.
   * 保留真实终态，直到同 worldId 被重新打开或 Provider 对象被回收。
   * 在途 execute 即使晚于 worker 退出，也能返回同一物理停止确认。
   */
  private terminalReceipts = new Map<string, Map<string, ActionReceipt>>()
  private closing = new Map<string, Promise<void>>()
  private closed = false
  private disposal?: Promise<void>
  /** Includes asynchronous policy resolution before a child exists. */
  private readonly shutdown = new AbortController()
  private diagnostics = ''
  private terminalError?: Error
  private exited?: Promise<void>
  private workerTermination?: Promise<void>
  private recovery?: Promise<void>
  private workerSerial = 0
  private openQueue: Promise<void> = Promise.resolve()
  private shutdownRequested = false
  /**
   * worker 自己 emit 的 phase 事件 + 传输层里程碑（spawned/ready）。83 的“Kit 启动零输出挂约 3 分钟”
   * 只有靠这条轨迹才能归因到具体阶段；不按“多久没有输出”判死任何仍有效的 worker。
   */
  private phases: { name: string; at: number }[] = []
  /** 本 Provider 的 worker 是否已交付过 ready；决定 dispose 能不能等它的 shutdown 回复。 */
  private ready = false
  /**
   * 本次 worker 启动实际取得的执行事实（会话身份/生效模式/授予根/运行根）。由装配方注入的
   * `launch` 给出；未接线的 Provider 上是 undefined——媒体中转据此判断能不能代宿主落盘。
   */
  private launchFacts?: SimWorkerLaunchFacts
  /** 本次 worker 的策略现值核对（与 `launchFacts` 同一接线给出）：写类操作前先问答一次。 */
  private policyCheck?: SimWorkerPolicyCheck
  /** worker 在 ready 里自报的执行事实（未经宿主改写），用于核对它收到的就是宿主发出的那份。 */
  private workerRuntime?: Record<string, string>
  /** worker 在 ready 里自报的 provider 能力表（原样保留、不转换）：合同侧见 `WorldHandle.capabilities`。 */
  private workerCapabilities?: Record<string, unknown>
  private mediaSerial = 0
  private readonly stopListeners=new Map<string,Set<(selection:StopSelection)=>void>>()
  constructor(readonly config: ProcessSimConfig) {
    const value = config.startupBudgetMs
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new RangeError('startupBudgetMs 必须是正的有限毫秒数；不配置即不设该上限')
  }
  get pid() { return this.process?.pid }
  private notePhase(name: string) {
    this.phases.push({ name, at: Date.now() })
    if (this.phases.length > 32) this.phases.splice(0, this.phases.length - 32)
  }
  /** 最近一次 spawn 起的阶段轨迹（相对首条阶段）；跨重启时不混入上一次 worker 的阶段。 */
  private currentPhases(): { name: string; at: number }[] {
    const spawn = this.phases.map(phase => phase.name).lastIndexOf('spawned')
    return spawn < 0 ? this.phases : this.phases.slice(spawn)
  }
  /** 只读阶段轨迹（wall-clock 相对毫秒）。供诊断、关停归因与测试取证；不含任何环境值或凭据。 */
  lifecyclePhases(): { name: string; elapsedMs: number }[] {
    const phases = this.currentPhases()
    const base = phases[0]?.at ?? Date.now()
    return phases.map(phase => ({ name: phase.name, elapsedMs: phase.at - base }))
  }
  private phaseTrail(): string {
    return this.lifecyclePhases().map(phase => `${phase.name}@+${phase.elapsedMs}ms`).join('→') || '无'
  }
  /** 启动失败/取消时的可诊断摘要：阶段、停滞时长、子进程 pid、已有 stderr 尾部。 */
  private startupDiagnostics(child: ChildProcessWithoutNullStreams, waitedMs: number): string {
    const phases = this.currentPhases()
    const last = phases[phases.length - 1]
    const stalled = last === undefined ? '（没有任何阶段事件）' : `${last.name} 之后停滞 ${Date.now() - last.at}ms`
    const tail = this.diagnostics.trim()
    return `pid=${child.pid ?? 'n/a'}，等待 ${waitedMs}ms，最后阶段=${stalled}，执行事实=${this.executionFacts()}，阶段轨迹=${this.phaseTrail()}，stderr 尾部=${tail.length === 0 ? '（worker 至今无任何 stderr/未解析输出）' : JSON.stringify(tail.slice(-800))}`
  }
  /** 本次 worker 的执行事实摘要（会话身份/生效模式/授予根/运行根；无凭据）。 */
  executionFacts(): string {
    const facts = this.launchFacts
    const worker = this.workerRuntime === undefined
      ? 'worker 未自报'
      : `worker 自报 会话=${this.workerRuntime.LYAPUNOV_SIM_SESSION ?? '缺'}，模式=${this.workerRuntime.LYAPUNOV_SIM_SANDBOX_MODE ?? '缺'}，运行根=${this.workerRuntime.LYAPUNOV_SIM_RUNTIME_ROOT ?? '缺'}`
    if (facts === undefined) return `未接线（历史直连 spawn，无沙箱与会话运行根）；${worker}`
    const privateRoot = facts.privateRootBoundary === 'os-bind' ? '会话私有目录=OS 挂载收窄' : '会话私有目录=仅应用层归属'
    // 用户模式与"引擎内部运行目录在 OS 层可写"是**两件事**，这里分开写：只读会话也能有内部可写位，
    // 报告不得把它说成用户模式放宽。
    const internal = facts.internalWritableRoots === undefined || facts.internalWritableRoots.length === 0
      ? '引擎内部可写=无'
      : `引擎内部可写=${facts.internalWritableRoots.join('、')}（${facts.internalWritableBoundary === 'os-bind' ? 'OS 挂载' : '未加挂载'}，仍是用户只读模式下的内部许可）`
    // 设备访问与文件效果同样是两件事：这里只说"引擎能不能碰到 GPU"，不改变用户模式的写法。
    const devices = facts.engineDevices === undefined || facts.engineDevices.length === 0
      ? '引擎设备=无声明'
      : `引擎设备=${facts.engineDevices.join('、')}（${facts.engineDeviceBoundary === 'device-bind' ? '本层设备挂载暴露' : '本层未挂'}）`
    return `会话=${facts.sessionId}，模式=${facts.mode}（用户模式），运行根=${facts.runtimeRoot}，授权根=${facts.writableRoot}，执行者=${facts.runner ?? '未知'}，强制=${facts.enforcement ?? '未知'}，${privateRoot}，${internal}，${devices}；${worker}`
  }
  private async terminateOwned(child: ChildProcessWithoutNullStreams, exited: Promise<void>): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return
    try { child.kill('SIGTERM') } catch { /* owned child already exited */ }
    await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 2000))])
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch { /* owned child already exited */ }
      await exited
    }
  }
  private failProvider(error: Error, child: ChildProcessWithoutNullStreams): void {
    // A late error from an old worker must never terminate or poison a newer
    // explicitly opened worker. Its terminal receipts are still accepted by
    // the line handler, but lifecycle state belongs to the current child.
    if (this.process !== child) return
    if (this.terminalError === undefined) this.terminalError = error
    if (this.process === child) this.workerSerial++
    const failure = this.terminalError
    for (const call of this.pending.values()) call.reject(failure)
    this.pending.clear()
    this.latest.clear(); this.worlds.clear(); this.generations.clear(); this.revisions.clear(); this.handles.clear(); this.syncQueues.clear()
    if (!this.shutdownRequested) {
      const exited = this.exited
      if (exited) this.workerTermination ??= this.terminateOwned(child, exited)
    }
  }
  /** Background calls remain terminal; only an explicit user open may replace the owned worker. */
  private async prepareExplicitOpen(): Promise<void> {
    if (this.terminalError === undefined) return
    this.recovery ??= (async () => {
      if (this.workerTermination) await this.workerTermination
      if (this.exited) await this.exited
      this.process = undefined; this.starting = undefined; this.exited = undefined; this.workerTermination = undefined
      this.terminalError = undefined; this.shutdownRequested = false; this.ready = false
    })()
    await this.recovery
    this.recovery = undefined
  }
  /**
   * 启动本 Provider 自己的 worker。只有显式 open 会调用它（其余方法不启动 SDK）。
   * `signal` 是调用方的取消；`startupBudgetMs` 是显式配置的启动预算。两者都只结束
   * **本次自己尚未 ready 的启动**，都不产生自动重试：失败后只有新的显式 open 能重新启动。
   */
  private start(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new SimError('PROVIDER_CLOSED', 'Provider 已释放'))
    if (this.terminalError) return Promise.reject(this.terminalError)
    if (this.starting) return this.starting
    this.starting = this.launchWorker(signal)
    return this.starting
  }
  /**
   * 解析本次执行接线（原生策略/沙箱包裹）再启动。接线失败是**终态**：不自动回落成不受约束的启动，
   * 也不重试——「拒绝在无沙箱后端时静默放行」与「不拿 full-access 绕过沙箱失败」都落在这一处。
   */
  private async launchWorker(signal?: AbortSignal): Promise<void> {
    const python = this.config.pythonPath
    const worker = this.config.workerPath
    if (!existsSync(python)) {
      const error = new SimError('PROVIDER_UNAVAILABLE', `${this.config.engineName} Python 环境不存在: ${python}`)
      this.terminalError = error
      throw error
    }
    const inherited: Record<string, string> = { ...process.env, ...this.config.env, HF_ENDPOINT: 'https://hf-mirror.com' } as Record<string, string>
    let spec: SimWorkerLaunchSpec = { argv: [python, '-u', worker], env: inherited, facts: undefined as never }
    const setup = new AbortController()
    const abortSetup = () => setup.abort(this.closed
      ? new SimError('PROVIDER_CLOSED', 'PROVIDER_CLOSED：Provider 在启动接线期间已释放（未启动 worker）')
      : new SimError('PROVIDER_START_CANCELLED', 'PROVIDER_START_CANCELLED：启动接线被取消（未启动 worker）'))
    this.shutdown.signal.addEventListener('abort', abortSetup, { once: true })
    signal?.addEventListener('abort', abortSetup, { once: true })
    let onSetupAbort: (() => void) | undefined
    try {
      if (this.closed || signal?.aborted) abortSetup()
      setup.signal.throwIfAborted()
      if (this.config.launch) {
        const cancelled = new Promise<never>((_, reject) => {
          onSetupAbort = () => reject(setup.signal.reason)
          setup.signal.addEventListener('abort', onSetupAbort, { once: true })
        })
        // The hook may ignore cancellation. Only this awaited winner can proceed
        // to spawn; a late hook result is consumed without creating a child.
        spec = await Promise.race([
          this.config.launch({ pythonPath: python, workerPath: worker, env: inherited, signal: setup.signal }),
          cancelled,
        ])
      }
      if (this.closed || signal?.aborted) abortSetup()
      setup.signal.throwIfAborted()
    } catch (failure) {
      const error = failure instanceof SimError ? failure
        : new SimError('PROVIDER_EXECUTION_UNAVAILABLE', `${this.config.engineName} worker 启动接线失败（不回落为不受约束的启动）：${failure instanceof Error ? failure.message : String(failure)}`)
      this.terminalError = error
      throw error
    } finally {
      this.shutdown.signal.removeEventListener('abort', abortSetup)
      signal?.removeEventListener('abort', abortSetup)
      if (onSetupAbort) setup.signal.removeEventListener('abort', onSetupAbort)
    }
    this.launchFacts = spec.facts
    this.policyCheck = spec.check
    return await this.spawnWorker(spec, signal)
  }
  private spawnWorker(spec: SimWorkerLaunchSpec, signal?: AbortSignal): Promise<void> {
    const { argv, env } = spec
    let budgetTimer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    /** 只表示「本次启动的 Promise 已经结算」（ready / 取消 / 预算到期），**不是**「worker 生命周期结束」。 */
    let startupSettled = false
    return new Promise<void>((ready, reject) => {
      // The launch hook and disposal can race at this boundary.  Keep the
      // final guard next to spawn so a late hook result can never create a
      // child after dispose has already cancelled this provider.
      if (this.closed || this.shutdown.signal.aborted) {
        reject(new SimError('PROVIDER_CLOSED', `${this.config.engineName} Provider 已释放，未启动 worker`))
        return
      }
      const startedAt = Date.now()
      const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: env ?? {}, ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }) })
      this.process = child
      this.ready = false
      // 新 worker 还没自报：上一只的能力表不能留给它（否则会把已死 worker 的能力当成现役事实）。
      this.workerCapabilities = undefined
      const workerId = ++this.workerSerial
      this.notePhase('spawned')
      const exited = new Promise<void>(done => { child.once('close', () => done()); child.once('error', () => done()) })
      this.exited = exited
      /** 本次启动的收尾：撤销预算/取消监听，再进入 failProvider（登记终态错误并终止这个 owned child）。 */
      const detach = () => {
        startupSettled = true
        if (budgetTimer !== undefined) { clearTimeout(budgetTimer); budgetTimer = undefined }
        if (onAbort !== undefined) { signal?.removeEventListener('abort', onAbort); onAbort = undefined }
      }
      const abortStartup = (code: string, reason: string) => {
        // 取消/预算只针对**尚未 ready 的启动**：已经交付 ready 之后，worker 的生死走 failProvider（见 failed）。
        if (startupSettled) return
        detach()
        // 错误码写进 message：工具/命令边界只把 message 交给调用方（SimError.code 在那一层看不到），
        // 走到模型面前也要能一眼分清「用户取消」和「显式预算到期」。
        const error = new SimError(code, `${code}：${this.config.engineName} worker ${reason}：${this.startupDiagnostics(child, Date.now() - startedAt)}`)
        this.failProvider(error, child)
        reject(this.terminalError ?? error)
      }
      const budget = this.config.startupBudgetMs
      if (budget !== undefined) budgetTimer = setTimeout(() => abortStartup('PROVIDER_START_TIMEOUT', `启动超过显式配置的启动预算 ${budget}ms（未收到 ready）`), budget)
      if (signal) {
        onAbort = () => abortStartup('PROVIDER_START_CANCELLED', '启动被显式取消（未收到 ready）')
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
      child.stderr.on('data', data => { this.diagnostics = (this.diagnostics + String(data)).slice(-6000) })
      child.stdin.on('error', error => this.failProvider(new SimError('PROVIDER_PIPE_BROKEN', `${this.config.engineName} worker stdin 断开: ${error.message}`), child))
      child.stdout.on('error', error => this.failProvider(new SimError('PROVIDER_PIPE_BROKEN', `${this.config.engineName} worker stdout 断开: ${error.message}`), child))
      const lines = createInterface({ input: child.stdout })
      lines.on('line', line => {
        let message: any
        try { message = decodePythonMessage(line) } catch { this.diagnostics = (this.diagnostics + line).slice(-6000); return }
        if (this.process !== child || workerId !== this.workerSerial) {
          if (message.event === 'receipt') this.rememberReceipt(message.receipt as ActionReceipt)
          return
        }
        // worker 的阶段事件（启动/关闭各阶段）只进生命周期轨迹：它们既不是回执也不触发任何
        // 自动动作，尤其不会因为“某阶段停了很久”去终止一个仍有效的 worker。
        if (message.event === 'phase') { this.notePhase(String(message.phase)); return }
        if (message.event === 'ready') {
          if (startupSettled) return
          // worker 自报的执行事实（它真的收到了哪份身份/模式/运行根），与宿主侧 facts 对照用。
          if (message.runtime !== undefined) this.workerRuntime = message.runtime
          // provider 自报的能力表（Newton 等）：**原样保留**，不转换、不裁剪，交付时挂在句柄上（见 adoptHandle）。
          if (message.capabilities !== undefined) this.workerCapabilities = message.capabilities
          detach(); this.notePhase('ready'); this.ready = true; ready(); return
        }
        if (message.event === 'fatal') {
          // provider 的只读启动事实（SDK/许可/Kit/PhysX 阶段）随同一错误回执保存，
          // 不重新分类、不把 details 丢掉后让调用方猜启动已经走到了哪里。
          const error = new SimError(message.error.code, message.error.message, message.error.details)
          failed(error)
          return
        }
        if (message.event === 'receipt') { this.rememberReceipt(message.receipt as ActionReceipt); return }
        if (message.event === 'frame') {
          const frame = message.frame as Frame
          const generation = this.generations.get(frame.worldId)
          if (generation !== undefined && frame.generation < generation) return
          const revision = this.revisions.get(frame.worldId)
          // Once a world has been opened through this transport, an old or
          // revision-unknown frame cannot be replayed as the current source.
          if (revision !== undefined && frame.sceneRevision !== revision) return
          const old = this.latest.get(frame.worldId)
          if (old && (frame.generation < old.generation || frame.generation === old.generation && (frame.sceneRevision !== old.sceneRevision || frame.stepIndex < old.stepIndex))) return
          this.latest.set(frame.worldId, frame)
          for (const listener of this.listeners.get(frame.worldId) ?? []) {
            try { listener(structuredClone(frame)) } catch { /* 订阅者异常不能中断物理 owner。 */ }
          }
          return
        }
        const call = this.pending.get(message.id)
        if (!call) return
        this.pending.delete(message.id)
        if (message.error) call.reject(new SimError(message.error.code, message.error.message))
        else call.resolve(message.result)
      })
      const failed = (error: Error) => {
        // 这里**不**看 startupSettled：它只表示启动 Promise 已经结算，不代表 worker 生命周期结束。
        // ready 之后的真实退出/fatal 必须照样走 failProvider（拒绝全部在途、清掉失效句柄）。陈旧 worker
        // 的事件由 failProvider 的 `this.process !== child` 与行读取器的 workerSerial 挡住；这里不重启。
        detach()
        this.failProvider(error, child)
        // 以已登记的终态为准：dispose 结束一个尚未 ready 的启动时，退出事件只是它的后果，
        // 调用方要看到的是「Provider 已释放」这条终态原因，而不是被 SIGTERM 的退出码。
        reject(this.terminalError ?? error)
      }
      child.once('error', error => failed(new SimError('PROVIDER_UNAVAILABLE', error.message)))
      child.once('exit', (code, signal) => failed(new SimError('PROVIDER_EXITED', `${this.config.engineName} worker 退出 (${code ?? signal}) ${this.diagnostics}`)))
    })
  }
  private async request<T>(method: string, args: Record<string, unknown>, expectedChild?: ChildProcessWithoutNullStreams, allowStart = false): Promise<T> {
    if (this.closed && method !== 'shutdown') throw new SimError('PROVIDER_CLOSED', 'Provider 已释放')
    if (allowStart) await this.start()
    else if (!this.process) throw new SimError('PROVIDER_UNAVAILABLE', `${this.config.engineName} worker 未启动；仅显式 open 可以启动`)
    if (this.terminalError) throw this.terminalError
    const child = expectedChild ?? this.process
    if (!child || this.process !== child) throw new SimError('PROVIDER_REPLACED', `${this.config.engineName} worker 已更换`)
    const id = ++this.serial
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const line = JSON.stringify({ id, method, args }) + '\n'
      try {
        if (child.stdin.destroyed || child.stdin.writableEnded) throw new SimError('PROVIDER_PIPE_BROKEN', `${this.config.engineName} worker stdin 已关闭`)
        child.stdin.write(line, error => {
          if (!error) return
          this.pending.delete(id)
          this.failProvider(new SimError('PROVIDER_PIPE_BROKEN', `${this.config.engineName} worker stdin 写入失败: ${error.message}`), child)
          reject(this.terminalError ?? error)
        })
      } catch (error) {
        this.pending.delete(id)
        const failure = error instanceof SimError ? error : new SimError('PROVIDER_PIPE_BROKEN', String(error))
        this.failProvider(failure, child)
        reject(failure)
      }
    })
  }
  /**
   * 显式建立世界。`signal` 是调用方（工具面）的取消：它只结束**本次尚未交付的 open**——
   * 没起 worker 时直接拒绝、起了就按归属终止这一个 owned child；世界一旦返回给调用方，
   * 取消就与它无关（结束已交付的世界仍然只能走 close）。
   */
  async open(snapshot: SceneSnapshot, options: WorldOptions = {}, signal?: AbortSignal): Promise<WorldHandle> {
    if (signal?.aborted) throw new SimError('CANCELLED', 'open 在派生 worker 前已取消')
    if (options.startPaused !== undefined && typeof options.startPaused !== 'boolean') throw new SimError('INVALID_ARGUMENT', 'startPaused 必须为 boolean')
    const previous = this.openQueue
    let release!: () => void
    const turn = new Promise<void>(resolve => { release = resolve })
    this.openQueue = previous.catch(() => undefined).then(() => turn)
    let onAbort: (() => void) | undefined
    let cleanup: Promise<unknown> | undefined
    // 本次 open 期间钩子对自己缓存的每一次改动都记在这里，失败/取消时按对象身份逐条回滚。
    const openWrites: { key: string; after: unknown; before: unknown }[] = []
    try {
      // 排队等待期间取消：本次 open 还没开始，既不启动也不结束任何 worker，也不陪前一个 open 一起等
      // （前一个可能是分钟级的 Kit 冷启动）。立刻返回；队列照常释放。
      if (signal === undefined) await previous
      else {
        let onWaiting: (() => void) | undefined
        const queued = new Promise<never>((_resolve, reject) => {
          onWaiting = () => reject(new SimError('PROVIDER_START_CANCELLED', `PROVIDER_START_CANCELLED：${this.config.engineName} open 在排队等待期间被取消（未启动、未结束任何 worker）`))
          if (signal.aborted) onWaiting()
          else signal.addEventListener('abort', onWaiting, { once: true })
        })
        try { await Promise.race([previous, queued]) }
        finally { if (onWaiting) signal.removeEventListener('abort', onWaiting) }
      }
      await this.prepareExplicitOpen()
      if (this.closed) throw new SimError('PROVIDER_CLOSED', 'Provider 已释放')
      // 建立/复用世界是**物理生命周期**，不看 Agent 模式：模式互切不结束 worker、不拦 open。复用既有 worker
      // 时它留在启动时那份沙箱里（本层不提升、不重挂）；用户产物落盘的授权另在 `requireUserFacingWrite` 的
      // IO 边界上按会话**当前**策略判定。真正结束世界仍只走显式 close/stop 与引擎故障。
      if (signal?.aborted) throw new SimError('CANCELLED', 'open 在启动 worker 之前已取消（未启动任何 worker）')
      if (options.worldId && this.closing.has(options.worldId) && this.worlds.has(options.worldId)) throw new SimError('WORLD_CLOSING', '世界正在关闭')
      await this.start(signal)
      const worker = this.process
      if (!worker) throw new SimError('PROVIDER_UNAVAILABLE', `${this.config.engineName} worker 未启动`)
      // worker 已 ready、世界尚未交付：从 syncArgsExtras 到 worker 回复 open 这一段都挂在同一个取消上。
      const openedAt = Date.now()
      // 只有**确实独占**这个 child 的启动才整进程终止；一个 worker 复用多个 world 时（MuJoCo），
      // 取消新的 open 不牵连同 worker 上已交付的 world。
      let cancelled: SimError | undefined
      let rejectCancellation!: (error: SimError) => void
      const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject })
      cancellation.catch(() => undefined)
      onAbort = () => {
        const error = new SimError('PROVIDER_START_CANCELLED', `PROVIDER_START_CANCELLED：${this.config.engineName} open 在 worker ready 之后、世界交付之前被取消：${this.startupDiagnostics(worker, Date.now() - openedAt)}`)
        cancelled = error
        if (this.handles.size === 0 && this.worlds.size === 0) this.failProvider(error, worker)
        rejectCancellation(error)
      }
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
      // open 与 sync 走同一追加通道（如场景碰撞补丁）：初始世界就带碰撞环境，不等首次 sync。
      // 取消必须能打断这段等待（碰撞编译可能很久），所以与取消竞速；晚到的 extras 由 catch 兜住，
      // 不发送本次 open，也由钩子自己按 signal 决定不写缓存。
      const extrasPromise = Promise.resolve(this.syncArgsExtras(options.worldId ?? '', snapshot, {}, signal,
        (key, after, before) => { openWrites.push({ key, after, before }) }))
      void extrasPromise.catch(() => undefined)
      const extras = await Promise.race([extrasPromise, cancellation])
      // 同一个 worldId 被重新开成新世界时，上一次留下的终态不能冒充本次世界的终态；只清「发出本次
      // 请求之前」已登记的条目（worker 可能先回 open 再补发本次世界自己的终态回执，那份属于新世界）。
      const staleReceipts = options.worldId === undefined ? undefined : this.terminalReceipts.get(options.worldId)
      const staleReceiptKeys = staleReceipts === undefined ? undefined : [...staleReceipts.keys()]
      // 取消发生在请求发出之前（例如卡在碰撞补丁编译里）：本次 open 根本没到 worker，直接结束。
      if (cancelled !== undefined) throw cancelled
      const opening = this.request<WorldHandle>('open', { snapshot, options, ...extras }, worker)
      // 隔离取消时 worker 很可能已经把这个世界建出来：这条回复不能丢，否则 worker 里就留下一个孤儿世界。
      // 接手迟到回复把它就地关掉（只关这一个），并让收尾占用本次 open 的队列槽位（见 finally）。
      const raced = Promise.race([opening, cancellation])
      // 结论先落地：交付了（或 worker 自己失败）就什么都不做；**是取消赢的**才接手 worker 迟到建出来的
      // 世界，把它就地关掉（只关这一个）。收尾占用本次 open 的队列槽位（见 finally）。
      cleanup = raced.then(
        () => undefined,
        () => cancelled === undefined ? undefined : opening.then(handle => this.closeAbandonedWorld(handle.worldId, worker, staleReceiptKeys), () => undefined),
      )
      const opened = await raced
      if (options.startPaused === true && (opened.status !== 'paused' || opened.supportsPause !== true)) {
        await this.closeAbandonedWorld(opened.worldId, worker, staleReceiptKeys)
        throw new SimError('CLOCK_CONTROL_UNSUPPORTED', 'Provider 未确认首物理步前的暂停准备，未交付该世界')
      }
      const handle = this.syncHandleExtras(opened, opened.worldId, snapshot)
      if (staleReceipts) for (const actionId of staleReceiptKeys ?? []) staleReceipts.delete(actionId)
      this.closing.delete(handle.worldId)
      this.adoptHandle(handle)
      return handle
    } catch (error) {
      // 本次 open 没交付：让提供方按它自己记录的写入清单回滚（默认无写入即无动作）。
      this.revertOwnWrites(openWrites)
      throw error
    } finally {
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
      // 有迟到收尾（被取消的 open 关掉它建出来的世界）时，收尾继续占用本次 open 的队列槽位：
      // 调用方早已拿到取消，不会被它阻塞，而同 id 的新 open 一定排在收尾之后，两者不会互相覆盖。
      // 收尾本身在 worker 回复（或按归属结束、全部在途被拒）时结算，队列不会被无限占住。
      if (cleanup === undefined) release()
      else void cleanup.then(release, release)
    }
  }
  /**
   * 回滚一次未交付 open 自己写下的提供方缓存条目（默认提供方没有缓存，什么都不做）。
   * 只回滚**对象身份仍是本次写入**的那些键：同一键上后写的对象（并行 sync、另一个 open）不是本次的写入，
   * 一律不动；回滚按写入顺序的逆序做，`before` 为空表示这次写之前该键本来不存在。
   */
  protected revertOwnWrites(_writes: { key: string; after: unknown; before: unknown }[]): void {}
  hasSceneWorld(sceneId: string): boolean {
    if (this.closed) throw new SimError('PROVIDER_CLOSED', 'Provider 已释放')
    return [...this.handles.values()].some(handle => handle.sceneId === sceneId && handle.status !== 'closed')
  }
  async listWorlds(): Promise<WorldHandle[]> {
    if(this.closed)throw new SimError('PROVIDER_CLOSED','Provider 已释放')
    if(!this.process)return []
    const handles = await this.request<WorldHandle[]>('list_worlds',{})
    for (const handle of handles) this.adoptHandle(handle)
    return handles
  }
  /**
   * 提供方钩子：为本次 sync/open 追加额外请求参数（如 MuJoCo 的场景碰撞补丁
   * collisionPatches）。默认无追加；其他 Provider 行为不变。
   * `signal` 在 open 路径上就是调用方的取消信号：钩子里的昂贵步骤跑完之后要先看它，
   * 已取消就不要再写自己的缓存（这次 open 不会发出去）。
   * `written` 只在 open 路径上给出：钩子每改一次自己的缓存就报一条 `(键, 改后的对象, 改前的对象)`，
   * 供 open 失败/取消时**只回滚本次确实写下的**条目。身份比较做不到这件事：同一个键上可能有并行的
   * sync（或另一个 open）在本 open 之后写入，那时"变了"不等于"是我写的"。
   */
  protected syncArgsExtras(_worldId: string, _snapshot: SceneSnapshot, _options: { forceRebuild?: boolean }, _signal?: AbortSignal, _written?: (key: string, after: unknown, before: unknown) => void): Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined {
    return undefined
  }
  /**
   * 提供方钩子：加工 worker 返回的 sync 句柄（如把提供方侧编译告警并入
   * handle.warnings）。默认原样返回。
   */
  protected syncHandleExtras(handle: WorldHandle, _worldId: string, _snapshot: SceneSnapshot): WorldHandle {
    return handle
  }
  async sync(worldId: string, snapshot: SceneSnapshot, options: { forceRebuild?: boolean } = {}): Promise<WorldHandle> {
    if (this.closed) throw new SimError('PROVIDER_CLOSED', 'Provider 已释放')
    // sync 是**物理世界**的同步：Agent 模式互切（readonly/write/full）本身不拦它、不结束 worker。worker
    // 仍在自己启动时那份原生沙箱里执行，写不写引擎别名由原生沙箱说了算；本层不按模式把它拒掉。
    if (this.closing.has(worldId)) throw new SimError('WORLD_CLOSING', '世界正在关闭')
    const previous = this.syncQueues.get(worldId) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(async () => {
      const current = this.handles.get(worldId)
      // Scene revisions are monotonic within the Scene a world is bound to,
      // not across Scenes. A reconnect or an older UI request must not roll a
      // world back after a newer sync has completed, but only a same-Scene
      // snapshot may take that shortcut: a different sceneId must reach the
      // Provider, which owns the world/Scene identity check (MuJoCo raises
      // SCENE_MISMATCH instead of binding another Scene). An explicit
      // forceRebuild remains the escape hatch for a same/older revision when
      // the caller intentionally needs a fresh model.
      // 同 revision 的显式 sync 仍交给 worker，执行清除临时相机覆盖等既定语义；只挡住旧快照回滚。
      if (current && !options.forceRebuild && snapshot.sceneId === current.sceneId && snapshot.revision < current.appliedSceneRevision) return current
      const worker = this.process
      if (!worker) throw new SimError('PROVIDER_UNAVAILABLE', `${this.config.engineName} worker 未启动`)
      const extras = await this.syncArgsExtras(worldId, snapshot, options)
      const handle = this.syncHandleExtras(await this.request<WorldHandle>('sync', { worldId, snapshot, options, ...extras }, worker), worldId, snapshot)
      if (this.process !== worker) throw new SimError('PROVIDER_REPLACED', `${this.config.engineName} worker 已更换`)
      const latest = this.handles.get(worldId)
      if (latest && !options.forceRebuild && latest.sceneId === handle.sceneId && latest.appliedSceneRevision > handle.appliedSceneRevision) return latest
      this.adoptHandle(handle)
      const frame = this.latest.get(worldId)
      if (frame && (frame.generation !== handle.worldGeneration || frame.sceneRevision !== handle.appliedSceneRevision)) this.latest.delete(worldId)
      return handle
    })
    const settled = run.then(() => undefined, () => undefined)
    this.syncQueues.set(worldId, settled)
    try { return await run }
    finally { if (this.syncQueues.get(worldId) === settled) this.syncQueues.delete(worldId) }
  }
  describe(worldId: string, entityId: string) { return this.request<RobotDescription>('describe', { worldId, entityId }) }
  observe(worldId: string, selection: ObservationSelection = {}) { return this.request<Frame>('observe', { worldId, selection }) }
  async setPaused(worldId:string,paused:boolean,expectedGeneration:number){
    // 暂停/继续是**物理世界生命周期**的一部分，不看 Agent 模式：模式互切不能把它拦下或结束世界。
    const bound=this.handles.get(worldId)
    if(!bound)throw new SimError('WORLD_NOT_FOUND','暂停目标世界不存在')
    if(bound.supportsPause!==true)throw new SimError('CLOCK_CONTROL_UNSUPPORTED','当前原生世界没有自报暂停/继续能力')
    const handle=await this.request<WorldHandle>('set_paused',{worldId,paused,expectedGeneration})
    this.adoptHandle(handle);return handle
  }
  async receipt(worldId: string, actionId: string, expectedChild?: ChildProcessWithoutNullStreams) {
    const completed = this.terminalReceipts.get(worldId)?.get(actionId)
    if (completed) return structuredClone(completed)
    try {
      const receipt = await this.request<ActionReceipt>('receipt', { worldId, actionId }, expectedChild)
      this.rememberReceipt(receipt)
      return receipt
    } catch (error) {
      // close/shutdown 在回复后可能已销毁 worker；真实终态事件仍然有效。
      const cached = this.terminalReceipts.get(worldId)?.get(actionId)
      if (cached) return structuredClone(cached)
      throw error
    }
  }
  terminalResults(worldId: string): ActionReceipt[] {
    return [...(this.terminalReceipts.get(worldId)?.values() ?? [])].map(receipt => structuredClone(receipt))
  }
  private rememberReceipt(receipt: ActionReceipt) {
    if (receipt.status === 'accepted' || receipt.status === 'running') return
    let receipts = this.terminalReceipts.get(receipt.worldId)
    if (!receipts) this.terminalReceipts.set(receipt.worldId, receipts = new Map())
    receipts.set(receipt.actionId, structuredClone(receipt))
  }
  async execute(worldId: string, action: SimAction, signal?: AbortSignal): Promise<ActionReceipt> {
    if (this.closing.has(worldId)) throw new SimError('WORLD_CLOSING', '世界正在关闭')
    if (signal?.aborted) throw new SimError('CANCELLED', '动作在提交前已取消')
    let stopping: Promise<unknown> | undefined
    const worker = this.process
    if (!worker) throw new SimError('PROVIDER_UNAVAILABLE', `${this.config.engineName} worker 未启动`)
    const abort = () => { stopping ??= this.stop(worldId, { actionId: action.actionId, expectedGeneration: action.expectedGeneration }, worker); void stopping.catch(() => {}) }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      let result = await this.request<ActionReceipt>('execute', { worldId, action }, worker)
      if (signal?.aborted) abort()
      while (result.status === 'accepted' || result.status === 'running') {
        await new Promise(resolve => setTimeout(resolve, 20))
        result = await this.receipt(worldId, action.actionId, worker)
      }
      if (stopping) try { await stopping } catch (error) {
        // 重建已产生此动作的真实终态时，迟到的停止不得触碰新代次，
        // 也不以停止的代次错误覆盖已经收到的原动作回执。
        if (!(error instanceof SimError) || error.code !== 'STALE_GENERATION' || result.generation !== action.expectedGeneration) throw error
      }
      this.rememberReceipt(result)
      return result
    } finally { signal?.removeEventListener('abort', abort) }
  }
  async stop(worldId: string, selection: StopSelection = {}, expectedChild?: ChildProcessWithoutNullStreams) {
    const result = await this.request<{ stopped: true; stepIndex: number; receipts: ActionReceipt[]; affectedEntityIds?: string[] }>('stop', { worldId, selection }, expectedChild)
    for (const receipt of result.receipts) this.rememberReceipt(receipt)
    if(result.stopped)for(const listener of this.stopListeners.get(worldId)??[])try{listener(structuredClone(selection))}catch{ /* 观察方错误不能撤销已确认的原生停止 */ }
    return result
  }
  subscribeStops(worldId:string,listener:(selection:StopSelection)=>void){
    let set=this.stopListeners.get(worldId);if(!set)this.stopListeners.set(worldId,set=new Set())
    set.add(listener);return()=>{set!.delete(listener);if(!set!.size)this.stopListeners.delete(worldId)}
  }
  subscribeFrames(worldId: string, listener: (frame: Frame) => void) {
    let set = this.listeners.get(worldId)
    if (!set) this.listeners.set(worldId, set = new Set())
    set.add(listener)
    const latest = this.latest.get(worldId)
    if (latest && latest.sceneRevision === this.revisions.get(worldId)) listener(structuredClone(latest))
    return () => { set!.delete(listener); if (!set!.size) this.listeners.delete(worldId) }
  }
  close(worldId: string): Promise<void> {
    if (this.closed) return Promise.reject(new SimError('PROVIDER_CLOSED', 'Provider 已释放'))
    const existing = this.closing.get(worldId)
    if (existing) return existing
    const closing = Promise.resolve().then(async () => {
      const pending = this.syncQueues.get(worldId)
      if (pending) await pending
      await this.stop(worldId, {})
      await this.request('close', { worldId })
      this.worlds.delete(worldId); this.latest.delete(worldId); this.listeners.delete(worldId); this.generations.delete(worldId); this.revisions.delete(worldId); this.handles.delete(worldId)
    })
    this.closing.set(worldId, closing)
    return closing
  }
  assist(worldId: string, options: { mode: 'attach' | 'release'; expectedGeneration: number; objectId: string; robotId?: string; anchorBody?: string }) { return this.request<Record<string, unknown>>('assist', { worldId, options }) }
  /**
   * 媒体产物落盘中转的判定。会话内部的采集/录制目录在产品会话存储里，可能落在本次原生授权的写入根
   * **之外**（`workspace-write` 只授予 workspace 根与平台临时区）。这类写入在授权根内的中转目录先落盘，
   * 返回后由宿主（本就拥有该会话产品根的一方）按原路径代落盘，回执里的中转路径改写回原路径。
   * 只对**本会话自己的产品根**内的目标中转；调用方给的任意越界路径一律不中转——让 worker 侧真实的
   * 拒绝（EROFS/EACCES）照原样浮上来，不用应用层代写把越界写入伪装成"策略允许"。
   * `danger-full-access` 无文件效果约束、`read-only` 一律没有可写中转位置，两者都直接透传。
   *
   * 这里的 `pathWithin` 按**规范路径**判定（`lyapunov-contracts/writable-boundary`，与场景/资产工具那条
   * 宿主代写边界同一份规则）：产品根是**按会话键**展开的 `<产品根>/sessions/<本会话键>`，所以"canonically
   * 落在本会话产品根内"同时就是会话归属核对——工作区里的链接、产品根里的链接指向别处（包括别的会话的
   * 私有目录或授权根外）都会因为真实目标不在本会话命名空间里而被拒，中转不再照着链接代写。
   *
   * 代写目标必须**能证明落点**：`..` 组件在真正落盘时按内核语义解析（先展开符号链接再回退），而这里
   * 手上只有词法路径工具；两者在「链接 + ..」上不一致，证明不了落到哪就**不中转**——让 worker 自己按
   * 它的沙箱处理，宿主一个字节都不代写（否则就成了"写出去的是别处、判定看的是原处"）。
   */
  /**
   * **用户产物落盘**（截图/多机位/数据集导出）在真正派发/发布写入前的**当前授权**断言。
   *
   * 物理世界生命周期与 Agent 模式互切已经解耦（见 `open`/`sync`/`setPaused`）：模式变化本身不结束 worker、
   * 不销毁世界；但用户文件效果必须在落盘那一刻按该会话**当前**有效策略授权，不能沿用 worker 启动时的旧许可。
   * 这里复用启动接线给出的 {@link SimWorkerPolicyCheck}（与启动同一条 resolve 链）重解析一次现值：
   *   · 核不出来（会话已不在等）⇒ 拒绝本次写入，但**不**结束 worker、不动已交付的世界（失败关闭但保留世界）；
   *   · 现值不再包含这只 worker 启动时携带的许可（被收紧过）⇒ 同样拒绝本次写入，老 worker 不能借旧许可写出文件；
   *   · 现值是 read-only ⇒ 用户产物没有可写位（只读下唯一可写的是引擎内部运行目录，不面向用户产物），拒绝；
   *   · 其余（现值 workspace-write / danger-full-access 且仍包含本 worker）⇒ 放行，交给既有 {@link stagingFor} 边界。
   * 内部计算缓存/临时目录的写入不经过这条边界（见 {@link SimWorkerLaunchFacts.internalWritableRoots}）。
   * 未接线（历史直连）或未给出核对时保持历史行为，不在这里新增拒绝。
   * @param action - 出现在错误里的动作名（哪个落盘请求被拒）。
   * @param phase - 派发或发布边界；发布前拒绝不能声称 worker 尚未写过内部暂存。
   */
  private async requireUserFacingWrite(action: string, phase: 'dispatch' | 'publish' = 'dispatch'): Promise<void> {
    const facts = this.launchFacts
    const check = this.policyCheck
    if (facts === undefined || check === undefined) return
    // 发布前 worker 已经可以写过内部暂存，不能再声称“没有派发/没有任何写入”。
    const effect = phase === 'dispatch'
      ? 'This request was denied before dispatch; no user write request was sent to the worker.'
      : 'This request was denied before publication; internal staging files may already exist, but publication to the user target was not started.'
    const preserved = 'The worker and existing worlds remain unchanged.'
    let verdict: SimWorkerPolicyVerdict
    try {
      verdict = await check(facts)
    } catch (failure) {
      throw new SimError('SIM_MEDIA_POLICY_UNVERIFIED', `${this.config.engineName} ${action}: current session file authorization could not be verified (${failure instanceof Error ? failure.message : String(failure)}). ${effect} ${preserved}`)
    }
    if (verdict.stale) {
      throw new SimError('SIM_MEDIA_POLICY_STALE', `${this.config.engineName} ${action}: the worker's launch authorization is no longer contained in the current session policy (${verdict.detail}). ${effect} ${preserved}`)
    }
    if (verdict.current.mode === 'read-only') {
      throw new SimError('SIM_MEDIA_POLICY_READ_ONLY', `${this.config.engineName} ${action}: the current session policy is read-only; engine-internal cache permissions do not authorize user output files. ${effect} ${preserved} Switch this session to a writable mode before saving user output.`)
    }
  }
  private stagingFor(outputDir: string): { staged: string; publish: string } | undefined {
    const facts = this.launchFacts
    if (facts === undefined || facts.mode !== 'workspace-write') return undefined
    if (outputDir.split(/[\\/]/).includes('..')) return undefined
    if (pathWithin(facts.writableRoot, outputDir) || pathWithin('/tmp', outputDir) || pathWithin(tmpdir(), outputDir)) return undefined
    if (!pathWithin(facts.writableRoot, facts.runtimeRoot)) return undefined
    if (!(facts.productRoots ?? []).some(product => pathWithin(product, outputDir))) return undefined
    return { staged: join(facts.runtimeRoot, 'staging', `media-${++this.mediaSerial}`), publish: outputDir }
  }
  /**
   * 用户产物的暂存/发布中转。派发前已由 {@link requireUserFacingWrite} 授权；**发布前再核对一次**：
   * worker 写暂存期间会话模式可能被收紧，宿主不能用一个已经过期的许可把它代写进产品根。拒绝时暂存目录
   * 由 `finally` 清掉、不发布也不改写回执；worker 与已交付的世界保持不动（不 failProvider、不杀 world）。
   * @param action - 发布前再核对的用户可见动作名；省略表示不核对（内部中转调用点）。
   */
  private async stageMedia<T>(outputDir: string, run: (outputDir: string) => Promise<T>, published?: (result: T, from: string, to: string) => Promise<void>, action?: string): Promise<T> {
    const plan = this.stagingFor(outputDir)
    if (plan === undefined) return run(outputDir)
    await mkdir(plan.staged, { recursive: true })
    try {
      const result = await run(plan.staged)
      if (action !== undefined) await this.requireUserFacingWrite(action, 'publish')
      await publishDirectory(plan.staged, plan.publish)
      await published?.(result, plan.staged, plan.publish)
      return rewriteStagedUris(result, plan.staged, plan.publish)
    } finally {
      await rm(plan.staged, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  private async publishCapture(worldId: string, result: Record<string, unknown>, fromDir: string, toDir: string): Promise<void> {
    if (typeof result.captureId !== 'string') return
    // 文件已由宿主发布；同步 worker 的登记路径，标注与导出才能继续消费这次真实采集。
    await this.request('capture_publish', { worldId, captureId: result.captureId, fromDir, toDir })
  }
  async capture(worldId: string, options: CaptureOptions) {
    await this.requireUserFacingWrite('sensor_capture')
    return this.stageMedia(options.outputDir, outputDir => this.request<Record<string, unknown>>('capture', { worldId, options: { ...options, outputDir } }), (result, from, to) => this.publishCapture(worldId, result, from, to), 'sensor_capture')
  }
  async captureMulti(worldId: string, options: MultiCaptureOptions) {
    await this.requireUserFacingWrite('camera_capture_multi')
    return this.stageMedia(options.outputDir, outputDir => this.request<Record<string, unknown>>('capture_multi', { worldId, options: { ...options, outputDir } }), (result, from, to) => this.publishCapture(worldId, result, from, to), 'camera_capture_multi')
  }
  listCameras(worldId: string) { return this.request<Record<string, unknown>>('camera_list', { worldId, options: {} }) }
  adjustCamera(worldId: string, options: CameraAdjustOptions) { return this.request<Record<string, unknown>>('camera_adjust', { worldId, options }) }
  projectAnnotation(worldId: string, options: CameraAnnotationOptions) { return this.request<Record<string, unknown>>('camera_project_annotation', { worldId, options }) }
  async exportCameraDataset(worldId: string, options: CameraDatasetExportOptions) {
    await this.requireUserFacingWrite('camera_dataset_export')
    return this.stageMedia(options.outputDir, outputDir => this.request<Record<string, unknown>>('camera_dataset_export', { worldId, options: { ...options, outputDir } }), undefined, 'camera_dataset_export')
  }
  /**
   * 释放本 Provider 的 worker：发出 shutdown、关 stdin、等进程真实退出——等多久由 Kit 自己决定，
   * 不靠强杀冒充正常关闭（83 报告里的“close 200s+”是累计计时口径，真实 close 约 1s，见 91 REPORT §1.2）。
   * 唯一例外是**尚未 ready** 的 worker：它不可能回复 shutdown（83 那次卡在 Kit 初始化时就是这样，
   * 已用假 worker 最小复现：这样 dispose 会永久悬空），所以这条路径不给不会来的回复/退出无限等待，
   * 按归属结束本 Provider 自己尚未交付的进程——复用既有 failProvider→terminateOwned，与显式取消同一机制。
   * 动作终态（terminalReceipts）不在这里清理：close/shutdown 之后按 actionId 仍能取到真实终态。
   */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.closed = true
    this.shutdown.abort()
    // Concurrent callers observe the same cleanup, including its failure.
    this.disposal = this.disposeOwned()
    return this.disposal
  }
  private async disposeOwned(): Promise<void> {
    const child = this.process
    try {
      if (child && !this.terminalError && child.exitCode === null && child.signalCode === null) {
        if (!this.ready) {
          // 尚未 ready：worker 不会回复 shutdown，等下去就是悬空 Promise。
          // 这里先走 failProvider（此刻 shutdownRequested 仍是 false，才会按归属终止这个自己的 child），
          // 再标记 shutdown，避免“等一个不会来的退出”。
          const spawnedAt = this.currentPhases()[0]?.at ?? Date.now()
          const error = new SimError('PROVIDER_CLOSED', `PROVIDER_CLOSED：Provider 已释放，本次尚未 ready 的启动被结束：${this.startupDiagnostics(child, Date.now() - spawnedAt)}`)
          this.failProvider(error, child)
          this.shutdownRequested = true
          void this.starting?.catch(() => undefined)
        } else {
          this.shutdownRequested = true
          try { await this.request('shutdown', {}) } catch (error) { if (!this.terminalError) throw error }
          child.stdin.end()
        }
      } else this.shutdownRequested = true
      if (child) await this.exited
      // A cancelled pre-spawn hook must also settle the pending open before
      // disposal completes, even though there was no child to terminate.
      await this.starting?.catch(() => undefined)
    } finally {
      this.worlds.clear(); this.listeners.clear(); this.latest.clear(); this.generations.clear(); this.revisions.clear(); this.handles.clear(); this.syncQueues.clear(); this.closing.clear()
    }
  }

  /**
   * 取消隔离路径的收尾：worker 迟到的 open 回执里那个世界从未交付给调用方，就地关掉，别在 worker 里留孤儿。
   * 只看「这个 child 还是不是当前 worker」——**不能**用 handles/worlds 当「已经交付」的判据：普通的
   * `listWorlds()` 轮询会把 worker 里的世界照单 adopt 进来（它分不出谁交付的），一 adopt 就跳过 close，
   * 孤儿就留下了（root-105-cancel-listworlds-probe.ts）。清掉这个 worldId 的传输层残留也是同理。
   * `keptReceipts` 是发出本次 open 之前就已登记的终态回执（同 worldId 上一个世界留下的），继续可读。
   */
  private async closeAbandonedWorld(worldId: string, worker: ChildProcessWithoutNullStreams, keptReceipts?: string[]): Promise<void> {
    if (this.process !== worker) return
    try { await this.stop(worldId, {}, worker) } catch { /* 世界可能根本没建出来（取消发生在 worker 处理它之前）。 */ }
    if (this.process !== worker) return
    try { await this.request('close', { worldId }, worker) } catch { /* worker 已经不在了就算了：这里不重启任何东西。 */ }
    if (this.process !== worker) return
    // 这次 open 的 world/帧/终态回执不属于任何已交付给调用方的世界，留着只会冒充「当前来源」；
    // 队列槽位还压在收尾上，所以这里不会清掉同 id 新 open 的状态（它排在本收尾之后）。
    this.worlds.delete(worldId); this.handles.delete(worldId)
    this.generations.delete(worldId); this.revisions.delete(worldId)
    this.latest.delete(worldId)
    const receipts = this.terminalReceipts.get(worldId)
    if (receipts) for (const actionId of [...receipts.keys()]) if (!keptReceipts?.includes(actionId)) receipts.delete(actionId)
  }
  private adoptHandle(handle: WorldHandle) {
    const current = this.handles.get(handle.worldId)
    if (current && (handle.appliedSceneRevision < current.appliedSceneRevision ||
      handle.appliedSceneRevision === current.appliedSceneRevision && handle.worldGeneration < current.worldGeneration)) return current
    // 唯一交付点：open／sync／listWorlds 都经这里，provider 自报的能力表原样挂上（未自报就不出现该键）。
    if (this.workerCapabilities !== undefined && handle.capabilities === undefined) handle.capabilities = this.workerCapabilities
    this.handles.set(handle.worldId, handle)
    this.worlds.add(handle.worldId)
    this.generations.set(handle.worldId, handle.worldGeneration)
    this.revisions.set(handle.worldId, handle.appliedSceneRevision)
    return handle
  }
}
