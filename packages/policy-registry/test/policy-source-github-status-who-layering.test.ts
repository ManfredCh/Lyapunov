/**
 * ① **401 与"权限 403"两条正文的 `who` 按层分岔**（F5／2026-09-27）。
 *
 * 来源：`bugfixHistory/RETRYLAYER-WIRING-20260926.md` §5 ③ / §10 `U3` —— 上一单把**限流正文**（403 配额/429）
 * 按 `retryLayer` 分岔了三处（`本机凭据` 的配额桶／`本次成本`／`处置建议`），但**如实登记未修**：
 * `githubStatusError` 的 **401** 与**权限 403** 两条正文**仍共用含 core 口径的 `who`**。
 *   ⇒ 检索链（`policy_search`）的 401/403 报文里写着「未设置（匿名 ⇒ **core 仅 60 次/小时**…）」，
 *   而那条路打的是 `api.github.com/search/repositories`（实测 `REQUESTS = 1`）——
 *   **core 是取件链吃的那个桶**（检索端点自己有单独一份、与 core 分开计）
 *   ⇒ **报文指向那条路径上不存在的东西**（与 §7.16 已登记的措辞问题同一族）。
 *
 * 判据（沿用上一单 Lead 裁定的那一句）：**同一句报文不许在两条路径上给出对方的事实。**
 *   · **含 core 口径的句子在检索链上必须消失**；
 *   · **取件链上逐字不变**（本文件把取件链的**整段报文**钉成字面量，改一个字就红）。
 *
 * 另外一个**本单自己加的**判据（同族）：检索链 401/403 的正文里**没有** `配额读数：resource=…` 那一行
 * ⇒ 措辞**不许指"上面那一份"**（否则就是"等到**上面那个**重置时刻"那一族：**指向不存在的一行**）。
 * 限流正文有那一行 ⇒ 那边继续用"上面 resource="，此处**反向**钉住（不许把三处措辞混成一处）。
 *
 * 全部走**真产品路径**（`searchPolicies` = `policy_search` 的 github 分支 / `sourceSnapshot` = 取件链），
 * `globalThis.fetch` 换替身 ⇒ **0 次真实网络、0 真实配额**（`U1`/`U2` 照旧未覆盖，见回执）。
 */
import { describe, expect, test } from 'bun:test'
import { githubRateLimitDiagnosis, githubSearchStatusError, githubStatusError, sourceSnapshot, GITHUB_ANONYMOUS_CORE_LIMIT, GITHUB_TOKEN_ENV } from '../src/source.ts'
import { searchPolicies } from '../src/plugin.ts'

