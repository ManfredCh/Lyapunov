import * as THREE from "three"
import type { Entity, Transform } from "../../lyapunov-contracts/src/types.ts"

/**
 * 为 Scene 文档已有的碰撞包络生成只读线框。
 *
 * 这里不解析 MJCF/URDF，也不从可见网格猜碰撞体；未知形状明确不显示，
 * 这样 Viewer 不会把近似几何误报成引擎实际碰撞几何。
 */
export function buildCollisionVisual(entity: Entity): THREE.Object3D | undefined {
  const value = entity.components.collision as Record<string, unknown> | undefined
  if (!value) return undefined
  const shape = String(value.type ?? value.shape ?? "box").toLowerCase()
  const numberList = (candidate: unknown): [number, number, number] | undefined => {
    if (!Array.isArray(candidate) || candidate.length !== 3 || candidate.some(item => typeof item !== "number" || !Number.isFinite(item) || item <= 0)) return undefined
    return [candidate[0] as number, candidate[1] as number, candidate[2] as number]
  }
  const half = numberList(value.halfExtents)
  let geometry: THREE.BufferGeometry
  if (shape === "sphere") {
    const radius = typeof value.radiusM === "number" && value.radiusM > 0 ? value.radiusM : typeof value.radius === "number" && value.radius > 0 ? value.radius : undefined
    if (!radius) return undefined
    geometry = new THREE.SphereGeometry(radius, 16, 8)
  } else if (shape === "cylinder") {
    const radius = typeof value.radiusM === "number" && value.radiusM > 0 ? value.radiusM : typeof value.radius === "number" && value.radius > 0 ? value.radius : undefined
    const halfHeight = typeof value.halfHeightM === "number" && value.halfHeightM > 0 ? value.halfHeightM : typeof value.heightM === "number" && value.heightM > 0 ? value.heightM / 2 : undefined
    if (!radius || !halfHeight) return undefined
    geometry = new THREE.CylinderGeometry(radius, radius, halfHeight * 2, 16)
  } else if (shape === "box") {
    const size = numberList(value.sizeM)
    const extents: [number, number, number] | undefined = half ?? (size ? [size[0] / 2, size[1] / 2, size[2] / 2] : undefined)
    if (!extents) return undefined
    geometry = new THREE.BoxGeometry(extents[0] * 2, extents[1] * 2, extents[2] * 2)
  }
  else return undefined
  const material = new THREE.LineBasicMaterial({ color: 0xffb347, transparent: true, opacity: .9, depthTest: false })
  const helper = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), material)
  geometry.dispose()
  helper.renderOrder = 20
  helper.userData.collisionHelper = true
  const transform = value.transform
  if (transform && typeof transform === "object") {
    const local = transform as Partial<Transform>
    if (Array.isArray(local.position) && local.position.length === 3) helper.position.fromArray(local.position as [number, number, number])
    if (Array.isArray(local.quaternion) && local.quaternion.length === 4) helper.quaternion.fromArray(local.quaternion as [number, number, number, number])
  }
  return helper
}
