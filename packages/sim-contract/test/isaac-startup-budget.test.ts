/**
 * ISAAC-02 接线切片（T11）：显式启动预算的**装配通路**与**传输语义**。
 *
 * 本文件只验两件事，两者都不是引擎实测：
 * 1. 装配侧（`script/runtime-patch.ts`）：显式给值的 `startupBudgetMs` 进入 sim-isaac 插件配置；不给值时不带
 *    该键——产品 Profile 不会凭空产生一个默认上限（Isaac RTX 冷缓存启动实测约 270s，默认上限会杀掉有效启动）。
 * 2. 传输侧（`ProcessSimProvider`，假 worker 只实现行协议）：不配置 = 没有上限，慢但最终 ready 的启动仍完成；
 *    显式配置到期 = 按既有 failProvider 语义结束本次尚未 ready 的启动，并报出最后阶段与原因；尚未 ready 时
 *    dispose 仍不悬空，且挂起的预算不会在 dispose 之后再触发一次。
 *
 * 预算是否真的落到真实 Kit 进程上，取决于 sim-isaac Provider 是否把该字段转交给传输层；本文件不使用真实
 * Kit，不能作为引擎实测证据（见回执 `ISAAC02-STARTUP-BUDGET-20260921.md` 的未覆盖项）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProcessSimProvider, type ProcessSimConfig } from '../src/python-transport.ts'
import { SimError } from '../src/index.ts'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import { isaacRuntimeOptions, runtimePluginInsert, type RuntimePatchInput } from '../../../script/runtime-patch.ts'

const WORKER = new URL('./fixtures/fake-worker.py', import.meta.url).pathname

function systemPython(): string | undefined {
  for (const candidate of ['/usr/bin/python3', '/usr/local/bin/python3', '/bin/python3']) if (existsSync(candidate)) return candidate
  return undefined
}

const PYTHON = systemPython()
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

const ASSEMBLY_BASE: Omit<RuntimePatchInput, 'engine' | 'isaac'> = { mode: 'developer', surface: 'web', sceneRoot: '/tmp/isaac02-assembly' }

/** 装配后的 `lyapunov-sim-isaac` 插件配置；找不到该条目就是接线断了，直接失败。 */
function simIsaacConfig(input: RuntimePatchInput): Record<string, unknown> {
  const entry = runtimePluginInsert(input).find(plugin => plugin.id === 'lyapunov-sim-isaac')
  if (entry === undefined) throw new Error('装配结果里没有 lyapunov-sim-isaac 插件')
  return entry.config ?? {}
}

test('装配接线：显式配置的启动预算随 sim-isaac 插件配置到达 Provider', () => {
  const config = simIsaacConfig({ ...ASSEMBLY_BASE, engine: 'isaac', isaac: { physicsDevice: 'cpu', rendering: 'none', startupBudgetMs: 600_000 } })
  expect(config.startupBudgetMs).toBe(600_000)
  // 其余 Isaac 选项与预算同源，接线不得改变它们。
  expect(config.physicsDevice).toBe('cpu')
  expect(config.rendering).toBe('none')
})

test('负对照：未配置启动预算时装配结果不带该键，也不产生默认上限', () => {
  const config = simIsaacConfig({ ...ASSEMBLY_BASE, engine: 'isaac', isaac: { physicsDevice: 'cpu', rendering: 'none' } })
  expect('startupBudgetMs' in config).toBe(false)
  expect(isaacRuntimeOptions({ physicsDevice: 'cpu', rendering: 'none' })).not.toHaveProperty('startupBudgetMs')
  // 默认设备为 cuda:0；显式空环境使预算负对照不依赖调用终端的设备覆盖。
  expect(isaacRuntimeOptions({}, {})).toEqual({ physicsDevice: 'cuda:0', rendering: 'none' })
})

test('非 Isaac 引擎不接收该键：装配方不把预算交给没接这个字段的 Provider', () => {
  const plugins = runtimePluginInsert({ ...ASSEMBLY_BASE, engine: 'mujoco', isaac: { physicsDevice: 'cpu', rendering: 'none', startupBudgetMs: 600_000 } })
  const mujoco = plugins.find(plugin => plugin.id === 'lyapunov-sim-mujoco')
  if (mujoco === undefined) throw new Error('装配结果里没有 lyapunov-sim-mujoco 插件')
  expect('startupBudgetMs' in (mujoco.config ?? {})).toBe(false)
})

let base: string
beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'lyapunov-isaac02-budget-')) })
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

function providerFor(plan: Record<string, unknown>, config: Partial<ProcessSimConfig> = {}) {
  const scenario = join(base, 'scenario.json')
  writeFileSync(scenario, JSON.stringify(plan))
  const marker = join(base, 'marker.log')
  writeFileSync(marker, '')
  const provider = new ProcessSimProvider({
    pythonPath: PYTHON!, workerPath: WORKER, engineName: 'fake-engine',
    env: { FAKE_SCENARIO: scenario, FAKE_MARKER: marker }, ...config,
  })
  return { provider, marker }
}

