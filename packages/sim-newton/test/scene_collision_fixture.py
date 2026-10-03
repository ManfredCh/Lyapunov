"""A09：真实 Newton CPU 消费 Scene collision；GLB 派生、接触与禁用碰撞负对照。"""
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys
import unittest

import numpy as np
import trimesh

worker_path, bake_path, fixture_root = map(Path, sys.argv[1:4])
del sys.argv[1:4]
fixture_root.mkdir(parents=True, exist_ok=True)
spec = importlib.util.spec_from_file_location('scene_collision_worker', worker_path)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
worker.emit = lambda value: None

EVIDENCE = {'newtonVersion': worker.NEWTON_VERSION, 'warpVersion': worker.WARP_VERSION, 'device': 'cpu'}


def entity(eid, collision=None, rigid=None, position=None, scale=None, parent=None, quaternion=None):
    components = {}
    if collision is not None:
        components['collision'] = collision
    if rigid is not None:
        components['rigidBody'] = rigid
    return {'entityId': eid, 'parentId': parent, 'transform': {
        'position': position or [0, 0, 0], 'quaternion': quaternion or [0, 0, 0, 1], 'scale': scale or [1, 1, 1],
    }, 'components': components}


def scene(*entities, revision=1):
    return {'sceneId': 'a09-collision', 'revision': revision, 'entities': list(entities)}


def world(snapshot, clock='manual'):
    return worker.World(snapshot, {'worldId': 'a09-cpu-world', 'clock': clock, 'device': 'cpu', 'ground': False})


def make_glb_parts():
    # 故意使用 Y-up、毫米源坐标；派生后转换成 Z-up、米制。空区位于两墙之间。
    meshes = []
    for size, position in [([2, 2, .1], [0, 0, 0]), ([.2, 2, 1], [-.9, 0, .5]), ([.2, 2, 1], [.9, 0, .5])]:
        mesh = trimesh.creation.box(extents=size)
        mesh.apply_translation(position)
        to_source = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]])
        mesh.vertices = mesh.vertices @ to_source.T * 1000
        meshes.append(mesh)
    glb = fixture_root / 'open-room-y-up-mm.glb'
    glb.write_bytes(trimesh.Scene(meshes).export(file_type='glb'))
    source_bytes = glb.read_bytes()
    request = {'sourcePath': str(glb), 'outputDirectory': str(fixture_root / 'derived'),
               'sourceUpAxis': 'Y', 'metersPerUnit': .001, 'method': 'triangle_mesh', 'usage': 'environment'}
    run = subprocess.run([sys.executable, '-B', str(bake_path)], input=json.dumps(request),
                         text=True, capture_output=True, check=False)
    (fixture_root / 'bake.stdout.json').write_text(run.stdout)
    (fixture_root / 'bake.stderr.log').write_text(run.stderr)
    if run.returncode != 0:
        raise RuntimeError('GLB 实际派生失败: ' + run.stdout + run.stderr)
    if source_bytes != glb.read_bytes():
        raise RuntimeError('派生修改了源 GLB')
    result = json.loads(run.stdout)
    EVIDENCE['glbDerivation'] = {'exitCode': run.returncode, 'parts': len(result['parts']),
                               'units': result['units'], 'upAxis': result['upAxis'], 'sourcePreserved': result['sourcePreserved']}
    return [Path(part['path']).as_uri() for part in result['parts']]


PARTS = make_glb_parts()


