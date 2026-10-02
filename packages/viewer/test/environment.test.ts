/**
 * 环境光照的**格式与数学**（`packages/viewer/src/environment.ts`）的行为测试。
 *
 * 这个文件测的是"文档里写下的环境组件会被解析成什么"：判别值、上界收敛、缺省补齐、
 * 昼夜太阳几何、渲染时钟推进、补丁合成。断言读的是函数返回值，不是源码文本——
 * 例如"写 500 会被收敛到 8 并记一条 CLAMPED 警告"这条，改坏了解析器就会真的失败。
 *
 * 不在这里测的（另有归属）：
 *  · 这些读数落到 THREE 对象/像素上——`environment-viewer.test.ts`（无 WebGL 的装配）与真实浏览器验收。
 *  · HDRI 纹理与 PMREM——真实浏览器（需要 WebGL）。
 *
 * 用法：`bun test packages/viewer/test/environment.test.ts`
 */
import { describe, expect, test } from "bun:test"

import {
  DAY_NIGHT_MAX_ELEVATION_DEG,
  DAY_NIGHT_NIGHT_FLOOR,
  ENVIRONMENT_COMPONENT_KEY,
  ENVIRONMENT_KIND,
  ENVIRONMENT_LIMITS,
  HDRI_MIME_TYPES,
  advanceEnvironmentClock,
  composeEnvironment,
  dayNightSun,
  defaultSceneEnvironment,
  environmentDaylightFactor,
  environmentLiveState,
  normalizeWrapped,
  parseEnvironmentComponent,
  resolveEnvironmentHdri,
  scanSceneEnvironment,
  smoothstep,
  sunDirectionVector,
} from "../src/environment.ts"
import type { SceneEnvironment } from "../src/environment.ts"
import type { Entity, SceneSnapshot } from "../../lyapunov-contracts/src/types.ts"

const source = { units: "m", upAxis: "Z", handedness: "right", metersPerUnit: 1 } as const
const entity = (entityId: string, components: Record<string, unknown>, resources: Entity["resources"] = []): Entity =>
  ({ entityId, name: entityId, transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, components, resources }) as Entity
const snapshot = (...entities: Entity[]): Pick<SceneSnapshot, "entities"> => ({ entities })

const hdriResource = (resourceId: string, version: number, uri: string, mimeType = "image/vnd.radiance"): Entity["resources"][number] => ({
  resourceId, version, source,
  original: { uri, mimeType },
  representations: [{ uri, mimeType }],
})

describe("组件解析", () => {
  test("只认 kind 完全相等的记录：同名不同 kind 不静默当环境用", () => {
    const wrong = parseEnvironmentComponent({ kind: "scene/lighting", exposure: 2 })
    expect("error" in wrong && wrong.error).toContain("ENVIRONMENT_KIND_UNSUPPORTED")
    expect("error" in parseEnvironmentComponent(null) && true).toBe(true)
    expect(("error" in parseEnvironmentComponent([1, 2]) ? "error" : "component")).toBe("error")
  })

  test("缺失字段补成 Viewer 改造前的那组读数（旧场景不受升级影响）", () => {
    const parsed = parseEnvironmentComponent({ kind: ENVIRONMENT_KIND })
    if ("error" in parsed) throw new Error(parsed.error)
    expect(parsed.component).toEqual({
      kind: ENVIRONMENT_KIND,
      environmentIntensity: 0.7,
      hemisphereIntensity: 2.4,
      exposure: 1,
      background: "color",
      shadows: false,
      sun: { azimuthDeg: 90, elevationDeg: 45, intensity: 3 },
      dayNight: { enabled: false, timeHours: 12, cycleSeconds: 60 },
    })
    expect(parsed.warnings).toEqual([])
    expect(parsed.component.hdri).toBeUndefined()
  })

  test("越界数值收敛到上界并留下 CLAMPED 警告（被改小过就不算原样生效）", () => {
    const parsed = parseEnvironmentComponent({ kind: ENVIRONMENT_KIND, exposure: 500, environmentIntensity: -3, "hemisphereIntensity": 1e9 })
    if ("error" in parsed) throw new Error(parsed.error)
    expect(parsed.component.exposure).toBe(ENVIRONMENT_LIMITS.exposure)
    expect(parsed.component.environmentIntensity).toBe(0)
    expect(parsed.component.hemisphereIntensity).toBe(ENVIRONMENT_LIMITS.intensity)
    expect(parsed.warnings.filter(warning => warning.includes("ENVIRONMENT_FIELD_CLAMPED"))).toHaveLength(3)
  })

  test("类型不对的字段回默认并记 DEFAULTED；只有 hdri 是硬错误", () => {
    const parsed = parseEnvironmentComponent({ kind: ENVIRONMENT_KIND, exposure: "亮一点", shadows: 1, background: "sky", dayNight: { timeHours: "中午" } })
    if ("error" in parsed) throw new Error(parsed.error)
    expect(parsed.component.exposure).toBe(1)
    expect(parsed.component.shadows).toBe(false)
    expect(parsed.component.background).toBe("color")
    expect(parsed.component.dayNight.timeHours).toBe(12)
    expect(parsed.warnings.filter(warning => warning.includes("ENVIRONMENT_FIELD_DEFAULTED")).length).toBeGreaterThanOrEqual(4)
    expect("error" in parseEnvironmentComponent({ kind: ENVIRONMENT_KIND, hdri: { resourceId: "sky" } }) && true).toBe(true)
    expect("error" in parseEnvironmentComponent({ kind: ENVIRONMENT_KIND, hdri: { resourceId: "sky", version: 0 } }) && true).toBe(true)
  })

  test("方位角与时刻按 360°/24h 归一（模型写 370° / 30h 不会溢出到另一天）", () => {
    const parsed = parseEnvironmentComponent({ kind: ENVIRONMENT_KIND, sun: { azimuthDeg: 370, elevationDeg: 120 }, dayNight: { timeHours: 30, cycleSeconds: 86400 * 2 } })
    if ("error" in parsed) throw new Error(parsed.error)
    expect(parsed.component.sun.azimuthDeg).toBeCloseTo(10, 6)
    expect(parsed.component.sun.elevationDeg).toBe(90)
    expect(parsed.component.dayNight.timeHours).toBeCloseTo(6, 6)
    expect(parsed.component.dayNight.cycleSeconds).toBe(ENVIRONMENT_LIMITS.cycleSecondsMax)
    expect(normalizeWrapped(-1, 24)).toBeCloseTo(23, 6)
    expect(() => normalizeWrapped(1, 0)).toThrow()
  })
})

