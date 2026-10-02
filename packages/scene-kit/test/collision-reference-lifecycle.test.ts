import {afterEach,beforeEach,expect,test} from 'bun:test'
import {createHash} from 'node:crypto'
import {mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {SceneOperations} from '../src/operations.ts'
import {SceneConflict} from '../src/store.ts'
import {PHYSICALIZATION_POLICY,pendingPhysicalization,resourcePhysicalizationOptions,schedulePhysicalization} from '../src/physicalization.ts'
import {physicalizationVariant} from '../src/physicalization.ts'
import {box,solidGlb} from './glb-geometry-fixture.ts'
import type {ResourceRecord} from '../src/resources.ts'
import {identityTransform} from '../../lyapunov-contracts/src/types.ts'
import {localPath} from '../src/formats.ts'

let root:string,ops:SceneOperations
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'a08-collision-owner-'));ops=new SceneOperations(join(root,'data'))})
afterEach(async()=>{await rm(root,{recursive:true,force:true})})
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const cubeOBJ='v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 0 0 1\nv 1 0 1\nv 1 1 1\nv 0 1 1\nf 1 3 2\nf 1 4 3\nf 5 6 7\nf 5 7 8\nf 1 2 6\nf 1 6 5\nf 2 3 7\nf 2 7 6\nf 3 4 8\nf 3 8 7\nf 4 1 5\nf 4 5 8\n'
async function publish(id='asset',scale=1,usage:'static'|'environment'='static',strategy='triangle_mesh',policy=PHYSICALIZATION_POLICY){
 const source=join(root,`${id}-${scale}.glb`)
 await writeFile(source,solidGlb({generator:`${id}-${scale}`,nodes:[{name:'box',mesh:box(scale)}]}))
 const resource=await ops.resources.import({path:source,resourceId:id,source:{units:'m',upAxis:'Z',handedness:'right',metersPerUnit:1},physicalizationRequest:{usage,strategy:strategy as 'triangle_mesh'}})
 const directory=join(ops.resources.derivedRoot,id,`v${resource.ref.version}`,'collision',usage,physicalizationVariant(strategy,undefined,policy)),part=join(directory,'part-0-0.obj'),manifest=join(directory,'physicalization.json')
 await mkdir(directory,{recursive:true});await writeFile(part,cubeOBJ)
 await writeFile(manifest,JSON.stringify({sourcePath:localPath(resource.ref.original.uri),sourcePreserved:true,units:'m',upAxis:'Z',strategy,objects:[{node:'box',selected:strategy,parts:[part]}]}))
 const record=await ops.resources.attachPhysicalization(id,resource.ref.version,{status:'ok',strategy,usage,policy,representations:[{uri:pathToFileURL(part).href,role:'collision',mimeType:'model/obj'},{uri:pathToFileURL(manifest).href,role:'collision',mimeType:'application/json'}],componentDefaults:{collision:{shape:'mesh',parts:[pathToFileURL(part).href],friction:[.7,.02,.005],material:'plastic',source:'asset-bake-hull'},rigidBody:{type:'static'}}})
 return {record,part,manifest,source}
}
async function mounted(record:ResourceRecord,id='placed'){
 try{await ops.create({sceneId:'s'})}catch{}
 return ops.mount({sceneId:'s',resourceId:record.ref.resourceId,version:record.ref.version,entityId:id})
}
async function seedLegacyBad(record:ResourceRecord,part:string){
 const mount=await mounted(record),scene=structuredClone(mount.snapshot),e=scene.entities.find(e=>e.entityId===mount.entityId)!
 const bad=pathToFileURL(join(root,'data','assets','sessions','old-session',localPath(pathToFileURL(part).href).slice(localPath(pathToFileURL(part).href).lastIndexOf('/derived/')+1))).href
 e.components.collision={...e.components.collision,parts:[bad]};delete e.components.physicsBinding
 await writeFile(ops.scene.path('s'),JSON.stringify(scene)) // 只构造测试自有旧数据，不绕过产品来写用户场景。
 return {scene,bad,entityId:mount.entityId}
}

