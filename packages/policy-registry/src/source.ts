import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
// 第 3 级（`mirror-search.ts`）的归档记忆化接线：`policyArchiveCache()` / `fetchPolicyFileViaArchive()`。
import { fetchFromMirrors, identityStrength, knownMirrorCandidates, MirrorArchiveCache, type DeclaredIdentity, type MirrorArchiveCacheStats, type MirrorArchiveOptions, type MirrorCoordinates, type MirrorFetchReading } from './mirror-search.ts'

/**
 * **就地负对照哨兵**（`docs/VERIFICATION_MECHANISMS.md` 机制 12 的同族；`script/release-gate.ts:195` 是既有先例）。
 *
 * 为什么 `source.ts` 需要它的对应物：在**共享产品文件**上就地做负对照（把某条修复临时切掉再取读数）
 * 等于**在读数面上投毒** —— 这一窗口里任何人跑用例／门／tsc，拿到的都可能是负对照态读数，而读数里
 * 没有任何字段提示它。`source.ts` 正是本轮被就地翻转最多的那个文件（`bugfixHistory/
 * SOURCE-TYPE-ERROR-AND-TSC-BLINDNESS-20260926.md` §3.2 记着 01:24:44–01:33:50 之间"切/补"≥4 次，
 * 其中一次还把另一个 lane 的 96 秒用例读数整段染成负对照态）。
 *
 * 用法：**就地**做负对照 ⇒ 把它设成一句话（如 `'F3-consumption-cut（负对照：故意切掉耗尽出口）'`），
 * 跑完**立刻设回 `null`**。取值会进 `policy-source-stall-cap.test.ts` 的读数与失败报文（`negctl=`），
 * 复核的人不必问"这份读数是不是负对照态的"。
 * **交付态必须是 `null`**：同一条用例的静态不变式专门拦"哨兵忘了撤"。
 */
export const NEGATIVE_CONTROL: string | null = null

export type PolicySource = 'modelscope' | 'github' | 'huggingface' | 'packs'
export interface SourceFile {
  path: string; bytes: number; revision: string; sha256?: string; gitBlob?: string
  /** 主端点的地址（github 分支＝`raw.githubusercontent.com`；其余来源＝它们自己的端点）。 */
  url: string
  /**
   * **备用端点**的地址（裁决 a／2026-09-26 的端点回退链）：github 分支＝内容接口
   * `api.github.com/repos/{owner}/{repo}/contents/{path}?ref={sha}`（取字节必须带
   * `Accept: application/vnd.github.raw`，否则拿回的是 base64 包在 JSON 里）。
   * **只有 github 分支填它** —— 其余来源的链长为 1，行为与"只有一个端点"时逐字一致（见 `sourceEndpoints`）。
   */
  fallbackUrl?: string
}
export interface PolicyManifest {
  status: 'DOWNLOADING' | 'DOWNLOADED' | 'CANCELLED' | 'FAILED'
  provider: PolicySource; modelId: string; revision: string; resolvedRevision: string
  metadata: Record<string, any>; sourceFiles: SourceFile[]
  files: Array<SourceFile & { sha256: string }>
  transfers: Array<Record<string, unknown>>
  execution: { status: 'BLOCKED'; reason: string }
  error?: string; updatedAt: string
}
export const asObject = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
export const checkCancelled = (signal: AbortSignal) => { if (signal.aborted) throw signal.reason ?? new Error('POLICY_CANCELLED') }
export const policyId = (value: unknown) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error('INVALID_POLICY_MODEL_ID')
  return value
}
export const policyRevision = (value: unknown) => {
  const revision = value === undefined ? 'master' : String(value)
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(revision)) throw new Error('INVALID_POLICY_REVISION')
  return revision
}
export const policyFile = (value: unknown) => {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..') || value.includes('\\')) throw new Error('INVALID_POLICY_FILE')
  return value
}
export const policySource = (value?: unknown): PolicySource => {
  if (value === undefined || value === 'modelscope') return 'modelscope'
  if (value === 'github') return 'github'
  if (value === 'huggingface') return 'huggingface'
  if (value === 'packs') return 'packs'
  throw new Error('POLICY_SOURCE_UNSUPPORTED')
}
export const policyDirectory = (root: string, provider: PolicySource, id: string, revision: string) => join(resolve(root), 'policies', ...(provider === 'modelscope' ? [] : [provider]), policyId(id).replace('/', '__'), policyRevision(revision)) // 'packs' 源沿用同族布局：provider 目录段 = 'packs'
const headers = { 'user-agent': 'LyapunovDSH-policy/0.1' }
/**
 * 官方 Hub 的 host（含子域）：**任何**以它为目的地的请求都是破约——配置成它、或被重定向到它，
 * 都拒绝（不静默回退官方端点）。镜像自己的签名 CDN 是另一回事（另一个域、URL 自带签名），照旧可跟随，
 * 只是不带我们的凭据。判定只看 host 后缀，不看路径。
 */
const OFFICIAL_HF_HOST = 'huggingface.co'
const isOfficialHuggingface = (hostname: string) => hostname === OFFICIAL_HF_HOST || hostname.endsWith('.' + OFFICIAL_HF_HOST)
/** HF 入口：默认 hf-mirror（与大件下载纪律一致），可用 HF_ENDPOINT 覆盖；与 ModelScope endpoint 分开，互不串用。 */
export const huggingfaceEndpoint = (configured?: string) => {
  const value = (configured ?? process.env.HF_ENDPOINT ?? 'https://hf-mirror.com').replace(/\/$/, ''), url = new URL(value)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('POLICY_ENDPOINT_MUST_BE_HTTPS')
  if (isOfficialHuggingface(url.hostname)) throw new Error('POLICY_HF_ENDPOINT_FORBIDDEN')
  return value
}
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')
/**
 * 本机 HF 凭据：优先**显式**环境变量 `HF_TOKEN`，其次本机标准 HF 登录缓存（`HF_TOKEN_PATH`，或
 * `$HF_HOME/token`，默认 `~/.cache/huggingface/token`）。读不到就是**没有凭据**（null）——不匿名拼假身份、
 * 不回落官方端点、不换源。返回值只进请求头：绝不写进 URL、日志、manifest、回执或发现面。
 */
export async function huggingfaceToken(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const explicit = env.HF_TOKEN?.trim()
  if (explicit) return explicit
  const cache = env.HF_HOME?.trim() || join(homedir(), '.cache', 'huggingface')
  for (const path of [env.HF_TOKEN_PATH?.trim(), join(cache, 'token')]) {
    if (!path) continue
    try { const token = (await readFile(path, 'utf8')).trim(); if (token) return token } catch {}
  }
  return null
}
/**
 * 凭据的**作用域**：只发给配置的 HF 端点（镜像）自己的 origin。镜像把大件交给它自己的签名 CDN 是另一个
 * origin，跳过去时**不转送** Bearer——中转 URL 已自带签名，令牌不该离开本仓配置的那一处。
 */
const huggingfaceHeaders = async (url: string): Promise<Record<string, string>> => {
  if (new URL(url).origin !== new URL(huggingfaceEndpoint()).origin) return {}
  const token = await huggingfaceToken()
  return token ? { authorization: `Bearer ${token}` } : {}
}
/** HF 端点的 401/403 分清「本机没有凭据」与「凭据被拒」（不回显上游原文）；其余状态码保持原有前缀，不换源。 */
const huggingfaceStatusError = (prefix: string, status: number, credential: boolean) =>
  status === 401 || status === 403 ? (credential ? 'POLICY_HF_AUTH_REJECTED' : 'POLICY_HF_AUTH_REQUIRED') : `${prefix}_${status}`
/**
 * GitHub 凭据入口（W26／2026-09-26）—— 与 W16 `LYAPUNOV_MAMBA_LICENSE` **同一形状**：显式 env 覆盖、命中即用、
 * 读不到就是没有（null），不匿名拼假身份、不换源、不新增配置文件格式。
 *
 * 为什么要有：`sourceSnapshot` 的 github 分支是取件链上**唯一隐式依赖匿名配额**的一段 —— 一次取件固定打
 * 3 个 `api.github.com` 请求（commit／repo／tree），而这条链此前只带 `user-agent`。匿名 core 配额是
 * **60 次/小时、按出口 IP 计**（P13 实测 `api.github.com/rate_limit`：limit 60／used 60／remaining 0），
 * 于是"重试"的真实代价是烧掉下一次取件的机会：配额打满后连元数据都进不去，症状是裸 `POLICY_REMOTE_403`
 * （非瞬时 ⇒ 不重试），用户既不知道自己被限流、也不知道可以带 token。
 *
 * 取值顺序（值本身只进请求头：绝不写进 URL、日志、manifest、回执或发现面；报错只报**变量名**）：
 *   1. `LYAPUNOV_GITHUB_TOKEN`（产品命名空间的显式覆盖）；
 *   2. `GITHUB_TOKEN` / `GH_TOKEN`（**沿用本仓既有命名**：`lyapunov-product-bundle/src/github.ts:62` 已认这两个名，
 *      CI 里 GitHub Actions 也自动注入 `GITHUB_TOKEN`）。命中哪个名报哪个名，便于定位"到底带了哪份凭据"。
 */
export const GITHUB_TOKEN_ENV = 'LYAPUNOV_GITHUB_TOKEN'
export const GITHUB_TOKEN_COMPAT = ['GITHUB_TOKEN', 'GH_TOKEN'] as const
/** 凭据与限流判定的目标 host：**只有** GitHub REST API 本身。 */
export const GITHUB_API_HOST = 'api.github.com'
/** GitHub REST API 的 origin（元数据请求与**备用内容端点**共用同一个 origin）。 */
export const GITHUB_API_ORIGIN = 'https://api.github.com'
/**
 * 内容字节的**主端点** host —— `sourceSnapshot` 的 github 分支此前把它**硬编**在这里、且没有备用
 * （裁决 a 要修的就是这一点：`raw.githubusercontent.com` 对默认客户端不通时整条取件链没有第二个落点）。
 */
export const GITHUB_RAW_HOST = 'raw.githubusercontent.com'
/** 内容接口的媒体类型：要的是**原文**，不是"内容 base64 包在 JSON 里"的另一种语义。 */
export const GITHUB_RAW_MEDIA_TYPE = 'application/vnd.github.raw'
/** 匿名 core 配额（上游口径）。写进报错是为了让"60/h"这件事在会话结束后仍可见。 */
export const GITHUB_ANONYMOUS_CORE_LIMIT = 60
/** 一条 github 取件固定消耗的 API 请求数（commit／repo／tree）——重试不免费，这个数字必须可见。 */
export const GITHUB_SNAPSHOT_REQUESTS = 3
/**
 * **检索链**（`policy_search` 的 github 分支，落在 `plugin.ts`）唯一打的那个端点路径。
 *
 * 为什么它要是个具名常量：限流正文里那句"本次成本"必须**指名本路径真正打的那个端点** ——
 * 取件链打 commit／repo／tree（3 个请求），检索链只打这一个（1 个请求）。
 * F2（2026-09-27）：那句话原先**写死了取件链**的成本口径，却是两条链**共用**的正文 ⇒
 * 它在检索链上原样发出，**点名了那条路上根本不存在的三个请求**。
 */
export const GITHUB_SEARCH_PATH = '/search/repositories'
export interface GithubCredential { name: string; token: string }
/** 命中的凭据连同**它来自哪个变量名**（报错只报名，绝不回显值）。 */
export function githubCredential(env: NodeJS.ProcessEnv = process.env): GithubCredential | null {
  for (const name of [GITHUB_TOKEN_ENV, ...GITHUB_TOKEN_COMPAT]) {
    const token = env[name]?.trim()
    if (token) return { name, token }
  }
  return null
}
export const githubToken = (env: NodeJS.ProcessEnv = process.env): string | null => githubCredential(env)?.token ?? null
/**
 * 凭据**作用域**：只发给 `api.github.com`。公开内容字节走 `raw.githubusercontent.com` —— 那条路不需要凭据，
 * 把 PAT 送去另一个 origin 是白送暴露面。与 HF 侧 `huggingfaceHeaders`（只发配置端点自己的 origin）同一条纪律。
 */
