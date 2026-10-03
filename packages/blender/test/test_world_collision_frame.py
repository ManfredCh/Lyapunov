"""碰撞盒帧对齐测试：导出的 center/尺寸必须落在**对象局部帧**，且与实体 TRS/父子层级/单位缩放严格对齐。

验收点与对应检查：
  · 普通 primitive_box（原点在几何中心）**原行为保留**：center 仍是 [0,0,0]，尺寸仍等于声明尺寸；
  · 几何烘焙进顶点、原点不在几何中心（48 真实院落形态）→ center 是对象局部帧里的几何中心，
    既不是原点，也不是世界包围盒中心（用一个"局部中心≠世界中心"的旋转对象反证）；
  · 平移 / 旋转 / 父层非均匀缩放 / 父层镜像缩放 / mesh 内偏移原点各一例：把导出读数按**消费方约定**
    （sim-mujoco worker 的 world_poses 位姿合成 + geom pos/size 乘累计缩放）还原成世界位形，与
    Blender 现场真值（matrix_world @ 局部中心、世界包围盒）逐一核对；
  · 父层非均匀缩放 + 子体旋转是盒合同表示不了的**剪切**位形：产品结果里带结构化 loss
    （两条出口各自的实测角点偏差 + 后续接口），world.xml 出口给的是真实体积在 body 帧里的紧包络，
    scene.json 出口按消费方约定给同帧最佳值——都不冒充精确碰撞盒；
  · 动态实体挂在**非单位缩放**父级下（freejoint 要独立实例化）：提升世界位姿时位置/朝向/缩放一起提升，
    Scene/GLB 出口的 transform 与 world.xml 的 body 都等于 Blender 世界位姿，并在真引擎里做真实落体
    核对静止高度（丢了父链缩放会差一个可直接量出来的量）；
  · lyapunov_size 过期 → 以评估后局部几何为准，并把过期声明记进 declaredSizeM；
  · 修改器 → 盒子量的是评估后几何（记录 evaluatedModifiers），不是原始 data；
  · 形态键 + 修改器 → 导出器保变形目标、拒绝烘修改器，盒子就量**同一份不带修改器**的几何（与可视 GLB 同源），
    并把没被表示的修改器记进 unbakedModifiers + 结构化 loss（不静默丢目标）；
  · 没有可测几何（EMPTY）与关闭碰撞的对象：前者按声明尺寸落在原点并标明来源，后者不多出碰撞体；
  · 可精确表示的位形上 physics/world.xml 与 scene.json 是同一世界位形；
  · isaac/import.json 的碰撞清单按实体带 losses（空列表=该盒与几何一致）；
  · 源工程未被这次导出改动：UV/修改器/自定义属性逐字段可核对。

场景由测试脚本现场生成，受测的是真实 `packages/blender/src/world.py` 与其真实产物。
跑法：`python3 packages/blender/test/test_world_collision_frame.py`（环境变量见 test_world_harness.py）。
`LYAPUNOV_SIM_PYTHON` 指向带 mujoco 的解释器（缺省用产品运行根的 .runtime/sim-python）时，本测试
还会用**真引擎**编译 physics/world.xml 与 scene.json 两条出口，核对 geom 世界位形与盒尺寸。
其中 scene.json 那条走 worker 的原生编译：worker 用**带符号**累计缩放乘 halfExtents，镜像父级会得到
负尺寸被 MuJoCo 拒收（worker.py 的既有行为，本任务范围外，见 NEEDS_ROOT.md）。这里不静默跳过——测试
按"去掉负缩放子树"的子集核对，并用**修前形状的同一场景**做对照，把两边的真实报错一起打印出来。
"""
from __future__ import annotations

import json
import math
import os
import shlex
import subprocess
import sys
from pathlib import Path
from xml.etree import ElementTree

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_world_harness import (  # noqa: E402
    Checks, blender_executable, entity_map, fresh_dir, inspect_blend, run_world, write_script, workdir,
)

