"""机器人基座装配与元数据；只改 MjSpec 私有实例，不改原件或本体内部关节。"""
import copy
import numpy as np
import mujoco as mj


def source_base(model, root_name=None):
    roots = [i for i in range(1, model.nbody) if int(model.body_parentid[i]) == 0]
    root = mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY, root_name) if root_name else (roots[0] if roots else -1)
    if root < 1 or root not in roots:
        return {'bodyName': root_name or '', 'mode': 'unknown', 'jointTypes': [], 'editable': False}
    types = [int(model.jnt_type[j]) for j in range(model.njnt) if int(model.jnt_bodyid[j]) == root]
    mode = 'free' if types == [int(mj.mjtJoint.mjJNT_FREE)] else 'articulated' if types else 'fixed'
    q = model.body_quat[root]
    return {'bodyName': model.body(root).name, 'mode': mode, 'jointTypes': types, 'massKg': float(model.body_mass[root]), 'editable': mode in ('fixed', 'free'),
            'modelFromBase': {'positionM': model.body_pos[root].tolist(), 'quaternionXyzw': [*q[1:].tolist(), float(q[0])]}}


def configure_source_base(child, source, declaration, error):
    if not declaration or declaration.get('mode') == 'source':
        return
    if not source['editable'] or declaration.get('bodyName') != source['bodyName']:
        raise error('ROBOT_BASE_UNSUPPORTED', '只编辑真实根基座；根上的本体关节或多根布局不能被删除')
    root = child.body(source['bodyName'])
    mode = declaration.get('mode')
    if mode not in ('fixed', 'free'):
        raise error('ROBOT_BASE_MODE_INVALID', '基座 mode 必须为 source/free/fixed')
    target = declaration.get('target') or {}
    # 固定到另一个实体的 body（target.entityId）走**原生刚性装配**：attach 阶段直接把本实体根作为
    # 目标 body 的真实子 body（无关节），因此这里不能保留自由关节；只有 mode='free' 的自由体才保留。
    # 自由的"焊到实体"语义（free + target.entityId）仍保留自由关节，由 compile_bindings 的 weld 拉住。
    want_free = mode == 'free'
    free = [joint for joint in root.joints if int(joint.type) == int(mj.mjtJoint.mjJNT_FREE)]
    changed = False
    if want_free and not free:
        if source.get('massKg', 0) <= 0:
            raise error('ROBOT_BASE_MASS_REQUIRED', '释放根基座需要原件声明的真实正质量')
        root.add_freejoint(name='__lyapunov_base_free')
        changed = True
    elif not want_free:
        for joint in free:
            child.delete(joint)
            changed = True
    if changed:
        # 原件 keyframe 已由调用方按真实关节名读取；改变根 nq 后不用旧长度重新解释原件数组。
        for key in list(child.keys):
            child.delete(key)


def compile_bindings(spec, scene, maps, poses, spec_bodies, error):
    """基座绑定装配。

    mode='fixed' + target.entityId：attach 阶段已把根作为目标 body 的真实子 body（无关节 ⇒ 原生刚性），
    这里先校验真实目标（自指/目标实体或 body 不存在必须拒绝）再跳过 equality weld；
    mode='free' + target.entityId：保留真实的 mjEQ_WELD 软约束语义（根仍是自由关节）；
    世界锚点（无 entityId）：把目标位姿写入根 body 的安装位姿。
    """
    pending = []
    for entity in scene['entities']:
        declaration = (entity.get('components') or {}).get('baseBinding')
        if not declaration or declaration.get('mode') not in ('fixed', 'free'):
            continue
        eid = entity['entityId']; info = maps.get(eid); target = (declaration.get('initialWorldPose') if declaration.get('mode') == 'free' else declaration.get('target')) or {}
        if info is None or not info.get('sourceBase', {}).get('editable'):
            raise error('ROBOT_BASE_UNSUPPORTED', '该实体没有可编辑的原生根基座: ' + eid)
        root = spec.body(eid + '/' + declaration['bodyName'])
        position = np.asarray(target.get('positionM'), dtype=float); xyzw = np.asarray(target.get('quaternionXyzw'), dtype=float)
        if position.shape != (3,) or xyzw.shape != (4,) or not np.isfinite(position).all() or not np.isfinite(xyzw).all() or abs(np.linalg.norm(xyzw) - 1) > 1e-4:
            raise error('ROBOT_BASE_ANCHOR_INVALID', '基座锚点必须是有限 XYZ 米和归一化四元数')
        q = xyzw[[3, 0, 1, 2]]
        if target.get('entityId'):
            # 真实目标校验必须**先于**"是否加 weld"的判断：自指、目标实体/body 不存在都要在这里
            # 明确拒绝。fixed 走原生刚性装配时不能跳过校验，否则会退化成普通挂载、绕过原有拒绝。
            parent = spec.body(target['entityId'] + '/' + str(target.get('bodyName', '')))
            if parent is None or target['entityId'] == eid:
                raise error('ROBOT_BASE_TARGET_MISSING',
                            'Base binding target must be a real body of a different entity: '
                            + str(target.get('entityId')) + '/' + str(target.get('bodyName', '')))
            if declaration.get('mode') == 'fixed':
                # 固定到另一实体：attach 阶段已把根作为目标 body 的真实子 body 刚性装配（无关节），
                # 不再加 equality weld 软约束。保留此分支的 free 语义给 mode='free' + 目标实体。
                continue
            # obj1=父目标，obj2=根；relpose 是父 body←根 body，MuJoCo weld 的真实定义。
            spec.add_equality(name=eid + '/__lyapunov_base_weld', type=mj.mjtEq.mjEQ_WELD, objtype=mj.mjtObj.mjOBJ_BODY,
                              name1=parent.name, name2=root.name, data=[0., 0., 0., *position.tolist(), *q.tolist(), 1.])
            pending.append((eid, target))
        else:
            # 根仍是源 frame 的子 body；目标给世界系，换算回安装 frame 的局部位姿。
            p, frame_q, _ = poses[eid]
            inverse = frame_q.copy(); inverse[1:] *= -1
            rotation = np.zeros(9); mj.mju_quat2Mat(rotation, inverse)
            root.pos = rotation.reshape(3, 3) @ (position - p)
            local_q = np.zeros(4); mj.mju_mulQuat(local_q, inverse, q)
            root.quat = local_q
            spec_bodies[eid] = (root, np.asarray(root.pos, float), np.asarray(root.quat, float))
    return pending


