/**
 * DEV-028 条件③（M1）判据测试：**VLA 分支的 CPU 推理预算必须可配置，且真的被 harness 采纳**。
 *
 * 背景（L416 实测）：CPU-only SmolVLA 一次出块 25,174–52,009 ms（run B）/ 54,896 ms（run A），
 * 而 `CPUInference.request()` 原本写死 `setTimeout(…,30000)` ⇒ VLA 分支**每一次**出块都会以
 * `POLICY_CPU_TIMEOUT` 结束，该分支等于不可用（Go1/WTW 分支 30 s 够用，不能被一起放宽）。
 *
 * 锁三件事：
 *  1. `vlaInferenceTimeoutMs()` 的取值语义：默认 15 min；`LYAPUNOV_VLA_INFER_TIMEOUT_MS` 正整数可覆盖；
 *     非法值（0/负数/非数字）**回落默认**，不静默当"无限等"、也不取 0 当"立刻超时"；
 *  2. **接线真的生效**：把 `pythonPath` 指向一个「回 load、`infer` 永不回包」的协议同构桩，覆盖成 500 ms ⇒
 *     `executeLiberoVlaPolicy` 必须在 ~秒级（远早于 30 s 默认值）以 `POLICY_CPU_TIMEOUT` 结束 —— 若构造参数
 *     没被传进 `CPUInference`，这条测试会等 30 s 才失败（因此它是"改法真的接上了"的判据，不是纯函数单测）；
 *  3. 桩引擎的请求日志里 `infer` 确实已被派发（不是死在 load 阶段）：证明超时发生在"等推理回包"这一步。
 */
import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateLiberoVlaAdapter } from '../src/adapter.ts'
import { executeLiberoVlaPolicy, vlaInferenceTimeoutMs } from '../src/execution.ts'
import { runtimeProbeStub, VLA_IDENTITY, officialFrame, officialScene, sceneHandle, writeVlaSnapshot } from './vlaRouteFixture.ts'

const scratch = mkdtempSync(join(tmpdir(), 'policy-vla-timeout-'))
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
/** 只在显式给值时改动环境，测完原样恢复（不污染同进程内其它测试文件的读数）。 */
function withTimeoutEnv(value: string | undefined, body: () => Promise<void> | void) {
  const previous = process.env.LYAPUNOV_VLA_INFER_TIMEOUT_MS
  if (value === undefined) delete process.env.LYAPUNOV_VLA_INFER_TIMEOUT_MS
  else process.env.LYAPUNOV_VLA_INFER_TIMEOUT_MS = value
  return Promise.resolve()
    .then(body)
    .finally(() => { if (previous === undefined) delete process.env.LYAPUNOV_VLA_INFER_TIMEOUT_MS; else process.env.LYAPUNOV_VLA_INFER_TIMEOUT_MS = previous })
}

describe('M1 · VLA 单次出块的 CPU 推理预算可配置', () => {
  test('默认 15 min；正整数覆盖生效；0/负数/非数字回落默认（不静默当无限等或立刻超时）', async () => {
    await withTimeoutEnv(undefined, () => { expect(vlaInferenceTimeoutMs()).toBe(900000) })
    await withTimeoutEnv('', () => { expect(vlaInferenceTimeoutMs()).toBe(900000) })
    await withTimeoutEnv('abc', () => { expect(vlaInferenceTimeoutMs()).toBe(900000) })
    await withTimeoutEnv('0', () => { expect(vlaInferenceTimeoutMs()).toBe(900000) })
    await withTimeoutEnv('-1', () => { expect(vlaInferenceTimeoutMs()).toBe(900000) })
    await withTimeoutEnv('1500', () => { expect(vlaInferenceTimeoutMs()).toBe(1500) })
    // 显式入参优先于环境（同一个纯函数既可读数也可注入）
    expect(vlaInferenceTimeoutMs('4200')).toBe(4200)
  })

  test('接线判据：覆盖成 500 ms ⇒ 永不回包的桩引擎在秒级以 POLICY_CPU_TIMEOUT 结束（默认 30 s 不可能这么快）', async () => {
    const { root } = await snapshot()
    const engine = writeHangingEngine()
    const sim = {
      observe: async () => officialFrame() as any,
      execute: async () => { throw new Error('不应到达 sim.execute：推理超时发生在下发动作之前') },
      stop: async () => ({ stopped: true, stepIndex: 0, receipts: [] }),
    }
    await withTimeoutEnv('500', async () => {
      const started = Date.now()
      const result = await executeLiberoVlaPolicy(
        { dataDirectory: mkdtempSync(join(scratch, 'run-')), pythonPath: engine.path },
        { ...identity, durationS: 5, runId: 'vla-timeout' } as any,
        sceneHandle(officialScene() as any) as any, sim as any, new AbortController().signal,
        { vlaAdapter: validateLiberoVlaAdapter(JSON.parse(readFileSync(join(root, 'derived', 'adapter.json'), 'utf8'))), manifestPath: join(root, 'manifest.json'), sceneRevision: 1, resolvedRevision: VLA_IDENTITY.revision },
      )
      const elapsed = Date.now() - started
      expect(result.status).toBe('FAILED')
      expect(result.error).toContain('POLICY_CPU_TIMEOUT')
      expect(result.controls).toBe(0)
      // 远早于 harness 的 30 s 默认值 ⇒ 构造参数真的被传进了 CPUInference
      expect(elapsed).toBeLessThan(10_000)
      // 桩日志：load 已回、infer 已派发（超时点确实在"等推理回包"）
      const seen = readFileSync(engine.requests, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      expect(seen.map((row: any) => row.method)).toEqual(['load', 'infer'])
    })
  }, 30_000)
})

/** 协议同构（`{id,method}` → `{id,result}`）的桩引擎：`load` 正常回包，`infer` **永不回包**并在 stdin 上挂着。 */
function writeHangingEngine() {
  const directory = mkdtempSync(join(scratch, 'engine-'))
  const path = join(directory, 'stub-hanging-vla-engine.cjs')
  const requests = join(directory, 'requests.jsonl')
  writeFileSync(path, `#!/usr/bin/env node
${runtimeProbeStub}const readline = require('node:readline'), fs = require('node:fs')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); fs.appendFileSync(${JSON.stringify(requests)}, line + '\\n')
  if (request.method === 'load') console.log(JSON.stringify({ id: request.id, result: { device: 'cpu', policyType: 'smolvla', chunkSize: 50, actionDim: 7 } }))
  // infer：故意不回包，模拟 25–55 s 量级的真实出块耗时被预算截断。
})
`)
  chmodSync(path, 0o755)
  return { path, requests }
}
