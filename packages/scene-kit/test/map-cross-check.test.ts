/**
 * ENV-43 多来源交叉校对（`crossCheckSources` / 工具 `map_cross_check_sources`）的真实行为测试。
 *
 * 数据是真的：fixtures/swisstopo-zurich-2026-4326.geojson 与 -1954- 是 swisstopo 官方 Gemeindegebiet
 * 原样拷贝（含官方自报 perimeter/gemflaeche）。两条量都先由 `map_geojson_to_local` 换算成局部米制顶点后
 * 现算周长（派生值），所以"地图量得"这一侧没有硬编码数字。
 *
 * 覆盖：两个年代的真实不一致 → conflict 且回查对象/年代；同一份数据的派生值 vs 官方自报 → agree（负对照：
 * 不得虚构冲突）；缺容差/单位不同/对象不同/只有一个来源 → unverifiable 且不判冲突；相机事实原样回显；
 * 参数校验复用既有口径（缺 basis、容差非法、没有 sources）。
 * 运行：`bun test packages/scene-kit/test/map-cross-check.test.ts`
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { crossCheckSources, mapGeoJsonToLocal } from "../src/map-constraints.ts"

const FIXTURES = join(import.meta.dir, "fixtures")
const readJson = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"))
const signal = new AbortController().signal
const ANCHOR = { lon: 8.5417, lat: 47.3769 }
const PAGE = "https://api3.geo.admin.ch/rest/services/api/MapServer/find?layer=ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill&searchText=Z%C3%BCrich"
const OBJECT = "苏黎世市界（swisstopo Gemeindegebiet）"

/** 用局部米制顶点与 rings 划分算周长（与 map-constraints-real-data.test.ts 同一口径：派生值）。 */
function perimeterOf(features: any[]): number {
  const length = (ring: number[][]) => ring.reduce((sum, [x1, y1], index) => index + 1 < ring.length ? sum + Math.hypot(ring[index + 1]![0]! - x1, ring[index + 1]![1]! - y1) : sum, 0)
  let perimeterM = 0
  for (const feature of features) {
    const flat = feature.vertices.map((vertex: any) => vertex.local.slice(0, 2))
    for (const ring of feature.rings ?? []) perimeterM += length(flat.slice(ring.start, ring.start + ring.count))
  }
  return perimeterM
}

const localPerimeter = async (file: string) => perimeterOf(((await mapGeoJsonToLocal({ path: join(FIXTURES, file), crs: "EPSG:4326", anchor: ANCHOR }, {}, signal)) as any).features)
const iso = (value: number) => Number(value.toFixed(3))

const measured = (id: string, era: string, value: number, page = PAGE, object = OBJECT) => ({
  id, kind: "map",
  source: { page, retrievedAt: "2026-09-20T04:16:00Z", object, era: { label: era, status: "confirmed" }, license: "swisstopo 开放数据（须署名）" },
  declaredValues: [{ name: "周长", value: iso(value), unit: "m", basis: "measured", source: `局部米制顶点算得（${era} 几何）` }],
})

const TOLERANCE = { relativePpm: 1000 }   // 0.1%：调用方声明的容差，本工具不自己挑阈值

