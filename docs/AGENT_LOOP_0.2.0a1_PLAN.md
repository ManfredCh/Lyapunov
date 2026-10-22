# 0.2.0α1 计划：Verified Skill Loop（ASPIRE × Lyapunov）

日期：2026-10-22。状态：计划待评审。目标：为 `0.2.0-alpha.1` 定义 agent loop 升级范围。

## 1. 结论先行

**ASPIRE（NVlabs，Agentic Skill Programming through Iterative Robot Exploration）不是 agent loop
框架**——它的 loop 是外购的（Claude Code / Codex），护城河是一套**验证基础设施**：
原语级回执 + 多模态证据、worker/verifier 多 agent 分工、dev/held-out 种子分治、
"只有 verifier 能复现的修复才准入技能库"的技能准入协议、以及信息隔离
（生成代码拿不到 sim 真值）。用法形态是给编码 agent 分发 skills 包
（`.claude/skills/`、`.codex/skills/`、`.agents/skills/`），prompt 驱动
coordinator 跑"生成 → 调试 → 验证 → 入库"的 campaign。

**我们的位置**：上游 DSH 自己挂账的 deferred 清单
（`.agents/notes/implemented/feature/2026-07-16-harness-level-loop.md`）正好是：
独立 evaluator、evaluator 驱动的反馈轮、completion certificate、确定性 checker、
对抗 verifier、token/时长预算。**ASPIRE 给了这套东西在机器人域的完整参照实现。**

我们的独特优势（ASPIRE 没有，保留并放大）：

- `ActionReceipt` 带 `worldGeneration/appliedSceneRevision/stepIndex/实测 Frame`
  （关节实测值、contacts、penetrations），CAS 防漂移——比 ASPIRE 的关键帧+状态码更强；
- `taskAchieved` 与动作 `status` 分离记账，与 NeurIPS'25 评测口径（task success vs
  action completion accuracy 分离）一致；
- 场景 CAS + revision 快照 = 天然的 dev/held-out 分治 substrate；
- 已有 worker-subagent、goal-round-driver、typed tool 注册表、packs 技能载体、
  `.agents/skills/` 加载链——不需要改 agent-loop。

**总判断：可行且值得做。做"回路之上的回路"，不改 `agent.ts`。**

## 2. 缺口清单（审计实测，非臆想）

| # | 缺口 | 证据 |
|---|---|---|
| G1 | `taskAchieved` 只有 LIBERO worker 真写；sim-mujoco/isaac/newton 只写 False | `sim-mujoco/python/worker.py:3013`、`benchmark-libero/python/worker.py:565` |
| G2 | loop 无 verify 阶段；goal/ralph 完成判定全靠模型/worker 自报 | `tool-ralph` README L162 "no independent evaluator" |
| G3 | 无 per-call 证据轨迹工件（receipt 只在 tool/result JSON，无结构化 run artifacts） | `renderRobotToolValue` 只渲染文本 |
| G4 | 无"修复准入"协议：workflow 能自测但不能把"验证过的修复"沉淀进 packs | `robot-workflows` 自产 taskAchieved 不外溢 |
| G5 | 无 dev/held-out 场景分治语义 | scene CAS 有，但无"评估分区"概念 |
| G6 | 预算上限（token/时长/步数）deferred 未实现 | 上游 deferred 清单 |

## 3. 架构：六件套（全部经扩展点，不动 agent-loop）

```
                ┌─────────────────────────────────────────────────┐
 用户任务 ────► │ Campaign Coordinator（goal-round-driver 驱动）    │
                │  curriculum：挑任务、派 worker、收 grade           │
                └──┬───────────────────┬───────────────────┬─────┘
                   ▼                   ▼                   ▼
              Worker subagent    Worker subagent     Verifier subagent
              （探索+写程序+调试） （并行候选 evosearch） （只凭技能库复现）
                   │                   │                   │
                   └─────────► 工具调用 ─┴─► ActionReceipt ─┴─► 准入判定
                                     │                        │
                                     ▼                        ▼
                        Run Artifacts（run_id/每次调用回执）  Skill Library
                        + task-check 谓词判定              packs/<id>/skills/
                        （taskAchieved 真值）               {签名,条件,修复策略,代码}
```

### 3.1 确定性任务断言层 `sim_task_check`（补 G1，α1 第一优先）

新工具（`robot-workflows` 或独立包，走 `ctx.tools.register`，typed schema 同既有）：

- 输入：世界句柄 + 谓词表达式（实体 pose 在位姿盒内 / 接触对存在 / 距离阈值 /
  关节角范围 / 静止判据），谓词组合 and/or/not；
- 实现：对 worker 的 `observe`/`inspect` 读数做**确定性求值**，不经模型；
- 输出：`{taskAchieved, failedPredicates:[{name, expected, measured, reasonCode}]}` —
  **具名失败原因**（"目标在臂展外 8cm" 而非 "bad"），喂回 worker 供针对性修复；
- 最便宜优先门序：spec 级检查（可达性/尺寸/t=0 已满足）先于 rollout，
  不可解任务在执行前被具名拒绝（借鉴 genesis-lab 门控）；
- 写回 ActionReceipt.taskAchieved——三个 sim worker 自此有真值来源。
- 反作弊：worker/生成代码经工具 API 访问，谓词由平台求值——隔离与 ASPIRE 同级。

### 3.2 Run Artifacts（补 G3）

- 每次工具调用落结构化记录：`{callId, tool, argsDigest, receipt{generation,
  revision, startStep, endStep, status, taskAchieved, reason}, keyframes?}`；
- `camera_*`/`recording_*` 按需取关键帧（失败调用前后各一帧，非全视频——ASPIRE 做法）；
- 位置：`scenes/<id>/runs/<run_id>/calls/` + `run.json` 汇总（复用 recording 通道落盘路径）；
- Model-visible ⟺ logged：run artifacts 与会话事件并存，摘要经 `additionalContexts`
  或 trajectory 投影回模型。

