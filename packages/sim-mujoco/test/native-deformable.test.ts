/**
 * envgate：真实 MuJoCo 3.13 worker，经 ResourceLibrary/SceneStore/便携保存与 Provider 验收。
 * 设置 LYAPUNOV_MUJOCO_PYTHON；缺环境显式跳过，不把跳过计为引擎通过。
 * 夹具是可独立复核的原生小模型，不调用 Viewer 或供应商模型。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EntityObservation, Frame, NativeDynamicGeometry, SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import { SceneOperations } from '../../scene-kit/src/operations.ts'
import { MuJoCoProvider } from '../src/provider.ts'

const here = dirname(fileURLToPath(import.meta.url))
const python = process.env.LYAPUNOV_MUJOCO_PYTHON ?? resolve(here, '../../../.runtime/sim-python/bin/python')
const available = existsSync(python)
const runtime = { timestepS: .001, realtimeFactor: 8, frameRateHz: 15, clock: 'realtime' as const, ground: true }
const options = { skip: available ? false : `原生 MuJoCo 解释器不存在：${python}`, timeout: 30_000 }
const fixture = (name: string) => resolve(here, '../fixtures', name)
const sample = (frame: Frame): EntityObservation => {
  const entity = frame.entities.find(item => item.entityId === 'sample')
  assert.ok(entity, '同一 Frame 必须包含原生实体')
  return entity
}
const geometry = (frame: Frame): NativeDynamicGeometry => {
  const value = sample(frame).dynamicGeometry?.[0]
  assert.ok(value, '原生求解状态必须沿原 Provider 同帧读回')
  assert.ok(value.positionsM.every(Number.isFinite))
  assert.equal(value.positionsM.length % 3, 0)
  return value
}
const physics = (frame: Frame) => sample(frame).sensors?.nativePhysics as any
const sag = (before: NativeDynamicGeometry, after: NativeDynamicGeometry) =>
  Math.max(...before.positionsM.filter((_, index) => index % 3 === 2).map((value, index) => value - after.positionsM[index * 3 + 2]!))
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function atTime(provider: MuJoCoProvider, worldId: string, simTime: number, collect?: (frame: Frame) => void): Promise<Frame> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const frame = await provider.observe(worldId, { contacts: true })
    collect?.(frame)
    if (frame.simTime >= simTime) return frame
    await pause(10)
  }
  assert.fail(`原生世界未推进到 ${simTime}s`)
}

async function imported(operations: SceneOperations, sceneId: string, source: string, positioned = false): Promise<SceneSnapshot> {
  await operations.create({ sceneId })
  const result = await operations.import({ path: source, sceneId, entityId: 'sample', resourceId: `res_${sceneId}`, physicalize: false,
    alignBottomToSurface: false, ...(positioned ? { transform: { position: [.7, -.2, .3], quaternion: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [1, 1, 1] } as const } : {}) })
  assert.ok(result.snapshot)
  return result.snapshot
}

async function material(operations: SceneOperations, snapshot: SceneSnapshot, field: string, values: unknown): Promise<SceneSnapshot> {
  const entity = snapshot.entities.find(item => item.entityId === 'sample')!
  const previous = entity.components.mujoco as Record<string, unknown>
  return operations.scene.commit({ sceneId: snapshot.sceneId, expectedRevision: snapshot.revision,
    patch: [{ op: 'update', entityId: entity.entityId, changes: { components: { ...entity.components, mujoco: { ...previous, [field]: values } } } }] })
}

async function reopenPortable(operations: SceneOperations, snapshot: SceneSnapshot, base: string, provider: MuJoCoProvider): Promise<Frame> {
  const path = join(base, 'portable', `${snapshot.sceneId}.json`)
  const saved = await operations.save(snapshot.sceneId, path, { portable: true })
  assert.deepEqual(saved.missing, [], '便携工程必须保存原生 source 闭包')
  const document = JSON.parse(await readFile(path, 'utf8')) as SceneSnapshot
  assert.deepEqual((document.entities[0]!.components.mujoco as any).flexMaterials, (snapshot.entities[0]!.components.mujoco as any).flexMaterials)
  assert.deepEqual((document.entities[0]!.components.mujoco as any).cableMaterials, (snapshot.entities[0]!.components.mujoco as any).cableMaterials)
  const reader = new SceneOperations(join(base, 'reader'))
  const reopened = await reader.open(path, { sceneId: `${snapshot.sceneId}_reopened` })
  const sourcePath = (reopened.entities[0]!.components.mujoco as any).sourcePath as string
  assert.ok(sourcePath.startsWith(join(base, 'portable')), '重开必须解析随包 source，不依赖原目录')
  const worldId = `${snapshot.sceneId}_reopened`
  await provider.open(reopened, { ...runtime, worldId })
  const frame = await provider.observe(worldId)
  assert.ok(geometry(frame))
  await provider.close(worldId)
  return frame
}

describe('原生 MuJoCo 弹性体与实体缆线', () => {
  test('flex 原声明经 attach 保留；同几何和重力下 Young 更大真实形变更小；保存重开保材料', options, async () => {
    const base = await mkdtemp(join(tmpdir(), 'lyapunov-flex-'))
    const provider = new MuJoCoProvider({ pythonPath: python })
    const source = fixture('flex-elastic-block.xml'), original = await readFile(source, 'utf8')
    try {
      const operations = new SceneOperations(join(base, 'data'))
      let snapshot = await imported(operations, 'flex_material', source, true)
      const handle = await provider.open(snapshot, { ...runtime, worldId: 'flex_material' })
      assert.equal(handle.engineVersion, '3.13.0')
      const before = await provider.observe(handle.worldId), beforeGeometry = geometry(before)
      assert.equal(beforeGeometry.kind, 'mesh')
      assert.equal(beforeGeometry.nativeName, 'block')
      assert.equal(beforeGeometry.positionsM.length, 27 * 3)
      assert.ok(beforeGeometry.kind === 'mesh' && beforeGeometry.indices.length > 0 && beforeGeometry.indices.every(index => index >= 0 && index < 27))
      // 第一个 pin 的源坐标 (-.05,-.05,.10)，经声明的 z+90° 与平移变为 (.75,-.25,.40)。
      assert.ok(beforeGeometry.positionsM.slice(0, 3).every((value, index) => Math.abs(value - [.75, -.25, .40][index]!) < 1e-8))
      assert.deepEqual(sample(before).transform.position, [.7, -.2, .3], '实体安装根不能冒充某个可动顶点')
      assert.equal(physics(before).flex[0].poisson, .3)
      assert.equal(physics(before).integrator.effective, 'mjINT_DISCRETE')
      const soft = await atTime(provider, handle.worldId, 1.2), softSag = sag(beforeGeometry, geometry(soft))
      snapshot = await material(operations, snapshot, 'flexMaterials', { block: { youngPa: 20_000, poisson: .3, rayleighDamping: .001 } })
      const rebuilt = await provider.sync(handle.worldId, snapshot)
      assert.equal(rebuilt.worldGeneration, handle.worldGeneration + 1)
      const stifferBefore = await provider.observe(handle.worldId)
      const stiff = await atTime(provider, handle.worldId, 1.2), stiffSag = sag(geometry(stifferBefore), geometry(stiff))
      assert.ok(softSag > .01 && stiffSag > 0 && softSag > stiffSag * 3, `真实同载荷挠度：2000Pa=${softSag}m，20000Pa=${stiffSag}m`)
      assert.equal(physics(stiff).flex[0].youngPa, 20_000)
      assert.equal(physics(stiff).flex[0].source.youngPa, 2_000, '覆盖值与源材料必须可区分')
      assert.equal(physics(stiff).flex[0].rayleighDamping, .001)
      assert.ok(geometry(stiff).positionsM.slice(0, 3).every((value, index) => Math.abs(value - [.75, -.25, .40][index]!) < 1e-8), '受载后 pin 仍真实固定')
      const reopened = await reopenPortable(operations, snapshot, base, provider)
      assert.equal(physics(reopened).flex[0].youngPa, 20_000)
      assert.equal(physics(reopened).flex[0].source.youngPa, 2_000)
      assert.equal(await readFile(source, 'utf8'), original, '原件字节不能被材料覆盖或保存回写')
      console.log(JSON.stringify({ evidence: 'flex-native-provider', python, engineVersion: handle.engineVersion, softSagM: softSag, stiffSagM: stiffSag, integrator: physics(stiff).integrator, portableReopened: true }))
    } finally {
      await provider.dispose()
      await rm(base, { recursive: true, force: true })
    }
  })

  test('flex 与地面真实接触读回原生 flex 名，geom=-1 不误归普通 geom', options, async () => {
    const provider = new MuJoCoProvider({ pythonPath: python })
    const xml = (await readFile(fixture('flex-elastic-block.xml'), 'utf8')).replace('<pin gridrange="0 0 0 0 2 2"/>', '')
    const snapshot = { sceneId: 'flex_contact', revision: 0,
      coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' },
      entities: [
        { entityId: 'sample', name: '弹性块', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [], components: { mujoco: { xml } } },
        { entityId: 'sentinel', name: '远处刚体', transform: { position: [10, 10, 10], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [], components: { collision: { shape: 'sphere', halfExtents: [.05, 0, 0] } } },
      ] } as SceneSnapshot
    try {
      await provider.open(snapshot, { ...runtime, worldId: snapshot.sceneId })
      const frame = await atTime(provider, snapshot.sceneId, 1.5)
      const contacts = frame.contacts!.filter(contact => [contact.geom1, contact.geom2].includes('sample/block'))
      assert.ok(contacts.length > 0 && contacts.some(contact => Math.hypot(...contact.forceN!) > 0), '必须读到 flex 的真实接触力')
      assert.ok(contacts.every(contact => [contact.geom1, contact.geom2].includes('__ground')))
      assert.ok(contacts.every(contact => contact.positionM?.every(Number.isFinite) && contact.sourceStep === frame.stepIndex))
      assert.ok(!frame.contacts!.some(contact => contact.geom1.includes('sentinel') || contact.geom2.includes('sentinel')))
      assert.equal(sample(frame).tendons, undefined, '实体变形不冒充 tendon')
    } finally { await provider.dispose() }
  })

  test('原生 cable 弯曲、障碍接触与不可伸长；bend 修改进入插件，保存重开保插件', options, async () => {
    const base = await mkdtemp(join(tmpdir(), 'lyapunov-cable-'))
    const provider = new MuJoCoProvider({ pythonPath: python })
    const source = fixture('elastic-cable.xml'), original = await readFile(source, 'utf8')
    try {
      const operations = new SceneOperations(join(base, 'data'))
      let snapshot = await imported(operations, 'cable_material', source)
      snapshot = await operations.scene.commit({ sceneId: snapshot.sceneId, expectedRevision: snapshot.revision, patch: [{ op: 'add', entity: {
        entityId: 'obstacle', name: '缆线障碍', transform: { position: [.25, 0, .18], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [],
        components: { collision: { shape: 'sphere', halfExtents: [.06, 0, 0] }, rigidBody: { type: 'static' } },
      } }] })
      const handle = await provider.open(snapshot, { ...runtime, worldId: snapshot.sceneId })
      const before = geometry(await provider.observe(handle.worldId))
      assert.equal(before.kind, 'lines')
      if (before.kind !== 'lines') assert.fail('原生缆线必须以真实线段读回')
      assert.equal(before.nativeName, 'compositewire')
      assert.equal(before.indices.length / 2, 12)
      assert.equal(before.radiusM, .01)
      assert.equal(before.nativeBodyNames?.length, 12)
      assert.ok(before.nativeBodyNames!.includes('wireB_first') && before.nativeBodyNames!.includes('wireB_last'))
      const lengths = (value: typeof before) => Array.from({ length: value.indices.length / 2 }, (_, index) => {
        const left = value.indices[index * 2]! * 3, right = value.indices[index * 2 + 1]! * 3
        return Math.hypot(...[0, 1, 2].map(axis => value.positionsM[left + axis]! - value.positionsM[right + axis]!))
      })
      // composite 网格顶点按 float32 展开，源 .6m 的原生总长为 .60000002384m；
      // 尺寸声明允许这一级舍入，下面受载前后每段长度的判据仍为 1e-8m。
      assert.ok(Math.abs(lengths(before).reduce((a, b) => a + b, 0) - .6) < 1e-7)
      let obstacleContact = false, maxContactForceN = 0
      const soft = await atTime(provider, handle.worldId, 2.5, frame => {
        for (const contact of frame.contacts ?? []) if ([contact.geom1, contact.geom2].includes('obstacle/geom') && [contact.geom1, contact.geom2].some(name => name.startsWith('sample/'))) {
          obstacleContact = true; maxContactForceN = Math.max(maxContactForceN, Math.hypot(...contact.forceN!))
        }
      })
      const softGeometry = geometry(soft), softSag = sag(before, softGeometry)
      assert.ok(softSag > .15 && obstacleContact && maxContactForceN > 0, '缆线必须真实下垂、弯曲并与障碍接触')
      assert.ok(softGeometry.kind === 'lines' && lengths(softGeometry).every((length, index) => Math.abs(length - lengths(before)[index]!) < 1e-8), '不可伸长来自原生运动学链')
      assert.equal(physics(soft).cable[0].model, 'mujoco.elasticity.cable')
      assert.equal(physics(soft).cable[0].inextensible, true)
      assert.equal(physics(soft).cable[0].twistPa, 1e6)
      assert.equal(sample(soft).tendons, undefined)
      snapshot = await material(operations, snapshot, 'cableMaterials', { compositewire: { bendPa: 1e8, twistPa: 1e6 } })
      await provider.sync(handle.worldId, snapshot)
      const stiffBefore = geometry(await provider.observe(handle.worldId))
      const stiff = await atTime(provider, handle.worldId, 2.5), stiffSag = sag(stiffBefore, geometry(stiff))
      assert.ok(stiffSag < softSag / 3, `插件 bend 的真实作用：1e6Pa=${softSag}m，1e8Pa=${stiffSag}m`)
      assert.equal(physics(stiff).cable[0].bendPa, 1e8)
      assert.equal(physics(stiff).cable[0].source.bendPa, 1e6)
      const reopened = await reopenPortable(operations, snapshot, base, provider)
      assert.equal(physics(reopened).cable[0].bendPa, 1e8)
      assert.equal(physics(reopened).cable[0].twistPa, 1e6)
      assert.equal(await readFile(source, 'utf8'), original)
      console.log(JSON.stringify({ evidence: 'cable-native-provider', python, engineVersion: handle.engineVersion, softSagM: softSag, stiffSagM: stiffSag, obstacleContact, maxContactForceN, inextensible: true, portableReopened: true }))
    } finally {
      await provider.dispose()
      await rm(base, { recursive: true, force: true })
    }
  })
})
