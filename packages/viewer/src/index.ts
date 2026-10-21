import * as THREE from "three"
import { buildSceneLight, orientAreaLight, type SceneLight } from "./scene-light.ts"
import { EntityMaterialOverride, composeMaterialOverride, parseMaterialOverride, MATERIAL_OVERRIDE_KEY, type MaterialOverridePatch, type MaterialStatus } from "./material-override.ts"
export type { MaterialOverride, MaterialOverridePatch, MaterialStatus } from "./material-override.ts"
import { type GLTF, type GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import {clone as cloneSkeleton} from 'three/addons/utils/SkeletonUtils.js'
// glTF 装载器**只在 `draco-decoder.ts` 里造**：它是唯一一处把 DRACO / KTX2 / meshopt 三种解码器接上去的地方
// （`createGltfLoader`）。本文件里再 `new GLTFLoader()` 一次，就等于又开出一条"遇到压缩扩展就整件加载失败"的路
// （DRACO / KHR_texture_basisu / EXT_meshopt_compression 三种都是构造期 throw，见该模块头）。
import { createGltfLoader, releaseGltfLoader } from "./draco-decoder.ts"
import {centralSplatBounds,placeInsideScene,FirstPersonNavigation} from "./first-person.ts"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import { TransformControls } from "three/addons/controls/TransformControls.js"
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js"
import { HDRLoader } from "three/addons/loaders/HDRLoader.js"
import { EXRLoader } from "three/addons/loaders/EXRLoader.js"
import { SparkRenderer, SplatMesh, SplatFileType } from "@sparkjsdev/spark"
import { assessSplatDecoded, assessSplatDeclaration, assessSplatFailure, splatWarningCode } from "./splat-support.ts"
import { appendFrameSample, cachedSplatCenterBounds, frameSampleSummary, scanSplatCenterBounds, splatDataSource, splatPointCount,splatInitializationLod, SPLAT_INTERACTIVE_BUDGET, viewerWebglFacts,interactiveSplatBudget,recognizedHighSplatVisual,type SplatInteractiveBudget,type SplatQuality } from "./splat-runtime.ts"
import { retainedSplats, retainedSplatFootprint,restoreSplatData, retainSplatData, type SplatRetentionScope } from "./splat-retention.ts"
import { assetFormatOf, pairDocumentAssets } from "./asset-locator.ts"
import { axisSuspectForGltf } from "./source-axis.ts"
import { isGaussianCameraFrame } from "../../lyapunov-contracts/src/gaussian-frame.ts"
import { gaussianFirstCameraPose } from "./gaussian-first-camera.ts"
import type { Entity, Frame, ResourceRef, SceneSnapshot, Transform, WorldHandle } from "../../lyapunov-contracts/src/types.ts"
import { FrameProjection } from "./projection.ts"
import { DynamicGeometryVisual } from "./dynamic-geometry.ts"
import { sceneEditTarget } from '../../lyapunov-contracts/src/scene-edit-target.ts'
import {RobotAnchorLayer,type RobotAnchorSelection} from "./robot-anchor-layer.ts"
import {
  advanceEnvironmentClock, composeEnvironment as composeEnvironmentComponent, environmentDaylightFactor,
  environmentLiveState, resolveEnvironmentHdri, scanSceneEnvironment,
  sunDirectionVector, ENVIRONMENT_COMPONENT_KEY, HDRI_MIME_TYPES, type EnvironmentClockState, type EnvironmentPatch,
  type EnvironmentHdriResolution, type EnvironmentScan, type SceneEnvironment, type EnvironmentToneMapping, SCENE_ENVIRONMENT_DEFAULTS,
} from "./environment.ts"
/**
 * 环境组件的格式与纯计算由 `./environment.ts` 唯一拥有，这里再导出给消费方（面板/测试）：
 * 界面只按这些类型读写，不自己解析字段。
 */
export {
  composeEnvironment, defaultSceneEnvironment, parseEnvironmentComponent, scanSceneEnvironment,
  environmentLiveState, resolveEnvironmentHdri, dayNightSun, sunDirectionVector,
  ENVIRONMENT_COMPONENT_KEY, ENVIRONMENT_KIND, HDRI_MIME_TYPES, ENVIRONMENT_LIMITS,
} from "./environment.ts"
export type { EnvironmentParseResult, EnvironmentScan, EnvironmentPatch, SceneEnvironment } from "./environment.ts"
export type { EnvironmentHdriResolution } from "./environment.ts"
import { buildRobotVisual, type RobotVisual } from "./robot.ts"
import {objectWorldBounds,fitPerspectiveBounds,subjectEntityIds,markAuthoringHelper,isAuthoringHelperRoot} from "./framing.ts"
import {CollisionTopologyLayer,type CollisionTopologyStatus} from "./collision-topology.ts"
export type {CollisionTopologyStatus} from "./collision-topology.ts"
import { chooseDerivedNode, derivedNodeMatrix, fileNodeChain, LOD_BASE, primaryResource, rawLodLevel, resolveLodPlan, selectLodLevel, type DerivedNodeCandidate, type LodPlan } from "./lod.ts"
import {
  ANNOTATION_ROOT_NAME, applyAnnotationSelection, buildAnnotationMarker, disposeAnnotationMarker, drawAnnotationPins,
  annotationAnchorAtHit, annotationAtCapture, projectToCapture, refreshAnnotationMarker, resolveAnnotationWorld, updateAnnotationMarker,
  type ViewerAnnotation, type ViewerAnnotationAnchor,
} from "./annotations.ts"
import {
  applyViewToCamera, assertRenderSize, cameraForward, cameraRequestFromState, cameraStateFromView, describeCameraView, isPlainLens, namedCamerasOfScene, normalizeCameraRequest, rotateByQuaternion, scaleIntrinsics, setCameraIntrinsics,
  writeViewToCamera, ViewerCameraError,
  type ViewerCameraCurrent, type ViewerCameraIntrinsics, type ViewerCameraMeasurement, type ViewerCameraRequest, type ViewerVec3, type ViewerCameraView,
} from "./camera-view.ts"
import { cameraRequestFromRig, captureGateLabel, captureGateRect, frustumFromReceipt, frustumGeometry, rigidPoseOf, type FrustumGeometry, type FrustumSpec, type RigidPose } from "./camera-frustum.ts"
import { captureRoutePathSegments, captureRouteStationGeometry, captureRouteStationsGeometry, type CaptureRouteStationGeometry, type CaptureRouteStationInput } from "./capture-route-display.ts"
import { currentRobotFrame } from "../../lyapunov-contracts/src/robot-frame.ts"
import { projectSceneCameraRigs } from "./scene-camera-rigs.ts"
import { staticAnimationReference, type StaticAnimationReference } from "./animation-reference.ts"

const TONE_MAPPINGS: Record<EnvironmentToneMapping, THREE.ToneMapping> = { aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping, linear: THREE.LinearToneMapping, none: THREE.NoToneMapping }

export interface ViewerOptions {
  container: HTMLElement
  resolveResource: (uri: string, resource?: ResourceRef) => string | Promise<string>
  /** 可选：同一账户Host和会话内短暂保留冷解码数组，不复用可变Viewer/Scene/物理对象。 */
  splatRetentionScope?: SplatRetentionScope
  commitEdit?: (input: { sceneId: string; expectedRevision: number; entityId: string; transform: Transform }) => Promise<SceneSnapshot>
  onSelection?: (entityId: string | undefined) => void
  /** 部件级选择（R-011）：只报告"当前高亮的是哪个真实部件"，不写 Scene、不动物理。 */
  onPartSelect?: (selection: ViewerPartSelection | undefined) => void
  /** 右键只贡献当前选择与真实命中；聊天引用仍由原生会话 owner 处理。 */
  onContextMenu?: (input: { clientX:number; clientY:number; sceneId:string; sceneRevision:number; entityId:string; annotate:()=>void }) => void
  onRobotAnchorSelect?: (selection: RobotAnchorSelection) => void
  onPlacePoint?: (point: [number, number, number]) => void
  /** 表面安装点拾取（R-012）：用户点中源真实可见几何，点/法线已换算到源真实根 body 局部系。 */
  onMountPick?: (pick: ViewerSurfaceMountPick) => void
  onError?: (error: Error) => void
  /** 用户在 3D 视口里新落一条批注：锚点已换算成实体局部坐标，换视角/移动实体都不会走位。 */
  onAnnotationCreate?: (anchor: ViewerAnnotationAnchor) => void
  /** 用户点了某条批注标记（用来编辑它的文字）。 */
  onAnnotationSelect?: (annotationId: string) => void
  translate?: (zh:string,en:string)=>string
}
export interface ViewerDisplaySettings { grid: boolean; axes: boolean; background: string; wireframe: boolean; splats: boolean; collision?: boolean;splatQuality?:SplatQuality }
/** Viewer 自己的显示默认：V8 画布底色；碰撞线框默认收起，只有用户显式打开才显示。 */
export const DEFAULT_VIEWER_DISPLAY: Readonly<ViewerDisplaySettings> = { grid: true, axes: true, background: "#242a32", wireframe: false, splats: true, collision: false }
/**
 * 网格只往上抬 2mm：地面与网格线原本共面，线宽只有 1px，深度值相等时会出现点状 z-fighting。
 * 这是**显示层**修正：不移动地面/实体、不改碰撞或 Scene 变换，也不关闭网格功能。
 */
export const VIEWER_GRID_Z_OFFSET_M = 0.002
/** 网格显示材质只读深度、不写深度；与上面的微抬升一起消除共面闪烁。 */
export function applyViewerGridDepthPolicy(grid: THREE.GridHelper): void {
  grid.position.z = VIEWER_GRID_Z_OFFSET_M
  grid.renderOrder = 1
  const materials = Array.isArray(grid.material) ? grid.material : [grid.material]
  for (const material of materials) material.depthWrite = false
}
/**
 * 相机状态。前三个字段的老语义一字未改（老调用方传 `{position,quaternion,target}` 照常工作），
 * 后面几个是"照片相机"必需、而老形状装不下的东西：
 *  · `up` —— **相机自身 up 轴**（相机 y 轴在世界系的方向）。有 roll 时它不等于世界 up；
 *    老实现只存 position/quaternion/target 且 `setViewState` 后 `controls.update()` 按当时的 `camera.up`
 *    重写姿态，于是"带 roll 的照片机位"存下来再恢复就被抹平了（实测同一姿态差 115.9°）。
 *  · `fovDeg` / `intrinsics` —— 视场与内参（含主点偏移、fx≠fy）。`intrinsics` 只在**普通镜头装不下**时才出现
 *    （见 `isPlainLens`），所以普通相机存下来的状态不会多出噪声字段。
 *  · `near`/`far` —— 照片相机的裁剪面；不带上就会在极近/极远处被裁掉。
 */
export interface ViewerViewState {
  position: [number,number,number]; quaternion: [number,number,number,number]; target: [number,number,number]
  up?: [number,number,number]; fovDeg?: number; near?: number; far?: number
  intrinsics?: ViewerCameraIntrinsics
  navigation?: "orbit"|"first-person"
}
interface CameraRigRecord { spec: FrustumSpec; group: THREE.Group; lines: THREE.LineSegments; pick: THREE.Mesh; geometryKey?: string }
export interface ViewerObserverState {
  mode: "free" | "pilot" | "camera-edit"
  cameraId?: string
  navigation: "orbit" | "first-person"
  dirty: boolean
  saving: boolean
  error?: string
  positionLocked?: boolean
  scope: { sceneId?: string; sceneRevision?: number; worldId?: string; generation?: number }
}
export interface ViewerCameraAuthoringSample {
  sceneId: string; sceneRevision: number
  worldId?: string; generation?: number; frameId?: string; stepIndex?: number
  view: ViewerViewState
  camera: ViewerCameraMeasurement
  bodies?: Array<{ entityId: string; bodyName: string; worldFromBody: RigidPose; frameId: string; stepIndex: number }>
}
export interface ViewerCameraEdit {
  worldPose: RigidPose; localPose: RigidPose
  sceneId?: string; sceneRevision?: number; revision?: number; worldId?: string; generation?: number; frameId?: string; stepIndex?: number
  parentEntityId?: string; parentBodyName?: string
  intrinsics: ViewerCameraIntrinsics; width: number; height: number; near: number; far: number
}
/** 按指定相机出图：请求就是"应用相机"那一个，外加要出的像素尺寸。 */
export interface ViewerCameraRenderRequest extends ViewerCameraRequest { width?: number; height?: number }
/**
 * 按指定相机渲染出来的一张图：**同一台原生 Viewer、同一个 scene**，只换相机与出图尺寸。
 *
 * `source` 是给模型与采集记录看的出处：这是"用指定相机渲染的"（native-viewer-camera），
 * 不是当前屏幕截图（那份语义仍归 `capture()`/`viewer_observe`，它照旧只认画布上真正看到的画面）。
 */
export interface ViewerCameraRender {
  dataURL: string
  imageWidth: number; imageHeight: number
  source: "native-viewer-camera"
  /** 出图相机**量出来**的视角（含有效内参、roll、worldFromCamera），不是"我请求了什么"。 */
  camera: ViewerCameraMeasurement
  /** 请求里给的照片内参（未按出图尺寸缩放的原值）；与 `camera.intrinsics` 对照即可看出缩放关系。 */
  sourceIntrinsics?: ViewerCameraIntrinsics
  /** 归一化后的应用视角（含 `notes`：哪些输入没被复现，例如畸变系数）。 */
  applied: ViewerCameraView
  /**
   * 这张图这一帧的**环境光照窄面**（与 `capture()` 的 `environment` 同一份 owner）：按指定相机出的图
   * 也可能落在"请求的 HDRI 没装上/正在换图"的画面上，采集记录与回执要能如实说出，不能只对当前画布图生效。
   */
  environment: EnvironmentCaptureFace
  sceneId?: string; sceneRevision?: number
  /**
   * 这张图这一帧的 **LOD 窄面**（与 `capture()` 的 `lod` 同一份 owner）：按指定相机出图**前**会按**这台
   * 相机**重新定级（`updateLod(camera, {settle:true})`），所以图里的几何就是这台相机该用的那一级；
   * 出图后窗口相机那一级会恢复回去。回执据此说清"这张图用了简化件 / 有没有比该用的更粗"。
   */
  lod: LodCaptureFace
  /** 这张图这一帧的**展示层事实**（是否炸开、选中哪个真实部件、哪一版资源）；与 `capture()` 同一 owner。 */
  presentation: PresentationCaptureFace
  worldId?: string; generation?: number; worldSceneRevision?: number
  frameId?: string; frameSceneRevision?: number; stepIndex?: number; simTime?: number
  capturedAt: string
}
export interface ViewerViewState { position: [number,number,number]; quaternion: [number,number,number,number]; target: [number,number,number] }
/**
 * 环境光照的**当前读数**（`SceneViewer.environmentStatus()`）：生效的太阳/时刻/渲染时钟、IBL 来源、
 * HDRI 是否真的在手里、以及文档里被忽略/被收敛的记录。界面与验收读的都是这一份，不各自重算。
 */
export interface EnvironmentStatus {
  /** 承载实体（没有环境组件时缺省）。 */
  carrier?: string
  /** 生效的组件（已规范化）。 */
  component?: SceneEnvironment
  /** 解析这条组件时被收敛的字段（逐条带路径）。 */
  warnings: string[]
  /** 声明了 `components.environment` 但没被采纳的记录及原因。 */
  ignored: EnvironmentScan["diagnostics"]
  /**
   * HDRI 的**归属**读数：`resourceId@version` 是文档请求的那一份；`applied` 是**真的装到画面上**的那一份。
   * `loaded` 只在两者一致时为真——换图在途（A 还在显示、B 正在读）时 `loaded=false` 且 `applied=A`，
   * 不拿还显示的旧 A 冒充新请求的 B（2026-09-20 审查）。`uri`/`size` 只在 `loaded` 时给，
   * 否则它们描述的是别的文件。`loading`＝请求的这一份正在读（还没落地）。
   */
  hdri?: { resourceId: string; version: number; loaded: boolean; loading: boolean; applied?: { resourceId: string; version: number }; uri?: string; size?: [number, number] }
  /** Viewer 认得的 HDRI mimeType（.hdr/.exr 两条）：界面按它筛素材库，不猜扩展名。 */
  hdriMimeTypes: readonly string[]
  /** 当前 IBL 到底来自 HDRI 还是内置环境光（按"纹理是否真在手里"判定，不看声明）。 */
  environmentSource: "hdri" | "builtin"
  /** HDRI 资源缺失/加载失败的原因。 */
  error?: string
  background: "environment" | "color"
  /** 组件里保存的场景自带背景色（缺省＝没有这一份，沿用查看器偏好）。 */
  backgroundColor?: string
  /** 纯色背景**实际生效**的颜色：组件自带色优先，否则是查看器/相机面板那一份（背景色的唯一回落处）。 */
  colorBackground: string
  exposure: number
  toneMapping: EnvironmentToneMapping
  environmentRotationDeg: [number, number, number]
  shadow: SceneEnvironment["shadow"]
  environmentIntensity: number
  hemisphereIntensity: number
  shadows: boolean
  sun: { azimuthDeg: number; elevationDeg: number; intensity: number; source: "manual" | "dayNight" }
  /** 生效的渲染时刻（小时）：昼夜开启时是"静态时刻 + 渲染时钟偏移"。 */
  timeHours: number
  clock: EnvironmentClockState
}
/**
 * 随 `capture()` 一起交出去的环境窄面：只回答一个问题——**这张图用的光照，是不是场景文档请求的那一份**。
 *
 * 为什么采集回执必须带它：`startEnvironmentLoad` 失败后照样 resolve，前端与工作台会认为这一版"就绪"，
 * 而 `viewer_observe` 从前只看 `loadingErrors`/`visualWarnings`——于是"HDRI 没装上、IBL 退回内置环境光"
 * 的画面会被当成完整配置交出去（2026-09-20 审查）。有了这一面，采集/观察的回执能如实说出
 * "请求的是 A、画面用的是 B 或内置光"，而不是静默冒充。字段是窄面，不是整套读数：整套在 `environmentStatus()`。
 */
export interface EnvironmentCaptureFace {
  /** 这一帧的 IBL 来自哪里：`hdri`＝手里有环境贴图；`builtin`＝内置环境光（含回退）。 */
  source: "hdri" | "builtin"
  /** 文档请求的 HDRI（`resourceId@version`）；场景没声明 HDRI 时缺省（内置光就是它的配置，不是回退）。 */
  requested?: string
  /** 真的装在画面上的那一份；与 `requested` 不同就是"还没换上"。 */
  applied?: string
  /** 请求的那一份真的在手里（精确版本一致）。 */
  loaded: boolean
  /** 请求的那一份正在加载中。 */
  loading: boolean
  /** 取不到/读不到的原因（缺版本、失败原因等）。 */
  error?: string
}

/** 单个实体这一帧的级别读数（采集回执里的 `lod.entries`；整形在 `packages/lyapunov-shell/src/lod-capture.ts`）。 */
export interface LodEntityReading {
  entityId: string
  /** 画面里这一帧用的级别：-1 = 基础件（未简化），≥0 = 文档 `visual.lod` 的第 N 条派生级。 */
  level: number
  /** 这台相机按距离**该用**的级别；与 `level` 不同就是"顶不上去"的降级（见 `coarser`）。 */
  requested: number
  /** 该级别的角色名（文档 `visual.lod[].role`）。 */
  role?: string
  /** 画面的几何来自哪条资源版本（`resourceId@version`）；基础件时为文档里那条原件。 */
  resource?: string
  /** 画面里这一级的三角形数（真实渲染用的那份对象）。 */
  triangles: number
  /** 相机到该实体锚点的距离（米）。 */
  distanceM: number
  /** 用的是简化件（不是基础件）——正常按距离简化，但数据集必须知道。 */
  simplified: boolean
  /** 比这台相机该用的级别**更粗**：只有缺资源/读失败才会，是降级不是正常简化。 */
  coarser?: boolean
  /** 该读进来却读失败的级别（角色名）。 */
  failed?: string[]
}
/**
 * 采集/观察回执里的 LOD 窄面：这一帧每个参与级别的实体显示的是哪一级、哪份资源、多少三角形、距离多少。
 *
 * 这是 Viewer 对外的**唯一一份**级别读数（`capture()` 与 `renderCameraImage()` 都带它），
 * 形状固定、只读；服务端只做整形与措辞（`lod-capture.ts`），不重算级别。
 */
export interface LodCaptureFace {
  /** 这些级别是为**哪台相机**定的：`capture` = 按指定相机出图那次，`window` = 窗口相机。 */
  camera: "capture" | "window"
  /** 这一帧参与级别选择的实体数。 */
  planned: number
  /** 逐实体读数。 */
  entries: LodEntityReading[]
  /** 参与不了级别交换的实体（例如带烘焙动画）：如实带上，不省这点面数。 */
  skipped?: Array<{ entityId: string; reason: string }>
}
/**
 * 一个**可读部件**的对外身份（R-011）。`partId` 只在同一实体内唯一，跨实体靠 `entityId` 定身份；
 * `resource`/`signature` 说明这棵树来自哪一版资源，避免"同名不同版"被当成同一件东西。
 */
export interface ViewerPart {
  entityId: string
  partId: string
  name: string
  kind: "body" | "link" | "node"
  /** 原生名字路径（展示用；不参与身份）。 */
  path: string[]
  /** 这一版资源身份：`resourceId@version` 或（非机器人资源）加载签名。 */
  resource?: string
  resourceSignature: string
  granularity: "hierarchy" | "single"
  /** 是否可参与展示层炸开；false 时 `reason` 给出具体不可用原因。 */
  separable: boolean
  reason?: string
  /** 当前是否是选中的部件。 */
  selected: boolean
}
export interface ViewerPartSelection { entityId: string; partId: string }
/**
 * 随采集/观察一起交出去的**展示层事实**：这张图是不是炸开视图、展开到多少、选中的是哪个真实部件、
 * 对应哪一版资源。它描述的是"这张图画的是什么显示状态"，不是 Scene/物理的改动（`displayOnly` 恒真）。
 */
export interface PresentationCaptureFace {
  displayOnly: true
  exploded: boolean
  spread: number
  entityId?: string
  selectedPart?: { entityId: string; partId: string; name: string; kind: ViewerPart["kind"] }
  catalog?: { entityId: string; resource?: string; signature: string; parts: number; separable: number }
  /** 未应用的装配预览 ghost：画面里的第二只手只是临时预览，不是已提交实体。 */
  assemblyPreview?: ViewerAssemblyPreviewFace
  /** 未应用的旧件停放 ghost：旧件身份 + 明确停放位姿，`applied:false` 说明它还没被真正停放。 */
  parkingPreview?: ViewerParkingPreviewFace
}
interface Loaded {
  group: THREE.Group; signature: string; documentWorldMatrix?: THREE.Matrix4
  robot?: RobotVisual; splat?: SplatMesh; collision?: THREE.Object3D
  dynamicGeometry?: DynamicGeometryVisual
  /** 初始化中的 mesh 也归当前 Loaded；取消仅停止本地后处理，Spark 的质量 WASM 仍须等返回再释放。 */
  pendingSplat?: { mesh?: SplatMesh; controller: AbortController; cancel(): void }
  splatRetentionKey?: string
  /** 从 GLB 读到的**烘焙动画**（作者在 Blender 里打的关键帧，随导出走）。与物理实时帧无关。 */
  mixer?: THREE.AnimationMixer; clips?: THREE.AnimationClip[]
  /**
   * 正在进行的资源加载（成功即清空）。同一个实体在"签名不变"的后续 setScene 里复用这个 Loaded，
   * 因此后续 setScene 通过 await 它来等到**真正加载完成**，而不是看 `userData.loaded` 跳过。
   */
  pending?: Promise<void>
  /** 基础级别（`visual` 表示）的可视对象；LOD 交换只换 `visual`，它一直留着。 */
  materialOverride?: EntityMaterialOverride
  baseVisual?: THREE.Object3D
  /** 当前挂在 group 上显示的可视对象（LOD 交换会替换它）。 */
  visual?: THREE.Object3D
  /** 可视对象来自 GLTF 缓存（几何/材质/贴图按 URL 共享）：释放这个实体时**不销毁**它们，只有缓存所有者销毁。 */
  shared?: boolean
  /** LOD 运行态；没有合法计划、或基础视觉不是 GLB 网格时不存在。 */
  lod?: LodRuntime
  /** 基础级别**实际去读**的那条资源版本（`primaryResource` 选中的那条）。回执里"基础件的资源版本"就是它。 */
  baseRef?: { resourceId: string; version: number }
  /** 加载期缺件说明（LOD 基础级失败后降级、某级加载失败、实体没有 `visual` 组件……）；与机器人缺件合并后写进 `visualWarnings`。 */
  lodWarnings: string[]
  /** 这一版实体的 `visual` 组件（派生级别沿用它的 `gltfNode`/`sourceTransform` 语义，不另立一套）。 */
  planVisual?: Record<string, unknown>
  /**
   * 基础级别 GLB 里那个节点在**该文件内部**的完整变换链（`父 × … × 自己`，整文件级别为 undefined）与名字。
   * 派生文件是另一个命名空间，节点号不能套用；但"基础节点的完整链"是派生节点相对变换的基准
   * （见 `derivedNodeMatrix`），也是按名字找节点的依据。链只含该文件自己的 glTF 节点，Scene 侧父变换不在里面。
   */
  baseNode?: { matrix: THREE.Matrix4; name: string }
  /**
   * 非机器人刚体物件的**纯显示炸开层**（R-011）：按实例缓存的稳定部件身份 + 每部件的展示包装组。
   * 包装组只插在**本实例自己的克隆层级**里（几何/材质仍归 GLTF 缓存），原真实节点矩阵不动。
   */
  nodeExplode?: NodeExplodeRuntime
}
/**
 * 非机器人结点的展示层不可分原因（码值）；文案在读取时经 `options.translate` 本地化，
 * 因此缓存的身份里不存语言相关的字符串。
 */
type NodePartReasonCode = "PART_NO_OWN_GEOMETRY" | "PART_GROUP_GEOMETRY" | "PART_NESTED_GEOMETRY" | "PART_SKINNED" | "PART_SINGLE"
/** 一个非机器人真实结点（包装组不算用户部件，身份只来自原层级）。 */
interface NodePartRecord {
  partId: string
  node: THREE.Object3D
  name: string
  path: string[]
  /** 该结点自己有可视几何（自身是 Mesh，或直接挂着 Mesh 子结点）。 */
  hasVisual: boolean
  separable: boolean
  reasonCode?: NodePartReasonCode
}
interface NodeExplodeRuntime {
  /** 身份缓存对应的可视对象；LOD/重建换了对象就重算。 */
  visual?: THREE.Object3D
  parts: NodePartRecord[]
  /** partId → 展示包装组（只有可分部件有；懒建一次，绝不重复插入）。 */
  wrappers: Map<string, THREE.Object3D>
  offsets: Map<string, [number, number, number]>
  spread: number
}
/** 一个实体上的 LOD：计划 + 已加载的派生级别 + 在途/失败记录。 */
interface LodRuntime {
  plan: LodPlan
  /** 已读进来的派生级别：级别下标 → 可视对象。 */
  levels: Map<number, THREE.Object3D>
  /** 各级别的三角形数（-1 = 基础级别）：按级别算一次，报告里读的是真实几何量，不是配置里的声明。 */
  triangles: Map<number, number>
  /** 距离参照点（group 局部坐标）：取基础级别的包围盒中心，交换级别不改它，避免切级别时参照点跟着跳。 */
  anchorLocal: THREE.Vector3
  /** 当前**正在显示**的级别（-1 = 基础）。 */
  current: number
  /** 距离要求的级别（可能还在加载）。 */
  wanted: number
  /** 最近一次判据算出的相机距离（米）；采集元数据要用"这一帧实际按多远判的"。 */
  distance: number
  pending?: number
  failed: Set<number>
  switches: number
}

/**
 * 环境组件出现**之前** Viewer 写死的那组光照读数：没有 `components.environment` 的场景继续读它，
 * 画面与旧版逐项一致。新的默认值（SCENE_ENVIRONMENT_DEFAULTS）与这里同值，只是多了一条可被
 * 文档覆写的通道——所以"加环境光照"不会顺手改变任何历史场景的亮度。
 */
const LEGACY_LIGHTING = {
  exposure: 1, environmentIntensity: 0.7, hemisphereIntensity: 2.4,
  sunIntensity: 3, sunPosition: [5, -4, 8] as const,
} as const

/**
 * `setScene` 里同一时刻最多在途的实体资源读取数。
 *
 * 有界是必须的：无界时大场景（实测 1120 实体 / 1119 个 GLB）会在同一轮里起上千个读取与解析，
 * 解析回调把主线程排满，重载期间求值与输入成片超时（DEV-010）。64 是实测折中：冷加载总时长与
 * 无界同量级（同一个本地 HTTP 源、上千次小请求），而峰值停顿显著下降（见回执）。
 */
const LOAD_CONCURRENCY = 64

/**
 * 展示层炸开的位移尺度（与 `robot.ts` 同一条口径）：可视整体包围盒对角线的这个比例 × spread。
 * 纯显示量，不写任何原生矩阵/Scene。
 */
const NODE_EXPLODE_RADIUS_FACTOR = 0.35

/**
 * 部件/炸开的系统能力理由（zh, en）。**唯一一份**：Viewer 读取时经 `options.translate` 本地化，
 * 缓存的身份里只存码值；这样英文界面不会出现系统中文，用户自己的名称则原样保留。
 */
const PART_REASONS = {
  dynamic: ["该实体当前显示原生动态几何（线缆/网格由物理帧驱动），不能按刚体拉开", "This entity currently shows native dynamic geometry (driven by physics frames), so it cannot be exploded as a rigid body."],
  animated: ["该实体带烘焙/蒙皮动画，刚体展示偏移会与动画骨骼冲突，不能按刚体拉开", "This entity has baked/skinned animation; a rigid display offset would conflict with the animated skeleton, so it cannot be exploded."],
  lod: ["该实体使用 LOD 级别切换，展示层偏移不会跟随交换后的级别，因此不提供炸开", "This entity uses LOD level switching; a display explode layer would not follow the swapped level, so explosion is unavailable."],
  robotSingle: ["整个资源只有一个可视部件，没有可分离的兄弟部件", "The resource has only one visual component, so there are no sibling components to separate."],
  objectSingle: ["这个物件只有一个可视部件，没有可独立显示的子部件，不虚构可拆面", "This object has only one visual component; there are no independently displayable child components, and no cut faces are invented."],
  noVisual: ["该实体没有可读的可视节点", "This entity has no readable visual nodes."],
  notLoaded: ["实体尚未加载", "The entity has not finished loading."],
  robotNoVisual: ["该节点没有自己的可视几何（纯变换/关节节点）", "This node has no visual geometry of its own (a pure transform/joint node)."],
  noOwnGeometry: ["该节点没有自己的可视几何（几何由子部件提供）", "This node has no visual geometry of its own (its geometry belongs to child components)."],
  groupGeometry: ["该节点是容器，自己的可视几何由子部件提供", "This node is a container; its visual geometry belongs to child components."],
  nestedGeometry: ["该网格下面还有子部件，单独平移会一并带走它们，因此不独立炸开", "This mesh contains child components; translating it alone would move them too, so it is not exploded independently."],
  skinned: ["该部件是蒙皮网格，刚体展示偏移会与骨骼蒙皮冲突", "This component is a skinned mesh; a rigid display offset would conflict with its skeleton skinning."],
} as const

/** 结点级原因码 → 本地化文案键（唯一映射，避免把码值当文案）。 */
const NODE_PART_REASON_KEY: Record<NodePartReasonCode, keyof typeof PART_REASONS> = {
  PART_NO_OWN_GEOMETRY: "noOwnGeometry",
  PART_GROUP_GEOMETRY: "groupGeometry",
  PART_NESTED_GEOMETRY: "nestedGeometry",
  PART_SKINNED: "skinned",
  PART_SINGLE: "objectSingle",
}


/**
 * DEV-039：WebGL 不可用时的专用错误。
 *
 * 为什么要一个类型而不是让 three.js 的原始异常冒出去：客户机上 WebGL 可能因为
 * 「没有 GPU / 驱动挂了 / 浏览器禁用了硬件加速 / 远程会话里没有 GL」而不存在。
 * 上层需要据此**分辨**这是"环境缺能力"而不是"场景坏了"，并给出处置建议；
 * 靠匹配 three.js 的异常字符串既脆弱又说不清。
 */
export class WebGLUnavailableError extends Error {
  readonly code = "VIEWER_WEBGL_UNAVAILABLE" as const
  constructor(cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : cause === undefined ? "" : String(cause)
    super(`VIEWER_WEBGL_UNAVAILABLE: 无法创建 WebGL 上下文${detail ? `（${detail}）` : ""}`)
    this.name = "WebGLUnavailableError"
  }
}

export function createViewer(options: ViewerOptions) { return new SceneViewer(options) }

/**
 * R-012／§2.9：临时装配预览 ghost 的只读输入。
 *
 * `targetBodyFromSourceRoot` 是服务端 `robot_assembly_preview` 按
 * `T_targetBody_sourceRoot = T_targetBody_targetMount · T_pair · inverse(T_sourceRoot_sourceMount)`
 * 算出的**目标 body 局部**安装变换（米、归一化 xyzw）。Viewer 只负责用真实已加载几何把它显示出来，
 * 不自己算安装数学、不读 explode 偏移、不新增 Scene 实体。
 */
export interface ViewerAssemblyGhostSpec {
  sourceEntityId: string
  targetEntityId: string
  targetBodyName: string
  targetBodyFromSourceRoot: { positionM: number[]; quaternionXyzw: number[] }
  /** 身份绑定：任一变化（scene/world/revision/generation/资源签名）都必须清理 ghost。 */
  worldId?: string
  sceneId?: string
  sceneRevision?: number
  generation?: number
  sourceRootBodyName?: string
  sourceResourceSignature?: string
  targetResourceSignature?: string
}
export interface ViewerAssemblyGhostResult {
  status: "PREVIEW" | "UNAVAILABLE"
  reason?: string
  sourceEntityId?: string
  targetEntityId?: string
  targetBodyName?: string
}
/**
 * R-012 Replace：旧末端**离开挂载位的停放**临时 ghost 的只读输入。`worldPose` 是旧末端真实根 body
 * 在世界系中的明确停放位姿（米/归一化 xyzw）。Viewer 只把它显示出来，不决定停放位置、不写 Scene。
 */
export interface ViewerParkingGhostSpec {
  entityId: string
  worldPose: { positionM: number[]; quaternionXyzw: number[] }
  worldId?: string
  sceneId?: string
  sceneRevision?: number
  generation?: number
}
export interface ViewerParkingGhostResult {
  status: "PREVIEW" | "UNAVAILABLE"
  reason?: string
  entityId?: string
}
/**
 * V10-08/38：真实资产放置预览的只读输入。
 *
 * 实体来自服务端 `asset_placement_preview`（与 `scene_mount` 同一份落点/底面对齐和纯节点构造），
 * 只允许 Viewer 真实显示的 mesh/robot。ghost 放在独立 authoring 子树里，不进入 `objects`/部件目录/
 * 物理/主拾取/采集；身份 = session+scene+resource/version+本次 placement token。
 */
export interface ViewerPlacementPreviewSpec {
  token: string
  sceneId: string
  resourceId: string
  version: number
  entities: Entity[]
  /** 预览资源字节的专用解析器；与主 Scene 的授权路由分开，只由本次放置使用。 */
  resolveResource?: ViewerOptions["resolveResource"]
}
export interface ViewerPlacementPreviewResult {
  status: "PREVIEW" | "UNAVAILABLE" | "SUPERSEDED"
  reason?: string
  token?: string
}
/** 采集/观察里给模型看的**未应用装配预览**窄面：ghost 不是第二只手，只是未提交的临时显示。 */
export interface ViewerAssemblyPreviewFace {
  applied: false
  sourceEntityId: string
  targetEntityId: string
  targetBodyName: string
  sourceRootBodyName?: string
  worldId?: string
  sceneRevision?: number
  generation?: number
}
/**
 * 采集/观察里给模型看的**未应用旧件停放预览**窄面。它必须同时说清"哪件旧件、停在哪个世界位姿、
 * 还没应用"，否则截图里的额外一只手会被当成真实实例。
 */
export interface ViewerParkingPreviewFace {
  applied: false
  entityId: string
  positionM: [number, number, number]
  quaternionXyzw: [number, number, number, number]
  worldId?: string
  sceneRevision?: number
  generation?: number
}
/** 表面拾取结果：点/法线在**源真实根 body** 局部系中，可直接当 `robot_assembly_preview` 的 `kind:'pose'` 源安装面。 */
export interface ViewerSurfaceMountPick {
  entityId: string
  bodyName?: string
  positionM: [number, number, number]
  quaternionXyzw: [number, number, number, number]
  normalRootM: [number, number, number]
  hitPointWorld: [number, number, number]
}
/**
 * 独立的**输出画布**：录制/预览只从它取帧，不再从主画布直接 requestFrame。
 *
 * 原因：隐藏 helper → render → 恢复 helper → render 屏幕是同一个 JS 任务，但 canvas 的合成/取帧并不保证
 * 在同一个任务里发生；对主画布 `requestFrame()` 仍可能抓到恢复后的 dirty 帧。先把干净渲染同步
 * `drawImage` 到这块输出画布，再对输出画布取帧，视频内容就不再依赖浏览器何时合成主画布。
 */
function createCaptureSurface(width: number, height: number, host: HTMLElement): HTMLCanvasElement {
  if (typeof document === "undefined" || typeof document.createElement !== "function") throw new Error("VIEWER_CAPTURE_SURFACE_UNSUPPORTED: 当前环境不能创建独立输出画布")
  if (!host || typeof host.appendChild !== "function") throw new Error("VIEWER_CAPTURE_SURFACE_HOST_UNAVAILABLE: 当前 Viewer 没有可用的 DOM 父节点，不能建立连续视频流")
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  // 输出画布必须进入真实 DOM 的绘制生命周期，但只占 1×1 透明像素：不能在用户界面形成第二块画面。
  // 不能用 display:none/visibility:hidden（浏览器会跳过合成/采集），也不能让它获得焦点或改变布局。
  canvas.setAttribute("aria-hidden", "true")
  canvas.tabIndex = -1
  Object.assign(canvas.style, { position: "absolute", left: "0", top: "0", width: "1px", height: "1px", opacity: "0", pointerEvents: "none" })
  try { host.appendChild(canvas) } catch (failure) {
    detachCaptureSurface(canvas)
    throw new Error("VIEWER_CAPTURE_SURFACE_HOST_UNAVAILABLE: 当前 Viewer 的 DOM 父节点不能接收输出画布，不能建立连续视频流", { cause: failure })
  }
  return canvas
}

/** 只移除**本次**输出节点；宿主已提前移走/替换时保持幂等，绝不按选择器或兄弟位置误删别次画布。 */
function detachCaptureSurface(canvas: HTMLCanvasElement): void {
  const parent = canvas.parentNode
  if (!parent || typeof parent.removeChild !== "function") return
  try { parent.removeChild(canvas) } catch { /* 节点已被宿主移除或替换 */ }
}

function stopStreamTracks(stream: MediaStream | undefined): void {
  if (!stream) return
  try { for (const track of stream.getTracks()) { try { track.stop() } catch { /* 已结束 */ } } } catch { /* 无轨道列表 */ }
}

/** 只负责显示、本地选择/相机/gizmo；没有 step、下载索引、LLM 或机器人动作实现。 */
export class SceneViewer {
  readonly renderer: THREE.WebGLRenderer
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.01, 10000)
  readonly scene = new THREE.Scene()
  readonly projection = new FrameProjection()
  readonly controls: OrbitControls
  private readonly firstPerson: FirstPersonNavigation
  private navigationBar?:HTMLDivElement
  private navigationButtons:Array<{mode:"orbit"|"first-person";button:HTMLButtonElement}>=[]
  private navigationPreference?: "orbit" | "first-person"
  private observerSnapshot?: ViewerObserverState
  private observerListeners?: Set<() => void>
  /** 展示层状态（部件选择/炸开）的订阅者：面板据此在外部合拢/换身份后读回实际 0 状态，不新增轮询所有者。 */
  private presentationListeners?: Set<() => void>
  private observerLabel?: HTMLElement
  private observerExitButton?: HTMLButtonElement
  private navigationChanged=(event:Event)=>{const mode=(event as CustomEvent).detail;if(mode==="orbit"||mode==="first-person")this.setNavigationMode(mode,false)}
  private navigationStored=(event:StorageEvent)=>{if(event.key==="lyapunov.viewer.navigation"&&(event.newValue==="orbit"||event.newValue==="first-person"))this.setNavigationMode(event.newValue,false)}
  private readonly splatViewBounds=new WeakMap<THREE.Object3D,THREE.Box3>()
  private readonly transformControls: TransformControls
  private readonly objects = new Map<string, Loaded>()
  /**
   * 按解析后的 URL 缓存 GLTF：同一个 GLB 被 N 个实体引用时只解析一次，N 个可视对象是它的克隆——
   * 克隆只复制节点结构，**几何/材质/贴图仍是同一批实例**（three 的 clone 语义），这就是大场景里
   * "200 个实例 = 1 份几何 + 1 份贴图"的由来。缓存里的东西由 Viewer 独占，释放单个实体不销毁它们
   * （见 `release`/`disposeObject` 的 `sharedVisual` 判据）。
   */
  private readonly gltfs = new Map<string, Promise<GLTF>>()
  /**
   * 本 Viewer 独用的 glTF 装载器（**带 DRACO / KTX2 / meshopt 三种解码器**，由 `draco-decoder.ts` 唯一拥有）。
   *
   * 为什么不是每次读取都 `new GLTFLoader()`：带解码器的装载器一初始化就起 worker 池，一个 URL 一个
   * 装载器会在多 GLB 场景里起一堆 worker；而且解码器（内联字节，见该模块）只 base64 解码一次。
   * **懒建**：没有 glTF 要读时它是 `undefined`；不带压缩扩展的 glTF 走它也**不会**建 blob 或 worker。
   */
  private gltfLoaderInstance?: GLTFLoader
  /** 真实读取次数（缓存未命中才发起加载）与命中次数：验收要的是实际读数，不是"应该只读一次"。 */
  private readonly gltfStats = new Map<string, { loads: number; hits: number }>()
  /** LOD 交换累计次数（只有真的换了显示对象才 +1）。 */
  private lodSwitches = 0
  /** 每帧算 LOD 距离用的临时向量：大场景里每帧给 200 个实体各新建一个 Vector3 是不必要的垃圾。 */
  private readonly lodProbe = new THREE.Vector3()
  /** 同一批临时量：判据相机是世界坐标下的位置（按指定相机出图时那台相机不在场景图里，也要能算）。 */
  private readonly lodCamera = new THREE.Vector3()
  private spark?: SparkRenderer
  /** 大 splat 的解码/LOD 运行态；按 entityId 读回，不在每帧遍历 Gaussian。 */
  private splatRuntime: Map<string, { loadMs: number | null; sourceSplats: number | null; decodedSplats: number | null; lodEnabled: boolean; lodSplats: number | null; boundsSource: "metadata-centers" | "decoded-centers" | null; phase: "waiting-cache" | "initializing" | "bounds" | "ready" | "cancelled" | "failed"; firstDrawSubmittedMs: number | null; started: number; decodeCacheHit: boolean; decodeCacheWaitMs:number|null }> = new Map()
  private renderFrameSamplesMs: number[] = []
  private frameIntervalSamplesMs: number[] = []
  private lastRenderFrameStarted?: number
  private splatBudget:SplatInteractiveBudget = SPLAT_INTERACTIVE_BUDGET
  /** 当前 Scene 是否含已识别的"高精"高斯场景（新标准 v3，或大型旧 v2）；只影响 auto 画质默认预算。 */
  private recognizedHighSplat=false
  /** 内置环境光（RoomEnvironment 的 PMREM）：没有 HDRI 时的 IBL 兜底，也是 HDRI 加载失败后的退路。 */
  private readonly materialEnvironment: THREE.WebGLRenderTarget
  /**
   * 环境光照（`entity.components.environment`，格式唯一 owner 是 environment.ts）。
   * 组件来自 Scene 文档本身：`setScene` 每次重扫，因此 Agent 的 `scene_edit`、面板的提交、
   * 场景版本回退三条路都只走这一条应用通道，没有第二个环境状态。
   */
  private environment?: { carrier: string; component: SceneEnvironment; warnings: string[] }
  /** 昼夜的**渲染时钟**：只被 Viewer 的 rAF 推进，不写 Scene，不碰 world/frame（物理时间）。 */
  private environmentClock: EnvironmentClockState = { playing: false, offsetHours: 0, advancedSeconds: 0 }
  private environmentClockMs = 0
  /** 真的装到画面上的那份 HDRI：`ref` 是它的资源身份，用来和文档请求的那一份**按版本**比对。 */
  private environmentMap?: { key: string; uri: string; ref: { resourceId: string; version: number }; texture: THREE.Texture; target: THREE.WebGLRenderTarget }
  private environmentLoad?: { key: string; promise: Promise<void> }
  private environmentError?: string
  private environmentDiagnostics: EnvironmentScan["diagnostics"] = []
  /** 太阳到原点的距离：平行光只看方向，距离只决定阴影相机的覆盖（随场景尺度调整）。 */
  private sunDistance = 50
  /** 昼夜对背景/IBL 的当前系数（未开昼夜＝1）：天空盒与背景色都按它变暗，读数自洽。 */
  private backgroundDaylight = 1
  /** 几何版本号：实体资源增减时 ++，用来缓存场景包围球（阴影取景），昼夜播放的每帧不重算遍历。 */
  private geometryRevision = 0
  private sceneRadiusCache?: { revision: number; radius: number }
  private readonly hemisphere: THREE.HemisphereLight
  private readonly sun: THREE.DirectionalLight
  private preview?: THREE.Object3D
  private readonly splatBounds=new WeakMap<THREE.Object3D,THREE.Box3>()
  private lastFraming?:ReturnType<typeof fitPerspectiveBounds>
  private snapshot?: SceneSnapshot
  private world?: WorldHandle
  private selected?: string
  /**
   * 3D 变换手柄是**显式模式**：默认选中只保留细轮廓；只有用户在对象属性/快捷键里
   * 明确进入 Move/Rotate/Scale 时才挂上 TransformControls。
   */
  private transformEditing = false
  /** 当前高亮的部件（R-011）：只影响展示层高亮，不提交任何 Scene/物理改动。 */
  private selectedPart?: ViewerPartSelection
  /** 展示层炸开的**唯一状态**：哪台实体、展开多少。偏移只写 RobotVisual 的 presentation 组。 */
  private partExplode?: { entityId: string; spread: number; reason?: string }
  /**
   * R-012 临时装配预览 ghost：真实源几何的透明克隆 + 独立材质；不属于 Scene entities、不进入部件目录，
   * 换 scene/world/revision/generation、取消或销毁时清理。几何是共享的（克隆不复制 geometry），只销毁克隆材质。
   */
  private assemblyGhost?: {
    sourceEntityId: string; targetEntityId: string; targetBodyName: string
    sourceRootBodyName?: string
    targetBodyLocalName: string
    worldId?: string; sceneId?: string; sceneRevision?: number; generation?: number
    sourceResourceSignature?: string; targetResourceSignature?: string
    /** 安装局部关系（源根在目标 body 局部系）与源模型帧逆；每帧用当前目标 body 重算，只算一次会漂。 */
    install: THREE.Matrix4; rootFrameInverse: THREE.Matrix4
    sourceVisual: THREE.Object3D
    root: THREE.Group; visual: THREE.Object3D; marker: THREE.Group; materials: THREE.Material[]
  }
  /**
   * R-012 Replace 的旧末端停放预览 ghost：与装配 ghost 同源的真实几何透明克隆，但摆在**明确的世界停放位姿**，
   * 不跟随任何目标 body。它不是 Scene 实体、不进入物理；换身份/取消/提交时与装配 ghost 一并清理。
   */
  private parkingGhost?: {
    entityId: string
    worldPose: {positionM: [number, number, number]; quaternionXyzw: [number, number, number, number]}
    worldId?: string; sceneId?: string; sceneRevision?: number; generation?: number
    root: THREE.Group; visual: THREE.Object3D; materials: THREE.Material[]
  }
  /**
   * V10-08/38 真实资产放置 ghost：独立 authoring 子树，只由 `previewPlacement` 的临时实体构造。
   * 不写 `objects`/snapshot、不进部件目录/物理/拾取/采集；几何按原 Loader 约定共享，只销毁克隆材质。
   */
  private placementGhost?: { token: string; sceneId: string; resourceId: string; version: number; root: THREE.Group; materials: THREE.Material[]; dispose(): void }
  private placementPreviewGeneration = 0
  /** 源表面安装点拾取模式与临时标记（不属于 Scene 实体，不进目录/拾取）。 */
  private mountPick?: { entityId: string; rootBodyName: string }
  private mountPickMarker?: THREE.Group
  /** 高亮用的材质克隆（按 Mesh 记住原材质）：清除时必须逐项换回，绝不能改到共享材质本身。 */
  private partHighlight?: { entityId: string; partId: string; swaps: Array<{ mesh: THREE.Mesh; original: THREE.Material | THREE.Material[] }> }
  private collisionTopologyLayer?: CollisionTopologyLayer
  private robotAnchorLayer?: RobotAnchorLayer
  private disposed = false
  /** 活动连续视频流的手动取帧定时器清理句柄；Viewer 销毁时必须清掉，避免关闭后计时器泄漏。 */
  private captureStreamStops = new Set<() => void>()
  /**
   * 路线预览/录制的**临时**POV 相机。它不是场景相机、不是第二份持久状态：只在本轮 capture pass
   * 里供 `captureCanvasStream`/预览画布渲染；主视角、OrbitControls、物理时钟都不动。
   */
  private routeCaptureView?: ViewerCameraView
  private routeCaptureCamera?: THREE.PerspectiveCamera
  private generation = 0
  private raf = 0
  private readonly resize: ResizeObserver
  private editing = false
  private placing = false
  private placementTransformEnabled?: boolean
  private annotationTransformEnabled?: boolean
  private placeMarker?: THREE.Group
  private placeDown?: { x: number; y: number }
  private annotating = false
  private annotations: ViewerAnnotation[] = []
  private selectedAnnotation?: string
  private readonly markers = new Map<string, ReturnType<typeof buildAnnotationMarker>>()
  private readonly annotationRoot = new THREE.Group()
  /**
   * 相机视锥（DEV-038）：3D 里"看得见相机"的只读显示层。数据全部来自调用方喂的 `FrustumSpec[]`
   * （`camera_list` 回执经 `frustumFromReceipt`），本类**不算 K、不算 FK、不存第二份相机事实**。
   */
  private readonly cameraRigRoot = new THREE.Group()
  /** 路线轨迹（与 cameraRigRoot 分开）：临时路线显示不能覆盖/清除机器人已挂载机位。 */
  private readonly captureRouteRoot = new THREE.Group()
  /** 路线预览/录制中当前运动相机的独立 helper：不随站点重建，也不与机器人机位共用 owner。 */
  private readonly captureRouteCurrentRoot = new THREE.Group()
  private captureRouteCurrent?: THREE.Group
  private captureRouteCurrentLensKey = ""
  private readonly cameraRigs = new Map<string, CameraRigRecord>()
  private cameraRigSelected?: string
  /** 只保存导航返回位；跟随姿态来自原生相机回执或同 Frame 快照，没有第二份安装状态。 */
  private cameraRigPilot?: { key: string; source: FrustumSpec['source']; sceneId?: string; lens: boolean; returnView: ViewerViewState; distance: number }
  private cameraRigFrameId?: string
  private cameraRigScopeKey?: string
  /** 实际已经应用到场景图的Frame，接收未显示的Frame不得冒充authoring采样。 */
  private displayedFrame?: Frame
  private cameraRigEditBaseline?: { key: string; position: number[]; quaternion: number[]; intrinsics?: ViewerCameraIntrinsics }
  private cameraRigEditLens?: ViewerCameraIntrinsics
  private cameraRigLook?: { returnView:ViewerViewState; sceneId?:string; distance:number; controlsEnabled:boolean }
  private cameraRigSave?: { key: string; group: THREE.Group; scope?: string; enabled: boolean; promise?: Promise<void> }
  private cameraRigEditError?: string
  private cancellingCameraEdit = false
  /**
   * 取景框（用户反馈④）：Pilot"透过该相机看"后标注**实际可拍摄范围**——线框与投影共用同一份映射
   * （`captureGateRect`），所以它就是"透过这台相机看"看到的整块视口；只存这台相机的 K，不存相机事实。
   */
  private captureGateSpec?: { intrinsics: ViewerCameraIntrinsics }
  /** 画取景框那一刻相机长什么样的指纹：相机被导航/预设/全景/换相机改掉后，旧的框必须消失（不能继续冒充当前相机）。 */
  private captureGateView?: { position: THREE.Vector3; quaternion: THREE.Quaternion; projection: number[] }
  private readonly captureGateSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  /** 点选视锥时回调读数卡数据（Shell 挂载；`undefined`＝取消选中）。 */
  onCameraRigSelect?: (spec: FrustumSpec | undefined) => void
  /** S3（判据 4）：gizmo 拖拽结束回调（世界＋局部两套位姿；参考系判定见 `cameraAdjustFromDrag`）。 */
  onCameraRigEdit?: (key: string, edit: ViewerCameraEdit) => void | Promise<unknown>
  private cameraRigGizmoKey?: string
  private readonly grid = new THREE.GridHelper(20, 40, 0x48515f, 0x282f3a)
  private readonly axes = new THREE.AxesHelper(0.5)
  private display: ViewerDisplaySettings = { ...DEFAULT_VIEWER_DISPLAY }
  /**
   * 当前生效的**照片内参**，按"应用它时"的画布尺寸记。`undefined` = 普通镜头（fov + 宽高比就够，没有视口偏移）。
   *
   * 为什么留着它：窗口 resize 不能把照片相机退化成居中针孔。three 的 `PerspectiveCamera` 只存
   * 视口偏移的绝对值，画布一变这些值就过期（fov 是"整幅虚拟图"的视场，子视口位置按像素算）；
   * 这里留着原尺寸的 K，resize 时按新尺寸等比缩放再写回去，于是**投影方向与主点占比都不变**。
   */
  private appliedIntrinsics?: ViewerCameraIntrinsics
  readonly loadingErrors = new Map<string, string>()
  /**
   * 资源**加载成功、但画面里缺件**的警告（按实体）：缺网格、某张 mesh 取不到、URDF 关节缺 link。
   *
   * 为什么与 `loadingErrors` 分开：那张表的意思是"这个实体没加载成功"（画面里根本没有它），这张表的意思是
   * "它画出来了，但少了点什么"。混成一张表的后果是真实的（2026-09-20 集成审计 P1-1）：`viewer_observe`
   * 会把"有警告的机器人场景"当加载失败**永久拒拍**，模型还会照错误去修一个并不存在的问题。
   * 归属跟 `Loaded` 走：换资源/实体被移除/加载失败时随 `release` 或失败路径清掉，不会挂在同一个 entityId 上。
   */
  readonly visualWarnings = new Map<string, string[]>()
  /** Scene 灯的可见性开关（模型/用户可切）。默认开：作者打了光就该看见。 */
  private sceneLightsVisible = true
  /** 正在播放的烘焙动画（按实体）。与物理帧是两条独立时间轴，互不写对方状态。 */
  private readonly mixers = new Map<string, { mixer: THREE.AnimationMixer; clips: THREE.AnimationClip[]; paused: boolean; reference?: StaticAnimationReference; referenceKey?: string; visualPreview?: boolean }>()
  private animationsPlaying = true
  private animationSnapshot?: SceneSnapshot
  private animationEntities?: Map<string, Entity>
  private animationClock = 0

  constructor(private readonly options: ViewerOptions) {
    if (options.splatRetentionScope) retainedSplats.activateHost(options.splatRetentionScope.hostInstanceId)
    // DEV-039：WebGL 创建失败必须是**可解释的失败**，不是 three.js 的原始异常。
    // 客户机上 WebGL 可能因为「没有 GPU／驱动挂了／浏览器禁了硬件加速／远程会话无 GL」而不存在；
    // 抛成带 code 的类型后，上层能分辨这是"环境缺能力"而非"场景坏了"，从而显示
    // "3D 渲染不可用 + 处置建议"，而不是让异常冒到 slot 渲染边界、把标签页留成空白。
    try {
      // Spark 2.0 的高斯混合不受益于 MSAA，多采样会额外放大大场景的 GPU 填充开销。
      this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, preserveDrawingBuffer: true })
    } catch (error) {
      throw new WebGLUnavailableError(error)
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, SPLAT_INTERACTIVE_BUDGET.maxPixelRatio))
    this.refreshSplatBudget()
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    // 金属 PBR 材质需要反射环境；仅有方向光时会近乎黑色。
    const environment = new RoomEnvironment()
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.materialEnvironment = pmrem.fromScene(environment, 0.04)
    this.scene.environment = this.materialEnvironment.texture
    this.scene.environmentIntensity = 0.7
    environment.dispose(); pmrem.dispose()
    this.scene.background = new THREE.Color(0x242a32)
    this.camera.up.set(0, 0, 1)
    this.camera.position.set(5, -6, 4)
    this.renderer.domElement.addEventListener("pointerdown", this.orbitFocusPointer, true)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    // 左键保留选择，右键保留原生上下文菜单；OrbitControls 的 Shift+中键路径自动平移。
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: null } as unknown as typeof this.controls.mouseButtons
    this.controls.enableDamping = false
    this.firstPerson=new FirstPersonNavigation(this.camera,this.renderer.domElement,this.controls.target,()=>this.setNavigationMode("orbit"),()=>this.worldUp())
    this.initializeNavigationBar()
    let navigation:"orbit"|"first-person"="first-person"
    try{if(localStorage.getItem("lyapunov.viewer.navigation")==="orbit")navigation="orbit"}catch{}
    this.setNavigationMode(navigation,false)
    window.addEventListener("lyapunov-viewer-navigation",this.navigationChanged)
    window.addEventListener("storage",this.navigationStored)
    this.controls.target.set(0, 0, 0.7)
    this.controls.update()
    // 基础环境光：保证"作者没打灯"或"用户关掉 Scene 灯"时场景仍可读；不参与打光设计。
    // 这两盏灯同时是环境组件的落点（hemisphereIntensity / sun.*），**不新开第二套灯**：
    // 没有环境组件的旧场景读到的仍是这里写死的旧读数（见 applyEnvironment 的 LEGACY_LIGHTING）。
    this.hemisphere = new THREE.HemisphereLight(0xe7efff, 0x47515c, 2.4)
    this.scene.add(this.hemisphere)
    this.sun = new THREE.DirectionalLight(0xffffff, 3); this.sun.position.set(5, -4, 8); this.scene.add(this.sun)
    this.grid.rotateX(Math.PI / 2); applyViewerGridDepthPolicy(this.grid); this.scene.add(this.grid)
    this.scene.add(this.axes)
    this.annotationRoot.name = ANNOTATION_ROOT_NAME
    markAuthoringHelper(this.annotationRoot)
    this.scene.add(this.annotationRoot)
    this.cameraRigRoot.name = "lyapunov-camera-rigs"
    markAuthoringHelper(this.cameraRigRoot)
    this.scene.add(this.cameraRigRoot)
    this.captureRouteRoot.name = "lyapunov-capture-route"
    markAuthoringHelper(this.captureRouteRoot)
    this.scene.add(this.captureRouteRoot)
    this.captureRouteCurrentRoot.name = "lyapunov-capture-route-current"
    markAuthoringHelper(this.captureRouteCurrentRoot)
    this.scene.add(this.captureRouteCurrentRoot)
    markAuthoringHelper(this.grid)
    markAuthoringHelper(this.axes)
    this.captureGateSvg.setAttribute("class", "lya-capture-gate")
    this.captureGateSvg.setAttribute("aria-hidden", "true")
    Object.assign(this.captureGateSvg.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: "5" })
    options.container.appendChild(this.captureGateSvg)
    options.container.appendChild(this.renderer.domElement)
    this.transformControls = new TransformControls(this.camera, this.renderer.domElement)
    markAuthoringHelper(this.transformControls.getHelper())
    this.scene.add(this.transformControls.getHelper())
    this.transformControls.addEventListener("dragging-changed", event => {
      if (this.placing || this.annotating) return // 放置/批注独占指针，旧gizmo迟到事件不能提交实体。
      if(this.cancellingCameraEdit){this.editing=false;this.syncObserverControls();return}
      this.editing = Boolean(event.value)
      this.syncObserverControls()
      if (!this.editing) {
        // 归属不能混：gizmo 挂在视锥上 ⇒ 报告拖拽结果（S3）；挂在实体上 ⇒ 走既有实体编辑提交。
        if (this.cameraRigGizmoKey !== undefined) void this.emitCameraRigEdit().catch(error=>options.onError?.(error))
        else if (options.commitEdit) {
          // CAS尚未返回时保留拖动结果；恢复帧投影会把它覆盖回旧位姿。
          this.editing = true; this.controls.enabled = false; this.transformControls.enabled = false
          void this.finishEdit().catch(error => options.onError?.(error)).finally(() => { this.editing = false;if(!this.disposed){const enabled=Boolean(this.options.commitEdit);if(this.placing)this.placementTransformEnabled=enabled;if(this.annotating)this.annotationTransformEnabled=enabled;this.transformControls.enabled=!this.placing&&!this.annotating&&enabled;this.syncObserverControls()} })
        }
      }
    })
    this.transformControls.addEventListener("objectChange",()=>{if(this.cameraRigGizmoKey!==undefined)this.publishObserverState()})
    this.renderer.domElement.addEventListener("keydown",this.observerKeyDown,true)
    this.renderer.domElement.addEventListener("contextmenu", this.contextPointer)
    this.renderer.domElement.addEventListener("pointerdown", this.selectPointer)
    this.renderer.domElement.addEventListener("pointerup", this.placePointer)
    this.renderer.domElement.addEventListener("pointerdown", this.annotatePointer)
    this.resize = new ResizeObserver(() => this.resizeCanvas())
    this.resize.observe(options.container)
    this.resizeCanvas()
    this.renderLoop()
  }
  private resizeCanvas(): void {
    const width = this.options.container.clientWidth, height = this.options.container.clientHeight
    if (width <= 0 || height <= 0) return
    this.renderer.setSize(width, height)
    this.camera.aspect = width / height
    // 内参按新画布尺寸等比缩放后重新写进相机（视场与主点占比不变，像素焦距/主点随尺寸走）。
    // 没有内参时就是原来的宽高比更新。注意读的是**着色缓冲**尺寸（CSS × devicePixelRatio），
    // 因为内参、截图与 `capture()` 报的像素尺寸都在同一套像素里。
    if (this.appliedIntrinsics) {
      const size = this.canvasPixels()
      setCameraIntrinsics(this.camera, scaleIntrinsics(this.appliedIntrinsics, size.width, size.height))
    } else this.camera.updateProjectionMatrix()
    this.updateCaptureGate()
  }
  /** 着色缓冲（device 像素）尺寸：截图、内参与 `pose().imageWidth` 都在这套像素里。 */
  private canvasPixels(): { width: number; height: number } { const canvas = this.renderer.domElement; return { width: canvas.width, height: canvas.height } }
  /**
   * 归一化请求时的"此刻是什么样"：位置、姿态（含 roll）、转心、镜头、裁剪面、内参。
   * 姿态那一项不能省：只改 fov/near 的部分更新要靠它沿用当前 roll（否则只能按 target 重新 lookAt，roll 归零）。
   */
  private cameraCurrent(): ViewerCameraCurrent {
    const measurement = describeCameraView(this.camera, this.canvasPixels())
    return {
      position: measurement.position, quaternion: measurement.quaternion, cameraUp: measurement.up,
      target: this.controls.target.toArray() as ViewerVec3,
      fovYDeg: measurement.fovYDeg, near: measurement.near, far: measurement.far,
      targetDistanceM: this.camera.position.distanceTo(this.controls.target),
      ...isPlainLens(measurement.intrinsics) ? {} : { intrinsics: measurement.intrinsics },
    }
  }
  /**
   * 把归一化后的视角真正落到相机上：位置/姿态/up/内参/裁剪面一次写完，转心落在视线正前方，再让
   * `controls.update()` 复算一次姿态（render 循环本来每帧都会调它，这里先调一遍是为了**当场核对**）。
   *
   * 核对不通过就抛错、不返回"看起来成功"的读数：那正是"相机应用了但图不对"最难查的情形。
   */
  private writeCameraView(view: ViewerCameraView): void {
    const size = this.canvasPixels()
    // 写相机 + 转心 + controls 复算姿态 + 当场核对：顺序与判据都在 camera-view.ts 那一份实现里
    // （测试对着同一份跑，测试里不重写一遍顺序）。
    const damping=this.controls.enableDamping,autoRotate=this.controls.autoRotate
    // 先释放前一次自由导航的惯性，再应用标定；禁用输入本身不会停止OrbitControls.update的残余增量。
    this.controls.enableDamping=false;this.controls.autoRotate=false;this.controls.update()
    try{
      // 传感器观察锁定时只写完整光学姿态；Orbit的极点makeSafe不能挪动真实顶视相机。
      if(this.cameraRigPilot||this.cameraRigLook)this.controls.target.set(...view.target)
      const verification = writeViewToCamera(this.camera, this.cameraRigPilot||this.cameraRigLook?undefined:this.controls, view, size)
      this.appliedIntrinsics = view.intrinsics
      if (!verification.ok) throw new ViewerCameraError("VIEWER_CAMERA_APPLY_MISMATCH", `相机没有按请求复现（应用后当场测量）：${verification.errors.join("；")}`)
    }finally{this.controls.enableDamping=damping;this.controls.autoRotate=autoRotate}
  }
  /** 取景会重设视场：照片内参（视口偏移）随之失效，必须一起清掉，否则会留下"按旧 fov 算的偏移"。 */
  private clearAppliedIntrinsics(): void { this.appliedIntrinsics = undefined; this.camera.clearViewOffset() }
  private renderLoop = (): void => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.renderLoop)
    this.renderFrame()
  }
  /**
   * 一帧的实际工作（`renderLoop` 只负责排下一帧）。单独一个方法是为了**可执行地测**这一帧：
   * `renderLoop` 是构造时赋值的箭头字段，`Object.create(原型)` 的测试夹具拿不到它，而"取景框每帧是否
   * 对得上当前相机"正是这一帧里的行为（`bun test packages/viewer/test/capture-gate-view.test.ts`）。
   */
  private renderFrame(): void {
    this.refreshNavigationCopy()
    const frameStarted = performance.now()
    const intervals = this.frameIntervalSamplesMs ?? (this.frameIntervalSamplesMs = [])
    if (this.lastRenderFrameStarted !== undefined) appendFrameSample(intervals, frameStarted - this.lastRenderFrameStarted)
    this.lastRenderFrameStarted = frameStarted
    const frame = !this.editing ? this.projection.consume() : undefined
    if (frame) this.applyFrame(frame)
    this.firstPerson?.update()
    if(this.cameraRigLook)this.applyCameraRigLook()
    if(!this.cameraRigPilot&&!this.cameraRigLook&&!this.firstPerson?.active)this.controls.update()
    // 取景框只对"当时那台相机、那份投影"成立：用户一导航（OrbitControls 每帧都可能改相机）/预设/全景/
    // 换相机，旧的框就不再代表当前画面，立即收起。检查点放在 controls.update() 之后，读的就是将要渲染的那台相机。
    if (this.captureGateSpec && this.captureGateStale()) { this.captureGateSpec = undefined; this.captureGateView = undefined; this.updateCaptureGate() }
    // LOD 在相机更新之后、渲染之前决定这一帧用哪一级：交换只改显示对象，不碰 Scene/物理/动画时间轴。
    this.updateLod()
    this.advanceAnimations()
    // 昼夜走**渲染时钟**（与烘焙动画同一条"只改显示"的路）：绝不推进 world/frame/simTime。
    this.advanceDayNight()
    // 批注每帧按实体当前世界矩阵重新落位：这正是"转相机/移动实体后标记仍钉在原处"的执行点。
    this.updateAnnotationMarkers()
    // 底座/TCP 标签与批注标记同一条屏幕尺寸判据：不按米缩放，近景不糊住机器人。
    this.robotAnchorLayer?.updateLabels(this.camera, this.renderer.domElement.getBoundingClientRect().height || this.renderer.domElement.height)
    if (this.options.container.clientWidth > 0 && this.options.container.clientHeight > 0) this.renderer.render(this.scene, this.camera)
    if (this.spark?.activeSplats && this.options.container.clientWidth > 0 && this.options.container.clientHeight > 0) {
      for (const [id, state] of this.splatRuntime ?? []) {
        const loaded = this.objects.get(id), selected = loaded?.splat && this.spark.lodInstances.get(loaded.splat)
        if (state.phase === "ready" && state.firstDrawSubmittedMs === null && loaded?.group.visible && selected && selected.numSplats > 0)
          state.firstDrawSubmittedMs = performance.now() - state.started
      }
    }
    appendFrameSample(this.renderFrameSamplesMs ?? (this.renderFrameSamplesMs = []), performance.now() - frameStarted)
  }
  async setScene(snapshot: SceneSnapshot): Promise<void> {
    if (this.disposed) throw new Error("VIEWER_DISPOSED")
    if (this.snapshot?.sceneId === snapshot.sceneId && snapshot.revision < this.snapshot.revision) return
    const sameScene = this.snapshot?.sceneId === snapshot.sceneId
    // 换场景版本/换场景：旧部件选择、高亮与展示层展开一律按身份清掉，绝不让上一版资源停留在展开态。
    // 先用 restore 让被炸开时让位的 Transform gizmo 回到选中实体上，再清选择/高亮。
    if (this.snapshot && (this.snapshot.sceneId !== snapshot.sceneId || this.snapshot.revision !== snapshot.revision)) { this.clearAssemblyPreview(); this.restorePartExplode(); this.clearPartState(); this.clearSurfaceMountMarker(); this.mountPick = undefined }
    if (this.snapshot?.sceneId !== snapshot.sceneId || this.snapshot?.revision !== snapshot.revision) for (const loaded of this.objects.values()) this.clearDynamicGeometry(loaded)
    if (this.snapshot?.sceneId !== snapshot.sceneId) {
      // 换 Scene 时临时放置 ghost 一律清掉；迟到加载由 token/generation 拒绝复活。
      this.clearPlacementPreview()
      // 不让相同 entityId 的新场景复用旧场景尚未结束的泼溅初始化。
      for (const [id, loaded] of this.objects) if (loaded.pendingSplat || loaded.pending && loaded.planVisual?.kind === "splat") {
        this.release(loaded); this.objects.delete(id); this.mixers.delete(id)
      }
    }
    // 临时路线 POV 只属于发出它的那轮 capture；切 Scene 时立即清掉，绝不让旧 POV 继续渲染新场景。
    if (this.snapshot?.sceneId !== snapshot.sceneId) this.clearRouteCaptureView()
    if (this.world && this.world.sceneId !== snapshot.sceneId) this.setWorld(undefined)
    const generation = ++this.generation
    if(this.snapshot?.sceneId!==snapshot.sceneId||this.snapshot?.revision!==snapshot.revision)this.displayedFrame=undefined
    this.snapshot = structuredClone(snapshot)
    // auto 画质默认预算随 Scene 里的"已识别高精"事实变化：新标准 v3，或大型旧 v2。普通/未知资产
    // 不置位。必须在下面创建 SparkRenderer 之前刷新（startLoad 里的初始化读的就是 this.splatBudget）。
    this.recognizedHighSplat = snapshot.entities.some(entity => recognizedHighSplatVisual(entity.components.visual as Record<string, unknown> | undefined))
    this.refreshSplatBudget()
    this.projection.setScene(snapshot)
    this.syncRobotAnchors()
    this.syncCollisionTopology()
    this.setSceneEnvironment(scanSceneEnvironment(snapshot))
    if (this.world && this.world.sceneId === snapshot.sceneId && this.world.appliedSceneRevision !== snapshot.revision) this.projection.clear()
    // 已保存的固定机位直接来自 Scene；不等 world ready，也不等待大资源再次加载。
    this.setCameraRigs([])
    for (const [entityId, loaded] of this.objects) {
      if (!snapshot.entities.some(entity => entity.entityId === entityId)) { this.release(loaded); this.objects.delete(entityId); this.mixers.delete(entityId); this.splatRuntime?.delete(entityId) }
    }
    // DEV-010（N227 rev，方案 B）：本循环是**同步全量 CPU**（1120 实体在单帧内建灯/包 Group/挂树），
    // 会把主线程排满 ⇒ 大场景下 `Runtime.evaluate`/输入成片超时。每 64 个实体让出一次事件循环：
    // N 取 64 与既有读取并发 `LOAD_CONCURRENCY`（:277 同值）同阶——单个 CPU 分片的量与"一批读取"相当，
    // 1120 实体约 17 次让出，总开销可忽略，但足以让渲染与输入在分片之间跑。不新增类/配置/依赖。
    // 就绪语义不变：本循环仍是 `setScene` 内的顺序 `await`，只有全部实体处理完才继续往下（:567-568 的"这一版已就绪"仍在其后到达）。
    let yielded = 0
    for (const entity of snapshot.entities) {
      if (++yielded % 64 === 0) await new Promise(resolve => setTimeout(resolve, 0))
      // ── Scene 里的灯：这是"打光"能不能看到的关键一环 ──────────────────────────
      // 此前 Viewer 只用构造时硬编码的两盏灯，完全忽略 Scene；Blender 打的灯因此不可见
      // （官方建筑 case 的"可开关顶灯"也就不成立）。这里把带 `light` 组件的实体建成 THREE 灯，
      // 每个实体一个 `THREE.Group` 包着，变换仍走既有 applyTransform 路径，不新增定位逻辑。
      const light = entity.components.light as SceneLight | undefined
      if (light) {
        const signature = JSON.stringify({ light })
        let loaded = this.objects.get(entity.entityId)
        if (loaded && loaded.signature !== signature) {
          // 改灯参数保留当前实体 Group/选择，属性面板可连续调整。
          if (loaded.group.userData.sceneLight) { loaded.group.clear(); loaded.signature = signature; loaded.lodWarnings = [] }
          else { this.release(loaded, sameScene); this.objects.delete(entity.entityId); loaded = undefined }
        }
        if (!loaded) {
          loaded = { group: new THREE.Group(), signature, lodWarnings: [] }
          loaded.group.name = entity.name
          loaded.group.userData.entityId = entity.entityId
          loaded.group.userData.sceneLight = true
          this.objects.set(entity.entityId, loaded)
        }
        if (!loaded.group.children.length) {
          loaded.group.add(buildSceneLight(light))
          if (light.kind === "area" && light.shape && !["rectangle", "square"].includes(light.shape)) loaded.lodWarnings.push(`AREA_SHAPE_RECTANGULAR: ${light.shape} uses a rectangular emitter in the viewer; area lights do not cast shadows`)
        }
        loaded.group.userData.loaded = true
        this.refreshVisualWarnings(entity.entityId, loaded)
        applyTransform(loaded.group, entity.transform)
        loaded.group.visible = this.sceneLightsVisible&&entity.components.visual?.visible!==false
        continue
      }
      // 节点显隐只改变 Group 状态；不释放/重新读取大模型或点云，也不改变资源版本。
      const {visible:_visible,...visual}=entity.components.visual??{}
      const signature = JSON.stringify({ resources: entity.resources, visual })
      let loaded = this.objects.get(entity.entityId)
      if (loaded && loaded.signature !== signature) { this.release(loaded, sameScene); this.objects.delete(entity.entityId); loaded = undefined }
      if (!loaded) {
        loaded = { group: new THREE.Group(), signature, lodWarnings: [] }
        loaded.group.name = entity.name
        loaded.group.userData.entityId = entity.entityId
        this.objects.set(entity.entityId, loaded)
      }
      applyTransform(loaded.group, entity.transform)
      loaded.robot?.resetPose()
      loaded.group.visible = entity.components.visual?.visible !== false
      this.applyEntityMaterial(loaded)
      this.trackAnimation(entity.entityId, loaded)
    }
    // DEV-010（N227 rev，方案 B）：同上（挂树循环）——每 64 个实体让出一次事件循环。
    let yieldedParent = 0
    for (const entity of snapshot.entities) {
      if (++yieldedParent % 64 === 0) await new Promise(resolve => setTimeout(resolve, 0))
      const group = this.objects.get(entity.entityId)!.group
      const parent = entity.parentId ? this.objects.get(entity.parentId)?.group : this.scene
      if (!parent) throw new Error(`VIEWER_PARENT_MISSING: ${entity.parentId}`)
      if (group.parent !== parent) parent.add(group)
    }
    this.scene.updateMatrixWorld(true)
    for (const entity of snapshot.entities) if (entity.components.light) orientAreaLight(this.objects.get(entity.entityId)!.group, entity.components.light as SceneLight)
    for (const loaded of this.objects.values()) {
      loaded.group.updateWorldMatrix(true, false)
      loaded.documentWorldMatrix = loaded.group.matrixWorld.clone()
    }
    /**
     * 这一版实体的资源加载：**有界并发 + 可中断**，判据与旧实现逐条相同——签名没变的实体复用同一次
     * 在途读取，已经加载成功的直接跳过，这一版要求的实体全部落定（成功或失败）后 promise 才 resolve。
     *
     * 为什么不再 `Promise.all(entities.map(startLoad))`：那会在同一轮里对快照里的每个实体同时发起读取。
     * 大场景实测 1120 实体 / 1119 个 GLB：上千个读取与解析的回调把主线程排满，重载期间
     * `Runtime.evaluate` 与 `Input.dispatchMouseEvent` 成片超时——DEV-010 记录的"reload 时渲染器失去
     * 响应"就是这个形状。有界并发把突发变成稳定的流：先出结果的对象先进画面（渐进），解析之间主线程
     * 能跑渲染与输入。
     *
     * 可中断：生成号变了（更新的一版 `setScene` 已经开始）或 Viewer 已销毁，就不再**起新的**读取；
     * 已经在途的那些仍按 `startLoad` 既有的归属判据收尾（迟到的成功不挂到新对象、旧失败不写新台账），
     * 所以中断既不会漏掉这一版要的资源，也不会写坏下一版的状态。
     */
    let cursor = 0
    const loadNext = async (): Promise<void> => {
      while (cursor < snapshot.entities.length && !this.disposed && generation === this.generation) {
        const entity = snapshot.entities[cursor++]!
        const loaded = this.objects.get(entity.entityId)!
        // 这个实体的资源可能**上一次 setScene 就已经在加载**（entity/resources/visual 签名没变 ⇒ 复用同一个
        // Loaded 对象；典型的例子是 R0 的大 GLB 还在读，用户/Agent 只移动了它的位置就提交 R1）。
        // 这时必须等那次真实加载，不能看 `userData.loaded` 就跳过：那个标记在 await 之前置位，只表示
        // "已经起过加载"；据此提前 resolve 会让上层（workbench 就绪登记 / viewer_observe）把还没有模型的
        // 版本当成"已加载完成"，拍出缺对象的画面。已经成功加载过的才直接跳过。
        const inFlight = loaded.pending ?? (loaded.group.userData.loaded ? undefined : this.startLoad(entity, loaded))
        if (inFlight) await inFlight
      }
    }
    await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, snapshot.entities.length) }, loadNext))
    // 环境光同样属于"这次 setScene 加载完了没有"：HDRI 没进画面就不能算这一版已就绪
    // （上层拍图/登记就绪读的正是这个 promise 的完成事实）。
    const environment = this.syncEnvironmentMap()
    if (environment) await environment
    if (generation === this.generation) {
      // Scene锁更新只刷新实体gizmo，命名相机安装编辑仍保留其当前gizmo owner。
      if(this.cameraRigGizmoKey===undefined)this.setEditCommit(this.options.commitEdit)
      if (this.projection.current()) this.applyFrame(this.projection.current()!)
      this.setCameraRigs([])
    }
  }
  /**
   * 一个实体的资源加载生命周期：每个 Loaded 同时只有一次在途加载（`loaded.pending` 持有它）。
   *
   * 只有**成功**才把 `userData.loaded` 置真：早期实现是在 await 之前置位的，于是"加载中"和"加载完"
   * 在对象上无法区分，同资源的后续 setScene 会跳过等待。失败时错误留在 `loadingErrors`（成功但缺件的
   * 警告在另一张表 `visualWarnings`，两张表不混用）、`pending` 清空，
   * 下一次 setScene 重新尝试（可重试）；本次 setScene 的 promise 照常 resolve，失败由台账/onError 报告。
   * 资源被替换（签名变了 ⇒ 换成了别的 Loaded）或 Viewer 已销毁时，**成功与失败两侧用同一条归属判据**：
   * 旧结果就地丢弃——成功的不挂到新对象上，迟到的失败也不写进新实体的台账。
   */
  private startLoad(entity: Entity, loaded: Loaded): Promise<void> {
    const attempt = (async () => {
      try {
        this.loadingErrors.delete(entity.entityId)
        // 这一次加载还没出结果，上一版的缺件警告就不再是"当前画面"的事实：不清的话，换了资源但这次没有警告时，
        // 旧警告会留在同一个 entityId 上（`if (warnings.length)` 只写不清，正好漏这一种）。
        this.visualWarnings.delete(entity.entityId)
        loaded.lodWarnings = []
        loaded.planVisual = entity.components.visual as Record<string, unknown> | undefined
        const visual = await this.loadVisual(entity, loaded)
        // 没有 `components.visual` 的实体**不会进画面**（`loadVisual` 的首个判据），但这不是"还在加载"、
        // 也不是失败：以前这里什么都不说，于是"声明了原生模型/资源、画布却空着"只能靠猜（真实案例：
        // 手写 MJCF 场景只在 `components.mujoco` 里给几何，Viewer 静默不显示）。如实记一条缺件说明：
        // MJCF/URDF 视觉要 `visual.kind="robot"`（robot=解析后的文档），资源视觉要给出 visual 表示。
        if (!visual && entity.components.visual === undefined && (entity.resources?.length || entity.components.mujoco || entity.components.isaac)) {
          const native = entity.components.mujoco !== undefined || entity.components.isaac !== undefined
          loaded.lodWarnings.push(`VIEWER_VISUAL_COMPONENT_MISSING: 实体声明了${native ? "原生模型" : ""}${native && entity.resources?.length ? "和" : ""}${entity.resources?.length ? "资源" : ""}但没有 components.visual，Viewer 不显示它；MJCF/URDF 用 components.visual={kind:"robot",robot:解析后的文档}`)
        }
        if (this.disposed || this.objects.get(entity.entityId) !== loaded) { if (visual) disposeObject(visual); return }
        if (visual) {
          loaded.baseVisual = visual; loaded.visual = visual; loaded.group.add(visual)
          // ENV-24：贴图引用了但没有对应 UV 通道时，画面会静默退化成基色常量——记进**既有**的缺件
          // 警告表（与导出侧 world.py 的 losses 同一口径），让 viewer_observe 能看见，而不是只有像素能看出来。
          loaded.lodWarnings.push(...textureUvWarnings(visual))
        }
        // 成功但有缺件：记进 `visualWarnings` 而不是失败台账。归属与下面失败侧同一条判据——只有当前这个
        // Loaded 的警告才记（上面的身份检查已经挡掉"迟到的旧结果"）。
        this.setupLod(entity, loaded)
        this.applyEntityMaterial(loaded)
        this.refreshVisualWarnings(entity.entityId, loaded)
        loaded.group.userData.loaded = true
        this.applyDisplay(loaded)
        // 资源加载完成后部件目录才真正可读：播报一次，已打开的面板据此从"空"切到真实部件/展开状态。
        this.notifyPresentationState()
        // 新几何进画面：场景包围球变了，阴影取景要跟着重取（否则大模型的光影只覆盖到加载前那一小块）。
        this.geometryRevision++
        if (this.sun.castShadow) this.applyEnvironment({ meshes: false })
        // 烘焙动画的 mixer 是在这里（异步加载）才建出来的。**必须在这里登记**：
        // 上面那轮登记发生在加载完成之前，首次 setScene 时 loaded.mixer 还不存在。
        // 只在上面登记 ⇒ 第一次载入的场景永远不进播放表，`setAnimationsPlaying`/`animationSummary`
        // 报 0 clip、`advanceAnimations` 空转，要等下一次场景版本变更才"突然"动起来。
        this.trackAnimation(entity.entityId, loaded)
      } catch (error) {
        // 归属核对与成功路径**同一条判据**：只有这次失败属于当前这个 Loaded 才记。
        // 否则"迟到的失败"会写进同一个 entityId 的台账：典型情形是资源 A 还在读的时候实体换成了资源 B
        // （签名变了 ⇒ 新 Loaded），B 先成功并把 `userData.loaded` 置真，之后 A 才失败——这条陈旧错误
        // 会让后续 setScene 直接跳过加载（成功过就不再清台账）、`loadingErrors` 里永远留着一条，
        // 于是 `viewer_observe` 会**永久拒绝**一个实际已经完整的画面。旧结果的失败与新实体无关，静默丢弃
        // （与成功路径丢弃旧视觉一样）：新资源自己的失败会在它自己的 attempt 里照常记录。
        if (this.disposed || this.objects.get(entity.entityId) !== loaded) return
        // 基础级别（分辨率最高的那一级）读不出来时，先用**能读到的派生级别**把实体显示出来：
        // 画面里不出现"整个对象凭空消失"。这不是成功——降级事实进缺件警告（`visualWarnings`，采集照拍并
        // 如实上报），不写失败台账、不调 onError：那两条通道的意思是"这个实体没显示出来"。
        if (await this.tryLodFallback(entity, loaded, error)) return
        loaded.group.userData.loaded = false
        // 失败就是失败：这个实体没有成功加载完的版本，`visualWarnings` 里不能再留着"部分可见"的说法。
        this.visualWarnings.delete(entity.entityId)
        this.loadingErrors.set(entity.entityId, String(error))
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
      }
    })()
    loaded.pending = attempt
    // 这次尝试结束（成功或失败）后清空在途标记：失败允许下一次 setScene 重试，成功则下次直接跳过。
    const settled = () => { if (loaded.pending === attempt) loaded.pending = undefined }
    void attempt.then(settled, settled)
    return attempt
  }
  /**
   * 读一个实体的**基础级别**可视对象（`visual` 表示）。GLB 通过 `loadGltfObject` 走按 URL 的缓存：
   * 同一份资产被 N 个实体引用时只解析一次，N 个克隆共享同一批几何/材质/贴图实例。
   */
  private async loadVisual(entity: Entity, loaded: Loaded, resolveResource: ViewerOptions["resolveResource"] = this.options.resolveResource): Promise<THREE.Object3D | undefined> {
    const visual = entity.components.visual
    const splatLoadStarted = visual?.kind === "splat" ? performance.now() : 0
    const requestedSceneId = this.snapshot?.sceneId, requestedSignature = loaded.signature
    if (!visual || visual.kind === "group" || visual.kind === "source") return
    if (visual.kind === 'infinite-ground') {
      // 有限视觉参考面是零厚度平面，不是物理碰撞边界；Collider由Scene交给引擎。
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(20,20),new THREE.MeshStandardMaterial({color:0x596574,roughness:1,side:THREE.DoubleSide,transparent:true,opacity:.28,depthWrite:false}))
      plane.receiveShadow=true;plane.userData.infiniteGroundReference=true
      return plane
    }
    if (visual.kind === "robot") {
      if (!visual.robot) throw new Error(`ROBOT_VISUAL_DESCRIPTION_REQUIRED: ${entity.entityId}`)
      const robotInput=visual.robot as Record<string,unknown>
      const native=(entity.components.mujoco??entity.components.isaac??{}) as {rootBody?:string;source?:string}
      // 机器人的缺件（缺网格/关节缺 link）**不在这里写台账**：`buildRobotVisual` 只是把警告交回来，
      // 是不是这一版的、要不要记，由 `startLoad` 在身份核对之后决定（与失败侧同一条归属判据）。
      // DEV-PROJ-01：把**文档内引用 → 登记声明的 mimeType**表交给装配器。装载器分派不能再从 `file` 串猜扩展名：
      // 出站投影已把它换成不可逆标记 `res:<指纹>`，而 `Representation.mimeType` 不受投影影响。
      // 配对判据是逐字相等（`pairDocumentAssets`，唯一一份），配不上就是空表——回落到定位符真名后缀，不猜。
      const assetDeclarations=new Map(pairDocumentAssets(entity).map(row=>[row.file,row.mimeType]))
      loaded.robot = await buildRobotVisual({...robotInput,rootBody:robotInput.rootBody??native.rootBody,hideCollisionGeoms:native.source==="official-env",assetDeclarations}, resolveResource, { renderer: this.renderer })
      return loaded.robot.root
    }
    const ref = primaryResource(entity)
    if (!ref) return
    loaded.baseRef = { resourceId: ref.resourceId, version: ref.version }
    const rep = ref.representations.find(rep => rep.role === "visual") ?? ref.representations[0] ?? ref.original
    let result: THREE.Object3D
    if (visual.kind === "splat") {
      const current = () => !this.disposed && this.snapshot?.sceneId === requestedSceneId && this.objects.get(entity.entityId) === loaded && loaded.signature === requestedSignature
      if (!current()) throw new DOMException("泼溅加载已不属于当前场景", "AbortError")
      const filename = decodeURIComponent(rep.uri.split("/").pop()!)
      // DEV-025：成因分类先于尝试——格式不认识 / 预览依赖不可用，要**当场**说清是哪一类，
      // 不把它混进后面的通用解码失败里（分类判据是纯函数，同一份也供 Node 侧矩阵脚本使用）。
      // DEV-PROJ-01：格式的第一判据是**登记声明**（`rep.mimeType`，投影不动它），文件名只作回落。
      // 投影把 `rep.uri` 换成 `res:<指纹>` 之后 `split("/").pop()` 拿到的不是文件名 ⇒ 一律 unsupported-format。
      const input = assessSplatDeclaration({ mimeType: rep.mimeType, locator: rep.uri }, { dependencyAvailable: typeof SplatMesh === "function" && typeof SparkRenderer === "function" })
      if (!input.supported) {
        loaded.lodWarnings.push(`${splatWarningCode(input.cause)}: ${input.detail}`)
        return
      }
      this.spark ??= new SparkRenderer({ renderer: this.renderer, lodSplatCount: this.splatBudget.lodSplatCount, lodRenderScale: this.splatBudget.lodRenderScale, minSortIntervalMs: this.splatBudget.minSortIntervalMs })
      if (!this.spark.parent) this.scene.add(this.spark)
      const fileType = (SplatFileType as unknown as Record<string, SplatFileType>)[input.fileTypeName!]
      // Spark 2.0 的默认 quality 返回 lod-only 数据，不能从空的原始 packed 容器读取点数/边界。
      const sourcePoints=splatPointCount(visual.sourcePointCount),initializationLod=splatInitializationLod(sourcePoints)
      const retentionKey = JSON.stringify([ref.resourceId, ref.version, rep.uri, rep.mimeType,initializationLod])
      const state = { loadMs: null as number | null,requestedLodMethod:initializationLod===true?"tiny":"quality",sourceReadCompleteMs:null as number|null,initializationMs:null as number|null,decodedMemory:null as ReturnType<typeof retainedSplatFootprint>|null, sourceSplats:sourcePoints, decodedSplats: null as number | null, lodEnabled: true, lodSplats: null as number | null, boundsSource: null as "metadata-centers" | "decoded-centers" | null, phase: "initializing" as "waiting-cache" | "initializing" | "bounds" | "ready" | "cancelled" | "failed", firstDrawSubmittedMs: null as number | null, started: splatLoadStarted, decodeCacheHit:false,decodeCacheWaitMs:null as number|null }
      const controller = new AbortController()
      let mesh:SplatMesh|undefined
      let meshDisposed = false
      const disposeMesh = () => {
        if (meshDisposed||!mesh) return
        meshDisposed = true
        // SDK Worker 无取消入口。切走后若初始化成功，只留下原身份的有界 CPU 数组；
        // GPU/Dyno 仍释放，失败数据不缓存，账户切换由 put 的 Host 判据拒绝旧结果。
        if (controller.signal.aborted && mesh.isInitialized && this.options.splatRetentionScope) {
          const data = retainSplatData(mesh)
          if (data) retainedSplats.put(this.options.splatRetentionScope, retentionKey, data)
        }
        mesh.dispose()
      }
      const pending = { mesh:undefined as SplatMesh|undefined, controller, cancel: () => {
        controller.abort()
        if(!mesh)return
        // 不能终止共享 Worker 或宣称 dispose 中断了质量构建；等 SDK 收尾后释放其实际返回数据。
        const completion=mesh.initialized.then(disposeMesh, disposeMesh)
        if(this.options.splatRetentionScope)retainedSplats.defer(this.options.splatRetentionScope,retentionKey,completion)
        void completion
      } }
      loaded.pendingSplat = pending
      ;(this.splatRuntime ??= new Map()).set(entity.entityId, state)
      try {
        const scope=this.options.splatRetentionScope,transfer=scope?retainedSplats.wait(scope,retentionKey,controller.signal):undefined
        if(transfer){state.phase='waiting-cache';const waiting=performance.now();await transfer;state.decodeCacheWaitMs=performance.now()-waiting}
        controller.signal.throwIfAborted()
        if(!current())throw new DOMException('泼溅加载已不属于当前场景','AbortError')
        const retained=scope?retainedSplats.take(scope,retentionKey):undefined
        state.decodeCacheHit=retained!==undefined;state.sourceReadCompleteMs=retained?0:null;state.phase='initializing'
        if(retained)mesh=new SplatMesh({packedSplats:restoreSplatData(retained),enableLod:true})
        else{
          const url=await resolveResource(rep.uri,ref)
          controller.signal.throwIfAborted()
          if(!current())throw new DOMException('泼溅加载已不属于当前场景','AbortError')
          mesh=new SplatMesh({url,fileName:filename,fileType,lod:initializationLod,enableLod:true,onProgress:event=>{if(state.sourceReadCompleteMs===null&&event.total>0&&event.loaded>=event.total)state.sourceReadCompleteMs=performance.now()-splatLoadStarted}})
        }
        pending.mesh=mesh;state.lodEnabled=mesh.enableLod===true
        await mesh.initialized
        state.initializationMs=performance.now()-splatLoadStarted
        controller.signal.throwIfAborted()
        if (!current()) throw new DOMException("泼溅加载已不属于当前场景", "AbortError")
        const source = splatDataSource(mesh)
        if (!source) throw new Error("VIEWER_SPLAT_DECODER_MISSING: 解码后没有可显示的高斯点")
        const lodSource = mesh.packedSplats?.lodSplats ?? mesh.extSplats?.lodSplats
        state.decodedSplats = source.numSplats
        state.lodSplats = lodSource?.numSplats ?? null
        const decodedData=retainSplatData(mesh);state.decodedMemory=decodedData?retainedSplatFootprint(decodedData):null
        // 原始数据不可得时不能拿 LOD 树节点数冒充源点数；元信息缺失则保留 null。
        state.sourceSplats ??= splatPointCount(mesh.packedSplats?.numSplats ?? mesh.extSplats?.numSplats)
        state.phase = "bounds"
        const cachedBounds = cachedSplatCenterBounds(visual.sourceBounds)
        const bounds = cachedBounds ?? await scanSplatCenterBounds(source, { signal: controller.signal, current })
        controller.signal.throwIfAborted()
        if (!current()) throw new DOMException("泼溅加载已不属于当前场景", "AbortError")
        if (!bounds) throw new Error("VIEWER_SPLAT_DECODER_MISSING: 解码后没有可用的中心边界")
        this.splatBounds.set(mesh, bounds)
        // 完整源边界用于真实范围；镜头只用稳健主体抽样，离群点不能决定默认视角。
        const core = centralSplatBounds(source.numSplats, index => source.getSplat(index)) ?? bounds
        if (core) this.splatViewBounds.set(mesh, core)
        state.boundsSource = cachedBounds ? "metadata-centers" : "decoded-centers"
        const decoded = assessSplatDecoded({ numSplats: source.numSplats, bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() } })
        if (decoded.cause !== "ok") loaded.lodWarnings.push(`${splatWarningCode(decoded.cause)}: ${decoded.detail}`)
        loaded.splat = mesh
        loaded.splatRetentionKey = retentionKey
        state.loadMs = performance.now() - splatLoadStarted; state.phase = "ready"
        return this.wrapSourceCoordinates(ref, visual, mesh)
      } catch (failure) {
        disposeMesh()
        if (loaded.splat === mesh) loaded.splat = undefined
        if (controller.signal.aborted || !current() || failure instanceof DOMException && failure.name === "AbortError") {
          state.phase = "cancelled"
          throw failure
        }
        state.phase = "failed"
        const classified = assessSplatFailure(failure, { extension: input.extension, dependencyAvailable: true })
        const code = splatWarningCode(classified.cause)
        loaded.lodWarnings.push(`${code}: ${classified.detail}`)
        throw new Error(`${code}: ${classified.detail}`)
      } finally {
        if (loaded.pendingSplat === pending) loaded.pendingSplat = undefined
      }
    }
    const url = await resolveResource(rep.uri, ref)
    if (rep.mimeType !== "model/gltf-binary") throw new Error(`VIEWER_FORMAT_UNSUPPORTED: ${rep.mimeType}`)
    const { object, gltf, node } = await this.loadGltfObject(url, visual)
    // 单网格来源保留原轴向怀疑诊断；多网格装配体的零件长宽没有独立上下语义。
    // 按完整 glTF 资源判断，不能把展开后的单零件误认成独立道具。原source轴转换保持不变。
    {
      let resourceMeshCount=0
      gltf.scene.traverse(item=>{if(item instanceof THREE.Mesh&&item.geometry)resourceMeshCount++})
      const extents: Array<{ x: number; y: number; z: number }> = []
      object.traverse(item => {
        if (!(item instanceof THREE.Mesh) || !item.geometry) return
        if (!item.geometry.boundingBox) item.geometry.computeBoundingBox()
        const box = item.geometry.boundingBox
        if (!box) return
        const size = box.getSize(new THREE.Vector3()).multiply(item.scale)
        extents.push({ x: Math.abs(size.x), y: Math.abs(size.y), z: Math.abs(size.z) })
      })
      const suspect = axisSuspectForGltf(ref.source?.upAxis, extents, resourceMeshCount)
      if (suspect) loaded.lodWarnings.push(`${suspect.code}: ${suspect.detail}`)
    }
    if (node) loaded.baseNode = node
    // 烘焙动画由trackAnimation按实例物理参考合同启动；创建mixer不等于自动评价clip t=0。
    // **只取"目标节点确实在这个克隆子树里"的 clip**：同一个 GLB 可能被多个实体克隆
    // （每个实体一个 GLB 文件，但也可能共享资源），无条件把全部 clip 挂上去会让同一段动画
    // 驱动多个对象（一个动作被播 N 次），既费算力又会互相覆盖。按 track 的根节点名过滤才是正确的归属。
    const clipsHere = gltf.animations.filter(clip => {
      const roots = new Set(clip.tracks.map(track => track.name.split('.')[0]))
      let found = false
      object.traverse(node => { if (!found && node.name && roots.has(node.name)) found = true })
      return found
    })
    if (clipsHere.length > 0) {
      const mixer = new THREE.AnimationMixer(object)
      loaded.mixer = mixer
      loaded.clips = clipsHere
    }
    // 这份可视对象与其它实体共用 GLTF 缓存里的几何/材质/贴图：释放本实体时不销毁它们（见 `disposeObject`）。
    loaded.shared = true
    result = object
    return this.wrapSourceCoordinates(ref, visual, result)
  }
  /**
   * 本 Viewer 的 glTF 装载器（懒建、单例）。**全类唯一的 glTF 读取入口**，见 `gltfLoaderInstance`。
   *
   * `renderer` 必须传：KTX2 的 transcode 目标格式由渲染器的压缩纹理扩展能力决定，three 的
   * `KTX2Loader` 在没探测过能力时会在 `load()` 里直接抛初始化错误（见 `ktx2-decoder.ts` 模块头）。
   */
  private gltfLoader(): GLTFLoader {
    this.gltfLoaderInstance ??= createGltfLoader({ renderer: this.renderer })
    return this.gltfLoaderInstance
  }
  /**
   * 从 GLTF 缓存取一个可视对象。缓存键是**解析后的 URL**：同一 URL 只真正读一次，之后每个实体
   * 拿到的是它的克隆（three 的 clone 只复制节点，几何/材质/贴图实例是共享的）。
   * 读取失败**不进缓存**——否则之后所有重试都只会再次拿到那个失败的 promise，永远读不出来。
   *
   * 节点寻址（`address`）：实体节点用基础文件的 `gltfNode`；派生级别用的是**另一个文件**，节点号是两个命名空间，
   * 所以派生侧可以给 `gltfNodeName`，也可以不给——后者按基础节点名或"只有一个带网格节点"解析（见
   * `chooseDerivedNode`），解析不出来就如实报 `LOD_LEVEL_NODE_AMBIGUOUS`，绝不硬套一个号或随手取一个节点。
   *
   * 返回的 `node.matrix` 是该节点在**本文件内部**的完整变换链（见 `fileNodeChain`），不是它的局部矩阵：
   * 派生级别的相对变换要减掉的是整条链（GLB 展开出的父实体已经把整条链施加到显示对象上了）。
   */
  private async loadGltfObject(url: string, address: { gltfNode?: unknown; gltfNodeName?: unknown } = {}, derived?: { baseNodeName?: string }): Promise<{ object: THREE.Object3D; gltf: GLTF; node?: { matrix: THREE.Matrix4; name: string } }> {
    // Viewer 已销毁就不再开始新读取：关闭窗口时资源解析可能刚好返回（`resolveResource` 还在途），
    // 这条路上的解析结果没人会用，而缓存早已清空——挂进去就是一份谁都不释放的几何/材质/贴图。
    // 已经在途的那份归 `dispose()` 的收尾（见那里的 `.then(disposeGltfSource)`）。
    if (this.disposed) throw new Error("VIEWER_DISPOSED: Viewer 已销毁，不再读取资源")
    const stat = this.gltfStats.get(url) ?? { loads: 0, hits: 0 }
    this.gltfStats.set(url, stat)
    const cached = this.gltfs.get(url)
    if (cached) stat.hits++
    else {
      stat.loads++
      const pending = this.gltfLoader().loadAsync(url)
      pending.catch(() => { if (this.gltfs.get(url) === pending) this.gltfs.delete(url) })
      this.gltfs.set(url, pending)
    }
    const gltf = await this.gltfs.get(url)!
    const indexOf = (target: THREE.Object3D): number | undefined => gltf.parser.associations.get(target)?.nodes
    let object: THREE.Object3D
    let node: { matrix: THREE.Matrix4; name: string } | undefined
    const byIndex = typeof address.gltfNode === "number"
    if (byIndex || typeof address.gltfNodeName === "string" || derived) {
      // 候选节点只取"文件里真正的 glTF 节点"（GLTFLoader 会插入 wrapper，associations 里查得到号）。
      const candidates: DerivedNodeCandidate[] = []
      gltf.scene.traverse(item => {
        const index = indexOf(item)
        if (index === undefined) return
        candidates.push({ index, name: item.name ?? "", hasMesh: item instanceof THREE.Mesh || item.children.some(child => child instanceof THREE.Mesh) })
      })
      let chosen: number
      if (byIndex) {
        chosen = address.gltfNode as number
        if (!candidates.some(candidate => candidate.index === chosen)) throw new Error(`GLTF_NODE_NOT_FOUND: ${chosen}`)
      } else {
        const meshes = candidates.filter(candidate => candidate.hasMesh)
        const addressName = typeof address.gltfNodeName === "string" ? address.gltfNodeName : undefined
        const decision = chooseDerivedNode(meshes, addressName === undefined ? undefined : { name: addressName }, addressName === undefined ? derived?.baseNodeName : undefined)
        if ("problem" in decision) throw new Error(decision.problem)
        chosen = decision.index
      }
      let found: THREE.Object3D | undefined
      gltf.scene.traverse(item => { if (indexOf(item) === chosen) found = item })
      if (!found) throw new Error(`GLTF_NODE_NOT_FOUND: ${chosen}`)
      const clone = (source: THREE.Object3D): THREE.Object3D => {
        const target = source.clone(false)
        for (const child of source.children) if (indexOf(child) === undefined) target.add(clone(child))
        return target
      }
      // 存**文件内部完整链**而不是节点自己的局部矩阵：`glbEntities` 把整棵节点树展开成实体链，
      // 基础级别的显示位置 = 场景侧位姿 × 整条文件链；派生级别的相对矩阵要减掉的就是这一整条。
      // 存局部矩阵会让有父节点的文件"父变换被重复施加/派生父变换被丢掉"（ENV-95 点 1 实测两例）。
      node = { matrix: fileNodeChain(found, item => indexOf(item) !== undefined), name: found.name ?? "" }
      object = clone(found)
      object.position.set(0, 0, 0); object.quaternion.identity(); object.scale.set(1, 1, 1)
    } else object = cloneSkeleton(gltf.scene)
    // 打上"几何/材质归缓存所有"的标记：释放实体、丢弃迟到结果时都不销毁它们，只有 Viewer 销毁时才释放。
    markSharedVisual(object)
    return { object, gltf, ...(node ? { node } : {}) }
  }
  /**
   * 源坐标适配（Y-up→Z-up、单位缩放或显式 `sourceTransform`）：基础级别与每个派生级别走**同一段**代码，
   * 否则同一实体换个级别就会被多转 90°，看起来像"LOD 切换把模型挪走了"。
   */
  private wrapSourceCoordinates(ref: ResourceRef, visual: Record<string, unknown>, result: THREE.Object3D): THREE.Object3D {
    if (!ref.source) throw new Error("VIEWER_RESOURCE_SOURCE_REQUIRED: 资源缺少源单位/坐标信息，请重新导入这条素材；没有猜测默认朝向。")
    if (visual.sourceTransformApplied === true) return result
    const wrapper = new THREE.Group()
    const transform = visual.sourceTransform as Transform | undefined
    if (transform) applyTransform(wrapper, transform)
    else {
      // 已识别的旧 CV 首相机约定（X 右/Y 下/Z 前）：真实的 up=−Y 经既有 +90 会变成 −Z（画面倒置）。
      // 这一段只在**没有显式 sourceTransform** 时生效（mount 路径会在 operations 里装配好显式变换）；
      // v2 需要 Rx(−90) 让 up→+Z、forward→水平前方；v3/未知沿用既有 Yup→Zup(+90)。
      const frame = visual.gaussianCameraFrame
      if (frame === "first-camera-c2w-v2" && ref.source.upAxis === "Y") wrapper.rotateX(-Math.PI / 2)
      else if (ref.source.upAxis === "Y") wrapper.rotateX(Math.PI / 2)
      else if (ref.source.upAxis === "X") wrapper.rotateY(-Math.PI / 2)
      if (ref.source.handedness !== "right") throw new Error("VIEWER_SOURCE_COORDINATE_ADAPTER_REQUIRED")
      wrapper.scale.setScalar(ref.source.metersPerUnit ?? 1)
    }
    wrapper.add(result)
    // 包装本身不打共享标记：共享的是 `loadGltfObject` 克隆出来的那棵子树（几何/材质/贴图在那里）。
    return wrapper
  }
  /**
   * 建立实体的 LOD 运行态。判据只有一条：`visual.lod` 能解析出至少一个合法派生级别（见 `lod.ts`）。
   *
   * 带烘焙动画的实体**不参与交换**：mixer 绑在基础级别的对象上，派生物上不会重建，
   * 交换会让动画静默停住——这种情况如实记一条缺件说明，不省这点面数。
   */
  private setupLod(entity: Entity, loaded: Loaded): void {
    const plan = resolveLodPlan(entity)
    if (!plan) return
    if (plan.problems.length) loaded.lodWarnings.push(...plan.problems)
    if (plan.levels.length === 0) return
    if (loaded.mixer) { loaded.lodWarnings.push("LOD_SKIPPED_ANIMATED: 实体带烘焙动画，交换派生级别会停掉动画，因此不交换"); return }
    loaded.lod = { plan, levels: new Map(), triangles: new Map(loaded.baseVisual ? [[LOD_BASE, meshTriangles(loaded.baseVisual)]] : []), anchorLocal: loaded.baseVisual ? localCenterOf(loaded.baseVisual, loaded.group) : new THREE.Vector3(), current: LOD_BASE, wanted: LOD_BASE, distance: 0, failed: new Set(), switches: 0 }
  }
  /**
   * 按相机距离决定各实体显示哪一级。**真的换显示对象**（不是回一个标记）：换上去的是另一个
   * 派生 GLB 的克隆，三角形数因此在真实渲染里变化。
   *
   * `camera` 默认是窗口相机（每帧渲染循环调用一次）。**按指定相机出图时必须以那台相机再调一次**
   * （`packages/lyapunov-shell` 的 `renderCameraImage` 走的就是这条路）：否则一台 2 m 处的照片相机会
   * 拿到"窗口相机在 100 m 外"选出的粗级别——拿远景的粗 LOD 冒充近景高精。交换在满足判据时**同步完成**，
   * 所以出图前调用一次即可；目标级别还没读进来时，这里只会用"不粗于目标"的级别顶上（见 `applyBestAvailable`），
   * 绝不会退回更粗的一级。
   *
   * `settle` 供**一次性采集**使用：跳过滞回、一步算到该相机该用的级别。滞回是为窗口相机逐帧判级防抖的，
   * 用在"拍完就走的相机"上只有一个后果——一张 2.5 m 的近景图停在 15 m 那级（`rawLodLevel` 才是那次该用的判据）。
   */
  updateLod(camera: THREE.Camera = this.camera, options: { settle?: boolean } = {}): void {
    const position = camera.getWorldPosition(this.lodCamera)
    for (const [entityId, loaded] of this.objects) {
      const lod = loaded.lod
      if (!lod || loaded.dynamicGeometry) continue
      this.lodProbe.copy(lod.anchorLocal).applyMatrix4(loaded.group.matrixWorld)
      const distance = position.distanceTo(this.lodProbe)
      const wanted = options.settle === true ? rawLodLevel(lod.plan, distance) : selectLodLevel(lod.plan, distance, lod.current)
      lod.distance = distance
      lod.wanted = wanted
      if (wanted === lod.current) continue
      // 当前级别已经不粗于目标（`current < wanted` = 手上这份更精细）：保持不变，只把目标级别读进来。
      if (lod.current > wanted) this.applyBestAvailable(entityId, loaded, wanted)
      if (lod.current !== wanted && lod.pending !== wanted && !lod.failed.has(wanted)) this.requestLodLevel(entityId, loaded, wanted)
    }
  }
  /**
   * 目标级别已经读进来了就直接换；没读进来时用**已有级别里不粗于目标**的最细一级顶上（基础级别最细），
   * 顶不上就返回 false（上层去发起加载）。
   *
   * 为什么不是"没读进来就先不动"：那样在"窗口相机很远、指定相机很近"的采集里，图上留下的会是远处那级粗模型。
   * 画面宁可更精细（几何量更大）也不能更粗——粗了就是把远景的简化模型冒充近景高精。
   */
  private applyBestAvailable(entityId: string, loaded: Loaded, wanted: number): boolean {
    const lod = loaded.lod
    if (!lod) return false
    if (lod.levels.has(wanted)) return this.applyLodLevel(entityId, loaded, wanted)
    let best: number | undefined = loaded.baseVisual ? LOD_BASE : undefined
    for (const index of lod.levels.keys()) if (index <= wanted && (best === undefined || index < best)) best = index
    if (best === undefined || best === lod.current) return false
    return this.applyLodLevel(entityId, loaded, best)
  }
  /** 把显示对象换成指定级别；基础级别缺对象（基础读取失败时）返回 false，保持当前级别不回退。 */
  private applyLodLevel(entityId: string, loaded: Loaded, level: number): boolean {
    const lod = loaded.lod
    if (!lod || loaded.dynamicGeometry) return false
    const object = level === LOD_BASE ? loaded.baseVisual : lod.levels.get(level)
    if (!object) return false
    if (loaded.visual !== object) {
      if (loaded.visual) loaded.group.remove(loaded.visual)
      loaded.group.add(object)
      loaded.visual = object
      this.applyDisplay(loaded)
      lod.switches++
      this.lodSwitches++
    }
    lod.current = level
    return true
  }
  /**
   * 读一个派生级别。结果只在"仍是当前这个 Loaded 的这一份计划"时才挂上去：实体被换掉（签名变了 ⇒
   * 新 Loaded）、场景换版、Viewer 销毁之后到达的旧结果就地丢弃——对象归 GLTF 缓存所有，不销毁，
   * 也不回盖新画面（同 sceneId 的旧异步资源不会盖住新 revision）。
   */
  private requestLodLevel(entityId: string, loaded: Loaded, level: number): void {
    const lod = loaded.lod!
    lod.pending = level
    void this.buildLodLevel(loaded, level).then(object => {
      if (this.disposed || this.objects.get(entityId) !== loaded || loaded.lod !== lod) return
      lod.levels.set(level, object)
      this.applyEntityMaterial(loaded)
      lod.triangles.set(level, meshTriangles(object))
      if (lod.wanted === level) this.applyLodLevel(entityId, loaded, level)
    }, error => {
      if (this.disposed || this.objects.get(entityId) !== loaded || loaded.lod !== lod) return
      lod.failed.add(level)
      this.noteLodWarning(entityId, loaded, `LOD_LEVEL_LOAD_FAILED: ${lod.plan.levels[level]!.role} (${String(error)})`)
    }).finally(() => { if (lod.pending === level) lod.pending = undefined })
  }
  /**
   * 读一个派生级别，并按**派生节点合同**把它摆到基础节点同一个世界位置：
   *
   *  1. 节点寻址：级别条目给的 `gltfNode`/`gltfNodeName` 优先；不给就按基础节点名或"派生件里唯一的网格节点"解析
   *     （`chooseDerivedNode`）。基础文件的节点号不会套到派生文件上——两个文件是两套命名空间。
   *  2. 局部变换：显示对象的世界矩阵 = **场景侧位姿 × 源坐标变换 × 该文件内部被寻址节点的完整变换链**
   *     （`fileNodeChain`；场景侧位姿与源坐标变换对基础/派生两级完全相同，故两者相减后只剩文件内部那一段）。
   *     基础级别把节点自身变换置零、那段链完全交给实体父链承担（导入时节点变换已在实体 transform 上）；
   *     派生件同样置零，再补一个"基础链的逆 × 派生链"的相对矩阵：
   *       · 派生件保持父链与对象变换导出 → 派生链 = 基础链 → 相对矩阵 = I，与基础逐字一致；
   *       · 导出时把父链与对象变换烘焙进了网格（单节点、局部矩阵 = I）→ 相对矩阵 = 基础链的逆，正好抵消掉实体上那份；
   *       · 派生件换了另一层父节点 → 相对矩阵 = 基础链⁻¹ × 新父链，落点跟着新父链走。
   *     **比的是完整链、不是节点局部矩阵**：只比局部矩阵时，上面第一种情况会"父变换被重复施加"、
   *     第三种情况会"派生父变换整条丢掉"（95 号实测分别偏 0.41 m / 0.80 m）。
   *     Scene 侧的父变换（底座等）绝不进来——它由实体父链承担，进来就会随摆放位置改变相对矩阵。
   *     **这份相对矩阵直接写进 `matrix`，不走 `applyMatrix4`**：非均匀缩放节点变换的逆一般带剪切分量，
   *     不是"平移×旋转×缩放"能表示的，`applyMatrix4` 的 decompose 会把剪切丢掉（实测：非均匀缩放 + 25° 旋转的
   *     基础节点上，烘焙级别落到 16 cm 外、包围盒 X/Y 差 12%）。`matrixAutoUpdate=false` 让 three 每帧
   *     照抄这份矩阵，画面位置与合同逐位一致。
   *  3. 源坐标适配（`wrapSourceCoordinates`）与基础级别走同一段代码，`source` 不一致的级别已在
   *     `resolveLodPlan` 里被拒（`LOD_LEVEL_SOURCE_MISMATCH`）。
   */
  private async buildLodLevel(loaded: Loaded, level: number): Promise<THREE.Object3D> {
    const entry = loaded.lod!.plan.levels[level]!
    const visual = loaded.planVisual ?? {}
    const url = await this.options.resolveResource(entry.representation.uri, entry.ref)
    const { object, node } = await this.loadGltfObject(url, { ...(entry.node?.index !== undefined ? { gltfNode: entry.node.index } : {}), ...(entry.node?.name !== undefined ? { gltfNodeName: entry.node.name } : {}) }, { baseNodeName: loaded.baseNode?.name })
    if (loaded.baseNode && node) {
      object.matrix.copy(derivedNodeMatrix(loaded.baseNode.matrix, node.matrix))
      object.matrixAutoUpdate = false
      object.matrixWorldNeedsUpdate = true
    }
    return this.wrapSourceCoordinates(entry.ref, visual, object)
  }
  /**
   * 基础级别失败时的兜底：从最粗的派生级别往回找第一个读得出来的，把实体显示出来。
   * 计划照常生效（之后拉远拉近仍按距离切换）；基础级别本身缺失的事实留在缺件警告里。
   * 返回 true 表示"画面里已经有东西了"。归属在写入前再核一次：已经换版/换资源的实体不写。
   */
  private async tryLodFallback(entity: Entity, loaded: Loaded, baseError: unknown): Promise<boolean> {
    const plan = resolveLodPlan(entity)
    if (!plan?.levels.length) return false
    const visual = (entity.components.visual ?? {}) as Record<string, unknown>
    for (let index = plan.levels.length - 1; index >= 0; index--) {
      const entry = plan.levels[index]!
      try {
        const url = await this.options.resolveResource(entry.representation.uri, entry.ref)
        // 基础件读不出来时没有 `baseNode` 可比：退回实体名（`glbEntities` 就是用基础节点名命名实体的）按名字找派生节点。
        const { object } = await this.loadGltfObject(url, { ...(entry.node?.index !== undefined ? { gltfNode: entry.node.index } : {}), ...(entry.node?.name !== undefined ? { gltfNodeName: entry.node.name } : {}) }, { baseNodeName: entity.name })
        if (this.disposed || this.objects.get(entity.entityId) !== loaded) { disposeObject(object); return true }
        const wrapped = this.wrapSourceCoordinates(entry.ref, visual, object)
        loaded.shared = true
        loaded.visual = wrapped
        loaded.group.add(wrapped)
        loaded.lod = { plan, levels: new Map([[index, wrapped]]), triangles: new Map([[index, meshTriangles(wrapped)]]), anchorLocal: localCenterOf(wrapped, loaded.group), current: index, wanted: index, distance: 0, failed: new Set(), switches: 0 }
        loaded.lodWarnings.push(`LOD_BASE_FALLBACK: 基础级别加载失败，当前显示派生级别 ${entry.role}（${String(baseError)}）`)
        this.applyEntityMaterial(loaded)
        this.refreshVisualWarnings(entity.entityId, loaded)
        loaded.group.userData.loaded = true
        this.applyDisplay(loaded)
        this.trackAnimation(entity.entityId, loaded)
        this.notifyPresentationState()
        return true
      } catch { /* 这一级也读不出来：接着试更粗的 */ }
    }
    return false
  }
  /**
   * 运行期切换"编辑提交"能力（读写权限）。
   *
   * 为什么不在构造参数里一次定死：工作台原先把 `commitEdit` 绑进创建 effect 的依赖
   * （`readOnly`），于是一旦只读状态变化（打开官方世界、场景里出现 official-env 实体），
   * 整个 viewer 会被 dispose 再重建；若重建那一刻容器节点尚未挂回 DOM，effect 直接
   * return，3D 画布就永久空白（实测：`.lya-canvas` 高度 0 且无 canvas 子元素）。
   * 这里提供运行期 setter，让创建与权限解耦。
   */
  setEditCommit(commit: ViewerOptions["commitEdit"]): void {
    this.options.commitEdit = commit
    // 与 `select()` 共用同一条挂接判据：炸开的实体不因权限变化被重新挂上真实 Transform。
    this.syncTransformGizmo()
  }
  /**
   * 开关 Scene 里作者打的灯。硬编码的环境灯（Hemisphere/Directional）**不归它管**——
   * 关掉全部 Scene 灯后仍要有基础环境光，否则场景会全黑，用户会以为坏了。
   */
  setSceneLights(visible: boolean): void {
    this.sceneLightsVisible = visible
    for (const [entityId,loaded] of this.objects) if (loaded.group.userData.sceneLight === true) loaded.group.visible = visible&&this.snapshot?.entities.find(entity=>entity.entityId===entityId)?.components.visual?.visible!==false
  }

  /**
   * 缺件警告的**唯一写入点**：机器人缺件与 LOD 说明合并成一条记录，随 Loaded 的归属一起写/清。
   * 为什么合并：`visualWarnings` 是采集门读的那张表（"画出来了，但少了点什么"），两个来源各写各的
   * 会互相覆盖（机器人加载时清掉 LOD 的、LOD 失败时清掉机器人的），于是同一时刻只有一半事实。
   */
  private refreshVisualWarnings(entityId: string, loaded: Loaded): void {
    const warnings = [...(loaded.robot?.warnings ?? []), ...loaded.lodWarnings]
    if (warnings.length) this.visualWarnings.set(entityId, warnings)
    else this.visualWarnings.delete(entityId)
  }  /** 追加一条 LOD 说明（去重）并刷新缺件警告。 */
  private noteLodWarning(entityId: string, loaded: Loaded, text: string): void {
    if (loaded.lodWarnings.includes(text)) return
    loaded.lodWarnings.push(text)
    this.refreshVisualWarnings(entityId, loaded)
  }
  // ───────────────────── 环境光照：Scene 的 `components.environment` ─────────────────────
  /**
   * 场景版本 → 生效环境。组件来自文档本身，所以 Agent 的 `scene_edit`、面板提交、版本回退
   * 都只经过这一条通道；Viewer 不持有第二份"当前环境"。
   *
   * 渲染时钟的重置判据只有三件事：换承载实体、文档里的静态时刻/周期被改写、组件刚出现。
   * 播放本身不写文档，所以正常播放不会被下一次 setScene 打断（同一个 Scene 的编辑照常应用参数）。
   */
  private setSceneEnvironment(scan: EnvironmentScan): void {
    this.environmentDiagnostics = scan.diagnostics
    const environment = scan.environment
    if (!environment) {
      const hadEnvironment = Boolean(this.environment)
      this.environment = undefined
      this.environmentClock = { playing: false, offsetHours: 0, advancedSeconds: 0 }
      this.environmentError = undefined
      if (hadEnvironment || this.scene.environment !== this.materialEnvironment.texture) this.releaseEnvironmentMap()
      this.applyEnvironment()
      return
    }
    const previous = this.environment
    const restart = !previous || previous.carrier !== environment.entityId
      || previous.component.dayNight.timeHours !== environment.component.dayNight.timeHours
      || previous.component.dayNight.cycleSeconds !== environment.component.dayNight.cycleSeconds
    this.environment = { carrier: environment.entityId, component: environment.component, warnings: environment.warnings }
    if (restart) this.environmentClock = { ...this.environmentClock, offsetHours: 0 }
    this.environmentError = undefined
    this.applyEnvironment()
  }

  /**
   * 把生效读数写到**构造时就存在**的那些对象上：曝光→renderer、IBL→scene.environmentIntensity、
   * 半球/太阳→两盏既有灯、背景→scene.background、阴影→shadowMap 与太阳。
   *
   * 没有环境组件时写回的正是组件出现之前那组硬编码读数（LEGACY_LIGHTING）：不给旧场景
   * "顺手升级"光照——那会让历史画面在不知情的情况下变样。
   * `meshes:false` 是昼夜播放的每帧路径：只改灯光/背景读数，不遍历网格。
   */
  private applyEnvironment(options: { meshes?: boolean } = {}): void {
    const component = this.environment?.component
    const live = component ? environmentLiveState(component, this.environmentClock) : undefined
    const daylight = component && live ? environmentDaylightFactor(live, component) : 1
    this.renderer.toneMapping = TONE_MAPPINGS[component?.toneMapping ?? "aces"]
    const rotation = component?.environmentRotationDeg ?? [0, 0, 0]
    this.scene.environmentRotation.set(...rotation.map(THREE.MathUtils.degToRad) as [number, number, number], "XYZ")
    this.scene.backgroundRotation.copy(this.scene.environmentRotation)
    this.renderer.toneMappingExposure = component ? component.exposure : LEGACY_LIGHTING.exposure
    this.scene.environmentIntensity = (component ? component.environmentIntensity : LEGACY_LIGHTING.environmentIntensity) * daylight
    this.hemisphere.intensity = (component ? component.hemisphereIntensity : LEGACY_LIGHTING.hemisphereIntensity) * daylight
    this.applyShadows(component?.shadows === true, options.meshes !== false)
    if (live) this.placeSun(sunDirectionVector(live.sun.azimuthDeg, live.sun.elevationDeg), live.sun.intensity)
    else this.placeSun(LEGACY_LIGHTING.sunPosition, LEGACY_LIGHTING.sunIntensity)
    this.backgroundDaylight = daylight
    this.applyBackground()
  }

  /** 太阳位置＝方向×光距（原点为目标）；强度**只在昼夜日出/日落时**被日照系数收敛到 0。 */
  private placeSun(direction: readonly [number, number, number], intensity: number): void {
    this.sun.position.set(direction[0] * this.sunDistance, direction[1] * this.sunDistance, direction[2] * this.sunDistance)
    this.sun.intensity = Math.max(0, intensity)
  }

  /**
   * 背景只有一条归属链：环境组件说 skybox **且 HDRI 真的在手里**才显示天空盒；
   * 其余（含 HDRI 还在加载、加载失败）用纯色：组件自己保存的颜色优先，没有就沿用查看器既有的背景色
   * （相机面板那一份）——旧场景因此不会被改色，只有显式存了 `backgroundColor` 的场景才带着自己的颜色走。
   */
  private applyBackground(): void {
    const skybox = this.environment?.component.background === "environment" && this.environmentMap
    if (skybox) {
      this.scene.background = skybox.texture
      // 天空盒随昼夜变暗：否则"太阳落山、天空还大亮"的读数会自相矛盾。
      this.scene.backgroundIntensity = this.backgroundDaylight
      return
    }
    this.scene.background = new THREE.Color(this.environmentColor())
    this.scene.backgroundIntensity = 1
  }

  /** 纯色背景实际生效的颜色：组件自带色优先，否则查看器偏好（唯一回落处，读数与写入同源）。 */
  private environmentColor(): string {
    return this.environment?.component.backgroundColor ?? this.display.background
  }

  /**
   * 阴影：渲染器 shadowMap + 太阳 castShadow + 网格 cast/receive 三处一起改（漏一处就是"开关点了没反应"）。
   * 平行光的正交视锥按场景包围球取景，光距同步放大——否则大场景只有一小块落在阴影相机里。
   */
  private applyShadows(enabled: boolean, meshes = true): void {
    this.renderer.shadowMap.enabled = enabled
    this.sun.castShadow = enabled
    if (enabled) {
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
      const radius = this.sceneRadius()
      this.sunDistance = Math.max(50, radius * 2)
      const camera = this.sun.shadow.camera
      camera.left = -radius * 1.5; camera.right = radius * 1.5; camera.top = radius * 1.5; camera.bottom = -radius * 1.5
      camera.near = 0.1; camera.far = this.sunDistance + radius * 3
      camera.updateProjectionMatrix()
      const settings = this.environment?.component.shadow ?? SCENE_ENVIRONMENT_DEFAULTS.shadow
      if (this.sun.shadow.mapSize.x !== settings.mapSize || this.sun.shadow.mapSize.y !== settings.mapSize) {
        this.sun.shadow.mapSize.set(settings.mapSize, settings.mapSize)
        this.sun.shadow.map?.dispose(); this.sun.shadow.map = null
        this.sun.shadow.mapPass?.dispose(); this.sun.shadow.mapPass = null
      }
      this.sun.shadow.bias = settings.bias
      this.sun.shadow.normalBias = settings.normalBias
    }
    if (meshes) for (const loaded of this.objects.values()) this.applyDisplay(loaded)
  }

  /** 场景包围球半径（米）：阴影取景与光距用；按几何版本号缓存，昼夜播放的每帧不重算遍历。 */
  private sceneRadius(): number {
    if (this.sceneRadiusCache?.revision === this.geometryRevision) return this.sceneRadiusCache.radius
    const box = new THREE.Box3()
    for (const loaded of this.objects.values()) box.union(objectWorldBounds(loaded.group, this.splatBounds))
    if (this.preview) box.union(objectWorldBounds(this.preview, this.splatBounds))
    const radius = box.isEmpty() ? 1 : Math.max(0.5, box.getBoundingSphere(new THREE.Sphere()).radius)
    this.sceneRadiusCache = { revision: this.geometryRevision, radius }
    return radius
  }

  /**
   * 当前环境请求的那份 HDRI **能不能取到**：取到＝精确版本的资源引用 + 它的 HDRI 表示（在途结果迟到时按它判断该不该落地）；
   * 取不到＝返回原因，由调用方如实记进台账。没有声明 hdri 时返回 undefined（不是错误）。
   */
  private environmentHdri(): EnvironmentHdriResolution | undefined {
    const environment = this.environment
    const entity = environment ? this.snapshot?.entities.find(item => item.entityId === environment.carrier) : undefined
    return environment && entity ? resolveEnvironmentHdri(entity, environment.component) : undefined
  }

  /** 在途结果归属用的 key：`resourceId@version:uri`；取不到（或没有 HDRI）时 undefined。 */
  private environmentLoadKey(): string | undefined {
    const resolved = this.environmentHdri()
    return resolved?.ok ? `${resolved.ref.resourceId}@${resolved.ref.version}:${resolved.representation.uri}` : undefined
  }

  /**
   * HDRI → PMREM 环境贴图，与实体资源加载同一条纪律：同一个 HDRI 只有一次在途加载，
   * 后续 setScene 复用这次在途；迟到结果按 key 重新核对归属，不属于当前环境就地释放。
   * 没有 HDRI（或组件指的资源/表示取不到）时回到内置环境光，并把原因记进 `environmentError`。
   */
  private syncEnvironmentMap(): Promise<void> | undefined {
    const resolved = this.environmentHdri()
    if (!resolved?.ok) {
      if (this.environmentMap || this.scene.environment !== this.materialEnvironment.texture) this.releaseEnvironmentMap()
      // 没有声明 HDRI（resolved === undefined）＝本来就用内置环境光，不是错误；
      // 声明了却取不到**那一个版本**＝按解析结果如实记（缺版本 / 缺资源 / 表示不是 HDRI）：
      // 不拿别的版本顶替、不静默降级——请求 v2 却装了 v1，画面看着正常，读数却在骗人。
      this.environmentError = resolved ? resolved.error : undefined
      return
    }
    const key = `${resolved.ref.resourceId}@${resolved.ref.version}:${resolved.representation.uri}`
    if (this.environmentMap?.key === key) return
    if (this.environmentLoad?.key === key) return this.environmentLoad.promise
    return this.startEnvironmentLoad(key, resolved.representation.uri, resolved.ref, resolved.representation.mimeType)
  }

  private startEnvironmentLoad(key: string, uri: string, ref: ResourceRef, mimeType?: string): Promise<void> {
    const attempt = (async () => {
      try {
        const url = await this.options.resolveResource(uri, ref)
        // DEV-PROJ-01：与 splat 同一类错——投影后 `uri` 是标记，取不到后缀。改用表示**声明的 mimeType**
        // （`environment.ts:resolveEnvironmentHdri` 本来就是按 mimeType 选表示的，这里是同一份事实）。
        const format = assetFormatOf({ mimeType, locator: uri })
        // 复用 THREE 既有 loader：.hdr→HDRLoader（Radiance RGBe）、.exr→EXRLoader；其余按 HDR 处理并由 loader 报错。
        const texture = await (format === "exr" ? new EXRLoader() : new HDRLoader()).loadAsync(url)
        if (this.disposed || this.environmentLoadKey() !== key) { texture.dispose(); return }
        texture.mapping = THREE.EquirectangularReflectionMapping
        const pmrem = new THREE.PMREMGenerator(this.renderer)
        let target: THREE.WebGLRenderTarget
        try { target = pmrem.fromEquirectangular(texture) } finally { pmrem.dispose() }
        if (this.disposed || this.environmentLoadKey() !== key) { target.dispose(); texture.dispose(); return }
        const previous = this.environmentMap
        this.environmentMap = { key, uri, ref: { resourceId: ref.resourceId, version: ref.version }, texture, target }
        this.environmentError = undefined
        this.scene.environment = target.texture
        this.applyEnvironment()
        if (previous) { previous.target.dispose(); previous.texture.dispose() }
      } catch (error) {
        // 失败同样按归属判断：迟到的失败不属于当前环境时不写台账（旧结果不冒充新事实）。
        if (this.disposed || this.environmentLoadKey() !== key) return
        this.environmentError = error instanceof Error ? error.message : String(error)
        this.releaseEnvironmentMap()
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
      }
    })()
    this.environmentLoad = { key, promise: attempt }
    const settled = () => { if (this.environmentLoad?.promise === attempt) this.environmentLoad = undefined }
    void attempt.then(settled, settled)
    return attempt
  }

  /** 释放 HDRI 环境贴图与它的 PMREM 目标，并把 scene.environment/背景交还内置环境光。 */
  private releaseEnvironmentMap(): void {
    const current = this.environmentMap
    this.environmentMap = undefined
    // 交还内置环境光：只有当当前环境贴图确实是这一份（或压根没有）时才回退，
    // 不覆盖别的来源（迟到结果/别的 HDRI）刚装上的环境。
    if (!current || this.scene.environment === current.target.texture) this.scene.environment = this.materialEnvironment.texture
    if (current) {
      if (this.scene.background === current.texture) this.scene.background = new THREE.Color(this.display.background)
      current.target.dispose()
      current.texture.dispose()
    }
    this.applyBackground()
  }

  /**
   * 昼夜播放：推进**渲染时钟**并重算太阳/IBL/背景（`meshes:false`，不遍历网格）。
   * 这里没有、也不会调用 projection/world/snapshot 的任何写入口——渲染时间与物理时间在这一点上分离：
   * 播放多久，`frame.simTime`/`stepIndex` 与 Scene revision 都不会动。
   */
  private advanceDayNight(): void {
    const component = this.environment?.component
    if (!component?.dayNight.enabled || !this.environmentClock.playing) { this.environmentClockMs = 0; return }
    const now = performance.now()
    const delta = this.environmentClockMs === 0 ? 0 : Math.min(0.25, (now - this.environmentClockMs) / 1000)
    this.environmentClockMs = now
    if (delta <= 0) return
    const next = advanceEnvironmentClock(this.environmentClock, delta, component.dayNight.cycleSeconds)
    if (next === this.environmentClock) return
    this.environmentClock = next
    this.applyEnvironment({ meshes: false })
  }

  /**
   * 日夜播放开关（界面用）。只动 Viewer 的渲染时钟：没有环境组件、或昼夜未启用时
   * **如实返回没在播**，不开一条"看起来在播"的空转路径。返回的是实际生效状态。
   */
  setDayNightPlaying(playing: boolean): { playing: boolean; timeHours?: number; cycleSeconds?: number } {
    const component = this.environment?.component
    if (!component || !component.dayNight.enabled) {
      this.environmentClock = { ...this.environmentClock, playing: false }
      return { playing: false }
    }
    // 从"现在"起算：暂停的时长不算进昼夜，避免恢复播放时一下跳过半个昼夜。
    if (playing && !this.environmentClock.playing) this.environmentClockMs = 0
    this.environmentClock = { ...this.environmentClock, playing }
    return {
      playing,
      timeHours: environmentLiveState(component, this.environmentClock).timeHours,
      cycleSeconds: component.dayNight.cycleSeconds,
    }
  }

  private materialRoots(loaded: Loaded): THREE.Object3D[] {
    return [...new Set([loaded.baseVisual, loaded.visual, loaded.dynamicGeometry?.root, ...loaded.lod?.levels.values() ?? []].filter((root): root is THREE.Object3D => Boolean(root)))]
  }

  private applyEntityMaterial(loaded: Loaded): void {
    const entity = this.snapshot?.entities.find(item => item.entityId === loaded.group.userData.entityId)
    const raw = entity?.components[MATERIAL_OVERRIDE_KEY]
    if (raw === undefined && !loaded.materialOverride && !loaded.lodWarnings?.some(warning => warning.startsWith("MATERIAL_"))) return
    const parsed = parseMaterialOverride(raw)
    if (parsed.component && !loaded.materialOverride) loaded.materialOverride = new EntityMaterialOverride()
    loaded.materialOverride?.apply(this.materialRoots(loaded), parsed.component)
    loaded.lodWarnings = (loaded.lodWarnings ?? []).filter(warning => !warning.startsWith("MATERIAL_"))
    loaded.lodWarnings.push(...(parsed.component ? this.materialStatus(loaded.group.userData.entityId).warnings : parsed.warnings))
    this.refreshVisualWarnings(loaded.group.userData.entityId, loaded)
  }

  composeMaterial(entityId: string, patch: MaterialOverridePatch) {
    const entity = this.snapshot?.entities.find(item => item.entityId === entityId)
    if (!entity) throw new Error(`MATERIAL_ENTITY_MISSING: ${entityId}`)
    return composeMaterialOverride(entity.components[MATERIAL_OVERRIDE_KEY], patch)
  }

  /** 已加载的 PBR 材质实值；无网格/点云/非 PBR 不返回可操作的伪读数。 */
  materialStatus(entityId: string): MaterialStatus {
    const entity = this.snapshot?.entities.find(item => item.entityId === entityId)
    const parsed = parseMaterialOverride(entity?.components[MATERIAL_OVERRIDE_KEY]), loaded = this.objects.get(entityId)
    const roots = [loaded?.visual, loaded?.dynamicGeometry?.root].filter((root): root is THREE.Object3D => Boolean(root?.visible))
    const reading = (loaded?.materialOverride ?? new EntityMaterialOverride()).readings(roots)
    const warnings = [...parsed.warnings], declared = entity?.components[MATERIAL_OVERRIDE_KEY] !== undefined
    if (parsed.component && (roots.length || loaded?.group.userData.loaded) && !reading.supported) warnings.push("MATERIAL_PBR_UNSUPPORTED: The entity has no overridable PBR mesh materials; values were not applied")
    if (parsed.component?.normalScale !== undefined && reading.supported && !reading.materials.some(material => material.hasNormalMap)) warnings.push("MATERIAL_NORMAL_MAP_MISSING: Source materials have no normal map; normal strength was not applied")
    return { entityId, loaded: loaded?.group.userData.loaded === true, declared, ...parsed, warnings, ...reading }
  }

  /**
   * 界面用的一条环境补丁 → **完整的组件值**（格式归 environment.ts：默认值、上界、归一化都在那边）。
   *
   * 为什么由 Viewer 出这个值而不是面板自己拼：面板看到的当前值就是 Viewer 解析出来的这一份，
   * 补丁合到它上面再规范化，界面上写下的和文档里存的永远同一个形状。返回的 warnings 是
   * 规范化时被收敛的字段（例如超出上界），调用方应当说出来，别让"被改小过"看起来像原样生效。
   */
  composeEnvironment(patch: EnvironmentPatch): { component: SceneEnvironment; warnings: string[] } {
    return composeEnvironmentComponent(this.environment?.component, patch)
  }

  /**
   * 环境光照的实际读数：生效的太阳/时刻/时钟、IBL 来源与 HDRI 是否**真的**加载在手里、
   * 以及被忽略的 `components.environment` 记录（格式写错时给出原因，不静默当没有）。
   * HDRI 的 `loaded` 按**精确版本**判定：文档请求 v2 而画面还是 v1 时，这里是没加载。
   * 面板与验收读同一份，不各自重算一遍光照数学。
   */
  environmentStatus(): EnvironmentStatus {
    const component = this.environment?.component
    const live = component ? environmentLiveState(component, this.environmentClock) : undefined
    const requested = component?.hdri
    const applied = this.environmentMap?.ref
    // loaded 的判据是"**文档请求的那一份**（resourceId 与 version 都相同）真的在手里"，
    // 不是"手里有任何一张 HDRI"：换图在途时旧图还在显示，但请求的那份还没到，读数必须是没到。
    const loaded = Boolean(requested && applied && requested.resourceId === applied.resourceId && requested.version === applied.version)
    const image = loaded ? this.environmentMap?.texture.image as { width?: number; height?: number } | undefined : undefined
    const requestedKey = this.environmentLoadKey()
    const loading = Boolean(requestedKey) && this.environmentLoad?.key === requestedKey
    return {
      ...(this.environment ? { carrier: this.environment.carrier } : {}),
      ...(component ? { component } : {}),
      warnings: this.environment?.warnings ?? [],
      ignored: this.environmentDiagnostics,
      ...(requested ? {
        hdri: {
          ...requested, loaded, loading,
          ...(applied && !loaded ? { applied: { ...applied } } : {}),
          // uri/size 只在 loaded 时为真时给出：它们是**这一份**文件的读数，不能拿旧图的尺寸充数。
          ...(loaded ? { uri: this.environmentMap?.uri, ...(image?.width && image?.height ? { size: [image.width, image.height] as [number, number] } : {}) } : {}),
        },
      } : {}),
      environmentSource: this.environmentMap ? "hdri" : "builtin",
      hdriMimeTypes: HDRI_MIME_TYPES,
      ...(this.environmentError ? { error: this.environmentError } : {}),
      background: this.environment?.component.background ?? "color",
      ...(this.environment?.component.backgroundColor ? { backgroundColor: this.environment.component.backgroundColor } : {}),
      colorBackground: this.environmentColor(),
      exposure: this.renderer.toneMappingExposure,
      toneMapping: (Object.keys(TONE_MAPPINGS) as EnvironmentToneMapping[]).find(key => TONE_MAPPINGS[key] === this.renderer.toneMapping) ?? "aces",
      environmentRotationDeg: [this.scene.environmentRotation.x, this.scene.environmentRotation.y, this.scene.environmentRotation.z].map(THREE.MathUtils.radToDeg) as [number, number, number],
      shadow: { mapSize: this.sun.shadow.mapSize.x as SceneEnvironment["shadow"]["mapSize"], bias: this.sun.shadow.bias, normalBias: this.sun.shadow.normalBias },
      environmentIntensity: this.scene.environmentIntensity,
      hemisphereIntensity: this.hemisphere.intensity,
      shadows: this.sun.castShadow,
      sun: live
        ? { azimuthDeg: live.sun.azimuthDeg, elevationDeg: live.sun.elevationDeg, intensity: live.sun.intensity, source: live.sun.source }
        : { azimuthDeg: 0, elevationDeg: 0, intensity: this.sun.intensity, source: "manual" },
      timeHours: live ? live.timeHours : 0,
      clock: { ...this.environmentClock },
    }
  }

  /**
   * 采集/观察回执里的环境窄面（`capture()` 用它）。判据全部来自 `environmentStatus()`：
   * 这里只把"请求的/实际装的"折成 `resourceId@version`，不重算光照，也不给第二套已加载判据。
   */
  environmentCaptureFace(): EnvironmentCaptureFace {
    const status = this.environmentStatus()
    const requested = status.hdri ? `${status.hdri.resourceId}@${status.hdri.version}` : undefined
    const appliedRef = status.hdri?.loaded ? status.hdri : undefined
    const applied = appliedRef ? `${appliedRef.resourceId}@${appliedRef.version}` : status.hdri?.applied ? `${status.hdri.applied.resourceId}@${status.hdri.applied.version}` : undefined
    return {
      source: status.environmentSource,
      ...(requested ? { requested } : {}),
      ...(applied ? { applied } : {}),
      loaded: status.hdri?.loaded ?? false,
      loading: status.hdri?.loading ?? false,
      ...(status.error ? { error: status.error } : {}),
    }
  }

  /** 把一个实体的烘焙动画登记进播放表。加载完成与场景重入都走这里——"登记"只有一个 owner。 */
  private trackAnimation(entityId: string, loaded: Loaded): void {
    if (!loaded.mixer || !loaded.clips) return
    if(this.animationSnapshot!==this.snapshot||!this.animationEntities){this.animationSnapshot=this.snapshot;this.animationEntities=new Map(this.snapshot?.entities.map(entity=>[entity.entityId,entity])??[])}
    const entity=this.animationEntities.get(entityId),reference=entity?staticAnimationReference(entity,this.animationEntities):undefined
    const referenceKey=reference?JSON.stringify([this.snapshot?.sceneId,this.snapshot?.revision,this.world?.worldId,this.world?.worldGeneration,this.world?.appliedSceneRevision,this.world?['ready','running','paused'].includes(this.world.status):undefined,reference]):undefined
    const previous=this.mixers.get(entityId),same=previous?.mixer===loaded.mixer&&previous.referenceKey===referenceKey
    if(reference&&(!same||!previous?.visualPreview))loaded.mixer.stopAllAction()
    const entry={mixer:loaded.mixer,clips:loaded.clips,paused:same?previous!.paused:reference?true:this.animationsPlaying===false,reference,referenceKey,visualPreview:same?previous!.visualPreview:false}
    if(!reference&&!entry.paused)for(const clip of loaded.clips)loaded.mixer.clipAction(clip).play()
    this.mixers.set(entityId,entry)
    this.refreshAnimationWarning(entityId,loaded)
  }
  private refreshAnimationWarning(entityId:string,loaded:Loaded):void {
    loaded.lodWarnings=loaded.lodWarnings.filter(warning=>!warning.startsWith('ANIMATION_STATIC_REFERENCE:')&&!warning.startsWith('ANIMATION_STATIC_REFERENCE_UNVERIFIED:')&&!warning.startsWith('ANIMATION_VISUAL_PREVIEW:'))
    const entry=this.mixers.get(entityId)
    if(entry?.reference){
      const reference=entry.reference
      loaded.lodWarnings.push(entry.visualPreview?'ANIMATION_VISUAL_PREVIEW: 已明确选择仅视觉动画；姿态可能偏离源参考，静态碰撞未随动画更新，不代表物理同步':reference.verified?'ANIMATION_STATIC_REFERENCE: 静态物理实例保持源参考姿态；动画未评价。显式视觉试播不更新碰撞':`ANIMATION_STATIC_REFERENCE_UNVERIFIED: ${reference.reason}`)
    }
    this.refreshVisualWarnings(entityId,loaded)
  }

  /** 推进所有烘焙动画。**不参与物理**：只改被动画驱动的对象的显示变换。 */
  private advanceAnimations(): void {
    if (!this.mixers.size) return
    const now = performance.now()
    const delta = this.animationClock === 0 ? 0 : Math.min(0.1, (now - this.animationClock) / 1000)
    this.animationClock = now
    if (delta === 0) return
    for (const entry of this.mixers.values()) if (!entry.paused) entry.mixer.update(delta)
  }

  /** 播放/暂停烘焙动画（全部实体）。返回实际受控的实体数与 clip 数，便于界面显示真实读数。 */
  setAnimationsPlaying(playing: boolean,options:{allowStaticReferencePreview?:boolean}={}): { entities: number; clips: number } {
    this.animationsPlaying=playing
    let clips = 0
    for (const [entityId,entry] of this.mixers) {
      if(entry.reference){
        // effect/init的同值重放不创造授权，也不撤销本作用域里用户已明确选择的视觉试播。
        if(playing&&(options.allowStaticReferencePreview===true||entry.visualPreview===true)){entry.visualPreview=true;entry.paused=false;for(const clip of entry.clips)entry.mixer.clipAction(clip).play()}
        else{entry.mixer.stopAllAction();entry.visualPreview=false;entry.paused=true}
        const loaded=this.objects.get(entityId);if(loaded)this.refreshAnimationWarning(entityId,loaded)
      }else{entry.paused=!playing;if(playing)for(const clip of entry.clips)entry.mixer.clipAction(clip).play()}
      clips+=entry.clips.length
    }
    return { entities: this.mixers.size, clips }
  }

  /** 只读：当前场景里有多少实体带烘焙动画、共多少 clip。没有动画时如实返回 0。 */
  animationSummary(): { entities: number; clips: number; names: string[]; staticReferences: Array<{entityId:string;ownerEntityId:string;verified:boolean;visualPreview:boolean;physicsSynchronized:false}>; visualWarnings:Array<{entityId:string;warning:string}> } {
    const names: string[] = []
    let clips = 0
    for (const entry of this.mixers.values()) { clips += entry.clips.length; for (const clip of entry.clips) names.push(clip.name) }
    const staticReferences=[...this.mixers].flatMap(([entityId,entry])=>entry.reference?[{entityId,ownerEntityId:entry.reference.ownerEntityId,verified:entry.reference.verified,visualPreview:entry.visualPreview===true,physicsSynchronized:false as const}]:[])
    const visualWarnings=[...this.visualWarnings].flatMap(([entityId,warnings])=>warnings.filter(warning=>warning.startsWith('ANIMATION_STATIC_REFERENCE:')||warning.startsWith('ANIMATION_STATIC_REFERENCE_UNVERIFIED:')||warning.startsWith('ANIMATION_VISUAL_PREVIEW:')).map(warning=>({entityId,warning})))
    return { entities: this.mixers.size, clips, names, staticReferences, visualWarnings }
  }

  setWorld(world: WorldHandle | undefined): void {
    if (world && this.snapshot && world.sceneId !== this.snapshot.sceneId) throw new Error("VIEWER_WORLD_SCENE_MISMATCH")
    const changed = this.world?.worldId !== world?.worldId || this.world?.worldGeneration !== world?.worldGeneration || this.world?.appliedSceneRevision !== world?.appliedSceneRevision
    const unavailable=Boolean(world&&!['ready','running','paused'].includes(world.status))
    if(changed||unavailable)this.displayedFrame=undefined
    // 切 world/代次：旧展示层展开与高亮按身份清掉（同一 Scene 的实体在换代时仍会保留 Loaded，必须显式收口）。
    // 与 setScene 同一顺序：先 restore（把让位的 gizmo 还回选中实体），再清选择/高亮。
    if (changed || unavailable) { this.clearAssemblyPreview(); if (this.partExplode) this.restorePartExplode(); this.clearPartState() }
    this.world = world ? structuredClone(world) : undefined
    this.projection.setWorld(world)
    this.syncRobotAnchors()
    this.syncCollisionTopology()
    if ((!world || changed || unavailable) && this.snapshot) for (const entity of this.snapshot.entities) {
      const loaded = this.objects.get(entity.entityId)
      if (!loaded) continue
      this.clearDynamicGeometry(loaded)
      applyTransform(loaded.group, entity.transform)
      loaded.robot?.resetPose()
    }
    if(unavailable&&(this.cameraRigGizmoKey!==undefined||this.cameraRigPilot&&this.cameraRigPilot.source!=='named-view'))this.exitCameraMode({focus:false})
    if (changed || !world || unavailable) this.setCameraRigs([])
    if(changed||!world||unavailable)for(const [entityId,loaded] of this.objects)this.trackAnimation(entityId,loaded)
  }
  private syncCollisionTopology():void {
    if (!this.collisionTopologyLayer) { this.collisionTopologyLayer=new CollisionTopologyLayer({resolveResource:(uri,ref)=>this.options.resolveResource(uri,ref)});markAuthoringHelper(this.collisionTopologyLayer.root);this.scene.add(this.collisionTopologyLayer.root) }
    this.collisionTopologyLayer.setContext(this.snapshot,this.world,this.selected,this.display?.collision===true)
  }
  private syncRobotAnchors():void {
    if(!this.robotAnchorLayer){this.robotAnchorLayer=new RobotAnchorLayer();markAuthoringHelper(this.robotAnchorLayer.root);this.scene.add(this.robotAnchorLayer.root)}
    this.robotAnchorLayer.setContext(this.snapshot,this.world,this.selected)
  }
  collisionStatus():CollisionTopologyStatus {this.syncCollisionTopology();return this.collisionTopologyLayer!.status()}
  pushFrame(frame: Frame): boolean {
    if (!this.projection.acceptsBinding(frame)) { this.projection.push(frame); return false }
    if (frame.collisionTopology) { this.syncCollisionTopology();this.collisionTopologyLayer!.receive(frame.collisionTopology) }
    // 大凸包只交给专用层一次，不进入每次 current()/consume() 复制的运动帧。
    const {collisionTopology:_topology,...motion}=frame
    return this.projection.push(motion)
  }
  /** 离线录制投影；允许按历史步号回退，不连接或推进任何模拟世界。 */
  presentRecordedFrame(frame: Frame): void {
    if (this.world) throw new Error("RECORDED_FRAME_REQUIRES_OFFLINE_VIEWER")
    if (!this.snapshot) throw new Error("RECORDED_FRAME_REQUIRES_SCENE")
    this.applyFrame(frame)
  }
  private applyFrame(frame: Frame): void {
    applyWorldPoses(this.objects, this.scene, frame)
    for (const entity of frame.entities) {
      const loaded = this.objects.get(entity.entityId)
      if (!loaded) continue
      if (!entity.dynamicGeometry?.length) { this.clearDynamicGeometry(loaded); continue }
      loaded.dynamicGeometry ??= new DynamicGeometryVisual(loaded.group, () => loaded.materialOverride?.reset())
      loaded.dynamicGeometry.update(entity.dynamicGeometry, loaded.visual, loaded.robot?.bodyNode)
      this.applyEntityMaterial(loaded)
      this.applyDisplay(loaded)
    }
    this.displayedFrame=frame
    this.syncRobotAnchors();this.robotAnchorLayer!.receive(frame)
    if (frame.cameras && this.cameraRigFrameId !== frame.frameId) {
      this.cameraRigFrameId = frame.frameId
      const specs = frame.cameras.flatMap(row => {
        if (row.available === false || row.frameId !== frame.frameId || row.stepIndex !== frame.stepIndex || row.generation !== frame.generation || row.sceneRevision !== frame.sceneRevision) return []
        const result = frustumFromReceipt(row)
        return result.ok ? [result.spec] : []
      })
      this.setCameraRigs(specs)
    }
    // 装配预览 ghost 绑定 scene/world/revision/generation 与源/目标 body：身份变了就清理，否则跟随当前目标 body。
    this.refreshAssemblyGhostForFrame(frame)
  }
  private clearDynamicGeometry(loaded: Loaded): void {
    if (!loaded.dynamicGeometry) return
    loaded.dynamicGeometry.dispose(); loaded.dynamicGeometry = undefined
    this.applyEntityMaterial(loaded)
  }
  /** 系统能力理由的本地化：走既有 `options.translate`（未接线时回中文，与历史行为逐字一致）。 */
  private reason(key: keyof typeof PART_REASONS): string {
    const [zh, en] = PART_REASONS[key]
    return (this.options?.translate ?? ((zhText: string) => zhText))(zh, en)
  }
  /**
   * 非机器人刚体物件的**真实结点身份缓存**（R-011）：只走原可视层级，跳过展示包装组，
   * 因此反复调用 `listParts` 不会改变 partId，也不会把新增包装结点列成用户部件。
   * 身份与 `Loaded` 同生命周期；换了可视对象（LOD/重建）才重算。
   */
  private nodeExplodeRuntime(loaded: Loaded): NodeExplodeRuntime {
    const visual = loaded.baseVisual ?? loaded.visual
    const existing = loaded.nodeExplode
    if (existing && existing.visual === visual) return existing
    const runtime: NodeExplodeRuntime = { visual, parts: [], wrappers: new Map(), offsets: new Map(), spread: 0 }
    if (!visual) return runtime
    const hasGeometryDescendant = (object: THREE.Object3D): boolean => {
      let found = false
      object.traverse(child => { if (!found && child !== object && (child instanceof THREE.Mesh || child instanceof THREE.SkinnedMesh)) found = true })
      return found
    }
    const walk = (object: THREE.Object3D, path: string[]): void => {
      const name = object.name || (object instanceof THREE.Mesh ? "mesh" : "node")
      const ownMesh = object instanceof THREE.Mesh || object.children.some(child => child instanceof THREE.Mesh || child instanceof THREE.SkinnedMesh)
      const partId = `node:${runtime.parts.length}`
      object.userData.partId = partId
      let reasonCode: NodePartReasonCode | undefined
      if (object instanceof THREE.SkinnedMesh) reasonCode = "PART_SKINNED"
      else if (object instanceof THREE.Mesh && hasGeometryDescendant(object)) reasonCode = "PART_NESTED_GEOMETRY"
      else if (object instanceof THREE.Mesh) reasonCode = undefined
      else if (ownMesh) reasonCode = "PART_GROUP_GEOMETRY"
      else reasonCode = "PART_NO_OWN_GEOMETRY"
      runtime.parts.push({ partId, node: object, name, path: [...path, name], hasVisual: ownMesh, separable: false, ...(reasonCode ? { reasonCode } : {}) })
      for (const child of object.children) {
        if (child.userData.presentationWrapper === true) continue
        if (child instanceof THREE.Mesh || child instanceof THREE.Group || child instanceof THREE.Scene) walk(child, [...path, name])
      }
    }
    walk(visual, [])
    const candidates = runtime.parts.filter(part => part.reasonCode === undefined)
    // 单一可视部件不提供炸开：不虚构可拆面；≥2 个真实结点才各自可独立展示偏移。
    if (candidates.length >= 2) for (const part of candidates) part.separable = true
    else for (const part of candidates) part.reasonCode = "PART_SINGLE"
    loaded.nodeExplode = runtime
    return runtime
  }
  /**
   * 懒建每个可分部件的**展示包装组**：插在真实结点与它的父之间，原结点局部矩阵原样搬过去
   * （包装单位矩阵 ⇒ 世界矩阵逐元素不变）。子部件仍挂在真实结点下，不继承父部件的偏移，
   * 因此各部件真正独立。包装结点打标，目录与后续遍历都跳过它。
   */
  private ensureNodeWrappers(runtime: NodeExplodeRuntime): void {
    for (const part of runtime.parts) {
      if (!part.separable || runtime.wrappers.has(part.partId)) continue
      const node = part.node, parent = node.parent
      if (!parent) continue
      const wrapper = new THREE.Group()
      wrapper.name = `presentation:${node.name || "mesh"}`
      wrapper.userData.presentationWrapper = true
      parent.add(wrapper)
      wrapper.add(node)
      runtime.wrappers.set(part.partId, wrapper)
    }
  }
  /** 只读展示层炸开（非机器人）：偏移只写包装组，真实结点/源几何/共享材质一个数不动。 */
  private setNodeExplodeSpread(loaded: Loaded, spread: number): void {
    const runtime = this.nodeExplodeRuntime(loaded)
    this.ensureNodeWrappers(runtime)
    for (const wrapper of runtime.wrappers.values()) wrapper.position.set(0, 0, 0)
    runtime.offsets.clear()
    const visual = loaded.baseVisual ?? loaded.visual
    visual?.updateWorldMatrix(true, true)
    const value = Number.isFinite(spread) ? Math.max(0, Math.min(1, spread)) : 0
    runtime.spread = value
    if (value <= 0) return
    const boxes = new Map<string, THREE.Box3>()
    const overall = new THREE.Box3()
    for (const part of runtime.parts) {
      if (!part.separable || !runtime.wrappers.has(part.partId)) continue
      const box = new THREE.Box3().setFromObject(part.node)
      if (box.isEmpty()) continue
      boxes.set(part.partId, box)
      overall.union(box)
    }
    if (overall.isEmpty()) return
    const center = overall.getCenter(new THREE.Vector3())
    const radius = Math.max(overall.getSize(new THREE.Vector3()).length() * 0.5, 1e-6)
    const distance = radius * NODE_EXPLODE_RADIUS_FACTOR * value
    for (const [partId, box] of boxes) {
      const wrapper = runtime.wrappers.get(partId)
      const parent = wrapper?.parent
      if (!wrapper || !parent) continue
      const direction = box.getCenter(new THREE.Vector3()).sub(center)
      if (direction.lengthSq() < 1e-12) continue
      direction.normalize().multiplyScalar(distance)
      parent.updateWorldMatrix(true, false)
      const basis = new THREE.Matrix4().copy(parent.matrixWorld)
      basis.setPosition(0, 0, 0)
      wrapper.position.copy(direction.applyMatrix4(basis.invert()))
      runtime.offsets.set(partId, wrapper.position.toArray() as [number, number, number])
    }
    visual?.updateWorldMatrix(true, true)
  }
  /** 对任意实体施加展示层展开比例：机器人走 RobotVisual，其余刚体物件走本实例的包装组。 */
  private applyEntitySpread(entityId: string, spread: number): void {
    const loaded = this.objects.get(entityId)
    if (!loaded) return
    if (loaded.robot) { loaded.robot.setExplodeSpread(spread); return }
    // 合拢时只有真的建过包装组才回写：不给不可炸开（LOD/动画/蒙皮/单部件）的实体白插一层包装。
    if (spread > 0) this.setNodeExplodeSpread(loaded, spread)
    else if (loaded.nodeExplode && loaded.nodeExplode.wrappers.size > 0) this.setNodeExplodeSpread(loaded, 0)
  }
  /** 炸开时真实 Transform 编辑必须先合拢/让位：展示偏移绝不能经 gizmo 写进 Scene。 */
  private transformEditBlockedByExplode(entityId: string | undefined): boolean {
    return entityId !== undefined && this.partExplode?.entityId === entityId && this.partExplode.spread > 0
  }
  /** 重新挂接/让位的**唯一判据**：选中实体、可编辑、未锁定、且未处于炸开展示态。 */
  private syncTransformGizmo(): void {
    const selected = this.selected
    const targetId = selected && this.snapshot ? sceneEditTarget(this.snapshot, selected)?.entityId : selected
    if (this.transformEditing && !this.placing && !this.annotating && targetId && this.options.commitEdit && this.objects.has(targetId) && this.snapshot?.entities.find(entity => entity.entityId === targetId)?.locked !== true && !this.transformEditBlockedByExplode(targetId) && !this.transformEditBlockedByExplode(selected)) this.transformControls.attach(this.objects.get(targetId)!.group)
    else this.transformControls.detach()
  }
  /** 显式进入/退出手动变换：默认 false，只显示选中轮廓；真实提交仍走原有 commitEdit。 */
  setTransformEditing(enabled: boolean): void {
    this.transformEditing = Boolean(enabled)
    if (!this.transformEditing) this.transformControls.axis = null
    this.syncTransformGizmo()
    this.syncObserverControls()
  }
  transformEditingEnabled(): boolean { return this.transformEditing }
  /** 展示层状态变化的唯一播报点：面板据此读回外部合拢/换身份后的实际 0 状态。 */
  private notifyPresentationState(): void { for (const listener of this.presentationListeners ?? []) listener() }
  subscribePresentationState(listener: () => void): () => void { (this.presentationListeners ??= new Set()).add(listener); return () => this.presentationListeners?.delete(listener) }
  /**
   * 该实体的**部件目录**（R-011）：机器人按真实 body/link 建；非机器人刚体物件按真实节点层级建，
   * 身份缓存稳定、可逆展示炸开。全部字段来自当前 `Loaded` 的真实身份/节点，不做几何猜测。
   */
  private partCatalog(entityId: string): ViewerPart[] {
    const loaded = this.objects.get(entityId)
    if (!loaded) return []
    const selected = this.selectedPart
    const isSelected = (partId: string) => selected?.entityId === entityId && selected.partId === partId
    const resource = loaded.baseRef ? `${loaded.baseRef.resourceId}@${loaded.baseRef.version}` : undefined
    if (loaded.robot) {
      const reason = this.explodeBlockReason(entityId, loaded)
      return loaded.robot.parts.map(part => ({
        entityId, partId: part.partId, name: part.name, kind: part.kind, path: part.path,
        ...(resource ? { resource } : {}), resourceSignature: loaded.signature, granularity: part.granularity,
        separable: part.hasVisual && reason === undefined,
        ...(!part.hasVisual ? { reason: this.reason("robotNoVisual") } : reason ? { reason } : {}),
        selected: isSelected(part.partId),
      }))
    }
    // 非机器人刚体物件：真实节点层级来自本实例自己的克隆（几何/材质仍共享，不被修改）。
    // 目录只列原层级结点；展示包装组不算用户部件，partId 由缓存身份给出，反复读取不变。
    const runtime = this.nodeExplodeRuntime(loaded)
    if (runtime.parts.length === 0) return []
    const reason = this.explodeBlockReason(entityId, loaded)
    const granularity: ViewerPart["granularity"] = runtime.parts.length >= 2 ? "hierarchy" : "single"
    return runtime.parts.map(part => ({
      entityId, partId: part.partId, name: part.name, kind: "node", path: part.path,
      ...(resource ? { resource } : {}), resourceSignature: loaded.signature, granularity,
      separable: part.separable && reason === undefined,
      ...(part.reasonCode && !part.separable ? { reason: this.reason(NODE_PART_REASON_KEY[part.reasonCode]) } : reason ? { reason } : {}),
      selected: isSelected(part.partId),
    }))
  }
  /** 该实体当前是否可炸开；不可时给出**具体**原因（动态几何/烘焙动画/LOD/蒙皮/单部件）。 */
  private explodeBlockReason(entityId: string, loaded: Loaded): string | undefined {
    if (loaded.dynamicGeometry) return this.reason("dynamic")
    if (loaded.mixer) return this.reason("animated")
    if (loaded.lod) return this.reason("lod")
    if (loaded.robot) return loaded.robot.parts.filter(part => part.hasVisual).length < 2 ? this.reason("robotSingle") : undefined
    const runtime = this.nodeExplodeRuntime(loaded)
    if (runtime.parts.length === 0) return this.reason("noVisual")
    if (runtime.parts.filter(part => part.separable).length >= 2) return undefined
    return this.reason(runtime.parts.some(part => part.reasonCode === "PART_SKINNED") ? "skinned" : "objectSingle")
  }
  /** 列出部件：给了 entityId 只列该实体；不给则列当前所有已加载实体（机器人优先）。 */
  listParts(entityId?: string): ViewerPart[] {
    if (entityId !== undefined) return this.partCatalog(entityId)
    return [...this.objects.keys()].flatMap(id => this.partCatalog(id))
  }
  /** 只收集实际提交给渲染器的顶点范围，材质数组按 geometry group 分开裁剪。 */
  private componentGeometryBounds(mesh: THREE.Mesh | THREE.Line | THREE.LineSegments | THREE.InstancedMesh): THREE.Box3 {
    const box = new THREE.Box3()
    const geometry = mesh.geometry
    const position = geometry.getAttribute("position")
    if (!position || position.count === 0 || !mesh.material) return box

    const index = geometry.index
    const sourceCount = index?.count ?? position.count
    const drawRange = geometry.drawRange
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const grouped = Array.isArray(mesh.material)
    const isMesh = mesh instanceof THREE.Mesh
    const isInstancedMesh = mesh instanceof THREE.InstancedMesh
    const isLine = mesh instanceof THREE.Line
    const isLineSegments = mesh instanceof THREE.LineSegments
    const vertexForSlot = (slot: number, wireframe: boolean): number => {
      if (wireframe) {
        const edge = slot % 6
        const triangleSlot = Math.floor(slot / 6) * 3 + [0, 1, 1, 2, 2, 0][edge]!
        return index ? index.getX(triangleSlot) : triangleSlot
      }
      return index ? index.getX(slot) : slot
    }
    const rangeFactorFor = (material: THREE.Material): number => isMesh && (material as THREE.MeshBasicMaterial).wireframe ? 2 : 1
    const renderElementCount = (material: THREE.Material): number => rangeFactorFor(material) === 2 ? Math.floor(sourceCount / 3) * 6 : sourceCount
    const instanceCount = isInstancedMesh ? mesh.count : 1
    const local = new THREE.Vector3()
    const instanceMatrix = new THREE.Matrix4()
    const worldMatrix = new THREE.Matrix4()
    const addVertex = (slot: number, wireframe: boolean, world: THREE.Matrix4) => {
      const vertex = vertexForSlot(slot, wireframe)
      if (!Number.isInteger(vertex) || vertex < 0 || vertex >= position.count) return
      if (isMesh) (mesh as THREE.Mesh).getVertexPosition(vertex, local)
      else local.fromBufferAttribute(position, vertex)
      box.expandByPoint(local.applyMatrix4(world))
    }

    const addRange = (material: THREE.Material, group?: { start: number; count: number; materialIndex?: number }) => {
      if (!material.visible || (material.transparent && material.opacity <= 0)) return
      const wireframe = rangeFactorFor(material) === 2
      const factor = wireframe ? 2 : 1
      let start = Math.max(0, drawRange.start * factor)
      let end = (drawRange.start + drawRange.count) * factor
      if (group) {
        start = Math.max(start, group.start * factor)
        end = Math.min(end, (group.start + group.count) * factor)
      }
      end = Math.min(end, renderElementCount(material))
      if (!Number.isFinite(start) || Number.isNaN(end)) return
      start = Math.ceil(start)
      end = Math.floor(end)
      if (end <= start) return

      // OpenGL ignores incomplete final primitives; do not let their unused tail vertices widen the frame.
      if (!wireframe && isMesh) end = start + Math.floor((end - start) / 3) * 3
      else if (!wireframe && isLineSegments) end = start + Math.floor((end - start) / 2) * 2
      if (end <= start || (isLine && !isLineSegments && end - start < 2)) return

      for (let instanceIndex = 0; instanceIndex < instanceCount; instanceIndex++) {
        let world = mesh.matrixWorld
        if (isInstancedMesh) {
          mesh.getMatrixAt(instanceIndex, instanceMatrix)
          worldMatrix.multiplyMatrices(mesh.matrixWorld, instanceMatrix)
          world = worldMatrix
        }
        for (let slot = start; slot < end; slot++) addVertex(slot, wireframe, world)
      }
    }

    if (grouped) {
      for (const group of geometry.groups) {
        const material = group.materialIndex === undefined ? undefined : materials[group.materialIndex]
        if (material) addRange(material, group)
      }
    } else {
      addRange(materials[0]!)
    }
    return box
  }
  /**
   * 显式 Components 取景的展示边界：保留全部可见尺寸，不用自动取景的主体/大几何过滤。
   * 只读取当前世界矩阵（包括 presentation/wrapper 炸开偏移），不回放帧、不改关节或展示姿态。
   */
  private componentDisplayBounds(root: THREE.Object3D): THREE.Box3 {
    const box = new THREE.Box3()
    let displayed = false
    for (let ancestor: THREE.Object3D | null = root; ancestor; ancestor = ancestor.parent) {
      if (!ancestor.visible || isAuthoringHelperRoot(ancestor)) return box
      if (ancestor === this.scene) displayed = true
    }
    // LOD 切换可保留已脱离 scene 的 baseVisual 目录；不能拿缓存节点冒充当前展示。
    if (!displayed) return box
    root.updateWorldMatrix(true, true)
    const stack = [root]
    while (stack.length) {
      const object = stack.pop()!
      if (!object.visible || isAuthoringHelperRoot(object)) continue
      stack.push(...object.children)
      if (!object.layers.test(this.camera.layers)) continue
      const mesh = object as THREE.Mesh
      const local = new THREE.Box3()
      const splat = this.splatBounds.get(object)
      if (splat) local.copy(splat)
      else if (mesh.geometry) local.copy(this.componentGeometryBounds(mesh))
      if (local.isEmpty()) continue
      if (![...local.min.toArray(), ...local.max.toArray()].every(Number.isFinite)) {
        throw new Error("COMPONENT_BOUNDS_INVALID: The component has invalid display bounds.")
      }
      box.union(local)
    }
    return box
  }
  /** 显式取景到一个真实部件；身份/几何失败前不改变观察相机，选择与炸开状态保持原值。 */
  framePart(entityId: string, partId: string): void {
    if (this.disposed) throw new Error("VIEWER_DISPOSED: The 3D viewport is no longer available.")
    const loaded = this.objects.get(entityId)
    if (!loaded) throw new Error("ENTITY_NOT_FOUND: The component's entity is not loaded.")
    // 先核对该实体自己的目录，不能以另一个实例的同名节点或 partId 代替。
    if (!this.partCatalog(entityId).some(part => part.partId === partId)) throw new Error("PART_NOT_FOUND: The selected component is no longer available.")
    const target = loaded.robot ? loaded.robot.parts.find(part => part.partId === partId)?.presentation : this.partNodeOf(loaded, partId)
    if (!target) throw new Error("PART_NOT_FOUND: The selected component is no longer available.")
    const box = this.componentDisplayBounds(target)
    if (box.isEmpty()) throw new Error("PART_NO_VISIBLE_GEOMETRY: The selected component has no visible geometry to frame.")
    this.frameBounds(box)
  }
  /** 显式取景到 Components 当前实体的完整展示；不含其它实体或临时装配 ghost。 */
  frameAssembly(entityId: string): void {
    if (this.disposed) throw new Error("VIEWER_DISPOSED: The 3D viewport is no longer available.")
    const loaded = this.objects.get(entityId)
    if (!loaded) throw new Error("ENTITY_NOT_FOUND: The assembly is not loaded.")
    const box = this.componentDisplayBounds(loaded.group)
    if (box.isEmpty()) throw new Error("ASSEMBLY_NO_VISIBLE_GEOMETRY: The assembly has no visible geometry to frame.")
    this.frameBounds(box)
  }
  /** 当前选中的部件（只读）。 */
  selectedPartRef(): ViewerPartSelection | undefined { return this.selectedPart ? { ...this.selectedPart } : undefined }
  /**
   * 选中一个真实部件：只做展示层高亮 + 上报，不写 Scene、不动物理 Transform。
   * 部件必须真属该实体；`partId` 缺省或不存在即清除选择。
   */
  selectPart(entityId: string | undefined, partId: string | undefined): void {
    const catalog = entityId ? this.partCatalog(entityId) : []
    const hit = partId !== undefined ? catalog.find(part => part.partId === partId) : undefined
    if (this.selectedPart !== undefined && (entityId === undefined || hit === undefined || this.selectedPart.entityId !== entityId || this.selectedPart.partId !== partId)) this.clearPartHighlight()
    this.selectedPart = entityId !== undefined && hit !== undefined ? { entityId, partId: hit.partId } : undefined
    if (this.selectedPart) this.applyPartHighlight(this.selectedPart.entityId, this.selectedPart.partId)
    this.options.onPartSelect?.(this.selectedPart ? { ...this.selectedPart } : undefined)
    this.notifyPresentationState()
  }
  /**
   * 展示层炸开：机器人只写 `RobotVisual` 的 presentation 组，刚体物件只写本实例的展示包装组；
   * 原生矩阵、源几何、Scene、物理一概不动。`spread=0` 即合拢；实体不可炸开时保持合拢并记原因。
   */
  setPartExplode(entityId: string, spread: number): { spread: number; reason?: string } {
    const loaded = this.objects.get(entityId)
    const value = Number.isFinite(spread) ? Math.max(0, Math.min(1, spread)) : 0
    const reason = loaded ? this.explodeBlockReason(entityId, loaded) : this.reason("notLoaded")
    const effective = loaded && reason === undefined ? value : 0
    // 换实体的旧偏移先合拢，绝不让上一台机器人/物件留在展开态。
    if (this.partExplode && this.partExplode.entityId !== entityId) this.applyEntitySpread(this.partExplode.entityId, 0)
    this.applyEntitySpread(entityId, effective)
    this.partExplode = { entityId, spread: effective, ...(reason ? { reason } : {}) }
    this.syncTransformGizmo()
    this.notifyPresentationState()
    return { spread: effective, ...(reason ? { reason } : {}) }
  }
  /** 合拢当前炸开视图并清除部件高亮（切换场景/工具/关闭面板时的显式收口）。 */
  restorePartExplode(): void {
    if (this.partExplode) this.applyEntitySpread(this.partExplode.entityId, 0)
    this.partExplode = undefined
    this.syncTransformGizmo()
    this.notifyPresentationState()
  }
  /** 当前展示层炸开读数（含不可炸开原因）。 */
  partExplodeStatus(): { entityId?: string; spread: number; reason?: string } {
    return this.partExplode ? { entityId: this.partExplode.entityId, spread: this.partExplode.spread, ...(this.partExplode.reason ? { reason: this.partExplode.reason } : {}) } : { spread: 0 }
  }
  /**
   * R-012／§2.9：临时装配预览 ghost。clone 真实已加载几何与**当时内部关节姿态**，材质独立透明，
   * 按源 native 根、目标 body 与源安装面精确对齐。
   *
   * 边界：不新增真实 Scene 实体、不改共享材质/geometry（克隆只复制节点结构）、不动物理 Transform、
   * 不进入部件目录/选择实体。只有 `robot_set_base` 会提交绑定；ghost 本身不是兼容或装配成功。
   * 源处于炸开态时由调用方先显式 `restorePartExplode()`（本方法不改炸开状态，只消费原生节点）。
   */
  previewAssemblyGhost(spec: ViewerAssemblyGhostSpec): ViewerAssemblyGhostResult {
    this.clearAssemblyPreview()
    const source = this.objects.get(spec.sourceEntityId), target = this.objects.get(spec.targetEntityId)
    if (!source) return { status: "UNAVAILABLE", reason: "ASSEMBLY_PREVIEW_SOURCE_NOT_LOADED", sourceEntityId: spec.sourceEntityId }
    // 源正在炸开时不得把展示偏移当成物理安装面：先由调用方显式 `restorePartExplode()` 合拢再预览。
    if (this.partExplode && this.partExplode.spread > 0 && this.partExplode.entityId === spec.sourceEntityId) return { status: "UNAVAILABLE", reason: "ASSEMBLY_PREVIEW_SOURCE_EXPLODED", sourceEntityId: spec.sourceEntityId }
    if (!target?.robot) return { status: "UNAVAILABLE", reason: "ASSEMBLY_PREVIEW_TARGET_NOT_LOADED", targetEntityId: spec.targetEntityId }
    const body = target.robot.bodyNode(localBodyName(spec.targetBodyName, spec.targetEntityId))
    if (!body) return { status: "UNAVAILABLE", reason: "ASSEMBLY_PREVIEW_TARGET_BODY_MISSING", targetBodyName: spec.targetBodyName }
    const pose = spec.targetBodyFromSourceRoot
    if (!Array.isArray(pose?.positionM) || pose.positionM.length !== 3 || pose.positionM.some(value => !Number.isFinite(value)) || !Array.isArray(pose?.quaternionXyzw) || pose.quaternionXyzw.length !== 4 || pose.quaternionXyzw.some(value => !Number.isFinite(value))) {
      return { status: "UNAVAILABLE", reason: "ASSEMBLY_PREVIEW_POSE_INVALID" }
    }
    // 源实体的可见根：优先当前 LOD 级别的可视对象，回落到实体 group。克隆节点结构，几何/贴图仍共享。
    // 回落到 group 时清零克隆根自身的局部变换，避免把 `entityTransform · rootFrameInverse` 叠加两次。
    const useGroupFallback = !source.visual && !source.baseVisual
    const sourceVisual = source.visual ?? source.baseVisual ?? source.group
    const visual = sourceVisual.clone(true)
    if (useGroupFallback) { visual.position.set(0, 0, 0); visual.quaternion.identity(); visual.scale.set(1, 1, 1) }
    const materials: THREE.Material[] = []
    visual.traverse(child => {
      const mesh = child as THREE.Mesh
      if (!(mesh as THREE.Mesh).isMesh) return
      const clone = (material: THREE.Material) => {
        const copy = material.clone()
        copy.transparent = true
        copy.opacity = 0.45
        copy.depthWrite = false
        materials.push(copy)
        return copy
      }
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(clone) : clone(mesh.material)
      // ghost 不参与拾取/选择/放置：即使克隆保留了 userData.entityId 也不会被射线命中。
      ;(mesh as unknown as { raycast: () => void }).raycast = () => {}
    })
    visual.userData.assemblyGhost = true
    visual.userData.entityId = undefined
    // 源 group 的本地矩阵是 `entityTransform · rootFrameInverse`；ghost 根要放成
    // `targetBodyWorld · install · rootFrameInverse`，模型帧点 p → targetBodyWorld·install·(rootFrame^-1·p)。
    const rootFrameInverse = (source.robot?.rootFrameInverse ?? new THREE.Matrix4()).clone()
    const install = new THREE.Matrix4().compose(new THREE.Vector3(...pose.positionM), new THREE.Quaternion(...pose.quaternionXyzw).normalize(), new THREE.Vector3(1, 1, 1))
    const targetBodyLocalName = localBodyName(spec.targetBodyName, spec.targetEntityId)
    const ghost = new THREE.Group()
    ghost.name = "assembly-ghost"
    ghost.matrixAutoUpdate = false
    ghost.userData.assemblyGhost = true
    markAuthoringHelper(ghost)
    ghost.add(visual)
    const marker = new THREE.Group()
    marker.name = "assembly-mount-marker"
    marker.matrixAutoUpdate = false
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 8), new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.85, depthWrite: false }))
    dot.userData.assemblyGhost = true
    ;(dot as unknown as { raycast: () => void }).raycast = () => {}
    marker.add(dot)
    marker.userData.assemblyGhost = true
    markAuthoringHelper(marker)
    this.scene.add(ghost)
    this.scene.add(marker)
    this.assemblyGhost = {
      sourceEntityId: spec.sourceEntityId, targetEntityId: spec.targetEntityId, targetBodyName: spec.targetBodyName,
      ...(spec.sourceRootBodyName ? { sourceRootBodyName: spec.sourceRootBodyName } : {}),
      targetBodyLocalName,
      ...(spec.worldId ? { worldId: spec.worldId } : {}), ...(spec.sceneId ? { sceneId: spec.sceneId } : {}),
      ...(spec.sceneRevision !== undefined ? { sceneRevision: spec.sceneRevision } : {}), ...(spec.generation !== undefined ? { generation: spec.generation } : {}),
      ...(spec.sourceResourceSignature ? { sourceResourceSignature: spec.sourceResourceSignature } : {}), ...(spec.targetResourceSignature ? { targetResourceSignature: spec.targetResourceSignature } : {}),
      install, rootFrameInverse, sourceVisual, root: ghost, visual, marker, materials,
    }
    // 首次就用当前目标 body 摆好；之后每帧由 applyFrame 用**当前** body 重算，身体移动时 ghost 跟随。
    this.refreshAssemblyGhost()
    this.notifyPresentationState()
    return { status: "PREVIEW", sourceEntityId: spec.sourceEntityId, targetEntityId: spec.targetEntityId, targetBodyName: spec.targetBodyName }
  }
  /**
   * 用**当前**目标 body 世界位姿重算 ghost 根/标记矩阵，并把源克隆的内部关节姿态对齐到源当前姿态。
   * 只重算矩阵，不重建几何、不新增 Scene 实体；目标 body 缺失就清理（不留下漂在旧位置的手）。
   */
  private refreshAssemblyGhost(): void {
    const ghost = this.assemblyGhost
    if (!ghost) return
    const target = this.objects.get(ghost.targetEntityId)
    const body = target?.robot?.bodyNode(ghost.targetBodyLocalName)
    if (!body) { this.clearAssemblyPreview(); return }
    // 源关节/根姿态对齐：克隆与源可视对象同结构，逐节点复制局部矩阵（共享 geometry 不动）。
    // 跳过各自的根节点：ghost 根的摆放由上面的 ghost.matrix 全权负责，复制它会叠加两次。
    const source = this.objects.get(ghost.sourceEntityId)
    if (source?.robot) {
      const from: THREE.Object3D[] = [], to: THREE.Object3D[] = []
      ghost.sourceVisual.traverse(object => from.push(object))
      ghost.visual.traverse(object => to.push(object))
      if (from.length === to.length) for (let index = 1; index < from.length; index++) {
        to[index].matrix.copy(from[index].matrix)
        to[index].matrixAutoUpdate = from[index].matrixAutoUpdate
        to[index].matrixWorldNeedsUpdate = true
      }
    }
    body.updateWorldMatrix(true, false)
    ghost.root.matrix.copy(body.matrixWorld).multiply(ghost.install).multiply(ghost.rootFrameInverse)
    ghost.root.matrixWorldNeedsUpdate = true
    ghost.marker.matrix.copy(body.matrixWorld).multiply(ghost.install)
    ghost.marker.matrixWorldNeedsUpdate = true
  }
  /**
   * 原生帧到达后按身份与源/目标资源核对 ghost：任一变化或目标 body 缺姿态都清理。
   * 同一身份则用当前目标 body 重算，保证 body 移动时预览跟随。
   */
  private refreshAssemblyGhostForFrame(frame: Frame): void {
    this.refreshParkingGhostForFrame(frame)
    const ghost = this.assemblyGhost
    if (!ghost) return
    if ((ghost.worldId !== undefined && ghost.worldId !== frame.worldId) || (ghost.generation !== undefined && ghost.generation !== frame.generation) || (ghost.sceneRevision !== undefined && ghost.sceneRevision !== frame.sceneRevision)) { this.clearAssemblyPreview(); return }
    const entity = frame.entities.find(row => row.entityId === ghost.targetEntityId)
    const poses = entity?.sensors?.bodyWorldPoses as Record<string, unknown> | undefined
    const targetPose = poses?.[ghost.targetBodyLocalName] ?? poses?.[`${ghost.targetEntityId}/${ghost.targetBodyLocalName}`]
    if (!targetPose) { this.clearAssemblyPreview(); return }
    this.refreshAssemblyGhost()
  }
  /**
   * R-012 Replace：把旧末端显示在**明确的世界停放位姿**上做临时预览。
   * 只显示：不新增 Scene 实体、不动物理、不决定停放位置；停放位置由调用方给出的真实世界位姿驱动。
   */
  previewParkingGhost(spec: ViewerParkingGhostSpec): ViewerParkingGhostResult {
    this.clearParkingGhost()
    const source = this.objects.get(spec.entityId)
    if (!source) return { status: "UNAVAILABLE", reason: "ASSEMBLY_PREVIEW_SOURCE_NOT_LOADED", entityId: spec.entityId }
    const pose = spec.worldPose
    if (!Array.isArray(pose?.positionM) || pose.positionM.length !== 3 || pose.positionM.some(value => !Number.isFinite(value)) || !Array.isArray(pose?.quaternionXyzw) || pose.quaternionXyzw.length !== 4 || pose.quaternionXyzw.some(value => !Number.isFinite(value))) {
      return { status: "UNAVAILABLE", reason: "ASSEMBLY_PREVIEW_POSE_INVALID", entityId: spec.entityId }
    }
    const useGroupFallback = !source.visual && !source.baseVisual
    const sourceVisual = source.visual ?? source.baseVisual ?? source.group
    const visual = sourceVisual.clone(true)
    if (useGroupFallback) { visual.position.set(0, 0, 0); visual.quaternion.identity(); visual.scale.set(1, 1, 1) }
    const materials: THREE.Material[] = []
    visual.traverse(child => {
      const mesh = child as THREE.Mesh
      if (!(mesh as THREE.Mesh).isMesh) return
      const clone = (material: THREE.Material) => {
        const copy = material.clone()
        copy.transparent = true
        copy.opacity = 0.35
        copy.depthWrite = false
        materials.push(copy)
        return copy
      }
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(clone) : clone(mesh.material)
      ;(mesh as unknown as { raycast: () => void }).raycast = () => {}
    })
    visual.userData.assemblyGhost = true
    visual.userData.entityId = undefined
    const rootFrameInverse = (source.robot?.rootFrameInverse ?? new THREE.Matrix4()).clone()
    const root = new THREE.Group()
    root.name = "parking-ghost"
    root.matrixAutoUpdate = false
    root.userData.assemblyGhost = true
    markAuthoringHelper(root)
    root.add(visual)
    const world = new THREE.Matrix4().compose(new THREE.Vector3(...pose.positionM), new THREE.Quaternion(...pose.quaternionXyzw).normalize(), new THREE.Vector3(1, 1, 1))
    root.matrix.copy(world).multiply(rootFrameInverse)
    root.matrixWorldNeedsUpdate = true
    this.scene.add(root)
    this.parkingGhost = {
      entityId: spec.entityId,
      worldPose: {positionM: [pose.positionM[0], pose.positionM[1], pose.positionM[2]], quaternionXyzw: [pose.quaternionXyzw[0], pose.quaternionXyzw[1], pose.quaternionXyzw[2], pose.quaternionXyzw[3]]},
      ...(spec.worldId ? { worldId: spec.worldId } : {}), ...(spec.sceneId ? { sceneId: spec.sceneId } : {}),
      ...(spec.sceneRevision !== undefined ? { sceneRevision: spec.sceneRevision } : {}), ...(spec.generation !== undefined ? { generation: spec.generation } : {}),
      root, visual, materials,
    }
    this.notifyPresentationState()
    return { status: "PREVIEW", entityId: spec.entityId }
  }
  /** 停放 ghost 的身份核对：scene/world/revision/generation 任一变化即清理（停放是世界位姿，不逐帧重算）。 */
  private refreshParkingGhostForFrame(frame: Frame): void {
    const ghost = this.parkingGhost
    if (!ghost) return
    if ((ghost.worldId !== undefined && ghost.worldId !== frame.worldId) || (ghost.generation !== undefined && ghost.generation !== frame.generation) || (ghost.sceneRevision !== undefined && ghost.sceneRevision !== frame.sceneRevision)) this.clearParkingGhost()
  }
  /** 只移除停放 ghost 与克隆材质；共享 geometry 绝不销毁。 */
  clearParkingGhost(): void {
    const ghost = this.parkingGhost
    if (!ghost) return
    ghost.root.removeFromParent()
    for (const material of ghost.materials) material.dispose()
    ghost.root.clear()
    this.parkingGhost = undefined
    this.notifyPresentationState()
  }
  /** 取消/退出/换上下文：移除 ghost 与 marker，销毁克隆材质（共享 geometry 绝不销毁）。 */
  clearAssemblyPreview(): void {
    this.clearParkingGhost()
    const ghost = this.assemblyGhost
    if (!ghost) return
    ghost.root.removeFromParent()
    ghost.marker.removeFromParent()
    for (const material of ghost.materials) material.dispose()
    // marker 的 geometry/material 由本 Viewer 创建，随 marker 一并销毁；ghost.root 的 geometry 是共享的，不 dispose。
    disposeObject(ghost.marker)
    ghost.root.clear()
    this.assemblyGhost = undefined
    this.notifyPresentationState()
  }
  /**
   * V10-08/38：真实资产放置 ghost。用服务端只读预览返回的临时 Entity 数据走**既有 `loadVisual`**
   * 读取真实 mesh/robot；挂在独立 authoring helper 子树，材质独立半透明，不写 `objects`/snapshot，
   * 不进部件目录/物理/主拾取/采集。token 或 scene 变化时迟到结果原地丢弃，不复活旧 ghost。
   */
  async previewPlacement(spec: ViewerPlacementPreviewSpec): Promise<ViewerPlacementPreviewResult> {
    this.clearPlacementPreview()
    const generation = ++this.placementPreviewGeneration
    if (this.disposed) return { status: "UNAVAILABLE", reason: "VIEWER_DISPOSED", token: spec.token }
    if (this.snapshot && this.snapshot.sceneId !== spec.sceneId) return { status: "UNAVAILABLE", reason: "ASSET_PREVIEW_SCENE_CHANGED", token: spec.token }
    if (!Array.isArray(spec.entities) || spec.entities.length === 0) return { status: "UNAVAILABLE", reason: "ASSET_PREVIEW_EMPTY", token: spec.token }
    const stale = (): boolean => this.disposed || generation !== this.placementPreviewGeneration || Boolean(this.snapshot && this.snapshot.sceneId !== spec.sceneId)
    const materials: THREE.Material[] = []
    const root = new THREE.Group()
    root.name = "placement-ghost"
    root.matrixAutoUpdate = false
    root.userData.placementGhost = true
    markAuthoringHelper(root)
    // 本次 ghost **实际拥有**的 GPU 资源。GLTF 缓存克隆打了 sharedVisual：几何/贴图归缓存，不能销毁；
    // 机器人网格、无限地面等由本次 loadVisual 新建 ⇒ 必须在这里统一释放。root.clear 只脱树，不释放 GPU。
    const ownedGeometry = new Set<THREE.BufferGeometry>()
    const ownedMaterials = new Set<THREE.Material>()
    const ownedTextures = new Set<THREE.Texture>()
    const ownedSplats = new Set<SplatMesh>()
    const clonedMaterials = new Set<THREE.Material>()
    let released = false
    const collectTextures = (material: THREE.Material) => {
      for (const value of Object.values(material as unknown as Record<string, unknown>)) if (value instanceof THREE.Texture) ownedTextures.add(value)
    }
    const collectOwnedVisual = (visual: THREE.Object3D) => {
      visual.traverse(child => {
        if (child.userData.sharedVisual === true) return
        if (child instanceof SplatMesh) { ownedSplats.add(child); return }
        const drawable = child as THREE.Mesh | THREE.LineSegments
        if (!(drawable instanceof THREE.Mesh) && !(drawable instanceof THREE.LineSegments)) return
        if (drawable.geometry) ownedGeometry.add(drawable.geometry)
        const list = Array.isArray(drawable.material) ? drawable.material : [drawable.material]
        for (const material of list) { if (!material) continue; ownedMaterials.add(material); collectTextures(material) }
      })
    }
    const release = (): void => {
      if (released) return
      released = true
      for (const material of clonedMaterials) material.dispose()
      for (const material of ownedMaterials) material.dispose()
      for (const texture of ownedTextures) texture.dispose()
      for (const geometry of ownedGeometry) geometry.dispose()
      for (const splat of ownedSplats) splat.dispose()
      clonedMaterials.clear(); ownedMaterials.clear(); ownedTextures.clear(); ownedGeometry.clear(); ownedSplats.clear()
    }
    const detachSelf = () => {
      if (this.placementGhost?.root === root) {
        root.removeFromParent()
        this.placementGhost = undefined
      }
    }
    const fail = (reason: string): ViewerPlacementPreviewResult => {
      detachSelf(); release(); root.clear()
      return { status: "UNAVAILABLE", reason, token: spec.token }
    }
    const discard = (): ViewerPlacementPreviewResult => {
      detachSelf(); release(); root.clear()
      return { status: "SUPERSEDED", reason: "ASSET_PREVIEW_SUPERSEDED", token: spec.token }
    }
    const groups = new Map<string, THREE.Group>()
    for (const entity of spec.entities) {
      const group = new THREE.Group()
      group.name = `placement:${entity.entityId}`
      group.matrixAutoUpdate = false
      group.position.set(...entity.transform.position)
      group.quaternion.fromArray(entity.transform.quaternion).normalize()
      group.scale.set(...entity.transform.scale)
      group.updateMatrix()
      group.matrixWorldNeedsUpdate = true
      group.userData.placementGhost = true
      markAuthoringHelper(group)
      groups.set(entity.entityId, group)
    }
    for (const entity of spec.entities) {
      const group = groups.get(entity.entityId)!
      const parent = entity.parentId ? groups.get(entity.parentId) : undefined
      ;(parent ?? root).add(group)
    }
    try {
      for (const entity of spec.entities) {
        const group = groups.get(entity.entityId)!
        const loaded = { group, signature: `placement:${spec.token}:${entity.entityId}`, lodWarnings: [] } as unknown as Loaded
        const visual = await this.loadVisual(entity, loaded, spec.resolveResource ?? this.options.resolveResource)
        // 先登记所有权，再判迟到：loadVisual 刚返回但请求已被替换/换 Scene 时，这棵子树的几何/材质不能悬空。
        if (visual) collectOwnedVisual(visual)
        if (stale()) return discard()
        if (!visual) continue
        // 独立半透明材质：只复制材质，不改共享几何/贴图/原材质；raycast 关闭，ghost 不参与主拾取。
        visual.traverse(child => {
          const mesh = child as THREE.Mesh
          if (!mesh.isMesh) return
          const cloneMaterial = (material: THREE.Material) => {
            const copy = material.clone()
            copy.transparent = true
            copy.opacity = Math.min(0.45, typeof copy.opacity === "number" && copy.opacity > 0 ? copy.opacity * 0.55 : 0.45)
            copy.depthWrite = false
            clonedMaterials.add(copy)
            materials.push(copy)
            return copy
          }
          mesh.material = Array.isArray(mesh.material) ? mesh.material.map(cloneMaterial) : cloneMaterial(mesh.material)
          mesh.userData.placementGhost = true
          ;(mesh as unknown as { raycast: () => void }).raycast = () => {}
        })
        visual.userData.placementGhost = true
        markAuthoringHelper(visual)
        group.add(visual)
      }
      if (stale()) return discard()
      let hasVisual = false
      root.traverse(child => { if ((child as THREE.Mesh).isMesh) hasVisual = true })
      if (!hasVisual) return fail("ASSET_PREVIEW_NO_VISUAL")
      this.scene.add(root)
      this.placementGhost = { token: spec.token, sceneId: spec.sceneId, resourceId: spec.resourceId, version: spec.version, root, materials, dispose: release }
      this.notifyPresentationState()
      return { status: "PREVIEW", token: spec.token }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
  }
  /** 取消/确认/换资源/换 Scene/销毁：移除 ghost 与克隆材质；共享 geometry/贴图一律不动。 */
  clearPlacementPreview(): void {
    this.placementPreviewGeneration += 1
    const ghost = this.placementGhost
    if (!ghost) return
    ghost.root.removeFromParent()
    ghost.dispose()
    ghost.root.clear()
    this.placementGhost = undefined
    this.notifyPresentationState()
  }
  /**
   * V10：只把**已加载的真实 placement ghost**框进查看相机。只动相机，不写 Scene/物理/落点，
   * 不并入落点圈或远处原件；没有 ghost 时返回 ok:false，由调用方保留原视角。
   */
  framePlacementPreview(): { ok: boolean; token?: string } {
    const ghost = this.placementGhost
    if (!ghost) return { ok: false }
    ghost.root.updateMatrixWorld(true)
    // ghost 根与子组都打了 authoring helper 标记；要框的是标记内部的真实 ghost 几何。
    const box = new THREE.Box3().setFromObject(ghost.root)
    if (box.isEmpty()) return { ok: false, token: ghost.token }
    this.frameBounds(box)
    return { ok: true, token: ghost.token }
  }
  /** 只读 ghost 读数；`active` 只说明有临时放置预览，不代表任何已提交实体。 */
  placementPreviewStatus(): { active: boolean; token?: string; sceneId?: string; resourceId?: string; version?: number } {
    return this.placementGhost ? { active: true, token: this.placementGhost.token, sceneId: this.placementGhost.sceneId, resourceId: this.placementGhost.resourceId, version: this.placementGhost.version } : { active: false }
  }
  /** 当前 ghost 读数（只读；`active` 只说明有临时预览，不代表任何物理绑定）。 */
  assemblyPreviewStatus(): { active: boolean; sourceEntityId?: string; targetEntityId?: string; targetBodyName?: string } {
    return this.assemblyGhost ? { active: true, sourceEntityId: this.assemblyGhost.sourceEntityId, targetEntityId: this.assemblyGhost.targetEntityId, targetBodyName: this.assemblyGhost.targetBodyName } : { active: false }
  }
  /**
   * V10-33：把临时安装 ghost 与目标机器人一起框进真实查看相机。
   *
   * 只移动查看相机：不改 Scene、world、物理、选择或 ghost 位姿；没有 ghost 时返回 ok:false，
   * 调用方保留原视角。目标组只取该机器人自身，不并入远处未挂接手或无限地面。
   */
  frameAssemblyPreview(): { ok: boolean; entityIds: string[] } {
    const ghost = this.assemblyGhost
    if (!ghost) return { ok: false, entityIds: [] }
    ghost.root.updateMatrixWorld(true)
    ghost.visual.updateMatrixWorld(true)
    ghost.marker.updateMatrixWorld(true)
    // ghost.visual 本身是 authoring helper：这里要框的是 helper **内部**的真实几何，
    // 不能用会跳过 helper 整棵子树的 objectWorldBounds。
    ghost.visual.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(ghost.visual)
    const target = this.objects.get(ghost.targetEntityId)
    if (target) {
      target.group.updateMatrixWorld(true)
      const targetBox = objectWorldBounds(target.group, this.splatViewBounds, true, false)
      if (!targetBox.isEmpty()) box.union(targetBox)
    }
    if (box.isEmpty()) return { ok: false, entityIds: [ghost.sourceEntityId, ghost.targetEntityId] }
    this.frameBounds(box)
    return { ok: true, entityIds: [ghost.sourceEntityId, ghost.targetEntityId] }
  }
  /** 采集/观察携带的同帧展示层元数据；未炸开且无选中部件时也如实给出 `exploded:false`。 */
  presentationStatus(): PresentationCaptureFace {
    const entityId = this.partExplode?.entityId ?? this.selectedPart?.entityId
    const selected = this.selectedPart ? this.partCatalog(this.selectedPart.entityId).find(part => part.partId === this.selectedPart!.partId) : undefined
    const loaded = entityId ? this.objects.get(entityId) : undefined
    const catalogRows = entityId ? this.partCatalog(entityId) : []
    return {
      displayOnly: true,
      exploded: (this.partExplode?.spread ?? 0) > 0,
      spread: this.partExplode?.spread ?? 0,
      ...(entityId ? { entityId } : {}),
      ...(selected ? { selectedPart: { entityId: selected.entityId, partId: selected.partId, name: selected.name, kind: selected.kind } } : {}),
      ...(entityId && loaded ? { catalog: { entityId, ...(selected?.resource ? { resource: selected.resource } : {}), signature: loaded.signature, parts: catalogRows.length, separable: catalogRows.filter(part => part.separable).length } } : {}),
      // ghost 必须可解释为**未应用**的装配预览：否则模型会把画面里的第二只手当成真实实体。
      ...(this.assemblyGhost ? { assemblyPreview: this.assemblyPreviewFace() } : {}),
      ...(this.parkingGhost ? { parkingPreview: this.parkingPreviewFace() } : {}),
    }
  }
  /** 停放 ghost 只读读数；`active` 只说明有临时预览，不代表任何物理停放或声明。 */
  parkingPreviewStatus(): { active: boolean; entityId?: string; positionM?: [number, number, number]; quaternionXyzw?: [number, number, number, number] } {
    if (!this.parkingGhost) return { active: false }
    const face = this.parkingPreviewFace()
    return { active: true, entityId: face.entityId, positionM: face.positionM, quaternionXyzw: face.quaternionXyzw }
  }
  /** ghost 的采集窄面：只说明"这是未应用预览"及其源/目标/帧身份，绝不含任何已提交声明。 */
  private assemblyPreviewFace(): ViewerAssemblyPreviewFace {
    const ghost = this.assemblyGhost!
    return {
      applied: false,
      sourceEntityId: ghost.sourceEntityId,
      targetEntityId: ghost.targetEntityId,
      targetBodyName: ghost.targetBodyName,
      ...(ghost.sourceRootBodyName ? { sourceRootBodyName: ghost.sourceRootBodyName } : {}),
      ...(ghost.worldId ? { worldId: ghost.worldId } : {}),
      ...(ghost.sceneRevision !== undefined ? { sceneRevision: ghost.sceneRevision } : {}),
      ...(ghost.generation !== undefined ? { generation: ghost.generation } : {}),
    }
  }
  /** 旧件停放 ghost 的采集窄面：旧件 ID + 明确世界停放位姿 + `applied:false`，不说成已提交停放。 */
  private parkingPreviewFace(): ViewerParkingPreviewFace {
    const ghost = this.parkingGhost!
    return {
      applied: false,
      entityId: ghost.entityId,
      positionM: [ghost.worldPose.positionM[0], ghost.worldPose.positionM[1], ghost.worldPose.positionM[2]],
      quaternionXyzw: [ghost.worldPose.quaternionXyzw[0], ghost.worldPose.quaternionXyzw[1], ghost.worldPose.quaternionXyzw[2], ghost.worldPose.quaternionXyzw[3]],
      ...(ghost.worldId ? { worldId: ghost.worldId } : {}),
      ...(ghost.sceneRevision !== undefined ? { sceneRevision: ghost.sceneRevision } : {}),
      ...(ghost.generation !== undefined ? { generation: ghost.generation } : {}),
    }
  }
  /** 换回原材质、释放高亮克隆；共享材质一个字节都不改（只替换 Mesh 的材质引用，再换回）。 */
  private clearPartHighlight(): void {
    const highlight = this.partHighlight
    if (!highlight) return
    for (const { mesh, original } of highlight.swaps) { const current = mesh.material; mesh.material = original; if (Array.isArray(current)) for (const material of current) material.dispose(); else current.dispose() }
    this.partHighlight = undefined
  }
  private applyPartHighlight(entityId: string, partId: string): void {
    this.clearPartHighlight()
    const loaded = this.objects.get(entityId)
    if (!loaded) return
    const part = loaded.robot?.parts.find(row => row.partId === partId)
    const target = part?.presentation ?? this.partNodeOf(loaded, partId)
    if (!target) return
    const swaps: Array<{ mesh: THREE.Mesh; original: THREE.Material | THREE.Material[] }> = []
    target.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return
      const original = object.material
      const cloneOne = (material: THREE.Material): THREE.Material => {
        const clone = material.clone()
        const emissive = (clone as THREE.MeshStandardMaterial).emissive
        if (emissive instanceof THREE.Color) { emissive.set(0xffb020); (clone as THREE.MeshStandardMaterial).emissiveIntensity = 1 }
        return clone
      }
      object.material = Array.isArray(original) ? original.map(cloneOne) : cloneOne(original)
      swaps.push({ mesh: object, original })
    })
    this.partHighlight = { entityId, partId, swaps }
  }
  /** 非机器人资源的部件节点：按 partId 在可视层级里定位（tag 过 userData.partId）。 */
  private partNodeOf(loaded: Loaded, partId: string): THREE.Object3D | undefined {
    const root = loaded.baseVisual ?? loaded.visual
    let found: THREE.Object3D | undefined
    root?.traverse(object => { if (!found && object.userData.partId === partId) found = object })
    return found
  }
  /** 按身份清理旧部件/高亮/展开（实体删除、资源版本变化、scene/world/generation 切换、dispose）。 */
  private clearPartState(entityId?: string): void {
    if (entityId === undefined) {
      if (this.partExplode) this.applyEntitySpread(this.partExplode.entityId, 0)
      this.clearPartHighlight(); this.partExplode = undefined
      const had = this.selectedPart !== undefined
      this.selectedPart = undefined
      if (had) this.options.onPartSelect?.(undefined)
      this.notifyPresentationState()
      return
    }
    if (this.partExplode?.entityId === entityId) { this.applyEntitySpread(entityId, 0); this.partExplode = undefined }
    if (this.partHighlight?.entityId === entityId) this.clearPartHighlight()
    if (this.selectedPart?.entityId === entityId) { this.selectedPart = undefined; this.options.onPartSelect?.(undefined) }
    this.notifyPresentationState()
  }
  select(entityId: string | undefined): void {
    if(this.cameraRigGizmoKey!==undefined){if(entityId===this.selected)return;this.exitCameraMode({restoreView:false})}
    this.selected = entityId
    this.syncRobotAnchors()
    // 重新挂接与 `setEditCommit` 共用同一条判据：炸开的实体先合拢前不挂真实 Transform。
    this.syncTransformGizmo()
    this.syncCollisionTopology()
    this.options.onSelection?.(entityId)
  }
  setGizmoMode(mode: "translate" | "rotate" | "scale"): void { this.transformControls.setMode(mode) }
  /**
   * 批注模式：左键落点固定为"新建批注"或"选中批注"，不再改对象选择。
   *
   * 为什么用模式而不是常驻左键：视口左键已经有两个语义（选择对象、放置素材），
   * 再塞一个"随手点就是批注"会让用户无法预判；模式切换是显式的，也让落点判据只有一条。
   */
  setAnnotationMode(on: boolean): void {
    if (this.annotating === on) return
    this.annotating = on
    if (on) {
      this.annotationTransformEnabled = this.placing ? this.placementTransformEnabled ?? this.transformControls.enabled : this.transformControls.enabled
      this.transformControls.enabled = false
      this.transformControls.axis = null
    } else {
      if (!this.placing && this.annotationTransformEnabled !== undefined) this.transformControls.enabled = this.annotationTransformEnabled
      this.annotationTransformEnabled = undefined
    }
    this.syncTransformGizmo()
  }
  /**
   * 用外部（面板/持久化）的批注集合替换当前显示。
   *
   * 只按 annotationId 增量重建：改文字不会让标记闪一下，删掉的标记立即释放，
   * 未变的标记保持同一个对象（选中态与朝向不会被重建打断）。实体暂时不存在的批注保留在集合里、
   * 标记隐藏但不删除——实体回来（换场景版本、重新加载）时它必须还在，否则用户的批注会自己消失。
   */
  setAnnotations(annotations: ViewerAnnotation[]): void {
    this.annotations = annotations.map(annotation => structuredClone(annotation))
    const wanted = new Set(this.annotations.map(annotation => annotation.annotationId))
    for (const [annotationId, entry] of this.markers) {
      if (wanted.has(annotationId)) continue
      disposeAnnotationMarker(entry)
      this.markers.delete(annotationId)
    }
    for (const annotation of this.annotations) {
      const entry = this.markers.get(annotation.annotationId)
      // 编号是标记上唯一会变的东西（文字住在面板里），所以只有编号变化才重画徽标贴图。
      if (entry) refreshAnnotationMarker(entry, annotation.index, annotation.annotationId === this.selectedAnnotation)
      else {
        const built = buildAnnotationMarker(annotation)
        this.annotationRoot.add(built.marker)
        this.markers.set(annotation.annotationId, built)
      }
    }
    this.updateAnnotationMarkers()
  }
  getAnnotations(): ViewerAnnotation[] { return this.annotations.map(annotation => structuredClone(annotation)) }
  /**
   * 附着性自述：每条批注当前的屏幕像素位置 + 锚点 + 世界点。
   *
   * 为什么由 viewer 出这个读数：屏幕位置是"投影 + 实体世界矩阵 + 画布像素比"三者共同的结果，
   * 只有 viewer 手里有这三样；验收门若自己重算一遍，验的就成了门的数学，而不是产品的行为。
   */
  annotationProjections(): Array<{ annotationId: string; index: number; entityId: string; screen: [number, number]; local: [number, number, number]; world: [number, number, number] }> {
    const canvas = this.renderer.domElement
    const carriers = this.carriers
    return this.annotations.flatMap(annotation => {
      const world = resolveAnnotationWorld(annotation, carriers)
      const screen = world ? projectToCapture(world, this.camera, { width: canvas.width, height: canvas.height }) : undefined
      return world && screen ? [{ annotationId: annotation.annotationId, index: annotation.index, entityId: annotation.anchor.entityId, screen, local: annotation.anchor.local, world: world.toArray() as [number, number, number] }] : []
    })
  }
  selectAnnotation(annotationId: string | undefined): void {
    this.selectedAnnotation = annotationId
    for (const [id, entry] of this.markers) applyAnnotationSelection(entry, id === annotationId)
  }
  /**
   * 按回执/快照给的 `FrustumSpec[]` 增量更新相机视锥；键集完整替换，对象与不变的几何复用。
   * `truncationM` 是显示截断（方案 §9-D1）；`visible` 顺带开关（不传维持现状）。
   * 坏数据在 `frustumFromReceipt` 已被挡下，这里只画拿到的（判据 5：条目数＝锥数）。
   */
  setCameraRigs(specs: readonly FrustumSpec[], options: { truncationM?: number; visible?: boolean; unavailableCameraNames?: readonly string[] } = {}): void {
    const frame = this.displayedFrame ?? (!this.snapshot?this.projection?.current():undefined)
    if (this.snapshot) specs = projectSceneCameraRigs(this.snapshot, this.world, frame, specs, options.unavailableCameraNames)
    else if (frame?.cameras && specs.some(spec => spec.measured?.stepIndex !== frame.stepIndex || spec.measured?.generation !== frame.generation || spec.measured?.sceneRevision !== frame.sceneRevision)) return
    const scope=this.snapshot?JSON.stringify([this.snapshot.sceneId,this.snapshot.revision,this.world?.worldId,this.world?.worldGeneration]):undefined
    if(this.cameraRigScopeKey!==undefined&&scope!==this.cameraRigScopeKey){
      const pilot=this.cameraRigPilot,sameScene=(pilot?.sceneId??this.cameraRigLook?.sceneId)===this.snapshot?.sceneId
      // 命名机位属于Scene元数据，不因世界代次或同场景保存而变成传感器；安装编辑仍严格结束旧scope。
      const keepNamed=pilot?.source==='named-view'&&sameScene&&specs.some(spec=>spec.key===pilot.key&&spec.source==='named-view')
      if(!keepNamed&&(pilot||this.cameraRigGizmoKey!==undefined))this.exitCameraMode({restoreView:sameScene,focus:false})
      for(const rig of this.cameraRigs.values()){disposeObject(rig.group);rig.group.removeFromParent()}this.cameraRigs.clear();this.cameraRigSelected=undefined;this.onCameraRigSelect?.(undefined)
    }
    this.cameraRigScopeKey=scope
    const keep=this.cameraRigSelected,incoming=new Set(specs.map(spec=>spec.key))
    for(const [key,rig] of this.cameraRigs)if(!incoming.has(key)){
      if(this.cameraRigPilot?.key===key||this.cameraRigGizmoKey===key)this.exitCameraMode({focus:false})
      disposeObject(rig.group);rig.group.removeFromParent();this.cameraRigs.delete(key)
    }
    if(options.visible!==undefined)this.cameraRigRoot.visible=options.visible
    for(const spec of specs){
      const lens=this.cameraRigGizmoKey===spec.key&&this.cameraRigEditLens?this.cameraRigEditLens:spec.intrinsics
      const geometryKey=JSON.stringify([lens,spec.nearM,spec.farM,options.truncationM??null])
      let rig=this.cameraRigs.get(spec.key)
      if(!rig){
        const geometry=frustumGeometry(spec.intrinsics,{nearM:spec.nearM,farM:spec.farM,...options.truncationM===undefined?{}:{truncationM:options.truncationM}})
        const lines=new THREE.LineSegments(rigLineGeometry(geometry),new THREE.LineBasicMaterial({color:0x6cb6ff,transparent:true,opacity:.9})),pick=rigPickMesh(geometry),group=new THREE.Group()
        pick.userData.cameraRigKey=spec.key;group.name=`camera-rig:${spec.key}`;markAuthoringHelper(group);group.add(lines,pick)
        const origin=new THREE.Mesh(new THREE.SphereGeometry(.012,12,8),new THREE.MeshBasicMaterial({color:0xffbb35,depthTest:false}));origin.name='camera-install-origin'
        const normal=new THREE.ArrowHelper(new THREE.Vector3(0,0,-1),new THREE.Vector3(),.18,0x69e5ae,.04,.025);normal.name='camera-view-normal'
        group.add(origin,normal)
        rig={spec,group,lines,pick,geometryKey};this.cameraRigs.set(spec.key,rig)
      }else if(rig.geometryKey!==geometryKey){
        const geometry=frustumGeometry(lens,{nearM:spec.nearM,farM:spec.farM,...options.truncationM===undefined?{}:{truncationM:options.truncationM}}),pick=rigPickMesh(geometry)
        rig.lines.geometry.dispose();rig.lines.geometry=rigLineGeometry(geometry)
        rig.pick.geometry.dispose();rig.pick.geometry=pick.geometry
        for(const material of Array.isArray(pick.material)?pick.material:[pick.material])material.dispose()
        rig.geometryKey=geometryKey
      }
      rig.spec=spec;rig.group.visible=this.cameraRigRoot.visible
      // native刷新只更新读数；安装草稿的局部transform由同一个编辑对象拥有。
      if(this.cameraRigGizmoKey!==spec.key)this.placeCameraRig(rig,spec)
    }
    if(keep!==undefined){if(this.cameraRigs.has(keep))this.selectCameraRig(keep);else{this.cameraRigSelected=undefined;this.onCameraRigSelect?.(undefined)}}
    if(this.cameraRigPilot){const current=this.cameraRigs.get(this.cameraRigPilot.key);if(current&&current.spec.source===this.cameraRigPilot.source)this.applyCameraRigPilot(current.spec);else this.exitCameraMode({focus:false})}
    if(this.cameraRigLook)this.applyCameraRigLook()
    this.publishObserverState()
  }
  private placeCameraRig(rig:CameraRigRecord,spec:FrustumSpec):void {
    const {group}=rig,mount=spec.parentBodyName?this.bodyNodeOf(spec):{}
    delete group.userData.mountedTo;delete group.userData.mountedEntityId;delete group.userData.mountMissing;delete group.userData.mountMissingReason
    if(mount.node){
      if(spec.parentFromCamera){group.position.set(...spec.parentFromCamera.positionM);group.quaternion.set(...spec.parentFromCamera.quaternionXyzw);group.scale.set(1,1,1)}
      else{const world=new THREE.Matrix4().compose(new THREE.Vector3(...spec.positionM),new THREE.Quaternion(...spec.quaternionXyzw),new THREE.Vector3(1,1,1));mount.node.updateWorldMatrix(true,false);mount.node.matrixWorld.clone().invert().multiply(world).decompose(group.position,group.quaternion,group.scale)}
      group.userData.mountedTo=spec.parentBodyName;group.userData.mountedEntityId=mount.entityId
    }else{group.position.set(...spec.positionM);group.quaternion.set(...spec.quaternionXyzw);group.scale.set(1,1,1);if(spec.parentBodyName){group.userData.mountMissing=spec.parentBodyName;if(mount.reason)group.userData.mountMissingReason=mount.reason}}
    const parent=mount.node??this.cameraRigRoot;if(group.parent!==parent)parent.add(group)
  }
  /**
   * 相机 spec → body 场景图节点（S2 挂载），按"先定归属、再把名字局部化、最后只查那一个实体"三步走。
   *
   * 为什么不能按名字全局搜：`parentBodyName` 是**引擎**里的 body 名——MuJoCo 是带实体前缀的
   * `entityId/body`，Isaac 侧 USD prim 名不能含 `/`、报出来只有局部名；而 `RobotVisual.bodyNode`
   * 只认**该实体自己的局部 body 名**。全局搜等于同时赌"名字里没有实体前缀"与"全局唯一"，
   * 两个机器人都叫 `wrist` 时就会轻则挂不上、重则把 A 的相机挂到 B 的同名 body 上（跨挂）。
   * 定不了归属（回执没给 entityId、相机名也没有 `/` 前缀）时才退回全局搜，且**必须唯一**：
   * 0 个或多个都返回 `reason`，调用处降级成静态显示——绝不取第一个匹配。
   */
  private bodyNodeOf(spec: FrustumSpec): { node?: THREE.Object3D; entityId?: string; reason?: string } {
    const parent = spec.parentBodyName
    if (!parent || parent === "world") return { reason: parent === "world" ? "相机挂在 worldbody 上：没有可跟随的实体 body" : "回执没有 parentBodyName" }
    const declaredOwner = spec.parentEntityId ?? spec.entityId
    if (spec.parentEntityId && !this.objects.has(spec.parentEntityId)) return { entityId: spec.parentEntityId, reason: `挂载实体 ${spec.parentEntityId} 尚未加载` }
    const owner = declaredOwner !== undefined && this.objects.has(declaredOwner) ? declaredOwner : undefined
    if (owner !== undefined) {
      const local = localBodyName(parent, owner), node = this.objects.get(owner)!.robot?.bodyNode(local)
      return node ? { node, entityId: owner } : { entityId: owner, reason: `实体 ${owner} 没有 body「${local}」` }
    }
    const matches: Array<{ entityId: string; node: THREE.Object3D }> = []
    for (const [entityId, loaded] of this.objects) {
      const node = loaded.robot?.bodyNode(localBodyName(parent, entityId))
      if (node) matches.push({ entityId, node })
    }
    if (matches.length === 1) { const only = matches[0]!; return { node: only.node, entityId: only.entityId } }
    return { reason: matches.length > 1 ? `body 名「${parent}」在 ${matches.length} 个实体里同形（${matches.map(match => match.entityId).join("、")}），归属无法确定：拒绝取第一个匹配` : `没有任何已加载实体有 body「${parent}」` }
  }
  setCameraRigsVisible(visible: boolean): void { this.cameraRigRoot.visible = visible; for (const rig of this.cameraRigs.values()) rig.group.visible = visible }
  /** 当前 Capture 输出的真实像素画幅（与 cameraView 的 K 同一套画布像素）；拿不到时返回 0，让 fov-only 站点明确不可用。 */
  private captureRouteFrame(): {width:number;height:number} {
    try{const k=this.cameraView().intrinsics;return {width:k.width,height:k.height}}catch{return {width:0,height:0}}
  }
  /**
   * 路线站点轨迹：只读显示层，位姿/朝向/镜头全部来自持久 Route 引用的真实命名机位 viewState。
   * **独立 root**：不与 cameraRigRoot 共键、不 selectCameraRig、不清机器人已挂载机位；传空数组即隐藏。
   *
   * 每个可画站点是"相机"而不是圆点：四棱锥（near 矩形＋像平面矩形＋顶点→像平面四角＋roll 顶角）、
   * 机身、镜头环、位置点、真实前向中心线与真实 up 线。选中站点用暖色，其余用蓝色；缺失/坏数据
   * 不补 `[0,0,0]`/identity，也不从路径里跨过去连一条假直线。
   */
  setCaptureRouteTrail(stations: readonly CaptureRouteStationInput[], selected = -1): void {
    const root=this.captureRouteRoot
    const clear=()=>{for(const child of [...root.children]){disposeObject(child);root.remove(child)}}
    clear()
    if(stations.length===0){root.visible=false;return}
    // 画幅只取当前 Viewer 真实输出像素：fov-only 站点按这个宽高比投影，不把 640×480 当实际 Capture。
    const frame=this.captureRouteFrame()
    const geometry=captureRouteStationsGeometry(stations.map(station=>({...station,frameWidth:station.frameWidth??frame.width,frameHeight:station.frameHeight??frame.height})),selected)
    for(const segment of captureRoutePathSegments(geometry)){
      const points=segment.map(point=>new THREE.Vector3(point[0],point[1],point[2]))
      const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),new THREE.LineDashedMaterial({color:0x78aaff,transparent:true,opacity:.9,dashSize:.045,gapSize:.028,depthTest:false}))
      line.computeLineDistances();line.name='capture-route-path';line.renderOrder=18;root.add(line)
    }
    for(const station of geometry){
      if(!station.available||!station.position||!station.quaternion||!station.frustum)continue
      const color=station.selected?0xffbb35:0x78aaff
      const group=this.buildCaptureRouteCameraGroup(station,color,`capture-route-stop:${station.index}`)
      group.position.set(station.position[0],station.position[1],station.position[2])
      group.quaternion.set(station.quaternion[0],station.quaternion[1],station.quaternion[2],station.quaternion[3])
      root.add(group)
    }
    root.visible=root.children.length>0
  }
  /**
   * 路线预览/录制中**当前运动相机**的实时 pose/前向 helper。单独 root，站点列表重建时不清掉它；
   * 每帧只更新位置/四元数，镜头不变时不重建几何。传 `undefined` 即隐藏。
   */
  setCaptureRouteCurrentPose(station?: CaptureRouteStationInput): void {
    const root=this.captureRouteCurrentRoot
    if(!station){root.visible=false;return}
    const frame=this.captureRouteFrame()
    const geometry=captureRouteStationGeometry({...station,available:true,frameWidth:station.frameWidth??frame.width,frameHeight:station.frameHeight??frame.height},0,0)
    if(!geometry.available||!geometry.position||!geometry.quaternion||!geometry.frustum||!geometry.intrinsics){root.visible=false;return}
    // 画幅/resize 也会改变派生 K；用几何实际 K 当 lensKey，避免旧画幅的视锥留在当前相机上。
    const lensKey=JSON.stringify(geometry.intrinsics)
    if(!this.captureRouteCurrent||this.captureRouteCurrentLensKey!==lensKey){
      if(this.captureRouteCurrent){disposeObject(this.captureRouteCurrent);this.captureRouteCurrent.removeFromParent()}
      this.captureRouteCurrent=this.buildCaptureRouteCameraGroup(geometry,0x69e5ae,'capture-route-current')
      this.captureRouteCurrentLensKey=lensKey
      root.add(this.captureRouteCurrent)
    }
    this.captureRouteCurrent.position.set(geometry.position[0],geometry.position[1],geometry.position[2])
    this.captureRouteCurrent.quaternion.set(geometry.quaternion[0],geometry.quaternion[1],geometry.quaternion[2],geometry.quaternion[3])
    root.visible=true
  }
  /**
   * 路线预览/录制的**临时 POV**：只写这一份 capture pass 用的视图，不改主相机、不建第二份 Scene 状态。
   *
   * 会话每 tick 把真实采样（position/quaternion/target/up/FOV/K）送到这里，`captureCanvasStream`
   * 和 `renderRouteCapturePreview` 按它渲染；主视口继续保留可交互的路线总览。传 `undefined` 即清理。
   */
  setRouteCaptureView(state?: ViewerViewState): void {
    if (state === undefined) { this.routeCaptureView = undefined; return }
    const current: ViewerCameraCurrent = {
      position: state.position, quaternion: state.quaternion,
      ...state.up === undefined ? {} : {cameraUp: state.up},
      target: state.target, fovYDeg: state.fovDeg, near: state.near, far: state.far,
      ...state.intrinsics === undefined ? {} : {intrinsics: state.intrinsics},
    }
    // 立刻校验并归一化：坏位姿在开始录制/预览时就明确失败，不拖到视频里才变成错帧。
    this.routeCaptureView = normalizeCameraRequest(cameraRequestFromState(state), current)
  }
  /** 显式清理临时 POV（停止/取消/切 Scene/Viewer 更换/卸载都必须走这里）。 */
  clearRouteCaptureView(): void { this.routeCaptureView = undefined }
  /** 当前临时 POV 是否仍在（会话收尾自检/测试读回；不暴露第二份可写状态）。 */
  routeCaptureViewActive(): boolean { return this.routeCaptureView !== undefined }
  /** 临时 POV 相机：每次按真实输出尺寸写一遍并核对，绝不动主相机。 */
  private routeCapturePerspective(size: {width:number;height:number}): THREE.PerspectiveCamera {
    const view = this.routeCaptureView
    if (!view) throw new Error("VIEWER_ROUTE_CAPTURE_VIEW_MISSING: 没有临时路线相机视图")
    let camera = this.routeCaptureCamera
    if (!camera) { camera = new THREE.PerspectiveCamera(view.fovYDeg, size.width / size.height, view.near, view.far); this.routeCaptureCamera = camera }
    const verification = writeViewToCamera(camera, undefined, view, size)
    if (!verification.ok) throw new ViewerCameraError("VIEWER_ROUTE_CAPTURE_VIEW_MISMATCH", `临时路线相机没有按采样复现：${verification.errors.join("；")}`)
    camera.updateMatrixWorld(true)
    return camera
  }
  /**
   * 把当前临时 POV 渲染到一块小预览画布（真实 scene、同一套灯光/材质/tone mapping）。
   *
   * 预览与录制共用同一个 clean capture pass；渲染完立即按主相机重绘屏幕，主视口仍是可交互总览。
   * 画布像素尺寸按主输出宽高比自动定高，避免把 676×890 的 POV 拉成方图。
   */
  renderRouteCapturePreview(target: HTMLCanvasElement, maxHeight = 96): boolean {
    if (this.disposed || !this.routeCaptureView || !target || typeof target.getContext !== "function") return false
    const size = this.canvasPixels()
    if (size.width <= 0 || size.height <= 0) return false
    const height = Math.max(24, Math.min(240, Math.round(maxHeight)))
    const width = Math.max(16, Math.round(height * size.width / size.height))
    if (target.width !== width) target.width = width
    if (target.height !== height) target.height = height
    const context = target.getContext("2d")
    if (!context) return false
    let camera: THREE.PerspectiveCamera
    try { camera = this.routeCapturePerspective(size) } catch { return false }
    try {
      this.withoutCaptureHelpers(() => {
        this.renderer.render(this.scene, camera)
        context.drawImage(this.renderer.domElement, 0, 0, width, height)
      })
      return true
    } catch { return false }
    finally {
      // 临时 POV 渲染或同步 copy 失败时也不能把主画面留在 POV：helpers 由内层 finally 恢复，
      // 这里无论成功/异常都用主相机重绘可交互总览（预览不改 LOD owner，不额外 settle）。
      try { this.renderer.render(this.scene, this.camera) } catch { /* 主画面恢复失败不覆盖原返回值 */ }
    }
  }
  /**
   * 路线总览：把真实站点相机机身/镜头/四棱锥/上方向与场景主体一起框进 3D 视角。
   *
   * 与 `frameAll` 的区别：站点（含远端站点）是取景包围盒的一部分，不会被主体框丢下；场景主体仍用
   * 自动取景的可见主体判据（跳过无限地面/超大墙面），所以不会把地面无限范围撑满。缺失位姿的站点
   * 不参与包围盒，也不补零位姿。它只移动查看相机，不 pilot、不选中、不改物理。
   */
  frameCaptureRoute(stations: readonly CaptureRouteStationInput[]): { ok: boolean; stations: number; available: number; bounds?: { min: [number, number, number]; max: [number, number, number] } } {
    const frame = this.captureRouteFrame()
    const geometry = captureRouteStationsGeometry(stations.map(station => ({...station, frameWidth: station.frameWidth ?? frame.width, frameHeight: station.frameHeight ?? frame.height})), -1)
    const box = new THREE.Box3()
    let available = 0
    for (const station of geometry) {
      if (!station.available || !station.position || !station.quaternion || !station.forward || !station.up || !station.right || !station.frustum) continue
      available++
      const position = new THREE.Vector3(...station.position)
      const forward = new THREE.Vector3(...station.forward)
      const up = new THREE.Vector3(...station.up)
      const right = new THREE.Vector3(...station.right)
      box.expandByPoint(position)
      box.expandByPoint(position.clone().addScaledVector(forward, -0.06)) // 机身/镜头在顶点后方
      box.expandByPoint(position.clone().addScaledVector(up, 0.14))       // 真实 up 线
      const center = position.clone().addScaledVector(forward, station.frustum.imagePlaneM)
      const halfWidth = station.frustum.imageWidth / 2, halfHeight = station.frustum.imageHeight / 2
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) box.expandByPoint(center.clone().addScaledVector(right, sx * halfWidth).addScaledVector(up, sy * halfHeight))
    }
    if (available === 0) return {ok: false, stations: stations.length, available: 0}
    // 场景主体：与 frameAll 同一主体判据 + 同一"超大几何不参与"过滤；跳过 PlaneGeometry 的无限地面。
    // 这里**不**做 frameAll 的"整场都是超大几何"兜底：路线站点已经给出取景范围，把 6 m 墙面/地板重新
    // 并进来只会把总览拉远成小点。站点始终是包围盒的一部分，远端站点不会被主体框丢下。
    const subject = subjectEntityIds(this.snapshot?.entities)
    for (const [entityId, loaded] of this.objects) {
      if (subject && !subject.has(entityId)) continue
      const bounds = objectWorldBounds(loaded.group, this.splatViewBounds, true, false)
      if (!bounds.isEmpty()) box.union(bounds)
    }
    if (this.preview) box.union(objectWorldBounds(this.preview, this.splatBounds, true, false))
    if (box.isEmpty()) return {ok: false, stations: stations.length, available: 0}
    this.frameBounds(box)
    return {ok: true, stations: stations.length, available, bounds: {min: box.min.toArray() as [number,number,number], max: box.max.toArray() as [number,number,number]}}
  }
  /** 一台"看得见的相机"：四棱锥/像平面 + 机身/镜头 + 位置点 + 真实前向/up。局部系，调用方写位姿。 */
  private buildCaptureRouteCameraGroup(station: CaptureRouteStationGeometry, color: number, name: string): THREE.Group {
    const group=new THREE.Group(),frustum=station.frustum!
    group.name=name
    const lineMaterial=new THREE.LineBasicMaterial({color,transparent:true,opacity:.98,depthTest:false})
    const lineGeometry=new THREE.BufferGeometry()
    lineGeometry.setAttribute('position',new THREE.Float32BufferAttribute(frustum.lineVertices,3))
    const frustumLines=new THREE.LineSegments(lineGeometry,lineMaterial)
    frustumLines.name=`${name}:frustum`;frustumLines.renderOrder=20;group.add(frustumLines)
    // 像平面：半透明矩形，读得出"画面朝哪、有多大"；是显示面，不参与任何采集。
    const planeGeometry=new THREE.PlaneGeometry(frustum.imageWidth,frustum.imageHeight)
    const plane=new THREE.Mesh(planeGeometry,new THREE.MeshBasicMaterial({color,transparent:true,opacity:.13,side:THREE.DoubleSide,depthWrite:false,depthTest:false}))
    plane.position.set(0,0,-frustum.imagePlaneM);plane.name=`${name}:image-plane`;plane.renderOrder=19;group.add(plane)
    // 机身：顶点后方的短盒 + 镜头环 + 顶点球，让"相机"在 3D 里一眼可读。
    const bodyGeometry=new THREE.BoxGeometry(.062,.046,.036)
    const body=new THREE.Mesh(bodyGeometry,new THREE.MeshBasicMaterial({color:0x171b21,transparent:true,opacity:.96,depthTest:false}))
    body.position.set(0,0,.024);body.name=`${name}:body`;body.renderOrder=20;group.add(body)
    const edges=new THREE.LineSegments(new THREE.EdgesGeometry(bodyGeometry),lineMaterial)
    edges.position.copy(body.position);edges.name=`${name}:body-edges`;edges.renderOrder=21;group.add(edges)
    const lensGeometry=new THREE.CylinderGeometry(.016,.019,.026,14)
    const lens=new THREE.Mesh(lensGeometry,new THREE.MeshBasicMaterial({color:0x2c3541,transparent:true,opacity:.98,depthTest:false}))
    lens.rotation.x=Math.PI/2;lens.position.set(0,0,.004);lens.name=`${name}:lens`;lens.renderOrder=20;group.add(lens)
    const apex=new THREE.Mesh(new THREE.SphereGeometry(.009,12,8),new THREE.MeshBasicMaterial({color,depthTest:false}))
    apex.name=`${name}:origin`;apex.renderOrder=22;group.add(apex)
    // 真实前向中心线与真实 up 线：四棱锥已给出方向，这两条让 roll/朝向在缩略视角里也清楚。
    const forward=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0),new THREE.Vector3(0,0,-frustum.imagePlaneM)]),lineMaterial)
    forward.name=`${name}:forward`;forward.renderOrder=20;group.add(forward)
    const up=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0),new THREE.Vector3(0,.14,0)]),new THREE.LineBasicMaterial({color:0xffd166,transparent:true,opacity:.95,depthTest:false}))
    up.name=`${name}:up`;up.renderOrder=20;group.add(up)
    return group
  }
  /**
   * capture pass 的显式范围：截图、按相机出图、连续视频都只在这段范围内出图。
   *
   * 这里隐藏的是**显示辅助**，不是场景内容：TransformControls（那根巨大的绿色手柄）、网格/坐标轴、
   * 批注标记、相机视锥（含挂在 robot body 下的那些，所以必须逐个 rig.group 处理，不能只藏 cameraRigRoot）、
   * 路线站点/当前相机 helper、碰撞/底座标签、放置/安装点标记与装配 ghost。选中部件的高亮材质也临时换回。
   *
   * 所有 visible 原值（以及部件高亮）在 finally 里逐项恢复；相机、物理时钟、Scene 都不改。
   * Note 专用图（`captureAnnotated`）仍走同一条干净底图，随后由 `drawAnnotationPins` 把编号烧进像素。
   */
  private withoutCaptureHelpers<T>(run:()=>T):T {
    const hidden: Array<{object: THREE.Object3D; visible: boolean}> = []
    const hide = (object: THREE.Object3D | undefined): void => {
      if (!object) return
      hidden.push({object, visible: object.visible})
      object.visible = false
    }
    // 视锥可能被 `placeCameraRig` 挂到 robot body 节点下：只藏 cameraRigRoot 会让它们继续进视频。
    for (const rig of this.cameraRigs?.values() ?? []) hide(rig.group)
    hide(this.cameraRigRoot)
    hide(this.captureRouteRoot)
    hide(this.captureRouteCurrentRoot)
    hide(this.transformControls?.getHelper?.())
    hide(this.grid)
    hide(this.axes)
    hide(this.annotationRoot)
    hide(this.collisionTopologyLayer?.root)
    hide(this.robotAnchorLayer?.root)
    hide(this.placeMarker)
    hide(this.mountPickMarker)
    hide(this.assemblyGhost?.root)
    hide(this.parkingGhost?.root)
    // 放置预览 ghost 是未提交模型：预览时可见，但 Capture/截图/观察输出不能把它烧进像素；渲染后恢复。
    hide(this.placementGhost?.root)
    // 选中部件的暖色高亮属于选择辅助：临时换回原材质（共享材质不写）；finally 再按同一选择重建。
    const highlight = this.partHighlight
    const selectedPart = this.selectedPart
    if (highlight) this.clearPartHighlight()
    try { return run() }
    finally {
      for (const {object, visible} of hidden) object.visible = visible
      if (highlight && selectedPart && !this.partHighlight && this.selectedPart?.entityId === selectedPart.entityId && this.selectedPart.partId === selectedPart.partId) this.applyPartHighlight(selectedPart.entityId, selectedPart.partId)
    }
  }
  /** 选中一台相机视锥（点选/面板同路）：高亮 + 回调读数卡。`undefined`＝取消选中。 */
  selectCameraRig(key: string | undefined): void {
    this.cameraRigSelected = key !== undefined && this.cameraRigs.has(key) ? key : undefined
    for (const [id, rig] of this.cameraRigs) (rig.lines.material as THREE.LineBasicMaterial).color.set(id === this.cameraRigSelected ? 0xffbb35 : 0x6cb6ff)
    this.onCameraRigSelect?.(this.cameraRigSelected ? this.cameraRigs.get(this.cameraRigSelected)!.spec : undefined)
  }
  /** 现有视锥的键（诊断/验收：与 `camera_list` 条目数对账，判据 5）。 */
  cameraRigKeys(): string[] { return [...this.cameraRigs.keys()] }
  private worldUp(): THREE.Vector3 { return new THREE.Vector3(0,0,1) }
  private freeNavigation(): "orbit"|"first-person" { return this.navigationPreference??this.cameraRigPilot?.returnView.navigation??(this.firstPerson?.active?"first-person":"orbit") }
  /** 模式只从Viewer拥有的互斥pilot/edit事实投影，UI不另存模式真相。 */
  observerState(): ViewerObserverState {
    const mode=this.cameraRigPilot?"pilot":this.cameraRigGizmoKey!==undefined?"camera-edit":"free",cameraId=this.cameraRigPilot?.key??this.cameraRigGizmoKey
    const baseline=this.cameraRigEditBaseline,group=baseline?this.cameraRigs.get(baseline.key)?.group:undefined
    const dirty=Boolean(baseline&&group&&(group.position.toArray().some((v,i)=>Math.abs(v-baseline.position[i]!)>1e-9)||1-Math.abs(group.quaternion.dot(new THREE.Quaternion(...baseline.quaternion as [number,number,number,number])))>1e-9||baseline.intrinsics&&JSON.stringify(this.cameraRigEditLens)!==JSON.stringify(baseline.intrinsics)))
    const next:ViewerObserverState={mode,...cameraId?{cameraId}:{},navigation:this.freeNavigation(),dirty,saving:Boolean(this.cameraRigSave),...this.cameraRigLook?{positionLocked:true}:{},...this.cameraRigEditError?{error:this.cameraRigEditError}:{},scope:{...this.snapshot?{sceneId:this.snapshot.sceneId,sceneRevision:this.snapshot.revision}:{},...this.world?{worldId:this.world.worldId,generation:this.world.worldGeneration}:{}}}
    if(!this.observerSnapshot||JSON.stringify(next)!==JSON.stringify(this.observerSnapshot))this.observerSnapshot=Object.freeze({...next,scope:Object.freeze(next.scope)})
    return this.observerSnapshot
  }
  subscribeObserverState(listener:()=>void):()=>void { (this.observerListeners??=new Set()).add(listener);return()=>this.observerListeners?.delete(listener) }
  private initializeNavigationBar():void {
    this.navigationBar=document.createElement("div")
    this.navigationBar.className="lya-viewer-navigation"
    this.navigationBar.setAttribute("role","group")
    Object.assign(this.navigationBar.style,{position:"absolute",top:"12px",right:"12px",zIndex:"6",display:"flex",gap:"4px",padding:"4px",borderRadius:"8px",background:"var(--dsw-alias-bg-l1,#222)",color:"var(--dsw-alias-label-primary,#eee)"})
    for(const mode of ["orbit","first-person"] as const){
      const button=document.createElement("button");button.type="button"
      Object.assign(button.style,{padding:"4px 10px",border:"1px solid currentColor",borderRadius:"5px",background:"transparent",color:"inherit",cursor:"pointer"})
      button.onclick=()=>this.setNavigationMode(mode)
      this.navigationButtons.push({mode,button});this.navigationBar.appendChild(button)
    }
    this.observerLabel=document.createElement("span");this.observerLabel.setAttribute("role","status");this.navigationBar.appendChild(this.observerLabel)
    this.observerExitButton=document.createElement("button");this.observerExitButton.type="button";this.observerExitButton.onclick=()=>this.exitCameraMode();this.navigationBar.appendChild(this.observerExitButton)
    this.options.container.appendChild(this.navigationBar)
  }
  private refreshNavigationCopy(current=this.observerSnapshot):void {
    const tr=this.options?.translate??((zh:string,_en:string)=>zh)
    const copy=(element:HTMLElement,text:string,aria=text,title=text)=>{
      if(element.textContent!==text)element.textContent=text
      if(element.getAttribute('aria-label')!==aria)element.setAttribute('aria-label',aria)
      if(element.title!==title)element.title=title
    }
    if(this.navigationBar){const name=tr('查看器导航','Viewer navigation');if(this.navigationBar.getAttribute('aria-label')!==name)this.navigationBar.setAttribute('aria-label',name)}
    for(const {mode,button} of this.navigationButtons??[]){
      if(mode==='orbit')copy(button,tr('环绕','Orbit'),tr('查看器环绕','Orbit view'),tr('中键环绕所选资产 · Shift+中键平移 · 滚轮缩放','Middle-drag to orbit selection · Shift+middle-drag to pan · wheel to zoom'))
      else copy(button,tr('漫游','Roam'),tr('查看器漫游','Roam view'),tr('中键转头 · Shift+中键平移 · 滚轮前后移动 · WASD/QE · Shift加速','Middle-drag to look · Shift+middle-drag to pan · wheel to dolly · WASD/QE · Shift to accelerate'))
    }
    if(this.observerExitButton)copy(this.observerExitButton,tr('退出相机','Exit camera'),tr('退出相机','Exit camera'),tr('返回主视图','Return to the main view'))
    // 默认自由模式不再常驻“Free movement · WASD/QE”等说明：模式由 Orbit/Roam 按钮的选中态表达，
    // 完整键位在按钮 title 里。只有 pilot/相机编辑这类**有状态**身份保留短标识（Pilot、退出见旁边按钮）。
    if(current&&this.observerLabel){const caption=current.mode==="pilot"?`${tr('查看相机（锁定）','Viewing camera (locked)')} · ${current.cameraId}`:current.mode==="camera-edit"?`${current.positionLocked?tr('原点锁定 · 中键拖动调朝向','Origin locked · middle-drag to aim'):tr('编辑相机安装','Editing camera installation')}${current.saving?tr(' · 保存中',' · saving'):current.error?` · ${current.error}`:current.dirty?tr(' · 未保存',' · unsaved'):''}`:"";if(this.observerLabel.textContent!==caption)this.observerLabel.textContent=caption}
    if(current&&this.observerExitButton&&this.observerExitButton.hidden!==(current.mode==="free"))this.observerExitButton.hidden=current.mode==="free"
  }
  private publishObserverState():void {
    const previous=this.observerSnapshot,current=this.observerState()
    this.refreshNavigationCopy(current)
    if(previous!==current)for(const listener of this.observerListeners??[])listener()
  }
  private syncObserverControls():void {
    const mode=this.freeNavigation(),active=!this.cameraRigPilot&&!this.editing&&(Boolean(this.cameraRigLook)||mode==="first-person")
    if(this.firstPerson){this.firstPerson.rotationOnly=Boolean(this.cameraRigLook);this.firstPerson.onRotate=this.cameraRigLook?()=>this.captureCameraRigLook():undefined}
    if(this.firstPerson&&this.firstPerson.active!==active)this.firstPerson.setActive(active)
    if(this.controls)this.controls.enabled=!this.cameraRigPilot&&!this.cameraRigLook&&!this.editing&&mode==="orbit"
    this.publishObserverState()
  }
  private observerKeyDown=(event:KeyboardEvent)=>this.handleObserverKey(event)
  private handleObserverKey(event:KeyboardEvent):void {
    if(event.code!=="Escape"||event.ctrlKey||event.altKey||event.metaKey||(!this.cameraRigPilot&&this.cameraRigGizmoKey===undefined))return
    event.preventDefault();event.stopImmediatePropagation();this.exitCameraMode()
  }
  /** 所有出口都清同一Viewer模式；preset/bookmark随后写自己的新机位。 */
  exitCameraMode(options:{restoreView?:boolean;focus?:boolean}={}):boolean {
    const pilot=this.cameraRigPilot,editing=this.cameraRigGizmoKey!==undefined
    this.cameraRigPilot=undefined
    if(editing)this.endCameraRigEditing(true,options.restoreView!==false)
    this.firstPerson?.clearInput?.()
    if(pilot){this.setCaptureGate(undefined);if(options.restoreView!==false)this.setViewState(pilot.returnView,{focus:false});this.navigationPreference=pilot.returnView.navigation??this.freeNavigation()}
    this.syncObserverControls()
    if(options.focus!==false)this.renderer?.domElement?.focus?.({preventScroll:true})
    return Boolean(pilot||editing)
  }
  sampleCameraAuthoring(): ViewerCameraAuthoringSample {
    if(!this.snapshot)throw new ViewerCameraError("VIEWER_SCENE_REQUIRED","当前Viewer没有可采样的场景")
    const frame=currentRobotFrame(this.snapshot,this.world,this.displayedFrame),bodies:NonNullable<ViewerCameraAuthoringSample['bodies']>=[]
    if(frame)for(const entity of frame.entities)for(const [bodyName,value] of Object.entries(entity.sensors?.bodyWorldPoses??{})){const pose=rigidPoseOf(value);if(pose)bodies.push({entityId:entity.entityId,bodyName,worldFromBody:pose,frameId:frame.frameId,stepIndex:frame.stepIndex})}
    return {sceneId:this.snapshot.sceneId,sceneRevision:this.snapshot.revision,...this.world?.sceneId===this.snapshot.sceneId?{worldId:this.world.worldId,generation:this.world.worldGeneration}:{},...frame?{frameId:frame.frameId,stepIndex:frame.stepIndex,bodies}:{},view:this.getViewState(),camera:this.cameraView()}
  }
  focusRobotAnchor(entityId:string,kind:'tcp'|'base'):void {
    const frame=currentRobotFrame(this.snapshot,this.world,this.displayedFrame),observation=frame?.entities.find(row=>row.entityId===entityId)
    const pose=rigidPoseOf(kind==='tcp'?observation?.sensors?.tcp:(observation?.sensors?.robotBase as {worldFromBody?:unknown}|undefined)?.worldFromBody)
    if(!pose)throw new ViewerCameraError("VIEWER_ROBOT_ANCHOR_UNAVAILABLE",`机器人 ${entityId} 的 ${kind} 缺少当前原生读回`)
    this.exitCameraMode({restoreView:false});const radius=kind==='tcp'?.08:.18,point=new THREE.Vector3(...pose.positionM)
    this.frameBounds(new THREE.Box3(point.clone().addScalar(-radius),point.clone().addScalar(radius)))
  }
  /** 进入选中相机；跟随只消费同来源的当前Scene声明或原生读回，不以视觉FK冒充。 */
  pilotCameraRig(key: string, lens = true): void {
    const rig = this.cameraRigs.get(key)
    if (!rig) throw new ViewerCameraError("VIEWER_CAMERA_RIG_UNAVAILABLE", `相机 ${key} 没有当前原生位姿与内参`)
    if(this.cameraRigGizmoKey!==undefined)this.finishCameraRigEditing({discard:true})
    const state = this.cameraRigPilot?.returnView ?? this.getViewState()
    const distance = Math.hypot(...state.target.map((v, i) => v - state.position[i]!)) || 1
    this.cameraRigPilot = { key, source:rig.spec.source, sceneId:this.snapshot?.sceneId, lens, returnView: state, distance }
    this.transformControls?.detach()
    this.navigationPreference=state.navigation??this.freeNavigation();this.firstPerson?.clearInput?.();this.syncObserverControls()
    this.applyCameraRigPilot(rig.spec)
    this.renderer?.domElement?.focus?.({preventScroll:true})
  }
  private applyCameraRigPilot(spec: FrustumSpec): void {
    const pilot = this.cameraRigPilot
    if (!pilot) return
    const named=spec.source==='named-view'&&pilot.lens?namedCamerasOfScene(this.snapshot?.entities):undefined
    const saved=named?.cameras.find(row=>`${named.carrier}/${row.name}`===spec.key)
    // 保存视角的target/clips同样是文档事实；视锥的显示默认裁剪面不能成为原生标定。
    const request=saved?cameraRequestFromState(saved.state):{...cameraRequestFromRig(spec,pilot.distance,{lens:pilot.lens}),...pilot.lens&&spec.nearFarSource==='declared'?{near:spec.nearM,far:spec.farM}:{}}
    this.applyCameraView(request,{keepObserverMode:true})
    this.setCaptureGate(pilot.lens ? { intrinsics: spec.intrinsics } : undefined)
  }
  pilotedCameraRig(): string | undefined { return this.cameraRigPilot?.key }
  returnFromCameraRig(): void {
    this.exitCameraMode()
  }
  /**
   * 取景框（用户反馈④）：Pilot"透过这台相机看"后标注相机**实际可拍摄范围**——线框由
   * `captureGateRect(spec.intrinsics, 画布)` 按与投影**同一份映射**算出（图像边缘→画布边缘），
   * 四角角标＋说明（真实垂直 FOV）都读同一份 K。`undefined`＝收起。
   * 只是显示层：不改投影、不改渲染、不写任何相机状态；相机一旦不是这一台（导航/预设/换相机）就自动收起。
   */
  setCaptureGate(gate: { intrinsics: ViewerCameraIntrinsics } | undefined): void {
    this.captureGateSpec = gate
    this.captureGateView = gate ? this.captureViewSnapshot() : undefined
    this.updateCaptureGate()
  }
  /** 当前相机状态的指纹（取景框只在"还是同一台相机、同一份投影"时才算数）。 */
  private captureViewSnapshot(): { position: THREE.Vector3; quaternion: THREE.Quaternion; projection: number[] } {
    return { position: this.camera.position.clone(), quaternion: this.camera.quaternion.clone(), projection: this.camera.projectionMatrix.toArray() }
  }
  /**
   * 取景框是否已经对不上这台相机：位置/姿态/投影矩阵任一变了（OrbitControls 导航、预设、全景、拟合重置、
   * 换成另一台相机）就不再代表"透过这台相机看"，清掉而不是继续显示一个旧口径的框。
   * 投影矩阵本身是**画布无关**的（`scaleIntrinsics` 的各向异性缩放恰好让矩阵元素不变），所以 resize/DPR
   * 不会误清——取景框随新画布重新画（`resizeCanvas`→`updateCaptureGate`）。
   */
  private captureGateStale(): boolean {
    const snapshot = this.captureGateView
    if (!snapshot) return false
    const projection = this.camera.projectionMatrix.toArray()
    return this.camera.position.distanceTo(snapshot.position) > 1e-6
      || 2 * Math.acos(Math.min(1, Math.abs(this.camera.quaternion.dot(snapshot.quaternion)))) > 1e-6
      || projection.some((value, index) => !(Math.abs(value - snapshot.projection[index]!) <= 1e-6 * Math.max(1, Math.abs(value))))
  }
  private updateCaptureGate(): void {
    const svg = this.captureGateSvg
    if (!svg) return                       // 无构造器夹具/极简环境下静默跳过（纯显示层，不影响其它）
    while (svg.firstChild) svg.removeChild(svg.firstChild)
    const spec = this.captureGateSpec
    if (!spec) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    // 画布还没有尺寸（容器隐藏/未布局）时不画：这里**没有**可映射的画布，编一个框出来才是假读数。
    // 框本身留着（`captureGateSpec` 不动），布局一到 `resizeCanvas` 就会按新画布画出来。
    if (!(rect.width > 0 && rect.height > 0)) return
    const gate = captureGateRect(spec.intrinsics, rect.width, rect.height)
    svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`)
    const ns = "http://www.w3.org/2000/svg"
    const add = (tag: string, attrs: Record<string, string>): SVGElement => {
      const el = document.createElementNS(ns, tag)
      for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value)
      svg.appendChild(el)
      return el
    }
    // 线框＋四角角标（角标加粗一档，一眼读出边界）＋说明。
    add("rect", { x: String(gate.left), y: String(gate.top), width: String(gate.width), height: String(gate.height), fill: "none", stroke: "#ffffff", "stroke-width": "1.5" })
    const corner = Math.min(gate.width, gate.height) * 0.06
    for (const [x, y, dx, dy] of [[gate.left, gate.top, 1, 1], [gate.left + gate.width, gate.top, -1, 1], [gate.left, gate.top + gate.height, 1, -1], [gate.left + gate.width, gate.top + gate.height, -1, -1]] as const) {
      add("path", { d: `M ${x + dx * corner} ${y} L ${x} ${y} L ${x} ${y + dy * corner}`, fill: "none", stroke: "#ffbb35", "stroke-width": "3" })
    }
    const label = add("text", { x: String(gate.left + 6), y: String(gate.top + 16), fill: "#ffbb35", "font-size": "11", "font-family": "monospace" })
    // 说明与线框同一份 K、同一块画布：宽高比不同就如实说像素被各向异性拉伸（不是"线外拍不进"）。
    label.textContent = captureGateLabel(spec.intrinsics, { width: rect.width, height: rect.height })
  }
  /**
   * S3（判据 4）：把 gizmo 挂到视锥上拖安装位姿（移动/旋转用现有 `setGizmoMode`）。拖拽结束回调
   * `onCameraRigEdit`（世界＋局部两套位姿）；写回走消费者的Scene CAS/明确试拍接口。
   * 本类只拥有显示草稿与ACK状态，实体编辑与它复用同一 TransformControls，归属按对象区分。
   */
  attachCameraRigGizmo(key: string): void {
    const rig = this.cameraRigs.get(key)
    if (!rig) return
    this.exitCameraMode()
    this.cameraRigGizmoKey = key
    this.cameraRigEditError=undefined
    this.cameraRigEditLens=structuredClone(rig.spec.intrinsics)
    this.cameraRigEditBaseline={key,position:rig.group.position.toArray(),quaternion:rig.group.quaternion.toArray(),intrinsics:structuredClone(rig.spec.intrinsics)}
    this.transformControls.attach(rig.group)
    this.syncObserverControls()
  }
  /** 在同一安装编辑 session 进入相机原点。body 子节点与局部偏移继续跟 FK，不冻结世界点。 */
  aimCameraRig(key:string):void {
    const rig=this.cameraRigs.get(key)
    if(!rig)throw new ViewerCameraError('VIEWER_CAMERA_RIG_UNAVAILABLE',`Camera ${key} is unavailable`)
    if(rig.spec.source==='named-view')throw new ViewerCameraError('VIEWER_CAMERA_INSTALLATION_REQUIRED','Save this view as a Scene camera before editing its installation')
    if(rig.spec.parentBodyName&&rig.group.userData.mountMissing)throw new ViewerCameraError('VIEWER_CAMERA_MOUNT_REQUIRED','The actual mount body is unavailable')
    if(rig.spec.parentBodyName&&rig.spec.parentBodyName!=='world'&&this.snapshot){
      const frame=currentRobotFrame(this.snapshot,this.world,this.displayedFrame),owner=rig.spec.parentEntityId??rig.spec.entityId
      const poses=frame?.entities.find(e=>e.entityId===owner)?.sensors?.bodyWorldPoses as Record<string,unknown>|undefined
      const pose=owner?rigidPoseOf(poses?.[localBodyName(rig.spec.parentBodyName,owner)]):undefined
      if(!frame||!pose||rig.spec.measured?.frameId!==frame.frameId)throw new ViewerCameraError('VIEWER_CAMERA_BODY_FRAME_REQUIRED','Wait for the current same-frame camera and native body observation before aiming')
    }
    const returnView=this.cameraRigPilot?.returnView??this.cameraRigLook?.returnView??this.getViewState()
    this.attachCameraRigGizmo(key)
    this.cameraRigLook={returnView,sceneId:this.snapshot?.sceneId,distance:Math.max(.1,Math.hypot(...returnView.target.map((v,i)=>v-returnView.position[i]!))),controlsEnabled:this.transformControls.enabled}
    this.transformControls.enabled=false;if(this.transformControls.getHelper)this.transformControls.getHelper().visible=false
    this.firstPerson?.clearInput?.();this.syncObserverControls();this.applyCameraRigLook();this.renderer?.domElement?.focus?.({preventScroll:true})
  }
  private applyCameraRigLook():void {
    const key=this.cameraRigGizmoKey,look=this.cameraRigLook,rig=key===undefined?undefined:this.cameraRigs.get(key)
    if(!look||!rig)return
    rig.group.updateWorldMatrix(true,false)
    const position=new THREE.Vector3(),q=new THREE.Quaternion();rig.group.getWorldPosition(position);rig.group.getWorldQuaternion(q)
    const spec={...rig.spec,positionM:position.toArray() as ViewerVec3,quaternionXyzw:q.toArray() as [number,number,number,number],intrinsics:this.cameraRigEditLens??rig.spec.intrinsics}
    this.applyCameraView({...cameraRequestFromRig(spec,look.distance,{lens:true}),near:rig.spec.nearM,far:rig.spec.farM},{keepObserverMode:true});this.setCaptureGate({intrinsics:spec.intrinsics})
  }
  private captureCameraRigLook():void {
    const key=this.cameraRigGizmoKey,rig=key===undefined?undefined:this.cameraRigs.get(key)
    if(!this.cameraRigLook||!rig||this.cameraRigSave)return
    const parent=rig.group.parent,parentQ=new THREE.Quaternion();parent?.updateWorldMatrix(true,false);parent?.getWorldQuaternion(parentQ)
    // 移动只由 FK 决定；鼠标改变相机世界朝向后，立即反解到这台 rig 的 body-local 旋转。
    rig.group.quaternion.copy(parentQ.invert().multiply(this.camera.quaternion)).normalize()
    this.publishObserverState()
  }
  setCameraRigAimFov(fovYDeg:number):void {
    if(!this.cameraRigLook||!this.cameraRigEditLens||this.cameraRigSave)throw new ViewerCameraError('VIEWER_CAMERA_AIM_REQUIRED','Enter the locked camera origin before changing its draft FOV')
    if(!Number.isFinite(fovYDeg)||fovYDeg<=0||fovYDeg>=180)throw new ViewerCameraError('VIEWER_CAMERA_FOV_INVALID','Vertical FOV must be between 0 and 180 degrees')
    const k=this.cameraRigEditLens,fy=k.height/(2*Math.tan(fovYDeg*Math.PI/360))
    this.cameraRigEditLens={...k,fx:k.fx*fy/k.fy,fy}
    this.setCameraRigs([...this.cameraRigs.values()].map(r=>r.spec));this.publishObserverState()
  }
  detachCameraRigGizmo(): void {
    this.finishCameraRigEditing()
  }
  finishCameraRigEditing(options:{discard?:boolean}={}):void|Promise<void> {
    if(options.discard===false){
      const key=this.cameraRigGizmoKey,group=key===undefined?undefined:this.cameraRigs.get(key)?.group,scope=this.cameraRigScopeKey
      return this.commitCameraRigEditing().then(()=>{if(this.cameraRigGizmoKey===key&&this.cameraRigs.get(key!)?.group===group&&this.cameraRigScopeKey===scope)this.endCameraRigEditing(false)})
    }
    this.endCameraRigEditing(true)
  }
  /** 重试/等待同一草稿的消费者ACK；Viewer不执行Scene写入。 */
  commitCameraRigEditing():Promise<void> {
    if(this.cameraRigSave?.promise)return this.cameraRigSave.promise
    if(this.cameraRigGizmoKey===undefined||!this.observerState().dirty)return Promise.resolve()
    if(!this.onCameraRigEdit)return Promise.reject(new ViewerCameraError('VIEWER_CAMERA_EDIT_SAVE_UNAVAILABLE','当前没有相机安装保存接口'))
    const key=this.cameraRigGizmoKey,group=this.cameraRigs.get(key)?.group,scope=this.cameraRigScopeKey
    return this.emitCameraRigEdit().then(()=>{
      if(this.cameraRigGizmoKey===key&&this.cameraRigs.get(key)?.group===group&&this.cameraRigScopeKey===scope&&this.observerState().dirty)throw new ViewerCameraError('VIEWER_CAMERA_EDIT_ACK_REQUIRED','相机安装保存尚未收到确认')
    })
  }
  /** 丢弃才重投最新权威安装；保存ACK后的可见安装保留到真实Scene/native投影接替，不用旧spec回滚它。 */
  private endCameraRigEditing(discard:boolean,restoreView=true):void {
    const key=this.cameraRigGizmoKey,rig=key!==undefined?this.cameraRigs.get(key):undefined
    if(key===undefined)return
    this.cancellingCameraEdit=true
    const look=this.cameraRigLook
    try{this.cameraRigGizmoKey=undefined;this.cameraRigEditBaseline=undefined;this.cameraRigEditLens=undefined;this.cameraRigEditError=undefined;this.cameraRigLook=undefined;if(this.cameraRigSave)this.transformControls.enabled=this.cameraRigSave.enabled;if(look){this.transformControls.enabled=look.controlsEnabled;if(this.transformControls.getHelper)this.transformControls.getHelper().visible=true}this.cameraRigSave=undefined;this.editing=false;this.transformControls.dragging=false;this.transformControls.detach();if(discard&&rig)this.placeCameraRig(rig,rig.spec);if(look){this.setCaptureGate(undefined);if(restoreView)this.setViewState(look.returnView,{focus:false});this.navigationPreference=look.returnView.navigation??this.freeNavigation()}if(rig&&discard)this.setCameraRigs([...this.cameraRigs.values()].map(r=>r.spec))}
    finally{this.cancellingCameraEdit=false;this.firstPerson?.clearInput?.();this.syncObserverControls()}
  }
  private emitCameraRigEdit(): Promise<void> {
    const key = this.cameraRigGizmoKey
    const rig = key !== undefined ? this.cameraRigs.get(key) : undefined
    // 只认"确实挂在这一台上"的拖拽：实体 gizmo 复用同一 TransformControls，归属不能混。
    if(this.cameraRigSave?.promise)return this.cameraRigSave.promise
    if (!rig || this.transformControls.object !== rig.group) return Promise.resolve()
    rig.group.updateWorldMatrix(true, false)
    const position = new THREE.Vector3(), quaternion = new THREE.Quaternion()
    rig.group.getWorldPosition(position)
    rig.group.getWorldQuaternion(quaternion)
    const frame=currentRobotFrame(this.snapshot,this.world,this.displayedFrame)
    const edit:ViewerCameraEdit={
      worldPose: { positionM: position.toArray() as ViewerVec3, quaternionXyzw: quaternion.toArray() as [number, number, number, number] },
      localPose: { positionM: rig.group.position.toArray() as ViewerVec3, quaternionXyzw: rig.group.quaternion.toArray() as [number, number, number, number] },
      ...this.snapshot?{sceneId:this.snapshot.sceneId,sceneRevision:this.snapshot.revision,revision:this.snapshot.revision}:{},...this.world?{worldId:this.world.worldId,generation:this.world.worldGeneration}:{},...frame?{frameId:frame.frameId,stepIndex:frame.stepIndex}:{},
      parentEntityId:rig.spec.parentEntityId??rig.spec.entityId,parentBodyName:rig.spec.parentBodyName,
      intrinsics:this.cameraRigEditLens??rig.spec.intrinsics,width:rig.spec.intrinsics.width,height:rig.spec.intrinsics.height,near:rig.spec.nearM,far:rig.spec.farM,
    }
    const save:NonNullable<SceneViewer['cameraRigSave']>={key:rig.spec.key,group:rig.group,scope:this.cameraRigScopeKey,enabled:this.transformControls.enabled}
    this.cameraRigSave=save;this.cameraRigEditError=undefined;this.editing=true;this.transformControls.enabled=false;this.syncObserverControls()
    save.promise=(async()=>{try{
      const acknowledgment=this.onCameraRigEdit?.(rig.spec.key,edit)
      if(acknowledgment&&typeof acknowledgment.then==='function'){
        await acknowledgment
        if(this.cameraRigSave===save&&this.cameraRigGizmoKey===save.key&&this.cameraRigs.get(save.key)?.group===save.group&&this.cameraRigScopeKey===save.scope)this.cameraRigEditBaseline={key:save.key,position:save.group.position.toArray(),quaternion:save.group.quaternion.toArray(),intrinsics:structuredClone(edit.intrinsics)}
      }
    }catch(error){if(this.cameraRigSave===save)this.cameraRigEditError=error instanceof Error?error.message:String(error);throw error}
    finally{if(this.cameraRigSave===save){this.cameraRigSave=undefined;this.editing=false;this.transformControls.enabled=save.enabled;this.syncObserverControls()}}})()
    return save.promise
  }
  /** 单台回执仍走同一增量投影，保留选择、对象与编辑草稿。 */
  updateCameraRig(spec: FrustumSpec): void {
    const specs = [...this.cameraRigs.values()].map(rig => rig.spec).map(existing => existing.key === spec.key ? spec : existing)
    this.setCameraRigs(specs)
    this.selectCameraRig(spec.key)
  }
  /**
   * 拾取探针：给定视口 client 坐标，回答"这里命中了什么"。
   *
   * 为什么要有它：批注、选择、放置三条路径共用同一个命中判据，一旦视口里点的位置没命中，
   * 光看"批注没出现"分不清是"没几何 / 没加载完 / 被隐藏 / 真的点空了"。这里按同一判据回一次话，
   * 让排查与验收拿到的是原因而不是现象。
   */
  probePick(clientX: number, clientY: number): { entityId?: string; point?: [number, number, number]; meshes: number; rawHits: number; groups: number; hiddenChains?: string[]; loadingErrors: string[] } {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const pointer = new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1)
    const ray = new THREE.Raycaster(); ray.setFromCamera(pointer, this.camera)
    const raw = ray.intersectObjects([...this.objects.values()].map(value => value.group), true)
    const hit = firstVisibleHit(raw)
    let object: THREE.Object3D | undefined = hit?.object
    while (object && !object.userData.entityId) object = object.parent ?? undefined
    const hidden = raw.slice(0, 3).map(candidate => { let node: THREE.Object3D | null = candidate.object; const chain: string[] = []; while (node) { chain.push(`${node.type}${node.visible ? "" : "(hidden)"}`); node = node.parent } return chain.join("<") })
    return { ...(typeof object?.userData.entityId === "string" ? { entityId: object.userData.entityId } : {}), ...(hit ? { point: hit.point.toArray() as [number, number, number] } : {}), meshes: this.renderer.info.render.triangles, rawHits: raw.length, groups: this.objects.size, ...(raw.length && !hit ? { hiddenChains: hidden } : {}), loadingErrors: [...this.loadingErrors.values()] }
  }
  /** 场景图读数：验收/诊断用（哪些实体组在场景里、可见性、包围盒、相机位姿）。只读，不改任何状态。 */
  describeScene(): unknown {
    const groups = [...this.objects.entries()].map(([entityId, loaded]) => {
      // 只算模型/GLB/机器人/splat 的真实几何；挂在 body 下的相机视锥、安装点/gizmo 等辅助子树被整棵跳过。
      const box = objectWorldBounds(loaded.group, this.splatBounds)
      return { entityId, visible: loaded.group.visible, parented: Boolean(loaded.group.parent), meshes: loaded.group.getObjectsByProperty("isMesh", true).length, empty: box.isEmpty(), bounds: box.isEmpty() ? null : { min: box.min.toArray(), max: box.max.toArray() } }
    })
    return { groups, camera: { position: this.camera.position.toArray(), target: this.controls.target.toArray(), near: this.camera.near, far: this.camera.far, aspect: this.camera.aspect }, canvas: { width: this.renderer.domElement.width, height: this.renderer.domElement.height, cssHeight: Math.round(this.renderer.domElement.getBoundingClientRect().height) }, children: this.scene.children.length }
  }
  /**
   * 把一个实体组的世界包围盒中心投到屏幕像素，并在该像素上做一次拾取。
   *
   * 为什么单独一条：物体在画面上可能只有几十像素，网格扫描会整个错过它；按实体名取"它到底在哪一像素"，
   * 才能把"看不见"和"拾取坏了"分开。
   */
  probeEntityPixel(entityId: string): { screen?: [number, number]; insideCanvas?: boolean; pick?: ReturnType<SceneViewer["probePick"]>; bounds?: { min: number[]; max: number[] } } {
    const loaded = this.objects.get(entityId)
    if (!loaded) return {}
    // 与 focus/frameAll/describeScene 同一份实体几何：辅助显示不参与中心与包围盒，拾取落回真实表面。
    const box = objectWorldBounds(loaded.group, this.splatBounds)
    if (box.isEmpty()) return {}
    const center = box.getCenter(new THREE.Vector3())
    const ndc = center.clone().project(this.camera)
    const canvas = this.renderer.domElement
    const rect = canvas.getBoundingClientRect()
    const x = rect.left + (ndc.x * 0.5 + 0.5) * rect.width
    const y = rect.top + (1 - (ndc.y * 0.5 + 0.5)) * rect.height
    return { screen: [Math.round(x), Math.round(y)], insideCanvas: ndc.z >= -1 && ndc.z <= 1 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom, pick: this.probePick(x, y), bounds: { min: box.min.toArray(), max: box.max.toArray() } }
  }
  /**
   * 当前视口的相机位姿与画布尺寸：写"这批批注是在什么视角下标的"用。
   *
   * 为什么要把 target/up 也带上：只看 position+quaternion 能重建朝向，但重建不出"看向哪里"的构图语义；
   * 用户说"这张图里的苹果"时，模型需要知道相机是在俯视、侧视还是贴近表面。
   */
  pose(): { position: [number, number, number]; quaternion: [number, number, number, number]; target: [number, number, number]; up: [number, number, number]; fovDeg: number; near: number; far: number; imageWidth: number; imageHeight: number; aspect: number } {
    const canvas = this.renderer.domElement
    return {
      position: this.camera.position.toArray() as [number, number, number],
      quaternion: this.camera.quaternion.toArray() as [number, number, number, number],
      target: this.controls.target.toArray() as [number, number, number],
      up: this.camera.up.toArray() as [number, number, number],
      fovDeg: this.camera.fov, near: this.camera.near, far: this.camera.far,
      imageWidth: canvas.width, imageHeight: canvas.height, aspect: this.camera.aspect,
    }
  }
  /** 批注锚点的当前屏幕像素位置（含 device 像素比），供面板把编辑框贴着标记放。 */
  annotationScreenPoint(annotationId: string): [number, number] | undefined {
    const annotation = this.annotations.find(item => item.annotationId === annotationId)
    if (!annotation) return undefined
    const world = resolveAnnotationWorld(annotation, this.carriers)
    if (!world) return undefined
    const canvas = this.renderer.domElement
    return projectToCapture(world, this.camera, { width: canvas.width, height: canvas.height })
  }
  /** 批注载体是**实体 group**（实体级锚定）：实体被运行帧或编辑移动时，标记跟着走。 */
  private get carriers(): Map<string, { group: THREE.Group }> {
    const carriers = new Map<string, { group: THREE.Group }>()
    for (const [entityId, loaded] of this.objects) carriers.set(entityId, loaded)
    return carriers
  }
  /** 每帧重算标记世界位置、朝向与可见性；实体缺失时隐藏标记（保留批注，等实体回来）。 */
  private updateAnnotationMarkers(): void {
    const carriers = this.carriers
    // 屏幕尺寸按 CSS 像素算：贴图里已按 dpr 提过清晰度，这里再用 device 像素会把徽标放大一倍。
    const viewportHeightPx = this.renderer.domElement.getBoundingClientRect().height || this.renderer.domElement.height
    for (const annotation of this.annotations) {
      const entry = this.markers.get(annotation.annotationId)
      if (!entry) continue
      const world = resolveAnnotationWorld(annotation, carriers)
      entry.marker.visible = world !== undefined
      if (!world) continue
      updateAnnotationMarker(entry, world, this.camera, viewportHeightPx, this.annotating)
    }
  }
  /**
   * 批注点击：命中已有标记就交给调用方去编辑，否则在真实表面上落一条新批注。
   *
   * 判据与"选择/放置"同源（同一个 `firstVisibleHit`），所以被隐藏的碰撞 geom 不会被当成可批注表面；
   * 空白处（没有视觉命中）不落点——批注必须挂在真实物体上，否则"附着"就无从谈起。
   */
  private annotatePointer = (event: PointerEvent): void => { this.handleAnnotationPointer(event) }
  /**
   * 批注模式左键：命中标记/表面就交给回调，并取消这次左键的默认动作。
   *
   * 为什么必须 preventDefault：浏览器在 pointerdown 之后还会补发一次 mousedown，它的默认动作是
   * "聚焦被点中的画布"，正好把浮条输入框刚拿到的焦点抢回视口（真机事件序复现见
   * `.rc-evidence/p8-focus-fix`）。只吞真正处理了的那一次；空白点击与其它模式的默认行为不动。
   * 单独成方法是为了让这条判据在无 WebGL 的测试里用真源码钉住（`annotation-pointer-focus.test.ts`）。
   */
  private handleAnnotationPointer(event: PointerEvent): void {
    if (!this.annotating || event.button !== 0 || this.transformControls.axis) return
    if (this.applyAnnotationHit(this.annotationHitAtPointer(event.clientX,event.clientY))) event.preventDefault()
  }
  /** 返回这次是否真的交给了批注回调——调用方据此决定要不要取消浏览器随后的默认聚焦。 */
  private applyAnnotationHit(hit:{annotationId:string}|{anchor:ViewerAnnotationAnchor}|undefined):boolean {
    if(!hit)return false
    if('annotationId' in hit)this.options.onAnnotationSelect?.(hit.annotationId)
    else this.options.onAnnotationCreate?.(hit.anchor)
    return true
  }
  private annotationHitAtPointer(clientX:number,clientY:number,expectedEntityId?:string):{annotationId:string}|{anchor:ViewerAnnotationAnchor}|undefined {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const pointer = new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1)
    const ray = new THREE.Raycaster(); ray.setFromCamera(pointer, this.camera)
    const onMarker = ray.intersectObjects([...this.markers.values()].flatMap(entry => [entry.badge, entry.pick]), false)[0]
    const annotationId = onMarker?.object.userData.annotationId
    if (typeof annotationId === "string") return {annotationId}
    const hit = firstVisibleHit(ray.intersectObjects([...this.objects.values()].map(value => value.group), true))
    if (!hit) return
    let object: THREE.Object3D | undefined = hit.object
    while (object && !object.userData.entityId) object = object.parent ?? undefined
    const entityId = object?.userData.entityId
    if (typeof entityId !== "string" || expectedEntityId!==undefined&&entityId!==expectedEntityId) return
    const carrier = this.objects.get(entityId)
    if (!carrier) return
    if(!this.snapshot)return
    const normal = hit.face?.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize()
    return {anchor:annotationAnchorAtHit(entityId,carrier,hit.object,hit.point,normal,this.snapshot,currentRobotFrame(this.snapshot,this.world,this.displayedFrame))}
  }
  /** 面板可能改锚点（例如换实体）——锚点变了必须重建标记位置，否则显示与实际不一致。 */
  setAnnotationAnchor(annotationId: string, anchor: ViewerAnnotationAnchor): void {
    const annotation = this.annotations.find(item => item.annotationId === annotationId)
    if (!annotation) return
    annotation.anchor = structuredClone(anchor)
    this.updateAnnotationMarkers()
  }
  setPlacementMode(on: boolean): void {
    const wasOn = this.placing
    this.placing = on
    this.placeDown = undefined
    if (on) {
      if (!wasOn) this.placementTransformEnabled = this.annotating ? this.annotationTransformEnabled ?? this.transformControls.enabled : this.transformControls.enabled
      this.transformControls.enabled = false
      this.transformControls.axis = null
      this.syncTransformGizmo()
    } else {
      this.clearPlaceMarker()
      if (wasOn && this.placementTransformEnabled !== undefined) {
        if (!this.annotating) this.transformControls.enabled = this.placementTransformEnabled
        this.placementTransformEnabled = undefined
        this.syncTransformGizmo()
      }
    }
  }
  private clearPlaceMarker(): void {
    if (!this.placeMarker) return
    this.placeMarker.removeFromParent()
    disposeObject(this.placeMarker)
    this.placeMarker = undefined
  }
  private showPlaceMarker(point: THREE.Vector3): void {
    this.clearPlaceMarker()
    const group = new THREE.Group()
    group.position.copy(point).add(new THREE.Vector3(0, 0, 0.018))
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.065, 40), new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, side: THREE.DoubleSide }))
    ring.renderOrder = 1000
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 8), new THREE.MeshBasicMaterial({ color: 0xfff6a3, depthTest: false, depthWrite: false }))
    dot.renderOrder = 1001
    group.add(ring, dot)
    markAuthoringHelper(group)
    this.scene.add(group)
    this.placeMarker = group
  }
  /**
   * 进入/退出源表面安装点拾取模式。进入后左键点中源实体**真实可见几何**才产生结果：
   * 碰撞代理/隐藏 geom 由 `firstVisibleHit` 排除，ghost 不在 `objects` 里天然不参与。
   */
  setMountPickMode(target?: { entityId: string; rootBodyName: string }): void {
    this.mountPick = target
    if (!target) this.clearSurfaceMountMarker()
  }
  clearSurfaceMountMarker(): void {
    if (!this.mountPickMarker) return
    this.mountPickMarker.removeFromParent()
    disposeObject(this.mountPickMarker)
    this.mountPickMarker = undefined
  }
  /**
   * 射线只命中所选源的**真实可视几何**；点与法线换算到源真实根 body 局部系。
   * 返回的位姿把 +Z 对齐到表面法线，可直接交给 `robot_assembly_preview` 当 `kind:'pose'` 源安装面。
   */
  pickSourceSurfaceMount(entityId: string, rootBodyName: string, clientX: number, clientY: number): ViewerSurfaceMountPick | undefined {
    const loaded = this.objects.get(entityId)
    if (!loaded) return undefined
    const root = loaded.robot?.bodyNode(rootBodyName)
    if (!root) return undefined
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return undefined
    const pointer = new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1)
    const ray = new THREE.Raycaster(); ray.setFromCamera(pointer, this.camera)
    const visual = loaded.visual ?? loaded.baseVisual ?? loaded.group
    const hit = firstVisibleHit(ray.intersectObjects([visual], true))
    if (!hit) return undefined
    root.updateWorldMatrix(true, false)
    const worldFromRootInverse = root.matrixWorld.clone().invert()
    const position = hit.point.clone().applyMatrix4(worldFromRootInverse)
    const faceNormal = hit.face?.normal
    const normalWorld = faceNormal ? faceNormal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 0, 1)
    const normalRoot = normalWorld.clone().transformDirection(worldFromRootInverse).normalize()
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normalRoot)
    // 命中归属的真实 body/link 名：从命中节点往上找最内层已登记部件。
    let bodyName: string | undefined
    for (let node: THREE.Object3D | null = hit.object; node && bodyName === undefined; node = node.parent) {
      const part = loaded.robot?.parts.find(candidate => candidate.node === node)
      if (part) bodyName = part.name
    }
    return { entityId, ...(bodyName ? { bodyName } : {}), positionM: [position.x, position.y, position.z], quaternionXyzw: [quaternion.x, quaternion.y, quaternion.z, quaternion.w], normalRootM: [normalRoot.x, normalRoot.y, normalRoot.z], hitPointWorld: [hit.point.x, hit.point.y, hit.point.z] }
  }
  /** 小型位置/方向标记：加在源真实根 body 下（局部位姿），随 FK 移动但不进目录、不被拾取。 */
  private showSurfaceMountMarker(entityId: string, rootBodyName: string, pick: ViewerSurfaceMountPick): void {
    this.clearSurfaceMountMarker()
    const root = this.objects.get(entityId)?.robot?.bodyNode(rootBodyName)
    if (!root) return
    const group = new THREE.Group()
    group.name = "assembly-mount-pick-marker"
    group.matrixAutoUpdate = false
    group.matrix.copy(new THREE.Matrix4().compose(new THREE.Vector3(...pick.positionM), new THREE.Quaternion(...pick.quaternionXyzw).normalize(), new THREE.Vector3(1, 1, 1)))
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.01, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff9f43, depthTest: false, depthWrite: false }))
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.03, 10), new THREE.MeshBasicMaterial({ color: 0xffd34d, depthTest: false, depthWrite: false }))
    arrow.position.set(0, 0, 0.02)
    arrow.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1)))
    for (const object of [dot, arrow]) { object.userData.assemblyGhost = true; (object as unknown as { raycast: () => void }).raycast = () => {} }
    group.add(dot, arrow)
    group.userData.assemblyGhost = true
    markAuthoringHelper(group)
    root.add(group)
    this.mountPickMarker = group
  }
  /**
   * 自动画质预算的唯一写入口：真实显卡族 + 当前用户画质 + "这个 Scene 是否已识别高精"三者合成。
   * 构造函数、setDisplaySettings、setScene 都只调它，避免三处各写一套 `interactiveSplatBudget` 参数。
   */
  private refreshSplatBudget(): void {
    const vendorFamily = viewerWebglFacts(this.renderer).vendorFamily
    // `display` 在真实实例里一定已初始化；部分测试用 Object.create 跳过了字段初始化，读缺省即 auto。
    this.splatBudget = interactiveSplatBudget(vendorFamily, this.display?.splatQuality ?? "auto", { recognizedHighScene: this.recognizedHighSplat })
    if (this.spark) {
      this.spark.lodSplatCount = this.splatBudget.lodSplatCount
      this.spark.lodRenderScale = this.splatBudget.lodRenderScale
    }
  }
  setDisplaySettings(settings: Partial<ViewerDisplaySettings>): void {
    this.display = { ...this.display, ...settings }
    this.refreshSplatBudget()
    this.syncCollisionTopology()
    this.grid.visible = this.display.grid
    this.axes.visible = this.display.axes
    // 背景色仍归这里；但环境组件声明 `background: "environment"` 且 HDRI 在手里时，天空盒优先
    // （applyBackground 是背景的唯一写入口，别在这里再直接写 scene.background）。
    this.applyBackground()
    for (const loaded of this.objects.values()) this.applyDisplay(loaded)
  }
  private applyDisplay(loaded: Loaded): void {
    if (loaded.splat) loaded.splat.visible = this.display.splats
    if (loaded.collision) loaded.collision.visible = false
    // robot 源碰撞声明尚未带引擎编译位姿；实际拓扑统一由 collisionTopologyLayer 投影。
    loaded.robot?.setCollisionVisible(false)
    const shadows = this.environment?.component.shadows === true
    loaded.group.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return
      // 高斯泼溅不参与阴影贴图（spark 的渲染不走 THREE 的阴影通道）：按普通网格设置只会得到
      // "开了阴影但泼溅没有影子"的假读数，这里显式关掉。
      if (object instanceof SplatMesh) { object.castShadow = false; object.receiveShadow = false; return }
      object.castShadow = shadows
      object.receiveShadow = shadows
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) if ("wireframe" in material) material.wireframe = this.display.wireframe
    })
  }
  /**
   * 相机状态：前三个字段是老语义（位置/姿态/转心），后面如实带上 up、视场、裁剪面，
   * 以及**非普通镜头**才有的内参。全部按当前画布像素量出来（不是"上次请求的是什么"）。
   */
  getViewState(): ViewerViewState {
    // 量什么、什么时候带 intrinsics 都在 `cameraStateFromView`（与测试同一份）。
    return {...cameraStateFromView(this.camera, this.canvasPixels(), this.controls.target.toArray() as [number,number,number]),navigation:this.freeNavigation()}
  }
  /**
   * 恢复相机状态：roll、视场、裁剪面与内参都跟着回去（老的三字段状态照常可用）。
   *
   * 走的是与"应用照片相机"**同一条**路径（`normalizeCameraRequest` → `writeCameraView` → 当场核对），
   * 所以 target/up/roll 之间不会互相覆盖：状态里的四元数是姿态的唯一出处，target 只提供转心距离，
   * up 是相机 up 轴本身。恢复完当场测量，复现不出来就抛错。
   */
  setViewState(state: ViewerViewState,options:{focus?:boolean}={}): void {
    this.exitCameraMode({restoreView:false,focus:options.focus})
    // 状态 → 请求的映射与"命名相机恢复"共用一份（`cameraRequestFromState`），不各写一遍。
    this.writeCameraView(normalizeCameraRequest(cameraRequestFromState(state), this.cameraCurrent()))
    // 恢复场景相机只恢复机位；导航偏好属于查看器，不能被文件或旧机位覆盖。
  }
  /** 当前相机**量出来**的完整视角：内参、roll、投影矩阵、worldFromCamera（与 camera_fit 同形）。只读。 */
  cameraView(): ViewerCameraMeasurement { return describeCameraView(this.camera, this.canvasPixels()) }
  /**
   * 应用一台指定相机（照片机位/内参、camera_fit 的输出，或显式 position/quaternion/target/up/fov）。
   * 返回应用后当场测量到的视角；请求里有矛盾（位姿多来源不一致、target 不在视线上、fov 与内参不一致）时
   * 抛 `ViewerCameraError`，不猜、不静默挑一个。
   */
  applyCameraView(request: ViewerCameraRequest,options:{keepObserverMode?:boolean}={}): ViewerCameraMeasurement {
    if (this.disposed) throw new Error("VIEWER_DISPOSED")
    if(!options.keepObserverMode)this.exitCameraMode({restoreView:false})
    this.writeCameraView(normalizeCameraRequest(request, this.cameraCurrent()))
    return this.cameraView()
  }
  /**
   * 用指定相机、指定像素尺寸渲染一张图（同一台原生 Viewer、同一个 scene、同一套灯光与色调映射）。
   *
   * 实现是"临时把画布尺寸换掉、用一台专用相机渲染一次、`toDataURL` 后立刻还原"——不是另开一个
   * `WebGLRenderTarget`：走 render target 时 three 不做 `outputColorSpace` 的转换（拿到的是线性值），
   * 出的图与屏幕上的同一台相机会**色不一致**；换画布走的正是 `capture()` 那条路，色彩/色调映射/抗锯齿
   * 与屏幕逐位同源。整个过程同步完成，浏览器不会在中间合成一帧，屏幕上不会闪。
   * 专用相机（不是主相机）保证画布里的相机状态不被这次出图改动。
   */
  /**
   * LOD 窄面：这一帧参与级别选择的实体各自显示的是哪一级、哪份资源版本、多少三角形、距离多少。
   *
   * 两种事实分开：`simplified`（用了简化件，正常按距离简化）与 `coarser`/`failed`（比这台相机该用的级别更粗、
   * 或该读的级别没读进来）。`camera` 说明这些级别是为哪台相机定的——按指定相机出图那次是 `capture`。
   */
  private lodCaptureFace(camera: "capture" | "window"): LodCaptureFace {
    const entries: LodEntityReading[] = []
    const skipped: Array<{ entityId: string; reason: string }> = []
    for (const [entityId, loaded] of this.objects) {
      const lod = loaded.lod
      if (!lod) {
        const reason = loaded.lodWarnings.find(warning => warning.startsWith("LOD_SKIPPED"))
        if (reason) skipped.push({ entityId, reason })
        continue
      }
      const level = lod.current
      const selected = level === LOD_BASE ? undefined : lod.plan.levels[level]
      entries.push({
        entityId,
        level,
        requested: lod.wanted,
        ...(selected ? { role: selected.role, resource: `${selected.ref.resourceId}@${String(selected.ref.version)}` } : loaded.baseRef ? { resource: `${loaded.baseRef.resourceId}@${String(loaded.baseRef.version)}` } : {}),
        triangles: lod.triangles.get(level) ?? 0,
        distanceM: lod.distance,
        simplified: level !== LOD_BASE,
        ...(level > lod.wanted ? { coarser: true } : {}),
        ...(lod.failed.size ? { failed: [...lod.failed].map(index => lod.plan.levels[index]?.role ?? String(index)) } : {}),
      })
    }
    return { camera, planned: entries.length, entries, ...(skipped.length ? { skipped } : {}) }
  }
  renderCameraImage(request: ViewerCameraRenderRequest): ViewerCameraRender {
    if (this.disposed) throw new Error("VIEWER_DISPOSED")
    const view = normalizeCameraRequest(request, this.cameraCurrent())
    const width = request.width ?? view.intrinsics?.width ?? this.canvasPixels().width
    const height = request.height ?? view.intrinsics?.height ?? this.canvasPixels().height
    assertRenderSize(width, height)
    const size = { width, height }
    const camera = new THREE.PerspectiveCamera(view.fovYDeg, width / height, view.near, view.far)
    // 出图相机没有 controls（这台相机只出这一张图，不需要每帧重算姿态）：同一份写入 + 当场核对。
    const verification = writeViewToCamera(camera, undefined, view, size)
    camera.updateMatrixWorld(true)
    if (!verification.ok) throw new ViewerCameraError("VIEWER_CAMERA_RENDER_MISMATCH", `出图相机没有按请求复现：${verification.errors.join("；")}`)
    const frame = this.refreshDisplayedFrame()
    const renderer = this.renderer
    const previous = { width: renderer.domElement.width, height: renderer.domElement.height, pixelRatio: renderer.getPixelRatio() }
    // 出图这一帧的 LOD 读数（在下面 try 里、渲染之后**当场**取；变量放这儿是因为它要活过 finally）。
    let captureLod: LodCaptureFace
    let dataURL: string
    try {
      renderer.setPixelRatio(1)
      renderer.setSize(width, height, false)
      // 按**这台出图相机**重新定级（settle：一次性采集不走窗口相机的滞回）。窗口相机可能停在很远的远景，
      // 那一级对近景就是"粗件"；不在这里按出图相机 settle 一次，近景照片会沿用远景的简化件。
      // 交换在判据满足时同步完成，出图前调一次即可。
      this.updateLod(camera, { settle: true })
      // 所有作者辅助层（gizmo/视锥/路线/选择/碰撞…）不能混进"按相机出图"的 RGB；capture pass 自恢复。
      const captured = this.withoutCaptureHelpers(() => {
        renderer.render(this.scene, camera)
        // 此刻 loaded.lod 描述的就是**刚渲染出来的这一帧**：级别、资源版本、三角形、到这台相机的距离。
        // 下面的 finally 会把窗口相机那一级恢复回来，所以这一次读数必须在这里留住。
        const lod = this.lodCaptureFace("capture")
        return { lod, dataURL: renderer.domElement.toDataURL("image/png") }
      })
      captureLod = captured.lod
      dataURL = captured.dataURL
    } finally {
      renderer.setPixelRatio(previous.pixelRatio)
      this.restoreCanvasSize(previous)
      // 画布上现在留着的是刚刚那张"指定相机"的图（尺寸也不同）。立刻按当前相机重绘一次，
      // 保证屏幕上的画面与相机状态一致，不受这次出图影响。
      // 出图结束：把**窗口相机**那一级恢复回来（同一套判据、同样 settle 到该相机该用的级别），
      // 否则屏幕上会留着"按照片相机定的级"。恢复在重绘屏幕之前，这一帧屏幕上就是对的。
      this.updateLod(this.camera, { settle: true })
      renderer.render(this.scene, this.camera)
    }
    const measurement = describeCameraView(camera, size)
    return {
      dataURL, imageWidth: size.width, imageHeight: size.height, source: "native-viewer-camera",
      camera: measurement, ...view.intrinsics ? { sourceIntrinsics: view.intrinsics } : {}, applied: view,
      // 这张图**这一帧**的环境光照事实（与 `capture()` 同一份 owner）：按相机出的图同样可能落在
      // "请求的 HDRI 没装上/正在换"的画面上，回执必须能说清，不能只有当前画布截图才带这句。
      environment: this.environmentCaptureFace(),
      // 这张图这一帧的 LOD 窄面：渲染**前**按这台相机 settle、渲染**后**当场读（不是返回时才读）。
      lod: captureLod,
      // 展示层事实与 `capture()` 同一 owner：按相机出的图同样是"当前画面的显示状态"，不能不带这一面。
      presentation: this.presentationStatus(),
      sceneId: this.snapshot?.sceneId, sceneRevision: this.snapshot?.revision,
      ...this.world ? { worldId: this.world.worldId, generation: this.world.worldGeneration, worldSceneRevision: this.world.appliedSceneRevision, ...frame ? { frameId: frame.frameId, frameSceneRevision: frame.sceneRevision, stepIndex: frame.stepIndex, simTime: frame.simTime } : {} } : {},
      capturedAt: new Date().toISOString(),
    }
  }
  /** 出图前把在途的运行帧落实到画面（与 `capture()` 同一判据：编辑中不落实、只拍当前）。 */
  private refreshDisplayedFrame(): Frame | undefined {
    const pending = this.projection.consume()
    if (pending && !this.editing) this.applyFrame(pending)
    return this.editing ? undefined : this.projection.current()
  }
  /** 把画布尺寸还原成出图前的大小（优先按容器 CSS 尺寸走既有 resize；容器不可见时按记录还原着色缓冲）。 */
  private restoreCanvasSize(previous: { width: number; height: number; pixelRatio: number }): void {
    if (this.options.container.clientWidth > 0 && this.options.container.clientHeight > 0) { this.resizeCanvas(); return }
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(previous.width, previous.height, false)
    this.renderer.setPixelRatio(previous.pixelRatio)
    this.camera.updateProjectionMatrix()
  }
  cameraPreset(preset: "top" | "front" | "side" | "perspective"): void {
    this.exitCameraMode({restoreView:false});this.clearAppliedIntrinsics();this.camera.up.copy(this.worldUp())
    const distance = Math.max(0.2, this.camera.position.distanceTo(this.controls.target))
    const directions = { top: new THREE.Vector3(0, -0.001, 1), front: new THREE.Vector3(0, -1, 0.12), side: new THREE.Vector3(1, 0, 0.12), perspective: new THREE.Vector3(1, -1.4, 0.9) }
    this.camera.position.copy(this.controls.target).add(directions[preset].normalize().multiplyScalar(distance)); this.controls.update()
  }
  private contextPointer = (event: MouseEvent): void => { this.openContextMenu(event) }
  private openContextMenu(event: MouseEvent):void {
    if(!this.options.onContextMenu||!this.snapshot)return
    // 菜单目标必须是**光标下的真实实体**，不能拿“当前已选中”冒充：先射线拾取，点到空处不开菜单。
    const rect=this.renderer.domElement.getBoundingClientRect()
    const pointer=new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1)
    const ray=new THREE.Raycaster();ray.setFromCamera(pointer,this.camera)
    const hit=firstVisibleHit(ray.intersectObjects([...this.objects.values()].map(value=>value.group),true))
    let target:THREE.Object3D|undefined=hit?.object
    while(target&&!target.userData.entityId)target=target.parent??undefined
    const entityId=typeof target?.userData.entityId==='string'?target.userData.entityId:undefined
    if(entityId===undefined)return
    event.preventDefault()
    if(this.selected!==entityId)this.select(entityId)
    const sceneId=this.snapshot.sceneId,sceneRevision=this.snapshot.revision
    // 保存右键当帧的真实表面锚点；菜单焦点/面板布局变化后旧屏幕坐标不能再次投射。
    const carrier=this.objects.get(entityId),hitAtPointer=this.annotationHitAtPointer(event.clientX,event.clientY,entityId)
    this.options.onContextMenu({clientX:event.clientX,clientY:event.clientY,entityId,sceneId,sceneRevision,annotate:()=>{
      if(this.selected!==entityId||this.snapshot?.sceneId!==sceneId||this.snapshot.revision!==sceneRevision||!carrier||this.objects.get(entityId)!==carrier)throw Error('VIEWER_ANNOTATION_TARGET_CHANGED: 当前批注对象已变化 / The annotation target has changed.')
      if(!hitAtPointer)throw Error('VIEWER_ANNOTATION_SURFACE_REQUIRED: 当前位置没有可批注的所选对象表面 / No annotatable surface of the selected object was hit.')
      this.applyAnnotationHit(hitAtPointer)
    }})
  }
  private orbitFocusPointer = (event: PointerEvent): void => {
    if(event.button!==1||event.shiftKey||this.firstPerson?.active||this.cameraRigPilot||this.cameraRigLook||!this.selected)return
    const object=this.objects.get(this.selected)?.group
    if(!object)return
    object.updateWorldMatrix(true,true)
    const bounds=new THREE.Box3().setFromObject(object)
    if(!bounds.isEmpty())this.controls.target.copy(bounds.getCenter(new THREE.Vector3()))
  }
  private selectPointer = (event: PointerEvent): void => {
    // 批注模式下左键的语义归 annotatePointer：否则"点一个物体加批注"会顺带把它选中并挂上 gizmo。
    if (event.button !== 0) return
    if (this.placing) { this.placeDown = { x: event.clientX, y: event.clientY }; return }
    if (this.transformControls.axis || this.annotating) return
    // 表面安装点拾取模式：左键只做源真实几何拾取，不触发普通选择/gizmo。
    if (this.mountPick) {
      const pick = this.pickSourceSurfaceMount(this.mountPick.entityId, this.mountPick.rootBodyName, event.clientX, event.clientY)
      if (pick) { this.showSurfaceMountMarker(this.mountPick.entityId, this.mountPick.rootBodyName, pick); this.options.onMountPick?.(pick) }
      return
    }
    const rect = this.renderer.domElement.getBoundingClientRect()
    const pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1)
    const ray = new THREE.Raycaster(); ray.setFromCamera(pointer, this.camera)
    // 相机视锥（DEV-038）：先认视锥——命中即选中并高亮，不顺带改实体选择；点到别处则取消视锥选中。
    const rigHit = ray.intersectObjects([...this.cameraRigs.values()].map(rig => rig.pick), false)[0]
    const rigKey = typeof rigHit?.object.userData.cameraRigKey === "string" ? rigHit.object.userData.cameraRigKey : undefined
    if (rigKey !== undefined || this.cameraRigSelected !== undefined) this.selectCameraRig(rigKey)
    if (rigKey !== undefined) return
    const robotAnchor=this.robotAnchorLayer?.pick(ray)
    if(robotAnchor){this.select(robotAnchor.entityId);this.options.onRobotAnchorSelect?.(robotAnchor);return}
    const hit = firstVisibleHit(ray.intersectObjects([...this.objects.values()].map(value => value.group), true))
    let object: THREE.Object3D | undefined = hit?.object
    while (object && !object.userData.entityId) object = object.parent ?? undefined
    const entityId = object?.userData.entityId
    this.select(entityId)
    // 部件级选择（R-011）：从命中面往上找**最内层**带 partId 的真实部件；点到无部件的节点则清除部件选择。
    // 这只是展示层高亮 + 上报，下面 `select` 走的实体选择语义（gizmo/右键）一字未改。
    let partNode: THREE.Object3D | undefined = hit?.object
    while (partNode && partNode.userData.partId === undefined && partNode.userData.entityId === undefined) partNode = partNode.parent ?? undefined
    const partId = typeof partNode?.userData.partId === "string" ? partNode.userData.partId : undefined
    if (entityId !== undefined && partId !== undefined) this.selectPart(entityId, partId)
    else if (this.selectedPart) this.selectPart(undefined, undefined)
  }
  private placePointer = (event: PointerEvent): void => {
    const down = this.placeDown
    this.placeDown = undefined
    if (!this.placing || !down || event.button !== 0) return
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) >= 4) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    const pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1)
    const ray = new THREE.Raycaster(); ray.setFromCamera(pointer, this.camera)
    const hit = firstVisibleHit(ray.intersectObjects([...this.objects.values()].map(value => value.group), true))
    const point = hit?.point ?? ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3()) ?? undefined
    if (!point) return
    this.showPlaceMarker(point)
    this.options.onPlacePoint?.([point.x, point.y, point.z])
  }
  private async finishEdit(): Promise<void> {
    if (!this.selected || !this.snapshot || !this.options.commitEdit) return
    const sceneId = this.snapshot.sceneId
    const expectedRevision = this.snapshot.revision
    const entityId = sceneEditTarget(this.snapshot,this.selected)?.entityId
    if (!entityId) throw new Error('SCENE_EDIT_TARGET_MISSING: 所选节点的编辑实例已移除')
    const loaded = this.objects.get(entityId)!, group = loaded.group
    let transform: Transform = { position: group.position.toArray(), quaternion: group.quaternion.toArray(), scale: group.scale.toArray() }
    const documentMatrix = loaded.robot?.projectedDocumentMatrix()
    if (documentMatrix) {
      // gizmo挂在运行实体上，但编辑提交的是文档装配。抵消的运行根偏移不能被写回Scene。
      const parentDocument = this.objects.get(group.parent?.userData.entityId)?.documentWorldMatrix
      if (parentDocument) documentMatrix.premultiply(parentDocument.clone().invert())
      else if (group.parent) { group.parent.updateWorldMatrix(true, false); documentMatrix.premultiply(group.parent.matrixWorld.clone().invert()) }
      const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3()
      documentMatrix.decompose(position, rotation, scale)
      transform = { position: position.toArray(), quaternion: rotation.toArray(), scale: scale.toArray() }
    }
    try {
      const committed = await this.options.commitEdit({ sceneId, expectedRevision, entityId, transform })
      // 提交在途期间当前实例可能已切到别的场景（或编辑对象已被换掉）：已提交的事务结果照常保留、不回滚，
      // 但只有仍属本次编辑的原场景/原对象才把快照写回画布，否则迟到结果会把旧场景重新加载，画布与工作台选择脱节。
      if (this.ownsEditTarget(sceneId, entityId, group)) await this.setScene(committed)
    } catch (error) {
      // 失败回退同样只作用于仍属本次编辑的对象；不得按当前选中/当前快照把别场景（或别实体）的变换拼回旧 group。
      if (this.ownsEditTarget(sceneId, entityId, group)) {
        const original = this.snapshot!.entities.find(entity => entity.entityId === entityId)
        if (original) {
          applyTransform(group, original.transform)
          loaded.robot?.resetPose()
          const frame = this.projection?.current()
          const entity = frame?.entities.find(value => value.entityId === entityId)
          if (frame && entity && !this.editing) applyWorldPoses(this.objects, this.scene, { ...frame, entities: [entity] })
        }
      }
      throw error
    }
  }
  /** 当前实例是否仍属于发出编辑时的场景与对象（场景未切走、实体实例未被替换）。 */
  private ownsEditTarget(sceneId: string, entityId: string, group: THREE.Group): boolean {
    return this.snapshot?.sceneId === sceneId && this.objects.get(entityId)?.group === group
  }
  private frameBounds(box:THREE.Box3):void {
    this.exitCameraMode({restoreView:false});this.camera.up.copy(this.worldUp())
    this.clearAppliedIntrinsics()
    const fitted=fitPerspectiveBounds(this.camera,box)
    if(!fitted)return
    this.lastFraming=fitted
    this.controls.target.copy(fitted.center);this.controls.update()
  }
  /**
   * 最小预览入口：把"不是场景快照"的单个对象（STL/OBJ/FBX/DAE/3MF/USDZ/VTK/PLY 网格或转换后的 GLB）
   * 放进同一台相机、网格与 gizmo 里看。
   *
   * 与 `setScene` 完全解耦：不读也不改 `snapshot`/`world`/`objects`，只维护一个"当前预览对象"，
   * 因此工作台的场景语义、机器人、碰撞、编辑提交都不受影响；同一时刻只有一个预览对象存在，
   * 换新的会释放旧的（几何/材质/贴图随 renderer 释放）。`undefined` 表示清空预览。
   * @param object - 要显示的根对象；`undefined` 清空。
   * @param options - `frame:false` 保留相机，只换对象；默认取景到该对象包围盒。
   */
  setPreviewObject(object: THREE.Object3D | undefined, options?: { frame?: boolean }): void {
    if (this.disposed) throw new Error("VIEWER_DISPOSED")
    if (object !== this.preview) {
      this.releasePreview()
      this.preview = object
      if (object) {
        object.userData.previewObject = true
        this.scene.add(object)
      }
    }
    if (object && options?.frame !== false) this.frameBounds(objectWorldBounds(object, this.splatBounds))
  }
  /** 释放当前预览对象（splat 需要自己的 dispose，网格按几何/材质释放）。 */
  private releasePreview(): void {
    const object = this.preview
    this.preview = undefined
    if (!object) return
    object.removeFromParent()
    if (object instanceof SplatMesh) object.dispose()
    else disposeObject(object)
  }
  /** 所有格式、文件预览与场景面共享导航偏好；取景动作只变机位，不暗中改操作方式。 */
  setNavigationMode(mode:"orbit"|"first-person",remember=true):void {
    this.exitCameraMode();this.navigationPreference=mode;this.firstPerson?.clearInput?.();this.syncObserverControls()
    for(const item of this.navigationButtons??[]){const selected=item.mode===mode;item.button.setAttribute("aria-pressed",String(selected));item.button.style.opacity=selected?"1":".55";item.button.style.fontWeight=selected?"700":"400"}
    if(remember){try{localStorage.setItem("lyapunov.viewer.navigation",mode)}catch{};window.dispatchEvent(new CustomEvent("lyapunov-viewer-navigation",{detail:mode}))}
  }
  /** 环境首次打开进入主体内部；小物件、机器人继续使用物体视角。 */
  openDefaultView(entityId?:string):void {
    // 已识别首相机优先：这类文件自己声明了首帧机位，默认打开就该落在那里，而不是 bbox 中心。
    if(this.openFirstCameraView(entityId))return
    const candidates=[...this.objects.entries()].filter(([id])=>!entityId||id===entityId)
    const environment=candidates.some(([id,loaded])=>{
      const entity=this.snapshot?.entities.find(item=>item.entityId===id)
      if(entity?.components.articulation)return false
      const box=objectWorldBounds(loaded.group,this.splatViewBounds),size=box.getSize(new THREE.Vector3())
      return entity?.components.visual?.kind==="splat"?Math.max(size.x,size.y,size.z)>=5:Math.max(size.x,size.y)>=6&&size.z>=2
    })
    if(environment)this.enterSceneCenter(entityId)
    else if(entityId)this.focus(entityId)
    else this.frameAll()
  }
  /**
   * "没有保存机位"的默认打开入口：若这次要显示的对象里有**唯一一个**已识别的首相机标记，就把相机放到
   * 该文件声明的首帧位姿上；否则返回 false，调用方沿用既有 enterSceneCenter/focus/frameAll。
   *
   * 归属与歧义：给了 `entityId` 就只看该实体；没给时若命中的已识别实体不是一个（0 个或≥2 个），
   * 一律不跳（多环境无指定实体存在歧义时保留既有行为）。位姿由文件 frame + 该可视对象真实的
   * `matrixWorld`（实体放置 × 源坐标适配 × 单位缩放）算出，不硬编码任何场景坐标。
   *
   * 只在默认打开路径生效：保存机位（workbench 的 savedView）、显式 Fit/focus、手工导航都不经过这里。
   */
  private openFirstCameraView(entityId?:string):boolean {
    const recognized:Array<[string,Loaded]>=[]
    for(const [id,loaded] of this.objects){
      if(entityId&&id!==entityId)continue
      const frame=loaded.planVisual?.gaussianCameraFrame
      if(isGaussianCameraFrame(frame))recognized.push([id,loaded])
    }
    if(recognized.length!==1)return false
    const loaded=recognized[0]![1],visual=loaded.visual
    if(!visual)return false
    visual.updateWorldMatrix(true,false)
    const pose=gaussianFirstCameraPose(loaded.planVisual!.gaussianCameraFrame,visual.matrixWorld)
    if(!pose)return false
    const box=objectWorldBounds(loaded.group,this.splatViewBounds)
    const size=box.isEmpty()?undefined:box.getSize(new THREE.Vector3())
    const span=size&&Number.isFinite(size.x)&&Number.isFinite(size.y)&&Number.isFinite(size.z)?Math.max(size.x,size.y,size.z):1
    const distance=Number.isFinite(span)&&span>0?Math.max(1,span):1
    this.exitCameraMode({restoreView:false})
    this.clearAppliedIntrinsics();this.lastFraming=undefined
    this.camera.up.copy(pose.up)
    this.camera.position.copy(pose.position)
    this.camera.near=0.02
    this.camera.far=Math.max(100,distance*4)
    const target=pose.position.clone().addScaledVector(pose.forward,distance)
    this.camera.lookAt(target)
    this.camera.updateProjectionMatrix();this.camera.updateMatrixWorld(true)
    this.controls.target.copy(target);this.controls.update()
    this.firstPerson.speed=Math.max(3,Math.min(20,distance/10))
    this.select(undefined)
    return true
  }
  enterSceneCenter(entityId?:string):void {
    this.exitCameraMode({restoreView:false})
    const box=new THREE.Box3()
    for(const [id,loaded] of this.objects)if(!entityId||entityId===id)box.union(objectWorldBounds(loaded.group,this.splatViewBounds))
    const view=placeInsideScene(this.camera,box)
    if(!view)return
    this.clearAppliedIntrinsics();this.lastFraming=undefined
    this.controls.target.copy(view.target)
    this.firstPerson.speed=view.speed;this.select(undefined)
  }
  frameAll(): void {
    this.exitCameraMode({restoreView:false})
    // DEV-034 R19：默认取景优先"任务主体"（场景文档里没有 `articulation` 的实体）。机器人整臂会把取景框撑大，
    // 把 5 cm 的物体挤出画面；主体集合拿不到、或主体取景框为空时退回全部实体（既有行为不变）。
    const subject=subjectEntityIds(this.snapshot?.entities)
    const box=new THREE.Box3()
    // 主体集合里的**超大几何实体**（官方 LIBERO 的 `official-worldbody` 全是 3–6 m 墙面）不能再借"组内兜底"
    // 把 6 m 包围盒漏进并集（真机读数：`oversized=[6.02,0,0.0836,…]` ⇒ 默认机位 17 m、主体仍是小点）；
    // 因此并集里传 `allowOversizedFallback=false`，"整场只有超大几何"时最后再用带兜底的一次调用保底。
    for(const [entityId,loaded] of this.objects)if(!subject||subject.has(entityId))box.union(objectWorldBounds(loaded.group,this.splatViewBounds,true,false))
    if(box.isEmpty())for(const loaded of this.objects.values())box.union(objectWorldBounds(loaded.group,this.splatViewBounds,true,false))
    if(box.isEmpty())for(const loaded of this.objects.values())box.union(objectWorldBounds(loaded.group,this.splatViewBounds,true))
    if(this.preview)box.union(objectWorldBounds(this.preview,this.splatBounds))
    this.frameBounds(box)
  }
  focus(entityId: string): void {
    this.exitCameraMode({restoreView:false})
    const loaded=this.objects.get(entityId)
    if(!loaded)throw new Error(`ENTITY_NOT_FOUND: ${entityId}`)
    this.frameBounds(objectWorldBounds(loaded.group,this.splatViewBounds,true))
  }
  capture(): { dataURL: string; sceneId?: string; sceneRevision?: number; environment: EnvironmentCaptureFace; lod: LodCaptureFace; presentation: PresentationCaptureFace; worldId?: string; generation?: number; worldSceneRevision?: number; frameSceneRevision?: number; frameId?: string; stepIndex?: number; simTime?: number; camera: { position: number[]; quaternion: number[]; projectionMatrix: number[]; target:number[];up:number[];fov_y:number;near:number;far:number;projection:"perspective" }; capturedAt: string } {
    const pending = this.projection.consume()
    if (pending && !this.editing) this.applyFrame(pending)
    // 显示辅助（gizmo/视锥/路线/选择/碰撞…）只在这一帧的 capture pass 里隐藏，finally 恢复。相机状态/物理时钟一概不动。
    const dataURL = this.withoutCaptureHelpers(() => {
      this.renderer.render(this.scene, this.camera)
      return this.renderer.domElement.toDataURL("image/png")
    })
    // 恢复 helper 后再补一帧屏幕画面，避免用户看到"helper 忽然消失"的静态画布。
    this.renderer.render(this.scene, this.camera)
    const frame = this.editing ? undefined : this.projection.current()
    return { dataURL, sceneId: this.snapshot?.sceneId, sceneRevision: this.snapshot?.revision, environment: this.environmentCaptureFace(), lod: this.lodCaptureFace("window"), presentation: this.presentationStatus(), ...(this.world ? { worldId: this.world.worldId, generation: this.world.worldGeneration, worldSceneRevision: this.world.appliedSceneRevision, ...(frame ? { frameId: frame.frameId, frameSceneRevision: frame.sceneRevision, stepIndex: frame.stepIndex, simTime: frame.simTime } : {}) } : {}), camera: { position: this.camera.position.toArray(), quaternion: this.camera.quaternion.toArray(), projectionMatrix: this.camera.projectionMatrix.toArray(),target:this.controls.target.toArray(),up:this.camera.up.toArray(),fov_y:this.camera.fov,near:this.camera.near,far:this.camera.far,projection:"perspective" }, capturedAt: new Date().toISOString() }
  }
  /**
   * 输出画布的真实宿主：优先用主画布当前的父节点（就是 Viewer 容器），退化到构造时给的 container。
   *
   * 两条都是“当前 Viewer 自己的 DOM 宿主”，不是离树画布，也不是全局 document.body；如果都没有就明确报错。
   */
  private captureSurfaceHost(): HTMLElement {
    const canvas = this.renderer?.domElement as (HTMLCanvasElement & { parentElement?: HTMLElement | null }) | undefined
    const parent = canvas?.parentElement
    if (parent && typeof parent.appendChild === "function") return parent
    const container = this.options?.container
    if (container && typeof container.appendChild === "function") return container
    throw new Error("VIEWER_CAPTURE_SURFACE_HOST_UNAVAILABLE: 当前 Viewer 没有可用的 DOM 父节点，不能建立连续视频流")
  }

  /**
   * 真实渲染画布的连续视频流（供 MediaRecorder 使用）：**只**给画布，不请求麦克风或桌面录屏。
   *
   * V10 生产路径：独立输出画布 + 平台 `captureStream(fps)`。每 tick 在显式 capture pass 里真实渲染，
   * 再同步 `drawImage` 到输出画布；帧时间戳由平台按真实合成/采集时刻填写。不再经过
   * `MediaStreamTrackProcessor` / `MediaStreamTrackGenerator`，也不再使用 `captureStream(0)` +
   * `requestFrame()`（它的帧时间戳在本机 Chromium 上按名义 1/fps 递增，会压缩 WebM 时间轴）。
   *
   * 首帧必须在开流**之前**就真实渲染并同步复制到输出画布：平台建立轨道时看到的就是本次录制的
   * 真实画面，Start 后立刻 Stop 也不会先给一帧空白。开流后定时器每 tick 继续真实 clean render，
   * 即使场景静止也不会退化成只有首帧。
   *
   * 输出画布也必须在开流**之前**附着到当前 Viewer 的真实 DOM 宿主（1×1、透明、pointer-events:none，
   * 不用 display/visibility 隐藏）：本机 Chromium 对离树 canvas 的 captureStream 无法可靠连续出帧。
   * 每一轮 Start 都创建/附着自己的节点，Stop/失败/dispose 只摘除本轮节点。
   *
   * V9 干净出图保持不变：每帧先在显式 capture pass 里渲染，再同步 `drawImage` 到独立输出画布；
   * 路线预览/录制时若设了 `setRouteCaptureView`，这一帧用临时 POV 相机；主画布随后恢复为可交互总览。
   */
  captureCanvasStream(frameRate = 30): { stream: MediaStream; width: number; height: number; stop: () => void } {
    if (this.disposed) throw new Error("VIEWER_DISPOSED")
    const canvas = this.renderer.domElement
    const capture = (canvas as HTMLCanvasElement & { captureStream?: (frameRate?: number) => MediaStream }).captureStream
    if (typeof capture !== "function") throw new Error("VIEWER_CANVAS_STREAM_UNSUPPORTED: 当前浏览器不支持 canvas.captureStream，不能录制连续视频")
    const fps = Math.max(1, Math.min(120, Math.round(frameRate) || 30))
    const intervalMs = Math.max(1, Math.round(1000 / fps))
    // 独立输出画布：先附着到当前 Viewer 的真实宿主，再渲染/开流；Chromium 对离树画布的连续采集不可靠。
    const output = createCaptureSurface(canvas.width, canvas.height, this.captureSurfaceHost())
    const outputCapture = (output as HTMLCanvasElement & { captureStream?: (frameRate?: number) => MediaStream }).captureStream
    if (typeof outputCapture !== "function") {
      detachCaptureSurface(output)
      throw new Error("VIEWER_CANVAS_STREAM_UNSUPPORTED: 独立输出画布不支持 canvas.captureStream，不能录制连续视频")
    }
    // 先真实渲染/同步复制首帧，再开平台流。这里失败时还没有创建任何流或定时器，但附着节点必须由本次
    // closure 清掉，不能留成 1×1 残 canvas。
    let stream: MediaStream | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    let closed = false
    const stop = () => {
      if (closed) return
      closed = true
      if (timer !== undefined) { clearInterval(timer); timer = undefined }
      this.captureStreamStops.delete(stop)
      stopStreamTracks(stream)
      detachCaptureSurface(output)
    }
    const draw = () => {
      if (this.disposed || closed) { stop(); return }
      try { this.drawCleanCaptureFrame(output) } catch { stop() }
    }
    this.captureStreamStops.add(stop)
    try {
      this.drawCleanCaptureFrame(output)
      stream = outputCapture.call(output, fps)
      timer = setInterval(draw, intervalMs)
    } catch (failure) {
      // 首帧/开流/异常定时器任何一个失败，都停本次轨道、清本次 timer、移除本次节点后再把错误交给调用方。
      stop()
      throw failure
    }
    return { stream: stream!, width: output.width, height: output.height, stop }
  }

  /**
   * 一帧干净输出：按临时 POV（有则用）渲染 → 同步 `drawImage` 到输出画布 → 恢复屏幕主视角。
   *
   * 顺序是判据：`drawImage` 与 render 在同一个 JS 任务里完成，复制到输出画布的就是**隐藏 helper 后**
   * 那一帧；之后主画布怎么重绘都不会影响输出画布/视频。helper 的 visible 原值由 finally 恢复。
   */
  private drawCleanCaptureFrame(output: HTMLCanvasElement): { width: number; height: number } {
    const canvas = this.renderer.domElement
    const size = { width: canvas.width, height: canvas.height }
    if (output.width !== size.width) output.width = size.width
    if (output.height !== size.height) output.height = size.height
    const context = output.getContext("2d")
    if (!context) throw new Error("VIEWER_CAPTURE_SURFACE_UNSUPPORTED: 独立输出画布没有 2D 上下文")
    const routeCamera = this.routeCaptureView ? this.routeCapturePerspective(size) : this.camera
    const routeActive = Boolean(this.routeCaptureView)
    try {
      if (routeActive) this.updateLod(routeCamera, { settle: true })
      this.withoutCaptureHelpers(() => {
        this.renderer.render(this.scene, routeCamera)
        context.drawImage(canvas, 0, 0, output.width, output.height)
      })
      return { width: output.width, height: output.height }
    } finally {
      // 临时 POV 的渲染/同步 copy 即使抛错，也不能把主画布留在 POV：先在 finally 恢复主相机那一级
      // LOD（helpers 已由 withoutCaptureHelpers 的 finally 恢复），再用主相机重绘可交互总览。
      if (routeActive) { try { this.updateLod(this.camera, { settle: true }) } catch { /* 继续恢复主画面 */ } }
      this.renderer.render(this.scene, this.camera)
    }
  }

  /**
   * 带批注的截图：同一张真图 + 编号点烧进像素 + 逐条屏幕坐标与锚点回执。
   *
   * 为什么编号要烧进像素而不是只给坐标：模型看到的是一张图，图上没有圈点它就无从把"第 3 条"
   * 和画面里的东西对上；坐标回执同时保留，供后续工具做反投影或二次对齐。
   * 屏幕坐标按 `canvas.width/height`（着色缓冲＝device 像素）给出，与 PNG 的实际像素一一对应。
   */
  async captureAnnotated(): Promise<ReturnType<SceneViewer["capture"]> & { pose: ReturnType<SceneViewer["pose"]>; annotations:ViewerAnnotation[]; pins: Array<{ annotationId: string; index: number; text: string; entityId: string; entityName?: string; point: [number, number]; normalized: [number, number]; local: [number, number, number]; world: [number, number, number] }> }> {
    const snapshot = this.capture()
    const pose = this.pose()
    const size = { width: pose.imageWidth, height: pose.imageHeight }
    const carriers = this.carriers
    const capturedAnnotations=this.annotations.map(annotation=>{
      const world=resolveAnnotationWorld(annotation,carriers),carrier=carriers.get(annotation.anchor.entityId)
      return world&&carrier&&this.snapshot?annotationAtCapture(annotation,carrier,world,this.snapshot,currentRobotFrame(this.snapshot,this.world,this.displayedFrame)):structuredClone(annotation)
    })
    const placed = capturedAnnotations.flatMap(annotation => {
      const world = resolveAnnotationWorld(annotation, carriers)
      if (!world) return []
      const point = projectToCapture(world, this.camera, size)
      if (!point) return []
      return [{ annotation, world, point }]
    })
    const dataURL = placed.length
      ? await drawAnnotationPins(snapshot.dataURL, placed.map(item => ({ index: item.annotation.index, point: item.point, text: item.annotation.text })), this.renderer.getPixelRatio())
      : snapshot.dataURL
    return {
      ...snapshot, dataURL, pose, annotations:capturedAnnotations,
      pins: placed.map(item => ({
        annotationId: item.annotation.annotationId,
        index: item.annotation.index,
        text: item.annotation.text,
        entityId: item.annotation.anchor.entityId,
        point: item.point,
        normalized: [Number((item.point[0] / size.width).toFixed(4)), Number((item.point[1] / size.height).toFixed(4))],
        local: item.annotation.anchor.local,
        world: item.world.toArray() as [number, number, number],
      })),
    }
  }
  /**
   * 共享与复用的**真实读数**：每个 URL 真正读了几次（缓存未命中）、命中几次，当前画面里有多少个不同
   * 的几何/材质/贴图实例，以及 renderer 自己记的 GPU 资源数与本帧三角形数。
   *
   * 为什么必须给读数而不是断言"应该共享"：大场景验收要看的是 200 个实例是不是真的共用一份几何/贴图，
   * 只有数实例（IdentitySet 大小、`renderer.info.memory`）能回答，看代码只能回答"设计上打算共享"。
   */
  get resourceReport(): { loads: number; cacheHits: number; urls: Array<{ url: string; loads: number; hits: number }>; meshes: number; geometries: number; materials: number; textures: number; renderer: { geometries: number; textures: number; programs: number; triangles: number; calls: number } } {
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>()
    let meshes = 0
    for (const loaded of this.objects.values()) loaded.group.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return
      meshes++
      if (object.geometry) geometries.add(object.geometry)
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!material) continue
        materials.add(material)
        for (const value of Object.values(material as unknown as Record<string, unknown>)) if (value instanceof THREE.Texture) textures.add(value)
      }
    })
    let loads = 0, cacheHits = 0
    const urls = [...this.gltfStats].map(([url, stat]) => ({ url, ...stat })).map(entry => { loads += entry.loads; cacheHits += entry.hits; return entry })
    return { loads, cacheHits, urls, meshes, geometries: geometries.size, materials: materials.size, textures: textures.size, renderer: { geometries: this.renderer.info.memory.geometries, textures: this.renderer.info.memory.textures, programs: this.renderer.info.programs?.length ?? 0, triangles: this.renderer.info.render.triangles, calls: this.renderer.info.render.calls } }
  }
  /** LOD 的真实状态：哪些实体有计划、当前显示第几级、哪些级别已读进来、哪些级别读失败过、当前级别多少面。 */
  get lodReport(): { planned: number; switches: number; current: Record<string, number>; triangles: Record<string, number>; distance: Record<string, number>; degraded: Array<{ entityId: string; role: string; triangles: number; distanceM: number }>; levels: Record<string, Array<{ level: number; role: string | null; triangles: number }>>; failed?: Record<string, string[]> } {
    const current: Record<string, number> = {}, triangles: Record<string, number> = {}, distance: Record<string, number> = {}, levels: Record<string, Array<{ level: number; role: string | null; triangles: number }>> = {}, failed: Record<string, string[]> = {}
    const degraded: Array<{ entityId: string; role: string; triangles: number; distanceM: number }> = []
    for (const [entityId, entry] of this.objects) {
      if (!entry.lod) continue
      current[entityId] = entry.lod.current
      triangles[entityId] = entry.lod.triangles.get(entry.lod.current) ?? 0
      distance[entityId] = Number(entry.lod.distance.toFixed(3))
      levels[entityId] = [...entry.lod.triangles].map(([level, count]) => ({ level, role: level === LOD_BASE ? null : entry.lod!.plan.levels[level]?.role ?? null, triangles: count })).sort((left, right) => left.level - right.level)
      if (entry.lod.failed.size) failed[entityId] = [...entry.lod.failed].map(index => entry.lod!.plan.levels[index]?.role ?? String(index))
      // 采集质量元数据：现在这一刻画面里**低于基础级别**的实体（"这张图是粗的还是高精的"由它回答）。
      if (entry.lod.current !== LOD_BASE) degraded.push({ entityId, role: entry.lod.plan.levels[entry.lod.current]?.role ?? String(entry.lod.current), triangles: triangles[entityId]!, distanceM: distance[entityId]! })
    }
    return { planned: Object.keys(current).length, switches: this.lodSwitches, current, triangles, distance, degraded, levels, ...(Object.keys(failed).length ? { failed } : {}) }
  }
  get diagnostics() {
    const splats = Object.fromEntries([...this.splatRuntime ?? []].map(([id, { started: _started, ...state }]) => {
      const mesh = this.objects.get(id)?.splat
      return [id, { ...state, lodApplied: mesh?.context.enableLod.value ?? null, selectedSplats: mesh ? this.spark?.lodInstances.get(mesh)?.numSplats ?? null : null }]
    }))
    return {
      sceneId: this.snapshot?.sceneId, revision: this.snapshot?.revision, entityCount: this.objects.size,
      meshCount: this.renderer.info.render.triangles,
      // 保留旧字段：这是生成器当前点数，不是源 PLY 顶点数，也不是最终通过深度筛选的绘制点数。
      splatCount: [...this.objects.values()].reduce((sum, item) => sum + (item.splat?.numSplats ?? 0), 0), splats,
      renderFrameMs: frameSampleSummary(this.renderFrameSamplesMs),
      frameIntervalMs: frameSampleSummary(this.frameIntervalSamplesMs),
      webgl: viewerWebglFacts(this.renderer),
      splatRenderer: {
        activeSplats: this.spark?.activeSplats ?? null,
        generatedSplats: this.spark?.current?.numSplats ?? null,
        sorting: this.spark?.sorting ?? null,
        lodTarget: this.spark ? this.spark.lodSplatCount ?? this.spark.defaultSplatTarget() : null,
        budget: this.splatBudget,
        recognizedHighScene: this.recognizedHighSplat,
        initializationWorkerCancellation: "unsupported",
        decodedRetention: this.options?.splatRetentionScope ? retainedSplats.report : null,
      },
      loadingErrors: Object.fromEntries(this.loadingErrors), droppedFrames: this.projection.droppedFrames,
      framing: this.lastFraming ? { ...this.lastFraming, center: this.lastFraming.center.toArray() } : undefined,
      resources: this.resourceReport, lod: this.lodReport,
      dynamicGeometry: [...this.objects].flatMap(([entityId, loaded]) => loaded.dynamicGeometry ? [{ entityId, nativeNames: loaded.dynamicGeometry.nativeNames, unmatchedBodyNames: loaded.dynamicGeometry.unmatchedBodyNames }] : []),
    }
  }
  private release(loaded: Loaded, preserveSelection = false): void {
    // 这个 Loaded 连同它的缺件警告一起离开画面：实体被移除、换资源、销毁都在这里清，警告不会挂在同一个 entityId 上。
    const entityId = loaded.group.userData.entityId
    if (typeof entityId === "string") this.clearPartState(entityId)
    this.visualWarnings.delete(loaded.group.userData.entityId)
    loaded.dynamicGeometry?.dispose(); loaded.dynamicGeometry = undefined
    loaded.pendingSplat?.cancel()
    this.splatRuntime?.delete(loaded.group.userData.entityId)
    if (this.options?.splatRetentionScope && loaded.splatRetentionKey && loaded.group.userData.loaded && loaded.splat) {
      const data = retainSplatData(loaded.splat)
      if (data) retainedSplats.put(this.options.splatRetentionScope, loaded.splatRetentionKey, data)
    }
    // 同一 Scene 内仍存在的实体仅换视觉资源（例如 Apply policy 的配套模型）时，释放的是旧图形。
    // 保留实体选择，只暂时解绑旧 gizmo；setScene 完成后按当前选择挂到新图形。删除/换 Scene/销毁仍清选择。
    if (this.selected === loaded.group.userData.entityId) { if (this.disposed || preserveSelection) this.transformControls.detach(); else this.select(undefined) }
    loaded.group.removeFromParent(); loaded.splat?.dispose()
    // 共享的可视对象（几何/材质/贴图归 GLTF 缓存所有）在 `disposeObject` 里按 `sharedVisual` 跳过：
    // 同一个 GLB 的其它实例可能还在画面上，绝不能因为其中一个实体离开就把共用的几何/贴图销毁掉。
    // 不共享的部分（机器人网格、碰撞线框、LOD 交换下来的派生对象）照常释放。
    loaded.materialOverride?.reset()
    disposeObject(loaded.group)
    loaded.lod = undefined; loaded.baseVisual = undefined; loaded.visual = undefined
    // 几何减少后包围球变小：阴影取景缓存作废（下一帧 applyEnvironment 会按新半径重取）。
    this.geometryRevision++
    this.sceneRadiusCache = undefined
    // 实体被移除后它上面的批注不删（用户的文字不能自己消失），只是暂时无处安放；标记随之隐藏。
    this.updateAnnotationMarkers()
  }
  dispose(): void {
    this.navigationBar?.remove();if(typeof window!=="undefined"){window.removeEventListener("lyapunov-viewer-navigation",this.navigationChanged);window.removeEventListener("storage",this.navigationStored)}
    this.exitCameraMode({restoreView:false,focus:false});this.observerListeners?.clear();this.presentationListeners?.clear();this.renderer.domElement.removeEventListener("keydown",this.observerKeyDown,true)
    this.disposed = true; this.clearRouteCaptureView(); if (this.captureStreamStops) { for (const stop of this.captureStreamStops) { try { stop() } catch { /* 已清理 */ } } this.captureStreamStops.clear() } cancelAnimationFrame(this.raf); this.resize.disconnect(); this.firstPerson?.dispose(); this.controls.dispose(); this.transformControls.dispose()
    // 部件高亮克隆属于本 Viewer：销毁前换回原材质并释放克隆，避免把克隆材质留在共享几何上。
    this.clearPartState()
    this.clearAssemblyPreview()
    this.clearPlacementPreview()
    this.clearSurfaceMountMarker()
    this.renderer.domElement.removeEventListener("contextmenu", this.contextPointer)
    this.renderer.domElement.removeEventListener("pointerdown", this.orbitFocusPointer, true)
    this.renderer.domElement.removeEventListener("pointerdown", this.selectPointer)
    this.renderer.domElement.removeEventListener("pointerup", this.placePointer)
    this.renderer.domElement.removeEventListener("pointerdown", this.annotatePointer)
    for (const entry of this.markers.values()) disposeAnnotationMarker(entry)
    this.markers.clear(); this.annotations = []; this.annotationRoot.clear()
    for (const rig of this.cameraRigs.values()) { disposeObject(rig.group); rig.group.removeFromParent() }
    this.cameraRigs.clear(); this.cameraRigSelected = undefined
    if (this.captureRouteRoot) for (const child of [...this.captureRouteRoot.children]) { disposeObject(child); child.removeFromParent() }
    if (this.captureRouteCurrentRoot) for (const child of [...this.captureRouteCurrentRoot.children]) { disposeObject(child); child.removeFromParent() }
    this.captureRouteCurrent=undefined;this.captureRouteCurrentLensKey=""
    for (const loaded of this.objects.values()) this.release(loaded)
    this.objects.clear()
    this.collisionTopologyLayer?.dispose();this.collisionTopologyLayer=undefined
    this.robotAnchorLayer?.dispose();this.robotAnchorLayer=undefined
    // 缓存里的 GLTF 是共享几何/材质/贴图的所有者：到这一步才释放（`release` 按 `sharedVisual` 跳过它们，
    // 所以一份都不会早退）。还在途的读取成功后同样释放——它解析出来的东西没人会用，留着就是泄漏；
    // 读取失败的不进缓存，这里也就没有它的账。`gltfStats` 只是读数，随缓存一起清。
    for (const pending of this.gltfs.values()) void pending.then(gltf => disposeGltfSource(gltf), () => undefined)
    this.gltfs.clear(); this.gltfStats.clear()
    // glTF 装载器（含 DRACO/KTX2 解码器的 worker 池与内联字节建出的 blob URL）也是本 Viewer 的资源。
    // 关窗口/切场景时不关解码器 worker 会一直活着；blob URL 不撤则把 930 KB 解码器/转码器钉在内存里。
    if (this.gltfLoaderInstance) { releaseGltfLoader(this.gltfLoaderInstance); this.gltfLoaderInstance = undefined }
    this.releasePreview()
    // HDRI 纹理与 PMREM 目标是本 Viewer 的资源：销毁时一并释放（在途加载由 startEnvironmentLoad
    // 的归属检查自行丢弃，不会把纹理挂到已销毁的渲染器上）。
    this.releaseEnvironmentMap()
    this.spark?.dispose(); this.materialEnvironment.dispose(); this.renderer.dispose(); this.renderer.domElement.remove()
  }
}
/** 帧为 world pose；Scene 中的实体可能仍有 parent，应用时先换回父节点局部坐标。 */
export function applyWorldPoses(objects: ReadonlyMap<string, { group: THREE.Group; robot?: RobotVisual; documentWorldMatrix?: THREE.Matrix4 }>, scene: THREE.Object3D, frame: Frame): void {
  const pending = new Map(frame.entities.map(entity => [entity.entityId, entity]))
  const applied = new Set<string>()
  const apply = (entity: Frame["entities"][number]): void => {
    if (applied.has(entity.entityId)) return
    applied.add(entity.entityId)
    const loaded = objects.get(entity.entityId)
    if (!loaded) return
    // Scene 的 entities 数组不保证父前子后；先把本帧父实体的位姿落实到父 group，
    // 否则子实体会用上一帧的父 matrixWorld 做逆变换，再被父的本帧移动带偏。
    const parent = loaded.group.parent
    if (parent && parent !== scene) {
      const parentEntity = pending.get(parent.userData.entityId)
      if (parentEntity) apply(parentEntity)
    }
    // 运行帧为 world pose；Scene 中的实体可能仍有 parent，先换回父节点局部坐标。
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(...entity.transform.position), new THREE.Quaternion(...entity.transform.quaternion), new THREE.Vector3(...entity.transform.scale))
    if (loaded.robot) matrix.multiply(loaded.robot.rootFrameInverse)
    if (loaded.group.parent && loaded.group.parent !== scene) {
      loaded.group.parent.updateWorldMatrix(true, false)
      matrix.premultiply(loaded.group.parent.matrixWorld.clone().invert())
    }
    matrix.decompose(loaded.group.position, loaded.group.quaternion, loaded.group.scale)
    if (entity.joints) loaded.robot?.setJoints(entity.joints.names, entity.joints.positions)
    loaded.robot?.setBodyWorldPoses(entity.sensors?.bodyWorldPoses ?? entity.sensors?.freeBases, loaded.documentWorldMatrix)
  }
  for (const entity of frame.entities) apply(entity)
}
/** 相机视锥线框几何（DEV-038）：`frustumGeometry` 的 12 段顶点 → `LineSegments`。 */
function rigLineGeometry(geometry: FrustumGeometry): THREE.BufferGeometry {
  const buffer = new THREE.BufferGeometry()
  buffer.setAttribute("position", new THREE.Float32BufferAttribute(geometry.lineVertices, 3))
  return buffer
}
/** 引擎的 body 名 → 该实体的**局部** body 名：带 `entityId/` 前缀时剥掉（MuJoCo 路径），本来就是局部名时原样返回（Isaac 路径）。 */
function localBodyName(bodyName: string, entityId: string): string {
  const prefix = `${entityId}/`
  return bodyName.startsWith(prefix) ? bodyName.slice(prefix.length) : bodyName
}
/**
 * 视锥拾取代理（DEV-038）：顶点→end 四角的锥面（不可见 mesh）——线框本身太细难点，
 * 与批注 `pick` mesh 同套路。`userData.cameraRigKey` 是点选归属。
 */
function rigPickMesh(geometry: FrustumGeometry): THREE.Mesh {
  const apex: number[] = [0, 0, 0]
  const [a, b, c, d] = geometry.endCorners
  const buffer = new THREE.BufferGeometry()
  buffer.setAttribute("position", new THREE.Float32BufferAttribute([
    ...apex, ...a, ...b, ...apex, ...b, ...c, ...apex, ...c, ...d, ...apex, ...d, ...a,
  ], 3))
  buffer.computeVertexNormals()
  return new THREE.Mesh(buffer, new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }))
}
/** 沿 parent 链剔除不可见对象（隐藏的 MJCF 碰撞 geom）与碰撞线框 helper，选择与放置都只认落在可见视觉面的首个命中。 */
function firstVisibleHit(intersects: THREE.Intersection[]): THREE.Intersection | undefined {
  return intersects.find(candidate => {
    let object: THREE.Object3D | null = candidate.object
    while (object) {
      if (!object.visible || object.userData.collisionHelper) return false
      object = object.parent
    }
    return true
  })
}
function applyTransform(object: THREE.Object3D, transform: Transform): void { object.position.fromArray(transform.position); object.quaternion.fromArray(transform.quaternion); object.scale.fromArray(transform.scale) }
/**
 * 给一份**来自 GLTF 缓存**的可视对象（以及它的坐标包装）打标：几何/材质/贴图归缓存所有。
 *
 * 为什么需要这个标记：同一个 GLB 被 N 个实体引用时，N 个克隆共享同一批几何/材质/贴图实例。
 * 任何一个实体离开画面时若无条件 `dispose()`，其余实例下一帧就得把整份顶点数据重新上传
 * （three 会自愈，但复用不复存在，"200 个实例共用一份几何"就是假的）。标记在克隆自己身上，
 * 不写进缓存对象，缓存里的东西永远只有 Viewer 一个所有者。
 */
function markSharedVisual(object: THREE.Object3D): void {
  object.traverse(node => { node.userData.sharedVisual = true })
}

/**
 * 被引用的纹理槽（ENV-24：贴图要靠 UV 才贴得上）。
 *
 * 判据只看两件真事实，不猜：① 材质上这些槽里有没有纹理被引用；② 几何有没有对应通道的 UV 属性
 * （`channel` 0/1/2/3 → `uv`/`uv1`/`uv2`/`uv3`，即 glTF 的 `TEXCOORD_0..3`；纹理 `channel` 为负 =
 * 导出器写的 glTF `texCoord:-1`，表示**没有可用的 UV 集**，同样贴不上）。两个都成立才算缺失——
 * 没有纹理的纯色材质不该被点名（负对照 B：去贴图时这条警告必须不出现）。
 */
function textureUvWarnings(root: THREE.Object3D): string[] {
  const slots = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'displacementMap', 'specularMap'] as const
  const attributes = ['uv', 'uv1', 'uv2', 'uv3'] as const
  const warnings: string[] = []
  root.traverse(item => {
    if (!(item instanceof THREE.Mesh)) return
    const materials = Array.isArray(item.material) ? item.material : [item.material]
    for (const material of materials) {
      if (!material) continue
      const row = material as unknown as Record<string, THREE.Texture | null>
      for (const slot of slots) {
        const texture = row[slot]
        if (!texture || !(texture as THREE.Texture).isTexture) continue
        const channel = (texture as THREE.Texture & { channel?: number }).channel ?? 0
        const meshName = item.name === '' ? item.geometry?.name ?? '网格' : item.name
        if (channel < 0) {
          warnings.push(`VIEWER_TEXTURE_WITHOUT_UV: 材质「${material.name || '未命名'}」的 ${slot} 贴图带 texCoord=${channel}（没有可用 UV 集），几何「${meshName}」贴不上贴图，画面只显示基色`)
          continue
        }
        const attribute = attributes[channel]
        if (attribute && item.geometry?.getAttribute(attribute)) continue
        warnings.push(`VIEWER_TEXTURE_WITHOUT_UV: 材质「${material.name || '未命名'}」引用了 ${slot} 贴图，但几何「${meshName}」没有 ${attribute ? `TEXCOORD_${channel}（${attribute}）` : `texCoord=${channel} 对应的 UV 通道`}：画面只显示基色（导出侧 losses 会用同一口径指出这一点）`)
      }
    }
  })
  return [...new Set(warnings)]
}

/** 一棵子树里真实要画的三角形数（带索引按索引算）。报告里给的是这个数，不是配置里写的面数。 */
function meshTriangles(object: THREE.Object3D): number {
  let triangles = 0
  object.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return
    const index = node.geometry.index
    triangles += (index ? index.count : node.geometry.attributes.position?.count ?? 0) / 3
  })
  return Math.round(triangles)
}
/** 对象在**所属 group 局部坐标**里的包围盒中心（LOD 的距离参照点）。空包围盒退回原点，不抛错。 */
function localCenterOf(object: THREE.Object3D, group: THREE.Group): THREE.Vector3 {
  group.updateWorldMatrix(true, false)
  const box = new THREE.Box3().setFromObject(object)
  if (box.isEmpty()) return new THREE.Vector3()
  return group.worldToLocal(box.getCenter(new THREE.Vector3()))
}
function disposeObject(object: THREE.Object3D): void {
  object.traverse(child => {
    // 共享可视对象整棵子树跳过：它们的所有者是 GLTF 缓存（Viewer 销毁时统一释放）。
    if (child.userData.sharedVisual === true) return
    if (!(child instanceof THREE.Mesh) && !(child instanceof THREE.LineSegments)) return
    if (child.geometry) child.geometry.dispose()
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) material?.dispose()
  })
}
/**
 * 释放一份缓存 GLTF 的几何/材质/贴图——**Viewer 销毁时**才调用（缓存是它们唯一的所有者）。
 * 纹理要单独释放：three 的 `material.dispose()` 不释放材质引用的贴图。
 */
function disposeGltfSource(gltf: GLTF): void {
  const textures = new Set<THREE.Texture>()
  gltf.scene.traverse(child => {
    if (!(child instanceof THREE.Mesh)) return
    child.geometry?.dispose()
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      if (!material) continue
      for (const value of Object.values(material as unknown as Record<string, unknown>)) if (value instanceof THREE.Texture) textures.add(value)
      material.dispose()
    }
  })
  for (const texture of textures) texture.dispose()
}
