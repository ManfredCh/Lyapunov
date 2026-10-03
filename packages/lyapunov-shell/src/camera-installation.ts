import type { Entity, SceneCameraComponent, SceneCameraInstallation, SceneCommit, SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import { rigidPoseOf } from '../../viewer/src/camera-frustum.ts'
import { normalizeIntrinsics } from '../../viewer/src/camera-view.ts'
import { intrinsicsFromFovy } from '../../viewer/src/camera-frustum.ts'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { sceneCameraCommit, sceneCameraDraftOf, normalizeDraftLens, type CameraMountBody, type SceneCameraDraft } from './workbench-camera.ts'

export interface CameraSceneSaveInput {
  sceneId: string; expectedRevision: number; entityId?: string; name?: string; clientId?: string
  mode: 'current-view' | 'draft' | 'install' | 'native-preset' | 'restore'
  mount?: { entityId: string; bodyName: string }; draft?: SceneCameraDraft
  worldId?: string; expectedGeneration?: number; presetId?: string
  installation?: import('./camera-installation-input.ts').CameraInstallationInput
}
function entityMatrix(scene:SceneSnapshot,entity:Entity,visited=new Set<string>()):Matrix4{
  if(visited.has(entity.entityId))throw new Error('CAMERA_PARENT_CYCLE')
  visited.add(entity.entityId)
  const local=new Matrix4().compose(new Vector3(...entity.transform.position),new Quaternion(...entity.transform.quaternion),new Vector3(...entity.transform.scale))
  if(!entity.parentId)return local
  const parent=scene.entities.find(row=>row.entityId===entity.parentId)
  if(!parent)throw new Error('CAMERA_PARENT_MISSING')
  return entityMatrix(scene,parent,visited).multiply(local)
}
/** 有普通Scene父节点时，表单仍显示世界机位；mount始终是真实body局部安装。 */
export function cameraDraftOfScene(scene:SceneSnapshot,entity?:Entity):SceneCameraDraft{
  const draft=sceneCameraDraftOf(entity)
  if(!entity?.parentId||draft.parentEntityId)return draft
  const p=new Vector3(),q=new Quaternion(),s=new Vector3()
  entityMatrix(scene,entity).decompose(p,q,s)
  return {...draft,position:p.toArray().join(' '),quaternion:q.normalize().toArray().join(' ')}
}
/** 当前画面、人工安装及原生preset共用一份Scene CAS；普通编辑保留第一次安装基线。 */
export function cameraInstallationCommit(scene: SceneSnapshot, draft: SceneCameraDraft, bodies: readonly CameraMountBody[], entityId: string, source: SceneCameraInstallation['source'], sourceCameraName?: string): SceneCommit {
  const commit = sceneCameraCommit(scene, draft, bodies, entityId)
  const change = commit.patch[0]!
  const components = change.op === 'add' ? change.entity.components : change.op === 'update' ? change.changes.components! : undefined
  if (!components) throw new Error('CAMERA_INSTALLATION_PATCH_INVALID')
  const camera = components.camera as SceneCameraComponent
  const existing=scene.entities.find(entity=>entity.entityId===entityId),previous = existing?.components.camera as SceneCameraComponent | undefined
  const pose = camera.mount ?? rigidPoseOf({ positionM: draft.position.trim().split(/[\s,]+/).map(Number), quaternionXyzw: draft.quaternion.trim().split(/[\s,]+/).map(Number) })!
  const priorDraft=existing&&previous?cameraDraftOfScene(scene,existing):draft
  const priorPose=rigidPoseOf({positionM:priorDraft.position.trim().split(/[\s,]+/).map(Number),quaternionXyzw:priorDraft.quaternion.trim().split(/[\s,]+/).map(Number)})!
  const priorK=normalizeDraftLens(priorDraft,Number(priorDraft.width),Number(priorDraft.height),Number(priorDraft.fovYDeg))??intrinsicsFromFovy(Number(priorDraft.fovYDeg),Number(priorDraft.width),Number(priorDraft.height))
  camera.installation = previous?.installation ?? { source, ...(sourceCameraName ? { sourceCameraName } : {}), baseline: { positionM: [...priorPose.positionM], quaternionXyzw: [...priorPose.quaternionXyzw], ...(previous?.mount?{mount:structuredClone(previous.mount)}:!previous&&camera.mount?{mount:structuredClone(camera.mount)}:{}), fovYDeg: Number(priorDraft.fovYDeg), width: Number(priorDraft.width), height: Number(priorDraft.height), near: Number(priorDraft.near), far: Number(priorDraft.far), intrinsics: structuredClone(priorK) } }
  if(existing?.parentId&&!camera.mount&&change.op==='update'){
    const parent=scene.entities.find(entity=>entity.entityId===existing.parentId)!,parentWorld=entityMatrix(scene,parent)
    const wanted=new Matrix4().compose(new Vector3(...pose.positionM),new Quaternion(...pose.quaternionXyzw),new Vector3(1,1,1))
    const local=parentWorld.clone().invert().multiply(wanted),p=new Vector3(),q=new Quaternion(),scale=new Vector3()
    local.decompose(p,q,scale);q.normalize()
    const reproduced=parentWorld.clone().multiply(new Matrix4().compose(p,q,scale))
    if(reproduced.elements.some((value,i)=>!Number.isFinite(value)||Math.abs(value-wanted.elements[i]!)>1e-7))throw new Error('CAMERA_PARENT_NONRIGID: 当前父级缩放不能表示该世界机位；请新建世界相机')
    change.changes.transform={position:p.toArray(),quaternion:q.toArray(),scale:scale.toArray()}
  }
  return commit
}
export function restoredCameraDraft(entity: Entity): SceneCameraDraft {
  const camera = entity.components.camera as SceneCameraComponent | undefined, baseline = camera?.installation?.baseline
  if (!baseline || !rigidPoseOf(baseline)) throw new Error('CAMERA_BASELINE_MISSING: 这台相机尚无已保存的安装基线')
  const k = normalizeIntrinsics(baseline.intrinsics)
  return { ...sceneCameraDraftOf(entity), position: baseline.positionM.join(' '), quaternion: baseline.quaternionXyzw.join(' '), parentEntityId: baseline.mount?.entityId ?? '', bodyName: baseline.mount?.bodyName ?? '', intrinsics: k, fovYDeg: String(baseline.fovYDeg), width: String(baseline.width), height: String(baseline.height), near: String(baseline.near), far: String(baseline.far) }
}
