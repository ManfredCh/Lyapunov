/**
 * aligned-mesh-source — mesh-local → Scene/MuJoCo 世界系（z-up 米）矩阵合成。
 *
 * 组合顺序（列向量右乘语义）：
 *
 *   meshWorld = entityWorldTransform × splatSourceTransform × binding.meshToSplat
 *
 * 与 Viewer 的视觉合成严格一致（packages/viewer/src/index.ts loadVisual）：
 * Viewer 把 SplatMesh 包进一个施加了 components.visual.sourceTransform 的
 * wrapper Group，再把 wrapper 挂到按 parentId 嵌套、逐级施加 entity.transform
 * 的实体 Group 链上；binding.meshToSplat 把 GLB mesh 局部系配准到 splat 局部系。
 * 因此对 mesh 局部点 p：world = entityWorld · (splatSource · (meshToSplat · p))。
 * 旧实现（History aligned-mesh-source.ts）是 placement × meshToSplat 的同一思想，
 * 只是那时的 placement 来自 Viewer 放置参数而非 Scene 实体变换链。
 */

import type { Entity, SceneGeometryBinding, SceneSnapshot } from "../../../lyapunov-contracts/src/types.ts"
import { identityMat4, isFiniteMat4, mat4FromTrs, multiplyMat4, type Mat4, type TrsTransform } from "./mat4.ts"

export class AlignedMeshWorldMatrixError extends Error {
  constructor(
    readonly code: "invalid_transform" | "parent_cycle" | "parent_missing" | "unsupported_source",
    message: string,
  ) {
    super(message)
    this.name = "AlignedMeshWorldMatrixError"
  }
}

function finiteTuple(value: readonly number[] | undefined, length: number): value is readonly number[] {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite)
}

function trsMatrix(transform: TrsTransform, label: string): Mat4 {
  if (!finiteTuple(transform.position, 3) || !finiteTuple(transform.quaternion, 4) || !finiteTuple(transform.scale, 3)) {
    throw new AlignedMeshWorldMatrixError("invalid_transform", `${label} must contain finite position/quaternion/scale`)
  }
  const matrix = mat4FromTrs(transform)
  if (!isFiniteMat4(matrix)) throw new AlignedMeshWorldMatrixError("invalid_transform", `${label} produced a non-finite matrix`)
  return matrix
}

/**
 * 实体世界矩阵：从实体沿 parentId 链向上走，逐级左乘父级局部 TRS
 * （Scene Transform：position + quaternion xyzw + scale，见 lyapunov-contracts）。
 * 缺失父级或成环时明确报错（调用方降级为告警并跳过该实体）。
 */
export function entityWorldMatrix(snapshot: SceneSnapshot, entity: Entity): Mat4 {
  const byId = new Map(snapshot.entities.map((item) => [item.entityId, item]))
  let world = trsMatrix(entity.transform, `entity ${entity.entityId} transform`)
  const visited = new Set<string>([entity.entityId])
  let parentId = entity.parentId
  while (parentId !== undefined) {
    if (visited.has(parentId)) {
      throw new AlignedMeshWorldMatrixError("parent_cycle", `entity ${entity.entityId} parent chain contains a cycle at ${parentId}`)
    }
    visited.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) {
      throw new AlignedMeshWorldMatrixError("parent_missing", `entity ${entity.entityId} parent ${parentId} is not in the snapshot`)
    }
    world = multiplyMat4(trsMatrix(parent.transform, `entity ${parentId} transform`), world)
    parentId = parent.parentId
  }
  return world
}

function finiteScale(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * splatSourceTransform 矩阵：与 Viewer loadVisual 的 wrapper 逻辑等价。
 *  - sourceTransformApplied === true：不包 wrapper → 单位阵；
 *  - 有 visual.sourceTransform：按其 TRS（quaternion xyzw）；
 *  - 否则按资源 ref.source 的坐标适配兜底（Y-up 绕 X +90°、X-up 绕 Y −90°、
 *    metersPerUnit 缩放），与 Viewer 的 else 分支一致；左手系明确报错。
 */
export function splatSourceMatrix(entity: Entity): Mat4 {
  const visual = entity.components.visual ?? {}
  if (visual.sourceTransformApplied === true) return identityMat4()
  const sourceTransform = visual.sourceTransform as TrsTransform | undefined
  if (sourceTransform !== undefined) return trsMatrix(sourceTransform, `entity ${entity.entityId} visual.sourceTransform`)
  const ref = entity.resources[0]
  if (!ref) return identityMat4()
  if (ref.source.handedness !== "right") {
    throw new AlignedMeshWorldMatrixError(
      "unsupported_source",
      `entity ${entity.entityId} source is left-handed; a coordinate adapter is required`,
    )
  }
  const scale = finiteScale(ref.source.metersPerUnit) ?? 1
  // rotX(+90°)：quat xyzw (sin45, 0, 0, cos45)；rotY(−90°)：(0, −sin45, 0, cos45)。
  const half = Math.SQRT1_2
  const quaternion: readonly [number, number, number, number] =
    ref.source.upAxis === "Y" ? [half, 0, 0, half] : ref.source.upAxis === "X" ? [0, -half, 0, half] : [0, 0, 0, 1]
  return mat4FromTrs({ position: [0, 0, 0], quaternion, scale: [scale, scale, scale] })
}

/**
 * mesh-local → 世界系：entityWorldTransform × splatSourceTransform × meshToSplat。
 * meshToSplat 是列主序 16 元（绑定合同），entityWorld/splatSource 由上方两个
 * 组合器给出；三者都不含也不引入 Viewer 之外的额外放置。
 */
export function alignedSceneMeshWorldMatrix(input: {
  binding: SceneGeometryBinding
  entityWorld: Mat4
  splatSource: Mat4
}): Mat4 {
  if (!isFiniteMat4(input.entityWorld) || !isFiniteMat4(input.splatSource)) {
    throw new AlignedMeshWorldMatrixError("invalid_transform", "entity world and splat source matrices must be finite")
  }
  if (!isFiniteMat4(input.binding.meshToSplat as unknown as number[])) {
    throw new AlignedMeshWorldMatrixError("invalid_transform", "binding.meshToSplat must contain 16 finite values")
  }
  return multiplyMat4(multiplyMat4(input.entityWorld, input.splatSource), [...input.binding.meshToSplat] as Mat4)
}
