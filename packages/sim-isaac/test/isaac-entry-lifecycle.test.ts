/**
 * W3（ISAAC-01／ISAAC-02）回归：**装配期不撒谎** ＋ **Kit 未 ready 时的等待/取消/关闭读回**。
 *
 * 本文件**不启动 Kit**（真实 Kit 读数在 `bugfixHistory/ISAAC-ENTRY-LIFECYCLE-20260926.md` §3）：
 * 引擎进程由只实现行协议的最小假 worker 顶替，钉住的是装配与生命周期这两层的行为：
 *   ① ISAAC-01：无类型 Profile 配置里的未知取值在**装配期**被拒（不再静默按 CPU/none 组装），
 *      合法取值被显式回填进 Provider —— 装配用什么值 == Provider 拿到什么值；
 *   ② ISAAC-02：`lifecyclePhases(worldId)` 按 world 归因（多世界并发时不会把别人的轨迹当成它的）；
 *      尚未交付的 world 调 `close()` 给真实状态（WORLD_STARTING）而不是 WORLD_NOT_FOUND；
 *      关闭成功后不再留下"正在关闭"（第二次 close / 后续寻址不再被陈旧状态误导）；
 *      未 ready 时 `dispose()` 仍不悬空、进程按归属结束。
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// 测试专用替身：**真实 `plugin.apply()` / 真实 session launcher / 真实 Provider** 都照跑，
// 只有 `environment-readiness` 的两个探针被换成"可控夹具"（见下方 mock 段）——"无 GPU 会话"
// 因此可重复构造，不再依赖宿主恰好没有 `/dev/nvidia*`。
import * as realEnvironment from '../../lyapunov-shell/src/environment-readiness.ts'
import type { GpuFacts } from '../../lyapunov-shell/src/environment-readiness.ts'
import type { IsaacProvider } from '../src/provider.ts'
import { SimError } from '../../sim-contract/src/index.ts'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'

/**
 * 可控的"无 GPU 会话"探针夹具（GATE-AB-20260927）。
 *
 * 为什么必须换成夹具：原用例 `test.skipIf(PYTHON === undefined || probeGpuDeviceVisibility().visible)`
 * 在**GPU 可见的宿主**上整条跳过（基线 7 pass 掉到 6 pass/1 skip，且发布门按 skip 未豁免 + 下限 7 判红）。
 * 但"配置要求 GPU 而本会话没有设备节点 ⇒ 装配点必须明确拒绝"是**合同分支**，不能由宿主决定跑不跑。
 * 这里把两个探针换成同一份"卡在、驱动在、`/dev` 无字符设备"的事实（device-hidden）：
 *  · `probeGpuDeviceVisibility()` → `visible:false`（装配点守卫触发）；
 *  · `probeGpuFacts()` → 与之一致的 `device-hidden` facts（`gpuRefusal` 据此把原因说成"会话看不见设备"）。
 * 两个探针**不许互相矛盾**（这正是任务要求的那条不变式）；`forceHiddenGpu=false` 时原样委托真实现，
 * 所以同文件其余生命周期用例不受影响。
 */
const GPU_MARKER = 'MOCK-NO-GPU-SESSION-DRIVER-595.91.07'
function hiddenGpuFacts(): GpuFacts {
  return {
    probeError: null,
    driverVersion: `NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  ${GPU_MARKER}  Release Build`,
    driverGpuEntries: ['0000:02:00.0'],
    deviceNodes: [],
    deviceExtras: [],
    pciDevices: ['0000:02:00.0'],
    pciIds: ['0000:02:00.0 10de:2c58 class=0x030000'],
    driverGpuModels: ['0000:02:00.0 NVIDIA GeForce RTX 5090 Laptop GPU'],
    smi: { present: true, ok: false, output: '', error: '' },
    capacity: null, requiredVramMiB: null, minDriverMajor: null,
  }
}
let forceHiddenGpu = false
const realProbeVisibility = realEnvironment.probeGpuDeviceVisibility
const realProbeFacts = realEnvironment.probeGpuFacts
mock.module('../../lyapunov-shell/src/environment-readiness.ts', () => ({
  ...realEnvironment,
  probeGpuDeviceVisibility: (...args: Parameters<typeof realProbeVisibility>) =>
    forceHiddenGpu
      ? { visible: false, deviceNodes: [], deviceExtras: [], devReadable: true, exposable: ['/mock/never-exposed'] }
      : realProbeVisibility(...args),
  probeGpuFacts: (...args: Parameters<typeof realProbeFacts>) =>
    forceHiddenGpu ? hiddenGpuFacts() : realProbeFacts(...args),
}))
// mock **之后**再动态 import：plugin 拿到的就是上面那份替身。
const { effectiveIsaacEngineConfig, apply: applyIsaacPlugin } = await import('../src/plugin.ts')

