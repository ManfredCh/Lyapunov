/**
 * R-013／§2.10：内部子树真实拆分的**场景动作层**回归。
 *
 * 真实 SceneStore（临时私有目录）+ 注入的只读/原生替身与**成对派生替身**；本文件钉：
 *  · 一次 CAS 同时切 remaining 资源版本 + join 独立 part 实体，成对标记与控制器迁移；
 *  · 跨切口 controller 映射、过期 CAS、派生期间源实体被改动 → 全部在提交前拒绝，零 Scene 写入；
 *  · precheck 对无结构投影的格式（USD kind=source）给具名 unsupported，零写入；
 *  · 重组恢复原资源版本并移除独立件；资源被改后拒绝；
 *  · 既有 Scene 历史发现成对拆分、受保护局部 Undo 保留后来无关编辑、独立件被改后拒绝。
 *
 * 真实 MuJoCo 3.13 派生/独立重载/DOF 由 packages/scene-kit/test/subtree-native.test.ts 的
 * 原生用例（缺解释器时明确 skip）与主控原生探针覆盖；本文件不冒充原生运行。
 */
import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SceneOperations } from '../../scene-kit/src/operations.ts'
import { precheckRobotAssemblySubtree, extractRobotAssemblySubtree, reassembleRobotAssemblySubtree } from '../src/assembly-extract.ts'
import { readRobotAssemblyHistory, undoRobotAssembly } from '../src/assembly-history.ts'
import type { RobotSubtreeHooks } from '../src/operations.ts'
import type { RobotAnchorPose, RobotSubtreePrecheckResult } from '../../lyapunov-contracts/src/robot-authoring.ts'
import type { SimWorlds } from '../../sim-contract/src/index.ts'

const identity = () => ({ position: [0, 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] })
const ref = (resourceId: string, version = 1) => ({ resourceId, version, original: { uri: `file:///tmp/${resourceId}_v${version}.xml`, mimeType: 'application/x-mjcf+xml' }, representations: [], source: { units: 'm', upAxis: 'Z' as const, handedness: 'right' as const } })
const entity = (entityId: string, components: Record<string, unknown> = {}, resources = [ref(entityId)]) => ({ entityId, name: entityId, transform: identity(), resources, components })

const baseFacts = (): RobotSubtreePrecheckResult => ({
  sceneId: 's', entityId: 'arm', revision: 0,
  source: { resourceId: 'arm', version: 1, sha256: 'a'.repeat(64), format: 'mjcf', path: '/tmp/arm.xml' },
  selectedBody: 'hand', selectedBodyParent: 'arm', supported: true,
  subtree: { bodies: ['hand', 'left_finger', 'right_finger'], joints: ['finger_joint1', 'finger_joint2'], cutJoints: [], actuators: ['actuator8'], tendons: ['split'], equalities: ['equality-0'], sensors: [], meshes: 3, textures: 0 },
  remaining: { bodies: ['base', 'arm'], joints: ['joint1', 'joint2'], actuators: ['actuator1', 'actuator2'], tendons: [], equalities: [], sensors: [] },
  closure: { meshFiles: ['a.stl'], textureFiles: [], copiedBytes: 10 },
  crossEdges: [], warnings: [],
})

const armDescription = {
  entityId: 'arm', expectedGeneration: 2,
  nativeBodies: [
    { name: 'base', root: true, jointTypes: [] },
    { name: 'arm', parentName: 'base', root: false, jointTypes: ['hinge'] },
    { name: 'hand', parentName: 'arm', root: false, jointTypes: [] },
  ],
  nativeSites: [],
  base: { bodyName: 'base', mode: 'fixed', source: 'native-model', reason: '', constraints: [], editable: { fixed: true, free: true, entity: true } },
}

const worldPose = (positionM: [number, number, number]): RobotAnchorPose => ({ positionM, quaternionXyzw: [0, 0, 0, 1] })

