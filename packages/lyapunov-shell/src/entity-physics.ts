import type {Entity,Frame,SceneSnapshot,WorldHandle} from '../../lyapunov-contracts/src/types.ts'
import {sameWorldBinding} from './workbench-batch-binding.ts'
import type {PhysicalizationBudgetOptions} from '../../scene-kit/src/physicalization-parameters.ts'

export interface PhysicsUpdateValues {type?:'static'|'dynamic';massKg?:number;gravityEnabled?:boolean;collisionEnabled?:boolean}
export interface PhysicsUpdateInput extends PhysicsUpdateValues {sceneId:string;entityId:string;expectedRevision:number}
export interface PhysicsBindInput extends PhysicalizationBudgetOptions {sceneId:string;entityId:string;expectedRevision:number;type?:'static'|'dynamic';usage:'dynamic'|'static'|'environment';strategy?:'auto'|'voxel_boxes'|'triangle_mesh'|'convex_hull'|'coacd'|'sdf';massKg?:number}
export interface NativePhysics {source:'mujoco-compiled'|'isaac-compiled';dynamic:boolean;massKg:number|null;gravityEnabled:boolean;collisionEnabled:boolean;colliderCount:number;bodyName?:string}
export type InitialOverlap=NonNullable<Frame['initialOverlap']>
export interface PhysicsMutationReceipt {status:string;snapshot:SceneSnapshot;entityId:string;worldNeedsSync:boolean}
const native=(entity:Entity)=>Boolean(entity.components.articulation||entity.components.mujoco||entity.components.isaac||entity.components.newton)
const physical=(entity:Entity)=>Boolean(entity.components.collision||entity.components.rigidBody||native(entity))

/** 视觉叶编辑与物理 owner 共用 Scene 父链；不改变原来的视觉选择或 gizmo。 */
export function physicsOwnerOf(scene:SceneSnapshot,entityId:string):Entity|undefined {
 const byId=new Map(scene.entities.map(e=>[e.entityId,e])),selected=byId.get(entityId),seen=new Set<string>()
 let current=selected,owner:Entity|undefined
 while(current&&!seen.has(current.entityId)){seen.add(current.entityId);if(native(current))return current;if(!owner&&physical(current))owner=current;current=current.parentId?byId.get(current.parentId):undefined}
 return owner??selected
}
export function physicsSelectionIds(scene:SceneSnapshot,entityId:string):string[] {
 const owner=physicsOwnerOf(scene,entityId);if(!owner)return []
 const ids=new Set([owner.entityId])
 for(let changed=true;changed;){changed=false;for(const e of scene.entities)if(e.parentId&&ids.has(e.parentId)&&!ids.has(e.entityId)){ids.add(e.entityId);changed=true}}
 return [...ids]
}
export function currentPhysicsFrame(scene:SceneSnapshot,world?:WorldHandle,frame?:Frame):boolean {
 return Boolean(world&&frame&&world.sceneId===scene.sceneId&&world.appliedSceneRevision===scene.revision&&['ready','running','paused'].includes(world.status)&&frame.worldId===world.worldId&&frame.generation===world.worldGeneration&&frame.sceneRevision===scene.revision)
}
export function physicsFacts(scene:SceneSnapshot,selected:string,world?:WorldHandle,frame?:Frame){
 const owner=physicsOwnerOf(scene,selected),body=owner?.components.rigidBody,collider=owner?.components.collision
 const ids=new Set(physicsSelectionIds(scene,selected)),current=currentPhysicsFrame(scene,world,frame)
 const candidate=current?(frame?.entities.find(e=>e.entityId===owner?.entityId) as {physics?:NativePhysics}|undefined)?.physics:undefined
 const measured=candidate?.source===`${world?.engineId}-compiled`?candidate:undefined
 const initial=(frame as Frame&{initialOverlap?:InitialOverlap}|undefined)?.initialOverlap
 const overlapSource=world?.engineId==='mujoco'?initial?.source==='mujoco-compiled':world?.engineId==='isaac'?initial?.source==='isaac-contact-report'||initial?.source==='isaac-scene-query':false
 const overlap=current&&initial?.sceneRevision===scene.revision&&overlapSource?initial:undefined
 const topology=frame?.collisionTopology
 const geoms=current&&topology?.worldId===world?.worldId&&topology?.generation===world?.worldGeneration&&topology?.sceneRevision===scene.revision&&topology?.source===`${world?.engineId}-compiled`?topology.geoms.filter(g=>g.entityId&&ids.has(g.entityId)):undefined
 return {owner,native:Boolean(owner&&native(owner)),hasCollider:Boolean(collider),type:body?.type==='dynamic'?'dynamic' as const:body?.type==='static'||collider?'static' as const:undefined,massKg:typeof body?.massKg==='number'&&Number.isFinite(body.massKg)&&body.massKg>0?body.massKg:undefined,gravityEnabled:body?.gravityEnabled!==false,collisionEnabled:collider?.enabled!==false,binding:owner?.components.physicsBinding as {resourceId?:string;version?:number;status?:string}|undefined,current,measured,geoms,overlap}
}

