/**
 * DEV-028 条件③（M1/M2）判据夹具：**产品侧 VLA 派生件 ＋ 官方套件 world** 的契约形状，单一来源。
 * 供 `test/vla-route-match-exec.test.ts` 与 `.runtime/lane-vla-route418/probe-match.ts` 共用。
 *
 * 派生件**不是手写桩**：由产品自己的 `python/prepare_libero_vla.py` 在合成 safetensors/config 上实跑产出
 * （与 `test/adapter-contract.test.ts` 的 `liberoInput` 同一手法），再经 `src/adapter.ts` 的
 * `consumeLiberoVlaAdapter` 补身份戳 —— 即产品 `policy_prepare` 的 `derived/adapter.json` 产物形状。
 *
 * 官方 world / describe / frame 的字段值逐条取自 `packages/benchmark-libero/src/catalog.ts:176-205` 的
 * `officialTaskSpec` 与 `src/operations.ts:556-579` 的 `describe()`（只读引用，**不 import 该包**，不新增包依赖）。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { consumeLiberoVlaAdapter, type LiberoVlaAdapter } from '../src/adapter.ts'

const SYSTEM_PYTHON = process.env.TESTCI_PYTHON?.trim() || 'python3'
const PREPARE = join(import.meta.dir, '../python/prepare_libero_vla.py')
/** Node协议桩也需响应新的Python依赖预检；这是假模块报文，不签真实VLA运行时。 */
export const runtimeProbeStub=`if(process.argv.includes('-c')){const modules=JSON.parse(process.argv.at(-1));console.log(JSON.stringify({modules,missingModules:[],versions:Object.fromEntries(modules.map(n=>[n,'fixture'])),moduleFiles:Object.fromEntries(modules.map(n=>[n,'/fixture/'+n+'/__init__.py'])),pythonPrefix:'/fixture'}));process.exit(0)}\n`

/** 夹具身份：官方 pin（`src/adapter.ts:37-38` 的 LIBERO_SMOLVLA_ID / LIBERO_SMOLVLA_REVISION 同值）。 */
export const VLA_IDENTITY = {
  provider: 'huggingface' as const,
  modelId: 'k1000dai/smolvla_libero_finetune',
  revision: '492ac1c5f1b7808c444fae37b75a84fdeb15e70d',
  sceneId: 'libero_goal/turn_on_the_stove',
  entityId: 'official-robot',
  worldId: 'bench-world-1',
}

/** `benchmark-libero/src/catalog.ts:183-190` 的 `task.action` 原文（`describe()` 原样返回这几个字段）。 */
export const OFFICIAL_ACTION = {
  kind: 'controller',
  dimensions: 7,
  units: [
    'normalized world dx [-1,1] -> ±0.05 m', 'normalized world dy [-1,1] -> ±0.05 m', 'normalized world dz [-1,1] -> ±0.05 m',
    'normalized world droll [-1,1] -> ±0.5 rad', 'normalized world dpitch [-1,1] -> ±0.5 rad', 'normalized world dyaw [-1,1] -> ±0.5 rad',
    'gripper open_close [-1,1]',
  ],
  lower: [-1, -1, -1, -1, -1, -1, -1],
  upper: [1, 1, 1, 1, 1, 1, 1],
  controlFrequencyHz: 20,
  coordinateFrame: 'world-frame Cartesian position delta and world-frame axis-angle delta',
  axisNames: ['controller_dx', 'controller_dy', 'controller_dz', 'controller_droll', 'controller_dpitch', 'controller_dyaw', 'gripper_open_close'],
}
/** `catalog.ts:182` 的 `task.observation`（`describe().controller.observationFields` 的来源）。 */
export const OFFICIAL_OBSERVATION_FIELDS = ['agentview_image', 'robot0_eef_pos', 'robot0_eef_quat', 'robot0_gripper_qpos', 'robot0_joint_pos', 'objects.*_pos', 'objects.*_quat', 'objects.*_to_robot0_eef_pos', 'objects.*_to_robot0_eef_quat']

// ------------------------------------------------------------- 合成 LIBERO 源 + 产品派生件 -------------------------------------------------------------
/** safetensors 合成写入器（8 字节 LE 头长 + JSON 头 + 小端 F32 数据）。 */
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

/** 合成 SmolVLA 快照（config.json / train_config.json / model.safetensors），字段同 `catalog` 与真 pin 形状。
 *  `nActionSteps` 默认取真 pin 的读数（config.json 与 train_config.json 均为 50；任务书写 10，以检查点为准）。 */
