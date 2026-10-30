"""同一World.tick中的人群NumPy合批；不持有时钟/世界/控制状态，不改变碰撞体或物理步长。"""
import collections.abc
import numpy as np
import human


class ClipPoseMap(collections.abc.Mapping):
 """惰性末姿态：只持有该行的names与独立的p(bones,3)/q(bones,4)拷贝，不再每tick逐骨建dict。
 items()/sampled[name]按names顺序产出(name,(p[i],q[i]))，供complete_pose/write_mujoco_pose原样消费。"""
 __slots__=('names','p','q','index')
 def __init__(self,names,p,q):self.names=names;self.p=p;self.q=q;self.index={name:i for i,name in enumerate(names)}
 def __getitem__(self,name):i=self.index[name];return self.p[i],self.q[i]
 def __iter__(self):return iter(self.names)
 def __len__(self):return len(self.names)

def z_quaternion(direction):
 # 与原生mju_quatZ2Vec同一atan2轴角构造；1+unit.z在近反向Z会消减，不能用它改变传感器段坐标帧。
 length=np.linalg.norm(direction,axis=-1);unit=direction/np.maximum(length,1e-30)[...,None];axis_length=np.hypot(unit[...,0],unit[...,1]);valid=(length>=1e-15)&(axis_length>=1e-15);half=np.arctan2(axis_length,unit[...,2])/2;q=np.zeros((*length.shape,4));q[...,0]=1.;q[...,0][valid]=np.cos(half[valid]);sine=np.sin(half[valid])/axis_length[valid];q[...,1][valid]=-unit[...,1][valid]*sine;q[...,2][valid]=unit[...,0][valid]*sine;opposite=(length>=1e-15)&~valid&(unit[...,2]<0);q[opposite]=[0,1,0,0];return q

def eligible(info,m):
 cfg=info.get('human')or{};route=m.get('_route')or{}
 return cfg.get('mode')=='kinematic'and cfg.get('source',{}).get('kind')=='procedural'and not route.get('navigation')and not route.get('yieldToHumans')and not route.get('clip')

def clip_eligible(info,m):
 cfg=info.get('human')or{};route=m.get('_route')or{}
 return cfg.get('mode')=='kinematic'and cfg.get('source',{}).get('kind')=='rigged-glb'and bool(route.get('clip'))and not route.get('navigation')and not route.get('yieldToHumans')

def path_eligible(info,m,allow_clips=True):return eligible(info,m)or allow_clips and clip_eligible(info,m)

