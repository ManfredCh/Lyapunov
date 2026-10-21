/**
 * A→B→C 世界机位路线（R-005）：**有序**引用已保存的世界机位，每段时长与每站停留具名、可校验。
 *
 * 设计纪律：
 *  · 机位本体仍只有一份 owner——Scene 文档里的 `components.viewerCamera.cameras`（`NamedCamera`）。
 *    路线只按**名字**引用它们，不复制位姿，也不新开第二份相机数据库。
 *  · 路线自身随同一份 Viewer 相机组件保存（`viewerCamera.routes`），因此跟着场景版本历史回退、可被
 *    另一个窗口读到、重开顺序与参数不丢。
 *  · 位置插值用线性 lerp（米），旋转插值用四元数 slerp（xyzw，归一化）；普通镜头线性插值 `fovDeg`（度）；
 *    照片内参（fx/fy/cx/cy）线性插值；裁剪面 near/far（米）线性插值。
 *  · 两站镜头类型无法安全插值（一边普通镜头一边照片内参、或内参画幅不同）时**给具体原因并拒绝**，
 *    绝不静默把一种镜头类型当成另一种。
 *  · 路线只驱动镜头，不执行机器人动作、不推进 world 时钟、不自动启动物理。
 *
 * 纯函数模块：插值、校验、排序、时间轴采样都可离线复算，不依赖 React/Viewer。
 */
import type { NamedCamera, ViewerCameraIntrinsics } from "../../viewer/src/camera-view.ts"
import type { ViewerViewState } from "../../viewer/src/index.ts"

/** 单条路线上限：够用，也挡住手改文档把组件撑爆。 */
export const MAX_ROUTE_STOPS = 8
export const MAX_ROUTE_SEGMENT_MS = 120_000
export const MAX_ROUTE_HOLD_MS = 60_000
export const MAX_ROUTE_NAME = 60

export interface CaptureRouteStop {
  cameraName: string
  /** 到达该机位后的停留时间（毫秒）。 */
  holdMs: number
}
export interface CaptureRoute {
  routeId: string
  name: string
  sceneId: string
  sceneRevision: number
  /** 有序机位引用（A→B→C…）；每项带该站停留。 */
  stops: CaptureRouteStop[]
  /** 段时长：`segmentMs[i]` 是 `stops[i]`→`stops[i+1]` 的飞行时间（毫秒），长度为 stops-1。 */
  segmentMs: number[]
  savedAt: string
}

const ms = (value: unknown, max: number): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value) : undefined

/**
 * 读入即校验（场景文档是外部输入）：坏一条丢一条并给原因，不整份清空，也不补默认值。
 */
export function normalizeCaptureRoute(value: unknown, expectedSceneId?: string): { route?: CaptureRoute; reason?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { reason: "The route must be an object." }
  const raw = value as Record<string, unknown>
  const routeId = typeof raw.routeId === "string" && raw.routeId.trim() ? raw.routeId.trim().slice(0, 80) : ""
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, MAX_ROUTE_NAME) : ""
  if (!routeId) return { reason: "The route is missing routeId." }
  if (!name) return { reason: "Enter a route name." }
  if (typeof raw.sceneId !== "string" || !raw.sceneId) return { reason: "The route is missing sceneId." }
  if (expectedSceneId !== undefined && raw.sceneId !== expectedSceneId) return { reason: `The route belongs to scene ${raw.sceneId}, not the current scene ${expectedSceneId}.` }
  const sceneRevision = typeof raw.sceneRevision === "number" && Number.isInteger(raw.sceneRevision) && raw.sceneRevision >= 0 ? raw.sceneRevision : 0
  if (!Array.isArray(raw.stops) || raw.stops.length < 2) return { reason: "Add at least 2 saved cameras to the route." }
  if (raw.stops.length > MAX_ROUTE_STOPS) return { reason: `A route supports at most ${MAX_ROUTE_STOPS} cameras (received ${raw.stops.length}).` }
  const stops: CaptureRouteStop[] = []
  for (const [index, item] of raw.stops.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { reason: `Stop ${index + 1} must be an object.` }
    const row = item as Record<string, unknown>
    const cameraName = typeof row.cameraName === "string" ? row.cameraName.trim().slice(0, 60) : ""
    if (!cameraName) return { reason: `Choose a saved camera for stop ${index + 1}.` }
    const holdMs = ms(row.holdMs ?? 0, MAX_ROUTE_HOLD_MS)
    if (holdMs === undefined) return { reason: `Stop ${index + 1} hold must be a finite value from 0 to ${MAX_ROUTE_HOLD_MS / 1000} seconds.` }
    stops.push({ cameraName, holdMs })
  }
  const rawSegments = Array.isArray(raw.segmentMs) ? raw.segmentMs : []
  if (rawSegments.length !== stops.length - 1) return { reason: `The route needs ${stops.length - 1} segment durations, but received ${rawSegments.length}.` }
  const segmentMs: number[] = []
  for (const [index, item] of rawSegments.entries()) {
    const duration = ms(item, MAX_ROUTE_SEGMENT_MS)
    if (duration === undefined || duration <= 0) return { reason: `Segment ${index + 1} duration must be a finite value greater than 0 and at most ${MAX_ROUTE_SEGMENT_MS / 1000} seconds.` }
    segmentMs.push(duration)
  }
  const savedAt = typeof raw.savedAt === "string" && raw.savedAt ? raw.savedAt : new Date(0).toISOString()
  return { route: { routeId, name, sceneId: raw.sceneId, sceneRevision, stops, segmentMs, savedAt } }
}

