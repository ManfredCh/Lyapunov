/**
 * LOD **级别事实**随采集/观察回执带出来的行为测试（95 号点 2）。
 *
 * 要证明的三件事：
 *  1. `Viewer.capture().lod`（这一帧每个实体用的是哪一级）**原样**流经 `captureForObserver` 的载荷，
 *     不会被丢掉、也不会在缺字段时造一个空壳——它和 `environment` 走的是同一条载荷、同一条纪律；
 *  2. 形状整形是**诚实**的：形状不对就不带这一面（编造一面比没有更糟：下游会把简化件当基础几何）；
 *     但**规模不是形状错误**——上千个实体的合法大场景照收，不能因为"条数多"就把整份元数据丢掉；
 *     而"带了这一面但读不出来"与"没有这一面"必须分得开（`lodFaceIssue`）；
 *  3. 措辞把两种事实分开：按距离用上简化件是**正常行为**（省面数正是 LOD 的目的），但数据集必须知道
 *     "这份几何不是基础件"，所以级别/资源版本/三角形数要照实写；只有"比这台相机该用的级别更粗"或
 *     "该读的级别没读进来"才是降级。
 *
 * 这里**不测** Viewer 内部怎么定级（`packages/viewer/test/lod.test.ts` 管那段），也不重测
 * `viewer_observe` / `viewer_render_camera` / `viewer_capture` 三个注册里的取用——那三条是同一份载荷，
 * 由真实宿主链路验收（`packages/lyapunov-shell/test/viewer-observe.ts` 的 LOD 那节 + `native/goal.md` 那轮）。
 * 用法：`bun test packages/lyapunov-shell/test/lod-capture-face.test.ts`
 */
import { describe, expect, test } from "bun:test"

import { lodFaceFrom, lodFaceIssue, lodFaceIssueNote, lodFaceNote, type LodCaptureFace } from "../src/lod-capture.ts"
import { captureForObserver } from "../src/workbench-observe.ts"
import type { LodCaptureFace as ViewerLodFace } from "../../viewer/src/index.ts"

const entry = { entityId: "pot-00:node:1", level: 0, requested: 0, role: "visual", resource: "res_90bcb1a0@1", triangles: 4096, distanceM: 15.0004, simplified: true }
const face: LodCaptureFace = { camera: "capture", planned: 1, entries: [entry] }

/** 走**产品自己的**观察采集判定：真 Viewer 面缺一项都会被拒（本文件只喂合法输入）。 */
async function observe(viewer: { capture: () => any }) {
  const payloads: any[] = []
  const value = await captureForObserver({
    sceneId: "scene-1", expectedRevision: 4, observeId: "observe-1", clientId: "client-1",
    viewerVisible: true,
    viewer: { ...viewer, loadingErrors: new Map(), visualWarnings: new Map() },
    displayed: { sceneId: "scene-1", revision: 4, entityIds: ["pot-00:node:1"] },
    loadState: () => ({ sceneId: "scene-1", revision: 4, settled: true }),
    capture: async (payload: unknown) => { payloads.push(payload); return { saved: true } },
  })
  return { value, payload: payloads[0] }
}

