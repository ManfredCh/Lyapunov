import {useRef,useState} from 'react'
import type {Context} from '@deepseek-ai/cordis'
import {EXTERNAL_TOOL_OPTIONS} from './external-tools.ts'
import {startExternalInstallSession} from './external-install-session.ts'

type Translate=(zh:string,en:string)=>string
const descriptionsEn:Record<string,string>={blender:'3D modeling, scene editing and asset processing.',unity:'Install Unity Hub or the editor for scene creation and exchange.',sam3:'Local image segmentation; repository access is checked before download.',sam3d:'Downloadable 3D object model; this product has no SAM3D runtime adapter yet.',da3:'DA3 BASE weights. The built-in depth interface currently uses DA-V2, so runtime compatibility is checked separately.','blender-mcp':'Install or repair the MCP service and editor addon, then check the connection.','unity-mcp':'Connect an MCP service to the Unity editor, checking the editor and service address first.',fastgs:'Optional fast 3D Gaussian Splatting reconstruction; source and environment are downloaded on demand.',mcp:'Choose and configure another MCP service in a new conversation.'}
const actionsEn:Record<string,string>={'下载／安装':'Download / install','安装／配置':'Install / configure','选择／配置':'Choose / configure'}
export function ExternalToolsSettings({tr,start,close}:{tr:Translate;start:(id:string,close:()=>void)=>Promise<string>;close:()=>void}) {
 const [busy,setBusy]=useState<string>(),[error,setError]=useState('')
 const inFlight=useRef(false)
 const choose=async(id:string)=>{
  if(inFlight.current)return
  inFlight.current=true;setBusy(id);setError('')
  try{await start(id,close)}catch(reason){setError(reason instanceof Error?reason.message:String(reason))}
  finally{inFlight.current=false;setBusy(undefined)}
 }
 return <section aria-label={tr('外部工具','External tools')} style={{display:'grid',gap:14,padding:20}}>
  <h2 style={{margin:0}}>{tr('外部工具','External tools')}</h2>
  <p style={{margin:0,opacity:.75}}>{tr('选择工具后会新开一个会话，由助手检查已有环境、按需下载安装，并在该会话中报告结果。','Choose a tool to open a new conversation for checking, downloading and installing it.')}</p>
  {error&&<p role="alert">{error}</p>}
  {EXTERNAL_TOOL_OPTIONS.map(option=><article key={option.id} style={{padding:14,border:'1px solid var(--dsw-alias-border-l1,#7774)',borderRadius:8,display:'grid',gap:8}}>
   <div style={{display:'flex',gap:12,alignItems:'center'}}><strong>{option.id==='mcp'?tr(option.name,'Other MCP services'):option.name}</strong><span style={{flex:1}}/><button type="button" disabled={busy!==undefined} onClick={()=>void choose(option.id)}>{busy===option.id?tr('正在新建会话…','Opening conversation…'):tr(option.actionLabel,actionsEn[option.actionLabel]??option.actionLabel)}</button></div>
   <p style={{margin:0,opacity:.75}}>{tr(option.description,descriptionsEn[option.id]??option.description)}</p>
   {option.source&&<a href={option.source} target="_blank" rel="noreferrer">{tr('项目来源','Project source')}</a>}
  </article>)}
 </section>
}
export function applyExternalToolsSettings(ctx:Context):void {
 const t=ctx.locale.bind('lyapunov'),tr:Translate=(zh,en)=>t('open')==='Scene workbench'?en:zh
 ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'lyapunov-external-tools',order:21,label:()=>tr('外部工具','External tools'),inject:()=>({tr,start:(id:string,close:()=>void)=>startExternalInstallSession(ctx,id,close)})},ExternalToolsSettings))
}
