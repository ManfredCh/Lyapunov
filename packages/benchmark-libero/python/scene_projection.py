"""官方 ControlEnv 编译模型到 Scene/Viewer 的真实投影。

模块级只使用标准库；mujoco/numpy 在函数内按需导入（与 worker.load_sdk 的隔离约定一致）。

职责边界：
- 只读官方编译模型（MjModel/MjData）与官方编译 XML，产出 SceneSnapshot 与 Frame 的实体部分；
- 每个实体写一份自包含 MJCF 片段，视觉描述走 Viewer 已有的 components.visual.kind="robot" 契约；
- mesh 只做格式转换（.msh -> .obj，使用官方 mujoco.msh2obj）与绝对路径改写，不修改官方原件；
- texture 只做字节复制（内容寻址落到本轮 derived 目录）与绝对路径改写，不修改官方原件；
- 不判定任务成功、不产生动作、不复制任何套件常数。

坐标与位姿约定（与 Viewer.applyFrame 的数学一致）：
- 内部姿态字典统一使用 MuJoCo 的 wxyz 四元数；进入 Scene/Frame 时转成 xyzw；
- Frame 中实体 transform 是官方世界位姿 F；
- Scene 中实体 transform 是 G = F ∘ A⁻¹，A 是该实体 MJCF 根 body 的局部变换；
  Viewer 收到帧后计算 G' = F ∘ rootFrameInverse(= A⁻¹)，与 Scene 初值一致，首帧前后不会跳变。
"""

from __future__ import annotations

import hashlib
import re
import xml.etree.ElementTree as ET
from copy import deepcopy
from pathlib import Path

SCENE_COORDINATES = {"units": "m", "upAxis": "Z", "handedness": "right", "quaternion": "xyzw"}
SCENE_REVISION = 1
IDENTITY_POSITION = [0.0, 0.0, 0.0]
IDENTITY_QUATERNION_WXYZ = [1.0, 0.0, 0.0, 0.0]
VIEWER_MESH_EXTENSIONS = {".obj", ".stl", ".dae"}
VIEWER_MESH_MIME = {".obj": "model/obj", ".stl": "model/stl", ".dae": "model/vnd.collada+xml"}
# 2D 纹理按字节复制到 derived 目录：Viewer 的浏览器解码器认这些容器；cube/skybox 不走这条路。
VIEWER_TEXTURE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".tga", ".webp"}
VIEWER_TEXTURE_MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".bmp": "image/bmp", ".tga": "image/x-tga", ".webp": "image/webp",
}
ROBOT_ENTITY_ID = "official-robot"
WORLDBODY_ENTITY_ID = "official-worldbody"
# MuJoCo 关节类型：0 free, 1 ball, 2 slide, 3 hinge。Viewer 只投影 hinge/slide。
JOINT_TYPE_NAMES = {2: "slide", 3: "hinge"}
FREE_JOINT_TYPES = (0, 1)


def _safe_token(value, fallback="entity"):
    text = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value)).strip("_")
    return (text or fallback)[:96]


def _namespace_id(value, fallback="scene"):
    """官方 scene id → **会话场景命名空间**合法 id。

    官方 id 形如 `libero_object/pick_up_the_alphabet_soup_and_place_it_in_the_basket`（`/` 是官方命名空间的
    分隔符），而命名空间自己的契约是 scene-kit `safeId`：`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$`（`/` 非法）。
    投影文档里的 `sceneId` 与由它派生的 `resourceId` 都必须满足该契约，否则投影落盘时会被既有校验拒绝
    （真机原样报 `INVALID_ID: …/…`）。映射与 TS 侧 `scene-projection.namespaceSceneId` **完全一致**：
    非法字符折叠成 `-`、去掉开头非字母数字、截到 160；对已合法的 id 是恒等。
    """
    text = re.sub(r"[^A-Za-z0-9_.:-]+", "-", str(value))
    text = re.sub(r"^[^A-Za-z0-9]+", "", text)[:160]
    return text or fallback


def _round(values, digits=9):
    return [round(float(value), digits) for value in values]


def _text(value):
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)


def _xyzw(quat_wxyz):
    return [float(quat_wxyz[1]), float(quat_wxyz[2]), float(quat_wxyz[3]), float(quat_wxyz[0])]


def _finite(value):
    """拒绝 NaN/Infinity：worker 的 json.dumps(allow_nan=False) 不能带出脏数值。"""
    if isinstance(value, bool):
        return True
    if isinstance(value, (int, float)):
        return value == value and value not in (float("inf"), float("-inf"))
    if isinstance(value, dict):
        return all(_finite(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return all(_finite(item) for item in value)
    return True


def _unavailable(code, message, warnings=None):
    return {"status": "UNAVAILABLE", "code": code, "message": message, "warnings": list(warnings or [])}


def _quat_to_matrix(np, quat_wxyz):
    w, x, y, z = [float(value) for value in quat_wxyz]
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ], dtype=float)


