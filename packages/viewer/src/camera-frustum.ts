/**
 * 相机视锥（四棱台 + 像平面矩形）的**纯几何**——3D 视图里"看得见相机"（DEV-038）那一层的数学。
 *
 * 口径与相机合同同一份（`sim-mujoco/python/worker.py` 的 `depthSemantics`、本目录 `camera-view.ts`）：
 * 相机系 +X 右 / +Y 上 / −Z 前；`p_cam(u,v,d) = [(u−cx)·d/fx, −(v−cy)·d/fy, −d]`；锥角取像素网格的
 * **真实边缘** `u ∈ {−0.5, W−0.5}`、`v ∈ {−0.5, H−0.5}`（像素中心口径下首/末像素中心在 0 与 W−1，
 * 整幅图像的边缘在 ±0.5；`projectionMatrixFromIntrinsics` 的 NDC ±1 恰好落在这四角）。
 * 于是居中主点（`principalPointCentred`）的锥**严格对称**、偏心主点的锥**严格按偏移角歪**——
 * 非对称只来自 K 本身，不掺半像素口径差。`projectToPixel` 往返 ≤1e-9 px，测试钉住。
 *
 * 最薄原则（docs/DEVELOPMENT_PRINCIPLES.md §0）：本模块**无 three 依赖、零状态**——只做
 * 「回执/声明 → 视锥几何／安装偏移」的纯函数；不存相机、不算 FK、不派生第二个 K、不写任何文档/Provider。
 * 坏数据不猜：缺 `intrinsics` 且缺 `fovyDeg` 的条目回 `{ok:false}`，不用默认 FOV 顶替。
 * 数据来源只有三处既有事实（方案 §3）：`camera_list` 回执、场景快照声明、帧 body 位姿。
 *
 * 运行：`bun test packages/viewer/test/camera-frustum.test.ts`
 */
import {
  cameraForward, fovYFromIntrinsics, normalizeIntrinsics, normalizeQuaternion, quaternionFromRotationMatrix, rotateByQuaternion, scaleIntrinsics, ViewerCameraError,
  type ViewerCameraIntrinsics, type ViewerQuat, type ViewerVec3,
} from "./camera-view.ts"

const DEG = Math.PI / 180
/** 显示默认裁剪面（仅显示参数；标定回执另有 near/far 声明时用声明值，见 `nearFarSource`）。 */
export const DISPLAY_DEFAULT_NEAR_M = 0.05
export const DISPLAY_DEFAULT_FAR_M = 10

/** 刚体位姿输入：接受 `quaternionXyzw` 或 `rotationMatrix`（回执两种都有，取一即可）。 */
export interface RigidPoseInput {
  positionM?: unknown
  quaternionXyzw?: unknown
  rotationMatrix?: unknown
}
export interface RigidPose { positionM: ViewerVec3; quaternionXyzw: ViewerQuat }

/** 一台可画的相机（视锥显示的完整输入；全部来自回执/快照，没有本模块自己的状态）。 */
export interface FrustumSpec {
  /** 相机名（`cameraName`，或场景 `entityId/名字`）：显示与拾取的键。 */
  key: string
  /** 声明面：`engine`（原生命名相机）/`scene`（Scene 声明相机）/`named-view`（命名机位）。 */
  source: "engine" | "scene" | "named-view"
  positionM: ViewerVec3
  quaternionXyzw: ViewerQuat
  intrinsics: ViewerCameraIntrinsics
  /** 回执原样（`fovy|mjcf|engine-intrinsics`…）；由 fovy 派生时为 `fovy-derived`。 */
  intrinsicsSource: string
  nearM: number
  farM: number
  /** `declared`＝回执/声明自带裁剪面；`display-default`＝仅显示默认值（不是标定事实）。 */
  nearFarSource: "declared" | "display-default"
  clipPlanesSource?: string
  clipPlanesPerCameraSupported?: boolean
  parentBodyName?: string
  /**
   * 这台相机**所属实体**（相机是挂在 body/link 下的局部物件，挂载要先定归属再查 body）。
   * 回执直接给了就用；没给时按引擎命名约定从 `key` 推导（两台引擎的命名相机名都是 `entityId/局部名`），
   * 推导不出（没有 `/` 前缀）就留空——调用方据此走"必须全局唯一"的保守路径，绝不按名字取第一个匹配。
   */
  entityId?: string
  /** Scene 相机实体与机器人实体不同；挂载 owner 必须采用原生回执的 parentEntityId。 */
  parentEntityId?: string
  /** 原生安装偏移；存在时直接投影，避免把不同读回时刻的世界矩阵重新反解成安装标定。 */
  parentFromCamera?: RigidPose
  referenceFrame?: "world" | "parent"
  override?: boolean
  /** 数据时刻（原则：推算要标注；`camera_list` 回执的 stepIndex/simTime）。 */
  measured?: { stepIndex?: number; simTime?: number; frameId?: string; generation?: number; sceneRevision?: number }
  notes: string[]
}

