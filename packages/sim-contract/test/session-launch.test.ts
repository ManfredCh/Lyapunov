/**
 * 会话执行接线（`createSimSessionLauncher`）的**边界**测试：会话身份/运行根/原生有效策略怎么变成
 * 一次具体的 worker 启动，以及运行中策略改动的核对结论。
 *
 * 这里用替身的只有**原生服务**（agents / sandboxPolicy / sandbox 是别的包提供的执行环境，本包不拥有
 * 它们的实现）；本包自己的全部行为都是真的：策略按会话解析、运行根按会话键拼、原生 `confine` 出来的
 * argv 真的被后处理、目录真的在磁盘上建成/没建成、核对结论真的按当前策略算。
 *
 * 钉住的四条：
 *   1. 启动事实来自**这次会话自己的**解析结果（会话键/模式/授权根/运行根/产品根），并真的进了 env；
 *   2. 会话私有运行目录的收窄只认表达得了它的原生 argv 形态；表达不了就如实记 `none`、按原生语义执行；
 *   3. 运行中模式/授权根变了，核对（只服务用户产物落盘边界，不参与物理生命周期）按已定义模式的
 *      **单调包含**判定并回报 **当前** 有效策略：现值更宽放行且原 worker 留在原更严格沙箱（不提升/不重挂）；
 *      现值收紧或授权根变了必须说"这只 worker 带的是旧许可"；
 *   4. 没有会话身份、没有策略服务、没有沙箱后端时一律**失败关闭**，不拿部署默认值替一次执行解析策略。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SANDBOX_UNAVAILABLE, createSimSessionLauncher, resolveSessionPrivateRoot, type SimLaunchContext } from '../src/session-launch.ts'
import { apply as applyMuJoCo } from '../../sim-mujoco/src/plugin.ts'
import type { SessionSimFactory } from '../src/session-provider.ts'
import type { SimWorkerLaunchHook } from '../src/python-transport.ts'
import type { Context } from '@deepseek-ai/cordis'

const SESSION = 'launch-session-a'
const OTHER = 'launch-session-b'

let workspace: string
beforeEach(async () => { workspace = await mkdtemp(join(tmpdir(), 'lyapunov-session-launch-')) })
afterEach(async () => { await rm(workspace, { recursive: true, force: true }) })

type Mode = 'read-only' | 'workspace-write' | 'danger-full-access'
interface Harness {
  ctx: SimLaunchContext
  /** 运行中改权限：改的就是核对要重读的同一份"当前有效策略"。 */
  setPolicy: (next: { mode?: Mode; workspaceRoot?: string }) => void
  /** 运行中让本会话从本 Host 消失：核对同一份链必须核不出来（抛错）。 */
  setLive: (next: boolean) => void
  confined: { argv: readonly string[]; policy: { mode: string; workspaceRoot: string; sessionId?: string } }[]
}
function harness(options: { mode?: Mode; root?: string; sandbox?: 'bwrap' | 'other' | 'none'; live?: boolean } = {}): Harness {
  const root = options.root ?? workspace
  let policy = { mode: (options.mode ?? 'workspace-write') as Mode, workspaceRoot: root, sessionId: SESSION }
  let live = options.live !== false
  const session = { header: { id: SESSION, cwd: root } }
  const confined: Harness['confined'] = []
  const services: Record<string, unknown> = {
    sandboxPolicy: {
      resolve: ({ session: asked }: { session?: { header?: { id?: unknown } } }) => asked === undefined || asked.header?.id !== SESSION
        ? { mode: policy.mode, workspaceRoot: policy.workspaceRoot }
        : { ...policy },
    },
    agents: { get: (id: unknown) => id === SESSION && live ? { session } : undefined },
  }
  if (options.sandbox !== 'none') {
    const kind = options.sandbox ?? 'bwrap'
    services.sandbox = {
      confine: async (argv: readonly string[]) => {
        confined.push({ argv, policy: { mode: policy.mode, workspaceRoot: policy.workspaceRoot, sessionId: policy.sessionId } })
        // 与原生 bwrap profile 同形：read-only 整机只读（连 /tmp 都没有），workspace-write 才加 tmpfs 与授权根挂载。
        if (kind !== 'bwrap') return { argv: ['sandbox-exec', '-p', '(version 1)', ...argv], enforcement: 'partial' as const }
        const profile = ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
        if (policy.mode === 'workspace-write') profile.push('--tmpfs', '/tmp', '--bind', policy.workspaceRoot, policy.workspaceRoot)
        return { argv: [...profile, '--', ...argv], enforcement: 'full' as const }
      },
    }
  }
  return {
    ctx: { get: (name: string) => services[name] },
    setPolicy: next => { policy = { ...policy, ...next } },
    setLive: next => { live = next },
    confined,
  }
}
const input = { pythonPath: '/usr/bin/python3', workerPath: '/tmp/worker.py', env: { PATH: '/usr/bin' } }
const launch = (h: Harness, key = SESSION, productRoots?: (sessionKey: string) => string[]) =>
  createSimSessionLauncher(h.ctx, { engineName: '测试引擎', ...(productRoots === undefined ? {} : { productRoots }) })(key)