SCENE_TEMPLATE = '''"""测试场景：几何来源（中心/偏移/修改器）与位姿（平移/旋转/父级缩放/镜像）交叉，覆盖碰撞盒的帧对齐。"""
import bpy, json, math
from mathutils import Vector
from pathlib import Path

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

# 建筑类场景：导出时一并写 isaac/import.json（碰撞清单），用来核对 loss 也进那份回执。
bpy.context.scene["lyapunov_world_kind"] = "architecture"


def cube(name, size, offset=(0.0, 0.0, 0.0), uv=False):
    """立方体网格：size 是局部几何尺寸，offset 把顶点整体挪开（对象原点不动，模拟烘焙进顶点的几何）。"""
    bpy.ops.mesh.primitive_cube_add(size=1)
    obj = bpy.context.object
    obj.name = name
    for vertex in obj.data.vertices:
        vertex.co = Vector((vertex.co.x * size[0] + offset[0], vertex.co.y * size[1] + offset[1], vertex.co.z * size[2] + offset[2]))
    if uv and not obj.data.uv_layers:
        obj.data.uv_layers.new(name="UVMap")
    return obj


bpy.ops.object.empty_add(location=(0.0, 0.0, 0.0))
root = bpy.context.object
root.name = "frame_root"

bpy.ops.object.empty_add(location=(0.0, 3.0, 0.0))
scaled = bpy.context.object
scaled.name = "scaled_parent"
scaled.parent = root
scaled.scale = (2.0, 1.0, 0.5)

bpy.ops.object.empty_add(location=(3.0, 3.0, 0.0))
mirror = bpy.context.object
mirror.name = "mirror_parent"
mirror.parent = root
mirror.scale = (-1.0, 1.0, 1.0)

# 1) 普通 primitive_box：原点在几何中心（原生 box() 形态），声明与几何一致。
bpy.ops.mesh.primitive_cube_add(size=1)
centered = bpy.context.object
centered.name = "centered_box"
centered.parent = root
centered.location = (1.5, 0.5, 0.3)
centered.dimensions = (0.6, 0.4, 0.2)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
centered["lyapunov_shape"] = "box"
centered["lyapunov_size"] = [0.6, 0.4, 0.2]

# 2) 几何烘焙进顶点、原点不在几何中心（48 真实院落的院墙形态）+ UV。
baked = cube("baked_slab", (2.0, 1.0, 0.06), offset=(-2.9, 1.5, 1.31), uv=True)
baked.parent = root
baked["lyapunov_shape"] = "box"
baked["lyapunov_size"] = [2.0, 1.0, 0.06]

# 3) 旋转位姿 + mesh 内偏移原点：局部中心与世界中心不是一回事。
rotated = cube("rotated_offset", (0.8, 0.4, 1.2), offset=(0.35, -0.1, 0.6))
rotated.parent = root
rotated.location = (-1.5, -2.0, 0.2)
rotated.rotation_euler = (0.0, 0.0, math.radians(30))
rotated["lyapunov_shape"] = "box"
rotated["lyapunov_size"] = [0.8, 0.4, 1.2]

# 4) 父层非均匀缩放（子体不旋转 → 位形可被 MJCF 精确表示）。
child = cube("child_in_scaled_parent", (0.5, 0.4, 0.5), offset=(0.25, 0.0, 0.25))
child.parent = scaled
child.location = (0.5, 0.0, 0.2)
child["lyapunov_shape"] = "box"
child["lyapunov_size"] = [0.5, 0.4, 0.5]

# 5) 父层镜像（负）缩放：尺寸必须仍为正，方向由位姿承担。
mirrored = cube("child_in_mirror_parent", (0.4, 0.6, 0.2), offset=(0.1, 0.2, 0.1))
mirrored.parent = mirror
mirrored.location = (1.0, 0.0, 0.0)
mirrored["lyapunov_shape"] = "box"
mirrored["lyapunov_size"] = [0.4, 0.6, 0.2]

# 6) 父层非均匀缩放 + 子体带旋转：不可精确表示的剪切位形（如实记录与让量值的偏差）。
sheared = cube("child_rotated_in_scaled_parent", (0.4, 0.4, 0.8), offset=(0.2, 0.0, 0.4))
sheared.parent = scaled
sheared.location = (-0.6, 0.0, 0.1)
sheared.rotation_euler = (0.0, 0.0, math.radians(35))
sheared["lyapunov_shape"] = "box"
sheared["lyapunov_size"] = [0.4, 0.4, 0.8]

# 7) 过期声明：几何被就地改过，lyapunov_size 还是旧值。
stale = cube("stale_metadata", (0.9, 0.9, 0.9))
stale.parent = root
stale["lyapunov_shape"] = "box"
stale["lyapunov_size"] = [0.3, 0.3, 0.3]

# 8) 修改器：盒子要量评估后几何（Solidify 对称加厚，包围盒比 data 大）。
modified = cube("modified_mesh", (0.5, 0.5, 0.5))
modified.parent = root
solidify = modified.modifiers.new(name="thicken", type="SOLIDIFY")
solidify.thickness = 0.2
solidify.offset = 0.0
modified["lyapunov_shape"] = "box"
modified["lyapunov_size"] = [0.5, 0.5, 0.5]

# 9) 关闭碰撞：过期声明也不该凭空多出碰撞体。
off = cube("collision_off", (0.7, 0.7, 0.7))
off.parent = root
off["lyapunov_shape"] = "box"
off["lyapunov_size"] = [0.2, 0.2, 0.2]
off["lyapunov_collision"] = False

# 10) 没有可测几何：EMPTY 只有声明尺寸（保持既有语义，落在对象原点）。
declared_only = bpy.data.objects.new("declared_only_empty", None)
bpy.context.collection.objects.link(declared_only)
declared_only.parent = root
declared_only.location = (2.5, -2.0, 0.4)
declared_only["lyapunov_shape"] = "box"
declared_only["lyapunov_size"] = [0.3, 0.3, 0.3]

# 11) 动态实体挂在**非单位缩放**的父级下：freejoint 要求它在 worldbody 里独立实例化，提升世界位姿时
#     位置/朝向/缩放都要一起提升（只提升前两者的话，父链缩放会从盒尺寸里丢掉）。
dynamic_child = cube("dynamic_in_scaled_parent", (0.2, 0.2, 0.2))
dynamic_child.parent = scaled
dynamic_child.location = (0.7, -0.3, 1.6)
dynamic_child["lyapunov_shape"] = "box"
dynamic_child["lyapunov_size"] = [0.2, 0.2, 0.2]
dynamic_child["lyapunov_dynamic"] = True

# 12) 承接上面那个动态体的静态台面：真引擎里做真实落体，落点高度随盒尺寸（= 父链缩放）变化。
pad = cube("dynamic_pad", (1.0, 1.0, 0.1), offset=(0.0, 0.0, 0.05))
pad.parent = root
pad.location = (1.4, 2.7, 0.0)
pad["lyapunov_shape"] = "box"
pad["lyapunov_size"] = [1.0, 1.0, 0.1]

# 13) 非单位缩放父级下做 **90° 换轴**旋转（正常人会用的层级变换）：真实体积仍是盒，但换轴要按
#     R_eᵀ·S_p·R_e 算——逐分量乘父级缩放会把两个轴的长短弄反（x/y 互换）。
turned = cube("child_turned_90_in_scaled_parent", (0.4, 0.2, 0.1))
turned.parent = scaled
turned.location = (-0.5, 0.7, 2.4)
turned.rotation_euler = (0.0, 0.0, math.radians(90))
turned["lyapunov_shape"] = "box"
turned["lyapunov_size"] = [0.4, 0.2, 0.1]

# 14) 形态键 + 修改器：导出器**保变形目标、拒绝烘修改器**（应用就丢变形目标，见 bakes_modifiers），
#     所以可视 GLB 里就是数据块本身的几何，碰撞盒必须量同一份——否则盒子里比画面多出一圈修改器效果。
#     另一套顶点只挂在生成键上（值仍为 0），Basis 还是那个立方体：分叉只可能来自修改器。
puffed = cube("shapekey_modified", (0.5, 0.5, 0.5), offset=(0.15, -0.25, 0.35))
puffed.parent = root
puffed.shape_key_add(name="Basis")
puffed.shape_key_add(name="inflate").data[0].co.z += 0.5
puff_thick = puffed.modifiers.new(name="thicken", type="SOLIDIFY")
puff_thick.thickness = 0.4
puff_thick.offset = 0.0
puffed["lyapunov_shape"] = "box"
puffed["lyapunov_size"] = [0.5, 0.5, 0.5]

# ── 现场真值：导出前记下每个对象的局部/世界包围盒与位姿（受测的是 world.py，不是这些读数） ──
bpy.context.view_layer.update()
dependency = bpy.context.evaluated_depsgraph_get()


def bounds(points):
    low = [min(point[axis] for point in points) for axis in range(3)]
    high = [max(point[axis] for point in points) for axis in range(3)]
    return {"min": low, "max": high, "center": [(low[axis] + high[axis]) / 2.0 for axis in range(3)],
            "size": [high[axis] - low[axis] for axis in range(3)]}


report = {}
for obj in bpy.context.scene.objects:
    item = {"type": obj.type, "parent": obj.parent.name if obj.parent else None,
            "location": [round(value, 6) for value in obj.location],
            "scale": [round(value, 6) for value in obj.scale],
            "props": {key: (list(obj[key]) if key in ("lyapunov_size", "lyapunov_axis", "lyapunov_range", "lyapunov_friction") else obj[key])
                      for key in obj.keys() if key.startswith("lyapunov_")},
            "matrixWorld": [list(row) for row in obj.matrix_world]}
    if obj.type == "MESH":
        evaluated = obj.evaluated_get(dependency)
        mesh = evaluated.to_mesh()
        local = [vertex.co.copy() for vertex in mesh.vertices]
        evaluated.to_mesh_clear()
        raw = [vertex.co.copy() for vertex in obj.data.vertices]
        matrix = obj.matrix_world
        item["evaluatedLocalBounds"] = bounds(local)
        item["rawLocalBounds"] = bounds(raw)
        item["worldBounds"] = bounds([matrix @ point for point in local])
        # 局部几何中心在**世界**里的位置（真值）：碰撞盒必须让这个点在世界里落在同一处。
        item["worldCenter"] = list(matrix @ Vector(item["evaluatedLocalBounds"]["center"]))
        item["uvLayers"] = [layer.name for layer in obj.data.uv_layers]
        item["modifiers"] = [modifier.name for modifier in obj.modifiers]
        item["polygons"] = len(obj.data.polygons)
    report[obj.name] = item
Path(r"{facts_path}").write_text(json.dumps(report, ensure_ascii=False, indent=1))
'''

# ── 位姿/包围盒的小工具：全用 xyzw 四元数，与 scene.json 一致 ─────────────────────
def quaternion_multiply(first, second):
    ax, ay, az, aw = first
    bx, by, bz, bw = second
    return [aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz]


def rotate(quaternion, vector):
    qx, qy, qz, qw = quaternion
    ux, uy, uz = qx, qy, qz
    dot = ux * vector[0] + uy * vector[1] + uz * vector[2]
    cross = [uy * vector[2] - uz * vector[1], uz * vector[0] - ux * vector[2], ux * vector[1] - uy * vector[0]]
    return [2.0 * dot * u + (qw * qw - (ux * ux + uy * uy + uz * uz)) * v + 2.0 * qw * c
            for u, v, c in zip((ux, uy, uz), vector, cross)]


def add(first, second):
    return [first[axis] + second[axis] for axis in range(3)]


def scale_of(values, scale):
    return [values[axis] * scale[axis] for axis in range(3)]


def distance(first, second):
    return max(abs(first[axis] - second[axis]) for axis in range(3))


def axis_aligned(quaternion):
    """位姿是否只含 180° 翻转内的轴对齐旋转（这样的盒子世界包围盒就等于世界尺寸）。"""
    return max(abs(quaternion[0]), abs(quaternion[1]), abs(quaternion[2])) < 1e-9


