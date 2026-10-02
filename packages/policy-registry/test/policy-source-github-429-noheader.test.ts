/**
 * W26-R2（2026-09-26）：**429 无限流头时，"这是限流"这段诊断必须送达用户**。
 *
 * 缺口（验收队 V10 §3.C-1 查出、本单独立重取）：
 *   `githubRateLimited(429, 空头)` **为真**（分类层认它是限流），但旧口径的 `githubRateLimitNoRetry` 为假
 *   （覆盖要求"证据在场"）⇒ `boundedFetch` 把 429 当瞬时故障重试 3 次后抛 `PolicyFetchError`，
 *   **`githubStatusError` 根本没被调用** ⇒ 报文里连"限流"二字都没有，还写着"可否重试：true"。
 *   **中间代理剥掉 `x-ratelimit-*` 正是触发场景**（P18 §2.2／R-fix#3 §7.1 各登记了一半）。
 *
 * **本文件钉住的读法 = Lead 裁定的变体 A**（`docs/REMAINING_WORK_PLAN.md` §7.16，2026-09-27：
 * "**429 一律走分类器；重试覆盖【不再要求限流证据在场】**"，并据此明确修订 R-fix#3 §2.1）：
 *   - **尝试次数**：429（含有头/无头）一律 1 次 —— 报文说"不重试"就必须真的只打 1 次（否则报文在说谎），
 *     且匿名配额不再被烧 3 倍；
 *   - **诊断必须可达**：走**当场分类器**（`githubStatusError` ⇒ `githubRateLimitDiagnosis`），
 *     报文含"限流" + 重置指引（无证据时**不编时刻**，给"去哪儿查"）；
 *   - 与 W4 落地的内容路不变式一致：**同一个 429 在元数据路与逐件路给出同一套诊断与同一个"不重试"结论**。
 *
 * ⚠️ 与**变体 B**（"分类可达、但重试不覆盖"）的关系：本文件是从 B 版草稿（183 行，跑在 652 行冻结基线上）
 *    **改写**成正字的 A 版 —— 改动只落在**与变体绑定的两处**：① `ATTEMPTS_WHEN_NO_EVIDENCE`（3 → 1）；
 *    ② 原"（变体 B 独有）五要素一个都不丢"那条 ⇒ 改为**钉住 A 的投递路径**（当场分类器，报文里**没有**五要素），
 *    并把 `PolicyFetchError` 的 `diagnosis` 接缝改为**直接构造**覆盖。其余 7 条断言 B/A 共用、逐字未动。
 *
 * 全部替身 `fetch`：**0 次真实网络、0 真实配额**。
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * **本单扩展（RETRYLAYER-WIRING，2026-09-27）**：上面那 9 条**逐字保留**，另加 F1/F2/F3 四处。
 *
 * 缺口（`bugfixHistory/GITHUB-429-TEST-GAP-20260926.md` §6.1/§6.2 查出，本单**自己重跑真链探针复现**）：
 *   - **F1**：`plugin.ts:54` 调 `githubStatusError` 时**漏传 `retryLayer`** ⇒ 默认值 `'fetch'` 生效 ⇒
 *     检索链（`policy_search`）的真产品路径上，429 报文带着「立刻重试只会再烧配额」——
 *     **而那条路根本没有重试层**。上面第 6 条用例断言的那个"分得开"**只在手调参数时成立**：
 *     **用例绿，产品行为一个字没变**。
 *   - **F2**：共用的限流正文里「本次成本：一条 sourceSnapshot **最多**打 3 个请求（commit／repo／tree）」
 *     是**取件链专属**的，却在检索链上原样发出 —— 而那条路只打 **1 个 `search/repositories`**，
 *     **从不请求** commit／repo／tree。与 §7.16 已登记的措辞问题 ②（"等到**上面那个**重置时刻"而上面
 *     根本没有那一行）**同一族**：**报文指向那条路径上不存在的东西**。
 *   - **F3**（本单新查出）：并发的 lane-stall 在 00:48:16 的 922 行版里把 `boundedFetch` 的
 *     `classifyExhausted` 接线**整段切掉**（options 类型也一起去掉），而 `getJSON` 仍在传 ⇒
 *     全仓 `tsc` 多一条 `TS2353`，且"耗尽也要给诊断"那条出口被静默切断。本文件补一条接缝用例钉住它。
 *
 * **判据（Lead 裁定，逐字）**：**同一句报文不许在两条路径上给出对方的事实。**
 * ⇒ 本单新增的断言一律**驱动真产品路径**（`searchPolicies` / `sourceSnapshot`），
 *   不再靠手调 `githubStatusError(..., 'search')` 假装"分得开"。
 */
