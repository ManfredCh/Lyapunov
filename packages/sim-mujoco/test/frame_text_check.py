"""帧输出快路径单元核对：human.observe_many_text 与 observe_many 逐字节等价，四元数批转换逐位相等。

受测对象：`packages/sim-mujoco/python/human.py` 的 observe_many_text/observed_quaternions_batch
与 `worker.py` 的占位替换口径（本文件只核 human 层文本片段；整帧 byte-for-byte 由
p1/frame_check_worker.py 的真 worker 等价门覆盖）。

用桩 world/info 构造 kinematic/ragdoll、batch(>=256)/scalar(<256)、有无 target/motion、
非有限数组、以及四元数边界位形；断言：
  · observe_many_text 的输出 == json.dumps(observe_many 对应 dict, allow_nan=False, 紧凑分隔)；
  · 非有限数值时抛出与原路径同类的 ValueError；
  · observed_quaternions_batch 与旧实现（本文件内复制的原始分支式实现）在随机与边界位形下
    逐位相等（np.array_equal + signbit，覆盖 -0.0）。
"""
import importlib.util
import json
import os
import sys
from types import SimpleNamespace

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PYTHON_DIR = os.path.join(HERE, '..', 'python')
sys.path.insert(0, os.path.abspath(PYTHON_DIR))
WORKER_PATH = os.environ.get('LYAPUNOV_MUJOCO_TEST_WORKER', os.path.join(PYTHON_DIR, 'worker.py'))
spec = importlib.util.spec_from_file_location('worker_under_test', WORKER_PATH)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
human = sys.modules['human']

results = {}
rng = np.random.default_rng(7)


def rand_rots(n, gen=rng):
    q = gen.normal(size=(n, 4))
    q /= np.linalg.norm(q, axis=1)[:, None]
    w, x, y, z = q[:, 0], q[:, 1], q[:, 2], q[:, 3]
    m = np.zeros((n, 9))
    m[:, 0] = 1 - 2 * (y * y + z * z); m[:, 1] = 2 * (x * y - z * w); m[:, 2] = 2 * (x * z + y * w)
    m[:, 3] = 2 * (x * y + z * w); m[:, 4] = 1 - 2 * (x * x + z * z); m[:, 5] = 2 * (y * z - x * w)
    m[:, 6] = 2 * (x * z - y * w); m[:, 7] = 2 * (y * z + x * w); m[:, 8] = 1 - 2 * (x * x + y * y)
    return m


def rand_quats_wxyz(n, gen=rng):
    q = gen.normal(size=(n, 4))
    q /= np.linalg.norm(q, axis=1)[:, None]
    return q


class Fixture:
    """最小桩：observe_many 实际读到的字段，数值用真实 ndarray 保证分支语义一致。"""

    def __init__(self, nj=81, ns=14, count=3):
        self.nj, self.ns = nj, ns
        self.geom_pos = rng.normal(size=(count * ns, 3))
        self.geom_size = np.abs(rng.normal(size=(count * ns, 3))) + 1e-3
        self.geom_mat = rand_rots(count * ns)
        self.joint_pos = rng.normal(size=(count * nj, 3))
        self.joint_mat = rand_rots(count * nj)
        self.body_pos = rng.normal(size=(count * nj, 3))
        self.body_quat = rand_quats_wxyz(count * nj)
        world = SimpleNamespace()
        world.data = SimpleNamespace(geom_xpos=self.geom_pos, geom_xmat=self.geom_mat,
                                     site_xpos=self.joint_pos, site_xmat=self.joint_mat,
                                     xpos=self.body_pos, xquat=self.body_quat, time=0.014)
        world.model = SimpleNamespace(geom_size=self.geom_size)
        world.step_index = 7
        self.world = world

    def info(self, k, mode='kinematic', target=False, motion=False, name_suffix=''):
        ns, nj = self.ns, self.nj
        view = {'segmentIds': np.arange(k * ns, (k + 1) * ns, dtype=np.int32),
                'jointIds': np.arange(k * nj, (k + 1) * nj, dtype=np.int32),
                'segmentNames': [f'seg{k}_{i}{name_suffix}' for i in range(ns)],
                'jointNames': [f'jnt{k}_{i}{name_suffix}' for i in range(nj)],
                'geomPos': self.geom_pos, 'geomSize': self.geom_size, 'geomMat': self.geom_mat,
                'jointPos': self.joint_pos, 'jointOrientation': self.joint_mat}
        info = {'human': {'mode': mode}, 'humanObserve': view, 'humanSegments': list(range(ns))}
        if target:
            info['humanTarget'] = {'pos': [1.0, 2.0, 3.0]}
        if motion:
            info['humanMotion'] = {'clip': 'c', 'i': 3}
        return info


def check_text_equals_dict(world, infos):
    ref = human.observe_many(world, infos)
    txt = human.observe_many_text(world, infos)
    assert set(txt.keys()) == {id(i) for i in infos}
    for i in infos:
        expected = json.dumps(ref[id(i)], allow_nan=False, separators=(',', ':'))
        assert txt[id(i)] == expected, 'observe_many_text 与 observe_many 逐字节不一致'


# (a) batch 分支：3 个 kinematic 人（14段+81关节）×3 = 285 >= 256
fx = Fixture()
infos = [fx.info(0, target=True), fx.info(1, motion=True), fx.info(2, name_suffix='%')]
check_text_equals_dict(fx.world, infos)
results['batch_ge_256'] = human._observe_total(infos)

