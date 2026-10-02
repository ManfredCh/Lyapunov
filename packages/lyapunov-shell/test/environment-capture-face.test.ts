/**
 * 环境**光照事实**随采集/观察回执带出来的行为测试（2026-09-20 审查修复项 2）。
 *
 * 要证明的两件事：
 *  1. `Viewer.capture().environment`（这一帧的 IBL 是不是文档请求的那份 HDRI）**原样**流经
 *     `captureForObserver` 的载荷，不会被丢掉、也不会在缺字段时造一个空壳；
 *  2. 形状整形与"给模型的一句话"是**诚实**的：形状不对就不带这一面；场景压根没声明 HDRI 时
 *     （内置环境光就是它的配置）不写成"不完整"；请求的 HDRI 没装上时必须说明请求的是哪一份、
 *     画面现在是什么、原因是什么。
 *
 * 这里**不测** `viewer_capture` / `viewer_observe` 两个注册内部的取用：那两条路走的都是同一份载荷，
 * 落盘与回执由真实宿主链路验收（`environment-lighting-live.ts` 会核对采集记录里的这一面）。
 * 用法：`bun test packages/lyapunov-shell/test/environment-capture-face.test.ts`
 */
import { describe, expect, test } from "bun:test"

import { environmentFaceFrom, environmentFaceNote, type EnvironmentCaptureFace } from "../src/environment-capture.ts"
import { captureForObserver } from "../src/workbench-observe.ts"

const face: EnvironmentCaptureFace = { source: "hdri", requested: "sky-2@1", applied: "sky-1@1", loaded: false, loading: true }

/** 走**产品自己的**观察采集判定：真 Viewer 面缺一项都会被拒（本文件只喂合法输入）。 */
async function observe(viewer: { capture: () => any }) {
  const payloads: any[] = []
  const value = await captureForObserver({
    sceneId: "scene-1", expectedRevision: 4, observeId: "observe-1", clientId: "client-1",
    viewerVisible: true,
    viewer: { ...viewer, loadingErrors: new Map(), visualWarnings: new Map() },
    displayed: { sceneId: "scene-1", revision: 4, entityIds: ["lighting"] },
    loadState: () => ({ sceneId: "scene-1", revision: 4, settled: true }),
    capture: async (payload: unknown) => { payloads.push(payload); return { saved: true } },
  })
  return { value, payload: payloads[0] }
}

describe("环境窄面的整形", () => {
  test("合法面原样通过（限长之后）", () => {
    expect(environmentFaceFrom(face)).toEqual(face)
    expect(environmentFaceFrom({ source: "builtin", loaded: false, loading: false })).toEqual({ source: "builtin", loaded: false, loading: false })
  })

  test("形状不对就不带这一面：不猜、不补默认值（编造「核过了」比没有更糟）", () => {
    expect(environmentFaceFrom(undefined)).toBeUndefined()
    expect(environmentFaceFrom("hdri")).toBeUndefined()
    expect(environmentFaceFrom([])).toBeUndefined()
    expect(environmentFaceFrom({ source: "hdri", loaded: false })).toBeUndefined() // 缺 loading
    expect(environmentFaceFrom({ source: "skybox", loaded: true, loading: false })).toBeUndefined() // source 不认识
    expect(environmentFaceFrom({ source: "hdri", loaded: "yes", loading: false })).toBeUndefined()
  })

  test("超长字段被截断；多余字段不进记录", () => {
    const shaped = environmentFaceFrom({ ...face, error: "E".repeat(900), note: "不该进来" })
    expect(shaped?.error).toHaveLength(500)
    expect(shaped && "note" in shaped).toBe(false)
  })
})

describe("给模型的一句话：只在「请求的 HDRI 真的没在画面里」时才说话", () => {
  test("场景没声明 HDRI（内置环境光就是它的配置）：不写成「不完整」", () => {
    expect(environmentFaceNote({ source: "builtin", loaded: false, loading: false })).toBeUndefined()
    expect(environmentFaceNote(undefined)).toBeUndefined()
  })

  test("请求的那份已在画面里：没什么要提醒的", () => {
    expect(environmentFaceNote({ source: "hdri", requested: "sky-2@1", applied: "sky-2@1", loaded: true, loading: false })).toBeUndefined()
  })

  test("换图在途：说清请求的是谁、画面还在用谁、IBL 是什么", () => {
    const note = environmentFaceNote(face)!
    expect(note).toContain("没有用上")
    expect(note).toContain("sky-2@1")
    expect(note).toContain("画面现在用的是 sky-1@1")
    expect(note).toContain("另一份 HDRI")
    expect(note).toContain("仍在加载中")
    expect(note).toContain("别把这张图当成完整的环境配置")
  })

  test("回退到内置环境光：说明原因（缺版本/加载失败都走这一句）", () => {
    const note = environmentFaceNote({ source: "builtin", requested: "sky-1@2", loaded: false, loading: false, error: "ENVIRONMENT_HDRI_VERSION_MISSING: sky-1@2 不在承载实体的 resources 里（实体上只有 sky-1@1）" })!
    expect(note).toContain("没有可用的 HDRI")
    expect(note).toContain("内置环境光")
    expect(note).toContain("ENVIRONMENT_HDRI_VERSION_MISSING")
  })
})

describe("观察采集的载荷里带着这一面", () => {
  test("Viewer 给什么就带什么，逐字段相同", async () => {
    const { value, payload } = await observe({ capture: () => ({ dataURL: "data:image/png;base64,AAAA", sceneId: "scene-1", sceneRevision: 4, environment: face }) })
    expect(payload.environment).toEqual(face)
    expect(payload.observeId).toBe("observe-1")
    expect(payload.clientId).toBe("client-1")
    expect((value as { saved?: boolean })?.saved).toBe(true)
    // 它与缺件警告是两种事实：没装上的环境贴图不会被塞进 visualWarnings 冒充"少了几个部件"
    expect(payload.visualWarnings).toBeUndefined()
  })

  test("Viewer 不带这一面时不造空壳（没有这一面就是没有）", async () => {
    const { payload } = await observe({ capture: () => ({ dataURL: "data:image/png;base64,AAAA", sceneId: "scene-1", sceneRevision: 4 }) })
    expect("environment" in payload).toBe(false)
  })
})
