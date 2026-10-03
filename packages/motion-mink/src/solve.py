"""独立 Mink IK；编译私有模型，不读写运行中的仿真 data。输入/输出都是 SI 值。"""
import json,sys,uuid
import numpy as np
import mujoco,mink

# 单自由度关节类型必须按整数比较：mjtJoint 是 enum.Enum，而 model.jnt_type 的元素是 numpy 整型，
# 在 mujoco 3.13 + numpy 2.2 下 `np.int32(3) not in [mjtJoint.mjJNT_HINGE, ...]` 恒为 True，
# 会把所有正常关节误判成不支持、使 IK 完全不可用。按整数集合比较，跨 numpy 版本都成立。
SCALAR_JOINT_TYPES=(int(mujoco.mjtJoint.mjJNT_HINGE),int(mujoco.mjtJoint.mjJNT_SLIDE))

def solve(request):
    spec=mujoco.MjSpec.from_file(request['modelPath'])
    tcp=request['tcp']; body=spec.body(tcp['body'])
    if body is None: raise ValueError('TCP_BODY_MISSING: '+tcp['body'])
    site_name='lyapunov_motion_tcp'
    if tcp.get('site'):
        site=spec.site(tcp['site'])
        if site is None or site.parent.name!=tcp['body']: raise ValueError('TCP_SITE_MISSING: '+tcp['site'])
        site_name=tcp['site']
    else:
        localq=np.asarray(tcp.get('quaternionXyzw',[0,0,0,1]),float)
        if localq.shape!=(4,) or not np.isfinite(localq).all() or abs(np.linalg.norm(localq)-1)>1e-4: raise ValueError('INVALID_TCP_LOCAL_POSE')
        body.add_site(name=site_name,pos=tcp.get('offsetM',[0,0,0]),quat=localq[[3,0,1,2]])
    model=spec.compile(); names=request['jointNames'];
    if not names or len(set(names))!=len(names) or len(request['startPositions'])!=len(names) or not np.isfinite(request['startPositions']).all(): raise ValueError('INVALID_JOINT_VECTOR')
    if not np.isfinite(request.get('durationS',2.)) or request.get('durationS',2.)<=0: raise ValueError('INVALID_DURATION')
    jids=[mujoco.mj_name2id(model,mujoco.mjtObj.mjOBJ_JOINT,n) for n in names]
    if any(i<0 for i in jids): raise ValueError('JOINT_NOT_FOUND')
    if any(int(model.jnt_type[i]) not in SCALAR_JOINT_TYPES for i in jids): raise ValueError('UNSUPPORTED_CAPABILITY: IK 当前输入只支持有名称的单自由度关节')
    qids=[int(model.jnt_qposadr[i]) for i in jids]; dids=[int(model.jnt_dofadr[i]) for i in jids]
    target=request['targetPose']; q=np.array(target['quaternion'],float)
    if q.shape!=(4,) or not np.isfinite(q).all() or np.linalg.norm(q)<1e-12 or not np.isfinite(target['position']).all(): raise ValueError('INVALID_TCP_POSE')
    q=q[[3,0,1,2]]; q/=np.linalg.norm(q)
    pose=mink.SE3.from_rotation_and_translation(mink.SO3(q),np.array(target['position'],float))
    fixed=[]
    for name,value in request.get('fixedJoints',{}).items():
      if name in names: raise ValueError('INVALID_JOINT_VECTOR: fixedJoints 与 jointNames 重叠: '+name)
      jid=mujoco.mj_name2id(model,mujoco.mjtObj.mjOBJ_JOINT,name)
      if jid<0: raise ValueError('FIXED_JOINT_NOT_FOUND: '+name)
      if int(model.jnt_type[jid]) not in SCALAR_JOINT_TYPES: raise ValueError('UNSUPPORTED_CAPABILITY: fixedJoints 仅支持单自由度关节: '+name)
      if isinstance(value,bool) or not isinstance(value,(int,float)) or not np.isfinite(value): raise ValueError('INVALID_JOINT_VECTOR: fixedJoints 值必须为有限数值: '+name)
      fixed.append((int(model.jnt_qposadr[jid]),float(value)))
    best=None
    for seed_index,seed in enumerate(request.get('seeds',[request['startPositions']])):
      if len(seed)!=len(names) or not np.isfinite(seed).all(): raise ValueError('INVALID_JOINT_VECTOR')
      q0=model.qpos0.copy(); q0[qids]=seed
      for adr,value in fixed: q0[adr]=value
      cfg=mink.Configuration(model,q=q0); task=mink.FrameTask(frame_name=site_name,frame_type='site',position_cost=1.,orientation_cost=.5); task.set_target(pose)
      frozen=[i for i in range(model.nv) if i not in dids]; constraints=[mink.DofFreezingTask(model=model,dof_indices=frozen)] if frozen else []
      for step in range(request.get('maxIterations',160)):
        vel=mink.solve_ik(cfg,[task],dt=1.,solver='daqp',damping=.001,constraints=constraints); cfg.integrate_inplace(vel,1.)
        error=task.compute_error(cfg); pe=float(np.linalg.norm(error[:3])); oe=float(np.linalg.norm(error[3:]))
        if pe<request.get('positionToleranceM',.003) and oe<request.get('orientationToleranceRad',.0872664626): break
      result={'positions':cfg.q[qids].tolist(),'positionErrorM':pe,'orientationErrorRad':oe,'iterations':step+1,'seedIndex':seed_index,'converged':pe<request.get('positionToleranceM',.003) and oe<request.get('orientationToleranceRad',.0872664626)}
      if best is None or (not best['converged'] and result['converged']) or (result['converged']==best['converged'] and pe+oe<best['positionErrorM']+best['orientationErrorRad']): best=result
      if result['converged']: break
    plan=None
    if best['converged']:
      duration=request.get('durationS',2.); start=request['startPositions']; goal=best['positions']; steps=max(2,int(max(abs(a-b) for a,b in zip(start,goal))/.08)+1)
      plan={'planId':str(uuid.uuid4()),'entityId':request['entityId'],'modelVersion':request['modelVersion'],'jointNames':names,'points':[{'timeS':duration*i/(steps-1),'positions':[(1-i/(steps-1))*a+i/(steps-1)*b for a,b in zip(start,goal)]} for i in range(steps)],'collisionContextVersion':request['collisionContextVersion'],'expectedGeneration':request['expectedGeneration']}
    return {'provider':'mink','mujocoVersion':mujoco.__version__,'result':best,'plan':plan,'collisionChecked':False}

if __name__=='__main__':
    try: print(json.dumps(solve(json.load(sys.stdin)),allow_nan=False))
    except Exception as e: print(json.dumps({'error':type(e).__name__,'message':str(e)})); sys.exit(1)
