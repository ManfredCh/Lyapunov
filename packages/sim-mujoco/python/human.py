"""人体领域适配；由唯一World.tick调用。mocap只使用顶层body，ragdoll为自由根+球关节原生动力学。"""
import math
import copy
import json
import hashlib
import numpy as np
import mujoco as mj
import human_navigation as navigation

SEGMENTS=[('pelvis','spine',.12),('spine','chest',.14),('chest','neck',.115),('neck','head',.09),('leftHip','leftKnee',.065),('leftKnee','leftAnkle',.05),('leftAnkle','leftToe',.055),('rightHip','rightKnee',.065),('rightKnee','rightAnkle',.05),('rightAnkle','rightToe',.055),('leftShoulder','leftElbow',.045),('leftElbow','leftWrist',.037),('rightShoulder','rightElbow',.045),('rightElbow','rightWrist',.037)]
def mul(a,b):
 w,x,y,z=a;v,i,j,k=b
 return np.array([w*v-x*i-y*j-z*k,w*i+x*v+y*k-z*j,w*j-x*k+y*v+z*i,w*k+x*j-y*i+z*v])
def rotate(q,v):
 out=np.empty(3);mj.mju_rotVecQuat(out,np.asarray(v,dtype=float),np.asarray(q,dtype=float));return out
def xyzw(q):return [float(q[1]),float(q[2]),float(q[3]),float(q[0])]
def wxyz(q):return np.array([q[3],q[0],q[1],q[2]],dtype=float)
def finite_vector(v,n,error,label):
 if not isinstance(v,(list,tuple)) or len(v)!=n or any(isinstance(x,bool)or not isinstance(x,(int,float))or not math.isfinite(x)for x in v):raise error('HUMAN_INVALID',label+'须为有限向量')
 return np.asarray(v,dtype=float)
def validate_instance(cfg,error):
 if not isinstance(cfg,dict)or cfg.get('schema')!=1 or cfg.get('mode')not in ('kinematic','ragdoll')or cfg.get('collision')not in('detailed','coarse'):raise error('HUMAN_INVALID','人体schema/mode/collision不合法')
 if not isinstance(cfg.get('heightM'),(int,float))or not .5<=cfg['heightM']<=3:raise error('HUMAN_INVALID','身高须为0.5-3米')
 if cfg.get('mode')=='ragdoll'and cfg.get('collision')!='detailed':raise error('HUMAN_DYNAMIC_DETAILED_REQUIRED','ragdoll需要完整分段惯量与碰撞')

def validate(cfg,error):
 validate_instance(cfg,error)
 rig=cfg.get('rig');mapping=cfg.get('boneMapping')
 if not isinstance(rig,list)or not 1<=len(rig)<=128 or not isinstance(mapping,dict):raise error('HUMAN_INVALID','人体rig/mapping缺失')
 names=set()
 for j in rig:
  if not isinstance(j.get('name'),str)or j['name']in names or '/'in j['name']:raise error('HUMAN_INVALID','骨名须唯一且不含斜线')
  if j.get('parent')and j['parent']not in names:raise error('HUMAN_INVALID','骨架须按父先子后拓扑排序')
  finite_vector(j.get('offsetM'),3,error,'offsetM');q=finite_vector(j.get('quaternionXyzw'),4,error,'quaternion')
  if abs(np.linalg.norm(q)-1)>1e-4:raise error('HUMAN_INVALID','骨四元数须归一化')
  names.add(j['name'])
 if any(mapping.get(k)not in names for a,b,_ in SEGMENTS for k in(a,b)):raise error('HUMAN_BONE_MAPPING_MISSING','碰撞端点骨映射缺失')
 if not isinstance(cfg.get('heightM'),(int,float))or not .5<=cfg['heightM']<=3:raise error('HUMAN_INVALID','身高须为0.5-3米')
 if cfg.get('mode')=='ragdoll'and cfg.get('collision')!='detailed':raise error('HUMAN_DYNAMIC_DETAILED_REQUIRED','ragdoll需要完整分段惯量与碰撞')
 if cfg.get('footCollision'):
  calibration=cfg['footCollision']
  if calibration.get('schema')!=1 or cfg.get('source',{}).get('kind')!='rigged-glb' or not isinstance(calibration.get('segments'),dict):raise error('HUMAN_FOOT_CALIBRATION_INVALID','足段须为显式外部角色局部几何')
  for key,row in calibration['segments'].items():
   role={'leftAnkle-leftToe':'leftAnkle','rightAnkle-rightToe':'rightAnkle'}.get(key)
   if not role or row.get('frameJoint')!=mapping[role]or not isinstance(row.get('endpointsM'),list)or len(row['endpointsM'])!=2 or not isinstance(row.get('radiusM'),(int,float))or not .003<=row['radiusM']<=.15:raise error('HUMAN_FOOT_CALIBRATION_INVALID','足段几何/骨映射不合法')
   points=[finite_vector(v,3,error,'foot endpoint')for v in row['endpointsM']]
   if any(np.linalg.norm(v)>1 for v in points)or np.linalg.norm(points[1]-points[0])<1e-6:raise error('HUMAN_FOOT_CALIBRATION_INVALID','足段端点越界/重合')
 for c in cfg.get('clips',[]):
  for t in c.get('translations',[]):
   times=t.get('timesS',[]);values=t.get('positionsM',[])
   if t.get('joint')not in names or t.get('interpolation')not in('LINEAR','STEP')or not times or len(times)!=len(values)or any(not isinstance(x,(int,float))or not math.isfinite(x)or x<0 or i>0 and x<=times[i-1]for i,x in enumerate(times)):raise error('HUMAN_CLIP_TRANSLATION_INVALID','平移动作通道不合法')
   for value in values:finite_vector(value,3,error,'clip translation')
  root=c.get('rootMotion')
  if root:
   if root.get('joint')not in names or root.get('horizontal')not in('remove','remove-drift'):raise error('HUMAN_ROOT_MOTION_INVALID','根运动映射不合法')
   finite_vector(root.get('baselineM'),3,error,'root baseline')
   if root.get('horizontal')=='remove-drift':finite_vector(root.get('driftM'),3,error,'root drift')
  if not isinstance(c.get('durationS'),(int,float))or not math.isfinite(c['durationS'])or c['durationS']<=0:raise error('HUMAN_CLIP_INVALID','动作时长不合法')
  for t in c.get('tracks',[]):
   times=t.get('timesS',[]);qs=t.get('rotationsXyzw',[])
   if t.get('joint')not in names or t.get('interpolation')not in('LINEAR','STEP')or len(times)!=len(qs)or not times or any(not isinstance(x,(int,float))or not math.isfinite(x)or x<0 or i>0 and x<=times[i-1]for i,x in enumerate(times)):raise error('HUMAN_CLIP_INVALID','动作track不合法')
   for q in qs:
    if abs(np.linalg.norm(finite_vector(q,4,error,'clip quaternion'))-1)>1e-4:raise error('HUMAN_CLIP_INVALID','动作四元数须归一化')
 return cfg

def track_slot(track,time):
 times=track['timesS'];index=min(max(0,int(np.searchsorted(times,time,side='right'))-1),len(times)-1);next_index=min(index+1,len(times)-1)
 weight=0. if next_index==index or track['interpolation']=='STEP'else max(0.,min(1.,(time-times[index])/(times[next_index]-times[index])))
 return index,next_index,weight

