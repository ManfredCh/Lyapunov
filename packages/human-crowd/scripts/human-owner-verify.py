"""直接驱动现有产品World验证人物aid归属生命周期；不创建另一个控制器/调度器。"""
import argparse,copy,json,os,sys,traceback
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--engine',choices=['mujoco','isaac'],required=True);p.add_argument('--scene',required=True);p.add_argument('--output',required=True);p.add_argument('--worker');args=p.parse_args();out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=True);root=Path(__file__).resolve().parents[3];scene=json.loads(Path(args.scene).read_text());person=next(e for e in scene['entities']if e.get('components',{}).get('human'));person=copy.deepcopy(person);eid=person['entityId'];other=copy.deepcopy(person);other['entityId']='owner-long-person';other['transform']['position']=[0,2,0];other['components']['human']['phase']=.37;assets=[copy.deepcopy(e)for e in scene['entities']if e.get('components',{}).get('humanDefinition')];scene={**scene,'sceneId':'human-owner-lifecycle','entities':assets+[person,other]};app=None;world=None;checks=[];report={'status':'FAILED','engine':args.engine,'checks':checks,'scope':'当前aid人物清理；非人物owner语义不变'}
try:
 if args.engine=='mujoco':
  worker_path=Path(args.worker).resolve()if args.worker else root/'packages/sim-mujoco/python/worker.py';sys.path.insert(0,str(worker_path.parent));import worker
  worker.emit=lambda _:None;worker.emit_text=lambda _:None;World=worker.World
 else:
  os.environ.setdefault('LYAPUNOV_ISAAC_DEVICE','cpu');os.environ.setdefault('LYAPUNOV_ISAAC_RENDERING','none');os.environ.setdefault('LYAPUNOV_ISAAC_CACHE',str(out/'isaac-cache'));path=Path(args.worker).resolve()if args.worker else root/'packages/sim-isaac/python/worker.py';sys.path.insert(0,str(path.parent));ns={'__file__':str(path),'__name__':'human_owner_native_verification'};exec(compile(path.read_text().split('\nrequests=queue.Queue()')[0],str(path),'exec'),ns);ns['emit']=lambda _:None;World=ns['World'];app=ns['app']
 world=World(scene,{'worldId':'human-owner-'+args.engine,'clock':'manual','ground':True,'timestepS':.002});w=world
 def index():return w.step_index if args.engine=='mujoco'else w.index
 def active():return w.active if args.engine=='mujoco'else w.actions
 def entity(identity=eid):return next(e for e in w.observe({'entityIds':[identity]})['entities']if e['entityId']==identity)
 def pose(identity=eid):return copy.deepcopy(entity(identity)['humanPose']['joints'])
 def tick(n):
  for _ in range(n):w.tick()
 def motion(identity=eid,duration=.04):
  position=entity(identity)['transform']['position'];route={'pointsM':[[position[0]+2,position[1],position[2]]],'speedMps':.5,'behavior':'walk'};cfg=w.entities[identity]['human']
  if(cfg.get('route')or{}).get('clip'):route['clip']=cfg['route']['clip']
  return {'kind':'human','entityId':identity,'durationS':duration,'route':route}
 def execute(aid,motions):return w.execute({'kind':'batch','actionId':aid,'expectedGeneration':w.generation,'motions':motions})
 def check(name,values):checks.append({'name':name,'passed':True,'stepIndex':index(),**values})
 w.control_owners['unrelated-robot']='robot-owner-sentinel'
 before=index();execute('complete',[motion()]);assert w.control_owners[eid]=='complete';tick(20);assert index()==before+20 and eid not in w.control_owners and not active();assert w.receipts['complete']['status']=='completed';check('正常末步完成释放人物归属，不清其它owner',{'owners':dict(w.control_owners),'steps':20})
 execute('reentry',[motion()]);assert w.control_owners[eid]=='reentry';tick(20);assert eid not in w.control_owners and w.receipts['reentry']['status']=='completed';check('完成后新aid可重入并再次正确释放',{'owners':dict(w.control_owners)})
 w.set_paused(True,w.generation);before=index();held=pose();execute('paused',[motion(duration=.1)]);tick(5);assert index()==before;w.stop({'actionId':'paused','entityIds':[eid],'expectedGeneration':w.generation});assert eid not in w.control_owners and index()==before and pose()==held;assert w.receipts['paused']['status']=='cancelled';w.set_paused(False,w.generation);check('暂停中排队动作取消不推进物理步且释放归属',{'owners':dict(w.control_owners),'heldStep':before})
 before=index();held=pose();execute('failed',[motion(duration=.1)]);original=w.apply_motion
 def fail(_motion,_elapsed):raise RuntimeError('INJECTED_HUMAN_SAMPLING_FAILURE')
 w.apply_motion=fail
 try:w.tick()
 finally:w.apply_motion=original
 assert w.receipts['failed']['status']=='failed'and eid not in w.control_owners and not active()and index()==before and pose()==held;check('人物采样失败仍释放所属aid，末姿态/步号不变',{'owners':dict(w.control_owners),'reason':w.receipts['failed'].get('reason')})
 execute('windows',[motion(duration=.04),motion(other['entityId'],.1)]);tick(20);held=pose();assert eid not in w.control_owners and w.control_owners.get(other['entityId'])=='windows'and 'windows'in active();tick(30);assert pose()==held and eid not in w.control_owners and other['entityId']not in w.control_owners and w.receipts['windows']['status']=='completed';check('短人物末步释放，长成员继续且短人原生姿态保持',{'shortSteps':20,'longSteps':50,'owners':dict(w.control_owners)})
 execute('partial',[motion(duration=.1),motion(other['entityId'],.1)]);tick(5);held=pose();before=index();w.stop({'actionId':'partial','entityIds':[eid],'expectedGeneration':w.generation});assert eid not in w.control_owners and w.control_owners.get(other['entityId'])=='partial'and index()==before;tick(45);assert pose()==held and not active()and w.receipts['partial']['status']=='cancelled'and other['entityId']not in w.control_owners;check('部分停止只撤所选人物归属，长成员到窗正常完成',{'owners':dict(w.control_owners),'stopStep':before})
 execute('old-parent',[motion(duration=.04),motion(other['entityId'],.1)]);tick(20);assert eid not in w.control_owners;w.control_owners[eid]='newer-owner-fixture';held=pose();before=index();stopped=w.stop({'actionId':'old-parent','expectedGeneration':w.generation});assert eid not in stopped['affectedEntityIds'];assert w.control_owners[eid]=='newer-owner-fixture'and pose()==held and index()==before and other['entityId']not in w.control_owners;w.control_owners.pop(eid);check('旧父batch结束不能清更晚aid或重写短人物姿态',{'owners':dict(w.control_owners),'guardFixture':'仅注入owner元数据模拟晚到归属；未伪造物理姿态或运行第二控制器'})
 execute('old-active',[motion(duration=.1)]);tick(5);w.control_owners[eid]='different-owner-fixture';before=index();held=pose();stopped=w.stop({'actionId':'old-active','entityIds':[eid],'expectedGeneration':w.generation});assert stopped['affectedEntityIds']==[];assert w.control_owners[eid]=='different-owner-fixture'and pose()==held and index()==before;w.control_owners.pop(eid);check('旧活动成员取消也不能无条件清其它aid',{'owners':dict(w.control_owners)})
 assert w.control_owners=={'unrelated-robot':'robot-owner-sentinel'};w.control_owners.pop('unrelated-robot');report.update({'status':'PASSED','stepIndex':index(),'humanOwners':{},'sourceSha256':w.entities[eid]['human']['source'].get('sha256')})
