import { dirname, resolve } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { ProcessSimProvider, type SimWorkerLaunchHook } from '../../sim-contract/src/python-transport.ts'
import { SimError, type SimWorlds, type SimAction, type WorldOptions, type ObservationSelection, type StopSelection, type CaptureOptions, type MultiCaptureOptions, type CameraAdjustOptions, type CameraAnnotationOptions, type CameraDatasetExportOptions } from '../../sim-contract/src/index.ts'
import type { SceneSnapshot, WorldHandle, Frame, ActionReceipt } from '../../lyapunov-contracts/src/types.ts'
export interface IsaacConfig {
  pythonPath?: string; workerPath?: string; cacheRoot?: string; physicsDevice?: 'cpu' | 'cuda:0'; rendering?: 'none' | 'rtx'
  /**
   * **显式配置**的启动预算（毫秒）：只在该给值时交给传输层，不配置＝一直等到 worker 的 ready
   * （Isaac RTX 冷缓存启动实测约 270s，凭空一个默认上限会杀掉有效启动）。到期由传输层按既有
   * `failProvider` 语义结束本次尚未 ready 的启动，并报出最后阶段与原因。
   * 合法性（正的有限毫秒数）只由 `ProcessSimProvider` 构造函数这一处校验，这里不重复、不设默认值。
   */
  startupBudgetMs?: number
  /**
   * 按会话解析 Kit 的缓存根（可写运行空间）：Kit 启动前会自己建 `kit/<pid>` portable root、
   * 以及渲染时的 shader 缓存，全都必须**本次执行真的写得进去**。给了这个钩子时按它逐世界解析，
   * 取不到就按原样失败（不回落成一个只读的共享目录去撞沙箱）。
   */
  cacheRootFor?: () => Promise<string>
  /**
   * 按会话的执行接线（与 MuJoCo 同一条 `createSimSessionLauncher`）：会话身份、会话运行根与原生有效
   * 权限策略由它给出（Isaac 每个世界一条 Kit/PhysX 进程，接线按会话键注入到每条子进程）。
   * 不注入 = 保持历史直连 spawn（没有会话沙箱接线，调用方不得据此声称沙箱已生效）。
   */
  launch?: SimWorkerLaunchHook
}
/**
 * Isaac Sim 只在 Linux 上提供本仓库适配的运行路径；LD_LIBRARY_PATH/LD_PRELOAD 与
 * Vulkan ICD 是 Linux 专用注入（macOS 用 dyld，且没有该 ICD 路径，Windows 用注册表）。
 * 在 macOS/Windows 上注入指向 Linux 的路径只会误导排障，因此只对 Linux 注入；
 * 缺少 SDK 时仍由解释器存在性检查 fail-closed，不改变任何物理语义。
 */
