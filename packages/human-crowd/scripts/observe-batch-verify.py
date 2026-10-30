"""同一当前World的全部人体观测，对照原Mju标量或显式冻结模块；不作容量RTF。"""
import argparse,copy,hashlib,importlib.util,json,math,sys
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'sim-mujoco/python'))
import worker
worker.emit=lambda _:None;worker.emit_text=lambda _:None
p=argparse.ArgumentParser();p.add_argument('--scene',required=True);p.add_argument('--out',required=True);p.add_argument('--reference-human');args=p.parse_args();reference=worker.human
if args.reference_human:
 path=Path(args.reference_human).resolve();spec=importlib.util.spec_from_file_location('frozen_observe_reference',path);reference=importlib.util.module_from_spec(spec);spec.loader.exec_module(reference)

# 四元数符号也必须相同；覆盖单位/精确pi/近pi/trace边界/任意合法根，不只比旋转等价。
rng=np.random.default_rng(42);qs=rng.normal(size=(10000,4));qs/=np.linalg.norm(qs,axis=1)[:,None];edges=[]
for axis in [[1,0,0],[0,1,0],[0,0,1],[1,1,1],[1,-1,0],[-2,1,-3]]:
 axis=np.asarray(axis,dtype=float);axis/=np.linalg.norm(axis)
 for angle in [0,math.pi,math.pi-1e-12,math.pi+1e-12,2*math.pi/3-1e-12,2*math.pi/3,2*math.pi/3+1e-12]:edges.append([math.cos(angle/2),*(axis*math.sin(angle/2))])
qs=np.concatenate((qs,edges,-np.asarray(edges)));matrices=np.empty((len(qs),9))
for i,q in enumerate(qs):worker.mj.mju_quat2Mat(matrices[i],q)
expected=np.asarray(reference.observed_quaternions(matrices));actual=np.asarray(worker.human.observed_quaternions_batch(matrices));matrix_error=float(np.max(np.abs(expected-actual)));assert matrix_error<1e-12,matrix_error
for n in [0,1,14,81,255,256]:
 assert np.max(np.abs(np.asarray(reference.observed_quaternions(matrices[:n]))-np.asarray(worker.human.observed_quaternions_batch(matrices[:n]))),initial=0)<1e-12

scene=json.loads(Path(args.scene).read_text());people=[e for e in scene['entities']if e.get('components',{}).get('human')];assert len(people)>=3
rag=copy.deepcopy(people[0]);rag['entityId']='observe-ragdoll';rag['transform']['position']=[50,50,0];rag['components']['human']['mode']='ragdoll';scene['entities'].append(rag)
w=worker.World(scene,{'worldId':'observe-compare','clock':'manual','timestepS':.002,'ground':True,'frameRateHz':.001});errors={'fields':0.,'nativeReadback':0.};checks=[];count=0
def compare(a,b):
 if isinstance(a,dict):
  assert a.keys()==b.keys(),(a.keys(),b.keys())
  for key in a:compare(a[key],b[key])
 elif isinstance(a,list):
  assert len(a)==len(b)
  for x,y in zip(a,b):compare(x,y)
 elif isinstance(a,(int,float))and not isinstance(a,bool):errors['fields']=max(errors['fields'],abs(a-b))
 else:assert a==b,(a,b)
def check(selection=None):
 global count
 frame=w.observe(selection);only=(selection or{}).get('entityIds');expected_ids=[e['entityId']for e in w.scene['entities']if not only or e['entityId']in only];assert [e['entityId']for e in frame['entities']]==expected_ids
 for entity in frame['entities']:
  if not entity.get('humanPose'):continue
  info=w.info(entity['entityId']);pose=entity['humanPose'];compare(pose,reference.observe(w,info));assert pose['stepIndex']==frame['stepIndex']and pose['simTime']==frame['simTime'];count+=1
  for joint in pose['joints']:
   if info['human']['mode']=='kinematic':
    sid=w.model.site(info['prefix']+'joint/'+joint['name']).id;position=w.data.site_xpos[sid];q=np.empty(4);worker.mj.mju_mat2Quat(q,w.data.site_xmat[sid])
   else:
    bid=w.model.body(info['prefix']+'joint/'+joint['name']).id;position=w.data.xpos[bid];q=w.data.xquat[bid]
   errors['nativeReadback']=max(errors['nativeReadback'],float(np.max(np.abs(position-joint['positionM']))),float(np.max(np.abs(q[[1,2,3,0]]-joint['quaternionXyzw']))))
  for segment in pose['segments']:
   gid=w.model.geom(next(s['geomName']for s in info['humanSegments']if s['name']==segment['name'])).id;q=np.empty(4);worker.mj.mju_mat2Quat(q,w.data.geom_xmat[gid]);errors['nativeReadback']=max(errors['nativeReadback'],float(np.max(np.abs(w.data.geom_xpos[gid]-segment['positionM']))),float(np.max(np.abs(q[[1,2,3,0]]-segment['quaternionXyzw']))),abs(segment['radiusM']-w.model.geom_size[gid,0]),abs(segment['halfLengthM']-w.model.geom_size[gid,1]))
 return frame