/** 组件值里的路线表（`viewerCamera.routes`）：坏一条丢一条，给原因。 */
export function parseCaptureRoutes(component: unknown, expectedSceneId?: string): { routes: CaptureRoute[]; warnings: string[] } {
  const warnings: string[] = []
  if (!component || typeof component !== "object" || Array.isArray(component)) return { routes: [], warnings }
  const rows = (component as { routes?: unknown }).routes
  if (rows === undefined) return { routes: [], warnings }
  if (!Array.isArray(rows)) return { routes: [], warnings: ["viewerCamera.routes must be an array; the invalid list was ignored."] }
  const routes: CaptureRoute[] = []
  for (const item of rows) {
    const parsed = normalizeCaptureRoute(item, expectedSceneId)
    if (parsed.route) { if (!routes.some(route => route.routeId === parsed.route!.routeId)) routes.push(parsed.route) }
    else warnings.push(`Route ignored: ${parsed.reason ?? "Invalid route."}`)
  }
  return { routes, warnings }
}

/** 从场景实体表读路线（与 `namedCamerasOfScene` 同一个承载实体的组件）。 */
export function captureRoutesOfScene(entities: readonly { entityId: string; components?: unknown }[] | undefined, expectedSceneId?: string): { routes: CaptureRoute[]; carrier?: string; warnings: string[] } {
  const warnings: string[] = []
  for (const entity of entities ?? []) {
    const components = entity.components as Record<string, unknown> | undefined
    if (!components || !("viewerCamera" in components)) continue
    const parsed = parseCaptureRoutes(components.viewerCamera, expectedSceneId)
    return { routes: parsed.routes, carrier: entity.entityId, warnings: [...warnings, ...parsed.warnings] }
  }
  return { routes: [], warnings }
}

/** 保存/覆盖一条（同名覆盖，新的在前）。 */
export function withCaptureRoute(routes: readonly CaptureRoute[], route: CaptureRoute): CaptureRoute[] {
  return [route, ...routes.filter(row => row.routeId !== route.routeId)].slice(0, 20)
}
export function withoutCaptureRoute(routes: readonly CaptureRoute[], routeId: string): CaptureRoute[] {
  return routes.filter(row => row.routeId !== routeId)
}

/**
 * 保存前把路线草稿钉到当刻的**源快照**：`sceneId` 必须是当前场景，`sceneRevision` 是保存时读到的
 * 真实场景版本（不是硬编码 0），`savedAt` 是保存时间。随后走与读入**同一份** `normalizeCaptureRoute`
 * 校验——空名、少于两站、非法段时长/停留都返回 `reason`；调用方不得提交，也不得显示"已保存"。
 * 草稿来自别的 Scene 时（跨 Scene 旧草稿）直接拒绝，不悄悄写进当前 Scene。
 */
export function prepareCaptureRouteForSave(draft: CaptureRoute, sceneId: string | undefined, sceneRevision: number | undefined, savedAt: string): { route?: CaptureRoute; reason?: string } {
  if (!sceneId) return { reason: "There is no writable scene." }
  if (draft.sceneId !== sceneId) return { reason: `The route draft belongs to scene ${draft.sceneId || "(empty)"}, not the current scene ${sceneId}.` }
  return normalizeCaptureRoute({ ...draft, sceneId, sceneRevision: sceneRevision ?? draft.sceneRevision, savedAt }, sceneId)
}

