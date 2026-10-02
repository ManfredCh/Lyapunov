/**
 * Poly Haven CC0 贴图的最薄适配器。
 *
 * 为什么是"适配器"而不是平台：官方那个建筑 case 的贴图就来自 Poly Haven，而我们的
 * 缺口只是"模型拿不到可用的 PBR 贴图文件"。所以这里**不新建资源库、不新建索引、不新建缓存层**：
 * 查询 → 看真实候选 → 下载/复用一套到指定目录 → 写一份清单（含许可与作者）。文件落在调用方
 * 给的目录里，谁用谁负责，产品不持有第二个资产账本（合同 §2.5「不要新建 resources 平台」）。
 *
 * 许可：Poly Haven 免费素材为 **CC0**（public domain），署名非强制但这里仍逐条记录作者，
 * 便于审计来源；官方列表里标了 `prepaid`（付费/抢先体验）的素材**只出现在候选里，不下载**。
 *
 * 只依赖 node 内置 fetch；离线或接口不可用时**如实失败并说明**，不做本地替身、不把"没匹配"
 * 报成成功、不把缺图的一套说成完整 PBR。
 *
 * 官方字段按本仓缓存的一次真实列表返回核对过（862 条纹理的 `/assets?t=textures` 快照：
 * `.runtime/probe/archi-tiananmen/workspace/analysis/v4/ph_textures.json`）。只使用其中出现过的
 * `name / tags / categories / category / authors / max_resolution / dimensions / thumbnail_url /
 * description / download_count / date_published / prepaid`；快照里没有的字段不凭空假设。
 * `/files/{id}` 沿用既有实现用过的 `贴图名 → 分辨率 → jpg/png → url` 形状（`size`/`md5` 若接口
 * 给了就用，不假设一定有）。
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

const API = "https://api.polyhaven.com"
/** 只取 1k：建筑可视化在 1280×720–1920×1080 下够用，且单套约几 MB，不把 GB 级资产塞进运行根。 */
const DEFAULT_RESOLUTION: TextureResolution = "1k"
/** 一套贴图里我们真正会用的图：颜色、法线、粗糙度、环境光遮蔽。 */
const MAPS = ["Diffuse", "nor_gl", "Rough", "AO"] as const
/** 网络与体积上限默认值：够下 4k 一套，又挡住异常大文件和挂死的连接。 */
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_SET_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_CATALOG_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_THUMB_BYTES = 4 * 1024 * 1024
const DEFAULT_CANDIDATE_LIMIT = 8
const MANIFEST_SUFFIX = ".manifest.json"

export type TextureResolution = "1k" | "2k" | "4k" | "8k"
const RESOLUTION_PIXELS: Record<TextureResolution, number> = { "1k": 1024, "2k": 2048, "4k": 4096, "8k": 8192 }
const RESOLUTIONS = Object.keys(RESOLUTION_PIXELS) as TextureResolution[]

/** 官方 `/assets?t=textures` 单条记录里我们真正读取的字段（按缓存快照，不假设其他字段）。 */
interface CatalogEntry {
  name?: string
  tags?: string[]
  categories?: string[]
  category?: string
  authors?: Record<string, string>
  max_resolution?: number[]
  dimensions?: number[]
  thumbnail_url?: string
  description?: string
  download_count?: number
  date_published?: number
  prepaid?: boolean
}

/** 官方 `/files/{id}` 里一张图在一个分辨率档下的可下载形式。 */
interface FileVariant { url?: string; size?: number; md5?: string }
interface FilesPayload { [map: string]: { [resolution: string]: { jpg?: FileVariant; png?: FileVariant } } }

export interface TextureCandidate {
  /** Poly Haven 资产 id（稳定标识）。 */
  assetId: string
  name: string
  authors: string[]
  /** 非 prepaid 的 Poly Haven 素材是 CC0-1.0；prepaid 素材的许可不由本适配器断言。 */
  license: "CC0-1.0" | "unknown"
  source: string
  /** 命中该候选的检索词（可解释：为什么是它）。 */
  matchedTerms: string[]
  score: number
  /** 其中命中了 id/名称（比只命中标签更具体）的词数，参与排序。 */
  nameMatches: number
  categories: string[]
  tags: string[]
  /** 官方 metadata 的预览图 URL（真实字段 `thumbnail_url`，不编造）。 */
  thumbnailUrl?: string
  category?: string
  description?: string
  maxResolution?: number[]
  /** 官方 metadata 里这张贴图在现实中覆盖的尺寸（米）。 */
  dimensions?: number[]
  downloadCount?: number
  publishedAt?: string
  /** true = 付费/抢先体验素材：只列候选，不下载。 */
  prepaid: boolean
  /** 真下过预览图时给本地路径（options.thumbnails）。 */
  thumbnailPath?: string
  thumbnailError?: string
}

