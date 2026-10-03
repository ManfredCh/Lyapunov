/**
 * 照片相机 → 原生 Viewer 的**相机视角**：纯数学 + 校验，不 import three、不碰 DOM、不持状态。
 *
 * 为什么单独一份：这条路径有三处消费者，而它们必须是同一份判据——
 *   · Viewer（`index.ts`）把视角真正写进 three 相机；
 *   · 宿主（shell）收到前端回执后核对"报告的内参/投影/图片尺寸是不是同一件事"；
 *   · 测试用**真实 three 相机**投影点来核对（不是序列化往返）。
 *
 * 口径与 `docs/PHOTO_CAMERA_FIT.md`（camera_fit）逐字一致，不另立一套：
 *   · 世界：右手、Z-up、米制；相机：x 右、y 上、看向 −z；`world = R·p_cam + t`，
 *     `worldFromCamera.rotationMatrix` 的**列**是相机三轴在世界系里的方向；
 *   · 像素：原点左上、u 向右、v 向下；主点缺省取像素中心 `((width−1)/2, (height−1)/2)`；
 *   · 投影 `u = cx + fx·(x_cam/−z_cam)`、`v = cy − fy·(y_cam/−z_cam)`。
 *
 * three 的 `PerspectiveCamera` 只有"垂直视场角 + 画面宽高比"，既没有主点偏移也没有 fx≠fy。
 * 这里用它的**视口偏移**（`setViewOffset`）把一般 K 装进同一台相机：子视口宽高取真实画布尺寸时
 * 是 1:1 裁切，于是 `fullWidth = width·fx/fy` 承载像素长宽比、子视口左上角位置承载主点偏移。
 * 该实现与 `projectionMatrixFromIntrinsics` 的解析矩阵逐元素一致（测试用真实 three 投影核对，
 * 多个 K 形状上最大像素误差 ~1e-13）。
 */

export type ViewerVec3 = [number, number, number]
export type ViewerQuat = [number, number, number, number]

/** 针孔内参（像素）。与 camera_fit 的 `intrinsics` 同形：cx/cy 省略取像素中心。 */
export interface ViewerCameraIntrinsics {
  fx: number
  fy: number
  cx: number
  cy: number
  width: number
  height: number
  /** OpenCV 口径畸变系数（可省）；原生 Viewer 复现不了它，只如实报告"没复现"。 */
  distortion?: number[]
}

/**
 * `camera_fit` 的 `camera.worldFromCamera`：列 = 相机轴，四元数与本文件同为 xyzw。
 *
 * 位置字段名**就是尺度声明**（`docs/PHOTO_CAMERA_FIT.md` / 55 的接口说明）：`worldUnit` 未定时读数里
 * 只有 `positionInputUnits`（输入单位，**不是米**），带 M 的字段一律不出现。这里照它的口径分开收，
 * 免得把"输入单位"的数当米直接摆进米制世界。
 */
export interface ViewerWorldFromCamera {
  positionM?: unknown
  positionInputUnits?: unknown
  position?: unknown
  rotationMatrix?: unknown
  quaternionXyzw?: unknown
  quaternion?: unknown
}

/**
 * `camera_fit`（`packages/blender/src/camera-fit.ts` 的 `CameraFitViewerCamera`）的 `camera` 块，
 * **可原样喂进来**；也接受把 `camera.viewer` 摊平后的形状。
 *
 * 字段口径按它的实现对齐（不是按推测）：
 *  · `viewer.up` 是**相机自身 up 轴**（由 R 得出、含 roll）→ 落到 `cameraUp`；
 *  · `viewer.sceneUp` 才是世界 up（它固定给 [0,0,1]）→ 落到世界 up 提示；
 *  · `viewer.target`/`focusDistance` 是它算好的 OrbitControls 转心 → 落到 `target`；
 *  · `viewer.intrinsics` 是完整 K（fx/fy/cx/cy/width/height）→ 没有单独的 `intrinsics` 时就用它。
 * 旧形状（把 position/quaternion/up/fov_y_deg 直接摊平在块上）也认。
 *
 * 工具契约的 `camera` 块（`{position,quaternion,target,up,cameraUp,fovYDeg,near,far,worldFromCamera,intrinsics}`）
 * 也把字段摊平在块上，与顶层同名同义：读的时候两处都算，两处都写且对不上就拒（见 `declaredCameraField`）。
 * 块里**只**给 `up`（没给 `cameraUp`）时仍按上面的旧形状读成相机 up 轴——既有口径，不改。
 */
export interface ViewerCameraFitBlock {
  worldFromCamera?: ViewerWorldFromCamera
  intrinsics?: unknown
  /** `camera_fit` 的 `camera.metric`：位置字段名的尺度声明（与 `viewer.units.metric` 必须一致）。 */
  metric?: unknown
  /** 尺度未定时**由调用方**给出的换算（米/输入单位）：给了它才允许把输入单位的位置摆进米制世界。 */
  metersPerInputUnit?: unknown
  viewer?: {
    position?: unknown
    positionInputUnits?: unknown
    quaternion?: unknown
    up?: unknown
    sceneUp?: unknown
    target?: unknown
    focusDistance?: unknown
    fov_y_deg?: unknown
    fov_x_deg?: unknown
    aspect?: unknown
    intrinsics?: unknown
    units?: { metric?: unknown; metersPerInputUnit?: unknown }
    principalPointOffsetPx?: { x?: unknown; y?: unknown }
    principalPointCentred?: unknown
  }
  position?: unknown
  quaternion?: unknown
  /** 摊平在块上的 `up`：与 `cameraUp` 同时出现时后者才是相机 up 轴，单给 `up` 沿用 camera_fit 旧形状口径（相机 up 轴）。 */
  up?: unknown
  cameraUp?: unknown
  target?: unknown
  fov_y_deg?: unknown
  /** 工具契约在块里的拼写（与 `fov_y_deg` 同义；两处都给且对不上会拒）。 */
  fovYDeg?: unknown
  near?: unknown
  far?: unknown
}

/**
 * 一次"应用相机"的请求。位姿（position + 朝向）与投影（intrinsics 或 fovYDeg）各自独立，
 * **互不覆盖**：同时给且互相矛盾时明确拒绝，而不是静默挑一个。
 */
export interface ViewerCameraRequest {
  position?: unknown
  /** 尺度未定时**按输入单位**给的位置（米制位置用 `position`）。要应用它必须同时给 `metersPerInputUnit`。 */
  positionInputUnits?: unknown
  /** **调用方显式**给出的换算（米/输入单位）。`camera_fit` 的 `scale.metresPerInputUnit` 在尺度未定时是
   * `null`，所以它不算"显式换算"——没有这个字段就把输入单位的位置当米用，是这条路径最危险的静默错误。 */
  metersPerInputUnit?: unknown
  /** 尺度声明（`camera_fit` 的 `camera.metric`）：`false` = 位置字段不是米。给了米制位置却又声明 false 会拒。 */
  metric?: unknown
  /** 朝向：四元数（xyzw、世界系，相机系→世界系）。与 target 同时给会核对视线方向，不符即拒。 */
  quaternion?: unknown
  /** 朝向：3×3（行）或行主序 9 个数，**列** = 相机 x/y/z 轴在世界系的方向。 */
  rotationMatrix?: unknown
  /** 看向的点（世界系）。只给 target 时按 `up` 定朝向（roll = 0）。它是 OrbitControls 的转心。 */
  target?: unknown
  /** **世界 up 提示**（默认 [0,0,1]）：只用于 target 定朝向与 roll 的读数，不是相机 up 轴。 */
  up?: unknown
  /** **相机自身 up 轴**（写进 `camera.up`）：只在恢复已有相机状态时给；省略按朝向推导。 */
  cameraUp?: unknown
  worldFromCamera?: ViewerWorldFromCamera
  camera?: ViewerCameraFitBlock
  /** 照片内参：给了它投影就按它复现（含主点偏移与 fx≠fy）。 */
  intrinsics?: unknown
  /** 垂直视场角（度）。与 intrinsics 同时给会核对，不一致即拒。 */
  fovYDeg?: unknown
  fov_y_deg?: unknown
  near?: unknown
  far?: unknown
  /** 只有四元数、没有 target 时，转心放在视线正前方多远（米）；缺省沿用当前距离。 */
  targetDistanceM?: unknown
}

/** 归一化时用到的"此刻是什么样"（由 Viewer 传入；缺省按相机出厂值）。 */
export interface ViewerCameraCurrent {
  position?: ViewerVec3
  /** 当前**姿态**（含 roll）：请求只改投影/裁剪面时沿用它——缺了它就只能退回"用 target 定朝向"，roll 会归零。 */
  quaternion?: ViewerQuat
  /** 当前写进 `camera.up` 的值（相机自身 up 轴）：沿用姿态时一起沿用。 */
  cameraUp?: ViewerVec3
  target?: ViewerVec3
  fovYDeg?: number
  near?: number
  far?: number
  targetDistanceM?: number
  /** 当前**有效**内参（按当前画布尺寸量出来的）。请求没给投影时沿用它——"只换机位"不该把镜头换掉。 */
  intrinsics?: ViewerCameraIntrinsics
}

