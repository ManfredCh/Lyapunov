import { createHash, randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { request as httpsRequest } from "node:https"
import { basename, dirname, join, normalize, posix, sep } from "node:path"
import type { Transform } from "../../lyapunov-contracts/src/types.ts"
import {
  assertMountTarget,
  assertPublicHttpsURL,
  defaultHostResolver,
  fetchPublicHttpsBytesWithRetry,
  landingIsRegistered,
  NETWORK_ASSET_MAX_BYTES,
  type HostResolver,
  type NetworkAssetProvenance,
  type NetworkAssetRetryPolicy,
  type NetworkAssetTimeouts,
  type NetworkAssetTransport,
} from "./network-assets.ts"
import type { ResourceRecord } from "./resources.ts"
import type { SceneOperations } from "./operations.ts"
import type { PhysicalizeStrategy, PhysicalizeUsage } from "./physicalization.ts"

/**
 * 世界环境资产的公开来源检索与下载。与 Hunyuan/Marble 生成并列：这里只消费匿名、
 * 无需凭据的公开目录（当前为 PolyHaven 官方 API，CC0-1.0），不建索引、不记下载
 * 状态。网络部分复用 network-assets 的安全传输原语（预检与连接层用同一解析器），
 * 导入复用 ResourceLibrary / SceneOperations。
 */

const POLYHAVEN_API = "https://api.polyhaven.com"
const POLYHAVEN_PAGE = "https://polyhaven.com/a/"
const ALLOWED_HOSTS = new Set(["api.polyhaven.com", "dl.polyhaven.org"])
const RESOLUTIONS = ["1k", "2k", "4k", "8k"] as const
const SEARCH_LIMIT_DEFAULT = 8
const SEARCH_LIMIT_MAX = 20
const CATALOG_MAX_BYTES = 8 * 1024 * 1024
const GLTF_MAX_BYTES = 32 * 1024 * 1024
const MAX_SOURCE_FILES = 96
const ASSET_ID = /^[A-Za-z0-9_-]{1,64}$/
/** 环境尺度类目：命中者优先于同类关键词下的单个小摆件（道具/家具等）。 */
const ENVIRONMENT_CATEGORIES = new Set(["buildings", "structures", "nature", "ground cover", "rocks", "trees", "grass", "plants"])
const ENVIRONMENT_AFFINITY = 2

export type EnvironmentResolution = (typeof RESOLUTIONS)[number]

export interface EnvironmentAssetCandidate {
  assetId: string
  name: string
  categories: string[]
  tags: string[]
  authors: string[]
  license: "CC0-1.0"
  pageUrl: string
  thumbnailUrl?: string
  downloadCount?: number
}

export interface EnvironmentAssetDownloadFile { name: string; url: string; bytes: number; md5?: string }

export interface EnvironmentAssetDetail {
  assetId: string
  name: string
  /** 目录里的真实类目，例如模块库的 Facades & Modules；不要用尺度推断用途。 */
  categories: string[]
  /** 目录里的真实标签（如 wall / tower / modular），供 Agent 按来源描述辨认模块；目录没给就是空数组。 */
  tags: string[]
  /** 目录里的真实作者；目录没给就是空数组。 */
  authors: string[]
  resolution: EnvironmentResolution
  license: "CC0-1.0"
  pageUrl: string
  /** .gltf 主文件直链，便于审计；导入工具不需要调用方提供任何 URL。 */
  sourceUrl: string
  downloads: EnvironmentAssetDownloadFile[]
  totalBytes: number
  /** 整体视觉包围盒（米）：**只说明尺度**，不代表资产可直接使用或天然是完整环境。 */
  sizeM: [number, number, number]
  triangles: number
  meshes: number
  materials: number
  images: number
  upAxis: "Y"
  units: "m"
  note: string
}

export interface EnvironmentAssetSearchInput { query?: string; categories?: string[] | string; limit?: number }
export interface EnvironmentAssetImportInput {
  assetId: string
  resolution?: string
  sceneId?: string
  name?: string
  resourceId?: string
  entityId?: string
  parentId?: string
  transform?: Transform
  maxBytes?: number
  folder?: string
  /**
   * 派生用途（可选，显式选择才开启）：给 physicalizeUsage 时按该用途自动派生碰撞
   * （环境资产通常用 environment——按独立表面、不填内部、不封房间），给 physicalize:true
   * 而没给用途时按 dynamic 派生（等于"当成物体"）。两者都不给就保持本入口原有行为：
   * 不自动派生（physicalize:false），组装后按 environment 用法手工 asset_bake 的约定不变。
   */
  physicalize?: boolean
  physicalizeUsage?: PhysicalizeUsage
  physicalizeStrategy?: PhysicalizeStrategy
  physicalizeVoxelSizeM?: number
}

/**
 * signal 是原生 Tools/Jobs 的取消入口：预检等待、读体、退避等待、落地前的闸口都响应它；进入 authority 后按实际提交结果。
 * timeouts 是等待预算覆盖，只有测试注入（缩短停顿/总时长以确定性驱动超时语义）；生产留空用 network-assets 默认值。
 * retry 省略即用 network-assets 的 NETWORK_ASSET_RETRY_DEFAULTS（短暂故障最多再试 2 次，退避可取消）；{retries:0} 关闭。
 */
export interface EnvironmentAssetDependencies { resolve?: HostResolver; transport?: NetworkAssetTransport; signal?: AbortSignal; timeouts?: NetworkAssetTimeouts; retry?: NetworkAssetRetryPolicy }

/**
 * 本次调用真实发生的两个额度口径与请求计数（全是实测读数，不是计划值）：
 *  - queryBytes：目录/清单这类元数据请求取回的字节，**不占**资产下载额度；
 *  - downloadBytes：资产源文件（.gltf/bin/纹理）取回的字节，按**到达量**累计——重试中失败的字节同样计入，
 *    因此重试不能让已用额度归零重来；limit 是它的封顶。
 *  - requests/retries：真实发出的请求数与其中因短暂故障重发的次数。
 */
export interface EnvironmentAssetBudget { queryBytes: number; downloadBytes: number; limit: number; requests: number; retries: number }

export interface EnvironmentAssetImportResult {
  resource: ResourceRecord
  provenance: NetworkAssetProvenance
  verification: { valid: boolean; missing: string[]; changed: string[] }
  detail: Pick<EnvironmentAssetDetail, "assetId" | "name" | "categories" | "tags" | "authors" | "resolution" | "license" | "pageUrl" | "sizeM" | "triangles" | "meshes" | "materials" | "images" | "totalBytes">
  manifestPath: string
  sourceFiles: Array<{ name: string; path: string; bytes: number; md5?: string; sha256: string }>
  /** 本次导入的真实额度读数（查询字节与下载字节分列，含重试计数）。 */
  budget: EnvironmentAssetBudget
  snapshot?: Awaited<ReturnType<SceneOperations["inspect"]>>
  entityId?: string
}

interface PolyHavenAsset { name?: string; categories?: string[]; tags?: string[]; authors?: Record<string, string>; thumbnail_url?: string; download_count?: number }
interface PolyHavenFileEntry { url?: string; size?: number; md5?: string; include?: Record<string, { url?: string; size?: number; md5?: string }> }
/** transport 只在测试注入夹具时存在：生产路径留空，用 10 的 network-assets 默认传输（含其原生代理路由）。 */
interface EnvironmentHttp { resolve: HostResolver; transport?: NetworkAssetTransport; cache: Map<string, Buffer>; budget: { limit: number; used: number }; stats: { queryBytes: number; requests: number; retries: number }; signal?: AbortSignal; timeouts?: NetworkAssetTimeouts; retry?: NetworkAssetRetryPolicy }

function record(value: unknown): Record<string, any> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined }
function normalizedIncludeName(name: string): string { return posix.normalize(name.split(sep).join("/")) }
function hostAllowed(url: URL): boolean { return ALLOWED_HOSTS.has(url.hostname.toLowerCase()) }
function httpOf(dependencies: EnvironmentAssetDependencies, maxBytes: number): EnvironmentHttp {
  return {
    resolve: dependencies.resolve ?? defaultHostResolver,
    // 不填自己的默认传输：留空即用 10 的 network-assets 默认传输，从而保留其原生代理路由与连接期逐地址复核。
    ...(dependencies.transport ? { transport: dependencies.transport } : {}),
    cache: new Map(), budget: { limit: maxBytes, used: 0 }, stats: { queryBytes: 0, requests: 0, retries: 0 },
    ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    ...(dependencies.timeouts ? { timeouts: dependencies.timeouts } : {}),
    ...(dependencies.retry ? { retry: dependencies.retry } : {}),
  }
}

