/**
 * 适配件 stdout 契约测试（任务2a）：用**脚本造的合成输入实跑 python 侧 prepare_***（不需要真权重），
 * 把产出的 stdout JSON 喂 src/adapter.ts 的消费函数，锁住两侧契约：
 *
 * - prepare_wtw.py（Go1 WTW → MuJoCo position-PD）：PreparedAdapter 契约 + 声称语义
 *   （PD 20/0.5、action_scale 0.25、50Hz、观测 70 维×30 帧历史=2100）与消费侧解引用逐项一致；
 * - prepare_libero_vla.py（SmolVLA×LIBERO）：LiberoVlaAdapter 契约 + 7 维 OSC delta + 归一化统计 round-trip
 *   （stdlib 解析 safetensors——特意用 `TESTCI_PYTHON` 实跑，证明无第三方依赖）；
 * - 缺字段行为：脚本侧造错输入 ⇒ 非零退出+stderr 错误码；消费侧缺字段 ⇒ `ADAPTER_CONTRACT_MISMATCH` 点名
 *   路径（不再落成 hashFile(undefined)/TypeError 之类的晚期崩溃）；
 * - derived/adapter.json 双形状（PreparedAdapter / LiberoVlaAdapter）判别消费：matchPolicy 对 VLA 派生件
 *   给明确 ADAPTER_KIND_NOT_EXECUTABLE 差异，而不是解引用对方形状崩掉。
 *
 * 解释器：prepare_wtw 需要 mujoco+numpy（产品策略 python = pythonPath()，即 .runtime/sim-python）；
 * prepare_libero_vla 纯 stdlib，用 `TESTCI_PYTHON` 实跑（未设置时回退到系统 `python3`）。
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { consumeLiberoVlaAdapter, consumePreparedAdapter, isLiberoVlaAdapter, isPreparedAdapter, pythonPath, readAdapter, validateLiberoVlaAdapter, validatePreparedAdapter } from '../src/adapter.ts'
import { matchPolicy } from '../src/match.ts'

const PYTHON = pythonPath() // 产品策略 python（prepare_wtw 要 mujoco+numpy）
const SYSTEM_PYTHON = process.env.TESTCI_PYTHON?.trim() || 'python3' // CI venv（prepare_libero_vla 纯 stdlib 实证）
const emptyDir = () => mkdtempSync(join(tmpdir(), 'adapter-contract-'))
const source = { resolvedRevision: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', modelId: 'contract/source-model', provider: 'github' as const }

function run(python: string, args: string[]) {
  try {
    return { code: 0, stdout: execFileSync(python, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }), stderr: '' }
  } catch (error: any) {
    return { code: typeof error.status === 'number' ? error.status : -1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  }
}
const sha256hex = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')

// ---------------------------------------------------------------- WTW 合成输入 ----------------------------------------------------------------
/** 语义来源值取自真实 pkl 读数（见真实权重取证回执）：PD 20/0.5、action_scale 0.25、dt 0.005×decimation 4、
 *  num_observations 70、num_observation_history 30、commands 15 维、limit_gait_frequency [2,4]。 */
const wtwCfg = (overrides: Record<string, any> = {}) => ({
  control: { stiffness: { joint: 20.0 }, damping: { joint: 0.5 }, action_scale: 0.25, hip_scale_reduction: 0.5, decimation: 4 },
  normalization: { clip_actions: 10.0 },
  sim: { dt: 0.005 },
  init_state: {
    default_joint_angles: {
      FL_hip_joint: 0.1, FL_thigh_joint: 0.8, FL_calf_joint: -1.5,
      FR_hip_joint: -0.1, FR_thigh_joint: 0.8, FR_calf_joint: -1.5,
      RL_hip_joint: 0.1, RL_thigh_joint: 1.0, RL_calf_joint: -1.5,
      RR_hip_joint: -0.1, RR_thigh_joint: 1.0, RR_calf_joint: -1.5,
    },
    pos: [0.0, 0.0, 0.34],
  },
  env: { num_observations: 70, num_observation_history: 30, num_actions: 12 },
  commands: { limit_gait_frequency: [2.0, 4.0], num_commands: 15 },
  obs_scales: {
    lin_vel: 2.0, ang_vel: 0.25, body_height_cmd: 2.0, gait_freq_cmd: 1.0, gait_phase_cmd: 1.0,
    footswing_height_cmd: 0.15, body_pitch_cmd: 0.3, body_roll_cmd: 0.3, stance_width_cmd: 1.0,
    stance_length_cmd: 1.0, aux_reward_cmd: 1.0, dof_pos: 1.0, dof_vel: 0.05,
  },
  ...overrides,
})
/** menagerie 布局（`<dir>/go1.xml` + `assets/`）的最小 Go1 形 MJCF：trunk + 4 腿×3 关节 + 12 个 gear=1 motor。
 *  执行器序刻意用资产序（FR/FL/RR/RL），以核对策略序（FL/FR/RL/RR）映射字段 modelJointNames。 */
