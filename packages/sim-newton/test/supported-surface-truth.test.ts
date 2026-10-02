/**
 * DEV-008／W5 反查：`CAPABILITIES.supported` 这一面必须有「声明 ↔ 现实」对照（真机 worker）。
 *
 * 为什么单独一个文件（验收回执 `bugfixHistory/VERIFY-NEWTON-CAPABILITY-20260926.md` §4 D1）：
 * `capability-truth.test.ts` 对 `supported` 唯一的断言是「`ready` 与 `capabilities` 两份**自报**相等」
 * —— 自己等于自己。于是 `README.md` 里那条**反向假声明**（"当前独立环境没装 trimesh、带 mesh 的模型
 * 会 PROVIDER_DEPENDENCY_MISSING"）没有任何测试会红。本文件把 12 个声明为 true 的键**逐个配上另一条
 * 路径的真机读数**（不是第二份自报），并给三处被真机推翻的措辞加上守卫。
 *
 * 每条断言的形状都是「声明 ↔ 现实」三元组：`{ key, declared, reality }` ⇒ `{ key, declared: true, reality: true }`。
 * `declared` 是 worker 自报的表（**被验的声明**），`reality` 是**另一条路径**上的读数（真的编译 / 真的导入 /
 * 真的观测 / 真的消失 / 真的按挂钟推进）。两个方向都会红：
 *  · 把某个键声明成 false 而现实仍可用（反向假声明）⇒ declared 与 reality 不等 ⇒ 红；
 *  · 把某个键声明成 true 而现实做不到 ⇒ reality 为 false ⇒ 红。
 * 另有一条完整性断言：`supported` 里出现**本文件没有真机读数**的键 ⇒ 红（不许"只声明不验证"）。
 *
 * 负对照（读数见 `bugfixHistory/NEWTON-DECLARATION-FIX-20260926.md`）：
 *  · `LYAPUNOV_NEWTON_WORKER_PATH=<把 supported 某键改成 false 的副本>` ⇒ 本文件精确变红；
 *  · 把 README／worker 注释的任何一处改回旧措辞 ⇒ 文档面三条断言精确变红。
 *
 * 引擎面需要真实 Newton 环境（`.runtime/newton-env/bin/python`），缺失即整体 skip（不假装通过）；
 * 文档面只读文件，不需要引擎，因此不 skip。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEV = resolve(HERE, '../../..')
const PYTHON = join(DEV, '.runtime/newton-env/bin/python')
/** 默认就是本包真机 worker；`LYAPUNOV_NEWTON_WORKER_PATH` 只用于把矩阵指向另一份副本（负对照用，不是产品开关）。 */
const WORKER = process.env.LYAPUNOV_NEWTON_WORKER_PATH ?? join(DEV, 'packages/sim-newton/python/worker.py')
/** 文档面永远读仓里那一份，不受 `LYAPUNOV_NEWTON_WORKER_PATH` 影响。 */
const REPO_WORKER = join(DEV, 'packages/sim-newton/python/worker.py')
const README = join(DEV, 'packages/sim-newton/README.md')
const ARM = join(DEV, 'packages/sim-mujoco/fixtures/arm.xml')
const GO1_URDF = join(DEV, 'materials/robots/unitree_go1/xml/go1.urdf')
const PANDA_MJCF = join(DEV, 'materials/robots/franka_panda/franka_emika_panda/panda_nohand.xml')
const available = existsSync(PYTHON) && existsSync(WORKER)

/** inline MJCF：一个带 `<freejoint>` 的自由根球（`freeBodies` 声明的最小可判据世界）。 */
const FREE_BODY_XML = `<mujoco model="free-ball">
  <compiler angle="radian"/>
  <worldbody>
    <body name="ball" pos="0 0 0.5">
      <freejoint name="ball-free"/>
      <geom type="sphere" size="0.05" mass="1"/>
    </body>
  </worldbody>
</mujoco>
`