/** 只读快照：把本 http 上下文里已经真实发生的字节/请求计数交给调用方，不另造账本。 */
function budgetReading(http: EnvironmentHttp): EnvironmentAssetBudget {
  return { queryBytes: http.stats.queryBytes, downloadBytes: http.budget.used, limit: http.budget.limit, requests: http.stats.requests, retries: http.stats.retries }
}

/**
 * 传输层错误码换成环境资产侧词汇，其余错误原样抛出（AbortError 必须保持原样，调用方按名判定取消）。
 * 码段必须含数字：`NETWORK_ASSET_HTTP_404` 这类带状态码的也要真的换成 ENVIRONMENT_ASSET_HTTP_404，
 * 否则上层拿到的错误码与环境资产词汇表对不上（[A-Z_] 会漏掉全部 HTTP_<status>）。
 */
function asEnvironmentError(error: unknown): Error {
  const source = error instanceof Error ? error : new Error(String(error))
  if (source.name === "AbortError") return source
  const code = /^NETWORK_ASSET_([A-Z0-9_]+?)(:[\s\S]*)?$/.exec(source.message)
  if (!code) return source
  const mapped = new Error(`ENVIRONMENT_ASSET_${code[1]}${code[2] ?? ""}`)
  return mapped
}

/** 清单声明的逐文件期望：命中即作为本次请求的字节校验，失败按"这次取回的字节不可用"重试（永久错误除外）。 */
interface ExpectedFile { name: string; bytes?: number; md5?: string }

