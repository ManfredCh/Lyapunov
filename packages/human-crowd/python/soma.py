"""将 Lyapunov 的人体姿态约束送入本地 SOMA，并把结果转换成原骨架的一次性片段。"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'sim-mujoco' / 'python'))
import human

MODEL = 'nvidia/MotionBricks'
REVISION = '3cb362d9b95aa40462abcb4d8cfae9ffb6d97410'
EXPORTER_REVISION = '54fc563aeaaf819a753d72cc9fdc6713989cdd43'
RIG = json.loads(Path(__file__).with_name('soma-rig.json').read_text())
MODEL_JOINTS = RIG['modelJoints']
FRAMES_PER_SECOND = 30
IDENTITY = np.array([1., 0., 0., 0.])
MODEL_ROLES = {
    'Hips': 'pelvis', 'Spine1': 'spine', 'Chest': 'chest', 'Neck1': 'neck', 'Head': 'head',
    **{side + model: side.lower() + role for side in ('Left', 'Right') for model, role in
       zip(('Arm', 'ForeArm', 'Hand', 'Leg', 'Shin', 'Foot', 'ToeBase'),
           ('Shoulder', 'Elbow', 'Wrist', 'Hip', 'Knee', 'Ankle', 'Toe'))},
}
Z_TO_Y = np.array([[1., 0., 0.], [0., 0., 1.], [0., -1., 0.]])


def model_manifest(directory):
    path = Path(directory) / 'soma.json'
    try:
        manifest = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        raise ValueError(f'SOMA_MODEL_UNAVAILABLE: {path} · {error}') from error
    expected = dict(schema=1, model=MODEL, revision=REVISION, exporterRevision=EXPORTER_REVISION, precision='fp32')
    digest = manifest.get('sha256', '')
    if manifest.get('endpoint') not in ('https://huggingface.co', 'https://hf-mirror.com') or not isinstance(
            digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest) or any(
            manifest.get(key) != value for key, value in expected.items()) or manifest.get('file') != f'soma-{digest}.onnx':
        raise ValueError('SOMA_MODEL_MANIFEST_INVALID: 需要由固定检查点导出的 FP32 模型')
    model = path.parent / manifest['file']
    try:
        with model.open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    except OSError as error:
        raise ValueError(f'SOMA_MODEL_UNAVAILABLE: {model} · {error}') from error
    if model.stat().st_size != manifest.get('bytes') or actual != digest:
        raise ValueError(f'SOMA_MODEL_INTEGRITY_FAILED: {model}')
    return manifest, model


def matrix(quaternion):
    result = np.empty(9)
    human.mj.mju_quat2Mat(result, quaternion)
    return result.reshape(3, 3)


def quaternion(rotation):
    result = np.empty(4)
    human.mj.mju_mat2Quat(result, np.ascontiguousarray(rotation).reshape(9))
    return result


def yaw_y(angle):
    c, s = math.cos(angle), math.sin(angle)
    return np.array([[c, 0., s], [0., 1., 0.], [-s, 0., c]])


def hip_heading(right, left):
    across = right - left
    horizontal = np.hypot(across[..., 0], across[..., 2])
    return np.where(horizontal > 1e-6, np.arctan2(across[..., 2], -across[..., 0]), 0.)


def fk(parents, offsets, rotations):
    p, r = offsets.copy(), rotations.copy()
    for i, parent in enumerate(parents):
        if parent >= 0:
            p[i] = p[parent] + r[parent] @ p[i]
            r[i] = r[parent] @ r[i]
    return p, r


def local_from_world(parents, positions, rotations):
    p, r = positions.copy(), rotations.copy()
    for i, parent in enumerate(parents):
        if parent >= 0:
            inverse = rotations[parent].T
            p[i] = inverse @ (positions[i] - positions[parent])
            r[i] = inverse @ rotations[i]
    return p, r


class RigBridge:
    def __init__(self, definition):
        self.actor_names = [joint['name'] for joint in definition['rig']]
        self.actor_parents = [self.actor_names.index(joint['parent']) if joint.get('parent') else -1
                              for joint in definition['rig']]
        self.actor_offsets = np.asarray([joint['offsetM'] for joint in definition['rig']])
        self.actor_rotations = np.stack([matrix(human.wxyz(joint['quaternionXyzw'])) for joint in definition['rig']])
        self.actor_base_p, self.actor_base_r = fk(self.actor_parents, self.actor_offsets, self.actor_rotations)

        self.model_names, self.model_parents, model_offsets, model_rotations = zip(*RIG['rest'])
        self.model_offsets = np.asarray(model_offsets)
        self.model_rotations = np.stack([matrix(human.wxyz(q)) for q in model_rotations])
        self.model_base_p, self.model_base_r = fk(self.model_parents, self.model_offsets, self.model_rotations)
        self.model_indices = [self.model_names.index(name) for name in MODEL_JOINTS]
        try:
            self.map = {self.model_names.index(name): self.actor_names.index(definition['boneMapping'][role])
                        for name, role in MODEL_ROLES.items()}
        except (KeyError, ValueError) as error:
            raise ValueError(f'SOMA_RIG_UNMAPPED: {error}') from error
        if len(set(self.map.values())) != len(self.map):
            raise ValueError('SOMA_RIG_UNMAPPED: 语义骨映射须唯一')
        self.actor_root = self.map[0]
        self.model_left, self.model_right = (self.model_names.index(name) for name in ('LeftLeg', 'RightLeg'))
        model_heading = hip_heading(self.model_base_p[self.model_right], self.model_base_p[self.model_left])
        actor_heading = hip_heading(Z_TO_Y @ self.actor_base_p[self.map[self.model_right]],
                                    Z_TO_Y @ self.actor_base_p[self.map[self.model_left]])
        self.to_model = yaw_y(model_heading - actor_heading) @ Z_TO_Y
        def leg_length(positions, indices):
            return float(np.linalg.norm(np.diff(positions[indices], axis=0), axis=1).sum())
        leg = [self.model_names.index(name) for name in ('LeftLeg', 'LeftShin', 'LeftFoot')]
        actor_leg = leg_length(self.actor_base_p, [self.map[i] for i in leg])
        if actor_leg < .1:
            raise ValueError('SOMA_RIG_UNMAPPED: 角色下肢骨长度不足')
        self.scale = leg_length(self.model_base_p, leg) / actor_leg

    def actor_guide(self, poses):
        return (np.stack([poses[name][0] for name in self.actor_names]),
                np.stack([matrix(poses[name][1]) for name in self.actor_names]))

    def model_guide(self, pose):
        p, r = pose
        positions, rotations = self.model_offsets.copy(), self.model_rotations.copy()
        c = self.to_model
        positions[0] = self.model_base_p[0] + self.scale * c @ (p[self.actor_root] - self.actor_base_p[self.actor_root])
        for joint, parent in enumerate(self.model_parents):
            if parent >= 0:
                positions[joint] = positions[parent] + rotations[parent] @ positions[joint]
                rotations[joint] = rotations[parent] @ rotations[joint]
            if joint in self.map:
                actor = self.map[joint]
                rotations[joint] = c @ r[actor] @ self.actor_base_r[actor].T @ c.T @ self.model_base_r[joint]
        return positions[self.model_indices], rotations[self.model_indices]

    def actor_prediction(self, model_root, model_rotations):
        by_model_index = {joint: model_rotations[i] for i, joint in enumerate(self.model_indices)}
        desired = {actor: self.to_model.T @ by_model_index[joint] @ self.model_base_r[joint].T @ self.to_model @ self.actor_base_r[actor]
                   for joint, actor in self.map.items()}
        root_p = self.actor_base_p[self.actor_root] + self.to_model.T @ (model_root - self.model_base_p[0]) / self.scale
        p, r = self.actor_offsets.copy(), self.actor_rotations.copy()
        world_p, world_r = p.copy(), r.copy()
        for i, parent in enumerate(self.actor_parents):
            if parent >= 0:
                world_p[i] = world_p[parent] + world_r[parent] @ p[i]
                world_r[i] = world_r[parent] @ r[i]
            if i == self.actor_root:
                world_p[i] = root_p
                p[i] = world_r[parent].T @ (root_p - world_p[parent]) if parent >= 0 else root_p
            if i in desired:
                world_r[i] = desired[i]
                r[i] = world_r[parent].T @ world_r[i] if parent >= 0 else world_r[i]
        return p, r


def features(bridge, context, target, tokens):
    guides = [bridge.model_guide(row) for row in context + target + [target[-1]] * (4 - len(target))]
    p = np.stack([row[0] for row in guides])
    r = np.stack([row[1] for row in guides])
    right, left = (MODEL_JOINTS.index(name) for name in ('RightLeg', 'LeftLeg'))
    origin = p[3, 0].copy()
    origin[1] = 0.
    aligned_to_model = yaw_y(hip_heading(p[3, right], p[3, left]) - math.pi / 2)
    p = (p - origin) @ aligned_to_model
    r = aligned_to_model.T @ r
    heading = hip_heading(p[:, right], p[:, left])
    root = p[:, 0]
    next_index = np.array([1, 2, 3, 3, 5, 6, 7, 7])
    diff = heading[next_index] - heading
    horizontal = root.copy()
    horizontal[:, 1] = 0.
    root_mask = (np.arange(8) < 4 + len(target)).astype(np.int32)
    velocity_mask = root_mask.copy()
    velocity_mask[[3, 3 + len(target)]] = 0
    inputs = {
        'global_root_values': np.column_stack([root, np.cos(heading), np.sin(heading)]),
        'local_root_values': np.column_stack([np.arctan2(np.sin(diff), np.cos(diff)) * 30,
                                             (root[next_index][:, [0, 2]] - root[:, [0, 2]]) * 30, root[:, 1]]),
        'local_poses': np.concatenate([(p[:, 1:] - horizontal[:, None]).reshape(8, 87),
                                       r[..., :2].swapaxes(-1, -2).reshape(8, 180)], axis=1),
    }
    return ({**{name: value[None].astype(np.float32) for name, value in inputs.items()},
             'has_global_root_values': root_mask[None], 'has_local_root_values': velocity_mask[None],
             'has_local_poses': root_mask[None],
             'allowed_pred_num_tokens': np.isin(np.arange(6, 17), tokens)[None].astype(np.int32)},
            origin, aligned_to_model)


def decode_rotations(rotation_features):
    cols = rotation_features.reshape(-1, 30, 2, 3)
    x = cols[:, :, 0]
    x_norm = np.linalg.norm(x, axis=-1, keepdims=True)
    z = np.cross(x, cols[:, :, 1])
    z_norm = np.linalg.norm(z, axis=-1, keepdims=True)
    if np.any(x_norm < 1e-8) or np.any(z_norm < 1e-8):
        raise ValueError('SOMA_OUTPUT_INVALID: 旋转基向量退化')
    x, z = x / x_norm, z / z_norm
    return np.stack([x, np.cross(z, x), z], axis=-1)


def corrections(bridge, predictions, start, end):
    positions, rotations = (np.stack(items) for items in zip(*predictions))
    start_p, start_r = local_from_world(bridge.actor_parents, *start)
    end_p, end_r = local_from_world(bridge.actor_parents, *end)
    t = np.linspace(0., 1., len(positions))
    p = positions + (1 - t[:, None, None]) * (start_p - positions[0]) + t[:, None, None] * (end_p - positions[-1])
    q0 = np.stack([quaternion(r) for r in start_r @ rotations[0].transpose(0, 2, 1)])
    q1 = np.stack([quaternion(r) for r in end_r @ rotations[-1].transpose(0, 2, 1)])
    q1 = np.where((np.sum(q0 * q1, axis=-1) < 0)[:, None], -q1, q1)
    q = (1 - t[:, None, None]) * q0 + t[:, None, None] * q1
    q /= np.linalg.norm(q, axis=-1, keepdims=True)
    corrected = np.stack([matrix(item) for item in q.reshape(-1, 4)]).reshape(rotations.shape) @ rotations
    return p, corrected


class SomaGenerator:
    def __init__(self, directory):
        self.manifest, path = model_manifest(directory)
        try:
            import onnxruntime as ort
        except ImportError as error:
            raise ValueError('SOMA_RUNTIME_UNAVAILABLE: 需要可选环境中的 onnxruntime') from error
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        self.session = ort.InferenceSession(str(path), sess_options=options, providers=['CPUExecutionProvider'])

    def generate(self, bridge, context, target, tokens):
        if len(context) != 4 or not 1 <= len(target) <= 4 or not tokens or any(
                isinstance(t, bool) or not isinstance(t, int) or not 6 <= t <= 16 for t in tokens):
            raise ValueError('SOMA_INPUT_INVALID: 上下文须 4 帧、目标 1–4 帧、token 须在 6–16')
        inputs, origin, alignment = features(bridge, context, target, tokens)
        raw, count = self.session.run(['pred_global_motions', 'pred_num_tokens'], inputs)
        if raw.shape != (1, 64, 366) or count.shape != (1,) or int(count[0]) not in tokens:
            raise ValueError('SOMA_OUTPUT_INVALID: 模型输出形状或 token 数不符')
        values = raw[0, 3:4 * int(count[0]) - 3]
        if not np.all(np.isfinite(values)):
            raise ValueError('SOMA_OUTPUT_INVALID: 有非有限值')
        root = values[:, :3] @ alignment.T + origin
        rotations = alignment @ decode_rotations(values[:, 92:272])
        prediction = [bridge.actor_prediction(p, r) for p, r in zip(root, rotations)]
        return corrections(bridge, prediction, context[-1], target[0])


def pose_selector(cfg, selector):
    available = cfg['_poseRuntime']['clips']
    clip = selector['clip']
    elapsed = float(selector['timeS'])
    if clip not in available or not 0 <= elapsed <= available[clip]['source']['durationS'] + 1e-7:
        raise ValueError(f'SOMA_POSE_SOURCE_INVALID: {clip} @ {elapsed}')
    origin = np.asarray(selector.get('positionM', [0., 0., 0.]), dtype=float)
    yaw = float(selector.get('yawRad', 0.))
    if origin.shape != (3,) or not np.all(np.isfinite(origin)) or not math.isfinite(yaw):
        raise ValueError('SOMA_POSE_PLACEMENT_INVALID')
    q = np.array([math.cos(yaw / 2), 0., 0., math.sin(yaw / 2)])
    return human.pose(cfg, origin, q, elapsed, clip_name=clip, loop=False)


def to_clip(name, bridge, positions, rotations, manifest, sample_times=None):
    times = (np.arange(len(positions)) / FRAMES_PER_SECOND).tolist() if sample_times is None else sample_times
    q = np.stack([quaternion(item) for item in rotations.reshape(-1, 3, 3)]).reshape(
        len(times), len(bridge.actor_names), 4)
    return {
        'name': name, 'durationS': times[-1],
        'tracks': [dict(joint=joint, timesS=times, rotationsXyzw=q[:, i][:, [1, 2, 3, 0]].tolist(), interpolation='LINEAR')
                   for i, joint in enumerate(bridge.actor_names)],
        'translations': [dict(joint=joint, timesS=times, positionsM=positions[:, i].tolist(), interpolation='LINEAR')
                         for i, joint in enumerate(bridge.actor_names)
                         if not np.allclose(positions[:, i], bridge.actor_offsets[i], atol=1e-7, rtol=0)],
        'generation': dict(provider='soma-local', revision=manifest['revision'], modelSha256=manifest['sha256'],
                           fps=FRAMES_PER_SECOND),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['status', 'generate'])
    parser.add_argument('directory')
    args = parser.parse_args()
    if args.operation == 'status':
        manifest, _ = model_manifest(args.directory)
        import onnxruntime
        print(json.dumps(dict(status='prepared', model=manifest, runtime=onnxruntime.__version__)))
        return
    request = json.load(sys.stdin)
    definition = request['definition']
    definition['_poseRuntime'] = human.compile_pose(definition)
    bridge = RigBridge(definition)
    generator = SomaGenerator(args.directory)
    context, target = ([bridge.actor_guide(pose_selector(definition, frame)) for frame in request[key]]
                       for key in ('context', 'target'))
    positions, rotations = generator.generate(bridge, context, target, request['allowedTokens'])
    print(json.dumps(to_clip(request['name'], bridge, positions, rotations, generator.manifest), allow_nan=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        sys.exit(str(error))
