/**
 * DEV-033 边界回归：官方成功后的默认终态拒绝、显式续接、重复 actionId 与取消。
 *
 * 证据边界（不得当成 SDK 实测）：
 * - 本文件通过 `createProtocolDouble`（协议替身）执行，**不是真实 LIBERO SDK 实跑**；
 *   真实"放入→松手→重抓→取出"流程未在本轮验收，见回执未覆盖项。
 * - 替身覆盖适配器的门（默认终态／续接／指纹／取消／horizon／产品预算）与替身 env 的步进；
 *   它不覆盖 worker.py 的 IPC、真实 SDK 的 check_success、渲染与任何抓取物理。
 * - 唯一的非官方替身是"provider 回执不自洽"用例里的 transport 桩：只替换 IPC 边界，
 *   被验证的门（BENCHMARK_CONTINUATION_REQUIRES_SUCCESS／BENCHMARK_EPISODE_TERMINAL）仍在
 *   BenchmarkAdapter 内真实执行。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { BenchmarkAdapter } from '../src/operations.ts'
import { createProtocolDouble, type OfficialEnv, type OfficialProtocol } from '../src/protocol.ts'
import { SimError } from '../../sim-contract/src/index.ts'

const SUITE = 'libero_object'
const TASK_INDEX = 0
/** libero_object 的控制维度为 7；值本身不参与判定，判定只看替身 env 的 checkSuccess。 */
const VALUES = [0, 0, 0, 0, 0, 0, 1]

const adapters: BenchmarkAdapter[] = []
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.dispose().catch(() => undefined)
})

/** 失败时的结构化错误码；成功返回 NO_ERROR，非 SimError 原样带出，避免把"抛了别的错"当成通过。 */
async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof SimError ? error.code : `NOT_SIM_ERROR: ${String(error)}`
  }
  return 'NO_ERROR'
}

async function loadedWorld(options: { protocol?: OfficialProtocol; horizon?: number; succeedWhen?: (stepIndex: number, action: number[]) => boolean; agentStepBudget?: number } = {}) {
  const adapter = new BenchmarkAdapter({
    protocol: options.protocol ?? createProtocolDouble({ horizon: options.horizon, succeedWhen: options.succeedWhen }),
    ...(options.agentStepBudget === undefined ? {} : { agentStepBudget: options.agentStepBudget }),
  })
  adapters.push(adapter)
  const world = await adapter.load({ suite: SUITE, taskIndex: TASK_INDEX })
  if (!('worldId' in world)) throw new Error(`benchmark 载入未就绪: ${JSON.stringify(world)}`)
  const base = { worldId: world.worldId, expectedGeneration: world.worldGeneration, values: [...VALUES] }
  return { adapter, world, base }
}