/**
 * 传输层不看配额，配额分两条口径：
 *  - **资产源文件**（.gltf/bin/纹理，charge=true）在本次导入内按真实取回字节累计扣减。清单里的 size
 *    声明缺失或错误时，只有这条真实累计能挡住「每个文件各用一份完整预算」；
 *  - **元数据**（目录与清单，charge=false）不占资产额度，用调用方给的单响应上限读取：较小的 asset
 *    maxBytes 只该约束这次要下载的资产，不该连带限制公共目录请求。
 * 计费按**到达量**（onBytes）而不是成功量：中途断流/校验不过的那次尝试取回的字节同样计入额度，
 * 重试因此既不能把已用额度清零，也不能让总下载量超过 limit。短暂故障的有界重试在传输层内完成。
 */
async function safeGet(http: EnvironmentHttp, url: URL, maxBytes: number, charge: boolean, expect?: ExpectedFile): Promise<Buffer> {
  const allowance = charge ? Math.min(maxBytes, http.budget.limit - http.budget.used) : maxBytes
  if (allowance <= 0) throw new Error(`ENVIRONMENT_ASSET_SIZE_LIMIT: 已取回 ${http.budget.used}，达到本次导入上限 ${http.budget.limit}`)
  const requestsBefore = http.stats.requests
  try {
    const { bytes, retries } = await fetchPublicHttpsBytesWithRetry(url, http.resolve, allowance, {
      transport: http.transport, signal: http.signal, acceptHeader: "application/json, model/gltf+json, application/octet-stream, image/*", timeouts: http.timeouts, retry: http.retry,
      // 每个到达字节块立刻计费：失败尝试的字节也占额度，重试拿到的只是剩下那部分。
      onBytes: count => { if (charge) http.budget.used += count; else http.stats.queryBytes += count },
      // 尝试数在发起前就记：这一路请求无论成败都算真实发生的网络次数。
      onAttempt: () => { http.stats.requests += 1 },
      // 声明与实际不符（截断但"读完了"的响应）也当失败：不把坏字节交给装配。
      ...(expect ? {
        verify: (body: Buffer) => {
          if (expect.bytes && body.length !== expect.bytes) throw new Error(`ENVIRONMENT_ASSET_SIZE_MISMATCH: ${expect.name}`)
          if (expect.md5 && createHash("md5").update(body).digest("hex") !== expect.md5) throw new Error(`ENVIRONMENT_ASSET_MD5_MISMATCH: ${expect.name}`)
        },
      } : {}),
    })
    http.stats.retries += retries
    return bytes
  } catch (error) {
    // 失败也不吞掉真实发生的重试次数：额度读数在错误路径上同样要如实（attempts 由 onAttempt 精确计数）。
    http.stats.retries += Math.max(0, http.stats.requests - requestsBefore - 1)
    const mapped = asEnvironmentError(error)
    // 超限时把真实累计额度写进错误：清单声明可能缺失或错误，只有这条数字是实际取回的。
    if (charge && mapped.message === "ENVIRONMENT_ASSET_SIZE_LIMIT") throw new Error(`ENVIRONMENT_ASSET_SIZE_LIMIT: 已取回 ${http.budget.used}，本次响应后超过本次导入上限 ${http.budget.limit}`)
    throw mapped
  }
}

/** 同一 URL 本次调用内只取一次：已成功取回的依赖（.bin/纹理）直接复用，不因后续重试再下一遍。 */
async function getCached(http: EnvironmentHttp, url: string, maxBytes: number, charge = false, expect?: ExpectedFile): Promise<Buffer> {
  const cached = http.cache.get(url)
  if (cached) return cached
  const parsed = await assertPublicHttpsURL(url, http.resolve, http.signal)
  if (!hostAllowed(parsed)) throw new Error(`ENVIRONMENT_ASSET_HOST_NOT_ALLOWED: ${parsed.hostname}`)
  const bytes = await safeGet(http, parsed, maxBytes, charge, expect)
  http.cache.set(url, bytes)
  return bytes
}

async function getJson(http: EnvironmentHttp, url: string, maxBytes: number): Promise<unknown> {
  const bytes = await getCached(http, url, maxBytes)
  try { return JSON.parse(bytes.toString("utf8")) } catch { throw new Error(`ENVIRONMENT_ASSET_INVALID_JSON: ${url}`) }
}

