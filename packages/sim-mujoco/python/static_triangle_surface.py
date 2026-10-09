"""明确的静态原三角表示：刚性 flex 不经普通 mesh 凸包，不改变引擎或源文件。"""
from array import array
import math
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlparse, unquote
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


def authored_island_selection(cfg, child, error):
    """仅检测原件及include是否明确选择island；有效值仍由Mu已解析的option决定。"""
    visited, pending, found, size = set(), [], False, 0
    def local_xml_path(value):
        if str(value).startswith('file:'):
            parsed = urlparse(str(value))
            if parsed.netloc not in ('', 'localhost'):
                raise error('STATIC_TRIANGLE_ISLAND_SELECTION_UNVERIFIED', '原件求解声明必须为本地文件')
            return Path(unquote(parsed.path))
        return Path(value)
    if cfg.get('sourcePath'):
        pending.append((local_xml_path(cfg['sourcePath']), None))
    else:
        pending.append((None, cfg.get('xml', '')))
    while pending:
        path, text = pending.pop()
        if path is not None:
            key = path.resolve()
            if key in visited:
                continue
            visited.add(key)
            if len(visited) > 64:
                raise error('STATIC_TRIANGLE_ISLAND_SELECTION_UNVERIFIED', '原件include超过64文件，未猜求解选择')
            text = path.read_text(encoding='utf-8')
        size += len(text.encode('utf-8'))
        if size > 8 * 1024 * 1024:
            raise error('STATIC_TRIANGLE_ISLAND_SELECTION_UNVERIFIED', '原件求解声明超过8MiB，未猜island选择')
        root = ET.fromstring(text)
        found |= any('island' in flag.attrib for option in root.iter('option') for flag in option.findall('flag'))
        for include in root.iter('include'):
            filename = include.get('file')
            if filename:
                asset = (cfg.get('assets') or {}).get(filename)
                pending.append((local_xml_path(asset) if asset else (path.parent / filename if path else Path(filename)), None))
    if not found:
        return None
    return 'disable' if child.option.disableflags & int(mj.mjtDisableBit.mjDSBL_ISLAND) else 'enable'


def body_has_dofs(model, body):
    return int(model.body_dofnum[int(model.body_weldid[body])]) > 0


def body_is_static(model, body):
    # 祖先关节和mocap根都能带动当前体；zero-DOF不能单凭叶节点判断。
    while body:
        if int(model.body_dofnum[body]) or int(model.body_mocapid[body]) >= 0:
            return False
        body = int(model.body_parentid[body])
    return True


def flex_is_static(model, fid):
    if not model.flex_rigid[fid]:
        return False
    lo, count = int(model.flex_vertadr[fid]), int(model.flex_vertnum[fid])
    return all(body_is_static(model, int(body)) for body in np.unique(model.flex_vertbodyid[lo:lo + count]))


def configure_derived_static_masks(model, default_prefixes):
    """自动静态原面不互撞；一个未用原生bit保原动态接触矩阵，不改原件几何。"""
    if not default_prefixes:
        return None
    geoms, flexes, used, static_peers = [], [], 0, 0
    for gid in range(model.ngeom):
        ctype, affinity = int(model.geom_contype[gid]), int(model.geom_conaffinity[gid])
        used |= (ctype | affinity) & 0xffffffff
        static_peers += bool((ctype | affinity) & 1 and body_is_static(model, int(model.geom_bodyid[gid])))
        name = mj.mj_id2name(model, mj.mjtObj.mjOBJ_GEOM, gid) or ''
        if ctype == affinity == 1 and body_is_static(model, int(model.geom_bodyid[gid])) and any(name.startswith(p) for p in default_prefixes):
            geoms.append(gid)
    for fid in range(model.nflex):
        ctype, affinity = int(model.flex_contype[fid]), int(model.flex_conaffinity[fid])
        used |= (ctype | affinity) & 0xffffffff
        static_peers += bool((ctype | affinity) & 1 and flex_is_static(model, fid))
        name = mj.mj_id2name(model, mj.mjtObj.mjOBJ_FLEX, fid) or ''
        body = int(model.flex_vertbodyid[int(model.flex_vertadr[fid])])
        if ctype == affinity == 1 and flex_is_static(model, fid) and any(name.startswith(p) for p in default_prefixes):
            flexes.append(fid)
    if not flexes or static_peers < 2:
        return None
    # 避免有符号int32最高位；原件占满可用位时继续原兼容路径，不覆盖自定义mask。
    bit = next((1 << i for i in range(31) if not used & (1 << i)), None)
    if bit is None:
        return None
    for gid in range(model.ngeom):
        if not body_is_static(model, int(model.geom_bodyid[gid])) and (int(model.geom_contype[gid]) | int(model.geom_conaffinity[gid])) & 1:
            model.geom_conaffinity[gid] = int(model.geom_conaffinity[gid]) | bit
    for fid in range(model.nflex):
        body = int(model.flex_vertbodyid[int(model.flex_vertadr[fid])])
        if not flex_is_static(model, fid) and (int(model.flex_contype[fid]) | int(model.flex_conaffinity[fid])) & 1:
            model.flex_conaffinity[fid] = int(model.flex_conaffinity[fid]) | bit
    for gid in geoms:
        model.geom_contype[gid], model.geom_conaffinity[gid] = bit, 0
    for fid in flexes:
        model.flex_contype[fid], model.flex_conaffinity[fid] = bit, 0
    # Mu的bodyflex粗筛使用编译缓存，更新mask后同步对应body的geom聚合位。
    for bid in range(model.nbody):
        lo, count = int(model.body_geomadr[bid]), int(model.body_geomnum[bid])
        ctype, affinity = 0, 0
        for gid in range(lo, lo + count):
            ctype |= int(model.geom_contype[gid]); affinity |= int(model.geom_conaffinity[gid])
        model.body_contype[bid], model.body_conaffinity[bid] = ctype, affinity
    return {'source':'derived-static-pair-filter','reservedBit':bit,'staticGeoms':len(geoms),
            'staticFlexes':len(flexes),'geometryPreserved':True,'interactivePairsPreserved':True}


