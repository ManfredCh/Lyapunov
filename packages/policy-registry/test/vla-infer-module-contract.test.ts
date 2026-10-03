/**
 * L416 · 产品侧 VLA 推理模块的契约测试（`DEV-028 条件③` 的缺口件）。
 *
 * 被测件：
 *  - `packages/policy-registry/python/libero_vla_infer_server.py`（新增：推理实现落产品源码，
 *    协议与 `python/torch_cpu.py` 同构 ⇒ 既有 `src/execution.ts:13-40` CPUInference 可承载）；
 *  - `packages/policy-registry/python/prepare_libero_vla.py` 新增的 `inferenceModule` 声明。
 *
 * 锁四件事（全部实跑，不 mock；不加载 865 MB 真权重、不联网，因此可在 CI 里跑）：
 *  1. 派生件**声明**了产品侧推理入口，且 `validateLiberoVlaAdapter` 仍然接受（纯增量）；
 *  2. 模块的观测口径＝官方序（`env_preprocessor` 先翻图再拼 state）：翻图与 numpy 官方算子逐位一致、
 *     state 形状 (1,8)、task 是 1 元素 list（批维配对）；
 *  3. **缺 envProcessor 声明的派生件必须被拒绝**（`LIBERO_VLA_ENV_PROCESSOR_UNDECLARED`，退出码 5）——
 *     这正是 L398 实测过的 0/3 失败形态，产品侧不能静默用未翻转的图像出动作；
 *  4. JSON 行协议与 `torch_cpu.py` 同构：行内带同一个 `id`、失败行带 `error`/`code`，stdout 只允许协议行。
 *
 * 解释器：`TESTCI_PYTHON`（未设置时回退到 `python3`，numpy 后端可用；与 `env-processor-contract.test.ts` 同款）。
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateLiberoVlaAdapter } from '../src/adapter.ts'

const PYTHON = process.env.TESTCI_PYTHON?.trim() || 'python3'
const MODULE = join(import.meta.dir, '../python/libero_vla_infer_server.py')
const PREPARE = join(import.meta.dir, '../python/prepare_libero_vla.py')

function run(args: string[], stdin?: string) {
  try {
    return { code: 0, stdout: execFileSync(PYTHON, args, { encoding: 'utf8', input: stdin, maxBuffer: 8 * 1024 * 1024 }), stderr: '' }
  } catch (error: any) {
    return { code: typeof error.status === 'number' ? error.status : -1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  }
}

/** 合成一份最小 SmolVLA 检查点（结构与 prepare_libero_vla.py 的必填键一致）。 */
function syntheticCheckpoint(): string {
  const root = mkdtempSync(join(tmpdir(), 'vla-infer-module-'))
  writeSafetensors(join(root, 'model.safetensors'), [
    ...STRUCTURE_TENSORS.map(name => ({ name, shape: [1, 1], data: [0.25] })),
    { name: 'normalize_inputs.buffer_observation_state.mean', shape: [8], data: [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75] },
    { name: 'normalize_inputs.buffer_observation_state.std', shape: [8], data: [1, 1, 1, 1, 1, 1, 1, 1] },
    { name: 'normalize_targets.buffer_action.mean', shape: [7], data: [0, 0, 0, 0, 0, 0, 0] },
    { name: 'normalize_targets.buffer_action.std', shape: [7], data: [1, 1, 1, 1, 1, 1, 1] },
    { name: 'unnormalize_outputs.buffer_action.mean', shape: [7], data: [0, 0, 0, 0, 0, 0, 0] },
    { name: 'unnormalize_outputs.buffer_action.std', shape: [7], data: [1, 1, 1, 1, 1, 1, 1] },
  ])
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    type: 'smolvla',
    input_features: {
      'observation.images.image': { type: 'VISUAL', shape: [3, 256, 256] },
      'observation.images.wrist_image': { type: 'VISUAL', shape: [3, 256, 256] },
      'observation.state': { type: 'STATE', shape: [8] },
    },
    output_features: { action: { type: 'ACTION', shape: [7] } },
    normalization_mapping: { VISUAL: 'IDENTITY', STATE: 'MEAN_STD', ACTION: 'MEAN_STD' },
  }))
  writeFileSync(join(root, 'train_config.json'), JSON.stringify({ policy: { num_steps: 10, n_action_steps: 50, chunk_size: 50 } }))
  return root
}

function preparedAdapter(): { root: string; adapterPath: string } {
  const root = syntheticCheckpoint()
  const adapterPath = join(root, 'derived', 'adapter.json')
  const result = run([PREPARE, root, join(root, 'derived', 'libero-smolvla-v1')])
  expect(result.code).toBe(0)
  writeFileSync(adapterPath, result.stdout)
  return { root, adapterPath }
}