def path_states(world,infos,motions,elapsed,candidates,allow_clips=True):
 # 路线经prepare校验且在动作内不可变；缓存原生动作所属的折线数组，不持有另一份控制时钟。
 # 累计长度用严格“offset > 段末”选索引，保留标量在端点/零长度段/loop停留处的朝向语义。
 rows=[(i,m)for i,m in zip(infos,motions)if path_eligible(i,m,allow_clips)and elapsed<=m['_duration']+1e-12]
 if len(rows)<2:return {}
 identity=tuple(id(m)for i,m in rows);first=rows[0][1];cache=first.get('_batchPathGroup')
 if cache is None or cache['identity']!=identity:
  count=len(rows);width=max(1,max(len(m['_lengths'])for i,m in rows));a=np.empty((count,width,3));b=np.empty_like(a);ends=np.full((count,width),np.inf);starts=np.zeros_like(ends);lengths=np.zeros_like(ends)
  for n,(_,m)in enumerate(rows):
   size=len(m['_lengths']);a[n]=m['_origin'];b[n]=m['_origin']
   if size:a[n,:size]=m['_points'][:-1];b[n,:size]=m['_points'][1:];lengths[n,:size]=m['_lengths'];ends[n,:size]=np.cumsum(m['_lengths']);starts[n,1:size]=ends[n,:size-1]
  cache={'identity':identity,'a':a,'b':b,'ends':ends,'starts':starts,'lengths':lengths,'total':np.asarray([sum(m['_lengths'])for i,m in rows]),'speed':np.asarray([m['_route']['speedMps']for i,m in rows]),'moving':np.asarray([m['_route']['behavior']!='stand'for i,m in rows]),'loop':np.asarray([bool(m['_route'].get('loop'))for i,m in rows]),'dwell':np.asarray([m['_route'].get('dwellS',0.)for i,m in rows]),'turn':np.asarray([m['_route'].get('turnRateRadps',2.5)for i,m in rows]),'rootQ':np.stack([m['_rootQ']for i,m in rows])};first['_batchPathGroup']=cache
 dt=np.maximum(0,elapsed-np.asarray([m['_lastElapsed']for i,m in rows]));distance=np.asarray([m['_distance']for i,m in rows])+dt*cache['speed']*cache['moving'];total=cache['total'];cycle=total+cache['speed']*cache['dwell'];wrapped=np.remainder(distance,np.where(cycle>0,cycle,1.));offset=np.minimum(np.where(cache['loop']&(cycle>0),wrapped,distance),total);near_edge=np.any(np.abs(offset[:,None]-cache['ends'])<=1e-10*np.maximum(1,total[:,None]),axis=1);index=np.minimum(cache['ends'].shape[1]-1,np.sum(offset[:,None]>cache['ends'],axis=1));row=np.arange(len(rows));a=cache['a'][row,index];b=cache['b'][row,index];delta=b-a;length=cache['lengths'][row,index];local=offset-cache['starts'][row,index];fraction=np.minimum(1,np.divide(local,length,out=np.ones_like(local),where=length>0));roots=a+delta*fraction[:,None]
 yaw=np.asarray([m['_yaw']for i,m in rows]);horizontal=(total>0)&(np.hypot(delta[:,0],delta[:,1])>1e-9);difference=(np.arctan2(delta[:,1],delta[:,0])-yaw+np.pi)%(2*np.pi)-np.pi;limit=cache['turn']*dt;yaw=np.where(horizontal,yaw+np.clip(difference,-limit,limit),yaw);qs=cache['rootQ'].copy();qs[horizontal]=np.stack([np.cos(yaw[horizontal]/2),np.zeros(horizontal.sum()),np.zeros(horizontal.sum()),np.sin(yaw[horizontal]/2)],axis=1);stopped=(total==0)|(~cache['loop']&(distance>=total))|(cache['loop']&(total>0)&(wrapped>=total));states={}
 for n,(info,m)in enumerate(rows):
  # Python浮点sum与NumPy累加可能在端点差最后一位；沿用原标量判定，不能提前一tick换转向段。
  if near_edge[n]:states[id(m)]=human.advance(world,info,m,elapsed,defer_pose=True,obstacle_candidate=candidates.get(id(m)));continue
  m['_lastElapsed']=elapsed;m['_distance']=float(distance[n]);m['_yaw']=float(yaw[n]);m['_yielded']=False;root=roots[n];halt=bool(stopped[n]);blocked=None
  if m['_route'].get('avoidObstacles',True)and candidates.get(id(m))is not False:root,halt,blocked=human.constrain_root(world,info,m,root,halt,float(dt[n]),candidates.get(id(m)))
  states[id(m)]=(root,qs[n],'stand'if halt else m['_route']['behavior'],halt,blocked,float(dt[n]))
 return states