try:
 motions=[]
 for e in people:
  cfg=w.info(e['entityId'])['human'];names=[c['name']for c in cfg['clips']];clip='WalkGrounded'if 'WalkGrounded'in names else names[0];position=e['transform']['position'];motions.append({'kind':'human','entityId':e['entityId'],'durationS':.06,'route':{'pointsM':[[position[0]+1,position[1],position[2]]],'speedMps':1.,'behavior':'walk','clip':clip}})
 w.execute({'kind':'batch','actionId':'observe-walk','expectedGeneration':w.generation,'motions':motions});check()
 for _ in range(30):w.tick();check()
 checks.append('运动/末步/混ragdoll与冻结标量全字段及原生名字查找读回')
 for selection in [{'entityIds':[people[-1]['entityId'],people[0]['entityId']]},{'entityIds':['observe-ragdoll']},{'entityIds':[]},None]:check(selection)
 checks.append('selection子集/重排/空选择及恢复全部')
 # 显式测试刺激：同一物理step内写native派生数组后再次observe，不推进或改控制目标。
 info=w.info(people[0]['entityId']);sid=next(iter(info['humanJointSiteIds'].values()));gid=info['humanSegments'][0]['geomId'];bid=w.info('observe-ragdoll')['body'];saved=[w.data.site_xpos[sid].copy(),w.data.site_xmat[sid].copy(),w.data.geom_xpos[gid].copy(),w.data.geom_xmat[gid].copy(),w.model.geom_size[gid].copy(),w.data.xpos[bid].copy(),w.data.xquat[bid].copy()];step=w.step_index;now=w.data.time
 w.data.site_xpos[sid]+=[.123,.234,.345];w.data.geom_xpos[gid]+=[-.321,.2,.17];w.model.geom_size[gid,:2]+=[.001,.002];w.data.xpos[bid]+=[.3,.2,.1];w.data.xquat[bid]=[-.5,.5,-.5,.5];worker.mj.mju_quat2Mat(w.data.site_xmat[sid],np.array([.5,-.5,.5,.5]));worker.mj.mju_quat2Mat(w.data.geom_xmat[gid],np.array([0.,1.,0.,0.]));changed=check();assert w.step_index==step and w.data.time==now;assert next(j for e in changed['entities']if e['entityId']==people[0]['entityId']for j in e['humanPose']['joints'])['positionM']==w.data.site_xpos[sid].tolist()
 w.data.site_xpos[sid],w.data.site_xmat[sid],w.data.geom_xpos[gid],w.data.geom_xmat[gid],w.model.geom_size[gid],w.data.xpos[bid],w.data.xquat[bid]=saved;check();checks.append('同step显式native位置/矩阵/尺寸/有符号ragdoll xquat变更立即可见')
 old_model=w.model;old_identity=w._human_observe_layout['identity'];changed_scene=copy.deepcopy(scene);changed_scene['revision']+=1;changed_scene['entities'].reverse();w.sync(changed_scene,force=True);check();assert w.generation==2 and w.model is not old_model and w._human_observe_layout['identity']!=old_identity;checks.append('sync换model/成员重排重新绑定原生索引')
 assert errors['fields']<1e-12 and errors['nativeReadback']<1e-12,errors
 report={'status':'PASSED','matrixSamples':len(qs),'matrixMaxAbsDifference':matrix_error,'observedActors':count,'checks':checks,'maxErrors':errors,'source':'每次现读本World native data/model，无pose结果缓存','reference':args.reference_human or'保留的原Mju标量observe','stepsAfterSync':w.step_index,'generation':w.generation}
finally:w.close()
report['closed']=w.status=='closed';report['sceneSha256']=hashlib.sha256(Path(args.scene).read_bytes()).hexdigest();report['humanSha256']=hashlib.sha256(Path(worker.human.__file__).read_bytes()).hexdigest();report['referenceSha256']=hashlib.sha256(Path(args.reference_human).read_bytes()).hexdigest()if args.reference_human else None;Path(args.out).write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False))
