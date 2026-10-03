import { Matrix4, Quaternion, Vector3 } from "three"
import type { Entity, Frame, SceneCameraComponent, SceneSnapshot, WorldHandle } from "../../lyapunov-contracts/src/types.ts"
import { frustumFromReceipt, rigidPoseOf, type FrustumSpec, type RigidPose } from "./camera-frustum.ts"
import { namedCamerasOfScene } from "./camera-view.ts"

/** Scene 声明与当前原生 Frame 的单次投影；不持久化相机或原生 body 的副本。 */
export function currentCameraFrame(scene: SceneSnapshot | undefined, world: WorldHandle | undefined, frame: Frame | undefined): Frame | undefined {
  return scene && world && frame && ["ready", "running", "paused"].includes(world.status)
    && world.sceneId === scene.sceneId && world.appliedSceneRevision === scene.revision
    && frame.worldId === world.worldId && frame.generation === world.worldGeneration && frame.sceneRevision === scene.revision ? frame : undefined
}
function matrixPose(matrix: Matrix4): RigidPose | undefined {
  if (matrix.elements.some(value => !Number.isFinite(value)) || matrix.determinant() <= 0) return undefined
  const position = new Vector3(), quaternion = new Quaternion(), scale = new Vector3()
  matrix.decompose(position, quaternion, scale)
  return rigidPoseOf({ positionM: position.toArray(), quaternionXyzw: quaternion.toArray() })
}
function sceneWorldPose(entity: Entity, entities: readonly Entity[]): RigidPose | undefined {
  const visited = new Set<string>()
  const matrixOf = (row: Entity): Matrix4 | undefined => {
    if (visited.has(row.entityId)) return undefined
    visited.add(row.entityId)
    const pose = rigidPoseOf({ positionM: row.transform.position, quaternionXyzw: row.transform.quaternion })
    if (!pose || row.transform.scale.some(value => !Number.isFinite(value) || value === 0)) return undefined
    const local = new Matrix4().compose(new Vector3(...pose.positionM), new Quaternion(...pose.quaternionXyzw), new Vector3(...row.transform.scale))
    if (!row.parentId) return local
    const parent = entities.find(value => value.entityId === row.parentId), parentMatrix = parent && matrixOf(parent)
    return parentMatrix ? parentMatrix.multiply(local) : undefined
  }
  const matrix = matrixOf(entity)
  return matrix ? matrixPose(matrix) : undefined
}
function mountedPose(camera: SceneCameraComponent, frame: Frame | undefined): RigidPose | undefined {
  const mount = camera.mount
  if (!mount || !frame) return undefined
  const observation = frame.entities.find(entity => entity.entityId === mount.entityId)
  const poses = observation?.sensors?.bodyWorldPoses as Record<string, unknown> | undefined
  const body = rigidPoseOf(poses?.[mount.bodyName]), local = rigidPoseOf(mount)
  if (!body || !local) return undefined
  const matrix = (pose: RigidPose) => new Matrix4().compose(new Vector3(...pose.positionM), new Quaternion(...pose.quaternionXyzw), new Vector3(1, 1, 1))
  return matrixPose(matrix(body).multiply(matrix(local)))
}

/** 原生相机优先；缺世界时，固定相机/命名机位仍按 Scene 里的实际世界位姿显示。 */
export function projectSceneCameraRigs(scene: SceneSnapshot | undefined, world?: WorldHandle, frame?: Frame, listed: readonly FrustumSpec[] = [], unavailableCameraNames: readonly string[] = []): FrustumSpec[] {
  if (!scene) return []
  const measured = currentCameraFrame(scene, world, frame), nativeRows = measured?.cameras
  const native = nativeRows ? nativeRows.flatMap(row => {
    if (row.available === false || row.frameId !== measured!.frameId || row.stepIndex !== measured!.stepIndex || row.generation !== measured!.generation || row.sceneRevision !== measured!.sceneRevision) return []
    const result = frustumFromReceipt(row)
    return result.ok ? [result.spec] : []
  }) : listed.filter(spec => spec.source === "engine" && world?.sceneId === scene.sceneId && world.appliedSceneRevision === scene.revision && ["ready", "running", "paused"].includes(world.status)
    && spec.measured?.generation === world.worldGeneration && spec.measured?.sceneRevision === scene.revision)
  const rigs = new Map(native.map(spec => [spec.key, spec])), refused = new Set([...unavailableCameraNames, ...(nativeRows?.filter(row => row.available === false).map(row => row.cameraName) ?? [])])
  const add = (row: Record<string, unknown>, source: "scene" | "named-view") => {
    const key = row.cameraName as string
    if (rigs.has(key) || refused.has(key)) return
    const result = frustumFromReceipt(row, { source })
    if (result.ok) rigs.set(key, { ...result.spec, notes: [...result.spec.notes, source === "scene" ? "位姿和镜头来自当前 Scene 声明。" : "机位来自当前 Scene 的已保存视角；显示尺寸不代表原生采集标定。"] })
  }
  for (const entity of scene.entities) {
    const camera = entity.components.camera as SceneCameraComponent | undefined
    if (!camera || typeof camera !== "object") continue
    const pose = camera.mount ? mountedPose(camera, measured) : sceneWorldPose(entity, scene.entities)
    // 显式 mount 缺真实 body 时不拿实体 TRS 代替，不制造世界固定相机。
    if (!pose) continue
    add({ cameraName: `${entity.entityId}/${camera.name ?? entity.name}`, entityId: entity.entityId, worldFromCamera: pose,
      intrinsics: camera.intrinsics, fovyDeg: camera.fovYDeg, width: camera.width, height: camera.height, nearM: camera.near, farM: camera.far,
      intrinsicsSource: "scene-declared", ...camera.mount ? { parentEntityId: camera.mount.entityId, parentBodyName: camera.mount.bodyName,
        parentFromCamera: rigidPoseOf(camera.mount), referenceFrame: "parent", frameId: measured!.frameId, stepIndex: measured!.stepIndex,
        generation: measured!.generation, sceneRevision: measured!.sceneRevision, simTime: measured!.simTime } : {} }, "scene")
  }
  const named = namedCamerasOfScene(scene.entities)
  for (const camera of named.cameras) add({ cameraName: `${named.carrier}/${camera.name}`, entityId: named.carrier,
    worldFromCamera: { positionM: camera.state.position, quaternionXyzw: camera.state.quaternion }, intrinsics: camera.state.intrinsics,
    fovyDeg: camera.state.fovDeg, nearM: camera.state.near, farM: camera.state.far,
    intrinsicsSource: camera.state.intrinsics ? "saved-view-intrinsics" : "saved-view-fov-display-size" }, "named-view")
  return [...rigs.values()]
}
