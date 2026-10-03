/**
 * W26（2026-09-26）：GitHub 取件的**匿名配额隐式依赖**与**认证入口**。
 *
 * 与 W16（打包需要网络）／W21（运行时需要 GPU 设备节点）同一族：**产品能力隐式依赖一个从未声明过的前置条件**，
 * 而这个前置条件在用户侧不可见、也不给任何解法。这里的隐式依赖是：
 *
 *   `sourceSnapshot` 的 github 分支每次取件固定打 **3 个 `api.github.com` 请求**（commit／repo／tree），
 *   而这条链此前**只带 `user-agent`**（对照 HF 侧有 `HF_TOKEN`）⇒ 匿名 core 配额 **60 次/小时、按出口 IP 计**。
 *   配额打满后的症状是裸 `POLICY_REMOTE_403`（非瞬时 ⇒ 不重试），用户既不知道自己被限流、也不知道可以带 token；
 *   更要命的是"重试"会继续消耗同一份配额 —— 在共享出口的机器上，多个会话互相把对方锁死。
 *
 * 本文件钉住四件事（全部用替身/假响应，**不打真网络、不消耗任何配额**）：
 *  1. **成本可见**：一次 github 取件＝3 个 API 请求，匿名时三个都只带 `user-agent`；
 *  2. **凭据命中即用**：`LYAPUNOV_GITHUB_TOKEN`（兼容 `GITHUB_TOKEN`／`GH_TOKEN`）命中就带 `Bearer`，
 *     且**只发给 `api.github.com`**（内容端点 `raw.githubusercontent.com` 不发凭据）；
 *  3. **两类 403 必须可区分**：配额限流（响应带限流头）⇒ `POLICY_GITHUB_RATE_LIMITED` + 重置时刻 + 处置建议；
 *     其它 403（仓库/权限）⇒ 码**保持既有 `POLICY_REMOTE_403` 不变**，但报文点名"不是配额、等重置没用"；
 *  4. **不悄悄改旧读数**：非 401/403/429（如 404）码不变，modelscope 侧行为不变。
 *  5. **W26-R1（2026-09-26 追加）429 不重试**：429 在全局 `TRANSIENT_STATUS` 里（对一般上游是对的），
 *     但 GitHub 的 429 是**限流** ⇒ 重试 3 次＝把同一份配额再烧 3 倍、还会报"可否重试：true"（错误建议）。
 *     裁决是**不动全局 `TRANSIENT_STATUS`**，只在 github 这条链上按上下文覆盖重试判定：host 是
 *     `api.github.com` **且带限流证据**（`x-ratelimit-*`／`retry-after`）⇒ 不重试，报文说清限流 + 重置时刻 +
 *     "立刻重试只会再烧配额"。负对照两条：**429 无头**与**非 github host** ⇒ 既有语义**逐字不变**。
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  boundedFetch, downloadFile, downloadPolicy, githubCredential, githubHeaders, githubRateLimited, githubRateLimitNoRetry,
  githubRateLimitReading, githubStatusError, githubStatusRetryOverride,
  githubToken, huggingfaceEndpoint, policySourceEndpoints,
  GITHUB_ANONYMOUS_CORE_LIMIT, GITHUB_RAW_MEDIA_TYPE, GITHUB_SNAPSHOT_REQUESTS, GITHUB_TOKEN_ENV,
  POLICY_FETCH_ATTEMPTS, sourceSnapshot, type PolicyManifest,
} from '../src/source.ts'
import { searchPolicies } from '../src/plugin.ts'

const REPO = 'unitreerobotics/unitree_rl_gym'
const COMMIT = 'a'.repeat(40)
const TOKEN = 'ghp_' + 'S'.repeat(36)
const emptyDir = () => mkdtempSync(join(tmpdir(), 'policy-gh-quota-'))

/** 环境变量逐条还原（GITHUB_TOKEN 可能本来就存在：不能靠"删掉"来假定干净）。 */
async function withEnv(env: Record<string, string | undefined>, run: () => Promise<void>) {
  const keys = [GITHUB_TOKEN_ENV, 'GITHUB_TOKEN', 'GH_TOKEN'] as const
  const saved = keys.map(key => [key, process.env[key]] as const)
  for (const key of keys) { const value = env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value }
  try { await run() } finally { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
}
interface Call { url: string; headers: Record<string, string> }
/** 记录每次请求的 URL 与请求头；`handler` 决定应答。 */
function stubFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [], original = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init: any = {}) => {
    const call: Call = { url: String(input), headers: (init?.headers ?? {}) as Record<string, string> }
    calls.push(call)
    return handler(call)
  }) as unknown as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}
