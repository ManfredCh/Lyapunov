/**
 * DEV-034 机位：**初始机位不得被巨大地面/隐藏碰撞几何拉远**（任务主体不被缩成小点）。
 *
 * 这条链的两端都在本文件里钉住，而且是同一条链：
 *  ① **Viewer 侧复算（只读，跑真实 `packages/viewer/src/framing.ts`）**：官方 LIBERO 形状的场景里量三次取景——
 *     · 最原始（N9 之前）：`objectWorldBounds(root, splat, false)`＝`Box3.setFromObject` 把**一切**算进包围盒
 *       （含 1000 m 的 MJCF 无限地面与 `visible=false` 的 120 m 碰撞盒）；
 *     · 改前（N9 之后、R19 之前）：平面与隐藏层已排除，但**巨大可见几何**（9.5×9.0 m 底板 + 6 m 房间的四道
 *       3 m 墙）仍被逐实体 `autoFrame=true` 的组内兜底漏进并集 ⇒ 这就是 R18 真机量到的 17.0 m / 主体 3.2 px；
 *     · 改后（R19）：只并**任务主体实体**的可见有限几何，且不借组内兜底（`allowOversizedFallback=false`）。
 *  ② **shell 侧判据（`workbench-camera.ts` 新增）**：拿①量出来的**取景读数**＋逐实体可见有限几何，判"这份
 *     初始取景还能不能当初始机位"；被拉远就给兜底机位（**只改位置、不动姿态**）。判据与兜底都交给**真实**
 *     `normalizeCameraRequest` 复核（target 必须在视线上、roll 由 cameraUp 原样带走）。
 *
 * 为什么两半都要：光有①不覆盖"别的取景入口把非主体几何并进来"（`focus(entityId)` 仍按 `setFromObject` 取盒）；
 * 光有②没有①的读数就没有可核对的量。最要紧的一条断言是**两侧同一个数**：②的兜底距离 = ①改后的真实机位
 * （两侧用的是同一个 `k = distance / radius`）。
 *
 * 运行：`bun test packages/lyapunov-shell/test/workbench-camera-initial-framing.test.ts`
 */
import { describe, expect, test } from "bun:test"
import * as THREE from "three"

import { fitPerspectiveBounds, objectWorldBounds } from "../../viewer/src/framing.ts"
import { normalizeCameraRequest } from "../../viewer/src/camera-view.ts"
import {
  enforceInitialFraming, initialFramingVerdict, INITIAL_FRAMING_SUBJECT_RATIO_MAX,
  type FramingBounds, type FramingGeometryReading, type FramingReadout,
} from "../src/workbench-camera.ts"

/** R17 真机大画布（876×786）与 Viewer 出厂视场角（`PerspectiveCamera(50,1,0.01,10000)`）。 */
const CANVAS = { width: 876, height: 786 }
const FOV_Y_DEG = 50
const DEG = Math.PI / 180

const boxOf = (box: THREE.Box3): FramingBounds => ({ min: box.min.toArray() as [number, number, number], max: box.max.toArray() as [number, number, number] })
const sizeOf = (bounds: FramingBounds): [number, number, number] => [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]]
/** 与 `SceneViewer.diagnostics.framing` 同一映射（`center` 摊平成数组）。 */
const readoutOf = (fitted: NonNullable<ReturnType<typeof fitPerspectiveBounds>>): FramingReadout => ({
  center: fitted.center.toArray() as [number, number, number], radius: fitted.radius, distance: fitted.distance, bounds: fitted.bounds as FramingBounds,
})
/** 某尺寸的物体在给定机位距离下的**像素高度**（针孔 + 垂直视场角）；786 px 画布、50° 与 R18 真机同口径。 */
const pixelHeight = (sizeM: number, distanceM: number): number => sizeM * CANVAS.height / (2 * distanceM * Math.tan(FOV_Y_DEG / 2 * DEG))