/** `CAPABILITIES.supported` 里声明为 true 的 12 个键（第 13 个 `execute=false` 由 capability-truth.test.ts 逐个触发拒绝）。 */
const SUPPORTED_KEYS = [
  'open', 'sync', 'observe', 'describe', 'close', 'list_worlds',
  'mjcf', 'urdf', 'groundPlane', 'realtimeClock', 'freeBodies', 'articulatedJoints',
] as const

type Reply = { result?: any; error?: { code?: string; message?: string } }
type Request = { id: string; method: string; args: unknown }

const POSE = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }

/** 文件型原生源（MJCF/URDF 都走 `components.mujoco.sourcePath`，与 sim-mujoco 同口径）。 */
function fileSnapshot(sceneId: string, entityId: string, sourcePath: string, revision = 1) {
  return { sceneId, revision, entities: [{ entityId, name: entityId, transform: POSE, components: { mujoco: { sourcePath } } }] }
}

/** 内联 MJCF（`components.mujoco.xml`）。 */
function inlineSnapshot(sceneId: string, entityId: string, xml: string) {
  return { sceneId, revision: 1, entities: [{ entityId, name: entityId, transform: POSE, components: { mujoco: { xml } } }] }
}

/** 起一个真实 worker，按序发请求，回读 (events, id→response, exitCode)。id 是具名串，断言里不依赖请求下标。 */
function drive(requests: Request[]) {
  const lines = requests.map(request => JSON.stringify(request))
  lines.push(JSON.stringify({ id: '__eof', method: 'shutdown', args: {} }))
  const run = spawnSync(PYTHON, ['-u', WORKER], {
    cwd: DEV, input: lines.join('\n') + '\n', encoding: 'utf8', timeout: 900_000,
    env: { ...process.env, LYAPUNOV_NEWTON_CACHE_ROOT: cacheRoot! },
  })
  const events: any[] = []
  const replies = new Map<string, Reply>()
  for (const line of run.stdout.split('\n')) {
    const text = line.trim()
    if (!text) continue
    let message: any
    try { message = JSON.parse(text) } catch { continue }   // warp 的内核装载提示行不是协议
    if (message.event) events.push(message)
    else replies.set(String(message.id), message)
  }
  return { events, replies, status: run.status, stderr: run.stderr }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type Session = {
  events: any[]
  ready: Promise<any>
  send: (id: string, method: string, args: unknown, timeoutMs?: number) => Promise<Reply>
  stop: () => Promise<void>
}

/**
 * 交互式会话：realtime 时钟**必须**在请求之间真的等挂钟（批量送请求会被 worker 一次收完，量不到推进），
 * 所以这里逐条写 stdin、按 id 等回复。
 */
function openSession(): Session {
  const proc = spawn(PYTHON, ['-u', WORKER], {
    cwd: DEV, env: { ...process.env, LYAPUNOV_NEWTON_CACHE_ROOT: cacheRoot! },
  })
  const events: any[] = []
  const waiters = new Map<string, (reply: Reply) => void>()
  let pending = ''
  let settleReady!: (event: any) => void
  const ready = new Promise<any>(resolve => { settleReady = resolve })
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    pending += chunk
    let index: number
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index).trim()
      pending = pending.slice(index + 1)
      if (!line) continue
      let message: any
      try { message = JSON.parse(line) } catch { continue }
      if (message.event) {
        events.push(message)
        if (message.event === 'ready' || message.event === 'fatal') settleReady(message)
        continue
      }
      const waiter = waiters.get(String(message.id))
      if (waiter) { waiters.delete(String(message.id)); waiter(message) }
    }
  })
  const send = (id: string, method: string, args: unknown, timeoutMs = 240_000) =>
    new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id)
        reject(new Error(`worker 未在 ${timeoutMs} ms 内回复 ${id}`))
      }, timeoutMs)
      waiters.set(id, reply => { clearTimeout(timer); resolve(reply) })
      proc.stdin!.write(JSON.stringify({ id, method, args }) + '\n')
    })
  const stop = async () => {
    try { await send('__bye', 'shutdown', {}, 30_000) } catch { /* worker 可能已经退出 */ }
    if (proc.exitCode === null) {
      const exited = new Promise<void>(resolve => proc.once('exit', () => resolve()))
      proc.kill()
      await Promise.race([exited, sleep(10_000)])
    }
  }
  return { events, ready, send, stop }
}

