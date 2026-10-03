/**
 * DEV-038 · 相机视锥 **viewer 胶水**（`SceneViewer.setCameraRigs/selectCameraRig/attachCameraRigGizmo/updateCameraRig`）
 * 的真行为测试——判据 3 的场景图路径对账、判据 4 的拖拽报告与归属互斥、判据 5 的覆盖/降级。
 *
 * 与 `camera-view.test.ts` 的 `viewerRig` 同一手法：**真 `SceneViewer` 原型 + 假画布**（`Object.create`，
 * 跑的是产品那一份方法；只有 renderer/transformControls 是最小替身）。这里必须走真原型的原因：
 * 判据 3 要对账的是"视锥挂在 body 节点下、局部变换只写一次"这条**产品代码路径**上的矩阵闭合——
 * 测试自己另写一份矩阵公式再测，测的只是测试自己。
 *
 * 边界（不冒充已完成）：没有 WebGL/浏览器——真实画面像素、点选手感不在本文件（方案 §8 判据 4 的
 * 真机端由 `sim-mujoco` 相机测试族＋浏览器验收补）。运行：`bun test packages/viewer/test/camera-rig-view.test.ts`
 */
import { describe, expect, it } from "bun:test"
import * as THREE from "three"
import { SceneViewer } from "../src/index.ts"
import { frustumFromReceipt, type FrustumSpec, type RigidPose } from "../src/camera-frustum.ts"
import { normalizeIntrinsics, quaternionAngleDeg, type ViewerQuat, type ViewerVec3 } from "../src/camera-view.ts"
import type {Frame} from '../../lyapunov-contracts/src/types.ts'

const axisAngle = (axis: ViewerVec3, rad: number): ViewerQuat => {
  const norm = Math.hypot(...axis), s = Math.sin(rad / 2) / norm
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(rad / 2)]
}
const quat = (q: ViewerQuat) => new THREE.Quaternion(q[0], q[1], q[2], q[3])
/** 刚体复合 `parent ∘ local`（与引擎 `worldFromCamera = bodyWorld ∘ mountLocal` 同义）。 */
function composePose(parent: RigidPose, local: RigidPose): RigidPose {
  const position = new THREE.Vector3(...local.positionM).applyQuaternion(quat(parent.quaternionXyzw)).add(new THREE.Vector3(...parent.positionM))
  const quaternion = quat(parent.quaternionXyzw).multiply(quat(local.quaternionXyzw))
  return { positionM: position.toArray() as ViewerVec3, quaternionXyzw: quaternion.toArray() as ViewerQuat }
}

/** 真 `SceneViewer` 原型 + 假画布（camera-view.test.ts 的 viewerRig 同一手法，只留视锥用得到的缝）。 */
function rigHarness() {
  const viewer: any = Object.create(SceneViewer.prototype)
  viewer.scene = new THREE.Scene()
  viewer.objects = new Map()
  viewer.cameraRigs = new Map()
  viewer.cameraRigRoot = new THREE.Group()
  viewer.cameraRigGizmoKey = undefined
  viewer.cameraRigSelected = undefined
  viewer.transformControls = {
    object: undefined as THREE.Object3D | undefined,
    attach(object: THREE.Object3D) { this.object = object },
    detach() { this.object = undefined },
  }
  return viewer
}

