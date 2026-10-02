/**
 * L412 · Go1/WTW **身份分支派发**回归（网络无关）：把「权重已在本机、`prepare` 却抛
 * `POLICY_ADAPTER_UNAVAILABLE`」这一类缺陷钉住。
 *
 * 起因（09-22 历史判定）：`packages/policy-registry/src/adapter.ts` 的 `preparePolicy` 只按**字面身份**
 * 派发，当时只有 Go2/G1 两条分支 —— WTW 的权重校验通过之后**没有第三条身份分支**，于是落到最后一行
 * `POLICY_ADAPTER_UNAVAILABLE`（不是下载失败、不是校验失败）。本用例用**合成 pkl + 最小 Go1 MJCF**
 * 在**产品布局的策略缓存**里造出一个 `DOWNLOADED` 的 WTW 快照，直接调 `preparePolicy`：
 *   - 正向：必须命中 WTW 分支 → `PREPARED` + `wtw-go1-torchscript-v1` + 策略序/频率/70×30 契约；
 *   - 负例 1：登记的 modelId 但请求一个**没有 manifest 的 revision** ⇒ `POLICY_FILES_NOT_VERIFIED`
 *     （证明失败点与「缺适配器」不是同一个）；
 *   - 负例 2：一个**已下载但未登记**的 github 来源 ⇒ `POLICY_ADAPTER_UNAVAILABLE`
 *     （证明派发按身份、不借用同族适配器）。
 *
 * 解释器：`prepare_wtw.py` 需要 mujoco+numpy ⇒ 用产品策略 python（`pythonPath()`）。
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preparePolicy, pythonPath } from '../src/adapter.ts'
import { matchPolicy } from '../src/match.ts'
import { IMPLEMENTED_POLICY_ADAPTERS } from '../src/pack-contract.ts'
import { hashFile, policyDirectory, type PolicySource } from '../src/source.ts'

const PYTHON = pythonPath()
const SYSTEM_PYTHON = process.env.TESTCI_PYTHON?.trim() || 'python3'
const emptyDir = () => mkdtempSync(join(tmpdir(), 'wtw-identity-'))

const WTW = IMPLEMENTED_POLICY_ADAPTERS.find((row) => row.id === 'wtw-go1-torchscript-v1')!
const WTW_BASE = 'runs/gait-conditioned-agility/pretrain-v0/train/025417.456545'

/** 语义取值与真实 pkl 读数同源（见 adapter-contract.test.ts 的 wtwCfg 注释）。 */
const wtwCfg = () => ({
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
})

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
    `<mujoco model="go1-identity-synthetic"><compiler meshdir="assets"/><option timestep="0.005"/>\n` +
    `<worldbody><body name="trunk" pos="0 0 0.445"><freejoint name="floating_base"/>` +
    `<geom name="trunk_geom" type="box" size="0.1 0.05 0.03" mass="4.7"/>${bodies}</body></worldbody>\n` +
    `<actuator>${actuators}</actuator></mujoco>\n`)
}

/** 在产品布局的策略缓存里造一个 DOWNLOADED 的合成快照（manifest.files 的 bytes/sha256 都是**实测**值）。 */
async function seedCache(dataDirectory: string, provider: PolicySource, modelId: string, revision: string, resolvedRevision: string, files: string[]) {
  const root = policyDirectory(dataDirectory, provider, modelId, revision)
  const base = join(root, WTW_BASE)
  mkdirSync(join(base, 'checkpoints'), { recursive: true })
  const cfgPath = join(root, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(wtwCfg()))
  execFileSync(SYSTEM_PYTHON, ['-c', 'import json,pickle,sys; pickle.dump({"Cfg": json.load(open(sys.argv[1]))}, open(sys.argv[2],"wb"))', cfgPath, join(base, 'parameters.pkl')])
  writeFileSync(join(base, 'checkpoints/body_latest.jit'), 'synthetic-torchscript-body')
  writeFileSync(join(base, 'checkpoints/adaptation_module_latest.jit'), 'synthetic-torchscript-adaptation')
  const entries = []
  for (const path of files) {
    const actual = await hashFile(join(root, path))
    entries.push({ path, bytes: actual.bytes, sha256: actual.sha256, revision: resolvedRevision, url: `https://raw.githubusercontent.com/${modelId}/${resolvedRevision}/${path}` })
  }
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({
    status: 'DOWNLOADED', provider, modelId, revision, resolvedRevision,
    metadata: { provider, id: modelId, revision: resolvedRevision }, sourceFiles: entries, files: entries, transfers: [],
    execution: { status: 'BLOCKED', reason: '需匹配真实输入、动作语义和world版本后显式执行' }, updatedAt: new Date().toISOString(),
  }, null, 2) + '\n')
  return root
}