// ── 有序编辑（UI 与模型共用，不各写一套） ───────────────────────────────────
/** 追加一站；新站与前一站之间的段时长显式给出（首站忽略）。 */
export function addRouteStop(route: CaptureRoute, stop: CaptureRouteStop, segmentMs: number): CaptureRoute {
  if (route.stops.length >= MAX_ROUTE_STOPS) throw new Error(`ROUTE_MAX_STOPS: A route supports at most ${MAX_ROUTE_STOPS} cameras.`)
  const cameraName = stop.cameraName.trim().slice(0, 60)
  if (!cameraName) throw new Error("ROUTE_STOP_CAMERA_REQUIRED: Choose a saved world camera.")
  const holdMs = ms(stop.holdMs ?? 0, MAX_ROUTE_HOLD_MS)
  if (holdMs === undefined) throw new Error(`ROUTE_HOLD_INVALID: Hold must be from 0 to ${MAX_ROUTE_HOLD_MS / 1000} seconds.`)
  const stops = [...route.stops, { cameraName, holdMs }]
  if (route.stops.length === 0) return { ...route, stops, segmentMs: route.segmentMs.map(value => value) }
  const duration = ms(segmentMs, MAX_ROUTE_SEGMENT_MS)
  return { ...route, stops, segmentMs: [...route.segmentMs, duration && duration > 0 ? duration : 2000] }
}
export function moveRouteStop(route: CaptureRoute, index: number, delta: number): CaptureRoute {
  const next = Math.max(0, Math.min(route.stops.length - 1, index + delta))
  if (next === index) return route
  const stops = route.stops.map(row => ({ ...row }))
  const [moved] = stops.splice(index, 1)
  stops.splice(next, 0, moved!)
  // 段时长跟随机位重排：顺序变化后每段的目标与时长一并移动（不静默复用错段的时长）。
  const segmentMs = route.segmentMs.map(value => value)
  if (delta === -1 && index > 0) { const [movedSegment] = segmentMs.splice(index - 1, 1); segmentMs.splice(next, 0, movedSegment!) }
  else if (delta === 1 && index < segmentMs.length) { const [movedSegment] = segmentMs.splice(index, 1); segmentMs.splice(next - 1, 0, movedSegment!) }
  return { ...route, stops, segmentMs }
}
export function removeRouteStop(route: CaptureRoute, index: number): CaptureRoute {
  if (route.stops.length <= 2) throw new Error("ROUTE_MIN_STOPS: Keep at least 2 cameras; delete the whole route to clear it.")
  const stops = route.stops.filter((_, row) => row !== index)
  // 删除第 i 站：段时长合并——删首站用原第 1 段，删末站用原倒数第 1 段，中间站把两段相加（保持端到端时间语义）。
  const segmentMs = route.segmentMs.map(value => value)
  if (index === 0) segmentMs.splice(0, 1)
  else if (index >= stops.length) segmentMs.splice(segmentMs.length - 1, 1)
  else { const merged = segmentMs[index - 1]! + segmentMs[index]!; segmentMs.splice(index - 1, 2, Math.min(merged, MAX_ROUTE_SEGMENT_MS)) }
  return { ...route, stops, segmentMs }
}
export function setRouteStopHold(route: CaptureRoute, index: number, holdMs: number): CaptureRoute {
  const value = ms(holdMs, MAX_ROUTE_HOLD_MS)
  if (value === undefined) throw new Error(`ROUTE_HOLD_INVALID: Hold must be a finite value from 0 to ${MAX_ROUTE_HOLD_MS / 1000} seconds.`)
  return { ...route, stops: route.stops.map((row, at) => at === index ? { ...row, holdMs: value } : row) }
}
export function setRouteSegment(route: CaptureRoute, index: number, durationMs: number): CaptureRoute {
  const value = ms(durationMs, MAX_ROUTE_SEGMENT_MS)
  if (value === undefined || value <= 0) throw new Error(`ROUTE_SEGMENT_INVALID: Segment duration must be a finite value greater than 0 and at most ${MAX_ROUTE_SEGMENT_MS / 1000} seconds.`)
  return { ...route, segmentMs: route.segmentMs.map((row, at) => at === index ? value : row) }
}

// ── 解析 + 时间轴 ─────────────────────────────────────────────────────────
export interface RouteResolvedStop { cameraName: string; holdMs: number; state: ViewerViewState }
export interface RoutePlan {
  routeId: string
  name: string
  sceneId: string
  stops: RouteResolvedStop[]
  segmentMs: number[]
  totalMs: number
  /** 每段的镜头插值口径，供记录/回执复算。 */
  lens: Array<{ from: string; to: string; mode: "plain" | "intrinsics"; fovDeg?: [number, number]; width?: number; height?: number }>
}

