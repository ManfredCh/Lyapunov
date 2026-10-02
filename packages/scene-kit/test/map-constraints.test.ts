/**
 * ENV-41/42/43 程序侧薄片的真实行为测试：`map_geojson_to_local` 把"调用方显式声明 CRS 的 GeoJSON +
 * 显式锚点"换算成局部 ENU 米制坐标，并保留可逆原坐标、真实范围、单位说明与**实测**畸变。
 *
 * 覆盖的是行为而不是源码复述：拒绝矩阵（缺 CRS / 不支持的 CRS / 投影数值伪装成经纬度）、
 * 局部原点往返、跨 ±180、缺高度不编造、测量/估计分栏、来源元数据与年代不断言、顶点上限与取消，
 * 以及**真 ToolRegistry**（真 Context + dsh-tools）上的注册与执行结果形状。
 * 真实公开数据（swisstopo 市界、USGS 跨换日线目录）与 PROJ 独立口径见 map-constraints-real-data.test.ts。
 * 运行：`bun test packages/scene-kit/test/map-constraints.test.ts`
 */
import { describe, expect, test } from "bun:test"
import { Context } from "@deepseek-ai/cordis"
import Sessions, { SessionId } from "@deepseek-ai/dsh-session"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import Tools, { type ToolExecutionResult } from "@deepseek-ai/dsh-tools"
import type { Agent } from "@deepseek-ai/dsh-agent"
import { ToolCallId } from "@deepseek-ai/dsh-llm"
import FsLocal from "@deepseek-ai/dsh-fs-local"
import { join } from "node:path"
import {
  assessDatumOperation, geodesicDistanceM, geodesicDistances, geodeticToLocal, geodeticToSource, localToGeodetic, localToSource, longitudeDelta,
  mapGeoJsonToLocal, normalizeLongitude, parseDatumPolicy, parseSourceCrs, sourceToGeodetic,
} from "../src/map-constraints.ts"
import { registerMapConstraintTools } from "../src/map-constraints.ts"

const signal = new AbortController().signal
/** 固定时间：结果里的 convertedAt 由注入依赖决定，断言不依赖跑测试的当下。 */
const deps = { now: () => new Date("2026-09-20T04:16:00Z") }
/** 官方数据夹具目录（真实公开数据，见 fixtures/*.geojson 里的 note）。 */
const FIXTURES = join(import.meta.dir, "fixtures")

/** 一个 0.01°×0.01° 的方块（约 1.1 km 见方），用来核对局部米制尺寸与往返。 */
const square = (lon = 8.5417, lat = 47.3769) => ({
  type: "FeatureCollection",
  features: [{
    type: "Feature", id: "square",
    properties: { name: "方块" },
    geometry: { type: "Polygon", coordinates: [[[lon, lat], [lon + 0.01, lat], [lon + 0.01, lat + 0.01], [lon, lat + 0.01], [lon, lat]]] },
  }],
})

async function convert(input: any) {
  return await mapGeoJsonToLocal(input, deps, signal)
}

describe("来源 CRS 必须显式声明且只接受可精确反算的一小组", () => {
  test("缺声明或不支持的 CRS 一律拒绝，绝不默认成 4326", () => {
    expect(() => parseSourceCrs(undefined)).toThrow(/MAP_CRS_REQUIRED/)
    expect(() => parseSourceCrs("")).toThrow(/MAP_CRS_REQUIRED/)
    // 这些是真实常见的非 WGS84 CRS：必须明确拒绝，而不是"看不懂就当经纬度"
    for (const declared of ["EPSG:2056", "EPSG:27700", "EPSG:4214", "EPSG:4547", "EPSG:2154"]) {
      expect(() => parseSourceCrs(declared)).toThrow(/MAP_CRS_UNSUPPORTED/)
    }
    try { parseSourceCrs("EPSG:2056") } catch (error) { expect((error as Error).message).toContain("2056") }
  })

  test("接受经纬度/Web 墨卡托/WGS84 UTM，并把单位、带号与已知口径写清楚", () => {
    expect(parseSourceCrs("EPSG:4326").kind).toBe("geographic")
    expect(parseSourceCrs("OGC:CRS84").kind).toBe("geographic")
    expect(parseSourceCrs("WGS84").units).toBe("degree")
    expect(parseSourceCrs("EPSG:4490").kind).toBe("geographic")
    expect(parseSourceCrs("EPSG:3857").kind).toBe("web-mercator")
    expect(parseSourceCrs("EPSG:3857").units).toBe("meter")
    const utm = parseSourceCrs("EPSG:32633")
    expect(utm.kind).toBe("utm")
    expect(utm.zone).toBe(33)
    expect(utm.hemisphere).toBe("north")
    expect(utm.notes.join(" ")).toContain("0.9996")
    expect(parseSourceCrs("EPSG:32756").hemisphere).toBe("south")
    expect(() => parseSourceCrs("EPSG:32699")).toThrow(/MAP_CRS_UNSUPPORTED/)
  })

  test("把投影坐标硬声明成经纬度会被拦住，而不是算出假位置", async () => {
    // 真实 LV95（EPSG:2056）坐标：东距 2685056.9、北距 1244517.8
    await expect(convert({ geojson: { type: "Point", coordinates: [2685056.9, 1244517.8] }, crs: "EPSG:4326", anchor: { lon: 8.5417, lat: 47.3769 } })).rejects.toThrow(/MAP_GEOJSON_NOT_GEOGRAPHIC/)
    await expect(convert({ geojson: { type: "Point", coordinates: [2685056.9, 1244517.8] }, crs: "EPSG:2056", anchor: { lon: 8.5417, lat: 47.3769 } })).rejects.toThrow(/MAP_CRS_UNSUPPORTED/)
    // 锚点用来源 CRS 坐标（x/y）时同样要按声明换算，不能猜
    const crs = parseSourceCrs("EPSG:32633")
    const anchor = await sourceToGeodetic(crs, 500000, 5250000)
    expect(anchor.lon).toBeCloseTo(15, 6)
    expect(anchor.lat).toBeCloseTo(47.4, 2)
  })
})

