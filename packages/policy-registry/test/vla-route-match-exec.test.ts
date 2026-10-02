/**
 * DEV-028 条件③（M1＋M2）判据测试：**VLA 适配器能通过 `matchPolicy` 并进入 `execution`**。
 *
 * 锁四件事（全部走产品通路，不 mock 产品函数）：
 *  1. **M1 正例**：官方套件 world ＋ 官方 `describe().controller` ＋ 产品 `prepare_libero_vla.py` 产出的
 *     `derived/adapter.json` ⇒ `matchPolicy` 必须 `MATCHED`（`differences: []`）。修复前这里的 `adapter`
 *     差异恒为 `ADAPTER_KIND_NOT_EXECUTABLE`（`src/match.ts:92`），于是 `plugin.ts` 的 `policy_execute`
 *     与 `src/execution.ts:92` 双双不可达。
 *  2. **M1 判据化（缺口存在时必然失败）**：官方契约逐字段各造一个缺口（kind/dimensions/units/frequencyHz/
 *     coordinateFrame/axisNames/observationFields）＋ 适配器自报字段被篡改 ⇒ 必须 BLOCKED 且点名对应 reason。
 *  3. **门保留**：VLA 派生件放到**非官方套件** world（含"world 不可读"）上 ⇒ **仍**必须
 *     `ADAPTER_KIND_NOT_EXECUTABLE`，且 `actual.executionRoute` 仍指向 bench 链（既有
 *     `adapter-contract.test.ts:319-344` 断言的两项不得丢失）。
 *  4. **M2 分支**：`executeLiberoVlaPolicy` 用产品 `CPUInference` harness 驱动一个**协议同构的桩引擎**
 *     （`pythonPath` 是产品可配置项），把 bench Frame 的 sensors 送进推理、把 7 维动作经**既有**
 *     `sim.execute({kind:'control',positions,stepCount:1})` 下发、按 `nActionSteps` 排出块队列，
 *     并在官方终态（`taskAchieved/benchmarkStatus==='success'`）停下。
 */
import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { matchPolicy } from '../src/match.ts'
import {runtimeProbeStub} from './vlaRouteFixture.ts'
import { validateLiberoVlaAdapter } from '../src/adapter.ts'
import { executeLiberoVlaPolicy, vlaChunkQueue, vlaExecutionContract, vlaObservation } from '../src/execution.ts'
import {
  OFFICIAL_ACTION, VLA_IDENTITY, officialDescription, officialFrame, officialScene, officialWorld, produceVlaAdapter,
  sceneHandle, simStub, writeVlaSnapshot,
} from './vlaRouteFixture.ts'

const scratch = mkdtempSync(join(tmpdir(), 'policy-vla-route-'))
const identity = {
  provider: VLA_IDENTITY.provider, modelId: VLA_IDENTITY.modelId, revision: VLA_IDENTITY.revision,
  sceneId: VLA_IDENTITY.sceneId, entityId: VLA_IDENTITY.entityId, worldId: VLA_IDENTITY.worldId, expectedGeneration: 1,
}
let cached: { dataDirectory: string; root: string } | undefined
/** 一份装配好的产品策略快照（含 derived/adapter.json）在整组测试间复用：manifest 哈希与派生件都是真产物。 */
async function snapshot() {
  if (!cached) {
    const dataDirectory = mkdtempSync(join(scratch, 'root-'))
    cached = { dataDirectory, root: (await writeVlaSnapshot(dataDirectory)).root }
  }
  return cached
}
const matchOfficial = async (options: { description?: any; world?: any } = {}) =>
  matchPolicy({ dataDirectory: (await snapshot()).dataDirectory }, identity, sceneHandle(officialScene() as any) as any,
    simStub({ description: options.description ?? officialDescription(), world: options.world ?? officialWorld() }) as any)
const reasons = (result: any) => result.differences.map((row: any) => row.reason)