const LEGS = [['FR', '0.183 -0.047 0'], ['FL', '0.183 0.047 0'], ['RR', '-0.183 -0.047 0'], ['RL', '-0.183 0.047 0']] as const
const PARTS = [['hip', '1 0 0', '-1.05 1.05'], ['thigh', '0 1 0', '-1.57 1.57'], ['calf', '0 1 0', '-2.72 -0.92']] as const
function writeGo1Mjcf(modelDir: string) {
  mkdirSync(join(modelDir, 'assets'), { recursive: true })
  const bodies = LEGS.map(([leg, pos]) =>
    `<body name="${leg}_hip" pos="${pos}"><joint name="${leg}_hip_joint" type="hinge" axis="${PARTS[0][1]}" range="${PARTS[0][2]}"/><geom type="capsule" size="0.02" fromto="0 0 0 0 0 0.05"/>` +
    `<body name="${leg}_thigh" pos="0 0 0.05"><joint name="${leg}_thigh_joint" type="hinge" axis="${PARTS[1][1]}" range="${PARTS[1][2]}"/><geom type="capsule" size="0.02" fromto="0 0 0 0 0 -0.2"/>` +
    `<body name="${leg}_calf" pos="0 0 -0.2"><joint name="${leg}_calf_joint" type="hinge" axis="${PARTS[2][1]}" range="${PARTS[2][2]}"/><geom type="capsule" size="0.02" fromto="0 0 0 0 0 -0.2"/></body></body></body>`).join('')
  const actuators = LEGS.map(([leg]) => PARTS.map(([part]) => `<motor name="${leg}_${part}" joint="${leg}_${part}_joint" gear="1"/>`).join('')).join('')
  writeFileSync(join(modelDir, 'go1.xml'),
    `<mujoco model="go1-contract-synthetic"><compiler meshdir="assets"/><option timestep="0.005"/>\n` +
    `<worldbody><body name="trunk" pos="0 0 0.445"><freejoint name="floating_base"/>` +
    `<geom name="trunk_geom" type="box" size="0.1 0.05 0.03" mass="4.7"/>${bodies}</body></worldbody>\n` +
    `<actuator>${actuators}</actuator></mujoco>\n`)
}
function wtwInput(root: string, cfgOverrides: Record<string, any> = {}) {
  const runDir = join(root, 'runs/gait-conditioned-agility/pretrain-v0/train/025417.456545')
  mkdirSync(join(runDir, 'checkpoints'), { recursive: true })
  const cfgPath = join(root, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(wtwCfg(cfgOverrides)))
  execFileSync(SYSTEM_PYTHON, ['-c', 'import json,pickle,sys; pickle.dump({"Cfg": json.load(open(sys.argv[1]))}, open(sys.argv[2],"wb"))', cfgPath, join(runDir, 'parameters.pkl')])
  writeFileSync(join(runDir, 'checkpoints/body_latest.jit'), 'synthetic-torchscript-body')
  writeFileSync(join(runDir, 'checkpoints/adaptation_module_latest.jit'), 'synthetic-torchscript-adaptation')
  return runDir
}