/**
 * 官方 LIBERO 形状的场景：MJCF 无限地面（PlaneGeometry）+ 隐藏碰撞盒（120 m, visible=false）+
 * 官方 world body（9.5×9.0 m 底板 + 6 m 房间的四道 3 m 墙，全部可见）+ 机械臂（0.9 m，articulation）
 * + 7 个被操作物与 1 个篮子（5–20 cm，任务主体）。
 */
function liberoLikeScene() {
  const root = new THREE.Group()
  const box = (name: string, size: [number, number, number], at: [number, number, number], parent: THREE.Object3D = root) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), new THREE.MeshBasicMaterial())
    mesh.name = name
    mesh.position.set(...at)
    parent.add(mesh)
    return mesh
  }
  // ① MJCF 无限地面：`framing.ts` 按图元类型（PlaneGeometry）排除，不是按尺寸
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), new THREE.MeshBasicMaterial())
  ground.name = "ground"
  root.add(ground)
  // ② 隐藏的碰撞几何：可见性为 false，尺寸 120 m
  const collision = box("collision", [120, 120, 2], [0, 0, -1])
  collision.visible = false
  // ③ 官方 world body：可见的大几何（底板 9.5×9.0，四道 6 m 长 3 m 高的墙）
  const worldBody = new THREE.Group()
  worldBody.name = "official-worldbody"
  root.add(worldBody)
  box("floor-slab", [9.5, 9.0, 0.04], [0, 0, -0.02], worldBody)
  box("wall-x+", [0.1, 6, 3], [3, 0, 1.5], worldBody)
  box("wall-x-", [0.1, 6, 3], [-3, 0, 1.5], worldBody)
  box("wall-y+", [6, 0.1, 3], [0, 3, 1.5], worldBody)
  box("wall-y-", [6, 0.1, 3], [0, -3, 1.5], worldBody)
  // ④ 机器人：0.9 m 的整臂（场景文档里有 `articulation` ⇒ **不是**任务主体）
  const robot = new THREE.Group()
  robot.name = "official-robot"
  root.add(robot)
  box("arm", [0.12, 0.12, 0.9], [0, 0, 0.45], robot)
  // ⑤ 任务主体：篮子 + 7 个物体（罐头/纸盒，5–20 cm）
  const subjects = new Map<string, THREE.Group>()
  const subject = (id: string, size: [number, number, number], at: [number, number, number]) => {
    const group = new THREE.Group()
    group.name = id
    root.add(group)
    box(id, size, at, group)
    subjects.set(id, group)
  }
  subject("basket_1", [0.2, 0.2, 0.12], [0.55, -0.15, 0.06])
  subject("alphabet_soup_1", [0.065, 0.065, 0.1], [-0.5, -0.35, 0.05])
  subject("milk_1", [0.07, 0.07, 0.17], [-0.2, -0.2, 0.085])
  subject("salad_dressing_1", [0.06, 0.06, 0.15], [0.05, -0.3, 0.075])
  subject("cream_cheese_1", [0.09, 0.05, 0.03], [0.2, 0.1, 0.015])
  subject("tomato_sauce_1", [0.065, 0.065, 0.13], [0.35, -0.05, 0.065])
  subject("butter_1", [0.12, 0.04, 0.03], [0.45, 0.25, 0.015])
  subject("ketchup_1", [0.06, 0.06, 0.19], [-0.35, 0.2, 0.095])
  return { root, subjects, robot, ground, collision, worldBody }
}

/** 用一支一次性相机量一次取景（`fitPerspectiveBounds` 会改相机，所以每次新建）。 */
function framingOf(box: THREE.Box3): NonNullable<ReturnType<typeof fitPerspectiveBounds>> {
  const fitted = fitPerspectiveBounds(new THREE.PerspectiveCamera(FOV_Y_DEG, CANVAS.width / CANVAS.height, 0.01, 10000), box)
  if (!fitted) throw new Error("取景框为空：夹具不成立")
  return fitted
}

