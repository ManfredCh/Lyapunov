# Agent Graph 施工契约（0.2.0α1 并行代理版）

冻结时间：2026-10-22。本文件是 5 个并行施工代理的**唯一接口契约**；任何包只准按本文件实现，
跨包分歧一律改本文件而不是改对方代码。

## 0. 总规则（不可违背）

1. **类型唯一来源**：`packages/lyapunov-contracts/src/agent-graph.ts`（已冻结，勿改）。
   谓词 / Campaign / RunArtifact / SkillProposal 全部从那里 import。
2. **不改 agent-loop**：所有新行为走 `ctx.tools.register` / `ctx.on` / `tools/execute`
   waterfall / `ctx.commands.register` / `ctx.effect` / sessionProjections。
3. **不碰 bundle 组合文件**：`cordis.yml`、`lyapunov-product-bundle`、`script/test-ci.manifest.json`、
   `packages/lyapunov-shell/` 全部由 **Agent E** 独占；其他代理新包只产出
   `package.json`（按 `robot-workflows` 同构：private + peerDeps cordis/dsh-tools/dsh-commands
   optional + `dsh.bundle.patch: cordis.patch.yml` 若需要）和源码。
4. **命名冻结**：工具名 `sim_task_check`、`pack_skill_list`、`pack_skill_get`、
   `campaign_init`、`campaign_status`、`campaign_record_run`、`campaign_transition`、
   `skill_propose`、`skill_verify_record`、`skill_promote`。
   新错误码前缀：`TASK_CHECK_*`、`CAMPAIGN_*`、`SKILL_*`（具名、大写蛇形）。
5. **测试**：每个新包自带 `test/*.test.ts`（bun:test），断言真实行为不写假桩；
   测试夹具放各包 `test/fixtures/`。
6. **持久化位置**：campaign/run artifacts 落 `scenes/<sceneId>/campaigns/<campaignId>/`
   （经 `sceneOperationsFor` 的场景目录或 session 工作目录，二选一须与 Agent B 实现一致——
   约定：**session 工作目录下的 `.lyapunov/campaigns/`**，不污染场景文档）。
7. **JSON 可重建**：所有持久化对象可被 JSON.stringify/parse 往返；禁 Map/Set/class 实例。

## 1. 包与所有权划分（互不重叠）

