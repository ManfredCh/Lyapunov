/**
 * Scene 环境光照：`entity.components.environment` 的**唯一格式定义**与纯计算。
 *
 * 为什么落成组件而不是新的保存库：`SceneSnapshot` 顶层没有 metadata 字段（lyapunov-contracts/types.ts），
 * 场景侧唯一的可持久化命名空间就是实体组件。环境光照因此写成一条**普通实体的组件**——
 * 它随场景文档一起 CAS 提交、随 `scene_edit` 被 Agent 改、随 `scene_history` 回退，
 * 不需要第二套存储、快照或同步逻辑。HDRI 走实体自己的 `resources`（ResourceRef），
 * 组件里只留 resourceId@version，绝不写临时绝对路径。
 *
 * 本文件只放**纯函数与类型**（解析、规范化、太阳几何、昼夜时钟）。落到 THREE 对象与渲染器上的
 * 应用（PMREM、曝光、阴影、天空盒）在 index.ts：渲染器只有那一份 owner。
 */
import type { Entity, Representation, ResourceRef, SceneSnapshot, Vec3 } from "../../lyapunov-contracts/src/types.ts"

/** 组件键：环境光照住在 `entity.components.environment`。 */
export const ENVIRONMENT_COMPONENT_KEY = "environment"
/** 判别值：只有 `kind` 完全等于它的记录才被当成环境光照；别的同名记录不静默当环境用。 */
export const ENVIRONMENT_KIND = "scene/environment"
/** HDRI 资源的 mimeType（与 scene-kit/formats.ts 的 .hdr/.exr 解析一一对应）。 */
export const HDRI_MIME_TYPES = ["image/vnd.radiance", "image/x-exr"] as const

/** HDRI 引用：只记 resourceId@version（Scene 的资源身份），URI 从实体的 ResourceRef 取。 */
export interface SceneEnvironmentHdri { resourceId: string; version: number }
/** 太阳：方向为**世界方向**（光从太阳射向场景），方位角自 +X 轴起绕 +Z 轴，仰角自 XY 平面起。 */
export interface SceneEnvironmentSun { azimuthDeg: number; elevationDeg: number; intensity: number }
/**
 * 连续昼夜：timeHours 是**静态配置**（保存重开一致），播放只推进 Viewer 自己的渲染时钟
 * （`offsetHours`），不写 Scene、不碰物理。
 */
export interface SceneEnvironmentDayNight { enabled: boolean; timeHours: number; cycleSeconds: number }
/** Three r180 的原生色调映射；历史场景保持 ACES。 */
export const ENVIRONMENT_TONE_MAPPINGS = ["aces", "agx", "neutral", "linear", "none"] as const
export type EnvironmentToneMapping = typeof ENVIRONMENT_TONE_MAPPINGS[number]
export interface SceneEnvironmentShadow { mapSize: 512 | 1024 | 2048 | 4096; bias: number; normalBias: number }

export interface SceneEnvironment {
  kind: typeof ENVIRONMENT_KIND
  /** IBL 强度（`scene.environmentIntensity`）；未声明 HDRI 时作用于内置环境光。 */
  environmentIntensity: number
  /** 半球补光强度：作者没打灯、或用户关掉 Scene 灯时场景仍可读。 */
  hemisphereIntensity: number
  /** 色调映射曝光（`renderer.toneMappingExposure`）。 */
  exposure: number
  toneMapping: EnvironmentToneMapping
  /** 环境贴图旋转（XYZ 欧拉角，度）；Z 是场景世界竖轴，X/Y 可对齐 HDRI 源轴。 */
  environmentRotationDeg: Vec3
  /** 背景：`environment`＝显示 HDRI 天空盒；`color`＝纯色背景。 */
  background: "environment" | "color"
  /**
   * 纯色背景的**场景自带颜色**（`#rrggbb`）：给了就用它，随场景文档一起保存、重开一致。
   * 缺省＝没有这一份，沿用查看器/相机面板那条偏好色——历史场景不会因为加了环境光照就被改色。
   */
  backgroundColor?: string
  /** 阴影：由太阳（DirectionalLight）投射；关掉后渲染器不再做阴影贴图。 */
  shadows: boolean
  shadow: SceneEnvironmentShadow
  sun: SceneEnvironmentSun
  dayNight: SceneEnvironmentDayNight
  /** 缺省表示用内置环境光（改造前的行为），而不是"没有环境"。 */
  hdri?: SceneEnvironmentHdri
}