const REPO = 'unitreerobotics/unitree_rl_gym'
const API = 'https://api.github.com'

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
/** 凭据必须**确实没有**才谈得上"匿名那一份配额"：显式清空再还原，不赌环境。 */
async function withoutTokens<T>(run: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>()
  for (const name of [GITHUB_TOKEN_ENV, 'GITHUB_TOKEN', 'GH_TOKEN']) { saved.set(name, process.env[name]); delete process.env[name] }
  try { return await run() } finally { for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
}
const failure = async (run: () => Promise<unknown>) => await run().then(() => null, (reason: Error) => reason as Error)
/** 检索链的**真产品路径**入口（`policy_search` 的 github 分支走的就是它，`plugin.ts` 里用的是具名检索入口）。 */
const searchGithub = () => searchPolicies('https://modelscope.invalid', { provider: 'github', query: 'unitree' }, new AbortController().signal)
const snapshot = () => sourceSnapshot('github', REPO, 'main', 'https://modelscope.invalid', new AbortController().signal)

/** 两条链各跑一遍同一个状态码（空头 ⇒ 403 一定是"权限 403"那一支：`githubRateLimited(403, 空头)` 为假）。 */
async function bothChains(status: number) {
  return await withoutTokens(async () => {
    const search = stubFetch(() => new Response('denied', { status, headers: {} }))
    const searched = String(await failure(searchGithub).finally(() => search.restore()))
    const searchUrls = search.calls.map(call => call.url)
    const fetchStub = stubFetch(() => new Response('denied', { status, headers: {} }))
    const fetched = String(await failure(snapshot).finally(() => fetchStub.restore()))
    const fetchUrls = fetchStub.calls.map(call => call.url)
    return { searched, fetched, searchUrls, fetchUrls }
  })
}

/** 取件链**改前那份报文**里的 `本机凭据` 一行（本单一个字都不许动它 ⇒ 钉成字面量）。 */
const FETCH_WHO = `  本机凭据：未设置（匿名 ⇒ core 仅 ${GITHUB_ANONYMOUS_CORE_LIMIT} 次/小时，且按**出口 IP** 计：同机／同出口的所有会话共用这一份）`

describe('① 401 / 权限 403：`who` 的配额桶按层分岔（F5）', () => {
  test('401 匿名 · 检索链：**不含** core 口径，且明说自己吃的是检索端点那一份', async () => {
    const { searched, searchUrls } = await bothChains(401)
    expect(searched).toContain('POLICY_GITHUB_AUTH_REQUIRED')
    // ← 改前**真链实测为 true**（F5 的现场）：检索链的 401 报文里带着 core 的读数
    expect(searched).not.toContain(`core 仅 ${GITHUB_ANONYMOUS_CORE_LIMIT} 次/小时`)
    expect(searched).not.toContain('core 5000 次/小时')
    expect(searched).toContain('检索端点自己那一份')
    expect(searched).toContain('不是 core')
    // 这条路打的确实是检索端点（报文里的 URL 就是本次真打的那一个）
    expect(searchUrls).toEqual([`${API}/search/repositories?q=unitree&per_page=10`])
    expect(searched).toContain(searchUrls[0]!)
  })

  test('权限 403（无任何限流证据）· 检索链：**不含** core 口径，权限判定本身一个字不改', async () => {
    const { searched } = await bothChains(403)
    expect(searched).toContain('POLICY_REMOTE_403')
    expect(searched).toContain('按**仓库/权限**问题处理，不是配额')
    expect(searched).not.toContain(`core 仅 ${GITHUB_ANONYMOUS_CORE_LIMIT} 次/小时`)
    expect(searched).not.toContain('core 5000 次/小时')
    expect(searched).toContain('检索端点自己那一份')
  })

  test('两处检索链措辞**不许指"上面 resource="**（那两条正文没有 `配额读数` 行）', async () => {
    for (const status of [401, 403]) {
      const { searched } = await bothChains(status)
      // 若照抄限流正文那句"被拒的是**上面 resource=** 那一份"，就变成指向**不存在的一行** ⇒ 红
      expect(searched).not.toContain('上面 resource=')
    }
    // 反向：限流正文（同一状态码家族的另一支）**有**那一行 ⇒ 那边继续用"上面 resource="，不许被本单改掉
    const rateLimit = githubRateLimitDiagnosis(429, new Headers({}), `${API}/search/repositories?q=unitree`, null, Date.now(), 'search')
    expect(rateLimit).toContain('配额读数：resource=')
    expect(rateLimit).toContain('上面 resource=')
  })

  test('取件链**逐字未变**：401 / 权限 403 两条正文与改前**逐字节相同**', async () => {
    const unauthorized = await bothChains(401)
    expect(unauthorized.fetchUrls).toEqual([`${API}/repos/${REPO}/commits/main`])
    expect(unauthorized.fetched).toBe([
      'Error: POLICY_GITHUB_AUTH_REQUIRED: GitHub 拒绝了本次请求的凭据（HTTP 401）',
      `  上游 URL：${API}/repos/${REPO}/commits/main`,
      FETCH_WHO,
      `  处置建议：把 GitHub PAT 放进 ${GITHUB_TOKEN_ENV}（兼容 GITHUB_TOKEN／GH_TOKEN）后重试。`,
    ].join('\n'))
    const forbidden = await bothChains(403)
    expect(forbidden.fetched).toBe([
      'Error: POLICY_REMOTE_403: GitHub 拒绝了这个请求（HTTP 403，且响应里没有限流证据 ⇒ 按**仓库/权限**问题处理，不是配额）',
      `  上游 URL：${API}/repos/${REPO}/commits/main`,
      FETCH_WHO,
      '  处置建议：私有仓／组织 SSO 未授权／被组织或 IP 允许列表限制／仓库改名或不存在／凭据作用域不足都会长这样。带上凭据仍 403 ⇒ 就是权限问题，**等配额重置没有用**。',
      '  若你确信这是限流：响应头可能被中间代理剥掉了 x-ratelimit-*，报文因此无法据此分类。',
    ].join('\n'))
    // 两条链的差异**只在** `上游 URL` 与 `本机凭据` 两行（其余每一行逐字相同）
    const normalize = (text: string) => text.split('\n').map(line =>
      line.startsWith('  本机凭据：') ? '<who>' : line.startsWith('  上游 URL：') ? '<url>' : line)
    expect(normalize(unauthorized.searched)).toEqual(normalize(unauthorized.fetched))
  })

  test('接线证明：检索链真路径 == 具名检索入口，且 **!=** 取件入口（同 URL、同头 ⇒ 差异只来自层）', async () => {
    for (const status of [401, 403]) {
      const { searched, searchUrls } = await bothChains(status)
      const url = searchUrls[0]!
      expect(searched).toBe(`Error: ${githubSearchStatusError(status, new Headers({}), url, null).message}`)
      expect(searched).not.toBe(`Error: ${githubStatusError(status, new Headers({}), url, null).message}`)
      // 差异**只**来自 `retryLayer`：同一 URL、同一份头，喂给取件入口就带回 core 口径
      expect(githubStatusError(status, new Headers({}), url, null).message).toContain(`core 仅 ${GITHUB_ANONYMOUS_CORE_LIMIT} 次/小时`)
      expect(searched).not.toContain(`core 仅 ${GITHUB_ANONYMOUS_CORE_LIMIT} 次/小时`)
    }
  })

  test('凭据在场 ⇒ 两条链都**不谈桶**（分岔只在匿名那一半，别把凭据分支也改了）', async () => {
    const saved = process.env[GITHUB_TOKEN_ENV]
    process.env[GITHUB_TOKEN_ENV] = 'dummy-not-a-real-key'
    try {
      const search = stubFetch(() => new Response('denied', { status: 401, headers: {} }))
      const searched = String(await failure(searchGithub).finally(() => search.restore()))
      const fetchStub = stubFetch(() => new Response('denied', { status: 401, headers: {} }))
      const fetched = String(await failure(snapshot).finally(() => fetchStub.restore()))
      for (const text of [searched, fetched]) {
        expect(text).toContain('POLICY_GITHUB_AUTH_REJECTED')
        expect(text).toContain(`本机凭据：已设置（来自 ${GITHUB_TOKEN_ENV}，值不回显）`)
        expect(text).not.toContain('core 仅')
        expect(text).not.toContain('检索端点')
        expect(text).not.toContain('dummy-not-a-real-key')          // 值绝不回显
      }
      // 凭据分支**逐字同形**：两条链的报文只差 URL（分岔只在匿名那一半生效）
      expect(searched).toBe(fetched.replace(`${API}/repos/${REPO}/commits/main`, `${API}/search/repositories?q=unitree&per_page=10`))
    } finally { if (saved === undefined) delete process.env[GITHUB_TOKEN_ENV]; else process.env[GITHUB_TOKEN_ENV] = saved }
  })

  test('两条链的请求数都是 1（分岔没有顺手加请求）', async () => {
    const unauthorized = await bothChains(401)
    expect(unauthorized.searchUrls).toHaveLength(1)
    expect(unauthorized.fetchUrls).toHaveLength(1)
    const forbidden = await bothChains(403)
    expect(forbidden.searchUrls).toHaveLength(1)
    expect(forbidden.fetchUrls).toHaveLength(1)
  })
})
