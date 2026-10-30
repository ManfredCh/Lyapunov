"""有界原生性能测点；独立进程/档位，墙钟超限由外部timeout控制，不给容量承诺。"""
import argparse,copy,json,sys,time,resource,hashlib
from pathlib import Path
worker_root=Path(sys.argv[sys.argv.index('--worker-root')+1]).resolve()if '--worker-root'in sys.argv else Path(__file__).resolve().parents[2]/'sim-mujoco'/'python'
sys.path.insert(0,str(worker_root))
import worker
worker.emit=lambda _:None;worker.emit_text=lambda _:None
from worker import World
p=argparse.ArgumentParser();p.add_argument('scene');p.add_argument('--count',type=int,required=True);p.add_argument('--collision',choices=['coarse','detailed'],default='coarse');p.add_argument('--steps',type=int,default=10);p.add_argument('--warmup-steps',type=int,default=5);p.add_argument('--worker-root');p.add_argument('--avoid-obstacles',action='store_true');p.add_argument('--frame-hz',type=float,default=1);p.add_argument('--serialize-output',action='store_true');p.add_argument('--panda',action='store_true');p.add_argument('--output',required=True);a=p.parse_args();s=json.loads(Path(a.scene).read_text());asset=next(e for e in s['entities']if e.get('components',{}).get('humanDefinition'));person=next(e for e in s['entities']if e.get('components',{}).get('human'));entities=[asset]
for i in range(a.count):
 e=copy.deepcopy(person);e['entityId']='human_'+str(i);e['transform']['position']=[(i%32)*1.5,(i//32)*1.5,0];e['components']['human']['collision']=a.collision;e['components']['human']['phase']=(i*.61803398875)%1;entities.append(e)
if a.panda:
 entities[1]['transform']['position']=[-1.2,0,0]
 entities.append({'entityId':'panda','name':'Panda','transform':{'position':[0,0,0],'quaternion':[0,0,0,1],'scale':[1,1,1]},'resources':[],'components':{'mujoco':{'sourcePath':str(Path(__file__).resolve().parents[3]/'materials/robots/franka_panda/franka_emika_panda/panda.xml')}}})
s['entities']=entities
encoded={'messages':0,'bytes':0}
if a.serialize_output:
 def emit(value):
  encoded['messages']+=1;encoded['bytes']+=len(json.dumps(value,allow_nan=False,separators=(',',':')))
 worker.emit=emit;worker.emit_text=lambda text:encoded.update(messages=encoded['messages']+1,bytes=encoded['bytes']+len(text))
t=time.perf_counter();w=World(s,{'worldId':'perf','clock':'manual','ground':True,'timestepS':.002,'frameRateHz':a.frame_hz});compile_s=time.perf_counter()-t
motions=[{'kind':'human','entityId':e['entityId'],'durationS':(a.steps+a.warmup_steps)*.002,'route':{'pointsM':[[e['transform']['position'][0]+1,e['transform']['position'][1],0]],'speedMps':1.,'behavior':'walk','avoidObstacles':a.avoid_obstacles}}for e in entities[1:]if e.get('components',{}).get('human')]
t=time.perf_counter();w.execute({'kind':'batch','actionId':'perf','expectedGeneration':1,'motions':motions});prepare_s=time.perf_counter()-t
t=time.perf_counter()
for _ in range(a.warmup_steps):w.tick()
warmup_s=time.perf_counter()-t;t=time.perf_counter()
for _ in range(a.steps):w.tick()
tick_s=time.perf_counter()-t;t=time.perf_counter();frame=w.observe();observe_s=time.perf_counter()-t
actual_steps=w.step_index;action=w.receipts.get('perf',{});verified=actual_steps==a.steps+a.warmup_steps and action.get('status')=='completed'
result={'status':'completed'if verified else'FAILED','actualSteps':actual_steps,'actionStatus':action.get('status'),'actionReason':action.get('reason'),'inputScene':str(Path(a.scene).resolve()),'inputSceneSha256':hashlib.sha256(Path(a.scene).read_bytes()).hexdigest(),'sourceKind':asset['components']['humanDefinition']['source']['kind'],'workerPath':str(worker_root),'humanBatchSha256':hashlib.sha256((worker_root/'human_batch.py').read_bytes()).hexdigest()if(worker_root/'human_batch.py').exists()else None,'workerSha256':hashlib.sha256((worker_root/'worker.py').read_bytes()).hexdigest(),'humanSha256':hashlib.sha256((worker_root/'human.py').read_bytes()).hexdigest(),'collisionEnabledGeoms':int(((w.model.geom_contype!=0)|(w.model.geom_conaffinity!=0)).sum()),'collisionMaskSha256':hashlib.sha256(w.model.geom_contype.tobytes()+w.model.geom_conaffinity.tobytes()).hexdigest(),'frameRateHz':a.frame_hz,'serializationIncluded':a.serialize_output,'encoded':encoded,'count':a.count,'collision':a.collision,'engine':'MuJoCo '+worker.mj.__version__,'robot':('Panda共存，首人从-1.2m朝机器人行走，其余均匀1.5米间隔'if a.panda else'无机器人，均匀1.5米间隔')+'；无互让；停障='+str(a.avoid_obstacles),'timestepS':float(w.model.opt.timestep),'steps':a.steps,'warmupSteps':a.warmup_steps,'warmupS':warmup_s,'compileS':compile_s,'prepareS':prepare_s,'physicsWallS':tick_s,'physicsRTF':a.steps*.002/tick_s if verified else None,'observeS':observe_s,'maxRssMiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024,'nbody':w.model.nbody,'ngeom':w.model.ngeom,'frameBytes':len(json.dumps(frame)),'viewerFrameTimeMs':None,'viewerReason':'此脚本无图形Viewer；不把原生RTF当Viewer帧率','capacityPromise':False}
w.close();result['closed']=True
Path(a.output).write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False))

if not verified:sys.exit(1)
