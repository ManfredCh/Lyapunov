"""用 S4 笛卡尔夹具的原生抓放回执准备 Mimic 示教，保持 Lab 任务状态为待验证。"""

import argparse
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory

import torch

from export_lab_recording import check_equal, tensor
from vendor.isaaclab_data.utils.datasets.hdf5_dataset_file_handler import HDF5DatasetFileHandler
from vendor.isaaclab_data.utils.math import make_pose, matrix_from_quat


JOINT_NAMES = ["x", "y", "z", "left", "right"]
TCP_OFFSET_M = (0.0, 0.0, 0.03)


def read_episode(path):
    reader = HDF5DatasetFileHandler()
    reader.open(str(path))
    try:
        name, = reader.get_episode_names()
        return reader.load_episode(name, "cpu")
    finally:
        reader.close()


def entity(frame, name):
    value, = (row for row in frame["entities"] if row["entityId"] == name)
    return value


def prepare(source, samples, evidence, output):
    manifest = json.loads(source.with_name("manifest.json").read_text())
    raw_samples = samples.read_bytes()
    if hashlib.sha256(raw_samples).hexdigest() != manifest["sourceSha256"]:
        raise ValueError("控制样本的 SHA-256 与导出清单不一致")
    rows = [json.loads(line)["sample"] for line in raw_samples.splitlines()]
    observed = json.loads(evidence.read_text())["evidence"]
    episode = read_episode(source)
    actions = episode.data["actions"]
    if not rows or len(rows) != len(observed) or len(rows) != len(actions):
        raise ValueError("控制样本、原生回执和 HDF5 的行数不一致")
    if "datagen_info" in episode.data["obs"] or "rigid_object" in episode.data["states"]:
        raise ValueError("请使用未经任务标注的 S4 导出文件")

    offset = tensor(TCP_OFFSET_M, 3)
    identity_rotation = torch.eye(3, dtype=actions.dtype)
    initial_z = entity(rows[0]["before"], "box")["transform"]["position"][2]
    first_grasp = None
    for index, (sample, receipt) in enumerate(zip(rows, observed)):
        action = tensor(sample["positions"], len(JOINT_NAMES))
        if (sample["entityId"] != "cart" or sample["jointNames"] != JOINT_NAMES
                or sample["jointUnits"] != ["m"] * len(JOINT_NAMES)
                or not torch.equal(actions[index], action)
                or receipt["result"]["actionId"] != sample["actionId"]):
            raise ValueError(f"第 {index} 行与 S4 夹具的动作或原生回执不一致")

        cart = entity(sample["before"], "cart")
        tcp = cart["sensors"]["tcp"]
        tcp_position = tensor(tcp["positionM"], 3)
        cart_xyz = tensor(cart["joints"]["positions"][:3], 3)
        if (tcp["source"] != "native-site" or tcp["site"] != "tcp" or tcp["bodyName"] != "carriage"
                or cart["joints"]["names"] != JOINT_NAMES
                or not torch.allclose(tcp_position, cart_xyz + offset, atol=1e-9, rtol=0)
                or not torch.allclose(tensor(tcp["quaternionXyzw"], 4), tensor([0, 0, 0, 1], 4),
                                      atol=1e-9, rtol=0)):
            raise ValueError(f"第 {index} 行的原生 TCP 不符合笛卡尔夹具映射")

        box_before = entity(sample["before"], "box")["transform"]
        box_after = entity(sample["after"], "box")["transform"]["position"]
        if receipt["box"] != box_after:
            raise ValueError(f"第 {index} 行的原生回执与物体终态不一致")
        pairs = {frozenset((contact["geom1"], contact["geom2"])) for contact in receipt["contacts"]
                 if contact["sourceStep"] == sample["physicsStepEnd"]}
        pad_pairs = [frozenset((f"cart/{side}-pad", "box/cube")) for side in ("left", "right")]
        both_pads = all(pair in pairs for pair in pad_pairs)

        episode.add("obs/datagen_info/eef_pose/cart", make_pose(tcp_position, identity_rotation))
        episode.add("obs/datagen_info/target_eef_pose/cart", make_pose(action[:3] + offset, identity_rotation))
        episode.add("obs/datagen_info/object_pose/box", make_pose(
            tensor(box_before["position"], 3), matrix_from_quat(tensor(box_before["quaternion"], 4))))
        # Mimic 在动作前读信号。该窗口末尾观测到的抓取从下一个窗口开始生效。
        episode.add("obs/datagen_info/subtask_term_signals/grasp_1", torch.tensor(first_grasp is not None))
        if first_grasp is None and both_pads and box_after[2] - initial_z >= 0.005:
            first_grasp = index

    if (first_grasp is None or first_grasp + 2 >= len(rows)
            or any(pair in pairs for pair in pad_pairs)
            or frozenset(("__ground", "box/cube")) not in pairs
            or not (box_after[0] > 0.02 and box_after[2] < 0.025)):
        raise ValueError("原生回执未证实完整的双指抬升与落地释放")

    episode.pre_export()
    receipt = {"sourceSha256": manifest["sourceSha256"], "recordingId": rows[0]["episodeId"],
               "sampleCount": len(rows), "graspAfterWindow": first_grasp, "placedPositionM": box_after,
               "taskValidation": "unverified", "annotation": "s4-cart-grasp-place"}
    with TemporaryDirectory(dir=output.parent) as directory:
        staged = Path(directory) / "demo.hdf5"
        writer = HDF5DatasetFileHandler()
        writer.create(str(staged))
        try:
            writer.add_env_args({"lyapunov": manifest, "lyapunovMimicPreparation": receipt})
            writer.write_episode(episode)
        finally:
            writer.close()
        check_equal(episode.data, read_episode(staged).data)
        output.hardlink_to(staged)
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "samples", "evidence", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    args = parser.parse_args()
    if args.output.suffix != ".hdf5":
        parser.error("--output 必须以 .hdf5 结尾")
    print(json.dumps(prepare(**vars(args)), ensure_ascii=False))
