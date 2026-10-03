/**
 * P8（2026-09-26）：分享取件的**有界**联网 —— 与 W16（打包链 `fetchMambaLicense`）、
 * W25（取件链 `boundedFetch`）同一形状的第三处。
 *
 * 改前形态（实测盘点，见回执 §1）：`operations.ts` 的两个 fetch（`/v1/me` 身份、分享服务管理接口）
 * **只带调用方取消信号、自身没有超时**，失败只有一句 `SHARE_AUTH_REQUIRED` / `SHARE_SERVICE_ERROR`。
 *
 * 本文件钉住三件事：
 *  1. **有界**：不响应/不吐字节的上游在有界超时后失败，不无限等待（用 50ms 的测试口径证明机制，不是干等 30s）；
 *  2. **重试**：瞬时故障（超时/连接被断）重试至 3 次；4xx 不重试；调用方取消**立即传播且不重试**；
 *  3. **可诊断**：失败消息五要素齐（步骤如下＋上游 URL＋每次尝试的原因＋可否重试），
 *     并且发布链的取件失败按 `previewId` 落 `<私有根>/share-fetch-diag.jsonl`（会话结束后仍可查）。
 *
 * 网络一律用 global fetch 桩，不打真实网络；等待口径用构造参数压到毫秒级（生产调用点走 30s×3 默认值）。
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { ShareOperations, type ShareConfig } from '../src/operations.ts'
import { ShareFetchError, SHARE_FETCH_ATTEMPTS, type ShareFetchAttempt } from '../src/fetch.ts'
import { archiveDigest } from '../src/snapshot.ts'
import { PRIVATE_PREVIEW_PATH, registerPrivatePreview } from '../src/preview-route.ts'

const ACCOUNT_ID = 'acct-p8'
const TOKEN = 'p8-secret-token'
const ACCOUNT_URL = 'http://127.0.0.1:9/'
const SERVICE_URL = 'http://127.0.0.1:8'
const PREVIEW_ID = '11111111-2222-3333-4444-555555555555'
const SHARE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const TIMEOUT_MS = 50
/** 读正文的「无数据到达」上限：生产同为 30s；这里压到 200ms，与建连口径**分开**证明停摆这条路径本身。 */
const BODY_STALL_MS = 200

interface Diag { at: string; step: string; previewId?: string; url: string; error: string; retryable: boolean; attempts: ShareFetchAttempt[] }

/** `ctx` 只需要 `get`：credentials 桩让 `hasConfirmation` 认下这份预览的发布授权（与生产同一判定）。 */
const grantContext = (subject: Record<string, unknown>) => ({
  get: (name: string) => name === 'credentials'
    ? { readRecord: async () => ({ kind: 'grant', payload: { version: 1, decision: 'publish', questionId: 'q-p8', ...subject } }) }
    : undefined,
}) as any

const config = (privateRoot: string): ShareConfig => ({ mode: 'formal', privateRoot, serviceUrl: SERVICE_URL, accountId: ACCOUNT_ID, accountApiUrl: ACCOUNT_URL, tokenEnv: 'P8_TOKEN' })
const operations = (privateRoot: string, ctx: unknown = { get: () => undefined } as any) => new ShareOperations(ctx as any, config(privateRoot), { fetchTimeoutMs: TIMEOUT_MS, fetchAttempts: SHARE_FETCH_ATTEMPTS, bodyStallMs: BODY_STALL_MS })
/** `request`/`recordFetchDiagnostic` 是内部方法：这里按同一份实现调用，不复制逻辑。 */
const internals = (instance: ShareOperations) => instance as unknown as {
  request(path: string, init: RequestInit, token: string, signal: AbortSignal, previewId?: string): Promise<any>
  recordFetchDiagnostic(input: { step: string; error: unknown; previewId?: string }): Promise<void>
}
const diagEntries = (privateRoot: string): Diag[] => readFileSync(join(privateRoot, 'share-fetch-diag.jsonl'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line) as Diag)
/**
 * 取件诊断由发布链落盘（`operations.ts` 内部动作）：这里用**同一份实现**驱动它，
 * 目的是钉住"落盘诊断长什么样、按什么键检索"，而不是复制一份写入逻辑。
 */
const diagOf = (root: string, error: unknown, step: string, previewId: string) => internals(operations(root)).recordFetchDiagnostic({ step, error, previewId })

const withFetch = async (stub: typeof fetch, run: () => Promise<void>) => {
  const original = globalThis.fetch
  globalThis.fetch = stub
  try { await run() } finally { globalThis.fetch = original }
}
const emptyDir = () => mkdtempSync(join(tmpdir(), 'share-bounded-'))
const failure = async (run: Promise<unknown>) => await run.then(() => null, (reason: unknown) => reason as Error)
/** 永不回应答、只在 abort 时 reject —— 模拟"连上了但永远不回"。 */
const neverResponds = (async (_url: unknown, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true })
})) as unknown as typeof fetch

/**
 * 一份最小但**合法**的原生导出（`parseArchive` 认它），用于走发布链。
 *
 * **必须按字节可复现**：`fflate@0.8.3` 的 `zipSync` 默认把 `Date.now()` 写进 ZIP 头
 * （`f.mtime == null ? Date.now() : f.mtime`，DOS 时间戳粒度 **2 秒**），而 `archiveDigest` 是
 * **对 zip 字节**求 sha256（`snapshot.ts:9`）。本条用例里 `archive()` 会被调用两次（造预览一次、
 * 断言一次），两次只要跨过 2 秒边界就得到两个 digest ⇒ **红的是夹具不是产品**。
 * 实测（2026-09-26，本机）：200 连跑红 10 次（5%）；48 路合成负载下 200 连跑红 22 次（11%），
 * 失败那几次整文件耗时与全绿时一样（777–842ms vs 780–817ms，`bun` 的 5000ms 默认超时根本没碰到）。
 * 固定这个时间戳之后，digest 只由内容决定。
 */
const ARCHIVE_MTIME = new Date('2000-01-01T00:00:00Z')
const archive = () => {
  const log = [JSON.stringify({ type: 'session', id: 's1', version: 2 }), JSON.stringify({ seq: 0, type: 'message', data: { text: 'hi' } })].join('\n') + '\n'
  return new Uint8Array(zipSync({ 'session.v1.jsonl': new TextEncoder().encode(log) }, { mtime: ARCHIVE_MTIME }))
}
/** 造一份"已生成、已授权"的私有预览目录，返回它的 previewId 与发布授权 subject。 */
const preparedPreview = (privateRoot: string) => {
  const bytes = archive(), digest = archiveDigest(bytes), owner = `formal:${new URL(ACCOUNT_URL).origin}:${ACCOUNT_ID}`
  const directory = join(privateRoot, createHash('sha256').update(owner).digest('hex').slice(0, 32), 'previews', PREVIEW_ID)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'session.zip'), bytes)
  const preview = { previewId: PREVIEW_ID, owner, digest, sessionId: 's1', title: 'P8 会话分享', createdAt: new Date().toISOString(), includeDescendants: false }
  writeFileSync(join(directory, 'preview.json'), JSON.stringify(preview, null, 2))
  const subject = { previewId: PREVIEW_ID, digest, owner, serviceUrl: SERVICE_URL, title: preview.title }
  return { preview, subject, directory, receiptPath: join(directory, 'receipt.json'), diagPath: join(privateRoot, 'share-fetch-diag.jsonl') }
}

