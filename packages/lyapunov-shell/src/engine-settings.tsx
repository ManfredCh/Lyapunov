/**
 * 设置 → 物理引擎：把"装引擎/配引擎/选引擎"从开发脚本搬进界面。
 *
 * 为什么需要它：引擎的 Provider 在 Host 启动时按 `--engine` 装配，安装原本只有
 * `./lyapunov install-provider <provider>` 这一条命令行入口——给别人装产品时，
 * 没有终端、不知道脚本存在、也不知道"哪个引擎已经就绪"，就没法用。
 *
 * 这一节只做三件事，且都委托给既有 owner（不复制任何安装/偏好逻辑）：
 *  · 读状态：`/api/lyapunov/engine-providers`（宿主实际探测解释器与包，不是猜的）
 *  · 安装/修复：`/api/lyapunov/provider-install` → 宿主起发行包自带的 install-provider，
 *    界面只轮询日志与它输出的 JSON（含 EULA 拦截、前缀冲突这类 BLOCKED 原因）
 *  · 选引擎：`/api/lyapunov/engine-preference` → `script/engine-preference.ts`（唯一 owner），
 *    明示"下次启动生效"，不偷偷重启 Host（那会打断活动会话与运行中的动作）
 *
 * 兜底：每行都给出对应的命令行，供无界面/远程场景直接复制。
 */
import {useCallback,useEffect,useState} from "react"
import {Button,Input,Checkbox,SegmentedControl,IconRefreshOutlineRegular} from "@deepseek-ai/dsh-client-ui-primitives"
import {SettingsPage,SettingsHeading,SettingsListRow,SettingsField,SettingsDetails,SettingsStatus} from "./settings-ui.tsx"
import type {Context} from "@deepseek-ai/cordis"
import type {EngineInstallState,EngineLicenseAcceptance,EngineProvidersPayload,EngineProviderStatus,IsaacLocalCandidate,IsaacLocalDiscovery,IsaacLocalSelection} from "./engine-provider-contract.ts"

/** 宿主 `/api/lyapunov/engine-providers` 的返回形状（与 plugin.ts 的 providerRows() 对应）。 */
/** 线上形状与宿主共用一份声明（`engine-provider-contract.ts`）：两端各写一遍会在改字段时静默漂移。 */
type ProviderRow=EngineProviderStatus
type InstallRow=EngineInstallState
type Snapshot=EngineProvidersPayload
type LicenseAcceptance=EngineLicenseAcceptance

const EULA_URL="https://docs.omniverse.nvidia.com/platform/latest/common/NVIDIA_Omniverse_License_Agreement.html"
type Translate=(zh:string,en:string)=>string

async function localSdkRequest<T>(action:string,body?:Record<string,unknown>):Promise<T>{
 const response=await fetch(`/api/lyapunov/isaac-local/${action}`,body?{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}:undefined)
 const value=await response.json() as T&{error?:string}
 if(!response.ok)throw new Error(value.error??`HTTP ${response.status}`)
 return value
}

/**
 * 选择来源的界面措辞：宿主只给稳定取值（`nextSource`），中文/英文都在这里配。
 * 三档必须一眼分清：显式 ENV 覆盖 > 已保存外置/旧版本 > 本版本产品托管。
 */
function isaacSourceLabel(tr:Translate,source:IsaacLocalSelection["nextSource"]):string{
 return source==="env-override"?tr("环境变量覆盖","Environment override")
  :source==="saved-preference"?tr("已保存的本地 SDK","Saved local SDK")
  :tr("产品默认","Product default")
}

/** 当前选择说明：本地化文案由结构化字段（`nextSource`）推出，宿主返回的固定中文 detail 不直接上屏。 */
function isaacSelectionDetail(tr:Translate,selection:IsaacLocalSelection):string{
 if(selection.nextSource==="env-override")return tr("显式 LYAPUNOV_ISAAC_PYTHON 覆盖优先于保存选择与本版本产品托管安装；取消该覆盖并重启后才会使用已保存的路径。","The explicit LYAPUNOV_ISAAC_PYTHON override wins over a saved choice and this version's product-managed install; the saved path is used only after that override is removed and the app restarts.")
 if(selection.nextSource==="saved-preference")return tr("下次启动实际使用的就是这条已保存路径（可能是本产品旧版本，或你自己下载的 SDK）。本页保存选择不会改变当前会话正在使用的引擎。","This saved path (an older product version, or an SDK you downloaded) is exactly what the next startup uses. Saving here does not change the engine the current session is running.")
 return tr("本版本产品托管安装是下次启动的默认路径；当前会话不因保存 SDK 而改变。","This version's product-managed install is the default path for the next startup; saving an SDK does not change the current session.")
}

