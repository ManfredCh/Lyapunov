/**
 * Capture 路线站点的**显示几何**（纯函数，无 three 依赖）。
 *
 * 路线站点只引用 Scene 里持久命名机位的 `ViewerViewState`。本模块把那份真实位姿/镜头投影成
 * 「相机位置 + 四棱锥/像平面 + 朝向 + up」所需的局部线框，供 `SceneViewer.setCaptureRouteTrail`
 * 一次性建 3D helper。它不保存相机、不插值、不驱动录制，也不猜缺数据：
 *  · 缺位置/旋转/镜头 ⇒ `available:false`，调用方不得画一个 `[0,0,0]`/identity 的假相机；
 *  · 选中位按**原始站点索引**标记（缺失站点不从数组里平铺掉），避免高亮串位；
 *  · 路径只在**连续可用站点**之间连线，缺站不跨过去补一条假的直线。
 */
import {
  cameraForward,
  cameraRight,
  cameraUpAxis,
  normalizeIntrinsics,
  normalizeQuaternion,
  type ViewerCameraIntrinsics,
  type ViewerQuat,
  type ViewerVec3,
} from "./camera-view.ts"
import {DISPLAY_DEFAULT_FAR_M, DISPLAY_DEFAULT_NEAR_M, frustumGeometry, intrinsicsFromFovy} from "./camera-frustum.ts"

/** 路线显示输入：字段来自持久命名机位 `state`（壳层原样投影，不另存一份）。 */
export interface CaptureRouteStationInput {
  /** 稳定键（保存的机位名，或调用方给的 `stop:<index>`）；只用于对象命名/排查。 */
  key?: string
  position?: readonly number[]
  quaternion?: readonly number[]
  fovDeg?: number
  intrinsics?: unknown
  near?: number
  far?: number
  /**
   * 当前 Capture 输出的真实画幅（像素）。仅 fov-only 站点需要：用它把站点的**实际 fovDeg**
   * 投影成该画幅的视锥；已有完整 K 的站点仍以 K 为准。缺画幅/坏画幅时不拿 640×480 冒充。
   */
  frameWidth?: number
  frameHeight?: number
  /** 调用方已判定的可用性；显式 false 时即使带齐位姿也不画（如引擎明确拒绝）。 */
  available?: boolean
  unavailableReason?: string
}

export interface CaptureRouteStationGeometry {
  index: number
  key: string
  available: boolean
  selected: boolean
  position?: ViewerVec3
  quaternion?: ViewerQuat
  /** 世界系真实前向（相机 −Z）。 */
  forward?: ViewerVec3
  /** 世界系真实上向（相机 +Y，含 roll）。 */
  up?: ViewerVec3
  right?: ViewerVec3
  intrinsics?: ViewerCameraIntrinsics
  intrinsicsSource: "declared" | "fov-derived" | "none"
  /** 相机局部系的四棱锥线框（near 矩形＋像平面矩形＋顶点→像平面四角＋roll 顶角）。 */
  frustum?: {
    lineVertices: number[]
    imagePlaneM: number
    imageWidth: number
    imageHeight: number
    nearCenter: ViewerVec3
    imageCenter: ViewerVec3
  }
  unavailableReason?: string
}

const IMAGE_PLANE_M = 0.55
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const vec3 = (value: unknown): ViewerVec3 | undefined =>
  Array.isArray(value) && value.length === 3 && value.every(finite) ? [value[0], value[1], value[2]] : undefined
const quat = (value: unknown): ViewerQuat | undefined => {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(finite)) return undefined
  try { return normalizeQuaternion(value) } catch { return undefined }
}
const intrinsicsOf = (value: unknown): ViewerCameraIntrinsics | undefined => {
  if (value === undefined || value === null) return undefined
  try { return normalizeIntrinsics(value) } catch { return undefined }
}
const defaultNear = (value: unknown): number => finite(value) && value > 0 ? value : DISPLAY_DEFAULT_NEAR_M
const defaultFar = (value: unknown, near: number): number => finite(value) && value > near ? value : Math.max(near + 0.05, DISPLAY_DEFAULT_FAR_M)
const frameSize = (width: unknown, height: unknown): { width: number; height: number } | undefined =>
  typeof width === "number" && Number.isInteger(width) && width > 0 && typeof height === "number" && Number.isInteger(height) && height > 0
    ? { width, height }
    : undefined

