import * as THREE from 'three'
import type { Frame, SceneSnapshot, WorldHandle } from '../../lyapunov-contracts/src/types.ts'
import type { RobotAnchorPose, RobotBaseState } from '../../lyapunov-contracts/src/robot-authoring.ts'
import { validRobotPose } from '../../lyapunov-contracts/src/robot-authoring.ts'
import { currentRobotFrame } from '../../lyapunov-contracts/src/robot-frame.ts'

export interface RobotAnchorSelection { entityId: string; kind: 'base' | 'tcp' }
interface Marker { group: THREE.Group; pick: THREE.Mesh; label: THREE.Sprite; selection: RobotAnchorSelection }
/** 底座与 TCP 标志只投影同版本原生 Frame，标志几何不参与物理、碰撞或抓取。 */
export class RobotAnchorLayer {
  readonly root = new THREE.Group()
  private snapshot?: SceneSnapshot
  private world?: WorldHandle
  private selected?: string
  private markers = new Map<string, Marker>()
  private step = -1
  constructor() { this.root.name = '__lyapunov_robot_anchors' }
  setContext(snapshot: SceneSnapshot | undefined, world: WorldHandle | undefined, selected?: string) {
    const changed = this.snapshot?.sceneId !== snapshot?.sceneId || this.snapshot?.revision !== snapshot?.revision || this.world?.worldId !== world?.worldId || this.world?.worldGeneration !== world?.worldGeneration || this.world?.appliedSceneRevision !== world?.appliedSceneRevision
    this.snapshot = snapshot; this.world = world; this.selected = selected
    if (changed || !world || !['ready', 'running', 'paused'].includes(world.status) || world.sceneId !== snapshot?.sceneId || world.appliedSceneRevision !== snapshot?.revision) this.clear()
    for (const marker of this.markers.values()) marker.group.visible = marker.selection.kind === 'base' || marker.selection.entityId === selected
  }
  receive(frame: Frame): boolean {
    if (!currentRobotFrame(this.snapshot, this.world, frame) || frame.stepIndex < this.step) return false
    this.step = frame.stepIndex
    const keep = new Set<string>()
    for (const entity of frame.entities) {
      const base = entity.sensors?.robotBase as RobotBaseState | undefined
      if (base?.mode === 'fixed' && validRobotPose(base.worldFromBody)) this.update(keep, entity.entityId, 'base', base.worldFromBody, base.target?.entityId ? '绑定' : '固定', 0xffba52)
      const tcp = entity.sensors?.tcp as RobotAnchorPose | undefined
      if (validRobotPose(tcp)) this.update(keep, entity.entityId, 'tcp', tcp, 'TCP', 0x47cfff)
    }
    for (const [key, marker] of this.markers) if (!keep.has(key)) { this.disposeMarker(marker); this.markers.delete(key) }
    return true
  }
  private update(keep: Set<string>, entityId: string, kind: RobotAnchorSelection['kind'], pose: RobotAnchorPose, text: string, color: number) {
    const key = `${entityId}:${kind}`; keep.add(key)
    let marker = this.markers.get(key)
    if (!marker || marker.label.userData.text !== text) {
      if (marker) this.disposeMarker(marker)
      const group = new THREE.Group(); group.name = key
      const radius = kind === 'base' ? .038 : .018
      const cross = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-radius, 0, 0), new THREE.Vector3(radius, 0, 0), new THREE.Vector3(0, -radius, 0), new THREE.Vector3(0, radius, 0), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, radius)])
      const lines = new THREE.LineSegments(cross, new THREE.LineBasicMaterial({ color, depthTest: false })); lines.renderOrder = 90; group.add(lines)
      const pick = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.3, 8, 6), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })); pick.userData.robotAnchor = { entityId, kind }; group.add(pick)
      const canvas = document.createElement('canvas'); canvas.width = 144; canvas.height = 64
      const context = canvas.getContext('2d')!
      context.fillStyle = '#162636'; context.beginPath(); context.roundRect(3, 4, 138, 52, 12); context.fill()
      context.fillStyle = new THREE.Color(color).getStyle(); context.font = 'bold 30px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(text, 72, 30)
      const texture = new THREE.CanvasTexture(canvas); const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false })); label.scale.set(.16, .071, 1); label.position.set(0, 0, radius + .055); label.renderOrder = 91; label.userData.text = text; group.add(label)
      marker = { group, pick, label, selection: { entityId, kind } }; this.markers.set(key, marker); this.root.add(group)
    }
    marker.group.position.fromArray(pose.positionM); marker.group.quaternion.fromArray(pose.quaternionXyzw)
    marker.group.visible = kind === 'base' || entityId === this.selected
  }
  pick(ray: THREE.Raycaster): RobotAnchorSelection | undefined {
    const hit = ray.intersectObjects([...this.markers.values()].filter(marker => marker.group.visible).map(marker => marker.pick), false)[0]
    return hit?.object.userData.robotAnchor
  }
  private disposeMarker(marker: Marker) {
    marker.group.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) { object.geometry.dispose(); const materials = Array.isArray(object.material) ? object.material : [object.material]; for (const material of materials) material.dispose() }
    })
    marker.label.material.map?.dispose(); marker.label.material.dispose(); marker.group.removeFromParent()
  }
  clear() { for (const marker of this.markers.values()) this.disposeMarker(marker); this.markers.clear(); this.step = -1 }
  dispose() { this.clear(); this.root.removeFromParent() }
}
