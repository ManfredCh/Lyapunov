import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SceneOperations } from "../src/operations.ts"
import { planPhysicsUpdate } from "../src/physics-state.ts"
import {SceneConflict} from "../src/store.ts"
import { identityTransform, type Entity } from "../../lyapunov-contracts/src/types.ts"
import type { NativePhysicsUpdate } from "../src/native-physics.ts"
import { box, solidGlb } from "./glb-geometry-fixture.ts"

let root:string, operations:SceneOperations
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),"physics-state-"));operations=new SceneOperations(join(root,"data"))})
afterEach(async()=>{await rm(root,{recursive:true,force:true})})
async function physicalScene(){
 const scene=await operations.create({sceneId:"s"})
 return operations.scene.commit({sceneId:"s",expectedRevision:scene.revision,patch:[
  {op:"add",entity:{entityId:"root",name:"物件",transform:identityTransform(),resources:[],components:{visual:{kind:"group"},collision:{shape:"box",halfExtents:[.5,.4,.3],friction:[.5,.001,.0001],source:"fixture"},rigidBody:{type:"dynamic",massKg:2},annotation:{keep:"用户内容"}}}},
  {op:"add",entity:{entityId:"leaf",parentId:"root",name:"mesh",transform:identityTransform(),resources:[],components:{visual:{kind:"mesh"}}}},
  {op:"add",entity:{entityId:"other",name:"其它",transform:identityTransform(),resources:[],components:{collision:{shape:"sphere",halfExtents:[.2,0,0]},rigidBody:{type:"static"}}}},
 ]})
}
test("固定与解固定定位真实根，质量/摩擦/源保留且其它实例不变",async()=>{
 const scene=await physicalScene(),other=structuredClone(scene.entities[2])
 const fixed=await operations.updatePhysics({sceneId:"s",entityId:"leaf",expectedRevision:scene.revision,type:"static",gravityEnabled:false,collisionEnabled:false})
 expect(fixed.entityId).toBe("root");expect(fixed.worldNeedsSync).toBe(true)
 expect(fixed.snapshot.entities[0]!.components.rigidBody).toEqual({type:"static",massKg:2,gravityEnabled:false})
 expect(fixed.snapshot.entities[0]!.components.collision).toEqual({...scene.entities[0]!.components.collision,enabled:false})
 expect(fixed.snapshot.entities[2]).toEqual(other)
 const released=await operations.updatePhysics({sceneId:"s",entityId:"leaf",expectedRevision:fixed.snapshot.revision,type:"dynamic",gravityEnabled:true,collisionEnabled:true})
 expect(released.snapshot.entities[0]!.components.rigidBody).toEqual({type:"dynamic",massKg:2,gravityEnabled:true})
 expect(released.snapshot.entities[0]!.components.annotation).toEqual({keep:"用户内容"})
 const same=await operations.updatePhysics({sceneId:"s",entityId:"root",expectedRevision:released.snapshot.revision,type:"dynamic"})
 expect(same.status).toBe("UNCHANGED");expect(same.snapshot.revision).toBe(released.snapshot.revision)
 await expect(operations.updatePhysics({sceneId:"s",entityId:"root",expectedRevision:scene.revision,type:"static"})).rejects.toThrow(SceneConflict)
})
test("动态缺可靠质量明确拒绝；显式质量/隐藏与碰撞语义独立",async()=>{
 const scene=await physicalScene(),input={sceneId:"s",entityId:"other",expectedRevision:scene.revision,type:"dynamic" as const}
 expect(()=>planPhysicsUpdate(scene,input)).toThrow("PHYSICS_DYNAMIC_MASS_REQUIRED")
 const result=await operations.updatePhysics({...input,massKg:3})
 expect(result.snapshot.entities[2]!.components.rigidBody).toEqual({type:"dynamic",massKg:3,massSource:"declared",massScalePolicy:"constant"})
 expect(()=>planPhysicsUpdate(result.snapshot,{...input,expectedRevision:result.snapshot.revision,massKg:0})).toThrow("PHYSICS_MASS_INVALID")
})
test("物理CAS/history和正常保存重开持久恢复，不更改原件",async()=>{
 const scene=await physicalScene(),path=join(root,"scene.json")
 const fixed=await operations.updatePhysics({sceneId:"s",entityId:"leaf",expectedRevision:scene.revision,type:"static",collisionEnabled:false})
 await operations.save("s",path)
 const reopened=await operations.open(path,{sceneId:"reopen"})
 expect(reopened.entities[0]!.components).toEqual(fixed.snapshot.entities[0]!.components)
 const restored=await operations.scene.restore({sceneId:"s",revision:scene.revision,expectedRevision:fixed.snapshot.revision})
 expect(restored.revision).toBeGreaterThan(fixed.snapshot.revision);expect(restored.entities[0]!.components).toEqual(scene.entities[0]!.components)
})
test("显式物理用途/策略/voxel/false保在同资源版本，重复缺省导入复用原意图",async()=>{
 const path=join(root,"source.glb");await writeFile(path,solidGlb({generator:"request",nodes:[{name:"box",mesh:box()}]}))
 const original=await readFile(path)
 const library=operations.resources
 const first=await library.import({path,resourceId:"request",physicalizationRequest:{usage:"environment",strategy:"voxel_boxes",voxelSizeM:.15}})
 const repeated=await library.import({path})
 expect(repeated.ref.resourceId).toBe(first.ref.resourceId);expect(repeated.ref.version).toBe(1)
 expect(repeated.physicalizationRequest).toEqual({usage:"environment",strategy:"voxel_boxes",voxelSizeM:.15})
 const changed=await library.import({path,resourceId:"request",physicalizationRequest:false})
 expect(changed.ref.version).toBe(1);expect(changed.physicalizationRequest).toBe(false)
 const reopened=await new SceneOperations(join(root,"data")).resources.get("request",1)
 expect(reopened.physicalizationRequest).toBe(false)
 expect(await readFile(path)).toEqual(original)
})
test("不同几何替换保固定/重力/碰撞开关；密度质量取目标几何而显式质量保留",async()=>{
 await operations.create({sceneId:"s"})
 const a=join(root,"a.glb"),b=join(root,"b.glb")
 await writeFile(a,solidGlb({generator:"a",nodes:[{name:"box",mesh:box()}]}));await writeFile(b,solidGlb({generator:"b",nodes:[{name:"box",mesh:box(2)}]}))
 const old=await operations.resources.import({path:a,resourceId:"asset",components:{collision:{shape:"box",halfExtents:[.5,.5,.5],center:[.5,.5,.5],source:"fixture"},rigidBody:{type:"dynamic",massKg:2,massSource:"asset-bake",massScalePolicy:"density"}}})
 await operations.resources.import({path:b,resourceId:"asset",components:{collision:{shape:"box",halfExtents:[1,1,1],center:[1,1,1],source:"fixture"},rigidBody:{type:"dynamic",massKg:16,massSource:"asset-bake",massScalePolicy:"density"}}})
 const mounted=await operations.mount({sceneId:"s",resourceId:old.ref.resourceId,version:1,entityId:"placed"})
 const fixed=await operations.updatePhysics({sceneId:"s",entityId:"placed:node:0",expectedRevision:mounted.snapshot.revision,type:"static",gravityEnabled:false,collisionEnabled:false})
 const result=await operations.replaceResource({sceneId:"s",entityId:"placed",expectedRevision:fixed.snapshot.revision,resourceId:"asset",version:2})
 const rootEntity=result.snapshot.entities[0]!
 expect(rootEntity.components.rigidBody).toEqual({type:"static",massKg:16,massSource:"asset-bake",massScalePolicy:"density",gravityEnabled:false})
 expect(rootEntity.components.collision).toEqual({shape:"box",halfExtents:[1,1,1],center:[1,1,1],source:"fixture",enabled:false})
 const back=await operations.updatePhysics({sceneId:"s",entityId:"placed",expectedRevision:result.snapshot.revision,type:"dynamic",massKg:7})
 const replaced=await operations.replaceResource({sceneId:"s",entityId:"placed",expectedRevision:back.snapshot.revision,resourceId:"asset",version:1})
 expect(replaced.snapshot.entities[0]!.components.rigidBody?.massKg).toBe(7)
 expect(replaced.snapshot.entities[0]!.components.rigidBody?.type).toBe("dynamic")
})

