#!/usr/bin/env python3
"""LIBERO × VLA（SmolVLA）**产品侧**推理：把 lane 侧的 VLA 推理接线落成产品模块。

为什么需要这个文件（缺口，见 `bugfixHistory/DEV028-PRODUCT-VLA-ROUTE-20260923.md`）：
- `src/pack-contract.ts:57` 的 `IMPLEMENTED_SERVER_SIDE_INFERENCE = []` 为空 ⇒ `src/adapter.ts:261-263`
  的 `PACK_SERVER_SIDE_INFERENCE` 分支走不到；服务端 pack-endpoint（归 LyapunovOM）只有
  `/health`、`/packs/v1/{discovery,catalog,open,stream}`（无推理路由）；`python/torch_cpu.py` 只做
  关节级单帧 torchscript/onnx。⇒ 在 L416 之前，VLA 的**推理**只存在于 lane 本地服务
  （`.runtime/lane-*/infer_server.py`），按 DEV-028/023 的口径不算产品通路。本模块补上这一件：
  **推理实现落产品源码**，观测/动作口径复用同目录的产品模块 `libero_env_processor.py`（官方
  `LiberoProcessorStep` 等价物），**不新增第二套推理框架**。

协议：与 `python/torch_cpu.py` **逐字段同构**（`{"id":n,"method":…}` → `{"id":n,"result":…}` /
`{"id":n,"error":…}`），因此产品既有的 `src/execution.ts:13-40` `CPUInference` 子进程 harness
**不需要任何改动**即可承载本模块（同一 spawn / 同一 JSON 行读写 / 同一 `id` 关联）。
    → {"id":1,"method":"load","format":"libero-vla","adapterPath":"<derived/adapter.json>",
       "policyDir":"<已校验策略快照根>","depsPath":"<lerobot pydeps 绝对路径>","task":"turn on the stove"}
    ← {"id":1,"result":{"device":"cpu","policyType":"smolvla","loadS":…,"chunkSize":…,
                        "envProcessor":{…},"wristMode":"real"}}
    → {"id":2,"method":"infer","actions":7,"observation":{"imagePath":…,"wristImagePath":…,
       "eef":[3],"quatXyzw":[4],"gripper":[2],"task":…}}
    ← {"id":2,"result":{"values":[steps×7 个有限浮点],"steps":steps,"actionDim":7}}
       **默认出块**（steps = 检查点 n_action_steps ≤ chunk_size，官方 `eval_libero.py:131-133`
       `predict_action_chunk → chunk[:, :n_action_steps]` 同形），调用方按 7 维切队列逐步执行；
       `"singleAction":true` 时 steps=1（走 `select_action` 的内部队列）。
    → {"id":3,"method":"reset"}   ← {"id":3,"result":{"status":"reset-ok"}}
不认识的 method 明确报错（不静默当成 infer）。

观测口径（**必须与官方 `eval_libero.py:130` 同序**：`preprocessor(env_preprocessor(proc_obs))`）：
1. 图像：PNG → RGB → 256²（config.json 观测契约）→ float32 CHW /255 → **加批维** (1,3,256,256)；
2. `observation.robot_state.{eef.pos(3), eef.quat(4,xyzw), gripper.qpos(2)}` → `libero_env_processor`：
   **先 180° 翻图**（`torch.flip(dims=[2,3])`，官方 `env_processor.py:59`）再把 robot_state 拼成
   `observation.state` (1,8)（官方 `:65-82`）；
3. `task` 用 `policy_task()`/`paired_task()` 做**批维配对**（已批处理 ⇒ 1 元素 list，官方
   `eval_libero.py:120-127`）——半改法直接抛错，不静默坏 prompt；
4. 过 SmolVLA 自己的 policy preprocessor（tokenizer + MEAN_STD 归一化）→ `select_action`（内部按
   检查点声明的 `n_action_steps` 排队出块）→ 动作恒等 env_post（`lerobot==0.6.1` 空 pipeline）。

依赖边界（**不新增依赖**，复用既有 lerobot/torch 环境）：
- 解释器＝产品 `pythonPath()` 的同一口径（`src/adapter.ts:40`：`LYAPUNOV_POLICY_PYTHON` ⇒
  `LYAPUNOV_MUJOCO_PYTHON` ⇒ `.runtime/sim-python/bin/python`）；
- lerobot 运行库＝既有 `.runtime/lane-libero-vla/pydeps`（`lerobot==0.4.4` + torch CPU），由
  `--deps`/`load.depsPath`/`$LYAPUNOV_LIBERO_VLA_PYDEPS` 给出**绝对路径**；缺了明确失败，不静默降级；
- 本文件与 `libero_env_processor.py` 同为纯策略侧口径件，**不 import lerobot 之外的新包**。

失败码（非零退出 + stderr，或协议行 `error`，不静默）：
    2 LIBERO_VLA_USAGE                 参数/请求缺字段
    3 LIBERO_VLA_SOURCE_FILES_MISSING  权重/config/derived adapter 缺失
    4 LIBERO_VLA_ADAPTER_CONTRACT      派生件与 7 维 OSC delta 契约不符
    5 LIBERO_VLA_ENV_PROCESSOR_UNDECLARED 派生件未声明 envProcessor（= L398 已证的 0/3 失败形态）
    6 LIBERO_VLA_DEPS_UNAVAILABLE      lerobot/torch/numpy/PIL 运行库不可用（给出所查路径）
    7 LIBERO_VLA_WRIST_IMAGE_MISSING   真腕图像缺失（默认拒绝用 agentview 冒充）
"""
import argparse
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import libero_env_processor as envproc  # noqa: E402  （产品同目录模块，非 lane 件）