export const githubHeaders = (url: string): Record<string, string> => {
  if (new URL(url).hostname !== GITHUB_API_HOST) return {}
  const credential = githubCredential()
  return credential ? { authorization: `Bearer ${credential.token}` } : {}
}
/** 限流读数：只用上游给的响应头事实，不猜。 */
export interface GithubRateLimitReading {
  resource: string | null; limit: number | null; remaining: number | null; used: number | null
  resetAt: string | null; resetInSeconds: number | null; retryAfterSeconds: number | null
}
const numericHeader = (headers: Headers, name: string): number | null => {
  const raw = headers.get(name)
  if (raw === null || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}
export function githubRateLimitReading(headers: Headers, now = Date.now()): GithubRateLimitReading {
  const reset = numericHeader(headers, 'x-ratelimit-reset')
  return {
    resource: headers.get('x-ratelimit-resource'),
    limit: numericHeader(headers, 'x-ratelimit-limit'),
    remaining: numericHeader(headers, 'x-ratelimit-remaining'),
    used: numericHeader(headers, 'x-ratelimit-used'),
    resetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
    resetInSeconds: reset === null ? null : Math.max(0, reset - Math.floor(now / 1000)),
    retryAfterSeconds: numericHeader(headers, 'retry-after'),
  }
}
/**
 * 限流判定：403 且（剩余为 0 **或** 带 `retry-after`＝次级限流）⇒ 是限流；429 也是。
 * 其余 403 **不是**限流（私有仓／组织 SSO／被组织或 IP 允许列表限制／仓库不存在／凭据作用域不足）。
 */
export const githubRateLimited = (status: number, headers: Headers): boolean =>
  status === 429 || (status === 403 && (numericHeader(headers, 'x-ratelimit-remaining') === 0 || headers.has('retry-after')))
/** 响应头里的限流证据：`x-ratelimit-*`（core 配额）或 `retry-after`（次级限流）。只看上游给的事实。 */
const hasRateLimitEvidence = (headers: Headers): boolean =>
  [...headers.keys()].some(name => name.startsWith('x-ratelimit-') || name === 'retry-after')
/**
 * **覆盖重试判定**的判定（W26-R1 立；W26-R2 按 Lead `docs/REMAINING_WORK_PLAN.md` §7.16 裁定**修订**）：
 * host 是 `api.github.com` 且按 `githubRateLimited` 判为限流 ⇒ 这个应答在取件链上**不是瞬时故障**：
 * 重试只会把同一份配额再烧一遍。
 *
 * **Lead 2026-09-27 明确修订 R-fix#3 §2.1**（原文："重试覆盖**额外要求**限流证据在场"）——
 * 修订后：**不再要求证据在场**。裁定理由（逐字）：无证据时确实分不清"被剥头的限流"与"其它 429"，
 * **但那不影响"该不该重试"** —— 429 在语义上就是"你被限流了"，**而且报文必须与传输行为一致**
 * （旧口径下报文说"不重试"、传输层却重试 3 次 ⇒ **报文在说谎**）。附带收益：匿名 60/h 的配额不再被烧 3 倍。
 *
 * 为什么不是直接 `githubRateLimited`：**host 守卫才是保护别的 provider 的那一件**。
 *   - 429 一律覆盖（含无头；`x-ratelimit-*` 被中间代理剥掉是已知成因）；
 *   - 反过来，GitHub 的**权限 403 也顺带带 `x-ratelimit-*` 头**（如 remaining=42），`githubRateLimited` 为假
 *     ⇒ 这里不覆盖（它本来也不在 `TRANSIENT_STATUS` 里，重试语义与报文分类都不受影响）。
 * 于是覆盖条件 = host ∧ 限流；**非 github host ⇒ 既有的 `TRANSIENT_STATUS` 一个字不改**。
 * `hasRateLimitEvidence` **不是死代码**：它继续决定报文给"重置于 …"还是给"重置指引"（见 `githubRateLimitDiagnosis`）。
 */
export const githubRateLimitNoRetry = (status: number, headers: Headers, url: string): boolean =>
  new URL(url).hostname === GITHUB_API_HOST && githubRateLimited(status, headers)
/** `boundedFetch` 的 `retryOverride` 形状（见下）：只给 github 分支接线，其它 provider 不传。 */
export const githubStatusRetryOverride: StatusRetryOverride = (response, url) =>
  githubRateLimitNoRetry(response.status, response.headers, url)
/**
 * 按 **host** 收窄的覆盖入口（端点回退链复用 R-fix#3 的判定，2026-09-26）：只有打到 `api.github.com`
 * 的那一跳才带上 `githubStatusRetryOverride`，其余 host 一律返回 `undefined`（＝**不传** ⇒ 既有语义一个字不改）。
 *
 * 为什么要有：逐件下载那一跳现在可能是**两个**端点（raw 优先 → 内容接口回退），而内容接口的 429 是限流 ——
 * 不覆盖就会退回"重试 3 次＝再烧 3 倍配额 + 报可否重试：true"，正是 R-fix#3 刚修好的那个口子。
 */
export const githubRetryOverride = (url: string): StatusRetryOverride | undefined =>
  new URL(url).hostname === GITHUB_API_HOST ? githubStatusRetryOverride : undefined
const githubWait = (seconds: number | null): string => seconds === null ? '未知' : seconds >= 120 ? `约 ${Math.round(seconds / 60)} 分钟后` : `约 ${seconds} 秒后`
/**
 * 「本机凭据」一行的**匿名**口径 —— 按 `retryLayer` 分岔（F5／2026-09-27）。
 *
 * 与上一单（限流正文 F1/F2）**同族**：`githubStatusError` 的 **401** 与**权限 403** 两条正文里的 `who`
 * 与限流正文**共用**同一句，于是这两条在检索链上也会说「未设置（匿名 ⇒ core 仅 60 次/小时…）」——
 * **core 是取件链吃的那个桶**；检索端点（`/search/*`）自己有单独一份、与 core 分开计
 * ⇒ 报文**指向那条路径上不存在的东西**：用户照它去"省 core 配额"，省的是**另一条链**的桶。
 *
 * 两种检索链措辞（都**不复述 core 的读数**）：
 *   - `referencesReading: true`（限流正文用）：上面确实有 `配额读数：resource=…` 那一行 ⇒ 可以说"上面那一份"；
 *   - `referencesReading: false`（401／权限 403 正文用）：那两条正文**没有** `配额读数` 行 ⇒ 沿用"上面 resource="
 *     会变成**指向不存在的一行**（§7.16 措辞问题 ② 那一族）⇒ 只点明桶的归属，不指路。
 *
 * `'fetch'` 分支与分岔前**逐字节相同**（两种引用形态共用同一句 ⇒ 取件链一个字节都不变）。
 */
const anonymousCredentialWho = (retryLayer: 'fetch' | 'search', referencesReading: boolean): string =>
  retryLayer !== 'search'
    ? `未设置（匿名 ⇒ core 仅 ${GITHUB_ANONYMOUS_CORE_LIMIT} 次/小时，且按**出口 IP** 计：同机／同出口的所有会话共用这一份）`
    : referencesReading
      ? `未设置（匿名 ⇒ 被拒的是上面 resource= 那**一份**配额 —— 检索端点**自己有单独一份、不是 core**，且按**出口 IP** 计：同机／同出口的所有会话共用这一份）`
      : `未设置（匿名 ⇒ 这条链吃的是**检索端点自己那一份**配额 —— **不是 core**，且按**出口 IP** 计：同机／同出口的所有会话共用这一份）`
/** `本机凭据` 那一行：凭据在就只报它的来源（值不回显），**匿名才谈桶**（桶按层分岔，见上）。 */
const credentialWho = (credential: GithubCredential | null, retryLayer: 'fetch' | 'search', referencesReading: boolean): string =>
  credential ? `已设置（来自 ${credential.name}，值不回显）` : anonymousCredentialWho(retryLayer, referencesReading)
/**
 * **限流报文正文**（W26-R2／2026-09-26）：应答**当场**被判为限流（`githubStatusError`）与应答把尝试次数
 * **用尽之后**才被判为限流（`boundedFetch` 的 `classifyExhausted`）**共用同一段文字** ——
 * 两条投递路径不可能一条说"限流"、另一条说"瞬时故障"。
 *
 * 口径按"证据在不在"分岔（**只影响措辞，不影响重试判定**）：
 *   - 证据在：说"配额已用尽"，并给出上游给的 `重置于 …` 时刻；
 *   - 证据不在：**不给时刻**（本机算不出来），改给**重置指引**（去哪儿查）并点名"代理剥头"这个已知成因。
 *
 * `retryLayer` 让同一句话在两条链上各自为真（"重试判定"**三态**，不许混用一句话）：
 *   - `'fetch'`（取件链）+ 覆盖生效（**变体 A 落地后 429 一律覆盖**）⇒ 不重试（1 次）；
 *   - `'fetch'`（取件链）+ 覆盖未生效但尝试已耗尽 ⇒ 如实报"已试了几次"（见 `boundedFetch` 的耗尽出口）。
 *     ⚠️ **变体 A 下这一态在本产品路径上不可达**：覆盖条件现在是 host ∧ 限流，而耗尽出口只对
 *     `TRANSIENT_STATUS` 里的状态触发 —— 429 已被覆盖带走，其余（408/425/5xx）`githubRateLimited`
 *     为假 ⇒ 分类器返回 `null`。这一态是**有意保留的接缝**（口径若再变，两条投递路径仍同源），
 *     已在回执里如实登记为"无触发路径"。
 *   - `'search'`（检索链 `policy_search`）⇒ **本来就没有重试层**，不许让读者读成"覆盖生效"。
 *
 * **凡是"只有某一条链上才有"的事实都按 `retryLayer` 分岔**（F1/F2，2026-09-27）—— 一共三处：
 * `本机凭据` 的配额桶（core vs 检索端点自己那份）、`本次成本`（3 个 commit／repo／tree vs 1 个
 * `search/repositories`）、`处置建议`（core 5000/h vs 该端点自己那份）。判据：**同一句报文不许在两条
 * 路径上给出对方的事实**；取件链的每一个字在本次改动前后**逐字节相同**（负对照有读数）。
 * ⚠️ 上面那句"**只**覆盖限流这一条正文"在 **F5（2026-09-27）** 之后**已过期**：`githubStatusError`
 * 的 **401** 与**权限 403** 两条正文里的 `本机凭据` 现在也走同一个按层分岔入口（`credentialWho(..., false)`），
 * 检索链上不再出现 `core` 的读数。三条正文的分岔现在**同源**（同一个 `anonymousCredentialWho`）。
 */
export const githubRateLimitDiagnosis = (status: number, headers: Headers, url: string, credential: GithubCredential | null, now = Date.now(), retryLayer: 'fetch' | 'search' = 'fetch', exhaustedAttempts: number | null = null): string => {
  const rate = githubRateLimitReading(headers, now)
  const evidenced = hasRateLimitEvidence(headers)
  // F1/F2（2026-09-27）：从这一行起，**凡是指向"某一条链上才有的东西"的句子都按 `retryLayer` 分岔**。
  // 判据（Lead 裁定）：**同一句报文不许在两条路径上给出对方的事实**。
  //   · 取件链：一条 sourceSnapshot = commit／repo／tree 最多 3 个请求；被拒的是 **core** 配额。
  //   · 检索链：一条 policy_search = 1 个 `search/repositories` 请求、**没有重试层**；
  //     被拒的是**检索端点自己那一份**配额（不是 core），且这条路**从不请求** commit／repo／tree。
  const search = retryLayer === 'search'
  // F5（2026-09-27）：`who` 也走共用的按层分岔入口；这一条正文上面**有** `配额读数：resource=…`
  // ⇒ `referencesReading=true`（检索链可以说"上面那一份"）。取件链分支逐字节不变。
  const who = credentialWho(credential, retryLayer, true)
  const reading = [
    `resource=${rate.resource ?? '未知'}，limit=${rate.limit ?? '未知'}，used=${rate.used ?? '未知'}，remaining=${rate.remaining ?? '未知'}`,
    ...(rate.resetAt ? [`重置于 ${rate.resetAt}（${githubWait(rate.resetInSeconds)}）`] : []),
    ...(rate.retryAfterSeconds === null ? [] : [`retry-after=${rate.retryAfterSeconds}s（次级限流）`]),
  ].join('，')
  // "重试判定"**三态**：①覆盖生效 ②覆盖未生效但尝试已耗尽（变体 A 下不可达，见函数 doc）③本路径没有重试层。
  // 三句各自为真，不许混用。
  const retryLine = retryLayer === 'search'
    ? [`  重试判定：本路径（检索链 policy_search）**一次即失败** —— 它本来就没有重试层；这句话是如实说明，**不代表"限流覆盖"生效**`]
    : githubRateLimitNoRetry(status, headers, url)
      ? [`  重试判定：不重试 —— 限流不是瞬时故障，立刻重试只会再烧配额（等重置时刻或换一份凭据才有意义）`]
      : exhaustedAttempts === null
        ? []
        : [`  重试判定：不重试 —— 本次已按既有瞬时语义**先试了 ${exhaustedAttempts} 次**（本应答没有限流证据 ⇒ 限流覆盖未生效）；**不要再重跑同一条命令**：限流不是瞬时故障，在重置前重跑只会继续消耗同一份配额`]
  return [
    evidenced
      ? `POLICY_GITHUB_RATE_LIMITED: GitHub API 配额（限流）已用尽 —— 不是仓库不存在、也不是网络故障（HTTP ${status}）`
      : `POLICY_GITHUB_RATE_LIMITED: GitHub 按**限流**拒绝了这个请求（HTTP ${status}）—— 不是仓库不存在、也不是网络故障；响应里**没有任何** x-ratelimit-*／retry-after 可读，所以具体读数未知`,
    `  上游 URL：${url}`,
    `  配额读数：${reading}`,
    // 措辞级修正 ①：无证据时"等上面那个重置时刻"指向一个不存在的行 ⇒ 改成真正的**重置指引**。
    ...(evidenced ? [] : [`  重置指引：上游没给重置时刻 ⇒ 本机算不出来（**中间代理剥掉 x-ratelimit-\\* 是已知成因**）。当前窗口的重置时刻可访问 ${GITHUB_API_ORIGIN}/rate_limit 查（或 \`gh api rate_limit\`）。`]),
    `  本机凭据：${who}`,
    // 措辞级修正 ②：「固定打 3 个请求」在 commit 就先撞墙时是**假的**（那次只花 1 个）⇒ 改成上界 + 实际口径。
    // 措辞级修正 ③（F2，2026-09-27）：②修好的那句**仍然写死了取件链**（3 个请求、commit／repo／tree、
    // `sourceSnapshot`），而这段正文是**两条链共用**的 ⇒ 它在检索链上原样发出，点名了那条路上**不存在**的
    // 三个请求（检索链只打 1 个 `search/repositories`，实测 REQUESTS=1）。与 §7.16 已登记的措辞问题 ②
    // （"等到**上面那个**重置时刻"而上面根本没有那一行）**同一族**：**报文指向那条路径上不存在的东西**。
    // ⇒ 成本句按 `retryLayer` 分岔；两条链各自只说自己那条路上真有的东西。
    search
      ? `  本次成本：一条 policy_search（provider:"github"）**只打 1 个** api.github.com 请求 —— ${GITHUB_SEARCH_PATH}?…；这条链**没有重试层**，一次即失败，所以本次就花这一个。它**不是** sourceSnapshot：**不请求** commit／repo／tree（那是取件链的成本口径）`
      : `  本次成本：一条 sourceSnapshot **最多**打 ${GITHUB_SNAPSHOT_REQUESTS} 个 api.github.com 请求（commit／repo／tree）——**撞在第几个就只花到那一个**（第 1 个 commit 就被拒 ⇒ 本次只花 1 个）；重试会继续消耗同一配额，配额打满后连元数据都进不去`,
    ...retryLine,
    // 处置建议同样按层分岔：取件链的解法是 **core** 配额（PAT 5000 次/小时）；检索链被拒的是它**自己那一份**
    // 配额，把"core 5000/h"当解法是**另一条链的事实**（同一个缺陷族的第三处）。
    credential
      ? evidenced
        ? `  处置建议：这个凭据自己的配额也用尽了${search ? '' : '（PAT 通常 5000 次/小时）'}。换一份配额未用尽的凭据，或等到上面那个重置时刻再试。`
        : `  处置建议：若这确实是配额限流${search ? '' : '（PAT 通常 5000 次/小时）'}⇒ 换一份配额未用尽的凭据；上游没给重置时刻，按上面的重置指引先查出来再等。`
      : search
        ? `  处置建议：把 GitHub PAT 放进 ${GITHUB_TOKEN_ENV}（兼容 ${GITHUB_TOKEN_COMPAT.join('／')}）⇒ 这条路按**凭据口径**另计一份（**不是 core**，就是上面 resource= 那一份）；${evidenced ? '或等到上面那个重置时刻再试。' : '否则按上面的重置指引先查出重置时刻再等 —— 在重置前重跑只会继续消耗同一份配额。'}`
        : `  处置建议：把 GitHub PAT 放进 ${GITHUB_TOKEN_ENV}（兼容 ${GITHUB_TOKEN_COMPAT.join('／')}）⇒ core 5000 次/小时；${evidenced ? '或等到上面那个重置时刻再试。' : '否则按上面的重置指引先查出重置时刻再等 —— 在重置前重跑只会继续消耗同一份配额。'}`,
  ].join('\n')
}
/**
 * GitHub 的状态类错误：**把两类 403 分开**（配额限流 vs 仓库/权限），因为它们在报文里长得一模一样，
 * 处置却完全相反（等重置 vs 修权限/换坐标）。码的形状沿用仓库既有约定：401 ⇒ `POLICY_GITHUB_AUTH_*`
 * （对照 HF 侧 `POLICY_HF_AUTH_*`）；配额 403/429 ⇒ `POLICY_GITHUB_RATE_LIMITED`；**其余 403 保持既有
 * `POLICY_REMOTE_403` 码逐字不变**（不悄悄改掉已有读数）；非 401/403/429 也保持 `POLICY_REMOTE_<status>`。
 *
 * **`retryLayer` 也管这两条正文**（F5，2026-09-27）：401 与"权限 403"里的 `本机凭据` 曾与限流正文
 * 共用一份 `who`（含 `core 仅 60 次/小时`）⇒ 在检索链上**点名了另一条链的配额桶**。
 * 现在三条正文共用 `credentialWho`，按层分岔；取件链的每一个字**逐字节不变**。
 */
export function githubStatusError(status: number, headers: Headers, url: string, credential: GithubCredential | null, now = Date.now(), retryLayer: 'fetch' | 'search' = 'fetch'): Error {
  // F5（2026-09-27）：这两条正文（401／权限 403）**与限流正文共用过 `who`** —— 于是检索链上也会说
  // 「匿名 ⇒ core 仅 60 次/小时」，而 core 是**取件链**的桶。按同一判据分岔：
  // **同一句报文不许在两条路径上给出对方的事实**。这两条正文**没有** `配额读数` 行
  // ⇒ `referencesReading=false`，检索链只点明桶的归属、不去指一行不存在的读数。
  const who = credentialWho(credential, retryLayer, false)
  if (status === 401) return new Error([
    `${credential ? 'POLICY_GITHUB_AUTH_REJECTED' : 'POLICY_GITHUB_AUTH_REQUIRED'}: GitHub 拒绝了本次请求的凭据（HTTP 401）`,
    `  上游 URL：${url}`,
    `  本机凭据：${who}`,
    credential
      ? `  处置建议：${credential.name} 里的这个 PAT 被拒（过期／被撤销／拼写错误／作用域不含公开仓读取）。修正或清空它后重试。`
      : `  处置建议：把 GitHub PAT 放进 ${GITHUB_TOKEN_ENV}（兼容 ${GITHUB_TOKEN_COMPAT.join('／')}）后重试。`,
  ].join('\n'))
  if (status === 403 || status === 429) {
    // W26-R2：限流报文的正文与"尝试耗尽后再分类"那条路径**共用** `githubRateLimitDiagnosis` ⇒ 两条路径不会分叉。
    if (githubRateLimited(status, headers)) return new Error(githubRateLimitDiagnosis(status, headers, url, credential, now, retryLayer))
    return new Error([
      `POLICY_REMOTE_403: GitHub 拒绝了这个请求（HTTP 403，且响应里没有限流证据 ⇒ 按**仓库/权限**问题处理，不是配额）`,
      `  上游 URL：${url}`,
      `  本机凭据：${who}`,
      `  处置建议：私有仓／组织 SSO 未授权／被组织或 IP 允许列表限制／仓库改名或不存在／凭据作用域不足都会长这样。带上凭据仍 403 ⇒ 就是权限问题，**等配额重置没有用**。`,
      `  若你确信这是限流：响应头可能被中间代理剥掉了 x-ratelimit-*，报文因此无法据此分类。`,
    ].join('\n'))
  }
  return new Error(`POLICY_REMOTE_${status}`)
}
/**
 * **检索链**（`policy_search` 的 github 分支）的状态分类入口（F1，2026-09-27）。
 *
 * 为什么要这个**具名**入口，而不是在调用点写 `githubStatusError(..., Date.now(), 'search')`：
 * `retryLayer` 是**默认参数**，默认值恰好是取件链的 `'fetch'` —— 调用点漏传时**不报错、不提示、
 * 不换类型**，静默拿到取件链的措辞。F1 就是这么发生的：`plugin.ts:54` 漏传 ⇒ 检索链的 429 报文
 * 一直带着「立刻重试只会再烧配额」（那条路**根本没有重试层**）与取件链的成本口径（§F2）。
 * ⇒ 把这一层**写进函数名**：检索链只从这一个入口走，"漏接线"在调用点一眼可见。
 */
export const githubSearchStatusError = (status: number, headers: Headers, url: string, credential: GithubCredential | null, now = Date.now()): Error =>
  githubStatusError(status, headers, url, credential, now, 'search')
/**
 * 取件链的**有界**联网口径（W25／2026-09-26）。
 *
 * 与 `script/package-linux.ts` 的 `fetchMambaLicense` **同一形状**：`AbortSignal.timeout(30_000)` × 3 次。
 * 为什么要有这一层：同一形状的两次静默在 W16（打包链取 micromamba LICENSE，裸 `fetch` 静默 5 分钟）
 * 与 W25（取件链 `downloadPolicy` → Go2 `TimeoutError` 300004ms、Go1 `socket connection was closed
 * unexpectedly` 1998ms）各出现一次。W16 只修了它自己那一处；这里把它**变成一类**：
 * 取件链上**所有**等待网络的地方（元数据解析、内容建连、逐件下载的字节流）都走这里，
 * 且失败必须带齐五要素（上游 URL / 来源坐标 / 走到哪一步 / 每次尝试的原因 / 可否重试）。
 */
export const POLICY_FETCH_TIMEOUT_MS = 30_000
export const POLICY_FETCH_ATTEMPTS = 3
/**
 * 逐件下载的**停摆上限**：**正文阶段连续这么久没有收到任何字节**才掐（`POLICY_DOWNLOAD_STALL`）。
 *
 * 口径（W25 的「整体耗时不限」勘误为）：**每次尝试含读正文 30s** —— 这 30s 是**停摆**上限，不是总时限：
 * 字节只要在到就一直收（十几 GB 权重正常要几分钟）；建连／应答头那 30s 是**另一个**上限
 * （`POLICY_FETCH_TIMEOUT_MS`），**到应答头即撤销**，不压在读正文上。
 *
 * 为什么必须把两个 30s 分开写：W25 把建连时创建的 `AbortSignal.timeout(30s)` 一直挂在 body 上
 * ⇒ body 阶段的停摆计时器**必然比它晚** ⇒ 读正文永远被总时限掐断，而注释却写「整体耗时不限」。
 * 真机读数（`bugfixHistory/POLICY-STALL-CAP-FIX-20260926.md`）：`.part` 已落 2352 B（**拿到了部分字节**）
 * 却报 `TimeoutError code=23`。
 */
export const POLICY_DOWNLOAD_STALL_MS = 30_000
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const TRANSIENT_CODE = /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN)$/