def advance(world,motions,elapsed):
 groups={};clip_groups={};gpu_rows=[];candidates={};infos=[world.info(m['entityId'])for m in motions]
 # 混合导航/互让/动态队列保持原标量外部动作顺序，避免更晚回退成员看见不同的前人根位置。
 allow_clips=not any((m.get('_route')or{}).get('navigation')or(m.get('_route')or{}).get('yieldToHumans')or i.get('human',{}).get('mode')!='kinematic'for i,m in zip(infos,motions))
 gpu_clip=allow_clips and getattr(world,'human_compute_device','cpu')!='cpu'
 # 同一tick把保守前探包围盒合批。只证明不可能相交时跳过ray；.85m仍包含原.65m前探与.2m侧线。
 # 本步可能运动距离取speed×dt的各轴上界；斜线/转角/闭合loop都在此球的AABB内。
 bounded=[(info,m)for info,m in zip(infos,motions)if path_eligible(info,m,allow_clips)and m['_route'].get('avoidObstacles',True)]
 if bounded:
  bounds=human.obstacle_bounds(world)
  if bounds is not None:
   low,high=bounds;roots=np.asarray([i['humanRoot']for i,m in bounded]);height=np.asarray([i['human']['heightM']for i,m in bounded]);travel=np.asarray([m['_route']['speedMps']*max(0,elapsed-m['_lastElapsed'])for i,m in bounded]);lo=roots-np.stack([.85+travel,.85+travel,np.zeros_like(travel)],axis=1);hi=roots+np.stack([.85+travel,.85+travel,np.zeros_like(travel)],axis=1);lo[:,2]=roots[:,2]+.22*height/1.75;hi[:,2]=roots[:,2]+1.35*height/1.75
   intersects=np.any(np.all(high[None,:,:]>=lo[:,None,:],axis=2)&np.all(low[None,:,:]<=hi[:,None,:],axis=2),axis=1);candidates={id(m):bool(value)for(_,m),value in zip(bounded,intersects)}
 paths=path_states(world,infos,motions,elapsed,candidates,allow_clips)
 for info,motion in zip(infos,motions):
  if not path_eligible(info,motion,allow_clips):human.advance(world,info,motion,elapsed);continue
  state=paths.get(id(motion))if id(motion)in paths else human.advance(world,info,motion,elapsed,defer_pose=True,obstacle_candidate=candidates.get(id(motion)))
  if state is None:continue
  if clip_eligible(info,motion):
   if state[3]:human.complete_pose(world,info,motion,elapsed,state);continue
   # GPU：clip行人不再按签名/clip分组、不再有<4走标量的规则；全部进一次人群graph。
   if gpu_clip:gpu_rows.append((info,motion,state));continue
   key=(info['human']['_batchSignature'],motion['_route']['clip']);clip_groups.setdefault(key,[]).append((info,motion,state))
   continue
  root,q,behavior,stopped,blocked,dt=state;speed=0. if stopped else motion['_route']['speedMps'];cfg=info['human'];key=(cfg['_samplingIdentity'],behavior,round(speed,6),cfg['collision']);groups.setdefault(key,[]).append((info,motion,state,speed))
 for _,rows in groups.items():
  first=rows[0];table=human.sample_table(world,first[0]['human'],first[2][2],first[3])
  if table is None:
   for info,motion,state,speed in rows:
    root,q,behavior,stopped,blocked,dt=state;sampled=human.pose(info['human'],root,q,elapsed,behavior,speed);human.write_mujoco_pose(world,info,root,q,sampled);human.record_motion(info,motion,root,q,behavior,blocked,dt)
   continue
  names,positions,quaternions,frequency=table;phase=(np.asarray([row[0]['human']['phase']for row in rows])+elapsed*frequency)%1*128;index=phase.astype(np.int32);weight=(phase-index)[:,None,None];local_p=positions[index]*(1-weight)+positions[(index+1)%128]*weight;local_q=quaternions[index]*(1-weight)+quaternions[(index+1)%128]*weight;local_q/=np.linalg.norm(local_q,axis=-1)[...,None]
  roots=np.asarray([r[2][0]for r in rows]);qs=np.asarray([r[2][1]for r in rows]);root_ids=np.asarray([r[0]['humanRootMocap']for r in rows]);sites=np.stack([r[0]['humanSiteIndices']for r in rows])
  # 每段仍是原有独立顶层mocap刚体；只合并数组运算和写入，不替换或关闭真实分段碰撞。
  first_info=rows[0][0]
  if 'humanSegmentA'not in first_info:
   order={name:i for i,name in enumerate(names)};first_info['humanSegmentA']=np.asarray([order[s['a']]for s in first_info['humanSegments']]);first_info['humanSegmentB']=np.asarray([order[s['b']]for s in first_info['humanSegments']])
  if np.all(qs==[1,0,0,0]):world_p=local_p+roots[:,None,:]
  else:
   matrices=np.empty((len(rows),9))
   for n,q in enumerate(qs):human.mj.mju_quat2Mat(matrices[n],q)
   world_p=local_p@matrices.reshape(-1,3,3).transpose(0,2,1)+roots[:,None,:]
  a,b=world_p[:,first_info['humanSegmentA']],world_p[:,first_info['humanSegmentB']];segment_ids=np.asarray([[s['mocap']for s in r[0]['humanSegments']]for r in rows]);world_centers=(a+b)/2;world_quaternions=z_quaternion(b-a)
  # 先完成全部计算，再提交本组原生数组；与标量World-Z→段方向旋转相同，保留挂载传感器帧。
  world.data.mocap_pos[root_ids]=roots;world.data.mocap_quat[root_ids]=qs;world.model.site_pos[sites]=local_p;world.model.site_quat[sites]=local_q;world.data.mocap_pos[segment_ids]=world_centers;world.data.mocap_quat[segment_ids]=world_quaternions
  for info,motion,state,_ in rows:
   root,q,behavior,stopped,blocked,dt=state;human.record_motion(info,motion,root,q,behavior,blocked,dt)

 # 外部动作保持原始track精确采样；不同定义/源单位/足校准决不共享组。
 for key,rows in clip_groups.items():
  if len(rows)<4:
   for info,m,state in rows:human.complete_pose(world,info,m,elapsed,state)
  else:write_clip_group(world,rows,elapsed,key[1])
 # GPU人群路径在分组之后：批成员是动作内固定的全体clip_eligible行人（含本tick停住的行，
 # 它们保留上次有限输入照算但被Python忽略），本tick参与的行单独写回。
 if gpu_clip:
  members=[(info,m)for info,m in zip(infos,motions)if clip_eligible(info,m)]
  if members and gpu_rows:write_clip_rows_gpu(world,members,gpu_rows,elapsed)

