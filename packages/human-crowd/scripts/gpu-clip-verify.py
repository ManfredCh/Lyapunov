"""实际CUDA原clip/FK对独立冻结标量；只证明GPU数学和资源生命周期，不作World/RTF。"""
import argparse,copy,hashlib,importlib.util,json,math,sys,time
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'sim-mujoco/python'))
import human_gpu as gpu
p=argparse.ArgumentParser();p.add_argument('--definition',required=True,action='append');p.add_argument('--reference-human',required=True);p.add_argument('--out',required=True);p.add_argument('--device',default='cuda:0');p.add_argument('--expected-uuid');p.add_argument('--cache',required=True);args=p.parse_args();path=Path(args.reference_human).resolve();spec=importlib.util.spec_from_file_location('frozen_gpu_reference',path);ref=importlib.util.module_from_spec(spec);spec.loader.exec_module(ref)
rng=np.random.default_rng(42);roots=rng.normal(size=(20,3));qs=rng.normal(size=(20,4));qs/=np.linalg.norm(qs,axis=1)[:,None];qs[0]=[1.,0,0,0];qs[1]=[math.cos((math.pi-1e-12)/2),math.sin((math.pi-1e-12)/2),0,0];qs[2]=[0,0,1.,0];qs[3]=[-1.,0,0,0];phases=np.arange(20)*.61803398875%1;phases[:8]=[-.25,1.25,-1.25,2.,-2.,-1e-12,1+1e-12,1000.37];results=[];maximum=0.;segment_error=0.;samples=0;closed_batches=0
definitions=[(name,json.loads(Path(name).read_text()))for name in args.definition]
edge=copy.deepcopy(definitions[0][1]);names=[j['name']for j in edge['rig']];tracks=[]
for i,dot in enumerate([.9995-1e-12,.9995,.9995+1e-12]):tracks.append({'joint':names[i],'timesS':[0.,1.],'rotationsXyzw':[[0,0,0,1],[math.sqrt(1-dot*dot),0,0,dot]],'interpolation':'LINEAR'})
tracks.append({'joint':names[3],'timesS':[0.,.5,1.],'rotationsXyzw':[[0,0,0,1],[0,0,1,0],[0,0,0,-1]],'interpolation':'STEP'});edge['clips']=[{'name':'GpuBoundaryFixture','durationS':1.,'tracks':tracks,'translations':[{'joint':names[0],'timesS':[0.,.33,.67,1.],'positionsM':[[0,0,0],[.1,-.2,.03],[-.04,.01,.1],[0,0,0]],'interpolation':'STEP'}]}];definitions.append(('显式SLERP阈值/STEP数值夹具，非资源动作',edge))
for definition_name,original in definitions:
 for variant in ['original','antipodal']:
  cfg=copy.deepcopy(original)
  if variant=='antipodal':
   for clip in cfg['clips']:
    for track in clip['tracks']:
     for i,q in enumerate(track['rotationsXyzw']):
      if i%2:track['rotationsXyzw'][i]=[-v for v in q]
  cfg['_poseRuntime']=ref.compile_pose(cfg)
  for clip in cfg['clips']:
   batch=gpu.ClipBatch(cfg,20,clip['name'],device=args.device,cache_root=args.cache);error=0.;feet=0.;start=time.perf_counter()
   try:
    if args.expected_uuid:assert batch.device.uuid==args.expected_uuid,batch.facts()
    points=list(np.linspace(0,clip['durationS']*2,31))+[clip['durationS']-1e-12,clip['durationS']+1e-12];previous=None
    for k,t in enumerate(points):
     current_roots=roots+np.array([float(t)*.013,0,0]);times=np.maximum(0,t-np.arange(20)*.0001);current_phase=phases+k*.0013;positions,quaternions=batch.sample(current_roots,qs,times,current_phase)
     if previous is not None:assert np.array_equal(previous[0],previous[1]),'下次graph不得覆盖上次返回数组'
     previous=(positions,positions.copy())
     for i in range(20):
      expected=ref.pose({**cfg,'phase':float(current_phase[i])},current_roots[i],qs[i],float(times[i]),'walk',1.402,clip['name']);actual={name:(positions[i,n],quaternions[i,n])for n,name in enumerate(batch.names)};ep=np.asarray([expected[n][0]for n in batch.names]);eq=np.asarray([expected[n][1]for n in batch.names]);error=max(error,float(np.max(np.abs(ep-positions[i]))),float(np.max(np.abs(eq-quaternions[i]))));samples+=1
      for a,b,_ in ref.SEGMENTS:
       row={'a':cfg['boneMapping'][a],'b':cfg['boneMapping'][b],'calibration':ref.segment_calibration(cfg,a,b)};pa,pb=ref.segment_points(expected,row);qa,qb=ref.segment_points(actual,row);feet=max(feet,float(np.max(np.abs(pa-qa))),float(np.max(np.abs(pb-qb))))
    result={'definition':definition_name,'source':cfg['source'],'heightM':cfg['heightM'],'footCalibrated':bool(cfg.get('footCollision')),'variant':variant,'clip':clip['name'],'maxAbsDifference':error,'segmentEndpointsMaxDifference':feet,'elapsedIncludingReferenceS':time.perf_counter()-start,'gpu':batch.facts()};results.append(result);maximum=max(maximum,error);segment_error=max(segment_error,feet);assert error<1e-12 and feet<1e-12,(definition_name,variant,clip['name'],error,feet)
   finally:batch.close()
   assert batch.closed and batch.graph is None and batch.stream is None;closed_batches+=1;before=batch.calls
   try:batch.sample(roots,qs,np.zeros(20),phases)
   except gpu.HumanGpuError as exc:assert exc.code=='HUMAN_GPU_CLOSED'
   else:raise AssertionError('已关闭批不得继续执行')
   assert batch.calls==before;result['gpuAfterClose']=batch.facts();print(json.dumps({k:result[k]for k in ['definition','variant','clip','maxAbsDifference','segmentEndpointsMaxDifference']},ensure_ascii=False),flush=True)

