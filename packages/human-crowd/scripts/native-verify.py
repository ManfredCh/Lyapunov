"""逐物理tick原生回归；调用产品World/动作/观测，不复制运动算法。产物不写源码目录。"""
import argparse,copy,json,sys,time,os,resource
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'sim-mujoco'/'python'))
# packages/human-crowd/scripts -> packages为parents[2]
sys.path[0]=str(Path(__file__).resolve().parents[2]/'sim-mujoco'/'python')
import worker
from worker import World,SimError
worker.emit=lambda _value: None;worker.emit_text=lambda _value: None
parser=argparse.ArgumentParser();parser.add_argument('scene');parser.add_argument('--output',required=True);args=parser.parse_args();base=json.loads(Path(args.scene).read_text());out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
# 使用已生成的合法共享rig/skin Scene，只截取一个共享资源与人物。
asset=next(e for e in base['entities']if e.get('components',{}).get('humanDefinition'));person=next(e for e in base['entities']if e.get('components',{}).get('human'));person['transform']['position']=[0,0,0]
def scene(extra=None,ragdoll=False):
 es=[copy.deepcopy(asset),copy.deepcopy(person)]
 if ragdoll:es[1]['components']['human']['mode']='ragdoll'
 return {'sceneId':'human-native-verify','revision':1,'coordinates':base['coordinates'],'entities':es+(extra or[])}
def world(s,**kwargs):return World(s,{'worldId':'test','clock':'manual','ground':True,'timestepS':.002,**kwargs})
def motion(w,aid='action',**fields):
 w.execute({'kind':'human','entityId':person['entityId'],'actionId':aid,'expectedGeneration':w.generation,'durationS':fields.pop('durationS',1),**fields})
def get(w):return next(e for e in w.observe({'contacts':True})['entities']if e['entityId']==person['entityId'])
def check_native_readback(w,entity):
 import numpy as np
 pose=entity['humanPose'];prefix=entity['entityId']+'/';assert pose['stepIndex']==w.step_index and pose['simTime']==w.data.time;maximum=0.
 for joint in pose['joints']:
  if pose['mode']=='kinematic':
   sid=w.model.site(prefix+'joint/'+joint['name']).id;p=w.data.site_xpos[sid];q=np.empty(4);worker.mj.mju_mat2Quat(q,w.data.site_xmat[sid])
  else:
   bid=w.model.body(prefix+'joint/'+joint['name']).id;p=w.data.xpos[bid];q=w.data.xquat[bid]
  maximum=max(maximum,float(np.max(np.abs(np.asarray(joint['positionM'])-p))),float(np.max(np.abs(np.asarray(joint['quaternionXyzw'])-q[[1,2,3,0]]))))
 for segment in pose['segments']:
  gid=w.model.geom(prefix+'human/'+segment['name']).id;q=np.empty(4);worker.mj.mju_mat2Quat(q,w.data.geom_xmat[gid]);maximum=max(maximum,float(np.max(np.abs(np.asarray(segment['positionM'])-w.data.geom_xpos[gid]))),float(np.max(np.abs(np.asarray(segment['quaternionXyzw'])-q[[1,2,3,0]]))));assert segment['radiusM']==w.model.geom_size[gid,0]and segment['halfLengthM']==w.model.geom_size[gid,1]
 assert maximum<1e-12,maximum
results=[]
def check(name,fn):
 start=time.perf_counter();fn();results.append({'name':name,'status':'passed','wallS':time.perf_counter()-start})
def loop():
 w=world(scene());motion(w,route={'pointsM':[[.2,0,0]],'speedMps':1.,'behavior':'walk','loop':True,'avoidObstacles':False},durationS=1.)
 prev=get(w)['transform']['position'];max_delta=0
 for i in range(500):
  w.tick();now=get(w);delta=sum((a-b)**2 for a,b in zip(now['transform']['position'],prev))**.5;max_delta=max(max_delta,delta);assert delta<=.002001,(i,delta);assert now['humanPose']['simTime']==w.data.time and now['humanPose']['stepIndex']==w.step_index;prev=now['transform']['position']
  if i%100==0:check_native_readback(w,now)
 assert max_delta>.0019;assert w.receipts['action']['status']=='completed'
 results.append({'metric':'loop.maxPerTickDisplacementM','value':max_delta,'dtS':.002})
