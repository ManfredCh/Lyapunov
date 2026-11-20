"""有界 MuJoCo 仿真验收。几何预演使用临时 MjData，监测读原生积分中的接触和关节。"""

import copy
import hashlib
import os
import uuid
import mujoco as mj
import numpy as np

STATE = int(mj.mjtState.mjSTATE_INTEGRATION)
MAX_CHECKPOINTS = 12


def state_vector(world):
    out = np.empty(mj.mj_stateSize(world.model, STATE))
    mj.mj_getState(world.model, world.data, out, STATE)
    return out


def state_hash(world):
    return hashlib.sha256(state_vector(world).tobytes()).hexdigest()


def model_hash(model):
    buffer = np.empty(mj.mj_sizeModel(model), dtype=np.uint8)
    mj.mj_saveModel(model, None, buffer)
    return hashlib.sha256(buffer.tobytes()).hexdigest()


def current(world, generation, error):
    world.require_ready()
    if world.generation != generation:
        raise error('STALE_GENERATION', '评估请求属于旧模型代次')


def owned_geom(world, entity_id):
    model = world.model
    return [i for i in range(model.ngeom) if world.entity_of_geom(model.geom(i).name) == entity_id and
            (model.geom_contype[i] or model.geom_conaffinity[i])]


def clearance(world, action, spec, error):
    """按轨迹关节插值抽样。载荷刚性相对位姿只写入预演数据，活体世界的装配方式保持不变。"""
    robot = action['entityId']
    obj = spec.get('carriedObjectId')
    sampled_ids = spec.get('obstacleIds')
    if (not isinstance(sampled_ids, list) or not sampled_ids or len(sampled_ids) > 12
        or len(set(sampled_ids)) != len(sampled_ids) or robot in sampled_ids or obj in sampled_ids or obj == robot):
        raise error('CLEARANCE_INVALID_SCOPE', '必须声明可核对的障碍实体范围')
    world.info(robot)
    for eid in sampled_ids:
        world.info(eid)
    model, live = world.model, world.data
    if model.nflex:
        raise error('CLEARANCE_UNSUPPORTED_FLEX', '采样净空覆盖有效刚体碰撞几何')
    robot_geoms = owned_geom(world, robot)
    obstacles = [g for eid in sampled_ids for g in owned_geom(world, eid)]
    payload_geoms = owned_geom(world, obj) if obj else []
    if not robot_geoms or not obstacles or (obj and not payload_geoms):
        raise error('CLEARANCE_GEOMETRY_MISSING', '缺少可核对的机器人、障碍或载荷碰撞几何')
    scratch = mj.MjData(model)
    mj.mj_setState(model, scratch, state_vector(world), STATE)
    if obj:
        info = world.info(obj)
        if obj not in world.contact_summary(robot) or obj in world.assisted:
            raise error('CLEARANCE_PAYLOAD_CONTACT_REQUIRED', '携物净空需要实际机器人与目标接触')
        body = info['body']
        joint = int(model.body_jntadr[body])
        tcp = world.info(robot)['controller'].get('tcp', {})
        prefix = world.info(robot)['prefix']
        anchor = mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY, prefix + str(tcp.get('body', '')))
        if joint < 0 or int(model.jnt_type[joint]) != int(mj.mjtJoint.mjJNT_FREE) or anchor < 0:
            raise error('CLEARANCE_PAYLOAD_GEOMETRY_UNSUPPORTED', '需要自由刚体载荷与原生末端连杆')
        qpos = int(model.jnt_qposadr[joint])
        delta = live.xmat[anchor].reshape(3,3).T @ (live.xpos[body] - live.xpos[anchor])
        inverse = live.xquat[anchor].copy()
        inverse[1:] *= -1
        rotation = np.zeros(4)
        mj.mju_mulQuat(rotation, inverse, live.xquat[body])
    joints = world.info(robot)['joints']
    addresses = [joints[name]['qpos'] for name in action['jointNames']]
    points = action['points']
    if not 2 <= len(points) <= 41 or len(robot_geoms+payload_geoms)*len(obstacles) > 600:
        raise error('CLEARANCE_SAMPLE_BUDGET', '预演的轨迹或碰撞对超出预算')
    times = [p['timeS'] for p in points]
    if times[0] != 0 or any(b <= a for a,b in zip(times,times[1:])):
        raise error('CLEARANCE_INVALID_TRAJECTORY', '净空预演需要从 0 秒开始的严格有序轨迹')
    samples = [(0., live.qpos[addresses].copy())]
    for a,b in zip(points,points[1:]):
        q0,q1 = np.asarray(a['positions'],float),np.asarray(b['positions'],float)
        for fraction in (1/3,2/3,1.):
            samples.append((a['timeS'] + fraction*(b['timeS']-a['timeS']), q0 + fraction*(q1-q0)))
    cap = .08
    minima = {'robot':None,'payload':None}
    for seconds, joints_at_time in samples:
        scratch.qpos[addresses] = joints_at_time
        mj.mj_kinematics(model,scratch)
        if obj:
            scratch.qpos[qpos:qpos+3] = scratch.xpos[anchor] + scratch.xmat[anchor].reshape(3,3) @ delta
            mj.mju_mulQuat(scratch.qpos[qpos+3:qpos+7],scratch.xquat[anchor],rotation)
            mj.mj_kinematics(model,scratch)
        for role, actors in (('robot',robot_geoms),('payload',payload_geoms)):
            for i in actors:
                for j in obstacles:
                    if not ((model.geom_contype[i] & model.geom_conaffinity[j]) or (model.geom_contype[j] & model.geom_conaffinity[i])):
                        continue
                    value = float(mj.mj_geomDistance(model,scratch,i,j,cap,None))
                    if minima[role] is None or value < minima[role]['distanceM']:
                        minima[role] = {'distanceM':value,'geom1':model.geom(i).name,'geom2':model.geom(j).name,'timeS':seconds}
    if minima['robot'] is None or (obj and minima['payload'] is None):
        raise error('CLEARANCE_CONTACT_MASK_EMPTY', '透传碰撞掩码后无有效预演几何对')
    return {'source':'mujoco-sampled-rigid-geometry','sampleCount':len(samples),'distanceCapM':cap,**minima}


