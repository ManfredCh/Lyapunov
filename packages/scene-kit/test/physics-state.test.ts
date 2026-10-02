import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SceneOperations } from "../src/operations.ts"
import { planPhysicsUpdate } from "../src/physics-state.ts"
import {SceneConflict} from "../src/store.ts"
import { identityTransform } from "../../lyapunov-contracts/src/types.ts"
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
