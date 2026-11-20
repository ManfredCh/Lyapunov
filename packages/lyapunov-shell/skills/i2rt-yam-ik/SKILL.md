---
name: i2rt-yam-ik
description: "在显式 YAM MJCF 上调用上游六轴逆运动学，复算 TCP 位置和姿态误差。"
---

# I2RT YAM 正逆运动学

用 `robotics_lab` 的 `yam-ik`。提供 `sourcePath` 为与机型和夹爪一致的 MJCF，`requestPath` 为 `{tcpSite:"grasp_site",start:[q1,q2,q3,q4,q5,q6],target:[[...],[...],[...],[0,0,0,1]]}`。关节为有序弧度，目标为世界到 TCP 的位姿表示（矩阵把 TCP 局部坐标映射到世界）。
`job_output` 返回关节和独立 FK 误差。调用 `motion-planning` 检查带工具和障碍的轨迹，按产品已配置 Provider 的执行回执复验。

[上游参考](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics/skills/i2rt-yam-ik)
