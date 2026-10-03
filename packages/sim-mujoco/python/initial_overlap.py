"""同一compiled世界step0的几何相交；零距离不是CLEAR的证据。"""
import math
import mujoco as mj
import numpy as np

TOUCH_EPS_M = 1e-9
MAX_QUERIES = 4096
MAX_MESH_VERTICES = 200000


def box_box_distance(model, data, first, second):
    """真实OBB的完整15轴SAT；负值为最小分离平移，包含时同样有效。"""
    a = data.geom_xmat[first].reshape(3, 3)
    b = data.geom_xmat[second].reshape(3, 3)
    half_a, half_b = model.geom_size[first], model.geom_size[second]
    delta = data.geom_xpos[second] - data.geom_xpos[first]
    axes = [*a.T, *b.T, *(np.cross(u, v) for u in a.T for v in b.T)]
    separation = -math.inf
    for axis in axes:
        length = float(np.linalg.norm(axis))
        if length < 1e-12:
            continue
        direction = axis / length
        radius = float(np.abs(a.T @ direction) @ half_a + np.abs(b.T @ direction) @ half_b)
        separation = max(separation, abs(float(delta @ direction)) - radius)
    return separation


def box_sphere_distance(model, data, box, sphere):
    local = data.geom_xmat[box].reshape(3, 3).T @ (data.geom_xpos[sphere] - data.geom_xpos[box])
    offsets = np.abs(local) - model.geom_size[box]
    signed_center = float(np.linalg.norm(np.maximum(offsets, 0.))) + min(float(np.max(offsets)), 0.)
    return signed_center - float(model.geom_size[sphere, 0])


def plane_distance(model, data, plane, shape):
    """MuJoCo实际单侧平面与编译primitive/convex顶点的最小有符号高度。"""
    normal = data.geom_xmat[plane].reshape(3, 3)[:, 2]
    local_normal = data.geom_xmat[shape].reshape(3, 3).T @ normal
    center = float((data.geom_xpos[shape] - data.geom_xpos[plane]) @ normal)
    kind, size = int(model.geom_type[shape]), model.geom_size[shape]
    if kind == int(mj.mjtGeom.mjGEOM_BOX):
        return center - float(np.abs(local_normal) @ size)
    if kind == int(mj.mjtGeom.mjGEOM_SPHERE):
        return center - float(size[0])
    if kind == int(mj.mjtGeom.mjGEOM_CAPSULE):
        return center - float(size[0] + size[1] * abs(local_normal[2]))
    if kind == int(mj.mjtGeom.mjGEOM_CYLINDER):
        return center - float(size[0] * np.linalg.norm(local_normal[:2]) + size[1] * abs(local_normal[2]))
    if kind == int(mj.mjtGeom.mjGEOM_ELLIPSOID):
        return center - float(np.linalg.norm(size * local_normal))
    if kind == int(mj.mjtGeom.mjGEOM_MESH):
        mesh = int(model.geom_dataid[shape]); count = int(model.mesh_vertnum[mesh])
        if 0 < count <= MAX_MESH_VERTICES:
            start = int(model.mesh_vertadr[mesh])
            # 支持方向的极值对凸包与其编译顶点相同，不读原件/视觉bbox。
            return center + float(np.min(model.mesh_vert[start:start+count] @ local_normal))
    return None


def compiled_distance(model, data, first, second):
    kinds = (int(model.geom_type[first]), int(model.geom_type[second]))
    box, sphere, plane = (int(mj.mjtGeom.mjGEOM_BOX), int(mj.mjtGeom.mjGEOM_SPHERE), int(mj.mjtGeom.mjGEOM_PLANE))
    if kinds == (box, box):
        return box_box_distance(model, data, first, second)
    if kinds == (sphere, sphere):
        return float(np.linalg.norm(data.geom_xpos[first] - data.geom_xpos[second]) - model.geom_size[first, 0] - model.geom_size[second, 0])
    if kinds == (box, sphere):
        return box_sphere_distance(model, data, first, second)
    if kinds == (sphere, box):
        return box_sphere_distance(model, data, second, first)
    if plane in kinds:
        return plane_distance(model, data, first, second) if kinds[0] == plane else plane_distance(model, data, second, first)
    convex = {box, sphere, int(mj.mjtGeom.mjGEOM_CAPSULE), int(mj.mjtGeom.mjGEOM_CYLINDER), int(mj.mjtGeom.mjGEOM_ELLIPSOID), int(mj.mjtGeom.mjGEOM_MESH)}
    if all(kind in convex for kind in kinds):
        # distmax=0会把分离截成0；正边界查询仍可能对包含/未确定返回0。
        distance = float(mj.mj_geomDistance(model, data, first, second, 1., None))
        return distance if math.isfinite(distance) and abs(distance) > TOUCH_EPS_M else None
    return None


