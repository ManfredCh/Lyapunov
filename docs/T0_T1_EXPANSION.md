# T0+T1 扩面清单（资产 / policy / 特攻）

依据：最早机型清单的 T0+T1 档；资产源以 mujoco_menagerie@HEAD 目录实查（2026-09-23）+ openpi 官方桶 + HF 仓实查为准。状态词沿回执口径。**无公开资产/无 policy 的型号如实标注，不造假包。**

## 1. 逐形态扩面表

| 形态 | 型号 | 档位 | 资产源（实查） | policy 源 | 特攻要点 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 机械臂 | ur5e | T1 | menagerie `universal_robots_ur5e` | π0.5（openpi `ur5e` norm_stats）+ 直控 | 6DoF 裸臂 | 待建包 |
| 机械臂 | ufactory_xarm7 | T1（xArm 族） | menagerie `ufactory_xarm7` | 直控（+VLA 微调面） | 7DoF；另有 lite6 同源 | 待建包 |
| 机械臂 | ufactory_lite6 | T1+ | menagerie `ufactory_lite6` | 直控 | 6DoF 紧凑臂 | 待建包 |
| 机械臂 | robotstudio_so101 | T1 | menagerie `robotstudio_so101` | **G05 `g05-so101` 变体**（gated 待批）+ LeRobot 生态 | LeRobot 生态主力 | 待建包 |
| 机械臂 | trossen_vx300s | T1（ALOHA） | menagerie `trossen_vx300s` | π0.5（`trossen` norm_stats）+ ALOHA 系 | 双臂遥操作主力 | 待建包 |
| 机械臂 | trossen_wx250s | T1（DROID） | menagerie `trossen_wx250s` | **π0.5-DROID** + `droid` norm_stats（DROID 原生本体是 Franka Panda 7DoF；Wx250s 需 7↔8 维映射） | DROID 生态一种 embodiment | 待建包 |
| 机械臂 | trossen_wxai | T1+ | menagerie `trossen_wxai` | 同上族 | ALOHA 族新臂 | 待建包 |
| 机械臂 | aloha（双臂场景） | T1+ | menagerie `aloha` | π0.5-ALOHA 系 | 双臂组合场景包 | 待建包 |
| 机器狗 | unitree_a1 | T0（前代） | menagerie `unitree_a1` | WTW（walk-these-ways 支持 a1 族） | 与 Go1 同适配链 | 待建包 |
| 机器狗 | （Mini Cheetah） | T1 | **无公开 MJCF 主流仓**（MIT Cheetah-Software 代码为主） | 无公开部署级 policy | 如实标 UNVERIFIED，接口复刻位 | 不建假包 |
| 无人机 | generic_quadrotor（PX4） | T0 | **已定源**：gym-pybullet-drones `cf2x.urdf`（GitHub utiasDSL 原仓 / HF `bensprenger/gym_pybullet_drones` 镜像，2026-09-23 实查；MuJoCo 可直接载 URDF） | PX4/ArduPilot SITL 外接 | thrust 通道 + 外部飞控 | 待建包（第二批） |
| 无人机 | （DJI Tello） | T1 | **无官方 sim 模型** | 无 | 仅接口复刻位 | 不建假包 |
| 灵巧手 | shadow_dexee | T1+ | menagerie `shadow_dexee` | 直控（tendon 族） | Shadow 族第四包 | 待建包 |
| 灵巧手 | xhand_right | T1 | **已定源**：HF `RoboVerseOrg/roboverse_data` → `robots/xhand_right/urdf/xhand_right.urdf`（2026-09-23 实查） | HF 社区微调痕迹（GSHand xarm7_xhand、pi05-xhand）+ 直控 | XHand 族右手 | 待建包（第二批） |
| 灵巧手 | franka_shadow_hand / iiwa_allegro（组合件） | T1+ | RoboVerse `robots/franka_shadow_hand/mjcf/`、`robots/franka_allegro_hand/`、`KUKA_LBR_IIWA14/iiwa_allegro.urdf` | π0.5（franka stats）+ 直控 | 臂手组合包（补充现有单手包） | 待建包（第二批） |
| 灵巧手 | （Inspire RH56DFX / OHand ROHand Gen2 / Faive / Dex3） | T1 | **无公开模型仓**（查证结论：RH56=因时 Inspire，仅论文页/固件仓 oymotion/roh_gen2_firmware；OHand=ROHand Gen2 同上；Faive/Dex3 无） | RH56 有 HF 社区微调痕迹（rh56f1 π0.5 系） | 如实标 UNVERIFIED，接口复刻位 | 不建假包 |
| 人形 | unitree_h1 | T1 | menagerie `unitree_h1` | unitree_rl_gym TorchScript（G1 同链） | 行走 | 待建包 |
| 人形 | agility_cassie | T1 | menagerie `agility_cassie` | 无公开部署级 policy（Cassie RL 论文代码为主） | 腿式动力学标杆 | 待建包（policy 如实标） |
| 人形 | （Unitree R1/Booster/Digit） | T1 | R1 待查 unitree_rl_gym；Digit 无主流公开 | 待查/无 | 逐个查证 | 查证中 |