def consumer_poses(snapshot):
    """消费方（sim-mujoco worker.world_poses）的位姿约定，直接从导出件读：

    子体位置按父级**累计**缩放折进、再按父级朝向旋转；缩放沿父链相乘。实体自己的缩放不在本函数里
    应用——它就是载体，碰撞盒的 pos/size 各自再乘这个累计缩放（worker 的 geom 装配）。
    """
    entities = {entity["entityId"]: entity for entity in snapshot["entities"]}
    result = {}

    def resolve(eid):
        if eid in result:
            return result[eid]
        transform = entities[eid]["transform"]
        position = list(transform["position"])
        quaternion = list(transform["quaternion"])
        scale = list(transform["scale"])
        parent = entities[eid].get("parentId")
        if parent in entities:
            parent_position, parent_quaternion, parent_scale = resolve(parent)
            position = add(parent_position, rotate(parent_quaternion, scale_of(position, parent_scale)))
            quaternion = quaternion_multiply(parent_quaternion, quaternion)
            scale = [scale[axis] * parent_scale[axis] for axis in range(3)]
        result[eid] = (position, quaternion, scale)
        return result[eid]

    for eid in entities:
        resolve(eid)
    return result


def box_world_corners(pose, center, size):
    """把局部帧盒子按位姿约定摆到世界，返回 8 个角点。"""
    position, quaternion, scale = pose
    world_center = add(position, rotate(quaternion, scale_of(center, scale)))
    half = [abs(scale[axis]) * size[axis] / 2.0 for axis in range(3)]
    return [add(world_center, rotate(quaternion, [half[0] * sx, half[1] * sy, half[2] * sz]))
            for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]


def box_bounds(corners):
    low = [min(point[axis] for point in corners) for axis in range(3)]
    high = [max(point[axis] for point in corners) for axis in range(3)]
    return {"center": [(low[axis] + high[axis]) / 2.0 for axis in range(3)], "size": [high[axis] - low[axis] for axis in range(3)]}


def xml_boxes(path):
    """physics/world.xml 里每个 geom 的世界位形：按 MJCF 语义（body 只有 pos/quat，没有 scale）逐层合成。"""
    boxes = []

    def walk(body, parent_position, parent_quaternion, parent_body=None):
        position = [float(value) for value in body.get("pos", "0 0 0").split()]
        quat_wxyz = [float(value) for value in body.get("quat", "1 0 0 0").split()]
        quaternion = quat_wxyz[1:] + quat_wxyz[:1]
        world_position = add(parent_position, rotate(parent_quaternion, position))
        world_quaternion = quaternion_multiply(parent_quaternion, quaternion)
        for geom in body.findall("geom"):
            geom_position = [float(value) for value in geom.get("pos", "0 0 0").split()]
            # MJCF 的 box size 是半长；这里换算成整尺寸，与 Blender 的包围盒读数同口径。
            size = [2.0 * float(value) for value in geom.get("size", "0 0 0").split()]
            boxes.append({"body": body.get("name"), "center": add(world_position, rotate(world_quaternion, geom_position)),
                          "size": size, "worldPosition": world_position, "worldQuaternion": world_quaternion,
                          "parentBody": parent_body, "bodyPosition": position, "bodyQuaternion": quaternion})
        for child in body.findall("body"):
            walk(child, world_position, world_quaternion, body.get("name"))

    for body in ElementTree.parse(path).getroot().find("worldbody"):
        walk(body, [0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0])
    return boxes


def sim_python():
    """带 mujoco 的解释器：显式覆盖优先，否则用产品运行根里的 sim-python（与产品解析一致）。"""
    candidates = [os.environ.get("LYAPUNOV_SIM_PYTHON"),
                  str(Path.home() / "WS" / "Lyapunov" / "Dev" / ".runtime" / "sim-python" / "bin" / "python")]
    for candidate in candidates:
        if not candidate or not Path(candidate).is_file():
            continue
        probe = subprocess.run([candidate, "-c", "import mujoco"], capture_output=True, text=True)
        if probe.returncode == 0:
            return candidate
    return None


WORKER_DRIVER = '''"""真引擎读数：physics/world.xml 与 scene.json（经 sim-mujoco worker 编译）两条出口的 geom 世界位形。

scene.json 那条走 worker 的真实编译路径：worker 用**带符号**的累计缩放同时乘 center 与 halfExtents
（`worker.py` 编译 collision 段），所以负缩放链（镜像父级）会得到负尺寸被 MuJoCo 拒收。该行为与本任务
新增的 center 字段无关，因此这里额外用"修前形状"（去掉 center/boxSource/declaredSizeM/evaluatedModifiers）
编译同一场景做对照，把两次结果一并报出来。
"""
import copy, importlib.util, json, os, sys
import mujoco
import numpy as np

world_xml, scene_json, worker_py = sys.argv[1], sys.argv[2], sys.argv[3]
# worker.py 在模块层 `import gait`（同目录兄弟模块）；生产里它是被当脚本从自己目录起的，
# 这里按文件路径导入，得手动补上它所在目录，才算"和真实启动方式同一条路"。
sys.path.insert(0, os.path.dirname(os.path.abspath(worker_py)))
report = {}

model = mujoco.MjModel.from_xml_path(world_xml)
data = mujoco.MjData(model)
mujoco.mj_forward(model, data)
boxes = {}
for geom_id in range(model.ngeom):
    body_id = int(model.geom_bodyid[geom_id])
    boxes[model.body(body_id).name] = {"center": data.geom_xpos[geom_id].tolist(), "size": (model.geom_size[geom_id] * np.array([2.0, 2.0, 2.0])).tolist()}
report["worldXml"] = boxes

# 动态子体（freejoint）在真引擎里**真实落体**：它挂在非单位缩放的父级下，提升世界位姿时父链缩放必须
# 一起提升，否则盒尺寸按"剩下的局部缩放"算，静止高度会差一个可直接量出来的量（本场景 0.05 m）。
DYNAMIC = "dynamic_in_scaled_parent"
PAD = "dynamic_pad"


def geom_of_body(model, label):
    for geom_id in range(model.ngeom):
        if (model.body(int(model.geom_bodyid[geom_id])).name or "") == label:
            return geom_id
    return None


def geom_of_prefix(model, prefix):
    for geom_id in range(model.ngeom):
        if (model.geom(geom_id).name or "").startswith(prefix):
            return geom_id
    return None


pad_geom = geom_of_body(model, PAD)
dynamic_geom = geom_of_body(model, DYNAMIC)
if pad_geom is not None and dynamic_geom is not None:
    pad_top = float(data.geom_xpos[pad_geom][2] + model.geom_size[pad_geom][2])
    for _ in range(1500):
        mujoco.mj_step(model, data)
    report["worldXmlDrop"] = {"padTop": pad_top, "center": data.geom_xpos[dynamic_geom].tolist(),
                              "size": (model.geom_size[dynamic_geom] * np.array([2.0, 2.0, 2.0])).tolist(),
                              "restZ": float(data.geom_xpos[dynamic_geom][2])}


spec = importlib.util.spec_from_file_location("lyapunov_sim_worker", worker_py)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
with open(scene_json) as handle:
    snapshot = json.load(handle)


def compile_scene(scene):
    """跑一遍 worker 的原生编译，返回 {实体id: {center, size}}（世界位形，size 已翻成完整尺寸）。"""
    world = worker.World(scene, {"worldId": "collision-frame-check", "clock": "manual"})
    out = {}
    for entity_id, info in world.entities.items():
        for geom_id in range(world.model.ngeom):
            name = world.model.geom(geom_id).name
            if name.startswith(info["prefix"] + "geom"):
                out[entity_id] = {"center": world.data.geom_xpos[geom_id].tolist(),
                                  "size": (np.asarray(world.model.geom_size[geom_id]) * np.array([2.0, 2.0, 2.0])).tolist()}
    return out


def attempt(scene):
    try:
        return compile_scene(scene), None
    except Exception as exc:
        return None, type(exc).__name__ + ": " + str(exc).replace("\\n", " | ")


def drop_scene(scene):
    """worker 编译出来的世界里跑同一场真实落体（Scene 出口的落点高度）。"""
    world = worker.World(scene, {"worldId": "collision-frame-drop", "clock": "manual"})
    dynamic, pad = world.entities.get(DYNAMIC), world.entities.get(PAD)
    if dynamic is None or pad is None:
        return None
    dynamic_geom = geom_of_prefix(world.model, dynamic["prefix"] + "geom")
    pad_geom = geom_of_prefix(world.model, pad["prefix"] + "geom")
    if dynamic_geom is None or pad_geom is None:
        return None
    pad_top = float(world.data.geom_xpos[pad_geom][2] + world.model.geom_size[pad_geom][2])
    for _ in range(1500):
        mujoco.mj_step(world.model, world.data)
    return {"padTop": pad_top, "center": world.data.geom_xpos[dynamic_geom].tolist(),
            "size": (np.asarray(world.model.geom_size[dynamic_geom]) * np.array([2.0, 2.0, 2.0])).tolist(),
            "restZ": float(world.data.geom_xpos[dynamic_geom][2])}


full, full_error = attempt(snapshot)
report["sceneJson"] = full
report["sceneJsonError"] = full_error

baseline = copy.deepcopy(snapshot)
for entity in baseline["entities"]:
    collision = (entity.get("components") or {}).get("collision")
    if isinstance(collision, dict):
        for key in ("center", "boxSource", "declaredSizeM", "evaluatedModifiers", "unbakedModifiers", "losses"):
            collision.pop(key, None)
baseline_boxes, baseline_error = attempt(baseline)
report["baselineSceneJson"] = baseline_boxes
report["baselineSceneJsonError"] = baseline_error

# 负缩放链：worker 的累计缩放里有负分量，MuJoCo 的 box size 必须为正。用 worker 自己的 world_poses
# 判定（不是在这里另写一套层级数学），把命中的实体连同其后代一起从"可编译子集"里去掉。
negative = sorted(eid for eid, pose in worker.world_poses(snapshot).items() if (np.asarray(pose[2]) < 0).any())
report["negativeScaleEntities"] = negative
dropped = set(negative)
parent = {entity["entityId"]: entity.get("parentId") for entity in snapshot["entities"]}
grew = True
while grew:
    grew = False
    for entity_id, parent_id in parent.items():
        if parent_id in dropped and entity_id not in dropped:
            dropped.add(entity_id)
            grew = True
report["negativeScaleSubtree"] = sorted(dropped)
reduced = copy.deepcopy(snapshot)
reduced["entities"] = [entity for entity in reduced["entities"] if entity["entityId"] not in dropped]
report["sceneJsonReduced"], report["sceneJsonReducedError"] = attempt(reduced) if dropped else (full, full_error)
for label, scene in (("sceneJsonDrop", snapshot), ("sceneJsonReducedDrop", reduced)):
    try:
        report[label] = drop_scene(scene)
    except Exception as exc:
        report[label] = {"error": type(exc).__name__ + ": " + str(exc).replace("\\n", " | ")}
print("ENGINE_RESULT=" + json.dumps(report))
'''


