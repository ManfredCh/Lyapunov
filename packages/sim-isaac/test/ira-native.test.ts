import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { SceneOperations } from '../../scene-kit/src/operations.ts'
import { spawnCrowd, configureCrowd, startCrowd, stopCrowd } from '../../human-crowd/src/operations.ts'
import { IsaacProvider } from '../src/provider.ts'
import type { Frame } from '../../lyapunov-contracts/src/types.ts'

const root = resolve(import.meta.dirname, '../../..')
const python = process.env.LYAPUNOV_ISAAC_PYTHON
const enabled = [python, process.env.LYAPUNOV_USD_PYTHON, process.env.LYAPUNOV_ISAAC_IRA_MOTION_LIBRARY,
  process.env.LYAPUNOV_ISAAC_IRA_CHARACTER].every(path => path && existsSync(path))

test('原生 Isaac world 中的 IRA 区域停留、暂停、单人停止及 Scene 重开', { skip: !enabled, timeout: 540_000 }, async () => {
  const out = await mkdtemp(join(tmpdir(), 'ira-native-'))
  const provider = new IsaacProvider({ pythonPath: python, workerPath: join(root, 'packages/sim-isaac/python/worker.py'),
    cacheRoot: process.env.LYAPUNOV_S5_IRA_TEST_CACHE ?? join(out, 'isaac-cache'),
    physicsDevice: 'cpu', rendering: 'none', startupBudgetMs: 180_000 })
  const receipt: Record<string, unknown> = {}
  async function waitFor(predicate: (frame: Frame) => boolean) {
    const until = Date.now() + 30_000
    do {
      const frame = await provider.observe('ira')
      receipt.last = frame
      if (predicate(frame)) return frame
      await sleep(40)
    } while (Date.now() < until)
    throw Error('未观测到预期 IRA 帧，见 last 回执')
  }

  try {
    const ops = new SceneOperations(join(out, 'catalog'))
    await ops.create({ sceneId: 'ira' })
    const floor = join(out, 'floor.usda')
    await writeFile(floor, `#usda 1.0
(
    defaultPrim = "Floor"
    upAxis = "Z"
    metersPerUnit = 1
    kilogramsPerUnit = 1
)
def Xform "Floor" {
    def Mesh "Surface" (prepend apiSchemas = ["PhysicsCollisionAPI"]) {
        point3f[] points = [(-6,-6,0), (6,-6,0), (6,6,0), (-6,6,0)]
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0,1,2,3]
        uniform token subdivisionScheme = "none"
    }
}
`)
    await ops.import({ sceneId: 'ira', path: floor, entityId: 'floor', physicalize: false })
    const spawned = await spawnCrowd(ops, { sceneId: 'ira', expectedRevision: (await ops.scene.snapshot('ira')).revision,
      count: 2, seed: 7, collision: 'coarse', region: { min: [-2, -1, 0], max: [-2, 1, 0] } })
    const [a, b] = spawned.entityIds
    assert.ok(a && b)
    let scene = spawned.snapshot
    for (const [id, y] of [[a, -1], [b, 1]] as const) {
      const actor = scene.entities.find(row => row.entityId === id)!
      scene = await ops.scene.commit({ sceneId: 'ira', expectedRevision: scene.revision,
        patch: [{ op: 'update', entityId: id, changes: { transform: { ...actor.transform, position: [-2, y, 0] } } }] })
      scene = (await configureCrowd(ops, { sceneId: 'ira', expectedRevision: scene.revision, entityIds: [id],
        route: { pointsM: [[3, y, 0], [-3, y, 0]], speedMps: 1.2, behavior: 'walk', loop: true },
        ira: { seed: 7, region: { min: [0, y - .4, -.1], max: [1, y + .4, .1] }, dwellS: .5 } })).snapshot
    }
    const savePath = join(out, 'scene.json')
    await ops.save('ira', savePath)
    const reopenedOps = new SceneOperations(join(out, 'reopened'))
    const reopened = await reopenedOps.open(savePath, { sceneId: 'ira-copy' })
    assert.deepEqual(reopened.entities.map(e => e.components.human?.ira), scene.entities.map(e => e.components.human?.ira))

    const world = await provider.open(reopened, { worldId: 'ira', clock: 'manual', timestepS: 1 / 30,
      realtimeFactor: 1.5, ground: false, startPaused: true })
    const scope = { sceneId: reopened.sceneId, worldId: 'ira', expectedGeneration: world.worldGeneration }
    const person = (frame: Frame, id: string) => frame.entities.find(row => row.entityId === id)!
    const initial = await provider.observe('ira')
    assert.equal(person(initial, a).humanPose?.motion?.ira?.enabled, false)
    const running = startCrowd(reopenedOps, provider, { ...scope, entityIds: [a, b], durationS: 15 })
    void running.catch(() => undefined)
    await sleep(120)
    assert.equal((await provider.observe('ira')).stepIndex, initial.stepIndex)
    await provider.setPaused('ira', false, world.worldGeneration)
    const dwell = await waitFor(frame => {
      const ira = person(frame, a).humanPose?.motion?.ira
      return ira?.task === 'Idle' && ira.eventCount > 0
    })
    await waitFor(frame => person(frame, a).transform.position[0] > 1.1)
    const stopped = await stopCrowd(reopenedOps, provider, { ...scope, entityIds: [a] })
    assert.deepEqual(stopped.affectedEntityIds, [a])
    const before = await provider.observe('ira')
    const after = await waitFor(frame => frame.stepIndex >= before.stepIndex + 30 &&
      Math.abs(person(frame, b).transform.position[0] - person(before, b).transform.position[0]) > .15)
    assert.deepEqual(person(after, a).transform.position, person(before, a).transform.position)
    await provider.setPaused('ira', true, world.worldGeneration)
    const final = await provider.observe('ira')
    const [handle] = await provider.listWorlds()
    const clock = handle!.capabilities?.ira as { timelineTicks: number; physicsSteps: number }
    assert.equal(clock.timelineTicks, final.stepIndex)
    assert.equal(clock.physicsSteps, final.stepIndex)
    await stopCrowd(reopenedOps, provider, { ...scope, entityIds: [b] })
    await running
    receipt.status = 'PASSED'
    Object.assign(receipt, { dwellStep: dwell.stepIndex, clock, stopped: stopped.affectedEntityIds,
      positionBeforeStop: person(before, a).transform.position, positionAfterStop: person(after, a).transform.position })
  } finally {
    try { await provider.dispose() } finally {
      const keep = process.env.LYAPUNOV_S5_RECEIPT_DIR
      if (keep) {
        await mkdir(keep, { recursive: true })
        await writeFile(join(keep, 'ira-native-result.json'), JSON.stringify(receipt, null, 2))
      }
      await rm(out, { recursive: true, force: true })
    }
  }
})
