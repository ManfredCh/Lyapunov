"""Prepare the INRIA Go2 ONNX policy as a MuJoCo position-PD adapter.

The source MJCF and policy directory are read-only inputs.  This helper only
creates a derived MJCF and prints one JSON ``PreparedAdapter`` object.
"""
from __future__ import annotations

import copy
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import mujoco
import numpy as np


ISAAC_JOINTS = [
    "FL_hip_joint", "FR_hip_joint", "RL_hip_joint", "RR_hip_joint",
    "FL_thigh_joint", "FR_thigh_joint", "RL_thigh_joint", "RR_thigh_joint",
    "FL_calf_joint", "FR_calf_joint", "RL_calf_joint", "RR_calf_joint",
]
Q0 = [0.1, -0.1, 0.1, -0.1, 0.8, 0.8, 1.0, 1.0, -1.5, -1.5, -1.5, -1.5]
FEET = ["FL", "FR", "RL", "RR"]
PHYSICS_FIELDS = [
    "body_mass", "body_inertia", "geom_type", "geom_size", "geom_contype",
    "geom_conaffinity", "geom_friction", "jnt_range", "jnt_actfrcrange",
    "actuator_gear",
]


def _qpos_for_q0(model: mujoco.MjModel) -> list[float]:
    """Return a free-base qpos at the author's standing pose."""
    qpos = np.zeros(model.nq, dtype=np.float64)
    # The public Go2 MJCF has a free base; retain its canonical standing height.
    qpos[:7] = [0.0, 0.0, 0.27, 1.0, 0.0, 0.0, 0.0]
    joint_index = {}
    for jid in range(model.njnt):
        name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT, jid)
        if name:
            joint_index[name] = int(model.jnt_qposadr[jid])
    if set(ISAAC_JOINTS) - set(joint_index):
        raise RuntimeError("GO2_MJCF_MISSING_POLICY_JOINT")
    for name, angle in zip(ISAAC_JOINTS, Q0):
        qpos[joint_index[name]] = angle
    return qpos.tolist()


def _append_policy_keyframe(root: ET.Element, qpos: list[float]) -> None:
    keyframe = root.find("keyframe")
    if keyframe is None:
        keyframe = ET.SubElement(root, "keyframe")
    # Do not overwrite the source keyframe: the generated policy pose is named.
    ET.SubElement(keyframe, "key", {"name": "inria_policy_q0", "qpos": " ".join(map(str, qpos))})


