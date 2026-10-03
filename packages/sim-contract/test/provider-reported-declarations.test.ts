/**
 * F3／F8：provider 在 worker `ready` 事件里自报的能力表必须**原样**到达调用方（不得被传输层静默丢弃），
 * 且它和各 Provider 的句柄加法字段都声明在 `WorldHandle`（唯一归属）上；
 * F4／F5：worker 已产出的其它字段同样必须在合同里有可选声明（本文件里的字面量赋值就是那条类型断言）。
 *
 * 证据边界：F3／F8 用的是一个只实现行协议的**最小假 worker**（不是引擎实测），验的是
 * `python-transport.ts` 的 ready 处理 → 句柄交付这条真实代码路径；其余是**声明面**证据（tsc 判定），
 * 运行时的断言只保证这些可选字段不妨碍构造真实形状并在真实路径上原样通过，不替代 tsc。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProcessSimProvider } from '../src/python-transport.ts'
import type { RobotDescription, TendonActuatorDescription } from '../src/index.ts'
import type { SceneSnapshot, WorldHandle, Frame } from '../../lyapunov-contracts/src/types.ts'

function systemPython(): string | undefined {
  for (const candidate of ['/usr/bin/python3', '/usr/local/bin/python3', '/bin/python3']) if (existsSync(candidate)) return candidate
  return undefined
}

const PYTHON = systemPython()

/**
 * 与 Newton 第一切片同形的 provider 能力表（键与嵌套形状逐字取自
 * `packages/sim-newton/python/worker.py` 的 `CAPABILITIES`：engine/slice/supported/unsupported/notes，
 * 其中 `unsupported.execute` 是「动作 kind → 错误码」的对象，其余是错误码字符串）。
 */
const REPORTED = {
  engine: 'fake-provider',
  slice: 'minimal-1',
  supported: { open: true, sync: true, observe: true, execute: false },
  unsupported: { execute: { pick: 'ACTION_UNSUPPORTED' }, 'observe.contacts': 'UNSUPPORTED_CAPABILITY', capture: 'UNSUPPORTED_CAPABILITY' },
  notes: ['第一切片只支持最小世界；manual 时钟下世界保持冻结（不假装推进）。'],
}

/**
 * 与 Newton `handle()` 同形的句柄加法字段（`sim-newton/python/worker.py:317-325`）：
 * groundGeomNames/device/deviceKind/deviceDegraded/deviceNote/solver/warpVersion。
 * 三个 Provider 都产出 `groundGeomNames`，其余六个只有 Newton 产出。
 */
const HANDLE_EXTRAS: Required<Pick<WorldHandle, 'groundGeomNames' | 'device' | 'deviceKind' | 'deviceDegraded' | 'deviceNote' | 'solver' | 'warpVersion'>> = {
  groundGeomNames: ['floor', 'g1/floor'],
  device: 'cpu',
  deviceKind: 'cpu',
  deviceDegraded: true,
  deviceNote: 'auto：没有可用 CUDA 设备，已降级到 cpu',
  solver: 'xpbd',
  warpVersion: '1.2.3',
}

