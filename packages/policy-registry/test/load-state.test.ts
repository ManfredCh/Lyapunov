import {test,expect} from 'bun:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {policyLoadState} from '../src/load-state.ts'
const runtimeModules=new Set(['mujoco','numpy','torch','yaml'])
test('native无需policy，但没有真实world/控制映射不能ready',async()=>{
 const s=await policyLoadState({dataDirectory:'/not-used',pythonPath:'/not-used'},{nativeControl:true},{runtimeModules})
 expect(s.category).toBe('direct_execution');expect(s.executionKind).toBe('native_control');expect(s.policyPrepared).toBe(false);expect(s.ready).toBe(false);expect(s.missing[0]!.code).toBe('WORLD_BINDING_UNCHECKED')
})
test('明确本地权重存在但无来源映射：待适配，不假执行',async()=>{
 const root=await mkdtemp(join(tmpdir(),'load-state-'));try{const path=join(root,'own.safetensors');const header=Buffer.from(JSON.stringify({value:{dtype:'F32',shape:[1],data_offsets:[0,4]}})),size=Buffer.alloc(8);size.writeBigUInt64LE(BigInt(header.length));await writeFile(path,Buffer.concat([size,header,Buffer.alloc(4)]))
  const s=await policyLoadState({dataDirectory:root,pythonPath:'/not-used'},{filePath:path},{runtimeModules})
  expect(s.category).toBe('weights_need_adapter');expect(s.ready).toBe(false);expect(s.missing[0]!.code).toBe('POLICY_ADAPTER_REQUIRED')
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
