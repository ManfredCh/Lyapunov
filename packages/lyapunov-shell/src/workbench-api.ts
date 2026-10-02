import type {ControlGestureDisplay} from "./control-gesture.ts"
import type { SceneSnapshot,WorldHandle,Frame } from "../../lyapunov-contracts/src/types.ts"
import type {EnvironmentCaptureFace} from './environment-capture.ts'
import type {LodCaptureFace} from './lod-capture.ts'
import type {VerifiedAdministrator} from '../../lyapunov-product-bundle/src/account/administrator.ts'
/**
 * D1（`bugfixHistory/VISIBILITY-HOLES-20260926.md`）：computer-use 会话的**自报事实**——宿主 `plugin.ts` 的
 * `computerUseFacts()` 逐字投影（`active`/`since`/`consent`/`consentReason`/`indicator`/`snapshot`/`lastReport`/`refusals`）。
 *
 * 为什么单独立这一份合同：宿主一直在写这份投影（工具 JSON 与状态投影都在），而客户端**一个读取点都没有**
 * （`workbench.tsx` 里 `computerUse` 命中 0，本文件的 `WorkbenchState` 也没有这个键）⇒ 三件事用户全看不到：
 * 「这次会话正在控制输入」、「会话结束恢复失败了哪几项」、「哪些输入被拒了」。用户投诉过的正是这三件事的下游
 * 后果（探针往活桌面发键、把屏幕阅读器打开且停不掉）。**先有这份类型，再谈渲染**——没有它，渲染点连键都看不见。
 *
 * 只声明**本页要渲染**的字段（不声明＝不用）：宿主还投影 `snapshot.keys`（逐键原值，供诊断导出），
 * 那是"快照里存了什么"的正本，不在工作台逐键渲染，故不在此声明。
 */
export interface ComputerUseFacts {
  active:boolean
  since:string|null
  consent:boolean
  consentReason:string|null
  /** 可见指示的**实测**状态（`computer-use-input.ts` 的 `IndicatorState`）：`visible:false`＝用户看不见"正在控制输入"。 */
  indicator:{a11yStatusIcon:"visible"|"not-needed"|"unreadable";changedVisibility:boolean;notification:"sent"|"unavailable"|"failed";projection:boolean;visible:boolean;note:string}|null
  /** 桌面设置快照摘要（恢复的唯一依据）：`readableCount`＝这次真的读到了多少项。 */
  snapshot:{at:string;display:string;readableCount:number;note:string}|null
  /** 上一次会话结束的恢复报告：`failed` 非空＝有项没写回去（用户被留在被改过的环境里），必须可见。 */
  lastReport:{at:string;reason:string;note:string;restored:readonly string[];failed:readonly string[]}|null
  /** 被拒的输入（宿主保留最近 5 条）：`code`/`rule` 是拒它的判据，`combos` 是命中的组合键。 */
  refusals:Array<{at:string;tool:string;code:string;rule:string;combos:readonly string[]}>
}
export interface WorkbenchState { hostInstanceId:string; lastSceneId?:string; administrator?:VerifiedAdministrator['admin'];modelBilling?:'own-key';scene?:SceneSnapshot; worlds:WorldHandle[]; providerAvailable:boolean; captures?:CaptureRecord[]; recentActions?:Array<{id:string;label:string;waiting:boolean;receipt?:any;error?:string}>; uiActions?:Array<{id:string;action:string;args:Record<string,unknown>;enqueuedAt:string}>; /** 本窗口（clientId）自己的选择事实：多窗口同会话时，另一个窗口的选择不会覆盖它。 */ selection?:{clientId:string;facts:Record<string,unknown>}; /** D1：computer-use 会话事实（宿主 `computerUseFacts()`）；缺省＝宿主没给这一面。**渲染点**见 `workbench.tsx` 的 `ComputerUseFacts` 组件。 */ computerUse?:ComputerUseFacts }
/** 一条批注的落盘行：编号、文字、锚点（实体局部坐标 + 下单时世界坐标）。编号与标记、截图圈点同源。 */
export interface CaptureAnnotationRecord { index:number; annotationId:string; sceneId?:string; entityId:string; entity?:string; text:string; anchor:{entityId:string;local:[number,number,number];world:[number,number,number];normal?:[number,number,number]} }
/** 带批注采集在 state 投影里只给计数与摘要：界面列表用不到整套锚点，250ms 轮询不该背几百条坐标。 */
export interface CaptureAnnotationDigest { index:number; entity:string; text:string }
export interface CaptureRecord { captureId:string; sceneId:string; sceneRevision:number; worldId?:string; generation?:number; worldSceneRevision?:number; frameSceneRevision?:number; frameId?:string; stepIndex?:number; simTime?:number; capturedAt:string; imagePath:string; posePath?:string; attachment:{attachmentId:string;mediaType:string;width:number;height:number}; /** 附件库把图缩小入库时才有：原分辨率帧的逐字节副本（同一附件库的文件通道），`imagePath` 指向它；`attachment` 是预览。换算见 previewScaleOf/framePixelOfPreviewPixel。 */ originalImage?:{path:string;bytes:number;width:number;height:number;mediaType:string;storage:"verbatim";attachmentId:string}; camera?:unknown; /** 仅带批注的采集有：逐条编号/文字/锚点。 */ annotations?:CaptureAnnotationRecord[]; annotationCount?:number; annotationDigest?:CaptureAnnotationDigest[]; /** 带批注采集才有：发起时的相机位姿（"这张图什么视角"的正本）与喂给模型的说明。 */ prompt?:string; /** 说明投递失败时如实记录原因，不改采集本身。 */ injectionError?:string; /** 采集时该画面**可用但缺件**的警告（实体 id + 原因）：不是加载失败，但模型必须知道少的是哪一部分。 */ visualWarnings?:Array<{entityId:string;warning:string}>; /** 采集时这一帧的 **LOD 事实**：每个参与级别选择的实体用的是哪一级、哪份资源版本（`resourceId@version`）、多少三角形、距离多少。按距离正常简化时也要如实带出（数据集必须知道这份几何是简化件）；只有"比这台相机该用的级别更粗"或"该读的级别没读进来"才是降级。 */ lod?:LodCaptureFace; /** 载荷带了 LOD 面但整形没通过时的原因（见 `lod-capture.ts` 的 `lodFaceIssue`）：`lod` 读不出来**不等于**"场景里没有 LOD"，回执要如实说这一点。缺省＝这次载荷里根本没有这一面。 */ lodIssue?:string; /** 采集时这一帧的**环境光照事实**（请求的 HDRI 是否真的在画面里）：回退到内置光时必须随图如实带出。 */ environment?:EnvironmentCaptureFace }
/**
 * 附件库把大图缩成预览入库时的**坐标口径**：预览 = 原帧 × scale（整体等比缩放），像素按中心对齐（像素 i 的中心在 i+0.5）。
 * 宿主回执（`cameraImage.preview` / `imagePreviewNote`）与工作台采集面板的点击换算共用这一份，不各算各的。
 */
