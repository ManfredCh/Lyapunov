/**
 * ENV-15 字段级融合（`fuseDeclaredFields` / 工具 `map_fuse_fields`）的真实行为测试。
 *
 * 覆盖：采信按依据不按来源类别（CAD 输给地图、地图输给 CAD 各一例）、年代不同排除并回查（eraMismatch）、
 * 冲突不静默（value=null 且不取平均）、缺字段不补不猜、以及交叉校对同源的四种不可比原因
 * （tolerance-missing / unit-mismatch / subject-mismatch / 三源一致不虚构冲突）。
 * 年代与冲突用例的数值来自真实 swisstopo 2026/1954 几何（先经 map_geojson_to_local 算局部米制周长）。
 * 运行：`bun test packages/scene-kit/test/map-field-fusion.test.ts`
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fuseDeclaredFields, mapGeoJsonToLocal } from "../src/map-constraints.ts"

const FIXTURES = join(import.meta.dir, "fixtures")
const signal = new AbortController().signal
const ANCHOR = { lon: 8.5417, lat: 47.3769 }
const OBJECT = "苏黎世市界（swisstopo Gemeindegebiet）"
const TOLERANCE = { relativePpm: 1000 }

function perimeterOf(features: any[]): number {
  const length = (ring: number[][]) => ring.reduce((sum, [x1, y1], index) => index + 1 < ring.length ? sum + Math.hypot(ring[index + 1]![0]! - x1, ring[index + 1]![1]! - y1) : sum, 0)
  let perimeterM = 0
  for (const feature of features) {
    const flat = feature.vertices.map((vertex: any) => vertex.local.slice(0, 2))
    for (const ring of feature.rings ?? []) perimeterM += length(flat.slice(ring.start, ring.start + ring.count))
  }
  return perimeterM
}
const realPerimeter = async (file: string) => perimeterOf(((await mapGeoJsonToLocal({ path: join(FIXTURES, file), crs: "EPSG:4326", anchor: ANCHOR }, {}, signal)) as any).features)

const valued = (id: string, kind: string, name: string, value: number, unit: string, basis: string, options: { object?: string; era?: { label: string; status: string } } = {}) => ({
  id, kind,
  source: { page: `https://example.invalid/${id}`, object: options.object ?? OBJECT, era: options.era ?? { label: "2026", status: "confirmed" } },
  declaredValues: [{ name, value, unit, basis, source: `${id} 声明` }],
})

describe("ENV-15 字段级融合：采信按依据，不按来源类别", () => {
  test("CAD 输给地图：CAD 的 estimated 与地图的 measured 都在容差内 → 取地图（依据是 basis，不是类别）", () => {
    const report: any = fuseDeclaredFields({
      target: { object: OBJECT, era: { label: "2026", status: "confirmed" } }, tolerance: TOLERANCE,
      sources: [
        valued("地图-2026", "map", "面积", 27.2, "m2", "measured"),
        valued("CAD-2026", "cad", "面积", 27.21, "m2", "estimated"),
      ],
    })
    const field = report.fields[0]
    expect(report.summary.conflictUnresolved).toBe(0)
    expect(field.status).toBe("adopted")
    expect(field.value).toBe(27.2)
    expect(field.adoptedFrom).toMatchObject({ sourceId: "地图-2026", kind: "map", basis: "measured" })
    expect(field.reason).toContain("basis 最高的「measured」候选")
    expect(field.reason).toContain("kind=map，仅作标识，不参与排序")
    expect(field.candidates.find((candidate: any) => candidate.sourceId === "CAD-2026")).toMatchObject({ basis: "estimated", withinTolerance: true })
  })

  test("地图输给 CAD：地图的 estimated 与 CAD 的 measured 一致 → 取 CAD（同一规则的反向结果）", () => {
    const report: any = fuseDeclaredFields({
      target: { object: OBJECT, era: { label: "2026", status: "confirmed" } }, tolerance: TOLERANCE,
      sources: [
        valued("地图-2026", "map", "进深", 6.0, "m", "estimated"),
        valued("CAD-2026", "cad", "进深", 6.0, "m", "measured"),
      ],
    })
    expect(report.fields[0].status).toBe("adopted")
    expect(report.fields[0].adoptedFrom).toMatchObject({ sourceId: "CAD-2026", kind: "cad", basis: "measured" })
  })

  test("年代不同：与 target.era 不同的候选被排除并回查（eraMismatch），不静默合并", async () => {
    const [p2026, p1954] = [await realPerimeter("swisstopo-zurich-2026-4326.geojson"), await realPerimeter("swisstopo-zurich-1954-4326.geojson")]
    const report: any = fuseDeclaredFields({
      target: { object: OBJECT, era: { label: "2026", status: "confirmed" } }, tolerance: TOLERANCE, fields: [{ name: "周长", unit: "m" }],
      sources: [
        valued("地图-2026", "map", "周长", Number(p2026.toFixed(3)), "m", "measured"),
        valued("CAD-1954", "cad", "周长", Number(p1954.toFixed(3)), "m", "measured", { era: { label: "1954", status: "confirmed" } }),
      ],
    })
    const field = report.fields[0]
    expect(field.status).toBe("adopted")
    expect(field.value).toBe(Number(p2026.toFixed(3)))
    const excluded = field.candidates.find((candidate: any) => candidate.sourceId === "CAD-1954")
    expect(excluded.comparable).toBe(false)
    expect(excluded.excludedBecause).toContain("era-mismatch")
    expect(field.backQuery.eraMismatch).toBe(true)
    expect(field.backQuery.eras).toEqual(["2026（confirmed）", "1954（confirmed）"])
    expect(field.backQuery.action).toContain("CAD-1954")
    // 1954 的 64.7 km 没有被并进取值
    expect(field.value).toBeLessThan(p1954)
  })

  test("冲突不静默：两条 measured 超容差 → value=null、averaging=forbidden-by-rule、不取平均", () => {
    const report: any = fuseDeclaredFields({
      target: { object: OBJECT, era: { label: "2026", status: "confirmed" } }, tolerance: TOLERANCE,
      sources: [valued("地图-2026", "map", "周长", 58650.67, "m", "measured"), valued("CAD-2026", "cad", "周长", 58000, "m", "measured")],
    })
    const field = report.fields[0]
    expect(report.summary.conflictUnresolved).toBe(1)
    expect(field.status).toBe("conflict-unresolved")
    expect(field.value).toBeNull()
    expect(field.conflict).toMatchObject({ detected: true, outliers: ["CAD-2026"], averaging: "forbidden-by-rule" })
    expect(field.reason).toContain("不取平均/中位数、不按来源类别裁决")
    expect(field.value).not.toBe((58650.67 + 58000) / 2)
    expect(report.fusionRule).toContain("不取平均/中位数")
  })

  test("缺字段不补不猜：没有任何来源声明 → status=missing、value=null（高度例）", () => {
    const report: any = fuseDeclaredFields({
      target: { object: OBJECT, era: { label: "2026", status: "confirmed" } }, tolerance: TOLERANCE, fields: [{ name: "高度", unit: "m", required: true }],
      sources: [valued("地图-2026", "map", "周长", 58650.67, "m", "measured")],
    })
    expect(report.fields[0]).toMatchObject({ name: "高度", status: "missing", value: null, required: true })
    expect(report.missingPolicy).toContain("不补、不猜")
  })

  test("负对照①：三来源一致（measured×2 + estimated）→ 全部可比、无冲突", () => {
    const report: any = fuseDeclaredFields({
      target: { object: OBJECT, era: { label: "2026", status: "confirmed" } }, tolerance: TOLERANCE,
      sources: [
        valued("地图-2026", "map", "周长", 58650.67, "m", "measured"),
        valued("官方-2026", "公开尺寸", "周长", 58651.72, "m", "measured"),
        valued("照片-2026", "photo", "周长", 58674.13, "m", "estimated"),
      ],
    })
    expect(report.summary).toMatchObject({ adopted: 1, conflictUnresolved: 0, needBackQuery: [] })
    expect(report.fields[0].candidates.every((candidate: any) => candidate.comparable && candidate.withinTolerance)).toBe(true)
  })

  test("负对照②：单位不同（m vs ft）→ 全部不可比、不换算、不产出取值", () => {
    const report: any = fuseDeclaredFields({
      target: { object: OBJECT, era: { label: "2026", status: "confirmed" } }, tolerance: TOLERANCE, fields: [{ name: "周长", unit: "m" }],
      sources: [valued("地图-2026", "map", "周长", 58650.67, "m", "measured"), valued("图纸-英制", "cad", "周长", 192423.46, "ft", "measured")],
    })
    expect(report.fields[0].status).toBe("missing")
    expect(report.fields[0].value).toBeNull()
    expect(report.fields[0].reason).toContain("unit-mismatch")
    expect(report.fields[0].candidates.every((candidate: any) => candidate.comparable === false)).toBe(true)
  })

  test("负对照③：对象不同 → 该候选不比较（subject-mismatch），其余照常融合", () => {
    const report: any = fuseDeclaredFields({
      target: { object: OBJECT, era: { label: "2026", status: "confirmed" } }, tolerance: TOLERANCE,
      sources: [valued("地图-2026", "map", "周长", 58650.67, "m", "measured"), valued("CAD-车站", "cad", "周长", 333, "m", "measured", { object: "苏黎世火车总站站房" })],
    })
    expect(report.fields[0].status).toBe("adopted")
    expect(report.fields[0].value).toBe(58650.67)
    expect(report.fields[0].candidates.find((candidate: any) => candidate.sourceId === "CAD-车站").excludedBecause).toContain("subject-mismatch")
    expect(report.fields[0].backQuery.objectMismatch).toBe(true)
    expect(report.summary.needBackQuery).toEqual(["周长"])
  })

  test("负对照④：缺容差 → unverifiable(tolerance-missing)，不猜阈值", () => {
    const report: any = fuseDeclaredFields({
      target: { object: OBJECT, era: { label: "2026", status: "confirmed" } },
      sources: [valued("地图-2026", "map", "周长", 58650.67, "m", "measured"), valued("CAD-2026", "cad", "周长", 58000, "m", "measured")],
    })
    expect(report.tolerance).toBeNull()
    expect(report.fields[0].status).toBe("unverifiable")
    expect(report.fields[0].reason).toContain("tolerance-missing")
    expect(report.summary.conflictUnresolved).toBe(0)
  })

  test("参数校验：没有 sources、目标年代不完整、fields 缺 name、相机不可序列化都明确报错", () => {
    expect(() => fuseDeclaredFields({})).toThrow(/MAP_FUSION_SOURCES_REQUIRED/)
    expect(() => fuseDeclaredFields({ sources: [valued("a", "map", "周长", 1, "m", "measured")], target: { era: { label: "2026" } } })).toThrow(/MAP_FUSION_TARGET_ERA_INVALID/)
    expect(() => fuseDeclaredFields({ sources: [valued("a", "map", "周长", 1, "m", "measured")], fields: [{}] })).toThrow(/MAP_FUSION_FIELDS_INVALID/)
    expect(() => fuseDeclaredFields({ sources: [{ id: "a", camera: () => 1, declaredValues: [] }] })).toThrow(/MAP_CROSS_CHECK_CAMERA_INVALID/)
  })

  test("规则原文随结果返回：不按类别给权重 / 年代不静默合并 / 冲突不平均 / 缺项不编", () => {
    const report: any = fuseDeclaredFields({ sources: [valued("a", "map", "周长", 1, "m", "measured")], tolerance: TOLERANCE })
    expect(report.fusionRule).toContain("不按来源类别给权重")
    expect(report.fusionRule).toContain("不静默合并")
    expect(report.fusionRule).toContain("不补不猜")
    expect(report.eraAssertion).toBe("not-asserted")
  })
})
