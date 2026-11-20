---
name: iteration
description: "在开发任务上根据明确失败阶段修复程序，保留成功、失败和更正的证据。"
---

# 依据观测迭代机器人任务

加载 `skill-debug`，先固定任务目标、预算与版本，按实际失败阶段拆解。用相机和实体读数审查失败前后的帧，写清观察和假设。控制变量时优先使用 `sim2real-iteration` 的原生快照与分叉。保留最小改动、逐步判定与录制；在新场景复查。需要晋升时切到 `skill-verify` 走独立会话与工具证据。

[上游参考](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics/skills/iteration)