describe("局部锚点与可逆往返", () => {
  test("锚点经纬度与来源坐标二选一；都给或都不给都拒绝", async () => {
    await expect(convert({ geojson: square(), crs: "EPSG:4326" })).rejects.toThrow(/MAP_ANCHOR_REQUIRED/)
    await expect(convert({ geojson: square(), crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4, x: 1, y: 2 } })).rejects.toThrow(/MAP_ANCHOR_AMBIGUOUS/)
    await expect(convert({ geojson: square(), crs: "EPSG:4326", anchor: { lat: 47.4 } })).rejects.toThrow(/MAP_ANCHOR_REQUIRED/)
    await expect(convert({ geojson: square(), crs: "EPSG:4326", anchor: { lon: 8.5, lat: 99 } })).rejects.toThrow(/MAP_ANCHOR_INVALID/)
  })

  test("4300 米见方的数据在局部帧里就是 430 米上下，且逐点可逆回原坐标", async () => {
    const result = await convert({ geojson: square(), crs: "EPSG:4326", anchor: { lon: 8.5417, lat: 47.3769 } })
    const extent = result.extent as any
    // 0.01° 经度在 47.38°N 约 754 m，0.01° 纬度约 1112 m
    expect(extent.localMeters.widthM).toBeGreaterThan(740)
    expect(extent.localMeters.widthM).toBeLessThan(770)
    expect(extent.localMeters.depthM).toBeGreaterThan(1100)
    expect(extent.localMeters.depthM).toBeLessThan(1125)
    const crs = parseSourceCrs("EPSG:4326")
    const anchor = (result.anchor as any).geodetic
    let worst = 0
    for (const feature of result.features as any[]) {
      for (const vertex of feature.vertices) {
        const back = await localToSource(crs, anchor, vertex.local)
        worst = Math.max(worst, Math.abs(back[0] - vertex.source[0]), Math.abs(back[1] - vertex.source[1]))
      }
    }
    expect(worst).toBeLessThan(1e-9)
  })

  test("UTM 来源坐标同样可逆（网格米先反投影，再进局部帧）", async () => {
    // 苏黎世在第 32 带（中央经线 9°）内，声明正确的带号是可逆的前提
    const crs = parseSourceCrs("EPSG:32632")
    const origin = await geodeticToSource(crs, { lon: 8.5417, lat: 47.3769, h: 0 })
    const geometry = { type: "LineString", coordinates: [[origin[0], origin[1]], [origin[0] + 100, origin[1] + 100]] }
    const result = await convert({ geojson: geometry, crs: "EPSG:32632", anchor: { x: origin[0], y: origin[1] } })
    const vertex = (result.features as any[])[0].vertices[1]
    const back = await localToSource(crs, (result.anchor as any).geodetic, vertex.local)
    // 往返是 PROJ 的 cs2cs + cct（文本交接 12 位小数 ≈ 0.1 µm），这里按 1 mm 判，比引擎误差宽三个量级
    expect(Math.abs(back[0] - vertex.source[0])).toBeLessThan(1e-3)
    expect(Math.abs(back[1] - vertex.source[1])).toBeLessThan(1e-3)
    // 网格 100 m × 100 m 在局部米制里约 100 m（该处 k≈0.9996，网格米比地面米小 0.04%）
    expect(vertex.local[0]).toBeGreaterThan(99)
    expect(vertex.local[0]).toBeLessThan(101)
  })

  test("声明错 UTM 带号时给出警告：锚点离中央经线超过 6° 说明带号很可能选错", async () => {
    // 苏黎世真实属于 32 带；这里故意声明 33 带（中央经线 15°，差 6.46°）
    const crs = parseSourceCrs("EPSG:32633")
    const origin = await geodeticToSource(crs, { lon: 8.5417, lat: 47.3769, h: 0 })
    const result = await convert({
      geojson: { type: "Point", coordinates: [origin[0], origin[1]] },
      crs: "EPSG:32633", anchor: { x: origin[0], y: origin[1] },
    })
    const warnings = (result.warnings as string[]).join(" ")
    expect(warnings).toContain("中央经线")
    expect(warnings).toContain("带号很可能选错")
    // 声明正确带号时不应出现这条警告
    const correct = await convert({ geojson: square(), crs: "EPSG:32632", anchor: { lon: 8.5417, lat: 47.3769 } })
    expect((correct.warnings as string[]).join(" ")).not.toContain("带号很可能选错")
  })
})

