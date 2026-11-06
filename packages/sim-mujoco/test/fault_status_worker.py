"""真实 MuJoCo worker 的一次受控 tick 异常，用于验证原世界状态与恢复。"""
import importlib.util
import os
import pathlib
import sys

path = pathlib.Path(os.environ['LYAPUNOV_MUJOCO_FAULT_SOURCE'])
sys.path.insert(0, str(path.parent))
spec = importlib.util.spec_from_file_location('mujoco_fault_source', path)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
original = worker.World.tick
injected = False

def tick_once(self):
    global injected
    if not injected:
        injected = True
        raise RuntimeError('故障夹具：原生步进失败')
    return original(self)

worker.World.tick = tick_once
worker.main()
