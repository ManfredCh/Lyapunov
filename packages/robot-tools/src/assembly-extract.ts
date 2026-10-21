/**
 * RC v4 R-013／§2.10：内部子树真实拆分的**场景动作层**（`robot_assembly_extract` /
 * `robot_assembly_reassemble`）。源格式派生与资源登记由 scene-kit 的 `deriveRobotSubtree` 拥有
 * （经注入的 `subtree` 接线调用），本模块只做：
 *
 *  · 一次 Scene CAS：把 remaining 实例切到"切掉子树"的新版本资源、并 join 独立 part 实体；
 *  · 一次原生 sync/读回：切口实际世界位姿来自**同一 native frame**（不混用 root/model 坐标）；
 *  · 成对标记 `components.subtreeExtract`（remaining/part 同 operationId），供历史发现与受保护局部 Undo；
 *  · 控制器/传感器等按**真实关节名**迁移或标记失效；跨切口的映射明确拒绝，不静默拆散。
 *
 * 边界：不新建历史库、不整 Scene 复制恢复、不改源文件或旧资源版本；part 的内部 DOF/执行器保留，
 * 切口关节语义记录在 derivation 里，重组时恢复原模型引用（不用 fixed weld 冒充原关节）。
 */
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import type { Entity, Frame, SceneSnapshot, WorldHandle } from '../../lyapunov-contracts/src/types.ts'
import {
  nativePoseInFrame,
  type RobotAnchorPose,
  type RobotSubtreeDerivationRecord,
  type RobotSubtreeExtractInput,
  type RobotSubtreeExtractResult,
  type RobotSubtreeMarker,
  type RobotSubtreeNameMap,
  type RobotSubtreePrecheckInput,
  type RobotSubtreePrecheckResult,
  type RobotSubtreeReassembleInput,
  type RobotSubtreeReassembleResult,
} from '../../lyapunov-contracts/src/robot-authoring.ts'
import type { SimWorlds } from '../../sim-contract/src/index.ts'
import { invertPose, multiplyPoses } from './assembly-preview.ts'
import { syncRobotConfiguration } from './authoring.ts'
import type { RobotSubtreeFacts, RobotSubtreeHooks, SceneReader } from './operations.ts'

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 控制器里按**关节名**寻址的子结构：迁移到 part、保留在 remaining，或跨切口明确拒绝。 */
interface ControllerPartition {
  remaining?: Record<string, unknown>
  part?: Record<string, unknown>
  shared: string[]
  notes: string[]
}

const JOINT_LIST_KEYS = ['jointNames'] as const
const JOINT_VALUE_KEYS = ['joint'] as const

function partitionController(controller: Record<string, unknown> | undefined, partJoints: Set<string>, remainingJoints: Set<string>): ControllerPartition {
  if (!controller) return { shared: [], notes: [] }
  const remaining: Record<string, unknown> = {}
  const part: Record<string, unknown> = {}
  const shared: string[] = []
  for (const [groupKey, groupValue] of Object.entries(controller)) {
    if (groupKey === 'jointKp' || groupKey === 'jointKd') {
      const table = groupValue as Record<string, unknown>
      const keep: Record<string, unknown> = {}
      const move: Record<string, unknown> = {}
      for (const [joint, value] of Object.entries(table)) {
        if (partJoints.has(joint)) move[joint] = value
        else keep[joint] = value
      }
      if (Object.keys(keep).length) remaining[groupKey] = keep
      if (Object.keys(move).length) part[groupKey] = move
      continue
    }
    if (groupValue === null || typeof groupValue !== 'object' || Array.isArray(groupValue)) { remaining[groupKey] = groupValue; continue }
    const mapping = { ...(groupValue as Record<string, unknown>) }
    const referenced: string[] = []
    for (const key of JOINT_LIST_KEYS) if (Array.isArray(mapping[key])) referenced.push(...(mapping[key] as unknown[]).filter((item): item is string => typeof item === 'string'))
    for (const key of JOINT_VALUE_KEYS) if (typeof mapping[key] === 'string') referenced.push(mapping[key] as string)
    if (!referenced.length) { remaining[groupKey] = mapping; continue }
    const allPart = referenced.every(joint => partJoints.has(joint))
    const allRemaining = referenced.every(joint => remainingJoints.has(joint))
    if (allPart) part[groupKey] = mapping
    else if (allRemaining) remaining[groupKey] = mapping
    else shared.push(`${groupKey}: ${referenced.join(', ')}`)
  }
  return { remaining, part, shared, notes: shared.length ? [`controller 映射跨切口：${shared.join('; ')}`] : [] }
}