/** 失败时"走到哪一步"（错误五要素之一）。 */
export type PolicyFetchStep = '解析 source' | '建连' | '逐件下载' | '校验落盘'
export interface PolicyFetchAttempt {
  at: string; step: PolicyFetchStep; url: string; attempt: number; ms: number; reason: string; retryable: boolean
  /**
   * 这一跳打到**哪个端点**（host：`raw.githubusercontent.com` / `api.github.com` / HF 镜像…）。
   * 端点回退链下"哪一跳是哪个端点"必须一眼可见，否则"字节到底从哪来"说不清（裁决 a 的记录要求）。
   */
  endpoint?: string
}
export interface PolicyFetchTrace { attempts: PolicyFetchAttempt[]; context: { provider?: string; modelId?: string; revision?: string } }
export const newPolicyFetchTrace = (context: PolicyFetchTrace['context'] = {}): PolicyFetchTrace => ({ attempts: [], context })

const describeError = (error: unknown): string => {
  const name = (error as Error)?.name
  const code = (error as { code?: string })?.code
  const message = String((error as Error)?.message ?? error).replace(/\s+/g, ' ').trim()
  return [name && name !== 'Error' ? name : '', code ? `code=${code}` : '', message].filter(Boolean).join(' ').slice(0, 240)
}
/** 瞬时故障才重试：超时/连接被断/网络不可达/5xx/429。凭据、校验、越界这类**不重试**（重试只会重复失败）。 */
export function isTransientFetchFailure(error: unknown): boolean {
  // 端点回退链上的**状态类**诊断（限流/权限/不存在）也在这里一次说清：不是瞬时故障 ⇒ 不重试、不换端点。
  if (error instanceof PolicyFetchError || error instanceof PolicyEndpointStatusError) return false
  const name = (error as Error)?.name
  if (name === 'TimeoutError' || name === 'AbortError') return true
  const code = String((error as { code?: string })?.code ?? '')
  if (TRANSIENT_CODE.test(code)) return true
  return /(timeout|timed out|socket|closed unexpectedly|network|fetch failed|terminated|stall|停摆|ECONN|ETIMEDOUT|EPIPE|EAI_AGAIN|unreachable)/i.test(String((error as Error)?.message ?? error))
}