function makeSim(revisionRef: { value: number }) {
  return {
    listWorlds: async () => [{ worldId: 'w', sceneId: 's', engineId: 'fake', engineVersion: '1', worldGeneration: 2, appliedSceneRevision: revisionRef.value, status: 'ready' }],
    describe: async () => armDescription,
    sync: async (worldId: string, snapshot: { sceneId: string; revision: number }) => ({ worldId, sceneId: snapshot.sceneId, engineId: 'fake', engineVersion: '1', worldGeneration: 2, appliedSceneRevision: snapshot.revision, status: 'ready' }),
    observe: async (worldId: string) => ({
      worldId, generation: 2, sceneRevision: revisionRef.value, frameId: 'f', stepIndex: 1,
      entities: [{ entityId: 'arm', transform: identity(), sensors: { bodyWorldPoses: { base: worldPose([0, 0, 0]), arm: worldPose([0, 0, 0.5]), hand: worldPose([0, 0, 1]) } } }],
    }),
  } as unknown as SimWorlds
}

function makeHooks(overrides: Partial<RobotSubtreeHooks> = {}): RobotSubtreeHooks {
  return {
    precheck: async () => ({
      resourceId: 'arm', version: 1, path: '/tmp/arm.xml', sha256: 'a'.repeat(64), format: 'mjcf', supported: true,
      facts: {
        source: '/tmp/arm.xml', sourceSha256: 'a'.repeat(64), selectedBody: 'hand', selectedBodyParent: 'arm', supported: true,
        subtree: baseFacts().subtree, remaining: baseFacts().remaining, closure: baseFacts().closure, crossEdges: [], warnings: [], reason: null,
      },
    }),
    derive: async (input) => ({
      derivation: {
        kind: 'subtree-extract', operationId: input.operationId, format: 'mjcf',
        sourceResourceId: 'arm', sourceVersion: 1, sourceSha256: 'a'.repeat(64),
        cutBody: 'hand', cutBodyParent: 'arm',
        remaining: { resourceId: 'arm', version: 2, nq: 2, nu: 2, ntendon: 0, neq: 0 },
        part: { resourceId: 'arm_part', version: 1, entityId: input.partEntityId, nq: 2, nu: 1, ntendon: 1, neq: 1 },
        ...(input.cutPoseInSourceRoot ? { cutPoseInSourceRoot: input.cutPoseInSourceRoot } : {}),
        nameMap: {
          part: {
            bodies: { hand: 'part_hand', left_finger: 'part_left_finger', right_finger: 'part_right_finger' },
            sites: {},
            joints: { finger_joint1: 'part_finger_joint1', finger_joint2: 'part_finger_joint2' },
            actuators: { actuator8: 'part_actuator8' },
          },
          remaining: {
            bodies: { base: 'base', arm: 'arm' },
            sites: {},
            joints: { joint1: 'joint1', joint2: 'joint2' },
            actuators: { actuator1: 'actuator1', actuator2: 'actuator2' },
          },
        },
        jointMap: { partJoints: ['finger_joint1', 'finger_joint2'], remainingJoints: ['joint1', 'joint2'], cutJoints: [] },
        at: new Date().toISOString(),
      },
      remainingRef: ref('arm', 2),
      partRef: ref('arm_part', 1),
    }),
    resourceComponents: async ({ resourceId, version }) => ({ ref: ref(resourceId, version), components: { visual: { kind: 'robot', robot: { format: 'mjcf', resource: `${resourceId}@${version}` } }, mujoco: { sourcePath: `/tmp/${resourceId}_v${version}.xml` }, articulation: { format: 'mjcf' } } }),
    ...overrides,
  }
}

async function seed(root: string) {
  const ops = new SceneOperations(root)
  const created = await ops.create({ sceneId: 's', template: 'blank' })
  return { ops, revisionRef: { value: created.revision } }
}

