import type {Context} from '@deepseek-ai/cordis'
import {IconDownloadOutlineRegular} from '@deepseek-ai/dsh-client-ui-primitives'

/** 只贡献自有设置分类的图标，不持有原生导航、选择状态或底色。 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
 interface SlotMap {'settings.section.icon':{kind:'list';scope:'root';owner:{children?:never}}}
}
type Kind='integrations'|'physics'|'robots'|'downloads'
function SettingsIcon({kind}:{kind:Kind}){
 if(kind==='downloads')return <IconDownloadOutlineRegular size={16}/>
 return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  {kind==='integrations'?<><path d="M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0V8Zm6 10v3"/></>:kind==='physics'?<><ellipse cx="12" cy="12" rx="11" ry="4" transform="rotate(45 12 12)"/><ellipse cx="12" cy="12" rx="11" ry="4" transform="rotate(-45 12 12)"/></>:<><path d="M4 21h10M6 18l-2-6m2-3 10-4m3 2 1 4m-2 1 2 2 2-2"/><circle cx="8" cy="19" r="2"/><circle cx="4" cy="10" r="2"/><circle cx="18" cy="5" r="2"/></>}
 </svg>
}
export function applySettingsIcons(ctx:Context){
 for(const [id,kind] of [['lyapunov-integrations','integrations'],['lyapunov-engine','physics'],['lyapunov-robot-library','robots'],['lyapunov-downloads','downloads']] as const){
  ctx.slots.inject('settings.section.icon',()=>ctx.slots.register({name:'settings.section.icon',id},()=> <SettingsIcon kind={kind}/>))
 }
}