let cacheRoot: string | undefined
beforeAll(() => { cacheRoot = mkdtempSync(join(tmpdir(), 'dev008-ss-')) })
afterAll(() => { if (cacheRoot) rmSync(cacheRoot, { recursive: true, force: true }); cacheRoot = undefined })

describe.skipIf(!available)('DEV-008：supported 面逐键「声明 ↔ 现实」对照（真机 worker）', () => {
  let run: ReturnType<typeof drive>

  beforeAll(() => {
    run = drive([
      { id: 'capabilities', method: 'capabilities', args: {} },
      { id: 'arm-open', method: 'open', args: { snapshot: fileSnapshot('ss-arm', 'arm-a', ARM), options: { worldId: 'w-ss', timestepS: 0.002, clock: 'manual' } } },
      { id: 'arm-list-worlds', method: 'list_worlds', args: {} },
      { id: 'arm-describe', method: 'describe', args: { worldId: 'w-ss', entityId: 'arm-a' } },
      { id: 'arm-observe', method: 'observe', args: { worldId: 'w-ss', selection: {} } },
      // 同一 scene 的新 revision：签名未变 ⇒ 只推进 appliedSceneRevision，不重编译（worldGeneration 不变）。
      { id: 'arm-sync', method: 'sync', args: { worldId: 'w-ss', snapshot: fileSnapshot('ss-arm', 'arm-a', ARM, 2) } },
      // groundPlane 的反面：显式 ground:false（与默认那次的 groundGeomNames 成对）。
      { id: 'ground-off-open', method: 'open', args: { snapshot: fileSnapshot('ss-noground', 'arm-a', ARM), options: { worldId: 'w-ss-noground', clock: 'manual', ground: false } } },
      // urdf：仓里真实的 URDF 资产（含 STL 网格引用），走 `add_urdf`。
      { id: 'urdf-open', method: 'open', args: { snapshot: fileSnapshot('ss-urdf', 'go1', GO1_URDF), options: { worldId: 'w-ss-urdf', clock: 'manual' } } },
      { id: 'urdf-describe', method: 'describe', args: { worldId: 'w-ss-urdf', entityId: 'go1' } },
      // freeBodies：内联 MJCF 的自由根。
      { id: 'free-open', method: 'open', args: { snapshot: inlineSnapshot('ss-free', 'ball', FREE_BODY_XML), options: { worldId: 'w-ss-free', clock: 'manual' } } },
      { id: 'free-describe', method: 'describe', args: { worldId: 'w-ss-free', entityId: 'ball' } },
      { id: 'free-observe', method: 'observe', args: { worldId: 'w-ss-free', selection: {} } },
      // 含 mesh 的 MJCF（README 曾经说它开不了的那个文件）。
      { id: 'mesh-open', method: 'open', args: { snapshot: fileSnapshot('ss-mesh', 'panda', PANDA_MJCF), options: { worldId: 'w-ss-mesh', clock: 'manual' } } },
      { id: 'mesh-describe', method: 'describe', args: { worldId: 'w-ss-mesh', entityId: 'panda' } },
      { id: 'arm-close', method: 'close', args: { worldId: 'w-ss' } },
      { id: 'arm-list-after-close', method: 'list_worlds', args: {} },
      { id: 'arm-observe-after-close', method: 'observe', args: { worldId: 'w-ss', selection: {} } },
    ])
  }, 900_000)

  test('12 个声明键逐条「声明 ↔ 现实」对照；声明表里不许有本文件量不到的键', () => {
    expect(run.status).toBe(0)
    // 先钉"读数都在"：任一条探针被拒（error）都在这里以码+报文暴露，而不是在下面抛 TypeError。
    // （`arm-observe-after-close` 不在列：它**应该**报 WORLD_NOT_FOUND；`mesh-*` 归下一条用例。）
    const probeIds = ['arm-open', 'arm-list-worlds', 'arm-describe', 'arm-observe', 'arm-sync', 'ground-off-open',
      'urdf-open', 'urdf-describe', 'free-open', 'free-describe', 'free-observe', 'arm-close', 'arm-list-after-close']
    expect(probeIds.map(id => ({ id, error: run.replies.get(id)?.error?.code ?? null })))
      .toEqual(probeIds.map(id => ({ id, error: null })))
    const declared = run.replies.get('capabilities')!.result.supported as Record<string, boolean>
    const armOpen = run.replies.get('arm-open')!.result
    const armDescribe = run.replies.get('arm-describe')!.result
    const armObserve = run.replies.get('arm-observe')!.result
    const armSync = run.replies.get('arm-sync')!.result
    const groundOffOpen = run.replies.get('ground-off-open')!.result
    const urdfOpen = run.replies.get('urdf-open')!.result
    const urdfDescribe = run.replies.get('urdf-describe')!.result
    const freeDescribe = run.replies.get('free-describe')!.result
    const freeObserve = run.replies.get('free-observe')!.result
    const listBefore = run.replies.get('arm-list-worlds')!.result as any[]
    const listAfter = run.replies.get('arm-list-after-close')!.result as any[]
    const observeAfterClose = run.replies.get('arm-observe-after-close')!
    const armJoints = armObserve.entities[0].joints

    // 现实侧：每一条都来自**声明之外**的另一条路径（真的编译 / 真的导入 / 真的观测 / 真的消失）。
    const reality: Record<string, boolean> = {
      open: armOpen.status === 'ready' && armOpen.engineId === 'newton' && armOpen.solver === 'xpbd' && armOpen.warnings.length === 0,
      sync: armSync.status === 'ready' && armSync.appliedSceneRevision === 2 && armSync.worldGeneration === 1,
      observe: armObserve.stepIndex === 0 && armObserve.entities.length === 1 && armObserve.executionMode === 'physical-contact',
      describe: armDescribe.joints.length === 3 && armDescribe.freeBases.length === 0,
      close: run.replies.get('arm-close')!.result === null && observeAfterClose.error?.code === 'WORLD_NOT_FOUND'
        && !listAfter.some(world => world.worldId === 'w-ss'),
      list_worlds: listBefore.some(world => world.worldId === 'w-ss' && world.status === 'ready'),
      mjcf: armDescribe.joints.length === 3 && armDescribe.nativeShapeLabels.length >= 1,
      urdf: urdfOpen?.status === 'ready' && urdfDescribe?.joints?.length === 12
        && urdfDescribe.joints.every((joint: any) => String(joint.name).startsWith('go1_description/')),
      groundPlane: JSON.stringify(armOpen.groundGeomNames) === JSON.stringify(['__ground']) && groundOffOpen.groundGeomNames.length === 0,
      // realtimeClock 在下面单独的 describe 里量（要在请求之间真的等挂钟）。
      realtimeClock: true,
      freeBodies: freeDescribe?.freeBases?.length === 1
        && freeObserve.entities[0].sensors.freeBases[freeDescribe.freeBases[0].jointName].positionM[2] === 0.5,
      articulatedJoints: armJoints.names.length === 3 && armJoints.positions.length === 3 && armJoints.velocities.length === 3
        && armJoints.positions.every((value: number) => Number.isFinite(value)),
    }

    for (const key of SUPPORTED_KEYS) {
      if (key === 'realtimeClock') continue                  // 由 realtime describe 量，见下
      expect({ key, declared: declared[key], reality: reality[key] }).toEqual({ key, declared: true, reality: true })
    }

    // 完整性：`supported` 里出现本文件没有真机读数的键（或漏掉一个已知键）都要红 —— 不许"只声明不验证"。
    expect(Object.keys(declared).sort()).toEqual([...SUPPORTED_KEYS, 'execute'].sort())
  }, 900_000)

  test('含 mesh 资产的 MJCF 真的能导入：README 那条反向假声明不许回来', () => {
    // 先钉"读数在"：open 被拒时把码与报文露出来，而不是抛 TypeError。
    const meshOpenReply = run.replies.get('mesh-open')!
    expect({ id: 'mesh-open', error: meshOpenReply.error?.code ?? null, message: meshOpenReply.error?.message ?? null })
      .toEqual({ id: 'mesh-open', error: null, message: null })
    const meshOpen = meshOpenReply.result
    const meshDescribe = run.replies.get('mesh-describe')!.result
    // 真机读数：trimesh 5.1.0 在装 ⇒ panda_nohand.xml（含 <mesh>）open → ready、warnings=[]。
    expect({ status: meshOpen.status, warnings: meshOpen.warnings }).toEqual({ status: 'ready', warnings: [] })
    expect(meshDescribe.joints.length).toBe(7)
    expect(meshDescribe.nativeShapeLabels.length).toBeGreaterThanOrEqual(50)
  }, 900_000)

  test('kernelCacheDir 三处同名不同义：handle=配置基目录，ready/capabilities=实际生效目录（含 warp 版本子目录）', () => {
    const ready = run.events.find(event => event.event === 'ready')!
    const capabilities = run.replies.get('capabilities')!.result
    const handle = run.replies.get('arm-open')!.result
    // 实际生效目录 = <配置基目录>/<warp 版本>（warp 自己在 init 时补上版本子目录）。
    expect(ready.kernelCacheDir).toBe(join(cacheRoot!, ready.warpVersion))
    expect(capabilities.kernelCacheDir).toBe(ready.kernelCacheDir)
    // 句柄上的是 init **之前**的配置值：没有版本子目录，因此**不是**"真正生效目录"（worker 注释已按此更正）。
    expect(handle.kernelCacheDir).toBe(cacheRoot!)
    expect(handle.kernelCacheDir).not.toBe(ready.kernelCacheDir)
    // note 的 token 名必须与它装的值说同一件事：`configured_cache_root=` 装的是**配置基目录**（= 句柄那个值，
    // 没有版本子目录），**不是**生效目录 ⇒ 它不许再叫 `kernel_cache_dir=`（那个名字与 warp init 之后回读的
    // `wp.config.kernel_cache_dir` 撞名，会被读成生效目录）。三条路径的 note 是同一份，逐条核对。
    for (const [where, note] of [['ready', ready.kernelCacheNote], ['capabilities', capabilities.kernelCacheNote],
                                 ['handle', handle.kernelCacheNote]] as const) {
      expect({ where, token: String(note).split('=')[0] }).toEqual({ where, token: 'configured_cache_root' })
      expect(String(note).startsWith(`configured_cache_root=${cacheRoot!}（来源：`)).toBe(true)
      expect(String(note)).not.toContain('kernel_cache_dir=')
    }
  }, 900_000)
})

