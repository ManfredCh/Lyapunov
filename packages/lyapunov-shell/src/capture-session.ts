/**
 * 连续视频 + A→B→C 路线的界面与生命周期（R-005）。
 *
 * 为什么把录制会话放在**工作台顶层**的 hook 里、而不是 Capture 面板组件里：切工具栏会卸载面板，
 * 面板内的录制状态会随之丢失。会话在这里只创建一次，面板只读取状态/发命令，因此切工具不重建 Viewer、
 * 也不打断正在进行的录制；窗口关闭/卸载时统一取消并释放流与计时器。
 *
 * 录制只走 `ContinuousVideoRecorder`（真实 MediaRecorder + 真实画布流），本文件不伪造任何帧。
 *
 * 生命周期归属（P7B 复核修复，见主控 `capture-lifecycle-probe.tsx`）：
 *  · 操作开始时把 **API、Viewer 实例、Scene 与会话上下文对象** 一并固定在 `CaptureOperation` 里；
 *    最终上传沿 `op.api`，不读收尾当刻的 props（否则切 API 会把旧场景视频传到新会话）。
 *  · 上下文对象在 SceneId 或 API 变化时换成**新对象**：因此 A→B→A 也拿不到同一个身份，
 *    迟到回执不会冒充当前操作（只比 sceneId 文字会把回到 A 误判成"仍是当前"）。
 *  · 当前 Viewer 关闭/更换（`viewerVisible=false` 或 getter 换实例）时终结真实 Recorder 与计时器，
 *    已有字节按真实 `stopReason` 保存，源画布不可用后不保持 Recording。
 *  · 保存成功/失败只在操作仍拥有当前 Scene+API 时回调当前 UI；旧结果仍上传到原 owner，
 *    不覆盖新 Scene/会话/新 Viewer 或新操作。保存失败保留已录字节并给下载恢复入口，不先标成功。
 *  · Cancel 先进入 Cancelling，等原生 MediaRecorder onstop（有界超时）后才释放/清 op；期间禁止
 *    同一 Viewer 开第二段录制。0B/flush 错误/停止超时按失败处理，不生成 0B 恢复下载。
 */
import {useCallback,useEffect,useMemo,useRef,useState} from "react"
import type {WorldHandle} from "../../lyapunov-contracts/src/types.ts"
import type {NamedCamera} from "../../viewer/src/camera-view.ts"
import type {SceneViewer,ViewerViewState} from "@lyapunov/viewer/client"
import type {Translate} from "./entity-editor.tsx"
import type {workbenchAPI} from "./workbench-api.ts"
import {ContinuousVideoRecorder,browserMediaRecorderCtor,type CaptureVideoRecord,type CaptureVideoSample,type CaptureVideoSource} from "./capture-video.ts"
import {planCaptureRoute,routePlanSummary,sampleRoutePlan,type CaptureRoute} from "./capture-route.ts"

export type CapturePhase = "idle" | "free" | "route-preview" | "route-record" | "cancelling"

/** 一次操作的会话身份：SceneId 或 API 变化就换新对象；A→B→A 也会得到新身份。 */
interface CaptureContext {
  sceneId?: string
  api: ReturnType<typeof workbenchAPI>
}

interface CaptureOperation {
  kind: CapturePhase
  token: number
  /** 操作开始时固定的上传 owner；收尾沿它走，不读收尾当刻的 props。 */
  api: ReturnType<typeof workbenchAPI>
  /** 操作开始时固定绑定的真实 Viewer 实例；恢复镜头只认这一台。 */
  viewer: SceneViewer
  /** 操作开始时的会话身份；与当前身份不同就说明旧操作已不属于当前窗口。 */
  context: CaptureContext
  sceneId?: string
  sceneRevision?: number
  worldId?: string
  worldGeneration?: number
  original: ViewerViewState
  source: CaptureVideoSource
  route?: CaptureRoute
  plan?: ReturnType<typeof routePlanSummary>
  frameRate: number
  /** Cancel 后旧回执只允许清理自己的资源，不能再写 UI/保存/恢复新场景镜头。 */
  cancelled?: boolean
}

export interface CaptureOrphan {
  url: string
  bytes: number
  mimeType: string
  fileName: string
  error: string
}

