import { isDeepStrictEqual } from 'node:util'
import type { Entity, SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import type {
  RobotAssemblyChange, RobotAssemblyHistoryInput, RobotAssemblyHistoryResult, RobotAssemblyReplaceMembership,
  RobotAssemblyReplacementGroup, RobotAssemblyUndoInput, RobotBindingField, RobotSubtreeMarker, RobotSubtreePartitionGroup,
} from '../../lyapunov-contracts/src/robot-authoring.ts'
import type { SimWorlds } from '../../sim-contract/src/index.ts'
import type { SceneReader } from './operations.ts'
import { presentBindingSides, readBindingField, syncRobotConfiguration, writeBindingField, type RobotConfigurationResult } from './authoring.ts'
import { subtreeMarkerOf } from './assembly-extract.ts'

/**
 * R-014：局部装配 Undo **不新建历史库**。它只读现有 `SceneStore` 的不可变版本历史
 * （`versions`/`version`）求本次绑定字段的 before/after 差异，再用当前 revision 的 CAS
 * 只回填该字段。整份 Scene 的复制恢复仍只属于 `scene_restore`。
 */
const BINDING_FIELDS: readonly RobotBindingField[] = ['baseBinding', 'controller.tcp']
/** 有界历史查询：默认只看最近若干版本，避免长历史把一次读回变成全量扫描。 */
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function boundedLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1) throw new Error('ROBOT_ASSEMBLY_LIMIT_INVALID: limit 必须是正整数')
  return Math.min(limit, MAX_LIMIT)
}

interface VersionHistory {
  version(sceneId: string, revision: number): SceneSnapshot | Promise<SceneSnapshot>
  versions(sceneId: string): Array<{ revision: number }> | Promise<Array<{ revision: number }>>
}

function requireHistory(scene: SceneReader): VersionHistory {
  if (typeof scene.version !== 'function' || typeof scene.versions !== 'function') {
    throw new Error('SCENE_HISTORY_UNAVAILABLE: 当前 Scene owner 未提供既有版本历史，无法定位局部装配 Undo；不猜测 before。')
  }
  return { version: scene.version.bind(scene), versions: scene.versions.bind(scene) }
}

/**
 * 这次 before/after 过渡是否允许用一个绑定字段的逆操作代表局部装配撤销。
 * 实体创建/移除或模型资源替换都属于**结构变化**：逆操作只回填一个字段，不能冒称完整装配撤销，
 * 必须交由 R-013 的完整恢复路径处理，而不是在这里猜旧 body。
 */
function bindingTransitionGuard(beforeEntity: Entity | undefined, afterEntity: Entity | undefined): { ok: boolean; reason?: string } {
  if (!beforeEntity) return { ok: false, reason: 'ROBOT_ASSEMBLY_ENTITY_CREATED: 这次变化包含实体创建，单字段逆操作不代表完整装配撤销。' }
  if (!afterEntity) return { ok: false, reason: 'ROBOT_ASSEMBLY_ENTITY_REMOVED: 这次变化包含实体移除，单字段逆操作不代表完整装配撤销。' }
  if (!isDeepStrictEqual(beforeEntity.resources, afterEntity.resources)) return { ok: false, reason: 'ROBOT_ASSEMBLY_RESOURCE_CHANGED: 这次变化替换了模型资源，单字段逆操作不代表完整装配撤销。' }
  return { ok: true }
}

/** 当前版本是否仍等于该次 after、且实体/资源身份未变：决定这一条现在是否可撤销。 */
function undoVerdict(current: SceneSnapshot, afterEntity: Entity, entityId: string, field: RobotBindingField, afterValue: unknown): { undoable: boolean; reason?: string } {
  const currentEntity = current.entities.find(entity => entity.entityId === entityId)
  if (!currentEntity) return { undoable: false, reason: 'ROBOT_ASSEMBLY_ENTITY_MISSING: 当前场景没有该实体。' }
  if (!isDeepStrictEqual(afterEntity.resources, currentEntity.resources)) return { undoable: false, reason: 'ROBOT_ASSEMBLY_RESOURCE_CHANGED: 实体资源身份已变化。' }
  if (!isDeepStrictEqual(readBindingField(currentEntity, field), afterValue)) return { undoable: false, reason: 'ROBOT_ASSEMBLY_CONFLICT: 目标绑定在之后又被编辑；拒绝覆盖后续改动。' }
  return { undoable: true }
}