def compile_pose(cfg):
 """仅解码不可变rig/clip；不存物理状态，也不对原Scene定义写入NumPy对象。"""
 rig=cfg['rig'];indices={j['name']:i for i,j in enumerate(rig)};clips={}
 for clip in cfg.get('clips',[]):
  groups={}
  for kind,tracks,key in [('rotation',clip['tracks'],'rotationsXyzw'),('translation',clip.get('translations',[]),'positionsM')]:
   for track in tracks:
    identity=(kind,track['interpolation'],tuple(track['timesS']));group=groups.setdefault(identity,{'kind':kind,'interpolation':track['interpolation'],'times':np.asarray(track['timesS'],dtype=float),'indices':[],'values':[]})
    values=np.asarray(track[key],dtype=float)
    if kind=='rotation':values=values[:,[3,0,1,2]]
    group['indices'].append(indices[track['joint']]);group['values'].append(values)
  for group in groups.values():group['indices']=np.asarray(group['indices'],dtype=np.int32);group['values']=np.asarray(group['values'])
  clips[clip['name']]={'source':clip,'groups':list(groups.values())}
 parents=[indices.get(j.get('parent'),-1)for j in rig];depth=np.zeros(len(rig),dtype=np.int32)
 for i,parent in enumerate(parents):depth[i]=0 if parent<0 else depth[parent]+1
 identity=hashlib.sha256(json.dumps([rig,cfg['boneMapping'],cfg.get('clips',[])],sort_keys=True,separators=(',',':')).encode()).hexdigest()
 return {'identity':identity,'levels':[np.flatnonzero(depth==n)for n in range(int(depth.max())+1)],'names':[j['name']for j in rig],'parents':parents,'offsets':np.asarray([j['offsetM']for j in rig],dtype=float),'rotations':np.asarray([wxyz(j['quaternionXyzw'])for j in rig]),'clips':clips}

def pose(cfg,root,q,elapsed=0,behavior='stand',speed=0,clip_name=None):
 runtime=cfg.get('_poseRuntime')
 if runtime is None:runtime=compile_pose(cfg)
 rotations=runtime['rotations'].copy();translations=runtime['offsets'].copy();prepared=runtime['clips'].get(clip_name);clip=prepared['source']if prepared else None
 if clip:
  time=(elapsed+cfg.get('phase',0)*clip['durationS'])%clip['durationS']
  for group in prepared['groups']:
   times=group['times'];i=min(max(0,int(np.searchsorted(times,time,side='right'))-1),len(times)-1);j=min(i+1,len(times)-1);u=0. if j==i or group['interpolation']=='STEP'else max(0.,min(1.,(time-times[i])/(times[j]-times[i])))
   values=group['values'];a=values[:,i];b=values[:,j]
   if group['kind']=='translation':translations[group['indices']]=(1-u)*a+u*b;continue
   dot=np.sum(a*b,axis=1);negative=dot<0;b=np.where(negative[:,None],-b,b);dot=np.where(negative,-dot,dot);linear=dot>.9995;rotation=np.empty_like(a)
   if np.any(linear):
    part=(1-u)*a[linear]+u*b[linear];rotation[linear]=part/np.linalg.norm(part,axis=1)[:,None]
   nonlinear=~linear
   if np.any(nonlinear):
    theta=np.arccos(np.clip(dot[nonlinear],-1.,1.));rotation[nonlinear]=(np.sin((1-u)*theta)[:,None]*a[nonlinear]+np.sin(u*theta)[:,None]*b[nonlinear])/np.sin(theta)[:,None]
   rotations[group['indices']]=rotation
 elif behavior in('walk','run')and speed>1e-6:
  phase=cfg.get('phase',0)*2*math.pi+elapsed*(2.8 if behavior=='run'else 1.7)*2*math.pi;amount=(.8 if behavior=='run'else .45)*min(1,speed/(2.8 if behavior=='run'else 1.2));indices={name:i for i,name in enumerate(runtime['names'])}
  for side,sign in [('left',1),('right',-1)]:
   swing=math.sin(phase)*sign;angles={side+'Hip':amount*swing,side+'Knee':-.7*max(0,-swing),side+'Shoulder':-amount*.65*swing,side+'Elbow':-.25-(.55 if behavior=='run'else .12)*max(0,swing)}
   for name,angle in angles.items():rotations[indices[cfg['boneMapping'].get(name,name)]]=[math.cos(angle/2),0,math.sin(angle/2),0]
 positions=np.empty_like(translations);orientations=np.empty_like(rotations)
 for i,parent in enumerate(runtime['parents']):
  position,orientation=(positions[parent],orientations[parent])if parent>=0 else(root,q)
  mj.mju_mulPose(positions[i],orientations[i],position,orientation,translations[i],rotations[i])
 if clip and clip.get('rootMotion'):
  mapping=clip['rootMotion'];inverse=np.array([q[0],-q[1],-q[2],-q[3]]);local=rotate(inverse,positions[runtime['names'].index(mapping['joint'])]-root);baseline=mapping['baselineM'];offset=np.asarray(mapping['driftM'])*(time/clip['durationS'])if mapping['horizontal']=='remove-drift'else np.array([local[0]-baseline[0],local[1]-baseline[1],0]);positions-=rotate(q,offset)
 return {name:(positions[i],orientations[i])for i,name in enumerate(runtime['names'])}

def segment_points(sampled,segment):
 calibration=segment.get('calibration')
 if calibration:
  p,q=sampled[calibration['frameJoint']];return tuple(p+rotate(q,v)for v in calibration['endpointsM'])
 return sampled[segment['a']][0],sampled[segment['b']][0]

def segment_calibration(cfg,a,b):return cfg.get('footCollision',{}).get('segments',{}).get(a+'-'+b)

def install_batch(spec,scene,poses,error,definition_cache):
 """先在独立的小MjSpec中装配每人，再以原生attach合入同一个物理模型。

 MjsBody.add_site对不断增长的全局树重复索引；每个人的根/独立mocap段/site、双精度姿态
 与碰撞参数均不改变。ragdoll继续原装配路径；不经只保留六位有效数字的to_xml序列化。
 """
 prepared={};children=[]
 for entity in scene['entities']:
  if(entity.get('components',{}).get('human')or{}).get('mode')!='kinematic':continue
  child=mj.MjSpec();eid=entity['entityId'];info,root=install(child,entity,*poses[eid],error,definition_cache);spec.attach(child,prefix='',frame=spec.worldbody.add_frame());prepared[eid]=info;children.append(child)
 return prepared,children

