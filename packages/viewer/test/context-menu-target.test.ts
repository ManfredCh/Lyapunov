/**
 * 右键菜单的**实体目标**回归：菜单必须落在光标下的真实实体上，不能用“当前已选中”冒充。
 *
 * 真 Three 射线拾取 + 真视口尺寸；只替身 renderer/canvas 边界与回调。旧实现只读 `this.selected`，
 * 右键 B 而 A 被选中时会把菜单/批注挂到 A。
 */
import {test, expect} from 'bun:test'
import * as THREE from 'three'
import {SceneViewer} from '../src/index.ts'

function fixture() {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true)
  const canvas = {getBoundingClientRect: () => ({left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON() {}})}
  const mesh = (entityId: string, x: number) => {
    const group = new THREE.Group(); group.userData.entityId = entityId
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()); box.position.set(x, 0, 0)
    group.add(box); group.updateMatrixWorld(true); return group
  }
  const viewer = Object.create(SceneViewer.prototype) as any
  viewer.renderer = {domElement: canvas}
  viewer.camera = camera
  viewer.objects = new Map([['a', {group: mesh('a', 0)}], ['b', {group: mesh('b', 1.2)}]])
  viewer.snapshot = {sceneId: 's', revision: 1}
  viewer.selected = 'a'
  viewer.select = function (id?: string) { this.selected = id }
  viewer.annotationHitAtPointer = () => ({surface: true})
  const applied: unknown[] = []
  viewer.applyAnnotationHit = (hit: unknown) => { applied.push(hit) }
  const requests: any[] = []
  viewer.options = {onContextMenu: (request: any) => requests.push(request)}
  return {viewer, requests, applied}
}
const mouse = (clientX: number, clientY: number) => { const event: any = {clientX, clientY, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }}; return event }

test('右键实体 B（当前选中 A）⇒ 菜单目标是 B，并同步选中 B', () => {
  const {viewer, requests, applied} = fixture()
  const onB = mouse(151, 100)
  viewer.openContextMenu(onB)
  expect(onB.defaultPrevented).toBe(true)
  expect(requests).toHaveLength(1)
  expect(requests[0].entityId).toBe('b')
  expect(viewer.selected).toBe('b')
  // 批注锚点也按右键实体 B 计算，而不是旧的 A。
  requests[0].annotate()
  expect(applied).toHaveLength(1)
})

test('右键空处不开菜单也不阻止默认；右键实体 A 仍是 A', () => {
  const {viewer, requests} = fixture()
  const empty = mouse(5, 5)
  viewer.openContextMenu(empty)
  expect(empty.defaultPrevented).toBe(false)
  expect(requests).toHaveLength(0)
  const onA = mouse(100, 100)
  viewer.openContextMenu(onA)
  expect(requests).toHaveLength(1)
  expect(requests[0].entityId).toBe('a')
  expect(viewer.selected).toBe('a')
})