/** 实体 `components.assemblyReplace` 上的窄 Replace 成员标记（同一 operationId 即同一次 CAS）。 */
function replaceMembership(entity: Entity | undefined): RobotAssemblyReplaceMembership | undefined {
  const value = entity?.components.assemblyReplace as RobotAssemblyReplaceMembership | undefined
  if (!value || typeof value !== 'object' || typeof value.operationId !== 'string' || typeof value.peerEntityId !== 'string') return undefined
  if (value.role !== 'new' && value.role !== 'old') return undefined
  return value
}

/**
 * 从既有 Scene 版本历史发现一次 Replace 的新旧双方：请求实体在其 `assemblyReplace` 标记出现/更换的
 * 那次连续过渡上，与 marker.peerEntityId 同 operationId 成组。不新历史库、不猜版本号。
 */
function replaceGroupAt(
  current: SceneSnapshot,
  after: SceneSnapshot,
  entityId: string,
  membership: RobotAssemblyReplaceMembership,
  beforeRevision: number,
  afterRevision: number,
): RobotAssemblyReplacementGroup {
  const memberIds = [...new Set([entityId, membership.peerEntityId])]
  const members: RobotAssemblyReplacementGroup['members'] = []
  let reason: string | undefined
  for (const memberId of memberIds) {
    const afterEntity = after.entities.find(entity => entity.entityId === memberId)
    const currentEntity = current.entities.find(entity => entity.entityId === memberId)
    const selfMarker = replaceMembership(afterEntity)
    const role: 'new' | 'old' = memberId === entityId
      ? membership.role
      : (selfMarker?.operationId === membership.operationId ? selfMarker.role : (membership.role === 'new' ? 'old' : 'new'))
    const peerEntityId = memberId === entityId ? membership.peerEntityId : (selfMarker?.operationId === membership.operationId ? selfMarker.peerEntityId : entityId)
    members.push({ entityId: memberId, field: 'baseBinding', role, peerEntityId })
    if (!afterEntity || !currentEntity) { reason ??= `ROBOT_ASSEMBLY_ENTITY_MISSING: 该次替换的成员 ${memberId} 已不在当前场景。`; continue }
    if (!isDeepStrictEqual(afterEntity.resources, currentEntity.resources)) { reason ??= `ROBOT_ASSEMBLY_RESOURCE_CHANGED: 成员 ${memberId} 的资源身份已变化。`; continue }
    const afterValue = readBindingField(afterEntity, 'baseBinding')
    if (!isDeepStrictEqual(readBindingField(currentEntity, 'baseBinding'), afterValue)) reason ??= `ROBOT_ASSEMBLY_CONFLICT: 成员 ${memberId} 的绑定在之后又被编辑；整组拒绝，不冒称完整撤销。`
  }
  return {
    operationId: membership.operationId,
    targetEntityId: membership.targetEntityId,
    targetBodyName: membership.targetBodyName,
    beforeRevision, afterRevision, members,
    undoable: reason === undefined,
    ...(reason ? { reason } : {}),
  }
}

