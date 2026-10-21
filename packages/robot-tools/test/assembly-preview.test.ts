/**
 * R-012／§2.9：只读装配预览的数学与正负行为。
 *
 * 本文件不触引擎、不写 Scene：`sim` 是只暴露 listWorlds/describe/observe 的替身，`scene` 只暴露
 * `snapshot`。因此若预览路径偷偷 commit/sync/start/step 会直接抛错——这同时是"读取无写入"的负证据。
 * 真实原生挂接/碰撞读回在 `packages/sim-mujoco/test/action-window.test.ts` 与主控原生探针。
 */
import { test, expect } from 'bun:test'
import { Quaternion, Vector3 } from 'three'
import {
  invertPose, matrixToPose, mountBodyFixedToRoot, multiplyPoses, poseToMatrix, previewRobotAssembly, sourceRootPoseFromMounts,
} from '../src/assembly-preview.ts'
import type { RobotAnchorPose } from '../../lyapunov-contracts/src/robot-authoring.ts'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import type { SceneReader } from '../src/operations.ts'
import type { SimWorlds } from '../../sim-contract/src/index.ts'

const IDENTITY: RobotAnchorPose = { positionM: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1] }
const maxPoseDelta = (a: RobotAnchorPose, b: RobotAnchorPose) => Math.max(
  ...a.positionM.map((value, index) => Math.abs(value - b.positionM[index]!)),
  ...a.quaternionXyzw.map((value, index) => Math.abs(Math.abs(value) - Math.abs(b.quaternionXyzw[index]!))),
)
const applyPose = (pose: RobotAnchorPose, point: [number, number, number]) => new Vector3(...point).applyMatrix4(poseToMatrix(pose)).toArray()

test('T_A_B 数学：非零平移 + 非单位旋转 + T_pair 均由同一 4×4 齐次式合成', () => {
  const targetMount: RobotAnchorPose = { positionM: [0.12, -0.03, 0.4], quaternionXyzw: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.7).normalize().toArray() as [number, number, number, number] }
  const sourceMount: RobotAnchorPose = { positionM: [-0.0093, 0.02, -0.095], quaternionXyzw: new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.4).normalize().toArray() as [number, number, number, number] }
  const pair: RobotAnchorPose = { positionM: [0.01, 0, 0], quaternionXyzw: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI).normalize().toArray() as [number, number, number, number] }
  const sourceRoot = sourceRootPoseFromMounts(targetMount, pair, sourceMount)
  // 由公式反推：把源安装面经安装变换放进目标 body 后，必须与"目标安装位再乘 T_pair"逐值一致。
  const mapped = matrixToPose(poseToMatrix(sourceRoot).multiply(poseToMatrix(sourceMount)))
  const expected = multiplyPoses(targetMount, pair)
  expect(maxPoseDelta(mapped, expected)).toBeLessThan(1e-9)
  // 逆变换与矩阵逆一致（非零平移 + 非单位旋转）。
  expect(maxPoseDelta(invertPose(invertPose(sourceRoot)), sourceRoot)).toBeLessThan(1e-9)
  // 位置是真实米制合成，不是把平移直接相加。
  expect(applyPose(sourceRoot, sourceMount.positionM as [number, number, number])).not.toEqual(sourceMount.positionM)
})

test('mountBodyFixedToRoot：根/固定链通过，移动内链拒绝', () => {
  const bodies = [
    { name: 'root', root: true, jointTypes: ['free'] },
    { name: 'weld', parentName: 'root', root: false, jointTypes: ['fixed'] },
    { name: 'nojoint', parentName: 'weld', root: false, jointTypes: [] },
    { name: 'hinge', parentName: 'weld', root: false, jointTypes: ['hinge'] },
  ]
  expect(mountBodyFixedToRoot(bodies, 'root', 'root')).toBe(true)
  expect(mountBodyFixedToRoot(bodies, 'weld', 'root')).toBe(true)
  expect(mountBodyFixedToRoot(bodies, 'nojoint', 'root')).toBe(true)
  expect(mountBodyFixedToRoot(bodies, 'hinge', 'root')).toBe(false)
})

