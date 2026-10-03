/**
 * DEV-018：benchmark 适配器共用的「并发 load 串行 + 释放只跑一次」规则，唯一一处。
 *
 * 为什么会有这个模块：`benchmark-libero/src/operations.ts` 与 `benchmark-gymnasium/src/adapter.ts`
 * 各抄了一份**逐字相同**的实现（字段 270 B、串行块 748 B、dispose/teardown 正文 370 B，
 * 三处 sha256 分别全等；读数见 `bugfixHistory/DEV018-RESIDUAL-20260926.md` §1）。
 * 两份适配器实现的是同一条与套件无关的不变量，不是"同族不同义"：
 *
 *   · 并发 load 若不串行，两次 open 会先后写适配器的 world，先完成的那次 world/worker
 *     再无人持有（连 dispose 都找不到它）⇒ 进程泄漏；
 *   · 释放若不只跑一次，并发/重复 dispose 会重复回收同一个 worker；
 *   · 释放若不**等在途 load 交回**，首载 open 尚未返回（world 仍 undefined）时 dispose 就先
 *     resolve，"插件卸载等待真实回收"的承诺即不成立。
 *
 * 边界（本模块**不管**的事）：world 的回收、`closeWorld`、释放态 `closed`、guard 的错误码与文案
 * 都留在各适配器自己的 `teardown`/`guard` 里 —— 那部分两包本来就不同义（错误文案、可选 protocol
 * 路径、包内世界结构），本轮一个字没动。
 */
export class AdapterConcurrency {
  /** load 串行队列：并发的 load 不得互相覆盖 world / 丢 worker。 */
  private loadQueue: Promise<void> = Promise.resolve()
  /** 释放流程只跑一次；并发/重复 dispose 共享同一次真实回收。 */
  private disposal?: Promise<void>

  /** 在途 load 的完成点：teardown 必须等它，释放承诺才成立。 */
  get pending(): Promise<void> {
    return this.loadQueue
  }

  /**
   * 串行化 load：并发 load 必须按调用顺序替换世界。
   *
   * `loadQueue` 指向"本次 turn 结束"而非"本次 body 成功"：body 成功或失败都只影响调用方，
   * 不影响队列尾（所以后续 load 不会被前一次的失败钉死）。
   */
  async serialize<T>(body: () => Promise<T>): Promise<T> {
    const previous = this.loadQueue
    let release!: () => void
    const turn = new Promise<void>(resolve => { release = resolve })
    this.loadQueue = previous.catch(() => undefined).then(() => turn)
    await previous.catch(() => undefined)
    try {
      return await body()
    } finally {
      release()
    }
  }

  /** 释放流程只跑一次；后续调用共享第一次的回收，`teardown` 不再执行。 */
  async disposeOnce(teardown: () => Promise<void>): Promise<void> {
    this.disposal ??= teardown()
    return this.disposal
  }
}