export async function readRobotAssemblyHistory(scene: SceneReader, input: RobotAssemblyHistoryInput): Promise<RobotAssemblyHistoryResult> {
  const current = await scene.snapshot(input.sceneId)
  const history = requireHistory(scene)
  const limit = boundedLimit(input.limit)
  const all = await history.versions(input.sceneId)
  const revisions = [...new Set(all.map(entry => entry.revision))].sort((left, right) => left - right)
  const window = revisions.slice(-(limit + 1))
  const entries: RobotAssemblyChange[] = []
  const replacements: RobotAssemblyReplacementGroup[] = []
  const subtreePartitions: RobotSubtreePartitionGroup[] = []
  const seenGroups = new Set<string>()
  const seenSubtree = new Set<string>()
  let historyComplete = true
  for (let index = window.length - 1; index >= 1; index--) {
    const beforeRevision = window[index - 1]!, afterRevision = window[index]!
    // Scene 每次正常提交 revision+1；列表里相邻项差 >1 就是缺页，不能拼成一次可撤销变化，也不据此推断 before。
    if (afterRevision !== beforeRevision + 1) { historyComplete = false; continue }
    const before = await history.version(input.sceneId, beforeRevision)
    const after = await history.version(input.sceneId, afterRevision)
    const beforeEntity = before.entities.find(entity => entity.entityId === input.entityId)
    const afterEntity = after.entities.find(entity => entity.entityId === input.entityId)
    const afterMarker = replaceMembership(afterEntity)
    const beforeMarker = replaceMembership(beforeEntity)
    // 这条过渡把请求实体纳入一次 Replace（出现或更换 operationId）：在既有历史里成组，重开后仍可发现双方。
    if (afterMarker && afterMarker.operationId !== beforeMarker?.operationId && !seenGroups.has(afterMarker.operationId)) {
      seenGroups.add(afterMarker.operationId)
      replacements.push(replaceGroupAt(current, after, input.entityId, afterMarker, beforeRevision, afterRevision))
    }
    // R-013：这条过渡让请求实体的成对拆分标记出现（拆分，含 part 侧被加入）或消失（重组，含 part 被移除）：
    // 在既有 Scene 历史里成组 remaining/part 双方，重开后仍能整组受保护 Undo。
    const beforeSubtree = subtreeMarkerOf(beforeEntity)
    const afterSubtree = subtreeMarkerOf(afterEntity)
    if (afterSubtree && afterSubtree.operationId !== beforeSubtree?.operationId && !seenSubtree.has(afterSubtree.operationId)) {
      seenSubtree.add(afterSubtree.operationId)
      subtreePartitions.push(subtreePartitionAt(current, after, input.entityId, afterSubtree, 'extract', beforeRevision, afterRevision))
    } else if (beforeSubtree && !afterSubtree && !seenSubtree.has(beforeSubtree.operationId)) {
      seenSubtree.add(beforeSubtree.operationId)
      subtreePartitions.push(subtreePartitionAt(current, after, input.entityId, beforeSubtree, 'reassemble', beforeRevision, afterRevision))
    }
    for (const field of BINDING_FIELDS) {
      const beforeValue = readBindingField(beforeEntity, field)
      const afterValue = readBindingField(afterEntity, field)
      if (isDeepStrictEqual(beforeValue, afterValue)) continue
      const guard = bindingTransitionGuard(beforeEntity, afterEntity)
      const verdict = guard.ok ? undoVerdict(current, afterEntity!, input.entityId, field, afterValue) : { undoable: false, ...(guard.reason ? { reason: guard.reason } : {}) }
      entries.push({ sceneId: input.sceneId, entityId: input.entityId, field, beforeRevision, afterRevision, ...presentBindingSides(beforeValue, afterValue), ...verdict, ...(afterMarker ? { replace: afterMarker } : {}) })
    }
  }
  return {
    sceneId: input.sceneId,
    entityId: input.entityId,
    revision: current.revision,
    entries,
    inspected: window.length,
    historyComplete,
    ...(historyComplete ? {} : { reason: 'ROBOT_ASSEMBLY_HISTORY_GAP: 既有 Scene 历史缺少中间版本；跨缺页的相邻版本不视为一次装配变化，也不用于推断 before。' }),
    ...(replacements.length > 0 ? { replacements } : {}),
    ...(subtreePartitions.length > 0 ? { subtreePartitions } : {}),
  }
}

/** 成对拆分标记（remaining/part 同 operationId）的成组事实；`current` 用于判断该次过渡现在是否还可撤销。 */
function subtreePartitionAt(current: SceneSnapshot, after: SceneSnapshot, entityId: string, marker: RobotSubtreeMarker, role: 'extract' | 'reassemble', beforeRevision: number, afterRevision: number): RobotSubtreePartitionGroup {
  const remainingEntityId = marker.role === 'remaining' ? entityId : marker.peerEntityId
  const partEntityId = marker.role === 'part' ? entityId : marker.peerEntityId
  const reasons = partitionUndoVerdict(current, after, remainingEntityId, partEntityId)
  return {
    operationId: marker.operationId,
    role,
    remainingEntityId,
    partEntityId,
    beforeRevision,
    afterRevision,
    derivation: marker.derivation,
    undoable: reasons.length === 0,
    ...(reasons.length ? { reason: `ROBOT_ASSEMBLY_CONFLICT: ${reasons.join('; ')}` } : {}),
  }
}

