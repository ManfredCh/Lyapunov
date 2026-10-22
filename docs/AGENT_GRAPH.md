# Agent Graph 用户文档（0.2.0α1）

Agent Graph 是 Lyapunov 的"回路之上的回路"：在既有 agent-loop 不动的前提下，
用三个角色（Coordinator / Worker / Verifier）跑"生成 → 调试 → 验证 → 入库"的
技能准入流水线。协议参照 NVIDIA ASPIRE（iterative debugging + verifier 准入），
全部落到本产品的 typed 工具、`ActionReceipt` 回执和 packs 技能载体上。

接口契约见 `docs/AGENT_GRAPH_CONTRACT.md`；类型唯一来源
`packages/lyapunov-contracts/src/agent-graph.ts`；三个角色的操作协议见
`.agents/skills/skill-debug/`、`skill-campaign/`、`skill-verify/`。

## 1. 全景图

```
用户任务 ──► Campaign Coordinator（skill-campaign）
              │  campaign_init 分区建任务 / curriculum 排序 / 派活 / 收 verdict
              ├──► Worker subagent（skill-debug）── dev 实例上探索+写程序+调试
              │        │ typed 工具调用 → ActionReceipt → sim_task_check 求谓词真值
              │        └──► skill_propose 提案（未准入）
              ├──► Verifier subagent（skill-verify）── 只凭技能库+提案复现（≤2 attempts）
              │        └──► skill_verify_record（passed:true/false）
              └──► heldout-eval（coordinator 独占）→ done / blocked

工具调用 ──► Run Artifacts（.lyapunov/campaigns/<campaignId>/runs/<runId>/）
验证通过的提案 ──► Skill Library（packs/<id>/skills/ + promotions.jsonl）
```

**节点**：Coordinator、Worker、Verifier 三类 agent（独立会话/subagent），
加上平台侧的确定性求值器 `sim_task_check` 和持久化层（run artifacts、技能库）。

**边**：`campaign_init/transition/record_run/status` 构成状态机边；
worker→verifier 只传**提案 JSON**（信息隔离边）；任何 agent→`heldout` 分区
之间只有 coordinator 一条边。

## 2. 任务与分区

Campaign 里的每个任务：`{taskId, sceneId, partition, goal}`。
`goal` 是 `PredicateExpr` 谓词树（`entity-in-box`、`contact-exists`、`distance-below`、
`joint-in-range`、`settled`、`reachable`、`no-penetration`，可 and/or/not 组合），
由平台确定性求值——**成败真值不经过模型自报**。

| 分区 | 谁能跑 | 用途 |
|---|---|---|
| `dev` | worker（迭代调试）、verifier（复现）、coordinator | 开发调试与准入验证 |
| `heldout` | **仅 coordinator**（`heldout-eval`） | 防过拟合的最终跑分 |

worker/verifier 碰 heldout 任务会被 `CAMPAIGN_PARTITION_VIOLATION` 拒绝；
heldout 回执对 worker 不可见——修不好就修不好，不许对着 heldout 调参。

## 3. 状态机与预算

任务状态：`pending → exploring → debugging → verifying → heldout-eval →
done | blocked | rejected`，由 `campaign_transition` 驱动，非法迁移具名拒绝
`CAMPAIGN_ILLEGAL_TRANSITION`。heldout 任务只允许 `heldout-eval → done|blocked`。

`campaign_init` 时设 `budget: {maxToolCalls, maxSimSteps, maxWallSeconds}`；
`tools/execute` waterfall 按 run 记账（toolCalls 计数 + receipt.stepIndex 增量），
超限后该 campaign 名下后续调用被 `CAMPAIGN_BUDGET_EXCEEDED` 拦截
（当前调用允许跑完，避免半写状态）。`campaign_status` 随时可读 `used vs budget`。

## 4. 三个角色的职责边界

| | Coordinator（skill-campaign） | Worker（skill-debug） | Verifier（skill-verify） |
|---|---|---|---|
| 输入 | 用户任务列表 + 技能库 | 一个 dev 任务 + 技能库 | 技能库 + 单个提案 |
| 主循环 | 建任务→排序→派活→heldout→汇总 | 探索→写程序→dev 调试→提案 | 重解→sim_task_check→记录 |
| 写 | campaign 状态机、`skill_promote` | 任务程序、`skill_propose` | `skill_verify_record` |
| 禁 | 写任务程序、替 worker 调参 | 碰 heldout、看 verifier 判定 | 看 proposer 会话/artifacts、promote |

