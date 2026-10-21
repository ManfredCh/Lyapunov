"""MJCF 内部子树真实拆分（RC v4 R-013 / §2.10 的原生格式层）。

一个 MJCF 源模型里选中一个**内部 body**，把它连同后代体真实切成两份可独立加载的 MJCF：

  · remaining：源模型复制后 `delete(selected)`，保留余下全部 body/joint/actuator/tendon/equality/sensor；
  · part：新建 MjSpec，把 donor 的 selected body 经 `add_frame().attach_body(prefix='part_')` 挂进新根，
    MuJoCo 会把引用该子树的 tendon/equality/actuator/sensor/keyframe 一并带过来。

本模块**不猜 API、不按 mesh 名或 link7 猜身份**：结构事实全部来自已安装 MuJoCo 3.13 的 MjSpec
真实枚举。它也**不把编译通过当作语义保全**：预检会先逐条列出跨切口依赖（tendon/equality/actuator/
sensor/contact-exclude 引用两侧、selected 是根/世界体、源文档含 include 未被内联等），任一严格保全
不了的项都在写入前拒绝并给出具体对象；SDK 的自动丢弃不会冒充成功。

原件与旧依赖一律只读：本模块只读源文件字节（split 前后各核一次 sha256），只往 `--out` 目录写派生件。
两份派生件都把**引用到的 mesh/texture 文件**复制进各自 `assets/` 子目录并写 `meshdir="assets"`，
因此离开原模型目录后仍能独立重载。part 用非空 `part_` 前缀，避免 MjSpec 生成空 default class。

CLI（由 scene-kit 的 TS 层调用，stdout 只输出一份 JSON）：
  mjcf_subtree.py precheck --source <panda.xml> --body <hand> [--json <report.json>]
  mjcf_subtree.py split    --source <panda.xml> --body <hand> --out <dir> --source-sha <sha>
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def sha256_file(path: str | os.PathLike[str]) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class Refusal(Exception):
    """结构化拒绝：带错误码前缀 + 具体对象，不静默替换。"""

    def __init__(self, code: str, message: str, details=None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.details = details or {}


def _load_mujoco():
    try:
        import mujoco  # noqa: PLC0415
    except Exception as exc:  # pragma: no cover - 由缺 SDK 环境触发
        raise SystemExit(json.dumps({
            "ok": False,
            "code": "MUJOCO_SDK_UNAVAILABLE",
            "message": f"无法 import mujoco：{exc}",
        }, ensure_ascii=False))
    return mujoco


def _walk_bodies(body):
    yield body
    for child in body.bodies:
        yield from _walk_bodies(child)


def _named_sites(spec) -> dict:
    """源真实 site 名 → 所属 body 名；供两侧 site 归属与派生名映射。"""
    result: dict[str, str] = {}
    for body in _walk_bodies(spec.worldbody):
        for site in body.sites:
            result[site.name] = body.name
    return result


def _name_map(source_names, derived_names, prefix: str) -> dict:
    """按**实际重载结果**求 source→derived 名映射：只收两侧都真存在、且按前缀对得上的对象。

    对不上（例如 URDF 切口关节从 part 移除、或 MuJoCo 因命名冲突改了名）就不写该条目的映射，
    消费侧按“未映射”处理并具名拒绝/失效，绝不猜一个未被 SDK 证实的名字。
    """
    derived = set(derived_names)
    mapping: dict[str, str] = {}
    for name in source_names:
        candidate = prefix + name
        if candidate in derived:
            mapping[name] = candidate
        elif name in derived:
            mapping[name] = name
    return mapping


def _side_name_map(subtree_bodies: set, all_bodies: set, spec, facts: dict, sides: dict) -> dict:
    """两侧 body/site/joint/actuator 的 source→derived 名映射，全部来自真实枚举与重载。"""
    site_owner = _named_sites(spec)
    part_sites = sorted(name for name, owner in site_owner.items() if owner in subtree_bodies)
    remaining_sites = sorted(name for name, owner in site_owner.items() if owner in all_bodies - subtree_bodies)
    return {
        "part": {
            "bodies": _name_map(sorted(subtree_bodies), sides["part"]["bodies"], "part_"),
            "sites": _name_map(part_sites, sides["part"]["sites"], "part_"),
            "joints": _name_map(facts["subtree"]["joints"], sides["part"]["joints"], "part_"),
            "actuators": _name_map(facts["subtree"]["actuators"], sides["part"]["actuators"], "part_"),
        },
        "remaining": {
            "bodies": _name_map(sorted(all_bodies), sides["remaining"]["bodies"], ""),
            "sites": _name_map(remaining_sites, sides["remaining"]["sites"], ""),
            "joints": _name_map(facts["remaining"]["joints"], sides["remaining"]["joints"], ""),
            "actuators": _name_map(facts["remaining"]["actuators"], sides["remaining"]["actuators"], ""),
        },
    }


def _option_attributes(source_path: str) -> dict:
    try:
        root = ET.parse(source_path).getroot()
    except ET.ParseError:
        return {}
    option = root.find("option")
    return dict(option.attrib) if option is not None else {}


def _escaped(obj) -> str:
    return obj.name if obj is not None else ""


def _object_side(name: str, part_bodies: set[str], joint_body: dict[str, str], tendon_side: dict[str, str], body_names: set[str], site_body: dict[str, str] | None = None, geom_body: dict[str, str] | None = None) -> str:
    """把某个被引用对象名映射到 'part' / 'remaining' / 'unknown'。"""
    if name in joint_body:
        return "part" if joint_body[name] in part_bodies else "remaining"
    if name in body_names:
        return "part" if name in part_bodies else "remaining"
    if name in tendon_side:
        return tendon_side[name]
    if site_body is not None and name in site_body:
        return "part" if site_body[name] in part_bodies else "remaining"
    if geom_body is not None and name in geom_body:
        return "part" if geom_body[name] in part_bodies else "remaining"
    return "unknown"


def _tendon_references(mujoco, spec, tendon):
    refs = []
    for wrap in tendon.path:
        kind = int(wrap.type)
        if kind == int(mujoco.mjtWrap.mjWRAP_JOINT) and wrap.target is not None:
            refs.append(("joint", wrap.target.name))
        elif kind == int(mujoco.mjtWrap.mjWRAP_SITE) and wrap.target is not None:
            refs.append(("site", wrap.target.name))
        elif kind == int(mujoco.mjtWrap.mjWRAP_GEOM) and wrap.target is not None:
            refs.append(("geom", wrap.target.name))
        elif kind in (int(mujoco.mjtWrap.mjWRAP_PULLEY),):
            refs.append(("pulley", wrap.target.name if wrap.target is not None else ""))
        else:
            refs.append(("unknown", getattr(getattr(wrap, "target", None), "name", "") or ""))
    return refs


def _equality_references(mujoco, equality):
    kind = int(equality.type)
    if kind == int(mujoco.mjtEq.mjEQ_JOINT):
        return [("joint", equality.name1), ("joint", equality.name2)]
    if kind == int(mujoco.mjtEq.mjEQ_TENDON):
        return [("tendon", equality.name1), ("tendon", equality.name2)]
    if kind in (int(mujoco.mjtEq.mjEQ_WELD), int(mujoco.mjtEq.mjEQ_CONNECT), int(mujoco.mjtEq.mjEQ_DISTANCE)):
        return [("body", equality.name1), ("body", equality.name2)]
    return [("unknown", equality.name1), ("unknown", equality.name2)]


def _actuator_references(mujoco, actuator):
    """执行器按传动类型给出所引用对象；返回 (kind, name) 列表，避免把跨切口驱动漏掉。"""
    try:
        transmission = int(actuator.trntype)
    except Exception:
        return [("unknown", "")]
    name = actuator.target if isinstance(actuator.target, str) else getattr(actuator.target, "name", "")
    if transmission in (int(mujoco.mjtTrn.mjTRN_JOINT), int(mujoco.mjtTrn.mjTRN_JOINTINPARENT)):
        return [("joint", name)]
    if transmission == int(mujoco.mjtTrn.mjTRN_TENDON):
        return [("tendon", name)]
    if transmission == int(mujoco.mjtTrn.mjTRN_SITE):
        return [("site", name)]
    if transmission == int(mujoco.mjtTrn.mjTRN_BODY):
        return [("body", name)]
    if transmission == int(mujoco.mjtTrn.mjTRN_SLIDERCRANK):
        site = actuator.slidersite if isinstance(actuator.slidersite, str) else getattr(actuator.slidersite, "name", "")
        return [("site", site), ("site", name)]
    return [("unknown", name)]


def _sensor_references(mujoco, sensor):
    """sensor 顶层元素的事务引用；无法核对的对象如实标 unknown，由预检拒绝。"""
    refs = []
    for attr in ("objname", "obj2name", "refname", "site", "body", "joint", "tendon"):
        value = getattr(sensor, attr, None)
        if isinstance(value, str) and value:
            refs.append((attr, value))
    # MuJoCo 3.13 的传感器对象有时挂在 objtype/objname 上；`objname` 足够本任务分类。
    return refs or [("unknown", "")]


def collect_facts(source_path: str, body_name: str) -> dict:
    """只读预检事实：结构枚举 + 跨切口依赖。任何写入前调用。"""
    mujoco = _load_mujoco()
    path = str(Path(source_path).resolve())
    if not os.path.isfile(path):
        raise Refusal("SUBTREE_SOURCE_MISSING", f"源文件不存在：{path}")
    source_sha = sha256_file(path)
    spec = mujoco.MjSpec.from_file(path)
    selected = spec.body(body_name)
    if selected is None:
        raise Refusal("SUBTREE_BODY_MISSING", f"源模型没有名为 {body_name} 的真实 body")
    if selected.id == 0 or selected.parent is None or selected.parent.id == 0:
        raise Refusal("SUBTREE_ROOT_BODY_UNSUPPORTED", f"{body_name} 是模型根/世界体；只能拆内部 body，不能拆整机根")

    part_bodies = {body.name for body in _walk_bodies(selected)}
    world_name = spec.worldbody.name
    all_bodies = {body.name for body in _walk_bodies(spec.worldbody)} - {world_name}
    remaining_bodies = all_bodies - part_bodies

    joint_body: dict[str, str] = {}
    site_body: dict[str, str] = {}
    geom_body: dict[str, str] = {}
    for body in _walk_bodies(spec.worldbody):
        for joint in body.joints:
            joint_body[joint.name] = body.name
        for site in body.sites:
            site_body[site.name] = body.name
        for geom in body.geoms:
            if geom.name:
                geom_body[geom.name] = body.name
    part_joints = sorted(name for name, owner in joint_body.items() if owner in part_bodies)
    remaining_joints = sorted(name for name, owner in joint_body.items() if owner in remaining_bodies)
    cut_joints = sorted(joint.name for joint in selected.joints)

    def side_of(name: str) -> str:
        return _object_side(name, part_bodies, joint_body, tendon_side, all_bodies, site_body, geom_body)

    # 先把 tendon 归属算出来，供 actuator/equality 引用。
    tendon_side: dict[str, str] = {}
    tendon_facts = []
    for tendon in spec.tendons:
        refs = _tendon_references(mujoco, spec, tendon)
        sides = {side_of(name) for _, name in refs if name}
        side = "part" if sides == {"part"} else "remaining" if sides == {"remaining"} else "cross" if sides else "empty"
        tendon_side[tendon.name] = side if side != "cross" else "cross"
        tendon_facts.append({"name": tendon.name, "references": [{"kind": k, "name": n} for k, n in refs], "side": side})

    cross_edges: list[dict] = []
    for fact in tendon_facts:
        if fact["side"] in ("cross", "empty"):
            cross_edges.append({
                "kind": "tendon",
                "name": fact["name"],
                "reason": "fixed/spatial tendon 的 wrap 引用横跨切口两侧" if fact["side"] == "cross" else "tendon 的 wrap 引用解析不出归属",
                "references": fact["references"],
            })

    equality_facts = []
    for index, equality in enumerate(spec.equalities):
        refs = _equality_references(mujoco, equality)
        sides = {side_of(name) for _, name in refs if name}
        side = "part" if sides == {"part"} else "remaining" if sides == {"remaining"} else "cross" if sides else "empty"
        item = {"name": equality.name or f"equality-{index}", "references": [{"kind": k, "name": n} for k, n in refs], "side": side}
        equality_facts.append(item)
        if side in ("cross", "empty"):
            cross_edges.append({
                "kind": "equality",
                "name": item["name"],
                "reason": "equality 引用横跨切口两侧" if side == "cross" else "equality 引用解析不出归属",
                "references": item["references"],
            })

    actuator_facts = []
    for actuator in spec.actuators:
        refs = _actuator_references(mujoco, actuator)
        sides = {side_of(name) for _, name in refs if name}
        if "cross" in sides or "unknown" in sides or not sides:
            side = "cross" if "cross" in sides else "unknown"
        else:
            side = "part" if sides == {"part"} else "remaining"
        item = {"name": actuator.name, "transmission": int(actuator.trntype), "references": [{"kind": k, "name": n} for k, n in refs], "side": side}
        actuator_facts.append(item)
        if side in ("cross", "unknown"):
            cross_edges.append({
                "kind": "actuator",
                "name": actuator.name,
                "reason": "执行器传动引用横跨切口两侧或无法解析",
                "references": item["references"],
            })

    sensor_facts = []
    for index, sensor in enumerate(spec.sensors):
        refs = _sensor_references(mujoco, sensor)
        sides = {side_of(name) for _, name in refs if name}
        if sides == {"part"}:
            side = "part"
        elif sides == {"remaining"}:
            side = "remaining"
        elif not sides:
            side = "empty"
        else:
            side = "cross"
        item = {"name": sensor.name or f"sensor-{index}", "references": [{"kind": k, "name": n} for k, n in refs], "side": side}
        sensor_facts.append(item)
        if side in ("cross", "empty"):
            cross_edges.append({
                "kind": "sensor",
                "name": item["name"],
                "reason": "sensor 引用横跨切口两侧或无法解析",
                "references": item["references"],
            })

    exclude_facts = []
    for index, exclude in enumerate(spec.excludes):
        names = [exclude.bodyname1, exclude.bodyname2]
        sides = {side_of(name) for name in names if name}
        side = "part" if sides == {"part"} else "remaining" if sides == {"remaining"} else "cross" if sides else "empty"
        item = {"name": f"exclude-{index}", "bodies": names, "side": side}
        exclude_facts.append(item)
        if side == "cross":
            cross_edges.append({
                "kind": "contact-exclude",
                "name": f"exclude-{index}",
                "reason": "contact exclude 横跨切口两侧，拆分后会静默改变接触，拒绝",
                "references": [{"kind": "body", "name": n} for n in names],
            })

    mesh_files, texture_files, copy_plan = _asset_copy_plan(spec)

    warnings = []
    if spec.keys:
        warnings.append({
            "code": "SUBTREE_KEYFRAMES_RESIZED",
            "message": f"源含 {len(spec.keys)} 个 keyframe；MuJoCo 会按两侧各自的 qpos/ctrl 维度重排（实测 home 保留），预检如实列出，不静默丢。",
            "names": [key.name for key in spec.keys],
        })

    return {
        "source": path,
        "sourceSha256": source_sha,
        "format": "mjcf",
        "modelName": spec.modelname,
        "selectedBody": body_name,
        "selectedBodyParent": selected.parent.name,
        "supported": not cross_edges,
        "subtree": {
            "bodies": sorted(part_bodies),
            "joints": part_joints,
            "cutJoints": cut_joints,
            "actuators": sorted(item["name"] for item in actuator_facts if item["side"] == "part"),
            "tendons": sorted(item["name"] for item in tendon_facts if item["side"] == "part"),
            "equalities": sorted(item["name"] for item in equality_facts if item["side"] == "part"),
            "sensors": sorted(item["name"] for item in sensor_facts if item["side"] == "part"),
            "meshes": len(mesh_files),
            "textures": len(texture_files),
        },
        "remaining": {
            "bodies": sorted(remaining_bodies),
            "joints": remaining_joints,
            "actuators": sorted(item["name"] for item in actuator_facts if item["side"] == "remaining"),
            "tendons": sorted(item["name"] for item in tendon_facts if item["side"] == "remaining"),
            "equalities": sorted(item["name"] for item in equality_facts if item["side"] == "remaining"),
            "sensors": sorted(item["name"] for item in sensor_facts if item["side"] == "remaining"),
        },
        "tendons": tendon_facts,
        "equalities": equality_facts,
        "actuators": actuator_facts,
        "sensors": sensor_facts,
        "excludes": exclude_facts,
        "closure": {
            "meshFiles": mesh_files,
            "textureFiles": texture_files,
            "copiedBytes": sum(plan["bytes"] for plan in copy_plan),
            "files": copy_plan,
        },
        "crossEdges": cross_edges,
        "warnings": warnings,
        "reason": ("SUBTREE_CROSS_EDGE_DEPENDENCY: 存在无法严格保全的跨切口引用，拒绝拆分；请先拆分或重建这些对象。"
                   if cross_edges else None),
    }


def _asset_copy_plan(spec) -> tuple[list[str], list[str], list[dict]]:
    """枚举引用到的 mesh/texture 文件并按声明路径拼复制清单。"""
    meshdir = spec.compiler.meshdir or spec.meshdir or ""
    texturedir = spec.compiler.texturedir or spec.texturedir or ""
    mesh_files, texture_files, plan = [], [], []
    base = Path(spec.modelfiledir).resolve() if getattr(spec, "modelfiledir", None) else Path(os.getcwd())
    def resolve_asset(name: str, directory: str) -> Path:
        resolved = Path(name)
        if resolved.is_absolute():
            return resolved.resolve()
        if directory:
            resolved = (Path(directory) / resolved)
            if resolved.is_absolute():
                return resolved.resolve()
        return (base / resolved).resolve()
    for mesh in spec.meshes:
        name = mesh.file
        if not name or name.startswith("package://"):
            continue
        resolved = resolve_asset(name, meshdir)
        mesh_files.append(name)
        plan.append({"kind": "mesh", "declared": name, "source": str(resolved), "bytes": resolved.stat().st_size})
    for texture in spec.textures:
        name = texture.file
        if not name or name.startswith("package://"):
            continue
        resolved = resolve_asset(name, texturedir)
        texture_files.append(name)
        plan.append({"kind": "texture", "declared": name, "source": str(resolved), "bytes": resolved.stat().st_size})
    return mesh_files, texture_files, plan


def _write_side(spec, mujoco, out_dir: Path, source_sha: str, option_attrs: dict, copy_plan: list[dict]) -> dict:
    """序列化一侧并复制资产闭包，随后**离开原目录**重载核对。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    assets_dir = out_dir / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    spec.compiler.meshdir = "assets"
    spec.compiler.texturedir = "assets"
    xml_text = spec.to_xml()
    tree = ET.fromstring(xml_text)
    compiler = tree.find("compiler")
    if compiler is None:
        compiler = ET.SubElement(tree, "compiler")
    compiler.set("meshdir", "assets")
    if any(plan["kind"] == "texture" for plan in copy_plan) or compiler.get("texturedir"):
        compiler.set("texturedir", "assets")
    # 显式保全源 option（例如 integrator=implicitfast）：不静默沿用新 spec 的默认。
    option_element = tree.find("option")
    if option_attrs:
        if option_element is None:
            option_element = ET.SubElement(tree, "option")
        for key, value in option_attrs.items():
            option_element.set(key, value)
    model_path = out_dir / "model.xml"
    ET.ElementTree(tree).write(model_path, encoding="unicode")

    copied = []
    for plan in copy_plan:
        source = Path(plan["source"])
        dest = assets_dir / plan["declared"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, dest)
        if sha256_file(source) != sha256_file(dest):
            raise Refusal("SUBTREE_ASSET_COPY_MISMATCH", f"资产复制后字节不一致：{plan['declared']}")
        copied.append({"kind": plan["kind"], "declared": plan["declared"], "bytes": dest.stat().st_size, "sha256": sha256_file(dest)})

    # 从**派生目录**重载：这是"离开原模型目录仍可独立加载"的真实证据，而不是内存编译。
    previous = os.getcwd()
    try:
        os.chdir(out_dir)
        model = mujoco.MjModel.from_xml_path(str(model_path))
    finally:
        os.chdir(previous)
    return {
        "model": str(model_path),
        "nbody": int(model.nbody),
        "nq": int(model.nq),
        "nv": int(model.nv),
        "nu": int(model.nu),
        "ntendon": int(model.ntendon),
        "neq": int(model.neq),
        "nkey": int(model.nkey),
        "bodies": [model.body(i).name for i in range(1, model.nbody)],
        "sites": [model.site(i).name for i in range(model.nsite)],
        "joints": [model.joint(i).name for i in range(model.njnt)],
        "actuators": [model.actuator(i).name for i in range(model.nu)],
        "integrator": int(model.opt.integrator),
        "files": copied,
        "copiedBytes": sum(item["bytes"] for item in copied),
    }


