"""在独立 Isaac Kit 中按同机位参考帧渲染并评估 NuRec 场景。"""

import argparse
from hashlib import file_digest
import json
import os
from pathlib import Path
import sys
from time import monotonic
import traceback
from types import ModuleType


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--references", type=Path, required=True, help="相机名/纳秒时间戳.png 或 jpg")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--camera", action="append", required=True)
    parser.add_argument("--shader-cache", type=Path)
    parser.add_argument("--samples", type=int, default=10)
    parser.add_argument("--warmup-steps", type=int, default=64)
    parser.add_argument("--resolution", type=int, nargs=2, metavar=("WIDTH", "HEIGHT"), default=(960, 600))
    args = parser.parse_args()
    if (args.samples < 1 or args.warmup_steps < 1
            or min(args.resolution) < 16 or max(args.resolution) > 4096):
        parser.error("采样数和预热步数须为正，分辨率须在 16–4096")
    stage = args.stage.resolve(strict=True)
    references = args.references.resolve(strict=True)
    if not stage.is_file() or not references.is_dir():
        parser.error("需要本地 USD 场景文件与参考图目录")
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()):
        parser.error("需要空的输出目录")
    output.mkdir(parents=True, exist_ok=True)
    cache = args.shader_cache.resolve() if args.shader_cache else output / "shader-cache"
    for name in ("shadercache", "nv_shadercache"):
        (cache / name).mkdir(parents=True, exist_ok=True)
    for key, name in (("XDG_CACHE_HOME", "cache"), ("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data")):
        os.environ[key] = str(output / name)

    from isaacsim import SimulationApp, __file__ as sdk_file

    sdk = Path(sdk_file).resolve().parent
    kit = Path(__file__).resolve().parents[2] / "sim-isaac/python/physics-rtx.kit"
    extra = ["--portable-root", str(output / "kit"), "--enable", "omni.rtx.spg",
             "--/renderer/multiGpu/enabled=false", "--/telemetry/enableAnonymousData=false",
             "--/privacy/usage=false", "--/privacy/performance=false",
             "--/rtx/shaderDb/shaderCachePath=" + str(cache / "shadercache"),
             "--/rtx/shaderDb/driverShaderCachePath=" + str(cache / "nv_shadercache")]
    for directory in ("exts", "extscache", "extsDeprecated", "extsUser"):
        extra.extend(["--ext-folder", str(sdk / directory)])
    kit_start = monotonic()
    app = SimulationApp({"headless": True, "renderer": "RaytracedLighting", "multi_gpu": False,
                         "enable_crashreporter": False, "limit_cpu_threads": 4, "extra_args": extra}, str(kit))
    kit_seconds = monotonic() - kit_start
    try:
        package = ModuleType("isaacsim.replicator.nurec_utils")
        package.__path__ = [str(Path(__file__).resolve().with_name("vendor") / "nurec_utils")]
        sys.modules[package.__name__] = package

        from isaacsim.replicator.nurec_utils.eval import evaluate, read_gt_timestamps
        from isaacsim.replicator.nurec_utils.render import render_keyframes
        from isaacsim.replicator.nurec_utils.rendering_setup import classify_stage
        from isaacsim.replicator.nurec_utils.usd_utils import subsample
        import omni.usd
        from pxr import UsdGeom

        cameras = set(args.camera)
        available = read_gt_timestamps(str(references), cameras)
        if set(available) != cameras:
            raise ValueError(f"参考帧缺失的相机：{sorted(cameras - set(available))}")
        selected = {camera: subsample(timestamps, args.samples) for camera, timestamps in available.items()}
        render_start = monotonic()
        manifest = render_keyframes(app, str(stage), str(output / "render"), selected,
                                    warmup_steps=args.warmup_steps, resolution=tuple(args.resolution))
        render_seconds = monotonic() - render_start
        if manifest is None:
            raise RuntimeError("官方渲染入口没有产出帧")
        opened_stage = omni.usd.get_context().get_stage()
        kinds = classify_stage(opened_stage)
        if not kinds.is_nurec:
            raise ValueError("场景没有 NuRec 粒子场或体积")
        score_start = monotonic()
        summary = evaluate(manifest, str(references), out_dir=str(output / "eval"))
        score_seconds = monotonic() - score_start
        count = sum(map(len, selected.values()))
        if not summary or summary["overall"]["n"] != count or summary["n_skipped"]:
            raise RuntimeError("参考帧与渲染帧未完整配对")
        with stage.open("rb") as stream:
            source_hash = file_digest(stream, "sha256").hexdigest()
        result = {"stage": str(stage), "stageSha256": source_hash, "references": str(references),
                  "manifest": manifest, "selectedTimestampsNs": selected, "resolution": args.resolution,
                  "warmupSteps": args.warmup_steps, "metrics": summary,
                  "timingSeconds": {"kitStartup": kit_seconds, "render": render_seconds, "evaluate": score_seconds},
                  "stageKinds": kinds._asdict(), "upAxis": UsdGeom.GetStageUpAxis(opened_stage),
                  "metersPerUnit": UsdGeom.GetStageMetersPerUnit(opened_stage),
                  "upstreamRevision": "045ca8b59622b99a408092124377c66346e8d9c2"}
        (output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(result, ensure_ascii=False), flush=True)
    except Exception:
        traceback.print_exc()
        app.close(exit_code=1)
        raise
    app.close()


if __name__ == "__main__":
    main()
