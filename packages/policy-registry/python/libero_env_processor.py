#!/usr/bin/env python3
"""LIBERO × VLA 观测口径适配：官方 `LiberoProcessorStep` 的 **180° 图像翻转** + **state 组装** + **task 形状配对**。

口径来源（本机磁盘逐条取证，见 `bugfixHistory/DEV028-GRIFFIN-CRITERION-20260923.md` §①）：
- 官方 LIBERO 评测循环必经一层 **env 处理器**：`examples/libero/eval_libero.py:130`
  `obs_for_policy = preprocessor(env_preprocessor(proc_obs))`；
  `lerobot/envs/configs.py:447-451` `get_env_processors()` 返回
  `(PolicyProcessorPipeline(steps=[LiberoProcessorStep()]), PolicyProcessorPipeline(steps=[]))`。
- 该步对 `observation.images.*` 做 `torch.flip(img, dims=[2, 3])`（`lerobot/processor/env_processor.py:59`），
  把 env 原始相机画面转到 HuggingFaceVLA/libero 的相机朝向约定（`env_processor.py:45-46` docstring；
  外部旁证：LIBERO HDF5→RLDS 转换脚本「we rotate the images by 180 degrees because we observe that the
  environments return images that are upside down on our platform」）。
- 同一 `_process_observation`（`env_processor.py:65-82`）把
  `observation.robot_state.{eef.pos, eef.quat, gripper.qpos}` 拼成 `observation.state`
  ＝ `cat(eef_pos(3), axisangle(quat)(3), gripper_qpos(2))`、`float32`，消费后 `pop` 掉 `robot_state`。
- `env_postprocessor` 在 `lerobot==0.6.1`（插件 `pyproject.toml` 钉死）是**空 pipeline＝恒等**
  （`envs/configs.py:450` `PolicyProcessorPipeline(steps=[])`）。
- `task` 必须与观测**批维配对**：官方 `eval_libero.py:120-127`
  `proc_obs["task"] = list(env.call("task_description"))` ⇒ **1 元素 list**；而 lerobot 的
  `add_batch_dimension` 只在 `observation.state.ndim == 1` 时才把**裸字符串**包成 list
  ⇒ 「已批处理 + 裸 str」与「未批处理 + list」两种半改法都会**静默**改掉 prompt 文本
  （详见 `DEV028-GRIFFIN-CRITERION-20260923.md` §③ 第 6 行）。本模块用 `paired_task()` 把这条
  配对规则变成**显式契约**，半改法直接抛错，不再静默。

落点判定（为什么在 `packages/policy-registry/python/` 而不是 `packages/benchmark-libero/python/`）：
- 上游 `lerobot/envs/libero.py` 的 env 返回的**就是未翻转**的 `agentview_image`；翻转由**评测驱动侧**的
  `env_preprocessor` 施加。我们的 `benchmark-libero/python/worker.py` 是 env 的对应物，`policy-registry`
  是策略/驱动侧的对应物 ⇒ 口径应落在策略侧。
- 在 worker 里翻转会改动 `bench_step` 的观测契约与落盘像素（`worker.py:380-397`），使所有既往前缀
  `agentviewSha256` 读数不可复现，并与上游 env 行为不符 ⇒ 放错层。
- 本模块与 `prepare_libero_vla.py` 同目录、同为纯策略侧口径件；`adapter.json` 由后者声明本模块。

依赖边界：
- **不 import torch / lerobot**。传入 torch 张量时逐字调用官方算子（`torch.flip` / 同式 cat），此时与
  官方 `LiberoProcessorStep` 逐位可比；传入 numpy 数组时用同式 numpy 实现；纯 stdlib 只覆盖图像翻转
  （纯索引置换，逐位精确）与结构校验，数值路径缺后端时**明确失败**（不静默降级）。

失败码（非零退出 + stderr，不静默）：
    2 LIBERO_ENV_PROCESSOR_USAGE
    3 LIBERO_ENV_PROCESSOR_BATCH_REQUIRED      图像/state 缺批维（官方 dims=[2,3] 只在 (B,C,H,W) 上成立）
    4 LIBERO_ENV_PROCESSOR_TASK_SHAPE_MISMATCH task 形状与批维不配对（半改法）
    5 LIBERO_ENV_PROCESSOR_STATE_SHAPE_MISMATCH robot_state 子张量形状不符
    6 LIBERO_ENV_PROCESSOR_BACKEND_UNAVAILABLE  数值路径需要 torch/numpy 但都不可用
"""
import json
import math
import sys

