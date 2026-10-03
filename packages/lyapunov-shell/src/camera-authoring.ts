import type { Entity, SceneCameraComponent, SceneSnapshot, WorldHandle } from '../../lyapunov-contracts/src/types.ts'
import type { ViewerViewState } from '@lyapunov/viewer/client'
import type { ViewerCameraMeasurement } from '../../viewer/src/camera-view.ts'
import { fovYFromIntrinsics, normalizeIntrinsics } from '../../viewer/src/camera-view.ts'
import { mountLocalFrom, rigidPoseOf, type RigidPose } from '../../viewer/src/camera-frustum.ts'
import { sceneCameraDraftOf, type CameraMountBody, type SceneCameraDraft } from './workbench-camera.ts'

/** 只读采样来自Viewer实际已显示Frame，不使用轮询清单来替它的body姿态。 */
export interface CameraAuthoringSnapshot {
  sceneId?: string; sceneRevision?: number; worldId?: string; generation?: number; frameId?: string; stepIndex?: number
  view: ViewerViewState; camera: ViewerCameraMeasurement
  bodies?: CameraMountBody[]
}
export interface CameraAuthoringViewer {
  sampleCameraAuthoring(): CameraAuthoringSnapshot
  focusRobotAnchor?(entityId: string, kind: 'tcp' | 'base'): unknown
  observerState?(): { mode: 'free' | 'pilot' | 'camera-edit'; cameraId?: string; navigation: 'orbit' | 'first-person'; dirty: boolean; saving?:boolean;error?:string; positionLocked?:boolean; scope: {sceneId?:string;sceneRevision?:number;worldId?:string;generation?:number} }
  subscribeObserverState?(listener:()=>void):()=>void
  exitCameraMode?(options?:{restoreView?:boolean;focus?:boolean}):unknown
  finishCameraRigEditing?(options?:{discard?:boolean}):unknown
  aimCameraRig?(key:string):void
  selectCameraRig?(key:string):void
  setCameraRigAimFov?(fovYDeg:number):void
}
export interface CameraExitBridge {
  registerExitParticipant?(id:string,participant:{summary():{dirtyDrafts:number;runningActions:number};flush():Promise<void>}):()=>void
}
export function sampleCameraForAuthoring(viewer: unknown, scene: SceneSnapshot): CameraAuthoringSnapshot {
  const source = viewer as Partial<CameraAuthoringViewer> | undefined
  if (typeof source?.sampleCameraAuthoring !== 'function') throw new Error('CAMERA_AUTHORING_SAMPLE_UNAVAILABLE: 当前Viewer尚未提供同帧相机采样，请刷新客户端')
  const sampled = source.sampleCameraAuthoring()
  requireCameraSample(scene, sampled)
  return sampled
}
export function requireCameraSample(scene: SceneSnapshot, sampled: CameraAuthoringSnapshot) {
  if (sampled.sceneId !== scene.sceneId || sampled.sceneRevision !== scene.revision) throw new Error('CAMERA_AUTHORING_SCENE_STALE: 画面不属于当前场景版本，未保存相机')
  const measured = sampled.camera
  if (!measured || measured.projection !== 'perspective' || !rigidPoseOf({ positionM: measured.position, quaternionXyzw: measured.quaternion })) throw new Error('CAMERA_AUTHORING_POSE_REQUIRED: 缺少当前画面的真实透视相机位姿')
  const k = normalizeIntrinsics(measured.intrinsics)
  if (measured.imageWidth !== k.width || measured.imageHeight !== k.height) throw new Error('CAMERA_AUTHORING_LENS_MISMATCH: 画布分辨率与当前像素内参不一致')
  if (!(measured.near > 0 && measured.far > measured.near) || !Number.isFinite(measured.far)) throw new Error('CAMERA_AUTHORING_CLIP_REQUIRED: 当前相机裁剪面无效')
  return sampled
}
export function cameraSampleBodies(scene: SceneSnapshot, world: WorldHandle | undefined, sampled: CameraAuthoringSnapshot): CameraMountBody[] {
  requireCameraSample(scene, sampled)
  if (!world || !['ready', 'running', 'paused'].includes(world.status) || world.sceneId !== scene.sceneId || world.appliedSceneRevision !== scene.revision || sampled.worldId !== world.worldId || sampled.generation !== world.worldGeneration || typeof sampled.frameId !== 'string' || !Number.isInteger(sampled.stepIndex)) throw new Error('CAMERA_AUTHORING_WORLD_STALE: 挂载需要当前世界同版本、同代次的已显示物理帧')
  return (sampled.bodies ?? []).filter(body => body.frameId === sampled.frameId && body.stepIndex === sampled.stepIndex && rigidPoseOf(body.worldFromBody) && scene.entities.some(entity => entity.entityId === body.entityId))
}
/** 当前镜头完整K保留；FOV表示由真实fy定义的有效垂直视场，不替换偏心/非方形像素。 */
export function cameraDraftFromSample(scene: SceneSnapshot, sampled: CameraAuthoringSnapshot, options: { name?: string; world?: WorldHandle; mount?: { entityId: string; bodyName: string } } = {}): SceneCameraDraft {
  requireCameraSample(scene, sampled)
  const measured = sampled.camera, k = normalizeIntrinsics(measured.intrinsics)
  let pose: RigidPose = { positionM: measured.position, quaternionXyzw: measured.quaternion }
  if (options.mount) {
    const bodies = cameraSampleBodies(scene, options.world, sampled)
    const selected = bodies.filter(body => body.entityId === options.mount!.entityId && body.bodyName === options.mount!.bodyName)
    if (selected.length !== 1 || !selected[0]!.worldFromBody) throw new Error('CAMERA_AUTHORING_BODY_REQUIRED: 当前已显示帧中没有唯一的目标连杆位姿，未拼接其它帧')
    pose = mountLocalFrom(pose, selected[0]!.worldFromBody!)
  }
  return { ...sceneCameraDraftOf(), name: options.name ?? '当前画面相机', position: pose.positionM.join(' '), quaternion: pose.quaternionXyzw.join(' '), fovYDeg: String(fovYFromIntrinsics(k)), width: String(k.width), height: String(k.height), near: String(measured.near), far: String(measured.far), intrinsics: k, ...(options.mount ? { parentEntityId: options.mount.entityId, bodyName: options.mount.bodyName } : {}) }
}
/** gizmo事件拥有实际显示身份和完整镜头；已挂载相机只保存它的同帧localPose。 */
export function cameraDraftFromRigEdit(scene:SceneSnapshot,world:WorldHandle|undefined,entity:Entity,edit:any):SceneCameraDraft{
  if(edit?.sceneId!==scene.sceneId||edit.revision!==scene.revision)throw new Error('CAMERA_RIG_EDIT_SCENE_STALE: 安装编辑来自过期场景')
  const component=entity.components.camera as SceneCameraComponent|undefined
  if(!component)throw new Error('CAMERA_RIG_SCENE_CAMERA_REQUIRED')
  const k=normalizeIntrinsics(edit.intrinsics)
  if(edit.width!==k.width||edit.height!==k.height||!(edit.near>0&&edit.far>edit.near)||!Number.isFinite(edit.far))throw new Error('CAMERA_RIG_EDIT_LENS_REQUIRED: 编辑缺少当前真实镜头与裁剪面')
  let pose=rigidPoseOf(edit.worldPose)
  if(component.mount){
    if(!world||!['ready','running','paused'].includes(world.status)||world.sceneId!==scene.sceneId||world.appliedSceneRevision!==scene.revision||edit.worldId!==world.worldId||edit.generation!==world.worldGeneration||!edit.frameId||!Number.isInteger(edit.stepIndex))throw new Error('CAMERA_RIG_EDIT_WORLD_STALE')
    const bodyName=typeof edit.parentBodyName==='string'&&edit.parentBodyName.startsWith(component.mount.entityId+'/')?edit.parentBodyName.slice(component.mount.entityId.length+1):edit.parentBodyName
    if(edit.parentEntityId!==component.mount.entityId||bodyName!==component.mount.bodyName)throw new Error('CAMERA_RIG_EDIT_PARENT_MISMATCH: 挂载body owner已改变')
    pose=rigidPoseOf(edit.localPose)
  }
  if(!pose)throw new Error('CAMERA_RIG_EDIT_POSE_REQUIRED')
  return {...sceneCameraDraftOf(entity),position:pose.positionM.join(' '),quaternion:pose.quaternionXyzw.join(' '),intrinsics:k,fovYDeg:String(fovYFromIntrinsics(k)),width:String(k.width),height:String(k.height),near:String(edit.near),far:String(edit.far)}
}