def write_clip_group(world,rows,elapsed,clip_name):
 first=rows[0];cfg=first[0]['human'];names=cfg['_poseRuntime']['names'];roots=np.asarray([r[2][0]for r in rows]);qs=np.asarray([r[2][1]for r in rows]);times=np.asarray([elapsed-r[1].get('_clipPausedS',0.)for r in rows]);phases=np.asarray([r[0]['human']['phase']for r in rows]);world_p,world_q=world.sample_human_clip(cfg,roots,qs,times,phases,clip_name)if hasattr(world,'sample_human_clip')else human.sample_clip_batch(cfg,roots,qs,times,phases,clip_name)
 identity=(id(world.model),tuple(id(r[0])for r in rows));cache=first[1].get('_clipGroupIndices')
 if cache is None or cache['identity']!=identity:
  order={name:i for i,name in enumerate(names)};segments=first[0]['humanSegments'];cache={'identity':identity,'roots':np.asarray([r[0]['humanRootMocap']for r in rows]),'sites':np.stack([r[0]['humanSiteIndices']for r in rows]),'segments':np.asarray([[s['mocap']for s in r[0]['humanSegments']]for r in rows]),'a':np.asarray([order[s['a']]for s in segments]),'b':np.asarray([order[s['b']]for s in segments]),'feet':[(n,order[s['calibration']['frameJoint']],np.asarray(s['calibration']['endpointsM']))for n,s in enumerate(segments)if s.get('calibration')]};first[1]['_clipGroupIndices']=cache
 matrices=np.empty((len(rows),9))
 for n,q in enumerate(qs):human.mj.mju_quat2Mat(matrices[n],q)
 local_p=(world_p-roots[:,None,:])@matrices.reshape(-1,3,3);inverse=qs.copy();inverse[:,1:]*=-1;local_q=human.multiply_batch(inverse[:,None,:],world_q);a=world_p[:,cache['a']].copy();b=world_p[:,cache['b']].copy()
 for index,joint,points in cache['feet']:
  anchor=world_p[:,joint];q=world_q[:,joint];a[:,index]=anchor+human.rotate_batch(q,points[0]);b[:,index]=anchor+human.rotate_batch(q,points[1])
 centers=(a+b)/2;segment_q=z_quaternion(b-a)
 # 缓存每人独立数值副本，避免一个停住的人保留整个批组大数组；计算全部结束再提交本组。
 for n,(info,m,state)in enumerate(rows):
  p=world_p[n].copy();q=world_q[n].copy();human.remember_clip_pose(m,state[0],state[1],{name:(p[i],q[i])for i,name in enumerate(names)})
 world.data.mocap_pos[cache['roots']]=roots;world.data.mocap_quat[cache['roots']]=qs;world.model.site_pos[cache['sites']]=local_p;world.model.site_quat[cache['sites']]=local_q;world.data.mocap_pos[cache['segments']]=centers;world.data.mocap_quat[cache['segments']]=segment_q
 for info,m,state in rows:
  root,q,behavior,stopped,blocked,dt=state;human.record_motion(info,m,root,q,behavior,blocked,dt)

