/**
 * 「429 **尝试耗尽**之后仍要给出限流诊断」这条**已验收出口**的钉子
 * （复核单 CLASSIFYEXHAUSTED-RESTORE／F3，2026-09-27；回执 `bugfixHistory/CLASSIFYEXHAUSTED-RESTORE-20260926.md`）。
 *
 * ## 为什么要有这个文件（它钉的是"绿着断开"那一次）
 *
 * 并发的 lane-stall 在 00:48:16 的 922 行版里，把 `boundedFetch` 里 W26-R2 的**应答级分类**接线整段切掉：
 *
 * ```
 *   − const classified = options.classifyExhausted?.(response, url, failures.length) ?? null
 *   − throw new PolicyFetchError({ … retryable: classified?.retryable ?? true, … diagnosis: classified?.diagnosis ?? null })
 *   + throw new PolicyFetchError({ … retryable: true, … })      // 诊断投递点没了
 * ```
 *
 * 而 `getJSON`（+ 它上游的 `sourceSnapshot`）**仍在传**这个分类器 ⇒ 三个后果：
 *   ① 全仓 `tsc` 多一条 `TS2353`（实参比形参多 —— 形参那一项也一起被删掉了）；
 *   ② **已验收的出口被静默切断**：重试到耗尽之后，"这是限流 + 重置指引"这段诊断送不到用户面前，
 *      报文退回"可否重试：true（瞬时网络故障）"—— **把限流说成了瞬时故障**；
 *   ③ 死代码全留着（`ExhaustedResponseClassifier`、`getJSON` 的形参、`sourceSnapshot` 的构造点）。
 *
 * **现有用例一条都抓不到**：同目录 `policy-source-github-429-noheader.test.ts` 里唯一提到
 * `classifyExhausted` 的是那条「**不传** ⇒ 与改前逐字一致」—— 它压根不传参数，所以接线被切掉它照绿。
 *
 * ## 本文件的判据（Lead 逐字）
 *
 * > **把 `classifyExhausted` 从 `boundedFetch` 里删掉 ⇒ 本文件必须红。**
 *
 * 所以断言不钉"函数签名长什么样"，只钉**用户能看到的报文**：
 * 分类器**被调用**、它的诊断**进了报文**、`attempts` 参数是**实际试过的次数**。
 *
 * ## 与变体 A 的关系（不越界）
 *
 * 变体 A 落地后 429 在**产品路径**上被 `retryOverride` 当场带走（1 次、走 `githubStatusError`）
 * ⇒ 这条耗尽出口在产品路径上**不可达**（已在 `source.ts` 的函数 doc 与既有回执里如实登记）。
 * 但它**仍是已验收的接缝**：口径再变时两条投递路径必须同源。本文件就在**接缝层**钉住它 ——
 * 用**和 `sourceSnapshot` 同一个组成**的分类器（`githubRateLimited` → `githubRateLimitDiagnosis`），
 * 只是 URL 换成不受 host 守卫保护的地址，好让 429 真的重试到耗尽。
 *
 * ## 边界
 *
 * 全部替身 `fetch`：**0 次真实网络、0 真实配额、不读环境凭据**（分类器显式传 `null` = 匿名口径）。
 * 断言里的"诊断正文"一律**由 `githubRateLimitDiagnosis` 现算**再比对（空头上该函数与时钟无关），
 * **不抄写文**——这样措辞演进时红的是"不再同源"，而不是"抄的那份过期了"。
 */
import { describe, expect, test } from 'bun:test'
import {
  boundedFetch, githubRateLimitDiagnosis, githubRateLimited, PolicyFetchError, POLICY_FETCH_ATTEMPTS,
} from '../src/source.ts'

/**
 * 接缝地址：`upstream.invalid` **不是** `api.github.com` ⇒ `githubRateLimitNoRetry` 的 host 守卫为假
 * ⇒ 429 不会被"限流覆盖"当场带走 ⇒ 真的按既有瞬时语义重试到 `POLICY_FETCH_ATTEMPTS` 次后走耗尽出口。
 */
const UPSTREAM = 'https://upstream.invalid/repos/unitreerobotics/unitree_rl_gym/commits/main'

/** 与 `sourceSnapshot` 里那个分类器**同一段组成**（见 `source.ts` 的 github 分支）。 */
const NOW = Date.now()
const anonymousExhaustedClassifier = (response: Response, url: string, attempts: number) =>
  githubRateLimited(response.status, response.headers)
    ? { retryable: false, diagnosis: githubRateLimitDiagnosis(response.status, response.headers, url, null, NOW, 'fetch', attempts) }
    : null

interface Call { url: string; status: number }
function stubFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [], original = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    const call: Call = { url: String(input), status: 0 }
    calls.push(call)
    return handler(call)
  }) as unknown as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}