/** 环境强度/曝光/太阳强度的上界：无界输入会把画面烧成白屏，也不能当成"更亮"的证据。 */
export const ENVIRONMENT_LIMITS = { exposure: 8, intensity: 8, cycleSecondsMin: 5, cycleSecondsMax: 86400 } as const
/** 昼夜模型的日照上限仰角（简化模型，不是天文星历）。 */
export const DAY_NIGHT_MAX_ELEVATION_DEG = 55
/** 夜里 IBL/天空盒保留的比例：全黑会让人以为渲染坏了，但它必须明显暗于白天。 */
export const DAY_NIGHT_NIGHT_FLOOR = 0.12

/** 组件缺省值：与环境光照出现之前 Viewer 的硬编码读数一致（IBL 0.7 / 半球 2.4 / 太阳 3），
 *  太阳方向取正午偏东的 90° 方位、45° 仰角。旧场景没有这个组件时不进入这条路径，读数不被改写。 */
export const SCENE_ENVIRONMENT_DEFAULTS = {
  kind: ENVIRONMENT_KIND,
  environmentIntensity: 0.7,
  hemisphereIntensity: 2.4,
  exposure: 1,
  toneMapping: "aces",
  environmentRotationDeg: [0, 0, 0],
  background: "color",
  shadows: false,
  shadow: { mapSize: 512, bias: -0.0005, normalBias: 0 },
  sun: { azimuthDeg: 90, elevationDeg: 45, intensity: 3 },
  dayNight: { enabled: false, timeHours: 12, cycleSeconds: 60 },
} as const satisfies Omit<SceneEnvironment, "hdri">

export function defaultSceneEnvironment(overrides: Partial<SceneEnvironment> = {}): SceneEnvironment {
  const { sun, dayNight, shadow, ...rest } = overrides
  return {
    ...SCENE_ENVIRONMENT_DEFAULTS,
    ...rest,
    sun: { ...SCENE_ENVIRONMENT_DEFAULTS.sun, ...sun },
    dayNight: { ...SCENE_ENVIRONMENT_DEFAULTS.dayNight, ...dayNight },
    shadow: { ...SCENE_ENVIRONMENT_DEFAULTS.shadow, ...shadow },
    environmentRotationDeg: [...(overrides.environmentRotationDeg ?? SCENE_ENVIRONMENT_DEFAULTS.environmentRotationDeg)],
  }
}

const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
/** 组件里能保存的纯色背景形状：`#rrggbb`（大小写不敏感，落库前规范化为小写）。 */
const BACKGROUND_COLOR_HEX = /^#[0-9a-fA-F]{6}$/
/** 归一化到 [0, span)，span 非正或输入非有限时抛错（调用方已经校验过，这里只是不静默）。 */
export function normalizeWrapped(value: number, span: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(span) || span <= 0) throw new Error(`ENVIRONMENT_VALUE_INVALID: ${value}`)
  return ((value % span) + span) % span
}
/** 平滑过渡：昼夜模型里把"刚出地平线"的太阳做成渐亮，而不是 0/满的硬开关。 */
export function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value < edge0 ? 0 : 1
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

export interface EnvironmentParseSuccess { component: SceneEnvironment; warnings: string[] }
export interface EnvironmentParseFailure { error: string }
export type EnvironmentParseResult = EnvironmentParseSuccess | EnvironmentParseFailure

