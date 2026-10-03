#!/usr/bin/env python3
"""用 OpenCV（隔离解释器）从 3D-2D 对应点拟合照片相机位姿。

输入：`--input request.json`（或 `--input -` 从 stdin 读）。世界点是米制、Z-up；像素原点左上、u 右 v 下。
输出：stdout 单行

    LYAPUNOV_CAMERA_FIT_RESULT={...}   成功，退出码 0
    LYAPUNOV_CAMERA_FIT_ERROR={...}    可预期失败（输入非法／点不可辨识／缺 OpenCV），退出码 3
    未预期异常：stderr 回溯，退出码 2

坐标合同（与 packages/sim-mujoco/python/worker.py 的 camera calibration 同一份，不另立一套）：

    camera x 右、y 上、看向 -z；world = R * p_cam + t
    p_cam = [(u-cx)*d/fx, -(v-cy)*d/fy, -d]，d 是沿相机 -z 的轴向米制深度
    cx/cy 用像素中心口径 (width-1)/2、(height-1)/2（与 MuJoCo 标定、与 Blender 渲染一致）

Blender 相机局部轴（+X 右／+Y 上／-Z 朝前）与 three.js（原生 Viewer）同构，所以同一个 R
与四元数在两处都直接可用；focal 与 FOV 的换算在 blender/viewer 两个适配块里给出。

四条纪律（都写进结果的 precision/warnings 里，不靠调用方记得）：

  · 低残差 ≠ 实测精度：拟合残差与**独立检查点**残差分开报，且残差只说明"给定对应点被重投影到
    什么程度"。没有检查点时明确声明这次没有独立证据。
  · 共面点集有两解、共线点不可辨识：共面时算两解并给误差间隔与歧义判定；三点共线（或投影退化）
    直接报错，不拿"还能算出一个位姿"冒充答案。
  · 内参不是调用方给的实测标定（按镜头 FOV／传感器／消失点估计或按理由假设）时，标 source 与
    assumptions，并声明这不是实测标定，也不拿一个固定焦距当真相。
  · 尺度：世界点单位未知时只在归一化坐标下求解，位置沿用输入单位，不宣称绝对尺度与绝对位置。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

RESULT_PREFIX = "LYAPUNOV_CAMERA_FIT_RESULT="
ERROR_PREFIX = "LYAPUNOV_CAMERA_FIT_ERROR="
EXIT_OK = 0
EXIT_INTERNAL = 2
EXIT_FIT_ERROR = 3
SCRIPT_VERSION = "1"
# 输出精度：旋转/位置给 12 位十进制（远超像素级需求），像素给 9 位；JSON 因此逐位可比。
DIGITS = 12
PIXEL_DIGITS = 9
# 一次拟合的对应点上限（超过就拒绝，不悄悄截断）；报告里逐点明细的上限（计数与统计仍是全量）。
MAX_CORRESPONDENCES = 4096
MAX_REPORTED_POINTS = 200
# PnP 的最小点数：少于 4 个不共线点，位姿不唯一（3 点有最多 4 个 P3P 解）。
MIN_FIT_POINTS = 4
# 奇异值比：<= COLLINEAR_RATIO 判为共线/共面（秩亏），<= NEAR_DEGENERATE_RATIO 给出病态警告。
COLLINEAR_RATIO = 1e-6
NEAR_DEGENERATE_RATIO = 1e-2

# 世界点单位 → 米。未知/相对尺度不在表里，走归一化路径。
WORLD_UNITS = {
    "m": 1.0, "metre": 1.0, "meter": 1.0, "metres": 1.0, "meters": 1.0,
    "cm": 0.01, "mm": 0.001, "km": 1000.0, "dm": 0.1,
    "in": 0.0254, "inch": 0.0254, "inches": 0.0254, "ft": 0.3048, "feet": 0.3048, "foot": 0.3048,
    "yd": 0.9144, "mil": 2.54e-5,
}
UNKNOWN_SCALES = {"unknown", "relative", "arbitrary", "unitless", "none"}

# Blender 相机参数的默认口径（见 blender_parameters()）：传感器尺寸只是 lens 的参照，两者只有成对才有意义。
BLENDER_SENSOR_WIDTH_MM = 36.0
BLENDER_SENSOR_HEIGHT_MM = 24.0
# scene.render.pixel_aspect_x/y 是表达 fx≠fy 的唯一旋钮；超出这个范围就不假装能复现。
BLENDER_PIXEL_ASPECT_RANGE = (0.1, 200.0)

DISTORTION_MODELS = {
    4: "opencv-k1k2p1p2",
    5: "opencv-k1k2p1p2k3",
    8: "opencv-k1k2p1p2k3k4k5k6",
    12: "opencv-k1k2p1p2k3k4k5k6s1s2s3s4",
    14: "opencv-k1k2p1p2k3k4k5k6s1s2s3s4tauXtauY",
}


class FitError(Exception):
    """可预期失败：稳定机器码 + 给人看的原因/下一步。"""

    def __init__(self, code: str, message: str, **detail):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.detail = detail


def r(value, digits: int = DIGITS):
    """四舍五入到固定小数位；-0.0 归一成 0.0，保证 JSON 稳定可比。"""
    number = round(float(value), digits)
    return 0.0 if number == 0 else number


def vec(values, digits: int = DIGITS) -> list:
    return [r(v, digits) for v in values]


def mat(rows, digits: int = DIGITS) -> list:
    return [vec(row, digits) for row in rows]


def emit(payload: dict, prefix: str) -> None:
    print(prefix + json.dumps(payload, ensure_ascii=False))


def fail(code: str, message: str, **extra) -> int:
    emit({"ok": False, "scriptVersion": SCRIPT_VERSION,
          "error": {"code": code, "message": message, **extra}}, ERROR_PREFIX)
    return EXIT_FIT_ERROR


# ---------------------------------------------------------------------------
# 输入解析与校验
# ---------------------------------------------------------------------------
def load_request(path: str) -> dict:
    if path == "-":
        raw = sys.stdin.read()
        source = "<stdin>"
    else:
        resolved = os.path.expanduser(path)
        if not os.path.isfile(resolved):
            raise FitError("CAMERA_FIT_INPUT_MISSING", f"请求文件不存在：{path}", path=path)
        with open(resolved, "r", encoding="utf-8") as handle:
            raw = handle.read()
        source = resolved
    if not raw.strip():
        raise FitError("CAMERA_FIT_INPUT_EMPTY", f"请求文件是空的：{source}", path=source)
    try:
        request = json.loads(raw)
    except json.JSONDecodeError as error:
        raise FitError("CAMERA_FIT_INPUT_UNREADABLE",
                       f"请求不是合法 JSON（{error.msg} 在第 {error.lineno} 行）", path=source)
    if not isinstance(request, dict):
        raise FitError("CAMERA_FIT_INPUT_INVALID", "请求必须是一个 JSON 对象", path=source)
    return request


def _finite3(value, label: str) -> list:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise FitError("CAMERA_FIT_INPUT_INVALID", f"{label} 必须是 3 个数（收到 {value!r}）", field=label)
    out = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            raise FitError("CAMERA_FIT_INPUT_INVALID", f"{label} 里有非数值：{item!r}", field=label)
        number = float(item)
        if not math.isfinite(number):
            raise FitError("CAMERA_FIT_INPUT_INVALID", f"{label} 里有非有限值（NaN/Inf）：{item!r}", field=label)
        out.append(number)
    return out


def _finite2(value, label: str) -> list:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise FitError("CAMERA_FIT_INPUT_INVALID", f"{label} 必须是 2 个数（收到 {value!r}）", field=label)
    out = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            raise FitError("CAMERA_FIT_INPUT_INVALID", f"{label} 里有非数值：{item!r}", field=label)
        number = float(item)
        if not math.isfinite(number):
            raise FitError("CAMERA_FIT_INPUT_INVALID", f"{label} 里有非有限值（NaN/Inf）：{item!r}", field=label)
        out.append(number)
    return out


def read_correspondences(request: dict):
    """→ (fit_world, fit_pixel, fit_ids, check_world, check_pixel, check_ids, meta)。

    重复点规则（这里决定 check 点算不算**独立证据**，所以必须显式判，不能只看数量）：

    · id 重复，或"世界点与像素都完全相同"的对应点重复（含跨 role）→ 直接拒绝：把同一条观测既放进
      fit 又放进 check，会让"独立核对"变成复读，还会让 RANSAC 把同一个点当两个证据。
    · 世界点相同、像素不同（同一 3D 点在不同照片/不同时刻的两次观测）→ 允许，但 check 侧这类点会记进
      meta.checkRepeatedWorldPoints：它们能核对内参与像素一致性，**不提供空间外推验证**（世界点已经在
      fit 里出现过，位姿在那片区域是"见过"的）。
    """
    raw = request.get("correspondences")
    if not isinstance(raw, list) or not raw:
        raise FitError("CAMERA_FIT_INPUT_INVALID",
                       "correspondences 必须是非空数组，每项形如 {\"world\":[x,y,z],\"pixel\":[u,v],\"role\":\"fit|check\"}")
    if len(raw) > MAX_CORRESPONDENCES:
        raise FitError("CAMERA_FIT_TOO_MANY_POINTS",
                       f"对应点 {len(raw)} 个，超过上限 {MAX_CORRESPONDENCES}；请先抽样或分批",
                       count=len(raw), limit=MAX_CORRESPONDENCES)
    fit_world, fit_pixel, fit_ids = [], [], []
    check_world, check_pixel, check_ids = [], [], []
    roles = {"fit": 0, "check": 0}
    seen_ids: dict[str, int] = {}
    seen_pairs: dict[tuple, tuple] = {}
    seen_worlds: dict[tuple, list] = {}
    for index, item in enumerate(raw):
        where = f"correspondences[{index}]"
        if not isinstance(item, dict):
            raise FitError("CAMERA_FIT_INPUT_INVALID", f"{where} 必须是对象（收到 {item!r}）", field=where)
        label = item.get("id")
        name = str(label) if isinstance(label, (str, int)) and not isinstance(label, bool) else f"p{index + 1}"
        role = item.get("role", "fit")
        if role not in ("fit", "check"):
            raise FitError("CAMERA_FIT_INPUT_INVALID",
                           f"{where}.role 只能是 \"fit\" 或 \"check\"（收到 {role!r}）；"
                           "check 点是**不参与拟合**的独立检查点", field=f"{where}.role")
        if "world" not in item or "pixel" not in item:
            raise FitError("CAMERA_FIT_INPUT_INVALID", f"{where} 缺少 world 或 pixel", field=where)
        world = _finite3(item["world"], f"{where}.world")
        pixel = _finite2(item["pixel"], f"{where}.pixel")
        if name in seen_ids:
            raise FitError("CAMERA_FIT_DUPLICATE_CORRESPONDENCE",
                           f"id={name!r} 出现了两次（第 {seen_ids[name] + 1} 项与第 {index + 1} 项）："
                           "同一 id 只能有一条对应点，重复 id 说明数据被贴了两遍",
                           field=f"{where}.id", id=name, firstIndex=seen_ids[name], secondIndex=index)
        seen_ids[name] = index
        pair = (tuple(world), tuple(pixel))
        if pair in seen_pairs:
            first_index, first_role = seen_pairs[pair]
            if first_role != role:
                raise FitError("CAMERA_FIT_DUPLICATE_CORRESPONDENCE",
                               f"第 {index + 1} 项（{where}）与第 {first_index + 1} 项的世界点和像素完全相同，"
                               f"却被分别当成 {first_role} 与 {role}：完全重复的对应点不能既参与拟合又当独立检查点"
                               "（独立核对会退化成复读，RANSAC 还会把它当两个证据）",
                               field=where, world=world, pixel=pixel,
                               firstRole=first_role, secondRole=role)
            raise FitError("CAMERA_FIT_DUPLICATE_CORRESPONDENCE",
                           f"第 {index + 1} 项（{where}）与第 {first_index + 1} 项是完全相同的对应点"
                           f"（同为 {role}）：重复计数会让该点在拟合里权重翻倍，请去掉重复项",
                           field=where, world=world, pixel=pixel, role=role)
        seen_pairs[pair] = (index, role)
        seen_worlds.setdefault(tuple(world), []).append((index, role, name))
        roles[role] += 1
        if role == "fit":
            fit_world.append(world)
            fit_pixel.append(pixel)
            fit_ids.append(name)
        else:
            check_world.append(world)
            check_pixel.append(pixel)
            check_ids.append(name)
    if len(fit_world) < MIN_FIT_POINTS:
        raise FitError("CAMERA_FIT_POINTS_INSUFFICIENT",
                       f"参与拟合的点只有 {len(fit_world)} 个，至少需要 {MIN_FIT_POINTS} 个不共线的 fit 点"
                       f"（check 点不参与拟合）",
                       fitPoints=len(fit_world), checkPoints=len(check_world), required=MIN_FIT_POINTS)
    # 空间上"见过"的 check 点：世界点在 fit 里出现过（像素不同，所以不是重复观测）。
    repeated_ids = [name for entries in seen_worlds.values()
                    if any(role == "fit" for _, role, _ in entries)
                    for _, role, name in entries if role == "check"]
    held_out = roles["check"] - len(repeated_ids)
    if roles["check"] and held_out <= 0:
        held_out_note = ("check 点的世界点全部在 fit 里出现过：它们只能核对内参/像素一致性，"
                         "不能验证位姿在没见过的空间位置上的外推。")
    elif repeated_ids:
        held_out_note = (f"{len(repeated_ids)} 个 check 点的世界点也出现在 fit 里（像素观测不同）："
                         f"只有另外 {held_out} 个 check 点提供空间外推验证。")
    else:
        held_out_note = "check 点的世界点都没有参与拟合：可作空间外推的独立核对。"
    meta = {"total": len(raw), "fit": roles["fit"], "check": roles["check"],
            "uniqueWorldPoints": len(seen_worlds),
            "checkRepeatedWorldPoints": len(repeated_ids),
            "checkRepeatedWorldPointIds": repeated_ids[:MAX_REPORTED_POINTS],
            "checkHeldOut": bool(roles["check"] > 0 and held_out > 0),
            "note": held_out_note}
    return fit_world, fit_pixel, fit_ids, check_world, check_pixel, check_ids, meta


def resolve_world_unit(request: dict):
    """世界点单位 → 米制因子。未知/相对尺度返回 None（走归一化路径，不假装有绝对尺度）。"""
    raw = request.get("worldUnit", "m")
    if not isinstance(raw, str):
        raise FitError("CAMERA_FIT_INPUT_INVALID", f"worldUnit 必须是字符串（收到 {raw!r}）", field="worldUnit")
    unit = raw.strip().lower()
    if unit in UNKNOWN_SCALES:
        return None, {"unit": "unknown", "metresPerUnit": None, "determined": False,
                      "source": "caller-declared-unknown"}
    if unit not in WORLD_UNITS:
        raise FitError("CAMERA_FIT_UNIT_UNSUPPORTED",
                       f"worldUnit {raw!r} 不支持；可用：{'/'.join(sorted(set(WORLD_UNITS) - {'metre', 'meter', 'metres', 'meters', 'inch', 'inches', 'feet', 'foot'}))}"
                       f"，或声明 \"unknown\"（相对尺度）",
                       field="worldUnit", value=raw)
    factor = WORLD_UNITS[unit]
    return factor, {"unit": unit, "metresPerUnit": factor, "determined": True, "source": "caller-declared-unit"}


# ---------------------------------------------------------------------------
# 内参：已知 K 优先；无 K 时按镜头/消失点给**标明来源**的估计或假设
# ---------------------------------------------------------------------------
def _intrinsics_from_known(raw: dict) -> dict:
    for key in ("fx", "fy", "width", "height"):
        value = raw.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise FitError("CAMERA_FIT_INPUT_INVALID",
                           f"intrinsics.{key} 必须是有限数（收到 {value!r}）；已知 K（实测标定）是内参的主要来源",
                           field=f"intrinsics.{key}")
    fx, fy = float(raw["fx"]), float(raw["fy"])
    width, height = float(raw["width"]), float(raw["height"])
    if fx <= 0 or fy <= 0:
        raise FitError("CAMERA_FIT_INPUT_INVALID", f"intrinsics.fx/fy 必须为正（收到 {fx}/{fy}）",
                       field="intrinsics.fx")
    if width <= 1 or height <= 1:
        raise FitError("CAMERA_FIT_INPUT_INVALID", f"intrinsics.width/height 必须 > 1（收到 {width}/{height}）",
                       field="intrinsics.width")
    cx = raw.get("cx", (width - 1) / 2.0)
    cy = raw.get("cy", (height - 1) / 2.0)
    if isinstance(cx, bool) or not isinstance(cx, (int, float)) or not math.isfinite(float(cx)):
        raise FitError("CAMERA_FIT_INPUT_INVALID", f"intrinsics.cx 必须是有限数（收到 {cx!r}）", field="intrinsics.cx")
    if isinstance(cy, bool) or not isinstance(cy, (int, float)) or not math.isfinite(float(cy)):
        raise FitError("CAMERA_FIT_INPUT_INVALID", f"intrinsics.cy 必须是有限数（收到 {cy!r}）", field="intrinsics.cy")
    return {"fx": fx, "fy": fy, "cx": float(cx), "cy": float(cy), "width": width, "height": height}


def _distortion_of(raw) -> list:
    if raw is None:
        return []
    if not isinstance(raw, (list, tuple)) or len(raw) not in DISTORTION_MODELS:
        raise FitError("CAMERA_FIT_INPUT_INVALID",
                       f"intrinsics.distortion 必须是长度 {sorted(DISTORTION_MODELS)} 的数组"
                       "（OpenCV 的 k1,k2,p1,p2[,k3[,k4,k5,k6[,s1,s2,s3,s4[,tauX,tauY]]]]）",
                       field="intrinsics.distortion")
    out = []
    for item in raw:
        number = float(item)
        if not math.isfinite(number):
            raise FitError("CAMERA_FIT_INPUT_INVALID", "intrinsics.distortion 里有非有限值", field="intrinsics.distortion")
        out.append(number)
    return out


def _focal_from_vanishing_points(raw: dict, cx: float, cy: float):
    """两两正交方向的消失点各给一条 f 的约束：f² = -[(u₁-cx)(u₂-cx)+(v₁-cy)(v₂-cy)]。

    主点假设在图像中心（写进 assumptions）；≥2 组正交对才估计（少于此不可辨识）。
    """
    entries = raw.get("directions")
    if not isinstance(entries, list) or len(entries) < 2:
        raise FitError("CAMERA_FIT_INPUT_INVALID",
                       "lens.directions 至少两对（世界方向 + 像素消失点），且其中至少两对对世界方向正交",
                       field="lens.directions")
    directions = []
    for index, item in enumerate(entries):
        if not isinstance(item, dict):
            raise FitError("CAMERA_FIT_INPUT_INVALID", f"lens.directions[{index}] 必须是对象", field="lens.directions")
        world = _finite3(item.get("world"), f"lens.directions[{index}].world")
        pixel = _finite2(item.get("pixel"), f"lens.directions[{index}].pixel")
        norm = math.sqrt(sum(v * v for v in world))
        if norm <= 0:
            raise FitError("CAMERA_FIT_INPUT_INVALID",
                           f"lens.directions[{index}].world 是零向量，方向无意义", field="lens.directions")
        directions.append({"world": [v / norm for v in world], "pixel": pixel,
                           "label": str(item.get("label", f"d{index + 1}"))})
    estimates, pairs, skipped = [], [], []
    for i in range(len(directions)):
        for j in range(i + 1, len(directions)):
            a, b = directions[i], directions[j]
            cos = sum(a["world"][k] * b["world"][k] for k in range(3))
            if abs(cos) > 1e-6:
                skipped.append({"pair": [a["label"], b["label"]], "worldAngleDeg": r(math.degrees(math.acos(max(-1.0, min(1.0, cos))))),
                                "reason": "世界方向不正交，给不出 f 的约束"})
                continue
            value = -((a["pixel"][0] - cx) * (b["pixel"][0] - cx) + (a["pixel"][1] - cy) * (b["pixel"][1] - cy))
            if value <= 0:
                skipped.append({"pair": [a["label"], b["label"]], "fSquared": r(value, 6),
                                "reason": "该正交对与主点假设矛盾（f²<=0）：消失点像素或主点假设有问题"})
                continue
            estimates.append(math.sqrt(value))
            pairs.append({"pair": [a["label"], b["label"]], "focalPx": r(math.sqrt(value), 6)})
    if len(estimates) < 2:
        raise FitError("CAMERA_FIT_LENS_UNIDENTIFIABLE",
                       f"从消失点只得到 {len(estimates)} 条可用约束，至少需要 2 条正交对才能估计焦距；"
                       "请多给一组正交方向，或直接给已知 K（intrinsics）",
                       pairs=pairs, skipped=skipped)
    focal = sum(estimates) / len(estimates)
    spread = max(estimates) - min(estimates)
    orthogonality = []
    for i in range(len(directions)):
        for j in range(i + 1, len(directions)):
            a, b = directions[i], directions[j]
            va = [(a["pixel"][0] - cx) / focal, (a["pixel"][1] - cy) / focal, 1.0]
            vb = [(b["pixel"][0] - cx) / focal, (b["pixel"][1] - cy) / focal, 1.0]
            dot = sum(va[k] * vb[k] for k in range(3))
            na = math.sqrt(sum(v * v for v in va))
            nb = math.sqrt(sum(v * v for v in vb))
            orthogonality.append({"pair": [a["label"], b["label"]],
                                  "cosine": r(dot / (na * nb), 9)})
    return focal, {"constraints": pairs, "usedPairs": len(estimates), "skippedPairs": skipped,
                   "focalSpreadPx": r(spread, 6), "orthogonalityResidual": orthogonality}


def build_intrinsics(request: dict):
    """→ (intrinsics dict, meta dict)。meta 说明来源、假设与"这是不是实测标定"。"""
    known = request.get("intrinsics")
    lens = request.get("lens")
    if known is not None and lens is not None:
        raise FitError("CAMERA_FIT_INPUT_INVALID",
                       "intrinsics 与 lens 只能给一个：已知 K（实测标定）与按镜头/消失点的估计是两条不同的路径",
                       field="intrinsics|lens")
    if known is not None:
        if not isinstance(known, dict):
            raise FitError("CAMERA_FIT_INPUT_INVALID", "intrinsics 必须是对象", field="intrinsics")
        base = _intrinsics_from_known(known)
        distortion = _distortion_of(known.get("distortion"))
        meta = {"source": "caller-k", "estimated": False,
                "assumptions": ["内参由调用方给出（已知 K），本工具不做标定、不改内参"],
                "calibrated": True,
                "distortionGiven": bool(distortion)}
        return {**base, "distortion": distortion}, meta
    if lens is None:
        raise FitError("CAMERA_FIT_INTRINSICS_REQUIRED",
                       "必须给 intrinsics（已知 K：fx/fy/cx/cy/width/height）或 lens（按镜头 FOV、"
                       "传感器尺寸、消失点、或带理由的焦距假设）；本工具不默认一个焦距当真值",
                       fields=["intrinsics", "lens"])
    if not isinstance(lens, dict):
        raise FitError("CAMERA_FIT_INPUT_INVALID", "lens 必须是对象", field="lens")
    kind = lens.get("kind")
    if kind not in ("fov", "sensor", "vanishing-points", "assumed-focal-px"):
        raise FitError("CAMERA_FIT_INPUT_INVALID",
                       "lens.kind 只能是 fov|sensor|vanishing-points|assumed-focal-px（收到 "
                       f"{kind!r}）", field="lens.kind")
    if kind == "assumed-focal-px":
        rationale = lens.get("rationale")
        if not isinstance(rationale, str) or not rationale.strip():
            raise FitError("CAMERA_FIT_INPUT_INVALID",
                           "lens.kind=\"assumed-focal-px\" 必须带 rationale（说明这个焦距从哪来）；"
                           "没有理由的固定焦距不是估计，工具不接受", field="lens.rationale")

    def positive(name: str) -> float:
        value = lens.get(name)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)) or float(value) <= 0:
            raise FitError("CAMERA_FIT_INPUT_INVALID", f"lens.{name} 必须是正数（收到 {value!r}）",
                           field=f"lens.{name}")
        return float(value)

    width, height = positive("width"), positive("height")
    if width <= 1 or height <= 1:
        raise FitError("CAMERA_FIT_INPUT_INVALID", f"lens.width/height 必须 > 1（收到 {width}/{height}）",
                       field="lens.width")
    cx = lens.get("cx", (width - 1) / 2.0)
    cy = lens.get("cy", (height - 1) / 2.0)
    principal_given = "cx" in lens or "cy" in lens
    if kind == "fov":
        vertical = lens.get("fovDegVertical")
        horizontal = lens.get("fovDegHorizontal")
        if (vertical is None) == (horizontal is None) and (vertical is None or horizontal is None):
            raise FitError("CAMERA_FIT_INPUT_INVALID",
                           "lens.kind=\"fov\" 必须给 fovDegVertical 或 fovDegHorizontal 之一", field="lens.kind")
        if vertical is not None:
            angle = positive("fovDegVertical")
            if not 0 < angle < 180:
                raise FitError("CAMERA_FIT_INPUT_INVALID", f"lens.fovDegVertical 必须在 (0,180)（收到 {angle}）",
                               field="lens.fovDegVertical")
            fy = height / (2.0 * math.tan(math.radians(angle) / 2.0))
            fx = fy
            derivation = f"fy = height / (2·tan(fovY/2)) = {r(fy, 6)} px；方形像素假设 fx = fy"
        else:
            angle = positive("fovDegHorizontal")
            if not 0 < angle < 180:
                raise FitError("CAMERA_FIT_INPUT_INVALID", f"lens.fovDegHorizontal 必须在 (0,180)（收到 {angle}）",
                               field="lens.fovDegHorizontal")
            fx = width / (2.0 * math.tan(math.radians(angle) / 2.0))
            fy = fx
            derivation = f"fx = width / (2·tan(fovX/2)) = {r(fx, 6)} px；方形像素假设 fy = fx"
        meta = {"source": "lens-fov", "estimated": True, "calibrated": False,
                "assumptions": [f"镜头视场 {r(angle, 4)}° 由调用方给出（镜头规格/EXIF/已知实测，非本工具测量）",
                                "方形像素（fx = fy）",
                                derivation,
                                "主点按像素中心 (width-1)/2,(height-1)/2" if not principal_given
                                else "主点由调用方给出"],
                "derivation": derivation}
    elif kind == "sensor":
        focal_mm = positive("focalLengthMm")
        sensor_mm = positive("sensorWidthMm")
        fx = focal_mm / sensor_mm * width
        fy = fx
        meta = {"source": "lens-sensor", "estimated": True, "calibrated": False,
                "assumptions": [f"焦距 {focal_mm} mm、传感器宽 {sensor_mm} mm 由调用方给出（规格值）",
                                "传感器宽度方向占满画面（sensor_fit=HORIZONTAL，与 Blender AUTO 在宽≥高时一致）",
                                "方形像素（fx = fy）", "无畸变",
                                "主点按像素中心 (width-1)/2,(height-1)/2" if not principal_given
                                else "主点由调用方给出"],
                "derivation": f"fx = focalMm / sensorWidthMm · width = {r(fx, 6)} px；fy = fx"}
    elif kind == "vanishing-points":
        focal, detail = _focal_from_vanishing_points(lens, cx, cy)
        fx = focal
        fy = focal
        meta = {"source": "lens-vanishing-points", "estimated": True, "calibrated": False,
                "assumptions": ["主点在图像中心（消失点只约束焦距，不约束主点）",
                                "方形像素（fx = fy）",
                                "给消失点的世界方向是正交的（非正交对不参与，见 constraints.skippedPairs）",
                                "消失点像素由调用方给出（本工具不检测消失点）"],
                "derivation": f"f² = -[(u₁-cx)(u₂-cx)+(v₁-cy)(v₂-cy)] 逐正交对求解后取均值：f = {r(focal, 6)} px",
                "vanishingPoints": detail}
    else:  # assumed-focal-px
        focal = positive("focalPx")
        fx = focal
        fy = focal
        meta = {"source": "lens-assumed-focal-px", "estimated": True, "calibrated": False,
                "assumptions": [f"焦距 {r(focal, 6)} px 是**假设**，理由（调用方给出）：{lens['rationale'].strip()}",
                                "方形像素（fx = fy）", "无畸变",
                                "主点按像素中心 (width-1)/2,(height-1)/2" if not principal_given
                                else "主点由调用方给出"],
                "derivation": "fx = fy = 调用方假设的焦距（不是本工具测量或估计的结果）"}
    distortion = _distortion_of(lens.get("distortion"))
    if distortion:
        meta["assumptions"].append("畸变系数由调用方给出（无 K 场景下畸变未与本工具一并标定）")
    meta["distortionGiven"] = bool(distortion)
    return {"fx": fx, "fy": fy, "cx": float(cx), "cy": float(cy), "width": width, "height": height,
            "distortion": distortion}, meta


# ---------------------------------------------------------------------------
# 几何可辨识性：共线（秩 1）不可解；共面（秩 2）有两解，必须给出间隔
# ---------------------------------------------------------------------------
def rank_analysis(points) -> dict:
    """SVD 相对奇异值判秩：秩 1=共线，秩 2=共面。近共线/近共面另给警告（病态）。"""
    import numpy as np

    array = np.asarray(points, dtype=float)
    if len(array) < 2:
        return {"rank": 0 if len(array) == 0 else 1, "singularValuesRelative": [1.0], "collinear": len(array) < 2}
    centered = array - array.mean(axis=0)
    singular = np.linalg.svd(centered, compute_uv=False)
    scale = float(singular[0]) if singular[0] > 0 else 1.0
    relative = [float(value) / scale for value in singular]
    rank = int(sum(1 for value in relative if value > COLLINEAR_RATIO))
    return {"rank": rank, "singularValuesRelative": vec(relative, 9),
            "collinear": rank <= 1, "planar": rank <= 2,
            "nearCollinear": bool(rank >= 2 and relative[1] < NEAR_DEGENERATE_RATIO),
            "nearPlanar": bool(rank == 3 and relative[2] < NEAR_DEGENERATE_RATIO)}


# ---------------------------------------------------------------------------
# 求解
# ---------------------------------------------------------------------------
# OpenCV 相机系（x 右、y 下、z 朝前，p_cv = R·X + t，深度 = z）与产品约定
# （x 右、y 上、看向 -z，world = R_p·p_p + t_p，见 sim-mujoco worker.py 的 camera calibration）
# 之间差一个 F = diag(1,-1,-1)：p_cv = F·p_p。
# cv2 只会算 OpenCV 系，所以**解出来必须显式换算**：
#     R_p = R_cv^T · F        t_p = -R_cv^T · t_cv
# 为什么这条不能省：像素投影对"镜像相机"不变（同一组像素、所有点在背后），
# 于是漏掉这一步时重投影残差**照样很小**，报出去的位姿却是错的——低残差掩盖错位姿。
CV_PRODUCT_FLIP = ((1.0, 0.0, 0.0), (0.0, -1.0, 0.0), (0.0, 0.0, -1.0))


def product_pose_from_cv(rotation, translation):
    """OpenCV 相机系位姿 → 产品约定的 (rotationMatrix, positionM)：R_p = R_cv^T·F，t_p = -R_cv^T·t_cv。

    t_p 就是相机中心在世界系里的位置（对应 world = R_p·p_p + t_p 里的 t）。
    """
    import numpy as np

    rotation = np.asarray(rotation, dtype=float).reshape(3, 3)
    translation = np.asarray(translation, dtype=float).reshape(3)
    return rotation.T @ np.asarray(CV_PRODUCT_FLIP, dtype=float), -rotation.T @ translation


def _matrix_to_quaternion(rotation) -> list:
    """R（列=相机轴在世界系）→ 四元数 [x,y,z,w]，Shepperd 分支法（分支按最大对角元，数值稳定）。"""
    import numpy as np

    m = np.asarray(rotation, dtype=float)
    trace = float(m[0, 0] + m[1, 1] + m[2, 2])
    if trace > 0:
        s = math.sqrt(trace + 1.0) * 2.0
        w = 0.25 * s
        x = (m[2, 1] - m[1, 2]) / s
        y = (m[0, 2] - m[2, 0]) / s
        z = (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2.0
        w = (m[2, 1] - m[1, 2]) / s
        x = 0.25 * s
        y = (m[0, 1] + m[1, 0]) / s
        z = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2.0
        w = (m[0, 2] - m[2, 0]) / s
        x = (m[0, 1] + m[1, 0]) / s
        y = 0.25 * s
        z = (m[1, 2] + m[2, 1]) / s
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2.0
        w = (m[1, 0] - m[0, 1]) / s
        x = (m[0, 2] + m[2, 0]) / s
        y = (m[1, 2] + m[2, 1]) / s
        z = 0.25 * s
    quaternion = [x, y, z, w]
    if w < 0:  # 统一半球（旋转矩阵→四元数在 ±q 之间二义，取 w>=0 的一支）
        quaternion = [-value for value in quaternion]
    norm = math.sqrt(sum(value * value for value in quaternion))
    return [value / norm for value in quaternion]


def _rotation_angle_between(a, b) -> float:
    """两个旋转矩阵之间的夹角（度）。"""
    import numpy as np

    relative = np.asarray(a, dtype=float).T @ np.asarray(b, dtype=float)
    trace = float(relative[0, 0] + relative[1, 1] + relative[2, 2])
    cosine = max(-1.0, min(1.0, (trace - 1.0) / 2.0))
    return math.degrees(math.acos(cosine))


def project_points(object_points, rvec, tvec, camera_matrix, distortion):
    """→ (uv, in_front)：uv 是像素（左上原点、u 右 v 下），in_front 表示点在相机前方（深度 > 0）。

    这里收发的 rvec/tvec 是 **OpenCV 相机系**的解（cv2 的原生口径：p_cv = R·X + t，深度 = z > 0）。
    产品约定的位姿由 product_pose_from_cv 换算；两种口径不在同一个函数里混用。
    """
    import cv2
    import numpy as np

    object_array = np.asarray(object_points, dtype=np.float64)
    image_points, _ = cv2.projectPoints(object_array, rvec, tvec, camera_matrix, distortion)
    uv = image_points.reshape(-1, 2)
    rotation = cv2.Rodrigues(rvec)[0]
    camera_space = (rotation @ object_array.T + np.asarray(tvec, dtype=float).reshape(3, 1)).T
    return uv, camera_space[:, 2] > 0


def _residual_rows(ids, world, observed, predicted, in_front, outlier_flags=None, metric=True):
    rows = []
    for index, name in enumerate(ids):
        du = float(predicted[index][0] - observed[index][0])
        dv = float(predicted[index][1] - observed[index][1])
        row = {"id": name,
               **position_fields("world", world[index], metric),
               "observedPx": vec(observed[index], PIXEL_DIGITS),
               "predictedPx": vec(predicted[index], PIXEL_DIGITS),
               "residualPx": [r(du, PIXEL_DIGITS), r(dv, PIXEL_DIGITS)],
               "distancePx": r(math.hypot(du, dv), PIXEL_DIGITS),
               "inFrontOfCamera": bool(in_front[index])}
        if outlier_flags is not None:
            row["outlier"] = bool(outlier_flags[index])
        rows.append(row)
    return rows


def _stats(rows) -> dict:
    """只用相机前方、且非离群的点算统计（背后的点残差没有意义，离群点另外列）。"""
    used = [row for row in rows if row["inFrontOfCamera"] and not row.get("outlier", False)]
    excluded_front = sum(1 for row in rows if not row["inFrontOfCamera"])
    excluded_outlier = sum(1 for row in rows if row.get("outlier", False))
    if not used:
        return {"count": 0, "usedForStats": 0, "rmsPx": None, "maxPx": None, "medianPx": None,
                "behindCamera": excluded_front, "outliers": excluded_outlier}
    distances = sorted(row["distancePx"] for row in used)
    rms = math.sqrt(sum(value * value for value in distances) / len(distances))
    median = distances[len(distances) // 2] if len(distances) % 2 == 1 else \
        0.5 * (distances[len(distances) // 2 - 1] + distances[len(distances) // 2])
    return {"count": len(rows), "usedForStats": len(used), "rmsPx": r(rms, PIXEL_DIGITS),
            "maxPx": r(distances[-1], PIXEL_DIGITS), "medianPx": r(median, PIXEL_DIGITS),
            "behindCamera": excluded_front, "outliers": excluded_outlier}


def _solve_initial(object_points, image_points, camera_matrix, distortion):
    """初始解：点数≥6 用 ITERATIVE（OpenCV 5 内部 DLT 需要 ≥6），4–5 点用 SQPNP（失败退 EPNP）。"""
    import cv2

    attempts = []
    candidates = []
    if len(object_points) >= 6:
        candidates.append(("SOLVEPNP_ITERATIVE", cv2.SOLVEPNP_ITERATIVE))
    candidates.append(("SOLVEPNP_SQPNP", cv2.SOLVEPNP_SQPNP))
    candidates.append(("SOLVEPNP_EPNP", cv2.SOLVEPNP_EPNP))
    for name, flag in candidates:
        try:
            ok, rvec, tvec = cv2.solvePnP(object_points, image_points, camera_matrix, distortion, flags=flag)
            attempts.append({"backend": name, "ok": bool(ok)})
            if ok:
                return (rvec, tvec), name, attempts
        except cv2.error as error:
            attempts.append({"backend": name, "ok": False,
                             "error": str(error).strip().splitlines()[-1][:200]})
    raise FitError("CAMERA_FIT_SOLVER_FAILED",
                   "OpenCV 的 PnP 求解器都没能给出解（点数/几何可能退化）",
                   attempts=attempts)


def _ransac(object_points, image_points, camera_matrix, distortion, options):
    """RANSAC 初筛外点：用 EPNP（对任意构型都不抛异常）。返回 (rvec, tvec, inlier_mask) 或 None。"""
    import cv2
    import numpy as np

    threshold = options["reprojectionThresholdPx"]
    iterations = options["iterations"]
    confidence = options["confidence"]
    try:
        ok, rvec, tvec, inliers = cv2.solvePnPRansac(
            object_points, image_points, camera_matrix, distortion,
            iterationsCount=iterations, reprojectionError=threshold, confidence=confidence,
            flags=cv2.SOLVEPNP_EPNP)
    except cv2.error as error:
        return None, {"enabled": True, "ok": False, "thresholdPx": threshold, "iterations": iterations,
                      "confidence": confidence, "error": str(error).strip().splitlines()[-1][:200]}
    if not ok or inliers is None or len(inliers) < MIN_FIT_POINTS:
        return None, {"enabled": True, "ok": False, "thresholdPx": threshold, "iterations": iterations,
                      "confidence": confidence,
                      "inliers": 0 if inliers is None else int(len(inliers)),
                      "note": f"RANSAC 没找到 {MIN_FIT_POINTS} 个以上一致点"}
    mask = np.zeros(len(object_points), dtype=bool)
    mask[np.asarray(inliers).reshape(-1).astype(int)] = True
    return (rvec, tvec, mask), {"enabled": True, "ok": True, "thresholdPx": threshold,
                                "iterations": iterations, "confidence": confidence,
                                "inliers": int(mask.sum()), "outliers": int((~mask).sum())}


def solve_pose(fit_world, fit_pixel, camera_matrix, distortion, options, geometry):
    """完整求解链：RANSAC（可选）→ 初解 → LM 精化。返回的是 **OpenCV 相机系**的 (rvec, tvec, R, mask, meta)。

    世界点按产品约定（米、Z-up）原样送进 cv2——世界系不需要换，换的是回来的**相机系**；
    换算在 build_report 里由 product_pose_from_cv 显式完成，别在别处偷偷假设某一种口径。
    """
    import cv2
    import numpy as np

    cv2.setRNGSeed(int(options["seed"]))
    object_points = np.asarray(fit_world, dtype=np.float64)
    image_points = np.asarray(fit_pixel, dtype=np.float64).reshape(-1, 1, 2)
    count = len(object_points)
    solver = {"inputPoints": count, "refined": False, "attempts": [], "seed": int(options["seed"])}

    want_ransac = options["ransac"] == "auto" and count >= 6 or options["ransac"] is True
    if options["ransac"] is True and count < MIN_FIT_POINTS + 1:
        want_ransac = False
        solver["notes"] = ["点数不足以做 RANSAC（至少 5 个 fit 点），已直接求解"]
    mask = None
    solver["ransac"] = None
    if want_ransac:
        found, meta = _ransac(object_points, image_points, camera_matrix, distortion, options)
        solver["ransac"] = meta
        if found is None:
            if meta.get("ok") is False and meta.get("inliers") == 0 and count >= 6:
                raise FitError("CAMERA_FIT_RANSAC_FAILED",
                               "RANSAC 找不到一致子集：对应点里没有 ≥4 个互相一致的点（错点太多或内参不对）",
                               ransac=meta, points=count)
            solver["notes"] = (solver.get("notes", []) or []) + ["RANSAC 不可用，退回全点求解"]
        else:
            mask = found[2]
    if mask is None:
        (rvec, tvec), backend, attempts = _solve_initial(object_points, image_points,
                                                         camera_matrix, distortion)
    else:
        rvec, tvec = found[0], found[1]
        backend = "SOLVEPNP_EPNP+RANSAC"
        attempts = [{"backend": backend, "ok": True}]
        if int(mask.sum()) < count:
            # 用内点重解一次：RANSAC 报出的位姿是在它挑中的子集上算的，重解让初值来自全部内点。
            (rvec, tvec), backend, extra = _solve_initial(object_points[mask], image_points[mask],
                                                          camera_matrix, distortion)
            attempts = attempts + extra
    solver["attempts"] = attempts
    solver["backend"] = backend
    if options["refine"]:
        subset = slice(None) if mask is None else mask
        try:
            rvec, tvec = cv2.solvePnPRefineLM(object_points[subset], image_points[subset],
                                              camera_matrix, distortion, rvec, tvec)
            solver["refined"] = True
            solver["backend"] = backend + "+solvePnPRefineLM"
        except cv2.error as error:
            solver["refineError"] = str(error).strip().splitlines()[-1][:200]
    rotation = cv2.Rodrigues(rvec)[0]
    return rvec, tvec, rotation, mask, solver


def planar_two_solutions(object_points, image_points, camera_matrix, distortion):
    """共面点集的 IPPE 两解（歧义证据），位姿已换算到产品约定。IPPE 只对共面点有意义；不适用时返回 None。"""
    import cv2
    import numpy as np

    try:
        count, rotations, translations, errors = cv2.solvePnPGeneric(
            np.asarray(object_points, dtype=np.float64),
            np.asarray(image_points, dtype=np.float64).reshape(-1, 1, 2),
            camera_matrix, distortion, flags=cv2.SOLVEPNP_IPPE)
    except cv2.error as error:
        return None, str(error).strip().splitlines()[-1][:200]
    solutions = []
    for index in range(int(count)):
        cv_rotation = rotations[index] if rotations[index].shape == (3, 3) else cv2.Rodrigues(rotations[index])[0]
        rotation, position = product_pose_from_cv(cv_rotation, translations[index])
        solutions.append({"worldFromCamera": {"positionM": position.tolist(),
                                              "rotationMatrix": rotation.tolist()},
                          "reprojectionRmsPx": float(np.ravel(errors)[index]) if len(np.ravel(errors)) > index else None})
    return solutions, None


# ---------------------------------------------------------------------------
# 报告
# ---------------------------------------------------------------------------
def position_fields(name: str, values, metric: bool, digits: int = DIGITS) -> dict:
    """按"尺度是否确定"给位置字段命名：**只有**米制确定时才给 `M` 后缀。

    为什么不能只靠一条 warning：读数会被 53/Blender 直接喂进"场景单位=米"的地方，字段名里的 M
    就是最强的暗示（warning 会被过滤、会被摘要吃掉）。尺度未知时只出 `…InputUnits`。
    """
    return {(name + "M") if metric else (name + "InputUnits"): vec(values, digits)}


def blender_view_plane(sensor_fit: str, lens_mm: float, sensor_width_mm: float, sensor_height_mm: float,
                       width: int, height: int, pixel_aspect_x: float = 1.0, pixel_aspect_y: float = 1.0,
                       shift_x: float = 0.0, shift_y: float = 0.0) -> dict:
    """Blender 相机画幅（`camera.data.view_frame`）的解析模型——**不是**"想象中"的相机模型。

    逐条对着真实 Blender 5.2.2 的 view_frame 反推并核对过（夹具脚本的 `model_delta`、
    回灌脚本的 `kInBlender`）：

    · 装 fit 轴（HORIZONTAL→x；VERTICAL→y；AUTO→按 pixel_aspect 修正后的画幅长短边选）在距离
      |z| = lens/传感器尺寸 处张成 ±0.5，另一轴按**修正后**的画幅比例取半宽；
    · AUTO 只读 sensor_width（**竖幅也是**：AUTO 下 sensor_height 完全不参与）；显式 VERTICAL 才用 sensor_height；
    · shift_x/shift_y 都按"fit 轴全长 = 1"的单位平移画幅（横竖幅同单位，所以竖幅的 shift_x 也按高度算）；
    · pixel_aspect 改的是画幅比例：fy/fx = pixel_aspect_x / pixel_aspect_y。

    返回画幅四边（相机系、z<0）与平面距离 |z|。
    """
    aspect_x = width * pixel_aspect_x
    aspect_y = height * pixel_aspect_y
    if sensor_fit == "VERTICAL":
        axis, sensor_mm = "y", sensor_height_mm
    elif sensor_fit == "AUTO":
        axis, sensor_mm = ("x" if aspect_x >= aspect_y else "y"), sensor_width_mm
    else:
        axis, sensor_mm = "x", sensor_width_mm
    if axis == "x":
        half_x, half_y = 0.5, 0.5 * aspect_y / aspect_x
    else:
        half_x, half_y = 0.5 * aspect_x / aspect_y, 0.5
    return {"left": -half_x + shift_x, "right": half_x + shift_x,
            "bottom": -half_y + shift_y, "top": half_y + shift_y,
            # view_frame 把画幅放在 z = -(lens/传感器尺寸) 上（真机量出来的），不是"传感器尺寸/焦距"。
            "distance": lens_mm / sensor_mm, "fitAxis": axis, "sensorMm": sensor_mm}


def blender_intrinsics_from_parameters(parameters: dict) -> dict:
    """把一组 Blender 参数反推成像素内参 K（**像素中心口径**：u = fx·x/z + cx，主点在 (width-1)/2）。

    这就是"这组参数到底画成什么画面"的定义式；回灌脚本会拿真实 Blender 的 view_frame 再算一遍对账。
    """
    width = int(parameters["resolutionPx"]["width"])
    height = int(parameters["resolutionPx"]["height"])
    plane = blender_view_plane(parameters["sensorFit"], parameters["lensMm"],
                               parameters["sensorWidthMm"], parameters.get("sensorHeightMm",
                                                                           BLENDER_SENSOR_HEIGHT_MM),
                               width, height, parameters["pixelAspect"]["x"], parameters["pixelAspect"]["y"],
                               parameters["shiftX"], parameters["shiftY"])
    depth = plane["distance"]
    fx = width * depth / (plane["right"] - plane["left"])
    fy = height * depth / (plane["top"] - plane["bottom"])
    # view_frame 把画面边缘映到 u∈[0,width]（连续坐标）；像素**索引**口径要再减 0.5。
    cx = -plane["left"] * width / (plane["right"] - plane["left"]) - 0.5
    cy = plane["top"] * height / (plane["top"] - plane["bottom"]) - 0.5
    return {"fx": fx, "fy": fy, "cx": cx, "cy": cy, "width": width, "height": height,
            "viewPlane": {key: plane[key] for key in ("left", "right", "bottom", "top", "distance",
                                                      "fitAxis", "sensorMm")}}


def blender_parameters(intrinsics: dict, sensor_width_mm: float = BLENDER_SENSOR_WIDTH_MM,
                       sensor_height_mm: float = BLENDER_SENSOR_HEIGHT_MM) -> dict:
    """已知 K → 能**真正复现这台相机**的 Blender 参数（不含位姿）。

    反解用的是 sensorFit='HORIZONTAL'：fit 轴固定成 x，于是
      lens 由 fx 定（fx = width·lens/sensor_width），
      fy/fx 由 pixel_aspect 定（fy = fx·pixel_aspect_x/pixel_aspect_y），
      主点由 shift_x/shift_y 定（shift 是 fit 轴全长=1 的单位）。
    另一个能用的组合是 fit=VERTICAL + sensor_height，但不需要两套，固定一套更不容易装错；
    非方形像素是**真的**用 render.pixel_aspect 表达，不是忽略差异。
    """
    width, height = int(intrinsics["width"]), int(intrinsics["height"])
    fx, fy = float(intrinsics["fx"]), float(intrinsics["fy"])
    cx, cy = float(intrinsics["cx"]), float(intrinsics["cy"])
    if fy <= 0 or fx <= 0:
        raise FitError("CAMERA_FIT_INTRINSICS_INVALID", f"fx/fy 必须是正数（收到 fx={fx}, fy={fy}）")
    ratio = fy / fx                                     # = pixel_aspect_x / pixel_aspect_y
    if ratio >= 1.0:
        aspect_x, aspect_y = ratio, 1.0
    else:
        aspect_x, aspect_y = 1.0, 1.0 / ratio
    low, high = BLENDER_PIXEL_ASPECT_RANGE
    clamped = not (low <= aspect_x <= high and low <= aspect_y <= high)
    aspect_x = min(max(aspect_x, low), high)
    aspect_y = min(max(aspect_y, low), high)
    lens_mm = fx * sensor_width_mm / width
    shift_x = 0.5 - (cx + 0.5) / width
    shift_y = (cy + 0.5 - height / 2.0) * (aspect_y / aspect_x) / width
    return {"sensorFit": "HORIZONTAL", "lensMm": lens_mm, "sensorWidthMm": sensor_width_mm,
            "sensorHeightMm": sensor_height_mm, "shiftX": shift_x, "shiftY": shift_y,
            "resolutionPx": {"width": width, "height": height},
            "pixelAspect": {"x": aspect_x, "y": aspect_y}, "pixelAspectClamped": bool(clamped)}


def _blender_adapter(position, quaternion, intrinsics, fov, metric: bool,
                     sensor_width_mm: float = BLENDER_SENSOR_WIDTH_MM):
    """Blender 相机：局部轴 +X 右／+Y 上／-Z 朝前与合同一致，所以位置/四元数直接可用。

    内参必须给**全套**参数才能复现：sensorFit + lens/sensor + shift_x/y + pixel_aspect + 分辨率。
    只写 lens/sensor 会得到一台"主点在画面中心、方形像素"的相机——已知 K 非居中（裁切照片常见）
    或 fx≠fy 时，那样装出来的机位会把画面里的点整体挪走几十到几百像素。
    """
    parameters = blender_parameters(intrinsics, sensor_width_mm)
    reproduced = blender_intrinsics_from_parameters(parameters)
    error = {key: abs(reproduced[key] - float(intrinsics[key])) for key in ("fx", "fy", "cx", "cy")}
    square = abs(intrinsics["fx"] - intrinsics["fy"]) <= 1e-9 * max(1.0, abs(intrinsics["fx"]))
    adapter = {
        **position_fields("location", position, metric),
        # 位置数值的尺度：与 camera.metric / viewer.units.metric 同一件事，别让消费者从字段名猜。
        "metric": bool(metric),
        "rotationQuaternionXyzw": vec(quaternion),
        "rotationMode": "QUATERNION",
        "note": "Blender 相机局部轴（+X 右／+Y 上／-Z 朝前）与合同 camera x 右／y 上／看 -z 同构："
                "位置与四元数可直接写进相机对象，不需要再乘任何翻转矩阵。"
                "但内参不是一个 lens 就装完的：resolutionPx + pixelAspect + shiftX/shiftY + sensorFit + "
                "lensMm/sensorWidthMm 要**一起**装（见 requires），否则主点会回到画面正中、像素会变方形。",
        "sensorFit": parameters["sensorFit"],
        "lensMm": r(parameters["lensMm"], 9),
        "sensorWidthMm": r(parameters["sensorWidthMm"], 9),
        "sensorHeightMm": r(parameters["sensorHeightMm"], 9),
        "sensorHeightNote": "sensorFit=HORIZONTAL 时 Blender 只用 sensor_width：sensor_height 是 Blender 的"
                            "默认值，改它不影响画面；垂直视场由 resolutionPx + pixelAspect 决定。",
        "shiftX": r(parameters["shiftX"]),
        "shiftY": r(parameters["shiftY"]),
        "resolutionPx": parameters["resolutionPx"],
        "pixelAspect": {"x": r(parameters["pixelAspect"]["x"]), "y": r(parameters["pixelAspect"]["y"])},
        "pixelAspectClamped": parameters["pixelAspectClamped"],
        # camera.data.angle 是 sensor_fit 轴上的视场角：这里 fit 轴固定为 x，所以它就是水平视场角。
        "angleDeg": r(fov["horizontalDeg"]),
        "fovXDeg": r(fov["horizontalDeg"]),
        "fovYDeg": r(fov["verticalDeg"]),
        "squarePixels": bool(square),
        "resolvesIntrinsics": {key: r(reproduced[key]) for key in ("fx", "fy", "cx", "cy")},
        "intrinsicsReproductionErrorPx": {**{key: r(value, PIXEL_DIGITS) for key, value in error.items()},
                                          "max": r(max(error.values()), PIXEL_DIGITS)},
        "requires": ["scene.render.resolution_x/resolution_y = resolutionPx",
                     "scene.render.pixel_aspect_x/pixel_aspect_y = pixelAspect",
                     "camera.data.sensor_fit = sensorFit",
                     "camera.data.lens = lensMm", "camera.data.sensor_width = sensorWidthMm",
                     "camera.data.shift_x/shift_y = shiftX/shiftY"],
        "noteSquarePixels": (
            "fx=fy（方形像素）：pixelAspect=1/1，lens 由 fx 定，主点由 shift 定（即使主点居中，"
            "shift 也常常是非零的小量：像素中心口径下居中主点是 (width-1)/2，不是 width/2）。"
            if square else
            f"fx≠fy：用 render.pixel_aspect={parameters['pixelAspect']['x']:.6g}/"
            f"{parameters['pixelAspect']['y']:.6g} **真实表达**非方形像素（fy = fx·pax/pay），"
            "不是忽略差异；回灌脚本会用真实 Blender 重渲染核对。"),
    }
    if parameters["pixelAspectClamped"]:
        adapter["noteSquarePixels"] += ("；警告：fy/fx 超出 Blender pixel_aspect 可用范围 "
                                        f"{BLENDER_PIXEL_ASPECT_RANGE}，已截断，这组参数复现不出原 K"
                                        "（残差见 intrinsicsReproductionErrorPx）")
    return adapter


def _viewer_adapter(position, quaternion, intrinsics, fov, rotation, metric: bool, depths):
    """原生 Viewer（three.js PerspectiveCamera）：位置/四元数直接写；fov 是**垂直**视场角。

    三件必须说清的事：
    1. 相机的真实 up 由 R 决定（含 roll），**不是**世界 up [0,0,1]：`OrbitControls.update()` 会用
       `camera.up` + target 重算 lookAt，把拟合出来的 roll 抹掉。要保住 roll 就得把 camera.up 设成
       cameraUp（或干脆不调 update）。这里把 cameraUp/forward/target/rollDeg 全给出来，别让调用方自己猜。
    2. 本读数走的是 three.js 的**普通装配路径**（`PerspectiveCamera.fov` + `.aspect`，主点用
       setViewOffset 表达）：这个接口的前提是方形像素、单一 fov，所以 fx≠fy 在这条路径里表达不了
       ——于是不声称"一条 fov 就能复现 K"，而是给出这条路径下残余像素误差的上界。
       这是**接口**的限制，不是 three.js 整体做不到：直接给 `camera.projectionMatrix`（fx/fy 各轴
       各一个量）或用 setViewOffset 的整幅适配法都能精确装出非方形像素（66 候选的 Viewer 侧已实现，
       见 squarePixelModel.note）。要用精确 K 就走那条路，别只照抄这里的 fov 参数。
    3. 位置数值的尺度：worldUnit=unknown 时**不是米**（见 units）。
    """
    width, height = int(intrinsics["width"]), int(intrinsics["height"])
    centre_x = (width - 1) / 2.0
    centre_y = (height - 1) / 2.0
    offset_x = intrinsics["cx"] - centre_x
    offset_y = intrinsics["cy"] - centre_y
    square = abs(intrinsics["fx"] - intrinsics["fy"]) <= 1e-9 * max(1.0, abs(intrinsics["fx"]))
    camera_up = [float(rotation[row][1]) for row in range(3)]
    forward = [-float(rotation[row][2]) for row in range(3)]
    # roll：把**世界 up**投到像平面（⊥ forward 的平面）上，量它转到相机 up 的有符号角。
    # 有符号（绕 forward 轴，右手正向）：+90° 表示相机横躺着。这正是 OrbitControls.update() 会抹掉的那部分。
    scene_up = [0.0, 0.0, 1.0]
    along = sum(scene_up[index] * forward[index] for index in range(3))
    world_up_plane = [scene_up[index] - along * forward[index] for index in range(3)]
    plane_norm = math.sqrt(sum(value * value for value in world_up_plane))
    if plane_norm > 1e-9:
        world_up_plane = [value / plane_norm for value in world_up_plane]
        cosine = sum(camera_up[k] * world_up_plane[k] for k in range(3))
        sine = ((world_up_plane[1] * camera_up[2] - world_up_plane[2] * camera_up[1]) * forward[0]
                + (world_up_plane[2] * camera_up[0] - world_up_plane[0] * camera_up[2]) * forward[1]
                + (world_up_plane[0] * camera_up[1] - world_up_plane[1] * camera_up[0]) * forward[2])
        roll_deg = math.degrees(math.atan2(sine, cosine))
    else:                                   # 正对天顶/天底：世界 up 在像平面上没有分量，roll 无定义
        roll_deg = None
    focus = sorted(value for value in depths if value > 0)
    focus_distance = focus[len(focus) // 2] if focus else None
    target = None if focus_distance is None else [position[index] + forward[index] * focus_distance
                                                  for index in range(3)]
    # fx≠fy 在这条普通 fov+aspect 路径里表达不了（不是 three.js 的能力上限，见 squarePixelModel.note）：
    # 给出两种"守一边"的装法各自的像素误差上界。
    edge = max(abs(0.0 - intrinsics["cx"]), abs((width - 1) - intrinsics["cx"]))
    vertical_edge = max(abs(0.0 - intrinsics["cy"]), abs((height - 1) - intrinsics["cy"]))
    # 非方形像素的残余：这条普通路径下的相机恒按 fx=fy 建矩阵。
    # 守 fy（fov_y 按 fy 给）→ 模型焦距 fx_model=fy，横向错位 |u−cx|·|fy/fx−1|（竖向是对的）；
    # 守 fx（fov_y 反过来按 fx 给）→ 模型焦距 fy_model=fx，竖向错位 |v−cy|·|fx/fy−1|（横向是对的）。
    # 下面的上界都用"离主点最远的像素"量，并且**假设已按 viewOffsetPx 补上主点**（否则还要叠主点误差）。
    square_model = {
        "note": "本读数的 Viewer 装配走的是 three.js 的**普通 fov + 画布 aspect 接口**"
                "（PerspectiveCamera.fov/.aspect；主点用 setViewOffset 表达）——该接口的前提是方形像素，"
                "所以非方形 K 在这条路径里必然有残差，下面是两种守法的上界（都假定已按 viewOffsetPx 补上主点）。"
                "**这不是 three.js 的能力上限**：直接给 camera.projectionMatrix（fx/fy 各轴各一个量）"
                "或用 setViewOffset 的整幅适配法（虚拟整幅宽 = width·fx/fy、子视口取真实画布）都能精确表达"
                "非方形 K，已有实现在 66 候选（Viewer 侧 camera-view.ts，合入主仓后为 "
                "packages/viewer/src/camera-view.ts：projectionMatrixFromIntrinsics / "
                "intrinsicsCameraParameters，与真实 three 投影核对到 1e-13 像素量级）；"
                "要用精确 K 就不要只照抄这里的 fov 参数。",
        "viewOffsetPx": {"x": r(-offset_x, PIXEL_DIGITS), "y": r(-offset_y, PIXEL_DIGITS),
                         "apply": "camera.setViewOffset(width, height, x, y, width, height)"},
        "exact": bool(square),
        "options": [
            {"keeps": "fy", "fovYDeg": r(fov["verticalDeg"]), "aspect": r(width / height, 9),
             "maxPixelErrorPx": r(0.0 if square else edge * abs(intrinsics["fy"] / intrinsics["fx"] - 1.0),
                                  PIXEL_DIGITS),
             "pays": "竖向完全正确（fov_y 就是按 fy 给的），残余全在横向：随 |u−cx| 线性增长"},
            {"keeps": "fx", "fovYDeg": r(2.0 * math.degrees(math.atan(height / (2.0 * intrinsics["fx"])))),
             "aspect": r(width / height, 9),
             "maxPixelErrorPx": r(0.0 if square else vertical_edge * abs(intrinsics["fx"] / intrinsics["fy"] - 1.0),
                                  PIXEL_DIGITS),
             "pays": "横向完全正确，残余全在竖向：随 |v−cy| 线性增长"},
        ],
    }
    viewer = {
        # 位置字段名跟着尺度走（与 camera.worldFromCamera / blender 同一套规则）：带 M 名字会被直接当米用。
        "quaternion": vec(quaternion),
        "units": {"metric": bool(metric), "name": "m" if metric else "input-units(unknown-scale)",
                  "note": "位置数值的尺度：worldUnit=unknown 时它**不是米**，把它直接摆进以米为单位的场景"
                          "等于声明 1 输入单位 = 1 米。"
                          if not metric else "位置数值按调用方声明的 worldUnit 换算成米。"},
        "fov_y_deg": r(fov["verticalDeg"]),
        "fov_x_deg": r(fov["horizontalDeg"]),
        "aspect": r(width / height, 9),
        "up": vec(camera_up, 12),
        "upNote": "相机真实上向量（由 R 的第二列给出，含 roll）；**不是**世界 up [0,0,1]。",
        "forward": vec(forward, 12),
        "target": None if target is None else vec(target),
        "focusDistance": None if focus_distance is None else r(focus_distance),
        "rollDeg": None if roll_deg is None else r(roll_deg, 9),
        "rollNote": "OrbitControls.update() 用 camera.up + target 重算朝向：用默认的 worldUp 调它，"
                    "roll 会被抹成 rollDeg 这个角度。要保住拟合的真实 roll，就把 camera.up 设成 up 再 update，"
                    "或者装完直接用 position/quaternion（worldFromCamera 的完整矩阵）不要再调 lookAt/update。",
        "sceneUp": [0.0, 0.0, 1.0],
        "projection": "perspective",
        "intrinsics": {
            "model": "pinhole",
            "fx": r(intrinsics["fx"]), "fy": r(intrinsics["fy"]),
            "cx": r(intrinsics["cx"], PIXEL_DIGITS), "cy": r(intrinsics["cy"], PIXEL_DIGITS),
            "width": width, "height": height,
            "principalPointOffsetPx": {"x": r(offset_x, PIXEL_DIGITS), "y": r(offset_y, PIXEL_DIGITS)},
            "principalPointCentred": bool(abs(offset_x) <= 0.5 and abs(offset_y) <= 0.5),
            "reproducibleByFovAlone": False,
            "note": "fx/fy/主点都以像素给出：只给一条 fov（=fov_y_deg）复现不了非中心主点，"
                    "也复现不了 fx≠fy——这是 fov+aspect 这个普通接口的限制，不是 three.js 的能力上限"
                    "（给 projectionMatrix 或用整幅适配法能精确表达任意 K，见 squarePixelModel.note）；"
                    "主点用 setViewOffset 精确表达，这条普通路径下 fx≠fy 的残余误差见 squarePixelModel.options。",
        },
        "squarePixelModel": square_model,
        "matrixWorldFromCamera": mat([[rotation[row][col] for col in range(3)] + [position[row]]
                                      for row in range(3)] + [[0.0, 0.0, 0.0, 1.0]]),
    }
    viewer.update(position_fields("position", vec(position), metric))
    return viewer


def build_report(request, fit_world, fit_pixel, fit_ids, check_world, check_pixel, check_ids, points_meta):
    import cv2
    import numpy as np

    unit_factor, unit_meta = resolve_world_unit(request)
    intrinsics, intrinsics_meta = build_intrinsics(request)
    schema = cv2.__version__
    options = parse_options(request)

    # 尺度：单位未知时只在归一化坐标下求解（位置沿用输入单位，不宣称绝对尺度）。
    normalization = None
    if unit_factor is None:
        cloud = np.asarray(fit_world + check_world, dtype=float)
        centre = cloud.mean(axis=0)
        radius = float(np.sqrt(((cloud - centre) ** 2).sum(axis=1).mean()))
        if radius <= 0:
            raise FitError("CAMERA_FIT_POINTS_DEGENERATE", "所有点重合，无法归一化", points=len(cloud))
        normalization = {"applied": True, "rmsRadiusInputUnits": r(radius), "centroidInputUnits": vec(centre),
                         "note": "世界点尺度未知：先减重心、按 RMS 半径归一化后求解；位置沿用输入单位，"
                                 "要米制绝对位置必须先有一条已知长度做锚。"}
        scale_to_metres = 1.0 / radius
    else:
        scale_to_metres = unit_factor
    world_fit_m = [[value * scale_to_metres for value in point] for point in fit_world]
    world_check_m = [[value * scale_to_metres for value in point] for point in check_world]

    geometry = {
        "fit3d": rank_analysis(world_fit_m),
        "fitPixel": rank_analysis(fit_pixel),
        "check3d": rank_analysis(world_check_m) if len(world_check_m) >= 2 else None,
    }
    if geometry["fit3d"]["collinear"]:
        raise FitError("CAMERA_FIT_POINTS_COLLINEAR",
                       f"参与拟合的 {len(world_fit_m)} 个世界点共线（3D 点秩 {geometry['fit3d']['rank']}）："
                       "这组点不能确定相机位姿（沿视线方向有无穷多解），请补不在同一条直线上的点",
                       geometry=geometry["fit3d"])
    if geometry["fitPixel"]["rank"] < 2:
        raise FitError("CAMERA_FIT_PIXEL_DEGENERATE",
                       "参与拟合的像素点共线（像平面秩 1）：该构型下位姿不可辨识"
                       "（对应点所在平面可能穿过相机中心），请用不在同一平面上的点",
                       geometry={"fit3d": geometry["fit3d"], "fitPixel": geometry["fitPixel"]})

    camera_matrix = np.array([[intrinsics["fx"], 0.0, intrinsics["cx"]],
                              [0.0, intrinsics["fy"], intrinsics["cy"]],
                              [0.0, 0.0, 1.0]], dtype=np.float64)
    distortion = np.asarray(intrinsics["distortion"], dtype=np.float64) if intrinsics["distortion"] else None

    # solve_pose 给的是 OpenCV 相机系位姿；产品读数是世界系里的 worldFromCamera，必须先换算。
    rvec, tvec, cv_rotation, mask, solver = solve_pose(world_fit_m, fit_pixel, camera_matrix, distortion,
                                                       options, geometry)
    rotation, position = product_pose_from_cv(cv_rotation, tvec)
    # 位姿矩阵必须正交到数值精度：正交化误差写进结果（不给"看起来像旋转矩阵"的东西）。
    u, _, vt = np.linalg.svd(rotation)
    orthogonality_error = float(np.abs(rotation.T @ rotation - np.eye(3)).max())
    rotation = u @ vt
    if orthogonality_error > 1e-9:
        solver.setdefault("notes", []).append(f"旋转矩阵正交化残差 {orthogonality_error:.3e}（已重新正交化）")

    predicted_fit, front_fit = project_points(world_fit_m, rvec, tvec, camera_matrix, distortion)
    outlier_flags = None if mask is None else (~mask)
    fit_rows = _residual_rows(fit_ids, world_fit_m, fit_pixel, predicted_fit, front_fit, outlier_flags,
                              metric=unit_factor is not None)
    fit_stats = _stats(fit_rows)
    check_stats, check_rows = None, None
    if check_ids:
        predicted_check, front_check = project_points(world_check_m, rvec, tvec, camera_matrix, distortion)
        check_rows = _residual_rows(check_ids, world_check_m, check_pixel, predicted_check, front_check,
                                    metric=unit_factor is not None)
        check_stats = _stats(check_rows)

    position = vec(position)
    quaternion = _matrix_to_quaternion(rotation)
    fov = {"verticalDeg": 2.0 * math.degrees(math.atan(intrinsics["height"] / (2.0 * intrinsics["fy"]))),
           "horizontalDeg": 2.0 * math.degrees(math.atan(intrinsics["width"] / (2.0 * intrinsics["fx"])))}
    metric = unit_factor is not None
    # 焦点距离：对应点沿相机 forward 的中位深度（OrbitControls 的 target 用它，好让镜头对着那批点）。
    depths = []
    for point in list(world_fit_m) + list(world_check_m):
        depths.append(-sum(rotation[row][2] * (point[row] - position[row]) for row in range(3)))
    blender = _blender_adapter(position, quaternion, intrinsics, fov, metric)
    viewer = _viewer_adapter(position, quaternion, intrinsics, fov, rotation, metric, depths)

    planar = None
    if geometry["fit3d"]["planar"]:
        subset = slice(None) if mask is None else mask
        solutions, error = planar_two_solutions(np.asarray(world_fit_m)[subset],
                                                np.asarray(fit_pixel)[subset], camera_matrix, distortion)
        planar = {"kind": "planar-twofold",
                  "note": "共面点集的 PnP 一般有两解（IPPE）：误差接近时低残差**不能**区分它们。",
                  "ippeError": error}
        if solutions:
            ordered = sorted(solutions, key=lambda item: item["reprojectionRmsPx"] or 0.0)
            for item in ordered:
                pose = item["worldFromCamera"]
                # 尺度未知时位置不是米：字段名跟着换（同族里绝不留 M 名字）。
                pose.update(position_fields("position", vec(pose.pop("positionM")), metric))
                pose["rotationMatrix"] = mat(pose["rotationMatrix"])
                # 每解都要能和主位姿一样直接用：补四元数，别让调用方自己去转。
                pose["quaternionXyzw"] = vec(_matrix_to_quaternion(np.asarray(pose["rotationMatrix"], dtype=float)))
                item["reprojectionRmsPx"] = r(item["reprojectionRmsPx"], PIXEL_DIGITS) \
                    if item["reprojectionRmsPx"] is not None else None
            gap = None
            if len(ordered) >= 2 and ordered[0]["reprojectionRmsPx"] is not None:
                gap = ordered[1]["reprojectionRmsPx"] - ordered[0]["reprojectionRmsPx"]
            rotation_delta = None
            position_delta = None
            if len(ordered) >= 2:
                rotation_delta = _rotation_angle_between(ordered[0]["worldFromCamera"]["rotationMatrix"],
                                                         ordered[1]["worldFromCamera"]["rotationMatrix"])
                key = "positionM" if metric else "positionInputUnits"
                position_delta = float(np.linalg.norm(np.asarray(ordered[0]["worldFromCamera"][key])
                                                      - np.asarray(ordered[1]["worldFromCamera"][key])))
            different_pose = (rotation_delta is not None and rotation_delta > 0.5) or \
                             (position_delta is not None and
                              position_delta > 0.01 * float(np.linalg.norm(position)))
            ambiguous = gap is not None and gap <= max(options["planarGapTolerancePx"],
                                                       3.0 * (ordered[0]["reprojectionRmsPx"] or 0.0)) and different_pose
            planar.update({"solutions": ordered, "reprojectionGapPx": None if gap is None else r(gap, PIXEL_DIGITS),
                           "rotationDeltaDeg": None if rotation_delta is None else r(rotation_delta, 9),
                           ("positionDeltaM" if metric else "positionDeltaInputUnits"):
                               None if position_delta is None else r(position_delta, 9),
                           "ambiguous": bool(ambiguous)})

    warnings = []
    if not check_ids:
        warnings.append("NO_INDEPENDENT_CHECK: 没有 check 点（不在拟合里的点）：报告里的残差只是拟合残差，"
                        "不能当精度证据。请给至少一个未参与拟合的已知点做独立核对。")
    elif points_meta["checkRepeatedWorldPoints"]:
        if not points_meta["checkHeldOut"]:
            warnings.append("NO_SPATIAL_CHECK: "
                            f"{points_meta['checkRepeatedWorldPoints']} 个 check 点的世界点**全部**在 fit 里用过"
                            "（只是像素观测不同）：它们能核对内参/像素一致性，但世界点没有离开拟合区域，"
                            "**不提供空间外推验证**——别把这类 check 的残差当成「位姿对没见过的点也对」的证据。")
        else:
            warnings.append("REPEATED_WORLD_POINT_CHECK: "
                            f"{points_meta['checkRepeatedWorldPoints']} 个 check 点的世界点也出现在 fit 里"
                            "（像素观测不同）：它们只核对像素/内参一致性，不做空间外推验证；"
                            f"空间独立的 check 点只有 {points_meta['check'] - points_meta['checkRepeatedWorldPoints']} 个。")
    if geometry["fit3d"]["nearCollinear"] and not geometry["fit3d"]["collinear"]:
        warnings.append("NEAR_COLLINEAR_POINTS: 世界点接近共线（第二奇异值/第一 = "
                        f"{geometry['fit3d']['singularValuesRelative'][1]:.3g}）：位姿对噪声很敏感。")
    if geometry["fit3d"]["nearPlanar"] and not geometry["fit3d"]["planar"]:
        warnings.append("NEAR_PLANAR_POINTS: 世界点接近共面（第三奇异值/第一 = "
                        f"{geometry['fit3d']['singularValuesRelative'][2]:.3g}）：两解风险升高。")
    if planar and planar.get("ambiguous"):
        warnings.append("PLANAR_AMBIGUOUS: 共面点集的两解重投影误差只差 "
                        f"{planar['reprojectionGapPx']} px（位姿差 {planar['rotationDeltaDeg']}°／"
                        f"{planar['positionDeltaM' if metric else 'positionDeltaInputUnits']} "
                        f"{'m' if metric else '输入单位'}）：低残差不代表位姿唯一，请补不共面的点。")
    elif planar:
        warnings.append("PLANAR_POINTS: 世界点共面：已给出第二解与误差间隔（"
                        f"{planar.get('reprojectionGapPx')} px），当前解误差更低不代表几何上唯一。")
    if fit_stats.get("outliers"):
        warnings.append(f"OUTLIERS_REJECTED: RANSAC 剔除 {fit_stats['outliers']} 个不一致点（见 perPoint.outlier）。")
    if fit_stats.get("behindCamera"):
        warnings.append(f"POINTS_BEHIND_CAMERA: {fit_stats['behindCamera']} 个点解出来在相机背后，"
                        "未参与统计——通常是错点或内参不对。")
    if len(fit_world) < 6:
        warnings.append(f"FEW_POINTS: 只有 {len(fit_world)} 个拟合点（<6），解对单点误差很敏感。")
    if not intrinsics_meta["calibrated"]:
        warnings.append("INTRINSICS_NOT_CALIBRATED: 内参不是已知 K（"
                        f"source={intrinsics_meta['source']}）：位姿只是在这组假设内自洽，不是实测标定结果。")
    if unit_factor is None:
        warnings.append("SCALE_UNKNOWN: 世界点尺度未知：位置沿用输入单位（读数里带 M 后缀的位置字段**一律不出现**，"
                        "换成 positionInputUnits/locationInputUnits；blender.metric=false），"
                        "米制绝对位置与绝对尺度不可用。")
    if check_stats and check_stats["rmsPx"] is not None and fit_stats["rmsPx"] is not None \
            and check_stats["rmsPx"] > max(3.0 * fit_stats["rmsPx"], 2.0):
        warnings.append("CHECK_WORSE_THAN_FIT: 独立检查点残差（"
                        f"{check_stats['rmsPx']} px）明显大于拟合残差（{fit_stats['rmsPx']} px）："
                        "位姿对没参与拟合的点不好，别用拟合残差当精度。")
    if distortion is not None and len(distortion) > 5 and any(abs(value) > 0 for value in distortion[5:]):
        warnings.append("DISTORTION_MODEL_WIDE: 用了带 k4–k6/s/tau 的宽畸变模型：拟合自由度大，"
                        "低残差更容易，独立检查点更重要。")

    report = {
        "ok": True,
        "scriptVersion": SCRIPT_VERSION,
        "engine": {"name": "opencv", "version": schema, "numpy": np.__version__,
                   "interpreter": sys.executable, "python": sys.version.split()[0],
                   "solver": solver["backend"]},
        "conventions": {
            "world": "右手 Z-up，米制（除非 worldUnit=unknown：见 scale）",
            "pixel": "原点左上、u 向右、v 向下；主点用像素中心口径 (width-1)/2,(height-1)/2",
            "worldFromCamera": "camera x 右、y 上、看向 -z；world = R * p_cam + t"
                               "（与 packages/sim-mujoco/python/worker.py 的 camera calibration 同一份合同）",
            "depth": "深度是沿相机 -z 的轴向米制距离；p_cam = [(u-cx)*d/fx, -(v-cy)*d/fy, -d]",
            "rotationMatrix": "列 = 相机三轴在世界系中的方向（MuJoCo/Blender 同一读法）",
        },
        "input": {"counts": points_meta, "worldUnit": unit_meta["unit"],
                  "metresPerInputUnit": None if unit_factor is None else r(unit_factor),
                  "fitPoints": len(fit_world), "checkPoints": len(check_ids),
                  "fitPointIds": fit_ids[:MAX_REPORTED_POINTS],
                  "checkPointIds": check_ids[:MAX_REPORTED_POINTS]},
        "scale": ({"determined": True, "worldUnit": unit_meta["unit"],
                   "metresPerInputUnit": r(unit_factor), "source": unit_meta["source"],
                   "note": "位置按调用方声明的单位换算成米；单位声明错了位姿就等比例错。"}
                  if unit_factor is not None else
                  {"determined": False, "worldUnit": "unknown", "source": unit_meta["source"],
                   "normalization": normalization,
                   "note": "尺度未定：旋转有依据，平移只与输入点云的尺度成正比；绝对位置需要已知长度锚点。"}),
        "intrinsics": {**{key: r(value) for key, value in intrinsics.items() if key != "distortion"},
                       "distortion": vec(intrinsics["distortion"] or [0.0, 0.0, 0.0, 0.0, 0.0]),
                       "distortionModel": DISTORTION_MODELS.get(len(intrinsics["distortion"]), "none")
                       if intrinsics["distortion"] else "none",
                       "fovyDeg": r(fov["verticalDeg"]), "fovxDeg": r(fov["horizontalDeg"]),
                       "source": intrinsics_meta["source"], "estimated": intrinsics_meta["estimated"],
                       "calibrated": intrinsics_meta["calibrated"],
                       "assumptions": intrinsics_meta["assumptions"]},
        "identifiability": {
            "fit3dRank": geometry["fit3d"]["rank"],
            "fit3dSingularValuesRelative": geometry["fit3d"]["singularValuesRelative"],
            "fitPixelRank": geometry["fitPixel"]["rank"],
            "planar": geometry["fit3d"]["planar"],
            "collinear": geometry["fit3d"]["collinear"],
            "nearCollinear": geometry["fit3d"]["nearCollinear"],
            "nearPlanar": geometry["fit3d"]["nearPlanar"],
            "note": "秩 3 = 点云张成三维（一般位置）：在点数足够、无噪声、条件数良好的前提下位姿才唯一，"
                    "点少/近共面/近共线时仍可能病态（看 singularValuesRelative 与 warnings）；"
                    "秩 2 = 共面（一般两解，见 planarAmbiguity）；秩 1 = 共线（不可辨识，已拒绝）。",
        },
        "planarAmbiguity": planar,
        "camera": {
            "model": "pinhole",
            "worldFromCamera": {**position_fields("position", position, metric),
                                "rotationMatrix": mat(rotation), "quaternionXyzw": vec(quaternion)},
            "fov": {"verticalDeg": r(fov["verticalDeg"]), "horizontalDeg": r(fov["horizontalDeg"]),
                    "focalPx": {"x": r(intrinsics["fx"]), "y": r(intrinsics["fy"])}},
            "positionUnits": "m" if metric else "input-units(unknown-scale)",
            "metric": bool(metric),
            "blender": blender,
            "viewer": viewer,
        },
        "reprojection": {
            "fit": {"stats": fit_stats,
                    "perPoint": fit_rows[:MAX_REPORTED_POINTS],
                    "perPointReported": min(len(fit_rows), MAX_REPORTED_POINTS)},
            "check": (None if check_rows is None else
                      {"stats": check_stats, "perPoint": check_rows[:MAX_REPORTED_POINTS],
                       "perPointReported": min(len(check_rows), MAX_REPORTED_POINTS)}),
        },
        "precision": {
            "residualsAre": "重投影残差：predictedPx 是把 world 点用拟合出的位姿+内参投到像素的结果，"
                            "observedPx 是调用方给的照片像素。",
            "fitPointsUsedForEstimation": True,
            "independentCheck": bool(check_ids),
            "spatialCheck": bool(points_meta["checkHeldOut"]),
            "fitResidualRmsPx": fit_stats["rmsPx"],
            "checkResidualRmsPx": None if check_stats is None else check_stats["rmsPx"],
            "spatialCheckRmsPx": check_stats["rmsPx"] if points_meta["checkHeldOut"] else None,
            "claims": [
                "低残差只说明给定的对应点被这组位姿+内参重投影得好，**不是**实测精度；"
                "真实精度还取决于对应点本身的测量误差、内参是否实测标定、以及全部点是否同源。",
                "check 点不参与拟合，它们的残差是本次调用里唯一的独立证据；没有 check 点就没有独立证据。",
                "只有**世界点也没在 fit 里出现过**的 check 点才验证空间外推；"
                "世界点重复、只有像素不同的 check 点只能核对像素/内参一致性"
                "（见 input.counts.checkRepeatedWorldPoints 与 spatialCheck）。",
                "尺度看 scale：未定尺度时平移只有相对意义，位置字段也不带 M 后缀。" if unit_factor is None
                else "位置单位按调用方声明的 worldUnit 换算；单位声明错误会等比例传到位置上。",
            ],
            "measuredAccuracy": False,
        },
        "solver": {**solver, "options": options},
        "warnings": warnings,
    }
    return report


def parse_options(request: dict) -> dict:
    raw = request.get("options")
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise FitError("CAMERA_FIT_INPUT_INVALID", "options 必须是对象", field="options")
    unknown = sorted(set(raw) - {"ransac", "reprojectionThresholdPx", "iterations", "confidence",
                                 "seed", "refine", "planarGapTolerancePx"})
    if unknown:
        raise FitError("CAMERA_FIT_INPUT_INVALID", f"options 里有未知字段：{', '.join(unknown)}（不忽略，避免写错的选项被当成默认）",
                       field="options", unknown=unknown)
    ransac = raw.get("ransac", "auto")
    if ransac not in ("auto", True, False):
        raise FitError("CAMERA_FIT_INPUT_INVALID", "options.ransac 只能是 \"auto\"、true、false",
                       field="options.ransac")
    threshold = raw.get("reprojectionThresholdPx", 3.0)
    iterations = raw.get("iterations", 1000)
    confidence = raw.get("confidence", 0.99)
    seed = raw.get("seed", 0)
    refine = raw.get("refine", True)
    gap = raw.get("planarGapTolerancePx", 1.0)
    if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not math.isfinite(float(threshold)) or float(threshold) <= 0:
        raise FitError("CAMERA_FIT_INPUT_INVALID", "options.reprojectionThresholdPx 必须是正数", field="options.reprojectionThresholdPx")
    if isinstance(iterations, bool) or not isinstance(iterations, int) or not 1 <= iterations <= 100000:
        raise FitError("CAMERA_FIT_INPUT_INVALID", "options.iterations 必须是 1..100000 的整数", field="options.iterations")
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 < float(confidence) < 1:
        raise FitError("CAMERA_FIT_INPUT_INVALID", "options.confidence 必须在 (0,1)", field="options.confidence")
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < 2 ** 31:
        raise FitError("CAMERA_FIT_INPUT_INVALID", "options.seed 必须是 0..2^31-1 的整数", field="options.seed")
    if not isinstance(refine, bool):
        raise FitError("CAMERA_FIT_INPUT_INVALID", "options.refine 必须是布尔", field="options.refine")
    if isinstance(gap, bool) or not isinstance(gap, (int, float)) or not math.isfinite(float(gap)) or float(gap) < 0:
        raise FitError("CAMERA_FIT_INPUT_INVALID", "options.planarGapTolerancePx 必须是非负数", field="options.planarGapTolerancePx")
    return {"ransac": ransac, "reprojectionThresholdPx": float(threshold), "iterations": int(iterations),
            "confidence": float(confidence), "seed": int(seed), "refine": refine,
            "planarGapTolerancePx": float(gap)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="从 3D-2D 对应点拟合相机位姿（OpenCV）")
    parser.add_argument("--input", required=True, help="请求 JSON 路径（'-' 表示从 stdin 读）")
    parser.add_argument("--engine-version", action="store_true", help="只打印 OpenCV/numpy 版本后退出")
    args = parser.parse_args(argv if argv is not None else sys.argv[1:])
    if args.engine_version:
        try:
            import cv2
            import numpy as np
        except ImportError as error:
            return fail("CAMERA_FIT_OPENCV_MISSING", str(error), interpreter=sys.executable)
        emit({"ok": True, "opencv": cv2.__version__, "numpy": np.__version__,
              "interpreter": sys.executable}, RESULT_PREFIX)
        return EXIT_OK
    try:
        import cv2  # noqa: F401  只是尽早失败：缺依赖时给出可操作的安装命令
        import numpy  # noqa: F401
    except ImportError as error:
        return fail("CAMERA_FIT_OPENCV_MISSING",
                    f"解释器 {sys.executable} 里没有 {error.name}。请在独立 venv 里安装"
                    "（CPU 轮子即可）：python3 -m venv <venv> && <venv>/bin/pip install "
                    "opencv-python-headless numpy，并把该解释器配给 camera fit 工具"
                    "（config.python 或 LYAPUNOV_CAMERA_FIT_PYTHON）。",
                    interpreter=sys.executable, missing=error.name)
    try:
        request = load_request(args.input)
        fit_world, fit_pixel, fit_ids, check_world, check_pixel, check_ids, points_meta = read_correspondences(request)
        report = build_report(request, fit_world, fit_pixel, fit_ids, check_world, check_pixel,
                              check_ids, points_meta)
    except FitError as error:
        return fail(error.code, error.message, **error.detail)
    emit(report, RESULT_PREFIX)
    return EXIT_OK


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except BaseException as fatal:  # 未预期异常：stderr 回溯 + 退出码 2（不当成"可预期失败"）
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(f"camera_fit 未预期失败: {type(fatal).__name__}: {fatal}", file=sys.stderr)
        raise SystemExit(EXIT_INTERNAL)