export function writeSyntheticVlaSource(root: string, options: { nActionSteps?: number } = {}) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    type: 'smolvla',
    input_features: {
      'observation.images.image': { type: 'VISUAL', shape: [3, 256, 256] },
      'observation.images.wrist_image': { type: 'VISUAL', shape: [3, 256, 256] },
      'observation.state': { type: 'STATE', shape: [8] },
    },
    output_features: { action: { type: 'ACTION', shape: [7] } },
    normalization_mapping: { VISUAL: 'IDENTITY', STATE: 'MEAN_STD', ACTION: 'MEAN_STD' },
    n_action_steps: options.nActionSteps ?? 50,
  }))
  writeFileSync(join(root, 'train_config.json'), JSON.stringify({
    batch: 8, steps: 50000,
    policy: {
      num_steps: 10, n_action_steps: options.nActionSteps ?? 50, chunk_size: 50, vlm_model_name: 'openvla/openvla-smolvlm2-250M',
      tokenizer_max_length: 48, resize_imgs_with_padding: true, max_state_dim: 32, max_action_dim: 32,
    },
  }))
  writeSafetensors(join(root, 'model.safetensors'), [
    ...STRUCTURE_TENSORS.map(name => ({ name, shape: [1, 1], data: [0.25] })),
    { name: 'normalize_inputs.buffer_observation_state.mean', shape: [8], data: STATE_MEAN },
    { name: 'normalize_inputs.buffer_observation_state.std', shape: [8], data: STATE_STD },
    { name: 'normalize_targets.buffer_action.mean', shape: [7], data: TARGETS_MEAN },
    { name: 'normalize_targets.buffer_action.std', shape: [7], data: TARGETS_STD },
    { name: 'unnormalize_outputs.buffer_action.mean', shape: [7], data: ACTION_MEAN },
    { name: 'unnormalize_outputs.buffer_action.std', shape: [7], data: ACTION_STD },
  ])
}

