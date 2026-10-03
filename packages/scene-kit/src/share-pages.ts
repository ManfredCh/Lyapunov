/**
 * **可识别分享页 → 真实公开元数据**的解析（不猜地址、不抓 HTML 当模型、不假装已导入）。
 *
 * 目标：用户给一个明确的分享页网址时，直接用**页面自身公开的配置**找到真实资源入口，或如实说明
 * 为什么当前不能导入（多文件 LOD、需要登录、没有解码器），并给出可采取的动作；模型不必反复猜
 * PlayCanvas API、也不必把 LOD 清单改名成 PLY。
 *
 * 本轮适配 SuperSplat：
 *  · 分享页 `https://superspl.at/scene/<hash>` —— 读 `<link rel="license">`、og 标题/封面与页面自带的
 *    结构化元数据（format/size/lodCounts/作者），来源事实全部照抄，不推断许可；
 *  · 官方 viewer `https://superspl.at/s?id=<hash>` —— 读内嵌的 `sse-bootstrap` JSON，取权威 `contentUrl`；
 *  · `contentUrl`（如 `.../v1/lod-meta.json`）—— 公开 CDN 上的 LOD 清单，读出真实层级/计数。
 *  清单指向多个分块（SuperSplat 的 ssog 表示）时**不假装导入**：返回 `unsupported` 与事实/动作。
 *
 * 传输复用 network-assets 的同一条安全语义（https-only、无凭据、DNS 与连接期私网复核、禁重定向、
 * 字节上限、停顿/总时长预算、可取消、短暂故障有界重试），本模块只负责"读哪个公开地址、怎么读公开元数据"。
 */
import { gunzipSync } from "node:zlib"
import { planSsogLod } from "./ssog-manifest.ts"
import {
  assertPublicHttpsURL,
  defaultHostResolver,
  fetchPublicHttpsBytesWithRetry,
  type HostResolver,
  type NetworkAssetRetryPolicy,
  type NetworkAssetTimeouts,
  type NetworkAssetTransport,
} from "./network-assets.ts"

/** 分享页公开事实：全部来自页面/官方 viewer/公开清单，许可与作者照抄不推断。 */
export interface SharePageFacts {
  provider: string
  sourcePage: string
  viewerUrl?: string
  title?: string
  author?: string
  /** 直接从页面许可链接读出的名称（如 CC-BY-SA-4.0）；没有就不写。 */
  license?: string
  licenseUrl?: string
  /** 页面自报格式（SuperSplat 用 `ssog` 表示 LOD 流式表示）。 */
  format?: string
  byteLength?: number
  downloadCount?: number
  posterUrl?: string
  /** 官方 viewer 配置里的权威内容地址。 */
  contentUrl?: string
  collisionUrl?: string
  /** LOD 清单事实：层级数、每级计数、分块元数据文件数、清单自报总计数与空间范围。 */
  lodLevels?: number
  lodCounts?: number[]
  lodChunkFiles?: number
  manifestCount?: number
  bounds?: { min: number[]; max: number[] }
}

/**
 * 只读解析的三态，避免把"解析成功"误当成"已获取/已导入"：
 *  · `resolved: true`  —— 已按公开元数据完成解析；
 *  · `acquirable`      —— 是否给出了可直接获取的资源地址（direct=true；unsupported=false）；
 *  · `imported: false` —— 解析本身**从不**下载模型、不登记/导入资源（获取与导入在 scene_asset_acquire 里另行发生）。
 */
export type SharePageResolution =
  | { kind: "direct"; provider: string; directUrl: string; format?: string; facts: SharePageFacts; warnings: string[]; resolved: true; acquirable: true; imported: false }
  | { kind: "streamed-sog"; provider: string; manifestUrl: string; facts: SharePageFacts; warnings: string[]; resolved: true; acquirable: true; imported: false }
  | { kind: "unsupported"; provider: string; reason: string; facts: SharePageFacts; actions: string[]; warnings: string[]; resolved: true; acquirable: false; imported: false }

