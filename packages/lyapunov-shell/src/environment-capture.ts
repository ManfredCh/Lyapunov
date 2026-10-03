/**
 * 环境**光照**（Scene 的 `components.environment`）在采集/观察回执里的**窄面**：这张图用的光照，
 * 到底是不是场景文档请求的那一份。
 *
 * 为什么要有它：`startEnvironmentLoad` 失败后照样 resolve，前端与工作台会认为这一版"就绪"，
 * 而 `viewer_observe` 从前只看 `loadingErrors`/`visualWarnings`——于是"HDRI 没装上、IBL 退回内置环境光"
 * 的画面会被当成完整配置交出去（2026-09-20 审查）。有了这一面，采集记录与观察回执能如实说出
 * "请求的是 A、画面用的是 B 或内置光"，而不是静默冒充完整配置。
 *
 * 为什么在这里做整形：面由 Viewer 的 `capture().environment` 给出（**唯一 owner**，见
 * `packages/viewer/src/index.ts` 的 `EnvironmentCaptureFace`）；本模块只做最小整形
 * （认白名单字段、限长限量），不解释光照语义、不补默认值、不重算"是否已加载"。
 * 带批注采集/普通采集路径不受影响：没有这一面时它就不进记录（不写空壳）。
 */

/** 采集记录/观察回执里的环境窄面。字段与 Viewer 的 `EnvironmentCaptureFace` 一一对应。 */
export interface EnvironmentCaptureFace {
  /** 这一帧的 IBL 来自哪里：`hdri`＝手里有环境贴图；`builtin`＝内置环境光（含回退）。 */
  source: "hdri" | "builtin"
  /** 文档请求的 HDRI（`resourceId@version`）；场景没声明 HDRI 时缺省。 */
  requested?: string
  /** 真的装在画面上的那一份；与 `requested` 不同就是"还没换上"。 */
  applied?: string
  loaded: boolean
  loading: boolean
  error?: string
}

const text = (value: unknown, limit: number): string | undefined => typeof value === "string" && value ? value.slice(0, limit) : undefined

/**
 * 把前端送来的环境面整形进采集记录。形状不对就返回 undefined（**不猜、不造**）：
 * 编造一面比没有这一面更糟——"看起来核过了"会让模型把回退当成完整配置。
 */
export function environmentFaceFrom(input: unknown): EnvironmentCaptureFace | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const raw = input as Record<string, unknown>
  if (raw.source !== "hdri" && raw.source !== "builtin") return undefined
  if (typeof raw.loaded !== "boolean" || typeof raw.loading !== "boolean") return undefined
  const requested = text(raw.requested, 200), applied = text(raw.applied, 200), error = text(raw.error, 500)
  return {
    source: raw.source,
    ...(requested ? { requested } : {}),
    ...(applied ? { applied } : {}),
    loaded: raw.loaded,
    loading: raw.loading,
    ...(error ? { error } : {}),
  }
}

/**
 * 给模型看的一句话：这一帧**没有用上**文档请求的那份 HDRI 时说明现状与原因，其余情况返回 undefined。
 *
 * 只有"文档请求了 HDRI、但那份不在画面里"才算问题：场景压根没声明 HDRI 时内置环境光就是它的配置，
 * 不是回退，不该在回执里写成"不完整"。
 */
export function environmentFaceNote(face: EnvironmentCaptureFace | undefined): string | undefined {
  if (!face || face.loaded || !face.requested) return undefined
  const where = face.applied
    ? `画面现在用的是 ${face.applied}（不是请求的 ${face.requested}）`
    : "没有可用的 HDRI"
  const why = face.error ? `；原因：${face.error}` : face.loading ? "；请求的那份仍在加载中" : ""
  return `环境光照：这张图**没有用上**场景文档请求的 ${face.requested}——${where}，IBL 由${face.source === "hdri" ? "另一份 HDRI" : "内置环境光"}提供${why}。别把这张图当成完整的环境配置。`
}