export interface ContinuousCaptureSession {
  phase: CapturePhase
  elapsedMs: number
  totalMs?: number
  /** 路线当前路段：index 是出发站，hold 表示正在该站停留；自由拍摄时不存在。 */
  currentSegment?: {index:number;phase:"hold"|"move"}
  /** 当前运动相机的真实位姿与镜头（录制/预览时由路线采样写入 Viewer 临时 POV；主相机不被挪动）。 */
  currentPose?: {position:number[];quaternion:number[];fovDeg?:number;near?:number;far?:number;intrinsics?:ViewerViewState["intrinsics"]}
  saving: boolean
  error: string
  notice: string
  orphan?: CaptureOrphan
  startFree: () => void
  stop: () => void
  /** 取消会等到原生 onstop/超时确认后才回到 idle；期间 phase=Cancelling 且禁止重开。 */
  cancel: () => Promise<void> | void
  startRoute: (route: CaptureRoute, cameras: readonly NamedCamera[], mode: "preview" | "record") => void
  clear: () => void
}

/** 一帧真实 Viewer 状态 → 会话里只读的当前相机 pose（镜头字段有就带，不补假值）。 */
const poseOfState = (state: ViewerViewState) => ({
  position: [...state.position], quaternion: [...state.quaternion],
  ...(state.fovDeg !== undefined ? { fovDeg: state.fovDeg } : {}),
  ...(state.near !== undefined ? { near: state.near } : {}),
  ...(state.far !== undefined ? { far: state.far } : {}),
  ...(state.intrinsics !== undefined ? { intrinsics: state.intrinsics } : {}),
})

/**
 * 路线站点 → Viewer 显示总览用的只读投影。缺机位/缺位姿/缺镜头标 `available:false`，绝不补零位姿。
 * 这只用于「总览/临时 POV」这一轮 capture，不保存、不插值、不写回 Scene。
 */
const routeStationInputs = (route: CaptureRoute, cameras: readonly NamedCamera[]) => route.stops.map((stop, index) => {
  const camera = cameras.find(row => row.name === stop.cameraName)
  const state = camera?.state as any
  const vec = (value: unknown, length: number) => Array.isArray(value) && value.length === length && value.every(item => typeof item === "number" && Number.isFinite(item)) ? [...value] : undefined
  const position = vec(state?.position, 3), quaternion = vec(state?.quaternion, 4)
  const fovDeg = typeof state?.fovDeg === "number" && Number.isFinite(state.fovDeg) ? state.fovDeg : undefined
  const intrinsics = state?.intrinsics && typeof state.intrinsics === "object" ? state.intrinsics : undefined
  return {
    key: stop.cameraName || `stop:${index}`,
    ...position ? { position } : {}, ...quaternion ? { quaternion } : {},
    ...fovDeg === undefined ? {} : { fovDeg },
    ...typeof state?.near === "number" && Number.isFinite(state.near) ? { near: state.near } : {},
    ...typeof state?.far === "number" && Number.isFinite(state.far) ? { far: state.far } : {},
    ...intrinsics === undefined ? {} : { intrinsics },
    available: Boolean(camera && position && quaternion && (intrinsics !== undefined || fovDeg !== undefined)),
  }
})

/** 只清操作开始时固定那台 Viewer 的临时 POV；不碰当前 UI/Scene 的其他状态。 */
const clearRouteCaptureView = (op: CaptureOperation) => {
  try { op.viewer.clearRouteCaptureView() } catch { /* Viewer 已关闭/已更换 */ }
}

const FRAME_RATE = 30

/**
 * 连续录制/路线驱动的唯一会话：自由视角与路线录制共用同一个记录器与同一个原视角快照。
 * `viewer`、`sceneId` 等都是 getter，读的是调用当刻的工作台状态，不在闭包里冻住旧值。
 */
