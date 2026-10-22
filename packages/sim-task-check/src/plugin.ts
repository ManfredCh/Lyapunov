/**
 * `sim_task_check` 工具面（契约 `docs/AGENT_GRAPH_CONTRACT.md` §2）：
 * 对一个已开世界做**确定性**任务谓词判定，不推进物理、不经模型。
 *
 * 执行序：typed schema 校验（`validateArgs`，工具/命令同一条判据）→ 谓词形状校验
 * （`predicateExprProblems`，非法给 `TASK_CHECK_PREDICATE_INVALID`）→ 按执行会话取世界
 * （`simWorldsFor`；无世界 `TASK_CHECK_WORLD_REQUIRED`、`expectedGeneration` 不符
 * `TASK_CHECK_STALE_GENERATION`）→ spec 级门 → `sim.observe` 当前帧 →
 * `evaluatePredicate` → `TaskCheckResult`。
 *
 * spec 门两阶段（都不推进物理）：先对**场景声明**（`sceneOperationsFor` 的
 * `snapshot(world.sceneId)`，实体取声明位姿）拦截 SPEC_ENTITY_MISSING/
 * SPEC_UNREACHABLE——场景服务不可用时如实降级为仅帧级门；再对**当前观察帧**跑同一道门
 * （帧身份更晚，stepIndex===0 时的 SPEC_ALREADY_SATISFIED 只在这一阶段可能命中
 * 接触/关节类已满足的目标）。`checkSpec===false` 显式关掉全部 spec 门。
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { compatibleToolInput } from '../../lyapunov-contracts/src/tool-input.ts'
import { defineTool, validateArgs, ToolArgsError, type ToolExecution, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'
import { simWorldsFor, type RobotDescription, type SimWorlds } from '../../sim-contract/src/index.ts'
import { sceneOperationsFor } from '../../scene-kit/src/plugin.ts'
import { listSkills } from '../../policy-registry/src/skill-library.ts'
import type { Frame } from '../../lyapunov-contracts/src/types.ts'
import type { PredicateExpr, TaskCheckResult } from '../../lyapunov-contracts/src/agent-graph.ts'
import { collectAtoms, evaluatePredicate, predicateExprProblems } from './predicates.ts'
import { checkSpecGate } from './spec-gate.ts'

export const name = 'lyapunov-sim-task-check'
export const inject = ['tools', 'commands']

export interface Config {
  packsDirectory?: string
}

export interface SimTaskCheckInput {
  worldId: string
  expectedGeneration: number
  predicates: PredicateExpr
  checkSpec?: boolean
}

const parameters: ParameterSchemaSpec = { input: { type: 'object', required: true, additionalProperties: false, properties: {
  worldId: { type: 'string', required: true },
  expectedGeneration: { type: 'integer', required: true, description: "Current worldGeneration reported by sim_open/sim_world_list; stale generations are refused." },
  predicates: { type: 'json', required: true, description: "PredicateExpr JSON: atom kinds entity-in-box/distance-below/distance-above/contact-exists/joint-in-range/settled/reachable/no-penetration, composed with and/or/not." },
  checkSpec: { type: 'boolean', description: "Defaults to true: run spec-level gates (SPEC_ENTITY_MISSING/SPEC_UNREACHABLE/SPEC_ALREADY_SATISFIED) before frame evaluation." },
} } }

const description = "Deterministically evaluate task predicates against one open simulation world without stepping physics. Requires worldId and the exact current expectedGeneration. predicates is a PredicateExpr (atom kinds: entity-in-box, distance-below, distance-above, contact-exists, joint-in-range, settled, reachable, no-penetration; combinators and/or/not). Spec-level gates reject first when checkSpec!==false: entities referenced by the predicates but missing from the world (SPEC_ENTITY_MISSING), a positively-required reachable target clearly outside the declared reach radius (SPEC_UNREACHABLE), or the goal already true at stepIndex 0 (SPEC_ALREADY_SATISFIED, still reports taskAchieved). Evaluation reads the current observe frame only: missing entities report ENTITY_MISSING and missing observation data reports OBSERVATION_UNAVAILABLE instead of guessing. Returns TaskCheckResult {taskAchieved, evaluated, failed[{predicate,expected,measured,reasonCode}], rejectedBy?, frameId, stepIndex}."

/** 场景声明 → spec 帧：实体只带声明位姿，stepIndex=0；接触/关节/速度读数本就不存在，谓词会如实报缺。 */
function specFrameOf(worldId: string, generation: number, entities: Array<{ entityId: string; transform: Frame['entities'][number]['transform'] }>): Frame {
  return {
    worldId, generation, stepIndex: 0, simTime: 0, frameId: `spec:${worldId}:${generation}`,
    entities: entities.map(entity => ({ entityId: entity.entityId, transform: entity.transform })),
  }
}

