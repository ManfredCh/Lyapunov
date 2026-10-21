import {useEffect,useRef,useState} from 'react'

/** 桌面选择器有界等待：超过它就把选择器判为"没响应"，改走本地路径输入。 */
const CHOOSER_TIMEOUT_MS = 12_000
import type {PolicyLoadState} from '../../policy-registry/src/load-state.ts'
import type {WorldHandle} from '../../lyapunov-contracts/src/types.ts'
import type {Translate} from './entity-editor.tsx'
import {policyPanelAction,policyPrepareArgs,type PolicyPanelPorts,type PolicyAppliedBinding} from './policy-panel-action.ts'
import {importLocalPolicy,type LocalPolicyImportReceipt} from './local-policy-import.ts'
import {localPolicyBundlePath,type LocalPolicyEntry} from '../../policy-registry/src/local-policy-file-contract.ts'
export {policyPanelAction,policyPrepareArgs} from './policy-panel-action.ts'
export type {PolicyPanelPorts} from './policy-panel-action.ts'
export interface PolicySourceRow {adapterId:string;packId?:string;label:string;identity:{provider:string;modelId:string;revision:string};files:string[];downloadModelId:string|null;fallback?:{urls?:Array<{path:string;url:string}>;directories?:Array<{path:string;url:string}>}}
export const policyCategoryLabels:Record<PolicyLoadState['category'],string>={direct_execution:'执行路线已登记（实例状态另核）',weights_need_adapter:'有权重，来源或实例待准备',missing_files_or_runtime:'缺文件、运行依赖或世界绑定',model_incompatible:'当前模型不兼容'}
export interface PolicyCompatibilityContext {kind:'policy'|'vla';sceneId?:string;entityId?:string;worldId?:string;expectedGeneration?:number;expectedRevision?:number;identity?:{provider:string;modelId:string;revision:string}}
const sameIdentity=(a?:{provider:string;modelId:string;revision:string},b?:{provider:string;modelId:string;revision:string}):boolean=>a===b||Boolean(a&&b&&a.provider===b.provider&&a.modelId===b.modelId&&a.revision===b.revision)
/** 旧回执只对登记时的同一scene/entity/world/代次/版本/kind/identity有效；未知或不匹配不得授予兼容或可应用状态。 */
export function policyReceiptMatches(receipt:LocalPolicyImportReceipt|undefined,context:PolicyCompatibilityContext):boolean{
 const recorded=receipt?.context
 if(!recorded)return false
 return recorded.kind===context.kind&&recorded.sceneId===context.sceneId&&recorded.entityId===context.entityId&&recorded.worldId===context.worldId&&recorded.expectedGeneration===context.expectedGeneration&&recorded.expectedRevision===context.expectedRevision&&sameIdentity(recorded.identity,context.identity)
}
const hasAny=(state:PolicyLoadState|undefined,pattern:RegExp,codes:string[]=[]):boolean=>Boolean(state&&(state.missing??[]).some(item=>pattern.test(item.code)||codes.includes(item.code)))
/** 准确区分未检查/兼容/不兼容/缺项/只登记路线；一律走tr对应语言，技术码与缺项留在折叠详情。 */
export function policyCompatibilityLabel(state:PolicyLoadState|undefined,tr:Translate):string{
 if(!state)return tr('未检查','Not checked')
 if(state.recovery==='prepare_on_instance')return tr('需在本实例重新准备；旧缓存不能借用','Prepare again on this instance; the old cache cannot be borrowed')
 if(state.category==='model_incompatible')return tr('与当前实例不兼容','Incompatible with this instance')
 if(state.ready&&state.worldBound)return tr('与当前实例兼容','Compatible with this instance')
 if(state.applyEligible)return tr('可应用到所选实例；Apply 会重建所选世界','Ready to apply to the selected instance; Apply rebuilds the selected world')
 if(state.policyPrepared)return tr('适配器已准备；实例或世界未核','Adapter prepared; instance or world not verified')
 if(state.category==='direct_execution')return tr('执行路线已登记；实例未核','Execution route registered; instance not verified')
 if(state.category==='weights_need_adapter')return tr('有权重；尚缺适配器或实例准备','Weights present; adapter or instance preparation missing')
 if(hasAny(state,/^(RUNTIME_|POLICY_RUNTIME_)/))return tr('缺本地运行环境','Missing local runtime')
 if(hasAny(state,/^(WORLD_|SCENE_)/,['POLICY_ENTITY_NOT_FOUND','POLICY_EXPECTED_GENERATION_REQUIRED','POLICY_ROBOT_SELECTION_REQUIRED']))return tr('缺当前实例或世界绑定','Missing current instance or world binding')
 return tr('缺项：文件、运行环境或实例绑定','Missing files, runtime or instance binding')
}
/** 默认提示只翻译已知原因，完整code/detail仍在详情中，避免长路径与技术身份铺在首屏。 */
export function policyProblemSummary(state:PolicyLoadState|undefined,failure:any,error:string,tr:Translate):string|undefined{
 const codes=[failure?.code,...(state?.missing??[]).map(item=>item.code),error.match(/^([A-Z][A-Z0-9_]+)(?=:|$)/)?.[1]].filter(Boolean)
 if(codes.some(code=>/JOINT_COUNT|ACTION_DIM/.test(code)))return tr('策略动作维度与此机器人的关节不匹配。','Policy actions do not match this robot’s joints.')
 if(codes.some(code=>/MODEL_MISMATCH|JOINT.*MISMATCH/.test(code)))return tr('该策略为不同机器人本体或关节映射准备。','This policy was prepared for a different robot body or joint mapping.')
 if(codes.some(code=>/SOURCE.*MISMATCH|SOURCE_UNVERIFIED/.test(code)))return tr('策略文件与登记来源不匹配或尚未验证。','The policy files do not match a verified registered source.')
 if(codes.some(code=>/ENGINE|SIMULATOR/.test(code)))return tr('该策略不支持当前物理引擎。','This policy does not support the current physics engine.')
 if(codes.some(code=>/OBSERVATION/.test(code)))return tr('当前观测与策略输入契约不匹配。','Current observations do not match the policy input contract.')
 if(state?.category==='model_incompatible')return tr('策略与此实例的模型或控制映射不匹配。','The policy does not match this instance’s model or control mapping.')
 if(failure||error)return tr('策略操作未确认成功，请查看详情后重试。','The policy operation was not confirmed. Check the details before retrying.')
}
const executableWorld=(status:WorldHandle['status']|undefined):boolean=>status===undefined||status==='ready'||status==='running'
/** Apply 会先停止并重建所选世界（同一 Scene 版本/代次），因此 paused 不阻断可应用资格；
 *  执行策略所需运行态仍由 ready/世界状态单独判定，closed/failed 等不能借 Apply 放行。 */
