/**
 * 传输层启动/退出生命周期的**控制边界**测试（91_isaac_startup_lifecycle）。
 *
 * 背景：83 的真实回执里有一次 Kit 启动“零输出、2 线程 futex 等待、约 3 分钟无任何进展”，
 * 以及部分 close 墙钟 200s+。这里不重复 Isaac 的分钟级冷启动，而是用可编排的假 worker
 * （`fixtures/fake-worker.py`，只实现行协议）把每条**时序**逐条复现：
 *
 * - delayed ready + 显式取消：取消必须结束本次自己尚未 ready 的操作，并给出阶段/pid/stderr 摘要；
 * - 显式启动预算到期：同样结束并进入终态错误，且期间不产生任何自动重启；
 * - 真实 fatal / 真实 exit：既有错误语义不回退；
 * - 迟到旧 ready：陈旧 worker 的 ready 不得复活（只有显式新 open 才重启）；
 * - 正常 SDK 关闭：worker 回复 shutdown 后自行退出，不靠强杀（关闭仍等真回执）；
 * - 尚未 ready 时 dispose：不悬空——这条是从 83 现场提炼、且在基线版本上最小复现过的真实悬空路径；
 * - **就绪之后**的 worker 故障（exit / fatal / 管道断裂 / 自行死亡）：在途调用必须被拒绝而不是挂起，
 *   失效 world/帧句柄被清掉，旧 worker 不能复活也不能污染显式重开的新 worker（105 回归的交叉状态例）；
 * - 静默但不判死、慢观察不判死：没有输出/观察变慢都不是终止或重启的理由；
 * - 取消的清场可达性（110）：取消期间的普通 `listWorlds` 轮询不能把迟到世界「采纳掉」而跳过清场、
 *   同 id 的显式新 open 排在迟到清场之后（新世界不被旧清场关掉）、open 前的慢 extras 不拖住取消。
 *
 * 假 worker 不是第二个仿真引擎，也不证明 Isaac 的物理行为；它只证明生命周期由「显式取消 /
 * 显式预算」触发，而不是由「多久没有输出」这类观察超时触发。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ProcessSimProvider, type ProcessSimConfig } from '../src/python-transport.ts'
import { SimError } from '../src/index.ts'
import type { Frame, SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import { NewtonProvider } from '../../sim-newton/src/provider.ts'

const WORKER = new URL('./fixtures/fake-worker.py', import.meta.url).pathname

function systemPython(): string | undefined {
  for (const candidate of ['/usr/bin/python3', '/usr/local/bin/python3', '/bin/python3']) if (existsSync(candidate)) return candidate
  return undefined
}

const PYTHON = systemPython()
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

let base: string
beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'lyapunov-transport-lifecycle-')) })
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

/** 一次测试里的“场景文件”：假 worker 每次启动时重读，因此测试可以在两次启动之间改行为。 */
function writeScenario(plan: Record<string, unknown>): string {
  const path = join(base, 'scenario.json')
  writeFileSync(path, JSON.stringify(plan))
  return path
}

function providerFor<P extends ProcessSimProvider = ProcessSimProvider>(
  plan: Record<string, unknown>, config: Record<string, unknown> = {},
  create: (config: ProcessSimConfig) => P = config => new ProcessSimProvider(config) as P,
) {
  const scenario = writeScenario(plan)
  const marker = join(base, 'marker.log')
  closeSync(openSync(marker, 'a'))
  const provider = create({
    pythonPath: PYTHON!, workerPath: WORKER, engineName: 'fake-engine',
    env: { FAKE_SCENARIO: scenario, FAKE_MARKER: marker }, ...config,
  })
  return { provider, marker }
}

const scenarioOf = () => JSON.parse(readFileSync(join(base, 'scenario.json'), 'utf8'))
const markerText = (marker: string) => readFileSync(marker, 'utf8')

function scene(sceneId = 'fake-scene'): SceneSnapshot {
  return { sceneId, revision: 0, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' }, entities: [] }
}

async function failureOf(run: Promise<unknown>): Promise<SimError> {
  try { await run } catch (error) { return error as SimError }
  throw new Error('期望这次调用失败，但它成功了')
}

/** 等待一个条件成立（避免固定 sleep 造成的偶发）：超时即失败并带上给排查用的上下文。 */
async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`等待超时：${what}`)
}

/**
 * 断言这次调用**真的会结算**（105 回归的核心症状是“worker 都没了，调用还一直挂在 pending 上”）：
 * 在 `ms` 内既没成功也没失败，就按失败处理，错误信息直接说明是挂起。
 */
async function rejectionWithin(run: Promise<unknown>, ms: number): Promise<SimError> {
  const outcome = await Promise.race([
    run.then(() => ({ kind: 'resolved' as const }), (error: SimError) => ({ kind: 'rejected' as const, error })),
    new Promise<{ kind: 'pending' }>(resolve => setTimeout(() => resolve({ kind: 'pending' }), ms)),
  ])
  if (outcome.kind === 'pending') throw new Error(`调用在 ${ms}ms 内没有结算：worker 已经没了，它却还挂在 pending 上`)
  if (outcome.kind === 'resolved') throw new Error('期望这次调用失败，但它成功了')
  return outcome.error
}

