/**
 * 前端侧的"应用相机 / 按指定相机采集"：模型经 `viewer_camera_apply`、`viewer_render_camera`
 * （或在 `viewer_observe` 里带 `camera`）要求把它正在看的那个窗口摆到一台**指定相机**上。
 *
 * 为什么单独一个模块：判定必须在**真实前端**与**定向测试的前端替身**里是同一份代码（与 `workbench-observe.ts`
 * 同一个理由）。相机数学一个字都不在这里——位姿/内参/roll 的换算、投影矩阵与"应用后当场核对"都在
 * `packages/viewer/src/camera-view.ts`；这一层只回答三件事：
 *   · 这个窗口里的 Viewer 到底支不支持相机接口（不支持就明确失败，不假装应用过）；
 *   · 窗口显示的是不是被请求的那个场景/版本（与采集**同一份**判据）；
 *   · 应用完了把**量到的**读数、以及命名相机的存取交回去。
 *
 * 命名相机存在**场景文档**里（`entity.components.viewerCamera`），不在这个模块、也不在 localStorage：
 * 它是"用户在这个场景里存下来的机位"，要能随工程移动、被另一个窗口/客户端读到、跟着版本历史回退。
 * 格式与校验的 owner 是 `packages/viewer/src/camera-view.ts`（`namedCamerasOfScene` / `withNamedCamera` /
 * `composeViewerCameraComponent`）；本模块只做两件事：
 *   · **读**进来由调用方从场景快照里取（`CameraTargetInput.namedCameras`），本模块不自己找地方存；
 *   · **写**出去由调用方经 `saveNamedCameras` 端口做（产品原生命令 `scene_edit` + CAS）：
 *     写成功了回执里才出现 `savedAs`，写失败就是失败（不返回假成功）。
 */
import type { ViewerViewState } from "@lyapunov/viewer/client"
import type { Entity, SceneCameraComponent, SceneCommit, SceneSnapshot } from "../../lyapunov-contracts/src/types.ts"
import { intrinsicsFromFovy, mountLocalFrom, rigidPoseOf, type RigidPose } from "../../viewer/src/camera-frustum.ts"
import { cameraForward, cameraRequestFromState, cameraUpAxis, MAX_CAMERA_NAME, normalizeIntrinsics, scaleIntrinsics, type NamedCamera, type ViewerCameraRequest, type ViewerQuat } from "../../viewer/src/camera-view.ts"
/**
 * 命名相机的**格式面**原样再导出给界面用：界面（`workbench.tsx`）与工具（本模块）读写的是同一份
 * 解析/合成/增删函数，于是"界面存的"和"工具读的"不可能是两种形状。这里只是转口，不二次加工。
 */
export { composeViewerCameraComponent, namedCamerasOfScene, VIEWER_CAMERA_COMPONENT, withNamedCamera, withoutNamedCamera, type NamedCamera, type ViewerCameraComponent } from "../../viewer/src/camera-view.ts"
import { withNamedCamera } from "../../viewer/src/camera-view.ts"
import { captureForObserver, requireDisplayedScene, type ObserveLoadState, type ObserveShot, type ObservableViewer } from "./workbench-observe.ts"