def install(spec,e,p,q,scale,error,definition_cache=None):
 cfg=copy.copy(e['components']['human']);eid=e['entityId'];prefix=eid+'/'
 key=(id(cfg.get('rig')),id(cfg.get('boneMapping')),id(cfg.get('clips')))
 if definition_cache is not None and key in definition_cache:validate_instance(cfg,error);identity=definition_cache[key]
 else:
  validate(cfg,error);identity=hashlib.sha256(json.dumps([cfg['rig'],cfg['boneMapping']],sort_keys=True).encode()).hexdigest()
  if definition_cache is not None:definition_cache[key]=identity
 cfg['_samplingIdentity']=identity
 # cfg是实例私有浅拷贝；资源定义仍只保存普通JSON。共享定义只编译一次不可变采样表。
 runtime_key=('pose',key)
 if definition_cache is not None and runtime_key in definition_cache:cfg['_poseRuntime']=definition_cache[runtime_key]
 else:
  cfg['_poseRuntime']=compile_pose(cfg)
  if definition_cache is not None:definition_cache[runtime_key]=cfg['_poseRuntime']
 cfg['_batchSignature']=(cfg['_poseRuntime']['identity'],json.dumps(cfg['source'],sort_keys=True,separators=(',',':')),cfg['heightM'],cfg['collision'],json.dumps(cfg.get('footCollision'),sort_keys=True,separators=(',',':')))
 if e.get('parentId')or not np.allclose(scale,[1,1,1]):raise error('HUMAN_TRANSFORM_UNSUPPORTED','人体须为场景根节点且scale=1；身高写入rig')
 route=cfg.get('route')or{};initial=pose(cfg,p,q,0,route.get('behavior','stand'),route.get('speedMps',0),route.get('clip')if cfg['mode']=='kinematic'else None);bodies={};segments=[]
 if cfg['mode']=='kinematic':
  root=spec.worldbody.add_body(name=prefix+'root',mocap=True,pos=p,quat=q)
  for j in cfg['rig']:
   pos,quat=initial[j['name']];inverse=np.array([q[0],-q[1],-q[2],-q[3]]);attributes={'name':prefix+'joint/'+j['name'],'pos':rotate(inverse,pos-p),'quat':mul(inverse,quat),'size':[.003,0,0],'rgba':[0,0,0,0],'group':5}
   bodies[j['name']]=root.add_site(**attributes)
  edges=SEGMENTS if cfg['collision']=='detailed'else[('pelvis','neck',.23)]
  for a,b,r in edges:
   calibration=segment_calibration(cfg,a,b);pa,pb=segment_points(initial,{'a':cfg['boneMapping'][a],'b':cfg['boneMapping'][b],'calibration':calibration});direction=pb-pa;half=np.linalg.norm(direction)/2;quat=np.zeros(4);mj.mju_quatZ2Vec(quat,direction)
   body_name=prefix+'segment/'+a+'-'+b;radius=calibration['radiusM']if calibration else r*cfg['heightM']/1.75;attributes={'name':prefix+'human/'+a+'-'+b,'size':[radius,half,0],'rgba':[.12,.42,.65,1],'friction':[.8,.01,.001],'group':0,'contype':2,'conaffinity':1,'solref':[.006,1]}
   body=spec.worldbody.add_body(name=body_name,mocap=True,pos=(pa+pb)/2,quat=quat);body.add_geom(type=mj.mjtGeom.mjGEOM_CAPSULE,**attributes)
   segments.append({'name':a+'-'+b,'a':cfg['boneMapping'][a],'b':cfg['boneMapping'][b],'radius':radius,'half':half,'bodyName':body_name,'geomName':attributes['name'],**({'calibration':calibration}if calibration else{})})
 else:
  for j in cfg['rig']:
   parent=bodies.get(j.get('parent'));is_root=parent is None
   body=(parent or spec.worldbody).add_body(name=prefix+'joint/'+j['name'],pos=(p+rotate(q,j['offsetM']))if is_root else j['offsetM'],quat=mul(q,wxyz(j['quaternionXyzw']))if is_root else wxyz(j['quaternionXyzw']))
   if is_root:body.add_freejoint(name=prefix+'human_free')
   else:body.add_joint(name=prefix+'ball/'+j['name'],type=mj.mjtJoint.mjJNT_BALL,damping=.3,limited=True,range=[0,100])
   body.add_geom(name=prefix+'jointgeom/'+j['name'],type=mj.mjtGeom.mjGEOM_SPHERE,size=[.032,0,0],mass=.08,rgba=[.12,.42,.65,1],group=0,contype=2,conaffinity=1)
   bodies[j['name']]=body
  root=next(iter(bodies.values()))
  for a,b,r in SEGMENTS:
   an,bn=cfg['boneMapping'][a],cfg['boneMapping'][b];base,qa=initial[an];calibration=segment_calibration(cfg,a,b);pa,pb=segment_points(initial,{'a':an,'b':bn,'calibration':calibration});inverse=np.array([qa[0],-qa[1],-qa[2],-qa[3]]);start=rotate(inverse,pa-base);end=rotate(inverse,pb-base);radius=calibration['radiusM']if calibration else r*cfg['heightM']/1.75
   geom=bodies[an].add_geom(name=prefix+'human/'+a+'-'+b,type=mj.mjtGeom.mjGEOM_CAPSULE,fromto=[*start,*end],size=[radius,0,0],mass=2.5,rgba=[.12,.42,.65,1],group=0,contype=2,conaffinity=1)
   segments.append({'name':a+'-'+b,'a':an,'b':bn,'radius':radius,'half':np.linalg.norm(end-start)/2,'geomName':geom.name})
 stored=e
 if cfg.get('definition'):
  stored={**e,'components':{**e['components'],'human':{k:v for k,v in e['components']['human'].items()if k not in('rig','boneMapping','clips')}}}
 return {'entity':copy.deepcopy(stored),'prefix':prefix,'rootName':root.name[len(prefix):],'controller':{},'human':cfg,'humanRoot':np.asarray(p).copy(),'humanRootQ':np.asarray(q).copy(),'humanJoints':{name:body.name for name,body in bodies.items()},'humanSegments':segments},root

def bind(model,data,info):
 if 'human'not in info:return
 if info['human']['mode']=='kinematic':
  info['humanJointSiteIds']={name:model.site(full).id for name,full in info['humanJoints'].items()}
  # 这些site每tick更新局部姿态；编译时的sameframe快捷标志必须关闭，否则引擎会忽略后续旋转。
  for sid in info['humanJointSiteIds'].values():model.site_sameframe[sid]=0
  info['humanSiteOrder']=list(info['humanJointSiteIds']);info['humanSiteIndices']=np.asarray(list(info['humanJointSiteIds'].values()),dtype=np.int32)
 else:info['humanJointIds']={name:model.body(full).id for name,full in info['humanJoints'].items()}
 for seg in info['humanSegments']:
  seg['geomId']=model.geom(seg['geomName']).id
  if 'bodyName'in seg:seg['mocap']=int(model.body_mocapid[model.body(seg['bodyName']).id])
 if info['human']['mode']=='kinematic':
  info['humanRootMocap']=int(model.body_mocapid[info['body']])
 joint_ids=info['humanJointSiteIds']if info['human']['mode']=='kinematic'else info['humanJointIds']
 # 只缓存本model/data的原生数组视图和编译索引；每次observe仍按当前步读取，sync重建info时重绑。
 info['humanObserve']={'segmentIds':np.asarray([s['geomId']for s in info['humanSegments']],dtype=np.int32),'segmentNames':[s['name']for s in info['humanSegments']],'jointNames':list(joint_ids),'jointIds':np.asarray(list(joint_ids.values()),dtype=np.int32),'geomPos':data.geom_xpos,'geomMat':data.geom_xmat,'geomSize':model.geom_size,'jointPos':data.site_xpos if info['human']['mode']=='kinematic'else data.xpos,'jointOrientation':data.site_xmat if info['human']['mode']=='kinematic'else data.xquat}

