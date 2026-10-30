"""同一World当前输入的精确CUDA clip/FK数值；不拥有动作、物理时钟或原生模型。"""
import contextlib
import os
import sys
import time
import tempfile
from pathlib import Path
import numpy as np
class HumanGpuError(RuntimeError):
 def __init__(self,code,message):self.code=code;super().__init__(code+': '+message)
try:import warp as wp
except ImportError as exc:raise HumanGpuError('HUMAN_GPU_DEPENDENCY_MISSING','显式CUDA人体需要独立warp-lang==1.13.0')from exc

wp.set_module_options({'enable_backward':False,'fast_math':False,'fuse_fp':False})
D=wp.float64

@wp.func
def rotate(q:wp.vec4d,v:wp.vec3d):
 tx=D(2)*(q[2]*v[2]-q[3]*v[1]);ty=D(2)*(q[3]*v[0]-q[1]*v[2]);tz=D(2)*(q[1]*v[1]-q[2]*v[0])
 return wp.vec3d(v[0]+q[0]*tx+q[2]*tz-q[3]*ty,v[1]+q[0]*ty+q[3]*tx-q[1]*tz,v[2]+q[0]*tz+q[1]*ty-q[2]*tx)

@wp.func
def multiply(a:wp.vec4d,b:wp.vec4d):
 return wp.vec4d(a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3],a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1],a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0])

@wp.func
def slot(times:wp.array(dtype=D),start:int,count:int,t:D):
 i=int(0)
 while i+1<count and t>=times[start+i+1]:i+=1
 j=wp.min(i+1,count-1);u=D(0);denominator=times[start+j]-times[start+i]
 if denominator>D(0):u=wp.clamp((t-times[start+i])/denominator,D(0),D(1))
 return wp.vec3d(D(i),D(j),u)

@wp.kernel
def clip_fk(inputs:wp.array2d(dtype=D),parents:wp.array(dtype=wp.int32),offsets:wp.array2d(dtype=D),rest:wp.array2d(dtype=D),
 r_index:wp.array2d(dtype=wp.int32),r_times:wp.array(dtype=D),r_values:wp.array2d(dtype=D),t_index:wp.array2d(dtype=wp.int32),t_times:wp.array(dtype=D),t_values:wp.array2d(dtype=D),
 duration:D,bones:int,motion_kind:int,motion_joint:int,drift:wp.vec3d,baseline:wp.vec3d,output:wp.array3d(dtype=D)):
 actor=wp.tid();root=wp.vec3d(inputs[actor,0],inputs[actor,1],inputs[actor,2]);root_q=wp.vec4d(inputs[actor,3],inputs[actor,4],inputs[actor,5],inputs[actor,6]);t=(inputs[actor,7]+inputs[actor,8]*duration)%duration
 # Warp是fmod；保留既有phase可为负数的Python/NumPy正余数语义。
 if t<D(0):t=t+duration
 if t==D(0):t=D(0)
 for joint in range(bones):
  q=wp.vec4d(rest[joint,0],rest[joint,1],rest[joint,2],rest[joint,3]);v=wp.vec3d(offsets[joint,0],offsets[joint,1],offsets[joint,2]);rs=r_index[joint,0];rc=r_index[joint,1]
  if rc>0:
   indices=slot(r_times,rs,rc,t);i=rs+int(indices[0]);j=rs+int(indices[1]);u=indices[2]
   if r_index[joint,2]==1:u=D(0)
   a=wp.vec4d(r_values[i,0],r_values[i,1],r_values[i,2],r_values[i,3]);b=wp.vec4d(r_values[j,0],r_values[j,1],r_values[j,2],r_values[j,3]);dot=a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3]
   if dot<D(0):b=-b;dot=-dot
   if dot>D(.9995):
    q=(D(1)-u)*a+u*b;q=q/wp.sqrt(q[0]*q[0]+q[1]*q[1]+q[2]*q[2]+q[3]*q[3])
   else:
    theta=wp.acos(wp.clamp(dot,D(-1),D(1)));q=(wp.sin((D(1)-u)*theta)*a+wp.sin(u*theta)*b)/wp.sin(theta)
  ts=t_index[joint,0];tc=t_index[joint,1]
  if tc>0:
   indices=slot(t_times,ts,tc,t);i=ts+int(indices[0]);j=ts+int(indices[1]);u=indices[2]
   if t_index[joint,2]==1:u=D(0)
   v=(D(1)-u)*wp.vec3d(t_values[i,0],t_values[i,1],t_values[i,2])+u*wp.vec3d(t_values[j,0],t_values[j,1],t_values[j,2])
  parent=parents[joint];p=root;pq=root_q
  if parent>=0:p=wp.vec3d(output[actor,parent,0],output[actor,parent,1],output[actor,parent,2]);pq=wp.vec4d(output[actor,parent,3],output[actor,parent,4],output[actor,parent,5],output[actor,parent,6])
  p=p+rotate(pq,v);q=multiply(pq,q)
  for k in range(3):output[actor,joint,k]=p[k]
  for k in range(4):output[actor,joint,3+k]=q[k]
 if motion_kind>0:
  shift=wp.vec3d(D(0),D(0),D(0))
  if motion_kind==1:shift=drift*(t/duration)
  else:
   inverse=wp.vec4d(root_q[0],-root_q[1],-root_q[2],-root_q[3]);local=rotate(inverse,wp.vec3d(output[actor,motion_joint,0],output[actor,motion_joint,1],output[actor,motion_joint,2])-root);shift=wp.vec3d(local[0]-baseline[0],local[1]-baseline[1],D(0))
  shift=rotate(root_q,shift)
  for joint in range(bones):
   for k in range(3):output[actor,joint,k]=output[actor,joint,k]-shift[k]

