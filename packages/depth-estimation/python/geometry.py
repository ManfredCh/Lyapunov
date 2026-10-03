#!/usr/bin/env python3
"""相对深度 → 米制粗几何：逐图标定（锚点 scale/shift）+ 相机反投影 + 有界粗网格/点云。

与仓库其它 worker 同构：一次运行、一条结构化结果。
  stdin  : 一个 JSON 请求对象
  stdout : 最后一行 `LYAPUNOV_GEOMETRY_RESULT=<json>`（成功是结果，失败是 {"error":{...}}）
  退出码 : 0=成功；非 0=失败。取消由父进程终止进程（SIGTERM），本文件不做协作取消。

## 语义边界（不得混用）

* **输入是相对深度**（越大越近，来自本包 worker.py 的真实输出），不是米。只做一种映射：
  **逆深度** `1/d_axial_m = scale * relative + shift`（本 provider 的输出就是逆深度式的）。
* **逐图独立标定**：每张图的 scale/shift 各自由**该图自己的**训练锚点拟合，绝不跨图共享。
  单目图的相对尺度/偏置互不相同；`registration.frameId` 只说明世界坐标已配准，
  **不说明两张图的相对深度尺度一致**。某图没有自己的尺度时，它不会借别的图的锚点变成米制。
* **米制世界只收已标定的图**：合成的米制 GLB 只包含"自己有米制标定"的图像（同一 registration
  坐标系）；没有尺度的图各自出一份**相对预览**，两者不混在同一个文件、同一个世界坐标里。
* **相对预览是显示用的明确假设**：`d_assumed = 1 / relative`（等价于假设 shift=0、scale=1），
  位置只做世界旋转、**不加 positionM 平移**（没有米制尺度就没有世界位置），单位是 relative，
  不是米、也不是"可直接导入使用的真实几何"。
* **GLB 一律按 glTF 标准 Y-up 导出**：产品世界是 Z-up（MuJoCo 合同），导出时按 `(x,y,z)→(x,z,-y)`
  转成 Y-up；导入方（scene_import）对 .glb 声明 `upAxis=Y` 并再做一次 Y-up→Z-up 变换，
  两边合起来正好还原产品世界坐标，不会多转一次轴。
* **轴向深度 ≠ 射线距离**：写出的 `depth.metric.npy` 是**轴向深度** d（相机平面到点的距离，
  沿相机 -z 轴）；锚点的 `depthM` 也必须是轴向深度。报告里给出每个锚点的射线距离
  （rayM = d*sqrt(1+((u-cx)/fx)^2+((v-cy)/fy)^2)），就是为了让两者不被混用。
* **相机约定沿用产品现有合同**（sim-mujoco worker 的 camera calibration）：
  相机 x 右 / y 上 / 看向 -z；`world = R * p_cam + t`；K 的像素原点左上、x 右、y 下，
  所以 `p_cam = [(u-cx)*d/fx, -(v-cy)*d/fy, -d]`。本文件不另立坐标合同。
* **几何只覆盖看得到的面**：只有掩码通过的采样像元会成为顶点；三角面不跨遮挡大跳变
  （细化到像元级边检查，含对角边），不补看不到的背面。照片 RGB 只当顶点颜色，不改变这一点。
* **check 锚点只证"未参与拟合"**：check 锚点不进入拟合，且与 train 锚点不是同一图同一像元
  （同一像元直接拒绝）。这只证明"没用它拟合、不是同一个点"，**不声明两者的测量来源统计独立**。

单独运行示例（只在本包配置的解释器里）：
    <python> geometry.py < request.json
"""
from __future__ import annotations

import json
import math
import sys
import time
import traceback
from pathlib import Path

import numpy as np

SCHEMA = "lyapunov.depth-geometry/1"
RESULT_PREFIX = "LYAPUNOV_GEOMETRY_RESULT="
DEPTH_SCHEMA = "lyapunov.depth-estimation/1"

# 采样与几何默认值（都可由请求覆盖；范围在 normalize_params 里显式判，越界报错而不是夹取）。
DEFAULT_MIN_DEPTH_M = 0.05
DEFAULT_MAX_DEPTH_M = 200.0
DEFAULT_JUMP_RATIO = 0.10
DEFAULT_JUMP_FLOOR_M = 0.05
DEFAULT_SAMPLE_STEP = 8
DEFAULT_CHECK_TOLERANCE_RATIO = 0.05
MIN_SAMPLE_STEP = 1
MAX_SAMPLE_STEP = 64
# 采样点上限：GLB 是真实产物而不是缩略图；超限明确要求调大 sampleStep，不悄悄降采样。
MAX_SAMPLED_POINTS = 1_500_000
# 相对预览的假定深度上限（单位是"relative 的倒数"，不是米）：1/relative 超过它的像元不进入预览，
# 否则极小正相对值会炸出天文数字坐标。它是**显示口径**，与米制范围 minDepthM/maxDepthM 无关。
PREVIEW_MAX_DEPTH_UNITS = 1000.0

# 掩码码（写进 depth.mask.npy 的 uint8；含义由 geometry.metadata.json 的 mask.codes 公布）。
MASK_NAMES = {0: "ok", 1: "nonpositive_relative", 2: "outside_depth_range", 3: "nonpositive_depth"}
MASK_NOTES = {
    0: "该像元有深度证据",
    1: "相对深度 <= 0（ReLU 饱和或插值欠冲），没有深度证据",
    2: "米制模式：拟合出的米制深度落在 [minDepthM, maxDepthM] 之外；相对预览模式：假定的 1/relative 超过预览深度上限",
    3: "米制模式：拟合出的深度 <= 0（逆深度映射越界）",
}
MASK_CODES = {str(code): MASK_NAMES[code] for code in MASK_NAMES}

# 只支持本 provider 的逆深度语义：不提供未匹配别的 provider 的泛化选项。
MAPPING = "inverse"
MAPPING_MODEL = "1/d_axial_m = scale * relative + shift（本 provider 的相对输出是逆深度式的：越大越近）"
GEOMETRY_GENERATOR = "lyapunov depth-estimation geometry.py (" + SCHEMA + ")"
# verdict 严重度（worst 优先）；顶层 verdict 取"最差的那一个"，单图时就是该图自己的 verdict。
VERDICT_SEVERITY = ["insufficient-anchors", "train-inconsistent", "check-failed", "unverified", "verified"]