function candidateOf(id: string, meta: PolyHavenAsset): EnvironmentAssetCandidate {
  return {
    assetId: id,
    name: meta.name ?? id,
    categories: [...meta.categories ?? []],
    tags: [...meta.tags ?? []],
    authors: Object.keys(meta.authors ?? {}),
    license: "CC0-1.0",
    pageUrl: POLYHAVEN_PAGE + id,
    ...(meta.thumbnail_url ? { thumbnailUrl: meta.thumbnail_url } : {}),
    ...(meta.download_count !== undefined ? { downloadCount: meta.download_count } : {}),
  }
}

/** 自然语言检索：按 id/名称/类目/标签/作者命中词数排序，命中多者与下载量高者优先。 */
export async function searchEnvironmentAssets(input: EnvironmentAssetSearchInput, dependencies: EnvironmentAssetDependencies = {}): Promise<{ query: string; categories: string[]; total: number; candidates: EnvironmentAssetCandidate[]; note: string; budget: EnvironmentAssetBudget }> {
  const http = httpOf(dependencies, CATALOG_MAX_BYTES)
  const catalog = record(await getJson(http, `${POLYHAVEN_API}/assets?t=models`, CATALOG_MAX_BYTES))
  if (!catalog) throw new Error("ENVIRONMENT_ASSET_CATALOG_INVALID")
  const tokens = (input.query ?? "").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(token => token.length > 1)
  const wanted = (Array.isArray(input.categories) ? input.categories : input.categories ? [input.categories] : []).map(item => item.toLowerCase()).filter(Boolean)
  const scored: Array<{ candidate: EnvironmentAssetCandidate; score: number }> = []
  for (const [id, raw] of Object.entries(catalog)) {
    const meta = record(raw) as PolyHavenAsset | undefined
    if (!meta) continue
    if (wanted.length && !wanted.every(category => (meta.categories ?? []).some(item => item.toLowerCase().includes(category)))) continue
    const text = `${id} ${meta.name ?? ""} ${(meta.categories ?? []).join(" ")} ${(meta.tags ?? []).join(" ")} ${Object.keys(meta.authors ?? {}).join(" ")}`.toLowerCase()
    const hits = tokens.reduce((sum, token) => sum + (text.includes(token) ? 1 : 0), 0)
    if (tokens.length && hits === 0) continue
    // 类目亲和只用于同分排序与抵消“名称命中但只是摆件”的情况；关键词命中数仍是主排序。
    const environment = (meta.categories ?? []).some(category => { const value = category.toLowerCase(); return ENVIRONMENT_CATEGORIES.has(value) || value.startsWith("collection: ") })
    scored.push({ candidate: candidateOf(id, meta), score: hits * ENVIRONMENT_AFFINITY + (environment ? 1 : 0) })
  }
  scored.sort((a, b) => b.score - a.score || (b.candidate.downloadCount ?? 0) - (a.candidate.downloadCount ?? 0) || a.candidate.assetId.localeCompare(b.candidate.assetId))
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? SEARCH_LIMIT_DEFAULT) || SEARCH_LIMIT_DEFAULT, 1), SEARCH_LIMIT_MAX)
  return {
    query: input.query ?? "", categories: wanted, total: scored.length, candidates: scored.slice(0, limit).map(item => item.candidate), budget: budgetReading(http),
    note: "候选来自 PolyHaven 公开模型目录（CC0-1.0，无需凭据）。下载前先用 scene_environment_detail 核对真实类目、下载清单与三角数/体积；sizeM 只是包围盒尺度，不能用来认定「这是完整环境」。候选是模块、摆件还是整体环境，由下载后的实际观察与装配决定（渲染观察 / Blender 装配 / Scene 与 Sim 自检），不由名称或尺度推定。",
  }
}

