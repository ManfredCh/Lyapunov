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
 return source==="env-override"?tr("显式环境变量覆盖","explicit environment override")
  :source==="saved-preference"?tr("已保存的本地/旧版本 SDK","saved local/legacy SDK")
  :tr("本版本产品托管默认","this version's product-managed default")
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
 return <div style={{display:"grid",gap:8,padding:10,border:"1px solid var(--dsw-alias-border-l1)",borderRadius:6}} aria-label={tr("本地 Isaac Sim 安装","Local Isaac Sim installation")}>
  <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
   <strong style={{fontSize:13}}>{tr("已有 Isaac Sim？直接使用本地安装","Already have Isaac Sim? Use a local installation")}</strong>
   <button type="button" disabled={blocked} onClick={()=>void discover(false)}>{busy?tr("检查中…","Checking…"):tr("发现本地安装","Find local installation")}</button>
  </div>
  <p style={{margin:0,fontSize:12,opacity:.75}}>{tr("Isaac 路径按固定优先级解析：① 显式环境变量 LYAPUNOV_ISAAC_PYTHON；② 已保存的本地/旧版本 SDK；③ 本版本产品托管安装。下面保存只写选择，当前会话与运行中的世界不变，下次启动才使用新路径。安装目录、python.sh 或 Conda/venv 的 bin/python 都可以先检查再登记。","Isaac paths resolve in a fixed order: (1) the explicit LYAPUNOV_ISAAC_PYTHON environment override; (2) a saved local/legacy SDK; (3) this version's product-managed install. Saving below only records the choice: the current session and the running world are unchanged, and the new path is used on the next startup. A directory, python.sh or a Conda/venv bin/python can all be checked and then registered.")}</p>
  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
   <input aria-label={tr("Isaac Sim 安装目录或 Python 路径","Isaac Sim directory or Python path")} value={path} onChange={event=>setPath(event.target.value)} placeholder={tr("安装目录、python.sh 或 bin/python 的绝对路径","Absolute path to installation directory, python.sh or bin/python")} style={{flex:1,minWidth:180}}/>
   <button type="button" disabled={blocked||!path.trim()} onClick={()=>void discover(true)}>{tr("检查此路径","Check this path")}</button>
  </div>
  {selection&&<div style={{fontSize:12,opacity:.75,wordBreak:"break-all"}}>
   {tr("下次启动 SDK：","SDK for next startup: ")}{selection.nextPython}
   {"（"}{isaacSourceLabel(tr,selection.nextSource)}{"）"}
   <div>{isaacSelectionDetail(tr,selection)}</div>
   {selection.savedPython&&<button type="button" disabled={blocked||installing} onClick={()=>void select(null)}>{tr("恢复产品默认路径","Restore product default path")}</button>}
  </div>}
  {candidates.map(candidate=><div key={candidate.python} style={{display:"grid",gap:4,padding:8,background:"var(--dsw-alias-bg-l1,#0001)",borderRadius:6}}>
   <code style={{wordBreak:"break-all"}}>{candidate.python}</code>
   <span style={{fontSize:12}}>{isaacCandidateDetail(tr,candidate)}</span>
   <button type="button" disabled={blocked||installing||!candidate.compatible||selection?.savedPython===candidate.python} onClick={()=>void select(candidate.python)}>{selection?.savedPython===candidate.python?tr("已保存此安装","Installation saved"):tr("使用此安装（下次启动）","Use this installation (next startup)")}</button>
  </div>)}
  {message&&<p role="status" style={{margin:0,fontSize:12}}>{message}</p>}
  {installing&&<p style={{margin:0,fontSize:12}}>{tr("安装任务正在运行。可以检查已有安装，任务结束后再保存 SDK 选择。","Installation is running. You can check existing installations and save the SDK choice after the task ends.")}</p>}
  {error&&<p role="alert" style={{margin:0,fontSize:12}}>{error}</p>}
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
 return <div style={{display:"grid",gap:6,padding:"10px 12px",border:"1px solid var(--dsw-alias-border-l1)",borderRadius:8}}>
  <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
   <strong>{row.label}</strong>
   <span style={{opacity:.85}}>{row.installed?`${isPolicyRuntime?tr("独立 CPU 模块/版本已核","Independent CPU modules/versions verified"):tr("当前解释器可发现 SDK","SDK found in selected interpreter")}${row.version?` · ${row.version}`:""}`:isPolicyRuntime?tr("独立 CPU 环境待准备","Independent CPU environment needs preparation"):tr("当前解释器未发现 SDK","SDK not found in selected interpreter")}</span>
   <span style={{opacity:.6,fontSize:12}}>{row.detail}</span>
   <span style={{flex:1}}/>
   {row.engineChoice
    ? <button type="button" disabled={busy!==undefined||install?.running||preference===row.engineChoice} onClick={()=>onChoose(row.engineChoice!)}>
       {preference===row.engineChoice?tr("已是偏好","Preferred"):tr("切换到此引擎","Use this engine")}
      </button>
    : <span style={{opacity:.6,fontSize:12}}>{isPolicyRuntime?tr("CPU 策略推理","CPU policy inference"):tr("运行环境","Runtime")}</span>}
   {row.installable&&<button type="button" disabled={busy!==undefined||install?.running||blocked||localSelected} onClick={()=>onInstall(row.id)}>
    {install?.running?tr("安装中…","Installing…"):localSelected?tr("已选择本地安装","Local installation selected"):row.managedStatus==="missing"?tr("安装到产品目录","Install to product directory"):tr("修复产品托管安装","Repair managed install")}
   </button>}
  </div>
  <div style={{opacity:.65,fontSize:12,wordBreak:"break-all"}}>{tr("下次启动 SDK 路径：","SDK path for next startup: ")}{row.runtimePython}（{row.runtimeSource==="env-override"?tr("外置覆盖","external override"):row.runtimeSource==="saved-preference"?tr("已保存的本地安装","saved local installation"):tr("产品默认","product default")}；{tr("本页检查 SDK 可发现性","this page checks SDK discovery")}）</div>
  <div style={{opacity:.6,fontSize:12,wordBreak:"break-all"}}>{tr("产品托管安装：","Product managed install: ")}{row.managedStatus==="ready"?tr("SDK 可发现","SDK found"):row.managedStatus==="missing"?tr("前缀不存在","prefix missing"):tr("前缀存在但 SDK 未就绪","prefix present; SDK incomplete")} · {row.prefix}</div>
  {isIsaac&&<IsaacLocalPicker tr={tr} disabled={busy!==undefined} installing={Boolean(install?.running)} onChanged={onSdkChanged}/>}
  {isIsaac&&<div style={{display:"grid",gap:4}}>
   <label style={{display:"flex",gap:8,alignItems:"center",fontSize:13}}>
    <input type="checkbox" checked={Boolean(license)} onChange={event=>onAcceptLicense(event.target.checked)}/>
    <span>{tr("我已阅读并同意 NVIDIA Omniverse 许可协议","I have read and accept the NVIDIA Omniverse License Agreement")}（
     <a href={EULA_URL} target="_blank" rel="noreferrer">EULA</a>）</span>
   </label>
   {license
    ? <p style={{margin:0,opacity:.7,fontSize:12}}>{tr("已接受：","Accepted:")}{new Date(license.acceptedAt).toLocaleString()} · <a href={license.eulaUrl} target="_blank" rel="noreferrer">{license.eulaUrl}</a></p>
    : <p style={{margin:0,opacity:.75,fontSize:13}}>{tr("接受许可是「用户动作」（会记录接受时间）：先勾选上面这项，安装按钮才会可用——许可由使用者自己接受，我们不代签。","Accepting the license is an explicit user action (recorded with a timestamp): tick the box above to enable installation. The license is accepted by the end user, never on their behalf.")}</p>}
  </div>}
  <div style={{fontSize:12,opacity:.6}}>
   <>{tr("命令行等价入口：","CLI equivalent:")} <code>{install?.cli??`./lyapunov install-provider ${row.id}`}</code></>
  </div>
  {install?.running&&<pre style={{margin:0,maxHeight:140,overflow:"auto",fontSize:12,background:"var(--dsw-alias-bg-l1,#0001)",padding:8,borderRadius:6}}>{install.tail.slice(-1500)||tr("（安装刚开始，暂无输出）","(starting; no output yet)")}</pre>}
  {!install?.running&&result&&<p role="status" style={{margin:0,fontSize:13}}>
   {String(result.status??"")}{result.code?` · ${result.code}`:""}{result.message?`：${result.message}`:""}
  </p>}
 </div>
}

