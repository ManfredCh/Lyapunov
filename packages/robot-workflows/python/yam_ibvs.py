"""Controlled MuJoCo comparison of consecutive six-axis YAM wrist RGB-D corrections."""
import json
import math

import mujoco as mj
import numpy as np
from PIL import Image
from agy.ibvs import Ibvs
from agy.yam_ik import YamIk


COLORS = np.array([[1., .02, .02], [.02, 1., .02], [.02, .02, 1.], [1., 1., .02]])
POINTS = np.array([[-.026, -.018, .14], [.024, -.019, .15], [-.021, .025, .165], [.025, .022, .14]])


def observe(renderer, data, step):
    renderer.update_scene(data, camera='evaluation-wrist')
    rgb = renderer.render().copy()
    renderer.enable_depth_rendering()
    try:
        depth = renderer.render().copy()
    finally:
        renderer.disable_depth_rendering()
    r, g, b = rgb.transpose(2, 0, 1)
    masks = ((r > 105) & (g < 70) & (b < 70),
             (g > 105) & (r < 70) & (b < 70),
             (b > 105) & (r < 70) & (g < 70),
             (r > 105) & (g > 105) & (b < 70))
    observed = []
    for mask in masks:
        ys, xs = np.where(mask)
        if len(xs) < 4 or len(xs) > 200 or min(xs) <= 1 or min(ys) <= 1 or max(xs) >= rgb.shape[1] - 2 or max(ys) >= rgb.shape[0] - 2:
            return step, rgb, None
        observed.append([xs.mean(), ys.mean(), np.median(depth[ys, xs])])
    return step, rgb, np.asarray(observed)


def independent_pose_error(now, reference):
    angle = math.acos(float(np.clip((np.trace(reference[:3, :3].T @ now[:3, :3]) - 1.) / 2., -1., 1.)))
    return {'positionM': float(np.linalg.norm(now[:3, 3] - reference[:3, 3])), 'orientationRad': angle}