const PYTHON = ['/usr/bin/python3', '/usr/local/bin/python3', '/bin/python3'].find(candidate => existsSync(candidate))
const SESSION = 'w3-entry-lifecycle'
const scene = (sceneId = 'w3-scene'): SceneSnapshot => ({
  sceneId, revision: 0,
  coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' },
  entities: [],
})

const scratch: string[] = []
afterEach(async () => { for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true }) })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function bounded<T>(promise: Promise<T>, ms = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('操作没有在预算内结算')), ms)
    })])
  } finally { clearTimeout(timer) }
}
function rejection(promise: Promise<unknown>): Promise<SimError> {
  return promise.then(() => { throw new Error('期望失败，但它成功了') }, error => error as SimError)
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
async function until(check: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)) }
  throw new Error(`等待超时：${what}`)
}

/** 只实现行协议的最小假 worker：`hang` 世界永不 ready；`slow` 世界先报阶段再延迟 ready；其余立刻 ready。 */
const WORKER_SOURCE = `import json, os, sys, time
def emit(value): print(json.dumps(value), flush=True)
emit({'event': 'ready', 'engine': 'isaac', 'version': '0.0.0-fake', 'pid': os.getpid()})
worlds = {}
for line in sys.stdin:
    request = json.loads(line)
    method, args = request.get('method'), request.get('args', {})
    if method == 'open':
        world = args.get('options', {}).get('worldId') or 'w'
        if 'hang' in world:
            emit({'event': 'phase', 'phase': 'kit-app-start'})
            time.sleep(3600)
            continue
        if 'slow' in world:
            emit({'event': 'phase', 'phase': 'kit-app-start'})
            time.sleep(2.0)
        result = {'worldId': world, 'sceneId': args.get('snapshot', {}).get('sceneId', 's'), 'engineId': 'isaac',
                  'engineVersion': '0.0.0-fake', 'worldGeneration': 1, 'appliedSceneRevision': 0, 'status': 'ready',
                  'clock': 'manual', 'timestepS': 0.01, 'groundGeomNames': [], 'warnings': []}
        worlds[world] = result
        emit({'id': request['id'], 'result': result})
    elif method == 'close':
        worlds.pop(args.get('worldId'), None); emit({'id': request['id'], 'result': None})
    elif method == 'stop':
        emit({'id': request['id'], 'result': {'stopped': True, 'stepIndex': 0, 'receipts': []}})
    elif method == 'list_worlds':
        emit({'id': request['id'], 'result': list(worlds.values())})
    elif method == 'shutdown':
        emit({'id': request['id'], 'result': None}); break
    else:
        emit({'id': request['id'], 'result': None})
`

interface PluginHost {
  ctx: unknown
  provided: Record<string, unknown>
  dispose: () => Promise<void>
}
/**
 * 插件宿主的最小面（`get`/`reflect.provide`/`effect`）：**真实 `plugin.apply()` 代码**跑在这里。
 * 原生服务只桩 `agents`/`sandboxPolicy`，并且策略是 `danger-full-access`（不声明沙箱、也不经过
 * `sandbox` 服务）——本轮验的是 Isaac 装配与生命周期，不是沙箱（沙箱接线本身由
 * `packages/sim-contract/test/session-launch.test.ts` 覆盖）。
 */
function pluginHost(workspace: string): PluginHost {
  const provided: Record<string, unknown> = {
    agents: { get: (id: unknown) => id === SESSION ? { session: { header: { id: SESSION, cwd: workspace } } } : undefined },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: workspace }) },
  }
  const disposers: (() => void | Promise<void>)[] = []
  const ctx = {
    get: (name: string) => provided[name],
    reflect: { provide: (name: string, value: unknown) => { provided[name] = value } },
    effect: (callback: () => () => void) => { disposers.push(callback()) },
  }
  return {
    ctx, provided,
    dispose: async () => { for (const disposer of disposers.splice(0).reverse()) await disposer() },
  }
}
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'w3-entry-lifecycle-'))
  scratch.push(workspace)
  const workerPath = join(workspace, 'fake-worker.py')
  await writeFile(workerPath, WORKER_SOURCE)
  await mkdir(join(workspace, '.lyapunov', 'sessions', SESSION, 'engine-cache', 'isaac'), { recursive: true })
  return { workspace, workerPath }
}

