/**
 * W18 回归：**收尾失败不许静默**（两条残余静默面）。
 *
 * 1. `openImpl` 的失败收尾原来写 `await child.dispose().catch(()=>{})`：dispose 失败被吞掉，
 *    调用方只看到原始失败，而那只 worker 可能还活着、没有任何记录。
 * 2. `close()` 的 finally 原来**无条件** `instances.delete`：close/dispose 失败时句柄被摘除，
 *    worker 既不在册（Host 级 dispose() 只枚举 instances/pending，够不着）也没被关掉，
 *    而且 `closing` 里留着那条失败结论 ⇒ 重试也不是重试。
 *
 * 这里用真实 `IsaacProvider` + 真实子进程传输 + 最小假 worker；只有 `dispose` 这一处按用例注入失败
 * （fail-closed 收尾本身没法靠"真 worker 不听话"稳定制造：传输层的 terminateOwned 最终会 SIGKILL）。
 * 断言口径与 W3 的三条路径一致：**pid 级**（活着/死了）+ 孤儿登记可追溯 + 重试后差值 0。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IsaacProvider } from '../src/provider.ts'
import { SimError } from '../../sim-contract/src/index.ts'
import type { ProcessSimProvider } from '../../sim-contract/src/python-transport.ts'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'

const PYTHON = ['/usr/bin/python3', '/usr/local/bin/python3', '/bin/python3'].find(candidate => existsSync(candidate))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const scene = (sceneId = 'w18-scene'): SceneSnapshot => ({
  sceneId, revision: 0,
  coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' },
  entities: [],
})

let base: string | undefined
const providers: IsaacProvider[] = []
const spawned: number[] = []
afterEach(async () => {
  for (const pid of spawned.splice(0)) { try { process.kill(pid, 'SIGKILL') } catch { /* 已经死了 */ } }
  for (const provider of providers.splice(0)) await provider.dispose().catch(() => undefined)
  if (base) await rm(base, { recursive: true, force: true })
  base = undefined
})

