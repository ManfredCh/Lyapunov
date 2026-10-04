"""明确的静态原三角表示：刚性 flex 不经普通 mesh 凸包，不改变引擎或源文件。"""
from array import array
import math
from pathlib import Path
import numpy as np
import mujoco as mj

MAX_NODE_BYTES = 64 * 1024 * 1024
SURFACE_RADIUS_M = 1e-9
MAX_STATIC_ARENA_BYTES = 128 * 1024 * 1024


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
    return len(indices) // 3


def configure_static_surface_arena(spec, triangle_counts, explicit_sources, error):
    """Mu3.13树遍历按两棵BVH节点数保留栈；百万面不能沿用约16MiB自动估计。"""
    if not triangle_counts:
        return None
    # 二叉树至多2N-1节点；mjCollisionTree含两个int32，最大两树遍历按8B/node保留。
    largest_tree = max(2 * max(triangle_counts) - 1, 2 * len(list(spec.geoms)) - 1)
    tree_stack_bytes = 2 * largest_tree * 8
    required = 32 * 1024 * 1024 + tree_stack_bytes  # 其余接触/solver和同时在栈上的查询有界余量
    if required > MAX_STATIC_ARENA_BYTES:
        raise error('STATIC_TRIANGLE_ARENA_BUDGET', '原三角树遍历需要至少' + str(required) +
                    'B，超过128MiB工作arena上限；请采用明确的碰撞资产/分件预算，未删面或粗化')
    for eid, memory, nstack, njmax, nconmax in explicit_sources:
        if any(value >= 0 for value in (nstack, njmax, nconmax)):
            raise error('STATIC_TRIANGLE_ARENA_EXPLICIT_LIMIT', eid +
                        ' 原件声明legacy nstack/njmax/nconmax；未自动覆盖，需明确兼容原三角树的memory限制')
        if memory >= 0:
            if memory < required:
                raise error('STATIC_TRIANGLE_ARENA_EXPLICIT_LIMIT', eid + ' 原件memory=' + str(memory) +
                            'B不足树遍历至少' + str(required) + 'B；未自动提高原件限制')
            spec.memory = memory if spec.memory < 0 else min(spec.memory, memory)
    if spec.memory >= 0:
        if spec.memory < required:
            raise error('STATIC_TRIANGLE_ARENA_EXPLICIT_LIMIT', 'world memory不足至少' + str(required) + 'B；未覆盖')
    else:
        spec.memory = 64 * 1024 * 1024 if required <= 64 * 1024 * 1024 else MAX_STATIC_ARENA_BYTES
    return {'source':'static-triangle-bvh-bound','arenaBytes':spec.memory,
            'requiredBytes':required,'treeStackBytes':tree_stack_bytes,'largestTreeNodesAtMost':largest_tree}


def contact_side(model, contact, side):
    """接触来自原生 geom 或 flex；geom=-1 不得误当最后一个普通geom。"""
    geom = int(contact.geom[side])
    if geom >= 0:
        return ('geom', geom, model.geom(geom).name)
    flex = int(contact.flex[side])
    if flex >= 0:
        return ('flex', flex, mj.mj_id2name(model, mj.mjtObj.mjOBJ_FLEX, flex))
    return ('unknown', -1, None)
