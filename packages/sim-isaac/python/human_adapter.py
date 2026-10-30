"""Isaac运动学人体薄适配；采样/路径验证复用human.py，PhysX tick与真实刚体状态归现有World。"""
import sys,copy,math,os
from pathlib import Path
import numpy as np
from pxr import Gf,Tf,UsdGeom,UsdPhysics,PhysxSchema
# 与既有gait同样共享算法；临时仅在导入时加入兄弟包，不替换Isaac的world_physics等模块。
shared_path=str(Path(__file__).resolve().parents[2]/'sim-mujoco'/'python')
sys.path.insert(0,shared_path)
try:import human as shared
finally:sys.path.remove(shared_path)

def validate(cfg,error):
 shared.validate(cfg,error)
 if os.environ.get('LYAPUNOV_ISAAC_DEVICE','cpu')!='cpu' or os.environ.get('LYAPUNOV_ISAAC_RENDERING','none')!='none':raise error('HUMAN_ISAAC_DEVICE_UNSUPPORTED','HUMAN_ISAAC_DEVICE_UNSUPPORTED: 当前人体适配和验收仅CPU/rendering:none，RTX/CUDA未接通')
 if cfg['mode']!='kinematic':raise error('HUMAN_ISAAC_RAGDOLL_UNSUPPORTED','HUMAN_ISAAC_RAGDOLL_UNSUPPORTED: Isaac人体当前只适配运动学分段碰撞；MuJoCo ragdoll不静默移植')
 if 'navigation'in(cfg.get('route')or{}):raise error('HUMAN_ISAAC_NAVIGATION_UNSUPPORTED','HUMAN_ISAAC_NAVIGATION_UNSUPPORTED: Isaac尚未适配平面A*占用查询；基础路径与原生PhysX停障可用')

def matrix(p,q):return Gf.Matrix4d(1).SetRotate(Gf.Quatd(float(q[0]),Gf.Vec3d(*map(float,q[1:])))).SetTranslateOnly(Gf.Vec3d(*map(float,p)))
def set_pose(prim,p,q):
 x=UsdGeom.Xformable(prim);x.ClearXformOpOrder();x.AddTransformOp().Set(matrix(p,q))
def install(stage,path,entity,world,error):
 cfg=copy.deepcopy(entity['components']['human']);validate(cfg,error);cfg['_poseRuntime']=shared.compile_pose(cfg)
 if entity.get('parentId')or not np.allclose(entity['transform'].get('scale',[1,1,1]),[1,1,1]):raise error('HUMAN_TRANSFORM_UNSUPPORTED','人体须为场景根实体且scale=1')
 route=cfg.get('route')or{};initial=shared.pose(cfg,np.zeros(3),np.array([1.,0,0,0]),0,route.get('behavior','stand'),route.get('speedMps',0),route.get('clip'));joints=[];segments=[];allpaths=[]
 def body(geom,position,quat,visible,collision):
  prim=geom.GetPrim();set_pose(prim,position,quat);UsdPhysics.RigidBodyAPI.Apply(prim).CreateKinematicEnabledAttr(True);PhysxSchema.PhysxRigidBodyAPI.Apply(prim).CreateDisableGravityAttr(True);UsdPhysics.CollisionAPI.Apply(prim).CreateCollisionEnabledAttr(collision);UsdPhysics.MassAPI.Apply(prim).CreateMassAttr(1.);PhysxSchema.PhysxContactReportAPI.Apply(prim).CreateThresholdAttr(0);PhysxSchema.PhysxCollisionAPI.Apply(prim).CreateContactOffsetAttr(.005);PhysxSchema.PhysxCollisionAPI(prim).CreateRestOffsetAttr(0)
  geom.CreateDisplayColorAttr([Gf.Vec3f(.12,.42,.65)])
  if not visible:UsdGeom.Imageable(prim).CreateVisibilityAttr('invisible')
  allpaths.append(str(prim.GetPath()));return str(prim.GetPath())
 marker=UsdGeom.Sphere.Define(stage,path+'/human_root');marker.CreateRadiusAttr(.001);root=body(marker,[0,0,0],[1,0,0,0],False,False)
 for i,j in enumerate(cfg['rig']):
  marker=UsdGeom.Sphere.Define(stage,path+'/joint_'+str(i));marker.CreateRadiusAttr(.001);p,q=initial[j['name']];joints.append({'name':j['name'],'path':body(marker,p,q,False,False)})
 edges=shared.SEGMENTS if cfg['collision']=='detailed'else[('pelvis','neck',.23)]
 for i,(a,b,r)in enumerate(edges):
  an,bn=cfg['boneMapping'][a],cfg['boneMapping'][b];calibration=shared.segment_calibration(cfg,a,b);pa,pb=shared.segment_points(initial,{'a':an,'b':bn,'calibration':calibration});half=float(np.linalg.norm(pb-pa))/2;q=np.zeros(4);shared.mj.mju_quatZ2Vec(q,pb-pa);radius=calibration['radiusM']if calibration else r*cfg['heightM']/1.75;geom=UsdGeom.Capsule.Define(stage,path+'/segment_'+str(i));geom.CreateAxisAttr('Z');geom.CreateRadiusAttr(radius);geom.CreateHeightAttr(2*half);segments.append({'name':a+'-'+b,'a':an,'b':bn,'radius':radius,'half':half,'path':body(geom,(pa+pb)/2,q,True,True),**({'calibration':calibration}if calibration else{})})
 q=world.ExtractRotationQuat();return{'human':cfg,'humanRoot':np.asarray(world.ExtractTranslation()),'humanRootQ':np.array([float(q.GetReal()),*map(float,q.GetImaginary())]),'humanPaths':allpaths,'humanRootPath':root,'humanJoints':joints,'humanSegments':segments}

