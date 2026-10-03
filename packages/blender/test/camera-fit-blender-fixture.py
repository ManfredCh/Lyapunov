#!/usr/bin/env python3
"""用**真实 Blender** 生成相机拟合夹具：已知尺寸场景 + 已知镜头机位 + 真实渲染里量出的像素。

为什么不是合成投影：本夹具的像素是**从真实渲染图里量出来的**（每个标记是一颗自发光小球，
取其颜色质心的亚像素位置），再用 Blender 自己的相机矩阵**解析投影**对同一世界点核对；
两者差 > MAX_PROJECTION_DELTA_PX 的标记在本次机位里判为不可用（被遮挡/裁切/测不准）并记进 excluded。
于是"拟合用的像素"与"Blender 真实成像"之间没有自造环节，拟合精度才有意义。

场景是**通用几何**（长方体块、立柱、平面墙、一排共线点），尺寸都在下面参数里，不含任何特定建筑。

用法（在仓库根，用真实 Blender）：

    blender --background --factory-startup --python packages/blender/test/camera-fit-blender-fixture.py -- \
        --outdir packages/blender/test/fixtures/camera-fit

产物：每个机位一份 `<view>.json`（世界点 + 量出的像素 + 真值位姿/内参 + 自检差）与 `<view>.png`（真实渲染）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time

import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))


def _load_solver():
    """把求解器模块本身 import 进来：夹具要**用它的反解**把目标 K 变成 Blender 参数，
    再用真实 Blender 的 view_frame 反过来验这组参数——两边是同一个函数，就没有"两套公式各说各话"。"""
    import importlib.util
    path = os.path.join(HERE, os.pardir, "python", "camera_fit.py")
    spec = importlib.util.spec_from_file_location("camera_fit_solver", os.path.abspath(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SOLVER = _load_solver()

# ---------------------------------------------------------------------------
# 场景参数：通用几何，单位米，Z-up。改这里就能换一个场景，不需要改代码逻辑。
# ---------------------------------------------------------------------------
BOX_SIZE = (4.0, 2.5, 1.8)          # 长方体块 长×宽×高，底面在 z=0
POSTS = [                            # 立柱：地面位置 + 顶端标记高度
    (-3.5, 2.0, 1.2),
    (-3.5, -2.0, 2.2),
    (6.0, -2.0, 3.0),
    (6.0, 2.0, 4.0),
]
WALL = {"x0": 1.0, "x1": 7.0, "z0": 0.35, "z1": 3.0, "y": 3.2}
# 竖直平面（共面点集）；z0 离地 0.35 是让最下一排标记**不埋进地面**（球心贴着地面时下半球被地面吃掉，量到的质心不是球心）
WALL_GRID = (3, 3)                   # 墙上的标记阵列
LINE = {"start": (-3.0, -3.0, 0.45), "step": (1.2, 0.0, 0.0), "count": 5}  # 一排共线点
MARKER_RADIUS = 0.09

VIEWS = [                            # 机位：位置、看点、镜头（毫米）、分辨率
    {"name": "oblique", "location": (10.5, -12.0, 7.0), "target": (2.0, 1.2, 1.4), "lensMm": 50, "resolution": (960, 540)},
    {"name": "low-left", "location": (-9.0, -7.0, 2.4), "target": (2.0, 0.9, 1.3), "lensMm": 35, "resolution": (960, 540)},
    {"name": "high-down", "location": (4.5, -8.5, 13.0), "target": (2.0, 0.6, 0.5), "lensMm": 28, "resolution": (960, 540)},
    {"name": "wall-front", "location": (4.0, -12.0, 1.5), "target": (4.0, WALL["y"], 1.5), "lensMm": 50,
     "resolution": (960, 540), "planarFitGroup": "wall",
     "purpose": "共面两解用例：fit 点只用那面墙上的阵列（共面、秩 2），墙外的可见点全部留作独立检查点"},
    # 竖幅 + 非居中主点 + fx≠fy + 机身带 roll：相机**由目标 K 反解出来的 Blender 参数**搭出来
    # （sensorFit=HORIZONTAL/lens/shift_x,shift_y/render.pixel_aspect/分辨率），再真渲染。
    # 这就是"裁剪过的手机竖幅照片"那种 K：主点不在画面正中、像素不是方的、画幅是竖的。
    {"name": "portrait-crop", "location": (9.5, -11.0, 5.2), "target": (2.0, 1.0, 1.3), "rollDeg": 7.5,
     "resolution": (540, 960),
     "targetIntrinsics": {"fx": 780.0, "fy": 1050.0, "cx": 300.0, "cy": 402.5,
                          "width": 540, "height": 960},
     "purpose": "竖幅+非居中主点+fx≠fy+roll：验证 camera.blender 的那组参数**真的**复现这个 K"
                "（而非只复现 fx），并且拟合位姿在留出的 check 点上仍然对得住"},
]
SAMPLES = 16
SENSOR_WIDTH_MM = 36.0
CENTER_MARGIN_PX = 12.0              # 标记中心离画面边缘的最小距离（太靠边就判不可用）
MAX_PROJECTION_DELTA_PX = 0.6        # 量出的质心与解析投影的最大允许差（超过=该标记的测量不可信，排除）
MIN_AREA_RATIO = 0.6                 # 量到的纯色像素数至少要占投影圆面积的这个比例（被啃掉一半就别用）
COLOR_MATCH_TOLERANCE = 12.0         # 线性色距阈值（0..255 口径）：只认球**内部**的纯色。
# 为什么必须这么紧：球边缘是"标记色↔黑背景/↔别的标记"的混合带，混合到一半左右时，
# 那些像素会落在**更暗的那个调色板颜色**附近（(0,255,127) 的半强度 ≈ (0,127,63)，
# 离 (0,127,127) 只有 ~59）——阈值放宽到 60 就会把别处的边缘环算进这个标记的质心，
# 质心会被整块拽偏十几像素。纯色内部是平台，12 已经足够宽。


def palette(count: int) -> list[tuple[float, float, float]]:
    """从 {0,0.5,1}³ 里取 count 个非黑颜色：两两至少差一个 0.5 分量，质心分类不会串色。"""
    colors = [(r, g, b) for r in (1.0, 0.5, 0.0) for g in (1.0, 0.5, 0.0) for b in (1.0, 0.5, 0.0)
              if (r, g, b) != (0.0, 0.0, 0.0)]
    return colors[:count]


def clear_scene() -> None:
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)


def emission_material(color) -> bpy.types.Material:
    material = bpy.data.materials.new("marker")
    material.use_nodes = True
    tree = material.node_tree
    for node in list(tree.nodes):
        if node.type != 'OUTPUT_MATERIAL':
            tree.nodes.remove(node)
    output = next(node for node in tree.nodes if node.type == 'OUTPUT_MATERIAL')
    emission = tree.nodes.new('ShaderNodeEmission')
    emission.inputs[0].default_value = (*color, 1.0)
    emission.inputs[1].default_value = 1.0
    tree.links.new(emission.outputs[0], output.inputs['Surface'])
    return material


def add_marker(name: str, location, color) -> None:
    bpy.ops.mesh.primitive_uv_sphere_add(radius=MARKER_RADIUS, location=location, segments=32, ring_count=16)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(emission_material(color))
    obj.color = (*color, 1.0)


def add_solid(name: str, location, scale, color) -> None:
    """场景里的实体（长方体块/地面）：给标记一个真实遮挡关系，也是"已知尺寸"的那件东西。"""
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    obj.data.materials.append(emission_material(color))
    bpy.context.view_layer.update()


def build_scene() -> list[dict]:
    """→ 标记清单 [{id, group, world}]（世界点就是标记球心，也是被投影的已知点）。

    标记球**不与实体相交**（角点标记沿外对角线**外上方**偏 1.6·r，不埋进地面）：部分被挡住的小球质心会系统性偏移，
    量出来的像素就不是那个已知点了——这是测量污染，不是精度。遮挡改由相机射线显式排除。
    """
    markers = []
    length, width, height = BOX_SIZE
    body_color = (0.25, 0.25, 0.25)
    add_solid("box-body", (0.0, 0.0, height / 2.0), (length, width, height), body_color)
    add_solid("ground", (2.0, 0.0, -0.05), (40.0, 40.0, 0.1), (0.12, 0.12, 0.12))
    offset = 1.6 * MARKER_RADIUS
    # 长方体块的 8 个角点（沿外对角线外移）：不共面（秩 3）的骨架。
    corners = [(-length / 2, -width / 2, 0.0), (length / 2, -width / 2, 0.0),
               (length / 2, width / 2, 0.0), (-length / 2, width / 2, 0.0),
               (-length / 2, -width / 2, height), (length / 2, -width / 2, height),
               (length / 2, width / 2, height), (-length / 2, width / 2, height)]
    for index, corner in enumerate(corners):
        world = [corner[0] + math.copysign(offset, corner[0]),
                 corner[1] + math.copysign(offset, corner[1]),
                 corner[2] + offset]   # 一律往外上方偏：底角标记也抬离地面，免得下半球埋进地面
        markers.append({"id": f"box-c{index}", "group": "box", "world": world})
    for index, (x, y, z) in enumerate(POSTS):
        markers.append({"id": f"post-{index}", "group": "post", "world": [x, y, z]})
    columns, rows = WALL_GRID
    for column in range(columns):
        for row in range(rows):
            x = WALL["x0"] + (WALL["x1"] - WALL["x0"]) * column / (columns - 1)
            z = WALL["z0"] + (WALL["z1"] - WALL["z0"]) * row / (rows - 1)
            markers.append({"id": f"wall-{column}{row}", "group": "wall", "world": [x, WALL["y"], z]})
    for index in range(LINE["count"]):
        world = [LINE["start"][axis] + LINE["step"][axis] * index for axis in range(3)]
        markers.append({"id": f"line-{index}", "group": "line", "world": world})
    colors = palette(len(markers))
    if len(colors) < len(markers):
        raise RuntimeError(f"调色板不够：{len(colors)} < {len(markers)}")
    for marker, color in zip(markers, colors):
        add_marker(marker["id"], marker["world"], color)
        marker["color"] = list(color)
    return markers


def configure_render(scene, resolution) -> None:
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = SAMPLES
    scene.cycles.use_denoising = False
    scene.cycles.use_adaptive_sampling = False
    scene.cycles.seed = 0
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.render.resolution_x, scene.render.resolution_y = resolution
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    world = bpy.data.worlds['World']
    world.use_nodes = True
    background = world.node_tree.nodes['Background']
    background.inputs[0].default_value = (0.0, 0.0, 0.0, 1.0)
    background.inputs[1].default_value = 1.0


def place_camera(view) -> bpy.types.Object:
    bpy.ops.object.camera_add(location=view["location"])
    camera = bpy.context.object
    camera.name = f"cam-{view['name']}"
    direction = Vector(view["target"]) - Vector(view["location"])
    camera.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    if view.get("rollDeg"):
        # 绕相机自身视轴（局部 Z）转一下：真机位基本都带 roll，OrbitControls 那套"世界 up"装不出来。
        camera.rotation_euler.rotate_axis('Z', math.radians(float(view["rollDeg"])))
    camera.data.clip_start = 0.05
    camera.data.clip_end = 10000.0
    scene = bpy.context.scene
    if view.get("targetIntrinsics"):
        # 用**求解器自己的反解**把目标 K 变成 Blender 参数（sensorFit/lens/shift/pixel_aspect/分辨率）：
        # 这条路径就是读数里 camera.blender 给调用方的路径，夹具这里先跑一遍真实的。
        params = SOLVER.blender_parameters(view["targetIntrinsics"],
                                           float(view.get("sensorWidthMm", SENSOR_WIDTH_MM)))
        camera.data.lens = params["lensMm"]
        camera.data.sensor_width = params["sensorWidthMm"]
        camera.data.sensor_height = params["sensorHeightMm"]
        camera.data.sensor_fit = params["sensorFit"]
        camera.data.shift_x = params["shiftX"]
        camera.data.shift_y = params["shiftY"]
        scene.render.pixel_aspect_x = params["pixelAspect"]["x"]
        scene.render.pixel_aspect_y = params["pixelAspect"]["y"]
        if params["pixelAspectClamped"]:
            raise RuntimeError("目标 K 需要超出 Blender 可用范围的 pixel_aspect：这个夹具不该走到这条分支")
        view["blenderParameters"] = params
    else:
        camera.data.lens = view["lensMm"]
        camera.data.sensor_width = view.get("sensorWidthMm", SENSOR_WIDTH_MM)
        camera.data.sensor_fit = 'AUTO'
        scene.render.pixel_aspect_x = 1.0
        scene.render.pixel_aspect_y = 1.0
        view["blenderParameters"] = {"sensorFit": "AUTO", "lensMm": view["lensMm"],
                                     "sensorWidthMm": view.get("sensorWidthMm", SENSOR_WIDTH_MM),
                                     "sensorHeightMm": float(camera.data.sensor_height),
                                     "shiftX": 0.0, "shiftY": 0.0,
                                     "resolutionPx": {"width": view["resolution"][0],
                                                      "height": view["resolution"][1]},
                                     "pixelAspect": {"x": 1.0, "y": 1.0}}
    bpy.context.scene.camera = camera
    bpy.context.view_layer.update()   # matrix_world 在依赖图更新前是旧值——量投影前必须刷新
    return camera


def view_frame_intrinsics(camera, resolution) -> dict:
    """**用真实 Blender 的 view_frame 求这台相机的 K**（像素中心口径），不靠任何手写公式。

    view_frame 给的是相机系里画幅四角（z<0）：把画面边缘映到 u∈[0,width] 的连续坐标，
    所以像素索引口径要再减 0.5（与合同 cx=(width-1)/2 的约定一致）。
    """
    scene = bpy.context.scene
    width, height = resolution
    frame = [tuple(float(value) for value in point) for point in camera.data.view_frame(scene=scene)]
    xs = sorted(point[0] for point in frame)
    ys = sorted(point[1] for point in frame)
    depth = abs(frame[0][2])
    left, right = xs[0], xs[-1]
    bottom, top = ys[0], ys[-1]
    return {"fx": width * depth / (right - left), "fy": height * depth / (top - bottom),
            "cx": -left * width / (right - left) - 0.5, "cy": top * height / (top - bottom) - 0.5,
            "width": width, "height": height,
            "viewPlane": {"left": left, "right": right, "bottom": bottom, "top": top, "distance": depth}}


def camera_facts(camera, resolution) -> dict:
    width, height = resolution
    rotation = np.array(camera.matrix_world.to_3x3(), dtype=float)
    position = np.array(camera.matrix_world.translation, dtype=float)
    quaternion = camera.matrix_world.to_quaternion()
    scene = bpy.context.scene
    # K 一律由真实 Blender 的 view_frame 求（非中心主点/非方形像素/竖幅都对得上），再和
    # "求解器按同一组参数反推的 K"对账：两边差多少就是"参数是否真的复现了内参"的证据。
    intrinsics = view_frame_intrinsics(camera, resolution)
    parameters = {"sensorFit": camera.data.sensor_fit, "lensMm": float(camera.data.lens),
                  "sensorWidthMm": float(camera.data.sensor_width),
                  "sensorHeightMm": float(camera.data.sensor_height),
                  "shiftX": float(camera.data.shift_x), "shiftY": float(camera.data.shift_y),
                  "resolutionPx": {"width": width, "height": height},
                  "pixelAspect": {"x": float(scene.render.pixel_aspect_x),
                                  "y": float(scene.render.pixel_aspect_y)}}
    predicted = SOLVER.blender_intrinsics_from_parameters(parameters)
    model_delta = {key: predicted[key] - intrinsics[key] for key in ("fx", "fy", "cx", "cy")}
    fx, fy = intrinsics["fx"], intrinsics["fy"]
    # fovX/fovY 是**画面**的视场（由 fx/fy 与像素尺寸定），不是 Blender 的 camera.angle_x/angle_y：
    # AUTO 且横构图时 angle_y 是"把 sensor_height=24mm 竖过来"的虚构角度（本视图 26.99°），
    # 跟实际画幅的垂直视场（2·atan(h/2fy) = 22.93°）差了 4°，照它复现不出同一台相机。
    fov_x = 2.0 * math.degrees(math.atan(width / (2.0 * fx)))
    fov_y = 2.0 * math.degrees(math.atan(height / (2.0 * fy)))
    return {
        "positionM": position.tolist(),
        "rotationMatrix": rotation.tolist(),
        "quaternionXyzw": [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
        "lensMm": float(camera.data.lens),
        "sensorWidthMm": float(camera.data.sensor_width),
        "sensorHeightMm": float(camera.data.sensor_height),
        "sensorFit": camera.data.sensor_fit,
        "shiftX": float(camera.data.shift_x),
        "shiftY": float(camera.data.shift_y),
        "pixelAspect": {"x": float(scene.render.pixel_aspect_x), "y": float(scene.render.pixel_aspect_y)},
        "fovXDeg": fov_x,
        "fovYDeg": fov_y,
        "blenderAngleXDeg": math.degrees(float(camera.data.angle_x)),
        "blenderAngleYDeg": math.degrees(float(camera.data.angle_y)),
        "blenderParameters": parameters,
        "modelDeltaPx": model_delta,
        "intrinsics": {**{key: intrinsics[key] for key in ("fx", "fy", "cx", "cy")},
                       "width": width, "height": height, "distortion": [0.0, 0.0, 0.0, 0.0, 0.0]},
    }


def project(facts: dict, world) -> tuple[float, float, float]:
    """解析投影：u = cx + fx·X/(-Z)、v = cy - fy·Y/(-Z)（与合同、与 MuJoCo 标定同一口径）。

    → (u, v, depth)：depth 是沿相机 -z 的轴向米制深度（>0 表示在相机前方）。
    """
    intrinsics = facts["intrinsics"]
    rotation = np.array(facts["rotationMatrix"], dtype=float)
    position = np.array(facts["positionM"], dtype=float)
    camera_space = rotation.T @ (np.asarray(world, dtype=float) - position)
    depth = -camera_space[2]
    u = intrinsics["cx"] + intrinsics["fx"] * camera_space[0] / depth
    v = intrinsics["cy"] - intrinsics["fy"] * camera_space[1] / depth
    return float(u), float(v), float(depth)


def srgb_to_linear(values: "np.ndarray") -> "np.ndarray":
    """PNG 里存的是 sRGB 编码值（`image.pixels` 读出来的就是文件值），调色板是线性光。

    不转回线性就去比色，比中的不是球内部而是**球边缘的抗锯齿环**（那圈恰好跨过线性灰值），
    质心看着还准，一被遮挡就整块偏掉——旧版本正是栽在这里。这里统一到线性再分类。
    """
    unit = values / 255.0
    return np.where(unit <= 0.04045, unit / 12.92, ((unit + 0.055) / 1.055) ** 2.4) * 255.0


def measure_render(png_path: str, palette_colors: list, resolution) -> dict:
    """从真实渲染图里量每个标记的像素质心（像素中心口径，与合同一致）。

    图像数组第 0 行是**画面底部**；转成"原点左上、v 向下"时 v = (H-1) - 行号，
    于是质心的 u/v 就是像素索引（中心口径），与 cx=(W-1)/2 的约定吻合。
    """
    image = bpy.data.images.load(png_path, check_existing=False)
    width, height = image.size
    raw = np.array(image.pixels[:], dtype=np.float32).reshape(height, width, 4)[:, :, :3] * 255.0
    bpy.data.images.remove(image)
    if (width, height) != tuple(resolution):
        raise RuntimeError(f"渲染尺寸 {width}x{height} 与请求 {resolution} 不一致")
    flat = srgb_to_linear(raw).reshape(-1, 3)
    # 最近调色板颜色分类 + 距离阈值：只留球内部的纯色像素，边缘抗锯齿像素不参与质心。
    palette_array = np.array([[c * 255.0 for c in color] for color in palette_colors])
    distances = np.linalg.norm(flat[:, None, :] - palette_array[None, :, :], axis=2)
    nearest = np.argmin(distances, axis=1)
    closest = distances[np.arange(len(flat)), nearest]
    rows = np.arange(len(flat)) // width
    columns = np.arange(len(flat)) % width
    out = {}
    for index in range(len(palette_colors)):
        mask = (nearest == index) & (closest < COLOR_MATCH_TOLERANCE)
        if not mask.any():
            continue
        count = int(mask.sum())
        mean_column = float(columns[mask].mean())
        mean_row = float(rows[mask].mean())
        out[index] = {"pixel": [mean_column, (height - 1) - mean_row], "renderPixels": count}
    return out


def sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 16), b""):
            digest.update(block)
    return digest.hexdigest()


def occluded(scene, camera, depsgraph, world) -> bool:
    """相机→标记球心的射线在到达球面之前是否打到别的实体（球本身要排除：只走到球面之前）。"""
    origin = camera.matrix_world.translation
    direction = Vector(world) - origin
    distance = direction.length
    if distance <= MARKER_RADIUS * 2:
        return True
    hit, *_ = scene.ray_cast(depsgraph, origin, direction.normalized(), distance=distance - MARKER_RADIUS - 0.02)
    return bool(hit)


def rank3(points) -> int:
    """3D 点集的秩（SVD 相对奇异值）：3=一般位置，2=共面，1=共线。"""
    array = np.asarray(points, dtype=float)
    centered = array - array.mean(axis=0)
    singular = np.linalg.svd(centered, compute_uv=False)
    scale = float(singular[0]) if singular[0] > 0 else 1.0
    return int(sum(1 for value in singular if value / scale > 1e-6))


def split_roles(visible: list[dict], planar_group: str) -> None:
    """给可见标记分 fit/check。

    一般机位：按"每 3 个取 1 个 check"均匀铺开，并要求 fit 子集秩 3（位姿唯一）。
    共面用例（`planar_group` 非空）：fit 集**故意只放那一组的点**——墙上阵列本身共面，位姿两解，
    这正是要考的事实；其余可见点全当独立检查点（不参与拟合），正好用来判两解里哪个对。
    """
    if planar_group:
        for marker in visible:
            marker["role"] = "fit" if marker["group"] == planar_group else "check"
        fit = [marker for marker in visible if marker["role"] == "fit"]
        check = [marker for marker in visible if marker["role"] == "check"]
        if len(fit) < 4 or rank3([marker["world"] for marker in fit]) < 2:
            raise RuntimeError(f"共面用例 fit 组 {planar_group} 不够：可见 {len(fit)} 个")
        if not check:
            raise RuntimeError(f"共面用例没有独立检查点：画面里除了 {planar_group} 组还得有别处的点")
        return
    required = 3
    for position, marker in enumerate(visible):
        marker["role"] = "check" if position % 3 == 2 else "fit"
    fit = [marker for marker in visible if marker["role"] == "fit"]
    for _ in range(12):
        if len(fit) >= 4 and rank3([marker["world"] for marker in fit]) >= required:
            break
        candidates = [marker for marker in visible if marker["role"] == "check"]
        if candidates:
            candidates[0]["role"] = "fit"
        else:
            for marker in reversed(visible):
                if marker["role"] == "fit":
                    marker["role"] = "check"
                    break
        fit = [marker for marker in visible if marker["role"] == "fit"]
    if len(fit) < 4 or rank3([marker["world"] for marker in fit]) < required:
        raise RuntimeError(f"可见标记里凑不出一组秩 {required} 的 fit 点：请换机位或补标记")


def run_view(view, markers, outdir: str) -> dict:
    scene = bpy.context.scene
    configure_render(scene, view["resolution"])
    camera = place_camera(view)
    facts = camera_facts(camera, view["resolution"])
    png_path = os.path.join(outdir, f"{view['name']}.png")
    scene.render.filepath = png_path
    started = time.time()
    bpy.ops.render.render(write_still=True)
    seconds = time.time() - started

    measured = measure_render(png_path, [marker["color"] for marker in markers], view["resolution"])
    width, height = view["resolution"]
    visible, excluded = [], []
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for index, marker in enumerate(markers):
        u, v, depth = project(facts, marker["world"])
        if depth <= 0:
            excluded.append({"id": marker["id"], "group": marker["group"], "reason": "在相机背后"})
            continue
        if not (CENTER_MARGIN_PX <= u <= width - 1 - CENTER_MARGIN_PX and CENTER_MARGIN_PX <= v <= height - 1 - CENTER_MARGIN_PX):
            excluded.append({"id": marker["id"], "group": marker["group"], "reason": "投影落在画面边缘或画外", "projectedPx": [u, v]})
            continue
        if occluded(scene, camera, depsgraph, marker["world"]):
            excluded.append({"id": marker["id"], "group": marker["group"], "reason": "被场景实体挡住（相机射线在标记之前就打到别的物体）", "projectedPx": [u, v]})
            continue
        found = measured.get(index)
        if found is None:
            excluded.append({"id": marker["id"], "group": marker["group"], "reason": "渲染图里没有量到该标记（被遮挡或不可见）", "projectedPx": [u, v]})
            continue
        expected_radius_px = MARKER_RADIUS * facts["intrinsics"]["fx"] / depth
        expected_area_px = math.pi * expected_radius_px ** 2
        if found["renderPixels"] < MIN_AREA_RATIO * expected_area_px:
            excluded.append({"id": marker["id"], "group": marker["group"],
                             "reason": f"量到的纯色像素 {found['renderPixels']} 只占投影圆面积 {expected_area_px:.0f} 的 "
                                       f"{found['renderPixels'] / expected_area_px:.0%}（被部分遮挡，质心不可信）",
                             "projectedPx": [u, v], "measuredPx": found["pixel"]})
            continue
        delta = math.hypot(found["pixel"][0] - u, found["pixel"][1] - v)
        if delta > MAX_PROJECTION_DELTA_PX:
            excluded.append({"id": marker["id"], "group": marker["group"],
                             "reason": f"量出的质心与解析投影差 {delta:.2f} px（超过 {MAX_PROJECTION_DELTA_PX}）",
                             "projectedPx": [u, v], "measuredPx": found["pixel"]})
            continue
        visible.append({"id": marker["id"], "group": marker["group"], "world": marker["world"],
                        "pixelMeasured": found["pixel"], "pixelProjected": [u, v],
                        "renderPixels": found["renderPixels"], "projectionDeltaPx": delta,
                        "depthM": depth})
    try:
        split_roles(visible, str(view.get("planarFitGroup", "")))
    except RuntimeError as error:      # 凑不出可用点集时，把可见/排除明细一起报出来，省得瞎猜机位
        goal = view.get("planarFitGroup")
        key = [item for item in excluded if item["group"] == goal]
        rest = [item for item in excluded if item["group"] != goal][:6]
        detail = "；".join(f"{item['id']}={item['reason']}" for item in key + rest)
        raise RuntimeError(f"{error}｜可见 {[marker['id'] for marker in visible]}｜排除样本 {detail}") from None
    for marker in visible:
        marker["pixelMeasureBiasPx"] = [marker["pixelMeasured"][0] - marker["pixelProjected"][0],
                                        marker["pixelMeasured"][1] - marker["pixelProjected"][1]]
    deltas = [marker["projectionDeltaPx"] for marker in visible]
    fixture = {
        "kind": "camera-fit-blender-fixture",
        "generator": "packages/blender/test/camera-fit-blender-fixture.py",
        "blender": {"version": bpy.app.version_string, "engine": scene.render.engine,
                    "device": scene.cycles.device, "samples": scene.cycles.samples,
                    "viewTransform": scene.view_settings.view_transform,
                    "renderSeconds": round(seconds, 3)},
        "scene": {"description": "通用几何：长方体块角点 + 立柱顶 + 平面墙上阵列 + 一排共线点；标记是自发光小球，"
                                 "被投影的已知点就是球心",
                  "boxSizeM": list(BOX_SIZE), "posts": POSTS, "wall": WALL, "wallGrid": list(WALL_GRID),
                  "line": LINE, "markerRadiusM": MARKER_RADIUS},
        "view": {"name": view["name"], "resolution": {"width": width, "height": height},
                 "png": os.path.basename(png_path), "pngSha256": sha256_of(png_path),
                 "locationM": list(view["location"]), "targetM": list(view["target"]),
                 "rollDeg": float(view.get("rollDeg", 0.0)),
                 "blenderParameters": view.get("blenderParameters"),
                 "targetIntrinsics": view.get("targetIntrinsics"),
                 "purpose": view.get("purpose"), "planarFitGroup": view.get("planarFitGroup")},
        "groundTruth": facts,
        "points": visible,
        "excluded": excluded,
        "selfCheck": {"visibleMarkers": len(visible),
                      "fitPoints": sum(1 for marker in visible if marker["role"] == "fit"),
                      "checkPoints": sum(1 for marker in visible if marker["role"] == "check"),
                      "maxProjectionDeltaPx": max(deltas) if deltas else None,
                      "meanProjectionDeltaPx": float(np.mean(deltas)) if deltas else None,
                      "maxModelDeltaPx": max(abs(value) for value in facts["modelDeltaPx"].values()),
                      "modelDeltaPx": facts["modelDeltaPx"],
                      "note": "pixelMeasured 是渲染图里量出的质心，pixelProjected 是 Blender 相机矩阵的解析投影；"
                              "两者之差是本次测量的自检差，不是拟合精度。modelDeltaPx 是"
                              "「求解器按这组 Blender 参数反推的 K − 真实 Blender view_frame 给的 K」，"
                              "它才是「这组参数复现不复现内参」的证据（夹具里应到 1e-3 px 量级以下）。"},
    }
    json_path = os.path.join(outdir, f"{view['name']}.json")
    with open(json_path, "w", encoding="utf-8") as handle:
        json.dump(fixture, handle, ensure_ascii=False, indent=2)
    groups = {}
    for marker in visible:
        groups[marker["group"]] = groups.get(marker["group"], 0) + 1
    print(f"[fixture] {view['name']}: 可见 {len(visible)}（fit {fixture['selfCheck']['fitPoints']} / "
          f"check {fixture['selfCheck']['checkPoints']}，组 {groups}），排除 {len(excluded)}，"
          f"自检差 max {fixture['selfCheck']['maxProjectionDeltaPx']:.3f} px，渲染 {seconds:.2f}s")
    bpy.data.objects.remove(camera, do_unlink=True)
    return fixture


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--outdir", required=True)
    parser.add_argument("--views", default="", help="只跑指定机位（逗号分隔），缺省跑全部")
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    args = parser.parse_args(argv)
    outdir = os.path.abspath(os.path.expanduser(args.outdir))
    os.makedirs(outdir, exist_ok=True)
    selected = [view for view in VIEWS if not args.views or view["name"] in args.views.split(",")]
    clear_scene()
    markers = build_scene()
    print(f"[fixture] Blender {bpy.app.version_string}，标记 {len(markers)} 个，机位 {[v['name'] for v in selected]}")
    for view in selected:
        run_view(view, markers, outdir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
