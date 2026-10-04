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
import {synchronizeDesktopLocale} from './product-locale.ts'
import type {LocaleSettings} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
declare module '@deepseek-ai/dsh-client-ui-slots' {interface LocaleNamespaceMap {'lyapunov-product':'developer'|'mode-hint'|'administrator'|'administrator-hint'|'account'|'welcome'}}

export function Mark({size=24,className}:{size?:number;className?:string}){
  return <img src={LYAPUNOV_ICON_DATA_URL} width={size} height={size} className={className} alt="" aria-hidden="true" style={{width:size,height:size,objectFit:'contain',display:'block',flexShrink:0,borderRadius:'22%'}}/>
}
export function WelcomeHeadline({sessionId,store,locale="zh",welcome="Welcome to Lyapunov"}:HeroHeadlineOwnerProps & {store:ReturnType<typeof createWelcomeVerseStore>;locale?:string;welcome?:string}){
 const instance=useId()
 const verse=store.get(sessionId===undefined?'welcome:'+instance:'session:'+sessionId)
 const chinese=locale.toLowerCase().split(/[-_]/)[0]==="zh"
 return <span data-testid="lyapunov-welcome-verse" title={chinese?verse.sourceTitle:undefined} style={{fontFamily:'var(--lyapunov-font-serif,"Noto Serif CJK SC","Noto Serif SC","Lyapunov CJK",serif)',fontSize:'clamp(20px,1.8vw,28px)',fontWeight:400,lineHeight:1.45,whiteSpace:'normal',overflowWrap:'anywhere'}}>{chinese?verse.text:welcome}</span>
}
export function AccountShortcut({t}:PropsLocale<'lyapunov-product'>){
  const [formal,setFormal]=useState(false)
  useEffect(()=>{void window.lyapunovDesktop?.mode().then(mode=>setFormal(mode==="formal"))},[])
  if(!formal)return null
  return <button type="button" onClick={()=>void window.lyapunovDesktop!.showAccount()}>{t('account')}</button>
}
export function BrandName({t}:PropsLocale<'lyapunov-product'>){
 const [mode,setMode]=useState<'administrator'|'developer'>()
 useEffect(()=>{let active=true;void fetch('/api/lyapunov/runtime-info').then(response=>response.ok?response.json():undefined).then(value=>{if(active)setMode(value?.administrator?.role==='super_admin'&&value?.modelBilling==='own-key'?'administrator':value?.mode==='developer'?'developer':undefined)}).catch(()=>{});return()=>{active=false}},[])
 return <span style={{fontFamily:'var(--dsw-font-family,"Noto Sans","Lyapunov CJK",system-ui,sans-serif)',fontWeight:650,letterSpacing:'.01em',display:'inline-flex',alignItems:'center',gap:8}}>Lyapunov{mode&&<span title={t(mode==='administrator'?'administrator-hint':'mode-hint')} style={{fontSize:11,fontWeight:500,border:'1px solid currentColor',borderRadius:4,padding:'1px 5px',opacity:.75}}>{t(mode)}</span>}</span>
}
/** 产品只填品牌与账户入口；会话和设置仍由DSH原生界面承载。 */
export function applyProductUI(ctx:Context){
  const store=createWelcomeVerseStore()
  const Headline=(props:HeroHeadlineOwnerProps & PropsLocale<'lyapunov-product'>)=><WelcomeHeadline {...props} store={store} locale={ctx.locale.getSnapshot().active} welcome={props.t('welcome')}/>
  ctx.effect(()=>ctx.locale.register('lyapunov-product',{zh:{developer:'开发','mode-hint':'独立开发环境，由后端启动模式决定',administrator:'管理员','administrator-hint':'已验证的超级管理员，模型通过自有Key直连',account:'账户',welcome:'欢迎使用 Lyapunov'},en:{developer:'Developer','mode-hint':'Isolated development environment selected by the backend',administrator:'Administrator','administrator-hint':'Verified super administrator using a direct personal model key',account:'Account',welcome:'Welcome to Lyapunov'}}))
  ctx.effect(()=>{
   if(typeof document==='undefined')return()=>{}
   const link=document.createElement('link');link.rel='stylesheet';link.href='/api/lyapunov/fonts/lyapunov-fonts.css';link.dataset.lyapunovFonts=''
   document.head.append(link);return()=>link.remove()
  })
  ctx.effect(()=>{const desktop=typeof window==='undefined'?undefined:window.lyapunovDesktop;return desktop?synchronizeDesktopLocale(ctx.locale,ctx.configForms.get<LocaleSettings>('locale'),desktop):()=>{}})
  ctx.slots.inject("sidebar.brand.mark",()=>ctx.slots.register({name:"sidebar.brand.mark"},Mark))
  ctx.slots.inject("sidebar.brand.name",()=>ctx.slots.register({name:"sidebar.brand.name",locale:'lyapunov-product'},BrandName))
  ctx.slots.inject("conversation.hero.brand.mark",()=>ctx.slots.register({name:"conversation.hero.brand.mark"},Mark))
  ctx.slots.inject("conversation.hero.headline",()=>ctx.slots.register({name:"conversation.hero.headline",locale:'lyapunov-product'},Headline))
  ctx.slots.inject("conversation.session.header.actions",()=>ctx.slots.register({name:"conversation.session.header.actions",id:"lyapunov-account",order:50,locale:'lyapunov-product'},AccountShortcut))
}