def start_monitor(world, request, error):
    robot, target = request['robotId'], request['targetId']
    world.info(robot)
    world.info(target)
    if robot == target:
        raise error('EVALUATION_INVALID_ENTITIES', '机器人与目标必须是不同实体')
    limits = request.get('limits', {})
    names = ('graspForceN','otherForceN','jointSpeedRps')
    if set(limits) != set(names) or any(type(limits[n]) not in (float,int) or not 0 < limits[n] < 1e6 for n in names):
        raise error('EVALUATION_INVALID_LIMITS', '需要夹持力、其他接触力和关节速度的显式仿真限值')
    if getattr(world,'evaluation_monitor',None):
        raise error('EVALUATION_ALREADY_RUNNING', '当前世界已经在采样')
    world.evaluation_monitor = {'robotId':robot,'targetId':target,'generation':world.generation,
        'startStep':world.step_index,'samples':0,'limits':dict(limits),'peaks':{n:0. for n in names},'includesInitial':True}
    sample(world)
    return {'worldId':world.id,'generation':world.generation,'startStep':world.step_index}


def sample(world):
    monitor = getattr(world,'evaluation_monitor',None)
    if not monitor or monitor['generation'] != world.generation:
        return
    contacts = world.contact_summary(monitor['robotId'])
    target = monitor['targetId']
    speeds = [abs(float(world.data.qvel[j['dof']])) for j in world.info(monitor['robotId'])['joints'].values()
              if int(world.model.jnt_type[j['id']]) == int(mj.mjtJoint.mjJNT_HINGE)]
    step_values = {'graspForceN':contacts.get(target,{}).get('maxContactForceN',0.),
        'otherForceN':max((value['maxContactForceN'] for key,value in contacts.items() if key != target),default=0.),
        'jointSpeedRps':max(speeds,default=0.)}
    monitor['samples'] += 1
    for key,value in step_values.items():
        monitor['peaks'][key] = max(monitor['peaks'][key],value)


def finish_monitor(world,error):
    monitor = getattr(world,'evaluation_monitor',None)
    if not monitor or monitor['generation']!=world.generation or monitor['samples']<=0:
        raise error('EVALUATION_NO_SAMPLES', '无同代次的原生逐步采样')
    world.evaluation_monitor = None
    faults = [name for name,value in monitor['peaks'].items() if value>monitor['limits'][name]]
    return {'worldId':world.id,'sceneRevision':world.applied_revision,'endStep':world.step_index,
        **monitor,'passed':not faults,'violations':faults,'source':'mujoco-native-step-peak'}


