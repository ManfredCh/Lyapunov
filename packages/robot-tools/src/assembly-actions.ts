/**
 * R-012／§2.9／§2.10 的写入与只读检查补充：
 *  · `robot_assembly_mount`：把源安装面存进实体 `components.assemblyMount` 这一处窄元数据，绑定资源版本；
 *  · `robot_assembly_replace`：对已是独立外部实体的旧末端做一次窄多实体 CAS（新末端固定、旧末端留置）；
 *  · `robot_assembly_check`：只读读回真实 native 绑定/相对位姿/关节/接触/动作回执与挂接清单。
 *
 * 边界：不建第二历史库、不建独立点数据库、不写 localStorage；Replace 只借既有 SceneStore 的
 * 一次 commit→一次 sync，Undo 由既有 `robot_assembly_undo`（多条目形态）受保护恢复。
 */
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import type { Entity, Frame, SceneSnapshot, WorldHandle } from '../../lyapunov-contracts/src/types.ts'
import {
  nativePoseInFrame,
  validRobotPose,
  type RobotAnchorPose,
  type RobotAssemblyChange,
  type RobotAssemblyCheckInput,
  type RobotAssemblyCheckResult,
  type RobotAssemblyMountInput,
  type RobotAssemblyMountResult,
  type RobotAssemblyReplaceInput,
  type RobotAssemblyReplaceMembership,
  type RobotAssemblyReplaceResult,
  type RobotAttachmentEntry,
  type RobotBaseBinding,
  type RobotSavedMount,
  type RobotSourceMount,
} from '../../lyapunov-contracts/src/robot-authoring.ts'
import type { SimWorlds } from '../../sim-contract/src/index.ts'
import { invertPose, multiplyPoses, mountBodyFixedToRoot } from './assembly-preview.ts'
import { assertSourceInstallable } from './install-eligibility.ts'
import { presentBindingSides, readBindingField, syncRobotConfiguration, entityResourceIdentity } from './authoring.ts'
import type { SceneReader } from './operations.ts'

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 实体当前主资源身份；没有资源引用时明确 undefined（保存点不能绑到不存在的资源）。 */
function primaryResource(entity: Entity): { resourceId: string; version: number } | undefined {
  const ref = entity.resources[0]
  return ref ? { resourceId: ref.resourceId, version: ref.version } : undefined
}

function readSavedMount(entity: Entity): RobotSavedMount | undefined {
  const value = entity.components.assemblyMount as RobotSavedMount | undefined
  if (!value || typeof value !== 'object' || typeof value.rootBodyName !== 'string' || !value.mount || typeof value.mount !== 'object') return undefined
  return value
}

/**
 * 保存/读取/清除源安装点。保存时校验：site/body-origin 的 body 必须真实存在且相对根固定；
 * 给出 worldId 时按当前 `robot_describe` 校验；显式 pose 必须是合法位姿。
 */