class ClipBatch:
 """GPU buffer/graph只绑定不可变定义、clip与批大小；输入来自当前World tick。"""
 def __init__(self,cfg,count,clip_name,device='cuda:0',cache_root=None):
  if not isinstance(count,int)or not 1<=count<=1000:raise ValueError('HUMAN_GPU_BATCH_INVALID: 批大小须1-1000')
  if wp.__version__!='1.13.0':raise HumanGpuError('HUMAN_GPU_DEPENDENCY_VERSION','当前受验版本为warp-lang==1.13.0，实际'+wp.__version__)
  configured=cache_root or os.environ.get('LYAPUNOV_HUMAN_GPU_CACHE_ROOT')
  if not configured:raise HumanGpuError('HUMAN_GPU_CACHE_REQUIRED','显式CUDA人体需要当前Provider的可写私有cacheRoot')
  cache=Path(configured).resolve()
  try:
   cache.mkdir(parents=True,exist_ok=True)
   with tempfile.TemporaryFile(dir=cache):pass
  except OSError as exc:raise HumanGpuError('HUMAN_GPU_CACHE_UNWRITABLE','GPU内核缓存不可写: '+str(cache))from exc
  wp.config.kernel_cache_dir=str(cache)
  try:
   with contextlib.redirect_stdout(sys.stderr):wp.init()
   self.device=wp.get_device(device)
  except Exception as exc:raise HumanGpuError('HUMAN_CUDA_UNAVAILABLE','显式GPU人体计算的CUDA设备不可用: '+str(exc))from exc
  if not self.device.is_cuda:raise HumanGpuError('HUMAN_CUDA_UNAVAILABLE','显式GPU人体计算需要CUDA设备')
  self.count=count;self.names=[j['name']for j in cfg['rig']];self.bones=len(self.names);self.calls=0;self.closed=False;self.stream=wp.Stream(self.device);indices={name:i for i,name in enumerate(self.names)};clip=next(c for c in cfg['clips']if c['name']==clip_name)
  parents=np.asarray([indices.get(j.get('parent'),-1)for j in cfg['rig']],dtype=np.int32);offsets=np.asarray([j['offsetM']for j in cfg['rig']],dtype=np.float64);rest=np.asarray([[j['quaternionXyzw'][3],*j['quaternionXyzw'][:3]]for j in cfg['rig']],dtype=np.float64)
  def tracks(rows,key,width,rotation=False):
   metadata=np.zeros((self.bones,3),dtype=np.int32);times=[];values=[]
   for track in rows:
    metadata[indices[track['joint']]]=[len(times),len(track['timesS']),int(track['interpolation']=='STEP')];times.extend(track['timesS']);values.extend([[q[3],*q[:3]]for q in track[key]]if rotation else track[key])
   # 空track保留合法只读占位，不增加任何实际通道。
   return metadata,np.asarray(times or[0.],dtype=np.float64),np.asarray(values or[[0.]*width],dtype=np.float64)
  ri,rt,rv=tracks(clip['tracks'],'rotationsXyzw',4,True);ti,tt,tv=tracks(clip.get('translations',[]),'positionsM',3)
  arrays=[parents,offsets,rest,ri,rt,rv,ti,tt,tv];self.immutable=[wp.array(a,dtype=wp.int32 if a.dtype==np.int32 else D,device=self.device)for a in arrays]
  self.host_inputs=wp.zeros((count,9),dtype=D,device='cpu',pinned=True);self.device_inputs=wp.empty((count,9),dtype=D,device=self.device);self.device_output=wp.empty((count,self.bones,7),dtype=D,device=self.device);self.host_output=wp.empty((count,self.bones,7),dtype=D,device='cpu',pinned=True);self._input=self.host_inputs.numpy();self._output=self.host_output.numpy();self._input[:,3]=1.
  mapping=clip.get('rootMotion');kind=0 if not mapping else 1 if mapping['horizontal']=='remove-drift'else 2;root_joint=indices[mapping['joint']]if mapping else 0;drift=wp.vec3d(*(mapping.get('driftM',[0.,0.,0.])if mapping else[0.,0.,0.]));baseline=wp.vec3d(*(mapping['baselineM']if mapping else[0.,0.,0.]));self.arguments=[self.device_inputs,*self.immutable,D(clip['durationS']),self.bones,kind,root_joint,drift,baseline,self.device_output]
  started=time.perf_counter();self.graph=None
  try:
   with contextlib.redirect_stdout(sys.stderr):
    wp.copy(self.device_inputs,self.host_inputs,stream=self.stream);wp.launch(clip_fk,dim=count,inputs=self.arguments,device=self.device,stream=self.stream);wp.synchronize_stream(self.stream)
    wp.capture_begin(device=self.device,stream=self.stream)
    try:
     wp.copy(self.device_inputs,self.host_inputs,stream=self.stream);wp.launch(clip_fk,dim=count,inputs=self.arguments,device=self.device,stream=self.stream);wp.copy(self.host_output,self.device_output,stream=self.stream)
    finally:self.graph=wp.capture_end(device=self.device,stream=self.stream)
  except BaseException:self.close();raise
  self.prepare_s=time.perf_counter()-started
 def sample(self,roots,quaternions,elapsed,phases):
  if self.closed:raise HumanGpuError('HUMAN_GPU_CLOSED','本World GPU批已释放')
  if roots.shape!=(self.count,3)or quaternions.shape!=(self.count,4)or elapsed.shape!=(self.count,)or phases.shape!=(self.count,):raise ValueError('HUMAN_GPU_BATCH_INVALID: 当前根/相位输入维度不匹配')
  self._input[:,:3]=roots;self._input[:,3:7]=quaternions;self._input[:,7]=elapsed;self._input[:,8]=phases;wp.capture_launch(self.graph,stream=self.stream);wp.synchronize_stream(self.stream);self.calls+=1
  if not np.isfinite(self._output).all():raise HumanGpuError('HUMAN_GPU_NONFINITE','当前CUDA骨骼计算产生非有限值，未提交原生目标')
  return self._output[:,:,:3].copy(),self._output[:,:,3:].copy()
 def facts(self):return{'backend':'warp-cuda-float64','device':self.device.alias,'name':self.device.name,'uuid':self.device.uuid,'arch':self.device.arch,'warpVersion':wp.__version__,'dtype':'float64','fastMath':False,'fuseFp':False,'actors':self.count,'bones':self.bones,'kernelCalls':self.calls,'graphReplays':self.calls,'prepareS':self.prepare_s,'closed':self.closed}
 def close(self):
  if self.closed:return
  try:wp.synchronize_stream(self.stream)
  finally:self.graph=None;self.arguments=None;self.immutable=None;self._input=None;self._output=None;self.host_inputs=None;self.device_inputs=None;self.device_output=None;self.host_output=None;self.stream=None;self.closed=True

