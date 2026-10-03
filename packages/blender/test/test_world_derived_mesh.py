"""ENV-24 的 Python 侧行为测试：文字/曲线在**派生副本**里转 MESH 导出，原工程保持可编辑。

验收点与对应检查：
  · FONT/CURVE 这类可显示对象进入 scene.json 实体并有真实 GLB（此前整类对象被丢掉，招牌根本不存在）；
  · 派生副本带出网格、UV（TEXCOORD_0）、材质；未填充的曲线如实报"没有面"，不伪造几何；
  · 层级（父级）与位姿在导出后仍正确；
  · source.blend 里原对象**毫发无损**：文字仍可改内容、曲线倒角仍在、没有 __derived 残留、用户对象与导出前逐字段一致；
  · 物理语义不变：文字/曲线不凭空多出碰撞体，带 lyapunov_shape 的网格仍有碰撞；
  · MESH 的 UV/PBR 路径（UV + 贴图）在重构后仍完整；
  · 文字确实进入渲染画面（可见/隐藏两版渲染图不同）。

场景与渲染都由测试脚本现场生成，受测的是真实 `packages/blender/src/world.py` 与其真实产物。
跑法：`python3 packages/blender/test/test_world_derived_mesh.py`（环境变量见 test_world_harness.py）。
"""
from __future__ import annotations

import json
import shlex
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_world_harness import (  # noqa: E402
    FACTS_CODE, Checks, blender_executable, color_match, entity_map, fresh_dir, glb_facts, glb_paths,
    image_difference, png_pixels, run_world, scene_facts, workdir, write_script,
)

# 现场场景：空父级 + 网格（真 UV/贴图）+ 文字 + 倒角曲线 + 未填充曲线 + 带碰撞属性的盒子 + 相机/灯。
SCENE_TEMPLATE = '''"""测试用场景：先建场景，再由 world.py 做真实的建造/导出。"""
import bpy, json, math
from mathutils import Vector
from pathlib import Path

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

bpy.ops.object.empty_add(location=(0, 0, 0))
root = bpy.context.object
root.name = "asset_root"

# 真 UV + 贴图的网格：核对 MESH 的 UV/PBR 路径没有因为重构而丢失。
image = bpy.data.images.new("checker", width=8, height=8)
image.filepath_raw = str(Path(r"{image_path}"))
image.file_format = "PNG"
image.save()
textured = bpy.data.materials.new("贴图材质")
textured.use_nodes = True
image_node = textured.node_tree.nodes.new("ShaderNodeTexImage")
image_node.image = image
textured.node_tree.links.new(image_node.outputs["Color"], textured.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
bpy.ops.mesh.primitive_cube_add(size=1)
cube = bpy.context.object
cube.name = "uv_cube"
cube.parent = root
cube.location = (1.2, 0, 0.4)
if not cube.data.uv_layers:
    cube.data.uv_layers.new(name="UVMap")
cube.data.materials.append(textured)

# 文字：可显示但本来不是网格，此前在导出里整类消失。
bpy.ops.object.text_add(location=(-1.2, 0, 1.0))
font = bpy.context.object
font.name = "sign_text"
font.data.body = "Sign"
font.data.size = 1.0
font.data.extrude = 0.05
# text_add 的文字躺在 XY 平面上（朝上）；转成竖着的招牌正面朝 -Y，机位才看得到正面而不是侧棱。
font.rotation_euler = (math.pi / 2, 0, 0)
font.parent = root
sign_material = bpy.data.materials.new("招牌材质")
font.data.materials.append(sign_material)

# 有填充（倒角）的曲线：真实可显示的栏杆。
bpy.ops.curve.primitive_bezier_circle_add(location=(0, 1.5, 0.6))
curve = bpy.context.object
curve.name = "railing"
curve.data.bevel_depth = 0.06
curve.data.bevel_resolution = 2
curve.parent = root
rail_material = bpy.data.materials.new("栏杆材质")
curve.data.materials.append(rail_material)

# 未填充的 2D 曲线：派生网格本来就没有面，导出必须如实报告而不是伪造几何。
bpy.ops.curve.primitive_bezier_curve_add(location=(0, 3, 0))
flat = bpy.context.object
flat.name = "flat_path"
flat.parent = root

# 带碰撞属性的网格：核对物理语义没被这次改动带偏（文字/曲线不该凭空多出碰撞体）。
bpy.ops.mesh.primitive_cube_add(size=1)
solid = bpy.context.object
solid.name = "collision_box"
solid.parent = root
solid.location = (2.4, 0, 0.3)
solid.dimensions = (0.6, 0.6, 0.6)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
solid["lyapunov_shape"] = "box"
solid["lyapunov_size"] = [0.6, 0.6, 0.6]

# 对象级材质覆盖（link='OBJECT'）：data 槽是红，对象槽覆盖成蓝。
# 这是真实作者会干的事（同一个文字数据复用、每个对象换材质），而对象级槽不属于网格数据。
red_data = bpy.data.materials.new("数据材质")
red_data.use_nodes = True
red_data.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (1, 0, 0, 1)
blue_override = bpy.data.materials.new("覆盖材质")
blue_override.use_nodes = True
blue_override.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0, 0, 1, 1)

bpy.ops.object.text_add(location=(-3.2, 0, 1.0))
overlay_text = bpy.context.object
overlay_text.name = "overlay_text"
overlay_text.data.body = "Ov"
overlay_text.data.size = 1.0
overlay_text.rotation_euler = (math.pi / 2, 0, 0)
overlay_text.parent = root
overlay_text.data.materials.append(red_data)
overlay_text.material_slots[0].link = "OBJECT"
overlay_text.material_slots[0].material = blue_override

# 对照：真 MESH 上同样的覆盖。它走原有的直接导出路径，用来证明"该带覆盖材质"这个预期本身没错。
bpy.ops.mesh.primitive_cube_add(size=1)
override_cube = bpy.context.object
override_cube.name = "override_cube"
override_cube.parent = root
override_cube.location = (3.4, 0, 0.4)
override_cube.data.materials.append(red_data)
override_cube.material_slots[0].link = "OBJECT"
override_cube.material_slots[0].material = blue_override

# 机位正对文字：用来核对"文字确实进入渲染画面"。
bpy.ops.object.camera_add(location=(-1.2, -4.0, 1.0))
camera = bpy.context.object
camera.name = "proof_camera"
camera.data.lens = 50
camera.rotation_euler = (Vector((-1.2, 0, 1.0)) - camera.location).to_track_quat("-Z", "Y").to_euler()
bpy.context.scene.camera = camera
bpy.ops.object.light_add(type="SUN", location=(0, -3, 6))
bpy.context.object.data.energy = 4
# 太阳默认朝下照；转 45° 让它也照到朝 -Y 的招牌正面（否则招牌背光，差异会偏小）。
bpy.context.object.rotation_euler = (math.radians(45), 0, 0)
bpy.context.scene.render.engine = "BLENDER_EEVEE"
bpy.context.scene.render.resolution_x = 200
bpy.context.scene.render.resolution_y = 150
bpy.context.scene.render.resolution_percentage = 100

font.hide_render = {hide_font}

# 导出前把"用户对象"的现场状态落盘，稍后与重开的 source.blend 逐字段对比。
{FACTS_CODE}
Path(r"{facts_path}").write_text(json.dumps(report, ensure_ascii=False))
'''


