/**
 * R-014：局部装配 Undo 复用真实 SceneStore 历史（临时私有目录），不新建第二套历史库。
 *
 * 判定只看外部回执与真实落盘：绑定变化→后来的无关编辑→局部 Undo 必须保留无关编辑；
 * 目标绑定被后来编辑、stale revision、资源身份变化都必须明确拒绝；关闭并重建 SceneStore
 * 后既有历史仍能定位；历史缺失明确不可撤销。sim 是无世界替身：本文件测的是**声明层**
 * 恢复与待同步事实，真实原生回读在 packages/sim-mujoco/test/action-window.test.ts。
 */
import { test, expect } from 'bun:test'
import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { SceneOperations } from '../../scene-kit/src/operations.ts'
import { SceneStore } from '../../scene-kit/src/store.ts'
import { readRobotAssemblyHistory, undoRobotAssembly } from '../src/assembly-history.ts'
import { setRobotBase, syncRobotConfiguration } from '../src/authoring.ts'
import type { SceneReader } from '../src/operations.ts'
import type { SimWorlds } from '../../sim-contract/src/index.ts'

const sim = { listWorlds: async () => [] } as unknown as SimWorlds
const identity = () => ({ position: [0, 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] })
const binding = (z: number) => ({ mode: 'fixed', bodyName: 'mount', target: { entityId: 'parent', bodyName: 'base', positionM: [0, 0, z], quaternionXyzw: [0, 0, 0, 1] } })
/** 世界锚点绑定（不带目标实体），用于直接驱动 setRobotBase 的 fixed 路径。 */
const worldBinding = (z: number) => ({ mode: 'fixed', bodyName: 'mount', target: { positionM: [0, 0, z] as [number, number, number], quaternionXyzw: [0, 0, 0, 1] as [number, number, number, number] } })
const resource = (resourceId = 'arm') => [{ resourceId, version: 1, original: { uri: `file:///tmp/${resourceId}.xml`, mimeType: 'application/x-mjcf+xml' }, representations: [], source: { units: 'm', upAxis: 'Z' as const, handedness: 'right' as const } }]
const entity = (entityId: string, components: Record<string, unknown>, position: [number, number, number] = [0, 0, 0]) => ({ entityId, name: entityId, transform: { ...identity(), position }, resources: resource(), components })