/** camera_list 原生 body 读回，供明确选择挂载目标；不是模型名字预设表。 */
export interface CameraMountBody { entityId: string; bodyName: string; bodyPath?: string; worldFromBody?: RigidPose; frameId?: string; stepIndex?: number }
export interface SceneCameraDraft { name: string; position: string; quaternion: string; fovYDeg: string; width: string; height: string; near: string; far: string; parentEntityId: string; bodyName: string; intrinsics?: import('../../viewer/src/camera-view.ts').ViewerCameraIntrinsics }
export function sceneCamerasOfScene(entities: readonly Entity[] | undefined): Array<{ entity: Entity; component: SceneCameraComponent }> {
  return (entities ?? []).flatMap(entity => {
    const camera = entity.components.camera
    return camera && typeof camera === "object" && !Array.isArray(camera) ? [{ entity, component: camera as SceneCameraComponent }] : []
  })
}
export function cameraMountBodies(receipt: unknown, entities: readonly Entity[]): CameraMountBody[] {
  const rows = (receipt as { bodies?: unknown } | undefined)?.bodies
  if (!Array.isArray(rows)) return []
  return rows.flatMap(row => typeof row?.entityId === "string" && typeof row?.bodyName === "string" && row.bodyName && entities.some(entity => entity.entityId === row.entityId)
    ? [{ entityId: row.entityId, bodyName: row.bodyName, ...typeof row.bodyPath === "string" ? { bodyPath: row.bodyPath } : {},
      ...rigidPoseOf(row.worldFromBody) ? { worldFromBody: rigidPoseOf(row.worldFromBody)! } : {},
      ...typeof row.frameId === "string" ? { frameId: row.frameId } : {}, ...typeof row.stepIndex === "number" ? { stepIndex: row.stepIndex } : {} }] : [])
}
export function sceneCameraDraftOf(entity?: Entity): SceneCameraDraft {
  const component = entity?.components.camera as SceneCameraComponent | undefined, mount = component?.mount
  return { name: component?.name ?? entity?.name ?? "相机", position: (mount?.positionM ?? entity?.transform.position ?? [0, 0, 1]).join(" "),
    quaternion: (mount?.quaternionXyzw ?? entity?.transform.quaternion ?? [0, 0, 0, 1]).join(" "), fovYDeg: String(component?.fovYDeg ?? 50),
    width: String(component?.width ?? component?.intrinsics?.width ?? 640), height: String(component?.height ?? component?.intrinsics?.height ?? 480),
    near: String(component?.near ?? 0.01), far: String(component?.far ?? 100), parentEntityId: mount?.entityId ?? "", bodyName: mount?.bodyName ?? "", ...(component?.intrinsics?{intrinsics:component.intrinsics}:{}) }
}
/** 名称只用于给真实 body 加可读标签；不能由标签生成不存在的挂载点。 */
export function cameraMountLabel(bodyName: string): { zh: string; en: string; priority: number } {
  const name = bodyName.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()
  const token = (words: string) => new RegExp(`(^|[/_.\\s-])(${words})([/_.\\s-]|$)`).test(name)
  const side = token("left|l") ? ["左", "Left "] : token("right|r") ? ["右", "Right "] : ["", ""]
  if (token("head|skull|helmet") || name.includes("头")) return { zh: "头部", en: "Head", priority: 0 }
  if (token("wrist") || name.includes("腕")) return { zh: `${side[0]}手腕`, en: `${side[1]}wrist`, priority: 1 }
  if (token("hand|palm|gripper") || /手|夹爪/.test(name)) return { zh: `${side[0]}手部 / 夹爪`, en: `${side[1]}hand / gripper`, priority: 2 }
  if (token("tool|tcp|ee|end_effector")) return { zh: "末端工具", en: "End tool", priority: 3 }
  if (token("neck")) return { zh: "颈部", en: "Neck", priority: 4 }
  if (token("torso|chest|trunk")) return { zh: "躯干", en: "Torso", priority: 5 }
  if (token("base|pelvis|chassis")) return { zh: "基座 / 底盘", en: "Base / chassis", priority: 6 }
  return { zh: "连杆", en: "Link", priority: 7 }
}
/** 推荐只来自当前实例、唯一名称与真实 body 位姿。没有头/腕时仍列实际连杆。 */
export function recommendedCameraMount(bodies: readonly CameraMountBody[], entityId: string): CameraMountBody | undefined {
  const scoped = bodies.filter(body => body.entityId === entityId)
  return scoped.filter(body => body.worldFromBody && scoped.filter(row => row.bodyName === body.bodyName).length === 1)
    .sort((a, b) => cameraMountLabel(a.bodyName).priority - cameraMountLabel(b.bodyName).priority)[0]
}
/** 挂载当前完整机位，不能把它吸到body原点；此低层函数要求调用方保证同帧。 */
export function sceneCameraDraftAtBody(entity: Entity, bodies: readonly CameraMountBody[], bodyName: string, view?: ViewerViewState): SceneCameraDraft {
  const matches = bodies.filter(body => body.entityId === entity.entityId && body.bodyName === bodyName)
  if (matches.length !== 1 || !matches[0]!.worldFromBody) throw new Error("CAMERA_MOUNT_POSE_REQUIRED: 挂载连杆缺少当前唯一原生位姿")
  const worldFromBody = matches[0]!.worldFromBody!
  if(!view)throw new Error('CAMERA_VIEW_REQUIRED: 挂载当前画面需要Viewer真实位姿，未创建body原点替代')
  const pose = mountLocalFrom({ positionM: view.position, quaternionXyzw: view.quaternion }, worldFromBody)
  const draft = sceneCameraDraftOf(), label = cameraMountLabel(bodyName)
  return { ...draft, name: `${entity.name || "机器人"} · ${label.zh}相机`.replaceAll("/", "·").slice(0, MAX_CAMERA_NAME),
    parentEntityId: entity.entityId, bodyName, position: pose.positionM.join(" "), quaternion: pose.quaternionXyzw.join(" "),
    fovYDeg: view.fovDeg !== undefined ? String(view.fovDeg) : draft.fovYDeg, near:String(view.near??draft.near),far:String(view.far??draft.far),...(view.intrinsics?{intrinsics:view.intrinsics,width:String(view.intrinsics.width),height:String(view.intrinsics.height)}:{}) }
}
const cameraNumbers = (text: string, size: number): number[] => {
  const values = text.trim().split(/[\s,]+/).filter(Boolean).map(Number)
  if (values.length !== size || values.some(value => !Number.isFinite(value))) throw new Error(`相机位姿须提供 ${size} 个有限数值`)
  return values
}
/** 改尺寸/FOV沿原镜头缩放，保fx/fy比例和主点，不重建为中心方形像素。 */
export function normalizeDraftLens(draft: SceneCameraDraft, width: number, height: number, fovYDeg: number) {
  if(!draft.intrinsics)return undefined
  const scaled=scaleIntrinsics(normalizeIntrinsics(draft.intrinsics),width,height)
  const fy=height/(2*Math.tan(fovYDeg*Math.PI/360)),ratio=fy/scaled.fy
  return {...scaled,fx:scaled.fx*ratio,fy}
}
/** UI 与自然语言均可提交同一 Scene 相机声明；SceneStore 的 CAS 决定是否真正保存成功。 */
export function sceneCameraCommit(scene: SceneSnapshot, draft: SceneCameraDraft, bodies: readonly CameraMountBody[], entityId: string): SceneCommit {
  const name = draft.name.trim()
  if (!name || name.length > MAX_CAMERA_NAME || name.includes("/")) throw new Error("相机名称不能为空、包含 / 或超出长度限制")
  const positionM = cameraNumbers(draft.position, 3) as [number, number, number]
  const quaternionXyzw = cameraNumbers(draft.quaternion, 4) as [number, number, number, number]
  const pose = rigidPoseOf({ positionM, quaternionXyzw })
  if (!pose) throw new Error("相机四元数必须为非零 xyzw")
  const fovYDeg = Number(draft.fovYDeg), width = Number(draft.width), height = Number(draft.height), near = Number(draft.near), far = Number(draft.far)
  if (!(fovYDeg > 0 && fovYDeg < 180) || !Number.isFinite(fovYDeg)) throw new Error("竖直 FOV 必须在 0 至 180 度之间")
  if (![width, height].every(value => Number.isInteger(value) && value >= 16 && value <= 4096)) throw new Error("相机宽高必须为 16 至 4096 的整数像素")
  if (!(near > 0 && far > near) || !Number.isFinite(far)) throw new Error("裁剪面须满足 0 < near < far，单位为米")
  const explicitK=draft.intrinsics?normalizeDraftLens(draft,width,height,fovYDeg):undefined
  const component: SceneCameraComponent = { name, fovYDeg, width, height, near, far, intrinsics: explicitK??intrinsicsFromFovy(fovYDeg, width, height), isActive: true }
  if (draft.parentEntityId) {
    if (!scene.entities.some(entity => entity.entityId === draft.parentEntityId)) throw new Error("挂载实体不属于当前场景")
    const targets = bodies.filter(body => body.entityId === draft.parentEntityId && body.bodyName === draft.bodyName)
    if (targets.length !== 1) throw new Error(targets.length ? "挂载 body 名不唯一，请选择实际唯一的连杆" : "目标 body 尚无当前原生读回，请先同步世界")
    component.mount = { entityId: draft.parentEntityId, bodyName: draft.bodyName, ...pose }
  }
  const current = scene.entities.find(entity => entity.entityId === entityId)
  // 有明确 mount 时实体 TRS 不参与原生安装。保留原有 TRS，防止编辑局部标定时悄悄改变世界摆放。
  const transform = component.mount ? current?.transform ?? { position: [0, 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] }
    : { position: pose.positionM, quaternion: pose.quaternionXyzw, scale: [1, 1, 1] as [number, number, number] }
  return { sceneId: scene.sceneId, expectedRevision: scene.revision, patch: current
    ? [{ op: "update", entityId, changes: { name, transform, components: { ...current.components, camera: component } } }]
    : [{ op: "add", entity: { entityId, name, transform, resources: [], components: { camera: component } } }] }
}

