"""CPU 原生像素回归夹具；输出文件供 Bun 检查，stdout 保留 worker 的协议边界。"""
import copy
import importlib.util
import json
from pathlib import Path
import sys
from urllib.parse import unquote, urlparse
import struct
import zlib

import numpy as np

root, output = Path(sys.argv[1]), Path(sys.argv[2])
sys.path.insert(0, str(root / 'packages/sim-newton/python'))
spec = importlib.util.spec_from_file_location('newton_worker_camera_test', root / 'packages/sim-newton/python/worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
from camera import NewtonCamera

xml = '''<mujoco model="falling-box"><compiler angle="radian"/><worldbody>
<body name="box" pos="0 0 0.8"><freejoint name="free"/><geom name="box-shape" type="box" size=".2 .2 .2" mass="1" rgba=".8 .2 .1 1"/>
<camera name="mounted" pos="0 0 2" fovy="60"/>
<camera name="optics" pos="0 0 2" sensorsize=".036 .024" resolution="320 200" focalpixel="180 160" principalpixel="7 -4"/>
<camera name="tracking" mode="track" pos="0 0 2" fovy="60"/>
</body></worldbody></mujoco>'''


def entity(eid, position, components, name=None):
    return {'entityId': eid, 'name': name or eid, 'resources': [],
            'transform': {'position': position, 'quaternion': [0, 0, 0, 1], 'scale': [1, 1, 1]},
            'components': components}


source_root = output/'native-source'
source_root.mkdir(parents=True, exist_ok=True)
(source_root/'camera-root.xml').write_text('''<mujoco><compiler angle="degree"/>
<default><default class="optical"><camera fovy="50"/></default></default>
<worldbody><include file="included-body.xml"/></worldbody></mujoco>''')
(source_root/'included-body.xml').write_text('''<mujoco><body name="camera-parent" pos="0 1 1" euler="0 0 90">
<geom type="sphere" size=".1"/><body name="camera-child" pos="1 0 0" euler="0 0 90">
<geom type="sphere" size=".1"/><camera name="nested" class="optical" pos="0 0 .5" euler="0 90 0"/>
</body></body></mujoco>''')
included = entity('included', [-2, 0, 0], {'mujoco': {'sourcePath': str(source_root/'camera-root.xml')}})
included['transform']['quaternion'] = [0, 0, float(np.sqrt(.5)), float(np.sqrt(.5))]
attached = entity('scene-mounted', [0, 0, 2.8], {'camera': {'fovYDeg': 60}})
attached['parentId'] = 'first'
scene = {'sceneId': 'native-camera-cpu', 'revision': 1, 'entities': [
    entity('first', [1, 0, 0], {'mujoco': {'xml': xml}}),
    entity('second', [4, 0, 0], {'mujoco': {'xml': xml}}),
    entity('fixed', [1, 0, 3], {'camera': {'fovYDeg': 60}}, 'overview'),
    entity('saved', [0, 0, 0], {'viewerCamera': {'cameras': [
        {'name': 'known-K', 'state': {'position': [1, 0, 3], 'quaternion': [0, 0, 0, 1],
         'intrinsics': {'fx': 45, 'fy': 40, 'cx': 21.25, 'cy': 19.75, 'width': 64, 'height': 48}}}]}}),
    included, attached,
]}
world = worker.World(scene, {'worldId': 'camera-cpu', 'clock': 'realtime', 'device': 'cpu', 'timestepS': .002})
camera = NewtonCamera(world, worker.SimError, worker.native_source, worker.world_poses)
before = camera.list({'width': 64, 'height': 48})
(output/'mapping.json').write_text(json.dumps({'bodyLabels': list(world.model.body_label),
    'entities': {eid: {'rootBody': e.get('rootBody'), 'bodyLabels': e.get('bodyLabels')} for eid, e in world.entities.items()},
    'cameras': before['cameras']}, indent=2))
first = camera.capture_multi({'cameraNames': ['first/mounted', 'fixed/overview', 'saved/known-K', 'first/optics'],
                              'width': 64, 'height': 48, 'outputDir': str(output / 'before')})
step_before_capture = world.step_index
world_before_capture = world.state_a.body_q.numpy().copy()
# 真正由 XPBD/碰撞路径推进，不写入人为 body 动画。
for _ in range(100):
    world.tick()
after = camera.list({'width': 64, 'height': 48})
state_before = world.state_a.body_q.numpy().copy()
second = camera.capture_multi({'cameraNames': ['first/mounted', 'fixed/overview'],
                               'width': 64, 'height': 48, 'outputDir': str(output / 'after')})
state_after = world.state_a.body_q.numpy().copy()


def pixels(entry):
    path = Path(unquote(urlparse(entry['depth']['uri']).path))
    depth = np.load(path, allow_pickle=False)
    png = Path(unquote(urlparse(entry['rgb']['uri']).path)).read_bytes()
    cursor, compressed = 8, b''
    while cursor < len(png):
        length = struct.unpack('>I', png[cursor:cursor+4])[0]
        if png[cursor+4:cursor+8] == b'IDAT':
            compressed += png[cursor+8:cursor+8+length]
        cursor += 12+length
    raw = np.frombuffer(zlib.decompress(compressed), dtype=np.uint8).reshape(48, 64*3+1)
    rgb = raw[:, 1:].reshape(48, 64, 3)
    hits = depth[depth > 0]
    rows, columns = np.nonzero((depth > 0) & (depth < float(hits.min())+.02))
    return {'centerM': float(depth[24, 32]), 'hitCount': int(np.count_nonzero(depth > 0)),
            'shape': list(depth.shape), 'dtype': str(depth.dtype), 'pngSignature': list(png[:8]),
            'pngBytes': len(png), 'minM': float(depth.min()), 'maxM': float(depth.max()),
            'rgbUniqueCount': len(np.unique(rgb.reshape(-1, 3), axis=0)),
            'frontPixelBounds': [int(columns.min()), int(rows.min()), int(columns.max()), int(rows.max())],
            'frontPixelCentroid': [float(columns.mean()), float(rows.mean())]}


def rejected(options):
    try:
        camera.capture_multi({**options, 'outputDir': str(output/'rejected'), 'width': 64, 'height': 48})
        return {'unexpectedSuccess': True}
    except worker.SimError as exc:
        return {'code': exc.code, 'message': str(exc)}


report = {'beforeList': before, 'afterList': after, 'beforeCapture': first, 'afterCapture': second,
          'beforePixels': [pixels(e) for e in first['cameras']], 'afterPixels': [pixels(e) for e in second['cameras']],
          'captureStepBeforeAdvance': step_before_capture, 'bodyBeforeAdvance': world_before_capture.tolist(),
          'bodyAfterAdvance': state_after.tolist(), 'captureStateUnchanged': bool(np.array_equal(state_before, state_after)),
          'ambiguous': rejected({'cameraNames': ['mounted']}),
          'unsupportedMode': rejected({'cameraNames': ['first/tracking']}),
          'unknown': rejected({'cameraNames': ['missing']}),
          'duplicate': rejected({'cameraNames': ['first/mounted', 'first/mounted']}),
          'geomGroups': rejected({'cameraNames': ['first/mounted'], 'geomGroups': [0]})}
capture_id = second['captureId']
report['published'] = camera.publish_capture(capture_id, output/'after', output/'published')
report['publishedUris'] = [entry['depth']['uri'] for entry in camera.captures[capture_id]['cameras']]

# 相机参数只修改 scene 声明；物理模型未重编译时也必须刷新，且 JSON 保存重开一致。
modified = copy.deepcopy(world.scene)
modified['revision'] = 2
modified['entities'][2]['components']['camera']['fovYDeg'] = 40
model_before = world.model
world.sync(modified)
report['cameraOnlySyncModelUnchanged'] = world.model is model_before
report['syncedList'] = camera.list({'width': 64, 'height': 48})
reopened = worker.World(json.loads(json.dumps(modified)), {'clock': 'manual', 'device': 'cpu'})
reopened_camera = NewtonCamera(reopened, worker.SimError, worker.native_source, worker.world_poses)
report['reopenedList'] = reopened_camera.list({'width': 64, 'height': 48})

# 原生粒子同样走 model/state BVH，不能只拍到容器。
import newton
import warp as wp
builder = newton.ModelBuilder()
builder.add_particle(pos=wp.vec3(0, 0, -2), vel=wp.vec3(0, 0, 0), mass=1, radius=.35)
particle_model = builder.finalize(device='cpu')
particle_state = particle_model.state()
class ParticleWorld:
    model = particle_model
    state_a = particle_state
    id = 'particle-camera'
    generation = 1
    step_index = 0
    sim_time = 0.0
    applied_revision = 1
    solver_name = 'implicit-mpm'
    fail_observation = False
    entities = {}
    scene = {'entities': [entity('particle-view', [0, 0, 0], {'camera': {'fovYDeg': 60}})]}
    def require_ready(self):
        pass
    def observe(self, selection):
        if selection.get('contacts'):
            raise worker.SimError('UNSUPPORTED_CAPABILITY', 'MPM 不提供刚体 Contacts / MPM does not expose rigid Contacts')
        if self.fail_observation:
            raise worker.SimError('WORLD_UNAVAILABLE', '注入的观测错误 / Injected observation error')
        return {'frameId': 'particle-camera:1:0', 'stepIndex': 0, 'simTime': 0.0, 'entities': [],
                'sensorsOnly': selection == {'sensors': True}}
particle_camera = NewtonCamera(ParticleWorld(), worker.SimError, worker.native_source, worker.world_poses)
particle_capture = particle_camera.capture({'cameraName': 'particle-view/particle-view', 'width': 64, 'height': 48,
                                            'outputDir': str(output/'particle')})
report['particlePixels'] = pixels(particle_capture)
report['particleObservation'] = particle_capture['observation']
particle_state.particle_q.assign(np.array([[0, 0, -3]], dtype=np.float32))
particle_changed = particle_camera.capture({'cameraName': 'particle-view/particle-view', 'width': 64, 'height': 48,
                                            'outputDir': str(output/'particle-moved')})
report['particleMovedPixels'] = pixels(particle_changed)
particle_camera.world.fail_observation = True
try:
    particle_camera.capture({'cameraName': 'particle-view/particle-view', 'width': 64, 'height': 48,
                             'outputDir': str(output/'particle-observation-error')})
    report['particleObservationError'] = {'unexpectedSuccess': True}
except worker.SimError as exc:
    report['particleObservationError'] = {'code': exc.code, 'message': str(exc)}
report['device'] = str(world.model.device)
report['versions'] = {'newton': worker.NEWTON_VERSION, 'warp': worker.WARP_VERSION}
camera.close()
reopened_camera.close()
particle_camera.close()
world.close()
reopened.close()
(output/'report.json').write_text(json.dumps(report, allow_nan=False, indent=2))