class GeometryError(RuntimeError):
    """带结构化错误码的失败；code 会原样出现在结果行里。"""

    def __init__(self, code: str, message: str, detail=None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.detail = detail


def emit_result(payload: dict) -> None:
    """只打一行结果；父进程按前缀取用，其他日志不得使用该前缀。

    数值必须是**无损 JSON**：NaN/Inf 会让上层工具调用整次变成 invalid output，
    所以出口统一把非有限浮点换成 null（真实语义由各字段的 null 表达，不伪装成 0）。
    """
    sys.stdout.write(RESULT_PREFIX + json.dumps(sanitize(payload), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def sanitize(value):
    """递归把 NaN/±Inf 换成 None（JSON 里没有它们），其余原样。"""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: sanitize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitize(item) for item in value]
    return value


def finite_or_none(value) -> float | None:
    number = float(value)
    return number if math.isfinite(number) else None


# ---------------------------------------------------------------- 输入校验

def require_number(value, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise GeometryError("INVALID_NUMBER", f"{label} 必须是数字")
    number = float(value)
    if not math.isfinite(number):
        raise GeometryError("INVALID_NUMBER", f"{label} 必须是有限数字")
    return number


def normalize_params(raw) -> dict:
    """请求参数校验：只接受已实现字段；范围在这里显式判（不是夹取），越界明确报错。"""
    params = raw if raw is not None else {}
    if not isinstance(params, dict):
        raise GeometryError("INVALID_PARAMS", "params 必须是对象或不给")
    allowed = {"mapping", "minDepthM", "maxDepthM", "jumpRatio", "jumpThresholdM", "sampleStep", "vertexColor", "checkToleranceRatio", "writePly"}
    unknown = sorted(set(params) - allowed)
    if unknown:
        raise GeometryError("UNSUPPORTED_CAPABILITY", "未实现的 params 字段: " + ",".join(unknown))
    # mapping 只接受本 provider 的 inverse：不接受别的映射选项（过去那个 linear 分支没有真实 provider 支持）。
    mapping = str(params.get("mapping", MAPPING))
    if mapping != MAPPING:
        raise GeometryError("MAPPING_UNSUPPORTED", f"mapping 只支持 {MAPPING}（{MAPPING_MODEL}）；本工具不为没有真实输出的映射提供选项")
    minimum = float(params.get("minDepthM", DEFAULT_MIN_DEPTH_M))
    maximum = float(params.get("maxDepthM", DEFAULT_MAX_DEPTH_M))
    if not (math.isfinite(minimum) and math.isfinite(maximum)) or minimum <= 0 or maximum <= minimum:
        raise GeometryError("INVALID_PARAMS", f"正深度范围必须满足 0 < minDepthM < maxDepthM，收到 {minimum}..{maximum}")
    jump_ratio = float(params.get("jumpRatio", DEFAULT_JUMP_RATIO))
    jump_floor = float(params.get("jumpThresholdM", DEFAULT_JUMP_FLOOR_M))
    if not math.isfinite(jump_ratio) or not 0 <= jump_ratio < 1:
        raise GeometryError("INVALID_PARAMS", f"jumpRatio 必须在 [0,1)，收到 {jump_ratio}")
    if not math.isfinite(jump_floor) or jump_floor < 0:
        raise GeometryError("INVALID_PARAMS", f"jumpThresholdM 必须 >= 0，收到 {jump_floor}")
    step = params.get("sampleStep", DEFAULT_SAMPLE_STEP)
    if isinstance(step, bool) or not isinstance(step, int) or not MIN_SAMPLE_STEP <= step <= MAX_SAMPLE_STEP:
        raise GeometryError("INVALID_PARAMS", f"sampleStep 必须是 {MIN_SAMPLE_STEP}..{MAX_SAMPLE_STEP} 的整数，收到 {step!r}")
    vertex_color = str(params.get("vertexColor", "photo"))
    if vertex_color not in ("photo", "none"):
        raise GeometryError("INVALID_PARAMS", "vertexColor 只能是 photo 或 none")
    tolerance = float(params.get("checkToleranceRatio", DEFAULT_CHECK_TOLERANCE_RATIO))
    if not math.isfinite(tolerance) or tolerance <= 0 or tolerance >= 1:
        raise GeometryError("INVALID_PARAMS", f"checkToleranceRatio 必须在 (0,1)，收到 {tolerance}")
    write_ply = params.get("writePly", False)
    if not isinstance(write_ply, bool):
        raise GeometryError("INVALID_PARAMS", "writePly 必须是布尔值")
    return {
        "mapping": mapping, "minDepthM": minimum, "maxDepthM": maximum,
        "jumpRatio": jump_ratio, "jumpThresholdM": jump_floor, "sampleStep": step,
        "vertexColor": vertex_color, "checkToleranceRatio": tolerance, "writePly": write_ply,
    }


def absolute_path(raw, label: str) -> Path:
    """路径必须是绝对路径：相对路径由调用方按会话 cwd 解析（TS 层做），worker 不猜。"""
    if not isinstance(raw, str) or not raw:
        raise GeometryError("INVALID_REQUEST", f"{label} 必须给出绝对路径")
    path = Path(raw)
    if not path.is_absolute():
        raise GeometryError("INVALID_REQUEST", f"{label} 必须是绝对路径（相对路径由调用方按会话 cwd 解析）: {raw}")
    return path


def load_depth_array(path: Path) -> np.ndarray:
    """读真实 npy：二维、非空、浮点、全 finite。含 NaN/Inf 的整幅拒绝（与 worker.py 同一条纪律）。"""
    if not path.is_file():
        raise GeometryError("DEPTH_NPY_MISSING", f"相对深度 npy 不存在: {path}")
    try:
        array = np.load(path, allow_pickle=False)
    except Exception as error:
        raise GeometryError("DEPTH_NPY_INVALID", f"npy 读取失败（{type(error).__name__}）: {path}") from error
    if not np.issubdtype(array.dtype, np.floating):
        raise GeometryError("DEPTH_NPY_INVALID", f"相对深度必须是浮点数组: dtype={array.dtype}")
    if array.ndim != 2 or array.size == 0:
        raise GeometryError("DEPTH_NPY_INVALID", f"相对深度必须是二维非空数组: shape={array.shape}")
    if not bool(np.isfinite(array).all()):
        count = int(np.count_nonzero(~np.isfinite(array)))
        raise GeometryError("DEPTH_NPY_INVALID", f"相对深度含 {count}/{array.size} 个 NaN/Inf（整幅拒绝，不做过滤）")
    return np.ascontiguousarray(array, dtype=np.float32)


def load_depth_metadata(path: Path) -> dict:
    """相对深度 metadata：来源与语义必须由它自己背书（relative=true / metric=false）。"""
    if not path.is_file():
        raise GeometryError("METADATA_MISSING", f"相对深度 metadata 不存在: {path}")
    try:
        value = json.loads(path.read_text("utf8"))
    except Exception as error:
        raise GeometryError("METADATA_INVALID", f"metadata 不是合法 JSON（{type(error).__name__}）: {path}") from error
    if not isinstance(value, dict):
        raise GeometryError("METADATA_INVALID", "metadata 必须是 JSON 对象")
    if value.get("schema") != DEPTH_SCHEMA:
        raise GeometryError("METADATA_INVALID", f"metadata.schema 不是 {DEPTH_SCHEMA}")
    depth = value.get("depth") or {}
    if depth.get("relative") is not True or depth.get("metric") is not False:
        raise GeometryError("METADATA_INVALID", "metadata 必须自述 relative=true / metric=false（本工具只接受相对深度）")
    return value


def check_metadata_against_array(metadata: dict, array: np.ndarray) -> dict:
    """metadata 自述尺寸必须与 npy 实际形状一致；返回供来源说明用的摘要。"""
    full = (metadata.get("sizes") or {}).get("fullDepth") or {}
    width, height = full.get("width"), full.get("height")
    if not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0:
        raise GeometryError("METADATA_INVALID", "metadata.sizes.fullDepth 缺尺寸")
    if (height, width) != array.shape:
        raise GeometryError("SIZE_MISMATCH", f"metadata 尺寸 {width}x{height} 与 npy 形状 {array.shape[1]}x{array.shape[0]} 不一致")
    model = metadata.get("model") or {}
    image = metadata.get("image") or {}
    return {
        "sizes": {"width": width, "height": height},
        "relativeScale": (metadata.get("depth") or {}).get("scale"),
        "model": {
            "modelId": model.get("modelId"), "revision": model.get("revision"),
            "revisionSource": model.get("revisionSource"), "depthEstimationType": model.get("depthEstimationType"),
        },
        "sourceImage": {"path": image.get("path"), "width": image.get("width"), "height": image.get("height")},
    }


def normalize_intrinsics(raw, label: str) -> dict:
    if not isinstance(raw, dict):
        raise GeometryError("INTRINSICS_INVALID", f"{label} 必须是对象")
    allowed = {"fx", "fy", "cx", "cy", "width", "height", "distortion"}
    unknown = sorted(set(raw) - allowed)
    if unknown:
        raise GeometryError("UNSUPPORTED_CAPABILITY", f"{label} 有未实现字段: " + ",".join(unknown))
    values = {}
    for key in ("fx", "fy", "cx", "cy"):
        if key not in raw:
            raise GeometryError("INTRINSICS_INVALID", f"{label} 缺 {key}")
        values[key] = require_number(raw[key], f"{label}.{key}")
    if values["fx"] <= 0 or values["fy"] <= 0:
        raise GeometryError("INTRINSICS_INVALID", f"{label} 的 fx/fy 必须为正")
    width, height = raw.get("width"), raw.get("height")
    if isinstance(width, bool) or isinstance(height, bool) or not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0:
        raise GeometryError("INTRINSICS_INVALID", f"{label} 的 width/height 必须是正整数")
    distortion = raw.get("distortion")
    if distortion is not None:
        if not isinstance(distortion, (list, tuple)) or not all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in distortion):
            raise GeometryError("INTRINSICS_INVALID", f"{label}.distortion 必须是数字数组")
        # 不静默忽略畸变：带畸变的 K 必须先校正图像，否则像元方向是错的。
        if any(float(item) != 0.0 for item in distortion):
            raise GeometryError("DISTORTION_UNSUPPORTED", f"{label}.distortion 非零；请先做畸变校正，本工具不内联去畸变")
    return {"fx": values["fx"], "fy": values["fy"], "cx": values["cx"], "cy": values["cy"], "width": width, "height": height,
            "distortion": [0.0, 0.0, 0.0, 0.0, 0.0] if distortion is None else [float(item) for item in distortion]}


def normalize_world_from_camera(raw, label: str) -> dict:
    """world = R * p_cam + t；R 必须是真旋转（正交、det=+1），否则反投影出的世界点没有意义。"""
    if not isinstance(raw, dict):
        raise GeometryError("CAMERA_INVALID", f"{label} 必须是对象")
    unknown = sorted(set(raw) - {"positionM", "rotationMatrix"})
    if unknown:
        raise GeometryError("UNSUPPORTED_CAPABILITY", f"{label} 有未实现字段: " + ",".join(unknown))
    position, rotation = raw.get("positionM"), raw.get("rotationMatrix")
    if not isinstance(position, (list, tuple)) or len(position) != 3:
        raise GeometryError("CAMERA_INVALID", f"{label}.positionM 必须是 3 个数")
    if not isinstance(rotation, (list, tuple)) or len(rotation) != 3 or any(not isinstance(row, (list, tuple)) or len(row) != 3 for row in rotation):
        raise GeometryError("CAMERA_INVALID", f"{label}.rotationMatrix 必须是 3x3")
    t = np.array([require_number(item, f"{label}.positionM[{index}]") for index, item in enumerate(position)], dtype=np.float64)
    R = np.array([[require_number(item, f"{label}.rotationMatrix") for item in row] for row in rotation], dtype=np.float64)
    if not np.allclose(R.T @ R, np.eye(3), atol=1e-4):
        raise GeometryError("CAMERA_INVALID", f"{label}.rotationMatrix 不是正交矩阵（R^T R != I）")
    if abs(float(np.linalg.det(R)) - 1.0) > 1e-4:
        raise GeometryError("CAMERA_INVALID", f"{label}.rotationMatrix 的 det 不是 +1（反射或退化矩阵）")
    return {"positionM": [finite_or_none(item) for item in t.tolist()],
            "rotationMatrix": [[finite_or_none(item) for item in row] for row in R.tolist()], "R": R, "t": t}


def normalize_pixel(raw, label: str) -> tuple[float, float]:
    if not isinstance(raw, (list, tuple)) or len(raw) != 2:
        raise GeometryError("ANCHOR_INVALID", f"{label} 必须是 [u,v] 两个数")
    return require_number(raw[0], label + "[0]"), require_number(raw[1], label + "[1]")


def sample_bilinear(array: np.ndarray, u: float, v: float) -> float:
    """像素左上原点、x 右 y 下的双线性采样；坐标先夹到像元范围内（越界由调用方先拒）。"""
    height, width = array.shape
    x = min(max(u, 0.0), width - 1.0)
    y = min(max(v, 0.0), height - 1.0)
    x0, y0 = int(math.floor(x)), int(math.floor(y))
    x1, y1 = min(x0 + 1, width - 1), min(y0 + 1, height - 1)
    dx, dy = x - x0, y - y0
    top = float(array[y0, x0]) * (1.0 - dx) + float(array[y0, x1]) * dx
    bottom = float(array[y1, x0]) * (1.0 - dx) + float(array[y1, x1]) * dx
    return top * (1.0 - dy) + bottom * dy


# ---------------------------------------------------------------- 标定（锚点 → scale/shift）

def fit_mapping(pairs: list[dict]) -> dict:
    """最小二乘拟合 scale/shift（在 1/d 空间）。pairs 每项含 relative（采样值）与 depthM（已知轴向米制深度）。

    scale <= 0 显式拒绝：那与「越大越近」的输入语义矛盾，拟合结果不能反过来改写输入语义。
    """
    r = np.array([item["relative"] for item in pairs], dtype=np.float64)
    d = np.array([item["depthM"] for item in pairs], dtype=np.float64)
    target = 1.0 / d
    design = np.column_stack([r, np.ones_like(r)])
    spread = float(r.max() - r.min()) if r.size else 0.0
    if r.size < 2 or spread <= 1e-9:
        raise GeometryError("ANCHORS_DEGENERATE", f"训练锚点的相对深度跨度为 {spread:.3g}，无法分辨 scale/shift")
    solution, _, rank, _ = np.linalg.lstsq(design, target, rcond=None)
    if rank < 2:
        raise GeometryError("ANCHORS_DEGENERATE", "训练锚点设计矩阵秩不足（锚点退化）")
    scale, shift = float(solution[0]), float(solution[1])
    if not (math.isfinite(scale) and math.isfinite(shift)) or scale <= 0:
        raise GeometryError("MAPPING_INVALID", f"拟合结果 scale={scale:.6g} 不为正，与输入「越大越近」的语义矛盾")
    residual = target - design @ solution
    ss_res = float(np.sum(residual ** 2))
    ss_tot = float(np.sum((target - target.mean()) ** 2))
    return {
        "scale": scale, "shift": shift,
        "fitSpace": "1/d_axial",
        "rSquared": finite_or_none(1.0 - ss_res / ss_tot) if ss_tot > 0 else None,
        "relativeSpread": spread,
        "conditionNumber": finite_or_none(np.linalg.cond(design)),
    }


def inverse_to_depth(inverse: np.ndarray) -> np.ndarray:
    """1/d 空间 → 轴向深度；非正值没有物理深度（NaN）。"""
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(inverse > 0, 1.0 / inverse, np.nan)


def predict_depth(array: np.ndarray, calibration: dict, params: dict) -> tuple[np.ndarray, np.ndarray]:
    """把相对深度整幅映射到轴向米制深度。返回 (depth, mask)，被掩掉的像元 depth 为 NaN。"""
    relative = array.astype(np.float64)
    depth = inverse_to_depth(calibration["scale"] * relative + calibration["shift"])
    mask = np.zeros(array.shape, dtype=np.uint8)
    mask[relative <= 0.0] = 1  # MASK_NONPOSITIVE_RELATIVE
    mask[(mask == 0) & ~np.isfinite(depth)] = 3  # MASK_NONPOSITIVE_DEPTH
    outside = mask == 0
    outside &= (depth < params["minDepthM"]) | (depth > params["maxDepthM"])
    mask[outside] = 2  # MASK_OUTSIDE_DEPTH_RANGE（米制范围）
    return np.where(mask == 0, depth, np.nan).astype(np.float32), mask


def preview_depth(array: np.ndarray) -> tuple[np.ndarray, np.ndarray, dict]:
    """无尺度时的**显示用**相对预览：假定 `d_assumed = 1 / relative`（即 shift=0、scale=1）。

    这个假定不可验证（相对量本身不含全局尺度与偏移），所以：
      · 单位记为 relative（不是米）；
      · 只用于形状预览，`translationApplied=false`（没有米制尺度就没有世界位置）；
      · 过小的正相对值会被预览深度上限挡掉（掩码 code 2），避免天文数字坐标。
    """
    relative = array.astype(np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        assumed = np.where(relative > 0, 1.0 / relative, np.nan)
    mask = np.zeros(array.shape, dtype=np.uint8)
    mask[relative <= 0.0] = 1  # MASK_NONPOSITIVE_RELATIVE
    mask[(mask == 0) & ~(assumed <= PREVIEW_MAX_DEPTH_UNITS)] = 2  # 预览深度上限（非米制范围）
    return np.where(mask == 0, assumed, np.nan).astype(np.float32), mask, {
        "assumedMapping": "d_assumed = 1 / relative（假设上游逆深度映射的 scale=1、shift=0；偏移不可从相对量恢复）",
        "units": "relative",
        "maxDepthUnits": PREVIEW_MAX_DEPTH_UNITS,
        "translationApplied": False,
    }


def statistics_of(values: np.ndarray) -> dict | None:
    flat = values[np.isfinite(values)]
    if flat.size == 0:
        return None
    return {
        "min": finite_or_none(flat.min()), "max": finite_or_none(flat.max()),
        "mean": finite_or_none(flat.mean()), "std": finite_or_none(flat.std()),
        "percentiles": {name: finite_or_none(np.percentile(flat, point)) for name, point in (("p2", 2.0), ("p50", 50.0), ("p98", 98.0))},
        "validPixels": int(flat.size),
    }


def residual_report(anchors: list[dict]) -> dict:
    """每个锚点的真实/预测**轴向**深度、残差与射线距离。轴向与射线距离分开列，避免混用。"""
    items: list[dict] = []
    for index, anchor in enumerate(anchors):
        predicted = finite_or_none(anchor["predictedDepthM"])
        truth = float(anchor["depthM"])
        fx, fy, cx, cy = anchor["_intrinsics"]
        u, v = anchor["pixel"]
        ray_factor = math.sqrt(1.0 + ((u - cx) / fx) ** 2 + ((v - cy) / fy) ** 2)
        items.append({
            "index": index, "imageIndex": anchor["imageIndex"], "pixel": [u, v],
            "relative": finite_or_none(anchor["relative"]),
            "axialDepthM": truth, "predictedAxialDepthM": predicted,
            "residualM": finite_or_none(predicted - truth) if predicted is not None else None,
            "relativeError": finite_or_none((predicted - truth) / truth) if predicted is not None else None,
            "rayDistanceM": finite_or_none(truth * ray_factor),
            "rayToAxialFactor": finite_or_none(ray_factor),
            "note": anchor.get("note"),
        })
    usable = [item for item in items if item["predictedAxialDepthM"] is not None]
    errors = np.array([abs(item["relativeError"]) for item in usable], dtype=np.float64)
    absolute = np.array([abs(item["residualM"]) for item in usable], dtype=np.float64)
    return {
        "count": len(items), "usable": len(usable),
        "maxRelativeError": finite_or_none(errors.max()) if usable else None,
        "meanRelativeError": finite_or_none(errors.mean()) if usable else None,
        "rmseM": finite_or_none(math.sqrt(float((absolute ** 2).mean()))) if usable else None,
        "maxAbsoluteErrorM": finite_or_none(absolute.max()) if usable else None,
        "items": items,
    }


def judge(train: dict, check: dict, tolerance: float, metric: bool, reason: str | None) -> dict:
    """verdict：只有**训练锚点自洽**且**独立 check 锚点全部在容差内**才算 verified。

    训练锚点自洽 = 拟合后训练锚点自身的最大相对残差 <= 容差：锚点互相矛盾时无论怎么拟合
    都留残差，这种输入不能因为"某个 check 点恰好过了"就算标定通过。
    """
    if not metric:
        return {"verdict": "insufficient-anchors", "accepted": False, "reason": reason or "没有足够锚点做米制标定"}
    if train["usable"] < train["count"]:
        return {"verdict": "check-failed", "accepted": False, "reason": "有训练锚点无法给出预测（像素或取值问题）"}
    train_worst = float(train["maxRelativeError"])
    if train_worst > tolerance:
        return {"verdict": "train-inconsistent", "accepted": False,
                "reason": f"训练锚点自身不自洽：拟合后训练锚点最大相对残差 {train_worst:.4f} > 容差 {tolerance}（锚点互相矛盾，不能算标定通过）"}
    if check["count"] == 0:
        return {"verdict": "unverified", "accepted": False, "reason": "没有独立 check 锚点：米制换算未被独立核对，不能算标定通过"}
    if check["usable"] < check["count"]:
        return {"verdict": "check-failed", "accepted": False, "reason": "有 check 锚点无法给出预测（像素或取值问题）"}
    worst = float(check["maxRelativeError"])
    if worst <= tolerance:
        return {"verdict": "verified", "accepted": True, "reason": f"训练锚点自洽（最大相对残差 {train_worst:.4f}）且 check 锚点最大相对误差 {worst:.4f} <= 容差 {tolerance}"}
    return {"verdict": "check-failed", "accepted": False,
            "reason": f"check 锚点最大相对误差 {worst:.4f} > 容差 {tolerance}：独立核对未通过，不得当标定通过"}


def worst_verdict(verdicts: list[str]) -> str:
    """取最差 verdict（顶层汇总用）；空列表视为 insufficient-anchors（没有任何米制信息）。"""
    if not verdicts:
        return "insufficient-anchors"
    for verdict in VERDICT_SEVERITY:
        if verdict in verdicts:
            return verdict
    return verdicts[0]


# ---------------------------------------------------------------- 几何（采样、三角面、GLB/PLY）

def edge_ok(first: np.ndarray, second: np.ndarray, params: dict, metric: bool) -> np.ndarray:
    """像元级边检查：两端都必须有值，且差不超过跳变阈值（遮挡边界由此断开）。

    阈值以**较近**的一端为准：米制模式是 min(da,db)（连同绝对下限 jumpThresholdM）；
    相对模式是 max(ra,rb)——本 provider 的（逆深度式）相对输出越大越近，按较近端。
    相对模式的边检查始终在**原始相对值**上做，不用预览深度，避免换算放大误差。
    """
    valid = np.isfinite(first) & np.isfinite(second)
    left, right = np.where(valid, first, 0.0), np.where(valid, second, 0.0)
    if metric:
        limit = np.maximum(params["jumpThresholdM"], params["jumpRatio"] * np.minimum(left, right))
    else:
        limit = params["jumpRatio"] * np.maximum(left, right)
    return valid & (np.abs(left - right) <= limit)


def lattice_edges(fine: np.ndarray, step: int, row_starts: np.ndarray, column_starts: np.ndarray, direction: str) -> np.ndarray:
    """把像元级边升到采样格点级：一条格点边有效 = 它跨过的 step 条像元级边**全部**有效。

    格点边方向决定逐 offset 的位移：horizontal（(i,j)→(i,j+1)）只动列、vertical（(i,j)→(i+1,j)）
    只动行、diagonal（(i,j)→(i+1,j+1)）行列同动。索引上界由调用方保证：采样格点由
    arange(0,N,step) 生成，最后一段的窗口不会越出像元级边数组。
    """
    shifts = {"horizontal": (0, 1), "vertical": (1, 0), "diagonal": (1, 1)}[direction]
    result = np.ones((len(row_starts), len(column_starts)), dtype=bool)
    for offset in range(step):
        result &= fine[np.ix_(row_starts + offset * shifts[0], column_starts + offset * shifts[1])]
    return result


def zup_to_yup(positions: np.ndarray) -> np.ndarray:
    """产品世界（Z-up 右手系）→ glTF 标准 Y-up 右手系：(x, y, z) → (x, z, -y)。

    导入侧（scene-kit 的 .glb 分支）声明 upAxis=Y 并施加绕 X 轴 +90°，正好把这里的
    (x, z, -y) 还原成 (x, y, z)——两边的约定必须成对，否则轴会多转一次。
    """
    points = np.asarray(positions, dtype=np.float64).reshape(-1, 3)
    out = np.empty_like(points)
    out[:, 0] = points[:, 0]
    out[:, 1] = points[:, 2]
    out[:, 2] = -points[:, 1]
    return out


def build_image_geometry(values: np.ndarray, mask: np.ndarray, intrinsics: dict, world: dict, params: dict,
                         metric: bool, translation: bool, edge_values: np.ndarray | None = None) -> dict:
    """一个图像输入 → 顶点/颜色/三角面。只输出观测到的采样像元，不补看不到的背面。

    `translation=False` 时不加 worldFromCamera.positionM（只有旋转）：没有米制尺度时
    positionM 是世界里的米制位置，把它加到无单位的相对坐标上是混单位。
    """
    height, width = values.shape
    step = params["sampleStep"]
    rows, columns = np.arange(0, height, step), np.arange(0, width, step)
    sampled = values[np.ix_(rows, columns)]
    good = (mask[np.ix_(rows, columns)] == 0) & np.isfinite(sampled)
    edges = values if edge_values is None else edge_values

    # 像元级边（水平/垂直/对角）先升到格点级：掩码洞与遮挡跳变都由它断开，整格任一边无效应不出面。
    fine_h = edge_ok(edges[:, :-1], edges[:, 1:], params, metric)
    fine_v = edge_ok(edges[:-1, :], edges[1:, :], params, metric)
    fine_d = edge_ok(edges[:-1, :-1], edges[1:, 1:], params, metric)
    # 每格两个三角面共享左上→右下对角：a=(i,j) b=(i,j+1) c=(i+1,j) d=(i+1,j+1)
    #   tri1=[a,d,b]、tri2=[a,c,d]（法线朝向相机，正面可见）。
    tri_one = np.zeros((max(0, len(rows) - 1), max(0, len(columns) - 1)), dtype=bool)
    tri_two = np.zeros_like(tri_one)
    if tri_one.size:
        diagonal = lattice_edges(fine_d, step, rows[:-1], columns[:-1], "diagonal")
        top = lattice_edges(fine_h, step, rows[:-1], columns[:-1], "horizontal")
        bottom = lattice_edges(fine_h, step, rows[1:], columns[:-1], "horizontal")
        left = lattice_edges(fine_v, step, rows[:-1], columns[:-1], "vertical")
        right = lattice_edges(fine_v, step, rows[:-1], columns[1:], "vertical")
        tri_one = diagonal & top & right
        tri_two = diagonal & bottom & left

    vertex_index = np.full(good.shape, -1, dtype=np.int64)
    vertex_index[good] = np.arange(int(good.sum()), dtype=np.int64)
    xs = np.repeat(columns[None, :], len(rows), axis=0)[good].astype(np.float64)
    ys = np.repeat(rows[:, None], len(columns), axis=1)[good].astype(np.float64)
    depths = sampled[good].astype(np.float64)
    fx, fy, cx, cy = intrinsics["fx"], intrinsics["fy"], intrinsics["cx"], intrinsics["cy"]
    camera = np.column_stack([(xs - cx) * depths / fx, -(ys - cy) * depths / fy, -depths])
    rotated = camera @ world["R"].T
    positions = (rotated + world["t"]) if translation else rotated
    # 导出坐标：产品世界是 Z-up，GLB 必须按 glTF 标准 Y-up 写（否则导入时轴会多转一次）。
    positions = zup_to_yup(positions).astype(np.float32)

    one_i, one_j = np.nonzero(tri_one)
    two_i, two_j = np.nonzero(tri_two)
    parts = []
    if one_i.size:
        parts.append(np.column_stack([vertex_index[one_i, one_j], vertex_index[one_i + 1, one_j + 1], vertex_index[one_i, one_j + 1]]))
    if two_i.size:
        parts.append(np.column_stack([vertex_index[two_i, two_j], vertex_index[two_i + 1, two_j], vertex_index[two_i + 1, two_j + 1]]))
    triangles = np.concatenate(parts).astype(np.uint32) if parts else np.zeros((0, 3), dtype=np.uint32)
    return {"positions": positions, "pixels": np.column_stack([xs, ys]).astype(np.int64), "triangles": triangles,
            "localPositions": rotated.astype(np.float64)}


def sample_photo_colors(photo_path: Path | None, pixels: np.ndarray, expected: tuple[int, int], warnings: list[str]) -> np.ndarray | None:
    """原照片 RGB 顶点颜色（只影响显示，不改变几何）：尺寸不符就不上色并如实记一笔。"""
    if photo_path is None:
        return None
    try:
        from PIL import Image

        with Image.open(photo_path) as opened:
            array = np.asarray(opened.convert("RGB"), dtype=np.uint8)
    except Exception as error:
        warnings.append(f"PHOTO_UNREADABLE: 顶点颜色跳过（{type(error).__name__}）：{photo_path}")
        return None
    if (array.shape[0], array.shape[1]) != expected:
        warnings.append(f"PHOTO_SIZE_MISMATCH: 照片 {array.shape[1]}x{array.shape[0]} 与深度 {expected[1]}x{expected[0]} 不一致，跳过顶点颜色")
        return None
    if pixels.size == 0:
        return np.zeros((0, 3), dtype=np.uint8)
    return array[pixels[:, 1], pixels[:, 0]]


def write_glb(path: Path, primitives: list[dict], extras: dict) -> dict:
    """最小 glTF 2.0 二进制（GLB）写出器：一个 mesh、每个图像一个 primitive，全部 4 字节对齐。

    顶点坐标必须已经是 glTF 标准 Y-up（见 zup_to_yup）：写出器不再做任何轴变换。
    """
    binary = bytearray()
    buffer_views: list[dict] = []
    accessors: list[dict] = []
    gltf_primitives: list[dict] = []

    def append_bytes(payload: bytes, target: int | None) -> int:
        while len(binary) % 4:
            binary.append(0)
        offset = len(binary)
        binary.extend(payload)
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(payload)}
        if target is not None:
            view["target"] = target
        buffer_views.append(view)
        return len(buffer_views) - 1

    for primitive in primitives:
        positions = np.ascontiguousarray(primitive["positions"], dtype=np.float32)
        attributes = {}
        attributes["POSITION"] = len(accessors)
        accessors.append({
            "bufferView": append_bytes(positions.tobytes(), 34962), "componentType": 5126,
            "count": int(positions.shape[0]), "type": "VEC3",
            "min": [float(item) for item in positions.min(axis=0)] if positions.size else [0.0, 0.0, 0.0],
            "max": [float(item) for item in positions.max(axis=0)] if positions.size else [0.0, 0.0, 0.0],
        })
        colors = primitive.get("colors")
        if colors is not None:
            colors = np.ascontiguousarray(colors, dtype=np.uint8)
            attributes["COLOR_0"] = len(accessors)
            accessors.append({"bufferView": append_bytes(colors.tobytes(), 34962), "componentType": 5121,
                              "normalized": True, "count": int(colors.shape[0]), "type": "VEC3"})
        indices = np.ascontiguousarray(primitive["triangles"], dtype=np.uint32).reshape(-1)
        gltf_primitives.append({
            "attributes": attributes, "indices": len(accessors), "mode": 4,
            "extras": {"imageIndex": primitive["imageIndex"], "vertices": int(positions.shape[0]),
                       "triangles": int(primitive["triangles"].shape[0]),
                       **(primitive.get("extras") or {})},
        })
        accessors.append({"bufferView": append_bytes(indices.tobytes(), 34963), "componentType": 5125,
                          "count": int(indices.size), "type": "SCALAR"})

    name = str(extras.get("name", "depth-geometry"))
    gltf = {
        "asset": {"version": "2.0", "generator": GEOMETRY_GENERATOR},
        "scene": 0, "scenes": [{"nodes": [0], "name": name}], "nodes": [{"mesh": 0, "name": name}],
        "meshes": [{"name": name, "primitives": gltf_primitives, "extras": extras}],
        "buffers": [{"byteLength": len(binary)}], "bufferViews": buffer_views, "accessors": accessors, "extras": extras,
    }
    json_bytes = json.dumps(gltf, ensure_ascii=False, separators=(",", ":")).encode("utf8")
    json_bytes += b" " * ((4 - len(json_bytes) % 4) % 4)
    binary.extend(b"\x00" * ((4 - len(binary) % 4) % 4))
    total = 12 + 8 + len(json_bytes) + 8 + len(binary)
    with path.open("wb") as handle:
        handle.write(b"glTF")
        handle.write((2).to_bytes(4, "little"))
        handle.write(total.to_bytes(4, "little"))
        handle.write(len(json_bytes).to_bytes(4, "little"))
        handle.write(b"JSON")
        handle.write(json_bytes)
        handle.write(len(binary).to_bytes(4, "little"))
        handle.write(b"BIN\x00")
        handle.write(bytes(binary))
    return {"bytes": total, "vertices": sum(int(item["positions"].shape[0]) for item in primitives),
            "triangles": sum(int(item["triangles"].shape[0]) for item in primitives)}


def write_ply(path: Path, primitives: list[dict], units: str, frame: str) -> dict:
    """二进制小端 PLY 点云（可选）：与 GLB 同一批顶点（同一坐标系/同一轴约定），不额外造点。

    头必须是纯 ASCII（PLY 头没有编码声明，第三方读法各异），所以注释行统一折成 ASCII；
    单位/轴/帧这些会变的信息放注释里，正文二进制不受影响。
    """
    ascii_note = lambda text: str(text).encode("ascii", "replace").decode("ascii")
    positions = np.concatenate([np.ascontiguousarray(item["positions"], dtype=np.float32) for item in primitives], axis=0) if primitives else np.zeros((0, 3), dtype=np.float32)
    colors = None
    if primitives and all(item.get("colors") is not None for item in primitives):
        colors = np.concatenate([np.ascontiguousarray(item["colors"], dtype=np.uint8) for item in primitives], axis=0)
    header = ["ply", "format binary_little_endian 1.0",
              ascii_note(f"comment coarse depth geometry; units={units}; up=Y (glTF); frame={frame}; no invented backside"),
              ascii_note("comment generated by " + GEOMETRY_GENERATOR),
              f"element vertex {positions.shape[0]}", "property float x", "property float y", "property float z"]
    if colors is not None:
        header += ["property uchar red", "property uchar green", "property uchar blue"]
    header.append("end_header")
    with path.open("wb") as handle:
        handle.write(("\n".join(header) + "\n").encode("ascii"))
        if colors is None:
            handle.write(positions.astype("<f4").tobytes())
        else:
            typed = np.empty(positions.shape[0], dtype=[("xyz", "<f4", 3), ("rgb", "u1", 3)])
            typed["xyz"] = positions
            typed["rgb"] = colors
            handle.write(typed.tobytes())
    return {"bytes": path.stat().st_size, "vertices": int(positions.shape[0])}


# ---------------------------------------------------------------- 主流程

def normalize_images(request: dict) -> list[dict]:
    images = request.get("images")
    if not isinstance(images, list) or not images:
        raise GeometryError("INVALID_REQUEST", "images 必须是至少一个图像条目的数组")
    normalized = []
    for index, entry in enumerate(images):
        label = f"images[{index}]"
        if not isinstance(entry, dict):
            raise GeometryError("INVALID_REQUEST", f"{label} 必须是对象")
        unknown = sorted(set(entry) - {"relativeDepth", "metadata", "photo", "intrinsics", "worldFromCamera", "registration"})
        if unknown:
            raise GeometryError("UNSUPPORTED_CAPABILITY", f"{label} 有未实现字段: " + ",".join(unknown))
        depth_ref, metadata_ref, photo_ref = entry.get("relativeDepth") or {}, entry.get("metadata") or {}, entry.get("photo") or {}
        if not isinstance(depth_ref, dict) or not isinstance(metadata_ref, dict) or not isinstance(photo_ref, dict):
            raise GeometryError("INVALID_REQUEST", f"{label} 的 relativeDepth/metadata/photo 必须是对象")
        registration = entry.get("registration")
        frame_id = None
        if registration is not None:
            if not isinstance(registration, dict) or set(registration) - {"frameId"}:
                raise GeometryError("REGISTRATION_INVALID", f"{label}.registration 只接受 frameId")
            frame_id = registration.get("frameId")
            if not isinstance(frame_id, str) or not frame_id.strip():
                raise GeometryError("REGISTRATION_INVALID", f"{label}.registration.frameId 必须是非空字符串")
        normalized.append({
            "index": index, "article": label,
            "depthPath": absolute_path(depth_ref.get("path"), f"{label}.relativeDepth.path"),
            "metadataPath": absolute_path(metadata_ref.get("path"), f"{label}.metadata.path"),
            "photoPath": absolute_path(photo_ref["path"], f"{label}.photo.path") if photo_ref.get("path") else None,
            "intrinsics": normalize_intrinsics(entry.get("intrinsics"), f"{label}.intrinsics"),
            "world": normalize_world_from_camera(entry.get("worldFromCamera"), f"{label}.worldFromCamera"),
            "registration": {"frameId": frame_id} if frame_id else None,
        })
    if len(normalized) > 1:
        frames = {item["registration"]["frameId"] for item in normalized if item["registration"]}
        if not frames:
            raise GeometryError("REGISTRATION_REQUIRED", "多图合并必须先在同一坐标系配准：请为每个图像条目给出相同的 registration.frameId；本工具不做配准")
        if len(frames) > 1:
            raise GeometryError("REGISTRATION_MISMATCH", "图像条目的 registration.frameId 不一致：不同坐标系的深度不能合并")
    return normalized


def normalize_anchors(raw, images: list[dict]) -> dict:
    """锚点：训练与独立 check 分开；缺省即空列表（= 没有尺度，只能相对）。

    check 锚点必须与 train 锚点**不是同一图同一像元**：同一个点当然会"通过"，那是自证不是核对。
    这里只保证"未参与拟合 + 不是同一个点"，不声称两者的测量来源统计独立。
    """
    if raw is None:
        return {"train": [], "check": []}
    if not isinstance(raw, dict) or set(raw) - {"train", "check"}:
        raise GeometryError("INVALID_REQUEST", "anchors 只接受 {train:[...], check:[...]}")
    result: dict[str, list[dict]] = {}
    for role in ("train", "check"):
        entries = raw.get(role)
        if entries is None:
            result[role] = []
            continue
        if not isinstance(entries, list):
            raise GeometryError("INVALID_REQUEST", f"anchors.{role} 必须是数组")
        parsed = []
        for index, entry in enumerate(entries):
            label = f"anchors.{role}[{index}]"
            if not isinstance(entry, dict):
                raise GeometryError("ANCHOR_INVALID", f"{label} 必须是对象")
            unknown = sorted(set(entry) - {"pixel", "depthM", "imageIndex", "note"})
            if unknown:
                raise GeometryError("UNSUPPORTED_CAPABILITY", f"{label} 有未实现字段: " + ",".join(unknown))
            u, v = normalize_pixel(entry.get("pixel"), label + ".pixel")
            depth = require_number(entry.get("depthM"), label + ".depthM")
            if depth <= 0:
                raise GeometryError("ANCHOR_INVALID", f"{label}.depthM 必须是正的**轴向**米制深度（不是射线距离）")
            image_index = entry.get("imageIndex", 0)
            if isinstance(image_index, bool) or not isinstance(image_index, int) or not 0 <= image_index < len(images):
                raise GeometryError("ANCHOR_INVALID", f"{label}.imageIndex 越界: {image_index!r}")
            intrinsics = images[image_index]["intrinsics"]
            if not (0 <= u <= intrinsics["width"] - 1 and 0 <= v <= intrinsics["height"] - 1):
                raise GeometryError("ANCHOR_INVALID", f"{label}.pixel 超出 {images[image_index]['article']} 的 K 尺寸范围")
            parsed.append({"pixel": [u, v], "depthM": depth, "imageIndex": image_index,
                           "note": entry.get("note"), "_intrinsics": (intrinsics["fx"], intrinsics["fy"], intrinsics["cx"], intrinsics["cy"])})
        result[role] = parsed
    train_points = {(item["imageIndex"], item["pixel"][0], item["pixel"][1]) for item in result["train"]}
    dupes = [{"imageIndex": item["imageIndex"], "pixel": item["pixel"]} for item in result["check"]
             if (item["imageIndex"], item["pixel"][0], item["pixel"][1]) in train_points]
    if dupes:
        raise GeometryError("ANCHOR_CHECK_NOT_INDEPENDENT",
                            "check 锚点与 train 锚点是同一图同一像元：" + json.dumps(dupes, ensure_ascii=False)
                            + "；同一个点不能用来独立核对（它当然会通过）。请换独立像元，或把它只放在 train 里。",
                            {"duplicates": dupes})
    return result


def calibrate_image(image_index: int, train_anchors: list[dict], check_anchors: list[dict], params: dict) -> dict:
    """单张图的标定与判定：只用**该图自己的**训练锚点拟合，绝不借别的图的锚点。"""
    calibration: dict | None = None
    insufficient_reason: str | None = None
    unusable_code: str | None = None
    if len(train_anchors) < 2:
        insufficient_reason = f"本图训练锚点 {len(train_anchors)} 个（<2），无法分辨 scale/shift"
    else:
        try:
            calibration = fit_mapping([{"relative": item["relative"], "depthM": item["depthM"]} for item in train_anchors])
        except GeometryError as error:
            if error.code not in ("ANCHORS_DEGENERATE", "MAPPING_INVALID"):
                raise
            insufficient_reason, unusable_code = str(error), error.code
    metric = calibration is not None
    predicted: dict[str, list[dict]] = {"train": [], "check": []}
    for role, items in (("train", train_anchors), ("check", check_anchors)):
        for anchor in items:
            value = float("nan")
            if calibration is not None:
                inverse = calibration["scale"] * anchor["relative"] + calibration["shift"]
                value = float(inverse_to_depth(np.array([inverse]))[0])
            predicted[role].append({**anchor, "predictedDepthM": value})
    train_report = residual_report(predicted["train"])
    check_report = residual_report(predicted["check"])
    judgement = judge(train_report, check_report, params["checkToleranceRatio"], metric, insufficient_reason)
    if unusable_code == "MAPPING_INVALID":
        # 训练锚点与该包的逆深度语义直接矛盾（拟合 scale<=0）：更不能反推米制。与"残差超容差"同归
        # train-inconsistent，整次请求仍按逐图交付（别的图不受影响），只是本图没有米制产物。
        judgement = {"verdict": "train-inconsistent", "accepted": False,
                     "reason": f"本图训练锚点自相矛盾、与「越大越近」的逆深度语义冲突（{insufficient_reason}）；"
                               f"不能反推米制，本图只出相对预览"}
    missing_check = [item["pixel"] for item in check_report["items"] if item["predictedAxialDepthM"] is None]
    return {
        "imageIndex": image_index, "metric": metric, "units": "meters" if metric else "relative",
        "scale": calibration["scale"] if calibration else None,
        "shift": calibration["shift"] if calibration else None,
        "scaleUnit": "1/m per relative unit（逆深度空间）" if calibration else None,
        "fit": calibration, "train": train_report, "check": check_report,
        "trainAnchorsUsedForFit": True, "checkAnchorsUsedForFit": False, "checkAnchorsDisjointFromTrain": True,
        "anchorsUsed": {"train": len(train_anchors), "check": len(check_anchors)},
        "independenceClaim": "check 锚点未参与拟合，且与 train 锚点不是同一图同一像元；"
                             "**不**声明两者的测量来源统计独立（那取决于采样与标定方案，本工具无从验证）",
        "validDepthRangeM": {"min": params["minDepthM"], "max": params["maxDepthM"]} if metric else None,
        "unpredictedCheckPixels": missing_check,
        **judgement,
    }


def run(request: dict, output_directory: Path) -> dict:
    started = time.time()
    if not isinstance(request, dict):
        raise GeometryError("INVALID_REQUEST", "请求必须是 JSON 对象")
    request_id = str(request.get("requestId", ""))
    if not request_id or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for character in request_id):
        raise GeometryError("INVALID_REQUEST_ID", "requestId 只接受 [A-Za-z0-9_-]+")
    params = normalize_params(request.get("params"))
    images = normalize_images(request)
    anchors = normalize_anchors(request.get("anchors"), images)
    output_directory.mkdir(parents=True, exist_ok=True)
    warnings: list[str] = []

    arrays, provenance = [], []
    for image in images:
        array = load_depth_array(image["depthPath"])
        metadata = load_depth_metadata(image["metadataPath"])
        summary = check_metadata_against_array(metadata, array)
        intrinsics = image["intrinsics"]
        if (intrinsics["height"], intrinsics["width"]) != array.shape:
            raise GeometryError("SIZE_MISMATCH", f"{image['article']} 的 K 尺寸 {intrinsics['width']}x{intrinsics['height']} 与 npy 形状 {array.shape[1]}x{array.shape[0]} 不一致")
        arrays.append(array)
        provenance.append({
            "index": image["index"], "article": image["article"],
            "depthNpy": {"path": str(image["depthPath"]), "shape": [int(array.shape[0]), int(array.shape[1])], "dtype": str(array.dtype),
                         "semantics": "relative depth from this provider: larger means closer（逆深度式）"},
            "metadata": {"path": str(image["metadataPath"]), **summary},
            "intrinsics": {key: intrinsics[key] for key in ("fx", "fy", "cx", "cy", "width", "height", "distortion")},
            "worldFromCamera": {"positionM": image["world"]["positionM"], "rotationMatrix": image["world"]["rotationMatrix"]},
            "registration": image["registration"], "photo": None,
        })

    sample_total = sum(int(math.ceil(array.shape[0] / params["sampleStep"]) * math.ceil(array.shape[1] / params["sampleStep"])) for array in arrays)
    if sample_total > MAX_SAMPLED_POINTS:
        suggested = int(math.ceil(math.sqrt(sum(array.size for array in arrays) / MAX_SAMPLED_POINTS)))
        raise GeometryError("TOO_MANY_POINTS", f"按 sampleStep={params['sampleStep']} 会有 {sample_total} 个采样点，超过上限 {MAX_SAMPLED_POINTS}；请把 sampleStep 调到 >= {max(MIN_SAMPLE_STEP, suggested)}")

    # 锚点采样（在原始相对深度上双线性取样；轴向 depthM 只来自调用方）。
    for role in ("train", "check"):
        for anchor in anchors[role]:
            relative = sample_bilinear(arrays[anchor["imageIndex"]], anchor["pixel"][0], anchor["pixel"][1])
            if not relative > 0:
                raise GeometryError("ANCHOR_INVALID", f"锚点 {role}[{anchor['pixel']}] 的相对深度采样值 {relative:.4g} <= 0：该像元没有深度证据，不能当锚点")
            anchor["relative"] = relative

    # 逐图标定：每张图只用自己的锚点；没有尺度的图不会被别的图的锚点"带成"米制。
    per_image: list[dict] = []
    for image in images:
        index = image["index"]
        entry = calibrate_image(index, [item for item in anchors["train"] if item["imageIndex"] == index],
                                [item for item in anchors["check"] if item["imageIndex"] == index], params)
        per_image.append(entry)
        if entry["fit"] and (entry["fit"]["conditionNumber"] or 0.0) > 1e6:
            warnings.append(f"ILL_CONDITIONED_FIT: images[{index}] 训练锚点的相对深度跨度只有 {entry['fit']['relativeSpread']:.4g}，"
                            f"设计矩阵条件数 {entry['fit']['conditionNumber']:.3g}；scale/shift 对锚点误差极敏感")
        if entry["metric"] and entry["verdict"] != "verified":
            warnings.append(f"CALIBRATION_NOT_VERIFIED(images[{index}]): " + entry["reason"])
        if not entry["metric"]:
            own = entry["anchorsUsed"]["train"]
            used_elsewhere = len(anchors["train"]) - own
            if own > 0:
                warnings.append(f"ANCHORS_UNUSED(images[{index}]): 本图自己的 {own} 个训练锚点没能得到有效标定"
                                f"（{entry['reason']}）；本图只出相对预览，不借用其它图的锚点")
            elif used_elsewhere > 0:
                warnings.append(f"ANCHORS_NOT_SHARED(images[{index}]): 本图没有自己的训练锚点，"
                                f"不借用其它图的 {used_elsewhere} 个锚点；本图只出相对预览")
            provenance[index]["calibration"] = {"metric": False, "verdict": entry["verdict"], "accepted": False,
                                                "units": "relative", "scale": None, "shift": None}
        else:
            provenance[index]["calibration"] = {"metric": True, "verdict": entry["verdict"], "accepted": entry["accepted"],
                                                "units": "meters", "scale": entry["scale"], "shift": entry["shift"]}
        provenance[index]["metric"] = entry["metric"]

    metric_images = [entry["imageIndex"] for entry in per_image if entry["metric"]]
    all_metric = len(metric_images) == len(images)
    all_verified = all(entry["verdict"] == "verified" for entry in per_image)
    verdicts = [entry["verdict"] for entry in per_image]
    units = "meters" if all_metric else ("mixed" if metric_images else "relative")

    # 每个图像的深度图 + 掩码 + 几何：米制图用拟合出的 scale/shift；没有尺度的图只做相对预览。
    prepared = []
    for array, image, entry in zip(arrays, images, per_image):
        if entry["metric"]:
            depth, mask = predict_depth(array, entry["fit"], params)
            prepared.append({"image": image, "calibration": entry, "values": depth.astype(np.float32), "mask": mask,
                             "metric": True, "edge": None, "translation": True})
        else:
            assumed, mask, assumption = preview_depth(array)
            prepared.append({"image": image, "calibration": entry, "values": assumed, "mask": mask,
                             "metric": False, "edge": array, "translation": False,
                             "assumption": assumption, "raw": array})

    counts_by_code = {code: 0 for code in MASK_NAMES}
    for item in prepared:
        for code, count in zip(*np.unique(item["mask"], return_counts=True)):
            counts_by_code[int(code)] = counts_by_code.get(int(code), 0) + int(count)
    total_pixels = int(sum(item["mask"].size for item in prepared))
    invalid_pixels = total_pixels - counts_by_code[0]

    primitives: list[dict] = []
    for item in prepared:
        image, entry = item["image"], item["calibration"]
        geometry = build_image_geometry(item["values"], item["mask"], image["intrinsics"], image["world"], params,
                                        item["metric"], item["translation"], item["edge"])
        photo_path = image["photoPath"]
        if photo_path is None:
            candidate = provenance[image["index"]]["metadata"]["sourceImage"]["path"]
            if isinstance(candidate, str) and Path(candidate).is_file():
                photo_path = Path(candidate)
        colors = sample_photo_colors(photo_path, geometry["pixels"], item["values"].shape, warnings) if params["vertexColor"] == "photo" else None
        provenance[image["index"]]["photo"] = {"path": str(photo_path) if photo_path else None, "usedForVertexColor": colors is not None}
        primitives.append({"imageIndex": image["index"], "positions": geometry["positions"], "colors": colors,
                           "triangles": geometry["triangles"], "metric": item["metric"],
                           "extras": {"units": "meters" if item["metric"] else "relative", "metric": item["metric"],
                                      "verdict": entry["verdict"], "accepted": entry["accepted"],
                                      "scale": entry["scale"], "shift": entry["shift"],
                                      **({} if item["metric"] else {"assumedMapping": item["assumption"]["assumedMapping"],
                                                                    "translationApplied": False})}})

    artifacts: list[dict] = []
    for item in prepared:
        index = item["image"]["index"]
        mask_path = output_directory / f"{request_id}-depth-mask-i{index}.npy"
        np.save(mask_path, item["mask"])
        artifacts.append({"type": f"depth.mask.npy-i{index}", "path": str(mask_path), "bytes": mask_path.stat().st_size,
                          "note": "逐像元掩码（uint8 码；含义见 geometry.metadata.json 的 mask.codes）"})
        if item["metric"]:
            depth_path = output_directory / f"{request_id}-depth-metric-i{index}.npy"
            np.save(depth_path, item["values"])
            artifacts.append({"type": f"depth.metric.npy-i{index}", "path": str(depth_path), "bytes": depth_path.stat().st_size,
                              "note": "本图标定后的**轴向**米制深度（float32；NaN=掩码非 0；不是射线距离）"})

    limits = ["只覆盖观测到的采样像元；不补看不到的背面", "照片 RGB 仅作顶点颜色，不是完整几何重建",
              "三角面不跨遮挡大跳变（像元级边检查，含对角）",
              "米制世界只收本图自己有标定的图；没有尺度的图只出相对预览，两者不混在同一个文件里"]
    common_extras = {
        "name": f"{request_id}-geometry", "schema": SCHEMA,
        "mapping": params["mapping"],
        "depthSemantics": "axial depth along the camera view axis (camera -z); meters when units=meters; not ray/euclidean distance",
        "cameraConvention": "camera x right / y up / looks -z; world = R * p_cam + t; K pixel origin top-left, x right, y down",
        "sourceUpAxis": "Y", "productWorldUpAxis": "Z",
        "axisExport": "顶点按 glTF 标准 Y-up 写出（(x,y,z)→(x,z,-y) 由产品 Z-up 世界转换）；导入方对 .glb 声明 upAxis=Y，两边成对不会多转一次轴",
        "maskCodes": MASK_CODES, "sampleStep": params["sampleStep"], "limits": limits,
    }

    metric_primitives = [item for item in primitives if item["metric"]]
    preview_primitives = [item for item in primitives if not item["metric"]]
    combined: dict | None = None
    previews: list[dict] = []
    jump_rule_m = "edge kept only if |da-db| <= max(jumpThresholdM, jumpRatio*min(da,db))（米制，按较近端）"
    jump_rule_rel = "edge kept only if |ra-rb| <= jumpRatio*max(ra,rb)（原始相对深度，越大越近，按较近端）"
    if metric_primitives:
        glb_path = output_directory / f"{request_id}-geometry-meters.glb"
        extras = {**common_extras, "units": "meters", "frame": "world（调用方声明的 registration 坐标）",
                  "images": [item["imageIndex"] for item in metric_primitives],
                  "accepted": all(entry["accepted"] for entry in per_image if entry["metric"]),
                  "verdict": worst_verdict([entry["verdict"] for entry in per_image if entry["metric"]]),
                  "jumpRule": jump_rule_m}
        glb = write_glb(glb_path, metric_primitives, extras)
        artifacts.append({"type": "geometry.meters.glb", "path": str(glb_path), "bytes": glb["bytes"],
                          "note": f"米制粗网格 GLB（只含本图自己有标定的 {len(metric_primitives)} 张图；只含观测到的采样像元，不跨遮挡跳变）"})
        combined = {"units": "meters", "frame": "world（registration.frameId）", "images": [item["imageIndex"] for item in metric_primitives],
                    "glb": {"path": str(glb_path), "bytes": glb["bytes"], "vertices": glb["vertices"], "triangles": glb["triangles"]},
                    "primitives": [{"imageIndex": item["imageIndex"], "vertices": int(item["positions"].shape[0]),
                                    "triangles": int(item["triangles"].shape[0])} for item in metric_primitives]}
        if params["writePly"]:
            ply_path = output_directory / f"{request_id}-geometry-meters.ply"
            ply = write_ply(ply_path, metric_primitives, "meters", "world (registration.frameId; Z-up product world, exported vertices Y-up)")
            artifacts.append({"type": "geometry.meters.ply", "path": str(ply_path), "bytes": ply["bytes"], "note": "点云 PLY（与米制 GLB 同一批顶点）"})
            combined["ply"] = {"path": str(ply_path), "bytes": ply["bytes"], "vertices": ply["vertices"]}
    for item in preview_primitives:
        index = item["imageIndex"]
        glb_path = output_directory / f"{request_id}-geometry-relative-preview-i{index}.glb"
        assumption = next(entry["assumption"] for entry in prepared if entry["image"]["index"] == index)
        extras = {**common_extras, "units": "relative", "frame": "camera-frame（只用 worldFromCamera.rotationMatrix 旋转；未加 positionM）",
                  "calibrated": False, "assumed": True, "notForMetricUse": True, "jumpRule": jump_rule_rel, **assumption,
                  "sceneImportNote": "仅供显示的相对预览：不是米制、没有真实世界位置，不得当作真实完整几何或度量依据"}
        glb = write_glb(glb_path, [item], extras)
        artifacts.append({"type": f"geometry.relative.preview.glb-i{index}", "path": str(glb_path), "bytes": glb["bytes"],
                          "note": "相对预览 GLB（无该图尺度：1/relative 假定 + 只旋转不平移；仅显示用）"})
        preview = {"imageIndex": index, "units": "relative", "frame": "camera-frame（rotation only）", "assumed": True,
                   "glb": {"path": str(glb_path), "bytes": glb["bytes"], "vertices": glb["vertices"], "triangles": glb["triangles"]},
                   "assumption": assumption,
                   "primitives": [{"imageIndex": index, "vertices": int(item["positions"].shape[0]),
                                   "triangles": int(item["triangles"].shape[0])}]}
        if params["writePly"]:
            ply_path = output_directory / f"{request_id}-geometry-relative-preview-i{index}.ply"
            ply = write_ply(ply_path, [item], "relative", "camera-frame (rotation only; no positionM translation)")
            artifacts.append({"type": f"geometry.relative.preview.ply-i{index}", "path": str(ply_path), "bytes": ply["bytes"],
                              "note": "相对预览点云 PLY（与预览 GLB 同一批顶点）"})
            preview["ply"] = {"path": str(ply_path), "bytes": ply["bytes"], "vertices": ply["vertices"]}
        previews.append(preview)

    calibration_json = {
        "schema": SCHEMA, "requestId": request_id,
        "mapping": params["mapping"], "model": MAPPING_MODEL, "mappingIsInverseDepth": True,
        "scaleUnit": "1/m per relative unit（逆深度空间）",
        "perImage": True,
        "images": per_image,
        "summary": {"images": len(images), "metricImages": len(metric_images), "allImagesMetric": all_metric,
                    "allImagesVerified": all_verified, "metricImageIndexes": metric_images,
                    "verdicts": {name: verdicts.count(name) for name in VERDICT_SEVERITY if verdicts.count(name)},
                    "verdict": worst_verdict(verdicts), "accepted": all_verified},
        "verdict": worst_verdict(verdicts), "accepted": all_verified, "metric": bool(metric_images),
        "toleranceRelativeError": params["checkToleranceRatio"],
        "anchors": {"train": len(anchors["train"]), "check": len(anchors["check"]),
                    "sharedAcrossImages": None},
        "acceptedMeans": "只有每张图各自都判 verified（训练锚点自洽 + 独立 check 锚点在容差内）才 accepted=true；"
                         "accepted=false 的米制产物不得当作已标定几何使用",
        "perImageRequired": "每张图各自拟合 scale/shift：单目图的相对尺度/偏置互不相同，registration.frameId 只说明世界坐标配准，"
                            "不说明深度尺度一致；某图没有自己的训练锚点时不会借用别的图的锚点，该图只出相对预览",
        "notMetricWithoutAnchors": "没有训练锚点时不做任何米制换算，也不会用 min/max 归一化冒充米",
    }
    calibration_path = output_directory / f"{request_id}-geometry-calibration.json"
    calibration_path.write_text(json.dumps(sanitize(calibration_json), ensure_ascii=False, indent=2), encoding="utf8")
    artifacts.append({"type": "geometry.calibration.json", "path": str(calibration_path), "bytes": calibration_path.stat().st_size,
                      "note": "逐图标定：每图 scale/shift、训练/独立 check 锚点各自的残差与判定"})

    report = {
        "schema": SCHEMA, "requestId": request_id, "source": request.get("source"),
        "conventions": {
            "camera": "camera x right / y up / looks -z（沿用 sim-mujoco worker 的 camera calibration 合同）",
            "world": "world = R * p_cam + t（worldFromCamera.positionM / rotationMatrix）；产品世界是 Z-up 右手系",
            "pixels": "K 像素原点左上、x 右、y 下；p_cam = [(u-cx)*d/fx, -(v-cy)*d/fy, -d]",
            "depth": "轴向深度（相机平面到点的距离，沿 -z 轴）；与射线/欧氏距离严格区分，只有 rayDistanceM 是射线距离",
            "glbAxis": "GLB 按 glTF 标准 Y-up 导出（产品 Z-up → Y-up：(x,y,z)→(x,z,-y)）；导入方声明 upAxis=Y 再转回 Z-up",
            "relativePreview": "无尺度图的预览：位置只旋转（不加 positionM），深度是 1/relative 的显示用假定，单位 relative",
        },
        "images": provenance,
        "calibration": calibration_json,
        "depth": {
            "units": units,
            "perImage": [{"imageIndex": item["image"]["index"], "units": "meters" if item["metric"] else "relative",
                          "statistics": statistics_of(item["values"])} for item in prepared],
            "statistics": statistics_of(np.concatenate([item["values"].ravel() for item in prepared])),
            "note": ("每张图各自的轴向米制深度（NaN=掩码像元）" if all_metric
                     else "无尺度图给的是 1/relative 的相对预览（显示用假定），不是米制；米制图各自用本图的 scale/shift"),
        },
        "mask": {"codes": MASK_CODES,
                 "counts": {MASK_NAMES[code]: count for code, count in counts_by_code.items()},
                 "totalPixels": total_pixels,
                 "invalidFraction": finite_or_none(invalid_pixels / max(1, total_pixels)),
                 "notes": MASK_NOTES},
        "geometry": {
            "units": units,
            "unitPolicy": "每个文件只有一个单位：米制 GLB 只含自己有标定的图（同一 registration 坐标）；无尺度图各自一份相对预览；两者不合并",
            "combined": combined,
            "relativePreviews": previews,
            "recipe": {"sampleStep": params["sampleStep"], "jumpRatio": params["jumpRatio"],
                       "jumpThresholdM": params["jumpThresholdM"],
                       "jumpRuleMeters": jump_rule_m, "jumpRuleRelative": jump_rule_rel,
                       "vertexColor": params["vertexColor"], "writePly": params["writePly"],
                       "triangulation": "每格两个三角面共享左上→右下对角；水平/垂直/对角任一像元级边无效应整格不出面"},
            "primitives": [{"imageIndex": item["imageIndex"], "units": "meters" if item["metric"] else "relative",
                            "vertices": int(item["positions"].shape[0]), "triangles": int(item["triangles"].shape[0])} for item in primitives],
            "limits": limits,
        },
        "warnings": warnings, "gaps": [],
        "outputDirectory": str(output_directory),
        "runtime": {"python": sys.version.split()[0], "numpy": np.__version__, "elapsedMs": int((time.time() - started) * 1000)},
    }
    for entry in per_image:
        if not entry["metric"]:
            report["gaps"].append(f"METRIC_NOT_AVAILABLE(images[{entry['imageIndex']}]): {entry['reason']}")
            report["gaps"].append(f"RELATIVE_PREVIEW_ONLY(images[{entry['imageIndex']}]): 该图没有自己的米制标定，"
                                  f"只出相对预览（1/relative 假定 + 只旋转不平移）；它不是米制、没有真实世界位置，"
                                  f"也不进入米制 GLB")
    if len(images) > 1:
        report["gaps"].append("REGISTRATION_TRUSTS_CALLER: 多图合并按调用方声明的 registration.frameId 视为同一坐标；本工具不做配准，也不验证该声明")
        report["gaps"].append("PER_IMAGE_CALIBRATION: 每张图的 scale/shift 由本图锚点独立拟合；frameId 相同只说明坐标已配准，不代表相对深度尺度一致")
    metadata_path = output_directory / f"{request_id}-geometry-metadata.json"
    metadata_path.write_text(json.dumps(sanitize(report), ensure_ascii=False, indent=2), encoding="utf8")
    artifacts.append({"type": "geometry.metadata.json", "path": str(metadata_path), "bytes": metadata_path.stat().st_size,
                      "note": "来源（npy/metadata/相机/锚点）、逐图标定、掩码口径、几何配方与判定"})
    return {"artifacts": artifacts, "report": report}


def main() -> int:
    try:
        request = json.loads(sys.stdin.read() or "{}")
        if not isinstance(request, dict):
            raise GeometryError("INVALID_REQUEST", "请求必须是 JSON 对象")
        output_directory = Path(str(request["outputDirectory"]))
        emit_result(run(request, output_directory))
        return 0
    except GeometryError as error:
        emit_result({"error": {"code": error.code, "message": error.message, "detail": error.detail}})
        return 1
    except Exception as error:  # 未预期失败同样结构化上报，并保留回溯到 stderr
        traceback.print_exc()
        emit_result({"error": {"code": "GEOMETRY_UNEXPECTED_ERROR", "message": str(error)}})
        return 1


if __name__ == "__main__":
    sys.exit(main())
