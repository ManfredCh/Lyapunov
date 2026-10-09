"""Real USD/Gf origin-contract checks; no Kit, PhysX stepping or source mutation."""
import importlib.util
import json
from pathlib import Path
import sys
import types

import numpy as np
from pxr import Gf,Usd,UsdGeom,UsdPhysics

source=Path(sys.argv[1]);error_module=types.ModuleType('scene_adapter')
class SceneError(Exception):
    def __init__(self,code,message):super().__init__(message);self.code=code
error_module.SceneError=SceneError;sys.modules['scene_adapter']=error_module
spec=importlib.util.spec_from_file_location('origin_authoring',source/'python/robot_authoring.py')
authoring=importlib.util.module_from_spec(spec);spec.loader.exec_module(authoring)

def matrix(position,axis,degrees,scale=(1,1,1)):
    value=Gf.Matrix4d(1).SetScale(Gf.Vec3d(*scale))*Gf.Matrix4d(1).SetRotate(Gf.Rotation(Gf.Vec3d(*axis),degrees))
    return value.SetTranslateOnly(Gf.Vec3d(*position))

def state(value):
    value=value.RemoveScaleShear();q=value.ExtractRotationQuat()
    return list(value.ExtractTranslation()),[float(q.GetReal()),*map(float,q.GetImaginary())]

rows=[]
for label,model,local in [
    ('g1-source-offset',matrix([3.2,-1.2,0],[0,0,1],0),matrix([0,0,.793],[1,0,0],0)),
    ('rotated-source-and-installation',matrix([2,3,.4],[1,2,3],47),matrix([.22,-.31,.793],[2,-1,1],32)),
    ('scaled-installation',matrix([-.4,.5,1.8],[0,0,1],71,[2,2,2]),matrix([.22,-.31,.793],[1,0,0],25)),
    ('static-body',matrix([3,-5,.2],[0,1,0],18),matrix([-.2,.4,1.2],[0,0,1],35)),
    ('same-origin-primitive',matrix([1234,-987,1],[0,0,1],0),Gf.Matrix4d(1)),
]:
    stage=Usd.Stage.CreateInMemory();root=UsdGeom.Xform.Define(stage,'/World/entity');root.AddTransformOp().Set(model)
    body=UsdGeom.Xform.Define(stage,'/World/entity/root');body.AddTransformOp().Set(local);UsdPhysics.RigidBodyAPI.Apply(body.GetPrim())
    pose=types.SimpleNamespace(paths=['/World/entity/root']);entry={'entity':{'entityId':label},'path':'/World/entity','articulation':None,'pose':pose}
    authoring.capture_model_origin(stage,entry,model)
    native=UsdGeom.XformCache().GetLocalToWorldTransform(body.GetPrim()).RemoveScaleShear()
    observed=authoring.model_world_matrix(entry,*state(native))
    np.testing.assert_allclose(np.asarray(observed),np.asarray(model.RemoveScaleShear()),atol=1e-12)
    desired=matrix([4.1,2.3,1.7],[2,1,4],81)
    moved_native=entry['modelFromNativeRoot']*desired
    moved=authoring.model_world_matrix(entry,*state(moved_native))
    np.testing.assert_allclose(np.asarray(moved),np.asarray(desired),atol=1e-12)
    assert np.allclose(body.GetLocalTransformation(),local),'Projection changed authored source pose'
    initial=authoring.native_initial_pose(stage,entry);np.testing.assert_allclose(initial[0],state(native)[0],atol=1e-12)
    authoring.verify_native_origin(entry)
    rows.append({'case':label,'rawNativePositionM':state(native)[0],'modelPositionM':state(observed)[0],'movedModelPositionM':state(moved)[0],'sourcePreserved':True})