export interface QueryExplanation {
  original: string
  /** 实际用于检索的英文词。 */
  terms: string[]
  /** 命中的中文词 → 检索词（词表在源码里，未收录的词不会瞎猜）。 */
  mapped: Array<{ zh: string; en: string[] }>
  /** 未收录、被丢弃的中文片段；非空说明检索不完整。 */
  unmapped: string[]
}

export interface TextureSet {
  /** Poly Haven 资产 id（稳定标识）。 */
  assetId: string
  name: string
  authors: string[]
  license: "CC0-1.0"
  source: string
  /** 逻辑贴图名 → 磁盘路径（只含实际存在/下载成功的）。 */
  maps: Record<string, string>
  missingMaps: string[]
  totalBytes: number
  /** 本套的实际分辨率与逐图字节数（老清单没有这两个字段，读取时按文件名推断）。 */
  resolution: TextureResolution
  fileBytes: Record<string, number>
  /** 逐图失败原因（HTTP/超时/超限）；缺图时不冒充完整 PBR。 */
  mapErrors: Record<string, string>
  /** 四张约定贴图齐了才为 true。 */
  complete: boolean
  /** 本次实际使用的查询与中文词的本地映射结果（可解释）。 */
  query?: QueryExplanation
  /** 参与本次选择的真实候选（第一名之外也列出），要换一套就用 options.assetId 再来。 */
  candidates: TextureCandidate[]
  selected: { assetId: string; reason: "explicit" | "local-manifest" | "highest-score"; matchedTerms: string[]; score: number }
  /** true = 直接用了本地已有清单与文件，没有联网。 */
  reused: boolean
}

export interface TextureOptions {
  /** 明确指定官方素材 id，跳过关键词打分（query 可为空）。 */
  assetId?: string
  /** 分辨率档，默认 1k。 */
  resolution?: TextureResolution
  /** 原生取消信号：贯穿列表、文件清单、每张图与预览图的下载。 */
  signal?: AbortSignal
  /** 默认 true：目标目录里有**有效**清单且文件在，就直接复用，不联网。 */
  reuse?: boolean
  /** 候选列表长度上限，默认 8。 */
  limit?: number
  /** 单次请求超时（毫秒），默认 20000。 */
  timeoutMs?: number
  maxFileBytes?: number
  maxSetBytes?: number
  maxCatalogBytes?: number
  /** 下载候选预览图（默认 false，不改变旧调用的网络行为）。 */
  thumbnails?: boolean
  /** 预览图落盘目录；thumbnails=true 时必填。 */
  thumbnailDirectory?: string
  /** 接口根地址。默认官方 `https://api.polyhaven.com`；仅供测试或自建镜像注入。 */
  apiBase?: string
}

interface Settings {
  assetId?: string
  resolution: TextureResolution
  signal?: AbortSignal
  reuse: boolean
  limit: number
  timeoutMs: number
  maxFileBytes: number
  maxSetBytes: number
  maxCatalogBytes: number
  thumbnails: boolean
  thumbnailDirectory?: string
  apiBase: string
}

/**
 * 中文常见材料词 → 英文检索词。**只做本地、可解释的映射**（不调用第二个 LLM）：
 * 查到什么词、给出什么检索词都会记进结果与错误里；没收录的中文由调用方（原生 Agent）
 * 自己翻译后再来，或直接用 options.assetId 指定素材。
 */
const ZH_MATERIAL_TERMS: Record<string, string[]> = {
  // 木材
  木板: ["wood", "planks"], 木地板: ["wood", "floor"], 木料: ["wood"], 木材: ["wood"], 木头: ["wood"],
  木: ["wood"], 橡木: ["oak"], 松木: ["pine"], 桦木: ["birch"], 胡桃木: ["walnut"], 树皮: ["bark"],
  // 砖石
  红砖: ["brick", "red"], 砖墙: ["brick", "wall"], 砖: ["brick"],
  花岗岩: ["granite"], 大理石: ["marble"], 石灰石: ["limestone"], 砂岩: ["sandstone"], 板岩: ["slate"],
  鹅卵石: ["cobblestone"], 碎石: ["gravel"], 石材: ["stone"], 石头: ["stone"], 石: ["stone"],
  // 地砖、屋面与砌体
  瓷砖: ["tile"], 地砖: ["tile", "floor"], 面砖: ["tile"], 瓦片: ["tiles"], 屋顶瓦: ["roof", "tiles"],
  陶瓦: ["clay", "roof"], 瓦: ["roof", "tiles"],
  混凝土: ["concrete"], 水泥: ["cement"], 灰泥: ["plaster"], 抹灰: ["plaster"], 石膏: ["plaster"],
  墙面: ["wall", "plaster"], 墙: ["wall"], 地板: ["floor"], 地面: ["floor"], 屋顶: ["roof"], 屋面: ["roof"],
  // 金属与工业
  金属: ["metal"], 铁: ["iron"], 钢: ["steel"], 铜: ["copper"], 生锈: ["rust"], 锈: ["rust"],
  // 其他常见面材
  皮革: ["leather"], 织物: ["fabric"], 布料: ["fabric"], 牛仔布: ["denim"], 地毯: ["carpet"],
  壁纸: ["wallpaper"], 纸: ["paper"], 陶瓷: ["ceramic"], 塑料: ["plastic"], 玻璃: ["glass"],
  沥青: ["asphalt"], 柏油: ["asphalt"], 路面: ["pavement"], 人行道: ["pavement"],
  沙子: ["sand"], 沙地: ["sand"], 沙: ["sand"], 泥土: ["dirt"], 土壤: ["soil"], 土: ["dirt"],
  草地: ["grass"], 草坪: ["grass"], 草: ["grass"],
  // 常见修饰词（颜色/新旧）
  红色: ["red"], 红: ["red"], 白色: ["white"], 白: ["white"], 灰色: ["grey"], 灰: ["grey"],
  黑色: ["black"], 黑: ["black"], 棕色: ["brown"], 棕: ["brown"], 黄色: ["yellow"], 黄: ["yellow"],
  绿色: ["green"], 绿: ["green"], 蓝色: ["blue"], 蓝: ["blue"], 米色: ["beige"], 橙色: ["orange"],
  浅色: ["light"], 深色: ["dark"], 老旧: ["old", "weathered"], 旧: ["old", "weathered"],
  风化: ["weathered"], 磨损: ["worn"], 干净: ["clean"], 粗糙: ["rough"], 光滑: ["smooth"],
}
const MAX_ZH_KEY = Math.max(...Object.keys(ZH_MATERIAL_TERMS).map((key) => key.length))