OBS_STR = "observation"
OBS_PREFIX = OBS_STR + "."
OBS_STATE = OBS_STR + ".state"
OBS_IMAGES = "observation.images"
OBS_ROBOT_STATE = OBS_PREFIX + "robot_state"
ACTION = "action"

#: 官方口径身份（供 adapter.json 声明；sha256/行号见回执）
UPSTREAM = {
    "versionPin": "lerobot[libero,evaluation]==0.6.1",
    "envProcessors": "lerobot/envs/configs.py:447-451 (LiberoEnv.get_env_processors)",
    "envPreSteps": ["LiberoProcessorStep"],
    "envPostSteps": [],
    "imageFlip": "lerobot/processor/env_processor.py:59 torch.flip(img, dims=[2,3])",
    "imageFlipScope": "env_processor.py:54-56 (keys startswith 'observation.images.')",
    "stateAssembly": "lerobot/processor/env_processor.py:65-82",
    "quat2axisangle": "lerobot/processor/env_processor.py:114-153",
    "taskShape": "examples/libero/eval_libero.py:120-127 (1-element list)",
    "envPostIsIdentity": True,
    "orientationConvention": "HuggingFaceVLA/libero camera orientation (env_processor.py:45-46 docstring)",
}

ERRORS = {
    "LIBERO_ENV_PROCESSOR_USAGE": 2,
    "LIBERO_ENV_PROCESSOR_BATCH_REQUIRED": 3,
    "LIBERO_ENV_PROCESSOR_TASK_SHAPE_MISMATCH": 4,
    "LIBERO_ENV_PROCESSOR_STATE_SHAPE_MISMATCH": 5,
    "LIBERO_ENV_PROCESSOR_BACKEND_UNAVAILABLE": 6,
}


def fail(code, message):
    print(f"{code}: {message}", file=sys.stderr)
    raise SystemExit(ERRORS[code])


# ------------------------------------------------------------------ 后端判别


def _backend(value):
    module = type(value).__module__.split(".")[0]
    if module == "torch":
        return "torch"
    if module == "numpy":
        return "numpy"
    if isinstance(value, (list, tuple)):
        return "list"
    return "unsupported"


def _shape(value):
    """形状（list/tuple 递归；torch/numpy 用 .shape；标量 ⇒ []）。"""
    if isinstance(value, (list, tuple)):
        return [len(value)] + (_shape(value[0]) if len(value) else [])
    shape = getattr(value, "shape", None)
    if shape is None:
        return []
    return [int(d) for d in shape]


def _require_batch(value, what):
    shape = _shape(value)
    if len(shape) != 4 and what == "image":
        raise ValueError(
            f"LIBERO_ENV_PROCESSOR_BATCH_REQUIRED: {what} 需为 (B,C,H,W)（官方 torch.flip dims=[2,3] 只在 4 维上成立），实得 {shape}"
        )
    if len(shape) != 2 and what == "state":
        raise ValueError(
            f"LIBERO_ENV_PROCESSOR_BATCH_REQUIRED: {what} 需为 (B,D)，实得 {shape}"
        )
    return shape


# ------------------------------------------------------------------ 图像：180° 翻转


def _flip_list4(value):
    """(B,C,H,W) 嵌套序列的 H/W 双翻：纯索引置换，逐位精确（无算术）。"""
    return [[[row[::-1] for row in height[::-1]] for height in channel] for channel in value]


def flip180_image(value):
    """对单张 (`observation.images.*`) 张量做 180° 翻转 ＝ 同时翻 H 与 W。

    官方原文：`img = torch.flip(img, dims=[2, 3])`。三种后端：
      - torch 张量 ⇒ 逐字调用 `torch.flip(value, dims=[2,3])`（与官方同一算子，逐位可比）；
      - numpy 数组 ⇒ `np.flip(value, axis=(2,3))` 后 `ascontiguousarray`（负 stride 会让 `torch.from_numpy` 拒绝，
        故显式连续化；值不变）；
      - 纯 list/tuple (B,C,H,W) ⇒ `_flip_list4`（索引置换）。
    非 4 维一律 `LIBERO_ENV_PROCESSOR_BATCH_REQUIRED`（这正是"必须配批维"的机器可执行表达）。
    """
    backend = _backend(value)
    if backend == "torch":
        import torch  # noqa: PLC0415

        _require_batch(value, "image")
        return torch.flip(value, dims=[2, 3])
    if backend == "numpy":
        import numpy as np  # noqa: PLC0415

        _require_batch(value, "image")
        return np.ascontiguousarray(np.flip(value, axis=(2, 3)))
    if backend == "list":
        _require_batch(value, "image")
        return _flip_list4(value)
    raise ValueError(f"LIBERO_ENV_PROCESSOR_BACKEND_UNAVAILABLE: 不支持的图像类型 {type(value)!r}")