const handDescription = {
  entityId: 'hand', modelVersion: '1', expectedGeneration: 2, collisionContextVersion: 'c', joints: [], controlledJointNames: [],
  nativeBodies: [{ name: 'palm', root: true, jointTypes: ['free'] }, { name: 'finger', parentName: 'palm', root: false, jointTypes: ['hinge'] }],
  nativeSites: [{ name: 'palm_mount', bodyName: 'palm', positionM: [-0.0093, 0, -0.095], quaternionXyzw: [0, 0, 0, 1] }],
  base: { bodyName: 'palm', mode: 'free', source: 'native-model', reason: '', constraints: [], editable: { fixed: true, free: true, entity: true } },
} as never
const pandaDescription = {
  entityId: 'panda', modelVersion: '1', expectedGeneration: 2, collisionContextVersion: 'c', joints: [], controlledJointNames: [],
  nativeBodies: [{ name: 'base', root: true, jointTypes: [] }, { name: 'attachment', parentName: 'base', root: false, jointTypes: ['fixed'] }, { name: 'wrist_3_link', parentName: 'base', root: false, jointTypes: ['hinge'] }],
  nativeSites: [
    { name: 'attachment_site', bodyName: 'attachment', positionM: [0.1, 0.2, 0.3], quaternionXyzw: [0, 0, 0, 1] },
    { name: 'wrist_site', bodyName: 'wrist_3_link', positionM: [-0.1, 0, 0.05], quaternionXyzw: [0, 0, 0, 1] },
  ],
  base: { bodyName: 'base', mode: 'fixed', source: 'native-model', reason: '', constraints: [], editable: { fixed: true, free: true, entity: true } },
} as never
const snapshotWith = (entities: unknown[]): SceneSnapshot => ({ sceneId: 's', revision: 5, entities } as unknown as SceneSnapshot)
/** 同身份原生帧：源根/源 body/目标 body 都必须有合法 body pose，预览的 root↔body 换算只认这里。 */
const frameEntities = [
  { entityId: 'hand', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, sensors: { bodyWorldPoses: {
    palm: { bodyName: 'palm', positionM: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1] },
    finger: { bodyName: 'finger', positionM: [0, 0, 0.25], quaternionXyzw: [0, 0, 0, 1] },
  } } },
  { entityId: 'panda', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, sensors: { bodyWorldPoses: {
    base: { bodyName: 'base', positionM: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1] },
    attachment: { bodyName: 'attachment', positionM: [0.1, 0.2, 0.3], quaternionXyzw: [0, 0, 0, 1] },
    wrist_3_link: { bodyName: 'wrist_3_link', positionM: [-0.1, 0, 0.05], quaternionXyzw: [0, 0, 0, 1] },
  } } },
]
let observeCalls = 0
const makeSim = (overrides: Record<string, unknown> = {}) => ({
  listWorlds: async () => [{ worldId: 'w', sceneId: 's', worldGeneration: 2, appliedSceneRevision: 5, status: 'ready' }],
  describe: async (_worldId: string, entityId: string) => entityId === 'hand' ? handDescription : pandaDescription,
  observe: async () => { observeCalls += 1; return { worldId: 'w', generation: 2, sceneRevision: 5, frameId: 'f', stepIndex: 7, entities: frameEntities } },
  ...overrides,
}) as unknown as SimWorlds
const sceneOf = (snapshot: SceneSnapshot) => ({ snapshot: () => snapshot }) as unknown as SceneReader
const input = (overrides: Record<string, unknown> = {}) => ({
  worldId: 'w', sceneId: 's', expectedRevision: 5, expectedGeneration: 2,
  sourceEntityId: 'hand', sourceMount: { kind: 'site', bodyName: 'palm', site: 'palm_mount' },
  targetEntityId: 'panda', targetBodyName: 'attachment', targetMount: { kind: 'site', site: 'attachment_site' },
  ...overrides,
}) as never

const entity = (entityId: string, baseBinding?: unknown) => ({ entityId, name: entityId, transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [], components: baseBinding ? { baseBinding } : {} })

test('只读预览：静态 plane 源挂到 moving 目标 body 在提交前拒绝；世界静态子 body 仍可安装', async () => {
  const planeDescription = { ...(handDescription as any), installEligibility: { attachable: false, staticPlaneBodies: ['floor'], reason: 'SOURCE_HAS_STATIC_PLANE' } }
  const sim = makeSim({ describe: async (_w: string, entityId: string) => entityId === 'hand' ? planeDescription : pandaDescription })
  // 目标 attachment 相对固定根 base 只经 fixed 连接 ⇒ 世界静态，源 plane 不会进入 moving body，允许。
  const allowed = await previewRobotAssembly(sim, sceneOf(snapshotWith([entity('hand'), entity('panda')])), input({ targetBodyName: 'attachment', targetMount: { kind: 'body-origin' } }))
  expect(allowed.status).toBe('PREVIEW')
  // 目标 wrist_3_link 经转动关节连到根 ⇒ moving，提交前拒绝，不产生 applyInput，也零 Scene 写入。
  await expect(previewRobotAssembly(sim, sceneOf(snapshotWith([entity('hand'), entity('panda')])), input({ targetBodyName: 'wrist_3_link', targetMount: { kind: 'site', site: 'wrist_site' } }))).rejects.toThrow(/SOURCE_NOT_INSTALLABLE/)
})

