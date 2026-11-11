"""调用固定 SimFoundry 转件器，准备 SceneKit 可读取的派生 USD。"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

from pxr import Sdf, Usd, UsdGeom, UsdPhysics, UsdShade, UsdUtils

sys.path.insert(0, str(Path(__file__).with_name("vendor") / "simfoundry"))
from asset_import import convert_mesh

REVISION = "9e34ebefcd020583fbb755a8b57268dce78eca26"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--scale", type=float, required=True)
    parser.add_argument("--up-axis", choices=("y", "z"), required=True)
    parser.add_argument("--mass", type=float, required=True)
    parser.add_argument("--collision", choices=("convexHull", "convexDecomposition"), required=True)
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    output = args.output.resolve(strict=True)
    if source.suffix.lower() != ".glb" or any(output.iterdir()):
        parser.error("需要 GLB 与空的作业输出目录")
    with source.open("rb") as stream:
        source_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    path, summary = convert_mesh(source, output, "asset", scale=args.scale,
                                 up_axis=args.up_axis, mass=args.mass, collision=args.collision)
    stage = Usd.Stage.Open(str(path))
    materials = [prim.GetPath() for prim in stage.Traverse() if prim.IsA(UsdShade.Material)]
    for material in materials:
        # 固定转换器同时写 PreviewSurface 和裸路径 OmniPBR.mdl。后者在离线闭包中未解析。
        stage.GetPrimAtPath(material).RemoveProperty("outputs:mdl:surface")
        stage.RemovePrim(material.AppendChild("mdl_shader"))
    UsdPhysics.SetStageKilogramsPerUnit(stage, 1.0)
    stage.GetRootLayer().Save()
    layers, assets, unresolved = UsdUtils.ComputeAllDependencies(Sdf.AssetPath(str(path)))
    closure = [layer.realPath for layer in layers] + list(assets)
    if unresolved or any(not Path(item).resolve().is_relative_to(output) for item in closure):
        raise ValueError(f"SIMFOUNDRY_USD_DEPENDENCY_INVALID: {unresolved}")
    report = {"rootUsd": str(path.relative_to(output)), "sourceSha256": source_hash,
              "upstreamRevision": REVISION, "summary": summary, "metersPerUnit": UsdGeom.GetStageMetersPerUnit(stage),
              "kilogramsPerUnit": UsdPhysics.GetStageKilogramsPerUnit(stage), "upAxis": str(UsdGeom.GetStageUpAxis(stage))}
    (output / "result.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