describe('P8 分享取件：有界超时 + 重试（不另造参数体系）', () => {
  test('负对照：上游不响应 ⇒ 有界超时后失败（用 50ms 证明机制），而不是无限等待', async () => {
    await withFetch(neverResponds, async () => {
      const started = Date.now()
      const error = await failure(internals(operations(emptyDir())).request('/v1/shares', { method: 'GET' }, TOKEN, new AbortController().signal))
      const elapsed = Date.now() - started
      expect(error).toBeInstanceOf(ShareFetchError)
      expect((error as ShareFetchError).attempts.length).toBe(SHARE_FETCH_ATTEMPTS)
      expect((error as ShareFetchError).retryable).toBe(true)
      expect(elapsed).toBeGreaterThanOrEqual(100)   // 至少两次超时
      expect(elapsed).toBeLessThan(3_000)           // 有界：不是 30s / 5min
      expect(String(error)).toContain('SHARE_FETCH_FAILED')
      expect(String(error)).toContain('列出分享')
      expect(String(error)).toContain(SERVICE_URL + '/v1/shares')
      expect(String(error)).toContain('TimeoutError')
      expect(String(error).match(/每次尝试：/g)?.length).toBe(1)
    })
  })

  test('身份取件同样有界：/v1/me 不响应 ⇒ 3 次各 50ms 后失败，步骤是「账户身份」', async () => {
    await withFetch(neverResponds, async () => {
      process.env.P8_TOKEN = TOKEN
      const started = Date.now()
      const error = await failure(operations(emptyDir()).identity(new AbortController().signal))
      const elapsed = Date.now() - started
      expect(error).toBeInstanceOf(ShareFetchError)
      expect((error as ShareFetchError).step).toBe('账户身份')
      expect((error as ShareFetchError).attempts.length).toBe(SHARE_FETCH_ATTEMPTS)
      expect(elapsed).toBeGreaterThanOrEqual(100)
      expect(elapsed).toBeLessThan(3_000)
      expect(String(error)).toContain('SHARE_FETCH_FAILED')
      expect(String(error)).toContain('上游 URL：' + ACCOUNT_URL.replace(/\/$/, '') + '/v1/me')
      expect(String(error)).toContain('可否重试：true')
    })
  })

  test('瞬时故障自动重试：前两次 socket 断开，第三次成功', async () => {
    let calls = 0
    const stub = (async () => {
      calls += 1
      if (calls < 3) throw new Error('The socket connection was closed unexpectedly.')
      return Response.json({ shares: [{ id: SHARE_ID }] })
    }) as unknown as typeof fetch
    await withFetch(stub, async () => {
      const result = await internals(operations(emptyDir())).request('/v1/shares', { method: 'GET' }, TOKEN, new AbortController().signal)
      expect(calls).toBe(3)
      expect(result.shares[0].id).toBe(SHARE_ID)
    })
  })

  test('非瞬时（4xx）不重试：一次请求即失败，错误保留上游 error 且带五要素', async () => {
    let calls = 0
    const stub = (async () => { calls += 1; return Response.json({ error: 'SHARE_QUOTA_EXCEEDED' }, { status: 403 }) }) as unknown as typeof fetch
    await withFetch(stub, async () => {
      const error = await failure(internals(operations(emptyDir())).request('/v1/shares', { method: 'DELETE' }, TOKEN, new AbortController().signal))
      expect(calls).toBe(1)
      expect(error).not.toBeInstanceOf(ShareFetchError)
      expect(String(error)).toContain('SHARE_QUOTA_EXCEEDED')
      expect(String(error)).toContain('上游 HTTP 403')
      expect(String(error)).toContain('撤销分享')
      expect(String(error)).toContain('上游 URL：' + SERVICE_URL + '/v1/shares')
      expect(String(error)).toContain('可否重试：false')
    })
  })

  test('调用方取消立即传播且不重试：错误是调用方的原因，不是 ShareFetchError', async () => {
    let calls = 0
    const stub = (async () => { calls += 1; throw new Error('The socket connection was closed unexpectedly.') }) as unknown as typeof fetch
    await withFetch(stub, async () => {
      const controller = new AbortController()
      controller.abort(new Error('SHARE_CANCELLED_BY_CALLER'))
      const error = await failure(internals(operations(emptyDir())).request('/v1/shares', { method: 'GET' }, TOKEN, controller.signal))
      expect(calls).toBe(0)
      expect(error).not.toBeInstanceOf(ShareFetchError)
      expect(String(error)).toContain('SHARE_CANCELLED_BY_CALLER')
    })
  })

  test('凭据不进错误与诊断：请求里真带上凭据，失败读数里一个字节都不出现', async () => {
    // R-fix#7：原用例断言的是 `p8-super-secret-token`，而请求里真正用的凭据是 `TOKEN`
    // （`P8_TOKEN` 注入）——断言的是一个**从未上过线**的字符串；而且单独跑（`P8_TOKEN` 未设）时
    // `identity()` 在联网前就抛 `SHARE_AUTH_REQUIRED`，0 次 fetch 也照样绿（**空过**）。
    // 现在：自己设 `P8_TOKEN`；先证明"真凭据确实在请求里上过线"，再断言它不出现在任何失败读数里。
    const root = emptyDir(), { subject } = preparedPreview(root), seen: string[] = []
    let calls = 0
    const stub = (async (input: unknown, init?: RequestInit) => {
      calls += 1
      seen.push(String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''))
      if (String(input).includes('/v1/me')) return Response.json({ user: { id: ACCOUNT_ID } })
      throw new Error('The socket connection was closed unexpectedly.')
    }) as unknown as typeof fetch
    process.env.P8_TOKEN = TOKEN
    await withFetch(stub, async () => {
      const app = new ShareOperations(grantContext(subject), config(root), { fetchTimeoutMs: TIMEOUT_MS, fetchAttempts: SHARE_FETCH_ATTEMPTS, bodyStallMs: BODY_STALL_MS })
      const error = await failure(app.publish({ previewId: PREVIEW_ID }, new AbortController().signal, { id: 'agent-p8' } as any))
      // ① 先钉住"凭据真的在途"（否则下面的"不含凭据"仍然是空过）
      expect(calls).toBeGreaterThan(0)
      expect(seen).toContain('Bearer ' + TOKEN)
      // ② 再钉住"它在失败读数里一个字节都不出现"（消息 + 落盘诊断）
      expect(String(error)).toContain('SHARE_FETCH_FAILED')
      expect(String(error)).not.toContain(TOKEN)
      expect(seen.join('\n')).toContain(TOKEN)   // 对照组：凭据确实出现在**请求头**里（探针本身有效）
      const diagnostic = readFileSync(join(root, 'share-fetch-diag.jsonl'), 'utf8')
      expect(diagnostic).not.toContain(TOKEN)
      expect(diagnostic).toContain('发布分享')   // 对照组：诊断确实写了这一次失败
    })
  })
})