interface ControllerMigration {
  controller?: Record<string, unknown>
  /** part 侧引用但在派生件里没有真实映射、且不是被拆切口移除的关节：必须拒绝，不静默保留不可驱动项。 */
  unmapped: string[]
  /** 因切口关节被移除而具名清理掉的控制器条目。 */
  invalidated: string[]
}

/**
 * 按**真实派生名映射**改写 part 控制器的关节引用（jointKp/jointKd 键、jointNames、joint）。
 *
 * 只认原生 helper 重载核对过的 `nameMap.part`：源输入里的 100/5 会准确落到 `part_j2` 等真实名字上。
 * 被拆切口移除的关节引用（URDF）具名清理并记录；其余对不上映射的引用整体拒绝，不猜未证实的名字。
 * 没有 nameMap（旧记录/替身）时保持逐字不变，绝不按前缀自行推导。
 */
function migrateControllerNames(
  controller: Record<string, unknown> | undefined,
  nameMap: RobotSubtreeNameMap | undefined,
  removedCutJoints: Set<string>,
): ControllerMigration {
  if (!controller) return { controller: undefined, unmapped: [], invalidated: [] }
  if (!nameMap) return { controller, unmapped: [], invalidated: [] }
  const out: Record<string, unknown> = {}
  const unmapped: string[] = []
  const invalidated: string[] = []
  for (const [groupKey, groupValue] of Object.entries(controller)) {
    if (groupKey === 'jointKp' || groupKey === 'jointKd') {
      const table = groupValue as Record<string, unknown>
      const mappedTable: Record<string, unknown> = {}
      for (const [joint, value] of Object.entries(table)) {
        const mapped = nameMap.joints[joint]
        if (mapped !== undefined) mappedTable[mapped] = value
        else if (removedCutJoints.has(joint)) invalidated.push(`${groupKey}.${joint}`)
        else unmapped.push(`${groupKey}.${joint}`)
      }
      if (Object.keys(mappedTable).length) out[groupKey] = mappedTable
      continue
    }
    if (groupValue === null || typeof groupValue !== 'object' || Array.isArray(groupValue)) { out[groupKey] = groupValue; continue }
    const mapping = { ...(groupValue as Record<string, unknown>) }
    let drop = false
    if (Array.isArray(mapping.jointNames)) {
      const names: unknown[] = []
      for (const entry of mapping.jointNames as unknown[]) {
        if (typeof entry !== 'string') { names.push(entry); continue }
        const mapped = nameMap.joints[entry]
        if (mapped !== undefined) names.push(mapped)
        else if (removedCutJoints.has(entry)) { drop = true; invalidated.push(`${groupKey}.jointNames:${entry}`) }
        else unmapped.push(`${groupKey}.jointNames:${entry}`)
      }
      if (drop) continue
      mapping.jointNames = names
    }
    if (typeof mapping.joint === 'string') {
      const mapped = nameMap.joints[mapping.joint]
      if (mapped !== undefined) mapping.joint = mapped
      else if (removedCutJoints.has(mapping.joint)) { invalidated.push(`${groupKey}.joint:${mapping.joint}`); continue }
      else unmapped.push(`${groupKey}.joint:${mapping.joint}`)
    }
    // gripper 等按执行器**名字**寻址（worker 的 set_joint/apply_motion 用它定位 ctrl），同样按真实派生名迁移。
    if (typeof mapping.actuator === 'string') {
      const mapped = nameMap.actuators[mapping.actuator]
      if (mapped !== undefined) mapping.actuator = mapped
      else unmapped.push(`${groupKey}.actuator:${mapping.actuator}`)
    }
    if (Array.isArray(mapping.actuators)) {
      const mappedActuators: unknown[] = []
      for (const entry of mapping.actuators as unknown[]) {
        if (typeof entry !== 'string') { mappedActuators.push(entry); continue }
        const mapped = nameMap.actuators[entry]
        if (mapped !== undefined) mappedActuators.push(mapped)
        else unmapped.push(`${groupKey}.actuators:${entry}`)
      }
      mapping.actuators = mappedActuators
    }
    out[groupKey] = mapping
  }
  return { controller: out, unmapped, invalidated }
}