check('闭合循环每步连续且native姿态与Frame同物理步',loop)
def pause_stop():
 w=world(scene(),startPaused=True);motion(w,route={'pointsM':[[4,0,0]],'speedMps':1.,'behavior':'walk'},durationS=3.)
 before=get(w)
 for _ in range(5):w.tick()
 assert w.step_index==0 and get(w)==before
 w.set_paused(False,w.generation)
 for _ in range(100):w.tick()
 p=get(w)['humanPose'];w.stop({'entityIds':[person['entityId']],'expectedGeneration':w.generation});assert not w.active
 for _ in range(20):w.tick()
 assert get(w)['humanPose']['joints']==p['joints'];assert w.step_index==100;assert w.data.xfrc_applied.sum()==0
 changed=scene();changed['revision']=2;changed['entities'][1]['transform']['position']=[2,0,0];w.sync(changed,force=True)
 assert w.generation==2 and not w.active and w.step_index==0
 try:w.execute({'kind':'human','entityId':person['entityId'],'actionId':'stale','expectedGeneration':1,'durationS':1.})
 except SimError as error:assert error.code=='STALE_GENERATION'
 else:raise AssertionError('旧代次动作未拒绝')
check('暂停/停止保留姿态且重建清控制',pause_stop)
def obstacle():
 wall={'entityId':'wall','name':'wall','transform':{'position':[.7,0,1],'quaternion':[0,0,0,1],'scale':[1,1,1]},'resources':[],'components':{'collision':{'shape':'box','halfExtents':[.1,2,1]}}};w=world(scene([wall]));motion(w,route={'pointsM':[[2,0,0]],'speedMps':2.,'behavior':'run','avoidObstacles':True},durationS=1)
 for _ in range(500):w.tick()
 p=get(w);assert p['transform']['position'][0]<.37,p;assert p['humanPose']['motion']['blockedS']>0;assert w.receipts['action']['status']=='completed';results.append({'metric':'obstacleStopX','value':p['transform']['position'][0]})
check('原生墙几何停障并在有界窗口结束',obstacle)
def default_robot_stop():
 s=scene();s['entities'][1]['transform']['position']=[-1.2,0,0];s['entities'].append({'entityId':'panda','name':'Panda','transform':{'position':[0,0,0],'quaternion':[0,0,0,1],'scale':[1,1,1]},'resources':[],'components':{'mujoco':{'sourcePath':str(ROOT/'materials/robots/franka_panda/franka_emika_panda/panda.xml')}}});w=world(s);motion(w,route={'pointsM':[[1.2,0,0]],'speedMps':.8,'behavior':'walk'},durationS=3.)
 contact_steps=0
 for _ in range(1500):
  w.tick();contacts=w.observe({'contacts':True}).get('contacts',[])
  if any((c['geom1'].startswith(person['entityId']+'/')and c['geom2'].startswith('panda/'))or(c['geom2'].startswith(person['entityId']+'/')and c['geom1'].startswith('panda/'))for c in contacts):contact_steps+=1
 final=get(w);assert contact_steps==0,contact_steps;assert final['humanPose']['motion']['blockedS']>1.;assert not w.active
 results.append({'metric':'defaultPandaContactSteps','value':contact_steps,'stopX':final['transform']['position'][0]})
check('默认停障不将运动学人偶压入Panda，1500原生步零接触',default_robot_stop)
def dynamic():
 w=world(scene(ragdoll=True));before=get(w)['humanPose'];motion(w,forceN=[150,0,0],durationS=.2)
 for _ in range(100):w.tick()
 after=get(w)['humanPose'];assert w.model.nq>7 and w.model.nmocap==0;assert after['joints'][0]['positionM'][0]>.001;assert w.data.xfrc_applied.sum()==0
 motion(w,aid='freefall',forceN=[0,0,0],durationS=1.)
 for _ in range(500):w.tick()
 final=get(w)['humanPose'];check_native_readback(w,get(w));assert final['joints'][0]['positionM'][2]<before['joints'][0]['positionM'][2]-.2;assert final['mode']=='ragdoll';assert abs(get(w)['transform']['position'][0])>.01;assert get(w)['transform']['position']!=person['transform']['position'];results.append({'metric':'ragdollPelvisHeightM','before':before['joints'][0]['positionM'][2],'after':final['joints'][0]['positionM'][2]})