/** 把查询拆成英文检索词，并把中文词的映射如实报出来（纯函数：不联网、不调模型）。 */
export function explainTextureQuery(query: string | undefined): QueryExplanation {
  const original = (query ?? "").trim()
  const terms: string[] = []
  const mapped: QueryExplanation["mapped"] = []
  const unmapped: string[] = []
  const add = (list: readonly string[]) => { for (const term of list) if (!terms.includes(term)) terms.push(term) }
  let index = 0
  while (index < original.length) {
    const rest = original.slice(index)
    if (!/^[㐀-鿿]/.test(rest)) {
      // 英文/数字段整段取出，再按非字母数字切开（`oak_wood_planks` 这类 id 也吃得下）。
      const run = /^[A-Za-z0-9_.-]+/.exec(rest)
      if (run) { add(run[0].toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)); index += run[0].length; continue }
      index += 1
      continue
    }
    let hit: string | undefined
    // 贪心最长匹配：先试「红砖」再试「红」，「浅色灰泥」不会退化成一堆单字。
    for (let size = Math.min(MAX_ZH_KEY, rest.length); size >= 1; size -= 1) {
      const piece = rest.slice(0, size)
      if (ZH_MATERIAL_TERMS[piece]) { hit = piece; break }
    }
    if (hit) { mapped.push({ zh: hit, en: [...ZH_MATERIAL_TERMS[hit]!] }); add(ZH_MATERIAL_TERMS[hit]!); index += hit.length }
    else { const piece = rest[0]!; if (!unmapped.includes(piece)) unmapped.push(piece); index += 1 }
  }
  return { original, terms, mapped, unmapped }
}

/**
 * 真实候选列表，排序依据全部是可解释的真实信号：
 * 命中词数降序 → 免费（prepaid 不下载，排后面）→ 名称/id 也命中的词数降序 →
 * 官方 `download_count` 降序 → id 字典序（同一份列表快照下**结果可复现**）。
 * 候选字段全部来自官方列表 metadata，不编造；`options.thumbnails` 时另把预览图落盘。
 */
export async function findTextures(query: string | undefined, options: TextureOptions = {}): Promise<TextureCandidate[]> {
  const settings = normalizeOptions(options)
  throwIfAborted(settings.signal)
  const explanation = explainTextureQuery(query)
  if (!settings.assetId) requireTerms(explanation)
  const catalog = await fetchCatalog(settings)
  const ranked = settings.assetId
    ? [candidateFromCatalog(catalog, settings.assetId)]
    : rankCandidates(catalog, explanation.terms)
  if (settings.assetId && ranked[0]!.prepaid) throw new Error(`POLYHAVEN_PREPAID_ASSET: 「${ranked[0]!.assetId}」是付费（prepaid）素材，本适配器只下载 CC0 免费素材`)
  const candidates = takeCandidates(ranked, settings)
  await attachThumbnails(candidates, settings)
  return candidates
}

/** 兼容旧调用：返回第一名**可下载**候选（付费素材不选），没有则 undefined。 */
export async function findTexture(query: string, options: TextureOptions = {}): Promise<{ assetId: string; name: string; authors: string[] } | undefined> {
  const candidate = (await findTextures(query, options)).find((item) => !item.prepaid)
  return candidate ? { assetId: candidate.assetId, name: candidate.name, authors: candidate.authors } : undefined
}

