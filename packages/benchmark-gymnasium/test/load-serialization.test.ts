/**
 * DEV-018 残留小口：benchmark-gymnasium 适配器侧对「并发 load 串行 + 释放只跑一次」的接线。
 *
 * 本文件是该包**第一个**用例（此前 `packages/benchmark-gymnasium` 无 test 目录）。
 *
 * 证据边界（如实）：
 * - gymnasium 适配器**没有** protocol 替身，`load` 的唯一成立路径要 spawn 真 worker ⇒ 需要控制
 *   交回 turn 时机的用例把公开方法 `prepare()` 换成返回 BLOCKED 的替身（真 prepare 缺解释器时
 *   本来就返回 BLOCKED，形状一致）；**队列、guard、load 的排队路径、teardown、closeWorld 全部
 *   真实执行，没有一个 python 进程被拉起**。
 * - "只释放一次"那一例：世界对象是注入的替身（`transport` 只计数），因为不 spawn 就拿不到真世界；
 *   真实执行的是 `teardown` → `closeWorld` → `transport.close/dispose` 这条回收链，计数的是它的
 *   调用次数。
 * - 未覆盖：真 worker 进程、真实 gymnasium[mujoco] env、渲染与评分（需要 `.runtime/bench/gymnasium-env`）。
 */
import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { GymnasiumAntAdapter } from '../src/adapter.ts'
import { SimError } from '../../sim-contract/src/index.ts'
import type { GymnasiumPrepareResult } from '../src/prepare.ts'

const adapters: GymnasiumAntAdapter[] = []
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.dispose().catch(() => undefined)
})

// `prepareGymnasiumSdk` 在读盘前会 mkdir 隔离根 ⇒ 用临时目录，跑完删干净（不往仓里落垃圾）。
const scratchRoots: string[] = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev018-gymnasium-'))
  scratchRoots.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of scratchRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const none = (message: string): GymnasiumPrepareResult => ({
  status: 'BLOCKED',
  code: 'GYMNASIUM_SDK_UNAVAILABLE',
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

function track(adapter: GymnasiumAntAdapter) {
  adapters.push(adapter)
  return adapter
}

test('并发 load 串行：第二个 load 在第一个交回 turn 之前不进入独占段（按调用顺序放行）', async () => {
  const adapter = track(new GymnasiumAntAdapter())
  const gates = [deferred<GymnasiumPrepareResult>(), deferred<GymnasiumPrepareResult>()]
  const entered: number[] = []
  adapter.prepare = async () => {
    const index = entered.length
    entered.push(index)
    return gates[index]!.promise
  }

  const first = adapter.load()
  const second = adapter.load()
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
  const adapter = track(new GymnasiumAntAdapter())
  const gate = deferred<GymnasiumPrepareResult>()
  let calls = 0
  adapter.prepare = async () => {
    calls += 1
    if (calls === 1) throw new Error('DEV018_BOOM')
    return gate.promise
  }

  const first = adapter.load()
  const second = adapter.load()
  await expect(first).rejects.toThrow('DEV018_BOOM')
  await waitFor(() => calls === 2)              // 队列没被前一次的失败钉死
  gate.resolve(none('第二个'))
  expect(await second).toMatchObject({ status: 'BLOCKED', message: '第二个' })
})

test('dispose 等在途 load 交回 turn：释放不早于真实回收，且释放窗口内的 load fail-closed', async () => {
  const adapter = track(new GymnasiumAntAdapter())
  const gate = deferred<GymnasiumPrepareResult>()
  let entered = false
  adapter.prepare = async () => { entered = true; return gate.promise }

  const load = adapter.load()
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

test('并发 + 重复 dispose 只跑一次真实回收（teardown 进入 1 次、transport 回收 1 轮）', async () => {
  const adapter = track(new GymnasiumAntAdapter())
  const recycle = { close: 0, dispose: 0 }
  const realTeardown = (adapter as any).teardown.bind(adapter)
  let teardowns = 0
  ;(adapter as any).teardown = async () => { teardowns += 1; return realTeardown() }
  // 不 spawn 就拿不到真世界：注入最小世界替身，回收链（closeWorld → transport.close/dispose）仍是真实代码。
  ;(adapter as any).world = {
    handle: { worldId: 'dev018-world' },
    transport: {
      close: async () => { recycle.close += 1 },
      dispose: async () => { recycle.dispose += 1 },
    },
  }

  await Promise.all([adapter.dispose(), adapter.dispose(), adapter.dispose()])
  await adapter.dispose()
  expect(teardowns).toBe(1)                     // 释放只跑一次
  expect(recycle).toEqual({ close: 1, dispose: 1 })   // 真实回收也只跑一轮
  expect((adapter as any).world).toBeUndefined()
})

test('真 prepare 路径（无隔离解释器）⇒ BLOCKED 原样穿过串行队列，不 spawn worker', async () => {
  // 不替换任何方法：pythonPath 不存在 ⇒ prepareGymnasiumSdk 在 import gymnasium 之前 fail-closed。
  const adapter = track(new GymnasiumAntAdapter({ pythonPath: join(scratch(), 'no-such-python-dev018'), isolatedRoot: scratch() }))
  const loaded = await adapter.load()
  expect(loaded).toMatchObject({ status: 'BLOCKED', code: 'GYMNASIUM_SDK_UNAVAILABLE' })
})
