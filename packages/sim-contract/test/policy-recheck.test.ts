/**
 * 运行中收紧权限（P0-05 缺口 2）的**控制边界**测试：worker 的沙箱在启动时绑定，会话模式却可以在
 * 运行中被收紧——收紧之后，下一次相关（写类）操作**绝不能沿用旧许可继续写**。
 *
 * 用真实子进程（`fixtures/fake-worker.py`）而不是替身：这里要证的正是"旧 worker 在旧许可下继续干活"
 * 这件事没发生——marker 里有没有 `request sync`、进程还在不在，都只能从真实进程上读。假 worker
 * 不是第二个仿真引擎，也不证明任何物理行为。
 *
 * 钉住的四条：
 *   1. 核对说"现值一致"时，写类操作照常走到 worker（不是把核对变成新的拒绝）；
 *   2. 核对说"这只 worker 带的是旧许可"时：本次操作被拒、**worker 根本没收到请求**、且这只 worker
 *      按既有释放语义结束（SIGTERM→SIGKILL，进程真实消失）；
 *   3. 一次因收紧而结束的会话必须能按**当前**策略重新开回来（重新 open 会重新解析策略、重新启动），
 *      不能因为上一只 worker 的 facts 过期就永久开不回来；
 *   4. 一个会话的收紧只结束它自己的 worker：同进程里的另一个 Provider（= 另一个会话）一步不动。
 * 核不出结论（会话已不在等）时只拒绝本次操作、**不**结束 worker——无法证明许可过期就不拿它冒险。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProcessSimProvider, type SimWorkerLaunchSpec } from '../src/python-transport.ts'
import { SimError } from '../src/index.ts'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'

const WORKER = new URL('./fixtures/fake-worker.py', import.meta.url).pathname

function systemPython(): string | undefined {
  for (const candidate of ['/usr/bin/python3', '/usr/local/bin/python3', '/bin/python3']) if (existsSync(candidate)) return candidate
  return undefined
}

const PYTHON = systemPython()
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

let base: string
beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'lyapunov-policy-recheck-')) })
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

/** 一次会话运行空间：会话键 + 当前有效模式（`setMode` 就是"用户在运行中改了权限"）。 */
interface SessionSpace {
  readonly sessionId: string
  readonly runtimeRoot: string
  mode: 'read-only' | 'workspace-write'
  /** 每次启动按**当时**的模式写下的 facts 是否过期：核对读的就是这里。 */
  launches: { mode: string; facts: SimWorkerLaunchSpec['facts'] }[]
}
function sessionSpace(name: string, mode: 'read-only' | 'workspace-write' = 'workspace-write'): SessionSpace {
  return { sessionId: name, runtimeRoot: join(base, name, 'sim'), mode, launches: [] }
}
function providerFor(space: SessionSpace, opts: { check?: SimWorkerLaunchSpec['check'] | 'throw' } = {}) {
  const marker = join(base, `${space.sessionId}.marker`)
  closeSync(openSync(marker, 'a'))
  const provider = new ProcessSimProvider({
    pythonPath: PYTHON!, workerPath: WORKER, engineName: 'fake-engine',
    env: { FAKE_MARKER: marker },
    launch: async input => {
      const mode = space.mode
      const facts = { sessionId: space.sessionId, mode, workspaceRoot: base, writableRoot: base, runtimeRoot: space.runtimeRoot }
      space.launches.push({ mode, facts })
      const check: SimWorkerLaunchSpec['check'] = opts.check === 'throw'
        ? async () => { throw new Error('会话已不在本 Host，核不出有效策略') }
        : opts.check ?? (async current => current.mode === space.mode
          ? { stale: false as const }
          : { stale: true as const, detail: `本 worker 是按 ${current.mode} 启动的，该会话当前有效策略已经是 ${space.mode}` })
      return {
        argv: [input.pythonPath, '-u', input.workerPath],
        env: { ...input.env, LYAPUNOV_SIM_SESSION: space.sessionId, LYAPUNOV_SIM_RUNTIME_ROOT: space.runtimeRoot, LYAPUNOV_SIM_SANDBOX_MODE: mode },
        facts, check,
      }
    },
  })
  return { provider, marker }
}
const markerText = (marker: string) => readFileSync(marker, 'utf8')
function pidsIn(marker: string): number[] {
  return [...markerText(marker).matchAll(/started pid=(\d+)/g)].map(match => Number(match[1]))
}
function scene(sceneId: string): SceneSnapshot {
  return { sceneId, revision: 0, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' }, entities: [] }
}
async function failureOf(run: Promise<unknown>): Promise<SimError> {
  try { await run } catch (error) { return error as SimError }
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

const describeIfPython = PYTHON === undefined ? describe.skip : describe

describeIfPython('运行中收紧权限：写类操作前核对这只 worker 还带不带着旧许可', () => {
  test('现值一致时写类操作照常执行（核对不是新增的拒绝）；worker 真的收到了会话身份与模式', async () => {
    const space = sessionSpace('space-ok')
    const { provider, marker } = providerFor(space)
    const handle = await provider.open(scene('s1'), { worldId: 'w1' })
    expect(handle.worldId).toBe('w1')
    await provider.sync('w1', { ...scene('s1'), revision: 1 })
    expect(markerText(marker)).toContain('request sync')
    // worker 自报的运行时事实：启动接线给的身份/模式/运行根确实进了 worker 进程。
    expect(provider.executionFacts()).toContain(`会话=${space.sessionId}`)
    expect(provider.executionFacts()).toContain('模式=workspace-write')
    await provider.dispose()
  })

  test('收紧成 read-only 之后：写类操作被拒、worker 根本没收到请求、这只 worker 按既有释放语义结束', async () => {
    const space = sessionSpace('space-tighten')
    const { provider, marker } = providerFor(space)
    await provider.open(scene('s1'), { worldId: 'w1' })
    const pid = pidsIn(marker).at(-1)!
    expect(alive(pid)).toBe(true)
    // 用户在运行中把该会话收紧成 read-only：这正是修前没有覆盖的方向（只测过"只读仍被拒"）。
    space.mode = 'read-only'
    const failure = await failureOf(provider.sync('w1', { ...scene('s1'), revision: 1 }))
    expect(failure.code).toBe('SIM_SESSION_POLICY_CHANGED')
    expect(failure.message).toContain('workspace-write')
    expect(failure.message).toContain('read-only')
    // 关键负例：worker 没有收到这次 sync——没有"按旧许可继续写"这回事。
    expect(markerText(marker)).not.toContain('request sync')
    // 这只 worker 已按既有释放语义结束（真进程消失），不是无声留着。
    await until(() => !alive(pid), '过期 worker 真实退出')
    await provider.dispose()
  })

  test('被收紧结束的会话能按**当前**策略重新开回来（不会拿过期 facts 永久拦住显式 open）', async () => {
    const space = sessionSpace('space-reopen')
    const { provider, marker } = providerFor(space)
    await provider.open(scene('s1'), { worldId: 'w1' })
    const firstPid = pidsIn(marker).at(-1)!
    space.mode = 'read-only'
    expect((await failureOf(provider.sync('w1', { ...scene('s1'), revision: 1 }))).code).toBe('SIM_SESSION_POLICY_CHANGED')
    await until(() => !alive(firstPid), '过期 worker 真实退出')
    // 收紧之后**仍处于只读**时显式重开：build 世界本身不是写，必须按当前（read-only）策略真的开起来——
    // 拿上一只 worker 的旧 facts 去拦这一次 open，就等于「一次收紧把这个会话永久报废」。
    const reopened = await provider.open(scene('s1'), { worldId: 'w1' })
    expect(reopened.worldId).toBe('w1')
    expect(pidsIn(marker).at(-1)).not.toBe(firstPid)
    expect(space.launches.map(item => item.mode)).toEqual(['workspace-write', 'read-only'])
    // worker 自报：它这次真的按 read-only 起、拿到的还是同一条会话身份。
    expect(provider.executionFacts()).toContain('模式=read-only')
    expect(provider.executionFacts()).toContain(`会话=${space.sessionId}`)
    // 现值一致时写类操作不再被核对拦住：只读这条约束由 worker 自己的沙箱执行，不由核对假装执行。
    await provider.sync('w1', { ...scene('s1'), revision: 1 })
    expect(markerText(marker)).toContain('request sync')
    await provider.dispose()
  })

  test('收紧只结束本会话自己的 worker：同进程里的另一个会话一步不动', async () => {
    const spaceA = sessionSpace('session-a'), spaceB = sessionSpace('session-b')
    const a = providerFor(spaceA), b = providerFor(spaceB)
    await a.provider.open(scene('sA'), { worldId: 'wA' })
    await b.provider.open(scene('sB'), { worldId: 'wB' })
    const pidB = pidsIn(b.marker).at(-1)!
    spaceA.mode = 'read-only'
    expect((await failureOf(a.provider.sync('wA', { ...scene('sA'), revision: 1 }))).code).toBe('SIM_SESSION_POLICY_CHANGED')
    await until(() => !alive(pidsIn(a.marker).at(-1)!), 'A 的过期 worker 退出')
    // B 的 worker 与它已交付的世界照常：能同步、进程还在。
    await b.provider.sync('wB', { ...scene('sB'), revision: 1 })
    expect(alive(pidB)).toBe(true)
    expect(pidsIn(b.marker)).toEqual([pidB])
    expect(b.provider.executionFacts()).toContain('模式=workspace-write')
    await a.provider.dispose(); await b.provider.dispose()
  })

  test('核不出结论时只拒绝本次操作，**不**结束 worker（无法证明许可过期就不冒险销毁世界）', async () => {
    const space = sessionSpace('space-unverified')
    const { provider, marker } = providerFor(space, { check: 'throw' })
    await provider.open(scene('s1'), { worldId: 'w1' })
    const pid = pidsIn(marker).at(-1)!
    const failure = await failureOf(provider.sync('w1', { ...scene('s1'), revision: 1 }))
    expect(failure.code).toBe('SIM_SESSION_POLICY_UNVERIFIED')
    expect(markerText(marker)).not.toContain('request sync')
    expect(alive(pid)).toBe(true)
    await provider.dispose()
  })

  test('未接线的 Provider 保持历史行为（没有 check 就没有核对，也不假装核对过）', async () => {
    const marker = join(base, 'unwired.marker')
    closeSync(openSync(marker, 'a'))
    const provider = new ProcessSimProvider({ pythonPath: PYTHON!, workerPath: WORKER, engineName: 'fake-engine', env: { FAKE_MARKER: marker } })
    await provider.open(scene('s1'), { worldId: 'w1' })
    await provider.sync('w1', { ...scene('s1'), revision: 1 })
    expect(markerText(marker)).toContain('request sync')
    expect(provider.executionFacts()).toContain('未接线')
    await provider.dispose()
  })
})