// ── 夹具读数（全部由真实 `framing.ts` 算出，两段 describe 共用）─────────────────
const scene = liberoLikeScene()
const splat = new WeakMap<THREE.Object3D, THREE.Box3>()
const unionOf = (groups: readonly THREE.Object3D[], autoFrame: boolean, allowOversizedFallback = true): THREE.Box3 => {
  const box = new THREE.Box3()
  for (const group of groups) box.union(objectWorldBounds(group, splat, autoFrame, allowOversizedFallback))
  return box
}
/** 最原始（N9 之前）：`setFromObject` 语义。 */
const rawFraming = framingOf(objectWorldBounds(scene.root, splat, false))
/** 改前（N9 之后、R19 之前）：平面与隐藏层已排除，但超大可见几何借组内兜底进并集。 */
const preFixFraming = framingOf(unionOf([scene.ground, scene.collision, scene.worldBody, scene.robot, ...scene.subjects.values()], true))
/** 改后（R19）：只并任务主体实体的可见有限几何、不借组内兜底。 */
const postFixBox = unionOf([...scene.subjects.values()], true, false)
const postFixFraming = framingOf(postFixBox)
/** shell 侧事实：与产品同一份（实体 id / 是否主体 / 是否可见 / 世界包围盒）。 */
const geometry: FramingGeometryReading[] = [
  ...[...scene.subjects.entries()].map(([entityId, group]) => ({ entityId, subject: true, visible: true, bounds: boxOf(objectWorldBounds(group, splat, true, false)) })),
  { entityId: "official-robot", subject: false, visible: true, bounds: boxOf(objectWorldBounds(scene.robot, splat, true, false)) },
  { entityId: "official-worldbody", subject: false, visible: true, bounds: boxOf(objectWorldBounds(scene.worldBody, splat, true, false)) },
  { entityId: "ground", subject: false, visible: true, bounds: boxOf(objectWorldBounds(scene.ground, splat, true, false)) },
  { entityId: "collision", subject: true, visible: false, bounds: { min: [-60, -60, -2], max: [60, 60, 0] } },
]
const preFixReadout = readoutOf(preFixFraming)
const postFixReadout = readoutOf(postFixFraming)
/** 夹具的"主体球半径"（八个主体实体的可见有限几何并集；与 `frameAll()` 的并集是同一支）。 */
const SUBJECT_RADIUS_M = postFixFraming.radius
/** 主体并集的中心（兜底机位的转心；与并集盒同源）。 */
const SUBJECT_CENTER: [number, number, number] = [(postFixReadout.bounds.min[0] + postFixReadout.bounds.max[0]) / 2, (postFixReadout.bounds.min[1] + postFixReadout.bounds.max[1]) / 2, (postFixReadout.bounds.min[2] + postFixReadout.bounds.max[2]) / 2]
/** 逐分量比对（`normalizeCameraRequest` 会把四元数归一化，末位必然有浮点噪声）。 */
const expectVecClose = (actual: readonly number[], expected: readonly number[], precision = 12): void => {
  expect(actual).toHaveLength(expected.length)
  for (const [index, value] of expected.entries()) expect(actual[index]).toBeCloseTo(value, precision)
}

