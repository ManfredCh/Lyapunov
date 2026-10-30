"""同一World的SDF能力诊断；查询阶段不tick，显式反馈动作在快照之后执行，不作为产品审计。"""
import os,sys,json,copy,argparse,hashlib,subprocess,uuid,signal
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--scene',required=True,help='含绝对原生来源路径的本地Scene JSON')
parser.add_argument('--joint-source',required=True,help='合法自有Hinge原生USD正对照')
parser.add_argument('--out',required=True,help='本次独立输出目录')
parser.add_argument('--experimental-gpu-tensors',action='store_true',help='仅诊断：初始化GPU数据模式；不是产品支持')
parser.add_argument('--keep-gpu-data-mode',action='store_true')
parser.add_argument('--export-repx',action='store_true',help='同World诊断导出；可能使articulation view失效，不宣称只读兼容')
parser.add_argument('--internal-kit-child',action='store_true',help=argparse.SUPPRESS)
parser.add_argument('--timeout-s',type=int,default=120,help='Kit子进程显式截止秒数，1至120；超时清理仅本进程组')
parser.add_argument('--feedback-steps',type=int,default=400,help='查询快照后显式有界Hinge动作步数；0只查询')
args=parser.parse_args()
if not 0<=args.feedback_steps<=1000:parser.error('feedback-steps须为0至1000')
if not 1<=args.timeout_s<=120:parser.error('timeout-s须为1至120，不提高120秒门槛')
root=Path(__file__).resolve().parents[2];out=Path(args.out).resolve();out.mkdir(parents=True,exist_ok=True)
if not args.internal_kit_child:
    # Kit可在close()中直接以0终止解释器；独立普通Python进程按本次真实回执返回状态。
    invocation=str(uuid.uuid4());environment={**os.environ,'LYAPUNOV_SDF_PROBE_RUN_ID':invocation}
    child=subprocess.Popen([sys.executable,str(Path(__file__).resolve()),*sys.argv[1:],'--internal-kit-child'],env=environment,start_new_session=True)
    timed_out=False;forced=False
    try:child.wait(timeout=args.timeout_s)
    except subprocess.TimeoutExpired:
        timed_out=True
        try:os.killpg(child.pid,signal.SIGTERM)
        except ProcessLookupError:pass
        try:child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            forced=True
            try:os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            child.wait()
    try:
        result=json.loads((out/'receipt.json').read_text())
        if result.get('invocationId')!=invocation:raise RuntimeError('回执不是本次Kit进程生成')
    except Exception as error:result={'status':'PROCESS_FAILED','invocationId':invocation,'error':str(error),'worldClosed':False}
    if timed_out:
        result['statusBeforeTimeout']=result['status'];result['status']='TIMED_OUT';result['error']='KIT_CHILD_TIMEOUT: '+str(args.timeout_s)+'s，已终止本次独立Kit进程组'
    code=124 if timed_out else (128-child.returncode if child.returncode<0 else child.returncode)or(0 if result.get('status')=='MEASURED'and not result.get('error')and result.get('worldClosed')else 1)
    result['launcher']={'kitChildExitCode':child.returncode,'exitCode':code,'timeoutS':args.timeout_s,'timedOut':timed_out,'forcedKill':forced}
    (out/'receipt.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps({'status':result['status'],'error':result.get('error'),'launcher':result['launcher']},ensure_ascii=False),flush=True)
    raise SystemExit(code)
worker=root/'packages/sim-isaac/python/worker.py';sys.path.insert(0,str(worker.parent));source=worker.read_text().split('\nrequests=queue.Queue()')[0]
gpu_init=args.experimental_gpu_tensors
if gpu_init:
    for marker in ["SM.setup_simulation(dt=self.dt,device=device)","if device!='cpu':carb.settings.get_settings().set_bool('/physics/suppressReadback',False)","SM.initialize_physics()\n            self.assert_native_physics()"]:
        if source.count(marker)!=1:raise RuntimeError('探针内存替换锚点不唯一，拒绝继续：'+marker)
    source=source.replace("SM.setup_simulation(dt=self.dt,device=device)","SM.set_backend('warp')\n            SM.setup_simulation(dt=self.dt,device=device)")
    source=source.replace("if device!='cpu':carb.settings.get_settings().set_bool('/physics/suppressReadback',False)","if device!='cpu':carb.settings.get_settings().set_bool('/physics/suppressReadback',True)")
    if not args.keep_gpu_data_mode:source=source.replace("SM.initialize_physics()\n            self.assert_native_physics()","SM.initialize_physics()\n            carb.settings.get_settings().set_bool('/physics/suppressReadback',False)\n            self.assert_native_physics()")
ns={'__file__':str(worker),'__name__':'sdf_probe_worker'};exec(compile(source,str(worker),'exec'),ns)
ns['emit']=lambda event:None
report={'status':'PARTIAL','invocationId':os.environ.get('LYAPUNOV_SDF_PROBE_RUN_ID'),'queries':{},'explicitSteps':0,'experimentalGpuTensorInitialization':gpu_init,'keepGpuDataMode':args.keep_gpu_data_mode,'productCodeModified':False};world=None
try:
 scene=json.loads(Path(args.scene).resolve().read_text())
 from pxr import Usd,UsdGeom,UsdPhysics,PhysxSchema
 own=out/'noninstance-sdf.usda';s=Usd.Stage.CreateNew(str(own));UsdGeom.SetStageUpAxis(s,'Z');UsdGeom.SetStageMetersPerUnit(s,1);r=UsdGeom.Xform.Define(s,'/Root');s.SetDefaultPrim(r.GetPrim());UsdPhysics.RigidBodyAPI.Apply(r.GetPrim());UsdPhysics.MassAPI.Apply(r.GetPrim()).CreateMassAttr(1.)
 m=UsdGeom.Mesh.Define(s,'/Root/Mesh');m.CreatePointsAttr([(-.5,-.5,-.5),(.5,-.5,-.5),(.5,.5,-.5),(-.5,.5,-.5),(-.5,-.5,.5),(.5,-.5,.5),(.5,.5,.5),(-.5,.5,.5)]);m.CreateFaceVertexCountsAttr([4]*6);m.CreateFaceVertexIndicesAttr([0,3,2,1,4,5,6,7,0,1,5,4,3,7,6,2,0,4,7,3,1,2,6,5]);m.CreateSubdivisionSchemeAttr('none');UsdPhysics.CollisionAPI.Apply(m.GetPrim());UsdPhysics.MeshCollisionAPI.Apply(m.GetPrim()).CreateApproximationAttr('sdf');PhysxSchema.PhysxSDFMeshCollisionAPI.Apply(m.GetPrim()).CreateSdfResolutionAttr(32);s.GetRootLayer().Save();s=None
 scene['entities'].append({'entityId':'noninstance-sdf','name':'noninstance-sdf','transform':{'position':[3,0,1],'quaternion':[0,0,0,1],'scale':[1,1,1]},'resources':[],'components':{'isaac':{'sourcePath':str(own)}}})
 scene['entities'].append({'entityId':'probe-joint','name':'probe-joint','transform':{'position':[5,0,0],'quaternion':[0,0,0,1],'scale':[1,1,1]},'resources':[],'components':{'isaac':{'sourcePath':str(Path(args.joint_source).resolve())}}})
 scene['entities'].append({'entityId':'feedback-cube','name':'feedback-cube','transform':{'position':[7,0,1],'quaternion':[0,0,0,1],'scale':[1,1,1]},'resources':[],'components':{'collision':{'shape':'box','size':[.5,.5,.5]},'rigidBody':{'type':'dynamic','massKg':1}}})
 source_paths=sorted(set(entity.get('components',{}).get('isaac',{}).get('sourcePath')for entity in scene['entities']if entity.get('components',{}).get('isaac',{}).get('sourcePath')));source_hashes={path:hashlib.sha256(Path(path).read_bytes()).hexdigest()for path in source_paths};report['sourceEntrySha256Before']=source_hashes
 world=ns['World'](scene,{'worldId':'sdf-current-probe','clock':'manual','ground':True,'timestepS':.002})
 from pxr import Usd,UsdGeom,UsdPhysics,Gf
 import numpy as np
 import omni.physics.tensors as tensors
 import omni.physx
 paths=[str(p.GetPath())for p in Usd.PrimRange(world.stage.GetPseudoRoot(),Usd.TraverseInstanceProxies())if p.IsA(UsdGeom.Mesh)and p.HasAPI(UsdPhysics.CollisionAPI)and UsdPhysics.MeshCollisionAPI(p).GetApproximationAttr().Get()=='sdf']
 def snapshot():return {'step':world.index,'simTime':world.sim_time,'sdkTime':ns['SM'].get_simulation_time(),'sdkSteps':ns['SM'].get_num_physics_steps(),'suppressReadback':ns['carb'].settings.get_settings().get_as_bool('/physics/suppressReadback'),'actions':copy.deepcopy(world.actions),'controlOwners':copy.deepcopy(world.control_owners),'joints':world.observe({'entityIds':['probe-joint']})['entities'][0].get('joints'),'poses':{p:[float(v)for row in world._native_world_matrix(world.stage.GetPrimAtPath(p))for v in row]for p in paths}}
 before=snapshot();report['before']=before;report['paths']=paths
 original_legacy=ns['SM'].get_physics_sim_view();original_warp=ns['SM'].get_physics_simulation_view();report['originalManagerViews']={'legacyFrontend':str(type(original_legacy._frontend)),'legacyDevice':str(original_legacy.device),'warpDevice':str(original_warp.device)}
 report['nativeSceneFlags']=[{'path':str(prim.GetPath()),'gpuDynamics':PhysxSchema.PhysxSceneAPI(prim).GetEnableGPUDynamicsAttr().Get(),'broadphase':str(PhysxSchema.PhysxSceneAPI(prim).GetBroadphaseTypeAttr().Get())}for prim in world.stage.Traverse()if prim.IsA(UsdPhysics.Scene)]
 view=ns['SM'].get_physics_simulation_view();report['frontend']=str(type(view._frontend));report['viewDevice']=str(view.device);report['meshSchemas']={p:world.stage.GetPrimAtPath(p).GetAppliedSchemas()for p in paths};report['shapeAttributes']={p:{a.GetName():str(a.Get())for a in world.stage.GetPrimAtPath(p).GetAttributes()if'sdf'in a.GetName().lower()or'approximation'in a.GetName()}for p in paths}
 report['viewAttempts']=[];sdf=None
 for pattern in [paths[0],'/World/entities/*/source/Geometry/sm_box_a01_obj_00/sm_box_a01_mesh_00','/World/entities/e2/source/Mesh','/__Prototype_*/*','*']:
  candidate=view.create_sdf_shape_view(pattern,16);report['viewAttempts'].append({'pattern':pattern,'backend':str(candidate._backend)})
  if candidate._backend is not None:sdf=candidate;break
 if sdf is None:
  for suppress in [False,True]:
   settings=ns['carb'].settings.get_settings();previous=settings.get_as_bool('/physics/suppressReadback')
   try:
    settings.set_bool('/physics/suppressReadback',suppress)
    alternate=tensors.create_simulation_view('warp',stage_id=world.stage_id);alternate.set_subspace_roots('/');candidate=alternate.create_sdf_shape_view(paths[0],16);report['viewAttempts'].append({'stageId':world.stage_id,'suppressReadbackDuringViewCreation':suppress,'device':str(alternate.device),'backend':str(candidate._backend)})
    if candidate._backend is not None:sdf=candidate;view=alternate;break
   except Exception as error:report['viewAttempts'].append({'stageId':world.stage_id,'suppressReadbackDuringViewCreation':suppress,'error':str(error)})
   finally:settings.set_bool('/physics/suppressReadback',previous)
  report['originalManagerViewsUnchanged']=original_legacy is ns['SM'].get_physics_sim_view() and original_warp is ns['SM'].get_physics_simulation_view();assert report['originalManagerViewsUnchanged']
 if sdf is not None:
  report['sdfView']={'count':sdf.count,'paths':sdf.object_paths,'maxPoints':sdf.max_num_points,'valid':sdf.check()}
  points=np.zeros((sdf.count,16,3),dtype=np.float32);points[:,:,:]=[0,0,.25];points[:,1,:]=[3,0,.25];points[:,2,:]=[0,0,-.2];points[:,3,:]=[0,0,.8]
  try:
   import warp as wp
   data=wp.array(points,dtype=wp.float32,device=str(view.device))
   values=sdf.get_sdf_and_gradients(data);report['queries']['sdf']=np.asarray(values.numpy()if hasattr(values,'numpy')else values).tolist()
  except Exception as error:report['queries']['sdfError']=type(error).__name__+': '+str(error)
  try:
   calibration=view.create_sdf_shape_view('/World/entities/e2/source/Mesh',16);test_points=np.zeros((1,16,3),dtype=np.float32);test_points[:,1,:]=[.6,0,0];test_points[:,2,:]=[0,0,-.6];raw=calibration.get_sdf_and_gradients(wp.array(test_points,dtype=wp.float32,device=str(view.device))).numpy();report['queries']['boxCalibration']=raw[0,:3].tolist();report['queries']['distanceWCalibration']={'centreNegative':bool(raw[0,0,3]<0),'nearSurfaceDistancesMetric':bool(np.allclose(raw[0,1:3,3],[.1,.1],atol=.002)),'sparseInteriorIsNotAnalyticEuclidean':float(raw[0,0,3]),'layout':'gradient.xyz,distance.w'}
  except Exception as error:report['queries']['calibrationError']=str(error)
 else:report['queries']['sdfError']='Native SdfShapeView backend unavailable for current registered source meshes'
 from omni.physx.scripts.ifaces import get_physx_attachment_private_interface
 interface=get_physx_attachment_private_interface()
 try:
  wp=world._native_world_matrix(world.stage.GetPrimAtPath(paths[0])).Transform(Gf.Vec3d(0,0,.25));closest=interface.get_closest_points([Gf.Vec3f(*wp)],paths[0]);report['queries']['closest']={k:str(v)for k,v in closest.items()}
 except Exception as error:report['queries']['closestError']=type(error).__name__+': '+str(error)
 if args.export_repx:
  repx=out/'compiled.repx';success=omni.physx.get_physx_interface().save_scene_to_repx(str(repx));report['repxExport']={'success':bool(success),'path':str(repx),'readOnlyCompatibility':'UNVERIFIED: 导出可能使既有articulation view失效；subset时钟/pose/对象身份不能代替反馈验证','files':[{'path':str(file),'size':file.stat().st_size}for file in out.rglob('*')if file.is_file()]}
 report['nativeReportSizes']=[len(v)for v in omni.physx.get_physx_simulation_interface().get_contact_report()]
 report['originalManagerViewsUnchanged']=original_legacy is ns['SM'].get_physics_sim_view() and original_warp is ns['SM'].get_physics_simulation_view();assert report['originalManagerViewsUnchanged']
 after=snapshot();report['after']=after;report['clockPosesControlsUnchanged']=before==after;assert before==after
 if args.feedback_steps:
  maximum=0;contacts_seen=0;native_contacts=[0]
  subscription=omni.physx.get_physx_simulation_interface().subscribe_contact_report_events(lambda headers,points:native_contacts.__setitem__(0,native_contacts[0]+len(points)))
  gpu_contact=None;gpu_contact_max=0;gpu_force_max=0.;gpu_sample=None
  if gpu_init:
   all_colliders=[str(p.GetPath())for p in Usd.PrimRange(world.stage.GetPseudoRoot(),Usd.TraverseInstanceProxies())if p.HasAPI(UsdPhysics.CollisionAPI)and UsdPhysics.CollisionAPI(p).GetCollisionEnabledAttr().Get()is not False]
   report['gpuContactAttempts']=[]
   if gpu_init:all_colliders=[str(p.GetPath())for p in Usd.PrimRange(world.stage.GetPseudoRoot(),Usd.TraverseInstanceProxies())if p.HasAPI(UsdPhysics.RigidBodyAPI)]+['/World/ground/geometry/collisionPlane'];report['contactMode']='EXPERIMENTAL_BODY_PATTERNS_NOT_COLLIDER_IDENTITY'
   for sensors,filters in [(all_colliders,[all_colliders for _ in all_colliders]),('/World/entities/e4',['/World/ground/geometry/collisionPlane']),('/World/entities/e0/source/Geometry/sm_box_a01_obj_00',['/World/ground/geometry/collisionPlane'])]:
    try:
     candidate=view.create_rigid_contact_view(sensors,filters,4096)
     if candidate._backend is None:report['gpuContactAttempts'].append({'sensors':sensors,'filters':filters,'backend':'None'});continue
     gpu_contact=candidate;report['gpuContactView']={'sensorCount':gpu_contact.sensor_count,'filterCount':gpu_contact.filter_count,'sensorPaths':gpu_contact.sensor_paths,'filterPaths':gpu_contact.filter_paths};break
    except Exception as error:report['gpuContactAttempts'].append({'sensors':sensors,'filters':filters,'error':str(error)})
  body_paths=sorted(set(path for entry in world.entities.values()for path in entry.get('rigidPaths',[])));body_view=view.create_rigid_body_view(body_paths);report['nativeBodyView']={'paths':body_view.prim_paths,'count':body_view.count}
  world.execute({'actionId':'post-audit-joint','expectedGeneration':world.generation,'kind':'control','entityId':'probe-joint','jointNames':['Hinge'],'positions':[.2],'stepCount':args.feedback_steps})
  for _ in range(args.feedback_steps):
   world.tick();maximum=max(maximum,len(world.contacts));contacts_seen+=len(world.contacts)
   if gpu_contact:
    try:
     buffers=[value.numpy()if hasattr(value,'numpy')else np.asarray(value)for value in gpu_contact.get_contact_data(world.dt)];count=int(buffers[4].sum());gpu_contact_max=max(gpu_contact_max,count);gpu_force_max=max(gpu_force_max,float(np.abs(buffers[0]).max()))
     if count and gpu_sample is None:
      sensor,filtered=np.argwhere(buffers[4]>0)[0];start=int(buffers[5][sensor,filtered]);gpu_sample={'sensorIndex':int(sensor),'filterIndex':int(filtered),'start':start,'force':buffers[0][start].tolist(),'point':buffers[1][start].tolist(),'normal':buffers[2][start].tolist(),'separation':buffers[3][start].tolist()}
    except Exception as error:report['gpuContactReadError']=str(error);gpu_contact=None
  report['postAuditFeedbackTest']={'explicitWorldTicks':args.feedback_steps,'step':world.index,'contactPairs':len(world.contacts),'maximumPairsAcrossSteps':maximum,'contactPairsAcrossSteps':contacts_seen,'nativeContactPointsAcrossSteps':native_contacts[0],'gpuContactMaximumPoints':gpu_contact_max,'gpuContactMaximumForceN':gpu_force_max,'gpuContactSample':gpu_sample,'action':world.receipts['post-audit-joint'],'frame':world.observe({'contacts':True}),'suppressReadback':ns['carb'].settings.get_settings().get_as_bool('/physics/suppressReadback')}
  native=body_view.get_transforms();native=native.numpy()if hasattr(native,'numpy')else np.asarray(native);frame=world.observe({'contacts':True});frame_bodies={value['runtimePrimPath']:value['worldMatrixM']for entity in frame['entities']for value in entity.get('sensors',{}).get('usdBodyWorldPoses',{}).values()}
  for entity in frame['entities']:
   entry=world.entities[entity['entityId']];path=entry.get('nativePosePath')
   if path and path not in frame_bodies:
    transform=entity['transform'];matrix=world._matrix_from_pose(transform['position'],transform['quaternion']);frame_bodies[path]=[float(matrix[i][j])for i in range(4)for j in range(4)]
  report['bodyPoseComparison']=[]
  for i,path in enumerate(body_view.prim_paths):
   expected=world._matrix_from_pose(native[i,:3].tolist(),native[i,3:].tolist());expected=[float(expected[r][c])for r in range(4)for c in range(4)];actual=frame_bodies.get(path)
   report['bodyPoseComparison'].append({'path':path,'nativePoseXyzw':native[i].tolist(),'frameMatrix':actual,'matrixMatches':bool(actual is not None and np.allclose(expected,actual,atol=1e-5,rtol=0))})
  if not gpu_init:assert all(item['matrixMatches']for item in report['bodyPoseComparison'])
  world.execute({'actionId':'stop-pause-control','expectedGeneration':world.generation,'kind':'control','entityId':'probe-joint','jointNames':['Hinge'],'positions':[-.1],'stepCount':200});pause_before=snapshot();world.paused=True
  for _ in range(5):world.tick()
  report['pauseClockPoseControlUnchanged']=pause_before==snapshot();world.paused=False
  for _ in range(10):world.tick()
  report['stopReceipt']=world.stop({'actionId':'stop-pause-control','expectedGeneration':world.generation});stopped=snapshot()
  for _ in range(5):world.tick()
  report['stopManualClockPoseUnchanged']=stopped==snapshot();subscription=None
 report['sourceEntrySha256After']={path:hashlib.sha256(Path(path).read_bytes()).hexdigest()for path in source_paths};assert report['sourceEntrySha256After']==source_hashes
 report['status']='MEASURED'
except Exception as error:
 import traceback;report['error']=type(error).__name__+': '+str(error);report['traceback']=traceback.format_exc();print(report['traceback'])
finally:
 try:
  if world:world.close()
 except Exception as error:report['status']='PARTIAL';report['error']='WORLD_CLOSE_FAILED: '+str(error)
 report['worldClosed']=bool(world and world.status=='closed')
 report['closeRequested']=True;(out/'receipt.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False),flush=True)
 try:ns['app'].close()
 except Exception as error:
  report['status']='PARTIAL';report['error']='KIT_CLOSE_FAILED: '+str(error);(out/'receipt.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(report['error'],flush=True)
