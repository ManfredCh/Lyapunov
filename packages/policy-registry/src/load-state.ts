/** 机器人侧栏使用的策略/VLA加载状态；只读，绝不因缺参启动下载或伪造观测。 */
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {realpath} from 'node:fs/promises'
import {resolve} from 'node:path'
import {verifyPolicy,readAdapter,isPreparedAdapter,isLiberoVlaAdapter,type PolicyIdentity} from './adapter.ts'
import {matchPolicy,resolvePolicyWorldBinding,type PolicyMatchInput} from './match.ts'
import {robotDownloadPreflight,type RobotDownloadManifest} from './robot-download.ts'
import type {SimWorlds} from '../../sim-contract/src/index.ts'
import type {SceneSnapshot,WorldHandle} from '../../lyapunov-contracts/src/types.ts'
import {inspectLocalPolicyFile} from './local-policy-file.ts'
import {IMPLEMENTED_POLICY_ADAPTERS} from './pack-contract.ts'
import {verifyRegisteredPolicyFiles,type LocalPolicySource} from './local-policy-source.ts'
import {selectPolicyRuntime,type PolicyRuntimeConfig,type PolicyRuntimeResolution} from './runtime.ts'
import {hashFile} from './source.ts'
export type AdapterBodyIdentity='same-path'|'same-source-bytes'|'same-prepared-bytes'|'different-bytes'|'unproven'
export interface PolicyLoadState {
 category:'direct_execution'|'weights_need_adapter'|'missing_files_or_runtime'|'model_incompatible'
 executionKind:'native_control'|'local_torch'|'local_onnx'|'unsupported_vla'
 ready:boolean;runtimeChecked:boolean;modelId?:string
 /** 可应用资格：字节/来源/本体/引擎/绑定都已核对，允许由明确 Apply 重建 controller/observations/固定步长 world。
  *  与 `ready`（应用后已在当前世界匹配）严格分开：应用前不预先声称 ready 或行走已验证。 */
 applyEligible:boolean
 /** 仅因当前世界尚未被 Apply 重建而产生的差异；不是缺项，Apply 会按 prepared 适配器覆盖。 */
 /** 世界已按同一Scene版本重建前的合法差异；Apply 会按 prepared 适配器覆盖。 */
 preApplyDifferences:Array<{path:string;reason:string;detail:string}>
 /** 仅当旧适配器与当前登记本体无法按现存字节/已登记哈希证明同源时返回：允许且只允许在当前实例
  *  走现有 policy_prepare 重建适配器；不授予 Apply，也不自动执行。 */
 recovery?:'prepare_on_instance'
 dimensions:{observation?:number;action?:number;currentJointCount?:number;requiredJointCount?:number}
 missing:Array<{code:string;field:string;detail:string;nextAction:string}>
 nextActions:Array<{kind:'native_controls'|'local_load'|'prepare'|'match'|'install_runtime'|'web_fetch';label:string;input?:unknown}>
 worldBound:boolean;policyPrepared:boolean;robotWalkingVerified:false
 localSource?:LocalPolicySource
 runtime?:PolicyRuntimeResolution
 world?:Pick<WorldHandle,'worldId'|'sceneId'|'worldGeneration'|'appliedSceneRevision'|'engineId'|'status'>
 evidence?:{robotPresent:boolean;weightsPresent:boolean;weightsVerified:boolean;completeBundleVerified:boolean;adapterImplemented:boolean;filesVerified:boolean;cachePrepared:boolean;preparedOnInstance:boolean;runtimeReady:boolean;worldMatched:boolean;worldRunning:boolean;behaviorVerified:false;bodyIdentity?:AdapterBodyIdentity}
}
export async function probePolicyRuntime(python:string):Promise<ReadonlySet<string>> {
 const script="import importlib,json;out=[]\nfor name in ['mujoco','numpy','torch','yaml','onnxruntime','transformers','PIL','safetensors']:\n try: importlib.import_module(name);out.append(name)\n except Exception: pass\nprint(json.dumps(out))"
 const {stdout}=await promisify(execFile)(python,['-c',script],{timeout:8000,maxBuffer:4096,env:{...process.env,CUDA_VISIBLE_DEVICES:'',HF_ENDPOINT:'https://hf-mirror.com'}})
 return new Set(JSON.parse(stdout))
}
/** Apply 会用 prepared.components/worldOptions 覆盖的字段：这些在应用前必然与当前世界不同，
 *  属于“应用后必须匹配”，不能误当“应用前资格”而把人锁进循环。其余差异（本体字节/关节集/来源身份/
 *  引擎/陈旧绑定/provider 观测源）仍是真不兼容，继续阻断。 */