describe('P8 发布链：取件失败可诊断、可事后检索', () => {
  test('身份取件失败 ⇒ 发布抛五要素错误，且按 previewId 落盘一次诊断（含每次尝试）', async () => {
    const root = emptyDir()
    const { preview, directory } = preparedPreview(root)
    let error: Error | null = null
    await withFetch(neverResponds, async () => {
      process.env.P8_TOKEN = TOKEN
      error = await failure(operations(root).publish({ previewId: PREVIEW_ID }, new AbortController().signal, { id: 'agent-p8' } as any))
      expect(error).toBeInstanceOf(ShareFetchError)
      expect((error as ShareFetchError).step).toBe('账户身份')
      const entries = diagEntries(root)
      expect(entries.length).toBe(1)
      expect(entries[0]!.step).toBe('账户身份')
      expect(entries[0]!.previewId).toBe(PREVIEW_ID)
      expect(entries[0]!.url).toBe(ACCOUNT_URL.replace(/\/$/, '') + '/v1/me')
      expect(entries[0]!.retryable).toBe(true)
      expect(entries[0]!.attempts.length).toBe(SHARE_FETCH_ATTEMPTS)
      expect(entries[0]!.attempts.every(attempt => attempt.retryable && typeof attempt.ms === 'number' && Date.parse(attempt.at) > 0)).toBe(true)
      expect(String(error)).toContain('SHARE_FETCH_FAILED')
      expect(String(error)).toContain('可否重试：true')
      // 对**盘上真实的** session.zip 求 digest：验的是落盘字节本身，而不是"再派生一份夹具"。
      expect(preview.digest).toBe(archiveDigest(new Uint8Array(readFileSync(join(directory, 'session.zip')))))
    })
  })

  test('发布 POST 失败 ⇒ 落盘诊断按 previewId 指向「发布分享」与 /v1/shares，且不重复记两条', async () => {
    const root = emptyDir()
    const { subject } = preparedPreview(root)
    let error: Error | null = null
    const stub = (async (input: unknown) => {
      const url = String(input)
      if (url.includes('/v1/me')) return Response.json({ user: { id: ACCOUNT_ID } })
      throw new Error('The socket connection was closed unexpectedly.')
    }) as unknown as typeof fetch
    await withFetch(stub, async () => {
      process.env.P8_TOKEN = TOKEN
      const app = new ShareOperations(grantContext(subject), config(root), { fetchTimeoutMs: TIMEOUT_MS, fetchAttempts: SHARE_FETCH_ATTEMPTS, bodyStallMs: BODY_STALL_MS })
      error = await failure(app.publish({ previewId: PREVIEW_ID }, new AbortController().signal, { id: 'agent-p8' } as any))
      expect(error).toBeInstanceOf(ShareFetchError)
      expect((error as ShareFetchError).step).toBe('发布分享')
      expect(String(error)).toContain('上游 URL：' + SERVICE_URL + '/v1/shares')
      const entries = diagEntries(root)
      expect(entries.length).toBe(1)
      expect(entries[0]!.step).toBe('发布分享')
      expect(entries[0]!.previewId).toBe(PREVIEW_ID)
      expect(entries[0]!.error).toContain('SHARE_FETCH_FAILED')
    })
  })

  test('发布成功（POST 前两次断开、第三次成功）⇒ 写 receipt.json，取件诊断保持空', async () => {
    const root = emptyDir()
    const { subject, receiptPath } = preparedPreview(root)
    let posts = 0
    const stub = (async (input: unknown) => {
      const url = String(input)
      if (url.includes('/v1/me')) return Response.json({ user: { id: ACCOUNT_ID } })
      posts += 1
      if (posts < 3) throw new Error('The socket connection was closed unexpectedly.')
      return Response.json({ id: SHARE_ID, url: 'http://127.0.0.1:8/s/' + SHARE_ID })
    }) as unknown as typeof fetch
    await withFetch(stub, async () => {
      process.env.P8_TOKEN = TOKEN
      const app = new ShareOperations(grantContext(subject), config(root), { fetchTimeoutMs: TIMEOUT_MS, fetchAttempts: SHARE_FETCH_ATTEMPTS, bodyStallMs: BODY_STALL_MS })
      const receipt = await app.publish({ previewId: PREVIEW_ID }, new AbortController().signal, { id: 'agent-p8' } as any)
      expect(posts).toBe(3)
      expect(receipt.id).toBe(SHARE_ID)
      expect(existsSync(join(root, 'share-fetch-diag.jsonl'))).toBe(false)   // 成功不留故障诊断
      expect(JSON.parse(readFileSync(receiptPath, 'utf8')).id).toBe(SHARE_ID)
    })
  })
})

