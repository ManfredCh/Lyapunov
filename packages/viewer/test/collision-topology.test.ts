import {beforeAll,describe,expect,test} from "bun:test"
import {spawnSync} from "node:child_process"
import {existsSync} from "node:fs"
import {resolve} from "node:path"
import * as THREE from "three"
import {CollisionTopologyLayer,compiledColliderGeometry} from "../src/collision-topology.ts"
import {SceneViewer} from "../src/index.ts"
import {FrameProjection} from "../src/projection.ts"

test('CAS当前Scene30阻断world21的旧帧；新world同绑定首帧到达后恢复投影，重复步仍允许几何交付',()=>{
 const projection=new FrameProjection(),before:WorldHandle={worldId:'w',sceneId:'s',engineId:'mujoco',engineVersion:'fixture',worldGeneration:1,appliedSceneRevision:21,status:'ready'}
 const old:Frame={worldId:'w',generation:1,sceneRevision:21,frameId:'old',stepIndex:99,simTime:.198,entities:[]}
 projection.setWorld(before);projection.setScene({sceneId:'s',revision:21});expect(projection.push(old)).toBe(true)
 projection.setScene({sceneId:'s',revision:30});expect(projection.current()).toBeUndefined();expect(projection.acceptsBinding(old)).toBe(false);expect(projection.push({...old,stepIndex:100})).toBe(false)
 const after={...before,worldGeneration:2,appliedSceneRevision:30},fresh={...old,generation:2,sceneRevision:30,frameId:'fresh',stepIndex:0};projection.setWorld(after)
 expect(projection.push(fresh)).toBe(true);expect(projection.push(fresh)).toBe(false);expect(projection.acceptsBinding(fresh)).toBe(true);expect(projection.current()?.sceneRevision).toBe(30)
})
import {buildCollisionVisual} from "../src/collision.ts"
import type {CollisionTopology,Frame,SceneSnapshot,WorldHandle} from "../../lyapunov-contracts/src/types.ts"

