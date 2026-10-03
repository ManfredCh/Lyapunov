/**
 * `packs` 源：客户端**只经我们服务器的能力包端点**取件（`Dev/docs/PACK_ENDPOINT_CONTRACT.md` 的
 * catalog/open/stream 三端点），**绝不回落公开源下载**（goal 约束优先于便捷；负面清单第 2 条：
 * 任何响应不含对象存储/OSS/CDN URL——字节只经 `stream` 端点按句柄取）。
 *
 * - 模型 id 约定 `packs/<packId>`（沿用 policyId 校验风格）。
 * - endpoint 来自环境变量 PACK_ENDPOINT（默认 https://api.vorynel.com/packs/v1，
 *   允许 http://127.0.0.1|localhost 便于测试）；鉴权头 `Authorization: Bearer $PACK_TOKEN`。
 * - 流程：GET catalog（只作 packId 与 pieces 校验）→ POST open 拿 {mountId, files, expiresAt, budget}
 *   → 对清单逐文件 GET stream 落盘到 policyDirectory 同族布局（provider 目录段 'packs'），
 *   逐文件校验 sha256 与 bytes 与 open 清单一致，不一致即 PACK_INTEGRITY_MISMATCH 并删除派生件。
 * - PolicyManifest 沿用既有形状，但 sourceFiles 只记 path/bytes/sha256/revision（revision＝mount 快照，
 *   即 open 返回的那份绑定「用户+packId+文件清单」的清单快照句柄），**不记任何 URL**。
 * - mount 过期由服务端 410 定夺，客户端不自行延寿；支持 AbortSignal 取消（沿用 checkCancelled 风格）。
 */