describe('P8 应答体读取与诊断形状', () => {
  test('连上了但正文永不吐字节 ⇒ 读取同样有界（SHARE_FETCH_STALL），不静默干等', async () => {
    const stalls = (async (_url: unknown, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
        init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason ?? new Error('aborted')), { once: true })
      },
    }), { status: 200 })) as unknown as typeof fetch
    const root = emptyDir()
    const app = new ShareOperations({ get: () => undefined } as any, config(root), { fetchTimeoutMs: 300, fetchAttempts: 1, bodyStallMs: BODY_STALL_MS })
    await withFetch(stalls, async () => {
      const started = Date.now()
      const error = await failure(internals(app).request('/v1/shares', { method: 'GET' }, TOKEN, new AbortController().signal))
      const elapsed = Date.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(BODY_STALL_MS - 20)   // 真的等满了"无数据"窗口
      expect(elapsed).toBeLessThan(3_000)
      expect(String(error)).toContain('SHARE_FETCH_STALL')
      expect(String(error)).toContain('上游 URL：' + SERVICE_URL + '/v1/shares')
    })
  })

  test('落盘诊断的形状：五要素齐、字段是白名单（凭据/正文无处可落）、尝试带 ms/retryable/at', async () => {
    const root = emptyDir()
    const error = new ShareFetchError({
      url: SERVICE_URL + '/v1/shares',
      step: '列出分享',
      retryable: true,
      attempts: [
        { at: new Date().toISOString(), step: '列出分享', url: SERVICE_URL + '/v1/shares', attempt: 1, ms: TIMEOUT_MS, reason: 'TimeoutError code=23 The operation timed out.', retryable: true },
        { at: new Date().toISOString(), step: '列出分享', url: SERVICE_URL + '/v1/shares', attempt: 2, ms: TIMEOUT_MS, reason: 'TimeoutError code=23 The operation timed out.', retryable: true },
        { at: new Date().toISOString(), step: '列出分享', url: SERVICE_URL + '/v1/shares', attempt: 3, ms: TIMEOUT_MS, reason: 'TimeoutError code=23 The operation timed out.', retryable: true },
      ],
    })
    // 纯形状用例：只钉"一条取件失败落盘后长什么样、按什么键检索"，不掺网络（真失败自动留痕由上面两条覆盖）。
    await diagOf(root, error, '列出分享', PREVIEW_ID)
    const [entry] = diagEntries(root)
    expect(entry!.step).toBe('列出分享')
    expect(entry!.previewId).toBe(PREVIEW_ID)
    expect(entry!.url).toBe(SERVICE_URL + '/v1/shares')
    expect(entry!.retryable).toBe(true)
    expect(entry!.error).toContain('SHARE_FETCH_FAILED')
    expect(entry!.attempts.map(attempt => attempt.attempt)).toEqual([1, 2, 3])
    expect(entry!.attempts.map(attempt => attempt.reason).every(reason => reason.includes('TimeoutError'))).toBe(true)
    expect(entry!.attempts.every(attempt => Number.isFinite(attempt.ms) && attempt.ms >= 0)).toBe(true)
    expect(entry!.attempts.every(attempt => typeof attempt.at === 'string' && Date.parse(attempt.at) > 0)).toBe(true)
    // R-fix#7：原断言是 `JSON.stringify(entry)).not.toContain('p8-super-secret-token')` —— 那个字符串
    // 从来没进过这条形状（手搓的 error 里没有凭据），属**空过**。改成钉**字段白名单**：落盘只有这 7 个键，
    // 请求头 / 上游正文 / 其它任何东西都**没有可落的字段**（比"某个字符串不出现"更强，且不靠巧合）。
    expect(Object.keys(entry!).sort()).toEqual(['at', 'attempts', 'error', 'previewId', 'retryable', 'step', 'url'])
    expect(JSON.stringify(entry)).not.toContain(TOKEN)
    expect(entry!.url).not.toContain('?')   // 诊断只留 origin+path，查询串（可能带凭据）不进盘
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// R-fix#7（2026-09-26）：验收报告 `VERIFY-P8-SHARE-FETCH-20260926` 复核出的缺陷的回归用例。
// 全部网络仍是 fetch 桩；每一条的负对照见回执（还原该处修改 ⇒ 本组用例精确变红）。
// ─────────────────────────────────────────────────────────────────────────────

/** 应答头立刻到、吐一小块后**永不吐字节**；把 `init.signal` 接到 body 上（与真 fetch 同形）。 */
const stallsAfterFirstChunk = (async (_url: unknown, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('{'))
    init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason ?? new Error('aborted')), { once: true })
  },
}), { status: 200 })) as unknown as typeof fetch

/** 取消发生在**联网中**：fetch 先挂起，`abortAfterMs` 之后用调用方原因取消。 */
const cancelDuringFetch = async (run: (signal: AbortSignal) => Promise<unknown>, abortAfterMs = 20) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('SHARE_CANCELLED_BY_CALLER')), abortAfterMs)
  try { return await failure(run(controller.signal)) } finally { clearTimeout(timer) }
}

describe('R-fix#7 缺陷一：调用方取消**原样传播**（不被吞成 SHARE_AUTH_REQUIRED / 应答错误）', () => {
  test('identity() 三种时机取消 ⇒ 抛调用方原因，且 0 次 fetch（预先）/ 1 次 fetch（联网中、读正文中）', async () => {
    process.env.P8_TOKEN = TOKEN
    // ① 预先取消（改前 `identity()` 没有 try/catch ⇒ 原样传播；P8 之后被改写成 SHARE_AUTH_REQUIRED）
    let calls = 0
    const socketError = (async () => { calls += 1; throw new Error('The socket connection was closed unexpectedly.') }) as unknown as typeof fetch
    await withFetch(socketError, async () => {
      const controller = new AbortController()
      controller.abort(new Error('SHARE_CANCELLED_BY_CALLER'))
      const error = await failure(operations(emptyDir()).identity(controller.signal))
      expect(calls).toBe(0)
      expect(String(error)).toContain('SHARE_CANCELLED_BY_CALLER')
      expect(String(error)).not.toContain('SHARE_AUTH_REQUIRED')
    })
    // ② 联网中取消
    calls = 0
    const hanging = (async (_url: unknown, init?: RequestInit) => {
      calls += 1
      return await new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true }) })
    }) as unknown as typeof fetch
    await withFetch(hanging, async () => {
      const error = await cancelDuringFetch(signal => operations(emptyDir()).identity(signal))
      expect(calls).toBe(1)
      expect(String(error)).toContain('SHARE_CANCELLED_BY_CALLER')
      expect(String(error)).not.toContain('SHARE_AUTH_REQUIRED')
      expect(String(error)).not.toContain('SHARE_ACCOUNT_INVALID_RESPONSE')
    })
    // ③ 读正文中取消（应答头已到，正文永不吐字节）
    await withFetch(stallsAfterFirstChunk, async () => {
      const error = await cancelDuringFetch(signal => operations(emptyDir()).identity(signal))
      expect(String(error)).toContain('SHARE_CANCELLED_BY_CALLER')
      expect(String(error)).not.toContain('SHARE_ACCOUNT_INVALID_RESPONSE')
      expect(String(error)).not.toContain('SHARE_AUTH_REQUIRED')
    })
  })

  test('request() 联网中 / 读正文中取消 ⇒ 抛调用方原因；取消**不落故障诊断**（取消不是故障）', async () => {
    const root = emptyDir()
    await withFetch(neverResponds, async () => {
      const error = await cancelDuringFetch(signal => internals(operations(root)).request('/v1/shares', { method: 'GET' }, TOKEN, signal, PREVIEW_ID))
      expect(String(error)).toContain('SHARE_CANCELLED_BY_CALLER')
      expect(String(error)).not.toContain('SHARE_AUTH_REQUIRED')
    })
    await withFetch(stallsAfterFirstChunk, async () => {
      const error = await cancelDuringFetch(signal => internals(operations(root)).request('/v1/shares', { method: 'GET' }, TOKEN, signal, PREVIEW_ID))
      expect(String(error)).toContain('SHARE_CANCELLED_BY_CALLER')
      expect(String(error)).not.toContain('SHARE_SERVICE_INVALID_RESPONSE')
      expect(String(error)).not.toContain('SHARE_AUTH_REQUIRED')
    })
    expect(existsSync(join(root, 'share-fetch-diag.jsonl'))).toBe(false)   // 两次取消都没写故障诊断
  })
})

