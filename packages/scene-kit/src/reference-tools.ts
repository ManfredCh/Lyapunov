/**
 * Web 参考原图取得（ENV-37/39 的第一片）：把「已从来源页发现的 https 原图直链」变成
 *   1) 模型上下文里的**真实图像附件**（DSH 原生 attachments，不另建图片库、不复制缩略图当证据）；
 *   2) dataRoot 下载域里按 sha256 命名的**原图字节**与一份来源记录（图片 URL 与来源页分开字段，不含凭据）。
 *
 * 搜索与网页读取仍用原生 web_search／web_fetch：本文件只补"原图取得"这一段。
 * 传输层**不复制下载器**：SSRF 预检（DNS+连接期双重复核）、禁重定向、声明的字节上限、
 * 停顿/总时长预算与取消语义全部复用 network-assets 的 fetchPublicHttpsBytes，
 * 与原图一起落地的只有这一条请求生命周期。
 *
 * 工具失败一律抛错并带上"可采取的动作"（改 https、取最终直链、换来源、调 maxBytes 等），
 * 不用空结果或占位图冒充成功；取消沿用调用方的 AbortSignal，不新开 Job。
 */
import type { Context } from "@deepseek-ai/cordis"
import { defineTool, type ParameterSchemaSpec } from "@deepseek-ai/dsh-tools"
import type { ImageMediaType } from "@deepseek-ai/dsh-attachment"
import type {} from "@deepseek-ai/dsh-attachment"
import type { ContentBlock } from "@deepseek-ai/dsh-llm"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { assertPublicHttpsURL, defaultHostResolver, fetchPublicHttpsBytes, type HostResolver, type NetworkAssetTimeouts, type NetworkAssetTransport } from "./network-assets.ts"

/** 单张参考图的默认体积上限（字节）。多数原图在几 MiB 内；超限时工具给出可采取的原因。 */
export const REFERENCE_IMAGE_DEFAULT_MAX_BYTES = 12 * 1024 * 1024
/** 硬上限兜底：调用方再调高也不会超过它，也不会超过当前 Host 附件服务的图片上限。 */
export const REFERENCE_IMAGE_HARD_MAX_BYTES = 20 * 1024 * 1024
/** 只声明取回图片：多数站点按它返回原图直链的原始字节。 */
const REFERENCE_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/*;q=0.9"
/** 单张原图落地与来源记录在下载域里的子目录（与 network-assets 共用同一个 cache/download 根）。 */
const REFERENCE_IMAGE_DIRECTORY = "reference"
/** 附件服务 V1 支持的栅格格式；SVG/TIFF/AVIF 不在其中，遇到时明确拒绝而不是伪造图片。 */
const ACCEPTED_IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = ["image/png", "image/jpeg", "image/webp", "image/gif"]

export interface ReferenceImageHostLimits {
  /** 调用方请求或被夹紧后的生效字节上限。 */
  effectiveMaxBytes: number
  /** 调用方请求值（未给时为默认值）。 */
  requestedMaxBytes: number
  hardMaxBytes: number
  /** 当前 Host 附件服务的单图字节上限（未挂载附件服务时为空）。 */
  attachmentImageMaxBytes?: number
  /** 生效值是否被硬上限或附件上限夹紧。 */
  clamped: boolean
}

/** 响应头与实际字节都指向的图片类型；解析不出来就抛错（错误里带可采取动作）。 */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  const head = (start: number, end: number): string => Buffer.from(bytes.subarray(start, end)).toString("latin1")
  if (bytes.length >= 8 && bytes[0] === 0x89 && head(1, 4) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 6 && (head(0, 6) === "GIF87a" || head(0, 6) === "GIF89a")) return "image/gif"
  if (bytes.length >= 12 && head(0, 4) === "RIFF" && head(8, 12) === "WEBP") return "image/webp"
  return undefined
}

/** Content-Type 头归一：媒体类型小写去参数，image/jpg 折成 image/jpeg。 */
export function headerMediaType(contentType: string): string {
  const value = contentType.split(";", 1)[0]!.trim().toLowerCase()
  return value === "image/jpg" ? "image/jpeg" : value
}

/**
 * 判定这张原图到底是什么格式，并守住"不让缩略图/错误页冒充原图"的第一道门：
 *  · 头声明受支持图片类型时，实际字节必须是同一类型（否则是错配，明确拒绝）；
 *  · 头声明的是网页（text/html 等）时直接说明"这是网页不是图片直链"，并给出下一步动作；
 *  · 头缺失或写成 application/octet-stream 时按真实字节判定（很多图床如此）。
 */
export function resolveReferenceImageMediaType(contentType: string, bytes: Uint8Array): ImageMediaType {
  const declared = headerMediaType(contentType)
  const sniffed = sniffImageMediaType(bytes)
  if (ACCEPTED_IMAGE_MEDIA_TYPES.includes(declared as ImageMediaType)) {
    const mediaType = declared as ImageMediaType
    if (!sniffed) throw new Error(`REFERENCE_IMAGE_BYTES_NOT_IMAGE: 服务器声明 ${mediaType}，但取回的字节不是该格式（常见于错误页、登录页或被中间层改写）。可采取的动作：回到来源页核对这条直链是否仍指向原图文件；如果页面本身需要登录，请换一个公开来源。`)
    if (sniffed !== mediaType) throw new Error(`REFERENCE_IMAGE_CONTENT_TYPE_MISMATCH: 服务器声明 ${mediaType}，实际字节是 ${sniffed}。可采取的动作：以实际字节为准改传正确的原图直链；本工具不按声明谎报格式。`)
    return mediaType
  }
  if (sniffed) return sniffed
  if (declared === "" || declared === "application/octet-stream" || declared === "binary/octet-stream") {
    throw new Error("REFERENCE_IMAGE_FORMAT_UNRECOGNIZED: 取回的字节不是 png/jpeg/webp/gif 中任何可识别格式（且服务器没有给出可用的 Content-Type）。可采取的动作：这个 URL 很可能不是原图直链，请回到来源页取 <img>/og:image 指向的图片文件 URL；若是 AVIF/TIFF/SVG 等格式，先换一个 png/jpeg/webp/gif 版本。")
  }
  if (declared === "image/avif" || declared === "image/tiff" || declared === "image/svg+xml" || declared.startsWith("image/")) {
    throw new Error(`REFERENCE_IMAGE_FORMAT_UNSUPPORTED: 该 URL 返回 ${declared}，附件服务只接受 png/jpeg/webp/gif。可采取的动作：在来源页找同图的 png/jpeg/webp 版本（很多站点同时提供），或换一个来源。`)
  }
  throw new Error(`REFERENCE_IMAGE_NOT_AN_IMAGE_LINK: 该 URL 返回的是 ${declared}，不是图片文件直链。可采取的动作：先用 web_fetch 读来源页，从 <img> 的 src、og:image 或"查看原图"链接里取真正的图片 URL，再调用本工具。`)
}

