import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { selectActiveHistoryEvents } from '@deepseek-ai/dsh-session/surface'
import { historyLines } from './format.ts'

export interface TerminalHistoryOptions {
  /** 每页可见历史事件数，默认 100；不按换行数拆分一条消息。 */
  readonly limit?: number
  /** 严格早于此原生日志 seq，不包含游标事件。 */
  readonly beforeSeq?: number
  /** 显式显示游标之前的全部可见事件；不使用 limit。 */
  readonly all?: boolean
}

export interface TerminalHistoryEntry {
  readonly seq: number
  readonly text: string
}

export interface TerminalHistoryPage {
  /** 本页始终按原生日志顺序呈现，从旧到新。 */
  readonly entries: readonly TerminalHistoryEntry[]
  readonly hasMore: boolean
  /** 有更早历史时，把此值作为下一页的 beforeSeq。 */
  readonly nextBeforeSeq?: number
}

/** 只分页现有人类历史投影；不改日志、模型 surface 或 Session 状态。 */
export function historyPage(events: readonly SessionEvent[], options: TerminalHistoryOptions = {}): TerminalHistoryPage {
  const limit = options.limit ?? 100
  if (!options.all && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('HISTORY_LIMIT_INVALID: 每页数量必须为正整数。')
  if (options.beforeSeq !== undefined && (!Number.isSafeInteger(options.beforeSeq) || options.beforeSeq < 0)) throw new Error('HISTORY_CURSOR_INVALID: beforeSeq 必须为非负整数。')
  // 复用同一个格式化/append-origin边界，避免分页和完整历史出现不同归因。
  const active = selectActiveHistoryEvents(events)
  const activeSeqs = new Set(active.map(event => Number(event.seq)))
  const runs = new Map(events.flatMap(event => event.type === 'command/run' ? [[event.data.commandId, event.seq] as const] : []))
  const hasCheckout = events.some(event => event.type === 'session/history-checkout')
  const visible = active.flatMap(event => {
    if (options.beforeSeq !== undefined && event.seq >= options.beforeSeq) return []
    if (hasCheckout && event.type === 'command/done') {
      const start = runs.get(event.data.commandId)
      if (start === undefined || !activeSeqs.has(start)) return []
    }
    return historyLines([event]).map(text => ({ seq: event.seq, text }))
  })
  const entries = options.all ? visible : visible.slice(-limit)
  const hasMore = entries.length < visible.length
  return { entries, hasMore, ...(hasMore ? { nextBeforeSeq: entries[0]!.seq } : {}) }
}
