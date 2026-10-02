/**
 * ISAAC-02 收口（T26）：入口 flag `--isaac-startup-budget` 与 `IsaacProvider.open(signal)`。
 *
 * **装配层／桩证据，不是引擎实测**：本机没有 Isaac Kit/SDK，本文件不启动任何 Isaac 进程。
 * 覆盖两类证据：
 *  1. 入口（真实子进程）：`script/{launch,architecture}.ts` 的 flag 解析——非 `--engine isaac` 给该 flag 明确报错；
 *     `launch.ts` 显式给值时把 `startupBudgetMs` 写进 Profile patch（插件配置），**不给时不带该键**（负对照）、
 *     非法值原样带出（不在入口层校验／不加默认值）。patch 落在隔离的 `--runtime-root` 临时目录里，跑完即杀进程组。
 *  2. Provider（桩）：`IsaacProvider.open(snapshot, options, signal)` 把调用方取消交给传输层——未 ready 的启动
 *     被取消后返回可解释的 `PROVIDER_START_CANCELLED`（含 pid/阶段轨迹）、自有进程被释放；非法预算仍由传输层
 *     构造函数当场 `RangeError`；未 ready 时 `dispose()` 不悬空的既有语义不变。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { IsaacProvider } from '../src/provider.ts'
import type { ProcessSimProvider, ProcessSimConfig } from '../../sim-contract/src/python-transport.ts'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'

const repoRoot = resolve(import.meta.dirname, '..', '..', '..')
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
function systemPython(): string | undefined {
  for (const candidate of ['/usr/bin/python3', '/usr/local/bin/python3', '/bin/python3']) if (existsSync(candidate)) return candidate
  return undefined
}
const PYTHON = systemPython()
/** Provider 把本次 open 交给传输层后，那个真实的传输层对象就在 `pending` 里（测试用窄化探针，不改产品代码）。 */
type PendingProbe = { pending: Map<string, ProcessSimProvider> }

const scene = (sceneId = 'entry-scene'): SceneSnapshot => ({ sceneId, revision: 0, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' }, entities: [] })

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`等待超时：${what}`)
}

async function rejectionOf(run: Promise<unknown>): Promise<unknown> {
  try { await run } catch (error) { return error }
  throw new Error('期望这次调用失败，但它成功了')
}

// ---------------------------------------------------------------- 入口 flag（真实子进程）

function runEntry(script: string, args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ...env },
  })
}

test('非 --engine isaac 时给 --isaac-startup-budget：两个入口都明确报错', () => {
  // 与 --isaac-device/--isaac-rendering 同一处守卫；该守卫在两个入口都位于任何重活之前（不建 Profile、不拉 Blender MCP）。
  for (const script of ['script/launch.ts', 'script/architecture.ts']) {
    const run = runEntry(script, ['--engine', 'mujoco', '--isaac-startup-budget', '1000'])
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('Isaac选项需要--engine isaac')
  }
}, 60_000)

/** 递归找 launch.ts 写下的 Profile patch（插件配置真值就在里面）。 */
function findPatch(root: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) { const found = findPatch(path); if (found) return found }
    if (entry.isFile() && entry.name === 'lyapunov-runtime.patch.yml') return path
  }
  return undefined
}