/** 相机相关的界面动作名（与宿主 `plugin.ts` 里排队的那几个一字对应）。 */
export const CAMERA_ACTIONS = ["applyCameraViewer", "renderCameraViewer"] as const

/** 依赖相机接口的那几个方法在调用点上确实存在（不支持时给出同一个明确失败）。 */
interface CameraViewer extends ObservableViewer {
  applyCameraView(request: unknown): unknown
  cameraView(): unknown
  renderCameraImage(request: unknown): ObserveShot
  getViewState(): ViewerViewState
  setViewState(state: ViewerViewState): void
}
/**
 * 取"能应用相机的 Viewer"，缺一个就整条失败。
 *
 * 为什么不让缺的方法静默降级（例如没 `renderCameraImage` 就用画布截图凑）：那会让"按照片 K 出的图"
 * 变成一张尺寸/内参都不对的图，而模型拿到的是同一个工具的成功回执——这条路径的全部意义就是可比对。
 */
function requireCameraViewer(input: { viewerVisible: boolean; viewer?: ObservableViewer }): CameraViewer {
  if (!input.viewerVisible || !input.viewer) throw new Error("VIEWER_CAMERA_VIEWER_UNAVAILABLE: 目标窗口的 3D 视口当前不可用（Viewer 已关闭或未挂载），没有可以摆相机的画面。")
  const viewer = input.viewer as CameraViewer
  const missing = (["applyCameraView", "cameraView", "renderCameraImage", "getViewState", "setViewState"] as const).filter(name => typeof viewer[name] !== "function")
  if (missing.length) throw new Error(`VIEWER_CAMERA_UNSUPPORTED: 目标窗口里的 Viewer 不支持相机接口（缺 ${missing.join("、")}）：这个窗口跑的不是带相机能力的原生 Viewer（旧版本或别的实现），所以没有应用任何相机，也没有出图。`)
  return viewer
}

