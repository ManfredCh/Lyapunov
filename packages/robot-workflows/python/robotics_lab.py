"""Offline robotics operations launched by the existing Lyapunov Jobs plugin."""
import argparse
import dataclasses
from datetime import datetime, timezone
import hashlib
from importlib.util import find_spec
import json
from pathlib import Path
import re
import stat
import sys
import xml.etree.ElementTree as ET


DEPENDENCIES = {
    'mjcf-audit': ('mujoco', 'numpy', 'absl', 'PIL', 'scipy', 'trimesh'),
    'showcase': ('mujoco', 'numpy', 'absl', 'PIL'),
    'object-plan': ('mujoco', 'numpy', 'PIL'),
    'arm-plan': ('mujoco', 'numpy', 'PIL'),
    'rgb-localize': ('numpy',),
    'vision-transfer-plan': ('mujoco', 'numpy', 'PIL'),
    'ibvs-step': ('numpy',),
    'yam-ibvs': ('mujoco', 'numpy', 'PIL', 'mink', 'daqp'),
    'handeye-fit': ('numpy',),
    'yam-ik': ('mujoco', 'numpy'),
    'fr3-duo-check': ('mujoco', 'numpy'),
    'playground-camera': ('mujoco', 'numpy'),
    'gauntlet-schedule': ('numpy',),
    'rl-audit': (),
    'mcap-export': ('mcap',),
    'hardware-inventory': (),
    'probe': (),
}


def missing_for(operation):
    return [package for package in DEPENDENCIES[operation] if find_spec(package) is None]


def json_default(value):
    if hasattr(value, 'tolist'):
        return value.tolist()
    raise TypeError(f'不能序列化 {type(value).__name__}')


def encode(value):
    return json.dumps(value, default=json_default, allow_nan=False, ensure_ascii=False)


def workspace_file(workspace, filename):
    path = (workspace / filename).resolve(strict=True)
    if not path.is_relative_to(workspace) or not path.is_file():
        raise ValueError(f'ROBOTICS_INPUT_OUTSIDE_WORKSPACE: {filename}')
    return path


def checked_mjcf(workspace, path):
    # MuJoCo reads transitive assets by filename. Check those paths before
    # compilation, including the effective compiler directories of includes.
    if not path.is_relative_to(workspace):
        raise ValueError('ROBOTICS_INPUT_OUTSIDE_WORKSPACE')
    # Keep recursive inputs within the explicitly selected asset's directory.
    workspace = path.parent
    roots = {}
    pending = [path]
    seen = set()
    while pending:
        current = pending.pop()
        if current in seen:
            continue
        seen.add(current)
        root = ET.parse(current).getroot()
        roots[current] = root
        for item in root.iter('include'):
            pending.append(workspace_file(workspace, current.parent / item.attrib['file']))
    directories = {'mesh': {path.parent}, 'texture': {path.parent}}
    for current, root in roots.items():
        for item in root.iter('compiler'):
            if item.get('strippath') in ('true', '1'):
                raise ValueError('ROBOTICS_MJCF_STRIPPATH_UNSUPPORTED')
            for kind in directories:
                raw = item.get(f'{kind}dir', item.get('assetdir'))
                if raw is None:
                    continue
                for base in {path.parent, current.parent}:
                    direct = (base / raw).resolve()
                    if Path(raw).is_absolute() or not direct.is_relative_to(workspace):
                        raise ValueError('ROBOTICS_MJCF_ASSET_DIR_OUTSIDE_WORKSPACE')
                    directories[kind].add(direct)
    for current, root in roots.items():
        for item in root.iter():
            if item.tag in ('plugin', 'model', 'attach'):
                raise ValueError(f'ROBOTICS_MJCF_EXTENSION_UNSUPPORTED: {item.tag}')
            for key, filename in item.attrib.items():
                if (key != 'file' and not key.startswith('file')) or item.tag == 'include':
                    continue
                if Path(filename).is_absolute() or '..' in Path(filename).parts or '://' in filename:
                    raise ValueError(f'ROBOTICS_MJCF_ASSET_OUTSIDE_WORKSPACE: {filename}')
                candidates = {(base / filename) for base in directories.get(item.tag, set()) | {current.parent, path.parent}}
                for candidate in candidates:
                    if not candidate.resolve().is_relative_to(workspace):
                        raise ValueError(f'ROBOTICS_MJCF_ASSET_OUTSIDE_WORKSPACE: {filename}')
                if not any(candidate.is_file() for candidate in candidates):
                    raise ValueError(f'ROBOTICS_MJCF_ASSET_MISSING: {filename}')
    return path