test('同版本完整变体恢复错误URI，CAS新版本、旧历史与原件字节保持',async()=>{
 const {record,part,source}=await publish(),bytes=await readFile(source),legacy=await seedLegacyBad(record,part),old=await readFile(ops.scene.path('s'))
 const result=await ops.reconcilePhysics({sceneId:'s',expectedRevision:legacy.scene.revision,waitForPending:true})
 expect(result.changed).toBe(true);expect(result.snapshot.revision).toBe(legacy.scene.revision+1)
 expect(result.snapshot.entities.find(e=>e.entityId===legacy.entityId)!.components.collision!.parts).toEqual([pathToFileURL(part).href])
 expect(hash(await readFile(source))).toBe(hash(bytes))
 expect((await ops.scene.version('s',legacy.scene.revision)).entities.find(e=>e.entityId===legacy.entityId)!.components.collision!.parts).toEqual([legacy.bad])
 expect(hash(old)).not.toBe(hash(await readFile(ops.scene.path('s'))))
 expect((await ops.reconcilePhysics({sceneId:'s'})).changed).toBe(false)
})
test('正确存在但来自其它资源或版本的碰撞件，Scene事务拒绝且零写入',async()=>{
 const a=await publish('a'),other=await publish('other'),next=await publish('a',2),mount=await mounted(a.record),before=await readFile(ops.scene.path('s'))
 for(const foreign of [other.part,next.part]){
  const entity=mount.snapshot.entities.find(e=>e.entityId===mount.entityId)!
  await expect(ops.scene.commit({sceneId:'s',expectedRevision:mount.snapshot.revision,patch:[{op:'update',entityId:entity.entityId,changes:{components:{...entity.components,collision:{...entity.components.collision,parts:[pathToFileURL(foreign).href]}}}}]})).rejects.toThrow('COLLISION_RESOURCE_MISMATCH')
  expect(await readFile(ops.scene.path('s'))).toEqual(before)
 }
})
test('错误版本不能凭同名派生恢复；过期reconcile版本不修改场景',async()=>{
 const a=await publish(),legacy=await seedLegacyBad(a.record,a.part),before=await readFile(ops.scene.path('s'))
 await expect(ops.reconcilePhysics({sceneId:'s',expectedRevision:legacy.scene.revision-1})).rejects.toThrow(SceneConflict)
 expect(await readFile(ops.scene.path('s'))).toEqual(before)
 const e=legacy.scene.entities.find(e=>e.entityId===legacy.entityId)!
 e.components.collision={...e.components.collision,parts:[legacy.bad.replace('/v1/','/v2/')]}
 await writeFile(ops.scene.path('s'),JSON.stringify(legacy.scene))
 await expect(ops.reconcilePhysics({sceneId:'s'})).rejects.toThrow('COLLISION_RESOURCE_MISMATCH')
})
test('仅位置/相机更改命中已核字节缓存，原位同长度写入/缺件会失效并拒提交',async()=>{
 const a=await publish(),mount=await mounted(a.record),first=ops.resources.collisionVerificationStats()
 let snapshot=mount.snapshot
 for(let x=1;x<=3;x++)snapshot=await ops.scene.commit({sceneId:'s',expectedRevision:snapshot.revision,patch:[{op:'update',entityId:mount.entityId,changes:{transform:{...identityTransform(),position:[x,0,0]}}}]})
 snapshot=await ops.scene.commit({sceneId:'s',expectedRevision:snapshot.revision,patch:[{op:'add',entity:{entityId:'camera',name:'相机',transform:identityTransform(),resources:[],components:{annotation:{kind:'camera-fixture'}}}}]})
 const hot=ops.resources.collisionVerificationStats();expect(hot.hashReads).toBe(first.hashReads);expect(hot.cacheHits).toBeGreaterThan(first.cacheHits)
 const original=await readFile(a.part),info=await stat(a.part);await writeFile(a.part,original.toString().replace('v 1 0 0','v 2 0 0'))
 expect((await stat(a.part)).size).toBe(info.size)
 const before=await readFile(ops.scene.path('s'))
 await expect(ops.scene.commit({sceneId:'s',expectedRevision:snapshot.revision,patch:[{op:'update',entityId:mount.entityId,changes:{name:'不应提交'}}]})).rejects.toThrow('COLLISION_ARTIFACT_UNAVAILABLE')
 expect(ops.resources.collisionVerificationStats().hashReads).toBeGreaterThan(hot.hashReads);expect(await readFile(ops.scene.path('s'))).toEqual(before)
 await rm(a.part)
 expect((await ops.resources.verifyCollisionArtifacts('asset',1)).missing.length).toBe(1)
})
test('旧failed-PENDING重开收明确终态，不自动重新派生；snapshot仅读',async()=>{
 const path=join(root,'source.glb');await writeFile(path,solidGlb({generator:'failed',nodes:[{name:'box',mesh:box()}]}))
 const record=await ops.resources.import({path,resourceId:'asset',physicalizationRequest:{usage:'environment'}})
 await ops.resources.attachPhysicalization('asset',1,{status:'failed',usage:'environment',strategy:'auto',error:'Invalid string length'})
 await ops.create({sceneId:'s'});await ops.scene.commit({sceneId:'s',expectedRevision:0,patch:[{op:'add',entity:{entityId:'model',name:'旧大件',transform:identityTransform(),resources:[record.ref],components:{visual:{kind:'mesh'},physicsBinding:{resourceId:'asset',version:1,status:'PENDING'}}}}]})
 const before=await readFile(ops.scene.path('s')),fresh=new SceneOperations(join(root,'data'))
 await fresh.inspect('s');expect(await readFile(ops.scene.path('s'))).toEqual(before)
 const result=await fresh.reconcilePhysics({sceneId:'s',expectedRevision:1})
 expect(result.pending).toBe(false);expect(result.snapshot.entities[0]!.components.physicsBinding).toMatchObject({status:'BIND_REQUIRED',reason:'PHYSICS_DERIVATION_FAILED: Invalid string length'})
 expect((await fresh.resources.get('asset',1)).physicalization!.attempts).toBe(1)
 expect(result.issues[0]!.reason).toBe('Invalid string length')
 const saved=join(root,'saved.scene.json');await fresh.save('s',saved)
 const reopened=await fresh.open(saved,{sceneId:'reopened'});expect(reopened.entities[0]!.components.physicsBinding).toMatchObject({status:'BIND_REQUIRED'})
})
test('物理开关保留；原URI已发布时不能原位换字节冒充同一次派生',async()=>{
 const a=await publish(),mount=await mounted(a.record),e=mount.snapshot.entities.find(e=>e.entityId===mount.entityId)!
 const adjusted=await ops.updatePhysics({sceneId:'s',entityId:mount.entityId,expectedRevision:mount.snapshot.revision,type:'static',gravityEnabled:false,collisionEnabled:false})
 expect(adjusted.snapshot.entities.find(e=>e.entityId===mount.entityId)!.components.rigidBody?.gravityEnabled).toBe(false)
 await writeFile(a.part,cubeOBJ.replace('v 1 0 0','v 2 0 0'))
 await expect(ops.resources.attachPhysicalization('asset',1,{status:'ok',strategy:'triangle_mesh',usage:'static',representations:a.record.ref.representations.filter(r=>r.role==='collision'),componentDefaults:a.record.componentDefaults!})).rejects.toThrow('COLLISION_ARTIFACT_IMMUTABLE')
})
test('队列中已取消的请求写真实取消终态，不产生几何目录或永久PENDING',async()=>{
 const path=join(root,'cancel.glb');await writeFile(path,solidGlb({generator:'cancel',nodes:[{name:'box',mesh:box()}]}))
 const record=await ops.resources.import({path,resourceId:'cancel',physicalizationRequest:{usage:'static'}})
 const controller=new AbortController();controller.abort()
 const result=await schedulePhysicalization(ops.resources,record.ref,{usage:'static',strategy:'auto',signal:controller.signal})
 expect(result!.physicalization).toMatchObject({status:'failed',error:'PHYSICS_DERIVATION_CANCELLED: 派生在队列中已取消'})
 expect(await stat(join(ops.resources.derivedRoot,'cancel')).then(()=>true,()=>false)).toBe(false)
 const mount=await mounted(result!);expect(mount.snapshot.entities.find(e=>e.entityId===mount.entityId)!.components.physicsBinding).toMatchObject({status:'BIND_REQUIRED'})
})
test('旧auto环境政策升级失败移除unsafe parts，不只改status；自定义配置/原件/旧变体保留',async()=>{
 const a=await publish('old-environment',1,'environment','auto','cavity-safe-2')
 // 构造只在测试自有目录中的旧BOUND实例，使用尚未配置算法的目标恢复，真实触发spawn失败。
 await ops.create({sceneId:'s'})
 const snapshot=await ops.scene.commit({sceneId:'s',expectedRevision:0,patch:[{op:'add',entity:{entityId:'old',name:'旧环境',transform:identityTransform(),resources:[a.record.ref],components:{visual:{kind:'mesh'},...a.record.componentDefaults,rigidBody:{type:'static',gravityEnabled:false},collision:{...a.record.componentDefaults!.collision,enabled:false},physicsBinding:{resourceId:a.record.ref.resourceId,version:1,status:'BOUND',usage:'environment',strategy:'auto',policy:'cavity-safe-2',derivedComponents:a.record.componentDefaults}}}}]})
 const oldPartHash=hash(await readFile(a.part)),oldSourceHash=hash(await readFile(a.source))
 const failed=new SceneOperations(join(root,'data'),{algorithmPython:join(root,'missing-python')})
 const result=await failed.reconcilePhysics({sceneId:'s',expectedRevision:snapshot.revision,waitForPending:true})
 const e=result.snapshot.entities[0]!
 expect(e.components.physicsBinding).toMatchObject({status:'BIND_REQUIRED'})
 expect(e.components.collision).toBeUndefined();expect(e.components.rigidBody).toMatchObject({type:'static',gravityEnabled:false})
 expect(result.issues.length).toBeGreaterThan(0);expect(hash(await readFile(a.part))).toBe(oldPartHash);expect(hash(await readFile(a.source))).toBe(oldSourceHash)
 expect((await failed.scene.version('s',snapshot.revision)).entities[0]!.components.collision!.parts).toEqual([pathToFileURL(a.part).href])
})

