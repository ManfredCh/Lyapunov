---
name: motion-planning
description: "计算自由物体或带载荷机械臂的避障路径，对照直线路径与搜索候选，并回收可复核采样结果。"
---

# 避障和携物规划

- 当前世界先用 `robot_describe` 和 `robot_state` 获取命名关节、实际姿态和 TCP 来源。用 `motion_plan` 做原生 IK、`robot_pick` 和 `robot_place` 实际执行，保留 worldId 和代次。
- `robotics_lab` 的 `object-plan` 输入 JSON 含 `start` 和 `goal`，每组为 [x,y,z,yaw,pitch,roll]，单位米、弧度，另给 `spheres:[{center:[x,y,z],radius}]` 和 `obstacles:[{name,center,halfExtents}]`，几何均使用米。可选 `seed`。以 `sampledPathValid` 核对采样后的路径，读取 `trajectory.json` 对比直线。
- `arm-plan` 使用工作区 MJCF 作 `sourcePath`，请求含 `jointNames`、`tcpSite`、起止关节向量 `start`、`goal`。载荷用 `payload:{spheres,eeFromObject}`，`eeFromObject` 为局部 4×4 刚体变换。避障几何来自显式输入，实际现场执行前用独立的原生净空检查复核。
- 从 RGB 定位开始的转运可以直接用 `vision-transfer-plan`，JSON 为 `{localization,transfer}`。前者沿用定位合同，后者沿用物体路径合同且由定位填入起点。姿态先验可通过 `transfer.startAngles` 声明。

[上游参考](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics/skills/motion-planning)