/**
 * 下载（或复用）一套贴图到 `destination`，返回清单。**逐图独立失败**：缺某张图时记进
 * `missingMaps` 并写明 `mapErrors`，而不是整套失败——颜色图最重要，法线/粗糙度缺失不该让整个
 * 建模停摆；但颜色图也缺、或四张全因网络错误失败时如实抛错，不假装拿到了一套 PBR。
 *
 * 选择是**看得见**的：query 命中的候选（名称/来源/预览/付费标记）都记进结果的 `candidates`
 * 与 `selected`，要换一套就用 `options.assetId` 再来一次，不会只按第一名悄悄下载。
 */
export async function fetchTextureSet(query: string | undefined, destination: string, options: TextureOptions = {}): Promise<TextureSet> {
  const settings = normalizeOptions(options)
  throwIfAborted(settings.signal)
  const explanation = explainTextureQuery(query)
  if (!settings.assetId) requireTerms(explanation)

  // 1) 目标目录里已有有效清单（assetId、分辨率对得上，文件真在）就直接复用，不联网。
  if (settings.reuse) {
    const local = settings.assetId
      ? (await readLocalSet(destination, settings.assetId, settings.resolution))?.set
      : await findLocalSet(destination, explanation.terms, settings.resolution)
    if (local) return decorate(local, explanation, local.candidates, { assetId: local.assetId, reason: "local-manifest", matchedTerms: explanation.terms, score: explanation.terms.length })
  }

  // 2) 联网选择候选：明确 id 优先，否则按检索词打分（付费素材只列不选）。
  const catalog = await fetchCatalog(settings)
  let ranked: TextureCandidate[]
  let selected: TextureCandidate
  let reason: TextureSet["selected"]["reason"]
  if (settings.assetId) {
    selected = candidateFromCatalog(catalog, settings.assetId)
    if (selected.prepaid) throw new Error(`POLYHAVEN_PREPAID_ASSET: 「${selected.assetId}」是付费（prepaid）素材，本适配器只下载 CC0 免费素材`)
    ranked = [selected]
    reason = "explicit"
  } else {
    ranked = rankCandidates(catalog, explanation.terms)
    selected = ranked.find((item) => !item.prepaid) ?? onlyPrepaid(ranked, explanation)
    reason = "highest-score"
  }
  const maxPixels = selected.maxResolution?.[0]
  if (maxPixels && RESOLUTION_PIXELS[settings.resolution] > maxPixels) {
    throw new Error(`POLYHAVEN_RESOLUTION_UNAVAILABLE: 「${selected.assetId}」官方最高 ${maxPixels}px，取不到 ${settings.resolution}；改用较低档或换素材`)
  }
  const candidates = takeCandidates(ranked, settings, selected)
  await attachThumbnails(candidates, settings)

  // 3) 取文件清单并逐图下载。
  const files = await requestJson(`${settings.apiBase}/files/${encodeURIComponent(selected.assetId)}`, {
    signal: settings.signal, timeoutMs: settings.timeoutMs, maxBytes: settings.maxCatalogBytes,
  }) as FilesPayload
  const payload = checkFilesPayload(files, selected.assetId)
  const availableResolutions = collectResolutions(payload)
  if (availableResolutions.length && !availableResolutions.includes(settings.resolution)) {
    throw new Error(`POLYHAVEN_RESOLUTION_UNAVAILABLE: 「${selected.assetId}」接口给出的档位是 ${availableResolutions.join("/")}，没有 ${settings.resolution}`)
  }
  await mkdir(destination, { recursive: true })
  const maps: Record<string, string> = {}
  const missingMaps: string[] = []
  const fileBytes: Record<string, number> = {}
  const mapErrors: Record<string, string> = {}
  let totalBytes = 0
  let attempted = 0
  const failures: Error[] = []
  for (const map of MAPS) {
    const entry = payload[map]?.[settings.resolution]
    // 优先 jpg（体积小），退回 png；该档缺这张图就记缺失，不阻断其他图。
    const url = entry?.jpg?.url ?? entry?.png?.url
    if (!url) { missingMaps.push(map); mapErrors[map] = `官方文件清单里没有 ${settings.resolution} 档的 ${map}`; continue }
    attempted += 1
    try {
      const bytes = await requestBytes(url, { signal: settings.signal, timeoutMs: settings.timeoutMs, maxBytes: settings.maxFileBytes })
      if (totalBytes + bytes.byteLength > settings.maxSetBytes) {
        throw new TextureLimitError(`POLYHAVEN_SET_TOO_LARGE: 一套贴图累计超过 ${settings.maxSetBytes} 字节上限（${selected.assetId} @${settings.resolution}）；降档或调大 options.maxSetBytes`)
      }
      const path = join(destination, `${selected.assetId}_${map}_${settings.resolution}.${url.endsWith(".png") ? "png" : "jpg"}`)
      await writeFile(path, bytes)
      maps[map] = path
      fileBytes[map] = bytes.byteLength
      totalBytes += bytes.byteLength
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      if (isAbort(failure) || settings.signal?.aborted) throw abortError(url)
      if (failure instanceof TextureLimitError) throw failure
      missingMaps.push(map)
      mapErrors[map] = failure.message
      failures.push(failure)
    }
  }
  if (!maps.Diffuse) {
    // 有下载尝试且全失败：报根因（网络/HTTP）；否则报"颜色图取不到"，并带上已试过的原因。
    if (attempted > 0 && failures.length === attempted) throw failures[0]
    throw new Error(`POLYHAVEN_DIFFUSE_UNAVAILABLE: 「${selected.assetId}」在 ${settings.resolution} 档没有可下载的颜色图（${Object.entries(mapErrors).map(([map, reason]) => `${map}: ${reason}`).join("；") || "清单里没有 Diffuse"}）`)
  }
  const set: TextureSet = {
    assetId: selected.assetId, name: selected.name, authors: selected.authors, license: "CC0-1.0",
    source: selected.source, maps, missingMaps, totalBytes, resolution: settings.resolution, fileBytes, mapErrors,
    complete: missingMaps.length === 0, query: explanation, candidates,
    selected: { assetId: selected.assetId, reason, matchedTerms: selected.matchedTerms, score: selected.score },
    reused: false,
  }
  await writeFile(join(destination, `${selected.assetId}${MANIFEST_SUFFIX}`), JSON.stringify(set, null, 2) + "\n")
  return set
}