describe('R-fix#7 缺陷二：5xx/429 是**瞬时**的 —— 两条调用点都重试，且上报「可否重试：true」', () => {
  test('同一 503/429/504：request() 与 identity() 都 fetch 3 次、都报 true（不再只有 /v1/me 重试）', async () => {
    for (const status of [503, 429, 504]) {
      // 分享管理接口 = share_list / share_publish / share_revoke 的唯一出口
      const root = emptyDir()
      let calls = 0
      const stub = (async () => { calls += 1; return Response.json({ error: 'SHARE_SERVICE_BUSY' }, { status }) }) as unknown as typeof fetch
      await withFetch(stub, async () => {
        const error = await failure(internals(operations(root)).request('/v1/shares', { method: 'GET' }, TOKEN, new AbortController().signal, PREVIEW_ID))
        expect(calls).toBe(SHARE_FETCH_ATTEMPTS)
        expect(error).toBeInstanceOf(ShareFetchError)
        expect((error as ShareFetchError).retryable).toBe(true)
        expect((error as ShareFetchError).attempts.length).toBe(SHARE_FETCH_ATTEMPTS)
        expect((error as ShareFetchError).attempts.every(attempt => attempt.retryable)).toBe(true)
        expect(String(error)).toContain('可否重试：true')
        expect(String(error)).not.toContain('可否重试：false')
        expect(String(error)).toContain('上游 HTTP ' + status)
        expect(String(error)).toContain('列出分享')
        // 落盘诊断与消息给**同一个答案**（不是"消息说 true、盘上说 false"）
        const [entry] = diagEntries(root)
        expect(entry!.retryable).toBe(true)
        expect(entry!.attempts.length).toBe(SHARE_FETCH_ATTEMPTS)
        expect(entry!.url).toBe(SERVICE_URL + '/v1/shares')
      })
      // 身份取件（同一份判定，不再靠 `transientStatus` 这个开关）
      process.env.P8_TOKEN = TOKEN
      calls = 0
      await withFetch(stub, async () => {
        const error = await failure(operations(emptyDir()).identity(new AbortController().signal))
        expect(calls).toBe(SHARE_FETCH_ATTEMPTS)
        expect(error).toBeInstanceOf(ShareFetchError)
        expect((error as ShareFetchError).retryable).toBe(true)
        expect(String(error)).toContain('可否重试：true')
        expect(String(error)).toContain('账户身份')
      })
    }
  })

  test('5xx 在分享管理接口上**不再**被读成"不是瞬时故障"（一次即失败 + 可否重试：false 是错的答案）', async () => {
    const root = emptyDir()
    let calls = 0
    const stub = (async () => { calls += 1; return Response.json({ error: 'SHARE_SERVICE_BUSY' }, { status: 503 }) }) as unknown as typeof fetch
    await withFetch(stub, async () => {
      const error = await failure(internals(operations(root)).request('/v1/shares', { method: 'POST' }, TOKEN, new AbortController().signal))
      expect(calls).toBe(SHARE_FETCH_ATTEMPTS)          // 不是 1
      expect(String(error)).toContain('发布分享')
      expect(String(error)).toContain('可否重试：true')   // 不是 false
    })
  })
})

describe('R-fix#7 缺陷三：**非瞬时路径**的落盘诊断也带 url 与 attempts（不是 `url:""` + `attempts:[]`）', () => {
  test('403 ⇒ url 是上游 URL，attempts 含那条 403（一次即失败所以只有一条）', async () => {
    const root = emptyDir()
    let calls = 0
    const stub = (async () => { calls += 1; return Response.json({ error: 'SHARE_QUOTA_EXCEEDED' }, { status: 403 }) }) as unknown as typeof fetch
    await withFetch(stub, async () => {
      const error = await failure(internals(operations(root)).request('/v1/shares', { method: 'GET' }, TOKEN, new AbortController().signal, PREVIEW_ID))
      expect(calls).toBe(1)
      const [entry] = diagEntries(root)
      expect(entry!.url).toBe(SERVICE_URL + '/v1/shares')
      expect(entry!.retryable).toBe(false)
      expect(entry!.previewId).toBe(PREVIEW_ID)
      expect(entry!.attempts.length).toBe(1)
      expect(entry!.attempts[0]!.reason).toContain('上游 HTTP 403')
      expect(entry!.attempts[0]!.retryable).toBe(false)
      expect(entry!.attempts[0]!.url).toBe(SERVICE_URL + '/v1/shares')
      expect(String(error)).toContain('可否重试：false')
    })
  })

  test('应答读不完（SHARE_FETCH_STALL）⇒ url + 一条读取阶段的 attempts，retryable=true', async () => {
    const root = emptyDir()
    const app = new ShareOperations({ get: () => undefined } as any, config(root), { fetchTimeoutMs: 300, fetchAttempts: 1, bodyStallMs: BODY_STALL_MS })
    await withFetch(stallsAfterFirstChunk, async () => {
      const error = await failure(internals(app).request('/v1/shares', { method: 'GET' }, TOKEN, new AbortController().signal, PREVIEW_ID))
      expect(String(error)).toContain('SHARE_SERVICE_INVALID_RESPONSE')
      expect(String(error)).toContain('SHARE_FETCH_STALL')
      const [entry] = diagEntries(root)
      expect(entry!.url).toBe(SERVICE_URL + '/v1/shares')
      expect(entry!.retryable).toBe(true)
      expect(entry!.attempts.length).toBe(1)
      expect(entry!.attempts[0]!.reason).toContain('SHARE_FETCH_STALL')
      expect(entry!.attempts[0]!.retryable).toBe(true)
    })
  })

  test('应答不是 JSON ⇒ url + 一条应答阶段的 attempts（正文不进去，见缺陷五）', async () => {
    const root = emptyDir()
    const stub = (async () => new Response('<!doctype html><html>nginx</html>', { status: 200 })) as unknown as typeof fetch
    await withFetch(stub, async () => {
      const error = await failure(internals(operations(root)).request('/v1/shares', { method: 'GET' }, TOKEN, new AbortController().signal, PREVIEW_ID))
      expect(String(error)).toContain('不是 JSON')
      const [entry] = diagEntries(root)
      expect(entry!.url).toBe(SERVICE_URL + '/v1/shares')
      expect(entry!.retryable).toBe(false)
      expect(entry!.attempts.length).toBe(1)
      expect(entry!.attempts[0]!.reason).toContain('不是 JSON')
      expect(entry!.attempts[0]!.url).toBe(SERVICE_URL + '/v1/shares')
    })
  })
})

describe('R-fix#7 缺陷四：尝试上限只覆盖「发出请求 → 拿到应答头」，**不**绑在正文读取上', () => {
  test('应答头已到、正文在停摆窗口内持续到达（总耗时 > 尝试上限）⇒ 读得完，不被 TimeoutError 掐断', async () => {
    const parts = ['{"sha', 'res":[{"id":"', SHARE_ID, '"}]}']
    let calls = 0
    const slowBody = (async (_url: unknown, init?: RequestInit) => {
      calls += 1
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason ?? new Error('aborted')), { once: true })
          try {
            for (const part of parts) { await new Promise(resolve => setTimeout(resolve, 40)); controller.enqueue(new TextEncoder().encode(part)) }
            controller.close()
          } catch {}
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const app = new ShareOperations({ get: () => undefined } as any, config(emptyDir()), { fetchTimeoutMs: TIMEOUT_MS, fetchAttempts: 1, bodyStallMs: 1_000 })
    await withFetch(slowBody, async () => {
      const started = Date.now()
      const result = await internals(app).request('/v1/shares', { method: 'GET' }, TOKEN, new AbortController().signal)
      const elapsed = Date.now() - started
      expect(calls).toBe(1)
      expect(result.shares[0].id).toBe(SHARE_ID)
      expect(elapsed).toBeGreaterThan(TIMEOUT_MS)   // 正文总耗时**超过**每次尝试上限（160ms > 50ms）
      expect(elapsed).toBeLessThan(1_000)           // 且没触发「无数据到达」停摆窗口
    })
  })

  test('停摆窗口仍然有效：正文一个字节都不来 ⇒ SHARE_FETCH_STALL（上限解除 ≠ 读正文无界）', async () => {
    const root = emptyDir()
    const app = new ShareOperations({ get: () => undefined } as any, config(root), { fetchTimeoutMs: 5_000, fetchAttempts: 1, bodyStallMs: BODY_STALL_MS })
    await withFetch(stallsAfterFirstChunk, async () => {
      const started = Date.now()
      const error = await failure(internals(app).request('/v1/shares', { method: 'GET' }, TOKEN, new AbortController().signal))
      expect(Date.now() - started).toBeGreaterThanOrEqual(BODY_STALL_MS - 20)
      expect(String(error)).toContain('SHARE_FETCH_STALL')
    })
  })
})