describe("场景扫描", () => {
  test("取文档顺序第一条有效组件，重复的如实记进 diagnostics 而不是静默覆盖", () => {
    const scan = scanSceneEnvironment(snapshot(
      entity("robot", {}),
      entity("bad", { [ENVIRONMENT_COMPONENT_KEY]: { kind: "scene/environment", hdri: { resourceId: "x" } } }),
      entity("lighting", { [ENVIRONMENT_COMPONENT_KEY]: { kind: ENVIRONMENT_KIND, exposure: 2 } }),
      entity("duplicate", { [ENVIRONMENT_COMPONENT_KEY]: { kind: ENVIRONMENT_KIND, exposure: 3 } }),
    ))
    expect(scan.environment?.entityId).toBe("lighting")
    expect(scan.environment?.component.exposure).toBe(2)
    expect(scan.diagnostics).toHaveLength(2)
    expect(scan.diagnostics[0]!.reason).toContain("ENVIRONMENT_HDRI_INVALID")
    expect(scan.diagnostics[1]!.reason).toContain("ENVIRONMENT_DUPLICATE_IGNORED: 已有 lighting")
  })

  test("没有组件时不是错误：旧场景照常没有环境光照", () => {
    const scan = scanSceneEnvironment(snapshot(entity("robot", {})))
    expect(scan.environment).toBeUndefined()
    expect(scan.diagnostics).toEqual([])
    expect(scanSceneEnvironment(undefined).environment).toBeUndefined()
  })

  test("实体级警告带 entityId 前缀（面板上能指到是哪条实体）", () => {
    const scan = scanSceneEnvironment(snapshot(entity("lighting", { [ENVIRONMENT_COMPONENT_KEY]: { kind: ENVIRONMENT_KIND, exposure: 99 } })))
    expect(scan.environment?.warnings[0]).toStartWith("lighting: ENVIRONMENT_FIELD_CLAMPED")
  })
})