describe.skipIf(PYTHON === undefined)('ProcessSimProvider 启动/退出生命周期', () => {
  test('Newton不支持初始暂停，在实际launch入口前拒绝且不派生worker',async()=>{
    let launched=false
    const provider=new NewtonProvider({pythonPath:PYTHON!,workerPath:WORKER,launch:async()=>{launched=true;throw Error('不应启动worker')}})
    try {await expect(provider.open(scene(),{startPaused:true})).rejects.toMatchObject({code:'CLOCK_CONTROL_UNSUPPORTED'});expect(launched).toBe(false)}
    finally {await provider.dispose()}
  })
  test('原子初始暂停由worker回执确认，明确继续保留同world/代次/时钟', async () => {
    const { provider } = providerFor({ initialPauseSupport: true })
    try {
      const prepared = await provider.open(scene(), { worldId: 'preparing', clock: 'realtime', startPaused: true })
      expect(prepared.status).toBe('paused');expect(prepared.supportsPause).toBe(true);expect(prepared.clock).toBe('realtime')
      const frame = await provider.observe(prepared.worldId)
      expect(frame.stepIndex).toBe(0);expect(frame.simTime).toBe(0)
      const resumed = await provider.setPaused(prepared.worldId, false, prepared.worldGeneration)
      expect(resumed.worldId).toBe(prepared.worldId);expect(resumed.worldGeneration).toBe(prepared.worldGeneration)
      expect(resumed.clock).toBe('realtime');expect(resumed.status).toBe('ready')
    } finally { await provider.dispose() }
  })
  test('忽略初始暂停的worker不交付假准备世界，默认显式open保持兼容', async () => {
    const { provider, marker } = providerFor({})
    try {
      await expect(provider.open(scene(), { worldId: 'unsupported-pause', startPaused: true })).rejects.toMatchObject({code:'CLOCK_CONTROL_UNSUPPORTED'})
      expect(markerText(marker)).toContain('closed unsupported-pause')
      expect((await provider.listWorlds()).some(w=>w.worldId==='unsupported-pause')).toBe(false)
      const normal = await provider.open(scene(), {worldId:'normal'})
      expect(normal.status).toBe('ready');expect(normal.clock).toBe('realtime')
    } finally { await provider.dispose() }
  })
  test('初始暂停参数非boolean在启动worker前拒绝', async () => {
    const { provider, marker } = providerFor({})
    try {await expect(provider.open(scene(), {startPaused:'yes'} as any)).rejects.toMatchObject({code:'INVALID_ARGUMENT'});expect(markerText(marker)).toBe('')}
    finally {await provider.dispose()}
  })
  test('迟到的 ready + 显式取消：结束本次尚未 ready 的启动，并给出阶段/pid/stderr 摘要', async () => {
    const { provider, marker } = providerFor({ ready: 'none', readyDelayMs: 10_000, phases: true, stderr: 'FAKE_STDERR_MARKER kit 启动停在 carb 初始化' })
    const controller = new AbortController()
    const pending = failureOf(provider.open(scene(), {}, controller.signal))
    // 等**传输层**记到 kit-app-start 再取消：断言的是传输层对“取消发生在哪一阶段”的归因，
    // 只看假 worker 自己的 marker 会有竞态（marker 先落盘、那一行还没被解析）。
    await until(() => provider.lifecyclePhases().some(phase => phase.name === 'kit-app-start'), '传输层已记到 kit-app-start 阶段（取消前必须确有阶段事实）')
    const pid = provider.pid!
    expect(pid).toBeGreaterThan(0)
    controller.abort()
    const error = await pending
    expect(error.code).toBe('PROVIDER_START_CANCELLED')
    // 错误码也在 message 里：工具/命令边界只把 message 交给调用方，那一层看不到 code。
    expect(error.message).toContain('PROVIDER_START_CANCELLED')
    expect(error.message).toContain(`pid=${pid}`)
    expect(error.message).toContain('kit-app-start')
    expect(error.message).toContain('阶段轨迹=')
    expect(error.message).toContain('FAKE_STDERR_MARKER')
    // 「可靠结束本次自己尚未 ready 的操作」：自己的子进程必须真的结束，不能留悬空 Promise 或孤儿进程。
    await until(() => !alive(pid), '被取消的 worker 子进程退出')
    // 取消不产生任何自动重启。
    expect(provider.pid).toBe(pid)
  })

  test('显式启动预算到期：同样结束本次启动，且只有显式新 open 才重启', async () => {
    // 预算取 1s：必须明显长于解释器/worker 启动本身，否则这条测试测的是机器的快慢（在负载高的机器上
    // 会偶发失败——那样连 stderr 摘要都还没到），而不是“预算到期结束本次启动”。1s 仍远小于 ready 的 10s 延迟。
    const { provider, marker } = providerFor({ ready: 'none', readyDelayMs: 10_000, phases: true, stderr: 'FAKE_BUDGET_STDERR' }, { startupBudgetMs: 1000 })
    const error = await failureOf(provider.open(scene()))
    expect(error.code).toBe('PROVIDER_START_TIMEOUT')
    expect(error.message).toContain('1000ms')
    expect(error.message).toContain('阶段轨迹=')
    expect(error.message).toContain('FAKE_BUDGET_STDERR')
    const failedPid = provider.pid!
    await until(() => !alive(failedPid), '超预算的 worker 子进程退出')
    // 预算到期后：后台调用不会偷偷重启 worker，只是失败。
    const probe = await failureOf(provider.listWorlds())
    expect(probe.code).toBe('PROVIDER_START_TIMEOUT')
    expect(provider.pid).toBe(failedPid)
    expect(markerText(marker).split('started pid=').length - 1).toBe(1)
    // 显式新 open 才是重启入口：换掉场景后同一个 Provider 能起来真正的世界。
    writeScenario({ ready: 'ok', phases: true })
    const handle = await provider.open(scene('restarted'))
    expect(handle.worldId).toBe('fake-world')
    expect(markerText(marker).split('started pid=').length - 1).toBe(2)
    await provider.dispose()
  }, 20_000)

  test('真实 fatal：错误按 worker 回执的 code 上报，且不自动重启', async () => {
    const { provider } = providerFor({ fatal: 'FAKE_UNSUPPORTED:扩展没加载起来' })
    const error = await failureOf(provider.open(scene()))
    expect(error.code).toBe('FAKE_UNSUPPORTED')
    expect(error.message).toBe('扩展没加载起来')
    const failedPid = provider.pid!
    await until(() => !alive(failedPid), 'fatal 后的 worker 子进程退出')
    expect((await failureOf(provider.listWorlds())).code).toBe('FAKE_UNSUPPORTED')
    expect(provider.pid).toBe(failedPid)
  })

  test('真实 exit：worker 未 ready 就退出时上报 PROVIDER_EXITED 并带 stderr 摘要', async () => {
    const { provider } = providerFor({ exitCode: 4, stderr: 'FAKE_EXIT_STDERR' })
    const error = await failureOf(provider.open(scene()))
    expect(error.code).toBe('PROVIDER_EXITED')
    expect(error.message).toContain('FAKE_EXIT_STDERR')
  })

  test('迟到旧 ready：陈旧 worker 的 ready 不复活，只有显式新 open 换新进程', async () => {
    // ignoreSigterm 把 SIGTERM→SIGKILL 的窗口撑到 ready 之后，好让「迟到 ready」真的发生。
    const { provider, marker } = providerFor({ readyDelayMs: 1500, phases: true, ignoreSigterm: true })
    const controller = new AbortController()
    const pending = failureOf(provider.open(scene(), {}, controller.signal))
    // 必须等假 worker 真的装好 SIGTERM 处理器再取消（否则它被默认处置杀掉，撑不出这个窗口）；
    // 它的 ready 还在 1.5s 之后，取消发生在这之前。
    await until(() => markerText(marker).includes('sigterm-armed'), '假 worker 已装好 SIGTERM 处理器')
    const cancelledPid = provider.pid!
    controller.abort()
    expect((await pending).code).toBe('PROVIDER_START_CANCELLED')
    await until(() => markerText(marker).includes('ready-emitted'), '陈旧 worker 确实发出了迟到 ready')
    expect(markerText(marker)).toContain('sigterm-ignored')
    // 迟到 ready 不得被当成本次启动成功：没有 ready 阶段，也没有可用的世界。
    expect(provider.lifecyclePhases().some(phase => phase.name === 'ready')).toBe(false)
    expect((await failureOf(provider.listWorlds())).code).toBe('PROVIDER_START_CANCELLED')
    // 显式新 open 才换新进程。
    writeScenario({ ready: 'ok', phases: true })
    const handle = await provider.open(scene('fresh'))
    expect(handle.worldId).toBe('fake-world')
    expect(provider.pid).not.toBe(cancelledPid)
    expect(provider.lifecyclePhases().some(phase => phase.name === 'ready')).toBe(true)
    await until(() => !alive(cancelledPid), '被取消的旧 worker 最终被按归属终止')
    await provider.dispose()
  })

  test('正常 SDK 关闭：worker 回复 shutdown 后自行退出，不靠强杀，终态不丢', async () => {
    const { provider } = providerFor({ ready: 'ok', phases: true })
    const handle = await provider.open(scene())
    // 已交付世界的真实终态必须保留到 dispose 之后仍可读。
    await until(() => provider.terminalResults(handle.worldId).length === 1, 'worker 主动上报的终态回执已被登记')
    const pid = provider.pid!
    const startedAt = Date.now()
    await provider.dispose()
    expect(Date.now() - startedAt).toBeLessThan(3000)
    // 真回执 + 真退出：进程自己结束（这里没有任何强杀路径可走），关闭阶段也留下了轨迹。
    const names = provider.lifecyclePhases().map(phase => phase.name)
    expect(names).toContain('shutdown-world-closed')
    await until(() => !alive(pid), 'worker 自行退出')
    expect(provider.terminalResults(handle.worldId).length).toBe(1)
  })

  test('尚未 ready 时就 dispose：不悬空，按归属结束自己尚未交付的 worker', async () => {
    // 这是从 83 现场提炼的**真实悬空**（对照基线版本已最小复现：ignoreShutdown 的 worker 卡在启动、
    // 不读 stdin，基线 dispose 会永远等一个不会来的回复/退出）。正常 world 关闭仍走上面的真回执路径。
    const { provider } = providerFor({ ready: 'never', phases: true, ignoreShutdown: true })
    const pending = failureOf(provider.open(scene()))
    await until(() => provider.lifecyclePhases().some(phase => phase.name === 'kit-app-start'), 'worker 已进入启动阶段')
    const pid = provider.pid!
    const startedAt = Date.now()
    await provider.dispose()
    expect(Date.now() - startedAt).toBeLessThan(5000)
    await until(() => !alive(pid), '尚未 ready 的 worker 被按归属终止')
    // 本次尚未交付的启动被可靠结束：调用方拿到终态错误，而不是一个悬空 Promise。
    const error = await pending
    expect(error.code).toBe('PROVIDER_CLOSED')
    expect(error.message).toContain('尚未 ready')
    expect(error.message).toContain(`pid=${pid}`)
    expect(error.message).toContain('阶段轨迹=')
  })

  test('静默但不判死：启动期长时间零输出既不终止也不重启', async () => {
    const { provider, marker } = providerFor({ ready: 'ok', phases: false, silentMs: 1200, stderr: '' })
    const pending = provider.open(scene())
    await until(() => provider.pid !== undefined, 'worker 已派生')
    const pid = provider.pid!
    await new Promise(resolve => setTimeout(resolve, 600))
    // 静默 600ms（阶段事件也没有）时：没有预算/没有取消 ⇒ 不杀、不重启。
    expect(provider.pid).toBe(pid)
    expect(alive(pid)).toBe(true)
    expect(provider.lifecyclePhases().map(phase => phase.name)).toEqual(['spawned'])
    const handle = await pending
    expect(handle.worldId).toBe('fake-world')
    expect(provider.pid).toBe(pid)
    expect(markerText(marker)).toContain('ready-emitted')
    await provider.dispose()
  })

  test('慢观察不判死：一次很慢的 observe 只是等它返回，不换 worker', async () => {
    const { provider } = providerFor({ ready: 'ok', observeDelayMs: 900 })
    await provider.open(scene())
    const pid = provider.pid!
    const startedAt = Date.now()
    const frame = await provider.observe('fake-world')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(800)
    expect(frame.stepIndex).toBe(7)
    expect(provider.pid).toBe(pid)
    expect(alive(pid)).toBe(true)
    await provider.dispose()
  })

  test('关停阶段仍被记录：close 的 phase 事件进生命周期轨迹（慢关闭可归因）', async () => {
    const { provider } = providerFor({ ready: 'ok', closeDelayMs: 300 })
    const handle = await provider.open(scene())
    await provider.close(handle.worldId)
    const names = provider.lifecyclePhases().map(phase => phase.name)
    expect(names).toContain('world-close-request')
    expect(names).toContain('world-closed')
    await provider.dispose()
  })

  test('ready 之后、世界交付之前的取消：同样结束本次 open，世界不会被交付', async () => {
    // worker 已经 ready，但 open 回复被拖慢（真实 Isaac 建世界要几秒）：这一段也必须能被取消。
    const { provider, marker } = providerFor({ ready: 'ok', phases: true, openDelayMs: 3000 })
    const controller = new AbortController()
    const pending = failureOf(provider.open(scene('slow-world'), { worldId: 'slow-world' }, controller.signal))
    // 等**传输层**已经记到 ready 阶段再取消（不能只看假 worker 自己的 marker：marker 先落盘、
    // ready 行还没被解析完时取消，走的会是启动期取消那条路，测不到这一段）。
    await until(() => provider.lifecyclePhases().some(phase => phase.name === 'ready'), '传输层已看到 worker 的 ready')
    const pid = provider.pid!
    controller.abort()
    const error = await pending
    expect(error.code).toBe('PROVIDER_START_CANCELLED')
    expect(error.message).toContain('世界交付之前')
    expect(error.message).toContain(`pid=${pid}`)
    expect(error.message).toContain('ready')
    await until(() => !alive(pid), '被取消的子进程退出')
    // 没有悬空的世界：这次 open 只留下终态错误，后续调用一律沿用同一个错误，拿不到任何 world。
    expect((await failureOf(provider.listWorlds())).code).toBe('PROVIDER_START_CANCELLED')
    expect((await failureOf(provider.observe('slow-world'))).code).toBe('PROVIDER_START_CANCELLED')
  }, 20_000)

  test('拒绝非法显式预算：不把“配错了”静默当成没配置', () => {
    expect(() => providerFor({}, { startupBudgetMs: 0 }).provider).toThrow(RangeError)
    expect(() => providerFor({}, { startupBudgetMs: Number.NaN }).provider).toThrow(RangeError)
  })
})

