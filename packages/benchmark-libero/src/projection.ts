import { SCENE_COORDINATES, type Entity, type Frame, type Representation, type ResourceRef, type SceneSnapshot, type Transform } from '../../lyapunov-contracts/src/types.ts'
import type { WorldHandle } from '../../sim-contract/src/index.ts'

/**
 * 官方 worker 返回的 Scene 投影在进入 Viewer 前必须在这里被校验。
 * 约定：校验失败一律 fail-closed（不把半成品交给 setScene），但绝不因此中断官方 episode。
 */

const ROOT_FORMATS = ['mjcf', 'urdf']

/**
 * worker 的 open 结果在共享 WorldHandle 之上多带 Scene 投影字段（ProcessSimProvider 原样透传额外字段）。
 * sim-contract 只承诺已知字段，这里把额外字段显式类型化，读取端不必再靠 any。
 */
export type WorkerOpenResult = WorldHandle & {
  appliedSceneRevision?: number
  /** 官方编译模型的真实 SceneSnapshot；UNAVAILABLE 时缺席。 */
  scene?: unknown
  /** worker 自报的投影摘要（status/code/message/entityIds/robotJointNames/warnings）。 */
  projection?: Record<string, unknown>
}

export interface SceneProjectionState {
  /** AVAILABLE 时 scene 必定通过校验且与 appliedSceneRevision 一致。 */
  status: 'AVAILABLE' | 'UNAVAILABLE'
  scene?: SceneSnapshot
  code?: string
  message?: string
  sceneRevision: number
  entityIds: string[]
  robotEntityId?: string
  robotJointNames: string[]
  warnings: string[]
}

export interface FrameAlignment {
  /** 帧里的实体是否都能在 Scene 中找到（找不到就无法投影）。 */
  aligned: boolean
  frameEntityCount: number
  frameEntitiesOutsideScene: string[]
  sceneEntitiesMissingFromFrame: string[]
  jointEntityIds: string[]
}

function fail(code: string, detail?: string): never {
  throw new Error(detail ? `${code}: ${detail}` : code)
}

function numberList(value: unknown, length: number, code: string): number[] {
  if (!Array.isArray(value) || value.length !== length) fail(code, `需要 ${length} 个数值`)
  return (value as unknown[]).map(item => {
    if (typeof item !== 'number' || !Number.isFinite(item)) fail(code, '包含非有限数值')
    return item as number
  })
}

function nonEmptyString(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value) fail(code, '需要非空字符串')
  return value
}

function validateTransform(value: unknown, entityId: string): Transform {
  const record = value as { position?: unknown; quaternion?: unknown; scale?: unknown } | undefined
  const code = `BENCHMARK_SCENE_TRANSFORM_INVALID(${entityId})`
  if (!record || typeof record !== 'object') fail(code, '缺少 transform')
  const position = numberList(record.position, 3, code)
  const quaternion = numberList(record.quaternion, 4, code)
  const scale = numberList(record.scale, 3, code)
  const norm = Math.hypot(quaternion[0]!, quaternion[1]!, quaternion[2]!, quaternion[3]!)
  if (!(norm > 1e-6)) fail(code, '四元数退化')
  if (!scale.every(item => item > 0)) fail(code, 'scale 必须为正')
  return {
    position: position as Transform['position'],
    quaternion: quaternion.map(item => item / norm) as Transform['quaternion'],
    scale: scale as Transform['scale'],
  }
}

function validateRepresentation(value: unknown, code: string): Representation {
  const record = value as { uri?: unknown; mimeType?: unknown; role?: unknown } | undefined
  if (!record || typeof record !== 'object') fail(code, '缺少 representation')
  const result: Representation = {
    uri: nonEmptyString(record.uri, code),
    mimeType: nonEmptyString(record.mimeType, code),
  }
  if (record.role !== undefined) result.role = nonEmptyString(record.role, code)
  return result
}

