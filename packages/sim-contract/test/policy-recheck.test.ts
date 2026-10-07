/**
 * **物理生命周期 ↔ 用户文件效果**的分界测试（本轮返修方向）：Agent 在 readonly/write/full 之间互切
 * **本身不能**结束物理世界、拦下 `sim_sync` 或暂停/继续；但**用户产物落盘**（截图/多机位/数据集导出）
 * 必须在真正写入的派发/发布边界按会话**当前**有效策略授权。
 *
 * 用真实子进程（`fixtures/fake-worker.py`）而不是替身：这里要证的正是"模式互切之后 worker 还在原地，
 * 且落盘请求压根没送到它"这件事——marker 里有没有 `request sync` / `capture outputDir=`、进程还在不在，
 * 都只能从真实进程上读。假 worker 不是第二个仿真引擎，也不证明任何物理行为。
 *
 * 钉住的六条：
 *   1. 模式互切（write→read-only→full）不改写 worker：sync 与暂停/继续照常派发，进程不重启，argv/facts 保持；
 *   2. 当前是 read-only：capture/export 在派发前被拒（worker 没收到请求），但旧 world 仍能 observe/sync/暂停/close；
 *   3. 从 full 收紧之后：老 worker 不能借旧许可写出用户产物（stale 拒绝），世界不被杀；
 *   4. IO 授权核不出来（会话已不在）：只拒绝本次写入，**不**结束 worker，原世界继续；
 *   5. 一个会话收紧只拒绝它自己的写入：另一个会话照常写、worker 与已交付世界一步不动；
 *   6. 未接线的 Provider 保持历史行为（没有核对就不新增拒绝）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProcessSimProvider, pathWithin, type SimWorkerLaunchSpec } from '../src/python-transport.ts'
import { isWorkerModeWithinCurrent } from '../src/session-launch.ts'
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
let externalOutputs: string[]
beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'lyapunov-policy-recheck-')); externalOutputs = [] })
afterEach(async () => { for (const output of [base, ...externalOutputs]) await rm(output, { recursive: true, force: true }) })

/** 一次会话运行空间：会话键 + 当前有效模式（`mode` 就是"用户在运行中改了权限"）。 */
interface SessionSpace {
  readonly sessionId: string
  readonly runtimeRoot: string
  mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** 每次启动按**当时**的模式写下的 facts；核对读现值，启动事实保持不动。 */
  launches: { mode: string; facts: SimWorkerLaunchSpec['facts'] }[]
}
function sessionSpace(name: string, mode: 'read-only' | 'workspace-write' | 'danger-full-access' = 'workspace-write'): SessionSpace {
  return { sessionId: name, runtimeRoot: join(base, name, 'sim'), mode, launches: [] }
}
function providerFor(space: SessionSpace, opts: { check?: SimWorkerLaunchSpec['check'] | 'throw'; plan?: Record<string, unknown> } = {}) {
  const marker = join(base, `${space.sessionId}.marker`)
  const scenario = join(base, `${space.sessionId}.scenario.json`)
  closeSync(openSync(marker, 'a'))
  writeFileSync(scenario, JSON.stringify(opts.plan ?? {}))
  const provider = new ProcessSimProvider({
    pythonPath: PYTHON!, workerPath: WORKER, engineName: 'fake-engine',
    env: { FAKE_MARKER: marker, FAKE_SCENARIO: scenario },
    launch: async input => {
      const mode = space.mode
      const facts = { sessionId: space.sessionId, mode, workspaceRoot: base, writableRoot: base, runtimeRoot: space.runtimeRoot }
      space.launches.push({ mode, facts })
      // 默认核对复用生产实现里的 NativeMode 单调包含比较，并回报会话**当前**有效策略：
      // IO 边界据此判定这次用户产物写入允不允许（现值更宽不算过期；收紧或未知模式才算）。
      const check: SimWorkerLaunchSpec['check'] = opts.check === 'throw'
        ? async () => { throw new Error('会话已不在本 Host，核不出有效策略') }
        : opts.check ?? (async worker => isWorkerModeWithinCurrent(worker.mode, space.mode)
          ? { stale: false as const, current: { mode: space.mode, workspaceRoot: base } }
          : { stale: true as const, detail: `本 worker 是按 ${worker.mode} 启动的，该会话当前有效策略已经是 ${space.mode}`, current: { mode: space.mode, workspaceRoot: base } })
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

const describeIfPython = PYTHON === undefined ? describe.skip : describe

describeIfPython('物理生命周期与 Agent 模式解耦：模式互切不结束世界，用户落盘另按当前授权判定', () => {
  test('模式互切不改写物理世界：sim_sync 与暂停/继续继续派发到同一 worker，不重启、旧 argv/facts 保持', async () => {
    const space = sessionSpace('space-switch')
    const { provider, marker } = providerFor(space, { plan: { initialPauseSupport: true } })
    const handle = await provider.open(scene('s1'), { worldId: 'w1' })
    expect(handle.supportsPause).toBe(true)
    const pid = pidsIn(marker).at(-1)!
    const factsAtLaunch = { ...(space.launches.at(-1)!.facts) }
    // 用户在运行中把同一会话的权限改了两次：物理世界（sync 与物理钟）继续，不重启、不结束。
    space.mode = 'read-only'
    await provider.sync('w1', { ...scene('s1'), revision: 1 })
    expect((await provider.setPaused('w1', true, 1)).status).toBe('paused')
    space.mode = 'danger-full-access'
    await provider.sync('w1', { ...scene('s1'), revision: 2 })
    expect((await provider.setPaused('w1', false, 1)).status).toBe('ready')
    const written = markerText(marker)
    expect(written).toContain('request sync')
    expect(written).toContain('request set_paused')
    expect(alive(pid)).toBe(true)
    // 没有重启、没有重新解析策略：launches 只有最初那一次，启动事实保持启动时那份。
    expect(space.launches).toHaveLength(1)
    expect(space.launches[0].mode).toBe('workspace-write')
    expect(space.launches[0].facts).toMatchObject(factsAtLaunch)
    expect(provider.executionFacts()).toContain('模式=workspace-write')
    await provider.dispose()
  })

  test('当前是 read-only：capture/export 派发前被拒、worker 没收到请求；旧 world 仍能 observe/sync/暂停/close', async () => {
    const space = sessionSpace('space-readonly', 'read-only')
    const { provider, marker } = providerFor(space, { plan: { initialPauseSupport: true } })
    await provider.open(scene('s1'), { worldId: 'w1' })
    const pid = pidsIn(marker).at(-1)!
    const captureTarget = join(base, 'captures-readonly')
    const captureFailure = await failureOf(provider.capture('w1', { outputDir: captureTarget }))
    expect(captureFailure.code).toBe('SIM_MEDIA_POLICY_READ_ONLY')
    expect(captureFailure.message).toContain('read-only')
    expect(captureFailure.message).toContain('denied before dispatch')
    expect(captureFailure.message).not.toContain('denied before publication')
    const exportFailure = await failureOf(provider.exportCameraDataset('w1', { outputDir: captureTarget, captureIds: ['capture-1'] }))
    expect(exportFailure.code).toBe('SIM_MEDIA_POLICY_READ_ONLY')
    // worker 没有收到任何落盘请求，也没有产物。
    expect(markerText(marker)).not.toContain('capture outputDir=')
    expect(existsSync(captureTarget)).toBe(false)
    // 读与物理世界不受影响：observe/sync/暂停/close 照常，进程还在。
    await provider.observe('w1', {})
    await provider.sync('w1', { ...scene('s1'), revision: 1 })
    expect(markerText(marker)).toContain('request observe')
    expect(markerText(marker)).toContain('request sync')
    expect(alive(pid)).toBe(true)
    await provider.close('w1')
    expect(markerText(marker)).toContain('closed w1')
    await provider.dispose()
  })

  test('从 full 收紧之后：老 worker 不能借旧许可写出用户产物（stale 拒绝），世界不被杀、sync 继续', async () => {
    const space = sessionSpace('space-full-tighten', 'danger-full-access')
    const { provider, marker } = providerFor(space)
    await provider.open(scene('s1'), { worldId: 'w1' })
    const pid = pidsIn(marker).at(-1)!
    // full 下跨目录落盘正常：目标在工作区外的另一目录，照常派发并由 worker 写出。
    const external = await mkdtemp(join(tmpdir(), 'lyapunov-policy-full-output-'))
    externalOutputs.push(external)
    const fullTarget = join(external, 'deep')
    expect(pathWithin(base, fullTarget)).toBe(false)
    await provider.capture('w1', { outputDir: fullTarget })
    expect(existsSync(join(fullTarget, 'shot.png'))).toBe(true)
    // 用户在运行中收紧成 read-only：老的 full worker 不能再借旧许可写出用户产物。
    space.mode = 'read-only'
    const target = join(base, 'captures-full')
    const failure = await failureOf(provider.capture('w1', { outputDir: target }))
    expect(failure.code).toBe('SIM_MEDIA_POLICY_STALE')
    expect(failure.message).toContain('danger-full-access')
    expect(failure.message).toContain('read-only')
    expect(markerText(marker)).not.toContain(`capture outputDir=${target}`)
    expect(existsSync(target)).toBe(false)
    // 拒绝只落在这次写入上：worker 还在，物理世界照常 sync/observe，不重启。
    await provider.sync('w1', { ...scene('s1'), revision: 1 })
    expect(markerText(marker)).toContain('request sync')
    expect(alive(pid)).toBe(true)
    expect(space.launches).toHaveLength(1)
    await provider.dispose()
  })

  test('IO 授权核不出来时：只拒绝本次写入，不结束 worker，原世界继续', async () => {
    const space = sessionSpace('space-unverified')
    const { provider, marker } = providerFor(space, { check: 'throw' })
    await provider.open(scene('s1'), { worldId: 'w1' })
    const pid = pidsIn(marker).at(-1)!
    const failure = await failureOf(provider.capture('w1', { outputDir: join(base, 'captures-unverified') }))
    expect(failure.code).toBe('SIM_MEDIA_POLICY_UNVERIFIED')
    expect(markerText(marker)).not.toContain('capture outputDir=')
    // 失败关闭不等于杀世界：worker 还活着，物理世界照常同步。
    expect(alive(pid)).toBe(true)
    await provider.sync('w1', { ...scene('s1'), revision: 1 })
    expect(markerText(marker)).toContain('request sync')
    await provider.dispose()
  })

  test('一个会话收紧只拒绝它自己的写入：另一个会话照常写，两个 worker 与已交付世界一步不动', async () => {
    const spaceA = sessionSpace('tighten-a'), spaceB = sessionSpace('tighten-b')
    const a = providerFor(spaceA), b = providerFor(spaceB)
    await a.provider.open(scene('sA'), { worldId: 'wA' })
    await b.provider.open(scene('sB'), { worldId: 'wB' })
    const pidA = pidsIn(a.marker).at(-1)!
    const pidB = pidsIn(b.marker).at(-1)!
    spaceA.mode = 'read-only'
    const failure = await failureOf(a.provider.capture('wA', { outputDir: join(base, 'captures-a') }))
    expect(failure.code).toBe('SIM_MEDIA_POLICY_STALE')
    // A 只是不能写：它的 worker 与世界还在，sync 照常。
    await a.provider.sync('wA', { ...scene('sA'), revision: 1 })
    expect(alive(pidA)).toBe(true)
    // B 完全不受影响：照常派发落盘（假 worker 真写文件），worker 不重启、世界照常。
    const targetB = join(base, 'captures-b')
    await b.provider.capture('wB', { outputDir: targetB })
    expect(markerText(b.marker)).toContain(`capture outputDir=${targetB}`)
    expect(existsSync(join(targetB, 'shot.png'))).toBe(true)
    expect(alive(pidB)).toBe(true)
    expect(pidsIn(b.marker)).toEqual([pidB])
    await a.provider.dispose(); await b.provider.dispose()
  })

  test('未接线的 Provider 保持历史行为（没有核对就没有新增拒绝，落盘照常）', async () => {
    const marker = join(base, 'unwired.marker')
    closeSync(openSync(marker, 'a'))
    const provider = new ProcessSimProvider({ pythonPath: PYTHON!, workerPath: WORKER, engineName: 'fake-engine', env: { FAKE_MARKER: marker } })
    await provider.open(scene('s1'), { worldId: 'w1' })
    const target = join(base, 'captures-unwired')
    await provider.capture('w1', { outputDir: target })
    expect(markerText(marker)).toContain(`capture outputDir=${target}`)
    expect(provider.executionFacts()).toContain('未接线')
    await provider.dispose()
  })
})
