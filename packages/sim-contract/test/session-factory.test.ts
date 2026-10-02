/**
 * P0 会话隔离（sim 侧）的**最短反例**：世界服务按会话取用。
 *
 * 修前 `ctx.sim` 是 Host 级单例：任何会话都读写同一张 world 表，A 会话关掉一个世界会把
 * B 会话正在跑的世界一起关掉、A 的 `listWorlds` 也看得见 B 的世界。这条缺陷的根因不在
 * 某个字段没带会话，而在**没有归属维度**——所以这里不测"前缀拼得对不对"，而是直接钉两件事：
 *   1. `SessionSimFactory`：一个会话一个 Provider 实例，缺会话明确失败，release 只动一个会话；
 *   2. `simWorldsFor(ctx, owner)`：会话身份只来自原生 agent（缺席即失败），没有全局回退。
 *
 * 世界服务本身是**最薄的假实现**（只有 open/listWorlds/dispose 的现场记录），
 * 不是第二个仿真引擎、也不证明物理行为：真 MuJoCo 双世界由 135 的真实双窗口复现与验收覆盖。
 */
import { describe, expect, test } from 'bun:test'
import type { SceneSnapshot, WorldHandle } from '../../lyapunov-contracts/src/types.ts'
import { SessionSimFactory } from '../src/session-provider.ts'
import { simWorldsFor, type SimWorlds, type WorldOptions } from '../src/index.ts'

/** 该会话自己的世界表与释放现场（一个实例一份，测试用来核对"释放的是谁"）。 */
interface FakeWorldService { worlds: string[]; disposed: boolean }
/** 受控释放：`hang` 让 dispose 悬着不返回，`fail` 让它明确失败；两者都记录被调了几次。 */
const releasingWorlds = (options: { hang?: boolean; fail?: Error } = {}) => {
  const state = { disposeCalls: 0, release: undefined as (() => void) | undefined }
  const service = {
    open: async () => fakeHandle(fakeScene('world-release'), 'world-release'),
    listWorlds: async () => [],
    dispose: () => {
      state.disposeCalls += 1
      if (options.hang) return new Promise<void>(resolve => { state.release = resolve })
      return options.fail === undefined ? Promise.resolve() : Promise.reject(options.fail)
    },
  } as unknown as SimWorlds
  return { state, service }
}
/** 最薄的假世界服务：调用面与真 Provider 一致（worldId 走 `options.worldId`，缺省退回快照的 sceneId），
 *  只记录收到过哪些 worldId、是否被释放；它不模拟物理，只用来钉"实例归谁"。 */
