/**
 * DEV-008／W5：Newton 的"自报"与"实际"必须逐条对得上（真机 worker，无 CUDA 也要如实）。
 *
 * 本文件钉三件事（都是**真实读数**，不是"代码已写"）：
 *  1. 自报↔实际：`ready`／`capabilities` 里声明为 unsupported 的能力，运行时必须按**同一个码**拒绝；
 *     7 个未接通动作 kind 逐个 ACTION_UNSUPPORTED，7 个方法级能力逐个 UNSUPPORTED_CAPABILITY，
 *     `observe.contacts` 与 `collisionPatches`（open/sync）同样按声明的码拒绝。
 *  2. 能力范围事先说清：`describe().capabilities` 覆盖合同 `RobotCapability.kind` 的**共享 8 元组**
 *     （thrust/vehicle/joint/gripper/lift/control），逐源可用性并给原因；`controlMetadata`
 *     说明 controlledJointNames 为什么恒为空。少一条就是"等用户点了才报错"。
 *  3. 设备降级如实：设备真值（直接问 warp）为空时 auto 必须 degraded=true 且 note 说明"降级到 cpu"；
 *     显式 cpu 不是降级；显式 cuda:0 在无 CUDA 时**明确拒绝**（world 选项 → UNSUPPORTED_CAPABILITY；
 *     环境变量 → 结构化 fatal + 退出码 2），绝不静默顶替。
 *
 * 需要真实 Newton 环境（`.runtime/newton-env/bin/python`）；缺失即整体 skip（不假装通过）。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NewtonProvider } from '../src/provider.ts'
import { ROBOT_CAPABILITY_KINDS } from '../../sim-contract/src/index.ts'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSdkPython } from '../../lyapunov-product-bundle/src/sdk-python.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEV = resolve(HERE, '../../..')
const PYTHON = resolveSdkPython(DEV, 'newton').python
// 默认就是本包真机 worker；`LYAPUNOV_NEWTON_WORKER_PATH` 只用于把这个矩阵指向另一份 worker 副本
// （本条的负对照＝指向"改前"副本，验证测试真的会红；不是产品开关）。
const WORKER = process.env.LYAPUNOV_NEWTON_WORKER_PATH ?? join(DEV, 'packages/sim-newton/python/worker.py')
const ARM = join(DEV, 'packages/sim-mujoco/fixtures/arm.xml')
const available = existsSync(PYTHON)

/**
 * **强制"无 CUDA"的隔离环境**（GATE-AB-20260927）：`CUDA_VISIBLE_DEVICES=''` 是 CUDA 官方认可的
 * "把全部设备隐藏起来"的手段，`NVIDIA_VISIBLE_DEVICES=''` 覆盖容器侧同一语义。
 *
 * 为什么需要它：设备降级这一组（auto 降级 / 显式 cpu / 显式 cuda:0 拒绝）原来靠宿主"恰好没有 CUDA"
 * 才跑——GPU 主机上两个负对照直接 `return`，实测 expect 从 106 掉到 97，发布门按冻结下限 100 判红。
 * 隔离后"无 CUDA"是**构造出来的、可复现的事实**，不再是宿主偶然；worker 子进程与独立 warp 读数探针
 * 走**同一个 env**，两边的设备事实因此一致（这里证明的是 CPU/无 CUDA 分支，**不伪造** CUDA 事实）。
 */
const NO_CUDA_ENV: Record<string, string> = { CUDA_VISIBLE_DEVICES: '', NVIDIA_VISIBLE_DEVICES: '', LYAPUNOV_NEWTON_DEVICE: 'auto' }

/** 合同 `RobotCapability.kind` 的共享 8 元组（`packages/sim-contract/src/index.ts:129-142`）。 */
const CONTRACT_KINDS = ROBOT_CAPABILITY_KINDS
/** 合同 `ACTION_KINDS` 的 10 个动作 kind（worker CAPABILITIES.unsupported.execute 的键）。 */
const ACTION_KINDS = ['vehicle', 'lift', 'gripper', 'gait', 'thrust', 'tendon', 'batch'] as const
/** 声明键（CAPABILITIES.unsupported）→ 线上方法名。两份表都取自 worker 的实时自报，不是抄来的常量。 */
const DECLARED_METHODS: Record<string, string> = {
  cameraAdjust: 'camera_adjust',
  cameraProjectAnnotation: 'camera_project_annotation', cameraDatasetExport: 'camera_dataset_export', assist: 'assist',
}

type Reply = { result?: any; error?: { code?: string; message?: string } }

