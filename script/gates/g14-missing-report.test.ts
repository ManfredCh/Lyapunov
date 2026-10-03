/**
 * DEV-027 F24 负对照（N245）：缺失条目的"逐条报告"必须**在非空集上也成立**。
 *
 * 旧判据 `missingResources.length === 0` 只在**空集**上能通过，非空集时它只报"有缺失"，
 * 并不检查每条是否可复算。这条单测用**一条真实缺失样例**（本仓 N55 真实旧数据迁移的
 * 原始 ENOENT 条目）钉住"非空集也能通过"，并用缺字段条目钉住"报告不可复算必须失败"。
 */
import { describe, expect, test } from "bun:test"
import { missingReportCoverage } from "./g14.ts"

/** 真实样例：N55（task-88）对真实旧数据副本迁移时，资源原件已消失的原始缺失条目。 */
const REAL_MISSING = {
  kind: "resource",
  id: "res_041d57f2c002BYpbO4afPrxA6e",
  path: "/home/s18/WS/Lyapunov/History/Main/assets/objects/obj_041d57f2c0010b0j6iaVUz5YQX/normalized/object.glb",
  reason: "Error: ENOENT: no such file or directory, statx '/home/s18/WS/Lyapunov/History/Main/assets/objects/obj_041d57f2c0010b0j6iaVUz5YQX/normalized/object.glb'",
}

describe("G14 缺失逐条报告判据（F24）", () => {
  test("空集 ⇒ 通过（没有缺失是合法读数）", () => {
    expect(missingReportCoverage([]).ok).toBe(true)
  })

  test("非空集但每条都报全（真实样例）⇒ 通过", () => {
    const verdict = missingReportCoverage([REAL_MISSING])
    expect(verdict.ok).toBe(true)
    expect(verdict.incomplete).toEqual([])
  })

  test("负对照：resource 缺失缺 path ⇒ 必须判失败（报告不可复算）", () => {
    const { path: _drop, ...withoutPath } = REAL_MISSING
    const verdict = missingReportCoverage([withoutPath])
    expect(verdict.ok).toBe(false)
    expect(verdict.incomplete).toHaveLength(1)
  })

  test("负对照：缺 reason / 缺 id / 缺 kind ⇒ 必须判失败", () => {
    expect(missingReportCoverage([{ ...REAL_MISSING, reason: "  " }]).ok).toBe(false)
    expect(missingReportCoverage([{ ...REAL_MISSING, id: "" }]).ok).toBe(false)
    expect(missingReportCoverage([{ ...REAL_MISSING, kind: "" }]).ok).toBe(false)
  })

  test("非 resource/attachment 类型不强制 path（但 kind/id/reason 仍必须有）", () => {
    expect(missingReportCoverage([{ kind: "session", id: "ses_1", reason: "SOURCE_CHANGED_AFTER_MIGRATION" }]).ok).toBe(true)
  })
})