const repo=resolve(import.meta.dir,"../../.."),python=process.env.LYAPUNOV_MUJOCO_PYTHON??resolve(repo,".runtime/sim-python/bin/python")
const suite=existsSync(python)?describe:describe.skip
type Fixture={scene:SceneSnapshot;handle:WorldHandle;topology:CollisionTopology;warm:CollisionTopology;moved:CollisionTopology;revised:CollisionTopology;mujocoVersion:string;patchScene:SceneSnapshot;patchHandle:WorldHandle;patchTopology:CollisionTopology;truth:Array<{geomId:number;kind:number;sizeM:number[];positionM:[number,number,number];matrix:number[];boundsM?:number[][]}>}
const bounds=(object:THREE.Object3D)=>{object.updateMatrixWorld(true);return new THREE.Box3().setFromObject(object,true)}
test('选中多层视觉叶显示真实physics owner形状，保视觉叶选择、隐藏与world/engine/rev/generation边界',()=>{
 const transform={position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]} as const
 const node=(id:string,parentId?:string,components:any={}):any=>({entityId:id,name:id,transform,resources:[],components,...parentId?{parentId}:{}})
 const scene:SceneSnapshot={sceneId:'s',revision:1,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[node('owner',undefined,{collision:{shape:'mesh'},rigidBody:{type:'dynamic'}}),node('branch','owner'),node('visual-leaf','branch',{visual:{kind:'mesh'}}),node('separate',undefined,{collision:{shape:'box'}})]}
 const w:WorldHandle={worldId:'w',sceneId:'s',worldGeneration:2,appliedSceneRevision:1,status:'paused',engineId:'mujoco',engineVersion:'fixture'}
 const topology:CollisionTopology={source:'mujoco-compiled',worldId:'w',generation:2,sceneRevision:1,stepIndex:3,omitted:0,geometryIncluded:true,geoms:[{geomId:5,name:'owner/actual-shape',entityId:'owner',ground:false,positionM:[.1,.2,.3],quaternionXyzw:[0,0,0,1],geometry:{kind:'box',sizeM:[.1,.2,.3]},collisionEnabled:true},{geomId:6,name:'separate/shape',entityId:'separate',ground:false,positionM:[1,2,3],quaternionXyzw:[0,0,0,1],geometry:{kind:'sphere',sizeM:[.4,0,0]}}]}
 const layer=new CollisionTopologyLayer();layer.setContext(scene,w,'visual-leaf',true);expect(layer.receive(topology)).toBe(true);expect(layer.status().geoms).toBe(1);expect(layer.root.children[0]?.userData.entityId).toBe('owner');expect(layer.root.children[0]?.position.toArray()).toEqual([.1,.2,.3])
 const hidden={...scene,entities:scene.entities.map(e=>e.entityId==='visual-leaf'?{...e,components:{visual:{kind:'mesh',visible:false}}}:e)}
 layer.setContext(hidden,w,'visual-leaf',true);expect(layer.receive(topology)).toBe(true);expect(layer.root.children[0]?.visible).toBe(false);expect(topology.geoms[0]?.collisionEnabled).toBe(true)
 layer.setContext(scene,w,'visual-leaf',false);expect(layer.status().status).toBe('disabled');expect(layer.root.visible).toBe(false)
 layer.setContext(scene,w,'visual-leaf',true);for(const wrong of [{...topology,source:'isaac-compiled' as const},{...topology,worldId:'other'},{...topology,generation:9},{...topology,sceneRevision:0}])expect(layer.receive(wrong)).toBe(false)
 layer.setContext({...scene,revision:2},w,'visual-leaf',true);expect(layer.receive(topology)).toBe(false);expect(layer.root.children).toHaveLength(0)
 const native={...scene,entities:scene.entities.map(e=>e.entityId==='owner'?{...e,components:{mujoco:{sourcePath:'/fixture/robot.xml'}}}:e.entityId==='visual-leaf'?{...e,components:{collision:{shape:'mesh'}}}:e)}
 layer.setContext(native,w,'visual-leaf',true);expect(layer.receive(topology)).toBe(true);expect(layer.root.children[0]?.userData.entityId).toBe('owner');layer.dispose()
})
test('Isaac物理Collider读回可选中直接显示，保留world/代次/版本和真实source；不接跨engine数据',()=>{
 const scene:SceneSnapshot={sceneId:'s',revision:1,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[{entityId:'cube',name:'方块',transform:{position:[0,0,.44],quaternion:[0,0,0,1],scale:[.04,.04,.04]},resources:[],components:{}}]}
 const w:WorldHandle={worldId:'w',sceneId:'s',worldGeneration:1,appliedSceneRevision:1,status:'ready',engineId:'isaac',engineVersion:'fixture'}
 const topology:CollisionTopology={source:'isaac-compiled',worldId:'w',generation:1,sceneRevision:1,stepIndex:2,omitted:0,geometryIncluded:true,geoms:[{geomId:0,name:'cube/geometry',entityId:'cube',ground:false,positionM:[0,0,.44],quaternionXyzw:[0,0,0,1],geometry:{kind:'box',sizeM:[.02,.02,.02]},collisionEnabled:true}]}
 const layer=new CollisionTopologyLayer();layer.setContext(scene,w,'cube',true);expect(layer.receive(topology)).toBe(true);expect(layer.status().status).toBe('ready');expect(bounds(layer.root.children[0]!).getSize(new THREE.Vector3()).x).toBeCloseTo(.04,6)
 expect(layer.receive({...topology,source:'mujoco-compiled'})).toBe(false);expect(layer.receive({...topology,generation:2})).toBe(false);expect(layer.receive({...topology,sceneRevision:0})).toBe(false);layer.dispose()
})