export async function saveRobotAssemblyMount(sim: SimWorlds, scene: SceneReader, input: RobotAssemblyMountInput): Promise<RobotAssemblyMountResult> {
  if (input.clear === true && input.save !== undefined) throw new Error('ROBOT_ASSEMBLY_MOUNT_CONFLICT: save 与 clear 互斥')
  const current = await scene.snapshot(input.sceneId)
  if (current.revision !== input.expectedRevision) throw new Error(`SCENE_REVISION_MISMATCH: 当前场景已是版本 ${current.revision}，请求基于 ${input.expectedRevision}；未写入。`)
  const entity = current.entities.find(candidate => candidate.entityId === input.entityId)
  if (!entity) throw new Error('ROBOT_ENTITY_MISSING')
  const resource = primaryResource(entity)
  // 只读查询：resource 身份对不上即 stale，不静默当作有效点。
  if (input.save === undefined && input.clear !== true) {
    const saved = readSavedMount(entity)
    if (!saved) return { sceneId: input.sceneId, entityId: input.entityId, revision: current.revision, saved: true, changed: false, snapshot: current }
    const stale = !resource || resource.resourceId !== saved.resourceId || resource.version !== saved.resourceVersion
    return { sceneId: input.sceneId, entityId: input.entityId, revision: current.revision, saved: true, changed: false, snapshot: current, resourceId: resource?.resourceId, resourceVersion: resource?.version, mount: saved, ...(stale ? { stale: true, reason: 'ROBOT_ASSEMBLY_MOUNT_STALE: 当前实体资源版本与保存点绑定的版本不一致，保存点已失效。' } : {}) }
  }
  if (!resource) throw new Error('ROBOT_ASSEMBLY_MOUNT_RESOURCE_REQUIRED: 实体没有可绑定的资源引用，无法保存安装点')
  let next: RobotSavedMount | undefined
  if (input.clear) next = undefined
  else {
    const mount = input.save!
    let rootBodyName: string
    if (mount.kind === 'pose') {
      if (!validRobotPose(mount.pose)) throw new Error('ROBOT_ASSEMBLY_MOUNT_POSE_INVALID: 显式安装点必须是米/归一化 xyzw 位姿')
      if (input.rootBodyName) rootBodyName = input.rootBodyName
      else if (input.worldId) {
        const described = await sim.describe(input.worldId, input.entityId)
        const root = described.nativeBodies?.find(body => body.root)
        if (!root) throw new Error('ROBOT_ASSEMBLY_MOUNT_ROOT_MISSING: 无法从当前模型识别源根 body')
        rootBodyName = root.name
      } else throw new Error('ROBOT_ASSEMBLY_MOUNT_ROOT_REQUIRED: 保存显式 pose 安装点必须指明源根 body（或给出 worldId 以便读取）')
    } else {
      rootBodyName = input.rootBodyName ?? mount.bodyName
      const described = input.worldId ? await sim.describe(input.worldId, input.entityId) : undefined
      if (described) {
        if (input.expectedGeneration !== undefined && described.expectedGeneration !== input.expectedGeneration) throw new Error('STALE_GENERATION: 保存安装点前世界代次已变化')
        const bodies = described.nativeBodies ?? []
        const body = bodies.find(candidate => candidate.name === mount.bodyName)
        if (!body) throw new Error('ROBOT_ASSEMBLY_MOUNT_BODY_MISSING: 源模型没有该真实 body')
        const root = bodies.find(candidate => candidate.root)
        if (!root) throw new Error('ROBOT_ASSEMBLY_MOUNT_ROOT_MISSING: 无法从当前模型识别源根 body')
        if (!mountBodyFixedToRoot(bodies, body.name, root.name)) throw new Error('ROBOT_ASSEMBLY_MOUNT_NOT_ROOT_FIXED: 安装点必须位于根或已证实相对根只经固定关节相连的 body 上')
        rootBodyName = input.rootBodyName ?? root.name
        if (mount.kind === 'site' && !(described.nativeSites ?? []).some(site => site.name === mount.site && site.bodyName === mount.bodyName)) throw new Error('ROBOT_ASSEMBLY_MOUNT_SITE_MISSING: 源模型该 body 上没有这个真实 site')
      }
    }
    next = { resourceId: resource.resourceId, resourceVersion: resource.version, rootBodyName, mount }
  }
  const components = { ...entity.components }
  if (next === undefined) delete components.assemblyMount
  else components.assemblyMount = next as unknown as Record<string, unknown>
  const changed = !isDeepStrictEqual(components, entity.components)
  const snapshot = changed ? await scene.commit({ sceneId: input.sceneId, expectedRevision: input.expectedRevision, patch: [{ op: 'update', entityId: input.entityId, changes: { components } }] }) : current
  return { sceneId: input.sceneId, entityId: input.entityId, revision: snapshot.revision, saved: true, changed, snapshot, resourceId: resource.resourceId, resourceVersion: resource.version, ...(next ? { mount: next } : {}) }
}

/** 从 Scene 声明派生"目标 body → 外部手/工具"清单；Scene.parentId 不参与，只认 baseBinding。 */
function deriveAttachments(snapshot: SceneSnapshot, targetEntityId: string, frame: Frame | undefined, generation: number | undefined): RobotAttachmentEntry[] {
  return snapshot.entities.flatMap(entity => {
    const saved = entity.components.baseBinding as RobotBaseBinding | undefined
    if (!saved || saved.target?.entityId !== targetEntityId) return []
    const native: RobotAttachmentEntry['native'] = (() => {
      if (!frame || generation === undefined) return undefined
      const worldFromBody = nativePoseInFrame(frame, entity.entityId, saved.bodyName)
      const targetWorldFromTargetBody = saved.target?.bodyName ? nativePoseInFrame(frame, targetEntityId, saved.target.bodyName) : undefined
      return { bodyName: saved.bodyName, ...(worldFromBody ? { worldFromBody } : {}), ...(targetWorldFromTargetBody ? { targetWorldFromTargetBody } : {}), generation, sceneRevision: frame.sceneRevision ?? -1, ...(frame.frameId ? { frameId: frame.frameId } : {}) }
    })()
    return [{ entityId: entity.entityId, name: entity.name, saved, ...(native ? { native } : {}) }]
  })
}