/** reachable 谓词引用到的机器人逐台 describe；describe 失败的条目如实缺席（评估层报 OBSERVATION_UNAVAILABLE）。 */
async function describeReachableRobots(sim: SimWorlds, worldId: string, expr: PredicateExpr): Promise<RobotDescription[]> {
  const robotIds = [...new Set(collectAtoms(expr).filter(({ atom }) => atom.kind === 'reachable').map(({ atom }) => (atom as { robotId: string }).robotId))]
  const robots: RobotDescription[] = []
  for (const robotId of robotIds) {
    try { robots.push(await sim.describe(worldId, robotId)) } catch { /* 缺 describe 不是世界错误，留给评估层如实报 */ }
  }
  return robots
}

export function apply(ctx: Context, config: Config = {}) {
  const packsRoot = config.packsDirectory ? resolve(config.packsDirectory) : resolve(dirname(fileURLToPath(import.meta.url)), '../../../packs')
  // 入口是模型 JSON/命令 JSON：先经 validateArgs + predicateExprProblems 两道校验再收窄类型。
  const perform = async (raw: unknown, parent: Partial<ToolExecution>): Promise<TaskCheckResult> => {
    const errors = validateArgs(parameters, { input: raw })
    if (errors.length) throw new ToolArgsError(errors)
    const input = raw as SimTaskCheckInput
    const problems = predicateExprProblems(input.predicates)
    if (problems.length) throw new Error(`TASK_CHECK_PREDICATE_INVALID: ${problems.join('；')}`)
    const sim = simWorldsFor(ctx, parent.agent)
    const world = (await sim.listWorlds()).find(entry => entry.worldId === input.worldId)
    if (!world) throw new Error('TASK_CHECK_WORLD_REQUIRED: 先为当前Scene调用sim_open，再传worldId和expectedGeneration')
    if (world.worldGeneration !== input.expectedGeneration) throw new Error('TASK_CHECK_STALE_GENERATION: world已换代，请重新观察后再判定')
    const robots = await describeReachableRobots(sim, input.worldId, input.predicates)
    if (input.checkSpec !== false) {
      // 声明期门：场景服务不可用/快照失败时如实降级为仅帧级门，不把服务缺失变成世界错误。
      try {
        const snapshot = await sceneOperationsFor(ctx, parent.agent, '任务谓词 spec 门').scene.snapshot(world.sceneId)
        const rejected = checkSpecGate(input.predicates, specFrameOf(world.worldId, world.worldGeneration, snapshot.entities), { robots }, 'declared')
        if (rejected) return rejected
      } catch { /* 无场景服务时 spec 门在观察帧上照常执行 */ }
    }
    const frame = await sim.observe(input.worldId, { contacts: true, sensors: true })
    if (frame.generation !== input.expectedGeneration) throw new Error('TASK_CHECK_STALE_OBSERVATION: 观察帧代次与请求不一致')
    if (input.checkSpec !== false) {
      const rejected = checkSpecGate(input.predicates, frame, { robots })
      if (rejected) return rejected
    }
    const verdict = evaluatePredicate(input.predicates, frame, { robots })
    let matchedSkills: TaskCheckResult['matchedSkills']
    if (!verdict.ok && verdict.failures.length) {
      const codes = new Set<string>(verdict.failures.map(f => f.reasonCode))
      const packs = await listSkills(packsRoot).catch(() => [])
      const hits = packs.flatMap(p => p.skills).filter(s => s.proposal.failureSignature.reasonCodes.some(c => codes.has(c)))
      if (hits.length) {
        matchedSkills = hits.map(s => ({
          packId: s.proposal.packId,
          skillId: s.proposal.skillId,
          fixStrategy: s.proposal.fixStrategy,
          reasonCodes: s.proposal.failureSignature.reasonCodes,
        }))
      }
    }
    return {
      taskAchieved: verdict.ok, evaluated: true, failed: verdict.failures, frameId: frame.frameId, stepIndex: frame.stepIndex,
      ...(matchedSkills ? { matchedSkills } : {}),
    }
  }
  ctx.tools.register(compatibleToolInput(defineTool({
    name: 'sim_task_check', description, parameters,
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => JSON.parse(JSON.stringify(await perform(args.input, exec))),
  })))
  ctx.commands.register({
    name: 'sim_task_check', description, input: { hint: 'worldId/expectedGeneration/predicates JSON' },
    handler: async invocation => {
      try {
        const parsed = JSON.parse(invocation.rawInput)
        if (typeof ctx.tools?.execute === 'function') {
          const result = await ctx.tools.execute({
            name: 'sim_task_check',
            arguments: { input: parsed },
            callId: `sim-task-check-cmd-${Date.now()}` as never,
            ...(invocation.agent !== undefined ? { agent: invocation.agent as never } : {}),
            signal: invocation.signal ?? new AbortController().signal,
          })
          const text = result.content.filter(b => b.type === 'text').map(b => (b as { text?: string }).text ?? '').join('\n')
          return { kind: result.isError ? 'error' : 'success', text: text || JSON.stringify(result.value) }
        }
        return { kind: 'success', text: JSON.stringify(await perform(parsed, { agent: invocation.agent })) }
      } catch (error) { return { kind: 'error', text: String(error) } }
    },
  })
  // L1 谓词下沉：单步动作携带可选 `predicates` 时，在动作完成后自动对当前帧求值并写回真实 taskAchieved/reason/taskCheck。
  const ACTION_TOOLS = new Set(['robot_move', 'joint_move', 'vehicle_drive', 'robot_gripper', 'robot_walk', 'sim_execute_batch'])
  ctx.on('tools/execute', async (exec, next) => {
    if (!ACTION_TOOLS.has(exec.name)) return next()
    const rawArgs = exec.arguments as { input?: Record<string, unknown>; predicates?: unknown; worldId?: unknown; action?: unknown } | undefined
    const input = (rawArgs?.input && typeof rawArgs.input === 'object' ? rawArgs.input : rawArgs) as { worldId?: string; action?: { expectedGeneration?: number }; predicates?: PredicateExpr } | undefined
    if (input?.predicates === undefined) return next()
    const problems = predicateExprProblems(input.predicates)
    if (problems.length) throw new Error(`TASK_CHECK_PREDICATE_INVALID: ${problems.join('；')}`)
    const result = await next()
    if (result.isError || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)) return result
    const value = result.value as Record<string, unknown>
    if (value.status !== 'completed' || typeof input.worldId !== 'string') return result
    const generation = typeof value.generation === 'number' ? value.generation : input.action?.expectedGeneration
    if (typeof generation !== 'number') return result
    const check = await perform({ worldId: input.worldId, expectedGeneration: generation, predicates: input.predicates, checkSpec: false }, exec)
    const enriched = {
      ...value,
      taskAchieved: check.taskAchieved,
      ...(!check.taskAchieved && check.failed.length ? { reason: check.failed.map(f => f.reasonCode).join(',') } : {}),
      taskCheck: check,
    }
    return { ...result, value: enriched, content: [{ type: 'text', text: JSON.stringify(enriched) }] }
  })
}