// ── 命名相机（场景文档里的一条组件） ──────────────────────────────────────────
/**
 * 命名相机表 → 一台相机的应用请求（恢复用它）。映射本身在 `camera-view.ts` 的 `cameraRequestFromState`
 * （`setViewState` 画布内恢复与这里出图/应用两条路用**同一份**映射，一改两边一起改）。
 */
export const requestOfCameraState = (state: ViewerViewState): ViewerCameraRequest => cameraRequestFromState(state)
/**
 * 名字 → 这台相机（名字是它在**场景文档**里的 key）。
 *
 * 找不到时不编一个"最近的一台"顶上：报明确的错并列出文档里现有的名字，模型/用户下一句就能改对。
 */
export function findNamedCamera(cameras: readonly NamedCamera[], name: string): NamedCamera | undefined {
  return cameras.find(row => row.name === name.trim())
}

export interface CameraTargetInput {
  clientId: string
  viewerVisible: boolean
  viewer?: ObservableViewer
  displayed?: { sceneId?: string; revision?: number }
  /** 被请求的场景与版本：与采集同一份判据（只有目标窗口正显示着这一版才动手）。 */
  sceneId: string
  expectedRevision: number
  /** 相机请求：`camera_fit` 的块（worldFromCamera + viewer）或显式 position/quaternion/target/up/fov/intrinsics。 */
  request?: unknown
  /** 用这个场景文档里存过的**命名相机**（与 `request` 二选一）。 */
  name?: string
  /** 应用成功后再存成命名相机（覆盖同名）：**写进场景文档**，写失败就报错，不回成功。 */
  saveAs?: string
  /**
   * 这个场景**文档里现有的**命名相机（由调用方从场景快照读出来：`namedCamerasOfScene(scene.entities).cameras`）。
   *
   * 为什么从外面传进来：本模块不该自己去哪儿找状态——命名相机的唯一正本是场景文档，读它的人（界面/工具）
   * 手上就有快照；模块里再存一份（曾经是 localStorage）必然与文档漂移。
   */
  namedCameras?: readonly NamedCamera[]
  /**
   * 把整张命名相机表写进场景文档的**端口**（由调用方用产品原生命令实现：`scene_edit` + CAS）。
   *
   * 为什么是端口而不是在这里直接写：写文档要会话、要当前 rev、要过只读/官方场景的守卫，这些都在调用方
   * 手上（`workbench.tsx` 的 `writeNamedCameras`）。本模块只保证一件事：`saveAs` 时**先写成功再回 `savedAs`**，
   * 写失败（拒绝/过期/只读）整条抛错——不会出现"回执说存好了、文档里没有"。
   */
  saveNamedCameras?: (cameras: NamedCamera[]) => Promise<void>
}
export interface CameraApplyReceipt {
  /** 应用后**当场测量**的相机读数（不是"请求了什么"）。 */
  camera: unknown
  /** 应用后的完整可恢复状态（位置/姿态/相机 up/视场/裁剪面/内参）。 */
  state: ViewerViewState
  /**
   * 这次应用所归属的场景与版本（核对通过后填的是**请求的**那一版，因为核对就是"显示的就是这一版"）。
   * 服务端用它跑与采集**同一份**归属判据（会话 + 窗口 + 场景 + 版本），不在回报里假装成另一版。
   */
  sceneId: string
  sceneRevision: number
  usedName?: string
  savedAs?: string
  savedNames?: string[]
}
function resolveRequest(input: CameraTargetInput): { request: unknown; usedName?: string } {
  if (input.name === undefined && input.request === undefined) throw new Error("VIEWER_CAMERA_REQUEST_REQUIRED: 既没有给相机（camera/position/quaternion/target/up/fovYDeg/intrinsics），也没有给命名相机（name）。")
  if (input.name === undefined) return { request: input.request }
  const saved = findNamedCamera(input.namedCameras ?? [], input.name)
  if (!saved) {
    const names = (input.namedCameras ?? []).map(row => row.name)
    throw new Error(`VIEWER_CAMERA_NAME_UNKNOWN: 场景 ${input.sceneId} 的文档里没有命名相机「${input.name}」（现有：${names.join("、") || "无"}）。命名相机是场景内容（entity.components.viewerCamera）：用 viewer_camera_apply 带 saveAs 存一台，或在相机面板里保存当前视角——存完另一个窗口/客户端也能按这个名字用它。`)
  }
  return { request: requestOfCameraState(saved.state), usedName: saved.name }
}
/**
 * 把请求的相机落到这个窗口的 Viewer 上，返回量到的读数与可恢复状态；任何一步不成立都抛明确错误。
 *
 * `saveAs` 走 `input.saveNamedCameras`（产品原生命令 `scene_edit` + CAS，见那个端口的注释）：
 * **先写成功再回 `savedAs`**，写不进去就整条抛错——命名相机是场景内容，不是"本窗口的偏好"，
 * 存不上却回成功会让用户/模型以为它在另一个窗口里也读得到。
 */