export interface ReferenceImageSignal { code: string; detail: string }

/**
 * "像不像按尺寸派生的缩略图/预览图"的信号（**信号不是结论**）：
 * 只看 URL 形态与实测像素，不改写、不拦截。判断原图仍应看真实字节（sha256/字节数/实测尺寸）与来源页说明。
 */
export function thumbnailSignals(url: URL, dimensions: { width: number; height: number } | undefined): ReferenceImageSignal[] {
  const signals: ReferenceImageSignal[] = []
  const leaf = url.pathname.split("/").at(-1) ?? ""
  const filenameSize = /(?:^|[-_@.])(\d{2,5})x(\d{2,5})(?=[.@_-]|$)/i.exec(leaf)
  if (filenameSize) {
    const width = Number(filenameSize[1])
    const height = Number(filenameSize[2])
    const matches = dimensions !== undefined && (dimensions.width === width || dimensions.height === height)
    signals.push({
      code: "filename-size-token",
      detail: `URL 文件名带尺寸标记 ${width}x${height}${matches ? "，且与实际像素一致" : ""}：这类 URL 常由站点按尺寸派生，可能是缩略图；请回来源页确认是否有原始尺寸的直链。`,
    })
  }
  if (/(^|[/_.-])(thumbs?|thumbnails?|preview|small|mini|icons?|sprite|avatar|scaled)([/_.-]|$)/i.test(url.pathname)) {
    signals.push({ code: "thumbnail-path-token", detail: "URL 路径含 thumb/preview/small/icon 等缩略图目录名：请回来源页确认同一图片是否另有原图直链。" })
  }
  const resizeKeys = [...url.searchParams.keys()].filter(key => /^(w|h|width|height|resize|fit|max|maxwidth|maxheight|quality|q|size|scale|dpr|compress|stretch)$/i.test(key))
  if (resizeKeys.length) {
    signals.push({ code: "resize-query-param", detail: `URL 带尺寸/压缩参数（${resizeKeys.join(",")}）：服务器可能按参数返回缩放版本；请去掉这些参数或改用原图直链再核对一次。` })
  }
  if (dimensions && Math.max(dimensions.width, dimensions.height) <= 400) {
    signals.push({ code: "measured-small", detail: `实测最长边只有 ${Math.max(dimensions.width, dimensions.height)} px：接近常见缩略图尺寸，作为"原图证据"偏弱；请换更大尺寸的直链。` })
  }
  return signals
}

/** 来源页只做语法核对（它是记录字段，不会被本工具抓取），因此不在此解析 DNS，避免给纯元数据加网络失败点。 */
export function assertReferenceSourcePage(value: string): URL {
  if (!URL.canParse(value)) throw new Error("REFERENCE_IMAGE_SOURCE_PAGE_INVALID: sourcePage 必须是绝对 URL（含 https:// 和主机名）。可采取的动作：把发现这张图的页面地址原样传入；没有来源页时省略该字段。")
  const url = new URL(value)
  if (url.protocol !== "https:") throw new Error("REFERENCE_IMAGE_SOURCE_PAGE_INVALID: sourcePage 只接受 https 来源页。可采取的动作：换成该页面的 https 地址。")
  if (url.username || url.password) throw new Error("REFERENCE_IMAGE_SOURCE_PAGE_INVALID: sourcePage 不应包含用户名/密码。可采取的动作：去掉 URL 里的凭据，只留公开地址。")
  return url
}

/** 取回的字节 → 附件服务接受的媒体类型；失败原因必须能直接指导下一步。 */
function referenceImageFailure(error: unknown, context: { url: string; limits: ReferenceImageHostLimits }): Error {
  const message = error instanceof Error ? error.message : String(error)
  // 本文件自己的校验错误已经带动作说明，原样抛出。
  if (message.startsWith("REFERENCE_IMAGE_")) return error instanceof Error ? error : new Error(message)
  const limitHint = `本次生效上限 ${context.limits.effectiveMaxBytes} 字节（请求 ${context.limits.requestedMaxBytes}，硬上限 ${context.limits.hardMaxBytes}${context.limits.attachmentImageMaxBytes === undefined ? "" : `，附件服务上限 ${context.limits.attachmentImageMaxBytes}`}）`
  const actions: Array<{ match: (text: string) => boolean; reason: string }> = [
    { match: text => text.startsWith("NETWORK_URL_MUST_USE_HTTPS"), reason: "本工具只取 https 直链。可采取的动作：把 http:// 地址换成同一图片的 https 地址（多数站点 https 可用）。" },
    { match: text => text.startsWith("NETWORK_URL_MUST_BE_ABSOLUTE"), reason: "URL 不是绝对地址。可采取的动作：传入带 https:// 与主机名的完整 URL，不要传相对路径。" },
    { match: text => text.startsWith("NETWORK_URL_MUST_NOT_INCLUDE_CREDENTIALS"), reason: "URL 里带了用户名/密码。可采取的动作：本工具不携带任何凭据，请改用匿名可访问的直链。" },
    { match: text => text.startsWith("NETWORK_URL_PRIVATE_HOST") || text.startsWith("NETWORK_URL_PRIVATE_ADDRESS") || text.startsWith("NETWORK_URL_RESOLVES_TO_PRIVATE_ADDRESS"), reason: "目标解析到本机/内网/.local 地址，按安全策略拒绝。可采取的动作：改从公网来源取图；本地文件请用 scene_import 而不是本工具。" },
    { match: text => text.startsWith("NETWORK_ASSET_REDIRECT_REJECTED"), reason: "该直链发生重定向，本工具不跟随重定向（避免把证据指向未核对的目标）。可采取的动作：取出 Location 指向的最终图片直链，作为 url 再调用一次。" },
    { match: text => text.startsWith("NETWORK_ASSET_HTTP_403"), reason: "服务器拒绝访问（403）。常见原因是防盗链（需要 Referer）、地区限制或需要登录。可采取的动作：回来源页确认原图仍可直接打开，或换一个公开来源；本工具不会伪造 Referer/凭据。" },
    { match: text => text.startsWith("NETWORK_ASSET_HTTP_404") || text.startsWith("NETWORK_ASSET_HTTP_410"), reason: "该直链已失效。可采取的动作：回来源页重新取原图直链；不要用缩略图或转载页截图顶替原图。" },
    { match: text => /^NETWORK_ASSET_HTTP_\d{3}$/.test(text), reason: "服务器返回错误状态。可采取的动作：确认直链是否仍然有效；若是站点限流可稍后重试，或换一个来源。" },
    { match: text => text.startsWith("NETWORK_ASSET_SIZE_LIMIT"), reason: `超过体积上限（${limitHint}）。可采取的动作：确认这条直链是不是超大原图后，用 maxBytes 提高上限（不超过硬上限），或改用同图较小但仍是原件尺寸的版本。` },
    { match: text => text.startsWith("NETWORK_ASSET_EMPTY_BODY"), reason: "服务器返回 0 字节。可采取的动作：确认直链有效（浏览器能否打开），或换一个来源。" },
    { match: text => text.startsWith("NETWORK_ASSET_TIMEOUT"), reason: "传输停顿超时（一段时间内没有任何字节到达）。可采取的动作：重试一次；仍失败就换一个来源或更小的原图。" },
    { match: text => text.startsWith("NETWORK_ASSET_TOTAL_TIMEOUT"), reason: "传输总时长超时。可采取的动作：换更小的原图直链，或稍后重试。" },
  ]
  const action = actions.find(candidate => candidate.match(message))?.reason
    ?? "可采取的动作：确认这条 URL 在浏览器里能直接打开原图；回到来源页重新取直链；若是临时网络故障可重试一次。"
  return new Error(`REFERENCE_IMAGE_FETCH_FAILED(${message}): ${action}`)
}

