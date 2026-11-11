"""把预标注示教和原生控制帧组装为 S7 Lab 任务数据集。"""

import argparse
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory

import h5py
import torch

from export_lab_recording import tensor
from prepare_cart_mimic_demo import entity, read_episode
from vendor.isaaclab_data.utils.datasets.hdf5_dataset_file_handler import HDF5DatasetFileHandler


TASK_ID = "Lyapunov-Cart-GraspPlace-Mimic-v0"


def velocity(row):
    sensors = row["sensors"]
    return tensor(sensors["bodyLinearVelocityMps"] + sensors["bodyAngularVelocityRadps"], 6)


def pose(row):
    transform = row["transform"]
    return tensor(transform["position"] + transform["quaternion"], 7)


def to_sim_dtype(value):
    if isinstance(value, dict):
        return {key: to_sim_dtype(item) for key, item in value.items()}
    return value.to(torch.float32) if value.is_floating_point() else value


def complete_state(episode, frames, key, stack):
    state = episode.data[key]
    cart = [entity(frame, "cart") for frame in frames]
    box = [entity(frame, "box") for frame in frames]
    state["articulation"]["cart"]["root_velocity"] = stack([velocity(row) for row in cart])
    state["rigid_object"] = {"box": {"root_velocity": stack([velocity(row) for row in box]),
                                      "root_pose": stack([pose(row) for row in box])}}


def assemble(demos, output):
    sources = []
    seen = set()
    with TemporaryDirectory(dir=output.parent) as directory:
        staged = Path(directory) / "dataset.hdf5"
        writer = HDF5DatasetFileHandler()
        writer.create(str(staged), TASK_ID)
        try:
            for prepared, native in demos:
                raw = native.read_bytes()
                with h5py.File(prepared) as data:
                    metadata = json.loads(data["data"].attrs["env_args"])["lyapunovMimicPreparation"]
                digest = sha256(raw).hexdigest()
                recording = metadata["recordingId"]
                if digest != metadata["sourceSha256"] or recording in seen:
                    raise ValueError(f"示教来源不一致或重复：{prepared}")
                samples = [json.loads(line)["sample"] for line in raw.splitlines()]
                episode = read_episode(prepared)
                if (len(samples) != metadata["sampleCount"] or len(samples) != len(episode.data["actions"])
                        or any(sample["episodeId"] != recording for sample in samples)):
                    raise ValueError(f"示教控制样本与预标注不一致：{prepared}")
                complete_state(episode, [samples[0]["before"]], "initial_state", lambda values: values[0])
                complete_state(episode, [sample["after"] for sample in samples], "states", torch.stack)
                episode.data = to_sim_dtype(episode.data)
                episode.success = True
                writer.write_episode(episode)
                seen.add(recording)
                sources.append({"recordingId": recording, "sourceSha256": digest, "controlFrames": len(samples)})
            writer.add_env_args({"sourceEngine": "MuJoCo", "sourcePhysicalSuccess": True,
                                 "targetEngineValidation": "unverified", "sources": sources})
        finally:
            writer.close()
        output.hardlink_to(staged)
    return sources


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo", type=Path, nargs=2, action="append", required=True,
                        metavar=("PREPARED_HDF5", "CONTROL_SAMPLES_JSONL"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.suffix != ".hdf5":
        parser.error("--output 必须以 .hdf5 结尾")
    print(json.dumps(assemble(args.demo, args.output), ensure_ascii=False))
