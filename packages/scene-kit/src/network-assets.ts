import { createHash, randomUUID } from "node:crypto"
import { lookup } from "node:dns/promises"
import { createWriteStream } from "node:fs"
import { Agent as HttpsAgent, request as httpsRequest, type RequestOptions } from "node:https"
import { proxyRouteFor } from "@deepseek-ai/dsh-http-proxy"
import type { ClientRequest, IncomingMessage } from "node:http"
import { isIP } from "node:net"
import { link, mkdir, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { Transform as StreamTransform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { pathToFileURL } from "node:url"
import type { Transform } from "../../lyapunov-contracts/src/types.ts"
import { glbJSON } from "./formats.ts"
import type { ResourceRecord } from "./resources.ts"
import type { SceneOperations } from "./operations.ts"
import type { PhysicalizeStrategy, PhysicalizeUsage } from "./physicalization.ts"

export interface NetworkAssetProvenance {
  sourceUrl: string
  fetchedAt: string
  sha256: string
  byteLength: number
  glbVersion: string
  contentType: string
  maxBytes: number
  redirectsFollowed: 0
  externalDependencies: 0
}

export interface NetworkGlbImportInput {
  url: string
  sceneId?: string
  name?: string
  resourceId?: string
  parentId?: string
  transform?: Transform
  /** 默认 64 MiB；调用者可以收紧，但不能超过这个上限。 */
  maxBytes?: number
  /** 碰撞派生透传（可选，缺席即旧行为）：physicalizeUsage 见 scene_import 的同一枚举；
   *  下载来的世界环境/建筑构件用 environment，下载来的物体用默认 dynamic。 */
  physicalize?: boolean
  physicalizeUsage?: PhysicalizeUsage
  physicalizeStrategy?: PhysicalizeStrategy
  physicalizeVoxelSizeM?: number
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
/** 无任何字节进展的停顿预算：连接/响应头等待与读体阶段共用，字节到达即重置。 */
const NETWORK_ASSET_TIMEOUT_MS = 30_000
/** 单次请求的绝对上限：与进展无关，防止极慢速淋浴用一字节/几十秒长期占用 socket（64 MiB 在 ≥73 KiB/s 内不受影响）。 */
const NETWORK_ASSET_TOTAL_TIMEOUT_MS = 15 * 60_000

/** 单次请求的等待预算覆盖，仅测试用于缩短停顿/总时长以确定性验证语义（生产留空用上面的默认值）。 */
export interface NetworkAssetTimeouts { stallMs?: number; totalMs?: number }

/**
 * 有界重试策略：只对**可判定的短暂网络/传输失败**（连接被重置、读体中断、超时、5xx、408/429、
 * 以及调用方校验发现的字节不完整）在首次请求之后再试 `retries` 次（缺省 2），第 n 次重试前退避
 * `backoffMs * 2^(n-1)`（封顶 maxBackoffMs）。退避期间响应取消。没有无限重试，也不建下载状态库。
 */
export interface NetworkAssetRetryPolicy { retries?: number; backoffMs?: number; maxBackoffMs?: number }
export const NETWORK_ASSET_RETRY_DEFAULTS = { retries: 2, backoffMs: 400, maxBackoffMs: 4_000 } as const

/** 明确"再试也一样"的错误：URL 预检/非法地址、格式与尺寸上限、重定向策略、缺依赖。 */
const PERMANENT_NETWORK_CODES = /^NETWORK_(URL_[A-Z_]+|ASSET_(SIZE_LIMIT|MIME_REJECTED|EXTERNAL_DEPENDENCY|REDIRECT_REJECTED|MAX_BYTES_INVALID))/
/**
 * 获取层的内容/格式**永久**错误（HTML 伪装、容器不符、扩展名与字节不符、PLY/ ZIP 结构坏等）：
 * 这些错误的字节已经在本地，重下一遍不会变；`verifyFile` 抛它们时不该被当成"短暂故障"再试。
 */
const PERMANENT_ACQUISITION_CODES = /^ASSET_ACQUISITION_(MIME_REJECTED|CONTAINER_MISMATCH|SPLAT_FORMAT_MISMATCH|UNRECOGNIZED_SPLAT|INVALID_PLY|SPLAT_FORMAT_UNSUPPORTED|ENTRY_NOT_FOUND|NO_ASSET_IN_ARCHIVE|ENTRY_REQUIRED|PATH_UNSAFE|NESTED_ARCHIVE_UNSUPPORTED)\b/
/** 连接/读体层的短暂故障码（Node 原生与 undici 两套命名都列）。 */
const TRANSIENT_SOCKET_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "ENETRESET", "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL",
  "EAI_AGAIN", "ENOTFOUND", "ERR_STREAM_PREMATURE_CLOSE", "ERR_SOCKET_CONNECTION_TIMEOUT",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
])
const TRANSIENT_SOCKET_TEXT = ["socket hang up", "other side closed", "premature close", "connection reset", "Stream closed", "ECONNRESET", "ETIMEDOUT"]
/** 读体层"这次没读全"的错误前缀：字节不完整是典型短暂故障，重连一次通常就好。 */
const TRANSIENT_MESSAGE_PREFIXES = ["NETWORK_ASSET_SIZE_MISMATCH"]

/**
 * 明确判定为"再连一次结果也一样"的失败：协议/权限/地址/格式/尺寸这类与网络抖动无关的错误。
 * HTTP 状态里 4xx 除 408/429 都算永久（401/403/404/410 重试毫无意义）。
 */
export function permanentNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (PERMANENT_NETWORK_CODES.test(error.message)) return true
  if (PERMANENT_ACQUISITION_CODES.test(error.message)) return true
  const http = /^NETWORK_ASSET_HTTP_(\d{3})/.exec(error.message)
  if (http) { const status = Number(http[1]); return status < 500 && status !== 408 && status !== 429 }
  return false
}

