import type { Entity, SceneCommit } from "../../lyapunov-contracts/src/types.ts"

export type NativeKind = "flex" | "cable" | "deformable" | "pbd" | "mpm"
export interface NativePhysicsEditTarget {
  engine: "mujoco" | "isaac" | "newton"; kind: NativeKind; nativeName: string; dimensions?: number[]
}
export interface NativePhysicsUpdate extends NativePhysicsEditTarget { parameters: Record<string, number> }
export const flexKeys = ["youngPa", "poisson", "rayleighDamping"] as const
export const cableKeys = ["bendPa", "twistPa"] as const
export const mpmKeys = ["densityKgM3", "viscosityPaS", "youngModulusPa", "poissonRatio", "spacingM", "voxelSizeM"] as const
// 输入名仅映射当前 worker 已消费的原生 schema 属性。
export const isaacKeys: Record<string, string> = {
  youngsModulusPa: "omniphysics:youngsModulus", poissonsRatio: "omniphysics:poissonsRatio",
  densityKgM3: "omniphysics:density", dynamicFriction: "omniphysics:dynamicFriction",
}
export const pbdKeys: Record<string, string> = {
  densityKgM3: "physxPBDMaterial:density", viscosity: "physxPBDMaterial:viscosity",
  surfaceTension: "physxPBDMaterial:surfaceTension", cohesion: "physxPBDMaterial:cohesion", friction: "physxPBDMaterial:friction",
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** UI 和原 Scene 操作共用的纯编译：保全完整组件，只写当前支持的原生参数。应用由 sim_sync/robot_state 验证。 */
export function nativePhysicsCommit(sceneId: string, expectedRevision: number, entity: Entity, target: NativePhysicsEditTarget, parameters: Record<string, number>, dimensions = target.dimensions) {
  const correctEngine = target.kind === "flex" || target.kind === "cable" ? "mujoco" : target.kind === "mpm" ? "newton" : target.kind === "deformable" || target.kind === "pbd" ? "isaac" : undefined
  if (!correctEngine || target.engine !== correctEngine || typeof target.nativeName !== "string" || !target.nativeName.trim()) throw new Error("NATIVE_PARAMETER_INVALID: target")
  const source = entity.components[target.engine]
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("NATIVE_COMPONENT_REQUIRED")
  if (target.kind === "mpm" && (target.nativeName !== "water" || record(record(source).mpm).kind !== "water")) throw new Error("NATIVE_PARAMETER_INVALID: water")
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters) || !Object.keys(parameters).length && dimensions === undefined) throw new Error("NATIVE_PARAMETER_INVALID: parameters")
  if (dimensions !== undefined && (target.kind !== "mpm" || !Array.isArray(dimensions) || dimensions.length !== 3 || dimensions.some(value => !Number.isInteger(value) || value <= 0))) throw new Error("NATIVE_PARAMETER_INVALID: dimensions")
  const allowed = target.kind === "flex" ? flexKeys : target.kind === "cable" ? cableKeys : target.kind === "mpm" ? mpmKeys : Object.keys(target.kind === "pbd" ? pbdKeys : isaacKeys)
  for (const [key, value] of Object.entries(parameters)) {
    if (!(allowed as readonly string[]).includes(key) || !Number.isFinite(value)) throw new Error(`NATIVE_PARAMETER_INVALID: ${key}`)
    if ((key === "poisson" || key === "poissonsRatio" || key === "poissonRatio") ? value <= -1 || value >= 0.5 : value < 0 || ((key.endsWith("Pa") || key.endsWith("KgM3") || key.endsWith("M")) && value === 0)) throw new Error(`NATIVE_PARAMETER_INVALID: ${key}`)
  }
  const components = structuredClone(entity.components), component = record(components[target.engine])
  if (target.kind === "mpm") {
    component.mpm = { ...record(component.mpm), ...parameters, ...(dimensions ? { dimensions: [...dimensions] } : {}) }
  } else {
    const container = target.kind === "flex" ? "flexMaterials" : target.kind === "cable" ? "cableMaterials" : "materialOverrides"
    const configured = record(component[container])
    component[container] = { ...configured, [target.nativeName]: { ...record(configured[target.nativeName]), ...parameters } }
  }
  components[target.engine] = component
  return { sceneId, expectedRevision, patch: [{ op: "update" as const, entityId: entity.entityId, changes: { components } }] } satisfies SceneCommit
}
