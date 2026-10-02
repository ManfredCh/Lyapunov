/** 与旧通知导航一致的保留边界；只存来源标记，不复制Session正文。 */
export const NOTIFICATION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_NOTIFICATION_MARKERS = 500
export interface NotificationMarker { seq: number; sessionId: string; kind: 'completed' | 'error'; time: number }
export interface NotificationReading { notificationCounter: number; notificationMarkers: NotificationMarker[]; notificationReads: Record<string, number> }
export function retainNotificationMarkers(markers: readonly NotificationMarker[], now: number): NotificationMarker[] { return markers.filter(marker => marker.time >= now - NOTIFICATION_TTL_MS).slice(-MAX_NOTIFICATION_MARKERS) }
export function unreadNotificationMarkers(reading: NotificationReading, sessionId: string, now = Date.now()): NotificationMarker[] {
 return retainNotificationMarkers(reading.notificationMarkers, now).filter(marker => marker.sessionId === sessionId && marker.seq > (reading.notificationReads[sessionId] ?? 0))
}
export function latestNotificationSequence(reading: NotificationReading, sessionId: string): number { return reading.notificationMarkers.reduce((seq, marker) => marker.sessionId === sessionId ? Math.max(seq, marker.seq) : seq, 0) }
/** 与旧unseen导航相同：项目内循环，完成或错误任一未读即可进入。 */
export function neighboringUnreadSession(ids: readonly string[], current: string | undefined, direction: -1 | 1, reading: NotificationReading, now = Date.now()): string | undefined {
 if (!ids.length) return undefined
 const active = current === undefined ? -1 : ids.indexOf(current), start = active === -1 ? (direction > 0 ? -1 : 0) : active
 for (let offset = 1; offset <= ids.length; offset++) {
  const id = ids[(start + direction * offset + ids.length) % ids.length]!
  if (unreadNotificationMarkers(reading, id, now).length) return id
 }
 return undefined
}