test("原physics操作仅改指定原生材料，五个既有组合保全opaque组件和其它实体",async()=>{
 const created=await operations.create({sceneId:"native"})
 const opaque={visual:{robot:{document:{bodies:Array.from({length:160},(_,i)=>({name:`body${i}`,vertices:[i,i+1,i+2]}))}}},controller:{jointNames:["keep"]},custom:{document:"用户原文",values:Array.from({length:140},(_,i)=>i)}}
 const cases:Array<{entityId:string;components:Entity["components"];native:NativePhysicsUpdate;expected:unknown}>=[
  {entityId:"flex",components:{mujoco:{sourcePath:"/native/flex.xml",xml:"<mujoco/>",flexMaterials:{block:{youngPa:20000,poisson:.3,rayleighDamping:.001},other:{youngPa:1000}}}},native:{engine:"mujoco",kind:"flex",nativeName:"block",parameters:{youngPa:40000}},expected:{sourcePath:"/native/flex.xml",xml:"<mujoco/>",flexMaterials:{block:{youngPa:40000,poisson:.3,rayleighDamping:.001},other:{youngPa:1000}}}},
  {entityId:"cable",components:{mujoco:{sourcePath:"/native/cable.xml",cableMaterials:{wire:{bendPa:1000,twistPa:500}}}},native:{engine:"mujoco",kind:"cable",nativeName:"wire",parameters:{bendPa:2000}},expected:{sourcePath:"/native/cable.xml",cableMaterials:{wire:{bendPa:2000,twistPa:500}}}},
  {entityId:"elastic",components:{isaac:{sourcePath:"/native/soft.usda",materialOverrides:{"Materials/Elastic":{youngsModulusPa:20000,poissonsRatio:.35},"Materials/Other":{densityKgM3:800}}}},native:{engine:"isaac",kind:"deformable",nativeName:"Materials/Elastic",parameters:{youngsModulusPa:50000}},expected:{sourcePath:"/native/soft.usda",materialOverrides:{"Materials/Elastic":{youngsModulusPa:50000,poissonsRatio:.35},"Materials/Other":{densityKgM3:800}}}},
  {entityId:"fluid",components:{isaac:{sourcePath:"/native/fluid.usda",materialOverrides:{"Materials/Water":{densityKgM3:1000,viscosity:.01,friction:.2}}}},native:{engine:"isaac",kind:"pbd",nativeName:"Materials/Water",parameters:{viscosity:.02}},expected:{sourcePath:"/native/fluid.usda",materialOverrides:{"Materials/Water":{densityKgM3:1000,viscosity:.02,friction:.2}}}},
  {entityId:"water",components:{newton:{sourcePath:"/native/tank.xml",mpm:{kind:"water",gridType:"dense",dimensions:[3,3,3],spacingM:.03,densityKgM3:1000,viscosityPaS:.001,youngModulusPa:1e5,poissonRatio:.3,voxelSizeM:.06}}},native:{engine:"newton",kind:"mpm",nativeName:"water",parameters:{densityKgM3:1100},dimensions:[3,4,5]},expected:{sourcePath:"/native/tank.xml",mpm:{kind:"water",gridType:"dense",dimensions:[3,4,5],spacingM:.03,densityKgM3:1100,viscosityPaS:.001,youngModulusPa:1e5,poissonRatio:.3,voxelSizeM:.06}}},
 ]
 let scene=await operations.scene.commit({sceneId:"native",expectedRevision:created.revision,patch:cases.map(item=>({op:"add" as const,entity:{entityId:item.entityId,name:item.entityId,resources:[],transform:identityTransform(),components:{...structuredClone(opaque),...item.components}}}))})
 for(const item of cases){
  const before=structuredClone(scene)
  const result=await operations.updatePhysics({sceneId:"native",entityId:item.entityId,expectedRevision:scene.revision,native:item.native})
  expect(result.status).toBe("UPDATED");expect(result.worldNeedsSync).toBe(true)
  expect(result.native).toEqual(item.native);expect(result.snapshot.revision).toBe(scene.revision+1)
  const entity=result.snapshot.entities.find(row=>row.entityId===item.entityId)!
  expect(entity.components).toEqual({...opaque,[item.native.engine]:item.expected})
  expect(result.snapshot.entities.filter(row=>row.entityId!==item.entityId)).toEqual(before.entities.filter(row=>row.entityId!==item.entityId))
  scene=result.snapshot
 }
})