def initial_overlap(world, maximum_queries=MAX_QUERIES):
    model, data = world.model, world.data
    pairs, unverified = {}, []
    names = [model.geom(i).name for i in range(model.ngeom)]
    owners = [world.entity_of_geom(name) for name in names]
    explicit = {tuple(sorted((int(a), int(b)))) for a, b in zip(model.pair_geom1, model.pair_geom2)}
    explicit_ids = {gid for pair in explicit for gid in pair}
    active = [i for i in range(model.ngeom) if model.geom_contype[i] or model.geom_conaffinity[i] or i in explicit_ids]

    def permitted(first, second):
        return owners[first] != owners[second] and (tuple(sorted((first, second))) in explicit or
            (model.geom_contype[first] & model.geom_conaffinity[second]) or (model.geom_contype[second] & model.geom_conaffinity[first]))

    def record(first, second, distance):
        if not math.isfinite(distance) or distance >= -TOUCH_EPS_M or not permitted(first, second):
            return
        identity = tuple(sorted((first, second)))
        if identity in pairs and pairs[identity]['depthM'] >= -distance:
            return
        pairs[identity] = {'geom1': names[first], 'geom2': names[second], 'depthM': -distance,
                           **({'entity1': owners[first]} if owners[first] else {}), **({'entity2': owners[second]} if owners[second] else {})}

    for index in range(data.ncon):
        contact = data.contact[index]
        record(int(contact.geom1), int(contact.geom2), float(contact.dist))
    groups = {}
    for gid in active:
        groups.setdefault(owners[gid], []).append(gid)
    grouped = list(groups.values())
    def candidates():
        for index, first_group in enumerate(grouped):
            for second_group in grouped[index+1:]:
                for first in first_group:
                    for second in second_group:
                        yield first, second
    visited = 0
    for first, second in candidates():
        if not permitted(first, second):
            continue
        if visited >= maximum_queries:
            unverified.append('实际候选形状对超过'+str(maximum_queries)+'检查预算，未判CLEAR')
            break
        visited += 1
        radii = model.geom_rbound[[first, second]]
        # 仅用compiled包围球证明远对分离；不据此制造穿透或视觉bbox。
        if np.all(radii > 0) and np.linalg.norm(data.geom_xpos[first] - data.geom_xpos[second]) > float(sum(radii)):
            continue
        try:
            distance = compiled_distance(model, data, first, second)
            identity = tuple(sorted((first, second)))
            if distance is None or not math.isfinite(distance):
                if identity not in pairs:
                    unverified.append(names[first]+' / '+names[second]+' 的原生形状距离零或未支持，包含/轻触未确定')
            else:
                record(first, second, distance)
        except Exception as error:
            unverified.append(names[first]+' / '+names[second]+' 原生几何检查不可用：'+str(error))
    result = {'source': 'mujoco-compiled', 'checkedAtStep': 0, 'sceneRevision': world.applied_revision,
              'status': 'OVERLAP' if pairs else 'UNVERIFIED' if unverified else 'CLEAR',
              'pairs': sorted(pairs.values(), key=lambda pair: pair['depthM'], reverse=True)[:16]}
    if unverified or len(pairs) > 16:
        result['reason'] = '；'.join(unverified[:2]+(['共'+str(len(pairs))+'对，展示最深16对'] if len(pairs)>16 else []))
    return result
