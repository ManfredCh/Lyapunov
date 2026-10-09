import { describe, expect, test } from "bun:test"
import {
  GAUSSIAN_CAMERA_BASIS,
  GAUSSIAN_CAMERA_FRAME_MARKERS,
  isGaussianCameraFrame,
  parseGaussianCameraFramePlyHeader,
  parseGaussianPlyFacts,
  scanPlyHeader,
} from "../src/gaussian-frame.ts"

const V2 = GAUSSIAN_CAMERA_FRAME_MARKERS["first-camera-c2w-v2"]
const V3 = GAUSSIAN_CAMERA_FRAME_MARKERS["first-camera-opengl-v3"]
const encoder = new TextEncoder()
/** 生产侧 `gaussian_ply_header` 的 14 个 float 属性（顺序即判据）。 */
const PROPERTIES = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]

/**
 * 造一个**完整**的 Gaussian PLY（真实 14-float binary little endian 正文，非 header-only）。
 * 默认走生产约定；要用负例就传 `format`/`properties`/`count`/`comments`/`body` 覆盖。
 */
function ply(options: {
  comments?: string[]
  format?: string
  count?: number | string
  properties?: string[]
  body?: Uint8Array
  firstLine?: string
  end?: boolean
} = {}): Uint8Array {
  const lines = [options.firstLine ?? "ply", options.format ?? "format binary_little_endian 1.0"]
  for (const comment of options.comments ?? []) lines.push(comment)
  lines.push(`element vertex ${options.count ?? 1}`)
  for (const property of options.properties ?? PROPERTIES.map(name => `property float ${name}`)) lines.push(property)
  if (options.end !== false) lines.push("end_header")
  const header = encoder.encode(lines.join("\n") + "\n")
  // 每点 14 个小端 float；rot_0=1 让四元数成型（本体只读头，这里给出真实非空正文）。
  const vertexCount = typeof options.count === "number" ? options.count : 1
  const defaultBody = new Uint8Array(Math.max(0, vertexCount) * PROPERTIES.length * 4)
  for (let index = 0; index < defaultBody.length; index += 4) defaultBody[index] = 1
  const body = options.body ?? defaultBody
  const out = new Uint8Array(header.length + body.length)
  out.set(header, 0); out.set(body, header.length)
  return out
}

/** 生产约定完整头 + 恰好一条标记；`gaussian:false` 造只有 xyz 的普通网格。 */
function production(frame?: string | string[], options: { gaussian?: boolean; count?: number; comments?: string[] } = {}): Uint8Array {
  const comments = [...(frame === undefined ? [] : Array.isArray(frame) ? frame : [frame]), ...(options.comments ?? [])]
  return ply({ comments, ...(options.gaussian === false ? { properties: ["property float x", "property float y", "property float z"] } : {}), ...(options.count !== undefined ? { count: options.count } : {}) })
}

/**
 * 只造生产约定的**真实 14-float binary 头**（含声明顶点数），不带正文：识别只读 `end_header`
 * 之前的部分，声明百万级顶点时不必真的分配那份正文（`ply` 会按 count 分配，故此处单列）。
 */
function productionHeader(frame: string | string[], count: number | string, comments: string[] = []): Uint8Array {
  const markers = Array.isArray(frame) ? frame : [frame]
  const lines = ["ply", "format binary_little_endian 1.0", ...markers, ...comments, `element vertex ${count}`, ...PROPERTIES.map(name => `property float ${name}`), "end_header"]
  return encoder.encode(lines.join("\n") + "\n")
}