stage=Usd.Stage.CreateInMemory();model=matrix([1,2,.3],[0,0,1],23)
root=UsdGeom.Xform.Define(stage,'/World/fixed');root.AddTransformOp().Set(model)
body=UsdGeom.Xform.Define(stage,'/World/fixed/base');body.AddTranslateOp().Set(Gf.Vec3d(.2,.3,.7));UsdPhysics.RigidBodyAPI.Apply(body.GetPrim())
joint=UsdPhysics.FixedJoint.Define(stage,'/World/fixed/root_joint');joint.CreateBody1Rel().SetTargets([body.GetPath()])
entry={'entity':{'entityId':'fixed-joint'},'path':'/World/fixed','articulation':types.SimpleNamespace(link_paths=[[str(body.GetPath())]]),'pose':types.SimpleNamespace(paths=[str(joint.GetPath())])}
authoring.capture_model_origin(stage,entry,model);assert entry['nativePosePath']==str(body.GetPath())
relation=Gf.Matrix4d(entry['modelFromNativeRoot'])
# A changed real fixed/free/attached-body pose retains the original Resource relation.
anchor=matrix([5,-2,3],[1,1,0],56);body.ClearXformOpOrder();body.AddTransformOp().Set(anchor*model.GetInverse())
projected=authoring.model_world_matrix(entry,*authoring.native_initial_pose(stage,entry))
np.testing.assert_allclose(np.asarray(projected),np.asarray(relation.GetInverse()*anchor),atol=1e-12)
authoring.verify_native_origin(entry)
entry['articulation'].link_paths=[['/World/fixed/wrong-root']]
try:authoring.verify_native_origin(entry);raise AssertionError('Wrong root was accepted')
except SceneError as error:assert error.code=='ENTITY_ORIGIN_UNVERIFIED'
rows.append({'case':'fixed-joint-and-anchor','nativePosePath':str(body.GetPath()),'relationPreserved':True,'rootMismatchRejected':True})
# Scope 根只在原生有序 link 元数据 ready 后选择；预初始化 USD 快照不触碰 tensor。
class DelayedLinks:
    def __init__(self,paths):self.paths=paths;self.ready=False;self.reads=0
    @property
    def link_paths(self):
        self.reads+=1
        if not self.ready:raise SceneError('PHYSICS_NOT_READY','view not initialized')
        return self.paths
stage=Usd.Stage.CreateInMemory();model=matrix([2,-3,.2],[0,0,1],35)
container=UsdGeom.Xform.Define(stage,'/World/deferred');container.AddTransformOp().Set(model)
scope=UsdGeom.Scope.Define(stage,'/World/deferred/articulation');UsdPhysics.ArticulationRootAPI.Apply(scope.GetPrim())
body=UsdGeom.Xform.Define(stage,'/World/deferred/articulation/base');local=matrix([.1,.2,.7],[1,0,0],19);body.AddTransformOp().Set(local);UsdPhysics.RigidBodyAPI.Apply(body.GetPrim())
ordered=DelayedLinks([[str(body.GetPath())]])
entry={'entity':{'entityId':'deferred-scope'},'path':'/World/deferred','articulation':ordered,'pose':types.SimpleNamespace(paths=[str(scope.GetPath())]),'rigidPaths':[str(body.GetPath())]}
source_snapshot=authoring.snapshot_model_origin(stage,entry,model);assert ordered.reads==0
try:authoring.capture_model_origin(stage,entry,model);raise AssertionError('uninitialized link metadata was read as ready')
except SceneError as error:assert error.code=='PHYSICS_NOT_READY'
# 此真实 USD 变换变更代表初始化后环境发生变化；测试不运行物理，也不作为运行证据。
body.ClearXformOpOrder();body.AddTransformOp().Set(matrix([.6,-.2,.9],[0,1,0],14))
ordered.ready=True
authoring.capture_model_origin(stage,entry,source_snapshot['worldFromModel'],native_worlds=source_snapshot['worldByPath'])
assert entry['nativePosePath']==str(body.GetPath())
original=source_snapshot['worldByPath'][str(body.GetPath())];initial=authoring.native_initial_pose(stage,entry,native_world=original)
np.testing.assert_allclose(initial[0],state(original)[0],atol=1e-12)
projected=authoring.model_world_matrix(entry,*initial);np.testing.assert_allclose(np.asarray(projected),np.asarray(model.RemoveScaleShear()),atol=1e-12)
authoring.verify_native_origin(entry)
rows.append({'case':'deferred-scope-USD-snapshot','tensorReadsDuringSnapshot':0,'nativeRootFromOrderedLinks':True,'preInitializationOriginPreserved':True})

