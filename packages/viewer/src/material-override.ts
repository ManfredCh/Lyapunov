/** 视觉材质覆盖随普通 Scene 组件保存；这里只拥有当前实体的材质克隆，纹理/几何仍归资源缓存。 */
import * as THREE from "three"

export const MATERIAL_OVERRIDE_KEY = "materialOverride"
export const MATERIAL_OVERRIDE_KIND = "visual/material-override"
export interface MaterialOverride {
  kind: typeof MATERIAL_OVERRIDE_KIND
  baseColor?: string
  roughness?: number
  metalness?: number
  emissive?: string
  emissiveIntensity?: number
  opacity?: number
  textures?: boolean
  /** 乘在原始法线比例上，1 恢复原始强度；没有法线贴图时不产生效果。 */
  normalScale?: number
}
export type MaterialOverridePatch = Partial<Omit<MaterialOverride, "kind">>
export function parseMaterialOverride(raw: unknown): { component?: MaterialOverride; warnings: string[] } {
  const warnings: string[] = []
  if (raw === undefined) return { warnings }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || (raw as MaterialOverride).kind !== MATERIAL_OVERRIDE_KIND) return { warnings: ["MATERIAL_OVERRIDE_INVALID: kind must be visual/material-override"] }
  const value = raw as Record<string, unknown>, component: MaterialOverride = { kind: MATERIAL_OVERRIDE_KIND }
  for (const key of ["baseColor", "emissive"] as const) if (value[key] !== undefined) {
    if (typeof value[key] === "string" && /^#[0-9a-f]{6}$/i.test(value[key])) component[key] = value[key].toLowerCase()
    else warnings.push(`MATERIAL_OVERRIDE_INVALID: ${key} must be #rrggbb; ignored`)
  }
  for (const [key, max] of [["roughness", 1], ["metalness", 1], ["opacity", 1], ["emissiveIntensity", 32], ["normalScale", 8]] as const) if (value[key] !== undefined) {
    const n = value[key]
    if (typeof n !== "number" || !Number.isFinite(n)) warnings.push(`MATERIAL_OVERRIDE_INVALID: ${key} must be a finite number; ignored`)
    else { component[key] = Math.max(0, Math.min(max, n)); if (component[key] !== n) warnings.push(`MATERIAL_OVERRIDE_CLAMPED: ${key} clamped to [0, ${max}]`) }
  }
  if (typeof value.textures === "boolean") component.textures = value.textures
  else if (value.textures !== undefined) warnings.push("MATERIAL_OVERRIDE_INVALID: textures must be boolean; ignored")
  return { component, warnings }
}
export function composeMaterialOverride(current: unknown, patch: MaterialOverridePatch): { component: MaterialOverride; warnings: string[] } {
  const parsed = parseMaterialOverride({ ...parseMaterialOverride(current).component, ...patch, kind: MATERIAL_OVERRIDE_KIND })
  return { component: parsed.component!, warnings: parsed.warnings }
}

export interface MaterialReading {
  name: string; baseColor: string; roughness: number; metalness: number; emissive: string; emissiveIntensity: number; opacity: number
  hasTextures: boolean; texturesEnabled: boolean; hasNormalMap: boolean; normalScale: [number, number]
}
export interface MaterialStatus {
  entityId: string; loaded: boolean; declared: boolean; component?: MaterialOverride; warnings: string[]
  supported: number; unsupported: number; materials: MaterialReading[]
}
const pbr = (material: THREE.Material): material is THREE.MeshStandardMaterial => (material as THREE.MeshStandardMaterial).isMeshStandardMaterial === true
const surfaceMaps = (material: THREE.Material): string[] => Object.entries(material).filter(([key, value]) => value instanceof THREE.Texture && (key === "map" || key.endsWith("Map") && key !== "envMap")).map(([key]) => key)
const materialList = (material: THREE.Material | THREE.Material[]) => Array.isArray(material) ? material : [material]

/** 一个实体一份。只遍历其 visual/LOD 子树，不越过其它 Scene 实体，也不覆盖点云/线框材质。 */
export class EntityMaterialOverride {
  private sources = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
  private clones = new Set<THREE.Material>()
  private roots: THREE.Object3D[] = []
  private signature = ""

  apply(roots: THREE.Object3D[], component?: MaterialOverride): void {
    roots = [...new Set(roots)]
    const signature = JSON.stringify(component)
    if (signature === this.signature && roots.length === this.roots.length && roots.every((root, i) => root === this.roots[i])) return
    this.reset()
    this.roots = roots; this.signature = signature
    if (!component || Object.keys(component).length === 1) return
    const copies = new Map<THREE.Material, THREE.Material>()
    for (const root of roots) root.traverse(child => {
      if (!(child instanceof THREE.Mesh)) return
      const source = child.material
      if (!materialList(source).some(pbr)) return
      this.sources.set(child, source)
      const copied = materialList(source).map(material => {
        if (!pbr(material)) return material
        const found = copies.get(material)
        if (found) return found
        const clone = material.clone()
        if (component.baseColor !== undefined) clone.color.set(component.baseColor)
        if (component.roughness !== undefined) clone.roughness = component.roughness
        if (component.metalness !== undefined) clone.metalness = component.metalness
        if (component.emissive !== undefined) clone.emissive.set(component.emissive)
        if (component.emissiveIntensity !== undefined) clone.emissiveIntensity = component.emissiveIntensity
        if (component.opacity !== undefined) {
          clone.opacity = component.opacity
          clone.transparent = component.opacity < 1 || material.transparent
          if (component.opacity < 1) clone.depthWrite = false
        }
        if (material.normalMap && component.normalScale !== undefined) clone.normalScale.copy(material.normalScale).multiplyScalar(component.normalScale)
        if (component.textures === false) for (const key of surfaceMaps(clone)) (clone as unknown as Record<string, unknown>)[key] = null
        clone.needsUpdate = true
        copies.set(material, clone); this.clones.add(clone)
        return clone
      })
      child.material = Array.isArray(source) ? copied : copied[0]!
    })
  }

  readings(roots: THREE.Object3D[]): Pick<MaterialStatus, "supported" | "unsupported" | "materials"> {
    const supported = new Set<THREE.Material>(), unsupported = new Set<THREE.Material>(), materials: MaterialReading[] = []
    for (const root of roots) root.traverse(child => {
      if (!(child instanceof THREE.Mesh)) return
      const source = materialList(this.sources.get(child) ?? child.material)
      materialList(child.material).forEach((material, index) => {
        if (!pbr(material)) { unsupported.add(material); return }
        if (supported.has(material)) return
        supported.add(material)
        const original = source[index] as THREE.MeshStandardMaterial
        materials.push({ name: material.name, baseColor: `#${material.color.getHexString(THREE.SRGBColorSpace)}`, roughness: material.roughness, metalness: material.metalness,
          emissive: `#${material.emissive.getHexString(THREE.SRGBColorSpace)}`, emissiveIntensity: material.emissiveIntensity, opacity: material.opacity,
          hasTextures: surfaceMaps(original).length > 0, texturesEnabled: surfaceMaps(material).length > 0, hasNormalMap: Boolean(original.normalMap), normalScale: material.normalScale.toArray() as [number, number] })
      })
    })
    return { supported: supported.size, unsupported: unsupported.size, materials }
  }

  /** 材质 dispose 不释放纹理；先恢复源引用，再交还原实体/GLTF 缓存的释放链。 */
  reset(): void {
    for (const [mesh, source] of this.sources) mesh.material = source
    for (const material of this.clones) material.dispose()
    this.sources.clear(); this.clones.clear(); this.roots = []; this.signature = ""
  }
}