type LensVerdict = { ok: true; mode: "plain" | "intrinsics"; fovDeg?: [number, number]; width?: number; height?: number } | { ok: false; reason: string }

/** 两站镜头能不能安全插值；不能就给**具体原因**，不静默改类型。 */
export function lensInterpolation(from: ViewerViewState, to: ViewerViewState, label: string): LensVerdict {
  const left = from.intrinsics, right = to.intrinsics
  if (left && right) {
    if (left.width !== right.width || left.height !== right.height) return { ok: false, reason: `${label}: photo intrinsics use different frame sizes (${left.width}×${left.height} vs ${right.width}×${right.height}); use matching camera sizes or remove this segment.` }
    return { ok: true, mode: "intrinsics", width: left.width, height: left.height }
  }
  if (left || right) return { ok: false, reason: `${label}: one stop uses a plain lens and the other uses photo intrinsics (fx/fy/cx/cy); use the same lens type at both stops.` }
  if (typeof from.fovDeg !== "number" || typeof to.fovDeg !== "number") return { ok: false, reason: `${label}: both stops need an interpolable fovDeg.` }
  return { ok: true, mode: "plain", fovDeg: [from.fovDeg, to.fovDeg] }
}

/** 路线 + 已存世界机位 → 可执行计划；机位缺失或镜头不可插值时 `ok:false` 并给具体原因。 */
export function planCaptureRoute(route: CaptureRoute, cameras: readonly NamedCamera[]): { ok: true; plan: RoutePlan } | { ok: false; reason: string } {
  const byName = new Map(cameras.map(camera => [camera.name, camera]))
  const stops: RouteResolvedStop[] = []
  for (const [index, stop] of route.stops.entries()) {
    const camera = byName.get(stop.cameraName)
    if (!camera) return { ok: false, reason: `Stop ${index + 1} references saved camera “${stop.cameraName}”, which no longer exists. Choose another camera or remove this stop.` }
    stops.push({ cameraName: stop.cameraName, holdMs: stop.holdMs, state: camera.state as ViewerViewState })
  }
  const lens: RoutePlan["lens"] = []
  for (let index = 0; index < stops.length - 1; index++) {
    const verdict = lensInterpolation(stops[index]!.state, stops[index + 1]!.state, `Segment ${index + 1}→${index + 2}`)
    if (!verdict.ok) return { ok: false, reason: verdict.reason }
    lens.push({ from: stops[index]!.cameraName, to: stops[index + 1]!.cameraName, mode: verdict.mode, ...verdict.mode === "plain" ? { fovDeg: verdict.fovDeg } : { width: verdict.width, height: verdict.height } })
  }
  const totalMs = route.segmentMs.reduce((sum, value) => sum + value, 0) + stops.reduce((sum, stop) => sum + stop.holdMs, 0)
  return { ok: true, plan: { routeId: route.routeId, name: route.name, sceneId: route.sceneId, stops, segmentMs: route.segmentMs.map(value => value), totalMs, lens } }
}

// ── 插值数学（米 / xyzw 归一化四元数 / 度） ────────────────────────────────
export const lerp = (a: number, b: number, u: number): number => a + (b - a) * u
export const lerp3 = (a: readonly number[], b: readonly number[], u: number): [number, number, number] => [lerp(a[0]!, b[0]!, u), lerp(a[1]!, b[1]!, u), lerp(a[2]!, b[2]!, u)]
export function normalizeQuat(q: readonly number[]): [number, number, number, number] {
  const length = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!)
  return length > 0 ? [q[0]! / length, q[1]! / length, q[2]! / length, q[3]! / length] : [0, 0, 0, 1]
}
/** 四元数 slerp（xyzw）；共线时退回归一化 lerp。 */
export function slerp(a: readonly number[], b: readonly number[], u: number): [number, number, number, number] {
  let [ax, ay, az, aw] = normalizeQuat(a)
  let [bx, by, bz, bw] = normalizeQuat(b)
  let dot = ax * bx + ay * by + az * bz + aw * bw
  if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot }
  if (dot > 0.9995) return normalizeQuat([lerp(ax, bx, u), lerp(ay, by, u), lerp(az, bz, u), lerp(aw, bw, u)])
  const theta0 = Math.acos(Math.min(1, dot)), theta = theta0 * u
  const sin0 = Math.sin(theta0), sinT = Math.sin(theta)
  const s0 = Math.cos(theta) - dot * sinT / sin0, s1 = sinT / sin0
  return normalizeQuat([ax * s0 + bx * s1, ay * s0 + by * s1, az * s0 + bz * s1, aw * s0 + bw * s1])
}
/** 单位四元数旋转向量（xyzw）。 */
export function rotateVec(q: readonly number[], v: readonly number[]): [number, number, number] {
  const [x, y, z, w] = q
  const tx = 2 * (y! * v[2]! - z! * v[1]!), ty = 2 * (z! * v[0]! - x! * v[2]!), tz = 2 * (x! * v[1]! - y! * v[0]!)
  return [v[0]! + w! * tx + (y! * tz - z! * ty), v[1]! + w! * ty + (z! * tx - x! * tz), v[2]! + w! * tz + (x! * ty - y! * tx)]
}
const distance3 = (a: readonly number[], b: readonly number[]): number => Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!)
const lerpIntrinsics = (a: ViewerCameraIntrinsics, b: ViewerCameraIntrinsics, u: number): ViewerCameraIntrinsics => ({ fx: lerp(a.fx, b.fx, u), fy: lerp(a.fy, b.fy, u), cx: lerp(a.cx, b.cx, u), cy: lerp(a.cy, b.cy, u), width: a.width, height: a.height })

