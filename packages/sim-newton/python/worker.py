"""Newton Provider worker：NDJSON 请求/响应协议，与 packages/sim-mujoco/python/worker.py 同形。

第一切片（最小但真实）：
- 真物理：Newton 1.6.0 + Warp 1.17.0；MJCF/URDF 由 Newton 的 ModelBuilder 真实导入并步进。
- device 可降级：auto → 有 CUDA 用 cuda:0，没有则 cpu；显式指定的设备不可用时明确报错（不静默顶替）。
- 不支持的能力（动作、接触观测、渲染、辅助附着…）一律返回结构化错误，绝不静默成功或返回假数据。
- stdout 只承载 NDJSON：库自身的 print（Warp 初始化横幅/内核装载日志）被改道到 stderr。

协议要点（与 sim-mujoco 一致）：
  请求   {"id": <int>, "method": <str>, "args": {...}}
  启动   {"event":"ready","engine":"newton","version":...,"pid":...}
  成功   {"id": <int>, "result": {...}}
  失败   {"id": <int>, "error": {"code": ..., "message": ...}}
  帧     {"event":"frame","frame":{...}}
  致命   {"event":"fatal","error":{"code":"PROVIDER_UNAVAILABLE",...}} + exit 2
"""
import copy
import gc
import hashlib
import json
import math
import os
import queue
import sys
import threading
import time
import traceback
import uuid
from urllib.parse import unquote, urlparse

import numpy as np

# 协议通道保护：先占住真实 stdout，再把 sys.stdout 指向 stderr。
# Warp 在 init/finalize 时会往 stdout 打印初始化横幅与内核装载日志，若混进 NDJSON 通道
# 会让 TS 侧逐行解析失败（虽然会被当作诊断吞掉，但协议通道必须只承载协议）。
_PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr

try:
    import newton
    import warp as wp
except ImportError as exc:  # 依赖缺失按 sim-mujoco 的写法：致命事件 + 退出码 2
    print(json.dumps({'event': 'fatal', 'error': {'code': 'PROVIDER_UNAVAILABLE', 'message': str(exc)}}),
          file=_PROTOCOL_OUT, flush=True)
    sys.exit(2)

# Warp 内核缓存目录：必须在 warp.init()（首次设备查询/首次编译）之前设置。
#
# 为什么不能"设置失败就回落 Warp 默认缓存"：会话沙箱里 `~/.cache` 是**只读**的，回落过去不会当场失败，
# 而是在第一次 JIT 编译（tick 里的窄相内核）才抛 EROFS，世界于是静默死亡（N43 实测原文：
# `OSError: [Errno 30] Read-only file system: '/home/s18/.cache/warp/1.17.0/wp_narrow_phase_…'`）。
# 现在按**既有 env 通道**逐个挑一个**真实可写**的目录；显式指定的那个不可写就当场明确报错（不退到别的、
# 也不退到只读默认），一个都不可写同样当场报错——不再有"静默死亡"这条路径。
def _writable_cache_dir(candidate):
    """候选目录是否可写：建目录 + 落一个探针文件再删掉，不靠权限位猜。"""
    if not candidate:
        return False
    try:
        os.makedirs(candidate, exist_ok=True)
        probe = os.path.join(candidate, '.lyapunov-write-probe')
        with open(probe, 'w') as handle:
            handle.write('ok')
        os.remove(probe)
        return True
    except Exception:
        return False


def resolve_cache_dir():
    """返回 (目录, 来源说明)。顺序：显式 env → 会话运行根 → XDG → 临时目录 → 工作目录。

    显式指定的 cacheRoot 不可写时**不硬失败**：宿主给的是它自己的运行根
    （实测 `…/developer/cache/provider-cache/newton`），而 worker 跑在会话沙箱里，写不进去——
    这种"请求的目录用不了、但会话里另有可写位置"的情形应当**改用可写位置并如实记下**（note 里带原文），
    否则 Newton 在正常会话里永远起不来。只有**一个可写候选都没有**时才当场报错（不再静默死亡）。
    """
    tried = []
    explicit = os.environ.get('LYAPUNOV_NEWTON_CACHE_ROOT', '').strip()
    if explicit:
        if _writable_cache_dir(explicit):
            return explicit, 'LYAPUNOV_NEWTON_CACHE_ROOT=' + explicit
        tried.append(explicit)
    runtime_root = os.environ.get('LYAPUNOV_SIM_RUNTIME_ROOT', '').strip()
    candidates = []
    if runtime_root:
        candidates.append((os.path.join(runtime_root, 'cache', 'warp'), 'LYAPUNOV_SIM_RUNTIME_ROOT=' + runtime_root))
    xdg = os.environ.get('XDG_CACHE_HOME', '').strip()
    if xdg:
        candidates.append((os.path.join(xdg, 'warp'), 'XDG_CACHE_HOME=' + xdg))
    candidates.append((os.path.join(os.environ.get('TMPDIR', '').strip() or '/tmp',
                                    'lyapunov-warp-' + str(getattr(wp, '__version__', 'unknown'))), 'TMPDIR/临时目录'))
    candidates.append((os.path.join(os.getcwd(), '.warp-cache'), 'worker 工作目录'))
    for path, source in candidates:
        tried.append(path)
        if _writable_cache_dir(path):
            note = source
            if explicit:
                note += '（显式 LYAPUNOV_NEWTON_CACHE_ROOT=' + explicit + ' 不可写，已改用这里）'
                print('[sim-newton] WARNING 显式 Warp 缓存目录不可写，改用 ' + path + '（来源：' + source + '）',
                      file=sys.stderr, flush=True)
            return path, note
    raise RuntimeError('找不到可写的 Warp 内核缓存目录（试过：' + '，'.join(tried) + '）')


_CACHE_ROOT = ''
_CACHE_NOTE = None
try:
    _CACHE_ROOT, _CACHE_SOURCE = resolve_cache_dir()
    wp.config.kernel_cache_dir = _CACHE_ROOT
    # note 的 token 叫 configured_cache_root=：装的是**配置的基目录**（`warp.init()` 之前设进去的值，没有
    # warp 版本子目录）——**不是**「实际生效目录」（那是 `<这个值>/<warp 版本>`，见 ready/capabilities 的
    # kernelCacheDir）。**刻意不叫 `kernel_cache_dir=`**：那个名字与 Warp init 之后回读的
    # `wp.config.kernel_cache_dir` 同名，会被读成生效目录。名字与值必须说同一件事。
    _CACHE_NOTE = 'configured_cache_root=' + _CACHE_ROOT + '（来源：' + _CACHE_SOURCE + '）'