# 原关系取源 USD；显式基座绑定后的真实 USD 初态单独用于既有预热复位。
anchor=matrix([7,4,1.2],[1,2,1],51);body.ClearXformOpOrder();body.AddTransformOp().Set(anchor*model.GetInverse())
binding_snapshot=authoring.snapshot_model_origin(stage,entry,model)
authoring.capture_model_origin(stage,entry,model,native_worlds=source_snapshot['worldByPath'])
bound_initial=authoring.native_initial_pose(stage,entry,native_world=binding_snapshot['worldByPath'][str(body.GetPath())])
np.testing.assert_allclose(bound_initial[0],state(anchor)[0],atol=1e-12)
np.testing.assert_allclose(np.asarray(authoring.model_world_matrix(entry,*bound_initial)),np.asarray(entry['modelFromNativeRoot'].GetInverse()*anchor),atol=1e-12)
rows.append({'case':'binding-after-source-snapshot','authoredAnchorRestored':True,'sourceRelationPreserved':True})

bad=DelayedLinks([['/World/deferred/articulation/missing']]);bad.ready=True;entry['articulation']=bad
missing=UsdGeom.Xform.Define(stage,'/World/deferred/articulation/missing');UsdPhysics.RigidBodyAPI.Apply(missing.GetPrim())
try:authoring.capture_model_origin(stage,entry,model,native_worlds=source_snapshot['worldByPath']);raise AssertionError('uncaptured native root accepted')
except SceneError as error:assert error.code=='ENTITY_ORIGIN_UNVERIFIED'
rows.append({'case':'uncaptured-native-root-rejected','errorCode':'ENTITY_ORIGIN_UNVERIFIED'})
# 实际 MuJoCo 编译与只读 FK 消费 home 及显式初值；不启动物理积分。
import ast,tempfile
sys.modules['robot_authoring']=authoring
adapter_tree=ast.parse((source/'python/scene_adapter.py').read_text())
names={'mjcf_metadata','_scalar_joint_types','enum_name','object_name'}
metadata_nodes=[n for n in adapter_tree.body if isinstance(n,ast.FunctionDef) and n.name in names]
assert {n.name for n in metadata_nodes}==names
metadata_ns={};exec(compile(ast.Module(body=metadata_nodes,type_ignores=[]),str(source/'python/scene_adapter.py'),'exec'),metadata_ns)
with tempfile.TemporaryDirectory() as directory:
    model_path=Path(directory)/'source.xml'
    model_path.write_text('<mujoco><worldbody><body name="base"><geom size=".04" mass="1"/><body name="elbow"><joint name="hinge" axis="0 0 1"/><geom size=".04" mass="1"/><body name="tip" pos="1 0 0"><geom size=".04" mass="1"/></body></body></body></worldbody><keyframe><key name="home" qpos=".7"/></keyframe></mujoco>')
    declared=model_path.read_bytes();metadata=metadata_ns['mjcf_metadata'](str(model_path),{'initialJointPositions':{'hinge':-.2}})
    np.testing.assert_allclose(metadata['initialBodyPoses']['tip']['positionM'],[np.cos(-.2),np.sin(-.2),0],atol=1e-12)
    assert metadata['joints']['hinge']['home']==-.2 and model_path.read_bytes()==declared
rows.append({'case':'actual-source-home-FK','explicitHomeRad':-.2,'sourceBytesPreserved':True,'physicsSteps':0})

# 跨机构安装用源 home 的 FK，不使用零关节 USD 链；当前根安装变换仍来自真实 stage。
stage=Usd.Stage.CreateInMemory();model=matrix([1.2,-.4,.8],[0,0,1],31)
container=UsdGeom.Xform.Define(stage,'/World/parent');container.AddTransformOp().Set(model)
base=UsdGeom.Xform.Define(stage,'/World/parent/base');UsdPhysics.RigidBodyAPI.Apply(base.GetPrim())
hand=UsdGeom.Xform.Define(stage,'/World/parent/hand');hand.AddTranslateOp().Set(Gf.Vec3d(1,0,0));UsdPhysics.RigidBodyAPI.Apply(hand.GetPrim())
entry={'path':'/World/parent','metadata':{'bodies':{'base':{'parent':None},'hand':{'parent':'base'}},'rootBodies':[{'bodyName':'base'}],
    'initialBodyPoses':{'base':{'positionM':[0,0,0],'quaternionXyzw':[0,0,0,1]},'hand':{'positionM':[0,1,0],'quaternionXyzw':[0,0,np.sqrt(.5),np.sqrt(.5)]}}}}
