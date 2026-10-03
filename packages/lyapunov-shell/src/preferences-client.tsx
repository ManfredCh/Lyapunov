import { useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { defaultPreferences, matchShortcut, PREFERENCES_NAMESPACE, shortcutActions, shouldNotify, validateShortcuts, type NotificationKind, type Preferences, type ShortcutAction } from './preferences.ts'
import { executePreferenceShortcut } from './preferences-actions.ts'
import { soundOptions } from './preferences-sounds.ts'
import { applyPreferenceThemes } from './preferences-themes.tsx'
import { latestNotificationSequence, unreadNotificationMarkers } from './preferences-notification-state.ts'

type Notice = { id: number; sessionId: string; title: string; body: string }
type Surface = {
  scope: SettingsScope<Preferences>
  tr(zh: string, en: string): string
  subscribe(listener: () => void): () => void
  notices(): readonly Notice[]
  dismiss(id: number): void
  open(sessionId: string): void
  sound(kind: NotificationKind): Promise<void>
}
const labels: Record<NotificationKind, [string, string]> = { agent: ['会话运行结束', 'Session finished'], permissions: ['需要审批', 'Approval needed'], errors: ['运行错误', 'Session error'] }
const actionLabels: Record<ShortcutAction, [string, string]> = { newSession: ['新建会话', 'New session'], sidebar: ['展开或收起侧栏', 'Toggle sidebar'], previousSession: ['上一个会话', 'Previous session'], nextSession: ['下一个会话', 'Next session'], previousCompleted: ['上一个未读会话', 'Previous unread session'], nextCompleted: ['下一个未读会话', 'Next unread session'], archiveSession: ['归档当前会话', 'Archive current session'], projectOpen: ['打开项目目录', 'Open project directory'], projectPrevious: ['上一个项目', 'Previous project'], projectNext: ['下一个项目', 'Next project'], themeCycle: ['切换主题配色', 'Cycle theme palette'], languageCycle: ['切换界面语言', 'Cycle UI language'], modelChoose: ['选择模型', 'Choose model'], modelReasoningCycle: ['切换模型推理强度', 'Cycle reasoning effort'], agentNext: ['下一个 Agent（空白会话）', 'Next agent (blank session)'], agentPrevious: ['上一个 Agent（空白会话）', 'Previous agent (blank session)'], permissionChoose: ['选择权限模式', 'Choose permission mode'], commandMenu: ['打开原生命令菜单', 'Open native command menu'], stopSession: ['停止当前会话', 'Stop current session'] }

function PreferencesSection({ surface }: { surface: Surface }) {
  const { scope, tr } = surface
  const state = useSyncExternalStore(listener => scope.subscribe(listener), () => scope.getSnapshot(), () => scope.getSnapshot())
  const preferences = state.value ?? defaultPreferences
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Preferences['shortcuts']>()
  const [permission, setPermission] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
  const permissionLabels: Record<string, [string, string]> = { default: ['尚未询问', 'Not requested'], granted: ['已允许', 'Allowed'], denied: ['已阻止', 'Blocked'], unsupported: ['当前环境不支持', 'Unavailable'] }
  const save = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work() } catch (error) { setError(String(error)) } finally { setBusy(false) } }
  const writable = state.status === 'ready' && state.writable && !busy
  return <section style={{ display: 'grid', gap: 16, padding: 20 }} aria-label={tr('通知与快捷键', 'Notifications and shortcuts')}>
    <h2 style={{ margin: 0 }}>{tr('通知与快捷键', 'Notifications and shortcuts')}</h2>
    <p style={{ margin: 0, opacity: .75 }}>{tr('语言、外观、字号和发送键可在“通用”中调整。', 'Language, appearance, font size and Enter behavior are in General.')}</p>
    {state.status !== 'ready' && <p role="status">{tr('偏好设置暂不可写；请等待本地连接就绪。', 'Preferences are not writable until the local connection is ready.')}</p>}
    <fieldset disabled={!writable} style={{ display: 'grid', gap: 10, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8 }}>
      <legend>{tr('提醒', 'Notifications')}</legend>
      {(Object.keys(labels) as NotificationKind[]).map(kind => <div key={kind} style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
        <label><input type="checkbox" checked={preferences[kind]} onChange={event => void save(() => scope.set(kind, event.target.checked))} /> {tr(...labels[kind])}</label>
        <label><input type="checkbox" checked={preferences[`${kind}Sound`]} onChange={event => { const checked = event.target.checked; if (checked) void surface.sound(kind).catch(error => setError(String(error))); void save(() => scope.set(`${kind}Sound`, checked)) }} /> {tr('提示音', 'Sound')}</label>
        <select aria-label={tr(...labels[kind]) + tr('提示音素材', ' sound')} value={preferences[`${kind}SoundId`]} onChange={event => void save(() => scope.set(`${kind}SoundId`, event.target.value))}>{soundOptions.map(id => <option key={id} value={id}>{id}</option>)}</select>
        <button type="button" onClick={() => void surface.sound(kind).catch(error => setError(String(error)))}>{tr('试听', 'Preview sound')}</button>
      </div>)}
      <label><input type="checkbox" checked={preferences.backgroundOnly} onChange={event => void save(() => scope.set('backgroundOnly', event.target.checked))} /> {tr('仅在当前会话不在前台时提醒', 'Notify only when the session is not in the foreground')}</label>
    </fieldset>
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}><span>{tr('系统通知权限：', 'System notification permission: ')}{tr(...permissionLabels[permission]!)}</span><button type="button" disabled={permission !== 'default'} onClick={() => void Notification.requestPermission().then(setPermission).catch(error => setError(String(error)))}>{tr('启用系统通知', 'Enable system notifications')}</button></div>
    {permission === 'denied' && <p>{tr('请在浏览器或系统设置中允许此站点的通知。', 'Allow notifications for this site in browser or system settings.')}</p>}
    <p style={{ margin: 0, opacity: .75 }}>{tr('未允许系统通知时，提醒仍显示在应用内。提示音首次使用需点击“试听”或开启提示音。', 'Without system permission, notices stay in the app. Click Preview sound or enable a sound to activate audio.')}</p>
    <fieldset disabled={!writable} style={{ display: 'grid', gap: 10, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8 }}>
      <legend>{tr('快捷键', 'Keyboard shortcuts')}</legend>
      {shortcutActions.map(action => <label key={action} style={{ display: 'grid', gridTemplateColumns: '1fr 200px', gap: 16, alignItems: 'center' }}>{tr(...actionLabels[action])}<input aria-label={tr(...actionLabels[action])} value={(editing ?? preferences.shortcuts)[action]} onChange={event => setEditing({ ...(editing ?? preferences.shortcuts), [action]: event.target.value })} spellCheck={false} /></label>)}
      <p style={{ margin: 0, opacity: .75 }}>{tr('mod 在 macOS 上代表 Cmd，在其他系统代表 Ctrl；quote/period 表示单引号/句号。清空可禁用。快捷键可在聊天输入框中使用；输入法组合、已处理的键、弹窗和终端专用区域仍由原组件处理。设置窗口用 Ctrl/Cmd+逗号，输入聚焦用 Ctrl+L，消息前后用 Ctrl/Cmd+Alt+[ 或 ]。', 'mod means Cmd on macOS and Ctrl elsewhere; quote/period mean punctuation keys. Leave blank to disable. Shortcuts work in the composer; composition, handled keys, dialogs and terminal regions retain their controls. Settings: Ctrl/Cmd+comma. Focus input: Ctrl+L. Messages: Ctrl/Cmd+Alt+[ or ].')}</p>
      <div style={{ display: 'flex', gap: 10 }}><button type="button" disabled={!editing} onClick={() => void save(async () => { await scope.set('shortcuts', validateShortcuts(editing!)); setEditing(undefined) })}>{tr('保存快捷键', 'Save shortcuts')}</button><button type="button" onClick={() => void save(async () => { await scope.unset('shortcuts'); setEditing(undefined) })}>{tr('恢复默认快捷键', 'Reset shortcuts')}</button></div>
    </fieldset>
    {error && <p role="alert" style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{error}</p>}
  </section>
}
function Notices({ surface }: { surface: Surface }) {
  const notices = useSyncExternalStore(surface.subscribe, surface.notices, surface.notices)
  return <div aria-live="polite" style={{ position: 'fixed', right: 18, bottom: 18, zIndex: 1200, display: 'grid', gap: 8, maxWidth: 360, pointerEvents: 'auto' }}>{notices.map(notice => <div key={notice.id} role="status" style={{ background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: 12, boxShadow: '0 6px 24px #0002' }}><strong>{notice.title}</strong><p style={{ margin: '6px 0', overflowWrap: 'anywhere' }}>{notice.body}</p><button type="button" onClick={() => { surface.open(notice.sessionId); surface.dismiss(notice.id) }}>{surface.tr('打开会话', 'Open session')}</button> <button type="button" onClick={() => surface.dismiss(notice.id)}>{surface.tr('关闭', 'Dismiss')}</button></div>)}</div>
}

