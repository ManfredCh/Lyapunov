"""Run the real worker lifecycle with inert engine modules; no SDK imports or physics."""
import copy
import gc
import importlib.util
import os
import queue
import sys
import types
import unittest
import weakref
from unittest.mock import patch

# Install these before importing the worker. -S also disables site packages.
for name in ('numpy', 'newton', 'warp'):
    module = types.ModuleType(name)
    module.__version__ = 'offline-stub'
    sys.modules[name] = module
sys.modules['warp'].config = types.SimpleNamespace(kernel_cache_dir=None)
worker_path = sys.argv.pop(1)
os.environ['LYAPUNOV_NEWTON_CACHE_ROOT'] = os.path.join(os.getcwd(), 'cache')
spec = importlib.util.spec_from_file_location('offline_newton_worker', worker_path)
worker = importlib.util.module_from_spec(spec)
stdout = sys.stdout
try:
    spec.loader.exec_module(worker)
finally:
    sys.stdout = stdout

NATIVE_FIELDS = ('builder', 'model', 'state_a', 'state_b', 'control', 'solver',
                 'pipeline', 'contacts', 'ik_q', 'ik_qd')
SCENE = {'sceneId': 'offline', 'revision': 0, 'entities': []}


class NativeHandle:
    """Weak-referenceable placeholder; entering tick fails before any physics."""
    def clear_forces(self):
        raise RuntimeError('injected tick failure')


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.refs = []
        self.worlds = []
        self.compile_patch = patch.object(worker.World, 'compile', self.fake_compile)
        self.compile_patch.start()
        self.addCleanup(self.compile_patch.stop)

    def fake_compile(self, scene):
        def handle():
            obj = NativeHandle()
            self.refs.append(weakref.ref(obj))
            return obj
        return {
            'builder': handle(), 'model': handle(), 'states': (handle(), handle()),
            'control': handle(), 'solver': handle(), 'solverName': 'offline',
            'pipeline': handle(), 'contacts': handle(), 'ik_q': handle(), 'ik_qd': handle(),
            'entities': {}, 'ground': [], 'warnings': [],
        }

    def make_world(self):
        return worker.World(SCENE, {'worldId': 'world', 'device': 'cpu', 'clock': 'manual'})

    def assert_released(self, world):
        for field in NATIVE_FIELDS:
            self.assertIsNone(getattr(world, field), field)
        self.assertEqual(world.entities, {})

    def test_fault_releases_handles_rejects_use_and_close_is_idempotent(self):
        world = self.make_world()
        self.assertTrue(all(ref() is not None for ref in self.refs))
        world.fault(RuntimeError('injected fault'))
        self.assert_released(world)
        gc.collect()
        self.assertTrue(all(ref() is None for ref in self.refs))
        handle = world.handle()
        self.assertEqual(handle['status'], 'unavailable')
        self.assertEqual(handle['statusReason'], 'RuntimeError: injected fault')
        self.assertEqual(handle['sceneId'], SCENE['sceneId'])
        for call in (world.observe, lambda: world.describe('entity'), lambda: world.stop({})):
            with self.assertRaises(worker.SimError) as caught:
                call()
            self.assertEqual(caught.exception.code, 'WORLD_UNAVAILABLE')
            self.assertIn('injected fault', str(caught.exception))
        world.tick()  # Faulted ticks do not touch any cleared native handles.
        world.close()
        world.close()
        self.assertEqual(world.status, 'closed')
        self.assertIsNone(world.scene)
        self.assert_released(world)

    def test_explicit_sync_rebuilds_faulted_world_and_clears_stale_reason(self):
        world = self.make_world()
        old_generation = world.generation
        world.fault(ValueError('old fault'))
        handle = world.sync(dict(SCENE, revision=1))
        self.assertEqual(handle['status'], 'ready')
        self.assertNotIn('statusReason', handle)
        self.assertEqual(handle['worldGeneration'], old_generation + 1)
        self.assertEqual(handle['appliedSceneRevision'], 1)
        self.assertIsNotNone(world.model)
        world.require_ready()
        world.close()

    def test_failed_recompile_preserves_existing_ready_world(self):
        world = self.make_world()
        native = {field: getattr(world, field) for field in NATIVE_FIELDS}
        with patch.object(worker.World, 'compile', side_effect=RuntimeError('compile failure')):
            with self.assertRaises(worker.SimError) as caught:
                world.sync(dict(SCENE, revision=1), force=True)
        self.assertEqual(caught.exception.code, 'COMPILE_FAILED')
        self.assertEqual(world.status, 'ready')
        self.assertIsNone(world.status_reason)
        for field, value in native.items():
            self.assertIs(getattr(world, field), value)
        world.close()

    def test_main_tick_fault_is_listable_rejects_observe_and_can_close(self):
        worker.requests = queue.Queue()
        worker.requests.put({'id': 1, 'method': 'open', 'args': {
            'snapshot': SCENE, 'options': {'worldId': 'world', 'device': 'cpu', 'clock': 'realtime'},
        }})
        events = []

        def emit(event):
            events.append(copy.deepcopy(event))
            if event.get('event') == 'world-error':
                for rid, method in ((2, 'list_worlds'), (3, 'observe'), (4, 'close'),
                                    (5, 'list_worlds'), (6, 'shutdown')):
                    worker.requests.put({'id': rid, 'method': method, 'args': {'worldId': 'world'}})

        with patch.object(worker.threading, 'Thread'), \
                patch.object(worker, 'resolve_device', return_value=('cpu', 'cpu', False, 'offline')), \
                patch.object(worker, 'emit', side_effect=emit):
            worker.main()
        errors = [event for event in events if event.get('event') == 'world-error']
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]['error'], 'injected tick failure')
        replies = {event['id']: event for event in events if 'id' in event}
        faulted = replies[2]['result'][0]
        self.assertEqual(faulted['status'], 'unavailable')
        self.assertEqual(faulted['statusReason'], 'RuntimeError: injected tick failure')
        self.assertEqual(replies[3]['error']['code'], 'WORLD_UNAVAILABLE')
        self.assertIn('injected tick failure', replies[3]['error']['message'])
        self.assertIsNone(replies[4]['result'])
        self.assertEqual(replies[5]['result'], [])
        gc.collect()
        self.assertTrue(all(ref() is None for ref in self.refs))


if __name__ == '__main__':
    unittest.main(verbosity=2)
