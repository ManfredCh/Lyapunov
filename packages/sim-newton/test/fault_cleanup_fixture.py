"""受控故障注入：真实 Newton World 持有原生活动动作时 fault，再按原 stop/close 收尾。"""
import importlib.util
import json
import pathlib
import sys

worker, arm = map(pathlib.Path, sys.argv[1:3])
sys.path.insert(0, str(worker.parent))
spec = importlib.util.spec_from_file_location('newton_fault_test_worker', worker)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.emit = lambda *_args, **_kwargs: None
scene = {'sceneId': 'fault-cleanup-scene', 'revision': 1,
         'coordinates': {'units': 'm', 'upAxis': 'Z', 'handedness': 'right', 'quaternion': 'xyzw'},
         'entities': [{'entityId': 'arm', 'name': 'arm', 'resources': [],
                       'transform': {'position': [0, 0, 0], 'quaternion': [0, 0, 0, 1], 'scale': [1, 1, 1]},
                       'components': {'mujoco': {'sourcePath': str(arm)}}}]}
world = module.World(scene, {'worldId': 'fault-cleanup-world', 'clock': 'manual', 'ground': True})
try:
    # 单有 unavailable 字样但原生模型仍在时，不得伪造停止成功。
    world.status, world.status_reason = 'unavailable', 'fixture: 模型尚未释放'
    try:
        world.stop({})
        raise AssertionError('模型仍在时不得确认停止')
    except module.SimError as error:
        assert error.code == 'WORLD_UNAVAILABLE'
    world.status, world.status_reason = 'ready', None
    joint = world.entities['arm']['joints'][0]['label']
    receipt = world.execute({'actionId': 'live-action', 'kind': 'joint', 'entityId': 'arm',
                             'expectedGeneration': world.generation, 'jointNames': [joint],
                             'positions': [.2], 'durationS': 1})
    assert receipt['status'] == 'accepted' and 'live-action' in world.active
    world.fault(module.SimError('ENGINE_INSTABILITY', '受控故障'))
    assert world.receipts['live-action']['status'] == 'failed' and not world.active
    assert world.model is None and not world.commanded
    for selection, code in [({'expectedGeneration': world.generation + 1}, 'STALE_GENERATION'),
                            ({'actionId': 'unknown'}, 'ACTION_NOT_FOUND')]:
        try:
            world.stop(selection)
            raise AssertionError('预期拒绝: ' + code)
        except module.SimError as error:
            assert error.code == code, (error.code, code)
    stopped = world.stop({'expectedGeneration': world.generation, 'actionId': 'live-action'})
    assert stopped['stopped'] is True and stopped['reason'] == 'WORLD_ALREADY_UNAVAILABLE'
    assert stopped['receipts'] == [] and '受控故障' in stopped['statusReason']
    world.close()
    assert world.status == 'closed'
    module._PROTOCOL_OUT.write(json.dumps({'status': 'PASS', 'receipt': receipt,
                                           'failedAction': world.receipts['live-action'], 'stop': stopped}) + '\n')
    module._PROTOCOL_OUT.flush()
finally:
    world.close()