/**
 * 取回被调用方取消时返回的占位值。**不是成功结果**：ok=false、没有图片附件、没有 sha256/附件字段，
 * 因此模型不会把取消当成"图取到了"。
 *
 * 走注册表执行时模型看不到这份值：ToolRuntime 在工具体返回后复查 signal，已 abort 就统一改写成
 * `tool aborted`（isError + info { name: 'AbortError', code: 'ABORTED' }）。这正是本工具要的取消语义，
 * 于是不需要（也做不到）在 scene-kit 侧伪造那个机器码——Lyapunov 侧 import 的 HarnessError 与
 * dsh-tools 内部 bundle 里的 HarnessError 是**两个类**（同一进程内实测 instanceof 为 false），
 * 抛 HarnessError 拿不到 error.info，反而会把取消混进普通失败里。
 */
function cancelledReferenceImage(url: string, cause: unknown): Record<string, unknown> {
  return {
    tool: "reference_image_fetch",
    ok: false,
    cancelled: true,
    image: { url },
    note: "调用方已取消（abort）：本次不返回图片附件、不写来源记录；取消前若原图已按 sha256 落盘，该文件按内容寻址保留、不回滚。",
    ...(cause instanceof Error ? { reason: cause.message } : {}),
  }
}

export interface ReferenceImageLanding {
  saved: boolean
  path?: string
  recordPath?: string
  reusedExistingOriginal?: boolean
  reason?: string
}

const MEDIA_TYPE_EXTENSION: Record<ImageMediaType, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" }

/** 显示的默认名字只取 URL 末段文件名（去掉控制/非法字符与查询串）；不解析路径、不写入任何凭据。 */
function defaultImageName(url: URL, mediaType: ImageMediaType): string {
  let leaf = url.pathname.split("/").at(-1) ?? ""
  try { leaf = decodeURIComponent(leaf) } catch { /* 非法百分号编码：按原样用文件名 */ }
  const safe = leaf.replace(/[^\p{L}\p{N}._@+-]+/gu, "-").replace(/^[.-]+|[.-]+$/g, "")
  const extension = MEDIA_TYPE_EXTENSION[mediaType]
  const name = safe === "" ? `reference-image${extension}` : safe.includes(".") ? safe : safe + extension
  return name.slice(0, 120)
}

/**
 * 原图字节按 sha256 落到下载域（内容寻址，同图重复取回即复用同一文件），并在旁边写一份来源记录。
 * 只写这两个文件，不进资源库索引、不建第二资料库；任何一步失败都如实返回 reason，不影响已成功的附件。
 */