check('自由根球关节原生受力/跌倒且外力在窗口后归零',dynamic)
def multi_instance():
 s=scene();second=copy.deepcopy(person);second['entityId']='another_person';second['transform']['position']=[0,2,0];second['components']['human']['phase']=.7;s['entities'].append(second);w=world(s)
 w.execute({'kind':'batch','actionId':'batch','expectedGeneration':w.generation,'motions':[{'kind':'human','entityId':e['entityId'],'durationS':1.,'route':{'pointsM':[[2,e['transform']['position'][1],0]],'speedMps':1.,'behavior':'walk','avoidObstacles':False}}for e in [person,second]]})
 for _ in range(100):w.tick()
 w.stop({'expectedGeneration':w.generation,'entityIds':[person['entityId']]});held=get(w)['humanPose']['joints']
 for _ in range(400):w.tick()
 assert get(w)['humanPose']['joints']==held
 frame=w.observe();other=next(e for e in frame['entities']if e['entityId']=='another_person');assert abs(other['transform']['position'][0]-1)<1e-6
 assert w.receipts['batch']['status']=='cancelled' and not w.active
 # 两个world同名人物独立：另一个世界没有本世界的动作进度。
 w2=world(s);assert get(w2)['transform']['position'][0]==0
check('同tick批量/单人停止不影响同组他人与多世界隔离',multi_instance)
def visible_rgbd():
 import numpy as np
 camera={'entityId':'camera','name':'camera','transform':{'position':[0,-3.5,1.1],'quaternion':[2**-.5,0,0,2**-.5],'scale':[1,1,1]},'resources':[],'components':{'camera':{'name':'human-rgbd','fovYDeg':55,'width':320,'height':240}}};w=world(scene([camera]));captured=w.capture({'outputDir':str(out/'rgbd'),'cameraName':'camera/human-rgbd','width':320,'height':240});assert captured['renderOption']['geomGroups']==[0,1,2];assert captured['renderOption']['explicitGeomGroups']is False
 import struct,zlib
 png=next((out/'rgbd').glob('*.png')).read_bytes();chunks=[];offset=8
 while offset<len(png):
  size=struct.unpack('>I',png[offset:offset+4])[0];kind=png[offset+4:offset+8];data=png[offset+8:offset+8+size];offset+=size+12
  if kind==b'IHDR':width,height=struct.unpack('>II',data[:8])
  if kind==b'IDAT':chunks.append(data)
 raw=np.frombuffer(zlib.decompress(b''.join(chunks)),dtype=np.uint8).reshape(height,width*3+1);assert np.all(raw[:,0]==0);rgb=raw[:,1:].reshape(height,width,3).astype(float);blue=(rgb[:,:,2]>rgb[:,:,0]*1.5)&(rgb[:,:,2]>rgb[:,:,1]*1.1)&(rgb[:,:,2]>15);pixels=int(blue.sum());assert pixels>300,pixels;depth=np.load(next((out/'rgbd').glob('*.npy')));assert np.isfinite(depth[blue]).all()and float(depth[blue].min())>0;results.append({'metric':'humanVisibleBluePixels','value':pixels,'minHumanDepthM':float(depth[blue].min()),'source':'实际MuJoCo RGB PNG/depth NPY，默认显示组'})
check('默认RGB-D真实看见人体且深度有限为米',visible_rgbd)
def sampling_error():
 import human as h
 import numpy as np
 w=world(scene());cfg=next(i['human']for i in w.entities.values()if i.get('human'));maximum=0.
 for i in range(79):
  elapsed=i*.0137;exact=h.pose(cfg,np.zeros(3),np.array([1.,0,0,0]),elapsed,'walk',1.2);cached=h.sample_pose(w,cfg,np.zeros(3),np.array([1.,0,0,0]),elapsed,'walk',1.2);maximum=max(maximum,max(float(np.linalg.norm(exact[n][0]-cached[n][0]))for n in exact))
 assert maximum<.0005,maximum;results.append({'metric':'proceduralSamplingMaxJointErrorM','value':maximum,'sampling':'128相位线性插值，79个非格点样本；仅原创程序化步态'})