function validateResource(value: unknown, entityId: string): ResourceRef {
  const code = `BENCHMARK_SCENE_RESOURCE_INVALID(${entityId})`
  const record = value as Record<string, unknown> | undefined
  if (!record || typeof record !== 'object') fail(code, '缺少 resource')
  if (typeof record.version !== 'number' || !Number.isInteger(record.version) || record.version < 0) fail(code, 'version 非法')
  if (!Array.isArray(record.representations) || record.representations.length === 0) fail(code, '缺少 representations')
  const source = record.source as { units?: unknown; upAxis?: unknown; handedness?: unknown } | undefined
  if (!source || source.handedness !== 'right') fail(code, '只接受右手坐标源')
  if (!['X', 'Y', 'Z'].includes(String(source.upAxis))) fail(code, 'upAxis 非法')
  return {
    resourceId: nonEmptyString(record.resourceId, code),
    version: record.version,
    original: validateRepresentation(record.original, code),
    representations: record.representations.map(item => validateRepresentation(item, code)),
    source: {
      units: nonEmptyString(source.units, code),
      upAxis: source.upAxis as ResourceRef['source']['upAxis'],
      handedness: 'right',
      ...(typeof (source as { metersPerUnit?: unknown }).metersPerUnit === 'number'
        ? { metersPerUnit: (source as { metersPerUnit: number }).metersPerUnit }
        : {}),
    },
  }
}

function validateVisual(value: unknown, entityId: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  const code = `BENCHMARK_SCENE_VISUAL_INVALID(${entityId})`
  const record = value as Record<string, unknown> | undefined
  if (!record || typeof record !== 'object') fail(code, 'visual 必须是对象')
  if (record.kind !== 'robot') fail(code, `官方投影只产出 robot 视觉，收到 ${String(record.kind)}`)
  const robot = record.robot as Record<string, unknown> | undefined
  if (!robot || typeof robot !== 'object') fail(code, '缺少 robot 描述')
  const format = nonEmptyString(robot.format, code)
  if (!ROOT_FORMATS.includes(format)) fail(code, `不支持的格式 ${format}`)
  if (!robot.document || typeof robot.document !== 'object') fail(code, '缺少 document')
  nonEmptyString(robot.baseUri, code)
  if (robot.rootBody !== undefined) nonEmptyString(robot.rootBody, code)
  return record
}

