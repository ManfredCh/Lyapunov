/**
 * ENV-41 地点/年代消歧 + 边界/相邻地标核对（`checkPlace` / 工具 `map_place_check`）的真实行为测试。
 *
 * 覆盖：同名多候选**不擅自选定**（返回候选 + 回查项）、只有证据唯一筛出才算 resolved、证据把候选筛空仍判 ambiguous、
 * 单一候选按"唯一性"采用、年代不同 era-mismatch 排除 + backQuery.eras、未声明年代显式"未做年代排除"、
 * 边界内外/边界上（容差）/越界明确报出/无边界即 unavailable、相邻地标 matched/mismatch/无地标不虚构。
 * 边界几何用内联小方块（快）；真实 swisstopo/USGS 数据的读数见回执里的 CLI 证据。
 * 运行：`bun test packages/scene-kit/test/map-place-check.test.ts`
 */
import { describe, expect, test } from "bun:test"
import { checkPlace } from "../src/map-constraints.ts"

const signal = new AbortController().signal
const CANDIDATES = [
  { id: "zh-2026", name: "Zürich", identity: { gde_hist_id: 13688, gde_nr: 261, jahr: 2026 }, era: { label: "2026", status: "confirmed" }, coordinate: { lon: 8.564262, lat: 47.346028 }, page: "https://example.invalid/zh-2026" },
  { id: "zh-1954", name: "Zürich", identity: { gde_hist_id: 10327, gde_nr: 253, jahr: 1954 }, era: { label: "1954", status: "confirmed" }, coordinate: { lon: 8.535801, lat: 47.347122 }, page: "https://example.invalid/zh-1954" },
]
/** 苏黎世附近的小方块（边长约 0.01° ≈ 700 m），用于边界/地标核对。 */
const SQUARE = {
  type: "FeatureCollection",
  features: [{ type: "Feature", id: "square", properties: { name: "测试方块" }, geometry: { type: "Polygon", coordinates: [[[8.50, 47.35], [8.51, 47.35], [8.51, 47.36], [8.50, 47.36], [8.50, 47.35]]] } }],
}
const FRAME = { crs: "EPSG:4326", anchor: { lon: 8.5417, lat: 47.3769 } }

describe("ENV-41 地名消歧：不擅自选定", () => {
  test("同名两候选、没有辨别证据 → ambiguous、chosen=null，并列出候选身份差异与回查项", async () => {
    const report: any = await checkPlace({ place: { name: "Zürich" }, candidates: CANDIDATES }, {}, signal)
    expect(report.place.status).toBe("ambiguous")
    expect(report.place.chosen).toBeNull()
    expect(report.place.reason).toContain("不擅自选定")
    expect(report.place.sameNameDifferentIdentity).toBe(true)
    expect(report.place.differingIdentityKeys).toEqual(["gde_hist_id", "gde_nr", "jahr"])
    expect(report.place.sameNameDifferentCoordinates).toBe(true)
    expect(report.place.candidates).toHaveLength(2)
    expect(report.place.candidates[0].whatToQuery.length).toBeGreaterThan(0)
    expect(report.summary.needBackQuery).toContain("place")
    expect(report.place.rule).toContain("不擅自选定")
  })

  test("证据唯一筛出：target.era 与 target.identity 各自都能 resolved-by-evidence，并逐字回显用到的证据", async () => {
    const byEra: any = await checkPlace({ place: { name: "Zürich" }, candidates: CANDIDATES, target: { era: { label: "2026", status: "confirmed" } } }, {}, signal)
    expect(byEra.place.status).toBe("resolved-by-evidence")
    expect(byEra.place.chosen).toMatchObject({ id: "zh-2026" })
    expect(byEra.place.chosen.because).toEqual(["target.era=2026（confirmed）"])
    expect(byEra.place.candidatesExcluded[0].because).toContain("era-mismatch")
    const byIdentity: any = await checkPlace({ place: { name: "Zürich" }, candidates: CANDIDATES, target: { identity: { gde_hist_id: 13688 } } }, {}, signal)
    expect(byIdentity.place.status).toBe("resolved-by-evidence")
    expect(byIdentity.place.chosen.id).toBe("zh-2026")
    expect(byIdentity.place.candidatesExcluded[0].because).toContain("identity-conflict")
  })

  test("证据把候选筛空 → 仍 ambiguous（不硬凑一个），且要求先回查证据本身", async () => {
    const report: any = await checkPlace({ place: { name: "Zürich" }, candidates: CANDIDATES, target: { era: { label: "2026", status: "confirmed" }, identity: { gde_hist_id: 99999 } } }, {}, signal)
    expect(report.place.status).toBe("ambiguous")
    expect(report.place.chosen).toBeNull()
    expect(report.place.reason).toContain("筛空")
    expect(report.place.candidatesExcluded).toHaveLength(2)
  })

  test("负对照①：只有一个同名候选（无竞争者）→ 按唯一性采用并显式说明依据不是身份判定", async () => {
    const report: any = await checkPlace({ place: { name: "Zürich" }, candidates: [CANDIDATES[0]] }, {}, signal)
    expect(report.place.status).toBe("single-candidate")
    expect(report.place.chosen).toMatchObject({ id: "zh-2026" })
    expect(report.place.chosen.because).toEqual(["no-competing-candidate（同名候选只有一个）"])
    expect(report.place.candidates).toHaveLength(1)
    expect(report.place.sameNameDifferentIdentity).toBe(false)
  })

  test("负对照②：没有候选匹配名称 → no-candidate（不虚构候选）", async () => {
    const report: any = await checkPlace({ place: { name: "Baden" }, candidates: CANDIDATES }, {}, signal)
    expect(report.place.status).toBe("no-candidate")
    expect(report.place.nameMatchedCount).toBe(0)
    expect(report.place.chosen).toBeNull()
  })
})

