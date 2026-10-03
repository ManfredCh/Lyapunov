/**
 * ⚠️ 这是**静态单元级依据**，只覆盖 `preferences-notification-*.ts` 这两个纯函数的契约
 * （重复读不增标记、读不产生动作类副作用）。它**不能**充当 DEV-035 的**真机证据**——
 * "后台完成通知不重发动作"的真机验收仍需真实模型回合 + 页面/工具调用清单前后对照
 * （见 `bugfixHistory/DEV035-LOOP-20260922.md` §2/§8）。
 *
 * 依据：`preferences-notification-state.ts` 的导出全是纯读函数（retain/unread/latest/neighboring），
 * `preferences-notification-host.ts` 只做 Settings 读写；两个文件里 `action|execute|command|job`
 * 出现次数为 **0**（grep 实测）。本用例把"读"与"产生动作"在类型/行为两层上钉住。
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_NOTIFICATION_MARKERS,
  NOTIFICATION_TTL_MS,
  latestNotificationSequence,
  neighboringUnreadSession,
  retainNotificationMarkers,
  unreadNotificationMarkers,
  type NotificationReading,
} from '../src/preferences-notification-state.ts'

const src = (name: string) => readFileSync(join(import.meta.dirname, '../src', name), 'utf8')

const reading = (): NotificationReading => ({
  notificationCounter: 2,
  notificationMarkers: [
    { seq: 1, sessionId: 'session-a', kind: 'completed', time: 1_790_000_000_000 },
    { seq: 2, sessionId: 'session-b', kind: 'error', time: 1_790_000_100_000 },
  ],
  notificationReads: {},
})

test('重复读不增加标记、不改动读数（顺序 20 轮 + 并发 8 次后逐字段相等；已读计数单调不减）', async () => {
  const before = reading()
  const snapshot = JSON.stringify(before)
  for (let i = 0; i < 20; i++) {
    unreadNotificationMarkers(before, 'session-a', before.notificationMarkers[0]!.time)
    unreadNotificationMarkers(before, 'session-b', before.notificationMarkers[1]!.time)
    latestNotificationSequence(before, 'session-a')
    neighboringUnreadSession(['session-a', 'session-b'], 'session-a', 1, before)
    neighboringUnreadSession(['session-a', 'session-b'], 'session-a', -1, before)
  }
  // 并发式重复读（同一批调用一起发）也必须不改动读数
  await Promise.all(Array.from({ length: 8 }, async () => { unreadNotificationMarkers(before, 'session-a', 0); latestNotificationSequence(before, 'session-b') }))
  expect(JSON.stringify(before)).toBe(snapshot)
  // 已读计数单调不减：带读数的 reading 读多次后不会变小
  const withReads: NotificationReading = { ...before, notificationReads: { 'session-a': 3 } }
  for (let i = 0; i < 5; i++) unreadNotificationMarkers(withReads, 'session-a', 0)
  expect(withReads.notificationReads['session-a']).toBeGreaterThanOrEqual(3)
  expect(before.notificationMarkers).toHaveLength(2)
  expect(before.notificationCounter).toBe(2)
  expect(before.notificationReads).toEqual({})
})

test('保留策略是纯过滤：返回新数组、不放大、不就地改写输入', () => {
  const now = 1_790_000_200_000
  const markers = [
    { seq: 1, sessionId: 's', kind: 'completed' as const, time: now - NOTIFICATION_TTL_MS - 1 }, // 过期
    { seq: 2, sessionId: 's', kind: 'error' as const, time: now },
  ]
  const frozen = JSON.stringify(markers)
  const kept = retainNotificationMarkers(markers, now)
  expect(kept).not.toBe(markers)
  expect(kept.map(m => m.seq)).toEqual([2])
  expect(JSON.stringify(markers)).toBe(frozen)
  expect(kept.length).toBeLessThanOrEqual(markers.length)
  expect(kept.length).toBeLessThanOrEqual(MAX_NOTIFICATION_MARKERS)
})

test('导出面/实现里没有动作类入口（读通知不会重发动作）', () => {
  const state = src('preferences-notification-state.ts')
  const host = src('preferences-notification-host.ts')
  for (const text of [state, host]) expect(text).not.toMatch(/\b(action|execute|dispatch|replay|resend|sim_|robot_)\b/)
  // 状态模块只导出常量/类型 + 四个纯读函数
  const exported = [...state.matchAll(/export (?:const|function) (\w+)/g)].map(m => m[1]).sort()
  expect(exported).toEqual(['MAX_NOTIFICATION_MARKERS', 'NOTIFICATION_TTL_MS', 'latestNotificationSequence', 'neighboringUnreadSession', 'retainNotificationMarkers', 'unreadNotificationMarkers'])
})