/**
 * TCP 的 body/site 落在 part 子树时，按真实派生名随独立件迁移；留在 remaining 的保持原样。
 * 逐字保留 offset/quaternion 数值；没有派生映射时不移动，也不改名。
 */
function migrateTcpReference(
  original: Record<string, unknown> | undefined,
  migratedPart: Record<string, unknown> | undefined,
  remaining: Record<string, unknown>,
  nameMap: RobotSubtreeNameMap | undefined,
): Record<string, unknown> | undefined {
  const tcp = original?.tcp
  if (!tcp || typeof tcp !== 'object' || Array.isArray(tcp) || !nameMap) return migratedPart
  const definition = tcp as Record<string, unknown>
  const body = typeof definition.body === 'string' ? definition.body : undefined
  const site = typeof definition.site === 'string' ? definition.site : undefined
  const mappedBody = body !== undefined ? nameMap.bodies[body] : undefined
  const mappedSite = site !== undefined ? nameMap.sites[site] : undefined
  if (mappedBody === undefined && mappedSite === undefined) return migratedPart
  const migrated: Record<string, unknown> = { ...definition }
  if (mappedBody !== undefined) migrated.body = mappedBody
  if (mappedSite !== undefined) migrated.site = mappedSite
  delete remaining.tcp
  return { ...(migratedPart ?? {}), tcp: migrated }
}

/** 把资源派生的组件（visual/mujoco/articulation）覆盖到既有组件上，其余键一字不动。 */
function overlayResourceComponents(base: Entity['components'], patch: Partial<Entity['components']>): Entity['components'] {
  return { ...base, ...patch, visual: { ...(base.visual as Record<string, unknown> | undefined), ...(patch.visual as Record<string, unknown> | undefined) } }
}

function subtreeMarker(marker: RobotSubtreeMarker): Record<string, unknown> { return marker as unknown as Record<string, unknown> }

function readMarker(entity: Entity | undefined): RobotSubtreeMarker | undefined {
  const value = entity?.components.subtreeExtract as RobotSubtreeMarker | undefined
  if (!value || typeof value !== 'object' || typeof value.operationId !== 'string' || typeof value.peerEntityId !== 'string') return undefined
  if (value.role !== 'remaining' && value.role !== 'part') return undefined
  if (!value.derivation || typeof value.derivation !== 'object') return undefined
  return value
}

/** 当前实体主资源引用；缺资源时明确 undefined。 */
function primaryResource(entity: Entity): { resourceId: string; version: number } | undefined {
  const ref = entity.resources[0]
  return ref ? { resourceId: ref.resourceId, version: ref.version } : undefined
}

function requireSubtreeHooks(hooks: RobotSubtreeHooks | undefined): RobotSubtreeHooks {
  if (!hooks) throw new Error('SUBTREE_HOOKS_UNAVAILABLE: 当前装配未接线源格式派生（MJCF/URDF 真实拆分），拒绝按扩展名或名称猜能力')
  return hooks
}

/** 被引用关节集合 → 归属集合；无法归属即拒绝（不静默删除控制映射）。 */
function jointOwnership(precheck: RobotSubtreePrecheckResult): { part: Set<string>; remaining: Set<string> } {
  return { part: new Set(precheck.subtree.joints), remaining: new Set(precheck.remaining.joints) }
}

/**
 * 只读预检：核实体主资源类型/格式，列两侧清单与跨切口引用。零 Scene 写入、零资源登记。
 * 不支持的格式（如 USD `kind=source`）给具名 unsupported，绝不按扩展名开放按钮。
 */