describe("Gaussian PLY 头坐标标记的严格识别", () => {
  test("完整 binary 14-float 生产头里唯一一条 v2/v3 标记被精确识别", () => {
    expect(parseGaussianCameraFramePlyHeader(production(V2))).toBe("first-camera-c2w-v2")
    expect(parseGaussianCameraFramePlyHeader(production(V3))).toBe("first-camera-opengl-v3")
    expect(scanPlyHeader(production(V2))?.vertexCount).toBe(1)
  })

  test("CRLF 行尾与前后空白的标记同样识别", () => {
    const bytes = encoder.encode(["ply", "format binary_little_endian 1.0", `  ${V2}  `, "element vertex 1", ...PROPERTIES.map(p => `property float ${p}`), "end_header", ""].join("\r\n"))
    expect(parseGaussianCameraFramePlyHeader(bytes)).toBe("first-camera-c2w-v2")
  })

  test("同时出现两种 frame 的冲突件拒绝（不猜）", () => {
    expect(parseGaussianCameraFramePlyHeader(production([V2, V3]))).toBeUndefined()
  })

  test("同一条标记重复两次也不自动识别（头里必须恰好一条）", () => {
    expect(parseGaussianCameraFramePlyHeader(production([V2, V2]))).toBeUndefined()
    expect(parseGaussianCameraFramePlyHeader(production([V3, V3]))).toBeUndefined()
  })

  test("未知 Lyapunov coordinate_frame 与已知标记混用同样拒绝", () => {
    expect(parseGaussianCameraFramePlyHeader(production([V2, "comment Lyapunov idle coordinate_frame future_v9"]))).toBeUndefined()
    expect(parseGaussianCameraFramePlyHeader(production(V2, { comments: ["comment Lyapunov idle coordinate_frame future_v9"] }))).toBeUndefined()
    expect(parseGaussianCameraFramePlyHeader(production("comment Lyapunov idle coordinate_frame future_v9"))).toBeUndefined()
  })

  test("正文里的同一字符串永不参与匹配；只在 end_header 之前扫描", () => {
    // 头里没有标记，正文第一行伪装成标记：不得命中。
    expect(parseGaussianCameraFramePlyHeader(ply({ body: encoder.encode(V2 + "\n") }))).toBeUndefined()
    // 头里已有真 v3，正文再放 v2：仍是唯一 v3，不冲突。
    expect(parseGaussianCameraFramePlyHeader(ply({ comments: [V3], body: encoder.encode(V2 + "\n") }))).toBe("first-camera-opengl-v3")
  })

  test("前缀/后缀扩展、非 Gaussian 头、坏头、未终止头一律拒绝", () => {
    expect(parseGaussianCameraFramePlyHeader(production(`${V2}_extra`))).toBeUndefined()
    expect(parseGaussianCameraFramePlyHeader(production(V2, { gaussian: false }))).toBeUndefined()
    expect(parseGaussianCameraFramePlyHeader(ply({ comments: [V2], firstLine: "ply2" }))).toBeUndefined()
    expect(parseGaussianCameraFramePlyHeader(ply({ comments: [V2], end: false }))).toBeUndefined()
    expect(parseGaussianCameraFramePlyHeader(new Uint8Array())).toBeUndefined()
  })

  test("只认生产约定的完整 14-float binary 头：缺属性/多属性/ASCII 都不自动识别", () => {
    // 只带 xyz/f_dc_0/scale_0 的简写头（旧测试用的形状）不再是生产约定。
    expect(parseGaussianCameraFramePlyHeader(ply({ comments: [V2], properties: ["property float x", "property float y", "property float z", "property float f_dc_0", "property float scale_0"] }))).toBeUndefined()
    // 属性顺序不对也不算完整命中。
    const swapped = PROPERTIES.map(name => `property float ${name}`); const first = swapped[0]!; swapped[0] = swapped[1]!; swapped[1] = first
    expect(parseGaussianCameraFramePlyHeader(ply({ comments: [V2], properties: swapped }))).toBeUndefined()
    // ASCII 头即使带标记也不认（生产约定是 binary little endian）。
    expect(parseGaussianCameraFramePlyHeader(ply({ comments: [V2], format: "format ascii 1.0" }))).toBeUndefined()
  })

  test("comment 里提到 property 不能伪造成 Gaussian 判据", () => {
    const bytes = ply({ comments: [V2, "comment property float f_dc_0", "comment element vertex 1"], properties: ["property float x", "property float y", "property float z"] })
    expect(parseGaussianCameraFramePlyHeader(bytes)).toBeUndefined()
    expect(scanPlyHeader(bytes)?.propertyLines).toEqual(["property float x", "property float y", "property float z"])
  })

  test("顶点数必须是真正安全正整数：0/负数形状/重复 vertex 段都拒绝", () => {
    expect(parseGaussianCameraFramePlyHeader(production(V2, { count: 0 }))).toBeUndefined()
    const duplicate = ply({ comments: [V2], count: 1 })
    const text = new TextDecoder().decode(duplicate)
    const dup = encoder.encode(text.replace("element vertex 1", "element vertex 1\nelement vertex 2"))
    expect(parseGaussianCameraFramePlyHeader(dup)).toBeUndefined()
    const huge = ply({ comments: [V2], count: "99999999999999999999" })
    expect(parseGaussianCameraFramePlyHeader(huge)).toBeUndefined()
    expect(scanPlyHeader(huge)).toBeUndefined()
  })

  test("end_header 超过 64 KiB 头窗口时视为未终止（与 formats 的头读取窗口同判据）", () => {
    const filler = (": " + "a".repeat(90) + "\n").repeat(800) // > 64 KiB 的注释
    const text = `ply\nformat binary_little_endian 1.0\ncomment ${filler}${V2}\nelement vertex 1\n${PROPERTIES.map(p => `property float ${p}`).join("\n")}\nend_header\n`
    const bytes = encoder.encode(text)
    expect(bytes.length).toBeGreaterThan(65536)
    expect(parseGaussianCameraFramePlyHeader(bytes)).toBeUndefined()
  })

  test("frame 判据与文件空间首相机基向量是闭合表", () => {
    expect(isGaussianCameraFrame("first-camera-c2w-v2")).toBe(true)
    expect(isGaussianCameraFrame("first-camera-opengl-v3")).toBe(true)
    expect(isGaussianCameraFrame("something-else")).toBe(false)
    expect(isGaussianCameraFrame(undefined)).toBe(false)
    // v2 OpenCV：朝 +Z、up −Y；v3 OpenGL：朝 −Z、up +Y。
    expect(GAUSSIAN_CAMERA_BASIS["first-camera-c2w-v2"]).toEqual({ forward: [0, 0, 1], up: [0, -1, 0] })
    expect(GAUSSIAN_CAMERA_BASIS["first-camera-opengl-v3"]).toEqual({ forward: [0, 0, -1], up: [0, 1, 0] })
  })
})