### 3.3 单任务 Worker Fix Loop（α1 骨架）

`.agents/skills/skill-debug/`（产品内置技能，仿 iterative-debugging SKILL.md 移植）：

1. **探索**：`robot_describe`/`scene_inspect`/`robot_state` 拿真实可用关节/实体/位姿；
2. **写任务程序**：调用 typed 工具编排动作序列（不生成裸控制代码，走工具白名单）；
3. **执行+读回**：`robot_move*` 返回 receipt；`sim_task_check` 求谓词真值；
4. **失败归约**：按 failure signature 分桶（不可达/接触缺失/位姿偏差/超时），
   每版在全部 dev 场景实例上跑分；
5. **产出**：`run.json` + `skill_proposal.json {failureSignature, applicableWhen,
   fixStrategy, programSketch, devEvidence}`。

### 3.4 Verifier 准入的技能库（补 G4，α1 核心）

- verifier subagent 独立会话：**只给技能库 + 提案**，不给 proposer 的产物/对话；
- 在 dev 场景头 N 个实例上重解，≤2 次尝试内复现 `taskAchieved=true` 才准入；
- 准入物：`packs/<id>/skills/<skill>.json`（ASPIRE 同构 schema + 我们的回执引用）；
- 晋升审计：每次晋升记 `promotion.json`（verifier run_id、复现种子集、回执指纹）——
  **completion certificate** 的落形；
- 库查询工具 `pack_skill_list`/`pack_skill_get`：worker 开跑前必读（curriculum 由
  coordinator 依"库能教会什么"排序）。

### 3.5 Dev/Held-out 场景分治（补 G5）

- 场景 CAS 已有：`expectedGeneration`/`expectedRevision`；新增评估语义：
  - `scene_snapshot` 复制场景为评估实例（已有复制能力），标记
    `partition: dev|heldout`（entity 属性，不写物理）；
  - worker 只能对 `dev` 实例迭代；`heldout` 由 **coordinator** 独占跑分
    （worker 无权限读 heldout 回执——防过拟合调试）；
  - `audit_partition` 校验器：任一 dev 修订泄漏进 heldout 实例 → 判 campaign 无效
    （ASPIRE `audit_seeding.py` 等价物）。

### 3.6 预算与护栏（补 G6）

- campaign 级预算字段：`maxCalls, maxSimSteps, maxWallSeconds, maxModelTokens`；
- 走 `agent/request` waterfall 计数 + `agent/turn-stopping` 终判（扩展点，不改 loop）；
- 超限 → `concludesTurn` + campaign `blocked` 终态，run.json 如实记账。

## 4. 阶段切片

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 = α1 硬内核** | `sim_task_check` 谓词层 + run artifacts + 单 worker fix-loop skill + 预算上限 | 单任务端到端：worker 调试一版程序至 `taskAchieved=true`，artifacts 可回放 |
| **P1** | coordinator + verifier 准入 + `packs/<id>/skills/` 库 | 提案被 verifier 复现才入库；不可复现的提案被拒（负对照） |
| **P2** | dev/heldout 分治 + `audit_partition` + heldout 统计报表 | 泄漏检测负对照红；heldout 报表出真数字 |
| **P3** | evosearch-lite：并行 worker 跑候选程序，dev 集选型 | N 候选并行，选型记录可审计 |

α1 交付 **P0+P1**（单任务验证闭环 + 技能准入）；P2/P3 是 α2 候选。

## 5. 与既有约定的对位

- **Plugins, not loop changes**：全部新行为经 `ctx.tools.register`/`ctx.on`/
  `agent/*` waterfall/`concludesTurn`/`sessionProjections`/`ctx.effect`；`agent.ts` 零改动；
- **Model-visible ⟺ logged**：run artifacts 与 predicate 判定都落 session 事件
  （新事件如 `campaign/call`、`campaign/promotion`）；
- **测试纪律**：谓词求值器是纯函数 → 仓内夹具测试；worker/verifier 链路用现有
  `resource-route-harness` 模式做真链；负对照（不可复现提案被拒、分区泄漏被审计）
  是必做用例；
- **上游边界**：不 patch DSH loop；若必须动上游，走 `packages/*/patches/*.patch` +
  `UPSTREAM_LOCK.json` 钉指纹，并评估能否改为产品侧插件；
- **版本节奏**：0.2.0α1 仍是 prerelease；会话 schema 只加不改（monotonic
  `SCHEMA_VERSION`，遵循 persistence-type 约定）。

## 6. 风险

- **技能泛化**：dev→heldout 过拟合——靠 P2 分治+审计强制；
- **谓词表达力**：手写谓词覆盖常见任务，VLM 判定（AutoEval 式）留 P3+ 备选；
- **并行 worker 资源**：多 MuJoCo 实例内存/CPU——P3 前先容量测量；
- **ASPIRE 代码不可直接用**（Apache-2.0 可用但耦合 robosuite/LIBERO），我们移植
  **协议**（SKILL.md 流程 + verifier 准入），不搬代码。

## 7. 立刻可做（α1 kick-off）

1. 新包 `packages/sim-task-check/`：`sim_task_check` 工具 + 谓词求值器 + 测试；
2. `robot-tools` 增 run-artifact 落盘钩子（`ctx.on("tool/result")` 收集）；
3. `.agents/skills/skill-debug/SKILL.md`：移植 iterative-debugging 协议到我们的工具名；
4. `packs/<id>/skills/` 目录约定 + `pack_skill_*` 查询工具；
5. campaign coordinator：goal-round-driver 注入 campaign 状态机（不写 loop）。