/** 用产品自己的 `prepare_libero_vla.py` 产出派生契约（纯 stdlib，`TESTCI_PYTHON` 实跑），再补产品身份戳。 */
export async function produceVlaAdapter(root: string): Promise<LiberoVlaAdapter> {
  writeSyntheticVlaSource(root)
  const stdout = execFileSync(SYSTEM_PYTHON, [PREPARE, root, join(root, 'out')], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  return consumeLiberoVlaAdapter(stdout, { resolvedRevision: VLA_IDENTITY.revision, modelId: VLA_IDENTITY.modelId, provider: VLA_IDENTITY.provider })
}

/** 在 `<dataDirectory>` 下装配**已校验的策略快照**：manifest(DOWNLOADED) + 源件 + `derived/adapter.json`。
 *  返回产品 `policyDirectory()` 解析到的同一路径（`src/source.ts:39` 的布局）。 */
export async function writeVlaSnapshot(dataDirectory: string, options: { adapterOverride?: Record<string, unknown> } = {}) {
  const root = join(dataDirectory, 'policies', 'huggingface', 'k1000dai__smolvla_libero_finetune', VLA_IDENTITY.revision)
  mkdirSync(join(root, 'derived'), { recursive: true })
  const adapter = await produceVlaAdapter(join(root, 'source'))
  for (const name of ['config.json', 'train_config.json', 'model.safetensors']) {
    const bytes = readFileSync(join(root, 'source', name))
    writeFileSync(join(root, name), bytes)
  }
  const files = ['config.json', 'train_config.json', 'model.safetensors'].map(name => {
    const bytes = readFileSync(join(root, name))
    return { path: name, bytes: bytes.byteLength, revision: VLA_IDENTITY.revision, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({
    status: 'DOWNLOADED', provider: VLA_IDENTITY.provider, modelId: VLA_IDENTITY.modelId, revision: VLA_IDENTITY.revision,
    resolvedRevision: VLA_IDENTITY.revision, updatedAt: '2026-09-23T00:00:00.000Z', files,
  }, null, 2) + '\n')
  writeFileSync(join(root, 'derived', 'adapter.json'), JSON.stringify({ ...adapter, ...(options.adapterOverride ?? {}) }, null, 2) + '\n')
  return { root, adapter }
}

// ------------------------------------------------------------- 官方套件 provider 桩 -------------------------------------------------------------
const toRad = (quaternion: number[]) => quaternion

/** 官方 `describe()`（`packages/benchmark-libero/src/operations.ts:556-579` 的返回值形状）。 */
export function officialDescription(overrides: { controller?: Record<string, unknown> } = {}) {
  return {
    entityId: VLA_IDENTITY.entityId,
    modelVersion: 'libero-panda-osc-pose',
    expectedGeneration: 1,
    collisionContextVersion: VLA_IDENTITY.sceneId,
    joints: [1, 2, 3, 4, 5, 6, 7].map(index => ({ name: `robot0_joint${index}`, type: 'hinge' as const, unit: 'rad' as const })),
    controlledJointNames: [1, 2, 3, 4, 5, 6, 7].map(index => `robot0_joint${index}`),
    controller: {
      controlMode: 'official-controller', kind: OFFICIAL_ACTION.kind, dimensions: OFFICIAL_ACTION.dimensions,
      units: OFFICIAL_ACTION.units, lower: OFFICIAL_ACTION.lower, upper: OFFICIAL_ACTION.upper,
      frequencyHz: OFFICIAL_ACTION.controlFrequencyHz, coordinateFrame: OFFICIAL_ACTION.coordinateFrame,
      axisNames: OFFICIAL_ACTION.axisNames, observationFields: OFFICIAL_OBSERVATION_FIELDS, gripper: { maxWidthM: 0.08 },
      ...(overrides.controller ?? {}),
    },
  }
}

/** 官方 world 句柄（`canonicalWorldHandle`：engineId='official-suite'，`operations.ts:16`）。 */
export function officialWorld(overrides: Record<string, unknown> = {}) {
  return {
    worldId: VLA_IDENTITY.worldId, sceneId: VLA_IDENTITY.sceneId, appliedSceneRevision: 1, worldGeneration: 1,
    engineId: 'official-suite', clock: 'manual', timestepS: 1 / OFFICIAL_ACTION.controlFrequencyHz, status: 'running', ...overrides,
  }
}

/** 官方 Scene 投影（含被匹配实体；`projection.ts:153-162` 保证实体带 `components`，但**不保证**
 *  `components.sensor.policyObservations` 或 `components[engineId].sourcePath` —— 这正是 VLA 判据不能
 *  沿用关节级 `PreparedAdapter` 对账的原因）。 */
export function officialScene(sceneId = VLA_IDENTITY.sceneId, revision = 1) {
  return {
    sceneId, revision, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' },
    entities: [{
      entityId: VLA_IDENTITY.entityId, transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      joints: { names: [1, 2, 3, 4, 5, 6, 7].map(index => `robot0_joint${index}`), positions: [0, 0, 0, 0, 0, 0, 0], velocities: [0, 0, 0, 0, 0, 0, 0] },
      components: { mujoco: { jointNames: [1, 2, 3, 4, 5, 6, 7].map(index => `robot0_joint${index}`) } },
    }],
  }
}

/** 官方 Frame（`python/worker.py:492-500` 的 sensors 口径；图像给真实落盘路径）。 */
export function officialFrame(overrides: Record<string, unknown> = {}, imageDirectory = '/tmp/libero-frame') {
  return {
    worldId: VLA_IDENTITY.worldId, generation: 1, stepIndex: 0, simTime: 0, sceneRevision: 1, frameId: 'frame-0',
    entities: [{
      entityId: VLA_IDENTITY.entityId, transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      joints: { names: [1, 2, 3, 4, 5, 6, 7].map(index => `robot0_joint${index}`), positions: [0, 0, 0, 0, 0, 0, 0], velocities: [0, 0, 0, 0, 0, 0, 0] },
      sensors: {
        eefPositionM: [0.1, 0.2, 0.85], eefQuaternionXyzw: toRad([0, 0, 0, 1]), gripperQpos: [0.02, -0.02],
        agentview_image: { path: join(imageDirectory, 'step-0000.png'), mimeType: 'image/png' },
        wrist_image: { path: join(imageDirectory, 'step-0000-wrist.png'), mimeType: 'image/png' },
        source: 'official-env', fields: ['robot0_eef_pos', 'robot0_eef_quat', 'robot0_gripper_qpos', 'objects'],
      },
    }],
    ...overrides,
  }
}

/** `policy_match`/`policy_execute` 的场景句柄（公开读法只有 `inspect`）。 */
export const sceneHandle = (snapshot: Record<string, unknown>) => ({ inspect: async (_sceneId: string) => snapshot as any })

/** 官方套件 provider 的最小桩：listWorlds/describe/observe 三件（match 只读这三件 + execute/stop）。 */
export function simStub(options: { world?: any; description?: any; frame?: any; execute?: (worldId: string, action: any) => any } = {} as any) {
  const world = options.world ?? officialWorld()
  const description = options.description ?? officialDescription()
  const frame = options.frame ?? officialFrame()
  return {
    listWorlds: async () => [world],
    describe: async () => description,
    observe: async () => frame,
    execute: options.execute,
    stop: async () => ({ stopped: true, stepIndex: 0, receipts: [] }),
  }
}