def initialize_bindings(model, data, maps, pending):
    """起始根位姿对齐锚点；之后由真实 weld 维持，不在 tick 中 teleport。"""
    by_id = {eid: info for eid, info in maps.items()}; done = set(); visiting = set()
    targets = dict(pending)
    def align(eid):
        if eid in done: return
        if eid in visiting: raise ValueError('ROBOT_BASE_BINDING_CYCLE')
        visiting.add(eid); target = targets[eid]
        if target['entityId'] in targets: align(target['entityId'])
        mj.mj_forward(model, data)
        parent = model.body(target['entityId'] + '/' + target['bodyName']).id
        info = by_id[eid]; root = info['body']
        free = next((j for j in info['freeJoints'].values() if j['body'] == root), None)
        if free is None: raise ValueError('ROBOT_BASE_FREE_ROOT_MISSING')
        pq = data.xquat[parent]; position = np.asarray(target['positionM'], float)
        rotation = np.zeros(9); mj.mju_quat2Mat(rotation, pq)
        q = np.asarray(target['quaternionXyzw'], float)[[3, 0, 1, 2]]; world_q = np.zeros(4); mj.mju_mulQuat(world_q, pq, q)
        qa = free['qpos']; data.qpos[qa:qa+3] = data.xpos[parent] + rotation.reshape(3, 3) @ position; data.qpos[qa+3:qa+7] = world_q
        visiting.remove(eid); done.add(eid)
    for eid in targets: align(eid)
    mj.mj_forward(model, data)


def body_pose(world, body):
    q = world.data.xquat[body]
    return {'positionM': world.data.xpos[body].tolist(), 'quaternionXyzw': [*q[1:].tolist(), float(q[0])]}


