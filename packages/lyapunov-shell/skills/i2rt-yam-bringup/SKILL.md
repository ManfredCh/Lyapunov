---
name: i2rt-yam-bringup
description: "检查 YAM 或 YAM Pro 的 CAN、相机、夹爪型号、SDK 和急停准备情况。"
---

# I2RT YAM 设备准备

先用 `robotics_lab` 的 `hardware-inventory` 拿到本机 CAN、USB 相机和 SDK 候选。根据实际设备区分 YAM／YAM Pro、夹爪和 CAN 接口。按厂商与上游已固定的机型步骤核对 CAN 参数、急停、关节边界和低速单动作；保存真实状态与命令回执。

仿真先导入同型号 MJCF，通过 `i2rt-yam-ik` 检查关节顺序及 TCP；组合控制再加载 `motion-planning` 和 `sim2real-gauntlet`。

[上游参考](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics/skills/i2rt-yam-bringup)
