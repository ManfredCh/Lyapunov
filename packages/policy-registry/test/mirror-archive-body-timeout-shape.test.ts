/**
 * **U4** 回归：正文阶段超时**不再裸奔**（`bugfixHistory/ARCHIVE-FETCH-MEMOIZATION-20260926.md` §7 `U4`）。
 *
 * 机制（来源回执逐字）：abort 落在 `fetchArchiveBytes` 的**正文循环**里，而那里在 `boundedFetch` 的
 * `try/catch` **之外** ⇒ 抛出来的是**裸 `DOMException`（`TimeoutError`）**：`trace.attempts` **为空**、
 * 没有五要素、也不重试 ⇒ 用户/模型拿到的是一句不带任何诊断的 `The operation timed out.`。
 *
 * 本文件用**「正文停摆」替身**造出那个状态（应答头立刻给、正文一个字节不发，超时 signal 一 abort 就让
 * body 以 `signal.reason` 拒绝 —— 与真 fetch 同形），判据两条：
 *   ① 错误**带五要素**（上游 URL／来源坐标／走到哪一步／每次尝试的原因／可否重试）**且 `attempts` 非空**；
 *   ② 同时钉住**没有被顺手改掉的东西**：`POLICY_FETCH_ATTEMPTS` 仍是 3、取消仍原样传播（不包装）、
 *      `OVERSIZED` 这类判据类失败仍原样抛出（不被套上"重试即可"的五要素）。
 *
 * 全部离线：`globalThis.fetch` 换替身，**0 次真实网络**（匿名配额 60/h 已打满过一次）。
 * 运行：`bun test packages/policy-registry/test/mirror-archive-body-timeout-shape.test.ts`
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knownMirrorCandidates, unpackMirrorArchive, type DeclaredIdentity, type MirrorCandidate } from '../src/mirror-search.ts'
import { POLICY_FETCH_ATTEMPTS, PolicyFetchError, newPolicyFetchTrace } from '../src/source.ts'

const REPO = 'unitreerobotics/unitree_rl_gym'
const COMMIT = 'c'.repeat(40)
const PATH = 'policy/params/parameters.pkl'
const BYTES = Buffer.from('lyapunov-archive-body-stall-'.repeat(16))
const GIT_BLOB = createHash('sha1').update(`blob ${BYTES.length}\0`).update(BYTES).digest('hex')
const COORDS = { provider: 'github' as const, modelId: REPO, revision: COMMIT }
const declared: DeclaredIdentity = {
  identity: { path: PATH, bytes: BYTES.length, gitBlob: GIT_BLOB },
  provenance: 'source-snapshot',
  note: 'sourceSnapshot 的 github tree（本用例自造，与网络无关）',
}
const codeload = (): MirrorCandidate => knownMirrorCandidates(COORDS, declared).find(row => row.host === 'codeload.github.com')!
const workdir = () => mkdtempSync(join(tmpdir(), 'mirror-archive-stall-'))

/** 归档字节的**真上限**（判据类失败的替身用）。 */
const oversizeFetch = () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(Buffer.alloc(64), { status: 200 })) as unknown as typeof fetch
  return { restore: () => { globalThis.fetch = original } }
}
/**
 * **「正文停摆」替身**：`fetch()` 立刻回一个 200 与一条**永远不吐字节**的流（所以 `boundedFetch` 那一步
 * 成功返回、失败发生在**正文循环**里 —— 正是 U4 的机制）；`init.signal` abort 时把 `signal.reason`
 * 原样灌进流（真 fetch 的 body 在 signal abort 时就是这个形状）。
 */
const stallingFetch = () => {
  const original = globalThis.fetch
  const signals: AbortSignal[] = []
  globalThis.fetch = (async (_input: unknown, init: any = {}) => {
    const signal = init?.signal as AbortSignal
    signals.push(signal)
    const body = new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason ?? new DOMException('The operation timed out.', 'TimeoutError')), { once: true })
      },
    })
    return new Response(body, { status: 200 })
  }) as unknown as typeof fetch
  return { signals, restore: () => { globalThis.fetch = original } }
}