def checkpoint(world,error):
    if world.active or world.assisted or world.frozen or getattr(world,'evaluation_fault',None) or getattr(world,'gauntlet_profile',None):
        raise error('EVALUATION_CHECKPOINT_BUSY', '只在无在途动作、故障和辅助约束的阶段边界保存快照')
    tokens = getattr(world,'evaluation_checkpoints',{})
    if len(tokens)>=MAX_CHECKPOINTS:
        raise error('EVALUATION_CHECKPOINT_LIMIT', '当前世界快照已达上限')
    state = state_vector(world)
    token = str(uuid.uuid4())
    checkpoint_data = {'generation':world.generation,'stepIndex':world.step_index,'state':state,
        'sceneRevision':world.applied_revision,'stateSha256':hashlib.sha256(state.tobytes()).hexdigest(),
        'modelSha256':model_hash(world.model),'held':{k:copy.deepcopy(v['heldTargets']) for k,v in world.entities.items()}}
    tokens[token] = checkpoint_data
    world.evaluation_checkpoints = tokens
    return {'checkpointId':token,'worldId':world.id,**{k:checkpoint_data[k] for k in ('generation','stepIndex','sceneRevision','stateSha256','modelSha256')}}


def fork(world, request, factory, error):
    cp = getattr(world,'evaluation_checkpoints',{}).get(request.get('checkpointId'))
    if not cp or cp['generation']!=world.generation or cp['sceneRevision']!=world.applied_revision:
        raise error('EVALUATION_CHECKPOINT_STALE', '快照必须来自当前原生模型')
    # 保持编译时模型名称一致以复核整个 MJB，交付时采用新世界 ID。
    if cp['modelSha256'] != model_hash(world.model):
        raise error('EVALUATION_MODEL_MISMATCH', '源模型在快照保存后发生变化')
    target = factory(world.scene,{**world.options,'worldId':world.id,'startPaused':True},
                     collision_patches=getattr(world,'evaluation_collision_patches',None))
    try:
        if cp['modelSha256'] != model_hash(target.model):
            raise error('EVALUATION_MODEL_MISMATCH', '分叉重编译模型与快照不一致')
        target.id = request['forkWorldId']
        # 分叉由动作驱动物理时钟，避免两次回放间隙的墙钟调度差异。
        target.clock = 'manual'
        target.step_index = cp['stepIndex']
        for key,held in cp['held'].items():
            target.entities[key]['heldTargets'] = copy.deepcopy(held)
        mj.mj_setState(target.model,target.data,cp['state'],STATE)
        target.refresh_derived()
        mj.mj_setState(target.model,target.data,cp['state'],STATE)
        if state_hash(target)!=cp['stateSha256']:
            raise error('EVALUATION_STATE_MISMATCH','分叉原生积分态校验失败')
        return target,{'world':target.handle(),'sourceWorldId':world.id,'stepIndex':target.step_index,'stateSha256':cp['stateSha256']}
    except Exception:
        target.close()
        raise


def configure_fault(world, request, error):
    if os.environ.get('LYAPUNOV_SIM_LAB_FAULTS')!='1':
        raise error('EVALUATION_FAULTS_DISABLED', '故障注入仅限显式启动的仿真实验')
    action_id = request.get('actionId')
    if not isinstance(action_id,str) or not action_id or action_id in world.receipts or getattr(world,'evaluation_fault',None):
        raise error('EVALUATION_FAULT_INVALID','需要一个尚未执行的夹爪动作 ID')
    world.evaluation_fault = {'kind':'gripper-stall','actionId':action_id,'generation':world.generation,'triggeredStep':None}
    return dict(world.evaluation_fault)


def stalls_gripper(world, motion):
    fault = getattr(world,'evaluation_fault',None)
    if not fault or fault['generation']!=world.generation or motion.get('_evaluationActionId')!=fault['actionId']:
        return False
    if fault['triggeredStep'] is None:
        fault['triggeredStep'] = world.step_index+1
    return True
