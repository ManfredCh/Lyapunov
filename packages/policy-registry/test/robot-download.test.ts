import {test,expect} from 'bun:test'
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {robotDownloadManifest,robotDownloadPreflight,installRobotDownload,registeredRobotDownloads,RobotDownloadFailure,type RobotDownloadManifest,type RobotDownloadFetcher} from '../src/robot-download.ts'
import {matchPolicy,resolvePolicyWorldBinding} from '../src/match.ts'
import {verifyPolicy} from '../src/adapter.ts'
import {policyLoadState} from '../src/load-state.ts'
const source={provider:'github' as const,modelId:'unitreerobotics/unitree_rl_gym',resolvedRevision:'276801e46c5d433564f24658bac64f254b7d2d4b'}
const required=['deploy/pre_train/g1/motion.pt','deploy/deploy_mujoco/configs/g1.yaml','deploy/deploy_mujoco/deploy_mujoco.py','resources/robots/g1_description/g1_12dof.xml','resources/robots/g1_description/meshes/pelvis.STL']
const make=(xml='<mujoco><asset><mesh file="pelvis.STL"/></asset></mujoco>')=>{
 const data=new Map(required.map(p=>[p,Buffer.from(p.endsWith('.xml')?xml:'offline-byte-fixture')]))
 const files=[...data].map(([path,b])=>({path,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex'),gitBlob:createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex')}))
 const m:RobotDownloadManifest={schema:'g1-policy-download/v1',packId:'unitree_g1_12dof_motion',version:source.resolvedRevision,downloadReady:true,serverSideInference:false,source,files,adapter:{id:'unitree-g1-12dof-v1',controlledJointCount:12,jointNames:Array.from({length:12},(_,i)=>'j'+i),registeredAdapterRequires:required,deploymentClosure:required},fallback:{action:'web_fetch',retryable:false,rawBase:'https://raw.githubusercontent.com/'+source.modelId+'/'+source.resolvedRevision+'/'}}
 return{m,data}
}
const assetProtocol=():RobotDownloadManifest=>{
 const repository=source.modelId,revision=source.resolvedRevision,path='resources/robots/g1_description/g1_23dof_rev_1_0.xml',sha256='8ca62fcccdca91a431ca04f1a42f9c2fda241fdd5e13411168dc82de00f978de'
 const jointNames=Array.from({length:23},(_,i)=>'j'+i)
 return {schema:'robot-download/v1',packId:'unitree_g1_23dof_75obs',version:'fixture-protocol-only',serverSideInference:false,downloadReady:false,source:{provider:'github',modelId:'jloganolson/g1_23dof_locomotion_isaac',resolvedRevision:'fbfa38706b817e2d4b19e444db95ae7fb2537b46'},missingLicense:['policy许可未核'],pieceReadiness:{asset:{downloadReady:true,missingFiles:[],missingLicense:[]},policy:{downloadReady:false,missingLicense:['policy许可未核']}},adapter:{id:'jlog-g1-23-75-torchscript-v1',controlledJointCount:23,jointNames,registeredAdapterRequires:['deployment/policy.pt'],deploymentClosure:['deployment/policy.pt']},assetModel:{entry:'robot/g1_23dof_rev_1_0.xml',sha256,controlledJointNames:jointNames,source:{repository,revision,path,url:`https://raw.githubusercontent.com/${repository}/${revision}/${path}`}},files:[{path:'robot/g1_23dof_rev_1_0.xml',bytes:12000,sha256,piece:'asset',sourceRepository:repository,sourceRevision:revision,sourcePath:path,url:`https://raw.githubusercontent.com/${repository}/${revision}/${path}`}, {path:'../policy-dependency-missing.pt',bytes:-1,sha256:'unknown',piece:'policy'}]}
}
test('本体独立许可可解析，策略缺件/许可false仍保持整包阻断，不虚装policy缓存',()=>{
 const m=assetProtocol(),asset=robotDownloadManifest(m,{assetOnly:true})
 expect(asset.files).toHaveLength(1);expect(asset.files[0]!.piece).toBe('asset');expect(asset.downloadReady).toBe(false);expect(asset.missingLicense).toEqual(['policy许可未核']);expect(m.files).toHaveLength(2)
 expect(()=>robotDownloadManifest(m)).toThrow('ROBOT_DOWNLOAD_NOT_READY')
 expect(()=>robotDownloadManifest({...m,pieceReadiness:{asset:{downloadReady:true,missingLicense:['本体许可未核']}}},{assetOnly:true})).toThrow('ROBOT_DOWNLOAD_NOT_READY')
 expect(()=>robotDownloadManifest({...m,pieceReadiness:undefined},{assetOnly:true})).toThrow('ROBOT_DOWNLOAD_NOT_READY')
})
test('asset-only不能把不同本体来源、入口SHA或12关节冒充登记23原件',()=>{
 const m=assetProtocol()
 for(const model of [{...m.assetModel!,sha256:'1'.repeat(64)},{...m.assetModel!,controlledJointNames:m.assetModel!.controlledJointNames.slice(0,12)},{...m.assetModel!,source:{...m.assetModel!.source,revision:'0'.repeat(40)}}])expect(()=>robotDownloadManifest({...m,assetModel:model},{assetOnly:true})).toThrow('ROBOT_DOWNLOAD_ASSET_MODEL_INVALID')
 const disguised={path:'deployment/policy.pt',piece:'asset',bytes:299424,sha256:'1'.repeat(64),sourceRepository:m.source.modelId,sourceRevision:m.source.resolvedRevision,sourcePath:'deployment/policy.pt'}
 expect(()=>robotDownloadManifest({...m,files:[m.files[0]!,disguised]},{assetOnly:true})).toThrow('ROBOT_DOWNLOAD_ASSET_FILE_INVALID')
})
test('asset-only请求只open asset；快照更换固定source在任何stream前拒绝',async()=>{
 const root=await mkdtemp(join(tmpdir(),'asset-source-refusal-')),m=assetProtocol(),calls:string[]=[]
 try{
  const fetcher:RobotDownloadFetcher=async(url,init)=>{calls.push(url);if(url.endsWith('/manifest'))return Response.json(m);expect(JSON.parse(String(init?.body)).pieces).toEqual(['asset']);return Response.json({mountId:'fixture',assetModel:m.assetModel,files:m.files.map(f=>({...f,sourceRevision:'0'.repeat(40)}))})}
  await expect(installRobotDownload({endpoint:'http://127.0.0.1/robot-downloads',modelId:m.packId,token:'fixture',pieces:['asset'],dataDirectory:root,signal:new AbortController().signal,fetcher})).rejects.toThrow('ROBOT_DOWNLOAD_OPEN_MISMATCH')
  expect(calls).toHaveLength(2);expect(calls.some(x=>x.includes('/stream'))).toBe(false)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('asset首鉴权错误给准确本体固定来源，不误导取未许可策略或默认12型号',async()=>{
 let requests=0
 try{await installRobotDownload({endpoint:'http://127.0.0.1/robot-downloads',modelId:'unitree_g1_23dof_75obs',pieces:['asset'],dataDirectory:'/unused',signal:new AbortController().signal,fetcher:async()=>{requests++;throw Error('未鉴权不可联网')}});throw Error('应拒绝')}catch(error){expect(error).toBeInstanceOf(RobotDownloadFailure);const e=error as RobotDownloadFailure;expect(e.code).toBe('ROBOT_DOWNLOAD_AUTH_REQUIRED');expect(e.fallback?.urls?.[0]!.url).toContain('/276801e46c5d433564f24658bac64f254b7d2d4b/resources/robots/g1_description/g1_23dof_rev_1_0.xml');expect(JSON.stringify(e.fallback)).not.toContain('deployment/policy.pt')}
 expect(requests).toBe(0)
})
test('G1一次反馈清单/运行时/23与12型号缺口，不借默认观测值放行',()=>{
 const{m}=make();m.files=m.files.slice(0,1)
 const p=robotDownloadPreflight(m,{runtimeModules:new Set(['mujoco','numpy']),currentJointNames:Array(23).fill('other')})
 expect(p.status).toBe('BLOCKED');expect(p.missingFiles.length).toBeGreaterThanOrEqual(4);expect(p.missingRuntime).toEqual(['torch','yaml']);expect(p.modelMismatch).toBe(true);expect(p.robotWalkingVerified).toBe(false)
})
test('服务端推理和未准备型号不进入下载执行',()=>{const{m}=make();expect(()=>robotDownloadManifest({...m,serverSideInference:true})).toThrow('LOCAL_INFERENCE_REQUIRED');expect(()=>robotDownloadManifest({...m,downloadReady:false})).toThrow('NOT_READY')})
test('同身份本地字节一次安装，第二次复用缓存0网络',async()=>{
 const root=await mkdtemp(join(tmpdir(),'robot-local-reuse-'));try{
  const{m,data}=make(),local=new Map<string,string>();for(const[path,b]of data){const p=join(root,'local-'+local.size);await writeFile(p,b);local.set(path,p)}
  let requests=0;const fetcher:RobotDownloadFetcher=async()=>{requests++;throw new Error('不应联网')}
  const input={manifest:m,endpoint:'http://127.0.0.1/test',modelId:m.packId,token:'fixture',dataDirectory:join(root,'cache'),signal:new AbortController().signal,fetcher,localFiles:local}
  const first=await installRobotDownload(input);expect(first.reusedFiles).toHaveLength(5);expect(first.policyPrepared).toBe(false)
  const again=await installRobotDownload({...input,localFiles:undefined});expect(again.reusedFiles).toHaveLength(5);expect(requests).toBe(0)
  const saved=JSON.parse(await readFile(join(first.root,'manifest.json'),'utf8'));expect(saved.execution.status).toBe('BLOCKED');expect(JSON.stringify(saved)).not.toContain('fixture')
 }finally{await rm(root,{recursive:true,force:true})}
})
test('本地bundle源meshdir可带尾斜线，POSIX闭包安装保留源XML字节且0网络',async()=>{
 const root=await mkdtemp(join(tmpdir(),'robot-meshdir-tail-'));try{
  for(const [index,meshdir]of ['meshes','meshes/'].entries()){
   const xml=`<mujoco><compiler meshdir="${meshdir}"/><asset><mesh file="pelvis.STL"/></asset></mujoco>`,{m,data}=make(xml),local=new Map<string,string>()
   for(const[path,b]of data){const p=join(root,`local-${index}-${local.size}`);await writeFile(p,b);local.set(path,p)}
   let requests=0
   const installed=await installRobotDownload({manifest:m,endpoint:'http://127.0.0.1/test',modelId:m.packId,dataDirectory:join(root,'cache-'+index),signal:new AbortController().signal,localFiles:local,fetcher:async()=>{requests++;throw Error('禁止联网')}})
   expect(installed.reusedFiles).toHaveLength(5);expect(requests).toBe(0)
   expect(await readFile(join(installed.root,required[3]!),'utf8')).toBe(xml)
   expect(installed.policyPrepared).toBe(false);expect(installed.robotWalkingVerified).toBe(false)
  }
 }finally{await rm(root,{recursive:true,force:true})}
})
test('源prefix和mesh先校验原始相对段，组合不能掩盖父目录或绝对路径',async()=>{
 const root=await mkdtemp(join(tmpdir(),'robot-meshdir-invalid-'));try{
  for(const [index,[meshdir,file]]of [['../meshes/','pelvis.STL'],['/meshes/','pelvis.STL'],['meshes//nested/','pelvis.STL'],['meshes\\','pelvis.STL'],['meshes/','../pelvis.STL'],['meshes/','/pelvis.STL'],['meshes/','nested/../pelvis.STL'],['meshes/','nested//pelvis.STL']].entries()){
   const {m,data}=make(`<mujoco><compiler meshdir="${meshdir}"/><asset><mesh file="${file}"/></asset></mujoco>`),local=new Map<string,string>()
   for(const[path,b]of data){const p=join(root,`local-${index}-${local.size}`);await writeFile(p,b);local.set(path,p)}
   let requests=0
   await expect(installRobotDownload({manifest:m,endpoint:'http://127.0.0.1/test',modelId:m.packId,dataDirectory:join(root,'cache-'+index),signal:new AbortController().signal,localFiles:local,fetcher:async()=>{requests++;throw Error('禁止联网')}})).rejects.toThrow('INVALID_POLICY_FILE')
   expect(requests).toBe(0)
  }
 }finally{await rm(root,{recursive:true,force:true})}
})
test('端点503仅请求一次，立即返回精确来源web_fetch而非层层重试',async()=>{
 const root=await mkdtemp(join(tmpdir(),'robot-fast-fail-'));try{const{m}=make();let n=0
  try{await installRobotDownload({manifest:m,endpoint:'http://127.0.0.1/test',modelId:m.packId,token:'fixture',dataDirectory:root,signal:new AbortController().signal,fetcher:async()=>{n++;return new Response('{}',{status:503})}});throw new Error('应失败')}catch(e){expect(e).toBeInstanceOf(RobotDownloadFailure);expect((e as RobotDownloadFailure).retryable).toBe(false);expect((e as RobotDownloadFailure).fallbackAction).toBe('web_fetch');expect((e as RobotDownloadFailure).fallback?.rawBase).toContain(source.resolvedRevision)}
  expect(n).toBe(1)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('清单后stream首错保留服务端身份并补同pin精确链接，不借其它来源',async()=>{
 const root=await mkdtemp(join(tmpdir(),'robot-post-manifest-fail-'));try{
  const{m}=make();m.fallback={action:'web_fetch',retryable:false,rawBase:`https://raw.githubusercontent.com/${source.modelId}/${source.resolvedRevision}/`,blobBase:`https://github.com/${source.modelId}/blob/${source.resolvedRevision}/`}
  const calls:string[]=[]
  const fetcher:RobotDownloadFetcher=async(url)=>{const path=new URL(url).pathname;calls.push(path);if(path.endsWith('/manifest'))return Response.json(m);if(path.endsWith('/open'))return Response.json({mountId:'test-mount',files:m.files});return new Response('{}',{status:503})}
  let failed:RobotDownloadFailure|undefined
  try{await installRobotDownload({endpoint:'http://127.0.0.1/test',modelId:m.packId,token:'fixture',dataDirectory:root,signal:new AbortController().signal,fetcher})}catch(error){failed=error as RobotDownloadFailure}
  expect(failed?.code).toBe('ROBOT_DOWNLOAD_ENDPOINT_FAILED');expect(failed?.retryable).toBe(false);expect(calls).toHaveLength(3)
  const fallback=failed?.fallback as any
  expect(fallback?.rawBase).toBe(m.fallback.rawBase);expect(fallback?.blobBase).toBe(m.fallback.blobBase)
  expect(fallback?.urls).toHaveLength(m.files.length)
  for(const row of fallback.urls)expect(row.url).toBe(`${m.fallback.rawBase}${row.path}`)
  expect(fallback.directories).toEqual([{path:'resources/robots/g1_description/meshes',url:`https://github.com/${source.modelId}/tree/${source.resolvedRevision}/resources/robots/g1_description/meshes`}])
  m.source={...source,resolvedRevision:'a'.repeat(40)};calls.length=0
  try{await installRobotDownload({endpoint:'http://127.0.0.1/test',modelId:m.packId,token:'fixture',dataDirectory:root,signal:new AbortController().signal,fetcher})}catch(error){expect((error as RobotDownloadFailure).code).toBe('ROBOT_DOWNLOAD_PREFLIGHT_BLOCKED');expect((error as RobotDownloadFailure).fallback as any).not.toHaveProperty('urls')}
  expect(calls).toHaveLength(1)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('open响应body停滞有界终态，不留无限后台等待',async()=>{
 const root=await mkdtemp(join(tmpdir(),'robot-body-timeout-'));try{const{m}=make();const start=Date.now()
  await expect(installRobotDownload({manifest:m,endpoint:'http://127.0.0.1/test',modelId:m.packId,token:'fixture',dataDirectory:root,signal:new AbortController().signal,timeoutMs:20,fetcher:async()=>new Response(new ReadableStream({start(){}}))})).rejects.toThrow('BODY_TIMEOUT')
  expect(Date.now()-start).toBeLessThan(300)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('缺world只绑定同Scene唯一真实句柄，不猜多世界或覆盖显式代次',async()=>{
 const input={provider:'github' as const,modelId:'x/y',sceneId:'scene',entityId:'robot'}
 const sim={listWorlds:async()=>[{sceneId:'scene',worldId:'real',worldGeneration:7}]} as never
 const bound=await resolvePolicyWorldBinding(input,sim);expect(bound.worldId).toBe('real');expect(bound.expectedGeneration).toBe(7)
 const two={listWorlds:async()=>[{sceneId:'scene',worldId:'a',worldGeneration:1},{sceneId:'scene',worldId:'b',worldGeneration:2}]} as never
 expect(await resolvePolicyWorldBinding(input,two)).toEqual(input)
 expect(await resolvePolicyWorldBinding({...input,worldId:'explicit',expectedGeneration:3},sim)).toMatchObject({worldId:'explicit',expectedGeneration:3})
})
test('未验证23策略的schema缺项与真实provider观察缺失分层，不伪造observer',async()=>{
 const root=await mkdtemp(join(tmpdir(),'robot-observer-diagnostic-'));try{
  const result=await matchPolicy({dataDirectory:root},{provider:'github',modelId:'jloganolson/g1_23dof_basic_locomotion',revision:'e7c3fbd6d30ad2c85106dfcc4d26d9ee11ca3727',sceneId:'s',entityId:'robot'},{inspect:async()=>({sceneId:'s',revision:1,entities:[]}) as never})
  expect(result.status).toBe('BLOCKED');expect(result.diagnostics.stage).toBe('POLICY_ARTIFACTS');expect(result.diagnostics.providerObservationAttempted).toBe(false);expect(result.diagnostics.missingWorldBinding).toBe(true);expect(result.diagnostics.missingMeasuredObservationFields).toEqual([])
 }finally{await rm(root,{recursive:true,force:true})}
})
test('23/75统一下载型号独立于旧12DOF，不把登记来源当已下载',()=>{
 const rows=registeredRobotDownloads(),old=rows.find(r=>r.adapterId==='unitree-g1-12dof-v1')!,current=rows.find(r=>r.adapterId==='jlog-g1-23-75-torchscript-v1')!
 expect(old.downloadModelId).toBe('unitree_g1_12dof_motion');expect(current.downloadModelId).toBe('unitree_g1_23dof_75obs');expect(current.label).toContain('23DOF / 75');expect(current.identity.modelId).toBe('jloganolson/g1_23dof_locomotion_isaac')
 expect(current.fallback.urls[0]!.url).toBe(`https://media.githubusercontent.com/media/${current.identity.modelId}/${current.identity.revision}/deployment/policy.pt`)
})
test('下载ID不能借用旧12适配器，关节数与唯一关节声明必须相等',()=>{
 const{m}=make()
 expect(()=>robotDownloadManifest({...m,packId:'unitree_g1_23dof_75obs'})).toThrow('MODEL_MISMATCH')
 expect(()=>robotDownloadManifest({...m,adapter:{...m.adapter!,controlledJointCount:23}})).toThrow('ADAPTER_INVALID')
 expect(()=>robotDownloadManifest({...m,adapter:{...m.adapter!,jointNames:Array(12).fill('same')}})).toThrow('ADAPTER_INVALID')
})
test('manifest和HTTP许可阻断一次列齐，不用web_fetch绕过缺许可',async()=>{
 const{m}=make(),missingLicense=['jloganolson/g1_23dof_locomotion_isaac@fixed/policy.pt'],missingFiles=['POLICY_LICENSE']
 try{robotDownloadManifest({...m,downloadReady:false,missingFiles,missingLicense});throw Error('应拒绝')}catch(error){expect((error as RobotDownloadFailure).toJSON()).toMatchObject({code:'ROBOT_DOWNLOAD_NOT_READY',missingFiles,missingLicense,retryable:false})}
 let requests=0
 try{await installRobotDownload({endpoint:'http://127.0.0.1/test',modelId:m.packId,token:'fixture',dataDirectory:'/not-used',signal:new AbortController().signal,fetcher:async()=>{requests++;return Response.json({code:'ROBOT_BUNDLE_LICENSE_UNVERIFIED',missingFiles,missingLicense},{status:409})}});throw Error('应拒绝')}catch(error){expect((error as RobotDownloadFailure).toJSON()).toMatchObject({code:'ROBOT_BUNDLE_LICENSE_UNVERIFIED',missingFiles,missingLicense,retryable:false});expect((error as Error).message).toContain('补齐许可前不取件')}
 expect(requests).toBe(1)
})
test('混合23模型与LFS权重保留逐件固定来源，完整包校验覆盖非Git派生件',async()=>{
 const root=await mkdtemp(join(tmpdir(),'robot-mixed-23-'));try{
  const oldSource=source,policy={provider:'github' as const,modelId:'jloganolson/g1_23dof_locomotion_isaac',resolvedRevision:'fbfa38706b817e2d4b19e444db95ae7fb2537b46'}
  const data=new Map([['robot/model.xml',Buffer.from('<mujoco/>')],['deployment/policy.pt',Buffer.from('LFS-materialized-bytes')],['adapter-contract.json',Buffer.from('{}')]])
  const files=[...data].map(([path,b])=>({path,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex'),...(path==='robot/model.xml'?{gitBlob:createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'),sourceRepository:oldSource.modelId,sourceRevision:oldSource.resolvedRevision,sourcePath:'resources/robots/g1_description/g1_23dof_rev_1_0.xml',url:`https://raw.githubusercontent.com/${oldSource.modelId}/${oldSource.resolvedRevision}/resources/robots/g1_description/g1_23dof_rev_1_0.xml`}:path==='deployment/policy.pt'?{sourceRepository:policy.modelId,sourceRevision:policy.resolvedRevision,sourcePath:path,url:`https://media.githubusercontent.com/media/${policy.modelId}/${policy.resolvedRevision}/${path}`,sourceGitBlob:'a'.repeat(40)}:{sourceKind:'derived-contract'})}))
  const m:RobotDownloadManifest={schema:'robot-download/v1',packId:'unitree_g1_23dof_75obs',version:policy.resolvedRevision,downloadReady:true,serverSideInference:false,source:policy,files,adapter:{id:'jlog-g1-23-75-torchscript-v1',controlledJointCount:23,jointNames:Array.from({length:23},(_,i)=>'j'+i),registeredAdapterRequires:['deployment/policy.pt'],deploymentClosure:[...data.keys()],modelEntry:'robot/model.xml',observationDim:75,actionDim:23}}
  robotDownloadManifest(m)
  const local=new Map<string,string>();for(const[path,b]of data){const p=join(root,'local-'+local.size);await writeFile(p,b);local.set(path,p)}
  const installed=await installRobotDownload({manifest:m,endpoint:'http://127.0.0.1/test',modelId:m.packId,dataDirectory:root,signal:new AbortController().signal,localFiles:local})
  const saved=JSON.parse(await readFile(join(installed.root,'manifest.json'),'utf8'))
  expect(saved.files).toHaveLength(3);expect(saved.sourceFiles).toHaveLength(2);expect(saved.sourceFiles.find((f:any)=>f.path==='robot/model.xml').url).toBe(m.files[0]!.url);expect(saved.sourceFiles.find((f:any)=>f.path==='deployment/policy.pt').url).toBe(m.files[1]!.url)
  const state=await policyLoadState({dataDirectory:root,pythonPath:'/not-used'},{identity:{...policy,revision:policy.resolvedRevision}},{runtimeModules:new Set(['mujoco','numpy','torch','yaml'])})
  // 运输层的合成字节全部相等，不等于它真是登记的299424B固定权重。
  expect(state.evidence).toMatchObject({filesVerified:true,completeBundleVerified:false,weightsPresent:true,weightsVerified:false,cachePrepared:false,preparedOnInstance:false,worldMatched:false,worldRunning:false,behaviorVerified:false});expect(state.ready).toBe(false)
  expect(state.missing.some(m=>m.code==='POLICY_ADAPTER_SOURCE_MISMATCH')).toBe(true)
  await writeFile(join(installed.root,'adapter-contract.json'),'changed')
  expect((await verifyPolicy(root,{...policy,revision:policy.resolvedRevision})).valid).toBe(false)
  const stale=await policyLoadState({dataDirectory:root,pythonPath:'/not-used'},{identity:{...policy,revision:policy.resolvedRevision}},{runtimeModules:new Set(['mujoco','numpy','torch','yaml'])})
  expect(stale.evidence?.completeBundleVerified).toBe(false);expect(stale.missing.some(x=>x.field==='adapter-contract.json')).toBe(true)
  expect(()=>robotDownloadManifest({...m,files:files.map(f=>f.path==='robot/model.xml'?{...f,sourceRevision:'a'.repeat(40)}:f)})).toThrow('FILE_SOURCE_INVALID')
 }finally{await rm(root,{recursive:true,force:true})}
})