/**
 * 单个站点 → 显示几何。`selected` 是**原始站点索引**，不是"第几个能画的站点"。
 * 缺位姿/镜头时只返回 `available:false` 与原因，绝不补默认位姿或默认镜头。
 */
export function captureRouteStationGeometry(station: CaptureRouteStationInput, index: number, selected = -1): CaptureRouteStationGeometry {
  const key = station.key?.trim() || `stop:${index}`
  const selectedHere = index === selected
  if (station.available === false) return {index, key, available: false, selected: selectedHere, intrinsicsSource: "none", unavailableReason: station.unavailableReason ?? "站点机位不可用"}
  const position = vec3(station.position), quaternion = quat(station.quaternion)
  if (!position) return {index, key, available: false, selected: selectedHere, intrinsicsSource: "none", unavailableReason: station.unavailableReason ?? "站点缺少真实位置"}
  if (!quaternion) return {index, key, available: false, selected: selectedHere, intrinsicsSource: "none", unavailableReason: station.unavailableReason ?? "站点缺少真实旋转"}
  const declared = intrinsicsOf(station.intrinsics)
  const fovUsable = finite(station.fovDeg) && station.fovDeg > 0.001 && station.fovDeg < 179.999
  const frame = frameSize(station.frameWidth, station.frameHeight)
  const derived = declared === undefined && fovUsable && frame
    ? (() => { try { return intrinsicsFromFovy(station.fovDeg, frame.width, frame.height) } catch { return undefined } })()
    : undefined
  const intrinsics = declared ?? derived
  if (!intrinsics) {
    const reason = declared === undefined && fovUsable && !frame
      ? "站点缺少实际 Capture 画幅（不能以固定 4:3 代替 fov-only 镜头）"
      : "站点缺少可显示的镜头（内参或 fovDeg）"
    return {index, key, available: false, selected: selectedHere, intrinsicsSource: "none", unavailableReason: station.unavailableReason ?? reason}
  }
  const nearM = defaultNear(station.near), farM = defaultFar(station.far, nearM)
  let frustum: frustumGeometryResult
  try { frustum = frustumGeometry(intrinsics, {nearM, farM, imagePlaneM: Math.min(IMAGE_PLANE_M, farM)}) }
  catch { return {index, key, available: false, selected: selectedHere, intrinsicsSource: "none", unavailableReason: "站点镜头参数不能构成视锥"} }
  const xs = frustum.imageCorners.map(corner => corner[0])
  const ys = frustum.imageCorners.map(corner => corner[1])
  return {
    index, key, available: true, selected: selectedHere,
    position, quaternion,
    forward: cameraForward(quaternion), up: cameraUpAxis(quaternion), right: cameraRight(quaternion),
    intrinsics, intrinsicsSource: declared ? "declared" : "fov-derived",
    frustum: {
      lineVertices: frustum.lineVertices,
      imagePlaneM: Math.min(IMAGE_PLANE_M, farM),
      imageWidth: Math.max(...xs) - Math.min(...xs),
      imageHeight: Math.max(...ys) - Math.min(...ys),
      nearCenter: [0, 0, -nearM],
      imageCenter: [0, 0, -Math.min(IMAGE_PLANE_M, farM)],
    },
  }
}

type frustumGeometryResult = ReturnType<typeof frustumGeometry>

/** 整条草稿 → 每个原始站点的显示几何（索引与草稿 stops 一一对应）。 */
export function captureRouteStationsGeometry(stations: readonly CaptureRouteStationInput[], selected = -1): CaptureRouteStationGeometry[] {
  return stations.map((station, index) => captureRouteStationGeometry(station, index, selected))
}

/**
 * 运镜路径：只在**连续可用**的站点之间连线。缺站把路径断开，而不是用一条直线跨过它。
 * 返回若干个点串（每个至少 2 点）。
 */
export function captureRoutePathSegments(stations: readonly CaptureRouteStationGeometry[]): ViewerVec3[][] {
  const segments: ViewerVec3[][] = []
  let current: ViewerVec3[] = []
  for (const station of stations) {
    if (!station.available || !station.position) {
      if (current.length >= 2) segments.push(current)
      current = []
      continue
    }
    current.push(station.position)
  }
  if (current.length >= 2) segments.push(current)
  return segments
}
