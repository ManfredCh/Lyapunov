---
name: so101-bringup
description: "盘点 SO-101 串口、相机和 LeRobot，按实际设备身份核对标定、电机与停止链，并提供仿真路径。"
---

# SO-101 设备准备

先用 `robotics_lab` 的 `hardware-inventory` 读取主机设备候选。核实 SO‑101 是 follower、端口对应关系、供电、夹具、关节刻度和急停。候选串口和 video 节点属于设备枚举，身份需独立确认。连接调试采用该机型匹配的 LeRobot 版本及上游清单；报告被占用的端口和缺失的标定。

未接真机时用 `robot-provisioning` 打开 SO‑101 MJCF，通过 `robot_describe` 读取关节、夹爪和 TCP。相机与桌面标定见 `so101-calibration`。执行前保存资源版本、标定来源、停止回执预期和记录路径。

[上游参考](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics/skills/so101-bringup)