def array(value, shape, label):
    import numpy as np
    result = np.asarray(value, dtype=float)
    if result.shape != shape or not np.isfinite(result).all():
        raise ValueError(f'ROBOTICS_INPUT_INVALID: {label} 需要有限数值及形状 {shape}')
    return result


def transform(value, label):
    import numpy as np
    pose = array(value, (4, 4), label)
    rot = pose[:3, :3]
    if not np.allclose(pose[3], [0, 0, 0, 1]) or not np.allclose(rot.T @ rot, np.eye(3), atol=1e-5) or np.linalg.det(rot) <= 0:
        raise ValueError(f'ROBOTICS_INPUT_INVALID: {label} 需要刚体变换')
    return pose


def points(value, dimension, label, minimum=1, maximum=2048):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise ValueError(f'ROBOTICS_INPUT_INVALID: {label} 需要 {minimum}–{maximum} 行')
    return array(value, (len(value), dimension), label)


def camera(value):
    intrinsics = array(value['intrinsics'], (3, 3), 'intrinsics')
    if min(intrinsics[0, 0], intrinsics[1, 1]) <= 0 or list(intrinsics[2]) != [0, 0, 1]:
        raise ValueError('ROBOTICS_INPUT_INVALID: intrinsics')
    return intrinsics, transform(value['worldFromCamera'], 'worldFromCamera')


def rgb_localize(req, source):
    from agy import rgb_localization as rgb
    mode = req.get('mode')
    if mode == 'triangulate':
        first, second = req['views']
        k1, t1 = camera(first)
        k2, t2 = camera(second)
        uv1 = points(first['pixels'], 2, 'views[0].pixels')
        uv2 = points(second['pixels'], 2, 'views[1].pixels')
        if len(uv1) != len(uv2) or sum((t1[:3, 3] - t2[:3, 3]) ** 2) < 1e-8:
            raise ValueError('ROBOTICS_INPUT_INVALID: 需要成对像点和非零双视角基线')
        result = rgb.triangulate_matched_points(k1, t1, uv1, k2, t2, uv2)
    elif mode == 'plane-mask':
        import numpy as np
        from PIL import Image
        if source is None:
            raise ValueError('ROBOTICS_INPUT_INVALID: 平面定位需要 sourcePath 掩膜')
        k, t = camera(req['camera'])
        plane_z = float(req['planeZM'])
        if not -100 <= plane_z <= 100:
            raise ValueError('ROBOTICS_INPUT_INVALID: planeZM')
        with Image.open(source) as image:
            if image.width * image.height > 8_000_000:
                raise ValueError('ROBOTICS_INPUT_INVALID: 掩膜尺寸过大')
            mask = np.asarray(image.convert('L'))
        result = rgb.ray_plane_contour_pose(mask, k, t, plane_z)
        if result is None:
            return {'localized': False, 'mode': mode, 'reason': 'no_valid_contour'}
    elif mode == 'homography':
        uv = points(req['pixels'], 2, 'pixels', minimum=4)
        xy = array(req['worldXY'], uv.shape, 'worldXY')
        result = {'homography': rgb.fit_plane_homography(uv, xy)}
    else:
        raise ValueError('ROBOTICS_INPUT_INVALID: RGB 定位模式')
    return {'localized': mode != 'homography', 'mode': mode, 'geometry': result}