/** 最小行协议 worker：ready（可带 capabilities）→ 回 open／list_worlds／shutdown。不是引擎。 */
function workerSource(withCapabilities: boolean): string {
  const capsJson = JSON.stringify(REPORTED)
  const extrasJson = JSON.stringify(HANDLE_EXTRAS)
  return [
    'import json, sys',
    'def emit(value): print(json.dumps(value), flush=True)',
    'CAPS = json.loads(' + JSON.stringify(capsJson) + ')',
    'EXTRA = json.loads(' + JSON.stringify(extrasJson) + ')',
    withCapabilities
      ? "emit({'event': 'ready', 'engine': 'fake-provider', 'version': '0.0.0', 'pid': 1, 'capabilities': CAPS})"
      : "emit({'event': 'ready', 'engine': 'fake-provider', 'version': '0.0.0', 'pid': 1})",
    'worlds = []',
    'def handle_of(world, scene):',
    "    return {'worldId': world, 'sceneId': scene, 'engineId': 'fake', 'engineVersion': '0.0.0', 'worldGeneration': 1, 'appliedSceneRevision': 0, 'status': 'ready', 'clock': 'realtime', 'timestepS': 0.002, **EXTRA}",
    'for line in sys.stdin:',
    '    request = json.loads(line)',
    "    method = request.get('method'); args = request.get('args', {})",
    "    if method == 'open':",
    "        world = args.get('options', {}).get('worldId') or 'w1'",
    '        if world not in worlds: worlds.append(world)',
    "        emit({'id': request['id'], 'result': handle_of(world, args.get('snapshot', {}).get('sceneId', 's'))})",
    "        emit({'event': 'frame', 'frame': {'worldId': world, 'generation': 1, 'stepIndex': 3, 'simTime': 0.006, 'sceneRevision': 0, 'frameId': world + ':1:3', 'entities': [], 'executionMode': 'physical-contact', 'device': EXTRA['device']}})",
    "    elif method == 'list_worlds':",
    "        emit({'id': request['id'], 'result': [handle_of(name, 's') for name in worlds]})",
    "    elif method == 'shutdown':",
    "        emit({'id': request['id'], 'result': None}); break",
    '    else:',
    "        emit({'id': request['id'], 'error': {'code': 'UNKNOWN_METHOD', 'message': str(method)}})",
  ].join('\n') + '\n'
}

const scene = (sceneId = 'declaration-scene'): SceneSnapshot => ({ sceneId, revision: 0, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' }, entities: [] })

test.skipIf(!PYTHON)('A08 未自报暂停能力的原生世界精确拒绝，不把继承的方法当支持或发未知RPC',async()=>{
 const provider=providerWith(true)
 await expect(provider.setPaused('missing',true,1)).rejects.toMatchObject({code:'WORLD_NOT_FOUND'})
 const opened=await provider.open(scene())
 await expect(provider.setPaused(opened.worldId,true,opened.worldGeneration)).rejects.toMatchObject({code:'CLOCK_CONTROL_UNSUPPORTED'})
 expect((await provider.listWorlds())[0]?.status).toBe('ready')
})

let base: string | undefined
const providers: ProcessSimProvider[] = []
afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.dispose().catch(() => undefined)
  if (base !== undefined) rmSync(base, { recursive: true, force: true })
  base = undefined
})

function providerWith(withCapabilities: boolean): ProcessSimProvider {
  base = mkdtempSync(join(tmpdir(), 'lyapunov-contract-decl-'))
  const worker = join(base, withCapabilities ? 'caps-worker.py' : 'plain-worker.py')
  writeFileSync(worker, workerSource(withCapabilities))
  const provider = new ProcessSimProvider({ pythonPath: PYTHON!, workerPath: worker, engineName: 'fake-provider' })
  providers.push(provider)
  return provider
}

async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`等待超时：${what}`)
}