describe('ISAAC-01 装配期：未知引擎取值拒绝装配，合法取值显式钉住（无类型 Profile 边界）', () => {
  test('生效值与 GPU 判据：默认 cpu/none 不需要 GPU；cuda:0／rtx 需要；未知值当场拒绝', () => {
    expect(effectiveIsaacEngineConfig()).toEqual({ physicsDevice: 'cpu', rendering: 'none', requiresGpu: false })
    expect(effectiveIsaacEngineConfig({ rendering: 'rtx' })).toEqual({ physicsDevice: 'cpu', rendering: 'rtx', requiresGpu: true })
    expect(effectiveIsaacEngineConfig({ physicsDevice: 'cuda:0' })).toEqual({ physicsDevice: 'cuda:0', rendering: 'none', requiresGpu: true })
    for (const bad of [{ rendering: 'RTX' }, { rendering: 'path-tracing' }, { physicsDevice: 'cuda:1' }, { physicsDevice: 'GPU' }]) {
      expect(() => effectiveIsaacEngineConfig(bad as never)).toThrow(/ISAAC_ENGINE_CONFIG_UNSUPPORTED/)
    }
    // 报错要指出**具体**不可满足的条件（哪个键、什么值、支持哪些），不是一句笼统失败。
    expect(() => effectiveIsaacEngineConfig({ rendering: 'RTX' } as never)).toThrow(/rendering=RTX/)
    expect(() => effectiveIsaacEngineConfig({ physicsDevice: 'cuda:1' } as never)).toThrow(/physicsDevice=cuda:1/)
  })

  test('apply() 在装配期拒绝未知取值；合法配置被显式回填（装配值 == Provider 拿到的值）', async () => {
    const { workspace, workerPath } = await fixture()
    // 未知取值：装配期就失败——不会先装配一只"不需要 GPU"的 Provider、再把未知值交给 worker。
    for (const bad of [{ rendering: 'RTX' }, { physicsDevice: 'cuda:9' }]) {
      const host = pluginHost(workspace)
      expect(() => applyIsaacPlugin(host.ctx as never, { pythonPath: PYTHON, workerPath, ...bad } as never)).toThrow(/ISAAC_ENGINE_CONFIG_UNSUPPORTED/)
      expect(host.provided.sim).toBeUndefined()
    }
    // 负对照：合法配置装配成功，且生效值（含默认）显式钉在 Provider 配置上（不是各层再默认一次）。
    const host = pluginHost(workspace)
    applyIsaacPlugin(host.ctx as never, { pythonPath: PYTHON, workerPath })
    const service = host.provided.sim as { forSession(key: string): IsaacProvider }
    const provider = service.forSession(SESSION)
    expect(provider.config.physicsDevice).toBe('cpu')
    expect(provider.config.rendering).toBe('none')
    expect(provider.config.pythonPath).toBe(PYTHON)
    expect(provider.config.workerPath).toBe(workerPath)
    expect(typeof provider.config.launch).toBe('function')
    await host.dispose()
  })
})