def prepare(world,info,m,error):
 if 'human'not in info:raise error('HUMAN_COMPONENT_REQUIRED','目标不是已编译人体')
 duration=m.get('durationS')
 if isinstance(duration,bool)or not isinstance(duration,(int,float))or not math.isfinite(duration)or not 0<duration<=300:raise error('HUMAN_DURATION_INVALID','动作时长须为0-300秒')
 m['_duration']=m['_end']=duration;m['_origin']=info['humanRoot'].copy();m['_rootQ']=info['humanRootQ'].copy();m['_distance']=0.;m['_lastElapsed']=0.;m['_yielded']=False;m['_travelledM']=0.;m['_yaw']=float(2*math.atan2(m['_rootQ'][3],m['_rootQ'][0]));m['_blockedS']=0.
 if info['human']['mode']=='ragdoll':
  if m.get('route'):raise error('HUMAN_DYNAMIC_CONTROLLER_UNAVAILABLE','ragdoll无步态/恢复控制器，不能运动学路径回放')
  m['_force']=finite_vector(m.get('forceN',[0,0,0]),3,error,'forceN')
  if np.linalg.norm(m['_force'])>2000:raise error('OUT_OF_RANGE','人体外力须不超过2000N')
  return
 if m.get('forceN')is not None:raise error('HUMAN_KINEMATIC_FORCE_UNSUPPORTED','运动学人体不响应外力；需要ragdoll模式')
 route=m.get('route')or info['human'].get('route')or{'pointsM':[],'speedMps':0,'behavior':'stand'};m['_route']=copy.deepcopy(route)
 speed=route.get('speedMps');behavior=route.get('behavior');points=route.get('pointsM',[])
 if isinstance(speed,bool)or not isinstance(speed,(int,float))or not math.isfinite(speed)or not 0<=speed<=6 or behavior not in('stand','walk','run'):raise error('HUMAN_ROUTE_INVALID','速度/行为不合法')
 m['_points']=[m['_origin']]+[finite_vector(x,3,error,'pointsM')for x in points]
 if len(points)>256:raise error('HUMAN_ROUTE_LIMIT','路径最多256点')
 for key in('dwellS','avoidanceRadiusM','turnRateRadps'):
  v=route.get(key,0)
  if isinstance(v,bool)or not isinstance(v,(int,float))or not math.isfinite(v)or not 0<=v<=30:raise error('HUMAN_ROUTE_INVALID',key+'不合法')
 if route.get('clip')and not any(c['name']==route['clip']for c in info['human'].get('clips',[])):raise error('HUMAN_CLIP_MISSING','原件缺少动作: '+route['clip'])
 if route.get('clip')and info['human']['source']['kind']=='rigged-glb':
  m['_clipPausedS']=0.;m['_lastClipPose']=pose(info['human'],m['_origin'],m['_rootQ'],0,behavior,speed,route['clip']);m['_lastClipRoot']=m['_origin'].copy();m['_lastClipQ']=m['_rootQ'].copy();m['_clipPoseCommitted']=False
 if route.get('loop') and len(m['_points'])>1 and np.linalg.norm(m['_points'][-1]-m['_origin'])>1e-9:m['_points'].append(m['_origin'].copy())
 m['_navTargets']=[p.copy()for p in m['_points'][1:]];m['_navPending']=[p.copy()for p in m['_navTargets']];m['_navLastReplan']=-.5;m['_navError']=error;m['_navReplans']=0
 if 'navigation'in route:
  navigation.config(route['navigation'],error)
  try:m['_points'],m['_navigation']=navigation.plan(world,m['entityId'],m['_origin'],m['_navPending'],route['navigation'],info['human']['heightM'],error)
  except error as exc:
   if exc.code!='HUMAN_NAV_NO_PATH':raise
   m['_points']=[m['_origin'].copy()];m['_navigation']={'status':'blocked','reason':str(exc),'source':'mujoco-compiled-aabb'}
 m['_lengths']=[float(np.linalg.norm(b-a))for a,b in zip(m['_points'],m['_points'][1:])]

def advance(world,info,m,elapsed,defer_pose=False,obstacle_candidate=None):
 cfg=info['human']
 # 混合batch由最长成员持有时钟；短人体窗口结束后不再采样/写目标，ragdoll外力立即撤销。
 # 运动学身体保留最后一次原生目标；另一个成员继续物理推进不延长本人物时长。
 if elapsed>m['_duration']+1e-12:
  if cfg['mode']=='ragdoll':world.data.xfrc_applied[info['body']]=0
  if info.get('humanMotion'):info['humanMotion']={**info['humanMotion'],'behavior':'stopped'}
  return
 if cfg['mode']=='ragdoll':world.data.xfrc_applied[info['body'],:3]=m['_force'];return
 route=m['_route'];root=m['_origin'].copy();quat=m['_rootQ'].copy();dt=max(0,elapsed-m['_lastElapsed']);m['_lastElapsed']=elapsed;yielded=False
 if route.get('yieldToHumans'):
  radius=route.get('avoidanceRadiusM',.6)
  for eid,other in world.entities.items():
   if 'human'in other and eid<m['entityId'] and np.linalg.norm((world.human_root_position(info)if hasattr(world,'human_root_position')else world.data.xpos[info['body']])[:2]-(world.human_root_position(other)if hasattr(world,'human_root_position')else world.data.xpos[other['body']])[:2])<radius:yielded=True;break
 m['_yielded']=yielded
 if route.get('navigation')and m.get('_navPending')and (yielded or m.get('_navigation',{}).get('status')=='blocked' or m.get('_blockedS',0)>0)and elapsed-m['_navLastReplan']>=.5:
  m['_navLastReplan']=elapsed;m['_navReplans']+=1
  try:
   goals=[p.copy()for p in m['_navPending']]
   if route.get('loop')and np.linalg.norm(goals[-1]-info['humanRoot'])>1e-9:goals.append(info['humanRoot'].copy())
   points,receipt=navigation.plan(world,m['entityId'],info['humanRoot'],goals,route['navigation'],cfg['heightM'],m['_navError'])
   if route.get('loop'):m['_navTargets']=[p.copy()for p in goals];m['_navPending']=[p.copy()for p in goals]
   m['_points']=points;m['_origin']=info['humanRoot'].copy();m['_distance']=0.;m['_lengths']=[float(np.linalg.norm(b-a))for a,b in zip(points,points[1:])];m['_navigation']={**receipt,'replans':m['_navReplans']};m['_blockedS']=0.;yielded=False;m['_yielded']=False
  except m['_navError'] as exc:
   if exc.code!='HUMAN_NAV_NO_PATH':raise
   m['_navigation']={'status':'blocked','reason':str(exc),'source':'mujoco-compiled-aabb','replans':m['_navReplans']}
 if not yielded and route['behavior']!='stand':m['_distance']+=dt*route['speedMps']
 distance=m['_distance'];total=sum(m['_lengths']);dwell=route.get('dwellS',0)
 if total>0:
  cycle=total+route['speedMps']*dwell;offset=distance%cycle if route.get('loop')and cycle else min(distance,total)
  if offset>=total:offset=total
  for i,length in enumerate(m['_lengths']):
   if offset>length and i<len(m['_lengths'])-1:offset-=length;continue
   a,b=m['_points'][i:i+2];root=a+(b-a)*min(1,offset/length)if length else b.copy();direction=b-a
   if math.hypot(float(direction[0]),float(direction[1]))>1e-9:
    target_yaw=math.atan2(direction[1],direction[0]);difference=(target_yaw-m['_yaw']+math.pi)%(2*math.pi)-math.pi;limit=route.get('turnRateRadps',2.5)*dt;m['_yaw']+=max(-limit,min(limit,difference));quat=np.array([math.cos(m['_yaw']/2),0,0,math.sin(m['_yaw']/2)])
   break
 stopped=yielded or total==0 or not route.get('loop')and distance>=total or route.get('loop')and total>0 and distance%(total+route['speedMps']*dwell)>=total
 root,stopped,blocked=constrain_root(world,info,m,root,stopped,dt,obstacle_candidate)
 behavior='stand'if stopped else route['behavior']
 state=(root,quat,behavior,stopped,blocked,dt)
 if defer_pose:return state
 return complete_pose(world,info,m,elapsed,state)