/**
 * 设置节主体。**同一实现服务两节**：`kinds` 决定展示哪一类行——
 * 这一节**只列引擎**（可切换/可安装），基准测试是评测负载、不在其中。
 * 基准测试（评测负载）**不在这一节**：它们不是 provider，仍走 `./lyapunov benchmark --provider …`。
 * 摆在一起会让人以为 LIBERO/Gymnasium 也是可选引擎，所以分节是硬要求。
 */
export function EngineSettingsSection({tr,kinds,title,blurb,showSwitch}:{tr:Translate;kinds:readonly ProviderRow["kind"][];title:string;blurb:string;showSwitch:boolean}){
 const [snapshot,setSnapshot]=useState<Snapshot>()
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
 return <section style={{display:"grid",gap:14,padding:20}} aria-label={title}>
  <h2 style={{margin:0}}>{title}</h2>
  <p style={{margin:0,opacity:.75}}>{blurb}</p>
  {showSwitch&&<p style={{margin:0}}>
   {tr("当前运行：","Running:")} <strong>{running??tr("未知","unknown")}</strong>
   {" · "}{tr("偏好：","Preference:")} <strong>{preference??tr("自动（Isaac GPU 优先）","automatic (prefer Isaac GPU)")}</strong>
  </p>}
  {/* 复核点 3：从"已有手动偏好"回到自动的**显式入口**——复用同一偏好文件/endpoint（写 `auto` 即清除
      显式偏好），不另造配置 owner；CLI/env 的显式 engine 仍优先。运行中的世界不变，重启后生效。 */}
  {showSwitch&&<div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
   <button type="button" disabled={busy!==undefined||isAuto} onClick={()=>void choose("auto")}>
    {isAuto?tr("已是自动","Automatic"):tr("自动（Isaac GPU 优先）","Automatic (prefer Isaac GPU)")}
   </button>
   <span style={{opacity:.6,fontSize:12}}>{tr("清除显式偏好：Isaac 的 SDK/许可/GPU 条件具备且仍为自动时，下次启动优先 Isaac；已设置的手动偏好不会被自动逻辑改动。","Clears the explicit preference: when Isaac's SDK/license/GPU conditions hold and you stay automatic, the next start prefers Isaac; a manual preference is never changed automatically.")}</span>
  </div>}
  {/* 自动候选与回退理由：判据全部来自宿主上游 `resolveEngine()` 原话，界面不复述、不另编"默认"。 */}
  {showSwitch&&decision?.gpu&&<p style={{margin:0,opacity:.75}}>{tr("GPU：","GPU: ")}{decision.gpu.headline}</p>}
  {showSwitch&&decision?.next&&<p style={{margin:0}}>
   {decision.next.source==="default"?tr("缺省/自动会选：","Default/auto picks: "):tr("下次启动：","Next start: ")}
   <strong>{decision.next.engine}</strong>{"（"}{decision.next.reason}{"）"}
   {decision.restartRequired?tr("；偏好已保存，重启后生效。","; preference saved, effective after restart."):""}
  </p>}
  {showSwitch&&decision?.next?.candidates?.length?<ul style={{margin:0,paddingInlineStart:18,opacity:.7,fontSize:12}}>
   {decision.next.candidates.map(candidate=><li key={candidate.engine}>{candidate.engine}{candidate.ready?tr("：候选条件满足"," : candidate conditions met"):`：${candidate.blockers.join(tr("；","; "))}`}{candidate.scope?`（${candidate.scope}）`:""}</li>)}
  </ul>:null}
  {showSwitch&&decision?.error?<p role="alert" style={{margin:0}}>{tr("引擎判定不可用：","Engine decision unavailable: ")}{decision.error}</p>:null}
  {error&&<p role="alert" style={{margin:0}}>{error}</p>}
  {!snapshot&&!error&&<p role="status">{tr("正在读取状态…","Reading status…")}</p>}
  {snapshot&&<div style={{display:"grid",gap:10}}>
   {rows.map(row=><ProviderRowView key={row.id} row={row} install={snapshot.installs.find(item=>item.provider===row.id)} preference={preference} busy={busy} license={snapshot.licenses?.isaac} tr={tr} onAcceptLicense={accepted=>void acceptLicense(accepted)} onInstall={provider=>void install(provider)} onChoose={provider=>void choose(provider)} onSdkChanged={refresh}/>)}
  </div>}
  {snapshot&&<p style={{margin:0,opacity:.6,fontSize:12}}>
   {showSwitch
    ? tr("已有兼容的 Isaac Sim 可直接选择本地安装；产品安装选择当前物理、机器人导入及 RTX 相机所需的官方组件、SDK 必需的辅助组件及扩展缓存，按完整运行依赖安装。机器人和环境素材按任务准备。Isaac 需用户接受 NVIDIA Omniverse 许可；一般场景与碰撞可在本页显式选择 MuJoCo，重启后生效。",
        "Reuse a compatible local Isaac Sim installation when available. The installer selects official components for physics, robot import and RTX cameras, required SDK support components and extension caches, with their full runtime dependencies. Robot and environment assets are prepared per task. Isaac requires the user's NVIDIA Omniverse license acceptance. For general scenes and collision, explicitly select MuJoCo here; it takes effect after restart.")
    : tr("基准测试（LIBERO / Gymnasium）是「评测负载」，不在这个清单里：它们不是 provider，仍用 `./lyapunov install-provider benchmark-*` 安装、`./lyapunov benchmark --provider …` 运行。",
        "These are evaluation workloads with their own Python environments, not physics engines: the engine computes the world, the benchmark decides which tasks to grade it on.")}
  </p>}
 </section>
}

/** 注册到设置面板（与"通知与快捷键"同一种 slot，不新建设置框架）。 */
export function applyEngineSettings(ctx:Context):void{
 const t=ctx.locale.bind("lyapunov")
 const tr:Translate=(zh,en)=>t("open")==="Scene workbench"?en:zh
 const inject=(kinds:readonly ProviderRow["kind"][],title:string,blurb:string,showSwitch:boolean)=>()=>({tr,kinds,title,blurb,showSwitch})
 ctx.slots.inject("settings.section",()=>ctx.slots.register({
  name:"settings.section",id:"lyapunov-engine",order:20,label:()=>tr("物理引擎","Physics engine"),
  inject:inject(["engine"],tr("物理引擎","Physics engine"),
   tr("引擎在启动时装配（一个世界只能有一个 Provider），所以切换后需重启工作台生效，运行中的会话与动作不会被打断。",
      "The engine is composed at startup (one provider per world), so a switch takes effect after the workbench restarts; running sessions and actions are unaffected."),true),
 },EngineSettingsSection))
}