describe("ENV-43 交叉校对：可区分的冲突结论 + 回查对象/年代/相机", () => {
  test("两个年代的真实几何不一致：判 conflict，并回查对象与两个年代", async () => {
    const [p2026, p1954] = [await localPerimeter("swisstopo-zurich-2026-4326.geojson"), await localPerimeter("swisstopo-zurich-1954-4326.geojson")]
    const report: any = crossCheckSources({ sources: [measured("地图-2026", "2026", p2026), measured("地图-1954", "1954", p1954)], tolerance: TOLERANCE })
    expect(report.summary.conflicts).toEqual(["周长"])
    expect(report.summary.conflicted).toBe(1)
    const row = report.values[0]
    expect(row.verdict).toBe("conflict")
    expect(row.reference.sourceId).toBe("地图-2026")
    const outlier = row.comparisons.find((item: any) => item.sourceId === "地图-1954")
    expect(outlier.withinTolerance).toBe(false)
    expect(outlier.deltaFromReference).toBeCloseTo(p1954 - p2026, 3)
    expect(row.backQuery.objects).toEqual([OBJECT])
    expect(row.backQuery.eraMismatch).toBe(true)
    expect(row.backQuery.eras).toEqual(["2026（confirmed）", "1954（confirmed）"])
    expect(row.note).toContain("先回查要哪个年代")
    expect(report.eraAssertion).toBe("not-asserted")
  })

  test("负对照：同一份 2026 数据的派生周长与官方自报 perimeter 一致 → agree，不虚构冲突", async () => {
    const p2026 = await localPerimeter("swisstopo-zurich-2026-4326.geojson")
    const official = readJson("swisstopo-zurich-2026-4326.geojson").features[0].properties.perimeter
    const report: any = crossCheckSources({
      sources: [measured("地图-2026", "2026", p2026), measured("官方自报-2026", "2026", official)],
      tolerance: TOLERANCE,
    })
    expect(report.summary).toMatchObject({ conflicted: 0, agreed: 1, conflicts: [] })
    const row = report.values[0]
    expect(row.verdict).toBe("agree")
    expect(row.comparisons.every((item: any) => item.withinTolerance === true)).toBe(true)
    // 派生值与官方量确实有微小差异（不是逐位相同），但仍在容差内：这才是"没虚构冲突"的实证。
    expect(Math.abs(p2026 - official)).toBeGreaterThan(0)
    expect(Math.abs(p2026 - official)).toBeLessThan(official * TOLERANCE.relativePpm / 1e6)
  })

  test("缺容差不猜阈值：判 unverifiable（tolerance-missing），而不是随便判冲突或一致", async () => {
    const report: any = crossCheckSources({ sources: [measured("地图-2026", "2026", 1000), measured("地图-1954", "1954", 2000)] })
    expect(report.tolerance).toBeNull()
    expect(report.summary).toMatchObject({ conflicted: 0, agreed: 0, unverifiable: 1, conflicts: [] })
    expect(report.values[0].verdict).toBe("unverifiable")
    expect(report.values[0].reason).toContain("tolerance-missing")
    expect(report.values[0].comparisons[0].withinTolerance).toBeNull()
  })

  test("单位不同不换算：判 unverifiable（unit-mismatch），并列出两侧单位", async () => {
    const report: any = crossCheckSources({
      sources: [measured("地图-2026", "2026", 58650.67), { ...measured("图纸-英制", "2026", 192421.5), declaredValues: [{ name: "周长", value: 192421.5, unit: "ft", basis: "measured", source: "图纸（英尺）" }] }],
      tolerance: TOLERANCE,
    })
    expect(report.summary.conflicts).toEqual([])
    expect(report.values[0].verdict).toBe("unverifiable")
    expect(report.values[0].unit).toEqual(["m", "ft"])
    expect(report.values[0].reason).toContain("unit-mismatch")
  })

  test("对象不同不是数值冲突：判 unverifiable（subject-mismatch）", async () => {
    const report: any = crossCheckSources({
      sources: [measured("地图-2026", "2026", 58650.67), measured("CAD-车站", "2026", 333, "file:///dwg/zurich-hb.dwg", "苏黎世火车总站站房")],
      tolerance: TOLERANCE,
    })
    expect(report.summary.conflicts).toEqual([])
    expect(report.values[0].verdict).toBe("unverifiable")
    expect(report.values[0].reason).toContain("subject-mismatch")
    expect(report.values[0].backQuery.objectMismatch).toBe(true)
    expect(report.values[0].comparisons.find((item: any) => item.sourceId === "CAD-车站").withinTolerance).toBe(false)
  })

  test("只有一个来源：unverifiable（single-source），不判冲突", () => {
    const report: any = crossCheckSources({ sources: [measured("地图-2026", "2026", 58650.67)], tolerance: TOLERANCE })
    expect(report.summary).toMatchObject({ conflicted: 0, unverifiable: 1, conflicts: [] })
    expect(report.values[0].reason).toContain("single-source")
  })

  test("照片来源：相机事实原样回显，estimated 值照实标注（不做摄影测量、不升格成实测）", () => {
    const camera = { model: "iPhone 15 Pro 主摄", focalLengthMm: 24, sensorWidthMm: 9.8, imageWidthPx: 4032, capturedAt: "2026-09-19T15:04:00+02:00" }
    const report: any = crossCheckSources({
      sources: [
        measured("地图-2026", "2026", 58650.67),
        { id: "照片-2026", kind: "photo", source: { page: "https://example.invalid/photo", object: OBJECT, era: { label: "2026", status: "unconfirmed" } }, camera, declaredValues: [{ name: "周长", value: 63342.72, unit: "m", basis: "estimated", source: "相机参数 + 像素跨度推算" }] },
      ],
      tolerance: TOLERANCE,
    })
    expect(report.summary.conflicts).toEqual(["周长"])
    expect(report.backQuery.cameras).toEqual([{ sourceId: "照片-2026", camera }])
    expect(report.values[0].backQuery.cameras[1]).toEqual(camera)
    const estimated = report.values[0].comparisons.find((item: any) => item.sourceId === "照片-2026")
    expect(estimated.basis).toBe("estimated")
    expect(estimated.withinTolerance).toBe(false)
    expect(report.values[0].note).toContain("estimated")
    expect(report.notes.join(" ")).toContain("不做摄影测量")
  })

  test("参数校验复用既有口径：没有 sources、容差非法、缺 basis 都明确报错", () => {
    expect(() => crossCheckSources({})).toThrow(/MAP_CROSS_CHECK_SOURCES_REQUIRED/)
    expect(() => crossCheckSources({ sources: [measured("a", "2026", 1)], tolerance: { relativePpm: -1 } })).toThrow(/MAP_CROSS_CHECK_TOLERANCE_INVALID/)
    expect(() => crossCheckSources({ sources: [measured("a", "2026", 1), { id: "b", source: { object: OBJECT }, declaredValues: [{ name: "周长", value: 2, unit: "m" }] }], tolerance: TOLERANCE })).toThrow(/MAP_VALUE_BASIS_REQUIRED/)
    expect(() => crossCheckSources({ sources: [{ id: "a", camera: () => 1, declaredValues: [] }] })).toThrow(/MAP_CROSS_CHECK_CAMERA_INVALID/)
  })
})