/** 两侧当前是否仍等于该次过渡的 after（资源/成对标记/独立件绑定）；被实质改动即拒绝。 */
function partitionUndoVerdict(current: SceneSnapshot, after: SceneSnapshot, remainingEntityId: string, partEntityId: string): string[] {
  const reasons: string[] = []
  const currentRemaining = current.entities.find(entity => entity.entityId === remainingEntityId)
  const afterRemaining = after.entities.find(entity => entity.entityId === remainingEntityId)
  const currentPart = current.entities.find(entity => entity.entityId === partEntityId)
  const afterPart = after.entities.find(entity => entity.entityId === partEntityId)
  if (!currentRemaining || !afterRemaining) reasons.push(`remaining 实体 ${remainingEntityId} 缺失`)
  else {
    if (!isDeepStrictEqual(currentRemaining.resources, afterRemaining.resources)) reasons.push('remaining 资源身份已变化')
    if (!isDeepStrictEqual(currentRemaining.components.subtreeExtract, afterRemaining.components.subtreeExtract)) reasons.push('remaining 成对标记已变化')
  }
  if (Boolean(currentPart) !== Boolean(afterPart)) reasons.push('独立件存在性与该次 after 不一致')
  else if (currentPart && afterPart) {
    if (!isDeepStrictEqual(currentPart.resources, afterPart.resources)) reasons.push('独立件资源身份已变化')
    if (!isDeepStrictEqual(currentPart.components.subtreeExtract, afterPart.components.subtreeExtract)) reasons.push('独立件成对标记已变化')
    if (!isDeepStrictEqual(currentPart.components.baseBinding, afterPart.components.baseBinding)) reasons.push('独立件绑定已被改动')
  }
  return reasons
}

/**
 * 成对拆分的局部 Undo：只把这次过渡改动的**字段与实体**从 before 版本恢复回当前 Scene，仍只产生一个新版本、
 * 只同步一次。后来在其它键上的无关编辑保留（只回填 before/after 不同的键）；两侧任一被实质改动即拒绝。
 * 恢复的是既有 Scene 历史快照，不整 Scene checkout、不删用户新件、不覆盖源文件。
 */