/** 带"引擎内部可写目录"的装配：Isaac 那种需要 portable root/导入缓存的引擎按这个形态接线。 */
const launchWithInternal = (h: Harness, key = SESSION, internal: (request: { sessionKey: string; privateRoot: string }) => string[]) =>
  createSimSessionLauncher(h.ctx, { engineName: '测试引擎', internalWritableRoots: internal })(key)
const engineCacheOf = (privateRoot: string) => join(privateRoot, 'engine-cache', 'isaac')
const engineTempOf = (privateRoot: string) => join(privateRoot, 'engine-tmp')
/** 带"引擎内部可写目录 + 内部临时目录"的装配：Isaac 那种 Kit 启动即要可写缓存与临时目录的引擎按这个形态接线。 */
const launchWithTemp = (h: Harness, key = SESSION, extra: { roots?: (request: { sessionKey: string; privateRoot: string }) => string[]; temp?: (request: { sessionKey: string; privateRoot: string }) => string } = {}) =>
  createSimSessionLauncher(h.ctx, {
    engineName: '测试引擎',
    internalWritableRoots: extra.roots ?? (({ privateRoot }) => [engineCacheOf(privateRoot)]),
    internalTempDir: extra.temp ?? (({ privateRoot }) => engineTempOf(privateRoot)),
  })(key)

describe('启动接线：会话身份/运行根/有效策略 → 一次 worker 启动', () => {
  test('workspace-write：按本会话解析出模式与授权根，运行根落在会话键下，原生沙箱包裹后才启动', async () => {
    const h = harness()
    const spec = await launch(h, SESSION, key => [`/products/${key}/media`])(input)
    expect(spec.argv.slice(0, 2)).toEqual(['bwrap', '--ro-bind'])
    expect(spec.cwd).toBe(workspace)
    expect(spec.facts).toEqual({
      sessionId: SESSION, mode: 'workspace-write', workspaceRoot: workspace, writableRoot: workspace,
      runtimeRoot: join(workspace, '.lyapunov', 'sessions', SESSION, 'sim'),
      productRoots: [`/products/${SESSION}/media`],
      runner: 'bwrap', enforcement: 'full', privateRootBoundary: 'os-bind',
    })
    // 身份与运行根真的进了 worker 的环境（不是只写在宿主侧的 facts 里）。
    expect(spec.env).toMatchObject({
      PATH: '/usr/bin', LYAPUNOV_SIM_SESSION: SESSION, LYAPUNOV_SIM_SANDBOX_MODE: 'workspace-write',
      LYAPUNOV_SIM_WORKSPACE_ROOT: workspace, LYAPUNOV_SIM_RUNTIME_ROOT: join(workspace, '.lyapunov', 'sessions', SESSION, 'sim'),
    })
    // 启动命令本体还在（沙箱只是包裹）：解释器与 worker 路径没有被改写。
    expect(spec.argv.slice(-3)).toEqual(['/usr/bin/python3', '-u', '/tmp/worker.py'])
  })

  test('会话私有运行目录：父目录只读挂回、自己那层挂回可写；别的会话目录**不建也不碰**', async () => {
    const h = harness()
    const spec = await launch(h)(input)
    const sessionsParent = join(workspace, '.lyapunov', 'sessions')
    const own = join(sessionsParent, SESSION)
    const separator = spec.argv.lastIndexOf('--')
    expect(spec.argv.slice(separator - 6, separator)).toEqual(['--ro-bind', sessionsParent, sessionsParent, '--bind', own, own])
    // 两条挂载都插在 `--` 之前（bwrap 的挂载必须先于被判定的命令），且挂载顺序保证"自己这层后挂可写"。
    const mounts = spec.argv.slice(0, separator)
    expect(mounts.indexOf(own)).toBeGreaterThan(mounts.indexOf(sessionsParent))
    expect(existsSync(join(own, 'sim'))).toBe(true)
    expect(existsSync(join(sessionsParent, OTHER))).toBe(false)
  })

  test('原生 argv 表达不了这层收窄时：如实记 none，argv 原样交给原生语义（不假装有 OS 级私有目录）', async () => {
    const h = harness({ sandbox: 'other' })
    const spec = await launch(h)(input)
    expect(spec.argv[0]).toBe('sandbox-exec')
    expect(spec.facts.privateRootBoundary).toBe('none')
    expect(spec.facts.enforcement).toBe('partial')
    expect(existsSync(join(workspace, '.lyapunov'))).toBe(false)
  })

  test('read-only：整机只读本来就没有会话私有目录要收窄，不加挂载；danger-full-access：不包裹也不声称有沙箱', async () => {
    const readOnly = await launch(harness({ mode: 'read-only' }))(input)
    expect(readOnly.facts.mode).toBe('read-only')
    expect(readOnly.facts.privateRootBoundary).toBe('none')
    expect(existsSync(join(workspace, '.lyapunov'))).toBe(false)
    const full = await launch(harness({ mode: 'danger-full-access', sandbox: 'none' }))(input)
    expect(full.argv).toEqual(['/usr/bin/python3', '-u', '/tmp/worker.py'])
    expect(full.facts).toMatchObject({ mode: 'danger-full-access', privateRootBoundary: 'none' })
    expect(full.facts.enforcement).toBeUndefined()
  })
})