/**
 * 解析一条 `components.environment` 记录：**只接受** `kind === "scene/environment"`。
 *
 * 实际行为（解析结果里的 `component` 就是**生效读数**，调用方不需要再算一遍）：
 *  · 缺失字段用默认值补齐（静默，缺省本来就是它的正常状态）；
 *  · 越界数值收敛到上界、类型不对/不是 `#rrggbb` 的颜色**回默认值或忽略**，并逐条记 warning
 *    （`ENVIRONMENT_FIELD_CLAMPED` / `ENVIRONMENT_FIELD_DEFAULTED`）——模型把 0.5 打成 500 时，
 *    面板与验收能读到"被收敛过/被换过"，而不是拿到一个看起来正常的假读数；
 *  · 只有两处是硬错误：`kind` 不是 `scene/environment`（这根本不是环境光照），
 *    以及 `hdri` 形状不合法（`{resourceId:string, version:int≥1}`）——指向哪张天空是实打实的引用，
 *    猜一个只会让人以为"文档写的生效了"。硬错误返回 `{error}`，其余一律返回规范化后的生效组件 + warnings。
 */
export function parseEnvironmentComponent(value: unknown): EnvironmentParseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "ENVIRONMENT_COMPONENT_NOT_OBJECT" }
  const raw = value as Record<string, unknown>
  if (raw.kind !== ENVIRONMENT_KIND) return { error: `ENVIRONMENT_KIND_UNSUPPORTED: ${String(raw.kind)}` }
  const warnings: string[] = []
  const defaults = defaultSceneEnvironment()
  const number = (input: unknown, fallback: number, path: string, min: number, max: number): number => {
    const parsed = finite(input)
    const renderControl = path.startsWith("shadow.") || path.startsWith("environmentRotationDeg[")
    if (parsed === undefined) {
      if (input !== undefined) warnings.push(renderControl ? `ENVIRONMENT_FIELD_DEFAULTED: ${path}=${JSON.stringify(input)} is not a finite number; using ${fallback}` : `ENVIRONMENT_FIELD_DEFAULTED: ${path}=${JSON.stringify(input)} 不是有限数值，用默认 ${fallback}`)
      return fallback
    }
    if (parsed < min || parsed > max) {
      warnings.push(renderControl ? `ENVIRONMENT_FIELD_CLAMPED: ${path}=${parsed} clamped to [${min}, ${max}]` : `ENVIRONMENT_FIELD_CLAMPED: ${path}=${parsed} 收敛到 [${min}, ${max}]`)
      return clamp(parsed, min, max)
    }
    return parsed
  }
  const boolean = (input: unknown, fallback: boolean, path: string): boolean => {
    if (input === undefined) return fallback
    if (typeof input !== "boolean") { warnings.push(`ENVIRONMENT_FIELD_DEFAULTED: ${path}=${JSON.stringify(input)} 不是布尔值，用默认 ${fallback}`); return fallback }
    return input
  }
  const color = (input: unknown, path: string): string | undefined => {
    if (input === undefined) return undefined
    if (typeof input !== "string" || !BACKGROUND_COLOR_HEX.test(input)) {
      warnings.push(`ENVIRONMENT_FIELD_DEFAULTED: ${path}=${JSON.stringify(input)} 不是 #rrggbb 颜色，忽略（纯色背景沿用查看器的背景色偏好）`)
      return undefined
    }
    return input.toLowerCase()
  }
  const sun = raw.sun && typeof raw.sun === "object" && !Array.isArray(raw.sun) ? raw.sun as Record<string, unknown> : {}
  if (raw.sun !== undefined && sun !== raw.sun) warnings.push("ENVIRONMENT_FIELD_DEFAULTED: sun 不是对象，用默认值")
  const dayNight = raw.dayNight && typeof raw.dayNight === "object" && !Array.isArray(raw.dayNight) ? raw.dayNight as Record<string, unknown> : {}
  if (raw.dayNight !== undefined && dayNight !== raw.dayNight) warnings.push("ENVIRONMENT_FIELD_DEFAULTED: dayNight 不是对象，用默认值")
  const shadow = raw.shadow && typeof raw.shadow === "object" && !Array.isArray(raw.shadow) ? raw.shadow as Record<string, unknown> : {}
  if (raw.shadow !== undefined && shadow !== raw.shadow) warnings.push("ENVIRONMENT_FIELD_DEFAULTED: shadow must be an object; using defaults")
  const toneMapping = ENVIRONMENT_TONE_MAPPINGS.includes(raw.toneMapping as EnvironmentToneMapping) ? raw.toneMapping as EnvironmentToneMapping : defaults.toneMapping
  if (raw.toneMapping !== undefined && raw.toneMapping !== toneMapping) warnings.push("ENVIRONMENT_FIELD_DEFAULTED: toneMapping is unsupported; using aces")
  const mapSize = [512, 1024, 2048, 4096].includes(shadow.mapSize as number) ? shadow.mapSize as SceneEnvironmentShadow["mapSize"] : defaults.shadow.mapSize
  if (shadow.mapSize !== undefined && shadow.mapSize !== mapSize) warnings.push("ENVIRONMENT_FIELD_DEFAULTED: shadow.mapSize must be 512/1024/2048/4096; using 512")
  const rotation = Array.isArray(raw.environmentRotationDeg) && raw.environmentRotationDeg.length === 3 ? raw.environmentRotationDeg : defaults.environmentRotationDeg
  if (raw.environmentRotationDeg !== undefined && rotation !== raw.environmentRotationDeg) warnings.push("ENVIRONMENT_FIELD_DEFAULTED: environmentRotationDeg must be [x,y,z]; using [0,0,0]")
  const background = raw.background === undefined || raw.background === "color" || raw.background === "environment"
    ? raw.background as SceneEnvironment["background"] ?? defaults.background
    : (() => { warnings.push(`ENVIRONMENT_FIELD_DEFAULTED: background=${JSON.stringify(raw.background)} 不是 color/environment，用默认 ${defaults.background}`); return defaults.background })()
  const component: SceneEnvironment = {
    kind: ENVIRONMENT_KIND,
    environmentIntensity: number(raw.environmentIntensity, defaults.environmentIntensity, "environmentIntensity", 0, ENVIRONMENT_LIMITS.intensity),
    hemisphereIntensity: number(raw.hemisphereIntensity, defaults.hemisphereIntensity, "hemisphereIntensity", 0, ENVIRONMENT_LIMITS.intensity),
    exposure: number(raw.exposure, defaults.exposure, "exposure", 0, ENVIRONMENT_LIMITS.exposure),
    toneMapping,
    environmentRotationDeg: rotation.map((value, index) => normalizeWrapped(number(value, 0, `environmentRotationDeg[${index}]`, -3600, 3600), 360)) as Vec3,
    background,
    shadows: boolean(raw.shadows, defaults.shadows, "shadows"),
    shadow: { mapSize, bias: number(shadow.bias, defaults.shadow.bias, "shadow.bias", -0.01, 0.01), normalBias: number(shadow.normalBias, defaults.shadow.normalBias, "shadow.normalBias", 0, 1) },
    sun: {
      azimuthDeg: normalizeWrapped(number(sun.azimuthDeg, defaults.sun.azimuthDeg, "sun.azimuthDeg", -3600, 3600), 360),
      elevationDeg: number(sun.elevationDeg, defaults.sun.elevationDeg, "sun.elevationDeg", -90, 90),
      intensity: number(sun.intensity, defaults.sun.intensity, "sun.intensity", 0, ENVIRONMENT_LIMITS.intensity),
    },
    dayNight: {
      enabled: boolean(dayNight.enabled, defaults.dayNight.enabled, "dayNight.enabled"),
      timeHours: normalizeWrapped(number(dayNight.timeHours, defaults.dayNight.timeHours, "dayNight.timeHours", -24 * 366, 24 * 366), 24),
      cycleSeconds: number(dayNight.cycleSeconds, defaults.dayNight.cycleSeconds, "dayNight.cycleSeconds", ENVIRONMENT_LIMITS.cycleSecondsMin, ENVIRONMENT_LIMITS.cycleSecondsMax),
    },
  }
  const backgroundColor = color(raw.backgroundColor, "backgroundColor")
  if (backgroundColor) component.backgroundColor = backgroundColor
  if (raw.hdri !== undefined) {
    const hdri = raw.hdri && typeof raw.hdri === "object" && !Array.isArray(raw.hdri) ? raw.hdri as Record<string, unknown> : undefined
    const resourceId = hdri?.resourceId, version = finite(hdri?.version)
    if (!hdri || typeof resourceId !== "string" || !resourceId || version === undefined || !Number.isInteger(version) || version < 1) {
      return { error: `ENVIRONMENT_HDRI_INVALID: ${JSON.stringify(raw.hdri)}` }
    }
    component.hdri = { resourceId, version }
  }
  return { component, warnings }
}