ERRORS = {
    "LIBERO_VLA_USAGE": 2,
    "LIBERO_VLA_SOURCE_FILES_MISSING": 3,
    "LIBERO_VLA_ADAPTER_CONTRACT": 4,
    "LIBERO_VLA_ENV_PROCESSOR_UNDECLARED": 5,
    "LIBERO_VLA_DEPS_UNAVAILABLE": 6,
    "LIBERO_VLA_WRIST_IMAGE_MISSING": 7,
}
IMAGE_SIZE = (256, 256)
STATE_DIM = 8
ACTION_DIM = 7
AGENTVIEW_KEY = envproc.OBS_IMAGES + ".image"
WRIST_KEY = envproc.OBS_IMAGES + ".wrist_image"
#: 协议通道：`torch_cpu.py` 不 import 大库所以没这个问题；本模块要 import lerobot/transformers，
#: 它们会往 stdout 打进度/告警（实测 "Reducing the number of VLM layers to 16 ..." ⇒ 会污染协议流、
#: 让消费侧 JSON.parse 失败）。因此协议行只走这里保存的**原 stdout**，其余 print 一律改道 stderr。
PROTOCOL = sys.stdout


def emit(payload):
    print(json.dumps(payload, allow_nan=False, ensure_ascii=False), file=PROTOCOL, flush=True)


class VlaError(RuntimeError):
    """带产品失败码的明确失败（调用方按 code 判定，不靠文案）。"""

    def __init__(self, code, message):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.reason = message


def die(code, message):
    print(f"{code}: {message}", file=sys.stderr)
    raise VlaError(code, message)


def load_runtime(deps_path):
    """按绝对路径接入既有 lerobot/torch 运行库（不新增依赖、不静默降级）。"""
    if deps_path and deps_path not in sys.path:
        sys.path.insert(0, deps_path)
    try:
        import numpy as np  # noqa: PLC0415
        import torch  # noqa: PLC0415
        from PIL import Image  # noqa: PLC0415
        from lerobot.configs.policies import PreTrainedConfig  # noqa: PLC0415
        from lerobot.policies.smolvla.modeling_smolvla import SmolVLAPolicy  # noqa: PLC0415
        from lerobot.policies.smolvla.processor_smolvla import make_smolvla_pre_post_processors  # noqa: PLC0415
    except ImportError as error:
        raise RuntimeError(
            f"LIBERO_VLA_DEPS_UNAVAILABLE: 运行库不可用（depsPath={deps_path!r}，"
            f"sys.path 头 3={sys.path[:3]}）：{error}"
        ) from None
    return np, torch, Image, PreTrainedConfig, SmolVLAPolicy, make_smolvla_pre_post_processors