const snapshot = (sceneId: string): SceneSnapshot => ({
  sceneId, revision: 1, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' },
  entities: [{
    entityId: 'arm-a', name: 'arm-a', resources: [],
    transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    components: { mujoco: { sourcePath: ARM } },
  }],
})

let cacheRoot: string | undefined
beforeAll(() => { cacheRoot = mkdtempSync(join(tmpdir(), 'dev008-warp-')) })
afterAll(() => { if (cacheRoot) rmSync(cacheRoot, { recursive: true, force: true }); cacheRoot = undefined })

/** 起一个真实 worker，按序发请求，回读 (events, id→response, exitCode)。 */
function drive(requests: Array<{ method: string; args: unknown }>, env: Record<string, string> = {}) {
  const lines = requests.map((r, i) => JSON.stringify({ id: i + 1, method: r.method, args: r.args }))
  lines.push(JSON.stringify({ id: '__eof', method: 'shutdown', args: {} }))
  const run = spawnSync(PYTHON, ['-u', WORKER], {
    cwd: DEV, input: lines.join('\n') + '\n', encoding: 'utf8', timeout: 600_000,
    env: { ...process.env, CUDA_VISIBLE_DEVICES: '', NVIDIA_VISIBLE_DEVICES: '',
      LYAPUNOV_NEWTON_DEVICE: 'cpu', LYAPUNOV_NEWTON_CACHE_ROOT: cacheRoot!, ...env },
  })
  const events: any[] = []
  const replies = new Map<number, Reply>()
  for (const line of run.stdout.split('\n')) {
    const text = line.trim()
    if (!text) continue
    let message: any
    try { message = JSON.parse(text) } catch { continue }   // warp 的内核装载提示行不是协议
    if (message.event) events.push(message)
    else replies.set(message.id, message)
  }
  return { events, replies, status: run.status, stderr: run.stderr }
}

/**
 * 独立设备真值：直接问 warp，不经过 worker 的降级判定。
 * 结果写文件回读：warp 的初始化横幅走 C 层缓冲 stdout（退出时才 flush），和 Python 层的
 * `os.write` 在同一根管道里会交错，行协议不安全；文件是唯一不靠缓冲顺序的读法。
 */
function cudaDevices(env: Record<string, string> = {}): { devices: string[]; error?: string } {
  const out = join(cacheRoot!, 'cuda-truth.json')
  const script = 'import json,sys,warp as wp\n'
    + 'try:\n    d=[str(x) for x in wp.get_cuda_devices()]\n    m={"devices":d}\n'
    + 'except Exception as exc:\n    m={"devices":[],"error":str(exc)}\n'
    + 'open(sys.argv[1],"w").write(json.dumps(m))\n'
  const run = spawnSync(PYTHON, ['-c', script, out], { cwd: DEV, encoding: 'utf8', timeout: 600_000, env: { ...process.env, ...env } })
  if (!existsSync(out)) return { devices: [], error: `probe failed rc=${run.status} ${run.stderr.slice(-200)}` }
  return JSON.parse(readFileSync(out, 'utf8'))
}

const WORLD = 'w-dev008'

