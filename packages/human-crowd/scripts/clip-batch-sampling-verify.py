"""完整冻结模块与同tick外部clip合批采样对照，不是性能基准。"""
import sys,json,types,copy,hashlib,argparse
from pathlib import Path
import numpy as np
parser=argparse.ArgumentParser();parser.add_argument('--definition',required=True);parser.add_argument('--reference-human',required=True);parser.add_argument('--output',required=True);args=parser.parse_args();sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'sim-mujoco/python'));import human as h
path=Path(args.reference_human).resolve();ref=types.ModuleType('frozen_a089');ref.__file__=str(path);exec(compile(path.read_text(),str(path),'exec'),ref.__dict__);base=json.loads(Path(args.definition).read_text());phases=(np.arange(20)*.61803398875)%1;rng=np.random.default_rng(42);roots=rng.normal(size=(20,3));qs=rng.normal(size=(20,4));qs/=np.linalg.norm(qs,axis=1)[:,None];maximum=0.;samples=0;reports=[]
for variant in ['original','antipodal']:
 a=copy.deepcopy(base);b=copy.deepcopy(base)
 if variant=='antipodal':
  for cfg in [a,b]:
   for clip in cfg['clips']:
    for track in clip['tracks']:
     for i,q in enumerate(track['rotationsXyzw']):
      if i%2:track['rotationsXyzw'][i]=[-v for v in q]
 a['_poseRuntime']=ref.compile_pose(a);b['_poseRuntime']=h.compile_pose(b)
 for clip in a['clips']:
  limit=0.
  for t in list(np.linspace(0,clip['durationS']*2,31))+[clip['durationS']-1e-12,clip['durationS']+1e-12]:
   times=np.maximum(0,t-np.arange(20)*.0001);p,q=h.sample_clip_batch(b,roots,qs,times,phases,clip['name'])
   for i in range(20):
    row={**a,'phase':float(phases[i])};expected=ref.pose(row,roots[i],qs[i],float(times[i]),'walk',1.402,clip['name']);ep=np.asarray([expected[n][0]for n in a['_poseRuntime']['names']]);eq=np.asarray([expected[n][1]for n in a['_poseRuntime']['names']]);limit=max(limit,float(np.max(np.abs(ep-p[i]))),float(np.max(np.abs(eq-q[i]))));samples+=1
  reports.append({'variant':variant,'clip':clip['name'],'maxAbsDifference':limit});maximum=max(maximum,limit)
assert maximum<1e-12,maximum
result={'status':'PASSED','referenceSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'samples':samples,'actors':20,'maxAbsDifference':maximum,'threshold':1e-12,'reports':reports};Path(args.output).write_text(json.dumps(result,indent=2));print(json.dumps(result))