export interface PreviewScale { scaleX:number; scaleY:number }
export const previewScaleOf=(frame:{width:number;height:number},preview:{width:number;height:number}):PreviewScale=>({scaleX:preview.width/frame.width,scaleY:preview.height/frame.height})
/** 预览像素索引 → 原帧像素索引（中心约定；缩图上的读数必须走这一步回到原帧）。 */
export const framePixelOfPreviewPixel=(u:number,v:number,scale:PreviewScale):[number,number]=>[(u+0.5)/scale.scaleX-0.5,(v+0.5)/scale.scaleY-0.5]
/** 图片盒上的点 → 原帧像素索引（整数、夹在画面内）：盒子里显示的是 `preview`，交出去的坐标按 `frame`。 */
export const framePixelOfBoxPoint=(point:{x:number;y:number},box:{left:number;top:number;width:number;height:number},frame:{width:number;height:number},preview:{width:number;height:number}):[number,number]=>{
 const [u,v]=framePixelOfPreviewPixel((point.x-box.left)/box.width*preview.width-0.5,(point.y-box.top)/box.height*preview.height-0.5,previewScaleOf(frame,preview))
 return [Math.min(frame.width-1,Math.max(0,Math.round(u))),Math.min(frame.height-1,Math.max(0,Math.round(v)))]
}
/** 上面那条换算的文字形式（回执里给模型读的那句与 `cameraImage.preview.pixelMapping` 用的是同一份）。 */
export const previewPixelMappingText=(scale:PreviewScale):string=>`u_orig=(u_preview+0.5)/${String(scale.scaleX)}-0.5，v_orig=(v_preview+0.5)/${String(scale.scaleY)}-0.5`
/** 资源库在工作台只投影可操作的元数据；原始文件仍由 scene-kit 按 URI 管理。 */
export interface MissingAssetRecord {
  resourceId:string
  legacyPath?:string
  displayName?:string
  source?:string
  sourceRef?:string
  assetRevision?:string
  status:"BLOCKED"
  reason:string
  recovery:{action:"restore-original-at-source-path-and-rerun-migration";replacementAllowed:false}
}
export interface MissingAssetRescan {
  checkedAt:string
  status:"BLOCKED"|"READY_TO_RERUN"|"EMPTY"
  records:Array<MissingAssetRecord & {sourcePath:{state:"missing"|"present"|"not-file";size?:number;mtimeMs?:number}}>
}
export interface AssetRecord {
  ref:{resourceId:string;version:number;original:{uri:string;mimeType:string}}
  name:string
  tags:string[]
  folder:string
  deletedAt?:string
  parsed?:{kind?:string;mimeType?:string;dependencies?:unknown[]}
  sizeBytes?:number
  storage?:"cas"|"reference"
  storedEntryPath?:string
  origin?:"builtin"|"download"|"generated"|"import"
  physicalizationRequest?:false|{usage?:'dynamic'|'static'|'environment'}
  physicalization?:{status:string;usage?:'dynamic'|'static'|'environment'}
}
/** 产品自带物料库（scene-kit builtin-assets 投影）的条目；path 已解析为绝对路径，导入走 scene_import。 */
export interface BuiltinAssetRecord {
  resourceId:string
  assetId:string
  category:string
  kind:string
  path:string
  displayName:string
  sizeBytes?:number
  /** splat 的碰撞网格绑定（经 parseSceneGeometryBinding 解析的合同对象）；导入时原样转发给 scene_import。 */
  sceneGeometryBinding?:unknown
  transform?:unknown
  /** 内置具体模型的实际控制映射；scene_import 登记为该资源默认，之后按实例挂载沿用。 */
  components?:Entity['components']
}
export function workbenchAPI(sessionId:string){
  // 一个窗口一个客户端身份（按会话 memo：换会话即换身份）。选择事实、UI 动作的目标窗口、
  // 以及模型主动观察时的"目标窗口"都用它——同一份身份，不在各处各生成一个。
  const clientId=crypto.randomUUID()
  /**
   * 会话绑定：宿主的场景/世界/采集/录制路由一律**按会话取服务**，所以本窗口的每个请求都必须带上
   * 本窗口所属的会话标识（不是"默认会话"，也没有全局回退）。已经在 path 里带了 sessionId 的不重复追加。
   */
  const withSession=(path:string):string=>{
    if(!sessionId)return path
    const index=path.indexOf("?"),base=index<0?path:path.slice(0,index),query=new URLSearchParams(index<0?"":path.slice(index+1))
    if(!query.has("sessionId"))query.set("sessionId",sessionId)
    const text=query.toString()
    return text?`${base}?${text}`:base
  }
  /** 图片/媒体类 URL（`<img src>`、`<a href>`、Viewer 的资源解析）：同样必须按会话寻址。 */
  const mediaURL=(path:string,query:Record<string,string|undefined>={})=>{
    const search=new URLSearchParams()
    for(const [key,value] of Object.entries(query))if(value!==undefined)search.set(key,value)
    if(sessionId)search.set("sessionId",sessionId)
    return "/api/lyapunov/"+path+"?"+search.toString()
  }
  const request=async<T>(path:string,init?:RequestInit):Promise<T>=>{
    const res=await fetch("/api/lyapunov/"+withSession(path),{...init,headers:{"content-type":"application/json",...init?.headers}})
    const value=await res.json()
    if(!res.ok)throw new Error(value.error??res.statusText)
    return value
  }
  type ViewSelection={sceneId?:string;entityId?:string;worldId?:string;sequence:number}
  let controlsBlocked=false
  const setControlsBlocked=(value:boolean)=>{controlsBlocked=value}
  const motionCommand=(name:string,input:unknown)=>['robot_move','joint_move','vehicle_drive','robot_gripper','sim_execute_batch'].includes(name)||(name==='robot_flight'&&!['stop','status','describe'].includes(String((input as {operation?:unknown}|null)?.operation)))
  let currentSelection:{input:ViewSelection;pending:Promise<{updated:boolean;facts?:Record<string,unknown>}>}|undefined
  const clearControlSelection=()=>{currentSelection=undefined}
  const selection=(input:ViewSelection)=>{
    const stage={input:{...input},pending:request<{updated:boolean;facts?:Record<string,unknown>}>("view-selection",{method:"POST",body:JSON.stringify({sessionId,...input,clientId})})}
    currentSelection=stage;return stage.pending
  }
  // selection 是“命令发出时”的选择身份（sceneId/worldId）**加本窗口身份**：前者只随内部请求发给 Lyapunov
  // 的 command 路由，服务端据此对迟到的 world 生命周期结果做归属核对（判据锚在用户发出命令那一刻，而不是请求
  // 到达后才采到的选择）；clientId 让这次结果写回**本窗口自己**的选择槽，不落到别的窗口的选择上。
  /**
   * 命令回执只读**机器面**（服务端逐命令白名单投影的 `ui` 字段）：`text` 是人类公共面，
   * 不是业务结果（服务端从不把完整内部 JSON 发给浏览器，也就没有 `.result` 兜底可解析）。
   * 正式模式同样返回必要的授权业务字段；不能退回公共摘要，也不能丢掉按钮后续操作所需结果。
   */
  const command=async<T=unknown>(name:string,input:unknown,selection?:{sceneId?:string;worldId?:string},signal?:AbortSignal,display?:ControlGestureDisplay):Promise<T>=>{
    if(controlsBlocked&&motionCommand(name,input))throw Error('CONTROL_EXIT_IN_PROGRESS')
    if(display&&display.phase!=='stop'){
      const stage=currentSelection
      if(!stage||stage.input.sceneId!==selection?.sceneId||stage.input.worldId!==display.worldId||stage.input.entityId!==display.entityId)throw Error('CONTROL_SELECTION_CHANGED')
      signal?.throwIfAborted()
      const ack=signal?await new Promise<Awaited<typeof stage.pending>>((resolve,reject)=>{
        const abort=()=>reject(signal.reason??new DOMException('Control request cancelled','AbortError'))
        signal.addEventListener('abort',abort,{once:true})
        stage.pending.then(value=>{signal.removeEventListener('abort',abort);resolve(value)},error=>{signal.removeEventListener('abort',abort);reject(error)})
        if(signal.aborted)abort()
      }):await stage.pending
      signal?.throwIfAborted()
      const facts=ack.facts
      if(stage!==currentSelection||ack.updated!==true||facts?.sceneId!==selection?.sceneId||facts?.worldId!==display.worldId||facts?.entityId!==display.entityId||facts?.expectedGeneration!==display.generation)throw Error('CONTROL_SELECTION_CHANGED')
    }
    if(controlsBlocked&&motionCommand(name,input))throw Error('CONTROL_EXIT_IN_PROGRESS')
    const value=await request<{kind:string;text?:string;ui?:unknown}>("command",{method:"POST",signal,body:JSON.stringify({sessionId,name,input,...selection?{selection:{...selection,clientId}}:{},...display?{display:{...display,clientId}}:{}})})
    if(value.kind!=="success")throw new Error(value.text??"命令未成功")
    return (value.ui??null) as T
  }
  // sceneId 缺省即显式清除当前选择；单调 sequence 由调用方保持，迟到的旧选择写不回。
  //
  // state 查询带三件事：要读哪个场景（sceneId，可选）、这个窗口此刻**正在显示**的场景与版本
  // （displaySceneId/displayRevision）。后两者是"这个窗口在场且看的是什么"的事实，服务端据此
  // 分辨多窗口目标、并核对主动观察拿回来的图属于哪个版本——不新增上报通道，就走这次轮询。
  return {request,command,clientId,mediaURL,sessionId,selection,clearControlSelection,setControlsBlocked,areControlsBlocked:()=>controlsBlocked,state:(input?:{sceneId?:string;displaySceneId?:string;displayRevision?:number})=>{
    const query=new URLSearchParams({sessionId,clientId})
    if(input?.sceneId)query.set("sceneId",input.sceneId)
    if(input?.displaySceneId){query.set("displaySceneId",input.displaySceneId);if(input.displayRevision!==undefined)query.set("displayRevision",String(input.displayRevision))}
    return request<WorkbenchState>("state?"+query.toString())
  },frame:(worldId:string,collision?:{entityIds:string[];includeGeometry:boolean},selection?:{entityIds?:string[];sensors?:boolean;contacts?:boolean})=>{
    const query=new URLSearchParams({worldId})
    if(collision){query.set("collisionTopology","1");query.set("collisionGeometry",collision.includeGeometry?"1":"0");for(const id of collision.entityIds)query.append("collisionEntityId",id)}
    if(selection){for(const field of ['sensors','contacts'] as const)if(selection[field]!==undefined)query.set(field,selection[field]?'1':'0');for(const id of selection.entityIds??[])query.append('entityId',id)}
    return request<Frame>("frame?"+query.toString())
  },capture:(capture:Record<string,unknown>)=>command<CaptureRecord>("viewer_capture",{...capture,sessionId,clientId}),captureURL:(id:string)=>mediaURL("capture",{captureId:id})}
}
/** 桌面退出 owner 的状态订阅：失败解锁；不把 committing 冒充世界状态或触发新动作。 */
export function bindControlExitState(bridge:{onExitStateChanged?:(listener:(committing:boolean)=>void)=>()=>void}|undefined,api:{setControlsBlocked:(value:boolean)=>void},changed?:(value:boolean)=>void):()=>void {
 const update=(value:boolean)=>{api.setControlsBlocked(value);changed?.(value)}
 update(false)
 const remove=bridge?.onExitStateChanged?.(update)
 return()=>{remove?.();api.setControlsBlocked(false)}
}
/** DEV-031：跨运行根发现到的历史会话（只读事实；`logFile` 是稳定地址，恢复按它寻址）。 */
export interface HistoryEntryRecord { id:string; title:string; cwd:string; cwdExists:boolean; format:string; messages:number; attachments:number; root:string; sessionsDir:string; workspaceSlug:string; sessionDir:string; logFile:string; logBytes:number; current:boolean; archived:boolean; fixture:boolean; duplicateOf:string[]; restorable:boolean; reason:string }
export interface HistoryRootRecord { dshHome:string; sessionsDir:string; label:string; current:boolean; exists:boolean }
export interface SessionHistoryState { roots:HistoryRootRecord[]; entries:HistoryEntryRecord[] }
export interface SessionHistoryPrecheck { entry:HistoryEntryRecord; firstUserText:string|null; lines:number; readable:boolean }
export interface SessionHistoryRestore { status:"restored"|"already-present"|"rejected"; target:string; files:string[]; reason:string }
/**
 * ENV-10：一次**照片驱动的局部修正**的四要素记录（实体 / 原因 / 动作 / 复看机位 + 改前/改后 + 证据）。
 *
 * 为什么要有它：`environment-routing.ts` 的"局部短计划（实体、原因、动作、复看机位）"此前只是**规划文本**，
 * 没有结构化回执——事后无法核"改了哪个实体、依据什么、做了什么、从哪个机位复查、前后差多少"。
 * 形状不对就抛错（**不补默认值、不写空壳**）：编造一条"改过了"的记录比没有记录更糟。
 * 复看机位沿用 `viewer_camera_apply` 的 camera 块口径（`worldFromCamera` / `position` / `quaternion` / 内参）。
 */
