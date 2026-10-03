import type { WorldHandle } from './types.ts'

export const SESSION_WORLD_PROJECTION_VERSION = 1 as const
export interface SessionWorldProjectionIdentity {
  sessionId: string
  formatVersion: string
  cwd: string
  isSeeded: boolean
  inheritedEventCount: number
}
export type SessionWorldProjectionFacts = Pick<WorldHandle,
  'worldId' | 'sceneId' | 'engineId' | 'engineVersion' | 'worldGeneration' | 'appliedSceneRevision'
>
export interface SessionWorldProjection {
  version: typeof SESSION_WORLD_PROJECTION_VERSION
  identity: SessionWorldProjectionIdentity
  world: SessionWorldProjectionFacts
  recordedAt: string
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const validIdentity = (identity: SessionWorldProjectionIdentity): boolean =>
  typeof identity.sessionId === 'string' && identity.sessionId.trim() !== ''
  && typeof identity.formatVersion === 'string' && identity.formatVersion.trim() !== ''
  && typeof identity.cwd === 'string' && identity.cwd.trim() !== ''
  && typeof identity.isSeeded === 'boolean'
  && Number.isSafeInteger(identity.inheritedEventCount) && identity.inheritedEventCount >= 0

export function createSessionWorldProjection(
  identity: SessionWorldProjectionIdentity,
  world: WorldHandle,
  recordedAt = new Date().toISOString(),
): SessionWorldProjection {
  if (!validIdentity(identity)) throw new Error('SESSION_WORLD_PROJECTION_IDENTITY_INVALID')
  if (!world.worldId || !world.sceneId || !world.engineId || !world.engineVersion) throw new Error('SESSION_WORLD_PROJECTION_WORLD_INVALID')
  if (!Number.isSafeInteger(world.worldGeneration) || world.worldGeneration < 0) throw new Error('SESSION_WORLD_PROJECTION_GENERATION_INVALID')
  if (!Number.isSafeInteger(world.appliedSceneRevision) || world.appliedSceneRevision < 0) throw new Error('SESSION_WORLD_PROJECTION_REVISION_INVALID')
  if (!Number.isFinite(Date.parse(recordedAt))) throw new Error('SESSION_WORLD_PROJECTION_TIME_INVALID')
  const facts: SessionWorldProjectionFacts = {
    worldId: world.worldId, sceneId: world.sceneId, engineId: world.engineId,
    engineVersion: world.engineVersion, worldGeneration: world.worldGeneration,
    appliedSceneRevision: world.appliedSceneRevision,
  }
  return copy({ version: SESSION_WORLD_PROJECTION_VERSION, identity, world: facts, recordedAt })
}

export function matchesSessionWorldProjection(
  projection: SessionWorldProjection,
  identity: SessionWorldProjectionIdentity,
): boolean {
  return projection.version === SESSION_WORLD_PROJECTION_VERSION
    && JSON.stringify(projection.identity) === JSON.stringify(identity)
    && projection.identity.sessionId === identity.sessionId
}

/**
 * Process-local metadata cache. It never stores worker handles or treats a row as
 * proof that the corresponding provider is running.
 */
export class SessionWorldProjectionCache {
  private readonly rows = new Map<string, Map<string, SessionWorldProjection>>()

  set(projection: SessionWorldProjection): void {
    const session = projection.identity.sessionId
    const worlds = this.rows.get(session) ?? new Map<string, SessionWorldProjection>()
    worlds.set(projection.world.worldId, copy(projection))
    this.rows.set(session, worlds)
  }

  get(sessionId: string, worldId: string, identity: SessionWorldProjectionIdentity): SessionWorldProjection | undefined {
    const projection = this.rows.get(sessionId)?.get(worldId)
    if (!projection || !matchesSessionWorldProjection(projection, identity)) return undefined
    return copy(projection)
  }

  delete(sessionId: string, worldId: string): void { this.rows.get(sessionId)?.delete(worldId) }
  release(sessionId: string): void { this.rows.delete(sessionId) }
  sessions(): string[] { return [...this.rows.keys()] }
}