/** 体积类上限用独立类型，才能在逐图 catch 里把它和"这张图网络失败"区分开。 */
class TextureLimitError extends Error {}

// ---------------------------------------------------------------------------
// 候选与检索
// ---------------------------------------------------------------------------

function normalizeOptions(options: TextureOptions): Settings {
  const resolution = options.resolution ?? DEFAULT_RESOLUTION
  if (!RESOLUTIONS.includes(resolution)) throw new Error(`POLYHAVEN_RESOLUTION_INVALID: 分辨率只能是 ${RESOLUTIONS.join("/")}，收到「${String(options.resolution)}」`)
  return {
    assetId: options.assetId,
    resolution,
    signal: options.signal,
    reuse: options.reuse !== false,
    limit: Math.max(1, Math.floor(options.limit ?? DEFAULT_CANDIDATE_LIMIT)),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxSetBytes: options.maxSetBytes ?? DEFAULT_MAX_SET_BYTES,
    maxCatalogBytes: options.maxCatalogBytes ?? DEFAULT_MAX_CATALOG_BYTES,
    thumbnails: options.thumbnails === true,
    thumbnailDirectory: options.thumbnailDirectory,
    apiBase: (options.apiBase ?? API).replace(/\/+$/, ""),
  }
}

function requireTerms(explanation: QueryExplanation): void {
  if (explanation.terms.length) return
  if (/[㐀-鿿]/.test(explanation.original)) {
    throw new Error(`POLYHAVEN_QUERY_UNTRANSLATED: 「${explanation.original}」里没有本工具收录的中文材料词（未收录：${explanation.unmapped.join("、")}）。本工具不调用第二个 LLM，请由原生 Agent 把目标翻译成英文检索词后重试（例如「浅色灰泥墙」→ "plaster wall"），或直接用 options.assetId 指定官方素材 id。`)
  }
  throw new Error("POLYHAVEN_QUERY_EMPTY: 需要检索词（或用 options.assetId 明确指定素材 id）")
}

async function fetchCatalog(settings: Settings): Promise<Record<string, CatalogEntry>> {
  const payload = await requestJson(`${settings.apiBase}/assets?t=textures`, { signal: settings.signal, timeoutMs: settings.timeoutMs, maxBytes: settings.maxCatalogBytes })
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("POLYHAVEN_CATALOG_UNREADABLE: 贴图列表返回的不是对象；接口形状变了，不猜")
  return payload as Record<string, CatalogEntry>
}

function candidateFromCatalog(catalog: Record<string, CatalogEntry>, assetId: string): TextureCandidate {
  const entry = catalog[assetId]
  if (!entry) throw new Error(`POLYHAVEN_UNKNOWN_ASSET: 官方贴图列表里没有「${assetId}」；先用 findTextures 看候选 id`)
  return toCandidate(assetId, entry, [])
}

/** 词元化：id/名称/层级分类/标签按非字母数字切开（`oak_wood_planks` → oak/wood/planks）。 */
function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/**
 * 检索词 vs 词元：**前缀匹配**（wood↔wooden、brick↔bricks、tile↔tiles 都算命中）。
 * 不用子串匹配——旧写法会把 "weath**ered**" 当成命中 "red"，让「红砖墙」排到砖墙素材后面。
 */