/**
 * 就绪**之后**的 worker 故障（105 回归：`start()` 里的 settled 只能结算启动 Promise，不能屏蔽整个生命周期）。
 *
 * 根因与症状：ready 之后 `settled` 已经是 true，而 `failed()` 里加了 `if (settled) return`，
 * 于是真实 exit / fatal 被整体跳过 ⇒ `failProvider` 不跑 ⇒ 在途 `observe` 永远挂在 pending 上。
 * 这一组用例把「就绪之后的每种真实故障」都钉住：在途必须被拒绝、失效句柄/帧必须被清掉、
 * 旧 worker 不能复活也不能污染显式重开后的新 worker、正常关闭不新增错误。
 */
describe.skipIf(PYTHON === undefined)('就绪之后的 worker 故障', () => {
  test('ready 后 observe 期间真实 exit(7)：在途请求被拒绝、失效帧/world 句柄被清掉、不自动重启', async () => {
    const { provider, marker } = providerFor({ ready: 'ok', phases: true, framesAfterOpen: 2, exitOnRequest: { method: 'observe', code: 7 } })
    const handle = await provider.open(scene())
    const pid = provider.pid!
    // 先证明传输层确实记住过这个世界的帧，否则“清掉失效帧”这条断言是空的。
    const seen: Frame[] = []
    provider.subscribeFrames(handle.worldId, frame => seen.push(frame))
    await until(() => seen.length > 0, '传输层已收到并记住该世界的帧事件')
    const error = await rejectionWithin(provider.observe(handle.worldId), 3000)
    expect(error.code).toBe('PROVIDER_EXITED')
    expect(error.message).toContain('退出 (7)')
    // 失效句柄/帧被清掉：旧帧不再重放，world 列表与观察一律沿用同一终态错误。
    const after: Frame[] = []
    provider.subscribeFrames(handle.worldId, frame => after.push(frame))
    expect(after).toEqual([])
    expect((await failureOf(provider.listWorlds())).code).toBe('PROVIDER_EXITED')
    expect((await failureOf(provider.observe(handle.worldId))).code).toBe('PROVIDER_EXITED')
    // 不自动重启：pid 不变、只派生过一次 worker。
    expect(provider.pid).toBe(pid)
    await until(() => !alive(pid), '真实退出的 worker 进程已消失')
    expect(markerText(marker).split('started pid=').length - 1).toBe(1)
    // 正常释放不新增错误。
    await provider.dispose()
    expect((await failureOf(provider.observe(handle.worldId))).code).toBe('PROVIDER_CLOSED')
  }, 20_000)

  test('ready 后 fatal：按 worker 回执的 code 终态化、拒绝在途、坏 worker 被按归属结束，显式 open 才恢复', async () => {
    const { provider, marker } = providerFor({ ready: 'ok', phases: true, fatalOnRequest: { method: 'observe', fatal: 'FAKE_MID_FATAL:运行中致命错误' } })
    const handle = await provider.open(scene())
    const pid = provider.pid!
    const error = await rejectionWithin(provider.observe(handle.worldId), 3000)
    expect(error.code).toBe('FAKE_MID_FATAL')
    expect(error.message).toBe('运行中致命错误')
    // fatal 之后这个 worker 已经不可用：它被按归属结束，且没有自动重启。
    await until(() => !alive(pid), 'fatal 的 worker 被按归属结束')
    expect(provider.pid).toBe(pid)
    expect((await failureOf(provider.listWorlds())).code).toBe('FAKE_MID_FATAL')
    // 只有显式新 open 才是恢复入口：同一个 Provider 换掉场景后能起来真正的世界。
    writeScenario({ ready: 'ok', phases: true })
    const restarted = await provider.open(scene('after-fatal'))
    expect(restarted.worldId).toBe('fake-world')
    expect(provider.pid).not.toBe(pid)
    expect((await provider.observe(restarted.worldId)).stepIndex).toBe(7)
    expect(markerText(marker).split('started pid=').length - 1).toBe(2)
    await provider.dispose()
  }, 20_000)

  test('ready 后管道断裂：在途与后续调用都被拒绝、坏 worker 被按归属结束、显式 open 才恢复', async () => {
    // 触发方式说明（实测见 105 证据 pipe-probe*.ts）：bun 不会把「子进程关掉自己 stdin」报成写错误——
    // 写回调仍返回成功、也没有 'error' 事件，所以那个现场无法被传输层观测到。这里改成从一个**真实存在
    // 且可观测**的边界出发：直接把本 Provider 那个真子进程的 stdin 写端销毁（真父进程、真管道、真子进程），
    // 走的仍是 request() 里「写端已坏 ⇒ PROVIDER_PIPE_BROKEN ⇒ failProvider 拒绝全部在途」这条代码路径。
    // ignoreShutdown 让子进程收到 EOF 也不退出：把「写端坏掉」与「子进程因此退出」分开，避免两条终态抢跑。
    const { provider, marker } = providerFor({ ready: 'ok', phases: true, ignoreShutdown: true, observeDelayMs: 800 })
    const handle = await provider.open(scene())
    const pid = provider.pid!
    const inFlight = rejectionWithin(provider.observe(handle.worldId), 3000)
    await until(() => markerText(marker).includes('request observe'), 'worker 已收到那个还在途的 observe')
    const child = (provider as unknown as { process: { stdin: { destroy(): void } } }).process
    child.stdin.destroy()
    // 管道已坏之后的调用：直接被拒绝，不是挂在 pending 上等一个永远不来的回复。
    const error = await rejectionWithin(provider.observe(handle.worldId), 3000)
    expect(error.code).toBe('PROVIDER_PIPE_BROKEN')
    // 在途的那一次同样被拒绝（failProvider 拒绝全部 pending），不是被留在那里。
    expect((await inFlight).code).toBe('PROVIDER_PIPE_BROKEN')
    await until(() => !alive(pid), '管道断裂的 worker 被按归属结束')
    expect(provider.pid).toBe(pid)
    expect(markerText(marker).split('started pid=').length - 1).toBe(1)
    expect((await failureOf(provider.listWorlds())).code).toBe('PROVIDER_PIPE_BROKEN')
    writeScenario({ ready: 'ok', phases: true })
    const restarted = await provider.open(scene('after-pipe'))
    expect(provider.pid).not.toBe(pid)
    expect((await provider.observe(restarted.worldId)).stepIndex).toBe(7)
    await provider.dispose()
  }, 20_000)

  test('ready 后 worker 自行死亡（没有在途请求）：后续调用立即失败而不是挂起，显式 open 换新进程', async () => {
    const { provider, marker } = providerFor({ ready: 'ok', phases: true, framesAfterOpen: 1, exitAfterReadyMs: 400, exitAfterReadyCode: 9 })
    const handle = await provider.open(scene())
    const pid = provider.pid!
    // 先确认传输层确实记住了这个世界的一帧，否则“清掉失效帧”这条断言在空集上恒真。
    const seen: Frame[] = []
    provider.subscribeFrames(handle.worldId, frame => seen.push(frame))
    await until(() => seen.length > 0, '传输层已收到并记住该世界的帧事件')
    await until(() => !alive(pid), 'worker 已自行退出')
    // 同步点：failProvider 跑过之后，这个世界留下的失效帧就不会再被重放（旧帧不能冒充当前来源）。
    // 它还没跑时这里必然能重放出一帧，因此这个循环不是空等而是真的在等终态清理完成。
    await until(() => { const replay: Frame[] = []; const stop = provider.subscribeFrames(handle.worldId, frame => replay.push(frame)); stop(); return replay.length === 0 }, '传输层已清掉这次退出的失效句柄/帧')
    const error = await rejectionWithin(provider.observe(handle.worldId), 3000)
    expect(error.code).toBe('PROVIDER_EXITED')
    expect(provider.pid).toBe(pid)
    expect(markerText(marker).split('started pid=').length - 1).toBe(1)
    writeScenario({ ready: 'ok', phases: true })
    const restarted = await provider.open(scene('after-death'))
    expect(provider.pid).not.toBe(pid)
    expect((await provider.observe(restarted.worldId)).stepIndex).toBe(7)
    await provider.dispose()
  }, 20_000)
})

