"""明确的静态原三角表示：刚性 flex 不经普通 mesh 凸包，不改变引擎或源文件。"""
from array import array
import math
from pathlib import Path
import numpy as np
import mujoco as mj

MAX_NODE_BYTES = 64 * 1024 * 1024
SURFACE_RADIUS_M = 1e-9


def declared_static_surface(collision, binding, rigid, eid, error):
    topology = collision.get('meshTopology')
    if topology is None:
        return False
    if topology != 'static-triangles' or collision.get('shape', collision.get('type')) != 'mesh':
        raise error('UNSUPPORTED_CAPABILITY', eid + ' 未支持的明确碰撞拓扑：' + str(topology))
    if binding.get('usage') not in ('static', 'environment') or rigid.get('type', 'static') != 'static':
        raise error('UNSUPPORTED_CAPABILITY', eid + ' static-triangles 只支持明确静态/环境绑定，未作为动态凸件消费')
    if collision.get('surfaceRadiusM') != SURFACE_RADIUS_M:
        raise error('INVALID_ARGUMENT', eid + ' static-triangles 必须明确 surfaceRadiusM=1e-9 m')
    if tuple(int(v) for v in mj.__version__.split('.')[:2]) < (3, 13) or not hasattr(mj.MjSpec, 'add_flex'):
        raise error('UNSUPPORTED_CAPABILITY', eid + ' static-triangles 需要已验 MuJoCo >=3.13 rigid-flex；旧运行时未退回普通mesh凸包')
    return True


def read_surface_obj(path, eid, error):
    """逐行读数值缓冲；单件沿已有几何交接的64MiB预算，不一次读整个文本。"""
    location = Path(path)
    if not location.is_file():
        raise error('COLLISION_MESH_NOT_FOUND', eid + ' 原三角派生件不存在：' + str(location))
    if location.suffix.lower() != '.obj':
        raise error('UNSUPPORTED_CAPABILITY', eid + ' static-triangles 仅消费真实派生OBJ')
    points, indices = array('d'), array('I')
    try:
        with location.open(encoding='utf-8') as stream:
            for line in iter(lambda: stream.readline(65537), ''):
                if len(line) > 65536:
                    raise ValueError('OBJ行超过64KiB文本预算')
                fields = line.split('#', 1)[0].split()
                if not fields:
                    continue
                if fields[0] == 'v':
                    if len(fields) != 4:
                        raise ValueError('顶点必须恰为3个坐标')
                    values = [float(v) for v in fields[1:]]
                    if not all(math.isfinite(v) for v in values):
                        raise ValueError('顶点含非有限值')
                    points.extend(values)
                elif fields[0] == 'f':
                    if len(fields) != 4:
                        raise ValueError('必须为真实三角面，未猜多边形划分')
                    face = [int(v.split('/')[0]) for v in fields[1:]]
                    face = [v-1 if v > 0 else len(points)//3+v for v in face]
                    if any(v < 0 or v >= len(points)//3 for v in face) or len(set(face)) != 3:
                        raise ValueError('三角索引越界或重复；派生必须如实去掉零面积面')
                    indices.extend(face)
                if len(points)*8+len(indices)*4 > MAX_NODE_BYTES:
                    raise error('UNSUPPORTED_CAPABILITY', eid + ' 原三角单件超过64MiB数值预算；未凸化或粗化')
        if len(points) < 9 or not indices:
            raise ValueError('缺少有效表面')
        return np.frombuffer(points, dtype=np.float64).reshape(-1, 3), np.frombuffer(indices, dtype=np.uint32)
    except (OSError, UnicodeError, ValueError, OverflowError) as exc:
        raise error('COLLISION_MESH_INVALID', eid + ' 原三角OBJ无效：' + str(exc)) from exc


def reindex_surface_vertices(points, indices):
    # Mu3.13 的边哈希是 vertex1 XOR vertex2。顺序相邻编号会挤入少数桶，
    # 大场景建边退化。仅重排内部顶点编号；每个三角的坐标、顺序、绕序完全不变。
    if len(points) < 2:
        return points, indices
    permutation = np.random.default_rng(0).permutation(len(points))
    inverse = np.empty(len(points), dtype=np.uint32)
    inverse[permutation] = np.arange(len(points), dtype=np.uint32)
    return points[permutation], inverse[indices]


def add_static_surface(spec, body, name, path, linear, collision, friction, solref, solimp, eid, error):
    points, indices = read_surface_obj(path, eid, error)
    # 完整仿射映射含剪切/反射：逐顶点映射，body继续承载实体的世界位置和旋转。
    points = (linear @ points.T).T
    points, indices = reindex_surface_vertices(points, indices)
    flex = spec.add_flex(name=name, dim=2, radius=SURFACE_RADIUS_M, vertbody=[body.name],
                         vert=points.reshape(-1), elem=indices, internal=False, selfcollide=0,
                         friction=friction, solref=solref, solimp=solimp)
    flex.contype = int(collision.get('contype', 1)) if collision.get('enabled', True) else 0
    flex.conaffinity = int(collision.get('conaffinity', 1)) if collision.get('enabled', True) else 0
    return flex


def contact_side(model, contact, side):
    """接触来自原生 geom 或 flex；geom=-1 不得误当最后一个普通geom。"""
    geom = int(contact.geom[side])
    if geom >= 0:
        return ('geom', geom, model.geom(geom).name)
    flex = int(contact.flex[side])
    if flex >= 0:
        return ('flex', flex, mj.mj_id2name(model, mj.mjtObj.mjOBJ_FLEX, flex))
    return ('unknown', -1, None)
