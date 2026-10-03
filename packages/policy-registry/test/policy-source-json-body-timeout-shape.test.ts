/**
 * 【同形残留】`getJSON` 正文阶段超时的错误形状（2026-09-27）
 *
 * 机制（两条 lane 独立登记的同一形状）：`boundedFetch` 的 `try/catch` 只包住 `fetch()`（**建连／应答头**），
 * 它 `return` 的那个 `Response` 的**正文**是在外面读的（`getJSON` 的 `await response.json()`），而
 * `timeoutScope` 走默认 `'attempt'` ⇒ 那个 `AbortSignal.timeout(POLICY_FETCH_TIMEOUT_MS)` **一直挂在 body 上**。
 * abort 落在读正文时抛出来的是一枚**裸 DOMException（`TimeoutError`）**：`trace.attempts` 为空、五要素全无
 * —— 用户/模型拿到的就是一句 `The operation timed out.`
 *
 * 本文件用**「正文停摆」替身**造出那个状态（200 应答头立刻给、正文先吐 0 或 N 字节随后以同形
 * `TimeoutError` DOMException 拒绝 —— 真 fetch 在超时 signal abort 时 body 就是这样拒绝的），判据与
 * `mirror-archive-body-timeout-shape.test.ts`（归档那一跳，已验收）逐条对齐：
 *   ① 错误是 `PolicyFetchError`（**不是**裸 DOMException）、`attempts` **非空**、五要素齐；
 *   ② 报文里看得出「**读正文阶段撞上本次尝试的上限**」以及「**在此之前已收到多少字节**」
 *      （0 与 1234 两种；后者同时证明"字节只要在到就一直收"）；
 *   ③ 同时钉住**没有被顺手改掉的东西**：`POLICY_FETCH_ATTEMPTS` 仍是 3、超时那一跳**没有新增重试层**、
 *      调用方取消仍**原样传播**（不包装、不记账）、状态类失败（404）仍是**裸码**、
 *      正文不是 JSON（判据类）仍**原样抛 `SyntaxError`**（位置与改前逐字相同 ⇒ 不新开"回显上游正文"的面）。
 *
 * 全部离线：`globalThis.fetch` 换替身，**0 次真实网络**。
 * 运行：`bun test packages/policy-registry/test/policy-source-json-body-timeout-shape.test.ts`
 */
import { describe, expect, test } from 'bun:test'
import { GITHUB_API_ORIGIN, newPolicyFetchTrace, PolicyFetchError, POLICY_FETCH_ATTEMPTS, POLICY_FETCH_TIMEOUT_MS, sourceSnapshot } from '../src/source.ts'

const REPO = 'unitree/unitree_go2'
const REVISION = 'main'
const COORDS = { provider: 'github' as const, modelId: REPO, revision: REVISION }
/** `sourceSnapshot` 的 github 分支第一条 `getJSON` 打的那个 URL（上游 URL＝五要素之一）。 */
const COMMIT_URL = `${GITHUB_API_ORIGIN}/repos/${REPO}/commits/${REVISION}`
const TIMEOUT = () => new DOMException('The operation timed out.', 'TimeoutError')

const withFetch = async <T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> => {
  const original = globalThis.fetch
  globalThis.fetch = stub
  try { return await run() } finally { globalThis.fetch = original }
}
/** **「正文停摆」替身**：200 应答头立刻给；正文第一拉吐 `after` 字节（给了才吐），第二拉以同形 TimeoutError 拒绝。 */
const stallingBody = (after?: Uint8Array) => (async () => {
  let pulled = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled++ === 0 && after) { controller.enqueue(after); return }
      controller.error(TIMEOUT())
    },
  })
  return new Response(body, { status: 200 })
}) as unknown as typeof fetch
/** 真 fetch 同形：body 只在 `init.signal` abort 时以 `signal.reason` 拒绝（取消那一格的替身）。 */
const abortReactiveBody = () => (async (_input: unknown, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
  start(controller) { init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason ?? TIMEOUT()), { once: true }) },
}), { status: 200 })) as unknown as typeof fetch
const githubSnapshot = (signal: AbortSignal, trace = newPolicyFetchTrace(COORDS)) =>
  sourceSnapshot('github', REPO, REVISION, GITHUB_API_ORIGIN, signal, trace).then(() => null, (error: Error) => error)