describe("ENV-41 目标年代核对", () => {
  test("年代不同 → era-mismatch 排除 + backQuery.eras；年代一致 → 不报 mismatch（负对照③）", async () => {
    const mismatched: any = await checkPlace({ place: { name: "Zürich" }, candidates: CANDIDATES, target: { era: { label: "2026", status: "confirmed" } } }, {}, signal)
    expect(mismatched.era.declared).toBe(true)
    expect(mismatched.era.excluded).toHaveLength(1)
    expect(mismatched.era.excluded[0].because).toContain("era-mismatch")
    expect(mismatched.era.backQuery).toEqual({ eras: ["2026", "1954"], eraMismatch: true })
    const consistent: any = await checkPlace({ place: { name: "Zürich" }, candidates: [CANDIDATES[0]], target: { era: { label: "2026", status: "confirmed" } } }, {}, signal)
    expect(consistent.era.excluded).toEqual([])
    expect(consistent.era.backQuery.eraMismatch).toBe(false)
    expect(consistent.era.note).toContain("没有候选因年代被排除")
  })

  test("未声明 target.era → 显式写「未做年代排除」，且不排除任何候选", async () => {
    const report: any = await checkPlace({ place: { name: "Zürich" }, candidates: CANDIDATES }, {}, signal)
    expect(report.era.declared).toBe(false)
    expect(report.era.excluded).toEqual([])
    expect(report.era.note).toContain("没有做年代排除")
    expect(report.era.backQuery.eras).toEqual(["2026", "1954"])
  })
})

