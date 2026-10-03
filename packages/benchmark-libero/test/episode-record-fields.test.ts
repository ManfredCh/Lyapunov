/**
 * N50 / DEV-023：episode 记录的**终止原因**与动作回执字段（协议替身，不是 SDK 实跑）。
 *
 * 证据边界：本文件用 `createProtocolDouble`（协议替身）执行，**不是真实 LIBERO SDK 实测**；
 * 真实逐 task×seed 的读数在回执 `bugfixHistory/DEV023-BENCHMARK-TASKS-20260922.md` 与其驱动日志里。
 * 这里钉的是从真机发现的一个记录缺口：`status` 只有 timeout 一档，"官方 horizon 走完"与"产品 agent
 * 预算耗尽"的 status 相同（真机读数：task0/seed2 在 300/1000 步被产品预算截断，却报 status=timeout）。
 * 所以 episode 记录必须显式带出 `terminationReason`，动作回执必须带出 `effect`（reward/done/判定来源）
 * 与 `reason` —— 否则调用方无法按 DEV-023 的要求逐 episode 保留终止原因。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { BenchmarkAdapter } from '../src/operations.ts'
import { createProtocolDouble, type OfficialProtocol } from '../src/protocol.ts'

const SUITE = 'libero_object'
const TASK_INDEX = 0
const VALUES = [0, 0, 0, 0, 0, 0, 1]

const adapters: BenchmarkAdapter[] = []
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.dispose().catch(() => undefined)
})

async function loadedWorld(options: { protocol?: OfficialProtocol; horizon?: number; succeedWhen?: (stepIndex: number, action: number[]) => boolean; agentStepBudget?: number } = {}) {
  const adapter = new BenchmarkAdapter({
    protocol: options.protocol ?? createProtocolDouble({ horizon: options.horizon, succeedWhen: options.succeedWhen }),
    ...(options.agentStepBudget === undefined ? {} : { agentStepBudget: options.agentStepBudget }),
  })
  adapters.push(adapter)
  const world = await adapter.load({ suite: SUITE, taskIndex: TASK_INDEX })
  if (!('worldId' in world)) throw new Error(`benchmark 载入未就绪: ${JSON.stringify(world)}`)
  return { adapter, world, base: { worldId: world.worldId, expectedGeneration: world.worldGeneration, values: [...VALUES] } }
}

describe('episode 记录的终止原因与动作回执字段', () => {
  test('官方 horizon 走完：status=timeout + terminationReason=horizon，回执带 reward/done/判定来源', async () => {
    const { adapter, world, base } = await loadedWorld({ horizon: 4 })
    const receipt = await adapter.step({ ...base, actionId: 'to-horizon', stepCount: 4 })
    expect(receipt.effect?.benchmarkStatus).toBe('timeout')
    expect(receipt.effect?.reward).toBe(0)
    // `done` 的取值由官方 env 决定：真机零动作 horizon 走完时是 false（终止来自 step_index>=horizon），
    // 协议替身在 horizon 处给 true —— 记录必须**带出**这个字段，取值不在此钉。
    expect(typeof receipt.effect?.done).toBe('boolean')
    expect(receipt.effect?.evaluator).toBe('official-env.check_success')
    expect(receipt.reason).toBe('horizon')
    const result = adapter.result({ worldId: world.worldId })
    expect(result.status).toBe('timeout')
    expect(result.success).toBe(false)
    expect(result.episode.terminationReason).toBe('horizon')
    expect(result.episode.stepIndex).toBe(4)
    // horizonSteps 报的是**任务目录声明的**官方 horizon（libero_object=1000），不是替身 env 自己的 horizon；
    // 真机上两者一致（零动作 episode 恰好停在被声明的 horizon 上），此处只钉"记录带了声明值"。
    expect(result.episode.horizonSteps).toBeGreaterThan(0)
  })

  test('官方成功：terminationReason=check_success，且 success 只来自官方判定', async () => {
    const { adapter, world, base } = await loadedWorld({ horizon: 10, succeedWhen: step => step === 1 })
    await adapter.step({ ...base, actionId: 'succeed', stepCount: 1 })
    const result = adapter.result({ worldId: world.worldId })
    expect(result.status).toBe('success')
    expect(result.success).toBe(true)
    expect(result.episode.terminationReason).toBe('check_success')
    expect(result.episode.stepIndex).toBe(1)
    expect(result.episode.stepIndex).toBeLessThan(result.episode.horizonSteps)
  })

  test('产品 agent 预算耗尽：status 仍是 timeout，但 terminationReason 明确是 agent-budget（不与官方 horizon 混为一谈）', async () => {
    const { adapter, world, base } = await loadedWorld({ horizon: 10, agentStepBudget: 3 })
    await adapter.step({ ...base, actionId: 'to-budget', stepCount: 10 })
    const result = adapter.result({ worldId: world.worldId })
    expect(result.status).toBe('timeout')
    expect(result.episode.terminationReason).toBe('agent-budget')
    // 官方 horizon 没到：这正是必须区分两者的原因
    expect(result.episode.stepIndex).toBe(3)
    expect(result.episode.stepIndex).toBeLessThan(result.episode.horizonSteps)
    const last = result.receipts.at(-1)
    expect(last?.reason).toBe('agent-budget')
    expect(last?.effect?.budget).toEqual({ kind: 'agentStepBudget', limit: 3 })
  })

  test('还在跑：status=running 且不出现 terminationReason（终态才有）', async () => {
    const { adapter, world, base } = await loadedWorld({ horizon: 10 })
    await adapter.step({ ...base, actionId: 'one-step', stepCount: 1 })
    const result = adapter.result({ worldId: world.worldId })
    expect(result.status).toBe('running')
    expect(result.episode.terminationReason).toBeUndefined()
    expect(result.success).toBe(false)
  })

  // DEV-023「每 episode 保留 observation/action/reward/终止/官方判定」里的 **action** 一格：
  // 回执此前只带 actionId 与步数，事后从记录答不出"这一步实际发了什么"。
  test('动作回执带出实际下发的控制向量（appliedControl.first/last/steps）', async () => {
    const { adapter, world, base } = await loadedWorld({ horizon: 10 })
    const values = [0.25, -0.5, 0, 0, 0, 0, 1]
    const receipt = await adapter.step({ ...base, values, actionId: 'applied-control', stepCount: 3 })
    expect(receipt.effect?.appliedControl).toEqual({ kind: 'control', first: values, last: values, steps: 3 })
    const result = adapter.result({ worldId: world.worldId })
    expect(result.receipts[0]?.effect?.appliedControl).toEqual({ kind: 'control', first: values, last: values, steps: 3 })
  })

  // 套件级路径（bench_run_suite）此前只回 taskId/status/stepIndex/success/evaluator，
  // 五件事实里只剩"官方判定"一件；这里把五件都钉住。
  test('套件级路径逐 episode 保留 observation/action/reward/终止/官方判定', async () => {
    const adapter = new BenchmarkAdapter({ protocol: createProtocolDouble({ horizon: 2 }) })
    adapters.push(adapter)
    const suite = await adapter.runSuite({ suite: SUITE }) as unknown as { tasks: Array<Record<string, any>> }
    expect(suite.tasks.length).toBeGreaterThan(0)
    const first = suite.tasks[0]!
    expect(typeof first.seed).toBe('number')
    expect(first.terminationReason).toBe('horizon')
    expect(first.observation.source).toBe('official-env')
    expect(Array.isArray(first.observation.fields)).toBe(true)
    expect(first.observation.fields.length).toBeGreaterThan(0)
    expect(first.actions[0].appliedControl.steps).toBe(2)
    expect(first.actions[0].appliedControl.first.length).toBe(first.actions[0].appliedControl.last.length)
    expect(first.actions[0].appliedControl.kind).toBe('control')
    expect(first.rewards[0].reward).toBe(0)
    expect(first.rewards[0].benchmarkStatus).toBe('timeout')
    expect(first.officialJudgement).toEqual({ evaluator: 'official-env.check_success', success: false, status: 'timeout' })
    expect(first.success).toBe(false)
    expect(first.evaluator).toBe('official-env.check_success')
  })
})