const worldAllowsApply=(status:WorldHandle['status']|undefined):boolean=>status===undefined||status==='ready'||status==='running'||status==='paused'
export function PolicyLibraryPanel({available,canLoad,canRegister=true,canLoadAsset=canLoad,sceneId,entityId,worldId,worldStatus,expectedGeneration,expectedRevision,command,chooseFile,onActivated,onAssetLoaded,importReceipt,targetLabel,tr,onOpenControls}:{available:boolean;canLoad:boolean;canRegister?:boolean;canLoadAsset?:boolean;sceneId?:string;entityId?:string;worldId?:string;worldStatus?:WorldHandle['status'];expectedGeneration?:number;expectedRevision?:number;command:PolicyPanelPorts['command'];chooseFile?:()=>Promise<string|undefined>;onActivated?:(result:any)=>void;onAssetLoaded?:(modelPath:string,downloadModelId:string,provenance:Record<string,unknown>)=>Promise<void>;importReceipt?:LocalPolicyImportReceipt;targetLabel?:string;tr:Translate;onOpenControls?:()=>void}){
 const receiptIdentity=importReceipt?.face.identity??importReceipt?.context?.identity
 const receiptMatches=policyReceiptMatches(importReceipt,{kind:'policy',sceneId,entityId,worldId,expectedGeneration,expectedRevision,identity:receiptIdentity})
 const [kind,setKind]=useState<'policy'|'vla'>('policy'),[path,setPath]=useState(importReceipt?.filePath??''),[rows,setRows]=useState<PolicySourceRow[]>([]),[sourceId,setSourceId]=useState(''),[installedIdentity,setInstalledIdentity]=useState<PolicySourceRow['identity']|undefined>(receiptIdentity),[state,setState]=useState<PolicyLoadState|undefined>(receiptMatches?importReceipt?.face.state:undefined),[failure,setFailure]=useState<any>(receiptMatches?importReceipt?.face.failure:undefined),[busy,setBusy]=useState(false),[error,setError]=useState(''),[chooserStalled,setChooserStalled]=useState(false),[application,setApplication]=useState<{binding:PolicyAppliedBinding;before:PolicyCompatibilityContext}>()
 const [localEntries,setLocalEntries]=useState<LocalPolicyEntry[]>(importReceipt?.entry?[importReceipt.entry]:[]),[localId,setLocalId]=useState(importReceipt?.entry?.id??'')
 const serial=useRef(0),alive=useRef(true)
 /** Apply 结果里自己的新绑定：父组件收到 snapshot/world 后 props 会跟着变；这是同一动作的合法版本更新，
  *  不能当成"世界被别人改了"而清掉刚读回的状态。 */
 const acceptedBinding=useRef<{worldId?:string;revision?:number;generation?:number;before:PolicyCompatibilityContext;observed:boolean}>(undefined)
 const activating=useRef(false),bindingRef=useRef({worldId,revision:expectedRevision,generation:expectedGeneration,worldStatus})
 bindingRef.current={worldId,revision:expectedRevision,generation:expectedGeneration,worldStatus}
 // 选择/类型/路径任一变化都使在途的旧异步回执作废：新目标必须重新预检，旧回执不得串用。
 const invalidate=()=>{serial.current++;activating.current=false;acceptedBinding.current=undefined;setApplication(undefined);setBusy(false)}
 useEffect(()=>()=>{alive.current=false;serial.current++},[])
 useEffect(()=>{if(!available)return;let current=true;void command('policy_download_sources',{}).then(result=>{if(!current)return;setRows(Array.isArray(result.models)?result.models:[]);setLocalEntries(Array.isArray(result.localEntries)?result.localEntries:[])}).catch(error=>{if(current)setError(String(error))});return()=>{current=false}},[available])
 // 目标实例身份（scene+entity）变化＝用户切实例/场景：硬作废在途回执、清掉已接收的绑定。同一实例的
 // world/代次/版本变化若正是 Apply 自己提交的新绑定，则保留刚读回的状态，其余变化仍清显示要求重核。
 const instanceKey=`${sceneId??''}:${entityId??''}`
 const instanceRef=useRef(instanceKey)
 useEffect(()=>{if(instanceRef.current===instanceKey)return;instanceRef.current=instanceKey;invalidate();setState(undefined);setFailure(undefined)},[instanceKey])
 useEffect(()=>{
  const accepted=acceptedBinding.current
  if(accepted&&worldAllowsApply(worldStatus)){
   if(accepted.worldId===worldId&&accepted.revision===expectedRevision&&accepted.generation===expectedGeneration){accepted.observed=true;return}
   // 父层尚未接纳成功回执时，原绑定的ready/running轮询不使自己的Apply失效。
   // 一旦新绑定已被观察到，再回到旧绑定必须重新检查。
   if(!accepted.observed&&accepted.before.worldId===worldId&&accepted.before.expectedRevision===expectedRevision&&accepted.before.expectedGeneration===expectedGeneration)return
  }
  if(!activating.current)invalidate();setState(undefined);setFailure(undefined)
 },[worldId,worldStatus,expectedGeneration,expectedRevision])
 // 切实例/世界代次/版本或kind/identity变化时重读回执：文件与登记条目继续复用，旧兼容结果不串用。
 // 只随回执本体或实例身份重跑（world/版本由上面的效果按"是否同一动作"决定），不取消同一实例的在途动作。
 useEffect(()=>{if(!importReceipt)return
  const identity=importReceipt.face.identity??importReceipt.context?.identity
  // 父组件重发登记时的旧预检不能覆盖本次真实Apply结果；换策略/实例仍按新回执处理。
  const samePolicy=sameIdentity(identity,installedIdentity)&&(importReceipt.entry?.id?importReceipt.entry.id===localId:importReceipt.filePath===path)
  if(samePolicy&&(activating.current||application&&application.binding.sceneId===sceneId&&application.binding.entityId===entityId))return
  invalidate();setError('');setPath(importReceipt.filePath);setKind('policy')
  const matches=policyReceiptMatches(importReceipt,{kind:'policy',sceneId,entityId,worldId,expectedGeneration,expectedRevision,identity})
  setState(matches?importReceipt.face.state:undefined);setFailure(matches?importReceipt.face.failure:undefined);setInstalledIdentity(importReceipt.face.identity)
  if(importReceipt.entry){setLocalId(importReceipt.entry.id);setLocalEntries(rows=>[importReceipt.entry!,...rows.filter(row=>row.id!==importReceipt.entry!.id)])}},[importReceipt,sceneId,entityId])
 const selected=rows.find(row=>row.adapterId===sourceId),identity=installedIdentity??selected?.identity
 const context={kind,...sceneId?{sceneId,expectedRevision}:{},...entityId?{entityId}:{},...worldId?{worldId,expectedGeneration}:{}}
 // Applied只来自成功activate的完整绑定；父props尚未接纳同一动作时保留原上下文，外部变更立即失效。
 const accepted=application?.binding
 const ownWorld=accepted&&accepted.worldId===worldId&&accepted.revision===expectedRevision&&accepted.generation===expectedGeneration
 const priorWorld=application&&!acceptedBinding.current?.observed&&application.before.worldId===worldId&&application.before.expectedRevision===expectedRevision&&application.before.expectedGeneration===expectedGeneration
 const applied=Boolean(accepted&&kind==='policy'&&accepted.sceneId===sceneId&&accepted.entityId===entityId&&sameIdentity(accepted.identity,identity)&&(ownWorld||priorWorld)&&worldAllowsApply(worldStatus))
 const input=()=>({...context,...localId?{entryId:localId}:path.trim()?(localPolicyBundlePath(path.trim())?{manifestPath:path.trim()}:{filePath:path.trim()}):{},...identity?{identity}:{},...state?.localSource?{localSource:state.localSource}:{}})
 const run=async(task:(current:()=>boolean)=>Promise<any>,activate=false)=>{
  const request=++serial.current,current=()=>alive.current&&request===serial.current,before={...context,identity}
  activating.current=activate;acceptedBinding.current=undefined;setApplication(undefined);setBusy(true);setState(undefined);setError('');setFailure(undefined)
  try{
   const result=await task(current);if(!current())return
   const bound=result.appliedBinding as PolicyAppliedBinding|undefined,latest=bindingRef.current
   if(activate){
    const sameBefore=latest.worldId===before.worldId&&latest.revision===before.expectedRevision&&latest.generation===before.expectedGeneration
    const sameAfter=Boolean(bound&&latest.worldId===bound.worldId&&latest.revision===bound.revision&&latest.generation===bound.generation)
    // 成功和失败都核scope：晚到的ACTIVE_BLOCKED后续检查同样不能给第三个world恢复旧Apply资格。
    if((!sameBefore&&!sameAfter)||!worldAllowsApply(latest.worldStatus))return
    if(bound){
     acceptedBinding.current={worldId:bound.worldId,revision:bound.revision,generation:bound.generation,before,observed:sameAfter}
     setApplication({binding:bound,before})
    }
   }
   if(result.state)setState(result.state);if(result.failure)setFailure(result.failure);if(result.identity)setInstalledIdentity(result.identity)
   if(result.entry){setPath('');setLocalId(result.entry.id);setSourceId('');setInstalledIdentity(result.entry.identity);setLocalEntries(rows=>[result.entry,...rows.filter(row=>row.id!==result.entry.id)])}
   if(bound)onActivated?.(result.result)
  }catch(error){if(current())setError(String(error))}finally{if(current()){activating.current=false;setBusy(false)}}
 }
 const action=(value:'check'|'load'|'download'|'prepare'|'activate')=>run(async current=>value==='load'&&!localId?(await importLocalPolicy({command,current},path.trim(),{...context,...identity?{identity}:{}})).face:policyPanelAction({command,current},value,value==='download'?{...context,modelId:selected?.downloadModelId}:input()),value==='activate')
 const loadAsset=()=>run(async current=>{const id=selected?.downloadModelId;if(!id)return {};const result=await policyPanelAction({command,current},'asset',{modelId:id});if(current()&&result.result?.status==='ASSET_DOWNLOADED'&&typeof result.result.modelPath==='string'&&onAssetLoaded)await onAssetLoaded(result.result.modelPath,id,{packId:selected?.packId??id,downloadModelId:id,source:result.result.source,assetModel:result.result.assetModel,assetBytesVerified:result.result.assetBytesVerified,fullBundleReady:result.result.fullBundleReady,policyPrepared:false});return result})
 // 桌面选择器可能既不 resolve 也不 reject（实测：按钮卡在 Working… 永不回来）。
 // 这里给它一个有界等待：超时就把真实原因说出来，并露出"输入本地路径"这条可走的路，而不是无限转圈。
 const chooseAndRegister=()=>run(async current=>{
  setChooserStalled(false)
  const chosen=await Promise.race([
   (chooseFile?.() ?? Promise.resolve(undefined)),
   new Promise<undefined>(resolve=>{setTimeout(()=>resolve(undefined),CHOOSER_TIMEOUT_MS)}),
  ])
  if(!chosen){if(current()){setChooserStalled(true);setError(tr('系统文件选择器没有响应。可以直接在下面输入本机路径后导入。','The system file picker did not respond. Enter a local path below to import instead.'))}return {}}
  if(current()){setPath(chosen);setLocalId('');setInstalledIdentity(undefined);return (await importLocalPolicy({command,current},chosen,{...context,...selected?.identity?{identity:selected.identity}:{}})).face}
  return {}
 })
 // R-004 主路径：先显示身份与当前状态，再给**一个**语义明确的下一步；底层 register/download/adapter 命令全部收进高级详情。
 const chooseValue=localId?`entry:${localId}`:sourceId?`source:${sourceId}`:''
 const currentPolicyLabel=localId?(localEntries.find(entry=>entry.id===localId)?.label??localId):identity?`${identity.modelId} · ${identity.revision.slice(0,12)}`:tr('未配置策略','No policy configured')
 const compatibilityLabel=applied?tr('已应用','Applied'):failure?tr('操作被阻断','Operation blocked'):policyCompatibilityLabel(state,tr)
 const problem=policyProblemSummary(state,failure,error,tr)
 const policyChoice=useRef<HTMLSelectElement>(null)
 // 应用资格由服务端按“字节/来源/本体/引擎/绑定”核对并单独返回；不把“应用后必须匹配”误当前置。
 const applyEligible=Boolean(state&&identity&&entityId&&worldId&&worldAllowsApply(worldStatus)&&state.applyEligible===true)
 const incompatible=Boolean(state&&state.recovery!=='prepare_on_instance'&&(state.category==='model_incompatible'||hasAny(state,/MISMATCH/,['ROBOT_MODEL_MISMATCH','JOINT_COUNT_MISMATCH','POLICY_SOURCE_MISMATCH'])))
 // paused 的 WORLD_NOT_EXECUTABLE 不是绑定故障：准备/Apply 仍可继续；缺实例/场景/代次等真实绑定问题才拦。
 const bindingMissing=Boolean(state&&(state.missing??[]).some((item:{code:string})=>item.code!=='WORLD_NOT_EXECUTABLE'&&(/^(WORLD_|SCENE_)/.test(item.code)||['POLICY_ENTITY_NOT_FOUND','POLICY_EXPECTED_GENERATION_REQUIRED','POLICY_ROBOT_SELECTION_REQUIRED'].includes(item.code))))
 const needsWorld=bindingMissing||(worldStatus!==undefined&&worldStatus!=='paused'&&!executableWorld(worldStatus))
 const needsRuntime=hasAny(state,/^(RUNTIME_|POLICY_RUNTIME_)/)
 const primary=!identity&&!localId&&!path.trim()
  ? {label:chooseFile?tr('导入策略','Import policy'):tr('输入本地路径以导入','Enter a local path to import'),run:chooseFile?chooseAndRegister:undefined,disabled:!available||!canRegister||busy||!chooseFile}
  : !localId&&!identity&&path.trim()
   ? {label:tr('登记并检查此路径','Register and check this path'),run:()=>action('load'),disabled:!available||!canRegister||busy}
   : !state
    ? {label:tr('检查兼容','Check compatibility'),run:()=>action('check'),disabled:!available||busy}
    : applyEligible
     ? {label:tr('应用到所选实例','Apply to instance'),run:()=>action('activate'),disabled:!available||!canLoad||busy||!identity||!entityId||!worldId}
     : state.recovery==='prepare_on_instance'&&!needsWorld
      ? {label:tr('为本实例准备','Prepare for this instance'),run:()=>action('prepare'),disabled:!available||!canLoad||busy||!entityId||!identity}
      : incompatible
       ? {label:tr('当前实例不兼容','Incompatible with this instance'),run:undefined,disabled:true}
      : needsWorld||!worldId
       ? worldId
        ? {label:tr('重新检查世界绑定','Re-check world binding'),run:()=>action('check'),disabled:!available||busy}
        : {label:tr('先在物理面板准备世界','Prepare a physics world first'),run:undefined,disabled:true}
       : needsRuntime
        ? {label:tr('先选择策略运行环境','Select a policy runtime first'),run:undefined,disabled:true}
        : {label:tr('为本实例准备','Prepare for this instance'),run:()=>action('prepare'),disabled:!available||!canLoad||busy||!entityId||!identity}
 return <fieldset className="lya-robot-card lya-policy-card" data-testid="robot-policy-vla-library">
  <div className="lya-policy-path" data-testid="policy-main-path">
   <div className="lya-segment" role="tablist" aria-label={tr('策略类型','Policy type')}><button role="tab" aria-selected={kind==='policy'} onClick={()=>{invalidate();setKind('policy');setState(undefined);setFailure(undefined);setInstalledIdentity(undefined)}}>{tr('控制策略','Policy')}</button><button role="tab" aria-selected={kind==='vla'} onClick={()=>{invalidate();setKind('vla');setSourceId('');setInstalledIdentity(undefined);setState(undefined);setFailure(undefined)}}>VLA</button></div>
   <div className="lya-policy-status" data-testid="policy-status-line">
    <span className="lya-row-main" style={{flexBasis:'100%'}}><span className="lya-row-title" data-testid="policy-current" title={currentPolicyLabel} style={{whiteSpace:'normal',overflowWrap:'anywhere'}}>{currentPolicyLabel}</span><span className="lya-row-subtitle" data-testid="policy-target" style={{whiteSpace:'normal',overflowWrap:'anywhere'}}>{targetLabel??entityId??tr('未选实例','No instance selected')}</span></span>
    <span className={applied||/^Compatible|^兼容/.test(compatibilityLabel)?'lya-badge lya-badge-ok':'lya-badge'} data-testid="policy-compatibility" title={compatibilityLabel}>{!applied&&!failure&&state?.applyEligible&&!(state.ready&&state.worldBound)?tr('可应用','Ready to apply'):compatibilityLabel}</span>
   </div>
   {kind==='policy'&&<label className="lya-field-label">{tr('策略','Policy')}<select ref={policyChoice} className="lya-wide" data-testid="policy-choose" value={chooseValue} onChange={event=>{const value=event.target.value;invalidate();setState(undefined);setFailure(undefined);if(value.startsWith('entry:')){const id=value.slice(6),entry=localEntries.find(row=>row.id===id);setLocalId(id);setPath('');setSourceId('');setInstalledIdentity(entry?.identity)}else if(value.startsWith('source:')){setSourceId(value.slice(7));setLocalId('');setInstalledIdentity(undefined)}else{setLocalId('');setSourceId('');setInstalledIdentity(undefined)}}}><option value="">{tr('选择已登记策略或来源','Choose a registered policy or source')}</option>{localEntries.length>0&&<optgroup label={tr('本地已登记','Registered locally')}>{localEntries.map(entry=><option key={entry.id} value={`entry:${entry.id}`}>{entry.label}{entry.available?'':` · ${tr('缓存原件缺失','Cached bytes missing')}`}</option>)}</optgroup>}{rows.length>0&&<optgroup label={tr('已登记来源','Registered sources')}>{rows.map(row=><option key={row.adapterId} value={`source:${row.adapterId}`}>{row.label}</option>)}</optgroup>}</select></label>}
   {/* 无桌面选择器（真实Web入口）时首屏直接给本地路径输入；有原生选择器时默认只有一条 Import policy。 */}
   {kind==='policy'&&(!chooseFile||chooserStalled)&&<label className="lya-field-label">{tr('本地权重 / bundle.json / 完整目录','Local weights / bundle.json / complete directory')}<input className="lya-wide" data-testid="policy-main-path-input" value={path} onChange={e=>{invalidate();setPath(e.target.value);setLocalId('');setInstalledIdentity(undefined);setState(undefined);setFailure(undefined)}} placeholder={tr('输入本机路径；目录只读取根 bundle.json','Enter a local path; directories use root bundle.json')}/></label>}
   {problem&&<div data-testid="policy-problem"><p className="lya-error" role="alert" data-testid="policy-failure">{problem}</p>{kind==='policy'&&<button type="button" data-testid="policy-change" onClick={()=>policyChoice.current?.focus()}>{tr('更换策略','Change policy')}</button>}</div>}
   {applied?<div className="lya-row" data-testid="policy-applied">{onOpenControls&&<button className="lya-primary" data-testid="policy-open-controls" onClick={onOpenControls}>{tr('打开实例控制','Open instance controls')}</button>}<span className="lya-help">{tr('当前实例/世界/版本的真实匹配读回成立；行走仍需执行回执。','The current instance/world/version readback matches; walking still needs an execution receipt.')}</span></div>:<div className="lya-row"><button className="lya-primary" data-testid="policy-next" disabled={primary.disabled} onClick={()=>{if(primary.run)void primary.run()}}>{busy?tr('处理中…','Working…'):primary.label}</button></div>}
   {kind==='policy'&&<p className="lya-help" data-testid="policy-apply-impact">{tr('应用将停止并重建所选世界。','Apply stops and rebuilds the selected world.')}</p>}
   {kind==='vla'&&<p className="lya-help">{tr('当前机器人没有通用可执行VLA适配器。已存在权重仍需图像/状态观测、动作维度/单位及本体控制映射；加载不会启动远程推理。','There is no generic VLA executor for this robot. Weights still require observation and action mappings; loading never starts remote inference.')}</p>}
  </div>
  <details className="lya-advanced" data-testid="policy-advanced"><summary title={tr('高级本地条目、来源、运行环境与诊断','Advanced local entries, sources, runtime & diagnostics')}>{tr('策略详情','Policy details')}</summary>
   {kind==='policy'&&<p className="lya-help" data-testid="policy-apply-details">{tr('应用会先核对本体与当前引擎，停止并重建所选世界为策略固定步长；不改已保存引擎偏好、不执行行走。','Applying checks the model and current engine, stops and rebuilds the selected world with policy timing; it preserves the saved engine preference and does not execute walking.')}</p>}
  <p className="lya-help">{tr('原生关节和夹爪控制无需训练策略。拖入权重、bundle.json 或完整目录即可登记到本地策略库，无需先选机器人。准备、兼容与应用按所选实例分别预检。','Native joints and grippers need no trained policy. Drop weights, bundle.json or a complete directory to register locally before choosing a robot. Preparation, compatibility and application use the selected instance.')}</p>
  {!entityId&&<p className="lya-help">{tr('选择当前场景机器人实例后可核对本体与世界兼容性。','Select a robot instance to check compatibility with its world.')}</p>}
  <label className="lya-field-label">{tr('本地权重 / bundle.json / 完整目录','Local weights / bundle.json / complete directory')}<input className="lya-wide" value={path} onChange={e=>{invalidate();setPath(e.target.value);setLocalId('');setInstalledIdentity(undefined);setState(undefined)}} placeholder={tr('目录只读取根 bundle.json；不递归搜索','Directories use root bundle.json; no recursive search')}/></label>
  <div className="lya-row">{chooseFile&&<button data-policy-register="choose" disabled={!available||!canRegister||busy} onClick={()=>void chooseAndRegister()}>{tr('选择并登记文件','Choose and register file')}</button>}<button data-policy-register="path" disabled={!available||!canRegister||busy||!path.trim()&&!localId} onClick={()=>void action('load')}>{localId?tr('读取已登记策略','Read registered policy'):tr('登记本地文件 / 目录','Register local file / directory')}</button><button disabled={!available||busy} onClick={()=>void action('check')}>{busy?tr('检查中…','Checking…'):tr('检查状态 / 兼容','Check status / compatibility')}</button></div>
  <div data-testid="policy-local-library"><label className="lya-field-label">{tr('本地已登记策略','Registered local policies')}<select className="lya-wide" value={localId} aria-label={tr('本地已登记策略','Registered local policies')} onChange={event=>{const entry=localEntries.find(row=>row.id===event.target.value);invalidate();setLocalId(event.target.value);setPath('');setInstalledIdentity(entry?.identity);setSourceId('');setState(undefined);setFailure(undefined)}}><option value="">{tr('选择已登记原件；不会自动应用','Choose registered bytes; no automatic application')}</option>{localEntries.map(entry=><option key={entry.id} value={entry.id}>{entry.label} · {entry.available?(entry.identity?tr('固定来源','Pinned source'):tr('来源与接口待验证','Source and interfaces unverified')):tr('缓存原件缺失','Cached bytes missing')}</option>)}</select></label></div>
  {importReceipt?.entry&&<p className="lya-help" data-testid="policy-registration-receipt">{tr('已登记到本地策略库，重开可读取；机器人应用尚未执行。','Registered in the local library and available after reopening; robot application has not run.')}</p>}
  {state?.category==='weights_need_adapter'&&path&&!localPolicyBundlePath(path)&&<p className="lya-help" data-testid="policy-bundle-required">{state.localSource?.bundlePath?tr('已登记包根：','Registered bundle root: '):tr('请选择实际完整bundle或明确已登记来源；未扫描目录，也未猜测附近文件。','Choose a complete bundle or a registered source; directories and nearby files were not searched.')}<code>{state.localSource?.bundlePath??''}</code> · {tr('已实现适配器与本实例准备是不同状态。','Implemented adapters and preparation on this instance are separate states.')}</p>}
  {state?.localSource&&<p className="lya-help" data-testid="policy-local-source">{tr('本地来源：','Local source: ')}{state.localSource.status} · {state.localSource.adapterId??tr('未识别固定来源','Fixed source unidentified')} · {tr('准备入口：','Preparation: ')}{state.localSource.prepareFrom}{state.localSource.licenseUnchecked||state.localSource.missingLicense?.length?` · ${tr('完整包分发许可未核；明确本地权重采纳单独判断','Bundle distribution license unchecked; explicit local weights are assessed separately')}`:''}</p>}
  {kind==='policy'&&<><button disabled={!available||busy} onClick={()=>void run(async current=>{const result=await command('policy_download_sources',{});if(current()){setRows(Array.isArray(result.models)?result.models:[]);setLocalEntries(Array.isArray(result.localEntries)?result.localEntries:[])}return {}})}>{tr('刷新本地库 / 已登记来源','Refresh local library / registered sources')}</button><select className="lya-wide" aria-label={tr('已登记策略来源','Registered policy source')} value={sourceId} onChange={e=>{invalidate();setSourceId(e.target.value);setInstalledIdentity(undefined);setState(undefined);setFailure(undefined)}}><option value="">{tr('选择固定来源，不自动下载','Choose a source; no automatic download')}</option>{rows.map(row=><option key={row.adapterId} value={row.adapterId}>{row.label}</option>)}</select>
   {selected&&<p className="lya-help">{selected.identity.modelId} · {selected.identity.revision.slice(0,12)} · {tr('本地执行，完整依赖预检','Local execution with dependency preflight')}</p>}
   <div className="lya-row"><button disabled={!available||!canLoadAsset||!sceneId||busy||!selected?.downloadModelId||!onAssetLoaded} onClick={()=>void loadAsset()}>{tr('仅下载本体并载入','Download body and load')}</button><button disabled={!available||!canLoad||busy||!selected?.downloadModelId} onClick={()=>void action('download')}>{tr('下载已登记完整包','Download registered bundle')}</button><button disabled={!available||!canLoad||!entityId||busy||!identity} onClick={()=>void action('prepare')}>{tr('准备已登记适配器','Prepare registered adapter')}</button></div>
   <p className="lya-help">{tr('本体只取已核许可的XML与依赖，并登记到当前Scene/Resource；完整包、策略许可、适配器和世界执行各自预检。','Body files use their verified license and are registered in Scene/Resource; the policy bundle, adapter and world are checked separately.')}</p>
   <button disabled={applied||!available||!canLoad||busy||!identity||!entityId||!worldId||!applyEligible} onClick={()=>void action('activate')}>{tr('应用到所选实例 / 建立匹配世界','Apply to this instance / create matched world')}</button><p className="lya-help">{tr('该操作会先核同本体与当前引擎，停止并重建所选世界为策略固定步长；不改已保存引擎偏好、不执行行走。','This checks model and engine, stops and recreates the selected world with policy timing. It preserves engine preference and does not execute walking.')}</p>
   {selected&&!selected.downloadModelId&&<p className="lya-help">{tr('该来源尚无统一下载包入口；按下面固定文件来源取件，不能猜测下载型号。','No unified bundle endpoint for this source; use its exact files below.')}</p>}
  </>}
  {state&&<div role="status" data-policy-category={state.category}><strong>{policyCompatibilityLabel(state,tr)}</strong><p className="lya-help">{state.ready?tr('预检通过；运动成功仍需真实执行回执。','Preflight passed; motion still needs execution evidence.'):state.applyEligible?tr('适配器已准备；Apply 会重建所选世界，尚未执行行走。','Adapter prepared; Apply rebuilds the selected world; walking has not run.'):tr('尚不可执行；请一次处理下面缺项。','Execution is blocked; resolve the items below.')} · {tr('观测 / 动作 / 当前关节：','Observation / action / current joints: ')}{state.dimensions.observation??'—'} / {state.dimensions.action??'—'} / {state.dimensions.currentJointCount??'—'}</p>{state.missing.map((item,i)=><p className="lya-help" key={i}><code>{item.code}</code> · {item.field}：{item.detail}</p>)}{state.nextActions.map((item,i)=><p className="lya-help" key={i}>{item.label}</p>)}{state.preApplyDifferences?.length?<p className="lya-help" data-testid="policy-pre-apply">{tr('应用前差异（Apply 会重建）：','Differences Apply will rebuild: ')}{state.preApplyDifferences.map((d,i)=><code key={i}>{d.path}</code>)}</p>:null}</div>}
  {state&&state.executionKind!=='native_control'&&<p className="lya-help" data-testid="policy-execution-evidence">{tr('本地适配：','Local preparation: ')}{state.policyPrepared?tr('已有已验适配信息','Verified adapter metadata exists'):tr('未准备','Not prepared')} · {tr('运行依赖：','Runtime dependencies: ')}{state.runtimeChecked&&!state.missing.some(m=>m.code.startsWith('RUNTIME_'))?tr('预检满足','Preflight satisfied'):tr('未满足或未核','Missing or unchecked')} · {tr('实际推理与稳定行走以运行回执判定；此状态检查没有完成稳定行走验收。','Actual inference and stable walking require execution evidence; this state check has not accepted stable walking.')}</p>}
  {state?.runtime&&<div className="lya-help" data-testid="policy-runtime-selection">
   <p>{tr('策略运行环境：','Policy runtime: ')}{state.runtime.status==='AVAILABLE'?`${state.runtime.provider} / ${state.runtime.source} · ${state.runtime.python}`:tr('已登记解释器没有满足所需依赖','Registered interpreters do not satisfy the required modules')}</p>
   <p>{tr('当前来源所需模块：','Required modules for this source: ')}{state.runtime.requiredModules.join(' / ')} · {tr('CPU 模式；选择解释器不启动物理引擎','CPU mode; interpreter selection does not start physics')}</p>
   {state.runtime.status==='AVAILABLE'?<p>{Object.entries(state.runtime.versions).map(([name,version])=>`${name} ${version}`).join(' · ')}</p>:<><p>{state.runtime.prepare?.detail}</p><p>{tr('设置 → 物理引擎 → 策略 CPU 独立环境，可安装/修复；ONNX 依赖由 MuJoCo 安装提供。','Settings → Physics engines → Independent policy CPU environment for install/repair; MuJoCo supplies ONNX dependencies.')}</p><code>{state.runtime.prepare?.command}</code></>}
  </div>}
  {state?.evidence&&<div className="lya-help" data-testid="policy-state-layers">
   <p>{tr('本体与缓存：','Robot and cache: ')}{tr('当前场景本体','Robot in this scene')}={state.evidence.robotPresent?tr('存在','present'):tr('未选实例或未核','no instance or unchecked')} · {tr('完整包字节已验','Complete bundle verified')}={state.evidence.completeBundleVerified?tr('是','yes'):tr('未核','unchecked')} · {tr('权重存在 / 字节已验','Weights present / verified')}={[state.evidence.weightsPresent,state.evidence.weightsVerified].map(v=>v?tr('是','yes'):tr('未核','unchecked')).join(' / ')}</p>
   <p>{tr('适配与实例：','Adapter and instance: ')}{tr('代码已实现 / 缓存已准备 / 本实例已匹配 / 运行依赖','Implemented / prepared cache / matched instance / runtime')}={[state.evidence.adapterImplemented,state.evidence.cachePrepared,state.evidence.preparedOnInstance,state.evidence.runtimeReady].map(v=>v?tr('是','yes'):tr('未核或未满足','missing or unchecked')).join(' / ')}</p>
   <p>{tr('世界匹配 / 世界正在运行','World matched / world running')}={[state.evidence.worldMatched,state.evidence.worldRunning].map(v=>v?tr('是','yes'):tr('否或未核','no or unchecked')).join(' / ')}{state.world?` · ${state.world.status} · ${tr('代次 / 场景版本','Generation / scene revision')} ${state.world.worldGeneration} / ${state.world.appliedSceneRevision}`:''} · {tr('行为验收：未由此检查证明','Behavior: not verified by this check')}</p>
  </div>}
  {failure&&<p className="lya-error" role="alert">{failure.code}：{failure.message} · {tr('已立即停止，未自动重试。','Stopped immediately; no automatic retry.')}</p>}
  {failure?.missingFiles?.length>0&&<p className="lya-error">{tr('缺文件：','Missing files: ')}{failure.missingFiles.join('、')}</p>}{failure?.missingLicense?.length>0&&<p className="lya-error">{tr('许可未核：','License unchecked: ')}{failure.missingLicense.join('、')} · {tr('补齐许可前不取件；固定来源链接仅供核对。','Resolve the license before fetching; fixed source links are for verification.')}</p>}
  {(failure?.fallback||selected?.fallback)&&<details open={Boolean(failure)}><summary>{tr('准确来源 web_fetch 回退','Exact source web_fetch fallback')}</summary><p className="lya-help">{failure?.missingLicense?.length?tr('先核所列许可。来源固定，不能通过另一包或另一revision绕过阻断。','Verify the listed license first; another bundle or revision cannot bypass this block.'):tr('端点首错误后按固定revision取明确文件，不重复本地搜索或整仓下载。','On the first endpoint error, fetch exact files at the fixed revision.')}</p>{((failure?.fallback??selected?.fallback)?.urls??[]).map((row:any)=><p className="lya-help" key={row.path}><a href={row.url} target="_blank" rel="noreferrer">{row.path}</a></p>)}{((failure?.fallback??selected?.fallback)?.directories??[]).map((row:any)=><p className="lya-help" key={row.path}>{tr('声明依赖目录：','Declared dependency directory: ')}<a href={row.url} target="_blank" rel="noreferrer">{row.path}</a></p>)}</details>}
  {error&&<p className="lya-error" role="alert">{error}</p>}
  </details>
 </fieldset>
}