# ── 碰撞盒台账：每条检查都打印真实读数 ────────────────────────────────────────────
# 可被盒合同精确表示的位形（父级缩放均匀、子体不旋转、或只换轴）：盒子世界包围盒应与几何世界包围盒一致。
REPRESENTABLE = ("centered_box", "baked_slab", "rotated_offset", "child_in_scaled_parent",
                 "child_in_mirror_parent", "stale_metadata", "modified_mesh",
                 "dynamic_in_scaled_parent", "dynamic_pad")
# world.xml 出口能精确表示、但 scene.json 的盒合同表示不了（非等比父级缩放 × 90° 换轴）的位形：
# 真引擎核心里它们的**中心**同样必须落在 Blender 真值上（尺寸由 loss/包络那条检查单独收口）。
ENGINE_EXACT = REPRESENTABLE + ("child_turned_90_in_scaled_parent",)


def check_scene_json(checks: Checks, facts: dict, snapshot: dict) -> dict:
    entities = entity_map(snapshot)
    ids = {entity["name"]: entity["entityId"] for entity in snapshot["entities"]}
    collision = {name: entities[eid]["components"].get("collision") for name, eid in ids.items()}
    poses = consumer_poses(snapshot)

    centered = collision.get("centered_box") or {}
    checks.check("普通 primitive_box（原点在几何中心）原行为保留：center 仍是原点、尺寸仍等于声明尺寸",
                 centered.get("center") == [0.0, 0.0, 0.0] and centered.get("sizeM") == [0.6, 0.4, 0.2]
                 and centered.get("halfExtents") == [0.3, 0.2, 0.1] and centered.get("boxSource") == "geometry-local-bounds",
                 json.dumps(centered, ensure_ascii=False))

    baked = collision.get("baked_slab") or {}
    baked_truth = facts["baked_slab"]["evaluatedLocalBounds"]
    checks.check("几何烘焙进顶点（原点不在几何中心）：center 是局部几何中心，不是原点也不是世界中心",
                 distance(baked.get("center", [0, 0, 0]), baked_truth["center"]) < 1e-5
                 and distance(baked.get("center", [0, 0, 0]), [0, 0, 0]) > 0.5
                 and baked.get("sizeM") == [round(value, 6) for value in baked_truth["size"]],
                 f"导出 center={baked.get('center')} sizeM={baked.get('sizeM')} 现场局部中心={[round(v, 6) for v in baked_truth['center']]}")

    rotated = collision.get("rotated_offset") or {}
    rotated_truth = facts["rotated_offset"]
    rotated_world = add(poses[ids["rotated_offset"]][0], rotate(poses[ids["rotated_offset"]][1], scale_of(rotated.get("center", [0, 0, 0]), poses[ids["rotated_offset"]][2])))
    checks.check("旋转位姿：写的是**局部**中心（世界中心另算），按消费方约定还原后与 Blender 世界中心一致",
                 distance(rotated.get("center", [0, 0, 0]), rotated_truth["evaluatedLocalBounds"]["center"]) < 1e-5
                 and distance(rotated.get("center", [0, 0, 0]), rotated_truth["worldCenter"]) > 0.1
                 and distance(rotated_world, rotated_truth["worldCenter"]) < 1e-5,
                 f"局部中心={rotated.get('center')} 世界中心真值={[round(v, 6) for v in rotated_truth['worldCenter']]} 还原={[round(v, 6) for v in rotated_world]}")

    # 父层非均匀缩放 / 镜像缩放：世界包围盒（真值来自 Blender 顶点世界坐标）逐一核对。
    for name, label in (("child_in_scaled_parent", "父层非均匀缩放"), ("child_in_mirror_parent", "父层镜像（负）缩放")):
        box = collision.get(name) or {}
        corners = box_world_corners(poses[ids[name]], box.get("center", [0, 0, 0]), box.get("sizeM", [0, 0, 0]))
        placed = box_bounds(corners)
        truth = facts[name]
        checks.check(f"{label}：按消费方约定还原的盒子世界包围盒与 Blender 几何世界包围盒一致",
                     distance(placed["center"], truth["worldBounds"]["center"]) < 1e-5
                     and distance(placed["size"], truth["worldBounds"]["size"]) < 1e-5,
                     f"盒子世界={ {key: [round(v, 6) for v in value] for key, value in placed.items()} } 几何世界={ {key: [round(v, 6) for v in value] for key, value in truth['worldBounds'].items()} }")
        checks.check(f"{label}：尺寸为正（镜像的负号由位姿承担，不写进尺寸）",
                     all(value > 0 for value in box.get("sizeM", [])), f"sizeM={box.get('sizeM')} 局部几何尺寸={[round(v, 6) for v in truth['evaluatedLocalBounds']['size']]}")

    sheared = collision.get("child_rotated_in_scaled_parent") or {}
    sheared_pose = poses[ids["child_rotated_in_scaled_parent"]]
    sheared_world = add(sheared_pose[0], rotate(sheared_pose[1], scale_of(sheared.get("center", [0, 0, 0]), sheared_pose[2])))
    sheared_truth = facts["child_rotated_in_scaled_parent"]["worldCenter"]
    checks.check("父层非均匀缩放 + 子体旋转：center 仍是该帧的局部几何中心（世界位置按消费方约定不是真值，见下一条 loss）",
                 distance(sheared.get("center", [0, 0, 0]), facts["child_rotated_in_scaled_parent"]["evaluatedLocalBounds"]["center"]) < 1e-5,
                 f"局部中心={sheared.get('center')} 还原世界={[round(v, 6) for v in sheared_world]} Blender 世界中心={[round(v, 6) for v in sheared_truth]} 中心偏差={round(distance(sheared_world, sheared_truth), 6)} m")

    stale = collision.get("stale_metadata") or {}
    checks.check("lyapunov_size 过期：以评估后局部几何为准，并把过期声明记进 declaredSizeM",
                 stale.get("sizeM") == [0.9, 0.9, 0.9] and stale.get("declaredSizeM") == [0.3, 0.3, 0.3]
                 and stale.get("center") == [0.0, 0.0, 0.0],
                 json.dumps(stale, ensure_ascii=False))

    modified = collision.get("modified_mesh") or {}
    raw_size = facts["modified_mesh"]["rawLocalBounds"]["size"]
    evaluated_size = facts["modified_mesh"]["evaluatedLocalBounds"]["size"]
    checks.check("修改器：盒子量的是评估后几何（等于 Blender 现场评估包围盒、且不等于原始 data），并记录 evaluatedModifiers",
                 modified.get("evaluatedModifiers") == ["thicken"]
                 and modified.get("boxSource") == "geometry-local-bounds"
                 and distance(modified.get("sizeM") or [0.0] * 3, evaluated_size) < 1e-6
                 and distance(modified.get("sizeM") or [0.0] * 3, raw_size) > 1e-3,
                 f"导出 sizeM={modified.get('sizeM')} Blender 评估包围盒={evaluated_size} 原始 data 尺寸={[round(v, 6) for v in raw_size]} evaluatedModifiers={modified.get('evaluatedModifiers')}")

    # 形态键 + 修改器：导出器拒绝给带形态键的网格应用修改器（应用就丢变形目标），GLB 里是数据块本身的几何，
    # 碰撞盒必须量同一份——量评估后几何就会**比画面大一圈**（这里 Solidify 0.4 让 0.5 变 0.9）。
    puffed = collision.get("shapekey_modified") or {}
    puffed_facts = facts["shapekey_modified"]
    puffed_raw = puffed_facts["rawLocalBounds"]
    puffed_evaluated = puffed_facts["evaluatedLocalBounds"]
    checks.check("形态键 + 修改器：碰撞盒量的是**导出器真正写出去的那份**几何（数据块、不带修改器），与可视 GLB 同源",
                 puffed.get("boxSource") == "geometry-local-bounds"
                 and distance(puffed.get("sizeM") or [0.0] * 3, puffed_raw["size"]) < 1e-6
                 and distance(puffed.get("center") or [0.0] * 3, puffed_raw["center"]) < 1e-6
                 and distance(puffed.get("sizeM") or [0.0] * 3, puffed_evaluated["size"]) > 1e-3,
                 f"导出 center={puffed.get('center')} sizeM={puffed.get('sizeM')}；原始 data center={[round(v, 6) for v in puffed_raw['center']]} "
                 f"size={[round(v, 6) for v in puffed_raw['size']]}；评估后（含 Solidify）size={[round(v, 6) for v in puffed_evaluated['size']]} "
                 f"（形态键的另一套顶点值为 0，不参与形变）")
    puffed_loss = (puffed.get("losses") or [{}])[0]
    checks.check("形态键 + 修改器：没被表示的修改器不静默丢——unbakedModifiers 点名 + 结构化 loss 一起进产品结果",
                 puffed.get("unbakedModifiers") == ["thicken"] and "evaluatedModifiers" not in puffed
                 and puffed_loss.get("code") == "COLLISION_MODIFIERS_UNBAKED" and "形态键" in str(puffed_loss.get("detail", ""))
                 and "thicken" in str(puffed_loss.get("detail", "")) and bool(puffed_loss.get("followUp")),
                 json.dumps({key: puffed.get(key) for key in ("unbakedModifiers", "evaluatedModifiers", "boxSource", "losses")}, ensure_ascii=False))

    checks.check("关闭碰撞的对象不多出碰撞体；没有声明的父级/空物体也照旧没有",
                 "collision" not in (entities[ids["collision_off"]]["components"])
                 and all("collision" not in entities[ids[name]]["components"] for name in ("frame_root", "scaled_parent", "mirror_parent")),
                 f"collision_off 组件={sorted(entities[ids['collision_off']]['components'])}")

    declared = collision.get("declared_only_empty") or {}
    checks.check("没有可测几何（EMPTY）：按声明尺寸落在对象原点，并标明来源是声明值",
                 declared.get("boxSource") == "declared-lyapunov_size" and declared.get("center") == [0.0, 0.0, 0.0]
                 and declared.get("sizeM") == [0.3, 0.3, 0.3], json.dumps(declared, ensure_ascii=False))

    # ── 表示不了的位形必须在产品结果里被标出来（不是只写在测试文字里） ──────────────
    losses = sheared.get("losses") or []
    first = losses[0] if losses else {}
    checks.check("剪切位形：scene.json 的碰撞组件带结构化 loss（含两条出口的实测偏差与后续接口），不冒充精确盒",
                 bool(losses) and first.get("code") == "COLLISION_BOX_APPROXIMATE_FRAME"
                 and first.get("engineDeviationM", 0) > 0.01 and first.get("sceneDeviationM", 0) > 0.01
                 and "body 帧盒" in str(first.get("followUp", "")) and "NEEDS_ROOT.md" in str(first.get("followUp", "")),
                 json.dumps(first, ensure_ascii=False))
    # 非等比父级缩放 × 90° 换轴：这是正常人会建的层级（把拉伸父级下的子体转个直角），真实体积仍是直立盒，
    # 但**换轴**必须按 R_eᵀ·S_p·R_e 算——逐分量乘父级缩放会把两个轴的长短弄反。
    turned = collision.get("child_turned_90_in_scaled_parent") or {}
    turned_losses = turned.get("losses") or []
    turned_first = turned_losses[0] if turned_losses else {}
    turned_pose = poses[ids["child_turned_90_in_scaled_parent"]]
    turned_placed = box_bounds(box_world_corners(turned_pose, turned.get("center", [0, 0, 0]), turned.get("sizeM", [0, 0, 0])))
    turned_truth = facts["child_turned_90_in_scaled_parent"]
    checks.check("非等比父级缩放 × 90° 换轴：world.xml 出口精确（loss 里 engineDeviationM ≈ 0），"
                 "但 scene.json 的盒合同表达不了换轴——两个轴的长短会反过来，该出口偏差必须>0.1 m 且被 loss 如实记录",
                 turned.get("center") == [0.0, 0.0, 0.0]
                 and turned_first.get("code") == "COLLISION_BOX_APPROXIMATE_FRAME"
                 and turned_first.get("engineDeviationM", 9.0) < 1e-5
                 and turned_first.get("sceneDeviationM", 0.0) > 0.1
                 # 换轴是**能精确表达**的位形：回执里不能说成"斜平行六面体"，要说清是 Scene 侧缺换轴能力。
                 # （判定按输入精度给容差：Blender 的单精度四元数会让 90° 转出 ~3e-8 的假非对角项。）
                 and "精确换算" in str(turned_first.get("detail", ""))
                 and distance(turned_placed["size"], turned_truth["worldBounds"]["size"]) > 0.1,
                 f"loss={json.dumps(turned_first, ensure_ascii=False)}；Scene 约定还原的世界尺寸={[round(v, 6) for v in turned_placed['size']]} "
                 f"Blender 几何世界尺寸={[round(v, 6) for v in turned_truth['worldBounds']['size']]} 局部 sizeM={turned.get('sizeM')}")

    flagged = sorted(name for name, component in collision.items() if component and component.get("losses"))
    codes = {name: [loss.get("code") for loss in (component or {}).get("losses") or []]
             for name, component in collision.items() if component and component.get("losses")}
    checks.check("带 loss 的只有两类：盒合同表示不了的位形（COLLISION_BOX_APPROXIMATE_FRAME）与形态键对象没烘的修改器"
                 "（COLLISION_MODIFIERS_UNBAKED）；其余碰撞盒（含动态子体、镜像、普通修改器）都没有 loss 字段",
                 flagged == ["child_rotated_in_scaled_parent", "child_turned_90_in_scaled_parent", "shapekey_modified"]
                 and codes["shapekey_modified"] == ["COLLISION_MODIFIERS_UNBAKED"]
                 and all(codes[name] == ["COLLISION_BOX_APPROXIMATE_FRAME"]
                         for name in ("child_rotated_in_scaled_parent", "child_turned_90_in_scaled_parent")),
                 f"带 loss 的实体={flagged} 各自 code={codes}（共 {sum(1 for c in collision.values() if c)} 个碰撞盒）")
    return collision