describe.skipIf(!available)('DEV-008：Newton 自报 ↔ 实际（真机 worker）', () => {
  let run: ReturnType<typeof drive>
  let declaredUnsupported: Record<string, any>
  let openHandle: any
  let describeReply: any
  let plainFrame: any

  beforeAll(() => {
    const requests: Array<{ method: string; args: unknown }> = [
      { method: 'capabilities', args: {} },
      { method: 'open', args: { snapshot: snapshot('dev008'), options: { worldId: WORLD, timestepS: 0.002, clock: 'manual' } } },
      ...ACTION_KINDS.map(kind => ({ method: 'execute', args: { worldId: WORLD, action: { kind, entityId: 'arm-a' } } })),
      { method: 'execute', args: { worldId: WORLD, action: { kind: 'batch', entityId: 'arm-a', motions: [{ kind: 'joint' }] } } },
      ...Object.values(DECLARED_METHODS).map(method => ({ method, args: { worldId: WORLD, options: {} } })),
      { method: 'observe', args: { worldId: WORLD, selection: { contacts: true } } },
      { method: 'observe', args: { worldId: WORLD, selection: {} } },
      { method: 'open', args: { snapshot: snapshot('dev008-cp'), options: { worldId: 'w-cp', clock: 'manual' }, collisionPatches: [] } },
      { method: 'sync', args: { worldId: WORLD, snapshot: snapshot('dev008'), collisionPatches: [] } },
      { method: 'describe', args: { worldId: WORLD, entityId: 'arm-a' } },
      { method: 'close', args: { worldId: WORLD } },
    ]
    run = drive(requests)
    declaredUnsupported = run.replies.get(1)!.result.unsupported
    openHandle = run.replies.get(2)!.result
    const base = 2 + ACTION_KINDS.length + 1 + Object.keys(DECLARED_METHODS).length
    // 索引：observe.contacts = base+1，observe.plain = base+2，open(collisionPatches) = base+3，sync = base+4，describe = base+5
    plainFrame = run.replies.get(base + 2)!.result
    describeReply = run.replies.get(base + 5)!.result
  }, 600_000)

  test('未接通的 7 个动作 kind 按 ACTION_UNSUPPORTED 拒绝', () => {
    expect(run.status).toBe(0)
    const declaredExecute = declaredUnsupported.execute as Record<string, string>
    expect(Object.keys(declaredExecute).sort()).toEqual([...ACTION_KINDS].sort())
    for (const [index, kind] of ACTION_KINDS.entries()) {
      const reply = run.replies.get(3 + index)!
      expect({ kind, code: reply.error?.code }).toEqual({ kind, code: declaredExecute[kind] })
      expect(reply.error?.message).toContain(kind)
    }
    const batch = run.replies.get(3 + ACTION_KINDS.length)!
    expect(batch.error?.code).toBe(declaredExecute.batch)
    expect(batch.error?.message).toContain('batch')
  })

  test('方法级 unsupported 键按自报的码拒绝，一个不漏（声明表即断言表）', () => {
    const offset = 3 + ACTION_KINDS.length + 1                       // 14：第一个方法级请求的 id
    const declaredKeys = Object.keys(DECLARED_METHODS)
    for (const [index, key] of declaredKeys.entries()) {
      const reply = run.replies.get(offset + index)!
      expect({ key, code: reply.error?.code }).toEqual({ key, code: declaredUnsupported[key] })
    }
    // 声明里的非"方法名"键：observe.contacts 走观测选择，collisionPatches 走 open/sync 入参。
    expect(declaredUnsupported['observe.contacts']).toBeUndefined()
    expect(run.replies.get(offset + declaredKeys.length)!.result.contacts).toBeArray()      // 21 observe(contacts)
    expect(run.replies.get(offset + declaredKeys.length + 2)!.error?.code).toBe('UNSUPPORTED_CAPABILITY')  // 23 open(collisionPatches)
    expect(run.replies.get(offset + declaredKeys.length + 3)!.error?.code).toBe('UNSUPPORTED_CAPABILITY')  // 24 sync(collisionPatches)
  })

  test('支持的能力真出结果：open 交付可用世界，observe 给出真实帧（不是只有拒绝）', () => {
    expect(openHandle.status).toBe('ready')
    expect(openHandle.engineId).toBe('newton')
    expect(openHandle.solver).toBe('xpbd')
    expect(plainFrame.stepIndex).toBe(0)
    expect(plainFrame.entities).toHaveLength(1)
    expect(plainFrame.executionMode).toBe('physical-contact')
    expect(plainFrame.assistAdvanceCount).toBe(0)
  })

  test('describe 覆盖共享 8 个 kind，已接通的源驱动可用，其他逐项给真实拒绝码', () => {
    const capabilities = describeReply.capabilities as Array<{ kind: string; available: boolean; reason?: string }>
    expect(capabilities.map(item => item.kind).sort()).toEqual([...CONTRACT_KINDS].sort())
    for (const item of capabilities) {
      const supported = item.kind === 'joint' || item.kind === 'control'
      expect(item.available).toBe(supported)
      if (!supported) expect(item.reason?.startsWith(declaredUnsupported.execute[item.kind] + ': ')).toBe(true)
    }
    expect(describeReply.controlledJointNames).toHaveLength(3)
    expect(describeReply.joints.every((joint: any) => joint.controlMode === 'position')).toBe(true)
    expect(describeReply.controlMetadata).toBeUndefined()
  })

  test('可用性逐世界回传：有源位置驱动才开放 execute/manualClockAdvance', () => {
    expect(openHandle.capabilities.supported.execute).toBe(true)
    expect(openHandle.capabilities.supported.manualClockAdvance).toBe(true)
    expect(openHandle.capabilities.supported.contacts).toBe(true)
  })

  test('ready 与 capabilities 两条自报路径给同一份能力表与同一份设备事实', () => {
    const ready = run.events.find(event => event.event === 'ready')!
    const capabilities = run.replies.get(1)!.result
    expect(capabilities.supported).toEqual(ready.capabilities.supported)
    expect(capabilities.unsupported).toEqual(ready.capabilities.unsupported)
    expect(capabilities.notes).toEqual(ready.capabilities.notes)
    expect(capabilities.device).toBe(ready.device)
    expect(capabilities.deviceDegraded).toBe(ready.deviceDegraded)
    expect(capabilities.deviceNote).toBe(ready.deviceNote)
    expect(typeof capabilities.kernelCacheNote).toBe('string')
    expect(capabilities.kernelCacheNote).toBe(ready.kernelCacheNote)
    // 来源写的是本次会话配置的缓存根，实际生效目录是它下面 warp 的版本子目录（两者都不许改写）。
    expect(capabilities.kernelCacheNote).toContain(cacheRoot!)
    expect(capabilities.kernelCacheDir!.startsWith(cacheRoot!)).toBe(true)
  })
})