async function landReferenceImage(input: {
  downloadRoot: string
  bytes: Buffer
  mediaType: ImageMediaType
  sha256: string
  record: Record<string, unknown>
  recordId: string
  signal?: AbortSignal
}): Promise<ReferenceImageLanding> {
  const directory = join(input.downloadRoot, REFERENCE_IMAGE_DIRECTORY)
  const path = join(directory, input.sha256 + MEDIA_TYPE_EXTENSION[input.mediaType])
  try {
    input.signal?.throwIfAborted()
    await mkdir(directory, { recursive: true, mode: 0o700 })
    let reusedExistingOriginal = false
    try {
      await writeFile(path, input.bytes, { mode: 0o600, flag: "wx" })
    } catch (error) {
      // 同名文件只可能来自同一 sha256 的原图字节（内容寻址）：视为已存在同一原件，不覆盖、不重写。
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      reusedExistingOriginal = true
    }
    const records = join(directory, "records")
    await mkdir(records, { recursive: true, mode: 0o700 })
    const recordPath = join(records, `${input.sha256.slice(0, 16)}-${input.recordId}.json`)
    await writeFile(recordPath, `${JSON.stringify(input.record, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    return { saved: true, path, recordPath, reusedExistingOriginal }
  } catch (error) {
    if (input.signal?.aborted) throw error
    return { saved: false, reason: `原图字节未能落盘（${error instanceof Error ? error.message : String(error)}）：附件仍已在本次工具结果中；如需磁盘证据，请检查 dataRoot 写权限后重试。` }
  }
}

export interface ReferenceImageDependencies {
  resolve?: HostResolver
  transport?: NetworkAssetTransport
  timeouts?: NetworkAssetTimeouts
  /** 仅测试：固定时间戳与记录文件名。 */
  now?: () => Date
  newId?: () => string
}

export interface ReferenceImageFetchInput {
  url: string
  sourcePage?: string
  object?: string
  viewpoint?: string
  name?: string
  maxBytes?: number
  saveOriginal?: boolean
}

export interface ReferenceImageToolOptions {
  /**
   * 原图与来源记录的落点：复用**本次调用会话**的下载域（与 scene_import_url／环境资产同一处）。
   * 按调用现取而不在注册期固定：落盘目录属于发起这次请求的会话，不是某个共享下载目录。
   */
  downloadRootFor(owner: unknown): string
  /** 仅测试注入：本机夹具传输/解析器与缩短的等待预算。 */
  dependencies?: ReferenceImageDependencies
}

/** 参数里显式给出的可选文本；空白串按未给出处理，避免"空备注"被当成字段已核对。 */
function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/**
 * 原图取得主流程。失败一律抛错（附可采取动作）；取消沿用调用方 signal，不抛错也不返回图片
 * （见 cancelledReferenceImage：注册表会把这次调用收尾成 code=ABORTED 的取消结果）：
 * 提交附件之前取消则不落盘、不提交附件；提交之后没有回滚点（内容寻址的不可变对象，与原生附件语义一致）。
 */
export async function fetchReferenceImage(ctx: Context, options: ReferenceImageToolOptions, input: ReferenceImageFetchInput, signal?: AbortSignal, owner?: unknown): Promise<unknown> {
  const dependencies = options.dependencies ?? {}
  const now = dependencies.now ?? (() => new Date())
  const newId = dependencies.newId ?? randomUUID
  const startedAt = now()
  if (typeof input?.url !== "string" || !input.url.trim()) throw new Error("REFERENCE_IMAGE_URL_REQUIRED: 缺少 url。可采取的动作：传入从来源页发现的 https 原图直链。")
  const attachments = ctx.get("attachments")
  if (!attachments) {
    throw new Error("REFERENCE_IMAGE_ATTACHMENTS_UNAVAILABLE: 当前 Host 未挂载附件服务，图片无法进入工具结果。可采取的动作：在带附件服务的宿主（桌面/Web Profile）里调用；只想要页面文字时用 web_fetch。")
  }
  const requestedMaxBytes = input.maxBytes ?? REFERENCE_IMAGE_DEFAULT_MAX_BYTES
  if (typeof requestedMaxBytes !== "number" || !Number.isSafeInteger(requestedMaxBytes) || requestedMaxBytes <= 0) {
    throw new Error("REFERENCE_IMAGE_MAX_BYTES_INVALID: maxBytes 必须是正整数（字节）。可采取的动作：省略该字段用默认上限，或给一个合理的正整数。")
  }
  const attachmentImageMaxBytes = attachments.imageLimits.maxImageBytes
  const effectiveMaxBytes = Math.min(requestedMaxBytes, REFERENCE_IMAGE_HARD_MAX_BYTES, attachmentImageMaxBytes)
  const limits: ReferenceImageHostLimits = { effectiveMaxBytes, requestedMaxBytes, hardMaxBytes: REFERENCE_IMAGE_HARD_MAX_BYTES, attachmentImageMaxBytes, clamped: effectiveMaxBytes !== requestedMaxBytes }
  const sourcePage = input.sourcePage === undefined ? undefined : assertReferenceSourcePage(input.sourcePage)
  const object = optionalText(input.object)
  const viewpoint = optionalText(input.viewpoint)
  const saveOriginal = input.saveOriginal !== false
  const resolve = dependencies.resolve ?? defaultHostResolver
  try {
    signal?.throwIfAborted()
    const url = await assertPublicHttpsURL(input.url.trim(), resolve, signal)
    signal?.throwIfAborted()
    const { bytes, contentType } = await fetchPublicHttpsBytes(url, resolve, effectiveMaxBytes, dependencies.transport, signal, REFERENCE_IMAGE_ACCEPT, dependencies.timeouts)
    // 提交点之前的取消闸：取消后不写盘、不提交附件。
    signal?.throwIfAborted()
    const mediaType = resolveReferenceImageMediaType(contentType, bytes)
    if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
      throw new Error(`REFERENCE_IMAGE_FORMAT_UNSUPPORTED: 当前 Host 附件服务不接受 ${mediaType}（接受：${attachments.imageLimits.mediaTypes.join("/")}）。可采取的动作：换 png/jpeg/webp/gif 版本的原图。`)
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 120) : defaultImageName(url, mediaType)
    const landing = saveOriginal
      ? await landReferenceImage({
        downloadRoot: options.downloadRootFor(owner),
        bytes,
        mediaType,
        sha256,
        recordId: newId(),
        signal,
        record: {
          kind: "reference-image-original",
          tool: "reference_image_fetch",
          fetchedAt: now().toISOString(),
          // 图片 URL 与来源页分开记录；不含任何凭据、请求头或 cookie（URL 预检已拒绝带凭据的地址）。
          imageUrl: url.href,
          imageHost: url.host,
          sourcePage: sourcePage?.href ?? null,
          object: object ?? null,
          viewpoint: viewpoint ?? null,
          contentTypeHeader: contentType,
          mediaType,
          byteLength: bytes.length,
          sha256,
          credentialsUsed: false,
          redirectsFollowed: 0,
        },
      })
      : { saved: false as const, reason: "saveOriginal=false：本次只返回附件与元数据，不落盘原图与来源记录。" }
    signal?.throwIfAborted()
    const attachment = await attachments.saveImage({ data: bytes, mediaType, name }).catch(error => {
      throw new Error(`REFERENCE_IMAGE_ATTACHMENT_REJECTED: 附件服务拒绝了这张图片（${error instanceof Error ? error.message : String(error)}）。可采取的动作：换一张体积更小或格式为 png/jpeg/webp/gif 的原图；若图片损坏，请回来源页确认原图本身可打开。`)
    })
    const normalized = attachment.originalDimensions !== undefined
    // 实测像素优先取附件服务解码出的入库前输入尺寸；附件里实际存的尺寸另列，避免把规范化缩小后的版本当原图证据。
    const width = attachment.originalDimensions?.width ?? attachment.width
    const height = attachment.originalDimensions?.height ?? attachment.height
    const signals = thumbnailSignals(url, { width, height })
    return {
      tool: "reference_image_fetch",
      ok: true,
      image: {
        url: url.href,
        host: url.host,
        mediaType,
        contentTypeHeader: contentType,
        byteLength: bytes.length,
        sha256,
        width,
        height,
      },
      source: {
        page: sourcePage?.href ?? null,
        sameOriginAsSourcePage: sourcePage ? sourcePage.origin === url.origin : null,
        note: sourcePage
          ? "来源页只作记录与核对，本工具不会抓取该页面；对象/年代/机位是否一致由模型核对。"
          : "未记录来源页：这张原图无法回溯到发现它的页面。可采取的动作:下次把来源页 URL 一并传入 sourcePage。",
      },
      annotations: { object: object ?? null, viewpoint: viewpoint ?? null },
      original: landing,
      attachment: {
        attachmentId: attachment.attachmentId,
        mediaType: attachment.mediaType,
        bytes: attachment.bytes,
        width: attachment.width,
        height: attachment.height,
        name: attachment.name ?? name,
        normalized,
        ...(normalized ? { normalizedFrom: attachment.originalDimensions } : {}),
      },
      thumbnailSignals: signals,
      signalsNote: "thumbnailSignals 是与『缩略图/预览图』形态一致的信号，不是结论；本工具不把任何图片宣告为原图，字节 sha256、实测像素与来源页说明才是证据。",
      limits,
      fetchedAt: startedAt.toISOString(),
      elapsedMs: Math.max(0, now().getTime() - startedAt.getTime()),
      credentialsUsed: false,
      redirectsFollowed: 0,
      // 私有字段：render 时摘出并变成真实图像内容块，不进入模型可见 JSON。
      __referenceImageAttachment: attachment,
    }
  } catch (error) {
    // 取消不是"取图失败"：不抛错，交回注册表按原生 tool 取消语义收尾（code=ABORTED，见 cancelledReferenceImage）。
    if (signal?.aborted === true || (error instanceof Error && error.name === "AbortError")) return cancelledReferenceImage(input.url, error)
    throw referenceImageFailure(error, { url: input.url, limits })
  }
}

/** 模型可见内容：先文本元数据，再（成功时）真实图片附件。 */
function renderReferenceImageResult(value: unknown): ContentBlock[] {
  const { __referenceImageAttachment: attachment, ...visible } = (value ?? {}) as Record<string, unknown>
  const blocks: ContentBlock[] = [{ type: "text", text: JSON.stringify(visible) }]
  if (attachment) blocks.push({ type: "image", attachment: attachment as never })
  return blocks
}

export const referenceImageFetchParameters: ParameterSchemaSpec = {
  input: {
    type: "object", required: true, additionalProperties: false,
    description: "Fetch an HTTPS original-image direct URL already discovered on a source page. Return a real image attachment viewable by the model and field-level provenance. Original-image acquisition only: no search, redirects or credentials.",
    examples: [{
      url: "https://www.python.org/static/img/python-logo.png",
      sourcePage: "https://www.python.org/",
      object: "Small official Python logo image",
      viewpoint: "Front view",
    }],
    properties: {
      url: { type: "string", required: true, description: "Original-image HTTPS direct URL from the source page's <img> src, og:image or view-original link. Supply the image-file URL, not a webpage URL or a thumbnail substituted for the original." },
      sourcePage: { type: "string", description: "Source-page HTTPS URL where the image was discovered, for recording/checking only; this tool does not fetch the page. If omitted, source.page=null and the image cannot be traced to its source page." },
      object: { type: "string", description: "Object note for the image content, such as a church's front facade, for comparison with the target object." },
      viewpoint: { type: "string", description: "Camera/viewpoint note, such as front facade, northeast corner or detail." },
      name: { type: "string", description: "Attachment display name; defaults to the final URL filename." },
      maxBytes: { type: "integer", description: "Byte limit for this request; default applies when omitted. The effective value is also capped by the hard maximum and the Host attachment service's image limit; see returned limits." },
      saveOriginal: { type: "boolean", description: "Whether to save original image bytes by sha256 in the dataRoot download domain and write provenance; default true. false returns only attachment/metadata." },
    },
  },
}

/**
 * 真实注册 `reference_image_fetch`：模型侧只看到 url/sourcePage/object/viewpoint/name/maxBytes/saveOriginal，
 * 图形内容通过原生 attachments + 图像内容块进入工具结果。
 * 不声明后台 Job：单张小图取回是短任务，取消沿用调用方 exec.signal（fetchPublicHttpsBytes 的停顿/总预算继续生效）。
 */
export function registerReferenceImageTools(ctx: Context, options: ReferenceImageToolOptions): void {
  ctx.tools.register(defineTool({
    name: "reference_image_fetch",
    description: "Fetch an already-discovered HTTPS original-image direct URL as a real image attachment viewable by the model. Return byte sha256, measured pixels, separate image/source-page URLs and thumbnail-like signals. Use after web_search/web_fetch discovers a source page. No search, redirects, credentials or thumbnails substituted for original-image evidence.",
    parameters: referenceImageFetchParameters,
    output: { schema: { type: "json" }, render: (_args, value) => renderReferenceImageResult(value) },
    // 只向唯一 uuid 的内容寻址路径与不可变附件对象写入，不改父级状态，可与其他工具调用并行。
    isConcurrencySafe: () => true,
    // args/exec 放宽类型（与 robot-tools 同一理由）：工具结果里的私有附件字段不是 JsonValue，收口在这一处。
    execute: async (args: any, exec: any) => (await fetchReferenceImage(ctx, options, args.input, exec.signal, exec?.agent)) as any,
  }))
}

/* ────────────────────────── ENV-06：照片视角覆盖表（N311） ────────────────────────── */

/**
 * 一张照片对某个对象的**视角记录**。机位只收**可推导**的量：要么调用方直接给方位角/仰角，
 * 要么给 `worldFromCamera.positionM`（相对被拍对象原点，米），由 {@link viewpointOfCamera} 如实换算。
 * 没有机位也没有视角名 ⇒ 这条记录**不可用**（记进 `unusable`，不冒充"覆盖了"）。
 */
export interface PhotoViewpoint {
  object: string
  viewpoint?: string
  photoId?: string
  capturedAt?: string
  azimuthDeg?: number
  elevationDeg?: number
  worldFromCamera?: { positionM?: number[] }
  /** 交付图像的像素尺寸（真实读数）；与 `frameSize` 相等时可**如实推导**"整帧未裁切"。 */
  imageSize?: { width: number; height: number }
  /** 采集帧的像素尺寸（真实读数）。 */
  frameSize?: { width: number; height: number }
  /** 裁切标注（调用方给出时逐项校验；缺失则按整帧记录，不编造矩形）。 */
  crop?: { kind: "full" | "cropBox" | "userRect"; rect?: number[] }
  /** 遮挡标注（`occluded:true` 必须给 reason）；与 `depthJump` 二选一或都给（标注优先）。 */
  occlusion?: { occluded: boolean; reason?: string }
  /** 深度跳变统计（真实读数）：`maxAbsJumpM > thresholdM` ⇒ **如实推导**为被遮挡。 */
  depthJump?: { maxAbsJumpM: number; thresholdM: number }
}

/** 一张照片的**可核对事实**（遮挡/裁切），随覆盖表一起回执；推导不出来就写 `derived:false`，不编造数值。 */
export interface PhotoFacts {
  photoId?: string
  object: string
  viewpoint: string
  /** 记录里**原样回显**的时间（调用方提供什么就是什么；**本工具不做 EXIF 推断**）。未提供时本键不存在。 */
  capturedAt?: string
  /** 时间字段的来源说明：提供时写"原样回显"，未提供时写清"未提供、不做 EXIF 推断"。 */
  capturedAtNote: string
  occlusion: { occluded: boolean; derived: boolean; reason: string }
  crop: { kind: "full" | "cropBox" | "userRect"; rect?: [number, number, number, number]; derived: boolean; note: string }
}

/** 时间事实：记录给了非空字符串就**原样回显**；没给就明确写"未提供"，**绝不用采集时刻/EXIF 推断冒充拍摄时间**。 */
export function photoCapturedAtFactsOf(entry: PhotoViewpoint): { capturedAt?: string; capturedAtNote: string } {
  const value = typeof entry.capturedAt === "string" ? entry.capturedAt.trim() : ""
  if (!value) return { capturedAtNote: "未提供：记录里没有 capturedAt，本工具不做 EXIF 推断、也不用采集时刻冒充拍摄时间" }
  return { capturedAt: value, capturedAtNote: "原样回显调用方提供的记录时间（本工具不校验其来源，也不做 EXIF 推断）" }
}

const cropRectOf = (rect: unknown, label: string): [number, number, number, number] => {
  if (!Array.isArray(rect) || rect.length !== 4 || rect.some(v => typeof v !== "number" || !Number.isFinite(v))) {
    throw new Error(`PHOTO_CROP_RECT_INVALID: ${label} 的裁切矩形必须是四个有限数 [x,y,width,height]`)
  }
  const [x, y, width, height] = rect as [number, number, number, number]
  if (width <= 0 || height <= 0 || x < 0 || y < 0) throw new Error(`PHOTO_CROP_RECT_INVALID: ${label} 的裁切矩形宽高必须为正、原点不得为负（收到 ${JSON.stringify(rect)}）`)
  return [x, y, width, height]
}

/** 裁切事实：有标注就逐项校验；没有标注但有真实尺寸时按"整帧"如实推导；否则按整帧记录并注明无可核对矩形。 */
export function photoCropFactsOf(entry: PhotoViewpoint): PhotoFacts["crop"] {
  const label = entry.photoId ?? entry.viewpoint ?? entry.object
  if (entry.crop) {
    if (!["full", "cropBox", "userRect"].includes(entry.crop.kind)) throw new Error(`PHOTO_CROP_KIND_INVALID: ${label} 的裁切 kind 只能是 full|cropBox|userRect（收到 ${JSON.stringify(entry.crop.kind)}）`)
    const rect = entry.crop.rect === undefined ? undefined : cropRectOf(entry.crop.rect, label)
    if (rect && entry.imageSize) {
      const { width, height } = entry.imageSize
      if (rect[0] + rect[2] > width || rect[1] + rect[3] > height) throw new Error(`PHOTO_CROP_RECT_INVALID: ${label} 的裁切矩形越界（rect=${JSON.stringify(rect)} 超出图像 ${width}×${height}）`)
    }
    // 措辞必须与**实际做过什么**一致：没给 rect 就没有矩形可校验；给了 rect 但没给 imageSize 也判不了越界。
    const note = !rect
      ? "调用方给了裁切 kind 但**没给 rect**：无矩形可校验，不编造矩形"
      : entry.imageSize
        ? "调用方给出的裁切标注（矩形与图像尺寸都已核对：越界即报错）"
        : "调用方给出的裁切标注（给了矩形但**没给 imageSize**，未做越界校验）"
    return { kind: entry.crop.kind, ...(rect ? { rect } : {}), derived: false, note }
  }
  if (entry.imageSize && entry.frameSize) {
    const same = entry.imageSize.width === entry.frameSize.width && entry.imageSize.height === entry.frameSize.height
    return same
      ? { kind: "full", rect: [0, 0, entry.imageSize.width, entry.imageSize.height], derived: true, note: `imageSize(${String(entry.imageSize.width)}×${String(entry.imageSize.height)}) == frameSize ⇒ 整帧未裁切` }
      : { kind: "full", derived: false, note: `imageSize(${String(entry.imageSize.width)}×${String(entry.imageSize.height)}) != frameSize(${String(entry.frameSize.width)}×${String(entry.frameSize.height)})：**有裁切但缺偏移**，本工具不编造矩形` }
  }
  return { kind: "full", derived: false, note: "无裁切元数据（也未给 imageSize/frameSize 可核对）：按整帧记录，不声称已裁切" }
}

/** 遮挡事实：标注优先（`occluded:true` 必须给 reason）；其次由**真实深度跳变**推导；两者都没有 ⇒ 不声称被遮挡。 */
export function photoOcclusionFactsOf(entry: PhotoViewpoint): PhotoFacts["occlusion"] {
  const label = entry.photoId ?? entry.viewpoint ?? entry.object
  if (entry.occlusion) {
    if (typeof entry.occlusion.occluded !== "boolean") throw new Error(`PHOTO_OCCLUSION_REQUIRED: ${label} 的遮挡标注必须给布尔 occluded`)
    const reason = typeof entry.occlusion.reason === "string" ? entry.occlusion.reason.trim() : ""
    if (entry.occlusion.occluded && !reason) throw new Error(`PHOTO_OCCLUSION_REASON_REQUIRED: ${label} 标了 occluded:true 就必须给 reason（为什么被挡）`)
    return { occluded: entry.occlusion.occluded, derived: false, reason: reason || "标注为未被遮挡（调用方给出）" }
  }
  if (entry.depthJump) {
    const { maxAbsJumpM, thresholdM } = entry.depthJump
    if (!Number.isFinite(maxAbsJumpM) || !Number.isFinite(thresholdM) || thresholdM < 0) throw new Error(`PHOTO_DEPTH_JUMP_INVALID: ${label} 的 depthJump 必须是有限数且 thresholdM ≥ 0（收到 ${JSON.stringify(entry.depthJump)}）`)
    return { occluded: maxAbsJumpM > thresholdM, derived: true, reason: `深度跳变推导：max|Δd|=${String(maxAbsJumpM)} m ${maxAbsJumpM > thresholdM ? ">" : "≤"} 阈值 ${String(thresholdM)} m（真实读数）` }
  }
  return { occluded: false, derived: false, reason: "未给遮挡证据（无标注、无深度跳变统计）：不声称被遮挡" }
}

/** 一个对象的覆盖表：已覆盖方位（去重后）、请求里的缺口、以及真实推导出的方位/仰角集合。 */
export interface ViewpointCoverage {
  object: string
  covered: string[]
  missing: string[]
  azimuthsDeg: number[]
  elevationsDeg: number[]
  unusable: number
}

/** 方位角分桶（度）。**同一桶内的多张照片只算一个方位**——数量多不等于覆盖全。 */
export const VIEWPOINT_AZIMUTH_BUCKET_DEG = 45

/** 由相机相对位置推导方位/仰角（度）。方位以 +Z 为 0°、绕 Y 轴右手为正；仰角以水平面为 0°。 */
export function viewpointOfCamera(positionM: readonly number[]): { azimuthDeg: number; elevationDeg: number } {
  const [x, y, z] = [Number(positionM[0] ?? 0), Number(positionM[1] ?? 0), Number(positionM[2] ?? 0)]
  const horizontal = Math.hypot(x, z)
  const azimuthDeg = horizontal === 0 ? 0 : (Math.atan2(x, z) * 180) / Math.PI
  const elevationDeg = Math.atan2(y, Math.max(horizontal, 1e-9)) * (180 / Math.PI)
  return { azimuthDeg: Math.round(azimuthDeg * 10) / 10, elevationDeg: Math.round(elevationDeg * 10) / 10 }
}

/** 仰角合法区间（度）：超出即 `PHOTO_VIEWPOINT_OUT_OF_RANGE`。方位角不限（按模 360 归一）。 */
export const VIEWPOINT_ELEVATION_RANGE_DEG: readonly [number, number] = [-90, 90]

/** 方位角桶：任意有限值都接受，**按模 360 归一**（`-30°` 与 `330°` 是同一个方位，`360°` ≡ `0°`）。 */
function azimuthBucketDeg(value: number): number {
  const bucket = Math.round(value / VIEWPOINT_AZIMUTH_BUCKET_DEG) * VIEWPOINT_AZIMUTH_BUCKET_DEG
  return ((bucket % 360) + 360) % 360
}

/** 仰角桶（30° 一格；调用前已做区间校验，故不做模运算）。 */
function elevationBucketDeg(value: number): number {
  return Math.round(value / 30) * 30
}

function assertElevationRange(value: number, label: string, where: string): void {
  if (value < VIEWPOINT_ELEVATION_RANGE_DEG[0] || value > VIEWPOINT_ELEVATION_RANGE_DEG[1]) {
    throw new Error(`PHOTO_VIEWPOINT_OUT_OF_RANGE: ${label} 的${where}必须在 [-90,90]° 内（收到 ${String(value)}）；方位角不限，按模 360 归一`)
  }
}

/** 形如 `az<数>/el<数>` 的视角名 ⇒ **规范桶键**；不是这个形状就 `undefined`（`front`/`东北角` 这类名字不编码角度）。 */
function namedBucketKeyOf(named: string, label: string): string | undefined {
  const match = /^az(-?\d+(?:\.\d+)?)\/el(-?\d+(?:\.\d+)?)$/i.exec(named)
  if (!match) return undefined
  const az = Number(match[1]), el = Number(match[2])
  if (!Number.isFinite(az) || !Number.isFinite(el)) return undefined
  assertElevationRange(el, label, `视角名 ${named} 里的仰角`)
  return `az${String(azimuthBucketDeg(az))}/el${String(elevationBucketDeg(el))}`
}

/** 数值推导出的视角桶键（`az<桶>/el<桶>`，方位按模 360 归一）；没有方位角时 `undefined`。 */
function numericViewpointKey(derived: { azimuthDeg?: number; elevationDeg?: number }, label: string): string | undefined {
  if (derived.elevationDeg !== undefined && Number.isFinite(derived.elevationDeg)) assertElevationRange(derived.elevationDeg, label, 'elevationDeg')
  if (derived.azimuthDeg === undefined) return undefined
  return `az${String(azimuthBucketDeg(derived.azimuthDeg))}/el${String(elevationBucketDeg(derived.elevationDeg ?? 0))}`
}

/**
 * 视角键：命名视角优先；**命名与显式方位/仰角互相矛盾时明确报错**，但两侧都先**规范化到同一个桶口径**再比——
 * `az0/el0` 与 `azimuthDeg:360` 是同一个方位（模 360），`az-30/el0` 与 `azimuthDeg:330` 同理，不得误判成矛盾。
 * 仰角超出 `[-90,90]°` 是**越界**（`PHOTO_VIEWPOINT_OUT_OF_RANGE`），与"写错/冲突"（`PHOTO_VIEWPOINT_CONFLICT`）分开报，不共用一个码。
 */
const viewpointKeyOf = (entry: PhotoViewpoint, derived: { azimuthDeg?: number; elevationDeg?: number }): string | undefined => {
  const named = typeof entry.viewpoint === "string" && entry.viewpoint.trim() ? entry.viewpoint.trim() : undefined
  const label = entry.photoId ?? named ?? entry.object
  const numeric = numericViewpointKey(derived, label)
  if (named) {
    const namedKey = namedBucketKeyOf(named, label)
    if (namedKey && numeric && namedKey !== numeric) {
      throw new Error(`PHOTO_VIEWPOINT_CONFLICT: ${label} 的视角名 ${named} 与显式方位/仰角不一致（视角名规范化为 ${namedKey}，数值推导为 ${numeric}；0°≡360°、-30°≡330° 视为同一角度）——同一记录不得自相矛盾（只给其一，或把两者改成一致）`)
    }
    return named
  }
  return numeric
}

/** 一条记录能推导出的方位/仰角：显式给的优先，其次由机位如实换算。覆盖表与逐照片事实**必须**共用这一份推导。 */
function viewpointDerivedOf(entry: PhotoViewpoint): { azimuthDeg?: number; elevationDeg?: number } {
  const derived: { azimuthDeg?: number; elevationDeg?: number } = {}
  if (entry.azimuthDeg !== undefined && Number.isFinite(entry.azimuthDeg)) derived.azimuthDeg = entry.azimuthDeg
  else if (entry.worldFromCamera?.positionM?.length === 3) { const v = viewpointOfCamera(entry.worldFromCamera.positionM); derived.azimuthDeg = v.azimuthDeg; derived.elevationDeg = v.elevationDeg }
  if (entry.elevationDeg !== undefined && Number.isFinite(entry.elevationDeg)) derived.elevationDeg = entry.elevationDeg
  return derived
}

/**
 * 请求视角的**可读标签**：字符串直接用；对象则取 `objectId`/`object`/`entity` 与 `viewpoint`/`name`/`label` 拼成
 * `"{objectId}@{viewpoint}"`（都没有就退化成单个字段）；两者都不是 ⇒ 明确报错。
 * 目的：`missing` 里**只放字符串**——曾经直接 `String(v)` 把对象变成 `"[object Object]"`，回执/页面完全不可读。
 */
function requestedViewpointLabelOf(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>
    const pick = (keys: string[]): string | undefined => {
      for (const key of keys) { const item = row[key]; if (typeof item === "string" && item.trim()) return item.trim() }
      return undefined
    }
    const object = pick(["objectId", "object", "entity"])
    const viewpoint = pick(["viewpoint", "name", "label"])
    if (object && viewpoint) return `${object}@${viewpoint}`
    if (viewpoint) return viewpoint
    if (object) return object
  }
  throw new Error(`PHOTO_VIEWPOINT_REQUEST_INVALID: 请求的视角要么是字符串，要么是带 viewpoint/name（可带 objectId/object）的对象（收到 ${JSON.stringify(value)}）`)
}

/**
 * 覆盖表：按 `object` 聚合，(a) 已覆盖视角＝记录里去重后的键（同名视角或同一方位桶只算一次），
 * (b) `missing`＝`requestedViewpoints` 里没被覆盖的，(c) 方位/仰角集合只放**真实推导出来的**数。
 * **没有照片**或**全部记录都没有可用机位/视角名**时返回 `insufficient`（点名原因），
 * 由调用方按失败处理——不返回空表冒充"没有缺口"。
 */
export function viewpointCoverageOf(
  entries: ReadonlyArray<PhotoViewpoint>,
  requestedViewpoints: ReadonlyArray<unknown> = [],
): { objects: ViewpointCoverage[]; photos: PhotoFacts[]; unattributed: number; insufficient?: string } {
  if (!entries.length) return { objects: [], photos: [], unattributed: 0, insufficient: "NO_PHOTOS: 没有任何照片/视角记录，给不出覆盖表（不返回空表冒充『没有缺口』）" }
  const byObject = new Map<string, { covered: Set<string>; azimuths: Set<number>; elevations: Set<number>; unusable: number }>()
  let usable = 0
  for (const entry of entries) {
    const object = typeof entry.object === "string" && entry.object.trim() ? entry.object.trim() : ""
    const derived = viewpointDerivedOf(entry)
    const key = viewpointKeyOf(entry, derived)
    const bucket = byObject.get(object) ?? { covered: new Set<string>(), azimuths: new Set<number>(), elevations: new Set<number>(), unusable: 0 }
    if (!object || key === undefined) { bucket.unusable += 1; byObject.set(object, bucket); continue }
    usable += 1
    bucket.covered.add(key.toLowerCase())
    if (derived.azimuthDeg !== undefined) bucket.azimuths.add(derived.azimuthDeg)
    if (derived.elevationDeg !== undefined) bucket.elevations.add(derived.elevationDeg)
    byObject.set(object, bucket)
  }
  // 没有 `object` 的记录落在 `object=""` 这个桶里；`objects` 会把它整桶丢掉（空的 object 不是可报的对象），
  // 但**计数不能跟着消失**——单独以 `unattributed` 如实报出，否则回执看起来"只少了一条"。
  const unattributed = byObject.get("")?.unusable ?? 0
  // 逐照片事实：**先逐条校验**（非法遮挡/裁切标注必须报错），再按视角键过滤。
  // 这里曾另算一次 key（漏掉 `azimuthDeg`/`elevationDeg`）⇒ 只有方位角的记录 key===undefined 被整条 filter 掉、
  // 三个事实函数根本没执行（校验被静默绕过）。现在与上面的聚合循环共用 {@link viewpointDerivedOf}。
  const photos: PhotoFacts[] = []
  for (const entry of entries) {
    const facts = { ...photoCapturedAtFactsOf(entry), occlusion: photoOcclusionFactsOf(entry), crop: photoCropFactsOf(entry) }
    const key = viewpointKeyOf(entry, viewpointDerivedOf(entry))
    const object = typeof entry.object === "string" ? entry.object.trim() : ""
    if (!object || key === undefined) continue // 不可用记录已计入 objects[].unusable；事实**已校验过**，不静默跳过
    photos.push({ ...(entry.photoId ? { photoId: entry.photoId } : {}), object, viewpoint: key, ...facts })
  }
  if (usable === 0) return { objects: [], photos, unattributed, insufficient: "NO_BASELINE: 有照片记录，但没有任何一条给出可用机位（worldFromCamera.positionM）或视角名，覆盖表无从推导——不编造方位" }
  const requested = requestedViewpoints.map(requestedViewpointLabelOf).filter(Boolean)
  const objects: ViewpointCoverage[] = [...byObject.entries()]
    .filter(([object]) => object !== "")
    .map(([object, bucket]) => ({
      object,
      covered: [...bucket.covered],
      missing: requested.filter(view => !bucket.covered.has(view.toLowerCase())),
      azimuthsDeg: [...bucket.azimuths].sort((a, b) => a - b),
      elevationsDeg: [...bucket.elevations].sort((a, b) => a - b),
      unusable: bucket.unusable,
    }))
  return { objects, photos, unattributed }
}