describe('M1 · VLA 适配器在官方套件世界上通过 matchPolicy', () => {
  test('正例：官方 world + 官方 describe + 产品派生件 ⇒ MATCHED（differences 空）', async () => {
    const result = await matchOfficial()
    expect(result.status).toBe('MATCHED')
    expect(result.differences).toEqual([])
    expect(result.execution.status).toBe('READY')
    // 走的是 VLA 分支（不是关节级 PreparedAdapter），派生件仍原样返回给执行链
    expect(result.adapter).toBeUndefined()
    expect(result.vlaAdapter?.adapter).toBe('libero-smolvla-v1')
  })

  test('M1 判据：官方 controller 每个字段各造一个缺口 ⇒ 逐条 BLOCKED 点名', async () => {
    const gaps: Array<{ controller: Record<string, unknown>; reason: string }> = [
      { controller: { kind: 'joint' }, reason: 'CONTROL_MODE_MISMATCH' },
      { controller: { dimensions: 6 }, reason: 'ACTION_DIMENSION_MISMATCH' },
      { controller: { units: OFFICIAL_ACTION.units.slice(0, 6) }, reason: 'ACTION_UNIT_MISMATCH' },
      { controller: { frequencyHz: 10 }, reason: 'CONTROL_FREQUENCY_MISMATCH' },
      { controller: { coordinateFrame: 'camera-frame delta' }, reason: 'ACTION_FRAME_MISMATCH' },
      { controller: { axisNames: [...OFFICIAL_ACTION.axisNames].reverse() }, reason: 'ACTION_AXIS_MISMATCH' },
      { controller: { observationFields: ['agentview_image'] }, reason: 'OBSERVATION_MAPPING_MISMATCH' },
    ]
    for (const gap of gaps) {
      const result = await matchOfficial({ description: officialDescription({ controller: gap.controller }) })
      expect({ gap: gap.reason, status: result.status, reasons: reasons(result) }).toEqual({ gap: gap.reason, status: 'BLOCKED', reasons: [gap.reason] })
    }
  })

  test('M1 判据：适配器自报的 actionDim/frequencyHz 被篡改 ⇒ 同样 BLOCKED（world 单方面"合规"不够）', async () => {
    const tampered = mkdtempSync(join(scratch, 'tampered-'))
    await writeVlaSnapshot(tampered, { adapterOverride: { actionDim: 6 } })
    const result = await matchPolicy({ dataDirectory: tampered }, identity, sceneHandle(officialScene() as any) as any, simStub() as any)
    expect(result.status).toBe('BLOCKED')
    expect(reasons(result)).toContain('ACTION_DIMENSION_MISMATCH')
    expect(result.differences.some((row: any) => row.path === 'vlaAdapter.actionDim')).toBe(true)
  })

  test('门保留：非官方套件 world（含 world 不可读）仍 ADAPTER_KIND_NOT_EXECUTABLE + bench 链指向', async () => {
    const nonOfficial = await matchOfficial({ world: officialWorld({ engineId: 'mujoco' }) })
    expect(nonOfficial.status).toBe('BLOCKED')
    expect(reasons(nonOfficial)).toEqual(['ADAPTER_KIND_NOT_EXECUTABLE'])
    const difference: any = nonOfficial.differences.find((row: any) => row.reason === 'ADAPTER_KIND_NOT_EXECUTABLE')
    expect(difference?.actual?.actionDim).toBe(7)
    expect(difference?.actual?.executionRoute).toContain('bench_step')
    expect(difference?.actual?.engineId).toBe('mujoco')

    // 既有 adapter-contract.test.ts 的场景（无 sim ⇒ world 不可读）也必须保留同一道门
    const noWorld = await matchPolicy({ dataDirectory: (await snapshot()).dataDirectory }, identity, sceneHandle(officialScene() as any) as any, undefined)
    expect(reasons(noWorld)).toContain('ADAPTER_KIND_NOT_EXECUTABLE')
    expect((noWorld.differences.find((row: any) => row.reason === 'ADAPTER_KIND_NOT_EXECUTABLE') as any)?.actual?.executionRoute).toContain('bench_step')
  })
})

