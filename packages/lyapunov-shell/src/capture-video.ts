/**
 * 自由视角连续视频（R-005）：**只**录制 Viewer 真实渲染画布，不请求麦克风或桌面录屏。
 *
 * 铁律：输出容器/编码一律按 `MediaRecorder` 的**实际**报告落盘——WebM 不会被改后缀成 MP4，
 * 不知道容器就如实说 `unknown`。`MediaRecorder` 不存在、画布没有 `captureStream`、录制失败都
 * 抛具名错误，由界面如实显示；**存在源码或构造成功都不等于视频可播放**，只有真实字节与解码才算。
 *
 * 本模块不依赖 React/浏览器全局：`openTarget` 与 `MediaRecorderCtor` 都注入，便于用假记录器单测，
 * 也便于在浏览器里用真的 `canvas.captureStream()` + `MediaRecorder` 跑同一份实现。
 */

export type VideoContainer = "webm" | "mp4" | "unknown"

export interface VideoCodecFace {
  mimeType: string
  container: VideoContainer
  codec: string
}

export interface VideoMimeCandidate {
  mimeType: string
  container: VideoContainer
  codec: string
}

/**
 * 优先 VP9、其次 VP8。**故意不列 MP4 候选**：即使平台默认给出 MP4，也由 `recorder.mimeType`
 * 读回真实容器，而不是我们预设。
 */
export const VIDEO_MIME_CANDIDATES: readonly VideoMimeCandidate[] = [
  { mimeType: "video/webm;codecs=vp9", container: "webm", codec: "vp9" },
  { mimeType: "video/webm;codecs=vp8", container: "webm", codec: "vp8" },
  { mimeType: "video/webm", container: "webm", codec: "webm" },
]

/** 从实际 mimeType 解析容器与编码；空串得到 `unknown`，不猜。 */
export function videoCodecFace(mimeType: string): VideoCodecFace {
  const text = (mimeType || "").trim()
  const lower = text.toLowerCase()
  const container: VideoContainer = lower.includes("webm") ? "webm" : lower.includes("mp4") ? "mp4" : "unknown"
  const match = /codecs?\s*=\s*"?([^;"]+)/.exec(lower)
  return { mimeType: text, container, codec: match?.[1]?.trim() || container }
}

/** 文件名后缀只由真实容器决定；`unknown` 给 `.bin` 并保留 mediaType，绝不把未知当 WebM。 */
export const videoFileExtension = (container: VideoContainer): string => container === "webm" ? "webm" : container === "mp4" ? "mp4" : "bin"

export function pickSupportedVideoMimeType(isSupported: (mime: string) => boolean): VideoMimeCandidate | undefined {
  for (const candidate of VIDEO_MIME_CANDIDATES) { try { if (isSupported(candidate.mimeType)) return candidate } catch { /* 平台抛错 = 不支持 */ } }
  return undefined
}

/** `MediaRecorder` 的结构面（真实实例与测试替身同形）。 */
export interface MediaRecorderLike {
  state: "inactive" | "recording" | "paused"
  mimeType: string
  start(timeslice?: number): void
  stop(): void
  ondataavailable: ((event: { data: Blob }) => void) | null
  onerror: ((event: { error?: unknown }) => void) | null
  onstop: (() => void) | null
}
export interface MediaRecorderCtor {
  new (stream: MediaStream, options?: { mimeType?: string }): MediaRecorderLike
  isTypeSupported?: (mime: string) => boolean
}

/** 浏览器真实 `MediaRecorder`；不存在时 undefined。收窄到结构面，避免 DOM 事件类型把调用方钉死。 */
export function browserMediaRecorderCtor(): MediaRecorderCtor | undefined {
  const ctor = (globalThis as { MediaRecorder?: unknown }).MediaRecorder
  return typeof ctor === "function" ? ctor as unknown as MediaRecorderCtor : undefined
}

/** 一次视频源：真实画布流 + 该画布的像素尺寸 + 可选手动取帧清理（静态场景稳定出帧）。 */
export interface VideoCaptureTarget { stream: MediaStream; width: number; height: number; stop?: () => void }

export interface VideoCaptureStart {
  mimeType: string
  container: VideoContainer
  codec: string
  width: number
  height: number
  startedAt: string
}

