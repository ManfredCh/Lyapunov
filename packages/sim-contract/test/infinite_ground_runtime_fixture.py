"""011：同一Scene真实CPU落球正负对照；只加载目标worker，不启动协议主循环。"""
import copy
import importlib.util
import json
from pathlib import Path
import sys

engine,root_path,scene_path=sys.argv[1:4]
root=Path(root_path);path=root/('packages/sim-'+engine+'/python/worker.py')
sys.path.insert(0,str(path.parent))
spec=importlib.util.spec_from_file_location('ground_runtime_worker',path)
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
worker.emit=lambda value:None
payload=json.loads(Path(scene_path).read_text())
options={'worldId':'ground-runtime-'+engine,'clock':'realtime','timestepS':.002,'ground':True,'device':'cpu'}
value=worker.World(payload['default'],options)
evidence={'engine':engine,'device':'cpu','worldId':value.id,'positionXY':[1234.,-987.],'checks':{}}

def sample(world):
    contacts=0
    for _ in range(1000):
        world.tick()
        contacts+=int(world.data.ncon)if engine=='mujoco'else int(world.contacts.rigid_contact_count.numpy()[0])
    frame=world.observe()
    height=next(entity['transform']['position'][2]for entity in frame['entities']if entity['entityId']=='ball')
    return {'heightM':height,'contactSamples':contacts,'generation':frame['generation'],'sceneRevision':frame['sceneRevision'],'stepIndex':frame['stepIndex'],'worldPhysics':frame['worldPhysics']}

try:
    if engine=='mujoco':
        planes=[i for i in range(value.model.ngeom)if value.model.geom_type[i]==worker.mj.mjtGeom.mjGEOM_PLANE]
        assert len(planes)==1,planes
        assert value.model.geom_size[planes[0]][:2].tolist()==[0.,0.]
    else:
        planes=[i for i,t in enumerate(value.model.shape_type.numpy())if int(t)==int(worker.newton.GeoType.PLANE)]
        assert len(planes)==1,planes
        assert value.model.shape_scale.numpy()[planes[0]][:2].tolist()==[0.,0.]
    baseline=sample(value)
    assert .08<baseline['heightM']<.14,baseline
    assert baseline['contactSamples']>0,baseline
    assert abs(baseline['worldPhysics']['gravityWorldMps2'][2]+3)<1e-5,baseline
    assert len(baseline['worldPhysics']['groundSources'])==1,baseline
    evidence['checks']['default']=baseline
    value.sync(payload['hidden'])
    hidden=sample(value)
    assert hidden['generation']==baseline['generation'],hidden
    assert .08<hidden['heightM']<.14 and hidden['contactSamples']>0,hidden
    evidence['checks']['hidden']=hidden
    value.sync(payload['deleted'])
    deleted=sample(value)
    assert deleted['heightM']<-4 and deleted['contactSamples']==0,deleted
    assert not deleted['worldPhysics']['groundSources'],deleted
    evidence['checks']['deleted']=deleted
finally:
    value.close()

reopened=worker.World(payload['deleted'],{**options,'worldId':'ground-runtime-reopen-'+engine})
try:
    result=sample(reopened)
    assert result['heightM']<-4 and result['contactSamples']==0,result
    assert not result['worldPhysics']['groundSources'],result
    evidence['checks']['reopenedDeleted']=result
finally:
    reopened.close()

native_cases=[
    ('nativeGroundNoDuplicate','<geom name="sourcefloor" type="plane" size="5 5 .1"/>',1,.1),
    ('nativeStaticChildNoDuplicate','<body name="floor_holder" pos="0 0 .25"><geom name="sourcefloor" type="plane" pos="0 0 -.25" size="5 5 .1"/></body>',1,.1),
    ('nativeElevatedChildPreservesTemplate','<body name="floor_holder" pos="0 0 .25"><geom name="sourcefloor" type="plane" size="5 5 .1"/></body>',2,.35),
]
for name,xml,expected_planes,height in native_cases:
    native=copy.deepcopy(payload['default']);native['sceneId']=name+'-'+engine
    native['entities'].append({'entityId':'native','name':'Native world','resources':[],'transform':{'position':[0,0,0],'quaternion':[0,0,0,1],'scale':[1,1,1]},'components':{'mujoco':{'xml':'<mujoco><worldbody>'+xml+'</worldbody></mujoco>'}}})
    native_world=worker.World(native,{**options,'worldId':'ground-runtime-'+name+'-'+engine})
    try:
        result=sample(native_world)
        if engine=='mujoco':plane_count=sum(native_world.model.geom_type==worker.mj.mjtGeom.mjGEOM_PLANE)
        else:plane_count=sum(int(t)==int(worker.newton.GeoType.PLANE)for t in native_world.model.shape_type.numpy())
        assert int(plane_count)==expected_planes,(name,plane_count)
        assert abs(result['heightM']-height)<.04 and result['contactSamples']>0,result
        if expected_planes==1:
            assert result['worldPhysics']['groundSources'][0]['source']=='native-plane',result
            assert len(result['worldPhysics']['groundSources'])==1,result
        else:
            assert any(source.get('entityId')=='lyapunov-default-ground'for source in result['worldPhysics']['groundSources']),result
        result['planeCount']=int(plane_count)
        evidence['checks'][name]=result
    finally:
        native_world.close()

evidence['passed']=True
print(json.dumps(evidence),file=getattr(worker,'_PROTOCOL_OUT',sys.stdout),flush=True)
