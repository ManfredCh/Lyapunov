/** Offline lifecycle regressions: only barriers and tiny fake Python workers. */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProcessSimProvider, type SimWorkerLaunchHook } from '../../sim-contract/src/python-transport.ts'
import { SimError } from '../../sim-contract/src/index.ts'
import { commandRouteResponse } from '../../lyapunov-contracts/src/command-privacy.ts'
import { IsaacProvider } from '../src/provider.ts'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'

const PYTHON = '/usr/bin/python3'
const scene = (): SceneSnapshot => ({
  sceneId: 'offline-lifecycle', revision: 0,
  coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' },
  entities: [],
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('lifecycle operation did not settle')), 2000)
    })])
  } finally { clearTimeout(timer) }
}
function rejection(promise: Promise<unknown>): Promise<SimError> {
  return promise.then(() => { throw new Error('expected rejection') }, error => error)
}
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const scratch: string[] = []
afterEach(async () => { for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sim-lifecycle-'))
  scratch.push(root)
  const workerPath = join(root, 'fake-worker.py')
  await writeFile(workerPath, `import json, sys
worlds = {}
print(json.dumps({'event': 'ready'}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    method, args = req['method'], req.get('args', {})
    if method == 'open':
        scene, options = args['snapshot'], args['options']
        result = dict(worldId=options['worldId'], sceneId=scene['sceneId'], engineId='fake',
                      engineVersion='offline', worldGeneration=1, appliedSceneRevision=scene['revision'],
                      status='ready', clock='manual', timestepS=0.01, groundGeomNames=[], warnings=[])
        worlds[result['worldId']] = result
    elif method == 'list_worlds':
        result = list(worlds.values())
    else:
        result = None
    print(json.dumps({'id': req['id'], 'result': result}), flush=True)
    if method == 'shutdown':
        break
`)
  return { root, workerPath }
}
function launchBarrier() {
  const entered = deferred<AbortSignal | undefined>()
  const release = deferred<void>()
  const returned = deferred<void>()
  let calls = 0
  const launch: SimWorkerLaunchHook = async input => {
    calls++
    entered.resolve(input.signal)
    await release.promise // Deliberately ignore cancellation like an external launch resolver might.
    returned.resolve()
    return {
      argv: [input.pythonPath, '-u', input.workerPath], env: input.env,
      facts: { sessionId: 'offline', mode: 'workspace-write', workspaceRoot: tmpdir(), writableRoot: tmpdir(), runtimeRoot: tmpdir() },
    }
  }
  return { launch, entered, release, returned, calls: () => calls }
}

describe.skipIf(!existsSync(PYTHON))('ProcessSimProvider lifecycle', () => {
  test('dispose settles while an entered launch hook remains blocked, and ignores its late result', async () => {
    const { workerPath } = await fixture()
    const barrier = launchBarrier()
    const provider = new ProcessSimProvider({ pythonPath: PYTHON, workerPath, engineName: 'fake', launch: barrier.launch })
    const opening = rejection(provider.open(scene(), { worldId: 'late-hook' }))
    try {
      const signal = await bounded(barrier.entered.promise)
      expect(barrier.calls()).toBe(1)
      expect(provider.pid).toBeUndefined()
      const disposing = provider.dispose()
      expect(provider.dispose()).toBe(disposing)
      await bounded(disposing) // Must not depend on releasing the hook.
      expect((await bounded(opening)).code).toBe('PROVIDER_CLOSED')
      expect(signal?.aborted).toBe(true)
      barrier.release.resolve()
      await bounded(barrier.returned.promise)
      await nextTurn()
      expect(provider.pid).toBeUndefined()
      expect(provider.lifecyclePhases().some(p => p.name === 'spawned')).toBe(false)
    } finally {
      barrier.release.resolve()
      await provider.dispose()
    }
  })

  test('positive control: the same fake worker opens and disposal waits for its exit', async () => {
    const { workerPath } = await fixture()
    const provider = new ProcessSimProvider({ pythonPath: PYTHON, workerPath, engineName: 'fake' })
    try {
      expect((await bounded(provider.open(scene(), { worldId: 'control' }))).worldId).toBe('control')
      const pid = provider.pid!
      expect(alive(pid)).toBe(true)
      await bounded(provider.dispose())
      expect(alive(pid)).toBe(false)
    } finally { await provider.dispose() }
  })
})

describe('IsaacProvider lifecycle reservations', () => {
  test('缺少解释器给出准备入口，保留错误码且不启动 worker 或改变引擎', async () => {
    const { root, workerPath } = await fixture()
    const pythonPath = join(root, 'not-installed/bin/python')
    let launches = 0
    const provider = new IsaacProvider({pythonPath, workerPath, cacheRoot: root, launch: async () => { launches++; throw new Error('缺少 SDK 不得启动 worker') }})
    try {
      const first = await rejection(provider.open(scene(), {worldId: 'missing-sdk'}))
      // Isaac 专属：不是通用的 PROVIDER_UNAVAILABLE（那会被 UNAVAILABLE 段泛化成 P422）。
      expect(first.code).toBe('ISAAC_SDK_UNAVAILABLE')
      expect(first.message).toContain('设置 → 物理引擎')
      expect(first.details).toMatchObject({engineId: 'isaac', stage: 'python-path', availability: 'missing', pythonPath, physicalExecution: false})
      // 真实的命令边界（robot-tools 把 `code: message` 交给 commandRouteResponse）：
      // 这个码必须落 P500 的固定说明——安装或检查并登记已有兼容 SDK、保存后重启；
      // 不落 P422「请调整请求内容」，也不把原始解释器路径投影给用户。
      const projected = commandRouteResponse('sim_open', {kind: 'error', text: `${first.code}: ${first.message}`}, 'formal')
      expect(projected.kind).toBe('error')
      expect(projected.text.startsWith('P500:')).toBe(true)
      expect(projected.text).not.toContain('P422')
      expect(projected.text).toContain('安装 Isaac')
      expect(projected.text).not.toContain('请求内容')
      expect(projected.text).not.toContain(pythonPath)
      expect(projected.ui).toBeNull()
      expect(launches).toBe(0)
      expect(provider.lifecyclePhases()).toEqual([])
      expect(provider.config.pythonPath).toBe(pythonPath)
      expect((await rejection(provider.open(scene(), {worldId: 'missing-sdk'}))).code).toBe('ISAAC_SDK_UNAVAILABLE')
      expect(provider.orphanedWorkers()).toEqual([])
    } finally { await provider.dispose() }
  })

  test('duplicate world IDs are reserved before cache resolution; dispose does not wait for the hook', async () => {
    const { root, workerPath } = await fixture()
    const cache = deferred<string>()
    let cacheCalls = 0
    const provider = new IsaacProvider({ pythonPath: PYTHON, workerPath, cacheRootFor: () => { cacheCalls++; return cache.promise } })
    const first = rejection(provider.open(scene(), { worldId: 'same-world' }))
    try {
      expect(cacheCalls).toBe(1)
      expect((await rejection(provider.open(scene(), { worldId: 'same-world' }))).code).toBe('WORLD_EXISTS')
      expect(cacheCalls).toBe(1)
      const disposing = provider.dispose()
      expect(provider.dispose()).toBe(disposing)
      await bounded(disposing) // Cache is still unresolved here.
      expect((await bounded(first)).code).toBe('PROVIDER_CLOSED')
      cache.resolve(root)
      await nextTurn()
      expect(provider.lifecyclePhases()).toEqual([])
      expect((await rejection(provider.open(scene(), { worldId: 'after-dispose' }))).code).toBe('PROVIDER_CLOSED')
    } finally { cache.resolve(root); await provider.dispose() }
  })

  test('caller cancellation releases the reservation even if cache resolution never settles', async () => {
    const cache = deferred<string>()
    const controller = new AbortController()
    let cacheCalls = 0
    const provider = new IsaacProvider({ cacheRootFor: () => { cacheCalls++; return cache.promise } })
    const first = rejection(provider.open(scene(), { worldId: 'retry' }, controller.signal))
    try {
      controller.abort()
      expect((await bounded(first)).code).toBe('PROVIDER_START_CANCELLED')
      const retry = rejection(provider.open(scene(), { worldId: 'retry' }))
      expect(cacheCalls).toBe(2)
      await bounded(provider.dispose())
      expect((await bounded(retry)).code).toBe('PROVIDER_CLOSED')
      // A late rejecting cache hook is observed too, without an unhandled rejection.
      cache.reject(new Error('late cache failure'))
      await nextTurn()
    } finally { cache.resolve(tmpdir()); await provider.dispose() }
  })

  test('cancellation fired synchronously inside cacheRootFor is not lost', async () => {
    const controller = new AbortController()
    const cache = deferred<string>()
    const provider = new IsaacProvider({ cacheRootFor: () => { controller.abort(); return cache.promise } })
    const opening = rejection(provider.open(scene(), { worldId: 'sync-abort' }, controller.signal))
    try {
      expect((await bounded(opening)).code).toBe('PROVIDER_START_CANCELLED')
    } finally { cache.resolve(tmpdir()); await provider.dispose() }
  })

  test.skipIf(!existsSync(PYTHON))('cancelling one reservation leaves a delivered sibling usable', async () => {
    const { root, workerPath } = await fixture()
    const cache = deferred<string>()
    const caller = new AbortController()
    const deliveredCaller = new AbortController()
    let calls = 0
    const provider = new IsaacProvider({
      pythonPath: PYTHON, workerPath,
      cacheRootFor: () => ++calls === 1 ? cache.promise : Promise.resolve(root),
    })
    const cancelled = rejection(provider.open(scene(), { worldId: 'cancelled' }, caller.signal))
    try {
      const delivered = await bounded(provider.open(scene(), { worldId: 'delivered' }, deliveredCaller.signal))
      expect(delivered.worldId).toBe('delivered')
      caller.abort()
      expect((await bounded(cancelled)).code).toBe('PROVIDER_START_CANCELLED')
      deliveredCaller.abort() // The caller no longer owns cancellation once the handle is delivered.
      expect((await bounded(provider.listWorlds())).map(world => world.worldId)).toEqual(['delivered'])
      await bounded(provider.dispose())
    } finally { cache.resolve(root); await provider.dispose() }
  })

  test.skipIf(!existsSync(PYTHON))('dispose cancels a child already pending in its launch hook', async () => {
    const { root, workerPath } = await fixture()
    const barrier = launchBarrier()
    const provider = new IsaacProvider({ pythonPath: PYTHON, workerPath, cacheRoot: root, launch: barrier.launch })
    const opening = rejection(provider.open(scene(), { worldId: 'pending-child' }))
    try {
      const signal = await bounded(barrier.entered.promise)
      await bounded(provider.dispose())
      expect((await bounded(opening)).code).toBe('PROVIDER_CLOSED')
      expect(signal?.aborted).toBe(true)
      barrier.release.resolve()
      await bounded(barrier.returned.promise)
      await nextTurn()
      expect(provider.lifecyclePhases().some(p => p.name === 'spawned')).toBe(false)
    } finally { barrier.release.resolve(); await provider.dispose() }
  })
})