function matchesTerm(tokens: string[], term: string): boolean {
  const singular = term.length > 3 && term.endsWith("s") ? term.slice(0, -1) : term
  return tokens.some((token) => token.startsWith(term) || (singular !== term && token.startsWith(singular)))
}

function rankCandidates(catalog: Record<string, CatalogEntry>, terms: string[]): TextureCandidate[] {
  const ranked: TextureCandidate[] = []
  for (const [id, entry] of Object.entries(catalog)) {
    const tokens = tokenize([id, entry.name ?? "", entry.category ?? "", ...(entry.categories ?? []), ...(entry.tags ?? [])].join(" "))
    const matchedTerms = terms.filter((term) => matchesTerm(tokens, term))
    if (!matchedTerms.length) continue
    const nameTokens = tokenize(`${id} ${entry.name ?? ""}`)
    const candidate = toCandidate(id, entry, matchedTerms)
    candidate.nameMatches = matchedTerms.filter((term) => matchesTerm(nameTokens, term)).length
    ranked.push(candidate)
  }
  // 命中词数 → 可下载优先 → **名称/id 也命中**（比标签命中更具体）→ 真实下载量（官方 metadata）
  // → id 字典序。后两键解决"一大票同分"时的选择问题：真实表里「木板」有 80 条同分，只按 id
  // 会选到 bamboo_wall 这种名字里既没有 wood 也没有 planks 的素材。
  ranked.sort((a, b) =>
    b.score - a.score
    || Number(a.prepaid) - Number(b.prepaid)
    || b.nameMatches - a.nameMatches
    || (b.downloadCount ?? 0) - (a.downloadCount ?? 0)
    || (a.assetId < b.assetId ? -1 : 1))
  return ranked
}

function takeCandidates(ranked: TextureCandidate[], settings: Settings, mustInclude?: TextureCandidate): TextureCandidate[] {
  const shown = ranked.slice(0, settings.limit)
  if (mustInclude && !shown.some((item) => item.assetId === mustInclude.assetId)) shown.push(mustInclude)
  return shown
}

/** 免费候选一个都没有时说清楚：是"全是付费"还是"没匹配"，两种都不是成功。 */
function onlyPrepaid(ranked: TextureCandidate[], explanation: QueryExplanation): never {
  if (ranked.length) {
    throw new Error(`POLYHAVEN_ONLY_PREPAID_MATCHES: 匹配「${explanation.original}」的候选（${ranked.map((item) => item.assetId).join("、")}）都是付费（prepaid）素材；换更具体的词，或用 options.assetId 指定免费素材`)
  }
  throw new Error(`POLYHAVEN_NO_MATCH: 贴图库中没有匹配「${explanation.original}」的素材${explanation.unmapped.length ? `（未收录的中文：${explanation.unmapped.join("、")}）` : ""}`)
}

function toCandidate(assetId: string, entry: CatalogEntry, matchedTerms: string[]): TextureCandidate {
  const candidate: TextureCandidate = {
    assetId,
    name: entry.name ?? assetId,
    authors: Object.keys(entry.authors ?? {}),
    license: entry.prepaid === true ? "unknown" : "CC0-1.0",
    source: `https://polyhaven.com/a/${assetId}`,
    matchedTerms,
    score: matchedTerms.length,
    nameMatches: 0,
    categories: entry.categories ?? [],
    tags: entry.tags ?? [],
    prepaid: entry.prepaid === true,
  }
  if (entry.thumbnail_url) candidate.thumbnailUrl = entry.thumbnail_url
  if (entry.category) candidate.category = entry.category
  if (entry.description) candidate.description = entry.description
  if (entry.max_resolution?.length) candidate.maxResolution = entry.max_resolution
  if (entry.dimensions?.length) candidate.dimensions = entry.dimensions
  if (typeof entry.download_count === "number") candidate.downloadCount = entry.download_count
  if (typeof entry.date_published === "number") candidate.publishedAt = new Date(entry.date_published * 1000).toISOString()
  return candidate
}

/** 候选预览图：用真实 `thumbnail_url` 落盘，逐张独立失败（失败只记 `thumbnailError`）。 */
async function attachThumbnails(candidates: TextureCandidate[], settings: Settings): Promise<void> {
  if (!settings.thumbnails) return
  const directory = settings.thumbnailDirectory
  if (!directory) throw new Error("POLYHAVEN_THUMBNAIL_DIRECTORY_REQUIRED: thumbnails=true 时必须给 options.thumbnailDirectory")
  await mkdir(directory, { recursive: true })
  for (const candidate of candidates) {
    if (!candidate.thumbnailUrl) continue
    try {
      const bytes = await requestBytes(candidate.thumbnailUrl, { signal: settings.signal, timeoutMs: settings.timeoutMs, maxBytes: DEFAULT_MAX_THUMB_BYTES })
      const path = join(directory, `${candidate.assetId}.thumb.png`)
      await writeFile(path, bytes)
      candidate.thumbnailPath = path
    } catch (error) {
      if (settings.signal?.aborted) throw abortError(candidate.thumbnailUrl)
      candidate.thumbnailError = error instanceof Error ? error.message : String(error)
    }
  }
}

