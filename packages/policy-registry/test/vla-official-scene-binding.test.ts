/**
 * DEV-028 条件①（M2 · 官方套件 scene 口径）判据测试：**官方 bench world 的场景权威是 world 句柄，不是会话投影文档**。
 *
 * 运行中产物的真读数（L419，真实 dev 宿主端口 4265；见 `.runtime/lane-vla-integ/evidence/before-m2-*.json`）：
 *   `bench_load` ⇒ `sceneId="libero_goal/turn_on_the_stove"`、`appliedSceneRevision=1`、
 *   `sceneBridge.sceneId="libero_goal-turn_on_the_stove"`（落盘文档 revision=1）；
 *   `scene.inspect("libero_goal/turn_on_the_stove")` ⇒ `Error: INVALID_ID`（scene-kit safeId 不接受 `/`）
 *   ⇒ 改前 `policy_match` 恒生三条假差异：`SCENE_UNREADABLE` / `ENTITY_NOT_FOUND` / `SCENE_REVISION_MISMATCH`。
 *
 * 锁四件事：
 *  1. 官方 world ＋ 会话文档不可读（与真机同形）⇒ **MATCHED**，且 `sceneRevision` 来自 `world.appliedSceneRevision`；
 *  2. **判据没被一起放宽**：官方 world 但传入的 sceneId 不是该 world 的 id ⇒ 仍 `WORLD_SCENE_MISMATCH`；
 *  3. 执行分支在同一权威下能跑通（会话文档读不到不再让整条路由 FAILED），且**守卫仍在**：
 *     `appliedSceneRevision` 与 `match.sceneRevision` 对不上 ⇒ `POLICY_SCENE_REVISION_CHANGED`；
 *  4. 非官方 world 的场景文档不可读 ⇒ **仍** `SCENE_UNREADABLE`（Go1/WTW 与 generic 分支逐字不变）。
 */
import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateLiberoVlaAdapter } from '../src/adapter.ts'
import { executeLiberoVlaPolicy } from '../src/execution.ts'
import { matchPolicy } from '../src/match.ts'
import { runtimeProbeStub, VLA_IDENTITY, officialFrame, officialWorld, sceneHandle, simStub, writeVlaSnapshot } from './vlaRouteFixture.ts'

const scratch = mkdtempSync(join(tmpdir(), 'policy-vla-scene-'))
const identity = {
  provider: VLA_IDENTITY.provider, modelId: VLA_IDENTITY.modelId, revision: VLA_IDENTITY.revision,
  sceneId: VLA_IDENTITY.sceneId, entityId: VLA_IDENTITY.entityId, worldId: VLA_IDENTITY.worldId, expectedGeneration: 1,
}
let cached: { dataDirectory: string; root: string } | undefined
async function snapshot() {
  if (!cached) {
    const dataDirectory = mkdtempSync(join(scratch, 'root-'))
    cached = { dataDirectory, root: (await writeVlaSnapshot(dataDirectory)).root }
  }
  return cached
}
/** 真机同形的场景句柄：官方 id 含 `/` ⇒ scene-kit safeId 拒绝，`inspect` 抛 `INVALID_ID`。 */
const unreadableScene = { inspect: async (sceneId: string): Promise<any> => { throw new Error(`INVALID_ID: ${sceneId}`) } }
const reasons = (result: any) => result.differences.map((row: any) => row.reason)

describe('M2 · 官方套件 world 的场景权威＝world 句柄', () => {
  test('官方 world ＋ 会话文档不可读（真机同形）⇒ MATCHED，sceneRevision 取 world.appliedSceneRevision', async () => {
    const result = await matchPolicy({ dataDirectory: (await snapshot()).dataDirectory }, identity, unreadableScene as any, simStub() as any)
    expect({ status: result.status, differences: result.differences, sceneRevision: result.sceneRevision })
      .toEqual({ status: 'MATCHED', differences: [], sceneRevision: 1 })
  })

  test('判据未放宽：官方 world 却传 namespaced/别的 sceneId ⇒ WORLD_SCENE_MISMATCH', async () => {
    const namespaced = await matchPolicy({ dataDirectory: (await snapshot()).dataDirectory },
      { ...identity, sceneId: 'libero_goal-turn_on_the_stove' }, unreadableScene as any, simStub() as any)
    expect({ status: namespaced.status, reasons: reasons(namespaced) }).toEqual({ status: 'BLOCKED', reasons: ['WORLD_SCENE_MISMATCH'] })
  })

  test('非官方 world ＋ 会话文档不可读 ⇒ 仍 SCENE_UNREADABLE + ENTITY_NOT_FOUND + SCENE_REVISION_MISMATCH（generic/Go1 分支逐字不变）', async () => {
    const nonOfficial = await matchPolicy({ dataDirectory: (await snapshot()).dataDirectory }, identity, unreadableScene as any, simStub({ world: officialWorld({ engineId: 'mujoco' }) }) as any)
    expect(nonOfficial.status).toBe('BLOCKED')
    // 第三条正是改前所有 world 都会拿到的"snapshot 读不到 ⇒ expected undefined ⇒ 恒 mismatch"；官方 world 才豁免。
    expect(reasons(nonOfficial)).toEqual(['SCENE_UNREADABLE', 'ENTITY_NOT_FOUND', 'SCENE_REVISION_MISMATCH', 'ADAPTER_KIND_NOT_EXECUTABLE'])
  })
})

