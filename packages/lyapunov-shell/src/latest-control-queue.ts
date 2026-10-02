/** 原生单关节拖动：最多一条在执行、一条最新目标等待。清空后迟到回执不会再续发。 */
export class LatestControlQueue<T, R> {
  private pending?: {value:T;resolve:(result:R|undefined)=>void}
  private running = false
  private runningAbort?:AbortController
  private epoch = 0
  constructor(private readonly send: (value: T,signal:AbortSignal) => Promise<R>, private readonly settled: (result: R, latencyMs: number) => void, private readonly failed: (error: unknown) => void) {}
  submit(value: T):Promise<R|undefined> { this.pending?.resolve(undefined);const result=new Promise<R|undefined>(resolve=>{this.pending={value,resolve}});void this.drain();return result }
  private discardPending(){this.pending?.resolve(undefined);this.pending=undefined}
  clearPending(){this.discardPending()}
  clear() { this.discardPending(); this.epoch++;this.runningAbort?.abort() }
  private async drain() {
    if (this.running) return
    this.running = true
    try {
      while (this.pending !== undefined) {
        const item=this.pending,value = item.value, epoch = this.epoch
        const controller=new AbortController();this.runningAbort=controller
        this.pending = undefined
        const at = performance.now()
        try { const result = await this.send(value,controller.signal); if (epoch === this.epoch){this.settled(result, performance.now() - at);item.resolve(result)}else item.resolve(undefined) }
        catch (error) { item.resolve(undefined);if (epoch === this.epoch) { this.discardPending(); this.failed(error) } }
        finally{if(this.runningAbort===controller)this.runningAbort=undefined}
      }
    } finally { this.running = false }
  }
}