def configure_static_surface_islands(model, derived_prefixes, explicit_choices, error):
    """仅Scene派生静态rigid-flex与zero-DOF静态形状相遇的3.13兼容路径，不改mask。"""
    geom_types, geom_affinities = 0, 0
    for gid in range(model.ngeom):
        if not body_has_dofs(model, int(model.geom_bodyid[gid])):
            geom_types |= int(model.geom_contype[gid])
            geom_affinities |= int(model.geom_conaffinity[gid])
    static_flexes, type_counts, affinity_counts = {}, [0] * 32, [0] * 32
    for fid in range(model.nflex):
        if not model.flex_rigid[fid] or body_has_dofs(model, int(model.flex_vertbodyid[int(model.flex_vertadr[fid])])):
            continue
        ctype, affinity = int(model.flex_contype[fid]) & 0xffffffff, int(model.flex_conaffinity[fid]) & 0xffffffff
        static_flexes[fid] = (ctype, affinity)
        for bit in range(32):
            type_counts[bit] += bool(ctype & (1 << bit))
            affinity_counts[bit] += bool(affinity & (1 << bit))
    risky = []
    for fid in range(model.nflex):
        name = mj.mj_id2name(model, mj.mjtObj.mjOBJ_FLEX, fid) or ''
        if not model.flex_rigid[fid] or not any(name.startswith(prefix) for prefix in derived_prefixes):
            continue
        body = int(model.flex_vertbodyid[int(model.flex_vertadr[fid])])
        if body_has_dofs(model, body):
            continue
        ctype, affinity = static_flexes[fid]
        other_flex = any((affinity & (1 << bit) and type_counts[bit] > bool(ctype & (1 << bit))) or
                         (ctype & (1 << bit) and affinity_counts[bit] > bool(affinity & (1 << bit))) for bit in range(32))
        if (ctype & geom_affinities) or (geom_types & affinity) or other_flex:
            risky.append(fid)
    if not risky:
        return None
    enabled = [eid for eid, choice in explicit_choices if choice == 'enable']
    if enabled:
        raise error('STATIC_TRIANGLE_ISLAND_EXPLICIT_CONFLICT', ','.join(enabled) +
                    ' 原件明确启island，与Mu3.13静态原三角zero-DOF接触不兼容；未覆盖选择或mask')
    model.opt.disableflags |= int(mj.mjtDisableBit.mjDSBL_ISLAND)
    return {'source':'mujoco-3.13-zero-dof-static-contact','mode':'non-island-solver',
            'derivedStaticFlexes':len(risky),'geometryPreserved':True,'masksPreserved':True}


def zero_dof_contact(model, contact):
    """纯静态接触不是客户的可交互接触；未知/可变形侧保守保留。"""
    for side in (0, 1):
        geom, flex = int(contact.geom[side]), int(contact.flex[side])
        if geom >= 0:
            if not body_is_static(model, int(model.geom_bodyid[geom])):
                return False
        elif flex >= 0 and model.flex_rigid[flex]:
            if not flex_is_static(model, flex):
                return False
        else:
            return False
    return True


def contact_side(model, contact, side):
    """接触来自原生 geom 或 flex；geom=-1 不得误当最后一个普通geom。"""
    geom = int(contact.geom[side])
    if geom >= 0:
        return ('geom', geom, model.geom(geom).name)
    flex = int(contact.flex[side])
    if flex >= 0:
        return ('flex', flex, mj.mj_id2name(model, mj.mjtObj.mjOBJ_FLEX, flex))
    return ('unknown', -1, None)