describe.skipIf(!available)('DEV-008：基础世界与撤回面各给真实回执（真机 worker）', () => {
  test('open→sync→observe→stop→receipt→describe(未知实体)→close 每条都有明确回执', () => {
    const run = drive([
      { method: 'open', args: { snapshot: snapshot('dev008-base'), options: { worldId: 'w-base', clock: 'manual' } } },
      { method: 'sync', args: { worldId: 'w-base', snapshot: snapshot('dev008-base') } },
      { method: 'observe', args: { worldId: 'w-base', selection: { entityIds: ['arm-a'] } } },
      { method: 'stop', args: { worldId: 'w-base', selection: {} } },
      { method: 'receipt', args: { worldId: 'w-base', actionId: 'never-issued' } },
      { method: 'describe', args: { worldId: 'w-base', entityId: 'ghost' } },
      { method: 'close', args: { worldId: 'w-base' } },
    ])
    expect(run.status).toBe(0)
    expect(run.replies.get(1)!.result.status).toBe('ready')
    // 签名未变的 sync 不重编译：仍 ready，世界代次不变（把"没重建"如实回报，而不是假装推进）。
    expect(run.replies.get(2)!.result.status).toBe('ready')
    expect(run.replies.get(2)!.result.worldGeneration).toBe(1)
    expect(run.replies.get(3)!.result.entities.map((entity: any) => entity.entityId)).toEqual(['arm-a'])
    // 空真值：从未接受过动作，就不伪造停止回执（README 已声明 stop 是空真值）。
    expect(run.replies.get(4)!.result).toEqual({ stopped: true, stepIndex: 0, receipts: [], affectedEntityIds: [] })
    expect(run.replies.get(5)!.error?.code).toBe('ACTION_NOT_FOUND')
    expect(run.replies.get(6)!.error?.code).toBe('ENTITY_NOT_SIMULATED')
    expect(run.replies.get(7)!.result).toBeNull()
  }, 600_000)
})

describe.skipIf(!available)('DEV-008：无 CUDA 时的设备降级必须如实（真机 worker）', () => {
  test('auto：设备真值决定 deviceDegraded；无 CUDA 时 note 必须写明"降级到 cpu"', () => {
    const truth = cudaDevices(NO_CUDA_ENV)
    // 先证明隔离真的生效：本轮的"无 CUDA"是构造出来的、可复现的事实，不是"宿主恰好没卡"。
    expect(truth.devices).toEqual([])
    const run = drive([
      { method: 'capabilities', args: {} },
      { method: 'open', args: { snapshot: snapshot('dev008-auto'), options: { worldId: 'w-auto', clock: 'manual' } } },
      { method: 'close', args: { worldId: 'w-auto' } },
    ], NO_CUDA_ENV)
    expect(run.status).toBe(0)
    const capabilities = run.replies.get(1)!.result
    const handle = run.replies.get(2)!.result
    const degraded = truth.devices.length === 0
    expect({ device: capabilities.device, degraded: capabilities.deviceDegraded }).toEqual({ device: degraded ? 'cpu' : truth.devices[0], degraded })
    expect(handle.device).toBe(capabilities.device)
    expect(handle.deviceKind).toBe(degraded ? 'cpu' : 'cuda')
    expect(handle.deviceDegraded).toBe(degraded)
    expect(handle.deviceNote).toContain(degraded ? '降级到 cpu' : '检测到 CUDA 设备')
    // 降级不是"环境坏了"：世界照样真编译、真可用。
    expect(handle.status).toBe('ready')
  }, 600_000)

  test('显式 cpu 不是降级：deviceDegraded=false 且 note 写明是显式选择', () => {
    const run = drive([
      { method: 'open', args: { snapshot: snapshot('dev008-cpu'), options: { worldId: 'w-cpu', clock: 'manual', device: 'cpu' } } },
      { method: 'close', args: { worldId: 'w-cpu' } },
    ], NO_CUDA_ENV)
    expect(run.status).toBe(0)
    const handle = run.replies.get(1)!.result
    expect(handle.device).toBe('cpu')
    expect(handle.deviceDegraded).toBe(false)
    expect(handle.deviceNote).toBe('显式选择 cpu')
    expect(handle.status).toBe('ready')
  }, 600_000)

  test('负对照：无 CUDA 时显式 cuda:0 明确拒绝（不静默顶替成 cpu）', () => {
    const truth = cudaDevices(NO_CUDA_ENV)
    // 隔离没生效（还是看得见 CUDA）时不静默跳过：这一格的判据要求"无 CUDA"这个前提必须成立。
    expect(truth.devices).toEqual([])
    const run = drive([
      { method: 'open', args: { snapshot: snapshot('dev008-cuda'), options: { worldId: 'w-cuda', clock: 'manual', device: 'cuda:0' } } },
      { method: 'list_worlds', args: {} },
    ], NO_CUDA_ENV)
    expect(run.status).toBe(0)
    expect(run.replies.get(1)!.error?.code).toBe('UNSUPPORTED_CAPABILITY')
    expect(run.replies.get(1)!.error?.message).toContain('显式指定的设备不可用: cuda:0')
    expect(run.replies.get(1)!.error?.message).toContain('可见 CUDA 设备: 无')
    expect(run.replies.get(2)!.result).toEqual([])            // 世界没有半建出来
  }, 600_000)

  test('负对照：LYAPUNOV_NEWTON_DEVICE=cuda:0 且无 CUDA → 结构化 fatal（退出码 2），不是静默回退', () => {
    const truth = cudaDevices(NO_CUDA_ENV)
    expect(truth.devices).toEqual([])
    const run = drive([{ method: 'capabilities', args: {} }], { ...NO_CUDA_ENV, LYAPUNOV_NEWTON_DEVICE: 'cuda:0' })
    expect(run.status).toBe(2)
    const fatal = run.events.find(event => event.event === 'fatal')!
    expect(fatal.error.code).toBe('PROVIDER_UNAVAILABLE')
    expect(fatal.error.message).toContain('显式指定的设备不可用: cuda:0')
    expect(run.replies.size).toBe(0)                          // 没有伪造任何能力回复
  }, 600_000)
})