export async function precheckRobotAssemblySubtree(scene: SceneReader, hooks: RobotSubtreeHooks | undefined, input: RobotSubtreePrecheckInput): Promise<RobotSubtreePrecheckResult> {
  const snapshot = await scene.snapshot(input.sceneId)
  const entity = snapshot.entities.find(candidate => candidate.entityId === input.entityId)
  if (!entity) throw new Error('ROBOT_ENTITY_MISSING')
  const resource = primaryResource(entity)
  if (!resource) throw new Error('SUBTREE_RESOURCE_REQUIRED: 实体没有可拆分的已登记机器人资源')
  const inspection = await requireSubtreeHooks(hooks).precheck({ resourceId: resource.resourceId, version: resource.version, bodyName: input.bodyName })
  if (!inspection.supported || !inspection.facts) {
    return {
      sceneId: input.sceneId, entityId: input.entityId, revision: snapshot.revision,
      source: { resourceId: resource.resourceId, version: resource.version, sha256: inspection.sha256, format: inspection.format, path: inspection.path },
      selectedBody: input.bodyName, selectedBodyParent: '', supported: false,
      subtree: { bodies: [], joints: [], cutJoints: [], actuators: [], tendons: [], equalities: [], sensors: [], meshes: 0, textures: 0 },
      remaining: { bodies: [], joints: [], actuators: [], tendons: [], equalities: [], sensors: [] },
      closure: { meshFiles: [], textureFiles: [], copiedBytes: 0 },
      crossEdges: inspection.unsupported ? [{ kind: 'format', name: inspection.format, reason: inspection.unsupported.message }] : [],
      warnings: [],
      reason: inspection.unsupported ? `${inspection.unsupported.code}: ${inspection.unsupported.message}` : 'SUBTREE_UNSUPPORTED',
    }
  }
  const facts = inspection.facts as RobotSubtreeFacts
  return {
    sceneId: input.sceneId, entityId: input.entityId, revision: snapshot.revision,
    source: { resourceId: resource.resourceId, version: resource.version, sha256: inspection.sha256, format: inspection.format, path: inspection.path },
    selectedBody: input.bodyName, selectedBodyParent: facts.selectedBodyParent, supported: facts.supported,
    subtree: facts.subtree, remaining: facts.remaining,
    closure: { meshFiles: facts.closure.meshFiles, textureFiles: facts.closure.textureFiles, copiedBytes: facts.closure.copiedBytes },
    crossEdges: facts.crossEdges, warnings: facts.warnings,
    ...(facts.reason ? { reason: facts.reason } : {}),
  }
}

/** 切口实际世界位姿来自当前 native frame：缺世界/不同步/帧身份不符一律拒绝，不混用 Scene transform。 */
async function requireCutFrame(sim: SimWorlds, scene: SceneReader, input: { sceneId: string; worldId: string; entityId: string; expectedGeneration?: number }): Promise<{ frame: Frame; snapshot: SceneSnapshot; rootBodyName: string }> {
  const world = (await sim.listWorlds()).find(candidate => candidate.worldId === input.worldId)
  if (!world || world.sceneId !== input.sceneId) throw new Error('WORLD_SCENE_MISMATCH: 当前物理世界不属于指定场景')
  if (input.expectedGeneration !== undefined && world.worldGeneration !== input.expectedGeneration) throw new Error('STALE_GENERATION: 物理世界已重建，请重新读取机器人')
  const snapshot = await scene.snapshot(input.sceneId)
  if (world.appliedSceneRevision !== snapshot.revision) throw new Error(`SUBTREE_NATIVE_FRAME_REQUIRED: 物理世界应用的是版本 ${world.appliedSceneRevision}，当前场景是 ${snapshot.revision}；提取需要同版本原生帧`)
  let frame: Frame
  try { frame = await sim.observe(input.worldId, { entityIds: [input.entityId], sensors: true }) }
  catch (error) { throw new Error(`SUBTREE_NATIVE_FRAME_REQUIRED: 提取需要当前版本的真实原生帧。${errorText(error)}`) }
  if (frame.worldId !== input.worldId || frame.generation !== world.worldGeneration || frame.sceneRevision !== snapshot.revision) throw new Error('SUBTREE_NATIVE_FRAME_STALE: 原生帧不属于当前 scene/revision/generation')
  const description = await sim.describe(input.worldId, input.entityId)
  const root = description.nativeBodies?.find(body => body.root)
  if (!root) throw new Error('SUBTREE_SOURCE_ROOT_MISSING: 无法识别源实体真实根 body')
  return { frame, snapshot, rootBodyName: root.name }
}