describe("跨 ±180 换日线", () => {
  test("换日线两侧的两点按最短路径算，不会被当成绕地球一圈", async () => {
    const far = await geodesicDistanceM({ lon: 179.9785, lat: -23.6999, h: 0 }, { lon: -179.9437, lat: -23.7616, h: 0 })
    expect(far.meters).toBeLessThan(12000)
    expect(far.meters).toBeGreaterThan(8000)
    const short = await geodesicDistanceM({ lon: 179.99, lat: 0, h: 0 }, { lon: -179.99, lat: 0, h: 0 })
    expect(short.meters).toBeLessThan(3000)
    // 反算回的经度落在换日线的哪一侧是浮点自由（PROJ 走三维几何，实测与 -180 差 3e-12°）：
    // 按最短路径比较，不拿原始数字硬减。
    const back = await localToGeodetic({ lon: 179.99, lat: 0, h: 0 }, await geodeticToLocal({ lon: 179.99, lat: 0, h: 0 }, { lon: -180, lat: 0, h: 0 }))
    expect(Math.abs(longitudeDelta(back.lon, -180))).toBeLessThan(1e-9)
    expect(back.lat).toBeCloseTo(0, 9)
    expect(normalizeLongitude(181)).toBe(-179)
    expect(longitudeDelta(-179.9, 179.9)).toBeCloseTo(0.2, 9)
  })

  test("整份数据跨换日线时给出警告，且经度跨度不冒充东西向尺寸", async () => {
    const result = await convert({
      geojson: {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: { i: 1 }, geometry: { type: "Point", coordinates: [179.8, -16.5] } },
          { type: "Feature", properties: { i: 2 }, geometry: { type: "Point", coordinates: [-179.8, -16.45] } },
        ],
      },
      crs: "EPSG:4326", anchor: { lon: 179.9, lat: -16.5 },
    })
    const extent = result.extent as any
    expect(extent.geodesic.crossesAntimeridian).toBe(true)
    expect(extent.geodesic.lonSpanDeg).toBeGreaterThan(180)
    // 真实东西向跨度约 40 km，绝不是 lonSpanDeg 暗示的 359.6°
    expect(extent.localMeters.widthM).toBeGreaterThan(40000)
    expect(extent.localMeters.widthM).toBeLessThan(50000)
    expect((result.warnings as string[]).join(" ")).toContain("±180")
  })
})

describe("缺高度不编造", () => {
  test("二维多边形的 height 为 null、不上报 up 范围，也没有任何凭空高度", async () => {
    const result = await convert({ geojson: square(), crs: "EPSG:4326", anchor: { lon: 8.5417, lat: 47.3769 } })
    const feature = (result.features as any[])[0]
    expect(feature.height.present).toBe(false)
    expect(feature.height.meters).toBeNull()
    expect(feature.bboxLocal.minUp).toBeNull()
    expect(feature.bboxLocal.maxUp).toBeNull()
    expect((result.heightSummary as any).featuresWithoutHeight).toEqual(["square"])
    // 结果里除来源坐标原样回显外，任何位置都不出现被"补"出来的高度数字
    expect(JSON.stringify(result.heightSummary)).toContain("不补")
  })

  test("第三位序数：未声明或声明为 depth 时都不当高度，只有 elevation 才有 up 范围", async () => {
    const points = {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { place: "震中" }, geometry: { type: "Point", coordinates: [179.5, -17.5, 35000] } }],
    }
    const unknown = await convert({ geojson: points, crs: "EPSG:4326", anchor: { lon: 179.5, lat: -17.5 } })
    expect((unknown.features as any[])[0].height.present).toBe(false)
    expect((unknown.heightSummary as any).featuresWithSourceHeight).toBe(0)
    const depth = await convert({ geojson: points, crs: "EPSG:4326", anchor: { lon: 179.5, lat: -17.5 }, zMeaning: "depth" })
    expect((depth.features as any[])[0].height.present).toBe(false)
    expect((depth.features as any[])[0].bboxLocal.minUp).toBeNull()
    const elevation = await convert({ geojson: points, crs: "EPSG:4326", anchor: { lon: 179.5, lat: -17.5 }, zMeaning: "elevation" })
    expect((elevation.features as any[])[0].height.present).toBe(true)
    expect((elevation.features as any[])[0].height.meters).toBe(35000)
    expect((elevation.features as any[])[0].bboxLocal.maxUp).toBeCloseTo(35000, 6)
    await expect(convert({ geojson: points, crs: "EPSG:4326", anchor: { lon: 179.5, lat: -17.5 }, zMeaning: "height" })).rejects.toThrow(/MAP_Z_MEANING_INVALID/)
  })

  test("heightProperty 只照抄来源真值；缺这个键的要素仍是缺高度", async () => {
    const result = await convert({
      geojson: {
        type: "FeatureCollection",
        features: [
          { type: "Feature", id: "有高度", properties: { hoehe: 42.5 }, geometry: { type: "Point", coordinates: [8.5417, 47.3769] } },
          { type: "Feature", id: "没高度", properties: {}, geometry: { type: "Point", coordinates: [8.542, 47.377] } },
          { type: "Feature", id: "高度是空值", properties: { hoehe: null }, geometry: { type: "Point", coordinates: [8.543, 47.378] } },
        ],
      },
      crs: "EPSG:4326", anchor: { lon: 8.5417, lat: 47.3769 }, heightProperty: "hoehe",
    })
    const features = result.features as any[]
    expect(features[0].height).toMatchObject({ present: true, meters: 42.5, source: "property:hoehe" })
    expect(features[1].height).toMatchObject({ present: false, meters: null })
    expect(features[2].height).toMatchObject({ present: false, meters: null })
    expect((result.heightSummary as any).featuresWithoutHeight).toEqual(["没高度", "高度是空值"])
  })
})