const failureOf = async (run: Promise<unknown>) => { try { await run } catch (error) { return String((error as Error).message) } throw new Error('期望失败，但它成功了') }

describe('L412 · Go1/WTW 身份分支派发（合成缓存实跑 preparePolicy）', () => {
  // 本用例实跑 prepare_wtw.py（mujoco 建模 + 两次物理量对账），本机常态 ~4–5 s；bun 默认 5 s 超时在
  // 并发负载下会假红 ⇒ 显式放到 60 s（**不放松任何断言**，只给足执行时间）。
  test('登记的 Go1/WTW 来源 ⇒ 命中 WTW 分支：PREPARED + 策略序/50Hz/70×30 契约 + 可加载模型路径', async () => {
    const dataDirectory = emptyDir(), modelDir = join(dataDirectory, 'model')
    writeGo1Mjcf(modelDir)
    await seedCache(dataDirectory, 'github', WTW.modelId, WTW.revision, WTW.revision, WTW.requires.files)

    const prepared = await preparePolicy(dataDirectory, { provider: 'github', modelId: WTW.modelId, revision: WTW.revision, robotModelPath: modelDir }, PYTHON)
    expect(prepared.status).toBe('PREPARED')
    const adapter = prepared.adapter
    expect(adapter.adapter).toBe('wtw-go1-torchscript-v1')
    // 策略 dof 序 = deploy 参考序 FL/FR/RL/RR × (hip,thigh,calf)（不是资产序、不是 pkl 字典序）
    expect(adapter.jointNames).toEqual(['FL_hip_joint', 'FL_thigh_joint', 'FL_calf_joint', 'FR_hip_joint', 'FR_thigh_joint', 'FR_calf_joint', 'RL_hip_joint', 'RL_thigh_joint', 'RL_calf_joint', 'RR_hip_joint', 'RR_thigh_joint', 'RR_calf_joint'])
    expect(adapter.frequencyHz).toBe(50)
    expect(adapter.config.control_decimation).toBe(4)
    expect(adapter.config.simulation_dt).toBe(0.005)
    expect(adapter.config.action_scale).toBe(0.25)
    expect(adapter.config.clip_actions).toBe(10)
    expect(adapter.config.hip_action_indices).toEqual([0, 3, 6, 9])
    expect(adapter.config.hip_scale_reduction).toBe(0.5)
    // 观测契约：70 维 × 30 帧历史 = 2100，两级推理（body + adaptation_module）
    expect(adapter.observations.shape).toEqual([70])
    expect(adapter.observations.frameDimension).toBe(70)
    expect(adapter.observations.historyFrames).toBe(30)
    expect(adapter.observations.inference).toBe('torchscript-adaptation')
    expect(adapter.config.num_obs_history).toBe(2100)
    // 步态命令逐项来自 deploy get_command()（trot：phase 0.5 / freq 3.0 / footswing 0.08 / stance 0.33×0.40）
    expect(adapter.observations.gait).toMatchObject({ phase: 0.5, frequencyHz: 3.0, footswingHeightM: 0.08, stanceWidthM: 0.33, stanceLengthM: 0.40 })
    expect(adapter.observations.gaitCommandScale).toHaveLength(15)
    // 身份戳按来源写；派生件与场景组件都指向**本次派生的**模型绝对路径
    expect(adapter.sourceModelId).toBe(WTW.modelId)
    expect(adapter.sourceRevision).toBe(WTW.revision)
    expect(adapter.modelSourcePath).toContain('go1.xml')
    expect(prepared.path).toBe(join(policyDirectory(dataDirectory, 'github', WTW.modelId, WTW.revision), 'derived/adapter.json'))
    expect(prepared.components.mujoco.sourcePath).toBe(adapter.modelPath)
    expect(prepared.components.mujoco.rootBody).toBe('trunk')
    expect(prepared.components.sensor.policyObservations).toEqual(adapter.observations)
    expect(prepared.worldOptions).toEqual({ clock: 'manual', timestepS: 0.005, ground: true })
    // ISAAC 引擎声明（本轮修复）——声明面与组件面在同一处对账：
    //   · `supportedEngines` 必须有 isaac：`match.ts:77` 按 `adapter.supportedEngines ?? [adapter.engine]`
    //     判 `SIMULATOR_MISMATCH`，只有 `["mujoco"]` 时 Isaac world 恒被挡（P13 实测 Go1 那一格）；
    //   · `components.isaac.sourcePath` 必须是**真路径**：`match.ts:93` 取
    //     `components[world.engineId].sourcePath` 做哈希，缺键时 `hashFile(undefined)` 变
    //     `ENOENT: …open '…/Dev/undefined'` ⇒ `ROBOT_PHYSICS_MODEL_UNREADABLE`（P13 实测第二条差异）。
    expect(adapter.engine).toBe('mujoco')            // 原生格式仍是 MJCF：不靠改 engine 绕过判据
    expect(adapter.supportedEngines).toEqual(['mujoco', 'isaac'])
    expect(prepared.components.isaac).toMatchObject({ sourcePath: adapter.modelPath })
    expect(prepared.components.isaac.sourcePath).toBe(prepared.components.mujoco.sourcePath)
    expect(existsSync(prepared.components.isaac.sourcePath)).toBe(true)
    // isaac 适配层真读的那两个键必须与 mujoco 组件逐字段同值（`scene_adapter.py:246` 覆盖 `joints[].home`，
    // `worker.py:467` 用它设 Isaac articulation 的初始 DOF 位置/目标）——否则"同一份派生模型"两个引擎的
    // 初始状态会不一致。`keyframe` 不得凭空生出（本派生件没有 WTW 专用关键帧）。
    expect(prepared.components.isaac.initialJointPositions).toEqual(prepared.components.mujoco.initialJointPositions)
    expect(prepared.components.isaac.rootBody).toBe(prepared.components.mujoco.rootBody)
    expect(Object.hasOwn(prepared.components.isaac, 'keyframe')).toBe(false)
  }, 60_000)

  test('负例 1：登记的 modelId 但该 revision 无 manifest ⇒ POLICY_FILES_NOT_VERIFIED（不是“缺适配器”）', async () => {
    const dataDirectory = emptyDir()
    writeGo1Mjcf(join(dataDirectory, 'model'))
    await seedCache(dataDirectory, 'github', WTW.modelId, WTW.revision, WTW.revision, WTW.requires.files)

    const message = await failureOf(preparePolicy(dataDirectory, { provider: 'github', modelId: WTW.modelId, revision: '0'.repeat(40) }, PYTHON))
    expect(message.startsWith('POLICY_FILES_NOT_VERIFIED')).toBe(true)
    expect(message.includes('POLICY_ADAPTER_UNAVAILABLE')).toBe(false)
  })

  test('负例 2：已下载但未登记的 github 来源 ⇒ POLICY_ADAPTER_UNAVAILABLE（按身份派发，不借同族适配器）', async () => {
    const dataDirectory = emptyDir()
    await seedCache(dataDirectory, 'github', 'unregistered/not-a-policy', 'master', 'master', ['cfg.json'])

    const message = await failureOf(preparePolicy(dataDirectory, { provider: 'github', modelId: 'unregistered/not-a-policy', revision: 'master' }, PYTHON))
    expect(message.startsWith('POLICY_ADAPTER_UNAVAILABLE')).toBe(true)
  })

  test('台账对账：Go1/WTW 已登记且 pin 与派发分支一致（modelId/revision/entry/pack）', () => {
    expect(WTW.adapter).toBe('torchscript')
    expect(WTW.revision).toBe('0e7236bdc81ce855cbe3d70345a7899452bdeb1c')
    expect(WTW.modelId).toBe('Improbable-AI/walk-these-ways')
    expect(WTW.entry).toBe('python/prepare_wtw.py')
    expect(WTW.packs).toContain('unitree_go1')
    expect(WTW.requires.files).toEqual([
      `${WTW_BASE}/checkpoints/body_latest.jit`,
      `${WTW_BASE}/checkpoints/adaptation_module_latest.jit`,
      `${WTW_BASE}/parameters.pkl`,
    ])
  })
})

