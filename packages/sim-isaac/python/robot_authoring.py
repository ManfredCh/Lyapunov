"""读取并装配真实 USD 基座与 TCP；USD/PhysX 拥有运行状态，Scene 仅声明。"""
import copy
import numpy as np
from pxr import Gf, Sdf, Usd, UsdGeom, UsdPhysics, Tf


def source_base_metadata(model):
    import mujoco as mj
    roots = [i for i in range(1, model.nbody) if int(model.body_parentid[i]) == 0]
    result = []
    for root in roots:
        types = [int(model.jnt_type[j]) for j in range(model.njnt) if int(model.jnt_bodyid[j]) == root]
        mode = 'free' if types == [int(mj.mjtJoint.mjJNT_FREE)] else 'articulated' if types else 'fixed'
        q = model.body_quat[root]
        result.append({'bodyName': model.body(root).name, 'mode': mode, 'massKg': float(model.body_mass[root]), 'editable': mode in ('fixed', 'free'),
                       'modelFromBase': {'positionM': model.body_pos[root].tolist(), 'quaternionXyzw': [*q[1:].tolist(), float(q[0])]}})
    return result


def body_prim(stage, entry, name, error, target=False):
    root = stage.GetPrimAtPath(entry['path'])
    matches = [prim for prim in Usd.PrimRange(root) if prim.GetName() in (name, Tf.MakeValidIdentifier(name)) and prim.IsA(UsdGeom.Xformable) and (prim.HasAPI(UsdPhysics.RigidBodyAPI) or target and entry.get('collision') and str(prim.GetPath()) == entry['path'])]
    if len(matches) != 1:
        raise error('ROBOT_BODY_UNAVAILABLE', '源 body 在真实 USD 刚体里不能唯一定位: ' + name)
    prim = matches[0]
    if target and not prim.HasAPI(UsdPhysics.RigidBodyAPI):
        # 已有真实静态 collider 作为关节端点，需要 PhysX kinematic actor；不生成新形状或质量。
        UsdPhysics.RigidBodyAPI.Apply(prim).CreateKinematicEnabledAttr().Set(True)
        from scene_adapter import RigidPrim
        entry['rigidPaths'].append(str(prim.GetPath())); entry['pose'] = RigidPrim(str(prim.GetPath()))
    return prim


def world_joints(stage, root_path):
    rows = []
    for prim in Usd.PrimRange(stage.GetPseudoRoot()):
        if not prim.IsA(UsdPhysics.Joint): continue
        joint = UsdPhysics.Joint(prim); a = list(joint.GetBody0Rel().GetTargets()); b = list(joint.GetBody1Rel().GetTargets())
        if (not a and b == [root_path]) or (not b and a == [root_path]): rows.append(joint)
    return rows


def pose_matrix(pose):
    q = pose['quaternionXyzw']
    return Gf.Matrix4d(1).SetRotate(Gf.Quatd(q[3], Gf.Vec3d(*q[:3]))).SetTranslateOnly(Gf.Vec3d(*pose['positionM']))


def pose_receipt(matrix):
    q = matrix.RemoveScaleShear().ExtractRotationQuat(); imaginary = q.GetImaginary()
    return {'positionM': [float(v) for v in matrix.ExtractTranslation()], 'quaternionXyzw': [*map(float, imaginary), float(q.GetReal())]}


def capture_model_origin(stage, entry, world_from_model, native_path=None):
    """Capture the imported body's rigid relation to the Resource origin before base edits.

    Gf uses row vectors: rootWorld = rootInModel * modelWorld. Scene scale is
    already present in the imported USD world pose, so its scaled source offset
    is preserved without guessing a root height, a bounding box or a foot.
    """
    from scene_adapter import SceneError
    if native_path is None:
        paths = entry['pose'].paths
        if len(paths) != 1:
            raise SceneError('ENTITY_ORIGIN_UNVERIFIED', 'One native pose is required for entity ' + entry['entity']['entityId'])
        native_path = paths[0]
        prim = stage.GetPrimAtPath(native_path)
        if entry['articulation'] is not None and prim.IsA(UsdPhysics.Joint):
            joint = UsdPhysics.Joint(prim)
            targets = list(joint.GetBody1Rel().GetTargets()) or list(joint.GetBody0Rel().GetTargets())
            if len(targets) != 1:
                raise SceneError('ENTITY_ORIGIN_UNVERIFIED', 'Articulation root joint does not identify one body: ' + str(native_path))
            native_path = str(targets[0])
        elif entry['articulation'] is not None and not prim.HasAPI(UsdPhysics.RigidBodyAPI):
            # Official ordered USD articulation metadata identifies its root link.
            links = entry['articulation'].link_paths
            if len(links) != 1 or not links[0]:
                raise SceneError('ENTITY_ORIGIN_UNVERIFIED', 'Imported articulation has no root link: ' + str(native_path))
            native_path = links[0][0]
    prim = stage.GetPrimAtPath(native_path)
    if not prim.IsValid() or not str(native_path).startswith(entry['path'] + '/') and str(native_path) != entry['path']:
        raise SceneError('ENTITY_ORIGIN_UNVERIFIED', 'Native root is outside its entity: ' + str(native_path))
    native_world = UsdGeom.XformCache().GetLocalToWorldTransform(prim).RemoveScaleShear()
    entry['nativePosePath'] = str(native_path)
    entry['modelFromNativeRoot'] = native_world * world_from_model.RemoveScaleShear().GetInverse()


