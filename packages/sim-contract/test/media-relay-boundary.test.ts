/**
 * Host 媒体中转的**写入边界**（138 定向返修，与本体复现的两条 scene_save 绕过同源）：
 * 会话内部的采集/录制目录落在原生工作区授权根**之外**，所以产物要由宿主按原路径代落盘——
 * 这条代写路径必须只对**本会话自己的产品根内**的目标生效，而且判定要按**规范路径**做。
 *
 * 修前 `pathWithin` 只做词法 `relative`：产品根里的一个符号链接指向别处（授权根外、或别的会话目录）
 * 就会被当成"在根内"，宿主照着链接把产物写到许可范围之外——换个入口照样代写。
 *
 * 这里用真实子进程（`fixtures/fake-worker.py`）跑的是**Host 侧决定**，不是物理/沙箱行为：
 *   · 合法目标：worker 收到的是 `<运行根>/staging/media-N`（宿主中转），返回后产物出现在**产品根**；
 *   · 链接越界：worker 收到的是**原样目标路径**（不中转、不改写），宿主一个字节都没替它写；
 *   · 别的会话的产品根：同样不中转（产品根是按会话键展开的，canonically 在"我的"产品根内才是我的）。
 * 假 worker 没有沙箱，它写不写、拒不等价于任何真实引擎的权限读数——这条边界由产品自己的
 * 原生沙箱/策略保证（见 137/138 的沙箱证据），测试只钉"宿主有没有替它写"。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProcessSimProvider, pathWithin, type SimWorkerLaunchSpec } from '../src/python-transport.ts'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'

const WORKER = new URL('./fixtures/fake-worker.py', import.meta.url).pathname

function systemPython(): string | undefined {
  for (const candidate of ['/usr/bin/python3', '/usr/local/bin/python3', '/bin/python3']) if (existsSync(candidate)) return candidate
  return undefined
}

const PYTHON = systemPython()

/**
 * 中转只在目标**既不在授权根、也不在平台临时区**时才发生（`python-transport.ts` 里就是
 * `pathWithin('/tmp', …) || pathWithin(tmpdir(), …)`），所以这个夹具必须落在 `/tmp` 与 `tmpdir()`
 * **之外**，同时本机得真的写得进去。写死 `/var/tmp` 时，`/var/tmp` 只读的环境里 12 例必然 EROFS——
 * 这里要表达的性质是"在平台临时区之外"，不是"必须在 /var/tmp"。
 * 候选按顺序探测：落在临时区里的跳过、真建不出目录的跳过，第一个可用的胜出。
 */
const RELAY_BASE = (() => {
  for (const candidate of ['/var/tmp', '/dev/shm', process.cwd()]) {
    if (pathWithin('/tmp', candidate) || pathWithin(tmpdir(), candidate)) continue
    try {
      const probe = mkdtempSync(join(candidate, 'lyapunov-relay-probe-'))
      rmSync(probe, { recursive: true, force: true })
      return candidate
    } catch { /* 只读、不存在或没有权限：试下一个候选 */ }
  }
  throw new Error('TEST_NO_WRITABLE_RELAY_BASE: 候选基目录都落在平台临时区内或不可写，构造不出"临时区之外"的夹具')
})()
let base: string
beforeEach(async () => { base = await mkdtemp(join(RELAY_BASE, 'lyapunov-media-relay-')) })
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

