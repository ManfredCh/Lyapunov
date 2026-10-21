/**
 * R-012／§2.9：Viewer 临时装配 ghost 的真实行为（真 THREE 图 + 真 `SceneViewer` 原型，不建 WebGL）。
 *
 * 证明：
 *  · ghost 用**真实已加载几何**的克隆，材质独立透明——共享 geometry 不被复制、共享材质一个数不改；
 *  · 按真实 native 根偏移（rootFrameInverse）与目标 body 世界矩阵精确对齐；
 *  · 源处于炸开态时拒绝预览，必须显式合拢；
 *  · 清理只销毁克隆材质与自建 marker，不动共享几何；ghost 不进入部件目录。
 */
import { describe, expect, test } from "bun:test"
import * as THREE from "three"
import { buildRobotVisual, type RobotVisual } from "../src/robot.ts"
import { SceneViewer } from "../src/index.ts"

const meshOf = (root: THREE.Object3D): THREE.Mesh => { let found: THREE.Mesh | undefined; root.traverse(child => { if (!found && (child as THREE.Mesh).isMesh) found = child as THREE.Mesh }); if (!found) throw new Error("夹具没有 Mesh"); return found }
const countByUserData = (root: THREE.Object3D, key: string): number => { let count = 0; root.traverse(child => { if (child.userData[key]) count += 1 }); return count }

async function handVisual(): Promise<RobotVisual> {
  // 根 body 带非零 pos：native 根与"模型原点"之间有真实偏移，rootFrameInverse 必须被用上。
  return buildRobotVisual({ format: "mjcf", baseUri: "file:///hand/", document: { worldbody: { body: { name: "palm", pos: "0.2 0 0.1", geom: { type: "box", size: "0.05 0.05 0.05" }, body: { name: "finger", pos: "0.06 0 0", geom: { type: "box", size: "0.02 0.02 0.02" } } } } } } as never, () => { throw new Error("box geom 不应取网格") })
}
async function pandaVisual(): Promise<RobotVisual> {
  return buildRobotVisual({ format: "mjcf", baseUri: "file:///panda/", document: { worldbody: { body: { name: "base", geom: { type: "box", size: "0.1 0.1 0.1" }, body: { name: "attachment", pos: "0.1 0.2 0.3", geom: { type: "box", size: "0.03 0.03 0.03" } } } } } } as never, () => { throw new Error("box geom 不应取网格") })
}

async function fixture() {
  const hand = await handVisual(), panda = await pandaVisual()
  const viewer = Object.create(SceneViewer.prototype) as any
  const scene = new THREE.Scene()
  hand.root.userData.entityId = "hand"; panda.root.userData.entityId = "panda"
  scene.add(hand.root, panda.root)
  Object.assign(viewer, {
    scene, presentationListeners: undefined, partExplode: undefined,
    objects: new Map([
      ["hand", { group: hand.root, visual: hand.root, signature: "hand@1", lodWarnings: [], robot: hand }],
      ["panda", { group: panda.root, visual: panda.root, signature: "panda@1", lodWarnings: [], robot: panda }],
    ]),
  })
  return { viewer, hand, panda }
}
const spec = (overrides: Record<string, unknown> = {}) => ({ sourceEntityId: "hand", targetEntityId: "panda", targetBodyName: "attachment", targetBodyFromSourceRoot: { positionM: [0.05, -0.02, 0.12], quaternionXyzw: [0, 0, 0, 1] }, ...overrides })