check('共享程序化相位表的位置误差有界，外部clip保持原始采样',sampling_error)
def navigation_detour():
 wall={'entityId':'wall','name':'wall','transform':{'position':[1.5,0,1],'quaternion':[0,0,0,1],'scale':[1,1,1]},'resources':[],'components':{'collision':{'shape':'box','halfExtents':[.1,.4,1]}}};w=world(scene([wall]));motion(w,route={'pointsM':[[3,0,0]],'speedMps':1.,'behavior':'walk','navigation':{'bounds':{'min':[-1,-2],'max':[4,2]},'cellSizeM':.25,'clearanceM':.65}},durationS=7.);maximum_y=0
 for _ in range(3500):
  w.tick();position=get(w)['transform']['position'];maximum_y=max(maximum_y,abs(position[1]));assert abs(position[0]-1.5)>.749999 or abs(position[1])>1.049999,'计划/执行进入墙体膨胀安全区'
 final=get(w);assert abs(final['transform']['position'][0]-3)<.05,final['humanPose'].get('motion');assert maximum_y>1.;assert final['humanPose']['motion']['navigation']['source']=='mujoco-compiled-aabb';results.append({'metric':'navigationDetour','maxAbsY':maximum_y,'finalPositionM':final['transform']['position']})
check('显式平面A*从原生墙几何自动绕行到目标',navigation_detour)
def congestion_release():
 s=scene();blocker=copy.deepcopy(person);blocker['entityId']='a_blocker';blocker['transform']['position']=[1.3,0,0];s['entities'].append(blocker);w=world(s);navigation={'bounds':{'min':[-1,-2],'max':[4,2]},'cellSizeM':.25,'clearanceM':.65}
 motion(w,route={'pointsM':[[3,0,0]],'speedMps':1.,'behavior':'walk','yieldToHumans':True,'navigation':navigation},durationS=8.);maximum_y=0
 for _ in range(4000):w.tick();maximum_y=max(maximum_y,abs(get(w)['transform']['position'][1]))
 final=get(w);assert final['transform']['position'][0]>2.9,final['humanPose'].get('motion');assert maximum_y>.8;assert not w.active;results.append({'metric':'congestionDetourAroundStandingHuman','maxAbsY':maximum_y,'finalPositionM':final['transform']['position']})
check('站立人物阻塞通道时从原生人物位置绕行解除拥堵',congestion_release)
def waiting_replan():
 # 窄平面内先无路；用原生mocap控制把阻塞人物移开，等待者按物理时间重规划并恢复。
 s=scene();blocker=copy.deepcopy(person);blocker['entityId']='a_blocker';blocker['transform']['position']=[1.5,0,0];s['entities'].append(blocker);w=world(s);navigation={'bounds':{'min':[-1,-.8],'max':[4,.8]},'cellSizeM':.2,'clearanceM':.65}
 w.execute({'kind':'batch','actionId':'wait','expectedGeneration':1,'motions':[{'kind':'human','entityId':person['entityId'],'durationS':7.,'route':{'pointsM':[[3,0,0]],'speedMps':1.,'behavior':'walk','yieldToHumans':True,'navigation':navigation}},{'kind':'human','entityId':'a_blocker','durationS':7.,'route':{'pointsM':[[1.5,3,0]],'speedMps':.7,'behavior':'walk','avoidObstacles':False}}]})
 blocked=False
 for _ in range(3500):w.tick();blocked=blocked or get(w)['humanPose'].get('motion',{}).get('navigation',{}).get('status')=='blocked'
 final=get(w);assert blocked;assert final['transform']['position'][0]>2.9,final['humanPose'].get('motion');assert final['humanPose']['motion']['navigation']['replans']>0
 results.append({'metric':'waitingThenReplan','finalPositionM':final['transform']['position'],'replans':final['humanPose']['motion']['navigation']['replans']})
