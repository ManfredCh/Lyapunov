/** 显式原生Isaac CPU/none验收；需要已有SDK与其既有许可确认，不安装或修改全局配置。 */
import {execFileSync} from 'node:child_process'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve,join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
import {SceneOperations} from '../../packages/scene-kit/src/operations.ts'
import {usdPython,setUsdInstance} from '../../packages/scene-kit/src/usd-assets.ts'
import {fileStamp} from '../../packages/scene-kit/src/formats.ts'
import * as THREE from 'three'
import {buildUsdVisual,applyUsdBodyWorldPoses} from '../../packages/viewer/src/usd-visual.ts'
import {IsaacProvider,isaacLoaderEnvironment} from '../../packages/sim-isaac/src/provider.ts'
import {resolveSdkPython} from '../../packages/lyapunov-product-bundle/src/sdk-python.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),args=process.argv.slice(2),arg=(flag:string)=>args[args.indexOf(flag)+1]
const out=resolve(args.includes('--out')?arg('--out'):join(root,'.runtime/usd-isaac-'+Date.now()))
await mkdir(out,{recursive:true})
const python=args.includes('--isaac-python')?resolve(arg('--isaac-python')):resolveSdkPython(root,'isaac').python
const receipt:Record<string,any>={status:'PARTIAL',startedAt:new Date().toISOString(),sourceSha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),worktreeStatus:execFileSync('git',['status','--short'],{cwd:root,encoding:'utf8'}).trim(),out,python,physicsDevice:'cpu',rendering:'none',checks:{}}
let provider:IsaacProvider|undefined
const check=(name:string,passed:boolean,evidence:unknown)=>{receipt.checks[name]={passed,evidence};if(!passed)throw Error('USD_ISAAC_CHECK_FAILED: '+name)}
try {
 execFileSync(usdPython(),[join(root,'packages/scene-kit/test/fixtures/usd/make_fixture.py'),join(out,'source')])
 const sourcePath=join(out,'source/prop.usda'),sha=(await fileStamp(sourcePath)).sha256
 const ops=new SceneOperations(join(out,'catalog'));await ops.create({sceneId:'usd-native'})
 const prop=await ops.import({path:sourcePath,sceneId:'usd-native',entityId:'prop-a',physicalize:false,transform:{position:[3,0,.1],quaternion:[0,0,0,1],scale:[1,1,1]},alignBottomToSurface:false})
 await ops.mount({sceneId:'usd-native',resourceId:prop.resource.ref.resourceId,entityId:'prop-b',transform:{position:[5,0,.6],quaternion:[0,0,0,1],scale:[1,1,1]},alignBottomToSurface:false})
 let scene=await ops.scene.snapshot('usd-native')
 await setUsdInstance(ops,{sceneId:'usd-native',entityId:'prop-b',expectedRevision:scene.revision,variants:{'/Prop':{shape:'large'}}})
 await ops.import({path:join(out,'source/joint.usda'),sceneId:'usd-native',entityId:'joint-asset',physicalize:false})
 scene=await ops.scene.snapshot('usd-native')
 // 原prop夹具是静态碰撞体；另加明确1kg落体才构成contacts正对照，不修改源USD。
 scene=await ops.scene.commit({sceneId:scene.sceneId,expectedRevision:scene.revision,patch:[{op:'add',entity:{entityId:'contact-probe',name:'原生接触正对照',transform:{position:[8,0,1],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{collision:{shape:'box',halfExtents:[.1,.1,.1]},rigidBody:{type:'dynamic',massKg:1}}}}]});receipt.scene=scene
 await ops.save('usd-native',join(out,'portable/scene.json'),{portable:true})
 provider=new IsaacProvider({pythonPath:python,workerPath:join(root,'packages/sim-isaac/python/worker.py'),cacheRoot:join(out,'isaac-cache'),physicsDevice:'cpu',rendering:'none',startupBudgetMs:90000})
 const world=await provider.open(scene,{worldId:'usd-native-check',clock:'manual',ground:true});receipt.world=world
 const ids=['prop-a','prop-b','joint-asset']
 const initial=await provider.observe(world.worldId,{contacts:true,sensors:true,collisionTopology:{entityIds:ids,includeGeometry:true}});receipt.initial=initial
 const geoms=initial.collisionTopology?.geoms??[],a=geoms.find(row=>row.entityId==='prop-a'),b=geoms.find(row=>row.entityId==='prop-b')
 check('native-collision-coverage',world.worldPhysics?.collisionCoverage.status==='COMPLETE',world.worldPhysics?.collisionCoverage)
 check('source-root-plus-instance',!!a&&Math.abs(a.positionM[2]-.6)<1e-5,a)
 check('independent-native-variant',!!a&&!!b&&a.geometry?.kind==='box'&&b.geometry?.kind==='box'&&Math.abs(a.geometry.sizeM[0]-.5)<1e-6&&Math.abs(b.geometry.sizeM[0]-1)<1e-6,{a,b})
 check('native-source-prim-mapping',a?.sourcePrimPath==='/Prop/Cube'&&b?.sourcePrimPath==='/Prop/Cube'&&a.runtimePrimPath!==b.runtimePrimPath,{a,b})
 const description=await provider.describe(world.worldId,'joint-asset');receipt.description=description
 check('native-joint-and-drive-readback',description.controlledJointNames.includes('Hinge')&&description.joints.some(row=>row.name==='Hinge'&&(row.driveStiffness??0)>0),description)
 receipt.action=await provider.execute(world.worldId,{actionId:'usd-hinge-control',expectedGeneration:world.worldGeneration,kind:'control',entityId:'joint-asset',jointNames:['Hinge'],positions:[.3],stepCount:500})
 const final=await provider.observe(world.worldId,{contacts:true,sensors:true,collisionTopology:{entityIds:ids,includeGeometry:false}});receipt.final=final
 const jointEntity=scene.entities.find(row=>row.entityId==='joint-asset')!
 const previewRef=jointEntity.resources.find(row=>row.original.mimeType==='application/vnd.lyapunov.usd-preview+json')!
 const payload=JSON.parse(await readFile(fileURLToPath(previewRef.original.uri),'utf8'))
 const group=new THREE.Group(),visual=buildUsdVisual(payload.preview);group.add(visual)
 const shape=visual.getObjectByName('/Robot/Link/Cube')!
 const project=(frame:typeof final)=>{const entity=frame.entities.find(row=>row.entityId==='joint-asset')!;group.position.fromArray(entity.transform.position);group.quaternion.fromArray(entity.transform.quaternion);group.scale.fromArray(entity.transform.scale);const update=applyUsdBodyWorldPoses(visual,entity.sensors?.usdBodyWorldPoses);return {position:shape.getWorldPosition(new THREE.Vector3()).toArray(),update}}
 const beforeVisual=project(initial),afterVisual=project(final)
 const physical=final.collisionTopology?.geoms.find(row=>row.entityId==='joint-asset'&&row.sourcePrimPath==='/Robot/Link/Cube')
 check('viewer-native-body-follow',!!physical&&afterVisual.update.applied===2&&afterVisual.position.every((value,index)=>Math.abs(value-physical.positionM[index]!)<1e-5)&&Math.hypot(...afterVisual.position.map((value,index)=>value-beforeVisual.position[index]!))>.05,{beforeVisual,afterVisual,physical})
 const joint=final.entities.find(row=>row.entityId==='joint-asset')?.joints
 check('native-physical-control',receipt.action.status==='completed'&&final.stepIndex>=500&&!!joint&&Math.abs(joint.positions[joint.names.indexOf('Hinge')]!-.3)<.03,{receipt:receipt.action,joint,stepIndex:final.stepIndex})
 check('native-contacts-retained',(final.contacts?.length??0)>0&&final.contacts!.every(contact=>contact.forceN?.every(Number.isFinite)),{contacts:final.contacts})
 check('source-original-unchanged',(await fileStamp(sourcePath)).sha256===sha,{before:sha,after:(await fileStamp(sourcePath)).sha256})
 await provider.dispose();provider=undefined;receipt.closed=true
 const queryRoot=join(out,'convex-plane'),queryScript=join(queryRoot,'probe.py'),invocation=randomUUID();await mkdir(queryRoot,{recursive:true})
 await writeFile(queryScript,String.raw`"""真实CPU/none同World凸包/Plane回归，不tick，不重建审计替身。"""
import sys,json,copy,hashlib
from pathlib import Path
root=Path(sys.argv[1]);out=Path(sys.argv[2]);invocation=sys.argv[3]
worker=root/'packages/sim-isaac/python/worker.py';sys.path.insert(0,str(worker.parent));ns={'__file__':str(worker),'__name__':'convex_plane_native_gate'};exec(compile(worker.read_text().split(chr(10)+'requests=queue.Queue()')[0],str(worker),'exec'),ns);ns['emit']=lambda event:None
report={'status':'PARTIAL','invocationId':invocation,'cases':[],'explicitWorldTicks':0};world=None
try:
 from pxr import Usd,UsdGeom,UsdPhysics,Gf
 from initial_overlap import initial_overlap
 vertices=[(-.5,-.5,-.5),(.5,-.5,-.5),(.5,.5,-.5),(-.5,.5,-.5),(-.5,-.5,.5),(.5,-.5,.5),(.5,.5,.5),(-.5,.5,.5)]
 faces=[0,3,2,1,4,5,6,7,0,1,5,4,3,7,6,2,0,4,7,3,1,2,6,5]
 def fixture(name,approximation):
  path=out/name;s=Usd.Stage.CreateNew(str(path));p=UsdGeom.Xform.Define(s,'/Static');s.SetDefaultPrim(p.GetPrim());UsdGeom.SetStageMetersPerUnit(s,1);UsdGeom.SetStageUpAxis(s,'Z');m=UsdGeom.Mesh.Define(s,'/Static/Mesh')
  if approximation=='convexHull':points=vertices;indices=faces;counts=[4]*6
  else:
   points=[];indices=[];counts=[]
   for centre,scale in [((-.4,0,0),(.2,1,1)),((.4,0,0),(.2,1,1)),((0,0,-.4),(.6,1,.2))]:
    base=len(points);points.extend(tuple(v[i]*scale[i]+centre[i]for i in range(3))for v in vertices);indices.extend(base+i for i in faces);counts.extend([4]*6)
  m.CreatePointsAttr(points);m.CreateFaceVertexCountsAttr(counts);m.CreateFaceVertexIndicesAttr(indices);m.CreateSubdivisionSchemeAttr('none');UsdPhysics.CollisionAPI.Apply(m.GetPrim());UsdPhysics.MeshCollisionAPI.Apply(m.GetPrim()).CreateApproximationAttr(approximation);s.GetRootLayer().Save();return str(path)
 convex=fixture('convex.usda','convexHull');concave=fixture('concave.usda','none');source_hashes={p:hashlib.sha256(Path(p).read_bytes()).hexdigest()for p in [convex,concave]}
 identity=[0,0,0,1]
 def rotation(axis,degrees):
  q=Gf.Rotation(Gf.Vec3d(*axis),degrees).GetQuat();return [*q.GetImaginary(),float(q.GetReal())]
 tilted=rotation((1,1,0),35);spun=rotation((1,2,3),27);reversed_plane=rotation((1,0,0),180)
 cases=[('separated',.02,'CLEAR',identity,identity,[1,1,1]),('touching',0,'UNVERIFIED',identity,identity,[1,1,1]),('near-positive',5e-8,'UNVERIFIED',identity,identity,[1,1,1]),('near-negative',-5e-8,'UNVERIFIED',identity,identity,[1,1,1]),('small-penetration',-.0001,'OVERLAP',identity,identity,[1,1,1]),('large-penetration',-.05,'OVERLAP',identity,identity,[1,1,1]),('tilted-rotated-scaled',.03,'CLEAR',tilted,spun,[2,.7,1.3]),('tilted-penetration',-.015,'OVERLAP',tilted,spun,[2,.7,1.3]),('reversed-separated',.02,'CLEAR',reversed_plane,spun,[.6,1.4,1.2]),('reversed-penetration',-.01,'OVERLAP',reversed_plane,spun,[.6,1.4,1.2]),('concave-unsupported',.02,'UNVERIFIED',identity,identity,[1,1,1]),('ownership-uncovered',.02,'UNVERIFIED',identity,identity,[1,1,1])]
 for index,(name,gap,expected,pq,sq,scale)in enumerate(cases):
  pm=ns['World']._matrix_from_pose(None,[0,0,0],pq);sm=ns['World']._matrix_from_pose(None,[0,0,0],sq);normal=pm.TransformDir(Gf.Vec3d(0,0,1));minimum=min(normal.GetDot(sm.TransformDir(Gf.Vec3d(*(v[i]*scale[i]for i in range(3)))))for v in vertices);centre=normal*(gap-minimum)
  scene={'sceneId':'convex-plane-gate','revision':index,'coordinates':{'units':'m','upAxis':'Z','handedness':'right','quaternion':'xyzw'},'entities':[{'entityId':'convex','name':name,'transform':{'position':list(centre),'quaternion':sq,'scale':scale},'resources':[],'components':{'isaac':{'sourcePath':concave if name=='concave-unsupported'else convex}}},{'entityId':'plane','name':'actual infinite plane','transform':{'position':[0,0,0],'quaternion':pq,'scale':[1,1,1]},'resources':[],'components':{'collision':{'shape':'plane','infinite':True,'size':[0,0,.1]},'rigidBody':{'type':'static'}}}]}
  if name=='ownership-uncovered':scene['entities'].append({'entityId':'joint','name':'ownership-positive-control','transform':{'position':[5,0,0],'quaternion':identity,'scale':[1,1,1]},'resources':[],'components':{'isaac':{'sourcePath':str(out.parent/'source/joint.usda')}}})
  if world is None:world=ns['World'](scene,{'worldId':'convex-plane-gate','clock':'manual','ground':False,'timestepS':.002})
  else:world.sync(scene,force=True)
  if name=='ownership-uncovered':world.execute({'actionId':'audit-must-not-consume','expectedGeneration':world.generation,'kind':'control','entityId':'joint','jointNames':['Hinge'],'positions':[.2],'stepCount':100})
  def snapshot():return {'index':world.index,'simTime':world.sim_time,'sdkTime':ns['SM'].get_simulation_time(),'sdkSteps':ns['SM'].get_num_physics_steps(),'actions':repr(world.actions),'owners':repr(world.control_owners),'poses':{str(p.GetPath()):[float(v)for row in world._native_world_matrix(p)for v in row]for p in Usd.PrimRange(world.stage.GetPseudoRoot(),Usd.TraverseInstanceProxies())if p.HasAPI(UsdPhysics.CollisionAPI)}}
  before=snapshot();audit=initial_overlap(world);after=snapshot();item={'name':name,'expected':expected,'authoredSignedGapM':gap,'audit':audit,'before':before,'after':after,'unchanged':before==after};report['cases'].append(item)
  assert before==after,(name,'audit changed clock/pose/control owner');assert audit['status']==expected,(name,audit)
  if expected=='OVERLAP':assert len(audit['pairs'])==1 and abs(audit['pairs'][0]['depthM']+gap)<.00002,(name,audit)
  else:assert not audit['pairs'],(name,audit)
  if name=='ownership-uncovered':assert world.actions and world.control_owners;world.stop({})
 assert source_hashes=={p:hashlib.sha256(Path(p).read_bytes()).hexdigest()for p in source_hashes};report['sourceHashesUnchanged']=True;report['status']='PASSED'
except Exception as error:
 import traceback;report['error']=repr(error);report['traceback']=traceback.format_exc()
finally:
 if world:world.close()
 report['closed']=bool(world and world.status=='closed');(out/'receipt.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps({'status':report['status'],'error':report.get('error'),'cases':len(report['cases']),'closed':report['closed']},ensure_ascii=False),flush=True);ns['app'].close()
`)
 let queryExit=0
 try{const output=execFileSync(python,[queryScript,root,queryRoot,invocation],{cwd:root,env:{...process.env,...isaacLoaderEnvironment(python),LYAPUNOV_PRODUCT_ROOT:root,LYAPUNOV_ISAAC_CACHE:join(queryRoot,'cache'),LYAPUNOV_ISAAC_DEVICE:'cpu',LYAPUNOV_ISAAC_RENDERING:'none',HF_ENDPOINT:'https://hf-mirror.com'},timeout:120000,killSignal:'SIGKILL',maxBuffer:8*1024*1024});await writeFile(join(queryRoot,'process.log'),output)}catch(error){queryExit=1;await writeFile(join(queryRoot,'process-error.log'),String(error))}
 const queryReport=await readFile(join(queryRoot,'receipt.json'),'utf8').then(JSON.parse,()=>({status:'MISSING_RECEIPT'}));receipt.convexPlane=queryReport
 check('native-convex-plane-precision',queryExit===0&&queryReport.invocationId===invocation&&queryReport.status==='PASSED'&&queryReport.closed===true&&queryReport.cases?.length===12,{exitCode:queryExit,receipt:join(queryRoot,'receipt.json'),status:queryReport.status,error:queryReport.error,cases:queryReport.cases?.map((item:any)=>({name:item.name,status:item.audit.status,unchanged:item.unchanged}))})
 receipt.status='PASSED'
} catch(error) {
 receipt.status=String(error).includes('USD_ISAAC_CHECK_FAILED')?'FAILED':'BLOCKED';receipt.error=String(error);process.exitCode=receipt.status==='FAILED'?1:2
} finally {
 if(provider){try{await provider.dispose();receipt.closed=true}catch(error){receipt.closeError=String(error);receipt.status='FAILED';process.exitCode=1}}
 if(receipt.initial)await writeFile(join(out,'initial-frame.json'),JSON.stringify(receipt.initial,null,2)+'\n');if(receipt.final)await writeFile(join(out,'final-frame.json'),JSON.stringify(receipt.final,null,2)+'\n')
 receipt.finishedAt=new Date().toISOString();await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
 console.log(JSON.stringify({status:receipt.status,out,checks:receipt.checks,error:receipt.error,closed:receipt.closed},null,2))
}
