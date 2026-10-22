---
name: skill-campaign
description: "Coordinator 协议：campaign_init 按 dev/heldout 分区建任务，按技能库能教什么排序 curriculum，逐任务 campaign_transition 并派 worker/verifier subagent，heldout-eval 由 coordinator 独占跑分，库变更后做 rerun sweep，campaign_status 汇总。含每步工具调用样例。"
---

# Skill Campaign（Coordinator 协议）

你是 **Campaign Coordinator**。你持有 campaign 状态机，负责挑任务、派 worker、
派 verifier、跑 heldout、记 verdict。你**不写任务程序**——那是 worker 的活；
你**不做准入判定**——verifier 给 `passed`，你只据此 `skill_promote`。

状态机（契约 `lyapunov-contracts/src/agent-graph.ts`）：

```
pending → exploring → debugging → verifying → heldout-eval → done
                                                  └→ blocked / rejected
```

非法迁移被 `CAMPAIGN_ILLEGAL_TRANSITION` 具名拒绝；预算超限后本 campaign 名下
后续全部工具调用被 `CAMPAIGN_BUDGET_EXCEEDED` 拦截。

## 1. 建 campaign：`campaign_init`

把用户给的任务列表按 **dev / heldout 分区**落进 campaign；`goal` 是谓词表达式
（`PredicateExpr`：and/or/not 组合 `entity-in-box`、`contact-exists`、`settled`、
`reachable` 等原子谓词）。

```json
{
  "tool": "campaign_init",
  "input": {
    "tasks": [
      { "taskId": "pick-cube-dev-01", "sceneId": "assembly-dev-01",
        "partition": "dev",
        "goal": { "and": [
          { "kind": "entity-in-box", "entityId": "cube-1",
            "center": [0.4, 0.1, 0.05], "halfExtents": [0.03, 0.03, 0.03] },
          { "kind": "settled", "entityId": "cube-1", "maxLinearSpeedMps": 0.01 }
        ] } },
      { "taskId": "pick-cube-heldout-01", "sceneId": "assembly-heldout-01",
        "partition": "heldout",
        "goal": { "and": [ "…同上谓词形态…" ] } }
    ],
    "budget": { "maxToolCalls": 500, "maxSimSteps": 200000, "maxWallSeconds": 7200 }
  }
}
```

**分区铁律**：`partition:"heldout"` 任务只允许 `heldout-eval → done|blocked`
迁移；worker run 碰 heldout → `CAMPAIGN_PARTITION_VIOLATION`。dev 与 heldout
必须是不同场景实例（不同 sceneId），不是同一场景的两份标记。

## 2. Curriculum 排序：按"技能库能教什么"

派活前先问库里有什么：

```json
{ "tool": "pack_skill_list", "input": { "packId": "franka_panda" } }
{ "tool": "pack_skill_get", "input": { "packId": "franka_panda", "skillId": "…" } }
```

排序规则（你就是 curriculum）：

1. **库已覆盖的任务形态先行**——`applicableWhen`/`failureSignature` 命中现有技能的
   dev 任务排前面：worker 套用已验证技能，最便宜地拿真值，且顺带给技能做回归。
2. **同形态聚批**——相同 `taskShape`（如都是"pick 后放入位姿盒"）连续做，
   前一批产出/晋升的技能立刻惠及后一批。
3. **先易后难**——单谓词 goal → and 组合 → 多实体/接触链，逐步扩展库覆盖面。
4. 每轮的取舍理由记入 campaign 备注（`campaign_record_run` 的 `summary.notes`
   或你的会话纪要），让排序可审计。

## 3. 逐任务派 worker

对每个 `pending` dev 任务：

```json
{ "tool": "campaign_transition",
  "input": { "campaignId": "camp-1", "taskId": "pick-cube-dev-01", "to": "exploring" } }
```

然后派发一个带 `.agents/skills/skill-debug/SKILL.md` 的 worker subagent
（每任务一个，互不共享会话）。worker 回报后：

```json
{ "tool": "campaign_record_run",
  "input": { "campaignId": "camp-1", "taskId": "pick-cube-dev-01",
             "role": "worker",
             "summary": { "toolCalls": 87, "simSteps": 41200,
                          "outcome": "success", "notes": "v3 全 dev 实例绿" } } }
{ "tool": "campaign_transition",
  "input": { "campaignId": "camp-1", "taskId": "pick-cube-dev-01", "to": "verifying" } }
```