describe("测量值与估计值分栏", () => {
  test("没声明 basis 直接拒绝（不替调用方归类）", async () => {
    await expect(convert({
      geojson: square(), crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 },
      declaredValues: [{ name: "塔高", value: 12, unit: "m" }],
    })).rejects.toThrow(/MAP_VALUE_BASIS_REQUIRED/)
  })

  test("测量值/估计值分栏返回，来源自报量只在 sourceMeasures 里原样保留", async () => {
    const result = await convert({
      geojson: {
        type: "FeatureCollection",
        features: [{ type: "Feature", id: "p", properties: { gemflaeche: 9188.0, perimeter: 58651.72 }, geometry: { type: "Polygon", coordinates: (square().features[0]!.geometry as any).coordinates } }],
      },
      crs: "EPSG:4326", anchor: { lon: 8.5417, lat: 47.3769 },
      declaredValues: [
        { name: "官方市界面积", value: 9188.0, unit: "ha", basis: "measured", source: "swisstopo gemflaeche" },
        { name: "照片里的楼高", value: 30, unit: "m", basis: "estimated", source: "照片粗估" },
      ],
    })
    const values = result.values as any
    expect(values.measured.map((row: any) => row.name)).toEqual(["官方市界面积"])
    expect(values.estimated.map((row: any) => row.name)).toEqual(["照片里的楼高"])
    // 来源 properties 里的 gemflaeche 只在 sourceMeasures 出现，不会被自动升格进 measured
    expect((result.features as any[])[0].sourceMeasures).toMatchObject({ gemflaeche: 9188.0, perimeter: 58651.72 })
    expect(values.measured).toHaveLength(1)
    await expect(convert({ geojson: square(), crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 }, declaredValues: "不是数组" })).rejects.toThrow(/MAP_VALUES_INVALID/)
  })
})

describe("来源元数据与年代", () => {
  test("来源页/获取时间/对象名原样保留；缺项如实提示而不是编造", async () => {
    const result = await convert({
      geojson: square(), crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 },
      source: { page: "https://example.gov/dataset", url: "https://example.gov/data.geojson", retrievedAt: "2026-09-20T04:16:00Z", object: "某市界（官方图层）", license: "CC-BY", attribution: "© 某测绘局" },
    })
    expect(result.source).toMatchObject({ page: "https://example.gov/dataset", retrievedAt: "2026-09-20T04:16:00Z", object: "某市界（官方图层）" })
    expect(result.sourceNotes).toEqual([])
    const bare = await convert({ geojson: square(), crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 } })
    expect((bare.sourceNotes as string[]).join(" ")).toContain("来源页")
    expect((bare.sourceNotes as string[]).join(" ")).toContain("获取时间")
    expect(result.convertedAt).toBe("2026-09-20T04:16:00.000Z")
  })

  test("年代未确认时不断言对应：eraMatch 恒为 not-asserted；给了 label 必须给 status", async () => {
    const result = await convert({
      geojson: square(), crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 },
      source: { page: "https://example.gov/1954", retrievedAt: "2026-09-20T04:16:00Z", object: "历史市界", era: { label: "1954", status: "unconfirmed" } },
    })
    expect(result.eraAssertion).toBe("not-asserted")
    expect((result.source as any).era).toMatchObject({ label: "1954", status: "unconfirmed" })
    expect((result.source as any).eraNote).toContain("不会声称")
    const confirmed = await convert({
      geojson: square(), crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 },
      source: { era: { label: "2026", status: "confirmed" } },
    })
    // 即使调用方声明已确认，工具本身仍不断言对应关系，只回显声明
    expect(confirmed.eraAssertion).toBe("not-asserted")
    await expect(convert({ geojson: square(), crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 }, source: { era: { label: "1954" } } })).rejects.toThrow(/MAP_ERA_STATUS_INVALID/)
  })
})

