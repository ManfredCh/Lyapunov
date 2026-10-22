---
name: skill-debug
description: "Worker fix-loop 协议：在 campaign 的 dev 任务上探索真实世界、用 typed 工具白名单写任务程序、按 sim_task_check 的具名 reasonCode 分桶迭代调试，每版在全部 dev 实例上跑分，产出 skill_propose 提案。只在 partition=dev 的任务上工作；heldout 由 coordinator 独占。"
---

# Skill Debug（Worker fix-loop）

你是 campaign 里的 **Worker subagent**。coordinator 用 `campaign_transition` 把一个
`partition:"dev"`、`status:"exploring"` 的任务派给你；你的工作是把它做到
`taskAchieved=true` 并把可复用的修复模式沉淀成 `skill_propose` 提案。

协议骨架移植自 NVIDIA ASPIRE 的 iterative-debugging，工具名全部换成本仓库
`docs/AGENT_GRAPH_CONTRACT.md` §2–§4 的冻结名。

## 0. 边界（先读，不可违背）

- **只能碰 `partition:"dev"` 的任务实例。** worker 对 `partition:"heldout"` 任务的任何
  run 会被 agent-graph 记为 `CAMPAIGN_PARTITION_VIOLATION`。heldout 场景、heldout 回执、
  heldout 统计都归 coordinator 独占——你读不到，也不要试图构造。
- **只用白名单工具。** 任务程序 = typed 工具调用序列，不生成裸控制代码。白名单：
  `scene_edit`、`sim_open`、`robot_state`、`robot_describe`、`robot_move_tcp`、
  `robot_pick`、`robot_place`、`motion_plan`、`sim_task_check`、`sim_stop`。
- **开跑前必读技能库。** `pack_skill_list` + `pack_skill_get` 查已准入技能；
  命中 `applicableWhen` 的技能先套用，未命中再自己探索。
- **预算由 campaign 计。** 超限后你的后续工具调用被 `CAMPAIGN_BUDGET_EXCEEDED` 拦截；
  如实停手并在 `campaign_record_run` 的 summary 里记 `budget-exceeded`。
- 每次工具调用的 `argsDigest` 与 receipt 字段已落 run artifacts
  （`.lyapunov/campaigns/<campaignId>/runs/<runId>/calls.jsonl`）——
  不要重复手工抄回执，但要读它们做判断。

## 1. 探索（拿真值，不猜）

在写任何动作之前建立世界与实体的真实读数：

1. `scene_inspect`（dev 场景）：拿到实体清单、id、声明位姿。
2. `sim_open`：打开 dev 场景实例的世界，记下 `worldId` 与 `worldGeneration`——
   后续所有调用带 `expectedGeneration`，陈旧代次会被拒。
3. `robot_describe`（`{worldId, entityId}`）：拿真实关节名、actuator、单位、
   TCP、基座、capabilities、`reachRadiusM`。**白名单里没有 `robot_set_tcp`/`robot_set_base`——
   TCP 缺失就选手腕 nativeBody 做末端，不要改机器人配置。**
4. `robot_state`：拿当前帧实体位姿、接触、关节实测值。

禁用臆测：关节名、site 名、接触对、位姿一律来自上面四个读数；
读不到就按 `OBSERVATION_UNAVAILABLE` 如实上报，不要编。

## 2. 写任务程序（typed 工具序列）

任务程序是一串白名单工具调用（提案里的 `program` 字段同构）：

```json
[
  { "tool": "robot_move_tcp", "input": { "worldId": "…", "entityId": "panda-1",
    "deltaM": [0, 0, -0.05], "expectedGeneration": 3 } },
  { "tool": "robot_pick",     "input": { "worldId": "…", "entityId": "panda-1",
    "targetEntityId": "cube-1", "expectedGeneration": 3 } },
  { "tool": "robot_place",    "input": { "worldId": "…", "entityId": "panda-1",
    "targetPose": { "positionM": [0.4, 0.1, 0.05], "quaternionXyzw": [0,0,0,1] },
    "expectedGeneration": 3 } }
]
```

- 单位是米/弧度/归一化 xyzw 四元数；`deltaM` 5 cm 是 `[0,0,-0.05]` 不是 `5`。
- 长距离/避障用 `motion_plan`；`scene_edit` 只允许改 **dev 场景**中属于你的
  任务实体初始布局（仍受分区铁律约束），不能用来把目标"搬到位"。
- 每步执行后读 receipt：`status`/`taskAchieved`/`reason`/`stepIndex`/`generation`。
  `status` 成功不等于 `taskAchieved`——两条账分开记。

## 3. dev 调试循环（核心）

```
执行程序 → 读 receipt → sim_task_check {worldId, expectedGeneration, predicates}
        → taskAchieved=true ?
            是 → 换下一个 dev 实例，全绿后交付
            否 → 按 reasonCode 分桶 → 改程序 → 重跑
```