suite("真 MuJoCo 编译碰撞几何 → Three 世界米制线框",()=>{
 let f:Fixture
 beforeAll(()=>{
  const result=spawnSync(python,[resolve(repo,"packages/sim-mujoco/test/collision_topology_check.py"),resolve(repo,"packages/sim-mujoco/python/worker.py"),resolve(repo,"materials/robots/franka_panda/franka_emika_panda/panda.xml")],{encoding:"utf8",env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"},timeout:20000,maxBuffer:8*1024*1024})
  expect(result.error).toBeUndefined();expect(result.status,result.stderr).toBe(0);f=JSON.parse(result.stdout)
 })
 test("0.06m cube、2×1.5×0.04m floor 不重复乘实体scale，球/胶囊/柱/椭球读取实际尺寸",()=>{
  const layer=new CollisionTopologyLayer();layer.setContext(f.scene,f.handle,"cube",true);expect(layer.receive(f.topology)).toBe(true)
  const cube=layer.root.children.find(o=>o.userData.entityId==="cube")!
  expect(bounds(cube).getSize(new THREE.Vector3()).toArray()).toEqual([expect.closeTo(.06,6),expect.closeTo(.06,6),expect.closeTo(.06,6)])
  expect(cube.position.toArray()).toEqual([.1,.2,.75]);expect(cube.scale.toArray()).toEqual([1,1,1]);expect(layer.status().geoms).toBe(1)
  for(const [id,size]of [["floor",[2,1.5,.04]],["capsule",[.08,.08,.32]],["cylinder",[.1,.1,.3]],["sphere",[.14,.14,.14]],["ellipsoid",[.14,.28,.42]]] as const){
   layer.setContext(f.scene,f.handle,id,true);expect(layer.receive(f.topology)).toBe(true)
   const object=layer.root.children.find(o=>o.userData.entityId===id)!
   const actual=bounds(object).getSize(new THREE.Vector3()).toArray();actual.forEach((value,i)=>expect(value).toBeCloseTo(size[i]!,5))
  }
  // 显式兼容 ground:true 现编译为有限盒，独立 model.geom_type/size 见证不能继续假定无限平面。
  const ground=f.topology.geoms.find(g=>g.name==="__ground")!,nativeGround=f.truth.find(row=>row.geomId===ground.geomId)!
  expect(nativeGround.kind).toBe(6) // mjGEOM_BOX；读取真 model，不以拓扑自身作为类型见证。
  expect(nativeGround.sizeM).toEqual([50,50,.05])
  expect(ground).toMatchObject({ground:true,positionM:[0,0,-.05],geometry:{kind:"box",sizeM:nativeGround.sizeM}})
  const groundObject=layer.root.children.find(o=>o.userData.geomId===ground.geomId)!
  expect(groundObject.position.toArray()).toEqual(nativeGround.positionM);expect(groundObject.scale.toArray()).toEqual([1,1,1])
  expect(bounds(groundObject).getSize(new THREE.Vector3()).toArray()).toEqual([expect.closeTo(100,6),expect.closeTo(100,6),expect.closeTo(.1,6)])
  expect(layer.status().infinitePlanes).toBe(0);layer.dispose()
 })
 test("Panda 使用编译凸包面和 geom_xpos/xmat，几何世界边界与真实 mesh 顶点独立读数相同",()=>{
  const layer=new CollisionTopologyLayer();layer.setContext(f.scene,f.handle,"arm",true);expect(layer.receive(f.topology)).toBe(true)
  const arm=layer.root.children.filter(o=>o.userData.entityId==="arm");expect(arm.length).toBeGreaterThan(8)
  let hulls=0
  for(const object of arm){
   const truth=f.truth.find(row=>row.geomId===object.userData.geomId)!
   expect(object.position.toArray()).toEqual(truth.positionM)
   const rotation=new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(object.quaternion)).elements
   // MuJoCo 矩阵是 row-major，Three Matrix3.elements 是 column-major。
   rotation.forEach((value,i)=>expect(value).toBeCloseTo(truth.matrix[(i%3)*3+Math.floor(i/3)]!,10))
   if(truth.boundsM){hulls++;const box=bounds(object);box.min.toArray().forEach((v,i)=>expect(v).toBeCloseTo(truth.boundsM![0]![i]!,6));box.max.toArray().forEach((v,i)=>expect(v).toBeCloseTo(truth.boundsM![1]![i]!,6));expect(object.userData.kind).toBe("convex-hull")}
  }
  expect(hulls).toBeGreaterThan(8)
  const objects=[...layer.root.children];expect(layer.receive(f.warm)).toBe(true);expect(layer.root.children).toEqual(objects)
  expect(layer.receive(f.moved)).toBe(true);expect(layer.root.children.some((o,i)=>o.position.distanceTo(new THREE.Vector3(...f.topology.geoms.find(g=>g.geomId===o.userData.geomId)!.positionM))>1e-6)).toBe(true)
  layer.dispose()
 })
 test("选中、父层隐藏、图层恢复、旧场景revision/旧world generation 都不残留错属凸包",()=>{
  const layer=new CollisionTopologyLayer(),parent={...f.scene.entities[0]!,entityId:"container",resources:[],components:{visual:{visible:false}}}
  const hidden={...f.scene,entities:[parent,...f.scene.entities.map(e=>e.entityId==="arm"?{...e,parentId:"container"}:e)]}
  layer.setContext(hidden,f.handle,"container",true);expect(layer.receive(f.topology)).toBe(true)
  expect(layer.root.children.filter(o=>o.userData.entityId==="arm").every(o=>!o.visible)).toBe(true)
  layer.setContext({...hidden,entities:hidden.entities.map(e=>e.entityId==="container"?{...e,components:{visual:{visible:true}}}:e)},f.handle,"container",true)
  expect(layer.root.children.filter(o=>o.userData.entityId==="arm").every(o=>o.visible)).toBe(true)
  layer.setContext(f.scene,f.handle,"cube",true);expect(layer.root.children.length).toBe(0);expect(layer.receive(f.topology)).toBe(true)
  expect(layer.root.children.every(o=>o.userData.ground||o.userData.entityId==="cube")).toBe(true)
  layer.setContext(f.scene,{...f.handle,worldGeneration:2},"cube",true);expect(layer.root.children.length).toBe(0);expect(layer.receive(f.topology)).toBe(false)
  layer.setContext({...f.scene,revision:8},f.handle,"cube",true);expect(layer.status().status).toBe("stale-world");expect(layer.receive(f.topology)).toBe(false)
  layer.setContext(f.scene,f.handle,"visual-only",true);expect(layer.receive(f.topology)).toBe(true);expect(layer.status().status).toBe("no-collider")
  layer.setContext(f.scene,{...f.handle,status:"closed"},"visual-only",true);expect(layer.root.children.length).toBe(0)
  layer.setContext(f.scene,undefined,"cube",true);expect(layer.status().status).toBe("no-world");expect(layer.root.children.length).toBe(0)
  layer.dispose()
 })
 test("可信场景碰撞绑定保留明确实例归属，实际墙盒显示、hfield缺拓扑明确而非假bbox",()=>{
  const layer=new CollisionTopologyLayer();layer.setContext(f.patchScene,f.patchHandle,"room",true);expect(layer.receive(f.patchTopology)).toBe(true)
  expect(layer.status().geoms).toBe(3);expect(layer.status().unsupported).toBe(1);expect(layer.root.children.length).toBe(2)
  const wall=layer.root.children.find(o=>o.userData.kind==="box")!
  expect(wall.position.toArray()).toEqual([.3,.4,.5]);expect(bounds(wall).getSize(new THREE.Vector3()).toArray()).toEqual([expect.closeTo(.2,6),expect.closeTo(.4,6),expect.closeTo(.6,6)])
  layer.dispose()
 })
 test("暂停同一步号允许改变碰撞选择，运动投影不复制凸包；选择/开关不加载视觉资源",async()=>{
  const value=Object.create(SceneViewer.prototype) as any
  value.scene=new THREE.Scene();value.snapshot=f.scene;value.world=f.handle;value.objects=new Map();value.projection=new FrameProjection();value.projection.setWorld(f.handle);value.options={};value.transformControls={detach:()=>{}};value.display={collision:true}
  let loads=0;value.loadVisual=()=>{loads++;throw new Error("选择不得读原件")}
  value.select("cube")
  const frame={worldId:f.topology.worldId,generation:f.topology.generation,sceneRevision:f.topology.sceneRevision,stepIndex:0,simTime:0,frameId:"fixture",entities:[],collisionTopology:f.topology} as Frame
  expect(value.pushFrame(frame)).toBe(true);expect(value.projection.current().collisionTopology).toBeUndefined();expect(value.collisionStatus().geoms).toBe(1)
  value.select("arm");expect(value.pushFrame(frame)).toBe(false);expect(value.collisionStatus().geoms).toBeGreaterThan(8);expect(loads).toBe(0)
  value.collisionTopologyLayer.dispose()
 })
})

describe("缺项不伪造碰撞体或源坐标",()=>{
 test("unsupported 与未知声明不回退成box，缺Source失败可定位",()=>{
  expect(compiledColliderGeometry({kind:"unsupported",sizeM:[1,1,1],reason:"no shape"})).toBeUndefined()
  expect(buildCollisionVisual({components:{collision:{shape:"mesh",halfExtents:[1,1,1]}}} as any)).toBeUndefined()
  const value=Object.create(SceneViewer.prototype) as any
  expect(()=>value.wrapSourceCoordinates({resourceId:"missing-source"},{},new THREE.Group())).toThrow("VIEWER_RESOURCE_SOURCE_REQUIRED")
 })
})
