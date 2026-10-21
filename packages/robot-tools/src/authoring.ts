import { isDeepStrictEqual } from 'node:util'
import type { Entity, Frame, SceneSnapshot, WorldHandle } from '../../lyapunov-contracts/src/types.ts'
import type { RobotSetTcpInput, RobotSetBaseInput, RobotConfigurationIdentity, RobotTcpDefinition, RobotBaseBinding, RobotBindingField, RobotConfigurationReceipt, RobotAssemblyChange } from '../../lyapunov-contracts/src/robot-authoring.ts'
import { validRobotPose } from '../../lyapunov-contracts/src/robot-authoring.ts'
import type { SimWorlds } from '../../sim-contract/src/index.ts'
import { assertSourceInstallable } from './install-eligibility.ts'
import type { SceneReader } from './operations.ts'

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 不使用 Viewer 选择、不猜 body，不把 parentId 当成物理焊接。 */
async function configurationContext(sim: SimWorlds, scene: SceneReader, input: RobotConfigurationIdentity) {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || !Number.isInteger(input.expectedGeneration) || input.expectedGeneration < 1) throw new Error('ROBOT_CONFIGURATION_IDENTITY_REQUIRED: 先读取当前场景版本与物理代次')
  const world = (await sim.listWorlds()).find(world => world.worldId === input.worldId)
  if (!world || world.sceneId !== input.sceneId) throw new Error('WORLD_SCENE_MISMATCH: 当前物理世界不属于指定场景')
  if (world.worldGeneration !== input.expectedGeneration) throw new Error('STALE_GENERATION: 物理世界已重建，请重新读取机器人')
  const snapshot = await scene.snapshot(input.sceneId)
  if (snapshot.revision !== input.expectedRevision || world.appliedSceneRevision !== snapshot.revision) throw new Error('SCENE_REVISION_MISMATCH: 请先同步当前场景，再设置机器人')
  const entity = snapshot.entities.find(entity => entity.entityId === input.entityId)
  if (!entity) throw new Error('ROBOT_ENTITY_MISSING')
  const description = await sim.describe(input.worldId, input.entityId)
  if (description.expectedGeneration !== input.expectedGeneration) throw new Error('STALE_GENERATION')
  return { world, snapshot, entity, description }
}

/** 实体当前资源身份（resourceId@version 序列）；装配写入/预览都复用它判断"异步读帧期间资源有没有变"。 */
export function entityResourceIdentity(entity: { resources?: Array<{ resourceId: string; version: number }> } | undefined): string {
  return (entity?.resources ?? []).map(ref => `${ref.resourceId}@${ref.version}`).join('|')
}

/** 读取一次装配绑定字段的当前声明值；不存在时明确返回 undefined（不伪造空对象）。 */
export function readBindingField(entity: Entity | undefined, field: RobotBindingField): unknown {
  if (!entity) return undefined
  if (field === 'baseBinding') return entity.components.baseBinding === undefined ? undefined : structuredClone(entity.components.baseBinding)
  const controller = entity.components.controller as Record<string, unknown> | undefined
  return controller?.tcp === undefined ? undefined : structuredClone(controller.tcp)
}

/** 只改本次装配触达的那个字段，其余组件与其它实体一字不动（局部 Undo 保护后续无关编辑的基础）。 */
export function writeBindingField(components: Entity['components'], field: RobotBindingField, value: unknown): Entity['components'] {
  const next = structuredClone(components)
  if (field === 'baseBinding') {
    if (value === undefined) delete next.baseBinding
    else next.baseBinding = value
    return next
  }
  const controller = { ...((next.controller as Record<string, unknown> | undefined) ?? {}) }
  if (value === undefined) delete controller.tcp
  else controller.tcp = value
  next.controller = controller
  return next
}

/**
 * 回执里的绑定变化两侧**只输出真实存在的值**：该侧声明本来不存在时**省略键**。
 * 写 `undefined` 会让整份工具结果不是无损 JSON（SDK `snapshotJsonValue` 直接判 INVALID_TOOL_OUTPUT）；
 * 写 `null` 又会把"字段不存在"与用户数据里的 `null` 混为一谈。消费侧读缺键得到 `undefined`，
 * 与原语义一致；内部 Undo 不从这里取 before，而是从历史快照 `readBindingField` 读缺省、`writeBindingField` 删除。
 */
export function presentBindingSides(before: unknown, after: unknown): Pick<RobotAssemblyChange, 'before' | 'after'> {
  return { ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) }
}

export interface RobotSyncOutcome {
  syncRequired: boolean
  reason?: string
  world?: WorldHandle
  frame?: Frame
}

/** 产品回执的机器人侧窄类型：`robot` 是既有 describe 结果，仅同步成功时给出。 */
export type RobotConfigurationResult = RobotConfigurationReceipt & { robot?: Awaited<ReturnType<SimWorlds['describe']>> }