export type FrustumFromReceipt =
  | { ok: true; spec: FrustumSpec }
  | { ok: false; key: string; unavailable: string }

/** 四棱锥几何（用户验收反馈修正）：near 矩形 + 像平面矩形（标 WxH）+ 顶点→**像平面**四角的棱线 + roll 顶角。
 *  棱线默认**止于像平面**（标准相机 gizmo 形态，锥形长度＝显示焦距），不再延伸成"射到无限远"的长射线；
 *  far/截断只作为数据保留在 `endCorners`/`endM`/`truncated`，除非显式 `extendToFar` 才补画延伸线。 */
export interface FrustumGeometryOptions {
  nearM?: number
  farM?: number
  /** 显示截断长度（米）：仅作用于 `extendToFar` 的延伸线（方案 §9-D1）。 */
  truncationM?: number
  /** 像平面矩形深度＝**显示焦距**（仅显示参数，默认 1 m；锥形四棱止于此）。 */
  imagePlaneM?: number
  /** 可选：补画顶点→far（或截断处）的延伸线（默认 false——用户反馈：射线不应延伸如无限远）。 */
  extendToFar?: boolean
}
export interface FrustumGeometry {
  /** 顺序恒为 TL,TR,BR,BL（v 向下）。 */
  nearCorners: ViewerVec3[]
  imageCorners: ViewerVec3[]
  /** far（或截断处）四角——**数据用**（可拍摄范围之外的深度事实）；默认不画线。 */
  endCorners: ViewerVec3[]
  endM: number
  truncated: boolean
  /** 13 段 × 2 点 × 3 分量 = 78 个数（near 4＋像平面 4＋顶点→像平面棱线 4＋roll 顶角 1）；`extendToFar` 时再加 4 段。 */
  lineVertices: number[]
}

const finiteNumber = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
function vec3Of(value: unknown): ViewerVec3 | undefined {
  return Array.isArray(value) && value.length === 3 && value.every(item => typeof item === "number" && Number.isFinite(item))
    ? [value[0]!, value[1]!, value[2]!] : undefined
}
function quatOf(value: unknown): ViewerQuat | undefined {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(item => typeof item === "number" && Number.isFinite(item))) return undefined
  // 零四元数等退化输入由 normalizeQuaternion 拒绝：这里转成 `undefined`（坏数据不画不猜），不把异常抛给回执解析。
  try { return normalizeQuaternion([value[0]!, value[1]!, value[2]!, value[3]!]) } catch { return undefined }
}
const invalid = (message: string): never => { throw new ViewerCameraError("CAMERA_FRUSTUM_INVALID", message) }

const add3 = (a: ViewerVec3, b: ViewerVec3): ViewerVec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub3 = (a: ViewerVec3, b: ViewerVec3): ViewerVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const scale3 = (a: ViewerVec3, s: number): ViewerVec3 => [a[0] * s, a[1] * s, a[2] * s]
const quatConjugate = (q: ViewerQuat): ViewerQuat => [-q[0], -q[1], -q[2], q[3]]
/** Hamilton 积 `a⊗b`（先转 b 再转 a；`rotateByQuaternion(a, rotateByQuaternion(b, v))` 同义）。 */
const quatMultiply = (a: ViewerQuat, b: ViewerQuat): ViewerQuat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
]

