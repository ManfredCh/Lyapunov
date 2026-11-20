"""Explicit laboratory-only perturbations on a single live MuJoCo generation."""

import hashlib
import math
import os
import re

import mujoco as mj
import numpy as np


SCALARS = {
    'damping_scale': (1., .5, 1.5), 'gain_scale': (1., .5, 1.5),
    'gravcomp_delta': (0., -.2, .2), 'cam_tilt_deg': (0., -5., 5.),
    'proprio_noise': (0., 0., .01), 'proprio_bias': (0., 0., .02),
    'hue_deg': (0., -30., 30.), 'sat_scale': (1., .5, 1.5),
    'rgb_gain': (1., .5, 1.5), 'rgb_noise': (0., 0., 20.),
    'depth_noise_m': (0., 0., .01), 'depth_dropout': (0., 0., .1),
    'push_dir_rad': (0., 0., 2 * math.pi),
}
EVENTS = {'slip': (.30, 22, 'lift'), 'push': (.80, 18, 'approach'), 'knockout': (1.2, 16, 'lift')}


def require_profile(world, error):
    if os.environ.get('LYAPUNOV_SIM_LAB_FAULTS') != '1':
        raise error('EVALUATION_FAULTS_DISABLED', 'Gauntlet 注入仅限实验仿真')
    state = getattr(world, 'gauntlet_profile', None)
    if not state:
        raise error('GAUNTLET_NOT_CONFIGURED', '需要先在已暂停的第 0 步配置当前世界')
    return state


def number(value, minimum, maximum, error, name):
    if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise error('GAUNTLET_PROFILE_INVALID', f'扰动字段越界: {name}')
    return float(value)


def configure(world, request, error):
    if os.environ.get('LYAPUNOV_SIM_LAB_FAULTS') != '1':
        raise error('EVALUATION_FAULTS_DISABLED', 'Gauntlet 注入仅限实验仿真')
    if world.step_index != 0 or not world.paused or world.active or getattr(world, 'gauntlet_profile', None) or getattr(world, 'evaluation_checkpoints', None):
        raise error('GAUNTLET_PROFILE_LOCKED', '仅允许在未保存快照的第 0 步暂停世界配置一次')
    profile = request.get('profile')
    if not isinstance(profile, dict):
        raise error('GAUNTLET_PROFILE_INVALID', 'profile 必须是对象')
    data = {key: number(profile.get(key, default), lo, hi, error, key) for key, (default, lo, hi) in SCALARS.items()}
    seed, prefix = request.get('seed'), request.get('actionPrefix')
    if type(seed) is not int or not 0 <= seed <= 2**32-1 or not isinstance(prefix, str) or not re.fullmatch(r'[\w-]{1,100}', prefix):
        raise error('GAUNTLET_PROFILE_INVALID', 'seed/动作前缀无效')
    disturbance, fault = profile.get('disturbance', ''), profile.get('fault', '')
    trigger = profile.get('fault_trigger', '')
    delay = profile.get('fault_delay', 0)
    if disturbance not in (*EVENTS, '') or fault not in ('', 'camera_freeze', 'dead_gripper') or trigger not in ('', 'arm_motion', 'gripper_close') or fault and not trigger or type(delay) is not int or not 0 <= delay <= 110:
        raise error('GAUNTLET_PROFILE_INVALID', '事件、故障或触发延迟无效')
    robot, target = world.info(request['robotId']), world.info(request['targetId'])
    camera = world.resolve_camera_name(request['cameraName'])
    camera_id = world.model.camera(camera).id
    offset = profile.get('cam_offset_m', [0., 0., 0.])
    if not isinstance(offset, list) or len(offset) != 3:
        raise error('GAUNTLET_PROFILE_INVALID', '相机偏移必须为三元数组')
    offset = [number(v, -.015, .015, error, 'cam_offset_m') for v in offset]
    bodies = [i for i in range(world.model.nbody) if world.model.body(i).name.startswith(robot['prefix'])]
    dofs = [v['dof'] for v in robot['joints'].values()]
    actuators = [v['id'] for v in robot['actuators'].values() if v['mode'] == 'position']
    world.model.dof_damping[dofs] *= data['damping_scale']
    world.model.actuator_gainprm[actuators, :1] *= data['gain_scale']
    world.model.actuator_biasprm[actuators, 1:3] *= data['gain_scale']
    world.model.body_gravcomp[bodies] += data['gravcomp_delta']
    world.model.cam_pos[camera_id] += offset
    if data['cam_tilt_deg']:
        q, result = np.zeros(4), np.zeros(4)
        mj.mju_axisAngle2Quat(q, np.array([1., 0., 0.]), math.radians(data['cam_tilt_deg']))
        mj.mju_mulQuat(result, world.model.cam_quat[camera_id].copy(), q)
        world.model.cam_quat[camera_id] = result
    world.refresh_derived()
    data.update(
        seed=seed, prefix=prefix, targetBody=target['body'], camera=camera,
        robotId=request['robotId'], targetId=request['targetId'],
        disturbance=disturbance, fault=fault, faultTrigger=trigger, faultDelay=delay,
        anchorStep=None, disturbanceStep=None, forceSteps=0, forceN=None, faultStep=None,
        imageSamples=0, jointSamples=0,
        static={'damping':world.model.dof_damping[dofs].tolist(),
                'actuatorGains': world.model.actuator_gainprm[actuators, 0].tolist(),
                'gravityCompensation':world.model.body_gravcomp[bodies].tolist(),
                'cameraPositionM':world.model.cam_pos[camera_id].tolist(), 'cameraQuaternionWxyz':world.model.cam_quat[camera_id].tolist()},
    )
    world.gauntlet_profile = data
    return status(world, error)


