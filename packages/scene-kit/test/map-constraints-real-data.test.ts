/**
 * 真实公开数据 + 独立口径（PROJ）验收：
 *
 *  · fixtures/swisstopo-zurich-2026-4326.geojson / -1954-：swisstopo（geo.admin.ch）官方 Gemeindegebiet
 *    要素原样拷贝（未改一个坐标与属性），带官方自报量 gemflaeche（公顷）与 perimeter（米）。
 *    用它核对：局部米制算出的面积/周长与官方量一致、逐点可逆、缺高度不补、年代不同几何确实不同。
 *  · fixtures/usgs-quakes-antimeridian-2026-06.geojson：USGS FDSN 目录里跨 ±180 的事件子集（坐标属性原样）。
 *    第三位序数是震源深度——它必须不被当成高度。
 *  · fixtures/proj-reference.json：pyproj 3.7.1 / PROJ 9.5.1 独立算出的 UTM / Web 墨卡托 / 大地线对照值
 *    （生成脚本见任务 runtime 的 checks/make_proj_fixture.py；pyproj 不是产品依赖）。
 *
 * 数据文件里的 note 字段写明了来源页与抓取时间；这里断言的是数值关系，不是复述源码。
 * 运行：`bun test packages/scene-kit/test/map-constraints-real-data.test.ts`
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  geodesicDistanceM, geodeticToSource, localToSourceBatch, parseSourceCrs, sourceToGeodetic,
} from "../src/map-constraints.ts"
import { mapGeoJsonToLocal } from "../src/map-constraints.ts"

const FIXTURES = join(import.meta.dir, "fixtures")
const readJson = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"))
const signal = new AbortController().signal

/** 苏黎世市中心（调用方声明的局部原点，与来源文件无关）。 */
const anchor = { lon: 8.5417, lat: 47.3769 }
const zurich2026 = readJson("swisstopo-zurich-2026-4326.geojson")
const zurich1954 = readJson("swisstopo-zurich-1954-4326.geojson")
const usgs = readJson("usgs-quakes-antimeridian-2026-06.geojson")
const proj = readJson("proj-reference.json")

const officialOf = (collection: any) => collection.features[0].properties as Record<string, number>

/** 用工具返回的局部米制顶点与 rings 划分算面积（外环加、洞减）与周长。 */
function localMetrics(features: any[]) {
  const twiceArea = (ring: number[][]) => ring.reduce((sum, [x1, y1], index) => index + 1 < ring.length ? sum + x1 * ring[index + 1]![1]! - ring[index + 1]![0]! * y1 : sum, 0)
  const length = (ring: number[][]) => ring.reduce((sum, [x1, y1], index) => index + 1 < ring.length ? sum + Math.hypot(ring[index + 1]![0]! - x1, ring[index + 1]![1]! - y1) : sum, 0)
  let areaM2 = 0, perimeterM = 0
  for (const feature of features) {
    const flat = feature.vertices.map((vertex: any) => vertex.local.slice(0, 2))
    for (const ring of feature.rings ?? []) {
      if (ring.role === "line") continue
      const slice = flat.slice(ring.start, ring.start + ring.count)
      const area = Math.abs(twiceArea(slice)) / 2
      areaM2 += ring.role === "outer" ? area : -area
      perimeterM += length(slice)
    }
  }
  return { areaM2, perimeterM }
}