def ibvs_step(req):
    from agy.ibvs import Ibvs
    current = points(req['pixels'], 2, 'pixels')
    target = array(req['goalPixels'], current.shape, 'goalPixels')
    depth = array(req['depthM'], (len(current),), 'depthM')
    if min(depth) <= 0:
        raise ValueError('ROBOTICS_INPUT_INVALID: depthM 必须为正')
    k = array(req['intrinsics'], (3, 3), 'intrinsics')
    extrinsic = transform(req['eeFromCamera'], 'eeFromCamera')
    if min(k[0, 0], k[1, 1]) <= 0:
        raise ValueError('ROBOTICS_INPUT_INVALID: fx/fy 必须为正')
    solver = Ibvs(k[0, 0], k[1, 1], k[0, 2], k[1, 2])
    result = solver.compute_step(current[:, 0], current[:, 1], depth, target[:, 0], target[:, 1], extrinsic)
    return {'computed': True, 'executed': False,
            'pixelErrorRmsPx': result['pixel_error_rms_px'], 'converged': result['converged'],
            'cameraTwist': result['v_cam'], 'eeTwist': result['v_ee']}


def localization_report(req, source, out):
    result = rgb_localize(req, source)
    (out / 'localization.json').write_text(encode(result), encoding='utf-8')
    geometry = {key: value for key, value in result.get('geometry', {}).items() if key != 'inliers_3d_m'}
    return {**result, 'geometry': geometry, 'artifact': 'localization.json'}


def handeye_fit(req, out):
    from agy.projective_handeye import fit_projective_handeye
    xyz = points(req['worldPoints'], 3, 'worldPoints', minimum=8)
    uv = array(req['pixels'], (len(xyz), 2), 'pixels')
    import numpy as np
    if np.linalg.matrix_rank(xyz - xyz.mean(axis=0)) != 3:
        raise ValueError('ROBOTICS_INPUT_INVALID: 投影标定需要非共面的三维样本')
    samples = [dict(pose_idx=i, tip_xyz_m=point, marker_uv_px=pixel) for i, (point, pixel) in enumerate(zip(xyz, uv))]
    regularization = float(req.get('regularization', 500))
    if not 0 <= regularization <= 100000:
        raise ValueError('ROBOTICS_INPUT_INVALID: regularization')
    fitted = fit_projective_handeye(samples, reg_lambda=regularization)
    (out / 'calibration.json').write_text(encode(fitted), encoding='utf-8')
    return {**{key: value for key, value in fitted.items() if key != 'per_pose_errors'}, 'artifact': 'calibration.json'}


def modeled_scene(req, planner):
    scene = planner.Scene3D()
    obstacles = req.get('obstacles', [])
    if not isinstance(obstacles, list) or len(obstacles) > 64:
        raise ValueError('ROBOTICS_INPUT_INVALID: obstacles 最多 64 项')
    names = set()
    for entry in obstacles:
        name = entry['name']
        if not isinstance(name, str) or not name or name in names:
            raise ValueError('ROBOTICS_INPUT_INVALID: 障碍物名称必须唯一')
        names.add(name)
        center = array(entry['center'], (3,), 'center')
        half = array(entry['halfExtents'], (3,), 'halfExtents')
        if min(half) <= 0:
            raise ValueError('ROBOTICS_INPUT_INVALID: halfExtents 必须为正')
        scene.add_aligned_box(name, center, half)
    return scene


def payload(entry, planner):
    spheres = entry['spheres']
    if not isinstance(spheres, list) or not 1 <= len(spheres) <= 64:
        raise ValueError('ROBOTICS_INPUT_INVALID: spheres 需要 1–64 项')
    obj = planner.MultiSphereObject()
    for sphere in spheres:
        radius = float(sphere['radius'])
        if not 0 < radius <= 2:
            raise ValueError('ROBOTICS_INPUT_INVALID: radius')
        obj.add_sphere(array(sphere['center'], (3,), 'sphere.center'), radius)
    return obj


def bounded_seed(req):
    seed = req.get('seed', 1)
    if type(seed) is not int or not 0 <= seed < 2**32:
        raise ValueError('ROBOTICS_INPUT_INVALID: seed')
    return seed