export interface VideoCaptureResult extends VideoCaptureStart {
  blob: Blob
  bytes: number
  stoppedAt: string
  durationMs: number
  stopReason: string
  /** 录制过程中记录器报的错（若有）；有错时字节可能不完整，界面必须如实显示。 */
  error?: string
}

export interface VideoRecorderDeps {
  /** 单调时钟（毫秒）；时长用它算，不用视频时间戳（没有可靠时间戳时是唯一诚实来源）。 */
  now: () => number
  /** 打开真实画布视频流；没有渲染器/不支持 captureStream 时返回 undefined。 */
  openTarget: (frameRate: number) => VideoCaptureTarget | undefined
  MediaRecorderCtor?: MediaRecorderCtor
  frameRate?: number
  timesliceMs?: number
  stopTimeoutMs?: number
  /** 取消时等待原生 `onstop` 的上限；超时后释放轨道但如实报告未确认。 */
  cancelTimeoutMs?: number
}

/** 取消结果：`acknowledged=false` 表示原生编码器在超时内没有确认关闭，不能假装已安全重录。 */
export interface VideoCancelOutcome {
  acknowledged: boolean
  error?: string
}

/**
 * 一段连续视频的录制会话。**唯一**驱动真实 `MediaRecorder` 的地方：
 * 自由视角与 A→B→C 路线录制走同一份，不各写一套。
 */
export class ContinuousVideoRecorder {
  private recorder?: MediaRecorderLike
  private target?: VideoCaptureTarget
  private chosen?: VideoMimeCandidate
  private chunks: Blob[] = []
  private startedAtMs = 0
  private startedAt = ""
  private stopRequestedAtMs?: number
  private stopReason?: string
  private errorText?: string
  private result?: VideoCaptureResult
  private pending?: Promise<VideoCaptureResult>
  private cancelPending?: Promise<VideoCancelOutcome>
  /** 每次 start 递增；旧 recorder 的迟到事件据此丢弃，不能写进下一段录制。 */
  private generation = 0
  /** cancel 后到 onstop 之前的旧数据一律丢弃。 */
  private discarding = false

  constructor(private readonly deps: VideoRecorderDeps) {}

  get recording(): boolean { return this.recorder !== undefined && this.recorder.state !== "inactive" }
  get startInfo(): VideoCaptureStart | undefined {
    const target = this.target
    if (!this.recorder || !target) return undefined
    const face = videoCodecFace((this.recorder.mimeType || this.chosen?.mimeType || "").trim())
    return { mimeType: face.mimeType, container: face.container, codec: face.codec, width: target.width, height: target.height, startedAt: this.startedAt }
  }

  start(): VideoCaptureStart {
    // 旧编码器还在 close：必须等 cancel 的 onstop/超时结论，不能抢先建第二段录制。
    if (this.cancelPending) throw new Error("VIDEO_CANCEL_PENDING: 上一次取消尚未确认编码器关闭，不能开始新录制")
    if (this.recorder || this.pending) throw new Error("VIDEO_ALREADY_RECORDING")
    const Ctor = this.deps.MediaRecorderCtor
    if (typeof Ctor !== "function") throw new Error("MEDIA_RECORDER_UNAVAILABLE: 当前环境没有 MediaRecorder，不能录制连续视频")
    const target = this.deps.openTarget(this.deps.frameRate ?? 30)
    if (!target) throw new Error("VIDEO_CANVAS_UNAVAILABLE: 没有可录制的真实渲染画布（Viewer 未渲染或该环境不支持 canvas.captureStream）")
    const isSupported = (mime: string): boolean => typeof Ctor.isTypeSupported === "function" ? Ctor.isTypeSupported.call(Ctor, mime) : true
    const chosen = pickSupportedVideoMimeType(isSupported)
    const generation = ++this.generation
    let recorder: MediaRecorderLike
    try { recorder = new Ctor(target.stream, chosen ? { mimeType: chosen.mimeType } : undefined) }
    catch (failure) { releaseTarget(target); throw new Error(`MEDIA_RECORDER_UNAVAILABLE: MediaRecorder 无法开始（${failure instanceof Error ? failure.message : String(failure)}）`) }
    this.recorder = recorder; this.target = target; this.chosen = chosen
    this.chunks = []; this.errorText = undefined; this.result = undefined; this.pending = undefined
    this.stopRequestedAtMs = undefined; this.discarding = false
    this.startedAtMs = this.deps.now(); this.startedAt = new Date(this.startedAtMs).toISOString()
    recorder.ondataavailable = event => {
      if (this.generation === generation && this.recorder === recorder && !this.discarding && event?.data && event.data.size > 0) this.chunks.push(event.data)
    }
    recorder.onerror = (event: { error?: unknown }) => {
      if (this.generation === generation && this.recorder === recorder && !this.discarding) this.errorText = `MEDIA_RECORDER_ERROR: ${errorTextOf(event?.error)}`
    }
    recorder.onstop = () => { /* 由 stop()/cancel() 覆盖；未调用时记录器自行结束也不丢已收字节 */ }
    try { recorder.start(this.deps.timesliceMs ?? 250) }
    catch (failure) {
      // `recorder.start` 抛错时同样要释放 target/轨道并清引用，否则下一次 Start 会复用半开状态。
      recorder.ondataavailable = null; recorder.onerror = null; recorder.onstop = null
      try { if (recorder.state !== "inactive") recorder.stop() } catch { /* 已停止 */ }
      this.recorder = undefined; this.target = undefined; this.chosen = undefined
      this.chunks = []; this.errorText = undefined; this.pending = undefined
      this.startedAtMs = 0; this.startedAt = ""
      releaseTarget(target)
      throw new Error(`MEDIA_RECORDER_UNAVAILABLE: MediaRecorder 无法开始（${failure instanceof Error ? failure.message : String(failure)}）`)
    }
    const info = this.startInfo!
    return info
  }

