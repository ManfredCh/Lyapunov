---
name: mujoco-python
description: "使用 MjModel、MjData、仿真状态、步进、控制、接触和传感器。"
---

# MuJoCo Python API

管理模型与运行数据的单独生命周期。读取仿真状态前执行 forward 计算派生量，在产品中以 sim_open、robot_state、sim_task_check 的真实帧为证据。排查控制先核对 actuator、ctrlrange、时步和模型单位。

[上游参考](https://github.com/google-deepmind/mujoco/tree/main/doc/skills/mujoco-python)