describe('M2 · VLA 执行分支（观测取 sensors、动作走既有 sim.execute、出块按 nActionSteps）', () => {
  test('契约读数取自产品派生件：chunkSteps/周期/轴名；缺 nActionSteps ⇒ 显式失败', async () => {
    const adapter = await produceVlaAdapter(mkdtempSync(join(scratch, 'contract-')))
    const contract = vlaExecutionContract(adapter)
    expect(contract.actionDim).toBe(7)
    expect(contract.chunkSteps).toBe(adapter.inferenceFormat.nActionSteps as number)
    expect(contract.periodS).toBeCloseTo(1 / 20, 12)
    expect(contract.axisNames).toHaveLength(7)
    expect(() => vlaExecutionContract({ ...adapter, inferenceFormat: {} } as any)).toThrow(/POLICY_VLA_CONTRACT_INVALID: inferenceFormat\.nActionSteps/)
  })

  test('观测口径：sensors.{eefPositionM,eefQuaternionXyzw,gripperQpos} + agentview/wrist 的 path；缺一路即失败', () => {
    const frame = officialFrame() as any
    expect(vlaObservation(frame, VLA_IDENTITY.entityId)).toEqual({
      eef: [0.1, 0.2, 0.85], quatXyzw: [0, 0, 0, 1], gripper: [0.02, -0.02],
      imagePath: frame.entities[0].sensors.agentview_image.path, wristImagePath: frame.entities[0].sensors.wrist_image.path,
    })
    const noWrist = structuredClone(frame)
    delete noWrist.entities[0].sensors.wrist_image
    expect(() => vlaObservation(noWrist, VLA_IDENTITY.entityId)).toThrow(/POLICY_VLA_OBSERVATION_UNAVAILABLE: sensors\.wrist_image\.path/)
    const shortEef = structuredClone(frame)
    shortEef.entities[0].sensors.eefPositionM = [0.1, 0.2]
    expect(() => vlaObservation(shortEef, VLA_IDENTITY.entityId)).toThrow(/POLICY_VLA_OBSERVATION_UNAVAILABLE: sensors\.eefPositionM/)
    const notFinite = structuredClone(frame)
    notFinite.entities[0].sensors.gripperQpos = [0.02, Number.NaN]
    expect(() => vlaObservation(notFinite, VLA_IDENTITY.entityId)).toThrow(/POLICY_VLA_OBSERVATION_UNAVAILABLE: sensors\.gripperQpos/)
  })

  test('出块队列：按 actionDim 切块、超过检查点声明的 nActionSteps 或非整数倍 ⇒ 显式失败', () => {
    expect(vlaChunkQueue([1, 2, 3, 4, 5, 6, 7], 7, 50)).toEqual([[1, 2, 3, 4, 5, 6, 7]])
    expect(vlaChunkQueue([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], 7, 50)).toHaveLength(2)
    expect(() => vlaChunkQueue([1, 2, 3, 4, 5, 6, 7, 8], 7, 50)).toThrow(/POLICY_VLA_ACTION_SHAPE_INVALID/)
    expect(() => vlaChunkQueue([...Array(7 * 51).fill(0)], 7, 50)).toThrow(/超过检查点声明的 nActionSteps=50/)
    expect(() => vlaChunkQueue([...Array(7).fill(Number.POSITIVE_INFINITY)], 7, 50)).toThrow(/POLICY_VLA_ACTION_NOT_FINITE/)
  })

  test('分支实跑：sensors → 推理 → 既有 sim.execute(stepCount:1) 逐周期下发 → 官方终态停止', async () => {
    const { root } = await snapshot()
    const engine = writeStubEngine('chunk-2')
    const actions: any[] = []
    const frames = steppedFrames(3)
    const sim = {
      observe: async () => frames[0],
      execute: async (_worldId: string, action: any) => { actions.push(action); return receiptFor(frames[actions.length]) },
      stop: async () => ({ stopped: true, stepIndex: 0, receipts: [] }),
    }
    const result = await executeLiberoVlaPolicy(
      { dataDirectory: mkdtempSync(join(scratch, 'run-')), pythonPath: engine.path },
      { ...identity, durationS: 5, runId: 'vla-branch' } as any,
      sceneHandle(officialScene() as any) as any, sim as any, new AbortController().signal,
      { vlaAdapter: validateLiberoVlaAdapter(JSON.parse(readFileSync(join(root, 'derived', 'adapter.json'), 'utf8'))), manifestPath: join(root, 'manifest.json'), sceneRevision: 1, resolvedRevision: VLA_IDENTITY.revision },
    )
    expect(result.status).toBe('COMPLETED')
    expect(result.termination).toBe('check_success')
    expect(result.executionBranch).toBe('vla-osc-pose-delta')
    // 引擎回包 14 维 = 2 步：第 2 步命中官方成功 ⇒ 1 次推理喂 2 个控制周期（队列确实被排空使用）
    expect([result.controls, result.inferences]).toEqual([2, 1])
    expect(actions).toHaveLength(2)
    expect(actions.map(action => [action.kind, action.positions.length, action.stepCount, action.jointNames.length]))
      .toEqual([['control', 7, 1, 7], ['control', 7, 1, 7]])
    // 送进推理的观测就是 bench Frame 的 sensors（含两路相机 path），不是另造一套
    const seen = readFileSync(engine.requests, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const load = seen.find(row => row.method === 'load')
    expect(load.format).toBe('libero-vla')
    expect(load.adapterPath.endsWith(join('derived', 'adapter.json'))).toBe(true)
    expect(load.policyDir).toBe(root)
    const inference = seen.filter(row => row.method === 'infer')
    expect(inference).toHaveLength(1)
    expect(inference[0].actions).toBe(7)
    expect(inference[0].observation).toEqual({
      eef: [0.1, 0.2, 0.85], quatXyzw: [0, 0, 0, 1], gripper: [0.02, -0.02],
      imagePath: (officialFrame() as any).entities[0].sensors.agentview_image.path,
      wristImagePath: (officialFrame() as any).entities[0].sensors.wrist_image.path,
    })
  }, 30_000)

  test('分支负例：引擎回包维数不合法 ⇒ FAILED 且带明确失败码（不静默截断出动作）', async () => {
    const { root } = await snapshot()
    const engine = writeStubEngine('bad-shape')
    const sim = { observe: async () => steppedFrames(2)[0], execute: async (_worldId: string, action: any) => receiptFor(steppedFrames(2)[1]), stop: async () => ({ stopped: true, stepIndex: 0, receipts: [] }) }
    const result = await executeLiberoVlaPolicy(
      { dataDirectory: mkdtempSync(join(scratch, 'run-bad-')), pythonPath: engine.path },
      { ...identity, durationS: 5, runId: 'vla-bad' } as any,
      sceneHandle(officialScene() as any) as any, sim as any, new AbortController().signal,
      { vlaAdapter: validateLiberoVlaAdapter(JSON.parse(readFileSync(join(root, 'derived', 'adapter.json'), 'utf8'))), manifestPath: join(root, 'manifest.json'), sceneRevision: 1 },
    )
    expect(result.status).toBe('FAILED')
    expect(result.error).toContain('POLICY_VLA_ACTION_SHAPE_INVALID')
  }, 30_000)
})

// ------------------------------------------------------------- 夹具：协议同构的桩引擎（harness 级） -------------------------------------------------------------
/** `pythonPath(config.pythonPath)` 是产品可配置项 ⇒ 这里把"解释器"指向一个实现同构 JSON 行协议的 node 桩：
 *  验证的是**产品自己的** CPUInference harness ＋ 本分支的控制环，不冒充真推理。 */
function writeStubEngine(mode: 'chunk-2' | 'bad-shape') {
  const directory = mkdtempSync(join(scratch, 'engine-'))
  const path = join(directory, 'stub-vla-engine.cjs')
  const requests = join(directory, 'requests.jsonl')
  writeFileSync(path, `#!/usr/bin/env node
${runtimeProbeStub}const readline = require('node:readline'), fs = require('node:fs')
const log = line => fs.appendFileSync(${JSON.stringify(requests)}, line + '\\n')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); log(line)
  const reply = result => console.log(JSON.stringify({ id: request.id, result }))
  if (request.method === 'load') reply({ device: 'cpu', policyType: 'smolvla', chunkSize: 50, actionDim: 7 })
  else if (request.method === 'infer') reply(${mode === 'chunk-2' ? '[0,0,0,0,0,0,0.5,0,0,0,0,0,0,0.5]' : '[0,0,0,0,0,0,0.5,0]'})
  else reply({ status: 'reset-ok' })
})
`)
  chmodSync(path, 0o755)
  return { path, requests }
}
/** 官方帧序列：stepIndex/simTime 严格按 1/20 推进（`worker.py` 的 stepIndex/20 口径）。 */
function steppedFrames(count: number) {
  return Array.from({ length: count }, (_value, index) => officialFrame({ stepIndex: index, simTime: index / 20, frameId: 'frame-' + index } as any))
}
function receiptFor(frame: any) {
  const stepIndex = frame.stepIndex
  return { actionId: 'a-' + stepIndex, worldId: VLA_IDENTITY.worldId, generation: 1, status: 'completed', startStep: stepIndex, endStep: stepIndex, finalState: frame, taskAchieved: stepIndex === 2, reason: stepIndex === 2 ? 'check_success' : undefined, effect: { benchmarkStatus: stepIndex === 2 ? 'success' : 'running', evaluator: 'official-env.check_success' } }
}