/** 跑一次 launch.ts（隔离 runtime-root），读它写出的 patch；读完立刻 SIGKILL 整个进程组，不留 DSH 子进程。 */
async function patchFromLaunch(budgetFlag: string | undefined, options: { device?: string; rendering?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Record<string, unknown>> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'lyapunov-isaac02-entry-'))
  const args = ['script/launch.ts', '--mode', 'developer', '--engine', 'isaac', '--surface', 'web',
    '--runtime-root', runtimeRoot, '--port', '0', ...(budgetFlag === undefined ? [] : ['--isaac-startup-budget', budgetFlag]),
    ...(options.device === undefined ? [] : ['--isaac-device', options.device]), ...(options.rendering === undefined ? [] : ['--isaac-rendering', options.rendering])]
  const environment: NodeJS.ProcessEnv = { ...process.env, ...options.env, LYAPUNOV_SESSION_UNDO: '0' }
  if (options.env?.LYAPUNOV_ISAAC_DEVICE === undefined) delete environment.LYAPUNOV_ISAAC_DEVICE
  if (options.env?.LYAPUNOV_ISAAC_RENDERING === undefined) delete environment.LYAPUNOV_ISAAC_RENDERING
  const child = spawn(process.execPath, args, {
    cwd: repoRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,   // 不触发插件构建，验证只关心 patch
  })
  let stderr = ''
  child.stderr!.setEncoding('utf8').on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000) })
  const killGroup = () => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* 已退出 */ } }
  try {
    let patch: string | undefined
    await until(() => {
      patch = findPatch(runtimeRoot)
      if (patch !== undefined) return true
      // 进程先退出＝这条入口路径没走到写 patch：立刻失败并带上真实 stderr，不要空等满 60s。
      if (child.exitCode !== null) throw new Error(`launch.ts 在写出 Profile patch 之前退出（code=${child.exitCode}）：${stderr.slice(-600)}`)
      return false
    }, `launch.ts 写下 Profile patch（stderr 尾部：${stderr.slice(-400)}）`, 60_000)
    const text = readFileSync(patch!, 'utf8')
    const plugins = (JSON.parse(text.replace(/^- insert:\s*/, '').split('\n')[0]!.trim()) as { id: string; config?: Record<string, unknown> }[])
    const isaac = plugins.find(plugin => plugin.id === 'lyapunov-sim-isaac')
    if (isaac === undefined) throw new Error('patch 里没有 lyapunov-sim-isaac 插件')
    return isaac.config ?? {}
  } finally {
    killGroup()
    await new Promise<void>(done => { child.once('close', () => done()); setTimeout(done, 2000) })
    await rm(runtimeRoot, { recursive: true, force: true })
  }
}

test('入口接线：显式给 --isaac-startup-budget → 该键进入 sim-isaac 插件配置；不给 → 不带该键（负对照）', async () => {
  const configured = await patchFromLaunch('1234')
  expect(configured.startupBudgetMs).toBe(1234)
  expect(configured.physicsDevice).toBe('cuda:0')       // 产品缺省实际装配 GPU 物理
  expect(configured.rendering).toBe('none')             // CUDA 物理不冒充默认 RTX
  const explicitCpu = await patchFromLaunch(undefined, { device: 'cpu', rendering: 'none' })
  expect(explicitCpu).toMatchObject({ physicsDevice: 'cpu', rendering: 'none' })
  const environmentCpu = await patchFromLaunch(undefined, { env: { LYAPUNOV_ISAAC_DEVICE: 'cpu', LYAPUNOV_ISAAC_RENDERING: 'none' } })
  expect(environmentCpu).toMatchObject({ physicsDevice: 'cpu', rendering: 'none' })
  const absent = await patchFromLaunch(undefined)
  expect('startupBudgetMs' in absent).toBe(false)       // 负对照：入口不加默认值
}, 180_000)

test('入口不校验、不夹取：非法值原样带出，拒绝留给传输层唯一一处 RangeError', async () => {
  const configured = await patchFromLaunch('0')
  expect(configured.startupBudgetMs).toBe(0)            // 入口只做字符串→数字，不静默变成"不设上限"或默认值
}, 120_000)

// ---------------------------------------------------------------- Provider：signal 与非法预算（桩）

let base: string
let hangWorker: string
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'lyapunov-isaac02-cancel-'))
  hangWorker = join(base, 'hang-worker.py')
  // 永不 ready、不读 stdin：把启动钉在"尚未 ready"，用来验证取消真的到达传输层。
  writeFileSync(hangWorker, 'import time\ntime.sleep(3600)\n')
})
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

const providerFor = (config: Partial<ProcessSimConfig> = {}) => new IsaacProvider({
  pythonPath: PYTHON ?? '/nonexistent/python3', workerPath: hangWorker, cacheRoot: join(base, 'cache'), ...config,
})

