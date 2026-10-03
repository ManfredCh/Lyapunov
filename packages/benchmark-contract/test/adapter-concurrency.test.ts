/**
 * DEV-018 残留小口：benchmark 两包共用的「并发 load 串行 + 释放只跑一次」规则。
 *
 * 本文件钉两件事：
 *   ① 规则本身的行为（顺序、失败不钉死队列、pending 语义、disposeOnce 单飞）；
 *   ② 结构：这条规则在全仓 benchmark 侧**只有一处实现**（共享模块），两包适配器不再内联。
 *      ② 是"合并被还原 ⇒ 精确变红"的那一半（同 P7 对 `persist` 的做法）。
 *
 * 负对照（真实执行，读数见 `bugfixHistory/DEV018-RESIDUAL-20260926.md` §4）：把共享模块
 * 改坏（去掉 `?>=` 单飞 / 不释放 turn / 直通 body）本文件立刻红。
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AdapterConcurrency } from '../src/adapter-concurrency.ts'

const DEV_ROOT = resolve(import.meta.dir, '../../..')
const LIBERO_SOURCE = 'packages/benchmark-libero/src/operations.ts'
const GYMNASIUM_SOURCE = 'packages/benchmark-gymnasium/src/adapter.ts'
const SHARED_SOURCE = 'packages/benchmark-contract/src/adapter-concurrency.ts'
const readSource = (relative: string) => readFileSync(resolve(DEV_ROOT, relative), 'utf8')

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('串行队列：后进入的 body 必须等前一个交回 turn 才开始，且按调用顺序', async () => {
  const gate = new AdapterConcurrency()
  const first = deferred<void>()
  const order: string[] = []
  const a = gate.serialize(async () => { order.push('a:enter'); await first.promise; order.push('a:exit') })
  const b = gate.serialize(async () => { order.push('b:enter') })
  await tick()
  expect(order).toEqual(['a:enter'])          // 串行：b 不得与 a 并存
  first.resolve()
  await Promise.all([a, b])
  expect(order).toEqual(['a:enter', 'a:exit', 'b:enter'])  // 顺序：先来的先进
})

test('前一个 body 失败不吃掉队列：后续 body 照常进入', async () => {
  const gate = new AdapterConcurrency()
  const ran: string[] = []
  const failed = gate.serialize(async () => { ran.push('a'); throw new Error('DEV018_BOOM') })
  const next = gate.serialize(async () => { ran.push('b'); return 'ok' })
  await expect(failed).rejects.toThrow('DEV018_BOOM')
  expect(await next).toBe('ok')
  expect(ran).toEqual(['a', 'b'])
})

test('pending 指向队列尾：在途 turn 未交回前不 resolve，交回后 resolve', async () => {
  const gate = new AdapterConcurrency()
  const hold = deferred<void>()
  let pendingSettled = false
  const running = gate.serialize(async () => { await hold.promise })
  void gate.pending.then(() => { pendingSettled = true })
  await tick()
  expect(pendingSettled).toBe(false)
  hold.resolve()
  await running
  await gate.pending
  expect(pendingSettled).toBe(true)
})

test('disposeOnce：并发/重复调用只跑一次 teardown，后来的 teardown 不被执行', async () => {
  const gate = new AdapterConcurrency()
  let teardowns = 0
  const teardown = async () => { teardowns++ }
  await Promise.all([gate.disposeOnce(teardown), gate.disposeOnce(teardown), gate.disposeOnce(teardown)])
  await gate.disposeOnce(teardown)
  expect(teardowns).toBe(1)
})

test('DEV-018 结构：串行队列/释放只跑一次只有共享模块一处实现，两包适配器不再内联', () => {
  const report = {
    // 队列尾拼接（`loadQueue = previous.catch(...).then(() => turn)`）出现在哪些文件
    queueImplementations: [LIBERO_SOURCE, GYMNASIUM_SOURCE, SHARED_SOURCE]
      .filter(path => readSource(path).includes('loadQueue = previous.catch(() => undefined).then(() => turn)')),
    // 两包适配器里任何内联的队列字段 / 内联单飞都应该 0 处
    inlined: [LIBERO_SOURCE, GYMNASIUM_SOURCE]
      .filter(path => /loadQueue|disposal\s*\?\?=/.test(readSource(path))),
    // 两包适配器都必须真的走共享模块（串行 + 单飞 + teardown 等在途 load）
    notRouted: [LIBERO_SOURCE, GYMNASIUM_SOURCE].filter(path => {
      const source = readSource(path)
      return !(source.includes('this.concurrency.serialize(') && source.includes('this.concurrency.disposeOnce(') && source.includes('await this.concurrency.pending'))
    }),
  }
  expect(report).toEqual({ queueImplementations: [SHARED_SOURCE], inlined: [], notRouted: [] })
})