def plan(req, mjcf, operation, out):
    from agy import motion_planner as planner
    scene = modeled_scene(req, planner)
    seed = bounded_seed(req)
    if operation == 'object-plan':
        obj = payload(req, planner)
        start = array(req['start'], (6,), 'start')
        goal = array(req['goal'], (6,), 'goal')
        direct = planner.check_se3_segment(obj, scene, start, goal, step_size=0.01)
        result = planner.plan_object_se3(obj, scene, start, goal, seed=seed, max_time_ms=3000)
        path = result['waypoints']
        segments = [planner.check_se3_segment(obj, scene, a, b, step_size=0.01) for a, b in zip(path, path[1:])]
    else:
        joint_names = req['jointNames']
        if not isinstance(joint_names, list) or not 1 <= len(joint_names) <= 16 or not all(isinstance(name, str) and name for name in joint_names) or len(set(joint_names)) != len(joint_names):
            raise ValueError('ROBOTICS_INPUT_INVALID: jointNames')
        arm = planner.RobotArmPlanner(mjcf_path=str(mjcf), arm=req.get('arm', 'left'),
                                      joint_names=joint_names, ee_site_name=req['tcpSite'])
        start = array(req['start'], (len(joint_names),), 'start')
        goal = array(req['goal'], (len(joint_names),), 'goal')
        if 'payload' in req:
            obj = payload(req['payload'], planner)
            arm.attach_object(obj, transform(req['payload']['eeFromObject'], 'eeFromObject'))
        direct = arm.check_arm_segment(scene, start, goal)
        result = arm.plan_arm(scene, start, goal, seed=seed, max_time_ms=3000)
        path = result['waypoints']
        segments = [arm.check_arm_segment(scene, a, b) for a, b in zip(path, path[1:])]
    verified = bool(result['solved'] and (len(path) > 1 or len(path) == 1 and bool((start == goal).all())) and all(row['valid'] for row in segments))
    (out / 'trajectory.json').write_text(encode({'reference': direct, 'plan': result, 'segmentChecks': segments}), encoding='utf-8')
    return {'solved': bool(result['solved']), 'sampledPathValid': verified, 'direction': operation,
            'directPathValid': bool(direct['valid']), 'waypoints': len(path), 'reason': result.get('reason'),
            'executed': False, 'artifact': 'trajectory.json'}


def vision_transfer_plan(req, source, out):
    vision = rgb_localize(req['localization'], source)
    if not vision['localized']:
        return {'localization': vision, 'trajectory': None, 'executed': False}
    position = vision['geometry'].get('center_3d_m')
    if position is None:
        position = [vision['geometry'][field] for field in ('x_m', 'y_m', 'z_m')]
    geometry = req['transfer']
    start_angles = array(geometry.get('startAngles', [0, 0, 0]), (3,), 'startAngles')
    start = [*position, *start_angles]
    trajectory = plan({**geometry, 'start': start}, None, 'object-plan', out)
    (out / 'localization.json').write_text(encode(vision), encoding='utf-8')
    return {'localizedStartM': position, 'localizationArtifact': 'localization.json',
            'trajectory': trajectory, 'executed': False}


def yam_ik(req, mjcf):
    import numpy as np
    from agy.yam_ik import YamIk
    solver = YamIk(xml_path=str(mjcf), site_name=req['tcpSite'])
    if solver.arm_dof != 6 or not np.array_equal(solver.model.jnt_qposadr[:6], np.arange(6)):
        raise ValueError('ROBOTICS_INPUT_INVALID: YAM 前六个关节需按 MJCF 单自由度顺序排列')
    q = array(req['start'], (6,), 'start')
    for j in range(6):
        if solver.model.jnt_limited[j] and not solver.model.jnt_range[j, 0] <= q[j] <= solver.model.jnt_range[j, 1]:
            raise ValueError(f'ROBOTICS_YAM_JOINT_OUT_OF_RANGE: {solver.model.joint(j).name}')
    goal = transform(req['target'], 'target')
    solution = solver.solve(goal, q_seed=q)
    measured = solver.fk(solution)
    rel_rot = goal[:3, :3].T @ measured[:3, :3]
    position_error = float(np.linalg.norm(measured[:3, 3] - goal[:3, 3]))
    angle_error = float(np.arccos(np.clip((np.trace(rel_rot) - 1) / 2, -1, 1)))
    return {'outputJoints': solution, 'positionErrorM': position_error, 'orientationErrorRad': angle_error,
            'solved': position_error <= 0.002 and angle_error <= 0.01, 'executed': False}