  /**
   * 停止并产出结果。`reason` 如实记进记录（用户 Stop / 预览取消 / 渲染器关闭 / 切场景）。
   * 即使记录器报错，也先把它**已经产生的字节**交出来（`error` 字段标出不完整），不假装成功。
   * 0 字节一律标 `VIDEO_BYTES_EMPTY`，调用方不得把它当可恢复的成品。
   */
  stop(reason: string): Promise<VideoCaptureResult> {
    if (this.result) return Promise.resolve(this.result)
    if (this.cancelPending) return Promise.reject(new Error("VIDEO_CANCEL_PENDING: 取消尚未确认，不能同时停止"))
    if (!this.recorder) return Promise.reject(new Error("VIDEO_NOT_RECORDING"))
    if (this.pending) return this.pending
    const recorder = this.recorder, generation = this.generation
    this.stopReason = reason
    // P23：停止时钟在**调用 stop 的当刻**记下，编码 flush / onstop 延迟不计入媒体 duration，
    // 避免把"收尾耗时"当成"多录了几百毫秒"。
    this.stopRequestedAtMs = this.deps.now()
    this.pending = new Promise<VideoCaptureResult>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = () => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        const result = this.finalizeResult()
        if (result) resolve(result); else reject(new Error("VIDEO_NO_RESULT"))
      }
      recorder.onstop = () => {
        if (this.generation !== generation || this.recorder !== recorder) return
        finish()
      }
      recorder.onerror = (event: { error?: unknown }) => {
        if (this.generation !== generation || this.recorder !== recorder) return
        this.errorText = `MEDIA_RECORDER_ERROR: ${errorTextOf(event?.error)}`; finish()
      }
      timer = setTimeout(() => {
        // 编码器在超时内没有发 onstop：字节可能不完整，必须如实标错，不能静默当完整成功。
        if (!this.errorText) this.errorText = `MEDIA_RECORDER_STOP_TIMEOUT: 停止后 ${this.deps.stopTimeoutMs ?? 5000} ms 内没有收到 onstop，录制的字节可能不完整`
        finish()
      }, this.deps.stopTimeoutMs ?? 5000)
      try { if (recorder.state !== "inactive") recorder.stop(); else finish() }
      catch (failure) { this.errorText = `MEDIA_RECORDER_ERROR: ${failure instanceof Error ? failure.message : String(failure)}`; finish() }
    })
    return this.pending
  }

  /**
   * 放弃本次录制：停止记录器、丢弃字节、释放轨道（不产出记录）。
   *
   * P31/V9 真机缺陷修复：原实现 `recorder.stop()` 后立刻丢引用并释放流，原生编码器尚未 onstop，
   * 紧接着的同 Viewer 重录会拿到 0 B。现在**等到原生 onstop**（有界超时）才清空/释放；期间
   * `start()` 明确拒绝，旧 `ondataavailable` 也不会写入任何后续结果。
   */
  cancel(): Promise<VideoCancelOutcome> {
    if (this.cancelPending) return this.cancelPending
    this.discarding = true
    const recorder = this.recorder
    const generation = this.generation
    const existing = this.pending
    const task = (async (): Promise<VideoCancelOutcome> => {
      // 已经调用过 stop()：等它的 onstop/超时结果即可，字节全部丢弃。
      if (existing) {
        let error: string | undefined
        try { const stopped = await existing; if (stopped.error) error = stopped.error }
        catch (failure) { error = `MEDIA_RECORDER_CANCEL_FAILED: ${failure instanceof Error ? failure.message : String(failure)}` }
        this.finishCancel()
        return error ? { acknowledged: false, error } : { acknowledged: true }
      }
      if (!recorder) { this.finishCancel(); return { acknowledged: true } }
      const outcome = await new Promise<VideoCancelOutcome>(resolve => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = (acknowledged: boolean, error?: string) => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          recorder.ondataavailable = null; recorder.onerror = null; recorder.onstop = null
          const text = error ?? (acknowledged ? undefined : `MEDIA_RECORDER_CANCEL_TIMEOUT: 取消后 ${this.deps.cancelTimeoutMs ?? this.deps.stopTimeoutMs ?? 5000} ms 内没有收到 onstop，已释放本地轨道但不能确认编码器已关闭`)
          this.errorText = text
          this.finishCancel()
          resolve(text ? { acknowledged: false, error: text } : { acknowledged: true })
        }
        recorder.ondataavailable = () => { /* 取消：旧数据一律丢弃，不能落进下一段录制 */ }
        recorder.onerror = (event: { error?: unknown }) => { finish(false, `MEDIA_RECORDER_ERROR: ${errorTextOf(event?.error)}`) }
        recorder.onstop = () => {
          if (this.generation !== generation || this.recorder !== recorder) return
          finish(true)
        }
        timer = setTimeout(() => finish(false), this.deps.cancelTimeoutMs ?? this.deps.stopTimeoutMs ?? 5000)
        try {
          if (recorder.state !== "inactive") recorder.stop()
          else finish(true)
        } catch (failure) {
          // stop() 抛错时若记录器已 inactive，仍算已关闭；否则如实标未确认。
          const inactive = recorder.state === "inactive"
          finish(inactive, inactive ? undefined : `MEDIA_RECORDER_ERROR: ${failure instanceof Error ? failure.message : String(failure)}`)
        }
      })
      return outcome
    })()
    const tracked = task.finally(() => { this.cancelPending = undefined })
    this.cancelPending = tracked
    return tracked
  }

  /** 取消收尾：丢弃结果并释放所有引用/轨道；此时旧 recorder 已 onstop 或已超时。 */
  private finishCancel(): void {
    this.chunks = []; this.result = undefined; this.pending = undefined
    this.recorder = undefined; this.chosen = undefined
    this.startedAtMs = 0; this.startedAt = ""
    this.stopRequestedAtMs = undefined; this.stopReason = undefined; this.errorText = undefined
    this.discarding = false
    this.release()
  }

  private finalizeResult(): VideoCaptureResult | undefined {
    if (this.result) return this.result
    const recorder = this.recorder, target = this.target
    if (!recorder || !target) return undefined
    const face = videoCodecFace((recorder.mimeType || this.chosen?.mimeType || "").trim())
    // duration 用 stop 调用当刻（没有则退回收尾当刻），不与 flush/onstop 延迟混在一起。
    const stoppedAtMs = this.stopRequestedAtMs ?? this.deps.now()
    const blob = new Blob(this.chunks, { type: face.mimeType || "video/webm" })
    // 0 B 不是"可恢复的字节"：明确标失败，调用方不得保存/给恢复下载入口。
    const error = blob.size <= 0
      ? [this.errorText, "VIDEO_BYTES_EMPTY: 没有收到任何视频字节（空录制不落盘）"].filter(Boolean).join("; ")
      : this.errorText
    this.result = {
      blob, bytes: blob.size, ...face, width: target.width, height: target.height,
      startedAt: this.startedAt, stoppedAt: new Date(stoppedAtMs).toISOString(),
      durationMs: Math.max(0, stoppedAtMs - this.startedAtMs), stopReason: this.stopReason ?? "stopped",
      ...error ? { error } : {},
    }
    this.recorder = undefined
    this.pending = undefined
    this.release()
    return this.result
  }

  private release(): void { const target = this.target; this.target = undefined; releaseTarget(target) }
}