test('precheck：无结构投影的格式给具名 unsupported 且零 Scene 写入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-subtree-pre-'))
  try {
    const { ops, revisionRef } = await seed(root)
    await ops.scene.commit({ sceneId: 's', expectedRevision: revisionRef.value, patch: [{ op: 'add', entity: entity('arm', { mujoco: {} }) as never }] })
    revisionRef.value = 1
    const hooks = makeHooks({ precheck: async () => ({ resourceId: 'arm', version: 1, path: '/tmp/scene.usd', sha256: 'b'.repeat(64), format: 'source', supported: false, unsupported: { code: 'SUBTREE_FORMAT_UNSUPPORTED', message: 'USD 没有结构 body/link 投影' } }) })
    const result = await precheckRobotAssemblySubtree(ops.scene, hooks, { sceneId: 's', entityId: 'arm', bodyName: 'link7' })
    expect(result.supported).toBe(false)
    expect(result.reason).toContain('SUBTREE_FORMAT_UNSUPPORTED')
    expect(result.crossEdges[0]?.kind).toBe('format')
    expect((await ops.scene.snapshot('s')).revision).toBe(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('extract：一次 CAS 切 remaining 版本 + join part；成对标记与控制器迁移；重组恢复原版本', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-subtree-x-'))
  try {
    const { ops, revisionRef } = await seed(root)
    const controller = { gripper: { jointNames: ['finger_joint1', 'finger_joint2'], actuator: 'actuator8', maxWidthM: 0.08 }, jointKp: { joint1: 10, finger_joint1: 5 }, tcp: { body: 'hand' } }
    await ops.scene.commit({ sceneId: 's', expectedRevision: revisionRef.value, patch: [{ op: 'add', entity: entity('arm', { mujoco: { sourcePath: '/tmp/arm.xml' }, controller }) as never }] })
    revisionRef.value = 1
    const sim = makeSim(revisionRef)
    const result = await extractRobotAssemblySubtree(sim, ops.scene, makeHooks(), { sceneId: 's', entityId: 'arm', bodyName: 'hand', worldId: 'w', expectedRevision: 1, expectedGeneration: 2, partName: 'detached hand' })
    expect(result.status).toBe('UPDATED')
    const snap = await ops.scene.snapshot('s')
    expect(snap.revision).toBe(2)
    const remaining = snap.entities.find(e => e.entityId === 'arm')!
    const part = snap.entities.find(e => e.entityId === result.partEntityId)!
    expect(remaining.resources[0]).toMatchObject({ resourceId: 'arm', version: 2 })
    expect(remaining.components.assemblyMount).toBeUndefined()
    const remainingController = remaining.components.controller as Record<string, any>
    // 夹爪映射整体引用 part 关节 → 迁到独立件；jointKp 按关节名拆开；TCP body=hand 随 part 真实派生名迁移。
    expect(remainingController.gripper).toBeUndefined()
    expect(remainingController.jointKp).toEqual({ joint1: 10 })
    expect(remainingController.tcp).toBeUndefined()
    const partController = part.components.controller as Record<string, any>
    expect(partController.gripper.jointNames).toEqual(['part_finger_joint1', 'part_finger_joint2'])
    expect(partController.gripper.actuator).toBe('part_actuator8')
    expect(partController.jointKp).toEqual({ part_finger_joint1: 5 })
    expect(partController.tcp).toEqual({ body: 'part_hand' })
    // 成对标记。
    expect((remaining.components.subtreeExtract as any).operationId).toBe((part.components.subtreeExtract as any).operationId)
    expect((part.components.subtreeExtract as any).role).toBe('part')
    // 独立件 transform = 切口根帧世界位姿（part 根帧 = 原父 body arm 的世界位姿）；不写世界锚 baseBinding
    // （那会把 part 文件内根 body 的局部安装位移归零，造成瞬移）。
    expect(part.transform.position).toEqual([0, 0, 0.5])
    expect(part.components.baseBinding).toBeUndefined()
    // 重组：恢复原资源版本并移除独立件。
    revisionRef.value = 2
    const reassembled = await reassembleRobotAssemblySubtree(sim, ops.scene, makeHooks(), { sceneId: 's', entityId: 'arm', worldId: 'w', expectedRevision: 2 })
    const after = await ops.scene.snapshot('s')
    expect(after.revision).toBe(3)
    expect(after.entities.find(e => e.entityId === 'arm')!.resources[0]).toMatchObject({ resourceId: 'arm', version: 1 })
    // 恢复的是原资源**完整 ResourceRef**（original.uri 指回 v1，不是只换 id/version 的 v2 引用）。
    expect(after.entities.find(e => e.entityId === 'arm')!.resources[0]!.original.uri).toContain('arm_v1.xml')
    expect(after.entities.some(e => e.entityId === result.partEntityId)).toBe(false)
    expect(reassembled.restoredResource).toEqual({ resourceId: 'arm', version: 1 })
    // 重组恢复被迁走的 controller 映射（夹具未被用户改过）。
    expect(after.entities.find(e => e.entityId === 'arm')!.components.controller).toEqual(controller)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('extract：切口关节被移除（URDF）时其控制器条目具名清理并记入标记，不残留不可驱动项', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-subtree-cut-'))
  try {
    const { ops, revisionRef } = await seed(root)
    await ops.scene.commit({ sceneId: 's', expectedRevision: revisionRef.value, patch: [
      { op: 'add', entity: entity('arm', { mujoco: { sourcePath: '/tmp/arm.urdf' }, controller: { jointKp: { j1: 10, j2: 100 }, jointKd: { j1: 1, j2: 5 } } }) as never },
    ] })
    revisionRef.value = 1
    const sim = makeSim(revisionRef)
    const facts = {
      ...baseFacts(),
      subtree: { ...baseFacts().subtree, joints: ['j2', 'j3'], cutJoints: ['j2'], bodies: ['hand', 'finger'] },
      remaining: { ...baseFacts().remaining, joints: ['j1'] },
    }
    const hooks = makeHooks({
      precheck: async () => ({
        resourceId: 'arm', version: 1, path: '/tmp/arm.urdf', sha256: 'a'.repeat(64), format: 'urdf', supported: true,
        facts: { source: '/tmp/arm.urdf', sourceSha256: 'a'.repeat(64), selectedBody: 'hand', selectedBodyParent: 'arm', supported: true, format: 'urdf', subtree: facts.subtree, remaining: facts.remaining, closure: facts.closure, crossEdges: [], warnings: [], reason: null },
      }),
      derive: async (input) => ({
        derivation: {
          kind: 'subtree-extract', operationId: input.operationId, format: 'urdf', sourceResourceId: 'arm', sourceVersion: 1, sourceSha256: 'a'.repeat(64),
          cutBody: 'hand', cutBodyParent: 'arm', cutJoint: { name: 'j2', parent: 'arm', type: 'revolute' },
          remaining: { resourceId: 'arm', version: 2, nq: 1, nu: 1, ntendon: 0, neq: 0 },
          part: { resourceId: 'arm_part', version: 1, entityId: input.partEntityId, nq: 1, nu: 1, ntendon: 0, neq: 0 },
          nameMap: {
            part: { bodies: { hand: 'hand', finger: 'finger' }, sites: {}, joints: { j3: 'j3' }, actuators: {} },
            remaining: { bodies: { arm: 'arm' }, sites: {}, joints: { j1: 'j1' }, actuators: {} },
          },
          jointMap: { partJoints: ['j2', 'j3'], remainingJoints: ['j1'], cutJoints: ['j2'] },
          at: new Date().toISOString(),
        },
        remainingRef: ref('arm', 2), partRef: ref('arm_part', 1),
      }),
    })
    await extractRobotAssemblySubtree(sim, ops.scene, hooks, { sceneId: 's', entityId: 'arm', bodyName: 'hand', worldId: 'w', expectedRevision: 1, expectedGeneration: 2, partEntityId: 'part-cut' })
    const snap = await ops.scene.snapshot('s')
    const remaining = snap.entities.find(e => e.entityId === 'arm')!
    // j2 是被移除的切口关节：其 jointKp/jointKd 条目被具名清理，不残留不可驱动项；j1 原样保留。
    expect((remaining.components.controller as any).jointKp).toEqual({ j1: 10 })
    expect((remaining.components.controller as any).jointKd).toEqual({ j1: 1 })
    const part = snap.entities.find(e => e.entityId === 'part-cut')!
    expect((part.components.controller as any)?.jointKp ?? {}).toEqual({})
    const marker = remaining.components.subtreeExtract as any
    expect(marker.migrated.invalidated).toEqual(['jointKp.j2', 'jointKd.j2'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('extract：跨切口 controller 映射、过期 CAS、派生期间源实体被改 → 提交前拒绝零写入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-subtree-guard-'))
  try {
    const { ops, revisionRef } = await seed(root)
    await ops.scene.commit({ sceneId: 's', expectedRevision: revisionRef.value, patch: [{ op: 'add', entity: entity('arm', { mujoco: {}, controller: { gripper: { jointNames: ['finger_joint1', 'joint1'] } } }) as never }] })
    revisionRef.value = 1
    const sim = makeSim(revisionRef)
    await expect(extractRobotAssemblySubtree(sim, ops.scene, makeHooks(), { sceneId: 's', entityId: 'arm', bodyName: 'hand', worldId: 'w', expectedRevision: 1, expectedGeneration: 2 })).rejects.toThrow(/SUBTREE_CONTROLLER_SPANS_CUT/)
    expect((await ops.scene.snapshot('s')).revision).toBe(1)
    // 过期 CAS：expectedRevision 与当前不符。
    await expect(extractRobotAssemblySubtree(sim, ops.scene, makeHooks(), { sceneId: 's', entityId: 'arm', bodyName: 'hand', worldId: 'w', expectedRevision: 0, expectedGeneration: 2 })).rejects.toThrow(/SCENE_REVISION_MISMATCH/)
    // 先把跨切口 controller 换成合法映射，再测"派生期间源实体被改动"。
    await ops.scene.commit({ sceneId: 's', expectedRevision: 1, patch: [{ op: 'update', entityId: 'arm', changes: { components: { mujoco: { sourcePath: '/tmp/arm.xml' }, controller: { tcp: { body: 'hand' } } } } }] })
    revisionRef.value = 2
    // 派生期间源实体被改动：derive 内提交一次，使最终 CAS 复核失败。
    const racing = makeHooks({
      derive: async (input) => {
        await ops.scene.commit({ sceneId: 's', expectedRevision: 2, patch: [{ op: 'update', entityId: 'arm', changes: { components: { mujoco: { sourcePath: '/tmp/arm.xml' }, controller: { tcp: { body: 'hand' } }, articulation: { format: 'mjcf' } } } }] })
        return {
          derivation: { kind: 'subtree-extract', operationId: input.operationId, format: 'mjcf', sourceResourceId: 'arm', sourceVersion: 1, sourceSha256: 'a'.repeat(64), cutBody: 'hand', cutBodyParent: 'arm', remaining: { resourceId: 'arm', version: 2, nq: 2, nu: 2, ntendon: 0, neq: 0 }, part: { resourceId: 'arm_part', version: 1, entityId: input.partEntityId, nq: 2, nu: 1, ntendon: 1, neq: 1 }, jointMap: { partJoints: [], remainingJoints: [], cutJoints: [] }, at: new Date().toISOString() },
          remainingRef: ref('arm', 2), partRef: ref('arm_part', 1),
        }
      },
    })
    const beforeRace = (await ops.scene.snapshot('s')).revision
    await expect(extractRobotAssemblySubtree(sim, ops.scene, racing, { sceneId: 's', entityId: 'arm', bodyName: 'hand', worldId: 'w', expectedGeneration: 2 })).rejects.toThrow(/SUBTREE_SOURCE_CHANGED|SCENE_REVISION_MISMATCH/)
    // 提取本身零写入：revision 只多了 racing 那一次无关提交（beforeRace + 1）。
    expect((await ops.scene.snapshot('s')).revision).toBe(beforeRace + 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('history/undo：发现成对拆分、受保护局部 Undo 保留第三物体与后加编辑、独立件被改后拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-subtree-undo-'))
  try {
    const { ops, revisionRef } = await seed(root)
    await ops.scene.commit({ sceneId: 's', expectedRevision: revisionRef.value, patch: [
      { op: 'add', entity: entity('arm', { mujoco: { sourcePath: '/tmp/arm.xml' }, controller: { tcp: { body: 'hand' }, jointKp: { joint1: 10, finger_joint1: 5 } } }) as never },
      { op: 'add', entity: entity('prop', { visual: { kind: 'group' } }, []) as never },
    ] })
    revisionRef.value = 1
    const sim = makeSim(revisionRef)
    const extracted = await extractRobotAssemblySubtree(sim, ops.scene, makeHooks(), { sceneId: 's', entityId: 'arm', bodyName: 'hand', worldId: 'w', expectedRevision: 1, expectedGeneration: 2, partEntityId: 'part-1' })
    // 后来无关编辑：改 remaining 的 jointKp.joint1（该子键在这次拆分里没变）与资源路径，给 prop 加文本组件。
    await ops.scene.commit({ sceneId: 's', expectedRevision: 2, patch: [
      { op: 'update', entityId: 'arm', changes: { components: { mujoco: { sourcePath: '/tmp/arm_v2.xml' }, articulation: { format: 'mjcf' }, visual: { kind: 'robot', robot: {} }, controller: { jointKp: { joint1: 1234 } }, subtreeExtract: (await ops.scene.snapshot('s')).entities.find(e => e.entityId === 'arm')!.components.subtreeExtract } } },
      { op: 'update', entityId: 'prop', changes: { components: { visual: { kind: 'group' }, annotation: { text: 'later note' } } } },
    ] })
    revisionRef.value = 3
    const history = await readRobotAssemblyHistory(ops.scene, { sceneId: 's', entityId: 'arm' })
    const group = history.subtreePartitions?.find(item => item.operationId === extracted.derivation.operationId)
    expect(group?.role).toBe('extract')
    expect(group?.undoable).toBe(true)
    const undone = await undoRobotAssembly(sim, ops.scene, { sceneId: 's', entityId: 'arm', expectedRevision: 3, worldId: 'w', subtree: { operationId: group!.operationId, beforeRevision: group!.beforeRevision, afterRevision: group!.afterRevision } })
    const snap = await ops.scene.snapshot('s')
    expect(snap.revision).toBe(4)
    const arm = snap.entities.find(e => e.entityId === 'arm')!
    expect(arm.resources[0]).toMatchObject({ resourceId: 'arm', version: 1 })
    expect(arm.resources[0]!.original.uri).toContain('arm_v1.xml')
    expect(arm.components.subtreeExtract).toBeUndefined()
    // 后来无关编辑保留：jointKp.joint1 仍是 1234；被拆分迁走的 finger_joint1 恢复为 5、TCP 随切出恢复为原值；prop 文本仍在；独立件被移除。
    expect((arm.components.controller as any).tcp).toEqual({ body: 'hand' })
    expect((arm.components.controller as any).jointKp).toEqual({ joint1: 1234, finger_joint1: 5 })
    expect((snap.entities.find(e => e.entityId === 'prop')!.components as any).annotation).toEqual({ text: 'later note' })
    expect(snap.entities.some(e => e.entityId === 'part-1')).toBe(false)
    // 重新提取，然后改独立件绑定 → Undo 必须拒绝并给具体冲突。
    revisionRef.value = 4
    const again = await extractRobotAssemblySubtree(sim, ops.scene, makeHooks(), { sceneId: 's', entityId: 'arm', bodyName: 'hand', worldId: 'w', expectedRevision: 4, expectedGeneration: 2, partEntityId: 'part-2' })
    await ops.scene.commit({ sceneId: 's', expectedRevision: 5, patch: [{ op: 'update', entityId: 'part-2', changes: { components: { visual: { kind: 'robot' }, mujoco: { sourcePath: '/tmp/arm_part.xml' }, articulation: { format: 'mjcf' }, subtreeExtract: (await ops.scene.snapshot('s')).entities.find(e => e.entityId === 'part-2')!.components.subtreeExtract, baseBinding: { mode: 'free', bodyName: 'part_hand' } } } }] })
    revisionRef.value = 6
    const history2 = await readRobotAssemblyHistory(ops.scene, { sceneId: 's', entityId: 'arm' })
    const group2 = history2.subtreePartitions?.find(item => item.operationId === again.derivation.operationId)
    expect(group2?.undoable).toBe(false)
    expect(group2?.reason).toContain('ROBOT_ASSEMBLY_CONFLICT')
    await expect(undoRobotAssembly(sim, ops.scene, { sceneId: 's', entityId: 'arm', expectedRevision: 6, subtree: { beforeRevision: group2!.beforeRevision, afterRevision: group2!.afterRevision } })).rejects.toThrow(/ROBOT_ASSEMBLY_CONFLICT/)
    expect(await revisionOf(ops)).toBe(6)
    void undone
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('history/undo：显式过期 world 代次在 CAS 前拒绝成对 Undo，不落版本', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-subtree-undo-stale-'))
  try {
    const { ops, revisionRef } = await seed(root)
    await ops.scene.commit({ sceneId: 's', expectedRevision: revisionRef.value, patch: [
      { op: 'add', entity: entity('arm', { mujoco: { sourcePath: '/tmp/arm.xml' }, controller: { tcp: { body: 'hand' }, jointKp: { joint1: 10, finger_joint1: 5 } } }) as never },
    ] })
    revisionRef.value = 1
    const sim = makeSim(revisionRef)
    const extracted = await extractRobotAssemblySubtree(sim, ops.scene, makeHooks(), { sceneId: 's', entityId: 'arm', bodyName: 'hand', worldId: 'w', expectedRevision: 1, expectedGeneration: 2, partEntityId: 'part-1' })
    revisionRef.value = 2
    const history = await readRobotAssemblyHistory(ops.scene, { sceneId: 's', entityId: 'arm' })
    const group = history.subtreePartitions!.find(item => item.operationId === extracted.derivation.operationId)!
    // 该 world 的真实代次是 2；显式传 1 必须在 CAS 前拒绝，不能把它当离线恢复放行。
    await expect(undoRobotAssembly(sim, ops.scene, { sceneId: 's', entityId: 'arm', expectedRevision: 2, worldId: 'w', expectedGeneration: 1, subtree: { operationId: group.operationId, beforeRevision: group.beforeRevision, afterRevision: group.afterRevision } })).rejects.toThrow(/STALE_GENERATION/)
    expect(await revisionOf(ops)).toBe(2)
    const snap = await ops.scene.snapshot('s')
    expect(snap.entities.some(e => e.entityId === 'part-1')).toBe(true)
    expect(snap.entities.find(e => e.entityId === 'arm')!.components.subtreeExtract).toBeDefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('reassemble 守卫：旧 world 代次拒绝、独立件被重新绑定拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-subtree-re-guard-'))
  try {
    const { ops, revisionRef } = await seed(root)
    await ops.scene.commit({ sceneId: 's', expectedRevision: revisionRef.value, patch: [{ op: 'add', entity: entity('arm', { mujoco: { sourcePath: '/tmp/arm.xml' } }) as never }] })
    revisionRef.value = 1
    const sim = makeSim(revisionRef)
    const result = await extractRobotAssemblySubtree(sim, ops.scene, makeHooks(), { sceneId: 's', entityId: 'arm', bodyName: 'hand', worldId: 'w', expectedRevision: 1, expectedGeneration: 2, partEntityId: 'part-1' })
    revisionRef.value = 2
    // 旧一代请求不得改写新一代场景。
    await expect(reassembleRobotAssemblySubtree(sim, ops.scene, makeHooks(), { sceneId: 's', entityId: 'arm', worldId: 'w', expectedRevision: 2, expectedGeneration: 1 })).rejects.toThrow(/STALE_GENERATION/)
    expect((await ops.scene.snapshot('s')).revision).toBe(2)
    // 独立件被重新绑定（实质改动）→ 拒绝重组，不删用户改过的件。
    const part = (await ops.scene.snapshot('s')).entities.find(e => e.entityId === 'part-1')!
    await ops.scene.commit({ sceneId: 's', expectedRevision: 2, patch: [{ op: 'update', entityId: 'part-1', changes: { components: { ...part.components, baseBinding: { mode: 'free', bodyName: 'part_hand' } } } }] })
    revisionRef.value = 3
    await expect(reassembleRobotAssemblySubtree(sim, ops.scene, makeHooks(), { sceneId: 's', entityId: 'arm', worldId: 'w', expectedRevision: 3, expectedGeneration: 2 })).rejects.toThrow(/SUBTREE_CONFLICT/)
    const final = await ops.scene.snapshot('s')
    expect(final.revision).toBe(3)
    expect(final.entities.some(e => e.entityId === 'part-1')).toBe(true)
    void result
  } finally { await rm(root, { recursive: true, force: true }) }
})

async function revisionOf(ops: SceneOperations): Promise<number> { return (await ops.scene.snapshot('s')).revision }
