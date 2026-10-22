/**
 * Campaign 任务状态机（docs/AGENT_GRAPH_CONTRACT.md §3.2 的唯一判定处）。
 *
 * 合法迁移表（dev 分区）：
 *   pending → exploring → debugging → verifying → heldout-eval → done | blocked | rejected
 * 附加边都是工作流里真实存在的回退/终止：
 *   · pending → rejected（受理即否决）；
 *   · exploring / debugging / verifying → blocked（任何活动阶段都可能被挂起）；
 *   · verifying → debugging（验证打回重调）；
 *   · heldout-eval → blocked | rejected（heldout 复核的另两种终局）。
 *
 * 分区铁律：`partition:'heldout'` 的任务不走 worker 管线，唯一合法迁移是
 *   pending → heldout-eval → done | blocked
 * （pending → heldout-eval 是进入复核的入口边；rejected 对 heldout 不开放）。
 * worker 角色的 run 触碰 heldout 任务 → CAMPAIGN_PARTITION_VIOLATION。
 */
import type { CampaignTask, TaskPartition, TaskStatus } from '../../lyapunov-contracts/src/agent-graph.ts'

export const CAMPAIGN_ILLEGAL_TRANSITION = 'CAMPAIGN_ILLEGAL_TRANSITION'
export const CAMPAIGN_PARTITION_VIOLATION = 'CAMPAIGN_PARTITION_VIOLATION'

/** 活动状态：进入这些状态会开（或复用）一个 session run，工具调用被记进 calls.jsonl。 */
export const ACTIVE_STATUSES: readonly TaskStatus[] = ['exploring', 'debugging', 'verifying', 'heldout-eval']
/** 终局状态：不接受任何出边。 */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['done', 'blocked', 'rejected']

export type RunRole = 'worker' | 'verifier' | 'coordinator'
export const RUN_ROLES: readonly RunRole[] = ['worker', 'verifier', 'coordinator']

const DEV_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['exploring', 'rejected'],
  exploring: ['debugging', 'blocked'],
  debugging: ['verifying', 'blocked'],
  verifying: ['heldout-eval', 'debugging', 'rejected', 'blocked'],
  'heldout-eval': ['done', 'blocked', 'rejected'],
  done: [],
  blocked: [],
  rejected: [],
}

const HELDOUT_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['heldout-eval'],
  exploring: [],
  debugging: [],
  verifying: [],
  'heldout-eval': ['done', 'blocked'],
  done: [],
  blocked: [],
  rejected: [],
}

/** 分区 → 合法出边表；heldout 只留复核入口与复核终局两条边。 */
export function transitionsFor(partition: TaskPartition): Readonly<Record<TaskStatus, readonly TaskStatus[]>> {
  return partition === 'heldout' ? HELDOUT_TRANSITIONS : DEV_TRANSITIONS
}

/** from → to 在该分区下是否合法。 */
export function canTransition(partition: TaskPartition, from: TaskStatus, to: TaskStatus): boolean {
  return (transitionsFor(partition)[from] ?? []).includes(to)
}

/**
 * 校验一次迁移；非法时抛 `CAMPAIGN_ILLEGAL_TRANSITION: ...`（具名拒绝，模型按码分桶）。
 * @returns 迁移前的状态（供回执 from 字段）。
 */
export function assertTransition(task: Pick<CampaignTask, 'taskId' | 'partition' | 'status'>, to: TaskStatus): TaskStatus {
  const from = task.status
  if (!canTransition(task.partition, from, to)) {
    throw new Error(`${CAMPAIGN_ILLEGAL_TRANSITION}: 任务 ${task.taskId}（分区 ${task.partition}）不允许 ${from} → ${to}；合法出边：${(transitionsFor(task.partition)[from] ?? []).join(', ') || '（终局状态，无出边）'}`)
  }
  return from
}

/** worker 角色的 run 不得触碰 heldout 任务；其它角色放行。 */
export function assertRunPartition(task: Pick<CampaignTask, 'taskId' | 'partition'>, role: RunRole): void {
  if (task.partition === 'heldout' && role === 'worker') {
    throw new Error(`${CAMPAIGN_PARTITION_VIOLATION}: heldout 任务 ${task.taskId} 只接受 verifier/coordinator run，worker run 被分区铁律拒绝`)
  }
}

/** 未显式给 role 时按目标状态推断：执行阶段是 worker，复核/heldout 阶段是 verifier。 */
export function defaultRoleFor(to: TaskStatus): RunRole {
  return to === 'verifying' || to === 'heldout-eval' ? 'verifier' : 'worker'
}
