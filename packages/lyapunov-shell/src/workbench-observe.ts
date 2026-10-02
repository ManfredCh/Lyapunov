/**
 * 前端侧的"模型主动观察"执行：模型经 `viewer_observe` 请求"这个窗口现在拍一张"。
 *
 * 为什么单独一个模块：这段判定（Viewer 在不在、窗口当前显示的是不是被请求的场景和版本、采到的图是不是那一版）
 * 必须在**真实前端**和**定向测试的前端替身**里是同一份代码——各写一遍就会漂移，
 * 而漂移出来的测试只能证明测试自己。落盘与来源校验不在这里：它走的是与用户点"采集图像"
 * 完全相同的 `viewer_capture`（服务端唯一实现），这里只决定"要不要采、采到的能不能认"。
 *
 * 这里的"要不要采"包含**资源是否真的加载完**：版本号对上不算数（setScene 在资源加载完成前就换了版本），
 * 必须等到真正 await 过 setScene 的那处登记完成、且 Viewer 的加载失败台账为空。
 */
/**
 * 一次"拍下来"的最小形状：**当前画布截图**（`capture()`）与**按指定相机出图**（`renderCameraImage()`）
 * 都满足它——两者都是 `dataURL` + 自己那份场景身份。其余字段（内参/尺寸/来源）原样随载荷回传，
 * 所以这里只钉住采集真正要读的那三个，多出来的字段谁来都不影响。
 */
export interface ObserveShot {
  dataURL: string; sceneId?: string; sceneRevision?: number
  /**
   * 这一帧的**环境光照事实**：真实 Viewer 的 `capture()` 与 `renderCameraImage()` 都自带
   * （唯一 owner 是 `packages/viewer/src/environment.ts` 的 `environmentCaptureFace()`）。
   * 本模块不解释它，原样 spread 进载荷——它就在**这次**返回值里，与这张图同一帧，
   * 所以读到的永远是"拍这张时的"环境，而不是"现在的"。落盘与措辞在 `viewer_capture` / `environment-capture.ts`。
   */
  environment?: unknown
  /**
   * 这一帧的 **LOD 级别事实**：真实 Viewer 的 `capture()` 与 `renderCameraImage()` 都自带
   * （唯一 owner 是 `packages/viewer/src/index.ts` 的 `lodCaptureFace()`）。与 `environment` 同一纪律：
   * 原样 spread 进载荷——它就在**这次**返回值里，说的是"这一帧用的是哪一级"，
   * 整形与措辞在 `lod-capture.ts`（这里不解释级别语义、不重算距离）。
   */
  lod?: unknown
}
/**
 * 能被观察的 Viewer 最小面：只需要一次同步截图。
 * 真实实现（packages/viewer/src/index.ts 的 `capture()`）在 `toDataURL` **之前**会先 `renderer.render` 一次，
 * 所以拿到的就是当前这一帧，不是上一帧的残留；本模块不重复渲染（重复渲染只会白耗一次整屏绘制）。
 */