/**
 * ISAAC 引擎声明 · `matchPolicy` 真判据（网络无关，全走产品通路）。
 *
 * P13 实测（`bugfixHistory/ISAAC-14B-STEP4-20260926.md` §4.2）Go1 在 Isaac world 上被**两条**差异挡住：
 *
 * ```
 * {"path":"world.engineId","reason":"SIMULATOR_MISMATCH","expected":["mujoco"],"actual":"isaac"}
 * {"path":"model","reason":"ROBOT_PHYSICS_MODEL_UNREADABLE","actual":"ENOENT: …open '…/Dev/undefined'"}
 * ```
 *
 * 这两条的成因分别是 `prepare_wtw.py` 的 `supportedEngines` 与 `adapter.ts` WTW 分支缺
 * `components.isaac`。本组用**同一份派生件**（真跑 `prepare_wtw.py` 得到的 `derived/adapter.json`）
 * 加一个 Isaac world 桩来判：
 *   1. 正向 ⇒ `MATCHED` / `differences: []`（两条差异都不出现）；
 *   2. 判据化①：场景缺 `components.isaac` ⇒ **必然** `ROBOT_PHYSICS_MODEL_UNREADABLE`；
 *   3. 判据化②：把 `supportedEngines` 改回 `["mujoco"]`（其余字节不动）⇒ **必然** `SIMULATOR_MISMATCH`。
 *
 * 桩只替代**引擎**（`SimWorlds` 的三个读法），引擎之外的一切（manifest 校验 / 派生件读取 / sha 判据 /
 * 对账逻辑）都是产品自己的代码——不 mock 产品函数。
 */