class SceneCollisionTests(unittest.TestCase):
    def test_primitives_compound_and_mass_use_real_shapes(self):
        room = entity('room', {'shape': 'box', 'shapes': [
            {'center': [-1, 0, 0], 'halfExtents': [.1, 1, 1]},
            {'center': [1, 0, 0], 'halfExtents': [.1, 1, 1]},
        ]}, {'type': 'static'})
        sphere = entity('sphere', {'shape': 'sphere', 'radiusM': .1}, {'type': 'dynamic', 'massKg': 2})
        cylinder = entity('cylinder', {'shape': 'cylinder', 'halfExtents': [.2, .3, .2]}, {'type': 'static'})
        capsule = entity('capsule', {'shape': 'capsule', 'size': [.1, .4]}, {'type': 'static'})
        plane = entity('plane', {'shape': 'plane', 'size': [.5, .6]}, {'type': 'static'})
        value = world(scene(room, sphere, cylinder, capsule, plane))
        self.addCleanup(value.close)
        self.assertEqual(value.model.shape_count, 6)
        self.assertEqual(value.model.body_count, 5)
        self.assertEqual(value.describe('room')['nativeShapeLabels'], ['room/box0', 'room/box1'])
        self.assertEqual(len(value.describe('room')['freeBases']), 0)
        self.assertEqual(len(value.describe('sphere')['freeBases']), 1)
        self.assertTrue(np.allclose(value.model.body_mass.numpy(), [0, 2, 0, 0, 0]))
        self.assertTrue(np.allclose(value.model.shape_scale.numpy()[-1], [.5, .6, 0]))
        EVIDENCE['primitives'] = {'shapeCount': value.model.shape_count, 'bodyCount': value.model.body_count,
                                  'types': value.model.shape_type.numpy().tolist(), 'bodyMassKg': value.model.body_mass.numpy().tolist()}

    def test_finite_plane_actual_extent_and_mirrored_normal(self):
        plane = entity('plane', {'shape': 'plane', 'size': [.5, .6]}, {'type': 'static'}, scale=[-1, 1, 1])
        inner = entity('inner', {'shape': 'sphere', 'radiusM': .05}, {'type': 'dynamic', 'massKg': 1}, position=[.2, 0, .5])
        outer = entity('outer', {'shape': 'sphere', 'radiusM': .05}, {'type': 'dynamic', 'massKg': 1}, position=[.8, 0, .5])
        value = world(scene(plane, inner, outer), clock='realtime')
        self.addCleanup(value.close)
        quaternion = value.model.shape_transform.numpy()[0, 3:]
        self.assertTrue(np.allclose(worker.quat_rotate(quaternion, [0, 0, 1]), [0, 0, 1]))
        for _ in range(300):
            value.tick()
        heights = {e['entityId']: e['transform']['position'][2] for e in value.observe()['entities']}
        self.assertTrue(.045 < heights['inner'] < .055, heights)
        self.assertLess(heights['outer'], -.4)
        EVIDENCE['finitePlane'] = {'halfExtentsM': [.5, .6], 'mirroredNormal': [0, 0, 1], 'innerBallHeightM': heights['inner'],
                                   'outerBallHeightM': heights['outer']}

    def test_sync_signature_collision_rigid_body_binding_and_representations(self):
        item = entity('box', {'shape': 'box', 'halfExtents': [.1, .2, .3]}, {'type': 'static'})
        snapshot = scene(item)
        value = world(snapshot)
        self.addCleanup(value.close)
        value.sync(scene(item, revision=2))
        self.assertEqual(value.generation, 1)
        self.assertEqual(value.applied_revision, 2)
        item['components']['collision']['halfExtents'][0] = .4
        value.sync(scene(item, revision=3))
        self.assertEqual(value.generation, 2)
        self.assertAlmostEqual(float(value.model.shape_scale.numpy()[0, 0]), .4, places=6)
        item['components']['rigidBody'] = {'type': 'dynamic', 'massKg': 3, 'massScalePolicy': 'density'}
        item['transform']['scale'] = [-2, 3, 4]
        value.sync(scene(item, revision=4))
        self.assertEqual(value.generation, 3)
        self.assertAlmostEqual(float(value.model.body_mass.numpy()[0]), 72., places=5)
        self.assertTrue(np.all(np.linalg.eigvalsh(value.model.body_inertia.numpy()[0]) > 0))
        item['components']['collision']['enabled'] = False
        value.sync(scene(item, revision=5))
        self.assertEqual(value.generation, 4)
        self.assertEqual(int(value.model.shape_flags.numpy()[0]) & int(worker.newton.ShapeFlags.COLLIDE_SHAPES), 0)
        item['components']['physicsBinding'] = {'status': 'BOUND', 'resourceId': 'r', 'resourceVersion': 1, 'strategy': 'auto'}
        value.sync(scene(item, revision=6))
        self.assertEqual(value.generation, 5)
        item['resources'] = [{'resourceId': 'r', 'version': 1, 'representations': [{'role': 'collision', 'uri': 'file:///new.obj'}]}]
        value.sync(scene(item, revision=7))
        self.assertEqual(value.generation, 6)
        item['name'] = '纯标签变化'
        value.sync(scene(item, revision=8))
        self.assertEqual(value.generation, 6)
        self.assertEqual(value.observe()['sceneRevision'], 8)
        EVIDENCE['sync'] = {'worldId': value.id, 'generation': value.generation,
                            'appliedSceneRevision': value.applied_revision, 'scaledMassKg': float(value.model.body_mass.numpy()[0])}

    def test_real_glb_static_mesh_contact_and_disable_negative_control_same_world(self):
        room = entity('glb-room', {'shape': 'mesh', 'parts': PARTS, 'source': 'asset-bake-surface'}, {'type': 'static'})
        room['components']['physicsBinding'] = {'status': 'BOUND', 'usage': 'environment', 'strategy': 'triangle_mesh'}
        ball = entity('ball', {'shape': 'sphere', 'radiusM': .06}, {'type': 'dynamic', 'massKg': 1}, position=[0, 0, .6])
        value = world(scene(room, ball), clock='realtime')
        self.addCleanup(value.close)
        self.assertEqual(value.model.shape_count, len(PARTS) + 1)
        self.assertEqual(value.model.shape_type.numpy()[:-1].tolist(), [int(worker.newton.GeoType.MESH)] * len(PARTS))

        def run_drop():
            contacts, pairs = 0, set()
            for _ in range(500):
                value.tick()
                count = int(value.contacts.rigid_contact_count.numpy()[0])
                contacts += count
                if count:
                    pairs.update(zip(value.contacts.rigid_contact_shape0.numpy()[:count].tolist(),
                                     value.contacts.rigid_contact_shape1.numpy()[:count].tolist()))
            frame = value.observe()
            self.assertEqual((frame['worldId'], frame['generation'], frame['sceneRevision']),
                             (value.id, value.generation, value.applied_revision))
            z = next(e for e in frame['entities'] if e['entityId'] == 'ball')['transform']['position'][2]
            return {'worldId': frame['worldId'], 'generation': frame['generation'], 'sceneRevision': frame['sceneRevision'],
                    'steps': frame['stepIndex'], 'ballHeightM': z, 'contactSamples': contacts, 'shapePairs': sorted(pairs)}

        enabled = run_drop()
        self.assertTrue(.10 < enabled['ballHeightM'] < .12, enabled)
        self.assertGreater(enabled['contactSamples'], 0)
        self.assertTrue(any(len(PARTS) in pair and min(pair) < len(PARTS) for pair in enabled['shapePairs']))
        room['components']['collision']['enabled'] = False
        value.sync(scene(room, ball, revision=2))
        disabled = run_drop()
        self.assertLess(disabled['ballHeightM'], -.4)
        self.assertEqual(disabled['contactSamples'], 0)
        room['components']['collision']['enabled'] = True
        value.sync(scene(room, ball, revision=3))
        restored = run_drop()
        self.assertTrue(.10 < restored['ballHeightM'] < .12, restored)
        self.assertEqual((enabled['generation'], disabled['generation'], restored['generation']), (1, 2, 3))
        EVIDENCE['glbContactCausalControl'] = {'enabled': enabled, 'disabled': disabled, 'restored': restored,
                                            'cavity': '球在两墙间的空区内落到原始地面，未被整件凸包托在墙顶'}

    def test_obj_affine_baking_preserves_mirrored_triangle_normals_and_dynamic_convex_parts(self):
        item = entity('mesh', {'shape': 'mesh', 'parts': [PARTS[0]], 'source': 'asset-bake-hull'},
                      {'type': 'dynamic', 'massKg': 2}, position=[.5, .6, .7], scale=[-2, 3, 4])
        value = world(scene(item))
        self.addCleanup(value.close)
        self.assertEqual(int(value.model.shape_type.numpy()[0]), int(worker.newton.GeoType.CONVEX_MESH))
        self.assertAlmostEqual(float(value.model.body_mass.numpy()[0]), 2.)
        reflected = worker.collision_mesh(PARTS[0], np.diag([-2., 3., 4.]), 'mirror', False)
        original = worker.collision_mesh(PARTS[0], np.eye(3), 'original', False)
        self.assertTrue(np.allclose(reflected.vertices, original.vertices @ np.diag([-2., 3., 4.])))
        self.assertTrue(np.array_equal(reflected.indices.reshape(-1, 3), original.indices.reshape(-1, 3)[:, [0, 2, 1]]))
        # 非均匀父缩放与旋转子实体构成真剪切：只烘焙 OBJ，不能按累计逐轴 scale 丢掉非对角项。
        parent = entity('parent', scale=[2, 1, 1], position=[1, 2, 3])
        item['parentId'] = 'parent'
        item['transform']['scale'] = [1, 1, 1]
        item['transform']['quaternion'] = [0, 0, math.sin(.3), math.cos(.3)]
        sheared = world(scene(parent, item))
        self.addCleanup(sheared.close)
        poses = worker.world_poses(scene(parent, item))
        frames = worker.collision_frame_maps(scene(parent, item), poses)
        expected = original.vertices @ frames['mesh'].T
        self.assertTrue(np.allclose(sheared.builder.shape_source[0].vertices, expected))
        EVIDENCE['affine'] = {'dynamicShapeType': int(value.model.shape_type.numpy()[0]),
                              'mirroredWindingCorrected': True, 'shearBakedInObj': True}

    def test_unsupported_and_invalid_declarations_are_specific_and_sync_is_atomic(self):
        base = entity('item', {'shape': 'box', 'halfExtents': [.1, .2, .3]}, {'type': 'static'})
        value = world(scene(base))
        self.addCleanup(value.close)
        old_model = value.model
        cases = [
            ({'shape': 'box'}, {'type': 'static'}, 'INVALID_ARGUMENT'),
            ({'shape': 'sdf', 'parts': PARTS}, {'type': 'static'}, 'UNSUPPORTED_CAPABILITY'),
            ({'shape': 'mesh', 'binding': {}}, {'type': 'static'}, 'UNSUPPORTED_CAPABILITY'),
            ({'shape': 'mesh', 'parts': [str(fixture_root / 'missing.obj')]}, {'type': 'static'}, 'COLLISION_MESH_NOT_FOUND'),
            ({'shape': 'mesh', 'parts': PARTS, 'source': 'asset-bake-surface'}, {'type': 'dynamic', 'massKg': 1}, 'UNSUPPORTED_CAPABILITY'),
            ({'shape': 'box', 'halfExtents': [.1, .2, .3]}, {'type': 'dynamic', 'massKg': 1, 'gravityEnabled': False}, 'UNSUPPORTED_CAPABILITY'),
            ({'shape': 'box', 'halfExtents': [.1, .2, .3], 'enabled': 'yes'}, {'type': 'static'}, 'INVALID_ARGUMENT'),
        ]
        refusals = []
        for collision, rigid, code in cases:
            with self.subTest(code=code, collision=collision):
                with self.assertRaises(worker.SimError) as caught:
                    value.sync(scene(entity('item', collision, rigid), revision=2))
                self.assertEqual(caught.exception.code, code)
                self.assertIn('item', str(caught.exception))
                self.assertIs(value.model, old_model)
                self.assertEqual((value.generation, value.applied_revision), (1, 1))
                refusals.append({'code': caught.exception.code, 'message': str(caught.exception)})
        sphere = entity('item', {'shape': 'sphere', 'radiusM': .1}, {'type': 'static'}, scale=[2, 1, 1])
        with self.assertRaises(worker.SimError) as caught:
            value.sync(scene(sphere, revision=2))
        self.assertEqual(caught.exception.code, 'UNSUPPORTED_CAPABILITY')
        parent = entity('parent', scale=[2, 1, 1])
        base['parentId'] = 'parent'
        base['transform']['quaternion'] = [0, 0, math.sin(.3), math.cos(.3)]
        with self.assertRaises(worker.SimError) as caught:
            value.sync(scene(parent, base, revision=2))
        self.assertEqual(caught.exception.code, 'UNSUPPORTED_CAPABILITY')
        self.assertIn('剪切', str(caught.exception))
        for selection in ({'contacts': True}, {'collisionTopology': {}}, {'penetrations': True}):
            with self.assertRaises(worker.SimError) as caught:
                value.observe(selection)
            self.assertEqual(caught.exception.code, 'UNSUPPORTED_CAPABILITY')
        EVIDENCE['refusals'] = refusals


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(SceneCollisionTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    EVIDENCE['testsRun'] = result.testsRun
    EVIDENCE['passed'] = result.wasSuccessful()
    (fixture_root / 'runtime-evidence.json').write_text(json.dumps(EVIDENCE, ensure_ascii=False, indent=2))
    print(json.dumps(EVIDENCE, ensure_ascii=False), file=worker._PROTOCOL_OUT)
    sys.exit(0 if result.wasSuccessful() else 1)
