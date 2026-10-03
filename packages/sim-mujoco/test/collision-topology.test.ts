import {describe,test} from "node:test"
import assert from "node:assert/strict"
import {existsSync} from "node:fs"
import {resolve,dirname} from "node:path"
import {fileURLToPath} from "node:url"
import {MuJoCoProvider} from "../src/provider.ts"
import {identityTransform,SCENE_COORDINATES,type SceneSnapshot} from "../../lyapunov-contracts/src/types.ts"
import {collisionFrameSelection} from "../../lyapunov-shell/src/collision-frame-request.ts"

const root=resolve(dirname(fileURLToPath(import.meta.url)),"../../..")
const python=process.env.LYAPUNOV_MUJOCO_PYTHON??resolve(root,".runtime/sim-python/bin/python")
const suite=existsSync(python)?describe:describe.skip
suite("真实 NDJSON worker 碰撞观察只读合同",()=>{
 test('初始真实BOX包含、部分相交、轻触、分离与父层变换使用同compiled几何，step0不靠solver分开',async()=>{
  const provider=new MuJoCoProvider({pythonPath:python,workerPath:resolve(root,'packages/sim-mujoco/python/worker.py')})
  const box=(entityId:string,half:number[],position:number[],extra:Record<string,unknown>={}):SceneSnapshot['entities'][number]=>({entityId,name:entityId,transform:{...identityTransform(),position:position as [number,number,number]},resources:[],components:{rigidBody:{type:'static'},collision:{shape:'box',halfExtents:half},...extra}})
  const center:[number,number,number]=[.65,0,.15],outer=box('outer',[.45,.45,.15],center),inner=box('inner',[.12,.08,.1],center)
  const cases:Array<{name:string;entities:SceneSnapshot['entities'];status:'OVERLAP'|'CLEAR'|'UNVERIFIED';depth?:number}>=[
   {name:'fully-contained-static',entities:[outer,inner],status:'OVERLAP',depth:.25},
   {name:'fully-contained-dynamic',entities:[outer,{...inner,components:{...inner.components,rigidBody:{type:'dynamic',massKg:1}}}],status:'OVERLAP',depth:.25},
   {name:'partial-overlap',entities:[outer,{...inner,transform:{...inner.transform,position:[1.2,0,.15]}}],status:'OVERLAP',depth:.02},
   {name:'touch-only',entities:[outer,{...inner,transform:{...inner.transform,position:[1.22,0,.15]}}],status:'CLEAR'},
   {name:'separated',entities:[outer,{...inner,transform:{...inner.transform,position:[1.25,0,.15]}}],status:'CLEAR'},
   {name:'disabled',entities:[outer,{...inner,components:{...inner.components,collision:{...inner.components.collision,enabled:false}}}],status:'CLEAR'},
   {name:'rotated-contained',entities:[outer,{...inner,transform:{...inner.transform,quaternion:[0,0,.5,Math.sqrt(.75)]}}],status:'OVERLAP',depth:.25},
   {name:'rotated-disjoint-with-overlapping-aabbs',entities:[{...box('outer',[.3,.03,.04],[0,0,.2]),transform:{...identityTransform(),position:[0,0,.2],quaternion:[0,0,Math.sin(Math.PI/8),Math.cos(Math.PI/8)]}},{...box('inner',[.3,.03,.04],[-.08*Math.SQRT1_2,.08*Math.SQRT1_2,.2]),transform:{...identityTransform(),position:[-.08*Math.SQRT1_2,.08*Math.SQRT1_2,.2],quaternion:[0,0,Math.sin(Math.PI/8),Math.cos(Math.PI/8)]}}],status:'CLEAR'},
   {name:'parent-scale-and-rotation',entities:[{entityId:'carrier',name:'carrier',resources:[],components:{},transform:{position:[0,0,0],quaternion:[0,0,.5,Math.sqrt(.75)],scale:[2,.5,1.4]}},{...outer,parentId:'carrier'},{...inner,parentId:'carrier'}],status:'OVERLAP',depth:.265},
   {name:'sphere-in-box',entities:[outer,box('inner',[.05,.05,.05],center,{collision:{shape:'sphere',halfExtents:[.05,.05,.05]}})],status:'OVERLAP',depth:.2},
   {name:'sphere-in-sphere',entities:[box('outer',[.3,.3,.3],center,{collision:{shape:'sphere',halfExtents:[.3,.3,.3]}}),box('inner',[.1,.1,.1],center,{collision:{shape:'sphere',halfExtents:[.1,.1,.1]}})],status:'OVERLAP',depth:.4},
  ]
  try{
   for(const [index,item] of cases.entries()){
    const scene:SceneSnapshot={sceneId:'initial-overlap-'+item.name,revision:index+1,coordinates:SCENE_COORDINATES,entities:structuredClone(item.entities)},handle=await provider.open(scene,{clock:'manual',ground:false})
    const frame=await provider.observe(handle.worldId,{contacts:true,collisionTopology:{entityIds:['outer','inner'],includeGeometry:true}}),report=frame.initialOverlap!
    assert.equal(frame.stepIndex,0,item.name);assert.equal(frame.simTime,0,item.name);assert.equal(frame.generation,handle.worldGeneration);assert.equal(frame.sceneRevision,scene.revision);assert.equal(report.checkedAtStep,0);assert.equal(report.sceneRevision,scene.revision);assert.equal(report.source,'mujoco-compiled');assert.equal(report.status,item.status,item.name)
    if(item.depth!==undefined){const pair=report.pairs.find(p=>[p.entity1,p.entity2].includes('outer')&&[p.entity1,p.entity2].includes('inner'))!;assert.ok(pair,item.name);assert.ok(Math.abs(pair.depthM!-item.depth)<1e-8,item.name+': '+pair.depthM);assert.ok(handle.warnings?.some(w=>w.code==='INITIAL_OVERLAP'))}
    else assert.equal(report.pairs.length,0,item.name)
    assert.equal(frame.collisionTopology!.sceneRevision,scene.revision);assert.equal(frame.collisionTopology!.generation,handle.worldGeneration);await provider.close(handle.worldId)
   }
  }finally{await provider.dispose()}
 })
 test('零原生距离的其它convex不能报CLEAR，互斥mask保留实际无碰撞语义',async()=>{
  const provider=new MuJoCoProvider({pythonPath:python,workerPath:resolve(root,'packages/sim-mujoco/python/worker.py')})
  const native=(id:string,size:string,kind='ellipsoid',mask='1'):SceneSnapshot['entities'][number]=>({entityId:id,name:id,transform:identityTransform(),resources:[],components:{mujoco:{xml:`<mujoco><worldbody><geom name="shape" type="${kind}" size="${size}" contype="${mask}" conaffinity="${mask==='1'?'1':'0'}"/></worldbody></mujoco>`}}})
  try{
   let scene:SceneSnapshot={sceneId:'initial-overlap-unresolved',revision:71,coordinates:SCENE_COORDINATES,entities:[native('outer','.3 .2 .1'),native('inner','.1 .05 .04')]},handle=await provider.open(scene,{clock:'manual',ground:false}),frame=await provider.observe(handle.worldId,{collisionTopology:{entityIds:['outer','inner'],includeGeometry:true}})
   assert.equal(frame.stepIndex,0);assert.equal(frame.initialOverlap!.status,'UNVERIFIED');assert.equal(frame.initialOverlap!.pairs.length,0);assert.ok(frame.initialOverlap!.reason?.includes('距离零或未支持'));assert.ok(handle.warnings?.some(w=>w.code==='INITIAL_OVERLAP_UNVERIFIED'));assert.ok(frame.collisionTopology!.geoms.every(g=>g.geometry!.kind==='ellipsoid'));await provider.close(handle.worldId)
   scene={...scene,sceneId:'initial-overlap-mask-excluded',revision:72,entities:[native('outer','.3 .2 .1','box','2'),native('inner','.1 .05 .04','box','4')]};handle=await provider.open(scene,{clock:'manual',ground:false});frame=await provider.observe(handle.worldId,{contacts:true})
   assert.equal(frame.stepIndex,0);assert.equal(frame.initialOverlap!.status,'CLEAR');assert.equal(frame.initialOverlap!.pairs.length,0);assert.equal(frame.contacts!.length,0);await provider.close(handle.worldId)
  }finally{await provider.dispose()}
 })
 test("当前world、revision、选择过滤与首静态几何/后位姿复用经过实际 RPC",async()=>{
  const provider=new MuJoCoProvider({pythonPath:python,workerPath:resolve(root,"packages/sim-mujoco/python/worker.py")})
  const scene:SceneSnapshot={sceneId:"rpc-collision",revision:1,coordinates:SCENE_COORDINATES,entities:[
   {entityId:"cube",name:"cube",transform:{...identityTransform(),position:[.1,.2,.75],scale:[.06,.06,.06]},resources:[],components:{collision:{shape:"box",halfExtents:[.5,.5,.5]}}},
   {entityId:"no-collider",name:"visual",transform:identityTransform(),resources:[],components:{visual:{kind:"mesh"}}},
  ]}
  try{
   let handle=await provider.open(scene,{clock:"manual"})
   assert.equal((await provider.observe(handle.worldId)).collisionTopology,undefined)
   const query=new URLSearchParams({collisionTopology:"1",collisionGeometry:"1"});query.append("collisionEntityId","cube")
   const full=await provider.observe(handle.worldId,collisionFrameSelection(query));assert.ok(full.collisionTopology)
   assert.equal(full.collisionTopology.worldId,handle.worldId);assert.equal(full.collisionTopology.generation,handle.worldGeneration);assert.equal(full.collisionTopology.sceneRevision,scene.revision)
   const cube=full.collisionTopology.geoms.find(g=>g.entityId==="cube")!
   assert.deepEqual(cube.geometry?.sizeM,[.03,.03,.03]);assert.deepEqual(cube.positionM,[.1,.2,.75])
   query.set("collisionGeometry","0")
   const warm=await provider.observe(handle.worldId,collisionFrameSelection(query));assert.equal(warm.collisionTopology?.geometryIncluded,false);assert.equal(warm.stepIndex,full.stepIndex)
   assert.ok(warm.collisionTopology?.geoms.every(g=>!g.geometry));assert.deepEqual(warm.collisionTopology?.geoms.find(g=>g.entityId==="cube")?.positionM,cube.positionM)
   query.set("collisionEntityId","no-collider");const empty=await provider.observe(handle.worldId,collisionFrameSelection(query));assert.ok(empty.collisionTopology?.geoms.every(g=>g.ground))
   handle=await provider.sync(handle.worldId,{...scene,revision:2});query.set("collisionEntityId","cube");query.set("collisionGeometry","1")
   const revised=await provider.observe(handle.worldId,collisionFrameSelection(query));assert.equal(revised.collisionTopology?.sceneRevision,2);assert.equal(revised.collisionTopology?.generation,handle.worldGeneration)
   await provider.close(handle.worldId)
  }finally{await provider.dispose()}
 })
})
