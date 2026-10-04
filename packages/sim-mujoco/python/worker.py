"""MuJoCo 原生运行所有者。只有 World.tick 调用 mj_step；stdin 只入队。
协议是 NDJSON，所有状态数组在 RPC/帧边界复制。无 Viewer/LLM/注册中心依赖。
"""
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import re
import shutil
import sys
import tempfile
import threading
import time
import traceback
import uuid
import struct
import zlib
from urllib.parse import urlparse, unquote
from xml.etree import ElementTree
from world_physics import scene_gravity,declared_ground_ids,explicit_ground_requested,coverage,replaceable_standard_ground,standard_support_plane

try:
    import mujoco as mj
    import numpy as np
    from triangle_surface import validate_exact_triangle_surfaces
    import gait
except ImportError as exc:
    print(json.dumps({'event': 'fatal', 'error': {'code': 'PROVIDER_UNAVAILABLE', 'message': str(exc)}}), flush=True)
    sys.exit(2)


def emit(value):
    print(json.dumps(value, allow_nan=False, separators=(',', ':')), flush=True)


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


def joint_gain(cfg, key, name, fallback_key, default):
    """逐关节增益（controller.jointKp/jointKd 映射）按关节名取值，缺该关节回落标量 kp/kd。

    官方力矩模型各关节刚度常差一个量级（如 H1 髋 150/膝 200/踝 40），单一标量表达不了；
    两者都没声明才用调用方的默认值。返回有限数值，非法取值按 INVALID_CONTROL_MAPPING 明确失败。
    """
    table = cfg.get(key)
    if isinstance(table, dict) and name in table:
        return finite(table[name], key + '.' + name)
    scalar = cfg.get(fallback_key)
    return finite(scalar, fallback_key) if scalar is not None else float(default)


def is_ground_geom_name(name):
    """源声明的世界地面 geom 名（floor/ground 字面约定，如官方 h1/scene.xml 与 bhl_scene.xml 的 floor）。

    只用于把这类 geom 的**接触标签**登记进 world handle 的 groundGeomNames，供接触过滤直接匹配；
    不改任何物理，也不按机器人名猜测。
    """
    lowered = str(name).lower()
    return 'floor' in lowered or 'ground' in lowered


def enum_name(enum, value):
    """mjt 枚举的可读名；未知取值退化为数字，错误信息不为展示而丢字段。"""
    try:
        return enum(int(value)).name
    except ValueError:
        return str(value)


# 单自由度关节类型（hinge/slide）必须按整数比较：mujoco 的 mjtJoint 是 enum.Enum，而 model.jnt_type
# 的元素是 numpy 整型；在本环境（mujoco 3.13 + numpy 2.2）里
# `np.int32(3) in (mjtJoint.mjJNT_HINGE, mjtJoint.mjJNT_SLIDE)` 恒为 False，只有逐元素 `==` 成立。
# 用元组成员判断会让原生 MJCF 实体的 joints/initialJoints 静默为空，进而 describe 无关节、
# joint/gripper 动作在 prepare 阶段 KeyError。统一取整数集合，跨 numpy 版本都成立。
SCALAR_JOINT_TYPES = (int(mj.mjtJoint.mjJNT_HINGE), int(mj.mjtJoint.mjJNT_SLIDE))


def fixed_position_servo(model, i):
    """核对“标准位置伺服”的固定 gain/bias 关系与执行器状态，供 tendon 坐标通道判断能否称位置参考。

    affine bias 的标准力律是
        f = gainprm[0]·ctrl + biasprm[0] + biasprm[1]·actuator_length + biasprm[2]·actuator_velocity，
    而 actuator_length = gear×坐标（肌腱/关节坐标），所以当 dyntype=none、gaintype=fixed、biastype=affine、
    biasprm[0]==0 且 gainprm[0]==-biasprm[1] 时：
        f = gainprm[0]·(ctrl − gear×坐标) + biasprm[2]·速度。
    biasprm[2]（=−kv，阻尼）可以非零：此时力并不恒等于纯 gainprm[0]·(ctrl−gear×坐标)，本函数不检查它，
    也不拒绝合法的带阻尼标准 position；只有零速度稳态才退化为 f=gainprm[0]·(ctrl−gear×坐标)，
    平衡坐标=ctrl/gear，因此 ctrl 仍能换算成肌腱坐标参考（阻尼只影响瞬态与带速度时的力）。
    小模型实测（08_tendon_receipt_contract_fix/work/gear-probe.py，MuJoCo 3.3.7）：gear=2 的标准 position
    在 ctrl=0.7 时稳定在坐标 0.35=ctrl/gear；motor（biastype=none）、gain/bias 不匹配（gainprm=2,biasprm[1]=-1，
    平衡在 2·ctrl）、带 dyntype 状态的自定义律都不能按坐标参考解释，必须拒绝而不是假称 position。
    这和关节执行器沿用的旧启发式（biasprm[1]<0）无关；本函数只被 tendon 通道使用，不改源控制器。
    """
    if model.actuator_dyntype[i] != mj.mjtDyn.mjDYN_NONE:
        return False
    if model.actuator_gaintype[i] != mj.mjtGain.mjGAIN_FIXED:
        return False
    if model.actuator_biastype[i] != mj.mjtBias.mjBIAS_AFFINE:
        return False
    gain = float(model.actuator_gainprm[i, 0])
    bias0, bias1 = float(model.actuator_biasprm[i, 0]), float(model.actuator_biasprm[i, 1])
    return gain != 0 and abs(bias0) <= 1e-12 and abs(gain + bias1) <= 1e-12 * max(1.0, abs(gain))


def path_from_uri(value):
    p = urlparse(value)
    if p.scheme == 'file':
        return unquote(p.path)
    if p.scheme:
        raise SimError('RESOURCE_NOT_LOCAL', '引擎只读取已导入的本地原件: ' + p.scheme)
    return str(Path(value).resolve())


# MuJoCo 3.13 的按路径加载按扩展名查资源解码器，表里只有 .xml/.urdf/.mjb；产品自己的原生
# 原件约定用 .mjcf（materials/robots、机器人工具 schema、场景导入落下的原件副本），
# MjSpec.from_file 对它会直接报 could not decode content（内容本身没问题，同一个文件按
# XML 解析即可编译）。这里登记解码表认的扩展名。
PATH_DECODABLE_SUFFIXES = frozenset({'.xml', '.urdf', '.mjb'})

# 本会话运行根（装配方 spawn 前经环境给出；未接线启动时为空）。中转文件只落在本会话自己的运行根
# 或平台临时区，不往产品共享目录、也不往原件目录写。
RUNTIME_ROOT_ENV = 'LYAPUNOV_SIM_RUNTIME_ROOT'


def writable_scratch_root():
    """本次执行真的能写中转文件的位置：优先本会话运行根，其次平台临时区；都不能写返回 None。

    逐个**真写一次探针文件**再判定，不按"目录存在"或"路径看着像可写"推断：沙箱下存在且
    不可写的目录很常见（只读挂载的原件目录），按存在性判断会把拒绝伪装成成功。
    """
    candidates = []
    root = os.environ.get(RUNTIME_ROOT_ENV, '').strip()
    if root:
        candidates.append(Path(root) / 'scratch')
    try:
        candidates.append(Path(tempfile.gettempdir()))
    except OSError:
        # 只读执行下 Python 自己就找不到可写临时区（gettempdir 抛 FileNotFoundError）。
        # 这不是意外，而是"本次执行没有可写中转位置"的直接结论：不在这里报 Python 的
        # 临时目录错误，交给调用方给出明确的拒绝码（SCENE_LOAD_WRITE_DENIED）。
        pass
    for candidate in candidates:
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            probe = candidate / ('.lyapunov-write-probe-' + uuid.uuid4().hex[:8])
            probe.write_bytes(b'')
            probe.unlink()
            return candidate
        except OSError:
            continue
    return None


def mirror_directory(source_dir, scratch):
    """把原件所在目录按**相对名**镜像到可写中转目录：目录造成真目录、文件造成符号链接，返回镜像目录。

    只建链接、不复制内容：镜像里的相对 include/meshdir/mesh 指到的仍是原件本身，编端口径与在
    原件目录里直接 from_file 一致。两条实测约束：

      · **目录必须是真目录**——把目录也做成链接的话，链接会指回原件目录，"镜像"里再放什么都会
        落回原件目录（实测：文件条目全部 FileExistsError，因为 `mirror/assets` 就是原件 assets 本身）；
      · **镜像必须活到 compile()**——MuJoCo 在 compile 期才真的读网格/贴图，解析完就删镜像会得到
        `Error opening file 'assets/link0.stl'`（实测）。所以镜像按源目录稳定命名、建好后留在
        本会话运行根里复用，不按调用新建也不在返回前删除。

    原件目录不可写时（原件在授权根之外、或只读模式）这是 .mjcf 唯一可用的加载方式；本次新建的
    半成品建失败就删干净，已存在的镜像不动（可能正被别的 spec 编译使用）。
    """
    mirror = scratch / ('mirror-' + hashlib.sha1(str(source_dir).encode('utf-8')).hexdigest()[:16])
    created = not mirror.exists()
    mirror.mkdir(parents=True, exist_ok=True)
    try:
        for path in sorted(source_dir.rglob('*')):
            if path.is_symlink():
                continue
            target = mirror / path.relative_to(source_dir)
            if path.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            elif path.is_file():
                if target.exists() or target.is_symlink():
                    continue
                os.symlink(path, target)
    except OSError:
        if created:
            shutil.rmtree(mirror, ignore_errors=True)
        raise
    return mirror


def spec_from_path(source_path):
    """按产品给出的原件路径加载一份未编译的 MjSpec；相对 include/meshdir/mesh 一律按原件所在目录解析。

    解码表认的扩展名直接按路径加载；表外的扩展名（当前就是产品的 .mjcf 约定）在**同一目录**
    建一个 .xml 别名再按路径加载——目录没变，所以相对引用与直接 from_file 完全同口径，
    读到的字节也还是原件本身。别名只为拿到根文件，用完即删。

    原件目录不可写时（原件落在本次执行的授权根之外、或只读模式）同目录别名建不出来，改在
    **本会话可写中转目录**里做相对名软链镜像并在镜像里放根文件别名；连可写中转位置都没有
    （只读执行）就明确失败，不假装加载成功、也不越过本次调用的有效策略去写别处。
    @param source_path - components.mujoco.sourcePath（本地路径或 file:// URI）。
    @returns 原生 MjSpec。
    """
    file = Path(path_from_uri(source_path))
    if file.suffix.lower() in PATH_DECODABLE_SUFFIXES:
        return mj.MjSpec.from_file(str(file))
    if not file.is_file():
        raise SimError('INVALID_SCENE', '原生原件不存在: ' + str(file))
    alias = file.with_name('.' + file.stem + '.' + uuid.uuid4().hex[:8] + '.lyapunov-load.xml')
    alias_error = None
    try:
        try:
            os.link(file, alias)
        except OSError:
            # 不支持硬链接的文件系统：退回同一目录的符号链接，解析目录不变。
            os.symlink(file, alias)
    except OSError as exc:
        alias_error = exc
    if alias_error is None:
        try:
            return mj.MjSpec.from_file(str(alias))
        finally:
            try:
                alias.unlink()
            except OSError:
                pass
    scratch = writable_scratch_root()
    if scratch is None:
        raise SimError(
            'SCENE_LOAD_WRITE_DENIED',
            '原生原件 ' + str(file) + ' 的 .mjcf 加载需要可写别名，但本次执行没有任何可写中转位置'
            '（只读模式，或原件与中转目录都在授权根之外）：' + str(alias_error))
    mirror = mirror_directory(file.parent, scratch)
    # 根别名按原件名稳定命名并复用（同一次运行里同一原件只建一次链接）；镜像与别名都留到
    # compile（见 mirror_directory 的两条实测约束），不在这里删。
    mirror_alias = mirror / ('.load-' + hashlib.sha1(file.name.encode('utf-8')).hexdigest()[:12] + '.xml')
    if not mirror_alias.exists() and not mirror_alias.is_symlink():
        os.symlink(file, mirror_alias)
    return mj.MjSpec.from_file(str(mirror_alias))


# 与 packages/asset-bake/src/materials.ts 的 MATERIALS[name].friction 一一对应的摩擦三元组
# （滑动/扭转/滚动，即 MuJoCo geom friction 的语义顺序）。物理侧只镜像摩擦；密度与质量
# 仍由 bake 侧按网格体积结算。materials.ts 的材质表改动必须同步这里。
MATERIAL_FRICTION = {
    'plastic': [0.7, 0.02, 0.005], 'wood': [0.6, 0.02, 0.005], 'metal': [0.5, 0.02, 0.005],
    'steel': [0.5, 0.02, 0.005], 'ceramic': [0.7, 0.02, 0.005], 'glass': [0.4, 0.01, 0.002],
    'rubber': [1.2, 0.05, 0.01], 'foam': [0.9, 0.03, 0.008], 'fabric': [0.8, 0.03, 0.008],
    'leather': [0.8, 0.02, 0.005], 'cardboard': [0.6, 0.02, 0.005], 'stone': [0.8, 0.03, 0.008],
    'food': [0.7, 0.02, 0.005], 'hollow': [0.6, 0.02, 0.005],
}


def collision_friction(value, material):
    """派生碰撞 geom 的摩擦三元组（滑动/扭转/滚动）。

    显式 friction 优先：数组原样交给引擎；标量按 asset-bake frictionTripleFromSliding 的
    比例展开（滑动=f，扭转=max(.001, f×.05)，滚动=max(.0001, f×.005)）。未给 friction 时
    按 material 查材质表；两者都没有沿用既有默认。未知材质名明确报错，不静默回落默认塑料。
    """
    if value is None:
        if material is None:
            return [1, .005, .0001]
        if material not in MATERIAL_FRICTION:
            raise SimError('INVALID_ARGUMENT', '未知碰撞材质: ' + str(material))
        return list(MATERIAL_FRICTION[material])
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        sliding = max(0, finite(value, 'collision.friction'))
        return [sliding, max(.001, sliding * .05), max(.0001, sliding * .005)]
    return value


def vec3(value, name):
    """collision 组件里的三维向量（center/halfExtents 等）：必须恰为 3 个有限数值。"""
    if isinstance(value, (list, tuple)) and len(value) == 3:
        return np.array([finite(v, name + '[' + str(i) + ']') for i, v in enumerate(value)])
    raise SimError('INVALID_ARGUMENT', name + ' 必须是 3 个数值的数组')


def check_collision_scale(scale, eid):
    """派生碰撞的累计 TRS scale 合法性：符号与 0 分量。

    带符号的 scale 表示镜像：它作用在几何上是"先把局部点反射、再平移"，几何装配时
    位置（center）必须保号、尺寸（halfExtents/半径/半长）必须取正量，两者不能互换
    ——把符号带进 size 会被 MuJoCo 直接拒绝（"size 0 must be positive in geom"，70 实测：
    镜像石狮 scale=[-1,-1,-1] 的盒尺寸被折成负数，整个 world 编译失败）；反过来把位置取
    绝对值会让镜像实体落到非镜像的位置上。mesh/sdf 分支相反：MuJoCo 对 mesh scale 接受
    负分量、顶点真的被反射（实测 72 个方向射线命中与镜像方向逐条一致到 1e-15），所以
    符号要留在 mesh.scale（= D 的逐轴分量）里。

    0 分量把几何压成退化面（任何碰撞形状都表达不了，MuJoCo 一律拒绝），这里按实体归因报
    INVALID_ARGUMENT，而不是让它变成无归因的引擎编译失败。
    """
    if not (np.abs(np.asarray(scale, dtype=float)) > 0).all():
        raise SimError('INVALID_ARGUMENT', '实体 ' + eid + ' 的累计缩放含 0 分量 scale=' + str([float(value) for value in scale])
                       + '：碰撞尺寸必须是正量（0 分量把几何压成退化面，任何碰撞形状都表达不了）')


def quat_mul(a, b):
    out = np.zeros(4)
    mj.mju_mulQuat(out, np.asarray(a, dtype=float), np.asarray(b, dtype=float))
    return out


def quat_inverse(q):
    """单位四元数的逆（共轭）；约定与 mju_negQuat 一致（w-first）。"""
    out = np.zeros(4)
    mj.mju_negQuat(out, np.asarray(q, dtype=float))
    return out


def quat_matrix(q):
    """w-first 四元数 → 3x3 旋转矩阵（world←local 正向，列是 local 轴在 world 的表示）。"""
    rotation = np.zeros(9)
    mj.mju_quat2Mat(rotation, np.asarray(q, dtype=float))
    return rotation.reshape(3, 3)


def quat_rotate(q, vector):
    out = np.zeros(3)
    mj.mju_rotVecQuat(out, np.asarray(vector, dtype=float), np.asarray(q, dtype=float))
    return out


def look_rotation(direction):
    """让相机 -Z 对准 direction、+Y 尽量朝世界上方的世界旋转矩阵。

    相机轴约定与 Blender/USD/MuJoCo 一致：+X 右、+Y 上、-Z 前（Z-up 右手系）。
    direction 与世界上方（+Z）平行时退化，此时按 +Y 取上方向（与 MuJoCo 自身的
    相机 azymuth/elevation 在垂直俯视时的处理同类），不产生 NaN/任意翻转。
    """
    forward = -np.asarray(direction, dtype=float)  # 相机自身 +Z 轴
    forward = forward / np.linalg.norm(forward)
    up_hint = np.array([0.0, 0.0, 1.0])
    if abs(float(forward @ up_hint)) > 1 - 1e-9:
        up_hint = np.array([0.0, 1.0, 0.0])
    right = np.cross(up_hint, forward)
    right = right / np.linalg.norm(right)
    up = np.cross(forward, right)
    return np.column_stack([right, up, forward])
# 线性映射「可精确表示」判定的相对容差。输入四元数是单精度（Blender decompose 的 90° 分量
# qz=0.7071067690849304 → 换到 D 上的相对非对角项 ~3.4e-08），真剪切的相对量级 ≥1e-02
# （93 实测：父级 2× 各向异性 × 子体 35° 的角点偏差 0.265785 m）。1e-6 把两者分开。
COLLISION_FRAME_TOLERANCE = 1e-6


def rotation_matrix(quat):
    """wxyz 四元数 → 3x3 旋转矩阵（列向量约定：世界向量 = R·局部向量）。"""
    matrix = np.zeros(9)
    mj.mju_quat2Mat(matrix, np.asarray(quat, dtype=float))
    return matrix.reshape(3, 3)


def collision_frame_maps(scene, poses):
    """每个实体 **数据帧 → body 帧** 的完整线性映射 D = R(q)ᵀ·A（3x3）。

    Scene 的层级变换是 GLTF 式 TRS：局部矩阵 L = T(t)·R(r)·S(s)，世界矩阵是父链矩阵之积，
    线性部分按 `A = A_parent·R(r)·S(s)` 累积。body 帧正是实体自己的 (position, quaternion)
    位姿（world_poses 的 p、q），而 collision.center/halfExtents/shapes/parts 都声明在实体
    数据帧里，所以声明几何在世界里的像是

        T(p)·A·(声明几何) = T(p)·R(q)·[D·(声明几何)]，   D = R(q)ᵀ·A

    ——把 D 交给本实体的 geom 帧（pos/quat/网格顶点）才是精确消费：父层非均匀缩放与子层旋转的
    组合（R_eᵀ·S_p·R_e）带非对角项，逐轴相乘父子 scale 会把这份映射丢掉。

    A 的递归与 world_poses 同口径（同一份 transform 字段、同一个归一化），两者只差最后一步
    取不取 R(q)ᵀ：world_poses 的位置/朝向/累计 scale 是 Scene 合同的**位姿**读数（observe 对外
    仍按原口径），D 只供碰撞装配使用。
    """
    entities = {e['entityId']: e for e in scene['entities']}
    world_maps = {}
    active = set()

    def get(eid):
        if eid in world_maps:
            return world_maps[eid]
        if eid in active:
            raise SimError('INVALID_SCENE', '实体层级成环')
        active.add(eid)
        e = entities[eid]
        t = e['transform']
        q = np.array([t['quaternion'][3], *t['quaternion'][:3]], dtype=float)
        if not np.isfinite(q).all() or np.linalg.norm(q) < 1e-8:
            raise SimError('INVALID_SCENE', '变换含非法值')
        local = rotation_matrix(q / np.linalg.norm(q)) @ np.diag(np.asarray(t.get('scale', [1, 1, 1]), dtype=float))
        world = local if not e.get('parentId') else get(e['parentId']) @ local
        world_maps[eid] = world
        active.remove(eid)
        return world

    for eid in entities:
        get(eid)
    return {eid: rotation_matrix(poses[eid][1]).T @ world for eid, world in world_maps.items()}


def linear_frame_split(linear, eid, where):
    """D → (quat_wxyz | None, 逐轴缩放 v)，使 D = R(quat)·diag(v)；D 含真剪切时返回 None。

    - D 已是对角阵（相对容差内）→ `(None, 对角线)`：与旧口径（center⊙s、size⊙|s|、mesh.scale=s）
      **逐位一致**，符号留在 v 里（MuJoCo 的 mesh scale 接受负分量，顶点真的被反射）。
    - 列两两正交（相对容差内）→ `D = R(quat)·diag(v)`，v 取列范数，符号选成让 R(quat) 是**真旋转**：
      MuJoCo 的 quat 只能是旋转（det=+1），反射必须留在 v 里——把反射折进 quat 会把镜像几何
      变成"旋转过的原几何"（只在中心对称的网格上碰巧等价）。
    - 其余（真剪切）→ None：盒的像是斜平行六面体（8 角点凸网格可精确表示），球/柱/胶囊没有
      与 quat+正尺寸同形的精确表示，由各形状的调用方分别处理（见 box_geoms_in_frame）。
    """
    linear = np.asarray(linear, dtype=float)
    columns = [linear[:, index] for index in range(3)]
    norms = np.array([float(np.linalg.norm(column)) for column in columns])
    if not (norms > 0).all():
        raise SimError('INVALID_ARGUMENT', '实体 ' + eid + ' 的' + where + '累计缩放把几何压成退化面（线性映射的列范数为 0）')
    diagonal = np.diagonal(linear)
    if float(np.abs(linear - np.diag(diagonal)).max()) <= COLLISION_FRAME_TOLERANCE * float(norms.min()):
        return None, diagonal.copy()
    for i, j in ((0, 1), (0, 2), (1, 2)):
        if abs(float(columns[i] @ columns[j])) > COLLISION_FRAME_TOLERANCE * norms[i] * norms[j]:
            return None
    rotation = np.stack([columns[index] / norms[index] for index in range(3)], axis=1)
    axis_scale = norms.copy()
    if float(np.linalg.det(rotation)) < 0:
        rotation[:, 2] = -rotation[:, 2]
        axis_scale[2] = -axis_scale[2]
    quat = np.zeros(4)
    mj.mju_mat2Quat(quat, rotation.reshape(9))
    return quat, axis_scale


# 派生形状（球/柱/胶囊）规范三角化的采样密度：圆截面 64 段、球面 16 条纬带。两引擎同值——
# 同一 Scene 在 MuJoCo 与 Isaac 落出逐点相同的顶点集，跨引擎比对才有意义。
DERIVED_SHAPE_SEGMENTS = 64
DERIVED_SHAPE_LATITUDES = 16


def shape_refusal_text(shape):
    """没有精确/派生表达时的逐形状说明（sdf 的场只能按源文件烘；平面本轮不动单侧法向）。"""
    if shape == 'sdf':
        return '符号距离场只按源网格文件烘制，剪切没有精确表达（把源网格物理化/改用 mesh 碰撞件，或改层级让缩放与旋转在同一层）'
    if shape == 'plane':
        return ('平面在可逆映射下的像仍是平面，但要把法向与 size 重定向到帧上；本轮刻意不动平面的单侧法向'
                '（避免静默翻转地面的受力侧），所以在这里拒绝而不是给一个朝向错的平面')
    return str(shape) + ' 在当前帧下没有与 quat+正尺寸同形的精确表达'


def conformal_scale(linear):
    """D = c·R（各向同性，c>0）→ c；否则 None。球在各向同性映射下的像仍是球。"""
    singular = np.linalg.svd(np.asarray(linear, dtype=float), compute_uv=False)
    spread = float(singular.max() - singular.min())
    return float(np.mean(singular)) if spread <= COLLISION_FRAME_TOLERANCE * float(singular.max()) else None


def ellipsoid_frame(linear, radius):
    """球半径 r 的像椭球 → (主半轴 σ·r, 局部→世界旋转 U)。D = U·diag(σ)·Vᵀ ⇒ D·(r·球) = U·(σ·r 椭球)。

    球在任意可逆线性映射下的像都是椭球，MuJoCo 有原生 ellipsoid，所以这条**精确**（旧口径取
    |v_x| 当半径，非均匀帧下实测差 0.3 m）。det(U)<0 时翻第三列：椭球中心对称，翻一列不改变像，
    而 MuJoCo 的 quat 只能是真旋转。
    """
    u, singular, _ = np.linalg.svd(np.asarray(linear, dtype=float))
    if float(np.linalg.det(u)) < 0:
        u[:, 2] = -u[:, 2]
    return singular * radius, u


def revolve_mesh(levels, segments):
    """旋转面 [(z, 半径), …] 从顶到底 → (顶点, 面顶点数, 面顶点索引)，面绕向朝外（右手数据帧）。

    半径 0 的层是极点（单个顶点，接三角扇），其余层是 N 边环（层间接四边形带）。柱/胶囊/球的
    三角化都走这一条，顶点序在两引擎里逐点一致。
    """
    points, rings = [], []
    for z, radius in levels:
        if radius <= 0.0:
            rings.append(('pole', len(points)))
            points.append([0.0, 0.0, float(z)])
            continue
        base = len(points)
        for index in range(segments):
            angle = 2 * math.pi * index / segments
            points.append([radius * math.cos(angle), radius * math.sin(angle), float(z)])
        rings.append(('ring', base))
    counts, indices = [], []
    for index in range(len(rings) - 1):
        (kind_a, base_a), (kind_b, base_b) = rings[index], rings[index + 1]
        for j in range(segments):
            if kind_a == 'pole' and kind_b == 'ring':
                counts.append(3)
                indices.extend([base_a, base_b + j, base_b + (j + 1) % segments])
            elif kind_a == 'ring' and kind_b == 'pole':
                counts.append(3)
                indices.extend([base_b, base_a + (j + 1) % segments, base_a + j])
            else:
                counts.append(4)
                indices.extend([base_a + j, base_b + j, base_b + (j + 1) % segments, base_a + (j + 1) % segments])
    return points, counts, indices


def primitive_mesh_points(shape, radius, half):
    """数据帧里球/柱/胶囊的规范三角化 → (顶点, 面顶点数, 面顶点索引)，几何中心在原点。

    解析采样：柱 = 两端 N 边形盖 + 柱身；胶囊 = 柱身 + 两半球；球 = UV 球。拓扑与 D 无关，
    调用方按 D 映射顶点即可（镜像/剪切不改面表，绕向按 det(D) 单独翻）。
    """
    if shape == 'cylinder':
        levels = [(half, 0.0), (half, radius), (-half, radius), (-half, 0.0)]
    elif shape == 'capsule':
        bands = [(half + radius * math.cos(math.pi * i / (2 * DERIVED_SHAPE_LATITUDES)),
                  radius * math.sin(math.pi * i / (2 * DERIVED_SHAPE_LATITUDES)))
                 for i in range(1, DERIVED_SHAPE_LATITUDES + 1)]
        levels = [(half + radius, 0.0)] + bands + [(-z, r) for z, r in reversed(bands)] + [(-half - radius, 0.0)]
    else:
        levels = ([(radius, 0.0)]
                  + [(radius * math.cos(math.pi * i / DERIVED_SHAPE_LATITUDES),
                      radius * math.sin(math.pi * i / DERIVED_SHAPE_LATITUDES)) for i in range(1, DERIVED_SHAPE_LATITUDES)]
                  + [(-radius, 0.0)])
    return revolve_mesh(levels, DERIVED_SHAPE_SEGMENTS)


def derived_mesh_deviation(shape, radius, linear):
    """派生凸网格对真实曲面的最大表面偏差上界（m）= σ_max(D) × 数据帧矢高。

    数据帧里内接多边形的矢高是 r(1−cos(π/N))（柱的端盖扇面与柱身都是这一项），球面/胶囊的曲面
    部分取网格单元的半对角：球从极到极跨 π、胶囊每端半球跨 π/2，所以两者的纬度间隔不同
    （球 π/K、胶囊 π/(2K)——用同一个值会把球的界低报约 2.4 倍）。D 作用后距离最多放大 σ_max；
    凸包与"点时凸组合"可交换，所以这是覆盖整个曲面的界，不是采样点的界。
    """
    circle = 1.0 - math.cos(math.pi / DERIVED_SHAPE_SEGMENTS)
    if shape == 'cylinder':
        factor = circle
    else:
        latitude = math.pi / DERIVED_SHAPE_LATITUDES if shape == 'sphere' else math.pi / (2 * DERIVED_SHAPE_LATITUDES)
        factor = max(circle, 1.0 - math.cos(0.5 * math.hypot(latitude, 2 * math.pi / DERIVED_SHAPE_SEGMENTS)))
    return float(np.linalg.svd(np.asarray(linear, dtype=float), compute_uv=False).max() * radius * factor)


def primitive_geoms_in_frame(spec, body, name, mesh_name, shape, size, center, linear, mass, friction, eid):
    """数据帧里的球/柱/胶囊 (center, size) 按完整线性映射 D 落到 body 帧 → (geoms, 表示法说明 | None)。

    - 位置一律 D·center（镜像实体的偏心几何落在镜像一侧）。
    - 精确的原生表达优先：各向同性下的球 → sphere；球的像 → ellipsoid（主半轴 σ·r、朝向左奇异向量）；
      柱在圆截面没被拉成椭圆且轴向仍与该平面正交时 → 原生 cylinder（**轴向可以独立缩放**：拉长的圆柱仍是圆柱）；
      胶囊要再加一条"轴向缩放 = 环向缩放"，因为它的端部是球、尺寸里只有柱段半长。
    - 装不进原生形状的（柱/胶囊圆截面被拉成椭圆或轴向不正交）改用规范三角化按 D 映射的凸网格
      （内接多面体），最大表面偏差随 handle.warnings 明示——受控近似。
    """
    linear = np.asarray(linear, dtype=float)
    radius = float(size[0])
    half = float(size[1]) if len(size) > 1 else 0.0
    singular = np.linalg.svd(linear, compute_uv=False)
    if float(singular.min()) <= COLLISION_FRAME_TOLERANCE * float(singular.max()):
        raise SimError('INVALID_ARGUMENT', '实体 ' + eid + ' 的 ' + shape + ' 碰撞：累计线性映射把几何压成退化面（奇异值 '
                       + str([float(v) for v in singular]) + '），三维碰撞形状表达不了')
    position = linear @ center
    if shape == 'sphere':
        scale = conformal_scale(linear)
        if scale is not None:
            return [body.add_geom(name=name, type=mj.mjtGeom.mjGEOM_SPHERE, size=[scale * radius, 0.0, 0.0], mass=mass, friction=friction, pos=position)], None
        semiaxes, rotation = ellipsoid_frame(linear, radius)
        quat = np.zeros(4)
        mj.mju_mat2Quat(quat, rotation.reshape(9))
        geom = body.add_geom(name=name, type=mj.mjtGeom.mjGEOM_ELLIPSOID, size=[float(v) for v in semiaxes], mass=mass, friction=friction, pos=position)
        geom.quat = quat
        return [geom], {'code': 'COLLISION_SHAPE_ELLIPSOID', 'entityId': eid, 'maxSurfaceDeviationM': 0.0,
                        'message': '实体 ' + eid + ' 的球在非各向同性帧下的像椭球已按原生 ellipsoid 精确表达：'
                                   '主半轴 ' + str([round(float(v), 9) for v in semiaxes]) + ' m（不是把 |v_x| 当半径）'}
    column_x, column_y, column_z = (linear[:, index] for index in range(3))
    norm_x, norm_y, norm_z = (float(np.linalg.norm(column)) for column in (column_x, column_y, column_z))
    circular = (abs(norm_x - norm_y) <= COLLISION_FRAME_TOLERANCE * min(norm_x, norm_y)
                and abs(float(column_x @ column_y)) <= COLLISION_FRAME_TOLERANCE * norm_x * norm_y)
    orthogonal = (abs(float(column_x @ column_z)) <= COLLISION_FRAME_TOLERANCE * norm_x * norm_z
                  and abs(float(column_y @ column_z)) <= COLLISION_FRAME_TOLERANCE * norm_y * norm_z)
    # 圆截面之外，胶囊还要看**轴向缩放是否等于环向缩放**：MuJoCo 的 capsule size=[r, h] 里 h 是柱段半长、
    # 两端恒按半径 r 生成半球，所以轴向单独放大（norm_z ≠ norm_x）时端部半球变成椭球，原生形状表达不了；
    # 圆柱没有端部曲面，轴向缩放可独立（size[1]=half·norm_z 精确），这条约束不适用于它。
    capsule_axis_exact = (shape != 'capsule'
                          or abs(norm_z - norm_x) <= COLLISION_FRAME_TOLERANCE * min(norm_z, norm_x))
    if circular and orthogonal and capsule_axis_exact:
        frame = np.stack([column_x / norm_x, column_y / norm_y, column_z / norm_z], axis=1)
        if float(np.linalg.det(frame)) < 0:
            frame[:, 2] = -frame[:, 2]      # 柱/胶囊对 z→−z 对称，翻轴不改变几何
        quat = np.zeros(4)
        mj.mju_mat2Quat(quat, frame.reshape(9))
        kind = mj.mjtGeom.mjGEOM_CYLINDER if shape == 'cylinder' else mj.mjtGeom.mjGEOM_CAPSULE
        geom = body.add_geom(name=name, type=kind, size=[radius * norm_x, half * norm_z, 0.0], mass=mass, friction=friction, pos=position)
        geom.quat = quat
        return [geom], None
    if not (circular and orthogonal):
        why = '圆截面被拉成椭圆或轴向与截面不再正交'
    else:
        why = ('轴向缩放 %.9g 与环向 %.9g 不同，端部半球被拉成椭球（原生 capsule 的 size[1] 只是柱段半长、'
               '端部恒按半径生成，装不下轴向单独放大的像）' % (norm_z, norm_x))
    points, _, _ = primitive_mesh_points(shape, radius, half)
    mesh = spec.add_mesh(name=mesh_name)
    mesh.uservert = [float(value) for point in (linear @ np.asarray(points, dtype=float).T).T for value in point]
    geom = body.add_geom(name=name, type=mj.mjtGeom.mjGEOM_MESH, meshname=mesh_name, mass=mass, friction=friction, pos=position)
    deviation = derived_mesh_deviation(shape, radius, linear)
    return [geom], {'code': 'COLLISION_SHAPE_DERIVED_MESH', 'entityId': eid, 'maxSurfaceDeviationM': deviation,
                    'message': '实体 ' + eid + ' 的 ' + shape + ' 在当前帧下' + why + '，原生形状装不下它：'
                               '已用 ' + str(DERIVED_SHAPE_SEGMENTS) + ' 段规范凸网格表达，最大表面偏差 ≤ '
                               + ('%.3e' % deviation) + ' m'}


