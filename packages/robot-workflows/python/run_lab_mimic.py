"""复用 S7 的原生 Lab 回放和固定上游 Mimic 扩增入口。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import h5py

TASK_ID = "Lyapunov-Cart-GraspPlace-Mimic-v0"
LAB_REVISION = "e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4"


def episode_count(path, require_annotations=False):
    with h5py.File(path, "r") as source:
        episodes = source["data"]
        if json.loads(episodes.attrs["env_args"])["env_name"] != TASK_ID:
            raise ValueError(f"MIMIC_TASK_MISMATCH: expected {TASK_ID}")
        for episode in episodes.values():
            if ("initial_state" not in episode or "actions" not in episode or not len(episode["actions"])
                    or (require_annotations and "obs/datagen_info" not in episode)):
                raise ValueError("MIMIC_ANNOTATED_DATASET_REQUIRED: use the S7 preparation steps")
        return len(episodes)


def replay(dataset):
    import gymnasium as gym
    import torch
    from isaaclab.app import add_launcher_args, launch_simulation, scan
    from isaaclab.utils.datasets import HDF5DatasetFileHandler
    from isaac_lab_cart_task import CartMimicCfg, placed, register

    launcher = argparse.ArgumentParser(add_help=False)
    add_launcher_args(launcher)
    args = launcher.parse_args(["--device", "cpu", "--visualizer", "none"])
    register()
    cfg = CartMimicCfg()
    cfg.sim.device = args.device
    cfg.terminations.success = None
    rows = []

    def reset_state(value):
        if isinstance(value, dict):
            return {name: reset_state(element) for name, element in value.items()}
        return value.unsqueeze(0).to(dtype=torch.float32, device=args.device)

    with launch_simulation(cfg, args):
        scan(cfg, args)
        env = gym.make(TASK_ID, cfg=cfg).unwrapped
        reader = HDF5DatasetFileHandler()
        try:
            reader.open(str(dataset))
            for name in reader.get_episode_names():
                episode = reader.load_episode(name, env.device)
                env.reset_to(reset_state(episode.data["initial_state"]), is_relative=True, seed=7)
                initial = env.scene.get_state(is_relative=True)["rigid_object"]["box"]["root_pose"][0]
                source_initial = episode.data["initial_state"]["rigid_object"]["box"]["root_pose"]
                if not torch.allclose(initial.to(source_initial), source_initial, atol=1e-6, rtol=0):
                    raise ValueError(f"MIMIC_RESET_MISMATCH: {name}")
                peak_z = float("-inf")
                success = False
                for action in episode.data["actions"]:
                    action = action.to(dtype=torch.float32)
                    reconstructed = env.target_eef_pose_to_action(env.action_to_target_eef_pose(action), env.actions_to_gripper_actions(action))
                    if not torch.allclose(reconstructed, action, atol=1e-7, rtol=0):
                        raise ValueError(f"MIMIC_ACTION_ROUNDTRIP_MISMATCH: {name}")
                    env.step(action.unsqueeze(0))
                    peak_z = max(peak_z, float(env.scene["box"].data.root_pos_w.torch[0, 2]))
                    success = bool(placed(env)[0])
                rows.append({"episode": name, "initial": initial.tolist(),
                             "finalM": env.scene["box"].data.root_pos_w.torch[0].tolist(),
                             "maxZ": peak_z, "success": success})
        finally:
            reader.close()
            env.close()
    return rows


def augment(args, dataset, output):
    if not args.generate_script or not 1 <= args.trials <= 100:
        raise ValueError("MIMIC_GENERATION_INPUT_INVALID")
    generated = output / "mimic.hdf5"
    rejected = output / "mimic_failed.hdf5"
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parent)}
    with (output / "generate.log").open("w") as log:
        proc = subprocess.run([sys.executable, str(args.generate_script), "--external_callback", "isaac_lab_cart_task.register",
                               "--task", TASK_ID, "--visualizer", "none", "--device", "cpu", "--num_envs", "2",
                               "--generation_num_trials", str(args.trials), "--input_file", str(dataset),
                               "--output_file", str(generated)], cwd=output, env=env, stdout=log, stderr=subprocess.STDOUT)
    if proc.returncode != 0:
        with (output / "generate.log").open("rb") as log:
            log.seek(max(0, os.fstat(log.fileno()).st_size - 4000))
            print(log.read().decode(errors="replace"), file=sys.stderr)
        raise RuntimeError(f"MIMIC_GENERATE_FAILED: {proc.returncode}")
    success = episode_count(generated) if generated.exists() else 0
    failure = episode_count(rejected) if rejected.exists() else 0
    if success + failure != args.trials:
        raise RuntimeError(f"MIMIC_GENERATION_INCOMPLETE: {success} successful + {failure} failed of {args.trials}")
    return {"attempts": args.trials, "success": success, "failed": failure,
            "successfulDataset": generated.name if success else None,
            "failedDataset": rejected.name if failure else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("replay", "augment"))
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--generate-script", type=Path)
    parser.add_argument("--trials", type=int, default=10)
    args = parser.parse_args()
    output = args.output.resolve(strict=True)
    dataset = args.dataset.resolve(strict=True)
    count = episode_count(dataset, require_annotations=True)
    if count == 0:
        raise ValueError("MIMIC_ANNOTATED_DATASET_REQUIRED: no episodes")
    if args.mode == "replay":
        rows = replay(dataset)
        success = sum(row["success"] for row in rows)
        if len(rows) != count:
            raise RuntimeError("MIMIC_REPLAY_INCOMPLETE")
        detail = {"summary": {"attempts": count, "success": success, "failed": count - success}, "episodes": rows}
    else:
        detail = {"summary": augment(args, dataset, output)}
    with dataset.open("rb") as source:
        source_hash = hashlib.file_digest(source, "sha256").hexdigest()
    report = {"mode": args.mode, "task": TASK_ID, "upstreamRevision": LAB_REVISION,
              "sourceSha256": source_hash, "sourceEpisodes": count, **detail}
    (output / "result.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