describe('R-015 原生相机 owner、同帧投影与返回导航',()=>{
 it('相机自身实体与 parentEntityId 不同：只挂到真实机器人 owner，原生局部标定不反解错时刻矩阵',()=>{
  const viewer=rigHarness(),bodyNode=new THREE.Object3D(),local={positionM:[0.1,0.2,0.3],quaternionXyzw:[0,0,0,1]}
  viewer.objects=new Map([['camera-a',{group:new THREE.Group()}],['robot-a',{group:new THREE.Group(),robot:{bodyNode:(name:string)=>name==='wrist'?bodyNode:undefined}}]])
  viewer.setCameraRigs([specOfRow({...receiptRow('camera-a/腕部','robot-a/wrist'),entityId:'camera-a',parentEntityId:'robot-a',parentFromCamera:local})])
  const rig=viewer.cameraRigs.get('camera-a/腕部')
  expect(rig.group.parent).toBe(bodyNode);expect(rig.group.userData.mountedEntityId).toBe('robot-a');expect(rig.group.position.toArray()).toEqual(local.positionM)
  viewer.setCameraRigsVisible(false);expect(rig.group.visible).toBe(false)
  viewer.setCameraRigs([specOfRow({...receiptRow('camera-a/腕部','robot-a/wrist'),parentEntityId:'robot-a',parentFromCamera:local})]);expect(viewer.cameraRigs.get('camera-a/腕部').group.visible).toBe(false)
 })
 it('显式 parentEntityId 尚未加载时不能跨挂到另一台同名 body',()=>{
  const viewer=rigHarness(),bodyNode=new THREE.Object3D()
  viewer.objects=new Map([['robot-b',{group:new THREE.Group(),robot:{bodyNode:()=>bodyNode}}]])
  viewer.setCameraRigs([specOfRow({...receiptRow('camera-a/腕部','wrist'),parentEntityId:'robot-a'})])
  expect(viewer.cameraRigs.get('camera-a/腕部').group.parent).toBe(viewer.cameraRigRoot)
  expect(viewer.cameraRigs.get('camera-a/腕部').group.userData.mountMissingReason).toContain('尚未加载')
 })
 it('进入后随真实回执更新，换相机不覆盖返回位；相机不可用时退出并恢复原导航',()=>{
  const viewer=rigHarness(),main={position:[5,-6,4],quaternion:[0,0,0,1],target:[0,0,1],navigation:'first-person'}
  const applied:any[]=[],restored:any[]=[],navigation:boolean[]=[]
  viewer.controls={enabled:true};viewer.firstPerson={setActive:(value:boolean)=>navigation.push(value)}
  viewer.getViewState=()=>main;viewer.applyCameraView=(request:any)=>applied.push(request);viewer.setViewState=(state:any)=>restored.push(state);viewer.setCaptureGate=()=>{}
  viewer.setCameraRigs([specOf('world-camera'),specOf('camera-b')]);viewer.pilotCameraRig('world-camera')
  expect(viewer.controls.enabled).toBe(false);expect(viewer.pilotedCameraRig()).toBe('world-camera')
  viewer.setCameraRigs([specOfRow({...receiptRow('world-camera'),worldFromCamera:{positionM:[2,3,4],quaternionXyzw:[0,0,0,1]}}),specOf('camera-b')])
  expect(applied.at(-1).position).toEqual([2,3,4]);viewer.pilotCameraRig('camera-b');viewer.returnFromCameraRig()
  expect(restored).toEqual([main]);expect(navigation.at(-1)).toBe(true)
  viewer.pilotCameraRig('world-camera');viewer.setCameraRigs([]);expect(viewer.pilotedCameraRig()).toBeUndefined();expect(restored).toEqual([main,main])
 })
 it('同Frame原生body投影先于相机；异frame行和异步清单拒绝，不在每个渲染tick重建视锥',()=>{
  const viewer=rigHarness(),bodyCalls:any[]=[],group=new THREE.Group()
  viewer.scene.add(group);viewer.objects=new Map([['robot-a',{group,robot:{rootFrameInverse:new THREE.Matrix4(),setBodyWorldPoses:(value:any)=>bodyCalls.push(value)}}]])
  const frame:Frame={worldId:'w',generation:4,sceneRevision:7,stepIndex:11,simTime:0.022,frameId:'w:4:11',entities:[{entityId:'robot-a',transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},sensors:{bodyWorldPoses:{wrist:{bodyName:'wrist',positionM:[1,2,3],quaternionXyzw:[0,0,0,1]}}}}],cameras:[{...receiptRow('camera-a/腕部'),frameId:'w:4:11',stepIndex:11,generation:4,sceneRevision:7},{...receiptRow('stale'),frameId:'w:4:10',stepIndex:10,generation:4,sceneRevision:7}]}
  viewer.projection={current:()=>frame};viewer.applyFrame(frame)
  expect(bodyCalls[0]).toEqual(frame.entities[0]!.sensors!.bodyWorldPoses);expect(viewer.cameraRigKeys()).toEqual(['camera-a/腕部'])
  const rig=viewer.cameraRigs.get('camera-a/腕部');viewer.applyFrame(frame);expect(viewer.cameraRigs.get('camera-a/腕部')).toBe(rig)
  viewer.setCameraRigs([specOfRow({...receiptRow('old-list'),stepIndex:10,generation:4,sceneRevision:7})]);expect(viewer.cameraRigKeys()).toEqual(['camera-a/腕部'])
 })
})

