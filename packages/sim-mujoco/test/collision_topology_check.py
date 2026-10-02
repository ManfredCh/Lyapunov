"""真 World/编译几何的离线夹具：只在独立进程创建世界，不修改用户世界或源资产。"""
import importlib.util
import json
import sys
from pathlib import Path
import mujoco as mj
import numpy as np

worker_path=Path(sys.argv[1]);panda=Path(sys.argv[2])
sys.path.insert(0,str(worker_path.parent))
spec=importlib.util.spec_from_file_location('collision_test_worker',worker_path)
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)

def node(eid,components,position=(0,0,0),scale=(1,1,1),quaternion=(0,0,0,1)):
 return {'entityId':eid,'name':eid,'transform':{'position':list(position),'quaternion':list(quaternion),'scale':list(scale)},'resources':[],'components':components}

scene={'sceneId':'actual-collider-fixture','revision':7,'coordinates':{'units':'m','upAxis':'Z','handedness':'right','quaternion':'xyzw'},'entities':[
 node('cube',{'collision':{'shape':'box','halfExtents':[.5,.5,.5]}},(.1,.2,.75),(.06,.06,.06)),
 node('floor',{'collision':{'shape':'box','halfExtents':[.5,.5,.5]}},(0,0,.02),(2,1.5,.04)),
 node('capsule',{'collision':{'shape':'capsule','halfExtents':[.04,.12,0]}},(-1,0,.5)),
 node('cylinder',{'collision':{'shape':'cylinder','halfExtents':[.05,.15,0]}},(-1,.3,.5)),
 node('sphere',{'collision':{'shape':'sphere','halfExtents':[.07,0,0]}},(-1,.6,.5)),
 node('ellipsoid',{'collision':{'shape':'sphere','halfExtents':[.07,0,0]}},(-1,.9,.5),(1,2,3)),
 node('arm',{'mujoco':{'sourcePath':str(panda)}},(.3,0,.04)),
 node('visual-only',{'visual':{'kind':'splat'}}),
]}
world=worker.World(scene,{'clock':'manual','worldId':'collision-test-world','ground':True})
ids=[e['entityId'] for e in scene['entities']]
frame=world.observe({'collisionTopology':{'entityIds':ids,'includeGeometry':True}})
topology=frame['collisionTopology'];assert topology['source']=='mujoco-compiled'
assert any(g.get('entityId')=='arm' and g['geometry']['kind']=='convex-hull' for g in topology['geoms'])
assert not any(g.get('entityId')=='visual-only' for g in topology['geoms'])
truth=[]
for g in topology['geoms']:
 gid=g['geomId'];size=world.model.geom_size[gid].tolist();kind=int(world.model.geom_type[gid])
 np.testing.assert_allclose(g['positionM'],world.data.geom_xpos[gid],atol=1e-12)
 quat=np.array([g['quaternionXyzw'][3],*g['quaternionXyzw'][:3]]);matrix=np.zeros(9);mj.mju_quat2Mat(matrix,quat)
 np.testing.assert_allclose(matrix,world.data.geom_xmat[gid],atol=1e-12)
 row={'geomId':gid,'kind':kind,'sizeM':size,'positionM':world.data.geom_xpos[gid].tolist(),'matrix':world.data.geom_xmat[gid].tolist()}
 if kind==int(mj.mjtGeom.mjGEOM_MESH):
  mesh=int(world.model.geom_dataid[gid]);at=int(world.model.mesh_vertadr[mesh]);n=int(world.model.mesh_vertnum[mesh]);vertices=world.model.mesh_vert[at:at+n]
  geometry=g['geometry'];assert geometry['kind']=='convex-hull',geometry
  np.testing.assert_allclose(np.asarray(geometry['vertices']).reshape(-1,3),vertices,atol=1e-12)
  assert all(0<=i<n for i in geometry['indices']),('凸包索引不属于该mesh',mesh,n)
  matrix=world.data.geom_xmat[gid].reshape(3,3);corners=(matrix@vertices.T).T+world.data.geom_xpos[gid]
  row['boundsM']=[corners.min(axis=0).tolist(),corners.max(axis=0).tolist()]
 truth.append(row)
warm=world.observe({'collisionTopology':{'entityIds':ids,'includeGeometry':False}})['collisionTopology']
assert not warm['geometryIncluded'] and all('geometry' not in g for g in warm['geoms'])
cube=next(g for g in topology['geoms'] if g.get('entityId')=='cube')
np.testing.assert_allclose(cube['geometry']['sizeM'],[.03,.03,.03],atol=1e-12)
floor=next(g for g in topology['geoms'] if g.get('entityId')=='floor')
np.testing.assert_allclose(floor['geometry']['sizeM'],[1,.75,.02],atol=1e-12)
world.step_index+=1;world.model.opt.gravity[:]=0;world.data.qpos[0]+=.1;mj.mj_forward(world.model,world.data)
moved=world.observe({'collisionTopology':{'entityIds':['arm'],'includeGeometry':False}})['collisionTopology']
world.sync({**scene,'revision':8},initial=False)
revised=world.observe({'collisionTopology':{'entityIds':['cube'],'includeGeometry':True}})['collisionTopology']
assert revised['sceneRevision']==8
patch_scene={'sceneId':'room-patch','revision':1,'coordinates':scene['coordinates'],'entities':[node('room',{'visual':{'kind':'splat'}})]}
patches={'entityId':'room','sourceKey':'synthetic-explicit-binding','frame':'mujoco-z-up-meters','suppressDefaultGround':True,
 'ground':{'kind':'hfield','name':'room-ground','nrow':2,'ncol':2,'origin':[0,0,0],'size':[1,1,.1,.01],'elevation':[0,0,0,0]},
 'walls':[{'center':[.3,.4,.5],'halfExtents':[.1,.2,.3]}],'catchNetZ':-2,'warnings':[]}
patch_world=worker.World(patch_scene,{'clock':'manual','worldId':'patch-world'},patches)
patch_frame=patch_world.observe({'collisionTopology':{'entityIds':['room'],'includeGeometry':True}})['collisionTopology']
assert len(patch_frame['geoms'])==3 and all(g.get('entityId')=='room' for g in patch_frame['geoms'])
assert any(g['geometry']['kind']=='unsupported' and g['ground'] for g in patch_frame['geoms'])
print(json.dumps({'scene':scene,'handle':{**world.handle(),'appliedSceneRevision':7,'worldGeneration':topology['generation']},'topology':topology,'truth':truth,'warm':warm,'moved':moved,'revised':revised,'mujocoVersion':mj.__version__,'patchScene':patch_scene,'patchHandle':patch_world.handle(),'patchTopology':patch_frame},allow_nan=False))