三份 SKILL.md 是操作协议（frontmatter `name`/`description` + Markdown 正文，
按 DSH/Claude skills 加载格式），agent 领到角色后照文执行。

## 5. 技能准入流水线

1. worker 在 dev 实例上把任务做到 `taskAchieved=true`，把修复模式写成
   `SkillProposal`（`failureSignature`/`applicableWhen`/`fixStrategy`/`program`/
   `devEvidence`）调 `skill_propose` —— 提案落 `packs/<packId>/proposals/<skillId>.json`，
   **未准入**。
2. verifier 独立会话复现：≤2 attempts 内在 dev 头几个实例上跑出
   `taskAchieved=true` → `skill_verify_record {passed:true}`。
3. coordinator 凭 `passed:true` 调 `skill_promote` —— 提案转正入
   `packs/<id>/skills/<skillId>.json` + `promotions.jsonl` 追加晋升账本
   （verifierRunId、复现实例、attempts——即 completion certificate）。
   未验证强推会被 `SKILL_NOT_VERIFIED` 拒。
4. `pack_skill_list` 只列已准入技能（有 promotion 才列）；worker 开跑前必读，
   coordinator 也按"库能教什么"排 curriculum。

## 6. 与既有 packs / receipts 的关系

- **packs**：`packs/<id>/` 原有 `asset/context/policy/vla` 等目录不动；
  新增 `skills/` 子目录是"验证过的修复模式"载体，schema `lyapunov-pack-skill/1`，
  与既有 pack 内容正交。
- **receipts**：动作执行仍走既有 `ActionReceipt` 通道
  （`worldGeneration`/`appliedSceneRevision`/`stepIndex`/实测 Frame），
  agent-graph 不加新回执类型——只是在 `tools/execute` waterfall 里把每次调用的
  `argsDigest` + receipt 字段转录成 `RunCallArtifact`，落
  `.lyapunov/campaigns/<campaignId>/runs/<runId>/calls.jsonl` + `run.json` 汇总。
  `sim_task_check` 是 `taskAchieved` 在 benchmark worker 之外的第一条真值通道。
- **持久化**：campaign 工件落 session 工作目录 `.lyapunov/campaigns/`，
  不污染场景文档；全部 JSON 可重建。

## 7. 快速上手

装好 0.2.0α1 后，给 agent 一句话即可跑 campaign，例如：

> "对 `franka_panda` pack 跑一个 pick-and-place campaign：用 `assembly-dev-01..05`
> 五个 dev 场景做调试、`assembly-heldout-01..03` 做 heldout，目标是 cube-1 进入
> 目标位姿盒且静止，预算 500 次工具调用 / 20 万 sim 步 / 2 小时，跑完汇报
> heldout 通过率和新准入的技能。"

agent（以 coordinator 身份）会依次：`campaign_init` 分区建任务 →
`pack_skill_list` 排 curriculum → 逐任务 `campaign_transition` + 派
skill-debug worker → 有提案派 skill-verify verifier → `skill_promote` →
亲自跑 heldout-eval → rerun sweep → `campaign_status` 汇总。

最小前提：场景中已有可驱动的机器人实体（`robot_describe` 能读到关节/能力），
dev 与 heldout 是**不同 sceneId 的场景实例**，goal 谓词引用的实体真实存在。

## 8. 错误码速查

| 错误码 | 含义 |
|---|---|
| `CAMPAIGN_ILLEGAL_TRANSITION` | 状态机非法迁移 |
| `CAMPAIGN_PARTITION_VIOLATION` | worker/verifier 越权碰 heldout |
| `CAMPAIGN_BUDGET_EXCEEDED` | campaign 预算耗尽，后续调用被拦 |
| `SKILL_NOT_VERIFIED` | 未过 verify 的提案被 promote |
| `SPEC_UNREACHABLE` / `SPEC_ENTITY_MISSING` / `SPEC_ALREADY_SATISFIED` | `sim_task_check` spec 级门拦截（未推进物理） |
| `OBSERVATION_UNAVAILABLE` | 谓词求值缺数据——如实报告，不猜 |
