/**
 * ISAAC-02 收口（T17）：`IsaacConfig.startupBudgetMs` 必须真的到得了传输层构造参数，不许在 Provider 的
 * 白名单里被静默吞掉（DEVELOPMENT_PRINCIPLES §7：已声明的参数不能被丢掉还不报错）。
 *
 * **这是装配层证据，不是引擎实测**：本机没有 Isaac Kit/SDK，本文件不启动任何 Isaac 进程、不加载 Kit。
 * 做法是用一个"永不 ready"的最小假 worker（测试运行时写到临时目录，只有 `time.sleep`）把启动挂在
 * 未 ready 状态，于是可以直接读 Provider 交给 `ProcessSimProvider` 的**真实构造参数**
 * （`ProcessSimProvider.config` 是公开只读字段），并用真实的"预算到期"与真实的 `RangeError` 证明：
 *   1. 未配置 → 构造参数**不含**该键，且 800ms 内没有任何上限把这次尚未 ready 的启动判死（负对照）；
 *   2. 显式 400ms → 该键**出现**在构造参数里，并真的按 400ms 到期（`PROVIDER_START_TIMEOUT` + 阶段轨迹）；
 *   3. 0／负数／NaN → 传输层构造函数当场 `RangeError`（既有校验未被本改动绕过，Provider 侧不重复校验）；
 *   4. 端到端装配链：`runtimePluginInsert` 产出的 sim-isaac 插件配置 → `IsaacProvider` → 传输层构造参数，
 *      两跳都用真实代码跑通（T11 的装配侧 + T17 的 Provider 侧）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IsaacProvider, type IsaacConfig } from '../src/provider.ts'
import type { ProcessSimProvider, ProcessSimConfig } from '../../sim-contract/src/python-transport.ts'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import { runtimePluginInsert } from '../../../script/runtime-patch.ts'

function systemPython(): string | undefined {
  for (const candidate of ['/usr/bin/python3', '/usr/local/bin/python3', '/bin/python3']) if (existsSync(candidate)) return candidate
  return undefined
}

const PYTHON = systemPython()
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
/** Provider 把本次 open 交给传输层后，那个真实的传输层对象就在 `pending` 里（测试用窄化探针，不改产品代码）。 */
type PendingProbe = { pending: Map<string, ProcessSimProvider> }

let base: string
let hangWorker: string
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'lyapunov-isaac02-wiring-'))
  hangWorker = join(base, 'hang-worker.py')
  // 只做一件事：永远不读 stdin、不发 ready —— 把启动钉在"尚未 ready"状态，好让构造参数可被读取。
  writeFileSync(hangWorker, 'import time\ntime.sleep(3600)\n')
})
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

const scene = (sceneId = 'wiring-scene'): SceneSnapshot => ({ sceneId, revision: 0, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' }, entities: [] })
const providerFor = (config: Record<string, unknown>, cacheName: string) => new IsaacProvider({
  pythonPath: PYTHON ?? '/nonexistent/python3', workerPath: hangWorker, cacheRoot: join(base, cacheName), ...config,
})

/** 读 Provider 实际交给传输层的构造参数（`open` 尚未 ready 时它挂在 `pending` 上）。 */
async function transportConfigGivenTo(provider: IsaacProvider, worldId: string): Promise<ProcessSimConfig> {
  const pending = (provider as unknown as PendingProbe).pending
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const child = pending.get(worldId)
    if (child) return child.config
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Provider 没有把这次 open 交给传输层（pending 为空）')
}

/** 一次调用在 ms 内是否结算（成功或失败都算结算）；用来证明"没有上限"时它一直挂着。 */
async function settledWithin(run: Promise<unknown>, ms: number): Promise<boolean> {
  return await Promise.race([run.then(() => true, () => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), ms))])
}

async function rejectionOf(run: Promise<unknown>): Promise<unknown> {
  try { await run } catch (error) { return error }
  throw new Error('期望这次调用失败，但它成功了')
}

async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`等待超时：${what}`)
}

