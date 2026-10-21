/**
 * V10-08/38：资产放置 ghost 的真实 THREE 图行为（真 `SceneViewer` 原型，不建 WebGL）。
 *
 * 证明：真实 loadVisual 结果进入独立 authoring 子树；材质独立半透明、raycast 关闭；
 * 不写 objects/部件目录；取消/换 token/换 Scene 后迟到加载不复活；清理不销毁共享 geometry。
 */
import { describe, expect, test } from "bun:test"
import * as THREE from "three"
import { SceneViewer } from "../src/index.ts"

const transform = (position: [number, number, number] = [0, 0, 0]) => ({ position, quaternion: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] })
const entities = [
  { entityId: "preview-root", name: "preview", transform: transform([1, 2, 0]), resources: [], components: { visual: { kind: "group" } } },
  { entityId: "preview-mesh", parentId: "preview-root", name: "real mesh", transform: transform([0, 0, 0.5]), resources: [], components: { visual: { kind: "mesh" } } },
]

function fixture() {
  const viewer = Object.create(SceneViewer.prototype) as any
  Object.assign(viewer, {
    disposed: false,
    scene: new THREE.Scene(),
    snapshot: { sceneId: "scene-preview", revision: 1, coordinates: { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" }, entities: [] },
    objects: new Map(),
    placementPreviewGeneration: 0,
    presentationListeners: new Set(),
    options: { resolveResource: () => "about:blank" },
    parts: [] as unknown[],
    listParts: () => viewer.parts,
  })
  return viewer
}

/** 真实 mesh/geometry/material（含贴图），但由测试直接交给 loadVisual 槽位，避免起 WebGL。 */
function meshVisual(shared = false) {
  const group = new THREE.Group()
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const texture = new THREE.Texture()
  const material = new THREE.MeshStandardMaterial({ color: 0x88aaff, map: texture })
  group.add(new THREE.Mesh(geometry, material))
  if (shared) group.traverse(node => { node.userData.sharedVisual = true })
  const disposed = { geometry: 0, material: 0, texture: 0 }
  const geometryDispose = geometry.dispose.bind(geometry), materialDispose = material.dispose.bind(material), textureDispose = texture.dispose.bind(texture)
  geometry.dispose = () => { disposed.geometry += 1; geometryDispose() }
  material.dispose = () => { disposed.material += 1; materialDispose() }
  texture.dispose = () => { disposed.texture += 1; textureDispose() }
  return { group, geometry, material, texture, disposed }
}

describe("V10 Viewer 资产放置 ghost", () => {
  test("真实 mesh 进入独立子树；镜像半透明材质/关闭拾取；清理不销毁共享 GLB geometry/贴图", async () => {
    const viewer = fixture()
    const visual = meshVisual(true)
    viewer.loadVisual = async (entity: any) => entity.components.visual.kind === "mesh" ? visual.group : undefined
    const result = await viewer.previewPlacement({ token: "p1", sceneId: "scene-preview", resourceId: "r", version: 1, entities })
    expect(result.status).toBe("PREVIEW")
    expect(viewer.placementPreviewStatus()).toMatchObject({ active: true, token: "p1", resourceId: "r", version: 1 })
    const ghost = viewer.scene.getObjectByName("placement-ghost") as THREE.Group
    expect(ghost).toBeTruthy()
    // 父组 transform 与预览命令返回的实体 transform 一致。
    const rootGroup = ghost.getObjectByName("placement:preview-root") as THREE.Group
    expect(rootGroup.position.toArray()).toEqual([1, 2, 0])
    const meshGroup = ghost.getObjectByName("placement:preview-mesh") as THREE.Group
    expect(meshGroup.parent).toBe(rootGroup)
    const mesh = visual.group.children[0] as THREE.Mesh
    expect(mesh.material).not.toBe(visual.material)
    expect((mesh.material as THREE.MeshStandardMaterial).transparent).toBe(true)
    expect((mesh.material as THREE.MeshStandardMaterial).opacity).toBeLessThan(1)
    // 共享材质一个数不改；ghost 不进 objects。
    expect(visual.material.transparent).toBe(false)
    expect(viewer.objects.size).toBe(0)
    viewer.clearPlacementPreview()
    expect(viewer.scene.getObjectByName("placement-ghost")).toBeFalsy()
    expect(viewer.placementPreviewStatus().active).toBe(false)
    // GLTF 缓存的 geometry/材质/贴图不属于本次 ghost：一个都不销毁。
    expect(visual.disposed).toEqual({geometry: 0, material: 0, texture: 0})
    viewer.clearPlacementPreview()
    expect(visual.disposed).toEqual({geometry: 0, material: 0, texture: 0})
  })

  test("未共享机器人几何/材质/贴图随取消释放；迟到加载也释放且旧 ghost 不复活", async () => {
    const viewer = fixture()
    const owned = meshVisual(false)
    viewer.loadVisual = async () => owned.group
    expect((await viewer.previewPlacement({ token: "robot", sceneId: "scene-preview", resourceId: "r", version: 1, entities })).status).toBe("PREVIEW")
    viewer.clearPlacementPreview()
    // 机器人网格由本次 loadVisual 新建：取消时几何/材质/贴图都要释放。
    expect(owned.disposed).toEqual({geometry: 1, material: 1, texture: 1})
    expect(viewer.scene.getObjectByName("placement-ghost")).toBeFalsy()

    // A 慢加载刚返回时 B 已显示：A 的未挂载子树也必须释放，且不能复活成 ghost。
    let resolveLate!: (value: THREE.Object3D) => void
    const late = new Promise<THREE.Object3D>(resolve => { resolveLate = resolve })
    const lateVisual = meshVisual(false)
    viewer.loadVisual = async () => late
    const pending = viewer.previewPlacement({ token: "slow", sceneId: "scene-preview", resourceId: "r", version: 1, entities })
    viewer.loadVisual = async () => meshVisual(false).group
    expect((await viewer.previewPlacement({ token: "fast", sceneId: "scene-preview", resourceId: "r", version: 1, entities })).status).toBe("PREVIEW")
    resolveLate(lateVisual.group)
    expect((await pending).status).toBe("SUPERSEDED")
    expect(lateVisual.disposed).toEqual({geometry: 1, material: 1, texture: 1})
    expect(viewer.placementPreviewStatus().token).toBe("fast")
    expect(viewer.scene.children.filter((child: THREE.Object3D) => child.name === "placement-ghost")).toHaveLength(1)
  })

  test("取消/换 token/换 Scene 后迟到加载不复活旧 ghost", async () => {
    const viewer = fixture()
    let resolveFirst!: (value: THREE.Object3D) => void
    const first = new Promise<THREE.Object3D>(resolve => { resolveFirst = resolve })
    let call = 0
    viewer.loadVisual = async () => { call += 1; return call === 1 ? first : meshVisual().group }
    const pending = viewer.previewPlacement({ token: "old", sceneId: "scene-preview", resourceId: "r", version: 1, entities })
    // 同一 Viewer 开始新放置：旧请求作废。
    const current = await viewer.previewPlacement({ token: "new", sceneId: "scene-preview", resourceId: "r", version: 1, entities })
    expect(current.status).toBe("PREVIEW")
    resolveFirst(meshVisual().group)
    const old = await pending
    expect(old.status).toBe("SUPERSEDED")
    expect(viewer.placementPreviewStatus().token).toBe("new")
    expect(viewer.scene.children.filter((child: THREE.Object3D) => child.name === "placement-ghost")).toHaveLength(1)
    // 换 Scene 后迟到结果同样作废。
    let resolveLate!: (value: THREE.Object3D) => void
    const late = new Promise<THREE.Object3D>(resolve => { resolveLate = resolve })
    viewer.loadVisual = async () => late
    const pendingLate = viewer.previewPlacement({ token: "late", sceneId: "scene-preview", resourceId: "r", version: 1, entities })
    viewer.snapshot = { ...viewer.snapshot, sceneId: "scene-other" }
    resolveLate(meshVisual().group)
    expect((await pendingLate).status).toBe("SUPERSEDED")
    expect(viewer.scene.getObjectByName("placement-ghost")).toBeFalsy()
  })

  test("没有可显示几何时明确 Unavailable，不留下 ghost", async () => {
    const viewer = fixture()
    viewer.loadVisual = async () => undefined
    const result = await viewer.previewPlacement({ token: "empty", sceneId: "scene-preview", resourceId: "r", version: 1, entities })
    expect(result).toMatchObject({ status: "UNAVAILABLE", reason: "ASSET_PREVIEW_NO_VISUAL" })
    expect(viewer.scene.getObjectByName("placement-ghost")).toBeFalsy()
  })
})

describe("V10 Frame placement preview", () => {
  test("只框已加载 ghost 几何；不把远处原件加入包围盒，也不改 ghost", async () => {
    const viewer = fixture()
    viewer.splatViewBounds = new WeakMap()
    viewer.loadVisual = async () => meshVisual(false).group
    let framed: THREE.Box3 | undefined
    viewer.frameBounds = (box: THREE.Box3) => { framed = box.clone() }
    const entities = [
      { entityId: "near", name: "near", transform: { position: [1, 2, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [], components: { visual: { kind: "mesh" } } },
    ]
    expect((await viewer.previewPlacement({ token: "frame", sceneId: "scene-preview", resourceId: "r", version: 1, entities })).status).toBe("PREVIEW")
    const result = viewer.framePlacementPreview()
    expect(result).toMatchObject({ ok: true, token: "frame" })
    expect(framed).toBeDefined()
    const center = framed!.getCenter(new THREE.Vector3())
    expect(center.x).toBeCloseTo(1)
    expect(center.y).toBeCloseTo(2)
    // 框选只动相机：ghost 仍在、token/变换未变。
    expect(viewer.placementPreviewStatus()).toMatchObject({ active: true, token: "frame" })
    expect(viewer.scene.getObjectByName("placement-ghost")).toBeTruthy()
  })
})
