/**
 * sim_task_check 的 spec 级静态门（契约 `docs/AGENT_GRAPH_CONTRACT.md` §2）：
 * 在物理评估之前用同一帧观察做最便宜优先拦截，`checkSpec!==false` 时执行序为
 * SPEC_ENTITY_MISSING → SPEC_UNREACHABLE → SPEC_ALREADY_SATISFIED。
 *
 *  - SPEC_ENTITY_MISSING：谓词引用的实体（entityId/entityA/entityB/robotId）不在世界里，
 *    不进入物理评估（`evaluated:false`）；
 *  - SPEC_UNREACHABLE：正极性 `reachable` 原子且基座-目标距离**明确**超出声明臂展
 *    （`marginM` 边界带内不判、臂展未声明不判——不猜）；
 *  - SPEC_ALREADY_SATISFIED：观察帧 `stepIndex===0`（t=0，尚无动作证据）且全谓词已真，
 *    如实返回 `taskAchieved` 并标 `rejectedBy`，由调用方决定是否仍推进验证；
 *    `stepIndex>0` 时的全真是动作结果，走正常评估路径不标此门。
 *    本门只在 `phase:'observed'`（真实帧）判定：声明期帧的 stepIndex 是构造值，
 *    场景声明满足不等于世界 t=0 满足。
 *
 * `phase`：`'declared'` 只跑实体缺失 + 臂展两道声明级静态门（对场景声明帧）；
 * `'observed'`（默认）跑完整三门（对真实观察帧）。
 */
import type { PredicateExpr, PredicateFailure, TaskCheckResult } from '../../lyapunov-contracts/src/agent-graph.ts'
import type { Frame } from '../../lyapunov-contracts/src/types.ts'
import { collectAtoms, entityOf, evaluatePredicate, predicateEntityIds, reachRadiusMOf, type PredicateContext } from './predicates.ts'

/** 返回 spec 级拦截结果；`null` 表示门通过、应继续物理评估。 */
export function checkSpecGate(expr: PredicateExpr, frame: Frame, ctx: PredicateContext = {}, phase: 'declared' | 'observed' = 'observed'): TaskCheckResult | null {
  const identity = { frameId: frame.frameId, stepIndex: frame.stepIndex }
  const missingIds = predicateEntityIds(expr).filter(id => !entityOf(frame, id))
  if (missingIds.length) {
    return {
      taskAchieved: false,
      evaluated: false,
      rejectedBy: 'SPEC_ENTITY_MISSING',
      failed: missingIds.map(id => ({
        predicate: expr,
        expected: `谓词引用的实体 "${id}" 存在于世界`,
        measured: '观察帧中没有该实体',
        reasonCode: 'ENTITY_MISSING' as const,
      })),
      ...identity,
    }
  }
  const unreachable: PredicateFailure[] = []
  for (const { atom, negated } of collectAtoms(expr)) {
    if (negated || atom.kind !== 'reachable') continue
    const target = entityOf(frame, atom.entityId)
    const robot = entityOf(frame, atom.robotId)
    const radius = reachRadiusMOf(ctx.robots?.find(entry => entry.entityId === atom.robotId))
    // 实体缺失已由上一门拦掉；臂展未声明时 spec 层不判，留给评估层如实报 OBSERVATION_UNAVAILABLE。
    if (!target || !robot || radius === undefined) continue
    const margin = atom.marginM ?? 0
    const measured = Math.hypot(
      robot.transform.position[0] - target.transform.position[0],
      robot.transform.position[1] - target.transform.position[1],
      robot.transform.position[2] - target.transform.position[2],
    )
    if (measured > radius + margin) {
      unreachable.push({
        predicate: atom,
        expected: `基座-目标距离 <= ${(radius + margin).toFixed(4)}m（声明臂展 ${radius.toFixed(4)}m${margin ? `+margin ${margin.toFixed(4)}m` : ''}）`,
        measured: `${measured.toFixed(4)}m`,
        reasonCode: 'UNREACHABLE',
      })
    }
  }
  if (unreachable.length) {
    return { taskAchieved: false, evaluated: false, rejectedBy: 'SPEC_UNREACHABLE', failed: unreachable, ...identity }
  }
  if (phase === 'observed' && frame.stepIndex === 0) {
    const verdict = evaluatePredicate(expr, frame, ctx)
    if (verdict.ok) {
      return { taskAchieved: true, evaluated: true, rejectedBy: 'SPEC_ALREADY_SATISFIED', failed: [], ...identity }
    }
  }
  return null
}
