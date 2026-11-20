---
name: visual-servoing
description: "使用同帧图像特征、深度和手眼外参计算有界的视觉伺服修正，并检查失帧、饱和和收敛。"
---

# 腕相机视觉伺服

1. 记录腕相机的实测内参和 `eeFromCamera` 光学外参。选择稳定且同序的多个特征，保留帧号和每个特征的正深度。
2. 用 `robotics_lab` 的 `ibvs-step` 计算一步。请求字段为 `pixels`、`goalPixels`、`depthM`、`intrinsics`（3×3）和 `eeFromCamera`（4×4）。结果含相机与末端体坐标 twist，前三项 m/s，后三项 rad/s，也返回像素误差和收敛读数。
3. SO-101 使用 `robot_pick.wristRefinement` 做 RGB-D 平面定位。可显式设置 `feedbackPasses`（2–6）和 `feedbackToleranceM`，从实际腕相机反复读帧并执行纠偏；失帧、不可达和未收敛均在下降或夹紧之前止损。
4. 在开发仿真可用 `robotics_lab` 的 `yam-ibvs` 传本地 Menagerie YAM Linear 4310 MJCF，运行六轴标记对位、静止参考与陈旧帧反例。从 `job_output` 回收每步像素误差、六维交互矩阵秩、实际关节命令、接触峰值和回放。该夹具启用等条件模型重力补偿。

[上游参考](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics/skills/visual-servoing)