const K = normalizeIntrinsics({ fx: 600, fy: 610, cx: 360, cy: 200, width: 640, height: 480 })
const bodyWorld: RigidPose = { positionM: [0.4, -0.2, 0.9], quaternionXyzw: axisAngle([0.2, 1, 0.3], 0.7) }
const specWorld: RigidPose = { positionM: [1.1, 0.3, 0.55], quaternionXyzw: axisAngle([1, -0.4, 0.5], -1.1) }
const receiptRow = (cameraName: string, parentBodyName?: string) => ({
  cameraName,
  worldFromCamera: { positionM: specWorld.positionM, quaternionXyzw: specWorld.quaternionXyzw },
  intrinsics: K,
  intrinsicsSource: "engine-intrinsics",
  ...parentBodyName ? { parentBodyName, referenceFrame: "parent" } : {},
  override: true,
})
const specOf = (cameraName: string, parentBodyName?: string): FrustumSpec => {
  const result = frustumFromReceipt(receiptRow(cameraName, parentBodyName), { source: "engine" })
  if (!result.ok) throw new Error(`fixture 不应被拒: ${result.unavailable}`)
  return result.spec
}
const specOfRow = (row: Record<string, unknown>): FrustumSpec => {
  const result = frustumFromReceipt(row, { source: "engine" })
  if (!result.ok) throw new Error(`fixture 不应被拒: ${result.unavailable}`)
  return result.spec
}
/** 两台**同名 body**的机器人（各实体只认自己的局部 body 名，与 `RobotVisual.bodyNode` 一致）。 */
function twoRobots(worldOf: Record<string, RigidPose>, bodies: Record<string, string[]>) {
  const nodes = new Map<string, Map<string, THREE.Object3D>>()
  const visuals = new Map<string, { group: THREE.Group; robot: { bodyNode: (name: string) => THREE.Object3D | undefined } }>()
  for (const [entityId, names] of Object.entries(bodies)) {
    const byName = new Map<string, THREE.Object3D>()
    for (const name of names) {
      const node = new THREE.Object3D()
      const pose = worldOf[`${entityId}/${name}`]!
      node.position.set(...pose.positionM)
      node.quaternion.copy(quat(pose.quaternionXyzw))
      node.updateWorldMatrix(true, false)
      byName.set(name, node)
    }
    nodes.set(entityId, byName)
    visuals.set(entityId, { group: new THREE.Group(), robot: { bodyNode: (name: string) => byName.get(name) } })
  }
  return { nodes, visuals }
}