describe("LOD 窄面的整形", () => {
  test("合法面原样通过（距离限小数、三角形取整）", () => {
    expect(lodFaceFrom(face)).toEqual({ camera: "capture", planned: 1, entries: [{ ...entry, distanceM: 15 }] })
    expect(lodFaceFrom({ camera: "window", planned: 0, entries: [] })).toEqual({ camera: "window", planned: 0, entries: [] })
  })

  test("Viewer 那边声明的面类型能直接喂进来（两份声明不许漂）", () => {
    const fromViewer: ViewerLodFace = { camera: "capture", planned: 1, entries: [{ entityId: "e", level: -1, requested: -1, triangles: 12, distanceM: 3, simplified: false }] }
    expect(lodFaceFrom(fromViewer)).toEqual({ camera: "capture", planned: 1, entries: [{ entityId: "e", level: -1, requested: -1, triangles: 12, distanceM: 3, simplified: false }] })
  })

  test("形状不对就不带这一面：不猜、不补默认值", () => {
    expect(lodFaceFrom(undefined)).toBeUndefined()
    expect(lodFaceFrom("capture")).toBeUndefined()
    expect(lodFaceFrom([])).toBeUndefined()
    expect(lodFaceFrom({ planned: 1, entries: [] })).toBeUndefined() // 缺 camera
    expect(lodFaceFrom({ camera: "window", entries: [] })).toBeUndefined() // 缺 planned
    expect(lodFaceFrom({ camera: "window", planned: 1 })).toBeUndefined() // 缺 entries
    expect(lodFaceFrom({ camera: "near", planned: 1, entries: [] })).toBeUndefined() // camera 不认识
    expect(lodFaceFrom({ camera: "window", planned: 1, entries: entry })).toBeUndefined() // entries 不是数组
    expect(lodFaceFrom({ camera: "window", planned: 1, entries: [{ entityId: "e", level: "0", requested: 0, triangles: 1, distanceM: 1 }] })).toBeUndefined() // level 不是数字
    expect(lodFaceFrom({ camera: "window", planned: 1, entries: [{ level: 0, requested: 0, triangles: 1, distanceM: 1 }] })).toBeUndefined() // 缺 entityId
  })

  test("一条实体读数不合法就整面作废：少报一个实体等于说谎", () => {
    expect(lodFaceFrom({ camera: "window", planned: 2, entries: [entry, { entityId: "bad" }] })).toBeUndefined()
    expect(lodFaceFrom({ camera: "window", planned: 2, entries: [entry, null] })).toBeUndefined()
    expect(lodFaceFrom({ camera: "window", planned: 1, entries: [{ ...entry, failed: "visual" }] })).toBeUndefined()
    expect(lodFaceFrom({ camera: "window", planned: 1, entries: [], skipped: [{ entityId: "e" }] })).toBeUndefined()
  })

  test("规模不是形状错误：1001 个合法实体照收，一条不少（不做整面丢弃，也不悄悄截断）", () => {
    const many = Array.from({ length: 1001 }, (_, index) => ({ ...entry, entityId: `plant_${String(index)}`, distanceM: 15 + index / 1000 }))
    const shaped = lodFaceFrom({ camera: "window", planned: 1001, entries: many })
    expect(shaped?.entries).toHaveLength(1001)
    expect(shaped?.planned).toBe(1001)
    expect(shaped?.entries[0]?.entityId).toBe("plant_0")
    expect(shaped?.entries[1000]?.entityId).toBe("plant_1000")
    expect(shaped?.entries.every(row => row.simplified)).toBe(true)
    // 参与不了级别交换的那一份同理：条数多也是事实，不是错误。
    const skipped = Array.from({ length: 200 }, (_, index) => ({ entityId: `rig_${String(index)}`, reason: "LOD_SKIPPED: 带烘焙动画" }))
    expect(lodFaceFrom({ camera: "window", planned: 1, entries: [entry], skipped })?.skipped).toHaveLength(200)
  })

  test("超长字段被截断；多余字段不进记录", () => {
    const shaped = lodFaceFrom({ ...face, entries: [{ ...entry, resource: "R".repeat(500), note: "不该进来" }], extra: 1 })
    expect(shaped?.entries[0]?.resource).toHaveLength(200)
    expect(shaped?.entries[0] && "note" in shaped.entries[0]).toBe(false)
    expect(shaped && "extra" in shaped).toBe(false)
  })
})

describe("读不出来 ≠ 没有这一面（lodFaceIssue）", () => {
  test("没有这一面：不是问题（旧前端照样能采集）", () => {
    expect(lodFaceIssue(undefined)).toBeUndefined()
    expect(lodFaceFrom(undefined)).toBeUndefined()
  })

  test("合法面：没有问题", () => {
    expect(lodFaceIssue(face)).toBeUndefined()
    expect(lodFaceIssue({ camera: "window", planned: 0, entries: [] })).toBeUndefined()
  })

  test("带了这一面但形状/字段不合格：给出原因（而不是让它看起来像没有读数）", () => {
    expect(lodFaceIssue({ camera: "degraded", planned: 1, entries: [] })).toContain("lod.camera")
    expect(lodFaceIssue({ camera: "window", planned: 1, entries: [{ entityId: "e" }] })).toContain("lod.entries[0]")
    expect(lodFaceIssue({ camera: "window", planned: 1, entries: [entry, null] })).toContain("lod.entries[1]")
    expect(lodFaceIssue("capture")).toContain("lod 必须是一个对象")
    // 不合格 = 整面作废：拿不到面，但拿得到原因——两件事同时成立才算"没有装成没有"。
    expect(lodFaceFrom({ camera: "degraded", planned: 1, entries: [] })).toBeUndefined()
  })

  test("这一面读不出来时，回执要把原因说出来（不能沉默）", () => {
    const issue = lodFaceIssue({ camera: "window", planned: 1, entries: [{ entityId: "e" }] })!
    const note = lodFaceIssueNote(issue)!
    expect(note).toContain("lod.entries[0]")
    expect(note).toContain("不能把它当成")
    expect(lodFaceIssueNote(undefined)).toBeUndefined()
  })
})