/** 回执/快照里的位姿（`positionM`＋`quaternionXyzw` 或 `rotationMatrix`）→ 刚体位姿；不成立回 `undefined`。 */
export function rigidPoseOf(value: unknown): RigidPose | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const positionM = vec3Of(row.positionM)
  if (!positionM) return undefined
  const quaternionXyzw = quatOf(row.quaternionXyzw)
    ?? (Array.isArray(row.rotationMatrix) ? safeQuaternionFromRotationMatrix(row.rotationMatrix) : undefined)
  if (!quaternionXyzw) return undefined
  return { positionM, quaternionXyzw }
}
function safeQuaternionFromRotationMatrix(value: unknown): ViewerQuat | undefined {
  try { return quaternionFromRotationMatrix(value) } catch { return undefined }
}

/**
 * 安装偏移＝「相机世界位姿 × 挂载点世界位姿⁻¹」——与引擎同一公式的逆
 * （`sim-mujoco/python/worker.py` 的 `_camera_world_pose`：`worldFromCamera = bodyWorld ∘ mountLocal`）。
 * P2 结构化挂载把结果写成 body 节点子级的局部变换；P3 拖拽写回 `camera_adjust` 的 `parent` 参考系也用它。
 */
export function mountLocalFrom(worldFromCamera: RigidPoseInput, bodyWorld: RigidPoseInput): RigidPose {
  const cam = rigidPoseOf(worldFromCamera) ?? invalid("worldFromCamera 缺 positionM 或旋转（quaternionXyzw/rotationMatrix）")
  const body = rigidPoseOf(bodyWorld) ?? invalid("bodyWorld 缺 positionM 或旋转（quaternionXyzw/rotationMatrix）")
  const q = quatMultiply(quatConjugate(body.quaternionXyzw), cam.quaternionXyzw)
  const t = rotateByQuaternion(quatConjugate(body.quaternionXyzw), sub3(cam.positionM, body.positionM))
  return { positionM: t, quaternionXyzw: normalizeQuaternion(q) }
}

/** 像素 (u,v) 相机系反投影（合同 `depthSemantics` 同式；`projectToPixel` 的逆）。 */
export function pixelToCameraPoint(k: ViewerCameraIntrinsics, u: number, v: number, depthM: number): ViewerVec3 {
  return [(u - k.cx) * depthM / k.fx, -(v - k.cy) * depthM / k.fy, -depthM]
}

/**
 * 四棱台 4 角（相机系，顺序 TL,TR,BR,BL；角点取像素网格真实边缘 `u∈{−0.5,W−0.5}`、`v∈{−0.5,H−0.5}`）。
 * 非方形像素、偏心主点的 K 会自然得到**非对称锥**——这是预期结果，不掰成 fov+aspect 的对称锥。
 */
export function frustumCorners(k: ViewerCameraIntrinsics, depthM: number): ViewerVec3[] {
  if (!(depthM > 0) || !Number.isFinite(depthM)) invalid(`depthM 必须是正有限数（收到 ${String(depthM)}）`)
  return [
    pixelToCameraPoint(k, -0.5, -0.5, depthM),
    pixelToCameraPoint(k, k.width - 0.5, -0.5, depthM),
    pixelToCameraPoint(k, k.width - 0.5, k.height - 0.5, depthM),
    pixelToCameraPoint(k, -0.5, k.height - 0.5, depthM),
  ]
}

/** fovy 路径（无 K 的老相机/Isaac fovy-only 行）：与 worker 同式 `fx=fy=H/(2·tan(fovy/2))`、主点在 `((W−1)/2,(H−1)/2)`。 */
export function intrinsicsFromFovy(fovyDeg: unknown, width = 640, height = 480): ViewerCameraIntrinsics {
  const fovy = finiteNumber(fovyDeg)
  if (fovy === undefined || !(fovy > 0 && fovy < 180)) return invalid(`fovyDeg 必须是 (0,180) 内的有限数（收到 ${String(fovyDeg)}）`)
  const f = height / (2 * Math.tan(fovy * DEG / 2))
  return normalizeIntrinsics({ fx: f, fy: f, cx: (width - 1) / 2, cy: (height - 1) / 2, width, height })
}

/**
 * 视锥线框几何：near 矩形＋像平面矩形＋顶点→end 的 4 条棱线（共 12 段）。
 * `endM = min(farM, truncationM)`；`truncated` 如实标注"显示截断"，`farM` 本身仍是声明/默认事实。
 */
