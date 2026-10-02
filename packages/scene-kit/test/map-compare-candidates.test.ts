/**
 * ENV-48 候选五维度比较（`compareCandidates` / 工具 `map_compare_candidates`）的真实行为测试。
 *
 * 覆盖：形制只认几何指纹（不看 bbox）、比例用 sizeM 归一化比值、完整性看缺件集合、体量只认 m3（边界盒代理不参与判定）、
 * 使用条件看条件集合与许可；原物/替代/生成**类别隔离**（跨类别只报读数、不判一致）；noOriginal；以及四条负对照
 * （三候选一致不虚构差异 / 只有生成件 → 无原物可比 / 比例相同但形制不同必须区分 / 缺项 missing 不编）。
 * 运行：`bun test packages/scene-kit/test/map-compare-candidates.test.ts`
 */
import { describe, expect, test } from "bun:test"
import { compareCandidates } from "../src/map-constraints.ts"

const TOLERANCE = { relativePpm: 1000 }
const source = (object: string, license?: string) => ({ page: "https://example.invalid/a", object, ...(license ? { license } : {}) })
const original = {
  id: "原物", role: "original", source: source("目标物", "CC0-1.0"), declaredBy: "真实资产读数",
  form: { digest: "d3f6ca9c422fd1d0", vertexCount: 814, triangleCount: 1396, topology: { nodes: 15, meshes: 15 } },
  size: { sizeM: [29.937453, 68.725113, 7.857933] },
  completeness: { missingParts: [], verification: { valid: true, missing: [], changed: [] } },
  volume: { boundsM3: 16167.34 },
  usage: { license: "CC0-1.0" },
}
const substitute = { ...original, id: "替代", role: "substitute", declaredBy: "同族替代件", form: { ...original.form, digest: "a221b60d0c9925c5" }, size: { sizeM: [29.937453, 7.857933, 68.725113] } }
const generated = { id: "生成", role: "generated", source: source("目标物"), declaredBy: "脚本生成", form: { digest: "b864514538fda626", topology: { nodes: 1, meshes: 1 } }, size: { sizeM: [1, 0, 1] }, completeness: { missingParts: ["NORMAL"], verification: { valid: true } }, usage: {} }