/** 停掉画布手动取帧清理与流轨道；清理函数自己抛错也不能妨碍轨道释放。 */
function releaseTarget(target: VideoCaptureTarget | undefined): void {
  if (!target) return
  try { target.stop?.() } catch { /* 清理失败仍继续停轨道 */ }
  releaseStream(target.stream)
}

function releaseStream(stream: MediaStream) { for (const track of stream.getTracks()) { try { track.stop() } catch { /* 已结束 */ } } }
function errorTextOf(error: unknown): string { return error instanceof Error ? error.message : typeof error === "string" && error ? error : "unknown error" }

/** 采集记录里保留的相机采样（自由视角至少起止两点，路线按实际经过点；位置米、四元数 xyzw、FOV 度）。 */
export interface CaptureVideoSample {
  tMs: number
  position: [number, number, number]
  quaternion: [number, number, number, number]
  fovDeg?: number
}

/** 视频记录来源：世界自由视角 / A→B→C 已存世界机位路线。与图像采集明确区分，不混进 PNG 列表。 */
export type CaptureVideoSource = "free-view" | "route"

export interface CaptureVideoRecord {
  videoId: string
  /** 具名区分：视频记录不是 PNG CaptureRecord，也不作为图像附件交给模型。 */
  kind: "continuous-video"
  sceneId: string
  sceneRevision: number
  worldId?: string
  worldGeneration?: number
  source: CaptureVideoSource
  mediaType: string
  container: VideoContainer
  codec: string
  width: number
  height: number
  bytes: number
  durationMs: number
  frameRate: number
  startedAt: string
  stoppedAt: string
  stopReason: string
  mediaPath: string
  createdAt: string
  cameraSamples?: CaptureVideoSample[]
  /** 路线录制时逐段/逐停留的可复算参数（自由视角不带）。 */
  route?: unknown
  error?: string
}