class ModelBatches:
 """当前model的有界GPU资源缓存；不持有World/模型对象/动作状态，只接受当前tick数组。"""
 def __init__(self,cfg,model_token,device,cache_root):
  self.model_token=model_token;self.device_name=device;self.cache_root=cache_root;self.batches={};self.completed_calls=0;self.closed=False;self.preparation_s=0.;self.hardware=None
  self.crowd=None;self.crowd_key=None
  self._batch(cfg,1,cfg['clips'][0]['name'])
 def _batch(self,cfg,count,clip):
  if self.closed:raise HumanGpuError('HUMAN_GPU_CLOSED','当前model的GPU资源已释放')
  key=(cfg['_batchSignature'],clip,count);batch=self.batches.pop(key,None)
  if batch is None:
   started=time.perf_counter();batch=ClipBatch(cfg,count,clip,self.device_name,self.cache_root);self.preparation_s+=time.perf_counter()-started
   if self.hardware is None:self.hardware=batch.facts()
   if len(self.batches)>=16:
    previous=self.batches.pop(next(iter(self.batches)));self.completed_calls+=previous.calls;previous.close()
  self.batches[key]=batch;return batch
 def sample(self,cfg,roots,quaternions,elapsed,phases,clip):return self._batch(cfg,len(roots),clip).sample(roots,quaternions,elapsed,phases)
 def crowd_batch(self,key,entries):
  # 人群批成员在动作内固定（含本tick停住的行）；成员集变化才重建graph，同动作内复用。
  if self.closed:raise HumanGpuError('HUMAN_GPU_CLOSED','当前model的GPU资源已释放')
  if self.crowd is None or self.crowd_key!=key:
   if self.crowd is not None:self.completed_calls+=self.crowd.calls;self.crowd.close();self.crowd=None
   started=time.perf_counter()
   from human_gpu_multi import CrowdPoseBatch
   self.crowd=CrowdPoseBatch(entries,self.device_name,self.cache_root);self.crowd_key=key
   self.preparation_s+=time.perf_counter()-started
  return self.crowd
 def facts(self):
  hardware=self.hardware or{}
  crowd=self.crowd.calls if self.crowd is not None else 0
  base={key:hardware[key]for key in ['backend','device','name','uuid','arch','warpVersion','dtype','fastMath','fuseFp']if key in hardware}|{'kernelCalls':self.completed_calls+sum(batch.calls for batch in self.batches.values())+crowd,'activeBatches':len(self.batches)+(1 if self.crowd is not None else 0),'prepareS':self.preparation_s,'closed':self.closed}
  if self.crowd is not None:base.update({'crowdGraphReplays':crowd,'crowdActors':self.crowd.count,'crowdDescriptions':self.crowd.descriptions,'crowdPrepareS':self.crowd.prepare_s,'crowdSampleSyncS':self.crowd.sample_s})
  return base
 def close(self):
  if self.closed:return
  errors=[]
  if self.crowd is not None:
   self.completed_calls+=self.crowd.calls
   try:self.crowd.close()
   except Exception as exc:errors.append(str(exc))
   self.crowd=None;self.crowd_key=None
  for batch in self.batches.values():
   self.completed_calls+=batch.calls
   try:batch.close()
   except Exception as exc:errors.append(str(exc))
  self.batches.clear();self.closed=True
  if errors:raise HumanGpuError('HUMAN_GPU_RELEASE_FAILED','; '.join(errors))