const APPLY_REBUILT_DIFFERENCES=new Set([
 'controller.robot','controller.scene.frequencyHz','controller.scene.controlMode',
 'controller.frequencyHz','controller.controlMode','controller.gravityCompensation',
 'world.clock','world.timestepS','observations.schema','model.sha256',
])
const applyRebuilds=(difference:{path:string;reason:string}):boolean=>APPLY_REBUILT_DIFFERENCES.has(difference.path)||(difference.path==='model'&&difference.reason==='ROBOT_PHYSICS_MODEL_UNREADABLE')
/** `WORLD_NOT_EXECUTABLE` 有两种语义：paused 是“执行需要运行态，但 Apply 会重建同一 Scene 版本”，
 *  可以继续准备/应用；其余状态（closed/failed/初始化中等）连 Apply 的同一版本绑定都不成立，仍须阻断。 */
const worldRebuildableForApply=(status:string|undefined):boolean=>status==='paused'
const executionOnlyWorldMissing=(item:{code:string},status:string|undefined):boolean=>item.code==='WORLD_NOT_EXECUTABLE'&&worldRebuildableForApply(status)
/** 已准备适配器必须指向当前实例真实登记的原件（或其合法派生件）：不能只凭关节数量/名称或robot显示名借用别的本体。
 *  版本/安装目录搬迁会让旧绝对路径消失或换位，因此先比路径，再按**文件字节与准备时登记的哈希**核对：
 *  · 原件复制到新路径：modelSourcePath/新增 modelSourceSha256 与当前登记原件字节相同 ⇒ 同源；
 *  · 已应用派生件：当前实体 sourcePath 就是 adapter.modelPath，或字节等于 modelSha256 ⇒ 同源；
 *  · 旧路径缺失且没有任何可核字节/哈希 ⇒ `unproven`，不借用旧适配器 Apply，但给出本实例重准备；
 *  · 可读的旧原件字节不同 ⇒ `different-bytes`，仍是真不兼容（Go1→Go2 / Panda 不得借放行）。 */