def authoring_description(world, info):
    model = world.model; prefix = info['prefix']; root = info['body']; bodies = []
    for i in range(1, model.nbody):
        if not model.body(i).name.startswith(prefix): continue
        parent = int(model.body_parentid[i]); name = model.body(i).name[len(prefix):]
        types = [mj.mjtJoint(int(model.jnt_type[j])).name.replace('mjJNT_', '').lower() for j in range(model.njnt) if int(model.jnt_bodyid[j]) == i]
        bodies.append({'name': name, 'root': i == root and parent == 0, 'parentName': model.body(parent).name[len(prefix):] if model.body(parent).name.startswith(prefix) else None,
                       'massKg': float(model.body_mass[i]), 'jointTypes': types, 'worldFromBody': body_pose(world, i)})
    sites = []
    for name, i in info['sites'].items():
        q = model.site_quat[i]
        sites.append({'name': name, 'bodyName': model.body(int(model.site_bodyid[i])).name[len(prefix):], 'positionM': model.site_pos[i].tolist(), 'quaternionXyzw': [*q[1:].tolist(), float(q[0])]})
    constraints = []
    root_weld = False
    for i in range(model.neq):
        kind = mj.mjtEq(int(model.eq_type[i])).name.replace('mjEQ_', '').lower(); a = int(model.eq_obj1id[i]); b = int(model.eq_obj2id[i])
        if kind not in ('weld', 'connect') or root not in (a, b): continue
        other = b if a == root else a; full = model.body(other).name if other >= 0 else 'world'; eid, _, local = full.partition('/')
        constraints.append({'name': model.equality(i).name or 'equality-' + str(i), 'kind': kind, 'active': bool(world.data.eq_active[i]), 'bodyName': model.body(root).name[len(prefix):],
                            **({'targetEntityId': eid, 'targetBodyName': local} if local else {'targetBodyName': 'world'})})
        root_weld = root_weld or kind == 'weld' and bool(world.data.eq_active[i])
    types = next((body['jointTypes'] for body in bodies if body['name'] == model.body(root).name[len(prefix):]), [])
    mode = 'free' if types == ['free'] else 'articulated' if types else 'fixed'
    declaration = (info['entity'].get('components') or {}).get('baseBinding'); source = info.get('sourceBase') or {'mode': mode, 'editable': False}
    if root_weld: mode = 'fixed'
    editable = bool(source.get('editable')) and not any(c['active'] and '__lyapunov_base_weld' not in c['name'] for c in constraints)
    # 描述按**实际装配方式**给：只有 fixed + 实体目标才是原生刚性父子；其余实体目标仍是 equality weld
    # 软约束（根保留自由关节）。不能只凭 target.entityId 就宣称刚性。
    binding_target = (declaration or {}).get('target') or {}
    target_entity = binding_target.get('entityId') if declaration else None
    weld_to_entity = next((c for c in constraints if c.get('targetEntityId')), None)
    if declaration and declaration.get('mode') == 'fixed' and target_entity:
        reason = 'Rigidly attached to the target entity body as a native parent-child (no joint); not a soft constraint'
    elif declaration and declaration.get('mode') == 'fixed':
        reason = 'Base fixed at a world anchor; no floor binding declared'
    elif weld_to_entity is not None:
        reason = 'Held to the target entity body by a real equality weld (soft constraint); the base keeps its free joint'
    elif mode == 'fixed':
        reason = 'Base fixed at a world anchor; no floor binding declared'
    elif mode == 'free':
        reason = 'Base root has a real free joint, affected by gravity and contact'
    else:
        reason = 'Root keeps source articulation joints; cannot be treated as a freely switchable base'
    state = {'bodyName': model.body(root).name[len(prefix):], 'mode': mode, 'source': 'scene-base-binding' if declaration else 'native-constraint' if root_weld else 'native-model',
             'sourceMode': source['mode'], 'reason': reason,
             'constraints': constraints, 'worldFromBody': body_pose(world, root), 'editable': {'fixed': editable, 'free': editable, 'entity': editable}}
    if not editable: state['editable']['reason'] = '源根本体关节/约束或质量尚不能保真编辑；内部关节保留'
    if declaration and declaration.get('target'): state['target'] = copy.deepcopy(declaration['target'])
    if source.get('modelFromBase'): state['modelFromBase'] = copy.deepcopy(source['modelFromBase'])
    return {'nativeBodies': bodies, 'nativeSites': sites, 'base': state}


def authoring_observation(world, info, sensors):
    if not info.get('sourceBase'):
        root = info['body']; name = world.model.body(root).name[len(info['prefix']):]
        sensors['bodyWorldPoses'] = {name: {'bodyName': name, **body_pose(world, root)}}
        return
    description = authoring_description(world, info)
    sensors['robotBase'] = description['base']
    sensors['bodyWorldPoses'] = {body['name']: {'bodyName': body['name'], **body['worldFromBody']} for body in description['nativeBodies']}
    tcp = info['controller'].get('tcp')
    if not tcp: return
    if tcp.get('site'):
        sid = info['sites'].get(tcp['site'])
        if sid is None: return
        q = np.zeros(4); mj.mju_mat2Quat(q, world.data.site_xmat[sid])
        pose = {'positionM': world.data.site_xpos[sid].tolist(), 'quaternionXyzw': [*q[1:].tolist(), float(q[0])]}
    else:
        body = mj.mj_name2id(world.model, mj.mjtObj.mjOBJ_BODY, info['prefix'] + tcp.get('body', ''))
        if body < 0: return
        rotation = world.data.xmat[body].reshape(3, 3); offset = np.asarray(tcp.get('offsetM', [0., 0., 0.]), float)
        local = np.asarray(tcp.get('quaternionXyzw', [0., 0., 0., 1.]), float)[[3, 0, 1, 2]]; q = np.zeros(4); mj.mju_mulQuat(q, world.data.xquat[body], local)
        pose = {'positionM': (world.data.xpos[body] + rotation @ offset).tolist(), 'quaternionXyzw': [*q[1:].tolist(), float(q[0])]}
    sensors['tcp'] = {**pose, 'bodyName': tcp['body'], **({'site': tcp['site']} if tcp.get('site') else {}), 'source': 'native-site' if tcp.get('site') else 'native-body-local'}
