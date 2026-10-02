/**
 * 分享取件的**有界**联网口径（P8／2026-09-26，同一形状的第三处）。
 *
 * 与 `packages/policy-registry/src/source.ts` 的 `boundedFetch`（W25）和
 * `script/package-linux.ts` 的 `fetchMambaLicense`（W16）**同一形状**：
 * `AbortSignal.timeout(30_000)` × 3 次，瞬时故障才重试，失败抛五要素齐的错误。
 *
 * 为什么这一处也要有：`operations.ts` 的两个 fetch（`/v1/me` 身份、分享服务管理接口）此前
 * **只带调用方取消信号、自身没有超时** —— 上游服务挂起时，"取消"只能靠用户/外层超时来救，
 * 失败时也只有一句 `SHARE_AUTH_REQUIRED` / `SHARE_SERVICE_ERROR`，说不清走到哪一步、哪一次、
 * 还能不能重试。本模块把这三点补齐；**不新增任何配置面**（超时/次数不是用户参数，是固定口径）。
 *
 * 隐私纪律：Authorization 只在请求头里；错误消息、尝试轨迹、落盘诊断**都不含凭据**——
 * 上游正文只在 `request` 的 JSON 分支按既有形状提取 `error` 字段，不整段回显。
 */
export const SHARE_FETCH_TIMEOUT_MS = 30_000
export const SHARE_FETCH_ATTEMPTS = 3
/** 字节流「无数据到达」上限：整体耗时不设上限（发布整个会话 zip 可能几十 MB），但不允许静默干等。 */
export const SHARE_FETCH_STALL_MS = 30_000

/** 失败时"走到哪一步"（五要素之一）。 */
export type ShareFetchStep = '账户身份' | '发布分享' | '列出分享' | '撤销分享'
export interface ShareFetchAttempt { at: string; step: ShareFetchStep; url: string; attempt: number; ms: number; reason: string; retryable: boolean }

/** 上游 URL 可能带查询串（既有调用点目前没有，但不假设）：诊断只留 origin+path，不把可能的凭据带进错误。 */
const safeUrl = (url: string): string => {
  try { const parsed = new URL(url); return parsed.origin + parsed.pathname } catch { return url }
}
/** 失败原因留痕：名字 + code + 消息（压平换行、截断），**不回显请求头**。 */
const describeError = (error: unknown): string => {
  const name = (error as Error)?.name
  const code = (error as { code?: string })?.code
  const message = String((error as Error)?.message ?? error).replace(/\s+/g, ' ').trim()
  return [name && name !== 'Error' ? name : '', code ? `code=${code}` : '', message].filter(Boolean).join(' ').slice(0, 240) || '未知错误'
}
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
/** 上游**应答状态**是不是瞬时的（5xx/429/408/425）——两条调用点共用同一个判定，不再各有一套（R-fix#7）。 */
export function isTransientShareStatus(status: number): boolean { return TRANSIENT_STATUS.has(status) }
const TRANSIENT_CODE = /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN)$/
/** 瞬时故障才重试：超时/连接被断/网络不可达/上游 5xx。凭据、ID 格式、4xx 这类**不重试**（重试只会重复失败）。 */
export function isTransientShareFailure(error: unknown): boolean {
  if (isShareFetchError(error)) return false
  const name = (error as Error)?.name
  if (name === 'TimeoutError' || name === 'AbortError') return true
  if (TRANSIENT_CODE.test(String((error as { code?: string })?.code ?? ''))) return true
  return /(timeout|timed out|socket|closed unexpectedly|network|fetch failed|terminated|stall|停摆|ECONN|ETIMEDOUT|EPIPE|EAI_AGAIN|unreachable)/i.test(String((error as Error)?.message ?? error))
}