def box_geoms_in_frame(spec, body, name, mesh_name, center, half, linear, mass, friction, eid):
    """数据帧里的一个盒 (center, halfExtents) 按完整线性映射 D 落到 body 帧。

    可精确表示的位形（D=R·diag(v)）保持**原生 box**：中心 D·c（保号：镜像实体的偏心盒落在
    镜像一侧）、朝向 R（父层非均匀缩放 × 子体 90° 换轴在这里精确）、半长 |v|⊙h。真剪切时盒的像
    是**斜平行六面体**，任何"旋转+正尺寸"的盒子都装不下它，放大成轴对齐盒还会封死门洞这类通道：
    改用 8 个角点的凸网格——平行六面体是凸的，MuJoCo 对 mesh geom 按凸包碰撞，这是最小精确表示。
    """
    split = linear_frame_split(linear, eid, '碰撞盒的')
    if split is not None:
        quat, axis_scale = split
        geom = body.add_geom(name=name, type=mj.mjtGeom.mjGEOM_BOX, pos=linear @ center, size=np.abs(axis_scale) * half, mass=mass, friction=friction)
        if quat is not None:
            geom.quat = quat
        return [geom]
    corners = [linear @ (center + half * np.array([sx, sy, sz])) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    mesh = spec.add_mesh(name=mesh_name)
    mesh.uservert = [float(value) for corner in corners for value in corner]
    return [body.add_geom(name=name, type=mj.mjtGeom.mjGEOM_MESH, meshname=mesh_name, mass=mass, friction=friction)]


def mesh_vertex_lines(path):
    """asset-bake 碰撞件（.obj）的顶点：只取 `v` 行（vn/vt/o/g/usemtl 等一律跳过）。

    只用于把剪切映射**烘进顶点**（D 作用在凸包顶点上与作用在几何上等价）：网格碰撞按凸包，
    顶点集就够，多余的行不参与，也不重算法线/不做平滑。读不出顶点就明确报错，不退化成空网格。
    """
    points = []
    with open(path, 'r', errors='replace') as handle:
        for line in handle:
            fields = line.split()
            if not fields or fields[0] != 'v':
                continue
            if len(fields) < 4:
                raise SimError('COLLISION_MESH_INVALID', '顶点行不完整: ' + path + ': ' + line.strip())
            try:
                point = [float(value) for value in fields[1:4]]
            except ValueError:
                raise SimError('COLLISION_MESH_INVALID', '顶点不是数值: ' + path + ': ' + line.strip())
            if not all(math.isfinite(value) for value in point):
                raise SimError('COLLISION_MESH_INVALID', '顶点不是有限数值: ' + path + ': ' + line.strip())
            points.append(point)
    if not points:
        raise SimError('COLLISION_MESH_INVALID', '碰撞网格没有顶点: ' + path)
    return np.asarray(points, dtype=float)


def world_poses(scene, actual=None):
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
        if actual and eid in actual:
            result[eid] = actual[eid]
            active.remove(eid)
            return result[eid]
        t = e['transform']
        p = np.array(t['position'], dtype=float)
        q = np.array([t['quaternion'][3], *t['quaternion'][:3]], dtype=float)
        if not np.isfinite(p).all() or not np.isfinite(q).all() or np.linalg.norm(q) < 1e-8:
            raise SimError('INVALID_SCENE', '变换含非法值')
        q /= np.linalg.norm(q)
        scale = np.array(t.get('scale', [1, 1, 1]), dtype=float)
        if e.get('parentId'):
            pp, pq, ps = get(e['parentId'])
            rotated = np.zeros(3)
            mj.mju_rotVecQuat(rotated, p * ps, pq)
            p, q, scale = pp + rotated, quat_mul(pq, q), scale * ps
        result[eid] = (p, q, scale)
        active.remove(eid)
        return result[eid]
    for eid in entities:
        get(eid)
    return result


def physics_signature(scene, collision_patches=None):
    # 标签、颜色和纯显示偏好不影响编译/动作代次。
    entries = []
    for e in scene['entities']:
        c = e.get('components', {})
        p = {k: v for k, v in c.items() if k != 'visual'}
        entries.append([e['entityId'], e.get('parentId'), e['transform'], e.get('resources', []), p])
    # 场景碰撞补丁在 scene 之外经 sync 参数传入，但同样决定编译产物：
    # 并入签名，补丁内容一变即触发重编译，与场景实体变更同口径。
    return json.dumps([scene.get('physics'),entries, collision_patches], sort_keys=True, separators=(',', ':'))


def check_collision_patches(patches, skipped):
    """校验场景碰撞补丁的整体可用性；不可用时登记结构化告警并返回 None（按无补丁装配）。

    frame 不是 mujoco-z-up-meters 时按 UNSUPPORTED_CAPABILITY 抛出：坐标系不符还继续装配
    必然整体错位，不能静默。hfield 网格声明（nrow/ncol/elevation）残缺属于数据问题：跳过
    整个补丁（含 suppressDefaultGround，默认地面随之保留）、登记 SCENE_COLLISION_PATCH_INVALID，
    世界照常编译可用——坏补丁绝不能打瘫既有世界（sync 先把新场景编译到临时变量）。
    """
    if patches is None:
        return None
    if not isinstance(patches, dict):
        raise SimError('INVALID_ARGUMENT', 'collisionPatches 必须是对象或 null')
    frame = patches.get('frame')
    if frame != 'mujoco-z-up-meters':
        raise SimError('UNSUPPORTED_CAPABILITY', '场景碰撞补丁坐标系不受支持: ' + str(frame) + '（仅支持 mujoco-z-up-meters）')
    ground = patches.get('ground')
    if isinstance(ground, dict) and ground.get('kind') == 'hfield':
        nrow, ncol = ground.get('nrow'), ground.get('ncol')
        elevation = ground.get('elevation')
        grid_ok = (isinstance(nrow, int) and not isinstance(nrow, bool) and nrow >= 2
                   and isinstance(ncol, int) and not isinstance(ncol, bool) and ncol >= 2)
        expected = nrow * ncol if grid_ok else -1
        origin = ground.get('origin')
        origin_ok = isinstance(origin, (list, tuple)) and len(origin) == 3
        if not isinstance(elevation, list) or len(elevation) != expected or not origin_ok:
            skipped.append({'code': 'SCENE_COLLISION_PATCH_INVALID',
                            'message': '场景碰撞补丁已整体跳过: hfield 声明残缺（elevation 长度 '
                                       + (str(len(elevation)) if isinstance(elevation, list) else '缺失')
                                       + ' 对 nrow×ncol=' + str(expected) + '；origin ' + ('齐备' if origin_ok else '缺失') + '）'})
            return None
    return patches


def apply_collision_patches(spec, patches, skipped):
    """把场景碰撞补丁装配成 worldbody 静态 geom，返回待写入的 hfield 高程（无则 None）。

    补丁坐标即场景世界系（Z-up，米），geom 直接放置、不做任何坐标换算。全部 geom
    group=3、rgba 全透明：splat 仍是唯一环境视觉，补丁 geom 只参与碰撞。
    hfield 合同（与 TS 侧 heightfield provider 一致）：elevation 已按 [0,1] 归一化，
    碰撞面 = origin[2] + elevation×size[2]；origin=[中心x, 中心y, 最低高程z]，size 为
    [x半径, y半径, 高差, base]。MuJoCo 3.3.7 实测（/tmp 探针）：size 四项必须严格为正
    才能编译，hfield_data 越出 [0,1] 会被钳制甚至失去碰撞，故写入前再钳一次；
    归一化高程在 spec.compile() 之后写进 model.hfield_data（spec 阶段放占位数据使编译通过）。
    """
    pending_hfield = None
    ground = patches.get('ground')
    if isinstance(ground, dict):
        kind = ground.get('kind')
        if kind == 'hfield':
            nrow, ncol = int(ground['nrow']), int(ground['ncol'])
            name = ground.get('name') or 'scene_ground'
            if not isinstance(name, str):
                raise SimError('INVALID_ARGUMENT', 'collisionPatches.ground.name 必须是字符串')
            size = ground.get('size')
            if not isinstance(size, (list, tuple)) or len(size) != 4:
                raise SimError('INVALID_ARGUMENT', 'collisionPatches.ground.size 必须是 4 个数值的数组 [xRadius, yRadius, zScale, base]')
            x_radius = positive(size[0], 'collisionPatches.ground.size[0]')
            y_radius = positive(size[1], 'collisionPatches.ground.size[1]')
            z_range = positive(size[2], 'collisionPatches.ground.size[2]')
            base_given = finite(size[3], 'collisionPatches.ground.size[3]')
            origin = vec3(ground.get('origin'), 'collisionPatches.ground.origin')
            # elevation 已是 [0,1] 归一化数据（TS 侧按高差归一）；钳制保底，防越界失去碰撞。
            elevation = np.clip(np.array([finite(v, 'collisionPatches.ground.elevation') for v in ground['elevation']]), 0.0, 1.0)
            hfield = spec.add_hfield(name=name, nrow=nrow, ncol=ncol)
            hfield.size = [x_radius, y_radius, z_range, base_given if base_given > 1e-9 else 1e-6]
            hfield.userdata = np.zeros(nrow * ncol)
            spec.worldbody.add_geom(name=name, type=mj.mjtGeom.mjGEOM_HFIELD, hfieldname=name,
                                    pos=[origin[0], origin[1], origin[2]], group=3, rgba=[0, 0, 0, 0])
            pending_hfield = (name, elevation)
        elif kind == 'boxes':
            boxes = ground.get('boxes')
            if not isinstance(boxes, list):
                raise SimError('INVALID_ARGUMENT', 'collisionPatches.ground.boxes 必须是数组')
            # 空数组合法（TS 侧没有产出地面时的显式退化）：不装地面 geom，
            # suppressDefaultGround 与其余补丁内容（墙体/承接网）仍然生效。
            for i, entry in enumerate(boxes):
                center = vec3(entry.get('center') if isinstance(entry, dict) else None, 'collisionPatches.ground.boxes[' + str(i) + '].center')
                half = vec3(entry.get('halfExtents') if isinstance(entry, dict) else None, 'collisionPatches.ground.boxes[' + str(i) + '].halfExtents')
                if (half <= 0).any():
                    raise SimError('INVALID_ARGUMENT', 'collisionPatches.ground.boxes[' + str(i) + '].halfExtents 必须大于零')
                spec.worldbody.add_geom(name='scene_collision_ground_' + str(i), type=mj.mjtGeom.mjGEOM_BOX, pos=center, size=half, group=3, rgba=[0, 0, 0, 0])
        else:
            raise SimError('INVALID_ARGUMENT', '未知场景碰撞地面类型: ' + str(kind))
    elif ground is not None:
        raise SimError('INVALID_ARGUMENT', 'collisionPatches.ground 必须是对象')
    for i, wall in enumerate(patches.get('walls') or []):
        center = vec3(wall.get('center') if isinstance(wall, dict) else None, 'collisionPatches.walls[' + str(i) + '].center')
        half = vec3(wall.get('halfExtents') if isinstance(wall, dict) else None, 'collisionPatches.walls[' + str(i) + '].halfExtents')
        if (half <= 0).any():
            raise SimError('INVALID_ARGUMENT', 'collisionPatches.walls[' + str(i) + '].halfExtents 必须大于零')
        # 可选朝向 quat(wxyz)：缺省为轴对齐盒；非法四元数属于数据问题，抛 INVALID_ARGUMENT。
        quat = wall.get('quat') if isinstance(wall, dict) else None
        geom_kwargs = {}
        if quat is not None:
            if not isinstance(quat, (list, tuple)) or len(quat) != 4:
                raise SimError('INVALID_ARGUMENT', 'collisionPatches.walls[' + str(i) + '].quat 必须是 4 个数值的数组 [w,x,y,z]')
            quat = np.array([finite(v, 'collisionPatches.walls[' + str(i) + '].quat') for v in quat])
            norm = float(np.linalg.norm(quat))
            if norm < 1e-9:
                raise SimError('INVALID_ARGUMENT', 'collisionPatches.walls[' + str(i) + '].quat 不能是零向量')
            geom_kwargs['quat'] = quat / norm
        spec.worldbody.add_geom(name='scene_collision_wall_' + str(i), type=mj.mjtGeom.mjGEOM_BOX, pos=center, size=half, group=3, rgba=[0, 0, 0, 0], **geom_kwargs)
    catch_net_z = patches.get('catchNetZ')
    if catch_net_z is not None:
        z = finite(catch_net_z, 'collisionPatches.catchNetZ')
        spec.worldbody.add_geom(name='scene_catch_net', type=mj.mjtGeom.mjGEOM_PLANE, pos=[0, 0, z], size=[20, 20, .05], group=3, rgba=[0, 0, 0, 0])
    source = patches.get('sourceKey')
    for message in patches.get('warnings') or []:
        skipped.append({'code': 'SCENE_COLLISION_PATCH_WARNING',
                        'message': ('场景碰撞补丁 ' + str(source) + ' 告警: ' if source else '场景碰撞补丁告警: ') + str(message)})
    return pending_hfield


def native_source(entity):
    cfg = entity.get('components', {}).get('mujoco', {})
    if cfg.get('sourcePath') or cfg.get('xml'):
        return cfg
    for r in entity.get('resources', []):
        for rep in [*r.get('representations', []), r.get('original', {})]:
            uri = rep.get('uri', '')
            if rep.get('mimeType') in ['application/x-mjcf+xml', 'application/mjcf+xml', 'application/x-urdf+xml', 'application/urdf+xml'] or uri.endswith(('.xml', '.urdf')):
                return {**cfg, 'sourcePath': path_from_uri(uri)}
    return None


def urdf_source_path(cfg):
    """实体原生来源是 URDF 时给出它的本地路径；MJCF/内联 XML/无来源一律 None。

    只认扩展名（与 spec_from_path 的解码表同一判据），不做内容嗅探：
    URDF 与 MJCF 共用 .xml 扩展名时按 MJCF 处理，与既有行为一致。
    """
    source = (cfg or {}).get('sourcePath')
    if not source:
        return None
    path = path_from_uri(source)
    return path if str(path).lower().endswith('.urdf') else None


def urdf_joint_unbounded_notes(urdf_path):
    """URDF 源码层的如实告知：revolute/prismatic 缺 <limit> ⇒ 导入后该关节无界。

    判定必须在**源码 XML** 上按关节 type 做：编译后的模型里 `revolute 缺 limit` 与
    `continuous` 完全一样（都是 jnt_limited=False、jnt_range=[0,0]），只看编译结果会把
    合法的 continuous 误报。URDF 规范里 <limit> 对 revolute/prismatic 是必填、对 continuous
    不适用，因此只有前者告警。
    """
    notes = []
    try:
        root = ElementTree.parse(str(urdf_path)).getroot()
    except (OSError, ElementTree.ParseError) as error:
        return [{'code': 'URDF_SOURCE_UNREADABLE',
                 'message': 'URDF 原件无法解析，未能核对关节 <limit>：' + str(error)}]
    for joint in root.iter('joint'):
        kind = (joint.get('type') or '').strip().lower()
        if kind in ('revolute', 'prismatic') and joint.find('limit') is None:
            notes.append({'code': 'URDF_JOINT_UNBOUNDED',
                          'message': 'URDF 关节 ' + str(joint.get('name')) + '（type=' + kind + '）缺 <limit>：'
                                     'URDF 规范对 ' + kind + ' 要求 <limit>，导入后该关节无界（range 不输出、'
                                     '位置目标不做范围校验）。补上 lower/upper/effort/velocity 后再导入。'})
    return notes


class World:
    def __init__(self, scene, options, collision_patches=None):
        validate_exact_triangle_surfaces(scene,SimError)
        self.id = options.get('worldId') or str(uuid.uuid4())
        self.options = options
        self.clock = options.get('clock', 'realtime')
        if self.clock not in ('realtime', 'manual'):
            raise SimError('INVALID_ARGUMENT', 'clock 必须为 realtime 或 manual')
        self.generation = 1
        self.applied_revision = -1
        self.step_index = 0
        self.scene = None
        self.model = None
        self.data = None
        self.entities = {}
        self.assisted = {}
        # 本 world 生命周期内真实辅助写回的累计次数：在 tick 的写回点递增，随 observe 帧如实带出。
        self.assist_advances = 0
        self.active = {}
        self.receipts = {}
        self.requests = {}
        self.control_owners = {}
        # 已命名相机的临时 override（渲染期生效、close/sync 清除）与真实 capture 记录
        # （captureId → 回执/逐相机标定/标注），供 camera_project_annotation 与数据集导出溯源。
        self.camera_overrides = {}
        self.captures = {}
        # 接触标签里的地面名（worker 自带 __ground + 源声明的地面 geom，附加后带实体前缀）。
        # 由 compile 每次重建时重填，随 handle 暴露，供接触过滤直接匹配而不猜前缀。
        self.ground_names = set()
        self.collision_patch_owners = {}
        # Scene 声明相机（components.camera / components.viewerCamera）的装配记录：
        # 成品相机名 → 实体绑定/声明光学参数。
        # 由 compile 每次重建时重填；camera_list 用它如实标注相机的来源与实体绑定。
        self.scene_cameras = {}
        # 最近一次成功编译的结构化告警（如纯视觉实体被跳过），由 sync 在编译成功后原子替换，
        # 随 handle 暴露；编译失败保留旧值，与保留的旧世界保持一致。
        self.warnings = []
        self.status = 'unavailable'
        self.paused = options.get('startPaused', False)
        if not isinstance(self.paused, bool):
            raise SimError('INVALID_ARGUMENT', 'startPaused 必须为 boolean')
        self.last_frame = 0.0
        self.factor = positive(options.get('realtimeFactor', 1), 'realtimeFactor')
        self.frame_hz = positive(options.get('frameRateHz', 30), 'frameRateHz')
        self.next_tick = time.monotonic()
        self.sync(scene, initial=True, collision_patches=collision_patches)

    def handle(self):
        return {'worldId': self.id, 'sceneId': self.scene['sceneId'], 'engineId': 'mujoco', 'engineVersion': mj.__version__, 'worldGeneration': self.generation, 'appliedSceneRevision': self.applied_revision, 'status': self.run_status(), 'clock': self.clock, 'timestepS': float(self.model.opt.timestep) if self.model is not None else self.options.get('timestepS', .002),
                **({'worldPhysics':self.world_physics()}if self.model is not None else{}),'supportsPause':True,
                # 接触标签口径的地面名（与 observe 的 contacts[].geom1/geom2 同名）：自带平面 __ground
                # + 源声明地面 geom 的 <实体前缀><geom名>（附加后才是 h1/floor 这种名字）。调用方按此
                # 精确匹配，不再靠实体前缀猜测。
                'groundGeomNames': sorted(self.ground_names),
                # 最近一次成功编译的告警列表（[{code, entityId, message}]，无告警为空数组）；
                # 典型项是纯视觉实体没有碰撞体被物理装配跳过，调用方据此补碰撞组件而不是无从察觉。
                'warnings': [dict(w) for w in self.warnings]}

    def require_ready(self):
        if self.status not in ('ready', 'running') or self.model is None:
            raise SimError('WORLD_UNAVAILABLE', '世界未同步或已关闭: ' + self.status)

    def run_status(self):
        if self.status not in ('ready','running'):return self.status
        if self.paused:return 'paused'
        return 'running'if self.active or self.clock=='realtime'and self.step_index>0 else'ready'

    def set_paused(self,paused,generation):
        self.require_ready()
        if not isinstance(paused,bool):raise SimError('INVALID_ARGUMENT','paused必须是boolean')
        if generation!=self.generation:raise SimError('STALE_GENERATION','暂停目标世界代次已变化')
        self.paused=paused;self.next_tick=time.monotonic()
        return self.handle()

    def world_physics(self):
        # collider布局只随Scene/编译代次变化；按版本复用真实编译结果，避免大件每帧再扫全部geom×实体。
        key=(id(self.model),self.applied_revision)
        if getattr(self,'_physics_layout_key',None)!=key:
            physical=set();names={};planes=[];legacy=False
            for gid in range(self.model.ngeom):
                if not (self.model.geom_contype[gid]or self.model.geom_conaffinity[gid]):continue
                name=self.model.geom(gid).name;eid=self.entity_of_geom(name)
                if eid is not None:physical.add(eid);names.setdefault(eid,[]).append(name)
                if name in self.native_ground_names:planes.append((eid,name))
                if name=='__ground':legacy=True
            ground=[{'source':'scene','entityId':eid,'geomNames':names[eid]}for eid in declared_ground_ids(self.scene)if eid in names]
            ground.extend({'source':'native-plane','entityId':eid,'geomNames':[name]}for eid,name in planes)
            if legacy:ground.append({'source':'explicit-legacy','geomNames':['__ground']})
            self._physics_layout=(physical,ground);self._physics_layout_key=key
        physical,ground=self._physics_layout
        return {'gravityWorldMps2':self.model.opt.gravity.tolist(),'gravityEnabled':not bool(self.model.opt.disableflags&int(mj.mjtDisableBit.mjDSBL_GRAVITY)),'units':'m/s^2','source':'mujoco-model','groundSources':ground,'collisionCoverage':coverage(self.scene,physical,getattr(self,'replaced_template_ground',[]))}

    def compile(self, scene, collision_patches=None):
        validate_exact_triangle_surfaces(scene,SimError)
        spec = mj.MjSpec()
        # 地面名与跳过告警先收集在局部变量：编译中途失败时运行中的世界状态不被半成品污染，
        # 由 sync 在编译成功后随 model/data 一起原子替换进 self。
        ground_names = set()
        skipped = []
        # 场景碰撞补丁（可选）：frame 校验不过在此直接抛出；数据残缺的补丁被整体跳过并
        # 登记告警（patches=None），下面的默认地面随之保留，坏补丁不影响世界可用性。
        patches = check_collision_patches(collision_patches, skipped)
        spec.modelname = 'lyapunov-world-' + self.id
        spec.option.timestep = positive(self.options.get('timestepS', .002), 'timestepS')
        spec.option.gravity = scene_gravity(scene,SimError)
        spec.option.integrator = mj.mjtIntegrator.mjINT_IMPLICITFAST
        replaced_template_ground=[];native_ground_names=set()
        # 补丁 geom 与实体装配互不依赖，先装好；归一化高程待 model 编译出来后写入（见下）。
        pending_hfield = apply_collision_patches(spec, patches, skipped) if patches is not None else None
        poses = world_poses(scene)
        # 碰撞几何按完整线性映射消费（数据帧 → body 帧），与位姿口径分开：位姿读数仍是 Scene
        # 合同的 TRS 口径，碰撞装配用 D 才能把父层非均匀缩放与子层旋转的组合表达出来。
        frames = collision_frame_maps(scene, poses)
        maps = {}
        child_specs = []
        static_triangle_counts, explicit_arena_sources = [], []
        # 实体的真实装配 body（eid → (spec body, 该 body 在实体局部帧中的 pos/quat)），
        # 供 Scene 声明相机挂载：相机进的是父实体的真实 body，随物理 FK 一起动。
        spec_bodies = {}
        for e in scene['entities']:
            eid = e['entityId']
            p, q, scale = poses[eid]
            cfg = native_source(e)
            prefix = eid + '/'
            component = e.get('components', {})
            if cfg:
                if not np.allclose(scale, [1, 1, 1]):
                    raise SimError('UNSUPPORTED_CAPABILITY', '原生 articulation 缩放须先由资产适配器物理化: ' + eid)
                if cfg.get('sourcePath'):
                    child = spec_from_path(cfg['sourcePath'])
                else:
                    assets = {name: Path(path_from_uri(path)).read_bytes() for name, path in cfg.get('assets', {}).items()}
                    child = mj.MjSpec.from_string(cfg['xml'], assets=assets)
                explicit_arena_sources.append((eid, child.memory, child.nstack, child.njmax, child.nconmax))
                native_camera_sources, native_camera_refusals = {}, []
                camera_urdf_path = urdf_source_path(cfg)
                if camera_urdf_path:
                    from urdf_cameras import install_urdf_cameras
                    native_camera_sources, native_camera_refusals = install_urdf_cameras(child, camera_urdf_path, self.scene_camera_optics)
                    skipped.extend({'entityId': eid, **refusal, 'cameraName': prefix + refusal['cameraName']} for refusal in native_camera_refusals)
                # URDF converters are allowed to leave collision geoms unnamed.
                # Give only those geoms a stable local name before attaching the
                # child.  The entity prefix is added by MjSpec.attach, so contact
                # observations remain attributable without changing the source
                # URDF/MJCF or inventing model-specific mappings.
                for geom_index, geom in enumerate(child.geoms):
                    if not geom.name:
                        geom.name = f'__geom_{geom_index}'
                # 原生 MJCF 允许匿名 freejoint。附加实体前命名，才能将实测
                # 自由基座姿态/角速度归回实例，而不是丢失策略观测。
                for joint_index, joint in enumerate(child.joints):
                    if not joint.name:
                        joint.name = f'__joint_{joint_index}'
                if child.option.cone == mj.mjtCone.mjCONE_ELLIPTIC:
                    spec.option.cone = mj.mjtCone.mjCONE_ELLIPTIC
                spec.option.impratio = max(spec.option.impratio, child.option.impratio)
                from policy_drive import apply_policy_drive
                apply_policy_drive(child, component.get('controller', {}))
                initial_model = child.compile()
                # world及焊接到world的静态子body都允许plane；用原生weld事实和FK，不以局部pos冒世界位姿。
                ground_data=mj.MjData(initial_model);mj.mj_forward(initial_model,ground_data)
                for gid in range(initial_model.ngeom):
                    if initial_model.geom_type[gid]!=mj.mjtGeom.mjGEOM_PLANE or initial_model.body_weldid[initial_model.geom_bodyid[gid]]!=0 or not(initial_model.geom_contype[gid]or initial_model.geom_conaffinity[gid]):continue
                    point=p+quat_rotate(q,ground_data.geom_xpos[gid]);normal=quat_rotate(q,ground_data.geom_xmat[gid].reshape((3,3))[:,2])
                    if standard_support_plane(point,normal):native_ground_names.add(prefix+initial_model.geom(gid).name)
                from robot_authoring import source_base, configure_source_base
                source_base_state = source_base(initial_model, cfg.get('rootBody'))
                key_name = cfg.get('keyframe', 'home')
                key_id = mj.mj_name2id(initial_model, mj.mjtObj.mjOBJ_KEY, key_name)
                initial_q = initial_model.key_qpos[key_id] if key_id >= 0 else initial_model.qpos0
                initial_ctrl = initial_model.key_ctrl[key_id].copy() if key_id >= 0 else np.zeros(initial_model.nu)
                initial_joints = {initial_model.joint(i).name: float(initial_q[initial_model.jnt_qposadr[i]]) for i in range(initial_model.njnt) if int(initial_model.jnt_type[i]) in SCALAR_JOINT_TYPES}
                initial_joints.update(cfg.get('initialJointPositions', {}))
                initial_actuators = {initial_model.actuator(i).name: float(initial_ctrl[i]) for i in range(initial_model.nu)}
                initial_actuators.update(cfg.get('initialActuatorControls', {}))
                # URDF 来源的两个如实告知（裁决 (B)：不合成驱动，只告警；MJCF 路径逐字不变）：
                #  · URDF 不声明驱动 ⇒ 编译后 nu==0 的实体结构上不可被 joint_move 驱动；
                #  · 源码层 revolute/prismatic 缺 <limit> 的关节导入后无界（continuous 无 limit 属规范内，不告警）。
                urdf_path = urdf_source_path(cfg)
                if urdf_path:
                    movable = sum(1 for i in range(initial_model.njnt) if int(initial_model.jnt_type[i]) in SCALAR_JOINT_TYPES)
                    if initial_model.nu == 0 and movable:
                        skipped.append({'code': 'URDF_NO_ACTUATORS', 'entityId': eid,
                                        'message': '实体 ' + eid + ' 的来源是 URDF：URDF 不声明驱动，导入后有 ' + str(movable) +
                                                   ' 个可动关节、0 个执行器，因此该实体结构上不可被 joint_move 驱动'
                                                   '（不会自动合成驱动）。两条出路：改用带 <actuator> 的 MJCF，'
                                                   '或在实体上声明 components.controller（夹爪/关节控制）后重试。'})
                    skipped.extend(dict(note, entityId=eid) for note in urdf_joint_unbounded_notes(urdf_path))
                configure_source_base(child, source_base_state, component.get('baseBinding'), SimError)
                del initial_model
                # 保留原件的关节、执行器、接触、传感器和各高级命名空间。
                # 片段里一个 body 都没有时（geom/相机直接挂 <worldbody>，合法原生写法：静态台面、墙、
                # 地面标记），attach 到 worldbody 级 frame 只会把实体位姿烘进 geom/相机、实体本身没有
                # 承载位姿的 body：observe 会把它报成原点，Scene 相机也没有可依附的父体。这里沿同一套
                # frame/body 装配**形成**一个安装根（与下面 collision 分支的 prefix+'body' 同构），片段挂到
                # 它的 frame——原始 MJCF 一字不动，worldbody 级 geom/相机精确落在"实体位姿 ∘ 片段局部坐标"，
                # 且仍然静态（片段里没有关节，MJCF 的世界系 geom 本来就不动）。
                segment_bodies = [body for body in child.bodies if body != child.worldbody]
                mount = spec.worldbody.add_body(name=prefix + 'root', pos=p, quat=q) if not cfg.get('rootBody') and not segment_bodies else None
                frame = spec.worldbody.add_frame(pos=p, quat=q) if mount is None else mount.add_frame()
                child_specs.append(child)
                spec.attach(child, prefix=prefix, frame=frame)
                root = spec.body(prefix + cfg['rootBody']) if cfg.get('rootBody') else None
                if root is None:
                    root = mount if mount is not None else next((body for body in spec.bodies if body.name.startswith(prefix)), None)
                if root is not None:
                    # root.pos/quat 是相对实体 frame 的局部安装位姿（attach 后仍原样保留），
                    # 父 body 的世界位姿 = 实体 frame 位姿 ∘ 该局部位姿；安装根本身就在实体 frame 上，
                    # 它的局部安装位姿是恒等（与 collision 分支一致）。
                    local = (np.zeros(3), np.array([1.0, 0.0, 0.0, 0.0])) if mount is not None else (np.asarray(root.pos, dtype=float), np.asarray(root.quat, dtype=float))
                    spec_bodies[eid] = (root, local[0], local[1])
                source_path = cfg.get('sourcePath') or cfg.get('modelPath')
                source_sha = hashlib.sha256(Path(path_from_uri(source_path)).read_bytes()).hexdigest() if source_path else None
                maps[eid] = {'entity': copy.deepcopy(e), 'prefix': prefix, 'rootName': cfg.get('rootBody'), 'controller': copy.deepcopy(component.get('controller', {})), 'initialJoints': initial_joints, 'initialActuators': initial_actuators, 'sourceSha256': source_sha, 'sourceBase': source_base_state, 'nativeCameraSources': native_camera_sources, 'nativeCameraRefusals': native_camera_refusals}
            elif component.get('collision'):
                c = component['collision']
                shape = c.get('shape', c.get('type', 'box'))
                if shape == 'mesh' and c.get('parts') is None and c.get('binding') is not None:
                    # splat 场景几何绑定：碰撞由本次编译的 collisionPatches 世界级通道提供，
                    # 实体本身不装碰撞体（asset-bake 的 parts 网格碰撞优先，互不误判）。
                    # 补丁未到达时不能静默：登记结构化告警，按纯视觉跳过。
                    if patches is None:
                        skipped.append({'code': 'SCENE_COLLISION_PATCH_MISSING', 'entityId': eid,
                                        'message': '实体 ' + eid + ' 声明了 splat/mesh 碰撞绑定，但碰撞补丁未随本次编译到达，已按纯视觉跳过'})
                    continue
                types = {'box': mj.mjtGeom.mjGEOM_BOX, 'sphere': mj.mjtGeom.mjGEOM_SPHERE, 'cylinder': mj.mjtGeom.mjGEOM_CYLINDER, 'capsule': mj.mjtGeom.mjGEOM_CAPSULE, 'plane': mj.mjtGeom.mjGEOM_PLANE}
                if shape not in ('mesh', 'sdf') and shape not in types:
                    raise SimError('UNSUPPORTED_CAPABILITY', '需要 asset-bake 或原生模型的碰撞类型: ' + str(shape))
                # 尺寸（halfExtents/半径/半长）是几何量：镜像分量只把它映到镜像位置，不改尺寸，
                # 必须取正量；位置（center）反过来必须保留符号。见 check_collision_scale。
                check_collision_scale(scale, eid)
                # 声明几何在实体数据帧里，落位一律走 frames[eid]（完整线性映射 D，见 collision_frame_maps）。
                linear = frames[eid]
                body = spec.worldbody.add_body(name=prefix + 'body', pos=p, quat=q)
                rigid = copy.deepcopy(component.get('rigidBody', {}))
                for field, declaration in [('gravityEnabled', rigid.get('gravityEnabled', True)), ('collision.enabled', c.get('enabled', True))]:
                    if not isinstance(declaration, bool):
                        raise SimError('INVALID_ARGUMENT', eid + ' 的 ' + field + ' 必须是布尔值')
                if rigid.get('massScalePolicy') == 'density':
                    rigid['massKg'] = positive(rigid.get('massKg'), eid + ' 的派生质量') * abs(float(np.linalg.det(linear)))
                if rigid.get('type', 'static') == 'dynamic':
                    body.add_freejoint(name=prefix + 'free')
                    if not rigid.get('gravityEnabled', True):
                        body.gravcomp = 1.
                # 摩擦与硬接触参数对本实体的全部派生 geom 统一：显式 friction 优先，
                # 缺省按 material 查 asset-bake 材质表，都没有沿用既有默认。
                friction = collision_friction(c.get('friction'), c.get('material'))
                solref = np.asarray(c.get('solref', [.002, 1.]), dtype=float)
                solimp = np.asarray(c.get('solimp', [.99, .99, .001, .5, 2.]), dtype=float)
                if shape in ('mesh', 'sdf'):
                    from static_triangle_surface import declared_static_surface, add_static_surface
                    native_surface = shape == 'mesh' and declared_static_surface(c, component.get('physicsBinding') or {}, rigid, eid, SimError)
                    # asset-bake 凸包产物（source=asset-bake-hull）：每个 part 一个网格资产，
                    # MuJoCo 对 mesh geom 按凸包碰撞。实体 scale 烘焙进网格顶点（不像原生
                    # articulation 那样拒绝 scale≠1）；声明质量在 parts 间均摊，刚体总质量
                    # 保持 rigidBody.massKg（缺失时与单盒一致默认 1）。
                    # sdf（source=asset-bake-sdf）：geom 用 mjGEOM_SDF，按源网格的符号距离场
                    # 碰撞，不凸化——深腔容器（碗/槽/杯）不封腔，是凸分解做不到的精度。
                    parts = c.get('parts')
                    if not isinstance(parts, list) or not parts:
                        raise SimError('INVALID_ARGUMENT', shape + ' 碰撞需要非空 parts 数组: ' + eid)
                    extra_boxes = c.get('shapes', [])
                    if not isinstance(extra_boxes, list):
                        raise SimError('INVALID_ARGUMENT', eid + ' 的 collision.shapes 必须是数组')
                    mass = rigid.get('massKg', 1) / (len(parts) + len(extra_boxes))
                    gtype = mj.mjtGeom.mjGEOM_MESH if shape == 'mesh' else mj.mjtGeom.mjGEOM_SDF
                    split = linear_frame_split(linear, eid, shape + ' 碰撞的')
                    if split is None and shape == 'sdf':
                        # sdf 的场由插件按网格文件在编译期烘出，顶点必须留在文件里：把剪切烘进
                        # 顶点这条路（mesh 分支在用）在这里走不通，也没有第二种精确表达。
                        raise SimError('UNSUPPORTED_CAPABILITY', '实体 ' + eid + ' 的 sdf 碰撞处在父层缩放与子层旋转合成的剪切映射下：'
                                       '符号距离场只按源网格文件烘制，剪切没有精确表达（把源网格物理化/改层级，或改用 mesh 碰撞件）')
                    geoms = []
                    for i, part in enumerate(parts):
                        if not isinstance(part, str):
                            raise SimError('INVALID_ARGUMENT', '实体 ' + eid + ' 的碰撞 parts 项必须是文件路径/URI 字符串: ' + str(part))
                        path = path_from_uri(part)
                        if not os.path.isfile(path):
                            raise SimError('COLLISION_MESH_NOT_FOUND', '实体 ' + eid + ' 的碰撞网格文件不存在: ' + path)
                        if native_surface:
                            static_triangle_counts.append(add_static_surface(spec, body, prefix + 'surface' + str(i), path, linear, c, friction, solref, solimp, eid, SimError))
                            continue
                        # 先用一次性 spec 真实解析该 OBJ：把文件级解析失败在此归因为
                        # 实体+文件名结构化错误，而不是让 spec.compile() 抛出无法归因的原始错误。
                        try:
                            probe = mj.MjSpec()
                            probe_mesh = probe.add_mesh(name='probe')
                            probe_mesh.file = path
                            probe.worldbody.add_geom(type=mj.mjtGeom.mjGEOM_MESH, meshname='probe')
                            probe.compile()
                        except Exception as exc:
                            raise SimError('COLLISION_MESH_INVALID', '实体 ' + eid + ' 的碰撞网格无法解析: ' + path + ': ' + str(exc)) from exc
                        mesh_name = prefix + 'hull' + str(i)
                        mesh = spec.add_mesh(name=mesh_name)
                        # 可精确表示的位形（D=R·diag(v)）仍走**文件 + 带符号 mesh.scale**：MuJoCo 把分量
                        # 真的乘到顶点上，负分量 = 顶点反射，凸包就是镜像后的几何（法线仍朝外），取绝对值
                        # 反而得到未镜像的错形状；父层旋转折进 geom 的 quat。真剪切时逐轴的 mesh.scale
                        # 不够——把 D 烘进顶点（凸包与仿射映射可交换），网格几何因此精确。
                        if split is not None:
                            quat, axis_scale = split
                            mesh.file = path
                            mesh.scale = axis_scale
                        else:
                            points = mesh_vertex_lines(path)
                            mesh.uservert = [float(value) for point in (linear @ points.T).T for value in point]
                        geom = body.add_geom(name=prefix + 'geom' + str(i), type=gtype, meshname=mesh_name, mass=mass, friction=friction)
                        if split is not None and split[0] is not None:
                            geom.quat = split[0]
                        geoms.append(geom)
                    for i, entry in enumerate(extra_boxes):
                        if not isinstance(entry, dict):
                            raise SimError('INVALID_ARGUMENT', eid + ' 的 collision.shapes 项必须是 {center,halfExtents}')
                        center = vec3(entry.get('center', [0, 0, 0]), eid + ' shapes.center')
                        half = vec3(entry.get('halfExtents'), eid + ' shapes.halfExtents')
                        if (half <= 0).any():
                            raise SimError('INVALID_ARGUMENT', eid + ' shapes.halfExtents 必须大于零')
                        geoms.extend(box_geoms_in_frame(spec, body, prefix + 'box' + str(i), prefix + 'boxframe' + str(i), center, half, linear, mass, friction, eid))
                elif shape == 'box' and c.get('shapes') is not None:
                    # asset-bake voxel_boxes 产物（凹物体/环境的盒组）：shapes 存在时忽略单盒
                    # 字段，逐盒按同一个 D 落位（可精确表示时是原生 box）；质量均摊保持刚体
                    # 总质量与单盒口径一致。
                    boxes = c['shapes']
                    if not isinstance(boxes, list) or not boxes:
                        raise SimError('INVALID_ARGUMENT', 'box shapes 必须是非空数组: ' + eid)
                    mass = rigid.get('massKg', 1) / len(boxes)
                    geoms = []
                    for i, entry in enumerate(boxes):
                        if not isinstance(entry, dict):
                            raise SimError('INVALID_ARGUMENT', '实体 ' + eid + ' 的 box shapes 项必须是 {center, halfExtents} 对象: ' + str(entry))
                        center = vec3(entry.get('center', [0, 0, 0]), eid + ' shapes[' + str(i) + '].center')
                        half = vec3(entry.get('halfExtents'), eid + ' shapes[' + str(i) + '].halfExtents')
                        if (half <= 0).any():
                            raise SimError('INVALID_ARGUMENT', eid + ' shapes[' + str(i) + '].halfExtents 必须大于零')
                        geoms.extend(box_geoms_in_frame(spec, body, prefix + 'geom' + str(i), prefix + 'frame' + str(i), center, half, linear, mass, friction, eid))
                else:
                    size = c.get('halfExtents', c.get('size', [.1, .1, .1]))
                    size = (list(size) + [0, 0, 0])[:3]
                    # 原生形状资产（source=asset-bake-primitive）的几何中心可偏离实体原点：
                    # 中心一律走完整映射 D·center（镜像实体的偏心中心要落到镜像一侧），缺省在原点。
                    center = vec3(c.get('center', [0, 0, 0]), eid + ' collision.center')
                    if shape == 'box':
                        geoms = box_geoms_in_frame(spec, body, prefix + 'geom', prefix + 'frame', center, np.asarray(size), linear, rigid.get('massKg', 1), friction, eid)
                    elif shape == 'plane':
                        # MuJoCo 的平面在物理上是无限的，size 只是渲染尺寸（逐轴 |v|）；平面的像在剪切下
                        # 要重定向法向，本轮不动单侧法向，所以那里明确拒绝（见 shape_refusal_text）。
                        split = linear_frame_split(linear, eid, '碰撞形状的')
                        if split is None:
                            raise SimError('UNSUPPORTED_CAPABILITY', '实体 ' + eid + ' 的 plane 碰撞处在父层缩放与子层旋转合成的剪切映射下：'
                                           + shape_refusal_text(shape))
                        quat, axis_scale = split
                        geom = body.add_geom(name=prefix + 'geom', type=types[shape], size=np.asarray(size, dtype=float) * np.abs(axis_scale),
                                             mass=rigid.get('massKg', 1), friction=friction, pos=linear @ center)
                        if quat is not None:
                            geom.quat = quat
                        geoms = [geom]
                    else:
                        geoms, note = primitive_geoms_in_frame(spec, body, prefix + 'geom', prefix + 'shape', shape, size, center, linear,
                                                               rigid.get('massKg', 1), friction, eid)
                        if note is not None:
                            # 几何表达被换掉（椭球/派生网格）必须让消费者看得见，不静默。
                            skipped.append(note)
                # 派生环境盒是表面近似；使用可配置的硬接触默认值，避免默认软接触
                # 在高速落体/车辆接触时产生厘米级穿透。原生 MJCF 的接触参数仍由原件保留。
                for geom in geoms:
                    geom.solref = solref
                    geom.solimp = solimp
                    geom.contype = int(c.get('contype', 1)) if c.get('enabled', True) else 0
                    geom.conaffinity = int(c.get('conaffinity', 1)) if c.get('enabled', True) else 0
                spec_bodies[eid] = (body, np.zeros(3), np.array([1.0, 0.0, 0.0, 0.0]))
                maps[eid] = {'entity': copy.deepcopy(e), 'prefix': prefix, 'rootName': 'body', 'controller': copy.deepcopy(component.get('controller', {}))}
            elif self.scene_camera_declarations(e):
                # 相机实体没有物理体，但它的相机声明（components.camera 或 viewport 存的
                # components.viewerCamera.cameras[]）会由下面的相机装配进引擎，因此不算
                # "被跳过的纯视觉实体"；相机本身的问题在装配阶段单独登记告警。
                pass
            else:
                # 既无原生 MJCF/URDF 又无 collision 组件的实体（典型是纯视觉 GLB）没有物理体，
                # 不能静默跳过：登记结构化告警，随本次编译结果经 handle 的 warnings 暴露给调用方。
                skipped.append({'code': 'ENTITY_SKIPPED_NO_COLLISION', 'entityId': eid,
                                'message': '实体 ' + eid + ('（' + str(e['name']) + '）' if e.get('name') else '') + ' 没有碰撞体，已在物理装配中跳过（纯视觉）'})
        # Scene 声明的命名相机（components.camera 与 components.viewerCamera）：与实体自带 MJCF/URDF 相机共存，名字一律带
        # 实体前缀，绝不覆盖同名原生相机；物理体装配完成后再挂载，才能挂到父实体的真实 body 上。
        native_planes=[g for g in spec.geoms if g.name in native_ground_names and g.type==mj.mjtGeom.mjGEOM_PLANE and (g.contype or g.conaffinity)]
        ground_names.update(g.name for g in native_planes)
        if native_planes:
            for entity in scene['entities']:
                if not replaceable_standard_ground(scene,entity)or entity['entityId']not in maps:continue
                prefix=maps[entity['entityId']]['prefix']
                for geom in list(spec.geoms):
                    if geom.name.startswith(prefix):spec.delete(geom)
                replaced_template_ground.append(entity['entityId'])
        if explicit_ground_requested(scene,self.options)and not native_planes and not (patches and patches.get('suppressDefaultGround')):
            spec.worldbody.add_geom(name='__ground',type=mj.mjtGeom.mjGEOM_PLANE,size=[0,0,.1],pos=[0,0,0],friction=[1.2,.08,.01]);ground_names.add('__ground')
        from robot_authoring import compile_bindings, initialize_bindings
        pending_base_bindings = compile_bindings(spec, scene, maps, poses, spec_bodies, SimError)
        scene_cameras = self.compile_scene_cameras(spec, scene, poses, spec_bodies, skipped)
        from static_triangle_surface import configure_static_surface_arena
        surface_arena = configure_static_surface_arena(spec, static_triangle_counts, explicit_arena_sources, SimError)
        if surface_arena:
            skipped.append({'code':'STATIC_TRIANGLE_ARENA','message':'Static triangle BVH uses a bounded work arena',**surface_arena})
        model = spec.compile()
        if pending_hfield is not None:
            # spec 阶段的 hfield 只有占位数据；把归一化高程写进编译产物的 hfield_data。
            # 碰撞面 = geom z + data×size[2]，精确落在补丁声明的绝对高程（米）上。
            hfield_name, hfield_values = pending_hfield
            hfield_id = mj.mj_name2id(model, mj.mjtObj.mjOBJ_HFIELD, hfield_name)
            adr = int(model.hfield_adr[hfield_id])
            model.hfield_data[adr:adr + hfield_values.shape[0]] = hfield_values
        for eid in declared_ground_ids(scene):
            if eid not in maps:continue
            prefix=maps[eid]['prefix']
            ground_names.update(model.geom(i).name for i in range(model.ngeom)if model.geom(i).name.startswith(prefix)and (model.geom_contype[i]or model.geom_conaffinity[i]))
        data = mj.MjData(model)
        mj.mj_forward(model, data)
        for eid, info in maps.items():
            prefix = info['prefix']
            bids = [i for i in range(1, model.nbody) if model.body(i).name.startswith(prefix)]
            info['body'] = model.body(prefix + info['rootName']).id if info['rootName'] else bids[0]
            joints = {}
            for i in range(model.njnt):
                name = model.joint(i).name
                if name.startswith(prefix) and int(model.jnt_type[i]) in SCALAR_JOINT_TYPES:
                    local = name[len(prefix):]
                    joints[local] = {'id': i, 'qpos': int(model.jnt_qposadr[i]), 'dof': int(model.jnt_dofadr[i]), 'actuator': None}
            acts = {}
            for i in range(model.nu):
                name = model.actuator(i).name
                if name.startswith(prefix):
                    j = int(model.actuator_trnid[i, 0])
                    local_joint = model.joint(j).name[len(prefix):] if j >= 0 and model.actuator_trntype[i] == mj.mjtTrn.mjTRN_JOINT else None
                    # 力律类别按 biastype 判定：NONE 时 biasprm 被 MuJoCo 整体忽略（纯力源 force=gainprm[0]×ctrl），
                    # 官方 BHL 力矩资产正是这种（<motor class=...> 继承类默认 <position kp="50"/>，biasprm=[0,-50,1]
                    # 但 biastype=NONE，实测 ctrl=0/偏角 0.3 rad 出力 0 N·m）。只看 biasprm 会把纯力矩执行器
                    # 误判成位置伺服，control 就会把位置参考写成 ctrl（=力矩）而不是走逐关节 PD。
                    bias_applies = int(model.actuator_biastype[i]) == int(mj.mjtBias.mjBIAS_AFFINE)
                    mode = 'position' if bias_applies and model.actuator_biasprm[i, 1] < 0 else ('velocity' if bias_applies and model.actuator_biasprm[i, 2] < 0 else 'torque')
                    acts[name[len(prefix):]] = {'id': i, 'joint': local_joint, 'mode': mode}
                    if local_joint in joints:
                        joints[local_joint]['actuator'] = name[len(prefix):]
                        if mode == 'position':
                            data.ctrl[i] = data.qpos[joints[local_joint]['qpos']]
            info['joints'], info['actuators'] = joints, acts
            # 一个原生 MJCF 内可以同时存在多个自由动态体（根 freejoint + 内部动态 body）。
            # 这里按真实 joint 局部名记录本实体的全部自由根，供 observe 逐一报告；bodyName 是
            # 该 joint 真实挂载 body 的局部稳定名，供消费者按 body 选择，不伪装成受控关节。
            info['freeJoints'] = {}
            for i in range(model.njnt):
                name = model.joint(i).name
                if name.startswith(prefix) and model.jnt_type[i] == mj.mjtJoint.mjJNT_FREE:
                    body_name = model.body(int(model.jnt_bodyid[i])).name
                    info['freeJoints'][name[len(prefix):]] = {'qpos': int(model.jnt_qposadr[i]), 'dof': int(model.jnt_dofadr[i]), 'body': int(model.jnt_bodyid[i]), 'bodyName': body_name[len(prefix):] if body_name.startswith(prefix) else body_name}
            # 源 tendon 执行器通道：肌腱不是关节，不能塞进 controlledJointNames；这里按源模型
            # （tendon 名 + 缠绕关节/系数 + gear/gain/bias/force/ctrlrange）原样记录，供 describe
            # 如实暴露、供 tendon 动作按肌腱坐标寻址。被肌腱驱动的关节只标注驱动来源。
            tendons = []
            for i in range(model.nu):
                name = model.actuator(i).name
                if not name.startswith(prefix) or model.actuator_trntype[i] != mj.mjtTrn.mjTRN_TENDON:
                    continue
                tid = int(model.actuator_trnid[i, 0])
                full_tendon = model.tendon(tid).name
                adr, count = int(model.tendon_adr[tid]), int(model.tendon_num[tid])
                wraps = [(int(model.wrap_type[k]), int(model.wrap_objid[k]), float(model.wrap_prm[k])) for k in range(adr, adr + count)]
                fixed = bool(wraps) and all(w[0] == int(mj.mjtWrap.mjWRAP_JOINT) for w in wraps)
                local_joints = [model.joint(oid).name[len(prefix):] for _, oid, _ in wraps] if fixed else []
                kinds = {int(model.jnt_type[oid]) for _, oid, _ in wraps} if fixed else set()
                # 源本身的坐标单位：fixed tendon 是 Σ coef·q（hinge→rad，slide→m），spatial tendon 是几何长度 m。
                unit = 'm' if not fixed or kinds == {int(mj.mjtJoint.mjJNT_SLIDE)} else ('rad' if kinds == {int(mj.mjtJoint.mjJNT_HINGE)} else 'mixed')
                gear = float(model.actuator_gear[i, 0])
                ctrl_range = [float(v) for v in model.actuator_ctrlrange[i]] if model.actuator_ctrllimited[i] else None
                run = name[len(prefix):]
                position_reference = fixed_position_servo(model, i)
                tendons.append({'name': full_tendon[len(prefix):] if full_tendon.startswith(prefix) else full_tendon,
                                'external': not full_tendon.startswith(prefix), 'id': tid, 'actuatorId': i, 'actuator': run,
                                # 只有核对过固定 gain/bias 关系的标准 position 力律才允许称坐标位置参考；
                                # 其余自定义力律标 custom，tendon 动作会明确拒绝（不冒充 position/velocity/torque）。
                                'mode': 'position' if position_reference else 'custom',
                                'positionReference': position_reference,
                                'heuristicMode': acts[run]['mode'], 'fixed': fixed, 'joints': local_joints, 'coefficients': [prm for _, _, prm in wraps] if fixed else [],
                                'unit': unit, 'gear': gear, 'ctrlRange': ctrl_range,
                                # 命令坐标的权限区间 = 源 ctrlrange 按 gear 换算（gear<0 时翻转；gear=0 无法用坐标寻址）。
                                'controlRange': sorted([ctrl_range[0] / gear, ctrl_range[1] / gear]) if ctrl_range and gear else None,
                                'forceRange': [float(v) for v in model.actuator_forcerange[i]] if model.actuator_forcelimited[i] else None,
                                'gainprm': [float(v) for v in model.actuator_gainprm[i][:3]], 'biasprm': [float(v) for v in model.actuator_biasprm[i][:3]]})
                for local_joint in local_joints:
                    if local_joint in joints:
                        joints[local_joint].setdefault('tendonActuators', []).append(run)
            info['tendons'] = tendons
            info['tendonByActuator'] = {t['actuator']: t for t in tendons}
            info['sites'] = {model.site(i).name[len(prefix):]: i for i in range(model.nsite) if model.site(i).name and model.site(i).name.startswith(prefix)}
            info['heldTargets'] = {}
            for name, value in info.get('initialJoints', {}).items():
                if name in joints:
                    data.qpos[joints[name]['qpos']] = value
            for name, value in info.get('initialActuators', {}).items():
                if name in acts:
                    data.ctrl[acts[name]['id']] = value
        initialize_bindings(model, data, maps, pending_base_bindings)
        mj.mj_forward(model, data)
        for info in maps.values():
            for name,joint in info['joints'].items():
                if joint['actuator'] and info['actuators'][joint['actuator']]['mode']=='torque':
                    info['heldTargets'][name]=float(data.qpos[joint['qpos']])
            if info['controller'].get('type') == 'quadruped':
                info['gaitLegs']=gait.calibrate(model,data,info,info['controller']['legs'])
        # 跳过告警走 stderr 诊断通道（stdout 是 NDJSON 协议通道，不能混入），结构化列表随返回值交出。
        if skipped:
            print('[sim-mujoco] WARNING ' + '；'.join(w['message'] for w in skipped), file=sys.stderr, flush=True)
        # 保存 spec 是为了保障 native assets 的生命周期。
        return spec, child_specs, model, data, maps, ground_names, skipped, scene_cameras,replaced_template_ground,{g.name for g in native_planes}

    # --------------------------------------------- Scene 声明相机（components.camera / viewerCamera）
    # 所有权边界与既有相机族一致：Scene 保存相机实体与声明（名字/TRS/光学参数），Sim 拥有
    # 世界内真实相机（mjCAMERA）、渲染与标定。相机名 = <entityId>/<显示名>，与原生 MJCF/URDF
    # 相机（attach 后同样带实体前缀）同一命名口径：稳定绑定实体、不与同名原生相机串台。
    # 不新建第二套相机数据库/录制器：这里只把声明装进引擎，读/拍/调全走既有
    # camera_list / camera_adjust / capture / project_annotation。

    def scene_camera_rotation(self, eid, world_quaternion, camera, skipped):
        """Scene 相机的世界朝向（3x3）与朝向来源（'transform' | 'direction'）。

        轴/单位约定（Blender 导出侧、USD、MuJoCo 相机三边一致）：右手 Z-up；相机 +X 右、+Y 上、
        -Z 前；四元数 [x,y,z,w] 表示 world←camera 旋转；长度单位米、角度弧度。实体 TRS 的世界
        旋转就是相机世界旋转（Blender 相机对象的局部轴即相机轴）。`direction` 是源件声明的世界
        视线方向，用于交叉核对：与 TRS 一致（1e-4 内）就以 TRS 为准；TRS 没有实质朝向（近单位
        旋转）时用它兜底取景；两者明显冲突时仍以 TRS 为准并登记结构化告警，不静默改朝向。
        """
        rotation = self._matrix_from_quaternion([float(world_quaternion[1]), float(world_quaternion[2]), float(world_quaternion[3]), float(world_quaternion[0])])
        direction = camera.get('direction')
        if direction is None:
            return rotation, 'transform'
        values = list(direction) if isinstance(direction, (list, tuple)) else None
        if values is None or len(values) != 3 or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values):
            skipped.append({'code': 'SCENE_CAMERA_DIRECTION_INVALID', 'entityId': eid,
                            'message': '实体 ' + eid + ' 的相机 direction 不是 3 个有限数值，该相机按实体 TRS 姿态取景'})
            return rotation, 'transform'
        vector = np.asarray(values, dtype=float)
        norm = float(np.linalg.norm(vector))
        if norm < 1e-9:
            skipped.append({'code': 'SCENE_CAMERA_DIRECTION_INVALID', 'entityId': eid,
                            'message': '实体 ' + eid + ' 的相机 direction 是零向量，该相机按实体 TRS 姿态取景'})
            return rotation, 'transform'
        cosine = float(np.clip(-rotation[:, 2] @ (vector / norm), -1.0, 1.0))
        if cosine >= 1 - 1e-4:
            return rotation, 'transform'
        if np.allclose(rotation, np.eye(3), atol=1e-3):
            return look_rotation(vector / norm), 'direction'
        skipped.append({'code': 'SCENE_CAMERA_DIRECTION_MISMATCH', 'entityId': eid,
                        'message': '实体 ' + eid + ' 的相机 direction 与实体 TRS 姿态相差 ' + str(round(math.degrees(math.acos(cosine)), 3)) + '°，该相机已按 TRS 装进引擎（未静默改成 direction）'})
        return rotation, 'transform'

    @staticmethod
    def finite_vector(value, size):
        """有限数值向量（长度必须等于 size），否则 None：声明里的位姿字段一律先这样校验。"""
        if not isinstance(value, (list, tuple)) or len(value) != size:
            return None
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in value):
            return None
        return [float(v) for v in value]

    # ---------------------------------------------- 引擎内参口径（正由真实渲染像素实测，非照抄公式）
    # MuJoCo 3.13 声明 resolution + sensorsize 后按内参渲染：focalpixel/principalpixel 在这一支里
    # 真正生效，cam_fovy 退化成派生量且对画面惰性（实测把它从 29.86° 改到 60°，输出逐像素不变）。
    # 视口 (W_v,H_v) 下实际生效的 K（probe10 用解耦轴最小二乘从真实像素回归，误差 <0.2 px）：
    #   fx_eff = fx_cfg·W_v/W_c            fy_eff = fy_cfg·H_v/H_c
    #   cx_eff = (W_v−1)/2 − cx_cfg·W_v/W_c   cy_eff = (H_v−1)/2 − cy_cfg·H_v/H_c
    # 即 focalpixel 是**相机自身分辨率下**的像素焦距；principalpixel 是"图像中心相对光轴像素的偏移"，
    # 与 OpenCV/CV 口径符号相反（cx_cfg=0 → 光轴恰在图像中心；cx_cfg=320 在 640 宽视口下把光轴推到
    # u=159.5−320=−160.5，实测 −160.5）。因此把用户/CV 口径 K 装进引擎要取
    #   principalpixel = ((W_c−1)/2 − cx, (H_c−1)/2 − cy)   （负值合法，引擎接受）
    # 这样在 K 自身分辨率下渲染出的就是声明的 K（实测光轴落点与声明 1e-6 内一致）。fovy 相机
    # （无 sensorsize）是另一支：fx = fy = H_v/(2·tan(fovy/2))、主点恰在 (W_v−1)/2，与视口长宽比无关。

    def scene_camera_intrinsics(self, eid, name, pose, skipped):
        """声明里的针孔内参 → 规范化 dict；没有 intrinsics 字段返回 None，非法登记告警并返回 None。

        接受的就是用户/CV 口径的像素 K：fx/fy 为像素焦距（正）、cx/cy 为光轴像素（可为负或在画面外）、
        width/height 为这份 K 对应的分辨率；可选 distortion（长度任意、全有限）与传感器宽度
        （sensorWidthMm，只用来给引擎的 sensorsize 一个物理尺度——它不影响成像角，只影响回执怎么描述
        传感器）。缺字段、非有限、非正焦距一律**不猜**：登记 SCENE_CAMERA_INTRINSICS_INVALID 后退回
        fovy 路径（声明里还有合法 fovDeg 时）或干脆不装配。
        """
        intrinsics = pose.get('intrinsics')
        if intrinsics is None:
            return None
        if not isinstance(intrinsics, dict):
            skipped.append({'code': 'SCENE_CAMERA_INTRINSICS_INVALID', 'entityId': eid,
                            'message': '相机 ' + name + ' 的 intrinsics 不是对象，该相机未按内参装配（不猜 K）'})
            return None
        values = {}
        for key in ('fx', 'fy', 'cx', 'cy', 'width', 'height'):
            value = intrinsics.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                skipped.append({'code': 'SCENE_CAMERA_INTRINSICS_INVALID', 'entityId': eid,
                                'message': '相机 ' + name + ' 的 intrinsics.' + key + ' 不是有限数值，该声明未按内参装配（不猜 K）'})
                return None
            values[key] = float(value)
        if not (values['fx'] > 0 and values['fy'] > 0):
            skipped.append({'code': 'SCENE_CAMERA_INTRINSICS_INVALID', 'entityId': eid,
                            'message': '相机 ' + name + ' 的 intrinsics 焦距必须为正（fx=' + str(values['fx']) + ', fy=' + str(values['fy']) + '），该声明未按内参装配'})
            return None
        for key in ('width', 'height'):
            if not 1 <= values[key] <= 16384 or abs(values[key] - round(values[key])) > 1e-6:
                skipped.append({'code': 'SCENE_CAMERA_INTRINSICS_INVALID', 'entityId': eid,
                                'message': '相机 ' + name + ' 的 intrinsics.' + key + ' 必须是 1..16384 的整数像素数（K 的分辨率口径），该声明未按内参装配'})
                return None
            values[key] = float(round(values[key]))
        result = dict(values)
        declared = intrinsics.get('distortion')
        if declared is not None:
            values = list(declared) if isinstance(declared, (list, tuple)) else None
            if values is None or not values or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values):
                skipped.append({'code': 'SCENE_CAMERA_INTRINSICS_INVALID', 'entityId': eid,
                                'message': '相机 ' + name + ' 的 intrinsics.distortion 必须是有限数值数组，该声明未按内参装配'})
                return None
            result['distortion'] = [float(v) for v in values]
            if any(v != 0 for v in values):
                # MuJoCo 3.13 的投影只有 perspective/orthographic（mjtProjection），没有畸变模型：
                # 声明了非零畸变就必须说清楚它没进渲染，不能回显成"已生效"。
                skipped.append({'code': 'SCENE_CAMERA_DISTORTION_UNMODELED', 'entityId': eid,
                                'message': '相机 ' + name + ' 声明了畸变 ' + str(result['distortion']) +
                                           '，但 MuJoCo 3.13 的相机投影没有畸变模型（只有透视/正交），该畸变未进渲染、标定里标成未建模'})
        sensor = pose.get('sensorWidthMm')
        if isinstance(sensor, (int, float)) and not isinstance(sensor, bool) and math.isfinite(sensor) and 0.1 <= sensor <= 10000:
            result['sensorWidthMm'] = float(sensor)
        return result

    def scene_camera_optics(self, intrinsics, fovy):
        """(声明的 K 或 None, 竖直视场或 None) → MjSpec 相机光学参数 kwargs（两条路径互斥）。

        - K 路径：resolution = K 自己的 W_c×H_c、sensorsize = 传感器宽度（声明优先，否则 36 mm）按 K 的
          长宽比配高度、focalpixel = 声明焦距、principalpixel = 上述补偿式；不给 fovy，避免与 sensorsize
          同时出现（XML 规则：至多其一）。
        - fovy 路径：沿用既有 fovy=…（引擎方形像素 + 竖直视场），没有 K 的老相机行为不变。
        """
        if intrinsics is None:
            return {'fovy': float(fovy)}
        width, height = int(intrinsics['width']), int(intrinsics['height'])
        sensor_width = round(intrinsics.get('sensorWidthMm', 36.0), 6) / 1000.0
        return {
            'resolution': [width, height],
            'sensor_size': [sensor_width, sensor_width * height / width],
            'focal_pixel': [float(intrinsics['fx']), float(intrinsics['fy'])],
            'principal_pixel': [(width - 1) / 2.0 - float(intrinsics['cx']), (height - 1) / 2.0 - float(intrinsics['cy'])],
        }

    @staticmethod
    def intrinsics_vertical_fov(intrinsics):
        """一份像素 K 的竖直视场（度）= 2·atan(H/(2·fy))：回执里的 fovyDeg 由 K 派生，不另编一个。"""
        return math.degrees(2.0 * math.atan(float(intrinsics['height']) / (2.0 * float(intrinsics['fy']))))

    def scene_camera_fov_check(self, eid, name, component, pose, intrinsics, skipped):
        """声明里同时有 fovDeg 与 K 时的交叉核对：一致（1% 或 0.5° 内）就算了，明显不一致就登记告警。

        K 优先（它比单一视场严格更强：还带主点与像素长宽比），但绝不静默丢掉声明的 fovDeg。
        """
        fovy = pose.get('fovYDeg') if component == 'camera' else pose.get('fovDeg')
        if isinstance(fovy, bool) or not isinstance(fovy, (int, float)) or not math.isfinite(fovy) or not 0 < fovy < 180:
            return None
        derived = self.intrinsics_vertical_fov(intrinsics)
        if abs(derived - fovy) > max(0.5, 0.01 * fovy):
            skipped.append({'code': 'SCENE_CAMERA_FOV_INTRINSICS_MISMATCH', 'entityId': eid,
                            'message': '相机 ' + name + ' 声明的 fovDeg=' + str(fovy) + ' 与 K 派生的竖直视场 ' +
                                       str(round(derived, 4)) + '° 不一致，已按 K 装配（K 更严格，同时定主点与像素长宽比）'})
        return float(fovy)

    def scene_camera_declarations(self, entity):
        """实体上的相机声明，按来源摊平成 [(component, 显示名或 None, 声明 dict)]。

        两种来源都读、互不覆盖：
        - `components.camera`：Blender 导出侧的相机实体（相机轴 = 实体 TRS 轴，另有 direction 交叉核对）；
        - `components.viewerCamera.cameras[]`：66 的 Scene 命名相机（`{name,savedAt,state}`），
          state 存的是**保存时的世界位姿**（position/quaternion，[x,y,z,w]）、竖直视场 fovDeg、
          near/far 与当时画布的 K。
        这里只负责认出声明；视场/位姿是否合法在装配时逐条校验，缺名字的用实体显示名兜底。
        """
        components = entity.get('components') or {}
        declarations = []
        camera = components.get('camera')
        if isinstance(camera, dict) and camera:
            declarations.append(('camera', str(camera.get('name') or '').strip() or None, camera))
        viewer = components.get('viewerCamera')
        entries = viewer.get('cameras') if isinstance(viewer, dict) else None
        if isinstance(entries, list):
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                state = entry.get('state')
                pose = dict(state) if isinstance(state, dict) else dict(entry)
                name = str(entry.get('name') or '').strip() or None
                declarations.append(('viewerCamera', name, pose))
        return declarations

    def scene_camera_view(self, eid, component, pose, world_position, world_quaternion, skipped):
        """一条声明 → (世界位置, 世界朝向 3x3, 朝向来源)，只读、不代替装配做取舍。

        - `components.camera`：世界位姿 = 实体世界 TRS，`direction` 只做交叉核对（沿用既有规则）；
        - `components.viewerCamera`：state 的位置/四元数是保存时的**世界**位姿，优先原样使用
          （口径与 66 的命名相机回执一致）；四元数缺失/非法时才按 position→target（配 up）做
          look-at 兜底，再退到实体 TRS——都在回执里标出来源，不静默猜。
        """
        if component == 'camera':
            rotation, source = self.scene_camera_rotation(eid, world_quaternion, pose, skipped)
            return list(world_position), rotation, source
        position = self.finite_vector(pose.get('position'), 3)
        quaternion = self.finite_vector(pose.get('quaternion'), 4)
        if quaternion is not None:
            rotation = self._matrix_from_quaternion(quaternion)  # state 的四元数就是 [x,y,z,w]
            return (position if position is not None else list(world_position)), rotation, 'viewer-camera'
        anchor = position if position is not None else list(world_position)
        target = self.finite_vector(pose.get('target'), 3)
        if target is not None:
            direction = np.asarray(target, dtype=float) - np.asarray(anchor, dtype=float)
            norm = float(np.linalg.norm(direction))
            if norm > 1e-9:
                skipped.append({'code': 'SCENE_CAMERA_VIEWER_POSE_INCOMPLETE', 'entityId': eid,
                                'message': '相机 ' + eid + ' 的命名相机声明没有可用四元数，已按 position→target 取景（朝向来源 viewer-camera-target）'})
                return anchor, look_rotation(direction / norm), 'viewer-camera-target'
        skipped.append({'code': 'SCENE_CAMERA_VIEWER_POSE_INCOMPLETE', 'entityId': eid,
                        'message': '相机 ' + eid + ' 的命名相机声明缺少可用的位姿，已按实体 TRS 取景'})
        rotation, source = self.scene_camera_rotation(eid, world_quaternion, {}, skipped)
        return list(world_position), rotation, source

    def scene_camera_extras(self, eid, name, component, pose, record, skipped, intrinsics=None):
        """把源件声明的光学参数原样带进记录（只回显核对，不参与投影）：镜头/传感器、near/far、K。

        declared* 一律是源件声明值（K 合法与否都回显，供调用方核对）；相机实际生效的内参在
        record['appliedIntrinsicsPx'] / 标定回执的 intrinsics 里，两者不同时以生效值为准。
        distortion 只在声明了的时候回显，并在标定里标成未建模（引擎没有畸变模型）。
        """
        if component == 'camera':
            for key in ('lensMm', 'sensorWidthMm'):
                value = pose.get(key)
                if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
                    record[key] = float(value)
        for key, target in (('near', 'declaredNearM'), ('far', 'declaredFarM')):
            value = pose.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
                record[target] = float(value)
        declared = pose.get('intrinsics')
        if isinstance(declared, dict):
            echo = {}
            for key in ('fx', 'fy', 'cx', 'cy', 'width', 'height'):
                value = declared.get(key)
                if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
                    echo[key] = float(value)
            if echo:
                record['declaredIntrinsicsPx'] = echo
        if intrinsics is None:
            return
        record['intrinsicsSource'] = 'declared-K'
        record['appliedIntrinsicsPx'] = {key: float(intrinsics[key]) for key in ('fx', 'fy', 'cx', 'cy', 'width', 'height')}
        if 'distortion' in intrinsics:
            record['declaredDistortion'] = list(intrinsics['distortion'])

    def compile_scene_cameras(self, spec, scene, poses, bodies, skipped):
        """把 Scene 声明的相机（components.camera 与 components.viewerCamera）编译成真实命名相机，
        返回 {相机名: 绑定记录}。

        - 显式 mount 精确选择实体内 body，局部安装 pose 直接写进真实相机；非法/缺 body 不退回 root/world；
        - 自由相机（无 parentId）直接挂 worldbody（camera_list 的 parentBodyName='world'）；
        - 有父实体的相机挂到父实体的真实 body，安装位姿 = 父 body 世界位姿⁻¹ ∘ 相机世界位姿
          （都按世界单位米/弧度），物理推进后相机随父 body 的 FK 一起动；
        - 父实体没有物理体（纯视觉）时按声明的世界位姿装到世界系并登记告警：相机可用但不会
          跟随一个不存在的物理体，不静默假装跟随；
        - 光学参数两条路径：声明了合法 K（intrinsics.fx/fy/cx/cy/width/height）就按引擎内参口径装配
          （resolution + sensorsize + focalpixel + principalpixel，见 scene_camera_optics），此时声明里的
          fovDeg 只作交叉核对；没有 K 或 K 非法时沿用 fovy 路径；
        - 视场（K 路径下无 K 可依时才需要）非法/缺失、或成品名与已有相机冲突时不装配，
          登记结构化告警（不猜视场、不覆盖别的相机）。
        """
        cameras = {}
        for e in scene['entities']:
            for component, declared_name, pose in self.scene_camera_declarations(e):
                record = self.install_scene_camera(spec, poses, bodies, skipped, e, component, declared_name, pose)
                if record:
                    cameras[record['cameraName']] = record
        return cameras

    def scene_camera_mount(self, spec, bodies, mount):
        """显式 body-local 米/xyzw 安装声明 → 唯一原生 body 与规范化局部 pose。"""
        if not isinstance(mount, dict):
            raise SimError('SCENE_CAMERA_MOUNT_INVALID', 'camera.mount 必须是 body 局部安装声明对象')
        owner, body_name = mount.get('entityId'), mount.get('bodyName')
        if not isinstance(owner, str) or not owner.strip() or not isinstance(body_name, str) or not body_name.strip():
            raise SimError('SCENE_CAMERA_MOUNT_INVALID', 'camera.mount 必须给出明确 entityId 与 bodyName')
        owner, body_name = owner.strip(), body_name.strip()
        if owner not in bodies:
            raise SimError('SCENE_CAMERA_MOUNT_NOT_FOUND', '相机目标实体没有原生物理 body: ' + owner)
        prefix = owner + '/'
        local_name = body_name[len(prefix):] if body_name.startswith(prefix) else body_name
        matches = [body for body in spec.bodies if body.name == prefix + local_name]
        if len(matches) != 1:
            raise SimError('SCENE_CAMERA_MOUNT_NOT_FOUND', '相机目标 body 不存在或不唯一: ' + prefix + local_name)
        position = self.finite_vector(mount.get('positionM'), 3)
        quaternion = self.finite_vector(mount.get('quaternionXyzw'), 4)
        norm = float(np.linalg.norm(quaternion)) if quaternion is not None else 0.0
        if position is None or not math.isfinite(norm) or norm < 1e-12:
            raise SimError('SCENE_CAMERA_MOUNT_INVALID', '相机 mount 必须给出有限局部 positionM 和非零 quaternionXyzw（米/xyzw）')
        quaternion = [value / norm for value in quaternion]
        return matches[0], {'entityId': owner, 'bodyName': local_name, 'positionM': position, 'quaternionXyzw': quaternion}

    def install_scene_camera(self, spec, poses, bodies, skipped, e, component, declared_name, pose):
        """装配一条 Scene 相机声明，成功返回绑定记录，未装配返回 None（并登记结构化告警）。"""
        eid = e['entityId']
        local_name = declared_name or (str(e.get('name') or '').strip() or 'camera')
        name = eid + '/' + local_name
        intrinsics = self.scene_camera_intrinsics(eid, name, pose, skipped)
        if intrinsics is not None:
            fovy = self.scene_camera_fov_check(eid, name, component, pose, intrinsics, skipped)
        else:
            fovy = pose.get('fovYDeg') if component == 'camera' else pose.get('fovDeg')
            if isinstance(fovy, bool) or not isinstance(fovy, (int, float)) or not math.isfinite(fovy) or not 0 < fovy < 180:
                skipped.append({'code': 'SCENE_CAMERA_FOV_INVALID', 'entityId': eid,
                                'message': '实体 ' + eid + ' 的相机 ' + local_name + ' 缺少合法的竖直视场（须是 (0,180) 开区间内的有限数值），且没有可用的 K，该相机未进引擎'})
                return None
            fovy = float(fovy)
        optics = self.scene_camera_optics(intrinsics, fovy)
        if any(item.name == name for item in spec.cameras):
            skipped.append({'code': 'SCENE_CAMERA_NAME_CONFLICT', 'entityId': eid,
                            'message': '相机名 ' + name + ' 已被模型中的其它相机占用，该 Scene 相机未进引擎'})
            return None
        if 'mount' in pose:
            try:
                body, mount = self.scene_camera_mount(spec, bodies, pose['mount'])
            except SimError as exc:
                skipped.append({'code': exc.code, 'entityId': eid, 'message': '相机 ' + name + ': ' + str(exc)})
                return {'entityId': eid, 'localName': local_name, 'cameraName': name,
                        'available': False, 'reason': exc.code, 'message': str(exc), 'cameraComponent': component}
            body.add_camera(name=name, pos=mount['positionM'],
                            quat=[mount['quaternionXyzw'][3], *mount['quaternionXyzw'][:3]], **optics)
            record = {'entityId': eid, 'localName': local_name, 'cameraName': name, 'available': True,
                      'parentEntityId': mount['entityId'], 'parentBodyName': body.name, 'mount': mount,
                      'fovyDeg': self.intrinsics_vertical_fov(intrinsics) if intrinsics is not None else float(fovy),
                      'intrinsicsSource': 'declared-K' if intrinsics is not None else 'fovy',
                      'cameraComponent': component, 'orientationSource': 'body-local-mount'}
            if intrinsics is not None and fovy is not None:
                record['declaredFovYDeg'] = float(fovy)
            if component == 'camera':
                record['isActive'] = bool(pose.get('isActive'))
            self.scene_camera_extras(eid, name, component, pose, record, skipped, intrinsics)
            return record
        position, quaternion, _scale = poses[eid]
        position, rotation, orientation_source = self.scene_camera_view(eid, component, pose, position, quaternion, skipped)
        camera_quaternion = self._quaternion_from_matrix(rotation)  # [x,y,z,w]
        world_quat = np.array([camera_quaternion[3], camera_quaternion[0], camera_quaternion[1], camera_quaternion[2]], dtype=float)
        owner = eid if eid in bodies else e.get('parentId')
        parent = bodies.get(owner) if owner else None
        parent_name = 'world'
        if parent is None:
            spec.worldbody.add_camera(name=name, pos=[float(v) for v in position], quat=[float(v) for v in world_quat], **optics)
            if e.get('parentId'):
                skipped.append({'code': 'SCENE_CAMERA_PARENT_UNSIMULATED', 'entityId': eid,
                                'message': '相机 ' + name + ' 的父实体 ' + str(e['parentId']) + ' 没有物理体，该相机已按场景声明的世界位姿装在世界系（不跟随物理）'})
        else:
            body, local_position, local_quaternion = parent
            frame_position, frame_quaternion, _frame_scale = poses[owner]
            body_position = frame_position + quat_rotate(frame_quaternion, local_position)
            body_quaternion = quat_mul(frame_quaternion, local_quaternion)
            body_rotation = quat_matrix(body_quaternion)
            local_camera_position = body_rotation.T @ (position - body_position)
            local_camera_quaternion = quat_mul(quat_inverse(body_quaternion), world_quat)
            body.add_camera(name=name, pos=[float(v) for v in local_camera_position],
                            quat=[float(v) for v in local_camera_quaternion], **optics)
            parent_name = body.name
        record = {'entityId': eid, 'localName': local_name, 'cameraName': name,
                  # K 路径的 fovyDeg 由 K 派生（引擎里 cam_fovy 也是这么算出来的）：不把声明的 fovDeg
                  # 冒充成生效视场，声明值只走 declaredIntrinsicsPx/fovDeg 交叉核对告警那条线。
                  'fovyDeg': self.intrinsics_vertical_fov(intrinsics) if intrinsics is not None else float(fovy),
                  'intrinsicsSource': 'declared-K' if intrinsics is not None else 'fovy',
                  'cameraComponent': component, 'orientationSource': orientation_source,
                  'parentBodyName': parent_name}
        if intrinsics is not None and fovy is not None:
            record['declaredFovYDeg'] = float(fovy)
        # isActive 只有 components.camera 声明（Blender 侧机位）才有；命名相机没有这个概念，
        # 缺这一项比编一个 false 更如实。
        if component == 'camera':
            record['isActive'] = bool(pose.get('isActive'))
        self.scene_camera_extras(eid, name, component, pose, record, skipped, intrinsics)
        return record

    def sync(self, scene, force=False, initial=False, collision_patches=None):
        if self.scene and scene['sceneId'] != self.scene['sceneId']:
            raise SimError('SCENE_MISMATCH', 'world 不能绑定另一个 scene')
        if scene['revision'] < self.applied_revision:
            return self.handle()
        signature = physics_signature(scene, collision_patches)
        if self.scene and not force and signature == self.signature and self.status in ('ready', 'running'):
            self.scene = copy.deepcopy(scene)
            self.applied_revision = scene['revision']
            return self.handle()
        # 先把新场景完整编译到临时变量，成功后才触碰运行中的世界：编译失败时旧 model/data、
        # 实体映射、地面名与告警原样保留，世界保持可用（状态不变），错误按 SimError 协议
        # 结构化抛回调用方，不再把整个模拟世界打瘫。只有首次 open（self.scene 仍为空，
        # 没有旧世界可保留）才维持 unavailable 语义。
        try:
            compiled = self.compile(scene, collision_patches)
        except Exception as exc:
            if self.scene is None:
                self.status = 'unavailable'
                self.scene = copy.deepcopy(scene)
                raise
            if isinstance(exc, SimError):
                raise
            raise SimError('COMPILE_FAILED', '场景重编译失败，上一可用世界已完整保留: ' + str(exc)) from exc
        self.stop({})
        self.control_owners.clear()
        self.assisted.clear()
        self.spec, self.child_specs, self.model, self.data, self.entities, self.ground_names, self.warnings, self.scene_cameras,self.replaced_template_ground,self.native_ground_names = compiled
        self.scene = copy.deepcopy(scene)
        from collision_topology import patch_ownership
        self.collision_patch_owners = patch_ownership(self, collision_patches)
        self.signature = signature
        self.applied_revision = scene['revision']
        if not initial:
            self.generation += 1
        # 模型重建后旧的临时相机 override 属于上一个代次的渲染状态，必须清除而不是继续冒充；
        # 已完成的 capture 记录保留（各自带自己的 generation/frameId，文件仍在磁盘上）。
        self.camera_overrides = {}
        self.step_index = 0
        self.next_tick = time.monotonic()
        self.status = 'ready'
        self.initial_overlap = self.initial_overlap_diagnostic()
        if self.initial_overlap['status'] != 'CLEAR':
            self.warnings.append({'code': 'INITIAL_OVERLAP' if self.initial_overlap['pairs'] else 'INITIAL_OVERLAP_UNVERIFIED',
                                  'message': '初始物理重叠：' + json.dumps(self.initial_overlap, ensure_ascii=False)})
        return self.handle()

    def describe(self, eid):
        self.require_ready()
        info = self.info(eid)
        result = []
        for name, j in info['joints'].items():
            i = j['id']
            slide = self.model.jnt_type[i] == mj.mjtJoint.mjJNT_SLIDE
            item = {'name': name, 'type': 'slide' if slide else 'hinge', 'unit': 'm' if slide else 'rad'}
            if self.model.jnt_limited[i]:
                item['range'] = self.model.jnt_range[i].tolist()
            if j['actuator']:
                item['actuator'] = j['actuator']
                item['controlMode'] = info['actuators'][j['actuator']]['mode']
                actuator = info['actuators'][j['actuator']]
                # 原生控制反馈：与set_joint相同的逐关节PD配置；位置drive则读编译参数。
                if actuator['mode'] == 'torque':
                    item['driveStiffness'] = joint_gain(info['controller'], 'jointKp', name, 'kp', 120)
                    item['driveDamping'] = joint_gain(info['controller'], 'jointKd', name, 'kd', 4)
                elif actuator['mode'] == 'position':
                    item['driveStiffness'] = float(self.model.actuator_gainprm[actuator['id'], 0])
                    item['driveDamping'] = float(-self.model.actuator_biasprm[actuator['id'], 2])
            if j.get('tendonActuators'):
                # 关节没有关节级执行器，只被源 tendon 带动；不伪造 actuator，也不进 controlledJointNames。
                item['tendonActuators'] = list(j['tendonActuators'])
            result.append(item)
        # freeBases 是只读发现元数据：列出 observe 会报告的动态自由根（joint 局部名 + 真实 body 名），
        # 让消费者能按稳定标识选择对象；它们不是受控关节，不进入 joints/controlledJointNames。
        free_bases = [{'jointName': name, 'bodyName': info['freeJoints'][name]['bodyName'], 'massKg': float(self.model.body_mass[info['freeJoints'][name]['body']])} for name in sorted(info['freeJoints'])]
        tendons = []
        for t in info['tendons']:
            item = {'name': t['name'], 'actuator': t['actuator'], 'controlMode': t['mode'], 'tendonType': 'fixed' if t['fixed'] else 'spatial',
                    'joints': list(t['joints']), 'coefficients': list(t['coefficients']), 'unit': t['unit'], 'gear': t['gear'],
                    'controlRange': t['controlRange'], 'ctrlRange': t['ctrlRange'], 'forceRange': t['forceRange'],
                    'gainprm': list(t['gainprm']), 'biasprm': list(t['biasprm'])}
            if t['external']:
                # 执行器属于本实体，但肌腱定义在实体前缀之外：本实体的 tendon 动作不能寻址它，如实标注。
                item['externalTendon'] = True
            tendons.append(item)
        # 模型身份（DEV-027 F16）：旧实现把资源列表字符串化，无资源时恒为 "[]"，而合同 §2.7 要求
        # MotionPlan 带机器人/模型版本，且门里没人断言非空。这里优先用 MJCF 源路径（同一份原件的稳定
        # 标识），内联 MJCF（无 sourcePath）退化为 `inline-mjcf:<模型名>#<资源数>res`——绝不返回空串或 "[]"。
        describe_entity = info['entity']
        describe_mujoco = (describe_entity.get('components') or {}).get('mujoco') or {}
        describe_resources = describe_entity.get('resources') or []
        describe_source = describe_mujoco.get('sourcePath') or describe_mujoco.get('modelPath')
        model_version = str(describe_source) if describe_source else f"inline-mjcf:{getattr(self.model, 'name', '') or 'unnamed'}#{len(describe_resources) if isinstance(describe_resources, list) else 0}res"
        result = {'entityId': eid, 'modelVersion': model_version, 'expectedGeneration': self.generation, 'collisionContextVersion': str(self.generation), 'joints': result, 'controlledJointNames': [name for name, j in info['joints'].items() if j['actuator']], 'tendonActuators': tendons, 'freeBases': free_bases, 'controller': info['controller']}
        from robot_authoring import authoring_description
        result.update(authoring_description(self, info))
        if info['controller'].get('type') == 'drone':
            try:
                names,ids,matrix,limits=self.wrench_mapping(info)
                result['bodyWrench']={'available':True,'frame':'body-root','units':{'force':'N','torque':'Nm'},
                    'massKg':float(self.model.body_mass[info['body']]),'bodyName':self.model.body(info['body']).name,'gravityWorldMps2':self.model.opt.gravity.tolist(),
                    **({'sourceSha256':info['sourceSha256']} if info.get('sourceSha256') else {}),'actuators':names,'matrix':matrix.tolist(),'limits':limits}
            except SimError as error:
                result['bodyWrench']={'available':False,'reason':error.code+': '+str(error)}
        return result

    def info(self, eid):
        if eid not in self.entities:
            raise SimError('ENTITY_NOT_SIMULATED', '实体没有已加载的物理表示: ' + eid)
        return self.entities[eid]

    def free_base(self, name, joint):
        """自由根的真实状态；位置为世界系，角速度为局部系。"""
        qa, va = joint['qpos'], joint['dof']
        fq = self.data.qpos[qa+3:qa+7]
        return {'jointName': name, 'bodyName': joint['bodyName'], 'positionM': self.data.qpos[qa:qa+3].tolist(), 'quaternionXyzw': [*fq[1:].tolist(), float(fq[0])], 'linearVelocityWorldMps': self.data.qvel[va:va+3].tolist(), 'angularVelocityLocalRadps': self.data.qvel[va+3:va+6].tolist()}

    def free_joint_state(self, info):
        for name, joint in info['freeJoints'].items():
            if joint['body'] == info['body']:
                return self.free_base(name, joint)
        return None

    def observe(self, selection=None):
        self.require_ready()
        selection = selection or {}
        only = selection.get('entityIds')
        entities = []
        scene_poses = None
        authored_poses = world_poses(self.scene)
        for e in self.scene['entities']:
            eid = e['entityId']
            if only and eid not in only:
                continue
            info = self.entities.get(eid)
            if info:
                b = info['body']
                q = self.data.xquat[b].tolist()
                transform = {'position': self.data.xpos[b].tolist(), 'quaternion': [*q[1:], q[0]], 'scale': authored_poses[eid][2].tolist()}
                item = {'entityId': eid, 'transform': transform, 'joints': {'names': list(info['joints']), 'positions': [float(self.data.qpos[j['qpos']]) for j in info['joints'].values()], 'velocities': [float(self.data.qvel[j['dof']]) for j in info['joints'].values()]}}
                if info['tendons']:
                    # 肌腱坐标直接读引擎自身缓存 data.ten_length/ten_velocity，不用关节角重算代替。
                    item['tendons'] = {'names': [t['name'] for t in info['tendons']], 'lengths': [float(self.data.ten_length[t['id']]) for t in info['tendons']], 'velocities': [float(self.data.ten_velocity[t['id']]) for t in info['tendons']]}
                if selection.get('sensors', True):
                    sensors = {'bodyLinearVelocityMps': self.data.cvel[b, 3:].tolist(), 'bodyAngularVelocityRadps': self.data.cvel[b, :3].tolist()}
                    from robot_authoring import authoring_observation
                    authoring_observation(self, info, sensors)
                    if info['freeJoints']:
                        sensors['freeBases'] = {name: self.free_base(name, joint) for name, joint in info['freeJoints'].items()}
                        free = self.free_joint_state(info)
                        if free:
                            sensors['freeBase'] = free
                    for i in range(self.model.nsensor):
                        name = self.model.sensor(i).name
                        if name.startswith(info['prefix']):
                            a, n = int(self.model.sensor_adr[i]), int(self.model.sensor_dim[i])
                            sensors[name[len(info['prefix']):]] = self.data.sensordata[a:a+n].tolist()
                    if selection.get('sensors') is True and info['controller'].get('policyAdapter') == 'jlog-g1-23-75-torchscript-v1':
                        from policy_drive import policy_diagnostics
                        sensors['policyDiagnostics'] = policy_diagnostics(self, info)
                    if selection.get('sensors') is True and info['sites']:
                        sites = {}
                        for name, site_id in info['sites'].items():
                            orientation = np.zeros(4)
                            mj.mju_mat2Quat(orientation, self.data.site_xmat[site_id])
                            sites[name] = {'positionM': self.data.site_xpos[site_id].tolist(), 'quaternionXyzw': [*orientation[1:].tolist(), float(orientation[0])]}
                        sensors['sites'] = sites
                    if sensors:
                        item['sensors'] = sensors
            else:
                if scene_poses is None:
                    # 未独立模拟的GLB子树继承最近物理祖先的同帧刚体位姿；不能给落地后的根配旧Scene叶位姿。
                    actual={loaded_id:(self.data.xpos[loaded['body']].copy(),self.data.xquat[loaded['body']].copy(),authored_poses[loaded_id][2]) for loaded_id,loaded in self.entities.items()}
                    scene_poses = world_poses(self.scene, actual)
                p, q, scale = scene_poses[eid]
                item = {'entityId': eid, 'transform': {'position': p.tolist(), 'quaternion': [*q[1:].tolist(), float(q[0])], 'scale': scale.tolist()}}
            entities.append(item)
            if info and info['entity'].get('components',{}).get('collision') and not any(info['entity'].get('components',{}).get(key) for key in ('mujoco','isaac','articulation')):
                geom_ids=[i for i in range(self.model.ngeom) if self.model.geom(i).name.startswith(info['prefix'])]
                body_ids=[i for i in range(self.model.nbody) if self.model.body(i).name.startswith(info['prefix'])]
                item['physics']={'source':'mujoco-compiled','dynamic':bool(info['freeJoints']),
                                 'massKg':float(sum(self.model.body_mass[i] for i in body_ids)) if info['freeJoints'] else None,
                                 'gravityEnabled':bool(float(self.model.body_gravcomp[info['body']]) < 1.),
                                 'collisionEnabled':any(self.model.geom_contype[i] or self.model.geom_conaffinity[i] for i in geom_ids),
                                 'colliderCount':len(geom_ids),'bodyName':self.model.body(info['body']).name}
        frame = {'worldId': self.id, 'generation': self.generation, 'sceneRevision': self.applied_revision, 'stepIndex': self.step_index, 'simTime': float(self.data.time), 'frameId': f'{self.id}:{self.generation}:{self.step_index}', 'entities': entities,'worldStatus':self.run_status(),'worldPhysics':self.world_physics()}
        if any(camera.get('mount') for camera in self.scene_cameras.values()) or selection.get('cameraAuthoring') is True:
            # 相机与机器人投到同一观察帧，避免消费者把不同轮询步的 world pose 拼成假跟随。
            camera_frame = self.camera_list()
            frame['cameras'] = camera_frame['cameras']
            if selection.get('sensors', True):
                for entity in entities:
                    poses = {body['bodyName']: {'bodyName': body['bodyName'], **body['worldFromBody']} for body in camera_frame['bodies']
                             if body['entityId'] == entity['entityId']}
                    if poses:
                        entity.setdefault('sensors', {})['bodyWorldPoses'] = poses
        frame['executionMode'] = 'assisted-teleport' if self.assisted else 'physical-contact'
        frame['assistAdvanceCount'] = self.assist_advances
        frame['initialOverlap'] = {**copy.deepcopy(self.initial_overlap), 'sceneRevision': self.applied_revision}
        if isinstance(selection.get('collisionTopology'),dict):
            from collision_topology import collision_topology
            frame['collisionTopology']=collision_topology(self,selection['collisionTopology'])
        if selection.get('contacts'):
            from static_triangle_surface import contact_side
            contacts = []
            pairs = {}
            for i in range(self.data.ncon):
                contact = self.data.contact[i]
                f = np.zeros(6)
                mj.mj_contactForce(self.model, self.data, i, f)
                geom1, geom2 = int(contact.geom1), int(contact.geom2)
                side1, side2 = contact_side(self.model, contact, 0), contact_side(self.model, contact, 1)
                name1, name2 = side1[2], side2[2]
                contacts.append({'geom1': name1, 'geom2': name2, 'distanceM': float(contact.dist), 'forceN': f[:3].tolist(), 'sourceStep': self.step_index, 'persistent': False})
                if contact.dist < 0:
                    # 穿透（负 dist）按 geom 对聚合取最小 dist：逐帧接触列表只罗列现象，
                    # 聚合后的穿透对才是调用方纠正初始穿模所需的异常信号。
                    identity = (side1[:2], side2[:2])
                    pair = pairs.get(identity)
                    if pair is None:
                        pairs[identity] = {'geom1': name1, 'geom2': name2, 'geom1Id': geom1, 'geom2Id': geom2, **({'flex1Id':side1[1]} if side1[0]=='flex' else {}), **({'flex2Id':side2[1]} if side2[0]=='flex' else {}), 'minDistanceM': float(contact.dist)}
                    else:
                        pair['minDistanceM'] = min(pair['minDistanceM'], float(contact.dist))
            frame['contacts'] = contacts
            # count 是发生穿透的 geom 对数量（无穿透为 0），worst 按 minDistanceM 升序取最严重的若干对。
            frame['penetrations'] = {'count': len(pairs), 'worst': sorted(pairs.values(), key=lambda pair: pair['minDistanceM'])[:8]}
        return frame

    def actuator(self, info, name):
        if name not in info['actuators']:
            raise SimError('INVALID_CONTROL_MAPPING', '模型不存在执行器: ' + name)
        return info['actuators'][name]

    def check_target(self, info, name, value):
        value = finite(value, name)
        j = info['joints'].get(name)
        if not j or not j['actuator']:
            raise SimError('UNSUPPORTED_CAPABILITY', '关节无可用执行器: ' + name)
        if self.model.jnt_limited[j['id']]:
            lo, hi = self.model.jnt_range[j['id']]
            if value < lo - 1e-8 or value > hi + 1e-8:
                raise SimError('OUT_OF_RANGE', name + ' 目标超出关节范围')
        return value

    def wrench_mapping(self, info):
        """把资产 drone 映射解析成体坐标 wrench 的线性映射：每列 = 1 单位 ctrl 产生的合 wrench。

        换算只用源模型本身，并先核对源执行器力律（MuJoCo 3.3.7 实测）：
          · 只支持 mjTRN_SITE 且 site 在该实体根刚体上的执行器；
          · 只支持固定增益（gaintype=fixed）、无状态（dyntype=none）、无偏置（biastype=none）、
            无 plugin、无 refsite 的执行器。此时标量执行器力严格等于 gain×ctrl
            （ctrl 按 ctrlrange 夹取、力按 forcerange 夹取，都是引擎内静默夹取，所以由本函数
            与 prepare_motion 显式核对并拒绝超权限，而不是依赖引擎夹取后把估算当实测）。
        gear[0:3]/gear[3:6] 表达在 **site 局部系**：力施加在 site 点、gear[3:6] 是纯力偶（mj_applyFT 等价
        已实测到 1e-21），因此该实体根刚体坐标系下
            F = R_body_site · gear_force · gain · ctrl
            τ = (R_body_site · gear_torque + site_pos_in_body × (R_body_site · gear_force)) · gain · ctrl
        （力矩参考点=根刚体坐标系原点）。执行器名必须互不相同：重名会让线性解以为有两列却写同一个
        ctrl，命令被静默减半。site 不在该实体根刚体上的映射无法表达统一体 wrench，明确拒绝。

        dyntype≠none（activation dynamics：force 跟 activation 而不是 ctrl）、biastype≠none
        （ctrl=0 仍有偏置力）、gaintype≠fixed（增益依赖 length/velocity 或未知力律）、plugin、
        refsite（MuJoCo actuator.h：refsite 把 site 传递改成“site 相对 refsite 的平移/旋转”量测，
        坐标语义不同）这五类当前无法在既有 neutralize 下保证正确 SI 换算与撤销，明确 UNSUPPORTED，
        不静默按直接力采用，也不改源物理。另外 0 必须同时落在 ctrlrange/forcerange 内，
        否则 ctrl=0 撤不掉推力，停止/完成后的零力没有保证，同样明确拒绝。
        返回 (执行器名序, id 序, 6×n 映射矩阵, 每执行器权限)。
        """
        cfg = info['controller']
        if cfg.get('type') != 'drone':
            raise SimError('MISSING_CONTROL_CONFIG', '该资产没有 drone 推力/力矩映射')
        torque_axes = cfg.get('torqueActuators') or {}
        names = {'thrust': cfg.get('thrustActuator'), 'x': torque_axes.get('x'), 'y': torque_axes.get('y'), 'z': torque_axes.get('z')}
        if not all(isinstance(names[k], str) and names[k] for k in ('thrust', 'x', 'y', 'z')):
            raise SimError('MISSING_CONTROL_CONFIG', 'drone 映射需要 thrustActuator 与 torqueActuators.x/y/z')
        ordered = [names[k] for k in ('thrust', 'x', 'y', 'z')]
        if len(set(ordered)) != len(ordered):
            raise SimError('INVALID_CONTROL_MAPPING', 'drone 映射的 4 个执行器名必须互不相同: ' + str(ordered))
        ids, columns, limits = [], [], []
        for name in ordered:
            actuator = info['actuators'].get(name)
            if not actuator:
                raise SimError('INVALID_CONTROL_MAPPING', '模型不存在执行器: ' + str(name))
            aid = actuator['id']
            if self.model.actuator_trntype[aid] != mj.mjtTrn.mjTRN_SITE:
                raise SimError('INVALID_CONTROL_MAPPING', 'drone 映射执行器必须是源模型的 site 执行器: ' + name)
            if int(self.model.actuator_plugin[aid]) >= 0:
                raise SimError('UNSUPPORTED_CAPABILITY', '执行器 ' + name + ' 使用 plugin 力律，当前通道无法核对 SI 换算与撤销，明确不支持')
            unsupported = []
            gaintype, biastype, dyntype = int(self.model.actuator_gaintype[aid]), int(self.model.actuator_biastype[aid]), int(self.model.actuator_dyntype[aid])
            if gaintype != mj.mjtGain.mjGAIN_FIXED:
                unsupported.append('gaintype=' + enum_name(mj.mjtGain, gaintype))
            if biastype != mj.mjtBias.mjBIAS_NONE:
                unsupported.append('biastype=' + enum_name(mj.mjtBias, biastype) + '（ctrl=0 仍有偏置力）')
            if dyntype != mj.mjtDyn.mjDYN_NONE:
                unsupported.append('dyntype=' + enum_name(mj.mjtDyn, dyntype) + '（force 由 activation 而非 ctrl 驱动）')
            if unsupported:
                raise SimError('UNSUPPORTED_CAPABILITY', '执行器 ' + name + ' 不是固定增益无状态直接力通道：' + '、'.join(unsupported) + '；当前 neutralize 无法保证正确 SI 换算与撤销，明确不支持')
            site_id = int(self.model.actuator_trnid[aid, 0])
            if site_id < 0 or int(self.model.site_bodyid[site_id]) != info['body']:
                raise SimError('UNSUPPORTED_CAPABILITY', '无法表达统一体 wrench：执行器 site 不在该实体根刚体上: ' + name)
            refsite = int(self.model.actuator_trnid[aid, 1])
            if refsite >= 0:
                raise SimError('UNSUPPORTED_CAPABILITY', '执行器 ' + name + ' 指定 refsite=' + self.model.site(refsite).name + '：gear 表达在 refsite 系且按相对位姿量测，transmission 坐标语义与 site 系直接力不同，明确不支持')
            gain = float(self.model.actuator_gainprm[aid, 0])
            if not math.isfinite(gain) or gain == 0:
                raise SimError('INVALID_CONTROL_MAPPING', '执行器 ' + name + ' 的固定增益不是有效非零有限值: ' + repr(gain))
            if self.model.actuator_ctrllimited[aid]:
                lo, hi = (float(v) for v in self.model.actuator_ctrlrange[aid])
                if not lo <= 0 <= hi:
                    raise SimError('UNSUPPORTED_CAPABILITY', '执行器 ' + name + ' 的 ctrlrange 不含 0，停止/完成后 ctrl=0 撤不掉推力，明确不支持')
            else:
                lo = hi = None
            if self.model.actuator_forcelimited[aid]:
                flo, fhi = (float(v) for v in self.model.actuator_forcerange[aid])
                if not flo <= 0 <= fhi:
                    raise SimError('UNSUPPORTED_CAPABILITY', '执行器 ' + name + ' 的 forcerange 不含 0，停止/完成后力回不到零，明确不支持')
            else:
                flo = fhi = None
            rotation = np.zeros(9)
            mj.mju_quat2Mat(rotation, np.asarray(self.model.site_quat[site_id], dtype=float))
            rotation = rotation.reshape(3, 3)
            gear = np.asarray(self.model.actuator_gear[aid, :6], dtype=float)
            force = rotation @ gear[:3]
            torque = rotation @ gear[3:] + np.cross(np.asarray(self.model.site_pos[site_id], dtype=float), force)
            column = gain * np.concatenate([force, torque])
            if not np.any(column):
                raise SimError('INVALID_CONTROL_MAPPING', '执行器 gear 在该实体根刚体上是零 wrench: ' + name)
            ids.append(aid)
            columns.append(column)
            limits.append({'name': name, 'gain': gain, 'ctrlrange': None if lo is None else (lo, hi), 'forcerange': None if flo is None else (flo, fhi)})
        return ordered, ids, np.column_stack(columns), limits

    def prepare_motion(self, motion):
        m = copy.deepcopy(motion)
        info = self.info(m['entityId'])
        kind = m['kind']
        m['_startPositions'] = self.data.xpos[info['body']].copy()
        if kind == 'control':
            if self.clock != 'manual':
                raise SimError('UNSUPPORTED_CAPABILITY', '按物理步采样的 control 需要显式 manual world')
            steps = m.get('stepCount')
            if isinstance(steps, bool) or not isinstance(steps, int) or steps <= 0:
                raise SimError('INVALID_ARGUMENT', 'stepCount 必须是大于0的整数')
            names, values = m.get('jointNames', []), m.get('positions', [])
            if not names or len(names) != len(values) or len(names) != len(set(names)):
                raise SimError('INVALID_ARGUMENT', 'control 关节名须非空唯一，目标向量长度一致')
            controls = []
            for name, value in zip(names, values):
                value = finite(value, name)
                joint = info['joints'].get(name)
                if not joint or not joint['actuator']:
                    raise SimError('UNSUPPORTED_CAPABILITY', '关节无执行器: ' + name)
                actuator = info['actuators'][joint['actuator']]
                aid = actuator['id']
                if actuator['mode'] == 'position':
                    target = value * float(self.model.actuator_gear[aid, 0])
                    if self.model.actuator_ctrllimited[aid] and not self.model.actuator_ctrlrange[aid, 0] <= target <= self.model.actuator_ctrlrange[aid, 1]:
                        raise SimError('OUT_OF_RANGE', '控制参考超出执行器 ctrlrange: ' + name)
                    controls.append({'actuator': aid, 'mode': 'position', 'ctrl': target})
                elif actuator['mode'] == 'torque':
                    # 力矩执行器的 control 参考是**关节位置目标**：由逐关节 PD（jointKp/jointKd，
                    # 缺省标量 kp/kd）在每个物理步折成力矩（见 set_joint）。官方力矩模型因此不必
                    # 先派生 position 变体。ctrlrange 是力矩限不是位置限，故不按它钳制参考。
                    controls.append({'actuator': aid, 'mode': 'torque', 'joint': name, 'target': value})
                else:
                    raise SimError('UNSUPPORTED_CAPABILITY',
                                   'control 需要 position 或 torque 执行器；velocity 执行器请用 trajectory/joint 动作，'
                                   '力矩执行器的 PD 增益由 controller.jointKp/jointKd（或标量 kp/kd）给出: ' + name)
            # PD参考可以超出机械限位；由原模型的关节约束和力矩限幅执行。
            m['_controls'] = controls
            m['_duration'] = m['_end'] = steps * float(self.model.opt.timestep)
        elif kind in ('trajectory', 'joint', 'lift'):
            if kind == 'lift':
                cfg = info['controller'].get('lift')
                if not cfg:
                    raise SimError('MISSING_CONTROL_CONFIG', '资产缺少 lift 映射')
                current = float(self.data.qpos[info['joints'][cfg['joint']]['qpos']])
                duration = positive(m['durationS'], 'durationS')
                if ('positionM' in m) == ('velocityMps' in m):
                    raise SimError('INVALID_ARGUMENT', '升降必须选择绝对 positionM 或显式 velocityMps')
                target = m['positionM'] if 'positionM' in m else current + finite(m['velocityMps'], 'velocityMps') * duration
                if cfg.get('rangeM') and not cfg['rangeM'][0] <= target <= cfg['rangeM'][1]:
                    raise SimError('OUT_OF_RANGE', '升降位置超出资产范围')
                m.update({'jointNames': [cfg['joint']], 'positions': [target], 'tolerance': m.get('tolerance', .015)})
            names = m['jointNames']
            if not names or len(set(names)) != len(names):
                raise SimError('INVALID_ARGUMENT', '关节名称必须非空且唯一')
            if kind == 'trajectory' and set(names) != {n for n, j in info['joints'].items() if j['actuator']}:
                # 显式 opt-in 的部分关节轨迹（`partialJointVector:true`）：未列出的受控关节**保持上一次写入的 ctrl**
                # ——既不归零、也不冻结在实测值（本动作不写它们的 ctrl，MuJoCo 沿用 data.ctrl 的现值），
                # 供"手臂轨迹 + 保持夹持"这类相位动作使用。不置真时契约逐字不变：仍要求精确覆盖全部受控关节。
                if m.get('partialJointVector') is not True or not set(names) <= {n for n, j in info['joints'].items() if j['actuator']}:
                    raise SimError('INCOMPLETE_JOINT_VECTOR', '轨迹须覆盖该机器人全部受控关节；部分关节用 joint 操作（或显式 partialJointVector=true 声明未列出的关节保持上一次 ctrl）')
            start = [float(self.data.qpos[info['joints'][n]['qpos']]) if n in info['joints'] else 0 for n in names]
            points = m['points'] if kind == 'trajectory' else [{'timeS': positive(m['durationS'], 'durationS'), 'positions': m['positions']}]
            last_t = -1
            for point in points:
                t = finite(point['timeS'], 'timeS')
                if t < 0 or t <= last_t or len(point['positions']) != len(names):
                    raise SimError('INVALID_ARGUMENT', '轨迹时点须严格递增且每个向量完整')
                for n, value in zip(names, point['positions']):
                    self.check_target(info, n, value)
                last_t = t
            if not points or last_t <= 0:
                raise SimError('INVALID_ARGUMENT', '轨迹必须包含正时长终点')
            if points[0]['timeS'] > 0:
                points.insert(0, {'timeS': 0, 'positions': start})
            m['_points'] = points
            m['_duration'] = last_t
            m['_end'] = last_t + max(0, finite(m.get('settleTimeS', .3), 'settleTimeS'))
            m['_tolerance'] = positive(m.get('tolerance', .03), 'tolerance')
            if m.get('plan'):
                p = m['plan']
                if p['expectedGeneration'] != self.generation or p['collisionContextVersion'] != str(self.generation) or p['entityId'] != m['entityId']:
                    raise SimError('STALE_PLAN', '计划模型或碰撞上下文已过期')
        elif kind == 'gait':
            if not info.get('gaitLegs'):
                raise SimError('UNSUPPORTED_CAPABILITY','该资产没有适用的四足控制策略')
            if not -1 <= finite(m['forward'],'forward') <= 1 or not -1 <= finite(m.get('turn',0),'turn') <= 1:
                raise SimError('OUT_OF_RANGE','四足步态forward/turn为显式[-1,1]意图')
            m['_duration']=m['_end']=positive(m['durationS'],'durationS')
        elif kind == 'gripper':
            cfg = info['controller'].get('gripper')
            if not cfg:
                raise SimError('MISSING_CONTROL_CONFIG', '夹爪需要 actuator/jointNames/maxWidthM/controlRange 映射')
            self.actuator(info, cfg['actuator'])
            width = finite(m['widthM'], 'widthM')
            if not 0 <= width <= cfg['maxWidthM']:
                raise SimError('OUT_OF_RANGE', '夹爪宽度超范围')
            m['_startWidth'] = sum(float(self.data.qpos[info['joints'][n]['qpos']]) for n in cfg['jointNames'])
            m['_duration'] = positive(m['durationS'], 'durationS')
            m['_end'] = m['_duration'] + max(0, finite(m.get('settleTimeS', .3), 'settleTimeS'))
            m['_tolerance'] = positive(m.get('tolerance', .005), 'tolerance')
        elif kind == 'tendon':
            # 源 tendon 执行器的肌腱坐标位置参考。命令值=源的 Σ coef·q 坐标；写入 ctrl=gear×目标，
            # gain/bias/forcerange 全部来自源执行器（不改增益、不加补偿），ctrlrange 按源校验为硬拒绝。
            names, values = m.get('tendonNames', []), m.get('lengths', [])
            if not names or len(names) != len(values) or len(names) != len(set(names)):
                raise SimError('INVALID_ARGUMENT', 'tendon 名须非空唯一，且与 lengths 长度一致')
            controls = []
            for name, value in zip(names, values):
                value = finite(value, name)
                matches = [t for t in info['tendons'] if t['name'] == name]
                if not matches:
                    if name in info['joints']:
                        raise SimError('INVALID_ARGUMENT', 'tendon 通道不接受关节名（关节请用 joint/trajectory 动作）: ' + name)
                    raise SimError('INVALID_ARGUMENT', '该实体不存在这个肌腱: ' + name)
                if len(matches) > 1:
                    raise SimError('UNSUPPORTED_CAPABILITY', '该肌腱由多个执行器驱动，肌腱坐标命令有歧义: ' + name)
                t = matches[0]
                if t['external']:
                    raise SimError('UNSUPPORTED_CAPABILITY', '该执行器驱动的肌腱不属于本实体，不能用本实体的肌腱坐标寻址: ' + name)
                if not t['positionReference']:
                    # 自定义力律（motor、gain/bias 不匹配、带 dyntype 状态等）不能按坐标参考解释，
                    # 即使旧启发式（biasprm[1]<0）会称 position 也不得冒充。
                    raise SimError('UNSUPPORTED_CAPABILITY',
                                   '源执行器未通过固定位置力律核对（需 dyntype=none、gaintype=fixed、biastype=affine、'
                                   'gainprm[0]==-biasprm[1]、biasprm[0]==0；旧启发式判定为 ' + t['heuristicMode'] + '），'
                                   '本通道不能把它当坐标位置参考: ' + name)
                if not t['gear']:
                    raise SimError('INVALID_CONTROL_MAPPING', '源执行器 gear 为 0，肌腱坐标无法换算成 ctrl: ' + name)
                ctrl = value * t['gear']
                if t['ctrlRange'] and not t['ctrlRange'][0] <= ctrl <= t['ctrlRange'][1]:
                    raise SimError('OUT_OF_RANGE', '肌腱目标超出源执行器 ctrlrange: ' + name)
                # 参考从当前实测肌腱坐标出发，避免起始跳变；插值终点是命令坐标。
                controls.append({'name': name, 'actuatorId': t['actuatorId'], 'tendonId': t['id'], 'gear': t['gear'],
                                 'ctrlRange': t['ctrlRange'], 'start': float(self.data.ten_length[t['id']]), 'target': value})
            m['_tendonControls'] = controls
            m['_duration'] = positive(m['durationS'], 'durationS')
            m['_end'] = m['_duration'] + max(0, finite(m.get('settleTimeS', .3), 'settleTimeS'))
            m['_tolerance'] = positive(m.get('tolerance', .03), 'tolerance')
        elif kind == 'vehicle':
            cfg = info['controller']
            if cfg.get('type') != 'vehicle' or not cfg.get('wheels'):
                raise SimError('MISSING_CONTROL_CONFIG', '资产必须提供车轮执行器、轮径和驱动配置')
            for wheel in cfg['wheels']:
                positive(wheel['radiusM'], 'radiusM')
                a = self.actuator(info, wheel['actuator'])
                if a['mode'] != 'velocity':
                    raise SimError('UNSUPPORTED_CAPABILITY', '当前轮速控制要求 velocity actuator: ' + wheel['actuator'])
            if 'steeringAngleRad' in m and 'yawRateRadps' in m:
                raise SimError('INVALID_ARGUMENT', '转向角与差速角速度只能选一个')
            m['speedMps'] = finite(m['speedMps'], 'speedMps')
            if cfg.get('steering'):
                positive(cfg.get('wheelbaseM'), 'wheelbaseM')
                angle = finite(m.get('steeringAngleRad', 0), 'steeringAngleRad')
                limits = cfg['steering'].get('rangeRad', [-.55, .55])
                if not limits[0] <= angle <= limits[1]:
                    raise SimError('OUT_OF_RANGE', '虚拟前轴转角超范围')
                if 'yawRateRadps' in m:
                    raise SimError('INVALID_ARGUMENT', '转向轴车辆使用 steeringAngleRad')
                for a in cfg['steering']['actuators']:
                    self.actuator(info, a)
            else:
                positive(cfg.get('trackWidthM'), 'trackWidthM')
                finite(m.get('yawRateRadps', 0), 'yawRateRadps')
                if 'steeringAngleRad' in m:
                    raise SimError('INVALID_ARGUMENT', '差速车辆使用 yawRateRadps')
            m['_duration'] = m['_end'] = positive(m['durationS'], 'durationS')
        elif kind == 'thrust':
            # 资产声明的体坐标 wrench（SI：N / N·m）。时长二选一先校验；单位比例/方向/上下限全部来自
            # 源执行器力律（固定增益×site/gear）+ ctrlrange/forcerange，见 wrench_mapping。
            if ('durationS' in m) == ('stepCount' in m):
                raise SimError('INVALID_ARGUMENT', 'thrust 必须二选一：durationS 或 stepCount')
            names, actuator_ids, matrix, limits = self.wrench_mapping(info)
            torque = m.get('torqueNm', [0.0, 0.0, 0.0])
            if not isinstance(torque, list) or len(torque) != 3:
                raise SimError('INVALID_ARGUMENT', 'torqueNm 必须是长度3的数组')
            wrench = np.array([0.0, 0.0, finite(m.get('thrustN'), 'thrustN'), *[finite(v, 'torqueNm') for v in torque]], dtype=float)
            ctrl, *_ = np.linalg.lstsq(matrix, wrench, rcond=None)
            # 只有能精确复现请求 wrench 的映射才可用；否则该资产表达不了这条命令，明确拒绝而不静默近似。
            if not np.allclose(matrix @ ctrl, wrench, atol=1e-9 * max(1.0, float(np.max(np.abs(wrench)))), rtol=0):
                raise SimError('UNSUPPORTED_CAPABILITY', '该映射无法精确表达请求的体坐标 wrench: ' + m['entityId'])
            controls, forces = [], {}
            for name, value, limit in zip(names, ctrl, limits):
                aid = info['actuators'][name]['id']
                # ctrlrange 是源控制权限（闭区间）：真正超权限必须明确拒绝，不能依赖 MuJoCo 静默夹取，
                # 否则回执的模型映射估算会与真实施力不符。线性解最后 1 ulp 的噪声（轮换 site 后列向量
                # 含 0.7071067811865476 这类不可精确表示的值）按相对护栏接受并夹回闭区间，写入值绝不越权。
                if limit['ctrlrange'] is not None:
                    lo, hi = limit['ctrlrange']
                    guard = 1e-12 * max(1.0, abs(lo), abs(hi), abs(value))
                    if not lo - guard <= value <= hi + guard:
                        raise SimError('OUT_OF_RANGE', '命令 wrench 超出源执行器 ctrlrange: ' + name)
                    value = float(min(max(value, lo), hi))
                # forcerange 是源执行器标量力权限（force = gain×ctrl），同样显式核对、闭区间 + 1 ulp 护栏。
                force = limit['gain'] * value
                if limit['forcerange'] is not None:
                    flo, fhi = limit['forcerange']
                    guard = 1e-12 * max(1.0, abs(flo), abs(fhi), abs(force))
                    if not flo - guard <= force <= fhi + guard:
                        raise SimError('OUT_OF_RANGE', '命令 wrench 超出源执行器 forcerange: ' + name)
                    force = float(min(max(force, flo), fhi))
                controls.append((aid, value))
                forces[name] = force
            m['_wrenchNames'], m['_actuatorIds'], m['_wrenchMatrix'], m['_actuatorControls'] = names, actuator_ids, matrix, controls
            m['_actuatorForces'] = forces
            dt = float(self.model.opt.timestep)
            if 'stepCount' in m:
                if self.clock != 'manual':
                    raise SimError('UNSUPPORTED_CAPABILITY', '按物理步采样的 thrust 需要显式 manual world')
                steps = m['stepCount']
                if isinstance(steps, bool) or not isinstance(steps, int) or steps <= 0:
                    raise SimError('INVALID_ARGUMENT', 'stepCount 必须是大于0的整数')
                m['_steps'] = steps
                m['_timingMode'] = 'stepCount'
            else:
                # durationS 量化规则：步数 = max(1, round(durationS/dt))；实际时长 = 步数×dt。
                m['_steps'] = max(1, int(round(positive(m['durationS'], 'durationS') / dt)))
                m['_timingMode'] = 'durationS'
            # _end 只用于和同 batch 其他定时动作比较完成时刻；推力窗口本身按整数步驱动/终结。
            m['_duration'] = m['_end'] = m['_steps'] * dt
            m['_drivenSteps'] = 0
        else:
            raise SimError('UNSUPPORTED_ACTION', '不支持的动作: ' + str(kind))
        return m

    def execute(self, action):
        self.require_ready()
        aid = action['actionId']
        request = json.dumps(action, sort_keys=True, separators=(',', ':'))
        if aid in self.receipts:
            if self.requests[aid] != request:
                raise SimError('ACTION_ID_CONFLICT', '相同 actionId 不得改变请求')
            return self.receipts[aid]
        if action['expectedGeneration'] != self.generation:
            raise SimError('STALE_GENERATION', '直接动作请求的模型代次已过期')
        if self.clock == 'manual' and self.active:
            raise SimError('WORLD_BUSY', '手动世界由一个有界动作或同步batch持有时钟')
        motions = action['motions'] if action['kind'] == 'batch' else [action]
        if not motions or len({m['entityId'] for m in motions}) != len(motions):
            raise SimError('INVALID_ARGUMENT', 'batch 的实体必须非空且不重复')
        occupied = {m['entityId'] for a in self.active.values() for m in a['motions']}
        if any(m['entityId'] in occupied for m in motions):
            raise SimError('ENTITY_BUSY', '目标实体已有活动或已排队动作')
        prepared = [self.prepare_motion(m) for m in motions]
        # 载荷事实基线：动作开始前记录全部已加载实体的实测世界位置；finish 只在此基础上报真实位移，
        # 不为没有基线（排队中未开始）的动作编造起点。
        for motion in prepared:
            motion['_payloadStart'] = self.entity_positions()
            motion['_payloadHistory'] = {}
        controls = [m for m in prepared if m['kind'] == 'control']
        if controls and (len(controls) != len(prepared) or len({m['stepCount'] for m in controls}) != 1):
            raise SimError('INVALID_ARGUMENT', 'control batch 各成员须使用相同 stepCount，不混入定时轨迹')
        start = action.get('startStep', self.step_index + 1)
        if not isinstance(start, int) or start <= self.step_index:
            raise SimError('INVALID_START_STEP', 'startStep 必须在未来')
        if controls and start != self.step_index + 1:
            raise SimError('INVALID_START_STEP', 'control 从下一物理步开始，不隐式推进空白步骤')
        receipt = {'actionId': aid, 'worldId': self.id, 'generation': self.generation, 'status': 'accepted'}
        self.requests[aid], self.receipts[aid] = request, receipt
        # windowSteps = 本动作在自己窗口内真实驱动过的物理步数（在 tick 里随每次成功推进递增）。
        # 定时动作的窗口与插值进度都以它为准，不再以 data.time 之差为准：引擎自动重置时钟时
        # data.time 会归零（见 tick 的自动重置检测），按它算的窗口永远到不了终点。
        self.active[aid] = {'expectedGeneration': action['expectedGeneration'], 'motions': prepared, 'start': start, 'startTime': None, 'windowSteps': 0}
        for motion in prepared:
            self.control_owners[motion['entityId']] = aid
        if controls:
            self.active[aid]['endStep'] = start + controls[0]['stepCount'] - 1
        # thrust 一律按整数步窗口驱动（复用 control 的 endStep 机制）：每个 thrust 自己记最后一步，
        # 全 thrust 的动作按最长窗口整数步终结；短推力在 apply_motion 里精确截止，不被长动作拖长。
        for motion in prepared:
            if motion['kind'] == 'thrust':
                motion['_lastStep'] = start + motion['_steps'] - 1
        if all(m['kind'] == 'thrust' for m in prepared):
            self.active[aid]['endStep'] = start + max(m['_steps'] for m in prepared) - 1
        return copy.deepcopy(receipt)

    def set_joint(self, info, name, target, dt):
        j = info['joints'][name]
        a = info['actuators'][j['actuator']]
        q, v = float(self.data.qpos[j['qpos']]), float(self.data.qvel[j['dof']])
        cfg = info['controller']
        if a['mode'] == 'position':
            ctrl = target
            lift = cfg.get('lift', {})
            if lift.get('joint') == name:
                ctrl += lift.get('gravityCompensationM', 0)
        elif a['mode'] == 'velocity':
            ctrl = (target - q) * cfg.get('positionVelocityGain', 8)
        else:
            info['heldTargets'][name]=target
            # 复用原控制器的位置/速度反馈及重力补偿语义；控制只写目标，不私自 step。
            # 逐关节增益（controller.jointKp/jointKd）优先，缺该关节回落标量 kp/kd（默认 120/4）。
            kp = joint_gain(cfg, 'jointKp', name, 'kp', 120)
            kd = joint_gain(cfg, 'jointKd', name, 'kd', 4)
            ctrl = (target - q) * kp - v * kd + (self.data.qfrc_bias[j['dof']] if cfg.get('gravityCompensation', cfg.get('type') != 'quadruped') else 0)
        if self.model.actuator_ctrllimited[a['id']]:
            ctrl = float(np.clip(ctrl, *self.model.actuator_ctrlrange[a['id']]))
        self.data.ctrl[a['id']] = ctrl

    def apply_motion(self, m, elapsed):
        info = self.info(m['entityId'])
        if m['kind'] == 'control':
            for entry in m['_controls']:
                if entry['mode'] == 'position':
                    self.data.ctrl[entry['actuator']] = entry['ctrl']
                else:
                    # 力矩执行器：每个物理步按逐关节 PD 把位置目标折成力矩（含源 ctrlrange 钳制）。
                    self.set_joint(info, entry['joint'], entry['target'], self.model.opt.timestep)
        elif m['kind'] == 'gait':
            cfg=info['controller'].get('gait',{})
            for name,target in gait.targets(info['gaitLegs'],elapsed,m['forward'],m.get('turn',0),cfg.get('frequencyHz',1.8),cfg.get('strideM',.12),cfg.get('liftM',.05)).items():
                self.set_joint(info,name,target,self.model.opt.timestep)
        elif m['kind'] == 'gripper':
            cfg = info['controller']['gripper']
            ratio = max(0, min(1, elapsed / m['_duration']))
            width = m['_startWidth'] + (m['widthM'] - m['_startWidth']) * ratio
            lo, hi = cfg.get('controlRange', [0, cfg['maxWidthM']])
            self.data.ctrl[self.actuator(info, cfg['actuator'])['id']] = lo + width / cfg['maxWidthM'] * (hi - lo)
        elif m['kind'] == 'vehicle':
            cfg = info['controller']
            # 动作结束后必须撤销轮速/差速角速度目标。之前只把 speed 置零，
            # 但在差速底盘上仍保留 yawRateRadps，导致 vehicle action 已完成后
            # 轮子继续反向旋转，世界在后台持续转动。车辆动作的持续时间是
            # 控制目标的生命周期；结束后保持中性控制，不能隐式继续驱动。
            active = elapsed < m['_duration']
            speed = m['speedMps'] if active else 0
            steering = cfg.get('steering')
            yaw = m.get('yawRateRadps', 0) if active else 0
            if steering:
                angle = m.get('steeringAngleRad', 0) if active else 0
                actual = angle * (-1 if steering.get('axle') == 'rear' else 1) * steering.get('sign', 1)
                for name in steering['actuators']:
                    self.data.ctrl[self.actuator(info, name)['id']] = actual
                yaw = speed * math.tan(angle) / cfg['wheelbaseM'] if active else 0
            for wheel in cfg['wheels']:
                side = -1 if wheel.get('side') == 'left' else 1
                linear = speed + side * yaw * cfg.get('trackWidthM', 0) / 2
                target = linear / wheel['radiusM'] * wheel.get('driveSign', 1)
                a = self.actuator(info, wheel['actuator'])
                if self.model.actuator_ctrllimited[a['id']]:
                    if not self.model.actuator_ctrlrange[a['id'], 0] <= target <= self.model.actuator_ctrlrange[a['id'], 1]:
                        raise SimError('OUT_OF_RANGE', 'SI 速度超出轮速执行器范围')
                self.data.ctrl[a['id']] = target
        elif m['kind'] == 'thrust':
            # 本 tick 驱动的是第 self.step_index+1 个物理步；窗口 [start, _lastStep] 内每步都写命令值
            # （无零推力孔），窗口外写 0（短推力不被同 batch 的长动作拖长，也不留残余推力）。
            # 这里只写 ctrl 并登记待测步号；实测力必须等这一步真的积分完成，在 tick 里与步号同处记录
            # （短窗口在 batch 末已写 0，finish 时再读 data.actuator_force 会读到别的步的值）。
            driven = self.step_index + 1 <= m['_lastStep']
            for aid, value in m['_actuatorControls']:
                self.data.ctrl[aid] = value if driven else 0.0
            if driven:
                m['_pendingMeasuredStep'] = self.step_index + 1
                m['_ctrlApplied'] = {name: float(value) for name, (_, value) in zip(m['_wrenchNames'], m['_actuatorControls'])}
        elif m['kind'] == 'tendon':
            # 参考在肌腱坐标上从实测起点线性走到目标；每步换算 ctrl=gear×坐标，并按源 ctrlrange 取闭区间。
            ratio = max(0, min(1, elapsed / m['_duration']))
            for c in m['_tendonControls']:
                ctrl = (c['start'] + (c['target'] - c['start']) * ratio) * c['gear']
                if c['ctrlRange']:
                    ctrl = min(max(ctrl, c['ctrlRange'][0]), c['ctrlRange'][1])
                self.data.ctrl[c['actuatorId']] = ctrl
                # 回执只报告真实写过的控制：每次真实写入都记下最后值与写入次数。
                # 终点计划值（gear×目标）不能冒充实际控制——取消/停止时两者不同。
                c['lastCtrl'] = ctrl
                c['appliedSteps'] = c.get('appliedSteps', 0) + 1
        else:
            points = m['_points']
            target = points[-1]['positions']
            for left, right in zip(points, points[1:]):
                if elapsed <= right['timeS']:
                    ratio = max(0, min(1, (elapsed - left['timeS']) / (right['timeS'] - left['timeS'])))
                    target = [x + (y - x) * ratio for x, y in zip(left['positions'], right['positions'])]
                    break
            for name, value in zip(m['jointNames'], target):
                self.set_joint(info, name, value, self.model.opt.timestep)

    def neutralize(self, eid):
        if self.model is None:
            return
        info = self.entities.get(eid)
        if not info:
            return
        for name, a in info['actuators'].items():
            j = info['joints'].get(a['joint'])
            tendon = info['tendonByActuator'].get(name)
            if a['mode'] == 'position' and j:
                self.data.ctrl[a['id']] = self.data.qpos[j['qpos']]
            elif tendon and not tendon['external'] and tendon['positionReference'] and tendon['gear']:
                # 核对过的位置伺服：中性参考=当前实测肌腱坐标×gear（平衡坐标=ctrl/gear，等价于保持在实测坐标）。
                # 停止/关闭保持现在的闭合，不把肌腱写 0 反向张开；未核对的自定义力律不按位置解释，走下面的中性分支。
                ctrl = float(self.data.ten_length[tendon['id']]) * tendon['gear']
                if self.model.actuator_ctrllimited[a['id']]:
                    ctrl = float(np.clip(ctrl, *self.model.actuator_ctrlrange[a['id']]))
                self.data.ctrl[a['id']] = ctrl
            else:
                self.data.ctrl[a['id']] = 0
                if j and a['mode']=='torque':info['heldTargets'][a['joint']]=float(self.data.qpos[j['qpos']])
        gripper = info['controller'].get('gripper')
        if gripper:
            width = sum(float(self.data.qpos[info['joints'][n]['qpos']]) for n in gripper['jointNames'])
            lo, hi = gripper.get('controlRange', [0, gripper['maxWidthM']])
            self.data.ctrl[self.actuator(info, gripper['actuator'])['id']] = lo + width / gripper['maxWidthM'] * (hi - lo)

    def entity_of_geom(self, name):
        """geom 名 → 实体 ID。实体前缀由 MjSpec.attach 写入，而实体 ID 自身可能含分隔符，
        因此按已登记的实体前缀取最长匹配，不切分字符串猜实体，也不猜世界 geom 归属。"""
        if not name:
            return None
        matched = None
        for eid, info in self.entities.items():
            prefix = info['prefix']
            if name.startswith(prefix) and (matched is None or len(prefix) > len(self.entities[matched]['prefix'])):
                matched = eid
        return matched

    def entity_positions(self):
        """全部已加载实体的实测世界位置快照（动作窗口基线与逐步采样共用）。"""
        return {eid: np.asarray(self.data.xpos[info['body']], dtype=float).copy() for eid, info in self.entities.items()}

    def initial_overlap_diagnostic(self):
        from initial_overlap import initial_overlap
        return initial_overlap(self)

    def contact_summary(self, actor):
        """本物理步的真实接触，按"被接触对象"聚合：只统计 actor 实体 geom ↔ 其他实体 geom 的接触对。
        接触来自引擎 data.contact，力来自 mj_contactForce；不推断抓取、不判定任务成功。"""
        summary = {}
        from static_triangle_surface import contact_side
        if self.data is None:
            return summary
        for i in range(self.data.ncon):
            contact = self.data.contact[i]
            first = self.entity_of_geom(contact_side(self.model, contact, 0)[2])
            second = self.entity_of_geom(contact_side(self.model, contact, 1)[2])
            if first == actor:
                other = second
            elif second == actor:
                other = first
            else:
                continue
            if other is None or other == actor:
                continue
            force = np.zeros(6)
            mj.mj_contactForce(self.model, self.data, i, force)
            entry = summary.setdefault(other, {'contactCount': 0, 'maxContactForceN': 0.0})
            entry['contactCount'] += 1
            entry['maxContactForceN'] = max(entry['maxContactForceN'], float(np.linalg.norm(force[:3])))
        return summary

    def sample_payload(self, motion):
        """逐物理步采样载荷事实：接触步数与该对象相对动作起点的最大抬升。
        只累计已开始的动作用户可见窗口，未开始的排队动作不提前采样。"""
        start = motion.get('_payloadStart')
        if start is None:
            return
        history = motion.setdefault('_payloadHistory', {})
        for eid, entry in self.contact_summary(motion['entityId']).items():
            record = history.setdefault(eid, {'contactSteps': 0, 'maxLiftM': None})
            record['contactSteps'] += 1
            origin = start.get(eid)
            if origin is None or eid not in self.entities:
                continue
            lift = float(np.asarray(self.data.xpos[self.entities[eid]['body']], dtype=float)[2] - origin[2])
            record['maxLiftM'] = lift if record['maxLiftM'] is None else max(record['maxLiftM'], lift)

    def motion_payload(self, motion):
        """动作窗口内真实发生的接触/位移事实。全部为实测：接触与力来自引擎，位移来自窗口起止实测位置差。
        故意不给出 EMPTY/WEAK/SLIP/SUCCESS 之类判定，也不设阈值——那属于消费方的任务语义。"""
        start = motion.get('_payloadStart')
        if start is None or len(self.entities) < 2:
            return None
        actor = motion['entityId']
        contacts = self.contact_summary(actor)
        attached = sorted(contacts)
        history = motion.get('_payloadHistory') or {}
        objects = []
        for eid in sorted(history):
            if eid not in self.entities or eid == actor:
                continue
            record = history[eid]
            origin = start.get(eid)
            position = np.asarray(self.data.xpos[self.entities[eid]['body']], dtype=float)
            displacement = position - origin if origin is not None else None
            objects.append({'objectId': eid, 'contactSteps': record['contactSteps'], 'maxLiftM': record['maxLiftM'],
                            'startPositionM': origin.tolist() if origin is not None else None,
                            'endPositionM': position.tolist(),
                            'displacementM': displacement.tolist() if displacement is not None else None,
                            'liftM': float(displacement[2]) if displacement is not None else None})
        return {'observedAtStep': self.step_index, 'actorEntityId': actor,
                'contacts': [{'objectId': eid, **contacts[eid]} for eid in attached],
                'objects': objects,
                # 结束时仍接触 = 夹持事实；窗口内曾接触、结束时已脱离 = 脱手/滑落事实。
                'attachedObjectIds': attached,
                'lostContactObjectIds': sorted(eid for eid in history if eid not in contacts),
                'basis': '接触与法向力来自引擎 data.contact/mj_contactForce（按实体前缀归属）；位移/maxLiftM 为动作窗口起止实测实体根刚体位置差；不含任务成功判定'}

    def finish(self, aid, status, reason=None, facts=None):
        active = self.active.pop(aid)
        receipt = self.receipts[aid]
        receipt.update({'status': status, 'endStep': self.step_index})
        if reason:
            receipt['reason'] = reason
        if facts:
            receipt.update(facts)
        effects = []
        if self.model is not None:
            for motion in active['motions']:
                info = self.info(motion['entityId'])
                displacement = (self.data.xpos[info['body']] - motion['_startPositions']).tolist()
                effect = {'entityId': motion['entityId'], 'kind': motion['kind'], 'displacementM': displacement}
                if motion['kind'] == 'thrust':
                    # 回执分开报告四类事实，不把估算标成实测，也不据此宣称悬停/航点等任务成功：
                    #   requestedWrench            请求（SI 体坐标语义）
                    #   ctrlPlanned / ctrlApplied  计划控制值 / 窗口内真实写入过的控制原值（从未驱动时为 null）
                    #   mappedActuatorForce / wrenchPerDrivenStep  模型映射估算（源增益×site/gear，非测量）
                    #   measuredActuatorForce      真实测得：与 measuredAtStep 同一物理步（积分完成时）的记录
                    ctrl_written = np.asarray([value for _, value in motion['_actuatorControls']], dtype=float)
                    applied = motion['_wrenchMatrix'] @ ctrl_written
                    requested = np.asarray([0.0, 0.0, motion['thrustN'], *list(motion.get('torqueNm', [0.0, 0.0, 0.0]))], dtype=float)
                    effect.update({'requestedWrench': {'forceN': requested[:3].tolist(), 'torqueNm': requested[3:].tolist(),
                                                       'frame': '实体根刚体坐标系：推力沿+z，力矩绕x/y/z（参考点=刚体坐标系原点）'},
                                   'ctrlPlanned': {name: float(value) for name, value in zip(motion['_wrenchNames'], ctrl_written)},
                                   'ctrlApplied': motion.get('_ctrlApplied'),
                                   'mappedActuatorForce': dict(motion['_actuatorForces']),
                                   'wrenchPerDrivenStep': {'forceN': applied[:3].tolist(), 'torqueNm': applied[3:].tolist(),
                                                           'kind': 'model-mapping estimate',
                                                           'basis': '源执行器固定增益×site/gear 映射换算自计划控制值；prepare 已校验精确表达请求，非传感器实测',
                                                           'maxAbsDeltaFromRequest': float(np.max(np.abs(applied - requested)))},
                                   'measuredActuatorForce': motion.get('_measuredActuatorForce'),
                                   'measuredActuatorForceNote': '实测：与 measuredAtStep 同一物理步（该步真实积分完成时）读取的执行器标量力；本动作窗口从未驱动时为 null',
                                   'measuredAtStep': motion.get('_measuredAtStep'),
                                   'timingMode': motion['_timingMode'], 'actuatorSteps': motion['_steps'], 'durationS': motion['_duration'],
                                   'quantizationRule': 'durationS→max(1, round(durationS/dt))步；stepCount→显式整数步；实际时长=步数×dt',
                                   'drivenSteps': motion['_drivenSteps'], 'lastDrivenStep': motion.get('_lastDrivenStep'),
                                   # 零推力保证是支持范围（无状态固定增益、无bias/dyn/plugin/refsite、0∈ctrlrange/forcerange）的
                                   # 结论，不是对任意 source actuator 的承诺；完成/停止/关闭都调用 neutralize 写 ctrl=0。
                                   'zeroForceAfterWindow': {'guaranteed': True, 'ctrlZeroed': True,
                                                            'basis': '支持范围内 ctrl=0 ⇒ 执行器力严格为0（无bias、无activation、无plugin/refsite）；完成/停止/关闭均经 neutralize 写0'},
                                   'rootBody': self.model.body(info['body']).name, 'freeBase': self.free_joint_state(info)})
                    # 完成即撤销推力：与 stop/close 走同一个 neutralize，不声称自动悬停；保持由外部控制器继续输出。
                    self.neutralize(motion['entityId'])
                elif motion['kind'] == 'control':
                    effect.update({'controlMode': 'position-reference', 'stepCount': motion['stepCount'], 'stepsExecuted': max(0, self.step_index - receipt.get('startStep', self.step_index + 1) + 1), 'jointNames': motion['jointNames'], 'referencePositions': motion['positions']})
                elif motion['kind'] == 'vehicle':
                    effect['wheelVelocitiesRadps'] = {a['joint']: float(self.data.qvel[info['joints'][a['joint']]['dof']]) for a in info['actuators'].values() if a['mode'] == 'velocity' and a['joint'] in info['joints']}
                    effect['commandedSpeedMps'] = motion['speedMps']
                    # 仅报告实测，不把轮速响应认作导航或任务成功。
                    self.apply_motion(motion, motion['_duration'])
                elif motion['kind'] == 'gait':
                    effect.update({'controller':'planar-diagonal-trot','baseHeightM':float(self.data.xpos[info['body'],2]),'stableWalkingNotGuaranteed':True})
                    for name,target in gait.targets(info['gaitLegs'],0,0,0).items():self.set_joint(info,name,target,self.model.opt.timestep)
                elif motion['kind'] == 'gripper':
                    cfg = info['controller']['gripper']
                    width = sum(float(self.data.qpos[info['joints'][n]['qpos']]) for n in cfg['jointNames'])
                    effect.update({'actualWidthM': width, 'targetWidthM': motion['widthM'], 'targetReached': abs(width - motion['widthM']) <= motion['_tolerance']})
                elif motion['kind'] == 'tendon':
                    # 回执必须区分三类值，不能把终点计划值冒充实际控制：
                    #  - targetLengths   请求目标（命令坐标，未被施加或只走了一部分的都按请求如实保留）
                    #  - ctrlApplied     本动作最后真实写入源 ctrl 的值；取消/停止时是插值中途的真实值，
                    #                    从未开始过的动作没有任何写入，必须是 null（不能称目标曾施加）
                    #  - holdReference   停止后的保持参考：neutralize 写回引擎的实际 ctrl 与换算坐标
                    # 只报告真实写过的控制/实测肌腱坐标；闭合只按坐标容差判定，不代表抓取成功。
                    started = active['startTime'] is not None
                    applied_steps = max([c.get('appliedSteps', 0) for c in motion['_tendonControls']] + [0])
                    last_ctrl = {c['name']: c['lastCtrl'] for c in motion['_tendonControls'] if 'lastCtrl' in c}
                    last_lengths = {c['name']: c['lastCtrl'] / c['gear'] for c in motion['_tendonControls'] if 'lastCtrl' in c}
                    measured = {c['name']: float(self.data.ten_length[c['tendonId']]) for c in motion['_tendonControls']}
                    errors = {c['name']: measured[c['name']] - c['target'] for c in motion['_tendonControls']}
                    hold = None
                    if status != 'completed':
                        # 先写中性参考，再从引擎 ctrl 读回：回执给的是真实存在的保持控制，不是计划值。
                        self.neutralize(motion['entityId'])
                        motion['_neutralized'] = True
                        hold = {'ctrl': {}, 'lengths': {}}
                        for c in motion['_tendonControls']:
                            value = float(self.data.ctrl[c['actuatorId']])
                            hold['ctrl'][c['name']] = value
                            hold['lengths'][c['name']] = value / c['gear'] if c['gear'] else None
                    effect.update({'tendonNames': [c['name'] for c in motion['_tendonControls']],
                                   'targetLengths': {c['name']: c['target'] for c in motion['_tendonControls']},
                                   'started': started, 'appliedSteps': applied_steps,
                                   'ctrlApplied': last_ctrl or None, 'lastAppliedLengths': last_lengths or None,
                                   'holdReference': hold,
                                   'measuredLengths': measured, 'tendonErrors': errors,
                                   # 未开始/从未写入的动作不能报 targetReached，即使当前坐标巧合落在容差内。
                                   'targetReached': bool(started and applied_steps
                                                         and max(map(abs, errors.values())) <= motion['_tolerance']),
                                   'tolerance': motion['_tolerance'],
                                   'gear': {c['name']: c['gear'] for c in motion['_tendonControls']}})
                else:
                    errors = [float(self.data.qpos[info['joints'][n]['qpos']]) - target for n, target in zip(motion['jointNames'], motion['_points'][-1]['positions'])]
                    effect.update({'jointErrors': errors, 'targetReached': max(map(abs, errors)) <= motion['_tolerance'], 'tolerance': motion['_tolerance']})
                effects.append(effect)
                payload = self.motion_payload(motion)
                if payload is not None:
                    effect['payload'] = payload
                    motion.pop('_payloadHistory', None)
                if status != 'completed' and not motion.get('_neutralized'):
                    self.neutralize(motion['entityId'])
            receipt['finalState'] = self.observe({'entityIds': [m['entityId'] for m in active['motions']], 'contacts': True})
        # 完成回执必须覆盖本动作窗口内真实发生过的辅助：只按结束瞬间的 map 快照会把已解除的辅助从回执上抹掉。
        receipt['effect'] = {'motions': effects, 'childrenStartSteps': {m['entityId']: receipt.get('startStep') for m in active['motions']}, 'executionMode': 'assisted-teleport' if self.assisted or active.get('assistedTicks') else 'physical-contact'}
        if status != 'completed':
            receipt['taskAchieved'] = False
        emit({'event': 'receipt', 'receipt': receipt})

    def stop(self, selection):
        if selection.get('expectedGeneration') is not None and selection['expectedGeneration'] != self.generation:
            raise SimError('STALE_GENERATION', '停止请求属于旧模型代次，不触碰新代次控制')
        action_id = selection.get('actionId')
        if action_id and action_id not in self.receipts:
            raise SimError('ACTION_NOT_FOUND', '停止请求的动作不存在')
        selected = set(selection.get('entityIds', self.entities))
        affected = {eid for eid in selected if not action_id or self.control_owners.get(eid) == action_id}
        stopped = []
        for aid, active in list(self.active.items()):
            if selection.get('actionId') and aid != selection['actionId']:
                continue
            if selection.get('entityIds') and not any(m['entityId'] in selection['entityIds'] for m in active['motions']):
                continue
            affected.update(m['entityId'] for m in active['motions'])
            self.finish(aid, 'cancelled', 'STOP_CONFIRMED')
            stopped.append(copy.deepcopy(self.receipts[aid]))
        for eid in affected:
            self.neutralize(eid)
            self.control_owners.pop(eid, None)
        if self.status in ('ready', 'running'):
            self.status = 'running' if self.active else 'ready'
        return {'stopped': True, 'stepIndex': self.step_index, 'receipts': stopped, 'affectedEntityIds': sorted(affected)}

    def refresh_derived(self):
        """把引擎派生量（xpos/xquat、ten_length/ten_velocity、actuator_force、sensordata…）对齐到当前积分状态。

        mj_step 的 forward 发生在积分之前，因此步后 data.ten_length/ten_velocity 等仍是上一物理步的缓存
        （realtime 曾因只在 manual 下刷新而读到错帧）。mj_forward 只按当前 qpos/qvel/act 重算派生量，
        不推进物理钟（time/qpos/qvel/ctrl/step_index 均不变），故每个 tick 在 mj_step 后统一刷新一次，
        不必在 observe/finish/neutralize/prepare 等每个读取点重复重算。
        """
        mj.mj_forward(self.model, self.data)

    def clock_advanced(self, time_before, dt):
        """mj_step 是否把物理钟推进了恰好一个 dt，且状态仍是有限值。

        mj_step 正常情况下必然推进 opt.timestep；被引擎自动重置（mj_resetData）时 time 归零，即"退步或原地"。
        非有限 qpos/qvel 同属引擎判定状态损坏这一类事实，一并当作不可继续驱动的信号。
        """
        if float(self.data.time) < time_before + dt * (1 - 1e-9):
            return False
        return bool(np.isfinite(self.data.qpos).all()) and bool(np.isfinite(self.data.qvel).all())

    def instability_evidence(self):
        """重置前一刻的实测加速度极值：真实取自引擎 data.qacc，用于说明是哪根自由度的量在发散。

        字段 `maxAbsQacc` 按名字给**非负幅值**（按绝对值的定义取 |qacc[argmax|qacc|]|，不发散方向）；
        非有限值照旧给 null，不编造数。只在有活动动作时采集；不据它推断任务成败，也不改任何增益。
        """
        qacc = np.asarray(self.data.qacc, dtype=float)
        if qacc.size == 0:
            return None
        dof = int(np.argmax(np.abs(qacc)))
        value = abs(float(qacc[dof]))
        return {'qaccDof': dof, 'maxAbsQacc': value if math.isfinite(value) else None, 'jointName': self.joint_of_dof(dof)}

    def joint_of_dof(self, dof):
        """模型 dof 索引 → "实体/关节"（重置证据里带名字，避免只给裸索引）。"""
        for eid, info in self.entities.items():
            for name, joint in info['joints'].items():
                if joint['dof'] == dof:
                    return eid + '/' + name
        return None

    def torque_gains(self, info, names):
        """这些关节在力矩执行器上的位置目标实际使用的显式 PD 增益。

        与 set_joint 同一解析路径（逐关节 controller.jointKp/jointKd → 标量 kp/kd → 默认 120/4），
        所以回执里给的是真正写进 ctrl 的增益，不是请求原文的照抄。
        """
        cfg = info['controller']
        gains = {}
        for name in names:
            joint = info['joints'].get(name)
            if not joint or not joint.get('actuator'):
                continue
            if info['actuators'][joint['actuator']]['mode'] != 'torque':
                continue
            gains[name] = {'kp': joint_gain(cfg, 'jointKp', name, 'kp', 120),
                           'kd': joint_gain(cfg, 'jointKd', name, 'kd', 4)}
        return gains

    def fail_unstable(self, dt, time_before, evidence):
        """引擎在动作窗口内自动重置 → 以 failed 如实终结本世界所有活动动作并释放时钟。

        不改增益、不换夹具、不放宽容差、不延长窗口：世界状态已被引擎清空，动作不可能再诚实到达目标；
        继续等 targetReached 只会永久持有手动时钟（139 现象）。回执给实测证据与请求增益，便于定位数值可积性。
        """
        sim_time = float(self.data.time)
        where = ''
        if evidence and evidence.get('maxAbsQacc') is not None:
            where = '，重置前 max|qacc|=%.3g（dof %d%s）' % (
                evidence['maxAbsQacc'], evidence['qaccDof'],
                '=' + evidence['jointName'] if evidence.get('jointName') else '')
        for aid, active in list(self.active.items()):
            gains = {}
            for motion in active['motions']:
                info = self.info(motion['entityId'])
                names = list(motion.get('jointNames') or [c['joint'] for c in motion.get('_controls', []) if c.get('mode') == 'torque'])
                gains.update({motion['entityId']: self.torque_gains(info, names)})
            self.finish(aid, 'failed',
                        'SIMULATION_UNSTABLE: 物理引擎在动作窗口内自动重置（步 %d，simTime %.4f→%.4f%s）；'
                        '世界状态已被引擎清空，动作无法如实完成。若目标由力矩执行器按位置语义驱动，请核对 '
                        'controller.jointKp/jointKd 与步长 %gs 的数值可积性（或改用 position 执行器）'
                        % (self.step_index, time_before, sim_time, where, dt),
                        {'engineReset': {'stepIndex': self.step_index, 'simTimeBeforeS': time_before, 'simTimeAfterS': sim_time,
                                         'maxAbsQacc': evidence.get('maxAbsQacc') if evidence else None,
                                         'qaccDof': evidence.get('qaccDof') if evidence else None,
                                         'jointName': evidence.get('jointName') if evidence else None,
                                         'timestepS': dt, 'torqueControllerGains': gains,
                                         'basis': 'mj_step 未把物理钟推进一个 dt（引擎自动重置把 time/qpos/qvel 清空）；'
                                                  'maxAbsQacc 为重置前一步实测 data.qacc 的极值幅值（非负，|qacc[argmax|qacc|]|），'
                                                  '该值为非有限时给 null'}})

    def tick(self):
        if self.paused:return
        if self.status not in ('ready', 'running'):
            return
        if self.clock == 'manual' and not self.active:
            return
        dt = float(self.model.opt.timestep)
        for info in self.entities.values():
            for name,target in list(info['heldTargets'].items()):self.set_joint(info,name,target,dt)
        for aid, active in list(self.active.items()):
            if active['expectedGeneration'] != self.generation:
                self.finish(aid, 'failed', 'STALE_GENERATION')
                continue
            if self.step_index + 1 < active['start']:
                continue
            receipt = self.receipts[aid]
            if active['startTime'] is None:
                active['startTime'] = float(self.data.time)
                receipt.update({'status': 'running', 'startStep': self.step_index + 1})
            # 本动作窗口内真实经历辅助 tick 的事实：只累计已开始且本 tick 正在被驱动的动作，
            # scheduled 未来动作不提前标脏；解除 attach 不清除已发生的事实，动作结束随动作生命周期消失。
            if self.assisted:
                active['assistedTicks'] = active.get('assistedTicks', 0) + 1
            # 窗口进度按"已驱动的物理步数×dt"计（本 tick 正在驱动第 windowSteps+1 步），与 data.time 之差
            # 在正常情况下逐步等价（mj_step 恰好推进 dt），但不会被引擎自动重置回退的时钟拖回早期相位。
            elapsed = (active['windowSteps'] + 1) * dt
            try:
                for m in active['motions']:
                    self.apply_motion(m, elapsed)
            except Exception as exc:
                self.finish(aid, 'failed', str(exc))
        if self.clock == 'manual' and not self.active:
            return
        for attachment in self.assisted.values():
            obj = self.info(attachment['objectId'])
            robot = self.info(attachment['robotId'])
            body = self.model.body(robot['prefix'] + attachment['anchorBody']).id
            position = self.data.xpos[body] + self.data.xmat[body].reshape(3, 3) @ attachment['offset']
            address = attachment['qpos']
            self.data.qpos[address:address+3] = position
            mj.mju_mulQuat(self.data.qpos[address+3:address+7], self.data.xquat[body], attachment['relativeOrientation'])
            self.data.qvel[attachment['dof']:attachment['dof']+6] = 0
            # 真实辅助推进计数只随一次真实写回递增；attach/release 调用本身不在计数点内。
            self.assist_advances += 1
        # 唯一物理步：同一个 tick 的全部机器人/全部关节先写目标，再推进真实引擎。
        # 引擎在坏 QACC/QPOS/QVEL 时会打印告警并整份 mj_resetData（time 归零、qpos/qvel 清空）：物理钟
        # 不再按 dt 前进就是这次自动重置的实测标志。139 的根因正是旧实现把动作窗口记在 data.time 上，
        # 重置后窗口永远到不了终点 → 动作永久 active、手动时钟被永久持有、后续动作被 WORLD_BUSY 拒绝。
        time_before = float(self.data.time)
        unstable = self.instability_evidence() if self.active else None
        mj.mj_step(self.model, self.data)
        self.step_index += 1
        if self.active and not self.clock_advanced(time_before, dt):
            self.fail_unstable(dt, time_before, unstable)
        # 值/step 同源：只把刚积分完成的这一步（self.step_index）的引擎 actuator_force 与步号一起记入动作；
        # 短推力窗口结束后 ctrl 已写 0，绝不把之后任何一步的值冒称最后驱动步，也不预支未完成的步。
        for active in self.active.values():
            if active['startTime'] is not None:
                # 本 tick 真的推进了一步（引擎未重置，否则动作已被 fail_unstable 终结），窗口计数只在这里递增。
                active['windowSteps'] += 1
            for motion in active['motions']:
                if motion['kind'] != 'thrust':
                    continue
                pending = motion.pop('_pendingMeasuredStep', None)
                if pending != self.step_index:
                    continue
                motion['_drivenSteps'] += 1
                motion['_lastDrivenStep'] = self.step_index
                motion['_measuredAtStep'] = self.step_index
                motion['_measuredActuatorForce'] = {name: float(self.data.actuator_force[aid]) for name, (aid, _) in zip(motion['_wrenchNames'], motion['_actuatorControls'])}
        # 在本步实际施力快照之后刷新观测派生量；重算力不能覆盖刚记录的实际施力。
        self.refresh_derived()
        # 载荷事实逐步采样：接触/位置取刚积分完成的这一步（与 observe 同源）；无活动动作或世界上
        # 没有其他实体时不做任何采样，不产生额外开销。
        if self.active and len(self.entities) > 1:
            for active in self.active.values():
                if active['startTime'] is None:
                    continue
                for motion in active['motions']:
                    self.sample_payload(motion)
        for aid, active in list(self.active.items()):
            # 定时动作按已驱动步数到窗（步数 = 窗长/dt 向上取整，最多比墙钟口径晚一个 dt）；
            # 与 data.time 之差在正常运行下逐步等价，但不会被引擎重置后的时钟回退无限拖延。
            completed = self.step_index >= active['endStep'] if 'endStep' in active else active['startTime'] is not None and active['windowSteps'] * dt >= max(m['_end'] for m in active['motions'])
            if completed:
                self.finish(aid, 'completed')
        self.status = 'running' if self.active else 'ready'
        if time.monotonic() - self.last_frame >= 1 / self.frame_hz:
            emit({'event': 'frame', 'frame': self.observe()})
            self.last_frame = time.monotonic()

    def assist(self, options):
        self.require_ready()
        if options['expectedGeneration'] != self.generation:
            raise SimError('STALE_GENERATION', '辅助动作代次已过期')
        object_id = options['objectId']
        if options['mode'] == 'release':
            self.assisted.pop(object_id, None)
            return {'executionMode': 'assisted-teleport', 'attached': False, 'worldId': self.id, 'generation': self.generation, 'stepIndex': self.step_index, 'countsAsPhysicalGrasp': False}
        if options['mode'] != 'attach':
            raise SimError('INVALID_ARGUMENT', '辅助模式必须明确 attach 或 release')
        obj, robot = self.info(object_id), self.info(options['robotId'])
        jid = int(self.model.body_jntadr[obj['body']])
        if jid < 0 or self.model.jnt_type[jid] != mj.mjtJoint.mjJNT_FREE:
            raise SimError('UNSUPPORTED_CAPABILITY', '辅助附着需要 freejoint 动态物体')
        anchor = options['anchorBody']
        body = self.model.body(robot['prefix'] + anchor).id
        offset = self.data.xmat[body].reshape(3, 3).T @ (self.data.xpos[obj['body']] - self.data.xpos[body])
        address = int(self.model.jnt_qposadr[jid])
        inverse, relative = np.empty(4), np.empty(4)
        mj.mju_negQuat(inverse, self.data.xquat[body])
        mj.mju_mulQuat(relative, inverse, self.data.qpos[address+3:address+7])
        self.assisted[object_id] = {'objectId': object_id, 'robotId': options['robotId'], 'anchorBody': anchor, 'offset': offset, 'relativeOrientation': relative, 'qpos': address, 'dof': int(self.model.jnt_dofadr[jid])}
        return {'executionMode': 'assisted-teleport', 'attached': True, 'worldId': self.id, 'generation': self.generation, 'stepIndex': self.step_index, 'countsAsPhysicalGrasp': False}

    def resolve_camera_name(self, name):
        """Resolve a source camera name after MjSpec.attach prefixes entity names."""
        if not isinstance(name, str) or not name.strip():
            raise SimError('INVALID_ARGUMENT', 'cameraName 必须是非空字符串')
        if mj.mj_name2id(self.model, mj.mjtObj.mjOBJ_CAMERA, name) >= 0:
            return name
        matches = []
        for info in self.entities.values():
            candidate = info['prefix'] + name
            if mj.mj_name2id(self.model, mj.mjtObj.mjOBJ_CAMERA, candidate) >= 0:
                matches.append(candidate)
        # Scene 声明的相机同样接受实体局部名简写（引擎名是 entityId/名字），与 MJCF 相机共用同一命名空间：
        # 重名一律按歧义拒绝，不会静默挑一台。
        for declared in self.scene_cameras.values():
            if declared.get('available') is not False and declared['localName'] == name and declared['cameraName'] not in matches:
                matches.append(declared['cameraName'])
        if len(matches) == 1:
            return matches[0]
        if not matches:
            raise SimError('CAMERA_NOT_FOUND', '原生相机不存在: ' + name)
        raise SimError('AMBIGUOUS_CAMERA', '原生相机名匹配多个实体: ' + name)

    def display_groups(self, value):
        """显式可选的 MuJoCo 显示组（0..5）：只决定渲染时哪些 geom group 可见，不触碰物理。
        未提供时返回 None，沿用引擎默认可见组，行为与既有 capture 一致。"""
        if value is None:
            return None
        if not isinstance(value, list) or any(isinstance(item, bool) or not isinstance(item, int) or not 0 <= item <= 5 for item in value):
            raise SimError('INVALID_ARGUMENT', 'geomGroups 必须是 0..5 的整数数组')
        return sorted(set(value))

    # --------------------------------------------------------- 多命名相机 / 临时调整
    # 所有权：Scene 保存相机实体与标定声明，Sim 拥有世界内真实位置与渲染。这里的临时
    # override 只改本 world 内存中的渲染源（data.cam_xpos/cam_xmat 与 model.cam_fovy/model.cam_intrinsic），
    # 不改写源 MJCF/Scene 文档、不落盘到模型；close/sync 时清除；capture 回执始终如实
    # 标注 override 与 worldGeneration，绝不把临时姿态冒充源相机。

    def _camera_far_depth(self):
        """背景/未命中像素的深度值：与 mujoco.Renderer 的反向 Z 线性化逐位一致（buffer=0 → d_coef/c_coef）。
        不能简写成 zfar·extent——渲染器的 float32 系数在 c_coef=(1−…) 处发生抵消，简单式有 ~1e-4 相对差。"""
        extent = float(self.model.stat.extent)
        zfar = np.float32(float(self.model.vis.map.zfar) * extent)
        znear = np.float32(float(self.model.vis.map.znear) * extent)
        c_coef = -(zfar + znear) / (zfar - znear)
        d_coef = -(np.float32(2) * zfar * znear) / (zfar - znear)
        c_coef = np.float32(-0.5) * c_coef - np.float32(0.5)
        d_coef = np.float32(-0.5) * d_coef
        return float(np.float32(float(d_coef) / float(c_coef)))

    def _camera_resolution(self, options):
        width, height = int(options.get('width', 640)), int(options.get('height', 480))
        if min(width, height) < 16 or max(width, height) > 4096:
            raise SimError('INVALID_ARGUMENT', '相机分辨率须介于 16 与 4096')
        return width, height

    def _scene_option_for(self, groups):
        """显示组只写进渲染选项：同一相机 RGB 与深度两次 update_scene 必须用同一个 scene_option。"""
        if groups is None:
            return None
        option = mj.MjvOption()
        for i in range(len(option.geomgroup)):
            option.geomgroup[i] = 1 if i in groups else 0
        return option

    def _camera_parent_body_name(self, camid):
        """相机所属 body 名（挂在 worldbody 上的相机返回 'world'）：parent 参考系的锚点。"""
        bodyid = int(self.model.cam_bodyid[camid])
        name = self.model.body(bodyid).name if 0 <= bodyid < self.model.nbody else ''
        return name or 'world'

    def _camera_parent_transform(self, camid):
        """相机父 body 当前的 world 变换 (positionM, rotation3x3)：parent 局部↔world 转换的唯一依据。"""
        bodyid = int(self.model.cam_bodyid[camid])
        return (np.asarray(self.data.xpos[bodyid], dtype=float).copy(),
                np.asarray(self.data.xmat[bodyid], dtype=float).reshape(3, 3).copy())

    def _camera_frame_identity(self):
        """相机/目标 body/采集共享同一世界物理帧身份。"""
        return {'worldId': self.id, 'generation': self.generation, 'worldGeneration': self.generation,
                'sceneRevision': self.applied_revision, 'appliedSceneRevision': self.applied_revision,
                'stepIndex': self.step_index, 'simTime': float(self.data.time),
                'frameId': f'{self.id}:{self.generation}:{self.step_index}'}

    def _camera_clip_planes(self):
        """实际渲染使用世界全局裁剪；逐相机 Scene near/far 仅保留声明，不冒称生效。"""
        extent = float(self.model.stat.extent)
        return {'nearM': float(self.model.vis.map.znear) * extent, 'farM': float(self.model.vis.map.zfar) * extent,
                'clipPlanesSource': 'engine-global', 'clipPlanesPerCameraSupported': False}

    def _camera_mount_readback(self, camid, position, rotation):
        """局部安装和目标 body 位姿均从当前引擎 FK 读回，含临时 pose override 的真实效果。"""
        body_position, body_rotation = self._camera_parent_transform(camid)
        local_position = body_rotation.T @ (np.asarray(position, dtype=float) - body_position)
        local_rotation = body_rotation.T @ rotation
        result = {'parentFromCamera': {'positionM': local_position.tolist(),
                                      'quaternionXyzw': self._quaternion_from_matrix(local_rotation),
                                      'rotationMatrix': local_rotation.tolist()},
                  'worldFromParent': {'positionM': body_position.tolist(),
                                      'quaternionXyzw': self._quaternion_from_matrix(body_rotation),
                                      'rotationMatrix': body_rotation.tolist()}}
        parent_name = self._camera_parent_body_name(camid)
        for eid in sorted(self.entities, key=len, reverse=True):
            if parent_name.startswith(self.entities[eid]['prefix']):
                result['parentEntityId'] = eid
                break
        declared = self.scene_cameras.get(self.model.camera(camid).name)
        if declared and declared.get('mount'):
            result['mount'] = copy.deepcopy(declared['mount'])
        return result

    def _matrix_from_quaternion(self, quaternion):
        """[x,y,z,w] → 3x3 旋转矩阵（与 MuJoCo mju_quat2Mat 的 w-first 约定一致）。"""
        rotation = np.zeros(9)
        mj.mju_quat2Mat(rotation, np.array([quaternion[3], quaternion[0], quaternion[1], quaternion[2]], dtype=float))
        return rotation.reshape(3, 3).copy()

    def _quaternion_from_matrix(self, rotation):
        """3x3 旋转矩阵 → [x,y,z,w]（mju_mat2Quat 返回 w-first）。"""
        quat = np.zeros(4)
        mj.mju_mat2Quat(quat, np.asarray(rotation, dtype=float).reshape(9))
        return [float(quat[1]), float(quat[2]), float(quat[3]), float(quat[0])]

    def _camera_source_local_pose(self, camid):
        """相机在源 MJCF 中相对父 body 的局部位姿（model.cam_pos/cam_quat，四元数转 [x,y,z,w]）。"""
        position = [float(v) for v in self.model.cam_pos[camid]]
        quat = np.asarray(self.model.cam_quat[camid], dtype=float)
        return position, [float(quat[1]), float(quat[2]), float(quat[3]), float(quat[0])]

    def _camera_world_pose(self, camid, override):
        """渲染/标定实际使用的最终真实 world pose（positionM, rotation3x3）。

        没有 override，或该相机没有任何显式位姿字段时，取当前 FK 派生量——挂载相机因此每帧跟随父 body，
        FOV-only 不会把相机冻结在调整时的世界位姿。有显式字段时只替换被显式覆盖的那个字段，
        另一个字段仍取当前 FK（单字段局部调整同样不冻结另一自由度）。
        parent 参考系：显式字段是相对相机所属 body 的局部位姿，用父 body 当前 FK 转成 world
        （与 MuJoCo 自身 cam_xpos = body_xpos + body_xmat·cam_pos 的固定相机定义一致）。
        """
        source_position = [float(v) for v in self.data.cam_xpos[camid]]
        source_rotation = np.asarray(self.data.cam_xmat[camid], dtype=float).reshape(3, 3).copy()
        if not override:
            return source_position, source_rotation
        position_overridden = bool(override.get('positionOverridden'))
        quaternion_overridden = bool(override.get('quaternionOverridden'))
        if not position_overridden and not quaternion_overridden:
            return source_position, source_rotation
        if override['referenceFrame'] == 'parent':
            body_position, body_rotation = self._camera_parent_transform(camid)
            position = (body_position + body_rotation @ np.asarray(override['positionM'], dtype=float)) if position_overridden else source_position
            rotation = (body_rotation @ self._matrix_from_quaternion(override['quaternionXyzw'])) if quaternion_overridden else source_rotation
            return [float(v) for v in position], rotation
        position = [float(v) for v in override['positionM']] if position_overridden else source_position
        rotation = self._matrix_from_quaternion(override['quaternionXyzw']) if quaternion_overridden else source_rotation
        return position, rotation

    def _pin_camera_override(self, resolved_name):
        """渲染前把 override 里显式覆盖的字段写进真实渲染数组，返回还原函数（无 override 时为 None）。
        只写被显式覆盖的字段：FOV-only / 单字段调整不冻结未覆盖的自由度，挂载相机继续按父 body 当前
        FK 渲染；只改内存副本，源 MJCF/Scene 文档、模型常量与物理状态都不动，渲染完立即还原。"""
        override = self.camera_overrides.get(resolved_name)
        if not override:
            return None
        camid = mj.mj_name2id(self.model, mj.mjtObj.mjOBJ_CAMERA, resolved_name)
        if camid < 0:
            raise SimError('CAMERA_NOT_FOUND', '原生相机不存在: ' + resolved_name)
        position_overridden = bool(override.get('positionOverridden'))
        quaternion_overridden = bool(override.get('quaternionOverridden'))
        fovy_overridden = bool(override.get('fovyOverridden'))
        if not (position_overridden or quaternion_overridden or fovy_overridden):
            return None
        saved_position = self.data.cam_xpos[camid].copy()
        saved_rotation = self.data.cam_xmat[camid].copy()
        saved_fovy = float(self.model.cam_fovy[camid])
        saved_intrinsic = self.model.cam_intrinsic[camid].copy()
        if position_overridden or quaternion_overridden:
            position, rotation = self._camera_world_pose(camid, override)
            if position_overridden:
                self.data.cam_xpos[camid] = np.asarray(position, dtype=float)
            if quaternion_overridden:
                self.data.cam_xmat[camid] = rotation.reshape(9)
        if fovy_overridden and override['fovyDeg'] is not None:
            engine = self._camera_engine_intrinsics(camid)
            if engine is None:
                self.model.cam_fovy[camid] = float(override['fovyDeg'])
            else:
                # 内参相机的 cam_fovy 是派生量、改了不影响画面（实测），"只改 FOV"必须改焦距：
                # 写回 model.cam_intrinsic 的**米制** focal（米 = 像素·传感器尺寸/分辨率）。
                focal_x, focal_y = self._engine_focal_after_fovy(engine, float(override['fovyDeg']))
                self.model.cam_intrinsic[camid][0] = focal_x * engine['sensorSizeM'][0] / engine['resolution'][0]
                self.model.cam_intrinsic[camid][1] = focal_y * engine['sensorSizeM'][1] / engine['resolution'][1]

        def restore():
            self.data.cam_xpos[camid] = saved_position
            self.data.cam_xmat[camid] = saved_rotation
            self.model.cam_fovy[camid] = saved_fovy
            self.model.cam_intrinsic[camid] = saved_intrinsic
        return restore

    def _render_named_camera(self, renderer, resolved_name, scene_option):
        """一次真实 RGB + 米制深度渲染；命名相机在渲染瞬间应用/还原临时 override。"""
        restore = self._pin_camera_override(resolved_name)
        try:
            renderer.update_scene(self.data, camera=resolved_name, scene_option=scene_option)
            rgb = renderer.render().copy()
            renderer.enable_depth_rendering()
            try:
                renderer.update_scene(self.data, camera=resolved_name, scene_option=scene_option)
                depth = renderer.render().copy()
            finally:
                renderer.disable_depth_rendering()
        finally:
            if restore:
                restore()
        return rgb, depth

    def _camera_engine_intrinsics(self, camid):
        """相机在引擎里的内参配置（像素口径），或 None（没有内参的 fovy 相机）。

        判定"引擎真的按内参渲染"的唯一依据是模型里同时有正的 sensorsize 与 resolution 与 focalpixel：
        这正是 MuJoCo 的编译条件（只给 fovy 的相机 cam_sensorsize 全 0，走方形像素 + 竖直视场）。
        原生 MJCF 自带 focalpixel/principalpixel 的相机在这里被如实认出，装配路径也从不改写它们。
        model.cam_intrinsic 是**米制** [focal, principal]（focal = 传感器尺寸/分辨率·像素焦距），
        这里换算回像素：px = 米·分辨率/传感器尺寸。
        """
        if not 0 <= camid < self.model.ncam:
            return None
        sensor = [float(v) for v in self.model.cam_sensorsize[camid]]
        if not (sensor[0] > 0 and sensor[1] > 0):
            return None
        resolution = [float(v) for v in self.model.cam_resolution[camid]]
        if min(resolution) < 1 or resolution[0] != int(resolution[0]) or resolution[1] != int(resolution[1]):
            return None
        focal_x, focal_y, point_x, point_y = (float(v) for v in self.model.cam_intrinsic[camid])
        if not (focal_x > 0 and focal_y > 0):
            return None
        return {'resolution': [int(resolution[0]), int(resolution[1])], 'sensorSizeM': sensor,
                'focalPixelConfigured': [focal_x * resolution[0] / sensor[0], focal_y * resolution[1] / sensor[1]],
                'principalPixelConfigured': [point_x * resolution[0] / sensor[0], point_y * resolution[1] / sensor[1]]}

    @staticmethod
    def _engine_focal_after_fovy(engine, fovy_deg):
        """K 相机上的 fovy override → 新的配置像素焦距 (fx', fy')。

        cam_fovy 对按内参渲染的相机是惰性的（实测把它改到 60° 输出逐像素不变），所以"只改 FOV"必须
        改焦距：fy' = H_c/(2·tan(fovy/2)) 让竖直视场正好是请求值，fx' 同比缩放（保持像素长宽比，
        不把非方形像素硬掰成方形）。fovy 相机那一支仍然是直接写 cam_fovy，语义两条路径一致。
        """
        height = float(engine['resolution'][1])
        focal_x, focal_y = engine['focalPixelConfigured']
        target = height / (2.0 * math.tan(math.radians(fovy_deg) / 2.0))
        factor = target / focal_y
        return focal_x * factor, target

    def _camera_effective_intrinsics(self, camid, width, height, override):
        """渲染实际生效的 K：CV 口径（cx/cy 是光轴像素，fx/fy 是该输出分辨率下的像素焦距）。

        内参相机：配置值按引擎规则缩放到输出分辨率——fx·W_v/W_c、fy·H_v/H_c、
        cx = (W_v−1)/2 − cx_cfg·W_v/W_c、cy = (H_v−1)/2 − cy_cfg·H_v/H_c（probe10 实测 <0.2 px）；
        fovy 相机：fx = fy = H_v/(2·tan(fovy/2))、主点恰在 (W_v−1)/2。
        """
        fovy_override = None
        if override and override.get('fovyOverridden') and override['fovyDeg'] is not None:
            fovy_override = float(override['fovyDeg'])
        engine = self._camera_engine_intrinsics(camid)
        if engine is None:
            fovy = fovy_override if fovy_override is not None else float(self.model.cam_fovy[camid])
            fy = height / (2.0 * math.tan(math.radians(fovy) / 2.0))
            return {'source': 'fovy', 'fx': fy, 'fy': fy, 'cx': (width - 1) / 2.0, 'cy': (height - 1) / 2.0,
                    'fovyDeg': fovy, 'engine': None}
        focal_x, focal_y = engine['focalPixelConfigured']
        if fovy_override is not None:
            focal_x, focal_y = self._engine_focal_after_fovy(engine, fovy_override)
        point_x, point_y = engine['principalPixelConfigured']
        scale_x, scale_y = width / engine['resolution'][0], height / engine['resolution'][1]
        fx, fy = focal_x * scale_x, focal_y * scale_y
        return {'source': 'engine-intrinsics', 'fx': fx, 'fy': fy,
                'cx': (width - 1) / 2.0 - point_x * scale_x, 'cy': (height - 1) / 2.0 - point_y * scale_y,
                # 竖直视场由实际焦距派生：对 K 相机它等于 2·atan(H_c/(2·fy_cfg))，与输出分辨率无关
                # （引擎在任何视口下都保持相机自身分辨率定义的成像角）。
                'fovyDeg': math.degrees(2.0 * math.atan(height / (2.0 * fy))), 'engine': engine}

    def _camera_calibration(self, resolved_name, width, height):
        """命名相机的完整 pinhole 标定；override 生效时内参/位姿来自真实渲染所用的临时值。

        intrinsics 是**渲染实际生效**的 K（该输出分辨率下、CV 口径：cx/cy 是光轴像素、fx/fy 是像素
        焦距），内参相机与 fovy 相机各按各自规则算（见 _camera_effective_intrinsics），不再用
        fx=fy 覆盖一份已知 K。intrinsicsSource 标明这一支是什么，engineIntrinsics 给出引擎侧配置值
        供核对；畸变如实标注：MuJoCo 3.13 没有畸变模型，声明过的畸变原样带出但标成未建模。
        worldFromCamera 始终是这一帧渲染实际使用的最终真实 world pose（parent 参考系用当前 body FK
        换算；无显式位姿字段时就是当前源相机 FK），并公开 parentBodyName/referenceFrame。"""
        camid = mj.mj_name2id(self.model, mj.mjtObj.mjOBJ_CAMERA, resolved_name)
        if camid < 0:
            raise SimError('CAMERA_NOT_FOUND', '原生相机不存在: ' + resolved_name)
        override = self.camera_overrides.get(resolved_name)
        effective = self._camera_effective_intrinsics(camid, width, height, override)
        position, rotation = self._camera_world_pose(camid, override)
        intrinsics = {'fx': float(effective['fx']), 'fy': float(effective['fy']),
                      'cx': float(effective['cx']), 'cy': float(effective['cy']),
                      'width': width, 'height': height, 'fovyDeg': float(effective['fovyDeg']),
                      'pixelAspectRatio': float(effective['fx'] / effective['fy']),
                      'distortionModeled': False}
        declared = self.scene_cameras.get(resolved_name)
        if declared and 'declaredDistortion' in declared:
            intrinsics['distortionDeclared'] = list(declared['declaredDistortion'])
        calibration = {
            **self._camera_frame_identity(),
            **self._camera_clip_planes(),
            'model': 'pinhole',
            'coordinateSystem': 'right-handed-z-up; MuJoCo camera looks along -Z, +Y up',
            'parentBodyName': self._camera_parent_body_name(camid),
            'referenceFrame': override['referenceFrame'] if override else ('parent' if self._camera_parent_body_name(camid) != 'world' else 'world'),
            'intrinsicsSource': effective['source'],
            'intrinsics': intrinsics,
            'worldFromCamera': {'positionM': position, 'quaternionXyzw': self._quaternion_from_matrix(rotation),
                                'rotationMatrix': [[float(v) for v in row] for row in rotation]},
            **self._camera_mount_readback(camid, position, rotation),
            # 深度语义以真实渲染实测为准（见 test/multiview-camera.test.ts 的平面距离验证）：
            # 深度是相机坐标系 -z 轴的轴向米制距离（相机平面到点的距离），不是欧氏距离。
            'depthSemantics': 'axial-meters-along-camera-axis; p_cam=[(u-cx)*d/fx, -(v-cy)*d/fy, -d]; world=R*p_cam+t',
            'backgroundDepthM': self._camera_far_depth(),
        }
        if effective['engine'] is not None:
            engine = effective['engine']
            calibration['engineIntrinsics'] = {
                'resolution': list(engine['resolution']), 'sensorSizeM': list(engine['sensorSizeM']),
                'focalPixelConfigured': list(engine['focalPixelConfigured']),
                'principalPixelConfigured': list(engine['principalPixelConfigured']),
                'principalPixelConvention': 'config = image-center − principal-point (engine); intrinsics.cx/cy = principal-point (CV)',
            }
        if declared:
            for key in ('declaredNearM', 'declaredFarM'):
                if key in declared:
                    calibration[key] = declared[key]
        return calibration

    def _write_rgb_png(self, path, rgb, width, height):
        def chunk(kind, payload):
            data = kind + payload
            return struct.pack('!I', len(payload)) + data + struct.pack('!I', zlib.crc32(data) & 0xffffffff)
        rows = b''.join(b'\x00' + rgb[y].tobytes() for y in range(height))
        path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))

    def _capture_entry(self, name, resolved_name, rgb, depth, width, height, root):
        """单个命名相机的真实产物 + 完整标定；override 状态随本次渲染如实标注。"""
        override = self.camera_overrides.get(resolved_name)
        calibration = self._camera_calibration(resolved_name, width, height)
        stem = str(uuid.uuid4())
        rgbpath, depthpath = root / (stem + '.png'), root / (stem + '-depth.npy')
        self._write_rgb_png(rgbpath, rgb, width, height)
        np.save(depthpath, depth)
        return {
            **self._camera_frame_identity(),
            'cameraName': name, 'resolvedCameraName': resolved_name,
            'override': override is not None,
            'worldGeneration': self.generation,
            'parentBodyName': calibration['parentBodyName'],
            **self._camera_mount_readback(mj.mj_name2id(self.model, mj.mjtObj.mjOBJ_CAMERA, resolved_name),
                                         calibration['worldFromCamera']['positionM'],
                                         np.asarray(calibration['worldFromCamera']['rotationMatrix'])),
            'referenceFrame': calibration['referenceFrame'],
            'positionOverridden': bool(override and override.get('positionOverridden')),
            'quaternionOverridden': bool(override and override.get('quaternionOverridden')),
            'fovyOverridden': bool(override and override.get('fovyOverridden')),
            **({'overrideSource': 'camera_adjust', 'overrideAdjustStepIndex': override['stepIndex']} if override else {}),
            'width': width, 'height': height,
            'rgb': {'uri': rgbpath.as_uri(), 'mimeType': 'image/png'},
            'depth': {'uri': depthpath.as_uri(), 'mimeType': 'application/x-npy', 'units': 'm'},
            'depthRangeM': [float(np.min(depth)), float(np.max(depth))],
            'calibration': calibration,
            'annotationIds': [],
        }

    def publish_capture(self,capture_id,from_dir,to_dir):
        """宿主发布完成后，只更新本次采集登记的文件位置，不重新采集或改动标定。"""
        if capture_id not in self.captures:raise SimError('CAPTURE_NOT_FOUND','采集登记不存在: '+capture_id)
        source=Path(from_dir).resolve();target=Path(to_dir).resolve();updates=[]
        for entry in self.captures[capture_id]['cameras']:
            for kind in ('rgb','depth'):
                metadata=entry.get(kind)
                if not metadata:continue
                path=target/Path(path_from_uri(metadata['uri'])).relative_to(source)
                if not path.is_file():raise SimError('CAPTURE_FILE_MISSING','已发布的采集文件不存在: '+str(path))
                updates.append((metadata,path.as_uri()))
        for metadata,uri in updates:metadata['uri']=uri
        return {'captureId':capture_id,'files':len(updates)}
    def _remember_capture(self, capture_id, result, cameras):
        """captureId → 真实回执与逐相机条目；标注/数据集只引用这里记录过的真实采集。"""
        self.captures[capture_id] = {
            'captureId': capture_id, 'worldId': self.id, 'generation': result['generation'],
            'sceneRevision': result['sceneRevision'], 'stepIndex': result['stepIndex'], 'simTime': result['simTime'],
            'frameId': result['frameId'], 'width': result['width'], 'height': result['height'],
            'multi': len(cameras) > 1, 'cameras': cameras, 'annotations': [],
        }
        for stale in list(self.captures)[:-128]:
            del self.captures[stale]

    def camera_list(self, options=None):
        """只读列出全部命名相机（含实体前缀与实体内局部别名）及最终真实位姿与生效内参。

        worldFromCamera 是这一帧渲染/标定实际使用的最终 world pose（parent override 按当前 body FK
        换算；FOV-only 不冻结姿态），sourceWorldFromCamera 是未施加 override 的源相机 FK 位姿；
        同时公开 parentBodyName/referenceFrame 与各字段的显式覆盖状态。
        intrinsics 是**该参考分辨率下实际生效的 K**（同一份值 capture/calibration 也会给出，
        见 _camera_effective_intrinsics），intrinsicsSource 说明它来自声明 K（'engine-intrinsics'）
        还是 fovy（'fovy'）；参考分辨率取 options.width/height（默认 640×480，与 capture 默认一致）。
        每台相机另标 cameraSource：'scene-camera' 是 Scene 声明的相机装进引擎的命名相机
        （附 entityId/localName/cameraComponent 与源件声明的光学参数，cameraComponent 区分
        'camera'（Blender 机位）与 'viewerCamera'（66 的命名相机）），'mjcf' 是实体自带 MJCF/URDF
        相机（自带 focalpixel/principalpixel 的原件在这里被如实标成 'engine-intrinsics'，装配路径
        从不改写它们）；两类相机同一命名空间、同一套渲染与标定路径。"""
        self.require_ready()
        self.refresh_derived()
        width, height = self._camera_resolution(options or {})
        cameras = []
        for camid in range(self.model.ncam):
            name = self.model.camera(camid).name
            if not name:
                continue
            override = self.camera_overrides.get(name)
            position, rotation = self._camera_world_pose(camid, override)
            fovy_overridden = bool(override and override.get('fovyOverridden'))
            effective = self._camera_effective_intrinsics(camid, width, height, override)
            source = self._camera_effective_intrinsics(camid, width, height, None)
            item = {**self._camera_frame_identity(), **self._camera_clip_planes(), 'cameraName': name, 'available': True,
                    'parentBodyName': self._camera_parent_body_name(camid),
                    'referenceFrame': override['referenceFrame'] if override else ('parent' if self._camera_parent_body_name(camid) != 'world' else 'world'),
                    'intrinsicsSource': effective['source'],
                    'referenceResolution': [width, height],
                    'intrinsics': {'fx': float(effective['fx']), 'fy': float(effective['fy']),
                                   'cx': float(effective['cx']), 'cy': float(effective['cy']),
                                   'width': width, 'height': height, 'fovyDeg': float(effective['fovyDeg']),
                                   'pixelAspectRatio': float(effective['fx'] / effective['fy']),
                                   'distortionModeled': False},
                    'fovyDeg': float(effective['fovyDeg']),
                    'sourceFovyDeg': float(source['fovyDeg']),
                    'worldFromCamera': {'positionM': position, 'quaternionXyzw': self._quaternion_from_matrix(rotation),
                                        'rotationMatrix': [[float(v) for v in row] for row in rotation]},
                    **self._camera_mount_readback(camid, position, rotation),
                    'sourceWorldFromCamera': {'positionM': [float(v) for v in self.data.cam_xpos[camid]],
                                              'rotationMatrix': [[float(v) for v in row] for row in self.data.cam_xmat[camid].reshape(3, 3)]},
                    'positionOverridden': bool(override and override.get('positionOverridden')),
                    'quaternionOverridden': bool(override and override.get('quaternionOverridden')),
                    'fovyOverridden': fovy_overridden}
            engine = self._camera_engine_intrinsics(camid)
            if engine:
                item['engineIntrinsics'] = {
                    'resolution': list(engine['resolution']), 'sensorSizeM': list(engine['sensorSizeM']),
                    'focalPixelConfigured': list(engine['focalPixelConfigured']),
                    'principalPixelConfigured': list(engine['principalPixelConfigured']),
                    # 配置值与 CV 口径的关系：引擎把 principalpixel 当作"图像中心相对光轴像素的偏移"，
                    # 上面 intrinsics.cx/cy 已经换算成 CV 口径的光轴像素，两者符号相反、不要混用。
                    'principalPixelConvention': 'config = image-center − principal-point (engine); intrinsics.cx/cy = principal-point (CV)',
                }
            declared = self.scene_cameras.get(name)
            item['cameraSource'] = 'scene-camera' if declared else 'mjcf'
            if declared:
                # Scene 相机：实体绑定与源件声明的光学参数原样带出，供调用方核对
                # （intrinsics/fovyDeg 才是引擎实际生效的值；declared*/lensMm/sensorWidthMm 只是源件声明）。
                item['entityId'] = declared['entityId']
                item['localName'] = declared['localName']
                item['cameraComponent'] = declared['cameraComponent']
                item['orientationSource'] = declared['orientationSource']
                if 'isActive' in declared:
                    item['sceneActive'] = declared['isActive']
                for key, target in (('lensMm', 'declaredLensMm'), ('sensorWidthMm', 'declaredSensorWidthMm'),
                                    ('declaredNearM', 'declaredNearM'), ('declaredFarM', 'declaredFarM'),
                                    ('declaredIntrinsicsPx', 'declaredIntrinsicsPx'),
                                    ('declaredDistortion', 'declaredDistortion'),
                                    ('declaredFovYDeg', 'declaredFovYDeg'),
                                    ('appliedIntrinsicsPx', 'appliedIntrinsicsPx')):
                    if key in declared:
                        item[target] = declared[key]
            else:
                for info in self.entities.values():
                    prefix = info['prefix']
                    if name.startswith(prefix) and len(name) > len(prefix):
                        item['localName'] = name[len(prefix):]
                        item['entityId'] = info['entity']['entityId']
                        source_camera = info.get('nativeCameraSources', {}).get(item['localName'])
                        if source_camera:
                            item.update({key: value for key, value in source_camera.items() if key != 'parentBodyName'})
                        break
            item['override'] = override is not None
            if override:
                item['worldGeneration'] = override['generation']
                item['overridePositionM'] = list(override['positionM'])
                item['overrideQuaternionXyzw'] = list(override['quaternionXyzw'])
                item['overrideFovyDeg'] = override['fovyDeg']
            cameras.append(item)
        for declared in self.scene_cameras.values():
            if declared.get('available') is False:
                cameras.append({**self._camera_frame_identity(), **declared, 'cameraSource': 'scene-camera'})
        for info in self.entities.values():
            for refusal in info.get('nativeCameraRefusals', []):
                cameras.append({**self._camera_frame_identity(), 'entityId': info['entity']['entityId'],
                                'cameraSource': 'urdf', 'cameraName': info['prefix'] + refusal['cameraName'],
                                'localName': refusal['cameraName'], 'available': False,
                                'reason': refusal['code'], 'message': refusal['message']})
        bodies = []
        for bodyid in range(1, self.model.nbody):
            name = self.model.body(bodyid).name
            for eid in sorted(self.entities, key=len, reverse=True):
                prefix = self.entities[eid]['prefix']
                if name and name.startswith(prefix):
                    quaternion = self.data.xquat[bodyid]
                    bodies.append({**self._camera_frame_identity(), 'entityId': eid, 'bodyName': name[len(prefix):],
                                   'worldFromBody': {'positionM': self.data.xpos[bodyid].tolist(),
                                                     'quaternionXyzw': [*quaternion[1:].tolist(), float(quaternion[0])],
                                                     'rotationMatrix': self.data.xmat[bodyid].reshape(3, 3).tolist()}})
                    break
        return {**self._camera_frame_identity(), 'cameras': cameras, 'cameraCount': len(cameras), 'bodies': bodies}

    def _convert_camera_override(self, camid, override, target_frame):
        """把已有 override 的显式位姿字段按当前 FK 安全换算到 target_frame，返回 (换算后记录, 字段名列表)。

        只换算显式覆盖过的字段：未显式覆盖的自由度在目标 frame 下继续取源值，不与旧 frame 的坐标
        静默混合。world→parent 用 body_xmatᵀ 把世界位姿变成当前局部安装偏移；parent→world 用 body_xmat
        把当前局部偏移固化成世界位姿。回执以 frameConverted/convertedFromFrame 明确标注这次换算。"""
        converted = {'cameraName': override['cameraName'], 'referenceFrame': target_frame,
                     'positionOverridden': bool(override.get('positionOverridden')),
                     'quaternionOverridden': bool(override.get('quaternionOverridden')),
                     'fovyDeg': override['fovyDeg'], 'fovyOverridden': bool(override.get('fovyOverridden')),
                     'generation': override['generation'], 'stepIndex': override['stepIndex']}
        fields = []
        world_position, world_rotation = self._camera_world_pose(camid, override)
        body_position, body_rotation = self._camera_parent_transform(camid)
        if converted['positionOverridden']:
            if target_frame == 'parent':
                converted['positionM'] = [float(v) for v in body_rotation.T @ (np.asarray(world_position, dtype=float) - body_position)]
            else:
                converted['positionM'] = [float(v) for v in world_position]
            fields.append('positionM')
        if converted['quaternionOverridden']:
            if target_frame == 'parent':
                converted['quaternionXyzw'] = self._quaternion_from_matrix(body_rotation.T @ world_rotation)
            else:
                converted['quaternionXyzw'] = self._quaternion_from_matrix(world_rotation)
            fields.append('quaternionXyzw')
        return converted, fields

    def camera_adjust(self, options):
        """对当前 world 的已命名相机建立/局部更新临时 override（不改源文档），或 clear 清除。

        referenceFrame 可选 'world'（默认，positionM/quaternionXyzw 是世界位姿，保持既有世界位姿调整语义，
        明确固定的世界位姿不随关节运动改变）或 'parent'（positionM/quaternionXyzw 是相对相机所属 body 的
        局部位姿，每帧用该 body 当前 FK 转成 world，用于腕部/头部挂载相机的安装偏移微调）。
        positionM/quaternionXyzw/fovyDeg 都可单独或组合给出；未给出的位姿字段只继承同一 referenceFrame
        下已有的显式字段，否则取该 frame 下的当前源值（world=当前源相机 FK；parent=源 MJCF 局部安装位姿）。
        referenceFrame 与已有 override 不同会在当前 FK 上做显式安全换算（回执 frameConverted=true 与
        convertedFromFrame），绝不静默混用坐标。FOV-only 且没有显式位姿字段时不冻结姿态：
        每次渲染/标定都用当前源相机 FK。clear=true 与三个字段互斥；非 clear 时至少给一个字段。"""
        self.require_ready()
        expected = options.get('expectedGeneration')
        if isinstance(expected, bool) or not isinstance(expected, int):
            raise SimError('INVALID_ARGUMENT', 'expectedGeneration 必须是整数')
        if expected != self.generation:
            raise SimError('STALE_GENERATION', '相机调整代次已过期: 请求 ' + str(expected) + '，当前 ' + str(self.generation))
        name = options.get('cameraName')
        resolved_name = self.resolve_camera_name(name)
        frame = options.get('referenceFrame', 'world')
        if frame not in ('world', 'parent'):
            raise SimError('INVALID_ARGUMENT', "referenceFrame 必须是 'world' 或 'parent'")
        width, height = self._camera_resolution(options)
        # 父 body FK 与源位姿在下面的局部更新/换算里会被读取，先对齐到当前积分状态（不推进物理钟）。
        self.refresh_derived()
        camid = mj.mj_name2id(self.model, mj.mjtObj.mjOBJ_CAMERA, resolved_name)
        if camid < 0:
            raise SimError('CAMERA_NOT_FOUND', '原生相机不存在: ' + resolved_name)
        base = {**self._camera_frame_identity(), 'cameraName': name, 'resolvedCameraName': resolved_name,
                'parentBodyName': self._camera_parent_body_name(camid), 'referenceFrame': frame,
                'source': 'camera-adjust-temporary-override', 'clearsOn': ['sim_close', 'sim_sync', 'camera_adjust(clear)']}
        clear = options.get('clear')
        if clear is not None and not isinstance(clear, bool):
            raise SimError('INVALID_ARGUMENT', 'clear 必须是布尔值')
        position, quaternion, fovy = options.get('positionM'), options.get('quaternionXyzw'), options.get('fovyDeg')
        provided = [field for field, value in (('positionM', position), ('quaternionXyzw', quaternion), ('fovyDeg', fovy)) if value is not None]
        if clear:
            if provided:
                raise SimError('INVALID_ARGUMENT', 'clear=true 与 positionM/quaternionXyzw/fovyDeg 互斥，不能同时给出')
            existed = self.camera_overrides.pop(resolved_name, None)
            return {**base, 'override': False, 'cleared': existed is not None,
                    'calibration': self._camera_calibration(resolved_name, width, height)}
        if not provided:
            raise SimError('INVALID_ARGUMENT', '至少给出 positionM/quaternionXyzw/fovyDeg 之一；清除 override 请用 clear=true')
        if position is not None:
            if not isinstance(position, (list, tuple)) or len(position) != 3:
                raise SimError('INVALID_ARGUMENT', 'positionM 必须是 3 个数')
            position = [finite(v, 'positionM[' + str(i) + ']') for i, v in enumerate(position)]
        if quaternion is not None:
            if not isinstance(quaternion, (list, tuple)) or len(quaternion) != 4:
                raise SimError('INVALID_ARGUMENT', 'quaternionXyzw 必须是 4 个数')
            quaternion = [finite(v, 'quaternionXyzw[' + str(i) + ']') for i, v in enumerate(quaternion)]
            norm = math.sqrt(sum(v * v for v in quaternion))
            if norm < 1e-8:
                raise SimError('INVALID_ARGUMENT', 'quaternionXyzw 不能是零四元数')
            quaternion = [v / norm for v in quaternion]
        if fovy is not None:
            fovy = finite(fovy, 'fovyDeg')
            if not 0 < fovy < 180:
                raise SimError('INVALID_ARGUMENT', 'fovyDeg 必须在 (0, 180) 开区间（源相机被替换的垂直视场）')
        # 局部更新：同 frame 下未给出的字段继承已有显式字段，否则取该 frame 的当前源值；
        # frame 切换时先把旧 override 的显式字段安全换算到目标 frame（未显式覆盖的自由度不换算，
        # 本次显式给出的字段用输入值、不参与换算），回执只标注真正被继承下来的换算字段。
        position_provided, quaternion_provided = position is not None, quaternion is not None
        previous = self.camera_overrides.get(resolved_name)
        converted_fields, converted_from = [], None
        if previous is not None and previous['referenceFrame'] != frame:
            converted_from = previous['referenceFrame']
            previous, converted_fields = self._convert_camera_override(camid, previous, frame)
            converted_fields = [field for field in converted_fields
                                if (field == 'positionM' and not position_provided) or (field == 'quaternionXyzw' and not quaternion_provided)]
        position_overridden = position is not None or bool(previous and previous.get('positionOverridden'))
        quaternion_overridden = quaternion is not None or bool(previous and previous.get('quaternionOverridden'))
        fovy_overridden = fovy is not None or bool(previous and previous.get('fovyOverridden'))
        source_local_position, source_local_quaternion = self._camera_source_local_pose(camid)
        if position is None:
            if previous and previous.get('positionOverridden'):
                position = [float(v) for v in previous['positionM']]
            elif frame == 'parent':
                position = source_local_position
            else:
                position = [float(v) for v in self.data.cam_xpos[camid]]
        if quaternion is None:
            if previous and previous.get('quaternionOverridden'):
                quaternion = [float(v) for v in previous['quaternionXyzw']]
            elif frame == 'parent':
                quaternion = source_local_quaternion
            else:
                # self.data.cam_xmat 是 world-from-camera 旋转矩阵（扁平 9 元，mju_mat2Quat 需要）；转成 [x,y,z,w]。
                quaternion = self._quaternion_from_matrix(self.data.cam_xmat[camid])
        if fovy is None:
            # 未显式给 fovyDeg 时的取值：继承已有 override，否则取源相机的**生效**竖直视场
            # （内参相机由 K 派生，与 model.cam_fovy 的派生值一致；fovy 相机就是 cam_fovy）。
            fovy = (float(previous['fovyDeg']) if previous and previous.get('fovyOverridden') and previous['fovyDeg'] is not None
                    else float(self._camera_effective_intrinsics(camid, width, height, None)['fovyDeg']))
        self.camera_overrides[resolved_name] = {'cameraName': name, 'referenceFrame': frame,
                                                'positionM': position, 'quaternionXyzw': quaternion,
                                                'positionOverridden': position_overridden, 'quaternionOverridden': quaternion_overridden,
                                                'fovyDeg': fovy, 'fovyOverridden': fovy_overridden,
                                                'generation': self.generation, 'stepIndex': self.step_index}
        effective = self._camera_calibration(resolved_name, width, height)
        receipt = {**base, 'override': True, 'worldGeneration': self.generation,
                   'positionOverridden': position_overridden, 'quaternionOverridden': quaternion_overridden,
                   'positionM': position, 'quaternionXyzw': quaternion,
                   'fovyDeg': effective['intrinsics']['fovyDeg'], 'fovyOverridden': fovy_overridden,
                   # 内参相机的 fovyDeg 调整实际落在焦距上（cam_fovy 对它们惰性），如实标出这一支。
                   **({'fovyApplied': 'cam_fovy' if effective['intrinsicsSource'] == 'fovy' else 'intrinsic-focal-rescale'}
                      if fovy_overridden else {}),
                   'intrinsicsSource': effective['intrinsicsSource'],
                   'intrinsicsAtReferenceResolution': effective['intrinsics'],
                   'worldFromCamera': effective['worldFromCamera'],
                   **self._camera_mount_readback(camid, effective['worldFromCamera']['positionM'],
                                                np.asarray(effective['worldFromCamera']['rotationMatrix'])),
                   'appliesTo': ['camera_capture_multi', 'sensor_capture', 'calibration']}
        if converted_fields:
            receipt.update({'frameConverted': True, 'convertedFromFrame': converted_from, 'convertedFields': converted_fields})
        return receipt

    def capture_multi(self, options):
        """同一 stepIndex/simTime 一次采集全部已命名相机；物理钟不推进，帧身份只取一次。"""
        self.require_ready()
        names = options.get('cameraNames')
        if not isinstance(names, list) or isinstance(names, bool) or not names:
            raise SimError('INVALID_ARGUMENT', 'cameraNames 必须是非空数组（至少一个已命名相机）')
        if len(names) > 16:
            raise SimError('INVALID_ARGUMENT', 'cameraNames 一次最多 16 个相机')
        resolved_names, seen = [], set()
        for value in names:
            if not isinstance(value, str) or not value.strip():
                raise SimError('INVALID_ARGUMENT', 'cameraNames 每项必须是非空字符串')
            name = value.strip()
            if name in seen:
                raise SimError('INVALID_ARGUMENT', 'cameraNames 不能包含重复相机: ' + name)
            seen.add(name)
            resolved_names.append((name, self.resolve_camera_name(name)))
        width, height = self._camera_resolution(options)
        groups = self.display_groups(options.get('geomGroups'))
        scene_option = self._scene_option_for(groups)
        root = Path(options['outputDir']).resolve()
        root.mkdir(parents=True, exist_ok=True)
        # 渲染前走同一个派生量刷新点（mj_step 后 qpos 已积分到当前时刻），不额外推进物理钟。
        self.refresh_derived()
        self.model.vis.global_.offwidth = max(width, self.model.vis.global_.offwidth)
        self.model.vis.global_.offheight = max(height, self.model.vis.global_.offheight)
        renderer = mj.Renderer(self.model, height=height, width=width)
        capture_id = str(uuid.uuid4())
        try:
            cameras = []
            for name, resolved_name in resolved_names:
                rgb, depth = self._render_named_camera(renderer, resolved_name, scene_option)
                cameras.append(self._capture_entry(name, resolved_name, rgb, depth, width, height, root))
        finally:
            renderer.close()
        effective = scene_option if scene_option is not None else mj.MjvOption()
        result = {**self._camera_frame_identity(),
                  'source': 'mujoco-renderer', 'captureId': capture_id, 'multi': len(cameras) > 1,
                  'cameraNames': [name for name, _ in resolved_names], 'width': width, 'height': height,
                  'cameras': cameras, 'observation': self.observe({'sensors': True, 'contacts': True})}
        result['renderOption'] = {'geomGroups': [i for i in range(len(effective.geomgroup)) if effective.geomgroup[i]], 'explicitGeomGroups': groups is not None, 'appliesTo': ['rgb', 'depth']}
        self._remember_capture(capture_id, result, cameras)
        return result

    def capture(self, options):
        self.require_ready()
        name = options.get('cameraName')
        if name:
            multi = self.capture_multi({**options, 'cameraNames': [name]})
            entry = multi['cameras'][0]
            result = {key: multi[key] for key in ('worldId', 'generation', 'stepIndex', 'simTime', 'sceneRevision', 'appliedSceneRevision', 'frameId', 'source', 'captureId', 'width', 'height', 'renderOption', 'observation')}
            result.update({'cameraName': name, 'resolvedCameraName': entry['resolvedCameraName'], 'rgb': entry['rgb'], 'depth': entry['depth'],
                           'depthRangeM': entry['depthRangeM'], 'calibration': entry['calibration'],
                           **{key: entry[key] for key in ('parentBodyName', 'parentFromCamera', 'worldFromParent')},
                           **{key: entry[key] for key in ('parentEntityId', 'mount') if key in entry},
                           'override': entry['override'], 'worldGeneration': entry['worldGeneration']})
            return result
        # 自由相机路径保持旧行为：不声明稳定位姿/内参（无法为它建立临时 override）。
        self.refresh_derived()
        width, height = self._camera_resolution(options)
        groups = self.display_groups(options.get('geomGroups'))
        scene_option = self._scene_option_for(groups)
        root = Path(options['outputDir']).resolve()
        root.mkdir(parents=True, exist_ok=True)
        camera = mj.MjvCamera()
        mj.mjv_defaultFreeCamera(self.model, camera)
        self.model.vis.global_.offwidth = max(width, self.model.vis.global_.offwidth)
        self.model.vis.global_.offheight = max(height, self.model.vis.global_.offheight)
        renderer = mj.Renderer(self.model, height=height, width=width)
        try:
            renderer.update_scene(self.data, camera=camera, scene_option=scene_option)
            rgb = renderer.render().copy()
            renderer.enable_depth_rendering()
            renderer.update_scene(self.data, camera=camera, scene_option=scene_option)
            depth = renderer.render().copy()
        finally:
            renderer.close()
        stem = str(uuid.uuid4())
        rgbpath, depthpath = root / (stem + '.png'), root / (stem + '-depth.npy')
        self._write_rgb_png(rgbpath, rgb, width, height)
        np.save(depthpath, depth)
        capture_id = str(uuid.uuid4())
        result = {'worldId': self.id, 'generation': self.generation, 'stepIndex': self.step_index, 'simTime': float(self.data.time), 'sceneRevision': self.applied_revision, 'frameId': f'{self.id}:{self.generation}:{self.step_index}', 'source': 'mujoco-renderer', 'captureId': capture_id, 'multi': False, 'cameraName': 'free', 'resolvedCameraName': 'free', 'width': width, 'height': height, 'rgb': {'uri': rgbpath.as_uri(), 'mimeType': 'image/png'}, 'depth': {'uri': depthpath.as_uri(), 'mimeType': 'application/x-npy', 'units': 'm'}, 'depthRangeM': [float(np.min(depth)), float(np.max(depth))], 'override': False}
        effective = scene_option if scene_option is not None else mj.MjvOption()
        result['renderOption'] = {'geomGroups': [i for i in range(len(effective.geomgroup)) if effective.geomgroup[i]], 'explicitGeomGroups': groups is not None, 'appliesTo': ['rgb', 'depth']}
        self._remember_capture(capture_id, result, [{'cameraName': 'free', 'resolvedCameraName': 'free', 'override': False, 'width': width, 'height': height, 'rgb': result['rgb'], 'depth': result['depth'], 'depthRangeM': result['depthRangeM'], 'annotationIds': []}])
        return result

    def _render_depth_only(self, resolved_name, width, height, groups):
        """标注自校验用的真实深度渲染（不落盘、不推进物理钟）。"""
        scene_option = self._scene_option_for(groups)
        self.model.vis.global_.offwidth = max(width, self.model.vis.global_.offwidth)
        self.model.vis.global_.offheight = max(height, self.model.vis.global_.offheight)
        renderer = mj.Renderer(self.model, height=height, width=width)
        try:
            restore = self._pin_camera_override(resolved_name)
            try:
                renderer.enable_depth_rendering()
                renderer.update_scene(self.data, camera=resolved_name, scene_option=scene_option)
                return renderer.render().copy()
            finally:
                if restore:
                    restore()
        finally:
            renderer.close()

    def project_annotation(self, options):
        """像素+真实米制深度 → camera/world 坐标；深度必须与真实渲染一致，不可伪造。
        引用的 capture 必须与**当前世界代次**同代（`sync` 之后旧 capture 的深度/标定可能已不同步）
        ⇒ 旧代次明确拒绝为 `STALE_GENERATION`，与 Isaac 侧同码同义。"""
        self.require_ready()
        name = options.get('cameraName')
        resolved_name = self.resolve_camera_name(name)
        pixel = options.get('pixel')
        if not isinstance(pixel, (list, tuple)) or isinstance(pixel, bool) or len(pixel) != 2:
            raise SimError('INVALID_ARGUMENT', 'pixel 必须是 [u, v] 两个数')
        u, v = finite(pixel[0], 'pixel[0]'), finite(pixel[1], 'pixel[1]')
        if u != int(round(u)) or v != int(round(v)):
            raise SimError('INVALID_ARGUMENT', '标注像素必须是整数像素坐标 (u, v)')
        u, v = int(round(u)), int(round(v))
        provided = options.get('depthM')
        if provided is not None:
            provided = finite(provided, 'depthM')
            if provided <= 0:
                raise SimError('INVALID_ARGUMENT', 'depthM 必须是大于零的米制深度')
        capture_id = options.get('captureId')
        record, entry, width, height, depth_source = None, None, None, None, None
        if capture_id is not None:
            if not isinstance(capture_id, str) or not capture_id:
                raise SimError('INVALID_ARGUMENT', 'captureId 必须是非空字符串')
            record = self.captures.get(capture_id)
            if record is None:
                raise SimError('CAPTURE_NOT_FOUND', 'captureId 不存在于当前 world（标注只能引用真实采集）: ' + capture_id)
            # 与 Isaac 侧同语义（`camera_math.select_capture` 的 STALE_GENERATION）：capture 属于旧世界代次时，
            # 它的深度/标定可能与当前场景已经不同步 ⇒ 明确拒绝，而不是照旧算一个世界点。
            if record.get('generation') != self.generation:
                raise SimError('STALE_GENERATION', '该 capture 属于旧世界代次（采集时 generation=' + str(record.get('generation'))
                               + '，当前 ' + str(self.generation) + '）：标定与像素可能已经不同步，拒绝而不是照旧算一个世界点')
            entry = next((item for item in record['cameras'] if item['cameraName'] == name or item['resolvedCameraName'] == resolved_name), None)
            if entry is None:
                raise SimError('CAMERA_NOT_IN_CAPTURE', '该 capture 没有相机: ' + name)
            if entry.get('ephemeral') or record.get('ephemeral'):
                raise SimError('CAPTURE_NOT_REUSABLE', '该 capture 的深度未落盘，不能再次标注: ' + capture_id)
            width, height, depth_source = record['width'], record['height'], 'capture-depth-npy'
        else:
            width, height = self._camera_resolution(options)
            depth_source = 'fresh-render'
        if not 0 <= u <= width - 1 or not 0 <= v <= height - 1:
            raise SimError('PIXEL_OUT_OF_BOUNDS', f'像素 ({u},{v}) 超出图像范围 {width}x{height}')
        if entry is not None:
            depth = np.load(path_from_uri(entry['depth']['uri']))
            actual = float(depth[v, u])
            calibration = entry['calibration']
            provenance = {'captureId': record['captureId'], 'frameId': record['frameId'], 'stepIndex': record['stepIndex'], 'simTime': record['simTime'],
                          'sceneRevision': record['sceneRevision'], 'generation': record['generation'], 'calibrationSource': 'capture-receipt',
                          'override': bool(entry.get('override')), 'captureWorldGeneration': entry.get('worldGeneration')}
        else:
            self.refresh_derived()
            depth = self._render_depth_only(resolved_name, width, height, self.display_groups(options.get('geomGroups')))
            actual = float(depth[v, u])
            calibration = self._camera_calibration(resolved_name, width, height)
            provenance = {'captureId': None, 'frameId': f'{self.id}:{self.generation}:{self.step_index}', 'stepIndex': self.step_index,
                          'simTime': float(self.data.time), 'sceneRevision': self.applied_revision, 'generation': self.generation,
                          'calibrationSource': 'fresh-render-at-annotation-step', 'override': resolved_name in self.camera_overrides,
                          'captureWorldGeneration': self.generation}
        # 背景/远平面像素线性化后等于 far = zfar·extent（含贴近地平线被远平面截断的像素）；
        # 用相对容差判定，避免 float32 往返误差把远平面像素误当有效深度。
        if not math.isfinite(actual) or actual <= 0 or actual >= self._camera_far_depth() * (1 - 1e-6):
            raise SimError('ANNOTATION_NO_DEPTH', f'像素 ({u},{v}) 没有有效米制深度（背景/远平面/无效值）: {actual}')
        if provided is not None and abs(provided - actual) > max(1e-9, 1e-6 * actual):
            raise SimError('ANNOTATION_DEPTH_MISMATCH', f'depthM={provided} 与该 capture 的真实深度 {actual} 不一致；深度必须来自真实渲染')
        intrinsics = calibration['intrinsics']
        if not intrinsics['fx'] or not intrinsics['fy']:
            raise SimError('CALIBRATION_REQUIRED', '该相机缺少可用内参')
        d = actual
        camera_point = [(u - intrinsics['cx']) * d / intrinsics['fx'], -(v - intrinsics['cy']) * d / intrinsics['fy'], -d]
        rotation = np.asarray(calibration['worldFromCamera']['rotationMatrix'], dtype=float)
        translation = np.asarray(calibration['worldFromCamera']['positionM'], dtype=float)
        world_point = (rotation @ np.asarray(camera_point, dtype=float)) + translation
        annotation = {
            'annotationId': str(uuid.uuid4()), 'worldId': self.id,
            'worldGeneration': provenance['captureWorldGeneration'], 'currentWorldGeneration': self.generation,
            'generation': provenance['generation'], 'sceneRevision': provenance['sceneRevision'],
            'frameId': provenance['frameId'], 'stepIndex': provenance['stepIndex'], 'simTime': provenance['simTime'],
            'cameraName': name, 'resolvedCameraName': resolved_name,
            'pixel': [u, v], 'depthM': actual, 'depthSource': depth_source, 'depthProvided': provided is not None,
            'cameraPointM': [float(v_) for v_ in camera_point], 'worldPointM': [float(v_) for v_ in world_point],
            'resolution': {'width': width, 'height': height},
            'fov': {'fovyDeg': intrinsics['fovyDeg'], 'fx': intrinsics['fx'], 'fy': intrinsics['fy'], 'cx': intrinsics['cx'], 'cy': intrinsics['cy']},
            'intrinsicsSource': calibration['intrinsicsSource'],
            'override': provenance['override'], 'captureId': provenance['captureId'], 'calibrationSource': provenance['calibrationSource'],
            'backgroundDepthM': self._camera_far_depth(),
        }
        if record is not None:
            record['annotations'].append(annotation)
        else:
            # 无 captureId 的标注：为可追溯性记下本次真实渲染的标定来源（深度未落盘，不再二次标注）。
            ephemeral_id = 'annotation-' + annotation['annotationId']
            self.captures[ephemeral_id] = {'captureId': ephemeral_id, 'worldId': self.id, 'generation': self.generation,
                                           'sceneRevision': self.applied_revision, 'stepIndex': self.step_index, 'simTime': float(self.data.time),
                                           'frameId': annotation['frameId'], 'width': width, 'height': height, 'multi': False, 'ephemeral': True,
                                           'cameras': [{'cameraName': name, 'resolvedCameraName': resolved_name, 'override': annotation['override'],
                                                        'ephemeral': True, 'depthRangeM': [actual, actual], 'annotationIds': []}],
                                           'annotations': [annotation]}
            annotation['captureId'] = ephemeral_id
        return annotation

    def export_camera_dataset(self, options):
        """把真实采集（+标定+标注引用）导出成自包含训练数据集；只引用已记录的真实产物。
        每个 captureId 必须与**当前世界代次**同代 ⇒ 旧代次明确拒绝为 `STALE_GENERATION`
        （与 Isaac 侧同码同义），且拒绝发生在建目录/拷文件之前。"""
        self.require_ready()
        capture_ids = options.get('captureIds')
        if not isinstance(capture_ids, list) or isinstance(capture_ids, bool) or not capture_ids:
            raise SimError('INVALID_ARGUMENT', 'captureIds 必须是非空数组（至少一个 captureId）')
        seen = set()
        for value in capture_ids:
            if not isinstance(value, str) or not value:
                raise SimError('INVALID_ARGUMENT', 'captureIds 每项必须是非空字符串')
            if value in seen:
                raise SimError('INVALID_ARGUMENT', 'captureIds 不能重复: ' + value)
            seen.add(value)
            if value not in self.captures:
                raise SimError('CAPTURE_NOT_FOUND', 'captureId 不存在于当前 world: ' + value)
            # 与 Isaac 侧同语义（`camera_dataset.export_dataset` 的 STALE_GENERATION）：守卫在 mkdir/拷文件之前，
            # 旧代次采集被拒时不留半份数据集。
            record = self.captures[value]
            if record.get('generation') != self.generation:
                raise SimError('STALE_GENERATION', 'captureId ' + value + ' 属于旧世界代次（采集时 generation=' + str(record.get('generation'))
                               + '，当前 ' + str(self.generation) + '）：拒绝导出可能已过期的采集')
        target = Path(options['outputDir']).resolve()
        for kind in ('rgb', 'depth'):
            (target / kind).mkdir(parents=True, exist_ok=True)
        dataset_id = str(uuid.uuid4())
        samples, cameras_index, files, missing, annotation_rows = [], {}, [], [], []
        frame_ids = set()
        for index, capture_id in enumerate(capture_ids):
            record = self.captures[capture_id]
            frame_ids.add(record['frameId'])
            for entry in record['cameras']:
                key = entry['resolvedCameraName'] or 'free'
                safe = re.sub(r'[^A-Za-z0-9_.-]', '_', key)
                row = {'captureId': capture_id, 'frameId': record['frameId'], 'stepIndex': record['stepIndex'], 'simTime': record['simTime'],
                       'sceneRevision': record['sceneRevision'], 'generation': record['generation'], 'worldId': record['worldId'],
                       'cameraName': entry['cameraName'], 'resolvedCameraName': entry['resolvedCameraName'],
                       'override': bool(entry.get('override')), 'worldGeneration': entry.get('worldGeneration'),
                       'resolution': {'width': record['width'], 'height': record['height']},
                       'calibration': entry.get('calibration'), 'annotationIds': [a['annotationId'] for a in record['annotations'] if a['cameraName'] == entry['cameraName'] or a['resolvedCameraName'] == entry['resolvedCameraName']],
                       'rgb': None, 'depth': None}
                for kind, extension in (('rgb', 'png'), ('depth', 'npy')):
                    source = (entry.get(kind) or {}).get('uri')
                    if not isinstance(source, str):
                        continue
                    origin = path_from_uri(source)
                    if not Path(origin).is_file():
                        missing.append({'captureId': capture_id, 'cameraName': entry['cameraName'], 'kind': kind, 'uri': source, 'reason': 'FILE_MISSING'})
                        continue
                    relative = kind + '/' + str(index) + '-' + safe + '.' + extension
                    shutil.copyfile(origin, target / relative)
                    files.append(relative)
                    row[kind] = relative
                samples.append(row)
                if entry.get('calibration'):
                    bucket = cameras_index.setdefault(key, {'cameraName': entry['cameraName'], 'resolvedCameraName': entry['resolvedCameraName'],
                                                            'calibration': entry['calibration'], 'sources': []})
                    bucket['calibration'] = entry['calibration']
                    bucket['sources'].append({'captureId': capture_id, 'frameId': record['frameId'], 'stepIndex': record['stepIndex'],
                                              'override': bool(entry.get('override')), 'worldGeneration': entry.get('worldGeneration')})
            annotation_rows.extend(record['annotations'])
        payload = {'format': 'lyapunov-camera-dataset-v1', 'datasetId': dataset_id, 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                   'worldId': self.id, 'sceneId': self.scene['sceneId'], 'engine': 'mujoco', 'cameraNames': sorted(cameras_index),
                   'captureIds': list(capture_ids), 'frameCount': len(frame_ids), 'sampleCount': len(samples),
                   'multiView': len({row['frameId'] for row in samples}) < len(samples),
                   'samples': 'samples.jsonl', 'calibration': 'calibration.json', 'annotations': 'annotations.json',
                   'annotationCount': len(annotation_rows), 'files': files, 'missing': missing,
                   'status': 'PARTIAL' if missing else 'completed',
                   'source': '来自真实 MuJoCo 渲染的 RGB/米制深度与 capture 回执标定；同 frameId 的多相机是同一物理步采集，不同 frameId 不拼为同步'}
        (target / 'samples.jsonl').write_text('\n'.join(json.dumps(row, allow_nan=False) for row in samples) + ('\n' if samples else ''))
        (target / 'calibration.json').write_text(json.dumps({'cameras': cameras_index}, indent=2, allow_nan=False))
        (target / 'annotations.json').write_text(json.dumps({'annotations': annotation_rows}, indent=2, allow_nan=False))
        (target / 'dataset.json').write_text(json.dumps(payload, indent=2, allow_nan=False))
        return {**payload, 'directory': str(target), 'datasetPath': str(target / 'dataset.json'), 'samplesPath': str(target / 'samples.jsonl'),
                'calibrationPath': str(target / 'calibration.json'), 'annotationsPath': str(target / 'annotations.json')}

    def close(self):
        self.stop({})
        self.status = 'closed'
        self.model = self.data = None
        self.entities = {}
        self.spec = None
        self.child_specs = []
        # 临时相机 override 只属于这个 world 的生命周期；关闭即清除，源 Scene/MJCF 从未被改。
        self.camera_overrides = {}
        self.captures = {}