def flip180_images(observation):
    """官方 `_process_observation` 的图像分支：对**所有** `observation.images.*` 键翻转。"""
    processed = dict(observation)
    flipped = []
    for key in list(processed.keys()):
        if isinstance(key, str) and key.startswith(OBS_IMAGES + "."):
            processed[key] = flip180_image(processed[key])
            flipped.append(key)
    return processed, flipped


# ------------------------------------------------------------------ state 组装


def _quat2axisangle_torch(quat):
    import torch  # noqa: PLC0415

    if not isinstance(quat, torch.Tensor):
        raise ValueError("LIBERO_ENV_PROCESSOR_STATE_SHAPE_MISMATCH: torch 后端要求 torch.Tensor")
    if quat.ndim != 2 or quat.shape[1] != 4:
        raise ValueError(f"LIBERO_ENV_PROCESSOR_STATE_SHAPE_MISMATCH: quat 需为 (B,4)，实得 {tuple(quat.shape)}")
    quat = quat.to(dtype=torch.float32)
    w = quat[:, 3].clamp(-1.0, 1.0)
    den = torch.sqrt(torch.clamp(1.0 - w * w, min=0.0))
    result = torch.zeros((quat.shape[0], 3), device=quat.device)
    mask = den > 1e-10
    if mask.any():
        angle = 2.0 * torch.acos(w[mask])
        axis = quat[mask, :3] / den[mask].unsqueeze(1)
        result[mask] = axis * angle.unsqueeze(1)
    return result


def _quat2axisangle_numpy(quat):
    """与 `_quat2axisangle_torch` 同式（clamp / clamp(min=0) / mask>1e-10 / acos / 轴除 den 乘角）。"""
    import numpy as np  # noqa: PLC0415

    q = np.asarray(quat, dtype=np.float32)
    if q.ndim != 2 or q.shape[1] != 4:
        raise ValueError(f"LIBERO_ENV_PROCESSOR_STATE_SHAPE_MISMATCH: quat 需为 (B,4)，实得 {list(q.shape)}")
    w = np.clip(q[:, 3], np.float32(-1.0), np.float32(1.0))
    den = np.sqrt(np.clip(np.float32(1.0) - w * w, np.float32(0.0), None))
    result = np.zeros((q.shape[0], 3), dtype=np.float32)
    mask = den > np.float32(1e-10)
    if mask.any():
        angle = (np.float32(2.0) * np.arccos(w[mask])).astype(np.float32)
        axis = q[mask, :3] / den[mask].reshape(-1, 1)
        result[mask] = (axis * angle.reshape(-1, 1)).astype(np.float32)
    return result


def _quat2axisangle_list(quat):
    """纯 stdlib 标量回退（float64 中间量；仅用于结构/量级核对，**不承诺与 float32 逐位相同**）。"""
    rows = [list(row) for row in quat]
    out = []
    for row in rows:
        if len(row) != 4:
            raise ValueError("LIBERO_ENV_PROCESSOR_STATE_SHAPE_MISMATCH: quat 每行需 4 个分量")
        x, y, z, w = (float(v) for v in row)
        w = min(1.0, max(-1.0, w))
        den = math.sqrt(max(0.0, 1.0 - w * w))
        if not den > 1e-10:
            out.append([0.0, 0.0, 0.0])
            continue
        scale = 2.0 * math.acos(w) / den
        out.append([x * scale, y * scale, z * scale])
    return out


def quat_xyzw_to_axis_angle_batch(quat):
    """批 (B,4) xyzw → (B,3) 轴角；按输入后端选实现（torch 优先 ⇒ 官方算子逐位同）。"""
    backend = _backend(quat)
    if backend == "torch":
        return _quat2axisangle_torch(quat)
    if backend == "numpy":
        return _quat2axisangle_numpy(quat)
    if backend == "list":
        return _quat2axisangle_list(quat)
    raise ValueError(f"LIBERO_ENV_PROCESSOR_BACKEND_UNAVAILABLE: 不支持的 quat 类型 {type(quat)!r}")