async function undoRobotSubtreeGroup(sim: SimWorlds, scene: SceneReader, history: VersionHistory, input: RobotAssemblyUndoInput): Promise<RobotConfigurationResult> {
  const current = await scene.snapshot(input.sceneId)
  if (current.revision !== input.expectedRevision) throw new Error(`SCENE_REVISION_MISMATCH: 当前场景已是版本 ${current.revision}，请求基于 ${input.expectedRevision}；未写入。`)
  const { beforeRevision, afterRevision } = input.subtree!
  if (!Number.isInteger(beforeRevision) || !Number.isInteger(afterRevision) || afterRevision !== beforeRevision + 1) throw new Error('ROBOT_ASSEMBLY_HISTORY_GAP: 该范围不是连续的一次历史过渡（缺少中间版本），拒绝跨缺页推断 before。')
  if (afterRevision > current.revision) throw new Error('ROBOT_ASSEMBLY_RANGE_INVALID: afterRevision 晚于当前场景版本')
  const load = async (revision: number): Promise<SceneSnapshot> => {
    try { return await history.version(input.sceneId, revision) }
    catch (error) { throw new Error(`ROBOT_ASSEMBLY_VERSION_NOT_FOUND: 既有 Scene 历史缺少版本 ${revision}，无法定位这次拆分（不猜测 before）。${errorText(error)}`) }
  }
  const before = await load(beforeRevision)
  const after = await load(afterRevision)
  const afterEntity = after.entities.find(entity => entity.entityId === input.entityId)
  const beforeEntity = before.entities.find(entity => entity.entityId === input.entityId)
  const marker = subtreeMarkerOf(afterEntity) ?? subtreeMarkerOf(beforeEntity)
  if (!marker) throw new Error('ROBOT_ASSEMBLY_SUBTREE_MISSING: 该范围不是一次成对拆分/重组过渡')
  if (input.subtree!.operationId && marker.operationId !== input.subtree!.operationId) throw new Error('ROBOT_ASSEMBLY_SUBTREE_MISMATCH: operationId 与该次过渡不一致')
  const remainingEntityId = marker.role === 'remaining' ? input.entityId : marker.peerEntityId
  const partEntityId = marker.role === 'part' ? input.entityId : marker.peerEntityId
  const reasons = partitionUndoVerdict(current, after, remainingEntityId, partEntityId)
  if (reasons.length) throw new Error(`ROBOT_ASSEMBLY_CONFLICT: ${reasons.join('; ')}；拒绝按旧版本回填`)

  const patch: Array<{ op: 'update'; entityId: string; changes: { resources?: Entity['resources']; components?: Entity['components'] } } | { op: 'add'; entity: Entity } | { op: 'remove'; entityId: string }> = []
  const currentRemaining = current.entities.find(entity => entity.entityId === remainingEntityId)!
  const beforeRemaining = before.entities.find(entity => entity.entityId === remainingEntityId)
  const afterRemaining = after.entities.find(entity => entity.entityId === remainingEntityId)!
  patch.push({ op: 'update', entityId: remainingEntityId, changes: { resources: structuredClone(beforeRemaining?.resources ?? afterRemaining.resources), components: restoreTouchedKeys(currentRemaining, beforeRemaining, afterRemaining) } })
  const currentPart = current.entities.find(entity => entity.entityId === partEntityId)
  const beforePart = before.entities.find(entity => entity.entityId === partEntityId)
  const afterPart = after.entities.find(entity => entity.entityId === partEntityId)
  if (afterPart && !beforePart) patch.push({ op: 'remove', entityId: partEntityId })
  else if (beforePart && !afterPart && !currentPart) patch.push({ op: 'add', entity: structuredClone(beforePart) })
  else if (currentPart && beforePart && afterPart) patch.push({ op: 'update', entityId: partEntityId, changes: { resources: structuredClone(beforePart.resources), components: restoreTouchedKeys(currentPart, beforePart, afterPart) } })

  const snapshot = await scene.commit({ sceneId: input.sceneId, expectedRevision: input.expectedRevision, patch })
  const outcome = await syncRobotConfiguration(sim, snapshot, input.worldId)
  return {
    status: 'UPDATED', saved: true,
    sync: outcome.syncRequired ? 'REQUIRED' : 'SYNCED', syncRequired: outcome.syncRequired,
    sceneId: input.sceneId, revision: snapshot.revision,
    ...(input.worldId === undefined ? {} : { worldId: input.worldId }),
    ...(outcome.world ? { worldGeneration: outcome.world.worldGeneration, appliedSceneRevision: outcome.world.appliedSceneRevision } : {}),
    entityId: input.entityId, snapshot,
    ...(outcome.world ? { world: outcome.world } : {}),
    ...(outcome.frame ? { frame: outcome.frame } : {}),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  } as RobotConfigurationResult
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * 递归只回填 before/after 真正不同的**叶子**：对象逐键下钻，叶值不同才恢复 before。
 * 这样拆分/重组改动过的 controller.gripper/jointKp.finger_joint1 会恢复，而用户后来改的
 * controller.jointKp.joint1=1234（该键在这次过渡里没变）逐字保留，不整块覆盖。
 */
function restoreValue(current: unknown, before: unknown, after: unknown): unknown {
  if (isPlainObject(before) && isPlainObject(after)) {
    const base: Record<string, unknown> = isPlainObject(current) ? { ...current } : {}
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (isDeepStrictEqual(before[key], after[key])) continue
      if (Object.hasOwn(before, key)) base[key] = restoreValue(base[key], before[key], after[key])
      else delete base[key]
    }
    return base
  }
  return isDeepStrictEqual(before, after) ? current : structuredClone(before)
}