| 代理 | 拥有的文件 | 交付 |
|---|---|---|
| **A sim-task-check** | `packages/sim-task-check/**` | 谓词求值器 + `sim_task_check` 工具 + spec 级门 + 测试 |
| **B agent-graph-core** | `packages/agent-graph/**` | campaign 状态机 + run-artifact 收集器（tools/execute waterfall）+ 预算护栏 + campaign_* 工具 + 测试 |
| **C skill-library** | `packages/policy-registry/src/skill-library.ts`、`packages/policy-registry/src/skill-tools.ts`、`packages/policy-registry/test/skill-*.test.ts`、`packs/*/skills/`(空骨架+示例)`、`docs/PACK_SKILLS.md` | `packs/<id>/skills/` 约定 + `pack_skill_list/get` + `skill_propose/verify_record/promote` + 测试 |
| **D protocol-skills** | `.agents/skills/skill-debug/`、`.agents/skills/skill-campaign/`、`.agents/skills/skill-verify/`、`docs/AGENT_GRAPH.md` | 三个 SKILL.md 协议（worker/campaign/verifier）+ 用户文档 |
| **E wiring** | `cordis*.yml`、`packages/lyapunov-product-bundle/**`、`packages/lyapunov-shell/src/campaign-*.ts(x)`、`script/test-ci.manifest.json`、`packages/lyapunov-shell/test/campaign-*.test.*` | bundle 注册新包 + campaign 状态 UI 投影 + 测试清单登记 |

## 2. sim_task_check（Agent A）

工具签名（typed schema，同 robot-workflows 风格）：

```
input: {
  worldId: string (required)
  expectedGeneration: integer (required)
  predicates: PredicateExpr (required, JSON)
  checkSpec?: boolean  // 默认 true：先跑 spec 级静态检查
}
returns: TaskCheckResult（见契约类型）
```

- **spec 级门**（`checkSpec!==false` 时先执行，不推进物理）：
  - `SPEC_ENTITY_MISSING`：谓词引用的实体不在世界里；
  - `SPEC_UNREACHABLE`：`reachable` 谓词且目标在声明臂展外（marginM 内不判）；
  - `SPEC_ALREADY_SATISFIED`：t=0 谓词已全真（如实报告，仍返回 taskAchieved）。
- **评估读数来源**：`sim.observe`/`inspect` 当前帧实体/接触/关节——用
  `simWorldsFor(ctx, agent)` 同 `robot-workflows` 的取法；不许私有 hook 进 worker。
- 谓词求值是纯函数（`evaluate(expr, frame, topology?) → TaskCheckResult`），
  单独导出便于测试。
- `reachable` 判据：`description.controller.reachRadiusM`（若有）否则
  基座到目标欧氏距离 vs 臂展声明；数据缺失给 `OBSERVATION_UNAVAILABLE` 不猜。

## 3. agent-graph core（Agent B）

### 3.1 tools/execute waterfall 拦截器（run artifacts + 预算）

- `ctx.on('tools/execute', handler)` waterfall：每次调用前后记录
  `RunCallArtifact`（argsDigest=sha256(args JSON)），取 result.value 里的
  `generation/sceneRevision/startStep/endStep/status/taskAchieved/reason` 若有；
- 预算：隶属 campaign 的调用（agent 上下文里有活动 campaignId——
  用 `ctx.sessionProjections` 或父 agent 标记）计数 toolCalls；sim 步数从
  receipt.stepIndex 增量累计；超限 → 在 waterfall 中返回具名错误
  `CAMPAIGN_BUDGET_EXCEEDED`（**允许当前调用完成，拦截后续调用**，避免半写状态）。
- 落盘：`.lyapunov/campaigns/<campaignId>/runs/<runId>/calls.jsonl`（追加写）+
  `run.json` 汇总（end 时写）。

### 3.2 campaign_* 工具

- `campaign_init {tasks:[{taskId,sceneId,partition,goal}], budget}` → 校验分区/谓词合法 →
  建 Campaign + 每任务 `pending`；
- `campaign_status {campaignId}` → Campaign 全量读数；
- `campaign_record_run {campaignId, taskId, role, summary}` → 关闭 run 写 run.json；
- `campaign_transition {campaignId, taskId, to, blockedReason?}` → 状态机校验
  （pending→exploring→debugging→verifying→heldout-eval→done|blocked|rejected），
  非法迁移具名拒绝 `CAMPAIGN_ILLEGAL_TRANSITION`；
- **分区铁律**：`partition:'heldout'` 任务只允许 `heldout-eval`→`done/blocked`；
  worker run 碰 heldout 任务 → `CAMPAIGN_PARTITION_VIOLATION`。

### 3.3 预算计数位置

`tools/execute` 拦截器内按 callId 归属 runId 累计；`campaign_budget` 超限时拦截
该 campaign 名下后续全部工具调用（其它 session 工具不受影响）。

## 4. Skill Library（Agent C）

- 目录约定：`packs/<id>/skills/<skillId>.json` = `PackSkill`（schema `lyapunov-pack-skill/1`）；
  `packs/<id>/skills/promotions.jsonl` 晋升账本（每行一个 SkillPromotion）。
- `pack_skill_list {packId?}` → 全部已准入技能（promotion 存在的才列出）；
- `pack_skill_get {packId, skillId}` → 单个 PackSkill；
- `skill_propose {packId, proposal:SkillProposal}` → 写提案为 **未准入**（promotion 缺省）
  到 `packs/<id>/proposals/<skillId>.json`，不直接进 skills/ 根；；
- `skill_verify_record {skillId, verifierRunId, reproducedTaskIds, attempts, passed}` →
  记录验证结果；passed=true 时才允许 promote；
- `skill_promote {skillId}` → 校验 verify 通过 → 提案转正入 skills/ + promotions.jsonl 追加
  + `promotion` 字段；未过验证具名拒绝 `SKILL_NOT_VERIFIED`；
- 读取位置：pack 根目录 = `packs/`（产品安装包内 packs 目录；测试用临时目录夹具）。

## 5. 三个 agent skills（Agent D，纯文档）

- `.agents/skills/skill-debug/SKILL.md`：worker fix-loop 协议（探索→写程序→dev 调试→
  按 failureSignature 分桶→产出 proposal），工具名按 §2–§4 冻结名引用；
- `.agents/skills/skill-campaign/SKILL.md`：coordinator 协议（campaign_init→派 worker→
  收 verdict→heldout→rerun sweep），含 curriculum 排序规则；
- `.agents/skills/skill-verify/SKILL.md`：verifier 协议（只见库+提案，≤2 attempts，
  写 skill_verify_record）；
- `docs/AGENT_GRAPH.md`：中文用户文档，讲清 graph 节点/边/分区/预算。

## 6. Wiring（Agent E）

- `cordis.yml`/bundle：注册 `sim-task-check`、`agent-graph`、`policy-registry` 已有则只加新模块；
- `lyapunov-shell`：campaign 状态投影（sessionProjection 'campaigns' → 面板卡片：
  task 状态矩阵 + 预算用量），文件限 `campaign-*` 前缀；
- `script/test-ci.manifest.json`：给新测试文件加 include 条目（reason 写明真实覆盖）；
- 依赖：E 在 A/B/C 提交后做最终接线，故 E 最后启动（或两轮制）。

## 7. 测试边界

- 每包测试自洽（夹具/tmpdir），不依赖其它包未提交产物；
- 跨包集成测试：E 在 `packages/agent-graph/test/campaign-e2e.test.ts` 用临时场景目录
  跑 init→transition→record→propose→verify→promote 全链；
- 反例必测：非法 transition、partition 越权、未验证 promote、budget 超限、
  spec 级拒绝、谓词 OBSERVATION_UNAVAILABLE。
