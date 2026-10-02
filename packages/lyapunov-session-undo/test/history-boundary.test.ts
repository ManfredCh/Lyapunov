/**
 * 撤销边界的回归：原生 `Session.checkout` 只接受**稳定边界**（前缀里没有未闭合的
 * turn／step／compaction）。真机复现过一条失败路径——用户在**回合进行中**发消息
 * （`agent/inbox/spliced` → 本回合内被接纳），此时 `user.seq - 1` 落在 `step/start` 上，
 * 原生 checkout 报 `history checkout requires a stable boundary outside turn, step and compaction`，
 * 整次撤销失败（文件一个字节都没回退）。`stableHistoryBoundary()` 用同一台状态机退到最近的稳定边界。
 *
 * 事件表按真机日志的形状构造（不是伪造 id：只保留判定用得到的 type/seq）。
 */
import { describe, expect, test } from 'bun:test'
import { stableHistoryBoundary } from '../src/controller.ts'

type Event = { type: string; seq: number }
const events = (...pairs: [number, string][]): Event[] => pairs.map(([seq, type]) => ({ seq, type }))
/** 真机失败现场的事件尾部（session-0d96903b… 的 seq 188–200）。 */
const liveFailureTail = events(
  [188, 'worktree/checkpoint'], [189, 'step/start'], [190, 'user/message'], [191, 'step/end'],
  [192, 'turn/end'], [193, 'worktree/checkpoint'], [194, 'agent/inbox/spliced'], [195, 'turn/start'],
  [196, 'worktree/checkpoint'], [197, 'worktree/checkpoint'], [198, 'worktree/checkpoint'],
  [199, 'step/start'], [200, 'user/message'],
)

describe('stableHistoryBoundary：把撤销目标退到原生接受的位置', () => {
  test('回合外的普通用户消息：边界就是它前面那一条（不后退）', () => {
    const tail = events([90, 'turn/end'], [91, 'session/title'], [92, 'user/message'])
    expect(stableHistoryBoundary(tail, 91)).toBe(91)
    // 幂等：已经是稳定边界时不动。
    expect(stableHistoryBoundary(tail, stableHistoryBoundary(tail, 91))).toBe(91)
  })

  test('真机失败现场：回合内部被接纳的用户消息 → 退到 turn/start 之前的稳定边界', () => {
    // 直接取 user.seq - 1 = 199（step/start）是原生拒绝的那一个；退到 194 才是稳定边界。
    expect(stableHistoryBoundary(liveFailureTail, 199)).toBe(194)
    expect(stableHistoryBoundary(liveFailureTail, 200)).toBe(194)
    // 回合结束后（step/end、turn/end 已落）又回到稳定。
    const afterTurn = [...liveFailureTail, { seq: 201, type: 'step/end' }, { seq: 202, type: 'turn/end' }]
    expect(stableHistoryBoundary(afterTurn, 202)).toBe(202)
  })

  test('compaction 未闭合同样不是稳定边界；session/end-seed 关闭它', () => {
    const compacting = events([1, 'compaction/start'], [2, 'user/message'], [3, 'assistant/message'])
    expect(stableHistoryBoundary(compacting, 3)).toBe(-1)
    const closed = [...compacting, { seq: 4, type: 'compaction/end' }]
    expect(stableHistoryBoundary(closed, 4)).toBe(4)
    const seedClosed = [...compacting, { seq: 4, type: 'session/end-seed' }]
    expect(stableHistoryBoundary(seedClosed, 4)).toBe(4)
  })

  test('日志开头就在开放回合里 → -1（原生允许的边界），空日志同样是 -1', () => {
    expect(stableHistoryBoundary(events([0, 'turn/start'], [1, 'step/start'], [2, 'user/message']), 2)).toBe(-1)
    expect(stableHistoryBoundary([], 5)).toBe(-1)
  })

  test('只读重放：不修改传入的事件表', () => {
    const snapshot = JSON.stringify(liveFailureTail)
    stableHistoryBoundary(liveFailureTail, 200)
    expect(JSON.stringify(liveFailureTail)).toBe(snapshot)
  })
})
