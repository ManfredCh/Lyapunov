import {useEffect,useRef,useState} from 'react'
import type {Context} from '@deepseek-ai/cordis'
import {closeTopModal} from '@deepseek-ai/dsh-client-ui-primitives'
import type {ISessions} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import {EXTERNAL_TOOL_OPTIONS} from './external-tools.ts'
import {mainSessionId} from './history-navigation.ts'
import {startExternalInstallSession} from './external-install-session.ts'
import type {ExternalToolsState} from './external-tools-state.ts'
import {marketplaceEntries,filterMarketplace,type MarketplaceEntry} from './plugin-marketplace.ts'

type Translate=(zh:string,en:string)=>string
const descriptionsEn:Record<string,string>={blender:'3D modeling and a separately configured editor bridge.',unity:'Unity Hub/editor and a separately configured editor bridge.',sam3:'Local image segmentation; gated access must succeed through the HF mirror.',sam3d:'Downloadable weights; no SAM 3D Objects runtime adapter.',da3:'DA3 BASE weights. The current depth adapter uses DA-V2.','blender-mcp':'Third-party mcp-for-blender service and Blender addon, locked by this product.','unity-mcp':'Third-party CoplayDev bridge; addon, endpoint and tools are separate checks.',fastgs:'Optional official FastGS source and isolated environment.',mcp:'Configure an MCP service without requiring a language model.'}
async function request<T>(path:string,body?:unknown):Promise<T>{
 const response=await fetch('/api/lyapunov/external-tools/'+path,body===undefined?undefined:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
 const value=await response.json() as T&{error?:string};if(!response.ok)throw Error(value.error??'外部工具操作失败。 / External tool operation failed.');return value
}
interface Props {view?:'integrations'|'downloads';tr:Translate;start:(id:string,close:()=>void)=>Promise<string>;close:()=>void;sessionId:()=>string|undefined;openDocument:()=>Promise<void>}
/** 单个设置面复用原生 profile、MCP 与 Jobs；安装助手只是可选入口。 */
export function ExternalToolsSettings({view='integrations',tr,start,close,sessionId,openDocument}:Props) {
 const [busy,setBusy]=useState<string>(),[error,setError]=useState(''),[notice,setNotice]=useState(''),[state,setState]=useState<ExternalToolsState>()
 const [modelDirs,setModelDirs]=useState<Record<string,string>>({}),[log,setLog]=useState('')
 const [query,setQuery]=useState(''),[filter,setFilter]=useState<'all'|MarketplaceEntry['kind']>('all'),[availability,setAvailability]=useState<'all'|'available'|'attention'>('all'),[detail,setDetail]=useState<string>()
 const [documentPending,setDocumentPending]=useState(false),[documentError,setDocumentError]=useState(''),documentInFlight=useRef(false)
 const inFlight=useRef(false),offsets=useRef<Record<string,number>>({})
 // Host既有中英公开句按当前界面投影，原始作业输出/诊断仍在日志保留。
 const displayDetail=(value:string|null|undefined)=>{if(!value)return value;const pair=value.split(' / ');return pair.length===2&&/[\u3400-\u9fff]/.test(pair[0]!)&&!/[\u3400-\u9fff]/.test(pair[1]!)?tr(pair[0]!,pair[1]!):value}

 const scoped=(path:string)=>{const id=sessionId();return id?path+(path.includes('?')?'&':'?')+'sessionId='+encodeURIComponent(id):path}
 const refresh=async()=>setState(await request<ExternalToolsState>(scoped('state')))
 const perform=async(id:string,operation:()=>Promise<void>)=>{
  if(inFlight.current)return;inFlight.current=true;setBusy(id);setError('');setNotice('')
  try{await operation()}catch(reason){setError(reason instanceof Error?reason.message:String(reason))}finally{inFlight.current=false;setBusy(undefined)}
 }
 useEffect(()=>{void perform('check',refresh)},[])
 // 系统编辑器可能持有opener进程直到窗口关闭；只锁文档重复打开，不占软件操作锁。
 const performDocument=async()=>{
  if(documentInFlight.current)return;documentInFlight.current=true;setDocumentPending(true);setDocumentError('')
  try{await openDocument()}catch(reason){setDocumentError(reason instanceof Error?reason.message:String(reason))}finally{documentInFlight.current=false;setDocumentPending(false)}
 }
 const edit=(_name:string)=>{void performDocument()}
 const acquire=async(id:string)=>{const r=await request<{jobId:string}>('acquire',{id,localDir:modelDirs[id],sessionId:sessionId()});await refresh();setNotice(tr('下载／安装请求已提交，进度和结果见下方：','Download / installation request submitted; inspect its progress and result below: ')+r.jobId)}
 const fastgs=async(action:'download'|'install'|'doctor')=>{const r=await fetch('/api/lyapunov/fastgs-tool',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});if(!r.ok)throw Error(await r.text());const value=await r.json() as {tool?:{ready?:{source:boolean;environment:boolean;trainable:boolean}};install?:{running:boolean;result?:{detail?:string;message?:string}}};setNotice(tr('FastGS 源码／环境／可训练：','FastGS source / environment / trainable: ')+[value.tool?.ready?.source,value.tool?.ready?.environment,value.tool?.ready?.trainable].map(v=>v===true?tr('已核','checked'):tr('未就绪','not ready')).join(' / ')+(value.install?.running?' · '+tr('后台安装处理中，稍后检查真实结果。','Acquisition is running; inspect its actual result later.'):value.install?.result?.detail??value.install?.result?.message??''))}
 const readJob=async(jobId:string)=>{const r=await request<{output:{text:string}[];nextOffset:number}>(scoped('job?jobId='+encodeURIComponent(jobId)+'&offset='+(offsets.current[jobId]??0)));offsets.current[jobId]=r.nextOffset;setLog(old=>(old+r.output.map(v=>v.text).join('')).slice(-8000));await refresh()}
 const entries=state?marketplaceEntries(state):[],filtered=filterMarketplace(entries,query,filter,availability)
 const installed=entries.filter(row=>row.installed===true||row.kind==='mcp')
 const visibleOptions=EXTERNAL_TOOL_OPTIONS.filter(option=>!query.trim()||[option.name,option.description,descriptionsEn[option.id],option.source].filter(Boolean).join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
 useEffect(()=>{
  const activeJobs=state?.installJobs.filter(job=>job.status==='running'||job.status==='stopping')??[];if(!activeJobs.length)return
  let live=true,pending=false
  const timer=setInterval(()=>{if(pending||inFlight.current)return;pending=true;void Promise.all(activeJobs.map(async row=>({id:row.jobId,...(await request<{job:{status:string;label:string;progress?:string;detail?:string}}>(scoped('job?jobId='+encodeURIComponent(row.jobId)+'&offset='+(offsets.current[row.jobId]??0)))).job}))).then(readings=>{if(live)setState(old=>old?{...old,installJobs:old.installJobs.map(row=>{const reading=readings.find(value=>value.id===row.jobId);return reading?{...row,status:reading.status,label:reading.label,progress:reading.progress??null,detail:reading.detail??null}:row})}:old)}).catch(reason=>{if(live)setError(reason instanceof Error?reason.message:String(reason))}).finally(()=>{pending=false})},1500)
  return()=>{live=false;clearInterval(timer)}
 },[state?.installJobs.map(job=>job.jobId+':'+job.status).join('|')])
 const mcpStatus=(status:string,count:number)=>tr(status==='connected'?'MCP 已握手':status==='unavailable'?'MCP 不可用':'MCP 已配置，尚无连接读数',status==='connected'?'MCP handshake connected':status==='unavailable'?'MCP unavailable':'Configured; no live connection reading')+' · '+count+' '+tr('个当前可见工具','currently visible tools')
 return <section aria-label={view==='downloads'?tr('可选下载软件包','Optional software downloads'):tr('软件与集成','Software and integrations')} style={{display:'grid',gap:14,padding:20}}>
  <h2 style={{margin:0}}>{view==='downloads'?tr('可选下载软件包','Optional software downloads'):tr('软件与集成','Software and integrations')}</h2>
  <p style={{margin:0,opacity:.75}}>{tr('直接检查已有软件、配置 MCP 和下载本地权重，无需先连接语言模型。软件、addon、MCP 握手和实际调用分别验收。','Inspect software, configure MCP and acquire local weights without a language model. Software, addons, MCP handshake and actual calls are separate checks.')}</p>
  <div><button disabled={!!busy} onClick={()=>void perform('check',refresh)}>{tr('检查已有／刷新','Inspect existing / refresh')}</button> <button disabled={documentPending} onClick={()=>void performDocument()}>{tr('打开原生 MCP 配置文档','Open native MCP configuration')}</button></div>
  {documentPending&&<p role='status'>{tr('原生文档打开请求仍在等待系统编辑器；软件操作可继续。','The native document opener is waiting for the system editor; software operations remain available.')}</p>}{documentError&&<p role='alert'>{displayDetail(documentError)}</p>}
  {error&&<p role='alert'>{displayDetail(error)}</p>}{notice&&<p role='status'>{notice}</p>}
  {view==='integrations'&&<><p style={{margin:0,opacity:.75}}>{tr('官方与内置插件保留在上方“插件列表”；这里提供软件下载、MCP 连接和技能。','Official and built-in plugins remain in the Plugin list tab above. Manage software downloads, MCP connections and skills here.')}</p>
  <div style={{display:'grid',gridTemplateColumns:'minmax(150px,200px) minmax(0,1fr)',gap:20}}>
  <aside aria-label={tr('集成分类与已安装条目','Integration categories and installed entries')} style={{borderRight:'1px solid var(--dsw-alias-border-l1,#7774)',paddingRight:14,display:'flex',flexDirection:'column',gap:8}}>
   <nav aria-label={tr('集成分类','Integration categories')} style={{display:'grid',gap:6}}>{([['all',tr('全部','All')],['software',tr('软件下载与安装','Software downloads')],['mcp',tr('MCP 插件','MCP plugins')],['skill',tr('技能','Skills')]] as const).map(([kind,label])=><button type='button' key={kind} aria-pressed={filter===kind} onClick={()=>{setFilter(kind);setDetail(undefined)}} style={{textAlign:'left',fontWeight:filter===kind?600:400}}>{label}</button>)}</nav>
   <strong style={{marginTop:12}}>{tr('已安装／已登记','Installed / registered')}</strong>
   {installed.map(row=><button type='button' key={row.id} onClick={()=>{setFilter(row.kind);setQuery('');setDetail(row.id)}} style={{textAlign:'left',overflowWrap:'anywhere'}}>{row.name}</button>)}
   {state&&!installed.length&&<small>{tr('未发现已安装条目。','No installed entries found.')}</small>}
  </aside>
  <div style={{display:'grid',gap:14,minWidth:0}}>
  <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
   <label>{tr('搜索软件、MCP 或技能','Search software, MCP or skills')} <input type='search' value={query} onChange={e=>setQuery(e.target.value)}/></label>
   <label>{tr('类型','Type')} <select value={filter} onChange={e=>setFilter(e.target.value as typeof filter)}><option value='all'>{tr('全部','All')}</option><option value='mcp'>MCP</option><option value='skill'>Skills</option><option value='software'>{tr('软件','Software')}</option></select></label>
   <label>{tr('可用性','Availability')} <select value={availability} onChange={e=>setAvailability(e.target.value as typeof availability)}><option value='all'>{tr('全部状态','All states')}</option><option value='available'>{tr('当前作用域可用','Available in this scope')}</option><option value='attention'>{tr('需要配置或检查','Needs configuration or inspection')}</option></select></label>
  </div>
  {state&&<small>{tr('最近探测：','Last inspected: ')}{new Date(state.capturedAt).toLocaleString()} · {tr('当前会话：','Current session: ')}{state.scopeSessionId??tr('未打开会话；以下是 profile 全局读数','No open session; profile-global reading')}</small>}
  {state?.skillsDetail&&<p role='status'>{state.skillsDetail}</p>}
  <div aria-label={tr('已发现的插件和技能','Discovered plugins and skills')} style={{display:'grid',gap:8}}>
   {filtered.map(row=><article key={row.id} style={{padding:12,border:'1px solid var(--dsw-alias-border-l1,#7774)',borderRadius:8}}>
    <strong>{row.name}</strong> · {row.kind==='skill'?'Skill':row.kind==='mcp'?'MCP':tr('软件','Software')}
    <p>{tr('已发现','Discovered')} · {row.kind==='mcp'?tr('已配置原生服务；桥接软件安装另查','Native server configured; bridge installation separate'):row.installed===true?tr('已安装／登记','Installed / registered'):row.installed===false?tr('未发现安装','Installation not found'):tr('安装状态未知','Installation unknown')} · {row.enabled===true?tr('已启用','Enabled'):row.enabled===false?tr('未启用','Disabled'):tr('启用状态另查','Enablement separate')} · {row.connected===true?tr('MCP 已握手','MCP connected'):row.connected===false?tr('未连接','Disconnected'):tr('连接不适用','Connection not applicable')} · {row.available===true?tr('当前作用域入口已注册','Entry registered in this scope'):tr('当前作用域尚未确认可用','Scope availability unconfirmed')}</p>
    <button type='button' onClick={()=>setDetail(detail===row.id?undefined:row.id)}>{tr('详情与来源','Details and source')}</button>
    {detail===row.id&&<div>
     <p>{displayDetail(row.description)}</p><p>{tr('来源／所有者：','Source / owner: ')}{row.source??tr('未知','Unknown')}</p><p>{tr('位置：','Location: ')}{row.location??tr('虚拟条目或未提供位置','Virtual item or no location supplied')}</p>
     {row.server&&<><p>{tr('配置 ID：','Configuration ID: ')}{row.server.id} · {row.server.transport}</p><p>{tr('命令／服务：','Command / endpoint: ')}{row.server.commandLocation??row.server.command??row.server.url??tr('由当前 scope 提供','Owned by this scope')}{row.server.port?' · port '+row.server.port:''}</p><p>{row.server.argsCount} {tr('个参数；秘密值不展示','arguments; secret values withheld')} · {row.server.tools.length} {tr('个当前工具','current tools')}</p><p>{tr('握手和工具注册不代表编辑器在线或工具调用已通过；addon、运行实例与实际结果另行核对。','Handshake and tool registration do not prove editor availability or successful calls; inspect the addon, running instance and actual result separately.')}</p><code style={{overflowWrap:'anywhere'}}>{row.server.tools.join(', ')||tr('没有当前工具；检查 addon／服务／连接','No current tools; inspect addon, server and connection')}</code><p>{tr('配置文件最近修改：','Configuration file last modified: ')}{row.server.modifiedAt?new Date(row.server.modifiedAt).toLocaleString():tr('未知；不猜安装者和安装时间','Unknown; installer identity and time are not inferred')}</p><button type='button' disabled={!!busy||!row.server.id} onClick={()=>edit(row.server!.serverName)}>{tr('配置或重连','Configure or reconnect')}</button>{row.server.canToggle&&<button type='button' disabled={!!busy} onClick={()=>void perform('enable',async()=>{await request('enable',{id:row.server!.nativeEntryId??row.server!.id,enabled:row.server!.enabled!==true});await refresh()})}>{row.server.enabled?tr('停用服务','Disable server'):tr('启用服务','Enable server')}</button>}</>}
     {row.skill&&<><p>{row.skill.modelInvocable?tr('允许模型加载','Model loading allowed'):tr('不允许模型加载','Model loading disabled')} · {row.skill.userInvocable?tr('允许用户调用','User invocation allowed'):tr('不允许用户调用','User invocation disabled')}</p><p>{row.skill.toolVisible?tr('当前原生 skill 工具可见','Native skill tool visible'):tr('当前 skill 工具不可见','Native skill tool not visible')} · {tr('调用入口：','Invocation: ')}<code>{'/'+row.skill.name}</code></p><p>{tr('这是原生目录摘要；加载正文与任务执行另外发生，安装不表示已经执行。使用模型仍需正常配置自有 provider。','This is native catalog metadata; loading instructions and running a task are separate. Model use still requires a configured personal provider.')}</p></>}
    </div>}
   </article>)}
   {state&&filtered.length===0&&<p>{tr('没有符合筛选的条目。','No matching entries.')}</p>}
  </div>
  {!!state?.associations?.length&&<fieldset><legend>{tr('已有安装与原生服务关联','Existing installations and native server association')}</legend>{state.associations.map(row=><div key={row.kind}><strong>{row.kind==='blender'?'Blender':'Unity'}</strong><p>{displayDetail(row.reason)}</p>{state.candidates?.filter(v=>v.kind===row.kind).map(v=><p key={v.id}><code>{v.requestedPath??v.path}</code>{v.requestedPath&&v.requestedPath!==v.path?<small> → {v.path}</small>:null} · {v.source}{v.version?' · '+v.packageName+' '+v.version:''}{v.owner?' · '+v.owner:''}{v.repository&&<a href={v.repository} target='_blank' rel='noreferrer'>{tr('来源','Source')}</a>}{v.addonPath&&<small> · addon {v.addonExists?tr('文件存在，启用另查','file exists; activation separate'):tr('文件缺失','file missing')} {v.addonPath}</small>}</p>)}{row.status==='associated'&&row.serverName&&<button type='button' disabled={!!busy} onClick={()=>edit(row.serverName!)}>{tr('打开已关联服务配置','Open associated server configuration')}</button>}{row.status==='not-configured'&&<button type='button' disabled={!!busy} onClick={()=>edit(row.kind)}>{tr('在原生文档中关联','Associate in native document')}</button>}{row.status==='ambiguous'&&<label>{tr('选择服务配置','Choose server configuration')} <select defaultValue='' onChange={e=>{if(e.target.value)edit(e.target.value)}}><option value=''>{tr('请选择，不自动替换','Choose; no automatic replacement')}</option>{state.mcp.filter(v=>row.serverIds.includes(v.id)).map(v=><option key={v.id} value={v.serverName}>{v.serverName+' · '+v.id}</option>)}</select></label>}</div>)}</fieldset>}
  </div></div></>}
  {view==='downloads'&&<label>{tr('搜索可选软件包','Search optional software packages')} <input type='search' value={query} onChange={e=>setQuery(e.target.value)}/></label>}
  {view==='downloads'&&(filter==='all'||filter==='software'||filter==='mcp')&&<section aria-label={tr(filter==='mcp'?'MCP 安装与连接':'软件下载与安装',filter==='mcp'?'MCP installation and connection':'Software downloads and installation')} style={{display:'grid',gap:12}}><h3 style={{margin:0}}>{tr(filter==='mcp'?'MCP 安装与连接':'软件下载与安装',filter==='mcp'?'MCP installation and connection':'Software downloads and installation')}</h3>
  {visibleOptions.filter(option=>filter==='mcp'?option.kind==='bridge':filter==='software'?option.kind!=='bridge':true).map(option=>{
   const reading=state?.software.find(v=>v.id===option.id),kind=['blender','blender-mcp'].includes(option.id)?'blender':['unity','unity-mcp'].includes(option.id)?'unity':undefined,association=state?.associations?.find(v=>v.kind===kind),bridge=kind?(association?.status==='associated'?association.serverName??kind:kind):option.id==='mcp'?'':undefined,row=bridge?state?.mcp.find(v=>v.serverName===bridge):undefined
   return <article key={option.id} data-tool-id={option.id} style={{padding:14,border:'1px solid var(--dsw-alias-border-l1,#7774)',borderRadius:8,display:'grid',gap:8}}>
    <strong>{option.id==='mcp'?tr(option.name,'Other MCP services'):option.name}</strong><p style={{margin:0}}>{tr(option.description,descriptionsEn[option.id]??option.description)}</p>
    {reading&&<p style={{margin:0}}>{reading.version??''} {displayDetail(reading.detail)}</p>}
    {bridge!==undefined&&<p style={{margin:0}}>{row?mcpStatus(row.status,row.tools.length):tr('MCP 未配置／未发现；安装软件不会自动建立连接。','MCP not configured/discovered; installing software does not create a connection.')}</p>}
    {option.id==='blender-mcp'&&state&&<><p style={{margin:0}}>{displayDetail(state.blenderSupply.detail)}</p><small>{tr('Addon 文件：','Addon file: ')}{state.blenderSupply.addon}</small>{state.blenderSupply.existingCommand&&<small>{tr('检测到已有桥接命令（版本兼容性、addon 与握手另验）：','Detected existing bridge command (compatibility, addon and handshake remain separate): ')}{state.blenderSupply.existingCommand}</small>}<p style={{margin:0}}>{tr('在 Blender Preferences → Add-ons 中启用已选 addon，再在侧栏启动端口服务。此处不会打开、重启或替换你的 Blender 工程。','Enable the selected addon in Blender Preferences → Add-ons, then start its side-panel server. This form does not open, restart or replace your Blender project.')}</p></>}
    <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
     <button disabled={!!busy} onClick={()=>void perform('check',refresh)}>{tr('检查已有','Inspect existing')}</button>
     {bridge!==undefined&&<button disabled={!!busy} onClick={()=>edit(bridge)}>{tr('连接／配置 MCP','Connect / configure MCP')}</button>}
     {option.kind==='software'&&<button type='button' disabled={!!busy} onClick={()=>void perform(option.id,()=>acquire(option.id))}>{tr('官方下载／安装','Download / install from official source')}</button>}
     {option.kind==='software'&&option.source&&<a href={option.source} target='_blank' rel='noreferrer'>{tr('官方下载安装页面','Official download and installation page')}</a>}
     {(option.id==='blender-mcp'||option.id==='unity-mcp')&&<button disabled={!!busy} onClick={()=>void perform(option.id,()=>acquire(option.id))}>{tr('下载／供给锁定桥接','Acquire locked bridge')}</button>}
     {option.id==='fastgs'&&<><button disabled={!!busy} onClick={()=>void perform('fastgs',()=>fastgs('doctor'))}>{tr('检查 FastGS','Inspect FastGS')}</button><button disabled={!!busy} onClick={()=>void perform('fastgs',()=>fastgs('download'))}>{tr('下载官方源码','Download official source')}</button><button disabled={!!busy} onClick={()=>void perform('fastgs',()=>fastgs('install'))}>{tr('安装隔离环境','Install isolated environment')}</button></>}
     <button disabled={!!busy} onClick={()=>void perform(option.id,async()=>{await start(option.id,close)})}>{tr('新会话助手安装','Install with assistant in a new chat')}</button>
    </div>
    {option.kind==='software'&&<small>{tr('系统会打开对应平台的官方安装页面；完成安装后点“检查已有”。MCP 插件需单独连接。','The system opens the official platform installer page. After installation, inspect the existing software. Connect its MCP plugin separately.')}</small>}
    {option.kind==='model'&&<><label>{tr('本地权重绝对目录','Absolute local weights directory')} <input value={modelDirs[option.id]??''} onChange={e=>setModelDirs({...modelDirs,[option.id]:e.target.value})} placeholder='/absolute/model-directory'/></label><button disabled={!!busy||!modelDirs[option.id]?.trim()} onClick={()=>void perform(option.id,()=>acquire(option.id))}>{tr('直接下载目录锁定权重','Download catalogued weights directly')}</button><small>{tr('仅使用 hf-mirror.com；镜像缺文件、访问授权或校验失败时阻断，不切官方端点。下载不等于推理可用。','Only hf-mirror.com; missing files, access or validation block the download. Acquisition does not prove inference readiness.')}</small></>}
    {option.source&&option.kind!=='software'&&<a href={option.source} target='_blank' rel='noreferrer'>{tr('项目来源','Project source')}</a>}
   </article>
  })}
  </section>}
  {view==='integrations'&&!!state?.mcp.length&&<fieldset><legend>{tr('当前原生 MCP 工具清单','Current native MCP tool inventory')}</legend>{state.mcp.map(row=><div key={row.id+row.serverName} style={{padding:6}}><strong>{row.serverName}</strong> · {row.transport} · {mcpStatus(row.status,row.tools.length)}<small style={{display:'block'}}>{row.command??row.url??''}</small>{row.detail&&<p>{displayDetail(row.detail)}</p>}<code>{row.tools.join(', ')||tr('暂无工具；检查 addon、服务端、握手和 scope。','No tools; inspect addon, server, handshake and scope.')}</code> <button disabled={!!busy||!row.id} onClick={()=>edit(row.serverName)}>{tr('配置','Configure')}</button></div>)}</fieldset>}
  {!!state?.installJobs.length&&<fieldset><legend>{tr('原生下载／安装作业','Native acquisition jobs')}</legend>{state.installJobs.map(job=><div key={job.jobId}>{job.jobId} · {job.status} · {displayDetail(job.progress??job.detail??job.label)} <button disabled={!!busy} onClick={()=>void perform('output',()=>readJob(job.jobId))}>{tr('读回实际输出','Read actual output')}</button></div>)}{log&&<pre style={{whiteSpace:'pre-wrap',maxHeight:240,overflow:'auto'}}>{log}</pre>}</fieldset>}
 </section>
}
export function applyExternalToolsSettings(ctx:Context):void {
 ctx.inject(['slots','locale','remote','remote.settings'],owner=>{
 const t=owner.locale.bind('lyapunov'),tr:Translate=(zh,en)=>t('open')==='Scene workbench'?en:zh
 let openingDocument:Promise<void>|undefined
 const openDocument=()=>openingDocument??=(async()=>{const r=await owner.remote.settings.openSettingsDocument();if(!r.ok)throw Error(r.error.message)})().finally(()=>{openingDocument=undefined})
 for(const [id,order,view,zh,en] of [['lyapunov-integrations',19,'integrations','软件与集成','Software and integrations'],['lyapunov-downloads',50,'downloads','可选下载软件包','Optional software downloads']] as const){
 owner.slots.inject('settings.section',()=>owner.slots.register({name:'settings.section',id,order,label:()=>tr(zh,en),inject:()=>({view,tr,close:()=>{closeTopModal(document)},start:(id:string,close:()=>void)=>startExternalInstallSession(owner,id,close),sessionId:()=>mainSessionId((owner.get('sessions') as unknown as ISessions).list.getSnapshot()),openDocument})},ExternalToolsSettings))
 }
 })
}
