/**
 * MuJoCoProvider 的 open 取消边界（110）：真实 provider + 可编排的假 worker。
 *
 * 这里验证的是**传输语义**（取消只结束本次尚未交付的 open，不碰同 worker 上已交付的 world、
 * 及时返回、本次 open 不发出去）与**碰撞缓存归属**（占位键 `''` / 显式 worldId 的条目只清本次，
 * 旧 world 与并行 sync 的条目不受影响）。真实 MuJoCo 引擎行为由门与真实探针覆盖，不用假 worker 冒充。
 *
 * 「慢编译」用可控延迟代替真实 `SceneCollisionBuilder.build`：真实编译需要可信 splat 绑定与真实网格，
 * 而这里要验的是它**前后**的 provider 代码（键计算、`collisionWorlds` 写入时机、取消后不写缓存），
 * 所以只把耗时替换成可控值，缓存与生命周期逻辑仍是被测的真实实现。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MuJoCoProvider } from '../src/provider.ts'
import type { Frame, SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'

const WORKER = new URL('../../sim-contract/test/fixtures/fake-worker.py', import.meta.url).pathname

function systemPython(): string | undefined {
  for (const candidate of ['/usr/bin/python3', '/usr/local/bin/python3', '/bin/python3']) if (existsSync(candidate)) return candidate
  return undefined
}

const PYTHON = systemPython()

let base: string
beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'lyapunov-mujoco-cancel-')) })
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

function scene(sceneId = 'mujoco-scene'): SceneSnapshot {
  return { sceneId, revision: 0, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' }, entities: [] }
}

const markerText = (marker: string) => readFileSync(marker, 'utf8')
const openRequests = (marker: string) => markerText(marker).split('request open').length - 1

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`等待超时：${what}`)
}

async function failureOf(run: Promise<unknown>): Promise<Error & { code?: string }> {
  try { await run } catch (error) { return error as Error & { code?: string } }
  throw new Error('期望这次调用失败，但它成功了')
}

/**
 * 可控编译：`plan()` 返回一个真实形状的计划（sourceKey/revision/entity），`build()` 等待固定时长。
 * 缓存键与写缓存都还是 MuJoCoProvider 自己的代码。
 */
function controllableCompile(buildMs: number) {
  const state = { builds: 0, done: 0 }
  const builder = {
    plan: () => ({ plan: { entity: { entityId: 'splat', name: 'splat' }, binding: {}, sourceToTarget: new Float32Array(16), sourceKey: 'slow-compile-key', revision: 0 }, warnings: [] }),
    async build() {
      state.builds++
      await new Promise(resolve => setTimeout(resolve, buildMs))
      state.done++
      return { compilation: { patches: [] }, warnings: [] }
    },
  }
  return { state, builder }
}

/** 夹具：真实 MuJoCoProvider + 假 worker；scenario/marker 经 config.env 传给子进程。 */
function providerFor(plan: Record<string, unknown>, buildMs = 800) {
  const scenario = join(base, 'scenario.json')
  writeFileSync(scenario, JSON.stringify(plan))
  const marker = join(base, 'marker.log')
  closeSync(openSync(marker, 'a'))
  const provider = new MuJoCoProvider({ pythonPath: PYTHON!, workerPath: WORKER })
  const config = (provider as unknown as { config: { env?: Record<string, string> } }).config
  config.env = { FAKE_SCENARIO: scenario, FAKE_MARKER: marker }
  const { state, builder } = controllableCompile(buildMs)
  ;(provider as unknown as { collisionBuilder: unknown }).collisionBuilder = builder
  return { provider, marker, state }
}

const cacheOf = (provider: MuJoCoProvider) => (provider as unknown as { collisionWorlds: Map<string, { key: string }> }).collisionWorlds
const stillAlive = async (provider: MuJoCoProvider, worldId: string) => (await provider.observe(worldId) as unknown as Frame & { stillAlive: boolean }).stillAlive

