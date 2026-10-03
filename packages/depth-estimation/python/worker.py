#!/usr/bin/env python3
"""单目相对深度 worker（Depth-Anything-V2-Small，官方 transformers 适配，离线本地权重）。

与仓库内其他 Python worker 同一形态：**一次运行、一条结构化结果**。
  stdin  : 一个 JSON 请求对象
  stdout : 最后一行 `LYAPUNOV_RESULT=<json>`（成功是结果，失败是 {"error":{...}}）
  退出码 : 0=成功；非 0=失败。取消由父进程终止进程（SIGTERM），本文件不做协作取消。

输出全部是相对深度：数值来自 ReLU(conv3(...)) * config.max_depth，越大表示越近，
不是米制距离，也没有置信度。天空等 ReLU 饱和区域会得到精确的 0.0。
常量预测（std=0，例如纯色/无纹理输入）是**有效输出**，照常返回读数，不当作失败。
配置可以指向任意本地 checkpoint，但本 provider 只认 `config.depth_estimation_type == "relative"`：
米制或其它类型的权重在加载后明确报 `DEPTH_TYPE_UNSUPPORTED`，不会被当成相对反深度输出。

权重只做读取前置核查（目录/必需文件/声明的字节数），**每次推理不重算 sha256**：
下载期由 `script/fetch-model.ts` 写入清单（含哈希），需要重核时显式跑 `--verify-only` 离线核对。

单独运行示例（只在本包 venv 中）：
    <venv>/bin/python worker.py < request.json
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path

import numpy as np

SCHEMA = "lyapunov.depth-estimation/1"
RESULT_PREFIX = "LYAPUNOV_RESULT="
REQUIRED_MODEL_FILES = ("config.json", "preprocessor_config.json", "model.safetensors")
MANIFEST_FILE = "lyapunov-model-manifest.json"
DEFAULT_MODEL_INPUT_SIZE = 518
PATCH_SIZE = 14
DEFAULT_PREVIEW_MAX_SIDE = 1024
DEFAULT_LOW_PERCENTILE = 2.0
DEFAULT_HIGH_PERCENTILE = 98.0
SCALE_NOTE = "模型相对尺度：ReLU(conv3) * config.max_depth；不同实现/权重的绝对数值不可比，也不是米"
ARTIFACT_SPECS = {
    "depth.image.npy": ("{request}-depth.npy", "原图尺寸的相对深度（float32，数值越大越近，未归一化）"),
    "depth.model.npy": ("{request}-depth-model.npy", "模型输出尺寸的原始相对深度（float32，未插值、未归一化）"),
    "depth.preview.png": ("{request}-depth.png", "灰度预览：亮度=近，仅用于显示"),
    "depth.preview.color.png": ("{request}-depth-color.png", "彩色预览：亮度=近，仅用于显示"),
    "depth.metadata.json": ("{request}-depth-metadata.json", "尺寸/预处理/模型身份/数值统计"),
}


class WorkerError(RuntimeError):
    """带结构化错误码的失败；code 会原样出现在结果行里。"""

    def __init__(self, code: str, message: str, detail=None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.detail = detail


def emit_result(payload: dict) -> None:
    """只打一行结果；父进程按前缀取用，其他日志（如有）不得使用该前缀。"""
    sys.stdout.write(RESULT_PREFIX + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_manifest(model_directory: str | Path) -> dict | None:
    """权重来源清单（由 script/fetch-model.ts 写入）。缺失返回 None，不猜 revision。"""
    path = Path(model_directory) / MANIFEST_FILE
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text("utf8"))
    except Exception:
        return {"_invalid": "manifest 不是合法 JSON"}
    return value if isinstance(value, dict) else None


def check_model_directory(model_directory: str | Path) -> dict:
    """只读核查权重目录：必需文件存在且非空，清单给出 revision/license（哈希不在推理期重算）。"""
    directory = Path(model_directory)
    if not directory.is_dir():
        raise WorkerError("MODEL_DIRECTORY_MISSING", f"权重目录不存在: {directory}")
    files = {}
    for name in REQUIRED_MODEL_FILES:
        target = directory / name
        if not target.is_file() or target.stat().st_size == 0:
            raise WorkerError("MODEL_FILES_MISSING", f"权重文件缺失或为空: {target}")
        files[name] = {"bytes": target.stat().st_size}
    manifest = load_manifest(directory)
    declared = (manifest or {}).get("files") or {}
    for name, entry in declared.items():
        local = directory / name
        if name in REQUIRED_MODEL_FILES and local.is_file() and int(entry.get("bytes", -1)) != local.stat().st_size:
            raise WorkerError("MODEL_FILE_SIZE_MISMATCH", f"{name} 与清单字节数不一致: {local.stat().st_size} != {entry.get('bytes')}")
    return {"directory": str(directory.resolve()), "files": files, "manifest": manifest}


def validate_depth_array(depth, label: str) -> np.ndarray:
    """写任何产物前的数值前置检查：必须二维、非空、全 finite。

    运行层（TS）按最薄层约定不再扫描 npy，所以"数组本身可用"只能在这里保证。含**部分**
    NaN/Inf 的输出必须显式失败，而不是把非有限值过滤掉继续算：分位点/插值遇到 NaN 会静默
    产出坏图，插图层的 bicubic 还会把单个 NaN 抹成一大片。常量预测（std=0）是有效输出，
    不在这里拒绝。
    """
    array = np.asarray(depth)
    if not np.issubdtype(array.dtype, np.floating):
        raise WorkerError("DEPTH_VALUES_INVALID", f"{label}不是浮点数组: dtype={array.dtype}")
    if array.ndim != 2:
        raise WorkerError("DEPTH_VALUES_INVALID", f"{label}必须是二维数组: ndim={array.ndim}, shape={array.shape}")
    if array.size == 0:
        raise WorkerError("DEPTH_VALUES_INVALID", f"{label}为空数组: shape={array.shape}")
    if not bool(np.isfinite(array).all()):
        non_finite = int(np.count_nonzero(~np.isfinite(array)))
        raise WorkerError("DEPTH_VALUES_INVALID", f"{label}含非有限值: {non_finite}/{array.size} 个 NaN/Inf（整幅拒绝，不做过滤）")
    return array


def compute_statistics(depth: np.ndarray) -> dict:
    """真实数值统计；不使用任何置信度或误差估计。0.0 占比说明 ReLU 饱和（天空等）范围。

    调用方必须已通过 validate_depth_array（本函数自己也再查一遍）：统计量在**整幅**数组上计算，
    不丢弃任何像素，所以含 NaN/Inf 的输出不会被"只统计有限值"掩盖。
    """
    flat = validate_depth_array(depth, "深度数组").astype(np.float64).ravel()
    return {
        "min": float(flat.min()),
        "max": float(flat.max()),
        "mean": float(flat.mean()),
        "std": float(flat.std()),
        "percentiles": {
            "p2": float(np.percentile(flat, 2.0)),
            "p50": float(np.percentile(flat, 50.0)),
            "p98": float(np.percentile(flat, 98.0)),
        },
        "zeroFraction": float((flat == 0.0).mean()),
        # 非有限值在 validate_depth_array 处整幅拒绝，能走到这里的数组恒为 0 个。
        "nonFiniteCount": 0,
        "validPixels": int(flat.size),
        # 常量预测是有效输出（纯色/无纹理输入可能如此），标出来是为了让上层能如实展示，不阻断。
        "constant": bool(flat.size and float(flat.std()) == 0.0),
    }


def spatial_diagnostic(depth: np.ndarray) -> dict:
    """上带/下带中位数与深度的纵向相关系数。只说明"有空间结构"，不是正确性证明。"""
    height = depth.shape[0]
    band = max(1, height // 4)
    top = float(np.median(depth[:band]))
    bottom = float(np.median(depth[-band:]))
    rows = np.repeat(np.linspace(-1.0, 1.0, height), depth.shape[1])
    values = depth.ravel().astype(np.float64)
    if values.std() == 0:
        correlation = 0.0
    else:
        correlation = float(np.corrcoef(rows, values)[0, 1])
    return {
        "topBandMedian": top,
        "bottomBandMedian": bottom,
        "verticalPearsonR": correlation,
        "note": "诊断量：仅说明深度图存在空间结构；相对深度下“越大越近”，不代表米制正确",
    }


def normalize_preview(depth: np.ndarray, low: float, high: float) -> np.ndarray:
    """按分位点裁剪归一到 0..1，只用于显示；npy 保留原始相对数值。"""
    low_value, high_value = np.percentile(depth, low), np.percentile(depth, high)
    if high_value <= low_value:
        low_value, high_value = float(depth.min()), float(depth.max())
    if high_value <= low_value:
        return np.zeros_like(depth, dtype=np.float32)
    return np.clip((depth.astype(np.float32) - low_value) / (high_value - low_value), 0.0, 1.0)


# 显示用色标锚点（暗紫→橙→亮黄），仅用于可视化，不影响数值语义。
COLOR_ANCHORS = np.array([
    [0.001, 0.000, 0.014], [0.113, 0.058, 0.247], [0.316, 0.071, 0.485],
    [0.549, 0.161, 0.506], [0.750, 0.278, 0.400], [0.925, 0.428, 0.245],
    [0.993, 0.601, 0.059], [0.987, 0.825, 0.358], [0.988, 0.998, 0.645],
], dtype=np.float32)


def colorize(normalized: np.ndarray) -> np.ndarray:
    """把 0..1 的归一化深度映射成 RGB uint8（线性插值色标）。"""
    position = np.clip(normalized, 0.0, 1.0) * (len(COLOR_ANCHORS) - 1)
    index = np.clip(np.floor(position).astype(np.int64), 0, len(COLOR_ANCHORS) - 2)
    fraction = (position - index)[..., None]
    colors = COLOR_ANCHORS[index] * (1.0 - fraction) + COLOR_ANCHORS[index + 1] * fraction
    return np.clip(colors * 255.0 + 0.5, 0, 255).astype(np.uint8)


def plan_preview_size(width: int, height: int, max_side: int) -> tuple[int, int]:
    """预览尺寸：长边不超过 max_side，保持纵横比，至少 1 像素。"""
    if max(width, height) <= max_side:
        return width, height
    scale = max_side / max(width, height)
    return max(1, round(width * scale)), max(1, round(height * scale))


def save_preview_pngs(gray_path: str, color_path: str, normalized: np.ndarray, preview_size: tuple[int, int], description: str) -> dict:
    """写灰度与彩色两张预览 PNG；都带说明文本，避免被当成米制或测量证据。"""
    from PIL import Image, PngImagePlugin

    info = PngImagePlugin.PngInfo()
    info.add_text("Description", description)
    info.add_text("Software", f"lyapunov depth-estimation worker ({SCHEMA})")
    gray = Image.fromarray((np.clip(normalized, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), mode="L").resize(preview_size, Image.BICUBIC)
    color = Image.fromarray(colorize(normalized), mode="RGB").resize(preview_size, Image.BICUBIC)
    gray.save(gray_path, format="PNG", pnginfo=info)
    color.save(color_path, format="PNG", pnginfo=info)
    return {"width": gray.size[0], "height": gray.size[1]}


def resize_depth(depth, target_height: int, target_width: int) -> np.ndarray:
    """把模型输出分辨率插值到目标尺寸（官方示例同样用 bicubic / align_corners=False）。"""
    import torch

    tensor = depth if torch.is_tensor(depth) else torch.as_tensor(depth)
    if tensor.dim() == 2:
        tensor = tensor[None, None]
    elif tensor.dim() == 3:
        tensor = tensor[:, None]
    resized = torch.nn.functional.interpolate(tensor.float(), size=(target_height, target_width), mode="bicubic", align_corners=False)
    return resized[0, 0].cpu().numpy().astype(np.float32)


def resolve_device(requested: str):
    import torch

    if requested == "cuda" and not torch.cuda.is_available():
        raise WorkerError("DEVICE_UNAVAILABLE", "请求 cuda 但当前环境不可用；显式失败，不静默回退 CPU")
    return requested


def run_inference(request: dict, artifacts: Path) -> dict:
    import torch
    from PIL import Image, ImageOps
    from transformers import AutoImageProcessor, DepthAnythingForDepthEstimation

    started = time.time()
    request_id = str(request["requestId"])
    params = request.get("params") or {}
    device = resolve_device(str(params.get("device", "cpu")))
    model_input_size = int(params.get("modelInputSize", DEFAULT_MODEL_INPUT_SIZE))
    preview_max_side = int(params.get("previewMaxSide", DEFAULT_PREVIEW_MAX_SIDE))
    low_percentile = float(params.get("lowPercentile", DEFAULT_LOW_PERCENTILE))
    high_percentile = float(params.get("highPercentile", DEFAULT_HIGH_PERCENTILE))
    model = check_model_directory(request["model"]["directory"])
    image_path = Path(request["image"]["path"])
    if not image_path.is_file():
        raise WorkerError("IMAGE_UNREADABLE", f"输入图像不存在: {image_path}")

    manifest = model["manifest"] if isinstance(model.get("manifest"), dict) and "_invalid" not in model["manifest"] else None
    weights = Path(model["directory"]) / "model.safetensors"
    # 推理期**不重算权重哈希**（150MB 权重每次多读一遍毫无产出）：清单哈希是下载期写下的，
    # 需要重核时用 `script/fetch-model.ts --verify-only` 显式离线核对，revision 仍以清单为来源。
    declared_sha = ((manifest or {}).get("files") or {}).get("model.safetensors", {}).get("sha256")

    threads = int(os.environ.get("LYAPUNOV_DEPTH_THREADS", min(8, os.cpu_count() or 1)))
    torch.set_num_threads(max(1, threads))
    # 关掉权重加载进度条：它走 stderr，会让每一轮正常运行都多出一份无信息的 stderr 日志。
    try:
        from transformers.utils import logging as transformers_logging

        transformers_logging.disable_progress_bar()
    except Exception:  # 只有日志格式变化时才会走到；不因为没有这个开关而失败
        pass
    processor = AutoImageProcessor.from_pretrained(model["directory"], local_files_only=True)
    network = DepthAnythingForDepthEstimation.from_pretrained(model["directory"], local_files_only=True)
    # 权重目录可以是任意本地 checkpoint，所以语义必须从 checkpoint 自己读出来核对：
    # 本 provider 的读取契约（metadata 写死 relative/越大越近）只对 relative 成立。
    depth_type = str(getattr(network.config, "depth_estimation_type", "") or "unknown")
    if depth_type != "relative":
        raise WorkerError(
            "DEPTH_TYPE_UNSUPPORTED",
            f"该 checkpoint 的 depth_estimation_type={depth_type}；本 provider 只支持 relative（相对反深度、越大越近），"
            "不会把米制或其它类型的权重当成相对深度输出",
            {"depthEstimationType": depth_type, "supported": ["relative"], "directory": model["directory"]},
        )
    network.eval().to(device)
    load_ms = int((time.time() - started) * 1000)

    with Image.open(image_path) as opened:
        # 记录 EXIF 方向标签本身：180°/镜像等方向不改变尺寸，用尺寸差判断会漏报。
        try:
            exif_orientation = int(opened.getexif().get(0x0112, 1) or 1)
        except Exception:
            exif_orientation = 1
        rgb = ImageOps.exif_transpose(opened).convert("RGB")
    input_width, input_height = rgb.size

    inference_started = time.time()
    inputs = processor(images=rgb, size={"height": model_input_size, "width": model_input_size}, return_tensors="pt")
    pixel_values = inputs["pixel_values"]
    processed_height, processed_width = int(pixel_values.shape[-2]), int(pixel_values.shape[-1])
    if processed_height % PATCH_SIZE or processed_width % PATCH_SIZE:
        raise WorkerError("PREPROCESS_SIZE_INVALID", f"预处理尺寸不是 {PATCH_SIZE} 的倍数: {processed_width}x{processed_height}")
    with torch.no_grad():
        outputs = network(pixel_values.to(device))
    predicted = outputs.predicted_depth
    if predicted.dim() == 3:
        predicted = predicted[0]
    model_depth = predicted.detach().float().cpu().numpy().astype(np.float32)
    # 先查模型原生输出再插值：NaN 一旦进了 bicubic 会被抹开，那时候已经看不出是哪一步坏的。
    validate_depth_array(model_depth, "模型原生输出")
    inference_ms = int((time.time() - inference_started) * 1000)

    full_depth = resize_depth(model_depth, input_height, input_width)
    validate_depth_array(full_depth, "原图尺寸深度")
    statistics = compute_statistics(full_depth)
    diagnostic = spatial_diagnostic(full_depth)
    preview_width, preview_height = plan_preview_size(input_width, input_height, preview_max_side)
    normalized_full = normalize_preview(full_depth, low_percentile, high_percentile)

    revision = None if manifest is None else manifest.get("revision")
    description = (
        f"Depth-Anything-V2-Small 相对深度（非米制）；亮度越大越近；按 p{low_percentile:g}..{high_percentile:g} 归一化；"
        f"模型 revision {revision or 'unknown'}；输入 {input_width}x{input_height}；模型输出 {processed_width}x{processed_height}"
    )
    targets = {kind: artifacts / template.format(request=request_id) for kind, (template, _) in ARTIFACT_SPECS.items()}
    np.save(targets["depth.image.npy"], full_depth)
    np.save(targets["depth.model.npy"], model_depth)
    save_preview_pngs(str(targets["depth.preview.png"]), str(targets["depth.preview.color.png"]), normalized_full, (preview_width, preview_height), description)

    sizes = {
        "input": {"width": input_width, "height": input_height},
        "modelInput": {"width": processed_width, "height": processed_height},
        "modelOutput": {"width": int(model_depth.shape[1]), "height": int(model_depth.shape[0])},
        "fullDepth": {"width": int(full_depth.shape[1]), "height": int(full_depth.shape[0])},
        "preview": {"width": preview_width, "height": preview_height},
    }
    metadata = {
        "schema": SCHEMA,
        "provider": "depth-anything-v2",
        "requestId": request_id,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "image": {"path": str(image_path.resolve()), "bytes": image_path.stat().st_size, "width": input_width, "height": input_height, "mode": "RGB"},
        "sizes": sizes,
        "preprocessing": {
            "resizeMode": "keep_aspect_ratio",
            "size": {"height": model_input_size, "width": model_input_size},
            "ensureMultipleOf": PATCH_SIZE,
            "resample": "bicubic (PIL resample=3)",
            "rescaleFactor": float(getattr(processor, "rescale_factor", 1.0 / 255.0)),
            "imageMean": [float(value) for value in getattr(processor, "image_mean", [])],
            "imageStd": [float(value) for value in getattr(processor, "image_std", [])],
            "inputToModelScale": round(processed_width / input_width, 6),
            "exifOrientationApplied": exif_orientation != 1,
            "exifOrientation": exif_orientation,
            "processorClass": type(processor).__name__,
            "parameters": {"modelInputSize": model_input_size},
        },
        "model": {
            "modelId": (manifest or {}).get("modelId") or "unknown-local-checkpoint",
            "revision": revision,
            "revisionSource": "manifest" if revision else "unavailable",
            "license": (manifest or {}).get("license"),
            "architecture": "DepthAnythingForDepthEstimation",
            # 清单自述值（下载期写入），不是本次推理重算的读数；没清单就是 None。
            "weightsSha256": declared_sha or None,
            "weightsBytes": weights.stat().st_size,
            "directory": model["directory"],
            "maxDepthConfig": float(getattr(network.config, "max_depth", 0.0)),
            "depthEstimationType": str(getattr(network.config, "depth_estimation_type", "unknown")),
        },
        "depth": {
            "relative": True,
            "metric": False,
            "largerMeans": "closer",
            "scale": SCALE_NOTE,
            "dtype": "float32",
            "statistics": statistics,
            "interpolation": {
                "mode": "bicubic",
                "alignCorners": False,
                "from": {"width": int(model_depth.shape[1]), "height": int(model_depth.shape[0])},
                "to": {"width": input_width, "height": input_height},
                "note": "放大到原图尺寸只做插值：会引入轻微欠冲（可出现极小负值），模型原生输出见 depth.model.npy",
            },
        },
        "spatialDiagnostic": diagnostic,
        "visualization": {
            "normalization": "percentile-clip", "lowPercentile": low_percentile, "highPercentile": high_percentile,
            "brightMeans": "closer", "files": [str(targets["depth.preview.png"]), str(targets["depth.preview.color.png"])],
            "note": "预览仅用于查看：归一只影响显示，npy 保留原始相对数值",
        },
        "runtime": {
            "python": sys.version.split()[0],
            "packages": {"torch": torch.__version__, "transformers": __import__("transformers").__version__, "numpy": np.__version__},
            "device": device,
            "cpuThreads": threads,
            "timingsMs": {"modelLoad": load_ms, "inference": inference_ms, "totalSoFar": int((time.time() - started) * 1000)},
        },
        "source": request.get("source"),
    }
    targets["depth.metadata.json"].write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf8")
    # 产物只报路径与字节数：推理期不再把每个产物（原图尺寸 npy 可达几十 MB）重读一遍算哈希。
    artifacts_payload = [
        {"type": kind, "path": str(targets[kind]), "bytes": targets[kind].stat().st_size, "note": note}
        for kind, (_, note) in ARTIFACT_SPECS.items()
    ]
    return {"artifacts": artifacts_payload, "metadata": metadata}


def main() -> int:
    try:
        request = json.loads(sys.stdin.read() or "{}")
        if not isinstance(request, dict):
            raise WorkerError("INVALID_REQUEST", "请求必须是 JSON 对象")
        artifacts = Path(str(request["outputDirectory"]))
        artifacts.mkdir(parents=True, exist_ok=True)
        emit_result(run_inference(request, artifacts))
        return 0
    except WorkerError as error:
        emit_result({"error": {"code": error.code, "message": error.message, "detail": error.detail}})
        return 1
    except Exception as error:  # 未预期失败同样结构化上报，并保留回溯到 stderr
        traceback.print_exc()
        emit_result({"error": {"code": "WORKER_UNEXPECTED_ERROR", "message": str(error)}})
        return 1


if __name__ == "__main__":
    sys.exit(main())
