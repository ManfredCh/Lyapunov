"""可选人体 CUDA 安装自检：实际执行随包 FP64 clip/FK，不创建 World 或修改引擎偏好。"""
import argparse
import contextlib
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-root', required=True)
    args = parser.parse_args()
    try:
        import mujoco
        import numpy as np
        if mujoco.__version__ != '3.13.0':
            raise RuntimeError('HUMAN_GPU_BASE_RUNTIME_UNSUPPORTED: 需要 MuJoCo 3.13.0')
        import warp as wp
        if wp.__version__ != '1.13.0':
            raise RuntimeError('HUMAN_GPU_DEPENDENCY_VERSION: 需要 warp-lang 1.13.0')
        from human_gpu import ClipBatch
        cfg = {'rig': [{'name': 'root', 'offsetM': [0., 0., 0.], 'quaternionXyzw': [0., 0., 0., 1.]}],
               'clips': [{'name': 'install-check', 'durationS': 1., 'tracks': []}]}
        batch = None
        try:
            with contextlib.redirect_stdout(sys.stderr):
                batch = ClipBatch(cfg, 1, 'install-check', cache_root=args.cache_root)
                positions, rotations = batch.sample(np.array([[1.25, 2.5, 3.75]]), np.array([[1., 0., 0., 0.]]), np.array([0.]), np.array([0.]))
            if not np.array_equal(positions, [[[1.25, 2.5, 3.75]]]) or not np.array_equal(rotations, [[[1., 0., 0., 0.]]]):
                raise RuntimeError('HUMAN_GPU_KERNEL_CHECK_FAILED: FP64 clip/FK 回读与固定输入不一致')
            facts = batch.facts()
        finally:
            if batch is not None:
                batch.close()
        source = Path(__file__).with_name('human_gpu.py')
        print(json.dumps({'provider': 'mujoco', 'status': 'AVAILABLE', 'feature': 'human-cuda',
                          'python': str(Path(sys.executable).resolve()), 'prefix': str(Path(sys.prefix).resolve()),
                          'mujocoVersion': mujoco.__version__, 'numpyVersion': np.__version__,
                          'warpVersion': importlib.metadata.version('warp-lang'), 'gpu': facts,
                          'helperSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                          'kernelCheck': {'actors': 1, 'bones': 1, 'dtype': 'float64', 'readbackExact': True},
                          'scope': '依赖、CUDA设备和一次真实FP64 clip/FK；不代表20人正常场景、实时性能或渲染已验收。'}, ensure_ascii=False))
        return 0
    except Exception as error:
        code = getattr(error, 'code', None) or (str(error).split(':', 1)[0] if str(error).startswith('HUMAN_') else 'HUMAN_CUDA_CHECK_FAILED')
        print(json.dumps({'provider': 'mujoco', 'status': 'BLOCKED', 'feature': 'human-cuda', 'code': code,
                          'message': str(error), 'python': sys.executable,
                          'install': './lyapunov install-provider mujoco --human-cuda'}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