requests = queue.Queue()
def read_requests():
    for line in sys.stdin:
        try:
            requests.put(json.loads(line))
        except Exception as exc:
            emit({'event': 'protocol-error', 'error': str(exc)})
    requests.put({'method': 'shutdown', 'id': '__eof'})


FACT_ENV_KEYS = (
    'LYAPUNOV_SIM_SESSION', 'LYAPUNOV_SIM_RUNTIME_ROOT', 'LYAPUNOV_SIM_SANDBOX_MODE',
    'LYAPUNOV_SIM_WORKSPACE_ROOT', 'LYAPUNOV_SIM_ENFORCEMENT', 'LYAPUNOV_SIM_RUNNER',
)


def execution_facts():
    """本 worker 启动时**实际收到**的执行事实（会话身份、会话运行根、生效文件效果模式）。

    由装配方在 spawn 前经环境显式给出（原生 sandboxPolicy 解析结果 + 本会话运行根）。
    未接线的启动这里是空 dict——绝不猜一个默认值冒充"沙箱已生效"。
    """
    return {key: os.environ[key] for key in FACT_ENV_KEYS if os.environ.get(key)}


def record_execution_facts(facts):
    """把执行事实写进本会话运行根（best effort），供宿主与验收按会话核对。

    写不进去（只读模式、运行根在授权根之外）是**真实拒绝**：如实回一条写到 stderr 的
    runtime-facts-write-denied，不假装写过，也不换一个位置偷偷写。
    """
    root = facts.get('LYAPUNOV_SIM_RUNTIME_ROOT')
    if not root:
        return
    payload = dict(facts, pid=os.getpid(), engine='mujoco', version=mj.__version__, cwd=os.getcwd())
    try:
        target = Path(root)
        target.mkdir(parents=True, exist_ok=True)
        (target / 'worker.json').write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    except OSError as exc:
        print(json.dumps({'event': 'runtime-facts-write-denied', 'runtimeRoot': root, 'error': str(exc)},
                         ensure_ascii=False, separators=(',', ':')), file=sys.stderr, flush=True)