describe.skipIf(PYTHON === undefined)('ISAAC-02 生命周期：未 ready 的等待/取消/关闭（假 worker，真 Provider 与真传输层）', () => {
  test('lifecyclePhases(worldId) 按 world 归因：取消 B 不把 A 的轨迹读成 B 的', async () => {
    const { workspace, workerPath } = await fixture()
    const host = pluginHost(workspace)
    applyIsaacPlugin(host.ctx as never, { pythonPath: PYTHON, workerPath, physicsDevice: 'cpu', rendering: 'none' })
    const provider = (host.provided.sim as { forSession(key: string): IsaacProvider }).forSession(SESSION)
    try {
      const delivered = await bounded(provider.open(scene(), { worldId: 'ok-a' }))
      expect(delivered.worldId).toBe('ok-a')
      await until(() => provider.lifecyclePhases('ok-a').some(phase => phase.name === 'ready'), 'A 的 ready 阶段')
      // B 卡在启动期：等到它自己的阶段轨迹已出现，再取消。
      const controller = new AbortController()
      const pending = rejection(provider.open(scene(), { worldId: 'slow-b' }, controller.signal))
      await until(() => provider.lifecyclePhases('slow-b').some(phase => phase.name === 'kit-app-start'), 'B 的启动阶段')
      controller.abort()
      const failure = await bounded(pending)
      expect(failure.code).toBe('PROVIDER_START_CANCELLED')
      // 归因：B 的轨迹带着它自己的 open 阶段（世界尚未交付就被取消）；A 的轨迹仍是它自己的两段。
      // 旧实现只有一个"最近启动"槽位，`lifecyclePhases('ok-a')` 会读成 B 的轨迹（多出 kit-app-start）。
      expect(provider.lifecyclePhases('slow-b').map(phase => phase.name)).toEqual(['spawned', 'ready', 'kit-app-start'])
      expect(provider.lifecyclePhases('ok-a').map(phase => phase.name)).toEqual(['spawned', 'ready'])
      // 省略 worldId 保持历史语义：最近一次启动（B）。
      expect(provider.lifecyclePhases().map(phase => phase.name)).toEqual(provider.lifecyclePhases('slow-b').map(phase => phase.name))
      // 取消只结束本次 open：已交付的 A 还能正常寻址（列世界读回它）。
      expect((await bounded(provider.listWorlds())).map(world => world.worldId)).toEqual(['ok-a'])
      expect(provider.lifecyclePhases('never-started')).toEqual([])
    } finally {
      await host.dispose()
    }
  }, 30_000)

  test('world 尚未交付时 close() 给真实状态（WORLD_STARTING），不冒充 WORLD_NOT_FOUND', async () => {
    const { workspace, workerPath } = await fixture()
    const host = pluginHost(workspace)
    applyIsaacPlugin(host.ctx as never, { pythonPath: PYTHON, workerPath })
    const provider = (host.provided.sim as { forSession(key: string): IsaacProvider }).forSession(SESSION)
    const controller = new AbortController()
    try {
      const pending = rejection(provider.open(scene(), { worldId: 'hang-c' }, controller.signal))
      await until(() => provider.lifecyclePhases('hang-c').length > 0, 'C 已被交给传输层')
      const error = await rejection(Promise.resolve().then(() => provider.close('hang-c')))
      expect(error.code as string).toBe('WORLD_STARTING')
      expect(error.message).toContain('hang-c')
      expect(error.message).toContain('AbortSignal')
      controller.abort()
      expect((await bounded(pending)).code).toBe('PROVIDER_START_CANCELLED')
    } finally {
      controller.abort()
      await host.dispose()
    }
  }, 30_000)

  test('关闭成功后不留下"正在关闭"：第二次 close 与后续寻址都报 WORLD_NOT_FOUND（不是陈旧 WORLD_CLOSING）', async () => {
    const { workspace, workerPath } = await fixture()
    const host = pluginHost(workspace)
    applyIsaacPlugin(host.ctx as never, { pythonPath: PYTHON, workerPath })
    const provider = (host.provided.sim as { forSession(key: string): IsaacProvider }).forSession(SESSION)
    try {
      await bounded(provider.open(scene(), { worldId: 'ok-d' }))
      await bounded(provider.close('ok-d'))
      // 世界真的没了：再次 close 不能"成功"（旧实现把已结算的 closing promise 又返回一次），
      // 后续寻址也不能报成"世界正在关闭"。`close` 对已不存在/正在关闭的世界是同步抛出（既有形态），
      // 所以这里显式包一层再断言，避免同步异常绕过 rejection 帮助函数。
      expect((await rejection(Promise.resolve().then(() => provider.close('ok-d')))).code).toBe('WORLD_NOT_FOUND')
      expect((await rejection(bounded(provider.sync('ok-d', scene())))).code).toBe('WORLD_NOT_FOUND')
      // 关闭后该次启动的阶段轨迹仍可读（事后归因），不是随实例一起被抹掉。
      expect(provider.lifecyclePhases('ok-d').map(phase => phase.name)).toContain('ready')
    } finally {
      await host.dispose()
    }
  }, 30_000)

  test('未 ready 时 dispose()（Host 级释放）不悬空：本次启动结束、子进程按归属退出、再开可用', async () => {
    const { workspace, workerPath } = await fixture()
    const host = pluginHost(workspace)
    applyIsaacPlugin(host.ctx as never, { pythonPath: PYTHON, workerPath })
    const service = host.provided.sim as { forSession(key: string): IsaacProvider }
    const provider = service.forSession(SESSION)
    const pending = rejection(provider.open(scene(), { worldId: 'hang-e' }))
    await until(() => provider.lifecyclePhases('hang-e').length > 0, 'E 已被交给传输层')
    const pendingProbe = (provider as unknown as { pending: Map<string, { pid?: number }> }).pending
    const pid = pendingProbe.get('hang-e')?.pid
    expect(typeof pid).toBe('number')
    const disposing = provider.dispose()
    expect(provider.dispose()).toBe(disposing)
    await bounded(disposing)
    expect((await bounded(pending)).code).toBe('PROVIDER_CLOSED')
    if (pid !== undefined) await until(() => !alive(pid), '尚未 ready 的 worker 子进程退出')
    // Host 释放后 Provider 永久关闭：新的 open 明确拒绝，不静默重建。
    expect((await rejection(Promise.resolve().then(() => provider.open(scene(), { worldId: 'after' })))).code).toBe('PROVIDER_CLOSED')
    expect(provider.lifecyclePhases('hang-e').map(phase => phase.name)).toContain('spawned')
  }, 30_000)
})