const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe.skipIf(!available)('Newton 源位置控制、停止与接触（真实 CPU 解释器和公共 Provider）', () => {
  let provider: NewtonProvider
  let names: string[]
  const worldId = 'w-position-cpu'
  const scene = snapshot('position-cpu')
  beforeAll(async () => {
    provider = new NewtonProvider({ pythonPath: PYTHON, workerPath: WORKER, device: 'cpu', cacheRoot })
    const handle = await provider.open(scene, { worldId, clock: 'manual', timestepS: .002 })
    expect(handle.device).toBe('cpu')
    names = (await provider.describe(worldId, 'arm-a')).controlledJointNames
    expect(names).toHaveLength(3)
  }, 600_000)
  afterAll(async () => { if (provider) await provider.dispose() })

  test('manual 空闲冻结；joint、trajectory 真运动；control 精确推进整数步', async () => {
    const first = await provider.observe(worldId)
    await wait(30)
    expect((await provider.observe(worldId)).stepIndex).toBe(first.stepIndex)
    const joint = await provider.execute(worldId, {
      actionId: 'joint-physical', expectedGeneration: 1, kind: 'joint', entityId: 'arm-a',
      jointNames: [names[0]!], positions: [.4], durationS: .2, settleTimeS: .2,
    })
    expect(joint.status).toBe('completed')
    expect(joint.finalState!.stepIndex).toBe(200)
    expect(Math.abs(joint.finalState!.entities[0]!.joints!.positions[0]! - .4)).toBeLessThan(.06)
    expect(joint.finalState!.entities[0]!.joints!.positions[0]!).toBeGreaterThan(.25)
    expect(joint.finalState!.simTime).toBeCloseTo(.4, 9)
    const before = joint.endStep!
    const control = await provider.execute(worldId, {
      actionId: 'control-37', expectedGeneration: 1, kind: 'control', entityId: 'arm-a',
      jointNames: [names[0]!], positions: [.2], stepCount: 37,
    })
    expect(control.status).toBe('completed')
    expect(control.endStep! - control.startStep! + 1).toBe(37)
    expect(control.endStep! - before).toBe(37)
    expect((control.effect!.motions as any[])[0].appliedSteps).toBe(37)
    const trajectory = await provider.execute(worldId, {
      actionId: 'trajectory-physical', expectedGeneration: 1, kind: 'trajectory', entityId: 'arm-a',
      jointNames: names, points: [{ timeS: .15, positions: [.1, -.1, .1] }], settleTimeS: .15,
    })
    expect(trajectory.status).toBe('completed')
    expect(trajectory.endStep! - trajectory.startStep! + 1).toBe(150)
    expect(Math.abs(trajectory.finalState!.entities[0]!.joints!.positions[0]! - .1)).toBeLessThan(.06)
    expect(trajectory.finalState!.entities[0]!.joints!.positions.every(Number.isFinite)).toBe(true)
    await wait(25)
    expect((await provider.observe(worldId)).stepIndex).toBe(trajectory.endStep!)
  }, 600_000)

  test('范围/不完整轨迹不推进；AbortSignal 产生真实取消回执并保持当时实测参考', async () => {
    const before = (await provider.observe(worldId)).stepIndex
    await expect(provider.execute(worldId, {
      actionId: 'bad-range', expectedGeneration: 1, kind: 'joint', entityId: 'arm-a',
      jointNames: [names[0]!], positions: [3], durationS: .2,
    })).rejects.toMatchObject({ code: 'OUT_OF_RANGE' })
    await expect(provider.execute(worldId, {
      actionId: 'bad-vector', expectedGeneration: 1, kind: 'trajectory', entityId: 'arm-a',
      jointNames: [names[0]!], points: [{ timeS: .2, positions: [.2] }],
    })).rejects.toMatchObject({ code: 'INCOMPLETE_JOINT_VECTOR' })
    expect((await provider.observe(worldId)).stepIndex).toBe(before)
    const abort = new AbortController()
    const pending = provider.execute(worldId, {
      actionId: 'cancel-real', expectedGeneration: 1, kind: 'control', entityId: 'arm-a',
      jointNames: [names[0]!], positions: [-.3], stepCount: 1_000_000,
    }, abort.signal)
    const deadline = Date.now() + 30_000
    while ((await provider.observe(worldId)).stepIndex < before + 5 && Date.now() < deadline) await wait(5)
    abort.abort()
    const cancelled = await pending
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.reason).toBe('STOP_CONFIRMED')
    expect(cancelled.endStep!).toBeGreaterThan(before)
    const effect = (cancelled.effect!.motions as any[])[0]
    expect(effect.appliedSteps).toBeGreaterThan(0)
    expect(effect.holdReference).toEqual(effect.measuredPositions)
    expect(effect.lastAppliedPositions).toEqual([-.3])
    await wait(25)
    expect((await provider.observe(worldId)).stepIndex).toBe(cancelled.endStep!)
    expect((await provider.receipt(worldId, 'cancel-real')).status).toBe('cancelled')
  }, 600_000)

  test('未来动作尚未写目标可停止；重建终结旧代次动作，迟到停止不触碰新代次', async () => {
    const before = await provider.observe(worldId)
    const future = provider.execute(worldId, {
      actionId: 'future-cancel', expectedGeneration: 1, kind: 'joint', entityId: 'arm-a',
      startStep: before.stepIndex + 1_000_000, jointNames: [names[0]!], positions: [.2], durationS: .2,
    })
    await wait(20)
    const stopped = await provider.stop(worldId, { actionId: 'future-cancel', expectedGeneration: 1 })
    const receipt = await future
    expect(stopped.affectedEntityIds).toEqual(['arm-a'])
    expect(receipt.status).toBe('cancelled')
    expect((receipt.effect!.motions as any[])[0].appliedSteps).toBe(0)
    expect((receipt.effect!.motions as any[])[0].lastAppliedPositions).toBeNull()
    expect((receipt.effect!.motions as any[])[0].holdReference).toBeNull()
    const long = provider.execute(worldId, {
      actionId: 'rebuild-cancel', expectedGeneration: 1, kind: 'control', entityId: 'arm-a',
      jointNames: [names[0]!], positions: [.3], stepCount: 1_000_000,
    })
    await wait(20)
    const rebuilt = await provider.sync(worldId, { ...scene, revision: 2 }, { forceRebuild: true })
    const old = await long
    expect(old.status).toBe('cancelled')
    expect(old.reason).toBe('MODEL_REBUILT')
    expect(old.generation).toBe(1)
    expect(rebuilt.worldGeneration).toBe(2)
    await expect(provider.stop(worldId, { expectedGeneration: 1 })).rejects.toMatchObject({ code: 'STALE_GENERATION' })
    expect((await provider.observe(worldId)).stepIndex).toBe(0)
    expect((await provider.receipt(worldId, 'rebuild-cancel')).generation).toBe(1)
  }, 600_000)

  test('源 ctrlrange 生效；XPBD 不支持的有限力限在 describe 与执行侧同样拒绝', async () => {
    const source = readFileSync(ARM, 'utf8')
    const bounded = snapshot('bounded-source')
    bounded.entities[0]!.components.mujoco = { xml: source.replace('<position name="a1"', '<position ctrllimited="true" ctrlrange="-.1 .1" name="a1"') }
    const handle = await provider.open(bounded, { worldId: 'w-bounded', clock: 'manual' })
    const description = await provider.describe(handle.worldId, 'arm-a')
    await expect(provider.execute(handle.worldId, {
      actionId: 'source-range', expectedGeneration: 1, kind: 'control', entityId: 'arm-a',
      jointNames: [description.controlledJointNames[0]!], positions: [.2], stepCount: 1,
    })).rejects.toMatchObject({ code: 'OUT_OF_RANGE' })
    expect((await provider.observe(handle.worldId)).stepIndex).toBe(0)
    await provider.close(handle.worldId)
    const limited = snapshot('force-limited-source')
    limited.entities[0]!.components.mujoco = { xml: source.replaceAll('<position ', '<position forcelimited="true" forcerange="-1 1" ') }
    const blocked = await provider.open(limited, { worldId: 'w-force-limit', clock: 'manual' })
    const blockedDescription = await provider.describe(blocked.worldId, 'arm-a')
    expect(blockedDescription.controlledJointNames).toEqual([])
    expect(blocked.capabilities!.supported).toMatchObject({ execute: false, manualClockAdvance: false })
    expect(blockedDescription.capabilities!.find(c => c.kind === 'joint')!.available).toBe(false)
    await expect(provider.execute(blocked.worldId, {
      actionId: 'force-limit', expectedGeneration: 1, kind: 'joint', entityId: 'arm-a',
      jointNames: [blockedDescription.joints[0]!.name], positions: [.1], durationS: .1,
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
    await provider.close(blocked.worldId)
  }, 600_000)

  test('真实球体接触读回距离、法线与XPBD力；穿透聚合来自负距离而非占位值', async () => {
    const ball = snapshot('contact-cpu')
    ball.entities[0]!.components.mujoco = { xml: '<mujoco model="ball"><worldbody><body name="ball" pos="0 0 .04"><freejoint/><geom name="ball-surface" type="sphere" size=".05" mass="1"/></body></worldbody></mujoco>' }
    const handle = await provider.open(ball, { worldId: 'w-contact', clock: 'realtime', timestepS: .002, ground: true })
    expect(handle.device).toBe('cpu')
    const initial = await provider.observe(handle.worldId, { contacts: true })
    expect(initial.contacts!.length).toBeGreaterThan(0)
    expect(initial.contacts!.some(c => c.distanceM! < 0)).toBe(true)
    expect(initial.penetrations!.count).toBeGreaterThan(0)
    let frame = initial
    const deadline = Date.now() + 30_000
    while (!frame.contacts!.some(c => c.forceN && Math.hypot(...c.forceN) > .01) && Date.now() < deadline) {
      await wait(10)
      frame = await provider.observe(handle.worldId, { contacts: true })
    }
    expect(frame.stepIndex).toBeGreaterThan(0)
    expect(frame.contacts!.some(c => c.geom1 === '__ground' || c.geom2 === '__ground')).toBe(true)
    expect(frame.contacts!.some(c => c.forceN && Math.hypot(...c.forceN) > .01)).toBe(true)
    for (const contact of frame.contacts!) {
      expect(Number.isFinite(contact.distanceM)).toBe(true)
      expect(contact.sourceStep).toBe(frame.stepIndex)
      expect(contact.normal!.every(Number.isFinite)).toBe(true)
      if (contact.forceN) expect(contact.forceN.every(Number.isFinite)).toBe(true)
    }
    await provider.close(handle.worldId)
  }, 600_000)

  test('产品 startPaused 首步门真实通过：首帧0、继续下落、再次暂停、重建与旧代次拒绝', async () => {
    const prepared = snapshot('paused-free-body')
    prepared.entities[0]!.components.mujoco = { xml: '<mujoco model="paused-ball"><worldbody><camera name="overview" pos="0 0 2" fovy="60"/><body name="ball" pos="0 0 .5"><freejoint/><geom name="surface" type="sphere" size=".05" mass="1"/></body></worldbody></mujoco>' }
    const handle = await provider.open(prepared, { worldId: 'w-paused-free', clock: 'realtime',
      timestepS: .002, ground: false, startPaused: true })
    try {
      expect(handle.status).toBe('paused')
      expect(handle.supportsPause).toBe(true)
      expect(handle.clock).toBe('realtime')
      const first = await provider.observe(handle.worldId)
      expect(first.stepIndex).toBe(0)
      expect(first.simTime).toBe(0)
      expect(first.worldStatus).toBe('paused')
      await wait(30)
      const held = await provider.observe(handle.worldId)
      expect(held.stepIndex).toBe(0)
      expect(held.entities).toEqual(first.entities)
      const image = await provider.capture(handle.worldId, { cameraName: 'overview', width: 32, height: 24,
        outputDir: join(cacheRoot!, 'paused-free-capture') }) as any
      expect(image.stepIndex).toBe(0)
      expect(image.observation.worldStatus).toBe('paused')
      expect(image.observation.frameId).toBe(first.frameId)
      expect((await provider.observe(handle.worldId)).stepIndex).toBe(0)
      const resumed = await provider.setPaused(handle.worldId, false, handle.worldGeneration)
      expect(resumed.worldId).toBe(handle.worldId)
      expect(resumed.worldGeneration).toBe(handle.worldGeneration)
      expect(resumed.clock).toBe('realtime')
      let progressed = await provider.observe(handle.worldId)
      const deadline = Date.now() + 30_000
      while (progressed.stepIndex < 20 && Date.now() < deadline) {
        await wait(5)
        progressed = await provider.observe(handle.worldId)
      }
      expect(progressed.stepIndex).toBeGreaterThanOrEqual(20)
      expect(progressed.worldStatus).toBe('running')
      expect(progressed.entities[0]!.transform.position[2]).toBeLessThan(first.entities[0]!.transform.position[2] - .003)
      expect((await provider.setPaused(handle.worldId, true, handle.worldGeneration)).status).toBe('paused')
      const frozen = await provider.observe(handle.worldId)
      await wait(30)
      expect((await provider.observe(handle.worldId)).frameId).toBe(frozen.frameId)
      const rebuilt = await provider.sync(handle.worldId, { ...prepared, revision: 2 }, { forceRebuild: true })
      expect(rebuilt.status).toBe('paused')
      expect(rebuilt.worldGeneration).toBe(handle.worldGeneration + 1)
      const reset = await provider.observe(handle.worldId)
      expect(reset.worldStatus).toBe('paused')
      expect(reset.stepIndex).toBe(0)
      expect(reset.simTime).toBe(0)
      await expect(provider.setPaused(handle.worldId, false, handle.worldGeneration)).rejects.toMatchObject({ code: 'STALE_GENERATION' })
      await wait(20)
      expect((await provider.observe(handle.worldId)).stepIndex).toBe(0)
      expect((await provider.listWorlds()).find(w => w.worldId === handle.worldId)!.status).toBe('paused')
    } finally { await provider.close(handle.worldId) }
  }, 600_000)

  test('manual 暂停不驱动已接受动作，stop无推进；继续后仍由明确control推进整数步', async () => {
    const handle = await provider.open(snapshot('paused-manual-arm'), { worldId: 'w-paused-manual',
      clock: 'manual', timestepS: .002, startPaused: true })
    try {
      const jointNames = (await provider.describe(handle.worldId, 'arm-a')).controlledJointNames.slice(0, 1)
      const pending = provider.execute(handle.worldId, { actionId: 'paused-stop', expectedGeneration: 1,
        kind: 'control', entityId: 'arm-a', jointNames, positions: [.2], stepCount: 5 })
      await wait(20)
      expect((await provider.receipt(handle.worldId, 'paused-stop')).status).toBe('accepted')
      expect((await provider.observe(handle.worldId)).stepIndex).toBe(0)
      const stopped = await provider.stop(handle.worldId, { actionId: 'paused-stop', expectedGeneration: 1 })
      expect(stopped.stepIndex).toBe(0)
      const cancelled = await pending
      expect(cancelled.status).toBe('cancelled')
      expect((cancelled.effect!.motions as any[])[0].appliedSteps).toBe(0)
      expect(cancelled.finalState!.worldStatus).toBe('paused')
      await provider.setPaused(handle.worldId, false, handle.worldGeneration)
      await wait(20)
      expect((await provider.observe(handle.worldId)).stepIndex).toBe(0)
      const five = await provider.execute(handle.worldId, { actionId: 'unpaused-five', expectedGeneration: 1,
        kind: 'control', entityId: 'arm-a', jointNames, positions: [.2], stepCount: 5 })
      expect(five.status).toBe('completed')
      expect(five.endStep! - five.startStep! + 1).toBe(5)
      await provider.setPaused(handle.worldId, true, handle.worldGeneration)
      expect((await provider.stop(handle.worldId)).stepIndex).toBe(5)
      await wait(20)
      const frozen = await provider.observe(handle.worldId)
      expect(frozen.stepIndex).toBe(5)
      expect(frozen.worldStatus).toBe('paused')
    } finally { await provider.close(handle.worldId) }
  }, 600_000)
})