except Exception as error:report.update({'error':str(error),'traceback':traceback.format_exc()});print(report['traceback'],flush=True)
finally:
 if world:
  report['observedOwnersBeforeClose']=dict(world.control_owners);report['observedHumanOwnersBeforeClose']={eid:aid for eid,aid in world.control_owners.items()if world.entities.get(eid,{}).get('human')};report['observedActiveActionIdsBeforeClose']=list(world.active if args.engine=='mujoco'else world.actions);report['observedReceiptStatusesBeforeClose']={aid:r.get('status')for aid,r in world.receipts.items()};report['observedStepBeforeClose']=world.step_index if args.engine=='mujoco'else world.index
  if getattr(world,'human_compute_device','cpu')!='cpu':report['humanComputeBeforeClose']=world.human_compute_facts()
  world.close()
  if getattr(world,'human_compute_device','cpu')!='cpu':
   report['humanComputeAfterClose']=world.human_compute_facts();assert report['humanComputeAfterClose']['closed']and report['humanComputeAfterClose']['activeBatches']==0
 report['closed']=bool(world and world.status=='closed');(out/'owner-receipt.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps({'status':report['status'],'checks':len(checks),'closed':report['closed'],'error':report.get('error'),'out':str(out)},ensure_ascii=False),flush=True)
 if app:app.close()
if report['status']!='PASSED':sys.exit(1)