describe('ISAAC-01 装配期：配置要求 GPU 但本会话没有设备节点时拒绝启动（可控夹具，宿主无关）', () => {
  // 为什么不再 `test.skipIf(probeGpuDeviceVisibility().visible)`：那是让**宿主**决定这条合同分支跑不跑
  // ——GPU 可见的机器上整条跳过，发布门按"skip 未豁免 + pass 6 < 下限 7"判红。现在用上面的探针替身
  // 构造"卡在、驱动在、`/dev` 无字符设备"的 device-hidden 会话，真实 `plugin.apply()` / 真实 launcher /
  // 真实 Provider 照跑；只有"Python 缺失"这一条**如实 skip**（当前环境有 Python）。
  test('夹具自检：替身真的生效，且两个探针给同一份"无设备"事实（不是宿主偶然）', async () => {
    forceHiddenGpu = true
    try {
      // mock **之后**动态 import 同一模块 ⇒ 拿到替身（`mock.module` 的解析口径见本文件顶部）。
      const env = await import('../../lyapunov-shell/src/environment-readiness.ts')
      const visibility = env.probeGpuDeviceVisibility()
      const facts = env.probeGpuFacts()
      expect(visibility.visible).toBe(false)
      expect(visibility.exposable).toEqual(['/mock/never-exposed'])
      expect(facts.driverVersion).toBe(`NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  ${GPU_MARKER}  Release Build`)
      expect(facts.deviceNodes).toEqual([])
      // 两个探针不许互相矛盾：可见性判据与 facts 的设备节点是同一份"无设备"事实。
      expect(facts.deviceNodes).toEqual([...visibility.deviceNodes])
      // 关掉开关后原样委托真实现（否则同文件其余用例会被夹具污染）。
      forceHiddenGpu = false
      expect(env.probeGpuFacts().driverVersion).not.toBe(`NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  ${GPU_MARKER}  Release Build`)
    } finally {
      forceHiddenGpu = false
    }
  })

  test.skipIf(PYTHON === undefined)('requiring GPU without /dev/nvidia* → 明确报缺失条件，不静默按 CPU 起来', async () => {
    forceHiddenGpu = true
    try {
      const { workspace, workerPath } = await fixture()
      const host = pluginHost(workspace)
      applyIsaacPlugin(host.ctx as never, { pythonPath: PYTHON, workerPath, physicsDevice: 'cuda:0' })
      const service = host.provided.sim as { forSession(key: string): { open(...args: never[]): Promise<unknown> } }
      try {
        const error = await rejection(bounded(service.forSession(SESSION).open(scene() as never)))
        expect(error.message).toContain('ISAAC_GPU_DEVICE_UNAVAILABLE')
        expect(error.message).toContain('physicsDevice=cuda:0')
        expect(error.message).toContain('NVIDIA 设备节点')
        // 两个探针一致 ⇒ 报文说的是"这个会话看不见设备"，不是"没有设备/驱动坏了"。
        expect(error.message).toContain('这个会话看不见设备')
        expect(error.message).toContain('卡是好的、驱动是好的')
      } finally {
        await host.dispose()
      }
    } finally {
      forceHiddenGpu = false
    }
  }, 30_000)
})
