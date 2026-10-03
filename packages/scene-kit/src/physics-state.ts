import { isDeepStrictEqual } from "node:util"
import type { Entity, SceneSnapshot, ScenePatch } from "../../lyapunov-contracts/src/types.ts"

export interface PhysicsUpdateInput {
  sceneId: string; entityId: string; expectedRevision: number
  type?: "static" | "dynamic"; massKg?: number; gravityEnabled?: boolean; collisionEnabled?: boolean
}
/** 选中 glTF 叶时操作其真实物理祖先；未声明物理的实体不猜默认刚体。 */
export function physicsOwner(scene: SceneSnapshot, entityId: string): Entity {
  const byId = new Map(scene.entities.map(e => [e.entityId, e]))
  let entity = byId.get(entityId)
  const visited = new Set<string>()
  while (entity) {
    if (visited.has(entity.entityId)) throw new Error("SCENE_PARENT_CYCLE")
    visited.add(entity.entityId)
    if (entity.components.collision || entity.components.rigidBody || entity.components.articulation || entity.components.mujoco || entity.components.isaac || entity.components.newton) return entity
    entity = entity.parentId ? byId.get(entity.parentId) : undefined
  }
  throw new Error("PHYSICS_COLLISION_REQUIRED: 先绑定所选完整实例的真实碰撞")
}
export function planPhysicsUpdate(scene: SceneSnapshot, input: PhysicsUpdateInput, defaultRigidBody?: Record<string, unknown>): { patch: ScenePatch; entity: Entity; changed: boolean } {
  if (scene.sceneId !== input.sceneId) throw new Error("SCENE_MISMATCH")
  if (scene.revision !== input.expectedRevision) throw new Error("SCENE_REVISION_MISMATCH")
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("INVALID_REVISION")
  if (input.type !== undefined && !["static", "dynamic"].includes(input.type)) throw new Error("PHYSICS_BODY_TYPE_INVALID")
  for (const value of [input.gravityEnabled, input.collisionEnabled]) if (value !== undefined && typeof value !== "boolean") throw new Error("PHYSICS_BOOLEAN_REQUIRED")
  if (input.massKg !== undefined && (!Number.isFinite(input.massKg) || input.massKg <= 0)) throw new Error("PHYSICS_MASS_INVALID")
  const owner = physicsOwner(scene, input.entityId)
  const byId=new Map(scene.entities.map(e=>[e.entityId,e]))
  for(let ancestor:Entity|undefined=owner;ancestor;ancestor=ancestor.parentId?byId.get(ancestor.parentId):undefined){
    if(ancestor.components.articulation||ancestor.components.mujoco||ancestor.components.isaac||ancestor.components.newton)throw new Error("PHYSICS_NATIVE_BODY_REQUIRED: 原生机器人固定/动力学由原生模型接口处理，不能覆盖本体或连杆")
  }
  if (!owner.components.collision) throw new Error("PHYSICS_COLLISION_REQUIRED")
  const entity = structuredClone(owner), rigid = { ...(entity.components.rigidBody ?? {}) }
  if (input.type !== undefined) rigid.type = input.type
  if (input.massKg !== undefined) Object.assign(rigid, { massKg: input.massKg, massSource: "declared", massScalePolicy: "constant" })
  if (input.gravityEnabled !== undefined) rigid.gravityEnabled = input.gravityEnabled
  if (rigid.type === "dynamic") {
    if (!(typeof rigid.massKg === "number" && Number.isFinite(rigid.massKg) && rigid.massKg > 0)) {
      if (!(typeof defaultRigidBody?.massKg === "number" && Number.isFinite(defaultRigidBody.massKg) && defaultRigidBody.massKg > 0)) throw new Error("PHYSICS_DYNAMIC_MASS_REQUIRED: 缺可靠质量，请显式给出 massKg；不创建默认轻质物体")
      for (const key of ["massKg", "massSource", "massScalePolicy"]) if (defaultRigidBody[key] !== undefined) rigid[key] = structuredClone(defaultRigidBody[key])
    }
  }
  if (Object.keys(rigid).length) entity.components.rigidBody = rigid
  if (input.collisionEnabled !== undefined) entity.components.collision = { ...entity.components.collision, enabled: input.collisionEnabled }
  const changed = !isDeepStrictEqual(entity.components, owner.components)
  return { patch: changed ? [{ op: "update", entityId: owner.entityId, changes: { components: entity.components } }] : [], entity, changed }
}

/** 替换时只允许已实现的实例物理控制值分歧；尺寸/摩擦/拓扑等自定义仍由原闸拒绝。 */
export function sameDerivedPhysics(name: string, actual: unknown, baseline: unknown): boolean {
  if (!actual || !baseline || typeof actual !== "object" || typeof baseline !== "object") return isDeepStrictEqual(actual, baseline)
  const left = structuredClone(actual) as Record<string, unknown>, right = structuredClone(baseline) as Record<string, unknown>
  const controls = name === "collision" ? ["enabled"] : name === "rigidBody" ? ["type", "massKg", "massSource", "massScalePolicy", "gravityEnabled"] : []
  for (const key of controls) { delete left[key]; delete right[key] }
  return isDeepStrictEqual(left, right)
}
export function preservePhysicsControls(name: string, derived: Record<string, unknown>, actual: Record<string, unknown>, baseline?: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(derived)
  if (name === "collision" && actual.enabled !== undefined) next.enabled = actual.enabled
  if (name === "rigidBody") {
    for (const key of ["type", "gravityEnabled"]) if (actual[key] !== undefined) next[key] = actual[key]
    // 显式质量保持；密度派生质量在换几何时用目标几何实测值，缩放交引擎按体积行列式应用。
    if (actual.massScalePolicy === "constant" || actual.massSource === "declared" || (actual.massScalePolicy !== "density" && actual.massKg !== baseline?.massKg)) {
      for (const key of ["massKg", "massSource", "massScalePolicy"]) if (actual[key] !== undefined) next[key] = actual[key]
    }
    if (next.type === "dynamic" && !(typeof next.massKg === "number" && Number.isFinite(next.massKg) && next.massKg > 0)) throw new Error("PHYSICS_DYNAMIC_MASS_REQUIRED: 目标几何没有可靠动态质量，请先显式设质量")
  }
  return next
}