test("原生声明UNCHANGED不加版本，旧刚体拒绝/参数白名单/冲突仍保留",async()=>{
 const created=await operations.create({sceneId:"native"})
 const scene=await operations.scene.commit({sceneId:"native",expectedRevision:created.revision,patch:[{op:"add",entity:{entityId:"flex",name:"Flex",resources:[],transform:identityTransform(),components:{mujoco:{sourcePath:"/native/flex.xml",flexMaterials:{block:{youngPa:20000}}}}}}]})
 const native:NativePhysicsUpdate={engine:"mujoco",kind:"flex",nativeName:"block",parameters:{youngPa:20000}}
 const input={sceneId:"native",entityId:"flex",expectedRevision:scene.revision,native}
 const same=await operations.updatePhysics(input)
 expect(same.status).toBe("UNCHANGED");expect(same.worldNeedsSync).toBe(false);expect(same.snapshot).toEqual(scene)
 await expect(operations.updatePhysics({...input,expectedRevision:scene.revision-1})).rejects.toThrow(SceneConflict)
 await expect(operations.updatePhysics({...input,type:"static"})).rejects.toThrow("NATIVE_PARAMETER_INVALID")
 await expect(operations.updatePhysics({sceneId:"native",entityId:"flex",expectedRevision:scene.revision,type:"static"})).rejects.toThrow("PHYSICS_NATIVE_BODY_REQUIRED")
 const invalid:NativePhysicsUpdate[]=[
  {...native,parameters:{poisson:.5}}, {...native,parameters:{youngPa:0}}, {...native,parameters:{youngPa:NaN}},
  {...native,parameters:{viscosity:1}}, {...native,parameters:{}}, {...native,dimensions:[1,2,3]},
  {...native,engine:"isaac" as const},
 ]
 for(const change of invalid)await expect(operations.updatePhysics({...input,native:change})).rejects.toThrow("NATIVE_PARAMETER_INVALID")
 await expect(operations.updatePhysics({...input,native:{engine:"isaac",kind:"deformable",nativeName:"Materials/Elastic",parameters:{youngsModulusPa:20000}}})).rejects.toThrow("NATIVE_COMPONENT_REQUIRED")
 expect(await operations.scene.snapshot("native")).toEqual(scene)
 const read=operations.scene.snapshot.bind(operations.scene);let reads=0
 const racing=spyOn(operations.scene,"snapshot").mockImplementation(async sceneId=>{
  if(++reads===2)await operations.scene.commit({sceneId:"native",expectedRevision:scene.revision,patch:[{op:"update",entityId:"flex",changes:{name:"Concurrent edit"}}]})
  return read(sceneId)
 })
 try{await expect(operations.updatePhysics(input)).rejects.toThrow(SceneConflict)}finally{racing.mockRestore()}
})