async function adapterTargetsRegisteredBody(adapter:{modelPath?:unknown;modelSourcePath?:unknown;modelSha256?:unknown;modelSourceSha256?:unknown}|undefined,entitySource:unknown):Promise<{status:boolean|undefined;evidence:AdapterBodyIdentity}>{
 const source=typeof entitySource==='string'&&entitySource?entitySource:undefined
 if(!adapter||!source)return {status:undefined,evidence:'unproven'}
 const modelPath=typeof adapter.modelPath==='string'&&adapter.modelPath?adapter.modelPath:undefined
 const sourcePath=typeof adapter.modelSourcePath==='string'&&adapter.modelSourcePath?adapter.modelSourcePath:undefined
 const samePath=async(a:string,b:string)=>{try{if(await realpath(a)===await realpath(b))return true}catch{};try{return resolve(a)===resolve(b)}catch{return false}}
 for(const candidate of [modelPath,sourcePath])if(candidate&&await samePath(candidate,source))return {status:true,evidence:'same-path'}
 if(!modelPath&&!sourcePath)return {status:undefined,evidence:'unproven'}
 let sourceHash:string
 try{sourceHash=(await hashFile(source)).sha256}catch{return {status:false,evidence:'different-bytes'}}
 // 重新 Apply 后实体 sourcePath 可以是 prepared 派生件（或它的副本）；可靠哈希相等即可证明同一已准备模型。
 if(typeof adapter.modelSha256==='string'&&adapter.modelSha256===sourceHash)return {status:true,evidence:'same-prepared-bytes'}
 // 旧原件仍可读：按真实字节下结论（不同字节必须继续挡住，不能因同名/同DOF放行）。
 if(sourcePath){try{const old=(await hashFile(sourcePath)).sha256;return {status:old===sourceHash,evidence:old===sourceHash?'same-source-bytes':'different-bytes'}}catch{}}
 // 旧原件路径已回收：只信准备时写下的原件哈希；这是“已登记事实”，不是按basename猜。
 if(typeof adapter.modelSourceSha256==='string'&&adapter.modelSourceSha256)return {status:adapter.modelSourceSha256===sourceHash,evidence:adapter.modelSourceSha256===sourceHash?'same-source-bytes':'different-bytes'}
 // 没有独立原件路径时，modelPath 本身就是原件（G1 同路径）；可读则按字节判定。
 if(modelPath&&(!sourcePath||await samePath(modelPath,sourcePath))){try{const old=(await hashFile(modelPath)).sha256;return {status:old===sourceHash,evidence:old===sourceHash?'same-source-bytes':'different-bytes'}}catch{}}
 return {status:undefined,evidence:'unproven'}
}
export async function policyLoadState(config:{dataDirectory:string}&PolicyRuntimeConfig,input:{identity?:PolicyIdentity;filePath?:string;manifest?:RobotDownloadManifest;nativeControl?:boolean;kind?:'policy'|'vla';currentJointNames?:string[];binding?:PolicyMatchInput;localSource?:LocalPolicySource},ports:{runtimeModules?:ReadonlySet<string>;scene?:{inspect(id:string):Promise<SceneSnapshot>|SceneSnapshot};sim?:Pick<SimWorlds,'describe'|'observe'|'listWorlds'>}={}):Promise<PolicyLoadState> {
 const out:PolicyLoadState={category:'missing_files_or_runtime',executionKind:'unsupported_vla',ready:false,runtimeChecked:false,applyEligible:false,preApplyDifferences:[],dimensions:input.currentJointNames?{currentJointCount:input.currentJointNames.length}:{},missing:[],nextActions:[],worldBound:false,policyPrepared:false,robotWalkingVerified:false}
 if(input.localSource)out.localSource=input.localSource
 const add=(code:string,field:string,detail:string,nextAction:string)=>{if(!out.missing.some(m=>m.code===code&&m.field===field))out.missing.push({code,field,detail,nextAction})}
 const selectedIdentity=input.identity??(input.manifest?{provider:input.manifest.source.provider,modelId:input.manifest.source.modelId,revision:input.manifest.source.resolvedRevision}:undefined)
 const implemented=selectedIdentity?.provider==='github'&&IMPLEMENTED_POLICY_ADAPTERS.some(a=>a.modelId===selectedIdentity.modelId&&a.revision===selectedIdentity.revision)
 const evidence:NonNullable<PolicyLoadState['evidence']>={robotPresent:false,weightsPresent:false,weightsVerified:false,completeBundleVerified:false,adapterImplemented:implemented,filesVerified:false,cachePrepared:false,preparedOnInstance:false,runtimeReady:false,worldMatched:false,worldRunning:false,behaviorVerified:false};out.evidence=evidence
 // 库/缓存状态与所选 Scene 实例分开；只从本会话 Scene 与原生句柄读事实，不改物理 owner。
 let boundEntity:SceneSnapshot['entities'][number]|undefined,boundWorld:WorldHandle|undefined
 if(input.binding){
  let snapshot:SceneSnapshot|undefined
  try{snapshot=await ports.scene?.inspect(input.binding.sceneId)}catch{}
  const entity=snapshot?.entities.find(e=>e.entityId===input.binding!.entityId)
  boundEntity=entity
  evidence.robotPresent=Boolean(entity)
  if(!snapshot)add('SCENE_BINDING_UNCHECKED','sceneId','The current session scene has not been read back; library bytes cannot stand in for this instance','match')
  else if(!entity)add('POLICY_ENTITY_NOT_FOUND','entityId','The selected robot instance does not belong to the current scene','match')
  const bound=await resolvePolicyWorldBinding(input.binding,ports.sim)
  input={...input,binding:bound}
  let world:WorldHandle|undefined
  try{world=(await ports.sim?.listWorlds())?.find(w=>w.worldId===bound.worldId)}catch{}
  boundWorld=world
  if(world){
   out.world={worldId:world.worldId,sceneId:world.sceneId,worldGeneration:world.worldGeneration,appliedSceneRevision:world.appliedSceneRevision,engineId:world.engineId,status:world.status}
   if(world.sceneId!==bound.sceneId)add('WORLD_SCENE_MISMATCH','world.sceneId','The selected world belongs to another scene and cannot be borrowed','match')
   if(bound.expectedGeneration===undefined)add('POLICY_EXPECTED_GENERATION_REQUIRED','expectedGeneration','An explicitly selected world must provide its current generation','match')
   else if(world.worldGeneration!==bound.expectedGeneration)add('WORLD_GENERATION_MISMATCH','expectedGeneration','The world generation changed; re-read the current world','match')
   if(snapshot&&world.appliedSceneRevision!==snapshot.revision)add('SCENE_REVISION_MISMATCH','world.appliedSceneRevision','The selected world has not synchronized the current scene revision','match')
   out.worldBound=Boolean(entity)&&!out.missing.length
   evidence.worldRunning=out.worldBound&&world.status==='running'
   if(!['ready','running'].includes(world.status))add('WORLD_NOT_EXECUTABLE','world.status',world.status==='paused'?'World status is paused; preparing/applying rebuilds this same Scene version, while executing needs a running world':'World status is '+world.status+'; restore a matching world before preparing or executing','match')
  }else add('WORLD_REQUIRED','worldId','Choose a real world of this scene in this session; a missing world does not trigger a robot re-download','match')
 }
 if(input.filePath){const fact=await inspectLocalPolicyFile(input.filePath)
  if(!fact.valid){add(fact.code!,'filePath',fact.detail!,'local_load');return out}
  evidence.weightsPresent=true
  if(!input.identity&&!input.manifest){out.category='weights_need_adapter';add('POLICY_ADAPTER_REQUIRED','adapter',input.kind==='vla'?'The VLA file header exists, but registered image/state observations, actions and body mappings are still missing; unknown weights are not executed':'The file header exists, but a registered source, observations and action mapping are still missing; dimensions/graph are unverified, so unknown weights are not executed','prepare');add('POLICY_SOURCE_UNVERIFIED','source','Provide a pinned source and a proper bundle.json; a filename cannot prove model identity','local_load');add('POLICY_OBSERVATION_MAPPING_REQUIRED','observations','Missing observation dimensions, order, units and the current body state mapping','prepare');add('POLICY_ACTION_MAPPING_REQUIRED','actions','Missing action dimensions, order, units and the joint control mapping','prepare');out.nextActions=[{kind:'local_load',label:'Choose a bundle.json with a pinned source and observation/action interfaces; registered unknown weights are never applied automatically'}];return out}
 }
 if(!input.nativeControl&&!input.identity&&!input.manifest){add('POLICY_SOURCE_MISSING','source','No local file or pinned-source bundle chosen yet','local_load');return out}
 let runtime:ReadonlySet<string>|undefined=ports.runtimeModules
 if(!runtime&&!input.nativeControl){const pin=IMPLEMENTED_POLICY_ADAPTERS.find(a=>selectedIdentity?.provider==='github'&&a.modelId===selectedIdentity.modelId&&a.revision===selectedIdentity.revision);out.runtime=await selectPolicyRuntime(config,pin?.id);runtime=out.runtime.status==='AVAILABLE'?new Set(out.runtime.modules):new Set<string>()}
 out.runtimeChecked=runtime!==undefined
 if(!runtime&&!input.nativeControl)add('RUNTIME_PROBE_UNAVAILABLE','python','The designated policy Python is unavailable or module preflight is incomplete; choose a local interpreter with the required dependencies instead of searching for more bodies','install_runtime')
 if(out.runtime?.status==='BLOCKED'){add('POLICY_RUNTIME_UNAVAILABLE','python',out.runtime.checked.map(c=>`${c.provider}：${c.missingModules.join('/')} ${c.error??''}`).join('；'),'install_runtime');out.nextActions.push({kind:'install_runtime',label:out.runtime.prepare!.command+'；'+out.runtime.prepare!.detail})}
 if(input.nativeControl){
  out.category='direct_execution';out.executionKind='native_control'
  // 原生控制运行时由已打开真实world证明；不因policy解释器缺Torch阻断机械臂关节。
  if(input.binding&&ports.sim){const bound=input.binding;if(bound.worldId&&out.worldBound){try{const d=await ports.sim.describe(bound.worldId,bound.entityId);out.dimensions.currentJointCount=d.joints.length;out.dimensions.requiredJointCount=d.controlledJointNames.length;if(d.expectedGeneration!==out.world?.worldGeneration)add('WORLD_GENERATION_MISMATCH','description.expectedGeneration','The native control mapping does not belong to the current world generation','native_controls');if(!d.controlledJointNames.length)add('NATIVE_CONTROL_UNAVAILABLE','controller','No usable native joint control mapping was read back','native_controls');const frame=await ports.sim.observe(bound.worldId,{entityIds:[bound.entityId]});if(frame.generation!==out.world?.worldGeneration||frame.sceneRevision!==out.world.appliedSceneRevision||!frame.entities.some(e=>e.entityId===bound.entityId))add('NATIVE_OBSERVATION_MISMATCH','frame','Native joint observations do not match the current instance/world revision','native_controls')}catch{add('ROBOT_DESCRIPTION_UNAVAILABLE','controller','The live provider returned no control mapping or observations for the target robot','native_controls')}}}
  else add('WORLD_BINDING_UNCHECKED','worldId','No real world binding read yet; do not download a policy just for joint control','native_controls')
  out.runtimeChecked=out.worldBound;out.ready=out.missing.length===0;evidence.runtimeReady=out.ready;evidence.worldMatched=out.ready;out.nextActions=[{kind:'native_controls',label:'Use native robot joint/gripper control; no trained policy is needed, while legged walking still needs a matched policy'}];return out
 }
 if(!input.binding)add('POLICY_ROBOT_SELECTION_REQUIRED','entityId','Policy registered; choose a real robot in the current scene to check body, observation/action and world compatibility','match')
 if(input.manifest){const p=robotDownloadPreflight(input.manifest,{runtimeModules:runtime,currentJointNames:input.currentJointNames});out.modelId=p.modelId;if(input.manifest.adapter){out.dimensions.requiredJointCount=input.manifest.adapter.controlledJointCount;out.dimensions.action=input.manifest.adapter.actionDim??input.manifest.adapter.controlledJointCount;out.dimensions.observation=input.manifest.adapter.observationDim}
  for(const path of p.missingFiles)add('POLICY_DEPENDENCY_MISSING',path,'The complete manifest is missing files; fetching them one by one is not preparation success','web_fetch')
  for(const name of p.missingRuntime)add('RUNTIME_MISSING',name,'Local runtime dependencies are unmet; the robot search does not continue','install_runtime')
  if(p.modelMismatch){out.category='model_incompatible';add('ROBOT_MODEL_MISMATCH','jointNames','The current body and the policy controlled joints differ; the model is not replaced automatically','local_load');return out}
  if(p.unknownAdapter||p.wrongSource){out.category='weights_need_adapter';add('POLICY_ADAPTER_REQUIRED','adapter','The weights manifest source/adapter is not registered','prepare');return out}
 }
 const identity=input.identity??(input.manifest?{provider:input.manifest.source.provider,modelId:input.manifest.source.modelId,revision:input.manifest.source.resolvedRevision}:undefined)
 if(!identity){add('POLICY_SOURCE_MISSING','source','No local path or pinned-source bundle chosen yet','local_load');return out}
 if(input.manifest&&(identity.provider!==input.manifest.source.provider||identity.modelId!==input.manifest.source.modelId||identity.revision!==input.manifest.source.resolvedRevision)){out.category='model_incompatible';add('POLICY_SOURCE_MISMATCH','identity','The selected identity differs from the bundle pinned source; another set of weights cannot be borrowed','local_load');return out}
 out.modelId=identity.modelId
 const registered=identity.provider==='github'?IMPLEMENTED_POLICY_ADAPTERS.find(a=>a.modelId===identity.modelId&&a.revision===identity.revision):undefined
 if(registered){out.executionKind=registered.adapter==='onnx'?'local_onnx':'local_torch';for(const name of registered.requires.runtimeModules??['mujoco','numpy',out.executionKind==='local_onnx'?'onnxruntime':'torch','yaml'])if(!runtime?.has(name)&&!out.missing.some(m=>m.field===name))add('RUNTIME_MISSING',name,'Local runtime dependencies required by the registered source are missing; do not keep searching for bodies','install_runtime')}
 evidence.runtimeReady=out.runtimeChecked&&out.runtime?.status!=='BLOCKED'&&!out.missing.some(m=>m.code.startsWith('RUNTIME_')||m.code==='POLICY_RUNTIME_UNAVAILABLE')
 const verified=await verifyPolicy(config.dataDirectory,identity)
 const sourceChecks=await verifyRegisteredPolicyFiles(verified.root,verified.manifest?{provider:verified.manifest.provider,modelId:verified.manifest.modelId,revision:verified.manifest.resolvedRevision}:identity)
 for(const check of sourceChecks)if(!check.valid)add('POLICY_ADAPTER_SOURCE_MISMATCH',check.path,'Required files of the registered pinned source are missing or mismatched; self-reported hashes cannot prove source authenticity','local_load')
 evidence.filesVerified=verified.valid
 const weightFiles=verified.checks.filter(c=>typeof c.path==='string'&&/\.(?:pt|pth|jit|onnx|safetensors)$/i.test(c.path))
 evidence.weightsPresent=evidence.weightsPresent||weightFiles.some(c=>c.valid===true)
 evidence.weightsVerified=weightFiles.length>0&&weightFiles.every(c=>c.valid===true)&&verified.valid&&sourceChecks.every(c=>c.valid)
 const bundle=verified.manifest?.metadata?.downloadBundle
 evidence.completeBundleVerified=verified.valid&&sourceChecks.length>0&&sourceChecks.every(c=>c.valid)&&Boolean(bundle&&bundle.fileCount===verified.checks.length&&bundle.totalBytes===verified.manifest!.files.reduce((n,f)=>n+f.bytes,0))
 if(registered)for(const path of registered.requires.files)if(!verified.manifest?.files?.some(f=>f.path===path))add('POLICY_DEPENDENCY_MISSING',path,'Required source files of the registered policy are missing; supply them together and do not substitute other files','local_load')
 for(const check of verified.checks)if(check.valid!==true)add('POLICY_FILE_NOT_VERIFIED',String(check.path),'Pinned-source file missing, or bytes/verification identity mismatched','local_load')
 if(!verified.valid){if(input.filePath)out.category='weights_need_adapter';add('POLICY_FILES_NOT_VERIFIED','manifest',input.filePath?'The selected local file exists, but was not installed and verified as the pinned source/complete dependency closure; it is not a registered executable policy':'No verified local weights/complete dependencies; a file list does not mean the policy is installed','local_load');out.nextActions=[{kind:'local_load',label:'Load a proper bundle or match a registered adapter; do not re-search the already selected files'}];return out}
 const adapter=await readAdapter(verified.root)
 if(!isPreparedAdapter(adapter)&&!isLiberoVlaAdapter(adapter)){out.category='weights_need_adapter';add('POLICY_ADAPTER_UNAVAILABLE','adapter','Bytes are verified, but the observation/control mapping for this model is still missing','prepare');out.nextActions=[{kind:'prepare',label:'Generate the registered-source adapter; do not mix 12/23 or other robots'}];return out}
 out.policyPrepared=true
 evidence.cachePrepared=true
 if(input.kind==='vla'&&!isLiberoVlaAdapter(adapter)){out.category='weights_need_adapter';out.executionKind='unsupported_vla';add('VLA_ADAPTER_REQUIRED','adapter','The selected file is an ordinary control policy and cannot pose as a VLA image/state-to-action adapter','prepare');return out}
 if(isLiberoVlaAdapter(adapter)){out.executionKind='unsupported_vla';out.dimensions.action=adapter.actionDim;for(const name of ['torch','transformers','PIL','safetensors'])if(!runtime?.has(name))add('RUNTIME_MISSING',name,'VLA local inference dependencies are missing','install_runtime');add('VLA_ROBOT_BINDING_UNSUPPORTED','observations/control','The registered LIBERO benchmark route cannot drive this robot directly; a matching image/state observation and action control adapter is missing','prepare');out.category='weights_need_adapter';return out}
 if(isPreparedAdapter(adapter)){out.executionKind=adapter.inferenceFormat==='onnx'?'local_onnx':'local_torch';out.dimensions.observation=adapter.config.num_obs;out.dimensions.action=adapter.config.num_actions;out.dimensions.requiredJointCount=adapter.jointNames.length
  for(const name of ['mujoco','numpy',out.executionKind==='local_onnx'?'onnxruntime':'torch'])if(!runtime?.has(name))add('RUNTIME_MISSING',name,'Local runtime dependencies required by the prepared policy are missing','install_runtime')
  if(input.currentJointNames&&(input.currentJointNames.length!==adapter.jointNames.length||adapter.jointNames.some(n=>!input.currentJointNames!.includes(n)))){out.category='model_incompatible';add('ROBOT_MODEL_MISMATCH','jointNames','The current body and the prepared policy joint sets differ','local_load');return out}
 }
 evidence.runtimeReady=out.runtimeChecked&&out.runtime?.status!=='BLOCKED'&&!out.missing.some(m=>m.code.startsWith('RUNTIME_')||m.code==='POLICY_RUNTIME_UNAVAILABLE')
 if(input.binding&&ports.scene&&ports.sim){const bound=await resolvePolicyWorldBinding({...input.binding,...identity},ports.sim);const matched=await matchPolicy(config,bound,ports.scene,ports.sim)
  evidence.worldMatched=matched.status==='MATCHED';evidence.preparedOnInstance=matched.status==='MATCHED'
  out.preApplyDifferences=matched.differences.filter(applyRebuilds).map(d=>({path:d.path,reason:d.reason,detail:'The current world has not been rebuilt by Apply; applying overwrites this field from the prepared adapter'}))
  // 应用前先核适配器指向的真实登记原件：不同本体的适配器不能仅凭关节数量/名称或robot显示名放行。
  const entitySource=boundWorld?((boundEntity?.components as Record<string,unknown>|undefined)?.[boundWorld.engineId] as {sourcePath?:unknown}|undefined)?.sourcePath:undefined
  const matchedAdapter=(matched as {adapter?:{modelPath?:unknown;modelSourcePath?:unknown;modelSha256?:unknown;modelSourceSha256?:unknown}}).adapter
  const body=await adapterTargetsRegisteredBody(matchedAdapter,entitySource)
  evidence.bodyIdentity=body.evidence
  if(body.status===false){out.category='model_incompatible';out.applyEligible=false;add('ROBOT_PHYSICS_MODEL_MISMATCH','adapter.modelSourcePath','The prepared adapter was built for a different registered body; prepare again on this instance instead of borrowing another body','prepare');return out}
  if(matched.status!=='MATCHED'){
   const fatal=matched.differences.filter(d=>!applyRebuilds(d))
   const blockingMissing=out.missing.some(item=>!executionOnlyWorldMissing(item,out.world?.status))
   if(fatal.length||blockingMissing||!evidence.runtimeReady){for(const d of fatal)add(d.reason,d.path,'The actual world/observation/control mapping has not passed; fix by field instead of a download loop','match');out.category=fatal.some(d=>/MODEL|JOINT|SIMULATOR/.test(d.reason))?'model_incompatible':'missing_files_or_runtime';out.applyEligible=false;return out}
   // 旧适配器路径已回收且无可核字节/登记哈希：拒绝借用旧派生件 Apply，但这不是死路——
   // 允许从当前实例真实登记的原件重走既有 policy_prepare；成功后仍需再核世界/引擎/关节/字节。
   if(body.status!==true){out.category='weights_need_adapter';out.applyEligible=false;out.recovery='prepare_on_instance';add('ROBOT_PHYSICS_MODEL_MISMATCH','adapter.modelSourcePath','The cached adapter cannot be tied to the current registered original by its bytes or recorded source hash; prepare again on this instance from the selected body instead of borrowing the old adapter','prepare');out.nextActions=[{kind:'prepare',label:'Prepare for this instance: rebuild the adapter from the selected body’s registered original; Apply still checks world/engine/joints/bytes, and walking is not executed'}];return out}
   out.category='direct_execution';out.applyEligible=true
   out.nextActions=[{kind:'match',label:out.world?.status==='paused'?'Ready to apply to this instance: Apply first checks the body and engine, then stops and rebuilds the paused world with the policy fixed step; walking is not executed':'Ready to apply to this instance: Apply first checks the body and engine, then stops and rebuilds the selected world with the policy fixed step; walking is not executed'}]
   return out
  }
  out.applyEligible=true
 }else add('WORLD_BINDING_UNCHECKED','worldId','Bind the actual session world and generation before policy_match','match')
 out.ready=out.missing.length===0;out.category=out.ready?'direct_execution':'missing_files_or_runtime';out.nextActions=[{kind:out.ready?'match':'install_runtime',label:out.ready?'Run the matched policy locally and read real motion/contact/Stop receipts':'Resolve the listed missing items together; do not report execution success'}];return out
}
