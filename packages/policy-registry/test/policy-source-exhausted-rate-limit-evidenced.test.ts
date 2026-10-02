/**
 * 耗尽出口的**第二类输入**：429 **带** `x-ratelimit-*` 证据（`hasRateLimitEvidence` 为真）。
 *
 * ## 为什么需要这个文件（与同目录 `policy-source-exhausted-rate-limit.test.ts` 的分工）
 *
 * 那个文件钉的是**证据缺失**那一类（空头 429 ⇒ `重置指引` 那一支）；
 * 本文件钉**证据在场**那一类（⇒ `配额（限流）已用尽` + `重置于 <时刻>` + `处置建议` 那一支）。
 * 两者走**同一个耗尽出口**，但**报文分支不同** —— 只钉一支时，另一支的措辞可以在无人察觉时退化
 * （例如把"有证据"也报成"算不出重置时刻"）。
 *
 * ## 它钉的历史事件（复核单 CLASSIFYEXHAUSTED-RESTORE／本 lane，2026-09-27）
 *
 * `boundedFetch` 的耗尽出口曾在 00:48:16 的 922 行版里被 lane-stall 的补丁脚本**整段重写**，
 * 连带删掉 `const classified = options.classifyExhausted?.(…)` 与 `retryable/diagnosis` 两项
 * ⇒ `retryable: true` 写死、诊断投递点消失（`getJSON`／`sourceSnapshot` 仍在传 ⇒ `TS2353`）。
 * **判据（Lead 逐字）：把那两行切掉 ⇒ 本文件必须红。**
 *
 * 所以断言只钉**用户能看到的报文**（哪个分支、哪几条事实、可否重试），不钉函数签名。
 *
 * ## 与变体 A 的关系
 *
 * 变体 A 下 429 在**产品路径**上被 `githubStatusRetryOverride` 当场带走（1 次即返回）
 * ⇒ 本出口在产品路径上**不可达**（已登记）。本文件在**接缝层**钉住它 —— 用与 `sourceSnapshot`
 * **同一段组成**的分类器（`githubRateLimited` → `githubRateLimitDiagnosis`），
 * 只把 URL 换成**非** `api.github.com`（host 守卫为假）好让 429 真的重试到耗尽。
 *
 * ## 边界
 *
 * 全部替身 `fetch`：**0 次真实网络、0 真实配额、不打 GitHub**；凭据显式传 `null` = 匿名口径。
 * 诊断正文一律**现算**再比对，**不抄写文** —— 措辞演进时红的应是"不再同源"，不是"抄的那份过期了"。
 *
 * ## ⚠️ 同一条报文里已登记的自相矛盾（**本文件不钉它**，见回执 §未覆盖）
 *
 * 证据在场时，`重试判定` 那一行仍写死「（本应答**没有**限流证据 ⇒ 限流覆盖未生效）」
 * —— 与同一段报文里的 `remaining=0`／`重置于 …` **直接相反**。
 * 成因是 `source.ts` 里 `retryLine` 的第三支没有按 `evidenced` 分岔。**不在这里断言它**：
 * 钉住错的句子（`toContain`）＝把缺陷固化成判据；断言它不出现＝本文件当场变红（那是**新缺陷**，
 * 不是"恢复被切掉的接线"）。⇒ 已单列进回执等 Lead 裁定，本文件只钉**今天为真**的事实。
 */
import { describe, expect, test } from 'bun:test'
import {
  boundedFetch, githubRateLimitDiagnosis, githubRateLimited, PolicyFetchError, POLICY_FETCH_ATTEMPTS,
} from '../src/source.ts'

/**
 * 接缝地址：`upstream.invalid` **不是** `api.github.com` ⇒ `githubRateLimitNoRetry` 的 host 守卫为假
 * ⇒ 429 不被"限流覆盖"当场带走 ⇒ 按既有瞬时语义重试到 `POLICY_FETCH_ATTEMPTS` 次后走耗尽出口。
 */
const UPSTREAM = 'https://upstream.invalid/repos/unitreerobotics/unitree_rl_gym/commits/main'

/** 30 分钟后重置：`约 30 分钟后` 这句在整整一分钟内不会因毫秒级漂移换数。 */
const RESET_IN_SECONDS = 1800
const headers = () => ({
  'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-used': '60',
  'x-ratelimit-resource': 'core',
  'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + RESET_IN_SECONDS),
})

