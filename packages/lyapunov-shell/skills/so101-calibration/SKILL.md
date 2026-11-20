---
name: so101-calibration
description: "对独立采集的 SO-101 三维末端点和相机标记像素拟合投影矩阵并检查误差。"
---

# SO-101 相机及桌面标定

1. 从实际驱动和同步相机采集端效器三维位置、像素与帧号，覆盖工作区域及不同高度。保存至少 8 组有效的非共面观测。
2. 调用 `robotics_lab` 的 `handeye-fit`，请求为 `{worldPoints:[[x,y,z],...],pixels:[[u,v],...],regularization:500}`。坐标使用米和像素，拟合结果返回 3×4 投影矩阵、逐点重投影误差和桌面 XY 误差。
3. 从 `calibration.json` 读取逐点误差，用独立采集的点复核。对应镜头参数或安装位置变化时重新标定。腕部刚体外参还需对应眼在手的采集和解算，消费方式见 `visual-servoing`。

[上游参考](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics/skills/so101-calibration)