def remember_clip_pose(m,root,quat,sampled):
 if '_lastClipPose'in m:
  m['_lastClipPose']=sampled;m['_lastClipRoot']=root.copy();m['_lastClipQ']=quat.copy();m['_clipPoseCommitted']=True

def complete_pose(world,info,m,elapsed,state):
 # 标量和批量只各推进一次路径；停止/阻挡/终点共用这个既有后半段出口。
 cfg=info['human'];route=m['_route'];yielded=m.get('_yielded',False);root,quat,behavior,stopped,blocked,dt=state
 hold_clip=stopped and route['behavior']in('walk','run')and '_lastClipPose'in m
 if hold_clip:
  # 阻挡/互让/终点保持最后有效clip骨姿，不回绑定，不继续空走；只有同World dt派生的相位补偿。
  m['_clipPausedS']+=dt
  if blocked or yielded or m.get('_navigation',{}).get('status')=='blocked':
   root=info['humanRoot'].copy();quat=info['humanRootQ'].copy();m['_yaw']=float(2*math.atan2(quat[3],quat[0]))
  old_root,old_q=m['_lastClipRoot'],m['_lastClipQ']
  if m['_clipPoseCommitted']and np.array_equal(root,old_root):quat=old_q.copy();m['_yaw']=float(2*math.atan2(quat[3],quat[0]))
  if m['_clipPoseCommitted']and np.array_equal(root,old_root)and np.array_equal(quat,old_q):
   record_motion(info,m,root,quat,behavior,blocked,dt);return
  delta=mul(quat,np.array([old_q[0],-old_q[1],-old_q[2],-old_q[3]]));sampled={name:(root+rotate(delta,p-old_root),mul(delta,q))for name,(p,q)in m['_lastClipPose'].items()}
 else:sampled=sample_pose(world,cfg,root,quat,elapsed-m.get('_clipPausedS',0.),behavior,0 if stopped else route['speedMps'],route.get('clip')if not stopped else None)
 remember_clip_pose(m,root,quat,sampled)
 if hasattr(world,'commit_human_pose'):world.commit_human_pose(info,root,quat,sampled)
 else:
  write_mujoco_pose(world,info,root,quat,sampled)
 record_motion(info,m,root,quat,behavior,blocked,dt)

def constrain_root(world,info,m,root,stopped,dt,obstacle_candidate=None):
 cfg=info['human'];route=m['_route']
 # 障碍约束直接查询原生碰撞几何；每步沿运动方向扫多个身体高度/侧边射线。
 # 这是保守停止（无自动绕行），同一有界动作可停止/结束，不能写成ORCA全导航。
 blocked=None
 previous=info['humanRoot'];delta=root-previous;travel=math.hypot(float(delta[0]),float(delta[1]))
 if route.get('avoidObstacles',True) and travel>1e-12 and (hasattr(world,'human_obstacle_distance')or(obstacle_candidates(world,previous,root,cfg['heightM'])if obstacle_candidate is None else obstacle_candidate)):
  direction=np.array([delta[0]/travel,delta[1]/travel,0.]);side=np.array([-direction[1],direction[0],0.]);groups=np.ones(6,dtype=np.uint8)
  for height in(.22,.8,1.35):
   for lateral in(-.2,0,.2):
    origin=previous+np.array([0,0,height*cfg['heightM']/1.75])+side*lateral;hit=np.array([-1],dtype=np.int32)
    distance,hit_id=world.human_obstacle_distance(origin,direction,travel+.65)if hasattr(world,'human_obstacle_distance')else obstacle_distance(world,origin,direction,travel+.65)
    if 0<=distance<=travel+.65:
     blocked=hit_id if isinstance(hit_id,str)else world.model.geom(hit_id).name if hit_id>=0 else 'HUMAN_RAY_LIMIT';break
   if blocked:break
 if blocked:
  root=previous.copy();m['_distance']=max(0,m['_distance']-dt*route['speedMps']);m['_blockedS']+=dt;stopped=True
 return root,stopped,blocked

def write_mujoco_pose(world,info,root,quat,sampled):
 data=world.data;data.mocap_pos[info['humanRootMocap']]=root;data.mocap_quat[info['humanRootMocap']]=quat
 inverse=np.array([quat[0],-quat[1],-quat[2],-quat[3]]);matrix=np.empty(9);mj.mju_quat2Mat(matrix,quat)
 positions=np.asarray([sampled[name][0]for name in info['humanSiteOrder']]);rotations=np.asarray([sampled[name][1]for name in info['humanSiteOrder']])
 world.model.site_pos[info['humanSiteIndices']]=(positions-root)@matrix.reshape(3,3)
 world.model.site_quat[info['humanSiteIndices']]=multiply_rows(inverse,rotations)
 for seg in info['humanSegments']:
  pa,pb=segment_points(sampled,seg);data.mocap_pos[seg['mocap']]=(pa+pb)/2;q=np.zeros(4);mj.mju_quatZ2Vec(q,pb-pa);data.mocap_quat[seg['mocap']]=q

def record_motion(info,m,root,quat,behavior,blocked,dt):
 route=m['_route'];yielded=m.get('_yielded',False)
 if route.get('navigation'):
  if blocked:m['_navigation']={**m.get('_navigation',{}),'status':'blocked','reason':'NATIVE_OBSTACLE:'+blocked}
  while m['_navPending']and np.linalg.norm(root-m['_navPending'][0])<max(.08,route['speedMps']*dt*1.1):m['_navPending'].pop(0)
  if not m['_navPending']and route.get('loop'):m['_navPending']=[p.copy()for p in m['_navTargets']]
 offset=root-info['humanRoot'];m['_travelledM']+=math.sqrt(float(offset[0]*offset[0]+offset[1]*offset[1]+offset[2]*offset[2]))
 info['humanRoot']=root;info['humanRootQ']=quat;info['humanMotion']={'behavior':behavior,'clip':route.get('clip'),'distanceM':m['_travelledM'],'yielded':yielded,'blockedByGeom':blocked,'blockedS':m['_blockedS'],**({'navigation':copy.deepcopy(m['_navigation'])}if '_navigation'in m else{})}
 info['humanTarget']={'rootPositionM':root.tolist(),'rootYawRad':float(2*math.atan2(quat[3],quat[0]))}