/** 一次会话的运行事实：授权根（工作区）在外，会话运行根在授权根内，产品根按会话键展开在外。 */
interface Space {
  sessionId: string
  writableRoot: string
  runtimeRoot: string
  productRoot: string
  launches: SimWorkerLaunchSpec['facts'][]
}
function spaceOf(sessionId: string): Space {
  const writableRoot = join(base, 'workspace')
  return {
    sessionId, writableRoot,
    runtimeRoot: join(writableRoot, '.lyapunov', 'sessions', sessionId, 'sim'),
    productRoot: join(base, 'captures', 'sessions', sessionId),
    launches: [],
  }
}
async function providerFor(space: Space, plan: Record<string, unknown>, mode: 'workspace-write' | 'read-only' = 'workspace-write'): Promise<{ provider: ProcessSimProvider; marker: string }> {
  const marker = join(base, `${space.sessionId}.marker`)
  const scenario = join(base, `${space.sessionId}.scenario.json`)
  await writeFile(marker, '')
  await writeFile(scenario, JSON.stringify(plan))
  const provider = new ProcessSimProvider({
    pythonPath: PYTHON!, workerPath: WORKER, engineName: 'fake-engine',
    env: { FAKE_MARKER: marker, FAKE_SCENARIO: scenario },
    launch: async input => {
      const facts = {
        sessionId: space.sessionId, mode,
        workspaceRoot: space.writableRoot, writableRoot: space.writableRoot,
        runtimeRoot: space.runtimeRoot, productRoots: [space.productRoot],
        // 只读会话里引擎内部缓存是唯一可写位（与 session-launch 的 internalWritableRoots 同形的启动事实）。
        ...(mode === 'read-only' ? { internalWritableRoots: [join(space.writableRoot, '.lyapunov', 'sessions', space.sessionId, 'engine-cache', 'isaac')], internalWritableBoundary: 'os-bind' as const } : {}),
      }
      space.launches.push(facts)
      return {
        argv: [input.pythonPath, '-u', input.workerPath],
        env: { ...input.env, LYAPUNOV_SIM_SESSION: space.sessionId, LYAPUNOV_SIM_RUNTIME_ROOT: space.runtimeRoot, LYAPUNOV_SIM_SANDBOX_MODE: mode },
        facts, check: async () => ({ stale: false as const }),
      }
    },
  })
  return { provider, marker }
}
function scene(sceneId: string): SceneSnapshot {
  return { sceneId, revision: 0, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' }, entities: [] }
}
const markerText = (marker: string) => readFile(marker, 'utf8')

const describeIfPython = PYTHON === undefined ? describe.skip : describe

describeIfPython('媒体中转只对 canonically 落在本会话产品根内的目标代写', () => {
  test('合法目标照旧中转：worker 拿到运行根里的暂存目录，产物最终落在产品根（不是暂存目录）', async () => {
    const space = spaceOf('relay-ok')
    const { provider, marker } = await providerFor(space, {})
    await provider.open(scene('s1'), { worldId: 'w1' })
    const target = join(space.productRoot, 'shots')
    const result = await provider.capture('w1', { outputDir: target }) as { path: string }
    // Host 中转在 worker 面前的样子：产物根被改写成会话运行根内的 staging。
    const written = await markerText(marker)
    expect(written).toContain(`capture outputDir=${join(space.runtimeRoot, 'staging')}`)
    expect(written).not.toContain(`capture outputDir=${target}`)
    // 返回后的样子：宿主把它搬到了**产品根**，回执里的路径也是真实目标路径。
    expect(existsSync(join(target, 'shot.png'))).toBe(true)
    expect(result.path).toBe(join(target, 'shot.png'))
    await provider.dispose()
  })

  test('可复用采集发布后通知 worker 更新登记路径，临时文件清理后仍可读', async () => {
    const space = spaceOf('relay-capture-record')
    const {provider,marker}=await providerFor(space,{rememberCapture:true})
    try {
      await provider.open(scene('s1'),{worldId:'w1'})
      const target=join(space.productRoot,'shots')
      const result=await provider.captureMulti('w1',{outputDir:target,cameraNames:['camera']}) as {captureId:string;path:string}
      expect(result.captureId).toBe('fixture-capture')
      expect(await readFile(result.path,'utf8')).toBe('fake-capture')
      expect(await markerText(marker)).toContain(`capture-published captureId=fixture-capture path=${join(target,'shot.png')} exists=True`)
      expect(existsSync(join(space.runtimeRoot,'staging','media-1'))).toBe(false)
    } finally { await provider.dispose() }
  })

  test('产品根里的符号链接指向授权根外：不中转、不改写，worker 拿到的是原样路径', async () => {
    const space = spaceOf('relay-link')
    const outside = join(base, 'outside')
    await mkdir(space.productRoot, { recursive: true })
    await mkdir(outside, { recursive: true })
    await symlink(outside, join(space.productRoot, 'escape'), 'dir')
    const { provider, marker } = await providerFor(space, { captureWrites: false })
    await provider.open(scene('s1'), { worldId: 'w1' })
    // 词法拼写落在产品根内，真实目标在授权根外。
    const target = join(space.productRoot, 'escape', 'shots')
    expect(pathWithin(space.productRoot, target)).toBe(false)
    const result = await provider.capture('w1', { outputDir: target }) as { path: string }
    const written = await markerText(marker)
    expect(written).toContain(`capture outputDir=${target}`)
    expect(written).not.toContain('staging')
    // 宿主没有代写、也没有把回执改写成"已成功落到产品根"：worker 说什么就浮上来什么。
    expect(result.path).toBe(join(target, 'shot.png'))
    expect(existsSync(join(outside, 'shots'))).toBe(false)
    await provider.dispose()
  })

  test('目标是同工作区里别的会话的产品根：不中转（产品根按会话键展开，canonically 是我的才是我的）', async () => {
    const space = spaceOf('relay-cross')
    const otherRoot = join(base, 'captures', 'sessions', 'relay-cross-other')
    const { provider, marker } = await providerFor(space, { captureWrites: false })
    await provider.open(scene('s1'), { worldId: 'w1' })
    const target = join(otherRoot, 'shots')
    const result = await provider.capture('w1', { outputDir: target }) as { path: string }
    const written = await markerText(marker)
    expect(written).toContain(`capture outputDir=${target}`)
    expect(written).not.toContain('staging')
    expect(result.path).toBe(join(target, 'shot.png'))
    expect(existsSync(target)).toBe(false)
    await provider.dispose()
  })

  test('产品根里的符号链接指向**还不存在**的目录：同样不中转（悬空链接的写入会落到链接指向的地方）', async () => {
    const space = spaceOf('relay-dangling')
    await mkdir(space.productRoot, { recursive: true })
    const ghost = join(base, 'ghost')   // 故意不创建：链接是悬空的
    await symlink(ghost, join(space.productRoot, 'dangling'), 'dir')
    const { provider, marker } = await providerFor(space, { captureWrites: false })
    await provider.open(scene('s1'), { worldId: 'w1' })
    const target = join(space.productRoot, 'dangling', 'shots')
    const result = await provider.capture('w1', { outputDir: target }) as { path: string }
    expect(await markerText(marker)).toContain(`capture outputDir=${target}`)
    expect(await markerText(marker)).not.toContain('staging')
    expect(result.path).toBe(join(target, 'shot.png'))
    expect(existsSync(ghost)).toBe(false)
    await provider.dispose()
  })

  test('目标拼写带 `..` 组件：证明不了内核把字节写到哪就不中转（占位链接 + .. 的回退是内核说了算）', async () => {
    const space = spaceOf('relay-dotdot')
    const outside = join(base, 'outside-dotdot')
    await mkdir(space.productRoot, { recursive: true }); await mkdir(outside, { recursive: true })
    await symlink(outside, join(space.productRoot, 'escape'), 'dir')
    const { provider, marker } = await providerFor(space, { captureWrites: false })
    await provider.open(scene('s1'), { worldId: 'w1' })
    // 物理落点：<productRoot>/escape/.. = <base>/captures/sessions —— 在产品根之外。
    // 拼写里必须**保留** `..`（join 会做词法归一，那正是这里不能用它的原因）。
    const target = `${space.productRoot}/escape/../shots`
    const result = await provider.capture('w1', { outputDir: target }) as { path: string }
    expect(await markerText(marker)).toContain(`capture outputDir=${target}`)
    expect(await markerText(marker)).not.toContain('staging')
    // 回执也**不被改写**：宿主没参与这条写入，worker 说什么就是什么（原样拼写）。
    expect(result.path).toBe(`${target}/shot.png`)
    expect(existsSync(join(base, 'captures', 'sessions', 'shots'))).toBe(false)
    await provider.dispose()
  })

  test('授权根之内的目标本来就不需要中转（worker 自己写）', async () => {
    const space = spaceOf('relay-inside')
    const { provider, marker } = await providerFor(space, {})
    await provider.open(scene('s1'), { worldId: 'w1' })
    const target = join(space.writableRoot, 'shots')
    const result = await provider.capture('w1', { outputDir: target }) as { path: string }
    expect(await markerText(marker)).toContain(`capture outputDir=${target}`)
    expect(result.path).toBe(join(target, 'shot.png'))
    await provider.dispose()
  })
})

describeIfPython('只读会话：用户落盘请求不能被引擎内部缓存的许可借道', () => {
  interface Refusal { code?: string; message: string }
  const refusalOf = (run: Promise<unknown>): Promise<Refusal> => run.then(() => { throw new Error('本该被拒绝') }, (error: unknown) => error as Refusal)

  test('目标指到内部缓存（只读下唯一可写位）：派发前拒绝，worker 没收到请求、缓存里没有新文件', async () => {
    const space = spaceOf('relay-readonly-cache')
    const { provider, marker } = await providerFor(space, {}, 'read-only')
    await provider.open(scene('s1'), { worldId: 'w1' })
    const cacheRoot = join(space.writableRoot, '.lyapunov', 'sessions', space.sessionId, 'engine-cache', 'isaac')
    await mkdir(cacheRoot, { recursive: true })
    const target = join(cacheRoot, 'shots')
    const failure = await refusalOf(provider.capture('w1', { outputDir: target }))
    expect(failure.code).toBe('SIM_MEDIA_POLICY_READ_ONLY')
    expect(failure.message).toContain('read-only')
    // worker 一个字节都没收到（不是"发给引擎再让它失败"），缓存目录里也没有产物。
    expect(await markerText(marker)).not.toContain('capture outputDir=')
    expect(existsSync(join(target, 'shot.png'))).toBe(false)
    await provider.dispose()
  })

  test('目标指到本会话产品根：同样按策略拒绝（只读下没有可写的用户产物位置）', async () => {
    const space = spaceOf('relay-readonly-product')
    const { provider, marker } = await providerFor(space, {}, 'read-only')
    await provider.open(scene('s1'), { worldId: 'w1' })
    const target = join(space.productRoot, 'shots')
    const failure = await refusalOf(provider.capture('w1', { outputDir: target }))
    expect(failure.code).toBe('SIM_MEDIA_POLICY_READ_ONLY')
    expect(await markerText(marker)).not.toContain('capture outputDir=')
    expect(existsSync(target)).toBe(false)
    await provider.dispose()
  })

  test('只读下的读与运行不受影响：观测请求照常派发（拒绝只针对落盘）', async () => {
    const space = spaceOf('relay-readonly-observe')
    const { provider, marker } = await providerFor(space, {}, 'read-only')
    await provider.open(scene('s1'), { worldId: 'w1' })
    await provider.observe('w1', {})
    expect(await markerText(marker)).toContain('request observe')
    await provider.dispose()
  })
})

describe('pathWithin：规范路径判定（符号链接 + 不存在的末端路径）', () => {
  test('末端路径还不存在时照常判定（导出/采集目录通常先于第一次写入不存在）', async () => {
    const root = join(base, 'root')
    await mkdir(root, { recursive: true })
    expect(pathWithin(root, join(root, 'a', 'b', 'c.json'))).toBe(true)
    expect(pathWithin(root, join(base, 'elsewhere', 'c.json'))).toBe(false)
  })

  test('根里的符号链接指向根外：不是"在根内"；指向根内则照旧是', async () => {
    const root = join(base, 'root2'), inside = join(root, 'inside'), outside = join(base, 'outside2')
    await mkdir(root, { recursive: true }); await mkdir(inside, { recursive: true }); await mkdir(outside, { recursive: true })
    await symlink(outside, join(root, 'out-link'), 'dir')
    await symlink(inside, join(root, 'in-link'), 'dir')
    expect(pathWithin(root, join(root, 'out-link', 'x.json'))).toBe(false)
    expect(pathWithin(root, join(root, 'in-link', 'x.json'))).toBe(true)
  })

  test('悬空链接（指向还不存在的目录）与链接链：都按最终指向判定，不看词法拼写', async () => {
    const root = join(base, 'root3'), ghost = join(base, 'ghost3'), outside = join(base, 'outside3')
    await mkdir(root, { recursive: true }); await mkdir(outside, { recursive: true })
    await symlink(ghost, join(root, 'dangling'), 'dir')                 // ghost3 故意不创建
    await symlink(join(root, 'dangling'), join(root, 'chain'), 'dir')   // 链到悬空链接
    await symlink(outside, join(root, 'out'), 'dir')
    await symlink(join(root, 'out'), join(root, 'out2'), 'dir')         // 链到根外
    expect(pathWithin(root, join(root, 'dangling', 'x.json'))).toBe(false)
    expect(pathWithin(root, join(root, 'chain', 'x.json'))).toBe(false)
    expect(pathWithin(root, join(root, 'out2', 'x.json'))).toBe(false)
  })
})