def read_adapter(path):
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        die("LIBERO_VLA_SOURCE_FILES_MISSING", f"派生件缺失或为空: {path}")
    with open(path) as stream:
        adapter = json.load(stream)
    if adapter.get("actionDim") != ACTION_DIM:
        die("LIBERO_VLA_ADAPTER_CONTRACT", f"actionDim 必须是 {ACTION_DIM}（OSC_POSE delta），实得 {adapter.get('actionDim')!r}")
    shape = ((adapter.get("observations") or {}).get("state") or {}).get("shape")
    if list(shape or []) != [STATE_DIM]:
        die("LIBERO_VLA_ADAPTER_CONTRACT", f"observations.state.shape 必须是 [{STATE_DIM}]，实得 {shape!r}")
    # env 层是**契约的一部分**（L398 实测：缺这一层 ⇒ 100 步旋钮恒 0.0 rad、无 check_success）。
    # 派生件没声明它 ⇒ 拒绝推理，而不是静默用未翻转的图像出动作。
    if not isinstance(adapter.get("envProcessor"), dict):
        die(
            "LIBERO_VLA_ENV_PROCESSOR_UNDECLARED",
            f"{path} 未声明 envProcessor（缺官方 env_preprocessor 口径） ⇒ 拒绝推理："
            "该形态即 DEV028-GRIFFIN-CRITERION 已证的 0/3 失败形态（图像 180° 倒置进策略）",
        )
    return adapter