import { describe, expect, test } from 'bun:test'
import {
  boundedFetch, githubRateLimitDiagnosis, githubRateLimited, githubRateLimitNoRetry, githubSearchStatusError, githubStatusError,
  githubStatusRetryOverride, sourceSnapshot, PolicyFetchError, POLICY_FETCH_ATTEMPTS,
  GITHUB_ANONYMOUS_CORE_LIMIT, GITHUB_SEARCH_PATH, GITHUB_SNAPSHOT_REQUESTS, GITHUB_TOKEN_ENV,
} from '../src/source.ts'
import { searchPolicies } from '../src/plugin.ts'

const REPO = 'unitreerobotics/unitree_rl_gym'
const COMMIT = 'a'.repeat(40)
const API = 'https://api.github.com'

/**
 * **本文件唯一与变体选择绑定的常量**（见文件头 ⚠️）：
 *   - 变体 A（**已落地**，"429 一律覆盖"）⇒ `1`；
 *   - 变体 B（备选，"分类可达但重试不覆盖"）⇒ `POLICY_FETCH_ATTEMPTS`（3）。
 * 把读数留在这里是为了让"读的是哪一种口径"无法被含糊过去。
 */
const ATTEMPTS_WHEN_NO_EVIDENCE = 1

interface Call { url: string; headers: Record<string, string> }
function stubFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [], original = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init: any = {}) => {
    const call: Call = { url: String(input), headers: (init?.headers ?? {}) as Record<string, string> }
    calls.push(call)
    return handler(call)
  }) as unknown as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}
/** 只认 api.github.com；未知路径一律 500 ⇒ "多打了一个请求"会以失败暴露，而不是静默成功。 */
const sourceStub = (status: number, responseHeaders: Record<string, string> = {}) => (call: Call) => {
  if (!/^https:\/\/api\.github\.com\//.test(call.url)) return new Response('unexpected ' + call.url, { status: 500 })
  if (status !== 200) return new Response('denied', { status, headers: responseHeaders })
  if (call.url.includes('/commits/')) return Response.json({ sha: COMMIT })
  if (call.url.includes('/git/trees/')) return Response.json({ tree: [] })
  if (new URL(call.url).pathname === `/repos/${REPO}`) return Response.json({ full_name: REPO })
  return new Response('unexpected ' + call.url, { status: 500 })
}
const snapshot = () => sourceSnapshot('github', REPO, 'main', 'https://modelscope.invalid', new AbortController().signal)
const failure = async (run: () => Promise<unknown>) => await run().then(() => null, (reason: Error) => reason as Error)
const rateLimitHeaders = (overrides: Record<string, string> = {}) => ({
  'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-used': '60',
  'x-ratelimit-resource': 'core', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 754), ...overrides,
})

/* ───────────────── 本单扩展（RETRYLAYER-WIRING）新增的夹具 ───────────────── */

