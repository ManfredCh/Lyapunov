/**
 * R-012：源安装点保存/复用、真实检查读回、Replace 的窄多实体 CAS 与多条目受保护 Undo。
 *
 * 真实 SceneStore（临时私有目录）+ 注入的只读/同步替身；本文件不冒充真实引擎，只钉声明与回执语义。
 * 真实原生挂接读回由 packages/sim-mujoco/test/action-window.test.ts 与主控原生探针覆盖。
 */
import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { SceneOperations } from '../../scene-kit/src/operations.ts'
import { checkRobotAssembly, replaceRobotAssembly, saveRobotAssemblyMount } from '../src/assembly-actions.ts'
import { setRobotBase } from '../src/authoring.ts'
import { readRobotAssemblyHistory, undoRobotAssembly } from '../src/assembly-history.ts'
import type { SceneReader } from '../src/operations.ts'
import type { SimWorlds } from '../../sim-contract/src/index.ts'

const identity = () => ({ position: [0, 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] })
const resource = (resourceId = 'hand', version = 1) => [{ resourceId, version, original: { uri: `file:///tmp/${resourceId}.xml`, mimeType: 'application/x-mjcf+xml' }, representations: [], source: { units: 'm', upAxis: 'Z' as const, handedness: 'right' as const } }]
const entity = (entityId: string, components: Record<string, unknown> = {}, resources = resource()) => ({ entityId, name: entityId, transform: identity(), resources, components })

const handDescription = {
  entityId: 'hand', expectedGeneration: 2,
  nativeBodies: [{ name: 'palm', root: true, jointTypes: ['free'] }, { name: 'bracket', parentName: 'palm', root: false, jointTypes: ['fixed'] }],
  nativeSites: [{ name: 'socket', bodyName: 'bracket', positionM: [0, 0, 0.2], quaternionXyzw: [0, 0, 0, 1] }],
  base: { bodyName: 'palm', mode: 'free', source: 'native-model', reason: '', constraints: [], editable: { fixed: true, free: true, entity: true } },
}
const targetDescription = {
  entityId: 'target', expectedGeneration: 2,
  nativeBodies: [{ name: 'base', root: true, jointTypes: [] }, { name: 'wrist', parentName: 'base', root: false, jointTypes: ['hinge'] }],
  nativeSites: [], base: { bodyName: 'base', mode: 'fixed', source: 'native-model', reason: '', constraints: [], editable: { fixed: true, free: true, entity: true } },
}
const otherHandDescription = {
  entityId: 'old', expectedGeneration: 2,
  nativeBodies: [{ name: 'palm_old', root: true, jointTypes: ['free'] }], nativeSites: [],
  base: { bodyName: 'palm_old', mode: 'free', source: 'native-model', reason: '', constraints: [], editable: { fixed: true, free: true, entity: true } },
}

function makeSim(ops: SceneOperations, revisionRef: { value: number }) {
  return {
    listWorlds: async () => [{ worldId: 'w', sceneId: 's', engineId: 'fake', engineVersion: '1', worldGeneration: 2, appliedSceneRevision: revisionRef.value, status: 'ready' }],
    describe: async (_worldId: string, entityId: string) => entityId === 'hand' ? handDescription : entityId === 'old' ? otherHandDescription : targetDescription,
    sync: async (worldId: string, snapshot: { sceneId: string; revision: number }) => ({ worldId, sceneId: snapshot.sceneId, engineId: 'fake', engineVersion: '1', worldGeneration: 2, appliedSceneRevision: snapshot.revision, status: 'ready' }),
    observe: async (worldId: string, options?: { contacts?: boolean }) => ({
      worldId, generation: 2, sceneRevision: revisionRef.value, frameId: 'f', stepIndex: 1,
      entities: [
        { entityId: 'hand', transform: identity(), joints: { names: ['j1', 'j2'], positions: [0.1, 0.2], velocities: [0, 0] }, sensors: { bodyWorldPoses: { palm: { bodyName: 'palm', positionM: [0, 0, 1], quaternionXyzw: [0, 0, 0, 1] } } } },
        { entityId: 'old', transform: identity(), sensors: { bodyWorldPoses: { palm_old: { bodyName: 'palm_old', positionM: [1, 2, 3], quaternionXyzw: [0, 0, 0, 1] } } } },
        { entityId: 'target', transform: identity(), sensors: { bodyWorldPoses: { wrist: { bodyName: 'wrist', positionM: [0, 0, 0.5], quaternionXyzw: [0, 0, 0, 1] } } } },
      ],
      ...(options?.contacts ? { contacts: [{ geom1: 'g1', geom2: 'g2', forceN: [1, 0, 0] }] } : {}),
    }),
    receipt: async () => ({ actionId: 'a1', status: 'completed' }),
  } as unknown as SimWorlds
}