describe("ENV-41 边界核对", () => {
  const boundary = { geojson: SQUARE, ...FRAME, toleranceM: 5 }
  test("内部点 → inside + 到边界米数", async () => {
    const report: any = await checkPlace({ place: { name: "Zürich" }, candidates: CANDIDATES, boundary: { ...boundary, coordinate: { lon: 8.505, lat: 47.355, name: "方块内" } } }, {}, signal)
    expect(report.boundary.status).toBe("inside")
    expect(report.boundary.inside).toBe(true)
    expect(report.boundary.distanceToBoundaryM).toBeGreaterThan(0)
    expect(report.boundary.note).toContain("在边界内")
  })

  test("边界上的点 → on-boundary（|距离| ≤ 容差）", async () => {
    const report: any = await checkPlace({ place: { name: "Zürich" }, candidates: CANDIDATES, boundary: { ...boundary, coordinate: { lon: 8.50, lat: 47.355, name: "边界顶点" } } }, {}, signal)
    expect(report.boundary.status).toBe("on-boundary")
    expect(report.boundary.distanceToBoundaryM).toBeLessThanOrEqual(5)
  })

  test("越界点 → outside 明确报出（不是静默算成在范围内）", async () => {
    const report: any = await checkPlace({ place: { name: "Zürich" }, candidates: CANDIDATES, boundary: { ...boundary, coordinate: { lon: 8.60, lat: 47.45, name: "方块外" } } }, {}, signal)
    expect(report.boundary.status).toBe("outside")
    expect(report.boundary.inside).toBe(false)
    expect(report.boundary.distanceToBoundaryM).toBeGreaterThan(0)
    expect(report.boundary.note).toContain("越界")
    expect(report.summary.needBackQuery).toContain("boundary")
  })

  test("负对照④：没给边界几何 → boundary-unavailable（不假设任何点在边界内）", async () => {
    const report: any = await checkPlace({ place: { name: "Zürich" }, candidates: CANDIDATES }, {}, signal)
    expect(report.boundary.status).toBe("unavailable")
    expect(report.boundary.reason).toContain("boundary-unavailable")
    expect(report.summary.needBackQuery).not.toContain("boundary")
  })
})

describe("ENV-41 相邻地标核对", () => {
  test("地标匹配 → matched（负对照⑤）；不匹配 → mismatch + 回查项", async () => {
    const report: any = await checkPlace({
      place: { name: "Zürich" }, candidates: CANDIDATES, boundary: { geojson: SQUARE, ...FRAME, toleranceM: 5, coordinate: { lon: 8.505, lat: 47.355, name: "方块内" } },
      landmarks: [
        { name: "方块东邻点", lon: 8.5095, lat: 47.355, page: "https://example.invalid/a", expected: { withinM: 500, bearingDeg: 90, bearingToleranceDeg: 20, inside: true } },
        { name: "远处的地标", lon: 8.60, lat: 47.45, page: "https://example.invalid/b", expected: { withinM: 100, inside: false } },
      ],
    }, {}, signal)
    const [matched, mismatched] = report.landmarks.items
    expect(matched.status).toBe("matched")
    expect(matched.checks.every((check: any) => check.matched)).toBe(true)
    expect(matched.distanceM).toBeGreaterThan(0)
    expect(mismatched.status).toBe("mismatch")
    expect(mismatched.note).toContain("回查")
    expect(mismatched.note).toContain("不说")
    expect(report.summary.landmarkMismatches).toBe(1)
    expect(report.summary.needBackQuery).toContain("landmark:远处的地标")
  })

  test("没给 expected → 只报测量不下结论；没给 landmarks → 不虚构地标", async () => {
    const measured: any = await checkPlace({
      place: { name: "Zürich" }, candidates: CANDIDATES, frame: FRAME,
      landmarks: [{ name: "无期望的地标", lon: 8.50, lat: 47.35, page: "https://example.invalid/c" }],
    }, {}, signal)
    expect(measured.landmarks.items[0].status).toBe("measured-only")
    expect(measured.landmarks.items[0].expected).toBeNull()
    expect(measured.landmarks.items[0].note).toContain("不下匹配结论")
    const none: any = await checkPlace({ place: { name: "Zürich" }, candidates: CANDIDATES }, {}, signal)
    expect(none.landmarks.status).toBe("none")
    expect(none.landmarks.items).toEqual([])
    expect(none.summary.landmarkMismatches).toBe(0)
  })

  test("判据原文随结果返回，且 eraAssertion 恒为 not-asserted", async () => {
    const report: any = await checkPlace({ place: { name: "Zürich" }, candidates: CANDIDATES }, {}, signal)
    expect(report.place.rule).toContain("不擅自选定")
    expect(report.era.rule).toContain("未做年代排除")
    expect(report.boundary.rule).toContain("越界不得静默")
    expect(report.landmarks.rule).toContain("不说「哪个错了」")
    expect(report.eraAssertion).toBe("not-asserted")
  })
})