describe("HDRI 引用", () => {
  test("按 resourceId@version 从承载实体的 resources 里取，接受 hdri 表示而非 original", () => {
    const carried = entity("sky", { [ENVIRONMENT_COMPONENT_KEY]: { kind: ENVIRONMENT_KIND, hdri: { resourceId: "sky-1", version: 2 } } },
      [hdriResource("sky-1", 2, "assets/sky.hdr"), hdriResource("other", 1, "assets/other.hdr")])
    const scan = scanSceneEnvironment(snapshot(carried))
    const resolved = resolveEnvironmentHdri(scan.environment!.entity, scan.environment!.component)
    expect(resolved?.ok && resolved.representation.uri).toBe("assets/sky.hdr")
    expect(resolved?.ok && resolved.ref.resourceId).toBe("sky-1")
  })

  test("请求的版本不在实体上：报缺版本并列出实际版本，**不拿同 id 的别的版本顶替**", () => {
    const carried = entity("sky", { [ENVIRONMENT_COMPONENT_KEY]: { kind: ENVIRONMENT_KIND, hdri: { resourceId: "sky-1", version: 2 } } },
      [hdriResource("sky-1", 1, "assets/old-v1.hdr"), hdriResource("sky-1", 3, "assets/other-v3.hdr")])
    const scan = scanSceneEnvironment(snapshot(carried))
    const resolved = resolveEnvironmentHdri(scan.environment!.entity, scan.environment!.component)
    expect(resolved?.ok).toBe(false)
    const error = resolved && !resolved.ok ? resolved.error : ""
    expect(error).toContain("ENVIRONMENT_HDRI_VERSION_MISSING: sky-1@2")
    expect(error).toContain("sky-1@1、@3") // 真实版本列出来，人能看懂为什么没换上
    expect(error).toContain("不拿别的版本顶替")
    // 兜底一旦回来，这里就会拿到 assets/old-v1.hdr："请求 v2 却显示 v1"必须不可能通过
    expect(JSON.stringify(resolved)).not.toContain("old-v1.hdr")
  })

  test("表示里没有 HDRI mime（或资源根本不在实体上）时报缺失，不猜一张贴图", () => {
    const wrongMime = entity("sky", { [ENVIRONMENT_COMPONENT_KEY]: { kind: ENVIRONMENT_KIND, hdri: { resourceId: "mesh", version: 1 } } },
      [hdriResource("mesh", 1, "assets/a.glb", "model/gltf-binary")])
    const scanA = scanSceneEnvironment(snapshot(wrongMime))
    const resolvedA = resolveEnvironmentHdri(scanA.environment!.entity, scanA.environment!.component)
    expect(resolvedA?.ok).toBe(false)
    expect(resolvedA && !resolvedA.ok ? resolvedA.error : "").toContain("ENVIRONMENT_HDRI_REPRESENTATION_MISSING: mesh@1")
    expect(resolvedA && !resolvedA.ok ? resolvedA.error : "").toContain("model/gltf-binary")

    const missing = entity("sky", { [ENVIRONMENT_COMPONENT_KEY]: { kind: ENVIRONMENT_KIND, hdri: { resourceId: "gone", version: 1 } } }, [])
    const scanB = scanSceneEnvironment(snapshot(missing))
    const resolvedB = resolveEnvironmentHdri(scanB.environment!.entity, scanB.environment!.component)
    expect(resolvedB && !resolvedB.ok ? resolvedB.error : "").toContain("ENVIRONMENT_HDRI_RESOURCE_MISSING: gone@1")

    // 组件没声明 hdri：不是错误，返回 undefined（用内置环境光）
    const none = entity("sky", { [ENVIRONMENT_COMPONENT_KEY]: { kind: ENVIRONMENT_KIND } }, [])
    const scanC = scanSceneEnvironment(snapshot(none))
    expect(resolveEnvironmentHdri(scanC.environment!.entity, scanC.environment!.component)).toBeUndefined()
  })

  test("HDRI mime 清单与 scene-kit 的 .hdr/.exr 解析一致（两处不漂移）", () => {
    expect([...HDRI_MIME_TYPES]).toEqual(["image/vnd.radiance", "image/x-exr"])
  })
})

