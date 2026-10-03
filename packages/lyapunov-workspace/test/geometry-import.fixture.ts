/** 外部真实 Blender 夹具：OBJ/MTL/PNG、FBX骨骼/动画，不自动安装/下载。 */
import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {spawn} from 'node:child_process'
import {SceneOperations} from '../../scene-kit/src/operations.ts'
import {parseAsset} from '../../scene-kit/src/formats.ts'
import {MuJoCoProvider} from '../../sim-mujoco/src/provider.ts'
import {identityTransform} from '../../lyapunov-contracts/src/types.ts'
import {convertRegisteredSource,convertCacheIdentity,type SpawnBlender} from '../src/model-convert.ts'
import {blenderEnvironment,blenderExecutable} from '../../scene-kit/src/blend-deps.ts'
const output=resolve(process.argv[2]??'.runtime/geometry-import-fixture'),fixtures=process.argv[3];assert(fixtures,'须提供合法OBJ/FBX/纹理原件夹具目录');await mkdir(output,{recursive:true})
const original=join(output,'original');await mkdir(original,{recursive:true});for(const name of ['rig-textured.fbx','checker.png'])await writeFile(join(original,name),await readFile(join(fixtures,name)))
const obj=['mtllib material.mtl','o TexturedBox',...[[0,0,0],[.1,0,0],[.1,.1,0],[0,.1,0],[0,0,.1],[.1,0,.1],[.1,.1,.1],[0,.1,.1]].map(v=>'v '+v.join(' ')),'vt 0 0','vt 1 0','vt 1 1','vt 0 1','usemtl Checker',...[[1,4,3,2],[5,6,7,8],[1,2,6,5],[2,3,7,6],[3,4,8,7],[4,1,5,8]].map(q=>'f '+q.map((v,i)=>v+'/'+(i+1)).join(' '))].join('\n')+'\n';await writeFile(join(original,'textured.obj'),obj);await writeFile(join(original,'material.mtl'),'newmtl Checker\nKd 1 1 1\nKs .5 .5 .5\nNs 50\nmap_Kd checker.png\n')
const operations=new SceneOperations(join(output,'registry'))
const spawnBlender:SpawnBlender=(argv,options)=>{let stdout='',stderr='';const child=spawn(argv[0]!,argv.slice(1),{cwd:options.cwd,env:blenderEnvironment(),signal:options.signal});child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);return {collected:{stdout:{readFrom:()=>({text:stdout})},stderr:{readFrom:()=>({text:stderr})}},done:new Promise(done=>child.on('close',(exitCode,signal)=>done({exitCode,signal}))),terminate:()=>{child.kill('SIGTERM')}}}
const records=[]
for(const name of ['textured.obj','rig-textured.fbx']){
 const imported=await operations.import({path:join(original,name),resourceId:name.startsWith('textured')?'obj-source':'fbx-source'})
 assert.equal(imported.resource.parsed.kind,'source');assert(imported.resource.parsed.dependencies.length>=2)
 records.push(imported.resource)
}
// 原目录挪走：必须使用已登记副本闭包，不能借原纹理仍存在当转换可移植。
await rename(original,join(output,'original-saved'))
const results=[]
for(const record of records){
 const src=new URL(record.ref.original.uri).pathname,dependencies=record.parsed.dependencies as any[]
 const originals=(record.parsed.metadata.externals as any).files as string[]
 const assetRemap=Object.fromEntries(originals.map((path,index)=>[path,dependencies[index]!.path]))
 const cacheIdentity=convertCacheIdentity({resourceId:record.ref.resourceId,version:record.ref.version,dependencies,dependenciesVerified:true})
 const converted=await convertRegisteredSource({path:src,cacheIdentity,assetRemap},{cacheRoot:join(output,'cache'),spawn:spawnBlender,blenderExecutable:blenderExecutable()})
 const parsed=await parseAsset(converted.cachedPath);const g=JSON.parse(converted.bytes.subarray(20,20+converted.bytes.readUInt32LE(12)).toString())
 assert((g.textures??[]).length>0,'原图须真实进入GLB，不默默变白模');assert(g.meshes.some((m:any)=>m.primitives.some((p:any)=>p.attributes.TEXCOORD_0!==undefined)))
 if(record.parsed.metadata.format==='fbx'){assert((g.skins??[]).length>0,'真实骨骼必须保留');assert((g.animations??[]).length>0,'真实动画必须保留')}
 const warm=await convertRegisteredSource({path:src,cacheIdentity,assetRemap},{cacheRoot:join(output,'cache'),spawn:()=>{throw new Error('缓存命中不可重启Blender')}});assert.equal(warm.cached,true)
 const derived=await operations.import({path:converted.cachedPath,resourceId:record.ref.resourceId+'-glb',physicalizeUsage:'static'})
 if(record.parsed.metadata.format==='obj'){
  const until=Date.now()+15000;let physical=derived.resource
  while(Date.now()<until){physical=await operations.resources.get(derived.resource.ref.resourceId);if(physical.physicalization?.status==='ok'||physical.physicalization?.status==='failed')break;await new Promise(r=>setTimeout(r,50))}
  assert.equal(physical.physicalization?.status,'ok',physical.physicalization?.error);assert(physical.componentDefaults?.collision);assert.equal(physical.componentDefaults?.rigidBody?.type,'static')
  const scene=await operations.create({sceneId:'geometry-physical-'+Date.now()});const mounted=await operations.mount({sceneId:scene.sceneId,resourceId:physical.ref.resourceId,entityId:'box',alignBottomToSurface:false})
  const provider=new MuJoCoProvider({pythonPath:process.env.LYAPUNOV_MUJOCO_PYTHON,workerPath:resolve(import.meta.dirname,'../../sim-mujoco/python/worker.py')})
  try{const world=await provider.open(mounted.snapshot,{clock:'manual',ground:false});const frame=await provider.observe(world.worldId,{collisionTopology:{includeGeometry:true}});assert(frame.collisionTopology?.geoms.length);await writeFile(join(output,'physics-default.json'),JSON.stringify({physical,mounted,world,frame},null,2))}finally{await provider.dispose()}
 }
 results.push({source:record.ref.resourceId,sourceFacts:record.parsed.metadata,dependencies:dependencies.length,outputPath:converted.cachedPath,bytes:converted.bytes.length,materials:g.materials,textures:g.textures.length,skins:g.skins?.length??0,animations:g.animations?.length??0,materialFacts:parsed.metadata.materials,warm: warm.cached})
}
await writeFile(join(output,'summary.json'),JSON.stringify({status:'passed',originalMovedOnlyInIsolatedFixture:true,results},null,2));console.log(JSON.stringify({status:'passed',results:results.map(r=>({source:r.source,bytes:r.bytes,textures:r.textures,skins:r.skins,animations:r.animations,warm:r.warm}))}))