describe('L416 · libero_vla_infer_server（产品侧 VLA 推理实现）', () => {
  test('派生件声明产品侧推理入口（inferenceModule）且 LiberoVlaAdapter 消费侧仍接受（纯增量）', () => {
    const { adapterPath } = preparedAdapter()
    const adapter = validateLiberoVlaAdapter(JSON.parse(readFileSync(adapterPath, 'utf8')))
    const declared = (adapter as any).inferenceModule
    expect(declared.path).toBe('packages/policy-registry/python/libero_vla_infer_server.py')
    expect(declared.protocol).toContain('torch_cpu.py 同构')
    expect(declared.methods).toEqual(['load', 'infer', 'reset'])
    expect(declared.harness).toContain('execution.ts:13-40')
    expect(declared.deps.newDependencies).toBe(0)
    expect(declared.envLayer).toContain('libero_env_processor.py')
    expect(declared.failureCodes).toContain('LIBERO_VLA_ENV_PROCESSOR_UNDECLARED')
    // 既有必填契约与 envProcessor 声明不受影响
    expect(adapter.actionDim).toBe(7)
    expect(adapter.frequencyHz).toBe(20)
    expect((adapter as any).envProcessor.envPreSteps).toEqual(['LiberoProcessorStep'])
  }, 60_000)

  test('观测口径＝官方序：翻图与 numpy 官方算子逐位一致、(1,8) state、task 1 元素 list', () => {
    const { root, adapterPath } = preparedAdapter()
    const result = run([MODULE, '--selftest', '--adapter', adapterPath, '--policy-dir', root])
    expect(result.code).toBe(0)
    const proof = JSON.parse(result.stdout)
    expect(proof.flip180MatchesNumpyFlip).toBe(true)
    expect(proof.flippedKeys).toEqual(['observation.images.image'])
    expect(proof.batched).toBe(true)
    expect(proof.stateShape).toEqual([1, 8])
    expect(proof.state).toEqual([1, 2, 3, 0, 0, 0, 0.25, -0.25])
    expect(proof.task).toEqual(['turn on the stove'])
    expect(proof.actionDim).toBe(7)
  }, 60_000)

  test('负对照：派生件未声明 envProcessor ⇒ 拒绝推理（退出码 5、LIBERO_VLA_ENV_PROCESSOR_UNDECLARED）', () => {
    const { adapterPath } = preparedAdapter()
    const stripped = JSON.parse(readFileSync(adapterPath, 'utf8'))
    delete stripped.envProcessor
    const strippedPath = join(tmpdir(), `vla-infer-stripped-${Date.now()}.json`)
    writeFileSync(strippedPath, JSON.stringify(stripped))
    const result = run([MODULE, '--selftest', '--adapter', strippedPath])
    expect(result.code).toBe(5)
    expect(result.stderr).toContain('LIBERO_VLA_ENV_PROCESSOR_UNDECLARED')
  }, 30_000)

  test('协议与 torch_cpu.py 同构：行内 id 原样回带、失败行带 error/code、stdout 只允许协议行', () => {
    const { root, adapterPath } = preparedAdapter()
    const stdin = [
      JSON.stringify({ id: 7, method: 'infer', actions: 7, observation: {} }),
      JSON.stringify({ id: 8, method: 'bogus' }),
      JSON.stringify({ id: 9, method: 'load', format: 'libero-vla', adapterPath: join(root, 'missing.json'), policyDir: root }),
    ].join('\n') + '\n'
    const result = run([MODULE, '--deps', root], stdin)
    const lines = result.stdout.trim().split('\n').filter(Boolean)
    expect(lines.length).toBe(3)
    const parsed = lines.map(line => JSON.parse(line)) // stdout 里任何非 JSON 行都会在这里炸
    expect(parsed.map(message => message.id)).toEqual([7, 8, 9])
    expect(parsed[0].error).toContain('未 load 就 infer')
    expect(parsed[1].error).toContain('未知 method')
    expect(parsed[2].code).toBe('LIBERO_VLA_SOURCE_FILES_MISSING')
    expect(parsed[2].error).toContain('LIBERO_VLA_SOURCE_FILES_MISSING')
    // 声明的失败码集合与实现一致（协议行里的 code 取自同一张表）
    expect(DECLARED_CODES).toContain(parsed[2].code)
  }, 30_000)
})

// ---------------------------------------------------------------- 与 env-processor-contract.test.ts 同式的 safetensors 写入器
function writeSafetensors(path: string, tensors: Array<{ name: string; shape: number[]; data: number[] }>) {
  const header: Record<string, any> = {}
  const blobs: Uint8Array[] = []
  let offset = 0
  for (const tensor of tensors) {
    const data = new Uint8Array(Float32Array.from(tensor.data).buffer)
    header[tensor.name] = { dtype: 'F32', shape: tensor.shape, data_offsets: [offset, offset + data.byteLength] }
    blobs.push(data)
    offset += data.byteLength
  }
  const headerBytes = new TextEncoder().encode(JSON.stringify(header))
  const length = new DataView(new ArrayBuffer(8))
  length.setBigUint64(0, BigInt(headerBytes.byteLength), true)
  writeFileSync(path, Buffer.concat([Buffer.from(length.buffer), Buffer.from(headerBytes), ...blobs.map(Buffer.from)]))
}
const STRUCTURE_TENSORS = ['model.action_in_proj.weight', 'model.action_out_proj.weight', 'model.state_proj.weight', 'model.action_time_mlp_in.weight', 'model.vlm_with_expert.vlm.model.text_model.embed_tokens.weight']
const DECLARED_CODES = ['LIBERO_VLA_USAGE', 'LIBERO_VLA_SOURCE_FILES_MISSING', 'LIBERO_VLA_ADAPTER_CONTRACT', 'LIBERO_VLA_ENV_PROCESSOR_UNDECLARED', 'LIBERO_VLA_DEPS_UNAVAILABLE', 'LIBERO_VLA_WRIST_IMAGE_MISSING']