def native_initial_pose(stage, entry):
    """Read the same root body for USD initialization and later PhysX tensor poses."""
    matrix = UsdGeom.XformCache().GetLocalToWorldTransform(stage.GetPrimAtPath(entry['nativePosePath'])).RemoveScaleShear()
    q = matrix.ExtractRotationQuat()
    return list(matrix.ExtractTranslation()), [float(q.GetReal()), *map(float, q.GetImaginary())]


def model_world_matrix(entry, native_position, native_quaternion):
    """Project native-root state to the Resource origin; native sensor poses remain native."""
    from scene_adapter import SceneError
    relation = entry.get('modelFromNativeRoot')
    if relation is None:
        raise SceneError('ENTITY_ORIGIN_UNVERIFIED', 'Imported model/native-root relation is unavailable')
    p = [float(v) for v in native_position]; q = [float(v) for v in native_quaternion]
    native_world = Gf.Matrix4d(1).SetRotate(Gf.Quatd(q[0], Gf.Vec3d(*q[1:]))).SetTranslateOnly(Gf.Vec3d(*p)).RemoveScaleShear()
    return relation.GetInverse() * native_world


def verify_native_origin(entry):
    """Refuse a USD/tensor root mismatch instead of correcting an unrelated body."""
    from scene_adapter import SceneError
    paths = entry['articulation'].link_paths if entry['articulation'] is not None else [entry['pose'].paths]
    if len(paths) != 1 or not paths[0] or str(paths[0][0]) != entry['nativePosePath']:
        raise SceneError('ENTITY_ORIGIN_UNVERIFIED', 'Imported root and native pose root differ for ' + entry['entity']['entityId'])