export async function applyCameraToWindow(input: CameraTargetInput): Promise<CameraApplyReceipt> {
  const viewer = requireCameraViewer(input)
  requireDisplayedScene(input.displayed, input.sceneId, input.expectedRevision, "VIEWER_CAMERA")
  const { request, usedName } = resolveRequest(input)
  const camera = viewer.applyCameraView(request)
  const state = viewer.getViewState()
  const receipt: CameraApplyReceipt = {
    camera, state,
    // 场景/版本取**核对通过后的那一次请求**：`requireDisplayedScene` 已经在上面证明了窗口显示的就是它。
    sceneId: input.sceneId, sceneRevision: input.expectedRevision,
    ...usedName === undefined ? {} : { usedName },
  }
  const saveName = input.saveAs?.trim().slice(0, MAX_CAMERA_NAME)
  if (!saveName) return receipt
  if (!input.saveNamedCameras) throw new Error(`VIEWER_CAMERA_SAVE_UNAVAILABLE: 这次调用没有可以写场景文档的入口，无法保存命名相机「${saveName}」——不假装存上了。`)
  // 要保存的是**应用之后量出来的状态**（不是原始请求）：照片 K 在画布上会按尺寸缩放，存原始请求会让
  // "再恢复一次"和"刚应用的那一次"不是同一台相机。
  const next = withNamedCamera(input.namedCameras ?? [], { name: saveName, savedAt: new Date().toISOString(), state: state as unknown as NamedCamera["state"] })
  await input.saveNamedCameras(next)
  return { ...receipt, savedAs: saveName, savedNames: next.map(row => row.name) }
}

export interface CameraCaptureInput extends CameraTargetInput {
  sessionId?: string
  observeId: string
  loadState?: () => ObserveLoadState | undefined
  readyTimeoutMs?: number
  capture: (payload: unknown) => Promise<unknown>
}
/** 按指定相机出图时的像素尺寸；省略时按请求里的内参尺寸，再没有就用当前画布尺寸（由 Viewer 决定，这里不猜）。 */
export interface RenderCameraInput extends CameraCaptureInput { width?: number; height?: number }
/**
 * "按指定相机出图"：**同一台原生 Viewer、同一个 scene**，换一台相机、换一套像素尺寸。
 *
 * 走的是与采集**完全相同**的那一串判定（视口在不在 → 显示的是不是这一版 → 资源真的加载完了 →
 * 失败台账为空 → 拍 → 图确实属于这一版），只把"拍哪一张"换成 `renderCameraImage`、
 * 并在拍之前把相机落到窗口上。因此这张图带 `source:"native-viewer-camera"`，
 * 与 `viewer_observe` 的当前画布截图在采集记录里是**两种来源**，不会互相冒充。
 */
export async function renderCameraForAgent(input: RenderCameraInput): Promise<unknown> {
  const viewer = requireCameraViewer(input)
  const { request, usedName } = resolveRequest(input)
  const size = { ...input.width === undefined ? {} : { width: input.width }, ...input.height === undefined ? {} : { height: input.height } }
  return await captureWithCamera(input, viewer, request, usedName, viewer2 => viewer2.renderCameraImage({ ...(request as Record<string, unknown>), ...size }))
}
/**
 * `viewer_observe` 带 `camera` 时走这条：**先把相机摆上去，再拍当前画布**。
 *
 * 与"按指定相机出图"只差拍哪一张：这条拍的仍是窗口里真实显示的那一帧（`capture()`，语义一字未改），
 * 所以它的来源仍是 `native-viewer`（当前屏幕画面），不会因为带了一台指定相机就冒充成"相机渲染图"。
 * 载荷里带上应用后量到的相机读数，于是"摆的是哪台相机"有据可查，模型不会拿着一张没摆成相机的图去比对。
 */
export async function observeCameraForAgent(input: CameraCaptureInput): Promise<unknown> {
  const viewer = requireCameraViewer(input)
  const { request, usedName } = resolveRequest(input)
  return await captureWithCamera(input, viewer, request, usedName, viewer2 => viewer2.capture())
}
/** 两条相机采集共用的骨架：先摆相机（量读数），再按给定的方式拍一张。 */
async function captureWithCamera(input: CameraCaptureInput, viewer: CameraViewer, request: unknown, usedName: string | undefined, shoot: (viewer: CameraViewer) => ObserveShot): Promise<unknown> {
  return await captureForObserver({
    sceneId: input.sceneId, expectedRevision: input.expectedRevision, observeId: input.observeId,
    clientId: input.clientId, sessionId: input.sessionId,
    viewerVisible: input.viewerVisible, viewer,
    displayed: input.displayed, loadState: input.loadState,
    ...input.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: input.readyTimeoutMs },
    // 先摆相机（并把量到的读数交回去），再拍：两个返回值一起进采集载荷，
    // 于是"图是哪台相机拍的"与"窗口现在是哪台相机"在记录里是同一份事实。
    prepare: () => {
      const applied = viewer.applyCameraView(request)
      return typeof applied === "object" && applied !== null ? { ...applied as Record<string, unknown>, ...usedName === undefined ? {} : { cameraName: usedName } } : { value: applied, ...usedName === undefined ? {} : { cameraName: usedName } }
    },
    shoot: () => shoot(viewer),
    capture: input.capture,
  })
}