/** 候选说明：只用结构化字段（`compatible`/`state`/版本/kind）拼中英文本，不直接渲染宿主的固定中文 detail。 */
function isaacCandidateDetail(tr:Translate,candidate:IsaacLocalCandidate):string{
 const kind=candidate.kind==="standalone"?tr("standalone python.sh","standalone python.sh"):tr("Conda/venv bin/python","Conda/venv bin/python")
 if(candidate.compatible)return tr(`发现兼容的 Isaac Sim ${candidate.sdkVersion} / Python ${candidate.pythonVersion}（${kind}）；可登记为下次启动路径。物理世界、许可与 RTX 仍需按实际运行检查。`,`Compatible Isaac Sim ${candidate.sdkVersion} / Python ${candidate.pythonVersion} found (${kind}); it can be registered for the next startup. Physics, license and RTX are still verified at run time.`)
 if(candidate.state==="timeout")return tr("SDK 发现检查超时，未启动物理引擎；可重试或改选其它安装。","The SDK discovery check timed out; no physics engine was started. Retry or choose another installation.")
 if(candidate.state==="unavailable")return tr("无法运行所选解释器；可重试或改选其它安装。","The selected interpreter could not be started. Retry or choose another installation.")
 if(candidate.state==="incompatible"){
  const version=candidate.sdkVersion??tr("未读到","unread"),python=candidate.pythonVersion??tr("未读到","unread")
  return /^3\.12\./.test(candidate.pythonVersion??"")
   ?tr(`发现 isaacsim，但版本 ${version} 或安装布局不符合本版锁定的 6.0.1；本版不采用该 SDK。`,`isaacsim was found, but version ${version} or its install layout does not match the 6.0.1 this build pins; this build will not use it.`)
   :tr(`Isaac Sim 6.0.1 需要 Python 3.12，当前解释器为 ${python}。`,`Isaac Sim 6.0.1 requires Python 3.12; this interpreter is ${python}.`)
 }
 return tr("当前解释器未发现 isaacsim；请检查路径，或改选包含 Isaac Sim 的目录、python.sh 或 Conda/venv 的 bin/python。","This interpreter did not find isaacsim; check the path, or choose a directory, python.sh or Conda/venv bin/python that contains Isaac Sim.")
}