def install_base_bindings(stage, scene, entities, error):
    declarations = {entity['entityId']: entity.get('components', {}).get('baseBinding') for entity in scene['entities']}
    done = set(); visiting = set()
    def install(eid):
        if eid in done: return
        if eid in visiting: raise error('ROBOT_BASE_BINDING_CYCLE', '基座绑定不可成环')
        declaration = declarations.get(eid)
        if not declaration or declaration.get('mode') == 'source': done.add(eid); return
        from pxr import PhysxSchema
        visiting.add(eid); entry = entities[eid]
        source = next((root for root in entry['metadata'].get('rootBodies', []) if root['bodyName'] == declaration.get('bodyName')), None)
        if not source or not source['editable'] or source['massKg'] <= 0:
            raise error('ROBOT_BASE_UNSUPPORTED', '根本体关节/质量不可核，不允许删除内部机构')
        root = body_prim(stage, entry, source['bodyName'], error); root_path = root.GetPath()
        if entry.get('nativePosePath') != str(root_path):
            from scene_adapter import poses
            capture_model_origin(stage, entry, poses(scene)[eid], str(root_path))
        # 只改世界↔根的固定关节；根与内部连杆的 Revolute/Prismatic 等源约束全部保留。
        for joint in world_joints(stage, root_path):
            if not joint.GetPrim().IsA(UsdPhysics.FixedJoint): raise error('ROBOT_BASE_UNSUPPORTED', '根存在源本体世界关节，不能删除')
            joint.CreateJointEnabledAttr().Set(False)
        mode = declaration['mode']
        if mode not in ('free', 'fixed'): raise error('ROBOT_BASE_MODE_INVALID', mode)
        if mode == 'fixed':
            target = declaration.get('target') or {}; parent_eid = target.get('entityId')
            if parent_eid:
                if parent_eid == eid or parent_eid not in entities: raise error('ROBOT_BASE_TARGET_MISSING', '绑定目标实体不存在')
                install(parent_eid)
                parent = body_prim(stage, entities[parent_eid], target.get('bodyName', ''), error, target=True)
                parent_world = UsdGeom.XformCache().GetLocalToWorldTransform(parent)
                world = pose_matrix(target) * parent_world
            else:
                parent = None; world = pose_matrix(target)
            # 在初始化前调整真实根的 authored transform；之后由 USD FixedJoint/PhysX 维持。
            parent_world = UsdGeom.XformCache().GetLocalToWorldTransform(root.GetParent())
            xform = UsdGeom.Xformable(root); xform.ClearXformOpOrder(); xform.AddTransformOp(opSuffix='baseAnchor').Set(world * parent_world.GetInverse())
            path = Sdf.Path(entry['path']).AppendChild('__lyapunov_base_fixed')
            joint = UsdPhysics.FixedJoint.Define(stage, path)
            if parent is not None: joint.CreateBody0Rel().SetTargets([parent.GetPath()])
            joint.CreateBody1Rel().SetTargets([root_path])
            local = target; q = local['quaternionXyzw']
            joint.CreateLocalPos0Attr().Set(Gf.Vec3f(*local['positionM']))
            joint.CreateLocalRot0Attr().Set(Gf.Quatf(q[3], Gf.Vec3f(*q[:3])))
            joint.CreateLocalPos1Attr().Set(Gf.Vec3f(0., 0., 0.)); joint.CreateLocalRot1Attr().Set(Gf.Quatf(1.))
            joint.CreateJointEnabledAttr().Set(True)
            # 跨 articulation 约束不并吞两个本体机构，PhysX 在外部约束求解器中处理。
            if parent is not None: joint.CreateExcludeFromArticulationAttr().Set(True)
            elif entry['articulation'] is not None:
                # 固定世界 articulation 的根必须挂在 FixedJoint 上；沿用官方 USD articulation API。
                for prim in Usd.PrimRange(stage.GetPrimAtPath(entry['path'])):
                    if prim.HasAPI(UsdPhysics.ArticulationRootAPI): prim.RemoveAPI(UsdPhysics.ArticulationRootAPI)
                UsdPhysics.ArticulationRootAPI.Apply(joint.GetPrim()); PhysxSchema.PhysxArticulationAPI.Apply(joint.GetPrim())
            entry['baseConstraintPath'] = str(path)
        else:
            # 浮动 articulation 的 API 在真实根刚体；不触碰任何内部关节/驱动。
            if declaration.get('initialWorldPose'):
                world = pose_matrix(declaration['initialWorldPose']); parent_world = UsdGeom.XformCache().GetLocalToWorldTransform(root.GetParent())
                xform = UsdGeom.Xformable(root); xform.ClearXformOpOrder(); xform.AddTransformOp(opSuffix='baseRelease').Set(world * parent_world.GetInverse())
            if entry['articulation'] is not None:
                for prim in Usd.PrimRange(stage.GetPrimAtPath(entry['path'])):
                    if prim.HasAPI(UsdPhysics.ArticulationRootAPI): prim.RemoveAPI(UsdPhysics.ArticulationRootAPI)
                UsdPhysics.ArticulationRootAPI.Apply(root); PhysxSchema.PhysxArticulationAPI.Apply(root)
        if entry['articulation'] is not None:
            from scene_adapter import Articulation
            articulation_path = entry.get('baseConstraintPath') if mode == 'fixed' and not (declaration.get('target') or {}).get('entityId') else str(root_path)
            entry['articulation'] = Articulation(articulation_path)
            entry['pose'] = entry['articulation']
        visiting.remove(eid); done.add(eid)
    for eid in declarations: install(eid)


