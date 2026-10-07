import { mkdirSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { SESSION_NOT_BOUND, safeSessionKey, sessionIdOf } from '../../lyapunov-contracts/src/session-scope.ts'
import { canonicalTargetPath, pathWithin } from '../../lyapunov-contracts/src/writable-boundary.ts'
import type { SimWorkerLaunchFacts, SimWorkerLaunchHook, SimWorkerPolicyCheck } from './python-transport.ts'

/**
 * 仿真执行的**会话运行空间接线**：把"按会话一份的世界服务"接到原生会话身份、原生有效权限策略
 * 与原生沙箱执行上。这一层只做装配，不新建会话系统、不新建执行平台：
 *
 *   · 身份与策略都来自**活着的原生 Session**（`sandboxPolicy.resolve({session})`）：模式取会话自己的
 *     `sandboxMode` 覆盖（无覆盖即部署默认），工作区根取 `session.header.cwd`（不可变、不可伪造）；
 *   · 会话运行根 = `<工作区根>/.lyapunov/sessions/<会话键>/sim`——同一 Host、同一工作区的两条会话
 *     因为 cwd 相同而共享的只有**只读的模型原件与引擎安装**，运行态各写各的会话子目录；
 *   · worker 经原生 `sandbox.confine` 包裹后 spawn（`workspace-write`/`read-only`）；该模式没有可用
 *     原生后端时**失败关闭**（SANDBOX_UNAVAILABLE），绝不静默退成直连；`danger-full-access` 是策略
 *     自己说"本次不受文件效果约束"，照实记录、不假装有沙箱。
 *   · `read-only` 下整机只读，但**受信引擎自己的内部运行目录**（Kit portable root、MJCF/URDF 导入缓存，
 *     以及引擎自己的临时目录）必须有唯一一处可写位：装配方按会话解析出目录
 *     （{@link SimSessionLauncherOptions.internalWritableRoots} / {@link SimSessionLauncherOptions.internalTempDir}），
 *     本层只在原生封装里把这些目录单独挂回可写、并把引擎的 `TMPDIR` 指过去。**用户模式仍是 read-only**：
 *     用户工程、场景资产与其他会话目录照旧只读，用户的截图/数据集落盘请求也不因为这份内部许可变成允许
 *     （见 python-transport）。
 *
 * 不在这里做的事：不改 `session.header.cwd`、不全局切换 currentSession/cwd、不把整个共享工作区
 * 当成某个会话的私有空间、不按路径前缀假装 OS 级隔离（容器/微虚拟机不在本接线的语义范围内）。
 */
export const SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE'

/**
 * 已定义 NativeMode（`SimWorkerLaunchFacts['mode']`）的**单调包含序**（数值越小权限越窄）：
 * `read-only` ⊂ `workspace-write` ⊂ `danger-full-access`。
 *
 * 这里**只认这三个本层已定义的值**；任何别的取值（第三方后端自造的模式名、拼写变体）都取不到序号。
 * 不猜它相对于已知模式是更宽还是更窄——认不出就按"不可证明"处理（见 {@link isWorkerModeWithinCurrent}）。
 */
const NATIVE_MODE_WIDTH = new Map<string, number>([
  ['read-only', 0],
  ['workspace-write', 1],
  ['danger-full-access', 2],
])

/**
 * worker 启动时绑定的沙箱模式是否被会话**当前**有效策略单调包含，也就是"这只 worker 带着的沙箱
 * 不比现值更宽"。这是用户文件效果核对**允许派发/发布**的方向（物理世界不经这条核对）：
 *   · 现值更宽或等宽（`read-only`→`workspace-write`/`danger-full-access`、`workspace-write`→
 *     `danger-full-access`）⇒ `true`：原 worker 留在它**原来那个更严格的沙箱**里继续干活。本层只是
 *     核对放行，**不提升、不重挂载、不换 argv**（放宽不会被用来悄悄扩大已有 worker 的权限）。
 *   · 现值更窄（`workspace-write`→`read-only`、`danger-full-access`→`workspace-write`）⇒ `false`：
 *     这只 worker 还带着比现值更宽的许可，必须按"旧许可过期"处理。
 *   · 任一取值不在 {@link NATIVE_MODE_WIDTH} 里（未知模式）⇒ `false`：失败关闭，不猜第三方模式语义。
 * @param workerMode - worker 启动时实际绑定的沙箱模式（`SimWorkerLaunchFacts.mode`）。
 * @param currentMode - 该会话当前重新解析出的有效策略模式。
 */
export function isWorkerModeWithinCurrent(workerMode: unknown, currentMode: unknown): boolean {
  if (typeof workerMode !== 'string' || typeof currentMode !== 'string') return false
  const worker = NATIVE_MODE_WIDTH.get(workerMode)
  const current = NATIVE_MODE_WIDTH.get(currentMode)
  return worker !== undefined && current !== undefined && worker <= current
}

/**
 * 把共享 workspace 里的**会话私有运行目录**从"整个授权根可写"里收出来。
 *
 * 原生 `workspace-write` 的语义是"授权根（`session.header.cwd`）整体可写"，同一 Host 上两条 cwd 相同的
 * 会话因此天然能互写对方的 `.lyapunov/sessions/<对方>/sim`——实测（137 evidence/sandbox-boundary）
 * A 的采集产物确实落进了 B 的运行目录。会话私有性必须在 OS 层也成立，所以在这一处封装点做**薄适配**：
 * 原生挂载本身能表达"父目录只读、自己那层再挂回可写"（bwrap 后挂载覆盖先挂载），就补两条挂载——
 * 运行根父目录只读挂回，自己这条会话的目录挂回可写。共享 workspace 的其余部分照旧可写（用户导出不受影响）。
 *
 * 只认 bwrap 形态（`argv[0]` 是 bwrap 且有 `--` 分隔符）；别的原生后端不吃这些参数，就**如实不加**
 * （返回 `none`），让它按原生语义执行并把边界记在启动事实里，不假装有这一层。
 * @param argv - 原生 `sandbox.confine` 给出的 argv。
 * @param options - 授权根、运行根父目录（相对授权根）与本会话键。
 * @returns 收窄后的 argv 与这一层是否真的加上。
 */
function narrowSessionPrivateRoot(
  argv: readonly string[],
  options: { workspaceRoot: string; parent: string; sessionKey: string },
): { argv: string[]; privateRootBoundary: 'os-bind' | 'none' } {
  if (basename(argv[0] ?? '') !== 'bwrap') return { argv: [...argv], privateRootBoundary: 'none' }
  const separator = argv.lastIndexOf('--')
  if (separator < 0) return { argv: [...argv], privateRootBoundary: 'none' }
  const sessionsParent = join(options.workspaceRoot, options.parent)
  const ownRoot = join(sessionsParent, safeSessionKey(options.sessionKey))
  // 挂载源必须存在：宿主（在沙箱外）先把自己这条会话的运行根建出来；别的会话目录不建、也不碰。
  mkdirSync(join(ownRoot, 'sim'), { recursive: true })
  const mounts = ['--ro-bind', sessionsParent, sessionsParent, '--bind', ownRoot, ownRoot]
  return { argv: [...argv.slice(0, separator), ...mounts, ...argv.slice(separator)], privateRootBoundary: 'os-bind' }
}

/** 原生 bwrap 的临时 /tmp 会遮住放在其中的安装包；仅恢复宿主声明的代码/SDK根的只读可见性。
 * 插在 tmpfs 后、工作区可写挂载前，保留原生工作区和后续会话私有目录的写入边界。 */
function bindRuntimeReadRoots(argv:readonly string[],roots:readonly string[],workspaceRoot:string):{argv:string[];roots:string[]}{
  if(basename(argv[0]??'')!=='bwrap')return {argv:[...argv],roots:[]}
  const mask=argv.findIndex((value,index)=>value==='--tmpfs'&&argv[index+1]==='/tmp')
  if(mask<0)return {argv:[...argv],roots:[]}
  const hidden:string[]=[]
  for(const value of roots){
    if(!isAbsolute(value))throw new Error('SIM_RUNTIME_READ_ROOT_INVALID: 运行依赖根必须是绝对路径')
    const root=resolve(value)
    if(root==='/tmp')throw new Error('SIM_RUNTIME_READ_ROOT_INVALID: 不允许重新暴露整个临时目录')
    if(!root.startsWith('/tmp/')||pathWithin(root,workspaceRoot))continue
    if(!statSync(root).isDirectory())throw new Error('SIM_RUNTIME_READ_ROOT_INVALID: 运行依赖根必须是目录')
    if(!hidden.includes(root))hidden.push(root)
  }
  const mounts=hidden.flatMap(root=>['--ro-bind',root,root])
  return {argv:[...argv.slice(0,mask+2),...mounts,...argv.slice(mask+2)],roots:hidden}
}

/** 原生上下文的最小只读面：只用 `get(name)` 取服务，不复制上游服务类型（与 lyapunov-contracts 的 SessionLookup 同口径）。 */
export interface SimLaunchContext { get(name: string): unknown }

/** 装配方按会话解析内部可写目录时的输入：会话键与本会话私有目录（内部目录必须落在它之内）。 */
export interface SimInternalWritableRootsRequest {
  sessionKey: string
  /** `<授权根>/<运行根落点>/<会话键>`（与 {@link resolveSessionPrivateRoot} 同一个取值）；装配方给的内部目录按它拼。 */
  privateRoot: string
}

/**
 * 核实装配方声明的**引擎内部可写目录**：每个都必须是本会话私有根之内的**规范路径**（符号链接按
 * 文件系统真实目标解析，与场景/资产工具、媒体中转共用 `lyapunov-contracts/writable-boundary` 同一份规则）。
 * 私有目录里一条指向别处的链接（或指向别的会话、指向授权根外）不能让只读会话的封装把那个真实目标挂成
 * 可写，所以核实不过就**抛错、不启动**，不静默少挂一条。
 * @param roots - 装配方给出的目录（绝对路径）。
 * @param privateRoot - 本会话私有目录（规范路径）。
 * @returns 规范化之后的目录（供挂载与启动事实共用同一份取值）。
 */
function verifyInternalWritableRoots(roots: readonly string[], privateRoot: string): string[] {
  const canonicalPrivate = canonicalTargetPath(privateRoot)
  return roots.map(root => {
    const canonical = canonicalTargetPath(root)
    if (!pathWithin(canonicalPrivate, canonical)) {
      throw new Error(`SESSION_INTERNAL_WRITE_OUTSIDE_PRIVATE_ROOT: 引擎内部可写目录 ${root} 的真实目标 ${canonical} 不在本会话私有目录 ${canonicalPrivate} 之内，拒绝按它放开任何写入`)
    }
    return canonical
  })
}

/**
 * 把引擎内部可写目录挂回可写（只读会话里唯一的可写位）。与 {@link narrowSessionPrivateRoot} 同一形态：
 * 只认 bwrap 且挂载插在 `--` 之前；别的原生后端表达不了这层许可就**如实不加**（返回 `applied:false`），
 * 让它按原生语义执行、把边界记在启动事实里，不假装有这一层。
 * 挂载源必须先存在：这里在宿主侧把会话自己的内部目录建出来（建的是产品按会话解析的运行目录，不是用户工程内容）。
 */
function bindInternalWritableRoots(argv: readonly string[], roots: readonly string[]): { argv: string[]; applied: boolean } {
  if (roots.length === 0) return { argv: [...argv], applied: false }
  if (basename(argv[0] ?? '') !== 'bwrap') return { argv: [...argv], applied: false }
  const separator = argv.lastIndexOf('--')
  if (separator < 0) return { argv: [...argv], applied: false }
  const mounts: string[] = []
  for (const root of roots) {
    mkdirSync(root, { recursive: true })
    mounts.push('--bind', root, root)
  }
  return { argv: [...argv.slice(0, separator), ...mounts, ...argv.slice(separator)], applied: true }
}

/**
 * 核实装配方声明的**引擎设备节点**：每一条都必须是 `/dev` 下真实存在的字符设备，或 `/dev` 下承载
 * 设备节点的子目录（例如 NVIDIA 的 `/dev/nvidia-caps`）——设备挂载的源不存在就没得挂。
 * 声明了却拿不到就**抛错、不启动**：让"配置了 GPU 却按 CPU 跑起来"变成一次响亮的启动失败，
 * 而不是一只没有 GPU 的 worker（判据是引擎日志里 requestedPhysicsDevice 与实际显存占用对不上）。
 * @param devices - 装配方给出的设备路径（绝对路径）。
 * @returns 规范化之后的设备路径（供挂载与启动事实共用同一份取值）。
 */
function verifyEngineDevices(devices: readonly string[]): string[] {
  return devices.map(device => {
    if (!isAbsolute(device) || !device.startsWith('/dev/')) {
      throw new Error(`SESSION_ENGINE_DEVICE_OUTSIDE_DEV: 引擎设备 ${device} 不是 /dev 下的绝对路径，拒绝按它加设备挂载`)
    }
    const canonical = canonicalTargetPath(device)
    if (!canonical.startsWith('/dev/')) {
      throw new Error(`SESSION_ENGINE_DEVICE_OUTSIDE_DEV: 引擎设备 ${device} 的真实目标 ${canonical} 不在 /dev 下，拒绝按它加设备挂载`)
    }
    let stats
    try {
      stats = statSync(canonical)
    } catch {
      throw new Error(`SESSION_ENGINE_DEVICE_UNAVAILABLE: 引擎设备 ${device} 在宿主上不存在；本 Host 的引擎配置要求这个设备（例如 GPU 物理/RTX），拒绝在没有它的情况下启动 worker 让它静默降级`)
    }
    if (!stats.isCharacterDevice() && !stats.isDirectory()) {
      throw new Error(`SESSION_ENGINE_DEVICE_UNAVAILABLE: 引擎设备 ${device} 既不是字符设备也不是目录（实际是 ${stats.isFile() ? '普通文件' : '其它类型'}），拒绝按设备暴露`)
    }
    return canonical
  })
}

/**
 * 把引擎设备挂进沙箱（`--dev-bind`：挂载源与目标同路径，沙箱里看到的仍是同一个设备节点）。
 * 与 {@link bindInternalWritableRoots} 同一形态：只认 bwrap 且挂载插在 `--` 之前；别的原生后端
 * 表达不了这层就**如实不加**（返回 `applied:false`），把边界记在启动事实里，不假装设备已暴露。
 */
function bindEngineDevices(argv: readonly string[], devices: readonly string[]): { argv: string[]; applied: boolean } {
  if (devices.length === 0) return { argv: [...argv], applied: false }
  if (basename(argv[0] ?? '') !== 'bwrap') return { argv: [...argv], applied: false }
  const separator = argv.lastIndexOf('--')
  if (separator < 0) return { argv: [...argv], applied: false }
  const mounts: string[] = []
  for (const device of devices) mounts.push('--dev-bind', device, device)
  return { argv: [...argv.slice(0, separator), ...mounts, ...argv.slice(separator)], applied: true }
}

interface NativeSession { header: { id?: unknown; cwd?: unknown } }
type NativeMode = SimWorkerLaunchFacts['mode']
interface NativeSandboxPolicyService {
  resolve(request: { session: NativeSession }): { mode: NativeMode; workspaceRoot: string; sessionId?: string }
}
interface NativeSandboxService {
  confine(argv: readonly string[], policy: { mode: Exclude<NativeMode, 'danger-full-access'>; workspaceRoot: string; sessionId?: string }, signal?: AbortSignal): Promise<{ argv: string[]; enforcement: 'full' | 'partial' }>
}

export interface SimSessionLauncherOptions {
  /** 由宿主装配声明的代码与SDK根；不是模型或HTTP请求可传入的权限扩展。 */
  readOnlyRoots?: readonly string[]
  /** 引擎名，只进诊断文本（会话身份/策略解析对所有引擎同一条链）。 */
  engineName: string
  /**
   * 本会话产品产物根（截图/录像/数据集目录所在的会话存储目录）。媒体中转只在这些根内代宿主落盘；
   * 装配方按会话键给出，取不到就返回空数组——空数组只让中转不做，worker 的真实拒绝照原样上报。
   */
  productRoots?: (sessionKey: string) => string[]
  /** 会话运行根在授予根内的落点，默认 `.lyapunov/sessions`。 */
  runtimeParent?: string
  /**
   * **受信引擎自己的内部运行目录**（按会话解析；例如 Isaac 的 Kit portable root 与 MJCF/URDF 导入缓存）。
   * 只读会话里这些目录由本接线在原生封装中单独挂回可写：引擎没有这处可写位就没法打开已有场景（导入缓存
   * 当场 EROFS），而"能打开"不该依赖热缓存碰巧存在。**用户模式仍是 read-only**——这份许可只覆盖这里声明的
   * 目录，且目录只能落在本会话私有根之内（规范路径核实，见 `verifyInternalWritableRoots`）；用户的场景/导出
   * 落盘请求不因此变成允许（`python-transport` 在派发前按模式拒绝）。省略 = 本次启动没有任何内部可写位。
   */
  internalWritableRoots?: (request: SimInternalWritableRootsRequest) => string[]
  /**
   * 引擎内部**临时目录**（按会话解析，同样必须落在本会话私有根之内）。只读会话里平台临时区（`/tmp`）
   * 是只读的：Kit/Python 的 `tempfile` 找不到任何可写候选目录时，**打开已有场景当场失败**
   * （`No usable temporary directory found in ['/tmp', '/var/tmp', '/usr/tmp', '/dev/shm']`）。
   * 所以这个目录与内部缓存同一条归属链：只读会话里单独挂回可写，并通过 `TMPDIR`/`TMP`/`TEMP`
   * 指给 worker——引擎的临时文件也是引擎自己的内部运行文件，不放开平台 `/tmp`、用户模式也不因此变化。
   * 声明了它才算进 {@link SimWorkerLaunchFacts.internalWritableRoots}；省略 = 本次启动没有内部临时目录。
   */
  internalTempDir?: (request: SimInternalWritableRootsRequest) => string
  /**
   * 引擎需要的**设备节点**（按引擎配置解析，例如 Isaac 的 GPU 物理/RTX 要的 `/dev/nvidia*`）。
   * 原生封装的 `--dev /dev` 给沙箱的是一个空挂载点：不显式暴露时，引擎在沙箱里拿不到 GPU
   * （实测 `/dev` 下没有 `nvidia*` → NVML 报未加载驱动 → 无物理设备）。这些路径由装配方给出，
   * 模型/HTTP 不能指定；本层只做两件事——核实它们真的存在（拿不到就**失败关闭**），
   * 在原生封装里把它们挂进沙箱。**用户文件效果模式不因此改变**：多出来的只有设备访问。
   * 省略 = 本次启动不声明任何设备。
   */
  engineDevices?: () => string[]
}

/**
 * 把会话键核实成一个**活着的原生 Session**。执行策略必须按真实 Session 解析（模式来自会话自己的
 * 投影、工作区根来自它不可变的 cwd），所以没有真会话就没有执行策略：这里明确失败，
 * 绝不拿部署默认值替一个没有会话身份的执行解析策略。
 */
async function requireLiveSession(ctx: SimLaunchContext, sessionKey: string, engineName: string): Promise<NativeSession> {
  const agents = ctx.get('agents') as { get?: (id: unknown) => unknown } | undefined
  const live = agents?.get?.(sessionKey) as { session?: NativeSession } | undefined
  const liveSession = live?.session
  if (liveSession !== undefined && sessionIdOf(liveSession) === sessionKey) return liveSession
  const controller = ctx.get('sessionController') as { resolveAgent?: (id: unknown) => Promise<unknown> } | undefined
  if (controller?.resolveAgent) {
    const resolved = await controller.resolveAgent(sessionKey).catch(() => undefined)
    const session = (resolved as { agent?: { session?: NativeSession } } | undefined)?.agent?.session
    if (session !== undefined && sessionIdOf(session) === sessionKey) return session
  }
  throw new Error(`${SESSION_NOT_BOUND}: ${engineName} 会话 ${sessionKey} 在本 Host 没有活着的原生会话，拒绝在没有会话身份的情况下解析执行策略`)
}

/**
 * 一条会话说清自己的执行策略：活着的原生 Session + 它自己的有效策略（模式与授权根）。
 * 启动接线与"引擎缓存该放哪"用的是**同一条**解析链，不各自解析一遍。
 */
async function resolveExecutionPolicy(ctx: SimLaunchContext, sessionKey: string, engineName: string): Promise<{ session: NativeSession; policy: { mode: NativeMode; workspaceRoot: string; sessionId?: string } }> {
  const session = await requireLiveSession(ctx, sessionKey, engineName)
  const policyService = ctx.get('sandboxPolicy') as NativeSandboxPolicyService | undefined
  if (policyService === undefined) {
    throw new Error(`${SANDBOX_UNAVAILABLE}: 本 Host 未装配 sandboxPolicy，${engineName} 无法取得这次执行的会话有效策略；拒绝在没有策略的情况下启动仿真 worker`)
  }
  return { session, policy: policyService.resolve({ session }) }
}

/**
 * 本会话的**私有目录**：`<授权根>/.lyapunov/sessions/<会话键>`，即沙箱里唯一挂回可写的那一层
 * （见 {@link narrowSessionPrivateRoot}）。引擎需要自己的可写运行空间（例如 Isaac 的 Kit portable root）
 * 时用它——授权根之外或共享缓存里的路径在本次执行里是只读的，写不进去是**策略的事实**，不要绕开。
 * @param ctx - Host 上下文（与启动接线同一份）。
 * @param sessionKey - 会话键；必须能解析成活着的原生会话。
 * @param engineName - 诊断用引擎名。
 * @param runtimeParent - 会话目录在授权根内的落点，默认 `.lyapunov/sessions`。
 * @returns 该会话私有目录的绝对路径（**不**创建它；创建由启动接线做）。
 */
export async function resolveSessionPrivateRoot(ctx: SimLaunchContext, sessionKey: string, engineName: string, runtimeParent = '.lyapunov/sessions'): Promise<string> {
  const { policy } = await resolveExecutionPolicy(ctx, sessionKey, engineName)
  return join(policy.workspaceRoot, runtimeParent, safeSessionKey(sessionKey))
}

/**
 * 建一条**按会话**的执行接线：`launch(sessionKey)` 给出该会话的启动钩子（装配到
 * `ProcessSimConfig.launch`），每次启动都重新解析一次原生策略——会话模式被显式改变时，
 * 下一次启动就是新模式，不需要重启 Host。
 *
 * 启动钩子同时给出**策略现值核对**（{@link SimWorkerPolicyCheck}）：worker 的沙箱在启动时绑定，
 * 而会话模式可以在运行中被改变。核对的用途已经**收窄到用户产物落盘边界**（截图/多集/数据集导出的派发
 * 与发布），不再参与物理世界生命周期：模式互切本身不结束 worker、不销毁世界，`sim_sync`/暂停继续照常。
 * 核对按已定义 NativeMode 的**单调包含**判定并回报会话**当前**有效策略：现值更宽时原 worker 继续在它
 * 原来那个更严格沙箱里跑（本层不提升、不重挂载）；现值收紧、授权根变化、会话核不出来或模式不可比较时
 * 按旧许可过期（或不可证明）拒绝——但拒绝只落在这一次 IO 写入上，世界继续。
 * @param ctx - Host 上下文（读 `agents`/`sessionController`/`sandboxPolicy`/`sandbox`）。
 * @param options - 引擎名、会话产品产物根与运行根落点。
 * @returns 按会话键取启动钩子的工厂。
 */
export function createSimSessionLauncher(ctx: SimLaunchContext, options: SimSessionLauncherOptions): (sessionKey: string) => SimWorkerLaunchHook {
  const engineName = options.engineName
  return (sessionKey: string): SimWorkerLaunchHook => async (input) => {
    const { policy } = await resolveExecutionPolicy(ctx, sessionKey, engineName)
    const policyService = ctx.get('sandboxPolicy') as NativeSandboxPolicyService
    /** 策略现值核对：与启动用同一条 resolve 链；读不到就抛给传输层（那边按"不可证明"拒绝本次写入，不杀世界）。 */
    const check: SimWorkerPolicyCheck = async (facts) => {
      const live = await requireLiveSession(ctx, sessionKey, engineName)
      const current = policyService.resolve({ session: live })
      const snapshot = { mode: current.mode, workspaceRoot: current.workspaceRoot }
      // 受限模式变更授权根必须重新建立运行空间。全访问已包括所有目录，
      // 主要工作目录变化不收紧许可；原worker仍保持它启动时的沙箱和私有运行根。
      if (current.mode !== 'danger-full-access' && current.workspaceRoot !== facts.workspaceRoot) {
        return { stale: true, detail: `the session workspace root changed from ${facts.workspaceRoot} to ${current.workspaceRoot}; this worker was launched with the previous workspace authorization`, current: snapshot }
      }
      // 模式只看**单调包含**：现值更宽放行（原 worker 留在原更严格沙箱，不提升/不重挂），
      // 现值收紧或模式不可比较（未知值）都按旧许可过期拒绝。
      if (!isWorkerModeWithinCurrent(facts.mode, current.mode)) {
        return { stale: true, detail: `this worker was launched in ${facts.mode} mode (session ${facts.sessionId}, runtime root ${facts.runtimeRoot}); the current session policy is ${current.mode}`, current: snapshot }
      }
      return { stale: false, current: snapshot }
    }
    const workspaceRoot = policy.workspaceRoot
    const runtimeParent = options.runtimeParent ?? '.lyapunov/sessions'
    const privateRoot = join(workspaceRoot, runtimeParent, safeSessionKey(sessionKey))
    const runtimeRoot = join(privateRoot, 'sim')
    // 引擎内部可写目录只从**本会话私有根**解析（装配方给的解析函数），并由本层核实规范路径仍在私有根内：
    // 模型/HTTP 没有任何参数能改它，别的会话与授权根外的目标也挂不进来。临时目录与缓存目录同一条核实链。
    const declaredRoots = options.internalWritableRoots?.({ sessionKey, privateRoot }) ?? []
    const tempRoot = options.internalTempDir === undefined
      ? undefined
      : verifyInternalWritableRoots([options.internalTempDir({ sessionKey, privateRoot })], privateRoot)[0]
    const internalRoots = [...verifyInternalWritableRoots(declaredRoots, privateRoot), ...(tempRoot === undefined ? [] : [tempRoot])]
    // 设备同样按**本次执行**解析（设备可能在后来的启动里才出现）：声明了却拿不到就在这里失败关闭。
    const engineDevices = verifyEngineDevices(options.engineDevices?.() ?? [])
    const env = {
      ...input.env,
      LYAPUNOV_SIM_SESSION: sessionKey,
      LYAPUNOV_SIM_RUNTIME_ROOT: runtimeRoot,
      LYAPUNOV_SIM_SANDBOX_MODE: policy.mode,
      LYAPUNOV_SIM_WORKSPACE_ROOT: workspaceRoot,
      // 只读会话里引擎的临时目录指向本会话内部临时目录（那里是唯一可写位，且已挂回可写）；
      // workspace-write 与 danger-full-access 下平台临时区本来可用，环境照旧不动。
      ...(tempRoot === undefined || policy.mode === 'workspace-write' || policy.mode === 'danger-full-access'
        ? {}
        : { TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot }),
    }
    const facts: SimWorkerLaunchFacts = {
      sessionId: sessionKey, mode: policy.mode, workspaceRoot, writableRoot: workspaceRoot, runtimeRoot,
      productRoots: options.productRoots?.(sessionKey) ?? [],
      ...(internalRoots.length === 0 ? {} : { internalWritableRoots: internalRoots }),
    }
    const argv = [input.pythonPath, '-u', input.workerPath]
    if (policy.mode === 'danger-full-access') {
      // 策略自己说"本次不受文件效果约束"：照实记录，不加沙箱、也不声称有沙箱；设备本来就在眼前可见。
      return {
        argv, cwd: workspaceRoot, env, check,
        facts: {
          ...facts, privateRootBoundary: 'none',
          ...(internalRoots.length === 0 ? {} : { internalWritableBoundary: 'none' as const }),
          ...(engineDevices.length === 0 ? {} : { engineDevices, engineDeviceBoundary: 'none' as const }),
        },
      }
    }
    const sandbox = ctx.get('sandbox') as NativeSandboxService | undefined
    if (sandbox === undefined) {
      throw new Error(`${SANDBOX_UNAVAILABLE}: ${engineName} 本次执行的策略是 ${policy.mode}，但本 Host 没有可用的原生沙箱执行器；拒绝不受约束地启动仿真 worker`)
    }
    const confined = await sandbox.confine(
      argv,
      { mode: policy.mode, workspaceRoot, ...(policy.sessionId === undefined ? {} : { sessionId: policy.sessionId }) },
      input.signal,
    )
    // read-only：整机只读下没有会话私有目录要收窄，但受信引擎的内部运行目录要单独挂回可写；
    // workspace-write：整层会话私有目录挂回可写（内部目录都在那一层里，不重复挂）。
    const runtimeRead = bindRuntimeReadRoots(confined.argv, options.readOnlyRoots ?? [], workspaceRoot)
    let confinedArgv = runtimeRead.argv
    let privateRootBoundary: 'os-bind' | 'none' = 'none'
    let internalWritableBoundary: 'os-bind' | 'none' = 'none'
    let engineDeviceBoundary: 'device-bind' | 'none' = 'none'
    if (policy.mode === 'workspace-write') {
      const narrowed = narrowSessionPrivateRoot(confinedArgv, { workspaceRoot, parent: runtimeParent, sessionKey })
      confinedArgv = narrowed.argv
      privateRootBoundary = narrowed.privateRootBoundary
      internalWritableBoundary = narrowed.privateRootBoundary
      if (engineDevices.length > 0) {
        const bound = bindEngineDevices(confinedArgv, engineDevices)
        confinedArgv = bound.argv
        engineDeviceBoundary = bound.applied ? 'device-bind' : 'none'
      }
    } else if (internalRoots.length > 0 || engineDevices.length > 0) {
      if (internalRoots.length > 0) {
        const bound = bindInternalWritableRoots(confinedArgv, internalRoots)
        confinedArgv = bound.argv
        internalWritableBoundary = bound.applied ? 'os-bind' : 'none'
      }
      if (engineDevices.length > 0) {
        const bound = bindEngineDevices(confinedArgv, engineDevices)
        confinedArgv = bound.argv
        engineDeviceBoundary = bound.applied ? 'device-bind' : 'none'
      }
    }
    return {
      argv: confinedArgv, cwd: workspaceRoot, env, check,
      facts: {
        ...facts, ...(runtimeRead.roots.length ? {runtimeReadRoots:runtimeRead.roots} : {}), runner: confinedArgv[0], enforcement: confined.enforcement, privateRootBoundary,
        ...(internalRoots.length === 0 ? {} : { internalWritableBoundary }),
        ...(engineDevices.length === 0 ? {} : { engineDevices, engineDeviceBoundary }),
      },
    }
  }
}