/** 归一化后的视角：写进相机的是它，回执与核对读的也是它。 */
export interface ViewerCameraView {
  position: ViewerVec3
  quaternion: ViewerQuat
  /** 要写进 `camera.up` 的值：**相机自身 y 轴**在世界系的方向（有 roll 时 ≠ 世界 up）。 */
  cameraUp: ViewerVec3
  /** `controls.target`：视线正前方 `targetDistanceM` 米（保证 OrbitControls 复现同一姿态）。 */
  target: ViewerVec3
  targetDistanceM: number
  fovYDeg: number
  near: number
  far: number
  /** 世界 up 提示（默认 [0,0,1]）：只影响 target 定朝向的参考与 roll 的读数。 */
  up: ViewerVec3
  intrinsics?: ViewerCameraIntrinsics
  /** `"current"` = 请求没给朝向、沿用当前相机姿态（部分更新，例如只改 fov/near）。 */
  orientationSource: "quaternion" | "rotationMatrix" | "target" | "worldFromCamera" | "current"
  projectionSource: "intrinsics" | "fov" | "keep"
  /** 相机相对世界 up 的滚转（度）：0 = 相机 y 轴落在"世界 up 与视线"张成的平面内。 */
  rollDeg: number
  /** 如实说明"输入里有什么没有被复现"（例如畸变系数、没给 K 时的照片主点偏移）。 */
  notes: string[]
}

/** 结构化失败：`code` 是稳定机器码，`message` 是给人看的下一步。 */
export class ViewerCameraError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "ViewerCameraError"
  }
}

const DEG = Math.PI / 180
/** 姿态/方向互相核对时的容差（度）：超过它就不是"同一个方向"，而是两个矛盾的输入。 */
const ANGLE_TOLERANCE_DEG = 0.5
/** fov 与内参互相核对时的容差（度）。 */
const FOV_TOLERANCE_DEG = 0.05
/** 视口偏移与姿态复现的核对容差（度 / 米）。 */
const VERIFY_TOLERANCE_DEG = 1e-3
const EPSILON = 1e-9

/** 输入不成立（缺字段、越界、退化）：`never` 返回，调用处之后照常继续用已校验的值。 */
function invalid(message: string): never { throw new ViewerCameraError("VIEWER_CAMERA_INVALID", message) }
/** 输入互相矛盾（多个位姿来源不一致、fov 与内参不一致…）：明确拒绝，不静默挑一个。 */
function conflict(message: string): never { throw new ViewerCameraError("VIEWER_CAMERA_CONFLICT", message) }
/**
 * 位置只有"输入单位"、没有米制换算：**明确拒绝**，不落回当前相机装成应用成功。
 *
 * 为什么单独一个码：`camera_fit` 在 `worldUnit="unknown"` 时给的就是这种位置（只有 `positionInputUnits`）。
 * 把它当米摆进米制世界，画面看起来"应用成功了"，实际尺度是错的——而这条路径的全部意义正是同机位可比对。
 */
function scaleUnknown(message: string): never { throw new ViewerCameraError("VIEWER_CAMERA_SCALE_UNKNOWN", message) }

/** 两处写的是不是同一个值（数按相对 1e-9 比，免得 JSON 往返的末位噪声被当成矛盾；数组/对象逐项比）。 */
function sameDeclaredValue(left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number") return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right))
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => sameDeclaredValue(item, right[index]))
  if (left && right && typeof left === "object" && typeof right === "object") {
    const a = left as Record<string, unknown>, b = right as Record<string, unknown>
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) if (!sameDeclaredValue(a[key], b[key])) return false
    return true
  }
  return Object.is(left, right)
}

/**
 * 契约里"相机块"与"扁平字段"是同一组字段的两种摆法（工具 schema 把 `camera:{position,…,fovYDeg,near,far,…}` 与
 * 顶层同名字段并列声明）。读的时候三处都算——顶层、`camera` 块、camera_fit 的 `camera.viewer` 块——
 * 但**两处都写同一个量且对不上就明确拒**：静默挑一个正是"块里的 `fovYDeg` 被整块忽略、回执却按沿用值报"那类错的来源。
 * 别名只保留契约里写死的拼写（工具契约 `fovYDeg`、camera_fit `fov_y_deg`），不在这里往外扩。
 */
function declaredCameraField(holders: ReadonlyArray<readonly [string, Record<string, unknown> | undefined]>, names: readonly string[], label: string): { value: unknown; where: string } | undefined {
  const found: Array<{ where: string; name: string; value: unknown }> = []
  for (const [where, holder] of holders) {
    if (!holder) continue
    for (const name of names) {
      const value = holder[name]
      if (value !== undefined && value !== null) found.push({ where, name, value })
    }
  }
  const first = found[0]
  if (!first) return undefined
  for (const other of found.slice(1)) {
    if (sameDeclaredValue(first.value, other.value)) continue
    conflict(`${label} 有两处说法且对不上：${first.where}「${first.name}」=${JSON.stringify(first.value)} 与 ${other.where}「${other.name}」=${JSON.stringify(other.value)}。只留一处，或把它们改成同一个值。`)
  }
  return { value: first.value, where: `${first.where}.${first.name}` }
}

const finite = (value: unknown, label: string): number => {
  const number = typeof value === "number" ? value : Number.NaN
  if (!Number.isFinite(number)) invalid(`${label} 必须是有限数（收到 ${JSON.stringify(value ?? null)}）`)
  return number
}
const positive = (value: unknown, label: string): number => {
  const number = finite(value, label)
  if (!(number > 0)) invalid(`${label} 必须为正数（收到 ${String(number)}）`)
  return number
}
const vec3 = (value: unknown, label: string): ViewerVec3 => {
  if (!Array.isArray(value) || value.length !== 3) invalid(`${label} 必须是长度 3 的数组`)
  return value.map((item, index) => finite(item, `${label}[${index}]`)) as ViewerVec3
}
const optionalVec3 = (value: unknown, label: string): ViewerVec3 | undefined => value === undefined || value === null ? undefined : vec3(value, label)
const length3 = (v: ViewerVec3): number => Math.hypot(...v)
const normalize3 = (value: ViewerVec3, label = "方向"): ViewerVec3 => {
  const length = length3(value)
  if (length < EPSILON) invalid(`${label}不能是零向量`)
  return [value[0] / length, value[1] / length, value[2] / length] as ViewerVec3
}
const add = (a: ViewerVec3, b: ViewerVec3): ViewerVec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: ViewerVec3, b: ViewerVec3): ViewerVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const scale = (a: ViewerVec3, k: number): ViewerVec3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: ViewerVec3, b: ViewerVec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: ViewerVec3, b: ViewerVec3): ViewerVec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/** 四元数（xyzw）：归一化；零四元数直接拒。 */
export function normalizeQuaternion(value: unknown, label = "quaternion"): ViewerQuat {
  if (!Array.isArray(value) || value.length !== 4) invalid(`${label} 必须是 [x,y,z,w] 四个数`)
  const raw = (value as unknown[]).map((item, index) => finite(item, `${label}[${index}]`)) as ViewerQuat
  const norm = Math.hypot(...raw)
  if (!(norm > EPSILON)) invalid(`${label} 不能是零四元数`)
  return [raw[0] / norm, raw[1] / norm, raw[2] / norm, raw[3] / norm] as ViewerQuat
}
/** 四元数旋转一个向量。 */
export function rotateByQuaternion(q: ViewerQuat, v: ViewerVec3): ViewerVec3 {
  const u = [q[0], q[1], q[2]] as ViewerVec3
  const t = scale(cross(u, v), 2)
  return add(add(v, scale(t, q[3])), cross(u, t))
}
/** 相机三轴（相机 x/y/z）在世界系里的方向。 */
export const cameraRight = (q: ViewerQuat): ViewerVec3 => rotateByQuaternion(q, [1, 0, 0])
export const cameraUpAxis = (q: ViewerQuat): ViewerVec3 => rotateByQuaternion(q, [0, 1, 0])
/** 视线方向（相机 −z 在世界系中的方向）。 */
export const cameraForward = (q: ViewerQuat): ViewerVec3 => rotateByQuaternion(q, [0, 0, -1])

/**
 * `rotationMatrix`（列 = 相机轴）→ 3×3 行。
 *
 * 接受 camera_fit 的 3×3 行数组，也接受行主序的 9 个数。列 j 是相机轴 j，也就是
 * `world = M·p_cam + t` 里的 M。不是旋转（列非单位向量 / 含镜像）就拒——静默歪掉的姿态最难查。
 */
