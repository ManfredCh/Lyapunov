"""最终外部角色+Panda的实际阻挡姿态检查；比较native pose与原件bind，不以推断判定。"""
import sys,json,copy,argparse,hashlib
from pathlib import Path
import numpy as np
p=argparse.ArgumentParser();p.add_argument('--scene',required=True);p.add_argument('--output',required=True);p.add_argument('--expect',choices=['bind','held'],required=True);p.add_argument('--endpoint',action='store_true');p.add_argument('--clip');args=p.parse_args();root=Path(__file__).resolve().parents[3];sys.path.insert(0,str(root/'packages/sim-mujoco/python'));import worker
worker.emit=lambda _:None;worker.emit_text=lambda _:None
scene=json.loads(Path(args.scene).read_text());person=next(e for e in scene['entities']if e.get('components',{}).get('human'));eid=person['entityId'];person['transform']['position']=[-1.2,0,0];assets=[e for e in scene['entities']if e.get('components',{}).get('humanDefinition')];scene={**scene,'sceneId':'blocked-external-human','entities':assets+[person,{'entityId':'panda','name':'Panda','transform':{'position':[0,0,0],'quaternion':[0,0,0,1],'scale':[1,1,1]},'resources':[],'components':{'mujoco':{'sourcePath':str(root/'materials/robots/franka_panda/franka_emika_panda/panda.xml')}}}]};out=Path(args.output);out.mkdir(parents=True,exist_ok=True);w=worker.World(scene,{'worldId':'blocked-clip','clock':'manual','ground':True,'timestepS':.002});info=w.info(eid);cfg=info['human'];clip=args.clip or next(c['name']for c in cfg['clips']if c['name']=='WalkGrounded');route={'pointsM':[[-1.196,0,0]]if args.endpoint else[[3,0,0],[-3,0,0]],'speedMps':1.4023727797434615,'behavior':'walk','clip':clip,'loop':not args.endpoint};w.execute({'kind':'human','entityId':eid,'actionId':'panda-walk','expectedGeneration':1,'durationS':2,'route':route});previous=None;blocked=None;last_held=None;maximum_hold=0.;frames=[]
def pose():return next(e for e in w.observe({'entityIds':[eid]})['entities']if e['entityId']==eid)
def points(e):return np.asarray([j['positionM']for j in e['humanPose']['joints']])
for i in range(1000):
 w.tick();current=pose()
 if current['humanPose'].get('motion',{}).get('blockedByGeom')or args.endpoint and current['humanPose'].get('motion',{}).get('behavior')=='stand':
  if blocked is None:
   sampled=worker.human.pose(cfg,info['humanRoot'],info['humanRootQ']);bind=np.asarray([sampled[j['name']][0]for j in current['humanPose']['joints']]);blocked={'firstBlockedStep':w.step_index,'lastUnblocked':previous,'firstBlocked':current,'bindMaxPositionErrorM':float(np.max(np.abs(points(current)-bind))),'jumpFromLastUnblockedMaxM':float(np.max(np.abs((points(current)-np.asarray(current['transform']['position']))-(points(previous)-np.asarray(previous['transform']['position'])))))};last_held=points(current).copy()
  maximum_hold=max(maximum_hold,float(np.max(np.abs(points(current)-last_held))))
 if i%20==0 or blocked and w.step_index==blocked['firstBlockedStep']:frames.append(w.observe({'contacts':True}))
 previous=current
assert blocked,'未出现默认Panda阻挡';report={'status':'PASSED','expected':args.expect,'assetSha256':cfg['source']['sha256'],'humanPythonSha256':hashlib.sha256((root/'packages/sim-mujoco/python/human.py').read_bytes()).hexdigest(),**blocked,'maxPoseChangeWhileBlockedM':maximum_hold,'scenario':'短终点'if args.endpoint else'默认Panda原生阻挡','lastStep':w.step_index,'lastPose':current,'owners':dict(w.control_owners),'receiptStatus':w.receipts['panda-walk']['status']};w.close();report['closed']=w.status=='closed'
if args.endpoint:assert abs(current['transform']['position'][0]+1.196)<1e-12,current['transform']
if args.expect=='bind':assert report['bindMaxPositionErrorM']<1e-12 and report['jumpFromLastUnblockedMaxM']>.1,report
else:assert report['jumpFromLastUnblockedMaxM']<1e-12 and report['maxPoseChangeWhileBlockedM']<1e-12 and report['bindMaxPositionErrorM']>.1,report
(out/'blocked-receipt.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));(out/'frames.jsonl').write_text('\n'.join(json.dumps(f)for f in frames));print(json.dumps({k:v for k,v in report.items()if k not in ['lastUnblocked','firstBlocked','lastPose']},ensure_ascii=False))