/**
 * 取件失败的可诊断错误：五要素**在一条消息里齐**，因为 `downloadPolicy` 的唯一失败出口是
 * `manifest.error = String(error)` —— 会话结束后人能看到的就这一行。
 */
export class PolicyFetchError extends Error {
  readonly url: string
  readonly step: PolicyFetchStep
  readonly attempts: readonly PolicyFetchAttempt[]
  readonly retryable: boolean
  constructor(input: { url: string; step: PolicyFetchStep; attempts: readonly PolicyFetchAttempt[]; retryable: boolean; context: PolicyFetchTrace['context']; diagnosis?: string | null }) {
    super(policyFetchErrorMessage(input))
    this.name = 'PolicyFetchError'
    this.url = input.url
    this.step = input.step
    this.attempts = input.attempts
    this.retryable = input.retryable
  }
}
const policyFetchErrorMessage = (input: { url: string; step: PolicyFetchStep; attempts: readonly PolicyFetchAttempt[]; retryable: boolean; context: PolicyFetchTrace['context']; diagnosis?: string | null }): string => [
  `POLICY_FETCH_FAILED: 取件失败于「${input.step}」步骤（${input.attempts.length}/${POLICY_FETCH_ATTEMPTS} 次尝试后放弃；可否重试=${input.retryable}）`,
  `  上游 URL：${input.url}`,
  `  来源坐标：${input.context.provider ?? '未提供'} ${input.context.modelId ?? '未提供'}@${input.context.revision ?? 'master'}`,
  // 每一跳点名**端点**（host）：端点回退链下"哪个端点失败了几次"是这条消息必须回答的问题。
  `  每次尝试：${input.attempts.length ? input.attempts.map((attempt, index) => `${'①②③④⑤⑥'[index] ?? `#${index + 1}`}${attempt.endpoint ? `${attempt.endpoint} ` : ''}${attempt.step} ${attempt.ms}ms：${attempt.reason}`).join('；') : '（无）'}`,
  // W26-R2：应答级诊断（如"这是限流 + 重置指引"）附在五要素之后 —— 五要素**一个字段都不少**。
  ...(input.diagnosis ? [`  ── 上游应答的诊断（与"当场判为限流"那条路径逐字同源）──`, ...input.diagnosis.split('\n').map(line => `  ${line}`)] : []),
  `  可否重试：${input.retryable ? 'true（瞬时网络故障：重试同一条命令即可，已落 .part 会续传）' : input.diagnosis ? 'false（不是瞬时故障：按上面的诊断处置，**别重跑同一条命令**）' : 'false（不是瞬时故障：先修正来源坐标/凭据/请求再试）'}`,
].join('\n')

/**
 * 端点回退链上的**状态类**失败（裁决 a／2026-09-26）：HTTP 应答本身给出的诊断 —— 限流（429／带限流证据的 403）、
 * 权限 403、401、404。它有两个"不许"，两个都来自已有裁决：
 *   1. **不许重试** —— 限流下重试＝把同一份配额再烧一遍（R-fix#3 的裁定；这里复用它的 `githubStatusError` 报文）；
 *   2. **不许换端点** —— 应答是**确定**的（这批字节/这个坐标就是这样），换端点只会再烧一份配额，
 *      还会把"来源里没有这个文件"说成另一回事（判据见 `endpointFallbackAllowed`）。
 * `isTransientFetchFailure` 对它返回 false ⇒ 外层 `downloadFile` 的重试循环**一个字不改**也不会重试它。
 * 报文＝状态分类器的原文（逐字保留，旧读数仍可 grep）＋ 一行**端点**：这批字节本该由哪个端点给。
 */
export class PolicyEndpointStatusError extends Error {
  readonly endpoint: string
  readonly url: string
  readonly status: number
  constructor(input: { endpoint: string; url: string; status: number; diagnosis: string; hop: string }) {
    super([input.diagnosis, `  端点：${input.endpoint}（回退链${input.hop}；上游 URL：${input.url}）`].join('\n'))
    this.name = 'PolicyEndpointStatusError'
    this.endpoint = input.endpoint
    this.url = input.url
    this.status = input.status
  }
}

/**
 * 重试判定的**上下文覆盖**（W26-R1／2026-09-26）。返回 `true` ⇒ 这个应答在本上下文里**不是**瞬时故障，
 * 不重试（把应答原样交给调用方的状态分类器去报错）；返回 `false`／未提供 ⇒ 完全按既有 `TRANSIENT_STATUS`。
 * 只有 github 取件链传它（`githubStatusRetryOverride`）——**其它 provider 的重试语义一个字不改**。
 *
 * 为什么需要这一层：429 在 `TRANSIENT_STATUS` 里（对一般上游是对的），但 GitHub 的 429 是**限流** ——
 * 重试 3 次等于把同一份配额再烧 3 倍，而最终报文还会说"可否重试：true"（在限流语境下是**错误建议**）。
 * 直接改 `TRANSIENT_STATUS` 会连 HF／ModelScope 的既有重试语义一起改掉 ⇒ 只在这条链上覆盖。
 */
export type StatusRetryOverride = (response: Response, url: string) => boolean
/**
 * **应答级失败分类**（W26-R2／2026-09-26）：一个应答在用尽 `boundedFetch` 的尝试次数之后，把**最后一个应答**
 * 交给调用方分类 —— 报文里的**诊断**与**可否重试**由调用方给；五要素（URL／坐标／步／每次尝试）仍由
 * `PolicyFetchError` 原样保留。`attempts` 是这条出口**实际试过**的次数（第三态"重试判定"要用它），
 * 因为"已试了 N 次"这句话只有这里知道。返回 `null`／未提供 ⇒ 与改前**逐字一致**。
 *
 * 为什么需要这一层：`retryOverride` 只管"**要不要**重试"（限流 ⇒ 1 次就返回应答）；覆盖**不生效**的应答
 * 会一路重试到耗尽再抛 `PolicyFetchError`，而那条出口**绕过了** `githubStatusError` ⇒ 已经算得出来的
 * 诊断送不到用户面前。
 *
 * ⚠️ **变体 A 落地后这条出口在本产品路径上不可达**：覆盖条件已是 host ∧ 限流（429 一律覆盖），
 * 而这里只对 `TRANSIENT_STATUS` 里的状态触发 ⇒ 剩下的 408/425/500/502/503/504 都 `githubRateLimited` 为假
 * ⇒ 分类器恒返回 `null`。它是**有意保留的接缝**（口径再变时两条投递路径仍同源），已如实登记为"无触发路径"。
 */
export type ExhaustedResponseClassifier = (response: Response, url: string, attempts: number) => { retryable: boolean; diagnosis: string } | null
/**
 * 「建连／应答头」上限的**可撤销**版本（`timeoutScope: 'connect'` 专用）。
 *
 * 为什么不用 `AbortSignal.timeout`：`AbortSignal.any` 合成的超时**撤不掉** —— 一旦合成，它就永远挂在
 * 这个 signal 上，而 body 正是绑着这个 signal 读的 ⇒ body 阶段的停摆计时器必然比它晚、永远输给它。
 * 手工计时器可以在**应答头到手时撤销**，两个 30s 从此各管各的（W25 的缺陷就是它们被算成了一个）。
 * `unref` 与 `AbortSignal.timeout` 同性质：计时器不参与"进程是否还有活"的判定。
 */
const newConnectDeadline = (ms: number) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return { signal: controller.signal, disarm: () => clearTimeout(timer) }
}
/**
 * 有界取件：每一次尝试各自 30s 上限（同时保留调用方的取消信号），瞬时故障重试至 3 次，
 * 非瞬时（4xx、校验类）立即失败；最终失败抛 `PolicyFetchError`（五要素齐）。
 * `timeoutMs/attempts` 只给单测用（生产调用点一律走默认 30s × 3，不引入新的配置体系）。
 * `retryOverride` 同样只由 github 分支传（见 `StatusRetryOverride`），默认不传 ⇒ 行为与改前逐字一致。
 *
 * `timeoutScope` 决定这 30s **管到哪里**（`bugfixHistory/POLICY-STALL-CAP-FIX-20260926.md`）：
 *   · `'attempt'`（默认；除逐件下载外的**全部**调用点）：从建连起一直管到 body 读完
 *     ⇒「每次尝试含读正文 30s」—— **与改前逐字相同**（仍是 `AbortSignal.timeout`，一行没动）。
 *   · `'connect'`（只有逐件下载那一跳传）：只管到**应答头**，到手即撤销；body 交给调用方自己的
 *     停摆上限（`downloadFileFromEndpoint` 的 `armStall`）。两个 30s 由此各管各的。
 */
export async function boundedFetch(url: string, init: Omit<RequestInit, 'signal'> & { signal?: AbortSignal }, options: { step: PolicyFetchStep; trace?: PolicyFetchTrace; timeoutMs?: number; attempts?: number; retryOverride?: StatusRetryOverride; classifyExhausted?: ExhaustedResponseClassifier; timeoutScope?: 'attempt' | 'connect' }): Promise<Response> {
  const { signal, ...rest } = init
  const timeoutMs = options.timeoutMs ?? POLICY_FETCH_TIMEOUT_MS
  const maxAttempts = options.attempts ?? POLICY_FETCH_ATTEMPTS
  const failures: PolicyFetchAttempt[] = []
  const record = (reason: string, retryable: boolean, attempt: number, ms: number) => {
    const entry: PolicyFetchAttempt = { at: new Date().toISOString(), step: options.step, url, endpoint: endpointHost(url), attempt, ms, reason, retryable }
    failures.push(entry); options.trace?.attempts.push(entry)
    return entry
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error('POLICY_CANCELLED')
    const started = Date.now()
    // 'connect' 作用域：可撤销的建连上限（应答头到手即撤销，见 `newConnectDeadline`）。
    const deadline = options.timeoutScope === 'connect' ? newConnectDeadline(timeoutMs) : undefined
    try {
      const composite = deadline
        ? (signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal)
        : (signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs))
      const response = await fetch(url, { ...rest, signal: composite })
      // 应答头到手即撤销建连上限（只有 'connect' 作用域有它；'attempt' 作用域故意保留 —— 那正是「含读正文」）。
      deadline?.disarm()
      if (TRANSIENT_STATUS.has(response.status)) {
        // 上下文覆盖：github 的限流应答**不重试**（重试＝继续烧同一份配额）⇒ 原样返回，
        // 交给调用方的状态分类器（`githubStatusError`：限流 + 重置时刻 + "立刻重试只会再烧配额"）。
        if (options.retryOverride?.(response, url)) return response
        record(`上游 HTTP ${response.status}`, true, attempt, Date.now() - started)
        if (attempt < maxAttempts) continue
        // W26-R2：覆盖不生效的应答在这里耗尽 —— 把**最后一个应答**交给调用方的分类器，
        // 诊断与"可否重试"由它给（github：限流 ⇒ 限流 + 重置指引 + 不要再重跑）。不传 ⇒ 与改前逐字一致。
        // ⚠️ F3（2026-09-27）：这三行是 W26-R2 已落地的接线，被并发的 lane-stall 在 00:48:16 的 922 行版里
        // **整段切掉**（`boundedFetch` 的 options 类型也一起去掉了 `classifyExhausted`），而 `getJSON`
        // 仍在传它 ⇒ 全仓 `tsc` 多出一条 `TS2353`（`source.ts:507`），**且已验收的"耗尽也要给诊断"这条出口
        // 被静默切断**（`ExhaustedResponseClassifier`、`getJSON` 的参数、`:524` 的构造全成了死代码，
        // 现有用例**一条都抓不到**）。这里**只恢复被切掉的接线**，不碰 lane-stall 的停摆上限改动。
        const classified = options.classifyExhausted?.(response, url, failures.length) ?? null
        throw new PolicyFetchError({ url, step: options.step, attempts: failures, retryable: classified?.retryable ?? true, context: options.trace?.context ?? {}, diagnosis: classified?.diagnosis ?? null })
      }
      return response
    } catch (error) {
      deadline?.disarm()
      if (error instanceof PolicyFetchError) throw error
      if (signal?.aborted) throw signal.reason ?? new Error('POLICY_CANCELLED')
      const retryable = isTransientFetchFailure(error)
      record(describeError(error), retryable, attempt, Date.now() - started)
      if (!retryable || attempt >= maxAttempts) throw new PolicyFetchError({ url, step: options.step, attempts: failures, retryable, context: options.trace?.context ?? {} })
    }
  }
  throw new PolicyFetchError({ url, step: options.step, attempts: failures, retryable: false, context: options.trace?.context ?? {} })
}

