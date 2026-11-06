"""用真实 Newton CPU 与已固定的 MuJoCo 解析器验证源初值和实体隔离。"""
import copy
import importlib.util
import math
import os
import sys
import unittest
import tempfile
from unittest.mock import patch
from pathlib import Path

worker_path = Path(sys.argv.pop(1))
sys.path.insert(0, str(worker_path.parent))
spec = importlib.util.spec_from_file_location('initial_state_worker', worker_path)
worker = importlib.util.module_from_spec(spec)
original_stdout = sys.stdout
try:
    spec.loader.exec_module(worker)
finally:
    sys.stdout = original_stdout
worker.emit = lambda *args, **kwargs: None

ARM = '''<mujoco model="initial_fixture"><compiler angle="radian"/><worldbody><body name="base"><body name="link" pos="0 0 .5"><joint name="j" type="hinge" axis="0 1 0" range="-1 1"/><geom type="box" size=".05 .05 .2" mass="1"/></body></body></worldbody><keyframe><key name="home" qpos=".4"/><key name="second" qpos="-.3"/></keyframe></mujoco>'''
FREE = '''<mujoco model="free_fixture"><worldbody><body name="body"><freejoint/><geom type="sphere" size=".1" mass="1"/></body></worldbody></mujoco>'''
DRIVEN = '''<mujoco model="drive_fixture"><worldbody><body name="base"><body name="link"><joint name="j" type="hinge" axis="0 1 0"/><geom type="box" size=".1 .1 .1" mass="1"/></body></body></worldbody><actuator><position name="p" joint="j" kp="20" kv="2"/></actuator><keyframe><key name="home" qpos=".4" ctrl=".4"/></keyframe></mujoco>'''
FORCE_LIMITED = DRIVEN.replace('kp="20" kv="2"', 'kp="20" kv="2" forcerange="-1 1"')

def entity(eid, pos, xml, **cfg):
    return {'entityId': eid, 'name': eid, 'transform': {'position': pos, 'quaternion': [0, 0, 0, 1], 'scale': [1, 1, 1]}, 'resources': [], 'components': {'mujoco': {'xml': xml, **cfg}}}

def scene(entities):
    return {'sceneId': 'initial-fixture', 'revision': 1, 'coordinates': {'units': 'm', 'upAxis': 'Z', 'handedness': 'right', 'quaternion': 'xyzw'}, 'entities': entities}