// ---------------------------------------------------------------------------
// 本地清单复用
// ---------------------------------------------------------------------------

interface LocalSet {
  set: TextureSet
  /** 清单里记下的检索词（新清单才有；用于"同 query 直接复用"，老清单没有就退回 id/名称判断）。 */
  recordedTerms?: string[]
}

/** 读目标目录里的清单并**按磁盘实况重建**：文件在才算数，缺图如实记，不冒充完整 PBR。 */
async function readLocalSet(destination: string, assetId: string, resolution: TextureResolution): Promise<LocalSet | undefined> {
  let parsed: Partial<TextureSet>
  try { parsed = JSON.parse(await readFile(join(destination, `${assetId}${MANIFEST_SUFFIX}`), "utf8")) as Partial<TextureSet> }
  catch { return undefined }
  if (!parsed || typeof parsed !== "object" || parsed.assetId !== assetId) return undefined
  const recorded = resolutionOf(parsed.resolution) ?? resolutionOfManifest(parsed.maps)
  if (recorded !== resolution) return undefined
  const maps: Record<string, string> = {}
  const missingMaps: string[] = []
  const fileBytes: Record<string, number> = {}
  for (const [key, value] of Object.entries(parsed.maps ?? {})) {
    const size = typeof value === "string" ? await fileSize(value) : undefined
    if (size === undefined) { missingMaps.push(key); continue }
    maps[key] = value as string
    fileBytes[key] = size
  }
  for (const map of MAPS) if (!maps[map] && !missingMaps.includes(map)) missingMaps.push(map)
  if (!maps.Diffuse) return undefined // 没有颜色图就不是可复用的一套
  const terms = parsed.query?.terms
  return {
    set: {
      assetId,
      name: typeof parsed.name === "string" && parsed.name ? parsed.name : assetId,
      authors: Array.isArray(parsed.authors) ? parsed.authors.filter((author): author is string => typeof author === "string") : [],
      license: "CC0-1.0",
      source: typeof parsed.source === "string" && parsed.source ? parsed.source : `https://polyhaven.com/a/${assetId}`,
      maps, missingMaps, fileBytes, mapErrors: {},
      totalBytes: Object.values(fileBytes).reduce((sum, size) => sum + size, 0),
      complete: missingMaps.length === 0, resolution,
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates.filter((item) => typeof item?.assetId === "string") : [],
      selected: { assetId, reason: "local-manifest", matchedTerms: [], score: 0 },
      reused: true,
    },
    recordedTerms: Array.isArray(terms) && terms.every((term) => typeof term === "string") ? terms as string[] : undefined,
  }
}

/**
 * 按 query 找本地清单。两档判定，**都不猜**：
 *  · 清单里记过当时的检索词（新清单）：**词集完全一致**才复用。检索词可能只命中 tags/categories
 *    （如"花岗岩地砖"的 floor 命中的是分类），光看 id/名称会误判成"不匹配"而白重下一遍。
 *  · 老清单没记检索词：要求**全部检索词**都出现在该套的 id/名称里，避免"看起来差不多"的复用。
 */
async function findLocalSet(destination: string, terms: string[], resolution: TextureResolution): Promise<TextureSet | undefined> {
  if (!terms.length) return undefined
  let names: string[]
  try { names = await readdir(destination) } catch { return undefined }
  for (const name of names.filter((entry) => entry.endsWith(MANIFEST_SUFFIX)).sort()) {
    const local = await readLocalSet(destination, name.slice(0, -MANIFEST_SUFFIX.length), resolution)
    if (!local) continue
    if (local.recordedTerms) {
      if (sameTerms(local.recordedTerms, terms)) return local.set
      continue
    }
    const haystack = `${local.set.assetId} ${local.set.name}`.toLowerCase()
    // 目录名已排序：取字典序最小的那套，保证可复现。
    if (terms.every((term) => haystack.includes(term))) return local.set
  }
  return undefined
}

/** 词集等价（大小写、顺序、重复都不影响）。 */
function sameTerms(left: string[], right: string[]): boolean {
  const a = new Set(left.map((term) => term.toLowerCase()))
  const b = new Set(right.map((term) => term.toLowerCase()))
  return a.size === b.size && [...a].every((term) => b.has(term))
}

function decorate(set: TextureSet, query: QueryExplanation, candidates: TextureCandidate[], selected: TextureSet["selected"]): TextureSet {
  return { ...set, query, candidates, selected, reused: true }
}

function resolutionOf(value: unknown): TextureResolution | undefined {
  return typeof value === "string" && (RESOLUTIONS as string[]).includes(value) ? value as TextureResolution : undefined
}

