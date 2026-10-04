/** 机器人侧栏使用的策略/VLA加载状态；只读，绝不因缺参启动下载或伪造观测。 */
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {verifyPolicy,readAdapter,isPreparedAdapter,isLiberoVlaAdapter,type PolicyIdentity} from './adapter.ts'
import {matchPolicy,resolvePolicyWorldBinding,type PolicyMatchInput} from './match.ts'
import {robotDownloadPreflight,type RobotDownloadManifest} from './robot-download.ts'
import type {SimWorlds} from '../../sim-contract/src/index.ts'
import type {SceneSnapshot,WorldHandle} from '../../lyapunov-contracts/src/types.ts'
import {inspectLocalPolicyFile} from './local-policy-file.ts'
import {IMPLEMENTED_POLICY_ADAPTERS} from './pack-contract.ts'
import {verifyRegisteredPolicyFiles,type LocalPolicySource} from './local-policy-source.ts'
import {selectPolicyRuntime,type PolicyRuntimeConfig,type PolicyRuntimeResolution} from './runtime.ts'
export interface PolicyLoadState {
 category:'direct_execution'|'weights_need_adapter'|'missing_files_or_runtime'|'model_incompatible'
 executionKind:'native_control'|'local_torch'|'local_onnx'|'unsupported_vla'
 ready:boolean;runtimeChecked:boolean;modelId?:string
 dimensions:{observation?:number;action?:number;currentJointCount?:number;requiredJointCount?:number}
 missing:Array<{code:string;field:string;detail:string;nextAction:string}>
 nextActions:Array<{kind:'native_controls'|'local_load'|'prepare'|'match'|'install_runtime'|'web_fetch';label:string;input?:unknown}>
 worldBound:boolean;policyPrepared:boolean;robotWalkingVerified:false
 localSource?:LocalPolicySource
 runtime?:PolicyRuntimeResolution
 world?:Pick<WorldHandle,'worldId'|'sceneId'|'worldGeneration'|'appliedSceneRevision'|'engineId'|'status'>
 evidence?:{robotPresent:boolean;weightsPresent:boolean;weightsVerified:boolean;completeBundleVerified:boolean;adapterImplemented:boolean;filesVerified:boolean;cachePrepared:boolean;preparedOnInstance:boolean;runtimeReady:boolean;worldMatched:boolean;worldRunning:boolean;behaviorVerified:false}
}
export async function probePolicyRuntime(python:string):Promise<ReadonlySet<string>> {
 const script="import importlib,json;out=[]\nfor name in ['mujoco','numpy','torch','yaml','onnxruntime','transformers','PIL','safetensors']:\n try: importlib.import_module(name);out.append(name)\n except Exception: pass\nprint(json.dumps(out))"
 const {stdout}=await promisify(execFile)(python,['-c',script],{timeout:8000,maxBuffer:4096,env:{...process.env,CUDA_VISIBLE_DEVICES:'',HF_ENDPOINT:'https://hf-mirror.com'}})
 return new Set(JSON.parse(stdout))
}
export async function policyLoadState(config:{dataDirectory:string}&PolicyRuntimeConfig,input:{identity?:PolicyIdentity;filePath?:string;manifest?:RobotDownloadManifest;nativeControl?:boolean;kind?:'policy'|'vla';currentJointNames?:string[];binding?:PolicyMatchInput;localSource?:LocalPolicySource},ports:{runtimeModules?:ReadonlySet<string>;scene?:{inspect(id:string):Promise<SceneSnapshot>|SceneSnapshot};sim?:Pick<SimWorlds,'describe'|'observe'|'listWorlds'>}={}):Promise<PolicyLoadState> {
 const out:PolicyLoadState={category:'missing_files_or_runtime',executionKind:'unsupported_vla',ready:false,runtimeChecked:false,dimensions:input.currentJointNames?{currentJointCount:input.currentJointNames.length}:{},missing:[],nextActions:[],worldBound:false,policyPrepared:false,robotWalkingVerified:false}
 if(input.localSource)out.localSource=input.localSource
 const add=(code:string,field:string,detail:string,nextAction:string)=>{if(!out.missing.some(m=>m.code===code&&m.field===field))out.missing.push({code,field,detail,nextAction})}
 const selectedIdentity=input.identity??(input.manifest?{provider:input.manifest.source.provider,modelId:input.manifest.source.modelId,revision:input.manifest.source.resolvedRevision}:undefined)
 const implemented=selectedIdentity?.provider==='github'&&IMPLEMENTED_POLICY_ADAPTERS.some(a=>a.modelId===selectedIdentity.modelId&&a.revision===selectedIdentity.revision)
 const evidence:NonNullable<PolicyLoadState['evidence']>={robotPresent:false,weightsPresent:false,weightsVerified:false,completeBundleVerified:false,adapterImplemented:implemented,filesVerified:false,cachePrepared:false,preparedOnInstance:false,runtimeReady:false,worldMatched:false,worldRunning:false,behaviorVerified:false};out.evidence=evidence
 // 库/缓存状态与所选 Scene 实例分开；只从本会话 Scene 与原生句柄读事实，不改物理 owner。
 if(input.binding){
  let snapshot:SceneSnapshot|undefined
  try{snapshot=await ports.scene?.inspect(input.binding.sceneId)}catch{}
  const entity=snapshot?.entities.find(e=>e.entityId===input.binding!.entityId)
  evidence.robotPresent=Boolean(entity)
  if(!snapshot)add('SCENE_BINDING_UNCHECKED','sceneId','当前会话 Scene 尚未读回；不能用库本体代替当前实例','match')
  else if(!entity)add('POLICY_ENTITY_NOT_FOUND','entityId','所选机器人实例不属于当前 Scene','match')
  const bound=await resolvePolicyWorldBinding(input.binding,ports.sim)
  input={...input,binding:bound}
  let world:WorldHandle|undefined
  try{world=(await ports.sim?.listWorlds())?.find(w=>w.worldId===bound.worldId)}catch{}
  if(world){
   out.world={worldId:world.worldId,sceneId:world.sceneId,worldGeneration:world.worldGeneration,appliedSceneRevision:world.appliedSceneRevision,engineId:world.engineId,status:world.status}
   if(world.sceneId!==bound.sceneId)add('WORLD_SCENE_MISMATCH','world.sceneId','所选世界属于另一 Scene，不能借用','match')
   if(bound.expectedGeneration===undefined)add('POLICY_EXPECTED_GENERATION_REQUIRED','expectedGeneration','显式选择世界必须提供当前代次','match')
   else if(world.worldGeneration!==bound.expectedGeneration)add('WORLD_GENERATION_MISMATCH','expectedGeneration','世界代次已变化，请重新读取当前世界','match')
   if(snapshot&&world.appliedSceneRevision!==snapshot.revision)add('SCENE_REVISION_MISMATCH','world.appliedSceneRevision','所选世界尚未同步当前 Scene 版本','match')
   out.worldBound=Boolean(entity)&&!out.missing.length
   evidence.worldRunning=out.worldBound&&world.status==='running'
   if(!['ready','running'].includes(world.status))add('WORLD_NOT_EXECUTABLE','world.status',`世界当前状态为 ${world.status}；重新准备或恢复世界后再执行`,'match')
  }else add('WORLD_REQUIRED','worldId','请选择本会话同 Scene 的真实世界；缺世界不重新下载机器人','match')
 }
 if(input.filePath){const fact=await inspectLocalPolicyFile(input.filePath)
  if(!fact.valid){add(fact.code!,'filePath',fact.detail!,'local_load');return out}
  evidence.weightsPresent=true
  if(!input.identity&&!input.manifest){out.category='weights_need_adapter';add('POLICY_ADAPTER_REQUIRED','adapter',input.kind==='vla'?'VLA文件格式头存在，仍缺已登记的图像/状态观测、动作与本体映射；不执行未知权重':'文件格式头存在，仍缺已登记来源、观测与动作映射；维度/图未验证，不执行未知权重','prepare');add('POLICY_SOURCE_UNVERIFIED','source','请提供固定来源与正规 bundle.json；文件名不能证明模型身份','local_load');add('POLICY_OBSERVATION_MAPPING_REQUIRED','observations','缺观测维度、顺序、单位与当前本体状态映射','prepare');add('POLICY_ACTION_MAPPING_REQUIRED','actions','缺动作维度、顺序、单位与关节控制映射','prepare');out.nextActions=[{kind:'local_load',label:'选择含固定来源及观测/动作接口的 bundle.json；登记的未知权重不会自动应用'}];return out}
 }
 if(!input.nativeControl&&!input.identity&&!input.manifest){add('POLICY_SOURCE_MISSING','source','尚未选择本地文件或固定来源bundle','local_load');return out}
 let runtime:ReadonlySet<string>|undefined=ports.runtimeModules
 if(!runtime&&!input.nativeControl){const pin=IMPLEMENTED_POLICY_ADAPTERS.find(a=>selectedIdentity?.provider==='github'&&a.modelId===selectedIdentity.modelId&&a.revision===selectedIdentity.revision);out.runtime=await selectPolicyRuntime(config,pin?.id);runtime=out.runtime.status==='AVAILABLE'?new Set(out.runtime.modules):new Set<string>()}
 out.runtimeChecked=runtime!==undefined
 if(!runtime&&!input.nativeControl)add('RUNTIME_PROBE_UNAVAILABLE','python','指定策略Python不可用或模块预检未完成；请选择包含所需依赖的本地解释器，不继续搜索本体','install_runtime')
 if(out.runtime?.status==='BLOCKED'){add('POLICY_RUNTIME_UNAVAILABLE','python',out.runtime.checked.map(c=>`${c.provider}：${c.missingModules.join('/')} ${c.error??''}`).join('；'),'install_runtime');out.nextActions.push({kind:'install_runtime',label:out.runtime.prepare!.command+'；'+out.runtime.prepare!.detail})}
 if(input.nativeControl){
  out.category='direct_execution';out.executionKind='native_control'
  // 原生控制运行时由已打开真实world证明；不因policy解释器缺Torch阻断机械臂关节。
  if(input.binding&&ports.sim){const bound=input.binding;if(bound.worldId&&out.worldBound){try{const d=await ports.sim.describe(bound.worldId,bound.entityId);out.dimensions.currentJointCount=d.joints.length;out.dimensions.requiredJointCount=d.controlledJointNames.length;if(d.expectedGeneration!==out.world?.worldGeneration)add('WORLD_GENERATION_MISMATCH','description.expectedGeneration','原生控制映射不属于当前世界代次','native_controls');if(!d.controlledJointNames.length)add('NATIVE_CONTROL_UNAVAILABLE','controller','未读到可用的原生关节控制映射','native_controls');const frame=await ports.sim.observe(bound.worldId,{entityIds:[bound.entityId]});if(frame.generation!==out.world?.worldGeneration||frame.sceneRevision!==out.world.appliedSceneRevision||!frame.entities.some(e=>e.entityId===bound.entityId))add('NATIVE_OBSERVATION_MISMATCH','frame','原生关节观测与当前实例/世界版本不一致','native_controls')}catch{add('ROBOT_DESCRIPTION_UNAVAILABLE','controller','真实provider未返回目标机器人控制映射或观测','native_controls')}}}
  else add('WORLD_BINDING_UNCHECKED','worldId','尚未读到真实世界绑定；不要为了关节控制下载policy','native_controls')
  out.runtimeChecked=out.worldBound;out.ready=out.missing.length===0;evidence.runtimeReady=out.ready;evidence.worldMatched=out.ready;out.nextActions=[{kind:'native_controls',label:'使用机器人原生关节/夹爪控制；无需训练policy，腿式行走另需匹配策略'}];return out
 }
 if(!input.binding)add('POLICY_ROBOT_SELECTION_REQUIRED','entityId','策略已登记；选择当前场景的真实机器人后核对本体、观测/动作与世界兼容性','match')
 if(input.manifest){const p=robotDownloadPreflight(input.manifest,{runtimeModules:runtime,currentJointNames:input.currentJointNames});out.modelId=p.modelId;if(input.manifest.adapter){out.dimensions.requiredJointCount=input.manifest.adapter.controlledJointCount;out.dimensions.action=input.manifest.adapter.actionDim??input.manifest.adapter.controlledJointCount;out.dimensions.observation=input.manifest.adapter.observationDim}
  for(const path of p.missingFiles)add('POLICY_DEPENDENCY_MISSING',path,'完整清单缺文件，不能逐件试错当成准备成功','web_fetch')
  for(const name of p.missingRuntime)add('RUNTIME_MISSING',name,'本地运行依赖未满足，不继续搜索机器人','install_runtime')
  if(p.modelMismatch){out.category='model_incompatible';add('ROBOT_MODEL_MISMATCH','jointNames','当前本体与策略受控关节不一致，不自动替换模型','local_load');return out}
  if(p.unknownAdapter||p.wrongSource){out.category='weights_need_adapter';add('POLICY_ADAPTER_REQUIRED','adapter','已有权重清单的来源/适配器未登记','prepare');return out}
 }
 const identity=input.identity??(input.manifest?{provider:input.manifest.source.provider,modelId:input.manifest.source.modelId,revision:input.manifest.source.resolvedRevision}:undefined)
 if(!identity){add('POLICY_SOURCE_MISSING','source','尚未选择本地路径或固定来源bundle','local_load');return out}
 if(input.manifest&&(identity.provider!==input.manifest.source.provider||identity.modelId!==input.manifest.source.modelId||identity.revision!==input.manifest.source.resolvedRevision)){out.category='model_incompatible';add('POLICY_SOURCE_MISMATCH','identity','选定身份与 bundle 的固定来源不同，不能借用另一份权重','local_load');return out}
 out.modelId=identity.modelId
 const registered=identity.provider==='github'?IMPLEMENTED_POLICY_ADAPTERS.find(a=>a.modelId===identity.modelId&&a.revision===identity.revision):undefined
 if(registered){out.executionKind=registered.adapter==='onnx'?'local_onnx':'local_torch';for(const name of registered.requires.runtimeModules??['mujoco','numpy',out.executionKind==='local_onnx'?'onnxruntime':'torch','yaml'])if(!runtime?.has(name)&&!out.missing.some(m=>m.field===name))add('RUNTIME_MISSING',name,'已登记来源所需本地运行依赖缺失；不要继续检索本体','install_runtime')}
 evidence.runtimeReady=out.runtimeChecked&&out.runtime?.status!=='BLOCKED'&&!out.missing.some(m=>m.code.startsWith('RUNTIME_')||m.code==='POLICY_RUNTIME_UNAVAILABLE')
 const verified=await verifyPolicy(config.dataDirectory,identity)
 const sourceChecks=await verifyRegisteredPolicyFiles(verified.root,verified.manifest?{provider:verified.manifest.provider,modelId:verified.manifest.modelId,revision:verified.manifest.resolvedRevision}:identity)
 for(const check of sourceChecks)if(!check.valid)add('POLICY_ADAPTER_SOURCE_MISMATCH',check.path,'已登记固定来源的必需文件字节缺失或不符；不能从自带哈希推断来源真实','local_load')
 evidence.filesVerified=verified.valid
 const weightFiles=verified.checks.filter(c=>typeof c.path==='string'&&/\.(?:pt|pth|jit|onnx|safetensors)$/i.test(c.path))
 evidence.weightsPresent=evidence.weightsPresent||weightFiles.some(c=>c.valid===true)
 evidence.weightsVerified=weightFiles.length>0&&weightFiles.every(c=>c.valid===true)&&verified.valid&&sourceChecks.every(c=>c.valid)
 const bundle=verified.manifest?.metadata?.downloadBundle
 evidence.completeBundleVerified=verified.valid&&sourceChecks.length>0&&sourceChecks.every(c=>c.valid)&&Boolean(bundle&&bundle.fileCount===verified.checks.length&&bundle.totalBytes===verified.manifest!.files.reduce((n,f)=>n+f.bytes,0))
 if(registered)for(const path of registered.requires.files)if(!verified.manifest?.files?.some(f=>f.path===path))add('POLICY_DEPENDENCY_MISSING',path,'已登记策略的必需源件缺失；一次补齐，不能用其他文件替代','local_load')
 for(const check of verified.checks)if(check.valid!==true)add('POLICY_FILE_NOT_VERIFIED',String(check.path),'固定来源文件缺失、字节或校验身份不符','local_load')
 if(!verified.valid){if(input.filePath)out.category='weights_need_adapter';add('POLICY_FILES_NOT_VERIFIED','manifest',input.filePath?'选定本地文件存在，但未按固定来源/完整依赖安装和验证；不能把它当作已登记可执行策略':'没有已验本地权重/完整依赖；文件清单存在不等于policy已安装','local_load');out.nextActions=[{kind:'local_load',label:'加载正规bundle或匹配已注册适配器；不重复搜索已经选定的文件'}];return out}
 const adapter=await readAdapter(verified.root)
 if(!isPreparedAdapter(adapter)&&!isLiberoVlaAdapter(adapter)){out.category='weights_need_adapter';add('POLICY_ADAPTER_UNAVAILABLE','adapter','字节已校验，尚缺当前模型的观测/控制映射','prepare');out.nextActions=[{kind:'prepare',label:'生成已注册来源适配器；不混用12/23或其他机器人'}];return out}
 out.policyPrepared=true
 evidence.cachePrepared=true
 if(input.kind==='vla'&&!isLiberoVlaAdapter(adapter)){out.category='weights_need_adapter';out.executionKind='unsupported_vla';add('VLA_ADAPTER_REQUIRED','adapter','选定文件是普通控制策略，不能冒充VLA图像/状态到动作适配','prepare');return out}
 if(isLiberoVlaAdapter(adapter)){out.executionKind='unsupported_vla';out.dimensions.action=adapter.actionDim;for(const name of ['torch','transformers','PIL','safetensors'])if(!runtime?.has(name))add('RUNTIME_MISSING',name,'VLA本地推理依赖缺失','install_runtime');add('VLA_ROBOT_BINDING_UNSUPPORTED','observations/control','已登记LIBERO基准路线不能直接驱动当前机器人；缺匹配的图像/状态观测与动作控制适配','prepare');out.category='weights_need_adapter';return out}
 if(isPreparedAdapter(adapter)){out.executionKind=adapter.inferenceFormat==='onnx'?'local_onnx':'local_torch';out.dimensions.observation=adapter.config.num_obs;out.dimensions.action=adapter.config.num_actions;out.dimensions.requiredJointCount=adapter.jointNames.length
  for(const name of ['mujoco','numpy',out.executionKind==='local_onnx'?'onnxruntime':'torch'])if(!runtime?.has(name))add('RUNTIME_MISSING',name,'已准备策略所需本地运行依赖缺失','install_runtime')
  if(input.currentJointNames&&(input.currentJointNames.length!==adapter.jointNames.length||adapter.jointNames.some(n=>!input.currentJointNames!.includes(n)))){out.category='model_incompatible';add('ROBOT_MODEL_MISMATCH','jointNames','当前本体与已准备策略关节集合不同','local_load');return out}
 }
 evidence.runtimeReady=out.runtimeChecked&&out.runtime?.status!=='BLOCKED'&&!out.missing.some(m=>m.code.startsWith('RUNTIME_')||m.code==='POLICY_RUNTIME_UNAVAILABLE')
 if(input.binding&&ports.scene&&ports.sim){const bound=await resolvePolicyWorldBinding({...input.binding,...identity},ports.sim);const matched=await matchPolicy(config,bound,ports.scene,ports.sim)
  evidence.worldMatched=matched.status==='MATCHED';evidence.preparedOnInstance=matched.status==='MATCHED'
  if(matched.status!=='MATCHED'){for(const d of matched.differences)add(d.reason,d.path,'实际world/观测/控制映射尚未通过；按字段修复而非下载循环','match');out.category=matched.differences.some(d=>/MODEL|JOINT|SIMULATOR/.test(d.reason))?'model_incompatible':'missing_files_or_runtime';return out}
 }else add('WORLD_BINDING_UNCHECKED','worldId','需绑定实际本会话world与代次，再做policy_match','match')
 out.ready=out.missing.length===0;out.category=out.ready?'direct_execution':'missing_files_or_runtime';out.nextActions=[{kind:out.ready?'match':'install_runtime',label:out.ready?'本地执行已匹配策略，并读取真实运动/接触/Stop回执':'一次处理列出的缺项；不得报告执行成功'}];return out
}