/** "这是一个有界取件的失败"的判定：**按形状**而不是 `instanceof`（同一个模块被两处入口各自打包时会是两个类对象）。 */
export function isShareFetchError(value: unknown): value is ShareFetchError {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.url === 'string' && typeof candidate.step === 'string'
    && typeof candidate.retryable === 'boolean' && Array.isArray(candidate.attempts)
}
/**
 * 分享取件失败的可诊断错误：五要素**在一条消息里齐**（上游 URL / 走到哪一步 / 每次尝试的原因 /
 * 可否重试，加上固定口径的尝试次数上界）——工具与 `/share_*` 命令的唯一失败出口就是这条消息。
 */
export class ShareFetchError extends Error {
  readonly url: string
  readonly step: ShareFetchStep
  readonly attempts: readonly ShareFetchAttempt[]
  readonly retryable: boolean
  constructor(input: { url: string; step: ShareFetchStep; attempts: readonly ShareFetchAttempt[]; retryable: boolean }) {
    super(shareFetchErrorMessage(input))
    this.name = 'ShareFetchError'
    this.url = input.url
    this.step = input.step
    this.attempts = input.attempts
    this.retryable = input.retryable
  }
}
const shareFetchErrorMessage = (input: { url: string; step: ShareFetchStep; attempts: readonly ShareFetchAttempt[]; retryable: boolean }): string => [
  `SHARE_FETCH_FAILED: 分享取件失败于「${input.step}」步骤（${input.attempts.length}/${SHARE_FETCH_ATTEMPTS} 次尝试后放弃；可否重试=${input.retryable}）`,
  `  上游 URL：${safeUrl(input.url)}`,
  `  每次尝试：${input.attempts.length ? input.attempts.map((attempt, index) => `${'①②③④⑤⑥'[index] ?? `#${index + 1}`}${attempt.step} ${attempt.ms}ms：${attempt.reason}`).join('；') : '（无）'}`,
  `  可否重试：${input.retryable ? 'true（瞬时网络故障：重试同一条命令即可）' : 'false（不是瞬时故障：先修正账户/服务地址/入参再试）'}`,
].join('\n')

/**
 * **每次尝试的上限**（`AbortSignal.timeout` 的等价物，但**可以解除**）：它只管到「拿到应答头」为止，
 * 之后由调用方 `clear()` ——正文改由 `readBoundedText` 的「无数据到达」窗口约束。
 *
 * 为什么不能直接用 `AbortSignal.timeout`：它一旦交给 `fetch` 就**不可解除**，到点会连同**正在到达**的正文
 * 一起掐断。P8 §2.1 声称「建连上限拿到应答头就用完、正文不设上限」，真 loopback 实测**不成立**
 * （应答头 7ms 到、正文每 100ms 一块，读取仍在 503ms 被 500ms 的尝试上限掐断）—— 这里把它改成真的成立。
 */
const attemptDeadline = (timeoutMs: number) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), timeoutMs)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}
/**
 * 与调用方 signal 合成的有界取件。超时口径/次数固化为 30s×3；`timeoutMs/attempts` **只给单测**用
 * （把机制压到毫秒级来证明机制）。**每次尝试的上限只覆盖「发出请求 → 拿到应答头」**（见 `attemptDeadline`）。
 * 瞬时故障（超时/连接被断/5xx）**两条调用点一律重试**到上界，然后抛五要素齐的 `ShareFetchError`
 * —— 不再有「只有身份取件重试 5xx」的不对称（R-fix#7）。
 * 返回 `{response, signal, attempts}`：`signal` 是**调用方取消信号**（读正文时用它，不是用完即废的建连信号）；
 * `attempts` 是已记录的失败轨迹（非瞬时路径里也有内容，供调用方原样落盘诊断）。
 */