def _cat_last(parts, backend):
    if backend == "torch":
        import torch  # noqa: PLC0415

        return torch.cat(parts, dim=-1)
    if backend == "numpy":
        import numpy as np  # noqa: PLC0415

        return np.concatenate(parts, axis=-1)
    return [sum((list(p[i]) for p in parts), []) for i in range(len(parts[0]))]


def _to_float32(value, backend):
    if backend == "torch":
        return value.float()
    if backend == "numpy":
        import numpy as np  # noqa: PLC0415

        return value.astype(np.float32, copy=False)
    return value


def _ensure_2d(value, backend):
    if backend == "torch":
        return value.unsqueeze(0) if value.dim() == 1 else value
    if backend == "numpy":
        import numpy as np  # noqa: PLC0415

        return np.expand_dims(value, 0) if value.ndim == 1 else value
    if value and isinstance(value[0], (int, float)):
        return [value]
    return value


def robot_state_to_state(robot_state):
    """`observation.robot_state` → `observation.state`（官方 `env_processor.py:65-82` 逐式）。

    输入 `{"eef": {"pos": (B,3), "quat": (B,4)}, "gripper": {"qpos": (B,2)}}`（xyzw 四元数）。
    输出 `(B,8) float32` ＝ `cat(eef_pos(3), axisangle(quat)(3), gripper_qpos(2))`。
    """
    try:
        eef_pos = robot_state["eef"]["pos"]
        eef_quat = robot_state["eef"]["quat"]
        gripper_qpos = robot_state["gripper"]["qpos"]
    except (KeyError, TypeError) as error:
        raise ValueError(
            "LIBERO_ENV_PROCESSOR_STATE_SHAPE_MISMATCH: robot_state 需含 eef.pos/eef.quat/gripper.qpos"
            f"（实得键 {list(robot_state) if isinstance(robot_state, dict) else type(robot_state)!r}），缺 {error}"
        ) from None
    backend = _backend(eef_pos)
    for value, dim, name in ((eef_pos, 3, "eef.pos"), (eef_quat, 4, "eef.quat"), (gripper_qpos, 2, "gripper.qpos")):
        if _backend(value) != backend:
            raise ValueError(f"LIBERO_ENV_PROCESSOR_STATE_SHAPE_MISMATCH: {name} 后端 {_backend(value)} 与 eef.pos({backend}) 不一致")
        shape = _require_batch(value, "state")
        if shape[1] != dim:
            raise ValueError(f"LIBERO_ENV_PROCESSOR_STATE_SHAPE_MISMATCH: {name} 需为 (B,{dim})，实得 {shape}")
    batches = {_require_batch(v, "state")[0] for v in (eef_pos, eef_quat, gripper_qpos)}
    if len(batches) != 1:
        raise ValueError(f"LIBERO_ENV_PROCESSOR_STATE_SHAPE_MISMATCH: robot_state 各分量批维不一致 {sorted(batches)}")
    axis_angle = quat_xyzw_to_axis_angle_batch(eef_quat)
    state = _cat_last([eef_pos, axis_angle, gripper_qpos], backend)
    state = _to_float32(state, backend)
    return _ensure_2d(state, backend)


def env_preprocess_observation(observation):
    """官方 `LiberoProcessorStep._process_observation` 逐式：先翻图，再把 `robot_state` 拼成 `state` 并 pop。

    返回 `(processed, flipped_image_keys)`；`processed` 是**浅拷贝**，输入不被就地改写。
    """
    processed, flipped = flip180_images(observation)
    if OBS_ROBOT_STATE in processed:
        robot_state = processed.pop(OBS_ROBOT_STATE)
        processed[OBS_STATE] = robot_state_to_state(robot_state)
    return processed, flipped


# ------------------------------------------------------------------ task 形状配对（P2）


def is_batched(observation):
    """观测是否带批维（官方判据：`observation.state.ndim == 2`，见 lerobot `add_batch_dimension`）。"""
    state = observation.get(OBS_STATE)
    if state is None:
        return False
    return len(_shape(state)) == 2


def policy_task(task):
    """官方 `eval_libero.py:120-127`：`proc_obs["task"] = list(env.call("task_description"))` ⇒ 1 元素 list。"""
    if isinstance(task, str):
        return [task]
    if isinstance(task, (list, tuple)) and len(task) == 1 and isinstance(task[0], str):
        return list(task)
    raise ValueError(f"LIBERO_ENV_PROCESSOR_TASK_SHAPE_MISMATCH: task 需为裸 str 或 1 元素 list[str]，实得 {task!r}")