export function frustumGeometry(k: ViewerCameraIntrinsics, options: FrustumGeometryOptions = {}): FrustumGeometry {
  const nearM = options.nearM ?? DISPLAY_DEFAULT_NEAR_M
  const farM = options.farM ?? DISPLAY_DEFAULT_FAR_M
  if (!(nearM > 0) || !(farM > nearM)) invalid(`nearM/farM 不合法（near=${String(nearM)}，far=${String(farM)}）：需要 0 < near < far`)
  const endM = options.truncationM !== undefined ? Math.min(farM, options.truncationM) : farM
  if (!(endM > nearM)) invalid(`truncationM 必须大于 nearM（end=${String(endM)}，near=${String(nearM)}）`)
  const imagePlaneM = Math.min(Math.max(options.imagePlaneM ?? 1, nearM * 2), endM)
  const nearCorners = frustumCorners(k, nearM)
  const imageCorners = frustumCorners(k, imagePlaneM)
  const endCorners = frustumCorners(k, endM)
  const apex: ViewerVec3 = [0, 0, 0]
  const segments: Array<[ViewerVec3, ViewerVec3]> = []
  const rect = (corners: ViewerVec3[]): void => {
    for (let i = 0; i < 4; i++) segments.push([corners[i]!, corners[(i + 1) % 4]!])
  }
  rect(nearCorners)
  rect(imageCorners)
  // 棱线止于**像平面**（四棱锥形态；用户验收反馈：不应延伸如无限远）。extendToFar 才补画到 far/截断处。
  for (const corner of imageCorners) segments.push([apex, corner])
  if (options.extendToFar) for (let i = 0; i < 4; i++) segments.push([imageCorners[i]!, endCorners[i]!])
  // roll 顶角（方案 §5）：near 矩形上边中点沿相机 +Y 伸一小截——照片有 roll 时这条"天线"立刻看得出来。
  const tickBase: ViewerVec3 = [(nearCorners[0]![0] + nearCorners[1]![0]) / 2, (nearCorners[0]![1] + nearCorners[1]![1]) / 2, -nearM]
  const tickLength = Math.abs(nearCorners[0]![1]) * 0.5
  segments.push([tickBase, [tickBase[0], tickBase[1] + tickLength, tickBase[2]]])
  const lineVertices = segments.flatMap(([a, b]) => [...a, ...b])
  return { nearCorners, imageCorners, endCorners, endM, truncated: endM < farM, lineVertices }
}

/**
 * S3（判据 4）拖拽结果 → `camera_adjust` 提交参数。参考系按方案 §9-D2 的通用语义（USD manipulator）：
 * 挂载相机（`parentBodyName` 在场）提交**局部安装位姿**（`parent`，随 FK）；自由相机提交世界位姿（`world`，钉住）。
 * 本函数只做这一判定；写回本身走 Shell 侧既有 `camera_adjust_ui`（过期 `expectedGeneration` 由 Provider 明确拒）。
 */
export function cameraAdjustFromDrag(cameraName: string, parentBodyName: string | undefined, edit: { worldPose: RigidPose; localPose: RigidPose; intrinsics?: ViewerCameraIntrinsics }):
  { cameraName: string; referenceFrame: "world" | "parent"; positionM: ViewerVec3; quaternionXyzw: ViewerQuat; fovyDeg?: number } {
  const referenceFrame = parentBodyName ? "parent" : "world"
  const pose = referenceFrame === "parent" ? edit.localPose : edit.worldPose
  return { cameraName, referenceFrame, positionM: pose.positionM, quaternionXyzw: pose.quaternionXyzw,
    ...(edit.intrinsics === undefined ? {} : { fovyDeg: fovYFromIntrinsics(normalizeIntrinsics(edit.intrinsics)) }) }
}

/**
 * S4（方案 §2 第 2 条的摄影口径 ↔ 像素 K）：USD/Isaac 镜头字段 → 内参。公式与
 * `sim-isaac/python/worker.py:1039` 的回读**逐字同式**：`fx = focal/hAp·W`、`cx = (W−1)/2 − hOffset/hAp·W`
 * （USD 的 aperture offset 符号与 CV 相反，这里照 USD 口径收）。UI 侧（Isaac Camera Inspector 风格的
 * 焦距/传感器输入框）与读数换算都走这一份，不另立第二套换算。
 */
