/**
 * DEV-028 条件①（真机集成判据）：**消费侧必须认产品推理模块的回包形状**。
 *
 * 现场读数（L419，真实 dev 宿主 4265，`policy_execute` runId `policy-d8202001-…`）：
 *   模块 `python/libero_vla_infer_server.py:280` 的 `infer` 回 `{"values":[…],"steps":50,"actionDim":7}`，
 *   而执行分支按**裸数组**读 ⇒ 第一次出块就
 *   `POLICY_VLA_ACTION_SHAPE_INVALID: 推理回包 非数组 不是 7 的正整数倍`（`status=FAILED`，`controls=0`）。
 *   `python/**` 是另一条 lane 的交付（只读），因此修在消费侧：`vlaActionValues` 把两种形状归一化到展平数组，
 *   维数上界/有限性仍只由 `vlaChunkQueue` 判（判据一处）。
 *
 * 锁三件事：① 两种形状都归一化正确；② 自相矛盾的对象回包逐条显式失败（不猜、不截断）；
 * ③ 分支实跑：桩引擎回**模块同形**对象 ⇒ 走到官方终态（controls=2 / inferences=1）。
 */
import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateLiberoVlaAdapter } from '../src/adapter.ts'
import { executeLiberoVlaPolicy, vlaActionValues, vlaChunkQueue } from '../src/execution.ts'
import { runtimeProbeStub, VLA_IDENTITY, officialFrame, officialWorld, sceneHandle, writeVlaSnapshot } from './vlaRouteFixture.ts'

const scratch = mkdtempSync(join(tmpdir(), 'policy-vla-reply-'))
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

describe('产品推理模块回包形状（{values,steps,actionDim}）', () => {
  test('裸数组原样透传（既有 harness 形状不回归）', () => {
    const flat = [1, 2, 3, 4, 5, 6, 7]
    expect(vlaActionValues(flat, 7)).toBe(flat)
    expect(vlaActionValues(undefined, 7)).toBeUndefined()
  })

  test('模块对象形状 ⇒ 展平 values，且仍由 vlaChunkQueue 切块', () => {
    const values = [...Array(14).fill(0).map((_value, index) => index / 10)]
    expect(vlaActionValues({ values, steps: 2, actionDim: 7 }, 7)).toEqual(values)
    expect(vlaChunkQueue(vlaActionValues({ values, steps: 2, actionDim: 7 }, 7), 7, 50)).toHaveLength(2)
  })

  test('自相矛盾的对象回包逐条显式失败（不猜、不截断）', () => {
    expect(() => vlaActionValues({ steps: 2, actionDim: 7 }, 7)).toThrow(/缺 values 数组/)
    expect(() => vlaActionValues({ values: [], steps: 0, actionDim: 7 }, 7)).toThrow(/steps 非法/)
    expect(() => vlaActionValues({ values: [1, 2, 3, 4, 5, 6, 7], steps: 1, actionDim: 6 }, 7)).toThrow(/actionDim=6 与执行契约 7 不符/)
    expect(() => vlaActionValues({ values: [1, 2, 3], steps: 1, actionDim: 7 }, 7)).toThrow(/values=3 与 steps×actionDim=1×7=7 不符/)
  })
})

describe('分支实跑：桩引擎回模块同形对象', () => {
  test('{values,steps:2,actionDim:7} ⇒ 2 个控制周期、官方 check_success 停止', async () => {
    const { root } = await snapshot()
    const engine = writeReplyEngine({ values: [0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0.5], steps: 2, actionDim: 7 })
    const frames = steppedFrames(3)
    const actions: any[] = []
    const sim = {
      listWorlds: async () => [officialWorld()],
      observe: async () => frames[0],
      execute: async (_worldId: string, action: any) => { actions.push(action); return receiptFor(frames[actions.length]) },
      stop: async () => ({ stopped: true, stepIndex: 0, receipts: [] }),
    }
    const result = await executeLiberoVlaPolicy(
      { dataDirectory: mkdtempSync(join(scratch, 'run-')), pythonPath: engine.path },
      { ...identity, durationS: 5, runId: 'vla-reply-ok' } as any,
      sceneHandle({ sceneId: VLA_IDENTITY.sceneId, revision: 1 }) as any, sim as any, new AbortController().signal,
      { vlaAdapter: validateLiberoVlaAdapter(JSON.parse(readFileSync(join(root, 'derived', 'adapter.json'), 'utf8'))), manifestPath: join(root, 'manifest.json'), sceneRevision: 1, resolvedRevision: VLA_IDENTITY.revision },
    )
    expect({ status: result.status, termination: result.termination, controls: result.controls, inferences: result.inferences })
      .toEqual({ status: 'COMPLETED', termination: 'check_success', controls: 2, inferences: 1 })
    expect(actions).toHaveLength(2)
  }, 30_000)

  test('负例：对象里 actionDim 与契约不符 ⇒ FAILED + POLICY_VLA_ACTION_SHAPE_INVALID（不放行）', async () => {
    const { root } = await snapshot()
    const engine = writeReplyEngine({ values: [0, 0, 0, 0, 0, 0.5], steps: 1, actionDim: 6 })
    const sim = { listWorlds: async () => [officialWorld()], observe: async () => officialFrame() as any, execute: async () => { throw new Error('不应下发动作') }, stop: async () => ({ stopped: true, stepIndex: 0, receipts: [] }) }
    const result = await executeLiberoVlaPolicy(
      { dataDirectory: mkdtempSync(join(scratch, 'run-bad-')), pythonPath: engine.path },
      { ...identity, durationS: 5, runId: 'vla-reply-bad' } as any,
      sceneHandle({ sceneId: VLA_IDENTITY.sceneId, revision: 1 }) as any, sim as any, new AbortController().signal,
      { vlaAdapter: validateLiberoVlaAdapter(JSON.parse(readFileSync(join(root, 'derived', 'adapter.json'), 'utf8'))), manifestPath: join(root, 'manifest.json'), sceneRevision: 1 },
    )
    expect(result.status).toBe('FAILED')
    expect(result.error).toContain('POLICY_VLA_ACTION_SHAPE_INVALID')
  }, 30_000)
})

function writeReplyEngine(reply: unknown) {
  const directory = mkdtempSync(join(scratch, 'engine-'))
  const path = join(directory, 'stub-vla-engine.cjs')
  writeFileSync(path, `#!/usr/bin/env node
${runtimeProbeStub}const readline = require('node:readline')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  const result = request.method === 'load' ? { device: 'cpu', policyType: 'smolvla', chunkSize: 50, actionDim: 7 }
    : request.method === 'infer' ? ${JSON.stringify(reply)} : { status: 'reset-ok' }
  console.log(JSON.stringify({ id: request.id, result }))
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