def scene_script(name: str, hide_font: bool = False) -> tuple[Path, Path]:
    facts_path = workdir() / f"scene-before-{name}.json"
    image_path = workdir() / f"checker-{name}.png"
    text = SCENE_TEMPLATE.format(image_path=image_path, facts_path=facts_path, hide_font=hide_font, FACTS_CODE=FACTS_CODE)
    return write_script(f"scene-{name}.py", text), facts_path


def check_derived_export(checks: Checks):
    """文字/曲线进实体、GLB 带网格与 UV，未填充曲线如实为空，层级与物理语义不变。"""
    output = fresh_dir("derived-build")
    script, facts_path = scene_script("build")
    run = run_world(["--operation", "build", "--output", output], scene_script=script)
    checks.check("build 干净退出（exit 0 且无异常堆栈）", run.clean,
                 "cmd=" + " ".join(shlex.quote(item) for item in run.argv) + f" exit={run.code} tail={run.tail()}")
    result = run.result or {}
    snapshot = json.loads((output / "scene.json").read_text()) if (output / "scene.json").is_file() else {}
    entities = entity_map(snapshot)
    checks.check("文字/曲线都进了 scene.json 实体（此前整类被丢弃）",
                 {"sign_text", "railing", "flat_path"} <= set(entities) and result.get("visuals") == 7,
                 f"entities={sorted(entities)} visuals={result.get('visuals')} glb={len(glb_paths(output))}")
    # 资源文件名现在是 `visuals/<resourceId>-v<rev>.glb`（版本化、不可覆盖），按实体从 scene.json 取真文件。
    visuals = ("collision_box", "flat_path", "overlay_text", "override_cube", "railing", "sign_text", "uv_cube")

    def visual(name: str) -> Path:
        return Path(entities[name]["resources"][0]["representations"][0]["uri"])

    checks.check("每个可显示对象都有真实 GLB（七个实体各指向一个存在且版本化的文件）",
                 len(glb_paths(output)) == 7
                 and all(visual(name).is_file() and "-v" in visual(name).stem for name in visuals)
                 and len({visual(name) for name in visuals}) == 7,
                 str(glb_paths(output)))

    sign = glb_facts(visual("sign_text"))
    checks.check("文字 GLB 带网格、UV 与材质",
                 sign["meshCount"] >= 1 and "TEXCOORD_0" in sign["attributes"] and sign["materials"] == ["招牌材质"],
                 json.dumps(sign, ensure_ascii=False))
    rail = glb_facts(visual("railing"))
    checks.check("倒角曲线 GLB 带网格、UV 与材质",
                 rail["meshCount"] >= 1 and "TEXCOORD_0" in rail["attributes"] and rail["materials"] == ["栏杆材质"],
                 json.dumps(rail, ensure_ascii=False))
    flat = glb_facts(visual("flat_path"))
    checks.check("未填充曲线如实为空（不伪造几何）", flat["meshCount"] == 0,
                 json.dumps(flat, ensure_ascii=False))
    cube = glb_facts(visual("uv_cube"))
    checks.check("MESH 的 UV/PBR 路径仍完整（UV + 内嵌贴图）",
                 cube["meshCount"] == 1 and "TEXCOORD_0" in cube["attributes"] and cube["images"] == 1 and cube["materials"] == ["贴图材质"],
                 json.dumps(cube, ensure_ascii=False))

    # 对象级材质覆盖（link='OBJECT'）不属于网格数据：派生副本只补空槽的话，data 上的旧材质会盖住覆盖。
    overlay = glb_facts(visual("overlay_text"))
    overlay_color = overlay["materialBaseColors"].get("覆盖材质")
    checks.check("文字的对象级材质覆盖进了 GLB（不是 data 上的旧材质）",
                 overlay["materials"] == ["覆盖材质"] and color_match(overlay_color, [0, 0, 1, 1]),
                 json.dumps({"materials": overlay["materials"], "baseColors": overlay["materialBaseColors"]}, ensure_ascii=False))
    control = glb_facts(visual("override_cube"))
    checks.check("对照：真 MESH 的同类覆盖走原路径也导出覆盖材质（预期本身没错）",
                 control["materials"] == ["覆盖材质"] and color_match(control["materialBaseColors"].get("覆盖材质"), [0, 0, 1, 1]),
                 json.dumps({"materials": control["materials"], "baseColors": control["materialBaseColors"]}, ensure_ascii=False))

    checks.check("转换来源与限制如实写进实体与资源表示",
                 entities["sign_text"]["components"]["visual"].get("convertedFrom") == "FONT"
                 and entities["railing"]["components"]["visual"].get("convertedFrom") == "CURVE"
                 and entities["flat_path"]["components"]["visual"].get("geometryEmpty") is True
                 and any("派生副本" in loss for loss in entities["sign_text"]["resources"][0]["representations"][0]["losses"])
                 and any("没有面" in loss for loss in entities["flat_path"]["resources"][0]["representations"][0]["losses"]),
                 json.dumps([entities[name]["components"]["visual"] for name in ("sign_text", "railing", "flat_path")], ensure_ascii=False))
    checks.check("未转换的 MESH 不带转换标记",
                 "convertedFrom" not in entities["uv_cube"]["components"]["visual"]
                 and "convertedFrom" not in entities["collision_box"]["components"]["visual"],
                 json.dumps(entities["uv_cube"]["components"]["visual"], ensure_ascii=False))

    children = ("sign_text", "railing", "flat_path", "uv_cube", "collision_box", "overlay_text", "override_cube")
    parents = {name: entities[name].get("parentId") for name in children}
    checks.check("层级保持（七个子对象仍挂在 asset_root 下）",
                 set(parents.values()) == {"asset_root"}, json.dumps(parents, ensure_ascii=False))
    position = entities["sign_text"]["transform"]["position"]
    checks.check("文字位姿由实体 transform 承载（不与几何混在一起）",
                 len(position) == 3 and max(abs(actual - want) for actual, want in zip(position, (-1.2, 0.0, 1.0))) < 1e-6,
                 json.dumps(entities["sign_text"]["transform"], ensure_ascii=False))
    checks.check("物理语义不变：文字/曲线没有碰撞体，带 lyapunov_shape 的网格仍有",
                 all("collision" not in entities[name]["components"] for name in ("sign_text", "railing", "flat_path"))
                 and entities["collision_box"]["components"].get("collision", {}).get("sizeM") == [0.6, 0.6, 0.6],
                 f"文字组件={sorted(entities['sign_text']['components'])} 盒子={entities['collision_box']['components'].get('collision')}")
    return output, facts_path, run