describe("ENV-48 五维度比较：机器可判定 + 类别隔离", () => {
  test("三候选（原物/替代/生成）：形制与比例给出可判定读数，跨类别只判 different-role，不静默等同", () => {
    const report: any = compareCandidates({ target: { object: "目标物" }, tolerance: TOLERANCE, candidates: [original, substitute, generated] })
    expect(report.originalCandidate.id).toBe("原物")
    expect(report.noOriginal).toBe(false)
    const form = report.dimensions.find((item: any) => item.dimension === "form")
    expect(form.status).toBe("cross-role-only")
    expect(form.rows.map((row: any) => row.verdict)).toEqual(["reference", "different-role", "different-role"])
    expect(form.rows[1].value).toBe("a221b60d0c9925c5")
    expect(form.rows[1].differenceVsReference).toBeNull()
    const proportion = report.dimensions.find((item: any) => item.dimension === "proportion")
    expect(proportion.rows[0].value).toBe("0.43561155:1:0.114338597")
    expect(proportion.rows[1].value).toBe("0.43561155:0.114338597:1")
    expect(proportion.rows[1].verdict).toBe("different-role")
    expect(report.crossRolePairs).toHaveLength(3)
    expect(report.crossRolePairs[0].note).toContain("不得被静默等同")
    expect(report.roleRule).toContain("类别是**采信前提**")
  })

  test("完整性：缺件集合差异照实报；同值但跨类别记 same-value-different-role", () => {
    const report: any = compareCandidates({ tolerance: TOLERANCE, candidates: [original, substitute, generated] })
    const completeness = report.dimensions.find((item: any) => item.dimension === "completeness")
    expect(completeness.rows[1].verdict).toBe("same-value-different-role")
    expect(completeness.rows[1].value).toBe("(无缺件)")
    expect(completeness.rows[2].verdict).toBe("different-role")
    expect(completeness.rows[2].value).toBe("NORMAL")
  })

  test("体量：没有 m3 一律 missing + 最小方案；boundsM3 只作代理不参与判定", () => {
    const report: any = compareCandidates({ tolerance: TOLERANCE, candidates: [original, substitute] })
    const volume = report.dimensions.find((item: any) => item.dimension === "volume")
    expect(volume.status).toBe("missing")
    expect(volume.rows.every((row: any) => row.value === null)).toBe(true)
    expect(volume.missingPlan).toContain("meshVolumeM3")
    expect(volume.missingPlan).toContain("boundsM3 只是包围盒代理")
    expect(report.summary.dimensionsMissing).toContain("volume")
    expect(report.summary.needBackQuery).toContain("volume")
  })

  test("使用条件：许可一致记 same-value-different-role，缺声明的候选记 insufficient", () => {
    const report: any = compareCandidates({ tolerance: TOLERANCE, candidates: [original, substitute, generated] })
    const usage = report.dimensions.find((item: any) => item.dimension === "usage")
    expect(usage.rows[1].value).toBe("CC0-1.0")
    expect(usage.rows[1].verdict).toBe("same-value-different-role")
    expect(usage.rows[2].verdict).toBe("insufficient")
    expect(usage.missingPlan).toContain("physicalizeUsage")
  })

  test("负对照①：三候选完全一致（同类）→ 各维度 same，不虚构差异", () => {
    const report: any = compareCandidates({ tolerance: TOLERANCE, candidates: [original, { ...original, id: "副本2" }, { ...original, id: "副本3" }] })
    for (const name of ["form", "proportion", "completeness", "usage"]) {
      const dimension = report.dimensions.find((item: any) => item.dimension === name)
      expect(dimension.status).toBe("same")
      expect(dimension.rows.map((row: any) => row.verdict)).toEqual(["reference", "same", "same"])
    }
    expect(report.crossRolePairs).toEqual([])
    expect(report.summary.dimensionsMissing).toEqual(["volume"])
  })

  test("负对照②：只有生成件 → noOriginal=true（生成件不得被当作原物）", () => {
    const report: any = compareCandidates({ tolerance: TOLERANCE, candidates: [generated] })
    expect(report.noOriginal).toBe(true)
    expect(report.originalCandidate).toBeNull()
    expect(report.noOriginalNote).toContain("不得被当作原物")
    expect(report.summary.needBackQuery).toContain("no-original")
  })

  test("负对照③：比例相同但形制不同 → 必须区分（bbox/比例相同不代表形制相同）", () => {
    const left = { ...generated, id: "生成-A", form: { digest: "b864514538fda626", bounds: { min: [0, 0, 0], max: [1, 1, 0] } }, size: { sizeM: [1, 0, 1] } }
    const right = { ...generated, id: "生成-B", form: { digest: "d6c757cac35ec027", bounds: { min: [0, 0, 0], max: [1, 1, 0] } }, size: { sizeM: [1, 0, 1] } }
    const report: any = compareCandidates({ tolerance: TOLERANCE, candidates: [left, right] })
    const form = report.dimensions.find((item: any) => item.dimension === "form")
    const proportion = report.dimensions.find((item: any) => item.dimension === "proportion")
    expect(form.status).toBe("different")
    expect(form.rows[1].verdict).toBe("different")
    expect(proportion.status).toBe("same")
    expect(proportion.rows[1].verdict).toBe("same")
    expect(form.note).toContain("判据不看 bbox")
  })

  test("负对照④：形制只有拓扑计数 → insufficient，不判相同；完全没有证据 → missing + 最小方案", () => {
    const countsOnly = { id: "只有计数", role: "generated", form: { topology: { nodes: 1, meshes: 1 } } }
    const report: any = compareCandidates({ tolerance: TOLERANCE, candidates: [countsOnly, { ...countsOnly, id: "只有计数2" }] })
    const form = report.dimensions.find((item: any) => item.dimension === "form")
    expect(form.status).toBe("missing")
    expect(form.missingPlan).toContain("glbGeometryFacts")
    const mixture = compareCandidates({ tolerance: TOLERANCE, candidates: [original, countsOnly] })
    const mixedForm = (mixture as any).dimensions.find((item: any) => item.dimension === "form")
    expect(mixedForm.rows[1].verdict).toBe("insufficient")
    expect(mixedForm.rows[1].value).toBeNull()
  })

  test("role 不是三类之一 → unclassified 并进回查；参数校验明确报错", () => {
    const report: any = compareCandidates({ tolerance: TOLERANCE, candidates: [{ ...original, role: "maybe" }] })
    expect(report.candidates[0].role).toBe("unclassified")
    expect(report.summary.needBackQuery).toContain("unclassified-role")
    expect(() => compareCandidates({})).toThrow(/MAP_CANDIDATES_REQUIRED/)
    expect(() => compareCandidates({ candidates: [original], tolerance: { absolute: -1 } })).toThrow(/MAP_CROSS_CHECK_TOLERANCE_INVALID/)
    expect(() => compareCandidates({ candidates: [{ ...original, size: { sizeM: [1, "x", 1] } }], tolerance: TOLERANCE })).toThrow(/MAP_CANDIDATES_INVALID/)
  })

  test("判据原文随结果返回：不看 bbox / 不静默等同 / 缺证据 missing", () => {
    const report: any = compareCandidates({ tolerance: TOLERANCE, candidates: [original] })
    expect(report.comparisonRule).toContain("判据不看 bbox")
    expect(report.comparisonRule).toContain("不得被静默等同")
    expect(report.comparisonRule).toContain("status=missing")
    expect(report.dimensions.find((item: any) => item.dimension === "form").note).toContain("比例相同、形制不同必须区分")
  })
})
