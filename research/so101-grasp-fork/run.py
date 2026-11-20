"""SO-101 下降前分叉。归档提供轨迹终点与时序，原生运行器从第 0 步重建分叉点。"""

import argparse
import copy
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote, urlparse

os.environ.setdefault('MUJOCO_GL', 'egl')
import mujoco as mj
import numpy as np
from scipy.spatial.transform import Rotation

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'packages/sim-mujoco/python'))
import worker

solver_path = REPO / 'packages/motion-mink/src/solve.py'
spec = importlib.util.spec_from_file_location('lyapunov_mink', solver_path)
solver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(solver)

INTEGRATION = int(mj.mjtState.mjSTATE_INTEGRATION)
JOINTS = ('shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll')
VARIANTS = {'reference': (0., False), 'raised': (.004, False), 'segmented': (0., True), 'raised-segmented': (.004, True)}
CONTACT_GROUPS = ('fixedFinger', 'movingFinger', 'targetSupport', 'armSupport', 'otherTargetArm')


def encoded(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'))


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + '\n', encoding='utf-8')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def load(path):
    return json.loads(path.read_text(encoding='utf-8'))


def historical_actions(episode):
    result = {}
    for action in episode['pick']['actions']:
        kind = action['actionId'].rsplit('-', 1)[-1]
        result[kind] = action
    assert {'open', 'approach', 'descend', 'close', 'lift'} <= result.keys()
    return result


def arm_source(scene):
    arm = next(entity for entity in scene['entities'] if entity['entityId'] == 'arm')
    address = urlparse(arm['resources'][0]['original']['uri'])
    assert address.scheme == 'file' and not address.netloc
    return Path(unquote(address.path))


def verify_source(path, condition):
    xml = path.read_bytes()
    xml_sha = sha(xml)
    meshes = sorted(set(re.findall(r'<mesh [^>]*file="([^"]+)"', xml.decode())))
    mesh_digests = [[name, sha((path.parent/'assets'/name).read_bytes())] for name in meshes]
    assert xml_sha == condition['sourceSha256']
    assert sha(encoded({'sourceSha256': xml_sha, 'sourceMeshDigests': mesh_digests}).encode()) == condition['sourceBundleSha256']


def state_of(world):
    state = np.empty(mj.mj_stateSize(world.model, INTEGRATION))
    mj.mj_getState(world.model, world.data, state, INTEGRATION)
    return state


def state_digest(world):
    return sha(state_of(world).tobytes())


class Video:
    def __init__(self, world, path):
        self.renderer = mj.Renderer(world.model, height=360, width=480)
        self.camera = mj.MjvCamera()
        self.camera.lookat[:] = (.175, 0, .045)
        self.camera.distance = .48
        self.camera.azimuth = 136
        self.camera.elevation = -30
        self.process = subprocess.Popen(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
            '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '480x360', '-r', '20', '-i', '-',
            '-an', '-c:v', 'libx264', '-preset', 'fast', '-threads', '1', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(path)], stdin=subprocess.PIPE)
        self.world = world

    def frame(self):
        self.renderer.update_scene(self.world.data, camera=self.camera)
        self.process.stdin.write(self.renderer.render().tobytes())

    def close(self):
        try:
            self.process.stdin.close()
            if self.process.wait(timeout=30) != 0:
                raise RuntimeError('ffmpeg 编码失败')
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait()
            self.renderer.close()