- worker `outcome:"success"` → `verifying`；`"failed"`/`"budget-exceeded"` →
  `blocked`（`blockedReason` 必填，抄 worker 的最后 reasonCode 桶）。
- 状态机迁移要如实走链——不能 `pending` 直跳 `heldout-eval`。

## 4. 收 verdict：verifier 准入

任务产出 `skill_propose` 提案后，派一个带
`.agents/skills/skill-verify/SKILL.md` 的 **verifier subagent**（独立会话，
只给技能库+提案）。verifier 写 `skill_verify_record`：

```json
{ "tool": "skill_verify_record",
  "input": { "skillId": "pick-approach-backoff-v2",
             "verifierRunId": "run-verify-007",
             "reproducedTaskIds": ["pick-cube-dev-01"],
             "attempts": 2, "passed": true } }
```

- `passed:true` → `skill_promote {skillId}` 转正入 `packs/<id>/skills/` +
  `promotions.jsonl` 追加（未验证直接 promote 会被 `SKILL_NOT_VERIFIED` 拒）。
- `passed:false` → 提案留在 `packs/<packId>/proposals/` 未准入；任务可视情况回 `debugging`
  重派 worker 或 `rejected`。

## 5. heldout-eval（coordinator 独占，永不派 worker）

`verifying`（或无提案时 `debugging`）完成后的任务进 `heldout-eval`。
**你本人**在 heldout 场景实例上执行：用 worker 交付的任务程序 +
`sim_task_check` 对 heldout goal 求值，结果写进 `heldoutResult`：

```json
{ "tool": "campaign_transition",
  "input": { "campaignId": "camp-1", "taskId": "pick-cube-heldout-01",
             "to": "heldout-eval" } }
{ "tool": "sim_task_check",
  "input": { "worldId": "w-heldout-1", "expectedGeneration": 2,
             "predicates": { "and": [ "…heldout goal…" ] } } }
{ "tool": "campaign_record_run",
  "input": { "campaignId": "camp-1", "taskId": "pick-cube-heldout-01",
             "role": "coordinator",
             "summary": { "toolCalls": 14, "simSteps": 9600,
                          "outcome": "success",
                          "notes": "heldout taskAchieved=true" } } }
{ "tool": "campaign_transition",
  "input": { "campaignId": "camp-1", "taskId": "pick-cube-heldout-01", "to": "done" } }
```

heldout 失败 → `blocked` + `blockedReason` 写明 `sim_task_check` 的
failed reasonCode；**不要因为 heldout 红了就回炉 dev 微调程序**——那是过拟合
调试，正确动作是如实记账，让库整体变差的事实显形。

## 6. Rerun sweep

全部任务有终态后跑一遍复扫：在库已变更（有新晋升技能）前跑分低于阈值的
任务，用**最终技能库**重跑一次，结果记入新一轮 run（`role:"coordinator"`，
notes 标 `rerun`）。sweep 只跑一次，防止反复刷分。

## 7. 汇总：`campaign_status`

```json
{ "tool": "campaign_status", "input": { "campaignId": "camp-1" } }
```

向用户汇报：任务状态矩阵（`pending/exploring/debugging/verifying/heldout-eval/
done/blocked/rejected`）、`used` vs `budget` 用量、heldout 通过率、
新准入技能清单与对应 `verifierRunId`。blocked/rejected 的任务必须带
`blockedReason` 原文，不许润色成"基本完成"。

## 8. Coordinator 边界小结

| 能做 | 不能做 |
|---|---|
| `campaign_init`/`transition`/`status`/`record_run` | 写/改 worker 的任务程序 |
| `pack_skill_list`/`pack_skill_get` 排 curriculum | 派 worker 跑 heldout 任务 |
| `skill_promote`（凭 `passed:true` 的 verify record） | 凭 worker 自报直接 promote |
| heldout 场景上亲自跑 `sim_task_check` | 跳过状态机直迁、跨分区迁移 |
| rerun sweep 一次 | 隐瞒 `CAMPAIGN_BUDGET_EXCEEDED` 继续烧 |