describe('prepare_wtw.py stdout × PreparedAdapter 消费契约（合成输入实跑）', () => {
  test('合成 pkl+MJCF 实跑 ⇒ 消费函数核对声称语义（PD 20/0.5、action_scale 0.25、50Hz、70×30=2100）', async () => {
    const root = emptyDir(), modelDir = join(root, 'model'), output = join(root, 'out')
    wtwInput(root)
    writeGo1Mjcf(modelDir)
    const result = run(PYTHON, [join(import.meta.dir, '../python/prepare_wtw.py'), root, modelDir, output])
    expect(result.code).toBe(0)

    const adapter = await consumePreparedAdapter(result.stdout, source)
    // 声称语义逐项核对（docstring 语义来源 = parameters.pkl + WTW 源码）
    expect(adapter.config.stiffness).toBe(20)      // PD 20/0.5
    expect(adapter.config.damping).toBe(0.5)
    expect(adapter.config.action_scale).toBe(0.25)
    expect(adapter.frequencyHz).toBe(50)           // 0.005 × 4
    expect(adapter.config.simulation_dt).toBe(0.005)
    expect(adapter.config.control_decimation).toBe(4)
    expect(adapter.config.num_obs).toBe(70)        // 3+15+12+12+12+12+4
    expect(adapter.observations.shape).toEqual([70])
    expect(adapter.observations.frameDimension).toBe(70)
    expect(adapter.observations.historyFrames).toBe(30)
    expect(adapter.config.num_observation_history).toBe(30)
    expect(adapter.config.num_obs_history).toBe(2100) // 70×30
    expect(adapter.observations.order).toEqual([
      'projectedGravityFromQuaternion', 'command*cmd_scale', '(jointPosition-default_angles)*dof_pos_scale',
      'jointVelocity*dof_vel_scale', 'previousAction', 'previousPreviousAction', 'clockInputs'])
    expect(adapter.observations.phasePeriodS).toBeCloseTo(1 / 3, 12)
    // 消费侧必需的其余字段（execution.ts twoStage 通路逐字段解引用）
    expect(adapter.observations.inference).toBe('torchscript-adaptation')
    expect(adapter.observations.commandDimension).toBe(15)
    expect(adapter.observations.gaitCommandScale).toHaveLength(15)
    expect(Object.keys(adapter.observations.gait!)).toEqual([
      'bodyHeightOffsetM', 'frequencyHz', 'phase', 'offset', 'bound', 'durationS',
      'footswingHeightM', 'bodyPitchRad', 'bodyRollRad', 'stanceWidthM', 'stanceLengthM', 'auxRewardCoef'])
    expect(adapter.config.clip_actions).toBe(10)
    expect(adapter.config.hip_action_indices).toEqual([0, 3, 6, 9])
    expect(adapter.config.hip_scale_reduction).toBe(0.5)
    // 策略序 FL/FR/RL/RR×(hip,thigh,calf)（deploy 参考实现）↔ MJCF 执行器序 FR/FL/RR/RL
    expect(adapter.jointNames).toEqual(['FL_hip_joint', 'FL_thigh_joint', 'FL_calf_joint', 'FR_hip_joint', 'FR_thigh_joint', 'FR_calf_joint', 'RL_hip_joint', 'RL_thigh_joint', 'RL_calf_joint', 'RR_hip_joint', 'RR_thigh_joint', 'RR_calf_joint'])
    expect(adapter.modelJointNames).toEqual(['FR_hip_joint', 'FR_thigh_joint', 'FR_calf_joint', 'FL_hip_joint', 'FL_thigh_joint', 'FL_calf_joint', 'RR_hip_joint', 'RR_thigh_joint', 'RR_calf_joint', 'RL_hip_joint', 'RL_thigh_joint', 'RL_calf_joint'])
    expect(adapter.config.default_angles).toEqual([0.1, 0.8, -1.5, -0.1, 0.8, -1.5, 0.1, 1, -1.5, -0.1, 1, -1.5])
    expect([adapter.unit, adapter.controlMode, adapter.rootBody, adapter.engine]).toEqual(['rad', 'position', 'trunk', 'mujoco'])
    // 身份戳与派生件
    expect(adapter.sourceRevision).toBe(source.resolvedRevision)
    expect(adapter.sourceModelId).toBe(source.modelId)
    expect(adapter.sourceProvider).toBe('github')
    expect(adapter.modelSha256).toBe(sha256hex(readFileSync(adapter.modelPath)))
    const xml = readFileSync(adapter.modelPath, 'utf8')
    expect(xml).toContain('kp="20.0"')               // PD 20/0.5 落进派生 MJCF 执行器（str(float(20.0))）
    expect(xml).toContain('kv="0.5"')
    expect(xml).toContain('forcerange="-33.5 33.5"')
    expect(adapter.weightsPath.endsWith('checkpoints/body_latest.jit')).toBe(true)
    expect(adapter.observations.adaptationWeightsPath!.endsWith('checkpoints/adaptation_module_latest.jit')).toBe(true)

    // derived/adapter.json 判别消费：PreparedAdapter 形
    mkdirSync(join(root, 'derived'), { recursive: true })
    writeFileSync(join(root, 'derived/adapter.json'), JSON.stringify(adapter))
    const read = await readAdapter(root)
    expect(isPreparedAdapter(read)).toBe(true)
    expect(isLiberoVlaAdapter(read)).toBe(false)
  }, 60_000)

  test('脚本侧负例：num_observations=69 ⇒ 非零退出（观测拼接 70 ≠ 69），不产 stdout JSON', () => {
    const root = emptyDir(), modelDir = join(root, 'model'), output = join(root, 'out')
    wtwInput(root, { env: { num_observations: 69, num_observation_history: 30, num_actions: 12 } })
    writeGo1Mjcf(modelDir)
    const result = run(PYTHON, [join(import.meta.dir, '../python/prepare_wtw.py'), root, modelDir, output])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('观测拼接')
  }, 60_000)

  test('消费侧缺字段行为：ADAPTER_CONTRACT_MISMATCH 点名路径（不再晚期崩溃）', async () => {
    const root = emptyDir(), modelDir = join(root, 'model'), output = join(root, 'out')
    wtwInput(root)
    writeGo1Mjcf(modelDir)
    const result = run(PYTHON, [join(import.meta.dir, '../python/prepare_wtw.py'), root, modelDir, output])
    expect(result.code).toBe(0)

    const noFrame = JSON.parse(result.stdout)
    delete noFrame.observations.frameDimension
    expect(() => validatePreparedAdapter(noFrame)).toThrow(/ADAPTER_CONTRACT_MISMATCH.*observations\.frameDimension/)

    const noGait = JSON.parse(result.stdout)
    delete noGait.observations.gait.footswingHeightM
    expect(() => validatePreparedAdapter(noGait)).toThrow(/ADAPTER_CONTRACT_MISMATCH.*observations\.gait\.footswingHeightM/)

    const noConfig = JSON.parse(result.stdout)
    delete noConfig.config
    expect(() => validatePreparedAdapter(noConfig)).toThrow(/ADAPTER_CONTRACT_MISMATCH/)

    const wrongDefaults = JSON.parse(result.stdout)
    wrongDefaults.config.default_angles = [0.1, 0.2]
    expect(() => validatePreparedAdapter(wrongDefaults)).toThrow(/ADAPTER_CONTRACT_MISMATCH/)

    expect(() => validatePreparedAdapter({ adapter: 'x' })).toThrow(/ADAPTER_CONTRACT_MISMATCH/)
    await expect(consumePreparedAdapter('not-json', source)).rejects.toThrow(/ADAPTER_STDOUT_NOT_JSON/)
  }, 60_000)
})