def paired_task(task, batched):
    """把 **task 形状与观测批维的配对规则**变成显式契约（半改法直接抛错，不静默坏 prompt）。

    官方口径：已批处理 ⇒ 1 元素 list；未批处理 ⇒ 裸 str（依赖 `add_batch_dimension` 的 ndim==1 分支包装）。
    """
    if batched:
        if isinstance(task, str):
            raise ValueError(
                "LIBERO_ENV_PROCESSOR_TASK_SHAPE_MISMATCH: 观测已带批维（state.ndim==2）时 task 必须是 1 元素 list"
                f"（官方 eval_libero.py:120-127 的 list(env.call('task_description'))），实得裸 str {task!r}"
            )
        return policy_task(task)
    if not isinstance(task, str):
        raise ValueError(
            f"LIBERO_ENV_PROCESSOR_TASK_SHAPE_MISMATCH: 观测未带批维（state.ndim==1）时 task 必须是裸 str，实得 {task!r}"
        )
    return task


def env_postprocess_action(chunk):
    """`env_postprocessor` 恒等（`lerobot==0.6.1` `envs/configs.py:450` 为空 pipeline）。

    保留为显式函数（而非"什么都没做"）以便：(a) 调用点与官方 `eval_libero.py:135` 同形；
    (b) 上游将来给 env_post 加步骤时这里能被契约测试抓住。
    """
    return chunk


# ------------------------------------------------------------------ adapter.json 声明


def describe():
    """供 `prepare_libero_vla.py` 写进 `adapter.json` 的声明块。"""
    return {
        "module": "libero_env_processor",
        "path": "packages/policy-registry/python/libero_env_processor.py",
        "scope": "policy-side observation adapter (mirrors lerobot env_preprocessor; NOT the bench env worker)",
        "envPreSteps": list(UPSTREAM["envPreSteps"]),
        "envPostSteps": list(UPSTREAM["envPostSteps"]),
        "imageFlip180": {
            "appliesTo": OBS_IMAGES + ".*",
            "op": "torch.flip(dims=[2,3]) == numpy.flip(axis=(2,3)) == index permutation",
            "requiresBatchDim": True,
            "convention": UPSTREAM["orientationConvention"],
        },
        "stateAssembly": {
            "from": OBS_ROBOT_STATE + ".{eef.pos(3),eef.quat(4,xyzw),gripper.qpos(2)}",
            "to": OBS_STATE,
            "shape": [8],
            "dtype": "float32",
            "order": ["eef_pos", "axis_angle_xyzw", "gripper_qpos"],
        },
        "taskShape": {"batchedObservation": "list[str] (1 element)", "unbatchedObservation": "str", "enforcedBy": "paired_task()"},
        "envPostIsIdentity": UPSTREAM["envPostIsIdentity"],
        "upstream": dict(UPSTREAM),
    }


# ------------------------------------------------------------------ 自检 / 探针