import { createHash } from 'node:crypto'
import { mkdir, open as openFile, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { asObject, checkCancelled, policyDirectory, policyFile, policyId, policyRevision, type PolicyManifest } from './source.ts'

export type PackPiece = 'asset' | 'context' | 'policy' | 'vla'
export const PACK_PIECES: PackPiece[] = ['asset', 'context', 'policy', 'vla']

/** open 清单条目：只有路径/字节数/内容 sha256/revision（mount 快照），没有任何 URL。 */
export interface PackSourceFile { path: string; bytes: number; sha256: string; revision: string }
/** 沿用 PolicyManifest 形状；sourceFiles/files 换成不带 url 的 pack 清单条目（负面清单第 2 条）。 */
export interface PackManifest extends Omit<PolicyManifest, 'provider' | 'sourceFiles' | 'files'> {
  provider: 'packs'
  sourceFiles: PackSourceFile[]
  files: PackSourceFile[]
}
export interface PackError extends Error { code: string }

export interface PackRequestInit { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
/** 可注入 fetcher（测试 mock 用）；默认走全局 fetch。 */
export type PackFetcher = (url: string, init: PackRequestInit) => Promise<Response>

export interface PackDownloadInput {
  dataDirectory: string
  /** 模型 id 约定 `packs/<packId>` */
  modelId: string
  revision?: string
  /** 可选，默认全部四件套；catalog 只作 packId 与 pieces 校验 */
  pieces?: PackPiece[]
  endpoint?: string
  /** 默认 process.env.PACK_TOKEN；仅供注入测试，任何文件都不写 token */
  token?: string
  signal: AbortSignal
  fetcher?: PackFetcher
}

export const packError = (code: string, detail?: string): PackError => {
  const error = new Error(detail ? `${code}: ${detail}` : code) as PackError
  error.code = code
  return error
}

export const DEFAULT_PACK_ENDPOINT = 'https://api.vorynel.com/packs/v1'
/** endpoint 来自 PACK_ENDPOINT；只允许 https，例外放行 http://127.0.0.1|localhost 便于测试（与 hf 入口同纪律）。 */
export const packEndpoint = (configured?: string) => {
  const value = (configured ?? process.env.PACK_ENDPOINT ?? DEFAULT_PACK_ENDPOINT).replace(/\/$/, '')
  const url = new URL(value)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw packError('PACK_ENDPOINT_MUST_BE_HTTPS')
  return value
}

/** 模型 id 约定 `packs/<packId>`：沿用 policyId 校验风格，再钉死 provider 段。 */
export const packModelId = (value: unknown) => {
  const id = policyId(value)
  const [prefix, packId] = id.split('/')
  if (prefix !== 'packs' || !packId) throw packError('INVALID_PACK_MODEL_ID', String(value))
  return { modelId: id, packId }
}

export const packPiece = (value: unknown): PackPiece => {
  if (typeof value === 'string' && (PACK_PIECES as string[]).includes(value)) return value as PackPiece
  throw packError('INVALID_PACK_PIECE', String(value))
}

/**
 * 取件 Bearer 的**唯一来源**：`PACK_TOKEN`（显式配置/开发路径）优先，其次**既有账号会话**
 * `LYAPUNOV_ACCOUNT_TOKEN`（正式 Host 由 backendEnvironment 注入的同一账号令牌，见 script/profile.ts）。
 * 于是正式装配**不需要新的白名单键**：能力包端点用既有账号消费链验证同一个令牌（server.ts 的
 * accountChainAuthenticator 走账户 API /me）。本函数只读环境变量，任何配置与文件都不落 token。
 */
export const packBearer = (explicit?: string) => explicit ?? process.env.PACK_TOKEN ?? process.env.LYAPUNOV_ACCOUNT_TOKEN

/** 错误映射（合同 §2）：401→PACK_UNAUTHORIZED、402→PACK_PAYMENT_REQUIRED/PACK_BUDGET_EXCEEDED、
 *  403→PACK_FORBIDDEN、404→PACK_NOT_FOUND、410→PACK_MOUNT_EXPIRED/PACK_MOUNT_SPENT、未知→PACK_ENDPOINT_ERROR。
 *  402/410 各有两个码：优先取响应体 `code`（服务端定夺），否则按语境兜底（stream 超预算→BUDGET_EXCEEDED；
 *  410 默认 EXPIRED，SPENT 由服务端 body code 定夺——mount 过期由服务端 410 定夺，客户端不自行延寿）。 */
const PACK_STATUS_CODES: Record<number, string[]> = {
  401: ['PACK_UNAUTHORIZED'],
  402: ['PACK_PAYMENT_REQUIRED', 'PACK_BUDGET_EXCEEDED'],
  403: ['PACK_FORBIDDEN'],
  404: ['PACK_NOT_FOUND'],
  410: ['PACK_MOUNT_EXPIRED', 'PACK_MOUNT_SPENT'],
}
type PackPhase = 'catalog' | 'open' | 'stream'
async function packStatusError(response: Response, phase: PackPhase): Promise<PackError> {
  const allowed = PACK_STATUS_CODES[response.status]
  if (!allowed) return packError('PACK_ENDPOINT_ERROR', `${phase} HTTP ${response.status}`)
  let code: string | undefined
  try {
    const body = asObject(await response.json())
    // 服务端错误体同时给 code 与 error（合同 §2 的码字面量）；只认其中一个就会丢掉
    // 402/410 的两码区分（PAYMENT_REQUIRED↔BUDGET_EXCEEDED、MOUNT_EXPIRED↔MOUNT_SPENT）。
    const declared = typeof body.code === 'string' ? body.code : typeof body.error === 'string' ? body.error : ''
    if (allowed.includes(declared)) code = declared
  } catch {}
  if (!code) code = response.status === 402 ? (phase === 'stream' ? 'PACK_BUDGET_EXCEEDED' : 'PACK_PAYMENT_REQUIRED') : response.status === 410 ? 'PACK_MOUNT_EXPIRED' : allowed[0]
  return packError(code!, `${phase} HTTP ${response.status}`)
}

const packHeaders = (token: string): Record<string, string> => ({ 'user-agent': 'LyapunovDSH-policy/0.1', authorization: `Bearer ${token}` })

async function packFetch(fetcher: PackFetcher, url: string, init: PackRequestInit, signal: AbortSignal) {
  checkCancelled(signal)
  try { return await fetcher(url, init) } catch (error) { checkCancelled(signal); throw error }
}

async function packJSON(fetcher: PackFetcher, url: string, init: PackRequestInit, token: string, signal: AbortSignal, phase: PackPhase) {
  const response = await packFetch(fetcher, url, { ...init, signal, headers: packHeaders(token) }, signal)
  if (!response.ok) throw await packStatusError(response, phase)
  try { return asObject(await response.json()) } catch { throw packError('PACK_ENDPOINT_ERROR', `${phase} 响应非 JSON`) }
}

export interface PackCatalogInput { endpoint?: string; token?: string; signal: AbortSignal; fetcher?: PackFetcher }
/** GET catalog（合同 §1：只出元数据、不出字节、不出 URL）。产品检索/元数据工具与 downloadPack 共用这一入口；
 *  鉴权头取 `token ?? $PACK_TOKEN`，错误码（401→PACK_UNAUTHORIZED 等）原样上抛。 */
export async function packCatalog(input: PackCatalogInput) {
  const endpoint = packEndpoint(input.endpoint)
  const token = packBearer(input.token)
  if (!token) throw packError('PACK_TOKEN_MISSING', '需要环境变量 PACK_TOKEN 或既有账号会话 LYAPUNOV_ACCOUNT_TOKEN（或显式 token）')
  const fetcher: PackFetcher = input.fetcher ?? ((url, init) => fetch(url, init as RequestInit))
  return packJSON(fetcher, `${endpoint}/catalog`, {}, token, input.signal, 'catalog')
}

export interface PackDiscoveryInput { endpoint?: string; signal: AbortSignal; fetcher?: PackFetcher }
/**
 * GET discovery（三面分离的**发现面**）：公开、无鉴权、只出元数据与别名——因此**不带任何凭据**，
 * 与浏览器/webfetch 看到的是同一份内容；取件仍必须走 catalog/open/stream 的账号鉴权。
 * 用于：没有 PACK_TOKEN 时的能力包检索（"客户端应该有发现入口"）。
 */
export async function packDiscovery(input: PackDiscoveryInput) {
  const endpoint = packEndpoint(input.endpoint)
  const fetcher: PackFetcher = input.fetcher ?? ((url, init) => fetch(url, init as RequestInit))
  const response = await packFetch(fetcher, `${endpoint}/discovery`, { headers: { "user-agent": "LyapunovDSH-policy/0.1" } }, input.signal)
  if (!response.ok) throw await packStatusError(response, "catalog")
  try { return asObject(await response.json()) } catch { throw packError("PACK_ENDPOINT_ERROR", "discovery 响应非 JSON") }
}

export interface PackListingReceipt {
  packId: string; modelId: string; status: string; resolvedRevision?: string
  files: PackSourceFile[]; nextSteps?: string[]
}
/** packs 源的逐文件身份只有 open mount 快照（随 policy_download 落 manifest.sourceFiles）；
 *  本函数只读 CAS 里的快照，**不新建 mount**（open/stream 逐次计量留痕，不为列清单虚开句柄）。
 *  未下载过 ⇒ 明确 NOT_DOWNLOADED 回执，不静默空表。 */
export async function readPackListing(dataDirectory: string, modelId: string, revision?: string): Promise<PackListingReceipt> {
  const { modelId: id, packId } = packModelId(modelId)
  const root = policyDirectory(dataDirectory, 'packs', id, policyRevision(revision))
  try {
    const manifest = asObject(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')))
    const files: PackSourceFile[] = (Array.isArray(manifest.sourceFiles) ? manifest.sourceFiles : []).map(asObject).map((row: Record<string, any>) =>
      ({ path: policyFile(row.path), bytes: Number(row.bytes), sha256: String(row.sha256), revision: String(row.revision) }))
    return {
      packId, modelId: id,
      status: manifest.status === 'DOWNLOADED' ? 'LISTED_FROM_MOUNT_SNAPSHOT' : `MANIFEST_${String(manifest.status ?? 'UNKNOWN')}`,
      ...(typeof manifest.resolvedRevision === 'string' ? { resolvedRevision: manifest.resolvedRevision } : {}),
      files,
    }
  } catch {
    return { packId, modelId: id, status: 'NOT_DOWNLOADED', files: [], nextSteps: ['逐文件身份是 open mount 快照，只随 policy_download 落 CAS（不为列清单新建计费 mount）；先 policy_download'] }
  }
}

/** 逐文件 GET stream 落盘：边收边写 .part，sha256 与 bytes 与 open 清单逐条核对后才 rename 成派生件。 */
async function streamPackFile(args: { fetcher: PackFetcher; url: string; token: string; file: PackSourceFile; target: string; signal: AbortSignal }) {
  const { fetcher, url, token, file, target, signal } = args
  const part = target + '.part'
  await mkdir(dirname(target), { recursive: true })
  let response: Response
  try { response = await packFetch(fetcher, url, { signal, headers: packHeaders(token) }, signal) } catch (error) { checkCancelled(signal); throw error }
  if (!response.ok) throw await packStatusError(response, 'stream')
  if (!response.body) throw packError('PACK_ENDPOINT_ERROR', `stream 无字节流: ${file.path}`)
  const sha = createHash('sha256')
  let bytes = 0
  const output = await openFile(part, 'w', 0o600)
  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = value as Uint8Array
      checkCancelled(signal)
      let written = 0
      while (written < chunk.byteLength) { const result = await output.write(chunk, written, chunk.byteLength - written); written += result.bytesWritten }
      sha.update(chunk)
      bytes += chunk.byteLength
      if (bytes > file.bytes) throw packError('PACK_INTEGRITY_MISMATCH', `${file.path} 超出 open 清单字节数`)
    }
  } finally { await output.close() }
  checkCancelled(signal)
  const sha256 = sha.digest('hex')
  if (bytes !== file.bytes || sha256 !== file.sha256) throw packError('PACK_INTEGRITY_MISMATCH', file.path)
  await rename(part, target)
  return { bytes, sha256, responseStatus: response.status }
}

/**
 * 经能力包端点取件（catalog→open→stream）并落盘到 policyDirectory 同族布局。
 * 全程只打我们的端点，无任何公开源回落；manifest 不记 URL。
 */
export async function downloadPack(input: PackDownloadInput) {
  const { modelId: id, packId } = packModelId(input.modelId)
  const revision = policyRevision(input.revision)
  const pieces = (input.pieces ?? PACK_PIECES).map(packPiece)
  const endpoint = packEndpoint(input.endpoint)
  const token = packBearer(input.token)
  if (!token) throw packError('PACK_TOKEN_MISSING', '需要环境变量 PACK_TOKEN 或既有账号会话 LYAPUNOV_ACCOUNT_TOKEN（或显式 token）')
  const fetcher: PackFetcher = input.fetcher ?? ((url, init) => fetch(url, init as RequestInit))
  const signal = input.signal
  const root = policyDirectory(input.dataDirectory, 'packs', id, revision)
  const manifestPath = join(root, 'manifest.json')
  await mkdir(root, { recursive: true })

  // 1) GET catalog：只作 packId 与 pieces 校验（不出字节、不出 URL）；与产品检索工具共用 packCatalog 入口
  const catalog = await packCatalog({ endpoint, token, fetcher, signal })
  const entry = (Array.isArray(catalog.packs) ? catalog.packs : []).map(asObject).find(row => row.packId === packId)
  if (!entry) throw packError('PACK_NOT_FOUND', `catalog 无 packId=${packId}`)
  for (const piece of pieces) if (asObject(entry.pieces)[piece] !== true) throw packError('PACK_PIECE_UNAVAILABLE', `${packId} 未提供 ${piece}`)

  // 2) POST open：拿 mount 快照清单（只有 path/bytes/sha256，无字节、无 URL）
  checkCancelled(signal)
  const opened = await packJSON(fetcher, `${endpoint}/open`, { method: 'POST', body: JSON.stringify({ packId, pieces }) }, token, signal, 'open')
  const mountId = typeof opened.mountId === 'string' ? opened.mountId : ''
  if (!mountId) throw packError('PACK_ENDPOINT_ERROR', 'open 响应缺 mountId')
  if (opened.packId !== undefined && opened.packId !== packId) throw packError('PACK_ENDPOINT_ERROR', 'open 响应 packId 与请求不符')
  const listing = Array.isArray(opened.files) ? opened.files : []
  if (listing.length === 0) throw packError('PACK_ENDPOINT_ERROR', 'open 清单为空')
  const sourceFiles: PackSourceFile[] = []
  for (const row of listing) {
    const file = asObject(row)
    const path = policyFile(file.path)
    const bytes = Number(file.bytes)
    const sha256 = typeof file.sha256 === 'string' ? file.sha256.toLowerCase() : ''
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !/^[a-f0-9]{64}$/.test(sha256)) throw packError('PACK_ENDPOINT_ERROR', `open 清单身份缺失: ${path}`)
    if (sourceFiles.some(existing => existing.path === path)) throw packError('PACK_ENDPOINT_ERROR', `open 清单重复路径: ${path}`)
    // revision 记 mount 快照（open 返回的绑定「用户+packId+文件清单」的清单快照）；不记任何 URL。
    sourceFiles.push({ path, bytes, sha256, revision: mountId })
  }
  const budget = asObject(opened.budget)
  const maxBytes = Number(budget.maxBytes)
  const totalBytes = sourceFiles.reduce((sum, file) => sum + file.bytes, 0)
  if (Number.isSafeInteger(maxBytes) && maxBytes > 0 && totalBytes > maxBytes) throw packError('PACK_BUDGET_EXCEEDED', `open 清单 ${totalBytes} 字节超出预算 ${maxBytes}`)

  const manifest: PackManifest = {
    status: 'DOWNLOADING', provider: 'packs', modelId: id, revision, resolvedRevision: mountId,
    metadata: {
      provider: 'packs', packId, requestedRevision: revision, pieces,
      mount: { mountId, expiresAt: typeof opened.expiresAt === 'string' ? opened.expiresAt : null, budget: Number.isSafeInteger(maxBytes) && maxBytes > 0 ? { maxBytes } : {} },
    },
    sourceFiles, files: [], transfers: [],
    execution: { status: 'BLOCKED', reason: '需匹配真实输入、动作语义和world版本后显式执行' },
    updatedAt: new Date().toISOString(),
  }
  const save = async () => { manifest.updatedAt = new Date().toISOString(); await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 }) }
  await save()
  const derived: string[] = []
  try {
    for (const file of sourceFiles) {
      checkCancelled(signal)
      const target = join(root, file.path)
      derived.push(target)
      const transfer = await streamPackFile({ fetcher, url: `${endpoint}/stream?${new URLSearchParams({ mount: mountId, path: file.path })}`, token, file, target, signal })
      manifest.transfers.push({ path: file.path, ...transfer })
      manifest.files.push({ ...file })
      await save()
    }
    manifest.status = 'DOWNLOADED'
    await save()
    return { ...manifest, path: root, manifestPath }
  } catch (error) {
    // 篡改即不可信：PACK_INTEGRITY_MISMATCH 时删除本次 mount 派生件（含 .part），不留来路不明的字节。
    if ((error as PackError)?.code === 'PACK_INTEGRITY_MISMATCH') {
      await Promise.all(derived.map(path => Promise.all([rm(path, { force: true }), rm(path + '.part', { force: true })])))
    }
    manifest.status = signal.aborted ? 'CANCELLED' : 'FAILED'
    manifest.error = String(error)
    await save()
    throw error
  }
}