actual=authoring.initialized_parent_body_world(stage,entry,hand.GetPrim(),'hand',SceneError)
expected=matrix([0,1,0],[0,0,1],90)*model
np.testing.assert_allclose(np.asarray(actual),np.asarray(expected),atol=1e-12)
assert not np.allclose(np.asarray(actual),np.asarray(UsdGeom.XformCache().GetLocalToWorldTransform(hand.GetPrim())))
rows.append({'case':'parent-source-home-FK','usesSourceHomeInsteadOfUsdZero':True,'actualWorldPositionM':state(actual)[0]})

# 只替代 SDK 的 JointState schema 接口，USD/Gf 与 Drive API 仍是真库；不签 PhysX 动作。
import pxr
class StateApi:
    def __init__(self,prim,axis):self.prim=prim;self.axis=axis
    @classmethod
    def Apply(cls,prim,axis):return cls(prim,axis)
    def CreatePositionAttr(self):return self.prim.CreateAttribute('state:'+self.axis+':physics:position',__import__('pxr.Sdf',fromlist=['ValueTypeNames']).ValueTypeNames.Double)
    def CreateVelocityAttr(self):return self.prim.CreateAttribute('state:'+self.axis+':physics:velocity',__import__('pxr.Sdf',fromlist=['ValueTypeNames']).ValueTypeNames.Double)
pxr.PhysxSchema=types.SimpleNamespace(JointStateAPI=StateApi)
stage=Usd.Stage.CreateInMemory();UsdGeom.Xform.Define(stage,'/World/arm')
r=UsdPhysics.RevoluteJoint.Define(stage,'/World/arm/elbow');p=UsdPhysics.PrismaticJoint.Define(stage,'/World/arm/finger')
dr=UsdPhysics.DriveAPI.Apply(r.GetPrim(),UsdPhysics.Tokens.angular);dr.CreateStiffnessAttr().Set(42);dr.CreateDampingAttr().Set(5)
dp=UsdPhysics.DriveAPI.Apply(p.GetPrim(),UsdPhysics.Tokens.linear);dp.CreateStiffnessAttr().Set(12)
entry={'path':'/World/arm','metadata':{'joints':{'elbow':{'type':'hinge','home':.6},'finger':{'type':'slide','home':.025}}}}
authoring.author_source_joint_initial_state(stage,entry,SceneError)
np.testing.assert_allclose(r.GetPrim().GetAttribute('state:angular:physics:position').Get(),np.degrees(.6),atol=1e-12)
np.testing.assert_allclose(p.GetPrim().GetAttribute('state:linear:physics:position').Get(),.025,atol=1e-12)
np.testing.assert_allclose(dr.GetTargetPositionAttr().Get(),np.degrees(.6),atol=1e-5)
assert dr.GetStiffnessAttr().Get()==42 and dr.GetDampingAttr().Get()==5 and dp.GetStiffnessAttr().Get()==12
rows.append({'case':'source-home-joint-state-before-warm','angularStateDeg':r.GetPrim().GetAttribute('state:angular:physics:position').Get(),'linearStateM':.025,'gainsPreserved':True})

# 被动关节同样有源初态，但不能因此新增执行器或 drive。
passive=UsdPhysics.RevoluteJoint.Define(stage,'/World/arm/passive')
entry['metadata']['joints']['passive']={'type':'hinge','home':-.2}
authoring.author_source_joint_initial_state(stage,entry,SceneError)
assert not passive.GetPrim().HasAPI(UsdPhysics.DriveAPI,UsdPhysics.Tokens.angular)
assert not passive.GetPrim().GetAttribute('drive:angular:physics:targetPosition').IsValid()
rows.append({'case':'passive-state-does-not-create-drive','driveAdded':False})

print(json.dumps({'status':'REAL_USD_ORIGIN_CONTRACT_PASS','scope':'Real USD/Gf contract; not Kit/PhysX/GUI','cases':rows}))