def _selftest():
    """纯 stdlib 证明：180° 翻转的**逐像素期望值**、翻转两次＝恒等、块位移、task 配对守卫。"""
    height, width, channels, batch = 5, 7, 3, 2
    # 可肉眼复算的源：value = b*1000 + c*100 + h*10 + w
    source = [[[[b * 1000 + c * 100 + h * 10 + w for w in range(width)] for h in range(height)] for c in range(channels)] for b in range(batch)]
    flipped = _flip_list4(source)
    twice = _flip_list4(flipped)

    # 独立参考实现（按定义做索引映射，不复用被测代码）
    reference = [[[[source[b][c][height - 1 - h][width - 1 - w] for w in range(width)] for h in range(height)] for c in range(channels)] for b in range(batch)]
    mismatches = [(b, c, h, w) for b in range(batch) for c in range(channels) for h in range(height) for w in range(width) if flipped[b][c][h][w] != reference[b][c][h][w]]

    # 逐像素 expected/actual 抽样（给出可复算的三元组）
    probes = []
    for (b, c, h, w) in ((0, 0, 0, 0), (0, 0, 0, 6), (0, 1, 4, 3), (1, 2, 2, 5)):
        probes.append({
            "at": [b, c, h, w],
            "source": source[b][c][h][w],
            "expected_from_source": source[b][c][height - 1 - h][width - 1 - w],
            "actual_flipped": flipped[b][c][h][w],
        })

    # 块位移：源左上 (0,0) 角块 ⇒ 翻转后右下角
    block = {
        "source_top_left": source[0][0][0][0],
        "flipped_bottom_right": flipped[0][0][height - 1][width - 1],
        "flipped_top_left": flipped[0][0][0][0],
        "source_bottom_right": source[0][0][height - 1][width - 1],
    }

    # task 配对守卫：两条半改法都必须抛错
    pairing = {}
    for name, task, batched in (("batched_with_str", "turn on the stove", True), ("unbatched_with_list", ["turn on the stove"], False)):
        try:
            paired_task(task, batched)
            pairing[name] = "NO_ERROR(缺陷：半改法被静默接受)"
        except ValueError as error:
            pairing[name] = str(error).split(":")[0]
    pairing["batched_with_list"] = paired_task(["turn on the stove"], True)
    pairing["unbatched_with_str"] = paired_task("turn on the stove", False)

    # state 组装（纯 stdlib 标量回退；float64 只用于结构/量级核对）
    state = robot_state_to_state({"eef": {"pos": [[1.0, 2.0, 3.0]], "quat": [[0.0, 0.0, 0.0, 1.0]]}, "gripper": {"qpos": [[0.25, -0.25]]}})

    # 官方算子可用时的交叉实现一致性（同一份 source 值，三种后端应逐位相同）
    parity = {"torch": "unavailable", "numpy": "unavailable"}
    try:
        import numpy as np  # noqa: PLC0415

        reference_array = np.asarray(source, dtype=np.int32)
        numpy_flip = flip180_image(reference_array)
        numpy_twice = flip180_image(numpy_flip)
        parity["numpy"] = {
            "matches_independent_reference": bool(np.array_equal(numpy_flip, np.asarray(reference, dtype=np.int32))),
            "matches_pure_python": bool(np.array_equal(numpy_flip, np.asarray(flipped, dtype=np.int32))),
            "double_flip_is_identity": bool(np.array_equal(numpy_twice, reference_array)),
            "contiguous": bool(numpy_flip.flags["C_CONTIGUOUS"]),
        }
    except ImportError:
        pass
    try:
        import torch  # noqa: PLC0415

        tensor = torch.tensor(source, dtype=torch.int32)
        torch_flip = flip180_image(tensor)
        torch_twice = flip180_image(torch_flip)
        parity["torch"] = {
            "matches_official_torch_flip": bool(torch.equal(torch_flip, torch.flip(tensor, dims=[2, 3]))),
            "matches_pure_python": bool(torch.equal(torch_flip, torch.tensor(flipped, dtype=torch.int32))),
            "double_flip_is_identity": bool(torch.equal(torch_twice, tensor)),
        }
    except ImportError:
        pass

    return {
        "shape": [batch, channels, height, width],
        "flip_dims": [2, 3],
        "pixel_mismatches_vs_reference": len(mismatches),
        "probes": probes,
        "block_move": block,
        "double_flip_is_identity": twice == source,
        "value_multiset_preserved": sorted(v for plane in sum(sum(source, []), []) for v in plane) == sorted(v for plane in sum(sum(flipped, []), []) for v in plane),
        "task_pairing_guard": pairing,
        "state_probe": state,
        "backend_parity": parity,
        "env_post_is_identity": env_postprocess_action(7) == 7,
    }


