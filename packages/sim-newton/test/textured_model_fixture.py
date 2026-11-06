"""真实 Newton CPU：已固定的 A1、Go2 纹理模型可读取并推进。"""
import importlib.util
import math
import sys
import unittest
from pathlib import Path

worker_path = Path(sys.argv.pop(1)); supply = Path(sys.argv.pop(1))
sys.path.insert(0, str(worker_path.parent))
spec = importlib.util.spec_from_file_location('textured_model_worker', worker_path)
worker = importlib.util.module_from_spec(spec)
stdout = sys.stdout
try:
    spec.loader.exec_module(worker)
finally:
    sys.stdout = stdout
worker.emit = lambda *args, **kwargs: None

class TexturedModels(unittest.TestCase):
    def test_textured_models_open_and_step(self):
        for pack, filename in [('unitree_a1', 'a1.xml'), ('unitree_go2', 'go2.xml')]:
            with self.subTest(pack=pack):
                path = supply / 'packs' / pack / 'asset' / filename
                self.assertTrue(path.is_file(), str(path))
                entity = {'entityId': pack, 'name': pack, 'transform': {'position': [0, 0, .4], 'quaternion': [0, 0, 0, 1], 'scale': [1, 1, 1]}, 'resources': [], 'components': {'mujoco': {'sourcePath': str(path)}}}
                scene = {'sceneId': pack, 'revision': 1, 'coordinates': {'units': 'm', 'upAxis': 'Z', 'handedness': 'right', 'quaternion': 'xyzw'}, 'entities': [entity]}
                world = worker.World(scene, {'worldId': pack, 'clock': 'realtime', 'device': 'cpu', 'timestepS': .002, 'ground': False})
                try:
                    before = world.observe()
                    self.assertEqual(before['stepIndex'], 0)
                    for _ in range(10): world.tick()
                    frame = world.observe()
                    self.assertEqual(frame['stepIndex'], 10)
                    self.assertTrue(all(math.isfinite(x) for x in frame['entities'][0]['transform']['position']))
                finally:
                    world.close()

if __name__ == '__main__':
    unittest.main()