describe('getJSON 正文阶段超时的错误形状（同形残留）', () => {
  test('正文停摆（0 字节）⇒ PolicyFetchError（五要素齐）+ attempts 非空 + 点名端点与阶段', async () => {
    const trace = newPolicyFetchTrace(COORDS)
    const failure = await withFetch(stallingBody(), () => githubSnapshot(new AbortController().signal, trace))

    expect(failure).toBeInstanceOf(PolicyFetchError)          // ① 不再是裸 DOMException
    expect(failure!.name).toBe('PolicyFetchError')
    const message = String(failure!.message)
    // 五要素：① 走到哪一步（+ 尝试次数） ② 上游 URL ③ 来源坐标 ④ 每次尝试的原因 ⑤ 可否重试
    expect(message).toContain('POLICY_FETCH_FAILED: 取件失败于「解析 source」步骤')
    expect(message).toContain(`（1/${POLICY_FETCH_ATTEMPTS} 次尝试后放弃`)
    expect(message).toContain(`  上游 URL：${COMMIT_URL}`)
    expect(message).toContain(`  来源坐标：github ${REPO}@${REVISION}`)
    expect(message).toContain('  每次尝试：①')                 // **非空**（改前这里是「（无）」）
    expect(message).toContain('api.github.com 解析 source')
    expect(message).toContain('TimeoutError')
    expect(message).toContain(`读正文阶段撞上本次尝试的 ${POLICY_FETCH_TIMEOUT_MS}ms 上限`)
    expect(message).toContain('在此之前已收到 0 字节')
    expect(message).toContain('  可否重试：true')
    expect(message).not.toContain('  每次尝试：（无）')
    // `trace.attempts` 也被填上（改前是空数组）——按 trace 报诊断的调用方拿得到东西。
    expect(trace.attempts).toHaveLength(1)
    expect(trace.attempts[0]).toMatchObject({ step: '解析 source', endpoint: 'api.github.com', attempt: 1, retryable: true })
    expect(trace.attempts[0]!.reason).toContain('TimeoutError')
  })

  test('部分字节后停摆 ⇒ 报文给出**真实**字节数；超时那一跳没有新增重试层', async () => {
    expect(POLICY_FETCH_ATTEMPTS).toBe(3)
    const trace = newPolicyFetchTrace(COORDS)
    const failure = await withFetch(stallingBody(new Uint8Array(1234).fill(65)), () => githubSnapshot(new AbortController().signal, trace))

    expect(failure).toBeInstanceOf(PolicyFetchError)
    expect(String(failure!.message)).toContain('在此之前已收到 1234 字节')
    // 一次失败尝试就收工（报文里的 `1/3`）—— 本单**没有**把正文读接进重试层。
    expect(trace.attempts).toHaveLength(1)
  })

  test('取消**原样传播**：调用方 abort ⇒ 不是 PolicyFetchError，且 attempts 不被记账', async () => {
    const controller = new AbortController()
    const trace = newPolicyFetchTrace(COORDS)
    const timer = setTimeout(() => controller.abort(new Error('POLICY_CANCELLED_BY_TEST')), 25)
    const failure = await withFetch(abortReactiveBody(), () => githubSnapshot(controller.signal, trace)).finally(() => clearTimeout(timer))

    expect(failure).not.toBeInstanceOf(PolicyFetchError)
    expect(String(failure!.message)).toContain('POLICY_CANCELLED_BY_TEST')
    expect(trace.attempts).toHaveLength(0)
  })

  test('状态类失败仍原样抛出：404 是裸码，不被套上五要素', async () => {
    const trace = newPolicyFetchTrace({ provider: 'modelscope', modelId: 'unitree/unitree_go2', revision: 'master' })
    const failure = await withFetch(
      (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch,
      () => sourceSnapshot('modelscope', 'unitree/unitree_go2', 'master', 'https://modelscope.invalid', new AbortController().signal, trace).then(() => null, (error: Error) => error),
    )

    expect(failure).not.toBeInstanceOf(PolicyFetchError)
    expect(String(failure!.message)).toBe('POLICY_REMOTE_404')
    expect(trace.attempts).toHaveLength(0)
  })

  test('正文不是 JSON 是**判据类**失败：仍原样抛 SyntaxError（不套五要素、不新开回显上游正文的面）', async () => {
    const trace = newPolicyFetchTrace(COORDS)
    const failure = await withFetch(
      (async () => new Response('<!DOCTYPE html><html>不是 JSON</html>', { status: 200 })) as unknown as typeof fetch,
      () => githubSnapshot(new AbortController().signal, trace),
    )

    expect(failure).not.toBeInstanceOf(PolicyFetchError)
    expect(failure!.name).toBe('SyntaxError')
    expect(trace.attempts).toHaveLength(0)
  })
})
