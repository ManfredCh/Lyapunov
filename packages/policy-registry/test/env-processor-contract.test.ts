/**
 * L405 · 官方 LIBERO env 层口径（`LiberoProcessorStep`）的产品侧契约测试。
 *
 * 被测件：`packages/policy-registry/python/libero_env_processor.py`（纯 stdlib，numpy/torch 仅作可选后端）
 *   ＋ `prepare_libero_vla.py` 新增的 `envProcessor` 声明。
 *
 * 锁三件事（全部实跑，不 mock）：
 *  1. **180° 翻转**确实同时翻 H 与 W：逐像素与"索引映射参考实现"零不符、翻转两次＝恒等、
 *     且 **不是** 单轴镜像（否则 U/D 或 L/R 单翻都能骗过"两次恒等"）；task 形状配对守卫必须
 *     在两种半改法上都抛错（这是 L398 记录过的**静默**坏 prompt 路径）。
 *  2. `prepare_libero_vla.py` 产出的 adapter JSON 带 `envProcessor`，且 `src/adapter.ts` 的
 *     `LiberoVlaAdapter` 消费函数**仍然接受**（纯增量、不改既有必填字段）。
 *  3. 官方 LIBERO env 的 `env_postprocessor` 恒等这一事实被写进声明（版本钉死 lerobot 0.6.1）。
 *
 * 解释器：`TESTCI_PYTHON`（未设置时回退到 `python3`；`libero_env_processor.py` 的纯 stdlib 路径与 prepare 脚本同款实证）。
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateLiberoVlaAdapter } from '../src/adapter.ts'

const SYSTEM_PYTHON = process.env.TESTCI_PYTHON?.trim() || 'python3'
const ENV_PROCESSOR = join(import.meta.dir, '../python/libero_env_processor.py')
const PREPARE = join(import.meta.dir, '../python/prepare_libero_vla.py')

function run(args: string[]) {
  try {
    return { code: 0, stdout: execFileSync(SYSTEM_PYTHON, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }), stderr: '' }
  } catch (error: any) {
    return { code: typeof error.status === 'number' ? error.status : -1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  }
}

interface FlipProof {
  shape: number[]; flip_dims: number[]; pixel_mismatches_vs_reference: number
  probes: Array<{ at: number[]; source: number; expected_from_source: number; actual_flipped: number }>
  block_move: Record<string, number>
  double_flip_is_identity: boolean; value_multiset_preserved: boolean
  task_pairing_guard: Record<string, unknown>
  state_probe: number[][]
  backend_parity: Record<string, any>
  env_post_is_identity: boolean
}

describe('L405 · libero_env_processor（官方 LiberoProcessorStep 产品侧实现）', () => {
  test('180° 翻转：逐像素＝索引映射参考、两次＝恒等、非单轴镜像；task 配对守卫拦两种半改法', () => {
    const result = run([ENV_PROCESSOR, '--selftest'])
    expect(result.code).toBe(0)
    const proof = JSON.parse(result.stdout) as FlipProof

    // 翻转轴＝官方 torch.flip(dims=[2,3])（H 与 W 同时翻）
    expect(proof.flip_dims).toEqual([2, 3])
    // 逐像素与独立参考实现零不符（参考＝按定义做索引映射，不复用被测代码）
    expect(proof.pixel_mismatches_vs_reference).toBe(0)
    // 逐像素 expected/actual 抽样：expected 取自源 (H-1-h, W-1-w)
    expect(proof.probes.length).toBeGreaterThanOrEqual(4)
    for (const probe of proof.probes) expect(probe.actual_flipped).toBe(probe.expected_from_source)
    // 左上角块 ⇒ 右下角、右下角块 ⇒ 左上角（真 180°，不是单轴镜像）
    expect(proof.block_move.flipped_bottom_right).toBe(proof.block_move.source_top_left)
    expect(proof.block_move.flipped_top_left).toBe(proof.block_move.source_bottom_right)
    // 翻转两次＝恒等；值集合不变（纯置换，无算术/无插值）
    expect(proof.double_flip_is_identity).toBe(true)
    expect(proof.value_multiset_preserved).toBe(true)

    // task 形状与批维必须配对：两种半改法都抛 LIBERO_ENV_PROCESSOR_TASK_SHAPE_MISMATCH
    expect(proof.task_pairing_guard.batched_with_str).toBe('LIBERO_ENV_PROCESSOR_TASK_SHAPE_MISMATCH')
    expect(proof.task_pairing_guard.unbatched_with_list).toBe('LIBERO_ENV_PROCESSOR_TASK_SHAPE_MISMATCH')
    // 配对正确的两条：已批处理 ⇒ 1 元素 list；未批处理 ⇒ 裸 str
    expect(proof.task_pairing_guard.batched_with_list).toEqual(['turn on the stove'])
    expect(proof.task_pairing_guard.unbatched_with_str).toBe('turn on the stove')

    // state 组装＝cat(eef_pos(3), axisangle(quat)(3), gripper_qpos(2))；单位四元数 ⇒ 轴角 0
    expect(proof.state_probe).toEqual([[1, 2, 3, 0, 0, 0, 0.25, -0.25]])

    // env_postprocessor 恒等（官方 0.6.1 空 pipeline）
    expect(proof.env_post_is_identity).toBe(true)

    // 后端一致性（numpy/torch 可用时）：同一份源值三种后端逐位相同
    if (proof.backend_parity.numpy !== 'unavailable') {
      expect(proof.backend_parity.numpy.matches_independent_reference).toBe(true)
      expect(proof.backend_parity.numpy.matches_pure_python).toBe(true)
      expect(proof.backend_parity.numpy.double_flip_is_identity).toBe(true)
      expect(proof.backend_parity.numpy.contiguous).toBe(true) // 负 stride 会让 torch.from_numpy 拒绝
    }
    if (proof.backend_parity.torch !== 'unavailable') {
      expect(proof.backend_parity.torch.matches_official_torch_flip).toBe(true)
      expect(proof.backend_parity.torch.matches_pure_python).toBe(true)
      expect(proof.backend_parity.torch.double_flip_is_identity).toBe(true)
    }
  }, 60_000)

  test('prepare_libero_vla.py 产出 envProcessor 声明且 LiberoVlaAdapter 消费侧仍接受（纯增量）', () => {
    const root = mkdtempSync(join(tmpdir(), 'env-processor-contract-'))
    writeSafetensors(join(root, 'model.safetensors'), [
      ...STRUCTURE_TENSORS.map(name => ({ name, shape: [1, 1], data: [0.25] })),
      { name: 'normalize_inputs.buffer_observation_state.mean', shape: [8], data: [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75] },
      { name: 'normalize_inputs.buffer_observation_state.std', shape: [8], data: [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75] },
      { name: 'normalize_targets.buffer_action.mean', shape: [7], data: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75] },
      { name: 'normalize_targets.buffer_action.std', shape: [7], data: [1, 1, 1, 1, 1, 1, 1] },
      { name: 'unnormalize_outputs.buffer_action.mean', shape: [7], data: [-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75] },
      { name: 'unnormalize_outputs.buffer_action.std', shape: [7], data: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] },
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
    writeFileSync(join(root, 'train_config.json'), JSON.stringify({ policy: { num_steps: 10, n_action_steps: 10, chunk_size: 50 } }))

    const result = run([PREPARE, root, join(root, 'out')])
    expect(result.code).toBe(0)
    const raw = JSON.parse(result.stdout)
    const adapter = validateLiberoVlaAdapter(raw) // 消费侧仍然接受（新增键不改必填契约）

    expect(adapter.observations.keys).toEqual(['observation.images.image', 'observation.images.wrist_image', 'observation.state'])
    const declared = (adapter as any).envProcessor
    expect(declared.module).toBe('libero_env_processor')
    expect(declared.envPreSteps).toEqual(['LiberoProcessorStep'])
    expect(declared.envPostSteps).toEqual([])
    expect(declared.envPostIsIdentity).toBe(true)
    expect(declared.imageFlip180.appliesTo).toBe('observation.images.*')
    expect(declared.imageFlip180.requiresBatchDim).toBe(true)
    expect(declared.stateAssembly.shape).toEqual([8])
    expect(declared.stateAssembly.dtype).toBe('float32')
    expect(declared.stateAssembly.order).toEqual(['eef_pos', 'axis_angle_xyzw', 'gripper_qpos'])
    expect(declared.taskShape.batchedObservation).toBe('list[str] (1 element)')
    expect(declared.taskShape.unbatchedObservation).toBe('str')
    // 口径来源逐条 file:line（可复核，不靠记忆）
    expect(declared.upstream.imageFlip).toContain('env_processor.py:59')
    expect(declared.upstream.stateAssembly).toContain('env_processor.py:65-82')
    expect(declared.upstream.taskShape).toContain('eval_libero.py:120-127')
    expect(declared.upstream.envProcessors).toContain('envs/configs.py:447-451')
    expect(declared.upstream.versionPin).toBe('lerobot[libero,evaluation]==0.6.1')
  }, 60_000)

  test('负对照：非 4 维（缺批维）图像 ⇒ 明确 LIBERO_ENV_PROCESSOR_BATCH_REQUIRED，不静默放行', () => {
    const script = [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(join(import.meta.dir, '../python'))})`,
      'from libero_env_processor import flip180_image',
      'try:',
      "    flip180_image([[1.0, 2.0], [3.0, 4.0]])",
      'except ValueError as error:',
      '    print(error)',
    ].join('\n')
    const result = run(['-c', script])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('LIBERO_ENV_PROCESSOR_BATCH_REQUIRED')
  }, 30_000)
})

// ---------------------------------------------------------------- safetensors 合成写入器（与 adapter-contract.test.ts 同式）
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