describe("判据 3（场景图路径对账）：结构化挂载的矩阵闭合", () => {
  it("挂载视锥＝body 节点子级；body∘local 与回执 worldFromCamera 逐位一致（≤1e-9）", () => {
    const viewer = rigHarness()
    const bodyNode = new THREE.Object3D()
    bodyNode.position.set(...bodyWorld.positionM)
    bodyNode.quaternion.copy(quat(bodyWorld.quaternionXyzw))
    bodyNode.updateWorldMatrix(true, false)
    viewer.objects = new Map([["robot", { group: new THREE.Group(), robot: { bodyNode: (name: string) => name === "probe_rig/link6" ? bodyNode : undefined } }]])
    viewer.setCameraRigs([specOf("probe_rig/wrist", "probe_rig/link6")])
    expect(viewer.cameraRigKeys()).toEqual(["probe_rig/wrist"])
    const rig = viewer.cameraRigs.get("probe_rig/wrist")
    expect(rig.group.parent).toBe(bodyNode)                    // 结构化挂载：不是摆世界，是挂 link 下
    expect(rig.group.userData.mountedTo).toBe("probe_rig/link6")
    const local: RigidPose = { positionM: rig.group.position.toArray(), quaternionXyzw: rig.group.quaternion.toArray() }
    const recomposed = composePose(bodyWorld, local)
    recomposed.positionM.forEach((v, i) => expect(Math.abs(v - specWorld.positionM[i]!)).toBeLessThan(1e-9))
    expect(quaternionAngleDeg(recomposed.quaternionXyzw, specWorld.quaternionXyzw)).toBeLessThan(1e-6)
  })
  it("运动父体：拖拽报告的 worldPose ＝ body∘localPose（同一帧 FK，判据 3 口径）", () => {
    const viewer = rigHarness()
    const bodyNode = new THREE.Object3D()
    bodyNode.position.set(...bodyWorld.positionM)
    bodyNode.quaternion.copy(quat(bodyWorld.quaternionXyzw))
    bodyNode.updateWorldMatrix(true, false)
    viewer.objects = new Map([["robot", { group: new THREE.Group(), robot: { bodyNode: () => bodyNode } }]])
    viewer.setCameraRigs([specOf("probe_rig/wrist", "probe_rig/link6")])
    // "拖了一段"：局部变换被 gizmo 改掉（世界位姿随之由 FK 复合得出）。
    const rig = viewer.cameraRigs.get("probe_rig/wrist")
    rig.group.position.set(0.02, -0.01, 0.03)
    rig.group.quaternion.copy(quat(axisAngle([0, 0, 1], 0.25)))
    const edits: Array<{ key: string; edit: { worldPose: RigidPose; localPose: RigidPose } }> = []
    viewer.onCameraRigEdit = (key: string, edit: { worldPose: RigidPose; localPose: RigidPose }) => edits.push({ key, edit })
    viewer.attachCameraRigGizmo("probe_rig/wrist")
    viewer.emitCameraRigEdit()
    expect(edits).toHaveLength(1)
    const { key, edit } = edits[0]!
    expect(key).toBe("probe_rig/wrist")
    const recomposed = composePose(bodyWorld, edit.localPose)
    recomposed.positionM.forEach((v, i) => expect(Math.abs(v - edit.worldPose.positionM[i]!)).toBeLessThan(1e-9))
    expect(quaternionAngleDeg(recomposed.quaternionXyzw, edit.worldPose.quaternionXyzw)).toBeLessThan(1e-6)
  })
  it("负对照（降级）：parentBodyName 映射不上 ⇒ 世界位姿静态 + mountMissing 标注，不硬凑挂载", () => {
    const viewer = rigHarness()
    viewer.setCameraRigs([specOf("probe_rig/wrist", "probe_rig/link6")])
    const rig = viewer.cameraRigs.get("probe_rig/wrist")
    expect(rig.group.parent).toBe(viewer.cameraRigRoot)
    expect(rig.group.userData.mountMissing).toBe("probe_rig/link6")
  })
})