describe.skipIf(PYTHON === undefined)('MuJoCoProvider open 取消与碰撞缓存归属', () => {
  test('自动 worldId：取消发生在慢编译里——及时返回、本次 open 不发出、占位缓存不残留、旧 world 的条目不动', async () => {
    const { provider, marker, state } = providerFor({ ready: 'ok', phases: true }, 800)
    const primary = await provider.open(scene('cancel-primary'), { worldId: 'primary' })
    expect(primary.worldId).toBe('primary')
    const primaryEntry = cacheOf(provider).get('primary')
    expect(primaryEntry).toBeDefined()

    const controller = new AbortController()
    const cancelledAt = Date.now()
    const pending = failureOf(provider.open(scene('cancel-auto'), {}, controller.signal))
    await until(() => state.builds === 2, '被取消的 open 已经进入慢编译')
    controller.abort()
    const error = await pending
    expect(error.code).toBe('PROVIDER_START_CANCELLED')
    expect(Date.now() - cancelledAt).toBeLessThan(400)
    // 取消发生在请求发出之前：worker 只见过 primary 的 open（没有第二个世界被建出来）。
    expect(openRequests(marker)).toBe(1)
    expect(markerText(marker)).not.toContain('closed')

    await until(() => state.done === 2, '慢编译已经跑完')
    // 晚到的编译结果不写进占位键 `''`（否则会被下一个 open 当成自己的编译结果迁移过去）。
    expect([...cacheOf(provider).keys()]).toEqual(['primary'])
    expect(cacheOf(provider).get('primary')).toBe(primaryEntry)

    // 后续正常 open 不受影响：占位键迁移照旧、只交付自己的世界。
    const secondary = await provider.open(scene('cancel-after'), { worldId: 'secondary' })
    expect(secondary.worldId).toBe('secondary')
    expect([...cacheOf(provider).keys()].sort()).toEqual(['primary', 'secondary'])
    expect(await stillAlive(provider, 'primary')).toBe(true)
    await provider.dispose()
  }, 20_000)

  test('显式 worldId：取消只清本次写下的条目，与其他 world 的缓存互不影响', async () => {
    const { provider, marker, state } = providerFor({ ready: 'ok', phases: true }, 800)
    await provider.open(scene('explicit-primary'), { worldId: 'primary' })
    const primaryEntry = cacheOf(provider).get('primary')

    const controller = new AbortController()
    const pending = failureOf(provider.open(scene('explicit-secondary'), { worldId: 'secondary' }, controller.signal))
    await until(() => state.builds === 2, '被取消的 open 已经进入慢编译')
    controller.abort()
    expect((await pending).code).toBe('PROVIDER_START_CANCELLED')
    expect(openRequests(marker)).toBe(1)
    await until(() => state.done === 2, '慢编译已经跑完')
    // 这次 open 没交付：它的 worldId 上不留缓存条目；旧 world 的条目对象原样保留。
    expect([...cacheOf(provider).keys()]).toEqual(['primary'])
    expect(cacheOf(provider).get('primary')).toBe(primaryEntry)

    // 同一个 worldId 之后仍然能正常显式 open（取消没有污染它）。
    const secondary = await provider.open(scene('explicit-secondary'), { worldId: 'secondary' })
    expect(secondary.worldId).toBe('secondary')
    expect([...cacheOf(provider).keys()].sort()).toEqual(['primary', 'secondary'])
    expect(await stillAlive(provider, 'secondary')).toBe(true)
    await provider.dispose()
  }, 20_000)

  test('并行 sync 写下新缓存对象后本 open 才失败/取消：只回滚本次确实写的条目（budget 复核点）', async () => {
    // root 的复核点：`before` 对象身份**不是**“本次写”的所有权证明——同一 worldId 的并行 sync
    // 会在本 open 之后写一个新对象，按身份比较删键就会把**别人写的**条目清掉。
    // 时序不靠 sleep：假 worker 用 openDelayByWorld 把本次 open 的请求挂在 worker 里，
    // 「本次 open 已写缓存 → 并行 sync 又写一次 → 本次 open 才取消」这个交错因此是确定的。
    const scenario = join(base, 'scenario.json')
    writeFileSync(scenario, JSON.stringify({ ready: 'ok', phases: true, openDelayByWorld: { primary: 1500 } }))
    const marker = join(base, 'marker.log')
    closeSync(openSync(marker, 'a'))
    const provider = new MuJoCoProvider({ pythonPath: PYTHON!, workerPath: WORKER })
    ;(provider as unknown as { config: { env?: Record<string, string> } }).config.env = { FAKE_SCENARIO: scenario, FAKE_MARKER: marker }
    const { builder } = controllableCompile(0)
    ;(provider as unknown as { collisionBuilder: unknown }).collisionBuilder = builder
    const cache = cacheOf(provider)

    const controller = new AbortController()
    const pending = failureOf(provider.open(scene('owner-primary'), { worldId: 'primary' }, controller.signal))
    await until(() => provider.lifecyclePhases().some(phase => phase.name === 'opening-primary'),
      '本次 open 的请求已经到 worker 并挂住（说明它的 extras 已经跑完）')
    const ownEntry = cache.get('primary')
    // 前提：本次 open 确实写下了自己的条目，交错才有意义。
    expect(ownEntry).toBeDefined()

    // 并行 sync 同一个 worldId：它写的是**它自己**的新对象（对象身份与 open 的那次不同）。
    const syncing = provider.sync('primary', scene('owner-sync')).catch(() => undefined)
    await until(() => cache.get('primary') !== ownEntry, 'sync 的写入已经落到同一个键上')
    const syncEntry = cache.get('primary')
    expect(syncEntry).toBeDefined()

    controller.abort()
    expect((await pending).code).toBe('PROVIDER_START_CANCELLED')
    await syncing
    // 取消/失败只回滚本次 open 自己写下的那一条；sync 后写的对象必须原样留下。
    expect(cache.get('primary')).toBe(syncEntry)
    // 且后续仍按该条目复用（不因为一次失败的 open 丢掉已交付世界的编译结果与告警）。
    expect((cache.get('primary') as { key: string }).key).toBe('slow-compile-key#0')
    await provider.dispose()
  }, 20_000)

  test('正常路径不变：真实 SceneCollisionBuilder（无可信绑定）下 open 照常，共用 worker 的取消不碰旧世界', async () => {
    const scenario = join(base, 'scenario.json')
    writeFileSync(scenario, JSON.stringify({ ready: 'ok', phases: true, openDelayByWorld: { secondary: 700 } }))
    const marker = join(base, 'marker.log')
    closeSync(openSync(marker, 'a'))
    const provider = new MuJoCoProvider({ pythonPath: PYTHON!, workerPath: WORKER })
    ;(provider as unknown as { config: { env?: Record<string, string> } }).config.env = { FAKE_SCENARIO: scenario, FAKE_MARKER: marker }
    const primary = await provider.open(scene('real-primary'), { worldId: 'primary' })
    expect(primary.worldId).toBe('primary')
    // 无可信绑定：不编译、也不留缓存条目（真实 plan() 的门禁结果）。
    expect([...cacheOf(provider).keys()]).toEqual([])

    const controller = new AbortController()
    const pending = failureOf(provider.open(scene('real-secondary'), { worldId: 'secondary' }, controller.signal))
    await until(() => provider.lifecyclePhases().some(phase => phase.name === 'opening-secondary'), '传输层已记到 secondary 的 open 阶段')
    controller.abort()
    expect((await pending).code).toBe('PROVIDER_START_CANCELLED')
    // 共用 worker 上已交付的 primary 不被牵连；迟到建出来的 secondary 被就地关掉。
    expect(await stillAlive(provider, 'primary')).toBe(true)
    await until(() => markerText(marker).includes('closed secondary'), 'worker 收到了对取消世界的 close')
    expect((await provider.listWorlds()).map(handle => handle.worldId)).toEqual(['primary'])
    await provider.dispose()
  }, 20_000)
})
