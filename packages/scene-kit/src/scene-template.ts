import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import type {Entity,ResourceRef,ScenePhysicsSettings} from '../../lyapunov-contracts/src/types.ts'
import {DEFAULT_WORLD_GRAVITY} from '../../lyapunov-contracts/src/world-physics.ts'

export type SceneTemplate='blank'|'physics-workspace'
export const STANDARD_GROUND_ID='lyapunov-default-ground'
export const STANDARD_GROUND_RESOURCE='lyapunov-default-ground-v1'
export const standardGroundPath=(productRoot?:string)=>productRoot?join(productRoot,'packages/scene-kit/materials/standard-ground.glb'):fileURLToPath(new URL('../materials/standard-ground.glb',import.meta.url))
export function physicsWorkspaceSettings():ScenePhysicsSettings{
 return {gravityWorldMps2:[...DEFAULT_WORLD_GRAVITY],template:'physics-workspace-v1',groundEntityId:STANDARD_GROUND_ID}
}
/** visual与collider共用20×20×0.1米的有限盒，顶面z=0；不依赖引擎隐式地面。 */
export function standardGroundEntity(ref:ResourceRef):Entity{
 return {entityId:STANDARD_GROUND_ID,name:'标准地面',transform:{position:[0,0,-.05],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[ref],
  components:{visual:{},collision:{shape:'box',halfExtents:[10,10,.05],friction:[1.2,.08,.01]},rigidBody:{type:'static'},
   supportSurface:{kind:'ground',source:'scene-template',template:'physics-workspace-v1'}}}
}