describe.skipIf(!available)('DEV-008：realtimeClock 声明 ↔ 现实（真机 worker，交互式驱动）', () => {
  test('realtime 世界真按挂钟推进：stepIndex 涨、simTime=stepIndex×dt、frame 事件持续到达', async () => {
    const session = openSession()
    try {
      const readyEvent = await session.ready
      expect(readyEvent.event).toBe('ready')
      const declared = (await session.send('cap', 'capabilities', {})).result.supported as Record<string, boolean>
      const opened = await session.send('open', 'open', {
        snapshot: fileSnapshot('ss-realtime', 'arm-a', ARM),
        options: { worldId: 'w-ss-rt', clock: 'realtime', timestepS: 0.002, frameRateHz: 30 },
      })
      expect(opened.result.status).toBe('ready')
      expect(opened.result.clock).toBe('realtime')

      // 判据是"最终真的推进过"，不是"多久推进一格"：冷缓存的首个 tick 会被内核 JIT 阻塞十几秒，
      // 机器负载也会拉长它 —— 这里是能力声明（能不能推），不是性能声明。
      const deadline = Date.now() + 240_000
      let advanced: any = null
      let attempt = 0
      while (!advanced && Date.now() < deadline) {
        const reply = await session.send(`obs-${attempt++}`, 'observe', { worldId: 'w-ss-rt', selection: {} })
        if (reply.result && reply.result.stepIndex > 0) advanced = reply.result
        else await sleep(200)
      }
      expect(advanced).not.toBeNull()

      const before = advanced.stepIndex
      await sleep(1000)
      const later = (await session.send('obs-late', 'observe', { worldId: 'w-ss-rt', selection: {} })).result
      const frames = session.events.filter(event => event.event === 'frame')

      // 与上面 11 个键**同一个判据形状**：声明侧（worker 自报）↔ 现实侧（真读数）。
      expect({
        key: 'realtimeClock',
        declared: declared.realtimeClock,
        reality: advanced.stepIndex > 0 && later.stepIndex > before && frames.length > 0
          && Math.abs(later.simTime - later.stepIndex * 0.002) < 1e-9,
      }).toEqual({ key: 'realtimeClock', declared: true, reality: true })
    } finally {
      await session.stop()
    }
  }, 600_000)
})