/**
 * 保存之后的原生同步阶段。任何失败都**不抛异常**：调用方已经拿到落盘的 Scene 版本，
 * 这里只如实回答"是否已同步"以及准确原因。world 未打开时不会被隐式启动（不伪造 native 事实）。
 */
export async function syncRobotConfiguration(sim: SimWorlds, snapshot: SceneSnapshot, worldId?: string): Promise<RobotSyncOutcome> {
  let existing: WorldHandle | undefined
  try { existing = worldId === undefined ? undefined : (await sim.listWorlds()).find(world => world.worldId === worldId) } catch { existing = undefined }
  if (!worldId || !existing || existing.status === 'closed') {
    return {
      syncRequired: true,
      reason: `ROBOT_CONFIGURATION_WORLD_NOT_OPEN: 配置已保存为场景版本 ${snapshot.revision}，但当前没有可同步的原生世界；声明已恢复，物理待同步。`,
      ...(existing && existing.sceneId === snapshot.sceneId ? { world: existing } : {}),
    }
  }
  // 提供的 world 必须属于该 Scene：跨 Scene 句柄既不能拿去 sync，也不能当作该 Scene 的原生证据。
  if (existing.sceneId !== snapshot.sceneId) {
    return {
      syncRequired: true,
      reason: `WORLD_SCENE_MISMATCH: world ${existing.worldId} 属于场景 ${existing.sceneId}，不是当前场景 ${snapshot.sceneId}；声明已恢复，物理待同步。`,
    }
  }
  try {
    const world = await sim.sync(worldId, snapshot)
    // sync 返回的句柄身份也必须与请求 worldId/当前 Scene 一致，否则不能作为原生已同步证据。
    if (world.worldId !== worldId || world.sceneId !== snapshot.sceneId) {
      return { syncRequired: true, reason: `ROBOT_CONFIGURATION_WORLD_MISMATCH: 配置已保存为场景版本 ${snapshot.revision}，但 sync 返回的 world 身份与请求或场景不一致；物理待同步。` }
    }
    let frame: Frame
    try { frame = await sim.observe(worldId, { sensors: true, contacts: true }) }
    catch (error) {
      return { syncRequired: true, reason: `ROBOT_CONFIGURATION_FRAME_STALE: 配置已保存为场景版本 ${snapshot.revision}，但尚无对应版本的原生帧。${errorText(error)}`, world }
    }
    if (world.appliedSceneRevision !== snapshot.revision || frame.worldId !== worldId || frame.generation !== world.worldGeneration || frame.sceneRevision !== snapshot.revision) {
      return { syncRequired: true, reason: `ROBOT_CONFIGURATION_FRAME_STALE: 配置已保存为场景版本 ${snapshot.revision}，但尚无对应版本的原生帧。`, world }
    }
    return { syncRequired: false, world, frame }
  } catch (error) {
    let world: WorldHandle | undefined = existing
    try { world = (await sim.listWorlds()).find(candidate => candidate.worldId === worldId) ?? existing } catch { /* 读不回就保留进入前的句柄 */ }
    return {
      syncRequired: true,
      reason: `ROBOT_CONFIGURATION_SYNC_FAILED: 配置已保存为场景版本 ${snapshot.revision}，原生世界未就绪；请使用同步重试。${errorText(error)}`,
      ...(world && world.sceneId === snapshot.sceneId ? { world } : {}),
    }
  }
}

/** 未改变的调用不重建世界、不写 Scene，只回读同版本的既有帧（有则已同步，无则如实待同步）。 */
async function observeUnchangedConfiguration(sim: SimWorlds, snapshot: SceneSnapshot, world: WorldHandle | undefined): Promise<RobotSyncOutcome> {
  if (!world || world.status === 'closed' || world.sceneId !== snapshot.sceneId || world.appliedSceneRevision !== snapshot.revision) return syncRobotConfiguration(sim, snapshot, world?.worldId)
  try {
    const frame = await sim.observe(world.worldId, { sensors: true, contacts: true })
    // 完整帧身份：worldId/generation/sceneRevision 三者都必须对得上，别把别的 world 的同数字帧当成已同步证据。
    if (frame.worldId === world.worldId && frame.generation === world.worldGeneration && frame.sceneRevision === snapshot.revision) return { syncRequired: false, world, frame }
    return { syncRequired: true, reason: `ROBOT_CONFIGURATION_FRAME_STALE: 配置未改变，但尚无对应版本的原生帧。`, world }
  } catch (error) {
    return { syncRequired: true, reason: `ROBOT_CONFIGURATION_FRAME_STALE: 配置未改变，但原生帧读取失败。${errorText(error)}`, world }
  }
}