/** 只回填 before/after 真正不同的组件键（对象逐键下钻）：后来对其它键/子键的无关编辑逐字保留。 */
function restoreTouchedKeys(currentEntity: Entity, beforeEntity: Entity | undefined, afterEntity: Entity): Entity['components'] {
  const components = structuredClone(currentEntity.components)
  const beforeComponents = beforeEntity?.components ?? {}
  const afterComponents = afterEntity.components
  for (const key of new Set([...Object.keys(beforeComponents), ...Object.keys(afterComponents)])) {
    if (isDeepStrictEqual((beforeComponents as Record<string, unknown>)[key], (afterComponents as Record<string, unknown>)[key])) continue
    if (Object.hasOwn(beforeComponents, key)) (components as Record<string, unknown>)[key] = restoreValue((components as Record<string, unknown>)[key], (beforeComponents as Record<string, unknown>)[key], (afterComponents as Record<string, unknown>)[key])
    else delete (components as Record<string, unknown>)[key]
  }
  return components
}

/**
 * Replace 的一次窄多实体 CAS：按每个条目各自的 before/after 受保护恢复双方字段，仍只产生一个新版本，
 * 并且只同步一次。后来无关编辑（当前值 != 该条 after）会明确拒绝，不覆盖。
 */
async function undoRobotAssemblyGroup(sim: SimWorlds, scene: SceneReader, history: VersionHistory, input: RobotAssemblyUndoInput): Promise<RobotConfigurationResult> {
  const current = await scene.snapshot(input.sceneId)
  if (current.revision !== input.expectedRevision) throw new Error(`SCENE_REVISION_MISMATCH: 当前场景已是版本 ${current.revision}，请求基于 ${input.expectedRevision}；未写入。`)
  const cache = new Map<number, SceneSnapshot>()
  const load = async (revision: number): Promise<SceneSnapshot> => {
    if (cache.has(revision)) return cache.get(revision)!
    try { const value = await history.version(input.sceneId, revision); cache.set(revision, value); return value }
    catch (error) { throw new Error(`ROBOT_ASSEMBLY_VERSION_NOT_FOUND: 既有 Scene 历史缺少版本 ${revision}，无法定位这次装配变化（不猜测 before）。${errorText(error)}`) }
  }
  const writes = new Map<string, Entity['components']>()
  const changes: RobotAssemblyChange[] = []
  for (const entry of input.changes!) {
    if (entry.field !== 'baseBinding' && entry.field !== 'controller.tcp') throw new Error('ROBOT_ASSEMBLY_FIELD_INVALID: field 必须是 baseBinding 或 controller.tcp')
    if (!Number.isInteger(entry.beforeRevision) || !Number.isInteger(entry.afterRevision) || entry.afterRevision !== entry.beforeRevision + 1) throw new Error('ROBOT_ASSEMBLY_HISTORY_GAP: 该范围不是连续的一次历史过渡（缺少中间版本），拒绝跨缺页推断 before。')
    if (entry.afterRevision > current.revision) throw new Error('ROBOT_ASSEMBLY_RANGE_INVALID: afterRevision 晚于当前场景版本')
    const before = await load(entry.beforeRevision), after = await load(entry.afterRevision)
    const currentEntity = current.entities.find(entity => entity.entityId === entry.entityId)
    if (!currentEntity) throw new Error('ROBOT_ASSEMBLY_ENTITY_MISSING: 当前场景没有该实体')
    const beforeEntity = before.entities.find(entity => entity.entityId === entry.entityId)
    const afterEntity = after.entities.find(entity => entity.entityId === entry.entityId)
    const guard = bindingTransitionGuard(beforeEntity, afterEntity)
    if (!guard.ok) throw new Error(guard.reason)
    if (!isDeepStrictEqual(afterEntity!.resources, currentEntity.resources)) throw new Error('ROBOT_ASSEMBLY_RESOURCE_CHANGED: 实体资源身份已变化，拒绝按旧版本回填')
    const afterValue = readBindingField(afterEntity, entry.field)
    if (!isDeepStrictEqual(readBindingField(currentEntity, entry.field), afterValue)) throw new Error('ROBOT_ASSEMBLY_CONFLICT: 目标绑定在之后又被编辑，拒绝覆盖；请核对当前值或使用场景历史恢复。')
    const beforeValue = readBindingField(beforeEntity, entry.field)
    writes.set(entry.entityId, writeBindingField(writes.get(entry.entityId) ?? currentEntity.components, entry.field, beforeValue))
    changes.push({ sceneId: input.sceneId, entityId: entry.entityId, field: entry.field, beforeRevision: entry.beforeRevision, afterRevision: entry.afterRevision, ...presentBindingSides(beforeValue, afterValue), undoable: true })
  }
  const patch = [...writes].map(([entityId, components]) => ({ op: 'update' as const, entityId, changes: { components } }))
  const snapshot = await scene.commit({ sceneId: input.sceneId, expectedRevision: input.expectedRevision, patch })
  const outcome = await syncRobotConfiguration(sim, snapshot, input.worldId)
  const entityId = input.changes![0]!.entityId
  return {
    status: 'UPDATED', saved: true,
    sync: outcome.syncRequired ? 'REQUIRED' : 'SYNCED', syncRequired: outcome.syncRequired,
    sceneId: input.sceneId, revision: snapshot.revision,
    ...(input.worldId === undefined ? {} : { worldId: input.worldId }),
    ...(outcome.world ? { worldGeneration: outcome.world.worldGeneration, appliedSceneRevision: outcome.world.appliedSceneRevision } : {}),
    entityId, snapshot,
    ...(outcome.world ? { world: outcome.world } : {}),
    ...(outcome.frame ? { frame: outcome.frame } : {}),
    ...(changes[0] ? { assembly: changes[0] } : {}),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  } as RobotConfigurationResult
}

