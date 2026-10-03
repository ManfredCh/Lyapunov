import { describe, expect, test } from 'bun:test'
import { ProcessSimProvider, type SimWorkerLaunchSpec } from '../src/python-transport.ts'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'

const scene: SceneSnapshot = { sceneId: 'deferred-launch', revision: 0, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' }, entities: [] }
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
// Tests exercise the real launch/ownership state machine, but intercept the final
// spawn boundary: no Python SDK or OS child is started in these cases.
function pendingLaunch() {
  const entered = deferred<AbortSignal | undefined>()
  const spec = deferred<SimWorkerLaunchSpec>()
  const provider = new ProcessSimProvider({
    pythonPath: process.execPath, workerPath: 'unused', engineName: 'stub',
    launch: async input => { entered.resolve(input.signal); return spec.promise },
  })
  let spawns = 0
  ;(provider as any).spawnWorker = async () => { spawns += 1 }
  const finish = () => spec.resolve({ argv: ['unused'], facts: undefined as never })
  return { provider, entered: entered.promise, finish, spawns: () => spawns }
}
const resultOf = (run: Promise<unknown>) => run.then(() => 'RESOLVED', error => error.code)
async function within<T>(run: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([run, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('operation remained pending')), 500) })])
  } finally { clearTimeout(timer) }
}

describe('pre-spawn ownership', () => {
  test('dispose settles opening during a stalled launch hook and late resolution cannot spawn', async () => {
    const test = pendingLaunch()
    const opening = resultOf(test.provider.open(scene))
    const signal = await test.entered
    try {
      await within(test.provider.dispose())
      expect(await within(opening)).toBe('PROVIDER_CLOSED')
      expect(signal?.aborted).toBe(true)
    } finally { test.finish() }
    await opening
    await Promise.resolve()
    expect(test.spawns()).toBe(0)
    expect(await resultOf(test.provider.open(scene))).toBe('PROVIDER_CLOSED')
  })

  test('caller cancellation during launch settles promptly and never dispatches late spawn', async () => {
    const test = pendingLaunch()
    const caller = new AbortController()
    const opening = resultOf(test.provider.open(scene, {}, caller.signal))
    const signal = await test.entered
    try {
      caller.abort()
      expect(await within(opening)).toBe('PROVIDER_START_CANCELLED')
      expect(signal?.aborted).toBe(true)
    } finally { test.finish() }
    await opening
    await Promise.resolve()
    expect(test.spawns()).toBe(0)
    await test.provider.dispose()
  })

  test('concurrent disposal callers share completion of an owned worker shutdown', async () => {
    const provider = new ProcessSimProvider({ pythonPath: process.execPath, workerPath: 'unused', engineName: 'stub' })
    const exited = deferred<void>()
    const shutdown = deferred<void>()
    let requests = 0
    const internal = provider as any
    internal.process = { exitCode: null, signalCode: null, stdin: { end() {} } }
    internal.ready = true
    internal.exited = exited.promise
    internal.request = async () => { requests += 1; await shutdown.promise }
    const first = provider.dispose()
    let secondDone = false
    const second = provider.dispose().then(() => { secondDone = true })
    try {
      await Promise.resolve()
      expect(secondDone).toBe(false)
      expect(requests).toBe(1)
    } finally { shutdown.resolve(); exited.resolve() }
    await Promise.all([first, second])
    expect(secondDone).toBe(true)
  })
})