describe("严格 header 事实：同一次扫描同时给出 frame 与安全顶点数", () => {
  test("完整真实 14-float binary 头同时给出唯一 frame 与安全正整数顶点数（含百万级旧 v2/新 v3）", () => {
    expect(parseGaussianPlyFacts(production(V2, { count: 1000 }))).toEqual({ frame: "first-camera-c2w-v2", sourcePointCount: 1000 })
    expect(parseGaussianPlyFacts(production(V3, { count: 7, comments: [] }))).toEqual({ frame: "first-camera-opengl-v3", sourcePointCount: 7 })
    // 百万级旧 v2：只读头，声明数如实取出（正文不必真的存在）。
    const largeV2 = parseGaussianPlyFacts(productionHeader(V2, 5_418_490))
    expect(largeV2).toEqual({ frame: "first-camera-c2w-v2", sourcePointCount: 5_418_490 })
    const largeV3 = parseGaussianPlyFacts(productionHeader(V3, 1_200_000))
    expect(largeV3).toEqual({ frame: "first-camera-opengl-v3", sourcePointCount: 1_200_000 })
    // 与只取 frame 的旧入口同源一致：新 helper 不改变既有判据。
    expect(parseGaussianCameraFramePlyHeader(productionHeader(V2, 5_418_490))).toBe("first-camera-c2w-v2")
    expect(parseGaussianPlyFacts(production(V2))?.frame).toBe(parseGaussianCameraFramePlyHeader(production(V2)))
  })

  test("非严格识别一律不产出事实：0/unsafe/重复 vertex、冲突/重复/未知 frame、非生产布局、坏头", () => {
    expect(parseGaussianPlyFacts(production(V2, { count: 0 }))).toBeUndefined()
    expect(parseGaussianPlyFacts(productionHeader(V2, "99999999999999999999"))).toBeUndefined()
    const duplicate = ply({ comments: [V2], count: 1 })
    const text = new TextDecoder().decode(duplicate)
    const dup = encoder.encode(text.replace("element vertex 1", "element vertex 1\nelement vertex 2"))
    expect(parseGaussianPlyFacts(dup)).toBeUndefined()
    expect(parseGaussianPlyFacts(production([V2, V3]))).toBeUndefined()
    expect(parseGaussianPlyFacts(production([V2, V2]))).toBeUndefined()
    expect(parseGaussianPlyFacts(production([V2, "comment Lyapunov idle coordinate_frame future_v9"]))).toBeUndefined()
    expect(parseGaussianPlyFacts(production("comment Lyapunov idle coordinate_frame future_v9"))).toBeUndefined()
    expect(parseGaussianPlyFacts(production(V2, { gaussian: false }))).toBeUndefined()
    expect(parseGaussianPlyFacts(ply({ comments: [V2], format: "format ascii 1.0" }))).toBeUndefined()
    expect(parseGaussianPlyFacts(ply({ comments: [V2], end: false }))).toBeUndefined()
    expect(parseGaussianPlyFacts(new Uint8Array())).toBeUndefined()
  })

  test("正文里的伪装标记不参与；顶点数仍只取头里唯一 vertex 段", () => {
    const bytes = ply({ comments: [V3], count: 7, body: encoder.encode(`${V2}\nelement vertex 999999\n`) })
    expect(parseGaussianPlyFacts(bytes)).toEqual({ frame: "first-camera-opengl-v3", sourcePointCount: 7 })
  })
})
