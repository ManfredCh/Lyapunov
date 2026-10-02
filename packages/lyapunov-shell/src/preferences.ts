export const PREFERENCES_NAMESPACE = 'lyapunov-preferences'
export const LEGACY_PREFERENCES_NAMESPACE = 'lyaup-preferences'
export const shortcutActions = ['newSession', 'sidebar', 'previousSession', 'nextSession', 'previousCompleted', 'nextCompleted', 'archiveSession', 'projectOpen', 'projectPrevious', 'projectNext', 'themeCycle', 'languageCycle', 'modelChoose', 'modelReasoningCycle', 'agentNext', 'agentPrevious', 'permissionChoose', 'commandMenu', 'stopSession'] as const
export type ShortcutAction = typeof shortcutActions[number]
export type NotificationKind = 'agent' | 'permissions' | 'errors'
export interface Preferences extends NotificationReading {
  agent: boolean
  permissions: boolean
  errors: boolean
  agentSound: boolean
  permissionsSound: boolean
  errorsSound: boolean
  agentSoundId: PreferenceSoundId
  permissionsSoundId: PreferenceSoundId
  errorsSoundId: PreferenceSoundId
  backgroundOnly: boolean
  themePalette: string
  shortcuts: Record<ShortcutAction, string>
}
export const defaultPreferences: Preferences = {
  agent: true, permissions: true, errors: false,
  agentSound: true, permissionsSound: true, errorsSound: true,
  agentSoundId: 'staplebops-01', permissionsSoundId: 'staplebops-02', errorsSoundId: 'nope-03',
  backgroundOnly: true,
  themePalette: 'native', notificationCounter: 0, notificationMarkers: [], notificationReads: {},
  shortcuts: { newSession: 'mod+shift+s', sidebar: 'mod+b', previousSession: 'alt+arrowup', nextSession: 'alt+arrowdown', previousCompleted: 'alt+shift+arrowup', nextCompleted: 'alt+shift+arrowdown', archiveSession: 'mod+shift+backspace', projectOpen: 'mod+o', projectPrevious: 'mod+alt+arrowup', projectNext: 'mod+alt+arrowdown', themeCycle: 'mod+shift+t', languageCycle: '', modelChoose: 'mod+quote', modelReasoningCycle: 'mod+shift+d', agentNext: 'mod+period', agentPrevious: 'mod+shift+period', permissionChoose: 'mod+shift+a', commandMenu: 'mod+shift+p', stopSession: 'mod+shift+x' },
}
export interface ShortcutKey {
  key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean
  isComposing?: boolean; repeat?: boolean; defaultPrevented?: boolean
}
/** 仅支持本文件列明的现有产品动作的一次组合键；空字符串表示禁用。 */
export function normalizeShortcut(value: string): string {
  if (!value.trim()) return ''
  const parts = value.toLowerCase().split('+').map(part => part.trim())
  const key = parts.pop()!, modifiers = new Set(parts)
  if (!/^(?:[a-z0-9]|arrowup|arrowdown|arrowleft|arrowright|backspace|quote|period|comma|f(?:[1-9]|1[0-2]))$/.test(key)
    || parts.length !== modifiers.size || parts.some(part => !['mod', 'ctrl', 'alt', 'shift', 'meta'].includes(part))
    || !(modifiers.has('mod') || modifiers.has('ctrl') || modifiers.has('meta') || modifiers.has('alt'))
    || modifiers.has('mod') && (modifiers.has('ctrl') || modifiers.has('meta'))) throw new Error('请使用 Ctrl/Cmd/Alt 加字母、数字、方向键、Backspace、quote、period、comma 或 F1—F12。')
  return ['mod', 'ctrl', 'meta', 'alt', 'shift'].filter(part => modifiers.has(part)).concat(key).join('+')
}
export function matchShortcut(event: ShortcutKey, shortcut: string, mac: boolean): boolean {
  if (!shortcut || event.isComposing || event.repeat || event.defaultPrevented) return false
  const parts = normalizeShortcut(shortcut).split('+'), key = parts.pop()!
  const expected = { ctrlKey: parts.includes('ctrl') || parts.includes('mod') && !mac, metaKey: parts.includes('meta') || parts.includes('mod') && mac, shiftKey: parts.includes('shift'), altKey: parts.includes('alt') }
  const actualKey = /^Key[A-Z]$/.test(event.code ?? '') ? event.code!.slice(3).toLowerCase() : /^Digit[0-9]$/.test(event.code ?? '') ? event.code!.slice(5) : ['Quote', 'Period', 'Comma'].includes(event.code ?? '') ? event.code!.toLowerCase() : ({ "'": 'quote', '.': 'period', ',': 'comma' } as Record<string, string>)[event.key] ?? event.key.toLowerCase()
  return actualKey === key && (Object.keys(expected) as Array<keyof typeof expected>).every(part => event[part] === expected[part])
}
export function validateShortcuts(value: Record<ShortcutAction, string>): Record<ShortcutAction, string> {
  const normalized = Object.fromEntries(shortcutActions.map(action => [action, normalizeShortcut(value[action])])) as Record<ShortcutAction, string>
  for (const mac of [false, true]) {
    const assigned = Object.values(normalized).filter(Boolean).map(key => key.replace('mod', mac ? 'meta' : 'ctrl'))
    if (new Set(assigned).size !== assigned.length) throw new Error('两个动作不能使用同一快捷键。')
    if (assigned.includes(mac ? 'meta+comma' : 'ctrl+comma')) throw new Error('Ctrl/Cmd+逗号保留给原生设置窗口。')
  }
  return normalized
}
export function shouldNotify(preferences: Preferences, kind: NotificationKind, current: boolean, focused: boolean): boolean {
  return (!preferences.backgroundOnly || !current || !focused) && (preferences[kind] || preferences[`${kind}Sound`])
}
import type { PreferenceSoundId } from './preferences-sounds.ts'
import type { NotificationReading } from './preferences-notification-state.ts'