const rateLimitHeaders = (overrides: Record<string, string> = {}) => ({
  'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-used': '60',
  'x-ratelimit-resource': 'core', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 754), ...overrides,
})
/** 未知路径一律 500：任何"多打了一个请求"都会以失败暴露，而不是静默成功。 */
const sourceStub = (status = 200, responseHeaders: Record<string, string> = {}) => (call: Call) => {
  if (!/^https:\/\/api\.github\.com\//.test(call.url)) return new Response('unexpected ' + call.url, { status: 500 })
  if (status !== 200) return new Response('denied', { status, headers: responseHeaders })
  if (call.url.includes('/commits/')) return Response.json({ sha: COMMIT })
  if (call.url.includes('/git/trees/')) return Response.json({ tree: [{ type: 'blob', mode: '100644', path: 'params/x.bin', size: 1, sha: 'b'.repeat(40) }] })
  if (new URL(call.url).pathname === `/repos/${REPO}`) return Response.json({ full_name: REPO })
  return new Response('unexpected ' + call.url, { status: 500 })
}
const snapshot = () => sourceSnapshot('github', REPO, 'main', 'https://modelscope.invalid', new AbortController().signal)
const failure = async (run: () => Promise<unknown>) => await run().then(() => null, (reason: Error) => reason)

describe('W26 GitHub 认证入口：env 覆盖、命中即用（照 W16 LYAPUNOV_MAMBA_LICENSE 的形状）', () => {
  test('取值优先级 LYAPUNOV_GITHUB_TOKEN > GITHUB_TOKEN > GH_TOKEN；空串/空白＝未设置；只报变量名不返回值', async () => {
    await withEnv({ [GITHUB_TOKEN_ENV]: 'top', GITHUB_TOKEN: 'mid', GH_TOKEN: 'low' }, async () => {
      expect(githubToken()).toBe('top')
      expect(githubCredential()).toEqual({ name: GITHUB_TOKEN_ENV, token: 'top' })
    })
    await withEnv({ [GITHUB_TOKEN_ENV]: undefined, GITHUB_TOKEN: 'mid', GH_TOKEN: 'low' }, async () => {
      expect(githubToken()).toBe('mid')                                   // 沿用本仓既有命名（product-bundle 已认这两个名）
      expect(githubCredential()?.name).toBe('GITHUB_TOKEN')
    })
    await withEnv({ [GITHUB_TOKEN_ENV]: undefined, GITHUB_TOKEN: undefined, GH_TOKEN: 'low' }, async () => {
      expect(githubCredential()).toEqual({ name: 'GH_TOKEN', token: 'low' })
    })
    await withEnv({ [GITHUB_TOKEN_ENV]: '   ', GITHUB_TOKEN: '', GH_TOKEN: undefined }, async () => {
      expect(githubToken()).toBeNull()                                    // 读不到就是没有凭据，不匿名拼假身份
    })
  })

  test('凭据作用域：只认 api.github.com，内容端点/别的 host 一律不发', async () => {
    await withEnv({ [GITHUB_TOKEN_ENV]: TOKEN }, async () => {
      expect(githubHeaders(`https://api.github.com/repos/${REPO}`)).toEqual({ authorization: `Bearer ${TOKEN}` })
      expect(githubHeaders(`https://raw.githubusercontent.com/${REPO}/${COMMIT}/params/x.bin`)).toEqual({})
      expect(githubHeaders('https://modelscope.invalid/openapi/v1/models')).toEqual({})
    })
  })

  test('命中即用：github 三个 API 请求都带 Bearer，且 token 不出现在 URL 里', async () => {
    await withEnv({ [GITHUB_TOKEN_ENV]: TOKEN }, async () => {
      const stub = stubFetch(sourceStub())
      try {
        await snapshot()
        expect(stub.calls.length).toBe(GITHUB_SNAPSHOT_REQUESTS)
        expect(stub.calls.every(call => call.headers.authorization === `Bearer ${TOKEN}`)).toBe(true)
        expect(stub.calls.every(call => !call.url.includes(TOKEN))).toBe(true)
      } finally { stub.restore() }
    })
  })

  test('负对照：未设置凭据 ⇒ 三个请求只带 user-agent（"匿名配额"这件事本身）', async () => {
    await withEnv({ [GITHUB_TOKEN_ENV]: undefined, GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, async () => {
      const stub = stubFetch(sourceStub())
      try {
        await snapshot()
        expect(stub.calls.length).toBe(GITHUB_SNAPSHOT_REQUESTS)
        expect(stub.calls.every(call => call.headers.authorization === undefined)).toBe(true)
        expect(stub.calls.every(call => typeof call.headers['user-agent'] === 'string')).toBe(true)
      } finally { stub.restore() }
    })
  })

  test('配额成本可见：一次 github 取件＝commit／repo／tree 三个请求，内容字节走 raw（不进 API 配额）', async () => {
    await withEnv({ [GITHUB_TOKEN_ENV]: undefined, GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, async () => {
      const stub = stubFetch(sourceStub())
      try {
        const out = await snapshot()
        expect(stub.calls.map(call => new URL(call.url).pathname)).toEqual([
          `/repos/${REPO}/commits/main`, `/repos/${REPO}`, `/repos/${REPO}/git/trees/${COMMIT}`,
        ])
        expect(out.files[0]?.url.startsWith('https://raw.githubusercontent.com/')).toBe(true)
      } finally { stub.restore() }
    })
  })

  test('作用域到下载：逐件取字节时（raw.githubusercontent.com）不带凭据；且**件数不改变 API 成本**', async () => {
    const payload = new TextEncoder().encode('weights')
    const gitBlob = createHash('sha1').update(`blob ${payload.byteLength}\0`).update(payload).digest('hex')
    const root = emptyDir()
    await withEnv({ [GITHUB_TOKEN_ENV]: TOKEN }, async () => {
      const stub = stubFetch(call => {
        if (call.url.includes('/commits/')) return Response.json({ sha: COMMIT })
        if (call.url.includes('/git/trees/')) return Response.json({ tree: ['params/x.bin', 'params/y.bin'].map(path => ({ type: 'blob', mode: '100644', path, size: payload.byteLength, sha: gitBlob })) })
        if (new URL(call.url).pathname === `/repos/${REPO}`) return Response.json({ full_name: REPO })
        if (call.url.startsWith('https://raw.githubusercontent.com/')) return new Response(payload, { status: 200 })
        return new Response('unexpected ' + call.url, { status: 500 })
      })
      try {
        const result = await downloadPolicy({
          dataDirectory: root, endpoint: 'https://modelscope.invalid', provider: 'github',
          modelId: REPO, revision: 'main', files: ['params/x.bin', 'params/y.bin'], signal: new AbortController().signal,
        })
        expect(result.status).toBe('DOWNLOADED')
        const raw = stub.calls.filter(call => call.url.startsWith('https://raw.githubusercontent.com/'))
        expect(raw.length).toBe(2)
        expect(raw.every(call => call.headers.authorization === undefined)).toBe(true)   // 凭据只属于 api.github.com
        const api = stub.calls.filter(call => call.url.startsWith('https://api.github.com/'))
        expect(api.length).toBe(GITHUB_SNAPSHOT_REQUESTS)                                // 2 件也好、68 件也好，API 成本恒为 3
        expect(api.every(call => call.headers.authorization === `Bearer ${TOKEN}`)).toBe(true)
      } finally { stub.restore() }
    })
  })
})

describe('W26 403 分类：配额限流 ≠ 仓库/权限（此前两者报文逐字相同）', () => {
  test('配额 403（带限流头）⇒ POLICY_GITHUB_RATE_LIMITED，报文点名限流、成本、凭据来源与处置', async () => {
    await withEnv({ [GITHUB_TOKEN_ENV]: undefined, GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, async () => {
      const stub = stubFetch(sourceStub(403, rateLimitHeaders()))
      try {
        const error = await failure(snapshot)
        const text = String(error)
        expect(text).toContain('POLICY_GITHUB_RATE_LIMITED')
        expect(text).toContain('配额（限流）已用尽')
        expect(text).toContain('不是仓库不存在、也不是网络故障')
        expect(text).toContain('limit=60')                       // 上游给的读数如实转述
        expect(text).toContain('remaining=0')
        expect(text).toContain('重置于 ')                        // 重置时刻 ⇒ "等多久"是可见的
        expect(text).toContain(`core 仅 ${GITHUB_ANONYMOUS_CORE_LIMIT} 次/小时`)   // 匿名口径点名
        expect(text).toContain(GITHUB_TOKEN_ENV)                 // **解法点名**
        expect(text).toContain(`${GITHUB_SNAPSHOT_REQUESTS} 个 api.github.com 请求`)
        expect(text).toContain('重试会继续消耗同一配额')
        expect(text).toContain(`https://api.github.com/repos/${REPO}/commits/main`) // 上游 URL 也在（W25 五要素里的那一项）
        expect(stub.calls.length).toBe(1)                        // 限流是非瞬时：**不重试**（重试只会继续烧配额）
      } finally { stub.restore() }
    })
  })

  test('权限 403（无限流头）⇒ 码保持 POLICY_REMOTE_403，但报文明确"不是配额、等重置没用"', async () => {
    await withEnv({ [GITHUB_TOKEN_ENV]: undefined, GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, async () => {
      const stub = stubFetch(sourceStub(403, {}))
      try {
        const text = String(await failure(snapshot))
        expect(text).toContain('POLICY_REMOTE_403')              // 旧码逐字不变（VERIFICATION_LEDGER 里的旧读数仍可 grep）
        expect(text).toContain('没有限流证据')
        expect(text).toContain('仓库/权限')
        expect(text).toContain('等配额重置没有用')
        expect(text).toContain(`https://api.github.com/repos/${REPO}/commits/main`)
      } finally { stub.restore() }
    })
  })

  test('区分性（本单的核心）：同一个 403，两种成因的报文必须不同', async () => {
    await withEnv({ [GITHUB_TOKEN_ENV]: undefined, GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, async () => {
      const limited = stubFetch(sourceStub(403, rateLimitHeaders()))
      const quota = String(await failure(snapshot).finally(() => limited.restore()))
      const denied = stubFetch(sourceStub(403, {}))
      const permission = String(await failure(snapshot).finally(() => denied.restore()))
      expect(quota).not.toBe(permission)
      expect(quota.startsWith('Error: POLICY_GITHUB_RATE_LIMITED')).toBe(true)
      expect(permission.startsWith('Error: POLICY_REMOTE_403')).toBe(true)
      expect(quota).not.toContain('等配额重置没有用')
      expect(permission).not.toContain('配额（限流）已用尽')
    })
  })

  test('次级限流（403 + retry-after，remaining 不是 0）同样判为限流', async () => {
    await withEnv({ [GITHUB_TOKEN_ENV]: undefined, GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, async () => {
      const stub = stubFetch(sourceStub(403, { 'retry-after': '60', 'x-ratelimit-remaining': '42' }))
      try {
        const text = String(await failure(snapshot))
        expect(text).toContain('POLICY_GITHUB_RATE_LIMITED')
        expect(text).toContain('retry-after=60s（次级限流）')
      } finally { stub.restore() }
    })
  })

  test('401 分清"没有凭据"与"凭据被拒"（对照 HF 侧 POLICY_HF_AUTH_*）', async () => {
    const anonymous = stubFetch(sourceStub(401, {}))
    await withEnv({ [GITHUB_TOKEN_ENV]: undefined, GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, async () => {
      const text = String(await failure(snapshot).finally(() => anonymous.restore()))
      expect(text).toContain('POLICY_GITHUB_AUTH_REQUIRED')
      expect(text).toContain(GITHUB_TOKEN_ENV)
    })
    const rejected = stubFetch(sourceStub(401, {}))
    await withEnv({ [GITHUB_TOKEN_ENV]: TOKEN }, async () => {
      const text = String(await failure(snapshot).finally(() => rejected.restore()))
      expect(text).toContain('POLICY_GITHUB_AUTH_REJECTED')
      expect(text).toContain(GITHUB_TOKEN_ENV)                 // 报**变量名**便于定位
      expect(text).not.toContain(TOKEN)                        // **绝不回显凭据值**
    })
  })

  test('带凭据仍被限流 ⇒ 报文说"这个凭据自己的配额也用尽了"（不把有 token 说成匿名）', async () => {
    await withEnv({ [GITHUB_TOKEN_ENV]: TOKEN }, async () => {
      const stub = stubFetch(sourceStub(403, rateLimitHeaders({ 'x-ratelimit-limit': '5000', 'x-ratelimit-used': '5000' })))
      try {
        const text = String(await failure(snapshot))
        expect(text).toContain('POLICY_GITHUB_RATE_LIMITED')
        expect(text).toContain(`已设置（来自 ${GITHUB_TOKEN_ENV}，值不回显）`)
        expect(text).toContain('这个凭据自己的配额也用尽了')
        expect(text).not.toContain(TOKEN)
      } finally { stub.restore() }
    })
  })

  test('不悄悄改旧读数：github 404 仍是 POLICY_REMOTE_404，modelscope 403 仍是裸 POLICY_REMOTE_403', async () => {
    const notFound = stubFetch(sourceStub(404, {}))
    await withEnv({ [GITHUB_TOKEN_ENV]: TOKEN }, async () => {
      expect(String(await failure(snapshot).finally(() => notFound.restore()))).toBe('Error: POLICY_REMOTE_404')
    })
    const scopeForbidden = stubFetch(() => new Response('denied', { status: 403 }))
    await withEnv({ [GITHUB_TOKEN_ENV]: undefined, GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, async () => {
      const text = String(await failure(() => sourceSnapshot('modelscope', REPO, 'main', 'https://modelscope.invalid', new AbortController().signal)).finally(() => scopeForbidden.restore()))
      expect(text).toBe('Error: POLICY_REMOTE_403')
    })
  })

  test('端到端：配额 403 ⇒ manifest.error 里是限流诊断（不是裸码），且失败尝试留痕', async () => {
    const root = emptyDir()
    await withEnv({ [GITHUB_TOKEN_ENV]: undefined, GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, async () => {
      const stub = stubFetch(sourceStub(403, rateLimitHeaders()))
      try {
        const error = await failure(() => downloadPolicy({
          dataDirectory: root, endpoint: 'https://modelscope.invalid', provider: 'github',
          modelId: REPO, revision: 'main', files: ['params/x.bin'], signal: new AbortController().signal,
        }))
        expect(String(error)).toContain('POLICY_GITHUB_RATE_LIMITED')
        const manifest = JSON.parse(readFileSync(join(root, 'policies', 'github', `${REPO.replace('/', '__')}`, 'main', 'manifest.json'), 'utf8')) as PolicyManifest
        expect(manifest.status).toBe('FAILED')
        expect(manifest.error).toContain('POLICY_GITHUB_RATE_LIMITED')
        expect(manifest.error).toContain(GITHUB_TOKEN_ENV)
        expect(manifest.error).not.toBe('Error: POLICY_REMOTE_403')   // 旧症状：这一行什么也没说
      } finally { stub.restore() }
    })
  })
})

describe('W26 检索路径同一条链：policy_search 的 github 分支也吃同一份匿名配额', () => {
  const search = () => searchPolicies('https://modelscope.invalid', { provider: 'github', query: 'unitree' }, new AbortController().signal)
  const searchStub = (status: number, headers: Record<string, string> = {}) => stubFetch(() => status === 200
    ? Response.json({ items: [{ full_name: REPO }], total_count: 1 })
    : new Response('denied', { status, headers }))

  test('命中即用：检索请求也带 Bearer（此前同样只带 user-agent）', async () => {
    await withEnv({ [GITHUB_TOKEN_ENV]: TOKEN }, async () => {
      const stub = searchStub(200)
      try {
        const result = await search()
        expect(result.status).toBe('MATCHES')
        expect(stub.calls.length).toBe(1)
        expect(stub.calls[0]!.url.startsWith('https://api.github.com/search/repositories?')).toBe(true)
        expect(stub.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`)
      } finally { stub.restore() }
    })
  })

  test('配额 403 ⇒ 同一套限流诊断；权限 403 ⇒ 同一套"不是配额"；其余状态码保持既有 POLICY_SEARCH_<status>', async () => {
    await withEnv({ [GITHUB_TOKEN_ENV]: undefined, GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, async () => {
      const limited = searchStub(403, rateLimitHeaders())
      expect(String(await failure(search).finally(() => limited.restore()))).toContain('POLICY_GITHUB_RATE_LIMITED')
      const denied = searchStub(403, {})
      expect(String(await failure(search).finally(() => denied.restore()))).toContain('POLICY_REMOTE_403')
      const notFound = searchStub(404, {})
      expect(String(await failure(search).finally(() => notFound.restore()))).toBe('Error: POLICY_SEARCH_404')
    })
  })
})

describe('W26 限流读数（只用上游给的事实）', () => {
  test('githubRateLimitReading：reset 秒数转成 UTC 时刻与"还有多久"（用固定 now，结果确定）', () => {
    const now = 1_700_000_000_000
    const headers = new Headers({ 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-used': '60', 'x-ratelimit-resource': 'core', 'x-ratelimit-reset': String(now / 1000 + 300) })
    const reading = githubRateLimitReading(headers, now)
    expect(reading).toEqual({ resource: 'core', limit: 60, remaining: 0, used: 60, resetAt: '2023-11-14T22:18:20.000Z', resetInSeconds: 300, retryAfterSeconds: null })
  })

  test('限流判定的边界：403 无头＝不是限流（不能把权限问题说成限流）；429＝限流；reset 已过 ⇒ 0 而不是负数', () => {
    expect(githubRateLimited(403, new Headers({}))).toBe(false)
    expect(githubRateLimited(403, new Headers({ 'x-ratelimit-remaining': '0' }))).toBe(true)
    expect(githubRateLimited(403, new Headers({ 'retry-after': '30' }))).toBe(true)
    expect(githubRateLimited(403, new Headers({ 'x-ratelimit-remaining': '42' }))).toBe(false)
    expect(githubRateLimited(429, new Headers({}))).toBe(true)
    expect(githubRateLimited(404, new Headers({ 'x-ratelimit-remaining': '0' }))).toBe(false)
    const past = new Headers({ 'x-ratelimit-reset': '1000' })
    expect(githubRateLimitReading(past, 2_000_000).resetInSeconds).toBe(0)
  })

  test('githubStatusError 的码面：401/403/429 分类，其余保持 POLICY_REMOTE_<status>', () => {
    const headers = new Headers({})
    const credential = { name: GITHUB_TOKEN_ENV, token: TOKEN }
    expect(String(githubStatusError(401, headers, 'https://api.github.com/x', null))).toStartWith('Error: POLICY_GITHUB_AUTH_REQUIRED')
    expect(String(githubStatusError(401, headers, 'https://api.github.com/x', credential))).toStartWith('Error: POLICY_GITHUB_AUTH_REJECTED')
    expect(String(githubStatusError(403, new Headers({ 'retry-after': '1' }), 'https://api.github.com/x', null))).toStartWith('Error: POLICY_GITHUB_RATE_LIMITED')
    expect(String(githubStatusError(429, headers, 'https://api.github.com/x', null))).toStartWith('Error: POLICY_GITHUB_RATE_LIMITED')
    expect(String(githubStatusError(403, headers, 'https://api.github.com/x', null))).toStartWith('Error: POLICY_REMOTE_403')
    expect(String(githubStatusError(404, headers, 'https://api.github.com/x', null))).toBe('Error: POLICY_REMOTE_404')
    expect(String(githubStatusError(451, headers, 'https://api.github.com/x', null))).toBe('Error: POLICY_REMOTE_451')
  })
})

/**
 * W26-R1（2026-09-26）：429 是**限流**，不许再说"可否重试：true"。
 *
 * 覆盖**只**发生在 github 这条链上：`boundedFetch` 的 `retryOverride`（`githubStatusRetryOverride`）。
 * 全局 `TRANSIENT_STATUS` **一个字没改** —— 所以 HF／ModelScope 的 429 仍按既有语义重试，
 * 这两个负对照就在下面（不是"应该没影响"，是读数）。
 */
describe('W26-R1 429 限流不重试：只在 github 这条链上覆盖重试判定（全局 TRANSIENT_STATUS 一个字不改）', () => {
  test('429 + 限流头 ⇒ 只打 1 个请求（不再烧 3 倍配额），报文说清"限流 / 重置时刻 / 立刻重试只会再烧配额"', async () => {
    await withEnv({ [GITHUB_TOKEN_ENV]: undefined, GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, async () => {
      const stub = stubFetch(sourceStub(429, rateLimitHeaders()))
      try {
        const text = String(await failure(snapshot))
        expect(text.startsWith('Error: POLICY_GITHUB_RATE_LIMITED')).toBe(true)  // 走限流分类器，不是 PolicyFetchError
        expect(text).toContain('配额（限流）已用尽')
        expect(text).toContain('不是仓库不存在、也不是网络故障')
        expect(text).toContain('limit=60')
        expect(text).toContain('remaining=0')
        expect(text).toContain('重置于 ')                        // 重置时刻 ⇒ "等多久"可见
        expect(text).toContain('不重试')                          // 重试判定**明说**
        expect(text).toContain('立刻重试只会再烧配额')             // 限流语境下的正确建议
        expect(text).toContain(GITHUB_TOKEN_ENV)                 // 解法仍点名
        expect(text).not.toContain('可否重试：true')              // 改前的错误建议：不许再出现
        expect(text).not.toContain('POLICY_FETCH_FAILED')        // 也没有走"3 次瞬时重试"那条出口
        expect(stub.calls.length).toBe(1)                        // **1 个请求＝1 个配额**（改前 3 次尝试＝3 倍）
        expect(stub.calls[0]!.url).toContain('/commits/main')
      } finally { stub.restore() }
    })
  })

  test('429 + 仅 retry-after（次级限流，没有 x-ratelimit-*）⇒ 同样不重试、同样报限流', async () => {
    await withEnv({ [GITHUB_TOKEN_ENV]: undefined, GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, async () => {
      const stub = stubFetch(sourceStub(429, { 'retry-after': '30' }))
      try {
        const text = String(await failure(snapshot))
        expect(text).toContain('POLICY_GITHUB_RATE_LIMITED')
        expect(text).toContain('retry-after=30s（次级限流）')
        expect(stub.calls.length).toBe(1)                        // 次级限流同样**不许立刻重试**
      } finally { stub.restore() }
    })
  })

  test('（§7.16 改判后）github 429 **无头**：不再要求限流证据在场 ⇒ 同样只打 1 个请求、同样走限流分类器', async () => {
    await withEnv({ [GITHUB_TOKEN_ENV]: undefined, GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, async () => {
      const stub = stubFetch(sourceStub(429, {}))
      try {
        const text = String(await failure(snapshot))
        // Lead 2026-09-27 `docs/REMAINING_WORK_PLAN.md` §7.16 明确修订 R-fix#3 §2.1：
        // **429 一律走分类器；重试覆盖不再要求限流证据在场**（报文说"不重试"就必须真的只打 1 次）。
        // 本条改前期望"仍重试 3 次 + 可否重试：true"（旧口径），已按改判更新；无证据时**分不清被剥头的限流**
        // 与其它 429，但那不影响"该不该重试"，且不再白烧 3 倍匿名配额。
        expect(stub.calls.length).toBe(1)                        // 1 个请求 ＝ 1 个配额（改前 3 次）
        expect(text).toContain('POLICY_GITHUB_RATE_LIMITED')
        expect(text).toContain('重试判定：不重试')
        expect(text).toContain('重置指引')                        // 没有证据 ⇒ 不给时刻，给"去哪儿查"（不指向不存在的行）
        expect(text).not.toContain('可否重试：true')              // 报文与传输行为一致：不再说谎
        expect(text).not.toContain('POLICY_FETCH_FAILED')        // 没走"3 次瞬时重试"那条出口
      } finally { stub.restore() }
    })
  })

  test('负对照 B：非 github host（modelscope）429 + 限流头 ⇒ 一次都不覆盖：两个元数据请求各重试 3 次、报文照旧', async () => {
    const stub = stubFetch(() => new Response('denied', { status: 429, headers: rateLimitHeaders() }))
    try {
      const text = String(await failure(() => sourceSnapshot('modelscope', REPO, 'main', 'https://modelscope.invalid', new AbortController().signal)))
      expect(stub.calls.length).toBe(2 * POLICY_FETCH_ATTEMPTS)  // info + listing，各 3 次尝试：**别的 provider 没被误伤**
      expect(stub.calls.every(call => !call.url.startsWith('https://api.github.com/'))).toBe(true)
      expect(text).toContain('POLICY_FETCH_FAILED')
      expect(text).toContain('上游 HTTP 429')
      expect(text).toContain('可否重试：true')
      expect(text).not.toContain('POLICY_GITHUB_RATE_LIMITED')
    } finally { stub.restore() }
  })

  test('负对照 C：HF 429 + 限流头 ⇒ 同样不覆盖：HF 既有重试语义一个字不改（裁决要保护的就是它）', async () => {
    const stub = stubFetch(() => new Response('denied', { status: 429, headers: rateLimitHeaders() }))
    try {
      const text = String(await failure(() => sourceSnapshot('huggingface', REPO, 'main', 'https://modelscope.invalid', new AbortController().signal)))
      expect(stub.calls.length).toBe(POLICY_FETCH_ATTEMPTS)      // 3 次尝试照旧
      expect(stub.calls.every(call => call.url.startsWith(huggingfaceEndpoint()))).toBe(true)
      expect(text).toContain('上游 HTTP 429')
      expect(text).toContain('可否重试：true')
      expect(text).not.toContain('POLICY_GITHUB_RATE_LIMITED')
    } finally { stub.restore() }
  })

  test('接缝（boundedFetch）：不传 retryOverride ⇒ 429 照旧重试 3 次；传了 ⇒ 1 次就返回应答', async () => {
    const stub = stubFetch(() => new Response('denied', { status: 429, headers: rateLimitHeaders() }))
    try {
      const error = await boundedFetch('https://upstream.invalid/x', {}, { step: '建连' }).then(() => null, (reason: Error) => reason)
      expect(stub.calls.length).toBe(POLICY_FETCH_ATTEMPTS)      // 默认口径＝全局 TRANSIENT_STATUS，未动
      expect(String(error)).toContain('可否重试：true')
      const response = await boundedFetch(`https://${'api.github.com'}/x`, {}, { step: '解析 source', retryOverride: githubStatusRetryOverride })
      expect(stub.calls.length).toBe(POLICY_FETCH_ATTEMPTS + 1)  // 覆盖后**不再尝试**
      expect(response.status).toBe(429)                          // 应答原样交给调用方的分类器
    } finally { stub.restore() }
  })

  test('判定边界（§7.16 改判后）：覆盖 = host ∧ 限流（**不再要求证据在场**）；权限 403 的配额头不会被误判', () => {
    const github = 'https://api.github.com/repos/x/y'
    const evidence = new Headers(rateLimitHeaders())
    expect(githubRateLimitNoRetry(429, evidence, github)).toBe(true)
    expect(githubRateLimitNoRetry(429, new Headers({}), github)).toBe(true)                         // §7.16（甲）：无证据也覆盖（改前是 false）
    expect(githubRateLimitNoRetry(429, new Headers({}), 'https://modelscope.invalid/x')).toBe(false) // **host 守卫才是保护别的 provider 的那一件**
    expect(githubRateLimitNoRetry(429, evidence, 'https://modelscope.invalid/x')).toBe(false)
    expect(githubRateLimitNoRetry(403, evidence, github)).toBe(true)                                // remaining=0 ⇒ 配额 403
    expect(githubRateLimitNoRetry(403, new Headers({ 'retry-after': '5' }), github)).toBe(true)     // 次级限流
    expect(githubRateLimitNoRetry(403, new Headers({ 'x-ratelimit-remaining': '42' }), github)).toBe(false) // 权限 403 也带配额头，但不是限流
    expect(githubRateLimitNoRetry(404, evidence, github)).toBe(false)
    // 分类与传输必须一致：429 无头既然不重试，报文就必须说"不重试"（改前这条断言是 not.toContain）
    expect(githubRateLimited(429, new Headers({}))).toBe(true)
    expect(String(githubStatusError(429, new Headers({}), github, null))).toContain('重试判定：不重试')
    expect(String(githubStatusError(429, new Headers({}), github, null))).toContain('重置指引')     // 无证据 ⇒ 给"去哪儿查"，不编时刻
  })

  test('端到端：github 429 ⇒ manifest.error 是限流诊断（不是 POLICY_FETCH_FAILED 五要素），整次取件只花 1 个配额', async () => {
    const root = emptyDir()
    await withEnv({ [GITHUB_TOKEN_ENV]: undefined, GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, async () => {
      const stub = stubFetch(sourceStub(429, rateLimitHeaders()))
      try {
        const error = await failure(() => downloadPolicy({
          dataDirectory: root, endpoint: 'https://modelscope.invalid', provider: 'github',
          modelId: REPO, revision: 'main', files: ['params/x.bin'], signal: new AbortController().signal,
        }))
        expect(String(error)).toContain('POLICY_GITHUB_RATE_LIMITED')
        const manifest = JSON.parse(readFileSync(join(root, 'policies', 'github', `${REPO.replace('/', '__')}`, 'main', 'manifest.json'), 'utf8')) as PolicyManifest
        expect(manifest.status).toBe('FAILED')
        expect(manifest.error).toContain('POLICY_GITHUB_RATE_LIMITED')
        expect(manifest.error).toContain('立刻重试只会再烧配额')
        expect(manifest.error).not.toContain('可否重试：true')
        expect(stub.calls.filter(call => call.url.startsWith('https://api.github.com/')).length).toBe(1)  // 3 → 1 的真实收益
      } finally { stub.restore() }
    })
  })
})

/**
 * W27（2026-09-26 · Lead 裁决 a）：`source.ts` 把 github 分支的内容地址**硬编**成 `raw.githubusercontent.com`
 * 而且**没有备用端点**。P13 实测：同一时刻 `curl` 通、软件自己的下载器 20 次全失败，而软件直连那个主机
 * 端口 **71ms 就连上** ⇒ 不是 DNS/路由，是 **TLS 握手特征被中间盒丢包**；同一批字节从 `api.github.com`
 * 的内容接口能取到、且指纹逐字相同。
 *
 * 裁决是**做回退链、不是换端点**（内容接口有速率限制：未认证 60 次/小时，且语义是"API"不是"原文"）：
 *  `raw.githubusercontent.com` **优先** → 失败回退内容接口；**必须记录"本次字节由哪个端点提供"**。
 * 两条衔接也钉在这里：
 *  1. **复用** P18 的 `githubHeaders`／`githubStatusError`（凭据只发 `api.github.com`）与 R-fix#3 的
 *     `githubStatusOverride` 判定（429 限流**不重试**）—— 否则内容接口的 429 会退回"重试 3 次 + 可否重试：
 *     true"，等于把刚修好的口子重新打开；
 *  2. 回退**只**发生在传输层失败（超时/断流）：校验不符、4xx、状态类诊断（限流/权限）**不回退** ——
 *     换端点只会再烧一份配额，还会把"这批字节不可信"说成另一回事。
 * 全部用替身/假响应：**不打真 GitHub**（配额 60/小时，已被打满过）。
 */
describe('W27 端点回退链：raw 优先 → 失败回退内容接口，且记下"本次由哪个端点提供"（裁决 a）', () => {
  const payload = new TextEncoder().encode('weights')
  const gitBlob = createHash('sha1').update(`blob ${payload.byteLength}\0`).update(payload).digest('hex')
  const isRaw = (call: Call) => call.url.startsWith('https://raw.githubusercontent.com/')
  const isContents = (call: Call) => call.url.startsWith('https://api.github.com/') && call.url.includes('/contents/')
  const isMetadata = (call: Call) => call.url.startsWith('https://api.github.com/') && !isContents(call)
  /** 断流（W25／P13 实测过的那个 `socket connection was closed unexpectedly`）。 */
  const socketClosed = (): never => { throw new Error('The socket connection was closed unexpectedly.') }
  /** 超时（P13 的形状：连得上、但应答永远不来）。用带 name 的错误**秒级**复现，不真等 30s。 */
  const timedOut = (): never => { const error = new Error('The operation timed out.'); error.name = 'TimeoutError'; throw error }
  /** 元数据三跳照旧；内容字节按端点分派 ⇒ "哪个端点被打了几次"是直接读数。 */
  const chainStub = (handlers: { raw: (call: Call) => Response | Promise<Response>; contents: (call: Call) => Response | Promise<Response> }) =>
    stubFetch((call: Call) => {
      if (call.url.includes('/commits/')) return Response.json({ sha: COMMIT })
      if (call.url.includes('/git/trees/')) return Response.json({ tree: [{ type: 'blob', mode: '100644', path: 'params/x.bin', size: payload.byteLength, sha: gitBlob }] })
      if (new URL(call.url).pathname === `/repos/${REPO}`) return Response.json({ full_name: REPO })
      if (isRaw(call)) return handlers.raw(call)
      if (isContents(call)) return handlers.contents(call)
      return new Response('unexpected ' + call.url, { status: 500 })
    })
  const readings = (stub: { calls: Call[] }) => ({ raw: stub.calls.filter(isRaw).length, contents: stub.calls.filter(isContents).length, metadata: stub.calls.filter(isMetadata).length })
  const download = (root: string) => downloadPolicy({
    dataDirectory: root, endpoint: 'https://modelscope.invalid', provider: 'github',
    modelId: REPO, revision: 'main', files: ['params/x.bin'], signal: new AbortController().signal,
  })
  const manifestOf = (root: string) => JSON.parse(readFileSync(join(root, 'policies', 'github', `${REPO.replace('/', '__')}`, 'main', 'manifest.json'), 'utf8')) as PolicyManifest
  const transfersOf = (root: string) => manifestOf(root).transfers
  const successRow = (root: string) => transfersOf(root).find(row => row.kind === undefined)!

  test('链的构造：github 每件都有主端点（raw）+ 备用端点（内容接口）；其余来源链长恒为 1', async () => {
    const stub = stubFetch(sourceStub())
    try {
      const out = await snapshot()
      const file = out.files[0]!
      expect(file.url).toBe(`https://raw.githubusercontent.com/${REPO}/${COMMIT}/params/x.bin`)          // 主端点＝raw（**优先**，不占 API 配额、不需要凭据）
      expect(file.fallbackUrl).toBe(`https://api.github.com/repos/${REPO}/contents/params/x.bin?ref=${COMMIT}`)  // 备用端点＝内容接口
      expect(policySourceEndpoints(file)).toEqual([
        { endpoint: 'raw.githubusercontent.com', url: file.url },
        { endpoint: 'api.github.com', url: file.fallbackUrl!, accept: GITHUB_RAW_MEDIA_TYPE },           // 要**原文**，不是 base64 包在 JSON 里
      ])
      // 别的来源没有第二跳：链长为 1 ⇒ 行为与"只有一个端点"逐字一致。
      expect(policySourceEndpoints({ path: 'a.bin', bytes: 1, revision: 'r', url: 'https://hf-mirror.com/x' }))
        .toEqual([{ endpoint: 'hf-mirror.com', url: 'https://hf-mirror.com/x' }])
    } finally { stub.restore() }
  })

  test('raw 断流 ⇒ 回退内容接口：字节到手，且记账说清"本次由 api.github.com 提供"', async () => {
    const root = emptyDir()
    const stub = chainStub({ raw: socketClosed, contents: () => new Response(payload, { status: 200 }) })
    try {
      const result = await download(root)
      expect(result.status).toBe('DOWNLOADED')
      const seen = readings(stub)
      expect(seen.raw).toBe(POLICY_FETCH_ATTEMPTS)        // raw 这一跳自己先有界重试 3 次（W25 语义不变）
      expect(seen.metadata).toBe(GITHUB_SNAPSHOT_REQUESTS) // 元数据仍是 3 个请求 —— 回退不改元数据成本
      expect(seen.contents).toBe(1)                        // 回退只打 1 次内容接口
      const row = successRow(root)
      expect(row.path).toBe('params/x.bin')
      expect(row.servedByEndpoint).toBe('api.github.com')                     // **本次字节由哪个端点提供**
      expect(row.answeredByEndpoint).toBe('api.github.com')                   // 没有 3xx ⇒ 应答方就是链上那一跳
      expect(row.fallbackUsed).toBe(true)
      expect(row.endpointsTried).toEqual(['raw.githubusercontent.com', 'api.github.com'])
      // 被放弃的那一跳也留痕（否则"主端点失败过"在报文里会整段消失）
      const abandoned = transfersOf(root).filter(row => row.endpoint === 'raw.githubusercontent.com')
      expect(abandoned.length).toBeGreaterThanOrEqual(POLICY_FETCH_ATTEMPTS)
      expect(abandoned.some(row => String(row.reason).includes('不可用') && String(row.reason).includes('回退到 api.github.com'))).toBe(true)
      // 内容接口那一跳带 `Accept: application/vnd.github.raw`（要原文）
      expect(stub.calls.find(isContents)!.headers.accept).toBe(GITHUB_RAW_MEDIA_TYPE)
      // 字节真的落盘、身份与来源清单一致（回退不改身份校验）
      const bytes = readFileSync(join(root, 'policies', 'github', `${REPO.replace('/', '__')}`, 'main', 'params', 'x.bin'))
      expect(bytes.byteLength).toBe(payload.byteLength)
      expect(createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')).toBe(gitBlob)
    } finally { stub.restore() }
  })

  test('raw 超时（TimeoutError）同样回退：这是 P13 实测的形状，不是只看一种错误', async () => {
    const root = emptyDir()
    const stub = chainStub({ raw: timedOut, contents: () => new Response(payload, { status: 200 }) })
    try {
      const result = await download(root)
      expect(result.status).toBe('DOWNLOADED')
      expect(readings(stub)).toEqual({ raw: POLICY_FETCH_ATTEMPTS, contents: 1, metadata: GITHUB_SNAPSHOT_REQUESTS })
      expect(successRow(root).servedByEndpoint).toBe('api.github.com')
    } finally { stub.restore() }
  })

  test('raw 正常时**不**回退，但记账照旧（"由 raw 提供"与"没走备用端点"都是读数）', async () => {
    const root = emptyDir()
    const stub = chainStub({ raw: () => new Response(payload, { status: 200 }), contents: () => { throw new Error('内容接口不该被碰到') } })
    try {
      expect((await download(root)).status).toBe('DOWNLOADED')
      expect(readings(stub)).toEqual({ raw: 1, contents: 0, metadata: GITHUB_SNAPSHOT_REQUESTS })
      const row = successRow(root)
      expect(row.servedByEndpoint).toBe('raw.githubusercontent.com')
      expect(row.fallbackUsed).toBe(false)
      expect(row.endpointsTried).toEqual(['raw.githubusercontent.com'])
      expect(Object.keys(row)).toContain('servedByEndpoint')   // 字段名本身要能一眼看出"这是端点"
      expect(row.kind).toBeUndefined()                          // 逐件结果仍与 kind:'attempt-failed' 可区分
    } finally { stub.restore() }
  })

  test('核心读数：回退后的 429（带限流头）⇒ 内容接口**只打 1 次**（1 个请求＝1 个配额），报文点名端点与重置时刻', async () => {
    const root = emptyDir()
    const stub = chainStub({ raw: socketClosed, contents: () => new Response('denied', { status: 429, headers: rateLimitHeaders() }) })
    try {
      const error = await failure(() => download(root))
      const text = String(error)
      // R-fix#3 那套判定被**复用**（同一个 `githubStatusError` + 同一个限流覆盖）：不重试、且给出重置时刻
      expect(text).toContain('POLICY_GITHUB_RATE_LIMITED')
      expect(text).toContain('配额（限流）已用尽')
      expect(text).toContain('重试判定：不重试')
      expect(text).toContain('立刻重试只会再烧配额')
      expect(text).toContain('重置于 ')
      expect(text).toContain('端点：api.github.com')          // 错误对象上也一眼看出是**哪个端点**
      expect(text).not.toContain('可否重试：true')             // 改前的错误建议：回退路径上同样不许出现
      expect(text).not.toContain('POLICY_FETCH_FAILED')
      expect(readings(stub)).toEqual({ raw: POLICY_FETCH_ATTEMPTS, contents: 1, metadata: GITHUB_SNAPSHOT_REQUESTS })  // 429 不重试：内容接口只花 1 个配额
      const manifest = manifestOf(root)
      expect(manifest.status).toBe('FAILED')
      expect(manifest.error).toContain('POLICY_GITHUB_RATE_LIMITED')
      expect(manifest.error).toContain('端点：api.github.com')
      expect(manifest.error).not.toContain('可否重试：true')
      // 失败留痕也要自洽：记的是**失败那一跳自己的**端点与 URL（不是主端点的），且明确 retryable=false
      const failed = manifest.transfers.filter(row => row.kind === 'attempt-failed').at(-1)!
      expect(failed.endpoint).toBe('api.github.com')
      expect(String(failed.url)).toContain('/contents/')
      expect(failed.retryable).toBe(false)
    } finally { stub.restore() }
  })

  test('回退后的 429 **无**限流头（§7.16 改判后）：覆盖照样生效 ⇒ 也只打 1 次，且报文与传输一致', async () => {
    const root = emptyDir()
    const stub = chainStub({ raw: socketClosed, contents: () => new Response('denied', { status: 429 }) })
    try {
      const text = String(await failure(() => download(root)))
      // §7.16（甲）：重试覆盖**不再要求限流证据在场** —— 429 在语义上就是"你被限流了"，
      // 而且报文说"不重试"就必须真的不重试（旧口径下报文与传输行为分叉＝报文在说谎）。
      expect(readings(stub).contents).toBe(1)                      // 1 个请求 ＝ 1 个配额（改前期望 3 次）
      expect(text).toContain('POLICY_GITHUB_RATE_LIMITED')
      expect(text).toContain('重试判定：不重试')
      expect(text).toContain('重置指引')                            // 无证据 ⇒ 给"去哪儿查"，不编时刻
      expect(text).not.toContain('可否重试：true')
      expect(text).not.toContain('POLICY_FETCH_FAILED')
      // 别的 provider 的 429 一个字不改：那条读数在下面的「负对照 B/C」里（非 github host ⇒ 不覆盖）
    } finally { stub.restore() }
  })

  test('负对照 B：raw 404（确定性应答）**不回退** —— 换端点只会再烧一份配额', async () => {
    const root = emptyDir()
    const stub = chainStub({ raw: () => new Response('nope', { status: 404 }), contents: () => { throw new Error('内容接口不该被碰到') } })
    try {
      const text = String(await failure(() => download(root)))
      expect(readings(stub)).toEqual({ raw: 1, contents: 0, metadata: GITHUB_SNAPSHOT_REQUESTS })
      expect(text).toContain('POLICY_DOWNLOAD_404')            // 旧读数逐字不变（不悄悄改码）
      expect(text).toContain('可否重试：false')
    } finally { stub.restore() }
  })

  test('负对照 C：校验不符（字节到了、但不是那一批）**不回退** —— 否则等于把"来源不可信"换成"再抓一次看看"', async () => {
    const root = emptyDir()
    const stub = chainStub({ raw: () => new Response(payload.map(byte => byte ^ 0xff), { status: 200 }), contents: () => new Response(payload, { status: 200 }) })
    try {
      const text = String(await failure(() => download(root)))
      expect(readings(stub)).toEqual({ raw: 1, contents: 0, metadata: GITHUB_SNAPSHOT_REQUESTS })
      expect(text).toContain('POLICY_SOURCE_CHECKSUM_MISMATCH')
      expect(text).toContain('可否重试：false')
    } finally { stub.restore() }
  })

  test('凭据作用域（复用 P18 的 githubHeaders）：回退那一跳带 Bearer，raw 那一跳一个字节凭据都不带', async () => {
    const root = emptyDir()
    await withEnv({ [GITHUB_TOKEN_ENV]: TOKEN }, async () => {
      const stub = chainStub({ raw: socketClosed, contents: () => new Response(payload, { status: 200 }) })
      try {
        expect((await download(root)).status).toBe('DOWNLOADED')
        expect(stub.calls.filter(isRaw).every(call => call.headers.authorization === undefined)).toBe(true)      // 凭据只属于 api.github.com
        expect(stub.calls.filter(isRaw).length).toBeGreaterThan(0)                                                // 真的打过 raw（不是"没打所以没带"）
        expect(stub.calls.find(isContents)!.headers.authorization).toBe(`Bearer ${TOKEN}`)                        // 回退那一跳命中即用
        expect(stub.calls.every(call => !call.url.includes(TOKEN))).toBe(true)                                    // 值绝不进 URL
      } finally { stub.restore() }
    })
  })

  test('调用方取消不回退：链上不再有第二次请求（回退也是白跑）', async () => {
    const root = emptyDir()
    const controller = new AbortController()
    const stub = chainStub({ raw: () => { controller.abort(new Error('POLICY_CANCELLED')); return socketClosed() }, contents: () => { throw new Error('内容接口不该被碰到') } })
    try {
      const error = await failure(() => downloadPolicy({
        dataDirectory: root, endpoint: 'https://modelscope.invalid', provider: 'github',
        modelId: REPO, revision: 'main', files: ['params/x.bin'], signal: controller.signal,
      }))
      expect(String(error)).toContain('POLICY_CANCELLED')
      expect(readings(stub).contents).toBe(0)
      expect(manifestOf(root).status).toBe('CANCELLED')
    } finally { stub.restore() }
  })

  test('内容接口 302 到 raw 主机：逐跳按 host 现算 —— 跳过去那一跳**不转送凭据**，且"字节由谁给的"如实记', async () => {
    const root = emptyDir()
    await withEnv({ [GITHUB_TOKEN_ENV]: TOKEN }, async () => {
      let contentsHit = false
      const stub = chainStub({
        // 主端点这一跳一直断流（内部有界重试 3 次都失败）；302 之后的那一跳才回字节
        raw: () => contentsHit ? new Response(payload, { status: 200 }) : socketClosed(),
        contents: () => { contentsHit = true; return new Response(null, { status: 302, headers: { location: `https://raw.githubusercontent.com/${REPO}/${COMMIT}/params/x.bin` } }) },
      })
      try {
        expect((await download(root)).status).toBe('DOWNLOADED')
        const row = successRow(root)
        expect(row.servedByEndpoint).toBe('api.github.com')                      // 链上走的是备用端点
        expect(row.answeredByEndpoint).toBe('raw.githubusercontent.com')         // 真正回字节的是 302 之后的 origin —— 不谎报
        expect(readings(stub).raw).toBe(POLICY_FETCH_ATTEMPTS + 1)               // 主端点 3 次失败 + 302 后一跳
        // P18 的作用域纪律在跳转下同样成立：PAT 只离开过 api.github.com 一次，且**不跟着 302 走**
        expect(stub.calls.find(isContents)!.headers.authorization).toBe(`Bearer ${TOKEN}`)
        expect(stub.calls.filter(isRaw).at(-1)!.headers.authorization).toBeUndefined()
      } finally { stub.restore() }
    })
  })

  test('链长为 1 的来源（非 github）：行为不变，记账仍如实说"由它自己那个端点提供"', async () => {
    const payloadText = new TextEncoder().encode('weights')
    const sha = createHash('sha256').update(payloadText).digest('hex')
    const stub = stubFetch(() => new Response(payloadText, { status: 200 }))
    try {
      const transfer = await downloadFile(
        { path: 'params/x.bin', bytes: payloadText.byteLength, revision: 'r', sha256: sha, url: 'https://upstream.invalid/x.bin' },
        join(emptyDir(), 'x.bin'), new AbortController().signal, false,
      )
      expect(stub.calls.length).toBe(1)                       // 一次请求：没有第二跳可试
      expect(transfer.servedByEndpoint).toBe('upstream.invalid')
      expect(transfer.endpointsTried).toEqual(['upstream.invalid'])
      expect(transfer.fallbackUsed).toBe(false)
    } finally { stub.restore() }
  })
})
