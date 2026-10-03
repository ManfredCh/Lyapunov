"""DEV-028 / Walk These Ways（Go1）策略 → MuJoCo position-PD 适配派生件。

只读输入：策略目录（`runs/gait-conditioned-agility/pretrain-v0/train/025417.456545/` 下的两个
TorchScript 与 `parameters.pkl`）与 Go1 MJCF 原件；本脚本只写派生 MJCF 与 stdout 上的一行
`PreparedAdapter` JSON（与 `prepare_go2.py`/`prepare_unitree.py` 同形）。

语义来源（全部来自 parameters.pkl 与 WTW 源码，见回执 Round 4/5）：
  · PD：`Cfg.control.stiffness.joint=20.0` / `damping.joint=0.5`；`action_scale=0.25`；`hip_scale_reduction=0.5`
  · 频率：`Cfg.sim.dt=0.005` × `Cfg.control.decimation=4` ⇒ 控制 50 Hz
  · 关节序与默认角：`Cfg.init_state.default_joint_angles`（12 个，插入序即策略序）
  · 观测 70 维：projected_gravity(3) → commands*scale(15) → (dof_pos−default)*scale(12) →
    dof_vel*scale(12) → actions(12) → last_actions(12) → clock_inputs(4)
    （`go1_gym/envs/base/legged_robot.py:302-372`；标志取自 pkl 的 `env.observe_*`）
  · 历史：`Cfg.env.num_observation_history=30` ⇒ 30×70=2100（`go1_gym/envs/wrappers/history_wrapper.py:15,24`）
  · 步态相位周期：`Cfg.commands.limit_gait_frequency=[2.0,4.0]` ⇒ phasePeriodS = 1/mean
"""
from __future__ import annotations

import io
import json
import pickle
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import mujoco
import numpy as np

PKL = "runs/gait-conditioned-agility/pretrain-v0/train/025417.456545/parameters.pkl"
WEIGHTS = "runs/gait-conditioned-agility/pretrain-v0/train/025417.456545/checkpoints/body_latest.jit"
ADAPTATION = "runs/gait-conditioned-agility/pretrain-v0/train/025417.456545/checkpoints/adaptation_module_latest.jit"
# 派生件里声明 pkl 初态（`Cfg.init_state`：基座 pos + default_joint_angles）的关键帧名。
# 口径同 `prepare_go2.py` 的 `inria_policy_q0`：**新增**一个具名关键帧、不覆盖原件自带的 `home`。
POLICY_INITIAL_KEYFRAME = "wtw_policy_q0"
PHYSICS_FIELDS = [
    "body_mass", "body_inertia", "geom_type", "geom_size", "geom_contype",
    "geom_conaffinity", "geom_friction", "jnt_range", "jnt_actfrcrange", "actuator_gear",
]


class _NoTorchUnpickler(pickle.Unpickler):
    """torch 不可用时的兜底：pkl 里嵌的是 CUDA 保存的 tensor storage，而本脚本只读 `Cfg` 下的
    标量/字典/列表 ⇒ 把 `torch.*` 的类替换成占位对象即可（不构造真正的张量）。"""

    def find_class(self, module, name):  # type: ignore[override]
        if module.split(".")[0] == "torch":
            return type("_TorchStub", (), {"__init__": lambda self, *a, **k: None, "__setstate__": lambda self, state: None})
        return super().find_class(module, name)


def load_parameters(path: Path) -> dict:
    """优先用 torch（CUDA 保存 + 嵌套 storage 双重 torch.load ⇒ 先给 torch.load 打 CPU 补丁再 pickle.load）；
    **torch 不可用**（例如产品的策略 python 在别处 HOME 下找不到用户站点包）时退回纯 pickle + 占位反序列化。"""
    try:
        import torch  # noqa: F401
    except ImportError:
        with path.open("rb") as handle:
            return _NoTorchUnpickler(handle).load()
    original = torch.load
    torch.load = lambda *args, **kwargs: original(*args, **{**kwargs, "map_location": "cpu"})  # type: ignore[assignment]
    try:
        with path.open("rb") as handle:
            return pickle.load(handle)
    finally:
        torch.load = original  # type: ignore[assignment]


