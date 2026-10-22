/**
 * agent-graph 共享契约（0.2.0α1 冻结版）。
 *
 * 这是五个并行施工代理的**唯一类型来源**：sim_task_check 的谓词、campaign 工件、技能提案
 * 都在此声明，各包只 import 不重复定义。修改本文件必须同步 docs/AGENT_GRAPH_CONTRACT.md。
 *
 * 设计锚点：
 *  - 谓词由平台确定性求值（不经过模型），命名失败原因回传 worker——ASPIRE 的 named reason。
 *  - ActionReceipt.taskAchieved 的真实来源之一（benchmark worker 之外的第一条真值通道）。
 *  - 全部 JSON 可序列化（落 run artifacts / pack skills / session 事件都要求可重建）。
 */
import type { Quaternion, Vec3 } from './types.ts'

// ---------- 任务谓词（sim_task_check 求值对象） ----------

/** 单个原子谓词：kind 是封闭可扩展集；params 是该 kind 的具名字段。 */
export type PredicateAtom =
  | { kind: 'entity-in-box'; entityId: string; center: Vec3; halfExtents: Vec3; toleranceM?: number }
  | { kind: 'distance-below'; entityA: string; entityB: string; maxM: number }
  | { kind: 'distance-above'; entityA: string; entityB: string; minM: number }
  | { kind: 'contact-exists'; entityA?: string; entityB?: string }
  | { kind: 'joint-in-range'; entityId: string; jointName: string; min?: number; max?: number }
  | { kind: 'settled'; entityId?: string; maxLinearSpeedMps?: number; maxAngularSpeedRps?: number; windowSteps?: number }
  | { kind: 'reachable'; entityId: string; robotId: string; marginM?: number }
  | { kind: 'no-penetration'; entityA?: string; entityB?: string }

/** 谓词组合树。 */
export type PredicateExpr =
  | PredicateAtom
  | { and: PredicateExpr[] }
  | { or: PredicateExpr[] }
  | { not: PredicateExpr }

/** 谓词失败读数：具名原因码 + 期望/实测，worker 据此定向修复而非盲重试。type 形式保持 JsonValue 兼容。 */
export type PredicateFailure = {
  predicate: PredicateExpr
  expected: string
  measured: string
  /** 封闭可扩展原因码；worker 的 failure-signature 分桶键。 */
  reasonCode:
    | 'POSE_OUTSIDE_BOX' | 'DISTANCE_NOT_MET' | 'CONTACT_MISSING' | 'JOINT_OUT_OF_RANGE'
    | 'NOT_SETTLED' | 'UNREACHABLE' | 'PENETRATION_PRESENT' | 'ENTITY_MISSING'
    | 'JOINT_MISSING' | 'OBSERVATION_UNAVAILABLE'
}

/** sim_task_check 返回。spec 级检查失败时 evaluated=false 且不重入仿真。type 形式保持 JsonValue 兼容。 */
export type TaskCheckResult = {
  taskAchieved: boolean
  evaluated: boolean
  failed: PredicateFailure[]
  /** spec 级（最便宜优先门）拦截：未执行物理评估时的具名拒绝。 */
  rejectedBy?: 'SPEC_UNREACHABLE' | 'SPEC_ALREADY_SATISFIED' | 'SPEC_ENTITY_MISSING'
  frameId?: string
  stepIndex?: number
  /** 失败时按 reasonCode 从 packs/<id>/skills/ 自动召回的已准入技能摘要（无匹配时省略）。 */
  matchedSkills?: Array<{ packId: string; skillId: string; fixStrategy: string; reasonCodes: string[] }>
}

// ---------- Campaign（campaign_* 工具的持久化状态） ----------

export type TaskPartition = 'dev' | 'heldout'
export type TaskStatus =
  | 'pending' | 'exploring' | 'debugging' | 'verifying' | 'heldout-eval' | 'done' | 'blocked' | 'rejected'

export type CampaignTask = {
  taskId: string
  sceneId: string
  partition: TaskPartition
  goal: PredicateExpr
  status: TaskStatus
  workerRunIds: string[]
  heldoutResult?: { taskAchieved: boolean; checkedAt: string; runId: string }
  blockedReason?: string
}

export type CampaignBudget = {
  maxToolCalls: number
  maxSimSteps: number
  maxWallSeconds: number
}

export type CampaignBudgetUsed = { toolCalls: number; simSteps: number; startedAt: string }

export type Campaign = {
  campaignId: string
  createdAt: string
  tasks: CampaignTask[]
  budget: CampaignBudget
  used: CampaignBudgetUsed
  status: 'running' | 'completed' | 'blocked' | 'aborted'
}

// ---------- Run Artifacts（每次工具调用的证据轨迹） ----------

export type RunCallArtifact = {
  seq: number
  callId: string
  tool: string
  /** 参数 JSON 的 sha256（不存原文，避免大参数体）。 */
  argsDigest: string
  /** 工具返回里有的回执字段原样转录；没有则省略。 */
  receipt?: { generation?: number; sceneRevision?: number; startStep?: number; endStep?: number; status?: string; taskAchieved?: boolean; reason?: string }
  keyframe?: string
  error?: string
  at: string
}

export type CampaignRun = {
  runId: string
  campaignId: string
  taskId: string
  role: 'worker' | 'verifier' | 'coordinator'
  calls: RunCallArtifact[]
  summary?: { toolCalls: number; simSteps: number; outcome: 'success' | 'failed' | 'budget-exceeded' | 'aborted'; notes?: string }
}

// ---------- 技能库（packs/<id>/skills/，verifier 准入） ----------

/** ASPIRE 同构：失败签名 + 适用条件 + 修复策略 + 程序草图 + 我们的回执证据。 */
export type SkillProposal = {
  skillId: string
  packId: string
  /** 触发本技能的失败签名（reasonCode 集合 + 场景特征描述）。 */
  failureSignature: { reasonCodes: string[]; description: string }
  /** 适用条件：机型/场景/谓词形态，worker 开跑前的匹配判据。 */
  applicableWhen: { robotKinds?: string[]; taskShape?: string; description: string }
  /** 修复策略陈述 + 可执行程序草图（typed 工具调用序列）。 */
  fixStrategy: string
  program: Array<{ tool: string; input: Record<string, unknown> }>
  /** dev 证据：产生本提案的 run 集合。 */
  devEvidence: { runIds: string[]; checkedAt: string }
  author?: string
}

export type SkillPromotion = {
  skillId: string
  packId: string
  verifierRunId: string
  reproducedTaskIds: string[]
  attempts: number
  promotedAt: string
}

/** packs/<id>/skills/<skill>.json 顶层形状。 */
export type PackSkill = {
  schema: 'lyapunov-pack-skill/1'
  proposal: SkillProposal
  promotion?: SkillPromotion
  deprecated?: { at: string; reason: string }
}

export type { Vec3, Quaternion }
