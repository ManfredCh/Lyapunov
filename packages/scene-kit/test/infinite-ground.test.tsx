import {test,expect} from 'bun:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {renderToStaticMarkup} from 'react-dom/server'
import {SceneOperations} from '../src/operations.ts'
import {SceneStore} from '../src/store.ts'
import {STANDARD_GROUND_ID} from '../src/scene-template.ts'
import {identityTransform,type SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'
import {SceneNodeLock,SceneRemovalConfirmation,infiniteGround,lockCommit,sceneNodeName,visibilityCommit,removeSceneNodeCommit} from '../../lyapunov-shell/src/scene-node-controls.tsx'
import {createRobotOperations} from '../../robot-tools/src/operations.ts'
import {SceneWorldLifecycle} from '../../lyapunov-shell/src/scene-world-lifecycle.ts'
import {EntityEditor} from '../../lyapunov-shell/src/entity-editor.tsx'

test('011：无限地面锁定、纯视觉隐藏、删除持久化、CAS和历史恢复',async()=>{
 const root=await mkdtemp(join(tmpdir(),'a09-infinite-ground-'))
 try{
  const ops=new SceneOperations(root),created=await ops.create({sceneId:'ground-state',template:'physics-workspace'}),ground=created.entities[0]!
  expect(ground).toMatchObject({entityId:STANDARD_GROUND_ID,locked:true,transform:identityTransform(),resources:[],components:{collision:{shape:'plane',infinite:true,size:[0,0,.1]},rigidBody:{type:'static'}}})
  expect(created.physics).toMatchObject({template:'physics-workspace-v2',groundState:'present',gravityWorldMps2:[0,0,-9.81]})
  expect(infiniteGround(ground)).toBe(true)
  await expect(ops.scene.commit({sceneId:created.sceneId,expectedRevision:0,patch:[{op:'update',entityId:ground.entityId,changes:{locked:false,transform:{...identityTransform(),position:[0,0,1]}}}]})).rejects.toThrow('ENTITY_LOCKED')
  await expect(ops.scene.commit({sceneId:created.sceneId,expectedRevision:0,patch:[{op:'reparent',entityId:ground.entityId}]})).rejects.toThrow('ENTITY_LOCKED')
  const hidden=await ops.scene.commit(visibilityCommit(created,ground.entityId,false))
  expect(hidden.entities[0]!.components.visual?.visible).toBe(false);expect(hidden.entities[0]!.components.collision).toEqual(ground.components.collision)
  expect(hidden.entities[0]!.locked).toBe(true)
  const deleted=await ops.scene.commit(removeSceneNodeCommit(hidden,ground.entityId))
  expect(deleted.entities).toEqual([]);expect(deleted.physics?.groundState).toBe('removed')
  expect(await new SceneStore(root).snapshot(created.sceneId)).toEqual(deleted)
  expect(await ops.prepareWorld({sceneId:created.sceneId,expectedRevision:deleted.revision})).toEqual(deleted)
  expect(await ops.prepareWorkspace({sceneId:created.sceneId,expectedRevision:deleted.revision})).toEqual(deleted)
  await expect(ops.scene.commit(removeSceneNodeCommit(hidden,ground.entityId))).rejects.toThrow('场景')
  const restored=await ops.scene.restore({sceneId:created.sceneId,expectedRevision:deleted.revision,revision:0})
  expect(restored.entities[0]!.locked).toBe(true);expect(restored.physics?.groundState).toBe('present')
  const unlocked=await ops.scene.commit(lockCommit(restored,ground.entityId,false))
  const moved=await ops.scene.commit({sceneId:created.sceneId,expectedRevision:unlocked.revision,patch:[{op:'update',entityId:ground.entityId,changes:{transform:{...identityTransform(),position:[0,0,1]}}}]})
  expect(moved.entities[0]!.transform.position).toEqual([0,0,1])
 }finally{await rm(root,{recursive:true,force:true})}
})

test('011：空制作首次物理准备保留用户重力、明确禁用、旧v1不迁移',async()=>{
 const root=await mkdtemp(join(tmpdir(),'a09-ground-preparation-'))
 try{
  const ops=new SceneOperations(root),blank=await ops.create({sceneId:'blank',template:'blank'})
  expect(blank.entities).toEqual([])
  const gravity=await ops.configurePhysics({sceneId:blank.sceneId,expectedRevision:0,gravityWorldMps2:[0,0,-3]})
  const world=await ops.prepareWorld({sceneId:blank.sceneId,expectedRevision:gravity.revision})
  expect(world.entities).toHaveLength(1);expect(world.physics?.gravityWorldMps2).toEqual([0,0,-3])
  const ground=world.entities[0]!,collisionOff=await ops.scene.commit({sceneId:world.sceneId,expectedRevision:world.revision,patch:[{op:'update',entityId:ground.entityId,changes:{components:{...ground.components,collision:{...ground.components.collision,enabled:false}}}}]})
  expect(collisionOff.physics?.groundState).toBe('disabled')
  expect(await ops.prepareWorld({sceneId:world.sceneId,expectedRevision:collisionOff.revision})).toEqual(collisionOff)
  const removedOff=await ops.scene.commit(removeSceneNodeCommit(collisionOff,ground.entityId));expect(removedOff.physics?.groundState).toBe('removed')
  const finite=await ops.create({sceneId:'finite',template:'blank'}),withFinite=await ops.scene.commit({sceneId:finite.sceneId,expectedRevision:0,patch:[{op:'add',entity:{entityId:'finite-ground',name:'用户有限地面',resources:[],transform:identityTransform(),components:{supportSurface:{kind:'ground'},collision:{shape:'box',halfExtents:[1,1,.1]},rigidBody:{type:'static'}}}}]})
  const withInfinite=await ops.prepareWorld({sceneId:finite.sceneId,expectedRevision:withFinite.revision})
  expect(withInfinite.entities.map(entity=>entity.entityId)).toEqual(['finite-ground',STANDARD_GROUND_ID])
  const off=await ops.create({sceneId:'off',template:'blank'}),disabled=await ops.prepareWorld({sceneId:off.sceneId,expectedRevision:0,ground:false})
  expect(disabled.entities).toEqual([]);expect(disabled.physics?.groundState).toBe('disabled')
  expect(await ops.prepareWorld({sceneId:off.sceneId,expectedRevision:disabled.revision})).toEqual(disabled)
  const legacy=await ops.create({sceneId:'legacy'}),old=await ops.scene.commit({sceneId:legacy.sceneId,expectedRevision:0,patch:[],physics:{template:'physics-workspace-v1',gravityWorldMps2:[0,0,-4]}})
  expect(await ops.prepareWorkspace({sceneId:legacy.sceneId,expectedRevision:old.revision})).toEqual(old)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('011：UI按locale显示无限地面、锁定和删除的物理后果',async()=>{
 const root=await mkdtemp(join(tmpdir(),'a09-ground-ui-'))
 try{
  const scene=await new SceneOperations(root).create({sceneId:'ui',template:'physics-workspace'}),entity=scene.entities[0]!,zh=(cn:string)=>cn,en=(_cn:string,english:string)=>english
  expect(sceneNodeName(entity,zh)).toBe('无限地面');expect(sceneNodeName(entity,en)).toBe('Infinite ground')
  expect(renderToStaticMarkup(<EntityEditor sceneId={scene.sceneId} revision={0} entity={entity} entities={scene.entities} tr={zh} commit={async()=>scene}/>)).toContain('value="无限地面"')
  expect(entity.name).toBe('Infinite ground')
  expect(sceneNodeName({...entity,name:'用户自己的地面名'},en)).toBe('用户自己的地面名')
  expect(sceneNodeName({...entity,name:'Infinite ground',components:{...entity.components,supportSurface:{kind:'ground',source:'user'}}},zh)).toBe('Infinite ground')
  expect(renderToStaticMarkup(<SceneNodeLock entity={entity} tr={zh} onChange={()=>{}}/>)).toContain('解锁节点 无限地面')
  const modal=renderToStaticMarkup(<SceneRemovalConfirmation target={{sessionId:'s',sceneId:'ui',revision:0,entityId:entity.entityId,name:sceneNodeName(entity,zh),nodeCount:1,ground:true}} busy={false} tr={zh} onConfirm={()=>{}} onCancel={()=>{}}/>)
  expect(modal).toContain('物理碰撞');expect(modal).toContain('重开场景不会自动恢复')
 }finally{await rm(root,{recursive:true,force:true})}
})

test('011：sim_open共享入口首次准备Scene；已有世界不迁移，取消不启动',async()=>{
 const root=await mkdtemp(join(tmpdir(),'a09-ground-open-'))
 try{
  const ops=new SceneOperations(root),blank=await ops.create({sceneId:'api',template:'blank'}),opened:SceneSnapshot[]=[],worlds:any[]=[],prepared:string[]=[]
  const sim:any={listWorlds:async()=>worlds,open:async(snapshot:SceneSnapshot)=>{opened.push(snapshot);return {sceneId:snapshot.sceneId,worldId:'world',appliedSceneRevision:snapshot.revision,status:'ready'}}}
  const api=createRobotOperations(sim,ops.scene,{prepareWorld:async(scene,options)=>{prepared.push(scene.sceneId);return ops.prepareWorld({sceneId:scene.sceneId,expectedRevision:scene.revision,ground:options?.ground})}})
  await api.sim_open({sceneId:blank.sceneId})
  expect(opened[0]!.entities[0]!.entityId).toBe(STANDARD_GROUND_ID);expect(opened[0]!.revision).toBe(1)
  worlds.push({sceneId:blank.sceneId,status:'ready',worldId:'existing'})
  await api.sim_open({sceneId:blank.sceneId});expect(prepared).toEqual(['api'])
  const controller=new AbortController();controller.abort();await expect(api.sim_open({sceneId:blank.sceneId},controller.signal)).rejects.toThrow();expect(opened).toHaveLength(2)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('011：空制作自动保持编辑；明确开始物理沿CAS接受新revision',async()=>{
 const root=await mkdtemp(join(tmpdir(),'a09-ground-lifecycle-'))
 try{
  const ops=new SceneOperations(root),scene=await ops.create({sceneId:'blank-world',template:'blank'}),calls:string[]=[],accepted:SceneSnapshot[]=[],lifecycle=new SceneWorldLifecycle(()=>{});let opened:SceneSnapshot|undefined
  const port:any={list:async()=>[],prepareWorld:async(snapshot:SceneSnapshot)=>{calls.push('prepare');return ops.prepareWorld({sceneId:snapshot.sceneId,expectedRevision:snapshot.revision})},acceptScene:(snapshot:SceneSnapshot)=>accepted.push(snapshot),open:async(snapshot:SceneSnapshot)=>{calls.push('open');opened=snapshot;return {sceneId:snapshot.sceneId,worldId:'w',worldGeneration:1,appliedSceneRevision:snapshot.revision,status:'ready'}},observe:async()=>({worldId:'w',generation:1,sceneRevision:opened!.revision,stepIndex:0,simTime:0,entities:[],frameId:'f'}),close:async()=>{}}
  await lifecycle.ensure('s','h',scene,port);expect(calls).toEqual([])
  await lifecycle.ensure('s','h',scene,port,true);expect(calls).toEqual(['prepare','open']);expect(accepted[0]!.revision).toBe(1);expect(opened!.entities[0]!.entityId).toBe(STANDARD_GROUND_ID)
 }finally{await rm(root,{recursive:true,force:true})}
})
