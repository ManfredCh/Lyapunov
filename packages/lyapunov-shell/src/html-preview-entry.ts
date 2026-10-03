/**
 * DEV-032 · HTML「编辑源码／预览页面」的**通用入口**（W10）。
 *
 * 命题（`docs/DEVELOPMENT_TODO.md#dev-032`）：原生普通 HTML 预览已经能用，但**通用入口**没补——
 * 于是"什么条件下预览不了、什么条件下源码编辑不了、为什么、怎么办"散落在各处（扩展编辑器一句
 * 4MB 报错、素材服务靠 Demo 的 python 脚本、单文件版另存他处）。这一层把它们收成**一份判据**：
 *
 *   检测（D1 预检） → 降级（D2 可解释） → 无替代则明确拒绝 + 处置（D3） → 回归测试（D4）
 *
 * 判据与话术**复用 W14 的环境契约**（`environment-readiness.ts`），不另造一套：
 *  · 状态用 `EnvironmentStatus`；行形状用 `EnvironmentRow`；四句话与处置步骤由 `environmentRowWording()` 统一渲染；
 *  · 依赖"出网能力"时直接吃环境面板的判定（`featureEnvironmentVerdict("asset.download", panel)`）。
 *  · 说明：`EnvironmentKind` 是 W14 契约里的封闭枚举（本单写入域不同、不去改它），HTML 的这几行按
 *    `tool` 登记、网络依赖按 `network` 登记；若那份契约后续加"内容"类目，这里只换一个字段值。
 *
 * **三个上限不是一回事**（DEV-032 完成条件点名"分别检查"，历史上正是被混为一谈才出的卡点）：
 *  · `EXTENSION_EDITOR_LIMIT_BYTES = 4_000_000` —— 工作区**扩展编辑器**读文本的上限
 *    （来源：`packages/lyapunov-workspace/src/plugin.ts` 的 `if((before.size??0)>4000000)`；
 *    注意是 4,000,000 B 不是 4 MiB＝4,194,304 B，报口径时不许四舍五入成 4MiB）；
 *  · `NATIVE_FULL_READ_LIMIT_BYTES = 32 MiB` —— DSH **原生完整读取／HTML 打包**的默认上限
 *    （来源：`docs/DEMO_BLOCKERS_AND_HISTORY_20260920.md §3.4`）；
 *  · `HTML_SCAN_WINDOW_BYTES = 4_000_000` —— 本模块预检**只看前这么多字节**（与编辑器上限同值，
 *    含义不同：不是限制，是"扫到哪"）；超过窗口就如实标"未扫全文"，不拿部分扫描冒充全文结论。
 *
 * 三条硬纪律：
 *  1. **两个入口各自独立**：页面预览成功**不能**代替源码编辑成功（DEV-032 完成条件原文）。
 *     所以 `planHtmlPreview()` 永远返回 `preview` 与 `source` 两个结论，谁也不掩盖谁。
 *  2. **判定必须稳定**：同一个文件连续判定两次、素材顺序打乱，都必须得到同一个结论与同一个
 *     `fingerprint`（计划函数是纯函数，不读时钟、不读全局、不写文件）。
 *  3. **存在性必须问对根**（BASE-SERVED-ROOT-MISMATCH，2026-09-26）：浏览器取素材问的是**素材服务**
 *     （origin + 路径），而本地文件系统只有在"服务根已知"时才和它对应。**服务根未知时，本地目录读数
 *     不是浏览器会得到的东西** —— 那时存在性**只由服务端实测回答**（问的就是浏览器要取的那个 URL），
 *     本地不判；反之服务根已知时用本地文件系统（便宜、且就在那棵树上）。
 *     由此得到一条**不许被打破的不变式**：同一块计划里，`assetService.state === "ready"` ⇒
 *     `missing` 与 `outsideRoot` 都为空（"服务就绪"与"缺件"不许同时出现；见 `planHtmlOpen` 与
 *     `assetServicePlan` 的实现，回归用例 `packages/lyapunov-shell/test/html-preview-served-root.test.ts`）。
 *
 * 客户端边界：`planHtmlPreview`/`parseHtmlAssetRefs`/`htmlPreviewFingerprint` 等**纯函数**可以被
 * 浏览器 import（bun 的浏览器构建会把 `node:fs` 探测函数摇掉）；**不要**在客户端引用
 * `probeHtmlPreviewFacts`/`probeAssetServer`/`planHtmlOpen`（它们要用 fs/网络）。
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, relative, resolve, sep } from "node:path"
import {
  environmentRowWording, featureEnvironmentVerdict,
  type EnvironmentDegradation, type EnvironmentPanel, type EnvironmentRemedy, type EnvironmentReport, type EnvironmentRow, type EnvironmentStatus,
} from "./environment-readiness.ts"

/** D4：钉住本入口判据的回归测试。 */
export const HTML_PREVIEW_CONTRACT_TEST = "packages/lyapunov-shell/test/html-preview-entry.test.ts"

// ───────────────────────── 三个上限口径（必须分开讲） ─────────────────────────

export interface HtmlLimit {
  id: string
  label: string
  bytes: number
  /** 这个数字管的是什么（一句人话）。 */
  scope: string
  /** 出处（可核对）。 */
  source: string
}

/** 工作区扩展编辑器读文本的上限：超了就拒绝整文件载入。 */
export const EXTENSION_EDITOR_LIMIT: HtmlLimit = {
  id: "extension-editor",
  label: "扩展编辑器整文件读取上限",
  bytes: 4_000_000,
  scope: "「编辑源码」走扩展编辑器时，超过它就不能整文件载入（与预览无关）",
  source: "packages/lyapunov-workspace/src/plugin.ts（`>4000000` 拒绝）",
}

/** DSH 原生完整读取／HTML 打包的默认上限。 */
export const NATIVE_FULL_READ_LIMIT: HtmlLimit = {
  id: "native-full-read",
  label: "原生完整读取/打包上限",
  bytes: 32 * 1024 * 1024,
  scope: "「预览页面」需要完整读取/打包页面时，超过它产品内预览不做完整载入",
  source: "docs/DEMO_BLOCKERS_AND_HISTORY_20260920.md §3.4（32MiB）",
}

/** 预检扫描窗口：只看前这么多字节（不是限制，是"扫到哪"）。 */
export const HTML_SCAN_WINDOW_BYTES = 4_000_000

export interface HtmlLimitCheck {
  limit: HtmlLimit
  bytes: number | null
  exceeded: boolean
  reading: string
}

function checkLimit(limit: HtmlLimit, bytes: number | null): HtmlLimitCheck {
  if (bytes === null) return { limit, bytes, exceeded: false, reading: `${limit.label}：文件大小未知，未判定（不猜）` }
  return {
    limit, bytes, exceeded: bytes > limit.bytes,
    reading: bytes > limit.bytes
      ? `${limit.label}：${humanBytes(bytes)} > ${humanBytes(limit.bytes)} ⇒ 超过`
      : `${limit.label}：${humanBytes(bytes)} ≤ ${humanBytes(limit.bytes)} ⇒ 未超过`,
  }
}

export function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)}MiB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

// ───────────────────────── 头部解析（纯函数；预检不整文件读入） ─────────────────────────

export type HtmlAssetKind = "image" | "video" | "audio" | "style" | "script" | "page" | "document" | "other"
export type HtmlAssetForm =
  | "inline" | "fragment" | "remote" | "asset-origin" | "relative" | "absolute-path" | "protocol-relative"
  /** 页面写了 `<base href>` 且指向**本机回环**：引用由那个服务提供（落点 = 服务根 + base 子路径）。 */
  | "base-served"

export interface HtmlAssetRef {
  raw: string
  kind: HtmlAssetKind
  form: HtmlAssetForm
  /** 声明它的属性（src/href/poster/srcset）。 */
  attribute: string
  /** `relative`/`absolute-path` 时解析出的**绝对路径**（工作区路径）；其它形态为 null。 */
  resolvedPath: string | null
  /** 是否落在素材服务根之内（决定它能不能被服务到）；无法判定为 null。 */
  withinServiceRoot: boolean | null
  /** 宿主探测：该文件在不在；null = 没探（**不得**当成存在）。 */
  exists: boolean | null
  /**
   * 这个 `exists` 是**问谁**问出来的（依据；`null` = 没判）：
   *  · `local-fs`：本机文件系统，落点 = **已被声明或实测证明的**服务根 + 路径；
   *  · `served-http`：素材服务本身（HTTP 状态裁决），URL **就是浏览器要取的那一个**。
   * 服务根未知时只用后者：本地目录跟浏览器问的不是同一棵树（BASE-SERVED-ROOT-MISMATCH）。
   */
  existenceBasis: "local-fs" | "served-http" | null
  /** `served-http` 时的 HTTP 状态码（证据；null = 请求没打成）。 */
  servedStatus: number | null
  /** 是否经 `<base href>` 解析（页面里写 `<base>` 时，相对引用不按页面目录走）。 */
  baseResolved: boolean
  /** 页面**实际会去取**的 URL（经 `<base>` 解析后）；非 URL 形态为 null。 */
  servedUrl: string | null
}

/**
 * `<base href>` 解析。
 *
 * 为什么必须有它：实测 `Demo/本地展示/产品介绍.html` 的 head 里写着
 * `<base href="http://127.0.0.1:44139/product/">`，于是页面里那些 `media/…` **不按页面目录解析**，
 * 而是去取 `http://127.0.0.1:44139/product/media/…`。忽略 `<base>` 会把一份配置正确的页面报成
 * "8 个素材不存在"——预检自己制造假警报，比不预检更坏（这正是本单要防的那类问题）。
 */
export function parseHtmlBaseHref(head: string): string | null {
  const match = head.match(/<base\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i)
  const value = (match?.[2] ?? match?.[3] ?? match?.[4] ?? "").trim()
  return value === "" ? null : value
}

export interface HtmlHeadFacts {
  /** `html` = 看起来是 HTML 文档；`fragment` = 像 HTML 片段；`other` = 不像 HTML；`binary` = 含 NUL 字节。 */
  contentType: "html" | "fragment" | "other" | "binary"
  hasDoctype: boolean
  /**
   * 编码读数：`bom` 只认 UTF-8 BOM（UTF-16 的解码结果会含 NUL 字节，落进 `binary`，不在这里猜）。
   * `declared` 是页面自己声明或 HTTP 头会带的 charset（声明≠实际，仅作读数）。
   */
  encoding: { bom: "utf-8" | null; declared: string | null }
  /** 头部里有 `<script>` 内联脚本（预览会执行它们——如实说明，不假装预览是"静态"的）。 */
  hasInlineScript: boolean
}