def _verify_against_official():
    """与**官方** `LiberoProcessorStep` 在同一输入上逐位比对（需 lerobot ⇒ 只在 lane env312 里跑）。"""
    import numpy as np  # noqa: PLC0415
    import torch  # noqa: PLC0415
    from lerobot.envs.configs import LiberoEnv  # noqa: PLC0415

    generator = torch.Generator().manual_seed(0)
    batch, channels, height, width = 2, 3, 8, 6
    images = {
        "observation.images.image": torch.randint(0, 256, (batch, channels, height, width), generator=generator).to(torch.float32) / 255.0,
        "observation.images.wrist_image": torch.rand((batch, channels, height, width), generator=generator),
    }
    quats = torch.randn((batch, 4), generator=generator)
    quats = quats / quats.norm(dim=-1, keepdim=True)
    quats[1] = torch.tensor([0.0, 0.0, 0.0, 1.0])
    robot_state = {
        "eef": {"pos": torch.rand((batch, 3), generator=generator), "quat": quats},
        "gripper": {"qpos": torch.rand((batch, 2), generator=generator)},
    }
    observation = dict(images)
    observation["observation.robot_state"] = robot_state

    # 官方工厂（＝评测循环 eval_libero.py / lerobot_eval.py 实际拿到的对象）
    env_pre, env_post = LiberoEnv(observation_height=256, observation_width=256).get_env_processors()
    official = dict(env_pre(dict(observation)))
    mine, flipped = env_preprocess_observation(observation)

    report = {
        "env_pre_steps": [type(step).__name__ for step in env_pre.steps],
        "env_post_steps": [type(step).__name__ for step in env_post.steps],
        "flipped_keys": sorted(flipped),
        "keys_equal": sorted(official.keys()) == sorted(mine.keys()),
        "official_only_keys": sorted(set(official) - set(mine)),
        "mine_only_keys": sorted(set(mine) - set(official)),
        "checks": {},
    }
    for key in sorted(mine):
        if key == "observation.state":
            report["checks"][key] = {
                "shape": list(mine[key].shape),
                "dtype": str(mine[key].dtype),
                "bitwise_equal": bool(torch.equal(official[key], mine[key])),
                "max_abs_diff": float((official[key] - mine[key]).abs().max().item()),
            }
        else:
            report["checks"][key] = {
                "shape": list(mine[key].shape),
                "bitwise_equal": bool(torch.equal(official[key], mine[key])),
            }
    # env_post 恒等（官方空 pipeline）对动作张量逐位不变
    action_chunk = torch.rand((batch, 5, 7), generator=generator)
    report["env_post_action_bitwise_identical"] = bool(torch.equal(env_post({ACTION: action_chunk})[ACTION], action_chunk))
    # numpy 后端的数值路径与 torch 官方逐位比对
    numpy_states = _quat2axisangle_numpy(quats.numpy())
    official_axis_angle = official["observation.state"][:, 3:6].numpy()
    report["numpy_vs_official_state_max_abs_diff"] = float(np.abs(numpy_states - official_axis_angle).max())
    report["numpy_state_bitwise_equal"] = bool((numpy_states == official_axis_angle).all())
    # 图像：numpy 后端与 torch 官方逐位比对
    numpy_image = flip180_image(images["observation.images.image"].numpy())
    report["numpy_image_bitwise_equal"] = bool((numpy_image == official["observation.images.image"].numpy()).all())
    report["all_bitwise_equal"] = all(item["bitwise_equal"] for item in report["checks"].values())
    return report