/**
 * 取消的**边界**：只有确实独占这个 child 的启动才能被整进程终止。
 *
 * 反例（root-91-shared-worker-cancel-probe.ts 实测）：MuJoCo 这类一个 worker 复用多个 world 的引擎上，
 * 先 open 了 primary 再 open secondary 并取消第二个，取消直接把整个 worker 按归属结束 ⇒ primary 一起死。
 * 这一组把两条边都钉住：已有已交付 world 时必须隔离（worker/其它 world/帧一律不动、迟到的世界关掉不留孤儿），
 * 以及排队未开始的 open 被取消时不启动也不结束任何 worker。独占场景（本次启动自己起的、还没有任何已交付
 * world）仍按归属终止整个 worker——那条由上面「ready 之后、世界交付之前的取消」用例守着。
 */
describe.skipIf(PYTHON === undefined)('取消不越界：共享 worker 的隔离与排队取消', () => {
  test('取消第二个 open 不牵连同 worker 上已交付的 primary，迟到的世界被就地关掉且不自动重启', async () => {
    const { provider, marker } = providerFor({ ready: 'ok', phases: true, openDelayByWorld: { secondary: 700 } })
    const primary = await provider.open(scene('shared-primary'), { worldId: 'primary' })
    expect(primary.worldId).toBe('primary')
    const pid = provider.pid!
    const controller = new AbortController()
    const pending = failureOf(provider.open(scene('shared-secondary'), { worldId: 'secondary' }, controller.signal))
    // 等**传输层**记到 secondary 的 open 阶段（worker 正卡在 700ms 的建世界延迟里）。
    await until(() => provider.lifecyclePhases().some(phase => phase.name === 'opening-secondary'), '传输层已记到 secondary 的 open 阶段')
    const cancelledAt = Date.now()
    controller.abort()
    const error = await pending
    expect(error.code).toBe('PROVIDER_START_CANCELLED')
    expect(error.message).toContain('世界交付之前')
    // 取消立刻返回，不是等 worker 把 secondary 建完（700ms）才回。
    expect(Date.now() - cancelledAt).toBeLessThan(400)
    // 同 worker 上已交付的 primary 一帧都没被碰：worker 还活着、pid 没变、primary 仍可观察。
    expect(provider.pid).toBe(pid)
    expect(alive(pid)).toBe(true)
    const frame = await provider.observe('primary') as Frame & { stillAlive: boolean }
    expect(frame.worldId).toBe('primary')
    expect(frame.stillAlive).toBe(true)
    // 迟到的 secondary 世界不交付、也不在 worker 里留孤儿：传输层按隔离路径把它就地关掉。
    await until(() => markerText(marker).includes('closed secondary'), 'worker 收到了对取消世界的 close（没留孤儿）')
    expect((await provider.listWorlds()).map(handle => handle.worldId)).toEqual(['primary'])
    expect(provider.terminalResults('secondary')).toEqual([])
    // 全程没有自动重启：只派生过这一个 worker。
    expect(markerText(marker).split('started pid=').length - 1).toBe(1)
    await provider.dispose()
  }, 20_000)

  test('排队未开始的 open 被取消：立刻返回，既不启动也不结束任何 worker，队列不被卡住', async () => {
    const { provider, marker } = providerFor({ ready: 'ok', phases: true, openDelayMs: 1500 })
    const first = provider.open(scene('queued-primary'), { worldId: 'primary' })
    // 第一个 open 已经落到 worker 上（在途等 1.5s 的回复），第二个 open 这时才是在排队。
    await until(() => markerText(marker).includes('request open'), '第一个 open 已经发到 worker')
    const pid = provider.pid!
    const controller = new AbortController()
    const queuedAt = Date.now()
    const queued = failureOf(provider.open(scene('queued-secondary'), { worldId: 'secondary' }, controller.signal))
    controller.abort()
    const error = await queued
    expect(error.code).toBe('PROVIDER_START_CANCELLED')
    expect(error.message).toContain('排队等待期间')
    expect(Date.now() - queuedAt).toBeLessThan(300)
    // 排队取消既不启动也不结束任何进程：还是那一个 worker、还是那个 pid。
    expect(provider.pid).toBe(pid)
    expect(alive(pid)).toBe(true)
    expect(markerText(marker).split('started pid=').length - 1).toBe(1)
    // 队列没有被这次取消卡住：前一个 open 正常交付，后面的 open 也照常轮到。
    expect((await first).worldId).toBe('primary')
    const third = await provider.open(scene('queued-tertiary'), { worldId: 'tertiary' })
    expect(third.worldId).toBe('tertiary')
    expect(provider.lifecyclePhases().some(phase => phase.name === 'ready')).toBe(true)
    await provider.dispose()
  }, 20_000)
})

