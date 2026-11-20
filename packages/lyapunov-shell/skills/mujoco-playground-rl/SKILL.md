---
name: mujoco-playground-rl
description: "静态审计 RL 热路径，再根据实际 Torch、环境和加速后端验证批量训练与回放。"
---

# MuJoCo Playground 强化学习检查

用 `robotics_lab` 的 `rl-audit` 传工作区中的任务 Python 源码，查看 `findings.json` 的批维、热路径 host/device 同步和不合适的 API 用法。该步骤按语法树分析源码。独立训练解释器的配置状态从 `scene_workflow_capabilities` 中的 `playground_train_so101` 读取。

训练前检查独立 Playground 解释器 `LYAPUNOV_PLAYGROUND_PYTHON`。可调用 `playground_train_so101`，参数为 `{sourcePath,iterations,worlds?,steps?,seed?}`。使用工作区内的 SO-101 MJCF 与网格，环境固定为 `SO101PickCube`。先用 2 个并行环境和 1 次 PPO 更新验证入口，再按任务预算扩大运行。

从 `job_output` 读取训练日志和 checkpoint。用 `playground_eval_so101` 传 `sourcePath`、`checkpointPath`、`trainingReceiptPath`、`episodes`、`steps` 和首个独立 `seed`。它核对源 MJCF 与权重哈希，在新 CPU MuJoCo 中成对比较零动作和权重推理，保留每次判定、结束原因和回放。上游成功谓词是方块抬起并接近指定目标，入盒或真机迁移按各自任务验收。

[上游参考](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics/skills/mujoco-playground-rl)
