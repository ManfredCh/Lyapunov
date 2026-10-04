import { useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Preferences } from './preferences.ts'
import { legacyThemePresets } from './preferences-theme-data.ts'

export const preferenceThemeIds = ['native', ...legacyThemePresets.map(theme => theme.id)] as const
export function paletteTokens(id: string) {
 if (id === 'native') return {}
 const theme = legacyThemePresets.find(theme => theme.id === id)
 if (!theme) throw new Error('找不到该本地主题。')
 return theme.tokens
}
function ThemePaletteRow({ scope, tr }: { scope: ConfigForm<Preferences>; tr(zh: string, en: string): string }) {
 const snapshot = useSyncExternalStore(listener => scope.subscribe(listener), () => scope.getSnapshot(), () => scope.getSnapshot())
 const [error, setError] = useState(''), [busy, setBusy] = useState(false)
 return <div style={{ padding: '12px 0', display: 'grid', gap: 8 }}>
  <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}><strong>{tr('主题配色', 'Theme palette')}</strong><select aria-label={tr('主题配色', 'Theme palette')} disabled={!snapshot.writable || snapshot.status !== 'ready' || busy} value={snapshot.value?.themePalette ?? 'native'} onChange={event => { setBusy(true); setError(''); void scope.set('themePalette', event.target.value).catch(error => setError(String(error))).finally(() => setBusy(false)) }}>
   <option value="native">{tr('当前默认配色', 'Native palette')}</option>{legacyThemePresets.map(theme => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
  </select></label>
  <span style={{ opacity: .7 }}>{tr('37套原有本地主题；亮色、暗色和跟随系统仍由“外观”控制。', '37 existing local palettes. Appearance continues to control light, dark and system mode.')}</span>
  {error && <span role="alert">{error}</span>}
 </div>
}
/** 只添加原生token覆盖层，模式与DOM呈现仍由DSH主题所有者维护。 */
export function applyPreferenceThemes(ctx: Context, scope: ConfigForm<Preferences>, tr: (zh: string, en: string) => string) {
 ctx.inject(['theme', 'slots'], owner => {
  let selected: string | undefined, remove: (() => void) | undefined
  const sync = () => {
   const id = scope.getSnapshot().value?.themePalette ?? 'native'
   if (id === selected) return
   selected = id; remove?.(); remove = owner.theme.overrideTokens('lyapunov-theme-palette', paletteTokens(id))
  }
  owner.effect(() => { sync(); const off = scope.subscribe(sync); return () => { off(); remove?.() } })
  owner.slots.inject('settings.general.item', () => owner.slots.register({ name: 'settings.general.item', id: 'lyapunov-theme-palette', order: 12, inject: () => ({ scope, tr }) }, ThemePaletteRow))
 })
}