export function intrinsicsFromLens(lens: { focalLength: number; horizontalAperture: number; verticalAperture: number; horizontalApertureOffset?: number; verticalApertureOffset?: number; width: number; height: number }): ViewerCameraIntrinsics {
  const f = finiteNumber(lens.focalLength), hAp = finiteNumber(lens.horizontalAperture), vAp = finiteNumber(lens.verticalAperture)
  const hOff = finiteNumber(lens.horizontalApertureOffset) ?? 0, vOff = finiteNumber(lens.verticalApertureOffset) ?? 0
  if (f === undefined || !(f > 0) || hAp === undefined || !(hAp > 0) || vAp === undefined || !(vAp > 0)) return invalid("lens 的 focalLength/aperture 必须是正有限数")
  return normalizeIntrinsics({
    fx: f / hAp * lens.width,
    fy: f / vAp * lens.height,
    cx: (lens.width - 1) / 2 - hOff / hAp * lens.width,
    cy: (lens.height - 1) / 2 + vOff / vAp * lens.height,
    width: lens.width, height: lens.height,
  })
}

/**
 * S4 摄影口径 → fovy（供 `camera_adjust` 的 `fovyDeg` 提交）：给焦距＋传感器宽（mm），竖直光圈按**当前 K 的
 * fx/fy 比**推出（`vAp = hAp·(H/fy)/(W/fx)`），于是换镜头只改整体焦距尺度、非方形像素比例不被掰平——
 * 与 `camera_adjust` 的 `intrinsic-focal-rescale` 语义同向。fx=fy 的相机满足精确往返：
 * `fovyFromLens(K, fx/W·hAp, hAp) === fovYFromIntrinsics(K)`（测试钉住）。
 */
export function fovyFromLens(intrinsics: ViewerCameraIntrinsics, focalLength: number, horizontalAperture: number): number {
  const verticalAperture = horizontalAperture * (intrinsics.height / intrinsics.fy) / (intrinsics.width / intrinsics.fx)
  const k = intrinsicsFromLens({ focalLength, horizontalAperture, verticalAperture, width: intrinsics.width, height: intrinsics.height })
  return fovYFromIntrinsics(k)
}

export interface CaptureGateRect { left: number; top: number; width: number; height: number }
/**
 * 图像像素 → 画布像素：`applyViewToCamera`/`resizeCanvas` 写进相机的那份 `scaleIntrinsics` 的**逐像素写法**
 * （`sx = canvasW/k.width`，`u_c = sx·(u+0.5) − 0.5`，v 同理）。半像素口径下图像边缘 `u∈{−0.5,W−0.5}`
 * 恰好落在画布边缘。取景框必须与投影共用这一份映射，否则"线框"与"实际拍到的范围"各说各话。
 */
export function imagePixelToCanvasPixel(k: ViewerCameraIntrinsics, u: number, v: number, canvasW: number, canvasH: number): [number, number] {
  const scaled = scaleIntrinsics(k, canvasW, canvasH)
  return [scaled.cx + scaled.fx * (u - k.cx) / k.fx, scaled.cy + scaled.fy * (v - k.cy) / k.fy]
}
/**
 * 取景框（gate）＝相机**实际可拍摄范围**在画布上的矩形，由"图像四条边缘 → 画布"的同一份映射算出
 * （`imagePixelToCanvasPixel`），不是另写一套宽高比内接算法。
 *
 * 为什么不再是"按 WxH 宽高比居中内接"：Viewer 的"透过该相机看"用的是 `scaleIntrinsics` 的**各向异性**
 * 缩放（fx/fy 各按画布宽/高缩放，fovX/fovY 与主点占比不变），整幅照片因此恰好铺满整个画布。
 * 画布宽高比与照片不同的那部分仍然在这台相机的投影里——内接矩形之外的"线外拍不进"是假的。
 * 所以这里给出的是**整块画布**；哪天缩放口径改成 letterbox 之类，同一份映射会立刻给出更小的框，
 * 不会出现"线框说裁掉、投影却没裁"的分歧。偏心主点、fx≠fy、非 4:3、DPR 与 resize 都由映射本身覆盖。
 */