const fakeScene = (sceneId: string): SceneSnapshot => ({ sceneId, revision: 0, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' }, entities: [] })
const fakeHandle = (snapshot: SceneSnapshot, worldId: string): WorldHandle => ({ worldId, sceneId: snapshot.sceneId, engineId: 'fake-engine', engineVersion: 'test', worldGeneration: 1, appliedSceneRevision: snapshot.revision, status: 'ready' })
const fakeWorlds = () => {
  const state: FakeWorldService = { worlds: [], disposed: false }
  const service = {
    open: async (snapshot: SceneSnapshot, options: WorldOptions = {}) => { const worldId = options.worldId ?? snapshot.sceneId; state.worlds.push(worldId); return fakeHandle(snapshot, worldId) },
    listWorlds: async () => state.worlds.map(worldId => fakeHandle(fakeScene(worldId), worldId)),
    dispose: async () => { state.disposed = true },
  } as unknown as SimWorlds
  return { state, service }
}
/** 按真实调用面显式建一个世界（worldId 经 options 给出）。 */
const openWorld = (worlds: SimWorlds, worldId: string) => worlds.open(fakeScene(worldId), { worldId })
const worldIds = async (worlds: SimWorlds) => (await worlds.listWorlds()).map(handle => handle.worldId)

/** 原生 agent 的最小形状：会话身份就在 `agent.session.header.id` 上（与 requireSessionId 同一事实）。 */
const agentOf = (sessionId: string) => ({ id: sessionId, session: { header: { id: sessionId } } })

describe('SessionSimFactory：一个会话一套世界服务', () => {
  test('同名 worldId 在两个会话里各自成立，实例不串用', async () => {
    const created = new Map<string, ReturnType<typeof fakeWorlds>>()
    const factory = new SessionSimFactory({ create: key => { const built = fakeWorlds(); created.set(key, built); return built.service } })
    await openWorld(factory.forSession('s1'), 'world-main')
    await openWorld(factory.forSession('s2'), 'world-main')
    expect(created.size).toBe(2)
    expect(created.get('s1')!.state.worlds).toEqual(['world-main'])
    expect(created.get('s2')!.state.worlds).toEqual(['world-main'])
    expect(factory.forSession('s1')).toBe(created.get('s1')!.service)
    expect(await worldIds(factory.forSession('s1'))).toEqual(['world-main'])
  })

  test('缺会话键明确失败，不落到任何共享实例', () => {
    const factory = new SessionSimFactory({ create: () => fakeWorlds().service })
    for (const key of ['', '   ']) expect(() => factory.forSession(key)).toThrow(/SESSION_SCOPE_UNAVAILABLE/)
    expect(factory.sessions()).toEqual([])
  })

  test('has() 只报事实、不隐式创建；sessions() 是已有实例的会话键', () => {
    const factory = new SessionSimFactory({ create: () => fakeWorlds().service })
    expect(factory.has('s1')).toBe(false)
    expect(factory.sessions()).toEqual([])
    factory.forSession('s1')
    expect(factory.has('s1')).toBe(true)
    expect(factory.has('s2')).toBe(false)
    expect(factory.sessions()).toEqual(['s1'])
  })

  test('release 只释放一个会话：另一个会话的世界与实例一步不动', async () => {
    const created = new Map<string, ReturnType<typeof fakeWorlds>>()
    const released: string[] = []
    const factory = new SessionSimFactory({ create: key => { const built = fakeWorlds(); created.set(key, built); return built.service }, onRelease: key => { released.push(key) } })
    const own = factory.forSession('s1'), other = factory.forSession('s2')
    await openWorld(own, 'world-a'); await openWorld(other, 'world-b')
    await factory.release('s1')
    expect(created.get('s1')!.state.disposed).toBe(true)
    expect(created.get('s2')!.state.disposed).toBe(false)
    expect(released).toEqual(['s1'])
    expect(factory.sessions()).toEqual(['s2'])
    expect(factory.forSession('s2')).toBe(other)
    expect(await worldIds(factory.forSession('s2'))).toEqual(['world-b'])
    // 再次 release 同一个会话是空操作，不重复释放别人的实例。
    await factory.release('s1')
    expect(created.get('s2')!.state.disposed).toBe(false)
  })

  test('dispose() 是 Host 级释放：全部会话实例被释放', async () => {
    const created: Array<ReturnType<typeof fakeWorlds>> = []
    const factory = new SessionSimFactory({ create: () => { const built = fakeWorlds(); created.push(built); return built.service } })
    factory.forSession('s1'); factory.forSession('s2')
    await factory.dispose()
    expect(created.map(item => item.state.disposed)).toEqual([true, true])
    expect(factory.sessions()).toEqual([])
  })

  test('Host dispose 从调用开始就封住新会话，完成后旧键和新键也不得重建', async () => {
    const built = releasingWorlds({ hang: true })
    const created: string[] = []
    const factory = new SessionSimFactory({ create: key => { created.push(key); return built.service } })
    factory.forSession('s1')
    const disposing = factory.dispose()
    try {
      expect(built.state.disposeCalls).toBe(1)
      expect(() => factory.forSession('s2')).toThrow(/SIM_FACTORY_DISPOSED/)
      expect(() => factory.forSession('s1')).toThrow(/SESSION_RELEASING/)
      expect(created).toEqual(['s1'])
      expect(factory.sessions()).toEqual([])
    } finally {
      built.state.release!()
      await disposing
    }
    expect(() => factory.forSession('s1')).toThrow(/SIM_FACTORY_DISPOSED/)
    expect(() => factory.forSession('s2')).toThrow(/SIM_FACTORY_DISPOSED/)
    expect(created).toEqual(['s1'])
    expect(factory.sessions()).toEqual([])
  })

  test('空工厂 dispose 也立即封住新会话，重复 dispose 不重新开放', async () => {
    let createCalls = 0
    const factory = new SessionSimFactory({ create: () => { createCalls += 1; return fakeWorlds().service } })
    const disposing = factory.dispose()
    expect(() => factory.forSession('s1')).toThrow(/SIM_FACTORY_DISPOSED/)
    await disposing
    await factory.dispose()
    expect(() => factory.forSession('s1')).toThrow(/SIM_FACTORY_DISPOSED/)
    expect(createCalls).toBe(0)
    expect(factory.sessions()).toEqual([])
  })

  test('并发及重复 dispose 幂等：等待已在途的 release，每个实例与回调只释放一次', async () => {
    const slow = releasingWorlds({ hang: true }), healthy = releasingWorlds()
    const released: string[] = []
    const factory = new SessionSimFactory({
      create: key => key === 's1' ? slow.service : healthy.service,
      onRelease: key => { released.push(key) },
    })
    factory.forSession('s1'); factory.forSession('s2')
    const releasing = factory.release('s1')
    let completed = 0
    const first = factory.dispose().then(() => { completed += 1 })
    const second = factory.dispose().then(() => { completed += 1 })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(completed).toBe(0)
      expect(slow.state.disposeCalls).toBe(1)
      expect(healthy.state.disposeCalls).toBe(1)
    } finally {
      slow.state.release!()
      await Promise.all([releasing, first, second])
    }
    await factory.dispose()
    expect(completed).toBe(2)
    expect(slow.state.disposeCalls).toBe(1)
    expect(healthy.state.disposeCalls).toBe(1)
    expect(released.sort()).toEqual(['s1', 's2'])
    expect(factory.sessions()).toEqual([])
  })

  test('释放中不得重建同一个会话：dispose 还没返回时取服务明确失败，收干净后才允许重建', async () => {
    const built = releasingWorlds({ hang: true })
    const factory = new SessionSimFactory({ create: () => built.service })
    expect(factory.forSession('s1')).toBe(built.service)
    const releasing = factory.release('s1')
    // 旧 worker 的 dispose 还悬着：这时同一个会话键**不能**再建第二个实例（否则同会话两个进程并存）。
    expect(built.state.disposeCalls).toBe(1)
    expect(() => factory.forSession('s1')).toThrow(/SESSION_RELEASING/)
    expect(factory.has('s1')).toBe(false)
    built.state.release!()
    await releasing
    // 收干净之后这个会话键回到可用状态（agent 被 resume 时还能起新的实例）。
    expect(factory.forSession('s1')).toBe(built.service)
  })

  test('释放失败不冒充成功：release 抛出真实错误，会话键保留到收干净为止', async () => {
    const failure = new Error('MUJOCO_WORKER_DISPOSE_FAILED: worker 未退出')
    const built = releasingWorlds({ fail: failure })
    const factory = new SessionSimFactory({ create: () => built.service })
    factory.forSession('s1')
    await expect(factory.release('s1')).rejects.toThrow(/MUJOCO_WORKER_DISPOSE_FAILED/)
    // 没收干净就不能重建：再取同一个会话是明确失败，而不是悄悄起第二个 worker。
    expect(() => factory.forSession('s1')).toThrow(/SESSION_RELEASE_FAILED/)
    expect(built.state.disposeCalls).toBe(1)
    // 再 release 一次是**重试同一个实例的收尾**（同一个 worker 只被释放一次，不新建实例）。
    await expect(factory.release('s1')).rejects.toThrow(/MUJOCO_WORKER_DISPOSE_FAILED/)
    expect(built.state.disposeCalls).toBe(2)
  })

  test('Host dispose 不把释放失败当成功：如实报错，且其它会话的实例照常释放', async () => {
    const failing = releasingWorlds({ fail: new Error('ISAAC_KIT_DISPOSE_FAILED: Kit 未退出') })
    const healthy = fakeWorlds()
    const factory = new SessionSimFactory({ create: key => key === 's1' ? failing.service : healthy.service })
    factory.forSession('s1'); factory.forSession('s2')
    await expect(factory.dispose()).rejects.toThrow(/SIM_SESSION_RELEASE_FAILED.*s1.*ISAAC_KIT_DISPOSE_FAILED/)
    // 一个会话收不干净不影响别的会话真的被释放，也不虚报"全部释放完成"。
    expect(healthy.state.disposed).toBe(true)
    expect(factory.sessions()).toEqual([])
    // 收尾归属仍在本工厂：同会话键不许重建，避免"Host 已卸载"与"又起了一个 worker"同时成立。
    expect(() => factory.forSession('s1')).toThrow(/SESSION_RELEASE_FAILED/)
    expect(() => factory.forSession('s3')).toThrow(/SIM_FACTORY_DISPOSED/)
  })

  test('Host dispose 失败仍保留收尾归属：release 和 dispose 可重试，但成功后也不重新开放', async () => {
    const failure = new Error('MUJOCO_WORKER_DISPOSE_FAILED: worker 未退出')
    const options: { fail?: Error } = { fail: failure }
    const failing = releasingWorlds(options), healthy = releasingWorlds()
    const created: string[] = [], released: string[] = []
    const factory = new SessionSimFactory({
      create: key => { created.push(key); return key === 's1' ? failing.service : healthy.service },
      onRelease: key => { released.push(key) },
    })
    factory.forSession('s1'); factory.forSession('s2')
    await expect(factory.dispose()).rejects.toThrow(/SIM_SESSION_RELEASE_FAILED.*s1.*MUJOCO_WORKER_DISPOSE_FAILED/)
    await expect(factory.release('s1')).rejects.toBe(failure)
    expect(failing.state.disposeCalls).toBe(2)
    expect(released).toEqual(['s2'])
    expect(() => factory.forSession('s1')).toThrow(/SESSION_RELEASE_FAILED/)
    expect(() => factory.forSession('s3')).toThrow(/SIM_FACTORY_DISPOSED/)
    options.fail = undefined
    await factory.dispose()
    await factory.dispose()
    expect(failing.state.disposeCalls).toBe(3)
    expect(healthy.state.disposeCalls).toBe(1)
    expect(released).toEqual(['s2', 's1'])
    expect(created).toEqual(['s1', 's2'])
    expect(() => factory.forSession('s1')).toThrow(/SIM_FACTORY_DISPOSED/)
    expect(() => factory.forSession('s3')).toThrow(/SIM_FACTORY_DISPOSED/)
    expect(factory.sessions()).toEqual([])
  })
})

describe('simWorldsFor：会话身份只来自原生 agent', () => {
  test('按 agent 的会话取服务；没有 agent / 没有 Provider 都明确失败', () => {
    const created = new Map<string, ReturnType<typeof fakeWorlds>>()
    const factory = new SessionSimFactory({ create: key => { const built = fakeWorlds(); created.set(key, built); return built.service } })
    const ctx = { get: (name: string) => name === 'sim' ? factory : undefined }
    simWorldsFor(ctx, agentOf('s1'))
    simWorldsFor(ctx, agentOf('s1'))
    simWorldsFor(ctx, agentOf('s2'))
    expect(created.size).toBe(2)
    expect(() => simWorldsFor(ctx, undefined)).toThrow(/SESSION_SCOPE_UNAVAILABLE/)
    expect(() => simWorldsFor(ctx, { id: 'agent-without-session' })).toThrow(/SESSION_SCOPE_UNAVAILABLE/)
    // 会话取不到时**不能**落回某个已存在的实例：失败之后实例数一个都没变。
    expect(created.size).toBe(2)
    expect(() => simWorldsFor({ get: () => undefined }, agentOf('s1'))).toThrow(/PROVIDER_UNAVAILABLE/)
  })
})