export interface BoundedShareResponse { response: Response; signal: AbortSignal; attempts: readonly ShareFetchAttempt[] }
export async function boundedShareFetch(url: string, init: Omit<RequestInit, 'signal'> & { signal?: AbortSignal }, step: ShareFetchStep, options: { timeoutMs?: number; attempts?: number } = {}): Promise<BoundedShareResponse> {
  const { signal, ...rest } = init
  const timeoutMs = options.timeoutMs ?? SHARE_FETCH_TIMEOUT_MS
  const maxAttempts = options.attempts ?? SHARE_FETCH_ATTEMPTS
  if (!signal) throw new Error('SHARE_CANCELLATION_SIGNAL_REQUIRED')
  const failures: ShareFetchAttempt[] = []
  const record = (reason: string, retryable: boolean, attempt: number, ms: number) => {
    const entry: ShareFetchAttempt = { at: new Date().toISOString(), step, url: safeUrl(url), attempt, ms, reason, retryable }
    failures.push(entry)
    return entry
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal.aborted) throw signal.reason ?? new Error('SHARE_CANCELLED')
    const started = Date.now()
    let response: Response
    try {
      // 每次尝试各自 30s 上限，且**保留调用方取消语义**（两者任一触发都 abort）。
      const deadline = attemptDeadline(timeoutMs)
      try { response = await fetch(url, { ...rest, signal: AbortSignal.any([signal, deadline.signal]) }) }
      finally { deadline.clear() }   // 应答头已到 ⇒ 尝试上限解除：正文再慢也不由它掐断
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? new Error('SHARE_CANCELLED')
      const retryable = isTransientShareFailure(error)
      record(describeError(error), retryable, attempt, Date.now() - started)
      if (!retryable || attempt >= maxAttempts) throw new ShareFetchError({ url: safeUrl(url), step, attempts: failures, retryable })
      continue
    }
    if (isTransientShareStatus(response.status)) {
      // **瞬时的**（5xx/429/408/425）⇒ 一律重试；到上界抛五要素错误，「可否重试」=true（5xx 是瞬时故障）。
      record(`上游 HTTP ${response.status}`, true, attempt, Date.now() - started)
      try { await response.body?.cancel() } catch {}   // 丢掉这一次的应答体，不把连接吊在这儿
      if (attempt < maxAttempts) continue
      throw new ShareFetchError({ url: safeUrl(url), step, attempts: failures, retryable: true })
    }
    // 非瞬时的终端应答（4xx）也进轨迹：`attempts` 因此在**非瞬时路径**上同样有内容，不再是空数组。
    if (!response.ok) record(`上游 HTTP ${response.status}`, false, attempt, Date.now() - started)
    return { response, signal, attempts: failures }
  }
  throw new ShareFetchError({ url: safeUrl(url), step, attempts: failures, retryable: false })
}

/**
 * 应答体读取也纳入有界口径：连上了却**不再吐字节**的上游不许静默干等 —— 每个"无数据到达"窗口
 * （默认 30s）一到就抛 `SHARE_FETCH_STALL`。数据在到达（即使很慢）就不算停摆：整段耗时不设上限。
 */
export async function readBoundedText(response: Response, signal: AbortSignal, timeoutMs = SHARE_FETCH_TIMEOUT_MS): Promise<string> {
  const body = response.body
  if (!body) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = '', complete = false
  const stalled = () => new Error(`SHARE_FETCH_STALL: ${timeoutMs}ms 内没有收到任何数据`)
  try {
    for (;;) {
      // **每窗口竞速**：定时器与这一读各自独立。定时器先到就是"这段时间一个字节都没到" ⇒ 停摆。
      // 不能用建连那次 `AbortSignal.timeout` 判读正文——那个上限到"拿到应答头"就用完了（读得慢 ≠ 停摆）。
      let timer: ReturnType<typeof setTimeout> | undefined
      const read = reader.read()
      const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(stalled()), timeoutMs) })
      let part: ReadableStreamReadResult<Uint8Array>
      try { part = await Promise.race([read, timeout]) }
      catch (error) {
        read.catch(() => undefined)   // 竞速输掉的那一读已经没人接：吞掉它的拒绝，避免未处理拒绝
        throw error
      } finally { if (timer) clearTimeout(timer) }
      if (part.done) break
      text += decoder.decode(part.value, { stream: true })
    }
    complete = true
    return text + decoder.decode()
  } finally {
    // 正文没读完就失败/取消时释放底层连接（附带取消原因），不把句柄吊在那儿。
    if (!complete) { try { await reader.cancel(signal.reason) } catch {} }
    reader.releaseLock()
  }
}
