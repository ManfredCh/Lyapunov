import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import type {Entity,ResourceRef,ScenePhysicsSettings} from '../../lyapunov-contracts/src/types.ts'
import {DEFAULT_WORLD_GRAVITY} from '../../lyapunov-contracts/src/world-physics.ts'

export type SceneTemplate='blank'|'physics-workspace'
export const STANDARD_GROUND_ID='lyapunov-default-ground'
export const STANDARD_GROUND_RESOURCE='lyapunov-default-ground-v1'
export const standardGroundPath=(productRoot?:string)=>productRoot?join(productRoot,'packages/scene-kit/materials/standard-ground.glb'):fileURLToPath(new URL('../materials/standard-ground.glb',import.meta.url))
export function physicsWorkspaceSettings():ScenePhysicsSettings{
 return {gravityWorldMps2:[...DEFAULT_WORLD_GRAVITY],template:'physics-workspace-v2',groundEntityId:STANDARD_GROUND_ID,groundState:'present'}
}
/** Collider是z=0、法向+Z的零厚度无限plane；20米视觉参考面不限制碰撞范围。 */
export function standardGroundEntity(ref?:ResourceRef):Entity{
 return {entityId:STANDARD_GROUND_ID,name:'Infinite ground',locked:true,transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:ref?[ref]:[],
  components:{visual:{kind:'infinite-ground',referenceSizeM:20},collision:{shape:'plane',infinite:true,size:[0,0,.1],friction:[1.2,.08,.01]},rigidBody:{type:'static'},
   supportSurface:{kind:'ground',source:'scene-template',template:'physics-workspace-v2'}}}
}
