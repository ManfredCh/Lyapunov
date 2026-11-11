"""用 Isaac Sim 官方 MJCF 导入器准备 S7 夹具的五滑轨 USD。"""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import xml.etree.ElementTree as ET


JOINTS = {"x", "y", "z", "left", "right"}


def split_rails(source, output):
    tree = ET.parse(source)
    base = tree.find(".//body[@name='base']")
    carriage = base.find("body[@name='carriage']")
    parent = base
    # 官方导入器会将同一刚体上的 x/y/z 合并为多轴关节。分轨保持五个标量动作的映射。
    for name in ("x", "y"):
        joint = carriage.find(f"joint[@name='{name}']")
        carriage.remove(joint)
        rail = ET.SubElement(parent, "body", {"name": f"{name}_rail"})
        rail.append(joint)
        ET.SubElement(rail, "inertial", {"pos": "0 0 0", "mass": "0.0001", "diaginertia": "1e-6 1e-6 1e-6"})
        parent = rail
    base.remove(carriage)
    parent.append(carriage)
    tree.write(output, encoding="unicode")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source, output = args.source.resolve(strict=True), args.output.resolve()
    output.mkdir(parents=True)
    mjcf = output / "cartesian-gripper-five.xml"
    split_rails(source, mjcf)

    from isaacsim import AppFramework, __file__ as sdk_file

    repo = Path(__file__).resolve().parents[3]
    kit = repo / "packages/sim-isaac/python/physics-cpu.kit"
    argv = [str(kit), "--no-window", "--portable-root", str(output / "kit")]
    sdk = Path(sdk_file).resolve().parent
    for directory in ("exts", "extscache", "extsDeprecated"):
        argv.extend(["--ext-folder", str(sdk / directory)])
    app = AppFramework(name="lyapunov-cart-lab-asset", argv=argv)

    from omni.kit.app import get_app

    manager = get_app().get_extension_manager()
    if not manager.set_extension_enabled_immediate("isaacsim.asset.importer.mjcf", True):
        raise RuntimeError("官方 MJCF 导入扩展无法启动")
    from isaacsim.asset.importer.mjcf import MJCFImporter, MJCFImporterConfig
    from pxr import Usd, UsdPhysics

    config = MJCFImporterConfig(mjcf_path=str(mjcf), usd_path=str(output / "usd"), import_scene=False,
                                fix_base=True, run_multi_physics_conversion=True)
    asset = Path(MJCFImporter(config).import_mjcf())
    stage = Usd.Stage.Open(str(asset))
    joints = [prim.GetName() for prim in stage.Traverse() if prim.IsA(UsdPhysics.PrismaticJoint)]
    if len(joints) != len(JOINTS) or set(joints) != JOINTS:
        raise RuntimeError(f"导入关节与五滑轨合同不符：{joints}")
    receipt = {"asset": str(asset), "prismaticJoints": joints, "root": str(stage.GetDefaultPrim().GetPath()),
               "sourceSha256": sha256(source.read_bytes()).hexdigest()}
    (output / "asset.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt), flush=True)
    app.close()


if __name__ == "__main__":
    main()
