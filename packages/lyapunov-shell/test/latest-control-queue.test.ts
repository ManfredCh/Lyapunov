import { expect, test } from 'bun:test'
import { LatestControlQueue } from '../src/latest-control-queue.ts'
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
test('持续手调最多一条执行加一条最新目标，不排队重播中间位置', async () => {
  const sent: number[] = [], seen: number[] = [], pending: Array<(v: number) => void> = []
  const queue = new LatestControlQueue<number, number>(value => { sent.push(value); return new Promise(resolve => pending.push(resolve)) }, result => seen.push(result), error => { throw error })
  queue.submit(1); queue.submit(2); queue.submit(3); queue.submit(4)
  expect(sent).toEqual([1]); pending.shift()!(1); await tick()
  expect(sent).toEqual([1, 4]); pending.shift()!(4); await tick(); expect(seen).toEqual([1, 4])
})
test('Stop/切换清除等待目标与迟到回执，新的显式操作仍可继续', async () => {
  const sent: number[] = [], seen: number[] = [], pending: Array<(v: number) => void> = []
  const queue = new LatestControlQueue<number, number>(value => { sent.push(value); return new Promise(resolve => pending.push(resolve)) }, result => seen.push(result), () => {})
  queue.submit(1); queue.submit(2); queue.clear(); pending.shift()!(1); await tick()
  expect(sent).toEqual([1]); expect(seen).toEqual([])
  queue.submit(3); pending.shift()!(3); await tick(); expect(sent).toEqual([1, 3]); expect(seen).toEqual([3])
})
test('引擎拒绝时丢弃等待目标并显示错误，不自动重试驱动', async () => {
  const sent: number[] = [], errors: unknown[] = []
  let fail!: (error: unknown) => void
  const queue = new LatestControlQueue<number, never>(value => { sent.push(value); return new Promise((_resolve, reject) => { fail = reject }) }, () => {}, error => errors.push(error))
  queue.submit(1); queue.submit(2); fail('STALE_GENERATION'); await tick()
  expect(sent).toEqual([1]); expect(errors).toEqual(['STALE_GENERATION'])
})
test('松手最终目标排在唯一在途后，被合并目标不冒充最终回执',async()=>{
 const sent:string[]=[],pending:Array<(value:string)=>void>=[],seen:string[]=[]
 const queue=new LatestControlQueue<string,string>(value=>{sent.push(value);return new Promise(resolve=>pending.push(resolve))},value=>seen.push(value),()=>{})
 const first=queue.submit('update-1'),replaced=queue.submit('update-2'),final=queue.submit('final')
 expect(await replaced).toBeUndefined();expect(sent).toEqual(['update-1'])
 pending.shift()!('r1');expect(await first).toBe('r1');await tick();expect(sent).toEqual(['update-1','final'])
 pending.shift()!('not-reached');expect(await final).toBe('not-reached');expect(seen).toEqual(['r1','not-reached'])
})
test('Stop清除未发final，迟到在途终态不能续发或冒充final',async()=>{
 let deliver!:(v:string)=>void;const sent:string[]=[],seen:string[]=[]
 const queue=new LatestControlQueue<string,string>(value=>{sent.push(value);return new Promise(resolve=>{deliver=resolve})},v=>seen.push(v),()=>{})
 const inFlight=queue.submit('update'),final=queue.submit('final');queue.clear()
 expect(await final).toBeUndefined();deliver('stopped');expect(await inFlight).toBeUndefined();await tick()
 expect(sent).toEqual(['update']);expect(seen).toEqual([])
})
test('clear传原AbortSignal取消真实在途等待，新显式手势不复用旧signal',async()=>{
 const signals:AbortSignal[]=[],sent:string[]=[],errors:unknown[]=[]
 const queue=new LatestControlQueue<string,string>((value,signal)=>{sent.push(value);signals.push(signal);return value==='old'?new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})):Promise.resolve(value)},()=>{},error=>errors.push(error))
 const old=queue.submit('old'),unissued=queue.submit('final');queue.clear()
 expect(signals[0]!.aborted).toBe(true);expect(await old).toBeUndefined();expect(await unissued).toBeUndefined()
 expect(await queue.submit('new')).toBe('new');expect(signals[1]!.aborted).toBe(false);expect(sent).toEqual(['old','new']);expect(errors).toEqual([])
})
test('退出先只丢未发目标，不在flush阶段提前abort原动作，也不自动续发',async()=>{
 let finish!:(value:string)=>void,activeSignal!:AbortSignal
 const sent:string[]=[],seen:string[]=[]
 const queue=new LatestControlQueue<string,string>((value,signal)=>{sent.push(value);activeSignal=signal;return new Promise(resolve=>{finish=resolve})},value=>seen.push(value),()=>{})
 const running=queue.submit('update'),pending=queue.submit('final');queue.clearPending()
 expect(await pending).toBeUndefined();expect(activeSignal.aborted).toBe(false);finish('real-receipt');expect(await running).toBe('real-receipt')
 expect(sent).toEqual(['update']);expect(seen).toEqual(['real-receipt'])
})
