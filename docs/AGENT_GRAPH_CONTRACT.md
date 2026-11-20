# Agent Graph 接口契约（0.2.1）

初始冻结时间：2026-10-22；以下接口按当前0.2.1原实现校对。
历史施工分工不构成新增开发代理的授权；执行入口以根AGENTS.md为准。
跨包分歧先核对原类型、注册schema和实际owner，再同步契约，不另写替代实现。

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
6. **持久化位置**：campaign/run artifacts 只落调用方真实session工作目录下
   `.lyapunov/campaigns/<campaignId>/`，不落场景目录，不污染场景文档。
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
  `generation/sceneRevision/startStep/endStep/simSteps/status/taskAchieved/reason` 若有；
  `generation` 表示数值 World 代次。SOMA 生成回执的片段名、供应方、模型 revision 与 SHA-256 记录在
  `receipt.motion`，场景修订仍记录在 `receipt.sceneRevision`。
  MuJoCo 人体片段回执提供包含起止步的实际 `simSteps`，预算优先计该值。
- 预算：按调用方真实session身份查原CampaignRuntime.openRuns，取最近活动run；
  父会话、字符串id或投影不是代替子会话owner的入口。普通工具按实际dispatch计toolCalls，
  campaign_*编排调用不计；sim步数按同世界／代次的原回执增量累计。
  超限 → 在waterfall中返回具名错误
  `CAMPAIGN_BUDGET_EXCEEDED`（**允许当前调用完成，拦截后续调用**，避免半写状态）。
- 落盘：`.lyapunov/campaigns/<campaignId>/runs/<runId>/calls.jsonl`（追加写）+
  `run.json` 汇总（end 时写）。

### 3.2 campaign_* 工具

- `campaign_init {tasks:[{taskId,sceneId,partition,goal}], budget}` → 校验分区/谓词合法 →
  建 Campaign + 每任务 `pending`；
- `campaign_status {campaignId}` → Campaign 全量读数；
- `campaign_record_run {campaignId, taskId, role, summary:{outcome,notes?}}` → 关闭本会话run写run.json；
  outcome只允许success／failed／budget-exceeded／aborted；工具数与步数由原owner计量，不能手填；
- `campaign_transition {campaignId, taskId, to, role?, blockedReason?}` → 状态机校验
  （pending→exploring→debugging→verifying→heldout-eval→done|blocked|rejected），
  非法迁移具名拒绝 `CAMPAIGN_ILLEGAL_TRANSITION`；
- **分区铁律**：`partition:'heldout'` 任务只允许 `heldout-eval`→`done/blocked`；
  worker run 碰 heldout 任务 → `CAMPAIGN_PARTITION_VIOLATION`。
- 进入活动状态在调用方自己的会话开run。Worker自行进入exploring／debugging并关闭自己的run；
  fresh Verifier自行进入verifying并取返回runId。Coordinator不代开／代关子会话run。
- 原subagent/end事件确认本地one-shot已结束后，原Campaign owner将漏关run按真实计量记aborted；
  continuable的epoch、已有显式结果和父会话不受影响，不推断任务成功或自动迁移任务。

### 3.3 预算计数位置

`tools/execute` 拦截器内按 callId 归属 runId 累计；`campaign_budget` 超限时拦截
该 campaign 名下后续全部工具调用（其它 session 工具不受影响）。

### 3.4 配对评测

