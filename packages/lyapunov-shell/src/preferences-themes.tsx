import { useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Preferences } from './preferences.ts'
import { legacyThemePresets } from './preferences-theme-data.ts'
import {Button,Menu,IconChevronDownOutlineRegular} from '@deepseek-ai/dsh-client-ui-primitives'

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
 const [open,setOpen]=useState(false),active=snapshot.value?.themePalette??'native'
 const options=[{id:'native',label:tr('当前默认配色','Native palette')},...legacyThemePresets.map(theme=>({id:theme.id,label:theme.name}))]
 return <div style={{padding:'16px 0',borderBottom:'.5px solid var(--dsw-alias-border-l2)'}}>
  <div style={{display:'flex',alignItems:'center',gap:16}}>
   <div style={{flex:1,minWidth:0}}><div style={{fontSize:14,lineHeight:'22px',fontWeight:400}}>{tr('主题配色','Theme palette')}</div><div style={{fontSize:12,lineHeight:'18px',color:'var(--dsw-alias-label-tertiary)',marginTop:4}}>{tr('本地配色；明暗模式由“外观”控制。','Local palettes; Appearance controls light and dark mode.')}</div></div>
   <Menu open={open} onClose={()=>setOpen(false)} items={options} selectedId={active} onSelect={id=>{setOpen(false);setBusy(true);setError('');void scope.set('themePalette',id).catch(error=>setError(String(error))).finally(()=>setBusy(false))}} align="end" portal anchor={<Button variant="toolbar" aria-label={tr('主题配色','Theme palette')} aria-haspopup="menu" aria-expanded={open} disabled={!snapshot.writable||snapshot.status!=='ready'||busy} onClick={()=>setOpen(v=>!v)}>{options.find(o=>o.id===active)?.label??active}<IconChevronDownOutlineRegular size={12}/></Button>}/>
  </div>
  {error&&<p role="alert" style={{fontSize:12,lineHeight:'18px',color:'var(--dsw-alias-state-error-primary)'}}>{error}</p>}
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