`sim_task_check` 由平台确定性求值，返回
`{taskAchieved, evaluated, failed:[{predicate, expected, measured, reasonCode}], rejectedBy?}`。
**先处理 `rejectedBy`（spec 级门，未推进物理就被拦），再看 `failed[].reasonCode`：**

| 桶 | reasonCode / rejectedBy | 定向修复 |
|---|---|---|
| **不可达** | `UNREACHABLE`、`SPEC_UNREACHABLE` | 用 `robot_describe` 的 `reachRadiusM` 核对目标距离；能用 `scene_edit` 调 dev 实例初始布局的就调（写明这是布局修正不是作弊）；布局合法仍不可达 → 任务不可解，如实上报让 coordinator 判 `blocked`，不要伪造可达。 |
| **实体/规格缺失** | `ENTITY_MISSING`、`JOINT_MISSING`、`SPEC_ENTITY_MISSING` | 谓词或程序引用了不存在的实体/关节——回 §1 用 `scene_inspect`/`robot_describe` 重取真实 id 与关节名。 |
| **接触缺失** | `CONTACT_MISSING`、`PENETRATION_PRESENT` | 接触没发生：缩短 `robot_move_tcp` 步长、用 `robot_state` 读实际 TCP-目标距离再逼近；穿透：回退进给量、抬高接近路径。抓取后必须用 `robot_state` 核实物体真实位移，attach/teleport 不算真实抓取。 |
| **位姿偏差** | `POSE_OUTSIDE_BOX`、`DISTANCE_NOT_MET`、`JOINT_OUT_OF_RANGE` | 读 `failed[].expected` vs `measured` 的数值差（如"目标在盒外 8cm"），按世界系绝对坐标修正目标位姿/放置点；`JOINT_OUT_OF_RANGE` 回 `robot_describe` 核限位。 |
| **未稳定** | `NOT_SETTLED` | 放置后加稳定等待再重跑 `sim_task_check`（`windowSteps`/速度阈值如实给）；不要在物体还在动时判成败。 |
| **超时/预算** | receipt 步数超限、`CAMPAIGN_BUDGET_EXCEEDED` | 删无效步、`motion_plan` 合并长轨迹；预算真超限就停手记账，不换壳重试。 |
| **读数不可用** | `OBSERVATION_UNAVAILABLE` | 数据缺失如实报告（如 `reachRadiusM` 未声明），不猜不编。 |
| **t=0 已满足** | `SPEC_ALREADY_SATISFIED` | 平台如实返回 `taskAchieved`——照实记录，仍走全 dev 实例验证，不把"本来就对"包装成修复功劳。 |

**按失败模式组织调试，不按种子逐个修**：同一 reasonCode 桶的失败一起定位根因；
**每一版程序都要在任务名下全部 dev 实例上跑分**再算交付版本——
只绿一个实例的版本不算数。

## 4. 交付

- 全 dev 实例 `taskAchieved=true` → 调
  `campaign_record_run {campaignId, taskId, role:"worker", summary:{…, outcome:"success"}}`
  关 run，等 coordinator 走 `verifying`/`heldout-eval`。
- 真不可解/超预算 → `outcome:"failed"|"budget-exceeded"` + `notes` 写明最后一个
  reasonCode 桶与实测读数，coordinator 据此 `blocked`。

## 5. 产出提案（`skill_propose`）

若调试中形成了可复用修复模式，调 `skill_propose {packId, proposal}`——
提案落 `packs/<packId>/proposals/<skillId>.json`（**未准入**，`promotion` 缺省），
只有 verifier 复现通过后才由 coordinator `skill_promote` 入库。
`SkillProposal` 字段（类型见 `lyapunov-contracts/src/agent-graph.ts`）：

| 字段 | 内容 |
|---|---|
| `skillId` / `packId` | 提案标识与目标 pack。 |
| `failureSignature` | `{reasonCodes:[…], description}`：触发本技能的失败签名，reasonCode 用 §3 的具名码。 |
| `applicableWhen` | `{robotKinds?, taskShape?, description}`：机型/谓词形态/场景特征——worker 开跑前的匹配判据，写窄不写宽。 |
| `fixStrategy` | 修复策略的自然语言陈述（为什么这样修，不是步骤复述）。 |
| `program` | `[{tool, input}]`：可执行的白名单工具序列草图（§2 同构）。 |
| `devEvidence` | `{runIds:[…], checkedAt}`：产生本提案的 run 证据，verifier 会据此复核口径。 |
| `author` | 可选署名。 |

提案只承诺你在 dev 证据里真实做到的事；`applicableWhen` 夸大等于给 verifier
和后续 worker 埋雷。