describe('M2 · VLA 执行分支的场景复核（权威＝world，守卫保留）', () => {
  test('官方路由：会话文档读不到 ⇒ 按 world.appliedSceneRevision 复核，跑到官方终态', async () => {
    const { root } = await snapshot()
    const engine = writeStubEngine()
    const actions: any[] = []
    const frames = steppedFrames(3)
    const sim = {
      listWorlds: async () => [officialWorld()],
      observe: async () => frames[0],
      execute: async (_worldId: string, action: any) => { actions.push(action); return receiptFor(frames[actions.length]) },
      stop: async () => ({ stopped: true, stepIndex: 0, receipts: [] }),
    }
    const result = await executeLiberoVlaPolicy(
      { dataDirectory: mkdtempSync(join(scratch, 'run-')), pythonPath: engine.path },
      { ...identity, durationS: 5, runId: 'vla-scene-ok' } as any,
      unreadableScene as any, sim as any, new AbortController().signal,
      { vlaAdapter: validateLiberoVlaAdapter(JSON.parse(readFileSync(join(root, 'derived', 'adapter.json'), 'utf8'))), manifestPath: join(root, 'manifest.json'), sceneRevision: 1, resolvedRevision: VLA_IDENTITY.revision },
    )
    expect({ status: result.status, termination: result.termination, controls: result.controls }).toEqual({ status: 'COMPLETED', termination: 'check_success', controls: 2 })
    expect(result.error).toBeUndefined()
  }, 30_000)

  test('守卫仍在：world.appliedSceneRevision 对不上 match.sceneRevision ⇒ POLICY_SCENE_REVISION_CHANGED', async () => {
    const { root } = await snapshot()
    const engine = writeStubEngine()
    const frames = steppedFrames(3)
    const sim = {
      listWorlds: async () => [officialWorld({ appliedSceneRevision: 2 })],
      observe: async () => frames[0],
      execute: async () => receiptFor(frames[1]),
      stop: async () => ({ stopped: true, stepIndex: 0, receipts: [] }),
    }
    const result = await executeLiberoVlaPolicy(
      { dataDirectory: mkdtempSync(join(scratch, 'run-stale-')), pythonPath: engine.path },
      { ...identity, durationS: 5, runId: 'vla-scene-stale' } as any,
      unreadableScene as any, sim as any, new AbortController().signal,
      { vlaAdapter: validateLiberoVlaAdapter(JSON.parse(readFileSync(join(root, 'derived', 'adapter.json'), 'utf8'))), manifestPath: join(root, 'manifest.json'), sceneRevision: 1 },
    )
    expect({ status: result.status, error: result.error }).toEqual({ status: 'FAILED', error: 'Error: POLICY_SCENE_REVISION_CHANGED' })
    expect(result.controls).toBe(0)
  }, 30_000)

  test('会话文档读得到 ⇒ 仍旧复核它（读得到时不以 world 覆盖）', async () => {
    const { root } = await snapshot()
    const engine = writeStubEngine()
    const frames = steppedFrames(3)
    const sim = { listWorlds: async () => [officialWorld()], observe: async () => frames[0], execute: async () => receiptFor(frames[1]), stop: async () => ({ stopped: true, stepIndex: 0, receipts: [] }) }
    const result = await executeLiberoVlaPolicy(
      { dataDirectory: mkdtempSync(join(scratch, 'run-doc-')), pythonPath: engine.path },
      { ...identity, durationS: 5, runId: 'vla-scene-doc' } as any,
      sceneHandle({ sceneId: VLA_IDENTITY.sceneId, revision: 3 }) as any, sim as any, new AbortController().signal,
      { vlaAdapter: validateLiberoVlaAdapter(JSON.parse(readFileSync(join(root, 'derived', 'adapter.json'), 'utf8'))), manifestPath: join(root, 'manifest.json'), sceneRevision: 1 },
    )
    expect({ status: result.status, error: result.error }).toEqual({ status: 'FAILED', error: 'Error: POLICY_SCENE_REVISION_CHANGED' })
  }, 30_000)
})

/** 协议同构的桩引擎（只在验证"产品 harness＋控制环"时使用；不冒充真推理）。load 回包、infer 回 2 步 7 维。 */
function writeStubEngine() {
  const directory = mkdtempSync(join(scratch, 'engine-'))
  const path = join(directory, 'stub-vla-engine.cjs')
  writeFileSync(path, `#!/usr/bin/env node
${runtimeProbeStub}const readline = require('node:readline')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  const reply = result => console.log(JSON.stringify({ id: request.id, result }))
  if (request.method === 'load') reply({ device: 'cpu', policyType: 'smolvla', chunkSize: 50, actionDim: 7 })
  else if (request.method === 'infer') reply([0,0,0,0,0,0,0.5,0,0,0,0,0,0,0.5])
  else reply({ status: 'reset-ok' })
})
`)
  chmodSync(path, 0o755)
  return { path }
}
function steppedFrames(count: number) {
  return Array.from({ length: count }, (_value, index) => officialFrame({ stepIndex: index, simTime: index / 20, frameId: 'frame-' + index, sceneRevision: 1 } as any))
}
function receiptFor(frame: any) {
  const stepIndex = frame.stepIndex
  return { actionId: 'a-' + stepIndex, worldId: VLA_IDENTITY.worldId, generation: 1, status: 'completed', startStep: stepIndex, endStep: stepIndex, finalState: frame, taskAchieved: stepIndex === 2, reason: stepIndex === 2 ? 'check_success' : undefined, effect: { benchmarkStatus: stepIndex === 2 ? 'success' : 'running', evaluator: 'official-env.check_success' } }
}