/** 凭据必须**确实没有**才谈得上"匿名那一份配额"：显式清空再还原，不赌环境。 */
async function withoutTokens<T>(run: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>()
  for (const name of [GITHUB_TOKEN_ENV, 'GITHUB_TOKEN', 'GH_TOKEN']) { saved.set(name, process.env[name]); delete process.env[name] }
  try { return await run() } finally { for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
}
/** 检索链的**真产品路径**入口（`policy_search` 的 github 分支走的就是它）。 */
const searchGithub = () => searchPolicies('https://modelscope.invalid', { provider: 'github', query: 'unitree' }, new AbortController().signal)

describe('W26-R2 429 **无**限流头：正确诊断必须可达（代理剥头的真实场景）', () => {
  test('报文里**必须出现"限流"字样**，且**不得**再把限流说成瞬时网络故障', async () => {
    const stub = stubFetch(sourceStub(429, {}))
    try {
      const text = String(await failure(snapshot))
      // ① 分类可达：改前这里是 POLICY_FETCH_FAILED + "上游 HTTP 429"，**一个字都没有"限流"**
      expect(text).toContain('POLICY_GITHUB_RATE_LIMITED')
      expect(text).toContain('限流')
      expect(text).toContain('不是仓库不存在、也不是网络故障')
      expect(text).toContain(`https://api.github.com/repos/${REPO}/commits/main`)
    } finally { stub.restore() }
  })

  // ⚠️ 与变体绑定（A 版改写处 ②）：A 的投递点是**当场分类器**（429 被覆盖 ⇒ 1 次就返回应答 ⇒ `getJSON`
  //    直接把应答交给 `statusError`），报文与既有"429 + 限流头"那条路**同形**：**没有**五要素。
  //    B 的投递点是 `PolicyFetchError` 的耗尽出口（报文里有五要素 + 附在后面的诊断）—— 那条路 A 下不可达。
  test('投递路径（变体 A）：走**当场分类器**、不是"耗尽出口" ⇒ 报文里没有五要素；`PolicyFetchError` 的诊断接缝本身仍可用', async () => {
    const stub = stubFetch(sourceStub(429, {}))
    try {
      const text = String(await failure(snapshot))
      expect(text.startsWith('Error: POLICY_GITHUB_RATE_LIMITED')).toBe(true)   // **不是** PolicyFetchError
      expect(text).not.toContain('POLICY_FETCH_FAILED')
      expect(text).not.toContain('每次尝试')                    // 五要素不在（与"429 + 限流头"那条路一致）
      expect(text).not.toContain('上游应答的诊断')
      expect(stub.calls.length).toBe(ATTEMPTS_WHEN_NO_EVIDENCE)  // 投递点与"只打 1 次"是同一件事的两面
      // 接缝本身（变体 A 下**无触发路径**，已在回执如实登记）仍能把诊断附在五要素**之后**，五要素一个不丢：
      const seam = new PolicyFetchError({
        url: `${API}/x`, step: '解析 source', retryable: false, context: {},
        attempts: [{ at: new Date(0).toISOString(), step: '解析 source', url: `${API}/x`, attempt: 1, ms: 1, reason: '上游 HTTP 429', retryable: true }],
        diagnosis: githubRateLimitDiagnosis(429, new Headers({}), `${API}/x`, null),
      })
      expect(String(seam)).toContain('每次尝试')                 // 五要素在
      expect(String(seam)).toContain('上游应答的诊断')           // 诊断附在后面
      expect(String(seam)).toContain('重试判定')
      expect(String(seam)).toContain('可否重试：false（不是瞬时故障：按上面的诊断处置，**别重跑同一条命令**）')
    } finally { stub.restore() }
  })

  test('**重置指引**：无头时给"去哪儿查"（不给假时刻）；有头时给**时刻**', async () => {
    const anonymous = stubFetch(sourceStub(429, {}))
    const noEvidence = String(await failure(snapshot).finally(() => anonymous.restore()))
    expect(noEvidence).toContain('重置指引')                       // 无证据 ⇒ 给指引，不能沉默
    expect(noEvidence).toContain('api.github.com/rate_limit')      // 去哪儿查，可执行
    expect(noEvidence).toContain('代理')
    expect(noEvidence).not.toContain('重置于 ')                     // **不许编一个算不出来的时刻**

    const evidenced = stubFetch(sourceStub(429, rateLimitHeaders()))
    const withEvidence = String(await failure(snapshot).finally(() => evidenced.restore()))
    expect(withEvidence).toContain('重置于 ')                      // 有证据 ⇒ 给上游的真实时刻
    expect(withEvidence).toContain('limit=60')
    expect(withEvidence).toContain('remaining=0')
  })

  test('**不重试**：尝试次数与"报文与传输一致"各自钉住（变体 A 的裁定点）', async () => {
    const stub = stubFetch(sourceStub(429, {}))
    try {
      const text = String(await failure(snapshot))
      // (a) 传输层：**429 一律覆盖** ⇒ 只打 1 个请求（R-fix#3 负对照 A 的旧读数 3 次已被 §7.16 改判）
      expect(stub.calls.length).toBe(ATTEMPTS_WHEN_NO_EVIDENCE)
      // (b) 报文层：必须说"不重试" —— 改前这里写着"可否重试：true（瞬时网络故障：重试同一条命令即可）"
      expect(text).toContain('重试判定：不重试')
      expect(text).not.toContain('可否重试：true')
      expect(text).not.toContain('瞬时网络故障')
      expect(text).not.toContain('先试了')                       // 变体 A 下**没有**"先试了 N 次"这一态（那是 B 的措辞）
      expect(text).toContain('立刻重试只会再烧配额')              // 限流语境下正确的建议
      // (c) 分类口径与覆盖口径**同一件事**：429 恒为限流 ⇒ 恒覆盖（这正是 §7.16 的裁定）
      expect(githubRateLimited(429, new Headers({}))).toBe(true)
      expect(githubRateLimitNoRetry(429, new Headers({}), `${API}/x`)).toBe(true)
      expect(githubRateLimitNoRetry(429, new Headers({}), 'https://modelscope.invalid/x')).toBe(false)  // host 守卫没动
    } finally { stub.restore() }
  })

  test('措辞：**"本次成本"不再是"固定打 3 个"** —— 撞在第几个请求上就只花到那一个', async () => {
    const stub = stubFetch(sourceStub(429, rateLimitHeaders()))
    try {
      const text = String(await failure(snapshot))
      expect(text).toContain('最多')
      expect(text).toContain('撞在第几个就只花到那一个')
      expect(text).toContain('本次只花 1 个')                    // commit（第 1 个请求）就被拒的真实场景
      expect(text).not.toContain('固定打 3 个')                  // 改前那句在"commit 先撞墙"时是**假的**
      expect(stub.calls.length).toBe(1)                          // 而这一次确实只花了 1
    } finally { stub.restore() }
  })

  // ⚠️ **本单改写**（F1）：这一条**原先手调** `githubStatusError(..., Date.now(), 'search')` ——
  //    断言的是"分类器被喂对参数时会分岔"，而真产品路径上 `plugin.ts:54` **根本没传**那个参数。
  //    ⇒ 用例绿、产品行为一个字没变（正是本轮反复在抓的第三类）。现在两条链**都走真产品路径**。
  test('措辞：同一句"重试判定"在**检索链**与**取件链**含义不同 ⇒ 报文里必须分得开（**走真产品路径**）', async () => {
    await withoutTokens(async () => {
      const headers = rateLimitHeaders()
      const fetchStub = stubFetch(sourceStub(429, headers))
      const fetched = await failure(snapshot).finally(() => fetchStub.restore())
      const searchStub = stubFetch(() => new Response('denied', { status: 429, headers }))
      const searched = await failure(searchGithub).finally(() => searchStub.restore())
      const fetchedText = String(fetched), searchedText = String(searched)

      // ① 取件链：说"不重试"（覆盖生效），且**不许**声称自己"没有重试层"
      expect(fetchedText).toContain('重试判定：不重试')
      expect(fetchedText).not.toContain('检索链')
      expect(fetchedText).not.toContain('本来就没有重试层')
      // ② 检索链：一次即失败、**本来就没有重试层**，且必须**显式否认**"这是覆盖生效"
      expect(searchedText).toContain('检索链')
      expect(searchedText).toContain('本来就没有重试层')
      expect(searchedText).toContain('不代表')
      // ③ 两条链的"重试判定"那一句**必须不同**（同一应答、同一分类器、两条真路径）
      expect(searchedText).not.toContain('重试判定：不重试')
      expect(fetchedText).not.toBe(searchedText)
    })
  })

  // ⚠️ 这一条是 F1 的**接线证明**（与上面那条分开，是因为它要求报文**逐字**可复算 ⇒ 必须用
  //    无证据头：那一路没有 `重置于 …`／`约 N 分钟后`，报文与时钟无关，能逐字节比）。
  test('F1 接线证明：检索链真路径的报文**逐字等于具名检索入口**，且**不等于**取件入口（同 URL、同头）', async () => {
    await withoutTokens(async () => {
      const stub = stubFetch(() => new Response('denied', { status: 429, headers: {} }))
      try {
        const text = String(await failure(searchGithub))
        const url = stub.calls[0]!.url
        // 真产品路径 = 检索入口（改前这里会等于取件入口 ⇒ **红**）
        expect(text).toBe(`Error: ${githubSearchStatusError(429, new Headers({}), url, null).message}`)
        expect(text).not.toBe(`Error: ${githubStatusError(429, new Headers({}), url, null).message}`)
        // 差异**只**来自 `retryLayer`：同一个 URL、同一份头，喂给取件入口就带回那句取件建议
        const fetchLayer = githubStatusError(429, new Headers({}), url, null).message
        expect(fetchLayer).toContain('立刻重试只会再烧配额')
        expect(text).not.toContain('立刻重试只会再烧配额')
      } finally { stub.restore() }
    })
  })

  test('接缝（boundedFetch）：不传 classifyExhausted ⇒ 报文与改前**逐字一致**（别的 provider 不受影响）', async () => {
    const stub = stubFetch(() => new Response('denied', { status: 429, headers: {} }))
    try {
      const error = await boundedFetch('https://upstream.invalid/x', {}, { step: '建连' }).then(() => null, (reason: Error) => reason as Error)
      expect(stub.calls.length).toBe(POLICY_FETCH_ATTEMPTS)
      expect(String(error)).toContain('可否重试：true')           // 未传分类器 ⇒ 既有语义一个字不改
      expect(String(error)).not.toContain('上游应答的诊断')
    } finally { stub.restore() }
  })

  test('负对照：**别的 host** 的 429 无头仍然只报"瞬时故障"（覆盖与诊断都不外溢）', async () => {
    const stub = stubFetch(() => new Response('denied', { status: 429, headers: {} }))
    try {
      const text = String(await failure(() => sourceSnapshot('modelscope', REPO, 'main', 'https://modelscope.invalid', new AbortController().signal)))
      expect(text).toContain('POLICY_FETCH_FAILED')
      expect(text).toContain('可否重试：true')
      expect(text).not.toContain('POLICY_GITHUB_RATE_LIMITED')
      expect(text).not.toContain('限流')
      expect(stub.calls.every(call => !call.url.startsWith('https://api.github.com/'))).toBe(true)
    } finally { stub.restore() }
  })

  test('诊断正文是**同一段文字**：当场分类与耗尽分类不可能分叉', () => {
    const headers = new Headers({})
    const direct = String(githubStatusError(429, headers, `${API}/x`, null))
    const diagnosis = githubRateLimitDiagnosis(429, headers, `${API}/x`, null)
    expect(direct).toContain(diagnosis)                          // 两条投递路径共用同一段正文
    expect(diagnosis).toContain('限流')
    expect(diagnosis).toContain(GITHUB_TOKEN_ENV)                // 解法点名（凭据入口）
  })

  /* ══════════ RETRYLAYER-WIRING（F1／F2／F3）：两条链各自只说自己那条路上**真有的**东西 ══════════
   * 判据（Lead 裁定，逐字）：**同一句报文不许在两条路径上给出对方的事实。**
   * 下面每一条都驱动**真产品路径**（`searchGithub` = `searchPolicies`；`snapshot` = `sourceSnapshot`），
   * 不再手调 `retryLayer` 参数 —— 那正是 F1 溜过去的原因。 */

  test('F1 真产品路径：检索链的 429 报文**不含**取件链那句重试建议（它本来就没有重试层）', async () => {
    await withoutTokens(async () => {
      const stub = stubFetch(() => new Response('denied', { status: 429, headers: {} }))
      try {
        const text = String(await failure(searchGithub))
        expect(text).toContain('POLICY_GITHUB_RATE_LIMITED')
        expect(text).not.toContain('立刻重试只会再烧配额')      // ← 改前**真链实测为 true**（F1 的现场）
        expect(text).toContain('本来就没有重试层')              // ← 改前也是 false
        expect(text).toContain('检索链')
        expect(stub.calls.length).toBe(1)                       // 这条路确实一次即失败（没有重试层）
        expect(stub.calls[0]!.url).toContain(GITHUB_SEARCH_PATH) // 打的是 search 端点，不是取件端点
      } finally { stub.restore() }
    })
  })

  test('F2 真产品路径：检索链的"本次成本"**不许**点取件链的 commit／repo／tree', async () => {
    await withoutTokens(async () => {
      const stub = stubFetch(() => new Response('denied', { status: 429, headers: {} }))
      try {
        const text = String(await failure(searchGithub))
        // ← 改前这三条**全红**：共用的限流正文把取件链的成本口径原样发在检索链上
        expect(text).not.toContain(`一条 sourceSnapshot **最多**打 ${GITHUB_SNAPSHOT_REQUESTS} 个 api.github.com 请求`)
        expect(text).not.toContain(`${GITHUB_SNAPSHOT_REQUESTS} 个 api.github.com 请求`)
        expect(text).not.toContain('撞在第几个就只花到那一个')
        // 只说本路径真有的东西：1 个请求、打的是哪一个端点
        expect(text).toContain(GITHUB_SEARCH_PATH)
        expect(text).toContain('只打 1 个')
        expect(text).toContain('**不是** sourceSnapshot')        // 显式否认取件链的成本口径
        expect(stub.calls.length).toBe(1)
      } finally { stub.restore() }
    })
  })

  test('F2 反向·回归护栏：取件链的"本次成本"**仍是**正确的取件口径（一个字不许丢）', async () => {
    await withoutTokens(async () => {
      const stub = stubFetch(sourceStub(429, {}))
      try {
        const text = String(await failure(snapshot))
        expect(text).toContain(`一条 sourceSnapshot **最多**打 ${GITHUB_SNAPSHOT_REQUESTS} 个 api.github.com 请求（commit／repo／tree）`)
        expect(text).toContain('撞在第几个就只花到那一个')
        expect(text).toContain('本次只花 1 个')
        expect(text).not.toContain(GITHUB_SEARCH_PATH)           // 取件链不许提检索端点
        expect(text).not.toContain('policy_search')
      } finally { stub.restore() }
    })
  })

  test('F2 同族第三处：**配额桶**也不许串（core vs 检索端点自己那一份）', async () => {
    await withoutTokens(async () => {
      const fetchStub = stubFetch(sourceStub(429, {}))
      const fetched = String(await failure(snapshot).finally(() => fetchStub.restore()))
      const searchStub = stubFetch(() => new Response('denied', { status: 429, headers: {} }))
      const searched = String(await failure(searchGithub).finally(() => searchStub.restore()))
      // 取件链：core 口径（既有读数，不动）
      expect(fetched).toContain(`core 仅 ${GITHUB_ANONYMOUS_CORE_LIMIT} 次/小时`)
      expect(fetched).toContain('core 5000 次/小时')
      // 检索链：被拒的**不是** core ⇒ 不许把 core 的数字当成本路径的事实（连"解法"也不许）
      expect(searched).not.toContain(`core 仅 ${GITHUB_ANONYMOUS_CORE_LIMIT} 次/小时`)
      expect(searched).not.toContain('core 5000 次/小时')
      expect(searched).toContain('不是 core')
    })
  })

  test('F3 接缝：`classifyExhausted` 真的被 `boundedFetch` 用上（耗尽出口把诊断附在五要素之后）', async () => {
    const stub = stubFetch(() => new Response('denied', { status: 429, headers: {} }))
    try {
      const error = await boundedFetch('https://upstream.invalid/x', {}, {
        step: '建连',
        classifyExhausted: (response, url, attempts) => ({ retryable: false, diagnosis: `DIAG attempts=${attempts} status=${response.status} url=${url}` }),
      }).then(() => null, (reason: Error) => reason as Error)
      expect(stub.calls.length).toBe(POLICY_FETCH_ATTEMPTS)   // 未覆盖 ⇒ 仍按既有瞬时语义重试到耗尽
      expect(String(error)).toContain('每次尝试')              // 五要素在
      expect(String(error)).toContain('上游应答的诊断')        // ← 接线被切断时这一条**红**（F3）
      expect(String(error)).toContain(`DIAG attempts=${POLICY_FETCH_ATTEMPTS}`)
      expect(String(error)).toContain('可否重试：false（不是瞬时故障：按上面的诊断处置，**别重跑同一条命令**）')
    } finally { stub.restore() }
  })

  /**
   * ③ 裁定（`docs/REMAINING_WORK_PLAN.md` 的 ③；依据 `bugfixHistory/GITHUB-429-VARIANT-A-LANDED-20260926.md` §4.2）：
   * **变体 A 下那条"不可达接缝"【保留】** —— 删它行为零变化（N2 的 0 红），
   * 但保留它把这轮的政策变更留成一条**可复用的缝**（这一轮已经证明政策会再变：429 口径本身就被改判过一次）。
   * ⇒ 代价是：**"它现在不可达"这件事必须有人守着**，否则将来它变可达时没人知道。
   *
   * 这一条就是这个守卫。它**不是空过**，两条腿互相夹住：
   *   ① **产品路径**：逐个瞬时状态走 `sourceSnapshot`（真链路 + 替身 fetch），断言产品路径**拿不到**
   *      耗尽出口那一态（没有"先试了 N 次"、没有"上游应答的诊断"）；
   *   ② **可达性前提**：分类器要返回非 null，必须先满足 `githubRateLimited(status, headers)`；
   *      而在 `api.github.com` 上它与 `githubStatusRetryOverride` 是**同一个判定**
   *      ⇒ 分类器非 null 的应答在到达耗尽出口之前就被 `retryOverride` 原样返回了。
   * ①的读数随政策变（变体 B 一装回去，"429 只打 1 次"当场变 3 次），②是穷尽式恒等式（一处改了就红）。
   * **两条同时空过的唯一办法是把整个接缝删掉** —— 而那正是 Lead 裁定【不许】的那件事。
   */
  test('③ 保留的接缝：耗尽出口在**产品路径**上没有入口（政策再变 ⇒ 这一条会红）', async () => {
    // ① 产品路径：`boundedFetch` 会重试的状态逐个走真链路（= `TRANSIENT_STATUS` 的字面量，见 source.ts:526）。
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      const stub = stubFetch(sourceStub(status, {}))
      try {
        const text = String(await failure(snapshot))
        expect(text).not.toContain('先试了')            // ← 耗尽出口"已试了 N 次"那一态（变体 A 下不许出现）
        expect(text).not.toContain('上游应答的诊断')     // ← 分类器给的诊断（它只能从那一条出口进来）
        // 429 ⇒ 当场分类器拿走（1 次）；其余瞬时态 ⇒ 重试到耗尽（3 次）—— 两条路都不经过"非 null 分类"。
        expect(stub.calls.length).toBe(status === 429 ? ATTEMPTS_WHEN_NO_EVIDENCE : POLICY_FETCH_ATTEMPTS)
      } finally { stub.restore() }
    }
    // ② 可达性前提（穷尽式，**不靠**枚举 `TRANSIENT_STATUS`）：api.github.com 上"认限流" ⇔ "重试被覆盖"。
    const shapes: [string, Headers][] = [
      ['空头（代理剥头）', new Headers({})],
      ['配额头 remaining=0', new Headers(rateLimitHeaders())],
      ['配额头 remaining=42（权限 403 也带这个头）', new Headers(rateLimitHeaders({ 'x-ratelimit-remaining': '42' }))],
      ['retry-after（次级限流）', new Headers({ 'retry-after': '30' })],
    ]
    for (const status of [400, 401, 403, 404, 408, 425, 429, 451, 500, 502, 503, 504]) {
      for (const [label, headers] of shapes) {
        const classified = githubRateLimited(status, headers)
        const overridden = githubStatusRetryOverride(new Response(null, { status, headers }), `${API}/x`)
        // 分类器非 null ⇒ 覆盖必须先一步把应答拿走 ⇒ 耗尽出口上的非 null 分支没有入口。
        expect({ status, label, hole: classified && !overridden }).toEqual({ status, label, hole: false })
      }
    }
    // 反向：上面的恒等式不是"两边都恒假"的空过 —— 429 与"403 + 配额头"两格必须为真（将来变体 B 会把它们拆开）。
    expect(githubRateLimited(429, new Headers({}))).toBe(true)
    expect(githubStatusRetryOverride(new Response(null, { status: 429 }), `${API}/x`)).toBe(true)
    expect(githubRateLimited(403, new Headers(rateLimitHeaders()))).toBe(true)
    expect(githubStatusRetryOverride(new Response(null, { status: 403, headers: rateLimitHeaders() }), `${API}/x`)).toBe(true)
    // 别的 host：覆盖恒为假 —— 那两条链**根本不传**这两个回调，所以接缝在那里同样没有入口（不是靠"恰好没触发"）。
    expect(githubStatusRetryOverride(new Response(null, { status: 429 }), 'https://modelscope.invalid/x')).toBe(false)
    expect(githubRateLimited(429, new Headers({}))).toBe(true)
  })
})