def main():
    threading.Thread(target=read_requests, daemon=True).start()
    worlds = {}
    facts = execution_facts()
    record_execution_facts(facts)
    emit({'event': 'ready', 'engine': 'mujoco', 'version': mj.__version__, 'pid': os.getpid(), 'runtime': facts,'capabilities':{'engine':'mujoco','supported':{'convexTriangleMesh':True,'declaredStaticTriangleSurface':tuple(int(v) for v in mj.__version__.split('.')[:2])>=(3,13) and hasattr(mj.MjSpec,'add_flex')},'unsupported':{'nonconvexTriangleMesh':'MUJOCO_TRIANGLE_SURFACE_UNSUPPORTED','sampledVoxelSurface':'MUJOCO_SAMPLED_SURFACE_UNSUPPORTED'},'notes':['明确meshTopology=static-triangles的静态/环境表示使用Mu3.13刚性三角flex，半厚度1e-9m；未声明拓扑的普通mesh保持既有凸包规则，明确凹/开放三角面或采样union边界仍拒绝；不自动切引擎，真实接触以当前世界Frame为准']}})
    running = True
    while running:
        batch = []
        # 没有需要推进的时钟时直接等待现有请求队列；手动世界在推理间隙
        # 不空转，也不以固定sleep人为增加每次控制请求的等待时间。
        if not any(w.status in ('ready', 'running') and (w.clock == 'realtime' or w.active) for w in worlds.values()):
            batch.append(requests.get())
        while not requests.empty():
            batch.append(requests.get_nowait())
        # 请求顺序接纳，execute 立即返回 accepted，stop 不等待动作完成。
        for request in batch:
            rid, method = request.get('id'), request.get('method')
            args = request.get('args', {})
            try:
                if method == 'shutdown':
                    for world in worlds.values():
                        world.close()
                    running = False
                    result = None
                elif method == 'list_worlds':
                    result = [world.handle() for world in worlds.values()]
                elif method == 'open':
                    # collisionPatches 与 sync 同一合同：初始世界即携带场景碰撞环境。
                    world = World(args['snapshot'], args.get('options', {}), collision_patches=args.get('collisionPatches'))
                    if world.id in worlds:
                        world.close()
                        raise SimError('WORLD_EXISTS', 'worldId 已存在')
                    worlds[world.id] = world
                    result = world.handle()
                else:
                    if args['worldId'] not in worlds:
                        raise SimError('WORLD_NOT_FOUND', 'worldId 不存在')
                    world = worlds[args['worldId']]
                    if method == 'sync':
                        # collisionPatches 是可选的场景碰撞补丁（splat 环境的不可见碰撞几何），
                        # 缺省/为 null 时保持旧行为；契约见 check_collision_patches。
                        result = world.sync(args['snapshot'], args.get('options', {}).get('forceRebuild', False), collision_patches=args.get('collisionPatches'))
                    elif method == 'observe':
                        result = world.observe(args.get('selection'))
                    elif method == 'set_paused':
                        result = world.set_paused(args['paused'],args['expectedGeneration'])
                    elif method == 'describe':
                        result = world.describe(args['entityId'])
                    elif method == 'execute':
                        result = world.execute(args['action'])
                    elif method == 'assist':
                        result = world.assist(args['options'])
                    elif method == 'capture_publish':
                        result = world.publish_capture(args['captureId'], args['fromDir'], args['toDir'])
                    elif method == 'capture':
                        result = world.capture(args['options'])
                    elif method == 'capture_multi':
                        result = world.capture_multi(args['options'])
                    elif method == 'camera_list':
                        result = world.camera_list(args.get('options'))
                    elif method == 'camera_adjust':
                        result = world.camera_adjust(args['options'])
                    elif method == 'camera_project_annotation':
                        result = world.project_annotation(args['options'])
                    elif method == 'camera_dataset_export':
                        result = world.export_camera_dataset(args['options'])
                    elif method == 'receipt':
                        if args['actionId'] not in world.receipts:
                            raise SimError('ACTION_NOT_FOUND', 'actionId 未知，先观察世界，不自动重发')
                        result = world.receipts[args['actionId']]
                    elif method == 'stop':
                        result = world.stop(args.get('selection', {}))
                    elif method == 'handle':
                        result = world.handle()
                    elif method == 'close':
                        world.close()
                        del worlds[world.id]
                        result = None
                    else:
                        raise SimError('UNKNOWN_METHOD', '未知方法: ' + str(method))
                emit({'id': rid, 'result': result})
            except Exception as exc:
                emit({'id': rid, 'error': {'code': getattr(exc, 'code', 'ENGINE_ERROR'), 'message': str(exc)}})
        now = time.monotonic()
        for world in list(worlds.values()):
            if not world.paused and now >= world.next_tick and world.status in ('ready', 'running') and (world.clock != 'manual' or world.active):
                try:
                    # 单循环有界追赶，仍在每个迭代处理控制请求。
                    world.tick()
                    world.next_tick = max(world.next_tick + float(world.model.opt.timestep) / world.factor, now - .05)
                except Exception as exc:
                    world.status = 'unavailable'
                    for aid in list(world.active):
                        try:
                            world.finish(aid, 'failed', 'ENGINE_ERROR: ' + str(exc))
                        except Exception:
                            pass
                    emit({'event': 'world-error', 'worldId': world.id, 'error': str(exc)})
        if requests.empty():
            time.sleep(.0001)


if __name__ == '__main__':
    main()
