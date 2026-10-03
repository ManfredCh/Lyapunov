#!/usr/bin/env python3
"""SmolVLA × LIBERO 权重 → `derived/adapter.json` 的纯 stdlib 派生脚本。

用法: python prepare_libero_vla.py <policyRoot> <outputDir>
成功: adapter JSON 打到 stdout（`adapter.ts` 补 source*/modelSha256 后落 `derived/adapter.json`）。

职责与边界：
- **只读解析** `model.safetensors`（safetensors 头 + 归一化统计张量）、`config.json`、`train_config.json`，
  校验 SmolVLA 结构键与观测/动作形状契约；**不** import torch/lerobot（产品侧不引入大推理依赖）。
- 归一化统计直接从检查点缓冲读出（`normalize_inputs`/`normalize_targets`/`unnormalize_outputs`，
  与 lerobot `migrate_policy_normalization.py` 同源口径），推理侧（lane 本地 lerobot）按此做 MEAN_STD。
- **`envProcessor` 声明**：把官方 LIBERO 评测的 env 层口径（`LiberoProcessorStep` 的 180° 图像翻转 +
  robot_state→state 组装 + `task` 1 元素 list 配对）作为**契约的一部分**写进 adapter.json，实现落在
  同目录 `libero_env_processor.py`（纯 stdlib/可选 numpy|torch 后端；与官方逐位比对的读数见
  `bugfixHistory/DEV028-GRIFFIN-ENVLAYER-20260923.md` §①）。缺这一层的实测后果见
  `bugfixHistory/DEV028-GRIFFIN-CRITERION-20260923.md`（env 层 off ⇒ 100 步旋钮恒 0.0 rad、无成功）。
- 失败一律非零退出 + stderr 明确错误码，不静默降级：
    3 LIBERO_VLA_SOURCE_FILES_MISSING   源文件缺失/为空
    4 LIBERO_VLA_CONTRACT_MISMATCH      config 形状/键/type 与 7 维 OSC delta 契约不符
    5 LIBERO_VLA_TENSOR_MISSING         safetensors 结构键缺失或形状不符
    6 LIBERO_VLA_STATS_INVALID          归一化统计缺失/维度不符/非有限
"""
import json
import math
import struct
import sys
from pathlib import Path

from libero_env_processor import describe as describe_env_processor

ACTION_DIM = 7
STATE_DIM = 8
IMAGE_SHAPE = [3, 256, 256]
IMAGE_KEYS = ["observation.images.image", "observation.images.wrist_image"]
STATE_KEY = "observation.state"
ACTION_KEY = "action"

REQUIRED_TENSORS = {
    "model.action_in_proj.weight",
    "model.action_out_proj.weight",
    "model.state_proj.weight",
    "model.action_time_mlp_in.weight",
    "model.vlm_with_expert.vlm.model.text_model.embed_tokens.weight",
    "normalize_inputs.buffer_observation_state.mean",
    "normalize_inputs.buffer_observation_state.std",
    "normalize_targets.buffer_action.mean",
    "normalize_targets.buffer_action.std",
    "unnormalize_outputs.buffer_action.mean",
    "unnormalize_outputs.buffer_action.std",
}
STAT_TENSORS = {
    "normalize_inputs.buffer_observation_state.mean": STATE_DIM,
    "normalize_inputs.buffer_observation_state.std": STATE_DIM,
    "normalize_targets.buffer_action.mean": ACTION_DIM,
    "normalize_targets.buffer_action.std": ACTION_DIM,
    "unnormalize_outputs.buffer_action.mean": ACTION_DIM,
    "unnormalize_outputs.buffer_action.std": ACTION_DIM,
}


def die(code, message):
    print(f"{code}: {message}", file=sys.stderr)
    raise SystemExit(int(code.rsplit("_", 1)[-1]) if code.rsplit("_", 1)[-1].isdigit() else 1)


def fail(code, message):
    print(f"{code}: {message}", file=sys.stderr)
    raise SystemExit({"LIBERO_VLA_SOURCE_FILES_MISSING": 3, "LIBERO_VLA_CONTRACT_MISMATCH": 4,
                      "LIBERO_VLA_TENSOR_MISSING": 5, "LIBERO_VLA_STATS_INVALID": 6}[code])


