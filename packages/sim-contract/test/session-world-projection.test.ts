import { describe, expect, test } from 'bun:test'
import { createSessionWorldProjection, SessionWorldProjectionCache, type SessionWorldProjectionIdentity, type WorldHandle } from '../../lyapunov-contracts/src/types.ts'
import { SessionSimFactory } from '../src/session-provider.ts'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import type { SimWorlds } from '../src/index.ts'

const identity = (sessionId: string, overrides: Partial<SessionWorldProjectionIdentity> = {}): SessionWorldProjectionIdentity => ({
  sessionId, formatVersion: 'v4', cwd: '/workspace', isSeeded: false, inheritedEventCount: 0, ...overrides,
})
const world = (worldId: string, overrides: Partial<WorldHandle> = {}): WorldHandle => ({
  worldId, sceneId: 'scene-main', engineId: 'mujoco', engineVersion: '3.3.0',
  worldGeneration: 2, appliedSceneRevision: 7, status: 'running', ...overrides,
})

describe('session world projection cache', () => {
  test('same world id is cached separately for each session', () => {
    const cache = new SessionWorldProjectionCache()
    cache.set(createSessionWorldProjection(identity('session-a'), world('world-main')))
    cache.set(createSessionWorldProjection(identity('session-b'), world('world-main', { sceneId: 'scene-b', appliedSceneRevision: 3 })))
    expect(cache.sessions()).toEqual(['session-a', 'session-b'])
    expect(cache.get('session-a', 'world-main', identity('session-a'))?.world.sceneId).toBe('scene-main')
    expect(cache.get('session-b', 'world-main', identity('session-b'))?.world.sceneId).toBe('scene-b')
  })

  test('identity drift invalidates a cached projection instead of claiming readiness', () => {
    const cache = new SessionWorldProjectionCache()
    cache.set(createSessionWorldProjection(identity('session-a'), world('world-main')))
    for (const changed of [
      identity('session-b'),
      identity('session-a', { formatVersion: 'v5' }),
      identity('session-a', { cwd: '/other-workspace' }),
      identity('session-a', { isSeeded: true }),
      identity('session-a', { inheritedEventCount: 4 }),
    ]) expect(cache.get('session-a', 'world-main', changed)).toBeUndefined()
    expect(cache.get('session-a', 'world-main', identity('session-a'))?.world.worldGeneration).toBe(2)
  })

  test('releasing one session leaves other session projections intact', () => {
    const cache = new SessionWorldProjectionCache()
    cache.set(createSessionWorldProjection(identity('session-a'), world('shared-local-id')))
    cache.set(createSessionWorldProjection(identity('session-b'), world('shared-local-id', { sceneId: 'scene-b' })))
    cache.release('session-a')
    expect(cache.get('session-a', 'shared-local-id', identity('session-a'))).toBeUndefined()
    expect(cache.get('session-b', 'shared-local-id', identity('session-b'))?.world.sceneId).toBe('scene-b')
    expect(cache.sessions()).toEqual(['session-b'])
  })

  test('SessionSimFactory optionally records successful open and release lifecycle facts', async () => {
    const cache = new SessionWorldProjectionCache()
    const snapshot: SceneSnapshot = { sceneId: 'scene-main', revision: 7, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' }, entities: [] }
    const handle = world('world-main')
    const service = {
      open: async () => handle,
      sync: async () => handle,
      close: async () => undefined,
      dispose: async () => undefined,
    } as unknown as SimWorlds
    const factory = new SessionSimFactory({
      create: () => service,
      projectionCache: cache,
      projectionIdentity: sessionId => identity(sessionId),
    })
    await factory.forSession('session-a').open(snapshot, { worldId: 'world-main' })
    expect(cache.get('session-a', 'world-main', identity('session-a'))?.world.appliedSceneRevision).toBe(7)
    await factory.release('session-a')
    expect(cache.get('session-a', 'world-main', identity('session-a'))).toBeUndefined()
  })

  test('returns detached records and never stores runtime worker handles', () => {
    const cache = new SessionWorldProjectionCache()
    const source = createSessionWorldProjection(identity('session-a'), world('world-main'))
    cache.set(source)
    const returned = cache.get('session-a', 'world-main', identity('session-a'))!
    ;(returned.world as { sceneId: string }).sceneId = 'mutated'
    expect(cache.get('session-a', 'world-main', identity('session-a'))?.world.sceneId).toBe('scene-main')
    expect(Object.keys(cache.get('session-a', 'world-main', identity('session-a'))!)).toEqual(['version', 'identity', 'world', 'recordedAt'])
  })
})