function matrixOf(node: any): number[] {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.slice()
  const [tx, ty, tz] = node.translation ?? [0, 0, 0], [x, y, z, w] = node.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = node.scale ?? [1, 1, 1]
  const x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2
  return [(1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0, (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0, (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0, tx, ty, tz, 1]
}
const multiply = (a: number[], b: number[]): number[] => { const out = new Array<number>(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let value = 0; for (let k = 0; k < 4; k++) value += a[k * 4 + r]! * b[c * 4 + k]!; out[c * 4 + r] = value } return out }
const applyTo = (m: number[], p: number[]): number[] => [m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!, m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!, m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!]

/** 视觉包围盒、三角数与材质/纹理计数：只读 glTF 的 accessor min/max 与节点变换，不做渲染、不做版式推断。 */
function geometrySummary(json: any): { size: [number, number, number]; triangles: number; meshes: number; materials: number; images: number; hasBounds: boolean } {
  const nodes: any[] = json.nodes ?? [], scene = json.scenes?.[json.scene ?? 0]
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  let triangles = 0
  const visiting = new Set<number>()
  const visit = (index: number, parent: number[]): void => {
    const node = nodes[index]
    if (!node) return
    // glTF 规范不允许环；恶意文件若成环，这里给出稳定错误而不是递归爆栈。
    if (visiting.has(index)) throw new Error(`ENVIRONMENT_ASSET_GEOMETRY_CYCLE: nodes[${index}]`)
    visiting.add(index)
    const world = multiply(parent, matrixOf(node))
    if (node.mesh !== undefined) {
      for (const primitive of json.meshes?.[node.mesh]?.primitives ?? []) {
        const accessor = json.accessors?.[primitive.attributes?.POSITION]
        if ((primitive.mode ?? 4) === 4) { const counter = json.accessors?.[primitive.indices] ?? accessor; if (counter) triangles += Math.floor(counter.count / 3) }
        if (!accessor?.min || !accessor?.max) continue
        const [ax, ay, az] = accessor.min, [bx, by, bz] = accessor.max
        for (const corner of [[ax, ay, az], [bx, ay, az], [ax, by, az], [ax, ay, bz], [bx, by, bz], [ax, by, bz], [bx, ay, bz], [bx, by, az]]) {
          const point = applyTo(world, corner)
          for (let axis = 0; axis < 3; axis++) {
            lo[axis] = Math.min(lo[axis]!, point[axis]!); hi[axis] = Math.max(hi[axis]!, point[axis]!)
          }
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world)
    visiting.delete(index)
  }
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  for (const root of scene?.nodes ?? nodes.map((_, index) => index)) visit(root, identity)
  const hasBounds = Number.isFinite(lo[0]) && Number.isFinite(hi[0])
  const size: [number, number, number] = hasBounds ? [hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!] : [0, 0, 0]
  return { size, triangles, meshes: json.meshes?.length ?? 0, materials: json.materials?.length ?? 0, images: json.images?.length ?? 0, hasBounds }
}

function fileEntryOf(files: any, resolution: string): { main: PolyHavenFileEntry; name: string } {
  const entry = record(files?.gltf?.[resolution]?.gltf)
  if (!entry?.url) throw new Error(`ENVIRONMENT_ASSET_RESOLUTION_UNAVAILABLE: ${resolution}`)
  return { main: entry as PolyHavenFileEntry, name: normalizedIncludeName(basename(new URL(entry.url).pathname)) }
}

async function detailWith(http: EnvironmentHttp, assetId: string, resolution: EnvironmentResolution): Promise<{ detail: EnvironmentAssetDetail; gltf: any; downloads: EnvironmentAssetDownloadFile[] }> {
  if (!ASSET_ID.test(assetId)) throw new Error(`ENVIRONMENT_ASSET_ID_INVALID: ${assetId}`)
  const files = record(await getJson(http, `${POLYHAVEN_API}/files/${assetId}`, CATALOG_MAX_BYTES))
  if (!files) throw new Error(`ENVIRONMENT_ASSET_NOT_FOUND: ${assetId}`)
  const { main, name } = fileEntryOf(files, resolution)
  const downloads: EnvironmentAssetDownloadFile[] = [{ name, url: main.url!, bytes: main.size ?? 0, ...(main.md5 ? { md5: main.md5 } : {}) }]
  for (const [includeName, include] of Object.entries(main.include ?? {})) {
    if (!include?.url) throw new Error(`ENVIRONMENT_ASSET_INCLUDE_INVALID: ${includeName}`)
    const normalized = normalizedIncludeName(includeName)
    // 目录穿越在取回任何字节之前就拒绝。
    if (normalized.startsWith("/") || normalized.split("/").includes("..") || normalized === ".") throw new Error(`ENVIRONMENT_ASSET_INCLUDE_PATH_UNSAFE: ${includeName}`)
    downloads.push({ name: normalized, url: include.url, bytes: include.size ?? 0, ...(include.md5 ? { md5: include.md5 } : {}) })
  }
  if (downloads.length > MAX_SOURCE_FILES) throw new Error(`ENVIRONMENT_ASSET_TOO_MANY_FILES: ${downloads.length}`)
  // 清单声明的 size/md5 直接当本次请求的校验：截断但"读完"的响应不会被当成主文件收下。
  const gltfBytes = await getCached(http, main.url!, Math.min(Math.max(GLTF_MAX_BYTES, main.size ?? 0), NETWORK_ASSET_MAX_BYTES), true, { name, bytes: main.size, md5: main.md5 })
  if (main.size !== undefined && gltfBytes.length !== main.size) throw new Error(`ENVIRONMENT_ASSET_SIZE_MISMATCH: ${name}`)
  let gltf: any
  try { gltf = JSON.parse(gltfBytes.toString("utf8")) } catch { throw new Error(`ENVIRONMENT_ASSET_INVALID_GLTF: ${assetId}`) }
  const geometry = geometrySummary(gltf)
  if (!geometry.meshes || !geometry.hasBounds) throw new Error(`ENVIRONMENT_ASSET_GEOMETRY_EMPTY: ${assetId}`)
  const meta = record(record(await getJson(http, `${POLYHAVEN_API}/assets?t=models`, CATALOG_MAX_BYTES))?.[assetId]) as PolyHavenAsset | undefined
  const detail: EnvironmentAssetDetail = {
    assetId, name: meta?.name ?? assetId, categories: [...meta?.categories ?? []], tags: [...meta?.tags ?? []], authors: Object.keys(meta?.authors ?? {}),
    resolution, license: "CC0-1.0", pageUrl: POLYHAVEN_PAGE + assetId, sourceUrl: main.url!,
    downloads, totalBytes: downloads.reduce((sum, file) => sum + file.bytes, 0),
    sizeM: geometry.size.map(value => Number(value.toFixed(3))) as [number, number, number],
    triangles: geometry.triangles, meshes: geometry.meshes, materials: geometry.materials, images: geometry.images,
    upAxis: "Y", units: "m",
    note: `glTF 为 Y-up、米制；导入时声明 source.upAxis=Y，由 Scene 统一坐标转换。sizeM 只是整体包围盒尺度，不代表资产可直接使用、也不是「完整环境」的证明：类目（${[...meta?.categories ?? []].join("/") || "未知"}）、来源标签（${[...meta?.tags ?? []].join("/") || "无"}）与网格数都只描述素材本身。它究竟是整体环境、模块库还是单个摆件，要看下载后的实际观察与装配结果（渲染观察 / Blender 装配 / Scene 与 Sim 自检）。`,
  }
  return { detail, gltf, downloads }
}

export async function environmentAssetDetail(input: { assetId: string; resolution?: string }, dependencies: EnvironmentAssetDependencies = {}): Promise<EnvironmentAssetDetail & { budget: EnvironmentAssetBudget }> {
  const resolution = (input.resolution ?? "1k") as EnvironmentResolution
  if (!RESOLUTIONS.includes(resolution)) throw new Error(`ENVIRONMENT_ASSET_RESOLUTION_INVALID: ${input.resolution}`)
  // 详情阶段只取元数据与 .gltf 结构，预算给到单文件上限；导入阶段才按整体 maxBytes 累计。
  const http = httpOf(dependencies, NETWORK_ASSET_MAX_BYTES)
  const { detail } = await detailWith(http, input.assetId, resolution)
  return { ...detail, budget: budgetReading(http) }
}

function dataURIBytes(uri: string): Buffer | undefined {
  const match = uri.match(/^data:([^;,]+)?(;base64)?,(.*)$/s)
  if (!match) return undefined
  return match[2] ? Buffer.from(match[3] ?? "", "base64") : Buffer.from(decodeURIComponent(match[3] ?? ""), "utf8")
}

function imageMimeFromName(name: string): string | undefined {
  const extension = name.toLowerCase().split(".").pop()
  return extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "png" ? "image/png" : undefined
}

/** 把 .gltf + 外部 .bin/纹理组装为自包含 GLB：合并 buffer、纹理嵌入 bufferView，去掉全部外部 uri。 */
export function assembleSelfContainedGLB(gltf: any, files: Map<string, Buffer>): Buffer {
  const json = structuredClone(gltf)
  const parts: Buffer[] = []
  let offset = 0
  const append = (blob: Buffer): { byteOffset: number; byteLength: number } => {
    const padding = (4 - (offset % 4)) % 4
    if (padding) { parts.push(Buffer.alloc(padding)); offset += padding }
    parts.push(blob)
    const view = { byteOffset: offset, byteLength: blob.length }
    offset += blob.length
    return view
  }
  const bufferOffsets: number[] = []
  for (const [index, buffer] of (json.buffers ?? []).entries()) {
    const uri = buffer?.uri
    const blob = typeof uri === "string" ? (uri.startsWith("data:") ? dataURIBytes(uri) : files.get(normalizedIncludeName(uri))) : undefined
    if (!blob) throw new Error(`ENVIRONMENT_ASSET_BUFFER_MISSING: ${uri ?? `buffers[${index}]`}`)
    // 每个源 buffer 的基址都必须 4 字节对齐：否则 3 字节索引 buffer 之后的 float32 位置数据
    // 会落在非对齐地址（glTF 要求 accessor 的组件对齐），合并后整个 BIN 不可用。
    bufferOffsets.push(append(blob).byteOffset)
  }
  json.bufferViews = (json.bufferViews ?? []).map((view: any) => ({ ...view, buffer: 0, byteOffset: (view.byteOffset ?? 0) + (bufferOffsets[view.buffer ?? 0] ?? 0) }))
  for (const image of json.images ?? []) {
    if (typeof image.bufferView === "number") continue
    const uri = image.uri
    const blob = typeof uri === "string" ? (uri.startsWith("data:") ? dataURIBytes(uri) : files.get(normalizedIncludeName(uri))) : undefined
    if (!blob) throw new Error(`ENVIRONMENT_ASSET_IMAGE_MISSING: ${image.uri ?? "image"}`)
    const view = append(blob)
    // glTF 的 mimeType 属于 image 本身（用 bufferView 存图时必填），不是 bufferView 字段。
    const mimeType = image.mimeType ?? imageMimeFromName(image.uri ?? "")
    image.bufferView = json.bufferViews.push({ buffer: 0, byteOffset: view.byteOffset, byteLength: view.byteLength }) - 1
    delete image.uri
    if (mimeType) image.mimeType = mimeType
  }
  const binary = Buffer.concat(parts)
  // 合并后所有 bufferView 都指向 buffer 0；其 byteLength 必须覆盖追加的纹理所占的尾部。
  if (json.buffers?.length || binary.length) json.buffers = [{ byteLength: binary.length }]
  const external = [...json.buffers ?? [], ...json.images ?? []].filter((item: any) => typeof item.uri === "string" && !item.uri.startsWith("data:"))
  if (external.length) throw new Error("ENVIRONMENT_ASSET_EXTERNAL_DEPENDENCY")
  const text = Buffer.from(JSON.stringify(json), "utf8")
  const jsonChunk = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)])
  const binChunk = binary.length ? Buffer.concat([binary, Buffer.alloc((4 - (binary.length % 4)) % 4, 0)]) : Buffer.alloc(0)
  const total = 12 + 8 + jsonChunk.length + (binChunk.length ? 8 + binChunk.length : 0)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8)
  const jsonHeader = Buffer.alloc(8); jsonHeader.writeUInt32LE(jsonChunk.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  const pieces = [header, jsonHeader, jsonChunk]
  if (binChunk.length) { const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binChunk.length, 0); binHeader.writeUInt32LE(0x004e4942, 4); pieces.push(binHeader, binChunk) }
  return Buffer.concat(pieces, total)
}

function absoluteIncludeTarget(root: string, name: string): string {
  const normalized = normalizedIncludeName(name)
  const target = normalize(join(root, normalized))
  if (normalized.startsWith("/") || normalized.split("/").includes("..") || normalized === "." || !target.startsWith(root + sep)) throw new Error(`ENVIRONMENT_ASSET_INCLUDE_PATH_UNSAFE: ${name}`)
  return target
}

/**
 * 下载一个公开环境资产并导入资源库：.gltf+依赖经同一安全传输取回、md5 与字节校验、
 * 组装自包含 GLB 后复用 SceneOperations.import；原件与依赖保留在落地目录 source/ 下，
 * manifest.json 记录来源页/许可/作者/类目/来源标签/逐文件哈希。
 */
export async function importEnvironmentAsset(operations: SceneOperations, input: EnvironmentAssetImportInput, dependencies: EnvironmentAssetDependencies = {}): Promise<EnvironmentAssetImportResult> {
  const resolution = (input.resolution ?? "1k") as EnvironmentResolution
  if (!RESOLUTIONS.includes(resolution)) throw new Error(`ENVIRONMENT_ASSET_RESOLUTION_INVALID: ${input.resolution}`)
  const maxBytes = Math.min(input.maxBytes ?? NETWORK_ASSET_MAX_BYTES, NETWORK_ASSET_MAX_BYTES)
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("ENVIRONMENT_ASSET_MAX_BYTES_INVALID")
  // 预算按本次导入真实取回的**资产源文件**字节累计（元数据按自己的单响应上限，不挤占资产额度），不只看清单里声明的 totalBytes。
  const http = httpOf(dependencies, maxBytes)
  dependencies.signal?.throwIfAborted()
  await assertMountTarget(operations, input.sceneId, input.parentId)
  const { detail, gltf, downloads } = await detailWith(http, input.assetId, resolution)
  if (detail.totalBytes > maxBytes) throw new Error(`ENVIRONMENT_ASSET_SIZE_LIMIT: ${detail.totalBytes} > ${maxBytes}`)
  // 逐件取回：同一 URL 只下一次（.gltf 已在 detail 阶段取过，这里直接命中缓存复用），
  // 清单里的 size/md5 作为每次请求的校验，坏字节不进入装配。
  const files = new Map<string, Buffer>()
  for (const download of downloads) files.set(download.name, await getCached(http, download.url, maxBytes, true, { name: download.name, bytes: download.bytes, md5: download.md5 }))
  const sourceFiles: EnvironmentAssetImportResult["sourceFiles"] = []
  for (const download of downloads) {
    const blob = files.get(download.name)!
    if (download.bytes && blob.length !== download.bytes) throw new Error(`ENVIRONMENT_ASSET_SIZE_MISMATCH: ${download.name}`)
    if (download.md5 && createHash("md5").update(blob).digest("hex") !== download.md5) throw new Error(`ENVIRONMENT_ASSET_MD5_MISMATCH: ${download.name}`)
    sourceFiles.push({ name: download.name, path: "", bytes: blob.length, ...(download.md5 ? { md5: download.md5 } : {}), sha256: createHash("sha256").update(blob).digest("hex") })
  }
  const assembled = assembleSelfContainedGLB(gltf, files)
  if (assembled.length > maxBytes) throw new Error(`ENVIRONMENT_ASSET_SIZE_LIMIT: ${assembled.length} > ${maxBytes}`)
  // 提交点前的取消闸：abort 之后不落文件、不登记资源。
  dependencies.signal?.throwIfAborted()
  // 下载落地跟随 cache 域：省略 layout 时仍是 <dataRoot>/resources/network。
  const landing = join(operations.resources.downloadRoot, randomUUID())
  const glbPath = join(landing, "asset.glb")
  await mkdir(landing, { recursive: true, mode: 0o700 })
  try {
    for (const [index, file] of sourceFiles.entries()) {
      const target = absoluteIncludeTarget(join(landing, "source"), file.name)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, files.get(downloads[index]!.name)!, { mode: 0o600, flag: "wx" })
      file.path = target
    }
    const manifestPath = join(landing, "manifest.json")
    const fetchedAt = new Date().toISOString()
    const sha256 = createHash("sha256").update(assembled).digest("hex")
    const manifest = {
      generator: "lyapunov-scene-kit/environment-assets",
      assetId: detail.assetId, name: detail.name, license: detail.license, pageUrl: detail.pageUrl, resolution,
      // 作者与类目都来自目录的真实字段；目录没给就不写，不用占位值凑。
      ...(detail.authors.length ? { authors: detail.authors } : {}),
      ...(detail.categories.length ? { categories: detail.categories } : {}),
      ...(detail.tags.length ? { tags: detail.tags } : {}),
      fetchedAt, sourceFiles, assembled: { path: glbPath, bytes: assembled.length, sha256, glbVersion: "2.0" },
      // 只记从源文件直接读到的事实，不做版式/可用性判定。
      detail: { sizeM: detail.sizeM, triangles: detail.triangles, meshes: detail.meshes, materials: detail.materials, images: detail.images, totalBytes: detail.totalBytes },
    }
    await writeFile(glbPath, assembled, { mode: 0o600, flag: "wx" })
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: "wx" })
    const provenance: NetworkAssetProvenance = {
      sourceUrl: detail.sourceUrl, fetchedAt, sha256, byteLength: assembled.length,
      glbVersion: "2.0", contentType: "model/gltf-binary", maxBytes, redirectsFollowed: 0, externalDependencies: 0,
    }
    // 首次 authority 提交前的取消闸：落盘期间被取消就不登记资源；异常走 catch 里对未登记 landing 的清理。
    dependencies.signal?.throwIfAborted()
    const imported = await operations.import({
      path: glbPath, sceneId: input.sceneId, name: input.name ?? detail.name, resourceId: input.resourceId, entityId: input.entityId,
      parentId: input.parentId, transform: input.transform, source: { units: "m", upAxis: "Y", handedness: "right", metersPerUnit: 1 }, networkProvenance: provenance,
      // 缺省仍是不自动派生（旧行为逐字不变）：环境模块若按 dynamic 派生会填实内部空腔。
      // 显式给 physicalizeUsage 才开启自动派生（通常给 environment：逐表面、保空腔）；
      // 只给 physicalize:true 就按 dynamic 走，等于把这份下载资产当物体处理。
      physicalize: input.physicalize ?? input.physicalizeUsage !== undefined,
      ...(input.physicalizeUsage ? { physicalizeUsage: input.physicalizeUsage } : {}),
      ...(input.physicalizeStrategy ? { physicalizeStrategy: input.physicalizeStrategy } : {}),
      ...(input.physicalizeVoxelSizeM !== undefined ? { physicalizeVoxelSizeM: input.physicalizeVoxelSizeM } : {}),
    })
    // 标签只写可核对的事实（来源/许可/来源页/清单/目录真实类目），不给资产贴「可用/成型」结论。
    const tags = ["下载环境", "来源:Poly Haven", `许可:${detail.license}`, `来源页:${detail.pageUrl}`, `清单:${manifestPath}`, ...(detail.categories.length ? [`类目:${detail.categories.join("/")}`] : [])]
    // 返回值必须是写完标签/目录之后的真实记录：拿更新前的 imported.resource 会给出空 tags/folder。
    const resource = await operations.resources.update(imported.resource.ref.resourceId, { tags, folder: input.folder ?? "下载环境/PolyHaven" })
    const verification = await operations.resources.verify(resource.ref.resourceId, resource.ref.version)
    if (!verification.valid) throw new Error(`ENVIRONMENT_ASSET_VERIFY_FAILED: ${JSON.stringify(verification)}`)
    return {
      ...imported, resource, verification, provenance, manifestPath, sourceFiles, budget: budgetReading(http),
      detail: { assetId: detail.assetId, name: detail.name, resolution, license: detail.license, pageUrl: detail.pageUrl, authors: detail.authors, categories: detail.categories, tags: detail.tags, sizeM: detail.sizeM, triangles: detail.triangles, meshes: detail.meshes, materials: detail.materials, images: detail.images, totalBytes: detail.totalBytes },
    }
  } catch (error) {
    const registered = await landingIsRegistered(operations, glbPath).catch(() => true)
    if (!registered) await rm(landing, { recursive: true, force: true })
    throw error
  }
}