def parse_mjcf(path: Path) -> ET.ElementTree:
    """WTW 的 go1.xml 里有**未加引号的属性值**（如 `objtype=site`，MuJoCo 接受、`xml.etree` 不接受）
    ⇒ 只做一处最小预处理：把 `<name>=<bare-value>` 形式补上引号，其余字节原样保留。"""
    import re
    text = path.read_text(encoding="utf-8")
    text = re.sub(r'(\s[A-Za-z_][\w.:-]*)=([A-Za-z_][\w.:-]*)(?=[\s/>])', r'\1="\2"', text)
    return ET.ElementTree(ET.fromstring(text))


def measure_initial_states(derived: Path, keyframe: str, policy_joints: dict, declared_base_z: float) -> dict:
    """量两个位形到地面（z=0 平面）的最近有符号距离：一个**断言语义**，两个**登记几何**。

    · `declaredPolicyInitialState`：`<keyframe name=keyframe>` 声明的 pkl 初态
      （= `Cfg.init_state.pos` + `Cfg.init_state.default_joint_angles`）。**断言**它逐关节等于 pkl 的
      default_joint_angles、基座 z 等于 pkl 的 init_state.pos[2] —— 这是"派生件确实声明了 pkl 初态"的判据。
    · 两个位形到地面（z=0 平面）的**有符号距离只登记、不断言**：本脚本的输入不保证是注册机型
      （合成夹具的 pkl/几何是造的），几何断言会误伤它们。读数走 stderr：
        - `declaredPolicyInitialState`：pkl 高度 + pkl 默认角 ⇒ 真 Go1 上应贴地（实测 +0.0152 m）；
        - `engineAssemblySeed`：模型 `qpos0`（= trunk body pos + 各 hinge ref）⇒ 引擎装配后、任何声明被
          写进去**之前**用的位形。真 Go1 上是"pkl 高度 × 原件关节 0 位形"，穿地 0.109 m
          （P17 实测：Isaac 侧 SDK 预热步按去穿透上限给基座 ~10 m/s）。该组合在 MJCF 里无法两全
          （见 ① 的 `ref` 实测），修点属 `sim-isaac/python/worker.py`（冻结中，见回执）。

    派生 MJCF 自身不带地面（地面由 world/scene 提供，`worldOptions.ground=true`），所以把**同一份派生件**
    在一份临时副本里加一块 z=0 平面再编译后再量 —— 量的就是产品默认路径下引擎看到的那两个位形。
    """
    import tempfile

    text = derived.read_text(encoding="utf-8")
    assert "</worldbody>" in text, "派生 MJCF 应有 </worldbody>"
    probe_text = text.replace("</worldbody>", '  <geom name="__ground" type="plane" size="6 6 0.1" pos="0 0 0"/>\n  </worldbody>')
    with tempfile.TemporaryDirectory() as scratch:
        probe = Path(scratch) / derived.name
        probe.write_text(probe_text, encoding="utf-8")
        model = mujoco.MjModel.from_xml_path(str(probe))
        data = mujoco.MjData(model)
        ground = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, "__ground")
        contacts = [i for i in range(model.ngeom)
                    if i != ground and (model.geom_contype[i] or model.geom_conaffinity[i])]

        def lowest() -> tuple[str, float]:
            if not contacts:
                return ("(无碰撞 geom)", float("nan"))
            index = min(contacts, key=lambda i: float(mujoco.mj_geomDistance(model, data, i, ground, 5.0, None)))
            return (mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, index) or f"geom{index}",
                    float(mujoco.mj_geomDistance(model, data, index, ground, 5.0, None)))

        data.qpos[:] = model.qpos0                      # 引擎装配种子位形
        mujoco.mj_forward(model, data)
        seed_name, seed_clearance = lowest()

        key_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_KEY, keyframe)
        assert key_id >= 0, f"派生件缺少声明的初态关键帧 {keyframe}"
        data.qpos[:] = model.key_qpos[key_id]            # pkl 声明的初态
        mujoco.mj_forward(model, data)
        declared_name, declared_clearance = lowest()
        declared_joints = {}
        for j in range(model.njnt):
            joint_name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT, j)
            if joint_name in policy_joints:
                declared_joints[joint_name] = float(data.qpos[model.jnt_qposadr[j]])
        declared_base = float(model.key_qpos[key_id][2])
    missing = sorted(set(policy_joints) - set(declared_joints))
    assert not missing, f"关键帧 {keyframe} 缺这些关节：{missing}"
    mismatch = {name: (value, policy_joints[name]) for name, value in declared_joints.items()
                if abs(value - policy_joints[name]) > 1e-9}
    assert not mismatch, f"关键帧 {keyframe} 的关节值不是 pkl default_joint_angles：{mismatch}"
    assert abs(declared_base - declared_base_z) <= 1e-9, (
        f"关键帧 {keyframe} 的基座高度 {declared_base:g} 不是 pkl init_state.pos[2]={declared_base_z:g}")
    return {"declaredKeyframe": keyframe,
            "declaredPolicyInitialState": {"trunkZ": declared_base, "jointsFromPkl": len(declared_joints),
                                           "lowestGeom": declared_name, "groundClearanceM": declared_clearance},
            "engineAssemblySeed": {"trunkZ": float(model.qpos0[2]), "lowestGeom": seed_name,
                                   "groundClearanceM": seed_clearance,
                                   "note": "引擎装配时先用的位形（trunk body pos + hinge ref）；pkl 高度 ⟂ 原件关节 0 位形 ⇒ 真 Go1 上穿地 0.109 m，修点在冻结的 sim-isaac/python/worker.py"}}


