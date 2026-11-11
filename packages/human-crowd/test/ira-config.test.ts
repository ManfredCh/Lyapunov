import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SceneOperations } from '../../scene-kit/src/operations.ts'
import { spawnCrowd, configureCrowd, startCrowd, validateIra } from '../src/operations.ts'
import type { HumanRoute } from '../../lyapunov-contracts/src/types.ts'

const route: HumanRoute = { pointsM: [[-3, 0, 0], [3, 0, 0]], speedMps: 1.2, behavior: 'walk', loop: true }
const ira = { seed: 7, region: { min: [-1, -1, -0.1] as [number, number, number], max: [1, 1, 0.1] as [number, number, number] }, dwellS: 0.5 }

async function scene() {
  const root = await mkdtemp(join(tmpdir(), 'human-ira-config-'))
  const ops = new SceneOperations(root)
  await ops.create({ sceneId: 's' })
  const spawned = await spawnCrowd(ops, { sceneId: 's', expectedRevision: 0, count: 1, seed: 42, groupId: 'ira', region: { min: [0, 0, 0], max: [0, 0, 0] } })
  return { root, ops, spawned, entityId: spawned.entityIds[0]! }
}

test('ira 只接受显式循环walk路线并在Scene快照持久化，重开保持', async () => {
  const { root, ops, spawned, entityId } = await scene()
  try {
    const updated = await configureCrowd(ops, { sceneId: 's', expectedRevision: spawned.snapshot.revision, entityIds: [entityId], route, ira })
    const saved = updated.snapshot.entities.find(entity => entity.entityId === entityId)!.components.human!
    expect(saved.ira).toEqual(ira)
    expect(saved.route).toEqual(route)
    const reopened = await new SceneOperations(root).scene.snapshot('s')
    expect(reopened.entities.find(entity => entity.entityId === entityId)!.components.human!.ira).toEqual(ira)
    expect(updated.snapshot.revision).toBe(reopened.revision)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('ira 对未实现配置具名拒绝且不写Scene', async () => {
  const { root, ops, spawned, entityId } = await scene()
  const base = { sceneId: 's', expectedRevision: spawned.snapshot.revision, entityIds: [entityId] }
  try {
    for (const [label, badRoute, badIra, code] of [
      ['非循环', { ...route, loop: false }, ira, 'HUMAN_IRA_ROUTE_UNSUPPORTED'],
      ['run', { ...route, behavior: 'run' as const }, ira, 'HUMAN_IRA_ROUTE_UNSUPPORTED'],
      ['navigation', { ...route, navigation: { bounds: { min: [-1, -1] as [number, number], max: [1, 1] as [number, number] } } }, ira, 'HUMAN_IRA_ROUTE_UNSUPPORTED'],
      ['dwell', route, { ...ira, dwellS: 0 }, 'HUMAN_IRA_DWELL_INVALID'],
      ['seed', route, { ...ira, seed: 1.5 }, 'HUMAN_IRA_SEED_INVALID'],
      ['region', route, { ...ira, region: { min: [2, -1, 0] as [number, number, number], max: [1, 1, 0] as [number, number, number] } }, 'HUMAN_IRA_REGION_INVALID'],
    ] as const) {
      await expect(configureCrowd(ops, { ...base, route: badRoute as HumanRoute, ira: badIra as typeof ira })).rejects.toThrow(code)
      expect((await ops.scene.snapshot('s')).revision).toBe(spawned.snapshot.revision)
    }
    expect(() => validateIra(ira, undefined, 'x')).toThrow('HUMAN_IRA_ROUTE_REQUIRED')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('非Isaac对IRA声明执行常规路线被拒绝；未重开的普通Isaac world给reopen错误', async () => {
  const { root, ops, spawned, entityId } = await scene()
  try {
    const updated = await configureCrowd(ops, { sceneId: 's', expectedRevision: spawned.snapshot.revision, entityIds: [entityId], route, ira })
    let executed = 0
    const world = (engineId: string, capabilities?: Record<string, unknown>) => ({
      listWorlds: async () => [{ worldId: 'w', sceneId: 's', engineId, appliedSceneRevision: updated.snapshot.revision, worldGeneration: 1, capabilities }],
      execute: async () => { executed++; return { status: 'accepted' as const } },
    })
    await expect(startCrowd(ops, world('mujoco') as never, { sceneId: 's', entityIds: [entityId], worldId: 'w', expectedGeneration: 1, durationS: 1 })).rejects.toThrow('HUMAN_IRA_ISAAC_ONLY')
    await expect(startCrowd(ops, world('isaac') as never, { sceneId: 's', entityIds: [entityId], worldId: 'w', expectedGeneration: 1, durationS: 1 })).rejects.toThrow('HUMAN_IRA_REOPEN_REQUIRED')
    expect(executed).toBe(0)
    const receipt = await startCrowd(ops, world('isaac', { supported: { humanIra: true } }) as never, { sceneId: 's', entityIds: [entityId], worldId: 'w', expectedGeneration: 1, durationS: 1 })
    expect(receipt.status).toBe('accepted')
    expect(executed).toBe(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