def _matrix_to_quat(np, matrix):
    """旋转矩阵 -> 四元数 wxyz。"""
    m = matrix
    trace = m[0][0] + m[1][1] + m[2][2]
    if trace > 0:
        s = np.sqrt(trace + 1.0) * 2
        w = 0.25 * s
        x = (m[2][1] - m[1][2]) / s
        y = (m[0][2] - m[2][0]) / s
        z = (m[1][0] - m[0][1]) / s
    elif m[0][0] > m[1][1] and m[0][0] > m[2][2]:
        s = np.sqrt(1.0 + m[0][0] - m[1][1] - m[2][2]) * 2
        w = (m[2][1] - m[1][2]) / s
        x = 0.25 * s
        y = (m[0][1] + m[1][0]) / s
        z = (m[0][2] + m[2][0]) / s
    elif m[1][1] > m[2][2]:
        s = np.sqrt(1.0 + m[1][1] - m[0][0] - m[2][2]) * 2
        w = (m[0][2] - m[2][0]) / s
        x = (m[0][1] + m[1][0]) / s
        y = 0.25 * s
        z = (m[1][2] + m[2][1]) / s
    else:
        s = np.sqrt(1.0 + m[2][2] - m[0][0] - m[1][1]) * 2
        w = (m[1][0] - m[0][1]) / s
        x = (m[0][2] + m[2][0]) / s
        y = (m[1][2] + m[2][1]) / s
        z = 0.25 * s
    quat = np.array([w, x, y, z], dtype=float)
    length = float(np.linalg.norm(quat))
    if not length or length != length:
        return np.array(IDENTITY_QUATERNION_WXYZ, dtype=float)
    return quat / length


def relative_scene_transform(np, world_pose, anchor_pose):
    """返回 G = F ∘ A⁻¹（位置 + wxyz 四元数），即 Viewer 在 App 帧下需要的实体变换。"""
    rotation_world = _quat_to_matrix(np, world_pose["quaternion"])
    rotation_anchor = _quat_to_matrix(np, anchor_pose["quaternion"])
    position_world = np.asarray(world_pose["position"], dtype=float)
    position_anchor = np.asarray(anchor_pose["position"], dtype=float)
    rotation = rotation_world @ rotation_anchor.T
    position = position_world - rotation @ position_anchor
    return {"position": position.tolist(), "quaternion": _matrix_to_quat(np, rotation).tolist()}


def _world_pose(data, body_id):
    """实体根 body 的官方世界位姿（wxyz）。"""
    if body_id is None or body_id == 0:
        return {"position": list(IDENTITY_POSITION), "quaternion": list(IDENTITY_QUATERNION_WXYZ)}
    return {
        "position": [float(value) for value in data.xpos[body_id]],
        "quaternion": [float(value) for value in data.xquat[body_id]],
    }


def _body_local_pose(model, body_id):
    """实体根 body 的编译局部变换（wxyz），即 MJCF 文档里写的 pos/quat。"""
    if body_id is None or body_id == 0:
        return {"position": list(IDENTITY_POSITION), "quaternion": list(IDENTITY_QUATERNION_WXYZ)}
    return {
        "position": [float(value) for value in model.body_pos[body_id]],
        "quaternion": [float(value) for value in model.body_quat[body_id]],
    }


def _collect(tag, node, result):
    for child in list(node):
        if child.tag == tag:
            result.append(child)
        _collect(tag, child, result)


def _element_axis(elements, count, name_of_id, warnings, label):
    """文档顺序 <-> 编译 id 的映射校验。

    mj_saveLastXML 的往返保真要求写入顺序与 id 顺序一致；这里核对计数并在名称
    可用时抽验名称，不匹配时退回名称索引，避免把属性写到错误的元素上。
    """
    if len(elements) != count:
        warnings.append("BENCHMARK_SCENE_%s_ORDER_MISMATCH: xml=%d model=%d" % (label.upper(), len(elements), count))
        return None
    by_name = {}
    order_ok = True
    for index, element in enumerate(elements):
        model_name = name_of_id(index)
        element_name = element.get("name")
        if element_name is not None and model_name is not None:
            by_name[element_name] = index
            if element_name != model_name:
                order_ok = False
    if not order_ok:
        warnings.append("BENCHMARK_SCENE_%s_NAME_ORDER_FALLBACK" % label.upper())
        return {"identity": None, "by_name": by_name}
    return {"identity": True, "by_name": by_name}


def _resolve_index(axis, element, fallback):
    if axis is None:
        return None
    if axis["identity"]:
        return fallback
    return axis["by_name"].get(element.get("name"))


def document_of(element):
    """MJCF Element -> Viewer 使用的文档对象（属性保持字符串，与 fast-xml-parser 一致）。"""
    node = {key: value for key, value in element.attrib.items()}
    children = {}
    for child in list(element):
        value = document_of(child)
        if child.tag in children:
            if isinstance(children[child.tag], list):
                children[child.tag].append(value)
            else:
                children[child.tag] = [children[child.tag], value]
        else:
            children[child.tag] = value
    node.update(children)
    text = (element.text or "").strip()
    if text:
        node["#text"] = text
    return node


def _empty_entity(entity_id, name, kind, root_body_id, root_body_name, parent_id, object_name, xml_index):
    return {
        "entityId": entity_id, "name": name, "kind": kind,
        "rootBodyId": root_body_id, "rootBodyName": root_body_name,
        "parentId": parent_id, "objectName": object_name, "xmlIndex": xml_index,
        "joints": [], "extraJoints": [], "meshes": [], "textures": [], "warnings": [],
        "textureColorMaterials": [],
    }