test('robot_assembly_mount：按真实 describe 校验并绑定资源版本；资源变化后读取即失效', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-mount-'))
  try {
    const ops = new SceneOperations(root)
    const created = await ops.create({ sceneId: 's', template: 'blank' })
    const revisionRef = { value: created.revision }
    await ops.scene.commit({ sceneId: 's', expectedRevision: created.revision, patch: [{ op: 'add', entity: entity('hand', { mujoco: {} }) as never }] })
    revisionRef.value = 1
    const sim = makeSim(ops, revisionRef)
    const saved = await saveRobotAssemblyMount(sim, ops.scene, { sceneId: 's', entityId: 'hand', expectedRevision: 1, save: { kind: 'site', bodyName: 'bracket', site: 'socket' }, worldId: 'w', expectedGeneration: 2 })
    expect(saved.changed).toBe(true)
    expect(saved.mount).toMatchObject({ resourceId: 'hand', resourceVersion: 1, rootBodyName: 'palm', mount: { kind: 'site', bodyName: 'bracket', site: 'socket' } })
    // 只读查询命中同资源。
    const read = await saveRobotAssemblyMount(sim, ops.scene, { sceneId: 's', entityId: 'hand', expectedRevision: saved.revision })
    expect(read.mount?.rootBodyName).toBe('palm')
    expect(read.stale).toBeUndefined()
    // 换资源版本后，保存点必须明确失效，不能悄悄复用。
    await ops.scene.commit({ sceneId: 's', expectedRevision: saved.revision, patch: [{ op: 'update', entityId: 'hand', changes: { resources: resource('hand', 2) } }] })
    const stale = await saveRobotAssemblyMount(sim, ops.scene, { sceneId: 's', entityId: 'hand', expectedRevision: saved.revision + 1 })
    expect(stale.stale).toBe(true)
    expect(stale.reason).toContain('ROBOT_ASSEMBLY_MOUNT_STALE')
    // 不存在的 site：明确拒绝且不写入。
    await expect(saveRobotAssemblyMount(sim, ops.scene, { sceneId: 's', entityId: 'hand', expectedRevision: saved.revision + 1, save: { kind: 'site', bodyName: 'bracket', site: 'nope' }, worldId: 'w', expectedGeneration: 2 })).rejects.toThrow(/MOUNT_SITE_MISSING/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('robot_assembly_check：无 world 只有声明；有 world 时读回 native 绑定/相对位姿/关节/接触与挂接清单', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-check-'))
  try {
    const ops = new SceneOperations(root)
    const created = await ops.create({ sceneId: 's', template: 'blank' })
    const binding = { mode: 'fixed', bodyName: 'palm', target: { entityId: 'target', bodyName: 'wrist', positionM: [0, 0, -0.5], quaternionXyzw: [0, 0, 0, 1] } }
    await ops.scene.commit({ sceneId: 's', expectedRevision: created.revision, patch: [
      { op: 'add', entity: entity('hand', { mujoco: {}, baseBinding: binding }) as never },
      { op: 'add', entity: entity('target', { mujoco: {} }) as never },
    ] })
    const revisionRef = { value: 1 }
    const sim = makeSim(ops, revisionRef)
    const noWorld = await checkRobotAssembly(sim, ops.scene, { sceneId: 's', entityId: 'hand' })
    expect(noWorld.savedBinding).toEqual(binding as never)
    expect(noWorld.checked.binding).toBe(true)
    expect(noWorld.checked.relativePose).toBe(false)
    expect(noWorld.notes.join(' ')).toContain('No worldId')
    const withWorld = await checkRobotAssembly(sim, ops.scene, { sceneId: 's', entityId: 'hand', worldId: 'w', expectedGeneration: 2, contacts: true, actionId: 'a1' })
    expect(withWorld.frame?.sceneRevision).toBe(1)
    expect(withWorld.nativeBase?.worldFromBody?.positionM).toEqual([0, 0, 1])
    expect(withWorld.checked.relativePose).toBe(true)
    expect(withWorld.joints?.count).toBe(2)
    expect(withWorld.checked.contacts).toBe(true)
    expect(withWorld.checked.actionReceipt).toBe(true)
    // 挂接清单从 baseBinding 派生：目标视角必须看到 hand，且 parentId 不参与。
    const targetView = await checkRobotAssembly(sim, ops.scene, { sceneId: 's', entityId: 'target', worldId: 'w', expectedGeneration: 2 })
    expect(targetView.attachments.map(entry => entry.entityId)).toEqual(['hand'])
    expect(targetView.attachments[0]!.saved).toEqual(binding as never)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('robot_assembly_replace：新末端固定、旧末端留置一次 CAS；多条目 Undo 恢复双方且保留后来无关编辑', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-replace-'))
  try {
    const ops = new SceneOperations(root)
    const created = await ops.create({ sceneId: 's', template: 'blank' })
    const oldBinding = { mode: 'fixed', bodyName: 'palm_old', target: { entityId: 'target', bodyName: 'wrist', positionM: [0, 0, -0.5], quaternionXyzw: [0, 0, 0, 1] } }
    await ops.scene.commit({ sceneId: 's', expectedRevision: created.revision, patch: [
      { op: 'add', entity: entity('old', { mujoco: {}, baseBinding: oldBinding }) as never },
      { op: 'add', entity: entity('hand', { mujoco: {} }) as never },
      { op: 'add', entity: entity('target', { mujoco: {} }) as never },
      { op: 'add', entity: entity('other', {}) as never },
    ] })
    const revisionRef = { value: 1 }
    const sim = makeSim(ops, revisionRef)
    const result = await replaceRobotAssembly(sim, ops.scene, {
      sceneId: 's', worldId: 'w', expectedRevision: 1, expectedGeneration: 2,
      newEntityId: 'hand', newBase: { mode: 'fixed', bodyName: 'palm', target: { entityId: 'target', bodyName: 'wrist', positionM: [0, 0, -0.6], quaternionXyzw: [0, 0, 0, 1] } },
      oldEntityId: 'old', oldParkingPose: { positionM: [1.5, 2, 3], quaternionXyzw: [0, 0, 0, 1] },
    })
    revisionRef.value = result.revision
    expect(result.revision).toBe(2)
    expect(result.changes).toHaveLength(2)
    // P6B：新件本来没有绑定 ⇒ before 键省略（不是 undefined、不冒充 null）；整份 Replace 回执无损 JSON。
    const newChange = result.changes.find(change => change.replace?.role === 'new')!
    const oldChange = result.changes.find(change => change.replace?.role === 'old')!
    expect('before' in newChange).toBe(false)
    expect(newChange.after).toBeDefined()
    expect(oldChange.before).toBeDefined()
    expect(oldChange.after).toBeDefined()
    expect(snapshotJsonValue(result)).toBeDefined()
    // 双方 changes 携带同一 operationId 的 Replace 成员标记，供既有历史成组发现。
    expect(result.changes[0]!.replace?.operationId).toBe(result.changes[1]!.replace?.operationId)
    expect(result.changes.map(change => change.replace?.role).sort()).toEqual(['new', 'old'])
    const newEntity = result.snapshot.entities.find(item => item.entityId === 'hand')!
    const oldEntity = result.snapshot.entities.find(item => item.entityId === 'old')!
    expect((newEntity.components.baseBinding as { target: { bodyName: string } }).target.bodyName).toBe('wrist')
    // 新件绑定使用请求的 newBase，不是复制旧件根偏移。
    expect((newEntity.components.baseBinding as { target: { positionM: number[] } }).target.positionM).toEqual([0, 0, -0.6])
    // 旧末端停放到明确给出的、离开挂载位的世界停放位 [1.5,2,3]，不留在旧挂载位、不跳回源模型原点。
    expect((oldEntity.components.baseBinding as { target: { positionM: number[] } }).target.positionM).toEqual([1.5, 2, 3])
    expect((oldEntity.components.assemblyReplace as { role: string }).role).toBe('old')
    // 后来的无关编辑。
    await ops.scene.commit({ sceneId: 's', expectedRevision: 2, patch: [{ op: 'update', entityId: 'other', changes: { transform: { ...identity(), position: [5, 0, 0] } } }] })
    revisionRef.value = 3
    const beforeRevision = result.changes[0]!.beforeRevision, afterRevision = result.changes[0]!.afterRevision
    const undone = await undoRobotAssembly(sim, ops.scene, {
      sceneId: 's', entityId: 'hand', expectedRevision: 3, worldId: 'w',
      changes: [
        { entityId: 'hand', field: 'baseBinding', beforeRevision, afterRevision },
        { entityId: 'old', field: 'baseBinding', beforeRevision, afterRevision },
      ],
    })
    revisionRef.value = undone.revision
    expect(undone.revision).toBe(4)
    const afterUndo = undone.snapshot
    expect(afterUndo.entities.find(item => item.entityId === 'hand')!.components.baseBinding).toBeUndefined()
    expect(afterUndo.entities.find(item => item.entityId === 'old')!.components.baseBinding).toEqual(oldBinding as never)
    // 后来无关编辑保留。
    expect(afterUndo.entities.find(item => item.entityId === 'other')!.transform.position).toEqual([5, 0, 0])
  } finally { await rm(root, { recursive: true, force: true }) }
})

/** Replace 校验夹具：old 固定在 arm/wrist，new 未绑定，parking 离开 [1,2,3] 挂载位。 */
async function replaceScene() {
  const root = await mkdtemp(join(tmpdir(), 'rc-replace-validate-'))
  const ops = new SceneOperations(root)
  const created = await ops.create({ sceneId: 's', template: 'blank' })
  const oldBinding = { mode: 'fixed', bodyName: 'palm_old', target: { entityId: 'target', bodyName: 'wrist', positionM: [0, 0, -0.5], quaternionXyzw: [0, 0, 0, 1] } }
  await ops.scene.commit({ sceneId: 's', expectedRevision: created.revision, patch: [
    { op: 'add', entity: entity('old', { mujoco: {}, baseBinding: oldBinding }) as never },
    { op: 'add', entity: entity('hand', { mujoco: {} }) as never },
    { op: 'add', entity: entity('target', { mujoco: {} }) as never },
  ] })
  return { root, ops, oldBinding }
}
const validReplace = () => ({ sceneId: 's', worldId: 'w', expectedRevision: 1, expectedGeneration: 2, newEntityId: 'hand', oldEntityId: 'old', newBase: { mode: 'fixed' as const, bodyName: 'palm', target: { entityId: 'target', bodyName: 'wrist', positionM: [0, 0, -0.6] as [number, number, number], quaternionXyzw: [0, 0, 0, 1] as [number, number, number, number] } }, oldParkingPose: { positionM: [1.5, 2, 3] as [number, number, number], quaternionXyzw: [0, 0, 0, 1] as [number, number, number, number] } })

test('robot_assembly_replace：非法输入/非真根 oldBodyName/目标不匹配/停放重合全部 CAS 前拒绝且零写入', async () => {
  const { root, ops, oldBinding } = await replaceScene()
  try {
    const revisionRef = { value: 1 }
    const sim = makeSim(ops, revisionRef)
    const reject = async (mutate: (input: any) => void, pattern: RegExp) => {
      const input: any = validReplace(); mutate(input)
      await expect(replaceRobotAssembly(sim, ops.scene, input)).rejects.toThrow(pattern)
      expect((await ops.scene.snapshot('s')).revision).toBe(1)
    }
    // 全零四元数的目标锚点。
    await reject(input => { input.newBase.target.quaternionXyzw = [0, 0, 0, 0] }, /TARGET_POSE_INVALID/)
    // 非有限数停放位姿。
    await reject(input => { input.oldParkingPose.positionM = [0, Number.NaN, 0] }, /PARKING_POSE_INVALID/)
    // 未给出停放去向：不得默认留在当前挂载位。
    await reject(input => { delete input.oldParkingPose }, /PARKING_REQUIRED/)
    // oldBodyName 不是该实体当前 native 真根（finger 在 Frame 里存在也不行）。
    await reject(input => { input.oldBodyName = 'finger' }, /OLD_BODY_NOT_ROOT/)
    // 旧末端实际挂接目标与所选目标安装位不一致。
    await reject(input => { input.newBase.target.bodyName = 'other-body' }, /TARGET_BODY_MISSING|OLD_TARGET_MISMATCH/)
    // 停放位仍等于旧件当前挂载位 [1,2,3]。
    await reject(input => { input.oldParkingPose.positionM = [1, 2, 3] }, /PARKING_OVERLAP/)
    // 无效输入下旧件的绑定与 revision 一字未动。
    const current = await ops.scene.snapshot('s')
    expect(current.entities.find(item => item.entityId === 'old')!.components.baseBinding).toEqual(oldBinding as never)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('robot_assembly_replace：observe 期间 world 代次变化 / 资源身份变化都在提交前拒绝且零写入', async () => {
  const { root, ops } = await replaceScene()
  try {
    const base = makeSim(ops, { value: 1 })
    // world 在 observe 返回后重建（generation 1→2）。
    let generation = 2, raced = false
    const racy = {
      ...(base as any),
      listWorlds: async () => [{ worldId: 'w', sceneId: 's', engineId: 'fake', engineVersion: '1', worldGeneration: generation, appliedSceneRevision: 1, status: 'ready' }],
      observe: async () => { const frame = await (base as any).observe('w'); if (!raced) { raced = true; generation = 3 } return frame },
    } as unknown as SimWorlds
    await expect(replaceRobotAssembly(racy, ops.scene, validReplace())).rejects.toThrow(/STALE_GENERATION/)
    expect((await ops.scene.snapshot('s')).revision).toBe(1)
    // 资源身份在 observe 期间被换。
    const swapped = {
      ...(base as any),
      observe: async () => {
        const frame = await (base as any).observe('w')
        await ops.scene.commit({ sceneId: 's', expectedRevision: 1, patch: [{ op: 'update', entityId: 'hand', changes: { resources: resource('hand', 2) } }] })
        return frame
      },
    } as unknown as SimWorlds
    await expect(replaceRobotAssembly(swapped, ops.scene, validReplace())).rejects.toThrow(/ROBOT_ASSEMBLY_REPLACE_RESOURCE_CHANGED|SCENE_REVISION_MISMATCH/)
    const after = await ops.scene.snapshot('s')
    expect(after.entities.find(item => item.entityId === 'old')!.components.baseBinding).toBeDefined()
    expect(after.revision).toBe(2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('robot_assembly_replace：明确 free 时停放位姿成为初始世界位姿；history 可发现新旧双方并可重开成组 Undo', async () => {
  const { root, ops, oldBinding } = await replaceScene()
  try {
    const revisionRef = { value: 1 }
    const sim = makeSim(ops, revisionRef)
    const input = validReplace()
    const result = await replaceRobotAssembly(sim, ops.scene, { ...input, oldFree: true })
    revisionRef.value = result.revision
    expect((result.snapshot.entities.find(item => item.entityId === 'old')!.components.baseBinding as any).mode).toBe('free')
    expect((result.snapshot.entities.find(item => item.entityId === 'old')!.components.baseBinding as any).initialWorldPose.positionM).toEqual([1.5, 2, 3])
    // 模拟重开：新建 SceneOperations，仅凭既有磁盘历史发现这次 Replace 的新旧双方。
    const reopened = new SceneOperations(root)
    const history = await readRobotAssemblyHistory(reopened.scene, { sceneId: 's', entityId: 'old' })
    const group = history.replacements?.find(item => item.afterRevision === 2)
    expect(group).toBeDefined()
    expect(group!.members.map(member => member.entityId).sort()).toEqual(['hand', 'old'])
    expect(group!.undoable).toBe(true)
    // 后来无关编辑（other 实体）不能阻止整组撤销，且撤销后保留。
    const edited = await reopened.scene.commit({ sceneId: 's', expectedRevision: 2, patch: [{ op: 'add', entity: entity('other', {}) as never }] })
    const changes = group!.members.map(member => ({ entityId: member.entityId, field: member.field, beforeRevision: group!.beforeRevision, afterRevision: group!.afterRevision }))
    const undone = await undoRobotAssembly(sim, reopened.scene, { sceneId: 's', entityId: 'old', expectedRevision: edited.revision, changes })
    expect(undone.revision).toBe(4)
    const afterUndo = undone.snapshot
    expect(afterUndo.entities.find(item => item.entityId === 'hand')!.components.baseBinding).toBeUndefined()
    expect(afterUndo.entities.find(item => item.entityId === 'old')!.components.baseBinding).toEqual(oldBinding as never)
    expect(afterUndo.entities.some(item => item.entityId === 'other')).toBe(true)
    // 重开后若任一方被后续编辑，成组 Undo 明确冲突、整组不写。
    const again = await readRobotAssemblyHistory(reopened.scene, { sceneId: 's', entityId: 'old' })
    expect(again.replacements?.find(item => item.afterRevision === 2)).toBeDefined()
    const conflicted = await reopened.scene.commit({ sceneId: 's', expectedRevision: 4, patch: [{ op: 'update', entityId: 'hand', changes: { components: { mujoco: {}, baseBinding: { mode: 'fixed', bodyName: 'palm', target: { positionM: [9, 9, 9] as [number, number, number], quaternionXyzw: [0, 0, 0, 1] as [number, number, number, number] } } } } }] })
    const conflictHistory = await readRobotAssemblyHistory(reopened.scene, { sceneId: 's', entityId: 'old' })
    expect(conflictHistory.replacements?.find(item => item.afterRevision === 2)!.undoable).toBe(false)
    await expect(undoRobotAssembly(sim, reopened.scene, { sceneId: 's', entityId: 'old', expectedRevision: conflicted.revision, changes })).rejects.toThrow(/ROBOT_ASSEMBLY_CONFLICT/)
    expect((await reopened.scene.snapshot('s')).revision).toBe(conflicted.revision)
  } finally { await rm(root, { recursive: true, force: true }) }
})

/**
 * 安装资格回归夹具：源实体 `new` 的根含静态 plane（attachable 可切换），目标 `arm` 同时有
 * moving body（wrist，及其 fixed 子 body fixed_tip）与世界静态子 body（static_mount）。
 * 只读 describe/listCameras + 注入 sync/observe；不触真实引擎。
 */
function eligibilitySim(revisionRef: { value: number }, options: { attachable: boolean }) {
  const pose = (x: number, y: number, z: number) => ({ positionM: [x, y, z], quaternionXyzw: [0, 0, 0, 1] })
  const sourceDescription = {
    entityId: 'new', expectedGeneration: 2,
    nativeBodies: [{ name: 'root', root: true, jointTypes: [] }, { name: 'tip', parentName: 'root', root: false, jointTypes: ['hinge'] }],
    nativeSites: [],
    base: { bodyName: 'root', mode: 'fixed', source: 'native-model', reason: '', constraints: [], editable: { fixed: true, free: true, entity: true } },
    installEligibility: options.attachable ? { attachable: true, staticPlaneBodies: [] } : { attachable: false, staticPlaneBodies: ['world'], reason: 'SOURCE_HAS_STATIC_PLANE' },
  }
  const armDescription = {
    entityId: 'arm', expectedGeneration: 2,
    nativeBodies: [
      { name: 'root', root: true, jointTypes: [] },
      { name: 'wrist', parentName: 'root', root: false, jointTypes: ['hinge'] },
      { name: 'fixed_tip', parentName: 'wrist', root: false, jointTypes: [] },
      { name: 'static_mount', parentName: 'root', root: false, jointTypes: [] },
    ],
    nativeSites: [],
    base: { bodyName: 'root', mode: 'fixed', source: 'native-model', reason: '', constraints: [], editable: { fixed: true, free: true, entity: true } },
  }
  const oldDescription = {
    entityId: 'old', expectedGeneration: 2,
    nativeBodies: [{ name: 'palm_old', root: true, jointTypes: ['free'] }], nativeSites: [],
    base: { bodyName: 'palm_old', mode: 'free', source: 'native-model', reason: '', constraints: [], editable: { fixed: true, free: true, entity: true } },
  }
  return {
    listWorlds: async () => [{ worldId: 'w', sceneId: 's', engineId: 'fake', engineVersion: '1', worldGeneration: 2, appliedSceneRevision: revisionRef.value, status: 'ready' }],
    describe: async (_worldId: string, entityId: string) => entityId === 'new' ? sourceDescription : entityId === 'old' ? oldDescription : armDescription,
    listCameras: async () => ({ generation: 2, sceneRevision: revisionRef.value, bodies: ['root', 'wrist', 'fixed_tip', 'static_mount'].map(bodyName => ({ entityId: 'arm', bodyName })) }),
    sync: async (worldId: string, snapshot: { sceneId: string; revision: number }) => ({ worldId, sceneId: snapshot.sceneId, engineId: 'fake', engineVersion: '1', worldGeneration: 2, appliedSceneRevision: snapshot.revision, status: 'ready' }),
    observe: async (worldId: string) => ({
      worldId, generation: 2, sceneRevision: revisionRef.value, frameId: 'f', stepIndex: 1,
      entities: [
        { entityId: 'new', transform: identity(), sensors: { robotBase: { worldFromBody: pose(0, 0, 0) }, bodyWorldPoses: { root: { bodyName: 'root', ...pose(0, 0, 0) } } } },
        { entityId: 'old', transform: identity(), sensors: { bodyWorldPoses: { palm_old: { bodyName: 'palm_old', ...pose(1, 2, 3) } } } },
        { entityId: 'arm', transform: identity(), sensors: { bodyWorldPoses: { wrist: { bodyName: 'wrist', ...pose(0, 0, 0.5) } } } },
      ],
    }),
  } as unknown as SimWorlds
}

test('robot_set_base：静态 plane 源固定到 moving 目标 body（含 fixed 子 body）在 commit 前拒绝且零写入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-setbase-elig-'))
  try {
    const ops = new SceneOperations(root)
    const created = await ops.create({ sceneId: 's', template: 'blank' })
    await ops.scene.commit({ sceneId: 's', expectedRevision: created.revision, patch: [
      { op: 'add', entity: entity('arm', { mujoco: {} }) as never },
      { op: 'add', entity: entity('new', { mujoco: {} }) as never },
    ] })
    const revisionRef = { value: 1 }
    const sim = eligibilitySim(revisionRef, { attachable: false })
    const request = (base: unknown) => ({ sceneId: 's', worldId: 'w', entityId: 'new', expectedRevision: revisionRef.value, expectedGeneration: 2, base } as never)
    const anchored = (bodyName: string, positionM: [number, number, number] = [0, 0, 0]) => ({ mode: 'fixed', bodyName: 'root', target: { entityId: 'arm', bodyName, positionM, quaternionXyzw: [0, 0, 0, 1] } })
    // 直接移动 body 与其 fixed 子 body 都属 moving 父链 ⇒ 都在 CAS 前拒绝，revision 不动。
    await expect(setRobotBase(sim, ops.scene, request(anchored('wrist')))).rejects.toThrow(/SOURCE_NOT_INSTALLABLE/)
    expect((await ops.scene.snapshot('s')).revision).toBe(1)
    await expect(setRobotBase(sim, ops.scene, request(anchored('fixed_tip')))).rejects.toThrow(/SOURCE_NOT_INSTALLABLE/)
    expect((await ops.scene.snapshot('s')).revision).toBe(1)
    // 世界静态子 body 允许：一次 CAS。
    const allowed = await setRobotBase(sim, ops.scene, request(anchored('static_mount', [0, 0, 0.2])))
    expect(allowed.status).toBe('UPDATED')
    expect(allowed.revision).toBe(2)
    revisionRef.value = allowed.revision
    // free 恢复保持允许（真实 MuJoCo 已证明 plane 仍属 world）。
    const freed = await setRobotBase(sim, ops.scene, request({ mode: 'free', bodyName: 'root' }))
    expect(freed.status).toBe('UPDATED')
    revisionRef.value = freed.revision
    // source 恢复声明：删除场景基座声明，不经过资格门。
    const sourced = await setRobotBase(sim, ops.scene, request({ mode: 'source', bodyName: 'root' }))
    expect(sourced.status).toBe('UPDATED')
    expect((await ops.scene.snapshot('s')).entities.find(item => item.entityId === 'new')!.components.baseBinding).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('robot_set_base：可安装本体（attachable=true）固定到 moving 目标 body 仍正常放行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-setbase-clean-'))
  try {
    const ops = new SceneOperations(root)
    const created = await ops.create({ sceneId: 's', template: 'blank' })
    await ops.scene.commit({ sceneId: 's', expectedRevision: created.revision, patch: [
      { op: 'add', entity: entity('arm', { mujoco: {} }) as never },
      { op: 'add', entity: entity('new', { mujoco: {} }) as never },
    ] })
    const revisionRef = { value: 1 }
    const sim = eligibilitySim(revisionRef, { attachable: true })
    const allowed = await setRobotBase(sim, ops.scene, { sceneId: 's', worldId: 'w', entityId: 'new', expectedRevision: 1, expectedGeneration: 2, base: { mode: 'fixed', bodyName: 'root', target: { entityId: 'arm', bodyName: 'wrist', positionM: [0, 0, 0.2], quaternionXyzw: [0, 0, 0, 1] } } } as never)
    expect(allowed.status).toBe('UPDATED')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('robot_assembly_replace：新件含静态 plane 固定到 moving 目标 body 在 CAS 前拒绝且零写入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-replace-elig-'))
  try {
    const ops = new SceneOperations(root)
    const created = await ops.create({ sceneId: 's', template: 'blank' })
    const oldBinding = { mode: 'fixed', bodyName: 'palm_old', target: { entityId: 'arm', bodyName: 'wrist', positionM: [0, 0, -0.5], quaternionXyzw: [0, 0, 0, 1] } }
    await ops.scene.commit({ sceneId: 's', expectedRevision: created.revision, patch: [
      { op: 'add', entity: entity('old', { mujoco: {}, baseBinding: oldBinding }) as never },
      { op: 'add', entity: entity('new', { mujoco: {} }) as never },
      { op: 'add', entity: entity('arm', { mujoco: {} }) as never },
    ] })
    const revisionRef = { value: 1 }
    const sim = eligibilitySim(revisionRef, { attachable: false })
    await expect(replaceRobotAssembly(sim, ops.scene, {
      sceneId: 's', worldId: 'w', expectedRevision: 1, expectedGeneration: 2,
      newEntityId: 'new', oldEntityId: 'old',
      newBase: { mode: 'fixed', bodyName: 'root', target: { entityId: 'arm', bodyName: 'wrist', positionM: [0, 0, -0.6], quaternionXyzw: [0, 0, 0, 1] } },
      oldParkingPose: { positionM: [1.5, 2, 3], quaternionXyzw: [0, 0, 0, 1] },
    })).rejects.toThrow(/SOURCE_NOT_INSTALLABLE/)
    const after = await ops.scene.snapshot('s')
    expect(after.revision).toBe(1)
    expect(after.entities.find(item => item.entityId === 'new')!.components.baseBinding).toBeUndefined()
    expect(after.entities.find(item => item.entityId === 'old')!.components.baseBinding).toEqual(oldBinding as never)
  } finally { await rm(root, { recursive: true, force: true }) }
})
