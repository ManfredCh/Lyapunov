"""对本地已准备素材运行固定的 SimFoundry Stage 8，并读取真实候选。"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


REVISION = "9e34ebefcd020583fbb755a8b57268dce78eca26"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--stage-script", type=Path, required=True)
    parser.add_argument("--object-index", type=int, required=True)
    parser.add_argument("--mesh-backend", required=True)
    args = parser.parse_args()
    scene = args.source.resolve(strict=True)
    output = args.output.resolve(strict=True)
    stage = args.stage_script.resolve(strict=True)
    upstream = stage.parents[4]
    argv = [sys.executable, str(stage), "root_dir=" + json.dumps(str(scene.parent)),
            "scene_name=" + json.dumps(scene.name), "s8_pose.out_dir=" + json.dumps(str(output / "s8_pose")),
            "hydra.run.dir=" + json.dumps(str(output / "hydra")), "visualize=false", "s3_ground.use_fs=false",
            "s7_mesh.texture_model=" + args.mesh_backend, "s7_mesh.shape_model=" + args.mesh_backend,
            f"s8_pose.object_indices=[{args.object_index}]", "s8_pose.use_foundationpose=false",
            "s8_pose.canonicalize_front=false", "s8_pose.front_refine=false"]
    with (output / "stage8.log").open("w") as log:
        proc = subprocess.run(argv, cwd=output, env={**os.environ, "PYTHONPATH": str(upstream)},
                              stdout=log, stderr=subprocess.STDOUT)
    if proc.returncode != 0:
        with (output / "stage8.log").open("rb") as log:
            log.seek(max(0, os.fstat(log.fileno()).st_size - 4000))
            print(log.read().decode(errors="replace"), file=sys.stderr)
        raise RuntimeError(f"SIMFOUNDRY_STAGE8_FAILED: {proc.returncode}")
    candidates, rejected = [], []
    for path in sorted((output / "s8_pose/info").glob("*.json")):
        row = json.loads(path.read_text())
        record = {"file": str(path.relative_to(output)), **row}
        (candidates if "z_up" in row else rejected).append(record)
    if not candidates and not rejected:
        raise ValueError("SIMFOUNDRY_POSE_OUTPUT_MISSING: check the selected object index")
    report = {"upstreamRevision": REVISION, "objectIndex": args.object_index, "meshBackend": args.mesh_backend,
              "summary": {"candidates": len(candidates), "rejected": len(rejected)},
              "candidates": candidates, "rejected": rejected}
    (output / "result.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