/**
 * 真实检查/读回。没有 world 或帧身份不对时，只有声明事实，`checked` 对应项保持 false 并写明原因；
 * 绝不把缺失的运动/接触证据当成"兼容通过"。
 */
export async function checkRobotAssembly(sim: SimWorlds, scene: SceneReader, input: RobotAssemblyCheckInput): Promise<RobotAssemblyCheckResult> {
  const snapshot = await scene.snapshot(input.sceneId)
  const entity = snapshot.entities.find(candidate => candidate.entityId === input.entityId)
  if (!entity) throw new Error('ROBOT_ENTITY_MISSING')
  const savedBinding = entity.components.baseBinding as RobotBaseBinding | undefined
  const notes: string[] = []
  let frame: Frame | undefined
  let world: WorldHandle | undefined
  let reason: string | undefined
  if (input.worldId) {
    try {
      world = (await sim.listWorlds()).find(candidate => candidate.worldId === input.worldId)
      if (!world || world.sceneId !== input.sceneId) reason = 'ROBOT_ASSEMBLY_CHECK_WORLD_MISMATCH: 世界不属于该场景，未做原生检查。'
      else if (input.expectedGeneration !== undefined && world.worldGeneration !== input.expectedGeneration) reason = 'STALE_GENERATION: 世界代次已变化，未做原生检查。'
      else if (world.appliedSceneRevision !== snapshot.revision) reason = `ROBOT_ASSEMBLY_CHECK_NOT_SYNCED: 物理世界应用的是版本 ${world.appliedSceneRevision}，当前场景是 ${snapshot.revision}；原生检查不可用。`
      else frame = await sim.observe(input.worldId, { entityIds: [input.entityId, ...(savedBinding?.target?.entityId ? [savedBinding.target.entityId] : [])], sensors: true, contacts: input.contacts === true })
    } catch (error) { reason = `ROBOT_ASSEMBLY_CHECK_READ_FAILED: ${errorText(error)}` }
  } else notes.push('No worldId supplied: only the saved declaration is reported; no native binding/joint/contact check was performed.')
  if (frame && (frame.worldId !== input.worldId || frame.sceneRevision !== snapshot.revision)) reason = 'ROBOT_ASSEMBLY_CHECK_FRAME_STALE: 原生帧身份与当前场景版本不一致。'
  const frameUsable = Boolean(frame && !reason && frame.sceneRevision === snapshot.revision)
  const bodyName = savedBinding?.bodyName
  const worldFromBody = frameUsable && bodyName ? nativePoseInFrame(frame!, input.entityId, bodyName) : undefined
  let relativePose: RobotAnchorPose | undefined
  if (frameUsable && savedBinding?.target?.entityId && savedBinding.target.bodyName && bodyName && worldFromBody) {
    const targetPose = nativePoseInFrame(frame!, savedBinding.target.entityId, savedBinding.target.bodyName)
    // 相对位姿：目标 body 局部系中的源根位姿（与预览公式同向）。
    if (targetPose) relativePose = multiplyPoses(invertPose(targetPose), worldFromBody)
  }
  const observation = frame?.entities.find(row => row.entityId === input.entityId)
  const joints = observation?.joints
  let actionReceipt: unknown
  if (frameUsable && input.worldId && input.actionId) {
    try { actionReceipt = await sim.receipt(input.worldId, input.actionId) } catch (error) { notes.push(`Action receipt unavailable: ${errorText(error)}`) }
  }
  const contacts = frame?.contacts
  return {
    sceneId: input.sceneId, entityId: input.entityId, revision: snapshot.revision,
    ...(savedBinding ? { savedBinding } : {}),
    ...(frameUsable && frame ? { frame: { worldId: frame.worldId, generation: frame.generation, sceneRevision: frame.sceneRevision ?? snapshot.revision, ...(frame.frameId ? { frameId: frame.frameId } : {}), ...(frame.stepIndex !== undefined ? { stepIndex: frame.stepIndex } : {}) } } : {}),
    ...(worldFromBody && bodyName ? { nativeBase: { bodyName, worldFromBody } } : {}),
    ...(relativePose ? { relativePose } : {}),
    ...(joints ? { joints: { count: joints.names.length, names: [...joints.names], positions: [...joints.positions] } } : {}),
    ...(contacts ? { contacts } : {}),
    ...(actionReceipt !== undefined ? { actionReceipt } : {}),
    attachments: deriveAttachments(snapshot, input.entityId, frame, world?.worldGeneration),
    checked: {
      binding: Boolean(savedBinding),
      relativePose: Boolean(relativePose),
      joints: Boolean(joints),
      contacts: Array.isArray(contacts),
      actionReceipt: actionReceipt !== undefined,
      attachments: true,
    },
    notes,
    ...(reason ? { reason } : {}),
  }
}