/** 最小假 worker：open/close/stop/list_worlds/shutdown 的行协议（引擎进程本身不参与本用例结论）。 */
const WORKER_SOURCE = `import json, os, sys, time
def emit(value): print(json.dumps(value), flush=True)
emit({'event': 'ready', 'engine': 'isaac', 'version': '0.0.0-fake', 'pid': os.getpid()})
worlds = {}
for line in sys.stdin:
    request = json.loads(line)
    method, args = request.get('method'), request.get('args', {})
    if method == 'open':
        world = args.get('options', {}).get('worldId') or 'w'
        delay = float(os.environ.get('W18_OPEN_DELAY') or 0)
        if delay: time.sleep(delay)
        result = {'worldId': world, 'sceneId': 's', 'engineId': 'isaac', 'engineVersion': '0.0.0-fake',
                  'worldGeneration': 1, 'appliedSceneRevision': 0, 'status': 'ready', 'clock': 'manual',
                  'timestepS': 0.01, 'groundGeomNames': [], 'warnings': []}
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

async function provider(): Promise<IsaacProvider> {
  base = await mkdtemp(join(tmpdir(), 'isaac-w18-'))
  const cache = join(base, 'cache')
  await mkdir(cache, { recursive: true })
  const workerPath = join(base, 'fake-worker.py')
  await writeFile(workerPath, WORKER_SOURCE)
  const instance = new IsaacProvider({ pythonPath: PYTHON!, workerPath, cacheRoot: cache })
  providers.push(instance)
  return instance
}
type InstanceProbe = { instances: Map<string, { process: ProcessSimProvider }>; pending: Map<string, ProcessSimProvider> }
const processOf = (instance: IsaacProvider, worldId: string): ProcessSimProvider => {
  const child = (instance as unknown as InstanceProbe).instances.get(worldId)?.process
  if (!child) throw new Error(`夹具里没有 world ${worldId} 的进程`)
  return child
}
/** 只在本次收尾上注入 dispose 失败；`restore()` 之后同一对象恢复真实 dispose。 */
function failingDispose(child: ProcessSimProvider, message = '测试注入：dispose 失败'): () => void {
  const target = child as unknown as { dispose: () => Promise<void> }
  const real = target.dispose
  target.dispose = () => Promise.reject(new Error(message))
  return () => { delete (child as unknown as Record<string, unknown>).dispose; void real }
}
async function rejection(promise: Promise<unknown>): Promise<SimError> {
  return promise.then(() => { throw new Error('期望失败，但它成功了') }, error => error as SimError)
}
async function until(check: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)) }
  throw new Error(`等待超时：${what}`)
}

describe.skipIf(PYTHON === undefined)('W18：收尾失败不静默（真实 Provider + 真实子进程）', () => {
  test('close 的 dispose 失败：登记孤儿（含 pid/路径/原文）、句柄保留可重试，重试成功后差值 0', async () => {
    const instance = await provider()
    const worldId = 'w18-close'
    await instance.open(scene(), { worldId })
    const child = processOf(instance, worldId)
    const pid = child.pid!
    spawned.push(pid)
    expect(alive(pid)).toBe(true)

    const restore = failingDispose(child, '测试注入：close 收尾 dispose 失败')
    const failure = await rejection(instance.close(worldId))
    expect(failure.code).toBe('WORLD_CLOSE_INCOMPLETE')
    expect(failure.message).toContain(`pid=${pid}`)
    expect(failure.message).toContain('未被确认结束')
    expect(failure.message).toContain('可重试 close')
    // 可追溯记录：哪条路径、哪个 pid、dispose 原文、最后停在哪一阶段。
    const orphans = instance.orphanedWorkers()
    expect(orphans).toHaveLength(1)
    expect(orphans[0]).toMatchObject({ worldId, pid })
    expect(orphans[0]!.path).toContain('close 收尾')
    expect(orphans[0]!.error).toContain('测试注入：close 收尾 dispose 失败')
    expect(orphans[0]!.phases.map(phase => phase.name)).toContain('spawned')
    // 事实分两层：**世界**在传输层已经 close（listWorlds 为空），但**worker 进程**未被回收、句柄仍保留在册。
    // "句柄保留"由下一段的重试证明：若像修复前那样无条件摘除 instance，重试会直接 WORLD_NOT_FOUND。
    expect(await instance.listWorlds()).toEqual([])
    expect(instance.lifecyclePhases(worldId).map(phase => phase.name)).toContain('spawned')
    expect(alive(pid)).toBe(true)

    // 重试是真重试：换回真实 dispose 后同一次 close 必须成功，并清掉孤儿记录（差值 0）。
    restore()
    await instance.close(worldId)
    expect(instance.orphanedWorkers()).toEqual([])
    expect(await instance.listWorlds()).toEqual([])
    await until(() => !alive(pid), '重试后 worker 进程退出')
  }, 30_000)

  test('open 未交付时的收尾 dispose 失败：不吞、原始 code 保留、并进孤儿事实', async () => {
    // 让这次 open 停在"worker 已 ready、世界尚未交付"的窗口里，取消才落得进去。
    process.env.W18_OPEN_DELAY = '3'
    try {
    const instance = await provider()
    const worldId = 'w18-open'
    const controller = new AbortController()
    const opening = rejection(instance.open(scene(), { worldId }, controller.signal))
    await until(() => (instance as unknown as InstanceProbe).pending.has(worldId), 'open 已交给传输层')
    const child = (instance as unknown as InstanceProbe).pending.get(worldId)!
    const pid = child.pid!
    spawned.push(pid)
    const restore = failingDispose(child, '测试注入：启动失败收尾 dispose 失败')
    controller.abort()
    const failure = await opening
    // 取消的结构化语义不能被收尾失败改写成另一个码。
    expect(failure.code).toBe('PROVIDER_START_CANCELLED')
    expect(failure.message).toContain('未被确认结束')
    expect(failure.message).toContain(`pid=${pid}`)
    expect(failure.message).toContain('测试注入：启动失败收尾 dispose 失败')
    const orphans = instance.orphanedWorkers()
    expect(orphans).toHaveLength(1)
    expect(orphans[0]).toMatchObject({ worldId, pid })
    expect(orphans[0]!.path).toContain('open')
    expect(orphans[0]!.error).toContain('测试注入：启动失败收尾 dispose 失败')
    // 不声称 liveness：这条路径上传输层自己也可能按归属结束它。登记的是"provider 没能确认它结束"，
    // 这与 pid 现在是死是活无关——要的是这个事实不被吞掉。测试按 pid 兜底收尾，避免真留下进程。
    restore()
    if (alive(pid)) process.kill(pid, 'SIGKILL')
    await until(() => !alive(pid), '测试兜底结束注入失败的 worker')
    } finally { delete process.env.W18_OPEN_DELAY }
  }, 30_000)

  test('Host 级 dispose 失败：同样登记孤儿（不再只抛一个理由）', async () => {
    const instance = await provider()
    const worldId = 'w18-host'
    await instance.open(scene(), { worldId })
    const child = processOf(instance, worldId)
    const pid = child.pid!
    spawned.push(pid)
    const restore = failingDispose(child, '测试注入：Host 级 dispose 失败')
    const failure = await rejection(instance.dispose())
    expect(failure.message).toContain('测试注入：Host 级 dispose 失败')
    const orphans = instance.orphanedWorkers()
    expect(orphans).toHaveLength(1)
    expect(orphans[0]).toMatchObject({ worldId, pid })
    expect(orphans[0]!.path).toContain('Host 级 dispose()')
    restore()
    process.kill(pid, 'SIGKILL')
    await until(() => !alive(pid), '测试自行结束注入失败的 worker')
  }, 30_000)
})
