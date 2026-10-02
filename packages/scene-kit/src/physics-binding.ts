import { Matrix4, Vector3, Quaternion } from "three"
import { isDeepStrictEqual } from "node:util"
import type { Entity, SceneSnapshot, Transform, ScenePatch } from "../../lyapunov-contracts/src/types.ts"
import { identityTransform } from "../../lyapunov-contracts/src/types.ts"
import type { ResourceRecord } from "./resources.ts"
import { glbEntities } from "./formats.ts"
import {physicalizationBudgets,type PhysicalizationBudgetOptions} from './physicalization-parameters.ts'
import {publicPhysicalizationFacts} from './physicalization-progress.ts'

export interface PhysicsBindInput extends PhysicalizationBudgetOptions {
  sceneId: string; entityId: string; expectedRevision: number
  /** 显式实例运动类型；不给时保用户既有配置，用途不能冒充固定授权。 */
  type?: 'static'|'dynamic'
  usage?: "dynamic" | "static" | "environment"
  strategy?: "auto" | "convex_hull" | "voxel_boxes" | "coacd" | "triangle_mesh" | "sdf"
  massKg?: number
}
export function validatePhysicsBindingType(input:Pick<PhysicsBindInput,'type'>):void {
 if(input.type!==undefined&&!['static','dynamic'].includes(input.type))throw Error('PHYSICS_BODY_TYPE_INVALID')
}
const key = (r: { resourceId: string; version: number }) => r.resourceId + "@" + r.version
const epsilon = 1e-8

export function entityWorldMatrix(entity: Entity, byId: Map<string, Entity>, visited = new Set<string>()): Matrix4 {
  if (visited.has(entity.entityId)) throw new Error("PHYSICS_BIND_INSTANCE_LAYOUT_UNSUPPORTED: 父链循环")
  visited.add(entity.entityId)
  const t = entity.transform
  const local = new Matrix4().compose(new Vector3(...t.position), new Quaternion(...t.quaternion), new Vector3(...t.scale))
  if (!entity.parentId) return local
  const parent = byId.get(entity.parentId)
  if (!parent) throw new Error("SCENE_PARENT_REQUIRED")
  return entityWorldMatrix(parent, byId, visited).multiply(local)
}
const delta = (a: Matrix4, b: Matrix4) => Math.max(...a.elements.map((v, i) => Math.abs(v - b.elements[i]!)))
function transform(matrix: Matrix4): Transform {
  const p = new Vector3(), q = new Quaternion(), s = new Vector3()
  matrix.decompose(p, q, s)
  if ([...p.toArray(), ...q.toArray(), ...s.toArray()].some(v => !Number.isFinite(v)) || s.toArray().some(v => v <= 0) || delta(new Matrix4().compose(p, q, s), matrix) > epsilon) {
    throw new Error("PHYSICS_BIND_TRANSFORM_UNSUPPORTED: 剪切/镜像变换不能伪装刚体")
  }
  return { position: p.toArray(), quaternion: q.toArray(), scale: s.toArray() }
}

/** 标记真实派生基线，供换几何时区分实例物理开关与自定义碰撞；不是另一个状态 owner。 */
export function physicsBindingFacts(record: ResourceRecord) {
  return {
    resourceId: record.ref.resourceId, version: record.ref.version, status: "BOUND",
    ...physicalizationBudgets(record.physicalization),
    ...record.physicalization?.geometryTransport?.verified===true&&record.physicalization.geometryTransport.sourceFrame?{sourceFrame:structuredClone(record.physicalization.geometryTransport.sourceFrame)}:{},
    ...record.physicalization?.geometryTransport?.verified===true&&record.physicalization.pointCloud?.length?{pointCloud:record.physicalization.pointCloud.map(facts=>publicPhysicalizationFacts(facts))}:{},
    ...(record.physicalization?.policy ? { policy: record.physicalization.policy } : {}),
    ...(record.physicalization?.usage ? { usage: record.physicalization.usage } : {}),
    ...(record.physicalization?.strategy ? { strategy: record.physicalization.strategy } : {}),
    ...(record.physicalization?.voxelSizeM !== undefined ? { voxelSizeM: record.physicalization.voxelSizeM } : {}),
    derivedComponents: structuredClone(record.componentDefaults ?? {}),
  }
}

