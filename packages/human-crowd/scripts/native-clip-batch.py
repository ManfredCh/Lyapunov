"""外部原始clip整组提交与Mju标量原语对照；冻结a089独立进程对照另由显式--worker-root快照入口执行。"""
import argparse,copy,json,sys,time,os
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'sim-mujoco'/'python'));import worker
worker.emit=lambda _:None;worker.emit_text=lambda _:None
p=argparse.ArgumentParser();p.add_argument('scene');p.add_argument('--output',required=True);p.add_argument('--clip',default='walk');p.add_argument('--without-robot',action='store_true');a=p.parse_args();scene=json.loads(Path(a.scene).read_text());people=[e for e in scene['entities']if e.get('components',{}).get('human')];assert len(people)==20
if a.without_robot:scene['entities']=[e for e in scene['entities']if e['entityId']!='panda']
scene['entities'].append({'entityId':'dynamic-box','name':'test-box','transform':{'position':[.3,0,.9],'quaternion':[0,0,0,1],'scale':[1,1,1]},'resources':[],'components':{'collision':{'shape':'box','halfExtents':[.1,.1,.2]},'rigidBody':{'type':'dynamic','massKg':1,'gravityEnabled':False}}})
for i,e in enumerate(people):e['transform']['position']=[i%5*2.,i//5*2.,0];e['components']['human']['phase']=(i*.61803398875)%1
left=worker.World(scene,{'worldId':'batch','clock':'manual','ground':True,'timestepS':.002,'frameRateHz':1});device=os.environ.get('LYAPUNOV_HUMAN_COMPUTE_DEVICE');os.environ['LYAPUNOV_HUMAN_COMPUTE_DEVICE']='cpu'
try:right=worker.World(scene,{'worldId':'scalar','clock':'manual','ground':True,'timestepS':.002,'frameRateHz':1})
finally:
 if device is None:os.environ.pop('LYAPUNOV_HUMAN_COMPUTE_DEVICE',None)
 else:os.environ['LYAPUNOV_HUMAN_COMPUTE_DEVICE']=device
motions=[{'kind':'human','entityId':e['entityId'],'durationS':.3,'route':{'pointsM':[[e['transform']['position'][0]+2,e['transform']['position'][1],0]],'speedMps':1.,'behavior':'walk','clip':a.clip,'avoidObstacles':False}}for e in people]
for w in [left,right]:w.execute({'kind':'batch','actionId':'equivalent','expectedGeneration':1,'motions':motions})
original=worker.human_batch.advance;maximum=0.;contact_steps=0;human_box_contacts=0;max_contact_force=0.;start=left.data.xpos[left.info('dynamic-box')['body']].copy()
def scalar(w,ms,elapsed):
 for m in ms:worker.human.advance(w,w.info(m['entityId']),m,elapsed)
for step in range(150):
 left.tick();worker.human_batch.advance=scalar
 try:right.tick()
 finally:worker.human_batch.advance=original
 for key in ['site_xpos','site_xmat','geom_xpos','geom_xmat']:maximum=max(maximum,float(np.max(np.abs(getattr(left.data,key)-getattr(right.data,key)))))
 assert maximum<1e-9,(step,maximum);assert np.allclose(left.data.qpos,right.data.qpos,atol=1e-9,rtol=0);contact_steps+=int(left.data.ncon>0)
 for contact_index,contact in enumerate(left.data.contact):
  names=[left.model.geom(int(g)).name for g in [contact.geom1,contact.geom2]]
  if any(n.startswith('dynamic-box/')for n in names)and any('/human/'in n for n in names):
   force=np.zeros(6);worker.mj.mj_contactForce(left.model,left.data,contact_index,force);human_box_contacts+=1;max_contact_force=max(max_contact_force,float(np.linalg.norm(force[:3])))
 if step==70:
  for w in [left,right]:w.stop({'entityIds':[people[0]['entityId']],'expectedGeneration':1})
displacement=float(np.linalg.norm(left.data.xpos[left.info('dynamic-box')['body']]-start));assert contact_steps>0 and displacement>.001,(contact_steps,displacement);assert np.array_equal(left.model.geom_contype,right.model.geom_contype)and np.array_equal(left.model.geom_conaffinity,right.model.geom_conaffinity);assert left.receipts['equivalent']['status']==right.receipts['equivalent']['status']=='cancelled';assert not left.control_owners and not right.control_owners
report={'status':'PASSED','actors':20,'steps':150,'maxNativeError':maximum,'threshold':1e-9,'contactSteps':contact_steps,'humanBoxContacts':human_box_contacts,'humanBoxPeakForceN':max_contact_force,'dynamicBoxDisplacementM':displacement,'reference':'已有Mju标量pose/FK，未调用NumPy批primitive；独立a089冻结全模块另作更强参照','maskUnchanged':True,'mode':'明确关闭avoidObstacles的接触正例，不作默认停障或正常人群容量成绩'}
if left.human_compute_device!='cpu':report['humanComputeBeforeClose']=left.human_compute_facts()
left.close();right.close();report['closed']=left.status==right.status=='closed'
if left.human_compute_device!='cpu':report['humanComputeAfterClose']=left.human_compute_facts()
Path(a.output).write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False))
