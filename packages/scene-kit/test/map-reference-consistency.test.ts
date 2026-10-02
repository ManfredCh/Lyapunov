/**
 * ENV-18 局部资产参考图一致性检查（`checkReferenceConsistency` / 工具 `map_check_reference_consistency`）的真实行为测试。
 *
 * 覆盖：①参考图挂到资产（含 sha256/来源）；②机器可判定一致性（宽高比 vs 资产 sizeM 主平面、像素统计 meanRGB/uniqueColors/nonBackgroundShare，
 * 全部给数值与阈值）；③生成补视角 assumption=true 且不参与判定、实测参考图 assumption=false；④四条负对照
 * （明显不同报不一致 / 无参考图 unavailable / 只有生成补视角 no-measured-reference / 同字节重复检测）。
 * 运行：`bun test packages/scene-kit/test/map-reference-consistency.test.ts`
 */
import { describe, expect, test } from "bun:test"
import { checkReferenceConsistency } from "../src/map-constraints.ts"

const TOLERANCE = { relativePpm: 500000, absolute: 20 }
const ASSET = { id: "urban-block", object: "urban-block（城市街区资产）", sizeM: [232, 184, 51.46948] }
const image = (sha: string, width: number, height: number, meanRGB: [number, number, number], uniqueColors: number, nonBackgroundShare: number, path = `/tmp/${sha}.png`) =>
  ({ path, sha256: sha, bytes: 900000, width, height, meanRGB, uniqueColors, nonBackgroundShare })
const measured = (id: string, view: string, img: ReturnType<typeof image>) => ({ id, role: "measured-reference", view, basis: "measured", source: { page: "file:///preview", object: "urban-block", era: { label: "2026", status: "confirmed" } }, declaredBy: img.path, image: img })
const generated = (id: string, view: string, img: ReturnType<typeof image>) => ({ id, role: "generated-view", view, basis: "estimated", source: { page: "file:///gen", object: "urban-block" }, declaredBy: "由实测图裁剪派生（生成补视角）", image: img })

const TOP_DOWN = image("a70e1e112f49cc7324b00a1bd9d1c16f43f88c518f96dd2e1168650388304ca9", 1280, 720, [102.6502, 111.2891, 94.2691], 4929, 0.782694)
const OBLIQUE = image("c011703f1d84f4eb0000000000000000000000000000000000000000000000aaaa", 1280, 720, [94.4085, 101.8563, 89.2336], 9732, 0.810002)
const STREET = image("035b9dd57dfa71fc0000000000000000000000000000000000000000000000bbbb", 1280, 720, [88.0546, 94.2966, 86.9114], 10210, 0.674883)
const CROP = image("7016ade28bb81585536372b5e23da806611ce01238c166a6523d874070126dfb", 844, 720, [103.4736, 111.9, 95.1], 3120, 0.79, "/tmp/gen/topdown-crop.png")

