import type {ScenePhysicsSettings,Vec3} from './types.ts'

export const DEFAULT_WORLD_GRAVITY:Vec3=[0,0,-9.81]
export function validateScenePhysics(value:ScenePhysicsSettings):void{
 if(!value||typeof value!=='object')throw Error('WORLD_PHYSICS_INVALID')
 const g=value.gravityWorldMps2
 if(!Array.isArray(g)||g.length!==3||g.some(n=>typeof n!=='number'||!Number.isFinite(n))||!Number.isFinite(Math.hypot(...g)))throw Error('WORLD_GRAVITY_INVALID: 需要三个有限的世界重力分量，单位m/s²')
 if(value.template!==undefined&&!['blank','physics-workspace-v1'].includes(value.template))throw Error('SCENE_TEMPLATE_INVALID')
 if(value.groundEntityId!==undefined&&(typeof value.groundEntityId!=='string'||!value.groundEntityId))throw Error('SCENE_GROUND_ID_INVALID')
}
