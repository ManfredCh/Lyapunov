import {useEffect,useId,useState} from "react"
import type {Context} from "@deepseek-ai/cordis"
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client"
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client"
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client"
import type {} from "@deepseek-ai/dsh-client-locale/client"
import type {PropsLocale} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from "../../desktop/src/bridge.ts"
import type {HeroHeadlineOwnerProps} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {LYAPUNOV_ICON_DATA_URL} from './brand-artwork.ts'
import {createWelcomeVerseStore} from './welcome-verses.ts'
declare module '@deepseek-ai/dsh-client-ui-slots' {interface LocaleNamespaceMap {'lyapunov-product':'developer'|'mode-hint'|'administrator'|'administrator-hint'}}

export function Mark({size=24,className}:{size?:number;className?:string}){
  return <img src={LYAPUNOV_ICON_DATA_URL} width={size} height={size} className={className} alt="" aria-hidden="true" style={{width:size,height:size,objectFit:'contain',display:'block',flexShrink:0,borderRadius:'22%'}}/>
}
export function WelcomeHeadline({sessionId,store}:HeroHeadlineOwnerProps & {store:ReturnType<typeof createWelcomeVerseStore>}){
 const instance=useId()
 const verse=store.get(sessionId===undefined?'welcome:'+instance:'session:'+sessionId)
 return <span data-testid="lyapunov-welcome-verse" title={verse.sourceTitle} style={{fontFamily:'"Noto Serif CJK SC","Noto Serif SC",serif',fontSize:'clamp(20px,1.8vw,28px)',fontWeight:400,lineHeight:1.45,whiteSpace:'normal',overflowWrap:'anywhere'}}>{verse.text}</span>
}
function AccountShortcut(){
  const [formal,setFormal]=useState(false)
  useEffect(()=>{void window.lyapunovDesktop?.mode().then(mode=>setFormal(mode==="formal"))},[])
  if(!formal)return null
  const label=document.documentElement.lang.startsWith("zh")?"账户":"Account"
  return <button type="button" onClick={()=>void window.lyapunovDesktop!.showAccount()}>{label}</button>
}
export function BrandName({t}:PropsLocale<'lyapunov-product'>){
 const [mode,setMode]=useState<'administrator'|'developer'>()
 useEffect(()=>{let active=true;void fetch('/api/lyapunov/runtime-info').then(response=>response.ok?response.json():undefined).then(value=>{if(active)setMode(value?.administrator?.role==='super_admin'&&value?.modelBilling==='own-key'?'administrator':value?.mode==='developer'?'developer':undefined)}).catch(()=>{});return()=>{active=false}},[])
 return <span style={{fontFamily:'"Noto Sans",system-ui,sans-serif',fontWeight:650,letterSpacing:'.01em',display:'inline-flex',alignItems:'center',gap:8}}>Lyapunov{mode&&<span title={t(mode==='administrator'?'administrator-hint':'mode-hint')} style={{fontSize:11,fontWeight:500,border:'1px solid currentColor',borderRadius:4,padding:'1px 5px',opacity:.75}}>{t(mode)}</span>}</span>
}
/** 产品只填品牌与账户入口；会话和设置仍由DSH原生界面承载。 */
export function applyProductUI(ctx:Context){
  const store=createWelcomeVerseStore()
  const Headline=(props:HeroHeadlineOwnerProps)=><WelcomeHeadline {...props} store={store}/>
  ctx.effect(()=>ctx.locale.register('lyapunov-product',{zh:{developer:'开发','mode-hint':'独立开发环境，由后端启动模式决定',administrator:'管理员','administrator-hint':'已验证的超级管理员，模型通过自有Key直连'},en:{developer:'Developer','mode-hint':'Isolated development environment selected by the backend',administrator:'Administrator','administrator-hint':'Verified super administrator using a direct personal model key'}}))
  ctx.slots.inject("sidebar.brand.mark",()=>ctx.slots.register({name:"sidebar.brand.mark"},Mark))
  ctx.slots.inject("sidebar.brand.name",()=>ctx.slots.register({name:"sidebar.brand.name",locale:'lyapunov-product'},BrandName))
  ctx.slots.inject("conversation.hero.brand.mark",()=>ctx.slots.register({name:"conversation.hero.brand.mark"},Mark))
  ctx.slots.inject("conversation.hero.headline",()=>ctx.slots.register({name:"conversation.hero.headline"},Headline))
  ctx.slots.inject("conversation.session.header.actions",()=>ctx.slots.register({name:"conversation.session.header.actions",id:"lyapunov-account",order:50},AccountShortcut))
}
