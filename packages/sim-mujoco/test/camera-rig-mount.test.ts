/**
 * MuJoCo 相机回执的**实体归属**：两台机器人各有同名 `head` 时，视锥必须各挂各的（判据 3 端到端）。
 *
 * 为什么需要这一条（不是重复 `packages/viewer/test/camera-rig-view.test.ts`）：那边的回执形状是
 * fixture 造的；这里跑的是**真 MuJoCo**（`MuJoCoProvider.open → listCameras`）交出来的回执行——
 * `cameraName`/`entityId` 带实体前缀、`parentBodyName` 是引擎里的**限定** body 名（`arm-a/head`），
 * 而 `worldFromCamera.positionM` 是按 **JSON 里声明的那串 body 几何手算出来**的独立期望值（不读引擎的
 * body 位姿），于是"这台回执确实属于这个实体的这个 body"是量出来的，不是假设的。再往下接
 * `frustumFromReceipt` + 真 `SceneViewer.setCameraRigs`：视锥挂在**自己**实体的 `head` 节点下，
 * 世界位姿＝body FK ∘ 安装偏移与回执闭合，绝不落到另一台机器人的同名 `head` 上。
 *
 * 运行：`bun test packages/sim-mujoco/test/camera-rig-mount.test.ts`
 * 解释器：`LYAPUNOV_MUJOCO_PYTHON`（未设时用仓库内 `.runtime/sim-python/bin/python`）；没有解释器时
 * 整份显式 skip 并说明原因，不假装通过（Isaac 侧的等价路径见回执的"未验证项"）。
 *
 * 边界（不冒充已完成）：本文件的自有场景是**最小合成件**（几何已知，便于手算），不含用户真实资产；
 * 真实资产上的同名 body 归属由模型侧验收。这里没有浏览器/WebGL：视锥挂载量的是场景图归属与世界位姿闭合。
 */
import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import * as THREE from "three"
import { MuJoCoProvider } from "../src/provider.ts"
import { SceneViewer } from "../../viewer/src/index.ts"
import { frustumFromReceipt, type FrustumSpec } from "../../viewer/src/camera-frustum.ts"
import { quaternionAngleDeg, type ViewerQuat, type ViewerVec3 } from "../../viewer/src/camera-view.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const python = process.env.LYAPUNOV_MUJOCO_PYTHON ?? resolve(root, ".runtime/sim-python/bin/python")
const available = existsSync(python)
const outDir = resolve(tmpdir(), `camera-rig-mount-${process.pid}`)
afterAll(() => rmSync(outDir, { recursive: true, force: true }))

/** 两台**结构完全相同**的机器人：`head` 挂在 `wrist` 下，相机装在 `head` 上（同名 body、同名相机）。 */
const WRIST_Z = 0.4, HEAD_Z = 0.4
const CAM_LOCAL: ViewerVec3 = [0.05, -0.08, 0.02]
const robotXml = () => '<mujoco><worldbody>'
  + `<body name="wrist" pos="0 0 ${WRIST_Z}"><geom name="wrist_geom" type="box" size="0.05 0.05 0.2"/>`
  + `<body name="head" pos="0 0 ${HEAD_Z}"><geom name="head_geom" type="box" size="0.06 0.06 0.06"/>`
  + `<camera name="cam_mono" pos="${CAM_LOCAL.join(" ")}" fovy="45"/></body></body>`
  + '</worldbody></mujoco>'
/** 两个实体的世界位置不同 ⇒ 同一台 `cam_mono` 的期望世界位置必须不同（同一个回执抄两遍就会露馅）。 */
const ARMS: Record<string, ViewerVec3> = { "arm-a": [0, 0, 0], "arm-b": [1.2, 0.3, 0] }
/** 手算期望：body 链是纯平移（MJCF 里没写朝向）⇒ head 世界 = 实体世界 + (0,0,WRIST_Z+HEAD_Z)。 */
const expectedHeadWorld = (entityId: string): ViewerVec3 => [ARMS[entityId]![0], ARMS[entityId]![1], ARMS[entityId]![2] + WRIST_Z + HEAD_Z]
const expectedCameraWorld = (entityId: string): ViewerVec3 => {
  const head = expectedHeadWorld(entityId)
  return [head[0] + CAM_LOCAL[0], head[1] + CAM_LOCAL[1], head[2] + CAM_LOCAL[2]]
}
const snapshot = () => ({
  sceneId: "camera-rig-mount", revision: 1,
  coordinates: { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" } as const,
  entities: Object.entries(ARMS).map(([entityId, position]) => ({
    entityId, name: entityId,
    transform: { position, quaternion: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] },
    resources: [],
    components: { mujoco: { xml: robotXml() } },
  })),
})
const specOf = (row: Record<string, unknown>): FrustumSpec => {
  const result = frustumFromReceipt(row, { source: "engine" })
  if (!result.ok) throw new Error(`回执行不该被拒: ${result.unavailable}`)
  return result.spec
}
const near = (actual: readonly number[], expected: readonly number[], tolerance = 1e-6) =>
  Math.max(...actual.map((value, index) => Math.abs(value - expected[index]!))) <= tolerance