describe("形状、上限与取消", () => {
  test("顶点超上限直接拒绝并给出裁剪动作；硬上限是封顶值", async () => {
    const many = { type: "LineString", coordinates: Array.from({ length: 100 }, (_, index) => [8.5 + index * 1e-4, 47.4]) }
    await expect(convert({ geojson: many, crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 }, maxVertices: 50 })).rejects.toThrow(/MAP_GEOJSON_TOO_MANY_VERTICES/)
    await expect(convert({ geojson: many, crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 }, maxVertices: 0 })).rejects.toThrow(/MAP_MAX_VERTICES_INVALID/)
    const ok = await convert({ geojson: many, crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 }, maxVertices: 100 })
    expect((ok.limits as any).totalVertices).toBe(100)
  })

  test("includeVertices=false 只省掉逐顶点数组，范围与畸变仍是真实读数", async () => {
    const full = await convert({ geojson: square(), crs: "EPSG:4326", anchor: { lon: 8.5417, lat: 47.3769 } })
    const lean = await convert({ geojson: square(), crs: "EPSG:4326", anchor: { lon: 8.5417, lat: 47.3769 }, includeVertices: false })
    expect((lean.features as any[])[0].vertices).toEqual([])
    expect((lean.features as any[])[0].verticesOmitted).toBe(true)
    expect((lean.limits as any).totalVertices).toBe((full.limits as any).totalVertices)
    expect((lean.extent as any).localMeters).toEqual((full.extent as any).localMeters)
    expect((lean.distortion as any).maxAbsoluteErrorM).toBe((full.distortion as any).maxAbsoluteErrorM)
  })

  test("已取消的信号不再继续换算", async () => {
    const aborted = new AbortController()
    aborted.abort()
    await expect(mapGeoJsonToLocal({ geojson: square(), crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 } }, deps, aborted.signal)).rejects.toThrow()
  })

  test("相对路径必须给出解析基准：没有会话工作目录就明确报错，不退回进程目录", async () => {
    const refusal = await convert({ path: "x.geojson", crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 } }).then(() => null, (error: Error) => error)
    expect(refusal?.message).toContain("MAP_SESSION_CWD_UNKNOWN")
    expect(refusal?.message).toContain("pathBase")     // 纯计算场景的可执行动作
    // 给了基准（注册时取自会话工作目录）就走正常读取路径：文件不存在时报的是"读不到"而不是"目录未知"
    const withBase = await mapGeoJsonToLocal({ path: "x.geojson", crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 } }, { ...deps, pathBase: "/tmp" }, signal).then(() => null, (error: Error) => error)
    expect(withBase?.message).toContain("MAP_GEOJSON_FILE_UNREADABLE")
    expect(withBase?.message).toContain("/tmp")
  })

  test("读不到文件 / 不是 JSON / 空结果 / 非法几何都报出可执行的原因", async () => {
    await expect(convert({ path: "/nonexistent/x.geojson", crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 } })).rejects.toThrow(/MAP_GEOJSON_FILE_UNREADABLE/)
    await expect(convert({ geojson: "<html>404</html>", crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 } })).rejects.toThrow(/MAP_GEOJSON_PARSE_FAILED/)
    await expect(convert({ geojson: { type: "FeatureCollection", features: [] }, crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 } })).rejects.toThrow(/MAP_GEOJSON_EMPTY/)
    await expect(convert({ geojson: { type: "Feature", properties: {}, geometry: { type: "Circle", coordinates: [1, 2] } }, crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 } })).rejects.toThrow(/MAP_GEOJSON_GEOMETRY_UNSUPPORTED/)
    await expect(convert({ geojson: square(), crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 }, path: "/tmp/other.geojson" })).rejects.toThrow(/MAP_GEOJSON_SOURCE_REQUIRED/)
  })

  test("多边形环给出划分与实测绕向；洞从外环里减掉", async () => {
    const result = await convert({
      geojson: {
        type: "Feature", properties: { name: "带洞的方块" },
        // 外环逆时针、洞顺时针（符合 RFC 7946）
        geometry: { type: "Polygon", coordinates: [
          [[8.5, 47.4], [8.51, 47.4], [8.51, 47.41], [8.5, 47.41], [8.5, 47.4]],
          [[8.502, 47.402], [8.502, 47.408], [8.508, 47.408], [8.508, 47.402], [8.502, 47.402]],
        ] },
      },
      crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 },
    })
    const feature = (result.features as any[])[0]
    expect(feature.rings.map((ring: any) => ring.role)).toEqual(["outer", "hole"])
    expect(feature.rings.map((ring: any) => ring.winding)).toEqual(["ccw", "cw"])
    expect(feature.rings[0].start).toBe(0)
    expect(feature.rings[1].start).toBe(5)
    expect(feature.rings.every((ring: any) => ring.closed)).toBe(true)
    expect((result.warnings as string[]).join(" ")).not.toContain("RFC 7946")
  })

  test("未闭合的警告只针对多边形环：折线本来就该开口，不报「环没有闭合」", async () => {
    // 真实场景（任务 75 原生实测里模型遇到的）：LineString 被当成"环"警告了一遍，这是错怪数据。
    const line = await convert({
      geojson: { type: "Feature", properties: { name: "开口折线" }, geometry: { type: "LineString", coordinates: [[8.5, 47.4], [8.51, 47.41], [8.52, 47.4]] } },
      crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 },
    })
    expect(((line.features as any[])[0].rings[0] as any).role).toBe("line")
    expect((line.warnings as string[]).join(" ")).not.toContain("环没有闭合")
    // 多边形外环真的没闭合时仍要警告（不因为上面的放宽而丢掉这条检查）
    const openPolygon = await convert({
      geojson: { type: "Feature", properties: { name: "没闭合的外环" }, geometry: { type: "Polygon", coordinates: [[[8.5, 47.4], [8.51, 47.4], [8.51, 47.41], [8.5, 47.41]]] } },
      crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 },
    })
    expect((openPolygon.warnings as string[]).join(" ")).toContain("环没有闭合")
  })

  test("绕向与 RFC 7946 相反时照实上报并警告，不悄悄翻转坐标", async () => {
    const clockwiseOuter = {
      type: "Feature", properties: { name: "顺时针外环" },
      geometry: { type: "Polygon", coordinates: [[[8.5, 47.4], [8.5, 47.41], [8.51, 47.41], [8.51, 47.4], [8.5, 47.4]]] },
    }
    const result = await convert({ geojson: clockwiseOuter, crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 } })
    expect(((result.features as any[])[0].rings[0] as any).winding).toBe("cw")
    expect((result.warnings as string[]).join(" ")).toContain("RFC 7946")
    // 来源坐标逐字未改
    expect(((result.features as any[])[0].vertices[0] as any).source).toEqual([8.5, 47.4])
  })
})