class InitialStateTests(unittest.TestCase):
    def world(self, snapshot):
        result = worker.World(snapshot, {'worldId': 'initial-fixture', 'clock': 'manual', 'device': 'cpu', 'timestepS': .002, 'ground': False})
        self.addCleanup(result.close)
        return result
    def values(self, world):
        frame = world.observe()
        return frame, {item['entityId']: item for item in frame['entities']}
    def test_keyframe_override_sync_and_rebuild(self):
        original = scene([entity('a', [0, 0, 0], ARM)])
        world = self.world(original)
        frame, items = self.values(world)
        self.assertAlmostEqual(items['a']['joints']['positions'][0], .4, places=5)
        changed = copy.deepcopy(original); changed['revision'] = 2
        changed['entities'][0]['components']['mujoco']['keyframe'] = 'second'
        world.sync(changed); frame, items = self.values(world)
        self.assertEqual(frame['generation'], 2)
        self.assertAlmostEqual(items['a']['joints']['positions'][0], -.3, places=5)
        changed['revision'] = 3
        changed['entities'][0]['components']['mujoco']['initialJointPositions'] = {'j': .6}
        world.sync(changed); frame, items = self.values(world)
        self.assertEqual(frame['generation'], 3)
        self.assertAlmostEqual(items['a']['joints']['positions'][0], .6, places=5)
        world.sync(changed, force=True); frame, items = self.values(world)
        self.assertEqual(frame['generation'], 4)
        self.assertAlmostEqual(items['a']['joints']['positions'][0], .6, places=5)
    def test_entity_scoping_and_free_root(self):
        snapshot = scene([entity('a', [-2, 0, 0], ARM), entity('b', [2, 0, 0], ARM, keyframe='second', initialJointPositions={'j': -.6}), entity('free', [0, 3, 4], FREE)])
        world = self.world(snapshot); frame, items = self.values(world)
        self.assertAlmostEqual(items['a']['joints']['positions'][0], .4, places=5)
        self.assertAlmostEqual(items['b']['joints']['positions'][0], -.6, places=5)
        self.assertEqual(items['free']['transform']['position'], [0, 3, 4])
        changed = copy.deepcopy(snapshot); changed['revision'] = 2
        changed['entities'][1]['components']['mujoco']['initialJointPositions']['j'] = .2
        world.sync(changed); frame, items = self.values(world)
        self.assertEqual(frame['generation'], 2)
        self.assertAlmostEqual(items['a']['joints']['positions'][0], .4, places=5)
        self.assertAlmostEqual(items['b']['joints']['positions'][0], .2, places=5)
        self.assertEqual(items['free']['transform']['position'], [0, 3, 4])
    def test_nonfinite_override_rejected(self):
        with self.assertRaisesRegex(worker.SimError, '有限数值'):
            self.world(scene([entity('a', [0, 0, 0], ARM, initialJointPositions={'j': math.nan})]))
    def test_import_dependency_message_preserves_missing_name(self):
        with patch.object(worker.newton.ModelBuilder, 'add_mjcf', side_effect=ModuleNotFoundError("No module named 'PIL'")):
            with self.assertRaisesRegex(worker.SimError, "No module named 'PIL'"):
                self.world(scene([entity('a', [0, 0, 0], ARM)]))
    def test_keyframe_control_is_not_replaced_by_zero_or_joint_override(self):
        snapshot = scene([entity('a', [0, 0, 0], DRIVEN, initialJointPositions={'j': .6})])
        snapshot['physics'] = {'gravityWorldMps2': [0, 0, 0]}
        world = self.world(snapshot)
        self.assertAlmostEqual(self.values(world)[1]['a']['joints']['positions'][0], .6, places=5)
        self.assertAlmostEqual(float(world.control.joint_target_q.numpy()[0]), .4, places=5)
        changed = copy.deepcopy(snapshot); changed['revision'] = 2
        changed['entities'][0]['components']['mujoco']['initialJointPositions']['j'] = .4
        world.sync(changed)
        world.clock = 'realtime'
        for _ in range(250): world.tick()
        self.assertAlmostEqual(self.values(world)[1]['a']['joints']['positions'][0], .4, places=3)
        changed['revision'] = 3
        changed['entities'][0]['components']['mujoco']['initialActuatorControls'] = {'p': .2}
        world.sync(changed)
        self.assertEqual(self.values(world)[0]['generation'], 3)
        self.assertAlmostEqual(float(world.control.joint_target_q.numpy()[0]), .2, places=5)

    def test_keyframe_control_after_free_root_uses_correct_layout(self):
        snapshot = scene([entity('free', [0, 3, 4], FREE), entity('driven', [0, 0, 0], DRIVEN, initialJointPositions={'j': .6})])
        snapshot['physics'] = {'gravityWorldMps2': [0, 0, 0]}
        world = self.world(snapshot)
        index = next(i for i, label in enumerate(world.model.joint_label) if label.endswith('/j') or label == 'j')
        starts = world.model.joint_q_start if worker.newton.use_coord_layout_targets else world.model.joint_qd_start
        target_index = int(starts.numpy()[index])
        self.assertAlmostEqual(float(world.control.joint_target_q.numpy()[target_index]), .4, places=5)
        world.clock = 'realtime'
        for _ in range(500): world.tick()
        self.assertAlmostEqual(self.values(world)[1]['driven']['joints']['positions'][0], .4, places=3)
        changed = copy.deepcopy(snapshot); changed['revision'] = 2
        changed['entities'][1]['components']['mujoco']['initialActuatorControls'] = {'p': .2}
        world.sync(changed)
        self.assertAlmostEqual(float(world.control.joint_target_q.numpy()[target_index]), .2, places=5)
        for _ in range(500): world.tick()
        self.assertAlmostEqual(self.values(world)[1]['driven']['joints']['positions'][0], .2, places=3)

    def test_force_limited_source_initial_target_kept_without_exposing_actions(self):
        snapshot = scene([entity('free', [0, 3, 4], FREE), entity('limited', [0, 0, 0], FORCE_LIMITED, initialJointPositions={'j': .6})])
        world = self.world(snapshot)
        joint = world.entities['limited']['joints'][0]
        index = joint['coord'] if worker.newton.use_coord_layout_targets else joint['dof']
        self.assertFalse(joint['drive']['available'])
        self.assertEqual(world.describe('limited')['controlledJointNames'], [])
        self.assertAlmostEqual(float(world.control.joint_target_q.numpy()[index]), .4, places=5)
        self.assertIn('SOURCE_ACTUATOR_FORCE_LIMIT_UNSUPPORTED', [warning['code'] for warning in world.handle()['warnings']])
        changed = copy.deepcopy(snapshot); changed['revision'] = 2
        changed['entities'][1]['components']['mujoco']['initialActuatorControls'] = {'p': .2}
        world.sync(changed)
        self.assertAlmostEqual(float(world.control.joint_target_q.numpy()[index]), .2, places=5)
        self.assertEqual(world.describe('limited')['controlledJointNames'], [])

    def test_multiple_source_actuators_do_not_guess_initial_control(self):
        multi = FORCE_LIMITED.replace('</actuator>', '<position name="p2" joint="j" kp="20" kv="2"/></actuator>').replace('ctrl=".4"', 'ctrl=".4 .2"')
        world = self.world(scene([entity('multi', [0, 0, 0], multi)]))
        drive = world.entities['multi']['joints'][0]['drive']
        self.assertFalse(drive['available'])
        self.assertFalse(drive['_initialTargetCompatible'])
        self.assertEqual(world.describe('multi')['controlledJointNames'], [])
        self.assertIn('SOURCE_ACTUATOR_FORCE_LIMIT_UNSUPPORTED', [warning['code'] for warning in world.handle()['warnings']])

    def test_fixed_urdf_chain_keeps_declared_pose_while_free_body_falls(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'fixed.urdf'
            path.write_text('''<robot name="fixed"><link name="base"><inertial><mass value=".027"/><inertia ixx=".000014" iyy=".000014" izz=".0000217" ixy="0" ixz="0" iyz="0"/></inertial><collision><geometry><box size=".1 .1 .1"/></geometry></collision></link><link name="child"><inertial><mass value="0"/><inertia ixx="0" iyy="0" izz="0" ixy="0" ixz="0" iyz="0"/></inertial></link><joint name="fixed_child" type="fixed"><parent link="base"/><child link="child"/><origin xyz=".1 0 .2"/></joint></robot>''')
            fixed = entity('fixed', [2, .3, .7], '', sourcePath=str(path))
            del fixed['components']['mujoco']['xml']
            world = self.world(scene([fixed, entity('falling', [4, 0, 4], FREE)]))
            self.assertAlmostEqual(self.values(world)[1]['fixed']['transform']['position'][2], .7, places=5)
            world.clock = 'realtime'
            for _ in range(1000): world.tick()
            frame, items = self.values(world)
            self.assertEqual(frame['stepIndex'], 1000)
            for measured, expected in zip(items['fixed']['transform']['position'], [2, .3, .7]):
                self.assertAlmostEqual(measured, expected, places=5)
            self.assertLess(items['falling']['transform']['position'][2], 3)
            poses = items['fixed']['sensors']['bodyWorldPoses']
            child = next(value for name, value in poses.items() if name.endswith('/child'))
            for measured, expected in zip(child['positionM'], [2.1, .3, .9]):
                self.assertAlmostEqual(measured, expected, places=5)

if __name__ == '__main__':
    unittest.main()