def bind(entry,RigidPrim):
 if not entry.get('human'):return
 entry['humanView']=RigidPrim(entry['humanPaths'])
 # 顺序以真实view.paths回报为准；不假设regex/SDK保留传入列表顺序。
 entry['humanIndices']={path:i for i,path in enumerate(entry['humanView'].paths)}

def prepare(world,entry,m,error):
 if not entry.get('human'):raise error('HUMAN_COMPONENT_REQUIRED','目标不是原生Isaac人体')
 route=m.get('route')or entry['human'].get('route')or{}
 if 'navigation'in route:raise error('HUMAN_ISAAC_NAVIGATION_UNSUPPORTED','HUMAN_ISAAC_NAVIGATION_UNSUPPORTED: Isaac平面A*尚未实现；不会静默删除navigation配置')
 shared.prepare(world,entry,m,error);m['_initialPosition']=root_position(world,entry).tolist();return m

def root_position(world,entry):
 from scene_adapter import use_backend
 with use_backend('tensor',raise_on_fallback=True):p,_=entry['pose'].get_world_poses()
 return np.asarray(p).reshape(-1)[:3]

def commit(world,entry,root,q,sampled):
 from scene_adapter import use_backend
 poses={entry['humanRootPath']:(root,q)}
 for row in entry['humanJoints']:poses[row['path']]=sampled[row['name']]
 for row in entry['humanSegments']:
  pa,pb=shared.segment_points(sampled,row);quat=np.zeros(4);shared.mj.mju_quatZ2Vec(quat,pb-pa);poses[row['path']]=((pa+pb)/2,quat)
 values=[]
 for path in entry['humanView'].paths:
  position,quat=poses[path];values.append([*position,*quat[1:],quat[0]])
 view=entry['humanView']
 # 只用PhysX原生kinematic target，让引擎在下一SM.step消费，不用USD动画或set_world_poses回放冒充。
 if hasattr(view,'_tensor'):native=view._tensor()._physics_view
 else:native=getattr(view,'_physics_rigid_body_view',None)
 if native is None or not hasattr(native,'set_kinematic_targets'):raise world.human_error('HUMAN_KINEMATIC_TARGET_UNAVAILABLE','当前SDK没有已初始化的PhysX RigidBodyView.set_kinematic_targets')
 native.set_kinematic_targets(np.asarray(values,dtype=np.float32),np.arange(len(values),dtype=np.uint32))

def observe(world,entry):
 from scene_adapter import use_backend
 with use_backend('tensor',raise_on_fallback=True):positions,quaternions=entry['humanView'].get_world_poses()
 positions=np.asarray(positions);quaternions=np.asarray(quaternions);indices=entry['humanIndices']
 def row(path):
  i=indices[path];q=quaternions[i];return{'positionM':positions[i].tolist(),'quaternionXyzw':[*q[1:].tolist(),float(q[0])]}
 return{'source':'isaac-body','mode':'kinematic','simTime':world.sim_time,'stepIndex':world.index,'joints':[{'name':j['name'],**row(j['path'])}for j in entry['humanJoints']],'segments':[{'name':s['name'],**row(s['path']),'radiusM':s['radius'],'halfLengthM':s['half']}for s in entry['humanSegments']],**({'motion':copy.deepcopy(entry['humanMotion'])}if entry.get('humanMotion')else{}),**({'target':copy.deepcopy(entry['humanTarget'])}if entry.get('humanTarget')else{})}

def obstacle_distance(world,origin,direction,limit):
 import omni.physx
 query=omni.physx.get_physx_scene_query_interface();roots=[e['path']for e in world.entities.values()if e.get('human')];closest=[-1.,'']
 if not hasattr(query,'raycast_all'):return 0.,'HUMAN_RAYCAST_ALL_UNAVAILABLE'
 def hit(value):
  path=str(value.get('collision')or value.get('rigidBody')or'')if isinstance(value,dict)else str(getattr(value,'collision','')or getattr(value,'rigid_body',''))
  if not path:closest[:]=[0.,'HUMAN_RAY_HIT_UNREADABLE'];return False
  if any(path==root or path.startswith(root+'/')for root in roots):return True
  distance=float(value.get('distance',0.))if isinstance(value,dict)else float(getattr(value,'distance',0.))
  if closest[0]<0 or distance<closest[0]:closest[:]=[distance,path]
  return True
 query.raycast_all(tuple(map(float,origin)),tuple(map(float,direction)),float(limit),hit)
 return closest[0],closest[1]

def stop(entry):
 if entry.get('humanMotion'):entry['humanMotion']={**entry['humanMotion'],'behavior':'stopped'}


def preflight(scene,error):
 for entity in shared.hydrate(scene,error)['entities']:
  cfg=entity.get('components',{}).get('human')
  if cfg:validate(cfg,error)