/** 完整 GLB 实例按真实原件布局绑定；多个网格必须共享同一个可表达根变换。 */
export function planPhysicsBinding(scene: SceneSnapshot, record: ResourceRecord, input: PhysicsBindInput): {
  patch: ScenePatch; rootEntityId: string; normalized: boolean; maxMatrixDelta: number
} {
  if (scene.sceneId !== input.sceneId) throw new Error("SCENE_MISMATCH")
  if (scene.revision !== input.expectedRevision) throw new Error("SCENE_REVISION_MISMATCH: 先读取当前场景版本")
  validatePhysicsBindingType(input)
  if (!["mesh", "splat"].includes(record.parsed.kind) || record.physicalization?.status !== "ok" || !record.componentDefaults?.collision) throw new Error("PHYSICS_DERIVATION_REQUIRED: 仅绑定同版本真实派生，不生成默认盒")
  const byId = new Map(scene.entities.map(e => [e.entityId, e])), selected = byId.get(input.entityId)
  if (!selected) throw new Error("SCENE_ENTITY_REQUIRED")
  let root = selected, current = selected
  const ancestors = new Set<string>()
  while (current.parentId) {
    if (ancestors.has(current.entityId)) throw new Error("PHYSICS_BIND_INSTANCE_LAYOUT_UNSUPPORTED")
    ancestors.add(current.entityId)
    const parent = byId.get(current.parentId)
    if (!parent) throw new Error("SCENE_PARENT_REQUIRED")
    current = parent
    if (current.components.visual?.kind === "group" && current.resources.some(r => key(r) === key(record.ref))) root = current
  }
  const descendants = new Set([root.entityId])
  for (let changed = true; changed;) {
    changed = false
    for (const e of scene.entities) if (e.parentId && descendants.has(e.parentId) && !descendants.has(e.entityId)) { descendants.add(e.entityId); changed = true }
  }
  const group = scene.entities.filter(e => descendants.has(e.entityId))
  if (group.some(e => e.components.collision || (e!==root&&e.components.rigidBody) || e.components.mujoco || e.components.isaac || e.components.articulation || e.components.newton)) throw new Error("PHYSICS_BIND_CUSTOMIZED: 此实例已声明碰撞/多刚体配置，不覆盖用户 collision 或本体")
  if (!root.resources.some(r => key(r) === key(record.ref)) || group.some(e => e.resources.some(r => key(r) !== key(record.ref)))) throw new Error("PHYSICS_BIND_RESOURCE_MISMATCH: 只能绑定同版本完整实例")
  const patch: ScenePatch = [], defaults = structuredClone(record.componentDefaults)
  const components: Entity["components"] = { ...root.components, collision: defaults.collision, ...(defaults.rigidBody ? { rigidBody: defaults.rigidBody } : {}), physicsBinding: physicsBindingFacts(record) }
  if(root.components.rigidBody){
    const explicit=structuredClone(root.components.rigidBody)
    components.rigidBody={...components.rigidBody,...explicit}
    if(explicit.massKg!==undefined&&explicit.massScalePolicy===undefined)Object.assign(components.rigidBody,{massSource:"declared",massScalePolicy:"constant"})
  }
  if(record.parsed.kind==="splat"&&input.type!=='static'&&(input.usage??record.physicalization.usage)==="dynamic"&&input.massKg===undefined&&root.components.rigidBody?.massKg===undefined&&!record.explicitComponentDefaultKeys?.includes("rigidBody"))throw new Error("PHYSICS_DYNAMIC_MASS_REQUIRED: 点云采样占据体素没有可信实体质量，请显式给massKg")
  if (input.massKg !== undefined) {
    if (!Number.isFinite(input.massKg) || input.massKg <= 0) throw new Error("PHYSICS_MASS_INVALID")
    if ((input.usage ?? record.physicalization.usage ?? "dynamic") !== "dynamic") throw new Error("PHYSICS_MASS_REQUIRES_DYNAMIC")
    components.rigidBody = { ...components.rigidBody, type: "dynamic", massKg: input.massKg, massSource: "declared", massScalePolicy: "constant" }
  }
  if(input.type!==undefined)components.rigidBody={...components.rigidBody,type:input.type}
  if((components.rigidBody?.type==="dynamic"||!components.rigidBody&&(input.usage??record.physicalization.usage??"dynamic")==="dynamic")&&!(typeof components.rigidBody?.massKg==="number"&&Number.isFinite(components.rigidBody.massKg)&&components.rigidBody.massKg>0))throw new Error("PHYSICS_DYNAMIC_MASS_REQUIRED: 动态绑定缺可靠质量，请显式给massKg")
  let normalized = false, maxMatrixDelta = 0, rootTransform = root.transform
  if (root.components.visual?.kind === "group") {
    const fresh = glbEntities(record.ref, record.parsed, root.entityId, root.name, identityTransform())
    const freshById = new Map(fresh.map(e => [e.entityId, e]))
    if (fresh.length !== group.length || group.some(e => !freshById.has(e.entityId) || (e !== root && e.parentId !== freshById.get(e.entityId)!.parentId) || e.components.visual?.gltfNode !== freshById.get(e.entityId)!.components.visual?.gltfNode)) throw new Error("PHYSICS_BIND_INSTANCE_LAYOUT_UNSUPPORTED: 节点集合或父子关系已变化，不能套整资源碰撞")
    const nodes = record.parsed.metadata.nodes as Array<{ mesh?: number }> | undefined
    const meshes = group.filter(e => typeof e.components.visual?.gltfNode === "number" && typeof nodes?.[e.components.visual.gltfNode]?.mesh === "number")
    if (!meshes.length) throw new Error("PHYSICS_BIND_INSTANCE_LAYOUT_UNSUPPORTED: 原件没有可绑定网格")
    const world = entityWorldMatrix(meshes[0]!, byId), sourceWorld = entityWorldMatrix(freshById.get(meshes[0]!.entityId)!, freshById)
    const newRootWorld = world.clone().multiply(sourceWorld.clone().invert())
    for (const mesh of meshes) {
      const actual = entityWorldMatrix(mesh, byId), original = entityWorldMatrix(freshById.get(mesh.entityId)!, freshById)
      maxMatrixDelta = Math.max(maxMatrixDelta, delta(newRootWorld.clone().multiply(original), actual))
    }
    if (maxMatrixDelta > epsilon) throw new Error("PHYSICS_BIND_INSTANCE_LAYOUT_UNSUPPORTED: 多网格相对布局已编辑，各网格不共享同一根变换；请恢复布局或按实际节点派生")
    const parentWorld = root.parentId ? entityWorldMatrix(byId.get(root.parentId)!, byId) : new Matrix4()
    rootTransform = transform(parentWorld.clone().invert().multiply(newRootWorld))
    for (const child of group) if (child !== root) {
      const original = freshById.get(child.entityId)!
      if (!isDeepStrictEqual(child.transform, original.transform)) {
        patch.push({ op: "update", entityId: child.entityId, changes: { transform: structuredClone(original.transform) } })
        normalized = true
      }
    }
    normalized ||= !isDeepStrictEqual(rootTransform, root.transform)
  } else if (group.length !== 1 || typeof root.components.visual?.gltfNode === "number") {
    throw new Error("PHYSICS_BIND_INSTANCE_LAYOUT_UNSUPPORTED")
  }
  patch.unshift({ op: "update", entityId: root.entityId, changes: { transform: rootTransform, components, resources: root.resources.map(r => key(r) === key(record.ref) ? structuredClone(record.ref) : r) } })
  return { patch, rootEntityId: root.entityId, normalized, maxMatrixDelta }
}