describe.skipIf(PYTHON === undefined)('F3／F8：自报能力表与句柄加法字段原样到达调用方（假 worker，非引擎实测）', () => {
  test('open 与 listWorlds 都经 WorldHandle（唯一归属）带出 capabilities，且是同一份原始结构', async () => {
    const provider = providerWith(true)
    // 显式标注成 WorldHandle：这条读法在收编后才成立（F6 时期只有 SimWorlds 的交叉类型能读到）。
    const handle: WorldHandle = await provider.open(scene(), { worldId: 'w1' })
    expect(handle.capabilities).toEqual(REPORTED)
    const worlds = await provider.listWorlds()
    expect(worlds).toHaveLength(1)
    expect(worlds[0]!.capabilities).toEqual(REPORTED)
    // 同一份原始结构：传输层只挂引用，没有逐句柄转换/复制/裁剪。
    expect(worlds[0]!.capabilities).toBe(handle.capabilities)
  }, 20_000)

  test('句柄上的 Newton 加法字段原样通过（不裁剪、不改写）', async () => {
    const provider = providerWith(true)
    const handle: WorldHandle = await provider.open(scene(), { worldId: 'w1' })
    expect(handle.groundGeomNames).toEqual(HANDLE_EXTRAS.groundGeomNames)
    expect(handle.device).toBe(HANDLE_EXTRAS.device)
    expect(handle.deviceKind).toBe(HANDLE_EXTRAS.deviceKind)
    expect(handle.deviceDegraded).toBe(HANDLE_EXTRAS.deviceDegraded)
    expect(handle.deviceNote).toBe(HANDLE_EXTRAS.deviceNote)
    expect(handle.solver).toBe(HANDLE_EXTRAS.solver)
    expect(handle.warpVersion).toBe(HANDLE_EXTRAS.warpVersion)
  }, 20_000)

  test('ready 未自报 capabilities 的 worker：句柄不出现该键（不伪造空表）', async () => {
    const provider = providerWith(false)
    const handle: WorldHandle = await provider.open(scene(), { worldId: 'w1' })
    expect('capabilities' in handle).toBe(false)
  }, 20_000)

  test('F9／F10：帧上的 device 与三家共有的 executionMode 原样到达订阅者（Frame 声明面）', async () => {
    const provider = providerWith(true)
    const frames: Frame[] = []
    // 先订阅再 open：帧由 worker 在 open 回包之后立刻发出，订阅按 worldId 建集合，不要求世界已存在。
    const unsubscribe = provider.subscribeFrames('w1', frame => frames.push(frame))
    try {
      await provider.open(scene(), { worldId: 'w1' })
      await until(() => frames.length > 0, '收到一帧')
    } finally {
      unsubscribe()
    }
    expect(frames[0]!.device).toBe(HANDLE_EXTRAS.device)
    // F10：executionMode 是三个 Provider 都产出的帧字段；这里钉住它经传输层原样到达，不被裁剪/改写。
    expect(frames[0]!.executionMode).toBe('physical-contact')
    expect(frames[0]!.stepIndex).toBe(3)
  }, 20_000)
})

/**
 * 声明面：下面的字面量按 worker 真实产出的形状构造。
 * 字段漏写或类型写错时 `tsc --noEmit -p tsconfig.json` 会失败（负对照见回执），
 * 因此“能构造出来”本身就是断言本体；运行时断言只保证可选字段不妨碍构造。
 */
const newtonHandle: WorldHandle = {
  worldId: 'w1', sceneId: 's', engineId: 'newton', engineVersion: '1.0.0', worldGeneration: 1, appliedSceneRevision: 0,
  status: 'ready', clock: 'realtime', timestepS: 0.002,
  groundGeomNames: ['floor'],
  capabilities: REPORTED,
  device: 'cuda:0', deviceKind: 'cuda', deviceDegraded: false, deviceNote: 'auto：检测到 CUDA 设备 cuda:0',
  solver: 'semi', warpVersion: '1.2.3',
}
const newtonDescription: RobotDescription = {
  entityId: 'e1', modelVersion: 'x', expectedGeneration: 1, collisionContextVersion: '1',
  joints: [], controlledJointNames: [], tendonActuators: [], freeBases: [], controller: {}, capabilities: [],
  nativeJointLabels: ['base', 'joint_1'],
  nativeShapeLabels: ['shape_0'],
  device: 'cpu',
}
const mujocoExternalTendon: TendonActuatorDescription = {
  name: 'split', actuator: 'finger', controlMode: 'position', tendonType: 'fixed', joints: ['finger_joint_1'], coefficients: [1],
  unit: 'rad', gear: 1, controlRange: null, ctrlRange: null, forceRange: null, gainprm: [1, 0, 0], biasprm: [0, -1, 0],
  externalTendon: true,
}
const newtonFrame: Frame = {
  worldId: 'w1', generation: 1, stepIndex: 3, simTime: 0.006, sceneRevision: 0, frameId: 'w1:1:3', entities: [],
  executionMode: 'physical-contact',
  device: 'cuda:0',
}
/** Isaac／MuJoCo 的帧（辅助附着生效期间）：executionMode 的另一取值，与 device 无关。 */
const assistedFrame: Frame = {
  worldId: 'w3', generation: 2, stepIndex: 9, simTime: 0.018, sceneRevision: 4, frameId: 'w3:2:9', entities: [],
  assistAdvanceCount: 7,
  executionMode: 'assisted-teleport',
}