export function captureGateRect(k: ViewerCameraIntrinsics, canvasW: number, canvasH: number): CaptureGateRect {
  if (![canvasW, canvasH].every(n => Number.isFinite(n) && n > 0)) invalid("captureGateRect 需要正有限的画布尺寸")
  const corners: Array<[number, number]> = [
    imagePixelToCanvasPixel(k, -0.5, -0.5, canvasW, canvasH),
    imagePixelToCanvasPixel(k, k.width - 0.5, -0.5, canvasW, canvasH),
    imagePixelToCanvasPixel(k, k.width - 0.5, k.height - 0.5, canvasW, canvasH),
    imagePixelToCanvasPixel(k, -0.5, k.height - 0.5, canvasW, canvasH),
  ]
  const xs = corners.map(corner => corner[0]), ys = corners.map(corner => corner[1])
  const left = Math.min(...xs), top = Math.min(...ys)
  // 半像素换算：映射给的是**像素中心口径**下的边缘（图像左边缘在 u=−0.5），画布上要画的盒子边界在 0；
  // 换算是统一平移，不改变宽高，也不掩盖"盒子外面还有没有投影"这件事（那由上面的角点决定）。
  return { left: left + 0.5, top: top + 0.5, width: Math.max(...xs) - left, height: Math.max(...ys) - top }
}
/**
 * 取景框说明文字：分辨率＋**真实垂直 FOV**（由实际内参算出——锥形与取景框同一份 K）＋这一层的实际口径
 * "视口即整幅照片"。画布与照片宽高比不同时补一句：像素被各向异性拉伸是那份缩放契约的既定行为，
 * 写出来比让人以为"线内才是照片"或"线外还能拍"都强。`canvas` 省略时只给与画布无关的部分。
 */
export function captureGateLabel(k: ViewerCameraIntrinsics, canvas?: { width: number; height: number }): string {
  const stretched = canvas !== undefined && Math.abs(canvas.width / canvas.height - k.width / k.height) > 1e-3
  return `${k.width}×${k.height} · 垂直FOV ${fovYFromIntrinsics(k).toFixed(1)}° · 视口即整幅照片${stretched ? "（画布宽高比≠照片：像素被各向异性拉伸）" : ""}`
}

/**
 * S2.5 Pilot（方案 §9-D5 的通用交互）：视锥 → 视口相机请求。
 * `lens:true`＝透过该相机看（位姿＋K 全套）；`lens:false`＝对齐机位（只给位姿，投影沿用当前——
 * `normalizeCameraRequest` 的部分更新语义）。`focusDistanceM` 只决定转心落点（沿视线向前），不改变成像。
 */
export function cameraRequestFromRig(spec: FrustumSpec, focusDistanceM: number, options: { lens?: boolean } = {}):
  { position: ViewerVec3; quaternion: ViewerQuat; target: ViewerVec3; intrinsics?: ViewerCameraIntrinsics } {
  const distance = Number.isFinite(focusDistanceM) && focusDistanceM > 0 ? focusDistanceM : 1
  const forward = cameraForward(spec.quaternionXyzw)
  const target = spec.positionM.map((v, i) => v + forward[i]! * distance) as ViewerVec3
  return { position: spec.positionM, quaternion: spec.quaternionXyzw, target, ...options.lens ? { intrinsics: spec.intrinsics } : {} }
}

/**
 * `camera_list` 回执行 → 可画视锥。坏数据不画不猜（原则 2）：
 * 缺 K 且缺 fovy ⇒ `{ok:false, unavailable}`；fovy-only ⇒ 按 fovy 路径派生并标 `intrinsicsSource='fovy-derived'`。
 */