describe("DEV-034 ① Viewer 侧复算：最原始 / 改前（N9 后）/ 改后（R19）", () => {
  test("最原始：1000 m 地面与隐藏碰撞盒都进包围盒（机位被拉到 1.8 km）", () => {
    const size = sizeOf(readoutOf(rawFraming).bounds)
    expect(size[0]).toBeCloseTo(1000, 6)
    expect(size[1]).toBeCloseTo(1000, 6)
    expect(rawFraming.radius).toBeGreaterThan(700)
    expect(rawFraming.distance).toBeGreaterThan(1800)
    console.log(`[最原始] 包围盒=${size.map(value => value.toFixed(2)).join("×")} m · radius=${rawFraming.radius.toFixed(3)} m · 机位=${rawFraming.distance.toFixed(3)} m · 6.5 cm 主体 ${pixelHeight(0.065, rawFraming.distance).toFixed(3)} px`)
  })

  test("改前（N9 后）：平面与隐藏层已排除，但 9.5×9.0 m 的可见墙面/底板仍把机位拉到 R18 真机那一档", () => {
    const size = sizeOf(preFixReadout.bounds)
    expect(preFixReadout.radius).toBeGreaterThan(6)      // R18 真机量到 6.54 m
    expect(preFixReadout.distance).toBeGreaterThan(16)   // R18 真机量到 17.0 m
    expect(preFixReadout.distance).toBeLessThan(20)
    const can = pixelHeight(0.065, preFixReadout.distance)
    expect(can).toBeGreaterThan(2)
    expect(can).toBeLessThan(4)                          // R18 真机：6.5 cm 罐头 ≈ 3.2 px
    console.log(`[改前] 包围盒=${size.map(value => value.toFixed(2)).join("×")} m · radius=${preFixReadout.radius.toFixed(3)} m · 机位=${preFixReadout.distance.toFixed(3)} m · 6.5 cm 主体 ${can.toFixed(2)} px`)
  })

  test("改后（R19）：只收可见的主体几何 ⇒ 同一主体从 3 px 变成 30+ px", () => {
    const size = sizeOf(postFixReadout.bounds)
    expect(postFixReadout.radius).toBeLessThan(1)        // 主体量级
    expect(postFixReadout.distance).toBeLessThan(2)
    const can = pixelHeight(0.065, postFixReadout.distance)
    expect(can).toBeGreaterThan(20)                      // R18 真机：29–102 px
    console.log(`[改后] 包围盒=${size.map(value => value.toFixed(2)).join("×")} m · radius=${postFixReadout.radius.toFixed(3)} m · 机位=${postFixReadout.distance.toFixed(3)} m · 6.5 cm 主体 ${can.toFixed(2)} px`)
  })

  test("负对照：隐藏碰撞几何与无限地面在『改后』语义里确实不进包围盒（同一份几何在『最原始』里确实进了）", () => {
    expect(objectWorldBounds(scene.root, splat, false).containsPoint(new THREE.Vector3(0, 0, -1))).toBe(true)  // 隐藏碰撞盒中心
    expect(objectWorldBounds(scene.ground, splat, true, false).isEmpty()).toBe(true)    // 无限地面：按图元类型排除
    expect(objectWorldBounds(scene.collision, splat, true, false).isEmpty()).toBe(true) // 隐藏层：traverseVisible 排除
    expect(objectWorldBounds(scene.worldBody, splat, true, false).isEmpty()).toBe(true) // 全场都是超大可见几何：不借兜底
  })
})

