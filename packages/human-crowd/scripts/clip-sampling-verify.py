"""原始逐通道标量参考与产品预解码/合批采样等价检查，不推进另一个物理时钟。"""
import argparse,json,sys,math,time,copy,hashlib,importlib.util
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'sim-mujoco'/'python'))
import human
from human import mul,rotate,wxyz,track_slot
def reference_pose(cfg,root,q,elapsed=0,behavior='stand',speed=0,clip_name=None):
 phase=cfg.get('phase',0)*2*math.pi+elapsed*(2.8 if behavior=='run'else 1.7)*2*math.pi;rotations={};translations={}
 clip=next((c for c in cfg.get('clips',[])if c['name']==clip_name),None)
 if clip:
  time=(elapsed+cfg.get('phase',0)*clip['durationS'])%clip['durationS']
  for track in clip['tracks']:
   i,j,u=track_slot(track,time);a=wxyz(track['rotationsXyzw'][i]);b=wxyz(track['rotationsXyzw'][j]);dot=float(np.dot(a,b))
   if dot<0:b=-b;dot=-dot
   if dot>.9995:rotation=(1-u)*a+u*b;rotation/=np.linalg.norm(rotation)
   else:
    theta=math.acos(max(-1.,min(1.,dot)));rotation=(math.sin((1-u)*theta)*a+math.sin(u*theta)*b)/math.sin(theta)
   rotations[track['joint']]=rotation
  for track in clip.get('translations',[]):
   i,j,u=track_slot(track,time);translations[track['joint']]=(1-u)*np.asarray(track['positionsM'][i])+u*np.asarray(track['positionsM'][j])
 elif behavior in('walk','run')and speed>1e-6:
  amount=(.8 if behavior=='run'else .45)*min(1,speed/(2.8 if behavior=='run'else 1.2))
  for side,sign in [('left',1),('right',-1)]:
   swing=math.sin(phase)*sign;angles={side+'Hip':amount*swing,side+'Knee':-.7*max(0,-swing),side+'Shoulder':-amount*.65*swing,side+'Elbow':-.25-(.55 if behavior=='run'else .12)*max(0,swing)}
   for name,angle in angles.items():rotations[cfg['boneMapping'].get(name,name)]=np.array([math.cos(angle/2),0,math.sin(angle/2),0])
 result={}
 for joint in cfg['rig']:
  parent=result.get(joint.get('parent'));position,orientation=parent if parent else(root,q);local=rotations.get(joint['name'],wxyz(joint['quaternionXyzw']));offset=translations.get(joint['name'],joint['offsetM']);result[joint['name']]=(position+rotate(orientation,offset),mul(orientation,local))
 if clip and clip.get('rootMotion'):
  mapping=clip['rootMotion'];inverse=np.array([q[0],-q[1],-q[2],-q[3]]);local=rotate(inverse,result[mapping['joint']][0]-root);baseline=mapping['baselineM'];offset=np.asarray(mapping['driftM'])*(time/clip['durationS'])if mapping['horizontal']=='remove-drift'else np.array([local[0]-baseline[0],local[1]-baseline[1],0]);shift=rotate(q,offset)
  result={name:(position-shift,orientation)for name,(position,orientation)in result.items()}
 return result

parser=argparse.ArgumentParser();parser.add_argument('--definition',required=True);parser.add_argument('--output',required=True);parser.add_argument('--reference-human');args=parser.parse_args();cfg=json.loads(Path(args.definition).read_text());reference_cfg=copy.deepcopy(cfg);reference=reference_pose;reference_sha=None
if args.reference_human:
 path=Path(args.reference_human).resolve();reference_sha=hashlib.sha256(path.read_bytes()).hexdigest();spec=importlib.util.spec_from_file_location('frozen_human_reference',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);reference=module.pose;reference_cfg['_poseRuntime']=module.compile_pose(reference_cfg)
cfg['_poseRuntime']=human.compile_pose(cfg);maximum=0.;samples=0
for clip in cfg['clips']:
 for phase in [0,.137,.999]:
  cfg['phase']=phase;reference_cfg['phase']=phase
  for elapsed in list(np.linspace(0,clip['durationS']*2,181))+[clip['durationS']-1e-12,clip['durationS']+1e-12]:
   q=np.array([math.cos(.35),0,0,math.sin(.35)]);p=np.array([1.,-.5,.7]);a=reference(reference_cfg,p,q,float(elapsed),'walk',1.402,clip['name']);b=human.pose(cfg,p,q,float(elapsed),'walk',1.402,clip['name']);samples+=1
   for name in a:maximum=max(maximum,float(np.max(np.abs(a[name][0]-b[name][0]))),float(np.max(np.abs(a[name][1]-b[name][1]))))
assert maximum<1e-12,maximum
report={'status':'PASSED','samples':samples,'bones':len(cfg['rig']),'clips':len(cfg['clips']),'maxAbsDifference':maximum,'threshold':1e-12,'referenceSha256':reference_sha,'referenceHuman':args.reference_human};Path(args.output).write_text(json.dumps(report,indent=2));print(json.dumps(report))
