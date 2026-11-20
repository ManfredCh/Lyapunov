---
name: sim2real-iteration
description: "结合原生快照分叉、配对评测和独立 Verifier，重查失败假设与技能准入条件。"
---

# 仿真到真机的独立复核

1. 加载 `skill-campaign` 建立 dev／heldout 任务。冻结机器人、资产版本、输入源、条件和预算。
2. 在已启用原生评估的 MuJoCo 世界用 `sim_evaluation` 采集关键动作前快照；按工具实际支持的快照与恢复操作原地分叉，记录状态指纹、动作步数和终态。需要真机时加载对应机型 bringup 技能并单独保存设备边界和采集。
3. 复核方只收到提案、任务目标和准入技能。按 `skill-verify` 独立执行，保留碰撞、稳定放置、故障停止和录制数据。安全准入按 `requireSafetyEvaluation` 合同回收。

[上游参考](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics/skills/sim2real-iteration)
