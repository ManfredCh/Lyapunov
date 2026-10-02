import {redactSecretsText,scrubAbsolutePaths} from '../../lyapunov-contracts/src/command-privacy.ts'
import {physicalizationBudgets} from './physicalization-parameters.ts'
import type {ResourcePhysicalization} from './resources.ts'

// 只投影算法公开阶段与有界计数；原始manifest/路径/SourceJSON只由资源owner持有。
const counts=new Set(('faces vertices sourcePoints finitePoints skippedNonfinitePoints occupiedVoxels initialOccupiedVoxels maxOccupiedVoxels maxBoxes maxGridCells gridCells tiles totalTiles tilesProcessed maxTiles facesVisited facesRasterized samplesProcessed maxSamples maxFaceVisits boxesBeforeMerge boxesAfterMerge temporaryBoxes maxWorkingBoxes workingBytesEstimate maxWorkingBytes requiredBoxesAtLeast requiredSamplesAtLeast requiredFaceVisitsAtLeast globalBoxesUsed globalMaxBoxes totalVoxelTiles maxTotalTiles totalVoxelSamples maxTotalSamples maxCellsPerTile diskBytes elapsedMs sourceReadBytes sourceReadCalls observedMaxReadBytes maxReadBytes fullScan maxTotalOccupiedVoxels maxTotalBoxes maxDiskBytes tileSizeCells requestedVoxelSizeM effectiveVoxelSizeM voxelSizeM metersPerUnit nodeCount readBytes requiredAtLeast limit processed sourceCells boxCells facesExposed triangles maxTriangles maxGeometryBytes geometryBytes').split(' '))
const text=new Set(['stage','reason','node','coverage','processing','representation','sourceKind','sourceUpAxis','coverageNotice','isaac','mujoco'])
const flags=new Set(['explicitVoxelSize','coverageComplete','occupiedUnionVerified'])
const containers=new Set(['sourceReads','limits','fullTiling','sourceBoundsM','bounds','min','max','gridDims','consumerSupport'])
const safeText=(value:string)=>scrubAbsolutePaths(redactSecretsText(value)).slice(0,500)
export function publicPhysicalizationFacts(value:Record<string,unknown>,depth=0):Record<string,unknown> {
 if(depth>3)return {}
 const result:Record<string,unknown>={}
 for(const [key,row] of Object.entries(value).slice(0,128)) {
  if(counts.has(key)&&typeof row==='number'&&Number.isFinite(row))result[key]=row
  else if(text.has(key)&&typeof row==='string')result[key]=safeText(row)
  else if(flags.has(key)&&typeof row==='boolean')result[key]=row
  else if(containers.has(key)) {
   if(Array.isArray(row)&&row.length<=3&&row.every(item=>typeof item==='number'&&Number.isFinite(item)))result[key]=row
   else if(row&&typeof row==='object'&&!Array.isArray(row))result[key]=publicPhysicalizationFacts(row as Record<string,unknown>,depth+1)
  }
 }
 return result
}
export function resourcePhysicalizationProgress(value:ResourcePhysicalization):Record<string,unknown> {
 return {status:value.status,usage:value.usage,strategy:value.strategy,policy:value.policy,...physicalizationBudgets(value),
  ...value.progress?{progress:{mode:safeText(value.progress.mode),...value.progress.node?{node:safeText(value.progress.node)}:{},facts:publicPhysicalizationFacts(value.progress.facts),at:value.progress.at}}:{},
  ...value.error?{error:safeText(value.error)}:{},...value.errorDetails?{errorDetails:publicPhysicalizationFacts(value.errorDetails)}:{},
  ...value.pointCloud?{pointCloud:value.pointCloud.map(facts=>publicPhysicalizationFacts(facts))}:{},
  ...value.boxes!==undefined?{boxes:value.boxes}:{},...value.finishedAt?{finishedAt:value.finishedAt}:{}
 }
}