describe('U4 · 归档正文阶段超时的错误形状', () => {
  test('正文停摆 ⇒ PolicyFetchError（五要素齐）+ attempts 非空 + 点名端点与阶段', async () => {
    const stub = stallingFetch()
    const trace = newPolicyFetchTrace(COORDS)
    const failure = await unpackMirrorArchive({
      declared, candidate: codeload(), target: join(workdir(), 'parameters.pkl'),
      signal: new AbortController().signal, trace, options: { timeoutMs: 40 },
    }).then(() => null, (error: Error) => error).finally(() => stub.restore())

    expect(failure).toBeInstanceOf(PolicyFetchError)          // ① 不再是裸 DOMException
    expect(failure!.name).toBe('PolicyFetchError')
    const message = String(failure!.message)
    // 五要素：① 走到哪一步（+ 尝试次数） ② 上游 URL ③ 来源坐标 ④ 每次尝试的原因 ⑤ 可否重试
    expect(message).toContain('POLICY_FETCH_FAILED: 取件失败于「逐件下载」步骤')
    expect(message).toContain(`（1/${POLICY_FETCH_ATTEMPTS} 次尝试后放弃`)
    expect(message).toContain(`  上游 URL：${codeload().url}`)
    expect(message).toContain(`  来源坐标：github ${REPO}@${COMMIT}`)
    expect(message).toContain('  每次尝试：①')                 // **非空**（改前这里是「（无）」）
    expect(message).toContain('codeload.github.com 逐件下载')
    expect(message).toContain('TimeoutError')
    expect(message).toContain('读正文阶段撞上本次尝试的 40ms 上限')
    expect(message).toContain('在此之前已收到 0 字节')
    expect(message).toContain('  可否重试：true')
    expect(message).not.toContain('  每次尝试：（无）')
    // `trace.attempts` 也被填上（改前是空数组）——想按 trace 报诊断的调用方拿得到东西。
    expect(trace.attempts).toHaveLength(1)
    expect(trace.attempts[0]).toMatchObject({ step: '逐件下载', endpoint: 'codeload.github.com', attempt: 1, retryable: true })
    expect(trace.attempts[0]!.reason).toContain('TimeoutError')
  })

  test('上限判据**不重试语义**：`POLICY_FETCH_ATTEMPTS` 仍是 3；超时那一跳没有新增重试层', async () => {
    expect(POLICY_FETCH_ATTEMPTS).toBe(3)
    const stub = stallingFetch()
    const trace = newPolicyFetchTrace(COORDS)
    await unpackMirrorArchive({
      declared, candidate: codeload(), target: join(workdir(), 'retry.pkl'),
      signal: new AbortController().signal, trace, options: { timeoutMs: 30 },
    }).then(() => null, () => null).finally(() => stub.restore())
    // 一次失败尝试就收工（报文里的 `1/3`）——本单**没有**把正文循环接进重试层。
    expect(trace.attempts).toHaveLength(1)
  })

  test('取消**原样传播**：调用方 abort ⇒ 不是 PolicyFetchError，且 attempts 不被记账', async () => {
    const stub = stallingFetch()
    const controller = new AbortController()
    const trace = newPolicyFetchTrace(COORDS)
    const timer = setTimeout(() => controller.abort(new Error('POLICY_CANCELLED_BY_TEST')), 25)
    const failure = await unpackMirrorArchive({
      declared, candidate: codeload(), target: join(workdir(), 'cancelled.pkl'),
      signal: controller.signal, trace, options: { timeoutMs: 5_000 },
    }).then(() => null, (error: Error) => error).finally(() => { clearTimeout(timer); stub.restore() })
    expect(failure).not.toBeInstanceOf(PolicyFetchError)
    expect(String(failure!.message)).toContain('POLICY_CANCELLED_BY_TEST')
    expect(trace.attempts).toHaveLength(0)
  })

  test('判据类失败仍原样抛出：归档超上限不被套上五要素（不许说成"重试即可"）', async () => {
    const stub = oversizeFetch()
    const trace = newPolicyFetchTrace(COORDS)
    const failure = await unpackMirrorArchive({
      declared, candidate: codeload(), target: join(workdir(), 'oversized.pkl'),
      signal: new AbortController().signal, trace, options: { maxBytes: 8 },
    }).then(() => null, (error: Error) => error).finally(() => stub.restore())
    expect(failure).not.toBeInstanceOf(PolicyFetchError)
    expect(String(failure!.message)).toMatch(/POLICY_MIRROR_ARCHIVE_OVERSIZED/)
    expect(trace.attempts).toHaveLength(0)
  })
})
