/**
 * DEV-033 真实 LIBERO SDK worker 的边界冒烟驱动（手工运行，不是 `bun test` 用例）。
 *
 * 用途：在**真实**隔离 SDK / worker 上重放适配器的三条边界（提交前续接拒绝、重复 actionId、
 * 取消后 fail-closed）。它不注入任何解题动作、不修改 SDK、不声称任务成功；观测图写到
 * /tmp 下的运行目录，不写 `.runtime`。
 *
 * 运行：export PATH="$HOME/.bun/bin:$PATH"; cd /home/s18/WS/Lyapunov/Dev && bun packages/benchmark-libero/test/real-sdk-boundaries.smoke.ts
 * 未安装隔离 SDK 时 `prepare` 返回 BLOCKED，本驱动如实打印并退出 2。
 */
import { BenchmarkAdapter } from '../src/operations.ts'
import { SimError } from '../../sim-contract/src/index.ts'

const code = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise } catch (error) { return error instanceof SimError ? `${error.code}: ${error.message}` : `NOT_SIM_ERROR: ${String(error)}` }
  return 'NO_ERROR'
}
const log = (label: string, value: unknown) => console.log(`${label} => ${JSON.stringify(value)}`)

const adapter = new BenchmarkAdapter({ outputRoot: '/tmp/dev033-libero-runs' })
try {
  log('prepare', await adapter.prepare())
  const loaded = await adapter.load({ suite: 'libero_object', taskIndex: 0, seed: 0 })
  if (!('worldId' in loaded)) { log('load.BLOCKED', loaded); process.exit(2) }
  log('load', { worldId: loaded.worldId, generation: loaded.worldGeneration, engineVersion: loaded.engineVersion, projection: (loaded.projection as { status?: string } | undefined)?.status })
  const base = { worldId: loaded.worldId, expectedGeneration: loaded.worldGeneration, values: [0, 0, 0, 0, 0, 0, 1] }

  log('early-continuation', await code(adapter.step({ ...base, actionId: 'real-early', continueAfterSuccess: true })))

  const first = await adapter.step({ ...base, actionId: 'real-a', stepCount: 2 })
  log('step.real-a', { status: first.status, startStep: first.startStep, endStep: first.endStep, taskAchieved: first.taskAchieved, benchmarkStatus: first.effect?.benchmarkStatus, evaluator: first.effect?.evaluator })

  const retry = await adapter.step({ ...base, actionId: 'real-a', stepCount: 2 })
  log('step.real-a-retry', { endStep: retry.endStep, sameAsFirst: JSON.stringify(retry) === JSON.stringify(first), stepIndex: adapter.result({ worldId: loaded.worldId }).episode.stepIndex })

  log('step.real-a-conflict', await code(adapter.step({ ...base, actionId: 'real-a', stepCount: 3 })))

  const second = await adapter.step({ ...base, actionId: 'real-b', stepCount: 3 })
  log('step.real-b', { status: second.status, startStep: second.startStep, endStep: second.endStep, benchmarkStatus: second.effect?.benchmarkStatus })

  const stopped = await adapter.stop(loaded.worldId, { expectedGeneration: loaded.worldGeneration, actionId: 'real-b' })
  log('stop', { stopped: stopped.stopped, stepIndex: stopped.stepIndex, status: adapter.result({ worldId: loaded.worldId }).status })

  log('continuation-after-stop', await code(adapter.step({ ...base, actionId: 'real-after-stop', continueAfterSuccess: true })))
  log('plain-after-stop', await code(adapter.step({ ...base, actionId: 'real-plain-after-stop' })))

  const snapshot = adapter.result({ worldId: loaded.worldId })
  log('result', {
    status: snapshot.status,
    success: snapshot.success,
    firstSuccess: snapshot.firstSuccess,
    stepIndex: snapshot.episode.stepIndex,
    receipts: snapshot.receipts.map(receipt => ({ actionId: receipt.actionId, status: receipt.status, endStep: receipt.endStep, benchmarkStatus: receipt.effect?.benchmarkStatus })),
  })
  await adapter.close(loaded.worldId)
  log('close', 'ok')
} finally {
  await adapter.dispose()
}
