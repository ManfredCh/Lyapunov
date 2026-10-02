"""独立 OMPL RRTConnect；用自己的 MuJoCo model/data 做配置碰撞判断。"""
import sys,json,uuid

def scalar_joint_types():
    """单自由度关节类型（MuJoCo: hinge/slide）按整数返回。

    mjtJoint 是 enum.Enum，而 model.jnt_type 的元素是 numpy 整型；在 mujoco 3.13 + numpy 2.2 下
    元组成员判断（np.int32(3) in (mjtJoint.mjJNT_HINGE, ...)）恒为 False，会把所有正常关节误判成
    不支持。按整数比较，跨 numpy 版本都成立。
    """
    import mujoco
    return (int(mujoco.mjtJoint.mjJNT_HINGE),int(mujoco.mjtJoint.mjJNT_SLIDE))

def plan(req):
    from ompl import base as ob, geometric as og
    import mujoco,numpy as np
    model=mujoco.MjModel.from_xml_path(req['modelPath']); data=mujoco.MjData(model)
    names=req['jointNames'];
    if not names or len(set(names))!=len(names) or any(len(req[k])!=len(names) or not np.isfinite(req[k]).all() for k in ['startPositions','goalPositions']): raise ValueError('INVALID_JOINT_VECTOR')
    if not np.isfinite(req.get('durationS',2.)) or req.get('durationS',2.)<=0: raise ValueError('INVALID_DURATION')
    scalar_joints=scalar_joint_types()
    ids=[mujoco.mj_name2id(model,mujoco.mjtObj.mjOBJ_JOINT,n) for n in names]
    if any(i<0 for i in ids): raise ValueError('JOINT_NOT_FOUND')
    if any(int(model.jnt_type[i]) not in scalar_joints for i in ids): raise ValueError('UNSUPPORTED_CAPABILITY: scalar joints only')
    qids=[model.jnt_qposadr[i] for i in ids];dim=len(ids);space=ob.RealVectorStateSpace(dim);bounds=ob.RealVectorBounds(dim)
    for i,j in enumerate(ids):
      if not model.jnt_limited[j]: raise ValueError('JOINT_LIMIT_REQUIRED: '+names[i])
      bounds.setLow(i,float(model.jnt_range[j,0]));bounds.setHigh(i,float(model.jnt_range[j,1]))
    fixed=[]
    for name,value in req.get('fixedJoints',{}).items():
      if name in names: raise ValueError('INVALID_JOINT_VECTOR: fixedJoints 与 jointNames 重叠: '+name)
      jid=mujoco.mj_name2id(model,mujoco.mjtObj.mjOBJ_JOINT,name)
      if jid<0: raise ValueError('FIXED_JOINT_NOT_FOUND: '+name)
      if int(model.jnt_type[jid]) not in scalar_joints: raise ValueError('UNSUPPORTED_CAPABILITY: fixedJoints 仅支持单自由度关节: '+name)
      if isinstance(value,bool) or not isinstance(value,(int,float)) or not np.isfinite(value): raise ValueError('INVALID_JOINT_VECTOR: fixedJoints 值必须为有限数值: '+name)
      fixed.append((int(model.jnt_qposadr[jid]),float(value)))
    space.setBounds(bounds); ss=og.SimpleSetup(space);checks=0; rejected=0
    def valid(state):
      nonlocal checks,rejected
      checks+=1;data.qpos[:]=model.qpos0;data.qpos[qids]=[state[i] for i in range(dim)]
      for adr,value in fixed: data.qpos[adr]=value
      mujoco.mj_forward(model,data)
      for c in data.contact:
        if c.dist < -req.get('contactToleranceM',.0001): rejected+=1;return False
      return True
    ss.setStateValidityChecker(valid);ss.getSpaceInformation().setStateValidityCheckingResolution(req.get('resolutionFraction',.002))
    start=space.allocState();goal=space.allocState()
    for i,(a,b) in enumerate(zip(req['startPositions'],req['goalPositions'])): start[i]=a;goal[i]=b
    ss.setStartAndGoalStates(start,goal);ss.setPlanner(og.RRTConnect(ss.getSpaceInformation()))
    result=ss.solve(req.get('timeoutS',2.))
    if not result or not ss.haveExactSolutionPath(): return {'provider':'ompl','noSolution':True,'reason':str(result),'collisionChecks':checks,'rejectedStates':rejected}
    path=ss.getSolutionPath();path.interpolate(max(path.getStateCount(),req.get('minPoints',30)));states=path.getStates();duration=req.get('durationS',2.)
    for state in states:
      if not valid(state): raise RuntimeError('PATH_COLLISION')
    motion={'planId':str(uuid.uuid4()),'entityId':req['entityId'],'modelVersion':req['modelVersion'],'jointNames':names,'points':[{'timeS':duration*i/(len(states)-1),'positions':[state[j] for j in range(dim)]} for i,state in enumerate(states)],'expectedGeneration':req['expectedGeneration'],'collisionContextVersion':req['collisionContextVersion']}
    return {'provider':'ompl','plan':motion,'noSolution':False,'collisionChecks':checks,'rejectedStates':rejected,'collisionModel':'MuJoCo contact geometry from supplied independent model snapshot'}
if __name__=='__main__':
    try: print('LYAPUNOV_RESULT='+json.dumps(plan(json.load(sys.stdin)),allow_nan=False))
    except ImportError as e: print('LYAPUNOV_RESULT='+json.dumps({'error':'PROVIDER_UNAVAILABLE','message':str(e)}));sys.exit(2)
    except Exception as e: print('LYAPUNOV_RESULT='+json.dumps({'error':type(e).__name__,'message':str(e)}));sys.exit(1)