/**
 * 元数据 JSON：github 走 `githubHeaders`（凭据只发给 api.github.com），状态类错误交给调用方给的分类器
 * （github 用它把"配额限流"与"仓库/权限"分开；其余来源保持既有 `POLICY_REMOTE_<status>` 裸码不变）。
 * `retryOverride` 也只有 github 传：限流应答**不重试**（否则 3 次尝试＝3 倍配额）；不传 ⇒ 重试语义与改前逐字一致。
 *
 * ── 正文阶段超时的**错误形状**（【同形残留】2026-09-27）────────────────────────
 * `boundedFetch` 的 `try/catch` 只包住 `fetch()`（**建连／应答头**）那一步；它 `return` 的那个 `Response`
 * 的正文是在**外面**读的，而 `timeoutScope` 走默认 `'attempt'` ⇒ 那个 `AbortSignal.timeout(30s)`
 * **一直挂在 body 上**。于是 abort 落在读正文时，抛出来的是一枚**裸 DOMException（`TimeoutError`）**：
 * `trace.attempts` **为空**、五要素全无 —— 用户/模型拿到的就是一句 `The operation timed out.`
 * （`mirror-search.ts` 的归档正文循环是**同一形状**，已在那里修好；这里补齐**元数据这一跳**。）
 * 现在把**读正文这一段**纳入 `try/catch`，形状与那处逐条对齐：超时/断流 ⇒ 记一条 `PolicyFetchAttempt`
 * （含 `endpoint`／`step`／**真实已收字节数**）＋ 抛五要素齐的 `PolicyFetchError`。
 * **不改**重试次数（`POLICY_FETCH_ATTEMPTS` 仍是 3；这里**没有新增重试层**）、**不改** `timeoutScope`
 * 与三处上限、**不改**凭据作用域（`githubHeaders` 照旧只发给 api.github.com）：改的只有**失败记账的形状**。
 * 调用方取消（`signal.aborted`）**照旧原样传播**：不包装、不记账。
 * 刻意**留在 `try` 之外**的两件：`JSON.parse`（"正文不是 JSON"是**判据类**失败，且它的报错会带上上游正文
 * 片段 —— 套进五要素等于新开一个"回显上游原文"的面）与 `asObject`（本就不抛）⇒ 位置与改前逐字相同。
 */
async function getJSON(url: string, signal?: AbortSignal, trace?: PolicyFetchTrace, statusError?: (response: Response, url: string) => Error, retryOverride?: StatusRetryOverride, classifyExhausted?: ExhaustedResponseClassifier) {
  const response = await boundedFetch(url, { signal, headers: { ...headers, ...githubHeaders(url) } }, { step: '解析 source', trace, retryOverride, classifyExhausted })
  if (!response.ok) throw statusError ? statusError(response, url) : new Error(`POLICY_REMOTE_${response.status}`)
  const chunks: Uint8Array[] = []
  let total = 0
  const started = Date.now()
  try {
    if (response.body) {
      for await (const chunk of response.body) {
        if (signal) checkCancelled(signal)
        total += chunk.byteLength
        chunks.push(chunk)
      }
    }
  } catch (error) {
    // 调用方取消**原样传播**：它不是"这一跳失败"，包装成五要素会把取消说成故障。
    if (signal?.aborted) throw signal.reason ?? error
    const name = (error as Error)?.name
    const retryable = isTransientFetchFailure(error)
    // abort 落在读正文阶段（超时 signal 仍挂在 body 上）：报文必须说得出"撞的是哪一次上限"和"已收到多少字节"。
    const stalled = name === 'TimeoutError' || name === 'AbortError'
    const entry: PolicyFetchAttempt = {
      at: new Date().toISOString(), step: '解析 source', url, endpoint: endpointHost(url), attempt: 1,
      ms: Date.now() - started, retryable,
      reason: [describeError(error), stalled ? `（读正文阶段撞上本次尝试的 ${POLICY_FETCH_TIMEOUT_MS}ms 上限；在此之前已收到 ${total} 字节，元数据这一跳的字节只要在到就一直收）` : ''].filter(Boolean).join(' '),
    }
    trace?.attempts.push(entry)
    throw new PolicyFetchError({ url, step: '解析 source', attempts: [entry], retryable, context: trace?.context ?? {} })
  }
  return asObject(JSON.parse(new TextDecoder().decode(Buffer.concat(chunks, total))))
}

/** 保存来源原字段，不把所有策略强制投影成一种视觉策略的metadata。 */
export async function sourceSnapshot(provider: PolicySource, id: string, revision: string, endpoint: string, signal?: AbortSignal, trace?: PolicyFetchTrace): Promise<{ metadata: Record<string, unknown>; files: SourceFile[]; resolvedRevision: string }> {
  const attempts = trace ?? newPolicyFetchTrace({ provider, modelId: id, revision })
  // 'packs' 源只经能力包端点（pack-source.ts 的 catalog/open/stream）取件，禁止回落公开源下载。
  if (provider === 'packs') throw new Error('PACK_PUBLIC_FALLBACK_FORBIDDEN')
  if (provider === 'github') {
    const base = `${GITHUB_API_ORIGIN}/repos/${policyId(id)}`
    // 状态类错误按 GitHub 语义分类：**两类 403 处置相反**（配额限流 vs 仓库/权限），不能报成一模一样的裸码。
    const statusError = (response: Response, url: string) => githubStatusError(response.status, response.headers, url, githubCredential())
    // W26-R2：**覆盖不生效**的限流应答会重试到耗尽再抛 PolicyFetchError —— 那条出口也必须拿到
    // 同一段限流诊断，否则"429 就是限流"这件事在用户侧仍然不可达。判定与措辞都与 statusError 同源。
    // ⚠️ 变体 A（429 一律覆盖）下这条出口不可达（见 `ExhaustedResponseClassifier`），保留为接缝。
    const classifyExhausted = (response: Response, url: string, attempts: number) => githubRateLimited(response.status, response.headers)
      ? { retryable: false, diagnosis: githubRateLimitDiagnosis(response.status, response.headers, url, githubCredential(), Date.now(), 'fetch', attempts) }
      : null
    // W26-R1：限流（429／带限流证据的 403）**不重试** —— 一次重试就是再花 3 个配额，且 429 会被
    // `TRANSIENT_STATUS` 重试 3 次后报"可否重试：true"。覆盖只发生在**这一条链**上（`getJSON` 的 `retryOverride`）。
    const commit = await getJSON(`${base}/commits/${encodeURIComponent(revision)}`, signal, attempts, statusError, githubStatusRetryOverride, classifyExhausted)
    if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error('POLICY_REVISION_UNRESOLVED')
    const [repo, tree] = await Promise.all([getJSON(base, signal, attempts, statusError, githubStatusRetryOverride, classifyExhausted), getJSON(`${base}/git/trees/${commit.sha}?recursive=1`, signal, attempts, statusError, githubStatusRetryOverride, classifyExhausted)])
    if (tree.truncated) throw new Error('POLICY_FILE_LIST_TRUNCATED')
    // 内容字节的**端点回退链**（裁决 a）：raw 优先（不占 API 配额、不需要凭据），失败才回退内容接口。
    // 两个地址都在这里定死并落进清单 —— 否则"回退到哪"就只能靠猜 URL 形状。
    const files: SourceFile[] = (tree.tree ?? []).filter((row: any) => row.type === 'blob' && row.mode !== '120000').map((row: any) => {
      const path = policyFile(row.path)
      return {
        path, bytes: row.size, revision: commit.sha, gitBlob: row.sha,
        url: `https://${GITHUB_RAW_HOST}/${id}/${commit.sha}/${encodePath(path)}`,
        fallbackUrl: `${GITHUB_API_ORIGIN}/repos/${policyId(id)}/contents/${encodePath(path)}?ref=${commit.sha}`,
      }
    })
    return { metadata: { ...repo, provider, id, revision: commit.sha, requestedRevision: revision }, files, resolvedRevision: commit.sha }
  }
  if (provider === 'huggingface') {
    // HF 走 hf-mirror 同形 API：先把请求 revision 解析成固定 commit sha，再取该 commit 的完整树。
    // 本机已登录（见 `huggingfaceToken`）时**带上凭据**：受控仓的 LFS 内容身份只有带授权才拿得到，
    // 匿名访问会被镜像掩码。身份两条各按内容算：普通文件的 tree `oid` 就是 git blob sha1（`hashFile`
    // 的 gitBlob 同算法）；LFS 大件的 `lfs.oid`/`lfs.sha256` 是内容 sha256（`downloadFile` 按 sha256 核对），
    // gitBlob 对 LFS 内容不适用故不填。manifest 仍落实测 sha256，重量校验不失守。
    // 两个元数据请求也走 `fetchScoped`：镜像把**元数据**接口 308 到官方端点时同样不许跟随。
    const scope = signal ?? new AbortController().signal
    const endpoint = huggingfaceEndpoint(), base = `${endpoint}/api/models/${policyId(id)}`
    const infoFetch = await fetchScoped(`${base}/revision/${encodeURIComponent(revision)}`, scope, {}, 5, { step: '解析 source', trace: attempts })
    if (!infoFetch.response.ok) throw new Error(huggingfaceStatusError('POLICY_REMOTE', infoFetch.response.status, infoFetch.credential))
    const info = asObject(await infoFetch.response.json())
    if (!/^[a-f0-9]{40}$/.test(info.sha)) throw new Error('POLICY_REVISION_UNRESOLVED')
    const commit = String(info.sha)
    const treeFetch = await fetchScoped(`${base}/tree/${commit}?recursive=true`, scope, {}, 5, { step: '解析 source', trace: attempts })
    if (!treeFetch.response.ok) throw new Error(huggingfaceStatusError('POLICY_REMOTE', treeFetch.response.status, treeFetch.credential))
    const rows = await treeFetch.response.json()
    if (!Array.isArray(rows)) throw new Error('POLICY_REMOTE_INVALID_RESPONSE')
    const files: SourceFile[] = rows.filter((row: any) => row?.type === 'file').map((row: any) => {
      const url = `${endpoint}/${id}/resolve/${commit}/${encodePath(row.path)}`
      const lfs = row.lfs && typeof row.lfs === 'object' ? row.lfs as Record<string, any> : null
      if (lfs) {
        // LFS 大件的内容身份只能是 sha256。掩码/缺失**照实报错**：行里的 `oid` 是那一百多字节
        // **指针文件**的 git blob sha1，拿它当十 GB 权重的身份是伪造，宁可拒绝也不拼假身份。
        const oid = String(lfs.sha256 ?? lfs.oid ?? ''), bytes = Number(lfs.size)
        if (!/^[a-f0-9]{64}$/.test(oid)) throw new Error(/^\*+$/.test(oid) ? 'POLICY_SOURCE_IDENTITY_MASKED' : 'POLICY_SOURCE_IDENTITY_MISSING')
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('POLICY_SOURCE_IDENTITY_MISSING')
        return { path: policyFile(row.path), bytes, revision: commit, sha256: oid, url }
      }
      const bytes = Number(row.size), gitBlob = /^[a-f0-9]{40}$/.test(row.oid) ? row.oid : undefined
      if (!Number.isSafeInteger(bytes) || bytes < 0 || gitBlob === undefined) throw new Error('POLICY_SOURCE_IDENTITY_MISSING')
      return { path: policyFile(row.path), bytes, revision: commit, gitBlob, url }
    })
    return { metadata: { ...info, provider, endpoint, id, revision: commit, requestedRevision: revision }, files, resolvedRevision: commit }
  }
  const [info, listing] = await Promise.all([
    getJSON(`${endpoint}/openapi/v1/models/${id}`, signal, attempts),
    getJSON(`${endpoint}/api/v1/models/${id}/repo/files?Revision=${encodeURIComponent(revision)}&Recursive=true`, signal, attempts),
  ])
  if (info.success !== true || !info.data || (listing.Success !== true && listing.Code !== 200)) throw new Error('POLICY_REMOTE_INVALID_RESPONSE')
  const data = asObject(info.data)
  const files: SourceFile[] = (listing.Data?.Files ?? []).filter((row: any) => row.Type === 'blob').map((row: any) => {
    if (!/^[a-f0-9]{40}$/.test(row.Revision) || !/^[a-f0-9]{64}$/.test(row.Sha256)) throw new Error('POLICY_SOURCE_IDENTITY_MISSING')
    return { path: policyFile(row.Path), bytes: row.Size, revision: row.Revision, sha256: row.Sha256, url: `${endpoint}/models/${id}/resolve/${row.Revision}/${encodePath(row.Path)}` }
  })
  const revisions = [...new Set(files.map(row => row.revision))]
  const resolvedRevision = revisions.length === 1 ? revisions[0]! : 'files-' + createHash('sha256').update(JSON.stringify(files)).digest('hex')
  return { metadata: { ...data, provider, endpoint, id: data.id ?? id, revision: resolvedRevision, requestedRevision: revision }, files, resolvedRevision }
}