describe('声明面：WorldHandle／RobotDescription／TendonActuatorDescription／Frame', () => {
  test('Newton 的句柄加法字段可赋值且值不被改写', () => {
    expect(newtonHandle.groundGeomNames).toEqual(['floor'])
    expect(newtonHandle.capabilities).toBe(REPORTED)
    expect(newtonHandle.deviceKind).toBe('cuda')
    expect(newtonHandle.deviceDegraded).toBe(false)
    expect(newtonHandle.solver).toBe('semi')
    expect(newtonHandle.warpVersion).toBe('1.2.3')
  })

  test('新增字段全部可选：最小 WorldHandle／RobotDescription／Frame 不带它们也合法', () => {
    const minimalHandle: WorldHandle = { worldId: 'w2', sceneId: 's', engineId: 'mujoco', engineVersion: 'x', worldGeneration: 1, appliedSceneRevision: 0, status: 'ready' }
    expect('capabilities' in minimalHandle).toBe(false)
    expect('groundGeomNames' in minimalHandle).toBe(false)
    expect('device' in minimalHandle).toBe(false)
    expect('solver' in minimalHandle).toBe(false)
    const minimal: RobotDescription = { entityId: 'e2', modelVersion: 'x', expectedGeneration: 1, collisionContextVersion: '1', joints: [], controlledJointNames: [] }
    expect('nativeJointLabels' in minimal).toBe(false)
    expect('nativeShapeLabels' in minimal).toBe(false)
    expect('device' in minimal).toBe(false)
    // F9：MuJoCo／Isaac 的帧不产出 device，最小帧（无该键）必须合法。
    const minimalFrame: Frame = { worldId: 'w2', generation: 1, stepIndex: 0, simTime: 0, frameId: 'w2:1:0', entities: [] }
    expect('device' in minimalFrame).toBe(false)
    // F10：旧持久化帧／旧 Provider 可以没有 executionMode；缺失就是缺失（下游按 unknown 处理）。
    expect('executionMode' in minimalFrame).toBe(false)
  })

  test('F9：Newton 帧的 device 可赋值且值不被改写', () => {
    expect(newtonFrame.device).toBe('cuda:0')
    expect(newtonFrame.stepIndex).toBe(3)
  })

  test('F10：三家共有的 executionMode 可赋值、两取值都合法且值不被改写', () => {
    expect(newtonFrame.executionMode).toBe('physical-contact')
    expect(assistedFrame.executionMode).toBe('assisted-teleport')
    expect(assistedFrame.assistAdvanceCount).toBe(7)
  })

  test('Newton 的 describe 加法字段与 MuJoCo 的 externalTendon 可赋值且值不被改写', () => {
    expect(newtonDescription.nativeJointLabels).toEqual(['base', 'joint_1'])
    expect(newtonDescription.nativeShapeLabels).toEqual(['shape_0'])
    expect(newtonDescription.device).toBe('cpu')
    expect(mujocoExternalTendon.externalTendon).toBe(true)
    const plainTendon: TendonActuatorDescription = { ...mujocoExternalTendon }
    delete plainTendon.externalTendon
    expect('externalTendon' in plainTendon).toBe(false)
  })
})