export interface SharePageDependencies {
  resolve?: HostResolver
  transport?: NetworkAssetTransport
  signal?: AbortSignal
  timeouts?: NetworkAssetTimeouts
  retry?: NetworkAssetRetryPolicy
  /** 分享页 HTML 上限（默认 4 MiB；真实页面几十 KB，给足余量但不无限）。 */
  maxPageBytes?: number
  /** 公开清单 JSON 上限（默认 8 MiB）。 */
  maxManifestBytes?: number
  /** 资产获取调用方用于同一请求聚合真实网络到达字节；独立 resolve 可省略。 */
  onBytes?: (count: number) => void
  onAttempt?: (attempt: number) => void
  budgetRemaining?: () => number
}

const DEFAULT_PAGE_MAX_BYTES = 4 * 1024 * 1024
const DEFAULT_MANIFEST_MAX_BYTES = 8 * 1024 * 1024
const HTML_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1"
const JSON_ACCEPT = "application/json,text/plain;q=0.9,*/*;q=0.1"

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
}

function attribute(html: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(html)
  return match?.[1] === undefined ? undefined : decodeHtml(match[1]).trim() || undefined
}

/** SuperSplat 分享页 → hash（`/scene/<hash>` 与 `/s?id=<hash>` 都认；其它主机返回 undefined）。 */
export function sharePageTargetOf(input: string): { provider: "supersplat"; hash: string } | undefined {
  if (!URL.canParse(input)) return undefined
  const url = new URL(input)
  if (url.protocol !== "https:") return undefined
  const host = url.hostname.toLowerCase()
  if (host !== "superspl.at" && host !== "www.superspl.at") return undefined
  const scene = /^\/scene\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)
  if (scene) return { provider: "supersplat", hash: scene[1]! }
  if (/^\/s\/?$/.test(url.pathname)) {
    const id = url.searchParams.get("id")
    if (id && /^[A-Za-z0-9_-]+$/.test(id)) return { provider: "supersplat", hash: id }
  }
  return undefined
}

async function fetchText(url: string, deps: Required<Pick<SharePageDependencies, "resolve">> & SharePageDependencies, maxBytes: number, acceptHeader: string): Promise<string> {
  const target = await assertPublicHttpsURL(url, deps.resolve, deps.signal)
  const allowance = Math.min(maxBytes, deps.budgetRemaining?.() ?? maxBytes)
  if (allowance <= 0) throw new Error("NETWORK_ASSET_SIZE_LIMIT: 分享页/清单读取已用完本次字节预算")
  const { bytes } = await fetchPublicHttpsBytesWithRetry(target, deps.resolve, allowance, {
    transport: deps.transport, signal: deps.signal, timeouts: deps.timeouts, retry: deps.retry, acceptHeader,
    onBytes: deps.onBytes, onAttempt: deps.onAttempt,
  })
  // 公开 CDN 对 JSON/HTML 常回 gzip（content-encoding 不在返回形状里），按魔数解一次；解压上限有界，防解压炸弹。
  const body = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: maxBytes * 16 }) : bytes
  return body.toString("utf8")
}

/**
 * 读一个**公开** JSON 地址（分享页清单等）：先过 SSRF 预检，再按同一条传输读回并 JSON.parse。
 * 非 JSON（HTML 错误页等）以结构化错误上抛，不当成"清单"继续。
 */
export async function fetchPublicJson(url: string, deps: SharePageDependencies = {}, maxBytes = DEFAULT_MANIFEST_MAX_BYTES): Promise<any> {
  const resolve = deps.resolve ?? defaultHostResolver
  const text = await fetchText(url, { ...deps, resolve }, maxBytes, JSON_ACCEPT)
  try { return JSON.parse(text) } catch { throw new Error(`ASSET_ACQUISITION_SHARE_PAGE_MANIFEST_NOT_JSON: ${url} 返回的不是 JSON（可能是 HTML 错误页）`) }
}