/**
 * `robot_assembly_extract`：一次 Scene CAS 切 remaining 资源 + join part 实体，再一次 sync。
 * 所有收口（资源预检、切口帧、资源登记后的 CAS 复核、成对标记）都在提交前完成；失败零 Scene 写入。
 */
export async function extractRobotAssemblySubtree(sim: SimWorlds, scene: SceneReader, hooks: RobotSubtreeHooks | undefined, input: RobotSubtreeExtractInput): Promise<RobotSubtreeExtractResult> {
  const wired = requireSubtreeHooks(hooks)
  if (!input.worldId) throw new Error('SUBTREE_NATIVE_FRAME_REQUIRED: 提取必须给出已同步的世界，切口位姿只从当前 native frame 读取')
  const { frame, snapshot: before, rootBodyName } = await requireCutFrame(sim, scene, { sceneId: input.sceneId, worldId: input.worldId, entityId: input.entityId, ...(input.expectedGeneration === undefined ? {} : { expectedGeneration: input.expectedGeneration }) })
  const entity = before.entities.find(candidate => candidate.entityId === input.entityId)
  if (!entity) throw new Error('ROBOT_ENTITY_MISSING')
  const resource = primaryResource(entity)
  if (!resource) throw new Error('SUBTREE_RESOURCE_REQUIRED: 实体没有可拆分的已登记机器人资源')
  if (input.expectedRevision !== undefined && before.revision !== input.expectedRevision) throw new Error(`SCENE_REVISION_MISMATCH: 当前场景已是版本 ${before.revision}，请求基于 ${input.expectedRevision}；未写入。`)
  const precheck = await precheckRobotAssemblySubtree(scene, wired, { sceneId: input.sceneId, entityId: input.entityId, bodyName: input.bodyName })
  if (!precheck.supported) throw new Error(precheck.reason ?? 'SUBTREE_CROSS_EDGE_DEPENDENCY: 预检未通过，拒绝拆分')
  // 切口位姿：selected body 与它的父 body（MJCF 的 part 根帧 = 原父帧）/ 自身（URDF 根=link 帧）都由同一 frame 读。
  const cutBodyPose = nativePoseInFrame(frame, input.entityId, input.bodyName)
  if (!cutBodyPose) throw new Error('SUBTREE_CUT_POSE_MISSING: 当前原生帧没有选中 body 的世界位姿，拒绝据 Scene 坐标猜切口')
  const placementBodyName = precheck.source.format === 'mjcf' ? precheck.selectedBodyParent : input.bodyName
  const placementPose = nativePoseInFrame(frame, input.entityId, placementBodyName)
  if (!placementPose) throw new Error('SUBTREE_CUT_POSE_MISSING: 当前原生帧没有 part 根帧对应 body 的世界位姿，拒绝放置独立件')
  const rootPose = nativePoseInFrame(frame, input.entityId, rootBodyName)
  const cutPoseInSourceRoot = rootPose ? multiplyPoses(invertPose(rootPose), cutBodyPose) : undefined
  const partEntityId = input.partEntityId ?? `entity_${randomUUID()}`
  if (before.entities.some(candidate => candidate.entityId === partEntityId)) throw new Error(`SUBTREE_PART_ENTITY_EXISTS: ${partEntityId} 已存在`)

  // 真实派生 + 资源登记（scene-kit owner）。登记失败在 Scene 提交前，零 Scene 写入。
  const derived = await wired.derive({
    sceneId: input.sceneId, entityId: input.entityId,
    sourceResourceId: resource.resourceId, sourceVersion: resource.version,
    bodyName: input.bodyName, operationId: `subtree-${randomUUID()}`,
    partEntityId, partName: input.partName ?? `${entity.name} · ${input.bodyName}`,
    ...(cutPoseInSourceRoot ? { cutPoseInSourceRoot } : {}),
  })
  const derivation: RobotSubtreeDerivationRecord = derived.derivation
  const ownership = jointOwnership(precheck)
  const controller = entity.components.controller as Record<string, unknown> | undefined
  const partition = partitionController(controller, ownership.part, ownership.remaining)
  if (partition.shared.length) throw new Error(`SUBTREE_CONTROLLER_SPANS_CUT: controller 映射同时引用两侧关节（${partition.shared.join('; ')}），拒绝静默拆散策略控制`)
  // 被拆切口移除、在 part 派生件里没有真实映射的关节（URDF）：其控制器引用具名清理并记入标记，
  // 不按源名残留一个不可驱动的条目。MJCF 切口关节保留在 part（part_j2），因此不会命中。
  const removedCutJoints = new Set((derivation.nameMap?.part ? precheck.subtree.cutJoints : []).filter(joint => derivation.nameMap!.part.joints[joint] === undefined))
  const migration = migrateControllerNames(partition.part, derivation.nameMap?.part, removedCutJoints)
  if (migration.unmapped.length) throw new Error(`SUBTREE_CONTROLLER_JOINT_UNMAPPED: part 控制器引用的关节 ${migration.unmapped.join(', ')} 在派生件里没有真实映射，拒绝保留不可驱动的控制条目`)
  // TCP 的 body/site 落在 part 子树时按真实派生名随独立件迁移；仍在 remaining 的保持原样。
  const migratedPartController = migrateTcpReference(controller, migration.controller, partition.remaining ?? {}, derivation.nameMap?.part)

  const remainingComps = (await wired.resourceComponents({ resourceId: derivation.remaining.resourceId, version: derivation.remaining.version })).components
  const partComps = (await wired.resourceComponents({ resourceId: derivation.part.resourceId, version: derivation.part.version })).components
  const remainingComponents = overlayResourceComponents(entity.components, remainingComps)
  if (partition.remaining) remainingComponents.controller = partition.remaining
  else delete remainingComponents.controller
  // 源安装点绑定的是旧资源版本，拆分后必须显式失效（不静默留下指向旧版本的 stale 点）。
  const originalAssemblyMount = entity.components.assemblyMount as Record<string, unknown> | undefined
  delete remainingComponents.assemblyMount
  // 记下拆分前 controller 与拆后 controller：重组只在用户没改过时恢复被迁走的映射。
  const migrated = {
    ...(entity.components.controller !== undefined ? { originalController: structuredClone(entity.components.controller as Record<string, unknown>) } : {}),
    ...(remainingComponents.controller !== undefined ? { remainingController: structuredClone(remainingComponents.controller as Record<string, unknown>) } : {}),
    ...(originalAssemblyMount !== undefined ? { originalAssemblyMount: structuredClone(originalAssemblyMount) } : {}),
    ...(migration.invalidated.length ? { invalidated: [...migration.invalidated] } : {}),
  }
  remainingComponents.subtreeExtract = subtreeMarker({ operationId: derivation.operationId, role: 'remaining', peerEntityId: partEntityId, derivation, ...(Object.keys(migrated).length ? { migrated } : {}) })

  const partComponents = overlayResourceComponents({}, partComps)
  if (migratedPartController && Object.keys(migratedPartController).length) partComponents.controller = migratedPartController
  partComponents.subtreeExtract = subtreeMarker({ operationId: derivation.operationId, role: 'part', peerEntityId: input.entityId, derivation })
  // part 的实体 transform 就是**切口根帧**的世界位姿（MJCF：原父 body；URDF：选中 link）；part 文件内根 body
  // 保留源局部安装位移，因此**不写世界锚 baseBinding**——那会把根 body 局部位姿归零、造成 0.107m 级瞬移。
  // 无关节根 attach 到实体 frame 后天然静态；挂到别的机器人仍走既有 robot_set_base。
  const partEntity: Entity = {
    entityId: partEntityId,
    name: input.partName ?? `${entity.name} · ${input.bodyName}`,
    transform: { position: [...placementPose.positionM], quaternion: [...placementPose.quaternionXyzw], scale: [1, 1, 1] },
    resources: [derived.partRef],
    components: partComponents,
  }

  // 异步派生后再次核对：Scene revision/world 代次与源实体组件/资源身份未变才提交。
  const afterDerive = await scene.snapshot(input.sceneId)
  const worldAfter = (await sim.listWorlds()).find(candidate => candidate.worldId === input.worldId)
  if (!worldAfter || worldAfter.sceneId !== input.sceneId) throw new Error('WORLD_SCENE_MISMATCH: 派生期间世界身份已变化')
  if (input.expectedGeneration !== undefined && worldAfter.worldGeneration !== input.expectedGeneration) throw new Error('STALE_GENERATION: 派生期间物理世界已重建，请重新读取机器人')
  if (afterDerive.revision !== before.revision || worldAfter.appliedSceneRevision !== afterDerive.revision) throw new Error('SCENE_REVISION_MISMATCH: 派生期间场景已变化，请求作废')
  const entityAfter = afterDerive.entities.find(candidate => candidate.entityId === input.entityId)
  if (!entityAfter) throw new Error('ROBOT_ENTITY_MISSING: 派生期间源实体消失')
  if (!isDeepStrictEqual(entityAfter.components, entity.components)) throw new Error('SUBTREE_SOURCE_CHANGED: 派生期间源实体组件声明已变化，拒绝据旧声明拆分')
  if (!isDeepStrictEqual(entityAfter.resources, entity.resources)) throw new Error('SUBTREE_SOURCE_CHANGED: 派生期间源实体资源身份已变化，拒绝据旧声明拆分')

  const patch = [
    { op: 'update' as const, entityId: input.entityId, changes: { resources: [derived.remainingRef], components: remainingComponents } },
    { op: 'add' as const, entity: partEntity },
  ]
  const nextSnapshot = await scene.commit({ sceneId: input.sceneId, expectedRevision: before.revision, patch })
  const outcome = await syncRobotConfiguration(sim, nextSnapshot, input.worldId)
  return {
    status: 'UPDATED', saved: true,
    sync: outcome.syncRequired ? 'REQUIRED' : 'SYNCED', syncRequired: outcome.syncRequired,
    sceneId: input.sceneId, revision: nextSnapshot.revision, worldId: input.worldId,
    remainingEntityId: input.entityId, partEntityId,
    derivation,
    precheck,
    snapshot: nextSnapshot,
    ...(outcome.world ? { worldGeneration: outcome.world.worldGeneration, appliedSceneRevision: outcome.world.appliedSceneRevision } : {}),
    ...(outcome.world ? { world: outcome.world } : {}),
    ...(outcome.frame ? { frame: outcome.frame } : {}),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  }
}