describe('R-fix#7 缺陷五：上游**正文**不进错误与诊断（原回执声称有此用例，实测不存在）', () => {
  const BODY_SECRET = 'p8-upstream-body-secret'
  test('4xx 的 JSON 正文：只留上游 error 码，正文其余部分（含同名字段）不回显', async () => {
    const root = emptyDir()
    let calls = 0
    const stub = (async () => { calls += 1; return Response.json({ error: 'SHARE_QUOTA_EXCEEDED', detail: BODY_SECRET, echo: { token: BODY_SECRET } }, { status: 403 }) }) as unknown as typeof fetch
    await withFetch(stub, async () => {
      const error = await failure(internals(operations(root)).request('/v1/shares', { method: 'GET' }, TOKEN, new AbortController().signal, PREVIEW_ID))
      expect(calls).toBe(1)
      expect(String(error)).toContain('SHARE_QUOTA_EXCEEDED')   // 上游 error 码照留（既有语义）
      expect(String(error)).not.toContain(BODY_SECRET)          // 正文其余部分不回显
      const diagnostic = readFileSync(join(root, 'share-fetch-diag.jsonl'), 'utf8')
      expect(diagnostic).toContain('SHARE_QUOTA_EXCEEDED')
      expect(diagnostic).not.toContain(BODY_SECRET)
    })
  })

  test('5xx 的 JSON 正文：重试到上界抛五要素错误，正文**根本没被读**', async () => {
    const root = emptyDir()
    let calls = 0
    const stub = (async () => { calls += 1; return Response.json({ error: 'SHARE_SERVICE_BUSY', detail: BODY_SECRET }, { status: 503 }) }) as unknown as typeof fetch
    await withFetch(stub, async () => {
      const error = await failure(internals(operations(root)).request('/v1/shares', { method: 'GET' }, TOKEN, new AbortController().signal, PREVIEW_ID))
      expect(calls).toBe(SHARE_FETCH_ATTEMPTS)
      expect(error).toBeInstanceOf(ShareFetchError)
      expect(String(error)).not.toContain(BODY_SECRET)
      expect(readFileSync(join(root, 'share-fetch-diag.jsonl'), 'utf8')).not.toContain(BODY_SECRET)
    })
  })

  test('2xx 但正文不是 JSON：报文只说"不是 JSON"，不回显正文', async () => {
    const root = emptyDir()
    const stub = (async () => new Response('csrf-token=' + BODY_SECRET, { status: 200 })) as unknown as typeof fetch
    await withFetch(stub, async () => {
      const error = await failure(internals(operations(root)).request('/v1/shares', { method: 'GET' }, TOKEN, new AbortController().signal, PREVIEW_ID))
      expect(String(error)).toContain('不是 JSON')
      expect(String(error)).not.toContain(BODY_SECRET)
      expect(readFileSync(join(root, 'share-fetch-diag.jsonl'), 'utf8')).not.toContain(BODY_SECRET)
    })
  })
})

/** 按 `preview-route.ts` 的方式注册路由并取出 handler（`inject`/`effect` 用最小桩，不启 webServer）。 */
const previewRoute = (app: ShareOperations) => {
  let handler: ((request: Request) => Promise<Response>) | undefined
  const ctx = {
    inject: (_deps: string[], callback: (host: unknown) => void) => callback({
      effect: (effect: () => unknown) => effect(),
      connection: { fetch: { register: (route: { fetch: (request: Request) => Promise<Response> }) => { handler = route.fetch; return async () => {} } } },
    }),
  } as any
  registerPrivatePreview(ctx, app)
  if (!handler) throw new Error('SHARE_PREVIEW_ROUTE_NOT_REGISTERED')
  return handler
}
const previewCall = (signal: AbortSignal, digest = 'deadbeef') => new Request('http://127.0.0.1:4280' + PRIVATE_PREVIEW_PATH + '?' + new URLSearchParams({ previewId: PREVIEW_ID, digest }), { signal })