/**
 * 本机缓存状态：只读 CAS 里的 `manifest.json`——**不重算哈希、不访问来源**。
 *
 * 为什么与 `policy_verify` 分开：verify 会逐件重算 sha256（对十 GB 级模型是分钟级操作），只适合
 * 用户显式校验；「这模型在本机有没有、下过多少」是每步决策与面板都要读的**便宜事实**，
 * 读 manifest 的 `status/files` 就够，且 manifest 本身就是下载时逐件核对后写下的。
 * 缓存目录不存在 ⇒ `NOT_DOWNLOADED`（不假装空表，也不抛）。
 */
export interface PolicyCacheStatus {
  status: 'NOT_DOWNLOADED' | PolicyManifest['status']
  root: string
  /** 下载时解析到的固定 revision（来源坐标，取件时已核对）；未下载过为 null。 */
  resolvedRevision: string | null
  /** 已落盘（下载时逐件核对过 sha256）的文件数与声明字节合计。 */
  files: number
  bytes: number
  updatedAt: string | null
  error: string | null
}
export async function readPolicyCache(dataDirectory: string, provider: PolicySource, modelId: string, revision?: string): Promise<PolicyCacheStatus> {
  const root = policyDirectory(dataDirectory, provider, modelId, policyRevision(revision))
  const empty: PolicyCacheStatus = { status: 'NOT_DOWNLOADED', root, resolvedRevision: null, files: 0, bytes: 0, updatedAt: null, error: null }
  try {
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as PolicyManifest
    const files = Array.isArray(manifest.files) ? manifest.files : []
    return {
      status: (manifest.status ?? 'NOT_DOWNLOADED') as PolicyCacheStatus['status'],
      root,
      resolvedRevision: typeof manifest.resolvedRevision === 'string' ? manifest.resolvedRevision : null,
      files: files.length,
      bytes: files.reduce((sum, file) => sum + (Number.isSafeInteger(file?.bytes) ? Number(file.bytes) : 0), 0),
      updatedAt: typeof manifest.updatedAt === 'string' ? manifest.updatedAt : null,
      error: typeof manifest.error === 'string' ? manifest.error : null,
    }
  } catch { return empty }
}

export async function hashFile(path: string, gitSize?: number) {
  const sha = createHash('sha256'), git = gitSize === undefined ? undefined : createHash('sha1').update(`blob ${gitSize}\0`)
  let bytes = 0
  for await (const chunk of createReadStream(path)) { sha.update(chunk); git?.update(chunk); bytes += chunk.length }
  return { bytes, sha256: sha.digest('hex'), ...(git ? { gitBlob: git.digest('hex') } : {}) }
}

/**
 * 自己跟 3xx（`redirect:'manual'`）而不是交给 fetch 自动跟：这样才能**逐跳**决定要不要带凭据。
 * 镜像把大件 302 到它自己的签名 CDN（另一个 origin）时就该丢掉 Authorization——凭据只属于配置的
 * HF 端点本身。其余来源（GitHub/ModelScope）拿到的凭据本来就是空集，语义与自动跟随一致。
 *
 * 返回值带上**真正给出这个应答的 origin 与它那跳有没有凭据**：判"是不是授权问题"必须看最后那一跳，
 * 否则镜像跳到 CDN、CDN 回 403 时会被报成"本机没有 HF 凭据"——那是把上游故障说成用户没登录。
 *
 * 跳转目标若是**官方 Hub**，不跟随、不发请求：那是"镜像失败后静默回退官方端点"，既破仓库纪律也把
 * 凭据带出配置的那一处（实测 hf-mirror 在 LFS `/resolve/` 上会回 308 → huggingface.co）。
 *
 * GitHub 侧同一形状（2026-09-26 端点回退链）：凭据（`githubHeaders`）与限流覆盖（`githubRetryOverride`）
 * 都**逐跳按 host 现算** —— 只发给 `api.github.com` 那一跳。若内容接口把请求 302 到 raw 主机，
 * 下一跳就自然不带凭据（`githubHeaders` 只看 host），而不是把 PAT 送给另一个 origin。
 * `hook.timeoutScope` / `hook.timeoutMs`：见 `boundedFetch` —— 逐件下载那一跳要的是 'connect'（建连上限到
 * 应答头即撤销），元数据与重定向每一跳保持默认的「每次尝试含读正文 30s」。
 */
async function fetchScoped(url: string, signal: AbortSignal, extra: Record<string, string>, limit = 5, hook?: { step: PolicyFetchStep; trace?: PolicyFetchTrace; timeoutScope?: 'attempt' | 'connect'; timeoutMs?: number }) {
  let target = url, auth = await huggingfaceHeaders(url)
  for (let hop = 0; ; hop++) {
    const hopOrigin = new URL(target).origin
    const response = await boundedFetch(target, { signal, headers: { ...headers, ...auth, ...githubHeaders(target), ...extra }, redirect: 'manual' }, { step: hook?.step ?? '建连', trace: hook?.trace, retryOverride: githubRetryOverride(target), timeoutScope: hook?.timeoutScope, timeoutMs: hook?.timeoutMs })
    const location = response.headers.get('location')
    if (!location || ![301, 302, 303, 307, 308].includes(response.status)) return { response, credential: 'authorization' in auth, origin: hopOrigin, url: target }
    if (hop >= limit) throw new Error('POLICY_REDIRECT_LIMIT')
    const next = new URL(location, target)
    if (isOfficialHuggingface(next.hostname)) throw new Error(`POLICY_HF_REDIRECT_FORBIDDEN: ${next.hostname}`)
    target = next.href
    if (next.origin !== new URL(huggingfaceEndpoint()).origin) auth = {}
  }
}

/** 端点身份（记录"本次字节由哪个端点提供"用的名字）：URL 的 host。 */
export const endpointHost = (url: string): string => new URL(url).hostname
/** 端点回退链上的一跳：`endpoint`＝host（记录用），`accept`＝这一跳要求的媒体类型（内容接口要 raw 原文）。 */
export interface PolicySourceEndpoint { endpoint: string; url: string; accept?: string }
/**
 * 一条来源文件的**端点回退链**（裁决 a／2026-09-26）：**主端点在前**（`file.url`），备用端点在次。
 *
 * 现在只有 github 分支有第二跳（内容接口 `api.github.com`，`sourceSnapshot` 写进 `fallbackUrl`），
 * 其余来源（HF／ModelScope／packs）链长恒为 1 —— 与"只有一个端点"时行为逐字一致。
 * 返回的是**候选顺序**，不是"一定会试"：能不能换下一跳由 `endpointFallbackAllowed` 定。
 */
export const policySourceEndpoints = (file: SourceFile): PolicySourceEndpoint[] => {
  const primary: PolicySourceEndpoint = { endpoint: endpointHost(file.url), url: file.url }
  if (!file.fallbackUrl) return [primary]
  return [primary, { endpoint: endpointHost(file.fallbackUrl), url: file.fallbackUrl, accept: GITHUB_RAW_MEDIA_TYPE }]
}
/**
 * 换端点的判据（裁决 a 只批准"失败⇒回退"，所以这里必须**窄**）：只有**传输层失败**才回退 ——
 * 超时／断流／连接被断／5xx，即 P13 实测的那个形状（`raw.githubusercontent.com` 这个**主机**对默认
 * 客户端不通：TCP 71ms 连上、HTTP/TLS 层被中间盒丢包，而同一批字节从内容接口能取到且指纹逐字相同）。
 *
 * **不回退**的三类（各自都有理由，且都是确定性的应答/判定）：
 *   1. 校验不符（`POLICY_SOURCE_CHECKSUM_MISMATCH`）—— 字节到过、只是**不是那一批**，换端点等于把
 *      "来源内容不可信"悄悄换成"再抓一次看看"，是伪造身份的口子；
 *   2. 4xx（404/403…）—— 应答是确定的，换端点只会再烧一份配额（内容接口未认证只有 60 次/小时）；
 *   3. 状态类诊断（限流/权限，`PolicyEndpointStatusError`）—— 同上，且限流本来就"重试＝再烧配额"。
 */
export const endpointFallbackAllowed = (error: unknown): boolean =>
  error instanceof PolicyFetchError ? error.retryable : !(error instanceof PolicyEndpointStatusError) && isTransientFetchFailure(error)

/** 边接收边落盘；中断保留真实.part，续传必须核对Content-Range与固定来源身份。 */
/**
 * 单次尝试的**一跳**：建连／应答头有**它自己的**上限（`connectMs`，**到应答头即撤销**）＋
 * 边收边落盘（**正文阶段** `stallMs` 没有收到任何字节才掐，整体耗时不限）。
 * 两个上限各管各的 —— 这正是 W25 没做到的那件事（它把两者算成了同一个总时限）。
 */