/** 把 worker 的 Scene 文档校验成 Viewer 可用的 SceneSnapshot；任何异常都抛出带码错误。 */
export function validateSceneSnapshot(value: unknown): SceneSnapshot {
  const record = value as Record<string, unknown> | undefined
  if (!record || typeof record !== 'object') fail('BENCHMARK_SCENE_INVALID', 'Scene 不是对象')
  const sceneId = nonEmptyString(record.sceneId, 'BENCHMARK_SCENE_INVALID')
  if (typeof record.revision !== 'number' || !Number.isInteger(record.revision) || record.revision < 0) {
    fail('BENCHMARK_SCENE_INVALID', 'revision 必须是非负整数')
  }
  const coordinates = record.coordinates as Record<string, unknown> | undefined
  if (!coordinates || JSON.stringify(coordinates) !== JSON.stringify(SCENE_COORDINATES)) {
    fail('BENCHMARK_SCENE_COORDINATES_MISMATCH', 'coordinates 必须与共享坐标约定一致')
  }
  if (!Array.isArray(record.entities) || record.entities.length === 0) fail('BENCHMARK_SCENE_INVALID', 'entities 不能为空')
  const entities: Entity[] = []
  const seen = new Set<string>()
  for (const item of record.entities as unknown[]) {
    const raw = item as Record<string, unknown> | undefined
    if (!raw || typeof raw !== 'object') fail('BENCHMARK_SCENE_INVALID', 'entity 不是对象')
    const entityId = nonEmptyString(raw.entityId, 'BENCHMARK_SCENE_INVALID')
    if (seen.has(entityId)) fail('BENCHMARK_SCENE_ENTITY_DUPLICATE', entityId)
    seen.add(entityId)
    if (!Array.isArray(raw.resources)) fail(`BENCHMARK_SCENE_RESOURCE_INVALID(${entityId})`, 'resources 必须是数组')
    const components = raw.components
    if (!components || typeof components !== 'object') fail(`BENCHMARK_SCENE_VISUAL_INVALID(${entityId})`, '缺少 components')
    const visual = validateVisual((components as Record<string, unknown>).visual, entityId)
    entities.push({
      entityId,
      ...(raw.parentId === undefined ? {} : { parentId: nonEmptyString(raw.parentId, 'BENCHMARK_SCENE_INVALID') }),
      name: typeof raw.name === 'string' && raw.name ? raw.name : entityId,
      transform: validateTransform(raw.transform, entityId),
      resources: (raw.resources as unknown[]).map(item => validateResource(item, entityId)),
      components: { ...(components as Record<string, unknown>), ...(visual ? { visual } : {}) } as Entity['components'],
    })
  }
  const byId = new Map(entities.map(entity => [entity.entityId, entity]))
  for (const entity of entities) {
    if (entity.parentId === undefined) continue
    if (!byId.has(entity.parentId)) fail('BENCHMARK_SCENE_PARENT_MISSING', `${entity.entityId} -> ${entity.parentId}`)
    const chain = new Set<string>([entity.entityId])
    let current: Entity | undefined = byId.get(entity.parentId)
    while (current) {
      if (chain.has(current.entityId)) fail('BENCHMARK_SCENE_PARENT_CYCLE', entity.entityId)
      chain.add(current.entityId)
      current = current.parentId === undefined ? undefined : byId.get(current.parentId)
    }
  }
  return { sceneId, revision: record.revision, coordinates: { ...SCENE_COORDINATES }, entities }
}

function robotJointNames(scene: SceneSnapshot | undefined): string[] {
  if (!scene) return []
  for (const entity of scene.entities) {
    const mujoco = entity.components.mujoco as { jointNames?: unknown } | undefined
    if (entity.components.visual?.kind === 'robot' && (entity.components.visual.robot as { rootBody?: unknown } | undefined)?.rootBody
      && Array.isArray(mujoco?.jointNames) && mujoco.jointNames.length) {
      return mujoco.jointNames.map(String)
    }
  }
  return []
}

/**
 * 读取 worker 的 open 结果：只有通过校验、且 revision 与世界句柄一致的 Scene 才标记 AVAILABLE。
 * 失败时返回带 code 的 UNAVAILABLE，官方 episode 继续可用（只是 Viewer 无场景）。
 */
export interface ProjectedJoint {
  name: string
  type: 'hinge' | 'slide'
  unit: 'rad' | 'm'
  body?: string
}

/** 官方机器人实体的真实关节（名称/类型/单位都来自编译模型，不是任务清单里的占位名）。 */
export function robotJoints(state: SceneProjectionState): ProjectedJoint[] {
  const scene = state.scene
  if (!scene) return []
  for (const entity of scene.entities) {
    if (entity.components.visual?.kind !== 'robot') continue
    const mujoco = entity.components.mujoco as { joints?: unknown } | undefined
    if (!Array.isArray(mujoco?.joints)) continue
    const joints = (mujoco.joints as Array<Record<string, unknown>>)
      .filter(record => record && typeof record.name === 'string' && record.name)
      .map(record => ({
        name: String(record.name),
        type: record.type === 'slide' ? 'slide' as const : 'hinge' as const,
        unit: record.type === 'slide' ? 'm' as const : 'rad' as const,
        ...(typeof record.body === 'string' && record.body ? { body: record.body } : {}),
      }))
    if (joints.length) return joints
  }
  return []
}

export function unavailableSceneProjection(code: string, message: string): SceneProjectionState {
  return { status: 'UNAVAILABLE', code, message, sceneRevision: 0, entityIds: [], robotJointNames: [], warnings: [] }
}