describe('成功后默认终态与首次成功保留', () => {
  test('首次官方成功：默认拒绝新动作，首次回执与 firstSuccess 保留，重复 actionId 不重复推进', async () => {
    const { adapter, world, base } = await loadedWorld({ horizon: 10, succeedWhen: step => step === 1 })
    const first = await adapter.step({ ...base, actionId: 'first', stepCount: 3 })
    expect(first.endStep).toBe(1)
    expect(first.taskAchieved).toBe(true)
    expect(first.effect?.benchmarkStatus).toBe('success')

    const afterSuccess = adapter.result({ worldId: world.worldId })
    expect(afterSuccess.status).toBe('success')
    expect(afterSuccess.success).toBe(true)
    expect(afterSuccess.firstSuccess?.stepIndex).toBe(1)

    // 默认终态：不声明续接的新 actionId 必须被拒绝。
    expect(await errorCode(adapter.step({ ...base, actionId: 'plain-after-success' }))).toBe('BENCHMARK_EPISODE_TERMINAL')
    // 相同 actionId + 相同请求 = 重试，返回同一回执且不重复推进官方物理。
    expect(await adapter.step({ ...base, actionId: 'first', stepCount: 3 })).toEqual(first)
    expect(adapter.result({ worldId: world.worldId }).episode.stepIndex).toBe(1)
    // 相同 actionId + 改参 = 冲突，不得拿旧回执冒充新动作。
    expect(await errorCode(adapter.step({ ...base, actionId: 'first', stepCount: 2 }))).toBe('ACTION_ID_CONFLICT')
    expect(await errorCode(adapter.step({ ...base, actionId: 'first', stepCount: 3, values: [1, 0, 0, 0, 0, 0, 1] }))).toBe('ACTION_ID_CONFLICT')
  })

  test('显式续接带 continuedInteraction；首次成功回执不被续接覆盖', async () => {
    const { adapter, world, base } = await loadedWorld({ horizon: 10, succeedWhen: step => step === 1 })
    const first = await adapter.step({ ...base, actionId: 'first', stepCount: 3 })
    const continued = await adapter.step({ ...base, actionId: 'take', stepCount: 2, continueAfterSuccess: true })
    expect(continued.endStep).toBe(3)
    expect(continued.taskAchieved).toBe(false)
    expect(continued.effect?.continuedInteraction).toBe(true)
    expect(continued.effect?.benchmarkStatus).toBe('running')

    const now = adapter.result({ worldId: world.worldId })
    // 当前 evaluator 已不满足成功条件，但首次官方成功是一次性事实，不被后续交互覆盖。
    expect(now.status).toBe('running')
    expect(now.success).toBe(false)
    expect(now.firstSuccess?.stepIndex).toBe(1)
    expect(now.receipts.find(receipt => receipt.actionId === 'first')).toEqual(first)
    expect(await adapter.receipt(world.worldId, 'first')).toEqual(first)
  })

  test('续接后的第二次成功不改写 firstSuccess，且该动作仍是续接动作', async () => {
    const { adapter, world, base } = await loadedWorld({ horizon: 10, succeedWhen: step => step === 1 || step === 3 })
    const first = await adapter.step({ ...base, actionId: 'first', stepCount: 3 })
    const regrasp = await adapter.step({ ...base, actionId: 'regrasp', stepCount: 2, continueAfterSuccess: true })
    expect(regrasp.endStep).toBe(3)
    expect(regrasp.taskAchieved).toBe(true)
    expect(regrasp.effect?.continuedInteraction).toBe(true)

    const snapshot = adapter.result({ worldId: world.worldId })
    expect(snapshot.firstSuccess?.stepIndex).toBe(1)
    expect(snapshot.receipts.find(receipt => receipt.actionId === 'first')).toEqual(first)
  })

  test('未成功前的续接被拒绝，且不推进官方物理', async () => {
    const { adapter, world, base } = await loadedWorld({ horizon: 10, succeedWhen: () => false })
    expect(await errorCode(adapter.step({ ...base, actionId: 'early', continueAfterSuccess: true }))).toBe('BENCHMARK_CONTINUATION_REQUIRES_SUCCESS')
    const snapshot = adapter.result({ worldId: world.worldId })
    expect(snapshot.episode.stepIndex).toBe(0)
    expect(snapshot.receipts.length).toBe(0)
  })

  test('provider 回执自称 success 却没有官方成功：默认拒绝，且不得凭空开续接通路', async () => {
    const { adapter, world, base } = await loadedWorld({ horizon: 10, succeedWhen: () => false })
    const active = (adapter as unknown as { world: { transport: unknown } }).world
    // 只替换 transport（官方 worker 的 IPC 边界）：回执 benchmarkStatus='success' 但 taskAchieved=false，
    // 是真实 worker 不会产出的不自洽回执；适配器必须 fail-closed，而不是把它当成合法的首次成功。
    active.transport = {
      execute: async (_worldId: string, action: { actionId: string }) => ({
        actionId: action.actionId, worldId: world.worldId, generation: world.worldGeneration, status: 'completed',
        startStep: 1, endStep: 1,
        finalState: {
          worldId: world.worldId, generation: world.worldGeneration, sceneRevision: 0, stepIndex: 1, simTime: 0.05,
          frameId: `${world.worldId}:${world.worldGeneration}:1`,
          entities: [{ entityId: 'official-robot', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] } }],
        },
        taskAchieved: false,
        effect: { benchmarkStatus: 'success', evaluator: 'official-env.check_success' },
      }),
      close: async () => undefined,
      dispose: async () => undefined,
    }

    const claimed = await adapter.step({ ...base, actionId: 'claimed-success' })
    expect(claimed.effect?.benchmarkStatus).toBe('success')
    const snapshot = adapter.result({ worldId: world.worldId })
    expect(snapshot.status).toBe('success')
    expect(snapshot.firstSuccess).toBeUndefined()
    expect(await errorCode(adapter.step({ ...base, actionId: 'claimed-cont', continueAfterSuccess: true }))).toBe('BENCHMARK_CONTINUATION_REQUIRES_SUCCESS')
    expect(await errorCode(adapter.step({ ...base, actionId: 'claimed-plain' }))).toBe('BENCHMARK_EPISODE_TERMINAL')
  })
})