// ------------------------------------------------------------- LIBERO 合成输入 -------------------------------------------------------------
/** safetensors 合成写入器（8 字节 LE 头长 + JSON 头 + 小端 F32 数据），值取 float32 可精确表示的 0.25 步进。 */
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
const STATE_MEAN = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75]
const STATE_STD = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75]
const ACTION_MEAN = [-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75]
const ACTION_STD = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
const TARGETS_MEAN = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75]
const TARGETS_STD = [1, 1, 1, 1, 1, 1, 1]
function liberoInput(root: string, options: { dropTensor?: string; actionShape?: number[]; stateMeanDim?: number; omitTrainConfig?: boolean } = {}) {
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    type: 'smolvla',
    input_features: {
      'observation.images.image': { type: 'VISUAL', shape: [3, 256, 256] },
      'observation.images.wrist_image': { type: 'VISUAL', shape: [3, 256, 256] },
      'observation.state': { type: 'STATE', shape: [8] },
    },
    output_features: { action: { type: 'ACTION', shape: options.actionShape ?? [7] } },
    normalization_mapping: { VISUAL: 'IDENTITY', STATE: 'MEAN_STD', ACTION: 'MEAN_STD' },
  }))
  if (!options.omitTrainConfig) writeFileSync(join(root, 'train_config.json'), JSON.stringify({
    batch: 8, steps: 50000,
    policy: {
      num_steps: 10, n_action_steps: 8, chunk_size: 50, vlm_model_name: 'openvla/openvla-smolvlm2-250M',
      tokenizer_max_length: 48, resize_imgs_with_padding: true, max_state_dim: 32, max_action_dim: 32,
    },
  }))
  const stateMean = options.stateMeanDim ? STATE_MEAN.slice(0, options.stateMeanDim) : STATE_MEAN
  const tensors = [
    ...STRUCTURE_TENSORS.map(name => ({ name, shape: [1, 1], data: [0.25] })),
    { name: 'normalize_inputs.buffer_observation_state.mean', shape: [stateMean.length], data: stateMean },
    { name: 'normalize_inputs.buffer_observation_state.std', shape: [8], data: STATE_STD },
    { name: 'normalize_targets.buffer_action.mean', shape: [7], data: TARGETS_MEAN },
    { name: 'normalize_targets.buffer_action.std', shape: [7], data: TARGETS_STD },
    { name: 'unnormalize_outputs.buffer_action.mean', shape: [7], data: ACTION_MEAN },
    { name: 'unnormalize_outputs.buffer_action.std', shape: [7], data: ACTION_STD },
  ].filter(tensor => tensor.name !== options.dropTensor)
  writeSafetensors(join(root, 'model.safetensors'), tensors)
}