def main() -> None:
    root, model_arg, output_arg = (Path(value) for value in sys.argv[1:4])
    # 模型目录支持两种布局：menagerie（`<dir>/go1.xml` + `assets/`）与 WTW（`<dir>/xml/go1.xml` + `meshes/`）。
    # 注意：WTW 自带的 `resources/robots/go1/xml/go1.xml` **不是 MuJoCo 可解析的 XML**
    # （`:189 objtype=site` 属性值未加引号 ⇒ MuJoCo 报 XML_ERROR_PARSING_ATTRIBUTE），因此物理模型用
    # menagerie 的 `unitree_go1`（同 12 关节名、同 5 个 STL）；WTW 的 URDF/XML 仅作语义对照。
    if model_arg.is_file():
        model_source = model_arg
    elif (model_arg / "go1.xml").is_file():
        model_source = model_arg / "go1.xml"
    else:
        model_source = model_arg / "xml" / "go1.xml"
    output = Path(output_arg)
    output.mkdir(parents=True, exist_ok=True)

    parameters = load_parameters(root / PKL)
    cfg = parameters["Cfg"]
    stiffness = float(cfg["control"]["stiffness"]["joint"])
    damping = float(cfg["control"]["damping"]["joint"])
    action_scale = float(cfg["control"]["action_scale"])
    hip_scale = float(cfg["control"]["hip_scale_reduction"])
    # ③ 动作后处理第一环：策略输出先 clip 到 ±clip_actions（pkl `normalization.clip_actions=10.0`；
    # 训练 `legged_robot.py:65-67`、deploy `lcm_agent.py step()` 同一写法），previousAction 槽位也存 clip 后值。
    clip_actions = float(cfg["normalization"]["clip_actions"])
    simulation_dt = float(cfg["sim"]["dt"])
    decimation = int(cfg["control"]["decimation"])
    default_angles = {str(name): float(value) for name, value in cfg["init_state"]["default_joint_angles"].items()}
    joint_names = list(default_angles)  # 插入序 = 策略序
    assert len(joint_names) == 12, f"策略关节数应为 12，实得 {len(joint_names)}"
    num_obs = int(cfg["env"]["num_observations"])
    num_hist = int(cfg["env"]["num_observation_history"])
    gait_low, gait_high = (float(value) for value in cfg["commands"]["limit_gait_frequency"])
    initial_qpos = [float(value) for value in cfg["init_state"]["pos"]]

    # 观测维度按 WTW 源码的拼接顺序核算（标记取自 pkl），必须与 num_observations 逐位吻合。
    obs_order = [
        "projectedGravityFromQuaternion",           # 3
        "command*cmd_scale",                        # Cfg.commands.num_commands = 15
        "(jointPosition-default_angles)*dof_pos_scale",  # 12
        "jointVelocity*dof_vel_scale",              # 12
        "previousAction",                           # 12
        "previousPreviousAction",                   # 12 (observe_two_prev_actions)
        "clockInputs",                              # 4  (observe_clock_inputs)
    ]
    obs_dims = [3, int(cfg["commands"]["num_commands"]), 12, 12, 12, 12, 4]
    assert sum(obs_dims) == num_obs, f"观测拼接 {sum(obs_dims)} != num_observations {num_obs}"

    # ---- 观测尺度与名义步态命令：全部取自同一份 pkl（不猜数值） ----
    # WTW `legged_gym/envs/base/legged_robot.py:1196-1202` 定义 commands_scale 的 15 项组成，
    # 每一项的数值来自 pkl 的 `Cfg.obs_scales`（训练时同一份配置）。
    scales = cfg["obs_scales"]
    num_commands = int(cfg["commands"]["num_commands"])
    commands_scale = [
        float(scales["lin_vel"]), float(scales["lin_vel"]), float(scales["ang_vel"]),
        float(scales["body_height_cmd"]), float(scales["gait_freq_cmd"]),
        float(scales["gait_phase_cmd"]), float(scales["gait_phase_cmd"]),
        float(scales["gait_phase_cmd"]), float(scales["gait_phase_cmd"]),
        float(scales["footswing_height_cmd"]), float(scales["body_pitch_cmd"]),
        float(scales["body_roll_cmd"]), float(scales["stance_width_cmd"]),
        float(scales["stance_length_cmd"]), float(scales["aux_reward_cmd"]),
    ][:num_commands]
    assert len(commands_scale) == num_commands
    cmd_cfg = cfg["commands"]

    def _lower(key: str) -> float:
        return float(cmd_cfg[key][0])

    def _mid(key: str) -> float:
        low, high = (float(value) for value in cmd_cfg[key])
        return 0.5 * (low + high)

    # 步态命令逐项对齐 **deploy 参考实现**（R8，替代 R7 的"区间中点/下界"名义合成）：
    # `go1_gym_deploy/utils/cheetah_state_estimator.py get_command()` 的默认值（RC 无输入）：
    #   `cmd_height=0.`、`cmd_freq=3.0`、`cmd_footswing=0.08`、`cmd_stance_width=0.33`、
    #   `cmd_stance_length=0.40`、`cmd_ori_pitch=0.`、`cmd_ori_roll=0.`；mode 0（对角 trot）：
    #   `cmd_phase=0.5, cmd_offset=0.0, cmd_bound=0.0, cmd_duration=0.5`；返回向量 15 项的第 15 项（aux）= 0。
    # 返回序 = `[x, y, yaw, height, freq, phase, offset, bound, duration, footswing, pitch, roll,
    # stance_width, stance_length, aux]`（与 `lcm_agent.py step()` 读 `commands[:,4..8]` 的相位语义一致）。
    # 每项同时落在 pkl `Cfg.commands` 的采样区间内（freq 3∈[2,4]、duration 0.5=唯一值、footswing
    # 0.08∈[0.03,0.35]、stance_width 0.33∈[0.1,0.45]、stance_length 0.40∈[0.35,0.45] …）。
    gait_defaults = {
        "bodyHeightOffsetM": 0.0,   # deploy cmd_height=0.（body_height_cmd ∈ [-0.25,0.15]）
        "frequencyHz": 3.0,         # deploy cmd_freq=3.0（= limit_gait_frequency [2,4] 中点）
        "phase": 0.5,               # deploy mode 0 trot cmd_phase=0.5（对角步）
        "offset": 0.0,              # deploy mode 0 cmd_offset=0.0
        "bound": 0.0,               # deploy mode 0 cmd_bound=0.0
        "durationS": 0.5,           # deploy mode 0 cmd_duration=0.5（pkl [0.5,0.5] 唯一值）
        "footswingHeightM": 0.08,   # deploy cmd_footswing=0.08（R7 名义中点 0.19 已弃用）
        "bodyPitchRad": 0.0,        # deploy cmd_ori_pitch=0.
        "bodyRollRad": 0.0,         # deploy cmd_ori_roll=0.
        "stanceWidthM": 0.33,       # deploy cmd_stance_width=0.33（R7 名义中点 0.275 已弃用）
        "stanceLengthM": 0.40,      # deploy cmd_stance_length=0.40
        "auxRewardCoef": 0.0,       # deploy get_command()[14]=0
    }
    assert int(cfg["env"]["num_observation_history"]) == num_hist

    # source 与派生件都在策略目录之外（model_arg 指向 materials 资产）⇒ 派生 MJCF 写进 output，
    # meshdir 重指到源资产同级目录（原件只读，不改）。
    tree = parse_mjcf(model_source)
    model = tree.getroot()
    # ① pkl `Cfg.init_state` 的**整条**才是初态：基座高度与关节角是一对，不能只搬高度。
    #    · 基座高度 = `init_state.pos`（[0,0,0.34]，同 `go1_gym/envs/go1/go1_config.py:11
    #      _.pos = [0.0, 0.0, 0.34]`）：menagerie 原件的 free base 起始 z=0.445（`go1.xml:80
    #      <body name="trunk" pos="0 0 0.445">`）。两个数各有各的配对关节位形，**不能互换**：
    #      MuJoCo 3.13 实测（把同一份派生件加一块 z=0 平面后 mj_geomDistance）
    #        (0.34 + 关节全 0 直腿)    ⇒ 足端球陷入地面 10.9 cm
    #        (0.34 + pkl 默认角 屈腿)  ⇒ 抬离地面 1.5–2.4 cm（= 训练资产的站立位形）
    #        (0.445 + 关节全 0 直腿)   ⇒ 贴地（原件作者位形）
    #    · 训练资产是本机同一套几何（WTW URDF `base`→`trunk` 为 xyz=0 的固定关节 ⇒ 自由根坐标系
    #      与 menagerie trunk 同源；髋 (0.1881, ∓0.04675, 0)、腿段 0.213/0.213、足端在 calf −0.213）
    #      ⇒ 0.34 是 pkl 的**忠实**基座初高，前提是**与 pkl 默认角一起**表达。
    #    · 怎么表达：MJCF 的 `qpos0` 只有"trunk body pos + 各 hinge `ref`"两个自由度，而 `ref` 不是
    #      "初值"而是**关节坐标的零点**（实测：ref=0.8 + qpos=0.8 与 ref=0 + qpos=0 是同一个直腿位形
    #      ⇒ 物理角 = qpos − ref）。用 `ref` 写初值会连动作语义一起改（策略给的是**绝对**目标角
    #      default_angles + 0.25·action）⇒ **不用 `ref`**。pkl 的初态只能走关键帧声明（与
    #      `prepare_go2.py:_qpos_for_q0/_append_policy_keyframe` 同一口径），下面 ④ 落 `wtw_policy_q0`。
    #    · qpos0 因此仍是"pkl 高度 + 原件关节 0 位形"，它是**引擎装配时的种子**位形（Isaac 侧实测
    #      被拿去当基座初态；穿地 10.9 cm ⇒ PhysX 去穿透），该种子位形在 MJCF 里无法同时满足两个条件，
    #      见 ④ 的诊断读数与回执。
    trunk = model.find(".//body[@name='trunk']")
    assert trunk is not None, "menagerie go1.xml 应有 trunk body"
    trunk.set("pos", " ".join(f"{float(value):g}" for value in initial_qpos))
    compiler = model.find("compiler")
    assert compiler is not None
    asset_dir = model_source.parent / "assets"
    if not asset_dir.is_dir():
        asset_dir = model_source.parent.parent / "meshes"
    compiler.set("meshdir", str(asset_dir.resolve()))
    actuators = list(model.find("actuator"))  # type: ignore[arg-type]
    model_joint_names = [a.attrib["joint"] for a in actuators]
    model_actuator_names = [a.attrib.get("name", a.attrib["joint"]) for a in actuators]
    # 策略 dof 序 = **deploy 参考实现的策略序 FL/FR/RL/RR × (hip,thigh,calf)**（R8 按证据修正）：
    # `go1_gym_deploy/envs/lcm_agent.py` 的 `joint_names`（default_dof_pos / p_gains / 观测 / 动作同一序）
    # + `go1_gym_deploy/utils/cheetah_state_estimator.py` 的 `joint_idxs=[3,4,5,0,1,2,9,10,11,6,7,8]`（`# reverse
    # legs`）把 unitree SDK 序（FR/FL/RR/RL；`lcm_position.cpp` `joint_state_simple.q[i]=state.motorState[i].q`）
    # 映到该策略序。髋位于 [0,3,6,9]，与 `legged_robot.py:920` 的 hip_scale_reduction 索引自洽。此前 R7 用的
    # 资产序（FR/FL/RR/RL）与 pkl 字典序（髋在前）都与 deploy 不符。
    joint_names = [f"{leg}_{part}_joint" for leg in ("FL", "FR", "RL", "RR") for part in ("hip", "thigh", "calf")]
    assert len(actuators) == 12, f"Go1 MJCF 执行器数应为 12，实得 {len(actuators)}"
    missing = [name for name in joint_names if name not in model_joint_names]
    assert not missing, f"策略关节在 MJCF 中缺失：{missing}"
    for actuator in actuators:
        # menagerie 用 `<position class=…>`（增益在 <default> 类里），WTW 用 `<motor gear="1">`；
        # 两者都归一到**显式 kp/kv 的 position actuator**（策略语义：position 参考 + 源声明 PD）。
        assert actuator.tag in ("motor", "position"), f"未预期的执行器类型 {actuator.tag}"
        if actuator.tag == "motor":
            assert actuator.get("gear", "1") == "1", "官方 Go1 用 gear=1 的 motor"
        actuator.tag = "position"
        actuator.set("kp", str(stiffness))
        actuator.set("kv", str(damping))
        actuator.set("ctrllimited", "false")
        # ③ 动作后处理第三环（力矩限幅）：训练 `_compute_torques` 末行 `torch.clip(torques, -torque_limits,
        # torque_limits)`（`legged_robot.py:946`；torque_limits 取 URDF `effort=33.5`，`:597-602`）⇒ 本派生
        # 模型的 position 执行器 force 显式限到 ±33.5 Nm（覆盖 menagerie 默认类的 ±23.7/±35.55）。
        actuator.set("forcelimited", "true")
        actuator.set("forcerange", "-33.5 33.5")
    target = output / "go1-position-pd.xml"
    tree.write(target, encoding="unicode")

    before = mujoco.MjModel.from_xml_path(str(model_source))
    after = mujoco.MjModel.from_xml_path(str(target))
    for field in PHYSICS_FIELDS:
        np.testing.assert_array_equal(getattr(before, field), getattr(after, field), err_msg=field)
    assert not np.any(after.body_gravcomp)

    # ④ 把 pkl 的初态**整条**落到派生件里（`<keyframe>`，口径同 `prepare_go2.py:_qpos_for_q0/
    #    _append_policy_keyframe`）：qpos = `init_state.pos` + `default_joint_angles`（按**模型自己的
    #    qpos 序**装配，不手写顺序）、ctrl = `default_joint_angles`（按**模型自己的执行器序**）。
    #    原件自带的 `home` 关键帧**不动**（它是原件作者位形，仍有独立用途）；`<keyframe>` 不存在时新建
    #    （合成夹具没有这一段，`prepare_go2.py` 同样建）。
    #    为什么落在关键帧而不是 `qpos0`：`qpos0` 只有"trunk body pos + 各 hinge ref"两个自由度，而
    #    `ref` 是关节**坐标零点**（①里实测），写它等于改坐标系 ⇒ pkl 的"屈腿站立"初态在 `qpos0` 里
    #    表达不出来。关键帧是"策略初态"在 MJCF 里的标准载体。
    #    **本键不接 `config.initialKeyframe`**（那会让 `components.isaac.keyframe` 出现，改动
    #    `test/wtw-identity-dispatch.test.ts:153` 断言的"本派生件没有 WTW 专用关键帧"这条既有设计声明；
    #    该文件不在本单写入域）。当前两个引擎的关节初值都由 adapter 的
    #    `initialJointPositions`/`initialActuatorControls`（= 同一组 default_angles）逐关节给出
    #    ⇒ 本关键帧对既有读数中性；它是"按声明初态复位"那条契约的载体 —— 引擎侧要用它，
    #    改点在 `sim-isaac/python/worker.py`（冻结中，见回执）。
    policy_qpos = [float(value) for value in after.qpos0]
    policy_qpos[0:3] = initial_qpos
    policy_ctrl = [0.0] * after.nu
    for joint_index in range(after.njnt):
        name = mujoco.mj_id2name(after, mujoco.mjtObj.mjOBJ_JOINT, joint_index)
        if name in default_angles:
            policy_qpos[int(after.jnt_qposadr[joint_index])] = default_angles[name]
    for actuator_index in range(after.nu):
        joint_index = int(after.actuator_trnid[actuator_index, 0])
        name = mujoco.mj_id2name(after, mujoco.mjtObj.mjOBJ_JOINT, joint_index)
        policy_ctrl[actuator_index] = default_angles.get(name, 0.0)
    keyframes = model.find("keyframe")
    if keyframes is None:  # 与 `prepare_go2.py:_append_policy_keyframe` 同口径：没有就建，不覆盖原件的
        keyframes = ET.SubElement(model, "keyframe")
    ET.SubElement(keyframes, "key", {
        "name": POLICY_INITIAL_KEYFRAME,
        "qpos": " ".join(f"{float(value):g}" for value in policy_qpos),
        "ctrl": " ".join(f"{float(value):g}" for value in policy_ctrl),
    })
    tree.write(target, encoding="unicode")
    policy_joints = {name: float(default_angles[name]) for name in default_angles}
    #    读数走 stderr（stdout 是 PreparedAdapter 契约，不掺诊断字段）：语义**断言**，几何**登记**。
    print(json.dumps({"initialState": measure_initial_states(target, POLICY_INITIAL_KEYFRAME, policy_joints, initial_qpos[2])}), file=sys.stderr)

    # engine 是这个派生模型的「原生格式/引擎」；supportedEngines 是「同一套动作与观测语义可以在哪些引擎上执行」
    # （与 `prepare_go2.py:133`、`prepare_unitree.py` 的 G1 分支同一口径）。
    # WTW 的动作语义（position 参考 + 源声明 PD kp/kv，目标 = default_angles + 0.25·action，髋 ×0.5）与观测语义
    # （自由根 + 12 关节 + 70 维/30 帧历史 + 4 路 clock，全部在策略侧 python 里算）都不依赖 MuJoCo 求解器：
    # Isaac Provider 用**同一份派生 XML（同 sha256）**走它的 MJCF 导入，dt 与控制抽减也相同（见
    # `packages/policy-registry/src/adapter.ts` 的 WTW 分支 `components.isaac`）。缺这一声明时 `match.ts:77`
    # 会按 `adapter.supportedEngines ?? [adapter.engine]` 把 Isaac world 判成 `SIMULATOR_MISMATCH`，
    # 于是**能力**从没被检验过就被**声明**挡住（P13 实测：Isaac 已成功导入本派生件，12 关节、control 可用）。
    print(json.dumps({
        "adapter": "wtw-go1-torchscript-v1",
        "robot": "unitree-go1-12dof",
        "engine": "mujoco",
        "supportedEngines": ["mujoco", "isaac"],
        "modelPath": str(target),
        "modelSourcePath": str(model_source),
        "weightsPath": str(root / WEIGHTS),
        "config": {
            "simulation_dt": simulation_dt,
            "control_decimation": decimation,
            "default_angles": [default_angles[name] for name in joint_names],
            "action_scale": action_scale,
            "hip_scale_reduction": hip_scale,
            "clip_actions": clip_actions,  # legged_robot.py:65-67 / lcm_agent.py step()：动作先 clip 到 ±clip_actions
            "hip_action_indices": [0, 3, 6, 9],  # legged_robot.py:920 `actions_scaled[:, [0,3,6,9]] *= hip_scale_reduction`
            "stiffness": stiffness,
            "damping": damping,
            "num_obs": num_obs,
            "num_actions": int(cfg["env"]["num_actions"]),
            "num_obs_history": num_obs * num_hist,
            "num_observation_history": num_hist,
            "gait_frequency_range_hz": [gait_low, gait_high],
            "initial_qpos": initial_qpos,
            "ang_vel_scale": float(scales["ang_vel"]),
            "cmd_scale": commands_scale,
            "dof_pos_scale": float(scales["dof_pos"]),
            "dof_vel_scale": float(scales["dof_vel"]),
        },
        "jointNames": joint_names,
        "modelJointNames": model_joint_names,
        "modelActuatorNames": model_actuator_names,
        "rootBody": "trunk",
        "unit": "rad",
        "controlMode": "position",
        "frequencyHz": 1.0 / (simulation_dt * decimation),
        "observations": {
            "type": "STATE",
            "shape": [num_obs],
            "order": obs_order,
            "quaternion": "xyzw",
            "phasePeriodS": 2.0 / (gait_low + gait_high),
            # 自定义观测契约（只在本 adapter 上生效；缺这些字段时产品走原单帧路径）：
            "frameDimension": num_obs,
            "historyFrames": num_hist,
            "previousActions": 2,
            "clockInputs": 4,
            "commandDimension": num_commands,
            "gaitCommandScale": commands_scale,
            "gait": gait_defaults,
            "inference": "torchscript-adaptation",
            "adaptationWeightsPath": str(root / ADAPTATION),
        },
        "inferenceFormat": "torchscript",
        "adaptationWeightsPath": str(root / ADAPTATION),
        "physicsPreserved": PHYSICS_FIELDS,
        "gravityCompensation": False,
    }))


if __name__ == "__main__":
    main()