export interface ObservableViewer {
  capture(): ObserveShot
  /**
   * 这四种是"按指定相机"那一半的能力（真实实现见 `packages/viewer/src/index.ts`）。都是可选的：
   * 页面里的 Viewer 可能是旧版本、或根本不是原生 Viewer（例如只读的官方视角画面），
   * 那时**明确失败**（`VIEWER_CAMERA_UNSUPPORTED`），绝不用"看起来像应用过了"的回执糊过去。
   *  · `applyCameraView(request)` → 应用并把**应用后当场测量**的相机读数交回来；
   *  · `cameraView()` → 只读当前相机读数；
   *  · `renderCameraImage(request)` → 用指定相机、指定像素尺寸出图（`source:"native-viewer-camera"`）；
   *  · `getViewState()/setViewState(state)` → 可恢复的完整相机状态（roll/视场/内参都在里面）。
   */
  applyCameraView?(request: unknown): unknown
  cameraView?(): unknown
  renderCameraImage?(request: unknown): unknown
  getViewState?(): unknown
  setViewState?(state: unknown): void
  /** 该 Viewer 自己的资源加载失败台账（真实 Viewer 已有公开的 `loadingErrors`）。空才说明画面里该有的都在。 */
  loadingErrors?: ReadonlyMap<string, string>
  /**
   * 该 Viewer 自己的**缺件警告**（真实 Viewer 已有公开的 `visualWarnings`）：实体 id → 警告文本。
   * 与失败台账是两种事实：那张表是"这个实体没加载成功"，这张表是"它画出来了，但少了几个部件"。
   * 有警告**不**拒绝采集（否则有缺件的机器人场景永远拍不了），但采集结果必须如实带上它——
   * 模型要能看见"少的是哪一部分"，而不是把这张图当成完整场景。
   */
  visualWarnings?: ReadonlyMap<string, readonly string[]>
}
/**
 * 本窗口**真正完成加载**的场景身份：只有 await 过 setScene 的那处能登记。
 *
 * 为什么不能只看版本字符串：Viewer 的 `setScene` 在 `await Promise.all(loadVisual)` **之前**就更新了 snapshot，
 * workbench 的 `sceneRef` 同样在加载在途时就带上新 revision——异步 GLB 还没回来时，
 * "版本已经是新的"与"画面已经是新的"是两件事，此时截图会把缺对象的画面标成新版本。
 * `settled` = 那次 setScene 的 promise 已落地（所有实体的异步加载都结束了）；`failed` = 它抛了。
 */
export interface ObserveLoadState { sceneId: string; revision: number; settled: boolean; failed?: boolean }
/**
 * 动作去重：同一条 `captureViewer` 只执行一次，重复投递返回 false。
 *
 * 为什么需要：服务端要等到 ack 才把动作出队，而 state 轮询是 250ms 一跳、采集（toDataURL + 落盘 POST）
 * 常常更慢——同一条动作在确认前会被下一轮轮询再看到一次。没有这道去重，一次观察会拍两张图、落两份盘
 * （模型侧结果不受影响，但相机面板里会多出一张没有出处的图，也白白多耗一次整屏编码）。
 */
export function createObserverActionGuard(){
 const consumed=new Set<string>()
 return (observeId:string):boolean=>{
  if(consumed.has(observeId))return false
  consumed.add(observeId)
  // 只保留最近一小批：这个集合只为"确认前的重复投递"服务，不当作历史记录。
  if(consumed.size>64)for(const id of consumed){consumed.delete(id);if(consumed.size<=32)break}
  return true
 }
}
export interface ObserveCaptureInput {
  /** 被请求的场景与版本（来自服务端排队的动作）。 */
  sceneId: string
  expectedRevision: number
  /** 这次观察的 id 与目标窗口 id：原样回传，服务端据此把它对回等待者。 */
  observeId: string
  clientId: string
  sessionId?: string
  /** 该窗口此刻的状态：视口是否可见、Viewer 实例、正在显示的场景与版本。 */
  viewerVisible: boolean
  viewer?: ObservableViewer
  displayed?: { sceneId?: string; revision?: number; entityIds?: readonly string[] }
  /**
   * 读一次"本窗口已确认加载完成"的场景身份（workbench 传它自己那处 `await setScene` 消费者登记的读取函数）。
   * 不给 = 无法证明资源已就绪，这次观察会明确失败而不是拍一张可能缺对象的图。
   */
  loadState?: () => ObserveLoadState | undefined
  /** 等待一次加载完成的上限（毫秒）；测试用它把"正在加载"的分支跑短。 */
  readyTimeoutMs?: number
  /** 真实落盘入口（workbench 传 `api.capture`）。 */
  capture: (payload: unknown) => Promise<unknown>
  /**
   * 拍之前的准备：把请求的相机落到窗口上（"按指定相机采集"）。返回值随载荷回传（应用后量到的相机读数）。
   * 与下面的 `shoot` 分开是因为两件事不同：先摆相机、再拍那一张；中间任何一步失败都不产生图。
   */
  prepare?: (viewer: ObservableViewer) => unknown
  /**
   * 拍哪一张：默认 `viewer.capture()`（当前画布——"观察"的语义一字未改）；
   * "按指定相机出图"时换成 `renderCameraImage`（同一台 Viewer、同一个 scene，另一台相机、另一套像素尺寸）。
   */
  shoot?: (viewer: ObservableViewer) => ObserveShot
}
/** 等"这一次 setScene 真正加载完"的上限：本地资源/GLB 读取是秒级，超过就是确实没完成，明确报错而不是继续等。 */
const READY_WAIT_MS = 4000
const READY_POLL_MS = 50
/** 失败台账里只认**当前画面里应当存在**的实体：被移出场景的旧实体不该永远挡着观察。 */
function loadFailures(viewer: ObservableViewer, entityIds?: readonly string[]): string[] {
  const errors = viewer.loadingErrors
  if (!errors || errors.size === 0) return []
  const failed = [...errors.keys()]
  return entityIds ? failed.filter(entityId => entityIds.includes(entityId)) : failed
}
/** 同一套归属过滤（只认当前画面里的实体），但读的是缺件警告那张表：它不拦采集，只随采集如实上报。 */
function loadWarnings(viewer: ObservableViewer, entityIds?: readonly string[]): Array<{ entityId: string; warning: string }> {
  const table = viewer.visualWarnings
  if (!table || table.size === 0) return []
  const rows = [...table].flatMap(([entityId, warnings]) => (warnings ?? []).map(warning => ({ entityId, warning: String(warning) })))
  return entityIds ? rows.filter(row => entityIds.includes(row.entityId)) : rows
}
/**
 * 等到"请求的这一版**加载完成**"，否则给出明确原因。
 *
 * 版本字符串相同不等于画面就绪（见 ObserveLoadState）：这里只认真正 await 过 setScene 的登记。
 * 正在加载 → 等一小会儿（沿同一次加载的完成事实，不重启加载、不轮询服务端）；仍未完成则报 `..._LOADING`；
 * 加载抛错报 `..._LOAD_FAILED`；登记的不是这一版（例如上一次 setScene 还没落地）报 `..._NOT_READY`。
 */