/** SuperSplat 页面里以 `\"key\",\"value\"` / `\"key\",<number>` 形状出现的自报事实；只在 ASCII 内解析。 */
function selfReported(html: string, key: string): string | number | undefined {
  const unescaped = html.replace(/\\"/g, '"')
  const text = new RegExp(`"${key}","([^"]*)"`).exec(unescaped)?.[1]
  if (text !== undefined) return decodeHtml(text)
  const num = new RegExp(`"${key}",(\\d+)`).exec(unescaped)?.[1]
  return num === undefined ? undefined : Number(num)
}

function parseViewerBootstrap(html: string): any | undefined {
  const match = /<script[^>]*id="sse-bootstrap"[^>]*>([\s\S]*?)<\/script>/.exec(html)
  if (!match) return undefined
  try { return JSON.parse(match[1]!) } catch { return undefined }
}

function licenseFromPage(html: string): { license?: string; licenseUrl?: string } {
  const href = attribute(html, /<link[^>]+rel="license"[^>]+href="([^"]+)"/i)
  if (!href) return {}
  const cc = /^https?:\/\/creativecommons\.org\/licenses\/([a-z-]+)\/(\d+(?:\.\d+)?)\/?/.exec(href)
  // 名称直接由公开许可 URL 的路径段拼出（by-sa/4.0 → CC-BY-SA-4.0），不是按主机名猜许可。
  return { license: cc ? `CC-${cc[1]!.toUpperCase()}-${cc[2]}` : undefined, licenseUrl: href }
}