def check_world_xml(checks: Checks, facts: dict, snapshot: dict, output: Path) -> dict:
    ids = {entity["name"]: entity["entityId"] for entity in snapshot["entities"]}
    entities = entity_map(snapshot)
    poses = consumer_poses(snapshot)
    collision_entities = {eid: entity for eid, entity in entities.items() if "collision" in entity["components"]}
    boxes = xml_boxes(output / "physics" / "world.xml")
    by_body = {box["body"]: box for box in boxes}
    checks.check("world.xml 为每个声明碰撞的实体给出一个 geom（关闭碰撞的不写）",
                 len(boxes) == len(collision_entities) and ids["collision_off"] not in by_body,
                 f"geom={len(boxes)} 声明碰撞实体={len(collision_entities)} 关闭者是否出现={ids['collision_off'] in by_body}")

    # 两条出口对**可精确表示的位形**必须给出同一世界位置；表示不了的位形由 loss 收口（下一条检查）。
    worst, compared_exits = 0.0, 0
    for name, eid in ids.items():
        if eid not in collision_entities or eid not in by_body:
            continue
        component = entities[eid]["components"]["collision"]
        if component.get("losses"):
            continue
        expected = add(poses[eid][0], rotate(poses[eid][1], scale_of(component["center"], poses[eid][2])))
        worst = max(worst, distance(by_body[eid]["center"], expected))
        compared_exits += 1
    checks.check("可精确表示的位形：world.xml 的 body/geom 合成与 scene.json 的消费方约定给出同一世界位置（两条出口一致）",
                 compared_exits >= 8 and worst < 1e-6, f"对比 {compared_exits} 个 geom，最大偏差={worst:.3e} m（world.xml 共 {len(boxes)} 个 geom）")

    # 表示不了的位形：MJCF 出口给的是该体积在 body 帧里的真实 AABB（保守包络）。真值角点转到 body 帧后
    # 与同一个中心比逐轴半长——同一帧里两个同心盒的包含关系就是这个比较（≥ 才叫保守）。
    envelope = []
    for name, eid in ids.items():
        component = entities.get(eid, {}).get("components", {}).get("collision") or {}
        box = by_body.get(eid)
        # 只看"盒合同表示不了"这一类：形态键对象的 loss 说的是修改器没烘，不涉及包络。
        if box is None or not any(loss.get("code") == "COLLISION_BOX_APPROXIMATE_FRAME" for loss in component.get("losses") or []):
            continue
        matrix = facts[name]["matrixWorld"]
        half = [value / 2.0 for value in component["sizeM"]]
        local = [[component["center"][axis] + sign[axis] * half[axis] for axis in range(3)]
                 for sign in [(sx, sy, sz) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]]
        world = [[sum(matrix[row][column] * point[column] for column in range(3)) + matrix[row][3] for row in range(3)] for point in local]
        center = [sum(matrix[row][column] * component["center"][column] for column in range(3)) + matrix[row][3] for row in range(3)]
        quaternion = box["worldQuaternion"]
        inverse = [-quaternion[0], -quaternion[1], -quaternion[2], quaternion[3]]
        body = [rotate(inverse, [point[axis] - center[axis] for axis in range(3)]) for point in world]
        excess = max(abs(point[axis]) - box["size"][axis] / 2.0 for point in body for axis in range(3))
        reported = next((loss.get("engineDeviationM") for loss in component["losses"]
                         if loss.get("code") == "COLLISION_BOX_APPROXIMATE_FRAME"), None)
        envelope.append({"name": name, "containsTruth": excess <= 1e-5, "excessM": round(excess, 6), "reported": reported,
                         "bodyHalf": [round(value, 6) for value in [box["size"][axis] / 2.0 for axis in range(3)]],
                         "truthMaxAbs": [round(max(abs(point[axis]) for point in body), 6) for axis in range(3)]})
    checks.check("带 loss 的位形：world.xml 的盒子在 body 帧里包住真实体积（含 6 位小数舍入容差），且 loss 里的 engineDeviationM 有读数",
                 len(envelope) == 2 and all(item["containsTruth"] and item["reported"] is not None for item in envelope),
                 json.dumps(envelope, ensure_ascii=False))

    mismatched = []
    compared = 0
    for name in REPRESENTABLE:
        eid = ids[name]
        box = by_body.get(eid)
        if box is None:
            mismatched.append((name, "world.xml 缺 geom"))
            continue
        # 只有 body 帧轴对齐（这些位形的子体都不旋转）时，世界盒子才是轴对齐的，才能直接比包围盒；
        # 转过向的实体由上面的中心核对覆盖，尺寸另按累计缩放比。
        if not axis_aligned(poses[eid][1]):
            continue
        compared += 1
        if distance(box["size"], facts[name]["worldBounds"]["size"]) > 1e-5:
            mismatched.append((name, f"世界尺寸 {box['size']} ≠ 真值 {facts[name]['worldBounds']['size']}"))
    checks.check("world.xml 里轴对齐位形的世界尺寸与 Blender 几何世界尺寸一致（含缩放层级）",
                 not mismatched and compared >= 4, f"对比了 {compared} 个实体，不一致={mismatched}")
    return {"boxes": boxes, "collisionEntities": len(collision_entities)}


