import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-settings'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { PREFERENCES_NAMESPACE, type Preferences } from './preferences.ts'
import { retainNotificationMarkers, type NotificationMarker } from './preferences-notification-state.ts'

/** 从原生Agent事件保存最小标记；通知开关不改变未读事实。 */
export function applyPreferenceNotificationMarkers(ctx: Context) {
 let queue = Promise.resolve(), disposed = false
 const running = new Set<string>()
 const append = (sessionId: string, kind: NotificationMarker['kind']) => {
  const time = Date.now()
  queue = queue.then(async () => {
   for (;;) {
    const descriptor = ctx.settings.describe().find(item => item.ns === PREFERENCES_NAMESPACE)
    // Agent teardown may finish one queued lifecycle callback after the
    // settings owner has already unloaded. That late event has no writable
    // namespace and must be ignored rather than turning cleanup into an
    // unhandled TypeError.
    if (!descriptor) return
    const value = descriptor.value as Preferences
    const seq = value.notificationCounter + 1, markers = retainNotificationMarkers([...value.notificationMarkers, { seq, sessionId, kind, time }], time)
    const live = new Set(markers.map(marker => marker.sessionId)), reads = Object.fromEntries(Object.entries(value.notificationReads).filter(([id]) => live.has(id)))
    try {
     await ctx.settings.mutate(PREFERENCES_NAMESPACE, [{ op: 'set', path: ['notificationCounter'], value: seq }, { op: 'set', path: ['notificationMarkers'], value: markers }, { op: 'set', path: ['notificationReads'], value: reads }], descriptor.revision)
     return
    } catch (error) { if (!(error instanceof SettingsConflictError)) throw error }
   }
  }).catch(error => { console.error('通知阅读标记保存失败:', error) })
 }
 ctx.on('agent/status', ({ agent, status }) => {
  if (disposed || agent.session.header.origin === 'subagent') return
  if (status === 'running') running.add(agent.id)
  else if (running.delete(agent.id)) append(agent.id, 'completed')
 })
 ctx.on('agent/error', ({ agent }) => {
  if (disposed || agent.session.header.origin === 'subagent') return
  // error 与 completed 是同一次生命周期的互斥终态；先移除 running，
  // 避免随后正常回到 idle 时重复写入“已完成”标记。
  running.delete(agent.id)
  append(agent.id, 'error')
 })
 ctx.effect(() => async () => { disposed = true; running.clear(); await queue })
}
