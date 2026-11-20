---
name: mujoco-playground
description: "检查 Playground 和 REAF 依赖，组合示范、原生数据集与仿真到真机评测。"
---

# MuJoCo Playground 示范与迁移

使用外部示范前，检查其独立解释器中的 `mujoco_playground`、`reaf` 与 Torch。确认 Playground 工作树、机器人资产、设备配置、控制频率和观察空间，再按上游同版本的机器人示范执行。SO-101 CPU 训练的配置通过 `scene_workflow_capabilities` 查询。

纯 Lyapunov 路径用 `robot_pick`／`robot_place` 执行，`recording_export` 导出原生演示。按后端要求校验动作、时钟、采样率和关节顺序，转换后以实测录制复跑。配对比较加载 `sim2real-gauntlet`，训练加载 `mujoco-playground-rl`。

使用同一组光学坐标时，`robotics_lab` 的 `playground-camera` 从工作区 MJCF 读取针孔相机。请求为 `{camera,width,height,qpos?}`，结果含内参和光学相机到世界的外参，可作为 `rgb-object-localization` 的输入。该读数来自离线 MJCF 状态。

[上游参考](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics/skills/mujoco-playground)