describe("DEV-034 ② shell 侧初始机位判据与兜底机位（`workbench-camera.ts`）", () => {
  test("同一份读数：改前的取景被判『拉远』，改后的取景被判『主体量级』", () => {
    const polluted = initialFramingVerdict({ framing: preFixReadout, geometry })
    const clean = initialFramingVerdict({ framing: postFixReadout, geometry })
    expect(polluted.status).toBe("pulled-away")
    expect(clean.status).toBe("subject-scale")
    if (polluted.status !== "pulled-away" || clean.status !== "subject-scale") throw new Error("unreachable")
    expect(polluted.subjectRadiusM).toBeCloseTo(SUBJECT_RADIUS_M, 9)
    expect(polluted.ratio).toBeGreaterThan(5)
    expect(clean.ratio).toBeCloseTo(1, 9)
    expect(polluted.subjectEntityIds).toHaveLength(8)
    expect(polluted.excluded).toEqual([
      { entityId: "official-robot", why: "not-subject" },
      { entityId: "official-worldbody", why: "not-subject" },
      { entityId: "ground", why: "not-subject" },
      { entityId: "collision", why: "hidden" },
    ])
    // **两侧同一个数**：②的兜底距离（只从读数算）= ①改后的真实机位（Viewer 过滤后拟合出来的）
    expect(polluted.correctedDistanceM).toBeCloseTo(postFixReadout.distance, 9)
    console.log(`[判据] 改前：取景球 ${preFixReadout.radius.toFixed(3)} m / 主体球 ${SUBJECT_RADIUS_M.toFixed(3)} m = ${polluted.ratio.toFixed(2)} 倍 ⇒ 兜底机位 ${polluted.correctedDistanceM.toFixed(3)} m（= 改后真实机位 ${postFixReadout.distance.toFixed(3)} m）`)
  })

  test("兜底机位交给真实 `normalizeCameraRequest` 复核：target 严格在视线上、姿态与 cameraUp 自洽、roll 不变", () => {
    const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0.3, 0.2, 0.1).normalize(), 0.6).toArray() as [number, number, number, number]
    const camera = { position: preFixFraming.center.clone().add(new THREE.Vector3(1, -1.4, 0.9).normalize().multiplyScalar(preFixFraming.distance)).toArray() as [number, number, number], quaternion, target: preFixFraming.center.toArray() as [number, number, number] }
    const verdict = initialFramingVerdict({ framing: preFixReadout, geometry, camera })
    if (verdict.status !== "pulled-away" || !verdict.request) throw new Error(`应判拉远并给出兜底机位，实际 ${verdict.status}`)
    const view = normalizeCameraRequest(verdict.request, { fovYDeg: FOV_Y_DEG, near: 0.01, far: 10000 })
    expect(view.orientationSource).toBe("quaternion")
    expectVecClose(view.position, verdict.request.position as number[], 12)
    expectVecClose(view.quaternion, quaternion, 12)                                    // 姿态一字不改（只差归一化的末位噪声）
    expectVecClose(view.cameraUp, verdict.request.cameraUp as number[], 12)
    expect(view.notes.filter(note => note.includes("相差"))).toEqual([])                // 0.5° 容差内：没有"target 不在视线上"的余地
    // target 与视线同轴 ⇒ 距离就是兜底距离
    expect(Math.hypot(...view.target.map((value, axis) => value - view.position[axis]) as [number, number, number])).toBeCloseTo(verdict.correctedDistanceM, 9)
    console.log(`[兜底] 机位 ${preFixReadout.distance.toFixed(3)} m → ${verdict.correctedDistanceM.toFixed(3)} m · 姿态 roll 读数 ${view.rollDeg.toFixed(3)}° · target=主体中心`)
  })

  test("enforceInitialFraming：真的把相机前移到主体上，回执同时给『改前』与量到的『改后』", () => {
    const { window, state, applied } = fakeWindow([...SUBJECT_CENTER])
    const receipt = enforceInitialFraming({ clientId: "window-cam1", viewerVisible: true, viewer: window, sceneId: "libero_object-pick_up", expectedRevision: 1, displayed: { sceneId: "libero_object-pick_up", revision: 1 }, readFraming: () => preFixReadout, geometry })
    expect(receipt).toMatchObject({ applied: true, status: "pulled-away" })
    expect(receipt.before?.framingRadiusM).toBeCloseTo(preFixReadout.radius, 9)
    expect(receipt.before?.framingDistanceM).toBeCloseTo(preFixReadout.distance, 9)
    expect(receipt.before?.subjectRadiusM).toBeCloseTo(SUBJECT_RADIUS_M, 9)
    expect(receipt.before?.ratio).toBeCloseTo(preFixReadout.radius / SUBJECT_RADIUS_M, 9)
    expect(applied).toHaveLength(1)
    expect(receipt.distanceM).toBeCloseTo(postFixReadout.distance, 6)     // **量到的**机位距离（不是"请求了什么"）
    expect(Math.hypot(state.position[0] - SUBJECT_CENTER[0], state.position[1] - SUBJECT_CENTER[1], state.position[2] - SUBJECT_CENTER[2])).toBeCloseTo(receipt.distanceM!, 6)
    expectVecClose(state.target, SUBJECT_CENTER, 12)                      // 转心落在主体并集中心
  })

  test("取景已是主体量级：一个字节都不动（applied=false，相机没被 apply 过一次）", () => {
    const { window, applied } = fakeWindow([...SUBJECT_CENTER])
    const receipt = enforceInitialFraming({ clientId: "window-cam1", viewerVisible: true, viewer: window, sceneId: "s", expectedRevision: 1, displayed: { sceneId: "s", revision: 1 }, readFraming: () => postFixReadout, geometry })
    expect(receipt).toMatchObject({ applied: false, status: "subject-scale" })
    expect(applied).toEqual([])
    expect(receipt.distanceM).toBe(postFixReadout.distance)
  })

  test("判不了就判不了：没有取景读数 / 没有可见主体 / 读数不成立 / 缺相机姿态，一律不动机位且带原因", () => {
    const { window, applied } = fakeWindow([0, 0, 0])
    const base = { clientId: "window-cam1", viewerVisible: true, viewer: window, sceneId: "s", expectedRevision: 1, displayed: { sceneId: "s", revision: 1 } }
    const noReadout = enforceInitialFraming({ ...base, readFraming: () => undefined, geometry })
    expect(noReadout).toMatchObject({ applied: false, status: "unverified" })
    expect(noReadout.reason).toContain("INITIAL_FRAMING_NO_READOUT")
    const noSubject = enforceInitialFraming({ ...base, readFraming: () => preFixReadout, geometry: geometry.map(row => ({ ...row, subject: false })) })
    expect(noSubject.status).toBe("unverified")
    expect(noSubject.reason).toContain("INITIAL_FRAMING_NO_SUBJECT_GEOMETRY")
    expect(noSubject.reason).toContain("alphabet_soup_1(not-subject)")
    const invalid = enforceInitialFraming({ ...base, readFraming: () => ({ ...preFixReadout, radius: 0 }), geometry })
    expect(invalid.reason).toContain("INITIAL_FRAMING_READOUT_INVALID")
    // 缺相机姿态：判得出"被拉远"（诊断不被吞掉），但不给一台姿态会变的相机
    const noCamera = initialFramingVerdict({ framing: preFixReadout, geometry })
    expect(noCamera.status).toBe("pulled-away")
    if (noCamera.status !== "pulled-away") throw new Error("unreachable")
    expect(noCamera.request).toBeUndefined()
    expect(noCamera.correctedDistanceM).toBeCloseTo(postFixReadout.distance, 9)
    expect(noCamera.reason).toContain("INITIAL_FRAMING_CAMERA_STATE_REQUIRED")
    expect(applied).toEqual([])
    // 相机状态读不出来（读数里出现非有限数）：照样判"被拉远"，但不给相机、如实说明
    const broken = { ...window, getViewState: () => ({ position: [Number.NaN, 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], target: [0, 0, 0] as [number, number, number] }) }
    const stuck = enforceInitialFraming({ ...base, viewer: broken, readFraming: () => preFixReadout, geometry })
    expect(stuck).toMatchObject({ applied: false, status: "pulled-away" })
    expect(stuck.reason).toContain("INITIAL_FRAMING_CAMERA_STATE_REQUIRED")
  })

  test("判据边界钉住：比值恰好 1.2 收、1.21 判拉远；隐藏几何放大十倍不影响任何读数", () => {
    expect(INITIAL_FRAMING_SUBJECT_RATIO_MAX).toBe(1.2)
    // 边界两侧各让 1e-7（浮点上"恰好 1.2"不可靠地落哪一边，这里钉的是"1.2 是分界"本身）
    const at = initialFramingVerdict({ framing: { ...postFixReadout, radius: SUBJECT_RADIUS_M * (INITIAL_FRAMING_SUBJECT_RATIO_MAX - 1e-7) }, geometry })
    const over = initialFramingVerdict({ framing: { ...postFixReadout, radius: SUBJECT_RADIUS_M * (INITIAL_FRAMING_SUBJECT_RATIO_MAX + 1e-7) }, geometry, camera: { position: [0, -2.2, 1.4], quaternion: [0, 0, 0, 1], target: postFixReadout.center } })
    expect(at.status).toBe("subject-scale")
    expect(over.status).toBe("pulled-away")
    const grown = geometry.map(row => row.entityId === "collision" ? { ...row, bounds: { min: [-600, -600, -20] as [number, number, number], max: [600, 600, 0] as [number, number, number] } } : row)
    const before = initialFramingVerdict({ framing: preFixReadout, geometry })
    const after = initialFramingVerdict({ framing: preFixReadout, geometry: grown })
    if (before.status !== "pulled-away" || after.status !== "pulled-away") throw new Error(`应判拉远，实际 ${before.status}/${after.status}`)
    expect(after.subjectRadiusM).toBe(before.subjectRadiusM)
    expect(after.ratio).toBe(before.ratio)
    expect(after.correctedDistanceM).toBe(before.correctedDistanceM)
  })

  test("与相机应用同一份前置判定：窗口不在 / 显示的不是这一版 ⇒ 明确失败，不静默不取景", () => {
    const { window } = fakeWindow([0, 0, 0])
    const base = { clientId: "window-cam1", viewerVisible: true, viewer: window, sceneId: "s", expectedRevision: 1, readFraming: () => preFixReadout, geometry }
    expect(() => enforceInitialFraming({ ...base, displayed: { sceneId: "s", revision: 2 } })).toThrow(/VIEWER_CAMERA_STALE_REVISION/u)
    expect(() => enforceInitialFraming({ ...base, displayed: { sceneId: "other", revision: 1 } })).toThrow(/VIEWER_CAMERA_SCENE_NOT_LOADED/u)
    expect(() => enforceInitialFraming({ ...base, displayed: { sceneId: "s", revision: 1 }, viewerVisible: false })).toThrow(/VIEWER_CAMERA_VIEWER_UNAVAILABLE/u)
  })
})

