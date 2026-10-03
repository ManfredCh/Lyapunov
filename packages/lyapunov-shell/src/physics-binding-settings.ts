import {FULL_POINT_CLOUD_TILING,validatePhysicalizationBudgets,type PhysicalizationBudgetOptions} from '../../scene-kit/src/physicalization-parameters.ts'
export interface CollisionBindingSettings {strategy:'auto'|'voxel_boxes'|'triangle_mesh'|'convex_hull'|'coacd'|'sdf';precision:'auto'|'explicit';voxelSizeM:number;maxBoxes:number;maxOccupiedVoxels:number;fullPointCloud:boolean}
export const DEFAULT_COLLISION_BINDING_SETTINGS:CollisionBindingSettings={strategy:'auto',precision:'auto',voxelSizeM:.1,maxBoxes:2048,maxOccupiedVoxels:250000,fullPointCloud:false}
export const FULL_POINT_CLOUD_SETTINGS:CollisionBindingSettings={strategy:'voxel_boxes',precision:'explicit',voxelSizeM:.1,maxBoxes:10000,maxOccupiedVoxels:1000000,fullPointCloud:true}
export const FULL_POINT_CLOUD_SURFACE_SETTINGS:CollisionBindingSettings={...FULL_POINT_CLOUD_SETTINGS,strategy:'triangle_mesh'}
export const explicitBindingMotion=(fixBody:boolean):{type?:'static'}=>fixBody?{type:'static'}:{}
export interface BindingMotionDraft {key:string;fixed:boolean}
export const physicsBindingControlKey=(sceneId:string,entityId:string|undefined)=>JSON.stringify([sceneId,entityId??null])
export const bindingMotionChecked=(draft:BindingMotionDraft,key:string)=>draft.key===key&&draft.fixed
export const scopedBindingMotion=(draft:BindingMotionDraft,key:string)=>explicitBindingMotion(bindingMotionChecked(draft,key))
export function collisionBindingParameters(settings:CollisionBindingSettings,usage:'dynamic'|'static'|'environment'):PhysicalizationBudgetOptions&{strategy:CollisionBindingSettings['strategy']}{
 const value={strategy:settings.strategy,...settings.precision==='explicit'?{voxelSizeM:settings.voxelSizeM}:{},maxBoxes:settings.maxBoxes,maxOccupiedVoxels:settings.maxOccupiedVoxels,...settings.fullPointCloud?{pointCloudTiling:{...FULL_POINT_CLOUD_TILING}}:{}}
 validatePhysicalizationBudgets(value)
 if(settings.fullPointCloud&&(usage!=='environment'||!['voxel_boxes','triangle_mesh'].includes(settings.strategy)||settings.precision!=='explicit'))throw Error('POINT_CLOUD_TILING_USAGE_INVALID: 全域点云必须明确环境、采样体素表示与精度')
 return value
}
export interface ResourcePhysicsProgress extends PhysicalizationBudgetOptions {status:string;usage?:string;strategy?:string;progress?:{mode:string;node?:string;facts:Record<string,unknown>;at:string};error?:string;errorDetails?:Record<string,unknown>;pointCloud?:Array<Record<string,unknown>>;boxes?:number}
