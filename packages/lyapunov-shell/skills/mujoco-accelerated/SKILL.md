---
name: mujoco-accelerated
description: "区分 CPU MuJoCo、MJX 和 Warp 的设备、批处理及可用特性。"
---

# MuJoCo 加速后端

固定模型和步数比较 CPU 与 GPU，核对碰撞对、批大小、dtype 及数值容差。记录实际设备、首轮编译和稳态吞吐。通过工作台明确选择 Provider，并在不可用时报告缺少模块或设备。

[上游参考](https://github.com/google-deepmind/mujoco/tree/main/doc/skills/mujoco-accelerated)