describe("ENV-18 参考图挂载与机器可判定一致性", () => {
  test("挂到资产：回执里带资产 id/sizeM 与每张参考图的 sha256/像素/来源，且实测参考图不被标成假设", () => {
    const report: any = checkReferenceConsistency({ asset: ASSET, tolerance: TOLERANCE, references: [measured("实测-俯视", "top-down", TOP_DOWN), measured("实测-斜视", "perspective", OBLIQUE)] })
    expect(report.asset).toMatchObject({ id: "urban-block", sizeM: [232, 184, 51.46948], assetAspect: 1.260869565 })
    expect(report.references).toHaveLength(2)
    expect(report.references[0].image.sha256).toBe(TOP_DOWN.sha256)
    expect(report.references[0].source.page).toBe("file:///preview")
    expect(report.assumptions.measured.every((item: any) => item.assumption === false)).toBe(true)
    expect(report.summary.measuredMarkedAsAssumption).toBe(0)
    expect(report.assumptionRule).toContain("实测参考图恒 assumption=false")
  })

  test("宽高比一致性：top-down 与资产主平面比（给数值），perspective 记 not-applicable（不硬套）", () => {
    const report: any = checkReferenceConsistency({ asset: ASSET, tolerance: TOLERANCE, references: [measured("实测-俯视", "top-down", TOP_DOWN), measured("实测-斜视", "perspective", OBLIQUE)] })
    const rows = report.checks.aspect.rows
    expect(rows[0]).toMatchObject({ view: "top-down", pixelAspect: 1.777777778, assetAspect: 1.260869565, verdict: "consistent", withinTolerance: true })
    expect(rows[0].relativePpm).toBeCloseTo(409961.69, 1)
    expect(rows[1]).toMatchObject({ view: "perspective", verdict: "not-applicable" })
    expect(rows[1].reason).toContain("不硬套")
  })

  test("像素统计一致性：meanRGB 欧氏距离/uniqueColors 相对差/nonBackgroundShare 绝对差都给数值与阈值", () => {
    const report: any = checkReferenceConsistency({ asset: ASSET, tolerance: TOLERANCE, references: [measured("实测-俯视", "top-down", TOP_DOWN), measured("实测-斜视", "perspective", OBLIQUE)] })
    const row = report.checks.pixelStatistics.rows[1]
    expect(row.rgbDistance).toBeCloseTo(13.500355, 5)
    expect(row.uniqueColorsRelative).toBeCloseTo(0.974437, 5)
    expect(row.nonBackgroundDelta).toBeCloseTo(0.027308, 5)
    expect(row.checks.map((check: any) => check.metric)).toEqual(["meanRgbDistance", "uniqueColorsRelative", "nonBackgroundShareDelta"])
    expect(row.checks[0]).toMatchObject({ value: 13.500355, threshold: 20, within: true })
    expect(row.checks[1].within).toBe(false)
    expect(row.verdict).toBe("inconsistent")
    expect(report.consistency.status).toBe("inconsistent")
    expect(report.consistency.inconsistentCount).toBe(1)
  })

  test("生成补视角：assumption=true + 假设原文，且不参与一致性判定（只列读数）", () => {
    const report: any = checkReferenceConsistency({ asset: ASSET, tolerance: TOLERANCE, references: [measured("实测-俯视", "top-down", TOP_DOWN), generated("生成-俯视裁剪", "top-down", CROP)] })
    const genRow = report.references.find((reference: any) => reference.id === "生成-俯视裁剪")
    expect(genRow.assumption).toBe(true)
    expect(genRow.assumptionNote).toContain("假设/估计，未经核实，不得与实测参考图混同")
    expect(report.assumptions.generated[0]).toMatchObject({ id: "生成-俯视裁剪", assumption: true })
    expect(report.summary.generatedMissingAssumption).toBe(0)
    expect(report.checks.aspect.rows[1].verdict).toBe("assumption-excluded")
    expect(report.checks.pixelStatistics.rows[1].verdict).toBe("assumption-excluded")
    expect(report.warnings.join(" ")).toContain("不参与一致性结论")
    expect(report.consistency.status).toBe("consistent")
  })

  test("负对照①：明显不同的两张实测图 ⇒ 报 inconsistent 并给数值", () => {
    const report: any = checkReferenceConsistency({ asset: ASSET, tolerance: TOLERANCE, references: [measured("实测-俯视", "top-down", TOP_DOWN), measured("实测-街面", "top-down", STREET)] })
    expect(report.consistency.status).toBe("inconsistent")
    const row = report.checks.pixelStatistics.rows[1]
    expect(row.rgbDistance).toBeGreaterThan(20)
    expect(row.uniqueColorsRelative).toBeGreaterThan(0.5)
    expect(row.checks.filter((check: any) => check.within === false).length).toBeGreaterThanOrEqual(2)
    expect(report.summary.needBackQuery).toContain("resolve-inconsistency")
  })

  test("负对照②：没有参考图 ⇒ unavailable（不编一致性）", () => {
    const report: any = checkReferenceConsistency({ asset: ASSET, tolerance: TOLERANCE, references: [] })
    expect(report.consistency.status).toBe("unavailable")
    expect(report.consistency.note).toContain("不编一致性")
    expect(report.summary.references).toBe(0)
    expect(report.summary.needBackQuery).toContain("measured-reference")
  })

  test("负对照③：只有生成补视角 ⇒ no-measured-reference，全部 assumption=true", () => {
    const report: any = checkReferenceConsistency({ asset: ASSET, tolerance: TOLERANCE, references: [generated("生成-俯视裁剪", "top-down", CROP)] })
    expect(report.consistency.status).toBe("no-measured-reference")
    expect(report.assumptions.measured).toEqual([])
    expect(report.assumptions.generated).toHaveLength(1)
    expect(report.assumptions.generated[0].assumption).toBe(true)
    expect(report.consistency.note).toContain("只有生成补视角")
  })

  test("负对照④：同一份字节（sha256 相同）被当两张参考 ⇒ 重复检测 + warning", () => {
    const report: any = checkReferenceConsistency({ asset: ASSET, tolerance: TOLERANCE, references: [measured("图A", "top-down", TOP_DOWN), measured("图A的副本", "top-down", TOP_DOWN)] })
    expect(report.checks.digestDuplicates).toHaveLength(1)
    expect(report.checks.digestDuplicates[0].ids).toEqual(["图A", "图A的副本"])
    expect(report.warnings.join(" ")).toContain("不是独立来源")
    expect(report.summary.needBackQuery).toContain("duplicate-bytes")
  })

  test("资产没声明 sizeM ⇒ 宽高比 unverifiable（不是 consistent）；参数校验明确报错", () => {
    const report: any = checkReferenceConsistency({ asset: { id: "x" }, tolerance: TOLERANCE, references: [measured("实测-俯视", "top-down", TOP_DOWN)] })
    expect(report.asset.assetAspect).toBeNull()
    expect(report.checks.aspect.rows[0].verdict).toBe("not-applicable")
    expect(report.warnings.join(" ")).toContain("无从比对")
    expect(report.summary.needBackQuery).toContain("asset-sizeM")
    expect(() => checkReferenceConsistency({ references: [] } as any)).toThrow(/MAP_REFERENCES_ASSET_REQUIRED/)
    expect(() => checkReferenceConsistency({ asset: ASSET, references: [{ id: "a", image: { width: 0, height: 1 } }] } as any)).toThrow(/MAP_REFERENCES_INVALID/)
  })

  test("判据原文随结果返回：机器可判定 / 不把实测验成假设 / 不把生成升格成实测", () => {
    const report: any = checkReferenceConsistency({ asset: ASSET, tolerance: TOLERANCE, references: [measured("实测-俯视", "top-down", TOP_DOWN)] })
    expect(report.referenceRule).toContain("不许用「看起来一致」")
    expect(report.referenceRule).toContain("实测参考图（role=measured-reference）不得被标成假设")
    expect(report.assumptionRule).toContain("生成补视角=假设")
    expect(report.assumptionRule).toContain("不把生成升格成实测")
  })
})