describe('R-fix#7 缺陷一（连带）：`preview-route` 的状态码映射（这条路径此前**无测试**）', () => {
  test('取消 ⇒ **404**（不是 401「要重新登录」）：错误是调用方原因原文', async () => {
    process.env.P8_TOKEN = TOKEN
    const app = new ShareOperations({ get: () => undefined } as any, config(emptyDir()), { fetchTimeoutMs: 5_000, fetchAttempts: SHARE_FETCH_ATTEMPTS, bodyStallMs: 5_000 })
    const handler = previewRoute(app)
    await withFetch(neverResponds, async () => {
      const controller = new AbortController()
      const pending = handler(previewCall(controller.signal))
      setTimeout(() => controller.abort(new Error('SHARE_CANCELLED_BY_CALLER')), 20)
      const response = await pending
      expect(response.status).toBe(404)
      const body = await response.json() as { error: string }
      expect(body.error).toContain('SHARE_CANCELLED_BY_CALLER')
      expect(body.error).not.toContain('SHARE_AUTH_REQUIRED')
      expect(body.error).not.toContain('SHARE_ACCOUNT_INVALID_RESPONSE')
    })
  })

  test('真认证失败 ⇒ 401（凭据缺失 / 上游 401 / 上游 403）', async () => {
    delete process.env.P8_ROUTE_UNSET_TOKEN
    const missingToken = new ShareOperations({ get: () => undefined } as any, { ...config(emptyDir()), tokenEnv: 'P8_ROUTE_UNSET_TOKEN' }, {})
    const missing = await previewRoute(missingToken)(previewCall(new AbortController().signal))
    expect(missing.status).toBe(401)
    expect((await missing.json() as { error: string }).error).toContain('SHARE_AUTH_REQUIRED')
    process.env.P8_TOKEN = TOKEN
    for (const status of [401, 403]) {
      const stub = (async () => Response.json({ error: 'SHARE_AUTH_REQUIRED' }, { status })) as unknown as typeof fetch
      await withFetch(stub, async () => {
        const response = await previewRoute(operations(emptyDir()))(previewCall(new AbortController().signal))
        expect(response.status).toBe(401)
      })
    }
  })

  test('预览不存在 ⇒ 404；上游 5xx ⇒ **不是 401**（5xx 不是认证问题），报文带「可否重试：true」', async () => {
    process.env.P8_TOKEN = TOKEN
    const okStub = (async () => Response.json({ user: { id: ACCOUNT_ID } })) as unknown as typeof fetch
    await withFetch(okStub, async () => {
      const response = await previewRoute(operations(emptyDir()))(previewCall(new AbortController().signal))
      expect(response.status).toBe(404)
      expect((await response.json() as { error: string }).error).toContain('SHARE_PREVIEW_NOT_FOUND')
    })
    let calls = 0
    const busy = (async () => { calls += 1; return Response.json({ error: 'SHARE_SERVICE_BUSY' }, { status: 503 }) }) as unknown as typeof fetch
    await withFetch(busy, async () => {
      const response = await previewRoute(operations(emptyDir()))(previewCall(new AbortController().signal))
      expect(calls).toBe(SHARE_FETCH_ATTEMPTS)
      expect(response.status).not.toBe(401)
      const body = await response.json() as { error: string }
      expect(body.error).toContain('可否重试：true')
      expect(body.error).not.toContain('SHARE_AUTH_REQUIRED')
    })
  })

  describe('该边角（R-fix#7 §5 ④）：**上游故障** ⇒ 503「服务暂时不可用」，不是 404「预览不存在」', () => {
    /**
     * 判别性来自两个事实同时成立：这份预览在**本地真的存在**、传的 digest 也**真的对**。
     * 所以下面 503 的每一条都不可能走"预览不存在"那条路 —— 每例都先用健康上游钉住 200 作对照。
     */
    test('上游 5xx/429 连答 3 次 ⇒ **503**（不是 404、不是 401）；同一份预览在健康上游下是 200', async () => {
      process.env.P8_TOKEN = TOKEN
      const root = emptyDir(), { preview } = preparedPreview(root)
      const handler = previewRoute(operations(root))
      const healthy = (async () => Response.json({ user: { id: ACCOUNT_ID } })) as unknown as typeof fetch
      await withFetch(healthy, async () => {
        const response = await handler(previewCall(new AbortController().signal, preview.digest))
        expect(response.status).toBe(200)                                  // 对照：预览在、digest 对 ⇒ 200
        expect(response.headers.get('content-type')).toContain('text/html')
      })
      for (const status of [500, 502, 503, 504, 429]) {
        let calls = 0
        const busy = (async () => { calls += 1; return Response.json({ error: 'SHARE_SERVICE_BUSY' }, { status }) }) as unknown as typeof fetch
        await withFetch(busy, async () => {
          const response = await handler(previewCall(new AbortController().signal, preview.digest))
          expect(calls).toBe(SHARE_FETCH_ATTEMPTS)                         // 固定口径 30s×3 未被改动
          expect(response.status).toBe(503)                                // ← 改前是 404
          const body = await response.json() as { error: string }
          expect(body.error).toContain('SHARE_FETCH_FAILED')
          expect(body.error).toContain(`上游 HTTP ${status}`)               // 上游真实状态码没被 503 抹掉
          expect(body.error).toContain('可否重试：true')                     // 状态码与报文同一个答案
          expect(body.error).not.toContain('SHARE_PREVIEW_NOT_FOUND')
          expect(body.error).not.toContain('SHARE_AUTH_REQUIRED')
        })
      }
    })

    test('上游连不上（socket 被断 / 超时）同属**瞬时**取件失败 ⇒ 同样是 503，不是 404', async () => {
      process.env.P8_TOKEN = TOKEN
      const refused = (async () => { throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' }) }) as unknown as typeof fetch
      await withFetch(refused, async () => {
        const response = await previewRoute(operations(emptyDir()))(previewCall(new AbortController().signal))
        expect(response.status).toBe(503)                                  // ← 改前是 404
        const body = await response.json() as { error: string }
        expect(body.error).toContain('ECONNREFUSED')
        expect(body.error).toContain('可否重试：true')
      })
    })

    /**
     * 分支**次序**用例：路由的旧判据是"消息正则 `/AUTH|ACCOUNT/`"，而诊断消息里带上游 URL ——
     * 只要 URL 里出现 `ACCOUNT`，上游 503 就会被抢成 401（"要重新登录"）。这正是本单要修的那一类误判，
     * 所以 5xx 分支必须**先于**那条正则判。
     */
    test('上游 503 且诊断消息里出现 `ACCOUNT`（账户 URL 路径）⇒ 仍是 503，不被 `/AUTH|ACCOUNT/` 抢成 401', async () => {
      process.env.P8_TOKEN = TOKEN
      const app = new ShareOperations({ get: () => undefined } as any, { ...config(emptyDir()), accountApiUrl: 'https://example.com/ACCOUNT/' }, { fetchTimeoutMs: TIMEOUT_MS, fetchAttempts: SHARE_FETCH_ATTEMPTS, bodyStallMs: BODY_STALL_MS })
      const busy = (async () => Response.json({ error: 'SHARE_SERVICE_BUSY' }, { status: 503 })) as unknown as typeof fetch
      await withFetch(busy, async () => {
        const response = await previewRoute(app)(previewCall(new AbortController().signal))
        const body = await response.json() as { error: string }
        expect(body.error).toContain('/ACCOUNT/v1/me')                     // 前提：消息里**真的**出现了 ACCOUNT（否则本用例空过）
        expect(response.status).toBe(503)                                  // ← 改前是 401
        expect(body.error).toContain('可否重试：true')
      })
    })
  })
})

/**
 * SHARE-STATUS-SHAPE（2026-09-26）：把"拿**消息内容**决定状态码"这一类收干净。
 *
 * 改前判据（一个字都不该再出现）：`/AUTH|ACCOUNT/.test(code)?401:/CHANGED/.test(code)?409:404` —— 在**整条**
 * 诊断消息里搜词，而这条消息的第二行就是上游 URL ⇒ 上游 503 会被抢成 401（R-fix#7 已修），
 * 上游 200 但正文不是 JSON（`SHARE_ACCOUNT_INVALID_RESPONSE`）**仍回 401**（R-fix#7 §7-2 发现未修，本单修）。
 * 改后判据：**形状**（`isShareFetchError` + `retryable`）在前，**错误码前缀**（`SHARE_XXX`）在后。
 *
 * 判别性口径（与上面那条边角一致）：每条都先钉住"同一份预览 + 健康上游 ⇒ 200"，所以下面拿到的非 2xx
 * 都不可能是"预览不存在"那条路；报文原文一并断言，保证状态码与报文说同一件事。
 */
describe('SHARE-STATUS-SHAPE：判据是**形状 + 错误码前缀**，不是消息文本（这一类收口）', () => {
  const healthy = (async () => Response.json({ user: { id: ACCOUNT_ID } })) as unknown as typeof fetch
  const html200 = (async () => new Response('<html>上游维护中</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch

  test('上游 200 但正文不是 JSON（`SHARE_ACCOUNT_INVALID_RESPONSE`）⇒ **502**（不是 401「要重新登录」、不是 404）', async () => {
    process.env.P8_TOKEN = TOKEN
    const root = emptyDir(), { preview } = preparedPreview(root)
    const handler = previewRoute(operations(root))
    await withFetch(healthy, async () => {
      const response = await handler(previewCall(new AbortController().signal, preview.digest))
      expect(response.status).toBe(200)                                    // 对照：预览在、digest 对 ⇒ 200
    })
    await withFetch(html200, async () => {
      const response = await handler(previewCall(new AbortController().signal, preview.digest))
      expect(response.status).toBe(502)                                    // ← 改前是 401
      const body = await response.json() as { error: string }
      expect(body.error).toContain('SHARE_ACCOUNT_INVALID_RESPONSE')
      expect(body.error).toContain('可否重试：false')                        // 状态码与报文同一个答案：非瞬时 ⇒ 不是 503
      expect(body.error).not.toContain('SHARE_AUTH_REQUIRED')
      expect(body.error).not.toContain('SHARE_PREVIEW_NOT_FOUND')
    })
  })

  /**
   * 本单的头号形态：**上游应答坏了**，却被说成"请重新登录"。两个触发条件同时在场 ——
   * ① 错误码含 `ACCOUNT`、② 诊断消息里带上游 URL（路径里也含 `ACCOUNT`）⇒ 旧判据必抢 401。
   */
  test('上游 200 非 JSON 且诊断消息里出现 `ACCOUNT`（账户 URL 路径）⇒ 仍是 502，不被 `/AUTH|ACCOUNT/` 抢成 401', async () => {
    process.env.P8_TOKEN = TOKEN
    const app = new ShareOperations({ get: () => undefined } as any, { ...config(emptyDir()), accountApiUrl: 'https://example.com/ACCOUNT/' }, { fetchTimeoutMs: TIMEOUT_MS, fetchAttempts: SHARE_FETCH_ATTEMPTS, bodyStallMs: BODY_STALL_MS })
    await withFetch(html200, async () => {
      const response = await previewRoute(app)(previewCall(new AbortController().signal))
      const body = await response.json() as { error: string }
      expect(body.error).toContain('/ACCOUNT/v1/me')                       // 前提：消息里**真的**出现了 ACCOUNT（否则本用例空过）
      expect(body.error).toContain('SHARE_ACCOUNT_INVALID_RESPONSE')
      expect(response.status).toBe(502)                                    // ← 改前是 401
    })
  })

  test('非瞬时取件失败（`retryable===false`：证书/地址这类重试也修不好的）⇒ **502**，不是 404、不是 503', async () => {
    process.env.P8_TOKEN = TOKEN
    let calls = 0
    const broken = (async () => { calls += 1; throw Object.assign(new TypeError('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) }) as unknown as typeof fetch
    await withFetch(broken, async () => {
      const response = await previewRoute(operations(emptyDir()))(previewCall(new AbortController().signal))
      expect(calls).toBe(1)                                                // 非瞬时 ⇒ 一次即失败（固定口径未被改动）
      expect(response.status).toBe(502)                                    // ← 改前是 404「预览不存在」
      const body = await response.json() as { error: string }
      expect(body.error).toContain('SHARE_FETCH_FAILED')
      expect(body.error).toContain('可否重试：false')                        // 报文说自己非瞬时 ⇒ 状态码不能是 503「稍后重试」
      expect(body.error).not.toContain('SHARE_PREVIEW_NOT_FOUND')
    })
  })

  test('本地配置错（账户 API 非 https 且非 loopback）⇒ **500**，不是 401「要重新登录」（0 次出网）', async () => {
    process.env.P8_TOKEN = TOKEN
    const app = new ShareOperations({ get: () => undefined } as any, { ...config(emptyDir()), accountApiUrl: 'http://example.com/' }, {})
    let calls = 0
    const counted = (async () => { calls += 1; return Response.json({ user: { id: ACCOUNT_ID } }) }) as unknown as typeof fetch
    await withFetch(counted, async () => {
      const response = await previewRoute(app)(previewCall(new AbortController().signal))
      expect(calls).toBe(0)                                                // 这一支在发请求之前就抛
      expect(response.status).toBe(500)                                    // ← 改前靠 `/AUTH/` 撞成 401
      expect((await response.json() as { error: string }).error).toContain('SHARE_AUTH_API_HTTPS_REQUIRED')
    })
  })

  test('登录账户与配置不符（`SHARE_ACCOUNT_CHANGED`）⇒ 仍是 **401**：消息里含 `ACCOUNT`，但判据不再靠这个词', async () => {
    process.env.P8_TOKEN = TOKEN
    const other = (async () => Response.json({ user: { id: 'someone-else' } })) as unknown as typeof fetch
    await withFetch(other, async () => {
      const response = await previewRoute(operations(emptyDir()))(previewCall(new AbortController().signal))
      expect(response.status).toBe(401)                                    // 既有 401 语义**未被吞掉**
      expect((await response.json() as { error: string }).error).toContain('SHARE_ACCOUNT_CHANGED')
    })
  })

  test('本地预览与元数据不一致（`SHARE_PREVIEW_CHANGED` 走 catch 那一支）⇒ 仍是 **409**', async () => {
    process.env.P8_TOKEN = TOKEN
    const root = emptyDir(), { preview, directory } = preparedPreview(root)
    const tampered = 'deadbeef' + preview.digest.slice(8)                  // 只改元数据里的 digest（文件字节不动）
    writeFileSync(join(directory, 'preview.json'), JSON.stringify({ ...preview, digest: tampered }, null, 2))
    await withFetch(healthy, async () => {
      const response = await previewRoute(operations(root))(previewCall(new AbortController().signal, tampered))
      expect(response.status).toBe(409)                                    // 既有 409 语义**未被吞掉**（且走的是 catch 而不是行内那一支）
      expect((await response.json() as { error: string }).error).toContain('SHARE_PREVIEW_CHANGED')
    })
  })

  test('兜底分支：形状丢了但码还在 ⇒ 502；码也没有 ⇒ 默认 404（取消那一条语义未动）', async () => {
    const statusOf = async (error: unknown) => (await previewRoute({ readPrivatePreview: async () => { throw error } } as any)(previewCall(new AbortController().signal))).status
    const shaped = Object.assign(new Error('SHARE_FETCH_FAILED: 取件失败（形状在场）'), { url: 'x', step: '账户身份', retryable: true, attempts: [] })
    expect(await statusOf(shaped)).toBe(503)                               // 形状在场 ⇒ 仍按 retryable 走 503/502 那一条
    expect(await statusOf(new Error('SHARE_FETCH_FAILED: 取件失败（形状丢失）'))).toBe(502)   // 形状不在、码在 ⇒ 兜底行，绝不落回 404
    expect(await statusOf(new Error('SHARE_CANCELLED_BY_CALLER'))).toBe(404)                 // 认不出的失败仍是 404（与改前逐字相同）
  })
})