describe('只读会话下的引擎内部可写目录：用户模式仍是只读，内部运行文件有唯一可写位', () => {
  test('read-only：声明的内部目录单独挂回可写，用户私有目录的其余部分不挂；事实分开写用户模式与内部许可', async () => {
    const h = harness({ mode: 'read-only' })
    const spec = await launchWithInternal(h, SESSION, ({ privateRoot }) => [engineCacheOf(privateRoot)])(input)
    const own = join(workspace, '.lyapunov', 'sessions', SESSION)
    const cache = join(own, 'engine-cache', 'isaac')
    const separator = spec.argv.lastIndexOf('--')
    // 挂载只有这一条、插在 `--` 之前、晚于 `--ro-bind / /`（顺序保证它是可写的那层）。
    expect(spec.argv.slice(separator - 3, separator)).toEqual(['--bind', cache, cache])
    expect(spec.argv.slice(0, separator).filter(item => item === '--bind')).toHaveLength(1)
    expect(spec.argv.indexOf('--ro-bind')).toBeLessThan(spec.argv.indexOf('--bind'))
    // 挂载源真的建出来了（只建这一条路径：会话私有目录的其余层不碰）。
    expect(existsSync(cache)).toBe(true)
    expect(existsSync(join(own, 'sim'))).toBe(false)
    expect(existsSync(join(workspace, '.lyapunov', 'sessions', OTHER))).toBe(false)
    // 事实里两件事分开：用户模式仍是 read-only；内部许可是 OS 挂载且只列这一个目录。
    expect(spec.facts.mode).toBe('read-only')
    expect(spec.facts.privateRootBoundary).toBe('none')
    expect(spec.facts.internalWritableRoots).toEqual([cache])
    expect(spec.facts.internalWritableBoundary).toBe('os-bind')
    expect(spec.facts.runner).toBe('bwrap')
  })

  test('装配方没声明内部目录时：只读照旧不加任何挂载、不建目录', async () => {
    const spec = await createSimSessionLauncher(harness({ mode: 'read-only' }).ctx, { engineName: '测试引擎' })(SESSION)(input)
    expect(spec.facts.internalWritableRoots).toBeUndefined()
    expect(spec.facts.internalWritableBoundary).toBeUndefined()
    expect(spec.argv).not.toContain('--bind')
    expect(existsSync(join(workspace, '.lyapunov'))).toBe(false)
  })

  test('MuJoCo 实际插件：read-only 冷加载只给本会话 scratch/temp 可写位，原件/产品/其它会话不挂回可写', async () => {
    const h = harness({ mode: 'read-only' })
    let sim: SessionSimFactory | undefined
    const ctx = {
      get: h.ctx.get,
      reflect: { provide: (name: string, value: unknown) => { if (name === 'sim') sim = value as SessionSimFactory } },
      effect: () => undefined,
    } as unknown as Context
    applyMuJoCo(ctx, { productRoots: ['/products/captures'] })
    try {
      // 读取实际插件创建的 Provider 启动钩子；核对最终 argv/env，不启动假沙箱冒充 OS 强制。
      const provider = sim!.forSession(SESSION) as unknown as { config: { launch: SimWorkerLaunchHook } }
      const spec = await provider.config.launch(input)
      const own = join(workspace, '.lyapunov', 'sessions', SESSION)
      const scratch = join(own, 'sim', 'scratch'), temp = join(own, 'sim', 'tmp')
      const separator = spec.argv.lastIndexOf('--')
      expect(spec.argv.slice(separator - 6, separator)).toEqual(['--bind', scratch, scratch, '--bind', temp, temp])
      expect(spec.argv.slice(0, separator).filter(item => item === '--bind')).toHaveLength(2)
      expect(spec.facts).toMatchObject({ mode: 'read-only', workspaceRoot: workspace, internalWritableRoots: [scratch, temp], internalWritableBoundary: 'os-bind', privateRootBoundary: 'none' })
      expect(spec.env).toMatchObject({ TMPDIR: temp, TMP: temp, TEMP: temp, LYAPUNOV_SIM_SANDBOX_MODE: 'read-only' })
      expect(existsSync(scratch)).toBe(true)
      expect(existsSync(temp)).toBe(true)
      expect(existsSync(join(workspace, '.lyapunov', 'sessions', OTHER))).toBe(false)
      expect(spec.argv).not.toContain('/products/captures')
    } finally { await sim?.dispose() }
  })

  test('workspace-write：整层会话私有目录已挂回可写，内部目录不再重复挂载，事实照实标 os-bind', async () => {
    const spec = await launchWithInternal(harness(), SESSION, ({ privateRoot }) => [engineCacheOf(privateRoot)])(input)
    const own = join(workspace, '.lyapunov', 'sessions', SESSION)
    const cache = join(own, 'engine-cache', 'isaac')
    const separator = spec.argv.lastIndexOf('--')
    expect(spec.argv.slice(separator - 6, separator)).toEqual(['--ro-bind', join(workspace, '.lyapunov', 'sessions'), join(workspace, '.lyapunov', 'sessions'), '--bind', own, own])
    expect(spec.facts.privateRootBoundary).toBe('os-bind')
    expect(spec.facts.internalWritableRoots).toEqual([cache])
    expect(spec.facts.internalWritableBoundary).toBe('os-bind')
  })

  test('内部目录指向私有根之外（含一条链接指向别处）：失败关闭，不启动、不静默少挂', async () => {
    const outside = join(workspace, '..', '授权根外')
    await expect(launchWithInternal(harness({ mode: 'read-only' }), SESSION, () => [outside])(input))
      .rejects.toThrow(/SESSION_INTERNAL_WRITE_OUTSIDE_PRIVATE_ROOT/)
    const own = join(workspace, '.lyapunov', 'sessions', SESSION)
    await mkdir(join(own, '..'), { recursive: true })
    await mkdir(outside, { recursive: true })
    await symlink(outside, join(workspace, '.lyapunov', 'sessions', OTHER), 'dir')
    // 词法上"在会话目录下"，但真实目标在授权根外：同样拒绝。
    await expect(launchWithInternal(harness({ mode: 'read-only' }), SESSION, () => [join(workspace, '.lyapunov', 'sessions', OTHER, 'engine-cache')])(input))
      .rejects.toThrow(/SESSION_INTERNAL_WRITE_OUTSIDE_PRIVATE_ROOT/)
  })

  test('原生 argv 表达不了这层内部许可（非 bwrap 后端）：如实标 none，不假装内部缓存已可写', async () => {
    const spec = await launchWithInternal(harness({ mode: 'read-only', sandbox: 'other' }), SESSION, ({ privateRoot }) => [engineCacheOf(privateRoot)])(input)
    expect(spec.argv[0]).toBe('sandbox-exec')
    expect(spec.facts.internalWritableBoundary).toBe('none')
    expect(spec.facts.mode).toBe('read-only')
  })
})