def split(source_path: str, body_name: str, out_dir: str, expected_sha: str | None) -> dict:
    mujoco = _load_mujoco()
    facts = collect_facts(source_path, body_name)
    if not facts["supported"]:
        raise Refusal("SUBTREE_CROSS_EDGE_DEPENDENCY", "拆分前预检发现跨切口引用，拒绝生成任何派生件", {"crossEdges": facts["crossEdges"]})
    path = str(Path(source_path).resolve())
    source_sha = sha256_file(path)
    if expected_sha and expected_sha != source_sha:
        raise Refusal("SUBTREE_SOURCE_CHANGED", f"源文件字节与请求声明的 SHA 不一致：{source_sha} != {expected_sha}")
    spec = mujoco.MjSpec.from_file(path)
    option_attrs = _option_attributes(path)

    remaining = spec.copy()
    remaining.delete(remaining.body(body_name))
    part = mujoco.MjSpec()
    part.option.integrator = spec.option.integrator
    part.modelname = (spec.modelname or "model") + "_part"
    part.worldbody.add_frame().attach_body(spec.copy().body(body_name), prefix="part_", suffix="")

    root = Path(out_dir).resolve()
    part_assets = facts["closure"]["files"]
    sides = {
        "remaining": _write_side(remaining, mujoco, root / "remaining", source_sha, option_attrs, part_assets),
        "part": _write_side(part, mujoco, root / "part", source_sha, option_attrs, part_assets),
    }
    part_bodies = set(facts["subtree"]["bodies"])
    all_bodies = part_bodies | set(facts["remaining"]["bodies"])
    name_map = _side_name_map(part_bodies, all_bodies, spec, facts, sides)
    after_sha = sha256_file(path)
    return {
        "ok": True,
        "outDir": str(root),
        "source": path,
        "sourceSha256": source_sha,
        "sourceStable": source_sha == after_sha,
        "selectedBody": body_name,
        "crossEdges": [],
        "warnings": facts["warnings"],
        "nameMap": name_map,
        "sides": sides,
    }