const python=process.env.LYAPUNOV_ALGORITHM_PYTHON
test('非等待政策恢复先撤下旧unsafe collider，返回pending，不让旧parts继续装配',async()=>{
 const a=await publish('nonblocking',1,'environment','auto','cavity-safe-2')
 await ops.create({sceneId:'s'})
 await ops.scene.commit({sceneId:'s',expectedRevision:0,patch:[{op:'add',entity:{entityId:'old',name:'旧环境',transform:identityTransform(),resources:[a.record.ref],components:{...a.record.componentDefaults,visual:{kind:'mesh'},collision:{...a.record.componentDefaults!.collision,enabled:false},physicsBinding:{resourceId:'nonblocking',version:1,status:'BOUND',usage:'environment',strategy:'auto',policy:'cavity-safe-2',derivedComponents:a.record.componentDefaults}}}}]})
 const failed=new SceneOperations(join(root,'data'),{algorithmPython:join(root,'missing-python')})
 const result=await failed.reconcilePhysics({sceneId:'s',waitForPending:false})
 expect(result.pending).toBe(true);expect(result.snapshot.entities[0]!.components.collision).toBeUndefined()
 expect(result.snapshot.entities[0]!.components.physicsBinding).toMatchObject({status:'PENDING',pendingCollisionEnabled:false})
 const flight=pendingPhysicalization(failed.resources,a.record.ref,{usage:'environment',strategy:'auto'});if(flight)await flight
 for(let tries=0;tries<100;tries++){if(((await failed.scene.snapshot('s')).entities[0]!.components.physicsBinding as {status?:string}).status!=='PENDING')break;await new Promise(resolve=>setTimeout(resolve,10))}
 expect((await failed.scene.snapshot('s')).entities[0]!.components.physicsBinding).toMatchObject({status:'BIND_REQUIRED'})
})
const actual=python?test:test.skip
actual('真实小GLB：登记后plain mount接同一in-flight终态，warm不重复算法',async()=>{
 ops=new SceneOperations(join(root,'actual'),{algorithmPython:python})
 await ops.create({sceneId:'s'});const path=join(root,'source.glb');await writeFile(path,solidGlb({generator:'plain-mount',nodes:[{name:'box',mesh:box()}]}))
 const imported=await ops.import({path,resourceId:'actual',physicalizeUsage:'static',physicalizeStrategy:'triangle_mesh',source:{units:'m',upAxis:'Z',handedness:'right',metersPerUnit:1}})
 const flight=pendingPhysicalization(ops.resources,imported.resource.ref,resourcePhysicalizationOptions(imported.resource))
 const mount=await ops.mount({sceneId:'s',resourceId:'actual',version:1,entityId:'model'})
 if(flight)await flight
 for(let tries=0;tries<100;tries++){
  const scene=await ops.scene.snapshot('s');if((scene.entities.find(e=>e.entityId===mount.entityId)!.components.physicsBinding as {status?:string})?.status!=='PENDING')break
  await new Promise(resolve=>setTimeout(resolve,10))
 }
 const record=await ops.resources.get('actual',1);expect(record.physicalization!.status).toBe('ok')
 expect((await ops.scene.snapshot('s')).entities.find(e=>e.entityId===mount.entityId)!.components.physicsBinding).toMatchObject({status:'BOUND',usage:'static'})
 const attempts=record.physicalization!.attempts
 await schedulePhysicalization(ops.resources,record.ref,resourcePhysicalizationOptions(record))
 expect((await ops.resources.get('actual',1)).physicalization!.attempts).toBe(attempts)
})
actual('真实冷缓存：缺件新位置恢复，保原件/旧历史与固定重力碰撞开关',async()=>{
 ops=new SceneOperations(join(root,'data'),{algorithmPython:python})
 const a=await publish(),mount=await mounted(a.record)
 const controls=await ops.updatePhysics({sceneId:'s',entityId:mount.entityId,expectedRevision:mount.snapshot.revision,type:'static',gravityEnabled:false,collisionEnabled:false}),sourceHash=hash(await readFile(a.source))
 await rm(a.part)
 const result=await ops.reconcilePhysics({sceneId:'s',expectedRevision:controls.snapshot.revision,waitForPending:true})
 const e=result.snapshot.entities.find(e=>e.entityId===mount.entityId)!
 expect(e.components.physicsBinding).toMatchObject({status:'BOUND',usage:'static'})
 expect(e.components.rigidBody).toMatchObject({type:'static',gravityEnabled:false})
 expect(e.components.collision!.enabled).toBe(false)
 expect((await ops.resources.get('asset',1)).physicalization!.artifactUris!.some(uri=>uri.includes('/repair-'))).toBe(true)
 expect(hash(await readFile(a.source))).toBe(sourceHash)
 expect((await ops.scene.version('s',controls.snapshot.revision)).entities.find(e=>e.entityId===mount.entityId)!.components.collision!.parts).toEqual([pathToFileURL(a.part).href])
})