export interface CaptureVideoContext {
  sceneId: string
  sceneRevision: number
  worldId?: string
  worldGeneration?: number
  source: CaptureVideoSource
  frameRate: number
  cameraSamples?: CaptureVideoSample[]
  route?: unknown
}

/** 由真实录制结果与上下文整形落盘记录；`bytes` 取真实 Blob 字节，不臆造。 */
export function captureVideoRecordOf(videoId: string, mediaPath: string, result: VideoCaptureResult, context: CaptureVideoContext, createdAt: string): CaptureVideoRecord {
  return {
    videoId, kind: "continuous-video", sceneId: context.sceneId, sceneRevision: context.sceneRevision,
    ...context.worldId ? { worldId: context.worldId } : {}, ...context.worldGeneration !== undefined ? { worldGeneration: context.worldGeneration } : {},
    source: context.source, mediaType: result.mimeType || "application/octet-stream", container: result.container, codec: result.codec,
    width: result.width, height: result.height, bytes: result.bytes, durationMs: result.durationMs, frameRate: context.frameRate,
    startedAt: result.startedAt, stoppedAt: result.stoppedAt, stopReason: result.stopReason, mediaPath, createdAt,
    ...context.cameraSamples && context.cameraSamples.length ? { cameraSamples: context.cameraSamples } : {},
    ...context.route !== undefined ? { route: context.route } : {},
    ...result.error ? { error: result.error } : {},
  }
}

/**
 * 上传载荷封包：`[4 字节大端 meta 长度][UTF-8 meta JSON][原始视频字节]`。
 * 不把 MB 级字节塞进 JSON 或请求头；也不经过任何会重新编码视频的通道。
 */
export async function frameVideoPayload(metadata: unknown, blob: Blob): Promise<ArrayBuffer> {
  const meta = new TextEncoder().encode(JSON.stringify(metadata))
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const frame = new Uint8Array(4 + meta.length + bytes.length)
  new DataView(frame.buffer).setUint32(0, meta.length)
  frame.set(meta, 4)
  frame.set(bytes, 4 + meta.length)
  return frame.buffer
}

