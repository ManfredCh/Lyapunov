import {expect,test} from 'bun:test'
import {Matrix4,Quaternion,Vector3} from 'three'
import {glbEntities} from '../src/formats.ts'
import {planPhysicsBinding,physicsBindingFacts} from '../src/physics-binding.ts'
import type {SceneSnapshot,Entity} from '../../lyapunov-contracts/src/types.ts'
const ref:any={resourceId:'source',version:1,original:{uri:'file:///fixture/box.glb',mimeType:'model/gltf-binary'},representations:[],source:{units:'m',upAxis:'Y',handedness:'right'}}
const record:any={ref,parsed:{kind:'mesh',metadata:{nodes:[{mesh:0}],scenes:[{nodes:[0]}],scene:0}},physicalization:{status:'ok',policy:'fixture'},componentDefaults:{collision:{shape:'box',halfExtents:[.5,.5,.5]},rigidBody:{type:'dynamic',massKg:1}}}
const matrix=(e:Entity,map:Map<string,Entity>):Matrix4=>{const t=e.transform,m=new Matrix4().compose(new Vector3(...t.position),new Quaternion(...t.quaternion),new Vector3(...t.scale));return e.parentId?matrix(map.get(e.parentId)!,map).multiply(m):m}
test('绑定只透传本版本已验证参考帧，不从latest资源推断或共享可变字段',()=>{
 const sourceFrame={pose:'reference',sourceUpAxis:'Y',metersPerUnit:1,derivedUnits:'m',derivedUpAxis:'Z',animation:{clips:2,evaluated:false,skinApplied:false}}
 const pinned={...record,physicalization:{status:'ok',usage:'environment',geometryTransport:{schema:'lyapunov.geometry.v2',version:2,verified:true,sourceFrame}}} as any
 const facts=physicsBindingFacts(pinned)
 expect(facts).toMatchObject({resourceId:'source',version:1,usage:'environment',sourceFrame})
 ;(facts.sourceFrame as any).animation.clips=99
 expect(sourceFrame.animation.clips).toBe(2)
 expect(physicsBindingFacts({...pinned,physicalization:{...pinned.physicalization,geometryTransport:{...pinned.physicalization.geometryTransport,verified:false}}}).sourceFrame).toBeUndefined()
 expect(physicsBindingFacts({...pinned,physicalization:{...pinned.physicalization,geometryTransport:{...pinned.physicalization.geometryTransport,verified:'yes'}}}).sourceFrame).toBeUndefined()
 expect(physicsBindingFacts({...pinned,ref:{...ref,version:2}}).version).toBe(2)
})
test('显式固定和几何绑定同patch，缺省保dynamic/质量/重力和其它用户组件，非法type零改动',()=>{
 const entities=glbEntities(ref,record.parsed,'placed','box');entities[0]!.components.rigidBody={type:'dynamic',massKg:3.5,gravityEnabled:false,customMaterial:'保留'}
 entities[0]!.components.annotation={note:'保留用户注释'}
 const scene:SceneSnapshot={sceneId:'s',revision:2,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities},before=structuredClone(scene)
 const source={...record,physicalization:{...record.physicalization,usage:'environment',strategy:'triangle_mesh'},componentDefaults:{...record.componentDefaults,rigidBody:{type:'static',massKg:2}}} as any
 const input={sceneId:'s',entityId:'placed',expectedRevision:2,usage:'environment' as const}
 const regular=planPhysicsBinding(scene,source,input),fixed=planPhysicsBinding(scene,source,{...input,type:'static'})
 const controls=(plan:ReturnType<typeof planPhysicsBinding>)=>plan.patch.find(p=>p.op==='update'&&p.entityId==='placed') as Extract<typeof plan.patch[number],{op:'update'}>
 expect(controls(regular).changes.components!.rigidBody).toMatchObject({type:'dynamic',massKg:3.5,gravityEnabled:false,customMaterial:'保留'})
 expect(controls(fixed).changes.components!.rigidBody).toMatchObject({type:'static',massKg:3.5,gravityEnabled:false,customMaterial:'保留'})
 expect(controls(fixed).changes.components!.collision).toEqual(source.componentDefaults.collision)
 expect(controls(fixed).changes.components!.annotation).toEqual({note:'保留用户注释'})
 expect(()=>planPhysicsBinding(scene,source,{...input,type:'kinematic' as any})).toThrow('PHYSICS_BODY_TYPE_INVALID')
 expect(scene).toEqual(before)
})
test('采样边界facts仅从同版本verified产物复制，未知secret/source路径不进入Scene consumer',()=>{
 const frame={pose:'reference',sourceUpAxis:'Y',metersPerUnit:1,derivedUnits:'m',derivedUpAxis:'Z'}
 const pointCloud={node:'points',sourceKind:'point_cloud',representation:'voxel_surface',processing:'full-spatial-voxel-surface',coverage:'full-measured-sample-voxel-boundary',consumerSupport:{isaac:'explicit-static-triangle-mesh-none',mujoco:'UNSUPPORTED_VOXEL_SURFACE'},coverageComplete:true,occupiedUnionVerified:true,sourcePoints:12,finitePoints:12,occupiedVoxels:5,manifestPath:'/private/source.json',unknownSecret:'不可公开'}
 const source={...record,physicalization:{status:'ok',usage:'environment',strategy:'triangle_mesh',geometryTransport:{schema:'lyapunov.geometry.v2',version:2,verified:true,sourceFrame:frame},pointCloud:[pointCloud]}} as any
 const facts=physicsBindingFacts(source)
 expect(facts).toMatchObject({resourceId:'source',version:1,usage:'environment',strategy:'triangle_mesh',pointCloud:[{processing:pointCloud.processing,coverage:pointCloud.coverage,coverageComplete:true,occupiedVoxels:5,sourceKind:'point_cloud',representation:'voxel_surface',consumerSupport:pointCloud.consumerSupport}]})
 expect(JSON.stringify(facts.pointCloud)).not.toContain('/private/');expect(JSON.stringify(facts.pointCloud)).not.toContain('不可公开')
 expect(physicsBindingFacts({...source,physicalization:{...source.physicalization,geometryTransport:{...source.physicalization.geometryTransport,verified:false}}}).pointCloud).toBeUndefined()
})
test('旧单mesh叶编辑吸收到根，全部可见世界矩阵不变，仍为同资源版本',()=>{
 const entities=glbEntities(ref,record.parsed,'placed','box');entities[2]!.transform.position=[.9528,.1811,-.0351]
 const other=structuredClone(entities);other.forEach(e=>{e.entityId+='-other';if(e.parentId)e.parentId+='-other'})
 const scene:SceneSnapshot={sceneId:'s',revision:19,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[...entities,...other]},before=matrix(entities[2]!,new Map(scene.entities.map(e=>[e.entityId,e])))
 const plan=planPhysicsBinding(scene,record,{sceneId:'s',entityId:entities[2]!.entityId,expectedRevision:19,usage:'dynamic'});expect(plan.normalized).toBe(true);expect(plan.maxMatrixDelta).toBeLessThan(1e-8)
 const changed=structuredClone(scene);for(const p of plan.patch)if(p.op==='update')Object.assign(changed.entities.find(e=>e.entityId===p.entityId)!,p.changes)
 const after=matrix(changed.entities[2]!,new Map(changed.entities.map(e=>[e.entityId,e])));after.elements.forEach((v,i)=>expect(v).toBeCloseTo(before.elements[i]!,10))
 expect(changed.entities[0]!.components.collision).toEqual(record.componentDefaults.collision);expect(changed.entities[2]!.resources[0]!.version).toBe(1);expect(changed.entities.slice(3)).toEqual(other)
})
test('已有用户collision、旧代次、无派生和多mesh实例明确拒绝，不覆写',()=>{
 const entities=glbEntities(ref,record.parsed,'placed','box'),s:SceneSnapshot={sceneId:'s',revision:2,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities},input={sceneId:'s',entityId:entities[2]!.entityId,expectedRevision:2}
 expect(()=>planPhysicsBinding(s,record,{...input,expectedRevision:1})).toThrow('SCENE_REVISION_MISMATCH')
 expect(()=>planPhysicsBinding(s,{...record,physicalization:{status:'failed'}},input)).toThrow('PHYSICS_DERIVATION_REQUIRED')
 entities[0]!.components.collision={shape:'box',halfExtents:[2,3,4]};expect(()=>planPhysicsBinding(s,record,input)).toThrow('PHYSICS_BIND_CUSTOMIZED');expect(entities[0]!.components.collision.halfExtents).toEqual([2,3,4])
 delete entities[0]!.components.collision;s.entities.push({...structuredClone(entities[2]!),entityId:'second'});expect(()=>planPhysicsBinding(s,record,input)).toThrow('PHYSICS_BIND_INSTANCE_LAYOUT_UNSUPPORTED')
})
test('完整多mesh共享根变换，真正绑定整资源，保持每个mesh可见世界矩阵',()=>{
 const multi={...record,parsed:{kind:'mesh',metadata:{nodes:[{mesh:0,translation:[.25,0,0]},{mesh:1,translation:[0,.5,.2]}],scenes:[{nodes:[0,1]}],scene:0}}} as any
 const entities=glbEntities(ref,multi.parsed,'multi','multi')
 entities[1]!.transform.position=[.2,.3,.4]
 const scene:SceneSnapshot={sceneId:'s',revision:2,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities},byId=new Map(entities.map(e=>[e.entityId,e]))
 const before=entities.slice(2).map(e=>matrix(e,byId))
 const plan=planPhysicsBinding(scene,multi,{sceneId:'s',entityId:entities[3]!.entityId,expectedRevision:2})
 expect(plan.rootEntityId).toBe('multi');expect(plan.normalized).toBe(true);expect(plan.maxMatrixDelta).toBeLessThan(1e-8)
 const after=structuredClone(scene)
 for(const p of plan.patch)if(p.op==='update')Object.assign(after.entities.find(e=>e.entityId===p.entityId)!,p.changes)
 const map=new Map(after.entities.map(e=>[e.entityId,e]))
 after.entities.slice(2).forEach((e,n)=>matrix(e,map).elements.forEach((v,i)=>expect(v).toBeCloseTo(before[n]!.elements[i]!,10)))
 expect(after.entities[0]!.components.collision).toEqual(record.componentDefaults.collision)
 expect(after.entities.slice(1).every(e=>!e.components.collision)).toBe(true)
})
test('多mesh独立叶改形不能覆盖整资源碰撞，完整原件布局仍可绑定',()=>{
 const multi={...record,parsed:{kind:'mesh',metadata:{nodes:[{mesh:0},{mesh:1,translation:[1,0,0]}],scenes:[{nodes:[0,1]}],scene:0}}} as any
 const entities=glbEntities(ref,multi.parsed,'multi','multi')
 const scene:SceneSnapshot={sceneId:'s',revision:2,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities}
 expect(planPhysicsBinding(scene,multi,{sceneId:'s',entityId:'multi',expectedRevision:2}).patch[0]!.op).toBe('update')
 entities[3]!.transform.position[1]=.4
 expect(()=>planPhysicsBinding(scene,multi,{sceneId:'s',entityId:'multi',expectedRevision:2})).toThrow('PHYSICS_BIND_INSTANCE_LAYOUT_UNSUPPORTED')
 expect(entities[0]!.components.collision).toBeUndefined()
})
test('显式splat真实派生可绑定，不隐式造盒或动态质量',()=>{
 const splat={...record,parsed:{kind:'splat',metadata:{}},physicalization:{status:'ok',usage:'environment'},componentDefaults:{collision:{shape:'box',shapes:[{center:[1,2,3],halfExtents:[.1,.1,.1]}]},rigidBody:{type:'static'}}} as any
 const scene:SceneSnapshot={sceneId:'s',revision:2,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[{entityId:'splat',name:'splat',transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[ref],components:{visual:{kind:'splat'}}}]}
 const plan=planPhysicsBinding(scene,splat,{sceneId:'s',entityId:'splat',expectedRevision:2})
 expect(plan.rootEntityId).toBe('splat')
 expect(plan.patch[0]!.op==='update'&&plan.patch[0]!.changes.components!.rigidBody).toEqual({type:'static'})
})