export interface ResolvedSceneEnvironment { entityId: string; entity: Entity; component: SceneEnvironment; warnings: string[] }
export interface EnvironmentScan {
  /** 文档顺序里第一条**有效**的环境组件（多份时后面的被忽略，并如实记进 diagnostics）。 */
  environment?: ResolvedSceneEnvironment
  /** 声明了 components.environment 但没被采纳的记录：模型写错格式时能立刻看到原因。 */
  diagnostics: Array<{ entityId: string; reason: string }>
}

/** 从场景快照里取出环境光照：Viewer 与面板读的都是这一份，不各自解析一遍。 */
export function scanSceneEnvironment(snapshot: Pick<SceneSnapshot, "entities"> | undefined): EnvironmentScan {
  const diagnostics: EnvironmentScan["diagnostics"] = []
  if (!snapshot?.entities) return { diagnostics }
  let environment: ResolvedSceneEnvironment | undefined
  for (const entity of snapshot.entities) {
    const record = entity.components?.[ENVIRONMENT_COMPONENT_KEY]
    if (record === undefined) continue
    const parsed = parseEnvironmentComponent(record)
    if ("error" in parsed) { diagnostics.push({ entityId: entity.entityId, reason: parsed.error }); continue }
    if (environment) { diagnostics.push({ entityId: entity.entityId, reason: `ENVIRONMENT_DUPLICATE_IGNORED: 已有 ${environment.entityId} 承载环境光照` }); continue }
    environment = { entityId: entity.entityId, entity, component: parsed.component, warnings: parsed.warnings.map(warning => `${entity.entityId}: ${warning}`) }
  }
  return { environment, diagnostics }
}