def read_safetensors_header(path):
    with path.open("rb") as stream:
        raw = stream.read(8)
        if len(raw) != 8:
            fail("LIBERO_VLA_TENSOR_MISSING", f"{path.name}: 头部不足 8 字节")
        length = struct.unpack("<Q", raw)[0]
        header = json.loads(stream.read(length))
        base = 8 + length
    tensors = {}
    for key, value in header.items():
        if key == "__metadata__":
            continue
        start, end = value["data_offsets"]
        tensors[key] = {"dtype": value["dtype"], "shape": list(value["shape"]), "start": base + start, "end": base + end}
    return tensors


def read_f32_vector(path, tensor):
    if tensor["dtype"] != "F32":
        fail("LIBERO_VLA_STATS_INVALID", f"统计张量 dtype 必须是 F32，实得 {tensor['dtype']}")
    count = tensor["end"] - tensor["start"]
    if count != 4 * math.prod(tensor["shape"]):
        fail("LIBERO_VLA_STATS_INVALID", "统计张量字节数与形状不符")
    with path.open("rb") as stream:
        stream.seek(tensor["start"])
        values = list(struct.unpack("<" + "f" * math.prod(tensor["shape"]), stream.read(count)))
    if not all(math.isfinite(value) for value in values):
        fail("LIBERO_VLA_STATS_INVALID", "统计张量含非有限值")
    return values