describe("真 ToolRegistry 上的 map_geojson_to_local", () => {
  test("注册后可被真实 tools.execute 调用，返回 JSON 安全的结果", async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(Sessions)
    registerMapConstraintTools(ctx, { dependencies: deps })
    const session = ctx.sessions.create(SessionId("map-constraints-tool"))
    const agent = { id: session.id, session } as Agent
    const result: ToolExecutionResult = await ctx.tools.execute({
      callId: ToolCallId("map-1"), name: "map_geojson_to_local",
      arguments: { input: { geojson: square(), crs: "EPSG:4326", anchor: { lon: 8.5417, lat: 47.3769 }, source: { page: "https://example.gov/x", retrievedAt: "2026-09-20T04:16:00Z", object: "方块" } } },
      signal, agent,
    })
    expect(result.isError).toBe(false)
    const value = (result as any).value
    expect(value.ok).toBe(true)
    expect(value.tool).toBe("map_geojson_to_local")
    expect(value.crs.silentlyAssumed).toBe(false)
    expect(value.eraAssertion).toBe("not-asserted")
    // 工具结果的硬要求：JSON 往返后完全一致（没有 undefined/NaN 会被整次判为 invalid output）
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
    const text = result.content.filter(block => block.type === "text").map((block: any) => block.text).join("")
    expect(text.length).toBeGreaterThan(0)
  })

  test("缺 crs / 缺 anchor 的参数在真实运行时被拒绝，且错误消息是可执行动作", async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(Sessions)
    registerMapConstraintTools(ctx, { dependencies: deps })
    const session = ctx.sessions.create(SessionId("map-constraints-tool-2"))
    const agent = { id: session.id, session } as Agent
    const missingCrs = await ctx.tools.execute({ callId: ToolCallId("map-2"), name: "map_geojson_to_local", arguments: { input: { geojson: square(), anchor: { lon: 8.5, lat: 47.4 } } }, signal, agent })
    // crs/anchor 在参数 schema 层就是必填：模型不给出参直接失败，不会走到"默认 4326"
    expect(missingCrs.isError).toBe(true)
    const badCrs = await ctx.tools.execute({ callId: ToolCallId("map-3"), name: "map_geojson_to_local", arguments: { input: { geojson: square(), crs: "EPSG:2056", anchor: { lon: 8.5, lat: 47.4 } } }, signal, agent })
    expect(badCrs.isError).toBe(true)
    expect(JSON.stringify(badCrs)).toContain("MAP_CRS_UNSUPPORTED")
  })

  /** 真实模型第一次就是把路径按会话工作目录写相对路径的（见任务 runtime 的 native/session-events.json）：这里钉住同一行为。 */
  test("装了原生 fs 时，path 相对 agent 会话工作目录解析（fs 自己的默认目录故意设成别处）", async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(Sessions)
    await ctx.plugin(FsLocal, { cwd: "/" })
    registerMapConstraintTools(ctx)
    const session = ctx.sessions.create(SessionId("map-constraints-fs"), { meta: { cwd: FIXTURES } })
    const agent = { id: session.id, session } as Agent
    const result = await ctx.tools.execute({
      callId: ToolCallId("map-fs-1"), name: "map_geojson_to_local",
      arguments: { input: { path: "swisstopo-zurich-2026-4326.geojson", crs: "EPSG:4326", anchor: { lon: 8.5417, lat: 47.3769 } } },
      signal, agent,
    })
    expect(result.isError).toBe(false)
    expect((result as any).value.limits.totalVertices).toBe(2090)
    expect((result as any).value.sourceNotes.join(" ")).toContain("未提供来源页")
    // 反过来：会话工作目录里没有的文件，错误消息要说清相对路径是按哪个目录解析的
    const missing = await ctx.tools.execute({
      callId: ToolCallId("map-fs-2"), name: "map_geojson_to_local",
      arguments: { input: { path: "nope.geojson", crs: "EPSG:4326", anchor: { lon: 8.5417, lat: 47.3769 } } },
      signal, agent,
    })
    expect(missing.isError).toBe(true)
    expect(JSON.stringify(missing)).toContain("MAP_GEOJSON_FILE_UNREADABLE")
    expect(JSON.stringify(missing)).toContain(FIXTURES)
  })

  /**
   * 会话工作目录未知时**明确报错**：fs 服务的默认目录故意设成夹具目录，所以"悄悄退回服务/进程默认目录"
   * 会看起来一切正常——这里正是要挡住那种"按错目录解析"的静默行为（任务 67 证明过这类缺陷）。
   */
  test("会话工作目录未知：相对路径明确报 MAP_SESSION_CWD_UNKNOWN，绝对路径照常可用", async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(Sessions)
    await ctx.plugin(FsLocal, { cwd: FIXTURES })
    registerMapConstraintTools(ctx)
    const session = ctx.sessions.create(SessionId("map-constraints-no-cwd"))
    const agent = { id: session.id, session } as Agent
    const relative = await ctx.tools.execute({
      callId: ToolCallId("map-nocwd-1"), name: "map_geojson_to_local",
      arguments: { input: { path: "swisstopo-zurich-2026-4326.geojson", crs: "EPSG:4326", anchor: { lon: 8.5417, lat: 47.3769 } } },
      signal, agent,
    })
    expect(relative.isError).toBe(true)
    expect(JSON.stringify(relative)).toContain("MAP_SESSION_CWD_UNKNOWN")
    // 绝对路径不依赖会话目录：同一份文件照样能读，说明拦的是"没有基准的相对路径"而不是路径本身
    const absolute = await ctx.tools.execute({
      callId: ToolCallId("map-nocwd-2"), name: "map_geojson_to_local",
      arguments: { input: { path: join(FIXTURES, "swisstopo-zurich-2026-4326.geojson"), crs: "EPSG:4326", anchor: { lon: 8.5417, lat: 47.3769 }, includeVertices: false } },
      signal, agent,
    })
    expect(absolute.isError).toBe(false)
    expect((absolute as any).value.limits.totalVertices).toBe(2090)
  })
})