/**
 * 同一世界位姿判定：位置逐分量近似相等且四元数（正负等价）近似相等。用于拒绝"停放位仍在挂载位"。
 * 阈值只用于判定重合/叠件，不参与任何位姿写入，不改变合法位姿本身的精度。
 */
function posesCoincident(left: RobotAnchorPose, right: RobotAnchorPose): boolean {
  if (!left.positionM.every((value, index) => Math.abs(value - right.positionM[index]!) < 1e-6)) return false
  const dot = left.quaternionXyzw.reduce((sum, value, index) => sum + value * right.quaternionXyzw[index]!, 0)
  return Math.abs(Math.abs(dot) - 1) < 1e-9
}

/** 一次 Replace 新旧双方的窄成员标记：同一 operationId 即可在既有 Scene 版本历史里成组发现。 */
function replaceMarker(operationId: string, role: 'new' | 'old', peerEntityId: string, targetEntityId: string, targetBodyName: string): Record<string, unknown> {
  const membership: RobotAssemblyReplaceMembership = { operationId, role, peerEntityId, targetEntityId, targetBodyName }
  return membership as unknown as Record<string, unknown>
}

/**
 * Replace 一次 CAS：新末端固定到目标 body、旧末端按**明确给出的停放 pose** 离开当前安装位固定留置
 * （或明确 free + 明确初始世界位姿）。不使用 parentId、不复制实体；双方字段在一次 commit + 一次 sync 中更新。
 *
 * 写入前收口（全部在任何 await 之后重核、提交之前无写）：
 *  · 新旧两侧真实 root 与 oldBodyName 一致；旧侧按 fixed/free 核 editable；
 *  · newBase.target 与停放 pose 用既有 validRobotPose 拒绝全零四元数/非有限数/非法向量；
 *  · new/old/target description 代次、scene/world/appliedRevision、Frame、资源身份一致；
 *  · old 必须确实挂在所选目标挂载位（同一 target entity+body），目标/新旧不成环。
 */