/** 老清单没有 resolution 字段：按文件名里的 `_1k.`/`_2k.` 推断（推断不出就不复用）。 */
function resolutionOfManifest(maps: unknown): TextureResolution | undefined {
  if (!maps || typeof maps !== "object") return undefined
  const found = new Set<TextureResolution>()
  for (const value of Object.values(maps as Record<string, unknown>)) {
    if (typeof value !== "string") continue
    for (const resolution of RESOLUTIONS) if (value.includes(`_${resolution}.`)) found.add(resolution)
  }
  return found.size === 1 ? [...found][0] : undefined
}

async function fileSize(path: string): Promise<number | undefined> {
  try { const info = await stat(path); return info.isFile() && info.size > 0 ? info.size : undefined } catch { return undefined }
}

// ---------------------------------------------------------------------------
// 网络：超时、体积上限与取消都收敛在这一层
// ---------------------------------------------------------------------------

interface RequestLimits { signal?: AbortSignal; timeoutMs: number; maxBytes: number }

async function requestJson(url: string, limits: RequestLimits): Promise<unknown> {
  const bytes = await requestBytes(url, limits)
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown }
  catch { throw new Error(`POLYHAVEN_JSON_INVALID: ${url} 返回的不是合法 JSON`) }
}

async function requestBytes(url: string, limits: RequestLimits): Promise<Uint8Array> {
  const signals: AbortSignal[] = []
  if (limits.signal) signals.push(limits.signal)
  if (limits.timeoutMs > 0) signals.push(AbortSignal.timeout(limits.timeoutMs))
  const signal = signals.length ? AbortSignal.any(signals) : undefined
  let response: Response
  try { response = await fetch(url, signal ? { signal } : {}) }
  catch (error) { throw networkError(url, error, limits) }
  if (!response.ok) throw new Error(`POLYHAVEN_HTTP_${response.status}: ${url}`)
  const declared = Number(response.headers.get("content-length") ?? Number.NaN)
  if (Number.isFinite(declared) && declared > limits.maxBytes) throw new TextureLimitError(`POLYHAVEN_FILE_TOO_LARGE: ${url} 声明 ${declared} 字节，超过上限 ${limits.maxBytes}`)
  try { return await readCapped(response, limits.maxBytes, url) }
  catch (error) { throw error instanceof TextureLimitError ? error : networkError(url, error, limits) }
}

/** 流式读取并守住体积上限：声明值与实际字节都查，避免"声明很小、实际很大"。 */
async function readCapped(response: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  const body = response.body
  if (!body) {
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) throw new TextureLimitError(`POLYHAVEN_FILE_TOO_LARGE: ${url} 实际 ${buffer.byteLength} 字节，超过上限 ${maxBytes}`)
    return buffer
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new TextureLimitError(`POLYHAVEN_FILE_TOO_LARGE: ${url} 实际超过上限 ${maxBytes} 字节`)
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
  return merged
}

/** 检查 `/files` 的返回形状：形状变了就明说，不让四张图"悄悄全缺"。 */
function checkFilesPayload(files: FilesPayload, assetId: string): FilesPayload {
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error(`POLYHAVEN_FILES_UNEXPECTED: 「${assetId}」的文件清单不是对象；接口形状变了，不猜`)
  if (!MAPS.some((map) => files[map] && typeof files[map] === "object")) throw new Error(`POLYHAVEN_FILES_UNEXPECTED: 「${assetId}」的文件清单里没有 ${MAPS.join("/")} 任何一项；接口形状变了，不猜`)
  return files
}

/** 文件清单里**真实出现**的档位（不按 max_resolution 猜）。 */
function collectResolutions(files: FilesPayload): TextureResolution[] {
  const found = new Set<string>()
  for (const map of MAPS) for (const resolution of Object.keys(files[map] ?? {})) if (RESOLUTIONS.includes(resolution as TextureResolution)) found.add(resolution)
  return RESOLUTIONS.filter((resolution) => found.has(resolution))
}

function isAbort(error: Error): boolean {
  return error.name === "AbortError" || error.name === "TimeoutError"
}

function abortError(where: string): Error {
  const error = new Error(`POLYHAVEN_ABORTED: 已取消（${where}）`)
  error.name = "AbortError"
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError("调用前")
}

function networkError(url: string, error: unknown, limits: RequestLimits): Error {
  if (limits.signal?.aborted) return abortError(url)
  const name = error instanceof Error ? error.name : ""
  // 区分"调用方取消"和"我们自己的超时"：前者按取消上报，后者给出可调的 timeoutMs。
  if (name === "TimeoutError" || (name === "AbortError" && limits.timeoutMs > 0)) return new Error(`POLYHAVEN_TIMEOUT: ${url} 在 ${limits.timeoutMs}ms 内没有完成（可用 options.timeoutMs 调整）`)
  if (name === "AbortError") return abortError(url)
  return new Error(`POLYHAVEN_NETWORK: ${url}: ${error instanceof Error ? error.message : String(error)}`)
}