/**
 * 文档面守卫：被真机推翻的措辞不许回来（三条对应上一轮的三处改写），外加"冷缓存首个 tick 会阻塞"
 * 这条**声明不全**的补写守卫（`VERIFY-NEWTON-CAPABILITY-20260926.md` §D3 点名、上一轮未改的文档缺口）。
 *
 * **强度边界（不许当成"README 已经正确"的证明）**：这几条是**文本/正则断言** —— 它们只能保证那几句
 * 被真机推翻的话不再出现、且改正后的关键事实（真实回落候选名 / fatal 报文原文 / 基目录语义 /
 * 首个 tick 的阻塞读数）还在，不能证明 README 的每句话都真。行为的真由上面的真机用例与
 * `warp-cache-dir.test.ts` 负责（后者钉显式可写 / 显式不可写改用它处 / 全不可写即 fatal 三条路径）。
 */
describe('DEV-008：声明面措辞守卫（README 与 worker 注释）', () => {
  test('README 不再声称"当前独立环境没装 trimesh"：含 mesh 的模型可用', () => {
    const readme = readFileSync(README, 'utf8')
    expect(readme).not.toContain('当前独立环境没装')
    // 改正后的那行必须指向真机探针用的同一个文件（含 mesh 的 Franka Panda）。
    expect(readme).toContain('panda_nohand.xml')
  })

  test('README 的缓存口径写明真实回落候选与"全不可写即 fatal"，不再说只告警回落默认缓存', () => {
    const readme = readFileSync(README, 'utf8')
    expect(readme).not.toContain('只告警并回落')
    // TMPDIR 候选（真机回落目标之一；warp-cache-dir.test.ts 也钉了这条路径）。
    expect(readme).toContain('lyapunov-warp-')
    // worker 的 fatal 报文原文：文档与用户实际看到的报文不许各说各话。
    expect(readme).toContain('找不到可写的 Warp 内核缓存目录')
  })

  test('worker 注释不再把 WorldHandle.kernelCacheDir 自称"真正生效"目录', () => {
    const worker = readFileSync(REPO_WORKER, 'utf8')
    expect(worker).not.toContain('真正生效的 Warp 内核缓存目录')
    // 改正后的注释必须说清它是 init 之前的**配置基目录**（值没变，只是不再声称它是生效目录）。
    expect(worker).toContain('配置的 Warp 内核缓存基目录')
  })

  test('README 写明冷缓存首个 realtime tick 会阻塞十几秒（用户会以为"卡死"的那一格）', () => {
    const readme = readFileSync(README, 'utf8')
    // 判据钉在「Warp 内核缓存」这一节里：读者问"为什么第一个 tick 不动"时看的就是这里，
    // 因此只在那节之外提一句不算补上（实测读数也写在这一节）。
    const cacheSection = readme.split('## Warp 内核缓存')[1]?.split('\n## ')[0] ?? ''
    // 只写"冷缓存慢"不够：用户看到的现象是"第一个 tick 不动"，必须点到这一格（同一句里三件事齐）。
    expect(cacheSection).toMatch(/(首个|第一个)[^。\n]*tick[^。\n]*阻塞[^。\n]*十几秒/)
    // 并且要给出"这是冷缓存、不是卡死"的判据（否则等于把现象原样丢回给用户）。
    expect(cacheSection).toContain('不是卡死')
  })
})