def observe(world,info):
 if 'human'not in info:return None
 data=world.data;views=info['humanObserve'];gids,jids=views['segmentIds'],views['jointIds'];positions=views['geomPos'][gids].tolist();sizes=views['geomSize'][gids,:2].tolist();orientations=observed_quaternions(views['geomMat'][gids]);segments=[{'name':name,'positionM':position,'quaternionXyzw':q,'radiusM':size[0],'halfLengthM':size[1]}for name,position,q,size in zip(views['segmentNames'],positions,orientations,sizes)]
 positions=views['jointPos'][jids].tolist();orientations=observed_quaternions(views['jointOrientation'][jids])if info['human']['mode']=='kinematic'else views['jointOrientation'][jids][:,[1,2,3,0]].tolist();joints=[{'name':name,'positionM':position,'quaternionXyzw':q}for name,position,q in zip(views['jointNames'],positions,orientations)]
 return observation(world,info,joints,segments)

def observation(world,info,joints,segments):
 return {'source':'mujoco-site'if info['human']['mode']=='kinematic'else'mujoco-body','mode':info['human']['mode'],'simTime':float(world.data.time),'stepIndex':world.step_index,'joints':joints,'segments':segments,**({'target':copy.deepcopy(info['humanTarget'])}if 'humanTarget'in info else{}),**({'motion':copy.deepcopy(info['humanMotion'])}if 'humanMotion'in info else{})}

def observed_quaternions(matrices):
 result=np.empty((len(matrices),4))
 for n,matrix in enumerate(matrices):mj.mju_mat2Quat(result[n],matrix)
 return result[:,[1,2,3,0]].tolist()

def observed_quaternions_batch(matrices):
 # dict路径保持原返回list；数值与ndarray变体同源同式。
 return observed_quaternions_ndarray(matrices).tolist()

def observed_quaternions_ndarray(matrices):
 # 小数组仍走Mju；大数组保留mat2Quat的trace优先、严格对角分支、符号与最后归一化。
 if len(matrices)<256:return np.asarray(observed_quaternions(matrices),dtype=float)
 m=np.asarray(matrices).reshape(-1,9);trace=m[:,0]+m[:,4]+m[:,8];components=np.stack((1+trace,1+2*m[:,0]-trace,1+2*m[:,4]-trace,1+2*m[:,8]-trace),axis=1);branch=np.where(trace>0,0,np.where((m[:,0]>m[:,4])&(m[:,0]>m[:,8]),1,np.where(m[:,4]>m[:,8],2,3)))
 # 对全部行一次算完四个分支（逐元素运算与原式完全相同，未选中分支在sqrt(负数)/除零
 # 处产生的nan/inf只是被下面按行选择的索引丢弃，不参与所选行结果），保持逐位相同。
 with np.errstate(invalid='ignore',divide='ignore'):
  v=np.sqrt(components);s=.5/v;a=m
  candidates=np.stack((
   np.stack((.5*v[:,0],(a[:,7]-a[:,5])*s[:,0],(a[:,2]-a[:,6])*s[:,0],(a[:,3]-a[:,1])*s[:,0]),axis=1),
   np.stack(((a[:,7]-a[:,5])*s[:,1],.5*v[:,1],(a[:,1]+a[:,3])*s[:,1],(a[:,2]+a[:,6])*s[:,1]),axis=1),
   np.stack(((a[:,2]-a[:,6])*s[:,2],(a[:,1]+a[:,3])*s[:,2],.5*v[:,2],(a[:,5]+a[:,7])*s[:,2]),axis=1),
   np.stack(((a[:,3]-a[:,1])*s[:,3],(a[:,2]+a[:,6])*s[:,3],(a[:,5]+a[:,7])*s[:,3],.5*v[:,3]),axis=1)),axis=1)
 q=candidates[np.arange(len(m)),branch]
 q/=np.linalg.norm(q,axis=1)[:,None]
 return q[:,[1,2,3,0]]

def _observe_layout(world,infos):
 """只缓存本model和成员的编译索引；即使同一step再次读也重读当前native数组。"""
 identity=(id(world.model),tuple(id(i)for i in infos));layout=getattr(world,'_human_observe_layout',None)
 if layout is None or layout['identity']!=identity:
  rows=[];segments=[];kinematic=[];dynamic=[]
  for info in infos:
   view=info['humanObserve'];joint_ids=kinematic if info['human']['mode']=='kinematic'else dynamic;gs=len(segments);js=len(joint_ids);segments.extend(view['segmentIds']);joint_ids.extend(view['jointIds']);rows.append((info,slice(gs,len(segments)),slice(js,len(joint_ids))))
  layout={'identity':identity,'rows':rows,'segments':np.asarray(segments,dtype=np.int32),'kinematic':np.asarray(kinematic,dtype=np.int32),'dynamic':np.asarray(dynamic,dtype=np.int32),'templates':{}};world._human_observe_layout=layout
 return layout

def _observe_arrays(world,infos):
 """批路径同源读数：只缓存本model和成员的编译索引；即使同一step再次读也重读当前native数组。"""
 layout=_observe_layout(world,infos)
 data=world.data;gids=layout['segments'];kin=layout['kinematic'];dyn=layout['dynamic']
 return layout,(data.geom_xpos[gids].tolist(),world.model.geom_size[gids,:2].tolist(),observed_quaternions_batch(data.geom_xmat[gids]),data.site_xpos[kin].tolist(),observed_quaternions_batch(data.site_xmat[kin]),data.xpos[dyn].tolist(),data.xquat[dyn][:,[1,2,3,0]].tolist())

def _observe_arrays_nd(world,infos):
 """文本路径同源读数的ndarray变体：共享同一layout缓存，数值与_observe_arrays逐位相同。"""
 layout=_observe_layout(world,infos)
 data=world.data;gids=layout['segments'];kin=layout['kinematic'];dyn=layout['dynamic']
 return layout,(data.geom_xpos[gids],world.model.geom_size[gids,:2],observed_quaternions_ndarray(data.geom_xmat[gids]),data.site_xpos[kin],observed_quaternions_ndarray(data.site_xmat[kin]),data.xpos[dyn],data.xquat[dyn][:,[1,2,3,0]])

def _observe_total(infos):
 return sum(len(i['humanSegments'])+(len(i['humanObserve']['jointIds'])if i['human']['mode']=='kinematic'else 0)for i in infos)

def observe_many(world,infos):
 if _observe_total(infos)<256:return{id(i):observe(world,i)for i in infos}
 layout,(gp,gs,gq,kp,kq,dp,dq)=_observe_arrays(world,infos);result={}
 for info,g,j in layout['rows']:
  view=info['humanObserve'];segments=[{'name':name,'positionM':p,'quaternionXyzw':q,'radiusM':s[0],'halfLengthM':s[1]}for name,p,q,s in zip(view['segmentNames'],gp[g],gq[g],gs[g])];jp,jq=(kp,kq)if info['human']['mode']=='kinematic'else(dp,dq);joints=[{'name':name,'positionM':p,'quaternionXyzw':q}for name,p,q in zip(view['jointNames'],jp[j],jq[j])];result[id(info)]=observation(world,info,joints,segments)
 return result

def _escaped(text):
 """模板里内嵌的json字面量必须先把%转义成%%，否则str%格式化会误读。"""
 return text.replace('%','%%')