/**
 * HDRI 解析结果：成功＝组件指的那条资源**精确到这个版本**、且它带着 HDRI 表示；
 * 失败＝带原因的诊断（哪一份缺、实体上到底有哪几个版本）。
 */
export type EnvironmentHdriResolution =
  | { ok: true; ref: ResourceRef; representation: Representation }
  | { ok: false; error: string }

/**
 * HDRI 表示：组件指到 `resourceId@version`，就从该实体的 ResourceRef 里取**那一条**的表示。
 *
 * **不做同 id 任意版本的兜底**：请求 v2 而实体上只有 v1 时报 `ENVIRONMENT_HDRI_VERSION_MISSING`
 * 并列出实际版本——否则画面会拿旧图冒充新版本，"读数说 v2、下载的是 v1"这种错误没人看得见
 * （2026-09-20 审查）。找不到就明确失败，由调用方决定回退到内置环境光。
 */
export function resolveEnvironmentHdri(entity: Entity, component: SceneEnvironment): EnvironmentHdriResolution | undefined {
  const hdri = component.hdri
  if (!hdri) return undefined
  const ref = entity.resources.find(item => item.resourceId === hdri.resourceId && item.version === hdri.version)
  if (!ref) {
    const sameId = entity.resources.filter(item => item.resourceId === hdri.resourceId).map(item => `@${item.version}`)
    return {
      ok: false,
      error: sameId.length
        ? `ENVIRONMENT_HDRI_VERSION_MISSING: ${hdri.resourceId}@${hdri.version} 不在承载实体的 resources 里（实体上只有 ${hdri.resourceId}${sameId.join("、")}）；不拿别的版本顶替`
        : `ENVIRONMENT_HDRI_RESOURCE_MISSING: ${hdri.resourceId}@${hdri.version} 不在承载实体的 resources 里`,
    }
  }
  const isHdri = (mimeType: string): boolean => (HDRI_MIME_TYPES as readonly string[]).includes(mimeType)
  const representation = ref.representations.find(item => isHdri(item.mimeType)) ?? (isHdri(ref.original.mimeType) ? ref.original : undefined)
  if (!representation) {
    const actual = [...ref.representations.map(item => item.mimeType), ref.original.mimeType].join("、")
    return { ok: false, error: `ENVIRONMENT_HDRI_REPRESENTATION_MISSING: ${hdri.resourceId}@${hdri.version} 的表示里没有 HDRI（要 ${HDRI_MIME_TYPES.join(" 或 ")}；实际是 ${actual}）` }
  }
  return { ok: true, ref, representation }
}

