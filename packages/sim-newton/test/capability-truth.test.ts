/**
 * DEV-008／W5：Newton 的"自报"与"实际"必须逐条对得上（真机 worker，无 CUDA 也要如实）。
 *
 * 本文件钉三件事（都是**真实读数**，不是"代码已写"）：
 *  1. 自报↔实际：`ready`／`capabilities` 里声明为 unsupported 的能力，运行时必须按**同一个码**拒绝；
 *     10 个动作 kind 逐个 ACTION_UNSUPPORTED，7 个方法级能力逐个 UNSUPPORTED_CAPABILITY，
 *     `observe.contacts` 与 `collisionPatches`（open/sync）同样按声明的码拒绝。
 *  2. 能力范围事先说清：`describe().capabilities` 覆盖合同 `RobotCapability.kind` 的**封闭 6 元组**
 *     （thrust/vehicle/joint/gripper/lift/control），全部 available=false 并给原因；`controlMetadata`
 *     说明 controlledJointNames 为什么恒为空。少一条就是"等用户点了才报错"。
 *  3. 设备降级如实：设备真值（直接问 warp）为空时 auto 必须 degraded=true 且 note 说明"降级到 cpu"；
 *     显式 cpu 不是降级；显式 cuda:0 在无 CUDA 时**明确拒绝**（world 选项 → UNSUPPORTED_CAPABILITY；
 *     环境变量 → 结构化 fatal + 退出码 2），绝不静默顶替。
 *
 * 需要真实 Newton 环境（`.runtime/newton-env/bin/python`）；缺失即整体 skip（不假装通过）。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
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
const NO_CUDA_ENV: Record<string, string> = { CUDA_VISIBLE_DEVICES: '', NVIDIA_VISIBLE_DEVICES: '' }

/** 合同 `RobotCapability.kind` 的封闭 6 元组（`packages/sim-contract/src/index.ts:129-142`）。 */
const CONTRACT_KINDS = ['thrust', 'vehicle', 'joint', 'gripper', 'lift', 'control'] as const
/** 合同 `ACTION_KINDS` 的 10 个动作 kind（worker CAPABILITIES.unsupported.execute 的键）。 */
const ACTION_KINDS = ['trajectory', 'joint', 'vehicle', 'lift', 'gripper', 'gait', 'control', 'thrust', 'tendon', 'batch'] as const
/** 声明键（CAPABILITIES.unsupported）→ 线上方法名。两份表都取自 worker 的实时自报，不是抄来的常量。 */
const DECLARED_METHODS: Record<string, string> = {
  capture: 'capture', captureMulti: 'capture_multi', cameraList: 'camera_list', cameraAdjust: 'camera_adjust',
  cameraProjectAnnotation: 'camera_project_annotation', cameraDatasetExport: 'camera_dataset_export', assist: 'assist',
}

type Reply = { result?: any; error?: { code?: string; message?: string } }

const snapshot = (sceneId: string) => ({
  sceneId, revision: 1,
  entities: [{
    entityId: 'arm-a', name: 'arm-a',
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
    env: { ...process.env, LYAPUNOV_NEWTON_CACHE_ROOT: cacheRoot!, ...env },
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

  test('10 个动作 kind 逐个按 ACTION_UNSUPPORTED 拒绝（含 batch 展开）', () => {
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
    expect(batch.error?.message).toContain('batch: joint')
  })

  test('方法级 unsupported 键按自报的码拒绝，一个不漏（声明表即断言表）', () => {
    const offset = 3 + ACTION_KINDS.length + 1                       // 14：第一个方法级请求的 id
    const declaredKeys = Object.keys(DECLARED_METHODS)
    for (const [index, key] of declaredKeys.entries()) {
      const reply = run.replies.get(offset + index)!
      expect({ key, code: reply.error?.code }).toEqual({ key, code: declaredUnsupported[key] })
    }
    // 声明里的非"方法名"键：observe.contacts 走观测选择，collisionPatches 走 open/sync 入参。
    expect(declaredUnsupported['observe.contacts']).toBe('UNSUPPORTED_CAPABILITY')
    expect(run.replies.get(offset + declaredKeys.length)!.error?.code).toBe('UNSUPPORTED_CAPABILITY')      // 21 observe(contacts)
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

  test('describe 覆盖合同封闭 6 个 kind，全部 available=false 且原因前缀＝执行侧真实拒绝码', () => {
    const capabilities = describeReply.capabilities as Array<{ kind: string; available: boolean; reason?: string }>
    expect(capabilities.map(item => item.kind).sort()).toEqual([...CONTRACT_KINDS].sort())
    const declaredExecute = declaredUnsupported.execute as Record<string, string>
    for (const item of capabilities) {
      expect({ kind: item.kind, available: item.available }).toEqual({ kind: item.kind, available: false })
      // **6 条逐条**对照（此前只对了 joint 一条 ⇒ 另外 5 条是敞口）：前缀必须恰好等于 execute 侧对
      // **同一个 kind** 的拒绝码。"声明 == 真机拒绝回执"由上面那条 10 个 kind 的用例逐条从真机回执钉住，
      // 于是三段合成一条链：describe 的 reason 前缀 ≡ 声明表 ≡ execute 真实返回码。
      expect({ kind: item.kind, prefix: item.reason?.split(': ')[0] })
        .toEqual({ kind: item.kind, prefix: declaredExecute[item.kind] })
      expect(item.reason?.startsWith(declaredExecute[item.kind] + ': ')).toBe(true)
    }
    // 逐实体能力表的判定与 execute 的真实拒绝同源：两边都能查到同一个码（值本身是线上码，钉死）。
    expect(describeReply.controlledJointNames).toEqual([])
    expect(declaredUnsupported.execute.joint).toBe('ACTION_UNSUPPORTED')
  })

  test('controlledJointNames 为空有回执：controlMetadata 如实说明原因', () => {
    expect(describeReply.controlMetadata.status).toBe('UNAVAILABLE')
    expect(describeReply.controlMetadata.reason).toContain('没有动作/控制通道')
    expect(describeReply.controlMetadata.reason).toContain('ACTION_UNSUPPORTED')
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
