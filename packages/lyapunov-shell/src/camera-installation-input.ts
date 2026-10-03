import { Matrix4, Quaternion, Vector3 } from 'three'
import type { Entity, SceneCameraComponent, SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import type { ViewerAnnotationAnchor } from '../../viewer/src/annotations.ts'
import { rigidPoseOf, mountLocalFrom, type RigidPose } from '../../viewer/src/camera-frustum.ts'
import { fovYFromIntrinsics, normalizeIntrinsics, type ViewerCameraIntrinsics, type ViewerQuat, type ViewerVec3 } from '../../viewer/src/camera-view.ts'
import { cameraDraftOfScene } from './camera-installation.ts'
import { sceneCameraDraftOf, type CameraMountBody, type SceneCameraDraft } from './workbench-camera.ts'

/** 与字符串表单共用持久安装操作的结构化输入；parent 明确指真实 body 局部系。 */
export interface CameraInstallationInput {
  referenceFrame?: 'world' | 'parent'
  positionM?: ViewerVec3
  annotationId?: string
  captureId?: string
  offsetM?: ViewerVec3
  normal?: ViewerVec3
  up?: ViewerVec3
  quaternionXyzw?: ViewerQuat
  fovYDeg?: number
  width?: number; height?: number; near?: number; far?: number
  intrinsics?: ViewerCameraIntrinsics
}
export interface CameraInstallationAnnotation {
  sceneId?: string; sceneRevision?: number
  annotationId: string; entityId: string; anchor: ViewerAnnotationAnchor
}
export function installationVector(value: unknown, name: string): ViewerVec3 {
  if (!Array.isArray(value) || value.length !== 3 || value.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw Error(`CAMERA_INSTALL_VECTOR_INVALID: ${name} requires three finite numbers`)
  return [...value] as ViewerVec3
}
/** 相机 -Z 为视线；未指定 up 时以最短旋转保留原安装的 roll，不隐含世界 up。 */
export function cameraQuaternionFromNormal(normal: unknown, previous: ViewerQuat, up?: unknown): ViewerQuat {
  const forward = new Vector3(...installationVector(normal, 'normal'))
  if (forward.lengthSq() < 1e-12) throw Error('CAMERA_INSTALL_NORMAL_ZERO: normal must be nonzero')
  forward.normalize()
  const original = rigidPoseOf({positionM:[0,0,0],quaternionXyzw:previous})
  if (!original) throw Error('CAMERA_INSTALL_QUATERNION_INVALID')
  const q = new Quaternion(...original.quaternionXyzw)
  if (up === undefined) {
    const priorForward = new Vector3(0,0,-1).applyQuaternion(q)
    q.premultiply(new Quaternion().setFromUnitVectors(priorForward,forward)).normalize()
  } else {
    const upAxis = new Vector3(...installationVector(up, 'up'))
    if (upAxis.lengthSq() < 1e-12) throw Error('CAMERA_INSTALL_UP_ZERO: up must be nonzero')
    const right = new Vector3().crossVectors(forward,upAxis.normalize())
    if (right.lengthSq() < 1e-12) throw Error('CAMERA_INSTALL_UP_COLLINEAR: normal and up cannot be collinear')
    right.normalize()
    q.setFromRotationMatrix(new Matrix4().makeBasis(right,new Vector3().crossVectors(right,forward).normalize(),forward.clone().negate())).normalize()
  }
  return q.toArray() as ViewerQuat
}
const matrix = (pose: RigidPose) => new Matrix4().compose(new Vector3(...pose.positionM),new Quaternion(...pose.quaternionXyzw),new Vector3(1,1,1))
const compose = (body: RigidPose, local: RigidPose): RigidPose => ({positionM:new Vector3(...local.positionM).applyMatrix4(matrix(body)).toArray() as ViewerVec3,quaternionXyzw:new Quaternion(...body.quaternionXyzw).multiply(new Quaternion(...local.quaternionXyzw)).normalize().toArray() as ViewerQuat})
/** 批注必须由相同 Scene/revision 的真实 body 命中产生。安装只从这一份清单的同帧 FK 换算。 */
export function cameraDraftFromInstallation(scene: SceneSnapshot, input: CameraInstallationInput, options: {
  existing?: Entity; name?: string; mount?: {entityId:string;bodyName:string}; bodies: readonly CameraMountBody[]
  worldId?: string; generation?: number; frameId?: string; stepIndex?: number; annotation?: CameraInstallationAnnotation
}): SceneCameraDraft {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('CAMERA_INSTALL_INPUT_REQUIRED')
  const prior = options.existing ? cameraDraftOfScene(scene,options.existing) : sceneCameraDraftOf()
  const component = options.existing?.components.camera as SceneCameraComponent | undefined
  const mount = options.mount ?? component?.mount
  const matches = mount ? options.bodies.filter(b => b.entityId === mount.entityId && b.bodyName === mount.bodyName) : []
  const body = matches[0], bodyPose = body && rigidPoseOf(body.worldFromBody)
  if (mount && (matches.length !== 1 || !bodyPose || body?.frameId !== options.frameId || body?.stepIndex !== options.stepIndex || !options.worldId || !Number.isInteger(options.generation) || !options.frameId || !Number.isInteger(options.stepIndex))) throw Error('CAMERA_INSTALL_BODY_FRAME_REQUIRED: select a unique real body from the current camera_list frame')
  if (mount && !scene.entities.some(e => e.entityId === mount.entityId)) throw Error('CAMERA_INSTALL_ENTITY_MISSING')
  const priorPose = rigidPoseOf({positionM:prior.position.split(/[\s,]+/).map(Number),quaternionXyzw:prior.quaternion.split(/[\s,]+/).map(Number)})!
  const sameMount = component?.mount?.entityId === mount?.entityId && component?.mount?.bodyName === mount?.bodyName
  let local = priorPose
  if (!sameMount && component?.mount) {
    if(input.positionM===undefined&&input.annotationId===undefined)throw Error('CAMERA_INSTALL_REMOUNT_POSITION_REQUIRED: use current-view or supply an installation for the new body')
    local={positionM:[0,0,0],quaternionXyzw:[0,0,0,1]}
  }
  if (!component?.mount && mount && options.existing) local = mountLocalFrom(priorPose,bodyPose!)
  const requestedPose = input.referenceFrame === 'world' && mount ? compose(bodyPose!,local) : local
  let position = requestedPose.positionM, orientation = requestedPose.quaternionXyzw
  if(input.referenceFrame!==undefined&&!['world','parent'].includes(input.referenceFrame))throw Error('CAMERA_INSTALL_REFERENCE_INVALID')
  let annotationNormal: ViewerVec3 | undefined
  if (input.annotationId !== undefined) {
    if (input.positionM !== undefined || input.referenceFrame === 'world') throw Error('CAMERA_INSTALL_ANNOTATION_POSITION_CONFLICT: annotation uses its real body-local point; offsetM is body-local')
    const a=options.annotation, anchor=a?.anchor, sampled=anchor?.body
    if (!a || a.annotationId !== input.annotationId || a.sceneId !== scene.sceneId || a.sceneRevision !== scene.revision || anchor?.sceneId !== scene.sceneId || anchor?.sceneRevision !== scene.revision) throw Error('CAMERA_INSTALL_ANNOTATION_STALE: capture a new annotation in the current Scene revision')
    if (!mount || a.entityId !== mount.entityId || anchor.entityId !== mount.entityId || !sampled || sampled.bodyName !== mount.bodyName || sampled.worldId !== options.worldId || sampled.generation !== options.generation) throw Error('CAMERA_INSTALL_ANNOTATION_BODY_REQUIRED: annotation must identify the selected real body in this world generation')
    position = installationVector(sampled.surfaceLocalM??sampled.localM,'annotation body surface local')
    annotationNormal = sampled.normalLocal && installationVector(sampled.normalLocal,'annotation normal')
    orientation = local.quaternionXyzw
  } else if (input.positionM !== undefined) {
    if (!['world','parent'].includes(input.referenceFrame!)) throw Error('CAMERA_INSTALL_REFERENCE_REQUIRED: positionM requires referenceFrame=world or parent')
    position = installationVector(input.positionM,'positionM')
  } else if (!options.existing) throw Error('CAMERA_INSTALL_POSITION_REQUIRED: use an annotation or an explicit referenceFrame and positionM; model names do not define centers')
  if (input.referenceFrame === 'parent' && !mount) throw Error('CAMERA_INSTALL_PARENT_REQUIRED')
  if (input.offsetM !== undefined) {
    if (!input.annotationId) throw Error('CAMERA_INSTALL_OFFSET_REQUIRES_ANNOTATION: use positionM for an offset from the declared frame origin')
    position = new Vector3(...position).add(new Vector3(...installationVector(input.offsetM,'offsetM'))).toArray() as ViewerVec3
  }
  if (input.quaternionXyzw !== undefined && (input.normal !== undefined || input.up !== undefined)) throw Error('CAMERA_INSTALL_ORIENTATION_CONFLICT: choose quaternionXyzw or normal/up')
  if (input.up !== undefined && input.normal === undefined) throw Error('CAMERA_INSTALL_NORMAL_REQUIRED: up needs an explicit normal')
  if (input.normal !== undefined || input.quaternionXyzw !== undefined) {
    if (!['world','parent'].includes(input.referenceFrame!)) throw Error('CAMERA_INSTALL_REFERENCE_REQUIRED: orientation requires referenceFrame=world or parent')
    if (input.normal !== undefined) orientation=cameraQuaternionFromNormal(input.normal,orientation,input.up)
    else {
      const pose=rigidPoseOf({positionM:[0,0,0],quaternionXyzw:input.quaternionXyzw})
      if (!pose) throw Error('CAMERA_INSTALL_QUATERNION_INVALID')
      orientation=pose.quaternionXyzw
    }
  } else if (annotationNormal) orientation=cameraQuaternionFromNormal(annotationNormal,orientation)
  else if (!options.existing) throw Error('CAMERA_INSTALL_ORIENTATION_REQUIRED: supply normal or quaternionXyzw; the annotation must have a measured surface normal')
  const pose=input.referenceFrame==='world'&&mount?mountLocalFrom({positionM:position,quaternionXyzw:orientation},bodyPose!):{positionM:position,quaternionXyzw:orientation}
  if(options.existing&&input.positionM===undefined&&input.annotationId===undefined)pose.positionM=[...local.positionM]
  const k=input.intrinsics===undefined?prior.intrinsics:normalizeIntrinsics(input.intrinsics)
  const fov=input.fovYDeg??(input.intrinsics?fovYFromIntrinsics(k!):Number(prior.fovYDeg))
  for (const key of ['fovYDeg','width','height','near','far'] as const) if(input[key]!==undefined && (typeof input[key]!=='number'||!Number.isFinite(input[key])))throw Error(`CAMERA_INSTALL_LENS_INVALID: ${key}`)
  return {...prior,name:options.name??options.existing?.name??'Eye camera',position:pose.positionM.join(' '),quaternion:pose.quaternionXyzw.join(' '),parentEntityId:mount?.entityId??'',bodyName:mount?.bodyName??'',fovYDeg:String(fov),width:String(input.width??k?.width??prior.width),height:String(input.height??k?.height??prior.height),near:String(input.near??prior.near),far:String(input.far??prior.far),...(k?{intrinsics:k}:{})}
}