test('只读预览：真实 site 解析出 applyInput，且状态是 PREVIEW/not applied', async () => {
  observeCalls = 0
  const scene = sceneOf(snapshotWith([entity('hand'), entity('panda')]))
  const result = await previewRobotAssembly(makeSim(), scene, input())
  expect(result.status).toBe('PREVIEW')
  expect(result.applied).toBe(false)
  expect(result.sourceMount).toMatchObject({ kind: 'site', bodyName: 'palm', label: 'palm/palm_mount' })
  expect(result.targetMount).toMatchObject({ kind: 'site', bodyName: 'attachment', label: 'attachment/attachment_site' })
  expect(result.source.rootBodyName).toBe('palm')
  expect(result.frame).toMatchObject({ worldId: 'w', generation: 2, sceneRevision: 5, frameId: 'f', stepIndex: 7 })
  // applyInput 与手动 Apply 同一条 robot_set_base 入参，位姿就是公式计算值。
  expect(result.applyInput.entityId).toBe('hand')
  expect(result.applyInput.base).toMatchObject({ mode: 'fixed', bodyName: 'palm', target: { entityId: 'panda', bodyName: 'attachment' } })
  const expected = sourceRootPoseFromMounts(result.targetMount, IDENTITY, result.sourceMountInSourceRoot!)
  expect(maxPoseDelta(result.applyInput.base.target as RobotAnchorPose, expected)).toBeLessThan(1e-9)
  // 只读：确实读了帧，但没有写 Scene / 没有 sync/start/step 通道可调。
  expect(observeCalls).toBe(1)
})

test('只读预览：固定子 body 的 site/body-origin 先乘 T_sourceRoot_sourceBody（同一原生帧），不漏乘', async () => {
  // 固定 bracket 在源根帧中 z=1，site 在 bracket 局部 z=0.2 ⇒ 源安装面在源根帧中 z=1.2，绑定 z=-1.2。
  const bracketBodies = [{ name: 'palm', root: true, jointTypes: ['free'] }, { name: 'bracket', parentName: 'palm', root: false, jointTypes: ['fixed'] }]
  const bracketDescription = { ...(handDescription as any), nativeBodies: bracketBodies, nativeSites: [{ name: 'socket', bodyName: 'bracket', positionM: [0, 0, 0.2], quaternionXyzw: [0, 0, 0, 1] }] }
  const frame = { worldId: 'w', generation: 2, sceneRevision: 5, frameId: 'f', stepIndex: 7, entities: [
    { entityId: 'hand', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, sensors: { bodyWorldPoses: {
      palm: { bodyName: 'palm', positionM: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1] },
      bracket: { bodyName: 'bracket', positionM: [0, 0, 1], quaternionXyzw: [0, 0, 0, 1] },
    } } },
    { entityId: 'panda', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, sensors: { bodyWorldPoses: { base: { bodyName: 'base', positionM: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1] }, attachment: { bodyName: 'attachment', positionM: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1] } } } },
  ] }
  const sim = makeSim({ describe: async (_w: string, entityId: string) => entityId === 'hand' ? bracketDescription : pandaDescription, observe: async () => frame })
  const site = await previewRobotAssembly(sim, sceneOf(snapshotWith([entity('hand'), entity('panda')])), input({ sourceMount: { kind: 'site', bodyName: 'bracket', site: 'socket' }, targetBodyName: 'attachment', targetMount: { kind: 'body-origin' } }))
  expect(site.targetBodyFromSourceRoot.positionM[2]).toBeCloseTo(-1.2, 12)
  // body-origin：用 bracket 原点（源根帧 z=1）⇒ 绑定 z=-1。
  const origin = await previewRobotAssembly(sim, sceneOf(snapshotWith([entity('hand'), entity('panda')])), input({ sourceMount: { kind: 'body-origin', bodyName: 'bracket' }, targetBodyName: 'attachment', targetMount: { kind: 'body-origin' } }))
  expect(origin.targetBodyFromSourceRoot.positionM[2]).toBeCloseTo(-1, 12)
})