/** 每条尝试都 429、**没有任何** `x-ratelimit-*`（中间代理剥头的真实场景）。 */
const alwaysRateLimited = (call: Call) => { call.status = 429; return new Response('denied', { status: 429, headers: {} }) }
const attempt = async (options: Parameters<typeof boundedFetch>[2]) =>
  await boundedFetch(UPSTREAM, {}, options).then(() => null, (reason: Error) => reason)
/** 报文里的 `ms` 是计时读数，两条路径之间不可逐字比较；比较时归一掉它，其余**逐字**。 */
const normalize = (text: string) => text.replace(/\d+ms/g, 'Nms')

describe('耗尽出口（`boundedFetch` 的 `classifyExhausted`）：接线被切掉 ⇒ 本文件必须红', () => {
  test('429 重试到耗尽 ⇒ 报文里**必须有"限流"诊断 + 重置指引**（已验收出口），且不许再说成瞬时故障', async () => {
    const stub = stubFetch(alwaysRateLimited)
    try {
      const error = await attempt({ step: '解析 source', classifyExhausted: anonymousExhaustedClassifier })
      const text = String(error)

      // ① 传输层：没传 `retryOverride` ⇒ 429 仍按既有瞬时语义重试到耗尽（这正是这条出口存在的理由）
      expect(stub.calls.length).toBe(POLICY_FETCH_ATTEMPTS)
      expect(error).toBeInstanceOf(PolicyFetchError)

      // ② 五要素仍在：诊断是**附在**五要素之后，不是替换（B 版口径的接缝语义，五要素一个不丢）
      expect(text).toContain(`（${POLICY_FETCH_ATTEMPTS}/${POLICY_FETCH_ATTEMPTS} 次尝试后放弃`)
      expect(text).toContain('每次尝试')
      expect(text).toContain('上游应答的诊断')

      // ③ ★被切掉的那条出口★：分类器的诊断必须送达用户（报文含"限流"、可执行的重置指引）
      expect(text).toContain('POLICY_GITHUB_RATE_LIMITED')
      expect(text).toContain('限流')
      expect(text).toContain('重置指引')
      expect(text).toContain('api.github.com/rate_limit')
      expect(text).not.toContain('重置于 ')          // 无证据 ⇒ 不许编一个算不出来的时刻

      // ④ 分类器的第三个参数 = **实际试过的次数**（只有 `boundedFetch` 知道）⇒ "三态"里"耗尽"那一态
      expect(text).toContain(`先试了 ${POLICY_FETCH_ATTEMPTS} 次`)

      // ⑤ 不许再把限流说成瞬时故障（改前这里正是 `可否重试：true（瞬时网络故障…）`）
      expect(text).not.toContain('可否重试：true')
      expect(text).toContain('可否重试：false（不是瞬时故障：按上面的诊断处置，**别重跑同一条命令**）')

      // ⑥ 同源：注入的这段文字**逐字等于**现算的同名诊断（两条投递路径不可能分叉）
      const direct = githubRateLimitDiagnosis(429, new Headers({}), UPSTREAM, null, NOW, 'fetch', POLICY_FETCH_ATTEMPTS)
      expect(direct).toContain(`先试了 ${POLICY_FETCH_ATTEMPTS} 次`)
      expect(text).toContain(direct.split('\n').map(line => `  ${line}`).join('\n'))
    } finally { stub.restore() }
  })

  test('对照·空分类器安全：传了但返回 `null` ⇒ 报文与**完全没接线**逐字一致（恢复接线不改别的 provider）', async () => {
    const withNull = stubFetch(alwaysRateLimited)
    const nulled = normalize(String(await attempt({ step: '建连', classifyExhausted: () => null }).finally(() => withNull.restore())))
    const without = stubFetch(alwaysRateLimited)
    const plain = normalize(String(await attempt({ step: '建连' }).finally(() => without.restore())))
    expect(nulled).toBe(plain)
    expect(plain).toContain('可否重试：true（瞬时网络故障：重试同一条命令即可，已落 .part 会续传）')
    expect(plain).not.toContain('上游应答的诊断')
  })

  test('对照·覆盖优先：`retryOverride` 生效（变体 A 的 429 覆盖）⇒ 一次即返回应答、**分类器根本不被调用**', async () => {
    const stub = stubFetch(alwaysRateLimited)
    let called = 0
    try {
      const response = await boundedFetch(UPSTREAM, {}, {
        step: '解析 source',
        retryOverride: () => true,
        classifyExhausted: (r, u, a) => { called += 1; return anonymousExhaustedClassifier(r, u, a) },
      })
      expect(response.status).toBe(429)      // 原样返回给调用方的状态分类器（`githubStatusError` 那条路）
      expect(stub.calls.length).toBe(1)      // 覆盖生效：只打 1 次
      expect(called).toBe(0)                 // ⇒ 恢复的接线不改变体 A 的行为（不越界动重试语义）
    } finally { stub.restore() }
  })
})