// ── 初始机位：只按"可见有限几何"取景（DEV-034） ────────────────────────────────
/**
 * 为什么这一段在这里：**初始机位是前端的决定**（"打开这个场景时相机摆哪儿"），而本模块就是前端相机判定的
 * 唯一入口。Viewer 侧已经按可见有限几何取景（`packages/viewer/src/framing.ts`：`traverseVisible` 不收
 * `visible=false` 的隐藏碰撞层、跳过 `PlaneGeometry` 的无限地面、剔掉超过主体量级的巨大可见几何；
 * `SceneViewer.frameAll()` 优先"任务主体"实体）——但**取景读数不等于取景结论**：任何一个取景入口
 * （自动取景 / 聚焦 / 预览对象）都可能把巨大地面、隐藏碰撞几何或整条机械臂的包围盒并进来，把 5 cm 的
 * 任务主体压成几个像素的点（DEV-034 的原始症状：真机 17.0 m 处主体只剩 1–2 px）。
 *
 * 这一层**不重走几何**（几何遍历是 Viewer 的活，两份实现必然漂移），只做两件事：
 *   · 用 Viewer 量出来的**取景读数**核对"这份初始取景是不是主体量级的可见有限几何"；
 *   · 不是就给出**兜底机位**：姿态（含 roll）一字不改，只沿视线把相机前移到主体上；距离按取景读数
 *     自己的比例 `k = distance / radius` 折算——既不重算拟合公式，也不需要 fov/画幅，因此不会与
 *     Viewer 的取景口径分叉（`fitPerspectiveBounds`：`distance = radius / sin(halfFov) · padding`）。
 *
 * 判据只消费调用方交进来的**事实**：逐实体的包围盒 + "是不是任务主体" + "画面上可不可见"。
 * 谁是主体（官方 LIBERO 口径：场景文档里没有 `articulation` 的实体）由调用方按同一份事实判，
 * 本模块不另立一套——这里只回答"这份取景读数还能不能当初始机位"。
 */
export interface FramingBounds { min: [number, number, number]; max: [number, number, number] }
/** 一个实体**可见有限几何**的读数（产品侧从 Viewer 的逐实体读数取，例如 `probeEntityPixel(id).bounds`）。 */
export interface FramingGeometryReading {
  entityId: string
  /** 场景文档里这个实体是不是任务主体（机器人本体不是；由调用方判，本模块只消费这个事实）。 */
  subject: boolean
  /** 画面里可见吗：`visible=false` 的碰撞层**不是**"可见有限几何"，不进包围盒。 */
  visible: boolean
  bounds: FramingBounds
}
/** Viewer 量出来的取景读数（`SceneViewer.diagnostics.framing` 的同一形状；米制）。 */
export interface FramingReadout {
  center: [number, number, number]
  /** 取景包围球半径（米）：与 `fitPerspectiveBounds` 同一算法（盒对角线的一半）。 */
  radius: number
  /** 这次取景算出来的机位距离（米）。 */
  distance: number
  bounds: FramingBounds
}
/** 没资格决定初始机位的几何，以及**为什么**（回执要能逐条复算，不写"应该是干净的"）。 */
export interface FramingGeometryExclusion { entityId: string; why: "hidden" | "not-subject" | "bounds-invalid" }
/**
 * 初始取景允许的"取景球半径 / 主体并集球半径"上限。
 *
 * 1.2 = 20% 余量：Viewer 把主体各实体的可见有限几何并起来时，两侧用的是**同一个算法**（盒对角线的一半），
 * 比值应当 ≈1。超过 20% 就说明这个并集里混进了非主体几何——巨大地面/墙面、隐藏碰撞层、或整条机械臂。
 * 真机口径（官方 LIBERO，R18）：被 6 m 墙面与地面拉远时取景半径 6.54 m、主体并集 0.65 m ⇒ 比值 10.1。
 */
export const INITIAL_FRAMING_SUBJECT_RATIO_MAX = 1.2
interface InitialFramingFacts { subjectEntityIds: string[]; excluded: FramingGeometryExclusion[] }
/**
 * 初始机位判据的结论：
 *   · `subject-scale`：取景已是主体量级 ⇒ **不动相机**；
 *   · `pulled-away`：被非主体几何拉远 ⇒ 给读数（改前）与兜底距离；拿到当前姿态时还带一台
 *     **只改位置、不动姿态**的兜底机位（`request`），没拿到就只给诊断 + `reason`；
 *   · `unverified`：判不了（没有取景读数 / 读数不成立 / 没有可见主体几何）⇒ **一个字节都不动**并如实说明，
 *     不假装取好了景。
 */