describe('只读会话下的引擎临时目录：Kit/Python 找不到可写临时区时打不开已有场景', () => {
  test('read-only：临时目录与缓存目录一起挂回可写，TMPDIR/TMP/TEMP 都指向本会话那一份', async () => {
    const spec = await launchWithTemp(harness({ mode: 'read-only' }))(input)
    const own = join(workspace, '.lyapunov', 'sessions', SESSION)
    const cache = join(own, 'engine-cache', 'isaac'), temp = join(own, 'engine-tmp')
    const separator = spec.argv.lastIndexOf('--')
    const mounts = spec.argv.slice(0, separator)
    expect(mounts.filter(item => item === '--bind')).toHaveLength(2)
    expect(spec.argv.slice(separator - 6, separator)).toEqual(['--bind', cache, cache, '--bind', temp, temp])
    expect(existsSync(temp)).toBe(true)
    // 用户模式仍是 read-only；两个内部目录都在启动事实里（引擎真正可写的位就在这两条）。
    expect(spec.facts.mode).toBe('read-only')
    expect(spec.facts.privateRootBoundary).toBe('none')
    expect(spec.facts.internalWritableRoots).toEqual([cache, temp])
    expect(spec.env).toMatchObject({ TMPDIR: temp, TMP: temp, TEMP: temp, LYAPUNOV_SIM_SANDBOX_MODE: 'read-only' })
  })

  test('workspace-write：平台临时区本来就可用，内部临时目录不重复挂载、临时环境变量照旧不动', async () => {
    const spec = await launchWithTemp(harness())(input)
    const own = join(workspace, '.lyapunov', 'sessions', SESSION)
    const separator = spec.argv.lastIndexOf('--')
    expect(spec.argv.slice(separator - 6, separator)).toEqual(['--ro-bind', join(workspace, '.lyapunov', 'sessions'), join(workspace, '.lyapunov', 'sessions'), '--bind', own, own])
    expect(spec.env!.TMPDIR).toBeUndefined()
    expect(spec.facts.internalWritableRoots).toEqual([join(own, 'engine-cache', 'isaac'), join(own, 'engine-tmp')])
    expect(spec.facts.internalWritableBoundary).toBe('os-bind')
  })

  test('临时目录指向私有根之外：失败关闭（与缓存目录同一条规范路径核实）', async () => {
    await expect(launchWithTemp(harness({ mode: 'read-only' }), SESSION, { temp: () => join(workspace, '..', '授权根外的临时区') })(input))
      .rejects.toThrow(/SESSION_INTERNAL_WRITE_OUTSIDE_PRIVATE_ROOT/)
  })

  test('装配方只声明缓存、不声明临时目录：只读照旧只有一条挂载、不设临时环境变量（MuJoCo 等保持原行为）', async () => {
    const spec = await launchWithInternal(harness({ mode: 'read-only' }), SESSION, ({ privateRoot }) => [engineCacheOf(privateRoot)])(input)
    expect(spec.facts.internalWritableRoots).toEqual([join(workspace, '.lyapunov', 'sessions', SESSION, 'engine-cache', 'isaac')])
    expect(spec.env!.TMPDIR).toBeUndefined()
  })
})