# 捕获中实际注入拷贝失败，核当前stream无残留capture，随后真实重建/重放成功。
cfg=definitions[0][1];clip_name=cfg['clips'][0]['name'];device=gpu.wp.get_device(args.device);before=set(device.captures);original_copy=gpu.wp.copy
def fail_during_capture(*values,**options):
 if device.captures:raise RuntimeError('HUMAN_GPU_TEST_CAPTURE_FAILURE')
 return original_copy(*values,**options)
gpu.wp.copy=fail_during_capture;capture_failed=False
try:
 try:gpu.ClipBatch(cfg,20,clip_name,device=args.device,cache_root=args.cache)
 except RuntimeError as exc:capture_failed='HUMAN_GPU_TEST_CAPTURE_FAILURE'in str(exc);assert capture_failed,str(exc)
 else:raise AssertionError('捕获故障未实际触发')
finally:gpu.wp.copy=original_copy
assert capture_failed and set(device.captures)==before
first=gpu.ClipBatch(cfg,20,clip_name,device=args.device,cache_root=args.cache);second=gpu.ClipBatch(cfg,20,clip_name,device=args.device,cache_root=args.cache);first.close();second.sample(roots,qs,np.zeros(20),phases);second.close();assert set(device.captures)==before
try:gpu.ClipBatch(cfg,20,clip_name,device='cpu',cache_root=args.cache)
except gpu.HumanGpuError as exc:assert exc.code=='HUMAN_CUDA_UNAVAILABLE'
else:raise AssertionError('显式GPU不得回落CPU')
report={'status':'PASSED','scope':'实际CUDA原始clip/FK和独立buffer/graph生命周期；尚未证明World/物理/实时/RTX渲染','actors':20,'samples':samples,'definitions':len(args.definition),'maxAbsDifference':maximum,'segmentEndpointsMaxDifference':segment_error,'threshold':1e-12,'referenceSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'gpuSourceSha256':hashlib.sha256(Path(gpu.__file__).read_bytes()).hexdigest(),'closedBatches':closed_batches,'captureFailureAndRecovery':capture_failed,'closeOneKeepsOther':True,'explicitCpuRejected':True,'closed':True,'results':results};Path(args.out).write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps({k:v for k,v in report.items()if k!='results'},ensure_ascii=False))