def fr3_duo_check(req, mjcf):
    import mujoco
    import numpy as np
    model = mujoco.MjModel.from_xml_path(str(mjcf))
    data = mujoco.MjData(model)

    def read_arm(side):
        arm = req[side]
        root = model.body(arm['rootBody']).id
        children = set()
        for body in range(1, model.nbody):
            if body == root or model.body_parentid[body] in children:
                children.add(body)
        names = arm['jointNames']
        if root == 0 or not isinstance(names, list) or len(names) != 7 or len(set(names)) != 7:
            raise ValueError('ROBOTICS_INPUT_INVALID: FR3 每臂需要根部和七个关节')
        joints = [model.joint(name).id for name in names]
        if any(model.jnt_bodyid[j] not in children or model.jnt_type[j] != mujoco.mjtJoint.mjJNT_HINGE for j in joints):
            raise ValueError('ROBOTICS_INPUT_INVALID: FR3 关节必须是所选机械臂的铰链')
        points_q = points(arm['positions'], 7, side, minimum=2, maximum=256)
        ranges = model.jnt_range[joints]
        limited = model.jnt_limited[joints].astype(bool)
        if np.any((points_q < ranges[:, 0])[:, limited] | (points_q > ranges[:, 1])[:, limited]):
            raise ValueError(f'ROBOTICS_FR3_JOINT_OUT_OF_RANGE: {side}')
        geoms = [g for g in range(model.ngeom) if model.geom_bodyid[g] in children and (model.geom_contype[g] or model.geom_conaffinity[g])]
        return model.jnt_qposadr[joints], points_q, geoms, children

    left_idx, left_pos, left_geoms, left_bodies = read_arm('left')
    right_idx, right_pos, right_geoms, right_bodies = read_arm('right')
    if left_bodies & right_bodies or len(left_pos) != len(right_pos) or not left_geoms or not right_geoms:
        raise ValueError('ROBOTICS_INPUT_INVALID: 双臂需要相同时间采样且拥有独立碰撞体')
    cap = .10
    worst = None
    samples = 0
    for index in range(len(left_pos) - 1):
        change = max(np.max(np.abs(left_pos[index+1] - left_pos[index])), np.max(np.abs(right_pos[index+1] - right_pos[index])))
        steps = max(1, int(np.ceil(change / .02)))
        if samples + steps > 4000:
            raise ValueError('ROBOTICS_FR3_PATH_TOO_LONG: 最多采样 4000 个间隔')
        for alpha in np.linspace(0., 1., steps+1)[(1 if index else 0):]:
            data.qpos[left_idx] = (1-alpha) * left_pos[index] + alpha * left_pos[index+1]
            data.qpos[right_idx] = (1-alpha) * right_pos[index] + alpha * right_pos[index+1]
            mujoco.mj_forward(model, data)
            samples += 1
            for a in left_geoms:
                for b in right_geoms:
                    if np.linalg.norm(data.geom_xpos[a] - data.geom_xpos[b]) - model.geom_rbound[a] - model.geom_rbound[b] >= cap:
                        continue
                    distance = float(mujoco.mj_geomDistance(model, data, a, b, cap, None))
                    if distance < cap and (worst is None or distance < worst['distanceM']):
                        worst = {'distanceM': distance, 'leftGeomId': a, 'rightGeomId': b, 'sample': samples - 1}
    return {'sampledPathValid': worst is None or worst['distanceM'] >= 0, 'sampleCount': samples,
            'distanceCapM': cap, 'closestPair': worst, 'scope': 'sampled-inter-arm-geometry', 'executed': False}