/** `expect(near(...)).toBe(true)` 失败时看不出差在哪，这里直接把两组数写进错误里。 */
function expectNear(actual: readonly number[], expected: readonly number[], label: string, tolerance = 1e-6): void {
  if (near(actual, expected, tolerance)) return
  throw new Error(`${label} 不闭合：实测 [${actual.join(", ")}] vs 期望 [${expected.join(", ")}]（容差 ${tolerance}）`)
}
/** 只留视锥挂载用得到的缝（与 `packages/viewer/test/camera-rig-view.test.ts` 的 `rigHarness` 同一手法）。 */
function viewerHarness(headWorld: Record<string, ViewerVec3>) {
  const viewer: any = Object.create(SceneViewer.prototype)
  viewer.scene = new THREE.Scene()
  viewer.cameraRigs = new Map()
  viewer.cameraRigRoot = new THREE.Group()
  viewer.transformControls = { object: undefined, attach(object: THREE.Object3D) { this.object = object }, detach() { this.object = undefined } }
  const heads = new Map<string, THREE.Object3D>()
  viewer.objects = new Map(Object.keys(headWorld).map(entityId => {
    const head = new THREE.Object3D()
    head.position.set(...headWorld[entityId]!)
    head.updateWorldMatrix(true, false)
    heads.set(entityId, head)
    // `RobotVisual.bodyNode` 只认**本实体的局部** body 名（与产品一致：`bodies.set(item.name)`）。
    const bodies = new Map([["wrist", new THREE.Object3D()], ["head", head]])
    return [entityId, { group: new THREE.Group(), robot: { bodyNode: (name: string) => bodies.get(name) } }]
  }))
  return { viewer, heads }
}

