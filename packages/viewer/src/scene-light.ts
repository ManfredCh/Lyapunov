import * as THREE from "three"
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js"

export interface SceneLight {
  kind?: string; color?: number[]; energy?: number; direction?: number[]
  sizeM?: number; widthM?: number; heightM?: number; sizeYM?: number; shape?: string; angleRad?: number; spotSizeRad?: number
}
let areaReady = false
const positive = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback

/** 原 point/spot/sun 换算保持；area 使用 Three 原生矩形面光源，energy 为 Three power，尺寸单位为米。 */
export function buildSceneLight(light: SceneLight): THREE.Light {
  const rgb = Array.isArray(light.color) && light.color.length >= 3 ? light.color.slice(0, 3) : [1, 1, 1]
  const energy = typeof light.energy === "number" && Number.isFinite(light.energy) ? light.energy : 1
  const kind = (light.kind ?? "point").toLowerCase()
  const built: THREE.Light = (() => {
    if (kind === "sun") {
      const value = new THREE.DirectionalLight(0xffffff, Math.min(6, Math.max(0, energy)))
      const d = light.direction ?? [0, 0, -1]
      value.position.set(-d[0]!, -d[1]!, -d[2]!)
      return value
    }
    if (kind === "area") {
      if (!areaReady) { RectAreaLightUniformsLib.init(); areaReady = true }
      const width = positive(light.widthM, positive(light.sizeM, 1)), height = positive(light.heightM, positive(light.sizeYM, width))
      const value = new THREE.RectAreaLight(0xffffff, 1, width, height)
      value.power = Math.max(0, energy)
      // direction 与 Blender 接收格式一致，为世界方向；父链挂好后再换算局部旋转。
      return value
    }
    if (kind === "spot") {
      const value = new THREE.SpotLight(0xffffff, Math.min(40, Math.max(0, energy / 25)), 0, typeof light.spotSizeRad === "number" ? light.spotSizeRad : Math.PI / 6, 0.3)
      const d = light.direction ?? [0, 0, -1]
      value.target.position.set(d[0]!, d[1]!, d[2]!)
      value.add(value.target)
      return value
    }
    return new THREE.PointLight(0xffffff, Math.min(40, Math.max(0, energy / 25)))
  })()
  built.color.setRGB(rgb[0]!, rgb[1]!, rgb[2]!, THREE.LinearSRGBColorSpace)
  built.name = `scene-light-${kind}`
  return built
}

/** 显式世界方向优先；没有 direction 时保留实体 quaternion 控制的局部 -Z 朝向。 */
export function orientAreaLight(group: THREE.Group, light: SceneLight): void {
  if (light.kind?.toLowerCase() !== "area") return
  const area = group.children.find(child => child instanceof THREE.RectAreaLight)
  if (!area) return
  area.quaternion.identity()
  if (!Array.isArray(light.direction) || light.direction.length < 3 || !light.direction.slice(0, 3).every(Number.isFinite)) return
  const direction = new THREE.Vector3(...light.direction.slice(0, 3) as [number, number, number])
  if (direction.lengthSq() < 1e-12) return
  const worldRotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), direction.normalize())
  area.quaternion.copy(group.getWorldQuaternion(new THREE.Quaternion()).invert()).multiply(worldRotation)
  area.updateMatrixWorld(true)
}