test('真实 SceneStore：绑定变化→无关编辑→局部 Undo 保留后来的无关编辑与其它实体', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-assembly-undo-'))
  try {
    const ops = new SceneOperations(root)
    const created = await ops.create({ sceneId: 'asm', template: 'blank' })
    const a = binding(0), b = binding(0.3)
    // rev1：child 声明固定到 parent，other 是一个无关实体。
    await ops.scene.commit({ sceneId: 'asm', expectedRevision: created.revision, patch: [
      { op: 'add', entity: entity('parent', { mujoco: {} }) as never },
      { op: 'add', entity: entity('child', { mujoco: {}, baseBinding: a }) as never },
      { op: 'add', entity: entity('other', {}, [1, 0, 0]) as never },
    ] })
    // rev2：后来的无关编辑（改 other 位置；不动任何绑定字段）。
    const edited = await ops.scene.commit({ sceneId: 'asm', expectedRevision: 1, patch: [{ op: 'update', entityId: 'other', changes: { transform: { ...identity(), position: [2, 0, 0] } } }] })
    expect(edited.revision).toBe(2)
    // rev3：目标绑定被改为 B。
    const rebind = await ops.scene.commit({ sceneId: 'asm', expectedRevision: 2, patch: [{ op: 'update', entityId: 'child', changes: { components: { mujoco: {}, baseBinding: b } } }] })
    expect(rebind.revision).toBe(3)

    // 绑定变化只有两条：rev0→rev1（新增并声明 A）与 rev2→rev3（A→B）；rev1→rev2 的无关编辑不产生假装配事件。
    const history = await readRobotAssemblyHistory(ops.scene, { sceneId: 'asm', entityId: 'child' })
    expect(history.revision).toBe(3)
    expect(history.entries).toHaveLength(2)
    const entry = history.entries.find(item => item.afterRevision === 3)!
    expect(entry.field).toBe('baseBinding')
    expect(entry.beforeRevision).toBe(2)
    expect(entry.afterRevision).toBe(3)
    expect(entry.before).toEqual(a)
    expect(entry.after).toEqual(b)
    expect(entry.undoable).toBe(true)

    // 局部 Undo：按当前 revision CAS 只回填绑定字段。
    const undone = await undoRobotAssembly(sim, ops.scene, { sceneId: 'asm', entityId: 'child', expectedRevision: 3, field: 'baseBinding', beforeRevision: 2, afterRevision: 3 })
    expect(undone.saved).toBe(true)
    expect(undone.revision).toBe(4)
    // 无 world：声明已恢复，物理待同步；不伪造 native 事实。
    expect(undone.syncRequired).toBe(true)
    expect(undone.sync).toBe('REQUIRED')
    expect(undone.reason).toContain('ROBOT_CONFIGURATION_WORLD_NOT_OPEN')
    const child = undone.snapshot.entities.find(item => item.entityId === 'child')!
    expect(child.components.baseBinding).toEqual(a)
    // 后来的无关编辑（other 的位置）与其它实体原样保留。
    expect(undone.snapshot.entities.find(item => item.entityId === 'other')!.transform.position).toEqual([2, 0, 0])
    expect(undone.snapshot.entities.map(item => item.entityId).sort()).toEqual(['child', 'other', 'parent'])
    // 真实落盘与新 SceneStore 一致。
    expect(await new SceneStore(root).snapshot('asm')).toEqual(undone.snapshot)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('目标绑定被后来编辑：局部 Undo 明确拒绝，不覆盖后续改动', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-assembly-conflict-'))
  try {
    const ops = new SceneOperations(root)
    const created = await ops.create({ sceneId: 'conflict', template: 'blank' })
    await ops.scene.commit({ sceneId: 'conflict', expectedRevision: created.revision, patch: [{ op: 'add', entity: entity('child', { mujoco: {}, baseBinding: binding(0) }) as never }] })
    await ops.scene.commit({ sceneId: 'conflict', expectedRevision: 1, patch: [{ op: 'update', entityId: 'child', changes: { components: { mujoco: {}, baseBinding: binding(0.3) } } }] })
    // 之后又改成 C：当前值已不等于 rev1→rev2 那次的 after（B）。
    await ops.scene.commit({ sceneId: 'conflict', expectedRevision: 2, patch: [{ op: 'update', entityId: 'child', changes: { components: { mujoco: {}, baseBinding: binding(0.6) } } }] })
    await expect(undoRobotAssembly(sim, ops.scene, { sceneId: 'conflict', entityId: 'child', expectedRevision: 3, field: 'baseBinding', beforeRevision: 1, afterRevision: 2 }))
      .rejects.toThrow('ROBOT_ASSEMBLY_CONFLICT')
    expect((await ops.scene.snapshot('conflict')).revision).toBe(3)
    expect((await ops.scene.snapshot('conflict')).entities[0]!.components.baseBinding).toEqual(binding(0.6))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('stale revision 与资源身份变化：拒绝且零写入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-assembly-stale-'))
  try {
    const ops = new SceneOperations(root)
    const created = await ops.create({ sceneId: 'stale', template: 'blank' })
    await ops.scene.commit({ sceneId: 'stale', expectedRevision: created.revision, patch: [{ op: 'add', entity: entity('child', { mujoco: {}, baseBinding: binding(0) }) as never }] })
    await ops.scene.commit({ sceneId: 'stale', expectedRevision: 1, patch: [{ op: 'update', entityId: 'child', changes: { components: { mujoco: {}, baseBinding: binding(0.3) } } }] })
    // stale expectedRevision：明确无写入。
    await expect(undoRobotAssembly(sim, ops.scene, { sceneId: 'stale', entityId: 'child', expectedRevision: 1, field: 'baseBinding', beforeRevision: 1, afterRevision: 2 }))
      .rejects.toThrow('SCENE_REVISION_MISMATCH')
    expect((await ops.scene.snapshot('stale')).revision).toBe(2)
    // 资源身份变化：换 resourceId 后再 Undo 必须拒绝。
    await ops.scene.commit({ sceneId: 'stale', expectedRevision: 2, patch: [{ op: 'update', entityId: 'child', changes: { resources: resource('other-arm') } }] })
    await expect(undoRobotAssembly(sim, ops.scene, { sceneId: 'stale', entityId: 'child', expectedRevision: 3, field: 'baseBinding', beforeRevision: 1, afterRevision: 2 }))
      .rejects.toThrow('ROBOT_ASSEMBLY_RESOURCE_CHANGED')
    expect((await ops.scene.snapshot('stale')).revision).toBe(3)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('历史不可用/版本缺失：明确不可撤销，不猜 before', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-assembly-missing-'))
  try {
    const ops = new SceneOperations(root)
    await ops.create({ sceneId: 'missing', template: 'blank' })
    const minimal: SceneReader = { snapshot: id => ops.scene.snapshot(id), commit: input => ops.scene.commit(input) }
    await expect(readRobotAssemblyHistory(minimal, { sceneId: 'missing', entityId: 'child' })).rejects.toThrow('SCENE_HISTORY_UNAVAILABLE')
    await expect(undoRobotAssembly(sim, minimal, { sceneId: 'missing', entityId: 'child', expectedRevision: 0, field: 'baseBinding', beforeRevision: 0, afterRevision: 0 })).rejects.toThrow('SCENE_HISTORY_UNAVAILABLE')
    // 版本缺失：owner 有历史接口，但被撤掉的那一版必须点名报错，不向当前版本退化猜测。
    await ops.scene.commit({ sceneId: 'missing', expectedRevision: 0, patch: [{ op: 'add', entity: entity('child', { mujoco: {}, baseBinding: binding(0) }) as never }] })
    await rm(join(root, 'scenes', '.history', 'missing'), { recursive: true, force: true })
    await ops.scene.commit({ sceneId: 'missing', expectedRevision: 1, patch: [{ op: 'update', entityId: 'child', changes: { components: { mujoco: {}, baseBinding: binding(0.3) } } }] })
    await expect(undoRobotAssembly(sim, ops.scene, { sceneId: 'missing', entityId: 'child', expectedRevision: 2, field: 'baseBinding', beforeRevision: 0, afterRevision: 1 }))
      .rejects.toThrow('ROBOT_ASSEMBLY_VERSION_NOT_FOUND')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('重建 SceneStore 后既有历史仍能定位；删除声明与局部 Undo 语义分明', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-assembly-reopen-'))
  try {
    const first = new SceneOperations(root)
    const created = await first.create({ sceneId: 'reopen', template: 'blank' })
    await first.scene.commit({ sceneId: 'reopen', expectedRevision: created.revision, patch: [{ op: 'add', entity: entity('child', { mujoco: {}, baseBinding: binding(0) }) as never }] })
    // 显式“恢复源基座”语义：删除 baseBinding 声明（与局部 Undo 是不同操作、不同回执）。
    await first.scene.commit({ sceneId: 'reopen', expectedRevision: 1, patch: [{ op: 'update', entityId: 'child', changes: { components: { mujoco: {} } } }] })
    // 关闭并重建一个全新的 SceneStore/operations，历史目录仍在磁盘上。
    const reopened = new SceneOperations(root)
    const history = await readRobotAssemblyHistory(reopened.scene, { sceneId: 'reopen', entityId: 'child' })
    // 最新一条是删除声明（A→undefined）；局部 Undo 恢复的是变化**之前**的声明，不是简单的“再删一次”。
    const removal = history.entries.find(item => item.afterRevision === 2)!
    expect(removal.before).toEqual(binding(0))
    expect(removal.after).toBeUndefined()
    expect(removal.undoable).toBe(true)
    const undone = await undoRobotAssembly(sim, reopened.scene, { sceneId: 'reopen', entityId: 'child', expectedRevision: 2, field: 'baseBinding', beforeRevision: 1, afterRevision: 2 })
    expect(undone.snapshot.entities[0]!.components.baseBinding).toEqual(binding(0))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('重复未改变的 robot_set_base 不追加装配历史，也不写新 revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-assembly-unchanged-'))
  try {
    const ops = new SceneOperations(root)
    const created = await ops.create({ sceneId: 'same', template: 'blank' })
    await ops.scene.commit({ sceneId: 'same', expectedRevision: created.revision, patch: [{ op: 'add', entity: entity('child', { mujoco: {}, baseBinding: binding(0) }) as never }] })
    // 最小 SimWorlds 替身：sync 后把 appliedSceneRevision 跟着快照走，observe 回同版本帧。
    const pose = { positionM: [0, 0, 0.5], quaternionXyzw: [0, 0, 0, 1] }
    let applied = 1
    const world = () => ({ worldId: 'w', sceneId: 'same', engineId: 'mujoco', engineVersion: '3', worldGeneration: 1, appliedSceneRevision: applied, status: 'ready' })
    const fake = {
      listWorlds: async () => [world()],
      describe: async () => ({ entityId: 'child', expectedGeneration: 1, nativeBodies: [{ name: 'mount', root: true, jointTypes: ['fixed'] }], nativeSites: [], base: { mode: 'fixed', bodyName: 'mount', source: 'scene-base-binding', reason: 'scene', constraints: [], editable: { fixed: true, free: true, entity: true } } }),
      observe: async () => ({ worldId: 'w', generation: 1, sceneRevision: applied, entities: [{ entityId: 'child', sensors: { robotBase: { worldFromBody: pose } } }] }),
      sync: async (_id: string, snapshot: { revision: number }) => { applied = snapshot.revision; return world() },
    } as unknown as SimWorlds
    const input = (expectedRevision: number) => ({ worldId: 'w', sceneId: 'same', entityId: 'child', expectedRevision, expectedGeneration: 1, base: { mode: 'free', bodyName: 'mount' } })
    const first = await setRobotBase(fake, ops.scene, input(1) as never)
    expect(first.status).toBe('UPDATED')
    expect(first.syncRequired).toBe(false)
    expect(first.assembly?.afterRevision).toBe(2)
    const before = await readRobotAssemblyHistory(ops.scene, { sceneId: 'same', entityId: 'child' })
    expect(before.entries.filter(entry => entry.field === 'baseBinding')).toHaveLength(2)
    // 第二次完全相同的调用：UNCHANGED，无新 revision，无新装配事件。
    const second = await setRobotBase(fake, ops.scene, input(2) as never)
    expect(second.status).toBe('UNCHANGED')
    expect(second.revision).toBe(2)
    expect(second.assembly).toBeUndefined()
    const after = await readRobotAssemblyHistory(ops.scene, { sceneId: 'same', entityId: 'child' })
    expect(after.entries.filter(entry => entry.field === 'baseBinding')).toHaveLength(2)
    expect((await ops.scene.snapshot('same')).revision).toBe(2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('跨模型资源替换的绑定变化：历史标不可局部 Undo，执行入口再次拒绝且零写入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-assembly-resource-'))
  try {
    const ops = new SceneOperations(root)
    const created = await ops.create({ sceneId: 'resource', template: 'blank' })
    await ops.scene.commit({ sceneId: 'resource', expectedRevision: created.revision, patch: [{ op: 'add', entity: entity('child', { mujoco: {}, baseBinding: binding(0) }) as never }] })
    // rev2 同时换掉模型资源与绑定：这不是"只改一个绑定字段"的过渡，不能用单字段逆操作代表完整装配撤销。
    await ops.scene.commit({ sceneId: 'resource', expectedRevision: 1, patch: [{ op: 'update', entityId: 'child', changes: { resources: resource('other-arm') as never, components: { mujoco: {}, baseBinding: binding(0.3) } } }] })
    const history = await readRobotAssemblyHistory(ops.scene, { sceneId: 'resource', entityId: 'child' })
    const entry = history.entries.find(row => row.beforeRevision === 1 && row.afterRevision === 2)!
    expect(entry.undoable).toBe(false)
    expect(entry.reason).toContain('ROBOT_ASSEMBLY_RESOURCE_CHANGED')
    await expect(undoRobotAssembly(sim, ops.scene, { sceneId: 'resource', entityId: 'child', expectedRevision: 2, field: 'baseBinding', beforeRevision: 1, afterRevision: 2 }))
      .rejects.toThrow('ROBOT_ASSEMBLY_RESOURCE_CHANGED')
    const current = await ops.scene.snapshot('resource')
    expect(current.revision).toBe(2)
    expect(current.entities[0]!.resources[0]!.resourceId).toBe('other-arm')
    expect(current.entities[0]!.components.baseBinding).toEqual(binding(0.3))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('历史缺页：不跨缺失版本拼成一次变化；执行入口拒绝且零写入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-assembly-gap-'))
  try {
    const ops = new SceneOperations(root)
    const created = await ops.create({ sceneId: 'gap', template: 'blank' })
    await ops.scene.commit({ sceneId: 'gap', expectedRevision: created.revision, patch: [{ op: 'add', entity: entity('child', { mujoco: {}, baseBinding: binding(0) }) as never }] })
    await ops.scene.commit({ sceneId: 'gap', expectedRevision: 1, patch: [{ op: 'update', entityId: 'child', changes: { components: { mujoco: {}, baseBinding: binding(0.3) } } }] })
    await ops.scene.commit({ sceneId: 'gap', expectedRevision: 2, patch: [{ op: 'update', entityId: 'child', changes: { components: { mujoco: {}, baseBinding: binding(0.6) } } }] })
    // 故障注入：删掉中间那一版，使版本列表出现 1 → 3 的缺口（不恢复故障注入本身）。
    await unlink(join(ops.scene.directory, 'scenes', '.history', 'gap', 'revision-2.json'))
    const history = await readRobotAssemblyHistory(ops.scene, { sceneId: 'gap', entityId: 'child' })
    expect(history.historyComplete).toBe(false)
    expect(history.entries.some(row => row.beforeRevision === 1 && row.afterRevision === 3)).toBe(false)
    // 创建过渡本身也不得被冒称可局部 Undo。
    const creation = history.entries.find(row => row.beforeRevision === 0 && row.afterRevision === 1)!
    expect(creation.undoable).toBe(false)
    expect(creation.reason).toContain('ROBOT_ASSEMBLY_ENTITY_CREATED')
    await expect(undoRobotAssembly(sim, ops.scene, { sceneId: 'gap', entityId: 'child', expectedRevision: 3, field: 'baseBinding', beforeRevision: 1, afterRevision: 3 }))
      .rejects.toThrow('ROBOT_ASSEMBLY_HISTORY_GAP')
    const current = await ops.scene.snapshot('gap')
    expect(current.revision).toBe(3)
    expect(current.entities[0]!.components.baseBinding).toEqual(binding(0.6))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('保存后 describe 读回失败：仍返回 saved 回执与 revision，robotDetail 如实报不可用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-assembly-detail-'))
  try {
    const ops = new SceneOperations(root)
    const created = await ops.create({ sceneId: 'detail', template: 'blank' })
    await ops.scene.commit({ sceneId: 'detail', expectedRevision: created.revision, patch: [{ op: 'add', entity: entity('child', { mujoco: {}, baseBinding: worldBinding(0) }) as never }] })
    let descriptions = 0
    let live: any = { worldId: 'w', sceneId: 'detail', engineId: 'fixture', engineVersion: '1', worldGeneration: 1, appliedSceneRevision: 1, status: 'ready' }
    const fake = {
      listWorlds: async () => [live],
      describe: async () => {
        if (++descriptions > 1) throw new Error('DESCRIPTION_READBACK_FAILED')
        return { entityId: 'child', expectedGeneration: 1, nativeBodies: [{ name: 'mount', root: true, jointTypes: [] }], nativeSites: [], base: { mode: 'fixed', bodyName: 'mount', source: 'scene-base-binding', reason: 'scene', constraints: [], editable: { fixed: true, free: true, entity: true } } }
      },
      observe: async () => ({ worldId: 'w', generation: live.worldGeneration, sceneRevision: live.appliedSceneRevision, entities: [] }),
      sync: async (_id: string, snapshot: { revision: number }) => { live = { ...live, worldGeneration: 2, appliedSceneRevision: snapshot.revision }; return live },
    } as unknown as SimWorlds
    const receipt = await setRobotBase(fake, ops.scene, { worldId: 'w', sceneId: 'detail', entityId: 'child', expectedRevision: 1, expectedGeneration: 1, base: worldBinding(0.3) } as never)
    expect(receipt.saved).toBe(true)
    expect(receipt.revision).toBe(2)
    expect(receipt.syncRequired).toBe(false)
    expect(receipt.robot).toBeUndefined()
    expect(receipt.robotDetail?.status).toBe('UNAVAILABLE')
    expect(receipt.robotDetail?.reason).toContain('ROBOT_DESCRIPTION_READBACK_FAILED')
    // P6B：即便详情读回失败，已保存回执仍是无损 JSON，不得因输出异常诱导模型重复写入。
    expect(snapshotJsonValue(receipt)).toBeDefined()
    const saved = await ops.scene.snapshot('detail')
    expect(saved.revision).toBe(2)
    expect(saved.entities[0]!.components.baseBinding).toEqual(worldBinding(0.3))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('sync 前就拒绝不属于当前 Scene 的 world：不调用 sync、不作原生证据', async () => {
  const snapshot = { sceneId: 's', revision: 7, entities: [] } as never
  let syncCalls = 0
  const foreign = {
    listWorlds: async () => [{ worldId: 'w', sceneId: 'other', engineId: 'x', engineVersion: '1', worldGeneration: 1, appliedSceneRevision: 7, status: 'ready' }],
    sync: async () => { syncCalls++; return { worldId: 'w', sceneId: 'other', engineId: 'x', engineVersion: '1', worldGeneration: 1, appliedSceneRevision: 7, status: 'ready' } },
    observe: async () => ({ worldId: 'w', generation: 1, sceneRevision: 7, entities: [] }),
  } as unknown as SimWorlds
  const outcome = await syncRobotConfiguration(foreign, snapshot, 'w')
  expect(syncCalls).toBe(0)
  expect(outcome.syncRequired).toBe(true)
  expect(outcome.reason).toContain('WORLD_SCENE_MISMATCH')
  expect(outcome.world).toBeUndefined()
})

test('不属于该 world 的同数字 Frame：sync 与 UNCHANGED 分支都拒绝为已同步证据', async () => {
  const snapshot = { sceneId: 's', revision: 7, entities: [] } as never
  const world = { worldId: 'w', sceneId: 's', engineId: 'x', engineVersion: '1', worldGeneration: 1, appliedSceneRevision: 7, status: 'ready' }
  const foreignFrame = { worldId: 'different-world', generation: 1, sceneRevision: 7, entities: [] }
  const syncFake = {
    listWorlds: async () => [world],
    sync: async () => world,
    observe: async () => foreignFrame,
  } as unknown as SimWorlds
  const synced = await syncRobotConfiguration(syncFake, snapshot, 'w')
  expect(synced.syncRequired).toBe(true)
  expect(synced.frame).toBeUndefined()

  // UNCHANGED 读取分支：配置无变化时不重建世界，但也只认属于该 world 的完整帧身份。
  const root = await mkdtemp(join(tmpdir(), 'rc-assembly-unchanged-frame-'))
  try {
    const ops = new SceneOperations(root)
    const created = await ops.create({ sceneId: 'unchanged-frame', template: 'blank' })
    await ops.scene.commit({ sceneId: 'unchanged-frame', expectedRevision: created.revision, patch: [{ op: 'add', entity: entity('child', { mujoco: {}, baseBinding: worldBinding(0.3) }) as never }] })
    const bound = { ...world, sceneId: 'unchanged-frame', appliedSceneRevision: 1 }
    const unchangedFake = {
      listWorlds: async () => [bound],
      describe: async () => ({ entityId: 'child', expectedGeneration: 1, nativeBodies: [{ name: 'mount', root: true, jointTypes: [] }], nativeSites: [], base: { mode: 'fixed', bodyName: 'mount', source: 'scene-base-binding', reason: 'scene', constraints: [], editable: { fixed: true, free: true, entity: true } } }),
      observe: async () => ({ ...foreignFrame, sceneRevision: 1 }),
    } as unknown as SimWorlds
    const receipt = await setRobotBase(unchangedFake, ops.scene, { worldId: 'w', sceneId: 'unchanged-frame', entityId: 'child', expectedRevision: 1, expectedGeneration: 1, base: worldBinding(0.3) } as never)
    expect(receipt.status).toBe('UNCHANGED')
    expect(receipt.saved).toBe(true)
    expect(receipt.syncRequired).toBe(true)
    expect(receipt.frame).toBeUndefined()
    expect(receipt.reason).toContain('ROBOT_CONFIGURATION_FRAME_STALE')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('P6B：缺省 before/after 省略键（不是 undefined、不冒充 null），回执与历史整份无损 JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-assembly-json-'))
  try {
    const ops = new SceneOperations(root)
    const created = await ops.create({ sceneId: 'json', template: 'blank' })
    await ops.scene.commit({ sceneId: 'json', expectedRevision: created.revision, patch: [{ op: 'add', entity: entity('child', { mujoco: {} }) as never }] })
    // 最小同步替身：sync 后 appliedSceneRevision 跟着新快照走，observe 回同版本帧。
    let live = { worldId: 'w', sceneId: 'json', engineId: 'mujoco', engineVersion: '3', worldGeneration: 1, appliedSceneRevision: 1, status: 'ready' }
    const fake = {
      listWorlds: async () => [live],
      describe: async () => ({ entityId: 'child', expectedGeneration: live.worldGeneration, nativeBodies: [{ name: 'mount', root: true, jointTypes: ['fixed'] }], nativeSites: [], base: { mode: 'fixed', bodyName: 'mount', source: 'scene-base-binding', reason: 'scene', constraints: [], editable: { fixed: true, free: true, entity: true } } }),
      observe: async () => ({ worldId: 'w', generation: live.worldGeneration, sceneRevision: live.appliedSceneRevision, entities: [{ entityId: 'child', sensors: { robotBase: { worldFromBody: { positionM: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1] } } } }] }),
      sync: async (_id: string, snapshot: { revision: number }) => { live = { ...live, worldGeneration: live.worldGeneration + 1, appliedSceneRevision: snapshot.revision }; return live },
    } as unknown as SimWorlds
    // 首次设置基座：设置前没有 baseBinding ⇒ before 键省略，after 有值。
    const set = await setRobotBase(fake, ops.scene, { worldId: 'w', sceneId: 'json', entityId: 'child', expectedRevision: 1, expectedGeneration: 1, base: worldBinding(0.3) } as never)
    expect(set.assembly).toBeDefined()
    expect('before' in set.assembly!).toBe(false)
    expect(set.assembly!.after).toEqual(worldBinding(0.3))
    expect(snapshotJsonValue(set)).toBeDefined()
    const history = await readRobotAssemblyHistory(ops.scene, { sceneId: 'json', entityId: 'child' })
    const first = history.entries.find(row => row.beforeRevision === 1 && row.afterRevision === 2)!
    expect('before' in first).toBe(false)
    expect(first.after).toEqual(worldBinding(0.3))
    expect(snapshotJsonValue(history)).toBeDefined()
    // 恢复源基座（删除声明）：after 键省略，before 有值；局部 Undo 仍恢复"删除该字段"。
    const restored = await setRobotBase(fake, ops.scene, { worldId: 'w', sceneId: 'json', entityId: 'child', expectedRevision: 2, expectedGeneration: 2, base: { mode: 'source', bodyName: 'mount' } } as never)
    expect(restored.assembly).toBeDefined()
    expect('after' in restored.assembly!).toBe(false)
    expect(restored.assembly!.before).toEqual(worldBinding(0.3))
    expect(snapshotJsonValue(restored)).toBeDefined()
    const undone = await undoRobotAssembly(fake, ops.scene, { sceneId: 'json', entityId: 'child', expectedRevision: 3, worldId: 'w', field: 'baseBinding', beforeRevision: 2, afterRevision: 3 })
    expect(undone.snapshot.entities[0]!.components.baseBinding).toEqual(worldBinding(0.3))
    // 用户数据里的 null 是真实值：必须原样保留为 null，不能与"缺省"混为一谈。
    await ops.scene.commit({ sceneId: 'json', expectedRevision: 4, patch: [{ op: 'update', entityId: 'child', changes: { components: { mujoco: {}, controller: { tcp: null } } } }] })
    const withNull = await readRobotAssemblyHistory(ops.scene, { sceneId: 'json', entityId: 'child' })
    const tcpEntry = withNull.entries.find(row => row.field === 'controller.tcp' && row.afterRevision === 5)!
    expect('after' in tcpEntry).toBe(true)
    expect(tcpEntry.after).toBeNull()
    expect(snapshotJsonValue(withNull)).toBeDefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})