describe("官方 swisstopo 市界（EPSG:4326，原样要素）", () => {
  test("局部米制算出的面积/周长与官方自报的 gemflaeche/perimeter 一致", async () => {
    const result = await mapGeoJsonToLocal({
      path: join(FIXTURES, "swisstopo-zurich-2026-4326.geojson"),
      crs: "EPSG:4326", anchor,
      source: { page: zurich2026.note, retrievedAt: "2026-09-20T04:16:00Z", object: "苏黎世市界 2026", era: { label: "2026", status: "unconfirmed" } },
    }, {}, signal)
    const official = officialOf(zurich2026)
    const metrics = localMetrics(result.features as any[])
    const officialAreaM2 = official.gemflaeche! * 10000
    // 官方面积是按 LV95 网格算的、并有取整；ENU 切平面在 ~7 km 尺度误差是 ppm 级。
    // 实测相对差：面积 ~6e-5、周长 ~2e-5，判据留到 1e-3（比口径差宽、比"换算坏了"窄）。
    expect(Math.abs(metrics.areaM2 - officialAreaM2) / officialAreaM2).toBeLessThan(1e-3)
    expect(Math.abs(metrics.perimeterM - official.perimeter!) / official.perimeter!).toBeLessThan(1e-3)
    // 范围来自真实数据：苏黎世市界约 13.4 km × 12.7 km
    const extent = result.extent as any
    expect(extent.localMeters.widthM).toBeGreaterThan(13000)
    expect(extent.localMeters.widthM).toBeLessThan(14000)
    expect((result.limits as any).totalVertices).toBe(2090)
    expect((result.features as any[])[0].sourceYear).toBe(2026)
    expect((result.features as any[])[0].sourceMeasures).toMatchObject({ gemflaeche: official.gemflaeche, perimeter: official.perimeter })
  })

  test("2090 个顶点逐点可逆回来源坐标；年代未确认时 eraMatch 仍是 not-asserted", async () => {
    const result = await mapGeoJsonToLocal({ path: join(FIXTURES, "swisstopo-zurich-2026-4326.geojson"), crs: "EPSG:4326", anchor, source: { era: { label: "2026", status: "unconfirmed" } } }, {}, signal)
    const crs = parseSourceCrs("EPSG:4326")
    const vertices = (result.features as any[]).flatMap(feature => feature.vertices)
    // 整批反算（两次 PROJ 调用），而不是逐点起子进程——这正是导出的批量函数存在的理由。
    const back = await localToSourceBatch(crs, (result.anchor as any).geodetic, vertices.map((vertex: any) => vertex.local))
    let worst = 0
    for (const [index, vertex] of vertices.entries()) {
      worst = Math.max(worst, Math.abs(back[index]![0] - vertex.source[0]), Math.abs(back[index]![1] - vertex.source[1]))
    }
    expect(vertices.length).toBe(2090)
    expect(worst).toBeLessThan(1e-9)
    expect(result.eraAssertion).toBe("not-asserted")
  })

  test("官方文件的外环是顺时针（违反 RFC 7946）：照实上报并警告，不悄悄翻转坐标", async () => {
    const result = await mapGeoJsonToLocal({ path: join(FIXTURES, "swisstopo-zurich-2026-4326.geojson"), crs: "EPSG:4326", anchor }, {}, signal)
    const rings = (result.features as any[])[0].rings
    expect(rings.map((ring: any) => ring.role)).toEqual(["outer"])
    expect(rings[0].winding).toBe("cw")
    expect((result.warnings as string[]).join(" ")).toContain("RFC 7946")
    expect(rings[0].closed).toBe(true)
  })

  test("缺高度不补：市界多边形没有任何高度，结果里也不出现被编造的建筑高度", async () => {
    const result = await mapGeoJsonToLocal({ path: join(FIXTURES, "swisstopo-zurich-2026-4326.geojson"), crs: "EPSG:4326", anchor }, {}, signal)
    const feature = (result.features as any[])[0]
    expect(feature.height).toMatchObject({ present: false, meters: null })
    expect(feature.bboxLocal.minUp).toBeNull()
    expect(feature.bboxLocal.maxUp).toBeNull()
    expect((result.heightSummary as any).featuresWithSourceHeight).toBe(0)
    // 局部 y（北）与局部 z（上）不是一回事：结果里没有把来源面积当高度之类的替代量
    expect(Object.keys(feature.height).sort()).toEqual(["meaning", "meters", "present", "source"])
  })

  test("1954 年与 2026 年不是同一条边界：年代未确认时不得当成对应", async () => {
    const older = await mapGeoJsonToLocal({ path: join(FIXTURES, "swisstopo-zurich-1954-4326.geojson"), crs: "EPSG:4326", anchor, source: { era: { label: "1954", status: "unconfirmed" } } }, {}, signal)
    const current = await mapGeoJsonToLocal({ path: join(FIXTURES, "swisstopo-zurich-2026-4326.geojson"), crs: "EPSG:4326", anchor }, {}, signal)
    const olderArea = localMetrics(older.features as any[]).areaM2
    const currentArea = localMetrics(current.features as any[]).areaM2
    // 真实差异约 4.5%（面积），说明"年份"不是可省略的元数据
    expect(olderArea / currentArea).toBeLessThan(0.99)
    expect(olderArea / currentArea).toBeGreaterThan(0.90)
    expect((older.features as any[])[0].sourceYear).toBe(1954)
    expect((older.features as any[])[0].sourceMeasures.gemflaeche).toBeLessThan((current.features as any[])[0].sourceMeasures.gemflaeche)
    expect(older.eraAssertion).toBe("not-asserted")
  })
})

