"""独立进程的冻结/候选World逐tick数值快照；只作对照，不是当前执行世界或RTF。"""
import sys,json,argparse,time,copy,hashlib
from pathlib import Path
import numpy as np
p=argparse.ArgumentParser();p.add_argument('--worker-root',required=True);p.add_argument('--scene',required=True);p.add_argument('--out',required=True);p.add_argument('--reference');p.add_argument('--steps',type=int,default=3000);p.add_argument('--mixed',action='store_true');p.add_argument('--fallback',action='store_true');p.add_argument('--rebind',action='store_true');p.add_argument('--resume',action='store_true',help='仅移动非人体原生mocap障碍，核对解除停障后的相位');args=p.parse_args();sys.path.insert(0,str(Path(args.worker_root).resolve()));import worker
worker.emit=lambda _:None;worker.emit_text=lambda _:None
calls=[0]
if hasattr(worker.human,'sample_clip_batch'):
 original_sample=worker.human.sample_clip_batch
 def counted_sample(*args,**kwargs):calls[0]+=1;return original_sample(*args,**kwargs)
 worker.human.sample_clip_batch=counted_sample
scene=json.loads(Path(args.scene).read_text())
if args.resume:
 template=next(e for e in scene['entities']if e.get('components',{}).get('human'));people=[]
 for i in range(4):
  e=copy.deepcopy(template);e['entityId']='resume_'+str(i);e['transform']['position']=[0,i*2,0];e['components']['human']['phase']=.37+i*.1;e['components']['human']['route']={'pointsM':[[3,i*2,0]],'speedMps':1.4023727797434615,'behavior':'walk','clip':'WalkGrounded'};people.append(e)
 scene['entities']=[e for e in scene['entities']if e.get('components',{}).get('humanDefinition')]+people+[{'entityId':'obstacle','name':'test-mocap-box','transform':{'position':[0,0,0],'quaternion':[0,0,0,1],'scale':[1,1,1]},'resources':[],'components':{'mujoco':{'xml':'<mujoco><worldbody><body name="box" mocap="true" pos="1 0 .9"><geom name="wall" type="box" size=".1 .5 .9"/></body></worldbody></mujoco>'}}}]
people=[e for e in scene['entities']if e.get('components',{}).get('human')];motions=[]
for i,e in enumerate(people):
 route=copy.deepcopy(e['components']['human']['route']);duration=args.steps*.002
 if args.mixed:
  route['clip']=['WalkGrounded','Walk','WalkGrounded','Run'][i%4]
  if i==18:duration=.12
  if i==17:route['pointsM']=[[e['transform']['position'][0]+.004,e['transform']['position'][1],0]];route['loop']=False
 if args.fallback and i==16:route['navigation']={'bounds':{'min':[-6,-3],'max':[6,10]},'cellSizeM':.5,'clearanceM':.65}
 if args.fallback and i==15:route['yieldToHumans']=True
 motions.append({'kind':'human','entityId':e['entityId'],'durationS':duration,'route':route})
if not args.resume:motions.append({'kind':'joint','entityId':'panda','jointNames':['joint1'],'positions':[.2],'durationS':args.steps*.002,'tolerance':.1,'settleTimeS':0})
out=Path(args.out);out.mkdir(parents=True,exist_ok=True);w=worker.World(scene,{'worldId':'numeric-compare','clock':'manual','ground':True,'timestepS':.002,'frameRateHz':.001});
if args.rebind:
 warm=copy.deepcopy(motions)
 for motion in warm:motion['durationS']=.1
 w.execute({'kind':'batch','actionId':'old-model','expectedGeneration':w.generation,'motions':warm})
 for _ in range(50):w.tick()
 changed=copy.deepcopy(scene);changed['revision']+=1;changed['entities']=list(reversed(changed['entities']));w.sync(changed,force=True);assert w.generation==2 and w.step_index==0