describe("给模型的一句话：正常简化要如实说，降级才写成问题", () => {
  test("没有这一面 / 没有实体 / 全是基础件：没什么要说的", () => {
    expect(lodFaceNote(undefined)).toBeUndefined()
    expect(lodFaceNote({ camera: "window", planned: 0, entries: [] })).toBeUndefined()
    expect(lodFaceNote({ camera: "window", planned: 1, entries: [{ ...entry, level: -1, requested: -1, simplified: false }] })).toBeUndefined()
  })

  test("按距离用上简化件：说出来是哪一级/哪份资源/多少面，并明说这不是故障", () => {
    const note = lodFaceNote(face)!
    expect(note).toContain("pot-00:node:1")
    expect(note).toContain("res_90bcb1a0@1")
    expect(note).toContain("4096")
    expect(note).toContain("这是按距离的正常简化，不是故障")
    expect(note).toContain("要按基础精度使用时请另取原件")
    expect(note).not.toContain("降级")
  })

  test("一句话只列前几个，但总数与完整读数的位置要说清（大场景也一样）", () => {
    const many = Array.from({ length: 1001 }, (_, index) => ({ ...entry, entityId: `plant_${String(index)}` }))
    const note = lodFaceNote({ camera: "window", planned: 1001, entries: many })!
    expect(note).toContain("有 1001 个实体")
    expect(note).toContain("1001 条都在本记录的 lod.entries 里")
    expect(note).toContain("plant_0")
    expect(note).not.toContain("plant_1000")
  })

  test("比该用的更粗：用降级的口气写，点名实体与原因", () => {
    const note = lodFaceNote({ camera: "capture", planned: 2, entries: [{ ...entry, level: 1, requested: 0, coarser: true }] })!
    expect(note).toContain("比这台相机该用的级别更粗")
    expect(note).toContain("该用级别 0、画面只有级别 1")
    expect(note).toContain("别把这张图当成它们该有的精度")
  })

  test("该读的级别没读进来：连角色名一起说", () => {
    const note = lodFaceNote({ camera: "capture", planned: 1, entries: [{ ...entry, level: 1, requested: 0, failed: ["visual"], coarser: true }] })!
    expect(note).toContain("该读的 visual 没读进来")
    expect(note).toContain("缺件/读取失败造成的降级")
  })

  test("实体多了只列前几个：回执是给模型读的，不是日志", () => {
    const many = Array.from({ length: 6 }, (_, index) => ({ ...entry, entityId: `pot-0${String(index)}:node:1` }))
    const note = lodFaceNote({ camera: "window", planned: 6, entries: many })!
    expect(note).toContain("等 6 个")
    expect(note).not.toContain("pot-05:node:1")
  })
})

describe("观察采集的载荷里带着这一面", () => {
  test("Viewer 给什么就带什么，逐字段相同", async () => {
    const { value, payload } = await observe({ capture: () => ({ dataURL: "data:image/png;base64,AAAA", sceneId: "scene-1", sceneRevision: 4, lod: face }) })
    expect(payload.lod).toEqual(face)
    expect(payload.observeId).toBe("observe-1")
    expect((value as { saved?: boolean })?.saved).toBe(true)
    // 与缺件警告是两种事实：正常按距离简化不会被塞进 visualWarnings 冒充"少了几个部件"
    expect(payload.visualWarnings).toBeUndefined()
  })

  test("Viewer 不带这一面时不造空壳（没有这一面就是没有）", async () => {
    const { payload } = await observe({ capture: () => ({ dataURL: "data:image/png;base64,AAAA", sceneId: "scene-1", sceneRevision: 4 }) })
    expect("lod" in payload).toBe(false)
  })
})