def _pose_template(info):
 """与observation()的dict完全同键序的文本模板；数值槽位只接受tolist()的Python float（%r口径与json.dumps一致）。"""
 view=info['humanObserve']
 joints='['+','.join('{"name":'+_escaped(json.dumps(name))+',"positionM":[%r,%r,%r],"quaternionXyzw":[%r,%r,%r,%r]}'for name in view['jointNames'])+']'
 segments='['+','.join('{"name":'+_escaped(json.dumps(name))+',"positionM":[%r,%r,%r],"quaternionXyzw":[%r,%r,%r,%r],"radiusM":%r,"halfLengthM":%r}'for name in view['segmentNames'])+']'
 head='{"source":'+_escaped(json.dumps('mujoco-site'if info['human']['mode']=='kinematic'else'mujoco-body'))+',"mode":'+_escaped(json.dumps(info['human']['mode']))+',"simTime":%r,"stepIndex":%d,"joints":'
 tail=''
 if 'humanTarget'in info:tail+=',"target":%s'
 if 'humanMotion'in info:tail+=',"motion":%s'
 return head+joints+',"segments":'+segments+tail+'}'

def observe_many_text(world,infos):
 """与observe_many逐字节等价（各自json.dumps后）的humanPose JSON文本；数值来源完全同源。"""
 if _observe_total(infos)<256:return{id(i):json.dumps(observe(world,i),allow_nan=False,separators=(',',':'))for i in infos}
 layout,(gp,gs,gq,kp,kq,dp,dq)=_observe_arrays_nd(world,infos);templates=layout['templates']
 # 全部人体数值拼成单一float64数组（按每行块布局）：关节[p3,q4]/段[p3,q4,s2]逐元交错，与模板槽位同序。
 blocks=[]
 for info,g,j in layout['rows']:
  jp,jq=(kp,kq)if info['human']['mode']=='kinematic'else(dp,dq)
  blocks.append(np.concatenate((np.concatenate((jp[j],jq[j]),axis=1).ravel(),np.concatenate((gp[g],gq[g],gs[g]),axis=1).ravel())))
 flat=np.concatenate(blocks)
 # 任一数值非有限时整帧退回原dict路径，json.dumps(allow_nan=False)抛同一错误。
 if not np.isfinite(flat).all():return{id(i):json.dumps(observe(world,i),allow_nan=False,separators=(',',':'))for i in infos}
 flat=flat.tolist();result={};off=0
 for (info,g,j),block in zip(layout['rows'],blocks):
  n=len(block);values=flat[off:off+n];off+=n
  key=(id(info),'humanTarget'in info,'humanMotion'in info);template=templates.get(key)
  if template is None:template=templates[key]=_pose_template(info)
  if 'humanTarget'in info:values.append(json.dumps(info['humanTarget'],allow_nan=False,separators=(',',':')))
  if 'humanMotion'in info:values.append(json.dumps(info['humanMotion'],allow_nan=False,separators=(',',':')))
  result[id(info)]=template%(float(world.data.time),int(world.step_index),*values)
 return result

def stop(world,info):
 if 'human'not in info:return
 world.data.xfrc_applied[info['body']]=0
 # 运动学停止保留最后一个真实物理姿态；不回跳初始Scene、不继续墙钟采样。
 if 'humanMotion'in info:info['humanMotion']={**info['humanMotion'],'behavior':'stopped'}


def hydrate(scene,error):
 """Scene保存单份带资源身份的rig/clip投影；编译时共享不可变定义，不逐帧写回Scene。"""
 result=copy.deepcopy(scene);by_id={e['entityId']:e for e in result['entities']}
 for e in result['entities']:
  cfg=e.get('components',{}).get('human')
  if not cfg or not cfg.get('definition'):continue
  ref=cfg['definition'];asset=by_id.get(ref.get('entityId'));definition=(asset or{}).get('components',{}).get('humanDefinition')
  if not definition or not any(r.get('resourceId')==ref.get('resourceId')and r.get('version')==ref.get('version')for r in asset.get('resources',[]))or not any(r.get('resourceId')==ref.get('resourceId')and r.get('version')==ref.get('version')for r in e.get('resources',[])):raise error('HUMAN_DEFINITION_MISSING','人体共享rig/clip资源身份不一致: '+e['entityId'])
  e['components']['human']={**definition,**cfg}
 return result


def entity_transform(world,info):
 root=next(j for j in info['human']['rig']if not j.get('parent'));rest=wxyz(root['quaternionXyzw']);inverse=np.array([rest[0],-rest[1],-rest[2],-rest[3]]);q=mul(world.data.xquat[info['body']],inverse);position=world.data.xpos[info['body']]-rotate(q,root['offsetM'])
 return {'position':position.tolist(),'quaternion':xyzw(q),'scale':[1,1,1]}


def obstacle_distance(world,origin,direction,limit):
 # 人体geom使用默认可见group0。射线逐交点跳过人体自身/同类，不借隐藏显示组改变RGB-D。
 key=id(world.model)
 if getattr(world,'_human_ray_model',None)!=key:
  world._human_ray_model=key;world._human_ray_geoms={seg['geomId']for info in world.entities.values()if info.get('human')for seg in info['humanSegments']}
 total=0.;current=origin.copy();groups=np.ones(6,dtype=np.uint8);hit=np.array([-1],dtype=np.int32)
 for _ in range(64):
  distance=mj.mj_ray(world.model,world.data,current,direction,groups,1,-1,hit)
  if distance<0:return -1.,-1
  total+=distance
  if total>limit or int(hit[0])not in world._human_ray_geoms:return total,int(hit[0])
  epsilon=1e-5;current=current+direction*(distance+epsilon);total+=epsilon
 # 同一有界射线遇到过多人体表面时保守停止，不假报通行。
 return min(total,limit),-1


def sample_table(world,cfg,behavior,speed):
 model_key=id(world.model if hasattr(world,'model')else world.stage)
 if getattr(world,'_human_sample_model',None)!=model_key:world._human_sample_model=model_key;world._human_sample_cache={}
 identity=cfg.get('_samplingIdentity') or str([(j['name'],j['offsetM'],j['quaternionXyzw'])for j in cfg['rig']]);key=(identity,behavior,round(speed,6));cache=world._human_sample_cache
 if key not in cache:
  if len(cache)>=16:return None
  clean={**cfg,'phase':0};frequency=2.8 if behavior=='run'else 1.7;names=[j['name']for j in cfg['rig']];positions=[];rotations=[]
  for i in range(128):
   sampled=pose(clean,np.zeros(3),np.array([1.,0.,0.,0.]),i/(128*frequency),behavior,speed);positions.append([sampled[n][0]for n in names]);rotations.append([sampled[n][1]for n in names])
  cache[key]=(names,np.asarray(positions),np.asarray(rotations),frequency)
 return cache[key]