- 在两条 `heldout` 任务的 `campaign_init.tasks[]` 上声明 `pair`。同一 `pair.id` 恰有 `baseline`、`candidate` 两名成员，必须共享 `sceneId`、`goal`、`seed`、`tier` 与 `sceneSha256`。`sceneSha256` 由评测驱动对场景实验条件与源资产计算。两名成员各自通过原工具打开独立世界，状态和预算依旧归原 campaign。
- 每名成员的活动 run 依次留下 `sim_open`、`recording_start`、终态 `sim_task_check`（`checkSpec:false`）及 `recording_stop` 的真实回执。终态判定必须使用原任务谓词以及本次打开的世界、代次和 Scene revision。录制须来自同一次开始回执并已完成，且含实际帧。
- `campaign_record_run` 用上面的判定和录制确定 `summary.outcome` 和 `pairResult`，同时保留原工具参数摘要、失败细项、帧号、录制标识和步骤计量。缺证据时该 run 以 `aborted` 收尾。`campaign_status.comparison` 给出两组均通过、仅基线通过、仅候选通过、均失败，以及未完成的对数。两次编译应用的 Scene revision 不一致时，该对保留为未完成。
- SO-101 桌面分拣由现有 `robot_pick`、`robot_place` 和 `recording_*` 执行。两组共用夹爪角度—指尖间距标定、Mink 规划、容器上方转运及入盒判据。候选组额外在预抓点采同帧腕相机 RGB-D，通过已知平面筛选颜色掩膜，纠正抓取位置及可选的径向偏航。分拣的成功判据覆盖目标入盒、与盒底接触、静止、释放夹爪及干扰物未入盒。

复跑 SO-101 时从仓库根执行以下命令。默认四个种子遍历三档扰动，输出路径须为尚不存在的目录。

```bash
node --experimental-transform-types script/gates/run-so101-paired.ts \
  --model /path/to/robotstudio_so101/asset/so101.xml \
  --python /path/to/mujoco-mink/bin/python \
  --out /path/to/new-results
```

所用 Python 环境包含 MuJoCo、Mink 与 DAQP，摄像机使用 EGL。每一对从暂停世界的第 0 步读取原生状态并核对摘要。双组按对交替先运行，比较相同的初始摆位、质量和摩擦。各组启用实时物理时钟，控制器追加规划带来的步数差异由回执记录。

评测方法参考 Google DeepMind Robotics Antigravity Plugin 的配对扰动与安全终态验证。本实现由 Lyapunov 原生工具执行。 [上游 Gauntlet 评测设计](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics/skills/sim2real-gauntlet)

#### 3.4.1 严格资格与分档统计

- 两成员都可设置 `pair.requirePreflight: true`。活动 run 须在原生第 0 步用 `robot_state` 读全场景，并在同一帧用默认 `sim_task_check` 核对任务尚未达成。终态保持 `physical-contact` 且原生辅助推进计数为零。缺少相应证据的 run 以 `aborted` 收尾。跨成员实测的实体变换与关节状态指纹不一致时，配对保留 `INITIAL_STATE_MISMATCH`，不进入统计。
- 终态前的新鲜 `robot_pick` 和 `robot_place` 回执提供 `workflows`，其中保存动作 ID、终点步号、执行状态、实测 `targetReached` 和已报告的原因。若原生动作记录了请求目标的接触，还保留 `targetContact` 中的接触步数、位移和窗口最大抬升。任务得分来自同一世界的最后物理谓词判定，保留阶段动作和任务得分分别查看。
- `campaign_status.comparison` 返回全局与 `tiers[]` 两层统计。每层都报告有效对、无效对、双过、单边过与双失败，并提供只统计完整对的成功率和双侧精确 McNemar 值。空样本统计值为 `null`。配对资格失败会阻止 campaign 进入 `completed`。
- `run-so101-paired.ts --comparison descent` 让参考与候选共用腕相机纠偏。候选显式使用 `robot_pick.descentSegments: 4`。`--comparison reacquire` 让两组均使用分段下降，仅候选在目标缺失或触边时启用 `wristRefinement.reacquireBackoffM`。两种模式都先运行正确入盒、悬停、盒外、错误物体等四个目标控制场景，然后才创建 campaign。分段规划只在路点上约束 TCP，返回 `collisionChecked=false`。代码对比和试验入口见 [Gauntlet 接入记录](../research/agent-graph-gauntlet/UPSTREAM_COMPARISON.md)。

#### 3.4.2 原生阶段快照与独立安全评分