def _urdf_children(root):
    links = {}
    for link in root.findall("link"):
        links[link.get("name")] = link
    joints = []
    for joint in root.findall("joint"):
        parent = joint.find("parent")
        child = joint.find("child")
        joints.append({
            "element": joint,
            "name": joint.get("name"),
            "type": joint.get("type"),
            "parent": parent.get("link") if parent is not None else None,
            "child": child.get("link") if child is not None else None,
        })
    return links, joints


def _urdf_subtree(link_name, joints):
    reachable = {link_name}
    changed = True
    while changed:
        changed = False
        for joint in joints:
            if joint["parent"] in reachable and joint["child"] not in reachable:
                reachable.add(joint["child"])
                changed = True
    return reachable


def _urdf_mesh_files(root, links):
    files = []
    for link in links:
        for tag in ("visual", "collision"):
            for node in link.findall(tag):
                geometry = node.find("geometry")
                if geometry is None:
                    continue
                mesh = geometry.find("mesh")
                if mesh is not None and mesh.get("filename"):
                    files.append(mesh.get("filename"))
    return files


def urdf_collect_facts(source_path: str, link_name: str) -> dict:
    """URDF 只读预检：真实 link/joint 层级、切口关节、mimic/transmission/sensor 跨边引用。"""
    path = str(Path(source_path).resolve())
    if not os.path.isfile(path):
        raise Refusal("SUBTREE_SOURCE_MISSING", f"源文件不存在：{path}")
    source_sha = sha256_file(path)
    tree = ET.parse(path)
    root = tree.getroot()
    if root.tag != "robot":
        raise Refusal("URDF_ROOT_INVALID", "URDF 根元素不是 <robot>")
    links, joints = _urdf_children(root)
    if link_name not in links:
        raise Refusal("SUBTREE_BODY_MISSING", f"源模型没有名为 {link_name} 的真实 link")
    incoming = [joint for joint in joints if joint["child"] == link_name]
    if not incoming:
        raise Refusal("SUBTREE_ROOT_BODY_UNSUPPORTED", f"{link_name} 没有父关节（是根 link）；只能拆内部 link")
    cut_joint = incoming[0]
    subtree = _urdf_subtree(link_name, joints)
    remaining = set(links) - subtree
    part_joints = [joint for joint in joints if joint["child"] in subtree]
    remaining_joints = [joint for joint in joints if joint["child"] in remaining]

    cross_edges = []
    mimic_facts = []
    for joint in joints:
        mimic = joint["element"].find("mimic")
        if mimic is None:
            continue
        source_joint = mimic.get("joint")
        source = next((item for item in joints if item["name"] == source_joint), None)
        side = "unknown" if source is None else ("part" if source["child"] in subtree else "remaining")
        own = "part" if joint["child"] in subtree else "remaining"
        mimic_facts.append({"name": joint["name"], "mimics": source_joint, "side": side})
        if side != own:
            cross_edges.append({
                "kind": "mimic",
                "name": joint["name"],
                "reason": f"mimic 关节横跨切口（{joint['name']} 在 {own} 侧，模仿的 {source_joint} 在 {side} 侧），拒绝静默丢约束",
                "references": [{"kind": "joint", "name": joint["name"]}, {"kind": "joint", "name": source_joint}],
            })

    transmission_facts = []
    for transmission in root.findall("transmission"):
        refs = [joint.get("name") for joint in transmission.findall("joint")]
        sides = set()
        for name in refs:
            item = next((candidate for candidate in joints if candidate["name"] == name), None)
            if item is None:
                sides.add("unknown")
            else:
                sides.add("part" if item["child"] in subtree else "remaining")
        side = "cross" if len(sides) > 1 else (next(iter(sides)) if sides else "empty")
        transmission_facts.append({"name": transmission.get("name"), "joints": refs, "side": side})
        if side in ("cross", "unknown", "empty"):
            cross_edges.append({
                "kind": "transmission",
                "name": transmission.get("name"),
                "reason": "transmission 引用的关节横跨切口两侧或无法解析",
                "references": [{"kind": "joint", "name": name} for name in refs],
            })

    sensor_facts = []
    for gazebo in root.findall("gazebo"):
        reference = gazebo.get("reference")
        for sensor in gazebo.findall("sensor"):
            side = "unknown"
            if reference in subtree:
                side = "part"
            elif reference in remaining:
                side = "remaining"
            elif reference in {joint["name"] for joint in joints}:
                item = next(candidate for candidate in joints if candidate["name"] == reference)
                side = "part" if item["child"] in subtree else "remaining"
            sensor_facts.append({"name": sensor.get("name"), "reference": reference, "side": side})
            if side == "unknown":
                cross_edges.append({
                    "kind": "sensor",
                    "name": sensor.get("name"),
                    "reason": f"gazebo sensor 的 reference={reference} 无法归属到任何一侧",
                    "references": [{"kind": "reference", "name": reference}],
                })

    mesh_files = _urdf_mesh_files(root, links.values())
    part_meshes = _urdf_mesh_files(root, [links[name] for name in subtree])
    remaining_meshes = _urdf_mesh_files(root, [links[name] for name in remaining])
    base = Path(path).parent
    copy_plan = []
    for name in sorted(set(mesh_files)):
        if name.startswith("package://") or "://" in name:
            cross_edges.append({
                "kind": "mesh-uri",
                "name": name,
                "reason": "mesh 使用 package:// 或远程 URI，无法在不下载的前提下打包进派生闭包",
                "references": [{"kind": "mesh", "name": name}],
            })
            continue
        resolved = (base / name).resolve()
        if not resolved.is_file():
            cross_edges.append({
                "kind": "mesh-missing",
                "name": name,
                "reason": f"mesh 文件不存在：{resolved}",
                "references": [{"kind": "mesh", "name": name}],
            })
            continue
        copy_plan.append({"kind": "mesh", "declared": name, "source": str(resolved), "bytes": resolved.stat().st_size,
                          "sides": [side for side, names in (("remaining", remaining_meshes), ("part", part_meshes)) if name in names]})

    return {
        "source": path,
        "sourceSha256": source_sha,
        "format": "urdf",
        "modelName": root.get("name"),
        "selectedBody": link_name,
        "selectedBodyParent": cut_joint["parent"],
        "supported": not cross_edges,
        "subtree": {
            "bodies": sorted(subtree),
            "joints": sorted(joint["name"] for joint in part_joints if joint["name"]),
            "cutJoints": [cut_joint["name"]],
            "actuators": [],
            "tendons": [],
            "equalities": [],
            "sensors": sorted(item["name"] for item in sensor_facts if item["side"] == "part"),
            "meshes": len(part_meshes),
            "textures": 0,
        },
        "remaining": {
            "bodies": sorted(remaining),
            "joints": sorted(joint["name"] for joint in remaining_joints if joint["name"]),
            "actuators": [],
            "tendons": [],
            "equalities": [],
            "sensors": sorted(item["name"] for item in sensor_facts if item["side"] == "remaining"),
        },
        "tendons": [], "equalities": [], "actuators": [], "sensors": sensor_facts,
        "mimics": mimic_facts, "transmissions": transmission_facts,
        "excludes": [],
        "closure": {"meshFiles": sorted(set(mesh_files)), "textureFiles": [], "files": copy_plan,
                    "copiedBytes": sum(item["bytes"] for item in copy_plan)},
        "crossEdges": cross_edges,
        "warnings": [],
        "reason": ("SUBTREE_CROSS_EDGE_DEPENDENCY: URDF 存在无法严格保全的跨切口引用（mimic/transmission/sensor/mesh），拒绝拆分。"
                   if cross_edges else None),
    }


