#!/usr/bin/env python3
"""把**拟合出来的相机**装回真实 Blender 再渲染一遍，用真实成像核对拟合读数。

为什么要有这一步：夹具里量出的像素只能证明"求解器在自己的输入上收敛"；这里换一条独立通路——
用结果里的 `camera.blender`（locationM / rotationQuaternionXyzw / lensMm / sensorWidthMm）真装一台相机，
真渲染，再从渲染图里量质心，跟拟合读数里的 `predictedPx` 比。两个量各自独立产生：

  · deltaApplyPx   = 新渲染里量到的质心 − 拟合预测像素。它把"位姿/内参 → 像素"这条链路的
                     数值正确性（含 Blender 适配字段的口径）压到测量噪声量级；
  · deltaFixturePx = 新渲染里量到的质心 − 夹具（真值相机）里量到的质心。它直接用像素量出
                     "拟合出来的相机离真值相机差多远"，不经过任何自报数据。

用法（在仓库根）：

    blender --background --factory-startup --python packages/blender/test/camera-fit-apply-check.py -- \
        --fixture packages/blender/test/fixtures/camera-fit/oblique.json \
        --result <拟合读数.json> --outdir <输出目录>

stdout 上打一行 `CAMERA_FIT_APPLY=<json>`，退出码 0=核对完成，2=环境/用法问题，3=输入不可用。
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import sys
import time

import bpy
import numpy as np

APPLY_PREFIX = "CAMERA_FIT_APPLY="
HERE = os.path.dirname(os.path.abspath(__file__))


def _load_fixture_module():
    """复用夹具脚本的场景搭建/成像测量代码：两份实现一定会漂移，这里只留一份。"""
    path = os.path.join(HERE, "camera-fit-blender-fixture.py")
    spec = importlib.util.spec_from_file_location("camera_fit_blender_fixture", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _fail(code: str, message: str, **detail) -> int:
    print(json.dumps({"ok": False, "code": code, "message": message, **detail}, ensure_ascii=False))
    return 3


def _install_camera(fixture, blender_camera: dict):
    """按拟合读数里的 Blender 字段真装一台相机：只读结果，不做任何换算。

    两个必须照做的地方：
    · 四元数**分量顺序**：读数里的 rotationQuaternionXyzw 是 (x,y,z,w)（与 three.js 一致），
      而 Blender 的 rotation_quaternion 是 (w,x,y,z)。顺序搞错不报错——装出来的是一台转错方向的相机，
      渲染图照样有内容，只是核不上。
    · 内参要**整套**装：sensorFit/lens/sensor/shift_x,shift_y + scene.render.pixel_aspect + 分辨率。
      只装 lens/sensor 会得到一台主点居中、方形像素的相机（裁剪竖幅照片会整体错几十到几百像素）。
    """
    width = int(blender_camera["resolutionPx"]["width"])
    height = int(blender_camera["resolutionPx"]["height"])
    location = blender_camera.get("locationM")
    if location is None:                      # 尺度未定的读数不能当米装进 Blender
        raise RuntimeError("读数里的位置是 locationInputUnits（尺度未定），不能按米装进 Blender 场景")
    qx, qy, qz, qw = (float(value) for value in blender_camera["rotationQuaternionXyzw"])
    bpy.ops.object.camera_add(location=tuple(location))
    camera = bpy.context.object
    camera.name = "cam-fitted"
    camera.rotation_mode = "QUATERNION"
    camera.rotation_quaternion = (qw, qx, qy, qz)
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.render.pixel_aspect_x = float(blender_camera["pixelAspect"]["x"])
    scene.render.pixel_aspect_y = float(blender_camera["pixelAspect"]["y"])
    camera.data.lens = float(blender_camera["lensMm"])
    camera.data.sensor_width = float(blender_camera["sensorWidthMm"])
    camera.data.sensor_height = float(blender_camera.get("sensorHeightMm", camera.data.sensor_height))
    camera.data.sensor_fit = str(blender_camera.get("sensorFit", "AUTO"))
    camera.data.shift_x = float(blender_camera.get("shiftX", 0.0))
    camera.data.shift_y = float(blender_camera.get("shiftY", 0.0))
    camera.data.clip_start = 0.05
    camera.data.clip_end = 10000.0
    scene.camera = camera
    bpy.context.view_layer.update()
    return camera


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--outdir", required=True)
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    args = parser.parse_args(argv)

    fixture = _load_fixture_module()
    try:
        with open(args.fixture, encoding="utf-8") as handle:
            fixture_data = json.load(handle)
        with open(args.result, encoding="utf-8") as handle:
            result = json.load(handle)
    except (OSError, ValueError) as error:
        return _fail("CAMERA_FIT_APPLY_INPUT", f"夹具或拟合读数读不进来：{error}")
    blender_camera = (result.get("camera") or {}).get("blender")
    if not isinstance(blender_camera, dict):
        return _fail("CAMERA_FIT_APPLY_INPUT", "拟合读数里没有 camera.blender（无法回灌真实 Blender）")
    points = fixture_data.get("points") or []
    if not points:
        return _fail("CAMERA_FIT_APPLY_INPUT", "夹具里没有 points")

    outdir = os.path.abspath(os.path.expanduser(args.outdir))
    os.makedirs(outdir, exist_ok=True)
    view = fixture_data["view"]
    width = int(view["resolution"]["width"])
    height = int(view["resolution"]["height"])

    fixture.clear_scene()
    markers = fixture.build_scene()
    fixture.configure_render(bpy.context.scene, (width, height))
    camera = _install_camera(fixture, blender_camera)
    png_path = os.path.join(outdir, f"{view['name']}-apply.png")
    bpy.context.scene.render.filepath = png_path
    started = time.time()
    bpy.ops.render.render(write_still=True)
    seconds = time.time() - started

    measured = fixture.measure_render(png_path, [marker["color"] for marker in markers], (width, height))
    by_id = {marker["id"]: index for index, marker in enumerate(markers)}
    # 拟合读数里逐点预测像素：fit 与 check 两组都要核（check 点不参与拟合，更要核）。
    predicted = {}
    for group in ("fit", "check"):
        block = ((result.get("reprojection") or {}).get(group) or {})
        for entry in block.get("perPoint") or []:
            if isinstance(entry, dict) and isinstance(entry.get("predictedPx"), list):
                predicted[entry.get("id")] = entry
    facts = fixture.camera_facts(camera, (width, height))
    # 装完之后这台相机**真实**的 K（Blender 自己的 view_frame 求的，不是读数自报的）与请求 K 的差。
    requested = result.get("intrinsics") or {}
    k_error = {"fx": None, "fy": None, "cx": None, "cy": None}
    for key in k_error:
        if isinstance(requested.get(key), (int, float)):
            k_error[key] = facts["intrinsics"][key] - float(requested[key])
    resolved = (blender_camera.get("resolvesIntrinsics") or {})
    resolve_error = {key: (facts["intrinsics"][key] - float(resolved[key]))
                     if isinstance(resolved.get(key), (int, float)) else None
                     for key in ("fx", "fy", "cx", "cy")}
    k_summary = {
        "requested": {key: requested.get(key) for key in ("fx", "fy", "cx", "cy", "width", "height")},
        "inBlender": {key: facts["intrinsics"][key] for key in ("fx", "fy", "cx", "cy")},
        "parameters": {"sensorFit": camera.data.sensor_fit, "lensMm": float(camera.data.lens),
                       "sensorWidthMm": float(camera.data.sensor_width),
                       "shiftX": float(camera.data.shift_x), "shiftY": float(camera.data.shift_y),
                       "pixelAspect": {"x": float(bpy.context.scene.render.pixel_aspect_x),
                                       "y": float(bpy.context.scene.render.pixel_aspect_y)}},
        "maxRequestedErrorPx": max(abs(value) for value in k_error.values() if value is not None),
        "maxResolvesIntrinsicsErrorPx": max(abs(value) for value in resolve_error.values() if value is not None),
        "errorPx": k_error,
        "note": "inBlender 是**装完之后**用真实 Blender 的 camera.data.view_frame 求出的 K（像素中心口径）；"
                "maxRequestedErrorPx 说明这组参数复现请求 K 到什么程度，"
                "maxResolvesIntrinsicsErrorPx 说明读数里自报的 resolvesIntrinsics 有没有说谎。",
    }

    deltas = []
    for point in points:
        marker_id = point["id"]
        index = by_id.get(marker_id)
        entry = predicted.get(marker_id)
        if index is None or entry is None:
            deltas.append({"id": marker_id, "role": point.get("role"), "skipped": "本次渲染里没量到或读数里没有该点"})
            continue
        found = measured.get(index)
        if found is None:
            deltas.append({"id": marker_id, "role": point.get("role"), "skipped": "本次渲染里没量到该标记的纯色像素"})
            continue
        u, v, _ = fixture.project(facts, point["world"])
        applied = found["pixel"]
        expect = entry["predictedPx"]
        fixture_px = point["pixelMeasured"]
        deltas.append({
            "id": marker_id, "role": point.get("role"),
            "worldM": point["world"],
            "fixtureMeasuredPx": fixture_px,
            "applyMeasuredPx": applied,
            "predictedPx": expect,
            "applyAnalyticPx": [u, v],
            "deltaApplyPx": math.hypot(applied[0] - expect[0], applied[1] - expect[1]),
            "deltaFixturePx": math.hypot(applied[0] - fixture_px[0], applied[1] - fixture_px[1]),
            "renderPixels": found["renderPixels"],
        })
    scored = [item for item in deltas if "deltaApplyPx" in item]
    if not scored:
        return _fail("CAMERA_FIT_APPLY_MEASURED_NOTHING", "回灌渲染里一个标记都没量到", view=view["name"])
    summary = {
        "points": len(scored),
        "fitPoints": sum(1 for item in scored if item["role"] == "fit"),
        "checkPoints": sum(1 for item in scored if item["role"] == "check"),
        "maxApplyDeltaPx": max(item["deltaApplyPx"] for item in scored),
        "meanApplyDeltaPx": float(np.mean([item["deltaApplyPx"] for item in scored])),
        "maxFixtureDeltaPx": max(item["deltaFixturePx"] for item in scored),
        "meanFixtureDeltaPx": float(np.mean([item["deltaFixturePx"] for item in scored])),
        "note": "deltaApplyPx=拟合预测像素与回灌渲染量到的质心之差（数值链路+测量噪声）；"
                "deltaFixturePx=回灌渲染质心与真值相机夹具质心之差（直接用像素量出的相机差）。",
    }
    payload = {
        "ok": True, "kind": "camera-fit-apply-check", "view": view["name"],
        "fixture": os.path.basename(args.fixture), "result": os.path.basename(args.result),
        "blender": {"version": bpy.app.version_string, "engine": bpy.context.scene.render.engine,
                    "samples": bpy.context.scene.cycles.samples, "renderSeconds": round(seconds, 3)},
        "resolution": {"width": width, "height": height}, "png": os.path.basename(png_path),
        "cameraInstalled": {"locationM": list(camera.matrix_world.translation),
                            "lensMm": float(camera.data.lens), "sensorWidthMm": float(camera.data.sensor_width),
                            "sensorFit": camera.data.sensor_fit,
                            "analyticIntrinsics": facts["intrinsics"]},
        "intrinsicsCheck": k_summary,
        "deltas": deltas, "summary": summary,
    }
    out_path = os.path.join(outdir, f"{view['name']}-apply.json")
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    print(APPLY_PREFIX + json.dumps({"ok": True, "view": view["name"], "json": out_path,
                                     "maxIntrinsicsErrorPx": k_summary["maxRequestedErrorPx"],
                                     "maxResolvesIntrinsicsErrorPx": k_summary["maxResolvesIntrinsicsErrorPx"],
                                     **summary}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