describe("太阳几何与昼夜模型", () => {
  test("方向是单位向量，方位角自 +X 起、仰角自 XY 平面起", () => {
    const [x, y, z] = sunDirectionVector(0, 0)
    expect([x, y, z].map(value => Number(value.toFixed(6)))).toEqual([1, 0, 0])
    const up = sunDirectionVector(0, 90)
    expect(up[2]).toBeCloseTo(1, 6)
    const length = Math.hypot(...sunDirectionVector(215, 33))
    expect(length).toBeCloseTo(1, 9)
  })

  test("昼夜：正午最高、午夜最低、日出前后渐亮（不是 0/满的硬开关）", () => {
    const noon = dayNightSun(12, 3)
    const midnight = dayNightSun(0, 3)
    expect(noon.elevationDeg).toBeCloseTo(DAY_NIGHT_MAX_ELEVATION_DEG, 6)
    expect(noon.daylight).toBe(1)
    expect(noon.intensity).toBeCloseTo(3, 6)
    expect(midnight.elevationDeg).toBeCloseTo(-DAY_NIGHT_MAX_ELEVATION_DEG, 6)
    expect(midnight.daylight).toBe(0)
    expect(midnight.intensity).toBe(0)
    const dawn = dayNightSun(6, 3)
    expect(dawn.elevationDeg).toBeCloseTo(0, 6)
    expect(dawn.daylight).toBeGreaterThan(0)
    expect(dawn.daylight).toBeLessThan(1)
    // 单调：日出那一段（仰角 0→12°，约 6:00–7:00）越来越亮，越过 12° 后到顶不再变
    expect(dayNightSun(6.5, 3).daylight).toBeGreaterThan(dayNightSun(6, 3).daylight)
    expect(dayNightSun(7, 3).daylight).toBe(1)
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 6)
  })

  test("生效读数：昼夜关闭时用手填方向、开启后由时刻推出", () => {
    const manual = defaultSceneEnvironment({ sun: { azimuthDeg: 30, elevationDeg: 20, intensity: 2 } })
    const off = environmentLiveState(manual, { playing: false, offsetHours: 0, advancedSeconds: 0 })
    expect(off.sun.source).toBe("manual")
    expect(off.sun.azimuthDeg).toBe(30)
    expect(off.timeHours).toBe(12)
    expect(environmentDaylightFactor(off, manual)).toBe(1)

    const dayNight = defaultSceneEnvironment({ sun: { azimuthDeg: 30, elevationDeg: 20, intensity: 2 }, dayNight: { enabled: true, timeHours: 12, cycleSeconds: 60 } })
    const on = environmentLiveState(dayNight, { playing: false, offsetHours: 0, advancedSeconds: 0 })
    expect(on.sun.source).toBe("dayNight")
    expect(on.sun.azimuthDeg).toBeCloseTo(90, 6)
    expect(on.sun.elevationDeg).toBeCloseTo(DAY_NIGHT_MAX_ELEVATION_DEG, 6)
    expect(on.sun.intensity).toBeCloseTo(2, 6)
    const night = environmentLiveState(dayNight, { playing: false, offsetHours: 12, advancedSeconds: 0 })
    expect(night.timeHours).toBe(0)
    expect(night.sun.intensity).toBe(0)
    expect(environmentDaylightFactor(night, dayNight)).toBeCloseTo(DAY_NIGHT_NIGHT_FLOOR, 6)
    expect(environmentDaylightFactor(night, dayNight)).toBeGreaterThan(0)
  })
})

describe("渲染时钟", () => {
  test("未播放/无效增量原地不动（返回同一个对象，调用方能靠引用判等跳过重算）", () => {
    const clock = { playing: false, offsetHours: 0, advancedSeconds: 0 }
    expect(advanceEnvironmentClock(clock, 1, 60)).toBe(clock)
    expect(advanceEnvironmentClock({ ...clock, playing: true }, 0, 60)).toEqual({ playing: true, offsetHours: 0, advancedSeconds: 0 })
    expect(advanceEnvironmentClock({ ...clock, playing: true }, Number.NaN, 60).advancedSeconds).toBe(0)
  })

  test("播放推进渲染时钟；单帧最多 1 秒（切回标签页不会一下跳过半个昼夜）", () => {
    const clock = { playing: true, offsetHours: 0, advancedSeconds: 0 }
    const half = advanceEnvironmentClock(clock, 0.5, 60)
    expect(half.advancedSeconds).toBeCloseTo(0.5, 9)
    expect(half.offsetHours).toBeCloseTo(0.5 / 60 * 24, 9)
    const burst = advanceEnvironmentClock(clock, 90, 60)
    expect(burst.advancedSeconds).toBe(1)
    expect(burst.offsetHours).toBeCloseTo(24 / 60, 9)
    // 一个完整周期回到起点（24 小时）
    expect(advanceEnvironmentClock({ playing: true, offsetHours: 0, advancedSeconds: 0 }, 1, 1).offsetHours).toBeCloseTo(24, 9)
  })
})

