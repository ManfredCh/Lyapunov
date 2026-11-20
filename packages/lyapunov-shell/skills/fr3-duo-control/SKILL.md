---
name: fr3-duo-control
description: "对照 FR3 双臂、Robotiq 和相机站位进行发现、单臂验证与联合避障。"
---

# Franka FR3 双臂联调

用 `robotics_lab` 的 `hardware-inventory` 检查本机 SDK 和相机候选。按上游固定版本的站位图和安全清单确认两臂 IP、臂编号、Robotiq、相机、工具外参和急停。真实地址从操作者提供的站位配置获取。

先在双臂 MJCF 中校验两侧 TCP 和碰撞坐标，再分别调用 `motion-planning` 的 `arm-plan`。用 `robotics_lab` 的 `fr3-duo-check` 对齐两臂采样时刻，输入 `{left:{rootBody,jointNames,positions},right:{rootBody,jointNames,positions}}`。各臂给七轴弧度、相同点数。核对最小实测样本距离及碰撞体，再按工位要求检查夹具、工具和障碍。用原生 recording 留下逐次执行证据。

[上游参考](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics/skills/fr3-duo-control)