/**
 * `robot_assembly_reassemble`：把明确成对派生结果还原为**原始版本引用**并移除独立件。
 * 恢复的是源模型本身，因此切口关节/控制/传感器逐字保持；不用 fixed weld 冒充原关节。
 * 任一侧资源/标记被实质改动即拒绝，保留后来无关编辑。
 */
export async function reassembleRobotAssemblySubtree(sim: SimWorlds, scene: SceneReader, hooks: RobotSubtreeHooks | undefined, input: RobotSubtreeReassembleInput): Promise<RobotSubtreeReassembleResult> {
  const wired = requireSubtreeHooks(hooks)
  const current = await scene.snapshot(input.sceneId)
  if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) throw new Error(`SCENE_REVISION_MISMATCH: 当前场景已是版本 ${current.revision}，请求基于 ${input.expectedRevision}；未写入。`)
  // 给出世界时必须核对同一 Scene 与代次：旧一代请求不得改写新一代场景。
  if (input.worldId !== undefined) {
    const world = (await sim.listWorlds()).find(candidate => candidate.worldId === input.worldId)
    if (!world || world.sceneId !== input.sceneId) throw new Error('WORLD_SCENE_MISMATCH: 当前物理世界不属于指定场景')
    if (input.expectedGeneration !== undefined && world.worldGeneration !== input.expectedGeneration) throw new Error('STALE_GENERATION: 物理世界已重建，拒绝据旧代次重组')
    if (world.appliedSceneRevision !== current.revision) throw new Error(`SUBTREE_NATIVE_FRAME_REQUIRED: 物理世界应用的是版本 ${world.appliedSceneRevision}，当前场景是 ${current.revision}；重组需要同版本原生世界`)
  }
  const entity = current.entities.find(candidate => candidate.entityId === input.entityId)
  if (!entity) throw new Error('ROBOT_ENTITY_MISSING')
  const marker = readMarker(entity)
  if (!marker || (input.operationId && marker.operationId !== input.operationId)) throw new Error('SUBTREE_PAIR_MISSING: 当前实体没有与请求匹配的拆分成对标记')
  const derivation = marker.derivation
  if (marker.role !== 'remaining') throw new Error('SUBTREE_PAIR_ROLE: 请对 remaining 实体执行重组')
  const part = current.entities.find(candidate => candidate.entityId === marker.peerEntityId)
  if (!part) throw new Error(`SUBTREE_PART_MISSING: 独立件 ${marker.peerEntityId} 已不在当前场景`)
  const partMarker = readMarker(part)
  if (!partMarker || partMarker.operationId !== derivation.operationId || partMarker.role !== 'part') throw new Error('SUBTREE_PAIR_MISSING: 独立件缺少同一 operationId 的成对标记，拒绝重组')
  // 两侧当前资源必须仍是这次派生的两侧；任何一侧换过资源或独立件被重新绑定（实质改动）即冲突。
  const currentResource = primaryResource(entity)
  if (!currentResource || currentResource.resourceId !== derivation.remaining.resourceId || currentResource.version !== derivation.remaining.version) throw new Error('SUBTREE_CONFLICT: remaining 侧资源已不是本次派生版本，拒绝重组')
  const partResource = primaryResource(part)
  if (!partResource || partResource.resourceId !== derivation.part.resourceId || partResource.version !== derivation.part.version) throw new Error('SUBTREE_CONFLICT: 独立件资源已不是本次派生版本，拒绝重组')
  if (part.components.baseBinding !== undefined) throw new Error('SUBTREE_CONFLICT: 独立件已被重新绑定（baseBinding），属于实质改动，拒绝重组')
  // 恢复原资源引用：用原资源**完整 ResourceRef**（original/representations/source），不是只换 id/version。
  const restore = await wired.resourceComponents({ resourceId: derivation.sourceResourceId, version: derivation.sourceVersion })
  const remainingComponents = overlayResourceComponents(entity.components, restore.components)
  // 重组恢复被迁移/失效的字段：只在当前值仍等于拆分后的值（用户没改过）时恢复原值；用户改过就保留改动。
  const migrated = marker.migrated
  if (migrated?.originalController !== undefined && isDeepStrictEqual(entity.components.controller, migrated.remainingController)) {
    remainingComponents.controller = structuredClone(migrated.originalController)
  }
  if (migrated?.originalAssemblyMount !== undefined && entity.components.assemblyMount === undefined) {
    remainingComponents.assemblyMount = structuredClone(migrated.originalAssemblyMount)
  }
  delete remainingComponents.subtreeExtract
  const restoredResource = structuredClone(restore.ref)
  const patch = [
    { op: 'update' as const, entityId: input.entityId, changes: { resources: [restoredResource], components: remainingComponents } },
    { op: 'remove' as const, entityId: marker.peerEntityId },
  ]
  const nextSnapshot = await scene.commit({ sceneId: input.sceneId, expectedRevision: current.revision, patch })
  const outcome = await syncRobotConfiguration(sim, nextSnapshot, input.worldId)
  return {
    status: 'UPDATED', saved: true,
    sync: outcome.syncRequired ? 'REQUIRED' : 'SYNCED', syncRequired: outcome.syncRequired,
    sceneId: input.sceneId, revision: nextSnapshot.revision,
    ...(input.worldId === undefined ? {} : { worldId: input.worldId }),
    remainingEntityId: input.entityId, partEntityId: marker.peerEntityId,
    restoredResource: { resourceId: derivation.sourceResourceId, version: derivation.sourceVersion },
    snapshot: nextSnapshot,
    ...(outcome.world ? { worldGeneration: outcome.world.worldGeneration, appliedSceneRevision: outcome.world.appliedSceneRevision } : {}),
    ...(outcome.world ? { world: outcome.world } : {}),
    ...(outcome.frame ? { frame: outcome.frame } : {}),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  }
}

/** 供历史模块读取成对标记（唯一解析点）。 */
export function subtreeMarkerOf(entity: Entity | undefined): RobotSubtreeMarker | undefined { return readMarker(entity) }