describe("补丁合成", () => {
  test("没有当前组件时从 Viewer 改造前的缺省起，只改补丁点到的字段", () => {
    const { component, warnings } = composeEnvironment(undefined, { exposure: 2 })
    expect(component.exposure).toBe(2)
    expect(component.environmentIntensity).toBe(0.7)
    expect(component.sun.azimuthDeg).toBe(90)
    expect(warnings).toEqual([])
  })

  test("嵌套字段是合并而不是整体替换（只动 intensity 不该抹掉方向）", () => {
    const current = defaultSceneEnvironment({ sun: { azimuthDeg: 200, elevationDeg: 10, intensity: 1 }, dayNight: { enabled: true, timeHours: 18, cycleSeconds: 120 } })
    const { component } = composeEnvironment(current, { sun: { intensity: 5 } })
    expect(component.sun).toEqual({ azimuthDeg: 200, elevationDeg: 10, intensity: 5 })
    expect(component.dayNight).toEqual({ enabled: true, timeHours: 18, cycleSeconds: 120 })
    expect(component.background).toBe("color")
  })

  test("hdri:null 去掉 HDRI；给了 hdri 就如实记下；非法补丁抛错而不是写进半份组件", () => {
    const withHdri = composeEnvironment(undefined, { hdri: { resourceId: "sky-1", version: 1 } }).component
    expect(withHdri.hdri).toEqual({ resourceId: "sky-1", version: 1 })
    expect(composeEnvironment(withHdri, { hdri: null }).component.hdri).toBeUndefined()
    expect(() => composeEnvironment(withHdri, { hdri: { resourceId: "", version: 1 } })).toThrow(/ENVIRONMENT_PATCH_INVALID/)
  })

  test("补丁里的越界值走同一条规范化并回报警告", () => {
    const { component, warnings } = composeEnvironment(undefined, { exposure: 99, dayNight: { cycleSeconds: 1 } })
    expect(component.exposure).toBe(ENVIRONMENT_LIMITS.exposure)
    expect(component.dayNight.cycleSeconds).toBe(ENVIRONMENT_LIMITS.cycleSecondsMin)
    expect(warnings).toHaveLength(2)
  })
})

describe("场景自带的背景色（backgroundColor）", () => {
  test("缺省＝没有这一份（历史场景不会被改色，沿用查看器偏好）", () => {
    const parsed = parseEnvironmentComponent({ kind: ENVIRONMENT_KIND })
    if ("error" in parsed) throw new Error(parsed.error)
    expect(parsed.component.backgroundColor).toBeUndefined()
    expect(parsed.warnings).toEqual([])
    // 缺省值与"有这份色"是两种状态：前者不写进组件，后者才写
    expect("backgroundColor" in parsed.component).toBe(false)
  })

  test("合法 #rrggbb 大小写不敏感并规范化为小写；写进文档后能被读回来", () => {
    const parsed = parseEnvironmentComponent({ kind: ENVIRONMENT_KIND, backgroundColor: "#AABB12" })
    if ("error" in parsed) throw new Error(parsed.error)
    expect(parsed.component.backgroundColor).toBe("#aabb12")
    expect(parsed.warnings).toEqual([])
    const scan = scanSceneEnvironment(snapshot(entity("lighting", { [ENVIRONMENT_COMPONENT_KEY]: { kind: ENVIRONMENT_KIND, backgroundColor: "#0a0b0c" } })))
    expect(scan.environment?.component.backgroundColor).toBe("#0a0b0c")
  })

  test("不是 #rrggbb（含 3 位简写/无 #/非字符串）就忽略并记警告，不当成生效色", () => {
    for (const value of ["#abc", "0a0b0c", "#12345g", 123456, { hex: "#ffffff" }]) {
      const parsed = parseEnvironmentComponent({ kind: ENVIRONMENT_KIND, backgroundColor: value })
      if ("error" in parsed) throw new Error(parsed.error)
      expect(parsed.component.backgroundColor).toBeUndefined()
      expect(parsed.warnings[0]).toContain("ENVIRONMENT_FIELD_DEFAULTED: backgroundColor=")
      expect(parsed.warnings[0]).toContain("沿用查看器的背景色偏好")
    }
  })

  test("补丁：给色／换色／用 null 去掉这一份", () => {
    const withColor = composeEnvironment(undefined, { backgroundColor: "#102030" }).component
    expect(withColor.backgroundColor).toBe("#102030")
    expect(composeEnvironment(withColor, { backgroundColor: "#405060" }).component.backgroundColor).toBe("#405060")
    const cleared = composeEnvironment(withColor, { backgroundColor: null }).component
    expect(cleared.backgroundColor).toBeUndefined()
    // 去掉之后再走一遍解析也不是"变成黑色"，而是明确的没有这一份
    expect("backgroundColor" in cleared).toBe(false)
  })
})

describe("环境组件在文档里的形状", () => {
  test("组件键与 kind 是面板/Agent/Viewer 共用的那一组常量", () => {
    expect(ENVIRONMENT_COMPONENT_KEY).toBe("environment")
    expect(ENVIRONMENT_KIND).toBe("scene/environment")
    const component: SceneEnvironment = defaultSceneEnvironment()
    expect(component.kind).toBe(ENVIRONMENT_KIND)
  })
})