/** 供上面两个测试共用的极小工具：确认公开导出的换算函数彼此自洽（不是复述源码，而是真实数值关系）。 */
test("导出的换算函数自洽：geodeticToSource ∘ sourceToGeodetic 是恒等，局部帧与大地线距离一致", async () => {
  // 每组都用该带内真实的点（苏黎世→32 带、悉尼→南半球 56 带）：带外声明的误差见 crosscheck 的实测包络
  for (const [declared, point] of [
    ["EPSG:4326", { lon: 8.5417, lat: 47.3769, h: 0 }],
    ["EPSG:3857", { lon: 8.5417, lat: 47.3769, h: 0 }],
    ["EPSG:32632", { lon: 8.5417, lat: 47.3769, h: 0 }],
    ["EPSG:32756", { lon: 151.2, lat: -33.87, h: 0 }],
  ] as const) {
    const crs = parseSourceCrs(declared)
    const source = await geodeticToSource(crs, point)
    const back = await sourceToGeodetic(crs, source[0], source[1])
    // 经纬度声明是纯代数（1e-12°）；投影 CRS 走 PROJ 正反算，带内实测在 1e-9 度量级
    const tolerance = crs.kind === "geographic" ? 1e-12 : 1e-8
    expect(Math.abs(back.lon - point.lon)).toBeLessThan(tolerance)
    expect(Math.abs(back.lat - point.lat)).toBeLessThan(tolerance)
  }
  // 局部帧里的 1000 m 与同一条大地线方向上的 1000 m 差在切平面二阶量以内（< 1 mm）
  const anchor = { lon: 8.5417, lat: 47.3769, h: 0 }
  const target = await localToGeodetic(anchor, [1000, 0, 0])
  const geodesic = await geodesicDistanceM(anchor, target)
  expect(Math.abs(geodesic.meters - 1000)).toBeLessThan(1e-3)
  const local = await geodeticToLocal(anchor, target)
  expect(Math.abs(local[0] - 1000)).toBeLessThan(1e-6)
})