export interface PhysicsMutationPort {
 scene():SceneSnapshot|undefined
 world():WorldHandle|undefined
 selected():string|undefined
 command(name:'scene_physics_update'|'scene_bind_physics',input:PhysicsUpdateInput|PhysicsBindInput,selection:{sceneId:string;worldId?:string}):Promise<PhysicsMutationReceipt>
 applyScene(snapshot:SceneSnapshot):'applied'|'scene-changed'|'superseded'
 sync():Promise<WorldHandle|undefined>
 start():Promise<WorldHandle|undefined>
 observe(worldId:string):Promise<Frame>
 applyFrame(frame:Frame):void
}
/** CAS → 当前 Scene → 同一 world 的新 revision/generation → 首帧；各 await 后重核选择。 */
export async function runPhysicsMutation(name:'scene_physics_update'|'scene_bind_physics',input:PhysicsUpdateInput|PhysicsBindInput,port:PhysicsMutationPort):Promise<{receipt:PhysicsMutationReceipt;synced:boolean;stale:boolean}> {
 const origin=port.scene(),selection=port.selected(),bound=port.world()
 if(!origin||origin.sceneId!==input.sceneId||origin.revision!==input.expectedRevision)throw Error('SCENE_REVISION_MISMATCH: 物理编辑仍基于旧场景，请读取当前版本。')
 if(!selection||physicsOwnerOf(origin,selection)?.entityId!==input.entityId)throw Error('PHYSICS_SELECTION_CHANGED: 物理操作仅应用当前所选实例。')
 const stillSelected=()=>port.scene()?.sceneId===origin.sceneId&&port.selected()===selection
 const receipt=await port.command(name,input,{sceneId:origin.sceneId,...bound?{worldId:bound.worldId}:{}})
 const stale=()=>({receipt,synced:false,stale:true})
 if(!stillSelected())return stale()
 if(receipt.snapshot?.sceneId!==origin.sceneId)throw Error('PHYSICS_RECEIPT_SCENE_MISMATCH')
 if(port.applyScene(receipt.snapshot)!=='applied')return stale()
 if(bound&&!sameWorldBinding(bound,port.world()))return stale()
 const currentWorld=port.world()
 const world=currentWorld?currentWorld.appliedSceneRevision===port.scene()?.revision&&!receipt.worldNeedsSync?currentWorld:await port.sync():await port.start()
 if(!stillSelected())return stale()
 if(!world)return {receipt,synced:false,stale:false}
 if(!sameWorldBinding(world,port.world())||world.appliedSceneRevision!==port.scene()?.revision)return stale()
 const frame=await port.observe(world.worldId)
 if(!stillSelected()||!sameWorldBinding(world,port.world()))return stale()
 if(!currentPhysicsFrame(port.scene()!,world,frame))throw Error('PHYSICS_FRAME_UNSYNCED: 配置已提交，当前物理帧尚未应用该场景版本。')
 port.applyFrame(frame)
 return {receipt,synced:true,stale:false}
}
