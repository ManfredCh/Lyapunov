#!/usr/bin/env python3
"""真实NDJSON worker分段计时包装；不改时钟/动作/采样或观测，只在正常shutdown后保存自身计数。"""
import atexit,json,os,sys,time
from pathlib import Path
worker_path=Path(sys.argv[-1]).resolve();sys.path.insert(0,str(worker_path.parent));import worker
out=Path(os.environ['LYAPUNOV_HUMAN_PROFILE_OUT']).resolve();timings={}
def measure(target,key,label):
 original=getattr(target,key)
 def wrapped(*args,**kwargs):
  start=time.perf_counter();cpu=time.thread_time()
  try:return original(*args,**kwargs)
  finally:
   elapsed=time.perf_counter()-start;entry=timings.setdefault(label,{'calls':0,'totalS':0.,'maxS':0.});entry['calls']+=1;entry['totalS']+=elapsed;entry['maxS']=max(entry['maxS'],elapsed);entry['cpuS']=entry.get('cpuS',0.)+time.thread_time()-cpu
 setattr(target,key,wrapped)
for key in('tick','observe','refresh_derived','contact_summaries','world_physics','initial_overlap_diagnostic','apply_motion','set_joint'):measure(worker.World,key,'World.'+key)
measure(worker,'emit','NDJSON.emit');measure(worker.human_batch,'advance','human_batch.advance');measure(worker.human,'obstacle_distance','native.human_ray');measure(worker.human,'observe','native.human_observe')
if hasattr(worker.human_batch,'path_states'):measure(worker.human_batch,'path_states','human_batch.path_states')
measure(worker.mj,'mj_step','native.mj_step')
import robot_authoring
measure(robot_authoring,'authoring_observation','robot.authoring_observation')
started=time.perf_counter()
def save():
 out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps({'worker':str(worker_path),'wallS':time.perf_counter()-started,'timings':timings,'note':'wallclock分段有嵌套，不求和冒充互斥CPU份额；正常worker protocol/物理行为未改'},ensure_ascii=False,indent=2))
atexit.register(save);worker.main()