def rollout(req, mjcf, out):
    passes = req.get('passes', 35)
    if type(passes) is not int or not 6 <= passes <= 60:
        raise ValueError('ROBOTICS_INPUT_INVALID: YAM IBVS passes 必须在 6–60')
    solver = YamIk(xml_path=str(mjcf), site_name='grasp_site')
    arm = np.array([solver.model.joint(f'joint{i}').id for i in range(1, 7)])
    indexes = solver.model.jnt_qposadr[arm]
    if solver.arm_dof != 6 or not np.array_equal(indexes, np.arange(6)):
        raise ValueError('YAM_IBVS_MODEL_MISMATCH')
    desired_q = np.array([.18, .64, .40, .20, .35, -.12])
    source_q = desired_q + np.array([-.03, .022, .014, -.018, .02, -.035])
    reference = solver.fk(desired_q)
    spec = mj.MjSpec.from_file(str(mjcf))
    site_name = solver.model.body(solver.model.site_bodyid[solver.site_id]).name
    site_quat = solver.model.site_quat[solver.site_id].copy()
    cam_quat = np.empty(4)
    mj.mju_mulQuat(cam_quat, site_quat, np.array([0., 1., 0., 0.]))
    spec.body(site_name).add_camera(name='evaluation-wrist', pos=solver.model.site_pos[solver.site_id], quat=cam_quat, fovy=46.)
    for index, (point, color) in enumerate(zip(POINTS, COLORS)):
        position = reference[:3, :3] @ point + reference[:3, 3]
        material = spec.add_material(name=f'eval-marker-{index}')
        material.rgba = np.append(color, 1.)
        material.emission = .8
        spec.worldbody.add_geom(name=f'eval-point-{index}', type=mj.mjtGeom.mjGEOM_SPHERE,
                                size=[.003, 0., 0.], pos=position, material=material.name, contype=0, conaffinity=0)
    model = spec.compile()
    # 固定标定工位启用模型重力补偿，三组使用同一原生动力学与位置执行器。
    model.body_gravcomp[1:] = 1.
    actuators = [model.actuator(f'joint{i}').id for i in range(1, 7)]
    gripper = model.actuator('gripper').id
    width, height = 320, 240
    f = height / (2 * math.tan(math.radians(23)))
    ibvs = Ibvs(f, f, (width - 1) / 2, (height - 1) / 2, gain=.9, convergence_tol_px=1.5)
    eye = np.eye(4)
    camera = mj.MjvCamera()
    camera.lookat[:] = reference[:3, 3]
    camera.azimuth, camera.elevation, camera.distance = 127., -32., .75
    results = {}

    with mj.Renderer(model, height=height, width=width) as renderer:
        def initial(q):
            data = mj.MjData(model)
            data.qpos[indexes] = q
            data.ctrl[actuators] = q
            data.ctrl[gripper] = .034
            mj.mj_forward(model, data)
            return data

        _, goal_image, target = observe(renderer, initial(desired_q), 0)
        if target is None:
            raise RuntimeError('YAM_IBVS_REFERENCE_FEATURES_MISSING')
        Image.fromarray(goal_image).save(out/'reference.png')
        for mode in ('hold', 'feedback', 'freeze', 'unreachable'):
            data = initial(source_q)
            traces, frames = [], []
            previous_step = -1
            command_count = 0
            reason = 'iteration-budget'
            frozen = None
            peak = 0.
            for turn in range(passes):
                source = frozen if mode == 'freeze' and frozen is not None else observe(renderer, data, turn)
                if frozen is None:
                    frozen = source
                stamp, rgb, features = source
                renderer.update_scene(data, camera=camera)
                view = Image.new('RGB', (width * 2, height))
                view.paste(Image.fromarray(renderer.render().copy()), (0, 0))
                view.paste(Image.fromarray(rgb), (width, 0))
                frames.append(view)
                if stamp <= previous_step:
                    reason = 'stale-frame'
                    traces.append({'turn': turn, 'cameraFrame': stamp, 'reason': reason, 'commands': command_count})
                    break
                previous_step = stamp
                if features is None:
                    reason = 'feature-lost'
                    traces.append({'turn': turn, 'cameraFrame': stamp, 'reason': reason, 'commands': command_count})
                    break
                measured = ibvs.compute_step(features[:, 0], features[:, 1], features[:, 2], target[:, 0], target[:, 1], eye)
                now_q = data.qpos[indexes].copy()
                now = solver.fk(now_q)
                residual = measured['pixel_error_rms_px']
                rank = int(np.linalg.matrix_rank(ibvs.interaction_matrix(features[:, 0], features[:, 1], features[:, 2])))
                receipt = {'turn': turn, 'cameraFrame': stamp, 'simTimeS': float(data.time), 'errorPx': residual,
                           'interactionRank': rank, 'poseError': independent_pose_error(now, reference)}
                traces.append(receipt)
                if rank != 6:
                    reason = 'feature-rank-loss'
                    break
                if mode != 'hold':
                    if residual <= 1.5:
                        reason = 'converged'
                        break
                    goal = now @ ibvs.se3_exp(measured['v_ee'], .36)
                    if mode == 'unreachable':
                        # 验收反例只向相同的 IK 门提交一次不可达计划，不发送仿真关节命令。
                        goal[:3, 3] += np.array([2., 0., 0.])
                        receipt['requestedUnreachablePose'] = goal.tolist()
                    try:
                        commanded = solver.solve(goal, q_seed=now_q, max_iters=130, pos_tol_m=.0015, ori_tol_rad=.014)
                    except (RuntimeError, ValueError) as error:
                        reason = 'ik-unreachable'
                        receipt['detail'] = str(error)
                        break
                    if float(np.max(np.abs(commanded - now_q))) > .16:
                        reason = 'joint-step-limit'
                        break
                    if mode == 'unreachable':
                        raise RuntimeError('YAM_IBVS_UNREACHABLE_CONTROL_ACCEPTED')
                    receipt['commandQ'] = commanded.tolist()
                    receipt['bodyTwist'] = measured['v_ee'].tolist()
                    data.ctrl[actuators] = commanded
                    command_count += 1
                for _ in range(max(1, round(.24 / model.opt.timestep))):
                    mj.mj_step(model, data)
                    if data.ncon:
                        forces = np.zeros(6)
                        for index in range(data.ncon):
                            mj.mj_contactForce(model, data, index, forces)
                            peak = max(peak, float(np.linalg.norm(forces[:3])))
                    if peak > 120:
                        reason = 'contact-limit'
                        break
                if reason == 'contact-limit':
                    break
            path = out/f'{mode}.gif'
            frames[0].save(path, save_all=True, append_images=frames[1:], duration=100, loop=0)
            with (out/f'{mode}.json').open('w', encoding='utf-8') as stream:
                json.dump(traces, stream, ensure_ascii=False, allow_nan=False, indent=2)
            errors = [row['errorPx'] for row in traces if 'errorPx' in row]
            results[mode] = {'reason': reason, 'commands': command_count, 'initialErrorPx': errors[0] if errors else None,
                             'finalErrorPx': errors[-1] if errors else None, 'simStepTimeS': float(data.time),
                             'peakContactN': peak, 'trace': f'{mode}.json', 'recording': path.name}
    return {'robot': 'YAM', 'model': str(mjcf.name), 'simulation': 'mujoco-native-actuator', 'gravityCompensation': True, 'modes': results, 'reference': 'reference.png'}
