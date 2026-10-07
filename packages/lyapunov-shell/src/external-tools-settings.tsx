import {useEffect,useRef,useState} from 'react'
import type {Context} from '@deepseek-ai/cordis'
import type {ISessions} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import {EXTERNAL_TOOL_OPTIONS} from './external-tools.ts'
import {mainSessionId} from './history-navigation.ts'
import {startExternalInstallSession} from './external-install-session.ts'
import type {ExternalToolsState,ExternalMcpInput} from './external-tools-state.ts'

type Translate=(zh:string,en:string)=>string
const descriptionsEn:Record<string,string>={blender:'3D modeling and a separately configured editor bridge.',unity:'Unity Hub/editor and a separately configured editor bridge.',sam3:'Local image segmentation; gated access must succeed through the HF mirror.',sam3d:'Downloadable weights; no SAM 3D Objects runtime adapter.',da3:'DA3 BASE weights. The current depth adapter uses DA-V2.','blender-mcp':'Third-party mcp-for-blender service and Blender addon, locked by this product.','unity-mcp':'Third-party CoplayDev bridge; addon, endpoint and tools are separate checks.',fastgs:'Optional official FastGS source and isolated environment.',mcp:'Configure an MCP service without requiring a language model.'}
async function request<T>(path:string,body?:unknown):Promise<T>{
 const response=await fetch('/api/lyapunov/external-tools/'+path,body===undefined?undefined:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
 const value=await response.json() as T&{error?:string};if(!response.ok)throw Error(value.error??'外部工具操作失败。 / External tool operation failed.');return value
}
interface Props {tr:Translate;start:(id:string,close:()=>void)=>Promise<string>;close:()=>void;sessionId:()=>string|undefined;openDocument:()=>Promise<void>}
/** 单个设置面复用原生 profile、MCP 与 Jobs；安装助手只是可选入口。 */
export function ExternalToolsSettings({tr,start,close,sessionId,openDocument}:Props) {
 const [busy,setBusy]=useState<string>(),[error,setError]=useState(''),[notice,setNotice]=useState(''),[state,setState]=useState<ExternalToolsState>()
 const [editing,setEditing]=useState(false),[serverName,setServerName]=useState(''),[transport,setTransport]=useState<ExternalMcpInput['transport']>('stdio')
 const [command,setCommand]=useState(''),[args,setArgs]=useState(''),[cwd,setCwd]=useState(''),[url,setUrl]=useState(''),[port,setPort]=useState('9876')
 const [modelDirs,setModelDirs]=useState<Record<string,string>>({}),[log,setLog]=useState('')
 const inFlight=useRef(false),offsets=useRef<Record<string,number>>({})
 const scoped=(path:string)=>{const id=sessionId();return id?path+(path.includes('?')?'&':'?')+'sessionId='+encodeURIComponent(id):path}
 const refresh=async()=>setState(await request<ExternalToolsState>(scoped('state')))
 const perform=async(id:string,operation:()=>Promise<void>)=>{
  if(inFlight.current)return;inFlight.current=true;setBusy(id);setError('');setNotice('')
  try{await operation()}catch(reason){setError(reason instanceof Error?reason.message:String(reason))}finally{inFlight.current=false;setBusy(undefined)}
 }
 useEffect(()=>{void perform('check',refresh)},[])
 const edit=(name:string)=>{
  const row=state?.mcp.find(v=>v.serverName===name);setEditing(true);setServerName(name);setTransport(row?.transport==='sse'?'sse':row?.transport==='streamable-http'?'streamable-http':'stdio')
  setCommand(row?'':name==='blender'?state?.blenderSupply.command??'':'');setArgs('');setCwd('');setUrl('');setPort(row?'':'9876')
 }
 const save=async()=>{
  const row=state?.mcp.find(v=>v.serverName===serverName)
  const input:ExternalMcpInput={serverName,transport,expectedRevision:row?.revision??null,...command.trim()?{command:command.trim()}:{},...args.trim()?{args:JSON.parse(args)}:{},...cwd.trim()?{cwd:cwd.trim()}:{},...url.trim()?{url:url.trim()}:{},...serverName==='blender'&&port.trim()?{blenderPort:Number(port)}:{}}
  await request('mcp',input);await refresh();setNotice(tr('配置已交给原生 MCP 客户端；刷新核对握手和工具清单。编辑器 addon 需自行启用。','Saved to the native MCP client; refresh to inspect handshake and tools. Enable the editor addon separately.'))
 }
 const acquire=async(id:string)=>{const r=await request<{jobId:string}>('acquire',{id,localDir:modelDirs[id],sessionId:sessionId()});await refresh();setNotice(tr('下载／供给已提交原生后台作业：','Acquisition submitted as native job: ')+r.jobId)}
 const fastgs=async(action:'download'|'install'|'doctor')=>{const r=await fetch('/api/lyapunov/fastgs-tool',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});if(!r.ok)throw Error(await r.text());const value=await r.json() as {tool?:{ready?:{source:boolean;environment:boolean;trainable:boolean}};install?:{running:boolean;result?:{detail?:string;message?:string}}};setNotice(tr('FastGS 源码／环境／可训练：','FastGS source / environment / trainable: ')+[value.tool?.ready?.source,value.tool?.ready?.environment,value.tool?.ready?.trainable].map(v=>v===true?tr('已核','checked'):tr('未就绪','not ready')).join(' / ')+(value.install?.running?' · '+tr('后台安装处理中，稍后检查真实结果。','Acquisition is running; inspect its actual result later.'):value.install?.result?.detail??value.install?.result?.message??''))}
 const readJob=async(jobId:string)=>{const r=await request<{output:{text:string}[];nextOffset:number}>(scoped('job?jobId='+encodeURIComponent(jobId)+'&offset='+(offsets.current[jobId]??0)));offsets.current[jobId]=r.nextOffset;setLog(old=>(old+r.output.map(v=>v.text).join('')).slice(-8000));await refresh()}
 const mcpStatus=(status:string,count:number)=>tr(status==='connected'?'MCP 已握手':status==='unavailable'?'MCP 不可用':'MCP 已配置，尚无连接读数',status==='connected'?'MCP handshake connected':status==='unavailable'?'MCP unavailable':'Configured; no live connection reading')+' · '+count+' '+tr('个当前可见工具','currently visible tools')
 return <section aria-label={tr('外部工具','External tools')} style={{display:'grid',gap:14,padding:20}}>
  <h2 style={{margin:0}}>{tr('外部工具','External tools')}</h2>
  <p style={{margin:0,opacity:.75}}>{tr('直接检查已有软件、配置 MCP 和下载本地权重，无需先连接语言模型。软件、addon、MCP 握手和实际调用分别验收。','Inspect software, configure MCP and acquire local weights without a language model. Software, addons, MCP handshake and actual calls are separate checks.')}</p>
  <div><button disabled={!!busy} onClick={()=>void perform('check',refresh)}>{tr('检查已有／刷新','Inspect existing / refresh')}</button> <button disabled={!!busy} onClick={()=>void perform('document',openDocument)}>{tr('打开原生 MCP 配置文档','Open native MCP configuration')}</button></div>
  {error&&<p role='alert'>{error}</p>}{notice&&<p role='status'>{notice}</p>}
  {EXTERNAL_TOOL_OPTIONS.map(option=>{
   const reading=state?.software.find(v=>v.id===option.id),bridge=['blender','blender-mcp'].includes(option.id)?'blender':['unity','unity-mcp'].includes(option.id)?'unity':option.id==='mcp'?'':undefined,row=bridge?state?.mcp.find(v=>v.serverName===bridge):undefined
   return <article key={option.id} style={{padding:14,border:'1px solid var(--dsw-alias-border-l1,#7774)',borderRadius:8,display:'grid',gap:8}}>
    <strong>{option.id==='mcp'?tr(option.name,'Other MCP services'):option.name}</strong><p style={{margin:0}}>{tr(option.description,descriptionsEn[option.id]??option.description)}</p>
    {reading&&<p style={{margin:0}}>{reading.version??''} {reading.detail}</p>}
    {bridge!==undefined&&<p style={{margin:0}}>{row?mcpStatus(row.status,row.tools.length):tr('MCP 未配置／未发现；安装软件不会自动建立连接。','MCP not configured/discovered; installing software does not create a connection.')}</p>}
    {option.id==='blender-mcp'&&state&&<><p style={{margin:0}}>{state.blenderSupply.detail}</p><small>{tr('Addon 文件：','Addon file: ')}{state.blenderSupply.addon}</small>{state.blenderSupply.existingCommand&&<small>{tr('检测到已有桥接命令（版本兼容性、addon 与握手另验）：','Detected existing bridge command (compatibility, addon and handshake remain separate): ')}{state.blenderSupply.existingCommand}</small>}<p style={{margin:0}}>{tr('在 Blender Preferences → Add-ons 中启用已选 addon，再在侧栏启动端口服务。此处不会打开、重启或替换你的 Blender 工程。','Enable the selected addon in Blender Preferences → Add-ons, then start its side-panel server. This form does not open, restart or replace your Blender project.')}</p></>}
    <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
     <button disabled={!!busy} onClick={()=>void perform('check',refresh)}>{tr('检查已有','Inspect existing')}</button>
     {bridge!==undefined&&<button disabled={!!busy} onClick={()=>edit(bridge)}>{tr('连接／配置 MCP','Connect / configure MCP')}</button>}
     {option.kind==='software'&&option.source&&<a href={option.source} target='_blank' rel='noreferrer'>{tr('官方软件下载页','Official software download')}</a>}
     {option.id==='blender-mcp'&&<button disabled={!!busy} onClick={()=>void perform(option.id,()=>acquire(option.id))}>{tr('下载／供给锁定桥接','Acquire locked bridge')}</button>}
     {option.id==='fastgs'&&<><button disabled={!!busy} onClick={()=>void perform('fastgs',()=>fastgs('doctor'))}>{tr('检查 FastGS','Inspect FastGS')}</button><button disabled={!!busy} onClick={()=>void perform('fastgs',()=>fastgs('download'))}>{tr('下载官方源码','Download official source')}</button><button disabled={!!busy} onClick={()=>void perform('fastgs',()=>fastgs('install'))}>{tr('安装隔离环境','Install isolated environment')}</button></>}
     <button disabled={!!busy} onClick={()=>void perform(option.id,async()=>{await start(option.id,close)})}>{tr('新会话助手安装','Install with assistant in a new chat')}</button>
    </div>
    {option.kind==='model'&&<><label>{tr('本地权重绝对目录','Absolute local weights directory')} <input value={modelDirs[option.id]??''} onChange={e=>setModelDirs({...modelDirs,[option.id]:e.target.value})} placeholder='/absolute/model-directory'/></label><button disabled={!!busy||!modelDirs[option.id]?.trim()} onClick={()=>void perform(option.id,()=>acquire(option.id))}>{tr('直接下载目录锁定权重','Download catalogued weights directly')}</button><small>{tr('仅使用 hf-mirror.com；镜像缺文件、访问授权或校验失败时阻断，不切官方端点。下载不等于推理可用。','Only hf-mirror.com; missing files, access or validation block the download. Acquisition does not prove inference readiness.')}</small></>}
    {option.source&&option.kind!=='software'&&<a href={option.source} target='_blank' rel='noreferrer'>{tr('项目来源','Project source')}</a>}
   </article>
  })}
  {editing&&<fieldset><legend>{tr('原生 MCP 连接配置','Native MCP connection configuration')}</legend><p>{tr('已有字段留空会保留。秘密、复杂参数或 transport 迁移请用原生文档。','Leave existing fields blank to preserve them. Use the native document for credentials or transport changes.')}</p><div style={{display:'grid',gap:8}}>
   <label>{tr('服务名称','Server namespace')} <input value={serverName} onChange={e=>setServerName(e.target.value)}/></label>
   <label>Transport <select value={transport} onChange={e=>setTransport(e.target.value as ExternalMcpInput['transport'])}><option>stdio</option><option>streamable-http</option><option>sse</option></select></label>
   {transport==='stdio'?<><label>{tr('可执行文件','Executable')} <input value={command} onChange={e=>setCommand(e.target.value)}/></label><label>{tr('参数 JSON 数组','Arguments JSON array')} <input value={args} onChange={e=>setArgs(e.target.value)} placeholder='[]'/></label><label>{tr('服务工作目录','Service working directory')} <input value={cwd} onChange={e=>setCwd(e.target.value)}/></label></>:<label>{tr('MCP 服务地址','MCP endpoint URL')} <input value={url} onChange={e=>setUrl(e.target.value)} placeholder='http://localhost:8080/mcp'/></label>}
   {serverName==='blender'&&transport==='stdio'&&state?.blenderSupply.existingCommand&&<button type='button' onClick={()=>setCommand(state.blenderSupply.existingCommand!)}>{tr('使用检测到的已有桥接命令','Use the detected existing bridge command')}</button>}
   {serverName==='blender'&&transport==='stdio'&&<label>{tr('Blender addon 端口','Blender addon port')} <input type='number' min='1' max='65535' value={port} onChange={e=>setPort(e.target.value)}/></label>}
   <button disabled={!!busy||!state?.writable} onClick={()=>void perform('mcp',save)}>{tr('保存并连接','Save and connect')}</button>
  </div></fieldset>}
  {!!state?.mcp.length&&<fieldset><legend>{tr('当前原生 MCP 工具清单','Current native MCP tool inventory')}</legend>{state.mcp.map(row=><div key={row.id+row.serverName} style={{padding:6}}><strong>{row.serverName}</strong> · {row.transport} · {mcpStatus(row.status,row.tools.length)}<small style={{display:'block'}}>{row.command??row.url??''}</small>{row.detail&&<p>{row.detail}</p>}<code>{row.tools.join(', ')||tr('暂无工具；检查 addon、服务端、握手和 scope。','No tools; inspect addon, server, handshake and scope.')}</code> <button disabled={!!busy||!row.id} onClick={()=>edit(row.serverName)}>{tr('配置','Configure')}</button></div>)}</fieldset>}
  {!!state?.installJobs.length&&<fieldset><legend>{tr('原生下载／安装作业','Native acquisition jobs')}</legend>{state.installJobs.map(job=><div key={job.jobId}>{job.jobId} · {job.status} · {job.progress??job.detail??job.label} <button disabled={!!busy} onClick={()=>void perform('output',()=>readJob(job.jobId))}>{tr('读回实际输出','Read actual output')}</button></div>)}{log&&<pre style={{whiteSpace:'pre-wrap',maxHeight:240,overflow:'auto'}}>{log}</pre>}</fieldset>}
 </section>
}
export function applyExternalToolsSettings(ctx:Context):void {
 const t=ctx.locale.bind('lyapunov'),tr:Translate=(zh,en)=>t('open')==='Scene workbench'?en:zh
 ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'lyapunov-external-tools',order:21,label:()=>tr('外部工具','External tools'),inject:()=>({tr,start:(id:string,close:()=>void)=>startExternalInstallSession(ctx,id,close),sessionId:()=>mainSessionId((ctx.get('sessions') as unknown as ISessions).list.getSnapshot()),openDocument:async()=>{const r=await ctx.remote.settings.openSettingsDocument();if(!r.ok)throw Error(r.error.message)}})},ExternalToolsSettings))
}