w.execute({'kind':'batch','actionId':'compare','expectedGeneration':w.generation,'motions':motions});prepared=w.active['compare']['motions'];phase_samples=[];obstacle=int(w.model.body_mocapid[w.model.body('obstacle/box').id])if args.resume else None;fields=['site_xpos','site_xmat','geom_xpos','geom_xmat','qpos','qvel'];slices={};width=0
for key in fields:size=getattr(w.data,key).size;slices[key]=(width,width+size);width+=size
array=np.lib.format.open_memmap(out/'native.npy',mode='w+',dtype=np.float64,shape=(args.steps,width))if not args.reference else np.load(Path(args.reference)/'native.npy',mmap_mode='r');maximum={key:0. for key in fields};start=time.thread_time();readback=0.;contacts=0
for step in range(args.steps):
 w.tick();contacts+=w.data.ncon
 for key in fields:
  a,b=slices[key];values=getattr(w.data,key).reshape(-1)
  if args.reference:maximum[key]=max(maximum[key],float(np.max(np.abs(values-array[step,a:b]),initial=0)))
  else:array[step,a:b]=values
 if step in [0,49,176,args.steps-1]:
  frame=w.observe();assert frame['stepIndex']==w.step_index
  for entity in frame['entities']:
   if not entity.get('humanPose'):continue
   info=w.info(entity['entityId']);assert entity['humanPose']['stepIndex']==frame['stepIndex']and entity['humanPose']['simTime']==frame['simTime']
   for j in entity['humanPose']['joints']:
    sid=info['humanJointSiteIds'][j['name']];readback=max(readback,float(np.max(np.abs(np.asarray(j['positionM'])-w.data.site_xpos[sid]))));q=np.empty(4);worker.mj.mju_mat2Quat(q,w.data.site_xmat[sid]);readback=max(readback,float(np.max(np.abs(np.asarray(j['quaternionXyzw'])-q[[1,2,3,0]]))))
 if args.resume:
  if step in [198,199,200,201,202,203,args.steps-1]:phase_samples.append({'step':w.step_index,'clipElapsedS':(step+1)*.002-prepared[0].get('_clipPausedS',0.),'pausedS':prepared[0].get('_clipPausedS',0.),'motion':copy.deepcopy(w.info('resume_0').get('humanMotion'))})
  if step==199:w.data.mocap_pos[obstacle]=[1,4,.9]
 elif step==min(1700,args.steps//2):w.stop({'entityIds':[people[1]['entityId'],people[-1]['entityId']],'expectedGeneration':w.generation})
assert readback<1e-12,readback
if args.reference:
 for key,error in maximum.items():assert error<1e-9,(key,error)
 reference_report=json.loads((Path(args.reference)/'compare.json').read_text());assert int(contacts)==reference_report['contacts'];assert phase_samples==reference_report.get('phaseSamples',[])
else:array.flush()
report={'status':'PASSED','steps':w.step_index,'simTime':w.data.time,'maxAbsDifferences':maximum,'nativeReadbackMaxError':readback,'reference':args.reference,'workerRoot':args.worker_root,'humanSha256':hashlib.sha256((Path(args.worker_root)/'human.py').read_bytes()).hexdigest(),'sceneSha256':hashlib.sha256(Path(args.scene).read_bytes()).hexdigest(),'cpuS':time.thread_time()-start,'contacts':int(contacts),'generation':w.generation,'groupSignatures':len({info['human'].get('_batchSignature')for info in w.entities.values()if info.get('human')})if hasattr(worker.human,'sample_clip_batch')else None,'batchSampleCalls':calls[0],'humanOwners':{eid:aid for eid,aid in w.control_owners.items()if w.entities[eid].get('human')},'receiptStatus':w.receipts['compare']['status'],'phaseSamples':phase_samples,'resumeStimulus':'step200后仅移动非人体原生mocap障碍到y4'if args.resume else None};w.close();report['closed']=w.status=='closed';(out/'compare.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
