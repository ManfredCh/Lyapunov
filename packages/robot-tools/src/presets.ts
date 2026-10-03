import type { Entity, SceneCameraComponent, SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import type { RobotConfigurationIdentity, RobotTcpDefinition } from '../../lyapunov-contracts/src/robot-authoring.ts'
import type { RobotDescription, SimWorlds } from '../../sim-contract/src/index.ts'
import type { SceneReader } from './operations.ts'
import { mountLocalFrom, rigidPoseOf, type RigidPose } from '../../viewer/src/camera-frustum.ts'
import { fovYFromIntrinsics, normalizeIntrinsics, type ViewerCameraIntrinsics } from '../../viewer/src/camera-view.ts'

export interface RobotCameraPreset {
  id: string; name: string; source: 'mjcf' | 'usd' | 'scene-baseline'; sourceCameraName?: string
  pose: RigidPose; mount?: { entityId: string; bodyName: string }
  intrinsics: ViewerCameraIntrinsics; fovYDeg: number; width: number; height: number; near: number; far: number
}
/** 只读当前原生声明。临时override不作原件preset；局部安装要有同帧唯一body。 */
export function nativeCameraPreset(row: any, receipt: any, entities: readonly Entity[]): RobotCameraPreset {
  if (!row || row.available === false || !['mjcf', 'usd'].includes(row.cameraSource) || row.override || row.positionOverridden || row.quaternionOverridden || row.fovyOverridden) throw new Error('CAMERA_NATIVE_PRESET_UNAVAILABLE: 需要未覆盖的模型原生相机')
  if (!receipt?.frameId || row.frameId !== receipt.frameId || row.stepIndex !== receipt.stepIndex || row.generation !== receipt.generation || row.sceneRevision !== receipt.sceneRevision || row.worldId !== receipt.worldId) throw new Error('CAMERA_PRESET_FRAME_STALE: 原生相机不是当前清单的同一帧')
  const worldPose = rigidPoseOf(row.worldFromCamera), k = normalizeIntrinsics(row.intrinsics)
  const near = row.nearM, far = row.farM
  if (!worldPose || !(near > 0 && far > near) || !Number.isFinite(far)) throw new Error('CAMERA_PRESET_METADATA_MISSING: 原件缺少真实位姿、镜头或裁剪面')
  let pose = worldPose, mount: RobotCameraPreset['mount']
  if (row.parentBodyName && row.parentBodyName !== 'world') {
    const owner = typeof row.parentEntityId === 'string' ? row.parentEntityId : row.entityId
    if (typeof owner !== 'string' || !entities.some(entity => entity.entityId === owner)) throw new Error('CAMERA_PRESET_OWNER_MISSING')
    const prefix = owner + '/', bodyName = row.parentBodyName.startsWith(prefix) ? row.parentBodyName.slice(prefix.length) : row.parentBodyName
    const bodies = (receipt.bodies ?? []).filter((body: any) => body.entityId === owner && body.bodyName === bodyName && body.frameId === receipt.frameId && body.stepIndex === receipt.stepIndex && body.generation === receipt.generation && body.worldId === receipt.worldId && body.sceneRevision === receipt.sceneRevision && rigidPoseOf(body.worldFromBody))
    if (bodies.length !== 1) throw new Error('CAMERA_PRESET_BODY_MISSING: 同帧挂载连杆不唯一或不可读')
    pose = mountLocalFrom(worldPose, rigidPoseOf(bodies[0].worldFromBody)!)
    mount = { entityId: owner, bodyName }
  }
  return { id: row.cameraName, name: row.localName ?? row.cameraName, source: row.cameraSource, sourceCameraName: row.cameraName, pose, ...(mount ? { mount } : {}), intrinsics: k, fovYDeg: fovYFromIntrinsics(k), width: k.width, height: k.height, near, far }
}
export function registeredCameraPresets(snapshot: SceneSnapshot, entityId: string): RobotCameraPreset[] {
  return snapshot.entities.flatMap(entity => {
    const component = entity.components.camera as SceneCameraComponent | undefined, baseline = component?.installation?.baseline
    if (!baseline || baseline.mount?.entityId !== entityId || !rigidPoseOf(baseline)) return []
    try {
      const k = normalizeIntrinsics(baseline.intrinsics)
      return [{ id: `scene:${entity.entityId}`, name: component?.name ?? entity.name, source: 'scene-baseline' as const, pose: { positionM: baseline.positionM, quaternionXyzw: baseline.quaternionXyzw }, mount: { entityId, bodyName: baseline.mount.bodyName }, intrinsics: k, fovYDeg: baseline.fovYDeg, width: baseline.width, height: baseline.height, near: baseline.near, far: baseline.far }]
    } catch { return [] }
  })
}
export function robotPresetProjection(snapshot: SceneSnapshot, description: RobotDescription, receipt?: any) {
  const entity = snapshot.entities.find(entity => entity.entityId === description.entityId)!
  const native: RobotCameraPreset[] = [], unavailable: Array<{ id: string; reason: string }> = []
  for (const row of receipt?.cameras ?? []) {
    if (!['mjcf', 'usd'].includes(row.cameraSource) || row.entityId !== entity.entityId && row.parentEntityId !== entity.entityId) continue
    try { native.push(nativeCameraPreset(row, receipt, snapshot.entities)) } catch (error) { unavailable.push({ id: row.cameraName, reason: String(error instanceof Error ? error.message : error) }) }
  }
  const current = entity.components.controller?.tcp as RobotTcpDefinition | undefined
  return { entityId: entity.entityId, nativeBodies: description.nativeBodies ?? [], tcp: { configured: current ?? null, source: current?.site ? 'native-site' : current ? 'scene-body-local' : 'unset', sites: description.nativeSites ?? [], ...description.nativeSites?.length?{}:{reason:'当前模型没有原生site；可明确选择真实body原点或人工局部偏移。'} }, cameras: { presets: [...native, ...registeredCameraPresets(snapshot, entity.entityId)], unavailable, ...native.length?{}:{reason:'当前本体没有可用原生相机预设；选择真实连杆后用当前画面标定或编辑局部安装。'} }, ...description.base?{base:description.base}:{} }
}
export async function readRobotPresets(sim: SimWorlds, scene: SceneReader, input: RobotConfigurationIdentity) {
  const requireIdentity = async () => {
    const world = (await sim.listWorlds()).find(world => world.worldId === input.worldId), snapshot = await scene.snapshot(input.sceneId)
    if (!world || !['ready', 'running', 'paused'].includes(world.status) || world.sceneId !== input.sceneId || world.worldGeneration !== input.expectedGeneration || world.appliedSceneRevision !== input.expectedRevision || snapshot.revision !== input.expectedRevision || !snapshot.entities.some(entity => entity.entityId === input.entityId)) throw new Error('ROBOT_PRESETS_STALE: 先同步当前场景与物理世界，再读取真实预设')
    return { world, snapshot }
  }
  const { snapshot } = await requireIdentity(), description = await sim.describe(input.worldId, input.entityId)
  if (description.expectedGeneration !== input.expectedGeneration) throw new Error('ROBOT_PRESETS_STALE')
  let receipt: any, cameraReason: string | undefined
  try {
    receipt = await sim.listCameras(input.worldId)
    if (receipt.worldId !== input.worldId || receipt.generation !== input.expectedGeneration || receipt.sceneRevision !== input.expectedRevision) throw new Error('CAMERA_PRESETS_SOURCE_MISMATCH')
  } catch (error) { cameraReason = String(error instanceof Error ? error.message : error); receipt = undefined }
  await requireIdentity()
  const projection = robotPresetProjection(snapshot, description, receipt)
  return { sceneId: input.sceneId, sceneRevision: input.expectedRevision, worldId: input.worldId, generation: input.expectedGeneration, ...projection, cameras: { ...projection.cameras, ...(cameraReason ? { reason: cameraReason } : {}) } }
}