describe("数值引擎是 PROJ（不自造数值栈）：引擎版本与口径都在结果里", () => {
  test("结果带 PROJ 引擎与版本；畸变口径写明由 PROJ geod 给出", async () => {
    const result = await convert({ geojson: square(), crs: "EPSG:4326", anchor: { lon: 8.5417, lat: 47.3769 } })
    const projection = result.projection as any
    expect(projection.engine).toContain("PROJ")
    expect(projection.version).toMatch(/^PROJ \d+\.\d+/)
    expect((result.distortion as any).method).toContain("PROJ geod")
    // datumTransform 现在是 PROJ 的原话（不是本工具的说法）：4326→4326 报 noop / 0 m
    expect(projection.datumTransform).toContain("无基准变换")
    expect(projection.datumTransform).toContain("0 m")
  })

  test("UTM 的源 CRS 说明写实测比例因子：中央 0.9996、带边 +0.098%（不是「最大 0.04%」）", async () => {
    const result = await convert({ geojson: square(), crs: "EPSG:32632", anchor: { lon: 8.5417, lat: 47.3769 } })
    const text = [...(result.crs as any).notes, (result.distortion as any).sourceCrsNote].join(" ")
    expect(text).toContain("0.9996")
    expect(text).toContain("+0.098%")
    expect(text).not.toContain("最大差约 0.04%")
  })

  test("EPSG:4490：默认策略直接拒绝（PROJ 只给 ballpark/unknown），不静默当成 WGS84", async () => {
    const input = { geojson: square(), anchor: { lon: 8.5417, lat: 47.3769 }, crs: "EPSG:4490" }
    // PROJ 对 4490→4326 的运算就是 ballpark（+proj=noop，精度 unknown）：默认策略不把它当换算依据。
    const refusal = await convert(input).then(() => null, (error: Error) => error)
    expect(refusal?.message).toContain("MAP_DATUM_UNAVAILABLE")
    expect(refusal?.message).toContain("ballpark")            // 引的是 PROJ 自己的说法，不是本工具的断言
    expect(refusal?.message).toContain("unknown accuracy")
    expect(refusal?.message).toContain("allow-ballpark")      // 可执行动作里给出放宽的办法
    expect(refusal?.message).toContain("projinfo -s")
    // 明确显式放宽后才给数：数值与按 4326 读一致，但精度标成 PROJ 自报的 unknown，且有醒目警告。
    const cgcs = await convert({ ...input, datumPolicy: "allow-ballpark" })
    expect((cgcs.projection as any).datumPolicy).toBe("allow-ballpark")
    expect((cgcs.projection as any).datumOperation.accuracy).toBe("unknown accuracy")
    expect((cgcs.projection as any).datumOperation.ballpark).toBe(true)
    expect((cgcs.projection as any).datumTransform).toContain("ballpark")
    expect((cgcs.warnings as string[])[0]).toContain("不得")
    expect((cgcs.crs as any).notes.join(" ")).toContain("allow-ballpark")
    const wgs = await convert({ ...input, crs: "EPSG:4326" })
    const a = (cgcs.features as any[])[0].vertices, b = (wgs.features as any[])[0].vertices
    for (const [index, vertex] of a.entries()) expect(Math.abs(vertex.lon - b[index].lon)).toBeLessThan(1e-9)
  })

  test("基准运算事实来自 PROJ：4326 是 noop/0 m，UTM 是 projection/0 m 且带适用范围", async () => {
    const geographic = await convert({ geojson: square(), crs: "EPSG:4326", anchor: { lon: 8.5417, lat: 47.3769 } })
    const op = (geographic.projection as any).datumOperation
    expect(op.kind).toBe("noop")
    expect(op.accuracy).toBe("0 m")
    expect(op.ballpark).toBe(false)
    expect(op.from).toBe("EPSG:4326")
    expect(op.to).toBe("EPSG:4326")
    const utm = await convert({ geojson: square(), crs: "EPSG:32632", anchor: { lon: 8.5417, lat: 47.3769 } })
    const utmOp = (utm.projection as any).datumOperation
    expect(utmOp.kind).toBe("projection")
    expect(utmOp.accuracy).toBe("0 m")
    // 适用范围是 PROJ 的原话（32 带：6°E..12°E），不是本工具编的
    expect(utmOp.area).toContain("6°E")
    expect((utm.projection as any).datumPolicy).toBe("require-exact")
    expect((utm.projection as any).epoch).toContain("不适用")
    // 投影 / 基准 / 历元 / 垂直基准分开写：垂直基准明说没做归算
    expect((utm.projection as any).verticalDatum).toContain("未做垂直基准变换")
    expect((utm.distortion as any).sourceCrsNote).toContain("0.9996")
  })

  test("datumPolicy 只认两个取值，其它一律拒绝（不替调用方挑宽松档）", async () => {
    const refusal = await convert({ geojson: square(), crs: "EPSG:4326", anchor: { lon: 8.5, lat: 47.4 }, datumPolicy: "whatever" }).then(() => null, (error: Error) => error)
    expect(refusal?.message).toContain("MAP_DATUM_POLICY_INVALID")
  })

  test("别的候选缺格网不连累已选中的运算：策略层按被选中的那条判（任务 92 的判据）", async () => {
    // EPSG:27700（OSGB36）不在本工具支持的 CRS 面里（见 parseSourceCrs），但策略是通用的：
    // 这对 CRS 有 8 条可用候选，PROJ 的首选是不需要 OSTN15 格网的 2 m 七参数（本机可执行），
    // 所以默认策略**接受**它——不能因为别的候选缺格网就把这条可用运算判成不可用。
    const osgb = { declared: "EPSG:27700", epsg: "EPSG:27700", kind: "utm" as const, units: "meter" as const, proj: "+init=epsg:27700", notes: [] }
    const accepted = await assessDatumOperation(osgb, "require-exact")
    expect(accepted.concerns).toEqual([])
    expect(accepted.warnings).toEqual([])
    expect(accepted.operation.usable).toBe(true)
    expect(accepted.operation.missingGrids).toEqual([])
    expect(accepted.operation.accuracy).toBe("2 m")
    expect(accepted.operation.kind).toBe("datum")
    // 报告里同时给出"这条运算的管线就是被执行的管线"
    expect(accepted.operation.projString).toContain("+proj=helmert")
    expect(accepted.operation.execution.engine).toBe("cct")

    // 只有**被选中的那条**缺格网/是 ballpark 时才拒绝：EPSG:4252（Lome，PROJ 只给 ballpark，
    // 精度 unknown）在默认策略下依然是 MAP_DATUM_UNAVAILABLE，放宽后才给数并标 unknown。
    const lome = { declared: "EPSG:4252", epsg: "EPSG:4252", kind: "utm" as const, units: "meter" as const, proj: "+init=epsg:4252", notes: [] }
    const refusal = await (async () => { try { await assessDatumOperation(lome, "require-exact"); return null } catch (error) { return error as Error } })()
    expect(refusal?.message).toContain("MAP_DATUM_UNAVAILABLE")
    expect(refusal?.message).toContain("ballpark")
    expect(refusal?.message).toContain("unknown accuracy")
    const allowed = await assessDatumOperation(lome, "allow-ballpark")
    expect(allowed.operation.ballpark).toBe(true)
    expect(allowed.operation.accuracy).toBe("unknown accuracy")
    expect(allowed.warnings[0]).toContain("不得")
  })

  test("多要素 + 嵌套 FeatureCollection：批量换算按要素切片对齐（每个顶点的局部坐标与它自己的经纬度自洽）", async () => {
    const crs = parseSourceCrs("EPSG:32632")
    const anchorGeodetic = { lon: 8.5417, lat: 47.3769, h: 0 }
    const [e0, n0] = await geodeticToSource(crs, anchorGeodetic)
    const features: any[] = []
    for (let index = 0; index < 10; index++) {
      const e = e0 + index * 200, n = n0 + index * 100
      features.push({ type: "Feature", id: `p${index}`, properties: {}, geometry: { type: "Point", coordinates: [e, n] } })
      features.push({ type: "Feature", id: `l${index}`, properties: {}, geometry: { type: "LineString", coordinates: [[e, n], [e + 150, n + 150]] } })
      features.push({ type: "Feature", id: `poly${index}`, properties: {}, geometry: { type: "Polygon", coordinates: [[[e, n], [e + 150, n], [e + 150, n + 150], [e, n]]] } })
    }
    const result = await convert({ geojson: { type: "FeatureCollection", features: [{ type: "FeatureCollection", features }] }, crs: "EPSG:32632", anchor: anchorGeodetic })
    const out = result.features as any[]
    expect(out.length).toBe(30)
    // 结构位没有错位：点 1 个顶点、线 2 个、多边形 4 个，按顺序重复十轮
    expect(out.map(feature => feature.vertexCount)).toEqual(Array.from({ length: 10 }, () => [1, 2, 4]).flat())
    const all = out.flatMap(feature => feature.vertices)
    expect(all.length).toBe((result.limits as any).totalVertices)
    expect(all.length).toBe(70)
    // 真检查：每个顶点的局部坐标必须与"它自己的经纬度到锚点的大地线距离"同量级（切片错位会立刻暴露）
    const geodesic = await geodesicDistances(anchorGeodetic, all.map(vertex => ({ lon: vertex.lon, lat: vertex.lat, h: 0 })))
    for (const [index, vertex] of all.entries()) {
      const localM = Math.hypot(vertex.local[0], vertex.local[1])
      if (geodesic[index]! > 1) expect(Math.abs(localM / geodesic[index]! - 1)).toBeLessThan(1e-5)
    }
  })
})