/** 有界产品快捷键与通知直接消费现有 Client 服务，生命周期由父插件释放。 */
export function applyPreferencesClient(root: Context) {
  root.inject(['slots', 'locale', 'settingsScope', 'sessions', 'uiSession', 'layout', 'uiWorkspace', 'remote'], ctx => {
    const scope = ctx.settingsScope.bind<Preferences>({ namespace: PREFERENCES_NAMESPACE })
    const sessions = ctx.get('sessions') as unknown as ISessions
    const tr = (zh: string, en: string) => ctx.locale.getSnapshot().active.startsWith('zh') ? zh : en
    applyPreferenceThemes(ctx, scope, tr)
    const pendingReads = new Set<string>()
    const markSelectedRead = () => {
      const snapshot = scope.getSnapshot(), reading = snapshot.value, id = sessions.list.getSnapshot().current
      if (!id || !reading || !snapshot.writable || !unreadNotificationMarkers(reading, id).length) return
      const seq = latestNotificationSequence(reading, id), key = id + ':' + seq
      if (pendingReads.has(key)) return
      pendingReads.add(key)
      // 选中路由即读，和是否聚焦窗口、是否开启弹窗/声音无关。
      void scope.mutate([{ op: 'set', path: ['notificationReads', id], value: seq }]).then(() => { pendingReads.delete(key); markSelectedRead() }, error => { pendingReads.delete(key); console.error('通知已读状态保存失败:', error) })
    }
    ctx.effect(() => { const offScope = scope.subscribe(markSelectedRead), offSessions = sessions.list.subscribe(markSelectedRead); markSelectedRead(); return () => { offScope(); offSessions(); pendingReads.clear() } })
    let rows: readonly Notice[] = [], nextId = 0, audio: AudioContext | undefined, disposed = false
    const soundBuffers = new Map<string, Promise<AudioBuffer>>(), playing = new Set<AudioBufferSourceNode>()
    const listeners = new Set<() => void>(), timers = new Set<ReturnType<typeof setTimeout>>(), notifications = new Set<Notification>()
    const publish = () => { for (const listener of listeners) listener() }
    const surface: Surface = {
      scope, tr, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } }, notices: () => rows,
      dismiss(id) { rows = rows.filter(row => row.id !== id); publish() },
      open(id) { const target = sessions.list.getSnapshot().ids.find(value => value === id); if (target) { window.focus(); sessions.open(target) } },
      async sound(kind) {
        if (disposed) return
        audio ??= new AudioContext()
        await audio.resume()
        const id = (scope.getSnapshot().value ?? defaultPreferences)[`${kind}SoundId`], engine = audio
        let loaded = soundBuffers.get(id)
        if (!loaded) {
          loaded = fetch('/api/lyapunov/preferences-sound?id=' + encodeURIComponent(id)).then(async response => { if (!response.ok) throw new Error(tr('提示音读取失败', 'Failed to read sound')); return engine.decodeAudioData(await response.arrayBuffer()) })
          soundBuffers.set(id, loaded); void loaded.catch(() => soundBuffers.delete(id))
        }
        const buffer = await loaded
        if (disposed) return
        const source = engine.createBufferSource(); source.buffer = buffer; source.connect(engine.destination); playing.add(source)
        source.onended = () => { playing.delete(source); source.disconnect() }; source.start()
      },
    }
    const notify = (kind: NotificationKind, id: string, body: string) => {
      const preferences = scope.getSnapshot().value ?? defaultPreferences, current = sessions.list.getSnapshot().current === id
      if (!shouldNotify(preferences, kind, current, document.visibilityState === 'visible' && document.hasFocus())) return
      const title = tr(...labels[kind])
      if (preferences[`${kind}Sound`] && audio?.state === 'running') void surface.sound(kind).catch(() => {})
      if (!preferences[kind]) return
      const notice = { id: ++nextId, sessionId: id, title, body: body.slice(0, 250) }
      rows = [...rows.slice(-3), notice]; publish()
      const timer = setTimeout(() => { timers.delete(timer); surface.dismiss(notice.id) }, 12000); timers.add(timer)
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { const notification = new Notification(title, { body: notice.body, tag: `lyapunov:${id}:${kind}`, silent: true }); notifications.add(notification); notification.onclick = () => { surface.open(id); notification.close() }; notification.onclose = () => notifications.delete(notification) } catch { /* 应用内提醒已经显示。 */ }
      }
    }
    let previous = sessions.list.getSnapshot()
    ctx.effect(() => sessions.list.subscribe(() => {
      const next = sessions.list.getSnapshot()
      // 与宿主 marker owner/原生侧栏同一身份规则：parentId 只是 fork 血缘（普通fork也有），
      // 只有 origin === 'subagent' 才是子代理；普通fork的运行结束照常通知。
      for (const id of next.ids) if (previous.byId[id]?.running && !next.byId[id]?.running && next.byId[id]?.origin !== 'subagent') notify('agent', id, next.byId[id]!.displayTitle)
      previous = next
    }))
    let pending = new Set([...ctx.uiSession.pendingInteractions.getSnapshot().values()].map(value => value.key))
    ctx.effect(() => ctx.uiSession.pendingInteractions.subscribe(() => {
      const next = ctx.uiSession.pendingInteractions.getSnapshot()
      for (const value of next.values()) if (value.kind === 'approval' && !pending.has(value.key)) notify('permissions', value.sessionId, sessions.list.getSnapshot().byId[value.sessionId]?.displayTitle ?? tr('有操作需要你决定是否允许。', 'An operation needs your approval.'))
      pending = new Set([...next.values()].map(value => value.key))
    }))
    ctx.effect(() => ctx.remote.$on('api-session/error', (id, message) => { if (sessions.list.getSnapshot().byId[id]?.origin !== 'subagent') notify('errors', id, message) }), 'lyapunov-preferences: session errors')
    ctx.effect(() => {
      const keydown = (event: KeyboardEvent) => {
        if (event.target instanceof Element && event.target.closest('[role=dialog],.xterm,.monaco-editor,[data-lyapunov-shortcuts=ignore]')) return
        const preferences = scope.getSnapshot().value ?? defaultPreferences
        const action = shortcutActions.find(action => matchShortcut(event, preferences.shortcuts[action], /Mac|iPhone|iPad/.test(navigator.platform)))
        if (!action) return
        event.preventDefault()
        void executePreferenceShortcut(ctx, action, scope).catch(error => {
          const notice = { id: ++nextId, sessionId: sessions.list.getSnapshot().current ?? '', title: tr('快捷键操作未完成', 'Shortcut action failed'), body: String(error) }
          rows = [...rows.slice(-3), notice]; publish()
          const timer = setTimeout(() => { timers.delete(timer); surface.dismiss(notice.id) }, 12000); timers.add(timer)
        })
      }
      document.addEventListener('keydown', keydown)
      return () => { disposed = true; document.removeEventListener('keydown', keydown); for (const timer of timers) clearTimeout(timer); for (const notice of notifications) notice.close(); for (const source of playing) source.stop(); playing.clear(); soundBuffers.clear(); void audio?.close(); listeners.clear() }
    })
    // 按产品入口收敛要求移除自定义设置导航；通知、快捷键及已有偏好仍由同一运行时消费。
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'lyapunov-notifications', order: 90, inject: () => ({ surface }) }, Notices))
  })
}