/**
 * 是否值得重试：**默认不重试**，只在能明确判定为短暂故障时才重试——永久失败
 * （HTTP 4xx 除 408/429、格式/尺寸/非法地址/重定向/缺依赖）一律不盲试第二遍。
 * 取消错误（AbortError）永远不重试：那是用户停的，不是网络坏了。
 */
export function transientNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error) || error.name === "AbortError" || permanentNetworkFailure(error)) return false
  const message = error.message
  const http = /^NETWORK_ASSET_HTTP_(\d{3})/.exec(message)
  if (http) { const status = Number(http[1]); return status === 408 || status === 429 || status >= 500 }
  if (message === "NETWORK_ASSET_TIMEOUT" || message === "NETWORK_ASSET_TOTAL_TIMEOUT") return true
  const code = (error as NodeJS.ErrnoException).code ?? ""
  if (TRANSIENT_SOCKET_CODES.has(code)) return true
  if (TRANSIENT_MESSAGE_PREFIXES.some(prefix => message.startsWith(prefix))) return true
  return TRANSIENT_SOCKET_TEXT.some(needle => message.includes(needle))
}

/** 退避等待：等待中 abort 立即以取消错误结束（不等满剩余退避）。 */
function waitBackoff(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((accept, reject) => {
    const active = signal
    const onAbort = (): void => { clearTimeout(timer); reject(abortError(active)) }
    const timer = setTimeout(() => { active?.removeEventListener("abort", onAbort); accept() }, ms)
    if (active) {
      if (active.aborted) return onAbort()
      active.addEventListener("abort", onAbort, { once: true })
    }
  })
}

export interface HostAddress { address: string; family: number }
/** 预检与真实连接必须使用同一个解析器；测试可注入以证明连接期核对。 */
export type HostResolver = (hostname: string) => Promise<HostAddress[]>
/** 默认解析器的唯一定义：asset-acquisition / environment-assets / reference-tools 都导入本实现。 */
export const defaultHostResolver: HostResolver = async hostname => (await lookup(hostname, { all: true, verbatim: true })).map(item => ({ address: item.address, family: item.family }))

/** URL.hostname 对 IPv6 字面量保留方括号，而 node/bun 的 net 层只接受不带方括号的 host。 */
function normalizeHostname(hostname: string): string { return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname }

/** 统一取消错误：调用方给了 Error 形式的 reason 就用它，否则也保证错误名为 AbortError。 */
function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  const error = new Error(reason === undefined ? "NETWORK_ASSET_ABORTED" : `NETWORK_ASSET_ABORTED: ${String(reason)}`)
  error.name = "AbortError"
  return error
}

/** 预检/解析等待无法把取消传给 getaddrinfo，只能竞速：abort 后立即失败，不等解析返回。 */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  return new Promise<T>((accept, reject) => {
    const onAbort = (): void => reject(abortError(signal))
    if (signal.aborted) return onAbort()
    signal.addEventListener("abort", onAbort, { once: true })
    work.then(value => { signal.removeEventListener("abort", onAbort); accept(value) }, error => { signal.removeEventListener("abort", onAbort); reject(error) })
  })
}

function privateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts as [number, number]
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
}

/** ::/96 与 ::ffff:0:0/96 的地址在连接时按嵌入的 IPv4 处理，展开成 8 段 hextet。 */
function expandIPv6(value: string): number[] | undefined {
  const [head = "", tail] = value.split("::")
  const left = head ? head.split(":") : [], right = tail === undefined ? [] : tail ? tail.split(":") : []
  const missing = 8 - left.length - right.length
  if (tail === undefined ? left.length !== 8 : missing < 0) return undefined
  const groups = [...left, ...Array<string>(Math.max(missing, 0)).fill("0"), ...right]
  if (!groups.every(group => /^[0-9a-f]{1,4}$/.test(group))) return undefined
  return groups.map(group => parseInt(group, 16))
}

