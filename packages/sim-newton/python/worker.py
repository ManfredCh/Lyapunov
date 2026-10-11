"""Newton Provider worker：NDJSON 请求/响应协议，与 packages/sim-mujoco/python/worker.py 同形。

RC2 原生后端切片：
- 真物理：Newton 1.6.0 + Warp 1.17.0；MJCF/URDF 由 Newton 的 ModelBuilder 真实导入并步进。
- device 可降级：auto → 有 CUDA 用 cuda:0，没有则 cpu；显式指定的设备不可用时明确报错（不静默顶替）。
- 未接通的动作、渲染与辅助附着返回结构化错误，绝不静默成功或返回假数据。
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
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from world_physics import scene_gravity,declared_ground_ids,explicit_ground_requested,coverage,replaceable_standard_ground,standard_support_plane

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


def vec3(value, name, strictly_positive=False):
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise SimError('INVALID_ARGUMENT', name + ' 必须是 3 个数值的数组')
    check = positive if strictly_positive else finite
    return np.array([check(v, name + '[' + str(i) + ']') for i, v in enumerate(value)])


def rotation_matrix(q):
    return np.column_stack([quat_rotate(q, axis) for axis in np.eye(3)])


def world_poses(scene):
    """实体层级 → 世界系 (position, quaternion_xyzw, scale)（与 sim-mujoco 的 world_poses 同语义）。"""
    entities = {e['entityId']: e for e in scene['entities']}
    result = {}
    linears = {}
    active = set()

    def get(eid):
        if eid in result:
            return result[eid]
        if eid in active:
            raise SimError('INVALID_SCENE', '实体层级成环')
        active.add(eid)
        e = entities[eid]
        t = e['transform']
        p = vec3(t['position'], eid + ' 的 position')
        q = np.array(t['quaternion'], dtype=float)
        if q.shape != (4,) or not np.isfinite(q).all() or np.linalg.norm(q) < 1e-8:
            raise SimError('INVALID_SCENE', '变换含非法值')
        q = q / np.linalg.norm(q)
        scale = vec3(t.get('scale', [1, 1, 1]), eid + ' 的 scale')
        linear = rotation_matrix(q) @ np.diag(scale)
        if e.get('parentId'):
            if e['parentId'] not in entities:
                raise SimError('INVALID_SCENE', eid + ' 的父实体不存在: ' + str(e['parentId']))
            pp, pq, ps = get(e['parentId'])
            p = pp + linears[e['parentId']] @ p
            linear = linears[e['parentId']] @ linear
            q = quat_mul(pq, q)
            scale = scale * ps
        result[eid] = (p, q, scale)
        linears[eid] = linear
        active.remove(eid)
        return result[eid]

    for eid in entities:
        get(eid)
    return result


def collision_frame_maps(scene, poses):
    """与已有 TRS 适配口径一致：声明几何→body 帧 D=R(q)ᵀA，保留父链剪切与镜像。"""
    entities = {e['entityId']: e for e in scene['entities']}
    linears = {}

    def get(eid):
        if eid not in linears:
            entity = entities[eid]
            t = entity['transform']
            q = np.asarray(t['quaternion'], dtype=float)
            q = q / np.linalg.norm(q)
            local = rotation_matrix(q) @ np.diag(vec3(t.get('scale', [1, 1, 1]), eid + ' 的 scale'))
            linears[eid] = get(entity['parentId']) @ local if entity.get('parentId') else local
        return linears[eid]

    return {eid: rotation_matrix(poses[eid][1]).T @ get(eid) for eid in entities}


def shape_frame(linear, eid, shape):
    """正交列可拆成旋转与带符号缩放；真剪切由调用方明确拒绝或精确烘焙顶点。"""
    lengths = np.linalg.norm(linear, axis=0)
    if not np.isfinite(linear).all() or not (lengths > 0).all() or abs(float(np.linalg.det(linear))) < 1e-15:
        raise SimError('INVALID_ARGUMENT', eid + ' 的碰撞变换退化或含非法值')
    rotation = linear / lengths
    if not np.allclose(rotation.T @ rotation, np.eye(3), atol=1e-6, rtol=0):
        raise SimError('UNSUPPORTED_CAPABILITY', eid + ' 的 ' + shape + ' 碰撞含剪切，不能用原生形状精确表达')
    signed = lengths.copy()
    if np.linalg.det(rotation) < 0:
        # 有限平面的朝向属于语义：反射留在切向轴，不把 X/Y 镜像误变成翻转法向。
        axis = 0 if shape == 'plane' else 2
        rotation[:, axis] *= -1
        signed[axis] *= -1
    q = wp.quat_from_matrix(wp.mat33(*[float(v) for v in rotation.reshape(-1)]))
    return q, signed


def collision_mesh(uri, linear, eid, dynamic):
    """只消费 asset-bake 的真实 OBJ 三角面；不猜格式、不填包围盒、不丢反射后的面朝向。"""
    if not isinstance(uri, str) or not uri:
        raise SimError('INVALID_ARGUMENT', eid + ' 的 collision.parts 必须是本地 OBJ 路径/URI')
    parsed = urlparse(uri)
    if parsed.scheme not in ('', 'file') or parsed.netloc not in ('', 'localhost'):
        raise SimError('UNSUPPORTED_CAPABILITY', eid + ' 的碰撞件只接受本地 OBJ: ' + uri)
    path = path_from_uri(uri)
    if not os.path.isfile(path):
        raise SimError('COLLISION_MESH_NOT_FOUND', eid + ' 的碰撞件不存在: ' + path)
    if os.path.splitext(path)[1].lower() != '.obj':
        raise SimError('UNSUPPORTED_CAPABILITY', eid + ' 的碰撞件只支持已派生 OBJ: ' + path)
    vertices, faces = [], []
    try:
        with open(path, encoding='utf-8') as handle:
            for line in handle:
                fields = line.split('#', 1)[0].split()
                if not fields:
                    continue
                if fields[0] == 'v':
                    if len(fields) != 4:
                        raise ValueError('顶点必须恰为三个坐标')
                    vertex = [float(v) for v in fields[1:]]
                    if not np.isfinite(vertex).all():
                        raise ValueError('顶点含非有限数值')
                    vertices.append(vertex)
                elif fields[0] == 'f':
                    if len(fields) != 4:
                        raise ValueError('只支持真实三角面，不猜凹多边形的三角划分')
                    face = [int(v.split('/')[0]) for v in fields[1:]]
                    if 0 in face:
                        raise ValueError('OBJ 顶点索引不能为 0')
                    faces.append([v - 1 if v > 0 else len(vertices) + v for v in face])
        if len(vertices) < (4 if dynamic else 3) or not faces or any(v < 0 or v >= len(vertices) for f in faces for v in f):
            raise ValueError('缺少有效顶点/面或索引越界')
        points = np.asarray(vertices, dtype=float) @ linear.T
        indices = np.asarray(faces, dtype=np.int32)
        if np.linalg.det(linear) < 0:
            indices = indices[:, [0, 2, 1]]
        mesh = newton.Mesh(points, indices.reshape(-1), compute_inertia=dynamic)
        return mesh
    except (OSError, UnicodeError, ValueError) as exc:
        raise SimError('COLLISION_MESH_INVALID', eid + ' 的 OBJ 碰撞件无效: ' + path + ': ' + str(exc)) from exc


def world_fixed_body(builder,body):
    """原生builder的真实固定关节链；质量、名字和视觉边界不证明world固定。"""
    seen=set()
    while body>=0:
        if body in seen:return False
        seen.add(body)
        if builder.body_flags[body]&int(newton.BodyFlags.KINEMATIC):return True
        joints=[joint for joint,child in enumerate(builder.joint_child)if child==body]
        if len(joints)!=1 or int(builder.joint_type[joints[0]])!=int(newton.JointType.FIXED):return False
        body=builder.joint_parent[joints[0]]
    return True


def scene_collision(builder, entity, pose, linear):
    """复用当前 ModelBuilder 装配一个 Scene 刚体；几何已是 Z-up 米制，不重复转换 GLB 原件。"""
    eid = entity['entityId']
    components = entity.get('components', {})
    c, rigid = components['collision'], components.get('rigidBody', {})
    if not isinstance(c, dict) or not isinstance(rigid, dict):
        raise SimError('INVALID_ARGUMENT', eid + ' 的 collision/rigidBody 必须是对象')
    kind = c.get('shape', c.get('type'))
    if kind not in ('box', 'sphere', 'cylinder', 'capsule', 'plane', 'mesh'):
        raise SimError('UNSUPPORTED_CAPABILITY', eid + ' 的 Scene 碰撞类型尚未支持: ' + str(kind))
    if c.get('binding') is not None and c.get('parts') is None:
        raise SimError('UNSUPPORTED_CAPABILITY', eid + ' 的 mesh binding 需要尚未接入的 collisionPatches')
    if c.get('frame') not in (None, 'mujoco-z-up-meters'):
        raise SimError('UNSUPPORTED_CAPABILITY', eid + ' 的碰撞坐标帧尚未支持: ' + str(c['frame']))
    body_type = rigid.get('type', 'static')
    if body_type not in ('static', 'dynamic'):
        raise SimError('UNSUPPORTED_CAPABILITY', eid + ' 的 rigidBody.type 尚未支持: ' + str(body_type))
    dynamic = body_type == 'dynamic'
    for name, value in (('collision.enabled', c.get('enabled', True)), ('gravityEnabled', rigid.get('gravityEnabled', True))):
        if not isinstance(value, bool):
            raise SimError('INVALID_ARGUMENT', eid + ' 的 ' + name + ' 必须是布尔值')
    if dynamic and not rigid.get('gravityEnabled', True):
        raise SimError('UNSUPPORTED_CAPABILITY', eid + ' 的动态 gravityEnabled=false 尚未接入 Newton 逐体重力通道')
    if not np.isfinite(linear).all() or abs(float(np.linalg.det(linear))) < 1e-15:
        raise SimError('INVALID_ARGUMENT', eid + ' 的碰撞变换退化或含非法值')
    binding = components.get('physicsBinding') or {}
    if kind == 'mesh' and dynamic and (binding.get('strategy') == 'triangle_mesh' or binding.get('usage') in ('static', 'environment')):
        raise SimError('UNSUPPORTED_CAPABILITY', eid + ' 的原始静态 triangle_mesh/环境碰撞不能作为动态凸件消费，请重新派生动态表示')
    if kind == 'mesh' and dynamic and c.get('source') != 'asset-bake-hull' and binding.get('strategy') not in ('convex_hull', 'coacd', 'auto'):
        raise SimError('UNSUPPORTED_CAPABILITY', eid + ' 的动态 OBJ 需要明确的凸件派生策略，不把未知凹面静默凸化')
    if dynamic and kind == 'plane':
        raise SimError('UNSUPPORTED_CAPABILITY', eid + ' 的 plane 只支持静态体')
    friction = c.get('friction')
    if friction is None:
        if c.get('material') is not None:
            raise SimError('UNSUPPORTED_CAPABILITY', eid + ' 的 collision.material 需要显式 friction，Newton 不猜材质属性')
        friction = [1., .005, .0001]
    elif isinstance(friction, (int, float)) and not isinstance(friction, bool):
        value = finite(friction, eid + ' 的 friction')
        friction = [value, max(.001, value * .05), max(.0001, value * .005)]
    friction = vec3(friction, eid + ' 的 friction')
    if (friction < 0).any():
        raise SimError('INVALID_ARGUMENT', eid + ' 的摩擦系数必须非负')
    restitution = finite(c.get('restitution', 0), eid + ' 的 restitution')
    if not 0 <= restitution <= 1:
        raise SimError('INVALID_ARGUMENT', eid + ' 的 restitution 必须在 [0,1]')
    cfg = builder.ShapeConfig(density=1. if dynamic else 0., mu=float(friction[0]),
                              mu_torsional=float(friction[1]), mu_rolling=float(friction[2]), restitution=restitution,
                              has_shape_collision=c.get('enabled', True), has_particle_collision=c.get('enabled', True))
    p, q, _ = pose
    xform = wp.transform(wp.vec3(*[float(v) for v in p]), wp.quat(*[float(v) for v in q]))
    start = (builder.body_count, builder.joint_count, builder.shape_count)
    if dynamic:
        body = builder.add_body(xform=xform, label=eid + '/body')
    else:
        body = builder.add_link(xform=xform, label=eid + '/body', lock_inertia=True, is_kinematic=True)
        joint = builder.add_joint_fixed(parent=-1, child=body, parent_xform=xform, label=eid + '/fixed')
        builder.add_articulation([joint], label=eid + '/static')

    def add_box(center, half, label):
        rotation, scale = shape_frame(linear, eid, 'box')
        size = vec3(half, label + ' 的 halfExtents', True) * np.abs(scale)
        local = wp.transform(wp.vec3(*[float(v) for v in linear @ vec3(center, label + ' 的 center')]), rotation)
        builder.add_shape_box(body, xform=local, hx=float(size[0]), hy=float(size[1]), hz=float(size[2]), cfg=cfg, label=label)

    if kind == 'mesh':
        parts = c.get('parts')
        if not isinstance(parts, list) or not parts:
            raise SimError('INVALID_ARGUMENT', eid + ' 的 mesh 碰撞必须有真实非空 parts')
        for index, part in enumerate(parts):
            mesh = collision_mesh(part, linear, eid, dynamic)
            add = builder.add_shape_convex_hull if dynamic else builder.add_shape_mesh
            add(body, mesh=mesh, cfg=cfg, label=eid + '/part' + str(index))
    shapes = c.get('shapes')
    if shapes is not None:
        if kind not in ('box', 'mesh'):
            raise SimError('UNSUPPORTED_CAPABILITY', eid + ' 的组合盒 shapes 只适用于 box/mesh')
        if not isinstance(shapes, list) or not shapes:
            raise SimError('INVALID_ARGUMENT', eid + ' 的 shapes 必须是非空数组')
        for index, entry in enumerate(shapes):
            if not isinstance(entry, dict):
                raise SimError('INVALID_ARGUMENT', eid + ' 的 shapes[' + str(index) + '] 必须是对象')
            add_box(entry.get('center', [0, 0, 0]), entry.get('halfExtents'), eid + '/box' + str(index))
    elif kind == 'box':
        add_box(c.get('center', [0, 0, 0]), c.get('halfExtents', c.get('size')), eid + '/box')
    elif kind != 'mesh':
        rotation, signed_scale = shape_frame(linear, eid, kind)
        scale = np.abs(signed_scale)
        local = wp.transform(wp.vec3(*[float(v) for v in linear @ vec3(c.get('center', [0, 0, 0]), eid + ' 的 center')]), rotation)
        size = c.get('halfExtents', c.get('size'))
        if kind == 'plane':
            if c.get('infinite') is True:
                width,length=0.,0.
            elif not isinstance(size, (list, tuple)) or len(size) < 2:
                raise SimError('INVALID_ARGUMENT', eid + ' 的 plane 缺 size[0..1]')
            else:
                width=positive(size[0],eid+' 的 plane.size[0]')*float(scale[0]);length=positive(size[1],eid+' 的 plane.size[1]')*float(scale[1])
            # Newton 1.6 的 finite-plane support function 将 width/length 当半宽/半长。
            # width=length=0是引擎真正的无限碰撞合同，不能用极大有限尺寸替代。
            builder.add_shape_plane(body=body, xform=local, width=width,length=length,cfg=cfg,label=eid+'/plane')
        else:
            radius = c.get('radiusM')
            if radius is None:
                radius = size[0] if isinstance(size, (list, tuple)) and size else None
            radius = positive(radius, eid + ' 的 ' + kind + '.radiusM')
            if not np.allclose(scale[:2], scale[0], rtol=1e-6, atol=0) or kind in ('sphere', 'capsule') and not np.allclose(scale, scale[0], rtol=1e-6, atol=0):
                raise SimError('UNSUPPORTED_CAPABILITY', eid + ' 的 ' + kind + ' 非均匀缩放不能用原生形状精确表达')
            kwargs = {'xform': local, 'radius': radius * float(scale[0]), 'cfg': cfg, 'label': eid + '/' + kind}
            if kind != 'sphere':
                half = size[1] if isinstance(size, (list, tuple)) and len(size) > 1 else None
                kwargs['half_height'] = positive(half, eid + ' 的 ' + kind + '.halfLength') * float(scale[2])
            getattr(builder, 'add_shape_' + kind)(body, **kwargs)
    if dynamic:
        mass = positive(rigid.get('massKg'), eid + ' 的动态 massKg')
        if rigid.get('massScalePolicy', 'constant') not in ('constant', 'density'):
            raise SimError('UNSUPPORTED_CAPABILITY', eid + ' 的 massScalePolicy 尚未支持')
        if rigid.get('massScalePolicy') == 'density':
            mass *= abs(float(np.linalg.det(linear)))
        measured = builder.body_mass[body]
        if not math.isfinite(measured) or measured <= 0:
            raise SimError('COLLISION_MESH_INVALID', eid + ' 的动态碰撞件没有有效封闭体积/惯性')
        factor = mass / measured
        builder.body_mass[body] = mass
        builder.body_inv_mass[body] = 1. / mass
        builder.body_inertia[body] *= factor
        builder.body_inv_inertia[body] = wp.inverse(builder.body_inertia[body])
    return start[0], builder.body_count, start[1], builder.joint_count, start[2], builder.shape_count


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
EXECUTABLE_KINDS = {'trajectory', 'joint', 'control'}
ROBOT_CAPABILITY_KINDS = ['thrust', 'vehicle', 'joint', 'gripper', 'lift', 'control', 'gait', 'tendon']
# 动作拒绝码：**一处定义**。声明表（CAPABILITIES.unsupported.execute）、describe 的缺项 reason 前缀、
# execute 的真实拒绝码全部从这一个常量出 —— 判定与拒绝同源，不靠人在多处抄同一个字面量。
# 值就是线上码（合同/README 都按这个字符串读），改它等于改协议。
ACTION_UNSUPPORTED_CODE = 'ACTION_UNSUPPORTED'

# 需要 worldId 的方法（其余方法名一律 UNKNOWN_METHOD，不让「未知方法」被世界查询掩盖）。
WORLD_METHODS = {'sync', 'observe', 'describe', 'handle', 'stop', 'receipt', 'execute', 'assist',
                 'capture', 'capture_multi', 'capture_publish', 'camera_list', 'camera_adjust',
                 'camera_project_annotation', 'camera_dataset_export', 'close'}

CAPABILITIES = {
    'engine': 'newton',
    'slice': 'joint-contact-mpm-rc2',
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
        'sceneCollisionCompilation': True,
        'execute': True,
        'manualClockAdvance': True,
        'contacts': True,
        'liquidParticles': True,
        'capture': True,
        'captureMulti': True,
        'cameraList': True,
    },
    'unsupported': {
        'execute': {kind: ACTION_UNSUPPORTED_CODE for kind in ACTION_KINDS if kind not in EXECUTABLE_KINDS},
        'observe.collisionTopology': 'UNSUPPORTED_CAPABILITY',
        'observe.sensors.sites': 'UNSUPPORTED_CAPABILITY',
        'observe.tendons': 'UNSUPPORTED_CAPABILITY',
        'cameraAdjust': 'UNSUPPORTED_CAPABILITY',
        'cameraProjectAnnotation': 'UNSUPPORTED_CAPABILITY',
        'cameraDatasetExport': 'UNSUPPORTED_CAPABILITY',
        'assist': 'UNSUPPORTED_CAPABILITY',
        'collisionPatches': 'UNSUPPORTED_CAPABILITY',
    },
    'notes': [
        '支持 MJCF/URDF 原生源、地面及 Scene collision 的 box/shapes、sphere、cylinder、capsule、静态 plane 与 OBJ parts；没有原生源也没有碰撞的实体按纯视觉跳过并带 ENTITY_SKIPPED_NO_NATIVE_SOURCE。',
        'Scene 环境/静态 OBJ 使用真实三角面，不合成整件凸包；动态 OBJ 仅接受明确凸件策略。组合盒保留逐件尺寸与空区，缺尺寸不造默认盒。',
        'Scene 碰撞支持完整父链线性映射烘焙到 OBJ；原生形状仅接受保持其形状的变换，剪切与球/胶囊非均匀缩放明确拒绝。动态体须有正 massKg；逐体关闭重力、SDF、补丁绑定与 topology 观测尚未接入。',
        'manual 只由已接受动作推进；control 精确执行 stepCount 步。MPM 水例使用 realtime / Manual clock advances accepted robot actions only; MPM water uses realtime.',
        'joints.positions/velocities 用 Newton eval_ik 从 body_q/body_qd 反解；自由根的速度按 Newton 自身的约定 (v_com_world, omega_world) 报告，字段名与 MuJoCo 的自由根速度约定（世界线速度 + 本地角速度）不同，见 README。',
        'STOP 保持实测关节参考，不清零刚体速度；XPBD 接触力为原生冲量/dt近似值。MPM 水例不执行机器人动作 / STOP holds measured references; XPBD forces are native approximations; MPM has no robot action channel.',
        '原生 SensorTiledCamera 消费当前 Newton 形状与粒子，采集需显式命名相机，不默认自由机位；RGB与轴向米制深度同物理步 / Named cameras use native pixels and axial metric depth from the same physical step.',
        '含 mesh 资产的 MJCF/URDF 需要 Newton 的 importers extra（trimesh 等）：缺失时 open/sync 明确报 PROVIDER_DEPENDENCY_MISSING 并给出安装方式，不会退化成「场景非法」。',
    ],
}


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
        self.ground = explicit_ground_requested(scene,options)
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
        self.active = {}
        self.receipts = {}
        self.commanded = {}
        self.camera_provider = None
        # 原生句柄：close 时逐一丢弃（Warp 没有显式 dispose，释放靠丢引用 + gc）
        self.builder = None
        self.model = None
        self.state_a = None
        self.state_b = None
        self.control = None
        self.solver = None
        self.pipeline = None
        self.contacts = None
        self.contact_distances = None
        self.contact_points0 = self.contact_points1 = None
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
            # 接触几何沿用原生 shape label；地面来源另见 worldPhysics。
            'groundGeomNames': list(self.ground_names),
            'warnings': [dict(w) for w in self.warnings],
            **({'worldPhysics':self.world_physics()}if self.model is not None else{}),
            # 以下是本 Provider 的加法字段（sim-mujoco 没有），如实交代真实设备与求解器。
            'device': self.device,
            'deviceKind': self.device_kind,
            'deviceDegraded': self.device_degraded,
            'deviceNote': self.device_note,
            'solver': self.solver_name,
            'warpVersion': WARP_VERSION,
            'capabilities': self.world_capabilities(),
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

    def camera(self):
        self.require_ready()
        if self.camera_provider is None:
            from camera import NewtonCamera
            self.camera_provider = NewtonCamera(self, SimError, native_source, world_poses)
        return self.camera_provider

    def release_camera(self):
        if self.camera_provider is not None:
            self.camera_provider.close()
            self.camera_provider = None

    def fault(self, error):
        """Transition a world to unavailable and release native handles immediately.

        A failed realtime tick must not retain a partially valid model/state pair:
        callers may inspect the status reason, but no later observe/step may touch
        the faulted Newton/Warp objects.
        """
        self.status = 'unavailable'
        self.status_reason = type(error).__name__ + ': ' + str(error)
        for aid in list(self.active):
            self.finish(aid, 'failed', 'WORLD_UNAVAILABLE', state_available=False)
        self.release_camera()
        self.builder = None
        self.model = None
        self.state_a = self.state_b = None
        self.control = None
        self.solver = None
        self.pipeline = None
        self.contacts = None
        self.contact_distances = None
        self.contact_points0 = self.contact_points1 = None
        self.ik_q = self.ik_qd = None
        self.entities = {}
        self.commanded = {}
        gc.collect()

    # -- 编译 ---------------------------------------------------------------
    def physics_signature(self, scene):
        """只覆盖影响物理的字段（与 sim-mujoco 同口径：revision／标签／颜色不参与签名）。

        签名包含本切片真正消费的全部物理输入：实体层级与位姿、Scene collision/rigidBody/绑定与碰撞表示、MJCF/URDF 原生源、
        地面开关、步长与设备。签名不变时 sync 只推进 appliedSceneRevision，不重编译。
        """
        payload = {
            'sceneId': scene.get('sceneId'),
            'ground': self.ground,
            'physics':scene.get('physics'),
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
                'mpm': e.get('components', {}).get('newton', {}).get('mpm'),
                'collision': e.get('components', {}).get('collision'),
                'rigidBody': e.get('components', {}).get('rigidBody'),
                'physicsBinding': e.get('components', {}).get('physicsBinding'),
                'collisionRepresentations': [
                    {'resourceId': r.get('resourceId'), 'version': r.get('version'), 'representations': reps}
                    for r in e.get('resources', [])
                    if (reps := [rep for rep in r.get('representations', []) if rep.get('role') == 'collision'])
                ],
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

    def build_scene(self, builder, scene, excluded=()):
        """复用RC2原生/Scene碰撞、模板地面替换与完整仿射装配。"""
        ground_names = []
        skipped = []
        poses = world_poses(scene)
        frames = collision_frame_maps(scene, poses)
        maps = {}
        native_planes=[];replaced=[]
        # 原生资产先真实导入；之后才决定未编辑模板地面是否让位，不按名字或bbox猜。
        ordered=sorted(scene['entities'],key=lambda entity:0 if native_source(entity)else 1)
        for e in ordered:
            if e['entityId'] in excluded:
                continue
            eid = e['entityId']
            cfg = native_source(e)
            if cfg:
                bodies = self._import_entity(builder, eid, e, cfg, poses[eid])
                for sid in range(bodies[4],bodies[5]):
                    if int(builder.shape_type[sid])!=int(newton.GeoType.PLANE)or not builder.shape_flags[sid]&int(newton.ShapeFlags.COLLIDE_SHAPES):continue
                    owner=builder.shape_body[sid]
                    if not world_fixed_body(builder,owner):continue
                    transform=builder.shape_transform[sid]
                    if owner>=0:transform=wp.transform_multiply(builder.body_q[owner],transform)
                    point=wp.transform_get_translation(transform);normal=wp.transform_vector(transform,wp.vec3(0,0,1))
                    if standard_support_plane(list(point),list(normal)):native_planes.append((eid,builder.shape_label[sid]))
                source = cfg.get('sourcePath') or 'inline-xml'
                if e.get('components', {}).get('collision'):
                    skipped.append({'code': 'SCENE_COLLISION_IGNORED_NATIVE_SOURCE', 'entityId': eid,
                                    'message': eid + ' 的原生 MJCF/URDF 碰撞优先，Scene collision 未参与装配'})
            elif e.get('components', {}).get('collision') is not None:
                if native_planes and replaceable_standard_ground(scene,e):replaced.append(eid);continue
                bodies = scene_collision(builder, e, poses[eid], frames[eid])
                source = 'scene-collision'
            else:
                skipped.append({'code': 'ENTITY_SKIPPED_NO_NATIVE_SOURCE', 'entityId': eid,
                                'message': '实体 ' + eid + ('（' + str(e['name']) + '）' if e.get('name') else '')
                                           + ' 没有 MJCF/URDF 原生源或 Scene collision，已在物理装配中跳过'})
                continue
            maps[eid] = {'bodyStart': bodies[0], 'bodyEnd': bodies[1], 'jointStart': bodies[2], 'jointEnd': bodies[3],
                         'shapeStart': bodies[4], 'shapeEnd': bodies[5], 'source': source, 'entity': e}
        if explicit_ground_requested(scene,self.options)and not native_planes:
            builder.add_ground_plane(label='__ground');ground_names.append('__ground')
        return poses, maps, ground_names, skipped, native_planes, replaced

    def compile(self, scene):
        """把 Scene 编译成真实的 Newton 模型；失败即抛结构化错误，不产出半成品世界。"""
        if any(e.get('components', {}).get('newton', {}).get('mpm') is not None for e in scene['entities']):
            return self.compile_mpm(scene)
        builder = newton.ModelBuilder(gravity=wp.vec3(*scene_gravity(scene,SimError)))
        poses, maps, ground_names, skipped, native_planes, replaced = self.build_scene(builder, scene)
        model = builder.finalize(device=self.device)
        model.request_contact_attributes('force')
        states = (model.state(), model.state())
        control = model.control()
        solver_name = os.environ.get('LYAPUNOV_NEWTON_SOLVER', 'xpbd').strip().lower()
        if solver_name == 'semi':
            # SolverSemiImplicit 在实测的三关节臂上会发散成 NaN（见 bugfixHistory 回执），
            # 因此默认不用它；显式要求时才启用，并如实记录在 handle.solver。
            solver = newton.solvers.SolverSemiImplicit(model)
        elif solver_name == 'xpbd':
            restitution = any(m['source'] == 'scene-collision' and m['entity']['components']['collision'].get('restitution', 0) > 0
                              for m in maps.values())
            solver = newton.solvers.SolverXPBD(model, iterations=4, enable_restitution=restitution)
        else:
            raise SimError('INVALID_ARGUMENT', 'LYAPUNOV_NEWTON_SOLVER 只支持 xpbd/semi，收到: ' + solver_name)
        pipeline = newton.CollisionPipeline(model)
        contacts = pipeline.contacts()
        distances = wp.zeros(contacts.rigid_contact_max, dtype=float, device=self.device)
        points0 = wp.zeros(contacts.rigid_contact_max, dtype=wp.vec3, device=self.device)
        points1 = wp.zeros(contacts.rigid_contact_max, dtype=wp.vec3, device=self.device)
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
        drives = self.source_drives(model)
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
                    entry['drive'] = copy.deepcopy(drives.get(d, {
                        'available': False,
                        'reason': 'UNSUPPORTED_CAPABILITY: 没有可核验的源关节位置执行器 / No verified source position actuator',
                    }))
                    if solver_name != 'xpbd':
                        entry['drive'].update(available=False, reason='UNSUPPORTED_CAPABILITY: 位置动作只在已验收的 XPBD 路径开放 / Position actions require the verified XPBD path')
                    if entry['drive']['available'] and math.isfinite(effort[d]) and effort[d] < EFFORT_DEFAULT:
                        entry['drive'].update(available=False, reason='UNSUPPORTED_CAPABILITY: XPBD 不执行源关节力限 / XPBD does not enforce source joint effort limits')
                    joints.append(entry)
                elif jtype == int(newton.JointType.FREE):
                    free_joints.append(entry)
            entity_maps[eid] = {
                'entity': copy.deepcopy(m['entity']),
                'rootBody': root if m['bodyEnd']>m['bodyStart']else None,
                'bodyStart': m['bodyStart'], 'bodyEnd': m['bodyEnd'],
                'bodyLabels': body_labels[m['bodyStart']:m['bodyEnd']],
                'joints': joints,
                'freeJoints': free_joints,
                'shapeLabels': shape_labels[m['shapeStart']:m['shapeEnd']],
                'shapeStart':m['shapeStart'],'shapeEnd':m['shapeEnd'],
                'source': m['source'],
            }
            for label in shape_labels[m['shapeStart']:m['shapeEnd']]:
                if is_ground_shape_name(label):
                    ground_names.append(label)
        for s in range(model.shape_count):
            if int(shape_types[s]) == int(newton.GeoType.PLANE) and shape_labels[s] not in ground_names:
                ground_names.append(shape_labels[s])
        for w in skipped:
            print('[sim-newton] WARNING ' + w['message'], file=sys.stderr, flush=True)
        return {'builder': builder, 'model': model, 'states': states, 'control': control, 'solver': solver,
                'solverName': solver_name, 'pipeline': pipeline, 'contacts': contacts, 'ik_q': ik_q, 'ik_qd': ik_qd,
                'contactDistances': distances, 'contactPoints0': points0, 'contactPoints1': points1,
                'entities': entity_maps, 'ground': ground_names, 'warnings': skipped,'nativeGround':native_planes,'replacedGround':replaced}

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
        for aid in list(self.active):
            self.finish(aid, 'cancelled', 'MODEL_REBUILT')
        self.release_camera()
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
        self.contact_distances = compiled.get('contactDistances')
        self.contact_points0 = compiled.get('contactPoints0')
        self.contact_points1 = compiled.get('contactPoints1')
        self.ik_q, self.ik_qd = compiled['ik_q'], compiled['ik_qd']
        self.entities = compiled['entities']
        self.ground_names = compiled['ground']
        self.native_ground=compiled['nativeGround'];self.replaced_ground=compiled['replacedGround']
        self.warnings = compiled['warnings']
        self.scene = copy.deepcopy(scene)
        self.commanded = {}
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

    def world_physics(self):
        key=(id(self.model),self.applied_revision)
        if getattr(self,'_physics_layout_key',None)!=key:
            physical=[];sources=[];enabled=self.model.shape_flags.numpy();ground_ids=set(declared_ground_ids(self.scene))
            for eid,info in self.entities.items():
                if info.get('liquid'):
                    physical.append(eid)
                    continue
                names=[self.model.shape_label[sid]for sid in range(info['shapeStart'],info['shapeEnd'])if int(enabled[sid])&int(newton.ShapeFlags.COLLIDE_SHAPES)]
                if names:physical.append(eid)
                if eid in ground_ids and names:sources.append({'source':'scene','entityId':eid,'geomNames':names})
            sources.extend({'source':'native-plane','entityId':eid,'geomNames':[name]}for eid,name in self.native_ground)
            if '__ground'in self.ground_names:sources.append({'source':'explicit-legacy','geomNames':['__ground']})
            self._physics_layout=(sources,coverage(self.scene,physical,self.replaced_ground));self._physics_layout_key=key
        sources,collision_coverage=self._physics_layout
        gravity=self.model.gravity.numpy()[0].tolist()
        return {'gravityWorldMps2':gravity,'gravityEnabled':True,'units':'m/s^2','source':'newton-model','groundSources':sources,'collisionCoverage':collision_coverage}

    # -- 观测 ---------------------------------------------------------------
    def _read_joint_arrays(self):
        """用 Newton 的 eval_ik 从 body 状态反解广义坐标（求解器只积分 body_q/body_qd）。"""
        newton.eval_ik(self.model, self.state_a, self.ik_q, self.ik_qd)
        return self.ik_q.numpy(), self.ik_qd.numpy()

    def observe(self, selection=None):
        self.require_ready()
        selection = selection or {}
        if selection.get('collisionTopology') is not None:
            raise SimError('UNSUPPORTED_CAPABILITY', 'Newton Provider 尚未实现通用 collisionTopology 读回')
        if self.solver_name == 'implicit-mpm':
            return self.observe_mpm(selection)
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
            if not info or info['rootBody']is None:
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
        frame['worldPhysics']=self.world_physics()
        if selection.get('contacts') or selection.get('penetrations'):
            frame.update(self.contact_observation())
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
            for key in ('actuator', 'controlMode'):
                if j['drive'].get(key) is not None:
                    item[key] = j['drive'][key]
            joints.append(item)
        free_bases = [{'jointName': j['label'], 'bodyName': self._body_label(self._body_of_free_joint(j))} for j in info['freeJoints']]
        controlled = [j['label'] for j in info['joints'] if j['drive']['available']]
        capabilities = []
        for kind in ROBOT_CAPABILITY_KINDS:
            error = self.action_capability(kind, info)
            item = {'kind': kind, 'available': error is None}
            if error:
                item['reason'] = error.code + ': ' + str(error)
            elif kind == 'joint':
                item.update(joints=len(info['joints']), controlledJointNames=controlled, controlledSource='source-metadata')
            elif kind == 'control':
                item['jointNames'] = controlled
            capabilities.append(item)
        return {
            'entityId': eid,
            'modelVersion': str(info['source']),
            'expectedGeneration': self.generation,
            'collisionContextVersion': str(self.generation),
            'joints': joints,
            'controlledJointNames': controlled,
            'tendonActuators': [],
            'freeBases': free_bases,
            'controller': {},
            'capabilities': capabilities,
            **({} if controlled else {'controlMetadata': {'status': 'UNAVAILABLE',
                'reason': 'UNSUPPORTED_CAPABILITY: 没有当前求解器可忠实驱动的源位置执行器 / No supported source position drives'}}),
            # 加法字段：Newton 自己的关节标签与形状标签，便于调用方定位原生对象。
            'nativeJointLabels': [j['label'] for j in info['joints']] + [j['label'] for j in info['freeJoints']],
            'nativeShapeLabels': list(info['shapeLabels']),
            'device': self.device,
        }

    def world_capabilities(self):
        result = copy.deepcopy(CAPABILITIES)
        result['supported']['liquidParticles'] = self.solver_name == 'implicit-mpm'
        if self.solver_name == 'implicit-mpm':
            result['slice'] = 'mpm-water-1'
            result['supported'].update(execute=False, manualClockAdvance=False, contacts=False,
                                       freeBodies=False, articulatedJoints=False)
            result['unsupported']['execute'] = {kind: ACTION_UNSUPPORTED_CODE for kind in ACTION_KINDS}
            result['unsupported'].update({'observe.contacts': 'UNSUPPORTED_CAPABILITY',
                                                                            'manualClockAdvance': 'UNSUPPORTED_CAPABILITY'})
            return result
        drives = any(j['drive']['available'] for info in self.entities.values() for j in info['joints'])
        result['supported']['execute'] = drives
        result['supported']['manualClockAdvance'] = drives
        if not drives:
            result['unsupported']['execute'].update({kind: 'UNSUPPORTED_CAPABILITY' for kind in EXECUTABLE_KINDS})
        return result

    def source_drives(self, model):
        """读取 Newton 导入器归一化的源执行器；不从非零增益猜控制模式。"""
        native = getattr(model, 'mujoco', None)
        if native is None or not hasattr(native, 'actuator_trnid'):
            return {}
        fields = ['actuator_trnid', 'actuator_trntype', 'actuator_dyntype', 'actuator_gaintype',
                  'actuator_biastype', 'actuator_gear', 'actuator_gainprm', 'actuator_biasprm',
                  'actuator_ctrllimited', 'actuator_ctrlrange', 'actuator_has_ctrlrange',
                  'actuator_forcelimited', 'actuator_has_forcerange', 'ctrl_source', 'ctrl_type']
        values = {key: getattr(native, key).numpy().tolist() for key in fields}
        result = {}
        for a, label in enumerate(native.actuator_label):
            if int(values['actuator_trntype'][a]) != 0:
                continue
            dof = int(values['actuator_trnid'][a][0])
            gain, bias = values['actuator_gainprm'][a], values['actuator_biasprm'][a]
            mode = {0: 'position', 1: 'velocity', 2: 'torque'}.get(int(values['ctrl_type'][a]))
            drive = {'actuator': label, 'controlMode': mode, 'available': False}
            reason = '源执行器不是当前接通的直接位置 PD / Source actuator is not a supported position PD drive'
            supported = (mode == 'position' and int(values['ctrl_source'][a]) == 0
                         and int(values['actuator_dyntype'][a]) == 0
                         and int(values['actuator_gaintype'][a]) == 0
                         and int(values['actuator_biastype'][a]) == 1
                         and np.allclose(values['actuator_gear'][a], [1, 0, 0, 0, 0, 0])
                         and gain[0] > 0 and math.isclose(gain[0], -bias[1], rel_tol=1e-6)
                         and bias[0] == 0 and bias[2] <= 0
                         and np.allclose(gain[1:], 0) and np.allclose(bias[3:], 0))
            limited_force = (int(values['actuator_forcelimited'][a]) != 0
                             and bool(values['actuator_has_forcerange'][a]))
            if supported and limited_force:
                reason = 'XPBD 不执行源 forcerange，未接通该执行器 / XPBD does not enforce source force limits'
                supported = False
            if supported:
                drive['available'] = True
                if int(values['actuator_ctrllimited'][a]) != 0 and values['actuator_has_ctrlrange'][a]:
                    drive['controlRange'] = values['actuator_ctrlrange'][a]
            else:
                drive['reason'] = 'UNSUPPORTED_CAPABILITY: ' + reason
            if dof in result:
                drive['available'] = False
                drive['reason'] = 'UNSUPPORTED_CAPABILITY: 同一关节有多个源执行器 / Multiple source actuators drive this joint'
            result[dof] = drive
        return result

    def compile_mpm(self, scene):
        """最小原生水例：与同 pin water_dam_break 相同的隐式 MPM 与材料，不借用 XPBD。"""
        from newton.solvers import SolverImplicitMPM
        liquids = [e for e in scene['entities'] if e.get('components', {}).get('newton', {}).get('mpm') is not None]
        if len(liquids) != 1:
            raise SimError('UNSUPPORTED_CAPABILITY', '当前 MPM 路径需要一个 water 粒子实体 / Current MPM path requires one water entity')
        water = liquids[0]
        cfg = water['components']['newton']['mpm']
        if not isinstance(cfg, dict) or cfg.get('kind') != 'water':
            raise SimError('UNSUPPORTED_CAPABILITY', '当前原生 MPM 只接通 kind=water / Only native MPM kind=water is connected')
        if native_source(water) is not None:
            raise SimError('UNSUPPORTED_CAPABILITY', 'water 实体同时声明了 MJCF/URDF 源；未接通把原生模型转为流体 / Native source-to-fluid conversion is not connected')
        dims = cfg.get('dimensions', [4, 4, 4])
        if not isinstance(dims, list) or len(dims) != 3 or any(type(n) is not int or n <= 0 for n in dims):
            raise SimError('INVALID_ARGUMENT', 'dimensions 必须是三个正整数 / dimensions must contain three positive integers')
        spacing = positive(cfg.get('spacingM', .03), 'spacingM')
        density = positive(cfg.get('densityKgM3', 1000.0), 'densityKgM3')
        young = positive(cfg.get('youngModulusPa', 1e15), 'youngModulusPa')
        poisson = finite(cfg.get('poissonRatio', .3), 'poissonRatio')
        if not -1 < poisson < .5:
            raise SimError('INVALID_ARGUMENT', 'poissonRatio 必须在 (-1,.5) 内 / poissonRatio must lie within (-1,.5)')
        viscosity = finite(cfg.get('viscosityPaS', 0.0), 'viscosityPaS')
        if viscosity < 0:
            raise SimError('INVALID_ARGUMENT', 'viscosityPaS 不能为负 / viscosityPaS must be nonnegative')
        voxel = positive(cfg.get('voxelSizeM', spacing * 2), 'voxelSizeM')
        if cfg.get('gridType', 'dense') != 'dense':
            raise SimError('UNSUPPORTED_CAPABILITY', '当前水例使用原生 dense grid / Current water path uses the native dense grid')
        builder = newton.ModelBuilder(gravity=wp.vec3(*scene_gravity(scene, SimError)))
        SolverImplicitMPM.register_custom_attributes(builder)
        poses, maps, ground, warnings, native_planes, replaced = self.build_scene(builder, scene, {water['entityId']})
        # 本切片没有刚体求解器耦合，不能静默冻结一台有自由/驱动关节的机器人充当容器。
        if any(int(kind) != int(newton.JointType.FIXED) for kind in builder.joint_type):
            raise SimError('UNSUPPORTED_CAPABILITY', 'MPM 水例仅接受固定原生碰撞体；未接通动态刚体/机器人耦合 / MPM water currently accepts fixed colliders only')
        p, q, scale = poses[water['entityId']]
        if not np.allclose(scale, [1, 1, 1]):
            raise SimError('UNSUPPORTED_CAPABILITY', 'MPM 粒子不接受实体缩放，请使用 spacingM / MPM particles require unit entity scale; use spacingM')
        builder.add_particle_grid(pos=wp.vec3(*[float(v) for v in p]), rot=wp.quat(*[float(v) for v in q]),
                                  vel=wp.vec3(0.0), dim_x=dims[0], dim_y=dims[1], dim_z=dims[2],
                                  cell_x=spacing, cell_y=spacing, cell_z=spacing,
                                  mass=density * spacing ** 3, jitter=0.0, radius_mean=spacing * .5,
                                  flags=newton.ParticleFlags.ACTIVE)
        model = builder.finalize(device=self.device)
        model.mpm.young_modulus.fill_(young)
        model.mpm.poisson_ratio.fill_(poisson)
        model.mpm.viscosity.fill_(viscosity)
        # 与原生水例一致：无摩擦/偏应力屈服强度，允许水的张力屈服比。
        model.mpm.friction.fill_(0.0)
        model.mpm.yield_stress.fill_(0.0)
        model.mpm.tensile_yield_ratio.fill_(1.0)
        config = SolverImplicitMPM.Config()
        config.grid_type = 'dense'
        config.voxel_size = voxel
        config.max_iterations = 50
        config.tolerance = 1e-3
        config.warmstart_mode = 'particles'
        config.strain_basis = 'P0'
        config.collider_basis = 'pic'
        config.velocity_basis = 'Q1'
        solver = SolverImplicitMPM(model, config=config)
        solver.setup_collider(collider_projection_threshold=[.25 * voxel])
        states = (model.state(), model.state())
        states[0].mpm.particle_Jp.fill_(1.0)
        entities = {}
        for eid, native in maps.items():
            b0, b1 = native['bodyStart'], native['bodyEnd']
            s0, s1 = native['shapeStart'], native['shapeEnd']
            entities[eid] = {'entity': copy.deepcopy(next(e for e in scene['entities'] if e['entityId'] == eid)),
                             'rootBody': b0 if b1 > b0 else None, 'bodyStart': b0, 'bodyEnd': b1,
                             'joints': [], 'freeJoints': [],
                             'shapeLabels': list(model.shape_label[s0:s1]), 'shapeStart': s0, 'shapeEnd': s1,
                             'source': native['source']}
        entities[water['entityId']] = {'entity': copy.deepcopy(water), 'rootBody': None, 'joints': [],
                                      'freeJoints': [], 'shapeLabels': [], 'source': 'newton-native-mpm-water',
                                      'liquid': True, 'bodyStart': 0, 'bodyEnd': 0, 'shapeStart': 0, 'shapeEnd': 0}
        for index, kind in enumerate(model.shape_type.numpy()):
            if int(kind) == int(newton.GeoType.PLANE) and model.shape_label[index] not in ground:
                ground.append(model.shape_label[index])
        if self.clock == 'manual':
            warnings.append({'code': 'MPM_MANUAL_CLOCK_FROZEN',
                             'message': 'MPM 水例没有机器人动作推进窗口；请用 realtime 时钟 / MPM water requires realtime clock for advancement'})
        return {'builder': builder, 'model': model, 'states': states, 'control': None, 'solver': solver,
                'solverName': 'implicit-mpm', 'pipeline': None, 'contacts': None, 'ik_q': None, 'ik_qd': None,
                'entities': entities, 'ground': ground, 'warnings': warnings,
                'nativeGround': native_planes, 'replacedGround': replaced}

    def observe_mpm(self, selection):
        if selection.get('contacts') or selection.get('penetrations'):
            raise SimError('UNSUPPORTED_CAPABILITY', 'MPM 碰撞由原生 collider 求解，未导出刚体 Contacts 观测 / MPM collider contacts are not exposed as rigid Contacts')
        poses = world_poses(self.scene)
        particles = self.state_a.particle_q.numpy()
        radius = float(self.model.particle_radius.numpy()[0])
        entities = []
        for entity in self.scene['entities']:
            eid = entity['entityId']
            if selection.get('entityIds') and eid not in selection['entityIds']:
                continue
            p, q, scale = poses[eid]
            item = {'entityId': eid, 'transform': {'position': p.tolist(), 'quaternion': q.tolist(), 'scale': scale.tolist()}}
            info = self.entities.get(eid)
            if info and info.get('liquid'):
                item['dynamicGeometry'] = [{'nativeName': 'newton-mpm/' + eid, 'kind': 'particles',
                                            'positionsM': particles.reshape(-1).tolist(), 'radiusM': radius}]
                if selection.get('sensors', True):
                    material = {name: float(getattr(self.model.mpm, attr).numpy()[0]) for name, attr in {
                        'youngModulusPa': 'young_modulus', 'poissonRatio': 'poisson_ratio',
                        'viscosityPaS': 'viscosity', 'friction': 'friction', 'yieldStressPa': 'yield_stress',
                        'tensileYieldRatio': 'tensile_yield_ratio',
                    }.items()}
                    material.update(solver='implicit-mpm', kind='water', gridType=self.solver.grid_type,
                                    particleCount=int(self.model.particle_count), spacingM=radius * 2,
                                    voxelSizeM=float(self.solver.voxel_size),
                                    densityKgM3=float(self.model.particle_mass.numpy()[0]) / (radius * 2) ** 3,
                                    materialNote='E/nu 是原生 MPM 压缩响应参数；水例采用零摩擦与零偏应力屈服 / E and nu control native MPM compressive response, with zero friction and deviatoric yield stress')
                    item['sensors'] = {'nativePhysics': material}
            entities.append(item)
        return {'worldId': self.id, 'generation': self.generation, 'sceneRevision': self.applied_revision,
                'stepIndex': self.step_index, 'simTime': float(self.sim_time),
                'frameId': f'{self.id}:{self.generation}:{self.step_index}', 'entities': entities,
                'executionMode': 'physical-contact', 'assistAdvanceCount': 0, 'device': self.device,
                'worldPhysics': self.world_physics()}

    def contact_observation(self):
        # 碰撞点属于本步原生碰撞流形；距离按当前积分状态求值，不以 shape 包围盒估算。
        if self.step_index == 0:
            self.pipeline.collide(self.state_a, self.contacts)
        newton.eval_rigid_contact_kinematics(self.model, self.state_a, self.contacts,
                                           out_distance=self.contact_distances,
                                           out_point0_world=self.contact_points0,
                                           out_point1_world=self.contact_points1)
        count = min(int(self.contacts.rigid_contact_count.numpy()[0]), self.contacts.rigid_contact_max)
        shape0 = self.contacts.rigid_contact_shape0.numpy()[:count]
        shape1 = self.contacts.rigid_contact_shape1.numpy()[:count]
        distances = self.contact_distances.numpy()[:count]
        points0, points1 = self.contact_points0.numpy()[:count], self.contact_points1.numpy()[:count]
        normals = self.contacts.rigid_contact_normal.numpy()[:count]
        # step() 后立即 update_contacts，同一 Contacts 对应本步的原生冲量；首次碰撞没有力测量。
        forces = self.contacts.force.numpy()[:count] if self.step_index > 0 and self.solver_name == 'xpbd' else None
        labels = self.model.shape_label
        contacts, penetrations = [], {}
        for i in range(count):
            s0, s1 = int(shape0[i]), int(shape1[i])
            if s0 < 0 or s1 < 0:
                continue
            distance = float(distances[i])
            item = {'geom1': labels[s0], 'geom2': labels[s1], 'distanceM': distance,
                    'positionM': ((points0[i] + points1[i]) * .5).tolist(),
                    'normal': normals[i].tolist(), 'sourceStep': self.step_index}
            if forces is not None:
                item['forceN'] = forces[i][:3].tolist()
            contacts.append(item)
            if distance < 0:
                key = tuple(sorted((s0, s1)))
                if key not in penetrations or distance < penetrations[key]['minDistanceM']:
                    penetrations[key] = {'geom1': labels[key[0]], 'geom2': labels[key[1]],
                                         'geom1Id': key[0], 'geom2Id': key[1], 'minDistanceM': distance}
        return {'contacts': contacts, 'penetrations': {'count': len(penetrations),
                'worst': sorted(penetrations.values(), key=lambda p: p['minDistanceM'])[:20]},
                'contactForceNote': 'XPBD 原生接触冲量/dt 近似值，forceN 为世界坐标下 shape1 对 shape0 的力；首次碰撞或 semi 不提供力 / Native XPBD approximate world-space contact force on shape0'}

    def action_capability(self, kind, info):
        if self.solver_name == 'implicit-mpm':
            return SimError(ACTION_UNSUPPORTED_CODE, 'MPM 水例未接通机器人动作 / Robot actions are unavailable in the MPM water world: ' + str(kind))
        if kind not in EXECUTABLE_KINDS:
            return SimError(ACTION_UNSUPPORTED_CODE, 'Newton 未接通动作 ' + str(kind) + ' / Newton action is not implemented: ' + str(kind))
        if not any(j['drive']['available'] for j in info['joints']):
            return SimError('UNSUPPORTED_CAPABILITY', '实体没有当前求解器可忠实驱动的源位置执行器 / Entity has no supported source position drive')
        if kind == 'control' and self.clock != 'manual':
            return SimError('UNSUPPORTED_CAPABILITY', 'control 需要 manual 时钟 / control requires manual clock')
        return None

    def execute(self, action):
        self.require_ready()
        kind = action.get('kind')
        if self.solver_name == 'implicit-mpm':
            raise self.action_capability(kind, {})
        if kind not in EXECUTABLE_KINDS:
            raise self.action_capability(kind, {})
        if type(action.get('expectedGeneration')) is not int or action['expectedGeneration'] != self.generation:
            raise SimError('STALE_GENERATION', '动作属于旧模型代次 / Action generation does not match world')
        aid = action.get('actionId')
        if not isinstance(aid, str) or not aid:
            raise SimError('INVALID_ARGUMENT', 'actionId 必须是非空字符串 / actionId must be a nonempty string')
        if aid in self.receipts:
            return copy.deepcopy(self.receipts[aid])
        eid = action.get('entityId')
        info = self.entities.get(eid)
        if not info:
            raise SimError('ENTITY_NOT_SIMULATED', '实体没有已加载的物理表示 / Entity is not simulated: ' + str(eid))
        error = self.action_capability(kind, info)
        if error:
            raise error
        if any(a['entityId'] == eid for a in self.active.values()):
            raise SimError('WORLD_BUSY', '实体已有活动动作 / Entity already has an active action: ' + eid)
        names = action.get('jointNames', [])
        if not isinstance(names, list) or not names or not all(isinstance(n, str) for n in names) or len(set(names)) != len(names):
            raise SimError('INVALID_ARGUMENT', 'jointNames 必须非空且唯一 / jointNames must be nonempty and unique')
        joints = {j['label']: j for j in info['joints']}
        selected = []
        for name in names:
            if name not in joints:
                raise SimError('JOINT_NOT_FOUND', '未知关节 / Unknown joint: ' + name)
            joint = joints[name]
            if not joint['drive']['available']:
                raise SimError('UNSUPPORTED_CAPABILITY', joint['drive']['reason'])
            selected.append(joint)
        if kind == 'trajectory' and set(names) != {j['label'] for j in info['joints'] if j['drive']['available']}:
            raise SimError('INCOMPLETE_JOINT_VECTOR', 'trajectory 必须覆盖全部受控关节 / trajectory must cover all controlled joints')

        def positions(values):
            if not isinstance(values, list) or len(values) != len(names):
                raise SimError('INVALID_ARGUMENT', '目标向量与关节数不一致 / Position vector length does not match joints')
            result = [finite(v, n) for n, v in zip(names, values)]
            for j, value in zip(selected, result):
                for bounds in (j.get('range'), j['drive'].get('controlRange')):
                    if bounds and not bounds[0] <= value <= bounds[1]:
                        raise SimError('OUT_OF_RANGE', '目标超出源关节/执行器范围 / Target exceeds source joint or actuator range: ' + j['label'])
            return result

        current, _ = self._read_joint_arrays()
        origin = [float(current[j['coord']]) for j in selected]
        if kind == 'control':
            steps = action.get('stepCount')
            if isinstance(steps, bool) or not isinstance(steps, int) or steps <= 0:
                raise SimError('INVALID_ARGUMENT', 'stepCount 必须是正整数 / stepCount must be a positive integer')
            points = [{'timeS': 0.0, 'positions': positions(action.get('positions'))}]
            duration, total_steps = steps * self.dt, steps
        else:
            if kind == 'joint':
                duration = positive(action.get('durationS'), 'durationS')
                points = [{'timeS': 0.0, 'positions': origin},
                          {'timeS': duration, 'positions': positions(action.get('positions'))}]
            else:
                points = []
                raw = action.get('points')
                if not isinstance(raw, list) or not raw:
                    raise SimError('INVALID_ARGUMENT', 'trajectory 需要非空 points / trajectory requires nonempty points')
                for point in raw:
                    t = finite(point.get('timeS'), 'timeS')
                    if t < 0 or (points and t <= points[-1]['timeS']):
                        raise SimError('INVALID_ARGUMENT', 'points 时间必须非负且严格递增 / Point times must be nonnegative and increasing')
                    points.append({'timeS': t, 'positions': positions(point.get('positions'))})
                duration = positive(points[-1]['timeS'], 'trajectory duration')
                if points[0]['timeS'] > 0:
                    points.insert(0, {'timeS': 0.0, 'positions': origin})
                plan = action.get('plan')
                if plan and (plan.get('expectedGeneration') != self.generation or plan.get('entityId') != eid
                             or str(plan.get('collisionContextVersion')) != str(self.generation)
                             or str(plan.get('modelVersion')) != str(info['source'])
                             or plan.get('jointNames') != names or plan.get('points') != raw):
                    raise SimError('STALE_PLAN', '轨迹 plan 与当前模型/请求不一致 / Trajectory plan does not match current model or request')
            settle = finite(action.get('settleTimeS', .2), 'settleTimeS')
            if settle < 0:
                raise SimError('INVALID_ARGUMENT', 'settleTimeS 不能为负 / settleTimeS must be nonnegative')
            total_steps = max(1, math.ceil((duration + settle) / self.dt - 1e-9))
        tolerance = positive(action.get('tolerance', .02), 'tolerance')
        start = action.get('startStep', self.step_index + 1)
        if isinstance(start, bool) or not isinstance(start, int) or start <= self.step_index:
            raise SimError('INVALID_START_STEP', 'startStep 必须是未来整数步 / startStep must be a future integer step')
        self.active[aid] = {'entityId': eid, 'kind': kind, 'joints': selected, 'points': points,
                            'start': start, 'duration': duration, 'steps': total_steps, 'appliedSteps': 0,
                            'tolerance': tolerance, 'lastApplied': None,
                            'originAtStart': kind == 'joint' or (kind == 'trajectory' and action['points'][0]['timeS'] > 0)}
        self.receipts[aid] = {'actionId': aid, 'worldId': self.id, 'generation': self.generation, 'status': 'accepted'}
        self.status = 'running'
        self.next_tick = time.monotonic()
        return copy.deepcopy(self.receipts[aid])

    def write_targets(self, joints, values):
        targets = self.control.joint_target_q.numpy()
        velocities = self.control.joint_target_qd.numpy()
        for joint, value in zip(joints, values):
            targets[joint['coord'] if newton.use_coord_layout_targets else joint['dof']] = value
            velocities[joint['dof']] = 0.0
        self.control.joint_target_q.assign(targets)
        self.control.joint_target_qd.assign(velocities)

    def finish(self, aid, status, reason=None, state_available=True):
        active = self.active.pop(aid)
        receipt = self.receipts[aid]
        receipt.update(status=status, endStep=self.step_index)
        if reason:
            receipt['reason'] = reason
        joints = active['joints']
        measured = None
        hold = None
        reached = False
        if state_available:
            q, _ = self._read_joint_arrays()
            measured = [float(q[j['coord']]) for j in joints]
            reached = bool(active['appliedSteps'] and max(abs(a-b) for a, b in zip(measured, active['points'][-1]['positions'])) <= active['tolerance'])
            if status != 'completed' and active['appliedSteps']:
                self.write_targets(joints, measured)
                reference = self.control.joint_target_q.numpy()
                hold = [float(reference[j['coord'] if newton.use_coord_layout_targets else j['dof']]) for j in joints]
                for joint in joints:
                    self.commanded.pop((active['entityId'], joint['label']), None)
            receipt['finalState'] = self.observe({'entityIds': [active['entityId']], 'contacts': True})
        receipt['effect'] = {'motions': [{'entityId': active['entityId'], 'kind': active['kind'],
            'jointNames': [j['label'] for j in joints], 'referencePositions': active['points'][-1]['positions'],
            'measuredPositions': measured, 'lastAppliedPositions': active['lastApplied'], 'holdReference': hold,
            'appliedSteps': active['appliedSteps'], 'targetReached': reached, 'tolerance': active['tolerance'],
            'controlMode': 'source-position-PD'}], 'executionMode': 'physical-contact'}
        if status != 'completed':
            receipt['taskAchieved'] = False
        if not self.active and self.status == 'running':
            self.status = 'ready'
        emit({'event': 'receipt', 'receipt': copy.deepcopy(receipt)})

    # -- 物理 ---------------------------------------------------------------
    def tick(self):
        if self.status not in ('ready', 'running'):
            return
        if self.clock == 'manual' and not self.active:
            return
        for aid, active in list(self.active.items()):
            if self.step_index + 1 < active['start']:
                continue
            receipt = self.receipts[aid]
            if receipt['status'] == 'accepted':
                receipt.update(status='running', startStep=self.step_index + 1)
                # 未来排程从实际开始时的位置插值，不采用排程时已过时的初态。
                if active['originAtStart']:
                    q, _ = self._read_joint_arrays()
                    active['points'][0]['positions'] = [float(q[j['coord']]) for j in active['joints']]
            elapsed = min((active['appliedSteps'] + 1) * self.dt, active['duration'])
            points = active['points']
            values = points[-1]['positions']
            for first, second in zip(points, points[1:]):
                if elapsed <= second['timeS']:
                    alpha = max(0.0, min(1.0, (elapsed - first['timeS']) / (second['timeS'] - first['timeS'])))
                    values = [(1-alpha)*a + alpha*b for a, b in zip(first['positions'], second['positions'])]
                    break
            self.write_targets(active['joints'], values)
            active['lastApplied'] = list(values)
            for joint in active['joints']:
                self.commanded[(active['entityId'], joint['label'])] = {'joint': joint, 'actionId': aid}
        if self.solver_name == 'implicit-mpm':
            self.solver.step(self.state_a, self.state_b, None, None, self.dt)
            self.solver.project_outside(self.state_b, self.state_b, self.dt)
            self.state_a, self.state_b = self.state_b, self.state_a
            if not np.isfinite(self.state_a.particle_q.numpy()).all() or not np.isfinite(self.state_a.particle_qd.numpy()).all():
                raise SimError('ENGINE_INSTABILITY', 'MPM 产生非有限粒子状态 / MPM produced nonfinite particle state')
        else:
            self.state_a.clear_forces()
            self.pipeline.collide(self.state_a, self.contacts)
            self.solver.step(self.state_a, self.state_b, self.control, self.contacts, self.dt)
            self.state_a, self.state_b = self.state_b, self.state_a
            if not np.isfinite(self.state_a.body_q.numpy()).all() or not np.isfinite(self.state_a.body_qd.numpy()).all():
                raise SimError('ENGINE_INSTABILITY', 'Newton 产生非有限刚体状态 / Newton produced nonfinite body state')
        self.step_index += 1
        self.sim_time = self.step_index * self.dt
        if self.solver_name == 'xpbd':
            self.solver.update_contacts(self.contacts, self.state_a)
        for aid, active in list(self.active.items()):
            if self.receipts[aid]['status'] == 'running':
                active['appliedSteps'] += 1
                if active['appliedSteps'] >= active['steps']:
                    self.finish(aid, 'completed')
        now = time.monotonic()
        if now - self.last_frame >= 1.0 / self.frame_hz:
            emit({'event': 'frame', 'frame': self.observe()})
            self.last_frame = now

    def stop(self, selection):
        selection = selection or {}
        if selection.get('expectedGeneration') is not None and (type(selection['expectedGeneration']) is not int or selection['expectedGeneration'] != self.generation):
            raise SimError('STALE_GENERATION', '停止请求属于旧代次 / Stop request has a stale generation')
        self.require_ready()
        aid = selection.get('actionId')
        if aid and aid not in self.receipts:
            raise SimError('ACTION_NOT_FOUND', 'actionId 未知 / Unknown actionId: ' + str(aid))
        receipts, affected = [], set()
        for action_id, active in list(self.active.items()):
            if aid and action_id != aid:
                continue
            if selection.get('entityIds') is not None and active['entityId'] not in selection['entityIds']:
                continue
            affected.add(active['entityId'])
            self.finish(action_id, 'cancelled', 'STOP_CONFIRMED')
            receipts.append(copy.deepcopy(self.receipts[action_id]))
        # 已完成动作留下的参考仍可由 stop 撤销；旧 actionId 不得改写后来动作拥有的参考。
        held = [(key, value) for key, value in self.commanded.items()
                if (not aid or value['actionId'] == aid)
                and (selection.get('entityIds') is None or key[0] in selection['entityIds'])]
        if held:
            q, _ = self._read_joint_arrays()
            self.write_targets([v['joint'] for _, v in held], [float(q[v['joint']['coord']]) for _, v in held])
            for key, _ in held:
                self.commanded.pop(key)
                affected.add(key[0])
        return {'stopped': True, 'stepIndex': self.step_index, 'receipts': receipts, 'affectedEntityIds': sorted(affected)}

    def close(self):
        if self.status == 'closed':
            return
        for aid in list(self.active):
            self.finish(aid, 'cancelled', 'WORLD_CLOSED', state_available=self.model is not None)
        self.release_camera()
        self.status = 'closed'
        # 丢弃全部 Newton/Warp 原生句柄：Warp 没有显式 dispose，数组按其分配器在引用归零后回收。
        self.builder = None
        self.model = None
        self.state_a = self.state_b = None
        self.control = None
        self.solver = None
        self.pipeline = None
        self.contacts = None
        self.contact_distances = None
        self.contact_points0 = self.contact_points1 = None
        self.ik_q = self.ik_qd = None
        self.entities = {}
        self.commanded = {}
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
        wp.init()
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
        if not any(w.status in ('ready', 'running') and (w.clock == 'realtime' or w.active) for w in worlds.values()):
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
                        aid = args.get('actionId')
                        if aid not in world.receipts:
                            raise SimError('ACTION_NOT_FOUND', 'actionId 未知 / Unknown actionId: ' + str(aid))
                        result = copy.deepcopy(world.receipts[aid])
                    elif method == 'execute':
                        result = world.execute(args.get('action') or {})
                    elif method == 'assist':
                        raise SimError('UNSUPPORTED_CAPABILITY', 'Newton 切片未实现 assist（附着/辅助写回）')
                    elif method == 'camera_list':
                        result = world.camera().list(args.get('options', {}))
                    elif method == 'capture':
                        result = world.camera().capture(args.get('options', {}))
                    elif method == 'capture_multi':
                        result = world.camera().capture_multi(args.get('options', {}))
                    elif method == 'capture_publish':
                        result = world.camera().publish_capture(args['captureId'], args['fromDir'], args['toDir'])
                    elif method in ('camera_adjust',
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
            if now >= world.next_tick and world.status in ('ready', 'running') and (world.clock != 'manual' or world.active):
                try:
                    world.tick()
                    world.next_tick = (time.monotonic() if world.clock == 'manual' else max(world.next_tick + world.dt / world.factor, now - .05))
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
