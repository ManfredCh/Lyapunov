---
name: sim2real-gauntlet
description: "固定扰动样本，成对比较控制策略，保留原生条件、判定、失败、录制和安全违规。"
---

# Gauntlet 配对和安全评测

1. 用 `robotics_lab` 的 `gauntlet-schedule` 生成 T0–T4 样本，请求为 `{"taskId":"sort","seed":42,"casesPerTier":4}`。开发装配通过 `LYAPUNOV_SIM_LAB_FAULTS=1` 显式启用，`sim_evaluation` 的 `gauntlet-configure` 只在指定 MuJoCo 世界第 0 步暂停状态接受。工作区的批次驱动负责构造相同静态场景，物理 worker 负责每步外力、驱动变化、传感器样本和触发记录。
2. 用 `campaign_init` 创建同种子、同场景摘要、同终态谓词的 baseline/candidate 任务。对采用真实 MuJoCo 的比较打开 `requirePreflight`，要求安全判分时再打开 `requireSafety`。通过原生工具逐步执行，保存 `sim_task_check` 的实际结果和录制。
3. 用 `campaign_status` 检查有效配对、组间分歧、逐档统计及安全违规。开始一致性、逐步安全和最终任务按各自证据判定。
4. 输入经授权导出的 `calls.jsonl` 供 `robotics_lab` 的 `mcap-export` 转为可交换的调用记录。原始录像和相机采集沿用 `recording_export`。
5. `gauntlet-status` 回收计划与实际触发。帧延迟／冻结用实验相机先采一次真实数据，旧帧仍携带其采集步。只在算法入口设置 `gauntletProprio`，真值判定继续读取权威物理状态。

[上游参考](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics/skills/sim2real-gauntlet)