/** 头部/全文窗口的分类：只看窗口内容，不猜后续。 */
export function classifyHtmlHead(head: string): HtmlHeadFacts {
  // UTF-8 BOM 会被解码成首个 U+FEFF；UTF-16 文件解出来带 NUL，落进 binary（不猜编码）。
  const bom = head.startsWith("\uFEFF") ? "utf-8" as const : null
  const binary = head.includes("\u0000")
  const declared = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i)?.[1]?.toLowerCase()
    ?? head.match(/charset\s*=\s*["']?\s*([\w-]+)/i)?.[1]?.toLowerCase() ?? null
  const hasDoctype = /<!doctype\s+html/i.test(head)
  const hasHtmlTag = /<html[\s>]/i.test(head)
  const hasBodyOrBlocks = /<(body|div|p|section|article|main|table|img|video|script|style|head)[\s>]/i.test(head)
  const contentType: HtmlHeadFacts["contentType"] = binary ? "binary" : hasDoctype || hasHtmlTag ? "html" : hasBodyOrBlocks ? "fragment" : "other"
  return { contentType, hasDoctype, encoding: { bom, declared }, hasInlineScript: /<script[\s>]/i.test(head) }
}

const REFERENCE_ATTRIBUTES: Array<[string, RegExp, HtmlAssetKind]> = [
  ["src", /\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi, "other"],
  ["href", /\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi, "other"],
  ["poster", /\sposter\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi, "image"],
  ["srcset", /\ssrcset\s*=\s*("([^"]*)"|'([^']*)')/gi, "image"],
]

/**
 * 按标签上下文细化类型：`<video>` 本体不带 src、真正指向媒体的是它里面的
 * `<source src="…" type="video/mp4">`；而 `<video poster="…">` 的 poster 是**封面图**。
 * 实测教训（`Demo/本地展示/product/index.html`）：把 poster 当视频、把 `<source type=video/mp4>`
 * 当 other，会让"需要 Range 的视频"计数为 0 —— 于是不支持 Range 的服务会被判成"预览就绪"。
 */
function refineKind(tag: string, attribute: string, fallback: HtmlAssetKind): HtmlAssetKind {
  const name = tag.match(/^<\s*([a-z0-9]+)/i)?.[1]?.toLowerCase() ?? ""
  const declared = tag.match(/\stype\s*=\s*["']?([\w/.+-]+)/i)?.[1]?.toLowerCase() ?? ""
  if (name === "source") {
    if (declared.startsWith("video/")) return "video"
    if (declared.startsWith("audio/")) return "audio"
    if (declared.startsWith("image/")) return "image"
    return attribute === "poster" || attribute === "srcset" ? "image" : "other"
  }
  if (attribute === "poster") return "image"
  if (name === "img") return "image"
  if (name === "video") return "video"
  if (name === "audio") return "audio"
  if (name === "script") return "script"
  if (name === "iframe" || name === "frame") return "page"
  if (name === "link") return /stylesheet/i.test(tag) ? "style" : "other"
  if (name === "a" || name === "area") return "document"
  return fallback
}

function formOf(raw: string, assetOrigin: string | null): HtmlAssetForm {
  if (raw.startsWith("#")) return "fragment"
  if (/^data:/i.test(raw)) return "inline"
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return assetOrigin !== null && raw.startsWith(assetOrigin) ? "asset-origin" : "remote"
  if (raw.startsWith("//")) return "protocol-relative"
  if (raw.startsWith("/")) return "absolute-path"
  return "relative"
}

/**
 * 从 HTML 正文（前 N 字节窗口）里抽出**素材引用**。
 *
 * 只做"引用在前 N 字节里出现过什么"的如实统计：不解析 DOM、不执行脚本、不下载远端。
 * `script`/`style` 的内联内容不当作引用；`href="#…"` 是页内锚点，单独计数不当素材。
 */
export function parseHtmlAssetRefs(head: string, options: { assetOrigin?: string | null } = {}): HtmlAssetRef[] {
  const assetOrigin = options.assetOrigin ?? null
  const refs: HtmlAssetRef[] = []
  const tagPattern = /<[a-z][^>]*>/gi
  let tag: RegExpExecArray | null
  while ((tag = tagPattern.exec(head)) !== null) {
    const source = tag[0]
    // `<base href>` / `<meta …>` 是文档元数据：`<base>` 自己会被当成一个"引用"数进来（实测）。
    if (/^<\s*(base|meta)\b/i.test(source)) continue
    for (const [attribute, pattern, fallback] of REFERENCE_ATTRIBUTES) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(source)) !== null) {
        const value = (match[2] ?? match[3] ?? match[4] ?? "").trim()
        if (value === "") continue
        const kind = refineKind(source, attribute, fallback)
        if (attribute === "srcset") {
          for (const candidate of value.split(",").map(part => part.trim().split(/\s+/)[0] ?? "").filter(Boolean)) {
            refs.push({ raw: candidate, kind: "image", form: formOf(candidate, assetOrigin), attribute, resolvedPath: null, withinServiceRoot: null, exists: null, existenceBasis: null, servedStatus: null, baseResolved: false, servedUrl: null })
          }
          continue
        }
        refs.push({ raw: value, kind, form: formOf(value, assetOrigin), attribute, resolvedPath: null, withinServiceRoot: null, exists: null, existenceBasis: null, servedStatus: null, baseResolved: false, servedUrl: null })
      }
    }
  }
  return refs
}

export interface AssetResolveOptions {
  pageDir: string
  serviceRoot: string | null
  /** 页面自己的 `<base href>`；有它时相对引用**不按页面目录**解析。 */
  baseHref?: string | null
  /** 配置的素材服务 origin（用来判断 base 指向的是不是同一个服务）。 */
  assetOrigin?: string | null
}

const within = (root: string | null, target: string): boolean | null =>
  root === null ? null : target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)

/**
 * 相对/绝对路径引用 → 本地绝对路径 + **页面实际会去取的 URL**。
 * 落在服务根之外、或解析不出本地落点的一律标出来（服务不到，不许当成"素材在"）。
 */