def check_dynamic(checks: Checks, facts: dict, snapshot: dict, output: Path, payload: dict | None):
    """动态实体挂在非单位缩放父级下：freejoint 要独立实例化，世界位姿的**位置/朝向/缩放**都得提升。

    只提升位置与朝向的话，两条出口的盒尺寸都会按"剩下的局部缩放"算（这里是 1，而不是父链的 0.5），
    落点高度直接差 0.05 m——所以这里既核 Scene/GLB 出口的 transform，也在真引擎里做真实落体。
    """
    ids = {entity["name"]: entity["entityId"] for entity in snapshot["entities"]}
    eid = ids["dynamic_in_scaled_parent"]
    entity = entity_map(snapshot)[eid]
    transform = entity["transform"]
    matrix = facts["dynamic_in_scaled_parent"]["matrixWorld"]
    world_position = [matrix[axis][3] for axis in range(3)]
    world_scale = [math.sqrt(sum(matrix[row][axis] ** 2 for row in range(3))) for axis in range(3)]
    checks.check("Scene/GLB 出口：动态实体提升为世界位姿（无 parentId），位置与**父链缩放**都写成了世界值（不是剩下的局部缩放）",
                 "parentId" not in entity
                 and distance(transform["position"], world_position) < 1e-5
                 and distance(transform["scale"], world_scale) < 1e-5
                 and distance(transform["scale"], [1.0, 1.0, 1.0]) > 0.1,
                 f"scene.json transform={ {key: [round(v, 6) for v in transform[key]] for key in ('position', 'scale')} } "
                 f"parentId={entity.get('parentId')}；Blender 世界位姿 position={[round(v, 6) for v in world_position]} scale={[round(v, 6) for v in world_scale]}")

    by_body = {box["body"]: box for box in xml_boxes(output / "physics" / "world.xml")}
    dynamic_box = by_body.get(eid) or {}
    pad_box = by_body.get(ids["dynamic_pad"]) or {}
    half_z = facts["dynamic_in_scaled_parent"]["worldBounds"]["size"][2] / 2.0
    checks.check("world.xml：动态 body 是 worldbody 直属，盒子中心/尺寸等于 Blender 真值（缩放只算了一次）",
                 dynamic_box.get("parentBody") is None
                 and distance(dynamic_box.get("center", [9, 9, 9]), facts["dynamic_in_scaled_parent"]["worldCenter"]) < 1e-5
                 and distance(dynamic_box.get("size", [9, 9, 9]), facts["dynamic_in_scaled_parent"]["worldBounds"]["size"]) < 1e-5,
                 f"parentBody={dynamic_box.get('parentBody')} geom center={[round(v, 6) for v in dynamic_box.get('center', [])]} "
                 f"size={[round(v, 6) for v in dynamic_box.get('size', [])]}；真值 center={[round(v, 6) for v in facts['dynamic_in_scaled_parent']['worldCenter']]} "
                 f"size={[round(v, 6) for v in facts['dynamic_in_scaled_parent']['worldBounds']['size']]}")

    if payload is None:
        print("NOTICE: 没有真引擎读数（未找到带 mujoco 的解释器），动态落体那两条检查跳过。", flush=True)
        return
    for key, label in (("worldXmlDrop", "world.xml"), ("sceneJsonDrop", "Scene（worker 编译）")):
        drop = payload.get(key) or {}
        if drop.get("error") or not drop:
            drop = payload.get("sceneJsonReducedDrop") or drop
            label = label + "（负缩放子树被 worker 拒收，按去掉该子树的子集跑）"
        pad_top = drop.get("padTop")
        rest = drop.get("restZ")
        unpromoted = None if pad_top is None else pad_top + (entity["components"]["collision"]["halfExtents"][2])
        checks.check(f"真引擎落体（{label}）：动态子体停在台面上，高度 = 台面顶 + 世界半高（提升后），而不是局部半高",
                     pad_top is not None and rest is not None and abs(rest - (pad_top + half_z)) < 1e-3
                     and abs(rest - unpromoted) > 0.03,
                     f"台面顶={pad_top} 静止中心 z={rest}（期望 {round(pad_top + half_z, 6)}；若丢了父链缩放会是 {round(unpromoted, 6)}）"
                     f" 盒世界尺寸={[round(v, 6) for v in drop.get('size', [])]}（真值 {[round(v, 6) for v in facts['dynamic_in_scaled_parent']['worldBounds']['size']]}）")