describe.skipIf(PYTHON === undefined)('IsaacConfig.startupBudgetMs 的透传（装配层证据，非引擎实测）', () => {
  test('负对照：未配置预算 → 构造参数不含该键，且启动没有上限', async () => {
    const provider = providerFor({}, 'cache-absent')
    const opening = provider.open(scene(), { worldId: 'no-budget' })
    void opening.catch(() => undefined)
    const config = await transportConfigGivenTo(provider, 'no-budget')
    // 这条确实是 Isaac 的传输层构造参数，不是别的 Provider：先钉住身份，再断言键的不存在。
    expect(config.engineName).toBe('Isaac Sim 6.0.1')
    expect('startupBudgetMs' in config).toBe(false)
    // 800ms 内既没成功也没失败：没有默认上限、没有看门狗把这次尚未 ready 的启动判死。
    expect(await settledWithin(opening, 800)).toBe(false)
    const pid = (provider as unknown as PendingProbe).pending.get('no-budget')!.pid!
    expect(alive(pid)).toBe(true)
    // 收尾仍走既有"尚未 ready 时 dispose 不悬空"：进程被按归属结束，调用方拿到终态错误。
    await provider.dispose()
    await until(() => !alive(pid), 'dispose 后尚未 ready 的 worker 被结束')
    const error = await rejectionOf(opening) as { code?: string }
    expect(error.code).toBe('PROVIDER_CLOSED')
  }, 20_000)

  test('显式 400ms → 该键出现在构造参数里，并真的按 400ms 到期', async () => {
    const provider = providerFor({ startupBudgetMs: 400 }, 'cache-budget')
    const opening = provider.open(scene(), { worldId: 'budgeted' })
    void opening.catch(() => undefined)
    const config = await transportConfigGivenTo(provider, 'budgeted')
    expect(config.startupBudgetMs).toBe(400)
    const pid = (provider as unknown as PendingProbe).pending.get('budgeted')!.pid!
    const error = await rejectionOf(opening) as { code?: string; message?: string }
    expect(error.code).toBe('PROVIDER_START_TIMEOUT')
    expect(error.message).toContain('400ms')
    expect(error.message).toContain('阶段轨迹=')
    await until(() => !alive(pid), '超预算的 worker 子进程退出')
  }, 20_000)
})

test('端到端装配链：runtime-patch 的 sim-isaac 插件配置 → IsaacProvider → 传输层构造参数', async () => {
  // T11 已让装配侧带出该键，T17 让 Provider 不再吞它：这里把两跳接起来跑一遍真实代码路径。
  const plugins = runtimePluginInsert({
    mode: 'developer', surface: 'web', sceneRoot: join(base, 'assembly-scene'), engine: 'isaac',
    isaac: { physicsDevice: 'cpu', rendering: 'none', startupBudgetMs: 900 },
  })
  const entry = plugins.find(plugin => plugin.id === 'lyapunov-sim-isaac')
  if (entry === undefined) throw new Error('装配结果里没有 lyapunov-sim-isaac 插件')
  const assembled = entry.config as Record<string, unknown>
  expect(assembled.startupBudgetMs).toBe(900)
  const provider = new IsaacProvider({ ...assembled, pythonPath: PYTHON!, workerPath: hangWorker, cacheRoot: join(base, 'cache-e2e') } as IsaacConfig)
  const opening = provider.open(scene(), { worldId: 'e2e' })
  void opening.catch(() => undefined)
  const transport = await transportConfigGivenTo(provider, 'e2e')
  expect(transport.engineName).toBe('Isaac Sim 6.0.1')
  expect(transport.startupBudgetMs).toBe(900)
  await provider.dispose()
}, 20_000)

test('非法值不被绕过：0／负数／NaN 由传输层构造函数当场 RangeError，且不留下挂起', async () => {
  for (const value of [0, -5, Number.NaN]) {
    const provider = providerFor({ startupBudgetMs: value }, `cache-invalid-${String(value)}`)
    const opening = provider.open(scene(), { worldId: `invalid-${String(value)}` })
    void opening.catch(() => undefined)
    // 构造当场失败＝立刻结算；被白名单吞掉时它会一路挂到 worker 永不 ready（这里 1.5s 足够区分两者）。
    const outcome = await Promise.race([
      opening.then(() => ({ kind: 'resolved' as const }), (error: unknown) => ({ kind: 'rejected' as const, error })),
      new Promise<{ kind: 'pending' }>(resolve => setTimeout(() => resolve({ kind: 'pending' }), 1500)),
    ])
    if (outcome.kind === 'pending') {
      await provider.dispose()
      throw new Error(`非法预算 ${String(value)} 没有当场被拒：构造参数被静默忽略，启动无上限地挂着（白名单吞参数的形态）`)
    }
    if (outcome.kind === 'resolved') throw new Error(`非法预算 ${String(value)} 没有当场被拒：open 反而成功了`)
    expect(outcome.error).toBeInstanceOf(RangeError)
    expect((outcome.error as RangeError).message).toContain('startupBudgetMs')
    // 构造就失败了：没有 spawn、没有半成品挂在 pending 上。
    expect((provider as unknown as PendingProbe).pending.size).toBe(0)
  }
}, 20_000)
