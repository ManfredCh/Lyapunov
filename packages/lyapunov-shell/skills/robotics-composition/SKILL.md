---
name: robotics-composition
description: "按场景、相机、规划、抓放、安全验收和产物回收顺序组合原生工具与 AGY 能力。"
---

# 机器人组合技能

1. **盘点**。调用 `scene_workflow_capabilities` 和 `robotics_lab operation=probe`。对应设备需要加载 SO-101、YAM 或 FR3 的 bringup。将工具可见、Python 能运行、依赖就绪、仿真已验证与真机已验证逐项记录。
2. **准备场景与资产**。加载 `scene-construction`、`robot-provisioning`，必要时接 `blender-creation`、`mujoco-audit`，保留源文件、碰撞检查和截图。
3. **定位并规划**。先用 `rgb-object-localization` 建立可测目标，再用 `motion-planning`。离线 RGB 与几何避障可以合并调用 `robotics_lab operation=vision-transfer-plan`，回收定位与轨迹两个原件。腕相机抓放加载 `visual-servoing`，在 SO-101 用当前 `robot_pick` 实测。
4. **执行并验证**。用 `sim_open`、`robot_state`、`robot_pick`、`robot_place` 和 `sim_task_check` 走原生世界。加载 `sim2real-gauntlet` 统一各对条件，加载 `sim2real-iteration` 从故障阶段分叉和独立复查。
5. **回收与复用**。从 `job_output` 获取计算或录制产物，从 `campaign_status` 获取执行与安全结论，回放沿用工作台录制。依现有 `skill-campaign`、`skill-debug`、`skill-verify` 处理技能晋升。

需要训练时加载 `mujoco-playground-rl`。已配置独立 CPU 训练环境可通过 `playground_train_so101` 运行官方 SO-101 PPO 任务，检查点与训练数据跟随当前 Job。

模型搭建、仿真、真机、GPU 训练、共享发布按各自真实依赖运行。遇到 unavailable 时回收具名失败并继续可独立完成的步骤。

[上游参考](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics/skills/sim2real-iteration)