def status(world, error):
    state = require_profile(world, error)
    return {**state, 'worldId': world.id, 'generation': world.generation, 'stepIndex': world.step_index,
            'faultActualStep': (getattr(world, 'evaluation_fault', None) or {}).get('triggeredStep', state['faultStep'])}


def before_step(world):
    state = getattr(world, 'gauntlet_profile', None)
    if state is None:
        return None
    step = world.step_index + 1
    actions = world.active
    prefix = state['prefix']
    fault = state['fault']
    if fault and state['faultStep'] is None:
        phase = 'close' if state['faultTrigger'] == 'gripper_close' else 'approach'
        if state['anchorStep'] is None and f'{prefix}-{phase}' in actions:
            state['anchorStep'] = step
        if state['anchorStep'] is not None and step >= state['anchorStep'] + state['faultDelay']:
            state['faultStep'] = step
            if fault == 'dead_gripper':
                world.evaluation_fault = {'kind': 'gripper-stall', 'generation': world.generation,
                                          'actionId': f'{prefix}-close', 'triggeredStep': None}
    event = state['disturbance']
    if not event:
        return None
    magnitude, duration, phase = EVENTS[event]
    if state['disturbanceStep'] is None and f'{prefix}-{phase}' in actions:
        state['disturbanceStep'] = step
        angle = state['push_dir_rad']
        state['forceN'] = [magnitude * math.cos(angle), magnitude * math.sin(angle), 0.]
    if state['disturbanceStep'] is None or step >= state['disturbanceStep'] + duration:
        return None
    index = state['targetBody']
    state['forceSteps'] += 1
    previous = world.data.xfrc_applied[index, :3].copy()
    world.data.xfrc_applied[index, :3] += state['forceN']
    return index, previous


def image(world, camera, rgb, depth):
    state = getattr(world, 'gauntlet_profile', None)
    if not state or camera != state['camera']:
        return rgb, depth
    index = state['imageSamples']
    state['imageSamples'] += 1
    rng = np.random.default_rng(np.random.SeedSequence([state['seed'], index, 1]))
    dropout = state['depth_dropout']
    axis = np.array([1., 1., 1.]) / math.sqrt(3.)
    # RGB 变换在中性灰轴周围旋转，保持灰度。相机本体标定仍随原帧。
    x, y, z = axis
    cross = np.array([[0., -z, y], [z, 0., -x], [-y, x, 0.]])
    theta = math.radians(state['hue_deg'])
    projection = np.outer(axis, axis)
    transform = projection + state['sat_scale'] * (math.cos(theta) * (np.eye(3) - projection) + math.sin(theta) * cross)
    if theta or state['sat_scale'] != 1. or state['rgb_gain'] != 1. or state['rgb_noise']:
        adjusted = (rgb.astype(float) @ transform.T) * state['rgb_gain']
        rgb = np.rint(np.clip(adjusted + rng.normal(0., state['rgb_noise'], rgb.shape), 0., 255.)).astype(np.uint8)
    if state['depth_noise_m'] or dropout:
        depth = (depth + rng.normal(0., state['depth_noise_m'], depth.shape)).clip(0.).astype(np.float32)
        depth[rng.random(depth.shape) < dropout] = 0.
    return rgb, depth


def joints(world, request, error):
    state = require_profile(world, error)
    if request.get('robotId') != state['robotId']:
        raise error('GAUNTLET_ROBOT_MISMATCH', '受扰关节读数仅归属已配置的机器人')
    info = world.info(request['robotId'])
    # 同代次同物理步的重复读取返回同样的受扰数据。授权的真值读数不变。
    names = sorted(info['joints'])
    values = {}
    for name in names:
        spec = info['joints'][name]
        h = hashlib.sha256(name.encode()).digest()
        key = int.from_bytes(h[:4], 'little')
        rng = np.random.default_rng(np.random.SeedSequence([state['seed'], key]))
        bias = rng.uniform(-state['proprio_bias'], state['proprio_bias'])
        noise = np.random.default_rng(np.random.SeedSequence([state['seed'], world.step_index, key])).normal(0, state['proprio_noise'])
        values[name] = float(world.data.qpos[world.model.jnt_qposadr[spec['id']]]) + bias + noise
    state['jointSamples'] += 1
    return {'positions': values, 'stepIndex': world.step_index, 'generation': world.generation, 'source': 'mujoco-gauntlet-policy-observation'}