export async function replaceRobotAssembly(sim: SimWorlds, scene: SceneReader, input: RobotAssemblyReplaceInput): Promise<RobotAssemblyReplaceResult> {
  if (input.oldEntityId === input.newEntityId) throw new Error('ROBOT_ASSEMBLY_REPLACE_SELF: 新旧末端不能是同一实体')
  // A2：位姿先于任何 await/写入校验（全零四元数、非有限数、非法向量一律拒绝）。
  const base = input.newBase
  if (!base || base.mode !== 'fixed' || !base.target) throw new Error('ROBOT_ASSEMBLY_REPLACE_TARGET_REQUIRED: 换挂的新末端必须固定到目标真实 body')
  if (!base.target.entityId || typeof base.target.entityId !== 'string' || !base.target.bodyName || typeof base.target.bodyName !== 'string' || !base.target.bodyName.trim()) throw new Error('ROBOT_ASSEMBLY_REPLACE_TARGET_INVALID: 目标必须是另一个实体的真实 body')
  if (!validRobotPose(base.target)) throw new Error('ROBOT_ASSEMBLY_REPLACE_TARGET_POSE_INVALID: 目标锚点必须是米/归一化 xyzw 的有效位姿（拒绝全零四元数、非有限数与非法向量）')
  const parking = input.oldParkingPose
  if (parking === undefined) throw new Error('ROBOT_ASSEMBLY_REPLACE_PARKING_REQUIRED: 必须先明确旧末端离开挂载位后的固定停放位姿，不能默认留在旧件当前（新件要占用）的安装位')
  if (!validRobotPose(parking)) throw new Error('ROBOT_ASSEMBLY_REPLACE_PARKING_POSE_INVALID: 停放位姿必须是米/归一化 xyzw 的有效位姿（拒绝全零四元数、非有限数与非法向量）')
  const world = (await sim.listWorlds()).find(candidate => candidate.worldId === input.worldId)
  if (!world || world.sceneId !== input.sceneId) throw new Error('WORLD_SCENE_MISMATCH: 当前物理世界不属于指定场景')
  if (world.worldGeneration !== input.expectedGeneration) throw new Error('STALE_GENERATION: 物理世界已重建，请重新读取机器人')
  const before = await scene.snapshot(input.sceneId)
  if (before.revision !== input.expectedRevision || world.appliedSceneRevision !== before.revision) throw new Error('SCENE_REVISION_MISMATCH: 请先同步当前场景，再换挂')
  const newEntity = before.entities.find(entity => entity.entityId === input.newEntityId)
  const oldEntity = before.entities.find(entity => entity.entityId === input.oldEntityId)
  const targetEntityId = base.target.entityId, targetBodyName = base.target.bodyName
  const targetEntity = before.entities.find(entity => entity.entityId === targetEntityId)
  if (!newEntity || !oldEntity) throw new Error('ROBOT_ENTITY_MISSING: 新旧末端实体都必须存在')
  if (targetEntityId === input.newEntityId || targetEntityId === input.oldEntityId) throw new Error('ROBOT_ASSEMBLY_REPLACE_TARGET_INVALID: 目标实体不能是新旧末端自身')
  if (!targetEntity) throw new Error('ROBOT_ASSEMBLY_REPLACE_TARGET_INVALID: 目标实体不存在')
  // A4：old 必须确实挂在所选目标挂载位上（同一真实 entity+body），不把无关实体当旧末端移动。
  const oldSaved = oldEntity.components.baseBinding as RobotBaseBinding | undefined
  if (!oldSaved || oldSaved.mode !== 'fixed' || !oldSaved.target?.entityId || !oldSaved.target.bodyName) throw new Error('ROBOT_ASSEMBLY_REPLACE_OLD_NOT_ATTACHED: 旧末端当前不是固定在该目标挂载位的外部末端')
  if (oldSaved.target.entityId !== targetEntityId || oldSaved.target.bodyName !== targetBodyName) throw new Error('ROBOT_ASSEMBLY_REPLACE_OLD_TARGET_MISMATCH: 旧末端实际挂接的目标 body 与所选目标安装位不一致，拒绝误移无关实体')
  // 成环检查：目标 baseBinding 链不能回到新末端。
  let next: string | undefined = targetEntityId
  const seen = new Set([input.newEntityId])
  while (next) {
    if (seen.has(next)) throw new Error('ROBOT_BASE_BINDING_CYCLE: 基座绑定不可成环')
    seen.add(next)
    next = (before.entities.find(entity => entity.entityId === next)?.components.baseBinding as RobotBaseBinding | undefined)?.target?.entityId
  }
  const newDescription = await sim.describe(input.worldId, input.newEntityId)
  if (newDescription.expectedGeneration !== input.expectedGeneration) throw new Error('STALE_GENERATION: 新末端描述代次已变化')
  const newRoot = newDescription.nativeBodies?.find(body => body.name === base.bodyName)
  if (!newRoot?.root) throw new Error('ROBOT_BASE_ROOT_REQUIRED: 只编辑真实根基座')
  if (!newDescription.base?.editable?.entity) throw new Error(`ROBOT_BASE_TARGET_UNSUPPORTED: ${newDescription.base?.editable?.reason ?? '当前引擎不支持实体约束'}`)
  const targetDescription = await sim.describe(input.worldId, targetEntityId)
  if (targetDescription.expectedGeneration !== input.expectedGeneration) throw new Error('STALE_GENERATION: 目标描述代次已变化，拒绝据旧描述换挂')
  if (!targetDescription.nativeBodies?.some(body => body.name === targetBodyName)) throw new Error('ROBOT_ASSEMBLY_REPLACE_TARGET_BODY_MISSING: 目标没有该真实 body')
  // 与 Preview／robot_set_base 共用同一份窄资格判据：新件含静态 plane 时不得固定到 moving 目标
  // body。仍在 commit 前，拒绝即零 Scene 写入。
  assertSourceInstallable(newDescription, targetBodyName, targetDescription)
  const oldDescription = await sim.describe(input.worldId, input.oldEntityId)
  if (oldDescription.expectedGeneration !== input.expectedGeneration) throw new Error('STALE_GENERATION: 旧末端描述代次已变化')
  const oldRoot = oldDescription.nativeBodies?.find(body => body.root)
  if (!oldRoot) throw new Error('ROBOT_ASSEMBLY_REPLACE_OLD_ROOT_MISSING: 无法识别旧末端真实根 body')
  // A1：给出的 oldBodyName 必须等于该实体当前 native 真根；不能因为 Frame 里存在某个 finger 就接受。
  if (input.oldBodyName !== undefined && input.oldBodyName !== oldRoot.name) throw new Error(`ROBOT_ASSEMBLY_REPLACE_OLD_BODY_NOT_ROOT: 旧末端当前 native 真根是 ${oldRoot.name}，请求的 ${input.oldBodyName} 不是真根`)
  const oldBodyName = oldRoot.name
  const wantedMode = input.oldFree === true ? 'free' : 'fixed'
  if (!oldDescription.base?.editable?.[wantedMode]) throw new Error(`ROBOT_ASSEMBLY_REPLACE_OLD_NOT_EDITABLE: 旧末端当前不可按 ${wantedMode} 重新绑定${oldDescription.base?.editable?.reason ? `：${oldDescription.base.editable.reason}` : ''}`)
  // 旧末端最终去向需要当前真实帧的根 world pose（固定停放/解除固定都以它为参照拒绝重合）。
  let frame: Frame
  try { frame = await sim.observe(input.worldId, { entityIds: [input.newEntityId, input.oldEntityId, targetEntityId], sensors: true }) }
  catch (error) { throw new Error(`ROBOT_ASSEMBLY_REPLACE_FRAME_UNAVAILABLE: 换挂需要当前版本的真实原生帧。${errorText(error)}`) }
  if (frame.worldId !== input.worldId || frame.generation !== input.expectedGeneration || frame.sceneRevision !== input.expectedRevision) throw new Error('ROBOT_ASSEMBLY_REPLACE_FRAME_STALE: 原生帧不属于当前 scene/revision/generation，拒绝据旧帧停放')
  const oldWorld = nativePoseInFrame(frame, input.oldEntityId, oldBodyName)
  if (!oldWorld) throw new Error('ROBOT_ASSEMBLY_REPLACE_OLD_POSE_MISSING: 当前原生帧没有旧末端根 body 的世界位姿，拒绝停放')
  // A3：observe 是异步的，读完必须再次核对当前 world/scene/revision 与三方资源/组件身份；期间任何变化都作废（无写）。
  const afterObserve = await scene.snapshot(input.sceneId)
  const worldAfter = (await sim.listWorlds()).find(candidate => candidate.worldId === input.worldId)
  if (!worldAfter || worldAfter.sceneId !== input.sceneId) throw new Error('WORLD_SCENE_MISMATCH: 换挂异步读取期间世界身份已变化')
  if (worldAfter.worldGeneration !== input.expectedGeneration) throw new Error('STALE_GENERATION: 换挂异步读取期间物理世界已重建，请重新读取机器人')
  if (afterObserve.revision !== input.expectedRevision || worldAfter.appliedSceneRevision !== afterObserve.revision) throw new Error('SCENE_REVISION_MISMATCH: 换挂异步读取期间场景版本已变化，旧请求作废')
  for (const entityId of [input.newEntityId, input.oldEntityId, targetEntityId]) {
    const beforeEntity = before.entities.find(entity => entity.entityId === entityId)
    const afterEntity = afterObserve.entities.find(entity => entity.entityId === entityId)
    if (!beforeEntity || !afterEntity) throw new Error(`ROBOT_ASSEMBLY_REPLACE_ENTITY_CHANGED: 换挂异步读取期间实体 ${entityId} 已变化`)
    if (!isDeepStrictEqual(beforeEntity.components, afterEntity.components)) throw new Error(`ROBOT_ASSEMBLY_REPLACE_ENTITY_CHANGED: 换挂异步读取期间实体 ${entityId} 的组件声明已变化`)
    if (entityResourceIdentity(beforeEntity) !== entityResourceIdentity(afterEntity)) throw new Error(`ROBOT_ASSEMBLY_REPLACE_RESOURCE_CHANGED: 换挂异步读取期间实体 ${entityId} 的资源身份已变化`)
  }
  // B2：停放位必须真的离开新件要占用的安装位；仍停在旧件当前挂载位或新件安装位即拒绝，不造叠件。
  if (posesCoincident(parking, oldWorld)) throw new Error('ROBOT_ASSEMBLY_REPLACE_PARKING_OVERLAP: 旧末端停放位姿仍是当前挂载位，会与新件叠件；请给出离开安装位的停放位姿')
  const targetBodyWorld = nativePoseInFrame(frame, targetEntityId, targetBodyName)
  if (targetBodyWorld && posesCoincident(parking, multiplyPoses(targetBodyWorld, base.target))) throw new Error('ROBOT_ASSEMBLY_REPLACE_PARKING_OVERLAP: 旧末端停放位姿与新件安装位重合，会叠件')
  const operationId = `replace-${randomUUID()}`
  const newBinding: RobotBaseBinding = { mode: 'fixed', bodyName: base.bodyName, target: structuredClone(base.target) }
  const oldBinding: RobotBaseBinding = input.oldFree === true
    ? { mode: 'free', bodyName: oldBodyName, initialWorldPose: structuredClone(parking) }
    : { mode: 'fixed', bodyName: oldBodyName, target: { positionM: [...parking.positionM], quaternionXyzw: [...parking.quaternionXyzw] } }
  const newComponents = { ...newEntity.components, baseBinding: newBinding as unknown as Record<string, unknown>, assemblyReplace: replaceMarker(operationId, 'new', input.oldEntityId, targetEntityId, targetBodyName) }
  const oldComponents = { ...oldEntity.components, baseBinding: oldBinding as unknown as Record<string, unknown>, assemblyReplace: replaceMarker(operationId, 'old', input.newEntityId, targetEntityId, targetBodyName) }
  const patch = [
    { op: 'update' as const, entityId: input.newEntityId, changes: { components: newComponents } },
    { op: 'update' as const, entityId: input.oldEntityId, changes: { components: oldComponents } },
  ]
  const nextSnapshot = await scene.commit({ sceneId: input.sceneId, expectedRevision: input.expectedRevision, patch })
  const outcome = await syncRobotConfiguration(sim, nextSnapshot, input.worldId)
  const after = nextSnapshot.entities
  const changes: RobotAssemblyChange[] = [
    { sceneId: input.sceneId, entityId: input.newEntityId, field: 'baseBinding', beforeRevision: input.expectedRevision, afterRevision: nextSnapshot.revision, ...presentBindingSides(readBindingField(newEntity, 'baseBinding'), readBindingField(after.find(entity => entity.entityId === input.newEntityId), 'baseBinding')), undoable: true, replace: { operationId, role: 'new', peerEntityId: input.oldEntityId, targetEntityId, targetBodyName } },
    { sceneId: input.sceneId, entityId: input.oldEntityId, field: 'baseBinding', beforeRevision: input.expectedRevision, afterRevision: nextSnapshot.revision, ...presentBindingSides(readBindingField(oldEntity, 'baseBinding'), readBindingField(after.find(entity => entity.entityId === input.oldEntityId), 'baseBinding')), undoable: true, replace: { operationId, role: 'old', peerEntityId: input.newEntityId, targetEntityId, targetBodyName } },
  ]
  return {
    status: 'UPDATED', saved: true,
    sync: outcome.syncRequired ? 'REQUIRED' : 'SYNCED', syncRequired: outcome.syncRequired,
    sceneId: input.sceneId, revision: nextSnapshot.revision, worldId: input.worldId,
    ...(outcome.world ? { worldGeneration: outcome.world.worldGeneration, appliedSceneRevision: outcome.world.appliedSceneRevision } : {}),
    snapshot: nextSnapshot, changes,
    ...(outcome.world ? { world: outcome.world } : {}),
    ...(outcome.frame ? { frame: outcome.frame } : {}),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  }
}

/** source mount 的合法位姿检查（供调用方复用，不重复实现）。 */
export function validSourceMount(mount: RobotSourceMount): boolean {
  if (mount.kind === 'pose') return validRobotPose(mount.pose)
  return typeof mount.bodyName === 'string' && mount.bodyName.length > 0 && (mount.kind !== 'site' || (typeof mount.site === 'string' && mount.site.length > 0))
}