export function frustumFromReceipt(row: unknown, options: { source?: FrustumSpec["source"] } = {}): FrustumFromReceipt {
  const record = row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : undefined
  const key = typeof record?.cameraName === "string" && record.cameraName ? record.cameraName : ""
  if (!record || !key) return { ok: false, key: key || "(unnamed)", unavailable: "缺 cameraName：无法归属这台相机的回执行" }
  const pose = rigidPoseOf(record.worldFromCamera)
  if (!pose) return { ok: false, key, unavailable: "worldFromCamera 缺 positionM 或旋转：不猜位姿、不画锥" }
  const notes: string[] = []
  let intrinsics: ViewerCameraIntrinsics | undefined
  let intrinsicsSource = typeof record.intrinsicsSource === "string" ? record.intrinsicsSource : ""
  if (record.intrinsics !== undefined) {
    try { intrinsics = normalizeIntrinsics(record.intrinsics, `${key}.intrinsics`) }
    catch (error) { return { ok: false, key, unavailable: `intrinsics 不合法（${String(error)}）：不猜 K、不画锥` } }
    if (!intrinsicsSource) intrinsicsSource = "receipt-intrinsics"
  } else {
    const width = finiteNumber(record.width), height = finiteNumber(record.height)
    try {
      intrinsics = intrinsicsFromFovy(record.fovyDeg, width === undefined ? undefined : Math.trunc(width), height === undefined ? undefined : Math.trunc(height))
      intrinsicsSource = "fovy-derived"
      notes.push("回执行没有像素 K：按 fovy 派生（fx=fy=H/(2·tan(fovy/2))、主点在画面中心）；非方形像素/偏心主点无从得知。")
    } catch {
      return { ok: false, key, unavailable: "缺 intrinsics 且缺 fovyDeg：不猜默认 FOV、不画锥" }
    }
  }
  const declaredNear = finiteNumber(record.nearM), declaredFar = finiteNumber(record.farM)
  const nearFarDeclared = declaredNear !== undefined && declaredFar !== undefined && declaredNear > 0 && declaredFar > declaredNear
  if (!nearFarDeclared) notes.push("回执行没有可用 near/far：显示用默认裁剪面（仅显示参数，不是标定事实）。")
  const measuredStep = finiteNumber(record.stepIndex), measuredTime = finiteNumber(record.simTime)
  const referenceFrame = record.referenceFrame === "parent" ? "parent" : record.referenceFrame === "world" ? "world" : undefined
  // 归属实体：回执的 entityId 优先，其次按命名约定取 `cameraName` 的实体前缀（两台引擎都这么命名相机）。
  const declaredEntity = typeof record.entityId === "string" && record.entityId ? record.entityId : undefined
  const prefixEntity = key.includes("/") ? key.slice(0, key.indexOf("/")) : undefined
  return {
    ok: true,
    spec: {
      key,
      source: options.source ?? "engine",
      positionM: pose.positionM,
      quaternionXyzw: pose.quaternionXyzw,
      intrinsics,
      intrinsicsSource,
      nearM: nearFarDeclared ? declaredNear! : DISPLAY_DEFAULT_NEAR_M,
      farM: nearFarDeclared ? declaredFar! : DISPLAY_DEFAULT_FAR_M,
      nearFarSource: nearFarDeclared ? "declared" : "display-default",
      ...typeof record.clipPlanesSource === "string" ? { clipPlanesSource: record.clipPlanesSource } : {},
      ...typeof record.clipPlanesPerCameraSupported === "boolean" ? { clipPlanesPerCameraSupported: record.clipPlanesPerCameraSupported } : {},
      ...((declaredEntity ?? prefixEntity) ? { entityId: declaredEntity ?? prefixEntity } : {}),
      ...typeof record.parentEntityId === "string" && record.parentEntityId ? { parentEntityId: record.parentEntityId } : {},
      ...rigidPoseOf(record.parentFromCamera) ? { parentFromCamera: rigidPoseOf(record.parentFromCamera)! } : {},
      ...typeof record.parentBodyName === "string" && record.parentBodyName ? { parentBodyName: record.parentBodyName } : {},
      ...referenceFrame ? { referenceFrame } : {},
      ...typeof record.override === "boolean" ? { override: record.override } : {},
      ...measuredStep !== undefined || measuredTime !== undefined || typeof record.frameId === "string"
        ? { measured: { ...measuredStep === undefined ? {} : { stepIndex: measuredStep }, ...measuredTime === undefined ? {} : { simTime: measuredTime },
          ...typeof record.frameId === "string" ? { frameId: record.frameId } : {},
          ...finiteNumber(record.generation) === undefined ? {} : { generation: record.generation as number },
          ...finiteNumber(record.sceneRevision) === undefined ? {} : { sceneRevision: record.sceneRevision as number } } } : {},
      notes,
    },
  }
}