class Trial:
    def __init__(self, scene, case):
        self.world = worker.World(copy.deepcopy(scene), {'worldId':case, 'timestepS':.002, 'ground':False, 'frameRateHz':.000001})
        self.commands = []
        self.trace = []
        self.video = None
        self.start_step = None
        model = self.world.model
        self.names = [model.geom(i).name for i in range(model.ngeom)]
        self.bodies = [model.body(int(model.geom_bodyid[i])).name for i in range(model.ngeom)]
        self.target = self.world.entities['target']['body']
        self.tcp = model.site('arm/gripperframe').id
        self.shoulder = model.actuator('arm/shoulder_lift').id
        self.shoulder_limit = float(max(map(abs, model.actuator_forcerange[self.shoulder])))
        qaddrs = self.world.entities['arm']['joints']
        self.arm_qpos = [qaddrs[j]['qpos'] for j in JOINTS]

    def describe_frame(self, phase):
        model, data = self.world.model, self.world.data
        force = np.zeros(6)
        grouped = {k: 0. for k in CONTACT_GROUPS}
        points = []
        for i, contact in enumerate(data.contact):
            geoms = [int(g) for g in contact.geom]
            if min(geoms) < 0:
                continue
            names = [self.names[g] for g in geoms]
            arm = next((j for j, name in enumerate(names) if name.startswith('arm/')), None)
            target = next((j for j, name in enumerate(names) if name.startswith('target/')), None)
            support = any(name.startswith('table/') for name in names)
            if arm is not None and target is not None:
                body = self.bodies[geoms[arm]]
                group = 'fixedFinger' if body == 'arm/gripper' else ('movingFinger' if body == 'arm/moving_jaw_so101_v1' else 'otherTargetArm')
            elif arm is not None and support:
                group = 'armSupport'
            elif target is not None and support:
                group = 'targetSupport'
            else:
                continue
            mj.mj_contactForce(model, data, i, force)
            if force[0] > 0.0001:
                grouped[group] += float(force[0])
                points.append([group, *names, float(force[0])])
        return {'step':self.world.step_index, 'phase':phase, 'targetM':data.xpos[self.target].tolist(),
                'tcpM':data.site_xpos[self.tcp].tolist(), 'shoulderForce':float(data.actuator_force[self.shoulder]),
                'normalForceN':grouped, 'contacts':points}

    def advance(self, step, phase):
        if step < self.world.step_index:
            raise ValueError(f'历史步号倒退 {phase} {step}')
        while self.world.step_index < step:
            self.tick(phase)

    def tick(self, phase):
        self.world.tick()
        if self.start_step is not None:
            self.trace.append(self.describe_frame(phase))
            if self.video and (self.world.step_index - self.start_step) % 25 == 0:
                self.video.frame()

    def execute(self, phase, action, timing):
        historic = timing[phase]
        self.advance(historic['startStep'] - 1, f'wait-{phase}')
        command = {'actionId':phase, 'expectedGeneration':self.world.generation, 'entityId':'arm', **action}
        self.commands.append({'step':self.world.step_index + 1, 'request':command})
        self.world.execute(command)
        for _ in range(1000):
            self.tick(phase)
            receipt = self.world.receipts[phase]
            if receipt['status'] == 'completed':
                assert self.world.step_index == historic['endStep'], (phase, self.world.step_index, historic['endStep'])
                return receipt['effect']['motions'][0]
            if receipt['status'] != 'running':
                raise RuntimeError(f'{phase}: {receipt}')
        raise RuntimeError(f'{phase}: 超过动作步数')

    @staticmethod
    def historical_endpoint(timing, phase):
        motion = timing[phase]['effect']['motions'][0]
        return [motion['positionControl'][j]['reference'] for j in JOINTS]

    def trajectory(self, timing, phase):
        return self.trajectory_points([self.historical_endpoint(timing, phase)])

    def trajectory_points(self, targets):
        points = [{'timeS':0., 'positions':self.world.data.qpos[self.arm_qpos].tolist()}]
        points += [{'timeS':.55*(i+1)/len(targets), 'positions':q} for i, q in enumerate(targets)]
        return {'kind':'trajectory', 'jointNames':list(JOINTS), 'points':points, 'settleTimeS':.5, 'partialJointVector':True}

    def plan_descent(self, source, episode, original_endpoint, height, segmented):
        # 复用上一轮保留的实测视觉估计，实验变量限于下降。旋转和偏置与原 SO-101 driver 相同。
        estimate_xy = episode['pick']['effect']['refinement']['observedXY']
        yaw = math.atan2(estimate_xy[1], estimate_xy[0] - .039)
        pose = np.array([estimate_xy[0] + .008*math.cos(yaw), estimate_xy[1] + .008*math.sin(yaw), .014 + height])
        quat = (Rotation.from_euler('z', yaw) * Rotation.from_euler('y', math.pi/2) * Rotation.from_euler('x', .0487)).as_quat().tolist()
        here = self.world.data.site_xpos[self.tcp].copy()
        start = self.world.data.qpos[self.arm_qpos].tolist()
        joints = self.world.entities['arm']['joints']
        ranges = [self.world.model.jnt_range[joints[j]['id']] for j in JOINTS]
        start = [float(np.clip(q, *lim)) for q, lim in zip(start, ranges)]

        def ik(alpha, seed):
            result = solver.solve({'modelPath':str(source), 'tcp':{'body':'gripper', 'site':'gripperframe'},
                'jointNames':list(JOINTS), 'startPositions':seed, 'targetPose':{'position':(here*(1-alpha) + pose*alpha).tolist(), 'quaternion':quat},
                'modelVersion':'fork', 'entityId':'arm', 'collisionContextVersion':'fork', 'expectedGeneration':self.world.generation,
                'durationS':.55, 'positionToleranceM':.0025, 'orientationToleranceRad':.16, 'maxIterations':130})
            if result['plan'] is None:
                raise RuntimeError(f'Mink {alpha:.2f}: {result["result"]}')
            return result['plan']['points'][-1]['positions']

        # 同一高度的两组共用终点关节目标，分段只改变路径。
        end = ik(1., start) if height else original_endpoint
        targets = []
        if segmented:
            for alpha in (.25, .5, .75):
                start = ik(alpha, start)
                targets.append(start)
        return self.trajectory_points([*targets, end])