/**
 * 一条环境光照**补丁**：界面上一次改动就是一条补丁（可能只动一个滑块）。
 *
 * 为什么用补丁而不是让界面拼整份组件：整份组件里每个字段的默认值/上界/归一化规则都在本文件，
 * 界面与 Agent 各拼一份必然漂移。补丁经 `composeEnvironment` 合到当前生效值上，
 * 再走同一条解析规范化，落进文档的值永远是本文件定义的形状。
 * `hdri: null` 表示"去掉 HDRI，回到内置环境光"。
 */
export interface EnvironmentPatch {
  environmentIntensity?: number
  hemisphereIntensity?: number
  exposure?: number
  toneMapping?: EnvironmentToneMapping
  environmentRotationDeg?: Vec3
  background?: SceneEnvironment["background"]
  /** `null`／缺省表示"没有场景自带的背景色"（沿用查看器偏好），字符串必须是 `#rrggbb`。 */
  backgroundColor?: string | null
  shadows?: boolean
  shadow?: Partial<SceneEnvironmentShadow>
  sun?: Partial<SceneEnvironmentSun>
  dayNight?: Partial<SceneEnvironmentDayNight>
  hdri?: SceneEnvironmentHdri | null
}

export interface EnvironmentComposition { component: SceneEnvironment; warnings: string[] }

/**
 * 把补丁合到当前生效组件上（没有就按默认值起），并用同一条解析规则规范化。
 * 规范化警告会返回给调用方——被收敛过的输入不该看起来像"原样生效"。
 */
export function composeEnvironment(current: SceneEnvironment | undefined, patch: EnvironmentPatch): EnvironmentComposition {
  const base = current ?? defaultSceneEnvironment()
  const merged: Record<string, unknown> = {
    ...base,
    ...("environmentIntensity" in patch ? { environmentIntensity: patch.environmentIntensity } : {}),
    ...("hemisphereIntensity" in patch ? { hemisphereIntensity: patch.hemisphereIntensity } : {}),
    ...("exposure" in patch ? { exposure: patch.exposure } : {}),
    ...("toneMapping" in patch ? { toneMapping: patch.toneMapping } : {}),
    ...("environmentRotationDeg" in patch ? { environmentRotationDeg: patch.environmentRotationDeg } : {}),
    ...("background" in patch ? { background: patch.background } : {}),
    ...("shadows" in patch ? { shadows: patch.shadows } : {}),
    sun: { ...base.sun, ...patch.sun },
    dayNight: { ...base.dayNight, ...patch.dayNight },
    shadow: { ...base.shadow, ...patch.shadow },
  }
  if ("backgroundColor" in patch) {
    if (patch.backgroundColor === null || patch.backgroundColor === undefined) delete merged.backgroundColor
    else merged.backgroundColor = patch.backgroundColor
  }
  if ("hdri" in patch) {
    if (patch.hdri === null) delete merged.hdri
    else merged.hdri = patch.hdri
  }
  const parsed = parseEnvironmentComponent(merged)
  if ("error" in parsed) throw new Error(`ENVIRONMENT_PATCH_INVALID: ${parsed.error}`)
  return { component: parsed.component, warnings: parsed.warnings }
}