test('只读预览：显式源安装面（非零平移/非单位旋转）与 T_pair 进入同一条公式', async () => {
  const sourceMount = { kind: 'pose', pose: { positionM: [0.05, -0.02, 0.1], quaternionXyzw: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.9).normalize().toArray() } }
  const pair = { positionM: [0, 0.01, 0], quaternionXyzw: new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI).normalize().toArray() }
  const result = await previewRobotAssembly(makeSim(), sceneOf(snapshotWith([entity('hand'), entity('panda')])), input({ sourceMount, pair, targetBodyName: 'wrist_3_link', targetMount: { kind: 'site', site: 'wrist_site' } }))
  expect(result.sourceMount.kind).toBe('pose')
  expect(result.targetMount.label).toBe('wrist_3_link/wrist_site')
  expect(result.targetBodyFromSourceRoot.positionM).toEqual((result.applyInput.base.target as RobotAnchorPose).positionM)
  expect(result.targetBodyFromSourceRoot.quaternionXyzw).toEqual((result.applyInput.base.target as RobotAnchorPose).quaternionXyzw)
  const mapped = matrixToPose(poseToMatrix(result.targetBodyFromSourceRoot).multiply(poseToMatrix(result.sourceMount)))
  const expected = multiplyPoses(result.targetMount, result.pair)
  expect(maxPoseDelta(mapped, expected)).toBeLessThan(1e-9)
})

test('负例：缺目标/自绑定/环/内部移动 site/非法 pose/过期帧/不可编辑根全部零 Scene 写', async () => {
  const base = [entity('hand'), entity('panda')]
  const cases: Array<[string, Record<string, unknown>, unknown[], RegExp]> = [
    ['缺目标实体', input({ targetEntityId: 'missing' }), base, /TARGET_MISSING/],
    ['自绑定', input({ sourceEntityId: 'panda', targetEntityId: 'panda' }), base, /SELF_BINDING/],
    ['成环', input(), [entity('hand'), entity('panda', { mode: 'fixed', bodyName: 'base', target: { entityId: 'hand', bodyName: 'palm' } })], /CYCLE/],
    ['源安装点在移动内链', input({ sourceMount: { kind: 'site', bodyName: 'finger', site: 'palm_mount' } }), base, /MOUNT_NOT_ROOT_FIXED/],
    ['非法 T_pair', input({ pair: { positionM: [0, 0, 0], quaternionXyzw: [0, 0, 0, 0] } }), base, /PAIR_INVALID/],
    ['过期帧', input(), base, /FRAME_STALE/],
  ]
  for (const [label, request, entities, pattern] of cases) {
    const sim = label === '过期帧' ? makeSim({ observe: async () => ({ worldId: 'w', generation: 9, sceneRevision: 5, frameId: 'f', stepIndex: 7, entities: [] }) }) : makeSim()
    await expect(previewRobotAssembly(sim, sceneOf(snapshotWith(entities)), request as never)).rejects.toThrow(pattern)
  }
  // 源根不可绑定到实体：明确拒绝，不产生 applyInput。
  const notEditable = makeSim({ describe: async (_w: string, entityId: string) => entityId === 'hand' ? { ...(handDescription as any), base: { ...(handDescription as any).base, editable: { fixed: false, free: false, entity: false, reason: 'engine has no entity binding' } } } : pandaDescription })
  await expect(previewRobotAssembly(notEditable, sceneOf(snapshotWith(base)), input())).rejects.toThrow(/SOURCE_NOT_EDITABLE/)
})

test('负例：world 代次过期 / 场景未同步 / 缺安装面均拒绝', async () => {
  const scene = sceneOf(snapshotWith([entity('hand'), entity('panda')]))
  await expect(previewRobotAssembly(makeSim({ listWorlds: async () => [{ worldId: 'w', sceneId: 's', worldGeneration: 9, appliedSceneRevision: 5, status: 'ready' }] }), scene, input())).rejects.toThrow(/STALE_GENERATION/)
  await expect(previewRobotAssembly(makeSim({ listWorlds: async () => [{ worldId: 'w', sceneId: 's', worldGeneration: 2, appliedSceneRevision: 4, status: 'ready' }] }), scene, input())).rejects.toThrow(/SCENE_REVISION_MISMATCH/)
  await expect(previewRobotAssembly(makeSim(), scene, input({ sourceMount: undefined }))).rejects.toThrow(/MOUNT_REQUIRED/)
})

test('插件 schema 登记了只读预览：入参含源/目标安装面，且未声明为持久写', async () => {
  const { robotToolParameters } = await import('../src/tool-schema.ts')
  const spec = robotToolParameters.robot_assembly_preview as { input?: { required?: boolean; properties?: Record<string, unknown> } }
  expect(spec.input?.required).toBe(true)
  for (const key of ['sourceEntityId', 'sourceMount', 'targetEntityId', 'targetBodyName', 'targetMount', 'pair', 'worldId', 'sceneId', 'expectedRevision', 'expectedGeneration']) {
    expect(Object.keys(spec.input!.properties ?? {})).toContain(key)
  }
})