## 2. π0.5 / G0.5 适配面（"不同种类"）

| 策略 | 种类 | 权重源 | 覆盖机型（其 norm_stats/变体实证） | 状态 |
| --- | --- | --- | --- | --- |
| π0.5 base | flow-matching 双系统 | `gs://openpi-assets/checkpoints/pi05_base`（官方） | **arx / arx_mobile / droid(Wx250s) / fibocom_mobile / franka / trossen(Vx300s) / trossen_mobile / ur5e / ur5e_dual** | 下载中（job bash-1709） |
| π0.5-LIBERO | 同上（微调） | `pi05_libero` | LIBERO（SOTA 位，正对我们测试集） | 下载中 |
| π0.5-DROID | 同上（微调） | `pi05_droid` | DROID 生态泛化（原生本体 Franka Panda 7DoF） | 下载中 |
| **G0.5（Galaxea G05）** | **自回归单流** | HF `OpenGalaxea/G05`（**gated，等用户批准**） | 变体：g05-base / g05-droid / **g05-libero** / g05-robotwin20 / **g05-so101** | 待批准后拉取 |

## 3. 与既有 15 包的 policy 映射（"policy 要适应每一个机器人"）

- 原生 RL/控制器类：Go1/A1=WTW、Go2=INRIA ONNX、G1/H1=unitree_rl_gym、腿式 gait 通道、无人机=外部飞控、灵巧手=直控（tendon/gripper）。
- VLA 类：机械臂全系按 π0.5 的 per-embodiment norm_stats 对接（arx/ur5e/trossen/franka 有实证 stats）；SO-101/Wx250s 另有 G05 变体（g05-so101/g05-droid）。
- 直控类（mimo/GPT6 + JEV 门）：所有臂/手的兜底层，vla/ 面已就绪。

## 4. 批三候选（RoboVerse `robots/` 实查发现，超出 T0+T1 范围备选）

2026-09-23 实查 `RoboVerseOrg/roboverse_data` 的 robots/ 根另含：Kinova_Gen3、Rethink_Robotics_Sawyer、Siasun_SO-ARM100、Koch_v1.1、Unitree_Z1、UFactory_Lite6、YAM、fetch、google_robot(+description)、g1、h1、h1_2_without_hand、**h1_hand**、Interbotix_WidowX_250、UR5e/UR10e、ARX_L5、franka 系列变体（calvin/rlafford/gripper_extension）。**h1_hand 核验结论（2026-09-23 二次实查）：它是 H1+Shadow Hand 组合件（mjcf/shadow_hand_menagerie/ 含 left/right_hand.xml + LICENSE），不是 Inspire RH56 ⇒ RH56"无公开模型仓"结论维持**；h1_hand 作为组合件候选（类 franka_shadow_hand）。其余多为 T2/重复形态，按需求追加。无人机模型该仓没有（实查 0 命中）。
