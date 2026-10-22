# packs 技能库（PACK_SKILLS）

> 实现：`packages/policy-registry/src/skill-library.ts`（读写层）+ `src/skill-tools.ts`（工具面）。
> 契约：`docs/AGENT_GRAPH_CONTRACT.md` §4；类型：`packages/lyapunov-contracts/src/agent-graph.ts`
> （`SkillProposal` / `SkillPromotion` / `PackSkill`，冻结勿改）。

## 1. 目录约定

每个能力包可以携带一个技能库，全部文件都在包目录内、随包分发：

```
packs/<packId>/
├── skills/
│   ├── <skillId>.json        # 已准入技能：PackSkill（schema "lyapunov-pack-skill/1"，promotion 必填）
│   └── promotions.jsonl      # 晋升账本：每行一个 SkillPromotion，只追加、不改写历史行
└── proposals/
    ├── <skillId>.json        # 未准入提案：PackSkill（promotion 缺省）
    └── <skillId>.verify.json # 最近一次验证记录（SkillVerifyRecord，覆盖写、最新为准）
```

- **提案与技能分目录**：`skill_propose` 只写 `proposals/`，绝不直接进 `skills/`；
  `promote` 是提案进入 `skills/` 的唯一通道（转正 = 移动，提案文件与 verify 文件同时清除）。
- `skills/` 目录是**纯新增**目录，不改 `pack.json` 已发布 schema 的任何字段；
  没有 `skills/` 的包 = 没有已准入技能（list 返回空，不报错）。
- `promotions.jsonl` 是审计账本：一行一次晋升，含 `verifierRunId` / `reproducedTaskIds` /
  `attempts` / `promotedAt`，可逐字重放准入历史。

## 2. 准入协议（verifier gating）

技能的唯一准入判据：**该提案存在 verify 记录且 `passed === true`**。

```
worker 产出 SkillProposal ──skill_propose──▶ proposals/<skillId>.json（未准入）
                                                 │
verifier 复现提案程序 ≤N attempts ──skill_verify_record──▶ proposals/<skillId>.verify.json
                                                 │ passed=true
                                                 ▼
                          skill_promote ─▶ skills/<skillId>.json（+ promotion 字段）
                                          + promotions.jsonl 追加一行
                                          − 移除 proposals/<skillId>.json 与 .verify.json
```

- 无 verify 记录或 `passed=false` 时 `skill_promote` 具名拒绝 **`SKILL_NOT_VERIFIED`**，
  不产出任何 `skills/` 文件与账本行；提案保留，可再次 `skill_verify_record` 覆盖记录后重试。
- 已准入的同名技能：再 propose / verify / promote 均具名拒绝 `SKILL_ALREADY_PROMOTED`；
  同名待审提案不覆盖写（`SKILL_PROPOSAL_EXISTS`）。
- `promotion` 字段的四个审计值（`verifierRunId`/`reproducedTaskIds`/`attempts`/`promotedAt`）
  全部来自 verify 记录与系统时钟，**不接受调用方传入**——这是账本可信的前提。

## 3. 工具面（契约冻结名）

| 工具 | 入参 | 返回要点 |
|---|---|---|
| `pack_skill_list` | `{packId?}` | 全部**已准入**技能（`promotion` 存在的才列出）；packId 缺省扫全部包，包不存在 `SKILL_PACK_NOT_FOUND` |
| `pack_skill_get` | `{packId, skillId}` | 单个 PackSkill + `admitted` 标志；缺件 `SKILL_NOT_FOUND` |
| `skill_propose` | `{packId, proposal}` | 写未准入提案；`proposal.packId` 与入参不一致 `SKILL_PACK_MISMATCH` |
| `skill_verify_record` | `{skillId, verifierRunId, reproducedTaskIds, attempts, passed, packId?}` | 记录验证结果；skillId 跨包唯一时可省 packId，多包命中 `SKILL_AMBIGUOUS` |
| `skill_promote` | `{skillId, packId?}` | 校验 verify 通过 → 转正 + 账本追加；未过 `SKILL_NOT_VERIFIED` |

同名 commands 同步注册（`rawInput` 为 JSON 字符串）。全部错误以 `SKILL_*` 具名码
挂在 `error.code` 上抛，不吞不译。

## 4. 读写层保证

- **JSON 往返**：所有持久化对象纯 JSON（契约 §0.7），读写均经 `JSON.parse`/`stringify` 深拷贝，
  调用方改不到盘上数据。
- **原子写**：`<file>.json` 一律同目录临时文件 + `rename`，读者只看到完整 JSON 或没有文件；
  `promotions.jsonl` 单行 `append`，崩溃至多留半行在文件尾（读侧按行解析，容忍截断尾行）。
- **id 校验**：`packId`/`skillId` 只允许 `[A-Za-z0-9_.-]`（首字符字母或数字），
  路径逃逸字符直接 `SKILL_ID_INVALID`。
- **持久化位置**：packsRoot = 产品安装根的 `packs/`；测试注入临时目录夹具
  （`applySkillTools(ctx, {packsRoot})` / 各库函数首参）。

## 5. 示例

`packs/franka_panda/skills/panda-grasp-retry-after-slip.json` 是一条字段完整的示例
`PackSkill`（fixture：runIds/verifierRunId/author 均以 `fixture` 前缀标注，非真实
验证产物）；同目录 `promotions.jsonl` 有一行与之对应的示例账本记录。