describe('运行中改权限：核对读的是"该会话当前有效策略"', () => {
  test('模式核对只按已定义 NativeMode 的单调包含：现值更宽放行且原 worker 留在原更严格沙箱；收紧/未知一律旧许可，并点明两个模式', async () => {
    // workspace-write 启动：现值一致、放宽到 danger-full-access、收紧到 read-only。
    const h = harness()
    const spec = await launch(h)(input)
    expect(spec.check).toBeDefined()
    expect(await spec.check!(spec.facts)).toEqual({ stale: false, current: { mode: 'workspace-write', workspaceRoot: workspace } })
    const argvAtLaunch = [...spec.argv]
    const factsAtLaunch = { ...spec.facts }
    h.setPolicy({ mode: 'danger-full-access' })
    expect(await spec.check!(spec.facts)).toEqual({ stale: false, current: { mode: 'danger-full-access', workspaceRoot: workspace } })
    // 放宽只放行核对，不重挂、不提升：worker 的 argv/facts 仍是启动时那份 workspace-write 沙箱。
    expect(spec.argv).toEqual(argvAtLaunch)
    expect(spec.facts).toEqual(factsAtLaunch)
    expect(spec.facts.mode).toBe('workspace-write')
    h.setPolicy({ mode: 'read-only' })
    const tightened = await spec.check!(spec.facts)
    expect(tightened.stale).toBe(true)
    if (!tightened.stale) throw new Error('不可达')
    expect(tightened.detail).toContain('workspace-write')
    expect(tightened.detail).toContain('read-only')
    expect(tightened.detail).toContain(SESSION)
    // 核对同时回报**当前**有效策略：IO 边界据此决定这次用户产物写入允不允许。
    expect(tightened.current).toEqual({ mode: 'read-only', workspaceRoot: workspace })

    // read-only 启动：放宽到 workspace-write / danger-full-access 都放行（worker 只会更严）。
    const readOnly = harness({ mode: 'read-only' })
    const readOnlySpec = await launch(readOnly)(input)
    expect(await readOnlySpec.check!(readOnlySpec.facts)).toEqual({ stale: false, current: { mode: 'read-only', workspaceRoot: workspace } })
    readOnly.setPolicy({ mode: 'workspace-write' })
    expect(await readOnlySpec.check!(readOnlySpec.facts)).toEqual({ stale: false, current: { mode: 'workspace-write', workspaceRoot: workspace } })
    readOnly.setPolicy({ mode: 'danger-full-access' })
    expect(await readOnlySpec.check!(readOnlySpec.facts)).toEqual({ stale: false, current: { mode: 'danger-full-access', workspaceRoot: workspace } })

    // danger-full-access 启动：收紧到 workspace-write / read-only 都拒绝（旧许可比现值更宽）。
    const full = harness({ mode: 'danger-full-access', sandbox: 'none' })
    const fullSpec = await launch(full)(input)
    expect(await fullSpec.check!(fullSpec.facts)).toEqual({ stale: false, current: { mode: 'danger-full-access', workspaceRoot: workspace } })
    full.setPolicy({ mode: 'workspace-write' })
    const fullToWrite = await fullSpec.check!(fullSpec.facts)
    expect(fullToWrite.stale).toBe(true)
    if (!fullToWrite.stale) throw new Error('不可达')
    expect(fullToWrite.detail).toContain('danger-full-access')
    expect(fullToWrite.detail).toContain('workspace-write')
    expect(fullToWrite.current).toEqual({ mode: 'workspace-write', workspaceRoot: workspace })
    full.setPolicy({ mode: 'read-only' })
    expect((await fullSpec.check!(fullSpec.facts)).stale).toBe(true)

    // 未知模式：取不到单调包含序，失败关闭（不猜第三方模式语义）。
    const unknown = harness()
    const unknownSpec = await launch(unknown)(input)
    unknown.setPolicy({ mode: 'third-party-mode' as unknown as Mode })
    const unknownVerdict = await unknownSpec.check!(unknownSpec.facts)
    expect(unknownVerdict.stale).toBe(true)
    if (!unknownVerdict.stale) throw new Error('不可达')
    expect(unknownVerdict.detail).toContain('third-party-mode')
    // 未知模式在类型上不属于已定义 NativeMode：按运行时取值核对现值原样回报。
    expect(unknownVerdict.current.mode as unknown as string).toBe('third-party-mode')
    expect(unknownVerdict.current.workspaceRoot).toBe(workspace)
    // worker 启动时就是未知模式：同一侧取不到包含序，同样按旧许可拒绝。
    const unknownWorker = harness({ mode: 'third-party-mode' as unknown as Mode })
    const unknownWorkerSpec = await launch(unknownWorker)(input)
    expect((await unknownWorkerSpec.check!(unknownWorkerSpec.facts)).stale).toBe(true)
  })

  test('受限模式变更授权根仍拒绝；全访问范围包括多个目录，不因主要工作目录变化误停', async () => {
    const h = harness()
    const spec = await launch(h)(input)
    h.setPolicy({ workspaceRoot: join(workspace, '另一个根') })
    const verdict = await spec.check!(spec.facts)
    expect(verdict.stale).toBe(true)
    if (!verdict.stale) throw new Error('不可达')
    expect(verdict.detail).toContain(join(workspace, '另一个根'))
    expect(verdict.current.workspaceRoot).toBe(join(workspace, '另一个根'))
    // 当前全访问已授权全部目录：旧worker继续保持原更窄沙箱，不重新挂载或提升。
    h.setPolicy({ mode: 'danger-full-access' })
    const widened = await spec.check!(spec.facts)
    expect(widened.stale).toBe(false)
    expect(spec.facts.mode).toBe('workspace-write')
    expect(spec.facts.workspaceRoot).toBe(workspace)
    const full = harness({mode:'danger-full-access',sandbox:'none'})
    const fullSpec = await launch(full)(input)
    const argv = [...fullSpec.argv]
    full.setPolicy({workspaceRoot:join(workspace,'又一个目录')})
    expect(await fullSpec.check!(fullSpec.facts)).toEqual({stale:false,current:{mode:'danger-full-access',workspaceRoot:join(workspace,'又一个目录')}})
    expect(fullSpec.argv).toEqual(argv)
  })

  test('会话已经不在本 Host：核对核不出来就抛（由传输层按"不可证明"拒绝，不拿默认策略顶替）', async () => {
    const h = harness()
    const spec = await launch(h)(input)
    expect(await spec.check!(spec.facts)).toEqual({ stale: false, current: { mode: 'workspace-write', workspaceRoot: workspace } })
    // 会话从本 Host 消失（关掉/换了一台 Host）之后：同一条核对必须核不出来——抛出去，由传输层按
    // "不可证明"拒绝本次写入（不杀世界），而不是回落成部署默认策略说"现值一致"。
    h.setLive(false)
    await expect(spec.check!(spec.facts)).rejects.toThrow(/SESSION_NOT_BOUND/)
    const dead = harness({ live: false })
    const specOnDead = await createSimSessionLauncher(dead.ctx, { engineName: '测试引擎' })(SESSION)
    await expect(specOnDead(input)).rejects.toThrow(/SESSION_NOT_BOUND/)
  })
})

