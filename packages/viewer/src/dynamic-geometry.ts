import * as THREE from "three"
import type { NativeDynamicGeometry } from "../../lyapunov-contracts/src/types.ts"

interface Part {
  kind: NativeDynamicGeometry["kind"]
  solidLines: boolean
  object: THREE.Mesh | THREE.LineSegments | THREE.Points
}

/** 一个 Scene 实体的 GPU 显示资源；输入始终来自当前 Frame，不持有第二份模拟状态。 */
export class DynamicGeometryVisual {
  readonly root = new THREE.Group()
  private readonly parts = new Map<string, Part>()
  private readonly hiddenVisuals = new Map<THREE.Object3D, boolean>()
  unmatchedBodyNames: string[] = []
  get nativeNames(): string[] { return [...this.parts.keys()] }

  constructor(private readonly parent: THREE.Group, private readonly beforeTopologyChange?: () => void) {
    this.root.name = "native-dynamic-geometry"
    this.root.matrixAutoUpdate = false
    parent.add(this.root)
  }

  update(states: readonly NativeDynamicGeometry[], staticVisual?: THREE.Object3D, bodyNode?: (name: string) => THREE.Object3D | undefined): void {
    // 数据已经是世界坐标；抵消 Scene 实体及全部父节点的变换，避免二次摆放。
    this.parent.updateWorldMatrix(true, false)
    this.root.matrix.copy(this.parent.matrixWorld).invert()
    this.root.matrixWorldNeedsUpdate = true
    const present = new Set<string>()
    for (const state of states) {
      const solidLines = state.kind === "lines" && state.radiusM !== undefined && state.radiusM > 0
      let part = this.parts.get(state.nativeName)
      const segmentCount = state.kind === "lines" ? state.indices.length / 2 : 0
      if (part && (part.kind !== state.kind || part.solidLines !== solidLines ||
          (part.object instanceof THREE.InstancedMesh && part.object.count !== segmentCount))) {
        this.beforeTopologyChange?.()
        this.releasePart(part); this.parts.delete(state.nativeName); part = undefined
      }
      if (!part) {
        this.beforeTopologyChange?.()
        part = createPart(state, solidLines)
        part.object.name = state.nativeName
        this.parts.set(state.nativeName, part)
        this.root.add(part.object)
      }
      present.add(state.nativeName)
      updatePart(part, state)
    }
    for (const [name, part] of this.parts) if (!present.has(name)) {
      this.beforeTopologyChange?.()
      this.releasePart(part); this.parts.delete(name)
    }
    // 实体缆线只能替换插件实际绑定的 body；同一 MJCF 内的障碍不能随之消失。
    const hidden = new Set<THREE.Object3D>(), missing = new Set<string>()
    for (const state of states) {
      if (state.kind !== "lines") { if (staticVisual) hidden.add(staticVisual); continue }
      for (const name of state.nativeBodyNames ?? []) {
        const node = bodyNode?.(name)
        if (node) hidden.add(node)
        else missing.add(name)
      }
    }
    for (const [object, visible] of this.hiddenVisuals) if (!hidden.has(object)) { object.visible = visible; this.hiddenVisuals.delete(object) }
    for (const object of hidden) {
      if (!this.hiddenVisuals.has(object)) this.hiddenVisuals.set(object, object.visible)
      object.visible = false
    }
    this.unmatchedBodyNames = [...missing]
  }

  private restoreStaticVisual(): void {
    for (const [object, visible] of this.hiddenVisuals) object.visible = visible
    this.hiddenVisuals.clear()
  }

  private releasePart(part: Part): void {
    part.object.removeFromParent()
    part.object.geometry.dispose()
    for (const material of Array.isArray(part.object.material) ? part.object.material : [part.object.material]) material.dispose()
  }

  dispose(): void {
    this.beforeTopologyChange?.()
    for (const part of this.parts.values()) this.releasePart(part)
    this.parts.clear()
    this.root.removeFromParent()
    this.restoreStaticVisual()
    this.unmatchedBodyNames = []
  }
}

function createPart(state: NativeDynamicGeometry, solidLines: boolean): Part {
  const material = () => new THREE.MeshStandardMaterial({ color: 0x58a9dd, roughness: 0.7, side: THREE.DoubleSide })
  let object: Part["object"]
  if (state.kind === "mesh") object = new THREE.Mesh(new THREE.BufferGeometry(), material())
  else if (state.kind === "particles") object = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0x58a9dd, size: state.radiusM * 2, sizeAttenuation: true }))
  else if (solidLines) {
    const segments = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 8), material(), state.indices.length / 2)
    segments.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    object = segments
  } else object = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x58a9dd }))
  return { kind: state.kind, solidLines, object }
}

function writePositions(geometry: THREE.BufferGeometry, values: readonly number[]): void {
  const current = geometry.getAttribute("position") as THREE.BufferAttribute | undefined
  if (current?.array.length === values.length) {
    (current.array as Float32Array).set(values)
    current.needsUpdate = true
  } else geometry.setAttribute("position", new THREE.Float32BufferAttribute(values, 3).setUsage(THREE.DynamicDrawUsage))
}

function writeIndices(geometry: THREE.BufferGeometry, values: number[]): void {
  const current = geometry.getIndex()
  if (current?.count === values.length) {
    // 统一用 Uint32，拓扑数量不变时顶点索引越过 65535 也不会被截断。
    (current.array as Uint32Array).set(values); current.needsUpdate = true
  } else geometry.setIndex(new THREE.Uint32BufferAttribute(values, 1))
}

function updatePart(part: Part, state: NativeDynamicGeometry): void {
  if (state.kind === "lines" && part.object instanceof THREE.InstancedMesh) {
    const start = new THREE.Vector3(), end = new THREE.Vector3(), direction = new THREE.Vector3()
    const center = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3(), matrix = new THREE.Matrix4()
    const up = new THREE.Vector3(0, 1, 0)
    for (let index = 0; index < state.indices.length; index += 2) {
      start.fromArray(state.positionsM, state.indices[index]! * 3)
      end.fromArray(state.positionsM, state.indices[index + 1]! * 3)
      direction.subVectors(end, start)
      const length = direction.length()
      center.addVectors(start, end).multiplyScalar(0.5)
      rotation.setFromUnitVectors(up, length > 0 ? direction.divideScalar(length) : up)
      scale.set(state.radiusM!, length, state.radiusM!)
      matrix.compose(center, rotation, scale)
      part.object.setMatrixAt(index / 2, matrix)
    }
    part.object.instanceMatrix.needsUpdate = true
    part.object.computeBoundingSphere()
    part.object.computeBoundingBox()
    return
  }
  const geometry = part.object.geometry
  writePositions(geometry, state.positionsM)
  if (state.kind !== "particles") writeIndices(geometry, state.indices)
  if (state.kind === "mesh") geometry.computeVertexNormals()
  if (state.kind === "particles") (part.object.material as THREE.PointsMaterial).size = state.radiusM * 2
  geometry.computeBoundingSphere()
  geometry.computeBoundingBox()
}