export function rotationMatrixFromInput(value: unknown, label = "rotationMatrix"): number[][] {
  let rows: number[][]
  if (Array.isArray(value) && value.length === 9 && value.every(item => typeof item === "number")) {
    const flat = value as number[]
    rows = [[flat[0]!, flat[1]!, flat[2]!], [flat[3]!, flat[4]!, flat[5]!], [flat[6]!, flat[7]!, flat[8]!]]
  } else if (Array.isArray(value) && value.length === 3 && value.every(row => Array.isArray(row) && row.length === 3)) {
    rows = (value as unknown[][]).map((row, index) => row.map((item, column) => finite(item, `${label}[${index}][${column}]`)))
  } else invalid(`${label} 必须是 3×3 的二维数组或行主序的 9 个数`)
  for (const axis of [0, 1, 2]) {
    const column = [rows[0]![axis]!, rows[1]![axis]!, rows[2]![axis]!] as ViewerVec3
    const norm = length3(column)
    if (!(Math.abs(norm - 1) <= 1e-4)) invalid(`${label} 的第 ${String(axis + 1)} 列不是单位向量（长度 ${norm.toFixed(6)}）——它应当是相机某条轴在世界系里的方向`)
  }
  const determinant = rows[0]![0]! * (rows[1]![1]! * rows[2]![2]! - rows[1]![2]! * rows[2]![1]!)
    - rows[0]![1]! * (rows[1]![0]! * rows[2]![2]! - rows[1]![2]! * rows[2]![0]!)
    + rows[0]![2]! * (rows[1]![0]! * rows[2]![1]! - rows[1]![1]! * rows[2]![0]!)
  if (determinant < 0) invalid(`${label} 的行列式为负（${determinant.toFixed(6)}）——含镜像，不是旋转`)
  return rows
}
export function quaternionFromRotationMatrix(value: unknown, label?: string): ViewerQuat {
  const m = rotationMatrixFromInput(value, label)
  const m00 = m[0]![0]!, m01 = m[0]![1]!, m02 = m[0]![2]!
  const m10 = m[1]![0]!, m11 = m[1]![1]!, m12 = m[1]![2]!
  const m20 = m[2]![0]!, m21 = m[2]![1]!, m22 = m[2]![2]!
  const trace = m00 + m11 + m22
  if (trace > 0) { const s = Math.sqrt(trace + 1) * 2; return normalizeQuaternion([(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]) }
  if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; return normalizeQuaternion([s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]) }
  if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; return normalizeQuaternion([(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]) }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2
  return normalizeQuaternion([(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s])
}
/** 四元数 → 3×3（行），列 = 相机 x/y/z 轴在世界系里的方向（camera_fit 口径）。 */
export function rotationMatrixColumnsFromQuaternion(q: ViewerQuat): number[][] {
  const x = cameraRight(q), y = cameraUpAxis(q), z = rotateByQuaternion(q, [0, 0, 1])
  return [[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]]
}
const dot4 = (a: ViewerQuat, b: ViewerQuat): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
/** 两个姿态之间的夹角（度）；符号无关（q 与 −q 是同一姿态）。 */
export function quaternionAngleDeg(a: ViewerQuat, b: ViewerQuat): number {
  const angle = 2 * Math.acos(Math.min(1, Math.abs(dot4(a, b)))) / DEG
  return Number.isNaN(angle) ? 0 : angle
}
/** 两个方向的夹角（度）。 */
export function directionAngleDeg(a: ViewerVec3, b: ViewerVec3): number {
  const cosine = dot(normalize3(a), normalize3(b))
  return Math.acos(Math.min(1, Math.max(-1, cosine))) / DEG
}

/**
 * 由"看向哪里"定朝向：与 three 的 `Object3D.lookAt`（相机）同一套基——z = normalize(position − target)，
 * x = normalize(up × z)，y = z × x。视线与世界 up 提示平行时滚转无从定义，这里**明确拒绝**，
 * 而不是像 three 那样偷偷扰动一下继续算（那会让"应用了照片相机"变成一句含糊的话）。
 */
export function quaternionLookingAt(position: ViewerVec3, target: ViewerVec3, up: ViewerVec3): ViewerQuat {
  const forward = sub(target, position)
  if (length3(forward) < EPSILON) invalid("target 与 position 重合，视线方向无从确定")
  const z = normalize3(scale(forward, -1))
  const upUnit = normalize3(up, "up ")
  const x = cross(upUnit, z)
  if (length3(x) < 1e-6) invalid(`世界 up 提示与视线方向几乎平行（夹角 ${directionAngleDeg(upUnit, z).toFixed(4)}°）：这种视角的滚转无从确定，请另给 up（例如顶视时给 [0,1,0]）`)
  const xn = normalize3(x)
  const y = cross(z, xn)
  return quaternionFromRotationMatrix([[xn[0], y[0], z[0]], [xn[1], y[1], z[1]], [xn[2], y[2], z[2]]])
}

/**
 * 相机相对世界 up 的滚转（度）：绕视轴 z（指向相机后方）从"无滚转参考基"转到相机自身 x 轴的角度，
 * 在相机自己的坐标系里逆时针为正。由 lookAt(target, up) 定出来的姿态读数是 0。
 */
export function rollDegrees(q: ViewerQuat, worldUp: ViewerVec3): number {
  const z = rotateByQuaternion(q, [0, 0, 1])
  const upUnit = normalize3(worldUp, "up ")
  const projected = sub(upUnit, scale(z, dot(upUnit, z)))
  if (length3(projected) < 1e-6) return 0
  const y0 = normalize3(projected)
  const x0 = cross(y0, z)
  const x = cameraRight(q)
  return Math.atan2(dot(x, y0), dot(x, x0)) / DEG
}

/** 内参：校验 + 主点缺省（与 camera_fit 同一口径 `(width−1)/2`）。 */
export function normalizeIntrinsics(value: unknown, label = "intrinsics"): ViewerCameraIntrinsics {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} 必须是对象（fx/fy/width/height 必填）`)
  const source = value as Record<string, unknown>
  const width = positive(source.width, `${label}.width`)
  const height = positive(source.height, `${label}.height`)
  if (!Number.isInteger(width) || !Number.isInteger(height)) invalid(`${label}.width/height 必须是整数像素（收到 ${String(width)}×${String(height)}）`)
  const fx = positive(source.fx, `${label}.fx`)
  const fy = positive(source.fy, `${label}.fy`)
  const cx = source.cx === undefined ? (width - 1) / 2 : finite(source.cx, `${label}.cx`)
  const cy = source.cy === undefined ? (height - 1) / 2 : finite(source.cy, `${label}.cy`)
  // 主点可以在画面外一点（外参把它推到边缘），但不允许到"明显不是这台相机"的量级。
  if (Math.abs(cx - (width - 1) / 2) > width || Math.abs(cy - (height - 1) / 2) > height) invalid(`${label}.cx/cy 离画面太远（${String(cx)}、${String(cy)}；画面 ${String(width)}×${String(height)}）`)
  if (source.distortion !== undefined && !(Array.isArray(source.distortion) && source.distortion.every(item => typeof item === "number" && Number.isFinite(item)))) invalid(`${label}.distortion 必须是有限数数组`)
  return { fx, fy, cx, cy, width, height, ...source.distortion === undefined ? {} : { distortion: source.distortion as number[] } }
}
/** 内参 → 垂直视场角（度）：`fov = 2·atan(height/(2·fy))`。 */
export const fovYFromIntrinsics = (k: ViewerCameraIntrinsics): number => 2 * Math.atan(k.height / (2 * k.fy)) / DEG
/** 内参 → 水平视场角（度）。 */
export const fovXFromIntrinsics = (k: ViewerCameraIntrinsics): number => 2 * Math.atan(k.width / (2 * k.fx)) / DEG
/** 主点相对画面中心（像素中心口径）的偏移（像素）。 */
export const principalPointOffsetPx = (k: ViewerCameraIntrinsics): { x: number; y: number } => ({ x: k.cx - (k.width - 1) / 2, y: k.cy - (k.height - 1) / 2 })
/** 主点是否在画面中心（半像素以内，与 camera_fit 的 principalPointCentred 同判据）。 */
export const principalPointCentred = (k: ViewerCameraIntrinsics): boolean => { const offset = principalPointOffsetPx(k); return Math.abs(offset.x) <= 0.5 && Math.abs(offset.y) <= 0.5 }
/**
 * 这个内参是不是"普通镜头"（居中主点 + 方形像素）——也就是 three 的 `fov + aspect` 本身就能表达的那一种。
 *
 * 为什么需要：只有"普通镜头"以外的 K 才携带额外信息，保存/恢复相机状态时才有必要带上它；
 * 普通镜头带上它反而会让"清掉视口偏移"的语义消失（恢复时会被重新写成一个空转的偏移）。
 * 注意判据是**充分**的：满足它时 `fov + aspect` 复现出的投影与这个 K 逐位相同，因此省略不会丢信息。
 */
export const isPlainLens = (k: ViewerCameraIntrinsics): boolean => principalPointCentred(k) && Math.abs(k.fx - k.fy) <= 1e-9 * Math.max(Math.abs(k.fx), Math.abs(k.fy))

/**
 * 内参按画布尺寸等比缩放：**视场与主点占比完全不变**，只是像素尺度变了。
 *
 * 为什么需要：照片是 960×540、画布可能是任意尺寸。等比缩放保证"某方向落在画面哪个比例位置"
 * 不变——同机位比较时两张图可以直接叠着看；像素焦距与主点按同一比例走，回执里两个都如实报出。
 */
export function scaleIntrinsics(k: ViewerCameraIntrinsics, width: number, height: number): ViewerCameraIntrinsics {
  const scaleX = width / k.width, scaleY = height / k.height
  return {
    fx: k.fx * scaleX, fy: k.fy * scaleY,
    cx: (k.cx + 0.5) * scaleX - 0.5, cy: (k.cy + 0.5) * scaleY - 0.5,
    width, height,
    ...k.distortion === undefined ? {} : { distortion: k.distortion },
  }
}

/**
 * 内参 → three `PerspectiveCamera` 的四个参数（`fov`、`zoom`、视口偏移、`aspect`）。
 *
 * 推导（与 three 的 `updateProjectionMatrix` 逐行对过）：子视口宽高取真实画布尺寸时是 1:1 裁切，
 * 所以 `fullWidth = width·fx/fy` 承载像素长宽比、子视口左上角在虚拟图里的位置
 * `((fullWidth−1)/2 − cx, (fullHeight−1)/2 − cy)` 承载主点偏移。
 * 注意 `setViewOffset` 会把 `camera.aspect` 改成 `fullWidth/fullHeight`（three 的既有行为），
 * 而画布宽高比是 `width/height`：必须改回来，否则 fx 会被 aspect 带偏（测试钉住了这一条）。
 */
export function intrinsicsCameraParameters(k: ViewerCameraIntrinsics): { fov: number; zoom: number; fullWidth: number; fullHeight: number; offsetX: number; offsetY: number; width: number; height: number; aspect: number } {
  const fullWidth = k.width * k.fx / k.fy
  const fullHeight = k.height
  return {
    fov: fovYFromIntrinsics(k), zoom: 1,
    fullWidth, fullHeight,
    offsetX: (fullWidth - 1) / 2 - k.cx,
    offsetY: (fullHeight - 1) / 2 - k.cy,
    width: k.width, height: k.height, aspect: k.width / k.height,
  }
}

/**
 * 内参 → 投影矩阵（three `Matrix4.elements` 的**列主序**，16 个数）。
 *
 * 只用于核对：Viewer 里真正算矩阵的是 three 自己；宿主收到回执后用这个解析式按"报告的内参 +
 * 报告的图片尺寸"复算一遍，与相机自报的投影矩阵逐元素比。于是"内参和输出投影真的一致"
 * 不是一句声明，而是一次比对。
 */
export function projectionMatrixFromIntrinsics(k: ViewerCameraIntrinsics, near: number, far: number): number[] {
  if (!(near > 0) || !(far > near)) invalid(`near/far 不合法（near=${String(near)}，far=${String(far)}）：需要 0 < near < far`)
  const elements = new Array<number>(16).fill(0)
  elements[0] = 2 * k.fx / k.width
  elements[5] = 2 * k.fy / k.height
  elements[8] = (k.width - 1 - 2 * k.cx) / k.width
  elements[9] = (2 * k.cy + 1 - k.height) / k.height
  elements[10] = -(far + near) / (far - near)
  elements[11] = -1
  elements[14] = -2 * far * near / (far - near)
  return elements
}

/** 投影矩阵 → 内参（`projectionMatrixFromIntrinsics` 的逆）。画面尺寸必须由调用方给出。 */
export function intrinsicsFromProjectionMatrix(elements: unknown, width: number, height: number): ViewerCameraIntrinsics {
  if (!Array.isArray(elements) || elements.length !== 16 || elements.some(item => typeof item !== "number" || !Number.isFinite(item))) invalid("projectionMatrix 必须是 16 个有限数（three 的列主序）")
  const te = elements as number[]
  if (Math.abs(te[1]!) > 1e-9 || Math.abs(te[4]!) > 1e-9) invalid("投影矩阵带 x/y 交叉项（视锥被扭转），不是针孔透视矩阵")
  const fx = te[0]! * width / 2, fy = te[5]! * height / 2
  if (!(fx > 0) || !(fy > 0)) invalid(`投影矩阵的焦距不是正数（fx=${String(fx)}，fy=${String(fy)}）`)
  return { fx, fy, cx: (width - 1 - te[8]! * width) / 2, cy: (te[9]! * height + height - 1) / 2, width, height }
}
/** 相机系一点 → 像素（针孔投影；测试与宿主核对共用这一份）。`undefined` = 点在相机后方。 */
export function projectToPixel(k: ViewerCameraIntrinsics, pointCam: ViewerVec3): [number, number] | undefined {
  const depth = -pointCam[2]
  if (!(depth > EPSILON)) return undefined
  return [k.cx + k.fx * (pointCam[0] / depth), k.cy - k.fy * (pointCam[1] / depth)]
}
/** 相机系一点 → 世界系（`world = R·p_cam + t`）。 */
export const cameraPointToWorld = (position: ViewerVec3, q: ViewerQuat, pointCam: ViewerVec3): ViewerVec3 => add(position, rotateByQuaternion(q, pointCam))

/**
 * 把请求归一化成"可直接写进相机"的视角。规则（每条都有对应测试）：
 *   · 位置：字段名**就是尺度声明**。`position`/`positionM`/`viewer.position` 是米；
 *     `positionInputUnits`/`viewer.positionInputUnits` 是**输入单位**，只有在调用方显式给出
 *     `metersPerInputUnit` 时才换算应用，否则明确拒（`VIEWER_CAMERA_SCALE_UNKNOWN`）——
 *     既不把它当米，也不落回当前相机的位置装成应用成功；换算同时作用于块里**与位置同尺度**的
 *     `viewer.target`/`viewer.focusDistance`（55 的读数里它们与位置在同一个空间：`target = position + forward·focusDistance`）；
 *   · 位姿：`position` + 朝向（四元数 / 旋转矩阵 / worldFromCamera / target）。多个来源**互相核对**，
 *     夹角超过 0.5° 就拒——不静默挑一个，那正是"target/up/roll 互相覆盖"的来源；
 *   · 只给 target 时按世界 up 提示定朝向（roll = 0）；**一个朝向来源都没给**（只改 fov/near 这类部分更新）
 *     则沿用当前相机的姿态本身（含 roll），不退回"按 target 重新 lookAt"——那会把 roll 抹平；
 *   · 投影：`intrinsics` 与 `fovYDeg` 至少一个；同时给就核对（差超过 0.05° 拒），都没有则沿用当前内参/fov；
 *   · 字段摆法：契约声明的相机字段在**顶层**与 `camera` 块（含 camera_fit 的 `camera.viewer`）里等价读取，
 *     同一个量两处都写且对不上就明确拒——`fovYDeg`/`near`/`far`/`cameraUp` 曾经只认一处，块形式会静默沿用当前值；
 *   · `up` 是**世界 up 提示**，`cameraUp` 才是写进相机 up 轴的值（有 roll 时两者不同）。
 *     camera_fit 的块按它自己的口径读：`viewer.up` = 相机 up 轴 → `cameraUp`，`viewer.sceneUp` = 世界 up → 提示。
 */
export function normalizeCameraRequest(request: ViewerCameraRequest, current: ViewerCameraCurrent = {}): ViewerCameraView {
  const notes: string[] = []
  const block = request.camera ?? {}
  const flatBlock = block as Record<string, unknown>
  const viewer = block.viewer ?? (block.position !== undefined || block.quaternion !== undefined || block.fovYDeg !== undefined || block.fov_y_deg !== undefined || block.near !== undefined || block.far !== undefined ? block as ViewerCameraFitBlock["viewer"] : undefined)
  const fromCamera = request.worldFromCamera ?? block.worldFromCamera
  // 声明过的相机字段：顶层 / `camera` 块 / camera_fit 的 `camera.viewer` 三处都算（块被摊平时它就是 `viewer`，只算一次）。
  const declaredHolders: Array<readonly [string, Record<string, unknown> | undefined]> = [["顶层", request as Record<string, unknown>], ["camera 块", flatBlock], ...((viewer as unknown) !== flatBlock && viewer ? [["camera.viewer 块", viewer as Record<string, unknown>] as const] : [])]

  // ── 位置：字段名就是尺度声明 ──────────────────────────────────────────────
  // `position`/`positionM`/`viewer.position` = 米；`positionInputUnits`/`viewer.positionInputUnits` =
  // **输入单位**（camera_fit 在 worldUnit=unknown 时只给这些）。后者只有在调用方显式给出换算时才应用——
  // 没有换算就拒（VIEWER_CAMERA_SCALE_UNKNOWN），绝不落回 current.position 装成应用成功。
  const metricInput = request.metric ?? block.metric ?? viewer?.units?.metric
  if (metricInput !== undefined && typeof metricInput !== "boolean") invalid(`metric 必须是布尔（收到 ${JSON.stringify(metricInput ?? null)}）`)
  const metricPositionInput = request.position ?? viewer?.position ?? fromCamera?.positionM
  const inputUnitsInput = request.positionInputUnits ?? viewer?.positionInputUnits ?? fromCamera?.positionInputUnits
  const conversionInput = request.metersPerInputUnit ?? block.metersPerInputUnit ?? viewer?.units?.metersPerInputUnit
  const conversion = conversionInput === undefined || conversionInput === null ? undefined : positive(conversionInput, "metersPerInputUnit")
  let positionInput: unknown
  /**
   * 块里**与位置同尺度**的量（`viewer.target`/`viewer.focusDistance`）要乘的换算。
   * 55 的读数里 `target = position + forward·focusDistance`——它们是同一个空间里的量，位置是输入单位时它们也是；
   * 只换算位置、留着 target 不动，会让"给了显式换算"这条路在"target 是否落在视线上"的核对里被拒（或把转心摆错深度）。
   */
  let inputUnitsToMetres = 1
  if (metricPositionInput !== undefined && inputUnitsInput !== undefined) conflict("位置有两个说法：同时给了米制位置（position/positionM）与 positionInputUnits（输入单位）。只留一个——要么直接给米，要么给输入单位 + metersPerInputUnit。")
  if (metricPositionInput !== undefined) {
    if (metricInput === false) conflict("尺度声明与位置字段矛盾：camera/viewer 声明 units.metric=false（位置不是米），却又给了米制位置字段（position/positionM）。要应用这种相机请给 positionInputUnits + metersPerInputUnit（显式换算），或去掉 units.metric=false 的声明。")
    positionInput = metricPositionInput
  } else if (inputUnitsInput !== undefined) {
    if (metricInput === true) conflict("尺度声明与位置字段矛盾：声明 metric=true（位置是米），却给了 positionInputUnits（输入单位）。米制位置请用 position/positionM。")
    if (conversion === undefined) scaleUnknown(`这台相机的位置只有输入单位（camera_fit 的 positionInputUnits，worldUnit=${viewer?.units?.metric === false ? "unknown" : "未声明"}）：Viewer 的世界是米制，没有换算就摆不出来。请给 metersPerInputUnit（米/输入单位，例如标定了一条已知长度后算出的比值），或改用已知米制的位置（position/positionM）。不会按当前相机的位置顶替。`)
    const sameScaleGiven = (viewer?.target !== undefined && viewer?.target !== null) || (viewer?.focusDistance !== undefined && viewer?.focusDistance !== null)
    notes.push(`位置按输入单位 × ${conversion}（m/单位，调用方显式给出的换算）换算成米后应用：绝对尺度取决于这个换算，不是读数自带的。${sameScaleGiven ? "块里的 target/focusDistance 与它同尺度，一起按这个换算搬过来。" : ""}`)
    positionInput = scale(vec3(inputUnitsInput, "positionInputUnits"), conversion)
    inputUnitsToMetres = conversion
  } else {
    // 没有位置输入 = 部分更新（只换投影/裁剪面/朝向）：沿用当前相机的位置，如实记一条。
    if (metricInput === false) notes.push("这份相机声明尺度未定（units.metric=false）且没给可换算的位置：只应用了它的朝向/投影，位置仍是当前相机的——不是那台照片相机的位置。")
    positionInput = current.position
  }
  if (positionInput === undefined) invalid("没有相机位置：给 position（或 worldFromCamera.positionM），或在已有画面上做部分更新（只改 fov/near 等）")
  const position = vec3(positionInput, "position")

  // ── 朝向：把所有来源收齐再互相核对 ───────────────────────────────────────
  const orientation: Array<{ label: string; quaternion: ViewerQuat; source: ViewerCameraView["orientationSource"] }> = []
  if (request.quaternion !== undefined) orientation.push({ label: "quaternion", quaternion: normalizeQuaternion(request.quaternion), source: "quaternion" })
  if (viewer?.quaternion !== undefined) orientation.push({ label: "camera.viewer.quaternion", quaternion: normalizeQuaternion(viewer.quaternion, "camera.viewer.quaternion"), source: "quaternion" })
  if (fromCamera?.quaternionXyzw !== undefined) orientation.push({ label: "worldFromCamera.quaternionXyzw", quaternion: normalizeQuaternion(fromCamera.quaternionXyzw, "worldFromCamera.quaternionXyzw"), source: "worldFromCamera" })
  else if (fromCamera?.quaternion !== undefined) orientation.push({ label: "worldFromCamera.quaternion", quaternion: normalizeQuaternion(fromCamera.quaternion, "worldFromCamera.quaternion"), source: "worldFromCamera" })
  if (request.rotationMatrix !== undefined) orientation.push({ label: "rotationMatrix", quaternion: quaternionFromRotationMatrix(request.rotationMatrix), source: "rotationMatrix" })
  else if (fromCamera?.rotationMatrix !== undefined) orientation.push({ label: "worldFromCamera.rotationMatrix", quaternion: quaternionFromRotationMatrix(fromCamera.rotationMatrix, "worldFromCamera.rotationMatrix"), source: "worldFromCamera" })
  for (let index = 1; index < orientation.length; index++) {
    const angle = quaternionAngleDeg(orientation[0]!.quaternion, orientation[index]!.quaternion)
    if (angle > ANGLE_TOLERANCE_DEG) conflict(`位姿来源互相矛盾：${orientation[0]!.label} 与 ${orientation[index]!.label} 相差 ${angle.toFixed(3)}°（容差 ${ANGLE_TOLERANCE_DEG}°）。只给一个来源，或把它们改成同一个姿态。`)
  }

  // 世界 up 提示：显式给的优先；camera_fit 的 `viewer.sceneUp` 是它的正本；
  // 只有在**没有朝向来源**（即要用 target 定朝向）时，`viewer.up` 才按世界 up 读——那时它是调用方唯一的 up 依据。
  const worldUpInput = request.up ?? viewer?.sceneUp ?? (orientation.length ? undefined : viewer?.up)
  const up = normalize3(worldUpInput === undefined ? [0, 0, 1] : vec3(worldUpInput, "up"), "世界 up 提示")
  // 显式 `request.target` 是**调用方**给的米制转心，不跟着块的尺度走；`viewer.target` 是块自己的、与位置同尺度。
  const targetInput = request.target !== undefined
    ? optionalVec3(request.target, "target")
    : viewer?.target === undefined || viewer?.target === null ? undefined : scale(vec3(viewer.target, "camera.viewer.target"), inputUnitsToMetres)
  // `viewer.focusDistance: null` 是 55 的"没给"（类型就是 `number|null`），按没给处理，不当成非法数。
  const blockFocusDistance = viewer?.focusDistance === undefined || viewer?.focusDistance === null ? undefined : finite(viewer.focusDistance, "camera.viewer.focusDistance") * inputUnitsToMetres
  const distanceInput = request.targetDistanceM === undefined
    ? blockFocusDistance ?? current.targetDistanceM
    : finite(request.targetDistanceM, "targetDistanceM")

  let quaternion: ViewerQuat, orientationSource: ViewerCameraView["orientationSource"], target: ViewerVec3, targetDistanceM: number, cameraUp: ViewerVec3
  // `cameraUp`（相机自身 up 轴）同样块里也认；块里只给了 `up` 时仍按 camera_fit 的旧形状读成相机 up 轴（这是既有口径，不改）。
  const declaredCameraUp = declaredCameraField(declaredHolders, ["cameraUp"], "cameraUp")?.value
  const explicitCameraUp = declaredCameraUp === undefined && viewer?.up === undefined
    ? undefined
    : normalize3(vec3(declaredCameraUp ?? viewer?.up, declaredCameraUp === undefined ? "camera.viewer.up" : "cameraUp"), "cameraUp")
  if (orientation.length) {
    quaternion = orientation[0]!.quaternion
    orientationSource = orientation[0]!.source
    const forward = normalize3(cameraForward(quaternion), "视线方向")
    const toTarget = targetInput ? sub(targetInput, position) : undefined
    if (targetInput && toTarget && length3(toTarget) >= 1e-6) {
      const angle = directionAngleDeg(toTarget, forward)
      if (angle > ANGLE_TOLERANCE_DEG) conflict(`target 与朝向说的不是同一个方向：target 方向与视线相差 ${angle.toFixed(3)}°（容差 ${ANGLE_TOLERANCE_DEG}°）。要么把 target 放在视线上，要么去掉其中一个。`)
      if (angle > 1e-6) notes.push(`target 与视线相差 ${angle.toFixed(4)}°（容差内）：转心按视线方向落在同一距离上，避免 controls.update() 把姿态拧走。`)
      targetDistanceM = length3(toTarget)
    } else {
      targetDistanceM = distanceInput !== undefined && distanceInput > 1e-6 ? distanceInput : 1
      if (targetInput) notes.push("target 与 position 重合：转心改按视线正前方放置。")
    }
    target = add(position, scale(forward, targetDistanceM))
    cameraUp = explicitCameraUp ?? normalize3(cameraUpAxis(quaternion), "相机 up 轴")
  } else if (!targetInput && current.quaternion !== undefined) {
    // 部分更新（常见：只改 fov/near、或只给内参）：沿用**当前姿态本身**（含 roll）。
    // 不能退回"用 target 定朝向"：那等于按世界 up 重新 lookAt 一次，roll 会被抹平（照片机位就废了）。
    quaternion = normalizeQuaternion(current.quaternion, "current.quaternion")
    orientationSource = "current"
    const forward = normalize3(cameraForward(quaternion), "视线方向")
    const currentDistance = current.position === undefined || current.target === undefined ? undefined : length3(sub(current.target, current.position))
    targetDistanceM = distanceInput !== undefined && distanceInput > 1e-6 ? distanceInput : currentDistance !== undefined && currentDistance > 1e-6 ? currentDistance : 1
    target = add(position, scale(forward, targetDistanceM))
    cameraUp = explicitCameraUp ?? normalize3(current.cameraUp ?? cameraUpAxis(quaternion), "相机 up 轴")
    notes.push("没给朝向：沿用当前相机的姿态（含 roll），只改你给的那几项。")
  } else {
    if (!targetInput) invalid("没有朝向：给 quaternion / rotationMatrix / worldFromCamera / target 中的至少一个（或在已有画面上做部分更新，只改投影/裁剪面）")
    const toTarget = sub(targetInput, position)
    if (length3(toTarget) < 1e-6) invalid("target 与 position 重合，视线方向无从确定")
    quaternion = quaternionLookingAt(position, targetInput, up)
    orientationSource = "target"
    target = targetInput
    targetDistanceM = length3(toTarget)
    cameraUp = explicitCameraUp ?? up
    if (explicitCameraUp && directionAngleDeg(explicitCameraUp, up) > ANGLE_TOLERANCE_DEG) notes.push("给了 cameraUp 与 up（世界 up 提示）不一致：朝向按 target+up 定，camera.up 用 cameraUp。")
  }

  // ── 投影 ────────────────────────────────────────────────────────────────
  // 内参来源：显式 `intrinsics` 优先，其次 camera_fit 块里的 `viewer.intrinsics`（它带着完整 K）。
  const intrinsicsInput = request.intrinsics ?? viewer?.intrinsics ?? block.intrinsics
  // `fovYDeg`（工具契约的拼写）与 `fov_y_deg`（camera_fit 的拼写）在块里同样有效——只认后者会让块形式的请求静默沿用当前视场角。
  const fovInput = declaredCameraField(declaredHolders, ["fovYDeg", "fov_y_deg"], "垂直视场角 fovYDeg")?.value
  const fovGiven = fovInput === undefined ? undefined : finite(fovInput, "fovYDeg")
  if (fovGiven !== undefined && !(fovGiven > 0.001 && fovGiven < 179.999)) invalid(`fovYDeg 必须在 (0,180) 度之间（收到 ${String(fovGiven)}）`)
  let intrinsics: ViewerCameraIntrinsics | undefined, fovYDeg: number, projectionSource: ViewerCameraView["projectionSource"]
  if (intrinsicsInput !== undefined) {
    intrinsics = normalizeIntrinsics(intrinsicsInput)
    fovYDeg = fovYFromIntrinsics(intrinsics)
    projectionSource = "intrinsics"
    if (fovGiven !== undefined && Math.abs(fovGiven - fovYDeg) > FOV_TOLERANCE_DEG) conflict(`内参与 fov 互相矛盾：按 K（fy=${intrinsics.fy.toFixed(3)}、height=${String(intrinsics.height)}）算出的垂直视场角是 ${fovYDeg.toFixed(4)}°，给的是 ${fovGiven.toFixed(4)}°（容差 ${FOV_TOLERANCE_DEG}°）。去掉 fovYDeg，或确认内参。`)
    if (fovGiven !== undefined) notes.push(`fovYDeg=${fovGiven.toFixed(4)}° 与内参自洽（按 K 算是 ${fovYDeg.toFixed(4)}°），以 K 为准复现。`)
    if ((intrinsics.distortion ?? []).some(item => item !== 0)) notes.push(`内参带畸变系数 [${(intrinsics.distortion ?? []).map(item => String(item)).join(", ")}]：原生 Viewer 是理想针孔，复现不了畸变——按 pinhole 应用，画面边缘会与照片不同。`)
    const offset = principalPointOffsetPx(intrinsics)
    notes.push(principalPointCentred(intrinsics)
      ? "主点在画面中心（半像素以内）：three 的居中视锥本身就够用。"
      : `主点偏离画面中心 (${offset.x.toFixed(2)}, ${offset.y.toFixed(2)}) 像素：用 three 的视口偏移复现，不假装它居中。`)
  } else if (fovGiven !== undefined) {
    fovYDeg = fovGiven
    projectionSource = "fov"
    const offsetX = viewer?.principalPointOffsetPx?.x === undefined ? 0 : finite(viewer.principalPointOffsetPx.x, "camera.viewer.principalPointOffsetPx.x")
    const offsetY = viewer?.principalPointOffsetPx?.y === undefined ? 0 : finite(viewer.principalPointOffsetPx.y, "camera.viewer.principalPointOffsetPx.y")
    if (Math.abs(offsetX) > 0.5 || Math.abs(offsetY) > 0.5) notes.push(`照片主点偏离画面中心 (${offsetX.toFixed(2)}, ${offsetY.toFixed(2)}) 像素，但没有给 intrinsics：单条 fov 复现不了它，Viewer 会按居中主点画。要与照片同构图请连 intrinsics 一起给。`)
  } else {
    // "只换机位"就该只换机位：当前是照片内参（主点偏移/fx≠fy）就一起沿用，不因为没给投影而把镜头换成居中针孔。
    intrinsics = current.intrinsics
    fovYDeg = current.intrinsics ? fovYFromIntrinsics(current.intrinsics) : current.fovYDeg ?? 50
    projectionSource = "keep"
    notes.push(current.intrinsics && !isPlainLens(current.intrinsics)
      ? "没给投影（intrinsics/fovYDeg）：沿用当前内参（含主点偏移/非方形像素），只换机位。"
      : "没给投影（intrinsics/fovYDeg）：沿用当前垂直视场角，只换机位。")
  }
  // 裁剪面同样按"块与扁平都算"读：只认顶层会让 `camera:{…,near,far}` 静默沿用当前值。
  const near = finite(declaredCameraField(declaredHolders, ["near"], "near")?.value ?? current.near ?? 0.01, "near")
  const far = finite(declaredCameraField(declaredHolders, ["far"], "far")?.value ?? current.far ?? 10000, "far")
  if (!(near > 0) || !(far > near)) invalid(`near/far 不合法（near=${String(near)}，far=${String(far)}）：需要 0 < near < far`)

  const rollDeg = rollDegrees(quaternion, up)
  if (orientationSource === "target" && Math.abs(rollDeg) > 1e-6) notes.push(`按 target+up 定出的姿态 roll=${rollDeg.toFixed(6)}°（应为 0）——lookAt 基准与 up 提示不自洽。`)
  return {
    position, quaternion, cameraUp, target, targetDistanceM, fovYDeg, near, far, up,
    ...intrinsics === undefined ? {} : { intrinsics },
    orientationSource, projectionSource, rollDeg, notes,
  }
}

/** 能否被 `applyViewToCamera` 驱动的相机（three `PerspectiveCamera` 结构上正好满足）。 */
export interface ProjectableCamera {
  readonly position: { set(x: number, y: number, z: number): unknown; toArray(): number[] }
  readonly quaternion: { set(x: number, y: number, z: number, w: number): unknown; toArray(): number[] }
  readonly up: { set(x: number, y: number, z: number): unknown; toArray(): number[] }
  fov: number
  aspect: number
  near: number
  far: number
  zoom: number
  updateProjectionMatrix(): void
  setViewOffset(fullWidth: number, fullHeight: number, x: number, y: number, width: number, height: number): void
  clearViewOffset(): void
}
/** 能"量出视角"的相机：在 `ProjectableCamera` 之上要投影矩阵与视口偏移（three 也有）。 */
export interface MeasurableCamera extends ProjectableCamera {
  readonly projectionMatrix: { toArray(): number[] }
  view?: { enabled: boolean; fullWidth: number; fullHeight: number; offsetX: number; offsetY: number; width: number; height: number } | null
}

export interface ViewerCanvasSize { width: number; height: number }
/** 视图尺寸上限：超过就别渲染（视口上限、显存与一次 toDataURL 的代价都不该被静默吃掉）。 */
export const MAX_CAMERA_IMAGE_PIXELS = 16_000_000
export const MAX_CAMERA_IMAGE_SIDE = 8192
/** 视图尺寸校验（`viewer_render_camera` 与离屏渲染共用）。 */
export function assertRenderSize(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) invalid(`图片尺寸不合法：${String(width)}×${String(height)}（需要正整数）`)
  if (width > MAX_CAMERA_IMAGE_SIDE || height > MAX_CAMERA_IMAGE_SIDE || width * height > MAX_CAMERA_IMAGE_PIXELS) invalid(`图片尺寸 ${String(width)}×${String(height)} 超过上限（单边 ≤ ${String(MAX_CAMERA_IMAGE_SIDE)}，总像素 ≤ ${String(MAX_CAMERA_IMAGE_PIXELS)}）`)
}

/**
 * 把视角真正写进相机（唯一一处写相机的地方）。
 *
 * roll 能不能活下来就看 `camera.up`：OrbitControls 每帧都会 `lookAt(target)`，它拿 `camera.up`
 * 当参考；把 up 设成"相机自身 y 轴在世界里的方向"，重算出来的姿态与刚写进去的逐位相同
 * （测试量到 1.7e-6 度；不设 up 的旧行为在同一姿态上丢了 115.9 度）。
 * 有内参时按内参复现（含主点偏移与 fx≠fy）；画布尺寸与照片不同就按比例缩放。
 */
export function applyViewToCamera(camera: ProjectableCamera, view: ViewerCameraView, size: ViewerCanvasSize): void {
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width <= 0 || size.height <= 0) invalid(`画布尺寸不合法：${String(size.width)}×${String(size.height)}`)
  camera.position.set(...view.position)
  camera.quaternion.set(...view.quaternion)
  camera.up.set(...view.cameraUp)
  camera.near = view.near
  camera.far = view.far
  camera.zoom = 1
  if (view.intrinsics) setCameraIntrinsics(camera, scaleIntrinsics(view.intrinsics, size.width, size.height))
  else {
    camera.clearViewOffset()
    camera.aspect = size.width / size.height
    camera.fov = view.fovYDeg
  }
  camera.updateProjectionMatrix()
}
/** 把（已按画布尺寸缩放过的）内参写进相机：fov + 视口偏移 + aspect，一步不少。 */
export function setCameraIntrinsics(camera: ProjectableCamera, k: ViewerCameraIntrinsics): void {
  const parameters = intrinsicsCameraParameters(k)
  camera.fov = parameters.fov
  camera.zoom = parameters.zoom
  camera.setViewOffset(parameters.fullWidth, parameters.fullHeight, parameters.offsetX, parameters.offsetY, parameters.width, parameters.height)
  // setViewOffset 把 aspect 改成了 fullWidth/fullHeight；画布宽高比是 width/height，改回来（否则 fx 被带偏）。
  camera.aspect = parameters.aspect
  camera.updateProjectionMatrix()
}

/** 从相机**量出来**的视角（回执与核对读的是它，不是我们请求了什么）。 */
export interface ViewerCameraMeasurement {
  position: ViewerVec3
  quaternion: ViewerQuat
  up: ViewerVec3
  fovYDeg: number
  fovXDeg: number
  near: number
  far: number
  projection: "perspective"
  aspect: number
  imageWidth: number
  imageHeight: number
  intrinsics: ViewerCameraIntrinsics
  /** three 的列主序投影矩阵（16 个数）：与内参是同一个事实的两种写法，宿主/测试按它逐元素核对。 */
  projectionMatrix: number[]
  principalPointOffsetPx: { x: number; y: number }
  principalPointCentred: boolean
  viewOffset: { fullWidth: number; fullHeight: number; offsetX: number; offsetY: number } | null
  rollDeg: number
  worldFromCamera: { positionM: ViewerVec3; rotationMatrix: number[][]; quaternionXyzw: ViewerQuat }
}
export function describeCameraView(camera: MeasurableCamera, size: ViewerCanvasSize, worldUp: ViewerVec3 = [0, 0, 1]): ViewerCameraMeasurement {
  const elements = camera.projectionMatrix.toArray()
  const intrinsics = intrinsicsFromProjectionMatrix(elements, size.width, size.height)
  const quaternion = normalizeQuaternion(camera.quaternion.toArray())
  const position = vec3(camera.position.toArray(), "position")
  const view = camera.view?.enabled
    ? { fullWidth: camera.view.fullWidth, fullHeight: camera.view.fullHeight, offsetX: camera.view.offsetX, offsetY: camera.view.offsetY }
    : null
  return {
    position, quaternion, up: normalize3(vec3(camera.up.toArray(), "camera.up"), "camera.up"),
    fovYDeg: camera.fov, fovXDeg: 2 * Math.atan(1 / elements[0]!) / DEG, near: camera.near, far: camera.far,
    projection: "perspective", aspect: camera.aspect, imageWidth: size.width, imageHeight: size.height,
    intrinsics, projectionMatrix: elements,
    principalPointOffsetPx: principalPointOffsetPx(intrinsics), principalPointCentred: principalPointCentred(intrinsics),
    viewOffset: view, rollDeg: rollDegrees(quaternion, worldUp),
    worldFromCamera: { positionM: position, rotationMatrix: rotationMatrixColumnsFromQuaternion(quaternion), quaternionXyzw: quaternion },
  }
}

/**
 * 应用完之后**当场核对**："写进去的"与"相机里量出来的"必须一致。
 *
 * 为什么非有这一步：`controls.update()` 会在应用之后重算姿态，任何一处（up 没跟着走、内参被
 * aspect 带偏、视口偏移没生效、OrbitControls 的 target 没落在视线上）都会在这里暴露成明确的不一致，
 * 而不是等到"模型的图看起来不太对"。核对带 `target` 时把转心也一起量。
 */
export function verifyAppliedView(camera: MeasurableCamera, view: ViewerCameraView, size: ViewerCanvasSize, extra: { target?: ViewerVec3 } = {}): { ok: boolean; errors: string[]; measured: ViewerCameraMeasurement } {
  const measured = describeCameraView(camera, size, view.up)
  const errors: string[] = []
  const compareNumber = (label: string, actual: number, expected: number, tolerance: number, unit = "") => {
    if (!(Math.abs(actual - expected) <= tolerance)) errors.push(`${label}：期望 ${expected.toFixed(6)}${unit}，实测 ${actual.toFixed(6)}${unit}（差 ${Math.abs(actual - expected).toExponential(2)}）`)
  }
  const comparePoint = (label: string, actual: ViewerVec3, expected: ViewerVec3) => {
    const distance = length3(sub(actual, expected))
    if (!(distance <= 1e-6 * Math.max(1, length3(expected)))) errors.push(`${label}：期望 [${expected.map(item => item.toFixed(6)).join(", ")}]，实测 [${actual.map(item => item.toFixed(6)).join(", ")}]（差 ${distance.toExponential(2)} 米）`)
  }
  const compareDirection = (label: string, actual: ViewerVec3, expected: ViewerVec3) => {
    const angle = directionAngleDeg(actual, expected)
    if (!(angle <= VERIFY_TOLERANCE_DEG)) errors.push(`${label}：期望 [${expected.map(item => item.toFixed(6)).join(", ")}]，实测 [${actual.map(item => item.toFixed(6)).join(", ")}]（相差 ${angle.toExponential(2)}°）`)
  }
  comparePoint("相机位置", measured.position, view.position)
  const poseAngle = quaternionAngleDeg(measured.quaternion, view.quaternion)
  if (!(poseAngle <= VERIFY_TOLERANCE_DEG)) errors.push(`姿态没复现：期望 [${view.quaternion.map(item => item.toFixed(6)).join(", ")}]，实测 [${measured.quaternion.map(item => item.toFixed(6)).join(", ")}]（相差 ${poseAngle.toExponential(2)}°）——多半是 camera.up 与姿态不一致，controls.update() 把姿态拧走了`)
  compareDirection("camera.up", measured.up, view.cameraUp)
  compareNumber("near", measured.near, view.near, 1e-9)
  compareNumber("far", measured.far, view.far, Math.max(1e-6, Math.abs(view.far) * 1e-9))
  if (extra.target) comparePoint("controls.target（转心必须落在视线上）", extra.target, view.target)
  if (view.intrinsics) {
    const expected = scaleIntrinsics(view.intrinsics, size.width, size.height)
    compareNumber("内参 fx(像素)", measured.intrinsics.fx, expected.fx, Math.max(1e-6, expected.fx * 1e-9))
    compareNumber("内参 fy(像素)", measured.intrinsics.fy, expected.fy, Math.max(1e-6, expected.fy * 1e-9))
    compareNumber("内参 cx(像素)", measured.intrinsics.cx, expected.cx, Math.max(1e-6, Math.abs(expected.cx) * 1e-9))
    compareNumber("内参 cy(像素)", measured.intrinsics.cy, expected.cy, Math.max(1e-6, Math.abs(expected.cy) * 1e-9))
    const analytic = projectionMatrixFromIntrinsics(expected, view.near, view.far)
    const actual = camera.projectionMatrix.toArray()
    const worst = Math.max(...analytic.map((item, index) => Math.abs(item - actual[index]!)))
    if (!(worst <= 1e-9)) errors.push(`投影矩阵与内参不自洽：逐元素最大差 ${worst.toExponential(2)}（按报告的内参解析复算 vs 相机自报的矩阵）`)
  } else {
    compareNumber("fovYDeg", measured.fovYDeg, view.fovYDeg, 1e-9)
    if (measured.viewOffset) errors.push("这次没给内参，但相机还带着视口偏移（上一次的设置没被清掉）")
  }
  return { ok: errors.length === 0, errors, measured }
}

/**
 * 位姿 → `worldFromCamera`（列 = 相机轴）：与 camera_fit 的输入口同形，可以直接回喂给需要位姿的
 * 工具（对应点、Blender 适配），不需要模型自己换算。
 */
export function worldFromCameraOf(position: ViewerVec3, quaternion: ViewerQuat): { positionM: ViewerVec3; rotationMatrix: number[][]; quaternionXyzw: ViewerQuat } {
  return { positionM: position, rotationMatrix: rotationMatrixColumnsFromQuaternion(quaternion), quaternionXyzw: quaternion }
}

/** `OrbitControls` 在"写相机"这件事上被用到的结构面（真实实例与测试替身形状一致，才谈得上同一份实现）。 */
export interface OrbitControlsLike {
  readonly target: { set(x: number, y: number, z: number): unknown; toArray(): number[] }
  update(): void
}
/**
 * 把视角写进相机与转心、让 controls 复算一次姿态、再**当场核对**——按这个顺序做这件事的**唯一一处**。
 *
 * 顺序本身是结论的一部分：`applyViewToCamera` 先把 `camera.up` 设成"相机自身 y 轴在世界里的方向"，
 * `controls.update()`（它每帧 lookAt 转心）才复现得出同一个姿态。所以生产（`SceneViewer.writeCameraView`）
 * 与测试调用的都是这一份：测试不在自己那边重写一遍调用顺序，否则量到的只是测试自己。
 */
export function writeViewToCamera(camera: ProjectableCamera & MeasurableCamera, controls: OrbitControlsLike | undefined, view: ViewerCameraView, size: ViewerCanvasSize): { ok: boolean; errors: string[]; measured: ViewerCameraMeasurement } {
  applyViewToCamera(camera, view, size)
  if (controls) {
    controls.target.set(...view.target)
    controls.update()
  }
  return verifyAppliedView(camera, view, size, controls ? { target: controls.target.toArray() as ViewerVec3 } : {})
}

/** 可恢复相机状态的**结构**面（客户端那份 `ViewerViewState` 结构上满足它）。 */
export interface ViewerCameraStateLike {
  position: unknown
  quaternion: unknown
  target: unknown
  up?: unknown
  fovDeg?: number
  near?: number
  far?: number
  intrinsics?: unknown
}
/** `cameraStateFromView` 的具体形状（= 客户端 `ViewerViewState`）。 */
export interface ViewerCameraStateOut {
  position: ViewerVec3
  quaternion: ViewerQuat
  target: ViewerVec3
  up?: ViewerVec3
  fovDeg?: number
  near?: number
  far?: number
  intrinsics?: ViewerCameraIntrinsics
}
/**
 * 从相机**量出**一份可恢复状态（`SceneViewer.getViewState` 与测试共用这一份）。
 *
 * `intrinsics` 只在**非普通镜头**时出现（`isPlainLens`）：普通镜头的 K 由 fov + aspect 完全表达，
 * 存下来只会在恢复时多写一个空转的视口偏移。转心由调用方给（它是 controls 的状态，不在相机里）。
 */
export function cameraStateFromView(camera: MeasurableCamera, size: ViewerCanvasSize, target: ViewerVec3): ViewerCameraStateOut {
  const measurement = describeCameraView(camera, size)
  return {
    position: measurement.position, quaternion: measurement.quaternion, target,
    up: measurement.up, fovDeg: measurement.fovYDeg, near: measurement.near, far: measurement.far,
    ...isPlainLens(measurement.intrinsics) ? {} : { intrinsics: measurement.intrinsics },
  }
}
/**
 * 可恢复的相机状态 → 应用请求（`setViewState` 与命名相机恢复共用这一份映射，不各写一遍）。
 *
 * `up` 是**相机自身 up 轴** → `cameraUp`（不是世界 up 提示）；四元数是姿态的唯一出处，target 只给转心距离。
 */
export function cameraRequestFromState(state: ViewerCameraStateLike): ViewerCameraRequest {
  return {
    position: state.position, quaternion: state.quaternion, target: state.target,
    ...state.up === undefined ? {} : { cameraUp: state.up },
    ...state.fovDeg === undefined ? {} : { fovYDeg: state.fovDeg },
    ...state.near === undefined ? {} : { near: state.near },
    ...state.far === undefined ? {} : { far: state.far },
    ...state.intrinsics === undefined ? {} : { intrinsics: state.intrinsics },
  }
}

// ── 命名相机：Scene 文档里的一条薄组件 ───────────────────────────────────────
/**
 * 命名相机存在**场景文档**里（`entity.components.viewerCamera`），不是本窗口的 localStorage。
 *
 * 为什么：机位属于"用户在这个场景里存下来的东西"，要能随工程移动、能被另一个窗口/客户端读到、
 * 也跟着场景版本历史回退。localStorage 三条都做不到（换台机器就没了、另一个窗口读不到、撤销不回）。
 * 这里只定义**格式与校验**（owner），写路径由产品自己的 `scene_edit`（CAS）走，不新开 host 表或状态库：
 *   · 读（任何窗口/工具/界面）：`namedCamerasOfScene(entities)`；
 *   · 写：`withNamedCamera` / `withoutNamedCamera` 改表 → `composeViewerCameraComponent` → `changes.components.viewerCamera`。
 *
 * 存的是**应用后量出来的状态**（`cameraStateFromView` 的那份，含 roll/视场/裁剪面/非普通镜头的 K），
 * 不是原始请求：照片 K 在画布上按尺寸缩放，存原始请求会让"恢复的那次"和"刚应用的那次"不是同一台相机。
 */
export const VIEWER_CAMERA_COMPONENT = "viewerCamera"
/** 单场景命名相机上限：够用，也能挡住手改文档把组件撑爆。 */
export const MAX_NAMED_CAMERAS = 40
export const MAX_CAMERA_NAME = 60
/** 一台命名相机：名字、保存时刻、可恢复状态。 */
export interface NamedCamera { name: string; savedAt: string; state: ViewerCameraStateOut }
/** 组件值本身（`entity.components.viewerCamera`）。 */
export interface ViewerCameraComponent { cameras: NamedCamera[] }

const finiteOrUndefined = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined
const tripleOrUndefined = (value: unknown, length: number): number[] | undefined =>
  Array.isArray(value) && value.length === length && value.every(item => typeof item === "number" && Number.isFinite(item)) ? value as number[] : undefined
/**
 * 读入即校验（场景文档是**外部输入**：手改、旧版本、别的工具写的）。坏一条丢一条，不整份清空。
 *
 * 内参单独判：它是**标量** fx/fy/cx/cy 加两个正整数尺寸，不能用数组检查器去问（曾经这么写过，
 * 于是每台命名相机读回来都丢掉镜头——fx 不是数组，检查器直接判假——roll 还在，镜头悄悄没了）。
 * 内参坏了就丢内参（留机位），整条状态坏了才丢这台相机。
 */
export function normalizeNamedCameraState(value: unknown): { state?: ViewerCameraStateOut; warning?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { warning: "状态不是对象" }
  const raw = value as Record<string, unknown>
  const position = tripleOrUndefined(raw.position, 3), quaternion = tripleOrUndefined(raw.quaternion, 4), target = tripleOrUndefined(raw.target, 3)
  if (!position || !quaternion || !target) return { warning: "缺 position/quaternion/target（或不是有限数）" }
  const up = tripleOrUndefined(raw.up, 3)
  const fovDeg = finiteOrUndefined(raw.fovDeg), near = finiteOrUndefined(raw.near), far = finiteOrUndefined(raw.far)
  let intrinsics: ViewerCameraIntrinsics | undefined, warning: string | undefined
  if (raw.intrinsics !== undefined) {
    const row: Record<string, unknown> | undefined = raw.intrinsics && typeof raw.intrinsics === "object" && !Array.isArray(raw.intrinsics) ? raw.intrinsics as Record<string, unknown> : undefined
    const scalars = row !== undefined && ["fx", "fy", "cx", "cy"].every(key => finiteOrUndefined(row[key]) !== undefined)
    const size = row !== undefined && [row.width, row.height].every(item => typeof item === "number" && Number.isInteger(item) && item > 0)
    if (scalars && size) intrinsics = normalizeIntrinsics(row)
    else warning = "intrinsics 形状不对（要 fx/fy/cx/cy 有限数 + width/height 正整数）：这台相机只留机位，镜头按普通镜头恢复"
  }
  const quaternionNormal = normalizeQuaternion(quaternion, "quaternion")
  return {
    state: {
      position: position as ViewerVec3, quaternion: quaternionNormal, target: target as ViewerVec3,
      ...up === undefined ? {} : { up: up as ViewerVec3 },
      ...fovDeg === undefined ? {} : { fovDeg }, ...near === undefined ? {} : { near }, ...far === undefined ? {} : { far },
      ...intrinsics === undefined ? {} : { intrinsics },
    },
    ...warning === undefined ? {} : { warning },
  }
}
/** 组件值 → 命名相机表（含逐条警告；空/坏值一律给空表 + 警告，不抛）。 */
export function parseViewerCameraComponent(value: unknown): { cameras: NamedCamera[]; warnings: string[] } {
  const warnings: string[] = []
  if (value === undefined || value === null) return { cameras: [], warnings }
  if (typeof value !== "object" || Array.isArray(value)) return { cameras: [], warnings: [`viewerCamera 组件不是对象（收到 ${Array.isArray(value) ? "数组" : typeof value}）：整条忽略`] }
  const rows = (value as { cameras?: unknown }).cameras
  if (rows === undefined) return { cameras: [], warnings: ["viewerCamera 组件里没有 cameras 数组：整条忽略"] }
  if (!Array.isArray(rows)) return { cameras: [], warnings: ["viewerCamera.cameras 不是数组：整条忽略"] }
  if (rows.length > MAX_NAMED_CAMERAS) warnings.push(`viewerCamera.cameras 有 ${String(rows.length)} 台，超过上限 ${String(MAX_NAMED_CAMERAS)}：只读前 ${String(MAX_NAMED_CAMERAS)} 台`)
  const cameras: NamedCamera[] = []
  for (const item of rows.slice(0, MAX_NAMED_CAMERAS)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) { warnings.push("有一条命名相机不是对象：丢弃"); continue }
    const raw = item as Record<string, unknown>
    const name = typeof raw.name === "string" ? raw.name.trim().slice(0, MAX_CAMERA_NAME) : ""
    if (!name) { warnings.push("有一条命名相机没有名字：丢弃"); continue }
    if (cameras.some(row => row.name === name)) { warnings.push(`命名相机「${name}」出现多次：只保留第一条`); continue }
    const parsed = normalizeNamedCameraState(raw.state)
    if (!parsed.state) { warnings.push(`命名相机「${name}」读不出来（${parsed.warning ?? "状态无效"}）：丢弃`); continue }
    if (parsed.warning) warnings.push(`命名相机「${name}」：${parsed.warning}`)
    cameras.push({ name, savedAt: typeof raw.savedAt === "string" && raw.savedAt ? raw.savedAt : new Date(0).toISOString(), state: parsed.state })
  }
  return { cameras, warnings }
}
/**
 * 从**场景快照的实体表**里读命名相机：组件在哪个实体上就认哪个（第一个带它的实体 = 承载实体）。
 *
 * 承载实体由文档自己决定（谁写了组件就是谁），不按名字/顺序猜：另一个窗口、另一个客户端读的是同一份
 * 文档，结论也就一样。没有组件时给空表——"这个场景还没有命名相机"不是错误。
 */
export function namedCamerasOfScene(entities: readonly { entityId: string; components?: unknown }[] | undefined): { cameras: NamedCamera[]; carrier?: string; warnings: string[] } {
  const warnings: string[] = []
  for (const entity of entities ?? []) {
    const components = entity.components as Record<string, unknown> | undefined
    if (!components || !(VIEWER_CAMERA_COMPONENT in components)) continue
    const parsed = parseViewerCameraComponent(components[VIEWER_CAMERA_COMPONENT])
    if (warnings.length === 0 && parsed.cameras.length === 0 && parsed.warnings.length > 0) {
      warnings.push(...parsed.warnings)
      continue
    }
    return { cameras: parsed.cameras, carrier: entity.entityId, warnings: [...warnings, ...parsed.warnings] }
  }
  return { cameras: [], warnings }
}
/** 组件值（写进 `changes.components.viewerCamera` 的值；一台都没有时给空表，由调用方决定要不要写）。 */
export const composeViewerCameraComponent = (cameras: readonly NamedCamera[]): ViewerCameraComponent => ({ cameras: cameras.slice(0, MAX_NAMED_CAMERAS).map(row => ({ name: row.name, savedAt: row.savedAt, state: row.state })) })
/** 保存/覆盖一台（同名覆盖），新的在前；名字先 trim + 截断（与读入同一套上界）。 */
export function withNamedCamera(cameras: readonly NamedCamera[], camera: NamedCamera): NamedCamera[] {
  const name = camera.name.trim().slice(0, MAX_CAMERA_NAME)
  if (!name) invalid("命名相机要有名字")
  return [{ ...camera, name }, ...cameras.filter(row => row.name !== name)].slice(0, MAX_NAMED_CAMERAS)
}
/** 删掉一台（没有这个名字就原样返回）。 */
export const withoutNamedCamera = (cameras: readonly NamedCamera[], name: string): NamedCamera[] => cameras.filter(row => row.name !== name.trim())