except Exception as exc:
    # 缓存不可写不是"环境本来就坏"：Newton 在正常会话里必须能跑；跑不了就**当场**说清路径与原因。
    print(json.dumps({'event': 'fatal', 'error': {'code': 'PROVIDER_DEPENDENCY_MISSING',
                                                  'message': 'Warp 内核缓存不可写，Newton 无法在本次会话编译内核: ' + str(exc)}}),
          file=_PROTOCOL_OUT, flush=True)
    sys.exit(2)


def emit(value):
    """唯一写协议通道的出口；所有状态数组在 RPC/帧边界复制成 JSON 原生类型。"""
    print(json.dumps(value, allow_nan=False, separators=(',', ':')), file=_PROTOCOL_OUT, flush=True)


class SimError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def finite(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise SimError('INVALID_ARGUMENT', name + ' 必须是有限数值')
    return float(value)


def positive(value, name):
    v = finite(value, name)
    if v <= 0:
        raise SimError('INVALID_ARGUMENT', name + ' 必须大于零')
    return v


def path_from_uri(value):
    """file:// URI / 绝对路径 / 相对路径 → 本地路径（与 sim-mujoco 同一口径）。"""
    text = str(value)
    parsed = urlparse(text)
    if parsed.scheme == 'file':
        return unquote(parsed.path)
    return text


def quat_mul(a, b):
    """xyzw 四元数乘法（合同坐标约定：quaternion 为 xyzw）。"""
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return np.array([
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ], dtype=float)


def quat_rotate(q, v):
    """用 xyzw 单位四元数旋转三维向量。"""
    x, y, z, w = q
    t = 2.0 * np.cross([x, y, z], v)
    return np.asarray(v) + w * t + np.cross([x, y, z], t)


def world_poses(scene):
    """实体层级 → 世界系 (position, quaternion_xyzw, scale)（与 sim-mujoco 的 world_poses 同语义）。"""
    entities = {e['entityId']: e for e in scene['entities']}
    result = {}
    active = set()

    def get(eid):
        if eid in result:
            return result[eid]
        if eid in active:
            raise SimError('INVALID_SCENE', '实体层级成环')
        active.add(eid)
        e = entities[eid]
        t = e['transform']
        p = np.array(t['position'], dtype=float)
        q = np.array(t['quaternion'], dtype=float)
        if not np.isfinite(p).all() or not np.isfinite(q).all() or np.linalg.norm(q) < 1e-8:
            raise SimError('INVALID_SCENE', '变换含非法值')
        q = q / np.linalg.norm(q)
        scale = np.array(t.get('scale', [1, 1, 1]), dtype=float)
        if e.get('parentId'):
            pp, pq, ps = get(e['parentId'])
            p = pp + quat_rotate(pq, p * ps)
            q = quat_mul(pq, q)
            scale = scale * ps
        result[eid] = (p, q, scale)
        active.remove(eid)
        return result[eid]

    for eid in entities:
        get(eid)
    return result


def native_source(entity):
    """实体声明的 MJCF/URDF 原生源。

    与 sim-mujoco 相同口径：先看 components.mujoco.sourcePath/xml，
    再从 resources 里找 mjcf/urdf 的表示。Newton 只做导入与仿真，不做资产转换。
    """
    cfg = entity.get('components', {}).get('mujoco', {})
    if cfg.get('sourcePath') or cfg.get('xml'):
        return cfg
    for r in entity.get('resources', []):
        for rep in [*r.get('representations', []), r.get('original', {})]:
            uri = rep.get('uri', '')
            if rep.get('mimeType') in ['application/x-mjcf+xml', 'application/mjcf+xml', 'application/x-urdf+xml', 'application/urdf+xml'] or uri.endswith(('.xml', '.urdf')):
                return {**cfg, 'sourcePath': path_from_uri(uri)}
    return None


def is_ground_shape_name(name):
    lowered = str(name).lower()
    return 'floor' in lowered or 'ground' in lowered


# ---------------------------------------------------------------------------
# 能力表：本切片真实支持什么、明确不支持什么。握手与 capabilities 方法原样交出。
# ---------------------------------------------------------------------------
ACTION_KINDS = ['trajectory', 'joint', 'vehicle', 'lift', 'gripper', 'gait', 'control', 'thrust', 'tendon', 'batch']
# 动作拒绝码：**一处定义**。声明表（CAPABILITIES.unsupported.execute）、describe 的 6 条 reason 前缀、
# execute 的真实拒绝码全部从这一个常量出 —— 判定与拒绝同源，不靠人在多处抄同一个字面量。
# 值就是线上码（合同/README 都按这个字符串读），改它等于改协议。
ACTION_UNSUPPORTED_CODE = 'ACTION_UNSUPPORTED'

# 需要 worldId 的方法（其余方法名一律 UNKNOWN_METHOD，不让「未知方法」被世界查询掩盖）。
WORLD_METHODS = {'sync', 'observe', 'describe', 'handle', 'stop', 'receipt', 'execute', 'assist',
                 'capture', 'capture_multi', 'camera_list', 'camera_adjust',
                 'camera_project_annotation', 'camera_dataset_export', 'close'}

CAPABILITIES = {
    'engine': 'newton',
    'slice': 'minimal-1',
    'supported': {
        'open': True,
        'sync': True,
        'observe': True,
        'describe': True,
        'close': True,
        'list_worlds': True,
        'mjcf': True,
        'urdf': True,
        'groundPlane': True,
        'realtimeClock': True,
        'freeBodies': True,
        'articulatedJoints': True,
    },
    'unsupported': {
        'execute': {kind: ACTION_UNSUPPORTED_CODE for kind in ACTION_KINDS},
        'observe.contacts': 'UNSUPPORTED_CAPABILITY',
        'observe.penetrations': 'UNSUPPORTED_CAPABILITY',
        'observe.sensors.sites': 'UNSUPPORTED_CAPABILITY',
        'observe.tendons': 'UNSUPPORTED_CAPABILITY',
        'capture': 'UNSUPPORTED_CAPABILITY',
        'captureMulti': 'UNSUPPORTED_CAPABILITY',
        'cameraList': 'UNSUPPORTED_CAPABILITY',
        'cameraAdjust': 'UNSUPPORTED_CAPABILITY',
        'cameraProjectAnnotation': 'UNSUPPORTED_CAPABILITY',
        'cameraDatasetExport': 'UNSUPPORTED_CAPABILITY',
        'assist': 'UNSUPPORTED_CAPABILITY',
        'collisionPatches': 'UNSUPPORTED_CAPABILITY',
        'sceneCollisionCompilation': 'UNSUPPORTED_CAPABILITY',
        'manualClockAdvance': 'UNSUPPORTED_CAPABILITY',
    },
    'notes': [
        '第一切片只支持「Scene 实体的 MJCF/URDF 原生源 + 地面」这一最小世界；没有原生源的实体按纯视觉跳过并带结构化告警 ENTITY_SKIPPED_NO_NATIVE_SOURCE，不静默。',
        'manual 时钟下没有任何动作可驱动，世界不会自行推进（不假装推进）；真步进请用 realtime 时钟。',
        'joints.positions/velocities 用 Newton eval_ik 从 body_q/body_qd 反解；自由根的速度按 Newton 自身的约定 (v_com_world, omega_world) 报告，字段名与 MuJoCo 的自由根速度约定（世界线速度 + 本地角速度）不同，见 README。',
        'STOP 在没有任何动作的切片里是空真值（receipts=[]、affectedEntityIds=[]），不伪造停止回执。',
        '含 mesh 资产的 MJCF/URDF 需要 Newton 的 importers extra（trimesh 等）：缺失时 open/sync 明确报 PROVIDER_DEPENDENCY_MISSING 并给出安装方式，不会退化成「场景非法」。',
    ],
}
CAPABILITIES['supported']['execute'] = False


NEWTON_VERSION = getattr(newton, '__version__', 'unknown')
WARP_VERSION = getattr(wp, '__version__', 'unknown')
# newton.MAXVAL 是「无位置限位」的哨兵（joint_limit_lower/upper 用 ±MAXVAL 表示不限）；
# 1e6 是 ModelBuilder.default_joint_cfg.effort_limit 的默认值，等于「没有显式力限」。
MAXVAL = float(getattr(newton, 'MAXVAL', 1e10))
EFFORT_DEFAULT = 1e6


def resolve_device(requested):
    """设备选择与降级。

    - 'auto'（默认）：有 CUDA 设备用 cuda:0，否则 cpu（降级带 note）。
    - 'cpu' / 'cuda:N'：显式指定；不可用即明确失败，绝不静默顶替成别的设备。
    返回 (device_string, kind, degraded: bool, note: str)。
    """
    requested = (requested or os.environ.get('LYAPUNOV_NEWTON_DEVICE') or 'auto').strip()
    cuda_devices = []
    cuda_error = None
    if requested == 'cpu':
        return 'cpu', 'cpu', False, '显式选择 cpu'
    try:
        cuda_devices = [str(d) for d in wp.get_cuda_devices()]
    except Exception as exc:  # 驱动/运行时缺失时按「没有 CUDA」处理，auto 仍可降级
        cuda_error = str(exc)
    if requested == 'auto':
        if cuda_devices:
            return cuda_devices[0], 'cuda', False, 'auto：检测到 CUDA 设备 ' + cuda_devices[0]
        return 'cpu', 'cpu', True, 'auto：没有可用 CUDA 设备（' + (cuda_error or 'wp.get_cuda_devices() 为空') + '），已降级到 cpu'
    if requested not in cuda_devices:
        raise SimError('UNSUPPORTED_CAPABILITY',
                       '显式指定的设备不可用: ' + requested + '（可见 CUDA 设备: ' + (', '.join(cuda_devices) or '无') + '）'
                       + ('；探测错误: ' + cuda_error if cuda_error else ''))
    return requested, 'cuda', False, '显式选择 ' + requested


class World:
    """一个 Newton 世界的全部原生状态与唯一物理循环入口（tick）。"""

    def __init__(self, scene, options):
        self.id = options.get('worldId') or str(uuid.uuid4())
        self.options = copy.deepcopy(options)
        self.clock = options.get('clock', 'realtime')
        if self.clock not in ('realtime', 'manual'):
            raise SimError('INVALID_ARGUMENT', 'clock 必须为 realtime 或 manual')
        self.dt = positive(options.get('timestepS', 1.0 / 500.0), 'timestepS')
        self.factor = positive(options.get('realtimeFactor', 1), 'realtimeFactor')
        self.frame_hz = positive(options.get('frameRateHz', 30), 'frameRateHz')
        self.ground = options.get('ground', True) is not False
        device, kind, degraded, note = resolve_device(options.get('device'))
        self.device = device
        self.device_kind = kind
        self.device_degraded = degraded
        self.device_note = note
        self.generation = 1
        self.applied_revision = -1
        self.step_index = 0
        self.sim_time = 0.0
        self.scene = None
        self.status = 'unavailable'
        # 世界为什么不可用（tick/编译失败的原话）：status 变 unavailable 时**不静默**——
        # 句柄把它带回产品侧（sim_world_list/state 的 statusReason），否则调用方只看到
        # "unavailable" 一个词，查不出是设备、依赖还是场景本身的问题（N43/DEV-008 实测）。
        self.status_reason = None
        self.warnings = []
        self.ground_names = []
        self.entities = {}
        # 原生句柄：close 时逐一丢弃（Warp 没有显式 dispose，释放靠丢引用 + gc）
        self.builder = None
        self.model = None
        self.state_a = None
        self.state_b = None
        self.control = None
        self.solver = None
        self.pipeline = None
        self.contacts = None
        self.ik_q = None
        self.ik_qd = None
        self.signature = None
        self.next_tick = time.monotonic()
        self.last_frame = 0.0
        self.sync(scene, initial=True)

    # -- 世界句柄 -----------------------------------------------------------
    def handle(self):
        return {
            'worldId': self.id,
            'sceneId': self.scene['sceneId'],
            'engineId': 'newton',
            'engineVersion': NEWTON_VERSION,
            'worldGeneration': self.generation,
            'appliedSceneRevision': self.applied_revision,
            'status': self.status,
            'clock': self.clock,
            'timestepS': float(self.dt),
            # Newton 切片不提供接触通道（见 capabilities），这里的名字只是 Newton shape label，
            # 用于标识世界里的地面几何，不参与任何接触过滤。
            'groundGeomNames': list(self.ground_names),
            'warnings': [dict(w) for w in self.warnings],
            # 以下是本 Provider 的加法字段（sim-mujoco 没有），如实交代真实设备与求解器。
            'device': self.device,
            'deviceKind': self.device_kind,
            'deviceDegraded': self.device_degraded,
            'deviceNote': self.device_note,
            'solver': self.solver_name,
            'warpVersion': WARP_VERSION,
            # 配置的 Warp 内核缓存基目录（= warp.init() 之前设进 wp.config.kernel_cache_dir 的值，来源见 note）
            # ——**不是**"实际生效目录"：warp 会在它下面再挂 `<warp 版本>` 子目录，真正生效的是
            # ready/capabilities 的 kernelCacheDir（那个值取自 init 之后，带版本子目录）。两者同名不同义。
            # 会话可写性出问题时，调用方从 sim_world_list 仍能看出**本次配置**的缓存根，不用去猜"环境本来就坏"。
            'kernelCacheDir': _CACHE_ROOT or None,
            **({'kernelCacheNote': _CACHE_NOTE} if _CACHE_NOTE else {}),
            # status=unavailable 时带上原因（tick/编译失败原话）；可用时不出现这个键，不制造噪音。
            **({'statusReason': self.status_reason} if self.status_reason else {}),
        }

    def require_ready(self):
        if self.status not in ('ready', 'running') or self.model is None:
            reason = (': ' + self.status_reason) if self.status_reason else ''
            raise SimError('WORLD_UNAVAILABLE', '世界未同步或已关闭: ' + self.status + reason)

    def fault(self, error):
        """Transition a world to unavailable and release native handles immediately.

        A failed realtime tick must not retain a partially valid model/state pair:
        callers may inspect the status reason, but no later observe/step may touch
        the faulted Newton/Warp objects.
        """
        self.status = 'unavailable'
        self.status_reason = type(error).__name__ + ': ' + str(error)
        self.builder = None
        self.model = None
        self.state_a = self.state_b = None
        self.control = None
        self.solver = None
        self.pipeline = None
        self.contacts = None
        self.ik_q = self.ik_qd = None
        self.entities = {}
        gc.collect()

    # -- 编译 ---------------------------------------------------------------
    def physics_signature(self, scene):
        """只覆盖影响物理的字段（与 sim-mujoco 同口径：revision／标签／颜色不参与签名）。

        签名包含本切片真正消费的全部物理输入：实体层级与位姿、解析出的 MJCF/URDF 原生源、
        地面开关、步长与设备。签名不变时 sync 只推进 appliedSceneRevision，不重编译。
        """
        payload = {
            'sceneId': scene.get('sceneId'),
            'ground': self.ground,
            'timestepS': self.dt,
            'device': self.device,
            'entities': [],
        }
        for e in scene.get('entities', []):
            cfg = native_source(e)
            payload['entities'].append({
                'entityId': e.get('entityId'),
                'parentId': e.get('parentId'),
                'transform': e.get('transform'),
                'source': None if cfg is None else {'sourcePath': cfg.get('sourcePath'), 'xml': cfg.get('xml')},
            })
        return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()

    def _import_entity(self, builder, eid, entity, cfg, pose):
        """把一个实体的 MJCF/URDF 原生源导入 builder，返回该实体在模型里的下标区间。"""
        p, q, scale = pose
        if not np.allclose(scale, [1, 1, 1]):
            raise SimError('UNSUPPORTED_CAPABILITY',
                           'Newton 切片不接受实体缩放（scale=' + str(scale.tolist()) + '），须先由资产适配器物理化: ' + eid)
        xform = wp.transform(wp.vec3(float(p[0]), float(p[1]), float(p[2])),
                             wp.quat(float(q[0]), float(q[1]), float(q[2]), float(q[3])))
        body_start, joint_start, shape_start = builder.body_count, builder.joint_count, builder.shape_count
        source_path = cfg.get('sourcePath')
        try:
            if source_path:
                path = path_from_uri(source_path)
                if not os.path.isfile(path):
                    raise SimError('SOURCE_NOT_FOUND', '实体 ' + eid + ' 的原生源文件不存在: ' + str(path))
                if os.path.splitext(path)[1].lower() == '.urdf':
                    builder.add_urdf(path, xform=xform)
                else:
                    # xform 与 MJCF 自身的内部姿态复合（根 body 不在原点时结果 = scenePose ∘ mjcfRoot）。
                    builder.add_mjcf(path, xform=xform)
            else:
                builder.add_mjcf(cfg['xml'], xform=xform)
        except ModuleNotFoundError as exc:
            # Newton 的 importers extra（trimesh/scipy/meshio/…）不在最小依赖里：带 mesh 资产的
            # MJCF/URDF 会在这里失败。明确归因到缺失的包与安装方式，不冒充「场景非法」。
            raise SimError('PROVIDER_DEPENDENCY_MISSING',
                           '实体 ' + eid + ' 的 MJCF/URDF 导入缺少 Newton 的可选依赖 ' + str(exc.name)
                           + '（含 mesh 资产的模型需要 Newton 的 importers extra）。'
                           + '安装（部署方执行）：uv pip install --python ' + sys.executable + ' "newton[importers]"'
                           + ' 或最小集 "trimesh>=4.6.8"') from exc
        return body_start, builder.body_count, joint_start, builder.joint_count, shape_start, builder.shape_count

    def compile(self, scene):
        """把 Scene 编译成真实的 Newton 模型；失败即抛结构化错误，不产出半成品世界。"""
        builder = newton.ModelBuilder()
        ground_names = []
        skipped = []
        if self.ground:
            builder.add_ground_plane(label='__ground')
            ground_names.append('__ground')
        poses = world_poses(scene)
        maps = {}
        for e in scene['entities']:
            eid = e['entityId']
            cfg = native_source(e)
            if not cfg:
                skipped.append({'code': 'ENTITY_SKIPPED_NO_NATIVE_SOURCE', 'entityId': eid,
                                'message': '实体 ' + eid + ('（' + str(e['name']) + '）' if e.get('name') else '')
                                           + ' 没有 MJCF/URDF 原生源（components.mujoco.sourcePath/xml 或 mjcf/urdf resource），已在物理装配中跳过'})
                continue
            bodies = self._import_entity(builder, eid, e, cfg, poses[eid])
            maps[eid] = {'bodyStart': bodies[0], 'bodyEnd': bodies[1], 'jointStart': bodies[2], 'jointEnd': bodies[3],
                         'shapeStart': bodies[4], 'shapeEnd': bodies[5], 'source': cfg.get('sourcePath') or 'inline-xml'}
        model = builder.finalize(device=self.device)
        states = (model.state(), model.state())
        control = model.control()
        solver_name = os.environ.get('LYAPUNOV_NEWTON_SOLVER', 'xpbd').strip().lower()
        if solver_name == 'semi':
            # SolverSemiImplicit 在实测的三关节臂上会发散成 NaN（见 bugfixHistory 回执），
            # 因此默认不用它；显式要求时才启用，并如实记录在 handle.solver。
            solver = newton.solvers.SolverSemiImplicit(model)
        elif solver_name == 'xpbd':
            solver = newton.solvers.SolverXPBD(model, iterations=4)
        else:
            raise SimError('INVALID_ARGUMENT', 'LYAPUNOV_NEWTON_SOLVER 只支持 xpbd/semi，收到: ' + solver_name)
        pipeline = newton.CollisionPipeline(model)
        contacts = pipeline.contacts()
        ik_q = wp.zeros(model.joint_coord_count, dtype=float, device=self.device)
        ik_qd = wp.zeros(model.joint_dof_count, dtype=float, device=self.device)

        joint_types = model.joint_type.numpy().tolist()
        joint_labels = list(model.joint_label)
        body_labels = list(model.body_label)
        shape_labels = list(model.shape_label)
        shape_types = model.shape_type.numpy().tolist()
        q_start = model.joint_q_start.numpy().tolist()
        qd_start = model.joint_qd_start.numpy().tolist()
        dof_dim = model.joint_dof_dim.numpy().tolist()
        limit_lo = model.joint_limit_lower.numpy().tolist()
        limit_hi = model.joint_limit_upper.numpy().tolist()
        target_ke = model.joint_target_ke.numpy().tolist()
        target_kd = model.joint_target_kd.numpy().tolist()
        effort = model.joint_effort_limit.numpy().tolist()
        entity_maps = {}
        for eid, m in maps.items():
            root = m['bodyStart']
            joints, free_joints = [], []
            for j in range(m['jointStart'], m['jointEnd']):
                jtype = int(joint_types[j])
                entry = {'index': j, 'label': joint_labels[j], 'type': jtype,
                         'coord': int(q_start[j]), 'dof': int(qd_start[j]), 'dofDim': dof_dim[j]}
                if jtype == int(newton.JointType.REVOLUTE) or jtype == int(newton.JointType.PRISMATIC):
                    entry['unit'] = 'm' if jtype == int(newton.JointType.PRISMATIC) else 'rad'
                    entry['kind'] = 'slide' if jtype == int(newton.JointType.PRISMATIC) else 'hinge'
                    # joint_limit_*/joint_target_ke/kd/joint_effort_limit 都是**每 DOF** 数组
                    # （shape=[joint_dof_count]），标量关节的 dof 号就是它的 qd_start。
                    d = entry['dof']
                    if math.isfinite(limit_lo[d]) and math.isfinite(limit_hi[d]) and limit_lo[d] < limit_hi[d] \
                            and abs(limit_lo[d]) < MAXVAL * 0.999 and abs(limit_hi[d]) < MAXVAL * 0.999:
                        entry['range'] = [float(limit_lo[d]), float(limit_hi[d])]
                    # 只报告真正显式声明过的力限：Newton 的默认上限（1e6）等于「没限」，报出来会误导。
                    if math.isfinite(effort[d]) and effort[d] < EFFORT_DEFAULT:
                        entry['driveMaxEffort'] = float(effort[d])
                    # 引擎侧该关节的隐式 PD 增益（MJCF 的 kp/kv 被导入到这里），如实回读。
                    if math.isfinite(target_ke[d]):
                        entry['driveStiffness'] = float(target_ke[d])
                    if math.isfinite(target_kd[d]):
                        entry['driveDamping'] = float(target_kd[d])
                    joints.append(entry)
                elif jtype == int(newton.JointType.FREE):
                    free_joints.append(entry)
            entity_maps[eid] = {
                'entity': copy.deepcopy(e),
                'rootBody': root,
                'bodyLabels': body_labels[m['bodyStart']:m['bodyEnd']],
                'joints': joints,
                'freeJoints': free_joints,
                'shapeLabels': shape_labels[m['shapeStart']:m['shapeEnd']],
                'source': m['source'],
            }
            for label in shape_labels[m['shapeStart']:m['shapeEnd']]:
                if is_ground_shape_name(label):
                    ground_names.append(label)
        # 与 sim-mujoco 同语义：options.ground !== false 时总是铺一块 __ground 平面。
        # 导入的 MJCF 自带 floor 平面时会与它共面重合（同一高程的两层平面，物理上无害）；
        # 需要单一地面时由调用方传 ground:false，本 Provider 不替调用方猜。
        for s in range(model.shape_count):
            if int(shape_types[s]) == int(newton.GeoType.PLANE) and shape_labels[s] not in ground_names:
                ground_names.append(shape_labels[s])
        for w in skipped:
            print('[sim-newton] WARNING ' + w['message'], file=sys.stderr, flush=True)
        return {'builder': builder, 'model': model, 'states': states, 'control': control, 'solver': solver,
                'solverName': solver_name, 'pipeline': pipeline, 'contacts': contacts, 'ik_q': ik_q, 'ik_qd': ik_qd,
                'entities': entity_maps, 'ground': ground_names, 'warnings': skipped}

    def sync(self, scene, force=False, initial=False):
        if self.scene and scene['sceneId'] != self.scene['sceneId']:
            raise SimError('SCENE_MISMATCH', 'world 不能绑定另一个 scene')
        if scene['revision'] < self.applied_revision:
            return self.handle()
        signature = self.physics_signature(scene)
        if self.scene and not force and signature == self.signature and self.status in ('ready', 'running'):
            self.scene = copy.deepcopy(scene)
            self.applied_revision = scene['revision']
            return self.handle()
        try:
            compiled = self.compile(scene)
        except Exception as exc:
            if self.scene is None:
                self.status = 'unavailable'
                self.status_reason = 'COMPILE_FAILED: ' + str(exc)
                self.scene = copy.deepcopy(scene)
                raise
            if isinstance(exc, SimError):
                raise
            raise SimError('COMPILE_FAILED', '场景重编译失败，上一可用世界已完整保留: ' + str(exc)) from exc
        # 编译成功才原子替换运行中的世界；旧代次的原生句柄在此丢弃。
        # builder 与 model 同寿命保留：MJCF/URDF 的网格等资产归它所有，不能让它在 model 之前被回收。
        self.builder = compiled['builder']
        self.model = compiled['model']
        self.state_a, self.state_b = compiled['states']
        self.control = compiled['control']
        self.solver = compiled['solver']
        self.solver_name = compiled['solverName']
        self.pipeline = compiled['pipeline']
        self.contacts = compiled['contacts']
        self.ik_q, self.ik_qd = compiled['ik_q'], compiled['ik_qd']
        self.entities = compiled['entities']
        self.ground_names = compiled['ground']
        self.warnings = compiled['warnings']
        self.scene = copy.deepcopy(scene)
        self.signature = signature
        self.applied_revision = scene['revision']
        if not initial:
            self.generation += 1
        self.step_index = 0
        self.sim_time = 0.0
        self.next_tick = time.monotonic()
        self.status = 'ready'
        self.status_reason = None
        gc.collect()
        return self.handle()

    # -- 观测 ---------------------------------------------------------------
    def _read_joint_arrays(self):
        """用 Newton 的 eval_ik 从 body 状态反解广义坐标（求解器只积分 body_q/body_qd）。"""
        newton.eval_ik(self.model, self.state_a, self.ik_q, self.ik_qd)
        return self.ik_q.numpy(), self.ik_qd.numpy()

    def observe(self, selection=None):
        self.require_ready()
        selection = selection or {}
        if selection.get('contacts'):
            # Newton 1.6.0 的标准碰撞管线不暴露逐接触的有符号距离（MuJoCo contact.dist 口径），
            # 于是不能按合同给出 distanceM/penetrations；明确拒绝而不是给出半真数据。
            raise SimError('UNSUPPORTED_CAPABILITY',
                           'Newton Provider 切片未实现 contacts/penetrations 观测：Newton 1.6.0 的 CollisionPipeline '
                           '不暴露逐接触有符号距离，无法按合同字段如实给出；不返回估算值')
        only = selection.get('entityIds')
        ik_q, ik_qd = self._read_joint_arrays()
        body_q = self.state_a.body_q.numpy()
        body_qd = self.state_a.body_qd.numpy()
        scene_poses = None
        entities = []
        for e in self.scene['entities']:
            eid = e['entityId']
            if only and eid not in only:
                continue
            info = self.entities.get(eid)
            if not info:
                if scene_poses is None:
                    scene_poses = world_poses(self.scene)
                p, q, scale = scene_poses[eid]
                entities.append({'entityId': eid, 'transform': {'position': p.tolist(), 'quaternion': q.tolist(), 'scale': scale.tolist()}})
                continue
            b = info['rootBody']
            pose = body_q[b]
            item = {
                'entityId': eid,
                'transform': {'position': [float(v) for v in pose[0:3]],
                              'quaternion': [float(v) for v in pose[3:7]],
                              'scale': list(e['transform'].get('scale', [1, 1, 1]))},
                'joints': {'names': [j['label'] for j in info['joints']],
                           'positions': [float(ik_q[j['coord']]) for j in info['joints']],
                           'velocities': [float(ik_qd[j['dof']]) for j in info['joints']]},
            }
            if selection.get('sensors', True):
                # body_qd 的约定（Newton State 文档）：前三项 = 相对质心的世界系线速度，后三项 = 世界系角速度；
                # 与 MuJoCo cvel 的 [rot; tran] 世界系口径一致，故沿用 sim-mujoco 的字段名。
                sensors = {'bodyLinearVelocityMps': [float(v) for v in body_qd[b][0:3]],
                           'bodyAngularVelocityRadps': [float(v) for v in body_qd[b][3:6]],
                           'velocityConvention': 'newton-body-twist (v_com_world, omega_world)'}
                if info['freeJoints']:
                    sensors['freeBases'] = {j['label']: self._free_base(j, body_q, body_qd) for j in info['freeJoints']}
                item['sensors'] = sensors
            entities.append(item)
        frame = {
            'worldId': self.id,
            'generation': self.generation,
            'sceneRevision': self.applied_revision,
            'stepIndex': self.step_index,
            'simTime': float(self.step_index * self.dt),
            'frameId': f'{self.id}:{self.generation}:{self.step_index}',
            'entities': entities,
        }
        # 本切片没有辅助/附着通道，如实标 physical-contact、辅助累计恒为 0。
        frame['executionMode'] = 'physical-contact'
        frame['assistAdvanceCount'] = 0
        frame['device'] = self.device
        return frame

    def _free_base(self, joint, body_q, body_qd):
        """自由根的真实状态。位置/姿态是 body 帧世界位姿（xyzw）；速度按 Newton 自身约定，
        字段名与本仓库 MuJoCo Provider 的自由根速度字段（世界线速度 + 本地角速度）刻意不同，
        避免把不同约定当成同一语义消费。"""
        b = self._body_of_free_joint(joint)
        pose, vel = body_q[b], body_qd[b]
        return {
            'jointName': joint['label'],
            'bodyName': self._body_label(b),
            'positionM': [float(v) for v in pose[0:3]],
            'quaternionXyzw': [float(v) for v in pose[3:7]],
            'linearVelocityComWorldMps': [float(v) for v in vel[0:3]],
            'angularVelocityWorldRadps': [float(v) for v in vel[3:6]],
            'velocityConvention': 'newton-body-twist (v_com_world, omega_world)',
        }

    def _body_of_free_joint(self, joint):
        body = int(self.model.joint_child.numpy()[joint['index']])
        if body < 0:
            raise SimError('ENGINE_ERROR', '自由关节没有子 body: ' + joint['label'])
        return body

    def _body_label(self, index):
        labels = list(self.model.body_label)
        return labels[index] if 0 <= index < len(labels) else str(index)

    def describe(self, eid):
        self.require_ready()
        info = self.entities.get(eid)
        if not info:
            raise SimError('ENTITY_NOT_SIMULATED', '实体没有已加载的物理表示: ' + eid)
        joints = []
        for j in info['joints']:
            item = {'name': j['label'], 'type': j['kind'], 'unit': j['unit']}
            if 'range' in j:
                item['range'] = list(j['range'])
            if 'driveMaxEffort' in j:
                item['driveMaxEffort'] = j['driveMaxEffort']
            if 'driveStiffness' in j:
                item['driveStiffness'] = j['driveStiffness']
            if 'driveDamping' in j:
                item['driveDamping'] = j['driveDamping']
            joints.append(item)
        free_bases = [{'jointName': j['label'], 'bodyName': self._body_label(self._body_of_free_joint(j))} for j in info['freeJoints']]
        return {
            'entityId': eid,
            'modelVersion': str(info['source']),
            'expectedGeneration': self.generation,
            'collisionContextVersion': str(self.generation),
            'joints': joints,
            # 本切片不驱动任何关节（没有执行器映射/控制通道），受控关节列表为空而不是伪造。
            'controlledJointNames': [],
            'tendonActuators': [],
            'freeBases': free_bases,
            'controller': {},
            # 合同的 RobotCapability.kind 是**封闭 6 元组**（thrust/vehicle/joint/gripper/lift/control）：
            # 少报一条就等于让调用方"点了才知道"（DEV-008）。这里 6 条全部逐项交出，available 一律 false，
            # reason 前缀就是执行侧 execute 真实返回的码（ACTION_UNSUPPORTED_CODE）——**同一个常量**，
            # 不是三处各抄一遍字面量（判定与拒绝同源）。
            'capabilities': [
                {'kind': 'joint', 'available': False, 'reason': ACTION_UNSUPPORTED_CODE + ': Newton 第一切片没有关节控制通道'},
                {'kind': 'thrust', 'available': False, 'reason': ACTION_UNSUPPORTED_CODE + ': Newton 第一切片没有 wrench/执行器通道'},
                {'kind': 'vehicle', 'available': False, 'reason': ACTION_UNSUPPORTED_CODE + ': Newton 第一切片没有车轮/转向映射'},
                {'kind': 'gripper', 'available': False, 'reason': ACTION_UNSUPPORTED_CODE + ': Newton 第一切片没有 controller.gripper 映射与执行器写回通道'},
                {'kind': 'lift', 'available': False, 'reason': ACTION_UNSUPPORTED_CODE + ': Newton 第一切片没有 controller.lift 映射与执行器写回通道'},
                {'kind': 'control', 'available': False, 'reason': ACTION_UNSUPPORTED_CODE + ': Newton 第一切片没有执行器写回通道（manual 时钟下也没有任何东西能推进）'},
            ],
            # controlledJointNames 恒为空的原因（合同里这一项就是"为什么受控列表是空的"的如实出口）：
            # 不是"这台机器人关节都被动"，而是这个 Provider 根本没有动作/控制通道。
            'controlMetadata': {'status': 'UNAVAILABLE',
                                'reason': 'Newton 第一切片没有动作/控制通道（capabilities.execute 全部 ' + ACTION_UNSUPPORTED_CODE + '）：'
                                          'controlledJointNames 恒为空，导入的执行器目标保持模型初值，不冒充受控关节'},
            # 加法字段：Newton 自己的关节标签与形状标签，便于调用方定位原生对象。
            'nativeJointLabels': [j['label'] for j in info['joints']] + [j['label'] for j in info['freeJoints']],
            'nativeShapeLabels': list(info['shapeLabels']),
            'device': self.device,
        }

    # -- 物理 ---------------------------------------------------------------
    def tick(self):
        if self.status not in ('ready', 'running'):
            return
        if self.clock == 'manual':
            # 没有动作通道 ⇒ 没有可推进的窗口；manual 世界保持冻结（如实，不假装步进）。
            return
        self.state_a.clear_forces()
        self.pipeline.collide(self.state_a, self.contacts)
        self.solver.step(self.state_a, self.state_b, self.control, self.contacts, self.dt)
        self.state_a, self.state_b = self.state_b, self.state_a
        self.step_index += 1
        self.sim_time = self.step_index * self.dt
        now = time.monotonic()
        if now - self.last_frame >= 1.0 / self.frame_hz:
            emit({'event': 'frame', 'frame': self.observe()})
            self.last_frame = now

    def stop(self, selection):
        """本切片没有任何可接受的动作，停止集合恒为空；返回真实空集而不是伪造回执。"""
        selection = selection or {}
        if selection.get('actionId'):
            raise SimError('ACTION_NOT_FOUND', 'actionId 未知（Newton 切片未接受过任何动作）: ' + str(selection['actionId']))
        self.require_ready()
        return {'stopped': True, 'stepIndex': self.step_index, 'receipts': [], 'affectedEntityIds': []}

    def close(self):
        if self.status == 'closed':
            return
        self.status = 'closed'
        # 丢弃全部 Newton/Warp 原生句柄：Warp 没有显式 dispose，数组按其分配器在引用归零后回收。
        self.builder = None
        self.model = None
        self.state_a = self.state_b = None
        self.control = None
        self.solver = None
        self.pipeline = None
        self.contacts = None
        self.ik_q = self.ik_qd = None
        self.entities = {}
        self.scene = None
        gc.collect()


requests = queue.Queue()


def read_requests():
    for line in sys.stdin:
        try:
            requests.put(json.loads(line))
        except Exception as exc:
            emit({'event': 'protocol-error', 'error': str(exc)})
    requests.put({'method': 'shutdown', 'id': '__eof'})


def main():
    try:
        device, kind, degraded, note = resolve_device(None)
    except Exception as exc:
        # 连 cpu 都不可用：按依赖缺失的写法致命退出。
        emit({'event': 'fatal', 'error': {'code': 'PROVIDER_UNAVAILABLE', 'message': 'Newton/Warp 设备初始化失败: ' + str(exc)}})
        sys.exit(2)
    # 设备解析已经触发 warp.init()，此时 kernel_cache_dir 是真正生效的目录，如实回读。
    kernel_cache = getattr(wp.config, 'kernel_cache_dir', None) or _CACHE_ROOT or '(warp 默认)'
    threading.Thread(target=read_requests, daemon=True).start()
    worlds = {}
    emit({'event': 'ready', 'engine': 'newton', 'version': NEWTON_VERSION, 'pid': os.getpid(),
          'warpVersion': WARP_VERSION, 'device': device, 'deviceKind': kind,
          'deviceDegraded': degraded, 'deviceNote': note, 'kernelCacheDir': kernel_cache,
          'kernelCacheNote': _CACHE_NOTE, 'capabilities': CAPABILITIES})
    running = True
    while running:
        batch = []
        # 只有在真的有 realtime 世界需要推进时才自旋；否则阻塞等请求。
        if not any(w.status in ('ready', 'running') and w.clock == 'realtime' for w in worlds.values()):
            batch.append(requests.get())
        while not requests.empty():
            batch.append(requests.get_nowait())
        for request in batch:
            rid, method = request.get('id'), request.get('method')
            args = request.get('args', {}) or {}
            try:
                if method == 'shutdown':
                    for world in worlds.values():
                        world.close()
                    running = False
                    result = None
                elif method == 'list_worlds':
                    result = [world.handle() for world in worlds.values()]
                elif method == 'capabilities':
                    # 与 ready 事件同一份自报：能力表 + 设备解析事实 + 缓存目录**及其来源**。
                    # kernelCacheNote 以前只在 ready 里给，只调 capabilities 的调用方看不到"落哪了、为什么"。
                    result = dict(CAPABILITIES, engineVersion=NEWTON_VERSION, warpVersion=WARP_VERSION,
                                  device=device, deviceKind=kind, deviceDegraded=degraded, deviceNote=note,
                                  kernelCacheDir=kernel_cache,
                                  **({'kernelCacheNote': _CACHE_NOTE} if _CACHE_NOTE else {}))
                elif method == 'open':
                    if 'snapshot' not in args:
                        raise SimError('INVALID_ARGUMENT', 'open 需要 args.snapshot')
                    if args.get('collisionPatches') is not None:
                        raise SimError('UNSUPPORTED_CAPABILITY', 'Newton 切片未实现 collisionPatches（场景碰撞编译通道）')
                    world = World(args['snapshot'], args.get('options', {}) or {})
                    if world.id in worlds:
                        world.close()
                        raise SimError('WORLD_EXISTS', 'worldId 已存在')
                    worlds[world.id] = world
                    result = world.handle()
                elif method not in WORLD_METHODS:
                    raise SimError('UNKNOWN_METHOD', '未知方法: ' + str(method))
                else:
                    if 'worldId' not in args:
                        raise SimError('INVALID_ARGUMENT', method + ' 需要 args.worldId')
                    if args['worldId'] not in worlds:
                        raise SimError('WORLD_NOT_FOUND', 'worldId 不存在')
                    world = worlds[args['worldId']]
                    if method == 'sync':
                        if args.get('collisionPatches') is not None:
                            raise SimError('UNSUPPORTED_CAPABILITY', 'Newton 切片未实现 collisionPatches（场景碰撞编译通道）')
                        result = world.sync(args['snapshot'], (args.get('options') or {}).get('forceRebuild', False))
                    elif method == 'observe':
                        result = world.observe(args.get('selection'))
                    elif method == 'describe':
                        result = world.describe(args['entityId'])
                    elif method == 'handle':
                        result = world.handle()
                    elif method == 'stop':
                        result = world.stop(args.get('selection', {}))
                    elif method == 'receipt':
                        raise SimError('ACTION_NOT_FOUND', 'actionId 未知（Newton 切片未接受过任何动作）: ' + str(args.get('actionId')))
                    elif method == 'execute':
                        action = args.get('action') or {}
                        kind = action.get('kind')
                        if kind == 'batch':
                            kinds = [m.get('kind') for m in action.get('motions', [])]
                            raise SimError(ACTION_UNSUPPORTED_CODE,
                                           'Newton Provider 第一切片未实现任何动作类型（batch: ' + ', '.join(str(k) for k in kinds) + '）；'
                                           '只支持 open/sync/observe/close，动作通道未接线，拒绝而不是假装执行')
                        raise SimError(ACTION_UNSUPPORTED_CODE,
                                       'Newton Provider 第一切片未实现动作类型 ' + str(kind) + '；只支持 open/sync/observe/close，'
                                       '动作通道未接线，拒绝而不是假装执行')
                    elif method == 'assist':
                        raise SimError('UNSUPPORTED_CAPABILITY', 'Newton 切片未实现 assist（附着/辅助写回）')
                    elif method in ('capture', 'capture_multi', 'camera_list', 'camera_adjust',
                                    'camera_project_annotation', 'camera_dataset_export'):
                        raise SimError('UNSUPPORTED_CAPABILITY', 'Newton 切片未实现渲染/相机通道: ' + method)
                    elif method == 'close':
                        world.close()
                        del worlds[world.id]
                        result = None
                    else:  # pragma: no cover - WORLD_METHODS 与上面的分支一一对应
                        raise SimError('UNKNOWN_METHOD', '未知方法: ' + str(method))
                emit({'id': rid, 'result': result})
            except Exception as exc:
                # 协议只回 {code,message}（与 sim-mujoco 一致）；完整栈走 stderr 诊断通道，
                # 不混进 stdout，也不让「未知异常」只剩一句无法归因的字符串。
                traceback.print_exc(file=sys.stderr)
                emit({'id': rid, 'error': {'code': getattr(exc, 'code', 'ENGINE_ERROR'), 'message': str(exc)}})
        now = time.monotonic()
        for world in list(worlds.values()):
            if now >= world.next_tick and world.status in ('ready', 'running') and world.clock != 'manual':
                try:
                    world.tick()
                    world.next_tick = max(world.next_tick + world.dt / world.factor, now - .05)
                except Exception as exc:
                    # Drop all native handles before exposing the fault.  The
                    # world remains listable for diagnosis, but is no longer
                    # allowed to retain or accidentally use a half-built model.
                    world.fault(exc)
                    emit({'event': 'world-error', 'worldId': world.id, 'error': str(exc),
                          'traceback': traceback.format_exc()[-2000:]})
        if requests.empty():
            time.sleep(.0001)


if __name__ == '__main__':
    main()
