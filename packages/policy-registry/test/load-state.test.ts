import {test,expect} from 'bun:test'
import {createHash} from 'node:crypto'
import {mkdir,mkdtemp,writeFile,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {policyLoadState} from '../src/load-state.ts'
import {consumePreparedAdapter} from '../src/adapter.ts'
const runtimeModules=new Set(['mujoco','numpy','torch','yaml'])
test('native无需policy，但没有真实world/控制映射不能ready',async()=>{
 const s=await policyLoadState({dataDirectory:'/not-used',pythonPath:'/not-used'},{nativeControl:true},{runtimeModules})
 expect(s.category).toBe('direct_execution');expect(s.executionKind).toBe('native_control');expect(s.policyPrepared).toBe(false);expect(s.ready).toBe(false);expect(s.missing[0]!.code).toBe('WORLD_BINDING_UNCHECKED')
})
test('明确本地权重存在但无来源映射：待适配，不假执行',async()=>{
 const root=await mkdtemp(join(tmpdir(),'load-state-'));try{const path=join(root,'own.safetensors');const header=Buffer.from(JSON.stringify({value:{dtype:'F32',shape:[1],data_offsets:[0,4]}})),size=Buffer.alloc(8);size.writeBigUInt64LE(BigInt(header.length));await writeFile(path,Buffer.concat([size,header,Buffer.alloc(4)]))
  const s=await policyLoadState({dataDirectory:root,pythonPath:'/not-used'},{filePath:path},{runtimeModules})
  expect(s.category).toBe('weights_need_adapter');expect(s.ready).toBe(false);expect(s.missing[0]!.code).toBe('POLICY_ADAPTER_REQUIRED')
  expect(s.missing.map(item=>item.field)).toEqual(['adapter','source','observations','actions']);expect(s.policyPrepared).toBe(false)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('缺文件一次反馈，状态检查不下载或清空用户目录',async()=>{
 const root=await mkdtemp(join(tmpdir(),'load-state-missing-'));try{
  const s=await policyLoadState({dataDirectory:root,pythonPath:'/not-used'},{filePath:join(root,'absent.pt')},{runtimeModules})
  expect(s.category).toBe('missing_files_or_runtime');expect(s.ready).toBe(false);expect(s.missing[0]).toMatchObject({code:'POLICY_FILE_MISSING',field:'filePath',nextAction:'local_load'});expect(s.robotWalkingVerified).toBe(false)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('已实现75适配与未下载/未准备/未匹配分别返回，不要求加入Host源码',async()=>{
 const root=await mkdtemp(join(tmpdir(),'load-state-implemented-'));try{
 const identity={provider:'github' as const,modelId:'jloganolson/g1_23dof_locomotion_isaac',revision:'fbfa38706b817e2d4b19e444db95ae7fb2537b46'}
 const s=await policyLoadState({dataDirectory:root,pythonPath:'/not-used'},{identity},{runtimeModules})
 expect(s.evidence?.adapterImplemented).toBe(true);expect(s.evidence?.filesVerified).toBe(false);expect(s.evidence?.cachePrepared).toBe(false);expect(s.evidence?.worldMatched).toBe(false);expect(s.evidence?.behaviorVerified).toBe(false);expect(s.ready).toBe(false)
 }finally{await rm(root,{recursive:true,force:true})}
})
const nativeBinding={provider:'github' as const,modelId:'native/control',sceneId:'s',entityId:'r',worldId:'w',expectedGeneration:3}
const nativePorts=(overrides:Record<string,unknown>={})=>({
 scene:{inspect:()=>({sceneId:'s',revision:7,entities:[{entityId:'r'}]}) as never},
 sim:{listWorlds:async()=>[{worldId:'w',sceneId:'s',worldGeneration:3,appliedSceneRevision:7,status:'running',engineId:'mujoco',...overrides}] as never,
 describe:async()=>({expectedGeneration:3,joints:[{name:'j'}],controlledJointNames:['j']}) as never,
 observe:async()=>({generation:3,sceneRevision:7,entities:[{entityId:'r'}]}) as never}
})
test('当前场景原生关节可执行无需policy，世界运行与本体/权重事实分别读回',async()=>{
 const s=await policyLoadState({dataDirectory:'/not-used',pythonPath:'/not-used'},{nativeControl:true,binding:nativeBinding},nativePorts())
 expect(s.ready).toBe(true);expect(s.world).toMatchObject({status:'running',worldGeneration:3,appliedSceneRevision:7})
 expect(s.evidence).toMatchObject({robotPresent:true,weightsPresent:false,weightsVerified:false,completeBundleVerified:false,adapterImplemented:false,cachePrepared:false,worldMatched:true,worldRunning:true,behaviorVerified:false})
})
test('manual ready可接受新动作但不是正在运行；Stop暂停保持明确阻断',async()=>{
 const ready=await policyLoadState({dataDirectory:'/not-used',pythonPath:'/not-used'},{nativeControl:true,binding:nativeBinding},nativePorts({status:'ready'}))
 expect(ready.ready).toBe(true);expect(ready.evidence?.worldRunning).toBe(false)
 const paused=await policyLoadState({dataDirectory:'/not-used',pythonPath:'/not-used'},{nativeControl:true,binding:nativeBinding},nativePorts({status:'paused'}))
 expect(paused.ready).toBe(false);expect(paused.evidence?.worldRunning).toBe(false);expect(paused.missing.map(m=>m.code)).toContain('WORLD_NOT_EXECUTABLE')
})
test('存在真实句柄也不能借用其他Scene、旧代次或未同步版本',async()=>{
 for(const [overrides,code] of [[{sceneId:'other'},'WORLD_SCENE_MISMATCH'],[{worldGeneration:4},'WORLD_GENERATION_MISMATCH'],[{appliedSceneRevision:6},'SCENE_REVISION_MISMATCH']] as const){
  const s=await policyLoadState({dataDirectory:'/not-used',pythonPath:'/not-used'},{nativeControl:true,binding:nativeBinding},nativePorts(overrides))
  expect(s.ready).toBe(false);expect(s.worldBound).toBe(false);expect(s.evidence?.worldRunning).toBe(false);expect(s.missing.map(m=>m.code)).toContain(code)
 }
})
test('关节观测必须与实例和当前原生代次一致，不能仅凭describe宣称ready',async()=>{
 const ports=nativePorts();ports.sim.observe=async()=>({generation:2,sceneRevision:7,entities:[{entityId:'r'}]}) as never
 const s=await policyLoadState({dataDirectory:'/not-used',pythonPath:'/not-used'},{nativeControl:true,binding:nativeBinding},ports)
 expect(s.ready).toBe(false);expect(s.missing.map(m=>m.code)).toContain('NATIVE_OBSERVATION_MISMATCH')
})
test('同名模型不同provider不能借用已实现适配器',async()=>{
 const root=await mkdtemp(join(tmpdir(),'load-state-provider-'));try{
  const s=await policyLoadState({dataDirectory:root,pythonPath:'/not-used'},{identity:{provider:'modelscope',modelId:'jloganolson/g1_23dof_locomotion_isaac',revision:'fbfa38706b817e2d4b19e444db95ae7fb2537b46'}},{runtimeModules})
  expect(s.evidence?.adapterImplemented).toBe(false);expect(s.evidence?.weightsVerified).toBe(false);expect(s.ready).toBe(false)
 }finally{await rm(root,{recursive:true,force:true})}
})

// ------------------------------------------------------------------ R-004 ------------------------------------------------------------------
/** R-004 根因回归：真实完整策略准备后，当前 Scene/World 尚未被 Apply 重建，必然与 prepared 适配器在
 *  controller.robot / frequencyHz / controlMode / gravityCompensation / world.clock / timestepS /
 *  observations.schema / model.sha256 上不同。旧实现把这些“应用后必须匹配”当成“应用前资格”，
 *  把 Apply 永久禁用。这里用一份合成的已准备 PreparedAdapter 缓存（不是假权重：manifest 逐字节自校验）
 *  复现审计十项差异，锁住“可应用资格 ≠ 已应用匹配”，并保留真不兼容的负例。 */
const R004_IDENTITY={provider:'github' as const,modelId:'synthetic/wtw-apply-test',revision:'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'}
const R004_JOINTS=['FL_hip_joint','FL_thigh_joint','FL_calf_joint','FR_hip_joint','FR_thigh_joint','FR_calf_joint','RL_hip_joint','RL_thigh_joint','RL_calf_joint','RR_hip_joint','RR_thigh_joint','RR_calf_joint']
const sha256hex=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex')
async function buildPreparedPolicyCache(root:string){
 const dir=join(root,'policies','github',R004_IDENTITY.modelId.replace('/','__'),R004_IDENTITY.revision)
 await mkdir(join(dir,'derived'),{recursive:true});await mkdir(join(dir,'model'),{recursive:true})
 const modelBytes='<mujoco model="synthetic-go1-apply"/>',weightsBytes='synthetic-torchscript-body-bytes'
 const modelPath=join(dir,'model/go1.xml'),weightsPath=join(dir,'model/body_latest.jit')
 await writeFile(modelPath,modelBytes);await writeFile(weightsPath,weightsBytes)
 const adapter={adapter:'synthetic-wtw-apply-v1',robot:'unitree_go1_synthetic',engine:'mujoco',modelPath,modelSourcePath:modelPath,weightsPath,
  config:{simulation_dt:0.005,control_decimation:4,num_obs:70,num_actions:12,default_angles:Array(12).fill(0)},
  jointNames:R004_JOINTS,unit:'rad',controlMode:'position',frequencyHz:50,
  observations:{type:'joint-state',shape:[70],order:['projectedGravity','command'],quaternion:'xyzw'},
  modelSha256:sha256hex('a-different-body-bytes'),sourceRevision:R004_IDENTITY.revision,sourceModelId:R004_IDENTITY.modelId,sourceProvider:'github',
  physicsPreserved:['gravity'],gravityCompensation:false,supportedEngines:['mujoco']}
 await writeFile(join(dir,'derived/adapter.json'),JSON.stringify(adapter))
 await writeFile(join(dir,'manifest.json'),JSON.stringify({status:'DOWNLOADED',provider:'github',modelId:R004_IDENTITY.modelId,revision:R004_IDENTITY.revision,resolvedRevision:R004_IDENTITY.revision,files:[{path:'model/go1.xml',bytes:Buffer.byteLength(modelBytes),sha256:sha256hex(modelBytes)},{path:'model/body_latest.jit',bytes:Buffer.byteLength(weightsBytes),sha256:sha256hex(weightsBytes)}]}))
 return {dir,modelPath}
}
function r004Ports(root:string,options:{joints?:string[];worldGeneration?:number;status?:string;entityModelPath?:string}={}){
 const joints=options.joints??R004_JOINTS,worldGeneration=options.worldGeneration??3
 const {modelPath}=(()=>{const dir=join(root,'policies','github',R004_IDENTITY.modelId.replace('/','__'),R004_IDENTITY.revision);return {modelPath:join(dir,'model/go1.xml')}})()
 const entity={entityId:'r',components:{controller:{robot:'currently-native',frequencyHz:30,controlMode:'torque'},sensor:{policyObservations:{stale:true}},mujoco:{sourcePath:options.entityModelPath??modelPath}}}
 return {scene:{inspect:()=>({sceneId:'s',revision:7,entities:[entity]}) as never},sim:{
  listWorlds:async()=>[{worldId:'w',sceneId:'s',worldGeneration,appliedSceneRevision:7,status:options.status??'running',engineId:'mujoco',clock:'realtime',timestepS:0.002}] as never,
  describe:async()=>({expectedGeneration:worldGeneration,joints:R004_JOINTS.map(name=>({name,unit:'rad',controlMode:'position'})),controlledJointNames:joints}) as never,
  observe:async()=>({generation:worldGeneration,sceneRevision:7,entities:[{entityId:'r',joints:{names:R004_JOINTS},sensors:{freeBase:{quaternionXyzw:[0,0,0,1],angularVelocityLocalRadps:[0,0,0]}}}]}) as never}}
}
const r004Binding={...R004_IDENTITY,sceneId:'s',entityId:'r',worldId:'w',expectedGeneration:3}
test('R-004 正例：完整策略已准备、当前世界尚未重建 ⇒ 授予可应用资格，但不宣称 ready/已匹配',async()=>{
 const root=await mkdtemp(join(tmpdir(),'load-state-r004-'));try{
  await buildPreparedPolicyCache(root)
  const s=await policyLoadState({dataDirectory:root,pythonPath:'/not-used'},{identity:R004_IDENTITY,binding:r004Binding},{...r004Ports(root),runtimeModules})
  expect(s.applyEligible).toBe(true)
  expect(s.ready).toBe(false)                 // 未应用：不得预先声称 ready
  expect(s.evidence?.worldMatched).toBe(false)
  expect(s.evidence?.preparedOnInstance).toBe(false)
  expect(s.missing).toEqual([])               // 十项“应用后会重建”的差异不算缺项
  expect(s.preApplyDifferences.map(d=>d.path).sort()).toEqual(['controller.controlMode','controller.frequencyHz','controller.gravityCompensation','controller.robot','controller.scene.controlMode','controller.scene.frequencyHz','model.sha256','observations.schema','world.clock','world.timestepS'])
  // R-010：可见诊断/下一步在英文界面不得混中文（机器码与字段名保留）。
  expect(JSON.stringify(s.preApplyDifferences)).not.toMatch(/[\u4e00-\u9fff]/)
  expect(JSON.stringify(s.nextActions)).not.toMatch(/[\u4e00-\u9fff]/)
  expect(s.robotWalkingVerified).toBe(false)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('R-004 负例：错误本体（受控关节集不符）仍阻断，不因放开可应用资格而放行',async()=>{
 const root=await mkdtemp(join(tmpdir(),'load-state-r004-body-'));try{
  await buildPreparedPolicyCache(root)
  const s=await policyLoadState({dataDirectory:root,pythonPath:'/not-used'},{identity:R004_IDENTITY,binding:r004Binding},{...r004Ports(root,{joints:['wrong_joint']}),runtimeModules})
  expect(s.applyEligible).toBe(false)
  expect(s.ready).toBe(false)
  expect(s.missing.map(m=>m.code)).toContain('ACTION_JOINT_SET_MISMATCH')
 }finally{await rm(root,{recursive:true,force:true})}
})
test('R-004 负例：陈旧世界代次仍阻断，不授予可应用资格',async()=>{
 const root=await mkdtemp(join(tmpdir(),'load-state-r004-gen-'));try{
  await buildPreparedPolicyCache(root)
  const s=await policyLoadState({dataDirectory:root,pythonPath:'/not-used'},{identity:R004_IDENTITY,binding:r004Binding},{...r004Ports(root,{worldGeneration:4}),runtimeModules})
  expect(s.applyEligible).toBe(false)
  expect(s.worldBound).toBe(false)
  expect(s.missing.map(m=>m.code)).toContain('WORLD_GENERATION_MISMATCH')
 }finally{await rm(root,{recursive:true,force:true})}
})
test('R-004 负例：损坏字节（缓存文件被改）仍阻断，不授予可应用资格',async()=>{
 const root=await mkdtemp(join(tmpdir(),'load-state-r004-corrupt-'));try{
  const {dir}=await buildPreparedPolicyCache(root)
  await writeFile(join(dir,'model/body_latest.jit'),'tampered-after-manifest')
  const s=await policyLoadState({dataDirectory:root,pythonPath:'/not-used'},{identity:R004_IDENTITY,binding:r004Binding},{...r004Ports(root),runtimeModules})
  expect(s.applyEligible).toBe(false)
  expect(s.ready).toBe(false)
  expect(s.missing.some(m=>m.code==='POLICY_FILE_NOT_VERIFIED'||m.code==='POLICY_FILES_NOT_VERIFIED')).toBe(true)
 }finally{await rm(root,{recursive:true,force:true})}
})

// ------------------------------------------------------------- P18 B1/B3 -------------------------------------------------------------
/** 已准备适配器的登记来源必须能对回当前实例的原件，或就是它自己的合法派生件；两者都不是＝借用别的本体。 */
async function setAdapterBodies(root:string,overrides:{modelPath?:string;modelSourcePath?:string;robot?:string;modelSha256?:string;modelSourceSha256?:string}){
 const dir=join(root,'policies','github',R004_IDENTITY.modelId.replace('/','__'),R004_IDENTITY.revision)
 const path=join(dir,'derived/adapter.json'),adapter=JSON.parse(await readFile(path,'utf8'))
 Object.assign(adapter,overrides)
 await writeFile(path,JSON.stringify(adapter))
}
test('B1 paused同一版本世界：准备/Apply资格仍在，执行运行态单独保持未就绪',async()=>{
 const root=await mkdtemp(join(tmpdir(),'load-state-paused-'));try{
  await buildPreparedPolicyCache(root)
  const s=await policyLoadState({dataDirectory:root,pythonPath:'/not-used'},{identity:R004_IDENTITY,binding:r004Binding},{...r004Ports(root,{status:'paused'}),runtimeModules})
  expect(s.applyEligible).toBe(true)                 // Apply 会重建同一 Scene 版本，不看运行态
  expect(s.ready).toBe(false)                        // 执行策略需要 running：不能先声称 ready
  expect(s.evidence?.worldRunning).toBe(false)
  expect(s.missing.map(m=>m.code)).toContain('WORLD_NOT_EXECUTABLE')
  expect(JSON.stringify(s.nextActions)).not.toMatch(/[\u4e00-\u9fff]/)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('B1 closed/failed世界不借Apply放行：不是所有WORLD错误都放宽',async()=>{
 for(const status of ['closed','failed']){
  const root=await mkdtemp(join(tmpdir(),'load-state-notpaused-'));try{
   await buildPreparedPolicyCache(root)
   const s=await policyLoadState({dataDirectory:root,pythonPath:'/not-used'},{identity:R004_IDENTITY,binding:r004Binding},{...r004Ports(root,{status}),runtimeModules})
   expect(s.applyEligible).toBe(false)
   expect(s.ready).toBe(false)
   expect(s.missing.map(m=>m.code)).toContain('WORLD_NOT_EXECUTABLE')
  }finally{await rm(root,{recursive:true,force:true})}
 }
})
test('B3 Go1→Go2 同12DOF同名关节：适配器指向别的登记原件时不得借Apply放行',async()=>{
 const root=await mkdtemp(join(tmpdir(),'load-state-go2-borrow-'));try{
  await buildPreparedPolicyCache(root)
  const dir=join(root,'policies','github',R004_IDENTITY.modelId.replace('/','__'),R004_IDENTITY.revision)
  const foreignOriginal=join(dir,'model/go2-original.xml'),foreignDerived=join(dir,'derived/go2-derived.xml')
  await writeFile(foreignOriginal,'<mujoco model="unitree-go2-original"/>');await writeFile(foreignDerived,'<mujoco model="unitree-go2-derived"/>')
  await setAdapterBodies(root,{modelPath:foreignDerived,modelSourcePath:foreignOriginal,robot:'unitree-go2'})
  const s=await policyLoadState({dataDirectory:root,pythonPath:'/not-used'},{identity:R004_IDENTITY,binding:r004Binding},{...r004Ports(root),runtimeModules})
  expect(s.applyEligible).toBe(false)
  expect(s.category).toBe('model_incompatible')
  expect(s.missing.map(m=>m.code)).toContain('ROBOT_PHYSICS_MODEL_MISMATCH')
 }finally{await rm(root,{recursive:true,force:true})}
})
test('B3 已应用派生件与其登记原件之间的合法Apply差异不被误判为借用别的本体',async()=>{
 const root=await mkdtemp(join(tmpdir(),'load-state-derived-'));try{
  await buildPreparedPolicyCache(root)
  const dir=join(root,'policies','github',R004_IDENTITY.modelId.replace('/','__'),R004_IDENTITY.revision)
  const original=join(dir,'model/go1-original.xml');await writeFile(original,'<mujoco model="unitree-go1-original"/>')
  // 世界里的 sourcePath 是 Apply 写回的派生件（= adapter.modelPath），原件另存：必须按派生件匹配放行。
  await setAdapterBodies(root,{modelSourcePath:original})
  const s=await policyLoadState({dataDirectory:root,pythonPath:'/not-used'},{identity:R004_IDENTITY,binding:r004Binding},{...r004Ports(root),runtimeModules})
  expect(s.applyEligible).toBe(true)
  expect(s.missing.map(m=>m.code)).not.toContain('ROBOT_PHYSICS_MODEL_MISMATCH')
 }finally{await rm(root,{recursive:true,force:true})}
})

// ------------------------------------------------ R-004 九：安装路径搬迁的身份核对 ------------------------------------------------
test('R-004九 正例：同一登记原件复制到新安装路径，按真实字节识别同源而不是绝对路径',async()=>{
 const root=await mkdtemp(join(tmpdir(),'load-state-moved-original-'));try{
  const {dir,modelPath}=await buildPreparedPolicyCache(root)
  const originalBytes=await readFile(modelPath)
  const oldSource=join(root,'old-install','go1.xml'),newSource=join(root,'new-install','go1.xml')
  await mkdir(join(root,'old-install'),{recursive:true});await mkdir(join(root,'new-install'),{recursive:true})
  await writeFile(oldSource,originalBytes);await writeFile(newSource,originalBytes)
  // 旧派生件与原件是不同字节；身份必须回到 modelSourcePath 的原件字节，不能拿派生件路径下结论。
  const oldDerived=join(dir,'derived/old-wtw-go1.xml'),derivedBytes='<mujoco model="wtw-derived-old-install"/>'
  await writeFile(oldDerived,derivedBytes)
  await setAdapterBodies(root,{modelPath:oldDerived,modelSourcePath:oldSource,modelSha256:sha256hex(derivedBytes),modelSourceSha256:undefined})
  const s=await policyLoadState({dataDirectory:root,pythonPath:'/not-used'},{identity:R004_IDENTITY,binding:r004Binding},{...r004Ports(root,{entityModelPath:newSource}),runtimeModules})
  expect(s.applyEligible).toBe(true)
  expect(s.evidence?.bodyIdentity).toBe('same-source-bytes')
  expect(s.missing.map(m=>m.code)).not.toContain('ROBOT_PHYSICS_MODEL_MISMATCH')
  expect(s.recovery).toBeUndefined()
 }finally{await rm(root,{recursive:true,force:true})}
})
test('R-004九 准备消费同时登记原件字节哈希，供搬迁后核对而不依赖绝对路径',async()=>{
 const root=await mkdtemp(join(tmpdir(),'load-state-source-metadata-'));try{
  const modelPath=join(root,'derived.xml'),sourcePath=join(root,'go1.xml'),weightsPath=join(root,'body_latest.jit')
  await writeFile(modelPath,'<mujoco model="derived"/>');await writeFile(sourcePath,'<mujoco model="go1-original"/>');await writeFile(weightsPath,'weights')
  const raw={adapter:'wtw-go1-torchscript-v1',robot:'unitree-go1-12dof',engine:'mujoco',modelPath,modelSourcePath:sourcePath,weightsPath,frequencyHz:50,
   config:{simulation_dt:0.005,control_decimation:4,num_obs:70,num_actions:12,default_angles:Array(12).fill(0)},jointNames:R004_JOINTS,unit:'rad',controlMode:'position',
   observations:{type:'STATE',shape:[70],order:['joints'],quaternion:'xyzw'},physicsPreserved:['gravity'],gravityCompensation:false}
  const adapter=await consumePreparedAdapter(JSON.stringify(raw),{resolvedRevision:'rev',modelId:'m',provider:'github'})
  expect(adapter.modelSha256).toBe(sha256hex('<mujoco model="derived"/>'))
  expect(adapter.modelSourceSha256).toBe(sha256hex('<mujoco model="go1-original"/>'))
 }finally{await rm(root,{recursive:true,force:true})}
})
test('R-004九 正例：旧安装路径已回收，准备时登记的原件哈希仍证明同一本体',async()=>{
 const root=await mkdtemp(join(tmpdir(),'load-state-recorded-source-'));try{
  const {modelPath}=await buildPreparedPolicyCache(root)
  const sourceSha=sha256hex(await readFile(modelPath))
  await setAdapterBodies(root,{modelPath:join(root,'gone','old-derived.xml'),modelSourcePath:join(root,'gone','go1.xml'),modelSha256:sha256hex('old-derived-bytes'),modelSourceSha256:sourceSha})
  const s=await policyLoadState({dataDirectory:root,pythonPath:'/not-used'},{identity:R004_IDENTITY,binding:r004Binding},{...r004Ports(root),runtimeModules})
  expect(s.applyEligible).toBe(true)
  expect(s.evidence?.bodyIdentity).toBe('same-source-bytes')
  expect(s.missing.map(m=>m.code)).not.toContain('ROBOT_PHYSICS_MODEL_MISMATCH')
 }finally{await rm(root,{recursive:true,force:true})}
})
test('R-004九 正例：合法派生件复制到新路径，按准备模型哈希识别而不是按文件名',async()=>{
 const root=await mkdtemp(join(tmpdir(),'load-state-moved-derived-'));try{
  await buildPreparedPolicyCache(root)
  const derivedBytes='<mujoco model="wtw-prepared-derived-copy"/>'
  const newDerived=join(root,'new-install','go1-position-pd.xml')
  await mkdir(join(root,'new-install'),{recursive:true});await writeFile(newDerived,derivedBytes)
  await setAdapterBodies(root,{modelPath:join(root,'gone','old-derived.xml'),modelSourcePath:join(root,'gone','go1.xml'),modelSha256:sha256hex(derivedBytes),modelSourceSha256:undefined})
  const s=await policyLoadState({dataDirectory:root,pythonPath:'/not-used'},{identity:R004_IDENTITY,binding:r004Binding},{...r004Ports(root,{entityModelPath:newDerived}),runtimeModules})
  expect(s.applyEligible).toBe(true)
  expect(s.evidence?.bodyIdentity).toBe('same-prepared-bytes')
  expect(s.missing.map(m=>m.code)).not.toContain('ROBOT_PHYSICS_MODEL_MISMATCH')
 }finally{await rm(root,{recursive:true,force:true})}
})
test('R-004九 负例：同12DOF/同关节名但旧原件字节不同，仍按不同本体阻断',async()=>{
 const root=await mkdtemp(join(tmpdir(),'load-state-different-bytes-'));try{
  const {dir}=await buildPreparedPolicyCache(root)
  const oldSource=join(root,'old-install','go1.xml'),foreignBytes='<mujoco model="unitree-go2-with-same-joint-names"/>'
  await mkdir(join(root,'old-install'),{recursive:true});await writeFile(oldSource,foreignBytes)
  const foreignDerived=join(dir,'derived/foreign-derived.xml');await writeFile(foreignDerived,'<mujoco model="foreign-derived"/>')
  await setAdapterBodies(root,{modelPath:foreignDerived,modelSourcePath:oldSource,modelSha256:sha256hex('<mujoco model="foreign-derived"/>'),modelSourceSha256:sha256hex(foreignBytes)})
  const s=await policyLoadState({dataDirectory:root,pythonPath:'/not-used'},{identity:R004_IDENTITY,binding:r004Binding},{...r004Ports(root),runtimeModules})
  expect(s.applyEligible).toBe(false)
  expect(s.category).toBe('model_incompatible')
  expect(s.recovery).toBeUndefined()
  expect(s.evidence?.bodyIdentity).toBe('different-bytes')
  expect(s.missing.map(m=>m.code)).toContain('ROBOT_PHYSICS_MODEL_MISMATCH')
 }finally{await rm(root,{recursive:true,force:true})}
})
test('R-004九 负例：旧路径缺失且无原件字节/哈希可证，拒绝借用但给出本实例重准备',async()=>{
 const root=await mkdtemp(join(tmpdir(),'load-state-unproven-body-'));try{
  await buildPreparedPolicyCache(root)
  await setAdapterBodies(root,{modelPath:join(root,'gone','derived.xml'),modelSourcePath:join(root,'gone','go1.xml'),modelSha256:sha256hex('some-other-prepared-model'),modelSourceSha256:undefined})
  const s=await policyLoadState({dataDirectory:root,pythonPath:'/not-used'},{identity:R004_IDENTITY,binding:r004Binding},{...r004Ports(root),runtimeModules})
  expect(s.applyEligible).toBe(false)
  expect(s.ready).toBe(false)
  expect(s.category).toBe('weights_need_adapter')
  expect(s.recovery).toBe('prepare_on_instance')
  expect(s.evidence?.bodyIdentity).toBe('unproven')
  expect(s.missing.map(m=>m.code)).toContain('ROBOT_PHYSICS_MODEL_MISMATCH')
  expect(s.nextActions.map(a=>a.kind)).toContain('prepare')
  expect(JSON.stringify(s.nextActions)).not.toMatch(/[\u4e00-\u9fff]/)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('R-004九 负例：路径缺失但登记哈希明确不符，仍是真不兼容而非可恢复',async()=>{
 const root=await mkdtemp(join(tmpdir(),'load-state-recorded-mismatch-'));try{
  await buildPreparedPolicyCache(root)
  await setAdapterBodies(root,{modelPath:join(root,'gone','derived.xml'),modelSourcePath:join(root,'gone','go1.xml'),modelSourceSha256:sha256hex('a-different-registered-body')})
  const s=await policyLoadState({dataDirectory:root,pythonPath:'/not-used'},{identity:R004_IDENTITY,binding:r004Binding},{...r004Ports(root),runtimeModules})
  expect(s.applyEligible).toBe(false)
  expect(s.category).toBe('model_incompatible')
  expect(s.recovery).toBeUndefined()
  expect(s.evidence?.bodyIdentity).toBe('different-bytes')
  expect(s.missing.map(m=>m.code)).toContain('ROBOT_PHYSICS_MODEL_MISMATCH')
 }finally{await rm(root,{recursive:true,force:true})}
})
