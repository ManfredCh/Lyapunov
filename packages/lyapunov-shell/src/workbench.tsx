import {requireFullJointTargets,jointTargetError} from "./joint-target-input.tsx"
import {controlGestureKey,upsertControlActionRow,type ControlGestureDisplay} from "./control-gesture.ts"
import {useEffect,useLayoutEffect,useMemo,useRef,useState,useCallback,useSyncExternalStore} from "react"
import type {ReactNode,DragEvent} from "react"
import type {DesktopBridge} from "../../desktop/src/bridge.ts"
import {importLocalFiles,localDropIsImport,localImportPathFromReceipt,DEFAULT_LOCAL_SOURCE_TEXTURE_POLICY,localImportUsageDefault,type LocalImportPhysicsUsage} from "./local-file-import.ts"
import {ImportPurposeChoice} from './import-purpose-choice.tsx'
import type {ResourcePhysicsProgress} from './physics-binding-settings.ts'
import {importLocalPolicy,type LocalPolicyImportReceipt} from './local-policy-import.ts'
import {physicalTestSpaceOf,physicalTestWorldInput,physicalTestMissingCapabilities} from "./physics-test-space.ts"
import {SceneWorldLifecycle,worldLifecycleState,measuredJointTargets,type SceneWorldState} from './scene-world-lifecycle.ts'
import {sceneEditTarget,sceneNodeRole} from '../../lyapunov-contracts/src/scene-edit-target.ts'
import {SceneWorldStatus,sceneWorldPhaseLabel} from './scene-world-status.tsx'
import {WorldPhysicsPanel} from './world-physics-panel.tsx'
import {SceneCreationActions,createSceneFromTemplate,createSceneCreationAction,type SceneCreationTemplate} from './scene-creation.tsx'
import {WorkbenchMessage} from './status-message.tsx'
import {PhysicsControls} from './physics-controls.tsx'
import {AnimationControls,applyAnimationDisplay,type AnimationDisplaySummary} from './animation-controls.tsx'
import {runPhysicsMutation,type PhysicsUpdateInput,type PhysicsBindInput} from './entity-physics.ts'
import {collisionRequestSelection} from '../../viewer/src/collision-selection.ts'
import { cameraAdjustFromDrag, fovyFromLens, frustumFromReceipt } from "../../viewer/src/camera-frustum.ts"
import type {EngineProvidersPayload} from "./engine-provider-contract.ts"
import { pairDocumentAssets } from "../../viewer/src/asset-locator.ts"
import type {Entity,ResourceRef,SceneCommit,SceneSnapshot,WorldHandle,Frame,ActionReceipt,Transform,Vec3} from "../../lyapunov-contracts/src/types.ts"
import type {RobotDescription,EntityMotion,WorldOptions} from "../../sim-contract/src/index.ts"
import {createViewer,projectSceneCameraRigs,WebGLUnavailableError,type SceneViewer,type ViewerDisplaySettings,type ViewerViewState,type CollisionTopologyStatus,type ViewerAnnotation,type ViewerAnnotationAnchor} from "@lyapunov/viewer/client"
import {workbenchAPI,bindControlExitState,type AssetRecord,type BuiltinAssetRecord,type MissingAssetRecord,type MissingAssetRescan,type CaptureRecord,type SceneVersion,type WorkbenchState,type HistoryEntryRecord,type SessionHistoryState,type SessionHistoryPrecheck,type SessionHistoryRestore} from "./workbench-api.ts"
import {captureForObserver as captureForObserverAction,createObserverActionGuard} from "./workbench-observe.ts"
// 相机（应用指定相机 / 按指定相机出图）与命名相机：判定与采集共用一份实现，这个文件只做"接线 + 控件"。
// 命名相机是**场景内容**（实体组件 viewerCamera）：读的是场景快照，写的是同一个 `updateScene`（scene_edit + CAS），
// 界面按钮与模型工具（viewer_camera_apply 的 name/saveAs）走的就是这一条原生命令。
import {applyCameraToWindow,composeViewerCameraComponent,namedCamerasOfScene,observeCameraForAgent as observeCameraForAgentAction,renderCameraForAgent as renderCameraForAgentAction,withNamedCamera,withoutNamedCamera,type NamedCamera} from "./workbench-camera.ts"
import {cameraDraftFromRigEdit,sampleCameraForAuthoring,type CameraAuthoringViewer,type CameraExitBridge} from './camera-authoring.ts'
import {cameraDraftOfScene,type CameraSceneSaveInput} from './camera-installation.ts'
import {applyCameraNavigation,enterSavedCameraView,isCameraNavigationAction,settleSceneCameraLoad,type CameraNavigationInput} from './camera-navigation-actions.ts'
import {workbenchStyle} from "./workbench-style.ts"
import {appSidePanelHost,appSidePanelGeometry} from "./app-side.ts"
import {ViewerOverlays,ViewerSurfaceState} from "./viewer-surface-state.tsx"

import {EntityEditor,type Translate} from "./entity-editor.tsx"
import {RobotControlPanel,ActionCards,type RecentAction,type NativeJointResult} from "./robot-control-panel.tsx"
import {RobotAuthoringPanel} from "./robot-authoring-panel.tsx"
import type {RobotSetBaseInput,RobotSetTcpInput} from "../../lyapunov-contracts/src/robot-authoring.ts"
import {FlightControlPanel} from "./flight-control-panel.tsx"
import {RecordingPanel} from "./recording-panel.tsx"
import {CapturePanel,cameraRigSpecs} from "./capture-panel.tsx"
import {CameraAimControl,CameraReturnControl,SceneCameraPanel,useNativeCameraList} from "./scene-camera-panel.tsx"
import {AnnotationPanel,type AnnotatedCapture} from "./annotation-panel.tsx"
import {annotationPromptText,annotationRows,createAnnotation,readAnnotations,writeAnnotations} from "./annotation-store.ts"
import {ToolRail} from "./tool-rail.tsx"
import {WorkbenchIcon} from "./vendor/tabler/icons.tsx"
import {AssetLibraryPanel,AssetPlacementBar,assetPlacementInput,assetPlacementOf,DomainAssetList,type AssetPlacement} from "./asset-library-panel.tsx"
import {SceneNodeLock,sceneNodeName,infiniteGround,lockCommit,SceneNodeVisibility,SceneRemovalConfirmation,assetSceneInstances,removeSceneNodeCommit,sceneSubtreeIds,visibilityCommit,type SceneRemovalTarget} from "./scene-node-controls.tsx"
import {PackLibraryPanel} from "./pack-library-panel.tsx"
import {PolicyLibraryPanel} from "./policy-library-panel.tsx"
import {EnvironmentPanel,type EnvironmentPatch,type EnvironmentStatus} from "./environment-panel.tsx"
import {WorkSurface,type WorkbenchRenderSlot} from "./work-surface.tsx"
import {surfaceDisposition,useWorkbenchUI,TOOL_PANEL_WIDTH,type ToolId} from "./workbench-ui.ts"
// openResource 回执判据（与宿主 `plugin.ts` 共用同一份纯函数，防两边漂移出假成功）。
import {openReceiptVerdict} from "./ui-action-open.ts"
import {useEnginePreference} from "./engine-preference-client.ts"
import {settleStoppedActions} from "./action-state.ts"
import {applySceneIfCurrent,runRestoreFollowthrough} from "./workbench-import.ts"
import {adoptWorldHandle,isStaleStateResponse,projectionWorldLanded} from "./workbench-state-order.ts"
import {sameWorldBinding} from "./workbench-batch-binding.ts"
const savedCameraViews=new Map<string,ViewerViewState>()
const WORKBENCH_STATE_POLL_MS=250
export const VIEWER_NAVIGATION_HELP={zh:"漫游模式：右键拖动环顾，点画面后 WASD 移动，Q 下降 / E 上升，按住 Shift 加速 5 倍；Esc 切换环绕。",en:"First-person mode: right-drag to look, click the canvas then WASD to move, Q down / E up, hold Shift for 5x speed; Esc switches to orbit."} as const
const initialDisplay:ViewerDisplaySettings={grid:true,axes:true,background:"#191d25",wireframe:false,splats:true,collision:true}
function readCache(key:string):{sceneId?:string;worldId?:string;hostInstanceId?:string;selectedEntityId?:string}{try{return JSON.parse(sessionStorage.getItem(key)??"{}")}catch{return {}}}
/** 机器人判定：关节/控制器映射，或带关节名的引擎映射；官方投影里地板/桌子的 mujoco 映射没有关节，不算机器人。 */
const robotEntity=(entity:Entity):boolean=>{
 const components=entity.components as Record<string,unknown>,mujoco=components.mujoco as {jointNames?:unknown}|undefined
 return Boolean(components.articulation||components.controller||(mujoco&&Array.isArray(mujoco.jointNames)&&mujoco.jointNames.length>0))
}
/** 公开环境资产候选（scene_environment_search 的返回项；只用于展示与选择，不下载）。 */
interface EnvironmentCandidate{assetId:string;name:string;categories:string[];tags:string[];authors:string[];license:string;pageUrl:string;thumbnailUrl?:string;downloadCount?:number}
/** 候选的真实下载事实（scene_environment_detail）：下载前核对，不据此断定"是完整环境"。 */
interface EnvironmentDetail{assetId:string;name:string;categories:string[];tags:string[];authors:string[];resolution:string;license:string;pageUrl:string;totalBytes:number;sizeM:[number,number,number];triangles:number;meshes:number;materials:number;images:number;downloads:Array<{name:string;bytes:number}>;note:string}

// 以下三个是这个文件里**唯一**一处把资产定位符交到 Viewer 手里的地方：判定与回写共用同一份实现。
const assetRows=(value:unknown):Array<Record<string,unknown>>=>value===undefined||value===null?[]:Array.isArray(value)?value as Array<Record<string,unknown>>:[value as Record<string,unknown>]
/** 回写读数（只读探针读它；产品逻辑不读）。`skipped`＝文档里有引用却**没能**配上标记的条数，如实登记不静默。 */
export interface AssetLocatorRewiring{entities:number;meshes:number;textures:number;skipped:number}
/**
 * 换过定位符之后 `baseUri` 的替身：**不透明**（没有可解析的相对基准）。
 * 换过的定位符都带 scheme（`res:<指纹>` 或绝对 URI），`new URL(标记, 哨兵)` 返回标记自身；
 * 相对定位符在这种基址上**照旧抛错**（与今天同一条失败路径）——不静默改变语义。
 */
const OPAQUE_ASSET_BASE="res:unresolved"
const parsableURL=(value:unknown):boolean=>{if(typeof value!=="string"||!value)return false;try{new URL(value);return true}catch{return false}}
/**
 * DEV-034：**交给 Viewer 的场景，资产引用必须还是产品自己的媒体定位符。**
 *
 * 为什么需要这一层：场景在到达浏览器之前会过一遍出站投影（`plugin.ts` 的 `state`/`scene` 路由 →
 * `lyapunov-contracts/src/product-paths.ts:projectPathsOnly`），把定位符换成产品自己的两种引用——
 * `uri` 键与 `file:` 字符串 → 媒体标记 `res:<指纹>`（不可逆），登记域内绝对路径 → `<域>/<相对>`。
 * 这对 Viewer 的**资源路径**（`resources[].representations[].uri` → `resolveResource`）正好合用；
 * 但机器人视觉是**文档内引用**：`viewer/src/robot.ts` 用 `documentReferenceLocator(file, baseUri)`
 * 解析 `visual.robot.document.asset.{mesh,texture}[].file`，而 `baseUri` 已变成 `res:<指纹>`、`file`
 * 已变成域引用 ⇒ 相对引用再也解析不出绝对位置（19:07 之前那版 `new URL(file, baseUri)` 是当场抛
 * `TypeError: Invalid URL`）⇒ 贴图与网格全部回落基色（DEV-034 的"包装和地板退化成纯色"就是这个形状）。
 * **这一层把每条资产引用换回同一份资产的媒体标记**：标记是媒体路由的既有准入货币
 * （`admitResourceToken` 对着该 Scene 的已授权候选集等值匹配），所以既不还原绝对路径（隐私口径不变），
 * 也不需要第二套加载器、不需要跨包改动。
 *
 * 配对判据**不在这个文件里**：唯一一份是 `viewer/src/asset-locator.ts` 的 `pairDocumentAssets`
 * （生产者对每个实体写的是 `representations = [派生 XML] + [逐 mesh 一条] + [逐 texture 一条]`，
 * 且 `document.asset.{mesh,texture}[i].file` 与 `components.mujoco.{meshes,textures}[i].file` **逐字相等**；
 * 条数、段位 mimeType、逐字符串相等三条判据都写在那一个函数里）。这里只把它的结果摊成
 * 「文档引用串 → 媒体标记」的 Map —— 接线层与它**同源**，不再有第二份判定。
 */
export function assetLocatorTokens(entity:Entity):Map<string,string>{
 const tokens=new Map<string,string>()
 for(const row of pairDocumentAssets(entity))tokens.set(row.file,row.uri)
 return tokens
}
/** 交给 Viewer 的那一份场景 + 本次回写读数。原场景不被改写：只沿被改写的路径复制。 */
export function prepareViewerScene(scene:SceneSnapshot):{scene:SceneSnapshot;rewiring:AssetLocatorRewiring}{
 const rewiring:AssetLocatorRewiring={entities:0,meshes:0,textures:0,skipped:0}
 let changed=false
 const entities=scene.entities.map(entity=>{
  const visual=entity.components.visual as {kind?:string;robot?:Record<string,unknown>}|undefined,document=visual?.robot?.document as {asset?:Record<string,unknown>;compiler?:Record<string,unknown>}|undefined,asset=document?.asset
  if(visual?.kind!=="robot"||!document||!asset)return entity
  const tokens=assetLocatorTokens(entity),nextAsset:{[key:string]:unknown}={...asset},compiler=document.compiler??{}
  // `viewer/src/robot.ts` 会按 `compiler.<dir>` 给引用加前缀（`prefix + "/" + file`）。有前缀的文档
  // 说明引用本来就是相对路径，换成标记会被拼成不认识的字符串 ⇒ 这一组不动，如实计入 `skipped`。
  const prefix=(key:"mesh"|"texture"):string=>{const value=key==="mesh"?compiler.meshdir??compiler.assetdir:compiler.texturedir??compiler.assetdir;return typeof value==="string"?value:""}
  let entityChanged=false
  for(const [key,counter] of [["mesh","meshes"],["texture","textures"]] as const){
   const source=asset[key],values=assetRows(source)
   if(!values.length)continue
   let groupChanged=false
   const mapped=values.map(value=>{
    const file=typeof value.file==="string"?value.file:"",token=file&&!prefix(key)?tokens.get(file):undefined
    if(!token){rewiring.skipped++;return value}
    // **只写纯标记 `res:<指纹>`**（P3-WIRING-REWORK）：一个后缀都不加。
    // 依据是 HEAD 的消费侧语义——`robot.ts` 按**登记声明的 mimeType** 分派装载器（`assetFormatOf`），
    // 而 `asset-locator.ts:80` 对 `res:` 开头的定位符**一律**返回 undefined，所以 `?ext=` 从来参与不了
    // 分派；反过来它会把 `pairDocumentAssets` 的**直接命中**（`file === rep.uri`）与顺序配对
    // （镜像里是没被改写的原引用）两条路一起打断 ⇒ 声明表整张落空、每条网格 UNSUPPORTED。
    // 实测（真文档 + 真函数）：纯标记 `声明 90 / UNSUPPORTED 0`，`?ext=` 后缀 `声明 0 / UNSUPPORTED 82`。
    rewiring[counter]++;groupChanged=true;entityChanged=true
    return {...value,file:token}
   })
   // 单条资产的容器形状保持原样（解析器给单个 `<texture>` 时是对象、多个时是数组）。
   if(groupChanged)nextAsset[key]=Array.isArray(source)?mapped:mapped[0]
  }
  if(!entityChanged)return entity
  rewiring.entities++;changed=true
  const robot:Record<string,unknown>={...visual.robot,document:{...document,asset:nextAsset}}
  if(!parsableURL(robot.baseUri))robot.baseUri=OPAQUE_ASSET_BASE
  return {...entity,components:{...entity.components,visual:{...visual,robot}}}
 })
 return {scene:changed?{...scene,entities}:scene,rewiring}
}
/**
 * Viewer 递回来的资产定位符 → 媒体路由的 `uri` 查询值。
 * 本层现在只写纯标记 `res:<指纹>`，所以这个函数对**本层自己的产出是恒等**（标记原样交给
 * `mediaURL("resource",{uri})`，媒体路由按标记在已授权候选集里等值匹配）。
 * 保留它只为兜住历史形状 `res:<指纹>?ext=.xxx`（19:07 之前那两版前端产物写过它）；其余定位符
 * （实体资源的 `res:<指纹>`、绝对路径、域引用）一律原样透传。**产品路径上它现在是一条空转**，
 * 见回执 `P3-WIRING-REWORK-20260926.md` 的未覆盖/待裁一节。
 */