check('暂时无路时有界等待，阻塞人物实际移开后重规划恢复',waiting_replan)
def diagonal_corner():
 def wall(eid,pos,half):return {'entityId':eid,'name':eid,'transform':{'position':pos,'quaternion':[0,0,0,1],'scale':[1,1,1]},'resources':[],'components':{'collision':{'shape':'box','halfExtents':half}}}
 w=world(scene([wall('vertical',[1,.5,1],[.1,.5,1]),wall('horizontal',[.5,1,1],[.5,.1,1])]))
 motion(w,route={'pointsM':[[2,2,0]],'speedMps':1.,'behavior':'walk','navigation':{'bounds':{'min':[0,0],'max':[2.5,2.5]},'cellSizeM':.25,'clearanceM':.65}},durationS=.1)
 for _ in range(50):w.tick()
 final=get(w);assert final['transform']['position']==[0,0,0];assert final['humanPose']['motion']['navigation']['status']=='blocked';assert not w.active
 for aid,target,nav,code in [('budget',[2,2,0],{'bounds':{'min':[-100,-100],'max':[100,100]},'cellSizeM':.1},'HUMAN_NAV_GRID_LIMIT'),('height',[2,2,1],{'bounds':{'min':[0,0],'max':[2.5,2.5]}},'HUMAN_NAV_NONPLANAR')]:
  try:motion(w,aid=aid,route={'pointsM':[target],'speedMps':1.,'behavior':'walk','navigation':nav},durationS=.1)
  except SimError as exc:assert exc.code==code,(exc.code,code)
  else:raise AssertionError(code+'未拒绝')
 assert not w.active
check('对角格点不得斜穿L形障碍角，具名不可行且有界结束',diagonal_corner)
def member_window():
 import numpy as np
 s=scene();other=copy.deepcopy(person);other['entityId']='long-person';other['transform']['position']=[0,2,0];s['entities'].append(other);w=world(s)
 w.execute({'kind':'batch','actionId':'windows','expectedGeneration':1,'motions':[{'kind':'human','entityId':person['entityId'],'durationS':.1,'route':{'pointsM':[[2,0,0]],'speedMps':1.,'behavior':'walk','avoidObstacles':False}},{'kind':'human','entityId':'long-person','durationS':.3,'route':{'pointsM':[[2,2,0]],'speedMps':1.,'behavior':'walk','avoidObstacles':False}}]})
 for _ in range(50):w.tick()
 held=get(w)['humanPose']['joints']
 for _ in range(100):w.tick()
 final=get(w);assert abs(final['transform']['position'][0]-.1)<1e-6;assert final['humanPose']['joints']==held;assert w.receipts['windows']['status']=='completed'
 rag=scene(ragdoll=True);rag['entities'].append(copy.deepcopy(other));wr=world(rag)
 wr.execute({'kind':'batch','actionId':'force-window','expectedGeneration':1,'motions':[{'kind':'human','entityId':person['entityId'],'durationS':.1,'forceN':[150,0,0]},{'kind':'human','entityId':'long-person','durationS':.3,'route':{'pointsM':[[2,2,0]],'speedMps':1.,'behavior':'walk','avoidObstacles':False}}]})
 for _ in range(51):wr.tick()
 assert np.allclose(wr.data.xfrc_applied[wr.entities[person['entityId']]['body']],0)