def schedule(req, out):
    from agy.perturb_spec import TIERS, sample, streams
    seed = bounded_seed(req)
    cases = req.get('casesPerTier', 1)
    task = req.get('taskId')
    if type(cases) is not int or not 1 <= cases <= 32 or not isinstance(task, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', task):
        raise ValueError('ROBOTICS_INPUT_INVALID: taskId 或 casesPerTier')
    result = []
    for tier in TIERS:
        for idx in range(cases):
            rng = streams(seed, task, tier, idx)
            perturbation = dataclasses.asdict(sample(tier, idx, rng.spec))
            digest = hashlib.sha256(encode(perturbation).encode()).hexdigest()
            result.append({'suiteCaseId': f'{tier}-{idx}', 'baseSeed': seed, 'tier': tier, 'sampleIndex': idx,
                           'perturbationSha256': digest, 'perturbation': perturbation})
    (out / 'schedule.json').write_text(encode({'appliedToPhysics': False, 'schedule': result}), encoding='utf-8')
    return {'cases': len(result), 'appliedToPhysics': False, 'artifact': 'schedule.json'}


def playground_camera(req, mjcf):
    import mujoco
    from agy.playground_camera import camera_intrinsics_from_model, camera_world_pose_opencv
    model = mujoco.MjModel.from_xml_path(str(mjcf))
    frame = mujoco.MjData(model)
    width, height = req['width'], req['height']
    if any(type(n) is not int or not 16 <= n <= 4096 for n in (width, height)):
        raise ValueError('ROBOTICS_INPUT_INVALID: 相机尺寸范围 16–4096')
    if 'qpos' in req:
        frame.qpos[:] = array(req['qpos'], (model.nq,), 'qpos')
    mujoco.mj_forward(model, frame)
    cam = model.camera(req['camera']).id
    if model.cam_projection[cam] != mujoco.mjtProjection.mjPROJ_PERSPECTIVE:
        raise ValueError('ROBOTICS_INPUT_INVALID: 只支持针孔相机')
    k, *_ = camera_intrinsics_from_model(model, cam, width, height)
    return {'intrinsics': k, 'worldFromCamera': camera_world_pose_opencv(frame, cam),
            'camera': req['camera'], 'width': width, 'height': height, 'source': 'offline-mjcf-forward'}


def audit_mjcf(req, mjcf, out):
    from agy.audit_scenarios import run_all_scenarios_for_asset, validate_static_and_mesh_hygiene
    static = validate_static_and_mesh_hygiene(str(mjcf))
    report = {'static': static}
    if req.get('dynamic', True) is True:
        dynamic = run_all_scenarios_for_asset(str(mjcf), str(out), label='asset')
        report.update({'scorecard': Path(dynamic['scorecard_json']).name, 'contactSheet': Path(dynamic['contact_sheet_png']).name})
    (out / 'audit.json').write_text(encode(report), encoding='utf-8')
    return {'artifact': 'audit.json', 'contactSheet': report.get('contactSheet'), 'dynamicRequested': req.get('dynamic', True) is True}


def showcase(req, mjcf, out):
    from absl import flags
    from agy.render_showcase_shot import render_6view_inspection_sheet
    size = req.get('panelSize', 256)
    if type(size) is not int or not 120 <= size <= 420:
        raise ValueError('ROBOTICS_INPUT_INVALID: panelSize')
    flags.FLAGS(['robotics_lab'])
    render_6view_inspection_sheet(str(mjcf), str(out / 'showcase.png'), panel_size=size)
    return {'artifact': 'showcase.png', 'views': 28, 'panelPixels': size}


def rl_audit(source, out):
    from agy.rl_task_check import audit_source
    if source.stat().st_size > 1_000_000:
        raise ValueError('ROBOTICS_INPUT_INVALID: RL 源文件限 1 MB')
    findings = audit_source(source.read_text(encoding='utf-8'), source.name)
    (out / 'findings.json').write_text(encode(findings), encoding='utf-8')
    return {'findings': len(findings), 'artifact': 'findings.json', 'trained': False}


def hardware_inventory():
    serial = []
    cameras = []
    can = []
    if sys.platform.startswith('linux') or sys.platform == 'darwin':
        for path in sorted(Path('/dev').iterdir()):
            if re.fullmatch(r'(tty(ACM|USB)\d+|cu\.usb(modem|serial).*)', path.name) and stat.S_ISCHR(path.stat().st_mode):
                serial.append(str(path))
            if re.fullmatch(r'video\d+', path.name) and stat.S_ISCHR(path.stat().st_mode):
                cameras.append(str(path))
    if sys.platform.startswith('linux'):
        for path in sorted(Path('/sys/class/net').iterdir()):
            if (path / 'type').read_text(encoding='utf-8').strip() == '280':
                can.append(path.name)
    return {'platform': sys.platform, 'serialCandidates': serial, 'videoCandidates': cameras, 'canInterfaces': can,
            'sdkModules': {name: find_spec(name) is not None for name in ('lerobot', 'i2rt', 'pylibfranka', 'pyrealsense2')},
            'robotIdentityVerified': False, 'devicesOpened': False, 'commandsSent': False}


def probe():
    packages = ('cv2', 'mujoco_playground', 'reaf', 'torch', 'mink', 'daqp')
    return {'missing': {name: missing_for(name) for name in DEPENDENCIES},
            'optional': {name: find_spec(name) is not None for name in packages}}


def mcap_export(source, out):
    from mcap.writer import Writer
    count = 0
    with source.open('rb') as rows, (out / 'calls.mcap').open('wb') as stream:
        writer = Writer(stream)
        writer.start(profile='lyapunov-agent-graph', library='lyapunov')
        channel = writer.register_channel(topic='lyapunov/campaign/call', message_encoding='json', schema_id=0)
        for count, row in enumerate(rows, 1):
            record = json.loads(row)
            # Publish stored timestamps and order, never invent media or simulator step stamps.
            timestamp = record.get('at')
            if not isinstance(timestamp, str):
                raise ValueError('ROBOTICS_MCAP_TIMESTAMP_MISSING')
            parsed = datetime.fromisoformat(timestamp)
            if parsed.tzinfo is None:
                raise ValueError('ROBOTICS_MCAP_TIMESTAMP_MISSING')
            delta = parsed - datetime(1970, 1, 1, tzinfo=timezone.utc)
            ns = ((delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds) * 1000
            writer.add_message(channel, ns, row.rstrip(b'\r\n'), ns, sequence=count)
        writer.finish()
    if count == 0:
        raise ValueError('ROBOTICS_MCAP_EMPTY')
    return {'messages': count, 'artifact': 'calls.mcap', 'contains': 'campaign-call-artifacts'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=DEPENDENCIES)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--request', type=Path)
    parser.add_argument('--source', type=Path)
    args = parser.parse_args()
    missing = missing_for(args.operation)
    if missing:
        raise SystemExit(f'ROBOTICS_DEPENDENCIES_MISSING: {", ".join(missing)}')
    if args.request and args.request.stat().st_size > 4_000_000:
        raise SystemExit('ROBOTICS_INPUT_INVALID: 请求 JSON 限 4 MB')
    req = json.loads(args.request.read_text(encoding='utf-8')) if args.request else {}
    if not isinstance(req, dict):
        raise SystemExit('ROBOTICS_INPUT_INVALID: 请求必须为 JSON 对象')
    source = args.source
    if source is not None:
        source = workspace_file(args.workspace, source)
    if args.operation in {'arm-plan', 'yam-ik', 'yam-ibvs', 'fr3-duo-check', 'playground-camera', 'mjcf-audit', 'showcase'}:
        source = checked_mjcf(args.workspace, source)
    def yam_feedback():
        from yam_ibvs import rollout
        return rollout(req, source, args.output)

    operations = {
        'mjcf-audit': lambda: audit_mjcf(req, source, args.output),
        'showcase': lambda: showcase(req, source, args.output),
        'object-plan': lambda: plan(req, None, args.operation, args.output),
        'arm-plan': lambda: plan(req, source, args.operation, args.output),
        'rgb-localize': lambda: localization_report(req, source, args.output),
        'vision-transfer-plan': lambda: vision_transfer_plan(req, source, args.output),
        'ibvs-step': lambda: ibvs_step(req),
        'yam-ibvs': yam_feedback,
        'handeye-fit': lambda: handeye_fit(req, args.output),
        'yam-ik': lambda: yam_ik(req, source),
        'fr3-duo-check': lambda: fr3_duo_check(req, source),
        'playground-camera': lambda: playground_camera(req, source),
        'gauntlet-schedule': lambda: schedule(req, args.output),
        'rl-audit': lambda: rl_audit(source, args.output),
        'mcap-export': lambda: mcap_export(source, args.output),
        'hardware-inventory': hardware_inventory,
        'probe': probe,
    }
    summary = operations[args.operation]()
    (args.output / 'result.json').write_text(encode({'operation': args.operation, 'summary': summary}) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
