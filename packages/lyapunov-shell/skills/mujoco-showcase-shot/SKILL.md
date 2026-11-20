---
name: mujoco-showcase-shot
description: "对 MJCF 输出视觉、黏土、碰撞覆盖与碰撞体的同机位多视角图，或者使用原生 Viewer 导出过程媒体。"
---

# MuJoCo 多视角检查图

- 用 `robotics_lab` 的 `showcase` 提供本地 MJCF，`requestPath` 可通过 `{"panelSize":256}` 设置单格边长，范围 120–420 像素。读取 `job_output` 取同一次 Job 的 `showcase.png`。
- 检查正面、背面、左右、顶部、底部、轴测视角的 visual、clay、overlay、hull 四行。检查碰撞对齐、接触面、朝向和裁切。
- 已加载世界的实际运动使用 `recording_*` 与工作台回放。检查图和仿真录像分别保留来源。

[上游参考](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics/skills/mujoco-showcase-shot)