def main():
    if len(sys.argv) != 3:
        print("用法: prepare_libero_vla.py <policyRoot> <outputDir>", file=sys.stderr)
        raise SystemExit(2)
    root = Path(sys.argv[1]).resolve()
    output = Path(sys.argv[2]).resolve()

    for name in ["model.safetensors", "config.json", "train_config.json"]:
        file = root / name
        if not file.is_file() or file.stat().st_size == 0:
            fail("LIBERO_VLA_SOURCE_FILES_MISSING", f"{file} 缺失或为空")

    config = json.loads((root / "config.json").read_text())
    train_config = json.loads((root / "train_config.json").read_text())
    # train_config.json 是训练管线配置：策略超参在 `policy` 子对象（顶层是 batch/steps/wandb 等训练面）。
    policy_train = train_config.get("policy") if isinstance(train_config.get("policy"), dict) else train_config

    # ---- 契约校验：形状不符明确失败（负对照 ② 的落点） ----
    if config.get("type") != "smolvla":
        fail("LIBERO_VLA_CONTRACT_MISMATCH", f"config.type 必须是 smolvla，实得 {config.get('type')!r}")
    inputs = config.get("input_features") or {}
    for key in IMAGE_KEYS:
        shape = list((inputs.get(key) or {}).get("shape") or [])
        if shape != IMAGE_SHAPE:
            fail("LIBERO_VLA_CONTRACT_MISMATCH", f"{key} 形状必须是 {IMAGE_SHAPE}，实得 {shape}")
        if (inputs.get(key) or {}).get("type") != "VISUAL":
            fail("LIBERO_VLA_CONTRACT_MISMATCH", f"{key} type 必须是 VISUAL")
    state_shape = list((inputs.get(STATE_KEY) or {}).get("shape") or [])
    if state_shape != [STATE_DIM]:
        fail("LIBERO_VLA_CONTRACT_MISMATCH", f"{STATE_KEY} 形状必须是 [{STATE_DIM}]，实得 {state_shape}")
    action_shape = list(((config.get("output_features") or {}).get(ACTION_KEY) or {}).get("shape") or [])
    if action_shape != [ACTION_DIM]:
        fail("LIBERO_VLA_CONTRACT_MISMATCH", f"action 维度必须是 {ACTION_DIM}（OSC_POSE delta），实得 {action_shape}")
    mapping = config.get("normalization_mapping") or {}
    for mode, expected in [("VISUAL", "IDENTITY"), ("STATE", "MEAN_STD"), ("ACTION", "MEAN_STD")]:
        if mapping.get(mode) != expected:
            fail("LIBERO_VLA_CONTRACT_MISMATCH", f"normalization_mapping.{mode} 必须是 {expected}，实得 {mapping.get(mode)!r}")

    # ---- safetensors 结构键与归一化统计 ----
    weights = root / "model.safetensors"
    tensors = read_safetensors_header(weights)
    missing = sorted(REQUIRED_TENSORS - set(tensors))
    if missing:
        fail("LIBERO_VLA_TENSOR_MISSING", f"缺少 SmolVLA 结构键: {missing}")
    stats = {}
    for key, dim in STAT_TENSORS.items():
        tensor = tensors[key]
        if math.prod(tensor["shape"]) != dim:
            fail("LIBERO_VLA_STATS_INVALID", f"{key} 维度必须是 {dim}，实得 {tensor['shape']}")
        stats[key] = read_f32_vector(weights, tensor)

    output.mkdir(parents=True, exist_ok=True)
    upscale = {
        "from": "以 worker.py:228 的 camera_heights/camera_widths 渲染分辨率为准（现为 256x256）",
        "to": "256x256（config.json 观测契约）",
        "kernel": "PIL.Image.BILINEAR（双线性，不锐化/不补边），RGB uint8 -> float32 CHW /255（modeling_smolvla.prepare_images 内部再转 [-1,1] 并 resize_with_pad 到 512x512）",
    }
    wrist_note = (
        "腕槽自 VERIFICATION_LEDGER R273 起取当帧真腕图像（worker.py 的 frame() 已在 sensors 挂当帧 "
        "wrist_image，camera=robot0_eye_in_hand_image，每步真值帧落盘 step-*-wrist.png）；旧「腕槽以同帧 "
        "agentview 上采样替代」注记仅适用于 R273 之前的历史运行，对当前适配器不再成立。"
    )
    adapter = {
        "adapter": "libero-smolvla-v1",
        "policyType": "smolvla",
        "weightsFile": "model.safetensors",
        "modelPath": str(weights),
        "weightsPath": str(weights),
        "modelSourcePath": str(root),
        "tensorCount": len(tensors),
        "actionDim": ACTION_DIM,
        "controlMode": "osc_pose_delta",
        "controlSemantics": {
            "contract": "官方 ControlEnv OSC_POSE 归一化 delta（bench describe：world-frame Cartesian delta + world-frame axis-angle delta + gripper open_close）",
            "axisNames": ["world_dx", "world_dy", "world_dz", "world_droll", "world_dpitch", "world_dyaw", "gripper_open_close"],
            "units": ["normalized [-1,1] -> ±0.05 m", "normalized [-1,1] -> ±0.05 m", "normalized [-1,1] -> ±0.05 m",
                      "normalized [-1,1] -> ±0.5 rad", "normalized [-1,1] -> ±0.5 rad", "normalized [-1,1] -> ±0.5 rad",
                      "gripper open_close [-1,1]"],
            "feed": "只经 bench_step({kind:'control',values:[7],stepCount})（worker.py:575 finite_vector(...,7) -> :535 env.step）",
        },
        "frequencyHz": 20,
        "task": {
            "suite": "libero_goal",
            "taskId": "turn_on_the_stove",
            "languageInstruction": "turn on the stove",
            "trainingCoverage": "k1000dai/libero meta/tasks.jsonl task_index=16 \"turn on the stove\"（40 任务=libero_10/goal/object/spatial 各 10）⇒ 该任务在训练分布内",
        },
        "observations": {
            "keys": IMAGE_KEYS + [STATE_KEY],
            "images": {
                "observation.images.image": {"shape": IMAGE_SHAPE, "source": "agentview_image（worker.py:379）", "upsample": upscale},
                "observation.images.wrist_image": {"shape": IMAGE_SHAPE, "source": "robot0_eye_in_hand_image（真腕，见 substitution）", "upsample": upscale, "substitution": wrist_note},
            },
            "state": {
                "shape": [STATE_DIM],
                "fields": ["robot0_eef_pos (3)", "robot0_eef_quat xyzw -> axis-angle (3)", "robot0_gripper_qpos (2)"],
                "source": "bench_step/bench_result Frame sensors: eefPositionM / eefQuaternionXyzw / gripperQpos",
                "quaternion": "xyzw -> 轴角＝robosuite transform_utils.quat2axisangle 原口径（(x,y,z)·2·acos(w)/√(1−w²)，angle∈[0,2π]，w<0 可超 π；den≈0→零向量）",
            },
            "normalization": {
                "mapping": mapping,
                "stateMean": stats["normalize_inputs.buffer_observation_state.mean"],
                "stateStd": stats["normalize_inputs.buffer_observation_state.std"],
                "actionMean": stats["unnormalize_outputs.buffer_action.mean"],
                "actionStd": stats["unnormalize_outputs.buffer_action.std"],
                "targetsMean": stats["normalize_targets.buffer_action.mean"],
                "targetsStd": stats["normalize_targets.buffer_action.std"],
                "statsSource": "model.safetensors 内嵌 normalize_inputs/normalize_targets/unnormalize_outputs 缓冲（与 lerobot migrate_policy_normalization 同源）",
                "applyAtInference": "state=(state-stateMean)/stateStd 后送 select_action；action=raw*actionStd+actionMean（MEAN_STD）",
            },
        },
        "inferenceFormat": {
            "kind": "lerobot-smolvla",
            "runtime": "lerobot==0.4.4 SmolVLAPolicy.from_pretrained(strict=False) + torch CPU",
            "deps": "lane 本地 PYTHONPATH（.runtime/lane-libero-vla/pydeps），不进产品 package.json",
            "flowSteps": policy_train.get("num_steps"),
            "nActionSteps": policy_train.get("n_action_steps"),
            "chunkSize": policy_train.get("chunk_size"),
            "vlmModelName": policy_train.get("vlm_model_name"),
            "tokenizerMaxLength": policy_train.get("tokenizer_max_length"),
            "resizeImgsWithPadding": policy_train.get("resize_imgs_with_padding"),
            "statePaddedDim": policy_train.get("max_state_dim"),
            "actionPaddedDim": policy_train.get("max_action_dim"),
            "oldFormatNote": "检查点为旧式内嵌归一化层（无 preprocessor.json）；0.4.4 from_pretrained strict=False 忽略 normalize_* 键，归一化由本 adapter 的 statistics 在推理侧执行",
        },
        # 官方 LIBERO 评测的 env 层口径（策略侧观测适配；实现＝同目录 libero_env_processor.py）。
        # 缺这一层会让图像以 env 原始朝向（180° 倒置）进策略：实测 env 层 off 时 100 步旋钮恒 0.0 rad、
        # 无 check_success（libero_goal/turn_on_the_stove seed0），on 时 77 步命中官方判据。
        "envProcessor": describe_env_processor(),
        # 产品侧 VLA 推理实现（DEV-028 条件③ 的缺口之一）：此前 VLA 推理只存在于 lane 本地服务
        # （`.runtime/lane-*/infer_server.py`），按 DEV-028/023 口径不算产品通路；本声明把推理入口登记到
        # 产品源码，观测口径**复用**上面的 envProcessor（同目录 libero_env_processor.py），不新增依赖、
        # 不新增第二套推理框架：协议与同目录 torch_cpu.py 逐字段同构（{id,method}→{id,result|error}），
        # 因此 src/execution.ts:13-40 的 CPUInference 子进程 harness 不需要任何改动即可承载。
        "inferenceModule": {
            "path": "packages/policy-registry/python/libero_vla_infer_server.py",
            "protocol": "torch_cpu.py 同构 JSON 行协议（{\"id\",\"method\"} → {\"id\",\"result\"|\"error\"}）",
            "methods": ["load", "infer", "reset"],
            "inferReply": "默认出块：result.values = steps×actionDim（steps=检查点 n_action_steps ≤ chunk_size，官方 eval_libero.py:131-133 同形，调用方按 actionDim 切队列开环执行）；singleAction=true 时 steps=1",
            "harness": "src/execution.ts:13-40 CPUInference（同一 spawn、同一 id 关联；无需改动）",
            "requestBudget": "一次出块即一次完整 chunk 规划，CPU-only 实测 54.9 s（本机负载下）⇒ 消费侧单请求超时必须 > 该量级（既有 CPUInference 默认 30 s 会先超时）",
            "deps": {
                "runtime": "既有 lerobot==0.4.4 + torch CPU（.runtime/lane-libero-vla/pydeps，绝对路径由调用方给出）",
                "resolution": "load.depsPath 或 $LYAPUNOV_LIBERO_VLA_PYDEPS；解释器沿用 pythonPath() 口径（src/adapter.ts:40）",
                "newDependencies": 0,
            },
            "envLayer": "复用同目录 libero_env_processor.py（先 180° 翻图 + robot_state→state，再叠 policy preprocessor）",
            "wrist": "帧 sensors.wrist_image 真腕；缺路径默认拒绝（LIBERO_VLA_WRIST_IMAGE_MISSING），仅显式 allowWristSubstitution 才用同帧 agentview",
            "failureCodes": ["LIBERO_VLA_USAGE", "LIBERO_VLA_SOURCE_FILES_MISSING", "LIBERO_VLA_ADAPTER_CONTRACT",
                             "LIBERO_VLA_ENV_PROCESSOR_UNDECLARED", "LIBERO_VLA_DEPS_UNAVAILABLE", "LIBERO_VLA_WRIST_IMAGE_MISSING"],
        },
    }
    print(json.dumps(adapter, ensure_ascii=False))


if __name__ == "__main__":
    main()
