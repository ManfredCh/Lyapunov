/**
 * 负对照 · `preview-route` 的失败状态码映射（形状在前、码在后、顺序不可颠倒）
 *
 * **收编时重新锚定过**：原脚本 `.runtime/lane-p8fix5xx/scripts/negative-control.ts` 的锚点是
 *   `    const status=isShareFetchError(error)&&error.retryable?503:/AUTH|ACCOUNT/.test(code)?401:…`
 * —— 那行**今天在交付版里命中 0 次**（该文件后来被重写成 `previewFailureStatus()` 函数，非瞬时改为 502）。
 * 原脚本遇到这种情况会 `throw` 拒绝跑（fail-closed，行为正确）；本文件按**今天的交付版**重新取锚点。
 * ⇒ 这一条正好是"负对照会随交付版腐烂、必须重新锚定"的实例，登记在 README 的收编表里。
 *
 * 目标：`packages/lyapunov-share/src/preview-route.ts`
 * 用例（**一个字不动**）：`packages/lyapunov-share/test/operations-bounded-fetch.test.ts`
 *
 * 跑法：`bun script/negative-controls/nc-share-preview-status.ts`
 */
import { runNegativeControl, type Mutation, type Target } from './nc-lib.ts'

const SRC = 'packages/lyapunov-share/src/preview-route.ts'
const TEST = 'packages/lyapunov-share/test/operations-bounded-fetch.test.ts'

const TARGETS: Target[] = [{ file: SRC, test: TEST }]

/** 交付版的那一行（先断言它**恰好命中 1**：锚点腐烂时这里就会拒绝执行，而不是静默 no-op）。 */
const DELIVERED =
  'const previewFailureStatus=(error:unknown):number=>isShareFetchError(error)?(error.retryable?503:502):(PREVIEW_STATUS.get(errorCode(error))??404)'

const MUTATIONS: readonly Mutation[] = [
  {
    name: 'P1 还原改前行为：整条"形状"分支摘掉（只按错误码映射）',
    file: SRC,
    from: DELIVERED,
    to: 'const previewFailureStatus=(error:unknown):number=>(PREVIEW_STATUS.get(errorCode(error))??404)',
    expect: [
      '上游 5xx/429 连答 3 次 ⇒ **503**',
      '上游连不上（socket 被断 / 超时）同属**瞬时**取件失败',
      '上游 503 且诊断消息里出现 `ACCOUNT`',
      '兜底分支：形状丢了但码还在',
    ],
    expectCount: 4,
  },
  {
    name: 'P2 过度放宽：非瞬时（retryable===false）也回 503，把 502 吞掉',
    file: SRC,
    from: DELIVERED,
    to: 'const previewFailureStatus=(error:unknown):number=>isShareFetchError(error)?(error.retryable?503:503):(PREVIEW_STATUS.get(errorCode(error))??404)',
    expect: ['非瞬时取件失败（`retryable===false`'],
    expectCount: 1,
  },
  {
    name: 'P3 还原原始缺陷：按**消息文本**搜 AUTH|ACCOUNT 抢在形状之前',
    file: SRC,
    from: DELIVERED,
    to:
      "const previewFailureStatus=(error:unknown):number=>/AUTH|ACCOUNT/.test(error instanceof Error?error.message:String(error))?401:(isShareFetchError(error)?(error.retryable?503:502):(PREVIEW_STATUS.get(errorCode(error))??404))",
    expect: [
      '上游 503 且诊断消息里出现 `ACCOUNT`',
      '上游 200 但正文不是 JSON',
      '上游 200 非 JSON 且诊断消息里出现 `ACCOUNT`',
      '本地配置错（账户 API 非 https 且非 loopback）',
    ],
    expectCount: 4,
  },
]

const ok = runNegativeControl('nc-share-preview-status', TARGETS, MUTATIONS)
process.exit(ok ? 0 : 1)