describe('成功后 status 回落后仍必须默认拒绝', () => {
  test('续接把 status 降回 running 后，未声明续接的普通动作仍被拒绝', async () => {
    const { adapter, world, base } = await loadedWorld({ horizon: 10, succeedWhen: step => step === 1 })
    await adapter.step({ ...base, actionId: 'first', stepCount: 3 })
    const continued = await adapter.step({ ...base, actionId: 'take', stepCount: 2, continueAfterSuccess: true })
    expect(continued.effect?.benchmarkStatus).toBe('running')
    expect(adapter.result({ worldId: world.worldId }).status).toBe('running')

    // 关键边界：官方成功已发生且 firstSuccess 仍在，普通动作不得因为 status 回落而被重新放行。
    expect(await errorCode(adapter.step({ ...base, actionId: 'bypass-plain' }))).toBe('BENCHMARK_EPISODE_TERMINAL')
    expect(adapter.result({ worldId: world.worldId }).episode.stepIndex).toBe(3)
    // 面板直控没有续接通道，同样不得在成功后重新放开。
    expect(await errorCode(adapter.execute(world.worldId, {
      actionId: 'panel-gripper', expectedGeneration: world.worldGeneration, kind: 'gripper', entityId: 'official-robot', widthM: 0.08, durationS: 0.1,
    }))).toBe('BENCHMARK_EPISODE_TERMINAL')
    // 显式续接仍然允许：边界只收紧未声明的通路。
    const again = await adapter.step({ ...base, actionId: 'take-more', stepCount: 1, continueAfterSuccess: true })
    expect(again.effect?.continuedInteraction).toBe(true)
    expect(again.endStep).toBe(4)
  })
})

describe('重复 actionId 指纹', () => {
  test('同一 actionId 的续接重试幂等；翻转 continueAfterSuccess 属于改参冲突', async () => {
    const { adapter, world, base } = await loadedWorld({ horizon: 10, succeedWhen: step => step === 1 })
    await adapter.step({ ...base, actionId: 'first', stepCount: 3 })
    const continued = await adapter.step({ ...base, actionId: 'take', stepCount: 2, continueAfterSuccess: true })
    expect(await adapter.step({ ...base, actionId: 'take', stepCount: 2, continueAfterSuccess: true })).toEqual(continued)
    expect(adapter.result({ worldId: world.worldId }).episode.stepIndex).toBe(3)
    expect(await errorCode(adapter.step({ ...base, actionId: 'take', stepCount: 2, continueAfterSuccess: false }))).toBe('ACTION_ID_CONFLICT')
    expect(await errorCode(adapter.step({ ...base, actionId: 'take', stepCount: 2 }))).toBe('ACTION_ID_CONFLICT')
  })

  test('并发同 ID 同请求只推进一次', async () => {
    const { adapter, base } = await loadedWorld({ horizon: 10, succeedWhen: () => false })
    const [left, right] = await Promise.all([
      adapter.step({ ...base, actionId: 'same', stepCount: 2 }),
      adapter.step({ ...base, actionId: 'same', stepCount: 2 }),
    ])
    expect(left).toEqual(right)
    expect(left.endStep).toBe(2)
    expect(adapter.result({ worldId: base.worldId }).episode.stepIndex).toBe(2)
  })
})