export function isaacLoaderEnvironment(pythonPath:string,platform:NodeJS.Platform=process.platform,inherited:NodeJS.ProcessEnv=process.env):Record<string,string>{
  if(platform!=='linux')return {}
  const libraryPath=resolve(dirname(pythonPath),'../lib')
  /**
   * `libstdc++.so.6` 的位置**不能假定**在解释器旁边的 `lib/`：
   * 实测 `uv venv` 建出的 Isaac 环境里 `<venv>/lib/` 只有 `python3.12/`，**没有这份库**，
   * 于是原来的写法产生 `LD_PRELOAD=<不存在>` → 加载器打印
   * `object '…/lib/libstdc++.so.6' from LD_PRELOAD cannot be preloaded … ignored`，worker 随即退出。
   * 现在按**存在性**回退：解释器旁没有就用系统库；两者都没有就**不设 LD_PRELOAD**
   * （让系统正常解析），而不是塞一个必然失败的路径。
   * `LYAPUNOV_ISAAC_LIBSTDCXX` 可显式指定（例如用 conda 环境时的 `$CONDA_PREFIX/lib`）。
   */
  const candidates=[
    process.env.LYAPUNOV_ISAAC_LIBSTDCXX?.trim(),
    resolve(libraryPath,'libstdc++.so.6'),
    '/usr/lib/x86_64-linux-gnu/libstdc++.so.6',
    '/usr/lib64/libstdc++.so.6',
  ].filter((value):value is string=>Boolean(value&&value.length>0))
  const preload=candidates.find(candidate=>existsSync(candidate))
  return {
    LD_LIBRARY_PATH:[libraryPath,inherited.LD_LIBRARY_PATH].filter(Boolean).join(':'),
    ...(preload===undefined?{}:{LD_PRELOAD:[preload,inherited.LD_PRELOAD].filter(Boolean).join(':')}),
    // Vulkan ICD：仅在文件真的存在时注入，否则同样会把排障引向一个假路径。
    ...(existsSync('/usr/share/vulkan/icd.d/nvidia_icd.json')?{VK_ICD_FILENAMES:'/usr/share/vulkan/icd.d/nvidia_icd.json',__NV_PRIME_RENDER_OFFLOAD:'1'}:{}),
  }
}
// （这里曾有一个 `nvidiaDeviceNodes()`：宿主 `/dev` 下 `nvidia*` **字符设备或非空目录**就算"设备"。
//  它是"什么算设备可见"的**第二份**判据，与契约（只算字符设备）分叉过：C1 实测"只暴露了
//  `/dev/nvidia-caps`、没有 `nvidia0`"的容器里，装配点守卫不触发，而同一台机器在面板里显示看不见设备。
//  装配点已改为消费契约的 `probeGpuDeviceVisibility()`（`plugin.ts`），"要暴露什么"另由 `exposable` 给；
//  最后一个消费点（`test/isaac-entry-lifecycle.test.ts` 的 skipIf）在 2026-09-26 第二轮也改问同一份判据
//  ——于是这里不再保留第二份实现，免得下次再分叉。）

/**
 * 一条**没能确认结束**的自有 worker（"关不掉"这件事的如实记录）。
 *
 * 为什么要有它：`dispose()`／`close()` 失败意味着那只 worker 可能还活着。以前这种失败有的被
 * 静默吞掉（调用方只看到成功），有的虽然报了错但句柄已经被摘除——于是 provider 与 Host 级
 * `dispose()`（只枚举 instances/pending）都够不着它：不在册、没关掉、也不会被重试。
 * 登记在这里的每条记录都能说清"哪条路径、哪个 pid、为什么够不着、最后停在哪一阶段"。
 */
export interface OrphanedWorker {
  readonly worldId: string
  /** 这只 worker 的进程号（拿不到时为 undefined，不编造）。 */
  readonly pid?: number
  /** 够不着它的那条路径（启动失败收尾／close 收尾／Host 级 dispose…）。 */
  readonly path: string
  /** dispose 的真实失败原文。 */
  readonly error: string
  readonly at: number
  /** 该次启动的最后阶段轨迹：够不着时至少知道它停在哪。 */
  readonly phases: { name: string; elapsedMs: number }[]
}