def project_scene(model, data, xml_text, *, scene_id, derived_root, revision=SCENE_REVISION,
                  robot_root=None, object_bodies=None, robot_prefixes=("robot0_",), xml_base=None):
    """把官方编译模型投影为完整 SceneSnapshot。

    返回 {"status", "scene", "entities", "warnings"} 或 {"status": "UNAVAILABLE", "code", ...}。
    任何失败都只影响视觉投影，不影响官方 episode 本身。
    """
    warnings = []
    object_bodies = {str(key): str(value) for key, value in (object_bodies or {}).items()}
    if not isinstance(xml_text, str) or "<mujoco" not in xml_text:
        return _unavailable("BENCHMARK_SCENE_XML_UNAVAILABLE", "官方编译模型 XML 不可用", warnings)
    try:
        root = ET.fromstring(xml_text)
    except Exception as error:  # noqa: BLE001 - XML 形状不可预期
        return _unavailable("BENCHMARK_SCENE_XML_INVALID", str(error), warnings)
    if root.tag != "mujoco":
        return _unavailable("BENCHMARK_SCENE_XML_INVALID", "根元素不是 mujoco: " + str(root.tag), warnings)
    try:
        import numpy as np
        import mujoco
    except Exception as error:  # noqa: BLE001 - 隔离环境缺失
        return _unavailable("BENCHMARK_SCENE_SDK_UNAVAILABLE", str(error), warnings)

    # N221：官方 id 带 `/` ⇒ **在投影源头**折成命名空间合法 id：文档 `sceneId` 与由它派生的
    # `resourceId`（两者都在本函数末尾构造）都用它，否则桥落盘时被 scene-kit `safeId` 拒绝（真机原样报 INVALID_ID）。
    scene_id = _namespace_id(scene_id)
    revision = int(revision)
    # 派生资产必须落在绝对路径上：资源 URI（file://）与 Viewer 的 baseUri 都要求绝对路径。
    derived_root = Path(derived_root).expanduser().resolve()
    nbody = int(model.nbody)
    njnt = int(model.njnt)
    ngeom = int(model.ngeom)

    def body_id_name(body_id):
        return mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, body_id)

    def joint_id_name(joint_id):
        return mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT, joint_id)

    def geom_id_name(geom_id):
        return mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, geom_id)

    worldbody = root.find("worldbody")
    if worldbody is None:
        return _unavailable("BENCHMARK_SCENE_XML_INVALID", "编译模型缺少 worldbody", warnings)
    body_elements = []
    joint_elements = []
    geom_elements = []
    _collect("body", worldbody, body_elements)
    _collect("joint", worldbody, joint_elements)
    _collect("geom", worldbody, geom_elements)
    body_axis = _element_axis(body_elements, nbody - 1, lambda index: body_id_name(index + 1), warnings, "body")
    joint_axis = _element_axis(joint_elements, njnt, lambda index: joint_id_name(index), warnings, "joint")
    geom_axis = _element_axis(geom_elements, ngeom, lambda index: geom_id_name(index), warnings, "geom")
    body_id_of_element = {}
    for index, element in enumerate(body_elements):
        resolved = _resolve_index(body_axis, element, index)
        if resolved is not None:
            body_id_of_element[id(element)] = resolved + 1

    parent = [int(model.body_parentid[body_id]) for body_id in range(nbody)]

    def top_ancestor(body_id):
        current = body_id
        while parent[current] != 0:
            current = parent[current]
        return current

    body_id_by_name = {}
    for body_id in range(nbody):
        name = body_id_name(body_id)
        if name is not None:
            body_id_by_name.setdefault(name, body_id)

    object_root = {}
    for object_name, body_name in object_bodies.items():
        body_id = body_id_by_name.get(body_name)
        if body_id is None:
            warnings.append("BENCHMARK_SCENE_OBJECT_BODY_MISSING: " + object_name)
            continue
        object_root[object_name] = body_id
    object_name_by_body = {}
    for object_name, body_id in object_root.items():
        object_name_by_body.setdefault(body_id, object_name)

    robot_id = None
    if robot_root:
        robot_id = body_id_by_name.get(str(robot_root))
        if robot_id is None:
            warnings.append("BENCHMARK_SCENE_ROBOT_BODY_MISSING: " + str(robot_root))
    if robot_id is None:
        for body_id in range(1, nbody):
            name = body_id_name(body_id) or ""
            if parent[body_id] == 0 and any(name.startswith(prefix) for prefix in robot_prefixes):
                robot_id = body_id
                warnings.append("BENCHMARK_SCENE_ROBOT_BODY_INFERRED: " + name)
                break

    # ---- 实体根：worldbody 直接几何、机器人、每个顶层 body、每个官方对象/自由体 ----
    entities = []
    entity_by_body = {}
    used_ids = set()

    def add_entity(entity_id, name, kind, root_body_id, parent_entity=None, object_name=None, xml_index=None):
        base = str(entity_id)
        candidate = base
        suffix = 2
        while candidate in used_ids:
            candidate = "%s#%d" % (base, suffix)
            suffix += 1
        if candidate != base:
            warnings.append("BENCHMARK_SCENE_ENTITY_ID_COLLISION: " + base)
        used_ids.add(candidate)
        if root_body_id is not None:
            entity_by_body[root_body_id] = candidate
        entities.append(_empty_entity(
            candidate, name, kind, root_body_id,
            body_id_name(root_body_id) if root_body_id else None,
            parent_entity, object_name, xml_index))
        return entities[-1]

    def element_index_for(body_id):
        if not 0 < body_id < len(body_elements) + 1:
            return None
        return _resolve_index(body_axis, body_elements[body_id - 1], body_id - 1)

    def ensure_entity(body_id, reason):
        if body_id in entity_by_body:
            return entity_by_body[body_id]
        object_name = object_name_by_body.get(body_id)
        label = body_id_name(body_id) or "body_%d" % body_id
        warnings.append("BENCHMARK_SCENE_ENTITY_PROMOTED: %s (%s)" % (label, reason))
        entity = add_entity(object_name or label, object_name or label, "object" if object_name else "body",
                            body_id, entity_by_body.get(top_ancestor(body_id)), object_name, element_index_for(body_id))
        return entity["entityId"]

    static_world_geoms = [child for child in list(worldbody) if child.tag != "body"]
    if static_world_geoms:
        add_entity(WORLDBODY_ENTITY_ID, "official world body geometry", "world", None, None, None, None)
    if robot_id is not None:
        add_entity(ROBOT_ENTITY_ID, body_id_name(robot_id) or "official robot", "robot", robot_id, None, None,
                   element_index_for(robot_id))
    for body_id in range(1, nbody):
        if parent[body_id] != 0 or body_id in entity_by_body:
            continue
        object_name = object_name_by_body.get(body_id)
        label = object_name or (body_id_name(body_id) or "body_%d" % body_id)
        add_entity(label, label, "object" if object_name else "body", body_id, None, object_name,
                   element_index_for(body_id))

    # 自由/球形关节 body 会独立运动，必须是自己的实体，否则视觉不会随官方状态移动。
    for joint_id in range(njnt):
        if int(model.jnt_type[joint_id]) in FREE_JOINT_TYPES:
            body_id = int(model.jnt_bodyid[joint_id])
            if body_id not in entity_by_body:
                ensure_entity(body_id, "free-or-ball-joint")
    # 嵌套官方对象（例如共享包装 body 内）单独成实体，避免与父实体共享刚性变换。
    for object_name in sorted(object_root):
        body_id = object_root[object_name]
        if body_id in entity_by_body:
            continue
        ancestor = top_ancestor(body_id)
        if ancestor not in entity_by_body:
            ensure_entity(ancestor, "object-ancestor")
        add_entity(object_name, object_name, "object", body_id, entity_by_body.get(ancestor), object_name,
                   element_index_for(body_id))

    # ---- body -> 实体归属（最深实体根胜出）----
    owner = {}
    for body_id in range(1, nbody):
        current = body_id
        while current != 0:
            entity_id = entity_by_body.get(current)
            if entity_id is not None:
                owner[body_id] = entity_id
                break
            current = parent[current]

    # 官方编译模型里关节多数是无名的（mj_id2name 返回 None）。Viewer 的 setJoints 只认名字，
    # 所以按「所属 body + 序号」合成稳定名字，并把它写进派生文档，三处（Scene/Frame/XML）同名。
    joint_names = {}
    per_body_joints = {}
    for joint_id in range(njnt):
        body_id = int(model.jnt_bodyid[joint_id])
        name = joint_id_name(joint_id)
        if not name:
            ordinal = per_body_joints.get(body_id, 0) + 1
            per_body_joints[body_id] = ordinal
            name = "%s_joint%d" % (body_id_name(body_id) or "body_%d" % body_id, ordinal)
        joint_names[joint_id] = str(name)

    entity_by_id = {entity["entityId"]: entity for entity in entities}
    for joint_id in range(njnt):
        joint_type = int(model.jnt_type[joint_id])
        body_id = int(model.jnt_bodyid[joint_id])
        entity = entity_by_id.get(owner.get(body_id))
        if entity is None:
            continue
        qposadr = int(model.jnt_qposadr[joint_id])
        record = {
            "id": joint_id, "name": joint_names[joint_id], "type": joint_type,
            "bodyId": body_id, "bodyName": body_id_name(body_id),
            "qposadr": qposadr, "dofadr": int(model.jnt_dofadr[joint_id]),
            "qpos0": float(model.qpos0[qposadr]) if joint_type in JOINT_TYPE_NAMES else None,
        }
        if joint_type in JOINT_TYPE_NAMES:
            entity["joints"].append(record)
        else:
            entity["extraJoints"].append(record)

    # ---- 属性物化：位姿/关节/几何以编译模型为准，摆脱 XML default 依赖 ----
    for index, element in enumerate(body_elements):
        resolved = _resolve_index(body_axis, element, index)
        body_id = None if resolved is None else resolved + 1
        if body_id is None or not 0 < body_id < nbody:
            continue
        element.set("pos", " ".join("%.9g" % value for value in model.body_pos[body_id]))
        element.set("quat", " ".join("%.9g" % value for value in model.body_quat[body_id]))
        for attribute in ("euler", "rpy", "axisangle"):
            element.attrib.pop(attribute, None)
    for index, element in enumerate(joint_elements):
        resolved = _resolve_index(joint_axis, element, index)
        if resolved is None or not 0 <= resolved < njnt:
            continue
        element.set("name", joint_names[resolved])
        joint_type = int(model.jnt_type[resolved])
        if joint_type not in JOINT_TYPE_NAMES:
            element.set("type", "free" if joint_type == 0 else "ball")
            continue
        element.set("type", JOINT_TYPE_NAMES[joint_type])
        element.set("axis", " ".join("%.9g" % value for value in model.jnt_axis[resolved]))
        element.set("pos", " ".join("%.9g" % value for value in model.jnt_pos[resolved]))
    for index, element in enumerate(geom_elements):
        resolved = _resolve_index(geom_axis, element, index)
        if resolved is None or not 0 <= resolved < ngeom:
            continue
        # 无名 geom（LIBERO 桌面/盒子等）在 Scene/验收里也要有稳定名字，否则 Viewer 里
        # 多个同名容器无法区分。与 joint 补名同策略：所属 body + geom id，确定性且唯一。
        element.set("name", str(geom_id_name(resolved) or "%s_g%d" % (
            body_id_name(int(model.geom_bodyid[resolved])) or "geom", resolved)))
        # group 以编译模型为准：官方 agentview 只渲染 group 1（robosuite base.py
        # render_collision_mesh=False / render_visual_mesh=True），Viewer 据此决定默认可见性。
        element.set("group", "%d" % int(model.geom_group[resolved]))
        element.set("pos", " ".join("%.9g" % value for value in model.geom_pos[resolved]))
        element.set("quat", " ".join("%.9g" % value for value in model.geom_quat[resolved]))
        element.set("rgba", " ".join("%.6g" % value for value in model.geom_rgba[resolved]))
        if int(model.geom_type[resolved]) in (2, 3, 4, 5, 6):  # plane/sphere/capsule/ellipsoid/cylinder
            element.set("size", " ".join("%.9g" % value for value in model.geom_size[resolved]))
        # fromto 会被编译进 pos/quat/size，留着会让 Viewer 再按 fromto 摆一次。
        element.attrib.pop("fromto", None)
        for attribute in ("euler", "rpy", "axisangle"):
            element.attrib.pop(attribute, None)

    # ---- mesh 解析与 .msh -> .obj 派生（内容寻址，不改官方原件）----
    compiler = root.find("compiler")
    meshdir = (compiler.get("meshdir") if compiler is not None else None) or ""
    asset = root.find("asset")
    mesh_elements = {}
    material_elements = {}
    texture_elements = {}
    if asset is not None:
        mesh_elements = {element.get("name"): element for element in asset.findall("mesh") if element.get("name")}
        material_elements = {element.get("name"): element for element in asset.findall("material") if element.get("name")}
        texture_elements = {element.get("name"): element for element in asset.findall("texture") if element.get("name")}

    mesh_model_paths = {}
    try:
        for mesh_id in range(int(model.nmesh)):
            name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_MESH, mesh_id)
            if name is None:
                continue
            candidates = []
            for attribute in ("mesh_path", "mesh_file"):
                values = getattr(model, attribute, None)
                if values is None or mesh_id >= len(values):
                    continue
                value = _text(values[mesh_id])
                if not value:
                    continue
                path = Path(value)
                candidates.append(str(path if path.is_absolute() else Path(meshdir) / path))
            mesh_model_paths[name] = candidates
    except Exception as error:  # noqa: BLE001 - 绑定差异只影响 mesh 候选路径
        warnings.append("BENCHMARK_SCENE_MESH_PATH_UNAVAILABLE: " + str(error))

    # 官方编译后的 mesh 帧（逐顶点数值实测确认的语义，见 07_alignment_runtime 报告）：
    #   v_compiled = Rᵀ · (S · v_file − mesh_pos)，  S = diag(mesh_scale), R = R(mesh_quat)
    # 即先按 mesh_scale 缩放原始顶点、再减 mesh_pos（实测 mesh_pos == S·原始包围盒中心，
    # 如 wall_decoration: raw 中心 × [0.4,0.1,0.4] 与 model.mesh_pos 逐位吻合）、最后左乘 Rᵀ。
    # 编译器把该帧补偿进了引用该 mesh 的 geom 的 pos/quat（无源位姿时 geom_pos==mesh_pos、
    # geom_quat==mesh_quat），官方渲染直接使用 v_compiled。派生 XML 把同一个 (pos,quat,scale)
    # 交给 Viewer，Viewer 对原始文件顶点应用 A = Rᵀ·T(−mesh_pos)·S 即得到官方世界几何。
    mesh_ids = {}
    for mesh_id in range(int(model.nmesh)):
        name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_MESH, mesh_id)
        if name:
            mesh_ids.setdefault(str(name), int(mesh_id))

    def mesh_frame(name):
        mesh_id = mesh_ids.get(str(name))
        if mesh_id is None:
            return None
        try:
            vectors = {
                "scale": np.asarray(model.mesh_scale[mesh_id], dtype=float).reshape(3),
                "pos": np.asarray(model.mesh_pos[mesh_id], dtype=float).reshape(3),
                "quat": np.asarray(model.mesh_quat[mesh_id], dtype=float).reshape(4),
            }
        except Exception as error:  # noqa: BLE001 - 旧绑定缺字段时保留源 XML 属性
            warnings.append("BENCHMARK_SCENE_MESH_FRAME_UNAVAILABLE: %s (%s)" % (name, error))
            return None
        return {key: " ".join("%.9g" % value for value in vector) for key, vector in vectors.items()}

    derived_mesh_root = derived_root / "meshes"
    mesh_cache = {}

    def resolve_mesh_file(name, element):
        candidates = list(mesh_model_paths.get(name) or [])
        file_value = element.get("file") if element is not None else None
        # 官方编译模型里 file 已是绝对路径；相对路径按 MuJoCo 语义相对 XML 目录/ meshdir 解析。
        roots = [Path(meshdir)] if meshdir else []
        if xml_base:
            roots.insert(0, Path(xml_base) / meshdir if meshdir else Path(xml_base))
            roots.insert(1, Path(xml_base))
        if file_value:
            path = Path(file_value)
            for root in roots:
                candidates.append(str(path if path.is_absolute() else root / path))
            candidates.append(str(path))
            # 有些绑定把 mesh_path 存成目录；再按「目录 + 文件名」试一次。
            for candidate in list(candidates):
                candidate_path = Path(candidate)
                if candidate_path.suffix.lower() in VIEWER_MESH_EXTENSIONS or candidate_path.suffix.lower() == ".msh":
                    candidates.append(str(candidate_path.parent / path.name))
        for candidate in candidates:
            path = Path(candidate)
            if path.is_file():
                return path
        return None

    def derive_mesh(name, element):
        if name in mesh_cache:
            return mesh_cache[name]
        source = resolve_mesh_file(name, element)
        if source is None:
            raise FileNotFoundError("BENCHMARK_SCENE_MESH_MISSING: " + str(name))
        extension = source.suffix.lower()
        # file 必须是绝对路径：Viewer 用 new URL(file, baseUri) 解析，
        # 而 representations 的 file:// URI 也只能由绝对路径产生。
        resolved = source.resolve()
        if extension in VIEWER_MESH_EXTENSIONS:
            record = {"name": name, "source": str(source), "file": str(resolved), "format": extension[1:], "derived": False}
        elif extension == ".msh":
            # 官方转换器（mujoco.msh2obj）保持顶点/法线/面不变，只换容器格式；mesh scale 仍在 XML 中。
            from mujoco.msh2obj import msh_to_obj
            text = msh_to_obj(source)
            digest = hashlib.sha256(source.read_bytes()).hexdigest()[:16]
            target = derived_mesh_root / digest / (_safe_token(source.stem) + ".obj")
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                temporary = target.with_name(target.name + ".tmp")
                temporary.write_text(text, encoding="utf-8")
                temporary.replace(target)
            record = {
                "name": name, "source": str(source), "file": str(target), "format": "obj", "derived": True,
                "vertices": text.count("\nv ") + (1 if text.startswith("v ") else 0),
            }
        else:
            raise ValueError("BENCHMARK_SCENE_MESH_FORMAT_UNSUPPORTED: " + str(source))
        mesh_cache[name] = record
        return record

    derived_texture_root = derived_root / "textures"
    texture_cache = {}

    def resolve_texture_file(file_value):
        """官方纹理引用 -> 本机文件。候选顺序与 mesh 一致：绝对路径优先，其次 compiler 的
        texturedir/assetdir/meshdir（相对 XML 目录与相对当前目录各试一次）。"""
        if not file_value:
            return None
        path = Path(file_value)
        candidates = [path] if path.is_absolute() else []
        if not path.is_absolute():
            directories = []
            for attribute in ("texturedir", "assetdir", "meshdir"):
                directory = compiler.get(attribute) if compiler is not None else None
                if directory:
                    directories.append(Path(directory))
            if xml_base:
                base = Path(xml_base)
                for directory in directories:
                    candidates.append(base / directory / path)
                candidates.append(base / path)
            for directory in directories:
                candidates.append(directory / path)
            candidates.append(path)
        return next((candidate for candidate in candidates if candidate.is_file()), None)

    def derive_texture(name, element):
        """官方 2D 纹理 -> 本轮 derived 目录的字节副本（内容寻址，不改官方原件）。

        只接 type=2d（或未声明 type，官方 robosuite/LIBERO 的 file 纹理都是 2d）的单文件纹理；
        cube/skybox 与 builtin 纹理在 Viewer 的一次性贴图里没有对应语义，抛错让调用方回落平均色。
        复制而不重新编码：解码/重编码会改变像素，纹理是"原字节即真值"的素材。
        """
        if name in texture_cache:
            return texture_cache[name]
        kind = element.get("type")
        if kind not in (None, "2d"):
            raise ValueError("BENCHMARK_SCENE_TEXTURE_TYPE_UNSUPPORTED: %s (%s)" % (name, kind))
        builtin = element.get("builtin")
        if builtin and builtin != "none":
            raise ValueError("BENCHMARK_SCENE_TEXTURE_BUILTIN_UNSUPPORTED: " + str(name))
        source = resolve_texture_file(element.get("file"))
        if source is None:
            raise FileNotFoundError("BENCHMARK_SCENE_TEXTURE_MISSING: %s (%s)" % (name, element.get("file")))
        extension = source.suffix.lower()
        if extension not in VIEWER_TEXTURE_EXTENSIONS:
            raise ValueError("BENCHMARK_SCENE_TEXTURE_FORMAT_UNSUPPORTED: " + str(source))
        payload = source.read_bytes()
        digest = hashlib.sha256(payload).hexdigest()[:16]
        target = derived_texture_root / digest / (_safe_token(source.stem) + extension)
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            temporary = target.with_name(target.name + ".tmp")
            temporary.write_bytes(payload)
            temporary.replace(target)
        record = {
            "name": name, "source": str(source), "file": str(target.resolve()),
            "format": extension[1:], "mimeType": VIEWER_TEXTURE_MIME[extension],
        }
        texture_cache[name] = record
        return record

    def prune(node, source, entity):
        """移除属于更深实体的 body 子树：同一 body 只能被一个实体渲染。

        node 是 source 的深拷贝，而 body_id_of_element 以原始元素的 id 建键——深拷贝后 id 全部
        不命中，必须让克隆树与原始树逐层并行、在原始节点上查归属，否则子 body 永远剪不掉。
        """
        children = [item for item in list(node) if item.tag == "body"]
        sources = [item for item in list(source) if item.tag == "body"]
        for child, child_source in zip(children, sources):
            child_body_id = body_id_of_element.get(id(child_source))
            if child_body_id is not None and owner.get(child_body_id) not in (None, entity["entityId"]):
                node.remove(child)
                continue
            prune(child, child_source, entity)

    def collect_assets(node, meshes, materials):
        for geom in node.iter("geom"):
            if geom.get("mesh"):
                meshes.add(geom.get("mesh"))
            if geom.get("material"):
                materials.add(geom.get("material"))

    def texture_average_color(material):
        """没有可用真纹理的材质：按纹理 PNG 平均色补 rgba（MuJoCo 语义里材质定义外观）。
        文件找不到/解码失败就跳过，材质保持原样。"""
        texture = texture_elements.get(material.get("texture") or "")
        source = resolve_texture_file(texture.get("file") if texture is not None else None)
        if source is None:
            return None
        try:
            from PIL import Image, ImageStat
            with Image.open(source) as image:
                mean = ImageStat.Stat(image.convert("RGB")).mean
        except Exception:  # noqa: BLE001 - 单个纹理解码失败只跳过该材质
            return None
        return [mean[0] / 255.0, mean[1] / 255.0, mean[2] / 255.0, 1.0]

    def asset_section(meshes, materials, entity):
        section = ET.Element("asset")
        mesh_clones = []
        for name in sorted(meshes):
            element = mesh_elements.get(name)
            if element is None:
                entity["warnings"].append("BENCHMARK_SCENE_MESH_ASSET_MISSING: " + str(name))
                continue
            try:
                record = derive_mesh(name, element)
            except Exception as error:  # noqa: BLE001 - 缺失/不支持格式只降级视觉
                entity["warnings"].append(str(error))
                continue
            clone = deepcopy(element)
            clone.set("file", record["file"])
            frame = mesh_frame(name)
            if frame is not None:
                # 编译后的 mesh 帧；Viewer 对原始文件顶点应用 A = Rᵀ·T(−pos)·S。
                clone.set("scale", frame["scale"])
                clone.set("pos", frame["pos"])
                clone.set("quat", frame["quat"])
            mesh_clones.append(clone)
            entity["meshes"].append(record)
        # 材质引用的纹理先落地：真纹理上车后就不再拿平均色冒充外观（MuJoCo 里材质 rgba 与
        # 纹理是 MODULATE 相乘，用平均色当基色会把整张贴图压暗到平均色²）。
        texture_clones = []
        derived_textures = set()
        for name in sorted(materials):
            element = material_elements.get(name)
            texture_name = element.get("texture") if element is not None else None
            if not texture_name or texture_name in derived_textures:
                continue
            texture = texture_elements.get(texture_name)
            if texture is None:
                entity["warnings"].append("BENCHMARK_SCENE_TEXTURE_ASSET_MISSING: " + str(texture_name))
                continue
            try:
                record = derive_texture(texture_name, texture)
            except Exception as error:  # noqa: BLE001 - 缺纹理只降级为平均色
                entity["warnings"].append(str(error))
                continue
            clone = deepcopy(texture)
            clone.set("file", record["file"])
            texture_clones.append(clone)
            derived_textures.add(texture_name)
            entity["textures"].append(record)
        material_clones = []
        for name in sorted(materials):
            element = material_elements.get(name)
            if element is None:
                continue
            clone = deepcopy(element)
            if clone.get("rgba") is None and clone.get("texture") not in derived_textures:
                if clone.get("texture"):
                    color = texture_average_color(clone)
                    if color is not None:
                        clone.set("rgba", " ".join("%.6g" % value for value in color))
                        entity["textureColorMaterials"].append(name)
            material_clones.append(clone)
        # asset 子元素按 mesh -> texture -> material 的 schema 顺序写。
        for clone in mesh_clones + texture_clones + material_clones:
            section.append(clone)
        return section

    def build_snippet(entity):
        if entity["kind"] != "world" and entity["xmlIndex"] is None:
            return None
        snippet = ET.Element("mujoco", {"model": "%s-%s" % (_safe_token(scene_id), _safe_token(entity["entityId"]))})
        for tag in ("compiler", "option", "size", "default"):
            section = root.find(tag)
            if section is None:
                continue
            clone = deepcopy(section)
            if tag == "compiler":
                # 片段里 mesh/texture 的 file 已是绝对路径；保留 meshdir/assetdir/texturedir
                # 会让 Viewer 再拼一次前缀（robot.ts: prefix + "/" + file）。
                for attribute in ("meshdir", "assetdir", "texturedir"):
                    clone.attrib.pop(attribute, None)
            snippet.append(clone)
        meshes = set()
        materials = set()
        worldbody_clone = ET.Element("worldbody")
        if entity["kind"] == "world":
            for child in static_world_geoms:
                clone = deepcopy(child)
                collect_assets(clone, meshes, materials)
                worldbody_clone.append(clone)
        else:
            source = body_elements[entity["xmlIndex"]]
            clone = deepcopy(source)
            prune(clone, source, entity)
            collect_assets(clone, meshes, materials)
            worldbody_clone.append(clone)
        snippet.append(asset_section(meshes, materials, entity))
        snippet.append(worldbody_clone)
        return snippet

    # ---- Scene 实体 ----
    ordered = sorted(entities, key=lambda entity: (entity["kind"] != "world", entity["kind"] != "robot",
                                                   entity["rootBodyId"] if entity["rootBodyId"] is not None else -1))
    scene_entities = []
    internal_entities = []
    for entity in ordered:
        snippet = build_snippet(entity)
        if snippet is None:
            entity["warnings"].append("BENCHMARK_SCENE_ENTITY_XML_MISSING")
            warnings.append("BENCHMARK_SCENE_ENTITY_DROPPED: " + entity["entityId"])
            continue
        if hasattr(ET, "indent"):
            ET.indent(snippet, space="  ")
        text = ET.tostring(snippet, encoding="unicode")
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]
        target = (derived_root / "scenes" / _safe_token(scene_id) / ("r%d" % revision)
                  / ("%s.%s.xml" % (_safe_token(entity["entityId"]), digest)))
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            temporary = target.with_name(target.name + ".tmp")
            temporary.write_text(text, encoding="utf-8")
            temporary.replace(target)

        for warning in entity["warnings"]:
            warnings.append("%s: %s" % (entity["entityId"], warning))
        anchor = _body_local_pose(model, entity["rootBodyId"])
        world = _world_pose(data, entity["rootBodyId"])
        transform = relative_scene_transform(np, world, anchor)
        joint_metadata = [{
            "name": record["name"], "type": JOINT_TYPE_NAMES[record["type"]],
            "body": record["bodyName"], "qpos0": record["qpos0"],
            **({"range": _round(model.jnt_range[record["id"]])} if int(model.jnt_limited[record["id"]]) else {}),
        } for record in entity["joints"]]
        source_uri = target.as_uri()
        representations = [{"uri": source_uri, "mimeType": "application/x-mjcf+xml", "role": "source"}]
        if entity["textureColorMaterials"]:
            representations[0]["losses"] = ["texture->average-color"]
        for mesh in entity["meshes"]:
            representation = {
                "uri": Path(mesh["file"]).as_uri(),
                "mimeType": VIEWER_MESH_MIME.get(Path(mesh["file"]).suffix.lower(), "application/octet-stream"),
                "role": "visual",
            }
            if mesh.get("derived"):
                representation["losses"] = ["msh->obj via official mujoco.msh2obj"]
            representations.append(representation)
        # 纹理按 representation 登记：Viewer 的 /api/lyapunov/resource 只放行 Scene 引用过的
        # URI 或其依赖，不登记的话 <texture file> 指向的 PNG 会被 RESOURCE_NOT_REFERENCED_BY_SCENE 拒掉。
        for texture in entity["textures"]:
            representations.append({
                "uri": Path(texture["file"]).as_uri(),
                "mimeType": texture["mimeType"],
                "role": "visual",
            })
        scene_entities.append({
            "entityId": entity["entityId"],
            "name": entity["name"],
            **({"parentId": entity["parentId"]} if entity["parentId"] else {}),
            "transform": {
                "position": _round(transform["position"]),
                "quaternion": _round(_xyzw(transform["quaternion"])),
                "scale": [1.0, 1.0, 1.0],
            },
            "resources": [{
                "resourceId": "official-mjcf:%s:%s:%d" % (scene_id, entity["entityId"], revision),
                "version": 1,
                "original": {"uri": source_uri, "mimeType": "application/x-mjcf+xml", "role": "source"},
                "representations": representations,
                "source": {"units": "m", "upAxis": "Z", "handedness": "right", "metersPerUnit": 1},
            }],
            "components": {
                "visual": {
                    "kind": "robot",
                    "robot": {
                        "format": "mjcf",
                        "document": document_of(snippet),
                        "baseUri": target.parent.as_uri() + "/",
                        # 世界 body 没有名字：缺省而不是 null，Viewer 会退化成“第一个顶层 body”作锚点。
                        **({"rootBody": entity["rootBodyName"]} if entity["rootBodyName"] else {}),
                    },
                },
                # 有 hinge/slide 关节的实体（official-robot，以及带抽屉/柜门的 articulated 对象）
                # 声明 articulation，面板据此识别可关节控制的实体；轴/范围直接取编译模型。
                **({"articulation": {
                    "joints": [{
                        "name": record["name"],
                        "type": JOINT_TYPE_NAMES[record["type"]],
                        "axis": _round(model.jnt_axis[record["id"]]),
                        **({"range": _round(model.jnt_range[record["id"]])} if int(model.jnt_limited[record["id"]]) else {}),
                    } for record in entity["joints"]],
                }} if entity["joints"] else {}),
                "mujoco": {
                    "source": "official-env",
                    "entityKind": entity["kind"],
                    "sourcePath": str(target),
                    **({"rootBody": entity["rootBodyName"]} if entity["rootBodyName"] else {}),
                    "objectName": entity["objectName"],
                    "freeJoint": any(record["type"] == 0 for record in entity["extraJoints"]),
                    "otherJointNames": [record["name"] for record in entity["extraJoints"]],
                    "jointNames": [record["name"] for record in entity["joints"]],
                    "joints": joint_metadata,
                    "meshes": entity["meshes"],
                    "textures": entity["textures"],
                    "sourcePose": {
                        "position": _round(anchor["position"]),
                        "quaternionXyzw": _round(_xyzw(anchor["quaternion"])),
                    },
                    **({"warnings": entity["warnings"]} if entity["warnings"] else {}),
                },
            },
        })
        internal_entities.append({
            "entityId": entity["entityId"], "rootBodyId": entity["rootBodyId"], "joints": entity["joints"],
        })

    if not scene_entities:
        return _unavailable("BENCHMARK_SCENE_EMPTY", "官方模型没有可投影实体", warnings)
    scene = {"sceneId": scene_id, "revision": revision, "coordinates": dict(SCENE_COORDINATES), "entities": scene_entities}
    if not _finite(scene):
        return _unavailable("BENCHMARK_SCENE_NOT_FINITE", "投影包含非有限数值，已放弃 Scene 以免污染 RPC", warnings)
    return {"status": "AVAILABLE", "scene": scene, "entities": internal_entities, "warnings": warnings}


def project_frame_entities(model, data, projection):
    """官方 mjData -> Frame 实体数组（世界位姿 + 官方关节名/位置/速度）。"""
    observations = []
    for entity in projection.get("entities", []):
        pose = _world_pose(data, entity.get("rootBodyId"))
        observation = {
            "entityId": entity["entityId"],
            "transform": {
                "position": _round(pose["position"]),
                "quaternion": _round(_xyzw(pose["quaternion"])),
                "scale": [1.0, 1.0, 1.0],
            },
        }
        records = entity.get("joints") or []
        if records:
            observation["joints"] = {
                "names": [record["name"] for record in records],
                "positions": [round(float(data.qpos[record["qposadr"]]), 9) for record in records],
                "velocities": [round(float(data.qvel[record["dofadr"]]), 9) for record in records],
            }
        observations.append(observation)
    return observations