/** 本地发现由用户按钮触发；打开设置只读保存选择，不扫描、不下载、不启动引擎。 */
function IsaacLocalPicker({tr,disabled,installing,onChanged}:{tr:Translate;disabled:boolean;installing:boolean;onChanged:()=>Promise<void>}){
 const [path,setPath]=useState("")
 const [selection,setSelection]=useState<IsaacLocalSelection>()
 const [candidates,setCandidates]=useState<IsaacLocalCandidate[]>([])
 const [busy,setBusy]=useState(false)
 const [message,setMessage]=useState("")
 const [error,setError]=useState("")
 useEffect(()=>{let active=true;void localSdkRequest<IsaacLocalSelection>("selection").then(value=>{if(active){setSelection(value);setPath(value.savedPython??"")}}).catch(reason=>{if(active)setError(String(reason instanceof Error?reason.message:reason))});return()=>{active=false}},[])
 const discover=async(manual:boolean)=>{
  setBusy(true);setError("");setMessage(tr("正在检查本地安装…","Checking local installations…"))
  try{const value=await localSdkRequest<IsaacLocalDiscovery>("discover",manual?{path:path.trim()}:{});setCandidates(value.candidates);setSelection(value.selection);setMessage(value.candidates.length?tr(`已检查 ${value.scanned} 个安装入口。`,"Checked "+value.scanned+" installation entries.")+(value.limited?tr(" 搜索数量已达上限；未列出的安装可以输入路径检查。"," Search limit reached; enter a path to check an installation not listed."):""):tr("常见目录未发现可检查的安装入口。可以输入已有 Python、python.sh 或安装目录的绝对路径。","No installable entry was found in common locations. Enter the absolute path of an existing Python, python.sh or installation directory."))}
  catch(reason){setError(String(reason instanceof Error?reason.message:reason))}finally{setBusy(false)}
 }
 const select=async(python:string|null)=>{
  setBusy(true);setError("")
  try{const value=await localSdkRequest<IsaacLocalSelection>("select",{python});setSelection(value);setMessage(tr("已保存，下次启动使用。当前会话继续运行。","Saved for next startup. The current session keeps running."));await onChanged()}
  catch(reason){setError(String(reason instanceof Error?reason.message:reason))}finally{setBusy(false)}
 }
 const blocked=disabled||busy
 const [candidatePython,setCandidatePython]=useState<string>()
 const chosen=candidatePython??selection?.savedPython
 const candidate=candidates.find(row=>row.python===chosen)
 return <div className='lya-settings' aria-label={tr('本地 Isaac Sim 安装','Local Isaac Sim installation')}>
  <label className='lya-settings-search-label'><span>{tr('安装目录或 Python 路径','Installation directory or Python')}</span><Input value={path} onChange={event=>setPath(event.target.value)} placeholder='/absolute/path/to/python.sh'/></label>
  <div className='lya-settings-actions'><Button size='sm' disabled={blocked||!path.trim()} onClick={()=>void discover(true)}>{tr('检查路径','Check path')}</Button><Button size='sm' disabled={blocked} onClick={()=>void discover(false)}>{busy?tr('检查中…','Checking…'):tr('发现本地安装','Find installations')}</Button></div>
  <div className='lya-settings-list'>{candidates.map(row=><Button key={row.python} variant='ghost' className='lya-settings-list-row' aria-pressed={chosen===row.python} disabled={blocked||!row.compatible} title={isaacCandidateDetail(tr,row)} onClick={()=>setCandidatePython(row.python)}><span className='lya-settings-row-name'><code>{row.python}</code></span><span className='lya-settings-row-state'>{row.compatible?tr('兼容','Compatible'):tr('不兼容／不可用','Not compatible / unavailable')}</span></Button>)}</div>
  {candidate&&<Button size='sm' variant='primary' disabled={blocked||installing||!candidate.compatible||selection?.savedPython===candidate.python} onClick={()=>void select(candidate.python)}>{selection?.savedPython===candidate.python?tr('已保存此安装','Installation saved'):tr('使用此安装','Use selected installation')}</Button>}
  {selection&&<dl className='lya-settings-fields'><SettingsField label={tr('下次启动 SDK','SDK for next start')}><code>{selection.nextPython}</code></SettingsField><SettingsField label={tr('来源','Source')}>{isaacSourceLabel(tr,selection.nextSource)}</SettingsField></dl>}
  {selection?.savedPython&&<Button size='sm' disabled={blocked||installing} onClick={()=>void select(null)}>{tr('恢复产品默认路径','Restore product default')}</Button>}
  {message&&<p className='lya-settings-message' role='status'>{message}</p>}{error&&<p className='lya-settings-message' role='alert'>{error}</p>}
  {installing&&<p className='lya-settings-caption'>{tr('安装任务运行中，结束后可保存 SDK 选择。','Installation is running. Save the SDK choice after it ends.')}</p>}
  <SettingsDetails title={tr('路径优先级与兼容性','Resolution order & compatibility')}><p className='lya-settings-caption'>{selection?isaacSelectionDetail(tr,selection):tr('显式环境变量优先，其次是保存选择，最后是产品默认。','Environment override, then saved choice, then product default.')}</p>{candidates.map(row=><div key={row.python}><code>{row.python}</code><p className='lya-settings-caption'>{isaacCandidateDetail(tr,row)}</p></div>)}</SettingsDetails>
 </div>
}

