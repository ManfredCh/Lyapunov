/** 几何工作预算的公开合同；仅显式full分块扩总量，不暗改原whole上限。无Node依赖，可用于人工面板。 */
export interface PointCloudTiling {coverage:'full';tileSizeCells:64;maxTotalOccupiedVoxels:number;maxTotalBoxes:number;maxTiles:number;maxDiskBytes:number}
export interface PhysicalizationBudgetOptions {voxelSizeM?:number;maxBoxes?:number;maxOccupiedVoxels?:number;maxTiles?:number;maxSamples?:number;maxFaceVisits?:number;maxWorkingBytes?:number;maxWorkingBoxes?:number;pointCloudTiling?:PointCloudTiling}
export const PHYSICALIZATION_BUDGET_KEYS=['voxelSizeM','maxBoxes','maxOccupiedVoxels','maxTiles','maxSamples','maxFaceVisits','maxWorkingBytes','maxWorkingBoxes','pointCloudTiling'] as const
export const PHYSICALIZATION_WORK_LIMITS={maxBoxes:10000,maxOccupiedVoxels:1000000,maxTiles:16384,maxSamples:1000000000,maxFaceVisits:1000000000,maxWorkingBytes:536870912,maxWorkingBoxes:100000} as const
export const POINT_CLOUD_FULL_LIMITS={maxTotalOccupiedVoxels:2000000,maxTotalBoxes:10000,maxTiles:16384,maxDiskBytes:2147483648} as const
export const FULL_POINT_CLOUD_TILING:PointCloudTiling={coverage:'full',tileSizeCells:64,...POINT_CLOUD_FULL_LIMITS}
export function physicalizationBudgets(value:PhysicalizationBudgetOptions|undefined):PhysicalizationBudgetOptions{
 return Object.fromEntries(PHYSICALIZATION_BUDGET_KEYS.flatMap(key=>value?.[key]!==undefined?[[key,value[key]]]:[])) as PhysicalizationBudgetOptions
}
export function validatePhysicalizationBudgets(value:PhysicalizationBudgetOptions):void{
 if(value.voxelSizeM!==undefined&&(typeof value.voxelSizeM!=='number'||!Number.isFinite(value.voxelSizeM)||value.voxelSizeM<=0))throw Error('PHYSICALIZATION_VOXEL_INVALID')
 for(const [key,limit] of Object.entries(PHYSICALIZATION_WORK_LIMITS)){
  const count=(value as Record<string,unknown>)[key]
  if(count!==undefined&&(typeof count!=='number'||!Number.isSafeInteger(count)||count<1||count>limit))throw Error(`PHYSICALIZATION_BUDGET_INVALID: ${key} 必须是1..${limit}的整数`)
 }
 const tiling=value.pointCloudTiling
 if(tiling!==undefined){
  if(!tiling||typeof tiling!=='object'||Array.isArray(tiling)||Object.keys(tiling).some(key=>!['coverage','tileSizeCells',...Object.keys(POINT_CLOUD_FULL_LIMITS)].includes(key))||tiling.coverage!=='full'||tiling.tileSizeCells!==64)throw Error('POINT_CLOUD_TILING_INVALID: 仅支持显式full、64cells空间块')
  for(const [key,limit] of Object.entries(POINT_CLOUD_FULL_LIMITS)){
   const count=(tiling as unknown as Record<string,unknown>)[key]
   if(typeof count!=='number'||!Number.isSafeInteger(count)||count<1||count>limit)throw Error(`POINT_CLOUD_TOTAL_BUDGET_INVALID: ${key} 必须是1..${limit}的整数`)
  }
  if(value.voxelSizeM===undefined)throw Error('POINT_CLOUD_PRECISION_REQUIRED: 全域分块必须明确voxelSizeM；.1m是近似采样而非默认精度')
 }
}
export function physicalizationBudgetIdentity(value:PhysicalizationBudgetOptions):string{
 const budgets=physicalizationBudgets(value)
 return JSON.stringify(budgets,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v)
}