def sample_pose(world,cfg,root,q,elapsed,behavior,speed,clip_name=None):
 # 根路径仍逐物理步推进；外部动作保留原始track精确采样。
 if clip_name and getattr(world,'human_compute_device','cpu')!='cpu':
  p,quaternions=world.sample_human_clip(cfg,np.asarray([root]),np.asarray([q]),np.asarray([elapsed]),np.asarray([cfg.get('phase',0)]),clip_name)
  return{name:(p[0,i],quaternions[0,i])for i,name in enumerate(cfg['_poseRuntime']['names'])}
 if cfg['source']['kind']!='procedural' or clip_name:return pose(cfg,root,q,elapsed,behavior,speed,clip_name)
 table=sample_table(world,cfg,behavior,speed)
 if table is None:return pose(cfg,root,q,elapsed,behavior,speed,clip_name)
 names,positions,rotations,frequency=table;phase=((cfg.get('phase',0)+elapsed*frequency)%1)*128;index=int(phase);weight=phase-index;local_p=positions[index]*(1-weight)+positions[(index+1)%128]*weight;local_q=rotations[index]*(1-weight)+rotations[(index+1)%128]*weight;local_q/=np.linalg.norm(local_q,axis=1)[:,None]
 matrix=np.empty(9);mj.mju_quat2Mat(matrix,q);world_p=local_p@matrix.reshape(3,3).T+root
 # 广播Hamilton积（wxyz）：一批骨骼一次算，避免每个物理步逐骨创建Python向量。
 world_q=multiply_rows(q,local_q)
 return {name:(world_p[i],world_q[i])for i,name in enumerate(names)}


def multiply_rows(q,rows):
 aw,ax,ay,az=q;bw,bx,by,bz=rows.T
 return np.stack([aw*bw-ax*bx-ay*by-az*bz,aw*bx+ax*bw+ay*bz-az*by,aw*by-ax*bz+ay*bw+az*bx,aw*bz+ax*by-ay*bx+az*bw],axis=1)


def obstacle_bounds(world):
 key=id(world.model)
 if getattr(world,'_human_obstacle_model',None)!=key:
  world._human_obstacle_model=key;human_ids={s['geomId']for info in world.entities.values()if info.get('human')for s in info['humanSegments']};world._human_obstacle_ids=np.asarray([i for i in range(world.model.ngeom)if i not in human_ids and world.model.geom_type[i]!=mj.mjtGeom.mjGEOM_PLANE],dtype=np.int32);world._human_obstacle_planes=np.asarray([i for i in range(world.model.ngeom)if world.model.geom_type[i]==mj.mjtGeom.mjGEOM_PLANE],dtype=np.int32);planes=world._human_obstacle_planes;world._human_obstacle_force=bool(world.model.nflex or len(planes)and np.any(np.abs(world.data.geom_xmat[planes].reshape(-1,3,3)[:,:2,2])>1e-12))
 if world._human_obstacle_force:return None
 ids=world._human_obstacle_ids
 if not len(ids):return np.empty((0,3)),np.empty((0,3))
 # 同一物理步所有候选人物共享一次原生几何世界包围盒投影。
 if getattr(world,'_human_obstacle_step',None)!=world.step_index:
  rotation=world.data.geom_xmat[ids].reshape(-1,3,3);bounds=world.model.geom_aabb[ids];centers=world.data.geom_xpos[ids]+np.einsum('nij,nj->ni',rotation,bounds[:,:3]);half=np.einsum('nij,nj->ni',np.abs(rotation),bounds[:,3:]);world._human_obstacle_bounds=(centers-half,centers+half);world._human_obstacle_step=world.step_index
 return world._human_obstacle_bounds

def obstacle_candidates(world,previous,target,height):
 bounds=obstacle_bounds(world)
 if bounds is None:return True
 low,high=bounds;lo=np.minimum(previous,target)-[.85,.85,0];hi=np.maximum(previous,target)+[.85,.85,0];lo[2]=previous[2]+.22*height/1.75;hi[2]=previous[2]+1.35*height/1.75
 return bool(np.any(np.all(high>=lo,axis=1)&np.all(low<=hi,axis=1)))


def multiply_batch(a,b):
 aw,ax,ay,az=a[...,0],a[...,1],a[...,2],a[...,3];bw,bx,by,bz=b[...,0],b[...,1],b[...,2],b[...,3]
 return np.stack((aw*bw-ax*bx-ay*by-az*bz,aw*bx+ax*bw+ay*bz-az*by,aw*by-ax*bz+ay*bw+az*bx,aw*bz+ax*by-ay*bx+az*bw),axis=-1)
def rotate_batch(q,v):
 w,x,y,z=q[...,0],q[...,1],q[...,2],q[...,3];vx,vy,vz=v[...,0],v[...,1],v[...,2];tx=2*(y*vz-z*vy);ty=2*(z*vx-x*vz);tz=2*(x*vy-y*vx);return np.stack((vx+w*tx+y*tz-z*ty,vy+w*ty+z*tx-x*tz,vz+w*tz+x*ty-y*tx),axis=-1)
def sample_clip_batch(cfg,roots,root_q,elapsed,phases,clip_name):
 runtime=cfg['_poseRuntime'];prepared=runtime['clips'][clip_name];clip=prepared['source'];count=len(roots);bones=len(runtime['names']);rotations=np.broadcast_to(runtime['rotations'],(count,bones,4)).copy();translations=np.broadcast_to(runtime['offsets'],(count,bones,3)).copy();time=(elapsed+phases*clip['durationS'])%clip['durationS']
 for group in prepared['groups']:
  times=group['times'];i=np.clip(np.searchsorted(times,time,side='right')-1,0,len(times)-1);j=np.minimum(i+1,len(times)-1);denominator=times[j]-times[i];u=np.divide(time-times[i],denominator,out=np.zeros_like(time),where=denominator>0);u=np.clip(u,0,1)
  if group['interpolation']=='STEP':u[:]=0
  values=group['values'];a=values[:,i,:].transpose(1,0,2);b=values[:,j,:].transpose(1,0,2)
  if group['kind']=='translation':translations[:,group['indices']]=(1-u[:,None,None])*a+u[:,None,None]*b;continue
  dot=np.sum(a*b,axis=-1);negative=dot<0;b=np.where(negative[...,None],-b,b);dot=np.where(negative,-dot,dot);linear=dot>.9995;rotation=np.empty_like(a);weight=np.broadcast_to(u[:,None],dot.shape)
  if np.any(linear):
   part=(1-weight[linear,None])*a[linear]+weight[linear,None]*b[linear];rotation[linear]=part/np.linalg.norm(part,axis=-1)[:,None]
  nonlinear=~linear
  if np.any(nonlinear):
   theta=np.arccos(np.clip(dot[nonlinear],-1.,1.));v=weight[nonlinear];rotation[nonlinear]=(np.sin((1-v)*theta)[:,None]*a[nonlinear]+np.sin(v*theta)[:,None]*b[nonlinear])/np.sin(theta)[:,None]
  rotations[:,group['indices']]=rotation
 parents=np.asarray(runtime['parents']);levels=runtime['levels']
 positions=np.empty_like(translations);orientations=np.empty_like(rotations)
 for level,indices in enumerate(levels):
  p=roots[:,None,:]if level==0 else positions[:,parents[indices],:];q=root_q[:,None,:]if level==0 else orientations[:,parents[indices],:];positions[:,indices]=p+rotate_batch(q,translations[:,indices]);orientations[:,indices]=multiply_batch(q,rotations[:,indices])
 mapping=clip.get('rootMotion')
 if mapping:
  if mapping['horizontal']=='remove-drift':offset=np.asarray(mapping['driftM'])[None,:]*(time/clip['durationS'])[:,None]
  else:
   inverse=root_q.copy();inverse[:,1:]*=-1;local=rotate_batch(inverse,positions[:,runtime['names'].index(mapping['joint'])]-roots);offset=local-np.asarray(mapping['baselineM']);offset[:,2]=0
  positions-=rotate_batch(root_q,offset)[:,None,:]
 return positions,orientations