def check_source_project_stays_editable(checks: Checks, output: Path, facts_path: Path):
    """重开 source.blend：文字/曲线仍可编辑，派生副本没落盘，用户对象与导出前逐字段一致。"""
    before = json.loads(facts_path.read_text())
    after = scene_facts(output / "source.blend")
    names_before = {name for name in before if not name.startswith("_")}
    names_after = {name for name in after if not name.startswith("_")}
    checks.check("导出确实发生过（场景带了资源版本戳，后面的没动过才有意义）",
                 bool(after.get("_sceneProps", {}).get("lyapunov_export_version")),
                 json.dumps(after.get("_sceneProps", {}), ensure_ascii=False))
    checks.check("重开工程：文字仍是 FONT 且内容可改",
                 after.get("sign_text", {}).get("type") == "FONT" and after["sign_text"].get("body") == "Sign"
                 and after["sign_text"].get("extrude", 0) > 0.04,
                 f"type={after.get('sign_text', {}).get('type')} body={after.get('sign_text', {}).get('body')!r} extrude={after.get('sign_text', {}).get('extrude')}")
    checks.check("重开工程：曲线仍是 CURVE 且倒角/样条还在",
                 after.get("railing", {}).get("type") == "CURVE" and after["railing"].get("bevelDepth", 0) > 0.05
                 and after["railing"].get("splines") == 1,
                 f"type={after.get('railing', {}).get('type')} bevelDepth={after.get('railing', {}).get('bevelDepth')} splines={after.get('railing', {}).get('splines')}")
    leaked = sorted(name for name in after if name.endswith("__derived"))
    checks.check("派生副本没有落进源工程（对象集合不多不少）",
                 leaked == [] and names_after == names_before,
                 f"残留={leaked} 多出={sorted(names_after - names_before)} 少了={sorted(names_before - names_after)}")
    mismatched = []
    for name, item in before.items():
        current = after.get(name)
        if current is None:
            continue
        for key in ("type", "parent", "location", "materials", "props"):
            if current.get(key) != item.get(key):
                mismatched.append(f"{name}.{key}: {item.get(key)!r} → {current.get(key)!r}")
    checks.check("用户对象在导出前后逐字段一致（类型/父级/位姿/材质/自定义属性）",
                 not mismatched, "; ".join(mismatched) or f"{len(names_before)} 个对象全部一致")