describe('取消必须结束', () => {
  test('stop() 之后的续接与普通动作都被拒绝', async () => {
    const { adapter, world, base } = await loadedWorld({ horizon: 10, succeedWhen: step => step === 1 })
    await adapter.step({ ...base, actionId: 'first', stepCount: 3 })
    const continued = await adapter.step({ ...base, actionId: 'take', stepCount: 1, continueAfterSuccess: true })
    expect(continued.effect?.continuedInteraction).toBe(true)

    await adapter.stop(world.worldId, { expectedGeneration: world.worldGeneration, actionId: 'take' })
    const stopped = adapter.result({ worldId: world.worldId })
    expect(stopped.status).toBe('cancelled')
    expect(stopped.firstSuccess?.stepIndex).toBe(1)
    expect(await errorCode(adapter.step({ ...base, actionId: 'after-stop', continueAfterSuccess: true }))).toBe('BENCHMARK_EPISODE_TERMINAL')
    expect(await errorCode(adapter.step({ ...base, actionId: 'after-stop-plain' }))).toBe('BENCHMARK_EPISODE_TERMINAL')
  })

  test('提交前已取消：CANCELLED、不推进、不落回执，且不篡改已发生的官方成功', async () => {
    const { adapter, world, base } = await loadedWorld({ horizon: 10, succeedWhen: step => step === 1 })
    await adapter.step({ ...base, actionId: 'first', stepCount: 3 })
    const controller = new AbortController()
    controller.abort()
    expect(await errorCode(adapter.step({ ...base, actionId: 'aborted', continueAfterSuccess: true }, controller.signal))).toBe('CANCELLED')
    const snapshot = adapter.result({ worldId: world.worldId })
    expect(snapshot.episode.stepIndex).toBe(1)
    expect(snapshot.receipts.some(receipt => receipt.actionId === 'aborted')).toBe(false)
    expect(snapshot.status).toBe('success')
    // 未提交的取消不是一次执行事实：之后的显式续接仍合法。
    const later = await adapter.step({ ...base, actionId: 'later', stepCount: 1, continueAfterSuccess: true })
    expect(later.effect?.continuedInteraction).toBe(true)
  })

  test('批次执行中被取消：在步边界停下、episode 转 cancelled、后续动作 fail-closed', async () => {
    const controller = new AbortController()
    let stepped = 0
    const inner = createProtocolDouble({ horizon: 100, succeedWhen: () => false })
    const protocol: OfficialProtocol = {
      createEnv(input) {
        const env = inner.createEnv(input)
        return {
          ...env,
          step(action: number[]) {
            const result = env.step(action)
            stepped += 1
            // 模拟取消在一次 env.step 期间到达：剩余步数必须在下一个边界停下。
            if (stepped === 2) controller.abort()
            return result
          },
        } satisfies OfficialEnv
      },
    }
    const { adapter, world, base } = await loadedWorld({ protocol })
    const receipt = await adapter.step({ ...base, actionId: 'long', stepCount: 10 }, controller.signal)
    expect(stepped).toBe(2)
    expect(receipt.endStep).toBe(2)
    expect(receipt.status).toBe('cancelled')
    expect(receipt.effect?.benchmarkStatus).toBe('cancelled')
    expect(adapter.result({ worldId: world.worldId }).episode.status).toBe('cancelled')
    expect(await errorCode(adapter.step({ ...base, actionId: 'after-cancel', continueAfterSuccess: true }))).toBe('BENCHMARK_EPISODE_TERMINAL')
  })
})

describe('续接不绕过 horizon 与产品步数预算', () => {
  test('horizon：续接在 horizon 处转 timeout，之后不再接受任何动作', async () => {
    const { adapter, world, base } = await loadedWorld({ horizon: 4, succeedWhen: step => step === 1 })
    await adapter.step({ ...base, actionId: 'first', stepCount: 3 })
    const continued = await adapter.step({ ...base, actionId: 'take', stepCount: 10, continueAfterSuccess: true })
    expect(continued.endStep).toBe(4)
    expect(continued.effect?.benchmarkStatus).toBe('timeout')
    expect(adapter.result({ worldId: world.worldId }).status).toBe('timeout')
    expect(await errorCode(adapter.step({ ...base, actionId: 'past-horizon', continueAfterSuccess: true }))).toBe('BENCHMARK_EPISODE_TERMINAL')
  })

  test('agentStepBudget：续接被截断在预算处并报 agent-budget，之后拒绝', async () => {
    const { adapter, world, base } = await loadedWorld({ horizon: 10, succeedWhen: step => step === 1, agentStepBudget: 3 })
    await adapter.step({ ...base, actionId: 'first', stepCount: 3 })
    const continued = await adapter.step({ ...base, actionId: 'take', stepCount: 5, continueAfterSuccess: true })
    expect(continued.endStep).toBe(3)
    expect(continued.reason).toBe('agent-budget')
    expect(continued.effect?.benchmarkStatus).toBe('timeout')
    expect(adapter.result({ worldId: world.worldId }).status).toBe('timeout')
    expect(await errorCode(adapter.step({ ...base, actionId: 'over-budget', continueAfterSuccess: true }))).toBe('BENCHMARK_EPISODE_TERMINAL')
  })
})