async function requireLoaded(input: ObserveCaptureInput, sceneId: string, expectedRevision: number): Promise<void> {
  const waitMs = input.readyTimeoutMs ?? READY_WAIT_MS
  const deadline = Date.now() + waitMs
  let last: ObserveLoadState | undefined
  for (;;) {
    last = input.loadState?.()
    if (last && last.sceneId === sceneId && last.revision === expectedRevision) {
      if (last.failed) throw new Error(`VIEWER_OBSERVE_SCENE_LOAD_FAILED: 目标窗口加载 ${sceneId} rev ${String(expectedRevision)} 失败，画面不完整，因此不采集（这次观察没有成立）。`)
      if (last.settled) return
    }
    if (Date.now() >= deadline) break
    await new Promise<void>(resolve => setTimeout(resolve, READY_POLL_MS))
  }
  if (!input.loadState) throw new Error("VIEWER_OBSERVE_SCENE_NOT_READY: 目标窗口没有登记过这次场景加载的完成事实，无法证明资源已就绪，因此不采集。")
  if (!last) throw new Error(`VIEWER_OBSERVE_SCENE_LOADING: 目标窗口还没有开始加载 ${sceneId} rev ${String(expectedRevision)}，因此不采集。`)
  if (last.sceneId !== sceneId || last.revision !== expectedRevision) throw new Error(`VIEWER_OBSERVE_SCENE_NOT_READY: 目标窗口已确认加载完成的是 ${last.sceneId} rev ${String(last.revision)}${last.settled ? "" : "（尚未完成）"}，不是请求的 ${sceneId} rev ${String(expectedRevision)}。`)
  throw new Error(`VIEWER_OBSERVE_SCENE_LOADING: 目标窗口正在加载 ${sceneId} rev ${String(expectedRevision)}，等了 ${waitMs >= 1000 ? `${String(Math.round(waitMs / 1000))} 秒` : `${String(waitMs)} 毫秒`}仍未完成（异步资源还在读取）；没有截这张可能缺对象的图，稍后可重试。`)
}
/**
 * 采集一次并交给服务端。任何一步不成立都抛明确错误——由调用方（工作台/测试）把原因回执给等着的工具；
 * 失败时不产生任何"看起来像成功"的图。
 * 顺序：目标窗口 → 显示的场景/版本一致 → **这一次加载真的完成**且失败台账为空 → 截图 → 图确实属于该版本。
 */