/**
 * `worldId` 显式给出时的 world 级身份校验：世界存在且与请求场景一致时，`expectedGeneration` 不符就在
 * CAS 前拒绝（与 `robot_assembly_extract`/`robot_set_base` 等入口同一 `STALE_GENERATION` 语义）。
 * 世界不存在时保留原"只恢复声明并如实报待同步"的分层语义；但**绝不把显式过期的 world 当离线请求放行**。
 */
async function assertUndoWorldIdentity(sim: SimWorlds, input: RobotAssemblyUndoInput): Promise<void> {
  if (!input.worldId || input.expectedGeneration === undefined) return
  const world = (await sim.listWorlds()).find(candidate => candidate.worldId === input.worldId)
  if (!world) return
  if (world.sceneId !== input.sceneId) throw new Error('WORLD_SCENE_MISMATCH: 物理世界不属于该场景')
  if (world.worldGeneration !== input.expectedGeneration) throw new Error('STALE_GENERATION: 物理世界已重建，请重新读取机器人')
}

export async function undoRobotAssembly(sim: SimWorlds, scene: SceneReader, input: RobotAssemblyUndoInput): Promise<RobotConfigurationResult> {
  await assertUndoWorldIdentity(sim, input)
  const history = requireHistory(scene)
  if (input.subtree) return undoRobotSubtreeGroup(sim, scene, history, input)
  if (input.changes && input.changes.length > 0) return undoRobotAssemblyGroup(sim, scene, history, input)
  if (input.field === undefined || input.beforeRevision === undefined || input.afterRevision === undefined) throw new Error('ROBOT_ASSEMBLY_RANGE_REQUIRED: 单字段 Undo 必须给出 field/beforeRevision/afterRevision，或给出 changes 组。')
  const field = input.field, beforeRevision = input.beforeRevision, afterRevision = input.afterRevision
  if (field !== 'baseBinding' && field !== 'controller.tcp') throw new Error('ROBOT_ASSEMBLY_FIELD_INVALID: field 必须是 baseBinding 或 controller.tcp')
  if (!Number.isInteger(beforeRevision) || !Number.isInteger(afterRevision) || beforeRevision >= afterRevision) throw new Error('ROBOT_ASSEMBLY_RANGE_INVALID: beforeRevision 必须早于 afterRevision')
  // 局部"本次变化"只接受真实连续的一次历史过渡；缺页时不能跨过缺失版本推断 before。
  if (afterRevision !== beforeRevision + 1) throw new Error('ROBOT_ASSEMBLY_HISTORY_GAP: 该范围不是连续的一次历史过渡（缺少中间版本），拒绝跨缺页推断 before。')
  // 恢复声明只依赖既有 Scene owner 与 CAS；即使 world 没应用当前 Scene 或不可用也允许，
  // 因此这里**不**走要求当前 Frame 已同步的 configurationContext 门禁。
  const current = await scene.snapshot(input.sceneId)
  if (current.revision !== input.expectedRevision) throw new Error(`SCENE_REVISION_MISMATCH: 当前场景已是版本 ${current.revision}，请求基于 ${input.expectedRevision}；未写入。`)
  if (afterRevision > current.revision) throw new Error('ROBOT_ASSEMBLY_RANGE_INVALID: afterRevision 晚于当前场景版本')
  let after: SceneSnapshot
  try { after = await history.version(input.sceneId, afterRevision) }
  catch (error) { throw new Error(`ROBOT_ASSEMBLY_VERSION_NOT_FOUND: 既有 Scene 历史缺少版本 ${afterRevision}，无法定位这次装配变化（不猜测 before）。${errorText(error)}`) }
  let before: SceneSnapshot
  try { before = await history.version(input.sceneId, beforeRevision) }
  catch (error) { throw new Error(`ROBOT_ASSEMBLY_VERSION_NOT_FOUND: 既有 Scene 历史缺少版本 ${beforeRevision}，无法定位这次装配变化（不猜测 before）。${errorText(error)}`) }
  const currentEntity = current.entities.find(entity => entity.entityId === input.entityId)
  if (!currentEntity) throw new Error('ROBOT_ASSEMBLY_ENTITY_MISSING: 当前场景没有该实体')
  const beforeEntity = before.entities.find(entity => entity.entityId === input.entityId)
  const afterEntity = after.entities.find(entity => entity.entityId === input.entityId)
  // 执行入口再次校验这次 before/after 的实体与资源身份：创建/移除/换模型资源都不能用一个绑定字段的逆操作冒称完整装配撤销。
  const guard = bindingTransitionGuard(beforeEntity, afterEntity)
  if (!guard.ok) throw new Error(guard.reason)
  if (!isDeepStrictEqual(afterEntity!.resources, currentEntity.resources)) throw new Error('ROBOT_ASSEMBLY_RESOURCE_CHANGED: 实体资源身份已变化，拒绝按旧版本回填')
  const afterValue = readBindingField(afterEntity, field)
  if (!isDeepStrictEqual(readBindingField(currentEntity, field), afterValue)) throw new Error('ROBOT_ASSEMBLY_CONFLICT: 目标绑定在之后又被编辑，拒绝覆盖；请核对当前值或使用场景历史恢复。')
  const beforeValue = readBindingField(beforeEntity, field)
  const components = writeBindingField(currentEntity.components, field, beforeValue)
  const changed = !isDeepStrictEqual(components, currentEntity.components)
  const snapshot = changed ? await scene.commit({ sceneId: input.sceneId, expectedRevision: input.expectedRevision, patch: [{ op: 'update', entityId: input.entityId, changes: { components } }] }) : current
  const outcome = await syncRobotConfiguration(sim, snapshot, input.worldId)
  let robot: Awaited<ReturnType<SimWorlds['describe']>> | undefined
  let robotDetail: RobotConfigurationResult['robotDetail']
  if (!outcome.syncRequired && input.worldId !== undefined) {
    try { robot = await sim.describe(input.worldId, input.entityId) }
    catch (error) { robotDetail = { status: 'UNAVAILABLE', reason: `ROBOT_DESCRIPTION_READBACK_FAILED: 装配已保存为场景版本 ${snapshot.revision}；机器人详情读回不可用。${errorText(error)}` } }
  }
  return {
    status: changed ? 'UPDATED' : 'UNCHANGED',
    saved: true,
    sync: outcome.syncRequired ? 'REQUIRED' : 'SYNCED',
    syncRequired: outcome.syncRequired,
    sceneId: input.sceneId,
    revision: snapshot.revision,
    ...(input.worldId === undefined ? {} : { worldId: input.worldId }),
    ...(outcome.world ? { worldGeneration: outcome.world.worldGeneration, appliedSceneRevision: outcome.world.appliedSceneRevision } : {}),
    entityId: input.entityId,
    snapshot,
    ...(outcome.world ? { world: outcome.world } : {}),
    ...(outcome.frame ? { frame: outcome.frame } : {}),
    ...(robotDetail ? { robotDetail } : {}),
    ...(robot ? { robot } : {}),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  }
}
