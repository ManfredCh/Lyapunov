/**
 * W25（2026-09-26）：取件链的**有界**联网 —— 与 `script/package-linux.ts:fetchMambaLicense` 同一形状。
 *
 * 同一形状的两次静默：W16（打包链取 micromamba LICENSE，裸 `fetch` 静默 5 分钟）与
 * W25（取件链 `downloadPolicy`：Go2 `TimeoutError` 300004ms、Go1 `socket connection was closed
 * unexpectedly` 1998ms）。本文件钉住"这一类"的三件事：
 *  1. **有界**：不响应的上游在有界超时后失败，不无限等待（用 50ms 的测试超时证明机制，不是 30s 干等）；
 *  2. **重试**：瞬时故障（超时/连接被断/5xx/停摆）自动重试至 3 次，非瞬时（404）不重试；
 *  3. **可诊断**：失败消息五要素齐（上游 URL / 来源坐标 / 走到哪一步 / 每次尝试的原因 / 可否重试），
 *     且失败尝试以 `kind:'attempt-failed'` 落进 `manifest.transfers`（与"逐件传输结果"可区分）。
 *
 * 网络一律用 global fetch 桩，不打真实网络。
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  boundedFetch, downloadFile, downloadPolicy, newPolicyFetchTrace, PolicyFetchError,
  POLICY_FETCH_ATTEMPTS, type PolicyManifest,
} from '../src/source.ts'

const withFetch = async (stub: typeof fetch, run: () => Promise<void>) => {
  const original = globalThis.fetch
  globalThis.fetch = stub
  try { await run() } finally { globalThis.fetch = original }
}
const emptyDir = () => mkdtempSync(join(tmpdir(), 'policy-bounded-'))
const manifestOf = (root: string) => JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as PolicyManifest
/** 永不回应答、只在 abort 时 reject —— 模拟"连上了但永远不回"。 */
const neverResponds = (async (_url: unknown, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true })
})) as unknown as typeof fetch

describe('W25 有界取件：boundedFetch', () => {
  test('负对照：上游不响应 ⇒ 有界超时后失败（用 50ms 证明机制），而不是无限等待', async () => {
    await withFetch(neverResponds, async () => {
      const started = Date.now()
      const error = await boundedFetch('https://upstream.invalid/x', {}, { step: '建连', timeoutMs: 50, attempts: POLICY_FETCH_ATTEMPTS }).then(() => null, (reason: Error) => reason)
      const elapsed = Date.now() - started
      expect(error).toBeInstanceOf(PolicyFetchError)
      expect((error as PolicyFetchError).attempts.length).toBe(POLICY_FETCH_ATTEMPTS)
      expect((error as PolicyFetchError).retryable).toBe(true)
      expect(elapsed).toBeGreaterThanOrEqual(100)   // 至少两次超时
      expect(elapsed).toBeLessThan(5_000)           // 有界：不是 30s/5min
      expect(String(error)).toContain('POLICY_FETCH_FAILED')
      expect(String(error)).toContain('TimeoutError')
    })
  })

  test('瞬时故障自动重试：前两次 socket 断开，第三次成功；失败尝试留在 trace 里', async () => {
    let calls = 0
    const stub = (async () => { calls += 1; if (calls < 3) throw new Error('The socket connection was closed unexpectedly.'); return new Response('ok', { status: 200 }) }) as unknown as typeof fetch
    await withFetch(stub, async () => {
      const trace = newPolicyFetchTrace({ provider: 'github', modelId: 'a/b', revision: 'main' })
      const response = await boundedFetch('https://upstream.invalid/x', {}, { step: '建连', trace })
      expect(response.status).toBe(200)
      expect(calls).toBe(3)
      expect(trace.attempts.length).toBe(2)
      expect(trace.attempts.every(attempt => attempt.retryable)).toBe(true)
      expect(trace.attempts[0]!.reason).toContain('socket connection was closed unexpectedly')
    })
  })

  test('非瞬时（404）不重试：一次请求即返回，交给调用方按来源语义报错', async () => {
    let calls = 0
    const stub = (async () => { calls += 1; return new Response('nope', { status: 404 }) }) as unknown as typeof fetch
    await withFetch(stub, async () => {
      const response = await boundedFetch('https://upstream.invalid/x', {}, { step: '解析 source' })
      expect(response.status).toBe(404)
      expect(calls).toBe(1)
    })
  })

  test('瞬时状态码（503）重试到上限后抛可诊断错误（带 HTTP 状态与尝试次数）', async () => {
    let calls = 0
    const stub = (async () => { calls += 1; return new Response('busy', { status: 503 }) }) as unknown as typeof fetch
    await withFetch(stub, async () => {
      const error = await boundedFetch('https://upstream.invalid/x', {}, { step: '解析 source' }).then(() => null, (reason: Error) => reason)
      expect(calls).toBe(POLICY_FETCH_ATTEMPTS)
      expect(error).toBeInstanceOf(PolicyFetchError)
      expect(String(error)).toContain('上游 HTTP 503')
      expect((error as PolicyFetchError).retryable).toBe(true)
    })
  })

  test('停摆也重试：字节流 50ms 无数据 ⇒ 每次尝试都失败并留痕（3 次后放弃）', async () => {
    const stub = (async (_url: unknown, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) { // 永不入队：只把 abort 接到流上（真实 fetch 就是这样让 body 迭代抛出的）
        init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason ?? new Error('aborted')), { once: true })
      },
    }), { status: 200 })) as unknown as typeof fetch
    await withFetch(stub, async () => {
      const trace = newPolicyFetchTrace({ provider: 'modelscope', modelId: 'unitree/unitree_go1', revision: 'master' })
      const file = { path: 'params/x.bin', bytes: 4, revision: 'r', sha256: 'a'.repeat(64), url: 'https://upstream.invalid/x.bin' }
      const error = await downloadFile(file, join(emptyDir(), 'x.bin'), new AbortController().signal, false, trace, { stallMs: 50 }).then(() => null, (reason: Error) => reason)
      expect(error).toBeInstanceOf(PolicyFetchError)
      expect((error as PolicyFetchError).step).toBe('逐件下载')
      expect((error as PolicyFetchError).attempts.length).toBe(POLICY_FETCH_ATTEMPTS)
      expect(String(error)).toContain('POLICY_DOWNLOAD_STALL')
      expect(trace.attempts.length).toBe(POLICY_FETCH_ATTEMPTS)
    })
  })

  test('调用方取消不重试：立即按取消传播，错误不是 PolicyFetchError', async () => {
    let calls = 0
    const stub = (async () => { calls += 1; throw new Error('The socket connection was closed unexpectedly.') }) as unknown as typeof fetch
    await withFetch(stub, async () => {
      const controller = new AbortController()
      controller.abort(new Error('POLICY_CANCELLED'))
      const error = await boundedFetch('https://upstream.invalid/x', { signal: controller.signal }, { step: '建连' }).then(() => null, (reason: Error) => reason)
      expect(calls).toBe(0)
      expect(error).not.toBeInstanceOf(PolicyFetchError)
      expect(String(error)).toContain('POLICY_CANCELLED')
    })
  })
})