/** 每个world独占一个Kit/PhysX进程；Provider内部管理world，不共享USD可变句柄。 */
export class IsaacProvider implements SimWorlds {
  private instances = new Map<string, { process: ProcessSimProvider; handle: WorldHandle }>()
  private closed = false
  private closing = new Map<string, Promise<void>>()
  private receipts = new Map<string, Map<string, ActionReceipt>>()
  private pending = new Map<string, ProcessSimProvider>()
  /** Reserve world ids before any async cache/launch hook work so concurrent opens cannot collide later. */
  private reservations = new Map<string, AbortController>()
  private openings = new Set<Promise<unknown>>()
  private disposal?: Promise<void>
  /** 最近一次真的起过的 worker：等待期/取消后/释放后都能读它的阶段轨迹（N60：启动不是黑盒 promise）。 */
  private lastStarted?: ProcessSimProvider
  /**
   * **每个 world** 最近一次启动的 worker（`worldId` → 该次启动）。一个 Provider 可以同时有多只 worker
   * 在启动/运行（多世界），只留"最后一个"会让 A 世界的等待/取消读回被 B 世界的轨迹顶替——归因就错了。
   * 关闭/释放后仍保留：取消与预算到期的事后归因读的就是它。条目随 Provider 生命周期（每会话一个）。
   */
  private starts = new Map<string, ProcessSimProvider>()
  /**
   * 未能确认结束的自有 worker（见 {@link OrphanedWorker}）：**只增不减地如实登记**，直到同一 world
   * 的收尾真的成功才清除。Host 级 `dispose()` 之后仍可读——排障正是要找"够不着的那只"。
   */
  private orphans = new Map<string, OrphanedWorker>()
  private cacheWarningShown = false
  constructor(readonly config: IsaacConfig = {}) {}
  /**
   * 只读回执：当前所有"没能确认结束"的自有 worker。空数组表示每条收尾路径都拿到了确认。
   * 每条记录含 worldId、pid、路径、dispose 原文、最后阶段轨迹与时间——不需要调用方去猜。
   */
  orphanedWorkers(): OrphanedWorker[] { return [...this.orphans.values()].map(record => structuredClone(record)) }
  /** 登记一条孤儿记录（同一 world 后一次失败覆盖前一次：要的是"现在够不着的是谁"）。 */
  private orphan(worldId: string, child: ProcessSimProvider, path: string, failure: unknown): OrphanedWorker {
    const record: OrphanedWorker = {
      worldId, ...(child.pid === undefined ? {} : { pid: child.pid }), path,
      error: failure instanceof Error ? failure.message : String(failure),
      at: Date.now(), phases: child.lifecyclePhases(),
    }
    this.orphans.set(worldId, record)
    return record
  }
  /**
   * 结束一只**尚未交付**的自有 worker（启动失败／取消／释放的收尾）。失败**不吞**：
   * 登记为孤儿并返回失败给调用方，由它并进给用户的那条错误（原始错误码保持不变）。
   * @returns 成功（含本来就已结束）时 undefined，否则 dispose 的真实失败。
   */
  private async releaseUndeivered(worldId: string, child: ProcessSimProvider, path: string): Promise<unknown> {
    try { await child.dispose(); this.orphans.delete(worldId); return undefined }
    catch (failure) { this.orphan(worldId, child, path, failure); return failure }
  }
  /**
   * 把"本次自有 worker 未被确认结束"并进给调用方的错误里：**保留原始 code**（取消/预算/关闭这些
   * 既有的结构化语义不能因为收尾失败就变成另一个码），正文补上 pid、路径与 dispose 原文，
   * `details.orphanedWorker` 带完整可追溯记录；没有孤儿记录时原样返回。
   */
  private withOrphan(error: unknown, worldId: string): unknown {
    const record = this.orphans.get(worldId)
    if (record === undefined) return error
    const code = error instanceof SimError ? error.code : 'PROVIDER_START_FAILED'
    const message = `${error instanceof Error ? error.message : String(error)}；本次自有 worker 未被确认结束（已登记为孤儿：pid=${record.pid ?? 'n/a'}，路径=${record.path}，dispose 原文=${record.error}）`
    return new SimError(code, message, { orphanedWorker: record })
  }
  /** 本次执行真的用的缓存根：给了 `cacheRootFor`（按会话解析，沙箱里真的可写）就按它解析。 */
  private async resolveCacheRoot(): Promise<string> {
    if(this.config.cacheRootFor!==undefined)return await this.config.cacheRootFor()
    return this.config.cacheRoot??resolve(dirname(fileURLToPath(import.meta.url)),'../../../.runtime/isaac-cache')
  }
  /** RTX 冷启动告警（只读存在性预检，不改变 provider 行为，也不额外拉起 worker）；版本键一致性以 worker 的 cache-preflight 事件为准。 */
  private warnIfShaderCacheCold(cacheRoot:string){
    if(this.cacheWarningShown||(this.config.rendering??'none')!=='rtx')return
    this.cacheWarningShown=true
    const rtx=resolve(cacheRoot,'rtx-cache')
    let warm=false
    try{warm=existsSync(rtx)&&readdirSync(rtx).some(version=>{try{return readdirSync(resolve(rtx,version,'nv_shadercache')).length>0}catch{return false}})}catch{warm=false}
    if(!warm)process.emitWarning(`Isaac RTX shader 缓存未预热（${rtx} 下没有任何含文件的 nv_shadercache）：首次运行需一次性 shader/管线编译（本机实测空缓存约 270s 才恢复满速），请给首次运行 ≥300s 时限，并把冷启动与热稳态计时分开。`,'IsaacRtxCachePreflight')
  }
  private instance(worldId: string, allowClosing = false) { const instance=this.instances.get(worldId);if(!instance)throw new SimError('WORLD_NOT_FOUND',`世界不存在: ${worldId}`);if(!allowClosing&&this.closing.has(worldId))throw new SimError('WORLD_CLOSING','世界正在关闭');return instance }
  /**
   * `signal` 是调用方的取消（与 MuJoCo Provider 及传输层同一个可选第三参）：只结束**本次尚未交付的
   * open**（未 ready 的启动按归属终止本次自己的 worker），已交付世界的结束仍只能走 close；不传时行为
   * 与历史一致。未 ready 时 `dispose()` 不悬空的既有语义不变（它走同一条 failProvider→terminateOwned）。
   */
  open(snapshot: SceneSnapshot, options: WorldOptions = {}, signal?: AbortSignal) {
    const opening = this.openImpl(snapshot, options, signal)
    this.openings.add(opening)
    void opening.finally(() => this.openings.delete(opening)).catch(() => undefined)
    return opening
  }
  private async openImpl(snapshot: SceneSnapshot, options: WorldOptions = {}, signal?: AbortSignal) {
    if(this.closed)throw new SimError('PROVIDER_CLOSED','Isaac Provider已关闭')
    if(signal?.aborted)throw new SimError('PROVIDER_START_CANCELLED','PROVIDER_START_CANCELLED：Isaac open 在启动前已取消')
    const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../../..'),worldId=options.worldId??randomUUID()
    if(this.instances.has(worldId)||this.pending.has(worldId)||this.reservations.has(worldId))throw new SimError('WORLD_EXISTS',`worldId已存在: ${worldId}`)
    const reservation=new AbortController()
    this.reservations.set(worldId,reservation)
    const abortReservation=()=>reservation.abort(this.closed
      ? new SimError('PROVIDER_CLOSED','PROVIDER_CLOSED：Isaac Provider在启动准备期间已释放')
      : new SimError('PROVIDER_START_CANCELLED','PROVIDER_START_CANCELLED：Isaac open 在启动准备期间已取消'))
    signal?.addEventListener('abort',abortReservation,{once:true})
    let rejectReservation!:()=>void
    try {
      // Subscribe before invoking user hooks: cacheRootFor may synchronously cancel or dispose.
      const cancelled=new Promise<never>((_resolve,reject)=>{
        rejectReservation=()=>reject(reservation.signal.reason)
        reservation.signal.addEventListener('abort',rejectReservation,{once:true})
        if(reservation.signal.aborted)rejectReservation()
      })
      const cacheRoot=await Promise.race([this.resolveCacheRoot(),cancelled])
      if(this.closed)throw new SimError('PROVIDER_CLOSED','Isaac Provider已关闭')
      if(reservation.signal.aborted)throw reservation.signal.reason
      const pythonPath=this.config.pythonPath??process.env.LYAPUNOV_ISAAC_PYTHON??resolve(root,'.runtime/conda/envs/isaac/bin/python')
      if(!existsSync(pythonPath))throw new SimError('PROVIDER_UNAVAILABLE',`Isaac Sim 6.0.1 当前 Python 入口不存在：${pythonPath}。请在「设置 → 物理引擎」安装 Isaac，或检查并登记已有的兼容本地安装。需要先使用一般物理仿真时，可在同页核对并显式选择 MuJoCo，重启工作台后生效。`,{engineId:'isaac',stage:'python-path',availability:'missing',pythonPath,physicalExecution:false,settingsSection:'lyapunov-engine'})
      this.warnIfShaderCacheCold(cacheRoot)
      const child=new ProcessSimProvider({pythonPath,workerPath:this.config.workerPath??resolve(here,'../python/worker.py'),engineName:'Isaac Sim 6.0.1',env:{...isaacLoaderEnvironment(pythonPath),LYAPUNOV_ISAAC_CACHE:cacheRoot,LYAPUNOV_ISAAC_DEVICE:this.config.physicsDevice??'cpu',LYAPUNOV_ISAAC_RENDERING:this.config.rendering??'none',XDG_CACHE_HOME:resolve(cacheRoot,'xdg-cache'),XDG_CONFIG_HOME:resolve(cacheRoot,'xdg-config'),XDG_DATA_HOME:resolve(cacheRoot,'xdg-data')},...(this.config.launch===undefined?{}:{launch:this.config.launch}),...(this.config.startupBudgetMs===undefined?{}:{startupBudgetMs:this.config.startupBudgetMs})})
      this.lastStarted=child
      this.starts.set(worldId,child)
      this.pending.set(worldId,child)
      try {
        const handle=await child.open(snapshot,{...options,worldId},reservation.signal)
        if(this.closed||reservation.signal.aborted)throw this.closed?new SimError('PROVIDER_CLOSED','Provider在模型加载期间已关闭'):reservation.signal.reason
        this.receipts.delete(worldId);this.closing.delete(worldId);this.instances.set(worldId,{process:child,handle});return handle
      } catch(error) {
        // 唯一的收尾点：无论失败来自 open、取消还是释放，都在这里结束这只尚未交付的 worker。
        // dispose 失败**不吞**（原来这里是 `catch(()=>{})`）：登记为孤儿，并把事实并进给调用方的错误。
        const disposeFailure=await this.releaseUndeivered(worldId,child,'本次 open 未交付时的收尾（失败／取消／释放）')
        // The child sees cancellation before its own dispose latch; retain the owner's closure code and diagnostics.
        const reason=reservation.signal.reason
        const reported=reason instanceof SimError&&reason.code==='PROVIDER_CLOSED'
          ? new SimError('PROVIDER_CLOSED',`${reason.message}；${error instanceof Error?error.message:String(error)}`)
          : error
        throw disposeFailure===undefined?reported:this.withOrphan(reported,worldId)
      }
      finally { this.pending.delete(worldId) }
    } finally {
      reservation.signal.removeEventListener('abort',rejectReservation)
      signal?.removeEventListener('abort',abortReservation)
      if(this.reservations.get(worldId)===reservation)this.reservations.delete(worldId)
    }
  }
  /**
   * 最近一次启动的阶段轨迹（wall-clock 相对毫秒）：`spawned → ready`，以及取消/预算到期/释放时的最后阶段。
   * N60：IsaacProvider 此前只把阶段轨迹放在**失败后的错误 message** 里，启动**进行中**调用方拿到的是黑盒
   * promise。这里透传传输层已有的只读轨迹（不新建字段/通道）。
   * @param worldId - 给了就只读**这个 world** 最近一次启动的轨迹（多世界并发时不会把别人的轨迹当成它的）；
   *   世界从没起过、或没有这个 world 时返回空数组（不伪造）。省略＝最近一只 worker（历史语义不变）。
   */
  lifecyclePhases(worldId?: string): { name: string; elapsedMs: number }[] {
    if(worldId===undefined)return this.lastStarted?.lifecyclePhases() ?? []
    return this.starts.get(worldId)?.lifecyclePhases() ?? []
  }
  async sync(worldId:string,snapshot:SceneSnapshot,options:{forceRebuild?:boolean}={}){const i=this.instance(worldId);try{const handle=await i.process.sync(worldId,snapshot,options);i.handle=handle;return handle}catch(error){i.handle={...i.handle,status:'unavailable'};throw error}}
  describe(worldId:string,entityId:string){return this.instance(worldId).process.describe(worldId,entityId)}
  observe(worldId:string,selection:ObservationSelection={}){return this.instance(worldId).process.observe(worldId,selection)}
  async setPaused(worldId:string,paused:boolean,expectedGeneration:number){const i=this.instance(worldId);const handle=await i.process.setPaused(worldId,paused,expectedGeneration);i.handle=handle;return handle}
  async receipt(worldId:string,actionId:string){
    const cached=this.receipts.get(worldId)?.get(actionId)
    if(cached)return structuredClone(cached)
    const receipt=await this.instance(worldId,true).process.receipt(worldId,actionId)
    this.remember(receipt);return receipt
  }
  private remember(receipt:ActionReceipt){
    if(receipt.status==='accepted'||receipt.status==='running')return
    let receipts=this.receipts.get(receipt.worldId)
    if(!receipts)this.receipts.set(receipt.worldId,receipts=new Map())
    receipts.set(receipt.actionId,structuredClone(receipt))
  }
  async execute(worldId:string,action:SimAction,signal?:AbortSignal){const i=this.instance(worldId);i.handle={...i.handle,status:'running'};try{const receipt=await i.process.execute(worldId,action,signal);this.remember(receipt);return receipt}finally{if(i.handle.status==='running')i.handle={...i.handle,status:'ready'}}}
  stop(worldId:string,selection:StopSelection={}){return this.instance(worldId,true).process.stop(worldId,selection)}
  subscribeFrames(worldId:string,listener:(frame:Frame)=>void){return this.instance(worldId).process.subscribeFrames(worldId,listener)}
  // `geomGroups` 只在 MuJoCo 的 RGB/深度渲染里被真实消费（sim-mujoco worker 的 display_groups）；
  // Isaac 的 USD/RTX 采集没有显示组概念，worker.capture 从不读该字段。原来是原样转发=静默忽略，
  // 调用方会以为过滤生效。显式给出时在这里拒绝，不把参数送给一个不读它的 worker；未给出时行为不变。
  capture(worldId:string,options:CaptureOptions){
    if(options.geomGroups!==undefined)throw new SimError('UNSUPPORTED_CAPABILITY','Isaac 未消费显示组过滤（geomGroups）：Isaac 的 RTX 采集没有 MuJoCo 显示组概念，该参数当前只由 MuJoCo provider 真实生效；拒绝而不是静默忽略')
    return this.instance(worldId).process.capture(worldId,options)
  }
  // 命名相机族**五个接口全部由 Isaac worker 真实实现并在这里原样转发**（同一条 request 名、
  // 同一份 options，不做客户端改写）：清单/同步多相机采集/临时位姿 override/像素+深度标注/
  // 数据集导出。能力边界仍在 worker 侧按真实条件**阶段化**拒绝（没有 RTX 时 RGB+深度类
  // 一律 SENSOR_UNAVAILABLE；captureId 不存在/跨代次/相机不在该 capture 里各有结构化错误码），
  // 所以这里不再有 UNSUPPORTED 空壳——不假装有，也不假装没有。
  /** 同一物理步的多相机采集：复用 worker 的单相机 RTX 通路（rgb+米制深度+标定），由 worker 保证同一步。 */
  captureMulti(worldId:string,options:MultiCaptureOptions){return this.instance(worldId).process.captureMulti(worldId,options)}
  /** 命名相机清单：真实枚举导入层核验过的原生相机（无相机时如实为空），不再是 UNSUPPORTED 空壳。 */
  listCameras(worldId:string){return this.instance(worldId).process.listCameras(worldId)}
  /** 命名相机临时位姿/视场 override：写 live USD 相机 prim（父/世界参考系换算），clear/sync/close 按源快照恢复。 */
  adjustCamera(worldId:string,options:CameraAdjustOptions){return this.instance(worldId).process.adjustCamera(worldId,options)}
  /** 像素+真实米制深度 → camera/world 坐标：用被引用 capture 的真实深度 npy，或本步新鲜渲染的深度。 */
  projectAnnotation(worldId:string,options:CameraAnnotationOptions){return this.instance(worldId).process.projectAnnotation(worldId,options)}
  /** 把已记录的真实采集导出为自包含数据集（samples.jsonl+标定+标注+真实 PNG/NPY 副本）。 */
  exportCameraDataset(worldId:string,options:CameraDatasetExportOptions){return this.instance(worldId).process.exportCameraDataset(worldId,options)}
  assist(worldId:string,options:{mode:'attach'|'release';expectedGeneration:number;objectId:string;robotId?:string;anchorBody?:string}){return this.instance(worldId).process.assist(worldId,options)}
  hasSceneWorld(sceneId:string){if(this.closed)throw new SimError('PROVIDER_CLOSED','Provider已关闭');return [...this.instances.values()].some(i=>i.process.hasSceneWorld(sceneId))}
  async listWorlds(){if(this.closed)throw new SimError('PROVIDER_CLOSED','Provider已关闭');const worlds=await Promise.all([...this.instances.values()].map(i=>i.process.listWorlds()));return worlds.flat()}
  close(worldId:string):Promise<void>{
    const existing=this.closing.get(worldId);if(existing)return existing
    // 世界还没交付时不能把"关闭"冒充成 WORLD_NOT_FOUND：那会把"你刚开、还在启动的这个世界"说成
    // 不存在，调用方据此以为没有东西要收尾。这里给出真实状态与唯一的结束入口（取消那次 open／Host 释放），
    // 也不偷偷替调用方取消一次可能属于别人的 open。
    if(this.reservations.has(worldId)||this.pending.has(worldId))throw new SimError('WORLD_STARTING',`世界仍在启动中、尚未交付: ${worldId}；要结束这次启动请对那次 open 传 AbortSignal（取消），或在 Host 级 dispose() 释放本会话`)
    const i=this.instance(worldId)
    const closing=Promise.resolve().then(async()=>{
      let closeFailure:unknown
      try{await i.process.close(worldId)}catch(error){closeFailure=error}
      let disposeFailure:unknown
      try{await i.process.dispose()}catch(error){disposeFailure=error}
      for(const receipt of i.process.terminalResults(worldId))this.remember(receipt)
      if(disposeFailure!==undefined){
        // worker **未被确认结束**：不能摘除 instance。摘除了它就成了"不在册、没关掉、也不会被重试"的孤儿
        // ——Host 级 dispose() 只枚举 instances/pending，够不着它。保留句柄（下次 close 能重试、Host 释放
        // 还能枚举到），并登记可追溯的孤儿记录（哪条路径、哪个 pid、dispose 原文、最后阶段）。
        const record=this.orphan(worldId,i.process,'close 收尾：worker 未被确认结束',disposeFailure)
        throw new SimError('WORLD_CLOSE_INCOMPLETE',`世界 ${worldId} 的 worker 未被确认结束：${record.error}${closeFailure===undefined?'':`；close 本身也失败：${closeFailure instanceof Error?closeFailure.message:String(closeFailure)}`}（已登记为孤儿：pid=${record.pid ?? 'n/a'}；句柄保留在册，可重试 close，Host 级 dispose() 仍能枚举到本会话的实例）`,{orphanedWorker:record})
      }
      // 进程确认结束：世界确实不存在了，摘除实例与孤儿记录。
      this.orphans.delete(worldId)
      this.instances.delete(worldId)
      // worker 结束了，但 close 本身失败：如实上报，不冒充成功（重试会按既有的世界不存在处理）。
      if(closeFailure!==undefined)throw closeFailure
    })
    this.closing.set(worldId,closing)
    // 无论成败都清掉这次尝试的标记：成功时它只表示"正在关闭"，失败时要让**重试**成为真的重试。
    // （原来成功清、失败留：那会把一次失败的世界永远钉在"拿同一条失败结论"上，句柄也就永远收不回来。）
    void closing.then(()=>{if(this.closing.get(worldId)===closing)this.closing.delete(worldId)},()=>{if(this.closing.get(worldId)===closing)this.closing.delete(worldId)})
    return closing
  }
  dispose(){
    if(this.disposal)return this.disposal
    this.closed=true
    for(const reservation of this.reservations.values())reservation.abort(new SimError('PROVIDER_CLOSED','PROVIDER_CLOSED：Isaac Provider已释放'))
    this.disposal=(async()=>{
      // 收尾对象连同 owner 一起记下来：dispose 失败时要能说清"哪只 worker 成了孤儿"，而不是只抛一个理由。
      const owned=[...this.instances].map(([worldId,instance])=>({worldId,child:instance.process}))
      for(const [worldId,child]of this.pending)if(!owned.some(entry=>entry.child===child))owned.push({worldId,child})
      const results=await Promise.allSettled(owned.map(entry=>entry.child.dispose()))
      results.forEach((result,index)=>{
        const {worldId,child}=owned[index]!
        if(result.status==='rejected')this.orphan(worldId,child,'Host 级 dispose() 收尾：worker 未被确认结束',result.reason)
        else this.orphans.delete(worldId)
      })
      // Reservations cover async cache resolution before a child is in pending; wait until each settles too.
      await Promise.allSettled([...this.openings])
      for(const [worldId,i]of this.instances)for(const receipt of i.process.terminalResults(worldId))this.remember(receipt)
      this.instances.clear();this.pending.clear();this.reservations.clear();this.closing.clear()
      const failed=results.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason
    })()
    return this.disposal
  }
}
