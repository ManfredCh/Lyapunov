import {afterEach,beforeEach,expect,test} from 'bun:test'
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {SceneOperations} from '../src/operations.ts'
import {validatePhysicalizationRequest} from '../src/resources.ts'
import {FULL_POINT_CLOUD_TILING,physicalizationBudgetIdentity,validatePhysicalizationBudgets} from '../src/physicalization-parameters.ts'
import {physicalizationVariant,resourcePhysicalizationOptions,schedulePhysicalization,PHYSICALIZATION_POLICY} from '../src/physicalization.ts'
import {sceneBindPhysicsParameters,sceneImportParameters} from '../src/tool-schema.ts'
import {validateArgs} from '@deepseek-ai/dsh-tools'
import {box,solidGlb} from './glb-geometry-fixture.ts'

const full={usage:'environment' as const,strategy:'voxel_boxes' as const,voxelSizeM:.1,maxOccupiedVoxels:1000000,maxBoxes:10000,pointCloudTiling:{...FULL_POINT_CLOUD_TILING}}
let root:string,ops:SceneOperations
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'a08-budget-'));ops=new SceneOperations(join(root,'data'))})
afterEach(async()=>{await rm(root,{recursive:true,force:true})})

test('full显式协议与whole预算分开，精度/总量/容量越界不被暗放宽',()=>{
 expect(()=>validatePhysicalizationRequest(full)).not.toThrow()
 for(const [key,value] of [['maxTotalOccupiedVoxels',2000001],['maxTotalBoxes',10001],['maxTiles',16385],['maxDiskBytes',2147483649],['tileSizeCells',63],['coverage','partial']] as const)
  expect(()=>validatePhysicalizationRequest({...full,pointCloudTiling:{...full.pointCloudTiling,[key]:value} as any})).toThrow()
 expect(()=>validatePhysicalizationRequest({...full,voxelSizeM:undefined})).toThrow('POINT_CLOUD_PRECISION_REQUIRED')
 expect(()=>validatePhysicalizationRequest({...full,usage:'dynamic'})).toThrow('POINT_CLOUD_TILING_USAGE_INVALID')
 expect(()=>validatePhysicalizationBudgets({maxOccupiedVoxels:1000001})).toThrow('PHYSICALIZATION_BUDGET_INVALID')
 expect(()=>validatePhysicalizationBudgets({maxBoxes:10001})).toThrow('PHYSICALIZATION_BUDGET_INVALID')
})
test('precision/tile和每个显式全域容量进入独立variant，键顺序不影响身份',()=>{
 const base=physicalizationVariant('voxel_boxes',.1,PHYSICALIZATION_POLICY,full)
 expect(base).not.toBe(physicalizationVariant('voxel_boxes',.1))
 for(const [key,value] of [['maxTotalOccupiedVoxels',1900000],['maxTotalBoxes',9000],['maxTiles',16000],['maxDiskBytes',1073741824]] as const)
  expect(physicalizationVariant('voxel_boxes',.1,PHYSICALIZATION_POLICY,{...full,pointCloudTiling:{...full.pointCloudTiling,[key]:value}})).not.toBe(base)
 expect(physicalizationVariant('voxel_boxes',.2,PHYSICALIZATION_POLICY,full)).not.toBe(base)
 const reordered={maxBoxes:full.maxBoxes,maxOccupiedVoxels:full.maxOccupiedVoxels,pointCloudTiling:{maxDiskBytes:2147483648,maxTiles:16384,maxTotalBoxes:10000,maxTotalOccupiedVoxels:2000000,tileSizeCells:64 as const,coverage:'full' as const},voxelSizeM:.1}
 expect(physicalizationBudgetIdentity(reordered)).toBe(physicalizationBudgetIdentity(full))
 expect(physicalizationVariant('voxel_boxes',.1,PHYSICALIZATION_POLICY,reordered)).toBe(base)
})
test('同版本原件登记和缺省重导入保完整request，不烘焙/改原字节',async()=>{
 const path=join(root,'source.glb');await writeFile(path,solidGlb({generator:'budget',nodes:[{name:'box',mesh:box()}]}));const before=await readFile(path)
 const first=await ops.resources.import({path,resourceId:'source',physicalizationRequest:full})
 const again=await ops.resources.import({path})
 expect(again.ref).toEqual(first.ref);expect(again.physicalizationRequest).toEqual(full)
 expect(resourcePhysicalizationOptions(again)).toMatchObject(full)
 expect((await new SceneOperations(join(root,'data')).resources.get('source',1)).physicalizationRequest).toEqual(full)
 expect(await readFile(path)).toEqual(before)
 await expect(ops.import({path,physicalizationRequest:full,physicalizeUsage:'environment'})).rejects.toThrow('PHYSICS_REQUEST_MIXED')
})
test('真实schema接收自然语言与人工同参数，缺coverage/总量/未知字段仍拒',()=>{
 expect(validateArgs(sceneBindPhysicsParameters,{input:{sceneId:'s',entityId:'e',expectedRevision:1,...full}} as any)).toEqual([])
 expect(validateArgs(sceneImportParameters,{input:{path:'/source.ply',physicalizationRequest:full}} as any)).toEqual([])
 expect(validateArgs(sceneBindPhysicsParameters,{input:{sceneId:'s',entityId:'e',expectedRevision:1,type:'static',...full}} as any)).toEqual([])
 expect(validateArgs(sceneBindPhysicsParameters,{input:{sceneId:'s',entityId:'e',expectedRevision:1,type:'kinematic',...full}} as any).length).toBeGreaterThan(0)
 const {maxTotalBoxes:ignored,...missing}=full.pointCloudTiling
 expect(validateArgs(sceneBindPhysicsParameters,{input:{sceneId:'s',entityId:'e',expectedRevision:1,...full,pointCloudTiling:missing}} as any).some(error=>error.includes('maxTotalBoxes'))).toBe(true)
 expect(validateArgs(sceneBindPhysicsParameters,{input:{sceneId:'s',entityId:'e',expectedRevision:1,...full,pointCloudTiling:{...full.pointCloudTiling,partial:true}}} as any).length).toBeGreaterThan(0)
})
test('Resource进度归属完整参数，迟到different总预算不写当前pending',async()=>{
 const path=join(root,'source.glb');await writeFile(path,solidGlb({generator:'progress',nodes:[{name:'box',mesh:box()}]}))
 await ops.resources.import({path,resourceId:'source',physicalizationRequest:full})
 await ops.resources.attachPhysicalization('source',1,{status:'pending',...full})
 const progress={mode:'voxel',node:'point-cloud',facts:{stage:'full-spatial-tiles',uniqueOccupied:100},at:'2026-10-01T00:00:00Z'}
 await ops.resources.notePhysicalizationProgress('source',1,{...full,pointCloudTiling:{...full.pointCloudTiling,maxTotalBoxes:9999}},progress)
 expect((await ops.resources.get('source',1)).physicalization!.progress).toBeUndefined()
 await ops.resources.notePhysicalizationProgress('source',1,full,progress)
 expect((await ops.resources.get('source',1)).physicalization!.progress).toEqual(progress)
 await ops.resources.attachPhysicalization('source',1,{status:'failed',...full,error:'POINT_CLOUD_TOTAL_BOX_BUDGET',errorDetails:{requiredAtLeast:10001,limit:10000}})
 const failed=await ops.resources.get('source',1)
 expect(failed.physicalization).toMatchObject({status:'failed',pointCloudTiling:full.pointCloudTiling,errorDetails:{requiredAtLeast:10001,limit:10000}})
 expect(failed.componentDefaults?.collision).toBeUndefined()
})
const actual=process.env.LYAPUNOV_ALGORITHM_PYTHON?test:test.skip
actual('实际小件geometry预算传至worker；失败收尾非PENDING，热缓存不重派生旧字节不变',async()=>{
 const path=join(root,'bounded.glb');await writeFile(path,solidGlb({generator:'bounded-budget',nodes:[{name:'box',mesh:box()}]}))
 const source=await ops.resources.import({path,resourceId:'bounded',physicalizationRequest:false})
 const opts={usage:'environment' as const,strategy:'voxel_boxes' as const,voxelSizeM:.1,maxBoxes:100,maxOccupiedVoxels:100000,maxTiles:1024}
 const cold=(await schedulePhysicalization(ops.resources,source.ref,opts))!
 expect(cold.physicalization!.status,cold.physicalization!.error).toBe('ok');expect(cold.physicalization).toMatchObject(opts)
 expect(cold.physicalization!.geometryTransport!.verified).toBe(true)
 expect(cold.physicalization!.progress).toBeDefined()
 expect(cold.physicalization!.progress!.facts.stage).toBeDefined()
 const uris=cold.physicalization!.artifactUris!,before=await Promise.all(uris.map(uri=>readFile(new URL(uri))))
 const warm=(await schedulePhysicalization(ops.resources,source.ref,opts))!
 expect(warm.physicalization!.attempts).toBe(cold.physicalization!.attempts)
 expect(warm.physicalization!.artifactUris).toEqual(uris)
 const failed=(await schedulePhysicalization(ops.resources,source.ref,{...opts,maxBoxes:1}))!
 expect(failed.physicalization!.status).toBe('failed');expect(failed.physicalization!.error).toContain('BUDGET')
 expect(failed.physicalization!.maxBoxes).toBe(1);expect(failed.physicalization!.errorDetails).toBeDefined()
 expect(await Promise.all(uris.map(uri=>readFile(new URL(uri))))).toEqual(before)
 const restored=(await schedulePhysicalization(ops.resources,source.ref,opts))!
 expect(restored.physicalization!.status).toBe('ok');expect(restored.physicalization!.artifactUris).toEqual(uris)
 expect(await Promise.all(uris.map(uri=>readFile(new URL(uri))))).toEqual(before)
},30000)
actual('真实Scene绑定和固定只增一次CAS；资源/类型/旧revision失败不落固定半步',async()=>{
 const path=join(root,'atomic.glb');await writeFile(path,solidGlb({generator:'atomic-static',nodes:[{name:'box',mesh:box()}]}))
 await ops.create({sceneId:'atomic'})
 const placed=await ops.import({path,sceneId:'atomic',entityId:'placed',resourceId:'atomic',physicalizationRequest:false,components:{rigidBody:{type:'dynamic',massKg:3.5,gravityEnabled:false},annotation:{note:'保留'}}})
 const before=await ops.scene.snapshot('atomic'),input={sceneId:'atomic',entityId:placed.entityId!,expectedRevision:before.revision,usage:'environment' as const,strategy:'triangle_mesh' as const,type:'static' as const}
 const bound=await ops.bindPhysics(input),body=bound.snapshot.entities.find(e=>e.entityId===placed.entityId!)!
 expect(bound.snapshot.revision).toBe(before.revision+1)
 expect(body.components.rigidBody).toMatchObject({type:'static',massKg:3.5,gravityEnabled:false})
 expect(body.components.collision).toBeDefined();expect(body.components.annotation).toEqual({note:'保留'})
 const complete=await ops.scene.snapshot('atomic')
 await expect(ops.bindPhysics({...input,type:'kinematic' as any,expectedRevision:complete.revision})).rejects.toThrow('PHYSICS_BODY_TYPE_INVALID')
 await expect(ops.bindPhysics(input)).rejects.toThrow()
 expect(await ops.scene.snapshot('atomic')).toEqual(complete)
 const missing=join(root,'failed-static.glb');await writeFile(missing,solidGlb({generator:'failed-static',nodes:[{name:'box',mesh:box()}]}))
 const failed=await ops.import({path:missing,sceneId:'atomic',entityId:'failed',resourceId:'failed',physicalizationRequest:false,components:{rigidBody:{type:'dynamic',massKg:2,gravityEnabled:false}}})
 const untouched=await ops.scene.snapshot('atomic'),bad=new SceneOperations(join(root,'data'),{algorithmPython:join(root,'missing-python')})
 await expect(bad.bindPhysics({sceneId:'atomic',entityId:failed.entityId!,expectedRevision:untouched.revision,type:'static',usage:'environment',strategy:'triangle_mesh'})).rejects.toThrow('PHYSICS_DERIVATION_FAILED')
 expect(await ops.scene.snapshot('atomic')).toEqual(untouched)
 expect((await ops.scene.snapshot('atomic')).entities.find(e=>e.entityId===failed.entityId!)!.components.rigidBody!.type).toBe('dynamic')
},30000)