/** 与 `sourceSnapshot` 里那个分类器**同一段组成**（见 `source.ts` 的 github 分支）。 */
const classifierWith = (now: number) => (response: Response, url: string, attempts: number) =>
  githubRateLimited(response.status, response.headers)
    ? { retryable: false, diagnosis: githubRateLimitDiagnosis(response.status, response.headers, url, null, now, 'fetch', attempts) }
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

describe('耗尽出口 · 证据在场（429 + x-ratelimit-*）：接线被切掉 ⇒ 本文件必须红', () => {
  test('429 带限流证据、重试到耗尽 ⇒ 报文给出**证据那一支**的诊断（读数 + 重置时刻 + 处置建议），且不再说成瞬时故障', async () => {
    let now = 0
    const stub = stubFetch(call => {
      call.status = 429
      return new Response('denied', { status: 429, headers: headers() })
    })
    try {
      const options = {
        step: '解析 source' as const,
        classifyExhausted: (r: Response, u: string, a: number) => classifierWith(now)(r, u, a),
      }
      now = Date.now()
      const error = await boundedFetch(UPSTREAM, {}, options).then(() => null, (reason: Error) => reason)
      const text = String(error)

      // ① 传输层：没有覆盖 ⇒ 429 仍按既有瞬时语义重试到耗尽（这正是这条出口存在的理由）
      expect(stub.calls.length).toBe(POLICY_FETCH_ATTEMPTS)
      expect(error).toBeInstanceOf(PolicyFetchError)

      // ② 五要素仍在：诊断是**附在**五要素之后，不是替换
      expect(text).toContain(`（${POLICY_FETCH_ATTEMPTS}/${POLICY_FETCH_ATTEMPTS} 次尝试后放弃`)
      expect(text).toContain('每次尝试')
      expect(text).toContain('上游应答的诊断')      // ← 接线被切断时**这一条**先红

      // ③ ★被切掉的那条出口★：分类器的诊断必须送达用户
      expect(text).toContain('POLICY_GITHUB_RATE_LIMITED')
      expect(text).toContain('限流')
      // 证据在场 ⇒ 走"已用尽"那一支，且**必须**给出可读的配额读数与重置时刻
      expect(text).toContain('配额（限流）已用尽')
      expect(text).toContain('配额读数：resource=core')
      expect(text).toContain('remaining=0')
      expect(text).toContain('重置于 ')
      expect(text).toContain('处置建议：把 GitHub PAT 放进')

      // ④ 分类器的第三个参数 = **实际试过的次数**（只有 `boundedFetch` 知道）
      expect(text).toContain(`先试了 ${POLICY_FETCH_ATTEMPTS} 次`)

      // ⑤ 不许再把限流说成瞬时故障（改前这里正是 `可否重试：true（瞬时网络故障…）`）
      expect(text).not.toContain('可否重试：true')
      expect(text).toContain('可否重试：false（不是瞬时故障：按上面的诊断处置，**别重跑同一条命令**）')

      // ⑥ 同源：注入的这段文字**逐字等于**现算的同名诊断（两条投递路径不可能分叉）
      const direct = githubRateLimitDiagnosis(429, new Headers(headers()), UPSTREAM, null, now, 'fetch', POLICY_FETCH_ATTEMPTS)
      expect(direct).toContain('配额（限流）已用尽')
      expect(text).toContain(direct.split('\n').map(line => `  ${line}`).join('\n'))
    } finally { stub.restore() }
  })

  test('对照·仍然不许把"带证据"说成"算不出重置时刻"：两支的标题互斥（只钉今天为真的那半边）', async () => {
    let now = 0
    const stub = stubFetch(call => {
      call.status = 429
      return new Response('denied', { status: 429, headers: headers() })
    })
    try {
      now = Date.now()
      const error = await boundedFetch(UPSTREAM, {}, {
        step: '解析 source',
        classifyExhausted: (r: Response, u: string, a: number) => classifierWith(now)(r, u, a),
      }).then(() => null, (reason: Error) => reason)
      const text = String(error)

      // 证据在场 ⇒ 不许出现"没有证据"那一支专属的**重置指引**句式
      // （`hasRateLimitEvidence` 为真时 `githubRateLimitDiagnosis` 不产生这一行）。
      expect(text).not.toContain('重置指引：上游没给重置时刻')
      // 而且必须真的把算出来的时刻印出来
      expect(text).toContain('重置于 ')
    } finally { stub.restore() }
  })
})