const scene = (sceneId = 'fake-scene'): SceneSnapshot => ({ sceneId, revision: 0, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' }, entities: [] })
const markerText = (marker: string) => readFileSync(marker, 'utf8')

async function failureOf(run: Promise<unknown>): Promise<SimError> {
  try { await run } catch (error) { return error as SimError }
  throw new Error('期望这次调用失败，但它成功了')
}

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`等待超时：${what}`)
}

describe.skipIf(PYTHON === undefined)('显式启动预算的传输语义（假 worker，非引擎实测）', () => {
  test('未配置预算 = 无上限：慢到 1.5s 才 ready 的启动仍然完成', async () => {
    const { provider, marker } = providerFor({ ready: 'ok', readyDelayMs: 1500, phases: true })
    const startedAt = Date.now()
    const handle = await provider.open(scene('slow-but-valid'))
    expect(handle.worldId).toBe('fake-world')
    // 真的等了 1.5s 才交付：这段时间里没有任何默认上限把它判死。
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1400)
    expect(provider.lifecyclePhases().map(phase => phase.name)).toContain('ready')
    expect(markerText(marker)).toContain('ready-emitted')
    expect(markerText(marker).split('started pid=').length - 1).toBe(1)
    const pid = provider.pid!
    expect(alive(pid)).toBe(true)
    // 交付后的世界可用，且这只 worker 没有被预算/看门狗换掉。
    expect((await provider.observe('fake-world')).stepIndex).toBe(7)
    expect(provider.pid).toBe(pid)
    await provider.dispose()
  }, 20_000)

  test('显式预算到期：结束本次尚未 ready 的启动，并报出最后阶段与原因', async () => {
    const { provider, marker } = providerFor(
      { ready: 'none', readyDelayMs: 10_000, phases: true, stderr: 'FAKE_BUDGET_STDERR' },
      { startupBudgetMs: 1000 },
    )
    const error = await failureOf(provider.open(scene('budgeted')))
    expect(error.code).toBe('PROVIDER_START_TIMEOUT')
    expect(error.message).toContain('1000ms')
    const pid = provider.pid!
    expect(error.message).toContain(`pid=${pid}`)
    expect(error.message).toContain('最后阶段=')
    expect(error.message).toContain('阶段轨迹=')
    // 「报出最后阶段」不是一句套话：消息里那一段必须就是传输层记录的最后一条阶段。
    const last = provider.lifecyclePhases().at(-1)?.name
    expect(last).toBeDefined()
    expect(error.message).toContain(last!)
    expect(error.message).toContain('FAKE_BUDGET_STDERR')
    // 只结束本次自己尚未交付的启动：进程真的退出，且预算到期不产生任何自动重启。
    await until(() => !alive(pid), '超预算的 worker 子进程退出')
    expect((await failureOf(provider.listWorlds())).code).toBe('PROVIDER_START_TIMEOUT')
    expect(provider.pid).toBe(pid)
    expect(markerText(marker).split('started pid=').length - 1).toBe(1)
  }, 20_000)

  test('尚未 ready 时 dispose：不悬空，且挂起的预算在 dispose 之后不再触发', async () => {
    const { provider } = providerFor(
      { ready: 'never', phases: true, ignoreShutdown: true },
      { startupBudgetMs: 1200 },
    )
    const pending = failureOf(provider.open(scene('disposed')))
    await until(() => provider.lifecyclePhases().some(phase => phase.name === 'kit-app-start'), 'worker 已进入启动阶段')
    const pid = provider.pid!
    const startedAt = Date.now()
    await provider.dispose()
    // dispose 不能等一个不会来的 shutdown 回复：预算还挂着也照样按时结束。
    expect(Date.now() - startedAt).toBeLessThan(5000)
    await until(() => !alive(pid), '尚未 ready 的 worker 被按归属终止')
    const error = await pending
    // 终态是「Provider 已释放」，不是随后到期的预算：预算定时器必须随这次启动一起撤销。
    expect(error.code).toBe('PROVIDER_CLOSED')
    expect(error.message).toContain('尚未 ready')
    expect(error.message).toContain(`pid=${pid}`)
    // 跨过预算本来该到期的时刻：没有第二次终止、没有重启、Provider 保持已释放。
    await until(() => Date.now() - startedAt > 1500, '越过原预算到期时刻')
    expect(provider.pid).toBe(pid)
    expect(alive(pid)).toBe(false)
    expect((await failureOf(provider.open(scene('after-dispose')))).code).toBe('PROVIDER_CLOSED')
  }, 20_000)
})