const ISAAC_SCENE_ID = 'wtw-go1-isaac-scene'
const ISAAC_ENTITY_ID = 'unitree_go1-policy'
const ISAAC_WORLD_ID = 'wtw-go1-isaac-world'
const ISAAC_GENERATION = 7
const ISAAC_SCENE_REVISION = 3

/** 场景句柄：components 直接用产品 `preparePolicy` 返回的那一份（可整键删掉做判据化①）。 */
const isaacScene = (components: Record<string, any>) => ({
  inspect: () => ({
    sceneId: ISAAC_SCENE_ID, revision: ISAAC_SCENE_REVISION,
    coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' },
    entities: [{
      entityId: ISAAC_ENTITY_ID, name: ISAAC_ENTITY_ID,
      transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      resources: [], components,
    }],
  }),
})

/** Isaac world 桩：只有 listWorlds/describe/observe 三个读法，字段口径照 P13 的真机回执写。 */
const isaacSim = (adapter: any) => {
  const world = {
    worldId: ISAAC_WORLD_ID, sceneId: ISAAC_SCENE_ID, engineId: 'isaac', engineVersion: '6.0.1.0',
    appliedSceneRevision: ISAAC_SCENE_REVISION, worldGeneration: ISAAC_GENERATION,
    clock: 'manual', timestepS: adapter.config.simulation_dt, status: 'ready', warnings: [],
  }
  const names: string[] = adapter.modelJointNames
  return {
    listWorlds: async () => [world],
    describe: async () => ({
      entityId: ISAAC_ENTITY_ID, expectedGeneration: ISAAC_GENERATION, controlledJointNames: [...names],
      controller: { frequencyHz: adapter.frequencyHz, controlMode: adapter.controlMode, gravityCompensation: false },
      joints: names.map((name) => ({ name, unit: 'rad', controlMode: 'position' })),
    }),
    observe: async () => ({
      generation: ISAAC_GENERATION, sceneRevision: ISAAC_SCENE_REVISION, simTime: 0, stepIndex: 0,
      entities: [{
        entityId: ISAAC_ENTITY_ID,
        joints: { names: [...names], positions: names.map(() => 0), velocities: names.map(() => 0) },
        sensors: { freeBase: { quaternionXyzw: [0, 0, 0, 1], angularVelocityLocalRadps: [0, 0, 0] } },
      }],
    }),
  }
}

const matchIsaac = async (dataDirectory: string, components: Record<string, any>, adapter: any) =>
  matchPolicy({ dataDirectory },
    { provider: 'github', modelId: WTW.modelId, revision: WTW.revision, sceneId: ISAAC_SCENE_ID, entityId: ISAAC_ENTITY_ID, worldId: ISAAC_WORLD_ID, expectedGeneration: ISAAC_GENERATION } as never,
    isaacScene(components) as never, isaacSim(adapter) as never)