/** 一行引擎：状态 + 安装/修复 + 切换。安装中的行显示日志尾与脚本给的 JSON 结局。 */
function ProviderRowView({row,install,preference,busy,license,tr,onAcceptLicense,onInstall,onChoose,onSdkChanged}:{
 row:ProviderRow;install?:InstallRow;preference:string|null;busy:string|undefined;license?:LicenseAcceptance;tr:Translate
 onAcceptLicense:(accepted:boolean)=>void;onInstall:(provider:string)=>void;onChoose:(provider:string)=>void
 onSdkChanged:()=>Promise<void>
}){
 const isIsaac=row.id==="isaac",isPolicyRuntime=row.kind==="runtime"
 const blocked=isIsaac&&!license
 const localSelected=isIsaac&&row.runtimeSource==="saved-preference"
 const result=install?.result??undefined
 const installButton=row.installable&&<Button size='sm' variant='primary' disabled={busy!==undefined||install?.running||blocked||localSelected} onClick={()=>onInstall(row.id)}>{install?.running?tr('安装中…','Installing…'):localSelected?tr('已选择本地安装','Local installation selected'):row.managedStatus==='missing'?tr('安装到产品目录','Install to product directory'):tr('修复托管安装','Repair managed install')}</Button>
 return <>
  <dl className='lya-settings-fields'>
   <SettingsField label={tr('SDK','SDK')}>{row.installed?tr('已发现','Found'):tr('未发现','Not found')}{row.version?' · '+row.version:''}</SettingsField>
   <SettingsField label={tr('来源','Source')}>{isaacSourceLabel(tr,row.runtimeSource)}</SettingsField>
   <SettingsField label={tr('托管安装','Managed install')}>{row.managedStatus==='ready'?tr('SDK 已发现','SDK found'):row.managedStatus==='missing'?tr('未安装','Not installed'):tr('安装未完整','Incomplete')}</SettingsField>
  </dl>
  {row.engineChoice&&preference!==row.engineChoice&&<div className='lya-settings-actions'><Button size='sm' disabled={busy!==undefined||install?.running||preference===row.engineChoice} onClick={()=>onChoose(row.engineChoice!)}>{preference===row.engineChoice?tr('已是偏好','Preferred'):tr('设为下次启动引擎','Use for next start')}</Button></div>}
  {isIsaac?<>
   <SettingsDetails title={tr('使用本地 SDK','Use a local SDK')}><IsaacLocalPicker tr={tr} disabled={busy!==undefined} installing={Boolean(install?.running)} onChanged={onSdkChanged}/></SettingsDetails>
   <SettingsDetails title={tr('产品托管安装','Product-managed installation')}>
    <Checkbox checked={Boolean(license)} onChange={onAcceptLicense} label={tr('我已阅读并接受 NVIDIA Omniverse 许可协议','I accept the NVIDIA Omniverse License Agreement')}/>
    <a href={EULA_URL} target='_blank' rel='noreferrer'>{tr('查看许可协议','Read license agreement')} ↗</a>
    {!license&&<p className='lya-settings-caption'>{tr('接受许可后才能安装。','Accept the license to enable installation.')}</p>}
    {license&&<p className='lya-settings-caption'>{tr('已接受：','Accepted: ')}{new Date(license.acceptedAt).toLocaleString()}</p>}
    {installButton}
    <SettingsDetails title={tr('组件与存储','Components & storage')}><p className='lya-settings-caption'>{tr('固定的 Kit/App、核心、机器人导入与测试组件，以及 SDK/physics/Kit 扩展缓存。通用 Kit 缓存 6.0.1.0 约 5.88 GB，支持分段续传并校验总长度与 SHA-256。','Pinned Kit/App, core, robot import/tests and SDK/physics/Kit extension caches. The generic Kit cache 6.0.1.0 is about 5.88 GB; segmented downloads check total length and SHA-256.')}</p></SettingsDetails>
   </SettingsDetails>
  </>:<div className='lya-settings-actions'>{installButton}</div>}
  <SettingsDetails title={tr('安装输出','Installation output')} open={Boolean(install?.running)}>
   {install?.running&&<SettingsStatus state='ongoing'>{tr('安装中','Installing')}</SettingsStatus>}
   <pre>{install?.tail||tr('暂无安装输出。','No installation output yet.')}</pre>
   {result&&<p className='lya-settings-message' role='status'>{[result.status,result.code,result.message].filter(Boolean).join(' · ')}</p>}
   {install?.logPath&&<code>{install.logPath}</code>}
  </SettingsDetails>
  <SettingsDetails title={tr('SDK 路径与诊断','SDK paths & diagnostics')}><dl className='lya-settings-fields'><SettingsField label={tr('下次启动 SDK','SDK for next start')}><code>{row.runtimePython}</code></SettingsField><SettingsField label={tr('托管安装目录','Managed directory')}><code>{row.prefix}</code></SettingsField></dl><p className='lya-settings-message'>{row.detail}</p><p className='lya-settings-caption'>{tr('这里检查 SDK 发现状态；实际物理世界与渲染按运行结果显示。','This checks SDK discovery; physical-world and rendering results are shown at run time.')}</p>{isPolicyRuntime&&<p className='lya-settings-caption'>{tr('独立 CPU 策略推理环境。','Independent CPU policy inference environment.')}</p>}</SettingsDetails>
  <SettingsDetails title={tr('命令行等价入口','CLI equivalent')}><code>{install?.cli??`./lyapunov install-provider ${row.id}`}</code></SettingsDetails>
 </>
}