function stateOnSegment(from: ViewerViewState, to: ViewerViewState, u: number): ViewerViewState {
  const position = lerp3(from.position, to.position, u)
  const quaternion = slerp(from.quaternion, to.quaternion, u)
  const distance = lerp(distance3(from.position, from.target), distance3(to.position, to.target), u)
  // target 由插值后的位置 + 朝向推出，保证它**永远在视线上**（否则 setViewState 的当场核对会拒）。
  const forward = rotateVec(quaternion, [0, 0, -1])
  const target: [number, number, number] = [position[0] + forward[0] * distance, position[1] + forward[1] * distance, position[2] + forward[2] * distance]
  const up = rotateVec(quaternion, [0, 1, 0])
  const fovDeg = typeof from.fovDeg === "number" && typeof to.fovDeg === "number" ? lerp(from.fovDeg, to.fovDeg, u) : from.fovDeg ?? to.fovDeg
  const near = typeof from.near === "number" && typeof to.near === "number" ? lerp(from.near, to.near, u) : from.near ?? to.near
  const far = typeof from.far === "number" && typeof to.far === "number" ? lerp(from.far, to.far, u) : from.far ?? to.far
  const intrinsics = from.intrinsics && to.intrinsics ? lerpIntrinsics(from.intrinsics, to.intrinsics, u) : undefined
  return { position, quaternion, target, up, ...fovDeg === undefined ? {} : { fovDeg }, ...near === undefined ? {} : { near }, ...far === undefined ? {} : { far }, ...intrinsics ? { intrinsics } : {} }
}

export interface RouteSample { tMs: number; phase: "hold" | "move"; stopIndex: number; state: ViewerViewState }

/** 时间 t（毫秒）处的镜头状态；`t<=0` 取首站，`t>=total` 取末站。 */
export function sampleRoutePlan(plan: RoutePlan, tMs: number): RouteSample {
  const clamped = Math.max(0, tMs)
  let cursor = 0
  for (let index = 0; index < plan.stops.length; index++) {
    const stop = plan.stops[index]!
    if (clamped < cursor + stop.holdMs) return { tMs: clamped, phase: "hold", stopIndex: index, state: { ...stop.state } }
    cursor += stop.holdMs
    if (index < plan.stops.length - 1) {
      const duration = plan.segmentMs[index]!
      if (clamped < cursor + duration) return { tMs: clamped, phase: "move", stopIndex: index, state: stateOnSegment(stop.state, plan.stops[index + 1]!.state, duration > 0 ? (clamped - cursor) / duration : 1) }
      cursor += duration
    }
  }
  return { tMs: clamped, phase: "hold", stopIndex: plan.stops.length - 1, state: { ...plan.stops[plan.stops.length - 1]!.state } }
}

/** 路线时间轴的可复算参数文本（回执/记录用）。 */
export function routePlanSummary(plan: RoutePlan): { totalMs: number; stops: Array<{ cameraName: string; holdMs: number }>; segmentMs: number[]; lens: RoutePlan["lens"] } {
  return { totalMs: plan.totalMs, stops: plan.stops.map(stop => ({ cameraName: stop.cameraName, holdMs: stop.holdMs })), segmentMs: plan.segmentMs.map(value => value), lens: plan.lens }
}
