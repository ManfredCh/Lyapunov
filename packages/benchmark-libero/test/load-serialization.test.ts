/**
 * DEV-018 残留小口：benchmark-libero 适配器侧对「并发 load 串行 + 释放只跑一次」的接线。
 *
 * 证据边界（如实）：
 * - **没有拉起真 python worker**：需要控制交回 turn 时机的三个用例把公开方法 `prepare()` 换成
 *   返回 BLOCKED 的替身（真 prepare 缺解释器时本来就返回 BLOCKED，形状一致）；**队列、guard、
 *   load 的排队路径、teardown、closeWorld 全部是真实执行**。
 * - 释放单飞那一例走**真实** `protocol` 替身（`createProtocolDouble`，与既有
 *   `continuation-boundaries.test.ts` 同族）：世界与 env 都是真的，只统计官方 env 的 `close()`
 *   次数；不涉及 worker 进程。
 * - 未覆盖：真实 worker 进程泄漏、跨进程竞争（需要 `.runtime/bench` 隔离 Python 与真套件）。
 */
import { afterEach, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { BenchmarkAdapter } from '../src/operations.ts'
import { createProtocolDouble, type OfficialProtocol } from '../src/protocol.ts'
import { SimError } from '../../sim-contract/src/index.ts'
import type { PrepareResult } from '../src/prepare.ts'

const adapters: BenchmarkAdapter[] = []
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.dispose().catch(() => undefined)
})

const none = (message: string): PrepareResult => ({
  status: 'BLOCKED',
  code: 'BENCHMARK_SDK_UNAVAILABLE',
  message,
  pythonPath: '/nonexistent/dev018-python',
  isolatedRoot: '/nonexistent/dev018-root',
})

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await tick()
  }
  throw new Error('DEV018_TIMEOUT: 等待条件未在 200 个宏任务内成立')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof SimError ? error.code : `NOT_SIM_ERROR: ${String(error)}`
  }
  return 'NO_ERROR'
}

function track(adapter: BenchmarkAdapter) {
  adapters.push(adapter)
  return adapter
}

test('并发 load 串行：第二个 load 在第一个交回 turn 之前不进入独占段（按调用顺序放行）', async () => {
  const adapter = track(new BenchmarkAdapter())
  const gates = [deferred<PrepareResult>(), deferred<PrepareResult>()]
  const entered: number[] = []
  adapter.prepare = async () => {
    const index = entered.length
    entered.push(index)
    return gates[index]!.promise
  }

  const first = adapter.load({})
  const second = adapter.load({})
  await waitFor(() => entered.length === 1)
  await tick()
  expect(entered).toEqual([0])                  // 队列在挡：第二个还没进独占段

  gates[0]!.resolve(none('第一个'))
  expect(await first).toMatchObject({ status: 'BLOCKED', message: '第一个' })
  await waitFor(() => entered.length === 2)
  expect(entered).toEqual([0, 1])               // 顺序：先来的先进

  gates[1]!.resolve(none('第二个'))
  expect(await second).toMatchObject({ status: 'BLOCKED', message: '第二个' })
})

test('第一个 load 失败不吃掉队列：后续 load 照常进入独占段', async () => {
  const adapter = track(new BenchmarkAdapter())
  const gate = deferred<PrepareResult>()
  let calls = 0
  adapter.prepare = async () => {
    calls += 1
    if (calls === 1) throw new Error('DEV018_BOOM')
    return gate.promise
  }

  const first = adapter.load({})
  const second = adapter.load({})
  await expect(first).rejects.toThrow('DEV018_BOOM')
  await waitFor(() => calls === 2)              // 队列没被前一次的失败钉死
  gate.resolve(none('第二个'))
  expect(await second).toMatchObject({ status: 'BLOCKED', message: '第二个' })
})

test('dispose 等在途 load 交回 turn：释放不早于真实回收，且释放窗口内的 load fail-closed', async () => {
  const adapter = track(new BenchmarkAdapter())
  const gate = deferred<PrepareResult>()
  let entered = false
  adapter.prepare = async () => { entered = true; return gate.promise }

  const load = adapter.load({})
  await waitFor(() => entered)

  let disposalSettled = false
  const disposal = adapter.dispose().then(() => { disposalSettled = true })
  await tick()
  await tick()
  expect(disposalSettled).toBe(false)           // 在途 load 仍持锁 ⇒ 释放不得先完成

  gate.resolve(none('释放期间'))
  // 释放态下不得 adopt 未完成的世界：guard 在 loadExclusive 内真实执行。
  const failure = await load.catch(error => error)
  expect(failure).toBeInstanceOf(SimError)
  expect((failure as SimError).code).toBe('PROVIDER_CLOSED')

  await disposal
  expect(disposalSettled).toBe(true)
})

test('并发 + 重复 dispose 只跑一次真实回收（官方 env 只被 close 一次）', async () => {
  const inner = createProtocolDouble()
  let envCloses = 0
  const protocol: OfficialProtocol = {
    createEnv: input => {
      const env = inner.createEnv(input)
      // 替身 env 是对象字面量，展开后仅覆盖 close；其余方法仍是同一个真实替身实现。
      return { ...env, close: () => { envCloses += 1; env.close() } }
    },
  }
  const adapter = track(new BenchmarkAdapter({ protocol }))
  const loaded = await adapter.load({ suite: 'libero_object', taskIndex: 0 })
  expect('worldId' in loaded).toBe(true)

  await Promise.all([adapter.dispose(), adapter.dispose(), adapter.dispose()])
  await adapter.dispose()
  expect(envCloses).toBe(1)                     // 释放只跑一次：没有第二次真实回收

  expect(await errorCode(adapter.close((loaded as { worldId: string }).worldId))).toBe('PROVIDER_CLOSED')
})

test('真 prepare 路径（无隔离解释器）⇒ BLOCKED 原样穿过串行队列，不 spawn worker', async () => {
  // 不替换任何方法：pythonPath 不存在 ⇒ prepareIsolatedSdk 在读盘前 fail-closed。
  const adapter = track(new BenchmarkAdapter({ pythonPath: resolve(import.meta.dir, 'no-such-python-dev018'), isolatedRoot: resolve(import.meta.dir, 'no-such-root-dev018') }))
  const loaded = await adapter.load({})
  expect(loaded).toMatchObject({ status: 'BLOCKED', code: 'BENCHMARK_SDK_UNAVAILABLE' })
})