def _urdf_write_side(root, links, joints, kept_links, out_dir: Path, copy_plan: list[dict], cut_joint_name: str | None) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    new_root = ET.Element("robot", {"name": (root.get("name") or "robot") + ("_part" if cut_joint_name else "")})
    for child in root:
        tag = child.tag
        if tag == "link" and child.get("name") in kept_links:
            new_root.append(child)
        elif tag == "joint" and child.find("child") is not None and child.find("child").get("link") in kept_links and child.get("name") != cut_joint_name:
            new_root.append(child)
        elif tag in ("material", "gazebo"):
            if tag == "material":
                new_root.append(child)
            else:
                reference = child.get("reference")
                if reference in kept_links or reference in {joint["name"] for joint in joints if joint["name"] != cut_joint_name}:
                    new_root.append(child)
        elif tag == "transmission":
            names = [joint.get("name") for joint in child.findall("joint")]
            if names and all(any(j["name"] == name and j["child"] in kept_links for j in joints) for name in names):
                new_root.append(child)
    model_path = out_dir / "model.urdf"
    ET.ElementTree(new_root).write(model_path, encoding="unicode", xml_declaration=True)

    copied = []
    for plan in copy_plan:
        if out_dir.name not in plan["sides"]:
            continue
        source = Path(plan["source"])
        dest = out_dir / plan["declared"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, dest)
        if sha256_file(source) != sha256_file(dest):
            raise Refusal("SUBTREE_ASSET_COPY_MISMATCH", f"资产复制后字节不一致：{plan['declared']}")
        copied.append({"kind": plan["kind"], "declared": plan["declared"], "bytes": dest.stat().st_size, "sha256": sha256_file(dest)})

    mujoco = _load_mujoco()
    previous = os.getcwd()
    try:
        os.chdir(out_dir)
        model = mujoco.MjModel.from_xml_path(str(model_path))
    finally:
        os.chdir(previous)
    return {
        "model": str(model_path), "nbody": int(model.nbody), "nq": int(model.nq), "nv": int(model.nv),
        "nu": int(model.nu), "ntendon": int(model.ntendon), "neq": int(model.neq), "nkey": int(model.nkey),
        "bodies": [model.body(i).name for i in range(1, model.nbody)],
        "sites": [model.site(i).name for i in range(model.nsite)],
        "joints": [model.joint(i).name for i in range(model.njnt)],
        "actuators": [model.actuator(i).name for i in range(model.nu)],
        "integrator": int(model.opt.integrator), "files": copied, "copiedBytes": sum(item["bytes"] for item in copied),
    }