describe("判据 4（归属互斥）：实体 gizmo 与视锥 gizmo 不混", () => {
  it("transformControls.object 不是这一台 ⇒ 拖拽不报（归属互斥负对照）", () => {
    const viewer = rigHarness()
    viewer.setCameraRigs([specOf("overview")])
    const edits: unknown[] = []
    viewer.onCameraRigEdit = (...args: unknown[]) => edits.push(args)
    viewer.attachCameraRigGizmo("overview")
    viewer.transformControls.object = new THREE.Group()   // 挂到别的对象上（例如实体编辑）
    viewer.emitCameraRigEdit()
    expect(edits).toHaveLength(0)
    viewer.transformControls.object = viewer.cameraRigs.get("overview").group
    viewer.emitCameraRigEdit()
    expect(edits).toHaveLength(1)
  })
  it("updateCameraRig 按回执归位（不用拖拽值自行回显）：位姿换新、选中保留、键集不变", () => {
    const viewer = rigHarness()
    viewer.setCameraRigs([specOf("overview"), specOf("wrist")])
    viewer.selectCameraRig("overview")
    const updates: Array<FrustumSpec | undefined> = []
    viewer.onCameraRigSelect = (spec: FrustumSpec | undefined) => updates.push(spec)
    const moved = frustumFromReceipt({ ...receiptRow("overview"), worldFromCamera: { positionM: [5, 5, 5], quaternionXyzw: specWorld.quaternionXyzw } }) as { ok: true; spec: FrustumSpec }
    viewer.updateCameraRig(moved.spec)
    expect(viewer.cameraRigKeys().sort()).toEqual(["overview", "wrist"])
    const rig = viewer.cameraRigs.get("overview")
    expect(rig.group.position.toArray().map((v: number) => Math.round(v * 1e6) / 1e6)).toEqual([5, 5, 5])
    expect(updates.at(-1)?.key).toBe("overview")               // 选中保留（回执归位后读数卡仍是这一台）
    expect(viewer.cameraRigs.get("wrist").group).toBeDefined() // 另一台不动
  })
})

describe("覆盖与开关（判据 5 胶水面）", () => {
  it("条目数＝喂入数；重复 setCameraRigs 全量替换不残留；可见性开关生效", () => {
    const viewer = rigHarness()
    viewer.setCameraRigs([specOf("a"), specOf("b")])
    expect(viewer.cameraRigKeys().sort()).toEqual(["a", "b"])
    const firstGroup = viewer.cameraRigs.get("a").group
    viewer.setCameraRigs([specOf("c")])
    expect(viewer.cameraRigKeys()).toEqual(["c"])
    expect(firstGroup.parent).toBeNull()                      // 旧锥真的从场景图摘掉，不残留
    viewer.setCameraRigsVisible(false)
    expect(viewer.cameraRigRoot.visible).toBe(false)
    viewer.setCameraRigsVisible(true)
    expect(viewer.cameraRigRoot.visible).toBe(true)
  })
  it("选中回调带 spec、取消选中回 undefined（读数卡数据源＝FrustumSpec 本身）", () => {
    const viewer = rigHarness()
    viewer.setCameraRigs([specOf("a")])
    const updates: Array<FrustumSpec | undefined> = []
    viewer.onCameraRigSelect = (spec: FrustumSpec | undefined) => updates.push(spec)
    viewer.selectCameraRig("a")
    viewer.selectCameraRig("不存在")
    viewer.selectCameraRig(undefined)
    expect(updates.map(item => item?.key)).toEqual(["a", undefined, undefined])
  })
})

/**
 * 判据 3 的**实体归属**：两台机器人各有同名 `wrist`/`head` 时，相机必须挂到**回执说的那一个实体**上。
 *
 * 为什么单列一组：引擎报的 body 名带实体归属（MuJoCo 是 `entityId/body`；Isaac 侧 USD prim 名不能含 `/`，
 * 报出来只有局部名），而 `RobotVisual.bodyNode` 只认该实体的**局部** body 名。按全名在所有实体里搜会
 * 同时赌"名字里没有前缀"与"全局唯一"：两个机器人都叫 `head` 时轻则挂不上，重则把 A 的相机挂到 B 上。
 */
