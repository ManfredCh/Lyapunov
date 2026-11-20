---
name: mujoco-studio-sidecar
description: "在已有 Viewer、场景树和会话录制中观察 MuJoCo 世界，查询帧身份并对照实时与历史状态。"
---

# 工作台实时仿真与回放

1. `sim_open` 打开当前 Scene。确认当前引擎、worldId、代次与 Scene 版本后在工作台 Viewer 定位选中对象。
2. `robot_state` 与 `sensor_capture` 分别读取当前帧与相机结果。对照 Contact 读数、世界计步、控制和录制。回放以对应历史帧在当前会话原生入口打开。
3. 查看拍摄证据用 `recording_*` 或加载 `mujoco-showcase-shot`。需要检查 XML 独立视图时，可用原版 MuJoCo Studio，工作台状态仍归当前 Sim Provider。

[上游参考](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics/skills/mujoco-studio-sidecar)