def check_text_is_actually_rendered(checks: Checks):
    """文字必须真的进入渲染画面：同机位渲染三次，隐藏文字后的像素差异要远高于渲染噪声基线。

    只看"两次渲染字节不同"证明不了任何事——渲染器逐次本来就有抖动。所以先量噪声基线
    （同一场景渲染两次的显著差异像素数），再看移除文字带来的差异，并要求它高出基线一个量级。
    """
    images = {}
    for label, hide in (("visible-a", False), ("visible-b", False), ("hidden", True)):
        output = fresh_dir(f"derived-render-{label}")
        script, _ = scene_script(label, hide_font=hide)
        run = run_world(["--operation", "preview", "--cameras", '["proof_camera"]',
                         "--resolution", "[200,150]", "--samples", "4", "--output", output], scene_script=script)
        image = output / "renders" / "proof_camera.png"
        if not run.clean or not image.is_file():
            checks.check(f"preview（{label}）成功出图", False, f"exit={run.code} tail={run.tail()}")
            return
        images[label] = png_pixels(image)
    noise = image_difference(images["visible-a"], images["visible-b"])
    signal = image_difference(images["visible-a"], images["hidden"])
    checks.check("同一场景两次渲染的差异只是噪声（差异量尺的基线）", noise["significant"] < 200,
                 f"噪声基线={noise} 文字信号={signal}")
    box = signal["bbox"] or [0, 0, images["visible-a"]["width"], images["visible-a"]["height"]]
    coverage = box[2] * box[3] / (images["visible-a"]["width"] * images["visible-a"]["height"])
    checks.check("文字确实进入渲染画面（隐藏文字后差异高出噪声基线一个量级且成片出现）",
                 signal["significant"] > max(10 * noise["significant"], 200) and coverage < 0.9,
                 f"信号={signal['significant']} 噪声={noise['significant']} 峰值={signal['peak']} 包围盒={box} 占画面={coverage:.0%}")


def main() -> int:
    checks = Checks("ENV-24 文字/曲线派生网格导出（真实 Blender）")
    if blender_executable() is None:
        return checks.blocked_on("找不到真实 Blender 可执行文件：设置 BLENDER_EXECUTABLE 或把 blender 放进 PATH")
    output, facts_path, _run = check_derived_export(checks)
    check_source_project_stays_editable(checks, output, facts_path)
    check_text_is_actually_rendered(checks)
    return checks.finish()


if __name__ == "__main__":
    sys.exit(main())