async function downloadFileFromEndpoint(file: SourceFile, candidate: PolicySourceEndpoint, hop: string, target: string, signal: AbortSignal, resume: boolean, trace?: PolicyFetchTrace, stallMs = POLICY_DOWNLOAD_STALL_MS, connectMs = POLICY_FETCH_TIMEOUT_MS) {
  const part = target + '.part', identityPath = part + '.json'
  await mkdir(dirname(target), { recursive: true })
  const identity = JSON.stringify(file)
  let offset = 0
  if (resume) {
    try { if (await readFile(identityPath, 'utf8') === identity) offset = (await stat(part)).size } catch {}
  }
  if (offset > file.bytes) throw new Error('POLICY_PART_OVERSIZED')
  if (offset === file.bytes && offset > 0) {
    const actual = await hashFile(part, file.gitBlob ? file.bytes : undefined)
    if (file.sha256 && actual.sha256 !== file.sha256 || file.gitBlob && actual.gitBlob !== file.gitBlob) throw new Error('POLICY_SOURCE_CHECKSUM_MISMATCH')
    checkCancelled(signal)
    await rename(part, target)
    return { ...actual, requestedOffset: offset, resumedBytes: offset, receivedBytes: 0, responseStatus: 0, contentRange: null }
  }
  // 这一层的 abort 受**两件事**驱动：调用方取消、**字节流停摆**（下面的 `armStall`）。
  // 建连上限由 `boundedFetch` 负责，且按 `timeoutScope: 'connect'` **到应答头即撤销** —— 不再压在读正文上。
  const attemptAbort = new AbortController()
  const scoped = AbortSignal.any([signal, attemptAbort.signal])
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  let stalled = false
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => { stalled = true; attemptAbort.abort(new Error(`POLICY_DOWNLOAD_STALL: ${stallMs}ms 内没有收到任何字节`)) }, stallMs)
  }
  let response: Response, credential: boolean, origin: string, answered: string
  // 建连／应答头这一跳：上限是 `connectMs`，而且 **`timeoutScope: 'connect'` ⇒ 到应答头即撤销**。
  // 这里**不再**武装停摆计时器：还没有开始读正文，"多久没收到字节"无从谈起 —— 它正是 W25 里两个 30s
  // 打架的来源（Go2 真机 ②③ 在建连阶段报出 `POLICY_DOWNLOAD_STALL`，就是这条的产物）。
  // 内容接口那一跳必须声明 `Accept: application/vnd.github.raw`（要的是**原文**，不是 base64 包在 JSON 里）；
  // 凭据与限流覆盖由 `fetchScoped` **按 host 逐跳**加（只发 api.github.com）。
  const extra = { ...(candidate.accept ? { accept: candidate.accept } : {}), ...(offset ? { Range: `bytes=${offset}-` } : {}) }
  const scopedFetch = await fetchScoped(candidate.url, scoped, extra, 5, { step: '建连', trace, timeoutScope: 'connect', timeoutMs: connectMs })
  response = scopedFetch.response; credential = scopedFetch.credential; origin = scopedFetch.origin; answered = scopedFetch.url
  // 授权口径只看**应答方**：镜像自己回的 401/403 才谈得上"本机凭据有无"；镜像跳到签名 CDN 后 CDN 回的
  // 403 是上游取件失败（签名过期/被拒），照原有前缀报，不冒充授权问题、也不回显上游原文。
  // GitHub 内容接口那一跳用 P18 的状态分类器（限流 vs 权限/仓库；429 也在内）—— 它与 `getJSON` 用的是**同一个**
  // `githubStatusError`，所以"同一个 429"在元数据与逐件两条路上给出同一套诊断与同一个"不重试"结论。
  if (!response.ok) {
    if (origin === GITHUB_API_ORIGIN) throw new PolicyEndpointStatusError({
      endpoint: candidate.endpoint, url: answered, status: response.status, hop,
      diagnosis: githubStatusError(response.status, response.headers, answered, githubCredential()).message,
    })
    throw new Error(origin === new URL(huggingfaceEndpoint()).origin
      ? `${huggingfaceStatusError('POLICY_DOWNLOAD', response.status, credential)}: ${file.path}`
      : `POLICY_DOWNLOAD_${response.status}: ${file.path}`)
  }
  let append = false
  if (response.status === 206) {
    const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
    if (!range || Number(range[1]) !== offset || Number(range[2]) !== file.bytes - 1 || Number(range[3]) !== file.bytes) throw new Error('POLICY_CONTENT_RANGE_MISMATCH')
    append = offset > 0
  } else if (response.status !== 200) throw new Error('POLICY_DOWNLOAD_STATUS_UNSUPPORTED')
  if (!response.body) throw new Error('POLICY_DOWNLOAD_BODY_MISSING')
  await writeFile(identityPath, identity, { mode: 0o600 })
  const output = await open(part, append ? 'a' : 'w', 0o600)
  let received = 0
  try {
    armStall()
    for await (const chunk of response.body) {
      checkCancelled(signal)
      let written = 0
      while (written < chunk.byteLength) { const result = await output.write(chunk, written, chunk.byteLength - written); written += result.bytesWritten }
      received += chunk.byteLength
      armStall()
      if ((append ? offset : 0) + received > file.bytes) throw new Error('POLICY_DOWNLOAD_OVERSIZED')
    }
  } catch (error) {
    // 停摆/上游断流都如实转成可读原因（"socket connection was closed unexpectedly" 不再裸奔）。
    if (stalled) throw new Error(`POLICY_DOWNLOAD_STALL: ${stallMs}ms 内没有收到任何字节（上游可能已断流）`)
    throw error
  } finally { if (stallTimer) clearTimeout(stallTimer); await output.close() }
  checkCancelled(signal)
  const actual = await hashFile(part, file.gitBlob ? file.bytes : undefined)
  if (actual.bytes !== file.bytes || file.sha256 && actual.sha256 !== file.sha256 || file.gitBlob && actual.gitBlob !== file.gitBlob) throw new Error('POLICY_SOURCE_CHECKSUM_MISMATCH')
  await rename(part, target)
  // `answeredByEndpoint`＝**真正回了这批字节的 origin**（`fetchScoped` 逐跳跟 3xx，最后一跳才算数）：
  // 内容接口把请求 302 到 raw 主机时，说"字节由 api.github.com 提供"就是不实。
  return { ...actual, requestedOffset: offset, resumedBytes: append ? offset : 0, receivedBytes: received, responseStatus: response.status, contentRange: response.headers.get('content-range'), answeredByEndpoint: endpointHost(answered) }
}

/**
 * 单次尝试＝**端点回退链**（裁决 a／2026-09-26）：主端点优先，传输层失败才换下一跳。
 *
 * 返回值把"这批字节由谁给的"一起带走：`servedByEndpoint`（**本次由哪个端点提供**）／`answeredByEndpoint`
 * （真正回应答的 origin，跟过 3xx 才算数）／`endpointsTried`（链上实际走过的端点序）／`fallbackUsed`（是否用了备用端点）。
 * 它们随 `downloadPolicy` 落进 `manifest.transfers` —— 验收问"字节从哪来"时，答案就在这一行里。
 */
async function downloadFileOnce(file: SourceFile, target: string, signal: AbortSignal, resume: boolean, trace?: PolicyFetchTrace, stallMs = POLICY_DOWNLOAD_STALL_MS, connectMs = POLICY_FETCH_TIMEOUT_MS) {
  const endpoints = policySourceEndpoints(file)
  const tried: string[] = []
  for (const [index, candidate] of endpoints.entries()) {
    const started = Date.now(), hop = `第 ${index + 1}/${endpoints.length} 跳`
    try {
      const transfer = await downloadFileFromEndpoint(file, candidate, hop, target, signal, resume, trace, stallMs, connectMs)
      return { ...transfer, servedByEndpoint: candidate.endpoint, endpointsTried: [...tried, candidate.endpoint], fallbackUsed: index > 0 }
    } catch (error) {
      // 取消不回退：回退也是白跑，按取消传播（与既有"取消不重试"同一条纪律）。
      if (signal.aborted) throw error
      tried.push(candidate.endpoint)
      const next = endpoints[index + 1]
      if (!next || !endpointFallbackAllowed(error)) throw error
      // 被放弃的这一跳必须留痕：否则"主端点失败过、字节其实是备用端点给的"在报文里会整段消失。
      trace?.attempts.push({
        at: new Date().toISOString(), step: '逐件下载', url: candidate.url, endpoint: candidate.endpoint,
        attempt: index + 1, ms: Date.now() - started, retryable: true,
        reason: `${candidate.endpoint} 不可用（${describeError(error)}）⇒ 回退到 ${next.endpoint}`,
      })
    }
  }
  throw new Error('POLICY_ENDPOINT_CHAIN_EMPTY')
}

/**
 * 逐件下载（W25；停摆语义修正见 `bugfixHistory/POLICY-STALL-CAP-FIX-20260926.md`）：
 * **整件**最多 3 次尝试（**次数与总的边界策略一个字未改**）—— 每次尝试内部有**两个各自独立的**上限：
 *   1. 建连／应答头 `connectMs`（默认 30s），**到应答头即撤销**；
 *   2. 读正文 `stallMs`（默认 30s）**没有收到任何字节**才掐 ⇒ 字节在到就一直收（整体耗时不限）。
 * 瞬时故障（超时/连接被断/5xx）自动续传重试（`.part` 已在，重试从断点续），
 * 非瞬时（校验不符、越界、4xx、凭据问题）立即失败且不重试。
 * 最终失败抛 `PolicyFetchError`（五要素齐）；成功但中间有失败尝试时，尝试仍留在 `trace.attempts` 里。
 * `stallMs` / `connectMs` 只给单测用（生产调用点一律走默认 30s × 30s）。
 */
export async function downloadFile(file: SourceFile, target: string, signal: AbortSignal, resume = true, trace?: PolicyFetchTrace, options: { stallMs?: number; connectMs?: number } = {}) {
  const failures: PolicyFetchAttempt[] = []
  for (let attempt = 1; attempt <= POLICY_FETCH_ATTEMPTS; attempt++) {
    const started = Date.now()
    try {
      return await downloadFileOnce(file, target, signal, resume, trace, options.stallMs, options.connectMs)
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? new Error('POLICY_CANCELLED')
      // 内层（建连）已经做过有界重试：原样抛出，不叠乘成 9 次。
      if (error instanceof PolicyFetchError) throw error
      // 端点回退链上的**状态类**诊断（限流/权限/不存在）：原样抛出（**不重试、也不套五要素**），
      // 理由见 `PolicyEndpointStatusError` —— 套上五要素会把限流的重置时刻与"不重试"两个结论截断掉。
      if (error instanceof PolicyEndpointStatusError) {
        // 记的是**失败的那一跳**自己的 URL 与端点（不是主端点的）—— 否则这一行会自相矛盾。
        trace?.attempts.push({ at: new Date().toISOString(), step: '逐件下载', url: error.url, endpoint: error.endpoint, attempt, ms: Date.now() - started, reason: describeError(error), retryable: false })
        throw error
      }
      const retryable = isTransientFetchFailure(error)
      const entry: PolicyFetchAttempt = { at: new Date().toISOString(), step: '逐件下载', url: file.url, endpoint: endpointHost(file.url), attempt, ms: Date.now() - started, reason: describeError(error), retryable }
      failures.push(entry); trace?.attempts.push(entry)
      if (!retryable || attempt >= POLICY_FETCH_ATTEMPTS) throw new PolicyFetchError({ url: file.url, step: '逐件下载', attempts: failures, retryable, context: trace?.context ?? {} })
    }
  }
  throw new PolicyFetchError({ url: file.url, step: '逐件下载', attempts: failures, retryable: false, context: trace?.context ?? {} })
}

/**
 * 取件选择项：精确路径，或以 `/` 结尾的**目录前缀**（该目录下全部 blob）。
 *
 * 为什么需要前缀：G1 12DOF 适配器的装配校验要求 `g1_12dof.xml` 里 `<mesh file=…>` 声明的每个 mesh
 * 都在缓存里，而这些 mesh 名**只有取到 XML 之后才知道** —— 精确路径列表在取件之前写不出来，
 * 于是"权重缺失"的提示只能给一条跑不通的命令。前缀把"这个目录下全部"这一层如实交给选择器，
 * 匹配仍然发生在**来源真实清单**上（选不中照样 `POLICY_FILE_NOT_IN_SOURCE`），不放宽任何校验。
 */