describe("判据 3（实体归属）：同名 body 各挂各的，归属不明不取第一个匹配", () => {
  const headA: RigidPose = { positionM: [0, 0, 0.3], quaternionXyzw: axisAngle([0, 0, 1], 0) }
  const headB: RigidPose = { positionM: [1.5, 0.4, 0.3], quaternionXyzw: axisAngle([0, 0, 1], 0.9) }
  const mountLocal: RigidPose = { positionM: [0.02, -0.05, 0.08], quaternionXyzw: axisAngle([1, 0, 0], 0.35) }
  const worldOf = {
    "arm-a/wrist": { positionM: [0, 0, 0.2], quaternionXyzw: axisAngle([0, 0, 1], 0) } as RigidPose,
    "arm-a/head": headA,
    "arm-b/wrist": { positionM: [1.5, 0.4, 0.2], quaternionXyzw: axisAngle([0, 0, 1], 0.9) } as RigidPose,
    "arm-b/head": headB,
    "arm-b/extra_link": { positionM: [1.62, 0.4, 0.44], quaternionXyzw: axisAngle([0, 0, 1], 0.9) } as RigidPose,
  }
  const robots = () => twoRobots(worldOf, { "arm-a": ["wrist", "head"], "arm-b": ["wrist", "head", "extra_link"] })
  /** 一台挂在自己实体 `head` 上的相机（回执行形状＝两台引擎真实回执：cameraName/entityId/parentBodyName 都带实体归属）。 */
  const headCameraRow = (entityId: string, parentBodyName: string, cameraName = `${entityId}/cam_mono`) => ({
    cameraName, entityId, parentBodyName, referenceFrame: "parent" as const,
    worldFromCamera: composePose(entityId === "arm-a" ? headA : headB, mountLocal),
    intrinsics: K, intrinsicsSource: "engine-intrinsics", override: false,
  })
  it("两台机器人同名 head：各挂自己那一个（局部安装偏移一致 ⇒ 没有跨挂）", () => {
    const { nodes, visuals } = robots()
    const viewer = rigHarness()
    viewer.objects = visuals
    viewer.setCameraRigs([specOfRow(headCameraRow("arm-a", "arm-a/head")), specOfRow(headCameraRow("arm-b", "arm-b/head"))])
    for (const [entityId, local] of [["arm-a", mountLocal], ["arm-b", mountLocal]] as const) {
      const rig = viewer.cameraRigs.get(`${entityId}/cam_mono`)
      expect(rig.group.parent).toBe(nodes.get(entityId)!.get("head"))   // 挂到**自己**实体的 head 下
      expect(rig.group.userData.mountedEntityId).toBe(entityId)
      expect(rig.group.userData.mountedTo).toBe(`${entityId}/head`)
      const local3 = rig.group.position.toArray().map((value: number) => Math.round(value * 1e9) / 1e9)
      expect(local3).toEqual(local.positionM)                            // 局部安装偏移＝声明值（两台一致）
      // 世界位姿＝该实体 head 的 FK ∘ 安装偏移 ⇒ 与引擎回执的 worldFromCamera 一致
      const world = new THREE.Vector3(), rotation = new THREE.Quaternion()
      rig.group.getWorldPosition(world); rig.group.getWorldQuaternion(rotation)
      const receipt = headCameraRow(entityId, `${entityId}/head`).worldFromCamera
      receipt.positionM.forEach((value, index) => expect(Math.abs(world.toArray()[index]! - value)).toBeLessThan(1e-9))
      // 夹角走 acos：|dot| 的 1e-16 级扰动会被放大成 ~1e-8 rad ≈ 1e-6°，所以这里取 1e-4°——
      // 真正的跨挂（挂到另一台机器人的 head 上）差的是**几十度**，这个阈值挡得住，也不能再紧了。
      expect(quaternionAngleDeg(rotation.toArray() as ViewerQuat, receipt.quaternionXyzw)).toBeLessThan(1e-4)
    }
  })
  it("父体 FK 变化：A 的视锥跟着 A 的 head 走，B 的一点不动（隔离）", () => {
    const { nodes, visuals } = robots()
    const viewer = rigHarness()
    viewer.objects = visuals
    viewer.setCameraRigs([specOfRow(headCameraRow("arm-a", "arm-a/head")), specOfRow(headCameraRow("arm-b", "arm-b/head"))])
    const worldOfRig = (key: string) => {
      const rig = viewer.cameraRigs.get(key), position = new THREE.Vector3(), rotation = new THREE.Quaternion()
      rig.group.updateWorldMatrix(true, false); rig.group.getWorldPosition(position); rig.group.getWorldQuaternion(rotation)
      return { positionM: position.toArray() as ViewerVec3, quaternionXyzw: rotation.toArray() as ViewerQuat }
    }
    const beforeB = worldOfRig("arm-b/cam_mono")
    // A 的 head 被 FK 带到新位姿（例如关节运动后）：只改场景图里的 body 节点，视锥不该被逐帧重算。
    const movedHead: RigidPose = { positionM: [0.35, -0.2, 0.62], quaternionXyzw: axisAngle([1, 0.4, 0], 1.2) }
    const nodeA = nodes.get("arm-a")!.get("head")!
    nodeA.position.set(...movedHead.positionM); nodeA.quaternion.copy(quat(movedHead.quaternionXyzw)); nodeA.updateWorldMatrix(true, false)
    const afterA = worldOfRig("arm-a/cam_mono")
    const expected = composePose(movedHead, mountLocal)
    expected.positionM.forEach((value, index) => expect(Math.abs(afterA.positionM[index]! - value)).toBeLessThan(1e-9))
    expect(quaternionAngleDeg(afterA.quaternionXyzw, expected.quaternionXyzw)).toBeLessThan(1e-4)
    expect(worldOfRig("arm-b/cam_mono")).toEqual(beforeB)   // B 不受 A 的运动影响
  })
  it("归属不明（相机名无实体前缀、body 名在两台机器人里同形）⇒ 静态＋原因，绝不取第一个匹配", () => {
    const { visuals } = robots()
    const viewer = rigHarness()
    viewer.objects = visuals
    viewer.setCameraRigs([specOfRow({ ...headCameraRow("arm-a", "head", "cam_free"), entityId: undefined })])
    const rig = viewer.cameraRigs.get("cam_free")
    expect(rig.group.parent).toBe(viewer.cameraRigRoot)                       // 没有硬凑挂载
    expect(rig.group.userData.mountMissing).toBe("head")
    expect(String(rig.group.userData.mountMissingReason)).toContain("拒绝取第一个匹配")
  })
  it("回执说的实体里没有这个 body ⇒ 静态（不落到另一实体的同名/同类 body 上）", () => {
    const { nodes, visuals } = robots()
    const viewer = rigHarness()
    viewer.objects = visuals
    // arm-b 有 extra_link、arm-a 没有：归属是 arm-a ⇒ 必须保持静态，不能被全局搜到 arm-b 上。
    viewer.setCameraRigs([specOfRow(headCameraRow("arm-a", "arm-a/extra_link"))])
    expect(nodes.get("arm-b")!.get("extra_link")).toBeDefined()               // 负对照：全局搜确实能找到它
    const rig = viewer.cameraRigs.get("arm-a/cam_mono")
    expect(rig.group.parent).toBe(viewer.cameraRigRoot)
    // 原因里点名的是**回执说的那个实体**（先定归属、再局部化，没落到 arm-b 的 extra_link 上）。
    expect(String(rig.group.userData.mountMissingReason)).toContain("实体 arm-a 没有 body「extra_link」")
  })
  it("worldbody 上的相机（parentBodyName='world'）不挂任何 body：静态＋原因", () => {
    const { visuals } = robots()
    const viewer = rigHarness()
    viewer.objects = visuals
    viewer.setCameraRigs([specOfRow({ ...headCameraRow("arm-a", "world", "overview") })])
    const rig = viewer.cameraRigs.get("overview")
    expect(rig.group.parent).toBe(viewer.cameraRigRoot)
    expect(String(rig.group.userData.mountMissingReason)).toContain("worldbody")
  })
})