async function commitConfiguration(sim: SimWorlds, scene: SceneReader, input: RobotConfigurationIdentity, before: Entity, components: Entity['components'], field: RobotBindingField): Promise<RobotConfigurationResult> {
  // describe 期间可能已有别的配置提交；Scene CAS 与 world 代次都再核一次。
  const worldAtCommit = (await sim.listWorlds()).find(world => world.worldId === input.worldId)
  if (worldAtCommit?.sceneId !== input.sceneId || worldAtCommit.worldGeneration !== input.expectedGeneration || worldAtCommit.appliedSceneRevision !== input.expectedRevision) throw new Error('STALE_GENERATION: 配置等待期间世界已变化，未写入')
  const changed = !isDeepStrictEqual(before.components, components)
  const snapshot = changed ? await scene.commit({ sceneId: input.sceneId, expectedRevision: input.expectedRevision, patch: [{ op: 'update', entityId: input.entityId, changes: { components } }] }) : await scene.snapshot(input.sceneId)
  if (!changed && snapshot.revision !== input.expectedRevision) throw new Error('SCENE_REVISION_MISMATCH')
  const outcome = changed ? await syncRobotConfiguration(sim, snapshot, input.worldId) : await observeUnchangedConfiguration(sim, snapshot, worldAtCommit)
  let robot: Awaited<ReturnType<SimWorlds['describe']>> | undefined
  let robotDetail: RobotConfigurationReceipt['robotDetail']
  if (!outcome.syncRequired) {
    // 保存/sync/Frame 事实已经成立；describe 只是详情读回，失败不得回滚、不得抹掉回执。
    try { robot = await sim.describe(input.worldId, input.entityId) }
    catch (error) { robotDetail = { status: 'UNAVAILABLE', reason: `ROBOT_DESCRIPTION_READBACK_FAILED: 装配已保存为场景版本 ${snapshot.revision}；机器人详情读回不可用（保存/同步/Frame 事实不变）。${errorText(error)}` } }
  }
  const after = snapshot.entities.find(entity => entity.entityId === input.entityId)
  return {
    status: changed ? 'UPDATED' : 'UNCHANGED',
    saved: true,
    sync: outcome.syncRequired ? 'REQUIRED' : 'SYNCED',
    syncRequired: outcome.syncRequired,
    sceneId: input.sceneId,
    revision: snapshot.revision,
    worldId: input.worldId,
    ...(outcome.world ? { worldGeneration: outcome.world.worldGeneration, appliedSceneRevision: outcome.world.appliedSceneRevision } : {}),
    entityId: input.entityId,
    snapshot,
    ...(outcome.world ? { world: outcome.world } : {}),
    ...(outcome.frame ? { frame: outcome.frame } : {}),
    ...(robotDetail ? { robotDetail } : {}),
    ...(robot ? { robot } : {}),
    ...(changed ? {
      assembly: {
        sceneId: input.sceneId,
        entityId: input.entityId,
        field,
        beforeRevision: input.expectedRevision,
        afterRevision: snapshot.revision,
        ...presentBindingSides(readBindingField(before, field), readBindingField(after, field)),
        undoable: true,
      },
    } : {}),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  }
}

export async function setRobotTcp(sim: SimWorlds, scene: SceneReader, input: RobotSetTcpInput) {
  const { entity, description } = await configurationContext(sim, scene, input)
  if (input.clear === true && input.tcp !== undefined || input.clear !== true && !input.tcp) throw new Error('TCP_DEFINITION_REQUIRED: 选择真实 body/site，或明确 clear:true')
  const controller = { ...(entity.components.controller ?? {}) }
  if (input.clear) delete controller.tcp
  else {
    const requested = input.tcp!
    if (!description.nativeBodies?.some(body => body.name === requested.body)) throw new Error('TCP_BODY_MISSING: 选中的真实连杆不存在，请刷新机器人')
    let tcp: RobotTcpDefinition
    if (requested.site !== undefined) {
      if (requested.offsetM !== undefined || requested.quaternionXyzw !== undefined) throw new Error('TCP_SITE_OFFSET_CONFLICT: site 使用源局部位姿，不同时给自定义偏移')
      const site = description.nativeSites?.find(site => site.name === requested.site && site.bodyName === requested.body)
      if (!site) throw new Error('TCP_SITE_MISSING: 当前引擎没有该 body 所属的真实 site')
      tcp = { body: site.bodyName, site: site.name, offsetM: [...site.positionM], quaternionXyzw: [...site.quaternionXyzw] }
    } else {
      const pose = { positionM: requested.offsetM ?? [0, 0, 0], quaternionXyzw: requested.quaternionXyzw ?? [0, 0, 0, 1] }
      if (!validRobotPose(pose)) throw new Error('TCP_POSE_INVALID: 位移必须为 XYZ 米，四元数必须归一化')
      tcp = { body: requested.body, offsetM: pose.positionM, quaternionXyzw: pose.quaternionXyzw }
    }
    controller.tcp = tcp
  }
  return commitConfiguration(sim, scene, input, entity, { ...entity.components, controller }, 'controller.tcp')
}