export const policyFileSelector = (value: unknown): { prefix: boolean; path: string } => {
  const text = typeof value === 'string' ? value : ''
  const prefix = text.endsWith('/')
  return { prefix, path: policyFile(prefix ? text.slice(0, -1) : value) }
}
/** 按选择项在**来源真实清单**上选出文件；精确路径找不到、或目录前缀一个都没匹配到，都是 `POLICY_FILE_NOT_IN_SOURCE`。 */
export const selectSourceFiles = (files: SourceFile[], selectors: string[]): SourceFile[] => {
  const picked = new Map<string, SourceFile>()
  for (const name of selectors) {
    const selector = policyFileSelector(name)
    const rows = selector.prefix ? files.filter(row => row.path.startsWith(selector.path + '/')) : files.filter(row => row.path === selector.path)
    if (!rows.length) throw new Error('POLICY_FILE_NOT_IN_SOURCE: ' + name)
    for (const row of rows) picked.set(row.path, row)
  }
  return [...picked.values()]
}
export async function downloadPolicy(input: { dataDirectory: string; endpoint: string; provider?: PolicySource; modelId: string; revision?: string; files: string[]; signal: AbortSignal; resume?: boolean }) {
  const provider = policySource(input.provider), id = policyId(input.modelId), revision = policyRevision(input.revision)
  const root = policyDirectory(input.dataDirectory, provider, id, revision), path = join(root, 'manifest.json')
  await mkdir(root, { recursive: true })
  // W25：整条取件链共用一份尝试轨迹；失败尝试**也要留痕**（见下面 flush 进 manifest.transfers）。
  const trace = newPolicyFetchTrace({ provider, modelId: id, revision })
  const manifest: PolicyManifest = { status: 'DOWNLOADING', provider, modelId: id, revision, resolvedRevision: '', metadata: {}, sourceFiles: [], files: [], transfers: [], execution: { status: 'BLOCKED', reason: '需匹配真实输入、动作语义和world版本后显式执行' }, updatedAt: new Date().toISOString() }
  /**
   * 尝试记录与"逐件传输结果"共用 `transfers`（契约里元素是自由形状，类型不动），但**必须可区分**：
   * 失败尝试带 `kind:'attempt-failed'`；正常逐件结果没有 `kind` 字段（保持既有形状不变）。
   */
  const flushAttempts = () => { for (const attempt of trace.attempts.splice(0)) manifest.transfers.push({ kind: 'attempt-failed', ...attempt }) }
  const save = async () => { flushAttempts(); manifest.updatedAt = new Date().toISOString(); await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 }) }
  // 先落一份 DOWNLOADING 清单：连"解析 source"这一步失败也能在 manifest 里留下状态、原因与尝试轨迹
  // （改前这里失败则**没有任何清单**，会话结束后无从检索——W25 把失败可诊断性补齐）。
  await save()
  try {
    const source = await sourceSnapshot(provider, id, revision, input.endpoint, input.signal, trace)
    const selected = selectSourceFiles(source.files, input.files)
    manifest.resolvedRevision = source.resolvedRevision
    manifest.metadata = source.metadata
    manifest.sourceFiles = selected
    await save()
    for (const file of selected) {
      let actual
      try {
        actual = await hashFile(join(root, file.path), file.gitBlob ? file.bytes : undefined)
        if (actual.bytes !== file.bytes || file.sha256 && actual.sha256 !== file.sha256 || file.gitBlob && actual.gitBlob !== file.gitBlob) actual = undefined
      } catch { actual = undefined }
      if (!actual) {
        const target = join(root, file.path)
        try {
          const transfer = await downloadFile(file, target, input.signal, input.resume, trace)
          actual = transfer; manifest.transfers.push({ path: file.path, ...transfer })
        } catch (error) {
          /**
           * ★ 第 3 级（整仓归档）在**产品路径**上的接线（2026-09-27）。
           *
           * 缺口：第 1/2 级的端点链**最多两跳**（`policySourceEndpoints` 的 raw → 内容接口），两个端点都
           * 传输层失败之后**没有第 3 跳** —— `mirror-search.ts` 的整仓归档（codeload）在产品 src 里
           * 一个调用点都没有（`bugfixHistory/ARCHIVE-REACHABILITY-AND-MEMO-20260927.md` §1 的实测形态：
           * 两个端点全失败 ⇒ codeload 接触次数 0）。这里**只补接线**，取件逻辑一行不新写：换级的动作
           * 交给同文件已有的 `fetchPolicyFileViaArchive()`。
           *
           * 四条换级判据（一条不放宽，全部复用现成导出，不新造尺子）：
           *   ⑧ **取消不换级**（与 `downloadFileOnce:905-907` 同一条纪律）；
           *   ⑪ **packs 源不适用**：能力包字节只经 pack 端点（`PACK_PUBLIC_FALLBACK_FORBIDDEN` 的同一道理），
           *      这里直接早退 —— 不让 `knownMirrorCandidates` 的 `POLICY_MIRROR_PACKS_FORBIDDEN` 变成
           *      "另一种失败形态"；
           *   ③ **身份不够强就不走**：`identityStrength(file) === 'none'` ⇒ 第 3 级没有判据
           *      （`requireMirrorIdentity` 会抛），**不**把"没有判据"降级成"随便取"；
           *   ① **只有传输层失败才换级**：`endpointFallbackAllowed(error)` —— 与第 1→2 级**同一把尺子**。
           *      校验不符（`POLICY_SOURCE_CHECKSUM_MISMATCH`）、4xx、状态类（`PolicyEndpointStatusError`
           *      限流／权限）**一律不换**：那三类是确定性结论，"再抓一次看看"会把"来源内容不可信"
           *      洗成"网络抖动"。三条理由与 `:788-798` 逐字同源。
           *   ② 换的只是**取字节的方式**，不是判据：下面的 `declared` 一个字段都不来自第 3 级，
           *      只来自 `sourceSnapshot` 的清单（`file.bytes` ＋ `gitBlob`／`sha256`，provenance='source-snapshot'）。
           *   ⑥ **不许编钉**：冷启动没有 `expectedSha256`（钉是"上一次核对通过之后"才知道的）⇒ 不传
           *      `archive.expectedSha256`，走 `fetchPolicyFileViaArchive` 的共享实例那条路
           *      （判据由"该实例内首次见到即记住"承担；把钉持久化进 manifest 是**另一件事**，本单不做）。
           *   ⑤ `archive.root` ＝ `<repo 名>-<commit sha>`（codeload 归档恒有这一个顶层目录）；
           *      给错会当场拒（`locateArchiveEntry` 逐字精确匹配，找不到即
           *      `POLICY_MIRROR_ARCHIVE_TARGET_MISSING`），不会静默取错字节。
           *   ④ 门①／门②**逐件不省**：每一件仍然各自命中条目、各自写 `.part`、各自与声明逐字核对
           *      （门①）、各自过 `verifyMirrorReading`（门②）—— 换级省的只是"第 1/2 级取不到字节"。
           *
           * ⚠️ 只许补在**这里**，不许补进 `downloadFile`／`downloadFileOnce`：`mirror-search.ts:320` 的
           * blob 候选回头调 `downloadFile` ⇒ 补在那里会在第 3 级内部递归回第 1 级；而且 `SourceFile`
           * 没有 `modelId`，`knownMirrorCandidates` 要的坐标在那里拿不到（判据⑦）。
           */
          if (input.signal.aborted || provider !== 'github' || identityStrength(file) === 'none' || !endpointFallbackAllowed(error)) throw error
          // 换级也是一次"尝试"：被放弃的第 1/2 级端点链必须留痕，否则"为什么换了级"在清单里整段消失。
          manifest.transfers.push({
            kind: 'attempt-failed', path: file.path, step: '逐件下载',
            endpointChain: policySourceEndpoints(file).map(row => row.endpoint), reason: describeError(error),
            nextHop: '第 3 级：整仓归档（codeload.github.com）',
          })
          let mirror: MirrorFetchReading
          try {
            mirror = await fetchPolicyFileViaArchive({
              coordinates: { provider, modelId: id, revision: source.resolvedRevision },
              declared: {
                identity: { path: file.path, bytes: file.bytes, ...(file.sha256 ? { sha256: file.sha256 } : {}), ...(file.gitBlob ? { gitBlob: file.gitBlob } : {}) },
                provenance: 'source-snapshot',
                note: `来源清单 ${file.path}（revision ${source.resolvedRevision}）；第 1/2 级端点链都失败后走第 3 级整仓归档`,
              },
              target, signal: input.signal, trace,
              archive: { root: `${id.split('/')[1]}-${source.resolvedRevision}` },
            })
          } catch (archiveError) {
            // 判据⑨：**第 3 级也失败要留痕** —— 失败那次进 `transfers`（与 `flushAttempts` 同形），
            // 第 1/2 级的五要素错**挂 cause** 一起带走（"字节为什么没来"两个层级的答案都不许消失）。
            manifest.transfers.push({ kind: 'attempt-failed', path: file.path, step: '逐件下载', endpoint: 'codeload.github.com', reason: describeError(archiveError), nextHop: null })
            if (archiveError instanceof Error && archiveError.cause === undefined) archiveError.cause = error
            throw archiveError
          }
          // 判据⑩：换级成功必须写明 —— `shape:'archive'` ＋ `servedByEndpoint`（哪个端点的字节）＋ 逐条候选裁决。
          actual = mirror.reading
          manifest.transfers.push({ path: file.path, ...mirror.reading, shape: mirror.servedBy.shape, servedByEndpoint: mirror.servedBy.host, mirrorAttempts: mirror.attempts })
        }
      }
      manifest.files.push({ ...file, sha256: actual.sha256 })
      await save()
    }
    manifest.status = 'DOWNLOADED'; await save()
    return { ...manifest, path: root, manifestPath: path }
  } catch (error) {
    manifest.status = input.signal.aborted ? 'CANCELLED' : 'FAILED'; manifest.error = String(error); await save(); throw error
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 第 3 级「整仓归档」的**产品侧接线**（2026-09-27 · 回执 `bugfixHistory/SOURCE-MEMO-WIRING-AND-SENTINEL-20260927.md`）
 *
 * 缺口（`bugfixHistory/ARCHIVE-FETCH-MEMOIZATION-20260926.md` §7-U2）：`mirror-search.ts` 的归档记忆化
 * 已经做好、判据一个字没放宽，但**没钉时默认不缓存**（`resolveMirrorArchiveCache`：`options.cache ??`
 * `(options.expectedSha256 ? defaultMirrorArchiveCache : undefined)`），而产品侧既没有钉、也没有交实例
 * ⇒ 一次取件里 68 件同属一棵树时仍然是**68 次取字节 + 68 次解包**（G1 那单 509.8 s，重测 95.575 s）。
 *
 * 两条口径一个字不改（这是接线的边界）：
 *   · **判据不省**：本文件只挑「同一发行方的**归档**候选」，再把**共享缓存**接下去（没钉 ⇒ 传实例；
 *     有钉 ⇒ 交给模块默认实例，钉本身进键并逐字核对）；门①（写盘前与声明逐字核对）、门②
 *     （`verifyMirrorReading`）与逐件判据全部仍在 `mirror-search.ts` 里**逐件**执行
 *     —— 命中只省"把同一包字节再下一次、再解一次"。
 *   · **失败不进缓存**：由 `loadArchiveMaterial` 的 `pending.catch(() => cache.forget(key))` 保证，本文件不碰。
 *
 * 为什么是**共享实例**而不是"给个钉"：冷启动没有钉（G1 的 `545ead52…` 是**上一次核对通过之后**才知道的），
 * 而共享实例在没钉时的语义是"该实例内首次见到即记住"（可信边界随之落在本函数），这正是记忆化的用法；
 * 调用方给了钉的场合，钉**照样进键、照样逐字核对**（两条路都测了，见回执 §3）。
 * ══════════════════════════════════════════════════════════════════════════════ */
let sharedArchiveCache: MirrorArchiveCache | undefined
/**
 * **进程内唯一**的归档记忆化缓存（惰性构造）。
 *
 * 为什么惰性：`mirror-search.ts` 在**模块顶部**（第 67 行）就 import 本文件，而 `MirrorArchiveCache`
 * 是它靠后的 `class` 声明 ⇒ 若本文件在顶层 `new MirrorArchiveCache()`，**以 `mirror-search.ts` 为入口**
 * 的那条加载顺序会撞上 TDZ（`Cannot access 'MirrorArchiveCache' before initialization`，本仓用例正是
 * 从 `mirror-search.ts` 入口加载的）。放进函数体即可，判据一个字不受影响。
 */
export function policyArchiveCache(): MirrorArchiveCache {
  return sharedArchiveCache ??= new MirrorArchiveCache()
}
/** 这份共享缓存的读数：`downloads`／`unpacks` 是**真取／真解**的次数，`hits` 是省下来的件数。 */
export function policyArchiveCacheStats(): MirrorArchiveCacheStats { return policyArchiveCache().stats() }

export interface PolicyArchiveFetchInput {
  /** 来源坐标（只用来合成候选 URL 与诊断，**不当判据**）。 */
  coordinates: MirrorCoordinates
  /** 身份声明：判据的**唯一**出处（与 blob 候选同一把尺子，见 `mirror-search.ts` 的 `requireMirrorIdentity`）。 */
  declared: DeclaredIdentity
  target: string
  signal: AbortSignal
  trace?: PolicyFetchTrace
  /**
   * 归档那一跳的参数（`root`／两个上限／`admittedHosts`／`timeoutMs`／`fetch` 接缝）。
   * **不含 `cache`**：缓存由本入口接线 —— 调用方不需要、也不该各自造一个（否则一次取件的 68 件各记一份，等于没省）。
   */
  archive?: Omit<MirrorArchiveOptions, 'cache'>
}

/**
 * 从**同一发行方的整仓归档**取一个文件（第 3 级归档路径的产品入口）。
 *
 * 与直接调 `fetchFromMirrors` 的差别**只有两点**：
 *   1. 候选只留 `shape === 'archive'` 的那几条 —— 本入口**不**顺带去试 `github.com/…/raw/…` 那条 blob
 *      候选（它最终会打到第 1 级那个故障主机；要走它请走第 1/2 级）；
 *   2. `archive.cache` **按有没有钉分两条路接上共享缓存**，两条路都做到"同一进程内第二次取同一个归档
 *      不再下载、不再解包"，且都**不省判据**（每一件仍然命中条目、写 `.part`、过门①、过门②）：
 *        · **有钉**（`expectedSha256` 给了）⇒ **不传实例**，走 `mirror-search.ts` 的**模块默认实例**
 *          （键是内容寻址的 ⇒ 进程内共享安全；读数在 `mirrorArchiveCacheStats()`）；
 *        · **没钉**（冷启动：钉是"上一次核对通过之后"才知道的）⇒ 传本文件的**共享实例**
 *          （语义＝该实例内"首次见到即记住"，可信边界归本函数；读数在 `policyArchiveCacheStats()`）。
 *      分成两条路而不是"恒传实例"，是为了不覆盖 `mirror-search.ts` 已经定好的那条口径
 *      （`resolveMirrorArchiveCache`：有钉用模块默认实例／没钉只认调用方实例），
 *      也让"有钉"那条路的读数直接落在它自己的 `mirrorArchiveCacheStats()` 上。
 */
export async function fetchPolicyFileViaArchive(input: PolicyArchiveFetchInput): Promise<MirrorFetchReading> {
  const candidates = knownMirrorCandidates(input.coordinates, input.declared).filter(row => row.shape === 'archive')
  const pinned = input.archive?.expectedSha256 !== undefined
  return await fetchFromMirrors({
    declared: input.declared, coordinates: input.coordinates, candidates,
    target: input.target, signal: input.signal, trace: input.trace,
    includeArchive: true,
    archive: { ...input.archive, ...(pinned ? {} : { cache: policyArchiveCache() }) },
  })
}