export type InitialFramingVerdict =
  | ({ status: "subject-scale"; framingRadiusM: number; framingDistanceM: number; subjectRadiusM: number; ratio: number } & InitialFramingFacts)
  | ({ status: "pulled-away"; framingRadiusM: number; framingDistanceM: number; subjectRadiusM: number; ratio: number; correctedDistanceM: number; request?: ViewerCameraRequest; reason?: string } & InitialFramingFacts)
  | ({ status: "unverified"; reason: string } & InitialFramingFacts)

const isVec3 = (value: unknown): value is [number, number, number] => Array.isArray(value) && value.length === 3 && value.every(item => typeof item === "number" && Number.isFinite(item))
const isBounds = (value: FramingBounds | undefined): value is FramingBounds => Boolean(value) && isVec3(value!.min) && isVec3(value!.max) && value!.min.every((item, axis) => item <= value!.max[axis])
/** 盒对角线长度（米）：与 `fitPerspectiveBounds` 的 `box.getSize().length()` 同一个量。 */
const diagonalOf = (box: FramingBounds): number => Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2])
const centerOf = (box: FramingBounds): [number, number, number] => [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2]
/** 只把**可见的有限主体几何**并起来：隐藏的碰撞层、非主体实体（机器人本体/世界本体/地面）一律不进并集。 */
function subjectGeometryOf(geometry: readonly FramingGeometryReading[]): { box?: FramingBounds; ids: string[]; excluded: FramingGeometryExclusion[] } {
  const excluded: FramingGeometryExclusion[] = []
  const ids: string[] = []
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const row of geometry) {
    if (!row.visible) { excluded.push({ entityId: row.entityId, why: "hidden" }); continue }
    if (!row.subject) { excluded.push({ entityId: row.entityId, why: "not-subject" }); continue }
    if (!isBounds(row.bounds)) { excluded.push({ entityId: row.entityId, why: "bounds-invalid" }); continue }
    ids.push(row.entityId)
    for (const axis of [0, 1, 2] as const) { min[axis] = Math.min(min[axis], row.bounds.min[axis]); max[axis] = Math.max(max[axis], row.bounds.max[axis]) }
  }
  return ids.length ? { box: { min, max }, ids, excluded } : { ids, excluded }
}
const describeExclusions = (excluded: readonly FramingGeometryExclusion[]): string => excluded.length ? excluded.map(row => `${row.entityId}(${row.why})`).join("、") : "无"
/**
 * 判这份取景读数能不能当初始机位；被判拉远时给出兜底机位（只改位置、不动姿态）。
 *
 * `camera` 只在需要兜底时用到（要沿"当前视线"前移，就必须知道当前姿态）：给了它，`pulled-away` 里就带一台
 * 可直接应用的兜底机位；没给，仍然照判"被拉远"，只是**没有**兜底机位（`request` 缺席 + `reason` 说明）——
 * 诊断与修复分开，不因为拿不到姿态就把"被拉远"这个事实吞掉。
 */