export async function setRobotBase(sim: SimWorlds, scene: SceneReader, input: RobotSetBaseInput) {
  const { snapshot, entity, description } = await configurationContext(sim, scene, input)
  const base = input.base
  if (!base || !['source', 'free', 'fixed'].includes(base.mode)) throw new Error('ROBOT_BASE_MODE_INVALID')
  const body = description.nativeBodies?.find(body => body.name === base.bodyName)
  if (!body?.root) throw new Error('ROBOT_BASE_ROOT_REQUIRED: 只编辑真实根基座，不删除本体内部关节')
  const capability = description.base?.editable
  if (base.mode !== 'source' && !capability?.[base.mode]) throw new Error(`ROBOT_BASE_UNSUPPORTED: ${capability?.reason ?? '当前引擎未提供可核实的基座编辑能力'}`)
  let declaration: RobotBaseBinding = { mode: base.mode, bodyName: base.bodyName }
  if (base.mode === 'free') {
    const frame = await sim.observe(input.worldId, { entityIds: [input.entityId], sensors: true })
    const actual = frame.entities.find(entity => entity.entityId === input.entityId)?.sensors?.robotBase as { worldFromBody?: unknown } | undefined
    if (frame.generation !== input.expectedGeneration || frame.sceneRevision !== input.expectedRevision || !validRobotPose(actual?.worldFromBody)) throw new Error('ROBOT_BASE_OBSERVATION_REQUIRED: 解除前需要当前基座的真实位姿')
    declaration.initialWorldPose = structuredClone(actual.worldFromBody)
  }
  if (base.mode === 'fixed') {
    if (!validRobotPose(base.target)) throw new Error('ROBOT_BASE_ANCHOR_REQUIRED: 固定基座需要有效的锚点位姿')
    if (base.target.entityId) {
      if (!capability?.entity) throw new Error(`ROBOT_BASE_TARGET_UNSUPPORTED: ${capability?.reason ?? '当前引擎不支持实体约束'}`)
      if (!base.target.bodyName || base.target.entityId === input.entityId || !snapshot.entities.some(entity => entity.entityId === base.target!.entityId)) throw new Error('ROBOT_BASE_TARGET_INVALID: 选择其他实体的真实 body')
      const targetReadback = await sim.listCameras(input.worldId) as { generation?: number; worldGeneration?: number; sceneRevision?: number; bodies?: Array<{ entityId?: string; bodyName?: string }> }
      if ((targetReadback.generation ?? targetReadback.worldGeneration) !== input.expectedGeneration || targetReadback.sceneRevision !== input.expectedRevision) throw new Error('ROBOT_BASE_TARGET_STALE')
      if (!targetReadback.bodies?.some(body => body.entityId === base.target!.entityId && body.bodyName === base.target!.bodyName)) throw new Error('ROBOT_BASE_TARGET_BODY_MISSING')
      let next: string | undefined = base.target.entityId
      const seen = new Set([input.entityId])
      while (next) {
        if (seen.has(next)) throw new Error('ROBOT_BASE_BINDING_CYCLE: 基座绑定不可成环')
        seen.add(next)
        next = (snapshot.entities.find(entity => entity.entityId === next)?.components.baseBinding as unknown as RobotBaseBinding | undefined)?.target?.entityId
      }
      // 与 Preview／Replace 共用同一份窄资格判据：目标描述必须与当前代次一致，源含静态 plane 时
      // 不得挂到 moving 目标 body。全部在 commit 前，失败零 Scene 写入。
      const targetDescription = await sim.describe(input.worldId, base.target.entityId)
      if (targetDescription.expectedGeneration !== input.expectedGeneration) throw new Error('STALE_GENERATION: 目标描述代次已变化，拒绝据旧描述挂接')
      assertSourceInstallable(description, base.target.bodyName, targetDescription)
    } else if (base.target.bodyName) throw new Error('ROBOT_BASE_TARGET_INVALID: 世界锚点不携带 bodyName')
    declaration = { ...declaration, target: structuredClone(base.target) }
  } else if (base.target !== undefined) throw new Error('ROBOT_BASE_TARGET_INVALID: free/source 不携带固定锚点')
  const components = { ...entity.components }
  if (base.mode === 'source') delete components.baseBinding
  else components.baseBinding = declaration as unknown as Record<string, unknown>
  return commitConfiguration(sim, scene, input, entity, components, 'baseBinding')
}
