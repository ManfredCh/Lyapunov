/**
 * 负对照 · 分享取件的**有界超时 / 取消原样传播 / 诊断不泄漏**
 *
 * 收编自 `.runtime/lane-p8fix/scripts/negative-control.ts`（R-fix#7），按 `nc-lib.ts` 的统一口径重写：
 * 去掉对 `.runtime/**` 的依赖（原脚本把备份与日志写在 `.runtime/lane-p8fix/`），只读库内文件即可复算。
 *
 * 目标（交付版，跑前逐个打印 sha256）：
 *   - `packages/lyapunov-share/src/fetch.ts`
 *   - `packages/lyapunov-share/src/operations.ts`
 * 用例（**一个字不动**）：`packages/lyapunov-share/test/operations-bounded-fetch.test.ts`
 *
 * 跑法：`bun script/negative-controls/nc-share-bounded-fetch.ts`
 *
 * ⚠️ 变异窗口内**产品文件是改过的**，跑完（含中断）逐字节还原。跑之前请确认没有别的 lane 正在写这三个文件。
 */
import { runNegativeControl, type Mutation, type Target } from './nc-lib.ts'

const SRC_FETCH = 'packages/lyapunov-share/src/fetch.ts'
const SRC_OPERATIONS = 'packages/lyapunov-share/src/operations.ts'
const TEST = 'packages/lyapunov-share/test/operations-bounded-fetch.test.ts'

const TARGETS: Target[] = [
  { file: SRC_FETCH, test: TEST },
  { file: SRC_OPERATIONS, test: TEST },
]

// `expect` 的片段**逐个点名该变红的那条用例**；`expectCount` = 该变异**应当**变红的用例条数。
// 这两个数都是**实测后冻结**的（`expectCount` 取自 2026-09-27 03:4x 的实测，见 README 的收编登记表），
// 不是"跑到几条算几条"：多红一条或少红一条都说明记忆里那条不变式已经变了，必须人看。
const MUTATIONS: readonly Mutation[] = [
  {
    name: 'N1 取消守卫整个失效（throwIfCancelled 空实现）',
    file: SRC_OPERATIONS,
    from: "const throwIfCancelled=(signal:AbortSignal)=>{if(signal.aborted)throw signal.reason??new Error('SHARE_CANCELLED')}",
    to: 'const throwIfCancelled=(_signal:AbortSignal)=>{}',
    expect: ['identity() 三种时机取消', 'request() 联网中 / 读正文中取消', '取消 ⇒ **404**'],
    expectCount: 3,
  },
  {
    name: 'N1b 只摘掉 identity() 里那一处取消守卫（P8 的原始回归点）',
    file: SRC_OPERATIONS,
    from: 'catch(error){\n   throwIfCancelled(signal)\n   if(isShareFetchError(error))throw error',
    to: 'catch(error){\n   if(isShareFetchError(error))throw error',
    expect: ['identity() 三种时机取消', '取消 ⇒ **404**'],
    expectCount: 2,
  },
  {
    name: 'N2 5xx/429 不再算瞬时（还原"一次即失败 + 可否重试：false"）',
    file: SRC_FETCH,
    from: 'export function isTransientShareStatus(status: number): boolean { return TRANSIENT_STATUS.has(status) }',
    to: 'export function isTransientShareStatus(status: number): boolean { return false }',
    expect: [
      '同一 503/429/504：request() 与 identity() 都 fetch 3 次',
      '5xx 在分享管理接口上**不再**被读成',
      '5xx 的 JSON 正文：重试到上界抛五要素错误',
      '预览不存在 ⇒ 404；上游 5xx',
      '上游 5xx/429 连答 3 次 ⇒ **503**',
      '上游 503 且诊断消息里出现 `ACCOUNT`',
    ],
    expectCount: 6,
  },
  {
    name: 'N3 落盘诊断忽略调用点传入的 url（还原 url:""）',
    file: SRC_OPERATIONS,
    from: "url:isShareFetchError(error)?error.url:(input.url??''),",
    to: "url:isShareFetchError(error)?error.url:'',",
    expect: ['403 ⇒ url 是上游 URL', '应答读不完（SHARE_FETCH_STALL）', '应答不是 JSON ⇒ url + 一条应答阶段的 attempts'],
    expectCount: 3,
  },
  {
    name: 'N3b 落盘诊断忽略调用点传入的 attempts',
    file: SRC_OPERATIONS,
    from: 'attempts:isShareFetchError(error)?[...error.attempts]:[...(input.attempts??[])]}',
    to: 'attempts:isShareFetchError(error)?[...error.attempts]:[]}',
    expect: ['403 ⇒ url 是上游 URL', '应答读不完（SHARE_FETCH_STALL）', '应答不是 JSON ⇒ url + 一条应答阶段的 attempts'],
    expectCount: 3,
  },
  {
    name: 'N4 尝试上限不可解除（还原 P8 的 AbortSignal.timeout：正文也被掐断）',
    file: SRC_FETCH,
    from: 'return { signal: controller.signal, clear: () => clearTimeout(timer) }',
    to: 'return { signal: controller.signal, clear: () => {} }',
    expect: ['应答头已到、正文在停摆窗口内持续到达'],
    expectCount: 1,
  },
  {
    name: 'N5 凭据泄漏：把请求头拼进每次尝试的原因',
    file: SRC_FETCH,
    from: 'record(describeError(error), retryable, attempt, Date.now() - started)',
    to: "record(describeError(error) + ' headers=' + JSON.stringify(rest.headers ?? {}), retryable, attempt, Date.now() - started)",
    expect: ['凭据不进错误与诊断：请求里真带上凭据'],
    expectCount: 1,
  },
  {
    name: 'N6 正文泄漏：把上游应答正文拼进错误消息',
    file: SRC_OPERATIONS,
    from: "先修正账户/服务地址/入参再试）'",
    to: "先修正账户/服务地址/入参再试）' + '\\n  上游正文：' + text.slice(0, 200)",
    expect: ['4xx 的 JSON 正文：只留上游 error 码'],
    expectCount: 1,
  },
]

const ok = runNegativeControl('nc-share-bounded-fetch', TARGETS, MUTATIONS)
process.exit(ok ? 0 : 1)