def urdf_split(source_path: str, link_name: str, out_dir: str, expected_sha: str | None) -> dict:
    facts = urdf_collect_facts(source_path, link_name)
    if not facts["supported"]:
        raise Refusal("SUBTREE_CROSS_EDGE_DEPENDENCY", "URDF 拆分前预检发现跨切口引用，拒绝生成任何派生件", {"crossEdges": facts["crossEdges"]})
    path = str(Path(source_path).resolve())
    source_sha = sha256_file(path)
    if expected_sha and expected_sha != source_sha:
        raise Refusal("SUBTREE_SOURCE_CHANGED", f"源文件字节与请求声明的 SHA 不一致：{source_sha} != {expected_sha}")
    tree = ET.parse(path)
    root = tree.getroot()
    links, joints = _urdf_children(root)
    subtree = _urdf_subtree(link_name, joints)
    remaining = set(links) - subtree
    cut_joint_name = next(joint["name"] for joint in joints if joint["child"] == link_name)
    root_dir = Path(out_dir).resolve()
    sides = {
        "remaining": _urdf_write_side(root, links, joints, remaining, root_dir / "remaining", facts["closure"]["files"], None),
        "part": _urdf_write_side(root, links, joints, subtree, root_dir / "part", facts["closure"]["files"], cut_joint_name),
    }
    name_map = {
        "part": {
            "bodies": _name_map(sorted(subtree), sides["part"]["bodies"], ""),
            "sites": _name_map([], sides["part"]["sites"], ""),
            "joints": _name_map(facts["subtree"]["joints"], sides["part"]["joints"], ""),
            "actuators": _name_map(facts["subtree"]["actuators"], sides["part"]["actuators"], ""),
        },
        "remaining": {
            "bodies": _name_map(sorted(remaining), sides["remaining"]["bodies"], ""),
            "sites": _name_map([], sides["remaining"]["sites"], ""),
            "joints": _name_map(facts["remaining"]["joints"], sides["remaining"]["joints"], ""),
            "actuators": _name_map(facts["remaining"]["actuators"], sides["remaining"]["actuators"], ""),
        },
    }
    after_sha = sha256_file(path)
    return {
        "ok": True, "outDir": str(root_dir), "source": path, "sourceSha256": source_sha,
        "sourceStable": source_sha == after_sha, "selectedBody": link_name,
        "cutJoint": {"name": cut_joint_name, "parent": facts["selectedBodyParent"], "type": next(joint["type"] for joint in joints if joint["name"] == cut_joint_name)},
        "crossEdges": [], "warnings": facts["warnings"], "nameMap": name_map, "sides": sides,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="MJCF/URDF internal subtree split")
    sub = parser.add_subparsers(dest="command", required=True)
    pre = sub.add_parser("precheck")
    pre.add_argument("--source", required=True)
    pre.add_argument("--body", required=True)
    pre.add_argument("--json")
    sp = sub.add_parser("split")
    sp.add_argument("--source", required=True)
    sp.add_argument("--body", required=True)
    sp.add_argument("--out", required=True)
    sp.add_argument("--source-sha")
    args = parser.parse_args(argv)
    try:
        urdf = str(Path(args.source).suffix).lower() == ".urdf"
        if args.command == "precheck":
            result = urdf_collect_facts(args.source, args.body) if urdf else collect_facts(args.source, args.body)
            if args.json:
                Path(args.json).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
            print(json.dumps(result, ensure_ascii=False))
            return 0
        result = urdf_split(args.source, args.body, args.out, args.source_sha) if urdf else split(args.source, args.body, args.out, args.source_sha)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Refusal as refusal:
        print(json.dumps({"ok": False, "code": refusal.code, "message": refusal.message, "details": refusal.details}, ensure_ascii=False))
        return 3
    except Exception as exc:  # pragma: no cover - 兜底结构化错误
        print(json.dumps({"ok": False, "code": "SUBTREE_NATIVE_FAILED", "message": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