def _probe_image(path, out_dir, compare=None):
    """对真实帧做翻转探针：写出 翻转/双翻 两张 PNG 并给出逐块与哈希读数。

    `compare`：可选的**独立实现**对照 PNG（如另一条 lane 产出的 `-rot180.png`），逐字节比对。
    """
    import hashlib  # noqa: PLC0415
    import os  # noqa: PLC0415

    from PIL import Image  # noqa: PLC0415

    import numpy as np  # noqa: PLC0415

    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.uint8)          # (H,W,C) uint8，env 原始朝向
    tensor = np.ascontiguousarray(rgb.transpose(2, 0, 1)[None])               # 官方 preprocess_observation 的 b h w c -> b c h w
    flipped = flip180_image(tensor)
    twice = flip180_image(flipped)
    flipped_hwc = flipped[0].transpose(1, 2, 0)
    stem = os.path.splitext(os.path.basename(path))[0]
    os.makedirs(out_dir, exist_ok=True)
    flip_path = os.path.join(out_dir, f"{stem}-flip180.png")
    twice_path = os.path.join(out_dir, f"{stem}-flip180-twice.png")
    Image.fromarray(flipped_hwc).save(flip_path)
    Image.fromarray(twice[0].transpose(1, 2, 0)).save(twice_path)
    height, width = rgb.shape[0], rgb.shape[1]
    quadrants = {}
    for name, (rows, cols) in {
        "source_tl": (slice(0, height // 2), slice(0, width // 2)),
        "source_br": (slice(height // 2, height), slice(width // 2, width)),
        "flipped_tl": (slice(0, height // 2), slice(0, width // 2)),
        "flipped_br": (slice(height // 2, height), slice(width // 2, width)),
    }.items():
        src = rgb if name.startswith("source") else flipped_hwc
        quadrants[name] = [round(float(v), 4) for v in src[rows, cols].reshape(-1, 3).mean(axis=0)]
    probes = []
    for (h, w) in ((0, 0), (0, width - 1), (height // 2, width // 3), (height - 1, width - 1)):
        probes.append({
            "at": [h, w],
            "source": [int(v) for v in rgb[h, w]],
            "expected_from_source": [int(v) for v in rgb[height - 1 - h, width - 1 - w]],
            "actual_flipped": [int(v) for v in flipped_hwc[h, w]],
        })
    return {
        "image": os.path.abspath(path),
        "shape_hwc": list(rgb.shape),
        "shape_chw_batched": list(tensor.shape),
        "sha256": {
            "source_rgb_tobytes": hashlib.sha256(rgb.tobytes()).hexdigest(),
            "source_png_file": hashlib.sha256(open(path, "rb").read()).hexdigest(),
            "flip180_rgb_tobytes": hashlib.sha256(flipped_hwc.tobytes()).hexdigest(),
            "flip180_png_file": hashlib.sha256(open(flip_path, "rb").read()).hexdigest(),
            "flip180_twice_rgb_tobytes": hashlib.sha256(twice[0].transpose(1, 2, 0).tobytes()).hexdigest(),
        },
        "quadrant_mean_rgb": quadrants,
        "probes": probes,
        "pixel_mismatches_vs_reference": int(np.count_nonzero(flipped_hwc != np.flip(rgb, axis=(0, 1)))),
        "double_flip_is_identity": bool(np.array_equal(twice[0].transpose(1, 2, 0), rgb)),
        "double_flip_sha256_equals_source": hashlib.sha256(twice[0].transpose(1, 2, 0).tobytes()).hexdigest() == hashlib.sha256(rgb.tobytes()).hexdigest(),
        "flip180_is_not_vertical_only": not bool(np.array_equal(flipped_hwc, rgb[::-1])),
        "flip180_is_not_horizontal_only": not bool(np.array_equal(flipped_hwc, rgb[:, ::-1])),
        "independent_reference_comparison": _compare_reference(compare, rgb, flipped_hwc, flip_path),
        "written": {"flip180": flip_path, "flip180_twice": twice_path},
    }


def _compare_reference(compare, rgb, flipped_hwc, flip_path):
    """与独立实现产出的对照 PNG 比对（文件字节 + 像素 + 与 PIL rotate(180) 的关系）。"""
    import hashlib  # noqa: PLC0415
    import os  # noqa: PLC0415

    if not compare:
        return None
    import numpy as np  # noqa: PLC0415

    from PIL import Image  # noqa: PLC0415

    reference = np.asarray(Image.open(compare).convert("RGB"), dtype=np.uint8)
    mine_bytes = hashlib.sha256(open(flip_path, "rb").read()).hexdigest()
    reference_bytes = hashlib.sha256(open(compare, "rb").read()).hexdigest()
    # 对照 PNG 自身是否就是**源**的 180°（用 PIL 的独立实现核一遍，防止"两个实现一起错"）
    pil_rot180_of_source = np.asarray(Image.fromarray(rgb).rotate(180), dtype=np.uint8)
    return {
        "reference_path": os.path.abspath(compare),
        "mine_png_file_sha256": mine_bytes,
        "reference_png_file_sha256": reference_bytes,
        "png_file_bit_identical": mine_bytes == reference_bytes,
        "pixels_equal_reference": bool(np.array_equal(flipped_hwc, reference)),
        "diff_pixels_vs_reference": int(np.count_nonzero(flipped_hwc != reference)),
        "reference_equals_pil_rotate180_of_source": bool(np.array_equal(reference, pil_rot180_of_source)),
        "mine_equals_pil_rotate180_of_source": bool(np.array_equal(flipped_hwc, pil_rot180_of_source)),
    }


def main():
    if len(sys.argv) < 2:
        fail("LIBERO_ENV_PROCESSOR_USAGE", "用法: libero_env_processor.py --selftest | --verify-against-official | --probe-image <png> --out <dir> | --print-describe")
    command = sys.argv[1]
    if command == "--print-describe":
        print(json.dumps(describe(), ensure_ascii=False, indent=2))
        return
    if command == "--selftest":
        print(json.dumps(_selftest(), ensure_ascii=False, indent=2))
        return
    if command == "--verify-against-official":
        print(json.dumps(_verify_against_official(), ensure_ascii=False, indent=2))
        return
    if command == "--probe-image":
        if len(sys.argv) < 3:
            fail("LIBERO_ENV_PROCESSOR_USAGE", "--probe-image 需要 PNG 路径")
        out_dir = "."
        if "--out" in sys.argv:
            out_dir = sys.argv[sys.argv.index("--out") + 1]
        compare = sys.argv[sys.argv.index("--compare") + 1] if "--compare" in sys.argv else None
        print(json.dumps(_probe_image(sys.argv[2], out_dir, compare), ensure_ascii=False, indent=2))
        return
    fail("LIBERO_ENV_PROCESSOR_USAGE", f"未知命令 {command!r}")


if __name__ == "__main__":
    main()
