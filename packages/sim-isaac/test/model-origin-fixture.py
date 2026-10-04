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
print(json.dumps({'status':'REAL_USD_ORIGIN_CONTRACT_PASS','scope':'Real USD/Gf contract; not Kit/PhysX/GUI','cases':rows}))