describe('会话私有目录的取法（引擎要可写运行空间时与启动接线同一条链）', () => {
  test('按会话键给出 <授权根>/.lyapunov/sessions/<会话键>：就是沙箱里唯一挂回可写的那一层', async () => {
    const h = harness()
    expect(await resolveSessionPrivateRoot(h.ctx, SESSION, '测试引擎')).toBe(join(workspace, '.lyapunov', 'sessions', SESSION))
    // 授权根变了就跟着变（同一条 resolve 链，不是自己拼一遍 session.header.cwd）。
    h.setPolicy({ workspaceRoot: join(workspace, '另一个根') })
    expect(await resolveSessionPrivateRoot(h.ctx, SESSION, '测试引擎')).toBe(join(workspace, '另一个根', '.lyapunov', 'sessions', SESSION))
  })

  test('没有活着的会话 / 没有策略服务：取不出来就抛（不回落成任意目录）', async () => {
    await expect(resolveSessionPrivateRoot(harness({ live: false }).ctx, SESSION, '测试引擎')).rejects.toThrow(/SESSION_NOT_BOUND/)
    // 有活会话但没有策略服务：同一条失败关闭（不拿部署默认值替它算路径）。
    const noPolicy: SimLaunchContext = { get: name => name === 'agents' ? harness().ctx.get('agents') : undefined }
    await expect(resolveSessionPrivateRoot(noPolicy, SESSION, '测试引擎')).rejects.toThrow(new RegExp(SANDBOX_UNAVAILABLE))
  })
})