def main() -> int:
    if len(sys.argv) != 4:
        raise SystemExit("usage: prepare_go2.py POLICY_ROOT ORIGINAL_GO2_MJCF OUTPUT_DIR")
    policy_root, source_path, output_dir = map(Path, sys.argv[1:4])
    model_path = policy_root / "onnx_inference" / "data" / "model.onnx"
    if not model_path.is_file():
        raise RuntimeError(f"GO2_POLICY_MODEL_MISSING: {model_path}")
    if not source_path.is_file():
        raise RuntimeError(f"GO2_MJCF_MISSING: {source_path}")

    source_tree = ET.parse(source_path)
    source_root = source_tree.getroot()
    # Compile the untouched source first; this also validates the supplied MJCF.
    source_model = mujoco.MjModel.from_xml_path(str(source_path))
    source_actuators = list(source_root.find("actuator") or [])
    if len(source_actuators) != 12:
        raise RuntimeError("GO2_MJCF_EXPECTED_12_ACTUATORS")
    source_motor_names = [a.get("name") for a in source_actuators]
    source_joint_names = [mujoco.mj_id2name(source_model, mujoco.mjtObj.mjOBJ_JOINT, j) for j in range(source_model.njnt) if source_model.jnt_type[j] == mujoco.mjtJoint.mjJNT_HINGE]
    if set(source_joint_names) != set(ISAAC_JOINTS):
        raise RuntimeError("GO2_MJCF_POLICY_JOINT_SET_MISMATCH")
    if any(a.tag != "motor" or not a.get("joint") for a in source_actuators):
        raise RuntimeError("GO2_MJCF_ACTUATORS_MUST_BE_MOTORS")

    # A copy is written elsewhere.  Make meshdir independent of output_dir while
    # retaining the source mesh assets and all physical XML attributes.
    root = copy.deepcopy(source_root)
    compiler = root.find("compiler")
    if compiler is not None and compiler.get("meshdir"):
        meshdir = Path(compiler.get("meshdir"))
        if not meshdir.is_absolute():
            meshdir = (source_path.parent / meshdir).resolve()
        compiler.set("meshdir", str(meshdir))
    actuators = list(root.find("actuator") or [])
    for actuator_index, (source_actuator, actuator) in enumerate(zip(source_actuators, actuators)):
        # The Go2 asset inherits ctrlrange from class defaults, so read the
        # resolved MuJoCo array rather than requiring an explicit XML attribute.
        ctrlrange = " ".join(str(float(v)) for v in source_model.actuator_ctrlrange[actuator_index])
        actuator.tag = "position"
        actuator.set("kp", "28.0")
        actuator.set("kv", "0.5")
        actuator.set("forcerange", ctrlrange)
        actuator.set("forcelimited", "true")
        actuator.set("ctrllimited", "false")
        actuator.attrib.pop("ctrlrange", None)
    after_without_key = mujoco.MjModel.from_xml_string(ET.tostring(root, encoding="unicode"))
    _append_policy_keyframe(root, _qpos_for_q0(after_without_key))

    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / "go2-inria-onnx-position-pd.xml"
    ET.indent(ET.ElementTree(root), space="  ")
    ET.ElementTree(root).write(target, encoding="utf-8", xml_declaration=False)
    target_model = mujoco.MjModel.from_xml_path(str(target))
    for field in PHYSICS_FIELDS:
        np.testing.assert_array_equal(getattr(source_model, field), getattr(target_model, field), err_msg=field)
    np.testing.assert_array_equal(source_model.actuator_ctrlrange, target_model.actuator_forcerange)

    # The policy consumes feature-wise two-frame history, not two flattened frames.
    config = {
        "simulation_dt": 0.002,
        "control_decimation": 10,
        "num_obs": 98,
        "num_actions": 12,
        "default_angles": Q0,
        "action_scale": 0.25,
        "kps": [28.0] * 12,
        "kds": [0.5] * 12,
        "footGeomNames": FEET,
        "contactForceThresholdN": (22.0 - 14.2) / 0.562,
        "observationHistory": 2,
        "initialKeyframe": "inria_policy_q0",
    }
    result = {
        "adapter": "inria-go2-onnx-v1",
        "robot": "unitree-go2",
        "engine": "mujoco",
        "supportedEngines": ["mujoco", "isaac"],
        "inferenceFormat": "onnx",
        "modelPath": str(target),
        "modelSourcePath": str(source_path),
        "weightsPath": str(model_path),
        "rootBody": "base",
        "config": config,
        "jointNames": ISAAC_JOINTS,
        "modelJointNames": source_joint_names,
        "modelActuatorNames": [next(a.get("name") for a in source_actuators if a.get("joint") == name) for name in source_joint_names],
        "unit": "rad",
        "controlMode": "position",
        "frequencyHz": 50.0,
        "observations": {
            "type": "STATE",
            "shape": [98],
            "quaternion": "xyzw",
            "order": [
                "gravityBody[t-1,t]", "angularVelocityBody[t-1,t]",
                "command[t-1,t]", "jointPositionMinusQ0[t-1,t]",
                "jointVelocity[t-1,t]", "previousAction[t-1,t]",
                "footContact01[t-1,t]",
            ],
            "historyLayout": "feature-wise two-frame history; no phase",
            "footForce": "Unitree foot_force >= 22 after source FL/FR/RL/RR remap",
        },
        "physicsPreserved": PHYSICS_FIELDS + ["actuator_forcerange_from_source_ctrlrange"],
        "gravityCompensation": False,
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