/** 太阳方向（单位向量，从场景指向太阳）。方位角自 +X 轴起绕 +Z 轴，仰角自 XY 平面起。 */
export function sunDirectionVector(azimuthDeg: number, elevationDeg: number): Vec3 {
  const azimuth = azimuthDeg * Math.PI / 180, elevation = elevationDeg * Math.PI / 180
  const horizontal = Math.cos(elevation)
  return [horizontal * Math.cos(azimuth), horizontal * Math.sin(azimuth), Math.sin(elevation)]
}

export interface EnvironmentSunState { azimuthDeg: number; elevationDeg: number; intensity: number; daylight: number }

/**
 * 昼夜模型：一天 24 小时绕一圈，正午最高、午夜最低（简化模型，不是天文星历）。
 * 仰角 = 55°·cos(π(h−12)/12)；方位角随小时角匀速转过 360°。日照系数 smoothstep(−2°, 12°, 仰角)：
 * 太阳落到地平线下就真的没有日照，而不是"低角度还在打强光"。
 */
export function dayNightSun(timeHours: number, baseIntensity: number): EnvironmentSunState {
  const hours = normalizeWrapped(timeHours, 24)
  const elevationDeg = DAY_NIGHT_MAX_ELEVATION_DEG * Math.cos(Math.PI * (hours - 12) / 12)
  const daylight = smoothstep(-2, 12, elevationDeg)
  return { azimuthDeg: normalizeWrapped(90 + (hours - 12) * 15, 360), elevationDeg, intensity: Math.max(0, baseIntensity) * daylight, daylight }
}

/** 昼夜的渲染时钟：只属于 Viewer。播放时推进 offsetHours，静态配置 timeHours 一个字节都不动。 */
export interface EnvironmentClockState { playing: boolean; offsetHours: number; advancedSeconds: number }
export function advanceEnvironmentClock(state: EnvironmentClockState, deltaSeconds: number, cycleSeconds: number): EnvironmentClockState {
  if (!state.playing || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0 || !Number.isFinite(cycleSeconds) || cycleSeconds <= 0) return state
  const advanced = Math.min(deltaSeconds, 1) // 大间歇（标签页切回来）不当成"一天过去了很多次"：单帧最多推进 1 秒
  return { ...state, offsetHours: state.offsetHours + advanced / cycleSeconds * 24, advancedSeconds: state.advancedSeconds + advanced }
}

export interface EnvironmentLiveState {
  /** 生效的太阳（昼夜开＝由 timeHours 推出，关＝组件里手填的方向）。 */
  sun: EnvironmentSunState & { source: "manual" | "dayNight" }
  /** 生效的渲染时刻（小时）：昼夜关闭时就是静态 timeHours。 */
  timeHours: number
  clock: EnvironmentClockState
}

/** 由组件 + 渲染时钟算出**这一帧**实际生效的环境读数。Viewer 的渲染循环与面板读的都是它。 */
export function environmentLiveState(component: SceneEnvironment, clock: EnvironmentClockState): EnvironmentLiveState {
  const timeHours = normalizeWrapped(component.dayNight.timeHours + clock.offsetHours, 24)
  if (!component.dayNight.enabled) {
    return { sun: { azimuthDeg: component.sun.azimuthDeg, elevationDeg: component.sun.elevationDeg, intensity: component.sun.intensity, daylight: component.sun.elevationDeg > 0 ? 1 : 0, source: "manual" }, timeHours, clock }
  }
  return { sun: { ...dayNightSun(timeHours, component.sun.intensity), source: "dayNight" }, timeHours, clock }
}

/**
 * 昼夜对 IBL 与天空盒的作用：夜里保留 `DAY_NIGHT_NIGHT_FLOOR` 的比例，白昼按日照系数过渡。
 * 未开昼夜时返回 1（不改变作者写的环境强度）。
 */
export function environmentDaylightFactor(state: EnvironmentLiveState, component: SceneEnvironment): number {
  if (!component.dayNight.enabled) return 1
  return DAY_NIGHT_NIGHT_FLOOR + (1 - DAY_NIGHT_NIGHT_FLOOR) * state.sun.daylight
}