function isStreamableDirect(url: string): boolean { return /\.(?:ply|spz|splat|sog)$/i.test(url.split(/[?#]/, 1)[0]!) }

/**
 * 解析一个已知分享页；不是已知分享页返回 undefined（交给直链获取入口，不猜）。
 * 网络/预检失败原样上抛（短暂故障由 fetchPublicHttpsBytesWithRetry 有界重试，安全语义与直链一致）。
 */
export async function resolveAssetSharePage(input: string, deps: SharePageDependencies = {}): Promise<SharePageResolution | undefined> {
  const target = sharePageTargetOf(input)
  if (!target) return undefined
  const resolve = deps.resolve ?? defaultHostResolver
  const view = { ...deps, resolve }
  const sourcePage = `https://superspl.at/scene/${target.hash}`
  const facts: SharePageFacts = { provider: target.provider, sourcePage }
  const warnings: string[] = []

  // ① 分享页：许可/作者/标题/自报格式与体积。页面读不到就如实失败，不猜。
  const html = await fetchText(sourcePage, view, deps.maxPageBytes ?? DEFAULT_PAGE_MAX_BYTES, HTML_ACCEPT)
  const rawTitle = attribute(html, /<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i)
    ?? attribute(html, /<title>([^<]*)<\/title>/i)
  if (rawTitle) facts.title = rawTitle.replace(/\s*-\s*SuperSplat\s*$/i, "")
  const poster = attribute(html, /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)
  if (poster) facts.posterUrl = poster
  const license = licenseFromPage(html)
  if (license.license) facts.license = license.license
  if (license.licenseUrl) facts.licenseUrl = license.licenseUrl
  const username = selfReported(html, "username")
  const fullName = selfReported(html, "fullName")
  if (typeof username === "string") facts.author = typeof fullName === "string" && fullName ? `${fullName} (${username})` : username
  const format = selfReported(html, "format")
  if (typeof format === "string") facts.format = format
  const size = selfReported(html, "size")
  if (typeof size === "number") facts.byteLength = size
  const downloadCount = selfReported(html, "downloadCount")
  if (typeof downloadCount === "number") facts.downloadCount = downloadCount
  // lodCounts 只在公开清单里取：分享页 SSR 流里的 lodCounts 可能是**引用下标**（[104,105,…]），
  // 把它当真实计数会撒谎；拿不到清单就如实不写这一项。

  // ② 官方 viewer：权威 contentUrl（不是猜的 API 路径）。
  const viewerUrl = `https://superspl.at/s?id=${target.hash}`
  facts.viewerUrl = viewerUrl
  const viewer = await fetchText(viewerUrl, view, deps.maxPageBytes ?? DEFAULT_PAGE_MAX_BYTES, HTML_ACCEPT)
  const bootstrap = parseViewerBootstrap(viewer)
  if (typeof bootstrap?.contentUrl === "string") facts.contentUrl = bootstrap.contentUrl
  if (typeof bootstrap?.collisionUrl === "string") facts.collisionUrl = bootstrap.collisionUrl
  if (typeof bootstrap?.posterUrl === "string" && facts.posterUrl === undefined) facts.posterUrl = bootstrap.posterUrl

  // 单个直链级资源（.ply/.spz/.splat）直接交给获取入口，不再去把它当 JSON 清单读。
  if (facts.contentUrl !== undefined && isStreamableDirect(facts.contentUrl)) {
    return { kind: "direct", provider: target.provider, directUrl: facts.contentUrl, ...(facts.format ? { format: facts.format } : {}), facts, warnings, resolved: true, acquirable: true, imported: false }
  }

  // 公开 LOD 清单：把"它到底是什么"钉成可核对读数（层级/计数/分块数/范围）。
  if (facts.contentUrl !== undefined) {
    const manifest = await fetchPublicJson(facts.contentUrl, view, deps.maxManifestBytes ?? DEFAULT_MANIFEST_MAX_BYTES)
    if (typeof manifest?.lodLevels === "number") facts.lodLevels = manifest.lodLevels
    if (Array.isArray(manifest?.counts) && manifest.counts.every((n: unknown) => typeof n === "number" && Number.isFinite(n))) facts.lodCounts = manifest.counts
    if (Array.isArray(manifest?.filenames)) facts.lodChunkFiles = manifest.filenames.length
    if (typeof manifest?.count === "number") facts.manifestCount = manifest.count
    const bound = manifest?.tree?.bound
    if (bound && Array.isArray(bound.min) && Array.isArray(bound.max) && [...bound.min, ...bound.max].every((n: unknown) => typeof n === "number" && Number.isFinite(n))) facts.bounds = { min: bound.min, max: bound.max }
    try {
      // 只读端确认这确实是可按 tree/filenames 选层的 SSOG，不下载任何分块。
      planSsogLod(manifest, 0)
      warnings.push("公开 Streamed SOG 的各层是压缩派生表示；默认 LOD0 是公开最高细节，但不等同网站需登录下载的作者原始 PLY。解析只读，尚未取得任何 chunk 或登记资源。")
      return { kind: "streamed-sog", provider: target.provider, manifestUrl: facts.contentUrl, facts, warnings, resolved: true, acquirable: true, imported: false }
    } catch (error) {
      warnings.push(`公开清单未通过 Streamed SOG v1 结构校验：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const full = facts.lodCounts?.[0]
  const detail = [
    facts.format !== undefined ? `format=${facts.format}` : undefined,
    facts.lodLevels !== undefined ? `${facts.lodLevels} 级 LOD` : undefined,
    facts.lodChunkFiles !== undefined ? `${facts.lodChunkFiles} 个分块元数据文件` : undefined,
    full !== undefined ? `全分辨率 ${full} 个高斯` : undefined,
    facts.byteLength !== undefined ? `页面自报 ${facts.byteLength} 字节` : undefined,
  ].filter(Boolean).join("，")
  const reason = `SuperSplat 分享页 ${target.hash} 是该站的 LOD 流式表示（${detail || "多文件清单"}），不是一个可下载的 3DGS 文件；本产品当前没有 ssog/LOD 分块解码器，不能把清单当模型导入。`
  const actions = [
    "给公开的 .spz/.ply/.splat 资源直链，用 scene_asset_acquire 获取；",
    "把已取得的本地原件（例如已读通的高斯 PLY）用 scene_import 或拖拽导入；",
    "在 SuperSplat 网页完成其下载流程取得完整原件后，再按本地文件导入；",
    "不要把这个 lod-meta.json 当 PLY 提交或改名，也不要反复猜它的 API。",
  ]
  warnings.push("分享页解析只读公开页面/官方 viewer 配置/公开清单，不访问任何账号凭据；LOD 分块没有下载，也就没有把预览级别当成完整原件这回事。")
  warnings.push("这里的 resolved/acquirable/imported 三态是分开的：本次只完成解析（resolved=true, acquirable=false, imported=false），没有取得模型字节、没有登记资源。完整原件若需要登录，本工具不会使用或绕过账号鉴权。")
  return { kind: "unsupported", provider: target.provider, reason, facts, actions, warnings, resolved: true, acquirable: false, imported: false }
}