describe.skipIf(PYTHON === undefined)('IsaacProvider.open(signal)（桩证据，非引擎实测）', () => {
  test('传 signal 后取消未 ready 的启动：可解释的取消结果 + 自有进程被释放 + dispose 不悬空', async () => {
    const provider = providerFor()
    const controller = new AbortController()
    const opening = provider.open(scene(), { worldId: 'cancelled' }, controller.signal)
    void opening.catch(() => undefined)
    const pending = (provider as unknown as PendingProbe).pending
    await until(() => pending.get('cancelled') !== undefined, 'Provider 已把本次 open 交给传输层')
    const pid = pending.get('cancelled')!.pid!
    expect(alive(pid)).toBe(true)
    controller.abort()
    // 取消真的到达传输层时立刻结算；没接线时它会一直挂着（桩 worker 永不 ready），5s 足够区分两者。
    const outcome = await Promise.race([
      opening.then(() => ({ kind: 'resolved' as const }), (error: unknown) => ({ kind: 'rejected' as const, error })),
      new Promise<{ kind: 'pending' }>(done => setTimeout(() => done({ kind: 'pending' }), 5000)),
    ])
    if (outcome.kind === 'pending') {
      await provider.dispose().catch(() => undefined)
      throw new Error('取消没有到达传输层：signal.abort() 之后 open 仍未结算（仍未 ready 的启动没有被结束）')
    }
    if (outcome.kind === 'resolved') throw new Error('取消没有到达传输层：本次 open 反而成功了')
    const error = outcome.error as { code?: string; message?: string }
    expect(error.code).toBe('PROVIDER_START_CANCELLED')
    expect(error.message).toContain(`pid=${pid}`)
    expect(error.message).toContain('阶段轨迹=')
    await until(() => !alive(pid), '被取消的 worker 子进程退出')
    // 取消只结束本次尚未交付的启动，不改 dispose 语义：仍未 ready 时 dispose 依旧按时返回。
    const startedAt = Date.now()
    await provider.dispose()
    expect(Date.now() - startedAt).toBeLessThan(5000)
    expect((await rejectionOf(provider.open(scene(), { worldId: 'after-dispose' })) as { code?: string }).code).toBe('PROVIDER_CLOSED')
  }, 60_000)

  test('未 ready 时 dispose（不传 signal 的既有路径）仍不悬空', async () => {
    const provider = providerFor()
    const opening = provider.open(scene(), { worldId: 'idle' })
    void opening.catch(() => undefined)
    const pending = (provider as unknown as PendingProbe).pending
    await until(() => pending.get('idle') !== undefined, 'Provider 已把本次 open 交给传输层')
    const pid = pending.get('idle')!.pid!
    const startedAt = Date.now()
    await provider.dispose()
    expect(Date.now() - startedAt).toBeLessThan(5000)
    await until(() => !alive(pid), '尚未 ready 的 worker 被按归属终止')
    expect((await rejectionOf(opening) as { code?: string }).code).toBe('PROVIDER_CLOSED')
  }, 60_000)

  test('非法预算不被绕过：0／负数／NaN 仍由传输层构造函数当场 RangeError', async () => {
    for (const value of [0, -5, Number.NaN]) {
      const provider = providerFor({ startupBudgetMs: value })
      const error = await rejectionOf(provider.open(scene(), { worldId: `invalid-${String(value)}` }))
      expect(error).toBeInstanceOf(RangeError)
      expect((error as RangeError).message).toContain('startupBudgetMs')
      expect((provider as unknown as PendingProbe).pending.size).toBe(0)
    }
  }, 60_000)

  test('显式预算经入口口径到达传输层后仍按值到期', async () => {
    const provider = providerFor({ startupBudgetMs: 400 })
    const opening = provider.open(scene(), { worldId: 'budgeted' })
    void opening.catch(() => undefined)
    const pending = (provider as unknown as PendingProbe).pending
    await until(() => pending.get('budgeted') !== undefined, 'Provider 已把本次 open 交给传输层')
    expect(pending.get('budgeted')!.config.startupBudgetMs).toBe(400)
    const error = await rejectionOf(opening) as { code?: string; message?: string }
    expect(error.code).toBe('PROVIDER_START_TIMEOUT')
    expect(error.message).toContain('400ms')
  }, 60_000)
})