describe('ISAAC 引擎声明 · prepare_wtw.py supportedEngines + adapter.ts components.isaac（matchPolicy 真判据）', () => {
  /** 每次都新派生一份（`preparePolicy` 写 derived/adapter.json，判据化②要另立一份改过的副本）。 */
  async function preparedGo1() {
    const dataDirectory = emptyDir(), modelDir = join(dataDirectory, 'model')
    writeGo1Mjcf(modelDir)
    await seedCache(dataDirectory, 'github', WTW.modelId, WTW.revision, WTW.revision, WTW.requires.files)
    const prepared = await preparePolicy(dataDirectory, { provider: 'github', modelId: WTW.modelId, revision: WTW.revision, robotModelPath: modelDir }, PYTHON)
    return { dataDirectory, prepared }
  }

  test('正向：Isaac world + 产品派生件 ⇒ MATCHED，differences 空（P13 那两条差异都不出现）', async () => {
    const { dataDirectory, prepared } = await preparedGo1()
    const result = await matchIsaac(dataDirectory, prepared.components, prepared.adapter)
    expect(result.differences).toEqual([])
    expect(result.status).toBe('MATCHED')
    expect(result.execution.status).toBe('READY')
    // 反向确认引擎判据真的被行使过：world.engineId 确实是 isaac，而不是没读到 world 才"没差异"
    expect(result.differences.find((row: any) => row.reason === 'SIMULATOR_MISMATCH')).toBeUndefined()
    expect(result.differences.find((row: any) => row.reason === 'ROBOT_PHYSICS_MODEL_UNREADABLE')).toBeUndefined()
  }, 60_000)

  test('判据化①：场景缺 components.isaac ⇒ ROBOT_PHYSICS_MODEL_UNREADABLE（缺口存在时必然失败）', async () => {
    const { dataDirectory, prepared } = await preparedGo1()
    const withoutIsaac = { ...prepared.components } as Record<string, any>
    delete withoutIsaac.isaac
    const result = await matchIsaac(dataDirectory, withoutIsaac, prepared.adapter)
    expect(result.status).toBe('BLOCKED')
    const difference = result.differences.find((row: any) => row.path === 'model')
    expect(difference?.reason).toBe('ROBOT_PHYSICS_MODEL_UNREADABLE')
    // 差异原文里必须能看见 `undefined`（就是 P13 的 `…open '…/Dev/undefined'`），不是别的原因
    expect(String(difference?.actual)).toContain('undefined')
  }, 60_000)

  test('判据化②：supportedEngines 回退为 ["mujoco"]（其余字节不动）⇒ SIMULATOR_MISMATCH', async () => {
    const { dataDirectory, prepared } = await preparedGo1()
    // 整根拷贝（manifest 与权重字节不变 ⇒ verifyPolicy 照旧通过），只改派生件里那一行声明
    const rolledBack = emptyDir()
    cpSync(dataDirectory, rolledBack, { recursive: true })
    const derivedPath = join(policyDirectory(rolledBack, 'github', WTW.modelId, WTW.revision), 'derived', 'adapter.json')
    const derived = JSON.parse(readFileSync(derivedPath, 'utf8'))
    expect(derived.supportedEngines).toEqual(['mujoco', 'isaac'])   // 改之前先确认读到的就是修复后的值
    derived.supportedEngines = ['mujoco']
    writeFileSync(derivedPath, JSON.stringify(derived, null, 2) + '\n')

    const result = await matchIsaac(rolledBack, prepared.components, prepared.adapter)
    expect(result.status).toBe('BLOCKED')
    const difference = result.differences.find((row: any) => row.path === 'world.engineId')
    expect(difference).toMatchObject({ reason: 'SIMULATOR_MISMATCH', expected: ['mujoco'], actual: 'isaac' })
    // 判据化②只该带回这一条：`components.isaac` 仍在 ⇒ 模型哈希判据仍成立（两条成因彼此独立）
    expect(result.differences.find((row: any) => row.reason === 'ROBOT_PHYSICS_MODEL_UNREADABLE')).toBeUndefined()
  }, 60_000)
})