describe.skipIf(!available)(`MuJoCo 相机回执 → viewer 挂载（判据 3 端到端）${available ? "" : ` [解释器不存在: ${python}]`}`, () => {
  it("两台机器人的回执各带实体归属：同名相机/同名 body，世界位置＝各自实体手算值", async () => {
    mkdirSync(outDir, { recursive: true })
    const provider = new MuJoCoProvider({ pythonPath: python })
    const handle = await provider.open(snapshot() as never, { ground: false, worldId: "camera-rig-mount" })
    try {
      const list = await provider.listCameras(handle.worldId) as { cameras: Array<Record<string, any>> }
      expect(list.cameras.map(camera => camera.cameraName).sort()).toEqual(["arm-a/cam_mono", "arm-b/cam_mono"])
      for (const entityId of ["arm-a", "arm-b"] as const) {
        const row = list.cameras.find(camera => camera.cameraName === `${entityId}/cam_mono`)!
        expect(row.entityId).toBe(entityId)
        expect(row.localName).toBe("cam_mono")
        // 缺陷前置条件：两个实体里的 body 局部同名（`head`），引擎报的是**限定**名。
        expect(row.parentBodyName).toBe(`${entityId}/head`)
        // 世界位置＝按 JSON 里声明的 body 链手算出来的期望（不读引擎的 body 位姿）：这条同时证明
        // "这份回执属于这个实体的这个 body"，而不是同一台相机被抄了两遍。
        expectNear(row.worldFromCamera.positionM, expectedCameraWorld(entityId), `${entityId}/cam_mono 世界位置`)
      }
      // 负对照：两个实体的期望世界位置本来就不一样（否则上面的断言区分不了两台）。
      expect(near(expectedCameraWorld("arm-a"), expectedCameraWorld("arm-b"))).toBe(false)
    } finally {
      await provider.close(handle.worldId).catch(() => {})
      await provider.dispose()
    }
  }, 60000)

  it("视锥各挂各的：挂在自己实体的 head 下，世界位姿与回执闭合，绝不落到另一台上", async () => {
    mkdirSync(outDir, { recursive: true })
    const provider = new MuJoCoProvider({ pythonPath: python })
    const handle = await provider.open(snapshot() as never, { ground: false, worldId: "camera-rig-mount" })
    try {
      const list = await provider.listCameras(handle.worldId) as { cameras: Array<Record<string, any>> }
      const rows = Object.fromEntries(list.cameras.map(row => [row.cameraName, row]))
      const { viewer, heads } = viewerHarness(Object.fromEntries(Object.keys(ARMS).map(entityId => [entityId, expectedHeadWorld(entityId)])))
      viewer.setCameraRigs([specOf(rows["arm-a/cam_mono"]!), specOf(rows["arm-b/cam_mono"]!)])
      expect(viewer.cameraRigKeys().sort()).toEqual(["arm-a/cam_mono", "arm-b/cam_mono"])
      for (const entityId of ["arm-a", "arm-b"] as const) {
        const other = entityId === "arm-a" ? "arm-b" : "arm-a"
        const rig = viewer.cameraRigs.get(`${entityId}/cam_mono`)
        expect(rig.group.parent).toBe(heads.get(entityId))       // 自己的 head
        expect(rig.group.parent).not.toBe(heads.get(other))      // 不是另一台的 head
        expect(rig.group.userData.mountedEntityId).toBe(entityId)
        expect(rig.group.userData.mountedTo).toBe(`${entityId}/head`)
        expect(rig.group.userData.mountMissing).toBeUndefined()
        // 世界位姿＝本实体 head 的 FK ∘ 引擎回执推出的安装偏移 ⇒ 与**引擎回执**闭合（≤1e-6）。
        rig.group.updateWorldMatrix(true, false)
        const position = new THREE.Vector3(), quaternion = new THREE.Quaternion()
        rig.group.getWorldPosition(position); rig.group.getWorldQuaternion(quaternion)
        const receipt = rows[`${entityId}/cam_mono`]!.worldFromCamera as { positionM: number[] }
        expectNear(position.toArray(), receipt.positionM, `${entityId}/cam_mono 视锥世界位置`)
        const local = rig.group.position.toArray()
        expectNear([local[0]!, local[1]!, local[2]!], CAM_LOCAL, `${entityId}/cam_mono 局部安装偏移`)
        // 朝向也闭合：回执给的是旋转矩阵，视锥是场景图复合出来的四元数，两条路必须落到同一个姿态。
        expect(quaternionAngleDeg(quaternion.toArray() as ViewerQuat, specOf(rows[`${entityId}/cam_mono`]!).quaternionXyzw)).toBeLessThan(1e-4)
      }
    } finally {
      await provider.close(handle.worldId).catch(() => {})
      await provider.dispose()
    }
  }, 60000)

  it("负对照：回执丢了实体归属（裸相机名 + 裸 body 名）⇒ 静态＋原因，绝不取第一个匹配", async () => {
    mkdirSync(outDir, { recursive: true })
    const provider = new MuJoCoProvider({ pythonPath: python })
    const handle = await provider.open(snapshot() as never, { ground: false, worldId: "camera-rig-mount" })
    try {
      const list = await provider.listCameras(handle.worldId) as { cameras: Array<Record<string, any>> }
      const row = list.cameras.find(camera => camera.cameraName === "arm-a/cam_mono")!
      // 模拟"没有实体前缀"的旧形状：裸相机名 + 裸 body 名 —— 两个实体里都有 `head`。
      const ambiguous = { ...row, cameraName: "cam_mono", entityId: undefined, parentEntityId: undefined, parentBodyName: "head" }
      const { viewer, heads } = viewerHarness(Object.fromEntries(Object.keys(ARMS).map(entityId => [entityId, expectedHeadWorld(entityId)])))
      viewer.setCameraRigs([specOf(ambiguous)])
      const rig = viewer.cameraRigs.get("cam_mono")
      expect(rig.group.parent).toBe(viewer.cameraRigRoot)
      expect(rig.group.parent).not.toBe(heads.get("arm-a"))
      expect(rig.group.parent).not.toBe(heads.get("arm-b"))
      expect(rig.group.userData.mountMissing).toBe("head")
      expect(String(rig.group.userData.mountMissingReason)).toContain("拒绝取第一个匹配")
    } finally {
      await provider.close(handle.worldId).catch(() => {})
      await provider.dispose()
    }
  }, 60000)
})