def _segments_desc(info):
 """每人14段的写回目标描述：a/b或足段frameJoint骨索引（按_poseRuntime names顺序）与端点。"""
 names=info['human']['_poseRuntime']['names'];order={name:i for i,name in enumerate(names)}
 desc=[]
 for seg in info['humanSegments']:
  calibration=seg.get('calibration')
  if calibration:desc.append({'joint':order[calibration['frameJoint']],'p0':list(calibration['endpointsM'][0]),'p1':list(calibration['endpointsM'][1])})
  else:desc.append({'a':order[seg['a']],'b':order[seg['b']]})
 return desc

def write_clip_rows_gpu(world,members,rows,elapsed):
 """GPU一次人群graph：输入组装→CrowdPoseBatch.sample→扁平索引写回6个原生数组→末姿态→record_motion。
 members是动作内固定的全体clip_eligible行人（含本tick未参与者）；rows只含本tick实际参与行。"""
 first=members[0][1];key=(id(world.model),tuple(id(i)for i,m in members),tuple(m['_route']['clip']for i,m in members))
 cache=first.get('_clipCrowdIndices')
 if cache is None or cache['key']!=key:
  entries=[(i['human'],m['_route']['clip'],_segments_desc(i))for i,m in members]
  batch=world.human_crowd_batch(key,entries)
  index={id(m):k for k,(i,m)in enumerate(members)}
  cache={'key':key,'batch':batch,'index':index,'flat':{},'rows':[
   {'root':i['humanRootMocap'],'sites':i['humanSiteIndices'],
    'segments':np.asarray([s['mocap']for s in i['humanSegments']],dtype=np.int32),
    'names':i['human']['_poseRuntime']['names'],'bones':len(i['human']['_poseRuntime']['names']),
    'segs':len(i['humanSegments'])}for i,m in members]}
  first['_clipCrowdIndices']=cache
 batch=cache['batch'];index=np.asarray([cache['index'][id(m)]for i,m,s in rows],dtype=np.int64)
 roots=np.asarray([s[0]for i,m,s in rows]);qs=np.asarray([s[1]for i,m,s in rows])
 times=np.asarray([elapsed-m.get('_clipPausedS',0.)for i,m,s in rows]);phases=np.asarray([i['human']['phase']for i,m,s in rows])
 world_p,world_q,site_p,site_q,centers,seg_q=batch.sample(index,roots,qs,times,phases)
 data=world.data;model=world.model
 # 只写本tick参与的行；gather/scatter扁平索引按(批成员,参与行集合)缓存，每tick共6次赋值。
 participant=tuple(cache['index'][id(m)]for i,m,s in rows);flat=cache['flat'].get(participant)
 if flat is None:
  root_ids=[];flat_sites=[];row_site=[];col_site=[];flat_segs=[];row_seg=[];col_seg=[]
  for n,(i,m,s)in enumerate(rows):
   ic=cache['rows'][cache['index'][id(m)]];root_ids.append(ic['root'])
   flat_sites.extend(ic['sites']);row_site.extend([n]*ic['bones']);col_site.extend(range(ic['bones']))
   flat_segs.extend(ic['segments']);row_seg.extend([n]*ic['segs']);col_seg.extend(range(ic['segs']))
  flat={'roots':np.asarray(root_ids),'sites':np.asarray(flat_sites),'rowSite':np.asarray(row_site),
        'colSite':np.asarray(col_site),'segs':np.asarray(flat_segs),'rowSeg':np.asarray(row_seg),
        'colSeg':np.asarray(col_seg)}
  if len(cache['flat'])>=8:cache['flat'].clear()
  cache['flat'][participant]=flat
 data.mocap_pos[flat['roots']]=roots;data.mocap_quat[flat['roots']]=qs
 model.site_pos[flat['sites']]=site_p[flat['rowSite'],flat['colSite']]
 model.site_quat[flat['sites']]=site_q[flat['rowSite'],flat['colSite']]
 data.mocap_pos[flat['segs']]=centers[flat['rowSeg'],flat['colSeg']]
 data.mocap_quat[flat['segs']]=seg_q[flat['rowSeg'],flat['colSeg']]
 for n,(info,m,state)in enumerate(rows):
  k=cache['index'][id(m)];ic=cache['rows'][k]
  human.remember_clip_pose(m,state[0],state[1],ClipPoseMap(ic['names'],world_p[n,:ic['bones']].copy(),world_q[n,:ic['bones']].copy()))
  root,q,behavior,stopped,blocked,dt=state;human.record_motion(info,m,root,q,behavior,blocked,dt)