describe('失败关闭：没有会话身份 / 没有策略服务 / 没有沙箱后端时不启动', () => {
  test('没有活着的原生会话：拒绝，且不解析出任何执行策略', async () => {
    const h = harness({ live: false })
    await expect(launch(h)(input)).rejects.toThrow(/SESSION_NOT_BOUND/)
  })

  test('策略服务未装配：拒绝（不拿部署默认值替一次执行解析策略）', async () => {
    const h = harness()
    const bare: SimLaunchContext = { get: name => name === 'agents' ? h.ctx.get('agents') : undefined }
    await expect(createSimSessionLauncher(bare, { engineName: '测试引擎' })(SESSION)(input)).rejects.toThrow(new RegExp(SANDBOX_UNAVAILABLE))
  })

  test('有策略但本 Host 没有可用沙箱执行器：workspace-write 下失败关闭，绝不静默退成直连', async () => {
    const h = harness({ sandbox: 'none' })
    await expect(launch(h)(input)).rejects.toThrow(/SANDBOX_UNAVAILABLE.*workspace-write/s)
  })
})

describe('引擎设备（GPU 物理/RTX 要的 /dev/nvidia*）：设备挂载暴露，用户文件效果模式不变', () => {
  const launchWithDevices = (h: Harness, devices: () => string[], key = SESSION) =>
    createSimSessionLauncher(h.ctx, { engineName: '测试引擎', engineDevices: devices })(key)

  test('read-only：声明的字符设备挂进沙箱（--dev-bind，插在 -- 之前），事实标 device-bind；用户模式照旧只读', async () => {
    const h = harness({ mode: 'read-only' })
    const spec = await launchWithDevices(h, () => ['/dev/null'])(input)
    const separator = spec.argv.lastIndexOf('--')
    expect(spec.argv.slice(separator - 3, separator)).toEqual(['--dev-bind', '/dev/null', '/dev/null'])
    expect(spec.facts.engineDevices).toEqual(['/dev/null'])
    expect(spec.facts.engineDeviceBoundary).toBe('device-bind')
    expect(spec.facts.mode).toBe('read-only')
    // 设备挂载没有被当成文件可写位：只读会话仍然只有内部运行目录那一条可写挂载（这里没声明，所以一条都没有）。
    expect(spec.argv.join(' ')).not.toContain('--bind /dev/null')
    expect(spec.facts.internalWritableBoundary).toBeUndefined()
  })

  test('workspace-write：设备挂载与会话私有目录收窄并存（两条挂载都在 -- 之前）', async () => {
    const h = harness()
    const spec = await launchWithDevices(h, () => ['/dev/null'])(input)
    const separator = spec.argv.lastIndexOf('--')
    const mounts = spec.argv.slice(0, separator).join(' ')
    expect(mounts).toContain('--dev-bind /dev/null /dev/null')
    expect(mounts).toContain(`--bind ${join(workspace, '.lyapunov', 'sessions', SESSION)}`)
    expect(spec.facts.engineDeviceBoundary).toBe('device-bind')
  })

  test('设备目录也算（NVIDIA 的能力节点放在 /dev/nvidia-caps 里）', async () => {
    if (!existsSync('/dev/shm')) return
    const h = harness({ mode: 'read-only' })
    const spec = await launchWithDevices(h, () => ['/dev/shm'])(input)
    expect(spec.facts.engineDevices).toEqual(['/dev/shm'])
    expect(spec.argv.join(' ')).toContain('--dev-bind /dev/shm /dev/shm')
  })

  test('声明的设备在宿主上不存在：失败关闭（不让一只拿不到 GPU 的 worker 静默跑起来）', async () => {
    const h = harness({ mode: 'read-only' })
    await expect(launchWithDevices(h, () => ['/dev/nvidia-does-not-exist-139'])(input)).rejects.toThrow(/SESSION_ENGINE_DEVICE_UNAVAILABLE/)
  })

  test('声明的路径不在 /dev 下（或指向 /dev 之外的真实目标）：失败关闭，不当设备暴露', async () => {
    const h = harness({ mode: 'read-only' })
    const outside = join(workspace, 'not-a-device')
    await writeFile(outside, 'x')
    await expect(launchWithDevices(h, () => [outside])(input)).rejects.toThrow(/SESSION_ENGINE_DEVICE_OUTSIDE_DEV/)
    await expect(launchWithDevices(h, () => ['/dev/null'])(input)).resolves.toBeDefined()
  })

  test('原生后端表达不了设备挂载（非 bwrap）：如实标 none，不假装设备已暴露', async () => {
    const h = harness({ mode: 'read-only', sandbox: 'other' })
    const spec = await launchWithDevices(h, () => ['/dev/null'])(input)
    expect(spec.facts.engineDeviceBoundary).toBe('none')
    expect(spec.argv.join(' ')).not.toContain('--dev-bind')
  })

  test('没声明设备的引擎（CPU 引擎）：argv 与事实里都不出现设备这一层', async () => {
    const spec = await launch(harness({ mode: 'read-only' }))(input)
    expect(spec.facts.engineDevices).toBeUndefined()
    expect(spec.facts.engineDeviceBoundary).toBeUndefined()
    expect(spec.argv.join(' ')).not.toContain('--dev-bind')
  })
})

