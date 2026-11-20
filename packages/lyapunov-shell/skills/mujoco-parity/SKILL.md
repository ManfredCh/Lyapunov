---
name: mujoco-parity
description: "对不同 MuJoCo 后端的相同模型和输入做成对实测，比较状态、动作、触碰和判定。"
---

# MuJoCo 后端一致性

冻结资产 SHA、随机种子、仿真步长、控制向量与初态。使用 sim2real-gauntlet 建立配对，比较观测误差、安全峰值和稳定完成；存下第一处偏离与同帧读数。

[上游参考](https://github.com/google-deepmind/mujoco/tree/main/doc/skills/mujoco-parity)
