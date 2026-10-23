import {useEffect,useRef,useState} from 'react'
import type {Context} from '@deepseek-ai/cordis'
import {Button,Input,SegmentedControl,Switch,IconSearchOutlineRegular,IconRefreshOutlineRegular,closeTopModal} from '@deepseek-ai/dsh-client-ui-primitives'
import type {ISessions} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import {EXTERNAL_TOOL_OPTIONS} from './external-tools.ts'
import {mainSessionId} from './history-navigation.ts'
import {startExternalInstallSession} from './external-install-session.ts'
import type {ExternalToolsState} from './external-tools-state.ts'
import {marketplaceEntries,filterMarketplace,type MarketplaceEntry,type IntegrationAssociation} from './plugin-marketplace.ts'
import {SettingsPage,SettingsHeading,SettingsListRow,SettingsField,SettingsDetails,SettingsSelect,SettingsStatus} from './settings-ui.tsx'

type Translate=(zh:string,en:string)=>string
const integrationNames={blender:'Blender',unity:'Unity','computer-use-linux':'Computer Use for Linux'} satisfies Record<IntegrationAssociation['kind'],string>
const descriptionsEn:Record<string,string>={blender:'3D modeling and a separately configured editor bridge.',unity:'Unity Hub/editor and a separately configured editor bridge.',sam3:'Local image segmentation; gated access must succeed through the HF mirror.',sam3d:'Downloadable weights; no SAM 3D Objects runtime adapter.',da3:'DA3 BASE weights. The current depth adapter uses DA-V2.','blender-mcp':'Third-party mcp-for-blender service and Blender addon, locked by this product.','unity-mcp':'Third-party CoplayDev bridge; addon, endpoint and tools are separate checks.',fastgs:'Optional official FastGS source and isolated environment.',mcp:'Configure an MCP service without requiring a language model.'}
async function request<T>(path:string,body?:unknown):Promise<T>{
 const response=await fetch('/api/lyapunov/external-tools/'+path,body===undefined?undefined:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
 const value=await response.json() as T&{error?:string};if(!response.ok)throw Error(value.error??'外部工具操作失败。 / External tool operation failed.');return value
}
interface Props {view?:'integrations'|'downloads';tr:Translate;start:(id:string,close:()=>void)=>Promise<string>;close:()=>void;sessionId:()=>string|undefined;openDocument:()=>Promise<void>}
/** 单个设置面复用原生 profile、MCP 与 Jobs；安装助手只是可选入口。 */
export function ExternalToolsSettings({view='integrations',tr,start,close,sessionId,openDocument}:Props) {
 const [busy,setBusy]=useState<string>(),[error,setError]=useState(''),[notice,setNotice]=useState(''),[state,setState]=useState<ExternalToolsState>()
 const [modelDirs,setModelDirs]=useState<Record<string,string>>({}),[logs,setLogs]=useState<Record<string,string>>({})
 const [packageFilter,setPackageFilter]=useState<'all'|'apps'|'bridges'|'models'>('all')
 const [fastgsReading,setFastgsReading]=useState<{source:boolean;environment:boolean;trainable:boolean}>()
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
 const fastgs=async(action:'download'|'install'|'doctor')=>{const r=await fetch('/api/lyapunov/fastgs-tool',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});if(!r.ok)throw Error(await r.text());const value=await r.json() as {tool?:{ready?:{source:boolean;environment:boolean;trainable:boolean}};install?:{running:boolean;result?:{detail?:string;message?:string}}};setFastgsReading(value.tool?.ready);setNotice(tr('FastGS 源码／环境／可训练：','FastGS source / environment / trainable: ')+[value.tool?.ready?.source,value.tool?.ready?.environment,value.tool?.ready?.trainable].map(v=>v===true?tr('已核','checked'):tr('未就绪','not ready')).join(' / ')+(value.install?.running?' · '+tr('后台安装处理中，稍后检查真实结果。','Acquisition is running; inspect its actual result later.'):value.install?.result?.detail??value.install?.result?.message??''))}
 const readJob=async(jobId:string)=>{const r=await request<{output:{text:string}[];nextOffset:number}>(scoped('job?jobId='+encodeURIComponent(jobId)+'&offset='+(offsets.current[jobId]??0)));offsets.current[jobId]=r.nextOffset;setLogs(old=>({...old,[jobId]:((old[jobId]??'')+r.output.map(v=>v.text).join('')).slice(-8000)}));await refresh()}
 const entries=state?marketplaceEntries(state):[],filtered=filterMarketplace(entries,query,filter,availability)
 const visibleOptions=EXTERNAL_TOOL_OPTIONS.filter(option=>!query.trim()||[option.name,option.description,descriptionsEn[option.id],option.source].filter(Boolean).join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
 useEffect(()=>{
  const activeJobs=state?.installJobs.filter(job=>job.status==='running'||job.status==='stopping')??[];if(!activeJobs.length)return
  let live=true,pending=false
  const timer=setInterval(()=>{if(pending||inFlight.current)return;pending=true;void Promise.all(activeJobs.map(async row=>({id:row.jobId,...(await request<{job:{status:string;label:string;progress?:string;detail?:string}}>(scoped('job?jobId='+encodeURIComponent(row.jobId)+'&offset='+(offsets.current[row.jobId]??0)))).job}))).then(readings=>{if(live)setState(old=>old?{...old,installJobs:old.installJobs.map(row=>{const reading=readings.find(value=>value.id===row.jobId);return reading?{...row,status:reading.status,label:reading.label,progress:reading.progress??null,detail:reading.detail??null}:row})}:old)}).catch(reason=>{if(live)setError(reason instanceof Error?reason.message:String(reason))}).finally(()=>{pending=false})},1500)
  return()=>{live=false;clearInterval(timer)}
 },[state?.installJobs.map(job=>job.jobId+':'+job.status).join('|')])
 const mcpStatus=(status:string,count:number)=>status==='connected'?tr('已连接','Connected')+' · '+count+' tools':status==='unavailable'?tr('不可用','Unavailable'):tr('已配置','Configured')
 const selectedOption=view==='downloads'?EXTERNAL_TOOL_OPTIONS.find(row=>row.id===detail):undefined
 const selectedEntry=view==='integrations'?entries.find(row=>row.id===detail):undefined
 const displayOrder=['blender','unity','blender-mcp','unity-mcp','sam3','sam3d','da3','fastgs','mcp']
 const versionText=(id:string,version?:string)=>id==='blender'?version?.replace(/^Blender\s+/i,''):version
 const packageRows=visibleOptions.slice().sort((a,b)=>displayOrder.indexOf(a.id)-displayOrder.indexOf(b.id)).filter(option=>packageFilter==='all'||packageFilter==='apps'&&(option.kind==='software'||option.kind==='tool')||packageFilter==='bridges'&&option.kind==='bridge'||packageFilter==='models'&&option.kind==='model')
 const optionName=(id:string)=>EXTERNAL_TOOL_OPTIONS.find(row=>row.id===id)?.name??id
 const pageTitle=view==='downloads'?tr('下载','Downloads'):tr('集成','Integrations')
 const connectionFor=(id:string)=>{
  const kind=id==='blender'||id==='blender-mcp'?'blender':id==='unity'||id==='unity-mcp'?'unity':undefined
  const association=state?.associations?.find(row=>row.kind===kind)
  const server=association?.status==='associated'?state?.mcp.find(row=>row.serverName===association.serverName):undefined
  return {kind,association,server}
 }
 const packageStatus=(id:string)=>{
  const option=EXTERNAL_TOOL_OPTIONS.find(row=>row.id===id)!,reading=state?.software.find(row=>row.id===id),{server}=connectionFor(id)
  if(option.kind==='bridge')return server?.status==='connected'?tr('已连接','Connected'):id==='blender-mcp'&&state?.blenderSupply.ready?tr('桥接已供给','Bridge available'):tr('待配置','Configure')
  if(option.kind==='model')return reading?.installed===true?tr('权重已下载','Weights downloaded'):reading?.installed===false?tr('未下载','Not downloaded'):tr('待检查','Not checked')
  if(id==='fastgs')return fastgsReading?.trainable?tr('可训练检查通过','Trainability checked'):fastgsReading?.source?tr('源码已下载','Source downloaded'):tr('检查配置','Check setup')
  return reading?.installed===true?[tr('已安装','Installed'),versionText(id,reading.version)].filter(Boolean).join(' · '):reading?.installed===false?tr('未发现','Not detected'):tr('待检查','Not checked')
 }
 const entryStatus=(row:MarketplaceEntry)=>row.kind==='mcp'?row.server?.status==='connected'?tr('已连接','Connected')+' · '+row.server.tools.length+' tools':row.server?.status==='unavailable'?tr('不可用','Unavailable'):tr('已配置','Configured'):row.kind==='skill'?row.available?tr('当前作用域可用','Available'):tr('待检查作用域','Check scope'):row.installed===true?tr('已安装','Installed'):row.installed===false?tr('未发现','Not detected'):tr('待检查','Not checked')
 const refreshButton=<Button size='sm' title={tr('刷新','Refresh')} aria-label={tr('刷新','Refresh')} icon={<IconRefreshOutlineRegular size={16}/>} disabled={!!busy} onClick={()=>void perform('check',refresh)}/>
 const selectedReading=selectedOption?state?.software.find(row=>row.id===selectedOption.id):undefined
 const selectedConnection=selectedOption?connectionFor(selectedOption.id):undefined
 return <SettingsPage label={pageTitle}>
  <SettingsHeading title={selectedOption?selectedOption.id==='mcp'?tr('其他 MCP 服务','Other MCP services'):selectedOption.name:selectedEntry?selectedEntry.kind==='software'?optionName(selectedEntry.name):selectedEntry.name:pageTitle} actions={refreshButton} back={detail?()=>setDetail(undefined):undefined} backLabel={pageTitle}/>
  {documentPending&&<p className='lya-settings-message' role='status'>{tr('正在等待系统编辑器；其它软件操作可继续。','Waiting for the system editor; other operations remain available.')}</p>}
  {documentError&&<p className='lya-settings-message' role='alert'>{displayDetail(documentError)}</p>}
  {error&&<p className='lya-settings-message' role='alert'>{displayDetail(error)}</p>}
  {notice&&<p className='lya-settings-message' role='status'>{displayDetail(notice)}</p>}
  {!state&&!error&&<p className='lya-settings-message' role='status'>{tr('正在检查…','Inspecting…')}</p>}
  {!detail&&<>
   <div className='lya-settings-toolbar'><Input className="lya-settings-search" type='search' icon={<IconSearchOutlineRegular size={16}/>} placeholder={view==='downloads'?tr('搜索软件包','Search packages'):tr('搜索软件、MCP 或技能','Search software, MCP or skills')} aria-label={tr('搜索','Search')} value={query} onChange={e=>setQuery(e.target.value)}/></div>
   {view==='downloads'?<>
    <SegmentedControl className='lya-settings-filter' id='lya-settings-packages' label={tr('软件包分类','Package type')} value={packageFilter} onChange={setPackageFilter} options={[{value:'all',label:tr('全部','All')},{value:'apps',label:tr('软件','Apps')},{value:'bridges',label:tr('桥接','Bridges')},{value:'models',label:tr('模型','Models')}]}/>
    <div id={'lya-settings-packages-'+packageFilter+'-panel'} role='tabpanel' aria-labelledby={'lya-settings-packages-'+packageFilter} className='lya-settings-list' aria-label={tr('可选软件包','Optional packages')}>
     {packageRows.map(option=><SettingsListRow key={option.id} name={option.id==='mcp'?tr('其他 MCP 服务','Other MCP services'):option.name} status={packageStatus(option.id)} onClick={()=>setDetail(option.id)}/>)}
     {!packageRows.length&&<p className='lya-settings-caption'>{tr('没有匹配的软件包。','No matching packages.')}</p>}
    </div>
   </>:<>
    <div className='lya-settings-toolbar'><SegmentedControl className='lya-settings-filter' id='lya-settings-integrations' label={tr('集成分类','Integration type')} value={filter} onChange={setFilter} options={[{value:'all',label:tr('全部','All')},{value:'software',label:tr('软件','Software')},{value:'mcp',label:'MCP'},{value:'skill',label:'Skills'}]}/>
    <SettingsSelect compact label={tr('状态筛选','Availability')} value={availability} onChange={value=>setAvailability(value as typeof availability)} options={[{value:'all',label:tr('全部状态','All states')},{value:'available',label:tr('可用','Available')},{value:'attention',label:tr('需要检查','Needs attention')}]}/></div>
    <div id={'lya-settings-integrations-'+filter+'-panel'} role='tabpanel' aria-labelledby={'lya-settings-integrations-'+filter} className='lya-settings-list' aria-label={tr('集成清单','Integration list')}>
     {filtered.map(row=><SettingsListRow key={row.id} name={row.kind==='software'?optionName(row.name):row.name} status={entryStatus(row)} onClick={()=>setDetail(row.id)}/>)}
     {state&&!filtered.length&&<p className='lya-settings-caption'>{tr('没有匹配的条目。','No matching entries.')}</p>}
    </div>
    <SettingsDetails title={tr('安装关联','Installation associations')}>
     {state?.associations?.map(row=><div key={row.kind}>
      <h3>{integrationNames[row.kind]}</h3><p className='lya-settings-caption'>{displayDetail(row.reason)}</p>
      {state.candidates?.filter(v=>v.kind===row.kind).map(v=><p className='lya-settings-caption' key={v.id}><code>{v.requestedPath??v.path}</code>{v.requestedPath&&v.requestedPath!==v.path?' → '+v.path:''} · {v.source}{v.version?' · '+v.packageName+' '+v.version:''}{v.owner?' · '+v.owner:''}{v.repository&&<> · <a href={v.repository} target='_blank' rel='noreferrer'>{tr('来源','Source')}</a></>}{v.addonPath&&<> · addon {v.addonExists?tr('文件存在，启用另查','file found; activation not checked'):tr('文件缺失','file missing')} <code>{v.addonPath}</code></>}</p>)}
      <Button size='sm' disabled={documentPending} onClick={()=>edit(row.serverName??row.kind)}>{tr('打开原生配置','Open native configuration')}</Button>
      {row.status==='ambiguous'&&<SettingsSelect label={tr('服务配置','Server configuration')} value='' onChange={value=>{if(value)edit(value)}} options={[{value:'',label:tr('选择服务','Choose a server')},...(state?.mcp.filter(v=>row.serverIds.includes(v.id)).map(v=>({value:v.serverName,label:v.serverName+' · '+v.id}))??[])]}/>}
     </div>)}
    </SettingsDetails>
    <SettingsDetails title={tr('作用域与探测','Scope & inspection')}><p className='lya-settings-caption'>{tr('最近检查：','Last inspected: ')}{state?new Date(state.capturedAt).toLocaleString():'—'}</p><p className='lya-settings-caption'>{tr('会话：','Session: ')}{state?.scopeSessionId??tr('Profile 全局','Profile-global')}</p>{state?.skillsDetail&&<p className='lya-settings-message'>{displayDetail(state.skillsDetail)}</p>}</SettingsDetails>
    <div className='lya-settings-actions'><Button size='sm' disabled={documentPending} onClick={()=>void performDocument()}>{tr('原生 MCP 配置','Native MCP configuration')}</Button></div>
   </>}
  </>}
  {selectedEntry&&<>
   <dl className='lya-settings-fields'>
    <SettingsField label={tr('类型','Type')}>{selectedEntry.kind==='skill'?'Skill':selectedEntry.kind==='mcp'?'MCP':tr('软件','Software')}</SettingsField>
    <SettingsField label={tr('状态','Status')}>{selectedEntry.server?mcpStatus(selectedEntry.server.status,selectedEntry.server.tools.length).split(' · ')[0]:entryStatus(selectedEntry)}</SettingsField>
    {selectedEntry.server&&<><SettingsField label={tr('传输','Transport')}>{selectedEntry.server.transport}</SettingsField><SettingsField label={tr('当前工具','Current tools')}>{selectedEntry.server.tools.length}</SettingsField><SettingsField label={tr('当前作用域','Current scope')}>{selectedEntry.server.currentScope===true?tr('是','Yes'):tr('未确认','Unconfirmed')}</SettingsField></>}
    {selectedEntry.skill&&<><SettingsField label={tr('调用入口','Invocation')}><code>/{selectedEntry.skill.name}</code></SettingsField><SettingsField label={tr('模型加载','Model loading')}>{selectedEntry.skill.modelInvocable?tr('允许','Allowed'):tr('不允许','Disabled')}</SettingsField><SettingsField label={tr('用户调用','User invocation')}>{selectedEntry.skill.userInvocable?tr('允许','Allowed'):tr('不允许','Disabled')}</SettingsField><SettingsField label={tr('工具可见','Tool visibility')}>{selectedEntry.skill.toolVisible?tr('可见','Visible'):tr('不可见','Not visible')}</SettingsField></>}
   </dl>
   {selectedEntry.server&&<div className='lya-settings-actions'><Button size='sm' variant='primary' disabled={documentPending} onClick={()=>edit(selectedEntry.server!.serverName)}>{tr('打开原生配置','Open native configuration')}</Button>{selectedEntry.server.canToggle&&<span className='lya-settings-status'><span>{selectedEntry.server.enabled!==false?tr('已启用','Enabled'):tr('已停用','Disabled')}</span><Switch label={tr('启用服务','Enable server')} checked={selectedEntry.server.enabled!==false} disabled={!!busy||!state?.writable} onChange={enabled=>void perform('enable',async()=>{await request('enable',{id:selectedEntry.server!.nativeEntryId??selectedEntry.server!.id,enabled});await refresh()})}/></span>}</div>}
   <SettingsDetails title={tr('来源与位置','Source & location')}><p className='lya-settings-caption'>{displayDetail(selectedEntry.description)}</p><dl className='lya-settings-fields'><SettingsField label={tr('来源／所有者','Source / owner')}>{selectedEntry.source??tr('未知','Unknown')}</SettingsField><SettingsField label={tr('位置','Location')}><code>{selectedEntry.location??tr('未提供','Not supplied')}</code></SettingsField></dl></SettingsDetails>
   {selectedEntry.server&&<>
    <SettingsDetails title={tr('工具清单','Available tools')} meta={selectedEntry.server.tools.length}><pre>{selectedEntry.server.tools.join('\n')||tr('当前没有可见工具。','No tools currently visible.')}</pre></SettingsDetails>
    <SettingsDetails title={tr('配置与诊断','Configuration & diagnostics')}><dl className='lya-settings-fields'><SettingsField label={tr('配置 ID','Configuration ID')}>{selectedEntry.server.id}</SettingsField><SettingsField label={tr('命令／服务','Command / endpoint')}><code>{selectedEntry.server.commandLocation??selectedEntry.server.command??selectedEntry.server.url??'—'}</code>{selectedEntry.server.port?' · port '+selectedEntry.server.port:''}</SettingsField><SettingsField label={tr('参数数量','Arguments')}>{selectedEntry.server.argsCount}</SettingsField><SettingsField label={tr('最近修改','Last modified')}>{selectedEntry.server.modifiedAt?new Date(selectedEntry.server.modifiedAt).toLocaleString():tr('未知','Unknown')}</SettingsField></dl><p className='lya-settings-caption'>{tr('握手与工具发现已单独记录；编辑器在线状态和实际调用另查。','Handshake and tool discovery are separate from editor availability and actual calls.')}</p></SettingsDetails>
   </>}
   {selectedEntry.skill&&<SettingsDetails title={tr('可用性说明','Availability details')}><p className='lya-settings-caption'>{tr('这里显示原生技能目录。加载技能正文与执行任务发生在会话中。','This is the native skill catalog. Instructions are loaded and tasks are run in the conversation.')}</p></SettingsDetails>}
  </>}
  {selectedOption&&<>
   <dl className='lya-settings-fields'>
    <SettingsField label={tr('状态','Status')}>{selectedOption.kind==='software'&&selectedReading?.installed===true?tr('已安装','Installed'):packageStatus(selectedOption.id)}</SettingsField>
    {selectedReading?.version&&<SettingsField label={tr('版本','Version')}>{versionText(selectedOption.id,selectedReading.version)}</SettingsField>}
    {selectedConnection?.kind&&<><SettingsField label='MCP'>{selectedConnection.server?mcpStatus(selectedConnection.server.status,selectedConnection.server.tools.length):tr('未配置／未发现','Not configured / discovered')}</SettingsField><SettingsField label={tr('实际调用','Tool execution')}>{tr('未检查','Not checked')}</SettingsField></>}
    {selectedOption.kind==='model'&&<SettingsField label={tr('运行支持','Runtime')}>{['sam3d','da3'].includes(selectedOption.id)?tr('尚未集成','Not integrated'):tr('未检查','Not checked')}</SettingsField>}
    {selectedOption.id==='fastgs'&&(['source','environment','trainable'] as const).map((key,index)=><SettingsField key={key} label={[tr('源码','Source'),tr('环境','Environment'),tr('可训练','Trainable')][index]!}>{fastgsReading?fastgsReading[key]?tr('检查通过','Checked'):tr('未就绪','Not ready'):tr('待检查','Not checked')}</SettingsField>)}
   </dl>
   {selectedOption.kind==='model'&&<label className='lya-settings-search-label'><span>{tr('本地权重目录','Local weights directory')}</span><Input value={modelDirs[selectedOption.id]??''} onChange={e=>setModelDirs({...modelDirs,[selectedOption.id]:e.target.value})} placeholder='/absolute/model-directory'/></label>}
   <div className='lya-settings-actions'>
    {selectedOption.kind==='model'&&<Button size='sm' variant='primary' disabled={!!busy||!modelDirs[selectedOption.id]?.trim()} onClick={()=>void perform(selectedOption.id,()=>acquire(selectedOption.id))}>{tr('下载权重','Download weights')}</Button>}
    {selectedOption.id!=='fastgs'&&<Button size='sm' disabled={!!busy} onClick={()=>void perform('check',refresh)}>{tr('检查已有','Inspect existing')}</Button>}
    {(selectedConnection?.kind||selectedOption.id==='mcp')&&<Button size='sm' disabled={documentPending} onClick={()=>edit(selectedConnection?.server?.serverName??selectedConnection?.kind??'')}>{tr('打开 MCP 配置','Open MCP configuration')}</Button>}
    {selectedOption.id==='fastgs'&&<Button size='sm' disabled={!!busy} onClick={()=>void perform('fastgs',()=>fastgs('doctor'))}>{tr('检查 FastGS','Inspect FastGS')}</Button>}
   </div>
   {selectedOption.kind==='model'&&<p className='lya-settings-caption'>{tr('来源仅为 hf-mirror.com；访问或校验失败会显示具体阻断。','Source: hf-mirror.com only. Access or validation failures show the exact blocker.')}</p>}
   {selectedOption.id==='fastgs'&&<div className='lya-settings-actions'><Button size='sm' disabled={!!busy} onClick={()=>void perform('fastgs',()=>fastgs('download'))}>{tr('下载官方源码','Download official source')}</Button><Button size='sm' disabled={!!busy} onClick={()=>void perform('fastgs',()=>fastgs('install'))}>{tr('安装隔离环境','Install isolated environment')}</Button></div>}
   {selectedOption.id==='blender-mcp'&&<SettingsDetails title={tr('编辑器 Addon','Editor addon')}><p className='lya-settings-caption'>{displayDetail(state?.blenderSupply.detail)}</p><code>{state?.blenderSupply.addon}</code>{state?.blenderSupply.existingCommand&&<code>{state.blenderSupply.existingCommand}</code>}<p className='lya-settings-caption'>{tr('在 Blender Preferences → Add-ons 启用所选 Addon，再启动其侧栏服务。','Enable the selected addon in Blender Preferences → Add-ons, then start its side-panel server.')}</p></SettingsDetails>}
   <SettingsDetails title={tr('安装选项','Installation options')}>
    {selectedOption.kind==='software'&&<Button size='sm' variant='outline' disabled={!!busy} onClick={()=>void perform(selectedOption.id,()=>acquire(selectedOption.id))}>{tr('打开官方安装入口','Open official installer')}</Button>}
    {(selectedOption.id==='blender-mcp'||selectedOption.id==='unity-mcp')&&<Button size='sm' variant='outline' disabled={!!busy} onClick={()=>void perform(selectedOption.id,()=>acquire(selectedOption.id))}>{tr('供给／修复锁定桥接','Acquire / repair locked bridge')}</Button>}
    {selectedOption.source&&<a href={selectedOption.source} target='_blank' rel='noreferrer'>{tr('项目／官方来源','Project / official source')} ↗</a>}
    <Button size='sm' disabled={!!busy} onClick={()=>void perform(selectedOption.id,async()=>{await start(selectedOption.id,close)})}>{tr('在新会话中用助手安装','Install with assistant in a new chat')}</Button>
    {selectedOption.kind==='software'&&<p className='lya-settings-caption'>{tr('完成官方安装后，再检查已有软件。MCP 需单独配置。','After completing the official installation, inspect the software. Configure MCP separately.')}</p>}
   </SettingsDetails>
   <SettingsDetails title={tr('来源与安装详情','Source & installation details')}><p className='lya-settings-caption'>{tr(selectedOption.description,descriptionsEn[selectedOption.id]??selectedOption.description)}</p>{selectedReading&&<><p className='lya-settings-message'>{displayDetail(selectedReading.detail)}</p>{selectedReading.location&&<code>{selectedReading.location}</code>}<p className='lya-settings-caption'>{selectedReading.adapter}</p></>}</SettingsDetails>
  </>}
  <SettingsDetails title={tr('安装活动','Activity')} meta={state?.installJobs.length??0}>
   {!state?.installJobs.length&&<p className='lya-settings-caption'>{tr('暂无安装作业。','No installation jobs.')}</p>}
   {state?.installJobs.map(job=><div key={job.jobId}><div className='lya-settings-title-meta'><h3>{job.registryId?optionName(job.registryId):job.label}</h3><SettingsStatus state={job.status==='running'||job.status==='stopping'?'ongoing':job.status==='completed'?'done':job.status==='failed'?'error':'idle'}>{job.status}</SettingsStatus></div><p className='lya-settings-message'>{displayDetail(job.progress??job.detail??job.label)}</p><Button size='sm' disabled={!!busy} onClick={()=>void perform('output',()=>readJob(job.jobId))}>{tr('读取实际输出','View output')}</Button>{logs[job.jobId]&&<pre>{logs[job.jobId]}</pre>}<p className='lya-settings-caption'>{job.jobId}</p></div>)}
  </SettingsDetails>
 </SettingsPage>
}
export function applyExternalToolsSettings(ctx:Context):void {
 ctx.inject(['slots','locale','remote','remote.settings'],owner=>{
 const t=owner.locale.bind('lyapunov'),tr:Translate=(zh,en)=>t('open')==='Scene workbench'?en:zh
 let openingDocument:Promise<void>|undefined
 const openDocument=()=>openingDocument??=(async()=>{const r=await owner.remote.settings.openSettingsDocument();if(!r.ok)throw Error(r.error.message)})().finally(()=>{openingDocument=undefined})
 for(const [id,order,view,zh,en] of [['lyapunov-integrations',19,'integrations','集成','Integrations'],['lyapunov-downloads',50,'downloads','下载','Downloads']] as const){
 owner.slots.inject('settings.section',()=>owner.slots.register({name:'settings.section',id,order,label:()=>tr(zh,en),inject:()=>({view,tr,close:()=>{closeTopModal(document)},start:(id:string,close:()=>void)=>startExternalInstallSession(owner,id,close),sessionId:()=>mainSessionId((owner.get('sessions') as unknown as ISessions).list.getSnapshot()),openDocument})},ExternalToolsSettings))
 }
 })
}