describe('W25 取件链：失败可诊断 + 尝试留痕（downloadPolicy）', () => {
  const sourceBody = (files: Array<{ Path: string; Revision: string; Sha256: string; Size: number; Type: string }>) => JSON.stringify({ Success: true, Code: 200, Data: { Files: files } })
  const infoBody = JSON.stringify({ success: true, data: { id: 'unitree/unitree_go2' } })

  test('解析 source 阶段全失败 ⇒ manifest 仍落盘且带五要素；三次尝试以 kind=attempt-failed 留痕', async () => {
    const root = emptyDir()
    const stub = (async () => { throw new Error('The socket connection was closed unexpectedly.') }) as unknown as typeof fetch
    await withFetch(stub, async () => {
      const error = await downloadPolicy({
        dataDirectory: root, endpoint: 'https://modelscope.invalid', provider: 'modelscope',
        modelId: 'unitree/unitree_go2', revision: 'master', files: ['params/x.bin'], signal: new AbortController().signal,
      }).then(() => null, (reason: Error) => reason)
      expect(error).toBeInstanceOf(PolicyFetchError)
      const manifest = manifestOf(join(root, 'policies', 'unitree__unitree_go2', 'master'))
      expect(manifest.status).toBe('FAILED')
      expect(manifest.error).toContain('POLICY_FETCH_FAILED')
      expect(manifest.error).toContain('上游 URL：')
      expect(manifest.error).toContain('来源坐标：modelscope unitree/unitree_go2@master')
      expect(manifest.error).toContain('取件失败于「解析 source」步骤')
      expect(manifest.error).toContain('每次尝试：')
      expect(manifest.error).toContain('可否重试：true')
      const attempts = manifest.transfers.filter(row => row.kind === 'attempt-failed')
      expect(attempts.length).toBeGreaterThanOrEqual(POLICY_FETCH_ATTEMPTS)
      expect(manifest.transfers.every(row => row.kind === 'attempt-failed')).toBe(true) // 该阶段没有逐件结果，不混淆
    })
  })

  test('逐件下载：两次 socket 断开后第三次成功 ⇒ DOWNLOADED，且失败尝试与逐件结果在同一字段里可区分', async () => {
    const root = emptyDir()
    const payload = new TextEncoder().encode('weights')
    const sha = createHash('sha256').update(payload).digest('hex')
    let downloadCalls = 0
    const stub = (async (input: unknown) => {
      const url = String(input)
      if (url.includes('/repo/files')) return new Response(sourceBody([{ Path: 'params/x.bin', Revision: 'a'.repeat(40), Sha256: sha, Size: payload.byteLength, Type: 'blob' }]), { status: 200 })
      if (url.includes('/openapi/v1/models/')) return new Response(infoBody, { status: 200 })
      downloadCalls += 1
      if (downloadCalls < 3) throw new Error('The socket connection was closed unexpectedly.')
      return new Response(payload, { status: 200 })
    }) as unknown as typeof fetch
    await withFetch(stub, async () => {
      const result = await downloadPolicy({
        dataDirectory: root, endpoint: 'https://modelscope.invalid', provider: 'modelscope',
        modelId: 'unitree/unitree_go2', revision: 'master', files: ['params/x.bin'], signal: new AbortController().signal,
      })
      expect(result.status).toBe('DOWNLOADED')
      expect(downloadCalls).toBe(3)
      const manifest = manifestOf(join(root, 'policies', 'unitree__unitree_go2', 'master'))
      const attempts = manifest.transfers.filter(row => row.kind === 'attempt-failed')
      const transfers = manifest.transfers.filter(row => row.kind === undefined)
      expect(attempts.length).toBe(2)
      expect(transfers.length).toBe(1)
      expect(transfers[0]!.path).toBe('params/x.bin')
      expect(String(attempts[0]!.reason)).toContain('socket connection was closed unexpectedly')
      // 这两次失败发生在**建连**阶段 ⇒ 由内层 boundedFetch 各自重试并记录（步骤名如实是「建连」）；
      // 字节流中途失败由外层 downloadFile 以「逐件下载」重试（见上一条停摆用例）。
      expect(attempts[0]!.step).toBe('建连')
    })
  })
})