export function useContinuousCaptureSession(input: {
  api: ReturnType<typeof workbenchAPI>
  viewer: () => SceneViewer | undefined
  /** Viewer 是否仍然渲染；关闭 Viewer 时工作台会置 false 并释放实例。 */
  viewerVisible?: boolean
  sceneId?: string
  sceneRevision?: number
  world?: WorldHandle
  tr: Translate
  onSaved: (record: CaptureVideoRecord) => void
  onError: (message: string) => void
}): ContinuousCaptureSession {
  const { api, viewer, viewerVisible = true, sceneId, sceneRevision, world, tr, onSaved, onError } = input
  const [phase, setPhase] = useState<CapturePhase>("idle")
  const [elapsedMs, setElapsedMs] = useState(0)
  const [totalMs, setTotalMs] = useState<number>()
  const [currentSegment, setCurrentSegment] = useState<{index:number;phase:"hold"|"move"}>()
  const [currentPose, setCurrentPose] = useState<{position:number[];quaternion:number[];fovDeg?:number;near?:number;far?:number;intrinsics?:ViewerViewState["intrinsics"]}>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [orphan, setOrphan] = useState<CaptureOrphan>()
  const recorderRef = useRef<ContinuousVideoRecorder>()
  const tokenRef = useRef(0)
  const opRef = useRef<CaptureOperation>()
  const samplesRef = useRef<CaptureVideoSample[]>([])
  const rafRef = useRef<number>()
  const timerRef = useRef<ReturnType<typeof setInterval>>()
  const phaseRef = useRef<CapturePhase>("idle")
  /** 当前操作的停止任务；只与同一个 op 去重，旧 op 的慢保存在新 op 开始时不得挡住新一轮 Stop。 */
  const finishRef = useRef<{ op: CaptureOperation; promise: Promise<void> }>()
  const cancelRef = useRef<Promise<void>>()
  /** 原生 stop 尚未 onstop 的确认点；Cancel 在 Stop 期间必须等它，不能领新 Start。 */
  const stopAckRef = useRef<{ op: CaptureOperation; promise: Promise<void> }>()
  const sceneRef = useRef({ sceneId, sceneRevision, worldId: world?.worldId, worldGeneration: world?.worldGeneration })
  sceneRef.current = { sceneId, sceneRevision, worldId: world?.worldId, worldGeneration: world?.worldGeneration }
  // 会话身份只在 SceneId/API 真的变化时换新对象（`useMemo` 依赖变化才重建）：A→B→A 会重建，
  // 所以第一次 A 的迟到回执拿不到"当前身份"。revision 变化不重建（同一次操作的来源版本已固定）。
  const context = useMemo<CaptureContext>(() => ({ sceneId, api }), [sceneId, api])
  const contextRef = useRef(context)
  contextRef.current = context

  const clearTimers = () => {
    if (rafRef.current !== undefined) { cancelAnimationFrame(rafRef.current); rafRef.current = undefined }
    if (timerRef.current !== undefined) { clearInterval(timerRef.current); timerRef.current = undefined }
  }

  /** 同步 phase 与 React state：异步收尾期间重复 Start/Cancel 先看 ref，不等下一次渲染。 */
  const setPhaseNow = (next: CapturePhase) => { phaseRef.current = next; setPhase(next) }

  /** 操作是否仍拥有当前 Scene+API 会话（既决定能不能回调当前 UI，也决定能不能恢复镜头）。 */
  const ownsContext = (op: CaptureOperation) => op.context === contextRef.current

  /** 只有操作仍属于当前会话**且**当前 Viewer 就是操作开始时那一台时才恢复原镜头；旧回执绝不覆盖新 Viewer。 */
  const restoreView = useCallback((op: CaptureOperation, restore: boolean) => {
    // 临时路线 POV 属于操作开始时那台 Viewer：无论是否还拥有当前上下文、是否恢复主视角，都必须清掉。
    clearRouteCaptureView(op)
    if (!restore || !ownsContext(op)) return
    const instance = viewer()
    if (!instance || instance !== op.viewer) return
    try { instance.setViewState(op.original, { focus: false }) } catch { /* 恢复失败不回滚已保存的编辑 */ }
  }, [viewer])

  /** 只结束仍属于当前对象的操作；Cancel 已经把 opRef 清掉时，旧 Stop/保存回执不得再写 UI。 */
  const settleIdle = (op: CaptureOperation, restore: boolean) => {
    if (opRef.current !== op) return
    opRef.current = undefined
    setPhaseNow("idle"); setElapsedMs(0); setTotalMs(undefined); setCurrentSegment(undefined)
    restoreView(op, restore)
  }

  const finishRecording = useCallback((reason: string, restore: boolean): Promise<void> => {
    const op = opRef.current
    const running = finishRef.current
    if (running && running.op === op) return running.promise
    const recorder = recorderRef.current
    if (!recorder || !op) return Promise.resolve()
    recorderRef.current = undefined
    tokenRef.current += 1
    clearTimers()
    let resolveAck: () => void = () => {}
    const ack = new Promise<void>(resolve => { resolveAck = resolve })
    stopAckRef.current = { op, promise: ack }
    const task = (async () => {
      let result
      try { result = await recorder.stop(reason) }
      catch (failure) {
        if (opRef.current === op && !op.cancelled) {
          const message = String(failure)
          if (ownsContext(op)) { setError(message); onError(message) }
          settleIdle(op, restore)
        }
        return
      } finally {
        // 原生 encoder 的 onstop/超时已经落定；Cancel 若在 Stop 期间点击，此刻才允许清理/重开。
        resolveAck()
        if (stopAckRef.current?.promise === ack) stopAckRef.current = undefined
      }
      // Cancel 在 flush 期间发生：不保存、不恢复、不清新操作；取消路径自己清理。
      if (op.cancelled || opRef.current !== op) return
      // 记录器已经停止并释放输出流：此刻清临时 POV，不会再让主相机画面混进最后一帧。
      clearRouteCaptureView(op)
      // 0 B / flush 错误 / 超时都是明确失败：不上传、不冒充已保存；只有非空字节才给排查下载。
      if (result.bytes <= 0 || result.error) {
        const detail = result.error || "VIDEO_BYTES_EMPTY: 没有收到任何视频字节"
        const message = result.bytes <= 0
          ? tr(`视频未保存：没有收到任何可播放字节（${detail}）。未生成下载，也未标记为成功。`, `Video not saved: no playable bytes were produced (${detail}). No download was created and it is not marked as saved.`)
          : tr(`视频未保存：录制结束不完整（${detail}）。只保留 ${result.bytes} B 不完整字节供排查下载，未标记为成功。`, `Video not saved: the recording did not finish cleanly (${detail}). Only ${result.bytes} B of incomplete bytes are kept for troubleshooting download; it is not marked as saved.`)
        if (opRef.current === op) {
          if (ownsContext(op)) { setError(message); onError(message) }
          if (result.bytes > 0 && typeof URL.createObjectURL === "function") {
            setOrphan({ url: URL.createObjectURL(result.blob), bytes: result.bytes, mimeType: result.mimeType, fileName: `capture-video.${result.container === "unknown" ? "bin" : result.container}`, error: detail })
          }
          settleIdle(op, restore)
        }
        return
      }
      setSaving(true)
      try {
        const samples = samplesRef.current.slice()
        // 沿操作开始时固定的 API 上传；切 API/会话不会把旧场景视频发到新会话。
        const record = await op.api.saveVideo({
          metadata: {
            sceneId: op.sceneId, sceneRevision: op.sceneRevision,
            ...op.worldId ? { worldId: op.worldId } : {}, ...op.worldGeneration !== undefined ? { worldGeneration: op.worldGeneration } : {},
            source: op.source, mediaType: result.mimeType, width: result.width, height: result.height,
            startedAt: result.startedAt, stoppedAt: result.stoppedAt, durationMs: result.durationMs,
            stopReason: result.stopReason, frameRate: op.frameRate,
            ...samples.length ? { cameraSamples: samples } : {},
            ...op.route ? { route: { route: op.route, plan: op.plan } } : {},
          },
          blob: result.blob,
        })
        // 旧操作的结果已落盘到原 owner，但只有仍属于当前会话时才写进当前 UI 列表/提示。
        if (opRef.current === op && !op.cancelled && ownsContext(op)) {
          onSaved(record)
          setNotice(tr(`连续视频已保存：${record.container}/${record.codec} · ${record.width}×${record.height} · ${(record.durationMs / 1000).toFixed(2)} s · ${record.bytes} B`, `Continuous video saved: ${record.container}/${record.codec} · ${record.width}×${record.height} · ${(record.durationMs / 1000).toFixed(2)} s · ${record.bytes} B`))
        }
      } catch (failure) {
        // 保存失败：**保留已录字节**并用浏览器直接下载作为恢复入口，绝不先标成功。
        if (opRef.current === op && result.bytes > 0 && typeof URL.createObjectURL === "function") {
          setOrphan({ url: URL.createObjectURL(result.blob), bytes: result.bytes, mimeType: result.mimeType, fileName: `capture-video.${result.container === "unknown" ? "bin" : result.container}`, error: String(failure) })
        }
        if (opRef.current === op && !op.cancelled && ownsContext(op)) {
          const message = tr(`视频已录制约 ${(result.durationMs / 1000).toFixed(2)} 秒（${result.bytes} B，${result.mimeType || "未知容器"}），但写入会话失败：${String(failure)}。字节已保留，可直接下载；未标记为成功保存。`, `Video recorded about ${(result.durationMs / 1000).toFixed(2)} s (${result.bytes} B, ${result.mimeType || "unknown container"}) but writing it to the session failed: ${String(failure)}. The bytes are kept for direct download and are NOT marked as saved.`)
          setError(message); onError(message)
        }
      } finally {
        if (opRef.current === op) setSaving(false)
      }
      settleIdle(op, restore)
    })()
    const entry = { op, promise: task }
    finishRef.current = entry
    void task.then(() => { if (finishRef.current === entry) finishRef.current = undefined }, () => { if (finishRef.current === entry) finishRef.current = undefined })
    return task
  }, [onSaved, onError, tr, restoreView])

  const finishRoute = useCallback(async (reason: string) => {
    const op = opRef.current
    if (!op || op.cancelled || phaseRef.current === "cancelling") return
    clearTimers()
    if (op.kind === "route-record") await finishRecording(reason, true)
    else {
      tokenRef.current += 1
      opRef.current = undefined
      setPhaseNow("idle"); setElapsedMs(0); setTotalMs(undefined); setCurrentSegment(undefined)
      restoreView(op, true)
    }
  }, [finishRecording, restoreView])

  const startFree = useCallback(() => {
    const instance = viewer()
    if (!instance) { setError(tr("没有可录制的真实渲染画布（Viewer 未渲染）。", "No real render canvas to record (viewer is not rendering).")); return }
    // Cancelling / 旧编码器 stop 未确认时都不能开第二段；此时 phase 与小浮条明确显示取消中。
    if (recorderRef.current || opRef.current || cancelRef.current || phaseRef.current === "cancelling") return
    setError(""); setNotice(""); setOrphan(undefined)
    const current = sceneRef.current
    const op: CaptureOperation = { kind: "free", token: ++tokenRef.current, api, viewer: instance, context: contextRef.current, sceneId: current.sceneId, sceneRevision: current.sceneRevision, worldId: current.worldId, worldGeneration: current.worldGeneration, original: instance.getViewState(), source: "free-view", frameRate: FRAME_RATE }
    const recorder = new ContinuousVideoRecorder({ now: () => Date.now(), MediaRecorderCtor: browserMediaRecorderCtor(), openTarget: frameRate => instance.captureCanvasStream(frameRate), frameRate: FRAME_RATE })
    try { recorder.start() }
    catch (failure) { setError(String(failure)); return }
    opRef.current = op; samplesRef.current = []; recorderRef.current = recorder
    setPhaseNow("free"); setElapsedMs(0); setTotalMs(undefined); setCurrentSegment(undefined); setCurrentPose(poseOfState(op.original))
    const started = performance.now()
    const sample = () => {
      if (opRef.current?.token !== op.token) return
      const state = instance.getViewState()
      samplesRef.current.push({ tMs: performance.now() - started, position: state.position, quaternion: state.quaternion, ...state.fovDeg !== undefined ? { fovDeg: state.fovDeg } : {} })
      setCurrentPose(poseOfState(state))
      setElapsedMs(Math.round(performance.now() - started))
    }
    sample()
    timerRef.current = setInterval(sample, 500)
  }, [api, viewer, tr])

  const startRoute = useCallback((route: CaptureRoute, cameras: readonly NamedCamera[], mode: "preview" | "record") => {
    const instance = viewer()
    if (!instance) { setError(tr("没有可驱动的真实渲染画布（Viewer 未渲染）。", "No real render canvas to drive (viewer is not rendering).")); return }
    if (recorderRef.current || opRef.current || cancelRef.current || phaseRef.current === "cancelling") return
    const planned = planCaptureRoute(route, cameras)
    if (!planned.ok) { setError(planned.reason); return }
    setError(""); setNotice(""); setOrphan(undefined)
    const current = sceneRef.current
    const op: CaptureOperation = { kind: mode === "preview" ? "route-preview" : "route-record", token: ++tokenRef.current, api, viewer: instance, context: contextRef.current, sceneId: current.sceneId, sceneRevision: current.sceneRevision, worldId: current.worldId, worldGeneration: current.worldGeneration, original: instance.getViewState(), source: "route", route, plan: routePlanSummary(planned.plan), frameRate: FRAME_RATE }
    samplesRef.current = []
    const recorder = mode === "record" ? new ContinuousVideoRecorder({ now: () => Date.now(), MediaRecorderCtor: browserMediaRecorderCtor(), openTarget: frameRate => instance.captureCanvasStream(frameRate), frameRate: FRAME_RATE }) : undefined
    // 主视口先落到本路线的总览（真实站点相机 + 场景主体），之后**不再**每 tick 挪动主相机。
    // 首帧必须来自路线 A：先把临时 POV 设到 A，再打开真实采集流。
    try {
      instance.frameCaptureRoute(routeStationInputs(route, cameras))
      instance.setRouteCaptureView(sampleRoutePlan(planned.plan, 0).state)
      recorder?.start()
    } catch (failure) {
      clearRouteCaptureView(op)
      try { instance.setViewState(op.original, { focus: false }) } catch { /* Viewer已关闭时保留原失败 */ }
      setError(String(failure)); return
    }
    if (recorder) recorderRef.current = recorder
    opRef.current = op
    setPhaseNow(op.kind); setElapsedMs(0); setTotalMs(planned.plan.totalMs); setCurrentSegment({index:0,phase:"hold"})
    const started = performance.now()
    const tick = () => {
      if (opRef.current?.token !== op.token) return
      const elapsed = performance.now() - started
      const clamped = Math.min(elapsed, planned.plan.totalMs)
      const sample = sampleRoutePlan(planned.plan, clamped)
      // 只更新临时 capture camera；主视口/OrbitControls/物理时钟一概不动，用户可继续操作总览。
      try { instance.setRouteCaptureView(sample.state) }
      catch (failure) { setError(String(failure)); void finishRoute("route-error"); return }
      samplesRef.current.push({ tMs: clamped, position: sample.state.position, quaternion: sample.state.quaternion, ...sample.state.fovDeg !== undefined ? { fovDeg: sample.state.fovDeg } : {} })
      setCurrentPose(poseOfState(sample.state))
      setCurrentSegment({index:sample.stopIndex,phase:sample.phase})
      setElapsedMs(Math.round(clamped))
      if (elapsed >= planned.plan.totalMs) { void finishRoute("completed"); return }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [api, viewer, tr, finishRoute])

  const stop = useCallback(() => {
    const op = opRef.current
    // 取消中/同一操作已有停止任务：重复 Stop 不得再保存一次，也不得打断 Cancelling。
    if (!op || op.cancelled || phaseRef.current === "cancelling") return
    if (op.kind === "route-preview" || op.kind === "route-record") void finishRoute("user-stop")
    else void finishRecording("user-stop", true)
  }, [finishRoute, finishRecording])

  const cancel = useCallback((): Promise<void> => {
    const running = cancelRef.current
    if (running) return running
    const op = opRef.current
    if (!op) return Promise.resolve()
    op.cancelled = true
    tokenRef.current += 1; clearTimers()
    const task = (async () => {
      // 先同步进入 Cancelling：期间 Start 由 opRef/phase 双重挡住，不会出现"旧编码器未关就重录"。
      setPhaseNow("cancelling"); setSaving(false)
      let acknowledged = true, cancelError = ""
      try {
        const recorder = recorderRef.current
        if (recorder) {
          recorderRef.current = undefined
          const outcome = await recorder.cancel()
          acknowledged = outcome.acknowledged
          cancelError = outcome.error ?? ""
        } else {
          // Stop 已触发但 onstop 未到：等同一个原生停止确认；保存中的旧回执则不再等待。
          const ack = stopAckRef.current
          if (ack?.op === op) { try { await ack.promise } catch { /* stop 自己的失败已由 finish 处理 */ } }
        }
      } catch (failure) {
        acknowledged = false; cancelError = String(failure)
      } finally {
        if (opRef.current === op) {
          opRef.current = undefined
          setSaving(false)
          setPhaseNow("idle"); setElapsedMs(0); setTotalMs(undefined); setCurrentSegment(undefined)
          restoreView(op, true)
        }
      }
      if (!acknowledged && ownsContext(op)) {
        const detail = cancelError || "MEDIA_RECORDER_CANCEL_TIMEOUT"
        const message = tr(`取消未确认：${detail}。已释放本地画布/轨道并回到空闲，但未收到原生编码器关闭确认；重新录制后请检查产物。`, `Cancel was not acknowledged: ${detail}. Local canvas/tracks were released and the session returned to idle, but the native encoder did not confirm closure; record again and verify the output.`)
        setError(message); onError(message)
      }
    })()
    cancelRef.current = task
    void task.then(() => { if (cancelRef.current === task) cancelRef.current = undefined })
    return task
  }, [onError, restoreView, tr])

  const clear = useCallback(() => { setError(""); setNotice("") }, [])

  // 切 Scene / 换 API（会话身份变化）：按操作归属收尾——结果仍上传原 owner，
  // 但迟到回调不覆盖新 Scene/会话；仍在原场景时恢复镜头，换了场景则不覆盖新场景的镜头。
  useEffect(() => {
    const op = opRef.current
    if (!op || op.cancelled || op.context === contextRef.current) return
    if (op.kind === "route-record" || op.kind === "free") void finishRecording("scene-changed", false)
    else { clearRouteCaptureView(op); tokenRef.current += 1; clearTimers(); opRef.current = undefined; setPhaseNow("idle"); setElapsedMs(0); setTotalMs(undefined); setCurrentSegment(undefined) }
  }, [context, finishRecording])

  // Viewer 关闭或更换：终结实际 Recorder 与流/计时器，已有字节按真实 stopReason 保存（不保持 Recording）。
  useEffect(() => {
    if (viewerVisible) return
    const op = opRef.current
    if (!op || op.cancelled) return
    if (op.kind === "route-record" || op.kind === "free") void finishRecording("renderer-closed", false)
    else { clearRouteCaptureView(op); tokenRef.current += 1; clearTimers(); opRef.current = undefined; setPhaseNow("idle"); setElapsedMs(0); setTotalMs(undefined); setCurrentSegment(undefined) }
  }, [viewerVisible, finishRecording])

  // Viewer getter 换了实例（renderer 重建/失败）但没有翻转 viewerVisible：同样终结本次录制/预览。
  useEffect(() => {
    const op = opRef.current
    if (!op || op.cancelled) return
    if (viewer() === op.viewer) return
    if (op.kind === "route-preview") { clearRouteCaptureView(op); tokenRef.current += 1; clearTimers(); opRef.current = undefined; setPhaseNow("idle"); setElapsedMs(0); setTotalMs(undefined); setCurrentSegment(undefined); return }
    if (!recorderRef.current) return
    if (op.kind === "route-record" || op.kind === "free") void finishRecording("renderer-replaced", false)
    else { clearRouteCaptureView(op); tokenRef.current += 1; clearTimers(); opRef.current = undefined; setPhaseNow("idle"); setElapsedMs(0); setTotalMs(undefined); setCurrentSegment(undefined) }
  })

  // 窗口/工作台卸载：释放流/事件/计时器。卸载时无法等待上传，已有字节不能在此声称"已正常保存"。
  useEffect(() => () => {
    tokenRef.current += 1
    if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current)
    if (timerRef.current !== undefined) clearInterval(timerRef.current)
    const op = opRef.current
    if (op) { op.cancelled = true; clearRouteCaptureView(op) }
    void recorderRef.current?.cancel()
    recorderRef.current = undefined
    opRef.current = undefined
    phaseRef.current = "idle"
  }, [])

  return { phase, elapsedMs, totalMs, currentSegment, currentPose, saving, error, notice, orphan, startFree, stop, cancel, startRoute, clear }
}