export interface LocalCorrectionRecord {
  entity:string
  reason:string
  action:string
  reviewCamera:Record<string,unknown>
  before:unknown
  after:unknown
  evidence?:unknown
  sceneId?:string
  recordedAt:string
}

/** 校验并整形一条局部修正记录（纯函数，供工具与单测共用）。 */
export function localCorrectionRecordOf(input:unknown,recordedAt:string):LocalCorrectionRecord {
  if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("LOCAL_CORRECTION_INPUT_REQUIRED: 局部修正记录必须是对象")
  const raw=input as Record<string,unknown>
  const text=(key:"entity"|"reason"|"action"):string=>{
    const value=raw[key]
    if(typeof value!=="string"||!value.trim())throw new Error(`LOCAL_CORRECTION_${key.toUpperCase()}_REQUIRED: 局部修正记录必须写清 ${key}（四要素之一）`)
    return value.trim()
  }
  const reviewCamera=raw.reviewCamera
  if(!reviewCamera||typeof reviewCamera!=="object"||Array.isArray(reviewCamera))throw new Error("LOCAL_CORRECTION_REVIEWCAMERA_REQUIRED: 局部修正记录必须给出复看机位（viewer_camera_apply 的 camera 块口径：worldFromCamera/position/quaternion/内参）")
  if(raw.before===undefined||raw.after===undefined)throw new Error("LOCAL_CORRECTION_BEFORE_AFTER_REQUIRED: 局部修正记录必须同时给出 before 与 after（改前/改后的数值）")
  return {
    entity:text("entity"),reason:text("reason"),action:text("action"),
    reviewCamera:reviewCamera as Record<string,unknown>,
    before:raw.before,after:raw.after,
    ...(raw.evidence!==undefined?{evidence:raw.evidence}:{}),
    ...(typeof raw.sceneId==="string"&&raw.sceneId.trim()?{sceneId:raw.sceneId.trim()}:{}),
    recordedAt,
  }
}
/** 元数据来自 SceneStore 的持久化历史目录；完整快照仍由 scene_restore 按需读取。 */
export interface SceneVersion { sceneId:string; revision:number; entityCount:number; current:boolean }
import type {Entity} from '../../lyapunov-contracts/src/types.ts'