export function initialFramingVerdict(input: { framing?: FramingReadout; geometry: readonly FramingGeometryReading[]; camera?: ViewerViewState }): InitialFramingVerdict {
  const subject = subjectGeometryOf(input.geometry)
  const facts: InitialFramingFacts = { subjectEntityIds: subject.ids, excluded: subject.excluded }
  const unverified = (reason: string): InitialFramingVerdict => ({ status: "unverified", reason, ...facts })
  const framed = input.framing
  if (!framed) return unverified("INITIAL_FRAMING_NO_READOUT: 这次没有自动取景读数（恢复了保存的视角，或还没取过景）：没有可核对的对象，一个字节都不动。")
  if (!isVec3(framed.center) || !isBounds(framed.bounds) || !Number.isFinite(framed.radius) || framed.radius <= 0 || !Number.isFinite(framed.distance) || framed.distance <= 0)
    return unverified(`INITIAL_FRAMING_READOUT_INVALID: 取景读数不成立（center=${JSON.stringify(framed.center)}、radius=${String(framed.radius)}、distance=${String(framed.distance)}）：不拿它当初始机位的依据。`)
  if (!subject.box) return unverified(`INITIAL_FRAMING_NO_SUBJECT_GEOMETRY: 这次没有任何**可见的**主体几何（收到 ${String(input.geometry.length)} 个实体的读数；被排除：${describeExclusions(subject.excluded)}）：判不出主体量级，不动相机。`)
  const subjectRadiusM = diagonalOf(subject.box) / 2
  const ratio = framed.radius / subjectRadiusM
  // 兜底距离 = 取景读数自己的比例 k = distance / radius 乘主体球半径：不重算拟合公式，也不需要 fov/画幅。
  const correctedDistanceM = (framed.distance / framed.radius) * subjectRadiusM
  if (ratio <= INITIAL_FRAMING_SUBJECT_RATIO_MAX)
    return { status: "subject-scale", framingRadiusM: framed.radius, framingDistanceM: framed.distance, subjectRadiusM, ratio, ...facts }
  const quaternion = input.camera?.quaternion
  const position = input.camera?.position
  if (!isVec3(position) || !Array.isArray(quaternion) || quaternion.length !== 4 || !quaternion.every(item => typeof item === "number" && Number.isFinite(item)))
    return {
      status: "pulled-away", framingRadiusM: framed.radius, framingDistanceM: framed.distance, subjectRadiusM, ratio, correctedDistanceM, ...facts,
      reason: `INITIAL_FRAMING_CAMERA_STATE_REQUIRED: 取景被非主体几何拉远（取景球 ${framed.radius.toFixed(3)} m / 主体球 ${subjectRadiusM.toFixed(3)} m = ${ratio.toFixed(2)} 倍），但没有当前相机状态（position/quaternion）：兜底机位只改位置、不动姿态，拿不到姿态就不给相机。`,
    }
  const forward = cameraForward(quaternion as ViewerQuat)
  const target = centerOf(subject.box)
  return {
    status: "pulled-away", framingRadiusM: framed.radius, framingDistanceM: framed.distance, subjectRadiusM, ratio, correctedDistanceM,
    // 位置按"主体中心 + 视线反方向 × 新距离"摆：target 与 quaternion 因此严格同轴（Viewer 的
    // `normalizeCameraRequest` 会用 0.5° 容差核对 target 是否在视线上），roll 由 cameraUp 原样带走。
    request: { position: [target[0] - forward[0] * correctedDistanceM, target[1] - forward[1] * correctedDistanceM, target[2] - forward[2] * correctedDistanceM], quaternion: quaternion as ViewerQuat, target, cameraUp: cameraUpAxis(quaternion as ViewerQuat) },
    ...facts,
  }
}
export interface InitialFramingInput {
  clientId: string
  viewerVisible: boolean
  viewer?: ObservableViewer
  /** 被请求的场景与版本：与相机应用/采集**同一份**判据（只有目标窗口正显示着这一版才动手）。 */
  displayed?: { sceneId?: string; revision?: number }
  sceneId: string
  expectedRevision: number
  /** 读 Viewer 量出来的取景读数（产品侧：`() => viewer.current?.diagnostics.framing`）。 */
  readFraming: () => FramingReadout | undefined
  /** 逐实体的可见有限几何读数（产品侧：场景文档的 `articulation` 事实 + Viewer 的逐实体 bounds）。 */
  geometry: readonly FramingGeometryReading[]
}
export interface InitialFramingReceipt extends InitialFramingFacts {
  /** 这次**有没有动相机**：`false` = 一个字节都没改（取景已是主体量级，或判不了）。 */
  applied: boolean
  status: InitialFramingVerdict["status"]
  /** 改前：Viewer 量出来的取景读数（取景半径 / 机位距离 / 主体球 / 比值）——复算用。 */
  before?: { framingRadiusM: number; framingDistanceM: number; subjectRadiusM: number; ratio: number }
  /** 机位距离（米）：动了就是**应用后当场量到的**（由 `applyCameraView` 的读数与可恢复状态的 target 算出）。 */
  distanceM?: number
  reason?: string
  state?: ViewerViewState
  camera?: unknown
}
/**
 * 初始机位落地：取景没被非主体几何拉远就**不动相机**（`applied:false`），被拉远就按兜底机位前移并回读数。
 *
 * 与 `applyCameraToWindow` 同一套前置判定（窗口在不在、显示的是不是这一版），因为它同样是"把一台相机
 * 摆到这个窗口上"；区别只在相机是**这里判出来的**，而且回执里同时给出改前/改后的可复算读数。
 */
export function enforceInitialFraming(input: InitialFramingInput): InitialFramingReceipt {
  const viewer = requireCameraViewer(input)
  requireDisplayedScene(input.displayed, input.sceneId, input.expectedRevision, "VIEWER_CAMERA")
  const verdict = initialFramingVerdict({ framing: input.readFraming(), geometry: input.geometry, camera: viewer.getViewState() })
  const facts: InitialFramingFacts = { subjectEntityIds: verdict.subjectEntityIds, excluded: verdict.excluded }
  if (verdict.status === "unverified") return { applied: false, status: verdict.status, reason: verdict.reason, ...facts }
  const before = { framingRadiusM: verdict.framingRadiusM, framingDistanceM: verdict.framingDistanceM, subjectRadiusM: verdict.subjectRadiusM, ratio: verdict.ratio }
  if (verdict.status === "subject-scale") return { applied: false, status: verdict.status, before, distanceM: verdict.framingDistanceM, ...facts }
  if (!verdict.request) return { applied: false, status: verdict.status, before, reason: verdict.reason, ...facts }
  const camera = viewer.applyCameraView(verdict.request)
  const state = viewer.getViewState()
  const measured = (camera as { position?: unknown } | undefined)?.position
  return {
    applied: true, status: verdict.status, before, ...facts,
    // 距离取**应用后量到的**（读数与请求分开：请求说摆到哪儿，读数说真的摆到了哪儿）。
    distanceM: isVec3(measured) && isVec3(state.target) ? Math.hypot(measured[0] - state.target[0], measured[1] - state.target[1], measured[2] - state.target[2]) : verdict.correctedDistanceM,
    state, camera,
  }
}