describe('prepare_libero_vla.py stdout × LiberoVlaAdapter 消费契约（合成输入实跑，stdlib）', () => {
  test('合成 safetensors/config 实跑 TESTCI_PYTHON ⇒ 消费函数核对 7 维 OSC delta 与归一化统计 round-trip', async () => {
    const root = emptyDir(), output = join(root, 'out')
    liberoInput(root)
    const result = run(SYSTEM_PYTHON, [join(import.meta.dir, '../python/prepare_libero_vla.py'), root, output])
    expect(result.code).toBe(0)

    const adapter = await consumeLiberoVlaAdapter(result.stdout, source)
    expect([adapter.adapter, adapter.policyType, adapter.weightsFile]).toEqual(['libero-smolvla-v1', 'smolvla', 'model.safetensors'])
    expect(adapter.actionDim).toBe(7)                       // 7 维 OSC delta 契约
    expect(adapter.controlMode).toBe('osc_pose_delta')
    expect((adapter.controlSemantics as any).axisNames).toEqual(['world_dx', 'world_dy', 'world_dz', 'world_droll', 'world_dpitch', 'world_dyaw', 'gripper_open_close'])
    expect((adapter.controlSemantics as any).units).toHaveLength(7)
    expect(adapter.frequencyHz).toBe(20)
    expect(adapter.tensorCount).toBe(11)
    expect(adapter.observations.keys).toEqual(['observation.images.image', 'observation.images.wrist_image', 'observation.state'])
    expect(adapter.observations.state.shape).toEqual([8])
    // 归一化统计从 safetensors 缓冲 round-trip（float32 精确值）
    const normalization = adapter.observations.normalization
    expect(normalization.stateMean).toEqual(STATE_MEAN)
    expect(normalization.stateStd).toEqual(STATE_STD)
    expect(normalization.actionMean).toEqual(ACTION_MEAN)    // unnormalize_outputs 缓冲
    expect(normalization.actionStd).toEqual(ACTION_STD)
    expect(normalization.targetsMean).toEqual(TARGETS_MEAN)  // normalize_targets 缓冲
    expect(normalization.targetsStd).toEqual(TARGETS_STD)
    expect(normalization.mapping).toEqual({ VISUAL: 'IDENTITY', STATE: 'MEAN_STD', ACTION: 'MEAN_STD' })
    // train_config policy 子对象读数（上采样/推理口径）
    expect((adapter.inferenceFormat as any).flowSteps).toBe(10)
    expect((adapter.inferenceFormat as any).nActionSteps).toBe(8)
    expect((adapter.inferenceFormat as any).chunkSize).toBe(50)
    expect((adapter.task as any).taskId).toBe('turn_on_the_stove')
    // 身份戳与派生权重哈希
    expect(adapter.sourceRevision).toBe(source.resolvedRevision)
    expect(adapter.sourceModelId).toBe(source.modelId)
    expect(adapter.modelSha256).toBe(sha256hex(readFileSync(adapter.modelPath)))
    expect(adapter.modelPath.endsWith('model.safetensors')).toBe(true)

    // derived/adapter.json 判别消费：LiberoVlaAdapter 形
    mkdirSync(join(root, 'derived'), { recursive: true })
    writeFileSync(join(root, 'derived/adapter.json'), JSON.stringify(adapter))
    const read = await readAdapter(root)
    expect(isLiberoVlaAdapter(read)).toBe(true)
    expect(isPreparedAdapter(read)).toBe(false)
  }, 30_000)

  test('脚本侧负例：错形状/缺张量/坏统计/缺源文件 ⇒ 4/5/6/3 非零退出 + stderr 错误码', () => {
    const script = join(import.meta.dir, '../python/prepare_libero_vla.py')

    const badShape = emptyDir()
    liberoInput(badShape, { actionShape: [6] })
    const r1 = run(SYSTEM_PYTHON, [script, badShape, join(badShape, 'out')])
    expect(r1.code).toBe(4)
    expect(r1.stderr).toContain('LIBERO_VLA_CONTRACT_MISMATCH')

    const missingTensor = emptyDir()
    liberoInput(missingTensor, { dropTensor: 'model.state_proj.weight' })
    const r2 = run(SYSTEM_PYTHON, [script, missingTensor, join(missingTensor, 'out')])
    expect(r2.code).toBe(5)
    expect(r2.stderr).toContain('LIBERO_VLA_TENSOR_MISSING')

    const badStats = emptyDir()
    liberoInput(badStats, { stateMeanDim: 7 })
    const r3 = run(SYSTEM_PYTHON, [script, badStats, join(badStats, 'out')])
    expect(r3.code).toBe(6)
    expect(r3.stderr).toContain('LIBERO_VLA_STATS_INVALID')

    const missingFile = emptyDir()
    liberoInput(missingFile, { omitTrainConfig: true })
    const r4 = run(SYSTEM_PYTHON, [script, missingFile, join(missingFile, 'out')])
    expect(r4.code).toBe(3)
    expect(r4.stderr).toContain('LIBERO_VLA_SOURCE_FILES_MISSING')
  }, 30_000)

  test('消费侧缺字段行为 + matchPolicy 对 VLA 派生件给 ADAPTER_KIND_NOT_EXECUTABLE（不崩）', async () => {
    const root = emptyDir(), output = join(root, 'out')
    liberoInput(root)
    const result = run(SYSTEM_PYTHON, [join(import.meta.dir, '../python/prepare_libero_vla.py'), root, output])
    expect(result.code).toBe(0)
    const raw = JSON.parse(result.stdout)

    const noNormalization = JSON.parse(result.stdout)
    delete noNormalization.observations.normalization
    expect(() => validateLiberoVlaAdapter(noNormalization)).toThrow(/ADAPTER_CONTRACT_MISMATCH.*observations\.normalization/)
    expect(() => validatePreparedAdapter(noNormalization)).toThrow(/ADAPTER_CONTRACT_MISMATCH/)

    // VLA 形 derived/adapter.json 喂 matchPolicy：明确差异，不是 TypeError
    const dataDirectory = emptyDir()
    const derived = join(dataDirectory, 'policies/huggingface/contract__smolvla/deadbeef/derived')
    mkdirSync(derived, { recursive: true })
    writeFileSync(join(derived, 'adapter.json'), JSON.stringify({ ...raw, ...source, modelSha256: 'x' }))
    const scene = { inspect: async () => ({ sceneId: 'scene-1', revision: 3, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' }, entities: [] }) }
    const matched = await matchPolicy({ dataDirectory }, { provider: 'huggingface', modelId: 'contract/smolvla', revision: 'deadbeef', sceneId: 'scene-1', entityId: 'arm' }, scene as any, undefined)
    expect(matched.status).toBe('BLOCKED')
    const difference: any = matched.differences.find((row: any) => row.reason === 'ADAPTER_KIND_NOT_EXECUTABLE')
    expect(difference?.actual?.actionDim).toBe(7)
    expect(difference?.actual?.executionRoute).toContain('bench_step')
    expect(matched.vlaAdapter?.adapter).toBe('libero-smolvla-v1')
  }, 30_000)
})