# (b) scalar 分支：1 人与 2 人（<256）
fx1 = Fixture(nj=10, ns=5, count=2)
check_text_equals_dict(fx1.world, [fx1.info(0)])
check_text_equals_dict(fx1.world, [fx1.info(0, target=True), fx1.info(1, motion=True)])
results['scalar_lt_256'] = human._observe_total([fx1.info(0), fx1.info(1)])

# (c) ragdoll：动态关节走 xpos/xquat 分支；批规模由 ragdoll 人堆出来
fxr = Fixture(nj=30, ns=14, count=10)
rinfos = [fxr.info(k, mode='ragdoll', target=(k == 0)) for k in range(10)]
check_text_equals_dict(fxr.world, rinfos)   # 14×10=140<256 → scalar
fxr2 = Fixture(nj=30, ns=14, count=20)
rinfos2 = [fxr2.info(k, mode='ragdoll', motion=(k % 3 == 0)) for k in range(20)]
check_text_equals_dict(fxr2.world, rinfos2)  # 14×20=280>=256 → batch
results['ragdoll_batch'] = human._observe_total(rinfos2)

# (e) 非有限数组：与原路径同类错误
fxn = Fixture()
ninfos = [fxn.info(0), fxn.info(1), fxn.info(2)]
fxn.geom_pos[0, 0] = float('nan')
err_text = err_ref = None
try:
    human.observe_many_text(fxn.world, ninfos)
except ValueError as e:
    err_text = type(e).__name__
try:
    json.dumps({'f': human.observe_many(fxn.world, ninfos)}, allow_nan=False)
except ValueError as e:
    err_ref = type(e).__name__
assert err_text == err_ref == 'ValueError', (err_text, err_ref)
fxn.geom_pos[0, 0] = 0.0
results['nonfinite_same_error'] = err_text


# (f) 四元数：旧分支式实现（逐位基准） vs 新向量化实现
def old_batch(matrices):
    if len(matrices) < 256:
        return human.observed_quaternions(matrices)
    m = np.asarray(matrices).reshape(-1, 9)
    trace = m[:, 0] + m[:, 4] + m[:, 8]
    components = np.stack((1 + trace, 1 + 2 * m[:, 0] - trace, 1 + 2 * m[:, 4] - trace, 1 + 2 * m[:, 8] - trace), axis=1)
    branch = np.where(trace > 0, 0, np.where((m[:, 0] > m[:, 4]) & (m[:, 0] > m[:, 8]), 1, np.where(m[:, 4] > m[:, 8], 2, 3)))
    q = np.empty((len(m), 4))
    for i in range(4):
        mask = branch == i
        a = m[mask]
        v = np.sqrt(components[mask, i])
        s = .5 / v
        if i == 0:
            q[mask] = np.stack((.5 * v, (a[:, 7] - a[:, 5]) * s, (a[:, 2] - a[:, 6]) * s, (a[:, 3] - a[:, 1]) * s), axis=1)
        elif i == 1:
            q[mask] = np.stack(((a[:, 7] - a[:, 5]) * s, .5 * v, (a[:, 1] + a[:, 3]) * s, (a[:, 2] + a[:, 6]) * s), axis=1)
        elif i == 2:
            q[mask] = np.stack(((a[:, 2] - a[:, 6]) * s, (a[:, 1] + a[:, 3]) * s, .5 * v, (a[:, 5] + a[:, 7]) * s), axis=1)
        else:
            q[mask] = np.stack(((a[:, 3] - a[:, 1]) * s, (a[:, 2] + a[:, 6]) * s, (a[:, 5] + a[:, 7]) * s, .5 * v), axis=1)
    q /= np.linalg.norm(q, axis=1)[:, None]
    return q[:, [1, 2, 3, 0]].tolist()


def bit_equal(a, b):
    A, B = np.asarray(a), np.asarray(b)
    return A.shape == B.shape and np.array_equal(np.signbit(A), np.signbit(B)) and np.array_equal(np.abs(A), np.abs(B))


N = 300
cases = {'random': rand_rots(N)}
identity = np.tile(np.eye(3).ravel(), (N, 1)); cases['identity'] = identity
pi_rot = np.zeros((N, 9)); pi_rot[:, 0] = -1; pi_rot[:, 8] = -1; pi_rot[:, 4] = 1; cases['pi_rotation'] = pi_rot
eq_diag = np.zeros((N, 9)); eq_diag[:, 0] = eq_diag[:, 4] = eq_diag[:, 8] = 1; cases['equal_diagonal'] = eq_diag
tr0 = np.zeros((N, 9)); tr0[:, 0] = 1; tr0[:, 4] = -1; tr0[:, 1] = 1; tr0[:, 3] = -1; cases['trace_zero'] = tr0
neg0 = rand_rots(N); neg0[:, 1] = -0.0; cases['neg_zero'] = neg0
cases['mixed'] = np.concatenate([identity[:75], pi_rot[:75], tr0[:75], eq_diag[:75]])
for name, case in cases.items():
    a, b = old_batch(case), human.observed_quaternions_batch(case)
    assert bit_equal(a, b), f'observed_quaternions_batch 用例 {name} 与旧实现不逐位相等'
results['quaternion_cases'] = len(cases)

print('CHECK_RESULT=' + json.dumps({'pass': True, **results}))