export function viewerResourceURI(uri:string):string{return /^(res:[^?#]+)\?ext=\.[A-Za-z0-9]+$/.exec(uri)?.[1]??uri}

/** 一条要显示的事实：`tone` 决定颜色（`warn` 走既有 `.lya-warning`），`key` 既是 React key 也是测试锚点。 */
export interface WorkbenchFactLine { key:string; tone:"warn"|"muted"; zh:string; en:string }
/**
 * 内部标识 → **用户话**（D1 文案层，USER-VISIBLE-WORDING-20260927）。
 *
 * 为什么有这一层：宿主投影过来的 `refusals[].tool`/`code`/`rule`、`lastReport.reason`、`since`/`at`
 * 全是**机器字**（驱动工具名 `cua_driver_native__<动词>`、`CUA_*` 错误码、rule id、
 * `idle`/`host-unload`/`consent-revoked`/`explicit:<会话>`、裸 ISO 时间戳）。照抄进用户那句话，就等于
 * 让用户去读内部枚举 —— 只读复核 `VERIFY-USERFIX-20260927` §二之5 逐条抓到的正是这件事
 * （唯一告诉用户"你的输入被拒了"的第 3 句里塞了 3 个内部标识）。⇒ 措辞在这里翻成人话。
 *
 * **判据一条没放宽**：被拒的条数与次数、哪个动作、为什么、涉及哪些按键、恢复失败哪几项、
 * 可见指示状态，全部照旧出现在同一行里（钉在 `test/computer-use-wording.test.tsx`）。
 *
 * 三条边界（都不许越）：
 *   · 认不出来的取值**不照抄原文**：宁可说"这台工作台不认识"，也不把内部枚举贴到用户面前；
 *   · 这张表**不是**"换一种机器字"（不是把 `CUA_INPUT_REFUSED` 写成 `input-refused`）——
 *     目标语言是用户读得懂的话；
 *   · **`lastReport.note` 与 GNOME 键名不进这张表**：前者是 `原话：` 之后的**逐字引用**（不许改写），
 *     后者（`screen-reader-enabled` 等）是系统里真实存在的键名，译掉用户就没法去系统设置/`gsettings` 查改。
 */
const CUA_REFUSED_ACTION_TEXT:Record<string,{zh:string;en:string}>={
 click:{zh:"点一下鼠标左键",en:"a left mouse click"},
 double_click:{zh:"双击鼠标左键",en:"a left mouse double-click"},
 right_click:{zh:"点一下鼠标右键",en:"a right mouse click"},
 drag:{zh:"拖动（按下鼠标并移动）",en:"a mouse drag"},
 move_cursor:{zh:"移动鼠标指针",en:"a mouse-pointer move"},
 type_text:{zh:"代你敲字",en:"typing text for you"},
 press_key:{zh:"按下一个键",en:"a key press"},
 hotkey:{zh:"按一组组合键",en:"a key combination"},
 scroll:{zh:"滚动",en:"a scroll"},
 browser_dialog:{zh:"操作浏览器对话框",en:"a browser dialog action"},
 mouse_button_down:{zh:"按住鼠标键不放",en:"holding a mouse button down"},
 mouse_button_up:{zh:"松开鼠标键",en:"releasing a mouse button"},
 mouse_drag:{zh:"按住鼠标拖动",en:"dragging with the mouse button held down"},
 parallel_mouse_drag:{zh:"同时拖动多个鼠标指针",en:"dragging several mouse pointers at once"},
 set_value:{zh:"往别的应用的控件里写值",en:"writing a value into another app's control"},
 invoke_menu:{zh:"点下应用菜单里的一项",en:"clicking an item in an app menu"},
 browser_click:{zh:"在浏览器页面里点击",en:"a click inside a browser page"},
 browser_type:{zh:"往浏览器页面里打字",en:"typing into a browser page"},
 browser_pointer:{zh:"在浏览器页面里操作指针",en:"a pointer action inside a browser page"},
 browser_navigate:{zh:"让浏览器打开一个地址",en:"navigating the browser to an address"},
 clipboard_write:{zh:"改写系统剪贴板",en:"a clipboard write"},
 clipboard_read:{zh:"读取系统剪贴板",en:"a clipboard read"},
 replay_trajectory:{zh:"重放一整批录制好的动作",en:"replaying a batch of recorded actions"},
 escalate_session:{zh:"把观察面扩大到整块桌面",en:"widening the session to the whole desktop"},
 install_ffmpeg:{zh:"调用系统包管理器装软件包",en:"installing a system package"},
 kill_app:{zh:"强制结束一个进程",en:"force-terminating a process"},
 set_config:{zh:"改驱动的持久配置",en:"changing the driver's persistent configuration"},
 set_window_frame:{zh:"改窗口的位置和大小",en:"changing a window's position or size"},
 bring_to_front:{zh:"把窗口强行置前、抢走焦点",en:"forcing a window to the front and taking focus"},
 browser_download:{zh:"把网上的内容下载到你的磁盘",en:"downloading content to your disk"},
 browser_prepare:{zh:"把浏览器调试端点挂上",en:"attaching a browser debugging endpoint"},
 launch_app:{zh:"按名字启动一个程序",en:"starting a program by name"},
 page:{zh:"在你已登录的页面里执行脚本",en:"running a script in a page you are logged into"},
 get_desktop_state:{zh:"抓取整块屏幕",en:"capturing the whole screen"},
 browser_set_input_files:{zh:"把你本机的文件交给网页",en:"handing local files to a web page"},
}
/** 驱动工具名 → 用户话里的**动作**。取最后一个 `__` 之后那一段，不把命名空间字面量硬编码进界面。 */
export function computerUseActionText(tool:string):{zh:string;en:string}{
 const cut=tool.lastIndexOf("__"),raw=cut<0?tool:tool.slice(cut+2)
 return CUA_REFUSED_ACTION_TEXT[raw]??{zh:"有一次输入动作",en:"an input action"}
}
/** rule id → 用户话：**为什么被拒**与**用户能怎么办**写在同一句里（当前 33 个产品 rule id 的取值域见 `computer-use-input.ts` 与 `plugin.ts`；认不出来的走兜底）。 */
const CUA_REFUSAL_REASON_TEXT:Record<string,{zh:string;en:string}>={
 "desktop-scope-refused":{zh:"这次调用选择了整个桌面，已拒绝；请只操作明确的窗口",en:"this call selected the whole desktop and was refused; select an exact window"},
 "foreground-delivery-refused":{zh:"这次调用要求占用前台焦点，已拒绝；请使用后台窗口操作",en:"this call requested foreground focus and was refused; use background window delivery"},
 "desktop-discovery-refused":{zh:"这次调用会遍历整个桌面或应用清单，已拒绝；请限定本任务进程",en:"this call would enumerate the desktop or all apps and was refused; limit discovery to the task process"},
 "window-scope-required":{zh:"这次观察缺少明确的进程或窗口目标，已拒绝",en:"this observation has no exact process or window target and was refused"},
 "global-needs-consent":{zh:"这次输入没有指定窗口，会打进你的整个桌面，而你还没有同意过这类全局输入；要放行得由你在工作台里显式同意（同意之后还得有可见提示才会真的发）",en:"this input names no window, so it would land on your whole desktop, and you have not given consent for such global input; to let it through you would consent explicitly in the workbench (and even then it is only sent while the visible notice is up)"},
 "global-needs-indicator":{zh:"你已经同意过全局输入，但此刻屏幕上没有「正在控制输入」的可见提示；要放行得先让这个提示亮起来",en:"you did give global-input consent, but no visible 'agent is controlling input' notice is on screen right now; it is only sent once that notice is up"},
 "clipboard-not-restorable":{zh:"它要改写你的系统剪贴板，而剪贴板被换掉之后没法还原；要让内容进剪贴板请你自己复制",en:"it would replace your system clipboard, and there is no way to restore what was there; copy it yourself to put something on the clipboard"},
 "clipboard-read-not-disclosable":{zh:"它要读取你的系统剪贴板；剪贴板里可能是密码或私信，读走就进了 agent 的上下文和会话记录，而你看不见也撤不回；要让 agent 看到某段文字请你自己把它贴进对话",en:"it would read your system clipboard, which may hold passwords or private messages; once read it sits in the agent's context and the session log, where you cannot see or take it back; paste the text into the conversation yourself instead"},
 "a11y-screen-reader":{zh:"这组键在你的桌面上是「开关屏幕阅读器」，会被合成按键突然打开并开始朗读；这个开关请你自己在系统「设置 → 无障碍」里改",en:"on your desktop that key combination toggles the screen reader, so it would start reading out loud; switch it yourself under system Settings → Accessibility"},
 "a11y-magnifier":{zh:"这组键在你的桌面上是「开关屏幕放大镜」，会改变你整个桌面的观感；这个开关请你自己在系统「设置 → 无障碍 → 缩放」里改",en:"on your desktop that key combination toggles the screen magnifier and changes how your whole desktop looks; switch it yourself under system Settings → Accessibility → Zoom"},
 "a11y-sticky-keys":{zh:"它只发了一个修饰键（单独或叠加），在你的桌面上会触发粘滞键/慢键这类无障碍功能，而且对窗口没有任何输入意义；要按住修饰键做组合输入，请把整组键一次性交给 agent 自己的窗口",en:"it sends a bare modifier key on its own, which on your desktop triggers accessibility features such as sticky keys or slow keys and means nothing to any window; hand whole key combinations to the agent's own window instead"},
 "media-keys":{zh:"这是静音/音量/亮度/睡眠这类媒体键，桌面或硬件会直接处理，会改你的音量、亮度甚至让机器挂起；这类效果请你自己按键",en:"this is a media key (mute/volume/brightness/sleep) handled directly by the desktop or the hardware, so it would change your volume or brightness or even suspend the machine; press it yourself"},
 "ime-switch":{zh:"这组键会切换你的输入法或键盘布局，之后你打的字会变成另一种布局；输入法切换请你自己来，文字输入请改用往 agent 自己的窗口里送文本",en:"that key combination switches your input method or keyboard layout, so what you type afterwards comes out in another layout; switch it yourself, and send text into the agent's own window instead"},
 "wm-window-switch":{zh:"这是窗口管理器的全局快捷键，会被桌面在窗口之前截走，动的是你自己的窗口（切换/移动/缩放/关闭）；要在 agent 自己的窗口之间切换请用应用内的操作，或你自己按",en:"this is a window-manager global shortcut, grabbed by the desktop before any window sees it, and it acts on your windows (switch/move/resize/close); use in-app actions to move between the agent's own windows, or press it yourself"},
 "accessx-toggle":{zh:"这类键改的是系统键盘控制位（粘滞键/慢键/鼠标键/大写锁定这一类），本机改前改后都抓不到原值、也就没法还原；无障碍键盘功能请你自己在系统「设置 → 无障碍 → 输入辅助」里开",en:"this key changes system-level keyboard control bits (sticky keys, slow keys, mouse keys, caps lock and the like) that this host can neither snapshot nor restore; turn accessibility keyboard features on yourself under system Settings → Accessibility → Typing Assist"},
 "vt-switch-and-desktop":{zh:"这是 Ctrl+Alt+… 这类系统级组合键，会切走你的整个图形会话/桌面；这类系统级动作请你自己执行",en:"this is a system-level Ctrl+Alt+… combination that can switch your whole graphical session away; run system-level actions yourself"},
 "super-combos":{zh:"组合里带 Super（Win/Cmd）键，会被你的桌面先截走（锁屏、通知、活动概览、输入法…），根本到不了 agent 自己的窗口；请改用应用内的等价操作，或你自己按",en:"the combination contains Super (Win/Cmd), which your desktop grabs first (lock screen, notifications, overview, input method …) so it never reaches the agent's own window; use the equivalent in-app action, or press it yourself"},
 sysrq:{zh:"这是 SysRq/PrintScreen 这类由内核或桌面全局处理的键（SysRq 组合甚至能重启或杀进程）；要截图请用 agent 自己的采集通道",en:"this is SysRq/PrintScreen, handled globally by the kernel or the desktop (a SysRq combination can even reboot or kill processes); use the agent's own capture channel for screenshots"},
 unparsable:{zh:"这次按键写法本机解析不出来，也就没法证明它只会进 agent 自己的窗口；请改成认得出来的写法（例如 ctrl+c、Return）",en:"this host cannot parse the key notation, so it cannot prove the keys would only reach the agent's own window; use a notation it understands (for example ctrl+c, Return)"},
 "key-field-unusable":{zh:"这次调用没有给出要按的键（键字段缺失、不是字符串，或者是空的），所以发不出去",en:"this call named no key to press (the key field is missing, is not a string, or is empty), so nothing could be sent"},
 "drag-moves-user-window":{zh:"在这台机器上，按住这个修饰键拖动会移动你自己的窗口，而不是 agent 窗口里的内容；拖动要选择/拖放请用 shift 或 ctrl 作修饰键，移动窗口请你自己拖",en:"on this machine, dragging with that modifier moves one of your own windows instead of content inside the agent's window; use shift or ctrl to select or drop by dragging, and move windows yourself"},
 "not-an-input-tool":{zh:"它不是 computer-use 的输入动作，本机不做判定",en:"it is not a computer-use input action, so this host makes no ruling on it"},
 "session-unavailable":{zh:"桌面临时设置的快照读不到，这次输入没有可恢复的依据，所以不发",en:"the desktop-settings snapshot is unavailable, so there would be nothing to restore afterwards and the input is not sent"},
 "driver-tool-unclassified":{zh:"这个工具名不在本机认识的驱动工具清单里（多半是驱动升级或改名新增的），本机没有它的判据，因此默认不发；要用它得先把它登记清楚",en:"this tool name is not among the driver tools this host knows (most likely added or renamed by a driver upgrade), so this host has no ruling for it and does not send it by default; it has to be classified before it can be used"},
 "trajectory-replay-bypasses-input-guard":{zh:"它会把一整批录制好的动作按驱动自己的通道重放出去，每一步都绕开本机的判定（作用域与全局快捷键拒绝清单都不生效）；要让 agent 重做某串动作，请把动作作为普通调用逐个发出来",en:"it would replay a whole batch of recorded actions through the driver's own dispatch path, bypassing this host's checks at every step (scope and the global-shortcut refusal list would not apply); have the agent send each action as an ordinary call instead"},
 "capture-escalation-not-reversible":{zh:"它会把观察面从一个窗口扩大到整块桌面，而驱动那边没有收回来的通道（扩出去就收不回）；要做桌面范围的动作，请你在会话里显式同意并按动作粒度指名目标",en:"it would widen the observed surface from one window to the whole desktop, and the driver has no way to narrow it back; for desktop-scoped actions, consent explicitly in the session and name the target per action"},
 "dependency-install-not-reversible":{zh:"它会真的调用系统包管理器装软件包，改的是你机器的系统状态，装完没有可信的还原；需要的软件请你自己装",en:"it would actually run your system package manager, changing your machine with no trustworthy way back; install what you need yourself"},
 "process-termination-not-reversible":{zh:"它等价于强制结束进程（未保存的内容会直接丢，结束了就回不来）；要关掉某个应用请你自己关",en:"it is equivalent to force-killing a process (unsaved work is lost and cannot be recovered); close the application yourself"},
 "driver-config-not-restorable":{zh:"它改的是驱动的持久配置（会落盘保存），本机没有改前的原值，改错恢复不了，而它改的正是采集范围这类隐私姿态；这类设置请在产品配置面里改",en:"it would change the driver's persistent configuration (written to disk) with no before-image kept, and what it changes is the capture posture; change settings like that through the product's own settings instead"},
 "window-frame-not-restorable":{zh:"它会改你窗口的位置和大小，而驱动只回读「改成了没有」、没有改前的几何；窗口尺寸请你自己调整",en:"it would change your window's position and size, and the driver only reads back whether the change landed, keeping no previous geometry; resize your windows yourself"},
 "foreground-activation-not-restored":{zh:"它会把窗口强行置前，把焦点从你手里拿走而且不还回去；需要前台交付请用输入工具自己提供的做法（那一种会还原原先的活动窗口）",en:"it would force a window to the front, taking focus from you without giving it back; for foreground delivery use the input tools' own option, which restores the previously active window"},
 "browser-download-writes-user-disk":{zh:"它会把网上下载的内容写进你的磁盘，落盘就撤不回；要让某个文件到你手里，请你自己下载",en:"it would write downloaded content to your disk, and a finished download cannot be undone; download the file yourself instead"},
 "browser-prepare-exposes-devtools":{zh:"它会把浏览器的调试端点挂上（还能挂到你已经登录的那个浏览器配置上），等于页面脚本可以驱使这个浏览器；浏览器自动化请走产品自己的浏览器能力",en:"it would attach a browser debugging endpoint, possibly to the browser profile you are logged into, which lets page scripts drive that browser; use the product's own browser capability instead"},
 "app-launch-runs-arbitrary-command":{zh:"它给的名称会被当成命令直接执行，能拉起任意程序，跑起来的进程收不回来；要打开应用或文件请你自己打开",en:"the name it passes is executed as a direct command, so it can start anything and cannot take it back; open the application or file yourself"},
 "legacy-page-escape-hatch":{zh:"它是遗留的页面脚本通道，会在你已经登录的页面里跑任意脚本，只读也会把整页内容读出来；只读的页面观察请用窗口级的做法",en:"it is a legacy page-script channel that runs arbitrary scripts inside a page you are logged into, and even its read side pulls the whole page; use the window-scoped way to observe pages instead"},
 "desktop-capture-not-disclosable":{zh:"它抓的是整块屏幕——你桌面上所有窗口的像素（可能是私信、密码管理器、别人的会议画面），不是 agent 自己那个窗口；要看 agent 操作的窗口请用窗口级的观察",en:"it captures the whole screen — pixels from every window on your desktop (private messages, password managers, other people's meetings), not just the agent's own window; use the window-scoped observation instead"},
 "local-file-upload-not-disclosable":{zh:"它会把本机文件的内容直接交给一个网页（可以立刻外发），交出去就撤不回；要让 agent 处理某个文件，请你自己把文件放进工作区",en:"it would hand the contents of a local file to a web page, which can send it straight out and cannot be taken back; put the file into the workspace yourself instead"},
}
/** rule id → 用户话；认不出来的取值**不照抄内部 id**。 */
export function computerUseRefusalReasonText(rule:string):{zh:string;en:string}{
 return CUA_REFUSAL_REASON_TEXT[rule]??{zh:"它属于本机默认不代发的那一类输入",en:"it belongs to the class of inputs this host never sends on your behalf"}
}
/** 会话结束原因（`plugin.ts` 的四取值，含 `explicit:<会话>`）→ 用户话；认不出来也不照抄内部枚举。 */
export function computerUseEndReasonText(reason:string):{zh:string;en:string}{
 if(reason==="idle")return {zh:"空闲太久自动结束",en:"closed automatically after sitting unused"}
 if(reason==="host-unload")return {zh:"工作台退出时结束",en:"closed because the workbench shut down"}
 if(reason==="consent-revoked")return {zh:"你收回同意后结束",en:"closed after you withdrew consent"}
 if(reason.startsWith("explicit:"))return {zh:"由 agent 主动结束",en:"closed by the agent itself"}
 return {zh:"已结束（结束原因这台工作台不认识）",en:"closed (this workbench does not recognize the reason)"}
}
const CUA_MONTH_TEXT=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
/** ISO 时间戳 → 用户能读的**本地时间**；没给/读不出来就说人话，**不照抄裸 ISO**。 */
export function computerUseClockText(iso:string|null|undefined):{zh:string;en:string}{
 if(!iso)return {zh:"时间未记录",en:"time not recorded"}
 const at=new Date(iso)
 if(Number.isNaN(at.getTime()))return {zh:"时间读不出来",en:"time unreadable"}
 const pad=(n:number)=>String(n).padStart(2,"0"),day=`${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
 return {zh:`${at.getFullYear()}年${at.getMonth()+1}月${at.getDate()}日 ${day}（本地时间）`,en:`${at.getDate()} ${CUA_MONTH_TEXT[at.getMonth()]} ${at.getFullYear()} ${day} (local time)`}
}
/**
 * D1 判据（纯函数，渲染与测试共用**同一份**）：computer-use 会话事实 → 用户看到的那几行。空数组＝无话可说（不占位）。
 *
 * 三条事实缺一不可：①会话开着（`active`）＝"这次会话正在控制输入"，且**可见指示是不是真的亮了**（用户投诉过的
 * 就是"屏幕阅读器被打开且停不掉"）；②`lastReport.failed` ＝"会话结束恢复失败"，必须点名哪几项没写回去；
 * ③`refusals` ＝被拒的输入记录（条数＋哪个动作＋为什么＋涉及哪些键，一条不少）。
 * 措辞经上面那几张表翻成用户话；**唯一的逐字引用**是 `lastReport.note`（`原话：` 之后，不许改写）。
 */
export function computerUseNoticeLines(cu:WorkbenchState["computerUse"]):WorkbenchFactLine[]{
 if(!cu)return []
 const lines:WorkbenchFactLine[]=[],indicator=cu.indicator,visible=indicator?.visible===true
 if(cu.active){
  const since=computerUseClockText(cu.since),consent=cu.consent?`已给${cu.consentReason?`（${cu.consentReason}）`:""}`:"未给"
  lines.push({key:"active",tone:visible?"muted":"warn",
   zh:`本会话正在控制输入（computer-use 会话开始于 ${since.zh}）：可见指示${visible?"已点亮":`未点亮——你现在看不到「正在控制输入」的提示`}${indicator?.a11yStatusIcon==="unreadable"?"；无障碍状态读不到":""}；全局输入同意：${consent}`,
   en:`This session is controlling input (computer-use open since ${since.en}): the visible indicator is ${visible?"on":`OFF — you cannot see the 'agent is controlling input' notice`}${indicator?.a11yStatusIcon==="unreadable"?"; accessibility state unreadable":""}; global input consent: ${cu.consent?`given${cu.consentReason?` (${cu.consentReason})`:""}`:"not given"}`})
 }
 if(cu.lastReport){
  const report=cu.lastReport,failed=[...report.failed],at=computerUseClockText(report.at),ended=computerUseEndReasonText(report.reason)
  lines.push(failed.length
   ?{key:"restore-failed",tone:"warn",
     zh:`上次 computer-use 会话（${ended.zh}，${at.zh}）结束后，桌面恢复有 ${failed.length} 项没写回去：${failed.join("、")}。这些是系统里的设置键名（在系统「设置」里能找到对应的开关，也可以用 gsettings 按这些名字查/改）。恢复没做完，下面是系统报告的原话（逐字照录，未改写）：${report.note}`,
     en:`The previous computer-use session (${ended.en}, ${at.en}) left ${failed.length} desktop setting(s) unrestored: ${failed.join(", ")}. These are the setting key names as your system knows them (the matching switches are in system Settings, and you can look them up or change them with gsettings). The restore did not finish; the system's own report follows verbatim, unrewritten: ${report.note}`}
   :{key:"restore-ok",tone:"muted",
     zh:`上次 computer-use 会话（${ended.zh}，${at.zh}）结束后，桌面设置已全部写回（${report.restored.length} 项，无失败）。`,
     en:`The previous computer-use session (${ended.en}, ${at.en}) restored every desktop setting it changed (${report.restored.length} item(s), no failures).`})
 }
 const refusals=[...cu.refusals],last=refusals[refusals.length-1]
 if(last){
  const action=computerUseActionText(last.tool),why=computerUseRefusalReasonText(last.rule)
  const keys=last.combos.length?{zh:`；涉及的按键：${last.combos.join(" ")}`,en:`; keys involved: ${last.combos.join(" ")}`}:{zh:"",en:""}
  // 宿主只投影最近 5 条（`plugin.ts` 的 `refusals:cuaRefusals.slice(-5)`）⇒ 到上限时**不把"至少 5 次"说成"5 次"**。
  const counted=refusals.length>=5
   ?{zh:"本机记录了至少 5 次被拒的 computer-use 输入（这一行只列最近 5 条）",en:"at least 5 computer-use input(s) have been refused on this host (this line lists the last 5)"}
   :{zh:`本机记录了 ${refusals.length} 次被拒的 computer-use 输入`,en:`${refusals.length} computer-use input(s) have been refused on this host`}
  lines.push({key:"refusals",tone:"warn",
   zh:`${counted.zh}。最近一次：${action.zh}被拒（原因：${why.zh}${keys.zh}）。被拒的输入一个字节都没发到你的桌面上。`,
   en:`${counted.en}. Most recently: ${action.en} was refused (reason: ${why.en}${keys.en}). Refused inputs were never sent to your desktop — not a single byte.`})
 }
 return lines
}
/**
 * D3 判据（纯函数）：`WorldHandle` 自报读数 → 世界状态行要补的那几行。空数组＝Provider 什么都没自报（不占位）。
 *
 * 此前这些字段**整片没有产品消费方**（`.warnings`/`.deviceKind`/`.deviceDegraded`/`.deviceNote`/`.warpVersion`
 * 在 `packages/<pkg>/src` 里 0 命中，唯一的读取点是 `script/gates/g10.ts` 的门内详情串）⇒ 世界编译告警
 * （如"纯视觉实体没有碰撞体被物理装配跳过"）、设备降级、Warp 版本用户全看不到。
 */
export function worldFactLines(world:WorldHandle|undefined):WorkbenchFactLine[]{
 if(!world)return []
 const lines:WorkbenchFactLine[]=[],warnings=world.warnings??[],first=warnings[0]
 if(first)lines.push({key:"warnings",tone:"warn",
  zh:`世界编译告警 ${warnings.length} 条${warnings.length>1?`（另有 ${warnings.length-1} 条未展开）`:""}：${first.message}（${first.code}${first.entityId?` · ${first.entityId}`:""}）`,
  en:`${warnings.length} world compile warning(s)${warnings.length>1?` (${warnings.length-1} more not expanded)`:""}: ${first.message} (${first.code}${first.entityId?` · ${first.entityId}`:""})`})
 if(world.deviceDegraded)lines.push({key:"device-degraded",tone:"warn",
  zh:`设备已降级${world.device?`（${world.device}）`:""}：${world.deviceNote??"Provider 没给降级说明（deviceNote 缺省）"}`,
  en:`Device degraded${world.device?` (${world.device})`:""}: ${world.deviceNote??"the provider gave no deviceNote"}`})
 const runtimeZh=[world.device||world.deviceKind?`设备 ${world.device??"未知"}${world.deviceKind?`（${world.deviceKind}）`:""}`:"",world.solver?`求解器 ${world.solver}`:"",world.warpVersion?`Warp ${world.warpVersion}`:""].filter(Boolean)
 const runtimeEn=[world.device||world.deviceKind?`device ${world.device??"unknown"}${world.deviceKind?` (${world.deviceKind})`:""}`:"",world.solver?`solver ${world.solver}`:"",world.warpVersion?`Warp ${world.warpVersion}`:""].filter(Boolean)
 if(runtimeZh.length)lines.push({key:"runtime",tone:"muted",zh:runtimeZh.join(" · "),en:runtimeEn.join(" · ")})
 return lines
}
/**
 * D1 渲染点。**同一份判据两个挂载点**（`place` 只改锚点，不改字）：
 *  · `settings` —— 运行设置里世界状态行同一区块（审计给的落点）；
 *  · `status` —— 页面底部常驻状态区：`<details>` 折叠起来时也看得见。"正在控制输入"与"恢复失败"是**安全事实**，
 *    藏在默认折叠的区块里等于没写（这正是本报单要修的那类"写了没人看"）。
 */
export function ComputerUseFacts({computerUse,tr,place="status"}:{computerUse:WorkbenchState["computerUse"];tr:Translate;place?:"status"|"settings"}){
 const lines=computerUseNoticeLines(computerUse)
 if(!lines.length)return null
 return <div className={place==="status"?"lya-cu-status":"lya-cu-settings"} role={place==="status"?"status":undefined} data-testid={place==="status"?"lyapunov-computer-use":"lyapunov-computer-use-settings"}>
  {lines.map(line=><p key={line.key} data-cu-line={line.key} className={line.tone==="warn"?"lya-help lya-warning":"lya-help"}><span className={line.tone==="warn"?"lya-badge lya-warning":"lya-badge"}>computer-use</span> {tr(line.zh,line.en)}</p>)}
 </div>
}
/** D3 渲染点：世界状态行下面补的几行（告警条数 + 首条原文 / 设备降级原话 / 运行设备事实）。空数组＝不占位。 */
export function WorldFacts({world,tr}:{world:WorldHandle|undefined;tr:Translate}){
 const lines=worldFactLines(world)
 if(!lines.length)return null
 return <div data-testid="lyapunov-world-facts">
  {lines.map(line=><p key={line.key} data-world-line={line.key} className={line.tone==="warn"?"lya-help lya-warning":"lya-help"}>{tr(line.zh,line.en)}</p>)}
 </div>
}

export function Workbench({sessionId,t,main,renderSlot,globalPanel=false,nativeTab=false,visible=true,revealScene,openFiles,openTerminal,openResource,openHistorySession}:{
 sessionId?:string
 t:(key:"open")=>string
 /** 原生中央内容（`main.surface` 座位交过来的原生对话节点）。 */
 main?:ReactNode
 globalPanel?:boolean
 nativeTab?:boolean
 revealScene?:()=>void
 /** nativeTab 下打开原生文件标签；非 nativeTab 回退到中央文件工作面。 */
 openFiles?:()=>void
 /** 打开官方侧边栏终端（0.1.6 原生 ui-sidebar-terminal）。 */
 openTerminal?:()=>void
 /** 当前root历史只交原生Session/Workspace导航；不复制、改cwd或触发模型。 */
 openHistorySession?:(entry:HistoryEntryRecord)=>Promise<{sessionId:string;opened:true}>
 /**
  * `ui_action` 的 `openResource`：按会话工作区把 path 解析成原生资源地址，交给**原生标签所有者**
  * （注册表预览/编辑器，不另造文件页）打开，并返回**从真实激活标签回读**的 `opened/visible/address/kind`
  * 回执（不是把请求参数抄回来）。缺省＝这个窗口没有接到标签所有者，动作会明确失败（不静默成功）。
  */
 openResource?:(path:string,target:"preview"|"source")=>Promise<{opened:boolean;visible:boolean;address:string|null;kind:string|null}>
 visible?:boolean
 /** 注册方声明的子槽位 `renderSlot`（授权函数由框架经注册项传入）。 */
 renderSlot:WorkbenchRenderSlot
 /** 原生输入插入动作（注册项经 inject 传入）：把请求追加到**指定会话**的原生输入框草稿。 */
}){
 const tr:Translate=(cn,en)=>t("open")==="Scene workbench"?en:cn,api=useMemo(()=>workbenchAPI(sessionId??""),[sessionId]),cacheKey="lyapunov.workbench."+sessionId
 const cameraTranslateRef=useRef(tr);cameraTranslateRef.current=tr
 // 物理引擎状态：**从 Host 读运行中的值**（`runtime-info.engine` 由启动参数回写），不是客户端猜的。
 // 切换只写偏好文件（唯一 owner：`script/engine-preference.ts`），**不重启 Host**——
 // 引擎在启动时装配 Provider，运行中换不了；重启会打断活动会话与运行中的动作。
 // 引擎状态与切换命令由共用 hook 提供（同一份逻辑同时服务 Workbench 与 WorkspaceTools 两处工具轨）。
 const {state:engineState,switchEngine:applyEnginePreference}=useEnginePreference(sessionId)
 const switchEngine=useCallback((next:"isaac"|"mujoco")=>{
  setError("");setNotice("")
  void applyEnginePreference(next)
   .then(()=>setNotice(tr(`已将物理引擎偏好设为 ${next==="isaac"?"Isaac":"MuJoCo"}。引擎在启动时装配，按回执提示重启工作台后生效；当前运行中的会话与动作不受影响。`,`Physics engine preference set to ${next==="isaac"?"Isaac":"MuJoCo"}. The engine is composed at startup, so it takes effect after you restart the workbench as the receipt explains; the running session and actions are unaffected.`)))
   .catch(value=>setError(value instanceof Error?value.message:String(value)))
 },[applyEnginePreference,tr])
 const ui=useWorkbenchUI(),uiState=ui.getSnapshot()
 const frameRoot=useRef<HTMLDivElement>(null),[availableWidth,setAvailableWidth]=useState(0)
 useLayoutEffect(()=>{
  const node=frameRoot.current;if(!node)return
  let positionedHost:HTMLElement|null=null
  const update=()=>{
   setAvailableWidth(node.clientWidth)
   if(!nativeTab||!visible||globalPanel)return
   const host=appSidePanelHost.current;if(!host)return
   const bounds=appSidePanelGeometry(node.getBoundingClientRect(),{width:window.innerWidth,height:window.innerHeight},TOOL_PANEL_WIDTH)
   Object.assign(host.style,{top:`${bounds.top}px`,right:`${bounds.right}px`,width:`${bounds.width}px`,height:`${bounds.height}px`,visibility:bounds.width>0&&bounds.height>0?"visible":"hidden"})
   host.dataset.workbenchPanelClient=api.clientId
   positionedHost=host
  }
  update();const observer=new ResizeObserver(update);observer.observe(node)
  window.addEventListener("resize",update)
  return()=>{
   observer.disconnect();window.removeEventListener("resize",update)
   // 另一个可见工作台已接管共享宿主时，旧 effect 不得把它隐藏。
   if(positionedHost?.dataset.workbenchPanelClient===api.clientId){positionedHost.style.visibility="hidden";delete positionedHost.dataset.workbenchPanelClient}
  }
 },[nativeTab,visible,globalPanel,uiState.tool,api.clientId])
 const [replayActive,setReplayActive]=useState(false)
 const nativeControlCancel=useRef<(()=>ControlGestureDisplay|undefined)|undefined>()
 const manualDrafts=useRef(new Set<string>()),manualActions=useRef<RecentAction[]>([])
 const [manualControlBlocked,setManualControlBlocked]=useState(false)
 const [administrator,setAdministrator]=useState<WorkbenchState["administrator"]>()
 const [officialCamera,setOfficialCamera]=useState(false)
 const [viewerVisible,setViewerVisible]=useState(true),[scenes,setScenes]=useState<Array<{sceneId:string}>>([]),[scene,setScene]=useState<SceneSnapshot>(),[worlds,setWorlds]=useState<WorldHandle[]>([]),[world,setWorld]=useState<WorldHandle>(),[frame,setFrame]=useState<Frame>()
 const [worldLifecycle,setWorldLifecycle]=useState<SceneWorldState>({phase:'idle'}),[worldHostEpoch,setWorldHostEpoch]=useState('')
 const automaticWorld=useMemo(()=>new SceneWorldLifecycle(setWorldLifecycle),[sessionId])
 const [versions,setVersions]=useState<SceneVersion[]>([]),[historyLoading,setHistoryLoading]=useState(false)
 const [assets,setAssets]=useState<AssetRecord[]>([]),[missingAssets,setMissingAssets]=useState<MissingAssetRecord[]>([]),[assetQuery,setAssetQuery]=useState(""),[includeDeleted,setIncludeDeleted]=useState(false),[assetsLoading,setAssetsLoading]=useState(false),[missingAssetsLoading,setMissingAssetsLoading]=useState(false),[renameAsset,setRenameAsset]=useState<{resourceId:string;original:string;value:string} | undefined>()
 const [selected,setSelected]=useState<string|undefined>(()=>{const value=readCache(cacheKey).selectedEntityId;return typeof value==="string"?value:undefined}),[batchIds,setBatchIds]=useState<string[]>([]),[collapsed,setCollapsed]=useState<Set<string>>(new Set()),[descriptions,setDescriptions]=useState<Record<string,RobotDescription>>({}),[targets,setTargets]=useState<Record<string,Record<string,number>>>({})
 const [newEntity,setNewEntity]=useState("")
 const [placingAsset,setPlacingAsset]=useState<AssetPlacement|undefined>(),[placingPoint,setPlacingPoint]=useState<[number,number,number]|undefined>()
 const [assetImportOpen,setAssetImportOpen]=useState(false),[assetPath,setAssetPath]=useState("")
 const [sourceTexturePolicy,setSourceTexturePolicy]=useState<'strict'|'available'>(DEFAULT_LOCAL_SOURCE_TEXTURE_POLICY)
 const [importUsageChoice,setImportUsageChoice]=useState<LocalImportPhysicsUsage>()
 const [importTextureWarnings,setImportTextureWarnings]=useState<string[]>([])
 const [importTextureDetails,setImportTextureDetails]=useState<string[]>([])
 useEffect(()=>{setSourceTexturePolicy(DEFAULT_LOCAL_SOURCE_TEXTURE_POLICY);setImportTextureWarnings([]);setImportTextureDetails([])},[sessionId])
 const [removal,setRemoval]=useState<SceneRemovalTarget>(),[removing,setRemoving]=useState(false)
 useEffect(()=>{setRemoval(undefined);setRemoving(false)},[sessionId])
 const [importBusy,setImportBusy]=useState(false)
 const [localPolicyImport,setLocalPolicyImport]=useState<{sessionId:string;receipt:LocalPolicyImportReceipt}>()
 const policySurfaceAlive=useRef(true)
 useEffect(()=>{policySurfaceAlive.current=true;return()=>{policySurfaceAlive.current=false}},[])
 useEffect(()=>{setLocalPolicyImport(undefined)},[sessionId,worldHostEpoch])
 const [orientationCheckId,setOrientationCheckId]=useState<string>()
 const [orientationStopTarget,setOrientationStopTarget]=useState<{sceneId:string;revision:number}>()
 const orientationStopRef=useRef<{sceneId:string;revision:number;requested:boolean;checkId?:string}>()
 const localImportBusy=useRef(false)
 const [dropTarget,setDropTarget]=useState<"scene"|"library">()
 const [duration,setDuration]=useState(1),[path,setPath]=useState(""),[notice,setNotice]=useState(""),[error,setError]=useState(""),[providerAvailable,setProviderAvailable]=useState(false),[reconnecting,setReconnecting]=useState(false),[actions,setActions]=useState<RecentAction[]>([])
 useEffect(()=>{
  if(!sessionId||!orientationCheckId)return
  let alive=true,busy=false
  const read=async()=>{
   if(busy)return;busy=true
   try{
    const face=await api.request<{checkId:string;status:"queued"|"checking"|"correct"|"corrected"|"uncertain"|"unchecked";attempts:number;turnStop?:"requested"|"confirmed"|"ended"|"shared"}|null>("orientation-status?checkId="+encodeURIComponent(orientationCheckId))
    if(!alive||orientationStopRef.current?.checkId!==orientationCheckId)return
    if(face?.turnStop==="requested"){setNotice(tr("已请求停止自动模型回合，正在等待原生结束回执…","Stopping the automatic model turn; waiting for its end receipt…"));return}
    if(!face||(face.status!=="queued"&&face.status!=="checking")){
     setNotice(face?.turnStop==="confirmed"?tr("方向检查与自动模型回合已停止。","Orientation check and automatic model turn stopped."):face?.turnStop==="shared"?tr("方向检查已撤销；当前对话回合未取消。如需停止生成，请使用对话停止按钮。","Orientation check cancelled; the current conversation turn continues. Use Stop generation if needed."):face?.turnStop==="ended"?tr("方向检查已撤销，自动回合已结束；取消结果未确认。","Orientation check cancelled and the model turn ended; cancellation was not confirmed."):face?.status==="corrected"?tr("已校正方向并复拍确认。","Orientation corrected and verified in a new image."):face?.status==="correct"?tr("方向已确认，无需调整。","Orientation confirmed; no change needed."):face?.status==="uncertain"?(face.attempts===0?tr("方向未确认，原姿态保留。","Orientation unconfirmed; original pose preserved."):tr("方向仍未确认，未继续调整；请查看当前姿态。","Orientation remains unconfirmed; no further adjustment was made. Review the current pose.")):tr("方向未检查，导入内容仍可使用。","Orientation was not checked; the import remains usable."))
     setOrientationCheckId(undefined)
     setOrientationStopTarget(undefined);orientationStopRef.current=undefined
    }
   }catch{if(alive&&orientationStopRef.current?.checkId===orientationCheckId){setNotice(tr("方向未检查，导入内容仍可使用。","Orientation was not checked; the import remains usable."));setOrientationCheckId(undefined);setOrientationStopTarget(undefined);orientationStopRef.current=undefined}}finally{busy=false}
  }
  void read();const timer=setInterval(()=>void read(),1500)
  return()=>{alive=false;clearInterval(timer)}
 },[sessionId,orientationCheckId,api])
 // D1（`bugfixHistory/VISIBILITY-HOLES-20260926.md`）：computer-use 会话事实（宿主 `computerUseFacts()` 的状态投影）。
 // 此前这个键在客户端**零读取**——"本会话正在控制输入"、"会话结束恢复失败了哪几项"、"哪些输入被拒了"用户全看不到。
 const [computerUse,setComputerUse]=useState<WorkbenchState["computerUse"]>()
 // DEV-039：3D 渲染不可用（WebGL 上下文创建失败）时的**显式**呈现状态。
 // 与 `error` 分开：`error` 是"这一轮操作失败了"，这里是"这台机器上 3D 画不出来"——
 // 前者会随下次操作清掉，后者在环境修好前一直成立，且必须顶掉画布位置而不是留空座位。
 const [renderFailure,setRenderFailure]=useState<{cause:unknown}>()
 const [sceneCreating,setSceneCreating]=useState<SceneCreationTemplate>()
 const creationTranslate=useRef(tr);creationTranslate.current=tr
 useEffect(()=>setSceneCreating(undefined),[api])
 /** 重试计数：环境修好后点"重试"要能真的重建 viewer；把计数放进创建 effect 的依赖里即可。 */
 const [renderRetry,setRenderRetry]=useState(0)
 const [renderLoading,setRenderLoading]=useState(false)
 const [collisionStatus,setCollisionStatus]=useState<CollisionTopologyStatus>({status:"no-world",geoms:0,unsupported:0,omitted:0,infinitePlanes:0,reasons:[]})
 const [display,setDisplay]=useState(initialDisplay),[sceneLights,setSceneLights]=useState(true),[animationsPlaying,setAnimationsPlaying]=useState(true),[animationSummary,setAnimationSummary]=useState<AnimationDisplaySummary>(),[gizmo,setGizmo]=useState<"translate"|"rotate"|"scale">("translate"),[captures,setCaptures]=useState<CaptureRecord[]>([]),[capture,setCapture]=useState<CaptureRecord>()
 // 3D 批注：锚在实体局部坐标上，按场景各存一份（annotation-store）。viewer 是渲染与拾取的唯一所有者，
 // 这里只持有"用户写了什么"与"哪条在编辑"；渲染位置一律由 viewer 按实体当前矩阵重算。
 const [annotations,setAnnotations]=useState<ViewerAnnotation[]>([]),[activeAnnotation,setActiveAnnotation]=useState<string|undefined>(),[annotating,setAnnotating]=useState(false),[annotationCaptures,setAnnotationCaptures]=useState<Array<{captureId:string;capturedAt:string;imageURL:string;annotations:AnnotatedCapture[]}>>([])
 // 编辑器回调是"点下去那一刻"的闭包（viewer 一次性注册指针监听），必须经 ref 读最新列表，避免旧闭包把已有批注覆盖掉。
 const [annotationPrompt,setAnnotationPrompt]=useState<string|undefined>()
 const annotationIds=useRef<string[]>([]),annotationScene=useRef<string|undefined>(undefined)
 // 采集时是否把说明直接投进当前会话（默认开：用户点一次就完成"标注→交给模型"）。
 const [injectAnnotations,setInjectAnnotations]=useState(true),injectAnnotationsRef=useRef(true)
 injectAnnotationsRef.current=injectAnnotations
 annotationIds.current=annotations.map(item=>item.annotationId);annotationScene.current=scene?.sceneId
 const [envQuery,setEnvQuery]=useState(""),[envBusy,setEnvBusy]=useState(false),[envCandidates,setEnvCandidates]=useState<EnvironmentCandidate[]>([]),[envDetail,setEnvDetail]=useState<EnvironmentDetail>(),[envNote,setEnvNote]=useState(""),[builtinAssets,setBuiltinAssets]=useState<BuiltinAssetRecord[]>([])
 // 环境光照：读数（Viewer 出）与已登记的 HDRI 引用（资源库出）。都不是第二份"环境状态"——
 // 提交后这里立刻重读，真相始终是 Viewer 解析出来的那一份。
 const [environmentStatus,setEnvironmentStatus]=useState<EnvironmentStatus>(),[hdriAssets,setHdriAssets]=useState<Array<{ref:ResourceRef;name:string}>>([]),[hdriBusy,setHdriBusy]=useState(false)
 const hdriMimeRef=useRef<string[]>([])
 // main 就是原生对话；万一没有可容纳的中央（座位异常）也不允许"对话专注"，否则会剩一块空中央。
 const canCollaborate=availableWidth===0||availableWidth>=960
 const preferredMode=main?uiState.mode:uiState.mode==="chat"?"collab":uiState.mode
 const mode=nativeTab?"scene":preferredMode==="collab"&&!canCollaborate?"scene":preferredMode
 // 场景机制按需启动：从没看过画布就完全不轮询；一旦看过就保持（切模式不重建 viewer，也不丢相机）。
 const [everLive,setEverLive]=useState(!globalPanel&&mode!=="chat")
 useEffect(()=>{if(!globalPanel&&mode!=="chat"&&!everLive)setEverLive(true)},[mode,everLive,globalPanel])
 const open=everLive
 // DEV-005：本窗口此刻是不是**当前可见的工作面**（可见的 3D 场景标签、且不是页面级面板）。
 // 用 ref 读最新值：state 轮询的 effect 只依赖 open/sessionId，切标签不会重建它的闭包，
 // 直接捕 visible 会让后台窗口一直以为自己是前台。
 const ownsSurface=visible&&!globalPanel
 const ownsSurfaceRef=useRef(ownsSurface);ownsSurfaceRef.current=ownsSurface
 // `openResource` 的接线随挂载/注册项变化，但与 state 轮询的闭包解耦（同 ownsSurfaceRef 的理由）。
 const openResourceRef=useRef(openResource);openResourceRef.current=openResource
 // 窗口身份由 api 持有（`api.clientId`，按会话 memo）：选择上报、UI 动作目标与主动观察的目标窗口共用同一个 id。
 const selectionSequence=useRef(0)
 /** 显式选场景的单调序号：只有**最后一次**显式选择自己的响应能落进视图（见 refreshState 的归属判据）。 */
 const sceneLoadSeq=useRef(0)
 const pendingFocus=useRef<{sceneId:string;entityId:string}>()
 const presentedScene=useRef<{viewer:SceneViewer;sceneId:string}>(),assetRewiring=useRef<AssetLocatorRewiring>()
 const container=useRef<HTMLDivElement>(null),viewer=useRef<SceneViewer>(),viewState=useRef<ViewerViewState>(),hostId=useRef<string>(),sceneRef=useRef(scene),worldRef=useRef(world),selectedRef=useRef(selected),descriptionsRef=useRef(descriptions),targetsRef=useRef(targets),apiRef=useRef(api),loadVersion=useRef(0),sceneIntent=useRef<string>()
 const [observerOwner,setObserverOwner]=useState<CameraAuthoringViewer>()
 const viewerVisibleRef=useRef(viewerVisible);viewerVisibleRef.current=viewerVisible
 const subscribeObserver=useCallback((listener:()=>void)=>observerOwner?.subscribeObserverState?.(listener)??(()=>{}),[observerOwner])
 const observerSnapshot=useCallback(()=>observerOwner?.observerState?.(),[observerOwner])
 const observerState=useSyncExternalStore(subscribeObserver,observerSnapshot,()=>undefined)
 const cameraExitBridge=typeof window!=='undefined'?window.lyapunovDesktop as unknown as CameraExitBridge|undefined:undefined
 useEffect(()=>cameraExitBridge?.registerExitParticipant?.('camera-gizmo:'+api.clientId,{summary:()=>({dirtyDrafts:observerOwner?.observerState?.().dirty?1:0,runningActions:0}),flush:async()=>{const state=observerOwner?.observerState?.();if(state?.dirty||state?.saving){if(!observerOwner?.finishCameraRigEditing)throw Error('CAMERA_EDIT_FINISH_UNAVAILABLE');await observerOwner.finishCameraRigEditing({discard:false})}}}),[cameraExitBridge,api.clientId,observerOwner])
 const cameraNavigation=(input:CameraNavigationInput)=>applyCameraNavigation(input,{clientId:api.clientId,ownsSurface:()=>ownsSurfaceRef.current,viewerVisible:()=>viewerVisibleRef.current,readOnly:()=>cameraReadOnlyRef.current,scene:()=>sceneRef.current,viewer:()=>viewer.current as unknown as CameraAuthoringViewer|undefined,ui,selectEntity:entityId=>{selectedRef.current=entityId;setSelected(entityId)}})
 const exitCameraView=()=>cameraNavigation({action:'exitCameraView',clientId:api.clientId,sceneId:sceneRef.current?.sceneId})
 const locateRobotAnchor=(entityId:string,kind:'tcp'|'base')=>cameraNavigation({action:kind==='tcp'?'locateTcp':'locateBase',clientId:api.clientId,sceneId:sceneRef.current?.sceneId,entityId})
 // 批注的"最新值"同样要有 ref：创建 effect 只在 open/可见性变化时跑，不能把它的依赖拖成批注数组。
 const annotationsRef=useRef<ViewerAnnotation[]>([]),annotatingRef=useRef(false)
 annotationsRef.current=annotations;annotatingRef.current=annotating
 sceneRef.current=scene;worldRef.current=world;selectedRef.current=selected;descriptionsRef.current=descriptions;targetsRef.current=targets;apiRef.current=api;manualActions.current=actions
 // 官方套件世界是只读投影：可以查看、转相机、看官方状态，但不进入编辑/历史/重建路径。
 const official=world?.engineId==="official-suite",readOnly=Boolean(!sessionId||official||scene?.entities.some(entity=>(entity.components.mujoco as {source?:string}|undefined)?.source==="official-env"))
 // 读写权限用 ref 暴露给 viewer：权限变化不再重建 viewer（重建会在容器未挂回时留下空白画布）。
 const readOnlyRef=useRef(readOnly);readOnlyRef.current=readOnly
 const cameraReadOnlyRef=useRef(readOnly||replayActive);cameraReadOnlyRef.current=readOnly||replayActive
 // 只创建一次的提交回调：viewer 的 commitEdit 不再随权限变化而换引用。
 const commitEditRef=useRef<((input:{sceneId:string;expectedRevision:number;entityId:string;transform:Transform})=>Promise<SceneSnapshot>)|undefined>(undefined)
 const projectedScene=useRef<string|undefined>()
 const entity=scene?.entities.find(value=>value.entityId===selected),description=selected?descriptions[selected]:undefined,observation=frame?.entities.find(value=>value.entityId===selected)
 const ready=Boolean(sessionId&&!replayActive&&!reconnecting&&world&&["ready","running","paused"].includes(world.status)&&world.appliedSceneRevision===scene?.revision)
 const sceneWritePort={identity:()=>({sceneId:sceneRef.current?.sceneId,revision:sceneRef.current?.revision}),applyScene:(value:unknown)=>{sceneRef.current=value as SceneSnapshot;setScene(value as SceneSnapshot)}}
 const persist=(s:SceneSnapshot|undefined,w:WorldHandle|undefined)=>sessionStorage.setItem(cacheKey,JSON.stringify({sceneId:s?.sceneId,worldId:w?.worldId,hostInstanceId:hostId.current,selectedEntityId:s?.entities.some(e=>e.entityId===selectedRef.current)?selectedRef.current:undefined}))
 const perform=(fn:()=>Promise<unknown>)=>{setError("");void fn().catch(value=>{if(apiRef.current===api)setError(value instanceof Error?value.message:String(value))})}
 const refreshScenes=async()=>{const value=await api.request<Array<{sceneId:string}>>("scenes");if(apiRef.current===api)setScenes(value);return value}
 // 打开「场景」面板就重读一次场景清单。
 // 为什么需要：agent 会用 `scene_open` / `scene_create` 建出新场景，而清单此前只在挂载与手动点「刷新」时读，
 // 于是出现**它说"导入成功 283 实体"、面板里却只有占位项**——实测连续两次（tiananmen、tiananmen-v6）。
 // 不放进 250ms 的轮询：清单要逐个解析场景文档（283 实体那份约 400KB），按 250ms 读代价过高；
 // 面板打开正是用户要看的时刻，读一次足够，也不改「清单由 Host 拥有」这个 owner 关系。
 // 场景清单此前只在挂载/重开面板时读一次：agent 用 scene_create/scene_open 建出的场景，或命令面
 // 建出的场景，在下拉里永远不出现（用户建完选不中，工作台停在空画布）。面板开着时按既有 refreshScenes 轮询，
 // 不新增状态库/第二套缓存；面板切走即停。
 useEffect(()=>{if(!open||!sessionId||uiState.tool!=="scene")return;let alive=true
  const read=()=>{if(alive)void refreshScenes().catch(()=>undefined)}
  read();const timer=setInterval(read,3000);return()=>{alive=false;clearInterval(timer)}},[open,sessionId,uiState.tool])
 // 日常工作台不拉取/显示内部路由诊断；Host实际判定与system/skill注入保持。
 const refreshHistory=async(sceneId=sceneRef.current?.sceneId):Promise<SceneVersion[]>=>{
  // 官方世界的派生 Scene 没有普通版本历史；活动官方世界期间不查 scene-history。
  if(!sceneId||worldRef.current?.engineId==="official-suite")return []
  setHistoryLoading(true)
  try{const value=await api.request<SceneVersion[]>("scene-history?sceneId="+encodeURIComponent(sceneId));if(sceneRef.current?.sceneId===sceneId)setVersions(value);return value}
  finally{setHistoryLoading(false)}
 }
 const refreshAssets=async(query=assetQuery,include=includeDeleted):Promise<AssetRecord[]>=>{
  setAssetsLoading(true)
  try{const value=await api.request<AssetRecord[]>("assets?"+new URLSearchParams({query,includeDeleted:String(include)}));if(apiRef.current===api)setAssets(value);return value}
  finally{if(apiRef.current===api)setAssetsLoading(false)}
 }
 const refreshMissingAssets=async():Promise<MissingAssetRecord[]>=>{
  setMissingAssetsLoading(true)
  try{const value=await api.request<MissingAssetRecord[]>("missing-assets");setMissingAssets(value);return value}
  finally{setMissingAssetsLoading(false)}
 }
 const refreshBuiltinAssets=async():Promise<BuiltinAssetRecord[]>=>{
  const value=await api.request<{resources:BuiltinAssetRecord[]}>("builtin-assets");setBuiltinAssets(value.resources);return value.resources
 }
 const submitRename=async()=>{
  const pending=renameAsset
  if(!pending)return
  const name=pending.value.trim()
  if(!name){setError(tr("资源名称不能为空。","Asset name cannot be empty."));return}
  if(name===pending.original){setRenameAsset(undefined);return}
  await api.command("asset_edit",{resourceId:pending.resourceId,name})
  setRenameAsset(undefined)
  await refreshAssets()
 }
 const rescanMissingAssets=async()=>{
  setMissingAssetsLoading(true)
  try{const value=await api.command<MissingAssetRescan>("asset_missing_rescan",{});setMissingAssets(value.records);setNotice(value.status==="READY_TO_RERUN"?tr("已找到全部原件；请重新运行同一迁移恢复，不会自动替换。","All originals are present; rerun the same migration to recover. Nothing was replaced automatically."):value.status==="BLOCKED"?tr("仍有原件缺失或路径不是文件。","Some originals are still missing or the path is not a file."):tr("没有迁移阻断原件。","No blocked migrated originals."));return value}
  finally{setMissingAssetsLoading(false)}
 }
 // 自我控制:host 队列里的界面动作(打开面板/文件/终端/画布、选中、聚焦)在每次 state 轮询时取走执行,
 // 执行成功才 ack 出队;动作幂等,ack 失败重复执行无副作用。
 /**
  * 本窗口**真正完成加载**的场景身份：只有 await 过 setScene 的那处（下面的 effect）能登记。
  * sceneRef/displayed 在 setScene 调用前后就带上了新 revision，证明不了"异步资源已经进了画面"；
  * 观察采集据这里判断要不要采、要不要再等一会儿。
  */
 const readyScene=useRef<{instance:unknown;sceneId:string;revision:number;settled:boolean;failed:boolean}|undefined>(undefined)
 // 换过 Viewer 实例（重建/切页）后旧登记立即作废：新实例还没加载过任何场景。
 const loadStateForObserver=()=>{const current=readyScene.current;return current&&current.instance===viewer.current?{sceneId:current.sceneId,revision:current.revision,settled:current.settled,failed:current.failed}:undefined}
 /**
  * 主动观察：模型请求"这个窗口现在拍一张"。只有 args.clientId 指向的窗口执行——
  * 同会话的其它窗口看得到这条动作，但既不执行也不代它确认（它不该把别人屏幕上的画面当成这次观察）。
  * 判定与采集本身放在 `workbench-observe.ts`（与定向测试共用同一份），落盘走与用户点"采集图像"
  * 完全相同的 `viewer_capture`：同一个落盘、同一套来源/版本校验。
  */
 const observerGuard=useRef(createObserverActionGuard())
 /** 三条"看图/摆相机"的界面动作共用的调用参数（判据与落盘入口一字不差，差别只在拍哪一张）。 */
 const observeCallInput=(item:{id:string;args:Record<string,unknown>})=>({
  sceneId:String(item.args.sceneId??""),expectedRevision:Number(item.args.expectedRevision),
  observeId:item.id,clientId:api.clientId,sessionId,viewerVisible,
  viewer:viewer.current,displayed:{sceneId:sceneRef.current?.sceneId,revision:sceneRef.current?.revision,entityIds:sceneRef.current?.entities.map(entity=>entity.entityId)},
  loadState:loadStateForObserver,
  capture:(payload:unknown)=>api.capture(payload as Record<string,unknown>),
 })
 const cameraArgsOf=(item:{args:Record<string,unknown>})=>({request:item.args.camera,name:typeof item.args.name==="string"?item.args.name:undefined})
 const captureForObserver=(item:{id:string;args:Record<string,unknown>})=>{
  const shared=observeCallInput(item),{request,name}=cameraArgsOf(item)
  // 带 camera/name 的那条是"先摆相机、再拍当前画布"：走 `workbench-camera.ts`（同一套判定），
  // 拍的仍是窗口里那一帧（来源 native-viewer）；不带就是原来那条当前画布采集，一字未改。
  return request===undefined&&name===undefined?captureForObserverAction(shared):observeCameraForAgentAction({...shared,request,name})
 }
 const drainUiActions=async(actions:Array<{id:string;action:string;args:Record<string,unknown>;enqueuedAt:string}>)=>{
  // 回执行里带上本窗口的 clientId：服务端只允许**被指定的那个窗口**给这次观察/相机应用下结论（会话+窗口双重归属），
  // 别的窗口拿同一个 requestId 也改变不了等待者的结果。带结果的成功行（相机应用的读数）走同一个数组的另一半。
  const done:string[]=[],results:Array<{id:string;ok:boolean;clientId:string;error?:string;value?:unknown}>=[]
  const failed=(id:string,error:unknown)=>results.push({id,ok:false,clientId:api.clientId,error:error instanceof Error?error.message:String(error)})
  for(const item of actions){
   try{
    // DEV-005：改页面级工作面的动作（共享布局偏好 store 与右侧栏标签）只由**当前可见**窗口落地；
    // 后台窗口（3D 场景标签被切走时仍挂载、仍在轮询）不确认出队，这条请求留在队列里，
    // 等它的窗口被切到前台再执行——既不会无提示改前台工作面，也不会被丢掉。
    if(surfaceDisposition(item.action,ownsSurfaceRef.current)==="defer")continue
    // 定向动作只由目标窗口执行。采集/相机仍会出现在非目标窗口的轮询里，这里跳过：
    // 不执行、不确认，留给真正的目标窗口。
    const directedClient=typeof item.args.clientId==="string"?item.args.clientId:undefined
    if(directedClient&&directedClient!==api.clientId)continue
    const tool=item.args.tool as ToolId|undefined,entityId=item.args.entityId as string|undefined,sceneId=item.args.sceneId as string|undefined
    if(item.action==="openTool"&&tool){ui.openTool(tool);ui.showCentre("canvas")}
    else if(item.action==="openFiles")openFiles?.()
    else if(item.action==="openTerminal")openTerminal?.()
    else if(item.action==="openResource"){
     // 指定资源打开：**等待型**动作。回执必须是原生标签所有者给出的真实 opened/visible，
     // 不是"我调了 openResource"。失败（无所有者/没打开/列没展开/地址打不开）按失败确认出队，
     // 让等着的模型立刻拿到原因，而不是空等到超时（失败也确认，否则同一动作会被每次轮询重试）。
     const path=typeof item.args.path==="string"?item.args.path.trim():""
     const target=item.args.target==="source"?"source":"preview"
     if(!path){failed(item.id,Error("UI_ACTION_OPEN_PATH_REQUIRED: 这条打开动作没有带 path"));done.push(item.id);continue}
     if(!observerGuard.current(item.id))continue
     try{
      const opener=openResourceRef.current
      if(!opener)throw Error("UI_ACTION_OPEN_UNAVAILABLE: 这个窗口没有接上原生资源标签所有者，无法打开")
      const receipt=await opener(path,target)
      // 与宿主同一份回执判据（`ui-action-open.ts`）：opened 且 visible 且带真实标签的 address/kind 才算成功；
      // 地址/kind 是否与请求对得上由标签所有者按同一份期望先行核对（宿主还会独立再核一遍）。
      const verdict=openReceiptVerdict(receipt)
      if(!verdict.ok)throw Error(verdict.reason)
      done.push(item.id);results.push({id:item.id,ok:true,clientId:api.clientId,value:verdict.value})
     }catch(error){failed(item.id,error);done.push(item.id)}
     continue
    }
    else if(item.action==="showCanvas")ui.showCentre("canvas")
    else if(item.action==="selectEntity"&&entityId){setSelected(entityId);ui.showCentre("canvas")}
    else if(item.action==="focus"){ui.showCentre("canvas");if(entityId)viewer.current?.focus(entityId);else viewer.current?.frameAll()}
    else if(item.action==="enterSceneCenter"){ui.showCentre("canvas");viewer.current?.enterSceneCenter(entityId)}
    else if(isCameraNavigationAction(item.action)){
     try{
      const receipt=cameraNavigation({action:item.action,...typeof item.args?.cameraId==='string'?{cameraId:item.args.cameraId}:{},...directedClient?{clientId:directedClient}:{},...sceneId?{sceneId}:{},...entityId?{entityId}:{}})
      if(!receipt.applied)continue
     }catch(error){failed(item.id,error);setError(error instanceof Error?error.message:String(error))}
    }
    else if(item.action==="selectScene"&&sceneId){
     // 与用户按钮「新建场景」**同一条**路径（先 refreshScenes 再 loadScene）：换场景、清旧实体/world 选择、
     // 作废相机视图全部由已有的 loadScene 负责，这里不另建状态，也不写 Scene 数据。
     // 为什么清单也要刷：agent 用 `scene_create` 建出的场景，下拉框的 option 只在打开面板/点「刷新」时读过，
     // 新 id 没有对应 option，`value={scene?.sceneId}` 匹配不上就回落成占位项「选择场景」——画面已切、
     // 名字还是旧的（真实 Edge 复现）。刷新失败与载入失败一样走 perform 的报错路径。
     // 认领与采集一样：确认出队前先认领（loadScene 内部会再触发一次 state 刷新，重复投递会挑到同一条动作）；
     // 回执/确认只说明"这个窗口取走了这条动作"，哪个场景真的显示了由 viewer_observe 按采集核对。
     if(!observerGuard.current(item.id))continue
     perform(async()=>{await refreshScenes();await loadScene(sceneId)})
    }
    else if(item.action==="captureViewer"){
     // 目标窗口不是本窗口就整条跳过：不执行、不确认，留给真正的目标窗口。
     const target=item.args.clientId as string|undefined
     if(target&&target!==api.clientId)continue
     // 确认出队前的重复投递（250ms 轮询比采集快）不重复执行：一次观察只拍一张。
     if(!observerGuard.current(item.id))continue
     try{await captureForObserver(item)}
     catch(error){
      // 失败也要确认出队（否则同一张没拍成的图会被每次轮询反复重试），同时把原因送回等着的工具。
      done.push(item.id);failed(item.id,error);continue
     }
    }
    else if(item.action==='sampleCameraViewer'){
     if(item.args.clientId!==api.clientId)continue
     if(!observerGuard.current(item.id))continue
     try{
      const currentScene=sceneRef.current
      if(cameraReadOnlyRef.current)throw Error('CAMERA_AUTHORING_READ_ONLY: 当前窗口为只读或录制回放')
      if(!viewerVisible||!currentScene||currentScene.sceneId!==item.args.sceneId||currentScene.revision!==item.args.expectedRevision)throw Error('CAMERA_AUTHORING_SCENE_STALE: 目标窗口未显示请求版本')
      const sampled=sampleCameraForAuthoring(viewer.current,currentScene)
      results.push({id:item.id,ok:true,clientId:api.clientId,value:{...sampled,state:sampled.view}})
     }catch(error){failed(item.id,error)}
    }
    else if(item.action==="applyCameraViewer"){
     const target=item.args.clientId as string|undefined
     if(target&&target!==api.clientId)continue
     if(!observerGuard.current(item.id))continue
     const {request,name}=cameraArgsOf(item)
     const sceneId=String(item.args.sceneId??""),expectedRevision=Number(item.args.expectedRevision)
     let receipt:ReturnType<typeof applyCameraToWindow> extends Promise<infer T>?T:never
     try{
      // 应用后**当场测量**再回报：回执里的相机是量出来的，不是"我请求了什么"；
      // 窗口显示的不是这一版、或 Viewer 不支持相机接口，都在这里明确失败。
      // 命名相机从这个**场景快照**里读、经 `saveNamedCameras` 写回同一份文档（scene_edit + CAS，
      // 与相机面板按钮同一个写入函数）：saveAs 写不进去就整条失败，回执里不出现 savedAs。
      receipt=await applyCameraToWindow({clientId:api.clientId,viewerVisible,viewer:viewer.current,displayed:{sceneId:sceneRef.current?.sceneId,revision:sceneRef.current?.revision},sceneId,expectedRevision,namedCameras:namedCamerasOfScene(sceneRef.current?.entities).cameras,saveNamedCameras:async next=>{await writeNamedCameras(sceneId,expectedRevision,next)},...request===undefined?{}:{request},...name===undefined?{}:{name},...typeof item.args.saveAs==="string"?{saveAs:item.args.saveAs}:{}})
     }catch(error){done.push(item.id);failed(item.id,error);continue}
     // 成功行带 value：服务端把它当作这次等待的结果（它没有图，交付物就是这份读数）。
     done.push(item.id);results.push({id:item.id,ok:true,clientId:api.clientId,value:receipt})
     // 相机应用本身作用在本窗口自己的 Viewer 上（不抢工作面）；只有"把中央视图切回画布"是页面共享布局。
     if(ownsSurfaceRef.current)ui.showCentre("canvas")
    }
    else if(item.action==="renderCameraViewer"){
     const target=item.args.clientId as string|undefined
     if(target&&target!==api.clientId)continue
     if(!observerGuard.current(item.id))continue
     const {request,name}=cameraArgsOf(item)
     try{
      await renderCameraForAgentAction({...observeCallInput(item),request,name,
       ...typeof item.args.width==="number"?{width:item.args.width}:{},...typeof item.args.height==="number"?{height:item.args.height}:{}})
     }catch(error){done.push(item.id);failed(item.id,error);continue}
    }
    else continue
    done.push(item.id)
   }catch{}
  }
  // 顶层带本窗口 clientId：定向请求(captureViewer/applyCameraViewer/renderCameraViewer)只认目标窗口自己的确认，
  // 少了它一条成功的采集/相机应用就出不了队（服务端会拒绝替别的窗口取走请求）。
  if(done.length)await api.command("ui_action_ack",{ids:done,clientId:api.clientId,...results.length?{results}:{}}).catch(()=>{})
 }
 /**
  * 每次 state 轮询都顺带上报"这个窗口此刻在显示什么"（api.state 的 displaySceneId/displayRevision）。
  * 这是服务端判断"哪个窗口在场、它显示的是哪个版本"的唯一来源：模型的主动观察据此选目标窗口，
  * 并按同一事实核对拿回来的图。上报的是**当前显示**的场景，不是本次请求想加载的场景。
  */
 const stateQuery=(sceneId?:string)=>({...sceneId?{sceneId}:{},displaySceneId:sceneRef.current?.sceneId,displayRevision:sceneRef.current?.revision})
 const refreshState=async(sceneId?:string,seq?:number)=>{
  // 请求目标：显式目标（新加载/官方投影自动采用/初始化选择）优先于调用时刻的 sceneRef，
  // 这样「新加载在途」期间轮询不会继续打旧 Scene，旧 Scene 的响应也不会挂回视图。
  const intent=sceneIntent.current,target=intent??sceneId??sceneRef.current?.sceneId
  // 官方 Scene 随 world 关闭而消失。先发现世界，避免轮询已失效 Scene 时一直报错，
  // 导致下面负责清除只读投影的 effect 永远收不到 worlds=[]。
  let value=await api.state(stateQuery(projectedScene.current===target?undefined:target))
  if(apiRef.current!==api)return value
  if(value?.uiActions?.length)void drainUiActions(value.uiActions)
  // 后台响应归属：await 之后按“落地时刻”重新核对（在途目标/当前视图/版本单调）。
  // 过时响应不得写场景、world、缓存与官方投影——只把连接状态收敛回去；
  // 新版本/显式选择的落地由它自己的响应或下一次轮询完成，不在这里抢写。
  const view=sceneRef.current
  // 归属判据里的"在途目标"：**显式点名的那一版自己就是它的在途目标，且只有最后一次显式选择算数**。
  // DEV-010 实测（283/1120 实体大场景恢复）：加载在途时再切场景，`sceneIntent` 已被上一条响应清空
  // （见 :312），若这里按 undefined 交给落地核对，"没有在途目标时只认当前显示场景"那条规则会把
  // **这次选择自己的响应**当成轮询的陈旧响应丢掉——用户切走的那一版永远不回填，工作台卡在被取代的
  // 场景上（"大场景恢复后失去响应"的用户视角）。反过来，只要放行所有显式响应，**更早那次**选择的
  // 迟到响应又会在新选择落地之后把旧场景挂回来。所以带序号：seq 仍是最后一次显式选择（sceneLoadSeq）
  // 时才把它当作在途目标；更早的、以及纯轮询的响应，仍由原有两条规则挡住。
  const explicitPending=sceneLoadSeq.current>0&&sceneLoadSeq.current===seq
  const pendingTarget=sceneIntent.current??(explicitPending?target:undefined)
  if(isStaleStateResponse({target,pendingTarget,viewSceneId:view?.sceneId,view,payload:value.scene})){
   setReconnecting(false);return value
  }
  if(intent!==undefined&&sceneIntent.current===intent)sceneIntent.current=undefined
  const activeOfficial=value.worlds.find(item=>item.engineId==="official-suite"&&item.status!=="closed"&&item.sceneId===target)
  if(activeOfficial){
   projectedScene.current=activeOfficial.sceneId
   const current=sceneRef.current
   const projection=worldRef.current?.worldId===activeOfficial.worldId&&worldRef.current.worldGeneration===activeOfficial.worldGeneration&&current?.sceneId===activeOfficial.sceneId&&current.revision===activeOfficial.appliedSceneRevision
    ?current:await api.request<SceneSnapshot>("scene?sceneId="+encodeURIComponent(activeOfficial.sceneId))
   if(projection!==current){
    // 落地核对全部放到最后一次 await 之后（第三次只读 state）。前两次 await 携带的是请求发出时的事实：
    // 在途期间用户可能已经切走场景（关闭官方 world 后的 fallback、显式选择）、world 代际或已应用版本
    // 可能已经前进、Host 也可能已经换掉——旧的 world 列表会把已消失的 world 与投影一起挂回视图与缓存。
    const live=await api.state(stateQuery())
    const landed=live.worlds.find(item=>item.worldId===activeOfficial.worldId&&item.status!=="closed")
    // ① 这次投影必须仍属于发起时那个 world 身份：仍在列、代际未前进、已应用版本正是这次取到的投影版本。
    //    已前进说明投影已过时——丢弃本次投影，由下一轮按新事实重新取值，不在这里抢写（projectionWorldLanded）。
    // ② world 列表取自 live、Host 身份与其余字段取自原 value：不把两个 Host 的字段拼在一起。
    // ③ 既有归属判据按落地时刻重新调用（原请求 target、当前 pendingTarget、当前 view、实际 projection）：
    //    在途目标已换、或视图已换到别的 Scene、或同 Scene 更低 revision 都不采用。这里判它不会误伤首次采用：
    //    那条路径的 target 就是当时的视图（pendingTarget 已在前面清掉）。
    if(!projectionWorldLanded(landed,activeOfficial,projection.revision)||live.hostInstanceId!==value.hostInstanceId||isStaleStateResponse({target,pendingTarget:sceneIntent.current,viewSceneId:sceneRef.current?.sceneId,view:sceneRef.current,payload:projection})){setReconnecting(false);return value}
    value={...value,worlds:live.worlds}
   }
   value={...value,scene:projection}
  }
  if(apiRef.current!==api)return value
  const previous=hostId.current??readCache(cacheKey).hostInstanceId,changed=Boolean(previous&&previous!==value.hostInstanceId)
  setAdministrator(value.modelBilling==="own-key"?value.administrator:undefined)
  hostId.current=value.hostInstanceId;setWorldHostEpoch(value.hostInstanceId);setProviderAvailable(value.providerAvailable);setWorlds(value.worlds);setCaptures(value.captures??[]);setComputerUse(value.computerUse)
  if(value.recentActions)setActions(value.recentActions)
  if(value.scene){if(selectedRef.current&&!value.scene.entities.some(e=>e.entityId===selectedRef.current)){selectedRef.current=undefined;setSelected(undefined)}setScene(old=>old?.sceneId===value.scene!.sceneId&&old.revision===value.scene!.revision?old:value.scene);sceneRef.current=value.scene}
  if(changed){setWorld(undefined);worldRef.current=undefined;setFrame(undefined);setDescriptions({});setTargets({});projectedScene.current=undefined;viewer.current?.setWorld(undefined);setNotice(tr("Host 已重启，旧世界句柄已清除；正在按当前场景恢复物理世界。","Host restarted; old world handles were cleared. Restoring physics for the current scene."));persist(value.scene,undefined)}
  else{const desired=worldRef.current?.worldId??readCache(cacheKey).worldId,same=value.worlds.filter(item=>item.sceneId===(value.scene?.sceneId??target)&&item.status!=="closed"),current=adoptWorldHandle(same.find(item=>item.worldId===desired)??(same.length===1?same[0]:undefined),worldRef.current);setWorld(current);worldRef.current=current;if(!current)setFrame(undefined);persist(value.scene,current)}
  setReconnecting(false);return value
 }
 const loadScene=async(id:string)=>{nativeControlCancel.current?.();sceneIntent.current=id;const seq=++sceneLoadSeq.current;pendingFocus.current=undefined;++loadVersion.current;viewState.current=undefined;projectedScene.current=undefined;selectedRef.current=undefined;setSelected(undefined);setBatchIds([]);setDescriptions({});setTargets({});setFrame(undefined);setWorld(undefined);worldRef.current=undefined;const value=await refreshState(id,seq);if(value.worlds.some(item=>item.engineId==="official-suite"&&item.sceneId===id))setVersions([]);else await refreshHistory(id);return value}
 const createScene=useMemo(()=>createSceneCreationAction(async(template:SceneCreationTemplate)=>{
  if(!sessionId||readOnlyRef.current)throw Error('SCENE_CREATION_UNAVAILABLE: 先选择可编辑工作区')
  setSceneCreating(template);setNotice('');setError('')
  try{
   const snapshot=await createSceneFromTemplate({create:chosen=>api.command<SceneSnapshot>('scene_create',{template:chosen}),refresh:refreshScenes,load:async id=>{await loadScene(id);return {scene:sceneRef.current}},isCurrent:()=>apiRef.current===api},template)
   if(apiRef.current===api&&sceneRef.current?.sceneId===snapshot.sceneId)setNotice(creationTranslate.current('场景已创建并载入；物理是否就绪以运行状态为准。','Scene created and loaded. Physics readiness is shown by runtime status.'))
   return snapshot
  }finally{if(apiRef.current===api)setSceneCreating(undefined)}
 }),[api])
 const describe=async(entityId:string)=>{
  const w=worldRef.current;if(!w)return
  const result=await api.request<RobotDescription>("robot-description?"+new URLSearchParams({worldId:w.worldId,entityId}))
  if(!sameWorldBinding(w,worldRef.current)||result.expectedGeneration!==w.worldGeneration)return
  setDescriptions(old=>({...old,[entityId]:result}));descriptionsRef.current={...descriptionsRef.current,[entityId]:result}
  const current=await api.frame(w.worldId);if(!sameWorldBinding(w,worldRef.current)||current.generation!==w.worldGeneration)return
  const values=measuredJointTargets(result,current,entityId)
  setTargets(old=>({...old,[entityId]:old[entityId]??values}));targetsRef.current={...targetsRef.current,[entityId]:targetsRef.current[entityId]??values};return result
 }
 // 选择事实必须与工作台当前可见状态一致：场景关闭/取消选择时同样发显式清除（无 sceneId），
 // 否则服务端的旧 scene/world/entity 会继续进入模型上下文。序号单调递增，迟到旧请求写不回。
 useEffect(()=>{if(!open||!sessionId)return;let alive=true
  // 当前选择只保存在该会话的视图缓存；Scene/Sim事实仍由Host拥有。
  if(scene)persist(scene,world)
  const assert=scene
   ?api.selection({sceneId:scene.sceneId,entityId:selected,worldId:world?.worldId,sequence:++selectionSequence.current})
   :api.selection({sequence:++selectionSequence.current})
  void assert.catch(value=>{if(alive)setError(String(value))});return()=>{alive=false;api.clearControlSelection()}
 },[open,scene?.sceneId,scene?.revision,selected,world?.worldId,world?.worldGeneration,sessionId])
 useEffect(()=>{if(!open||!sessionId)return;let alive=true,busy=false
  perform(async()=>{const list=await refreshScenes();const initial=await api.state();if(alive){
   const saved=sceneRef.current?.sceneId??readCache(cacheKey).sceneId??initial.lastSceneId
   const id=saved?(list.some(item=>item.sceneId===saved)||initial.worlds.some(item=>item.sceneId===saved)?saved:undefined):list[0]?.sceneId
   if(id){sceneIntent.current=id;await refreshState(id);await refreshHistory(id)}
  }})
  // 每次状态轮询顺带重读环境光照读数：读的是 Viewer 自己的解析结果（无渲染、无网络），
  // 因此 Agent 用 scene_edit 改了环境、或场景版本回退时，面板会跟着变——面板不自己算一套。
  const timer=setInterval(async()=>{if(busy)return;busy=true;try{await refreshState(sceneRef.current?.sceneId);readEnvironmentStatus()}catch(value){if(alive){setReconnecting(true);setError(String(value))}}finally{busy=false}},WORKBENCH_STATE_POLL_MS)
  return()=>{alive=false;clearInterval(timer)}
 },[open,sessionId])
 useEffect(()=>{if(!open||!viewerVisible)return
  setRenderFailure(undefined)
  // 容器可能在这一提交里还没挂上（例如世界打开后布局换了一棵子树）：按帧等到它出现，
  // 而不是 return 之后再无依赖变化可触发（旧实现就是这样留下永久空白画布的）。
  let raf=0,disposed=false,instance:SceneViewer|undefined
  const boot=()=>{if(disposed)return;const host=container.current;if(!host){raf=requestAnimationFrame(boot);return}
  // DEV-039：整段创建包在 try 里。此前 `createViewer` 直接裸调，WebGL 不可用时异常穿透 effect
  // 被 slot 渲染边界接住 ⇒ 用户只看得到一个**空座位**：没有错误、没有解释、没有建议。
  // 这里把它转成显式状态，由渲染侧顶掉画布位置（见 renderFailure 的 JSX）。
  try{
  // 资源也按会话取（`api.mediaURL` 会带上本窗口的会话标识）：同一个 sceneId/uri 在两个会话里
  // 指向各自那份存储，Viewer 不会用别的会话的资源字节拼这一版场景。走 apiRef 是因为这个
  // 效应不随 api 重建，闭包里直接捕 api 会在换会话后继续用旧身份。
  instance=createViewer({container:host,translate:(zh,en)=>cameraTranslateRef.current(zh,en),splatRetentionScope:sessionId&&hostId.current?{hostInstanceId:hostId.current,sessionId}:undefined,resolveResource:uri=>apiRef.current.mediaURL("resource",{sceneId:sceneRef.current?.sceneId??"",uri:viewerResourceURI(uri)}),onSelection:setSelected,onRobotAnchorSelect:()=>ui.openTool('robot'),onPlacePoint:point=>setPlacingPoint(point),onError:value=>setError(String(value)),
   // 新批注只在这里生成 id/编号：编号是显示序号（面板、标记、截图三处必须同一个），身份始终是 annotationId。
   onAnnotationCreate:anchor=>{const created=createAnnotation(anchor,annotationIds.current.length+1,new Date().toISOString());setAnnotations(old=>[...old,created]);setActiveAnnotation(created.annotationId)},
   onAnnotationSelect:annotationId=>setActiveAnnotation(annotationId),
   commitEdit:input=>{const commit=commitEditRef.current;if(!commit)throw new Error("SCENE_EDIT_UNAVAILABLE");return commit(input)}})
  viewer.current=instance;setObserverOwner(instance as unknown as CameraAuthoringViewer);instance.setDisplaySettings(display);instance.setSceneLights(sceneLights);instance.setAnimationsPlaying(animationsPlaying);instance.setGizmoMode(gizmo);instance.setEditCommit(readOnlyRef.current?undefined:commitEditRef.current)
  // 新实例必须立刻拿到当前批注（否则切回画布时标记短暂消失），模式同样同步。
  instance.setAnnotations(annotationsRef.current)
  instance.setAnnotationMode(annotatingRef.current)
  setRenderFailure(undefined)
  }catch(value){
   // 环境缺能力，不是场景坏了：如实说清是什么、为什么、怎么办。恢复后（重开 Viewer / 换到有 GL 的会话）
   // 这个状态会被下一次成功 boot 清掉。
   viewer.current=undefined;setObserverOwner(undefined)
   if(!disposed)setRenderFailure({cause:value})
  }
  }
  boot()
  return()=>{disposed=true;cancelAnimationFrame(raf);setObserverOwner(undefined);const current=instance??viewer.current;if(!current)return;readyScene.current=undefined;viewState.current=current.getViewState();const id=presentedScene.current?.sceneId;if(id)savedCameraViews.set(cacheKey+"\0"+id,viewState.current);current.dispose();viewer.current=undefined}
 },[open,viewerVisible,Boolean(scene),renderRetry,sessionId,hostId.current])
 // 权限变化只切提交能力，不重建 viewer。注意这条依赖里**没有** renderRetry——重试要重建。
 useEffect(()=>{const instance=viewer.current;if(!instance)return;instance.setEditCommit(readOnly?undefined:commitEditRef.current)},[readOnly,open,viewerVisible])
 useEffect(()=>{const instance=viewer.current;if(!scene||!instance)return;const version=++loadVersion.current
  // 同一场景的编辑只更新内容；自动取景会打断用户刚调整好的观察视角。
  const sameScene=presentedScene.current?.viewer===instance&&presentedScene.current.sceneId===scene.sceneId
  const camera=sameScene?undefined:savedCameraViews.get(cacheKey+"\0"+scene.sceneId)
  presentedScene.current={viewer:instance,sceneId:scene.sceneId}
  // DEV-034：交给 Viewer 的这一份才是**带可用资产定位符**的场景（回写判定见 `prepareViewerScene`）。
  // 面板自己继续用出站投影那一份（标签/序列化口径不变），两者只在资产定位符上不同。
  const prepared=prepareViewerScene(scene);assetRewiring.current=prepared.rewiring
  // 这一次 setScene 的完成事实就是"资源加载完"的唯一判据：登记下来供主动观察核对（先登记、再挂回调，
  // 回调里只改这一份登记的字段，避免把失败标记写成"加载成功"）。
  setRenderLoading(true)
  const loaded=instance.setScene(prepared.scene),ready={instance,sceneId:scene.sceneId,revision:scene.revision,settled:false,failed:false}
  readyScene.current=ready
  void loaded.then(()=>{ready.settled=true;if(version===loadVersion.current)setRenderLoading(false)},()=>{ready.failed=true;if(version===loadVersion.current)setRenderLoading(false)})
  void loaded.then(()=>{if(version!==loadVersion.current||viewer.current!==instance)return;settleSceneCameraLoad(instance,sameScene,camera);if(worldRef.current?.sceneId===scene.sceneId)instance.setWorld(worldRef.current);if(selectedRef.current)instance.select(selectedRef.current);setCollisionStatus(instance.collisionStatus());const focus=pendingFocus.current;if(focus?.sceneId===scene.sceneId){instance.openDefaultView(focus.entityId);pendingFocus.current=undefined}}).catch(value=>setError(String(value)))
 // 这一版 setScene 落定（含 HDRI 加载）之后再读一次环境读数：面板显示的是画面真正生效的那一份。
 void loaded.then(()=>{if(viewer.current===instance)readEnvironmentStatus()}).catch(()=>undefined)
 },[open,viewerVisible,scene,readOnly])
 // 批注按场景装载/落盘：换场景换一份，刷新/重开工作台后回来；只在 sceneId 变化时重读，编辑不反复读盘。
 useEffect(()=>{setAnnotations(readAnnotations(scene?.sceneId));setActiveAnnotation(undefined)},[scene?.sceneId])
 useEffect(()=>{if(!scene?.sceneId)return;writeAnnotations(scene.sceneId,annotations)},[annotations,scene?.sceneId])
 // 批注的显示锚点来自"当前选中的场景是哪一个"，不是"场景快照是否已经取回来"：
 // 把同步挂在 Boolean(scene) 上，会让刷新后（快照尚未回来）落的点既不显示也不落盘——静默失败最坏。
 const annotationSceneId=scene?.sceneId??presentedScene.current?.sceneId??annotationScene.current
 // 交给编辑器回调读的"当前场景"也以同一判据为准（它同样不能等快照）。
 annotationScene.current=annotationSceneId
 // 每次批注或模式变化都把最新一份推给 viewer：锚点与世界位置的重算只发生在 viewer 内部。
 useEffect(()=>{viewer.current?.setAnnotations(annotations)},[annotations,open,viewerVisible,annotationSceneId])
 useEffect(()=>{viewer.current?.setAnnotationMode(annotating);viewer.current?.selectAnnotation(activeAnnotation)},[annotating,activeAnnotation,open,viewerVisible,annotationSceneId])
 // 附着性自述（验收门读的就是它）：屏幕位置与锚点都来自 viewer 自己的投影，门不另算一套相机数学。
 // 只在浏览器里挂一个只读全局，不参与产品逻辑；没有批注时清空，避免残留上一次的读数骗过验收。
 useEffect(()=>{
  const publish=()=>{const instance=viewer.current;const rows=instance&&annotationsRef.current.length?instance.annotationProjections():[];(window as unknown as {__lyaAnnotationProbe?:unknown}).__lyaAnnotationProbe=rows}
  publish()
  // 只读探针：验收/诊断用（命中原因、加载错误、标记投影），产品逻辑不读它。
  ;(window as unknown as {__lyaViewerProbe?:unknown}).__lyaViewerProbe={pick:(x:number,y:number)=>viewer.current?.probePick(x,y),projections:()=>viewer.current?.annotationProjections()??[],scene:()=>viewer.current?.describeScene(),entity:(id:string)=>viewer.current?.probeEntityPixel(id),viewer:()=>viewer.current,
   // 交付验收读它：这一版交给 Viewer 的场景里，多少条资产引用换成了媒体标记、多少条没换成（`skipped`）。
   assetLocators:()=>assetRewiring.current}
  const timer=setInterval(publish,500)
  return()=>{clearInterval(timer);(window as unknown as {__lyaAnnotationProbe?:unknown}).__lyaAnnotationProbe=[]}
 },[open,viewerVisible,Boolean(scene)])
 const frameWorldReady=Boolean(world&&['ready','running','paused'].includes(world.status))
 useEffect(()=>{if(viewer.current)try{viewer.current.setWorld(world);setCollisionStatus(viewer.current.collisionStatus())}catch(value){setError(String(value))}},[open,viewerVisible,world?.worldId,world?.worldGeneration,world?.appliedSceneRevision,frameWorldReady])
 useEffect(()=>{if(!open||!world||!frameWorldReady)return;let alive=true,busy=false,geometryReceived=false
  const ids=selected&&scene?collisionRequestSelection(scene,selected).entityIds:[]
  const wantsTopology=viewerVisible&&display.collision===true&&['mujoco','isaac'].includes(world.engineId)&&ids.length>0&&scene?.sceneId===world.sceneId&&scene?.revision===world.appliedSceneRevision
  const poll=async()=>{if(busy)return;busy=true;try{
   // 新 Viewer/选择的图层可能没有几何；轮询闭包的“曾收到”不能代替当前图层的持有事实。
   const current=await api.frame(world.worldId,wantsTopology?{entityIds:ids,includeGeometry:!geometryReceived||viewer.current?.collisionStatus().needsGeometry===true}:undefined,uiState.tool==='camera'||uiState.tool==='annotation'||annotating||observerState?.mode==='camera-edit'?{cameraAuthoring:true}:undefined)
   if(!alive||apiRef.current!==api||worldRef.current?.worldId!==world.worldId)return
   if(current.generation!==worldRef.current.worldGeneration){await refreshState(sceneRef.current?.sceneId);return}
   if(current.sceneRevision!==worldRef.current.appliedSceneRevision||worldRef.current.engineId!==world.engineId){await refreshState(sceneRef.current?.sceneId);return}
   if(current.sceneRevision!==sceneRef.current?.revision||worldRef.current.appliedSceneRevision!==sceneRef.current?.revision){setFrame(undefined);const active=sceneRef.current,bound=worldRef.current;setWorldLifecycle(previous=>previous.sceneId===active?.sceneId&&previous.sceneRevision===active?.revision&&['syncing','failed','blocked','unsynced'].includes(previous.phase)?previous:{...worldLifecycleState({...bound,status:'unsynced'}),code:'WORLD_SCENE_UNSYNCED',detail:tr('场景编辑已保留，正在同步当前场景；同步完成前旧帧不会覆盖编辑，也不会恢复控制。','Scene edits are preserved while physics synchronizes. Old frames cannot overwrite edits or restore control.')});return}
   setFrame(current);setWorldLifecycle(sceneRef.current?.revision!==worldRef.current.appliedSceneRevision?{...worldLifecycleState({...worldRef.current,status:'unsynced'},current),code:'WORLD_SCENE_UNSYNCED',detail:tr('Scene已更新，物理世界待同步；先同步再执行动作。','The scene changed; synchronize physics before issuing actions.')}:worldLifecycleState(worldRef.current,current));viewer.current?.pushFrame(current)
   const topology=current.collisionTopology
   if(topology?.geometryIncluded&&topology.source===`${world.engineId}-compiled`&&topology.worldId===world.worldId&&topology.generation===worldRef.current.worldGeneration&&topology.sceneRevision===sceneRef.current?.revision)geometryReceived=true
   if(viewer.current)setCollisionStatus(viewer.current.collisionStatus())
  }catch(value){if(alive&&worldRef.current?.worldId===world.worldId){setReconnecting(true);setError(String(value));try{const refreshed=await refreshState(sceneRef.current?.sceneId);if(!refreshed.worlds.some(item=>item.worldId===world.worldId)){setReconnecting(false);setError("")}}catch{}}}finally{busy=false}}
  void poll();const timer=setInterval(poll,120);return()=>{alive=false;clearInterval(timer)}
 },[open,viewerVisible,renderRetry,world?.worldId,world?.engineId,world?.worldGeneration,world?.appliedSceneRevision,frameWorldReady,sessionId,selected,scene?.sceneId,scene?.revision,display.collision,uiState.tool,annotating,observerState?.mode])
 // 未装配世界的派生件只读加载也要更新状态；不发送 Frame、Commands 或另一份物理状态。
 useEffect(()=>{if(!open||!viewerVisible||!selected||frameWorldReady)return
  const read=()=>{const current=viewer.current?.collisionStatus();if(current)setCollisionStatus(previous=>JSON.stringify(previous)===JSON.stringify(current)?previous:current)}
  read();const timer=setInterval(read,250);return()=>clearInterval(timer)
 },[open,viewerVisible,selected,scene?.sceneId,scene?.revision,display.collision,frameWorldReady])
 useEffect(()=>{if(selected)setDisplay(value=>value.collision?value:{...value,collision:true})},[selected,scene?.sceneId])
 useEffect(()=>{viewer.current?.select(selected);if(viewer.current)setCollisionStatus(viewer.current.collisionStatus());const e=sceneRef.current?.entities.find(e=>e.entityId===selected);if(selected&&world&&e&&robotEntity(e))perform(()=>describe(selected))},[selected,world?.worldId,world?.worldGeneration,world?.appliedSceneRevision])
 useEffect(()=>{viewer.current?.setDisplaySettings(display);if(viewer.current)setCollisionStatus(viewer.current.collisionStatus())},[display]);useEffect(()=>{viewer.current?.setSceneLights(sceneLights)},[sceneLights]);useEffect(()=>{if(viewer.current)setAnimationSummary(applyAnimationDisplay(viewer.current,animationsPlaying))},[animationsPlaying]);useEffect(()=>{viewer.current?.setGizmoMode(gizmo)},[gizmo])
 // 同一 Viewer 的只读回执；异步载入/世界变化清授权后，控件不能仍假显示为播放中。
 useEffect(()=>{if(!open||!viewerVisible){setAnimationSummary(undefined);return}
  const read=()=>{const instance=viewer.current;if(!instance)return;const next=instance.animationSummary();setAnimationSummary(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next)}
  read();const timer=setInterval(read,250);return()=>clearInterval(timer)
 },[open,viewerVisible,renderRetry,scene?.sceneId,world?.worldId,world?.worldGeneration])
 // 活动官方世界自带只读 Scene 投影：把它设为当前场景（同一 world 的 sceneId），
 // 不注册进场景列表，也不经过任何持久 Scene owner。
 useEffect(()=>{
  if(!open||!official||!world)return
  const id=world.sceneId
  if(!id||sceneRef.current?.sceneId===id)return
  projectedScene.current=id;sceneIntent.current=id
  void refreshState(id).catch(value=>setError(String(value)))
 },[open,official,world?.worldId,world?.sceneId])
 // 官方世界关闭后它的投影 Scene 也不存在了：退回普通场景，别让轮询继续打一个失效的 sceneId。
 useEffect(()=>{
  if(!open)return
  const id=projectedScene.current
  if(!id)return
  if(worlds.some(item=>item.sceneId===id&&item.engineId==="official-suite"&&item.status!=="closed"))return
  projectedScene.current=undefined
  setScene(undefined);sceneRef.current=undefined;setSelected(undefined);setBatchIds([]);setDescriptions({});setTargets({});setFrame(undefined);setWorld(undefined);worldRef.current=undefined
  setError("");setReconnecting(false);setOfficialCamera(false)
  const fallback=scenes.find(item=>item.sceneId!==id)?.sceneId
  if(fallback)void loadScene(fallback).catch(value=>setError(String(value)))
 },[open,worlds,scenes])
 useEffect(()=>{if(!open||readOnly||!sessionId||!scene)return;void refreshHistory(scene.sceneId).catch(value=>{if(sceneRef.current?.sceneId===scene.sceneId)setError(String(value))})},[open,readOnly,sessionId,scene?.sceneId,scene?.revision])
 // Include-deleted is a native asset_list query boundary; search remains explicit.
 // 素材与内置库是四个域面板（机器人/物件/环境/素材）的共同数据源：任一面板打开都刷新同一份状态，
 // 域面板不另取一份。素材面板按自己的搜索词取列表；机器人/物件/环境面板始终取未过滤列表，
 // 否则素材面板的一次搜索会把域面板切成同一个子集。
 useEffect(()=>{if(!open||!sessionId)return;const tool=uiState.tool;if(tool!=="asset"&&tool!=="environment"&&tool!=="robot"&&tool!=="object"&&tool!=="scene")return;void Promise.all([refreshAssets(tool==="asset"?assetQuery:"",includeDeleted),refreshMissingAssets(),refreshBuiltinAssets()]).catch(value=>setError(String(value)))},[open,sessionId,uiState.tool,includeDeleted])
 const updateScene=async(input:SceneCommit)=>{
  // 官方派生 Scene 只读：不把编辑写进任何 Scene owner。
  if(worldRef.current?.engineId==="official-suite")throw new Error(tr("官方世界的场景是只读投影，不能编辑。","The official world's scene is a read-only projection and cannot be edited."))
  if(readOnlyRef.current)throw new Error("SCENE_READ_ONLY")
  const requestAPI=apiRef.current,bound=worldRef.current
  const next=await requestAPI.command<SceneSnapshot>("scene_edit",input,{sceneId:input.sceneId,...bound?.sceneId===input.sceneId?{worldId:bound.worldId}:{}})
  if(apiRef.current===requestAPI&&applySceneIfCurrent(sceneWritePort,input.sceneId,next)==='applied'){
   nativeControlCancel.current?.();setFrame(undefined)
   if(worldRef.current?.sceneId===next.sceneId&&worldRef.current.appliedSceneRevision!==next.revision)setWorldLifecycle({...worldLifecycleState({...worldRef.current,status:'unsynced'}),code:'WORLD_SCENE_UNSYNCED',detail:tr('编辑已提交，正在自动同步物理世界。','The edit is committed; physics synchronization follows automatically.')})
  }
  return next
 }
 const saveCameraInstallation=async(input:CameraSceneSaveInput)=>{
  if(cameraReadOnlyRef.current||worldRef.current?.engineId==='official-suite')throw Error('CAMERA_SAVE_READ_ONLY')
  const requestAPI=apiRef.current,bound=worldRef.current
  const result=await requestAPI.command<{snapshot:SceneSnapshot;entityId:string}>('camera_scene_save',{...input,clientId:requestAPI.clientId},{sceneId:input.sceneId,...bound?.sceneId===input.sceneId?{worldId:bound.worldId}:{}})
  if(apiRef.current===requestAPI&&applySceneIfCurrent(sceneWritePort,input.sceneId,result.snapshot)==='applied'){
   nativeControlCancel.current?.();setFrame(undefined)
   if(worldRef.current?.sceneId===input.sceneId&&worldRef.current.appliedSceneRevision!==result.snapshot.revision)setWorldLifecycle({...worldLifecycleState({...worldRef.current,status:'unsynced'}),code:'WORLD_SCENE_UNSYNCED',detail:tr('相机安装已保存，正在同步当前物理世界。','Camera installation saved; the current physical world is synchronizing.')})
  }
  return result
 }
 // Viewer拖拽和属性数值共用同一CAS入口；模型scene_edit写入后由同一revision effect跟进。
 commitEditRef.current=async input=>updateScene({sceneId:input.sceneId,expectedRevision:input.expectedRevision,patch:[{op:'update',entityId:input.entityId,changes:{transform:input.transform}}]})
 /**
  * 命名相机 → 场景文档：**唯一**的写入路径（相机面板按钮与模型工具 saveAs 都走它）。
  *
  * 为什么不是一张 host 表、也不是 localStorage：命名相机是"这个场景里的几个机位"，属于场景内容——
  * 要随工程移动、能被另一个窗口/客户端读到、跟着版本历史回退。落成实体组件（`components.viewerCamera`）
  * 就全都成立，而且写路径就是产品已有的 `scene_edit`（CAS，冲突会失败而不是覆盖别人）。
  * 组件已经在某个实体上就改它（承载实体由文档自己决定）；没有就新加一条只带这个组件的实体。
  * 空表也照写：它表示"这个场景现在没有命名相机"，不是错误。
  */
 const writeNamedCameras=async(sceneId:string,expectedRevision:number,next:readonly NamedCamera[]):Promise<SceneSnapshot>=>{
  const entities=sceneRef.current?.sceneId===sceneId?sceneRef.current.entities:undefined
  const carrierId=namedCamerasOfScene(entities).carrier
  const carrier=carrierId?entities?.find(entity=>entity.entityId===carrierId):undefined
  const component=composeViewerCameraComponent(next)
  if(carrier)return await updateScene({sceneId,expectedRevision,patch:[{op:"update",entityId:carrier.entityId,changes:{components:{...carrier.components,viewerCamera:component}}}]})
  const entity:Entity={entityId:crypto.randomUUID(),name:tr("命名相机","Named cameras"),transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{viewerCamera:component}}
  return await updateScene({sceneId,expectedRevision,patch:[{op:"add",entity}]})
 }
 const restoreVersion=async(revision:number)=>{
  const current=sceneRef.current
  if(!current||revision===current.revision)return
  const prompt=tr(`把 ${current.sceneId} 从版本 ${current.revision} 恢复到版本 ${revision}？编辑后会自动同步当前物理世界。`,`Restore ${current.sceneId} from revision ${current.revision} to revision ${revision}? The current physics world will synchronize after the edit.`)
  if(typeof window!=="undefined"&&!window.confirm(prompt))return
  // expectedRevision is deliberately read immediately before the request: a
  // concurrent edit then fails closed in SceneStore and leaves the visible
  // current snapshot untouched.
  const restored=await runRestoreFollowthrough({...sceneWritePort,command:(name,value)=>api.command<any>(name,value),applyScene:value=>{setScene(value as SceneSnapshot);sceneRef.current=value as SceneSnapshot},refreshHistory:()=>refreshHistory(current.sceneId),notify:setNotice},{sceneId:current.sceneId,revision,expectedRevision:current.revision,movedNotice:sceneId=>tr(`场景 ${sceneId} 已恢复到版本 ${revision} 并提交；当前视图已切换到其他场景，未改写当前视图。`,`Scene ${sceneId} was restored to revision ${revision} and committed; the view has moved to another scene, so the current view was left untouched.`),supersededNotice:()=>tr("恢复操作已提交，场景随后又有更新；继续显示当前版本。","The restore was committed, then the scene changed again. Keeping the current version."),restoredNotice:restoredRevision=>tr(`场景 ${current.sceneId} 已恢复到历史版本 ${revision}（当前 rev ${restoredRevision}）；物理世界将自动同步。`,`Scene ${current.sceneId} restored to revision ${revision} (now rev ${restoredRevision}). Physics will synchronize automatically.`)})
  return restored.snapshot as SceneSnapshot
 }
 const openWorld=async(chosen:SceneSnapshot,signal:AbortSignal,options:Pick<WorldOptions,'startPaused'>={})=>{
  // 命令发出时的选择身份：Scene 与用户当时选中的 world。它随内部请求发给服务端做同一套归属核对，
  // 命令自己也按它核对返回值：返回的 world 必须属于请求时的 Scene，且期间用户没有改选。
  // 同 Scene 连续新建 world 是正常动作（Simulate 在已有 world 时也可点），照常采用新结果。
  const requested=chosen.sceneId,worldAtStart=worldRef.current?.worldId
  const test=physicalTestSpaceOf(chosen)
  const actualEngine=test?(await api.request<{engine?:string|null}>("runtime-info")).engine:undefined
  const w=await api.command<WorldHandle>("sim_open",physicalTestWorldInput(chosen,actualEngine,options.startPaused),{sceneId:requested,worldId:worldAtStart},signal)
  if(test){try{
   const d=await api.request<RobotDescription>('robot-description?'+new URLSearchParams({worldId:w.worldId,entityId:test.robotId})),f=await api.frame(w.worldId,undefined,{entityIds:[test.robotId],sensors:true,contacts:true}),missing=physicalTestMissingCapabilities(chosen,w,d,f)
   if(missing.length)throw new Error('PHYSICS_TEST_CAPABILITY_MISSING: '+missing.join('; ')+'。可显式选择MuJoCo专项测试；未更改已保存引擎偏好。')
  }catch(error){await api.command("sim_close",{worldId:w.worldId},{sceneId:requested,worldId:w.worldId});throw error}
  }
  return w
 }
 const ensureSceneWorld=async(explicit=false)=>{
  const chosen=sceneRef.current,host=hostId.current,requestAPI=api
  if(!chosen||!host||!sessionId||readOnly)return
  const worldAtStart=worldRef.current?.worldId
  const w=await automaticWorld.ensure(sessionId,host,chosen,{reconcile:async(snapshot,signal)=>{signal.throwIfAborted();const result=await api.command<{snapshot:SceneSnapshot;pending:boolean;issues:Array<{entityId:string;resourceId?:string;version?:number;reason:string}>}>('scene_reconcile_physics',{sceneId:snapshot.sceneId,expectedRevision:snapshot.revision,retryFailed:false,waitForPending:true});signal.throwIfAborted();return result},acceptScene:snapshot=>{if(apiRef.current===requestAPI&&sceneRef.current?.sceneId===snapshot.sceneId)applySceneIfCurrent(sceneWritePort,snapshot.sceneId,snapshot)},prepareWorld:async(snapshot,signal)=>{signal.throwIfAborted();return api.command<SceneSnapshot>('scene_prepare_world',{sceneId:snapshot.sceneId,expectedRevision:snapshot.revision},undefined,signal)},list:async()=>{const worlds=(await api.state({sceneId:chosen.sceneId})).worlds;return worldAtStart&&worlds.some(w=>w.worldId===worldAtStart&&w.sceneId===chosen.sceneId)?worlds.filter(w=>w.worldId===worldAtStart):worlds},open:openWorld,setPaused:(bound,paused,signal)=>api.command<WorldHandle>('sim_set_paused',{worldId:bound.worldId,paused,expectedGeneration:bound.worldGeneration},{sceneId:bound.sceneId,worldId:bound.worldId},signal),sync:(snapshot,bound,signal)=>api.command<WorldHandle>('sim_sync',{sceneId:snapshot.sceneId,worldId:bound.worldId},{sceneId:snapshot.sceneId,worldId:bound.worldId},signal),observe:id=>api.frame(id),close:id=>api.command('sim_close',{worldId:id},{sceneId:chosen.sceneId,worldId:id})},explicit)
  if(!w||apiRef.current!==requestAPI||hostId.current!==host||sceneRef.current?.sceneId!==chosen.sceneId||(worldRef.current?.worldId!==worldAtStart&&worldRef.current?.worldId!==w.worldId))return
  if(w.appliedSceneRevision!==sceneRef.current?.revision)return
  const adopted=adoptWorldHandle(w,worldRef.current)!
  if(adopted.worldId!==worldRef.current?.worldId||adopted.worldGeneration!==worldRef.current?.worldGeneration){setDescriptions({});descriptionsRef.current={};setTargets({});targetsRef.current={}}
  setWorld(adopted);worldRef.current=adopted;setFrame(undefined);persist(sceneRef.current,adopted)
  return adopted
 }
 const startWorld=()=>ensureSceneWorld(true)
 const setWorldPaused=async(paused:boolean)=>{
  const bound=worldRef.current,requestAPI=api;if(!bound)throw Error('WORLD_NOT_FOUND')
  const result=await api.command<WorldHandle>('sim_set_paused',{worldId:bound.worldId,paused,expectedGeneration:bound.worldGeneration})
  if(apiRef.current!==requestAPI||!sameWorldBinding(bound,worldRef.current))return
  const observed=await api.frame(bound.worldId)
  if(observed.generation!==result.worldGeneration||observed.sceneRevision!==result.appliedSceneRevision)throw Error('WORLD_CLOCK_FRAME_STALE')
  const adopted=adoptWorldHandle(result,worldRef.current)!;setWorld(adopted);worldRef.current=adopted
  setFrame(observed);viewer.current?.pushFrame(observed);setWorldLifecycle(worldLifecycleState(adopted,observed))
 }
 const configureWorldGravity=async(gravity:Vec3)=>{
  const current=sceneRef.current,requestAPI=api;if(!current)throw Error('SCENE_NOT_FOUND')
  const snapshot=await api.command<SceneSnapshot>('scene_configure_physics',{sceneId:current.sceneId,expectedRevision:current.revision,gravityWorldMps2:gravity})
  if(apiRef.current===requestAPI&&sceneRef.current?.sceneId===current.sceneId)applySceneIfCurrent(sceneWritePort,current.sceneId,snapshot)
 }
 const preparePhysicsWorkspace=async()=>{
  const current=sceneRef.current,requestAPI=api;if(!current)throw Error('SCENE_NOT_FOUND')
  const snapshot=await api.command<SceneSnapshot>('scene_prepare_workspace',{sceneId:current.sceneId,expectedRevision:current.revision})
  if(apiRef.current===requestAPI&&sceneRef.current?.sceneId===current.sceneId)applySceneIfCurrent(sceneWritePort,current.sceneId,snapshot)
 }
 const closePhysicsWorld=async()=>{
  const closing=worldRef.current;if(!closing)return;automaticWorld.markClosed()
  await api.command('sim_close',{worldId:closing.worldId},{sceneId:sceneRef.current?.sceneId,worldId:closing.worldId})
  if(worldRef.current?.worldId===closing.worldId){setWorld(undefined);worldRef.current=undefined;setFrame(undefined)}
  await refreshState(sceneRef.current?.sceneId);setError('')
 }

 const changePhysics=async(name:'scene_physics_update'|'scene_bind_physics',input:PhysicsUpdateInput|PhysicsBindInput,signal?:AbortSignal)=>{
  if(readOnly||replayActive)throw Error('PHYSICS_EDIT_READ_ONLY')
  setNotice('');setError('')
  nativeControlCancel.current?.()
  const requestAPI=api,selectionAtStart=selectedRef.current
  const result=await runPhysicsMutation(name,input,{scene:()=>apiRef.current===requestAPI?sceneRef.current:undefined,world:()=>worldRef.current,selected:()=>selectedRef.current,
   command:(command,value,selection)=>api.command(command,value,selection,signal),applyScene:snapshot=>applySceneIfCurrent(sceneWritePort,input.sceneId,snapshot),sync,start:startWorld,observe:id=>api.frame(id),
   applyFrame:current=>{setFrame(current);viewer.current?.pushFrame(current);if(worldRef.current)setWorldLifecycle(worldLifecycleState(worldRef.current,current));if(viewer.current)setCollisionStatus(viewer.current.collisionStatus())}})
  if(result.stale)return
  if(name==='scene_bind_physics')await refreshAssets('')
  if(apiRef.current!==requestAPI||sceneRef.current?.sceneId!==input.sceneId||selectedRef.current!==selectionAtStart)return
  setNotice(result.synced?tr('物理配置已保存并同步，已读取当前版本的原生物理帧。','Physics configuration saved and synchronized; a native frame for the current revision was read.'):tr('物理配置已保存；物理世界尚未就绪，请查看世界状态。','Physics configuration saved; the physics world is not ready. Check its status.'))
  return result
 }
 const applyRobotConfiguration=async(name:'robot_set_tcp'|'robot_set_base'|'sim_reset',input:RobotSetTcpInput|RobotSetBaseInput|{worldId:string;sceneId:string;expectedRevision:number;expectedGeneration:number})=>{
  if(readOnly||replayActive)throw Error('ROBOT_CONFIGURATION_READ_ONLY')
  nativeControlCancel.current?.()
  const requestAPI=api,bound=worldRef.current,selection=selectedRef.current
  const result=await api.command<{snapshot:SceneSnapshot;world:WorldHandle;frame:Frame;robot?:RobotDescription}>(name,input,{sceneId:input.sceneId,worldId:input.worldId})
  if(apiRef.current!==requestAPI||sceneRef.current?.sceneId!==input.sceneId||worldRef.current?.worldId!==bound?.worldId||selectedRef.current!==selection)return result
  if(result.snapshot.sceneId!==input.sceneId||result.world.worldId!==input.worldId||result.world.appliedSceneRevision!==result.snapshot.revision||result.frame.worldId!==input.worldId||result.frame.generation!==result.world.worldGeneration||result.frame.sceneRevision!==result.snapshot.revision)throw Error('ROBOT_CONFIGURATION_FRAME_STALE')
  if(sceneRef.current.revision>result.snapshot.revision||(worldRef.current?.worldGeneration??0)>result.world.worldGeneration)return result
  applySceneIfCurrent(sceneWritePort,input.sceneId,result.snapshot)
  const adopted=adoptWorldHandle(result.world,worldRef.current)!
  setWorld(adopted);worldRef.current=adopted;setDescriptions({});descriptionsRef.current={};setTargets({});targetsRef.current={};persist(result.snapshot,adopted)
  viewer.current?.setWorld(adopted);setFrame(result.frame);viewer.current?.pushFrame(result.frame);setWorldLifecycle(worldLifecycleState(adopted,result.frame))
  if(result.robot){setDescriptions({[result.robot.entityId]:result.robot});descriptionsRef.current={[result.robot.entityId]:result.robot}}
  else if(selection)await describe(selection)
  return result
 }
 const manualTcpMove=async(deltaM:Vec3)=>{
  const bound=worldRef.current,current=sceneRef.current,entityId=selectedRef.current,requestAPI=api
  if(!bound||!current||!entityId||readOnly||replayActive||bound.appliedSceneRevision!==current.revision)throw Error('ROBOT_TCP_SYNC_REQUIRED: 先同步当前场景')
  const result=await api.command<any>('robot_move_tcp',{worldId:bound.worldId,robotId:entityId,expectedGeneration:bound.worldGeneration,deltaM,durationS:Math.min(5,Math.max(.1,duration))})
  const observed=await api.frame(bound.worldId,undefined,{sensors:true,contacts:true})
  if(apiRef.current===requestAPI&&sameWorldBinding(bound,worldRef.current)&&sceneRef.current?.revision===observed.sceneRevision&&observed.generation===bound.worldGeneration){setFrame(observed);viewer.current?.pushFrame(observed)}
  return result
 }
 useEffect(()=>{
  if(!open||!sessionId||!scene||!providerAvailable||readOnly){automaticWorld.leave();if(scene&&!providerAvailable)setWorldLifecycle({phase:'blocked',sceneId:scene.sceneId,code:'PROVIDER_UNAVAILABLE',detail:tr('当前Host未装配可用物理引擎；请检查已保存偏好与运行依赖。','The current Host has no physics provider; check the saved preference and runtime dependencies.')});return}
  void ensureSceneWorld().catch(value=>setError(String(value)))
 },[open,sessionId,scene?.sceneId,scene?.revision,providerAvailable,readOnly,worldHostEpoch])
 useEffect(()=>()=>automaticWorld.leave(),[open,sessionId,scene?.sceneId,providerAvailable,readOnly,worldHostEpoch])
 const resetPhysicalTest=async()=>{
  const current=sceneRef.current
  if(!current||!physicalTestSpaceOf(current))return
  const oldWorld=worldRef.current
  if(oldWorld){
   await api.command("sim_stop",{worldId:oldWorld.worldId,expectedGeneration:oldWorld.worldGeneration},{sceneId:current.sceneId,worldId:oldWorld.worldId})
   await api.command("sim_close",{worldId:oldWorld.worldId},{sceneId:current.sceneId,worldId:oldWorld.worldId})
   if(worldRef.current?.worldId!==oldWorld.worldId||sceneRef.current?.sceneId!==current.sceneId)return
   setWorld(undefined);worldRef.current=undefined;setFrame(undefined)
  }
  if(sceneRef.current?.sceneId!==current.sceneId)return
  const initial=current.revision===0?current:await api.command<SceneSnapshot>("scene_restore",{sceneId:current.sceneId,revision:0,expectedRevision:current.revision})
  if(sceneRef.current?.sceneId!==current.sceneId)return
  sceneRef.current=initial;setScene(initial);await refreshHistory(initial.sceneId)
  await startWorld();setNotice(tr("已停止旧动作，按初始工程重建物理世界；请继续在对话中测试。","Stopped old actions and rebuilt the physical world from the initial project. Continue testing in the conversation."))
 }
 const sync=async()=>{
  const w=await ensureSceneWorld(true)
  if(!w)throw new Error('WORLD_SYNC_NOT_READY: 当前场景尚未与原生世界完成同步；请查看物理状态中的具体原因后重试。')
  return w
 }
 /** 相机只准备当前 Scene 的原世界；引擎/SDK事实来自 Host，不切引擎或启动语言任务。 */
 const prepareCameraWorld=async(expectedSceneId:string)=>{
  const chosen=sceneRef.current,requestAPI=api
  if(!chosen||chosen.sceneId!==expectedSceneId||readOnly||replayActive)throw new Error("CAMERA_SCENE_READ_ONLY: 当前场景不可编辑或已切换")
  const facts=await api.request<EngineProvidersPayload>("engine-providers"),running=facts.runningEngine
  if(apiRef.current!==requestAPI||sceneRef.current?.sceneId!==expectedSceneId)return
  if(facts.preference&&facts.preference!==running)throw new Error(`CAMERA_ENGINE_RESTART_REQUIRED: 已指定 ${facts.preference}，当前 Host 为 ${running??"未装配"}；按设置提示重启工作台后再准备相机。`)
  if(running!=="isaac"&&running!=="mujoco")throw new Error(`CAMERA_ENGINE_UNAVAILABLE: 当前 Host 为 ${running??"未装配"}，机器人相机需要已装配的 Isaac 或 MuJoCo。`)
  const existing=worldRef.current?.sceneId===expectedSceneId?worldRef.current:undefined
  const provider=facts.providers.find(row=>row.id===running)
  if(!provider?.installed&&(!existing||!["ready","running","paused"].includes(existing.status)))throw new Error(`CAMERA_SDK_NOT_READY: ${provider?.label??running} · ${provider?.detail??"当前 Host 未提供该 SDK 的就绪事实"}`)
  if(existing&&existing.status!=="closed"&&existing.engineId!==running)throw new Error(`CAMERA_WORLD_ENGINE_MISMATCH: 当前世界为 ${existing.engineId}，Host 指定 ${running}。`)
  if(existing?.status==="unavailable")throw new Error("CAMERA_WORLD_UNAVAILABLE: 当前原生世界不可用，请先查看世界失败原因。")
  if(running==="isaac"&&!facts.licenses.isaac&&(!existing||existing.status==="closed"))throw new Error("CAMERA_ENGINE_LICENSE_REQUIRED: 当前 SDK 尚无 NVIDIA Omniverse EULA 接受记录，请在引擎设置中处理许可。")
  const prepared=existing&&existing.status!=="closed"?existing:await ensureSceneWorld(true)
  if(!prepared||apiRef.current!==requestAPI||sceneRef.current?.sceneId!==expectedSceneId)return
  if(prepared.engineId!==running)throw new Error(`CAMERA_WORLD_ENGINE_MISMATCH: 物理世界返回 ${prepared.engineId}，Host 指定 ${running}。`)
  return prepared.appliedSceneRevision!==sceneRef.current.revision||prepared.status==="unsynced"?await sync():prepared
 }

 const move=async(name:string,motion:EntityMotion|{kind:"batch";motions:EntityMotion[]},label:string,bound?:WorldHandle,display?:ControlGestureDisplay,signal?:AbortSignal)=>{if(replayActive)throw new Error("RECORDED_REPLAY_IS_READ_ONLY");const w=bound??worldRef.current;if(!w)return;const actionId=crypto.randomUUID(),id=display?"gesture:"+controlGestureKey({...display,clientId:api.clientId}):actionId;setActions(old=>upsertControlActionRow(old,{id,label,waiting:true,...display?{display}:{}}));setError("")
  try{const receipt=await api.command<ActionReceipt>(name,{worldId:w.worldId,action:{...motion,actionId,expectedGeneration:w.worldGeneration}},{sceneId:w.sceneId,worldId:w.worldId},signal,display);setActions(old=>old.map(item=>item.id===id&&(!display||item.display?.sequence===display.sequence)?{...item,waiting:false,receipt}:item));if(name==="robot_move"&&motion.kind==="joint")manualDrafts.current.delete(motion.entityId);return receipt}catch(value){setActions(old=>old.map(item=>item.id===id&&(!display||item.display?.sequence===display.sequence)?{...item,waiting:false,error:String(value)}:item));throw value}
 }
 const fullMotion=(id:string):EntityMotion=>{const d=descriptionsRef.current[id];if(!d?.controlledJointNames.length)throw new Error(tr("该实体没有可控制关节。","No controlled joints are available."));const jointNames=d.controlledJointNames,positions=requireFullJointTargets(d,targetsRef.current[id]??{});if(!Number.isFinite(duration)||duration<=0)throw Error("CONTROL_DURATION_INVALID");return {kind:"joint",entityId:id,jointNames,positions:positions as number[],durationS:duration}}
 const nativeJointMove=async(motion:EntityMotion,display?:ControlGestureDisplay,signal?:AbortSignal):Promise<NativeJointResult>=>{
  const bound=worldRef.current,current=sceneRef.current,requestAPI=api
  if(apiRef.current!==requestAPI||!bound||!current||readOnly||replayActive||bound.appliedSceneRevision!==current.revision||motion.kind!=="joint"||motion.entityId!==selectedRef.current||motion.jointNames.length!==1)throw new Error("NATIVE_CONTROL_SELECTION_CHANGED: 原生手调只控制当前已同步选中的单关节")
  const d=descriptionsRef.current[motion.entityId],joint=d?.joints.find(j=>j.name===motion.jointNames[0])
  if(!d||d.expectedGeneration!==bound.worldGeneration||!d.controlledJointNames.includes(motion.jointNames[0]!)||!joint?.controlMode||!joint.range?.every(Number.isFinite))throw new Error("NATIVE_CONTROL_NOT_AVAILABLE: 当前关节缺少真实执行器、限位或描述代次已变化")
  const invalid=jointTargetError(joint,motion.positions[0]);if(invalid)throw Error(invalid);if(display&&(display.worldId!==bound.worldId||display.generation!==bound.worldGeneration||display.entityId!==motion.entityId||display.jointName!==motion.jointNames[0]))throw Error("INVALID_CONTROL_GESTURE_SCOPE")
  signal?.throwIfAborted()
  const receipt=await move("joint_move",motion,tr("原生单关节手调","Native joint adjustment"),bound,display,signal)
  if(!receipt)throw new Error("NATIVE_CONTROL_NO_RECEIPT")
  signal?.throwIfAborted()
  if(apiRef.current!==requestAPI||motion.entityId!==selectedRef.current||!sameWorldBinding(bound,worldRef.current))throw new Error("NATIVE_CONTROL_SELECTION_CHANGED: 迟到回执不应用到新窗口或新选择")
  const at=performance.now(),observed=await api.frame(bound.worldId)
  signal?.throwIfAborted()
  if(apiRef.current!==requestAPI||motion.entityId!==selectedRef.current||!sameWorldBinding(bound,worldRef.current)||observed.generation!==bound.worldGeneration||observed.sceneRevision!==sceneRef.current?.revision||observed.sceneRevision!==bound.appliedSceneRevision)throw new Error("NATIVE_CONTROL_SELECTION_CHANGED: 迟到回执不应用到新窗口、新选择或新世界 / 场景版本")
  const joints=observed.entities.find(e=>e.entityId===motion.entityId)?.joints,index=joints?.names.indexOf(motion.jointNames[0]!)??-1
  const actual=index>=0?joints?.positions[index]:undefined
  setFrame(observed);viewer.current?.pushFrame(observed)
  return {receipt,observedStep:observed.stepIndex,actualPosition:typeof actual==="number"&&Number.isFinite(actual)?actual:null,observedLatencyMs:performance.now()-at,...display?{display}:{}}
 }
 // 批量控制的发出身份按「发起时」绑定：等待描述期间用户把视图切到别的 world（例如同一 Scene 里
 // 同名机器人的另一个世界）时，这次批量作废——不得把等待期间就绪的新描述/新目标发到新世界上。
 const batch=async()=>{const bound=worldRef.current;if(!bound)return
  const stillBound=()=>sameWorldBinding(bound,worldRef.current)
  const cancel=()=>{setNotice(tr("多机器人同时执行已取消：等待描述期间目标世界已改变，未向任何世界发出动作。","Multi-robot execution cancelled: the target world changed while descriptions were loading; no action was sent to any world."));return undefined}
  for(const id of batchIds){if(descriptionsRef.current[id])continue;await describe(id);if(!stillBound())return cancel()}
  if(!stillBound())return cancel()
  return move("sim_execute_batch",{kind:"batch",motions:batchIds.map(fullMotion)},tr("多机器人同一步开始","Synchronized multi-robot start"),bound)}
 const stop=async(all=false)=>{const display=nativeControlCancel.current?.();const bound=worldRef.current;if(!bound)return;const r=await api.command<{stopped:boolean;stepIndex:number;receipts?:ActionReceipt[]}>("sim_stop",{worldId:bound.worldId,expectedGeneration:bound.worldGeneration,...!all&&selectedRef.current?{entityIds:[selectedRef.current]}:{}},{sceneId:bound.sceneId,worldId:bound.worldId},undefined,!all?display:undefined);if(!sameWorldBinding(bound,worldRef.current))return r;if(r.receipts?.length)setActions(old=>settleStoppedActions(old,r.receipts!));setNotice(r.stopped?tr(`已确认停止动作，step ${r.stepIndex}；物理状态按当前世界读回。`,`Actions stopped at step ${r.stepIndex}; physics status is read from the current world.`):tr("已请求取消动作，等待确认。","Action cancellation requested; waiting for confirmation."));await refreshState(sceneRef.current?.sceneId);return r}
 useEffect(()=>{manualDrafts.current.clear()},[api,scene?.sceneId,world?.worldId,world?.worldGeneration])
 useEffect(()=>{
  const bridge=window.lyapunovDesktop as (DesktopBridge&{registerExitParticipant?:(id:string,participant:{summary:()=>{dirtyDrafts:number;runningActions:number};flush:()=>Promise<void>;stop?:()=>Promise<void>})=>()=>void;onExitStateChanged?:(listener:(committing:boolean)=>void)=>()=>void})|undefined
  const removeState=bindControlExitState(bridge,api,setManualControlBlocked)
  const removeParticipant=bridge?.registerExitParticipant?.('manual-controls.'+api.clientId,{
   summary:()=>({dirtyDrafts:manualDrafts.current.size,runningActions:manualActions.current.filter(row=>row.waiting).length}),
   flush:async()=>{if(manualDrafts.current.size)throw Error('MANUAL_TARGET_DRAFT_PENDING: 控制参数尚未提交或清除；退出不会自动执行这些目标。')},
   stop:async()=>{const bound=worldRef.current;if(!bound)return;nativeControlCancel.current?.();const requestAPI=apiRef.current,result=await requestAPI.command<{stopped:boolean}>('sim_stop',{worldId:bound.worldId,expectedGeneration:bound.worldGeneration},{sceneId:bound.sceneId,worldId:bound.worldId});if(apiRef.current!==requestAPI||!sameWorldBinding(bound,worldRef.current)||result.stopped!==true)throw Error('MANUAL_STOP_NOT_CONFIRMED: 未确认原世界动作已停止。')}
  })
  return()=>{removeParticipant?.();removeState()}
 },[api])
 const takeCapture=async()=>{if(replayActive)throw new Error("RECORDED_REPLAY_IS_READ_ONLY");if(!viewer.current)return;const value=await api.capture(viewer.current.capture());setCaptures(old=>[value,...old]);setCapture(value);ui.openTool("camera");return value}
 /**
  * 批注专有动作：落盘与"交给模型"都只发生在这一次收集里，不随每次落点往返 host。
  *
  * 截图里的编号点由 viewer 烧进像素（模型看的是图，图上没有编号它就对不上"第 3 条"），
  * 同一份锚点与文字随采集回执落盘，模型侧 `viewer_annotation_read` 再把图与文字一起取回。
  * 编号在面板、标记、截图三处同源；这里传出去的 rows 就是三处共用的那一份。
  */
 const annotationActions={
  toggleMode:()=>setAnnotating(value=>!value),
  select:(annotationId:string)=>setActiveAnnotation(annotationId),
  text:(annotationId:string,text:string)=>setAnnotations(old=>old.map(item=>item.annotationId===annotationId?{...item,text}:item)),
  // 删除后立刻重排编号：编号是**显示序号**，面板/标记/截图三处必须同一个，
  // 不能等下一次从 localStorage 读回来才对齐（那中间会短暂出现 1,2,4 这样的断号）。
  remove:(annotationId:string)=>{setAnnotations(old=>old.filter(item=>item.annotationId!==annotationId).map((item,index)=>({...item,index:index+1})));setActiveAnnotation(current=>current===annotationId?undefined:current)},
  capture:async()=>{
   const instance=viewer.current
   if(!instance)throw new Error("VIEWER_UNAVAILABLE")
   const sceneId=sceneRef.current?.sceneId
   if(!sceneId)throw new Error("ANNOTATION_REQUIRES_SCENE")
   if(annotationsRef.current.length===0)throw new Error("ANNOTATION_EMPTY")
   const value=await instance.captureAnnotated()
   // 批注常落在子实体上（GLB 的 node 级实体，名字是 "textured.obj" 之类），而人认的是它父级的名字（"测试苹果"）。
   // 说明里给"父级 › 本名"，让模型既能对上人的说法，也能拿到可操作的 entityId。
   const nameOf=(entityId:string):string|undefined=>{
    const entities=sceneRef.current?.entities??[]
    const byId=new Map(entities.map(entity=>[entity.entityId,entity]))
    const self=byId.get(entityId)
    if(!self)return entityId.split(":")[0]
    // 人类认的是导入时起的名字（"测试苹果"），而锚点常落在 GLB 内部的叶子实体（"textured.obj"）上；
    // 中间的 "world"/"normalized_root"/"源坐标转换" 是导入器加的技术层，对模型没有信息量，跳过。
    const noise=/^(world|normalized_root|scene|root|source|源坐标转换)$/i
    const chain:string[]=[]
    for(let node:{entityId:string;name:string;parentId?:string}|undefined=self;node;node=node.parentId?byId.get(node.parentId):undefined){
      if(!noise.test(node.name))chain.unshift(node.name)
    }
    return chain.length?chain.join(" › "):self.name
   }
   const rows=annotationRows(value.annotations??annotationsRef.current,nameOf)
   // 说明里带的是**每条批注的像素/归一化坐标 + 实体与局部坐标 + 相机位姿**：模型看图只知道"第 3 个圈在哪块像素"，
   // 不知道它对应场景里哪个实体、什么视角；这几行补上，并且默认直接投进当前会话（用户不必再打一句"看一下"）。
   const prompt=annotationPromptText({sceneId:sceneRef.current?.sceneId,sceneRevision:sceneRef.current?.revision,pins:value.pins.map(pin=>({...pin,entityName:nameOf(pin.entityId)})),pose:value.pose,imagePath:undefined,imageURL:undefined})
   // 会话 id 必须显式带过去：viewer_capture 的 payload 本来不含它，而"把说明投进对话"需要目标会话。
   const record=await api.capture({...value,sessionId,annotations:rows,prompt,inject:injectAnnotationsRef.current})
   setAnnotationPrompt(prompt)
   setCaptures(old=>[record,...old])
   setAnnotationCaptures(old=>[{captureId:record.captureId,capturedAt:record.capturedAt,imageURL:api.captureURL(record.captureId),annotations:rows},...old])
   const injected=(record as unknown as {injectedMessageId?:string;injectedSession?:string})
   const injectionNote=injected?.injectedMessageId?tr(`已投进会话 ${String(injected.injectedSession??"").slice(0,20)}（messageId ${injected.injectedMessageId.slice(0,8)}）`,`Injected into session ${String(injected.injectedSession??"").slice(0,20)} (messageId ${injected.injectedMessageId.slice(0,8)})`):tr("说明未投进会话（回执里没有 messageId）","The description was not injected (no messageId in the receipt)")
   setNotice(injectAnnotationsRef.current?tr(`批注截图已落盘；${injectionNote}：${rows.length} 条批注（含各自 xy 与相机位姿）。`,`Annotated capture saved; ${injectionNote}: ${rows.length} annotations with their xy and the camera pose.`):tr(`批注截图已落盘：${rows.length} 条批注，模型可用 viewer_annotation_read 读取。`,`Annotated capture saved: ${rows.length} annotations; the model can read them with viewer_annotation_read.`))
   return record
  },
 }
 const chooseSceneEntity=(id:string)=>{const current=sceneRef.current;if(!current)return;if(!current.entities.some(entity=>entity.entityId===id))return;nativeControlCancel.current?.();selectedRef.current=id;setSelected(id);ui.showCentre('canvas')}
 const nodeRoleLabel=(item:Entity)=>infiniteGround(item)?tr('无限碰撞平面 · 零厚度','Infinite collider · Zero thickness'):({robot:tr('机器人装配','Robot assembly'),animated:tr('动画装配','Animated assembly'),physics:tr('物理实例','Physics instance'),group:tr('组','Group'),child:tr('子节点','Child node'),entity:tr('独立实体','Entity')}[sceneNodeRole(item)])
 const tree=(parent?:string,depth=0):any=>scene?.entities.filter(item=>item.parentId===parent).map(item=>{const children=scene.entities.some(child=>child.parentId===item.entityId),robot=robotEntity(item);return <div key={item.entityId}><div className="lya-tree-row" aria-selected={selected===item.entityId} style={{paddingLeft:depth*12}}><button aria-label={tr("展开或收起 ","Expand or collapse ")+sceneNodeName(item,tr)} onClick={()=>setCollapsed(old=>{const next=new Set(old);next.has(item.entityId)?next.delete(item.entityId):next.add(item.entityId);return next})}>{children?(collapsed.has(item.entityId)?"▸":"▾"):"·"}</button><button className="lya-tree-name" title={item.entityId} onClick={()=>chooseSceneEntity(item.entityId)}>{robot?"⚙ ":""}{sceneNodeName(item,tr)}</button><small>{nodeRoleLabel(item)}{children?` · ${scene.entities.filter(child=>child.parentId===item.entityId).length} ${tr('子节点','children')}`:''}</small><SceneNodeLock entity={item} tr={tr} disabled={readOnly||removing} onChange={locked=>perform(()=>setNodeLock(item.entityId,locked))}/><SceneNodeVisibility entity={item} scene={scene} tr={tr} disabled={readOnly||removing} onChange={visible=>perform(()=>setNodeVisibility(item.entityId,visible))}/><button type="button" className="lya-icon-button" disabled={readOnly||removing} aria-label={tr("移除节点 ","Remove node ")+sceneNodeName(item,tr)} title={tr("移除当前场景实例；素材与原文件保留。","Remove this scene instance; library assets and originals remain.")} onClick={()=>requestRemoval(item.entityId)}>×</button>{robot&&<input type="checkbox" aria-label={tr("批量选择 ","Batch select ")+sceneNodeName(item,tr)} checked={batchIds.includes(item.entityId)} onChange={event=>{setBatchIds(old=>event.target.checked?[...old,item.entityId]:old.filter(id=>id!==item.entityId));if(event.target.checked&&world)perform(()=>describe(item.entityId))}}/>}</div>{children&&!collapsed.has(item.entityId)&&tree(item.entityId,depth+1)}</div>})

 // ---- 环境面板：检索 → 核对 → 下载导入。面板**不提供生成入口**：生成由域指针（router）命中后走 asset-generation 技能选路。 ----
 const searchEnvironment=async()=>{
  const query=envQuery.trim()
  if(!query)return
  setEnvBusy(true);setEnvNote("")
  try{const value=await api.command<{total:number;candidates:EnvironmentCandidate[];note:string}>("scene_environment_search",{query,limit:8});setEnvCandidates(value.candidates);setEnvDetail(undefined);setEnvNote(value.note??"")}
  finally{setEnvBusy(false)}
 }
 const inspectEnvironment=async(assetId:string)=>{
  setEnvBusy(true)
  try{const value=await api.command<EnvironmentDetail>("scene_environment_detail",{assetId});setEnvDetail(value);return value}
  finally{setEnvBusy(false)}
 }
 const importEnvironment=async(assetId:string)=>{
  const targetSceneId=sceneRef.current?.sceneId
  setEnvBusy(true)
  try{
   const value=await api.command<{resourceId?:string;entityId?:string}>("scene_environment_import",{assetId,...targetSceneId?{sceneId:targetSceneId}:{}})
   setNotice(value?.entityId?tr(`环境素材已加入场景 ${targetSceneId}。`,`Environment asset added to scene ${targetSceneId}.`):tr("环境素材已下载到素材库。","Environment asset downloaded to your library."))
   await refreshAssets()
   if(targetSceneId&&sceneRef.current?.sceneId===targetSceneId){
    if(value?.entityId)pendingFocus.current={sceneId:targetSceneId,entityId:value.entityId}
    await refreshState(targetSceneId)
    if(value?.entityId&&sceneRef.current?.sceneId===targetSceneId){setSelected(value.entityId);ui.showCentre("canvas");ui.closeTool()}
   }
   return value
  }finally{setEnvBusy(false)}
 }
 // ---- 物体面板：添加/删除/变换（写回既有 Scene owner，命令不变） ----
 const addEntity=async()=>{
  const current=sceneRef.current,name=newEntity.trim()
  if(!current||!name)return
  const entity:Entity={entityId:crypto.randomUUID(),name,transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{}}
  const next=await updateScene({sceneId:current.sceneId,expectedRevision:current.revision,patch:[{op:"add",entity}]})
  setNewEntity("");if(sceneRef.current?.sceneId===current.sceneId&&sceneRef.current.entities.some(item=>item.entityId===entity.entityId))setSelected(entity.entityId)
  setNotice(tr(`已添加实体 ${entity.entityId}（rev ${next.revision}）。`,`Entity ${entity.entityId} added (rev ${next.revision}).`))
 }
 const requestRemoval=(entityId:string)=>{
  const current=sceneRef.current
  if(!current||!sessionId||readOnlyRef.current)return
  const node=current.entities.find(value=>value.entityId===entityId)
  if(!node)return
  setError("");setRemoval({sessionId,sceneId:current.sceneId,revision:current.revision,entityId,name:sceneNodeName(node,tr),nodeCount:sceneSubtreeIds(current,entityId).length,ground:infiniteGround(node)})
 }
 const confirmRemoval=async()=>{
  const target=removal,current=sceneRef.current
  if(!target||!current||target.sessionId!==sessionId||current.sceneId!==target.sceneId||readOnlyRef.current)throw new Error("SCENE_SELECTION_CHANGED: 请重新选择当前场景的节点。")
  setRemoving(true)
  try{
   const removed=new Set(sceneSubtreeIds(current,target.entityId))
   const next=await updateScene(removeSceneNodeCommit({...current,revision:target.revision},target.entityId))
   if(apiRef.current!==api)return
   if(sceneRef.current?.sceneId===target.sceneId){if(selectedRef.current&&removed.has(selectedRef.current))setSelected(undefined);setBatchIds(old=>old.filter(id=>!removed.has(id)))}
   setRemoval(undefined);setNotice(tr(`已从场景移除「${target.name}」（rev ${next.revision}），素材保留。`,`“${target.name}” removed from the scene (rev ${next.revision}); the asset is preserved.`))
  }finally{if(apiRef.current===api)setRemoving(false)}
 }
 const setNodeLock=async(entityId:string,locked:boolean)=>{
  const current=sceneRef.current
  if(!current||readOnlyRef.current)throw new Error('SCENE_READ_ONLY')
  return updateScene(lockCommit(current,entityId,locked))
 }
 const setNodeVisibility=async(entityId:string,visible:boolean)=>{
  const current=sceneRef.current
  if(!current||readOnlyRef.current)throw new Error("SCENE_READ_ONLY")
  const next=await updateScene(visibilityCommit(current,entityId,visible))
  if(apiRef.current===api&&sceneRef.current?.sceneId===current.sceneId)setNotice(tr(`${visible?"已显示":"已隐藏"}节点（rev ${next.revision}）；仅改变显示，模拟继续。`,`${visible?"Node shown":"Node hidden"} (rev ${next.revision}); simulation keeps running.`))
 }
 const toggleAssetDeleted=async(asset:AssetRecord)=>{
  if(!sessionId)throw new Error("SESSION_REQUIRED")
  const authority=await api.command<{registryRevision:string}>("asset_authority_snapshot",{})
  if(apiRef.current!==api)return
  if(!authority?.registryRevision)throw new Error("ASSET_REVISION_UNAVAILABLE: 未取得素材版本，未执行回收操作。")
  await api.command("asset_edit",{resourceId:asset.ref.resourceId,deleted:!asset.deletedAt,expectedRegistryRevision:authority.registryRevision})
  if(apiRef.current!==api)return
  await refreshAssets()
  if(apiRef.current===api)setNotice(asset.deletedAt?tr("素材已恢复；原有场景实例保持原版本。","Asset restored; existing scene instances keep their original versions."):tr("素材已移入回收站；场景实例与原文件保留。要移除画面中的对象，请使用“从场景移除”。","Asset moved to trash; scene instances and original files remain. Use Remove from scene to remove an object from the view."))
 }
 const exitPlacement=()=>{setPlacingAsset(undefined);setPlacingPoint(undefined);viewer.current?.setPlacementMode(false)}
 // ---- 环境光照（Scene 的 environment 组件）：面板读 Viewer 的读数，写回走既有 scene_edit/scene_mount ----
 // 读数由 Viewer 出（格式 owner），这里只做三件事：轮询取回、补丁提交、资源引用准备。
 // 本文件不解析环境组件的字段，也不保存第二份环境状态（面板渲染的就是 Viewer 的读数）。
 const readEnvironmentStatus=()=>{const instance=viewer.current;if(!instance)return;const next=instance.environmentStatus();setEnvironmentStatus(old=>JSON.stringify(old)===JSON.stringify(next)?old:next);const types=[...next.hdriMimeTypes];if(types.join("\x00")!==hdriMimeRef.current.join("\x00")){hdriMimeRef.current=types;void refreshHdriAssets(types).catch(()=>undefined)}}
 /** 素材库里已登记的 HDRI（按 Viewer 给出的 mimeType 清单筛；本文件不猜扩展名）。 */
 const refreshHdriAssets=async(types=hdriMimeRef.current):Promise<Array<{ref:ResourceRef;name:string}>>=>{
  const list=await api.request<Array<AssetRecord&{ref:ResourceRef}>>("assets?"+new URLSearchParams({query:"",includeDeleted:"false"}))
  const rows=list.filter(item=>types.includes(item.ref.original.mimeType)).map(item=>({ref:item.ref,name:item.name}))
  setHdriAssets(rows);return rows
 }
 const importHdriAsset=async(path:string)=>{
  setHdriBusy(true)
  try{await api.command("scene_import",{path});await refreshHdriAssets();await refreshAssets();setNotice(tr("HDRI 已导入素材库；在上面的下拉框里选它即可用作环境贴图。","HDRI imported into your library; pick it in the list above to use it as the environment map."))}
  finally{setHdriBusy(false)}
 }
 /**
  * 一条环境补丁 → Scene 文档。补丁先经 Viewer 规范化成完整组件值（默认值/上界都在格式 owner 那边），
  * 再按"承载实体是否已经在文档里"分两条既有命令走：已有实体用 scene_edit 改它的组件；
  * 还没有实体时，HDRI 用 scene_mount（资源引用由资源库写进实体，界面不手抄 ref），
  * 不用 HDRI 就用 scene_edit 加一条空实体。两条路都经 SceneStore 的 CAS 提交，Agent 用同一批命令。
  */
 const applyEnvironmentPatch=async(patch:EnvironmentPatch)=>{
  const instance=viewer.current,current=sceneRef.current
  if(!instance||!current)throw new Error(tr("先在场景面板新建或打开一个场景。","Create or open a scene first."))
  const composed=instance.composeEnvironment(patch)
  const previous=instance.environmentStatus()
  const carrierEntity=previous.carrier?current.entities.find(entity=>entity.entityId===previous.carrier):undefined
  const hdri=composed.component.hdri
  const asset=hdri?hdriAssets.find(item=>item.ref.resourceId===hdri.resourceId&&item.ref.version===hdri.version):undefined
  if(hdri&&!asset)throw new Error(tr(`素材库里没有 ${hdri.resourceId}@${hdri.version}，不写入无法解析的资源引用。`,`Asset ${hdri.resourceId}@${hdri.version} is not in the library; a reference that cannot resolve is not written.`))
  if(carrierEntity){
   // 换 HDRI 时顺带把**上一个** HDRI 的引用换掉（同一个实体上不留用不到的引用）；其它引用一律不动。
   const stale=previous.hdri?carrierEntity.resources.filter(ref=>ref.resourceId!==previous.hdri!.resourceId):carrierEntity.resources
   const resources=asset?(stale.some(ref=>ref.resourceId===asset.ref.resourceId&&ref.version===asset.ref.version)?stale:[...stale,asset.ref]):stale
   await updateScene({sceneId:current.sceneId,expectedRevision:current.revision,patch:[{op:"update",entityId:carrierEntity.entityId,changes:{components:{...carrierEntity.components,environment:composed.component},...resources.length!==carrierEntity.resources.length||resources.some((ref,index)=>ref!==carrierEntity.resources[index])?{resources}:{}}}]})
  }else if(asset){
   if(worldRef.current?.engineId==="official-suite")throw new Error(tr("官方世界的场景是只读投影，不能编辑。","The official world's scene is a read-only projection and cannot be edited."))
   const created=await api.command<{snapshot:SceneSnapshot;entityId:string}>("scene_mount",{sceneId:current.sceneId,resourceId:asset.ref.resourceId,version:asset.ref.version,components:{environment:composed.component}})
   applySceneIfCurrent(sceneWritePort,current.sceneId,created.snapshot)
  }else{
   const entity:Entity={entityId:crypto.randomUUID(),name:tr("环境光照","Environment lighting"),transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{environment:composed.component}}
   await updateScene({sceneId:current.sceneId,expectedRevision:current.revision,patch:[{op:"add",entity}]})
  }
  readEnvironmentStatus()
  setNotice(composed.warnings.length?tr(`环境光照已提交；${composed.warnings.length} 个字段被规范化：${composed.warnings.join("；")}` ,`Lighting committed; ${composed.warnings.length} field(s) normalized: ${composed.warnings.join("; ")}`):tr("环境光照已提交。","Lighting committed."))
 }
 /** 去掉整条环境组件：回到组件出现之前那组内置光照读数（不删除实体/资源，用户写的都还在）。 */
 const removeEnvironment=async()=>{
  const instance=viewer.current,current=sceneRef.current
  if(!instance||!current)return
  const status=instance.environmentStatus()
  const carrier=status.carrier?current.entities.find(entity=>entity.entityId===status.carrier):undefined
  if(!carrier)return
  if(typeof window!=="undefined"&&!window.confirm(tr(`从 ${carrier.name||carrier.entityId} 移除环境光照组件？场景会回到内置光照（实体与 HDRI 资源都保留）。`,`Remove the lighting component from ${carrier.name||carrier.entityId}? The scene returns to the built-in lighting (entity and HDRI stay).`)))return
  const components={...carrier.components};delete components.environment
  await updateScene({sceneId:current.sceneId,expectedRevision:current.revision,patch:[{op:"update",entityId:carrier.entityId,changes:{components}}]})
  readEnvironmentStatus();setNotice(tr("已移除环境光照组件，回到内置光照。","Lighting component removed; using the built-in lighting."))
 }
 /** 昼夜播放开关：只动 Viewer 的渲染时钟，不写 Scene、不碰物理时间。 */
 const toggleDayNight=(playing:boolean)=>{
  const result=viewer.current?.setDayNightPlaying(playing)
  readEnvironmentStatus()
  setNotice(result?.playing?tr("昼夜播放中：只推进渲染时间，物理时间与场景版本不变。","Day/night playing: only render time advances; physics time and the scene revision stay put."):result?tr("昼夜播放已停止。","Day/night playback stopped."):tr("当前没有启用昼夜，没有开始播放。","Day/night is not enabled, so nothing started playing."))
 }
 const mountAsset=(asset:AssetRecord)=>{
  if(!sceneRef.current)return
  setPlacingAsset(assetPlacementOf(asset));setPlacingPoint(undefined)
  ui.showCentre("canvas");viewer.current?.setPlacementMode(true)
 }
 const confirmPlacement=async()=>{
  const current=sceneRef.current,asset=placingAsset,point=placingPoint
  if(!current||!asset||!point)return
  const value=await api.command<{snapshot:SceneSnapshot;entityId:string}>("scene_mount",assetPlacementInput(current.sceneId,asset,point))
  exitPlacement()
  const adoption=applySceneIfCurrent(sceneWritePort,current.sceneId,value.snapshot)
  if(adoption!=="applied"){setNotice(adoption==="superseded"?tr("加入操作已完成，场景随后又有更新；继续显示当前版本。","The asset was added, then the scene changed again. Keeping the current version."):tr(`素材已加入场景 ${current.sceneId}。`, `Asset added to scene ${current.sceneId}.`));return}
  pendingFocus.current={sceneId:current.sceneId,entityId:value.entityId}
  setSelected(value.entityId);ui.showCentre("canvas");ui.closeTool()
  setNotice(tr(`「${asset.name}」已加入当前场景。`,`${asset.name} added to this scene.`))
 }
 // 放置模式只在画布可见且仍处于能发起放置的域面板时成立；切场景/会话/面板或离开画布即退出。
 // 能发起「加入当前场景」的面板是四个域面板：素材（聚合）与机器人/物件/环境（各自域列表）。
 useEffect(()=>{viewer.current?.setPlacementMode(Boolean(placingAsset))},[open,viewerVisible,readOnly,Boolean(scene),placingAsset])
 useEffect(()=>{exitPlacement()},[sessionId,scene?.sceneId])
 useEffect(()=>{if(placingAsset&&(uiState.tool!=="asset"&&uiState.tool!=="robot"&&uiState.tool!=="object"&&uiState.tool!=="environment"||uiState.centre!=="canvas"||mode==="chat"||!viewerVisible))exitPlacement()},[placingAsset,uiState.tool,uiState.centre,mode,viewerVisible])
 const status=replayActive?tr("录制回放","Recorded replay"):official?tr("官方环境","Official environment"):world?sceneWorldPhaseLabel(worldLifecycle.phase,tr):tr("场景视图","Scene view")
 // 运行状态只表达状态：点开场景面板的动作归场景按钮，不在顶栏重复铺第二个入口。
 const statusState=replayActive?"replay":official?"official":world?worldLifecycle.phase:"idle"

 // ---- 面板内容（每个工具面板一次只渲染一个；未渲染的不挂载、不发请求） ----
 // 四个域面板（素材/机器人/物件/环境）共用同一份「可加入场景」判据：有可编辑场景、非录制回放。
 const canMountAsset=Boolean(scene&&!readOnly&&!replayActive)
 const projectFiles=<details className="lya-project-files"><summary>{tr("打开与保存工程","Open & save project")}</summary>
  <label className="lya-field-label">{tr("工程文件路径","Project file path")}<input className="lya-wide" aria-label={tr("工程文件路径","Project file path")} placeholder="/path/to/scene.json" value={path} onChange={event=>setPath(event.target.value)}/></label>
  <div className="lya-row"><button disabled={readOnly||!sessionId||!path.trim()} onClick={()=>perform(async()=>{const next=await api.command<SceneSnapshot>("scene_open",{path});await refreshScenes();await loadScene(next.sceneId);await refreshAssets()})}>{tr("打开工程","Open project")}</button>
  <button disabled={readOnly||!scene||!path.trim()} onClick={()=>perform(async()=>{const result=await api.command<any>("scene_save",{sceneId:scene!.sceneId,path,portable:true});setNotice(result.missing?.length?tr(`工程已保存，${result.missing.length} 个引用文件需要处理。`,`Project saved; ${result.missing.length} references need attention.`):tr("工程及依赖已保存。","Project and dependencies saved."))})}>{tr("保存工程","Save project")}</button></div>
 </details>
 const [historyState,setHistoryState]=useState<SessionHistoryState|null>(null),[historyNotice,setHistoryNotice]=useState("")
 const loadHistory=async()=>{const value=await api.request<SessionHistoryState>("session-history");setHistoryState(value);return value}
 const previewHistory=async(entry:HistoryEntryRecord)=>{const value=await api.request<SessionHistoryPrecheck>("session-history?logFile="+encodeURIComponent(entry.logFile));setHistoryNotice(`${entry.id}：${value.readable?tr("可读","readable"):tr("不可读","unreadable")}，用户消息 ${value.entry.messages}，附件 ${value.entry.attachments}，首条：${value.firstUserText??"—"}`);return value}
 const restoreHistoryEntry=async(entry:HistoryEntryRecord)=>{const value=await api.request<SessionHistoryRestore>("session-history-restore",{method:"POST",body:JSON.stringify({logFile:entry.logFile,confirm:true})});setHistoryNotice(`${entry.id}：${value.status} → ${value.target}${value.files.length?`（${value.files.join("、")}）`:""}；${value.reason}`);return value}
 const openHistoryEntry=async(entry:HistoryEntryRecord)=>{if(!openHistorySession)throw Error(tr('此窗口没有原生会话导航入口。','Native session navigation is unavailable in this window.'));return openHistorySession(entry)}
 const sessionHistory=<details><summary>{tr("历史会话（跨运行根）","Historic sessions (other roots)")}{historyState?` · ${String(historyState.entries.length)}`:""}</summary>
  <div className="lya-row"><span className="lya-help">{tr("当前运行根的记录可直接打开同一会话；其他根须显式复制恢复，不合并 storages、不改写 cwd。","Open the same session in the current runtime root. Other roots require explicit copy recovery; storage and cwd stay unchanged.")}</span><button onClick={()=>perform(loadHistory)}>{tr("发现","Discover")}</button></div>
  {historyState?.roots.map(root=><p className="lya-help" key={root.sessionsDir}>{`${root.label} · ${root.sessionsDir} · ${root.current?tr("当前运行根","current root"):tr("其他根","other root")} · ${root.exists?"":"missing"}`}</p>)}
  {[...historyState?.entries??[]].sort((left,right)=>Number(left.current)-Number(right.current)).slice(0,12).map(entry=><div className="lya-row" key={entry.logFile}><span className="lya-badge">{`${entry.format} · ${entry.archived?tr("已归档","archived"):tr("活跃","active")}`}</span><span className="lya-help">{`${entry.id} · ${entry.root} · cwd ${entry.cwdExists?tr("在场","ok"):tr("已失效","stale")} · ${entry.reason}`}</span><button onClick={()=>perform(()=>previewHistory(entry))}>{tr("只读预览","Preview")}</button>{entry.current?<button data-history-action="open-existing" disabled={!openHistorySession||entry.archived||!entry.cwdExists} title={entry.archived?tr('请先解除归档。','Unarchive this session first.'):!entry.cwdExists?tr('原工作目录不在场。','The recorded working directory is unavailable.'):undefined} onClick={()=>perform(()=>openHistoryEntry(entry))}>{tr("打开现有会话","Open existing session")}</button>:<button onClick={()=>perform(()=>restoreHistoryEntry(entry))}>{tr("复制恢复到当前根","Copy and restore")}</button>}</div>)}
  {historyNotice&&<p className="lya-help" data-lane="dev031-history">{historyNotice}</p>}
 </details>
 const sceneHistory=<details><summary>{tr("场景版本","Scene versions")} {scene?`· rev ${scene.revision}`:""}</summary><div className="lya-row"><span className="lya-help">{scene?tr(`${scene.sceneId} 的完整快照版本；恢复使用当前版本校验。`,`Complete snapshots for ${scene.sceneId}; restore checks the current revision.`):tr("先选择场景。","Select a scene first.")}</span><button disabled={!scene||historyLoading} onClick={()=>perform(()=>refreshHistory(scene?.sceneId))}>{historyLoading?tr("读取中…","Loading…"):tr("刷新历史","Refresh history")}</button></div>{versions.length===0&&<p className="lya-help">{tr("暂无可读历史版本。","No readable history versions yet.")}</p>}{versions.map(version=><div className="lya-row" key={`${version.sceneId}-${version.revision}`}><span className={version.current?"lya-badge lya-live":"lya-badge"}>{`rev ${version.revision} · ${version.entityCount} ${tr("个实体","entities")}`}{version.current?` · ${tr("当前","current")}`:""}</span><button disabled={readOnly||!scene||version.current||historyLoading} onClick={()=>perform(()=>restoreVersion(version.revision))}>{tr("恢复","Restore")}</button></div>)}</details>
 const importUsage=importUsageChoice??localImportUsageDefault(uiState.tool==='object'||uiState.tool==='asset'?'object':'environment')
 const importPurposeControl=<ImportPurposeChoice value={importUsage} disabled={importBusy} onChange={setImportUsageChoice} tr={tr}/>
 const importLocalPaths=async(paths:string[],target:"scene"|"library")=>{
  if(!sessionId)throw new Error("先选择一个任务，再导入本地文件。")
  if(localImportBusy.current||importBusy)throw new Error("正在导入，请等当前文件处理完成。")
  if(target==="scene"&&(readOnly||replayActive))throw new Error("当前场景为只读，请切到可编辑场景，或拖入素材库。")
  localImportBusy.current=true;setImportBusy(true)
  setImportTextureWarnings([]);setImportTextureDetails([])
  let targetScene=sceneRef.current?.sceneId,sequence=sceneLoadSeq.current
  const scopeCurrent=()=>policySurfaceAlive.current&&apiRef.current===api
  const current=()=>scopeCurrent()&&sceneRef.current?.sceneId===targetScene&&sceneLoadSeq.current===sequence
  try{
   const result=await importLocalFiles({current,sourceTexturePolicy,physicalizeUsage:importUsage,
    resolvePath:async path=>localImportPathFromReceipt(path,await api.command("scene_import_resolve",{path})),
    loadPolicy:async path=>{
     if(readOnlyRef.current||replayActive)throw Error('POLICY_REGISTRATION_READ_ONLY: 当前入口只读，请切到可编辑任务登记策略')
     const snapshot=sceneRef.current,candidate=snapshot?.entities.find(item=>item.entityId===selectedRef.current)
     const robot=candidate&&robotEntity(candidate)?candidate:undefined
     const boundWorld=worldRef.current,boundHost=hostId.current,revision=snapshot?.revision
     const policyCurrent=()=>scopeCurrent()&&hostId.current===boundHost&&(!robot||(sceneRef.current?.sceneId===snapshot?.sceneId&&sceneRef.current?.revision===revision&&selectedRef.current===robot.entityId&&worldRef.current?.worldId===boundWorld?.worldId&&worldRef.current?.worldGeneration===boundWorld?.worldGeneration))
     const context=robot&&snapshot?{sceneId:snapshot.sceneId,entityId:robot.entityId,expectedRevision:revision,...boundWorld?{worldId:boundWorld.worldId,expectedGeneration:boundWorld.worldGeneration}:{}}:{}
     const receipt=await importLocalPolicy({current:policyCurrent,command:(name,input)=>api.command<any>(name,input,{sceneId:snapshot?.sceneId,worldId:robot?boundWorld?.worldId:undefined})},path,context)
     if(policyCurrent()&&!receipt.face.cancelled){setLocalPolicyImport({sessionId,receipt});ui.openTool('robot')}
     return receipt
    },
    command:async<T,>(name:string,input:unknown)=>{
     const result=await api.command<T>(name,input,{sceneId:targetScene,worldId:worldRef.current?.worldId})
     if((name==="scene_create"||name==="scene_open"||name==="scene_package_import")&&current()){
      const value=await api.state({sceneId:(result as SceneSnapshot).sceneId})
      if(!value.scene)throw new Error("无法读取刚导入的场景。")
      return value.scene as T
     }
     return result
    },
    // .blend/.usd/.obj/.fbx：先由既有 scene_import 登记源件拿回 resourceId/version；转换只带这个身份，
    // 服务端从本会话资源 owner 解析路径并复用 scene_import 登记派生 GLB，只回可挂载的 resourceId/version
    // （浏览器不接触宿主私有路径），随后按既有 scene_mount 挂载。失败原因原样带回，不把"源文件入库"当显示成功。
    convert:async(request)=>{
     const converted=await api.request<{kind?:string;reason?:string;source?:{resourceId?:string;version?:number};glb?:{resourceId?:string;version?:number;name?:string};cached?:boolean;convertMs?:number;textureLoss?:{policy:'strict'|'available';partial:boolean;missingDependencies:unknown[];emptyDeclarations:unknown[];packedImageCount:number}}>("workspace",{method:"POST",body:JSON.stringify({sessionId,action:"convert-source",input:{resourceId:request.resourceId,version:request.version}})})
     if(converted.kind==="unsupported")throw new Error(converted.reason??"宿主没有给出可显示的转换结果")
     const glb=converted.glb
     if(converted.kind!=="converted-glb"||!glb||typeof glb.resourceId!=="string"||!Number.isInteger(glb.version))throw new Error(`转换服务返回了意外结果：${String(converted.kind??"空")}`)
     return {resourceId:glb.resourceId,version:glb.version as number,...(glb.name?{name:glb.name}:{}),...(converted.cached!==undefined?{cached:converted.cached}:{}),...(converted.convertMs!==undefined?{convertMs:converted.convertMs}:{}),...converted.textureLoss?{textureLoss:converted.textureLoss}:{}}
    },
    progress:setNotice,
    show:(snapshot,entityId)=>{
     if(snapshot.sceneId!==targetScene){++sceneLoadSeq.current;sequence=sceneLoadSeq.current;setWorld(undefined);worldRef.current=undefined;setFrame(undefined);selectedRef.current=undefined;setSelected(undefined);setBatchIds([])}
     targetScene=snapshot.sceneId;sceneIntent.current=undefined;sceneRef.current=snapshot;setScene(snapshot)
     if(entityId){selectedRef.current=entityId;setSelected(entityId);pendingFocus.current={sceneId:snapshot.sceneId,entityId}}
     setViewerVisible(true);ui.showCentre("canvas");ui.closeTool();revealScene?.()
   }},paths,target,targetScene)
   if(!current())return
   if(result.policyFiles.length>0&&result.imported.length===0&&result.sources.length===0){
    setAssetImportOpen(false);setAssetPath('');setNotice(result.policyFiles.length?tr(`已登记 ${result.policyFiles.length} 个策略文件；选择机器人后可检查兼容与缺项。`,`Registered ${result.policyFiles.length} policy files; select a robot to review compatibility and missing requirements.`):'')
    if(result.errors.length)setError(result.errors.join('；'))
    return
   }
   const [nextAssets,nextScenes]=await Promise.all([api.request<AssetRecord[]>("assets?query=&includeDeleted=false"),api.request<Array<{sceneId:string}>>("scenes")])
   if(!current())return
   setAssetQuery("");setAssets(nextAssets);setScenes(nextScenes);setAssetImportOpen(false);setAssetPath("")
   setNotice(result.imported.length?tr(`已导入 ${result.imported.length} 个文件。`,`Imported ${result.imported.length} files.`):"")
   if(result.errors.length)setError(result.errors.join("；"))
   setImportTextureWarnings(result.textureWarnings)
   setImportTextureDetails(result.textureWarningDetails)
   if(result.orientation&&target==="scene"&&current()){
    setNotice(tr("已导入并加入场景，正在检查方向…","Imported into the scene; checking orientation…"))
    setOrientationCheckId(undefined)
    const stopTarget={sceneId:result.orientation.sceneId,revision:result.orientation.revision,requested:false,checkId:undefined as string|undefined}
    orientationStopRef.current=stopTarget;setOrientationStopTarget(stopTarget)
    try{
     const face=await api.command<{checkId:string;status:string}|null>("viewer_orientation_check_ui",{sessionId,clientId:api.clientId,...result.orientation},{sceneId:result.orientation.sceneId,worldId:worldRef.current?.worldId})
     if(!current()||orientationStopRef.current!==stopTarget)return
     stopTarget.checkId=face?.checkId
     if(stopTarget.requested){
      if(face?.checkId){const stopped=await api.command<{checkId:string;attempts:number;turnStop?:"requested"|"confirmed"|"ended"|"shared"}>("viewer_orientation_stop_ui",{sessionId,sceneId:stopTarget.sceneId,revision:stopTarget.revision,checkId:face.checkId});receiveOrientationStop(stopTarget,stopped)}
      else{setOrientationCheckId(undefined);setOrientationStopTarget(undefined);orientationStopRef.current=undefined;setNotice(tr("方向未检查，导入内容仍可使用。","Orientation was not checked; the import remains usable."))}
     }else if(face?.status==="queued"||face?.status==="checking")setOrientationCheckId(face.checkId)
     else {setOrientationStopTarget(undefined);orientationStopRef.current=undefined;setNotice(tr("已导入；方向未检查，原姿态保留。","Imported; orientation was not checked and the pose was preserved."))}
    }catch{if(current()){if(stopTarget.requested&&stopTarget.checkId){stopTarget.requested=false;setOrientationCheckId(stopTarget.checkId);setNotice(tr("停止方向检查失败，请重试。","Could not stop orientation check; retry."))}else{setOrientationStopTarget(undefined);orientationStopRef.current=undefined;setNotice(tr("已导入；方向未检查，原姿态保留。","Imported; orientation was not checked and the pose was preserved."))}}}
   }
  }finally{localImportBusy.current=false;if(apiRef.current===api)setImportBusy(false)}
 }
 const receiveOrientationStop=(target:{sceneId:string;revision:number;requested:boolean;checkId?:string},face:{checkId:string;attempts:number;turnStop?:"requested"|"confirmed"|"ended"|"shared"})=>{
  if(orientationStopRef.current!==target)return
  target.checkId=face.checkId
  if(face.turnStop==="requested"){setOrientationCheckId(face.checkId);setNotice(tr("已请求停止自动模型回合，正在等待原生结束回执…","Stopping the automatic model turn; waiting for its end receipt…"));return}
  setOrientationCheckId(undefined);setOrientationStopTarget(undefined);orientationStopRef.current=undefined
  setNotice(face.turnStop==="confirmed"?tr("方向检查与自动模型回合已停止。","Orientation check and automatic model turn stopped."):face.turnStop==="shared"?tr("方向检查已撤销；当前对话回合未取消。如需停止生成，请使用对话停止按钮。","Orientation check cancelled; the current conversation turn continues. Use Stop generation if needed."):face.turnStop==="ended"?tr("方向检查已撤销，自动回合已结束；取消结果未确认。","Orientation check cancelled and the model turn ended; cancellation was not confirmed."):face.attempts>0?tr("方向仍未确认，未继续调整；请查看当前姿态。","Orientation remains unconfirmed; review the current pose."):tr("方向检查已停止，原姿态保留。","Orientation check stopped; original pose preserved."))
 }
 const stopOrientationCheck=async()=>{
  const target=orientationStopRef.current
  if(!target||!sessionId||target.requested)return
  target.requested=true
  setNotice(tr("正在停止方向检查…","Stopping orientation check…"))
  try{
   const face=await api.command<{checkId:string;attempts:number;turnStop?:"requested"|"confirmed"|"ended"|"shared"}>("viewer_orientation_stop_ui",{sessionId,sceneId:target.sceneId,revision:target.revision,...target.checkId?{checkId:target.checkId}:{}})
   receiveOrientationStop(target,face)
  }catch{if(target.checkId){target.requested=false;setNotice(tr("停止方向检查失败，请重试。","Could not stop orientation check; retry."))} /* 截图命令可能还未建检查；它返回后会按 requested 再执行停止。 */}
 }
 const fileDragOver=(event:DragEvent<HTMLDivElement>)=>{
  if(!event.dataTransfer.types.includes("Files"))return
  event.preventDefault()
  const target=(event.target as HTMLElement).closest?.(".lya-library")?"library":"scene"
  setDropTarget(target);event.dataTransfer.dropEffect=localImportBusy.current?"none":"copy"
 }
 const fileDrop=(event:DragEvent<HTMLDivElement>)=>{
  setDropTarget(undefined)
  const files=Array.from(event.dataTransfer.files)
  // 普通图片/文档在对话区仍是附件；模型文件在工作台直接进入确定性的导入链。
  const library=Boolean((event.target as HTMLElement).closest?.(".lya-library"))
  const canvas=Boolean((event.target as HTMLElement).closest?.(".lya-wb-canvas"))
  if(!localDropIsImport(files,Array.from(event.dataTransfer.items),library||canvas))return
  event.preventDefault();event.stopPropagation()
  // 附件层用 window.dragend 释放整页拖入提示；此处已接管 drop，不再把文件交给附件上传。
  window.dispatchEvent(new Event("dragend"))
  const desktop=window.lyapunovDesktop as DesktopBridge|undefined
  perform(async()=>{
   if(!desktop?.getDroppedFilePaths)throw new Error("此入口需要新版桌面客户端；也可在素材库填写本地文件路径。")
   const paths=desktop.getDroppedFilePaths(files)
   if(!paths.length||paths.some(path=>!path))throw new Error("无法取得本地文件或目录路径，请从系统文件管理器拖入，或在素材库填写本地路径。")
   await importLocalPaths(paths,library?"library":"scene")
  })
 }
 const importToLibrary=async()=>{
  if(!sessionId||!assetPath.trim()||importBusy)return
  await importLocalPaths([assetPath.trim()],"library")
 }
 // 内置素材按 assetId 登记 resourceId：同内容重复导入复用已存在记录（UI 侧同时按 asset_list 置灰）。
 const importBuiltin=async(item:BuiltinAssetRecord)=>{
  if(!sessionId||importBusy)return
  setImportBusy(true)
  try{const outcome=await api.command<{resource?:{alreadyPresent?:boolean}}>("scene_import",{path:item.path,resourceId:item.assetId,name:item.displayName,...item.components?{components:item.components}:{},...item.sceneGeometryBinding?{sceneGeometryBinding:item.sceneGeometryBinding}:{}});setAssetQuery("");await refreshAssets("");setNotice(outcome?.resource?.alreadyPresent?tr(`「${item.displayName}」已存在（内容相同，已复用）。`,`${item.displayName} already in your library (same content, reused).`):tr(`「${item.displayName}」已导入素材库。选择“加入当前场景”即可使用。`,`${item.displayName} imported to your library. Choose Add to scene to use it.`))}
  finally{setImportBusy(false)}
 }
 /**
  * 能力包面板的载入落点（review 项⑪ 的下游）：`policy_prepare` 交出的是**缓存内已校验绝对路径**
  * （直控路由的 `modelEntry`，或基础策略路由 `components.mujoco.sourcePath`），这里只把它交给既有
  * `scene_import`（带 sceneId 时同一步挂载），再选中挂上来的实体——之后就是既有的
  * 「启动模拟 → 机器人面板 describe/动作/停止」，不新增第二条加载链路。
  * **返回 Promise**：面板 await 它，忙态与失败因而覆盖到真实 `scene_import` 结束（R1：此前面板
  * 传的是 `perform(...)` 的 void，导入还没完成就清忙态、失败也只落在别处）。
  */
 const loadPackModel=async(modelPath:string,packId:string,provenance?:Record<string,unknown>)=>{
  if(!sceneRef.current){const created=await api.command<SceneSnapshot>("scene_create",{template:"physics-workspace"});await refreshScenes();await loadScene(created.sceneId)}
  const current=sceneRef.current
  if(!current)throw new Error("SCENE_UNAVAILABLE")
  // name 复用 scene_import 既有参数（与 importBuiltin 同一字段）：不给时实体名回落成文件名（真实 CU 里显示成 "scene"）。
  const outcome=await api.command<{resource?:{alreadyPresent?:boolean};snapshot?:SceneSnapshot;entityId?:string}>("scene_import",{path:modelPath,sceneId:current.sceneId,name:packId,...provenance?{components:{packBinding:provenance}}:{}})
  if(outcome.snapshot)applySceneIfCurrent(sceneWritePort,current.sceneId,outcome.snapshot)
  await refreshAssets("")
  if(!outcome.entityId)throw new Error(tr("模型已导入素材库但未挂到场景。","The model was imported but not mounted into the scene."))
  setSelected(outcome.entityId)
  setNotice(tr(`能力包 ${packId} 的模型已加入场景并选中；点「启动模拟」后即可在机器人面板读关节、执行动作、停止。`,`Pack ${packId} model added to the scene and selected; press Simulate to read joints, run actions and stop in the robot panel.`))
 }
 const assetInstanceControls={scene,sceneReadOnly:readOnly||removing,selectedInstanceId:selected,
  recoverPhysics:(asset:AssetRecord)=>{
   const instance=assetSceneInstances(sceneRef.current,asset.ref.resourceId).find(entity=>entity.resources.some(ref=>ref.resourceId===asset.ref.resourceId&&ref.version===asset.ref.version))
   if(!instance)return
   nativeControlCancel.current?.();selectedRef.current=instance.entityId;setSelected(instance.entityId);ui.openTool('object')
  },
  selectInstance:(entityId:string)=>{nativeControlCancel.current?.();selectedRef.current=entityId;setSelected(entityId);ui.showCentre("canvas")},
  focusInstance:(entityId:string)=>{nativeControlCancel.current?.();selectedRef.current=entityId;setSelected(entityId);ui.showCentre("canvas");viewer.current?.focus(entityId)},
  setInstanceVisible:(entityId:string,visible:boolean)=>perform(()=>setNodeVisibility(entityId,visible)),removeInstance:requestRemoval}
 const scenePanel=<>
  {!sessionId&&<p className="lya-help">{tr("先在左侧添加或选择工作区，再创建和编辑场景。","Add or choose a workspace on the left before creating or editing a scene.")}</p>}
  <div className="lya-row"><select className="lya-wide" data-testid="lyapunov-scene-select" aria-label={tr("场景","Scene")} disabled={readOnly} value={scene?.sceneId??""} onChange={event=>perform(()=>loadScene(event.target.value))}><option value="">{tr("选择场景","Select a scene")}</option>{scenes.map(item=><option key={item.sceneId} value={item.sceneId}>{item.sceneId}</option>)}</select></div>
  <SceneCreationActions disabled={readOnly||!sessionId} busy={sceneCreating} tr={tr} create={template=>perform(()=>createScene(template))}/><button onClick={()=>perform(refreshScenes)}>{tr("刷新","Refresh")}</button>
  {projectFiles}
  <div className="lya-panel-title"><strong>{tr("场景中的对象","Objects in this scene")} {scene?.entities.length??0}</strong></div>
 <div className="lya-tree">{tree()}</div>
 {importPurposeControl}
 <DomainAssetList domain="scene" assets={assets} builtin={builtinAssets} busy={importBusy} available={Boolean(sessionId)} canMount={canMountAsset} tr={tr} importBuiltin={item=>perform(()=>importBuiltin(item))} mount={mountAsset} instanceControls={assetInstanceControls}/>
  {physicalTestSpaceOf(scene)&&<div data-testid="lyapunov-physical-test-space">
   <div className="lya-panel-title"><strong>{tr("机械臂与动态方块 · 物理交互测试","Robot and dynamic cubes · physics test")}</strong></div>
   <p className="lya-help">{tr("物理世界按当前引擎偏好自动初始化，就绪后直接在对话中提出动作；画面与真实物理状态同步。末端下降使用IK，推箱成功以动态物体位移和接触力判断。","Physics initializes with your current engine preference. Once ready, ask for actions in the conversation; IK and real contact measurements determine success.")}</p>
   {physicalTestSpaceOf(scene)!.tasks.map(task=><p className="lya-help" key={task}>{task}</p>)}
   <p className="lya-help">{world?`${world.engineId} ${world.engineVersion} · ${world.clock??"—"} · step ${frame?.stepIndex??"—"} · ${frame?.simTime?.toFixed(2)??"—"}s`:tr("正在按实际provider核验实时钟、关节、末端和接触能力；使用包内地板。","Checking the actual provider's realtime clock, joints, end effector and contacts; this package includes its own floor.")}</p>
   <div className="lya-row"><button disabled={readOnly||!providerAvailable||Boolean(world)||worldLifecycle.phase==='initializing'} onClick={()=>perform(startWorld)}>{tr("启动物理测试","Start physics test")}</button><button className="lya-stop" disabled={!world} onClick={()=>perform(()=>stop(true))}>{tr("停止动作","Stop actions")}</button><button disabled={readOnly} onClick={()=>perform(resetPhysicalTest)}>{tr("恢复初始测试","Reset physics test")}</button></div>
  </div>}
  {!scene&&<p className="lya-help">{tr("还没有场景：在对话中描述你要构建的世界，或先新建/打开一个场景。","No scene yet: describe your world in the conversation, or create/open one.")}</p>}
  <WorldPhysicsPanel scene={scene} world={world} frame={frame} state={worldLifecycle} worlds={worlds.filter(item=>item.status!=="closed"&&item.sceneId===scene?.sceneId)} disabled={readOnly||!providerAvailable} tr={tr} diagnostics={<WorldFacts world={world} tr={tr}/>}
   start={()=>perform(startWorld)} sync={()=>perform(sync)} pause={paused=>perform(()=>setWorldPaused(paused))} stop={()=>perform(()=>stop(true))} close={()=>perform(closePhysicsWorld)} prepare={()=>perform(preparePhysicsWorkspace)} saveGravity={gravity=>perform(()=>configureWorldGravity(gravity))} cancel={()=>automaticWorld.cancel()}
   selectWorld={chosen=>{setWorld(chosen);worldRef.current=chosen;setFrame(undefined);persist(scene,chosen)}}/>
  <details><summary>{tr("高级运行信息","Advanced runtime information")}</summary><WorldFacts world={world} tr={tr}/><ComputerUseFacts computerUse={computerUse} tr={tr} place="settings"/></details>
  {!readOnly&&(scene?.entities.filter(e=>e.components.mujoco||e.components.isaac||e.components.articulation||e.components.controller).length??0)>=2&&<details><summary>{tr("多机器人同时执行","Run robots together")} ({batchIds.length})</summary><p className="lya-help">{tr("勾选机器人后，每台使用自己的完整目标，同一步开始。","Select robots; each uses its own complete target and starts at the same step.")}</p><div className="lya-help">{batchIds.join(" · ")}</div><button className="lya-primary lya-wide" disabled={!ready||batchIds.length<2} onClick={()=>perform(batch)}>{tr(`同步执行 ${batchIds.length} 台机器人`,`Execute ${batchIds.length} robots together`)}</button></details>}
  {sessionHistory}
  {sceneHistory}
 </>

 const editableEntity=scene&&selected?sceneEditTarget(scene,selected):undefined
 const objectInfo=entity&&scene&&<div className="lya-help" data-testid="scene-edit-target"><strong>{sceneNodeName(entity,tr)}</strong> · {nodeRoleLabel(entity)}{editableEntity&&editableEntity.entityId!==entity.entityId&&<span> · {tr('编辑实例：','Editing instance: ')}{editableEntity.name} <button type="button" onClick={()=>chooseSceneEntity(editableEntity.entityId)}>{tr('选择编辑实例','Select editing instance')}</button></span>}{entity.parentId&&<span> · {tr('父节点：','Parent: ')}{scene.entities.find(item=>item.entityId===entity.parentId)?.name??entity.parentId} <button type="button" onClick={()=>chooseSceneEntity(entity.parentId!)}>{tr('选择父实例','Select parent instance')}</button></span>}<button type="button" onClick={()=>ui.openTool('scene')}>{tr('查看场景层级','Show scene hierarchy')}</button></div>
 const objectEditor=entity&&scene&&!readOnly?<>{objectInfo}<EntityEditor sceneId={scene.sceneId} revision={scene.revision} entity={editableEntity??entity} entities={scene.entities} tr={tr} commit={updateScene} exitBridge={cameraExitBridge} exitId={'entity-editor:'+api.clientId}/></>:undefined
 const objectPanel=<>
  {!objectEditor&&objectInfo}
  {!objectEditor&&<p className="lya-help">{!sessionId?tr("先在左侧选择工作区，再编辑对象。","Choose a workspace on the left to edit objects."):readOnly?tr("当前世界是只读投影，不能编辑。","The current world is a read-only projection."):tr("先选择一个对象：在场景层级里点它的名字，或在画布上点它。","Select an object first: click its name in the scene tree or click it on the canvas.")}</p>}
  {entity&&scene&&<PhysicsControls key={`${scene.sceneId}:${entity.entityId}`} scene={scene} selected={entity.entityId} resource={assets.find(asset=>asset.ref.resourceId===entity.resources[0]?.resourceId&&asset.ref.version===entity.resources[0]?.version)} world={world} frame={frame} tr={tr} disabled={readOnly||replayActive} update={input=>changePhysics('scene_physics_update',input)} bind={(input,signal)=>changePhysics('scene_bind_physics',input,signal)} progressIdentity={`${worldHostEpoch}:${sessionId}:${api.clientId}`} readProgress={async(resourceId,version,signal)=>(await api.request<{physicalization?:ResourcePhysicsProgress}>(`resource-physics?resourceId=${encodeURIComponent(resourceId)}&version=${version}`,{signal})).physicalization} openLibrary={()=>ui.openTool('asset')}/>}
  <fieldset className="lya-property-editor"><legend>{tr("变换","Transform")}</legend>
   <div className="lya-segment">{(["translate","rotate","scale"] as const).map((value,index)=><button key={value} type="button" aria-pressed={gizmo===value} disabled={readOnly||!selected} onClick={()=>setGizmo(value)}>{[tr("移动","Move"),tr("旋转","Rotate"),tr("缩放","Scale")][index]}</button>)}</div>
   <p className="lya-help">{tr("逐个选择实例后拖动手柄，或填写位置、方向与比例；提交后自动同步物理世界。","Select an instance, then drag its gizmo or edit position, orientation and scale. Physics synchronizes after the edit.")}</p>
   <div className="lya-row"><button disabled={replayActive||!viewerVisible||!scene} title={tr("只将相机移到主体中心，不改变模型位置。","Moves only the camera to the subject center; model positions stay unchanged.")} onClick={()=>viewer.current?.enterSceneCenter()}>{tr("进入场景中心","Enter scene center")}</button><button disabled={replayActive||!viewerVisible} onClick={()=>viewer.current?.frameAll()}>{tr("全景","Fit")}</button><button disabled={!selected||!viewerVisible} onClick={()=>selected&&viewer.current?.focus(selected)}>{tr("聚焦","Focus")}</button></div>
  </fieldset>
  <fieldset className="lya-property-editor"><legend>{tr("碰撞拓扑","Collision topology")}</legend>
   <label className="lya-field-label"><input type="checkbox" checked={display.collision===true} onChange={event=>setDisplay(value=>({...value,collision:event.target.checked}))}/>{tr("显示所选实例的碰撞表面与边","Show collision surfaces and edges of the selection")}</label>
   <p className="lya-help" data-testid="collision-display-status" data-collision-status={collisionStatus.status} data-collision-source={collisionStatus.source??''} data-collision-drawn={collisionStatus.drawn??0}>{collisionStatus.status==="ready"?tr(`${world?.engineId??''} 实际碰撞体：${collisionStatus.geoms} 个，已绘制 ${collisionStatus.drawn??0} 个；表面与边按当前物理帧显示。`,`${world?.engineId??''} compiled colliders: ${collisionStatus.geoms}, drawn: ${collisionStatus.drawn??0}; surfaces and edges follow the current physics frame.`):collisionStatus.status==="preview"?tr(`待引擎装配的碰撞预览：${collisionStatus.geoms} 个同版本已绑定派生形状；尚未读回引擎实际碰撞或接触。`,`Collision preview awaiting engine assembly: ${collisionStatus.geoms} derived shapes bound to this resource version; compiled colliders and contacts have not been observed.`):collisionStatus.status==="preview-waiting"?tr("正在读取同版本已绑定派生件，准备待引擎装配的碰撞预览…","Reading bound derived geometry for a collision preview awaiting engine assembly…"):collisionStatus.status==="generating"?tr("该实例的碰撞派生正在进行；完成绑定后显示真实形状。","Collision derivation is in progress; shapes will appear after binding completes."):collisionStatus.status==="disabled"?tr("碰撞表面与边已隐藏；碰撞参与仍由物理配置决定。","Collision surfaces and edges are hidden; physics configuration still controls collision participation."):collisionStatus.status==="unselected"?tr("选择实例根或任意视觉节点，即显示所属实例的碰撞体。","Select an instance root or visual node to display that instance's colliders."):collisionStatus.status==="stale-world"?tr("物理世界尚未应用当前场景。同步后读取实际碰撞体。","The physics world has not applied this scene revision. Sync to read compiled colliders."):collisionStatus.status==="no-world"?tr("已声明碰撞，等待物理世界装配后读取实际形状；当前没有可核的同版本派生预览。","Collision is declared. Waiting for engine assembly to read its compiled shapes; no verified derived preview is available for this version."):collisionStatus.status==="no-collider"?tr("这个实例尚无实际碰撞体。使用上方“生成并绑定真实碰撞”，再同步物理世界。","This instance has no compiled collider. Use Generate and bind colliders above, then synchronize physics."):collisionStatus.status==="unavailable"?tr("当前引擎未提供可绘制的实际形状；请查看下方缺项说明。","The engine has not provided drawable compiled shapes; see the missing items below."):tr("正在读取所选实例的实际碰撞表面与边…","Reading compiled collision surfaces and edges of the selection…")}</p>
   {(collisionStatus.inactive??0)>0&&<p className="lya-help">{tr(`${collisionStatus.inactive} 个形状未参与碰撞，以灰色边线显示。`,`${collisionStatus.inactive} shapes do not participate in collisions and are shown with gray edges.`)}</p>}
   {collisionStatus.infinitePlanes>0&&<p className="lya-help">{tr("地面为无限碰撞平面；画出的有限参考范围不是碰撞边界。","The ground is an infinite collision plane; its finite reference outline is not a collision boundary.")}</p>}
   {(collisionStatus.selectionOmitted??0)>0&&<p className="lya-help">{tr(`另有 ${collisionStatus.selectionOmitted} 个物理声明实体超出本次选择预算，请选择较小子树查看。`,`${collisionStatus.selectionOmitted} declared physics entities exceed this selection budget; select a smaller subtree to inspect them.`)}</p>}
   {(collisionStatus.unsupported>0||collisionStatus.omitted>0)&&<p className="lya-help">{tr(`未绘制：${collisionStatus.unsupported} 个不支持的形状、${collisionStatus.omitted} 个超预算形状。`,`Not drawn: ${collisionStatus.unsupported} unsupported shapes, ${collisionStatus.omitted} shapes beyond the preview budget.`)} {collisionStatus.reasons.join(" ")}</p>}
   {collisionStatus.status==="no-collider"&&<p className="lya-help">{tr('当前引擎未读到这个实例的碰撞体。上方“物理状态与操作”显示声明、同步状态及生成绑定入口。','No collider for this instance was read from the engine. Physics state and controls above show the declaration, synchronization status and binding entry.')}</p>}
  </fieldset>
  <fieldset className="lya-property-editor"><legend>{tr("添加与删除","Add and remove")}</legend>
   <label className="lya-field-label">{tr("新实体名称","New entity name")}<input className="lya-wide" aria-label={tr("新实体名称","New entity name")} value={newEntity} disabled={readOnly||!scene} onChange={event=>setNewEntity(event.target.value)}/></label>
   <div className="lya-row"><button className="lya-primary" disabled={readOnly||!scene||!newEntity.trim()} onClick={()=>perform(addEntity)}>{tr("添加空实体","Add empty entity")}</button><button className="lya-stop" disabled={readOnly||!selected||removing} onClick={()=>selected&&requestRemoval(selected)}>{tr("从场景移除选中","Remove selected from scene")}</button></div>
   <p className="lya-help">{tr("空对象用于组织场景。要添加可见模型，从下方“小物件库”加入已导入素材，或在素材库导入本地文件。","Empty objects help organize the scene. Add an imported model from the object library below, or import a local file in the library.")}</p>
  </fieldset>
  {importPurposeControl}
  <DomainAssetList domain="object" assets={assets} builtin={builtinAssets} busy={importBusy} available={Boolean(sessionId)} canMount={canMountAsset} tr={tr} importBuiltin={item=>perform(()=>importBuiltin(item))} mount={mountAsset} openLibrary={()=>{setImportUsageChoice(importUsage);ui.openTool("asset")}} instanceControls={assetInstanceControls}/>
 </>

 const robotSelected=Boolean(entity&&robotEntity(entity))
 const robotPanel=<>
  <div className="lya-section"><span>{tr("机器人","Robot")}</span><span className={ready?"lya-badge lya-badge-ok":robotSelected?"lya-badge lya-badge-accent":"lya-badge"}>{world?sceneWorldPhaseLabel(worldLifecycle.phase,tr):robotSelected?tr("已选中","Selected"):tr("未选中","None selected")}</span></div>
  <div data-testid="current-scene-robot-instances">
   <div className="lya-panel-title"><strong>{tr("当前场景机器人实例","Robot instances in this scene")}</strong></div>
   {(scene?.entities.filter(robotEntity)??[]).map(instance=><div className="lya-tree-row" key={instance.entityId} aria-selected={selected===instance.entityId}><button className="lya-tree-name" onClick={()=>{nativeControlCancel.current?.();selectedRef.current=instance.entityId;setSelected(instance.entityId);ui.showCentre("canvas")}}>⚙ {instance.name}</button><small>{instance.resources.map(ref=>`v${ref.version}`).join(" · ")} · {world&&world.sceneId===scene?.sceneId?tr("已绑定世界","World bound"):tr("未启动世界","World not started")}</small></div>)}
   {!scene?.entities.some(robotEntity)&&<p className="lya-help">{tr("当前场景没有机器人实例。下方机器人库保存的是素材，加入场景后才有可控制的实例。","No robot instance in the current scene. Library assets become controllable instances after mounting in a scene.")}</p>}
  </div>
  {entity&&robotSelected&&<RobotAuthoringPanel entity={entity} scene={scene} world={world} frame={frame} description={description} ready={ready&&!readOnly&&!replayActive} tr={tr} configure={applyRobotConfiguration} moveTcp={manualTcpMove} stop={()=>perform(()=>stop(false))} sync={()=>perform(()=>worldRef.current?sync():startWorld())} reset={()=>{const w=worldRef.current,s=sceneRef.current;if(w&&s)perform(()=>applyRobotConfiguration('sim_reset',{worldId:w.worldId,sceneId:s.sceneId,expectedRevision:s.revision,expectedGeneration:w.worldGeneration}))}} editPosition={()=>ui.openTool('object')} locate={kind=>locateRobotAnchor(entity.entityId,kind)}/>}
  {entity&&world&&robotSelected
   ?<>{entity.components.controller?.type==="drone"?<FlightControlPanel entity={entity} description={description} observation={observation} world={world} ready={ready} command={(name,input)=>api.command<any>(name,input)} tr={tr} describe={()=>perform(()=>describe(entity.entityId))} onWorldReset={next=>{setWorld(next);worldRef.current=next;setFrame(undefined);void refreshState(next.sceneId)}}/>:<RobotControlPanel key={`${scene?.sceneId}:${world.worldId}:${world.worldGeneration}:${entity.entityId}`} entity={entity} description={description} observation={observation} targets={targets[entity.entityId]??{}} controlBlocked={manualControlBlocked} setTargets={(values,draft)=>{if(api.areControlsBlocked())return;setTargets(old=>({...old,[entity.entityId]:values}));targetsRef.current={...targetsRef.current,[entity.entityId]:values};if(draft===true)manualDrafts.current.add(entity.entityId);else if(draft===false)manualDrafts.current.delete(entity.entityId)}} ready={ready} duration={duration} setDuration={setDuration} describe={()=>perform(()=>describe(entity.entityId))} move={(name,motion,label)=>perform(()=>move(name,motion,label))} fullMotion={()=>fullMotion(entity.entityId)} tr={tr} controlKey={`${world.worldId}:${world.worldGeneration}`} controlScope={{worldId:world.worldId,generation:world.worldGeneration}} liveMove={nativeJointMove} registerLiveCancel={cancel=>{nativeControlCancel.current=cancel}} cancelLive={display=>{const bound=world;void api.command("sim_stop",{worldId:bound.worldId,expectedGeneration:bound.worldGeneration,entityIds:[entity.entityId]},{sceneId:bound.sceneId,worldId:bound.worldId},undefined,display).catch(value=>setError(String(value)))}}/>}
    <details className="lya-advanced"><summary>{tr("动作结果","Action results")} ({actions.length})</summary><ActionCards actions={actions} tr={tr}/></details></>
   :robotSelected&&entity
    ?<p className="lya-help">{tr(`已选中机器人「${entity.name}」。启动模拟后即可调整关节与执行动作。`,`${entity.name} selected. Start simulation to adjust its joints and run actions.`)}</p>
    :<p className="lya-help">{tr("在场景中选择一个机器人，启动模拟后即可调整关节与执行动作；也可以从下方机器人库把它加入当前场景。","Select a robot in the scene and start simulation to use its controls; or add one from the robot library below.")}</p>}
  <PolicyLibraryPanel key={`${worldHostEpoch}:${scene?.sceneId}:${selected}`} available={Boolean(sessionId)} canLoad={!readOnly&&robotSelected} canRegister={!readOnly&&!replayActive} canLoadAsset={!readOnly&&Boolean(scene?.sceneId)} onAssetLoaded={(modelPath,downloadModelId,provenance)=>loadPackModel(modelPath,downloadModelId,provenance)} importReceipt={localPolicyImport&&localPolicyImport.sessionId===sessionId?localPolicyImport.receipt:undefined} sceneId={scene?.sceneId} expectedRevision={scene?.revision} entityId={robotSelected?entity?.entityId:undefined} worldId={world?.worldId} worldStatus={world?.status} expectedGeneration={world?.worldGeneration} command={(name,input)=>api.command<any>(name,input)} onActivated={result=>{if(sceneRef.current?.sceneId!==result.snapshot.sceneId)return;applySceneIfCurrent(sceneWritePort,result.snapshot.sceneId,result.snapshot);setWorld(result.world);worldRef.current=result.world;setFrame(undefined);setDescriptions({});descriptionsRef.current={};setTargets({});targetsRef.current={};persist(result.snapshot,result.world);setNotice(tr('所选实例已应用策略映射并建立固定步长世界；实际行走还需执行与回执。','Policy mapping applied and a fixed-step world created; walking still needs an execution receipt.'))}} chooseFile={window.lyapunovDesktop?async()=>{const files=await window.lyapunovDesktop!.selectFiles();return files[0]}:undefined} tr={tr}/>
  <DomainAssetList domain="robot" assets={assets} builtin={builtinAssets} busy={importBusy} available={Boolean(sessionId)} canMount={canMountAsset} tr={tr} importBuiltin={item=>perform(()=>importBuiltin(item))} mount={mountAsset} openLibrary={()=>ui.openTool("asset")} instanceControls={assetInstanceControls}/>
  <PackLibraryPanel scene={scene} available={Boolean(sessionId)} canLoad={!readOnly} busy={importBusy} tr={tr} command={(name,args)=>api.command<any>(name,args)} load={(modelPath,packId,provenance)=>loadPackModel(modelPath,packId,provenance)}/>
 </>

 // 命名相机（场景内容，`entity.components.viewerCamera`）：这里**不持有第二份状态**——
 // 读的就是场景快照里的那条组件（写回后下一轮轮询/提交返回的 rev 就是它），所以另一个窗口存的那台、
 // 或者用 scene_edit 直接改文档的，界面里立刻就是同一个列表；模型侧按名字应用它们走同一个读函数。
 const [rigSpec,setRigSpec]=useState<any>(),[rigVisible,setRigVisible]=useState(true),[lensFocal,setLensFocal]=useState("24"),[lensSensor,setLensSensor]=useState("36")
 const rigSpecRef=useRef<any>()
 const nativeCameras=useNativeCameraList({api,scene,world,active:open&&!replayActive&&uiState.tool==="camera"})
 const unavailableCameraNames:string[]=(nativeCameras.receipt?.cameras??[]).filter((row:any)=>row.available===false).map((row:any)=>row.cameraName)
 const cameraSpecs=projectSceneCameraRigs(scene,world,frame,cameraRigSpecs(nativeCameras.receipt?.cameras),unavailableCameraNames)
 useEffect(()=>{setRigSpec(undefined);rigSpecRef.current=undefined},[nativeCameras.key,api])
 // Scene/Frame 都在原 Viewer 中投影；离开面板后的跟随只用同帧 native，不继续清单轮询。
 useEffect(()=>{const instance=viewer.current;if(!instance)return;instance.onCameraRigSelect=spec=>{setRigSpec(spec);rigSpecRef.current=spec};instance.onCameraRigEdit=adjustRig;instance.setCameraRigs(cameraRigSpecs(nativeCameras.receipt?.cameras),{visible:rigVisible,unavailableCameraNames})},[nativeCameras.receipt,scene?.sceneId,scene?.revision,rigVisible])
 const sceneNamedCameras=namedCamerasOfScene(scene?.entities).cameras
 const cameraNames=sceneNamedCameras.map(row=>row.name)
 const [cameraName,setCameraName]=useState(""),[savingView,setSavingView]=useState(false),savingViewRef=useRef(false)
 /** 保存当前视角（= 一次 scene_edit，与工具 saveAs 同一条路；失败如实报错，界面不显示"已保存"）。 */
 const saveCameraView=()=>{const instance=viewer.current,current=sceneRef.current;let name=cameraName.trim();if(!instance||!current||savingViewRef.current)return
  const currentCameras=namedCamerasOfScene(current.entities).cameras
  if(!name){let number=1;while(currentCameras.some(camera=>camera.name===tr(`视角 ${number}`,`View ${number}`)))number++;name=tr(`视角 ${number}`,`View ${number}`)}
  // 存的是**当场量出来的**状态（含 roll/视场/裁剪面/内参）：恢复时才回得到同一台相机。
  const saved={name,savedAt:new Date().toISOString(),state:instance.getViewState() as unknown as NamedCamera["state"]}
  savingViewRef.current=true;setSavingView(true)
  perform(async()=>{try{await writeNamedCameras(current.sceneId,current.revision,withNamedCamera(currentCameras,saved));setCameraName("");setNotice(tr(`已保存机位「${name}」。`,`Saved view "${name}".`))}finally{savingViewRef.current=false;setSavingView(false)}})}
 /** 进入文档机位并保存主视图返程；姿态仍沿统一normalize/write路径。 */
 const restoreCameraView=(name:string)=>{const instance=viewer.current,current=sceneRef.current,row=sceneNamedCameras.find(item=>item.name===name);if(!instance||!current||!row)return
  perform(async()=>{enterSavedCameraView(instance,current,name);ui.showCentre("canvas")})}
 /** 删除一台（也是一次 scene_edit：与保存同一条写路径，不"本地删掉、文档还留着"）。 */
 const deleteCameraView=(name:string)=>{const current=sceneRef.current;if(!current)return
  perform(async()=>{await writeNamedCameras(current.sceneId,current.revision,withoutNamedCamera(sceneNamedCameras,name))})}
 /** S4 摄影口径（Isaac Camera Inspector 同款控制）：焦距＋传感器宽（mm）→ `fovyDeg` 提交到既有
  * `camera_adjust_ui`（`intrinsic-focal-rescale` 语义同向；K 的 fx/fy 比不掰平，见 `fovyFromLens`）；
  * 成功按回执归位视锥。只改视场、不给位姿 ⇒ 挂载相机不被冻结（合同既有语义）。 */
 const applyLensFov=()=>{
  const spec=rigSpecRef.current,current=sceneRef.current,live=worldRef.current
  if(!spec||!current)return
  const fovyDeg=fovyFromLens(spec.intrinsics,Number(lensFocal),Number(lensSensor))
  if(!Number.isFinite(fovyDeg)||fovyDeg<=0||fovyDeg>=180)return
  perform(async()=>{
   if(cameraReadOnlyRef.current)throw Error('CAMERA_SAVE_READ_ONLY')
   const declared=current.entities.find(entity=>entity.entityId===spec.entityId&&entity.components.camera)
   if(declared){
    const draft={...cameraDraftOfScene(current,declared),fovYDeg:String(fovyDeg)}
    await saveCameraInstallation({mode:'draft',sceneId:current.sceneId,expectedRevision:current.revision,entityId:declared.entityId,draft,...live?{worldId:live.worldId,expectedGeneration:live.worldGeneration}:{}})
    return
   }
   if(!live||live.sceneId!==current.sceneId||live.appliedSceneRevision!==current.revision)throw Error('CAMERA_LENS_WORLD_STALE')
   const result=await api.command<any>('camera_adjust_ui',{sceneId:current.sceneId,worldId:live.worldId,cameraName:spec.key,expectedGeneration:live.worldGeneration,clear:false,fovyDeg})
   const updated=frustumFromReceipt({cameraName:spec.key,worldFromCamera:result.worldFromCamera,intrinsics:result.calibration?.intrinsics??result.intrinsicsAtReferenceResolution,fovyDeg:result.fovyDeg,intrinsicsSource:result.calibration?.intrinsicsSource??result.intrinsicsSource??spec.intrinsicsSource,parentBodyName:result.parentBodyName??spec.parentBodyName,referenceFrame:result.referenceFrame,override:result.override})
   if(updated.ok&&sceneRef.current?.sceneId===current.sceneId&&worldRef.current?.worldGeneration===live.worldGeneration)viewer.current?.updateCameraRig(updated.spec)
   setNotice(tr('已设置临时试拍镜头；永久安装使用Scene保存。','Preview lens adjusted temporarily; save to Scene for a permanent installation.'))
  })
 }
 /** Scene相机安装持久CAS；原生源相机编辑明确是临时试拍。Promise失败保留Viewer草稿。 */
 const adjustRig=async(key:string,edit:any)=>{
  const spec=rigSpecRef.current,live=worldRef.current,current=sceneRef.current,requestAPI=apiRef.current
  try{
   if(cameraReadOnlyRef.current)throw Error('CAMERA_SAVE_READ_ONLY')
   if(!spec||spec.key!==key||!current)throw Error('CAMERA_RIG_SELECTION_STALE')
   const declared=current.entities.find(entity=>entity.entityId===spec.entityId&&entity.components.camera)
   if(declared){
    const draft=cameraDraftFromRigEdit(current,live,declared,edit)
    return await saveCameraInstallation({mode:'draft',sceneId:current.sceneId,expectedRevision:current.revision,entityId:declared.entityId,draft,...live?{worldId:live.worldId,expectedGeneration:live.worldGeneration}:{}})
   }
   if(!live||live.sceneId!==current.sceneId||live.appliedSceneRevision!==current.revision||edit.sceneId!==current.sceneId||edit.revision!==current.revision||edit.worldId!==live.worldId||edit.generation!==live.worldGeneration)throw Error('CAMERA_RIG_EDIT_WORLD_STALE')
   const body=cameraAdjustFromDrag(spec.key,spec.parentBodyName,edit)
   const result=await requestAPI.command<any>('camera_adjust_ui',{sceneId:current.sceneId,worldId:live.worldId,expectedGeneration:live.worldGeneration,clear:false,...body})
   if(apiRef.current===requestAPI&&sceneRef.current?.sceneId===current.sceneId&&worldRef.current?.worldGeneration===live.worldGeneration){
    const updated=frustumFromReceipt({cameraName:key,worldFromCamera:result.worldFromCamera,intrinsics:result.calibration?.intrinsics??result.intrinsicsAtReferenceResolution,fovyDeg:result.fovyDeg,intrinsicsSource:result.calibration?.intrinsicsSource??result.intrinsicsSource??spec.intrinsicsSource,parentBodyName:result.parentBodyName??spec.parentBodyName,referenceFrame:result.referenceFrame,override:result.override})
    if(updated.ok)viewer.current?.updateCameraRig(updated.spec)
    setNotice(tr('已应用临时试拍安装；要持久保存，请保存当前画面安装到Scene。','Temporary preview installation applied; save the current-view installation to Scene to keep it.'))
   }
   return result
  }catch(value){setError(value instanceof Error?value.message:String(value));throw value}
 }
 /** S2.5 Pilot（方案 §9-D5 通用交互）：透过该相机看（位姿＋K）／对齐机位（只换位姿，投影沿用当前）。
  * 都走 `applyCameraView`（写入＋当场核对，VIEWER_CAMERA.md §3 的同一份）；核对不过如实抛错，不装成功。
  * 取景框只给"透过该相机看"这一支（线框＝整块视口，与投影同一份映射，见 viewer `captureGateRect`）；
  * Viewer 侧在相机被导航/预设/换相机后自动收起，这里不重复存门状态。 */
 const pilotRig=(spec:any,lens:boolean)=>{const instance=viewer.current;if(!instance)return;perform(async()=>{instance.pilotCameraRig(spec.key,lens);ui.showCentre("canvas")})}
 const cameraPanel=<>
  <div className="lya-row"><button disabled={replayActive||!viewerVisible||!scene} onClick={()=>perform(takeCapture)}>{tr("采集图像","Capture")}</button><button disabled={replayActive||!viewerVisible||!scene} title={tr("只将相机移到主体中心，不改变模型位置。","Moves only the camera to the subject center; model positions stay unchanged.")} onClick={()=>viewer.current?.enterSceneCenter()}>{tr("进入场景中心","Enter scene center")}</button><button disabled={replayActive||!viewerVisible} onClick={()=>viewer.current?.frameAll()}>{tr("全景","Fit")}</button><button disabled={!selected||!viewerVisible} onClick={()=>selected&&viewer.current?.focus(selected)}>{tr("聚焦选中","Focus selected")}</button></div>
  {replayActive&&<p className="lya-help">{tr("录制回放为只读，返回实时视图后才能采集。","Recorded replay is read-only; return to the live view before capturing.")}</p>}
  <SceneCameraPanel api={api} scene={scene} world={world} receipt={nativeCameras.receipt} error={nativeCameras.error} readOnly={readOnly||replayActive} tr={tr} perform={perform} commit={updateScene} sampleCurrent={()=>{const current=sceneRef.current;if(!current)throw Error('CAMERA_SCENE_REQUIRED');return sampleCameraForAuthoring(viewer.current,current)}} saveInstallation={saveCameraInstallation} pilot={key=>{const spec=cameraSpecs.find(row=>row.key===key);if(spec)pilotRig(spec,true)}} aim={key=>cameraNavigation({action:'aimCameraView',sceneId:scene?.sceneId,cameraId:key})} returnView={()=>{exitCameraView();}} piloted={observerState?.mode!=='free'?observerState?.cameraId:undefined} selectCamera={key=>viewer.current?.selectCameraRig(key)} selectedCameraEntityId={rigSpec?.entityId} selectedRobotEntityId={robotSelected?entity?.entityId:undefined} prepareWorld={prepareCameraWorld} worldState={worldLifecycle} sceneSpecs={cameraSpecs} refresh={nativeCameras.refresh} exitBridge={cameraExitBridge}/>
  <CameraAimControl positionLocked={observerState?.positionLocked} spec={rigSpec} tr={tr} setFov={value=>perform(async()=>viewer.current?.setCameraRigAimFov(value))}/>
  {observerState?.mode==='camera-edit'&&<div className="lya-row"><span>{tr('正在编辑相机安装','Editing camera installation')}{observerState.dirty?tr(' · 未保存',' · unsaved'):''}</span><button onClick={()=>perform(async()=>{const source=viewer.current as unknown as CameraAuthoringViewer;if(!source.finishCameraRigEditing)throw Error('CAMERA_EDIT_FINISH_UNAVAILABLE');await source.finishCameraRigEditing({discard:false})})}>{tr('保存并结束编辑','Save and finish editing')}</button><button onClick={()=>perform(async()=>{const source=viewer.current as unknown as CameraAuthoringViewer;await source.finishCameraRigEditing?.({discard:true})})}>{tr('放弃草稿','Discard draft')}</button></div>}
  <fieldset className="lya-property-editor"><legend>{tr("相机预设","Camera presets")}</legend>
   <div className="lya-row">{(["perspective","top","front","side"] as const).map((value,index)=><button key={value} disabled={!viewerVisible} onClick={()=>viewer.current?.cameraPreset(value)}>{[tr("透视","Perspective"),tr("顶视","Top"),tr("前视","Front"),tr("侧视","Side")][index]}</button>)}</div>
  </fieldset>
  <details className="lya-advanced"><summary>{tr("视锥与镜头参数","Frustums and lens parameters")}</summary>
  <fieldset className="lya-property-editor"><legend>{tr("相机视锥","Camera frustums")}</legend>
   <label><input type="checkbox" checked={rigVisible} onChange={()=>{const next=!rigVisible;setRigVisible(next);viewer.current?.setCameraRigsVisible(next)}}/>{tr("在 3D 里显示相机视锥","Show camera frustums in 3D")}</label>
   {rigSpec&&<div className="lya-row"><button disabled={!viewerVisible} onClick={()=>pilotRig(rigSpec,true)}>{tr("透过该相机看","Look through this camera")}</button><button disabled={!viewerVisible} onClick={()=>pilotRig(rigSpec,false)}>{tr("对齐机位","Align view to this camera")}</button><button disabled={!viewerVisible||replayActive||readOnly||Boolean(!world&&!(scene?.entities.some(entity=>entity.entityId===rigSpec.entityId&&entity.components.camera&&!(entity.components.camera as any).mount)))} onClick={()=>viewer.current?.attachCameraRigGizmo(rigSpec.key)}>{tr("gizmo 调整安装位姿","Adjust mount pose with gizmo")}</button><button disabled={!viewerVisible||replayActive||readOnly} onClick={()=>cameraNavigation({action:'aimCameraView',sceneId:scene?.sceneId,cameraId:rigSpec.key})}>{tr("在安装原点调朝向","Aim from installation origin")}</button></div>}
   {rigSpec&&<div className="lya-row"><input type="number" aria-label={tr("焦距 mm","Focal length mm")} value={lensFocal} onChange={event=>setLensFocal(event.target.value)} style={{width:60}}/><input type="number" aria-label={tr("传感器宽 mm","Sensor width mm")} value={lensSensor} onChange={event=>setLensSensor(event.target.value)} style={{width:60}}/><button disabled={!viewerVisible||replayActive||readOnly||Boolean(!world&&!(scene?.entities.some(entity=>entity.entityId===rigSpec.entityId&&entity.components.camera)))} onClick={applyLensFov}>{tr("按摄影口径设 FOV","Set FOV from lens")}</button></div>}
   {rigSpec
    ?<p className="lya-help">{rigSpec.key} · {rigSpec.intrinsics.width}×{rigSpec.intrinsics.height} · fx {rigSpec.intrinsics.fx.toFixed(2)} / fy {rigSpec.intrinsics.fy.toFixed(2)} · cx {rigSpec.intrinsics.cx.toFixed(1)} / cy {rigSpec.intrinsics.cy.toFixed(1)} · K={rigSpec.intrinsicsSource}{rigSpec.parentBodyName?` · ${tr("挂载","mount")} ${rigSpec.parentBodyName} (${rigSpec.referenceFrame??"—"})`:""}{rigSpec.override?` · ${tr("临时 override","temporary override")}`:""}<br/>{tr("来源","Source")}={rigSpec.source} · {rigSpec.clipPlanesSource==="engine-global"?tr("near/far 为引擎全局实际值","near/far from engine-global clipping"):rigSpec.nearFarSource==="declared"?tr("near/far 为声明值","near/far declared"):tr("near/far 为显示默认（仅显示参数）","near/far display default (display-only)")}{rigSpec.notes?.length?` · ${rigSpec.notes.join("；")}`:""}</p>
    :<p className="lya-help">{tr("点 3D 里的视锥看它的标定读数（数据来自 camera_list 回执，不是第二份状态）。","Click a frustum in 3D for its calibration readout (data comes from the camera_list receipt, not a second state store).")}</p>}
  </fieldset>
  </details>
  <fieldset className="lya-property-editor"><legend>{tr("已保存视角","Saved views")}</legend>
   <div className="lya-row"><input aria-label={tr("相机名","Camera name")} placeholder={tr("机位名称（可选）","View name (optional)")} value={cameraName} onChange={event=>setCameraName(event.target.value)}/><button disabled={readOnly||replayActive||!viewerVisible||!scene||savingView} onClick={saveCameraView}>{savingView?tr("正在保存…","Saving…"):tr("保存当前视角","Save view")}</button></div>
   {cameraNames.length
    ?<div className="lya-row">{cameraNames.map(name=><span className="lya-row" key={name}><button aria-label={tr(`进入保存视角 ${name}`,`Enter saved view ${name}`)} disabled={replayActive||!viewerVisible} onClick={()=>restoreCameraView(name)}>{name}</button><button aria-label={tr(`删除相机 ${name}`,`Delete camera ${name}`)} onClick={()=>deleteCameraView(name)}>×</button></span>)}</div>
    :<p className="lya-help">{tr("在这个场景里保存几个机位：点名字进入已保存视角，再点返回主视图回到进入前的画面。滚转、视场和内参随机位保存。","Save camera views per scene: click a name to enter a saved view, then return to the main view to restore the previous camera. Roll, field of view and intrinsics stay with each view.")}</p>}
   <CameraReturnControl mode={observerState?.mode} tr={tr} returnView={()=>exitCameraView()}/>
  </fieldset>
  <fieldset className="lya-property-editor"><legend>{tr("显示","Display")}</legend>
   <label className="lya-field-label">{tr("点云画质","Point cloud quality")}<select aria-label={tr("点云画质","Point cloud quality")} value={display.splatQuality??'auto'} onChange={event=>setDisplay(old=>({...old,splatQuality:event.target.value as 'auto'|'fast'|'balanced'|'quality'}))}><option value="auto">{tr("自动","Auto")}</option><option value="fast">{tr("流畅","Fast")}</option><option value="balanced">{tr("均衡","Balanced")}</option><option value="quality">{tr("高画质","High quality")}</option></select></label>
   <p className="lya-help">{tr("调整当前绘制细节，原文件保持完整。切换画质不重新解码场景。","Changes drawing detail; the original remains complete. Switching quality does not decode the scene again.")}</p>
   <div className="lya-row">{(["grid","axes","wireframe","splats","collision"] as const).map((value,index)=><label key={value}><input type="checkbox" checked={display[value]} onChange={event=>setDisplay(old=>({...old,[value]:event.target.checked}))}/>{[tr("网格","Grid"),tr("坐标轴","Axes"),tr("线框","Wireframe"),"Gaussian",tr("碰撞","Collision")][index]}</label>)}
     <label title={tr("显示/隐藏场景作者在 Blender 里打的灯；关掉后仍有基础环境光，不会全黑。","Show or hide the lights the scene author placed in Blender. Basic ambient light remains, so the view never goes fully black.")}><input type="checkbox" checked={sceneLights} onChange={event=>setSceneLights(event.target.checked)}/>{tr("场景灯","Scene lights")}</label>
     <AnimationControls summary={animationSummary} requested={animationsPlaying} tr={tr} disabled={!viewerVisible} change={playing=>{const instance=viewer.current;if(!instance)return;setAnimationSummary(applyAnimationDisplay(instance,playing,true));setAnimationsPlaying(playing)}}/></div>
   <div className="lya-row"><label className="lya-help">{tr("背景颜色","Background color")}<input type="color" aria-label={tr("背景颜色","Background color")} value={display.background} onChange={event=>setDisplay(old=>({...old,background:event.target.value}))}/></label><button onClick={()=>setViewerVisible(!viewerVisible)}>{viewerVisible?tr("关闭 Viewer","Close viewer"):tr("重开 Viewer","Reopen viewer")}</button></div>
   <p className="lya-help">{tr("关闭 Viewer 只停显示，世界继续运行；停止按钮始终可用。","Closing the viewer only stops rendering; the world keeps running and Stop stays available.")}</p>
  </fieldset>
  {official&&world&&<fieldset className="lya-property-editor"><legend>{tr("官方视角","Official camera")}</legend><button aria-pressed={officialCamera} onClick={()=>setOfficialCamera(value=>!value)}>{officialCamera?tr("回到 3D 场景","Back to 3D scene"):tr("官方相机画面","Official camera view")}</button></fieldset>}
  <details className="lya-advanced"><summary>{tr("采集与临时调整","Capture and temporary overrides")}</summary>
  <CapturePanel api={api} captures={captures} capture={capture} sceneId={scene?.sceneId} sceneRevision={scene?.revision} world={world} readOnly={replayActive} select={setCapture} tr={tr} perform={perform} cameraReceipt={nativeCameras.receipt} refreshCameraList={nativeCameras.refresh} onCameraRigs={specs=>viewer.current?.setCameraRigs(specs,{visible:rigVisible,unavailableCameraNames})}/>
  </details>
 </>

 const assetPanel=<>
  {importPurposeControl}
  <details className="lya-property-editor"><summary>{tr("模型导入高级设置","Advanced model import settings")}{sourceTexturePolicy==='strict'?tr(" · 严格完整依赖"," · Complete dependencies"):""}</summary><label className="lya-field-label">{tr("OBJ / FBX 纹理策略","OBJ / FBX texture policy")}<select aria-label={tr("源模型纹理策略","Source model texture policy")} value={sourceTexturePolicy} disabled={importBusy} onChange={event=>setSourceTexturePolicy(event.target.value as 'strict'|'available')}><option value="available">{tr("保留几何与现有材质（默认）","Geometry and available materials (default)")}</option><option value="strict">{tr("严格完整依赖","Require complete dependencies")}</option></select></label><p className="lya-help">{sourceTexturePolicy==='strict'?tr("文件选择、本地路径与拖入均要求材质依赖完整；缺少外部纹理时停止导入。","File selection, local paths, and drop require complete material dependencies; missing external textures stop the import."):tr("直接打开模型会载入几何与现有材质，缺失纹理单独提示。此设置适用于文件选择、本地路径与拖入。","Opening a model loads its geometry and available materials, with a separate notice for missing textures. This setting applies to file selection, local paths, and drop.")}</p></details>
  <AssetLibraryPanel assets={assets} builtin={builtinAssets} builtinBusy={importBusy} query={assetQuery} loading={assetsLoading} includeDeleted={includeDeleted} canMount={canMountAsset} available={Boolean(sessionId)} tr={tr} {...assetInstanceControls}
   setQuery={setAssetQuery} setIncludeDeleted={setIncludeDeleted} search={()=>perform(()=>refreshAssets(assetQuery))} refresh={()=>perform(()=>refreshAssets())}
   mount={mountAsset} rename={asset=>setRenameAsset({resourceId:asset.ref.resourceId,original:asset.name,value:asset.name})}
   verify={asset=>perform(async()=>{const result=await api.command<{valid:boolean;missing:string[];changed:string[]}>("asset_verify",{resourceId:asset.ref.resourceId,version:asset.ref.version});setNotice(result.valid?tr(`${asset.name} 的文件可用。`,`${asset.name} files are available.`):tr(`${asset.name} 有 ${result.missing.length+result.changed.length} 个文件需要处理。`,`${asset.name} has ${result.missing.length+result.changed.length} file issues.`))})}
   toggleDeleted={asset=>perform(()=>toggleAssetDeleted(asset))}
   importFile={()=>{if(window.lyapunovDesktop)perform(async()=>{const paths=await window.lyapunovDesktop!.selectFiles();if(paths.length)await importLocalPaths(paths,"library")});else setAssetImportOpen(value=>!value)}} importBuiltin={item=>perform(()=>importBuiltin(item))} browseEnvironment={()=>ui.openTool("environment")}
   importPanel={assetImportOpen&&<form className="lya-library-import-section" onSubmit={event=>{event.preventDefault();perform(importToLibrary)}}>
    <label className="lya-field-label">{tr("本地模型路径","Local model path")}<input autoFocus className="lya-wide" aria-label={tr("导入素材路径","Asset import path")} placeholder="/path/to/model.glb" value={assetPath} onChange={event=>setAssetPath(event.target.value)}/></label>
    <p className="lya-help">{tr("导入后会保存在素材库，原文件保留。","The asset is added to your library. The original file is preserved.")}</p>
    <div className="lya-row"><button className="lya-primary" type="submit" disabled={importBusy||!assetPath.trim()}>{importBusy?tr("导入中…","Importing…"):tr("导入素材","Import asset")}</button><button type="button" onClick={()=>setAssetImportOpen(false)}>{tr("取消","Cancel")}</button></div>
   </form>}/>
  {missingAssets.length>0&&<section className="lya-asset-library" aria-label={tr("待恢复原件","Missing originals")}>
   <div className="lya-panel-title"><strong>{tr("待恢复原件","Missing originals")} {missingAssets.length}</strong><span><button disabled={missingAssetsLoading} onClick={()=>perform(refreshMissingAssets)}>{missingAssetsLoading?"…":tr("刷新","Refresh")}</button>{missingAssets.length>0&&<button disabled={missingAssetsLoading} onClick={()=>perform(rescanMissingAssets)}>{missingAssetsLoading?"…":tr("重扫原件","Rescan originals")}</button>}</span></div>
   {missingAssets.length===0?<p className="lya-help">{tr("没有迁移阻断的原件。","No blocked migrated originals.")}</p>:missingAssets.map(asset=><div className="lya-row" key={asset.resourceId}><span className="lya-help" title={asset.legacyPath??asset.resourceId}><span className="lya-badge lya-warning">BLOCKED</span> {asset.displayName??asset.resourceId}{asset.legacyPath?` · ${asset.legacyPath}`:""}</span><span className="lya-help">{tr("请放回同一路径后重新迁移。重扫只检查，不会自动替换。","Restore the original at this path and rerun migration. Rescan only checks; it never replaces files.")}</span></div>)}
  </section>}

 </>

 const environmentPanel=<>
  {!sessionId&&<p className="lya-help">{tr("先在左侧选择工作区，再搜索或下载环境素材。","Choose a workspace on the left to search for or download environment assets.")}</p>}
  <EnvironmentPanel status={environmentStatus} hdris={hdriAssets.map(item=>({resourceId:item.ref.resourceId,version:item.ref.version,name:item.name,mimeType:item.ref.original.mimeType}))} hdriBusy={hdriBusy} readOnly={readOnly} viewerVisible={viewerVisible} busy={!sessionId}
   apply={patch=>perform(()=>applyEnvironmentPatch(patch))} remove={()=>perform(removeEnvironment)} setPlaying={playing=>toggleDayNight(playing)}
   color={display.background} setColor={value=>setDisplay(old=>({...old,background:value}))} importHdri={path=>perform(()=>importHdriAsset(path))} refresh={()=>perform(()=>refreshHdriAssets())} tr={tr}/>
  <div className="lya-section"><span>{tr("环境素材","Environment assets")}</span>{envCandidates.length>0&&<span className="lya-section-side">{envCandidates.length}</span>}</div>
  {importPurposeControl}
  <button className="lya-library-import" onClick={()=>{setImportUsageChoice(importUsage);ui.openTool("asset")}}>{tr("打开素材库","Open asset library")} <span aria-hidden="true">↗</span></button>
  <DomainAssetList domain="environment" assets={assets} builtin={builtinAssets} busy={importBusy} available={Boolean(sessionId)} canMount={canMountAsset} tr={tr} importBuiltin={item=>perform(()=>importBuiltin(item))} mount={mountAsset} instanceControls={assetInstanceControls}/>
  <fieldset className="lya-property-editor"><legend>{tr("搜索下载环境","Search and download")}</legend>
   <div className="lya-row"><input className="lya-wide" aria-label={tr("环境需求","Environment query")} placeholder={tr("例如 indoor courtyard / forest terrain","for example indoor courtyard / forest terrain")} value={envQuery} onChange={event=>setEnvQuery(event.target.value)}/><button disabled={!sessionId||envBusy||!envQuery.trim()} onClick={()=>perform(searchEnvironment)}>{envBusy?"…":tr("检索","Search")}</button></div>
   {envNote&&<p className="lya-help">{envNote}</p>}
   {envCandidates.map(candidate=><div className="lya-env-card" key={candidate.assetId}>
    {candidate.thumbnailUrl?<img className="lya-env-thumb" src={candidate.thumbnailUrl} alt="" loading="lazy"/>:<span className="lya-env-thumb" aria-hidden="true"><WorkbenchIcon id="environment" size={20}/></span>}
    <div className="lya-env-main" title={candidate.pageUrl}><strong>{candidate.name}</strong><span>{candidate.categories.join("/")} · {candidate.license}</span></div>
    <div className="lya-env-actions"><button className="lya-chip" disabled={!sessionId||envBusy} onClick={()=>perform(()=>inspectEnvironment(candidate.assetId))}>{tr("核对","Inspect")}</button><button className="lya-chip lya-chip-accent" disabled={envBusy||readOnly||replayActive} onClick={()=>perform(()=>importEnvironment(candidate.assetId))}>{tr("下载导入","Download")}</button></div>
   </div>)}
   {envDetail&&<div className="lya-detail-box"><div className="lya-panel-title"><strong>{envDetail.name}</strong><span className="lya-help">{envDetail.license} · {envDetail.resolution}</span></div>
    <dl className="lya-kv"><dt>{tr("尺寸","Size")}</dt><dd>{envDetail.sizeM.map(value=>value.toFixed(2)).join(" × ")} m</dd><dt>{tr("三角面","Triangles")}</dt><dd>{envDetail.triangles}</dd><dt>Mesh</dt><dd>{envDetail.meshes}</dd><dt>{tr("材质","Materials")}</dt><dd>{envDetail.materials}</dd><dt>{tr("贴图","Images")}</dt><dd>{envDetail.images}</dd><dt>{tr("下载","Downloads")}</dt><dd>{envDetail.downloads.length} · {Math.round(envDetail.totalBytes/1024/1024)} MiB</dd></dl>
    <p className="lya-help">{envDetail.note}</p>
    <div className="lya-row"><button className="lya-chip lya-chip-accent" disabled={envBusy||readOnly||replayActive} onClick={()=>perform(()=>importEnvironment(envDetail.assetId))}>{tr("下载并导入","Download and import")}</button></div>
   </div>}
  </fieldset>
 </>

 const deliverables=<>
  <RecordingPanel visible={visible&&!globalPanel&&mode!=="chat"&&uiState.drawer==="deliverable"} api={api} sceneId={scene?.sceneId} world={world} tr={tr} perform={perform} onReplayChange={setReplayActive} close={()=>ui.closeDrawer()}/>
  <div className="lya-row"><strong>{tr("图像","Images")} {captures.length}</strong><button disabled={replayActive||!viewerVisible||!scene} onClick={()=>perform(takeCapture)}>{tr("采集图像","Capture")}</button></div>
  <div className="lya-captures">{captures.slice(0,12).map(record=><figure key={record.captureId}><img src={api.captureURL(record.captureId)} alt={record.captureId} width={record.attachment.width} height={record.attachment.height}/><figcaption className="lya-help">{record.capturedAt} · rev {record.sceneRevision}{record.worldId?` · ${record.worldId.slice(0,8)}`:""}</figcaption></figure>)}</div>
 </>

 const annotationPanel=<AnnotationPanel annotations={annotations} activeId={activeAnnotation} annotating={annotating} readOnly={readOnly} replayActive={replayActive} viewerVisible={viewerVisible} entityName={entityId=>scene?.entities.find(item=>item.entityId===entityId)?.name} onToggleMode={annotationActions.toggleMode} onSelect={annotationActions.select} onText={annotationActions.text} onRemove={annotationActions.remove} onCapture={()=>perform(annotationActions.capture)} inject={injectAnnotations} onInject={setInjectAnnotations} prompt={annotationPrompt} captures={annotationCaptures} tr={tr}/>
 const panels:Record<ToolId,ReactNode>={scene:scenePanel,environment:environmentPanel,robot:robotPanel,object:objectPanel,camera:cameraPanel,asset:assetPanel,annotation:annotationPanel}
 const canvas=<div className="lya-wb-canvas" aria-busy={renderLoading||Boolean(sceneCreating)} data-drop-target={dropTarget==="scene"||undefined}>
  <ViewerSurfaceState visible={viewerVisible} failure={renderFailure} hasScene={Boolean(scene)} available={!readOnly&&Boolean(sessionId)} creating={sceneCreating} stop={world&&sessionId&&!replayActive?()=>perform(()=>stop(true)):undefined} tr={tr} create={template=>perform(()=>createScene(template))} retry={()=>{setRenderFailure(undefined);setRenderRetry(value=>value+1)}} reopen={()=>{setRenderFailure(undefined);setViewerVisible(true)}}>
   <div ref={container} className="lya-canvas"/>
   {official&&world&&officialCamera&&<img className="lya-canvas" style={{position:"absolute",inset:0,objectFit:"contain",background:"#151b24"}} alt="official agentview" src={api.mediaURL("official-view",{worldId:world.worldId,step:String(frame?.stepIndex??0)})}/>}
   {scene&&<ViewerOverlays navigation={tr(VIEWER_NAVIGATION_HELP.zh,VIEWER_NAVIGATION_HELP.en)} importChoice={sessionId?<ImportPurposeChoice compact value={importUsage} disabled={importBusy} onChange={setImportUsageChoice} tr={tr}/>:undefined}>
    {placingAsset&&<AssetPlacementBar asset={placingAsset} point={placingPoint} tr={tr} alignment={value=>setPlacingAsset(current=>current?{...current,alignBottomToSurface:value}:undefined)} confirm={()=>perform(confirmPlacement)} cancel={exitPlacement}/>}
    {annotating&&!readOnly&&!replayActive&&<div className="lya-annotation-bar" aria-label={tr("批注模式","Annotation mode")}><strong>{tr("批注","Annotate")}</strong><span className="lya-muted">{tr("点物体表面落点，点已有标记改文字","Click a surface to drop a point; click a marker to edit")}</span><span className="lya-annotation-count">{annotations.length}</span><button className="lya-primary" onClick={annotationActions.toggleMode}>{tr("结束批注","Stop")}</button><button onClick={()=>ui.openTool("annotation")}>{tr("打开批注面板","Open panel")}</button></div>}
   </ViewerOverlays>}
   {renderLoading&&<div className="lya-file-drop-hint" role="status">{tr("正在加载场景…","Loading scene…")}</div>}
   {selected&&!replayActive&&<div className="lya-selection-bar" aria-label={tr("当前选中","Current selection")}><strong title={selected}>{entity?.name??selected}</strong><button onClick={()=>ui.openTool("object")}>{tr("编辑对象","Edit object")}</button>{world&&<button disabled={!sessionId} onClick={()=>perform(()=>stop(false))}>{tr("停止选中对象","Stop selected")}</button>}</div>}
  </ViewerSurfaceState>
 </div>

 return <div ref={frameRoot} onDragEnterCapture={event=>{if(event.dataTransfer.types.includes("Files")){event.stopPropagation();fileDragOver(event)}}} onDragOverCapture={fileDragOver} onDropCapture={fileDrop} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setDropTarget(undefined)}} className="lya-wb" data-mode={mode} data-global-panel={globalPanel||undefined} aria-label={t("open")}>
  <style>{workbenchStyle}</style>
  {dropTarget&&<div className="lya-file-drop-hint" role="status">{dropTarget==="library"?"松开以导入素材库":"松开以导入并加入场景"}</div>}
  {administrator&&<div className="lya-help lya-wb-admin" aria-label={tr("超级管理员模型调用","Super administrator model billing")}>{administrator.username} · {tr("超级管理员 · 自有 Key 直连，不扣平台积分","Super administrator · own key, no platform points")}</div>}
  <div className="lya-wb-body">
   {main?<><section className="lya-wb-conversation" style={{width:uiState.conversationWidth}} aria-label={tr("对话","Conversation")}>{main}</section>
    <div className="lya-wb-splitter" role="separator" aria-orientation="vertical" aria-label={tr("调整对话宽度","Resize conversation")} title={tr("拖动调整对话宽度（360–420）","Drag to resize the conversation (360–420)")}
      onPointerDown={event=>{
        const startX=event.clientX,startWidth=uiState.conversationWidth
        const node=event.currentTarget
        node.setPointerCapture(event.pointerId);node.dataset.dragging="1"
        const move=(moveEvent:PointerEvent)=>{if(moveEvent.buttons!==1)return;ui.setConversationWidth(startWidth+(moveEvent.clientX-startX))}
        const up=()=>{delete node.dataset.dragging;node.removeEventListener("pointermove",move);node.removeEventListener("pointerup",up)}
        node.addEventListener("pointermove",move);node.addEventListener("pointerup",up)
      }}/></>:null}
   <WorkSurface revealScene={revealScene} nativeTab={nativeTab} active={visible&&!globalPanel&&mode!=="chat"} sessionId={sessionId} tr={tr} renderSlot={renderSlot} centre={canvas} panel={uiState.tool?panels[uiState.tool]:null} retainedPanel={objectEditor?{tool:'object',children:objectEditor}:undefined} deliverables={deliverables}/>
   {!nativeTab&&<ToolRail tr={tr} engine={engineState.engine??engineState.preference??undefined} onSwitchEngine={switchEngine}/>}
  </div>
  {importTextureWarnings.length>0&&<div className="lya-wb-status" role="status" aria-label={tr("现有材质导入损失","Available material import losses")}><WorkbenchMessage kind="warning" summary={importTextureWarnings.length===1?importTextureWarnings[0]:tr(`${importTextureWarnings.length} 个文件已导入，部分材质依赖缺失。`,`${importTextureWarnings.length} files imported with missing material dependencies.`)} message={(importTextureDetails.length?importTextureDetails:importTextureWarnings).join('\n')} tr={tr} onDismiss={()=>{setImportTextureWarnings([]);setImportTextureDetails([])}}/></div>}
  {(scene||error||notice||replayActive||orientationStopTarget)&&<footer className="lya-wb-status" role="status">{scene&&!replayActive&&<SceneWorldStatus compact state={worldLifecycle} tr={tr} retry={()=>perform(startWorld)} cancel={()=>automaticWorld.cancel()} disabled={readOnly||!providerAvailable}/>}<WorkbenchMessage key={error?'error':replayActive?'replay':'notice'} kind={error?'error':'notice'} message={error||(replayActive?tr("回放只读取录制帧、不发送动作，也不暂停实时世界。","Replay only reads recorded frames and sends no actions; it does not pause the live world."):notice)} tr={tr} onDismiss={error?()=>setError(""):!replayActive&&notice?()=>setNotice(""):undefined}/><span className="lya-spacer"/>{orientationStopTarget&&<button type="button" className="lya-stop" data-testid="orientation-stop" disabled={orientationStopRef.current?.requested} onClick={()=>void stopOrientationCheck()}>{tr("停止方向检查","Stop orientation check")}</button>}{scene&&!replayActive&&<span className="lya-revision">rev {scene.revision}</span>}{frame&&!replayActive&&<span data-testid="world-step">{frame.simTime.toFixed(2)} s · {frame.stepIndex}</span>}</footer>}
  {/* D1：computer-use 事实的**常驻**呈现（不放进默认折叠的 `<details>`）——"本会话正在控制输入"与"恢复失败"
      是安全事实：用户上一次投诉的正是这两件事看不见（`VISIBILITY-HOLES-20260926.md`）。判据与 `settings` 那处
      共用 `computerUseNoticeLines()`：一个字段两处渲染，不是两套口径。 */}
  {computerUseNoticeLines(computerUse).length>0&&<footer className="lya-wb-status" data-testid="lyapunov-computer-use-row"><ComputerUseFacts computerUse={computerUse} tr={tr} place="status"/></footer>}
  {renameAsset&&<div className="lya-modal" role="dialog" aria-label={tr("改名资源","Rename asset")}><div className="lya-floating-panel lya-inspector"><div className="lya-panel-title"><strong>{tr("改名资源","Rename asset")}</strong><button onClick={()=>setRenameAsset(undefined)}>×</button></div><form onSubmit={event=>{event.preventDefault();perform(submitRename)}}><input autoFocus className="lya-wide" aria-label={tr("资源名称","Asset name")} value={renameAsset.value} onChange={event=>setRenameAsset(current=>current?{...current,value:event.target.value}:current)}/><div className="lya-row"><button type="submit" className="lya-primary">{tr("保存","Save")}</button><button type="button" onClick={()=>setRenameAsset(undefined)}>{tr("取消","Cancel")}</button></div></form></div></div>}
  {removal&&<SceneRemovalConfirmation target={removal} busy={removing} error={error} tr={tr} onCancel={()=>{setRemoval(undefined);setError("")}} onConfirm={()=>perform(confirmRemoval)}/>}
 </div>
}