describe("PROJ 独立口径对照（pyproj 3.7.1 / PROJ 9.5.1 生成的参考值）", () => {
  test("对照夹具带出处（不是本仓自算的「参考值」）", () => {
    expect(proj.provenance.tool).toContain("PROJ")
    expect(proj.utm.length + proj.mercator.length + proj.geodesic.length).toBe(11)
  })

  test("UTM 正/反投影与 PROJ 一致到毫米级（四例全在各自带内）", async () => {
    for (const row of proj.utm as any[]) {
      const crs = parseSourceCrs(row.epsg)
      const [x, y] = await geodeticToSource(crs, { lon: row.lon, lat: row.lat, h: 0 })
      expect(Math.hypot(x - row.x, y - row.y)).toBeLessThan(1e-3)
      const back = await sourceToGeodetic(crs, row.x, row.y)
      expect(Math.hypot(back.lon - row.backLon, back.lat - row.backLat)).toBeLessThan(1e-8)
    }
  })

  test("Web 墨卡托正/反投影与 PROJ 一致（含高纬与原点）", async () => {
    for (const row of proj.mercator as any[]) {
      const crs = parseSourceCrs("EPSG:3857")
      const [x, y] = await geodeticToSource(crs, { lon: row.lon, lat: row.lat, h: 0 })
      expect(Math.hypot(x - row.x, y - row.y)).toBeLessThan(1e-6)
      const back = await sourceToGeodetic(crs, row.x, row.y)
      expect(Math.hypot(back.lon - row.backLon, back.lat - row.backLat)).toBeLessThan(1e-9)
    }
  })

  test("大地线距离与 PROJ 一致（含对跖点：PROJ geod 不含退化分支）", async () => {
    for (const row of proj.geodesic as any[]) {
      const result = await geodesicDistanceM({ lon: row.from[0], lat: row.from[1], h: 0 }, { lon: row.to[0], lat: row.to[1], h: 0 })
      // 与 pyproj 3.7.1/PROJ 9.5.1 生成的参照值逐条比：本机 PROJ 8.2.1 的 geod 与它是同一实现，毫米内一致
      expect(result.method).toBe("proj-geod")
      expect(Math.abs(result.meters - row.meters)).toBeLessThan(1e-3)
    }
  })
})

describe("USGS 跨 ±180 事件目录（第三位序数是深度，不是高度）", () => {
  test("换日线两侧的局部坐标是真实距离；最西/最东两条与 PROJ 大地线一致", async () => {
    const result = await mapGeoJsonToLocal({
      geojson: usgs, crs: "EPSG:4326", anchor: { lon: 179.5, lat: -17.5 }, zMeaning: "depth",
      source: { page: usgs.metadata.source, retrievedAt: "2026-09-20T04:16:00Z", object: "USGS 跨 ±180 地震目录子集" },
    }, {}, signal)
    expect((result.extent as any).geodesic.crossesAntimeridian).toBe(true)
    expect((result.warnings as string[]).join(" ")).toContain("±180")
    // 深度不是高度：所有事件都没有高度
    expect((result.heightSummary as any).featuresWithSourceHeight).toBe(0)
    expect((result.features as any[]).every((feature: any) => feature.height.present === false)).toBe(true)
    // 真实数据里的最西/最东两条：与 PROJ 的大地线值一致（约 10.4 km，绝不是绕一圈）
    const pair = (proj.geodesic as any[]).find(row => row.what.includes("USGS"))
    const geodesic = await geodesicDistanceM({ lon: pair.from[0], lat: pair.from[1], h: 0 }, { lon: pair.to[0], lat: pair.to[1], h: 0 })
    expect(Math.abs(geodesic.meters - pair.meters)).toBeLessThan(1e-3)
    expect(pair.meters).toBeLessThan(20000)
    // 同一对点在返回的局部米制坐标里也是这个量级（自洽）
    const points = (result.features as any[]).filter(feature => (feature.vertices[0].source[0] === pair.from[0]))
    const other = (result.features as any[]).filter(feature => (feature.vertices[0].source[0] === pair.to[0]))
    const [east, north] = points[0].vertices[0].local
    const [east2, north2] = other[0].vertices[0].local
    expect(Math.hypot(east2 - east, north2 - north)).toBeGreaterThan(9000)
    expect(Math.hypot(east2 - east, north2 - north)).toBeLessThan(12000)
  })
})