def authoring_description(world, eid):
    from scene_adapter import camera_mount_bodies, SceneError
    entry = world.entities[eid]; metadata = entry.get('metadata') or {}; declared = metadata.get('bodies') or {}; rows = []
    sources = metadata.get('rootBodies') or []; base_source = next((root for root in sources if root['bodyName'] == (entry['entity'].get('components', {}).get('baseBinding') or {}).get('bodyName')), sources[0] if sources else None)
    for body in camera_mount_bodies(world.stage, {eid: entry}):
        prim = world.stage.GetPrimAtPath(body['bodyPath']); name = body['bodyName']; source = declared.get(name) or {}
        rows.append({'name': name, 'parentName': source.get('parent'), 'root': bool(base_source and name == base_source['bodyName']), 'massKg': source.get('massKg'),
                     'jointTypes': source.get('jointTypes', []), 'worldFromBody': pose_receipt(world._native_world_matrix(prim))})
    native_sites = [{'name': name, 'bodyName': definition['body'], 'positionM': definition['positionM'], 'quaternionXyzw': [*definition['quaternionWxyz'][1:], definition['quaternionWxyz'][0]]}
                    for name, definition in (metadata.get('sites') or {}).items() if name in entry['siteNames']]
    if base_source is None:
        state = {'bodyName': '', 'mode': 'unknown', 'source': 'native-model', 'reason': '源未提供可核验的根关节/质量；不推断固定地板', 'constraints': [], 'editable': {'fixed': False, 'free': False, 'entity': False, 'reason': '仅源根元数据可核的 MJCF 支持保真基座编辑'}}
        return {'nativeBodies': rows, 'nativeSites': native_sites, 'base': state}
    root = body_prim(world.stage, entry, base_source['bodyName'], SceneError); root_path = root.GetPath(); constraints = []
    for prim in Usd.PrimRange(world.stage.GetPseudoRoot()):
        if not prim.IsA(UsdPhysics.Joint): continue
        joint = UsdPhysics.Joint(prim); a = list(joint.GetBody0Rel().GetTargets()); b = list(joint.GetBody1Rel().GetTargets())
        if root_path not in a + b: continue
        # 内部本体关节单独保留，不把 root→第一个转动关节说成固定世界。
        other = b if root_path in a else a
        if other and str(other[0]).startswith(entry['path'] + '/') and '__lyapunov_base_fixed' not in str(prim.GetPath()): continue
        enabled = joint.GetJointEnabledAttr().Get(); active = enabled is not False
        target_eid = next((other_id for other_id, other_entry in world.entities.items() if other and (str(other[0]) == other_entry['path'] or str(other[0]).startswith(other_entry['path'] + '/'))), None)
        constraints.append({'name': str(prim.GetPath().MakeRelativePath(Sdf.Path(entry['path']))), 'kind': 'fixed' if prim.IsA(UsdPhysics.FixedJoint) else prim.GetTypeName(), 'active': active,
                            'bodyName': base_source['bodyName'], **({'targetEntityId': target_eid, 'targetBodyName': other[0].name} if target_eid else {'targetBodyName': 'world'})})
    declaration = entry['entity'].get('components', {}).get('baseBinding'); fixed = any(c['active'] and c['kind'] == 'fixed' for c in constraints)
    mode = 'fixed' if fixed else 'articulated' if base_source['mode'] == 'articulated' else 'free'
    source = 'scene-base-binding' if declaration else 'importer-fixed-base' if entry['config'].get('fixBase') is True else 'native-constraint' if fixed else 'native-model'
    editable = base_source['editable'] and base_source['massKg'] > 0 and not any(c['active'] and c['kind'] != 'fixed' for c in constraints)
    state = {'bodyName': base_source['bodyName'], 'mode': mode, 'source': source, 'sourceMode': base_source['mode'], 'constraints': constraints, 'worldFromBody': pose_receipt(world._native_world_matrix(root)),
             'reason': '固定到指定实体的真实 USD/PhysX 约束' if declaration and (declaration.get('target') or {}).get('entityId') else '基座固定在世界坐标；未声明绑定地板' if fixed else '真实 USD 根未绑定世界；基座受重力和接触影响',
             'editable': {'fixed': bool(editable), 'free': bool(editable), 'entity': bool(editable)}}
    if not editable: state['editable']['reason'] = '根本体关节、质量或导入 body 映射不可核，不能保真编辑'
    if declaration and declaration.get('target'): state['target'] = copy.deepcopy(declaration['target'])
    if base_source.get('modelFromBase'): state['modelFromBase'] = copy.deepcopy(base_source['modelFromBase'])
    return {'nativeBodies': rows, 'nativeSites': native_sites, 'base': state}


def authoring_observation(world, frame):
    for entity in frame['entities']:
        eid = entity['entityId']; entry = world.entities.get(eid)
        if entry is None: continue
        metadata = entry.get('metadata') or {}
        if not metadata.get('rootBodies'):
            if entry.get('collision'):
                root = world.stage.GetPrimAtPath(entry['path'])
                entity.setdefault('sensors', {})['bodyWorldPoses'] = {root.GetName(): {'bodyName': root.GetName(), **pose_receipt(world._native_world_matrix(root))}}
            continue
        description = authoring_description(world, eid); sensors = entity.setdefault('sensors', {})
        sensors['robotBase'] = description['base']; sensors['bodyWorldPoses'] = {body['name']: {'bodyName': body['name'], **body['worldFromBody']} for body in description['nativeBodies']}
        tcp = entry['controller'].get('tcp')
        if not tcp: continue
        if tcp.get('site'):
            pose = sensors.get('sites', {}).get(tcp['site'])
            if not pose: continue
        else:
            body = sensors['bodyWorldPoses'].get(tcp.get('body'))
            if not body: continue
            local = {'positionM': tcp.get('offsetM', [0., 0., 0.]), 'quaternionXyzw': tcp.get('quaternionXyzw', [0., 0., 0., 1.])}
            pose = pose_receipt(pose_matrix(local) * pose_matrix(body))
        sensors['tcp'] = {**pose, 'bodyName': tcp['body'], **({'site': tcp['site']} if tcp.get('site') else {}), 'source': 'native-site' if tcp.get('site') else 'native-body-local'}