export async function captureForObserver(input: ObserveCaptureInput): Promise<unknown> {
  const { sceneId, expectedRevision } = input
  if (!input.viewerVisible || !input.viewer) throw new Error("VIEWER_OBSERVE_VIEWER_UNAVAILABLE: 目标窗口的 3D 视口当前不可用（Viewer 已关闭或未挂载），没有可采集的画面。")
  const displayed = input.displayed
  requireDisplayedScene(displayed, sceneId, expectedRevision)
  await requireLoaded(input, sceneId, expectedRevision)
  // 与 `requireDisplayedScene` 同一份"画面里应当有哪些实体"的过滤依据（它刚核对过 displayed 的场景/版本）。
  const entityIds = displayed?.entityIds
  const failures = loadFailures(input.viewer, entityIds)
  if (failures.length) throw new Error(`VIEWER_OBSERVE_SCENE_LOAD_FAILED: 目标窗口加载 ${sceneId} rev ${String(expectedRevision)} 时有 ${String(failures.length)} 个实体没加载成功（${failures.join("、")}）：这些实体不会出现在画面里，所以这次不采集。`)
  // 相机先落到窗口上、再拍：两件事分开是为了让"相机没应用成"与"图没拍成"的失败原因不会混成一个。
  const prepared = input.prepare ? input.prepare(input.viewer) : undefined
  const value = input.shoot ? input.shoot(input.viewer) : input.viewer.capture()
  // 采集读的是 Viewer 自己的快照：再核对一次，避免"场景正在换版本"的瞬间把旧图当成目标版本。
  if (value.sceneId !== sceneId || value.sceneRevision !== expectedRevision) throw new Error(`VIEWER_OBSERVE_CAPTURE_REVISION_MISMATCH: 采到的是 ${value.sceneId ?? "?"} rev ${String(value.sceneRevision ?? "?")}，不是请求的 ${sceneId} rev ${String(expectedRevision)}。`)
  // 缺件警告与这张图**同一版本**：图刚刚被核到就是请求的这一版（上面那行），读的又是同一个 Viewer 的同一批物体，
  // 所以这些警告说的就是画面里少的那些东西。随载荷一起回传，由 `viewer_capture` 落进采集记录、再由工具结果如实带给模型。
  // 环境窄面（`value.environment`，真实 Viewer 的 `capture()` 与 `renderCameraImage()` 都自带）同理：它就在这次截图的
  // 返回值里，与这张图同一帧、同一版本，spread 进载荷时原样带走，不需要在这里再读一次环境状态（那会读到"现在的"而不是"拍这张时的"）。
  const warnings = loadWarnings(input.viewer, entityIds)
  return input.capture({ ...value, ...(prepared === undefined ? {} : { appliedCamera: prepared }), sessionId: input.sessionId, clientId: input.clientId, observeId: input.observeId, ...(warnings.length ? { visualWarnings: warnings } : {}) })
}
/**
 * 目标窗口**显示身份**核对：它现在显示的必须就是被请求的那个场景、那个版本。
 *
 * 观察（`captureForObserver`）与相机（`workbench-camera.ts`）两条路径共用这一份实现——
 * 判据一样，只有错误码前缀不同（`VIEWER_OBSERVE_*` / `VIEWER_CAMERA_*`），调用方按自己的域传前缀。
 */
export function requireDisplayedScene(displayed: { sceneId?: string; revision?: number } | undefined, sceneId: string, expectedRevision: number, prefix = "VIEWER_OBSERVE"): void {
  if (!displayed?.sceneId || displayed.sceneId !== sceneId) throw new Error(`${prefix}_SCENE_NOT_LOADED: 目标窗口当前显示的是 ${displayed?.sceneId ?? "（没有场景）"}，不是请求的 ${sceneId}。`)
  if (displayed.revision !== expectedRevision) throw new Error(`${prefix}_STALE_REVISION: 目标窗口显示的是 ${sceneId} rev ${String(displayed.revision)}，不是请求的 rev ${String(expectedRevision)}。`)
}
