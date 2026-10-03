import { isDeepStrictEqual } from 'node:util'
import type { Entity, WorldHandle } from '../../lyapunov-contracts/src/types.ts'
import type { RobotSetTcpInput, RobotSetBaseInput, RobotConfigurationIdentity, RobotTcpDefinition, RobotBaseBinding } from '../../lyapunov-contracts/src/robot-authoring.ts'
import { validRobotPose } from '../../lyapunov-contracts/src/robot-authoring.ts'
import type { SimWorlds } from '../../sim-contract/src/index.ts'
import type { SceneReader } from './operations.ts'

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
async function commitConfiguration(sim: SimWorlds, scene: SceneReader, input: RobotConfigurationIdentity, before: Entity, components: Entity['components']) {
  // describe 期间可能已有别的配置提交；Scene CAS 与 world 代次都再核一次。
  const worldAtCommit = (await sim.listWorlds()).find(world => world.worldId === input.worldId)
  if (worldAtCommit?.sceneId !== input.sceneId || worldAtCommit.worldGeneration !== input.expectedGeneration || worldAtCommit.appliedSceneRevision !== input.expectedRevision) throw new Error('STALE_GENERATION: 配置等待期间世界已变化，未写入')
  const changed = !isDeepStrictEqual(before.components, components)
  const snapshot = changed ? await scene.commit({ sceneId: input.sceneId, expectedRevision: input.expectedRevision, patch: [{ op: 'update', entityId: input.entityId, changes: { components } }] }) : await scene.snapshot(input.sceneId)
  if (!changed && snapshot.revision !== input.expectedRevision) throw new Error('SCENE_REVISION_MISMATCH')
  let world: WorldHandle
  try { world = changed ? await sim.sync(input.worldId, snapshot) : worldAtCommit }
  catch (error) { throw new Error(`ROBOT_CONFIGURATION_SYNC_FAILED: 配置已保存为场景版本 ${snapshot.revision}，原生世界未就绪；请使用同步重试。${error instanceof Error ? error.message : String(error)}`) }
  const frame = await sim.observe(input.worldId, { sensors: true, contacts: true })
  if (world.appliedSceneRevision !== snapshot.revision || frame.generation !== world.worldGeneration || frame.sceneRevision !== snapshot.revision) throw new Error('ROBOT_CONFIGURATION_FRAME_STALE: 配置已保存，但尚无对应版本的原生帧')
  return { status: changed ? 'UPDATED' : 'UNCHANGED', snapshot, world, frame, entityId: input.entityId, robot: await sim.describe(input.worldId, input.entityId) }
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
  return commitConfiguration(sim, scene, input, entity, { ...entity.components, controller })
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
    } else if (base.target.bodyName) throw new Error('ROBOT_BASE_TARGET_INVALID: 世界锚点不携带 bodyName')
    declaration = { ...declaration, target: structuredClone(base.target) }
  } else if (base.target !== undefined) throw new Error('ROBOT_BASE_TARGET_INVALID: free/source 不携带固定锚点')
  const components = { ...entity.components }
  if (base.mode === 'source') delete components.baseBinding
  else components.baseBinding = declaration as unknown as Record<string, unknown>
  return commitConfiguration(sim, scene, input, entity, components)
}