def check_isaac_manifest(checks: Checks, snapshot: dict, output: Path):
    """Isaac 回执（isaac/import.json 的碰撞清单）也要带 loss，别让下游把近似盒当精确盒。"""
    path = output / "isaac" / "import.json"
    if not path.is_file():
        checks.check("isaac/import.json 碰撞清单", False, f"缺少 {path}")
        return
    manifest = json.loads(path.read_text())
    rows = {row["entityId"]: row for row in manifest["collisionEntities"]}
    ids = {entity["name"]: entity["entityId"] for entity in snapshot["entities"]}
    flagged = sorted(name for name, eid in ids.items() if (rows.get(eid) or {}).get("losses"))
    codes = {name: [loss.get("code") for loss in (rows.get(ids[name]) or {}).get("losses") or []] for name in ids}
    checks.check("isaac/import.json 的碰撞清单按实体带 losses（空列表=该盒与几何一致；形态键对象没烘的修改器同样如实标出）",
                 flagged == ["child_rotated_in_scaled_parent", "child_turned_90_in_scaled_parent", "shapekey_modified"]
                 and codes["shapekey_modified"] == ["COLLISION_MODIFIERS_UNBAKED"]
                 and all("losses" in row for row in manifest["collisionEntities"]),
                 f"带 loss 的实体={flagged}；清单共 {len(manifest['collisionEntities'])} 条，"
                 f"其中 {sum(1 for row in manifest['collisionEntities'] if row['losses'])} 条标了近似，status={manifest.get('status')}")


SOURCE_PROBE = '''
report = {}
for obj in bpy.context.scene.objects:
    item = {"type": obj.type, "parent": obj.parent.name if obj.parent else None,
            "props": {key: (list(obj[key]) if key in ("lyapunov_size",) else obj[key]) for key in obj.keys() if key.startswith("lyapunov_")}}
    if obj.type == "MESH":
        item["uvLayers"] = [layer.name for layer in obj.data.uv_layers]
        item["polygons"] = len(obj.data.polygons)
        item["modifiers"] = [modifier.name for modifier in obj.modifiers]
        coords = [vertex.co for vertex in obj.data.vertices]
        item["rawBoundsSize"] = [round(max(point[axis] for point in coords) - min(point[axis] for point in coords), 6) for axis in range(3)]
    report[obj.name] = item
print("PROBE_RESULT=" + json.dumps(report))
'''


def check_source_project(checks: Checks, facts: dict, output: Path):
    after = inspect_blend(output / "source.blend", SOURCE_PROBE)
    baked = after.get("baked_slab", {})
    stale = after.get("stale_metadata", {})
    modified = after.get("modified_mesh", {})
    checks.check("源工程里的几何/UV/修改器没被这次导出改掉（UV 层仍在、修改器仍可编辑、原始顶点没被就地烘焙）",
                 baked.get("uvLayers") == ["UVMap"] and baked.get("polygons") == facts["baked_slab"]["polygons"]
                 and modified.get("modifiers") == ["thicken"]
                 and max(abs(value - 0.5) for value in modified.get("rawBoundsSize", [0, 0, 0])) < 1e-6,
                 f"baked_slab UV={baked.get('uvLayers')} polygons={baked.get('polygons')} modified_mesh 修改器={modified.get('modifiers')} 原始几何尺寸={modified.get('rawBoundsSize')}")
    checks.check("源工程里 lyapunov_size 的旧声明保持原样（修的是导出读数，不是替用户改工程）",
                 stale.get("props", {}).get("lyapunov_size") == [0.3, 0.3, 0.3]
                 and stale.get("props", {}).get("lyapunov_shape") == "box",
                 json.dumps(stale.get("props", {}), ensure_ascii=False))


def check_result_row(checks: Checks, run, snapshot: dict):
    """导出结果行（LYAPUNOV_RESULT）也要带读数：近似盒不能只在实体组件里说，跑完导出的人得一眼看到。"""
    result = run.result or {}
    rows = result.get("collisionApproximations")
    if not isinstance(rows, list):
        checks.check("导出结果行带 collisionApproximations（近似盒清单）", False,
                     f"result keys={sorted(result)}")
        return
    ids = {entity["name"]: entity["entityId"] for entity in snapshot["entities"]}
    by_name = {row.get("name"): row for row in rows}
    checks.check("导出结果行带 collisionApproximations：两条出口各记了实测偏差，并标出该位形在 world.xml 出口是否精确",
                 sorted(by_name) == ["child_rotated_in_scaled_parent", "child_turned_90_in_scaled_parent"]
                 and by_name["child_rotated_in_scaled_parent"].get("exact") is False
                 and by_name["child_turned_90_in_scaled_parent"].get("exact") is True
                 and all(by_name[name].get("engineDeviationM") is not None and by_name[name].get("sceneDeviationM", 0) > 0.1
                         and by_name[name].get("entityId") == ids[name] for name in by_name),
                 json.dumps(rows, ensure_ascii=False))
    # 形态键对象不烘修改器：盒与可视 GLB 同源，但"少了修改器效果"必须让跑完导出的人一眼看到（不是只写在实体组件里）。
    unbaked = result.get("collisionUnbakedModifiers")
    by_unbaked = {row.get("name"): row for row in unbaked or []} if isinstance(unbaked, list) else {}
    checks.check("导出结果行带 collisionUnbakedModifiers：形态键对象没被烘进几何的修改器在结果里点名",
                 isinstance(unbaked, list) and sorted(by_unbaked) == ["shapekey_modified"]
                 and by_unbaked.get("shapekey_modified", {}).get("unbakedModifiers") == ["thicken"]
                 and by_unbaked.get("shapekey_modified", {}).get("entityId") == ids["shapekey_modified"],
                 json.dumps(unbaked, ensure_ascii=False))