export function resolveAssetRefs(refs: readonly HtmlAssetRef[], options: AssetResolveOptions): HtmlAssetRef[] {
  const root = options.serviceRoot === null ? null : resolve(options.serviceRoot)
  const baseHref = options.baseHref ?? null
  let baseUrl: URL | null = null
  if (baseHref !== null) { try { baseUrl = new URL(baseHref) } catch { baseUrl = null } }
  const assetOrigin = options.assetOrigin === null || options.assetOrigin === undefined ? null : safeOrigin(options.assetOrigin)
  return refs.map(ref => {
    // 写成绝对 URL、且指向配置素材服务的引用：同样要落到服务根上去核对（不许因为"写了完整 URL"就跳过）。
    if (ref.form === "asset-origin") {
      try {
        const served = new URL(ref.raw)
        const local = root === null ? null : resolve(root, `.${decodeURIComponent(served.pathname)}`)
        return { ...ref, resolvedPath: local, withinServiceRoot: local === null ? null : within(root, local), baseResolved: false, servedUrl: served.href }
      } catch { return ref }
    }
    if (ref.form !== "relative" && ref.form !== "absolute-path") return ref
    const path = ref.raw.split(/[?#]/)[0] ?? ""
    if (baseUrl !== null && ref.form === "relative") {
      const served = new URL(ref.raw, baseUrl)
      // base 指向文件系统：按路径落到本地。
      if (served.protocol === "file:") {
        const local = decodeURIComponent(served.pathname)
        return { ...ref, resolvedPath: local, withinServiceRoot: within(root, local), baseResolved: true, servedUrl: served.href }
      }
      // base 指向**本机回环**（配置的素材服务，或页面自己指定的另一个本机服务）：
      // 这一条仍然"需要服务"，只是落点由 base 决定。落点只在**同源**时才能映射到本地服务根上核对，
      // 否则 exists 保持 null —— 不能拿别人的根去断言素材"不存在"。
      if (isLoopbackHost(served.hostname)) {
        const sameOrigin = assetOrigin !== null && served.origin === assetOrigin
        const local = sameOrigin && root !== null ? resolve(root, `.${decodeURIComponent(served.pathname)}`) : null
        return { ...ref, form: "base-served", resolvedPath: local, withinServiceRoot: local === null ? null : within(root, local), baseResolved: true, servedUrl: served.href }
      }
      // base 指向外网站点：这一条是远端引用（要出网）。
      return { ...ref, form: "remote", resolvedPath: null, withinServiceRoot: null, baseResolved: true, servedUrl: served.href }
    }
    const local = ref.form === "relative" ? resolve(options.pageDir, path) : resolve(options.pageDir, `.${path}`)
    // 同源（配置了 origin + 根）时给出"实际会取的 URL"：复核命令与 Range 探测都要用真实的**文件** URL，
    // 拿服务根 `/`（目录）去判 Range 会得到一个假读数（本机实测：真服务被误判成"不支持 Range"）。
    const servedUrl = assetOrigin !== null && root !== null && within(root, local) === true
      ? `${assetOrigin}/${relative(root, local).split(sep).join("/")}`
      : null
    return { ...ref, resolvedPath: local, withinServiceRoot: within(root, local), baseResolved: false, servedUrl }
  })
}

function safeOrigin(origin: string): string | null {
  try { return new URL(origin).origin } catch { return null }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]"
}

/** 这个 origin 是不是本机回环（`probeAssetServer` 只探回环；宿主侧也用它决定"值不值得探"）。 */
export function isLoopbackOrigin(origin: string): boolean {
  try { return isLoopbackHost(new URL(origin).hostname) } catch { return false }
}

// ───────────────────────── 探测（真实 IO；客户端不要引用这一段） ─────────────────────────

export type AssetServiceKind = "host-route" | "static-service" | "none"

/** 本地静态素材服务状态。`reachable === null` 表示**没探过**——没探过不等于可用。 */
export interface HtmlAssetServerState {
  kind: AssetServiceKind
  origin: string | null
  root: string | null
  reachable: boolean | null
  /** 是否支持 `Range`（视频起播/拖动要用；用 206 实测，不靠自报）。 */
  rangeSupported: boolean | null
  /** 探测时刻（仅作证据；**不参与判定**，判定必须与时钟无关）。 */
  probedAt: number | null
  detail: string
}

export const UNPROBED_ASSET_SERVER: HtmlAssetServerState = {
  kind: "none", origin: null, root: null, reachable: null, rangeSupported: null, probedAt: null,
  detail: "尚未探测静态素材服务（没探过 ≠ 可用）",
}

/**
 * **服务端**存在性读数：在"浏览器会去取的那个 URL"上实测到的结果（BASE-SERVED-ROOT-MISMATCH）。
 * 为什么要它：服务根未知时，本地文件系统那棵树**不是**浏览器问的那一棵；本地找不到只能说明
 * "我映射错了树"，不能说明"素材不存在"。
 */
export interface ServedExistenceReading {
  /** HTTP 状态码；null = 请求没打成（超时/连不上/调用方关掉了探测）。 */
  status: number | null
  /** true = 服务端有这一份；false = 服务端明确说没有（404/410）；null = **没探到**（不得当成"不存在"）。 */
  exists: boolean | null
}

export interface HtmlPreviewFacts {
  /** 展示用路径（工作区相对路径优先，绝对路径也可）。 */
  path: string
  /** 文件绝对路径（相对素材以此为基址解析）。 */
  absolutePath: string
  /** 页面所在目录（探测层填；纯判定层用它，从而不 import node:path —— 客户端才 import 得动）。 */
  pageDir: string
  /**
   * **服务根是否已知**（有人明确给了它，或被实测证明过）。
   * `false` ⇒ 本模块**没有**服务对应的目录读数：存在性只能由服务端实测回答，
   * **不许**拿页面所在目录顶替（那正是 BASE-SERVED-ROOT-MISMATCH 的成因）。
   */
  serviceRootKnown: boolean
  sizeBytes: number | null
  head: string | null
  /** 扫描窗口是否截断（true 时**不许**下"全文只有这些引用"的结论）。 */
  scanTruncated: boolean
  headFacts: HtmlHeadFacts
  /** 页面自己的 `<base href>`（有它时相对引用不按页面目录走）。 */
  baseHref: string | null
  /** `<base href>` 的 origin（解析不出来为 null）。 */
  baseOrigin: string | null
  assets: readonly HtmlAssetRef[]
  assetServer: HtmlAssetServerState
  /** 环境契约的整屏（可选）：给了就用它的"出网能力"行判定远端素材。 */
  environment?: EnvironmentPanel | undefined
  /** 没有整屏时，可直接注入"出网能力"这一行的读数。 */
  network?: EnvironmentReport | undefined
}

export interface HtmlProbeInput {
  /** 文件绝对路径。 */
  filePath: string
  /** 展示用路径（缺省用 filePath）。 */
  displayPath?: string
  /**
   * 素材服务的根。缺省取页面所在目录（页面与素材同目录时最省事）；
   * **显式给 `null` = 服务根未知** ⇒ 本地落点不作数，存在性改由 `servedExistence` 回答。
   */
  serviceRoot?: string | null
  assetServer?: HtmlAssetServerState
  environment?: EnvironmentPanel
  network?: EnvironmentReport
  /** 扫描窗口字节数（缺省 `HTML_SCAN_WINDOW_BYTES`）。 */
  scanWindowBytes?: number
  /**
   * 服务端存在性读数（URL → 实测）。给了它且命中该引用的 `servedUrl`，就以**服务端**为准：
   * 这是"存在性问对根"的实现方式（服务根未知时唯一问得对的一棵树）。
   */
  servedExistence?: ReadonlyMap<string, ServedExistenceReading> | undefined
}

/** 宿主侧预检：stat + 读前 N 字节 + 解析引用 + 探素材存在性。**不整文件读入**、不执行页面脚本。 */
export function probeHtmlPreviewFacts(input: HtmlProbeInput): HtmlPreviewFacts {
  const absolutePath = resolve(input.filePath)
  const windowBytes = input.scanWindowBytes ?? HTML_SCAN_WINDOW_BYTES
  let sizeBytes: number | null = null
  try { const info = statSync(absolutePath); sizeBytes = info.isFile() ? info.size : null } catch { sizeBytes = null }
  let head: string | null = null
  try {
    const buffer = readFileSync(absolutePath)
    head = buffer.subarray(0, windowBytes).toString("utf8")
  } catch { head = null }
  const scanTruncated = sizeBytes !== null && head !== null && sizeBytes > Buffer.byteLength(head, "utf8")
  const headFacts = classifyHtmlHead(head ?? "")
  const pageDir = dirname(absolutePath)
  const assetOrigin = input.assetServer?.origin ?? null
  const baseHref = parseHtmlBaseHref(head ?? "")
  const serviceRootKnown = input.serviceRoot !== null
  const parsed = resolveAssetRefs(parseHtmlAssetRefs(head ?? "", { assetOrigin }), {
    pageDir, serviceRoot: input.serviceRoot === undefined ? pageDir : input.serviceRoot, baseHref, assetOrigin,
  })
  // 存在性**问谁**：① 有服务端读数 ⇒ 以服务端为准（问的就是浏览器要取的那个 URL）；
  //              ② 落点落不到本地（服务根未知/根外）⇒ 如实留 null，不许拿别的树当答案；
  //              ③ 其余（服务根已知）⇒ 本地文件系统。
  const assets = parsed.map(ref => {
    const served = ref.servedUrl === null ? undefined : input.servedExistence?.get(ref.servedUrl)
    if (served !== undefined) return { ...ref, exists: served.exists, existenceBasis: "served-http" as const, servedStatus: served.status }
    if (ref.resolvedPath === null || ref.withinServiceRoot === false) return ref
    return { ...ref, exists: existsSync(ref.resolvedPath), existenceBasis: "local-fs" as const, servedStatus: null }
  })
  return {
    path: input.displayPath ?? input.filePath, absolutePath, pageDir, serviceRootKnown, sizeBytes, head, scanTruncated, headFacts,
    baseHref, baseOrigin: baseHref === null ? null : safeOrigin(baseHref), assets,
    assetServer: input.assetServer ?? UNPROBED_ASSET_SERVER,
    environment: input.environment, network: input.network,
  }
}

export interface AssetServerProbeDeps {
  /** 注入 fetch（测试离线用）；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /**
   * 探测用的**具体文件路径**（例如 `/product/media/clip.mp4`）。
   * 必须给一个真实文件：拿服务根（目录）去判 Range 会得到假读数——本机实测真服务（支持 Range）
   * 因为根路径不是文件而回落 200，被判成"不支持 Range"，进而对用户说"视频不能起播"。
   * 不给时只判可达性，`rangeSupported` 保持 `null`（未知），绝不写成 false。
   */
  probePath?: string | null
}

/**
 * 实测静态素材服务：可达性 + `Range` 支持（用真 206 判定，不看它自报的头）。
 * 只对**本机回环**地址探测（不做出网请求）；探测结果带 `probedAt`，但判定不使用它。
 */
export async function probeAssetServer(origin: string, deps: AssetServerProbeDeps = {}): Promise<HtmlAssetServerState> {
  const doFetch = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? 3000
  const base: HtmlAssetServerState = { kind: "static-service", origin, root: null, reachable: null, rangeSupported: null, probedAt: Date.now(), detail: "" }
  let host: string
  try { host = new URL(origin).hostname } catch { return { ...base, detail: `不是合法 URL：${origin}` } }
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    return { ...base, detail: `只探测本机回环素材服务，拒绝探测 ${host}（避免把预览变成出网请求）` }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const probePath = deps.probePath?.trim()
  const target = probePath === undefined || probePath === "" ? origin : `${origin.replace(/\/$/, "")}${probePath.startsWith("/") ? probePath : `/${probePath}`}`
  const onFile = target !== origin
  try {
    const response = await doFetch(target, { method: "GET", headers: { range: "bytes=0-0" }, signal: controller.signal })
    // 404/410 时**不判 Range**：文件都不在那条路径上，200-vs-206 说明不了服务支不支持 Range。
    const missing = response.status === 404 || response.status === 410
    const rangeSupported = response.status === 206 ? true : missing ? null : onFile ? false : null
    // 只读 1 字节就取消，避免把整个文件拉下来。
    try { await response.body?.cancel() } catch { /* 已经读完/无 body */ }
    return {
      ...base, reachable: true, rangeSupported,
      detail: rangeSupported === true
        ? `可达且支持 Range（206，实测 ${target}）— 视频可起播/拖动`
        : rangeSupported === false
          ? `可达但**不支持 Range**（HTTP ${response.status}，期望 206；实测 ${target}）— 视频起播与拖动会失败`
          : response.status === 404 || response.status === 410
            // 404 不是 Range 读数：文件都不在这条路径上，说什么"支持不支持 Range"都是越读。
            ? `可达，但探测用的那个**文件路径在服务上不存在**（HTTP ${response.status}，实测 ${target}）：**Range 读数不成立**（这里如实报"未知"，不当成"不支持 Range"）`
            : `可达（HTTP ${response.status}），但本次只探到服务根、不是文件：Range 只能在真实素材上判，这里如实报"未知"（复核：${origin.replace(/\/$/, "")}/<任一素材>）`,
    }
  } catch (error) {
    return { ...base, reachable: false, rangeSupported: null, detail: `不可达：${(error as Error).name}: ${(error as Error).message}` }
  } finally { clearTimeout(timer) }
}

/**
 * 找到"这条素材在服务上的挂载点"：页面目录不一定就是服务根（本机实测：Demo 的服务根是
 * `Demo/本地展示`，而入口页在 `Demo/本地展示/product/`），所以按候选根依次试——
 * 显式给的服务根 → 页面目录 → 逐级祖先（最多 3 层），用**真实 HTTP 响应**（200/206）当裁决，
 * 取第一个命中的。这是**取事实**，不是另写一份判据：Range 结论仍然只由 `probeAssetServer` 给。
 */
async function discoverAssetUrl(origin: string, facts: HtmlPreviewFacts, explicitRoot: string | null, deps: AssetServerProbeDeps): Promise<{ url: string | null; root: string | null; tried: string[] }> {
  const direct = facts.assets.filter(isLoadTimeAsset).map(ref => ref.servedUrl).find(url => url !== null && url.startsWith(origin))
  if (direct !== undefined && direct !== null) return { url: direct, root: explicitRoot, tried: [direct] }
  const target = facts.assets.filter(isLoadTimeAsset).find(ref => ref.resolvedPath !== null && ref.withinServiceRoot === true)
  if (target === undefined || target.resolvedPath === null) return { url: null, root: explicitRoot, tried: [] }
  const roots: string[] = []
  if (explicitRoot !== null && explicitRoot !== "") roots.push(explicitRoot)
  let directory = facts.pageDir
  for (let depth = 0; depth < 4; depth++) {
    roots.push(directory)
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  const doFetch = deps.fetchImpl ?? fetch
  const tried: string[] = []
  for (const candidate of roots) {
    const path = relative(resolve(candidate), target.resolvedPath)
    if (path.startsWith("..")) continue
    const url = `${origin.replace(/\/$/, "")}/${path.split(sep).join("/")}`
    if (tried.includes(url)) continue
    tried.push(url)
    try {
      const response = await doFetch(url, { method: "GET", headers: { range: "bytes=0-0" }, signal: deps.timeoutMs === undefined ? undefined : AbortSignal.timeout(deps.timeoutMs) })
      try { await response.body?.cancel() } catch { /* 无 body */ }
      if (response.status === 206 || response.status === 200) return { url, root: candidate, tried }
    } catch { /* 换下一个候选 */ }
  }
  return { url: null, root: explicitRoot, tried }
}

/**
 * 该页面**第一条加载期素材**在素材服务上的路径（Range 探测与复核命令都该用它）。
 *
 * 为什么必须有：拿服务根 `/`（目录）去判 Range 会得到一个**假读数**——本机实测：真实
 * `Demo/tools/media-server.py` 是支持 Range 的（对素材回 206 + Content-Range），但根路径不是文件，
 * 它按目录回落 200，于是判据说出"不支持 Range、视频不能起播"这种与事实相反的话。
 * 客户端不要引用本函数（宿主侧用 node:path 算相对路径）。
 */
export function firstAssetPath(facts: HtmlPreviewFacts, serviceRoot: string | null): string | null {
  const direct = facts.assets.filter(isLoadTimeAsset).map(ref => ref.servedUrl).find(url => url !== null)
  if (direct !== undefined && direct !== null) { try { return new URL(direct).pathname } catch { /* 退回按落点算 */ } }
  const base = serviceRoot ?? facts.pageDir
  for (const ref of facts.assets.filter(isLoadTimeAsset)) {
    if (ref.resolvedPath === null || ref.withinServiceRoot !== true) continue
    const path = relative(resolve(base), ref.resolvedPath)
    if (!path.startsWith("..")) return `/${path.split(sep).join("/")}`
  }
  return null
}

/** 一次判定最多实测多少个素材（防止为一次判定发几百个请求；超出的如实标"未实测"，不猜）。 */
export const SERVED_EXISTENCE_PROBE_LIMIT = 24

/**
 * **在服务端**核对素材存在性：逐条 GET **浏览器会去取的那个 URL**（读完 1 字节即取消）。
 *
 * 为什么必须有（BASE-SERVED-ROOT-MISMATCH 的落点）：`<base href="http://127.0.0.1:44139/product/">`
 * 这类页面，素材在**服务实际根**那一棵树里，而本机拿到的"服务根"读数可能是页面目录——两棵树不同时，
 * `existsSync(页面目录 + /product/…)` 会回 false，于是计划块**一边报"素材服务 ready（206）"、
 * 一边报"缺件（服务再好也补不上）"**，而浏览器其实把图取到了。存在性问错根 ⇒ 结论与事实相反。
 *
 * 裁决口径（不用"猜"）：`200/206` ⇒ 有；`404/410` ⇒ **服务端明确说没有**；其它状态/没打成 ⇒
 * **未判**（`exists: null`，不许当成"不存在"，也不许当成"存在"）。
 */
async function probeServedExistence(
  assets: readonly HtmlAssetRef[], origin: string, deps: AssetServerProbeDeps,
): Promise<Map<string, ServedExistenceReading>> {
  const doFetch = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? 3000
  const readings = new Map<string, ServedExistenceReading>()
  const urls = [...new Set(assets
    .filter(ref => isLoadTimeAsset(ref) && ref.servedUrl !== null && ref.servedUrl.startsWith(origin))
    .map(ref => ref.servedUrl as string))].slice(0, SERVED_EXISTENCE_PROBE_LIMIT)
  for (const url of urls) {
    let reading: ServedExistenceReading = { status: null, exists: null }
    try {
      const response = await doFetch(url, { method: "GET", headers: { range: "bytes=0-0" }, signal: AbortSignal.timeout(timeoutMs) })
      const status = response.status
      try { await response.body?.cancel() } catch { /* 已经读完/无 body */ }
      reading = { status, exists: status === 200 || status === 206 ? true : status === 404 || status === 410 ? false : null }
    } catch { reading = { status: null, exists: null } }
    readings.set(url, reading)
  }
  return readings
}

// ───────────────────────── 判定（纯函数；同一份事实永远同一个结论） ─────────────────────────

export type HtmlOpenTarget = "preview" | "source"
export type HtmlDisposition = "ready" | "degraded" | "unusable" | "unknown"

export interface HtmlPathPlan {
  target: HtmlOpenTarget
  label: string
  /** 复用环境契约的行形状（状态 / 影响 / 降级 / 处置 / 证据齐全）。 */
  row: EnvironmentRow
  /** 统一话术：与 GPU/驱动那些行同一份格式（`environmentRowWording`）。 */
  wording: string[]
  disposition: HtmlDisposition
  limits: HtmlLimitCheck[]
  /** 界面/CLI 可直接照抄的动作。 */
  action: { kind: "open-preview" | "open-source"; label: string; detail: string; enabled: boolean }
}

export interface HtmlAssetServicePlan {
  required: boolean
  kind: AssetServiceKind
  origin: string | null
  root: string | null
  rangeRequired: boolean
  state: EnvironmentStatus
  row: EnvironmentRow
  wording: string[]
  checks: string[]
  /** 重开后必须**重新探测**（旧读数不算数）。 */
  recheck: { what: string; how: string; expect: string }
  /** 服务根是否**已知**（明确给出或实测证明过）；false ⇒ 计划里不许再写"根 = 页面所在目录"。 */
  rootKnown: boolean
  /** 指向服务根之外的引用（服务不到，如实列出）。 */
  outsideRoot: string[]
  /** 指向不存在文件的**加载期素材**（会缺图/缺视频，如实列出）。 */
  missing: string[]
  /** 指向不存在文件的**导航链接**（页面照常，点开才 404；DEV-032 的"加载失败可理解"）。 */
  brokenLinks: string[]
}

export interface HtmlPreviewPlan {
  path: string
  facts: {
    sizeBytes: number | null
    scanTruncated: boolean
    contentType: HtmlHeadFacts["contentType"]
    assetCounts: { inline: number; relative: number; remote: number; fragment: number; other: number }
    /** 单文件形态（没有需要外部服务的引用）——重启/断网仍可读的判据。 */
    selfContained: boolean
  }
  preview: HtmlPathPlan
  source: HtmlPathPlan
  assetService: HtmlAssetServicePlan
  /** 两个入口都要不要给用户看（DEV-032：保留明确的"编辑源码／预览页面"选择）。 */
  choices: Array<{ target: HtmlOpenTarget; label: string; disposition: HtmlDisposition; enabled: boolean }>
  recommended: HtmlOpenTarget | null
  /** 一句总述，界面直接显示。 */
  summary: string
  wording: string[]
  /** 稳定指纹：同一份事实两次判定必须一致（防止"判定自己在抖"）。 */
  fingerprint: string
}

const HTML_TEST = `${HTML_PREVIEW_CONTRACT_TEST} › `

function htmlRow(input: {
  id: string; label: string; status: EnvironmentStatus; state: string; reading: string; impact: string
  uncertain?: boolean; /** 这一行自己的不确定说明（通用话术原样带出，不借用别人的句子）。 */
  uncertaintyNote?: string | null
  evidence: readonly string[]; degradation: EnvironmentDegradation | null
  remedy: EnvironmentRemedy; kind?: EnvironmentRow["kind"]; test: string
}): EnvironmentRow {
  return {
    id: input.id, kind: input.kind ?? "tool", label: input.label, status: input.status, state: input.state,
    reading: input.reading, impact: input.impact, uncertain: input.uncertain ?? false,
    uncertaintyNote: input.uncertain ? (input.uncertaintyNote ?? null) : null,
    evidence: input.evidence, degradation: input.degradation, remedy: input.remedy, scope: "optional", contractTest: input.test,
  }
}

/** 行 → 处置（与 W14 的面板总评同一套语义：有降级路径就不算"不可用"）。 */
export function htmlDispositionOf(row: EnvironmentRow): HtmlDisposition {
  if (row.status === "ready") return "ready"
  if (row.status === "unknown") return "unknown"
  if (row.status === "degraded") return "degraded"
  return row.degradation === null ? "unusable" : "degraded"
}

const SOURCE_FALLBACK: EnvironmentDegradation = {
  path: "用终端或模型的分段读取改写（`sed -n` / `rg` 定位后按段读，不整文件载入编辑器）",
  active: true,
  restore: "把页面压到编辑器上限以内（拆分素材、外链资源、或另存精简版）后编辑器即可整文件载入",
}

const PREVIEW_FALLBACK: EnvironmentDegradation = {
  // F3（DEV032 §4 观察）：这句话原先写"不完整载入地看页面（产品内预览不做完整读取/打包）"，读起来像
  // 产品会**部分**载入出内容。界面级实测不是这样：超限页面点开后标签里**没有内容**（工具栏 `HTML` + 重试），
  // 原因是明确的失败态。所以这里改成"这一入口给出原因、换别的路看这一份"，与实测行为对齐。
  path: "产品内预览不做完整载入（点开会以失败态结束并给出原因）；要看这一页请用系统浏览器或本机静态服务直接打开这一份",
  active: true,
  restore: "切片/压缩到原生完整读取上限以内，或用系统浏览器/本地静态服务直接打开这一份",
}

function previewPlan(facts: HtmlPreviewFacts, scanNote: string): HtmlPathPlan {
  const size = facts.sizeBytes
  const limits = [checkLimit(NATIVE_FULL_READ_LIMIT, size)]
  const evidenceBase = [
    `文件：${facts.path}（${size === null ? "大小未知" : humanBytes(size)}）`,
    `头部判定：${facts.headFacts.contentType}${facts.headFacts.hasDoctype ? "（有 doctype）" : ""}${facts.headFacts.encoding.bom ? `，BOM=${facts.headFacts.encoding.bom}` : ""}`,
    facts.baseHref === null ? "无 <base href>：相对引用按页面目录解析" : `页面 <base href>：${facts.baseHref}（相对引用不按页面目录解析）`,
    scanNote,
  ]
  const action = (enabled: boolean): HtmlPathPlan["action"] => ({ kind: "open-preview", label: "预览页面", detail: `在原生预览里打开 ${facts.path}`, enabled })

  const counts = countAssets(facts.assets)
  // 只认**加载期**素材：`<a href>` 这类导航链接点开才用，不该把"必须有素材服务"判成必需。
  const loadRefs = facts.assets.filter(isLoadTimeAsset)
  const relative = loadRefs.filter(ref => SERVED_FORMS.has(ref.form))
  const remote = loadRefs.filter(ref => ref.form === "remote" || ref.form === "protocol-relative")
  const unserved = relative.filter(ref => ref.withinServiceRoot === false)
  const missing = relative.filter(ref => ref.exists === false)
  const rangeRequired = [...relative, ...remote].some(ref => ref.kind === "video" || ref.kind === "audio")
  const serviceState = facts.assetServer

  // ① 不是 HTML / 读不到：明确说清，不假装"预览成功"。
  if (facts.head === null) {
    const row = htmlRow({
      id: "html.preview", label: "页面预览", status: "unknown", state: "unreadable", reading: `文件读不到（或不是普通文件）：${facts.path}`,
      impact: "无法预检这条路：**未知不等于可用**，也不能假定打不开。", evidence: evidenceBase, degradation: null,
      remedy: { summary: "先确认路径与权限，再重试预检。", steps: ["确认文件在工作区里：`ls -l <路径>`", "确认是文件而不是目录/软链目标缺失", "确认宿主对该路径有读权限"] }, test: HTML_TEST + "预检四种形态",
    })
    return { target: "preview", label: "预览页面", row, wording: environmentRowWording(row), disposition: "unknown", limits, action: action(false) }
  }
  if (facts.headFacts.contentType === "binary") {
    const row = htmlRow({
      id: "html.preview", label: "页面预览", status: "missing", state: "binary", reading: `不是文本 HTML（头部含 NUL 字节）：${facts.path}`,
      impact: "按页面预览会得到乱码或空白——这正是“静默留空”的形态，所以这里明确拒绝。", evidence: evidenceBase, degradation: null,
      remedy: { summary: "换成源码/十六进制视图看，或换一个 HTML 文件。", steps: ["用「编辑源码」或终端 `file <路径>` 确认真实类型", "若是压缩/二进制资源，先解压或换用对应查看器"] }, test: HTML_TEST + "非 HTML 与编码异常",
    })
    return { target: "preview", label: "预览页面", row, wording: environmentRowWording(row), disposition: "unusable", limits, action: action(false) }
  }
  if (facts.headFacts.contentType === "other") {
    const row = htmlRow({
      id: "html.preview", label: "页面预览", status: "missing", state: "not-html", reading: `头部不像 HTML（无 doctype、无 <html>、也没有块级标签）：${facts.path}`,
      impact: "页面预览会给出一个空页/纯文本——不能当“预览成功”。",
      uncertain: true, uncertaintyNote: "这是**启发式**判定（只看头部有没有 doctype/<html>/块级标签）：片段式或非标准写法可能被误判，以源码视图为准",
      evidence: evidenceBase, degradation: null,
      remedy: { summary: "按源码看，或确认扩展名与实际内容是否对得上。", steps: ["用「编辑源码」确认内容", "若确实是 HTML 片段，可先补 `<html><body>` 外壳再预览", "若扩展名是 .html 但内容是别的格式，先改正文件"] }, test: HTML_TEST + "非 HTML 与编码异常",
    })
    return { target: "preview", label: "预览页面", row, wording: environmentRowWording(row), disposition: "unusable", limits, action: action(false) }
  }

  // ② 超过原生完整读取上限。
  if (size !== null && size > NATIVE_FULL_READ_LIMIT.bytes) {
    const row = htmlRow({
      id: "html.preview", label: "页面预览", status: "missing", state: "exceeds-native-limit",
      reading: `${humanBytes(size)} > 原生完整读取/打包上限 ${humanBytes(NATIVE_FULL_READ_LIMIT.bytes)}（${NATIVE_FULL_READ_LIMIT.source}）`,
      impact: "这一份不做完整载入，产品内预览打不开整页；**这与编辑器 4MB 上限是两回事**，别混着说。",
      evidence: [...evidenceBase, NATIVE_FULL_READ_LIMIT.scope], degradation: PREVIEW_FALLBACK,
      remedy: {
        summary: "这一份太大：切片/压缩，或直接用系统浏览器或本地静态服务打开。",
        steps: ["确认它是不是单文件内嵌版（内嵌视频/图片会把体积顶上去）", "拆成「轻量入口页 + 外部素材」形态（素材由静态服务提供）", "或压到 32MiB 以内再走产品内预览"],
      }, test: HTML_TEST + "大文件：两个上限分别判",
    })
    return { target: "preview", label: "预览页面", row, wording: environmentRowWording(row), disposition: htmlDispositionOf(row), limits, action: action(false) }
  }

  // ②.5 `<base href>` 指向的服务不是我们配置的那个：页面会去取别的地址，配错服务也修不好。
  const configuredOrigin = safeOrigin(facts.assetServer.origin ?? "")
  if (facts.baseHref !== null && facts.baseOrigin !== null && configuredOrigin !== null && facts.baseOrigin !== configuredOrigin) {
    const row = htmlRow({
      id: "html.preview", label: "页面预览", status: "degraded", state: "base-origin-mismatch",
      reading: `页面里写着 <base href="${facts.baseHref}">（${facts.baseOrigin}），而配置的素材服务是 ${configuredOrigin}`,
      impact: "页面会按 `<base>` 去取素材：**服务配得再对也没用**，因为请求根本没打到它那里。",
      evidence: [...evidenceBase, `base=${facts.baseHref}`, `素材服务 origin=${facts.assetServer.origin ?? "未配置"}`],
      degradation: { path: "只看能取到的那部分（多数素材会 404/连不上）", active: true, restore: "把 `<base href>` 改成素材服务的 origin，或让素材服务绑到 base 指向的 origin" },
      remedy: {
        summary: "让 `<base href>` 与素材服务指向同一个 origin（二者取其一改）。",
        steps: ["首选：改 HTML 的 `<base href>` 指向当前素材服务", "或让素材服务监听 base 指定的 origin/端口", "改完重探服务并重开预览"],
      }, test: HTML_TEST + "带素材：服务与存在性",
    })
    return { target: "preview", label: "预览页面", row, wording: environmentRowWording(row), disposition: htmlDispositionOf(row), limits, action: action(true) }
  }

  // ③ 素材：服务不到 / 文件不存在 / 远端离线 —— 都会让页面"有洞"，必须逐条说清。
  if (unserved.length > 0) {
    const row = htmlRow({
      id: "html.preview", label: "页面预览", status: "missing", state: "assets-unserved",
      reading: `${uniqueRaw(unserved).length} 个相对素材落在素材服务根之外（${facts.assetServer.root ?? "未配置根"}）：${uniqueRaw(unserved).slice(0, 3).join("、")}${uniqueRaw(unserved).length > 3 ? "…" : ""}`,
      impact: "这些图片/视频**不会被服务到**：页面能开，但会缺图缺视频（不是“页面损坏”，是服务根配错了）。",
      evidence: [...evidenceBase, ...unserved.map(ref => `${ref.raw} → ${ref.resolvedPath ?? "未解析"}`)],
      degradation: { path: "只显示能服务到的内容", active: true, restore: "把服务根指到页面所在目录（或把素材移进服务根）后重开预览" },
      remedy: { summary: "把静态素材服务的根指向页面所在目录。", steps: ["服务根 = 页面目录（同源、只读）", "或把 `../` 越界的素材复制进服务根", "重探服务后再打开预览"] }, test: HTML_TEST + "带素材：服务与存在性",
    })
    return { target: "preview", label: "预览页面", row, wording: environmentRowWording(row), disposition: htmlDispositionOf(row), limits, action: action(true) }
  }

  if (missing.length > 0) {
    // 缺件的**依据不同，话就不能一样**：本地文件系统说"没有"与服务端说"404"是两件事
    // （前者：文件不在那棵树上；后者：浏览器要取的那个 URL 服务端回 404）。
    const localMissing = missing.filter(ref => ref.existenceBasis !== "served-http")
    const servedMissing = missing.filter(ref => ref.existenceBasis === "served-http")
    const list = `${uniqueRaw(missing).slice(0, 3).join("、")}${uniqueRaw(missing).length > 3 ? "…" : ""}`
    const reading = servedMissing.length === 0
      ? `${uniqueRaw(missing).length} 个相对素材在本机不存在（合计 ${missing.length} 处引用）：${list}`
      : localMissing.length === 0
        ? `${uniqueRaw(missing).length} 个相对素材在素材服务上**取不到**（服务端 HTTP 404/410，合计 ${missing.length} 处引用）：${list}`
        : `${uniqueRaw(missing).length} 个相对素材取不到（本机不存在 ${localMissing.length} 个 ／ 服务端 404/410 ${servedMissing.length} 个；合计 ${missing.length} 处引用）：${list}`
    const impact = servedMissing.length === 0
      ? "页面会缺这些素材（服务再好也补不上）——用户看到的空洞有**明确原因**，不是静默留空。"
      : localMissing.length === 0
        ? "页面会缺这些素材：**服务端已经在回答“没有这一份”**（404/410）——文件不在服务根里，或路径不对；服务本身没问题。"
        : "页面会缺这些素材：一部分本机就没有（服务再好也补不上），另一部分服务端对**浏览器要取的那个 URL** 回了 404/410（不在服务根里或路径不对）。"
    const row = htmlRow({
      id: "html.preview", label: "页面预览", status: "degraded", state: "assets-missing",
      reading, impact,
      evidence: [...evidenceBase, ...[...new Map(missing.map(ref => [ref.raw, ref])).values()].map(ref => ref.existenceBasis === "served-http"
        ? `${ref.raw} → 服务端 HTTP ${ref.servedStatus ?? "无响应"}（${ref.servedUrl ?? "未解析"}）`
        : `${ref.raw} → ${ref.resolvedPath ?? "未解析"}（不存在）`)],
      degradation: { path: "其余素材照常加载，缺失项位置为空洞", active: true, restore: "补回缺失文件（或改指向存在的素材）后重开预览" },
      remedy: { summary: "补齐缺失素材或修正引用路径。", steps: ["按上面的清单逐个确认（路径大小写、中文名、扩展名）", "素材在别处时：移进服务根，或改 HTML 里的相对路径", "重开预览复核"] }, test: HTML_TEST + "带素材：服务与存在性",
    })
    return { target: "preview", label: "预览页面", row, wording: environmentRowWording(row), disposition: htmlDispositionOf(row), limits, action: action(true) }
  }

  if (relative.length > 0 && serviceState.reachable !== true) {
    const neverProbed = serviceState.reachable === null
    const row = htmlRow({
      id: "html.preview", label: "页面预览", status: neverProbed ? "unknown" : "degraded", state: neverProbed ? "service-unprobed" : "service-down",
      reading: neverProbed
        ? `这一页有 ${relative.length} 个相对素材，但静态素材服务**还没探测过**：${serviceState.detail}`
        : `这一页有 ${relative.length} 个相对素材，但静态素材服务不可达：${serviceState.origin ?? "未配置"}（${serviceState.detail}）`,
      impact: `相对素材（${counts.byKind}）加载不了：页面能开但有洞，视频/音频更需要 Range 才能真正起播。`,
      evidence: [...evidenceBase, `素材服务：${serviceState.kind} origin=${serviceState.origin ?? "无"} root=${serviceState.root ?? "无"} reachable=${String(serviceState.reachable)} range=${String(serviceState.rangeSupported)}`],
      degradation: { path: "只看页面结构与文案（相对素材不加载：图片/视频位置为空洞）", active: !neverProbed, restore: "让静态素材服务可达（同源、只读、支持 Range）后重开预览" },
      remedy: {
        summary: "给这一页配一个本机只读静态素材服务，再打开预览。",
        steps: [
          "首选：宿主提供同源只读路由（不要再加一个端口、也不要 --allow-file-access）",
          "兜底：本机静态服务绑定 127.0.0.1:44139，根 = 页面所在目录，响应带 `Accept-Ranges: bytes`",
          `复核可达性与 Range：\`curl -sSI -H 'Range: bytes=0-0' ${serviceState.origin ?? "http://127.0.0.1:44139"}/<任一素材>\` → 期望 **206**`,
          "**软件重开后必须重新探测**：服务是独立进程，重启后不一定还在",
        ],
      }, test: HTML_TEST + "带素材：服务与存在性",
    })
    return { target: "preview", label: "预览页面", row, wording: environmentRowWording(row), disposition: htmlDispositionOf(row), limits, action: action(true) }
  }

  if (relative.length > 0 && serviceState.rangeSupported === false && rangeRequired) {
    const row = htmlRow({
      id: "html.preview", label: "页面预览", status: "degraded", state: "no-range",
      reading: `静态素材服务可达但不支持 Range（${serviceState.origin}）：${serviceState.detail}`,
      impact: "图片能显示，但视频只有起播/拖动才会暴露问题——不实测就报“预览成功”是不诚实的。",
      evidence: [...evidenceBase, `素材服务 Range 探测：${String(serviceState.rangeSupported)}`],
      degradation: { path: "图片与静态内容正常；视频可能无法起播或无法拖动进度", active: true, restore: "让服务对媒体返回 206/`Accept-Ranges: bytes`" },
      remedy: { summary: "给媒体加 Range 支持（206），再加 `Accept-Ranges: bytes`。", steps: ["复核：`curl -sSI -H 'Range: bytes=0-0' <素材 URL>` → 期望 206", "服务端实现对 `Range: bytes=a-b` 返回 206 与 `Content-Range`", "重探后再打开预览"] }, test: HTML_TEST + "带素材：服务与存在性",
    })
    return { target: "preview", label: "预览页面", row, wording: environmentRowWording(row), disposition: htmlDispositionOf(row), limits, action: action(true) }
  }

  if (remote.length > 0) {
    const networkRow = networkAssessment(facts)
    if (networkRow !== null) {
      const row = htmlRow({
        id: "html.preview", label: "页面预览", status: networkRow.status, state: networkRow.state,
        reading: `这一页有 ${remote.length} 个外部引用，且${networkRow.reading}`,
        impact: "外部素材/脚本取不到时页面会缺件或脚本报错；页面本身仍可打开。",
        evidence: [...evidenceBase, ...networkRow.evidence], degradation: networkRow.degradation, remedy: networkRow.remedy, test: HTML_TEST + "远端素材：复用环境契约",
      })
      return { target: "preview", label: "预览页面", row, wording: environmentRowWording(row), disposition: htmlDispositionOf(row), limits, action: action(true) }
    }
  }

  // ④ 全部就绪：把"扫到哪"如实带上（大文件只扫了窗口，不许据此断言"全文就这些引用"）。
  const navigationRefs = facts.assets.filter(ref => ref.kind === "document" && SERVED_FORMS.has(ref.form))
  const brokenLinks = uniqueRaw(navigationRefs.filter(ref => ref.exists === false))
  const linkNote = brokenLinks.length === 0
    ? ""
    : `；另有 ${brokenLinks.length} 个相对链接指向不存在的文件（页面照常，点开才会 404）：${brokenLinks.slice(0, 3).join("、")}${brokenLinks.length > 3 ? "…" : ""}`
  const inlineOnly = loadRefs.every(ref => ref.form === "inline")
  const kind = loadRefs.length > 0 && inlineOnly ? "self-contained" : relative.length > 0 ? "with-assets" : "plain"
  // 就绪里的"素材在"必须是**量过**的：服务根未知时存在性可能一个都没实测到（那时不许写"素材在"）。
  const existenceUnproven = relative.filter(ref => ref.exists === null)
  const unprovenNote = existenceUnproven.length === 0 ? "" : `；其中 ${existenceUnproven.length} 个**没做存在性实测**（服务可达 ≠ 每一件都在）`
  const windowNote = facts.scanTruncated
    ? `；**只扫了前 ${humanBytes(HTML_SCAN_WINDOW_BYTES)}**（文件更大，未扫全文）——“没有外部素材引用”只是**这一窗口内**的读数`
    : ""
  const row = htmlRow({
    id: "html.preview", label: "页面预览", status: "ready", state: kind,
    reading: `${size === null ? "大小未知" : humanBytes(size)}；加载期素材 ${loadRefs.length} 个（${counts.byKind}）${unprovenNote}${windowNote}`,
    impact: (kind === "self-contained"
      ? `无：这一窗口内的加载期素材全部内嵌（${counts.inline} 处），断网与重启后都能读（单文件形态）。`
      : relative.length > 0
        ? existenceUnproven.length === 0
          ? "无：相对素材由本机静态服务提供（服务在，素材在）。"
          : "无（未逐件实测）：相对素材由本机静态服务提供；**没有**逐件核对存在性——服务可达不等于每一件都在。"
        : "无：页面没有加载期外部素材引用（导航链接不算）。") + linkNote + (facts.scanTruncated ? " 余下部分未扫，本行不作全文结论。" : ""),
    uncertain: facts.scanTruncated,
    uncertaintyNote: facts.scanTruncated
      ? `只扫了前 ${humanBytes(HTML_SCAN_WINDOW_BYTES)}（文件更大）：余下部分未扫，"没有外部素材引用"只是这一窗口内的读数`
      : null,
    evidence: [...evidenceBase, `内嵌 ${counts.inline} 处；相对 ${relative.length} 处；远端 ${remote.length} 处；导航链接 ${counts.navigation} 处`, `存在性依据：${describeExistenceBasis(relative)}`],
    degradation: null,
    remedy: {
      summary: brokenLinks.length === 0 ? "无需处置。" : "页面可预览；失效的下载/跳转链接按需补齐或改指向。",
      steps: [...(brokenLinks.length > 0 ? [`补回缺失文件或修正路径：${brokenLinks.slice(0, 3).join("、")}${brokenLinks.length > 3 ? "…" : ""}`] : []), ...(facts.scanTruncated ? [`如需全文口径：\`rg -o '(src|href)="[^"]+"' <文件>\` 扫一遍再对账`] : [])],
    },
    test: HTML_TEST + "预检四种形态",
  })
  return { target: "preview", label: "预览页面", row, wording: environmentRowWording(row), disposition: htmlDispositionOf(row), limits, action: action(true) }
}

/**
 * **加载期**素材：页面渲染/运行就要取的资源。这些才是"没有服务就会缺件"的引用。
 * `document`（`<a href>`）是导航链接——点开才需要，页面渲染不依赖它，不能算进"必须有服务"。
 */
const LOAD_KINDS: ReadonlySet<HtmlAssetKind> = new Set(["image", "video", "audio", "style", "script", "page"])
export function isLoadTimeAsset(ref: HtmlAssetRef): boolean { return LOAD_KINDS.has(ref.kind) }

/** 需要"本机素材服务"才能取到的引用形态（相对/绝对路径/同源绝对 URL/经 `<base>` 指向本机服务）。 */
export const SERVED_FORMS: ReadonlySet<HtmlAssetRef["form"]> = new Set(["relative", "absolute-path", "asset-origin", "base-served"])

export interface HtmlAssetCounts {
  inline: number; relative: number; remote: number; fragment: number; other: number
  /** 加载期素材数（渲染就要用的）。 */
  load: number
  /** 导航链接数（`<a href>`，点开才用）。 */
  navigation: number
  byKind: string
}

export function countAssets(assets: readonly HtmlAssetRef[]): HtmlAssetCounts {
  const counts = { inline: 0, relative: 0, remote: 0, fragment: 0, other: 0, load: 0, navigation: 0 }
  const kinds = new Map<HtmlAssetKind, number>()
  for (const ref of assets) {
    kinds.set(ref.kind, (kinds.get(ref.kind) ?? 0) + 1)
    if (isLoadTimeAsset(ref)) counts.load++
    else if (ref.kind === "document") counts.navigation++
    if (ref.form === "inline") counts.inline++
    else if (SERVED_FORMS.has(ref.form)) counts.relative++
    else if (ref.form === "remote" || ref.form === "protocol-relative") counts.remote++
    else if (ref.form === "fragment") counts.fragment++
    else counts.other++
  }
  const byKind = [...kinds.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => `${kind} ${count}`).join("、") || "无外部引用"
  return { ...counts, byKind }
}

/** 去重（同一素材被引用多次时，清单里只列一次；计数仍按引用次数）。 */
const uniqueRaw = (refs: readonly HtmlAssetRef[]): string[] => [...new Set(refs.map(ref => ref.raw))]

/**
 * 存在性依据的一句话读数。**"问的是谁"必须能看见**：同一条 `exists:false`，依据是"本机那棵树上没有"
 * 还是"浏览器要取的那个 URL 服务端回 404"，对用户是两件不同的事（改法也不同）。
 */
function describeExistenceBasis(refs: readonly HtmlAssetRef[]): string {
  if (refs.length === 0) return "无加载期相对素材"
  const local = refs.filter(ref => ref.existenceBasis === "local-fs").length
  const served = refs.filter(ref => ref.existenceBasis === "served-http").length
  const unproven = refs.length - local - served
  const parts: string[] = []
  if (local > 0) parts.push(`本机文件系统 ${local} 个（落点 = 已声明/已证明的服务根 + 路径）`)
  if (served > 0) parts.push(`服务端实测 ${served} 个（HTTP 状态裁决，URL = 浏览器要取的那一个）`)
  if (unproven > 0) parts.push(`未判 ${unproven} 个（服务根未知或按调用方要求未探测）`)
  return parts.join("；")
}

/** 远端素材的出网判定：优先吃环境契约的整屏，其次吃直接注入的读数；都没有就 unknown。 */
function networkAssessment(facts: HtmlPreviewFacts): { status: EnvironmentStatus; state: string; reading: string; evidence: string[]; degradation: EnvironmentDegradation | null; remedy: EnvironmentRemedy } | null {
  if (facts.environment) {
    const verdict = featureEnvironmentVerdict("asset.download", facts.environment)
    const row = facts.environment.rows.find(candidate => candidate.id === "network")
    const status: EnvironmentStatus = verdict.status === "ready" ? "ready" : verdict.status === "blocked" ? "missing" : "degraded"
    return {
      status, state: `contract:${verdict.status}`, reading: row?.reading ?? "出网能力读数缺失",
      evidence: [verdict.code ?? "环境契约：就绪", ...(row?.evidence ?? [])], degradation: row?.degradation ?? null, remedy: row?.remedy ?? { summary: "按环境就绪面板的处置", steps: [] },
    }
  }
  const report = facts.network
  if (!report) return null
  if (report.status === "ready") return null
  return {
    status: report.status === "unknown" ? "unknown" : report.status === "degraded" ? "degraded" : "missing",
    state: `report:${report.status}`, reading: report.reading, evidence: [...(report.evidence ?? [])],
    // 出网断了不等于页面打不开：页面照常开，缺的是远端素材/脚本——有替代路径（内嵌/本地），所以是降级不是"不可用"。
    degradation: {
      path: "页面能开；远端素材与脚本取不到（缺件或脚本报错）",
      active: true,
      restore: "把关键素材改成本地相对路径（由静态素材服务提供）或内嵌进 HTML，或先恢复出网",
    },
    remedy: { summary: "远端素材取不到时的处置：改用本地/内嵌素材，或先恢复出网。", steps: ["复核出网：`bun run script/doctor-env.ts`（§4/§5 两个端点）", "把关键素材改成本地相对路径（由静态服务提供）", "单文件交付版把这些素材内嵌进 HTML"] },
  }
}

function sourcePlan(facts: HtmlPreviewFacts): HtmlPathPlan {
  const limits = [checkLimit(EXTENSION_EDITOR_LIMIT, facts.sizeBytes)]
  const evidence = [`文件：${facts.path}（${facts.sizeBytes === null ? "大小未知" : humanBytes(facts.sizeBytes)}）`, EXTENSION_EDITOR_LIMIT.scope]
  const action = (enabled: boolean): HtmlPathPlan["action"] => ({ kind: "open-source", label: "编辑源码", detail: `在工作区 HTML 源码编辑器里打开 ${facts.path}`, enabled })

  if (facts.headFacts.contentType === "binary") {
    const row = htmlRow({
      id: "html.source", label: "源码编辑", status: "missing", state: "binary", reading: `不是文本 HTML（含 NUL 字节）：${facts.path}`,
      impact: "文本编辑器打不开它；页面预览同样拿不到可读内容。", evidence, degradation: null,
      remedy: { summary: "换对应类型的查看器，或先解压/转换。", steps: ["`file <路径>` 确认真实类型", "压缩件先解压", "确认扩展名与实际内容一致"] }, test: HTML_TEST + "非 HTML 与编码异常",
    })
    return { target: "source", label: "编辑源码", row, wording: environmentRowWording(row), disposition: "unusable", limits, action: action(false) }
  }
  if (facts.sizeBytes === null) {
    const row = htmlRow({
      id: "html.source", label: "源码编辑", status: "unknown", state: "size-unknown", reading: `${facts.path} 的大小未知，无法判定是否超过编辑器上限`,
      impact: "**未知不等于能编辑**：不能先打开再说，也不能假定打不开。", evidence, degradation: null,
      remedy: { summary: "先称重：`stat -c %s <路径>`（或 `ls -l`），再决定入口。", steps: ["确认文件存在且可读", "按读数对照 4,000,000 B 上限"] }, test: HTML_TEST + "小文件与未知大小",
    })
    return { target: "source", label: "编辑源码", row, wording: environmentRowWording(row), disposition: "unknown", limits, action: action(false) }
  }
  if (facts.sizeBytes > EXTENSION_EDITOR_LIMIT.bytes) {
    const row = htmlRow({
      id: "html.source", label: "源码编辑", status: "missing", state: "exceeds-editor-limit",
      reading: `${humanBytes(facts.sizeBytes)} > 扩展编辑器上限 ${humanBytes(EXTENSION_EDITOR_LIMIT.bytes)}（${EXTENSION_EDITOR_LIMIT.source}）`,
      impact: "**页面预览能用，不等于源码编辑能用**：这一份进不了扩展编辑器的整文件读取（历史上那句「文件超过4MB，请使用终端或模型的分段读取」就是这里）。",
      evidence: [...evidence, `两个上限是两回事：预览 ${humanBytes(NATIVE_FULL_READ_LIMIT.bytes)}（${facts.sizeBytes > NATIVE_FULL_READ_LIMIT.bytes ? "也已超过" : "未超过"}）／编辑器 ${humanBytes(EXTENSION_EDITOR_LIMIT.bytes)}（已超过）`],
      degradation: SOURCE_FALLBACK,
      remedy: {
        summary: "这份太大，编辑器整文件载入不了：用分段读取改写，或先拆小。",
        steps: ["分段看：`sed -n '1,200p' <路径>`；按需推进", "定位再改：`rg -n \"关键词\" <路径>` 后只读该段", "真要整篇编辑：拆成多个小文件，或外链素材/媒体后再编辑"],
      }, test: HTML_TEST + "大文件：两个上限分别判",
    })
    return { target: "source", label: "编辑源码", row, wording: environmentRowWording(row), disposition: htmlDispositionOf(row), limits, action: action(false) }
  }
  const row = htmlRow({
    id: "html.source", label: "源码编辑", status: "ready", state: "within-editor-limit",
    reading: `${humanBytes(facts.sizeBytes)} ≤ 编辑器上限 ${humanBytes(EXTENSION_EDITOR_LIMIT.bytes)}`,
    impact: "无：可以整文件载入编辑器。", evidence, degradation: null,
    remedy: { summary: "无需处置。", steps: facts.headFacts.encoding.bom ? [`文件带 ${facts.headFacts.encoding.bom} BOM：保存时保持编码，避免首行多出不可见字符`] : [] },
    test: HTML_TEST + "小文件与未知大小",
  })
  return { target: "source", label: "编辑源码", row, wording: environmentRowWording(row), disposition: htmlDispositionOf(row), limits, action: action(true) }
}

function assetServicePlan(facts: HtmlPreviewFacts): HtmlAssetServicePlan {
  // 只有**加载期**素材需要服务：`<a href="source/x.md">` 这类导航链接点开才用，不算"必须有服务"。
  const relative = facts.assets.filter(ref => isLoadTimeAsset(ref) && SERVED_FORMS.has(ref.form))
  const outsideRoot = uniqueRaw(relative.filter(ref => ref.withinServiceRoot === false))
  const missing = uniqueRaw(relative.filter(ref => ref.exists === false))
  const navigationRefs = facts.assets.filter(ref => ref.kind === "document" && SERVED_FORMS.has(ref.form))
  const brokenLinks = uniqueRaw(navigationRefs.filter(ref => ref.exists === false))
  const navigationLinks = navigationRefs.length
  const rangeRequired = facts.assets.some(ref => isLoadTimeAsset(ref) && (ref.kind === "video" || ref.kind === "audio"))
  const server = facts.assetServer
  const required = relative.length > 0
  const rootKnown = facts.serviceRootKnown
  const root = rootKnown ? server.root ?? (facts.pageDir === "" ? null : facts.pageDir) : null
  const checks = [
    `只监听回环：origin 必须是 127.0.0.1/localhost（当前：${server.origin ?? "未配置"}）`,
    rootKnown
      ? `根 = 页面所在目录（当前：${root}）`
      // 服务根未知时说"当前根 = 页面目录"就是**替用户断言了一棵没量过的树** —— 这正是
      // BASE-SERVED-ROOT-MISMATCH 里"缺件"判错的来源，所以这里如实报未知，并说清存在性改问谁。
      : `服务根**未确定**：只知道 origin=${server.origin ?? "未配置"}，本机没有它对应的目录读数 —— **不能假定"根 = 页面所在目录"**（页面目录 ${facts.pageDir} 与它不一定是同一棵）；这一页的素材存在性按**服务端实测**判（问的就是浏览器要取的那个 URL）`,
    facts.baseHref === null
      ? "页面没有 `<base href>`：相对引用按页面目录解析（服务根 = 页面目录即可）"
      : `页面里的 <base href>=${facts.baseHref} ：素材服务必须与它同源，否则请求打不到服务上`,
    `媒体要 Range：\`curl -sSI -H 'Range: bytes=0-0' <素材 URL>\` → 期望 **206** + \`Accept-Ranges: bytes\``,
    `只读：服务不得接受写请求；路径不得越出服务根`,
  ]
  if (!required) {
    const row = htmlRow({
      id: "html.asset-service", label: "静态素材服务", status: "ready", state: "not-needed",
      reading: `这一页不需要外部素材服务（加载期引用全部内嵌/页内${navigationLinks > 0 ? `；另有 ${navigationLinks} 个相对**链接**，点开时才需要服务` : ""}）`,
      impact: "无：单文件形态，断网与重启后都能读。",
      evidence: [`引用统计：内嵌 ${facts.assets.filter(ref => ref.form === "inline").length} 处；相对加载期 ${relative.length} 处；相对链接 ${navigationLinks} 处`], degradation: null,
      remedy: { summary: "无需处置。", steps: [] }, test: HTML_TEST + "单文件形态",
    })
    return { required, kind: "none", origin: server.origin, root: null, rootKnown, rangeRequired: false, state: "ready", row, wording: environmentRowWording(row), checks, recheck: { what: "不需要素材服务", how: "无需探测", expect: "文件自带素材" }, outsideRoot, missing, brokenLinks }
  }
  const configuredOrigin = safeOrigin(server.origin ?? "")
  const baseMismatch = facts.baseOrigin !== null && configuredOrigin !== null && facts.baseOrigin !== configuredOrigin
  const baseUnconfigured = facts.baseOrigin !== null && configuredOrigin === null
  // **这一页要的东西这个服务给不出来**（缺件 / 落在服务根外）⇒ 服务行不许再报 ready：
  // 同一块计划里"素材服务就绪"与"缺件"同时出现就是自相矛盾（BASE-SERVED-ROOT-MISMATCH 的判据）。
  const noRange = rangeRequired && server.rangeSupported === false
  const undeliverable = server.reachable === true && !baseMismatch && (missing.length > 0 || outsideRoot.length > 0)
  const state: EnvironmentStatus = baseMismatch ? "degraded"
    : baseUnconfigured ? "unknown"
      : server.reachable === true ? (noRange || undeliverable ? "degraded" : "ready")
        : server.reachable === false ? "missing" : "unknown"
  const stateName = baseMismatch ? "base-origin-mismatch" : baseUnconfigured ? "base-unconfigured"
    : state === "ready" ? "ready" : state === "degraded" ? (noRange ? "no-range" : "assets-undeliverable") : state === "missing" ? "down" : "unprobed"
  const undeliverableNote = !undeliverable ? "" : `｜**这一页有 ${missing.length + outsideRoot.length} 个素材这个服务给不出来**（${missing.length > 0 ? `本机/服务端没有 ${missing.length} 个` : ""}${missing.length > 0 && outsideRoot.length > 0 ? "、" : ""}${outsideRoot.length > 0 ? `落在服务根之外 ${outsideRoot.length} 个` : ""}；清单见「页面预览」行）`
  const row = htmlRow({
    id: "html.asset-service", label: "静态素材服务", status: state, state: stateName,
    reading: baseMismatch
      ? `${relative.length} 个素材由页面的 <base href> 指向 ${facts.baseOrigin}，而配置的服务是 ${configuredOrigin}｜${server.detail}`
      : baseUnconfigured
        ? `${relative.length} 个素材由页面的 <base href> 指向 ${facts.baseOrigin}，但没有配置素材服务`
        : `${relative.length} 个相对素材需要服务；${server.origin ?? "未配置 origin"}｜${server.detail}${undeliverableNote}`,
    impact: undeliverable
      ? "这几件加载不了：页面能开但它们的位置是空洞。**服务本身没问题**——缺的是文件或路径（见「页面预览」行的清单与改法）。"
      : rangeRequired
        ? "没有它（或没有 Range）时：图片可能还显示，视频起播/拖动会失败——“预览成功”就成了假话。"
        : "没有它时：页面能开但相对素材（图片/样式）不加载。",
    evidence: [`服务：kind=${server.kind} origin=${server.origin ?? "无"} root=${server.root ?? "无"} rootKnown=${String(rootKnown)} reachable=${String(server.reachable)} range=${String(server.rangeSupported)}`, ...checks],
    degradation: state === "ready" ? null
      : undeliverable
        ? { path: "缺的那几件照常取不到（其余素材正常加载）", active: true, restore: "补回缺失文件、把素材移进服务根，或修正引用路径后重开预览" }
        : { path: "不加载相对素材地看页面（缺图/缺视频）", active: server.reachable === false || baseMismatch, restore: "起服务（或让宿主提供同源只读路由）后重开预览；页面写了 <base> 时还要让服务与它同源" },
    remedy: {
      summary: undeliverable ? "补齐上面缺的素材（或修正引用路径）——服务本身不必动。" : "给这一页配本机只读静态素材服务（同源、支持 Range）。",
      steps: ["首选宿主同源只读路由；兜底 127.0.0.1:44139（根 = 页面目录）", "媒体必须支持 Range（返回 206）", "软件重开后**重新探测**：`curl -sSI -H 'Range: bytes=0-0' <素材 URL>`"],
    }, test: HTML_TEST + "带素材：服务与存在性",
  })
  // 复核命令要探一个**能证明服务活着**的 URL：拿一个刚判过"取不到"的素材去探，那条
  // `→ 期望 206` 是探不出来的（自己刚说它是 404），命令与结论就对不上了。跳过已知缺件的那几个。
  const probeable = facts.assets.filter(isLoadTimeAsset)
    .filter(ref => ref.servedUrl !== null && ref.exists !== false)
    .map(ref => ref.servedUrl as string)
  return {
    required, kind: server.kind, origin: server.origin, root, rootKnown, rangeRequired, state, row, wording: environmentRowWording(row), checks,
    recheck: {
      what: "重开后静态素材服务是否仍可达且支持 Range",
      how: `curl -sSI -H 'Range: bytes=0-0' ${probeable[0] ?? `${server.origin ?? "http://127.0.0.1:44139"}/<任一素材>`}`,
      expect: "HTTP/1.1 206 + Accept-Ranges: bytes",
    },
    outsideRoot, missing, brokenLinks,
  }
}

/**
 * 入口处置的**显式交代**（F2 的落点，DEV032 §4）。
 *
 * 病：`unknown` 行的通用话术写"既不放行、也不阻断"，而同一份计划把 `choices[].enabled` 置 false
 * ⇒ 界面**确实阻断**（按钮 disabled、点了不开）。话术与行为不符，用户读到的是相反的两句。
 * 药：那句话术属环境契约（它说的是"不凭未知读数下结论"，不替调用方承诺放不放行）；
 *     **本计划自己的入口处置必须自己说清楚** —— 在这里补一行，不动共用契约。
 */
function entryGateNotes(plans: readonly HtmlPathPlan[], choices: HtmlPreviewPlan["choices"]): string[] {
  const blocked = plans.filter(plan =>
    plan.disposition === "unknown" && choices.find(choice => choice.target === plan.target)?.enabled === false)
  if (blocked.length === 0) return []
  return ["", ...blocked.map(plan =>
    `[${plan.label}] 入口处置：**本计划对这个入口先不放行**（choices.${plan.target}.enabled=false ⇒ 界面把按钮停用；这不是"不可用"的判定）。上面那句“既不放行、也不阻断”是环境契约对**读数**的口径（它不替调用方承诺放不放行）——本入口要等读数测清楚、按新计划才恢复（未知 ≠ 不可用）。`)]
}

/**
 * **通用入口的判定核心**（纯函数）：给定文件事实，给出两条路各自独立的结论、素材服务计划与总述。
 * 同一份事实 → 同一个结果、同一个 `fingerprint`（判定不许自己在抖）。
 */
export function planHtmlPreview(facts: HtmlPreviewFacts): HtmlPreviewPlan {
  const count = countAssets(facts.assets)
  const scanNote = facts.scanTruncated
    ? `扫描：只看了前 ${humanBytes(HTML_SCAN_WINDOW_BYTES)}（文件更大）——**未扫全文**，引用统计可能不全`
    : `扫描：全文（≤ ${humanBytes(HTML_SCAN_WINDOW_BYTES)} 窗口）`
  const preview = previewPlan(facts, scanNote)
  const source = sourcePlan(facts)
  const assetService = assetServicePlan(facts)
  const usable = (plan: HtmlPathPlan) => plan.disposition === "ready" || plan.disposition === "degraded"
  const choices = [preview, source].map(plan => ({ target: plan.target, label: plan.label, disposition: plan.disposition, enabled: usable(plan) }))
  const recommended: HtmlOpenTarget | null = usable(preview) ? "preview" : usable(source) ? "source" : null
  // 单文件口径只看**加载期**素材：指向 GitHub 的 `<a href>` 不该把"断网可看"判成 false。
  const selfContained = facts.assets.filter(isLoadTimeAsset).every(ref => ref.form === "inline")
  const brokenLinks = assetService.brokenLinks
  const summary = recommended === null
    ? `两个入口都用不了：预览=${preview.row.state}，源码=${source.row.state}`
    : `${recommended === "preview" ? "推荐预览页面" : "推荐编辑源码"}｜预览：${preview.row.status}/${preview.row.state}｜源码：${source.row.status}/${source.row.state}｜素材服务：${assetService.required ? assetService.state : "不需要"}${brokenLinks.length > 0 ? `｜失效链接 ${brokenLinks.length} 个` : ""}`
  const wording = [
    `[${facts.path}] 打开方式判定：${summary}`,
    "",
    ...preview.wording,
    "",
    ...source.wording,
    ...(assetService.required ? ["", ...assetService.wording] : []),
    // F2（DEV032 §4）：通用话术对 `unknown` 行说的是"既不放行、也不阻断"，而**本计划对入口是明确
    // 先不放行的**（`choices[].enabled=false` ⇒ 界面把按钮停用）。两句同时出现在一块计划里就是
    // 自相矛盾 —— 在这里把**本计划自己的入口处置**显式说出来（不动环境契约那句通用话术：它管的是别的行）。
    ...entryGateNotes([preview, source], choices),
    ...(facts.scanTruncated ? ["", `注：本次只扫了前 ${humanBytes(HTML_SCAN_WINDOW_BYTES)}，未扫全文；上面的引用统计是**下限**，不是全文结论。`] : []),
  ]
  return {
    path: facts.path,
    facts: { sizeBytes: facts.sizeBytes, scanTruncated: facts.scanTruncated, contentType: facts.headFacts.contentType, assetCounts: count, selfContained },
    preview, source, assetService, choices, recommended, summary, wording,
    fingerprint: htmlPreviewFingerprint(facts),
  }
}

// ───────────────────────── 稳定性：指纹与规范化 ─────────────────────────

/** 规范化事实：排序、去重、丢掉与判定无关的字段（时刻、探测细节）。 */
export function normalizeHtmlPreviewFacts(facts: HtmlPreviewFacts): unknown {
  const refs = facts.assets.map(ref => [ref.raw, ref.kind, ref.form, ref.attribute, ref.resolvedPath, ref.withinServiceRoot, ref.exists, ref.existenceBasis, ref.servedStatus, ref.baseResolved, ref.servedUrl].join("|")).sort()
  return {
    path: facts.path, absolutePath: facts.absolutePath, pageDir: facts.pageDir, serviceRootKnown: facts.serviceRootKnown,
    sizeBytes: facts.sizeBytes, scanTruncated: facts.scanTruncated,
    contentType: facts.headFacts.contentType, bom: facts.headFacts.encoding.bom, declared: facts.headFacts.encoding.declared,
    base: [facts.baseHref, facts.baseOrigin],
    inlineScript: facts.headFacts.hasInlineScript,
    assets: refs,
    service: [facts.assetServer.kind, facts.assetServer.origin, facts.assetServer.root, facts.assetServer.reachable, facts.assetServer.rangeSupported],
    network: facts.network === undefined ? null : [facts.network.status, facts.network.reading],
    environment: facts.environment === undefined ? null : [facts.environment.overall, facts.environment.unknown.join(","), facts.environment.rows.filter(row => row.id === "network").map(row => `${row.status}/${row.state}`).join(",")],
  }
}

/**
 * 稳定指纹（FNV-1a 64 位，纯函数、无依赖）：同一份事实必须得到同一个值。
 * 存在意义：判定"自己在抖"时能一眼看出来（W14 的 `/dev/nvidia-caps` 就是这么被抓到的）。
 */
export function htmlPreviewFingerprint(facts: HtmlPreviewFacts): string {
  const text = JSON.stringify(normalizeHtmlPreviewFacts(facts))
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = (hash * prime) & mask
  }
  return `html-preview:${hash.toString(16).padStart(16, "0")}`
}

// ───────────────────────── 通用入口（宿主侧；客户端不要引用） ─────────────────────────

export interface HtmlOpenRequest {
  /** 文件路径（绝对或相对 cwd）。 */
  filePath: string
  /** 展示用路径（缺省用入参原样）。 */
  displayPath?: string
  /**
   * 素材服务的根（**声明**：宿主知道服务根在哪时给）。
   * 不给 ⇒ 本模块不假定"根 = 页面目录"：若只知道 origin，存在性改由服务端实测回答
   * （`<base href>` 指向的服务，根可能完全是另一棵树）。
   */
  serviceRoot?: string | null
  /**
   * 素材服务：给了具体配置就探它；给 `"auto"` 则由本模块自己决定探谁——
   * 显式 `previewOrigin`（宿主从环境变量读）优先，否则用页面 `<base href>` 里的**回环** origin，
   * 都没有就如实报"未配置/不需要"。宿主不需要自己判断，判据仍只有这一份。
   */
  assetServer?: { kind: AssetServiceKind; origin: string; root?: string | null } | "auto"
  /** 显式配置的素材服务 origin（例如 `LYAPUNOV_HTML_PREVIEW_ORIGIN`）。 */
  previewOrigin?: string | null
  environment?: EnvironmentPanel
  network?: EnvironmentReport
  probe?: AssetServerProbeDeps & { enabled?: boolean }
}

/**
 * 所有调用方共用的**一个**入口：预检 → （可选）实测素材服务 → 判定。
 * 现在用它的是原生工作区标签；后续任何新入口（模型工具、CLI、编排）都调这一个，不各写一套。
 */
export async function planHtmlOpen(request: HtmlOpenRequest): Promise<HtmlPreviewPlan> {
  const configured = request.assetServer
  // ① 先按"没有服务"预检一次：拿大小/头部/`<base>`/引用——它决定探哪个 origin、探哪个素材。
  const bare = probeHtmlPreviewFacts({
    filePath: request.filePath, displayPath: request.displayPath, serviceRoot: request.serviceRoot,
    environment: request.environment, network: request.network,
  })
  if (configured === undefined) return planHtmlPreview(bare)
  const explicit = request.previewOrigin?.trim()
  const origin = configured === "auto"
    ? (explicit !== undefined && explicit !== "" ? explicit : bare.baseOrigin !== null && isLoopbackOrigin(bare.baseOrigin) ? bare.baseOrigin : null)
    : configured.origin.trim() === "" ? null : configured.origin
  const kind: AssetServiceKind = configured === "auto" ? "static-service" : configured.kind
  // **服务根只认两种来源**：调用方明确给的（`serviceRoot` / `configured.root`），或下面实测证明过的。
  // 页面所在目录**不是**候选：`<base href>` 指向的那个服务，根可能完全是另一棵树
  // （BASE-SERVED-ROOT-MISMATCH：拿页面目录顶替 ⇒ 存在性问错根 ⇒ 计划块一边报"服务 ready"一边报"缺件"）。
  const declaredRoot = configured === "auto"
    ? request.serviceRoot ?? null
    : configured.root ?? request.serviceRoot ?? null
  // ② 先找挂载点（页面目录不一定就是服务根），再按**真实素材 URL** 探 Range——
  //    探服务根（目录）会得到假读数，本机实测：支持 Range 的真服务因此被判成"不支持"。
  const discovered = origin === null || request.probe?.enabled === false
    ? { url: null, root: declaredRoot, tried: [] as string[] }
    : await discoverAssetUrl(origin, bare, declaredRoot, request.probe ?? {})
  const mountRoot = discovered.root ?? declaredRoot
  const rootKnown = mountRoot !== null
  const probePath = discovered.url !== null ? new URL(discovered.url).pathname : firstAssetPath(bare, mountRoot ?? bare.pageDir)
  let probed: HtmlAssetServerState
  if (origin === null) probed = UNPROBED_ASSET_SERVER
  else if (request.probe?.enabled === false) probed = { ...UNPROBED_ASSET_SERVER, kind, origin, root: mountRoot, detail: "已配置但按调用方要求未探测" }
  else {
    const state = await probeAssetServer(origin, { ...(request.probe ?? {}), probePath })
    probed = {
      ...state, kind, root: mountRoot,
      detail: (discovered.url === null
        ? `${state.detail}｜未能在该 origin 上定位到页面素材（试过 ${discovered.tried.length} 个候选路径：${discovered.tried.join("、")}）——Range 读数不完整`
        : state.detail) + (rootKnown ? "" : `｜**服务根未确定**：本机没有 ${origin} 对应的目录读数，这一页的素材存在性按服务端实测判（不拿页面目录顶替）`),
    }
  }
  const probeFacts = (serviceRoot: string | null, servedExistence?: ReadonlyMap<string, ServedExistenceReading>): HtmlPreviewFacts => probeHtmlPreviewFacts({
    filePath: request.filePath, displayPath: request.displayPath, serviceRoot,
    assetServer: probed, environment: request.environment, network: request.network, servedExistence,
  })
  // ③ 带着服务状态再预检一次：引用的形态（同源/base-served）、存在性、落点都按"有服务"判。
  //    服务根已知 ⇒ 用**发现出来的那个**（否则复核命令里的素材 URL 会 404），本地文件系统判存在性。
  const pre = origin === null ? bare : probeFacts(mountRoot)
  // ④ 服务根未知 ⇒ 本地落点不是浏览器会去问的那棵树：**改问服务端**（GET 的 URL 与浏览器逐个相同），
  //    拿 HTTP 状态裁决存在性；没探到的如实留"未判"，绝不写成"缺件"。
  const servedExistence = origin !== null && !rootKnown && request.probe?.enabled !== false
    ? await probeServedExistence(pre.assets, origin, request.probe ?? {})
    : undefined
  const facts = servedExistence === undefined || servedExistence.size === 0 ? pre : probeFacts(null, servedExistence)
  return planHtmlPreview(facts)
}