/**
 * 可控的「慢 extras」：真实传输层 + 真实子进程，只把 open 之前的追加步骤拉长。
 * 真实对应物是 MuJoCo 的碰撞补丁编译（`SceneCollisionBuilder.build`），那一步在 open 与 sync 之前跑，
 * 编译很久时调用方过去只能干等——取消失效是传输层的问题，所以这里用可控耗时复现同一时序。
 */
class SlowExtrasProvider extends ProcessSimProvider {
  extrasCalls: { worldId: string; signal?: AbortSignal }[] = []
  extrasDone = 0
  delayMs = 900
  protected override async syncArgsExtras(worldId: string, _snapshot: SceneSnapshot, _options: { forceRebuild?: boolean } = {}, signal?: AbortSignal) {
    this.extrasCalls.push({ worldId, signal })
    await new Promise(resolve => setTimeout(resolve, this.delayMs))
    this.extrasDone++
    return undefined
  }
}

describe.skipIf(PYTHON === undefined)('取消清场可达性：普通轮询 / 同 id 重开 / 慢 extras', () => {
  test('取消期间普通 listWorlds 轮询不能把孤儿世界重新采纳（本体探针 root-105-cancel-listworlds-probe 的最小复现）', async () => {
    const { provider, marker } = providerFor({ ready: 'ok', phases: true, openDelayByWorld: { secondary: 700 }, framesAfterOpen: 2 })
    await provider.open(scene('poll-primary'), { worldId: 'primary' })
    const controller = new AbortController()
    const cancelledOpen = failureOf(provider.open(scene('poll-secondary'), { worldId: 'secondary' }, controller.signal))
    await until(() => provider.lifecyclePhases().some(phase => phase.name === 'opening-secondary'), '传输层已记到 secondary 的 open 阶段')
    controller.abort()
    expect((await cancelledOpen).code).toBe('PROVIDER_START_CANCELLED')
    // 这条 listWorlds 的回复由 worker 在**建出 secondary 之后**才发出，于是它把孤儿世界照单 adopt 进传输层。
    // 清场不能因此认为「它已经交付过」而跳过 close——110 的孤儿正是从这里留下的。
    expect((await provider.listWorlds()).map(handle => handle.worldId).sort()).toEqual(['primary', 'secondary'])
    await until(() => markerText(marker).includes('closed secondary'), 'worker 收到了对取消世界的 close')
    expect((await provider.listWorlds()).map(handle => handle.worldId)).toEqual(['primary'])
    // 迟到的帧句柄也要清掉：一个 worker 里已经不存在的世界不能再被当成当前来源重放。
    const replayed: Frame[] = []
    provider.subscribeFrames('secondary', frame => replayed.push(frame))
    expect(replayed).toEqual([])
    const frame = await provider.observe('primary') as Frame & { stillAlive: boolean }
    expect(frame.stillAlive).toBe(true)
    await provider.dispose()
  }, 20_000)

  test('取消后同 id 的显式新 open 排在迟到清场之后：新世界不被旧的清场关掉', async () => {
    const { provider, marker } = providerFor({ ready: 'ok', phases: true, openDelayByWorld: { secondary: 700 } })
    await provider.open(scene('reopen-primary'), { worldId: 'primary' })
    const controller = new AbortController()
    const cancelledOpen = failureOf(provider.open(scene('reopen-secondary'), { worldId: 'secondary' }, controller.signal))
    await until(() => provider.lifecyclePhases().some(phase => phase.name === 'opening-secondary'), '传输层已记到 secondary 的 open 阶段')
    controller.abort()
    expect((await cancelledOpen).code).toBe('PROVIDER_START_CANCELLED')
    // 取消立刻用同一个 worldId 重新显式 open：它排在迟到清场之后，所以
    // ① 清场只关掉被取消的那个世界（worker 只见过一次 close secondary）；
    // ② 新交付的世界还活着，没有被旧清场顺手关掉。
    const reopened = await provider.open(scene('reopen-secondary'), { worldId: 'secondary' })
    expect(reopened.worldId).toBe('secondary')
    expect(markerText(marker).split('closed secondary').length - 1).toBe(1)
    const frame = await provider.observe('secondary') as Frame & { stillAlive: boolean }
    expect(frame.stillAlive).toBe(true)
    expect((await provider.listWorlds()).map(handle => handle.worldId).sort()).toEqual(['primary', 'secondary'])
    await provider.dispose()
  }, 20_000)

  test('慢 extras 期间的取消：调用方及时返回，本次 open 不发给 worker，晚到的 extras 不补发、队列照常轮到', async () => {
    const { provider, marker } = providerFor({ ready: 'ok', phases: true }, {}, config => new SlowExtrasProvider(config))
    await provider.open(scene('slow-primary'), { worldId: 'primary' })
    const controller = new AbortController()
    const pending = failureOf(provider.open(scene('slow-secondary'), { worldId: 'secondary' }, controller.signal))
    await until(() => provider.extrasCalls.length === 2, '第二次 open 已经进入慢 extras')
    const cancelledAt = Date.now()
    controller.abort()
    expect((await pending).code).toBe('PROVIDER_START_CANCELLED')
    // extras 要 900ms；取消只等它结束就会白等——调用方必须在几十毫秒内拿到取消。
    expect(Date.now() - cancelledAt).toBeLessThan(400)
    // 取消发生在请求发出之前：worker 只见过 primary 的 open。
    expect(markerText(marker).split('request open').length - 1).toBe(1)
    // 晚到的 extras 跑完也不补发请求；钩子拿到的 signal 已经 aborted（据此不写自己的缓存）。
    await until(() => provider.extrasDone === 2, '第二次 extras 已经跑完')
    expect(provider.extrasCalls[1]?.signal?.aborted).toBe(true)
    expect(markerText(marker).split('request open').length - 1).toBe(1)
    // 队列没被这次取消卡住：后面的 open 照常轮到，已交付的 primary 未受影响。
    const third = await provider.open(scene('slow-tertiary'), { worldId: 'tertiary' })
    expect(third.worldId).toBe('tertiary')
    expect((await provider.observe('primary') as Frame & { stillAlive: boolean }).stillAlive).toBe(true)
    await provider.dispose()
  }, 20_000)
})

if (PYTHON === undefined) test('缺少系统 python3', () => { throw new Error('本机没有可用的 python3，生命周期边界测试无法运行') })