- MuJoCo 的 `sim_evaluation` 支持 `checkpoint`、`fork`、`command`、`monitor-start`、`monitor-stop`。阶段快照保留完整 `mjSTATE_INTEGRATION` 与关节保持目标，按当前世界代次限制数量。分叉检查编译模型摘要和状态摘要，在新的暂停世界交付。`command` 返回当前代次已产生终态的真实动作请求及起止物理步。源世界结束后使用归档的录像、命令与证据追溯。
- `robot_pick.recordPhaseCheckpoints` 在开爪、下降、闭爪和抬升前保存原生快照。`safeOpenPose` 要求先从原生观测排除夹爪目标接触，并用真实碰撞几何对拟执行轨迹采样。源世界处于暂停时，首条受净空阈值约束的轨迹在 Worker 内接纳后解除暂停。负距离拒绝为 `SAMPLED_CLEARANCE_REJECTED`。
- `robot_place.carryObstacleIds` 在抬高转运中对指定障碍做机器人和携物采样，返回两组最小距离、对应几何和轨迹时间。动作仍按现场接触运行。碰撞距离属于有限采样，`distanceCapM` 表明距离截断边界。动作的原生开始和结束步与预演时间分开保存。
- 两组都可设置 `pair.requireSafety: true`，同时启用 `requirePreflight`。只接受同一世界、代次、场景版本，且覆盖第 0 步至终态的原生监测。两组阈值差异标为 `SAFETY_LIMITS_MISMATCH`。终态通过率和 `comparison.safety` 独立保存，后者包含任务兼安全的通过数和候选相对参考新增违规数。
- `skill_propose` 可设置 `requireSafetyEvaluation: true`。验证通过需声明 `safetyCampaignId`，由 `skill_verify_record` 在调用会话核对已完成原生配对、复现任务、Verifier 的候选执行及其安全通过，且整批候选无新增安全违规。
- 实验驱动的腕相机冻结让控制器收到先前实际采集的旧帧，`WRIST_STALE_FRAME` 以真实动作完成步与帧步序比较。夹爪卡滞仅对显式仿真实验 Worker 启用，出参保存实际触发步。`minimumCloseTravelM` 使用原生实测开闭宽度判 `GRIPPER_STALL`。止损按确已停止且未开始抬升单独计分，相关场景见 [SO-101 原生集成验收](../research/so101-native-evaluation/README.md)。

## 4. Skill Library（Agent C）

- 目录约定：`packs/<id>/skills/<skillId>.json` = `PackSkill`（schema `lyapunov-pack-skill/1`）；
  `packs/<id>/skills/promotions.jsonl` 晋升账本（每行一个 SkillPromotion）。
- `pack_skill_list {packId?}` → 全部已准入技能（promotion 存在的才列出）；
- `pack_skill_get {packId, skillId}` → 单个 PackSkill；
- `skill_propose {packId, proposal:SkillProposal}` → 写提案为 **未准入**（promotion 缺省）
  到 `packs/<id>/proposals/<skillId>.json`，不直接进 skills/ 根；；
- `skill_verify_record {skillId, verifierRunId, reproducedTaskIds, attempts, passed, packId?}` →
  记录验证结果；passed=true 时才允许 promote；
- `skill_promote {skillId, packId?}` → 校验 verify 通过 → 提案转正入 skills/ + promotions.jsonl 追加
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

`robotics-composition` 与对应的 AGY 技能通过现有 DSH filesystem provider 装配。技能按当前工作区选择 Scene、Sim 和算法入口。`robotics_lab` 在已有离线 Scene Workflows 的 Job 中运行有名字的操作，沿用 session owner、取消、`job_output`、产物目录与 campaign tools/execute 留痕。其输出是定位、轨迹候选、资产审计或数据导出回执。任务终态和安全证据仍从实际世界的 `sim_task_check`、原生评估和录制获得。配对与技能准入沿用本合同，实验产物和单步求解不会进入已准入技能库。 [机器人组合实测与覆盖表](../research/agy-robotics/README.md)

`playground_train_so101` 使用单独配置的 CPU 训练解释器，走同一 Job 和留痕通路。训练输出为实际步数、日志和 checkpoint，策略质量使用单独的评测 run 判定。

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