check('混合batch短人物到窗保持且ragdoll外力归零，不被长成员延长控制',member_window)
def batch_equivalence():
 import numpy as np
 s=scene();s['entities']=s['entities'][:1]
 for i in range(20):
  e=copy.deepcopy(person);e['entityId']='person_'+str(i);e['transform']['position']=[(i%5)*2.,(i//5)*2.,0];e['components']['human']['phase']=(i*.61803398875)%1;e['components']['human']['collision']='coarse'if i%2 else'detailed';s['entities'].append(e)
 s['entities'].append({'entityId':'dynamic-box','name':'dynamic-box','transform':{'position':[.3,0,.9],'quaternion':[0,0,0,1],'scale':[1,1,1]},'resources':[],'components':{'collision':{'shape':'box','halfExtents':[.1,.1,.2]},'rigidBody':{'type':'dynamic','massKg':1,'gravityEnabled':False}}})
 a=world(s);installer=worker.human.install_batch;worker.human.install_batch=lambda *args:({},[])
 try:b=world(s)
 finally:worker.human.install_batch=installer
 assert a.model.nbody==b.model.nbody and a.model.nsite==b.model.nsite and a.model.ngeom==b.model.ngeom
 for field in('body_pos','body_quat','body_mass','geom_size','geom_solref','geom_friction','site_pos','site_quat','eq_data'):
  assert np.allclose(getattr(a.model,field),getattr(b.model,field),atol=1e-12,rtol=0),field
 motions=[{'kind':'human','entityId':e['entityId'],'durationS':.3,'route':{'pointsM':[[e['transform']['position'][0]+2,e['transform']['position'][1]+1,0]],'speedMps':1.,'behavior':'walk','avoidObstacles':False}}for e in s['entities'][1:-1]]
 for w in(a,b):w.execute({'kind':'batch','actionId':'equivalent','expectedGeneration':1,'motions':motions})
 optimized=worker.human_batch.advance;maximum=0.;contact_steps=0;initial_box=a.data.xpos[a.info('dynamic-box')['body']].copy()
 def scalar(w,ms,elapsed):
  for m in ms:worker.human.advance(w,w.info(m['entityId']),m,elapsed)
 for step in range(150):
  a.tick();worker.human_batch.advance=scalar
  try:b.tick()
  finally:worker.human_batch.advance=optimized
  maximum=max(maximum,float(np.max(np.abs(a.data.site_xpos-b.data.site_xpos))),float(np.max(np.abs(a.data.geom_xpos-b.data.geom_xpos))),float(np.max(np.abs(a.data.geom_xmat-b.data.geom_xmat))))
  assert maximum<1e-9,maximum;assert a.step_index==b.step_index;assert np.allclose(a.data.qpos,b.data.qpos,atol=1e-8)
  if a.data.ncon:contact_steps+=1
  if step==70:
   selection={'entityIds':['person_0','person_1'],'expectedGeneration':1};a.stop(selection);b.stop(selection)
 displacement=float(np.linalg.norm(a.data.xpos[a.info('dynamic-box')['body']]-initial_box));assert contact_steps>0 and displacement>.001,(contact_steps,displacement)
 assert a.receipts['equivalent']['status']==b.receipts['equivalent']['status']=='cancelled';assert np.array_equal(a.model.geom_contype,b.model.geom_contype);assert np.array_equal(a.model.geom_conaffinity,b.model.geom_conaffinity);results.append({'metric':'batchVersusScalarMaxNativeError','value':maximum,'actors':20,'steps':150,'timestepS':.002,'contactSteps':contact_steps,'dynamicBoxDisplacementM':displacement,'collision':'混合14段/1段+强制非让行接触动态方块；编译和逐步控制均与标量对照，未改mask'})
check('20人合批与原标量控制逐tick原生姿态/碰撞几何/动态状态一致，支持选择性停止',batch_equivalence)
def crowd_panda():
 s=scene();s['entities']=s['entities'][:1];people=[]
 for i in range(20):
  e=copy.deepcopy(person);e['entityId']='crowd_'+str(i);e['transform']['position']=[-1.2,0,0]if i==0 else[-2+(i%5)*1.5,2+(i//5)*1.5,0];e['components']['human']['phase']=(i*.61803398875)%1;e['components']['human']['collision']='detailed';people.append(e)
 s['entities']+=people+[{'entityId':'panda','name':'Panda','transform':{'position':[0,0,0],'quaternion':[0,0,0,1],'scale':[1,1,1]},'resources':[],'components':{'mujoco':{'sourcePath':str(ROOT/'materials/robots/franka_panda/franka_emika_panda/panda.xml')}}}];w=world(s);motions=[{'kind':'human','entityId':e['entityId'],'durationS':1.,'route':{'pointsM':[[e['transform']['position'][0]+6,e['transform']['position'][1],0]],'speedMps':.8,'behavior':'walk'}}for e in people]+[{'kind':'joint','entityId':'panda','jointNames':['joint1'],'positions':[.2],'durationS':1.,'settleTimeS':0,'tolerance':.1}]
 w.execute({'kind':'batch','actionId':'crowd-panda','expectedGeneration':1,'motions':motions});human_contacts=0
 for _ in range(500):
  w.tick()
  human_contacts+=sum(1 for c in w.data.contact if(w.entity_of_geom(w.model.geom(c.geom1).name)=='panda'and(w.entity_of_geom(w.model.geom(c.geom2).name)or'').startswith('crowd_'))or(w.entity_of_geom(w.model.geom(c.geom2).name)=='panda'and(w.entity_of_geom(w.model.geom(c.geom1).name)or'').startswith('crowd_')))
 frame=w.observe();first=next(e for e in frame['entities']if e['entityId']=='crowd_0');assert human_contacts==0 and first['humanPose']['motion']['blockedS']>.2,(human_contacts,first);assert w.step_index==500 and w.receipts['crowd-panda']['status']=='completed';assert w.data.qpos[w.info('panda')['joints']['joint1']['qpos']]>.05;assert all(e['humanPose']['stepIndex']==frame['stepIndex']for e in frame['entities']if e.get('humanPose'));results.append({'metric':'twentyDetailedPandaMixedBatch','humanRobotContacts':human_contacts,'firstPersonX':first['transform']['position'][0],'actualSteps':w.step_index,'timestepS':.002,'pandaJoint1Rad':float(w.data.qpos[w.info('panda')['joints']['joint1']['qpos']])})
check('20详细人物与运动Panda同一个有界batch，默认停障零人体接触且同物理Frame',crowd_panda)
def default_loop_batch():
 import numpy as np
 s=scene();s['entities']=s['entities'][:1];people=[]
 for i in range(20):
  e=copy.deepcopy(person);e['entityId']='loop_'+str(i);e['transform']['position']=[(i%5)*1.5,(i//5)*1.5,0];e['components']['human']['phase']=(i*.61803398875)%1;people.append(e)
 s['entities']+=people;a,b=world(s),world(s);motions=[{'kind':'human','entityId':e['entityId'],'durationS':6.,'route':{'pointsM':[[3,0,0],[-3,0,0]],'speedMps':3.,'behavior':'walk','loop':True,'avoidObstacles':False,'dwellS':.1 if i%3==0 else 0.}}for i,e in enumerate(people)]
 # 面板默认两点闭合loop，同时覆盖重复零长度段、站立与空路径；不缩小默认路线坐标。
 motions[-1]['route']['pointsM']=[];motions[-2]['route']['pointsM'].insert(0,people[-2]['transform']['position']);motions[-3]['route']['behavior']='stand'
 for w in(a,b):w.execute({'kind':'batch','actionId':'loop-equivalence','expectedGeneration':1,'motions':motions})
 optimized=worker.human_batch.advance;maximum=0.
 def scalar(w,ms,elapsed):
  for m in ms:worker.human.advance(w,w.info(m['entityId']),m,elapsed)
 for step in range(3000):
  a.tick();worker.human_batch.advance=scalar
  try:b.tick()
  finally:worker.human_batch.advance=optimized
  maximum=max(maximum,float(np.max(np.abs(a.data.site_xpos-b.data.site_xpos))),float(np.max(np.abs(a.data.geom_xmat-b.data.geom_xmat))));assert maximum<1e-9,(step,maximum)
  if step==500:
   for w in(a,b):
    w.set_paused(True,1);old=w.step_index
    for _ in range(10):w.tick()
    assert w.step_index==old;w.set_paused(False,1)
  if step==2000:
   for w in(a,b):w.stop({'entityIds':['loop_0','loop_1'],'expectedGeneration':1})
 assert a.step_index==b.step_index==3000 and not a.active and not b.active;assert a.receipts['loop-equivalence']['status']==b.receipts['loop-equivalence']['status']=='cancelled';results.append({'metric':'defaultUiLoopBatchVsScalar','actors':20,'actualSteps':3000,'simTimeS':a.data.time,'pointsM':[[3,0,0],[-3,0,0]],'speedMps':3.,'maxNativeError':maximum,'includes':['闭合loop折线索引/转向','零长度段','端点停留','站立/空路线','暂停','选择停后重建合批数组']})
check('20人面板默认两点闭合loop逐tick等价，含端点/停留/暂停/选择停止',default_loop_batch)
(out/'verify.json').write_text(json.dumps({'status':'completed','results':results,'source':'产品MuJoCo World逐tick原生实测','limitations':['不证明平衡步态、恢复或逼真外观；停障是保守停止，无自动绕行']},ensure_ascii=False,indent=2));print(json.dumps({'status':'completed','checks':len([r for r in results if 'name'in r]),'output':str(out/'verify.json')},ensure_ascii=False))