describe("R-012 Viewer 装配 ghost", () => {
  test("真实几何克隆 + 独立透明材质 + 原生根偏移对齐；清理不动共享资源", async () => {
    const { viewer, hand, panda } = await fixture()
    const handMesh = meshOf(hand.root), handGeometry = handMesh.geometry, handMaterial = handMesh.material as THREE.Material
    expect(handMaterial.transparent).toBeFalsy()
    const result = viewer.previewAssemblyGhost(spec())
    expect(result.status).toBe("PREVIEW")
    expect(viewer.assemblyPreviewStatus()).toMatchObject({ active: true, sourceEntityId: "hand", targetEntityId: "panda", targetBodyName: "attachment" })
    const ghost = viewer.scene.getObjectByName("assembly-ghost") as THREE.Group
    expect(ghost).toBeTruthy()
    const ghostMesh = meshOf(ghost)
    // 几何共享（克隆不复制 geometry），材质是独立克隆且透明。
    expect(ghostMesh.geometry).toBe(handGeometry)
    expect(ghostMesh.material).not.toBe(handMaterial)
    expect((ghostMesh.material as THREE.Material).transparent).toBe(true)
    expect((ghostMesh.material as THREE.Material).opacity).toBeLessThan(1)
    // 共享材质一个数没改。
    expect(handMaterial.transparent).toBeFalsy()
    expect(handMaterial.opacity).toBe(1)
    // 对齐：ghost.matrix = targetBodyWorld · install · rootFrameInverse。
    panda.bodyNode("attachment")!.updateWorldMatrix(true, false)
    const expected = panda.bodyNode("attachment")!.matrixWorld.clone()
      .multiply(new THREE.Matrix4().compose(new THREE.Vector3(0.05, -0.02, 0.12), new THREE.Quaternion(0, 0, 0, 1), new THREE.Vector3(1, 1, 1)))
      .multiply(hand.rootFrameInverse)
    expect(ghost.matrix.elements.map(value => Number(value.toFixed(9)))).toEqual(expected.elements.map(value => Number(value.toFixed(9))))
    // ghost 不进入部件目录（objects/parts 只认真实实体）。
    expect(viewer.listParts().length).toBe(viewer.listParts("hand").length + viewer.listParts("panda").length)
    expect(countByUserData(ghost, "assemblyGhost")).toBeGreaterThan(0)
    // 清理：移除 ghost 与 marker，共享几何仍在（未被 dispose）。
    let disposed = 0
    const originalDispose = handGeometry.dispose.bind(handGeometry)
    handGeometry.dispose = () => { disposed += 1; originalDispose() }
    expect(viewer.clearAssemblyPreview()).toBeUndefined()
    expect(viewer.scene.getObjectByName("assembly-ghost")).toBeFalsy()
    expect(viewer.scene.getObjectByName("assembly-mount-marker")).toBeFalsy()
    expect(viewer.assemblyPreviewStatus().active).toBe(false)
    expect(disposed).toBe(0)
    // 再次清理是幂等 no-op。
    viewer.clearAssemblyPreview()
    expect(viewer.assemblyPreviewStatus().active).toBe(false)
  })

  test("源炸开态拒绝预览；缺目标 body 明确不可用；重复预览替换旧 ghost", async () => {
    const { viewer } = await fixture()
    viewer.partExplode = { entityId: "hand", spread: 0.5 }
    expect(viewer.previewAssemblyGhost(spec())).toMatchObject({ status: "UNAVAILABLE", reason: "ASSEMBLY_PREVIEW_SOURCE_EXPLODED" })
    viewer.partExplode = undefined
    expect(viewer.previewAssemblyGhost(spec({ targetBodyName: "missing" }))).toMatchObject({ status: "UNAVAILABLE", reason: "ASSEMBLY_PREVIEW_TARGET_BODY_MISSING" })
    expect(viewer.previewAssemblyGhost(spec({ sourceEntityId: "nope" }))).toMatchObject({ status: "UNAVAILABLE", reason: "ASSEMBLY_PREVIEW_SOURCE_NOT_LOADED" })
    expect(viewer.previewAssemblyGhost(spec({ targetBodyFromSourceRoot: { positionM: [0, 0], quaternionXyzw: [0, 0, 0, 1] } }))).toMatchObject({ status: "UNAVAILABLE", reason: "ASSEMBLY_PREVIEW_POSE_INVALID" })
    // 合法预览后再预览：旧 ghost 被替换，场景里只有一个 ghost。
    expect(viewer.previewAssemblyGhost(spec()).status).toBe("PREVIEW")
    expect(viewer.previewAssemblyGhost(spec()).status).toBe("PREVIEW")
    expect(viewer.scene.children.filter((child: THREE.Object3D) => child.name === "assembly-ghost")).toHaveLength(1)
    expect(viewer.scene.children.filter((child: THREE.Object3D) => child.name === "assembly-mount-marker")).toHaveLength(1)
  })

  test("旧件停放 ghost：独立世界位姿 + 采集窄面带旧件 ID/停放 pose/applied:false，清理只删克隆", async () => {
    const { viewer, hand } = await fixture()
    const handMesh = meshOf(hand.root), handGeometry = handMesh.geometry
    const result = viewer.previewParkingGhost({ entityId: "hand", worldPose: { positionM: [0.4, 0.1, 0.2], quaternionXyzw: [0, 0, 0, 1] }, worldId: "w", sceneId: "s", sceneRevision: 3, generation: 2 })
    expect(result).toEqual({ status: "PREVIEW", entityId: "hand" })
    const ghost = viewer.scene.getObjectByName("parking-ghost") as THREE.Group
    expect(ghost).toBeTruthy()
    // 停放 ghost 摆在世界停放位姿（乘上源模型帧逆），不跟随任何目标 body。
    const expected = new THREE.Matrix4().compose(new THREE.Vector3(0.4, 0.1, 0.2), new THREE.Quaternion(0, 0, 0, 1), new THREE.Vector3(1, 1, 1)).multiply(hand.rootFrameInverse)
    expect(ghost.matrix.elements.map(value => Number(value.toFixed(9)))).toEqual(expected.elements.map(value => Number(value.toFixed(9))))
    // 采集/观察窄面必须能解释"这是哪件旧件、停在哪个世界位姿、还没应用"。
    expect(viewer.presentationStatus().parkingPreview).toMatchObject({ applied: false, entityId: "hand", positionM: [0.4, 0.1, 0.2], quaternionXyzw: [0, 0, 0, 1], worldId: "w", sceneRevision: 3, generation: 2 })
    expect(viewer.parkingPreviewStatus()).toMatchObject({ active: true, entityId: "hand", positionM: [0.4, 0.1, 0.2] })
    // 非法位姿明确不可用，不落 ghost。
    expect(viewer.previewParkingGhost({ entityId: "hand", worldPose: { positionM: [0, 0], quaternionXyzw: [0, 0, 0, 1] } })).toMatchObject({ status: "UNAVAILABLE", reason: "ASSEMBLY_PREVIEW_POSE_INVALID" })
    let disposed = 0
    const originalDispose = handGeometry.dispose.bind(handGeometry)
    handGeometry.dispose = () => { disposed += 1; originalDispose() }
    viewer.clearParkingGhost()
    expect(viewer.scene.getObjectByName("parking-ghost")).toBeFalsy()
    expect(viewer.parkingPreviewStatus().active).toBe(false)
    expect(viewer.presentationStatus().parkingPreview).toBeUndefined()
    expect(disposed).toBe(0)
  })
})