/**
 * 设置节主体。**同一实现服务两节**：`kinds` 决定展示哪一类行——
 * 这一节**只列引擎**（可切换/可安装），基准测试是评测负载、不在其中。
 * 基准测试（评测负载）**不在这一节**：它们不是 provider，仍走 `./lyapunov benchmark --provider …`。
 * 摆在一起会让人以为 LIBERO/Gymnasium 也是可选引擎，所以分节是硬要求。
 */
export function EngineSettingsSection({tr,kinds,title,blurb,showSwitch}:{tr:Translate;kinds:readonly ProviderRow["kind"][];title:string;blurb:string;showSwitch:boolean}){
 const [snapshot,setSnapshot]=useState<Snapshot>()
 const [selectedId,setSelectedId]=useState<string>()
 const [error,setError]=useState("")
 const [busy,setBusy]=useState<string|undefined>(undefined)
 const refresh=useCallback(async()=>{
  try{
   const response=await fetch("/api/lyapunov/engine-providers")
   if(!response.ok)throw new Error(`HTTP ${response.status}`)
   setSnapshot(await response.json() as Snapshot)
  }catch(reason){setError(String(reason instanceof Error?reason.message:reason))}
 },[])
 useEffect(()=>{void refresh()},[refresh])
 // 安装是宿主的独立进程：界面轮询状态与日志，直到它结束。
 const installing=Boolean(snapshot?.installs.some(item=>item.running))
 useEffect(()=>{if(!installing)return;const timer=setInterval(()=>{void refresh()},2000);return()=>clearInterval(timer)},[installing,refresh])
 const choose=async(engine:string)=>{
  setBusy(engine);setError("")
  try{const response=await fetch("/api/lyapunov/engine-preference",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({engine})});if(!response.ok)throw new Error(await response.text());await refresh()}
  catch(reason){setError(String(reason instanceof Error?reason.message:reason))}finally{setBusy(undefined)}
 }
 const acceptLicense=async(accepted:boolean)=>{
  setError("")
  try{const response=await fetch("/api/lyapunov/engine-license",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({engine:"isaac",accepted,eulaUrl:EULA_URL})});if(!response.ok)throw new Error(await response.text());await refresh()}
  catch(reason){setError(String(reason instanceof Error?reason.message:reason))}
 }
 const install=async(provider:string)=>{
  setBusy(provider);setError("")
  try{const response=await fetch("/api/lyapunov/provider-install",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider,acceptEula:provider==="isaac"?Boolean(snapshot?.licenses?.isaac):false})});if(!response.ok)throw new Error(await response.text());await refresh()}
  catch(reason){setError(String(reason instanceof Error?reason.message:reason))}finally{setBusy(undefined)}
 }
 const running=snapshot?.runningEngine??null,preference=snapshot?.preference??null
 const decision=snapshot?.engineDecision
 const rows=snapshot?.providers.filter(row=>kinds.includes(row.kind))??[]
 // "自动" = 偏好层没有显式引擎（`null`）。宿主写 `"auto"` 时会**清除** `engine` 键，所以读回也是 null。
 const isAuto=preference===null
 const selected=rows.find(row=>row.id===selectedId)
 const displayName=(name:string)=>name.replaceAll('（',' (').replaceAll('）',')')
 const engineName=(engine:string|null)=>displayName(rows.find(row=>row.engineChoice===engine)?.label??engine??tr('未知','Unknown'))
 return <SettingsPage label={title}>
  <SettingsHeading title={selected?displayName(selected.label):title} back={selected?()=>setSelectedId(undefined):undefined} backLabel={title} actions={<Button size='sm' title={tr('刷新','Refresh')} aria-label={tr('刷新','Refresh')} icon={<IconRefreshOutlineRegular size={16}/>} disabled={busy!==undefined} onClick={()=>void refresh()}/>}/>
  {error&&<p className='lya-settings-message' role='alert'>{error}</p>}
  {!snapshot&&!error&&<p className='lya-settings-message' role='status'>{tr('正在读取状态…','Reading status…')}</p>}
  {!selected&&<>
   {showSwitch&&<>
    <dl className='lya-settings-fields'><SettingsField label={tr('当前运行','Running')}>{engineName(running)}</SettingsField><SettingsField label={tr('下次启动','Next start')}>{decision?.next?.engine||preference?engineName(decision?.next?.engine??preference):tr('自动','Automatic')}{decision?.restartRequired&&<p className='lya-settings-caption'>{tr('已保存，重启后生效。','Saved; restart required.')}</p>}</SettingsField></dl>
    <label className='lya-settings-caption'>{tr('引擎偏好','Engine preference')}</label>
    <SegmentedControl id='lya-engine-preference' label={tr('引擎偏好','Engine preference')} value={isAuto?'auto':preference!} onChange={value=>void choose(value)} disabled={busy!==undefined||installing} options={[{value:'auto',label:tr('自动','Automatic')},...rows.filter(row=>row.engineChoice).map(row=>({value:row.engineChoice!,label:displayName(row.label)}))]}/>
    <div id={'lya-engine-preference-'+(isAuto?'auto':preference)+'-panel'} role='tabpanel' aria-labelledby={'lya-engine-preference-'+(isAuto?'auto':preference)}><p className='lya-settings-caption'>{tr('偏好在下次启动生效，当前会话继续运行。','Changes apply at the next start; the current session continues.')}</p></div>
   </>}
   <div className='lya-settings-list' aria-label={tr('可用引擎','Engine providers')}>{rows.map(row=><SettingsListRow key={row.id} name={displayName(row.label)} status={row.installed?[tr('SDK 已发现','SDK found'),row.version].filter(Boolean).join(' · '):tr('待安装／检查','Install / inspect')} onClick={()=>setSelectedId(row.id)}/>)}</div>
   {showSwitch&&<SettingsDetails title={tr('引擎选择与 GPU','Engine decision & GPU')}><p className='lya-settings-message'>{blurb}</p>{decision?.gpu&&<p className='lya-settings-message'>{decision.gpu.headline}</p>}{decision?.next&&<p className='lya-settings-message'>{decision.next.engine} · {decision.next.reason}</p>}{decision?.next?.candidates?.map(candidate=><p key={candidate.engine} className='lya-settings-message'>{candidate.engine} · {candidate.ready?tr('候选条件满足','Candidate conditions met'):candidate.blockers.join('; ')}{candidate.scope?' · '+candidate.scope:''}</p>)}{decision?.error&&<p className='lya-settings-message' role='alert'>{decision.error}</p>}</SettingsDetails>}
  </>}
  {selected&&<ProviderRowView row={selected} install={snapshot?.installs.find(item=>item.provider===selected.id)} preference={preference} busy={busy} license={snapshot?.licenses?.isaac} tr={tr} onAcceptLicense={accepted=>void acceptLicense(accepted)} onInstall={provider=>void install(provider)} onChoose={provider=>void choose(provider)} onSdkChanged={refresh}/>}
 </SettingsPage>
}

/** 注册到设置面板（与"通知与快捷键"同一种 slot，不新建设置框架）。 */
export function applyEngineSettings(ctx:Context):void{
 const t=ctx.locale.bind("lyapunov")
 const tr:Translate=(zh,en)=>t("open")==="Scene workbench"?en:zh
 const inject=(kinds:readonly ProviderRow["kind"][],title:()=>string,blurb:()=>string,showSwitch:boolean)=>()=>({tr,kinds,title:title(),blurb:blurb(),showSwitch})
 ctx.slots.inject("settings.section",()=>ctx.slots.register({
  name:"settings.section",id:"lyapunov-engine",order:30,label:()=>tr("物理引擎","Physics engine"),
  inject:inject(["engine"],()=>tr("物理引擎","Physics engine"),
   ()=>tr("引擎在启动时装配（一个世界只能有一个 Provider），所以切换后需重启工作台生效，运行中的会话与动作不会被打断。",
      "The engine is composed at startup (one provider per world), so a switch takes effect after the workbench restarts; running sessions and actions are unaffected."),true),
 },EngineSettingsSection))
}