def check_engine(checks: Checks, facts: dict, snapshot: dict, output: Path):
    interpreter = sim_python()
    if interpreter is None:
        print("NOTICE: 没有找到带 mujoco 的解释器（LYAPUNOV_SIM_PYTHON），本次跳过真引擎复核；"
              "world.xml/scene.json 的帧核对仍在上面按约定完成。", flush=True)
        return
    driver = write_script("collision-frame-engine.py", WORKER_DRIVER)
    worker_py = Path(__file__).resolve().parent.parent.parent / "sim-mujoco" / "python" / "worker.py"
    run = subprocess.run([interpreter, str(driver), str(output / "physics" / "world.xml"), str(output / "scene.json"), str(worker_py)],
                         capture_output=True, text=True, timeout=900)
    if run.returncode != 0:
        checks.check("真引擎（MuJoCo）编译两条出口", False, f"exit={run.returncode} tail={run.stderr[-300:]}")
        return None
    payload = None
    for line in reversed(run.stdout.split("\n")):
        if line.startswith("ENGINE_RESULT="):
            payload = json.loads(line[len("ENGINE_RESULT="):])
            break
    if payload is None:
        checks.check("真引擎（MuJoCo）编译两条出口", False, f"没有 ENGINE_RESULT 行：{run.stdout[-200:]}{run.stderr[-200:]}")
        return None

    ids = {entity["name"]: entity["entityId"] for entity in snapshot["entities"]}
    poses = consumer_poses(snapshot)

    xml_centers, xml_sizes = [], []
    for name in ENGINE_EXACT:
        eid = ids[name]
        box = payload["worldXml"].get(eid)
        if box is None:
            continue
        xml_centers.append(distance(box["center"], facts[name]["worldCenter"]))
        # 带 loss 的位形不参与尺寸核对：world.xml 给的是包络（或换轴后的盒），尺寸由上面的 body 帧检查收口。
        if axis_aligned(poses[eid][1]) and not entity_map(snapshot)[eid]["components"].get("collision", {}).get("losses"):
            xml_sizes.append(distance(box["size"], facts[name]["worldBounds"]["size"]))
    checks.check("真引擎（MuJoCo）读 physics/world.xml：每个碰撞盒中心都落在 Blender 真值上（含镜像父级）",
                 len(xml_centers) >= 7 and max(xml_centers) < 1e-5,
                 f"对比了 {len(xml_centers)} 个实体，最大偏差={max(xml_centers) if xml_centers else float('nan'):.3e} m（world.xml 共 {len(payload['worldXml'])} 个 geom）")
    checks.check("真引擎里轴对齐实体的 world.xml 盒尺寸等于 Blender 几何世界尺寸（缩放只算了一次；镜像取绝对值）",
                 len(xml_sizes) >= 5 and max(xml_sizes) < 1e-5,
                 f"对比了 {len(xml_sizes)} 个实体，最大偏差={max(xml_sizes) if xml_sizes else float('nan'):.3e} m")

    # scene.json 走 worker 的原生编译：负缩放链（镜像父级）会被 worker 的带符号缩放乘成负尺寸而被 MuJoCo 拒收
    # （worker.py 编译 collision 段的既有行为；本任务禁止改 worker），因此这部分用"去掉负缩放链子树"的子集，
    # 并另外用修前形状做对照，证明该拒收与新增的 center 字段无关。
    error = payload["sceneJsonError"]
    reduced = payload["sceneJsonReduced"]
    if error:
        print("NOTICE: worker 编译完整 scene.json 被拒：%s；"
              "负缩放链实体=%s（worker 用带符号累计缩放乘 halfExtents，MuJoCo 要求 box size 为正）。"
              "这是 worker.py 的既有行为、本任务范围外，已记 NEEDS_ROOT.md；下面按去掉该子树后的子集核对位形。"
              % (error, payload["negativeScaleSubtree"]), flush=True)
    scene_centers, scene_sizes, unscanned = [], [], []
    for name in ENGINE_EXACT:
        eid = ids[name]
        box = (reduced or {}).get(eid)
        if box is None:
            if eid not in payload["negativeScaleSubtree"]:
                unscanned.append(name)   # 只允许负缩放子树缺席，其余缺席即失败
            continue
        scene_centers.append(distance(box["center"], facts[name]["worldCenter"]))
        if axis_aligned(poses[eid][1]) and not entity_map(snapshot)[eid]["components"].get("collision", {}).get("losses"):
            scene_sizes.append(distance(box["size"], facts[name]["worldBounds"]["size"]))
    checks.check("真引擎按原生 Scene（sim-mujoco worker）编译 scene.json：geom 中心同样落在 Blender 真值上（除 worker 拒收的负缩放子树外一个不少）",
                 len(scene_centers) >= 5 and not unscanned and max(scene_centers) < 1e-5,
                 f"对比了 {len(scene_centers)} 个实体，最大偏差={max(scene_centers) if scene_centers else float('nan'):.3e} m；"
                 f"缺席={unscanned}；worker 拒收的={payload['negativeScaleSubtree']}（{error}）")
    checks.check("真引擎里轴对齐实体的 scene.json 盒尺寸等于 Blender 几何世界尺寸",
                 len(scene_sizes) >= 4 and max(scene_sizes) < 1e-5,
                 f"对比了 {len(scene_sizes)} 个实体，最大偏差={max(scene_sizes) if scene_sizes else float('nan'):.3e} m")
    checks.check("worker 对修前形状的同一场景（去掉 center/boxSource/declaredSizeM/evaluatedModifiers）给出同一结果——镜像被拒不是新增字段引入的",
                 (payload["baselineSceneJsonError"] or "") == (error or ""),
                 f"修后 scene.json → {error or '编译成功'}；修前形状 → {payload['baselineSceneJsonError'] or '编译成功'}")
    return payload


def main() -> int:
    checks = Checks("ENV-36 碰撞盒帧对齐（真实 Blender）")
    if blender_executable() is None:
        return checks.blocked_on("找不到 Blender 可执行文件（BLENDER_EXECUTABLE）")
    output = fresh_dir("collision-frame")
    facts_path = output / "scene-facts.json"
    # 模板里有字典字面量，用字符串替换而不是 str.format（花括号不是占位符）。
    scene_script = write_script(f"collision-frame-scene-{output.name}.py", SCENE_TEMPLATE.replace("{facts_path}", str(facts_path)))
    run = run_world(["--operation", "export", "--output", str(output)], scene_script=scene_script)
    checks.check("真实 Blender 干净退出（exit 0 且无异常堆栈）",
                 run.clean, f"cmd={' '.join(shlex.quote(item) for item in run.argv)} exit={run.code} tail={run.tail()}")
    if not facts_path.is_file() or not (output / "scene.json").is_file():
        checks.check("导出产物齐备", False, f"facts={facts_path.is_file()} scene={ (output / 'scene.json').is_file() } tail={run.tail()}")
        return checks.finish()
    facts = json.loads(facts_path.read_text())
    snapshot = json.loads((output / "scene.json").read_text())
    check_result_row(checks, run, snapshot)
    check_scene_json(checks, facts, snapshot)
    check_world_xml(checks, facts, snapshot, output)
    check_isaac_manifest(checks, snapshot, output)
    check_source_project(checks, facts, output)
    payload = check_engine(checks, facts, snapshot, output)
    check_dynamic(checks, facts, snapshot, output, payload)
    return checks.finish()


if __name__ == "__main__":
    sys.exit(main())