def historical_prefix(trial, timing):
    trial.execute('open', {'kind':'gripper', 'widthM':.06, 'durationS':.5}, timing)
    for phase in ('approach','correct'):
        if phase in timing:
            trial.advance(timing[phase]['startStep']-1, f'wait-{phase}')
            trial.execute(phase, trial.trajectory(timing, phase), timing)
    trial.advance(timing['descend']['startStep']-1, 'wait-descend')
    assert not trial.world.active and not trial.world.assisted and not trial.world.frozen
    return (state_of(trial.world), trial.world.step_index, {k:copy.deepcopy(v['heldTargets']) for k,v in trial.world.entities.items()})


def restore(trial, checkpoint):
    state, step, holds = checkpoint
    world = trial.world
    mj.mj_setState(world.model, world.data, state, INTEGRATION)
    world.refresh_derived()
    mj.mj_setState(world.model, world.data, state, INTEGRATION)
    world.step_index = step
    for key, value in holds.items():
        world.entities[key]['heldTargets'] = copy.deepcopy(value)
    assert np.array_equal(state_of(world), state)
    trial.start_step = step


def run_variant(scene, case, name, checkpoint, source, episode, timing, folder=None, media=False):
    trial = Trial(scene, case)
    restore(trial, checkpoint)
    checkpoint_sha = state_digest(trial.world)
    if media:
        trial.video = Video(trial.world, folder/'replay.mp4')
    initial = trial.describe_frame('branch-start')
    trial.trace.append(initial)
    if trial.video:
        trial.video.frame()
    try:
        try:
            action = trial.plan_descent(source, episode, trial.historical_endpoint(timing, 'descend'), *VARIANTS[name])
        except RuntimeError as err:
            result = {'completed':False, 'liftPassed':False, 'error':str(err)}
        else:
            descend = trial.execute('descend', action, timing)
            lowered = trial.describe_frame('descend-end')
            closed = trial.execute('close', {'kind':'gripper', 'widthM':.00263, 'durationS':.7, 'settleTimeS':.5}, timing)
            grasped = trial.describe_frame('close-end')
            trial.advance(timing['lift']['startStep']-1, 'wait-lift')
            # 使用相同的历史抬升终点和时序来隔离下降因素。
            trial.execute('lift', trial.trajectory(timing, 'lift'), timing)
            at_lift_end = trial.describe_frame('lift-end')
            trial.advance(episode['pick']['after']['stepIndex'], 'hold')
            final = trial.describe_frame('hold-end')
            z0 = initial['targetM'][2]
            forces = final['normalForceN']
            passed = min(final['targetM'][2], at_lift_end['targetM'][2]) - z0 >= .027 and forces['targetSupport'] == 0 and sum(forces[k] for k in ('fixedFinger','movingFinger','otherTargetArm')) > 0
            result = {'completed':True, 'liftPassed':bool(passed), 'descendReached':descend['targetReached'],
                      'descend':lowered, 'closed':grasped, 'liftEnd':at_lift_end, 'final':final,
                      'closedWidthM':closed['actualWidthM'], 'liftM':final['targetM'][2]-z0,
                      'maxLiftM':max(x['targetM'][2]-z0 for x in trial.trace if x['phase']=='lift'),
                      'firstArmTableStep':next((x['step'] for x in trial.trace if x['normalForceN']['armSupport']>0),None),
                      'maxArmTableN':max(x['normalForceN']['armSupport'] for x in trial.trace),
                      'maxDescentFingerForceN':max(x['normalForceN']['fixedFinger'] + x['normalForceN']['movingFinger'] for x in trial.trace if x['phase']=='descend'),
                      'descentShoulderSaturatedSteps':sum(abs(x['shoulderForce']) >= trial.shoulder_limit - .00001 for x in trial.trace if x['phase']=='descend'),
                      'targetXYShiftAtCloseM':math.dist(initial['targetM'][:2], grasped['targetM'][:2])}
    finally:
        if trial.video:
            trial.video.frame()
            trial.video.close()
    result.update({'checkpointSha256':checkpoint_sha, 'traceSha256':sha(encoded(trial.trace).encode()), 'finalSha256':state_digest(trial.world)})
    if folder:
        (folder/'contact-trace.jsonl').write_text(''.join(encoded(row)+'\n' for row in trial.trace),encoding='utf-8')
        write_json(folder/'actions.json',trial.commands)
        write_json(folder/'result.json',result)
    trial.world.close()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive',type=Path,required=True,help='上一轮 run-so101-paired.ts 的单批目录')
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--case',action='append',help='可重复，默认该批全部候选案例')
    parser.add_argument('--media',action='store_true')
    args = parser.parse_args()
    archive = args.archive.resolve()
    out = args.out.resolve()
    assert not out.is_relative_to(archive), '输出须独立于原始证据目录'
    out.mkdir(parents=True, exist_ok=False)
    cases = []
    worker.emit = lambda _event: None
    worker.emit_text = lambda _text: None
    for case in sorted(args.case or [p.name.removesuffix('-candidate') for p in (archive/'episodes').glob('*-candidate')]):
        episode_path = archive/'episodes'/f'{case}-candidate'/'episode.json'
        episode = load(episode_path)
        assert episode['variant'] == 'candidate' and episode['condition']['id'] == case
        scene = load(archive/'scene-runtime/sessions/so101-paired/scenes'/f'so101-{case}.json')
        source = arm_source(scene)
        verify_source(source, episode['condition'])
        timing = historical_actions(episode)
        prefix = Trial(scene, case)
        checkpoint = historical_prefix(prefix, timing)
        case_dir = out/case
        case_dir.mkdir()
        np.save(case_dir/'pre-descent-state.npy', checkpoint[0], allow_pickle=False)
        write_json(case_dir/'prefix.json', {'commands':prefix.commands, 'step':checkpoint[1], 'heldTargets':checkpoint[2], 'sceneId':scene['sceneId'], 'sceneSha256':episode['condition']['sceneSha256']})
        prefix.world.close()
        variants = {}
        for name in VARIANTS:
            folder = case_dir/name
            folder.mkdir()
            variants[name] = run_variant(scene, case, name, checkpoint, source, episode, timing, folder, args.media)
        repeat = run_variant(scene, case, 'reference', checkpoint, source, episode, timing)
        assert repeat == variants['reference'], f'未得到确定性的参考分叉: {case}'
        assert len({v['checkpointSha256'] for v in variants.values()}) == 1
        historic = episode['pick']['taskAchieved']
        variants_summary = {k:{n:v.get(n) for n in ('completed','liftPassed','descendReached','liftM','maxLiftM','firstArmTableStep','maxArmTableN','maxDescentFingerForceN','descentShoulderSaturatedSteps','targetXYShiftAtCloseM','error')} for k,v in variants.items()}
        result = {'case':case, 'historicalLiftPassed':historic, 'referenceAgrees':historic==variants['reference']['liftPassed'],
                  'deterministicReference':True, 'checkpointStep':checkpoint[1], 'checkpointSha256':variants['reference']['checkpointSha256'],
                  'originalEpisodeSha256':sha(episode_path.read_bytes()), 'variants':variants_summary}
        cases.append(result)
        print(encoded(result),flush=True)
    write_json(out/'summary.json',{'mujoco':mj.__version__, 'archive':str(archive),'variants':VARIANTS,'cases':cases})


if __name__ == '__main__':
    main()