export function sceneProjectionFrom(handle: unknown): SceneProjectionState {
  const record = (handle ?? {}) as Record<string, unknown>
  const reported = record.projection as Record<string, unknown> | undefined
  const applied = typeof record.appliedSceneRevision === 'number' ? record.appliedSceneRevision : undefined
  const warnings = Array.isArray(reported?.warnings)
    ? (reported!.warnings as unknown[]).map(String)
    : []
  const base = { sceneRevision: applied ?? 0, entityIds: [] as string[], robotJointNames: [] as string[], warnings }
  if (record.scene === undefined || record.scene === null) {
    return {
      ...base,
      status: 'UNAVAILABLE',
      code: typeof reported?.code === 'string' ? reported.code : 'BENCHMARK_SCENE_UNAVAILABLE',
      message: typeof reported?.message === 'string'
        ? reported.message
        : '官方世界未提供 Scene 投影（worker 未产出，或当前是注入的 protocol double）',
    }
  }
  try {
    const scene = validateSceneSnapshot(record.scene)
    if (applied !== undefined && applied !== scene.revision) {
      fail('BENCHMARK_SCENE_REVISION_MISMATCH', `世界句柄 ${applied} != Scene ${scene.revision}`)
    }
    return {
      status: 'AVAILABLE',
      scene,
      sceneRevision: scene.revision,
      entityIds: scene.entities.map(entity => entity.entityId),
      robotEntityId: scene.entities.find(entity => /^official-robot/.test(entity.entityId))?.entityId,
      robotJointNames: robotJointNames(scene),
      warnings,
    }
  } catch (error) {
    return {
      ...base,
      status: 'UNAVAILABLE',
      code: 'BENCHMARK_SCENE_INVALID',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 帧覆盖检查：帧里的实体必须都来自当前 Scene，否则 Viewer 无法投影该实体。 */
export function frameAlignment(scene: SceneSnapshot | undefined, frame: Frame | undefined): FrameAlignment {
  if (!scene || !frame) {
    return { aligned: false, frameEntityCount: 0, frameEntitiesOutsideScene: [], sceneEntitiesMissingFromFrame: [], jointEntityIds: [] }
  }
  const sceneIds = new Set(scene.entities.map(entity => entity.entityId))
  const frameIds = new Set(frame.entities.map(entity => entity.entityId))
  const frameEntitiesOutsideScene = frame.entities.map(entity => entity.entityId).filter(entityId => !sceneIds.has(entityId))
  return {
    aligned: frameEntitiesOutsideScene.length === 0,
    frameEntityCount: frame.entities.length,
    frameEntitiesOutsideScene,
    sceneEntitiesMissingFromFrame: [...sceneIds].filter(entityId => !frameIds.has(entityId)),
    jointEntityIds: frame.entities.filter(entity => entity.joints && entity.joints.names.length > 0).map(entity => entity.entityId),
  }
}

/** bench_load / bench_result 里给模型看的紧凑摘要；不含 Scene 文档本身。 */
export function projectionSummary(state: SceneProjectionState, frame?: Frame): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    status: state.status,
    source: 'official-env',
    sceneRevision: state.sceneRevision,
    entityCount: state.entityIds.length,
    entityIds: state.entityIds,
  }
  if (state.robotEntityId) summary.robotEntityId = state.robotEntityId
  if (state.robotJointNames.length) summary.robotJointNames = state.robotJointNames
  if (state.scene) {
    const alignment = frameAlignment(state.scene, frame)
    summary.frame = {
      aligned: alignment.aligned,
      frameEntityCount: alignment.frameEntityCount,
      frameEntitiesOutsideScene: alignment.frameEntitiesOutsideScene,
      sceneEntitiesMissingFromFrame: alignment.sceneEntitiesMissingFromFrame,
      jointEntityIds: alignment.jointEntityIds,
    }
  }
  if (state.code) summary.code = state.code
  if (state.message) summary.message = state.message
  if (state.warnings.length) summary.warnings = state.warnings
  return summary
}
