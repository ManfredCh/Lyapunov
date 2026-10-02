/**
 * ENV-10（N302）：局部修正的**四要素结构化记录**必须"缺一即报错、不补默认值"。
 *
 * 背景：`environment-routing.ts` 的"局部短计划（实体、原因、动作、复看机位）"此前只是**规划文本**，
 * 没有结构化回执——事后无法核"改了哪个实体、依据什么、做了什么、从哪个机位复查、前后差多少"。
 * 本文件钉住 `workbench-api.ts` 的纯校验函数 `localCorrectionRecordOf`：
 *   · 四要素（entity/reason/action/reviewCamera）+ before/after 齐 ⇒ 通过，且 `recordedAt` 由调用方给；
 *   · 缺任一要素、或 before/after 缺失 ⇒ **必须报错**（负对照），不得造一条"改过了"的空壳。
 * 边界：本文件不启动宿主、不证明工具已接线；工具/回读的真机回执在回执 Round 3 段里贴原文。
 */
import { describe, expect, test } from "bun:test"
import { localCorrectionRecordOf } from "../src/workbench-api.ts"

const AT = "2026-09-22T12:00:00.000Z"
const full = {
  sceneId: "eth3d-room", entity: "the_wall_block", reason: "照片真值深度显示该块中位误差 0.1352 m（图 A 8×8 块 @(0,44)）",
  action: "把该块的相机轴向深度从 1.4593 m 修为 1.5940 m（局部锚点重标定）",
  reviewCamera: { worldFromCamera: { positionM: [0, 0, 0], rotationMatrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }, intrinsics: { fx: 262.5, fy: 262.5, cx: 159.5, cy: 119.5, width: 320, height: 240 } },
  before: { localMedianErrM: 0.1352 }, after: { localMedianErrM: 0.0855 }, evidence: { truthDepth: "eth3d/a_depth.png", geometryReport: "env10-local-fix.out" },
}
const rejection = (action: () => unknown): Error => { try { action() } catch (error) { return error as Error } throw new Error("EXPECTED_REJECTION") }

describe("ENV-10 局部修正四要素记录（workbench-api.localCorrectionRecordOf）", () => {
  test("四要素 + before/after 齐 ⇒ 通过且逐字段保留（含可选 evidence/sceneId）", () => {
    const record = localCorrectionRecordOf(full, AT)
    expect(record.entity).toBe(full.entity)
    expect(record.reason).toBe(full.reason)
    expect(record.action).toBe(full.action)
    expect(record.reviewCamera).toEqual(full.reviewCamera)
    expect(record.before).toEqual(full.before)
    expect(record.after).toEqual(full.after)
    expect(record.evidence).toEqual(full.evidence)
    expect(record.sceneId).toBe("eth3d-room")
    expect(record.recordedAt).toBe(AT)
  })

  test("负对照：缺 entity / reason / action 任一 ⇒ 必须报错并点名要素", () => {
    for (const key of ["entity", "reason", "action"] as const) {
      const input: Record<string, unknown> = { ...full }
      delete input[key]
      const error = rejection(() => localCorrectionRecordOf(input, AT))
      expect(error.message).toContain(`LOCAL_CORRECTION_${key.toUpperCase()}_REQUIRED`)
    }
    // 空白串不算"写清了"
    expect(rejection(() => localCorrectionRecordOf({ ...full, entity: "   " }, AT)).message).toContain("LOCAL_CORRECTION_ENTITY_REQUIRED")
  })

  test("负对照：缺 reviewCamera（复看机位）/ 缺 before 或 after ⇒ 必须报错，不写空壳", () => {
    expect(rejection(() => localCorrectionRecordOf({ ...full, reviewCamera: undefined }, AT)).message).toContain("LOCAL_CORRECTION_REVIEWCAMERA_REQUIRED")
    expect(rejection(() => localCorrectionRecordOf({ ...full, reviewCamera: [] }, AT)).message).toContain("LOCAL_CORRECTION_REVIEWCAMERA_REQUIRED")
    const noBefore: Record<string, unknown> = { ...full }; delete noBefore.before
    expect(rejection(() => localCorrectionRecordOf(noBefore, AT)).message).toContain("LOCAL_CORRECTION_BEFORE_AFTER_REQUIRED")
    const noAfter: Record<string, unknown> = { ...full }; delete noAfter.after
    expect(rejection(() => localCorrectionRecordOf(noAfter, AT)).message).toContain("LOCAL_CORRECTION_BEFORE_AFTER_REQUIRED")
  })

  test("负对照：非对象输入（null/数组/字符串）⇒ 必须报错", () => {
    for (const bad of [null, [], "entity=wall", 7]) expect(rejection(() => localCorrectionRecordOf(bad, AT)).message).toContain("LOCAL_CORRECTION_INPUT_REQUIRED")
  })

  test("可选字段不伪造：不给 evidence/sceneId 时记录里就没有这两个键", () => {
    const { evidence: _e, sceneId: _s, ...rest } = full
    const record = localCorrectionRecordOf(rest, AT)
    expect("evidence" in record).toBe(false)
    expect("sceneId" in record).toBe(false)
    expect(Object.keys(record).sort()).toEqual(["action", "after", "before", "entity", "reason", "recordedAt", "reviewCamera"])
  })
})
