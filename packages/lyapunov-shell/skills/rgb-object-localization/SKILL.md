---
name: rgb-object-localization
description: "从已标定 RGB 相机和人工或模型确认的目标掩膜或匹配点估计三维位置与方向。"
---

# RGB 三维定位

1. 从当前世界用 `sensor_capture` 采集 RGB、内参、外参和原始帧身份。关联多相机时检查同一世界、代次、Scene 版本和物理时刻。来自其他设备的图像需要其对应标定。
2. 将光学相机坐标转成列向量约定，X 向右、Y 向下、Z 向前。将 `worldFromCamera` 明确写成光学相机到世界的 4×4 变换。
3. 调用 `robotics_lab` 的 `rgb-localize`，请求写入工作区 JSON。双视角模式为 `{"mode":"triangulate","views":[{"intrinsics":K1,"worldFromCamera":T1,"pixels":[[u,v]]},{"intrinsics":K2,"worldFromCamera":T2,"pixels":[[u,v]]}]}`，像点必须同序匹配。平面模式 `plane-mask` 提供 `camera:{intrinsics,worldFromCamera}`、`planeZM` 和 `sourcePath` 灰度掩膜。共面标定模式 `homography` 提供 `pixels`、`worldXY`。
4. 从 `job_output` 取到结果，保留原帧和匹配点。多视角注意内点比例、几何基线和目标是否在两图间移动。有效定位需要实际像素测量，结合 `motion-planning` 可直接走 `vision-transfer-plan`。

[上游参考](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics/skills/rgb-object-localization)