function privateIPv6(address: string): boolean {
  const value = address.toLowerCase()
  if (value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:")) return true
  // 点分形式的 v4-mapped/兼容地址同样按嵌入的 IPv4 判定（::ffff:172.16.0.1 等旧写法只覆盖了三个前缀）。
  const dotted = value.match(/^::(?:ffff:)?((?:\d{1,3}\.){3}\d{1,3})$/)
  if (dotted) return privateIPv4(dotted[1]!)
  // 十六进制 v4-mapped/兼容形式（如 ::ffff:7f00:1）必须按嵌入的 IPv4 判定，否则私网地址会被当成公网。
  const groups = expandIPv6(value)
  if (!groups || groups.slice(0, 5).some(group => group !== 0) || (groups[5] !== 0xffff && groups[5] !== 0)) return false
  const [high, low] = groups.slice(6) as [number, number]
  return privateIPv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`)
}

function privateAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4 ? privateIPv4(address) : family === 6 ? privateIPv6(address) : true
}

/** 只允许匿名公网 HTTPS；DNS 预检与真实连接都使用同一个解析器。 */
export async function assertPublicHttpsURL(value: string, resolve: HostResolver = defaultHostResolver, signal?: AbortSignal): Promise<URL> {
  if (!URL.canParse(value)) throw new Error("NETWORK_URL_MUST_BE_ABSOLUTE")
  const url = new URL(value)
  if (url.protocol !== "https:") throw new Error("NETWORK_URL_MUST_USE_HTTPS")
  if (url.username || url.password) throw new Error("NETWORK_URL_MUST_NOT_INCLUDE_CREDENTIALS")
  const host = normalizeHostname(url.hostname.toLowerCase())
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error("NETWORK_URL_PRIVATE_HOST")
  if (isIP(host)) {
    if (privateAddress(host)) throw new Error("NETWORK_URL_PRIVATE_ADDRESS")
    return url
  }
  const addresses = await abortable(resolve(host), signal)
  if (!addresses.length || addresses.some(item => privateAddress(item.address))) throw new Error("NETWORK_URL_RESOLVES_TO_PRIVATE_ADDRESS")
  return url
}

/** 连接层逐地址复核：即使预检通过后解析结果改变，私网地址也不会被真正连接。 */
export function publicHttpsLookup(resolve: HostResolver): NonNullable<RequestOptions["lookup"]> {
  return ((hostname: string, options: { all?: boolean } | undefined, callback: (error: Error | null, address?: unknown, family?: number) => void): void => {
    resolve(normalizeHostname(hostname)).then(
      addresses => {
        if (!addresses.length || addresses.some(item => privateAddress(item.address))) return callback(new Error("NETWORK_URL_RESOLVES_TO_PRIVATE_ADDRESS"))
        if (options?.all) return callback(null, addresses)
        const first = addresses[0]!
        return callback(null, first.address, first.family)
      },
      error => callback(error instanceof Error ? error : new Error(String(error))),
    )
  }) as NonNullable<RequestOptions["lookup"]>
}

function headerValue(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value }

async function readBounded(declared: string | undefined, body: AsyncIterable<Uint8Array>, maxBytes: number, onProgress?: () => void, onBytes?: (count: number) => void): Promise<Buffer> {
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new Error("NETWORK_ASSET_SIZE_LIMIT")
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of body) {
    // 每个真实到达的字节块都算进展：停顿预算据此重置，慢但活的传输不会被墙钟总时长误杀。
    onProgress?.()
    size += chunk.byteLength
    // 计数在越限判定之前：这块字节真的从网上下来了，即使本次请求随后失败也必须算进真实下载量。
    onBytes?.(chunk.byteLength)
    if (size > maxBytes) throw new Error("NETWORK_ASSET_SIZE_LIMIT")
    chunks.push(Buffer.from(chunk))
  }
  // 声明了 content-length 就必须一字不差地读到：读体中断有时不以错误收场（HTTP/2 与客户端自身的
  // 重发都能把截断藏成"干净的短体"，39 号那次重试写出的坏图就是这么来的），只有这条长度对照能揭穿它。
  if (declared !== undefined && Number(declared) !== size) throw new Error(`NETWORK_ASSET_SIZE_MISMATCH: 声明 ${declared} 字节，实际读到 ${size}`)
  if (!size) throw new Error("NETWORK_ASSET_EMPTY_BODY")
  return Buffer.concat(chunks, size)
}

/** 读体钩子：onBytes 在每个真实到达的字节块上同步回调（用于按到达量而非成功量计费）。 */
export interface NetworkAssetReadHooks { onBytes?: (count: number) => void }

/** 传输层钩子：默认是真实 https 请求，测试用本机 HTTP 夹具替换（TLS 证书无法在本机信任）。 */
export type NetworkAssetTransport = (url: URL, options: RequestOptions, listener: (response: IncomingMessage) => void) => ClientRequest
const defaultTransport: NetworkAssetTransport = (url, options, listener) => httpsRequest(url, options, listener)

/** 默认 Accept：只要自包含 GLB 类二进制；调用方（图片/环境资产）可换自己的。 */
const DEFAULT_NETWORK_ASSET_ACCEPT = "model/gltf-binary, application/octet-stream"

/** 一次请求的连接方案：代理分支自带一个一次性 agent，dispose 必须在请求 settle 后调用（见 fetchPublicHttpsBytes 的 finally）。 */
interface ConnectionPlan { options: RequestOptions; dispose: () => void }

/**
 * 一次请求的连接选项，路由判定完全交给原生代理 owner（dsh-http-proxy），本函数不猜请求选项形状。
 * owner 说这条 URL 要走代理时，用 **Node 内建** https.Agent({ proxyEnv: owner 已发布到 process.env 的
 * 归一化策略快照 })：Node v24.20.0 的 _http_agent 只在 Agent 构造处消费 proxyEnv（parseProxyConfigFromEnv），
 * _http_client 不处理请求级 proxyEnv——把 proxyEnv 当 https.request 的普通选项不生效，不构成"走了代理"的证据。
 * 快照在本次请求时点取一次：即使 owner 随后 dispose/恢复环境，本次路由也不会被改写。
 * 代理分支**不能**带本地 lookup：此时连接目标是代理自身，逐地址复核会把代理地址（常见 127.0.0.1）判成私网而
 * 拒绝直连；SSRF 预检仍由调用方的 assertPublicHttpsURL 完成，隧道目标交给受信代理解析（与上游
 * dsh-web-fetch-http 的 requestVia 同一信任边界）。
 * owner 说直连时保持原有的连接期逐地址复核（lookup）。
 * 注意：本函数不做 SSRF 预检，调用方必须先用 assertPublicHttpsURL（importNetworkGlb 与 02 都是如此）。
 */
function connectionPlan(url: URL, resolve: HostResolver, acceptHeader: string): ConnectionPlan {
  const hostname = normalizeHostname(url.hostname)
  const headers = { accept: acceptHeader }
  if (proxyRouteFor(url).proxied) {
    const agent = new HttpsAgent({ proxyEnv: { ...process.env } })
    return { options: { method: "GET", hostname, headers, agent }, dispose: () => agent.destroy() }
  }
  return { options: { method: "GET", hostname, headers, lookup: publicHttpsLookup(resolve) }, dispose: () => undefined }
}

/**
 * 一次受控匿名 HTTPS GET，返回原始字节。这是本模块唯一的请求生命周期实现：
 * 失败/取消时销毁自己的 request+response 并清除监听与计时器（只 resume 不销毁等于把 socket
 * 交给远端决定何时关闭）；成功读完时不碰 request，避免误伤已归还连接池的连接。
 * 02 的多文件环境资产（.gltf/bin/纹理）复用本函数（经 fetchPublicHttpsBytesWithRetry 加有界重试），
 * 不再维护第二份易分叉的生命周期。
 * 用自持计时器而不是 AbortSignal：bun 既不派发 destroy 的 error 也不响应 setTimeout/AbortSignal。
 * 等待预算是两条口径：NETWORK_ASSET_TIMEOUT 只在 stallMs 内无任何字节进展时触发（每个数据块重臂），
 * NETWORK_ASSET_TOTAL_TIMEOUT 是与进展无关的绝对上限。timeouts 参数仅测试用于缩短两者。
 * readHooks.onBytes 在每个到达的字节块上回调，供调用方按真实到达量计费（失败尝试的字节也算）。
 */
export async function fetchPublicHttpsBytes(url: URL, resolve: HostResolver, maxBytes: number, transport: NetworkAssetTransport = defaultTransport, signal?: AbortSignal, acceptHeader = DEFAULT_NETWORK_ASSET_ACCEPT, timeouts: NetworkAssetTimeouts = {}, readHooks: NetworkAssetReadHooks = {}): Promise<{ bytes: Buffer; contentType: string }> {
  const plan = connectionPlan(url, resolve, acceptHeader)
  const stallMs = timeouts.stallMs ?? NETWORK_ASSET_TIMEOUT_MS
  const totalMs = timeouts.totalMs ?? NETWORK_ASSET_TOTAL_TIMEOUT_MS
  try {
    return await new Promise<{ bytes: Buffer; contentType: string }>((accept, reject) => {
      let settled = false
      let responseEnded = false
      let request: ClientRequest | undefined
      let response: IncomingMessage | undefined
      let stallTimer: ReturnType<typeof setTimeout> | undefined
      let totalTimer: ReturnType<typeof setTimeout> | undefined
      // 两个计时器一起清：停顿预算在每次进展时重臂，总预算全程不重臂。
      const stopTimers = (): void => { if (stallTimer !== undefined) clearTimeout(stallTimer); if (totalTimer !== undefined) clearTimeout(totalTimer) }
      const finish = (action: () => void): void => { if (settled) return; settled = true; stopTimers(); signal?.removeEventListener("abort", onAbort); action() }
      // 失败路径必须销毁自己的请求/响应并摘掉监听：只 resume 不销毁等于让远端决定何时关闭 socket，而计时器已在
      // settle 时清除，就再没有回收手段。响应正常读完时不碰 request，避免误伤已归还连接池的 socket。
      const fail = (error: Error): void => finish(() => { if (!responseEnded) { response?.destroy(); request?.destroy() }; reject(error) })
      const onAbort = (): void => fail(abortError(signal))
      // 停顿计时器：连接、响应头、首个字节与每个后续字节都重臂；只有「stallMs 内没有任何字节进展」才以
      // NETWORK_ASSET_TIMEOUT 结束——慢但持续推进的下载不再因为墙钟总时长超限而失败。
      const armStall = (): void => { if (settled) return; if (stallTimer !== undefined) clearTimeout(stallTimer); stallTimer = setTimeout(() => fail(new Error("NETWORK_ASSET_TIMEOUT")), stallMs) }
      // 绝对上限与进展无关：极慢速淋浴（例如一字节/几十秒）仍会在 totalMs 结束时被销毁。
      totalTimer = setTimeout(() => fail(new Error("NETWORK_ASSET_TOTAL_TIMEOUT")), totalMs)
      armStall()
      if (signal?.aborted) { onAbort(); return }
      signal?.addEventListener("abort", onAbort, { once: true })
      try {
        request = transport(url, plan.options, incoming => {
          if (settled) { incoming.destroy(); return }
          response = incoming
          armStall()
          incoming.once("end", () => { responseEnded = true })
          const status = incoming.statusCode ?? 0
          const contentType = headerValue(incoming.headers["content-type"]) ?? ""
          if (status >= 300 && status < 400) { fail(new Error(`NETWORK_ASSET_REDIRECT_REJECTED: ${status}`)); return }
          if (status < 200 || status >= 300) { fail(new Error(`NETWORK_ASSET_HTTP_${status}`)); return }
          readBounded(headerValue(incoming.headers["content-length"]), incoming, maxBytes, armStall, readHooks.onBytes).then(bytes => finish(() => accept({ bytes, contentType })), error => fail(error))
        })
        request.on("error", error => fail(error))
        request.end()
      } catch (error) {
        // transport 同步构造失败时也要停掉两个计时器：否则预算回调会在没有 request 的情况下触发。
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  } finally {
    // 自有 agent 的生命周期止于本次请求：成功与失败都在这里释放，绝不把它留给连接池拖到进程退出。
    plan.dispose()
  }
}

/** 带重试的一次请求：除传输参数外只有两个钩子——按到达字节计费的 onBytes 与读体后的字节校验 verify。 */
export interface NetworkAssetRetryRequest {
  transport?: NetworkAssetTransport
  signal?: AbortSignal
  acceptHeader?: string
  timeouts?: NetworkAssetTimeouts
  retry?: NetworkAssetRetryPolicy
  /** 每个真实到达字节块的计费回调（**含失败尝试**）；重试不会把它清零，也不会缩小已用额度。 */
  onBytes?: (count: number) => void
  /** 每次真实发起请求前回调（从 1 开始）：尝试次数由此精确计数，不必靠夹具命中次数反推。 */
  onAttempt?: (attempt: number) => void
  /** 读体完整后的调用方校验（字节数/md5/装配结构等）：失败即"这次取回的字节不可用"，默认按短暂故障重试。 */
  verify?: (bytes: Buffer, contentType: string) => void
}

/** attempts 是真实发出的请求数，retries = attempts - 1，transferredBytes 是本次调用所有尝试实际取回的字节合计。 */
export interface NetworkAssetRetryResult { bytes: Buffer; contentType: string; attempts: number; retries: number; transferredBytes: number }

/**
 * 有界恢复的唯一实现：在 fetchPublicHttpsBytes 之上加「判定 + 退避 + 重试」，不建下载状态库、不做断点续传。
 * 三条硬约束：
 * 1. 只重试可判定的短暂故障（transientNetworkFailure）；永久失败原样抛出，绝不盲试第二遍。
 * 2. 每次尝试的额度是 `maxBytes - 已取回字节`，且每个到达字节块都立刻计费——重试不能让预算归零重来。
 * 3. 退避可取消、读体可取消：abort 后不再发下一次请求（取消错误原样上抛，不包装成网络故障）。
 * verify 失败（例如 39 号那次重试写出 154038 字节的坏图）按"字节不可用"处理：非永久错误即可重试，同样受次数上限约束。
 */
export async function fetchPublicHttpsBytesWithRetry(url: URL, resolve: HostResolver, maxBytes: number, request: NetworkAssetRetryRequest = {}): Promise<NetworkAssetRetryResult> {
  const policy: Required<NetworkAssetRetryPolicy> = { ...NETWORK_ASSET_RETRY_DEFAULTS, ...request.retry }
  const retries = Math.max(0, Math.floor(policy.retries))
  const backoffMs = Math.max(0, policy.backoffMs)
  const maxBackoffMs = Math.max(backoffMs, policy.maxBackoffMs)
  const signal = request.signal
  const acceptHeader = request.acceptHeader ?? DEFAULT_NETWORK_ASSET_ACCEPT
  let transferred = 0
  const charge = (count: number): void => { transferred += count; request.onBytes?.(count) }
  // attempt 是刚失败的那一次：还能再试就必须 attempt ≤ retries，且退避期间照样响应取消。
  const retryOrThrow = async (error: unknown, integrity: boolean, attempt: number): Promise<void> => {
    if (signal?.aborted) throw abortError(signal)
    const retryable = integrity ? !permanentNetworkFailure(error) : transientNetworkFailure(error)
    if (!retryable || attempt > retries) throw error
    await waitBackoff(Math.min(backoffMs * 2 ** (attempt - 1), maxBackoffMs), signal)
  }
  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted()
    request.onAttempt?.(attempt)
    let fetched: { bytes: Buffer; contentType: string }
    try {
      // 额度按「总上限 - 已取回」收窄：重试拿到的不是新的一份 maxBytes，而是这次预算的剩余量。
      fetched = await fetchPublicHttpsBytes(url, resolve, Math.max(0, maxBytes - transferred), request.transport, signal, acceptHeader, request.timeouts, { onBytes: charge })
    } catch (error) {
      await retryOrThrow(error, false, attempt)
      continue
    }
    try {
      request.verify?.(fetched.bytes, fetched.contentType)
    } catch (error) {
      await retryOrThrow(error, true, attempt)
      continue
    }
    return { ...fetched, attempts: attempt, retries: attempt - 1, transferredBytes: transferred }
  }
}

/** 流式落地的结果：文件已按**不覆盖契约**提交到 path（本次新建），字节数/哈希/类型都来自真实流转。 */
export interface NetworkAssetFileResult { path: string; bytes: number; sha256: string; contentType: string; attempts: number; retries: number; transferredBytes: number }

/** 单次流式落地的钩子：verifyHeaders 只看到响应头（含 Content-Disposition，可用作格式提示）；verifyFile 看到**本次独占的临时文件**（提交前，见 attemptTempPath）。 */
export interface NetworkAssetFileHooks {
  /** 每个真实到达字节块的计费回调（**含失败尝试**）。 */
  onBytes?: (count: number) => void
  /** 响应头就绪、读体之前：类型/声明长度的预校验；第三参是原始响应头（如 content-disposition）。抛错按短暂/永久分类。 */
  verifyHeaders?: (contentType: string, declaredLength: number | undefined, headers: Record<string, string | string[] | undefined>) => void
  /** 字节全部落地后的内容校验（读文件头等）；收到的是**本次独占的临时路径**，不要按它的扩展名判格式（提交后才会叫目标名）。抛错按短暂/永久分类，失败会删除这次落地的临时件。 */
  verifyFile?: (path: string, contentType: string) => void | Promise<void>
}

/** 每次尝试独占的临时落地名：与目标同目录（同一文件系统，提交用硬链接），UUID 保证不与任何已有文件重名。 */
function attemptTempPath(destination: string): string {
  return join(dirname(destination), `.${basename(destination)}.${randomUUID()}.part`)
}

/**
 * 不覆盖提交：用硬链接在目标名上建立**新**目录项；目标已存在时 link 以 EEXIST 失败（绝不 rename 覆盖）。
 * 临时件与目标同目录 ⇒ 同一文件系统，link 不会退化成拷贝；提交成功后删掉临时名，只留目标名。
 */
async function commitExclusive(temp: string, destination: string): Promise<void> {
  try {
    await link(temp, destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`NETWORK_ASSET_DESTINATION_EXISTS: 目标文件已存在，本次不覆盖也不删除它：${destination}`)
    throw error
  }
  await rm(temp, { force: true }).catch(() => undefined)
}

/**
 * 一次受控匿名 HTTPS GET 并**流式写入 destination**（不解码、不整份进 Buffer/RAM）。
 * `destination` 必须是**本次调用独占创建**的临时路径（调用方按 UUID 生成，见 attemptTempPath）：
 *  · 写文件用 `flag:"wx"`——同名已存在时以 EEXIST 失败，本函数**绝不删除/覆盖**非本次创建的文件；
 *  · 任何失败/取消都会先销毁 response/request、等 pipeline 与 writer 真正关闭，再删掉本次临时件后上抛；
 *  · 清理只针对本次独占路径，迟到的清理不可能删到后续重试的文件。
 * 与 fetchPublicHttpsBytes 共享同一套连接方案/计时/取消/错误语义；区别只在读体落点。
 */
async function fetchPublicHttpsFileOnce(url: URL, resolve: HostResolver, maxBytes: number, destination: string, transport: NetworkAssetTransport = defaultTransport, signal?: AbortSignal, acceptHeader = DEFAULT_NETWORK_ASSET_ACCEPT, timeouts: NetworkAssetTimeouts = {}, hooks: NetworkAssetFileHooks = {}): Promise<{ bytes: number; sha256: string; contentType: string }> {
  const plan = connectionPlan(url, resolve, acceptHeader)
  const stallMs = timeouts.stallMs ?? NETWORK_ASSET_TIMEOUT_MS
  const totalMs = timeouts.totalMs ?? NETWORK_ASSET_TOTAL_TIMEOUT_MS
  try {
    return await new Promise<{ bytes: number; sha256: string; contentType: string }>((accept, reject) => {
      let settled = false
      let responseEnded = false
      let request: ClientRequest | undefined
      let response: IncomingMessage | undefined
      let writer: ReturnType<typeof createWriteStream> | undefined
      let writerClosed = false
      let pipelineDone: Promise<void> | undefined
      let stallTimer: ReturnType<typeof setTimeout> | undefined
      let totalTimer: ReturnType<typeof setTimeout> | undefined
      const stopTimers = (): void => { if (stallTimer !== undefined) clearTimeout(stallTimer); if (totalTimer !== undefined) clearTimeout(totalTimer) }
      // writer 是否真的关闭是"清理完成"的一部分：pipeline settle 后再等 close，保证 fd 已释放。
      const waitWriterClosed = (): Promise<void> => {
        if (!writer || writerClosed) return Promise.resolve()
        return new Promise<void>(resolve => { writer!.once("close", () => { writerClosed = true; resolve() }); writer!.destroy() })
      }
      // 失败路径：先拆连接与流，等 pipeline/writer 真正结束，再删本次独占临时件，最后才 reject。
      // destination 只可能是临时路径；目标路径之外的文件从不被触及，迟到的清理也只删这条临时名。
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        stopTimers()
        signal?.removeEventListener("abort", onAbort)
        void (async () => {
          try {
            if (!responseEnded) { response?.destroy(); request?.destroy() }
            if (pipelineDone) await pipelineDone.catch(() => undefined)
            await waitWriterClosed()
          } catch { /* 拆除失败不能掩盖原始错误 */ }
          await rm(destination, { force: true }).catch(() => undefined)
          reject(error)
        })()
      }
      const onAbort = (): void => fail(abortError(signal))
      const armStall = (): void => { if (settled) return; if (stallTimer !== undefined) clearTimeout(stallTimer); stallTimer = setTimeout(() => fail(new Error("NETWORK_ASSET_TIMEOUT")), stallMs) }
      totalTimer = setTimeout(() => fail(new Error("NETWORK_ASSET_TOTAL_TIMEOUT")), totalMs)
      armStall()
      if (signal?.aborted) { onAbort(); return }
      signal?.addEventListener("abort", onAbort, { once: true })
      try {
        request = transport(url, plan.options, incoming => {
          response = incoming
          armStall()
          incoming.once("end", () => { responseEnded = true })
          const status = incoming.statusCode ?? 0
          const contentType = headerValue(incoming.headers["content-type"]) ?? ""
          if (status >= 300 && status < 400) { fail(new Error(`NETWORK_ASSET_REDIRECT_REJECTED: ${status}`)); return }
          if (status < 200 || status >= 300) { fail(new Error(`NETWORK_ASSET_HTTP_${status}`)); return }
          const declared = headerValue(incoming.headers["content-length"])
          // 声明长度就先卡一次：省得为必然超限的文件白读一遍（与 readBounded 同一判据）。
          if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) { fail(new Error("NETWORK_ASSET_SIZE_LIMIT")); return }
          try { hooks.verifyHeaders?.(contentType, declared === undefined ? undefined : Number(declared), incoming.headers) } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return }
          const hash = createHash("sha256")
          let size = 0
          const meter = new StreamTransform({
            transform(chunk, _encoding, callback) {
              armStall()
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
              // 计数在越限判定之前：这块字节真的到手了，失败尝试也必须计费。
              size += bytes.length
              hooks.onBytes?.(bytes.length)
              if (size > maxBytes) { callback(new Error("NETWORK_ASSET_SIZE_LIMIT")); return }
              hash.update(bytes)
              callback(null, bytes)
            },
          })
          // wx 只可能创建本次独占的临时件；它若已存在（UUID 撞名）就报错，绝不改写已有文件。
          writer = createWriteStream(destination, { flags: "wx", mode: 0o600 })
          writer.once("close", () => { writerClosed = true })
          pipelineDone = pipeline(incoming, meter, writer)
          pipelineDone.then(() => {
            // 声明了 content-length 就必须一字不差：读体中断有时以"干净的短体"收场，只有长度对照能揭穿。
            if (declared !== undefined && Number(declared) !== size) return fail(new Error(`NETWORK_ASSET_SIZE_MISMATCH: 声明 ${declared} 字节，实际读到 ${size}`))
            if (!size) return fail(new Error("NETWORK_ASSET_EMPTY_BODY"))
            if (settled) return
            settled = true
            stopTimers()
            signal?.removeEventListener("abort", onAbort)
            accept({ bytes: size, sha256: hash.digest("hex"), contentType })
          }, error => fail(error instanceof Error ? error : new Error(String(error))))
        })
        request.on("error", error => fail(error))
        request.end()
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  } finally {
    plan.dispose()
  }
}

/**
 * 带**有界重试**的流式落地：与 fetchPublicHttpsBytesWithRetry 同一条判定/退避/额度语义，
 * 只是每次尝试写**独占临时文件**而不是返回 Buffer——大 3DGS 直链不再受单份 Buffer 或 64 MiB 通用上限约束。
 * 所有权生命周期：每次尝试用 attemptTempPath 建新临时件，失败/取消只删这一条；全部通过后按**不覆盖契约**
 * 用硬链接提交到 destination（已存在则报 NETWORK_ASSET_DESTINATION_EXISTS，不删不覆盖），再删临时名。
 * 重试用的是同一条剩余额度（`maxBytes - 已取回`），校验失败同样计一次尝试。
 */
export async function fetchPublicHttpsFileWithRetry(url: URL, resolve: HostResolver, maxBytes: number, destination: string, request: Omit<NetworkAssetRetryRequest, "verify"> & NetworkAssetFileHooks = {}): Promise<NetworkAssetFileResult> {
  const policy: Required<NetworkAssetRetryPolicy> = { ...NETWORK_ASSET_RETRY_DEFAULTS, ...request.retry }
  const retries = Math.max(0, Math.floor(policy.retries))
  const backoffMs = Math.max(0, policy.backoffMs)
  const maxBackoffMs = Math.max(backoffMs, policy.maxBackoffMs)
  const signal = request.signal
  const acceptHeader = request.acceptHeader ?? DEFAULT_NETWORK_ASSET_ACCEPT
  let transferred = 0
  const charge = (count: number): void => { transferred += count; request.onBytes?.(count) }
  const retryOrThrow = async (error: unknown, integrity: boolean, attempt: number): Promise<void> => {
    if (signal?.aborted) throw abortError(signal)
    const retryable = integrity ? !permanentNetworkFailure(error) : transientNetworkFailure(error)
    if (!retryable || attempt > retries) throw error
    await waitBackoff(Math.min(backoffMs * 2 ** (attempt - 1), maxBackoffMs), signal)
  }
  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted()
    request.onAttempt?.(attempt)
    // 本尝试独占的临时件：绝不碰已有目标，也绝不被上一次迟到的清理删到。
    const temp = attemptTempPath(destination)
    let fetched: { bytes: number; sha256: string; contentType: string }
    try {
      fetched = await fetchPublicHttpsFileOnce(url, resolve, Math.max(0, maxBytes - transferred), temp, request.transport, signal, acceptHeader, request.timeouts, { onBytes: charge, verifyHeaders: request.verifyHeaders })
    } catch (error) {
      // 单次实现已等 writer 关闭并删过；这里再兜底删一次（同一独占路径，不涉及后续尝试）。
      await rm(temp, { force: true }).catch(() => undefined)
      await retryOrThrow(error, false, attempt)
      continue
    }
    try {
      await request.verifyFile?.(temp, fetched.contentType)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      await retryOrThrow(error, true, attempt)
      continue
    }
    try {
      signal?.throwIfAborted()
      await commitExclusive(temp, destination)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
    return { path: destination, ...fetched, attempts: attempt, retries: attempt - 1, transferredBytes: transferred }
  }
}

function validateSingleFileGLB(bytes: Buffer, contentType: string) {
  if (!/^(model\/gltf-binary|application\/octet-stream)(?:\s*;|$)/i.test(contentType)) throw new Error(`NETWORK_ASSET_MIME_REJECTED: ${contentType || "missing"}`)
  const json = glbJSON(bytes)
  const external = [...json.buffers ?? [], ...json.images ?? []].filter(item => typeof item.uri === "string" && !item.uri.startsWith("data:"))
  if (external.length) throw new Error("NETWORK_ASSET_EXTERNAL_DEPENDENCY")
  return { glbVersion: String(json.asset.version), externalDependencies: 0 as const, meshCount: json.meshes?.length ?? 0, nodeCount: json.nodes?.length ?? 0 }
}

/**
 * signal 是调用方（Tools/Jobs 原生任务）唯一的取消入口：预检等待/连接/读体/落盘前/落盘后提交前可取消，abort 后不登记资源；提交点之后取消不回滚。
 * timeouts 是等待预算覆盖，只有测试注入（缩短停顿/总时长以确定性驱动超时语义）；生产留空用本模块默认值。
 * retry 省略即用 NETWORK_ASSET_RETRY_DEFAULTS（短暂故障最多再试 2 次）；显式给 {retries:0} 可关闭重试。
 */
export interface NetworkAssetDependencies { resolve?: HostResolver; transport?: NetworkAssetTransport; signal?: AbortSignal; timeouts?: NetworkAssetTimeouts; retry?: NetworkAssetRetryPolicy }

/**
 * 挂载目标先于下载检查：scene 不存在或父实体不存在时不该发起请求、也不该登记资源。
 * 02 的多文件环境资产导入复用本实现，不再维护第二份易分叉的检查。
 */
export async function assertMountTarget(operations: SceneOperations, sceneId?: string, parentId?: string): Promise<void> {
  if (!sceneId) return
  const snapshot = await operations.inspect(sceneId).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`SCENE_NOT_FOUND: ${sceneId}`)
    throw error
  })
  if (parentId && !snapshot.entities.some(entity => entity.entityId === parentId)) throw new Error(`PARENT_NOT_FOUND: ${parentId}`)
}

/** authority 一旦已有记录指向落地文件，该文件就是已提交数据，清理绝不能删它；02 的环境资产导入复用本实现。 */
export async function landingIsRegistered(operations: SceneOperations, path: string): Promise<boolean> {
  const uri = pathToFileURL(path).href
  const { records } = await operations.resources.authoritySnapshot()
  return records.some(record => [record.ref.original, ...record.ref.representations].some(item => item.uri === uri))
}

/** 下载一个自包含 GLB，隔离落地后复用 ResourceLibrary/SceneOperations 的导入与校验。 */
export async function importNetworkGlb(operations: SceneOperations, input: NetworkGlbImportInput, dependencies: NetworkAssetDependencies = {}): Promise<{ resource: ResourceRecord; provenance: NetworkAssetProvenance; verification: { valid: boolean; missing: string[]; changed: string[] }; snapshot?: Awaited<ReturnType<SceneOperations["inspect"]>>; entityId?: string }> {
  const maxBytes = Math.min(input.maxBytes ?? DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES)
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("NETWORK_ASSET_MAX_BYTES_INVALID")
  const signal = dependencies.signal
  signal?.throwIfAborted()
  const resolve = dependencies.resolve ?? defaultHostResolver
  const url = await assertPublicHttpsURL(input.url, resolve, signal)
  await assertMountTarget(operations, input.sceneId, input.parentId)
  signal?.throwIfAborted()
  // 中途断流/超时这类短暂故障有界重试：字节不完整时宁可再连一次，也不把半截 GLB 当成品登记。
  const { bytes, contentType } = await fetchPublicHttpsBytesWithRetry(url, resolve, maxBytes, { transport: dependencies.transport, signal, timeouts: dependencies.timeouts, retry: dependencies.retry })
  // 提交点之前的硬保证：abort 之后既不落地文件也不进入 authority 事务。
  signal?.throwIfAborted()
  const parsed = validateSingleFileGLB(bytes, contentType)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const fetchedAt = new Date().toISOString()
  const provenance: NetworkAssetProvenance = { sourceUrl: url.href, fetchedAt, sha256, byteLength: bytes.length, glbVersion: parsed.glbVersion, contentType: contentType.split(";", 1)[0]!.trim().toLowerCase(), maxBytes, redirectsFollowed: 0, externalDependencies: parsed.externalDependencies }
  // 下载落地跟随 cache 域：省略 layout 时仍是 <dataRoot>/resources/network。
  const landingRoot = join(operations.resources.downloadRoot, randomUUID())
  const path = join(landingRoot, "asset.glb")
  await mkdir(landingRoot, { recursive: true, mode: 0o700 })
  try {
    // 落盘前的取消闸：取消后不再写入文件。
    signal?.throwIfAborted()
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" })
    // writeFile 之后、首次 authority 提交（operations.import）前的最后一道取消闸：用户写入期间取消也绝不登记
    // 资产（02 同类已整改，保持语义一致）；此时文件尚未提交，未登记的落地目录由下面的 catch 清理。
    // 提交点之后取消不再回滚（已登记文件绝不能被删，见 CR-006）。
    signal?.throwIfAborted()
    const imported = await operations.import({
      path, sceneId: input.sceneId, name: input.name, resourceId: input.resourceId, parentId: input.parentId, transform: input.transform,
      source: { units: "m", upAxis: "Y", handedness: "right", metersPerUnit: 1 }, networkProvenance: provenance,
      ...(input.physicalize !== undefined ? { physicalize: input.physicalize } : {}),
      ...(input.physicalizeUsage ? { physicalizeUsage: input.physicalizeUsage } : {}),
      ...(input.physicalizeStrategy ? { physicalizeStrategy: input.physicalizeStrategy } : {}),
      ...(input.physicalizeVoxelSizeM !== undefined ? { physicalizeVoxelSizeM: input.physicalizeVoxelSizeM } : {}),
    })
    const verification = await operations.resources.verify(imported.resource.ref.resourceId, imported.resource.ref.version)
    if (!verification.valid) throw new Error(`NETWORK_ASSET_VERIFY_FAILED: ${JSON.stringify(verification)}`)
    return { ...imported, provenance, verification }
  } catch (error) {
    // 清理只针对尚未提交的落地文件；已登记的文件删除后会留下悬空 authority 记录。
    const registered = await landingIsRegistered(operations, path).catch(() => true)
    if (!registered) await rm(landingRoot, { recursive: true, force: true })
    throw error
  }
}

export { DEFAULT_MAX_BYTES as NETWORK_ASSET_MAX_BYTES }
