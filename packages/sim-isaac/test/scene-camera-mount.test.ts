/** R015：真实 USD 装配和 AST 抽取的 worker 标定，未启动 Kit/PhysX/RTX。 */
import {describe, expect, test} from 'bun:test'
import {spawnSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const HERE=dirname(fileURLToPath(import.meta.url))
const ROOT=resolve(HERE,'../../..')
const PY=process.env.LYAPUNOV_ISAAC_PY??resolve(ROOT,'.runtime/conda/envs/isaac/bin/python')
const FLOOR_PROBE=String.raw`
import ast,copy,json,sys,tempfile
from pathlib import Path
import numpy as np
from pxr import Gf,Usd,UsdGeom,UsdPhysics
root=Path(sys.argv[1]);sys.path.insert(0,str(root/'python'))
tree=ast.parse((root/'python/scene_adapter.py').read_text())
wanted={'enum_name','object_name','mjcf_metadata','_scalar_joint_types','verified_native_ground_names'}
nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name in wanted]
assert set(n.name for n in nodes)==wanted
ns={'np':np,'Gf':Gf,'Usd':Usd,'UsdGeom':UsdGeom,'UsdPhysics':UsdPhysics}
exec(compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])),'scene_adapter.py','exec'),ns)
rows=[]
with tempfile.TemporaryDirectory(prefix='a08-source-floor-')as directory:
 for label,geom,position,rotation,enabled,expected in [
  ('source-world-plane','<geom name="support" type="plane" size="3 3 .1"/>',[0,0,0],0,True,['support']),
  ('named-floor-box','<geom name="floor" type="box" size="3 3 .1"/>',[0,0,0],0,True,[]),
  ('vertical-source-plane','<geom name="floor" type="plane" quat=".7071067811865476 .7071067811865476 0 0" size="3 3 .1"/>',[0,0,0],0,True,[]),
  ('lifted-source-plane','<geom name="floor" type="plane" pos="0 0 .2" size="3 3 .1"/>',[0,0,0],0,True,[]),
  ('shifted-installation','<geom name="support" type="plane" size="3 3 .1"/>',[0,0,.2],0,True,[]),
  ('rotated-installation','<geom name="support" type="plane" size="3 3 .1"/>',[0,0,0],90,True,[]),
  ('actual-collision-disabled','<geom name="support" type="plane" size="3 3 .1"/>',[0,0,0],0,False,[]),
  ('model-without-plane','<body name="arm"><geom name="link" type="box" size=".1 .1 .1"/></body>',[0,0,0],0,True,[]),
 ]:
  source=Path(directory)/(label+'.xml');source.write_text('<mujoco><worldbody>'+geom+'</worldbody></mujoco>')
  metadata=ns['mjcf_metadata'](str(source),{})
  stage=Usd.Stage.CreateInMemory();mount=UsdGeom.Xform.Define(stage,'/World/robot')
  mount.AddTranslateOp().Set(Gf.Vec3d(*position));mount.AddRotateXOp().Set(rotation)
  for name,definition in metadata['geoms'].items():
   path='/World/robot/native/'+name;cube=UsdGeom.Cube.Define(stage,path)
   UsdPhysics.CollisionAPI.Apply(cube.GetPrim()).CreateCollisionEnabledAttr(enabled);definition['nativePaths']=[path]
  actual=ns['verified_native_ground_names'](stage,{'path':'/World/robot','metadata':metadata})
  assert actual==expected,(label,actual,expected)
  rows.append({'case':label,'names':actual,'source':metadata['geoms']})
from world_physics import replaceable_standard_ground
ground={'entityId':'g','transform':{'position':[0,0,-.05],'quaternion':[0,0,0,1],'scale':[1,1,1]},'components':{'supportSurface':{'source':'scene-template','template':'physics-workspace-v1'},'collision':{'shape':'box','halfExtents':[10,10,.05],'friction':[1.2,.08,.01]},'rigidBody':{'type':'static'}}}
scene={'physics':{'template':'physics-workspace-v1','groundEntityId':'g'}}
assert replaceable_standard_ground(scene,ground)
for field,value in [('parentId','moved-parent'),('transform',{'position':[1,0,-.05],'quaternion':[0,0,0,1],'scale':[1,1,1]})]:
 changed=copy.deepcopy(ground);changed[field]=value;assert not replaceable_standard_ground(scene,changed)
changed=copy.deepcopy(ground);changed['components']['collision']['enabled']=False;assert not replaceable_standard_ground(scene,changed)
print(json.dumps({'cases':rows,'editedTemplateKept':True}))
`
const PROBE=String.raw`
import ast, copy, json, math, sys
from pathlib import Path
from pxr import Gf,Sdf,Tf,Usd,UsdGeom,UsdPhysics
sys.path.insert(0,str(Path(sys.argv[1])/'python'))
from camera_math import intrinsics_from_fovy

root=Path(sys.argv[1])
def source_functions(path,module_names=(),methods=()):
    tree=ast.parse(path.read_text());selected=[]
    for node in tree.body:
        if isinstance(node,(ast.FunctionDef,ast.ClassDef)) and node.name in module_names:selected.append(node)
        if isinstance(node,ast.ClassDef) and node.name=='World':
            selected.extend(item for item in node.body if isinstance(item,ast.FunctionDef) and item.name in methods)
    assert set(node.name for node in selected)==set(module_names)|set(methods)
    return ast.fix_missing_locations(ast.Module(body=selected,type_ignores=[]))

ns={'Gf':Gf,'Sdf':Sdf,'Tf':Tf,'Usd':Usd,'UsdGeom':UsdGeom,'UsdPhysics':UsdPhysics,'math':math,'copy':copy,'rendering':False,'intrinsics_from_fovy':intrinsics_from_fovy}
names={'SceneError','poses','native_cameras','camera_mount_bodies','camera_vector','camera_pose','scene_cameras'}
exec(compile(source_functions(root/'python/scene_adapter.py',names),str(root/'python/scene_adapter.py'),'exec'),ns)
methods={'resolve_camera_name','camera_list','_camera_frame_identity','_append_camera_observation','_camera_resolution','_camera_entity','_camera_prim','_camera_parent_world_matrix','_native_world_matrix','_camera_parent_body_name','_vec3','_quaternion_xyzw','_matrix_from_pose','_camera_world_rotation','_camera_pose_receipt','_camera_source_snapshot','_camera_source_fovy','_camera_effective_fovy','_set_camera_local_matrix','_restore_camera_snapshot','_camera_override_world_matrix','_apply_camera_override','_camera_readback','_convert_camera_override','clear_camera_overrides','camera_adjust'}
exec(compile(source_functions(root/'python/worker.py',module_names={'finite'},methods=methods),str(root/'python/worker.py'),'exec'),ns)
World=type('World',(),{name:ns[name] for name in methods})
transform=lambda p=[0,0,0],q=[0,0,0,1]:{'position':p,'quaternion':q,'scale':[1,1,1]}
entity=lambda eid,components={}: {'entityId':eid,'name':eid,'transform':transform(),'resources':[],'components':components}
def world_scene(mount=None,reverse=False,intrinsics=None):
    stage=Usd.Stage.CreateInMemory();UsdGeom.Xform.Define(stage,'/World')
    robot=UsdGeom.Xform.Define(stage,'/World/robot');robot.GetPrim().GetReferences().AddReference(str(root/'fixtures/moving-camera-light.usda'))
    # 官方 MJCF 产物里的 link/link 视觉别名模式：同名且源 metadata 有该名字，但没有刚体 schema。
    UsdGeom.Xform.Define(stage,'/World/robot/wrist/wrist')
    UsdGeom.Xform.Define(stage,'/World/camera')
    camera={'name':'eye','fovYDeg':55,'width':800,'height':600}
    if mount is not None:camera['mount']=mount
    if intrinsics is not None:camera['intrinsics']=intrinsics
    robot_entity=entity('robot');cam_entity=entity('cam',{'camera':camera});cam_entity['transform']=transform([2,-1,3],[0,0,math.sin(.3),math.cos(.3)])
    rows=[robot_entity,cam_entity] if not reverse else [cam_entity,robot_entity]
    snapshot={'sceneId':'scene','revision':8,'entities':rows}
    records={'robot':{'entity':robot_entity,'path':'/World/robot','metadata':{'bodies':{'base':{},'wrist':{}}},'cameras':ns['native_cameras'](stage,robot.GetPrim(),{}),'rigidPaths':['/World/robot/base','/World/robot/wrist'],'articulation':None},
             'cam':{'entity':cam_entity,'path':'/World/camera','metadata':{},'cameras':{},'rigidPaths':[],'articulation':None}}
    ns['scene_cameras'](stage,snapshot,records,ns['poses'](snapshot))
    world=World();world.id='w';world.generation=3;world.revision=8;world.index=7;world.sim_time=.014;world.stage=stage;world.entities=records;world.camera_overrides={};world.ready=lambda:None
    return world

mount={'entityId':'robot','bodyName':'wrist','positionM':[.12,-.07,.21],'quaternionXyzw':[0,0,math.sin(.2),math.cos(.2)]}
world=world_scene(mount,reverse=True);listing=world.camera_list();camera=next(item for item in listing['cameras'] if item['cameraName']=='cam/eye')
native=next(item for item in listing['cameras'] if item['cameraSource']=='usd')
assert native['cameraName']=='robot/wrist/native_cam'
assert camera['parentEntityId']=='robot' and camera['parentBodyName']=='wrist'
assert camera['mount']==mount and camera['referenceResolution']==[800,600]
assert {item['bodyName'] for item in listing['bodies']}=={'base','wrist'}
assert camera['worldGeneration']==3 and camera['appliedSceneRevision']==8 and camera['frameId']=='w:3:7'
try:world.camera_adjust({'cameraName':'robot/wrist/native_cam','expectedGeneration':3,'positionM':[0,0,0]});raise AssertionError('不支持的原生变换op被覆盖')
except ns['SceneError'] as e:assert e.code=='UNSUPPORTED_CAMERA_MODEL'
assert '/World/robot/wrist/native_cam' not in world.camera_overrides
assert next(item for item in world.camera_list()['cameras'] if item['cameraName']=='robot/wrist/native_cam')['override'] is False
pose=lambda row:Gf.Matrix4d(*[v for values in row['matrix4x4'] for v in values])
diff=lambda a,b:max(abs(a[i][j]-b[i][j]) for i in range(4) for j in range(4))
initial=pose(camera['worldFromCamera']);parent=pose(camera['worldFromParent']);local=pose(camera['parentFromCamera'])
assert diff(initial,local*parent)<1e-12
body=UsdGeom.Xformable(world.stage.GetPrimAtPath('/World/robot/wrist'));body.ClearXformOpOrder()
body.AddTransformOp().Set(Gf.Matrix4d(1).SetRotate(Gf.Rotation(Gf.Vec3d(0,0,1),61)).SetTranslateOnly(Gf.Vec3d(.7,.25,.8)))
world.index=8;world.sim_time=.016
moving=next(item for item in world.camera_list()['cameras'] if item['cameraName']=='cam/eye')
follow_error=diff(pose(moving['worldFromCamera']),local*UsdGeom.XformCache().GetLocalToWorldTransform(body.GetPrim()))
assert follow_error<1e-12 and diff(initial,pose(moving['worldFromCamera']))>.1 and moving['frameId']=='w:3:8'
frame={**world._camera_frame_identity(),'entities':[{'entityId':'robot'},{'entityId':'cam'}]}
world._append_camera_observation(frame,{})
assert frame['cameras'][0]['frameId']==frame['frameId']
assert 'wrist' in frame['entities'][0]['sensors']['bodyWorldPoses']
assert diff(pose(frame['entities'][0]['sensors']['bodyWorldPoses']['wrist']),pose(moving['worldFromParent']))<1e-12
adjust=world.camera_adjust({'cameraName':'cam/eye','expectedGeneration':3,'referenceFrame':'parent','positionM':[.2,0,.1]})
assert max(abs(v-e) for v,e in zip(adjust['parentFromCamera']['positionM'],[.2,0,.1]))<1e-12,adjust
cleared=world.camera_adjust({'cameraName':'cam/eye','expectedGeneration':3,'clear':True})
assert diff(pose(cleared['calibration']['parentFromCamera']),local)<1e-12
try:world.camera_adjust({'cameraName':'cam/eye','expectedGeneration':2,'positionM':[0,0,0]});raise AssertionError('旧generation未拒绝')
except ns['SceneError'] as e:assert e.code=='STALE_GENERATION'

free=world_scene();free_camera=next(item for item in free.camera_list()['cameras'] if item['cameraName']=='cam/eye')
assert free_camera['parentBodyName']=='world' and free_camera['worldFromCamera']['positionM']==[2,-1,3]
errors={}
for key,bad in [('missingBody',{**mount,'bodyName':'head_does_not_exist'}),('missingEntity',{**mount,'entityId':'absent'}),('missingLocalPose',{'entityId':'robot','bodyName':'wrist'}),('badQuaternion',{**mount,'quaternionXyzw':[0,0,0,0]})]:
    try:world_scene(bad);raise AssertionError('无效mount被接受: '+key)
    except ns['SceneError'] as e:errors[key]=e.code
stage=world.stage;other=UsdGeom.Xform.Define(stage,'/World/robot/other/wrist');UsdPhysics.RigidBodyAPI.Apply(other.GetPrim())
try:ns['camera_mount_bodies'](stage,world.entities);raise AssertionError('真同名刚体索引未拒绝')
except ns['SceneError'] as e:errors['duplicateNativeIndex']=e.code
try:ns['scene_cameras'](stage,{'entities':[entity('otherCam',{'camera':{'fovYDeg':55,'mount':mount}})]},{**world.entities,'otherCam':{'path':'/World/new','metadata':{},'cameras':{}}},{'otherCam':Gf.Matrix4d(1)});raise AssertionError('歧义body被接受')
except ns['SceneError'] as e:errors['ambiguousBody']=e.code
K={'fx':700.,'fy':700.,'cx':387.25,'cy':284.5,'width':800,'height':600,'distortion':[0.,0.,0.,0.,0.]}
calibrated=world_scene(mount,intrinsics=K);actual=next(item for item in calibrated.camera_list()['cameras'] if item['cameraName']=='cam/eye')['intrinsics']
kerror=max(abs(actual[key]-K[key]) for key in ('fx','fy','cx','cy'))
assert kerror<2e-5
try:world_scene(mount,intrinsics={**K,'fy':900});raise AssertionError('非方形K被静默改写')
except ns['SceneError'] as e:errors['nonSquareK']=e.code
assert errors['missingBody']=='CAMERA_BODY_NOT_FOUND' and errors['missingEntity']=='CAMERA_BODY_NOT_FOUND'
assert errors['ambiguousBody']=='CAMERA_BODY_AMBIGUOUS'
# entity wrapper 和模型源根刚体可同名；只有模型实际刚体进入索引。
wrapped=Usd.Stage.CreateInMemory();UsdGeom.Xform.Define(wrapped,'/World/wrapped')
actual=UsdGeom.Xform.Define(wrapped,'/World/wrapped/native/wrapped');UsdPhysics.RigidBodyAPI.Apply(actual.GetPrim())
wrapper_bodies=ns['camera_mount_bodies'](wrapped,{'asset':{'path':'/World/wrapped','metadata':{'bodies':{'wrapped':{}}}}})
assert wrapper_bodies==[{'entityId':'asset','bodyName':'wrapped','bodyPath':'/World/wrapped/native/wrapped'}]
# 已装配的 Scene 静态碰撞根仍可挂载，不能靠删掉全部无 RigidBodyAPI 根来凑唯一性。
UsdGeom.Xform.Define(wrapped,'/World/static')
static_bodies=ns['camera_mount_bodies'](wrapped,{'static':{'path':'/World/static','collision':{'source':'scene-primitive'}}})
assert static_bodies==[{'entityId':'static','bodyName':'static','bodyPath':'/World/static'}]
print(json.dumps({'camera':camera,'native':native,'bodies':listing['bodies'],'frame':frame,'followMatrixError':follow_error,'declaredKError':kerror,'errors':errors,'freeCamera':free_camera,'wrapperBodies':wrapper_bodies,'staticBodies':static_bodies},allow_nan=False))
`

describe('R015 Isaac 原生 USD 相机装配与同帧标定（CPU）',()=>{
  test('A08 源编译plane、实际USD碰撞与安装世界位姿共同确认地面，保用户编辑',()=>{
    expect(existsSync(PY),'阻断：真实pxr/MuJoCo解释器不存在：'+PY).toBe(true)
    const child=spawnSync(PY,['-c',FLOOR_PROBE,resolve(HERE,'..')],{encoding:'utf8',timeout:30000})
    expect(child.status,child.stderr+child.stdout).toBe(0)
    const result=JSON.parse(child.stdout.trim());expect(result.cases).toHaveLength(8);expect(result.editedTemplateKept).toBe(true)
    expect(result.cases[0].source.support).toMatchObject({geomKind:'mjGEOM_PLANE',sourceBodyId:0,quaternionWxyz:[1,0,0,0]})
  })
  function report(){
    expect(existsSync(PY),'阻断：真实 pxr 的 Isaac Python 不存在：'+PY).toBe(true)
    const child=spawnSync(PY,['-c',PROBE,resolve(HERE,'..')],{encoding:'utf8',timeout:30000})
    expect(child.status,child.stderr+child.stdout).toBe(0)
    return JSON.parse(child.stdout.trim())
  }
  test('从实际 fixture 装配 Scene camera 与原生 USD 相机，返回真实 body 和本代次标定',()=>{
    const result=report()
    expect(result.camera.cameraSource).toBe('scene-camera')
    expect(result.camera.parentEntityId).toBe('robot')
    expect(result.native.cameraName).toBe('robot/wrist/native_cam')
    expect(result.bodies).toHaveLength(2)
    expect(result.camera).toMatchObject({generation:3,worldGeneration:3,sceneRevision:8,appliedSceneRevision:8,frameId:'w:3:7',stepIndex:7})
    expect(result.frame.cameras[0].frameId).toBe(result.frame.frameId)
  })
  test('真实 USD body 平移与旋转后，camera world pose 等于保存局部 pose × body matrix；override/clear 保留安装',()=>{
    const result=report()
    expect(result.followMatrixError).toBeLessThan(1e-12)
    expect(result.declaredKError).toBeLessThan(2e-5)
    expect(result.freeCamera.parentBodyName).toBe('world')
    expect(result.freeCamera.worldFromCamera.positionM).toEqual([2,-1,3])
  })
  test('缺失/歧义 body、缺失局部标定、无效 quaternion 与不支持的 K 均明确拒绝',()=>{
    const result=report()
    expect(result.errors).toEqual({missingBody:'CAMERA_BODY_NOT_FOUND',missingEntity:'CAMERA_BODY_NOT_FOUND',missingLocalPose:'INVALID_ARGUMENT',badQuaternion:'INVALID_ARGUMENT',duplicateNativeIndex:'CAMERA_BODY_AMBIGUOUS',ambiguousBody:'CAMERA_BODY_AMBIGUOUS',nonSquareK:'UNSUPPORTED_CAMERA_MODEL'})
  })
  test('视觉重名与 wrapper 别名不成为 body；真实源根与静态碰撞根保留',()=>{
    const result=report()
    expect(result.bodies.map((row:{bodyName:string})=>row.bodyName).sort()).toEqual(['base','wrist'])
    expect(result.wrapperBodies).toEqual([{entityId:'asset',bodyName:'wrapped',bodyPath:'/World/wrapped/native/wrapped'}])
    expect(result.staticBodies).toEqual([{entityId:'static',bodyName:'static',bodyPath:'/World/static'}])
  })
})