class Engine:
    def __init__(self, request, cli):
        self.adapter_path = request.get("adapterPath") or cli.adapter
        if not self.adapter_path:
            die("LIBERO_VLA_USAGE", "缺 adapterPath/--adapter（产品 policy_prepare 产出的 derived/adapter.json）")
        self.adapter = read_adapter(self.adapter_path)
        self.policy_dir = request.get("policyDir") or cli.policy_dir or os.path.dirname(os.path.abspath(self.adapter_path))
        if not os.path.isdir(self.policy_dir):
            die("LIBERO_VLA_SOURCE_FILES_MISSING", f"策略快照根不存在: {self.policy_dir}")
        deps = request.get("depsPath") or cli.deps or os.environ.get("LYAPUNOV_LIBERO_VLA_PYDEPS")
        # 本地 HF 处理器缓存（SmolVLM2 tokenizer/processor 约 4.7 MB）：显式给出即**离线**加载，
        # 不依赖网络；不给则沿用既有 HF_HOME 语义（保持产品其它链路的既有行为）。
        hf_home = request.get("hfHome") or cli.hf_home or os.environ.get("LYAPUNOV_HF_HOME")
        self.hf_home = hf_home or os.environ.get("HF_HOME")
        self.offline = bool(hf_home)
        if hf_home:
            if not os.path.isdir(hf_home):
                die("LIBERO_VLA_DEPS_UNAVAILABLE", f"hfHome 不存在: {hf_home}")
            os.environ["HF_HOME"] = hf_home
            os.environ["HF_HUB_OFFLINE"] = "1"
            os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
        self.np, self.torch, self.Image, PreTrainedConfig, SmolVLAPolicy, make_pre_post = load_runtime(deps)
        self.deps_path = deps
        self.allow_wrist_substitution = bool(request.get("allowWristSubstitution")) or bool(cli.allow_wrist_substitution)
        self.task = request.get("task") or (self.adapter.get("task") or {}).get("languageInstruction")
        if not isinstance(self.task, str) or not self.task.strip():
            die("LIBERO_VLA_ADAPTER_CONTRACT", "adapter.task.languageInstruction 缺失，且请求未给 task")
        t0 = time.time()
        config = PreTrainedConfig.from_pretrained(self.policy_dir)
        config.device = "cpu"
        # 可选开环步长覆盖（A/B 用；默认取检查点声明的 n_action_steps，本检查点=50）。
        if cli.n_action_steps:
            override = int(cli.n_action_steps)
            if override <= 0 or override > int(getattr(config, "chunk_size", 0) or 0):
                die("LIBERO_VLA_ADAPTER_CONTRACT", f"n_action_steps 覆盖值非法: {override}（检查点 chunk_size={getattr(config, 'chunk_size', None)}）")
            config.n_action_steps = override
        # 检查点自带全量 VLM 权重（下方覆盖度硬校验），跳过 load_vlm_weights 的冗余下载。
        config.load_vlm_weights = False
        self.policy = SmolVLAPolicy.from_pretrained(self.policy_dir, config=config)
        self.policy.eval()
        self.load_s = time.time() - t0
        # 权重覆盖度硬校验：缺键 ⇒ 明确失败（不静默用随机初始化的一半权重出动作）。
        from safetensors import safe_open  # noqa: PLC0415
        weights = self.adapter.get("weightsPath") or os.path.join(self.policy_dir, self.adapter.get("weightsFile") or "model.safetensors")
        if not os.path.isfile(weights):
            die("LIBERO_VLA_SOURCE_FILES_MISSING", f"权重文件缺失: {weights}")
        with safe_open(weights, framework="pt") as handle:
            file_keys = {key for key in handle.keys() if key.startswith("model.")}
        model_keys = {key for key in self.policy.state_dict() if key.startswith("model.")}
        missing_in_file = sorted(model_keys - file_keys)
        missing_in_model = sorted(file_keys - model_keys)
        if missing_in_file or missing_in_model:
            die("LIBERO_VLA_ADAPTER_CONTRACT", f"权重覆盖度不符 file_missing={missing_in_file[:5]} model_missing={missing_in_model[:5]}")
        norm = ((self.adapter.get("observations") or {}).get("normalization") or {})
        stats = {
            "observation.state": {"mean": self.torch.tensor(norm["stateMean"], dtype=self.torch.float32),
                                  "std": self.torch.tensor(norm["stateStd"], dtype=self.torch.float32)},
            "action": {"mean": self.torch.tensor(norm["actionMean"], dtype=self.torch.float32),
                       "std": self.torch.tensor(norm["actionStd"], dtype=self.torch.float32)},
        }
        self.pre, self.post = make_pre_post(config, dataset_stats=stats)
        self.chunk_size = int(getattr(config, "n_action_steps", 1) or 1)
        self.weights_path = weights

    def image_tensor(self, path, label):
        if not isinstance(path, str) or not os.path.isfile(path):
            die("LIBERO_VLA_SOURCE_FILES_MISSING", f"{label} 图像缺失: {path!r}")
        image = self.Image.open(path).convert("RGB")
        if image.size != IMAGE_SIZE:
            image = image.resize(IMAGE_SIZE, self.Image.BILINEAR)
        array = self.np.asarray(image, dtype=self.np.float32) / 255.0
        tensor = self.torch.from_numpy(array.copy()).permute(2, 0, 1).contiguous()
        return tensor.unsqueeze(0)  # 批维：官方 env 层 dims=[2,3] 只在 (B,C,H,W) 上成立

    def observe(self, request):
        torch = self.torch
        image = self.image_tensor(request["imagePath"], "agentview")
        wrist_path = request.get("wristImagePath")
        if isinstance(wrist_path, str) and wrist_path:
            wrist = self.image_tensor(wrist_path, "wrist")
            wrist_source = "real"
        elif self.allow_wrist_substitution:
            wrist, wrist_source = image, "substitute"
        else:
            die("LIBERO_VLA_WRIST_IMAGE_MISSING", "帧未给真腕图像路径（adapter 契约的 R273+ 口径要求真腕）；确要用同帧 agentview 冒充请显式 allowWristSubstitution")
        def row(values, dim, name):
            values = [float(value) for value in values or []]
            if len(values) != dim or not all(math.isfinite(value) for value in values):
                raise ValueError(f"LIBERO_VLA_STATE_DIM_MISMATCH: {name} 需 {dim} 个有限值，实得 {values!r}")
            return torch.tensor([values], dtype=torch.float32)
        observation = {
            AGENTVIEW_KEY: image,
            WRIST_KEY: wrist,
            envproc.OBS_ROBOT_STATE: {
                "eef": {"pos": row(request.get("eef"), 3, "eef"),
                        "quat": row(request.get("quatXyzw"), 4, "quatXyzw")},
                "gripper": {"qpos": row(request.get("gripper"), 2, "gripper")},
            },
        }
        # 官方序：env_preprocessor（翻图 + state 组装）→ policy preprocessor。
        processed, flipped = envproc.env_preprocess_observation(observation)
        batched = envproc.is_batched(processed)
        processed["task"] = envproc.paired_task(envproc.policy_task(request.get("task") or self.task), batched)
        self.last_flipped = sorted(flipped)
        self.last_batched = batched
        self.last_state_shape = list(envproc._shape(processed[envproc.OBS_STATE]))
        return self.pre(processed)

    def infer(self, request):
        observation = request.get("observation")
        if not isinstance(observation, dict):
            raise ValueError("LIBERO_VLA_USAGE: infer 需要结构化 observation（imagePath/wristImagePath/eef/quatXyzw/gripper）")
        processed = self.observe(observation)
        action_dim = int(request.get("actions", ACTION_DIM))
        if action_dim != ACTION_DIM:
            raise ValueError(f"LIBERO_VLA_USAGE: actions 必须是 {ACTION_DIM}，实得 {request.get('actions')!r}")
        with self.torch.inference_mode():
            if request.get("singleAction") is True:
                # 单动作形态：走 `select_action`（lerobot 内部按 n_action_steps 排队）
                action = self.post(self.policy.select_action(processed))
                values = [float(value) for value in action.reshape(-1)[:ACTION_DIM]]
                steps = 1
            else:
                # **默认＝出块**：与官方 `eval_libero.py:131-133` 同形（`predict_action_chunk` →
                # `chunk[:, :n_action_steps]` → 队列 → 逐步 env.step），也是产品 `src/execution.ts`
                # VLA 分支 `vlaChunkQueue(values, actionDim, chunkSteps)` 的入参形态：
                # 每 n_action_steps 步重规划一次，而不是每步一次（CPU 上一次规划 ~50 s）。
                chunk = self.post(self.policy.predict_action_chunk(processed))
                # 官方 `eval_libero.py:135` 的动作侧 env_post（`lerobot==0.6.1` 恒等）；调用点保留以便上游加步骤时被测试抓住。
                chunk = envproc.env_postprocess_action(chunk)
                steps = int(min(self.chunk_size, int(chunk.shape[1])))
                values = [float(value) for value in chunk[0, :steps].reshape(-1)]
        if len(values) != steps * ACTION_DIM or not all(math.isfinite(value) for value in values):
            raise ValueError("LIBERO_VLA_ACTION_NOT_FINITE")
        # 回包形状与检查点声明一致（调用方按 `values.length % actionDim == 0` 切队列，见 execution.ts vlaChunkQueue）。
        return {"values": values, "steps": steps, "actionDim": ACTION_DIM}

    def reset(self):
        # select_action 的动作队列随 episode 重置（lerobot 内部 `_queues`）。
        try:
            self.policy.reset()
        except AttributeError:
            pass
        return {"status": "reset-ok"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--policy-dir")
    parser.add_argument("--adapter")
    parser.add_argument("--deps", help="既有的 lerobot pydeps 绝对路径（默认 $LYAPUNOV_LIBERO_VLA_PYDEPS）")
    parser.add_argument("--hf-home", help="本地 HF 处理器缓存绝对路径（默认 $LYAPUNOV_HF_HOME/$HF_HOME；给出即离线加载）")
    parser.add_argument("--n-action-steps", help="可选：覆盖开环步长（默认取检查点声明；A/B 用）")
    parser.add_argument("--allow-wrist-substitution", action="store_true")
    parser.add_argument("--selftest", action="store_true", help="只做 env 层/契约自检，不加载权重")
    args = parser.parse_args()
    if args.selftest:
        _selftest(args)
        return
    engine = None
    # 库的 print/WARNING 一律改道 stderr，协议流只留 JSON 行（见 PROTOCOL 注释）。
    sys.stdout = sys.stderr
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError as error:
            emit({"id": None, "error": f"LIBERO_VLA_USAGE: 非 JSON 行（{error}）"})
            continue
        identifier = request.get("id")
        try:
            method = request.get("method")
            if method == "load":
                engine = Engine(request, args)
                emit({"id": identifier, "result": {
                    "device": "cpu", "policyType": self_policy_type(engine), "loadS": round(engine.load_s, 1),
                    "chunkSize": engine.chunk_size, "actionDim": ACTION_DIM, "wristMode": "real",
                    "policyDir": engine.policy_dir, "weightsPath": engine.weights_path, "depsPath": engine.deps_path,
                    "hfHome": engine.hf_home, "offline": engine.offline,
                    "envProcessor": {
                        "module": "libero_env_processor", "envPreSteps": engine.adapter["envProcessor"]["envPreSteps"],
                        "envPostSteps": engine.adapter["envProcessor"]["envPostSteps"],
                        "imageFlip180": engine.adapter["envProcessor"]["imageFlip180"]["op"],
                        "stateShape": engine.adapter["envProcessor"]["stateAssembly"]["shape"],
                        "taskShape": engine.adapter["envProcessor"]["taskShape"],
                    },
                }})
            elif method == "infer":
                if engine is None:
                    raise ValueError("LIBERO_VLA_USAGE: 未 load 就 infer")
                emit({"id": identifier, "result": engine.infer(request)})
            elif method == "reset":
                if engine is None:
                    raise ValueError("LIBERO_VLA_USAGE: 未 load 就 reset")
                emit({"id": identifier, "result": engine.reset()})
            else:
                raise ValueError(f"LIBERO_VLA_USAGE: 未知 method={method!r}（只接受 load/infer/reset）")
        except BaseException as error:  # 明确失败，不静默出动作
            reason = str(error)
            code = getattr(error, "code", None)
            if code is None and isinstance(error, SystemExit):  # die() 之外的退出路径也要带码
                reason, code = f"LIBERO_VLA_FATAL: exit {error.code}", "LIBERO_VLA_FATAL"
            emit({"id": identifier, "error": reason, "code": code or "LIBERO_VLA_UNCLASSIFIED"})


def self_policy_type(engine):
    return (engine.adapter or {}).get("policyType") or "smolvla"


def _selftest(args):
    """不加载权重的契约自检：env 层翻转 + state 组装 + task 配对（在真实派生件上跑）。"""
    adapter = read_adapter(args.adapter)
    import numpy as np  # noqa: PLC0415
    image = np.arange(2 * 3 * 4, dtype=np.float32).reshape(1, 3, 2, 4)
    observation = {
        AGENTVIEW_KEY: image.copy(),
        envproc.OBS_ROBOT_STATE: {
            "eef": {"pos": np.array([[1.0, 2.0, 3.0]]), "quat": np.array([[0.0, 0.0, 0.0, 1.0]])},
            "gripper": {"qpos": np.array([[0.25, -0.25]])},
        },
    }
    processed, flipped = envproc.env_preprocess_observation(observation)
    batched = envproc.is_batched(processed)
    task = envproc.paired_task(envproc.policy_task(adapter["task"]["languageInstruction"]), batched)
    flip_ok = bool(np.array_equal(processed[AGENTVIEW_KEY], np.flip(image, axis=(2, 3))))
    state = processed[envproc.OBS_STATE]
    print(json.dumps({
        "adapter": args.adapter, "flippedKeys": flipped, "flip180MatchesNumpyFlip": flip_ok,
        "batched": batched, "stateShape": list(np.shape(state)), "state": np.asarray(state).reshape(-1).tolist(),
        "task": task, "envProcessorDeclared": True, "actionDim": adapter["actionDim"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except VlaError as error:
        raise SystemExit(ERRORS[error.code]) from None