/** 只会"记录被应用了什么"的窗口替身：判定走真实模块，落相机走真实 `normalizeCameraRequest`。 */
function fakeWindow(target: [number, number, number]) {
  const applied: unknown[] = []
  const state = { position: [0, -2.2, 1.4] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], target }
  const window = {
    capture: () => ({ dataURL: "data:,", camera: {} }),
    applyCameraView(request: unknown) {
      applied.push(request)
      const view = normalizeCameraRequest(request as Parameters<typeof normalizeCameraRequest>[0], { position: state.position, quaternion: state.quaternion, cameraUp: [0, 1, 0], target: state.target, fovYDeg: FOV_Y_DEG, near: 0.01, far: 10000 })
      state.position = [...view.position] as [number, number, number]
      state.quaternion = [...view.quaternion] as [number, number, number, number]
      state.target = [...view.target] as [number, number, number]
      return { position: view.position, quaternion: view.quaternion }
    },
    cameraView: () => ({ position: state.position }),
    renderCameraImage: () => { throw new Error("本用例不出图") },
    getViewState: () => ({ position: [...state.position] as [number, number, number], quaternion: [...state.quaternion] as [number, number, number, number], target: [...state.target] as [number, number, number] }),
    setViewState: (next: unknown) => { const value = next as { position: [number, number, number]; quaternion: [number, number, number, number]; target: [number, number, number] }; state.position = [...value.position]; state.quaternion = [...value.quaternion]; state.target = [...value.target] },
  }
  return { window, state, applied }
}