describe('临时安装下的运行依赖可见性',()=>{
  test('仅恢复声明的运行根，并保留工作区及本会话写入挂载的优先级',async()=>{
    const code=join(workspace,'..','installed-code')
    await mkdir(code,{recursive:true})
    const spec=await createSimSessionLauncher(harness().ctx,{engineName:'临时安装',readOnlyRoots:[code,workspace]})(SESSION)(input)
    expect(spec.facts.runtimeReadRoots).toEqual([code])
    const mask=spec.argv.indexOf('--tmpfs')
    const codeBind=spec.argv.findIndex((v,i)=>v==='--ro-bind'&&spec.argv[i+1]===code)
    const workspaceBind=spec.argv.findIndex((v,i)=>v==='--bind'&&spec.argv[i+1]===workspace)
    expect(codeBind).toBeGreaterThan(mask)
    expect(workspaceBind).toBeGreaterThan(codeBind)
    expect(spec.facts.privateRootBoundary).toBe('os-bind')
    expect(spec.argv.slice(-3)).toEqual(['/usr/bin/python3','-u','/tmp/worker.py'])
  })
  test('不能通过运行依赖根暴露整个tmp；未被tmpfs遮蔽的安装无需额外挂载',async()=>{
    await expect(createSimSessionLauncher(harness().ctx,{engineName:'临时安装',readOnlyRoots:['/tmp']})(SESSION)(input)).rejects.toThrow('不允许重新暴露整个临时目录')
    await expect(createSimSessionLauncher(harness().ctx,{engineName:'临时安装',readOnlyRoots:['relative-sdk']})(SESSION)(input)).rejects.toThrow('绝对路径')
    const spec=await createSimSessionLauncher(harness().ctx,{engineName:'临时安装',readOnlyRoots:['/usr/lib']})(SESSION)(input)
    expect(spec.facts.runtimeReadRoots).toBeUndefined()
  })
})
