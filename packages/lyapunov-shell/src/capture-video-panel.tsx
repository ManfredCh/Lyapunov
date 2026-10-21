/**
 * Capture 的自由视角 + A→B→C 路线界面（R-005 / V9）。
 *
 * 默认是同栏一页：标题 Capture、当前视角、拍照/开始拍摄、**唯一一套** Saved views 清单、
 * 进入 Camera route 的二级入口、已拍媒体与拍摄设置。路线是真正的同栏二级页（返回/名称/站点/
 * 时长/预览/录制），不在首屏摊一摞技术折叠项。
 *
 * 路线站点只按名字引用 Scene 里持久命名机位的 `ViewerViewState`；本文件不复制位姿、不新开相机
 * 数据库。站点真实位姿交给 Viewer 的 `setCaptureRouteTrail` 画相机/视锥，预览/录制中当前运动
 * 相机再走 `setCaptureRouteCurrentPose`。录制状态由画布底部小浮条承载（`CaptureSessionBar`），
 * 所有真实字节与相机采样仍由 `capture-session.ts` 产出，本文件不伪造画面或进度。
 */
import {useEffect,useRef,useState} from "react"
import type {NamedCamera} from "../../viewer/src/camera-view.ts"
import type {CaptureVideoRecord} from "./capture-video.ts"
import {MAX_ROUTE_HOLD_MS,MAX_ROUTE_SEGMENT_MS,MAX_ROUTE_STOPS,addRouteStop,moveRouteStop,planCaptureRoute,prepareCaptureRouteForSave,removeRouteStop,setRouteSegment,setRouteStopHold,normalizeQuat,rotateVec,type CaptureRoute} from "./capture-route.ts"
import type {ContinuousCaptureSession} from "./capture-session.ts"
import type {Translate} from "./entity-editor.tsx"
import type {CaptureRecord,workbenchAPI} from "./workbench-api.ts"
import {FooterActions,ListRow,PanelPage,PanelSection} from "./panel-chrome.tsx"
import {WorkbenchIcon} from "./vendor/tabler/icons.tsx"

const seconds = (value: number) => String(Math.round(value / 100) / 10)

/** 当前 Viewer 机位（含镜头；保存站点时用同一份 `ViewerViewState` 写回既有 NamedCamera owner）。 */
export type CaptureCurrentView = {position:number[];quaternion:number[];fovDeg?:number;near?:number;far?:number;intrinsics?:unknown}

/** 路线站点交给 Viewer 画总览/轨迹的只读投影：字段与 `setCaptureRouteTrail` 同形。 */
export type CaptureTrailStation = {key?:string;position?:number[];quaternion?:number[];fovDeg?:number;near?:number;far?:number;intrinsics?:unknown;available?:boolean;unavailableReason?:string}

/** 一个草稿站点在本面板里的只读投影：缺失/坏机位如实标不可用，不补位姿。 */
interface StopView {
  index: number
  stop: CaptureRoute["stops"][number]
  camera?: NamedCamera
  position?: number[]
  quaternion?: number[]
  fovDeg?: number
  near?: number
  far?: number
  intrinsics?: unknown
  available: boolean
  reason?: string
}

const finiteVec = (value: unknown, length: number): number[] | undefined =>
  Array.isArray(value) && value.length === length && value.every(item => typeof item === "number" && Number.isFinite(item)) ? [...value] : undefined
/** 持久机位里的 K 是外部输入：坏值当没有，不用它参与路线镜头插值或显示。 */
const validIntrinsics = (value: unknown): boolean => {
  if (value === undefined) return false
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return ["fx", "fy", "cx", "cy"].every(key => typeof row[key] === "number" && Number.isFinite(row[key]))
    && typeof row.width === "number" && Number.isInteger(row.width) && row.width > 0
    && typeof row.height === "number" && Number.isInteger(row.height) && row.height > 0
}
const poseText = (values: number[] | undefined, digits = 2) => values?.length ? values.map(value => value.toFixed(digits)).join(", ") : "—"
const stateOf = (camera: NamedCamera | undefined) => camera?.state

/** 英文产品界面：中文 reason 只作为原始码留在折叠详情，不直接铺在提示行。 */
const CJK = /[\u3400-\u9fff]/
const REASON_EN: Record<string,string> = {
  POSE_WRITE_DENIED:"The station pose could not be saved",
  CURRENT_POSE_DENIED:"The current view could not be written to the station",
  CAMERA_NOT_FOUND:"That saved camera no longer exists",
  SCENE_REQUIRED:"Choose a scene first",
  ROUTE_SAVE_DENIED:"The route could not be saved",
  ROUTE_DELETE_DENIED:"The route could not be deleted",
  OLD_OWNER_WRITE_FAILED:"A previous scene write failed; try again",
  SAVE_FAILED:"The recording could not be saved",
  RECORDING_FAILED:"Recording failed",
  CAPTURE_VIEW_UNAVAILABLE:"The current Viewer view is unavailable; show the Viewer and try again",
  VIDEO_BYTES_EMPTY:"No video bytes were received, so the file was not saved",
  VIDEO_CANCEL_PENDING:"A previous cancellation is still being confirmed; wait before recording again",
  VIDEO_CANVAS_UNAVAILABLE:"The live Viewer canvas is not available for recording",
  MEDIA_RECORDER_UNAVAILABLE:"This environment cannot record continuous video because MediaRecorder is unavailable",
  MEDIA_RECORDER_STOP_TIMEOUT:"The video encoder did not confirm the stop in time, so the file may be incomplete",
  MEDIA_RECORDER_CANCEL_TIMEOUT:"The video encoder did not confirm cancellation in time",
  ROUTE_MAX_STOPS:`A route supports at most ${MAX_ROUTE_STOPS} stops`,
  ROUTE_MIN_STOPS:"Keep at least 2 stops in a route",
  ROUTE_STOP_CAMERA_REQUIRED:"Choose a saved camera for this stop",
  ROUTE_HOLD_INVALID:"Enter a valid hold time",
  ROUTE_SEGMENT_INVALID:"Enter a valid segment duration",
  NO_SAVED_VIEW_OWNER:"Saved views are unavailable in this workspace",
  VIEW_SAVE_NOT_CONFIRMED:"The host did not add the named view to the scene, so no station was added",
  SAVED_VIEW_NOT_CONFIRMED:"The current view did not appear in the saved-view list, so it may not have been saved",
  VIEW_SAVE_TIMEOUT:"No saved view was confirmed before the timeout",
  VIEW_SAVE_CANCELLED:"Saving the current view was interrupted",
}
const REASON_ZH: Array<[string,string]> = [
  ["没有收到任何视频字节","no video bytes were received"],
  ["空录制不落盘","an empty recording is not saved"],
  ["当前环境没有 MediaRecorder，不能录制连续视频","MediaRecorder is unavailable, so continuous video cannot be recorded"],
  ["上一次取消尚未确认编码器关闭，不能开始新录制","a previous cancellation has not been confirmed; a new recording cannot start"],
  ["没有可录制的真实渲染画布","there is no live Viewer canvas to record"],
  ["未知容器","unknown container"],
]
/** 展示层：优先用已知码说人话；代码本身只进 <details>，未知中文不直接显示。 */
function readableReason(raw: string, fallback: string): {text:string;detail?:string} {
  const clean=String(raw ?? "").replace(/^Error:\s*/i,"").trim()
  const codes=clean.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? []
  let text=clean
  const known=codes.find(code=>REASON_EN[code])
  if(known){
    const at=clean.indexOf(known)
    const before=clean.slice(0,at).replace(/[\s:(]+$/,"").trim()
    const after=clean.slice(at+known.length).replace(/^:\s*/,"").replace(/[.;\s)]+$/,"").trim()
    text=REASON_EN[known]!
    if(before&&!CJK.test(before))text=`${before}: ${text}`
    if(after&&!CJK.test(after))text=`${text}: ${after}`
  }else{
    for(const [zh,en] of REASON_ZH)text=text.split(zh).join(en)
  }
  if(!text||CJK.test(text))text=fallback
  if(!/[.!?]$/.test(text))text=`${text}.`
  const detail=[...new Set(codes)].join(" · ")||(!CJK.test(clean)?clean:undefined)
  return {text,...detail&&detail!==text?{detail}:{}}
}

/** 错误/原因统一展示：英文可读句在前，原始 reason 码收进折叠详情。 */
function ReasonAlert({raw,fallback,testId}:{raw:string;fallback:string;testId?:string}){
  const {text,detail}=readableReason(raw,fallback)
  return <div className="lya-help lya-error" role="alert" data-testid={testId} style={{overflowWrap:"anywhere"}}>
    <p style={{margin:0}}>{text}</p>
    {detail&&<details className="lya-advanced" data-testid={testId?`${testId}-details`:"capture-reason-details"}><summary>Technical details</summary><code style={{fontSize:11,overflowWrap:"anywhere",whiteSpace:"pre-wrap"}}>{detail}</code></details>}
  </div>
}

/** 默认站点名要唯一：同名保存会覆盖既有命名机位，不静默覆盖。 */
function uniqueViewName(base:string,cameras:readonly NamedCamera[]):string{
  const used=new Set(cameras.map(camera=>camera.name))
  const current=(base.trim()||"Station A").slice(0,60)
  if(!used.has(current))return current
  let index=2
  while(used.has(`${current} ${index}`)&&index<100)index++
  return `${current} ${index}`.slice(0,60)
}

interface PendingViewSave{name:string;started:boolean;resolve:()=>void;reject:(error:Error)=>void;timer?:ReturnType<typeof setTimeout>}

/** 一个命名机位 → 站点投影。可用性判据与 Viewer 的显示几何一致：真位姿 + 真镜头。 */
function stopViewOf(stop: CaptureRoute["stops"][number], index: number, cameras: readonly NamedCamera[]): StopView {
  const camera = cameras.find(row => row.name === stop.cameraName)
  if (!camera) return {index, stop, available: false, reason: "The saved camera no longer exists."}
  const state = stateOf(camera) as any
  const position = finiteVec(state?.position, 3)
  const quaternion = finiteVec(state?.quaternion, 4)
  const intrinsics = validIntrinsics(state?.intrinsics) ? state.intrinsics : undefined
  const fovDeg = typeof state?.fovDeg === "number" && Number.isFinite(state.fovDeg) ? state.fovDeg : undefined
  const near = typeof state?.near === "number" && Number.isFinite(state.near) ? state.near : undefined
  const far = typeof state?.far === "number" && Number.isFinite(state.far) ? state.far : undefined
  if (!position) return {index, stop, camera, available: false, reason: "The saved camera has no valid position."}
  if (!quaternion) return {index, stop, camera, available: false, reason: "The saved camera has no valid rotation."}
  if (intrinsics === undefined && fovDeg === undefined) return {index, stop, camera, available: false, reason: "The saved camera has no lens (intrinsics or fovDeg)."}
  return {index, stop, camera, position, quaternion, ...(fovDeg === undefined ? {} : {fovDeg}), ...(near === undefined ? {} : {near}), ...(far === undefined ? {} : {far}), ...(intrinsics === undefined ? {} : {intrinsics}), available: true}
}

type CaptureWriteKind = "station" | "route-save" | "route-delete"

function StationPoseEditor({view,tr,disabled,onSave,onUseCurrentView,canUseCurrentView}:{view:StopView;tr:Translate;disabled:boolean;onSave:(state:CaptureCurrentView)=>Promise<boolean>;onUseCurrentView:()=>void;canUseCurrentView:boolean}) {
  const initial = () => ({position:view.position!.join(", "),quaternion:view.quaternion!.join(", "),fov:view.fovDeg === undefined ? "" : String(view.fovDeg)})
  const [fields,setFields]=useState(initial)
  const [error,setError]=useState("")
  const [saving,setSaving]=useState(false)
  const [notice,setNotice]=useState("")
  const savingRef=useRef(false)
  const apply=async()=>{
    if(disabled||savingRef.current)return
    const vector=(text:string,size:number)=>{const parts=text.trim().split(/[\s,]+/).filter(Boolean).map(Number);return parts.length===size&&parts.every(Number.isFinite)?parts:undefined}
    const position=vector(fields.position,3),rotation=vector(fields.quaternion,4),fov=fields.fov.trim()?Number(fields.fov):undefined
    if(!position||!rotation||!Number.isFinite(Math.hypot(...rotation))||Math.hypot(...rotation)===0||(!view.intrinsics&&(fov===undefined||!Number.isFinite(fov)||fov<=0||fov>=180))){setError(tr("请输入有效的 XYZ、非零 xyzw 四元数及 0–180° 视场角。","Enter finite XYZ, a nonzero xyzw quaternion and a field of view between 0 and 180 degrees."));return}
    const quaternion=normalizeQuat(rotation),state=view.camera!.state
    const target=finiteVec(state.target,3)
    const distance=target?Math.hypot(...target.map((value,index)=>value-state.position[index]!)):NaN
    if(!Number.isFinite(distance)||distance<=0){setError(tr("机位缺少有效的观察目标。","The saved view has no valid target."));return}
    const forward=rotateVec(quaternion,[0,0,-1])
    const next={...state,position,quaternion,target:position.map((value,index)=>value+forward[index]! * distance),up:rotateVec(quaternion,[0,1,0]),...view.intrinsics?{}:{fovDeg:fov}}
    savingRef.current=true;setSaving(true);setError("");setNotice("")
    try{if(await onSave(next))setNotice(tr("站点已保存。","Station saved."))}catch(failure){setError(String(failure))}finally{savingRef.current=false;setSaving(false)}
  }
  return <div data-testid="capture-station-editor">
    <div className="lya-section"><span>{tr("站点位姿","Station pose")}</span><span className="lya-section-side">{tr("XYZ / xyzw / FOV","XYZ / xyzw / FOV")}</span></div>
    <label className="lya-field-row"><span className="lya-field-label">{tr("位置 · XYZ（米）","Position · XYZ (m)")}</span><input style={{minWidth:0,width:"100%"}} aria-label="Station position XYZ" value={fields.position} disabled={disabled||saving} onChange={event=>setFields({...fields,position:event.target.value})}/></label>
    <label className="lya-field-row"><span className="lya-field-label">{tr("方向 · xyzw 四元数","Rotation · xyzw quaternion")}</span><input style={{minWidth:0,width:"100%"}} aria-label="Station quaternion xyzw" value={fields.quaternion} disabled={disabled||saving} onChange={event=>setFields({...fields,quaternion:event.target.value})}/></label>
    {!view.intrinsics&&<label className="lya-field-row"><span className="lya-field-label">{tr("镜头 · 视场角（度）","Lens · FOV (degrees)")}</span><input type="number" min={1} max={179} aria-label="Station field of view" value={fields.fov} disabled={disabled||saving} onChange={event=>setFields({...fields,fov:event.target.value})}/></label>}
    <p className="lya-help" data-testid="capture-station-orientation-help">{tr("方向以保存的 xyzw 四元数表示，站点保持这次保存的朝向。当前版本没有目标跟踪或朝向锁定，不提供该开关。","Rotation is the saved xyzw quaternion; the station keeps this saved direction. Target tracking and orientation lock are not available in this build, so no such control is offered.")}</p>
    <div className="lya-row">
      <button type="button" disabled={disabled||saving} onClick={()=>void apply()}>{saving?tr("正在保存…","Saving…"):tr("应用站点","Apply station")}</button>
      <button type="button" disabled={saving} onClick={()=>{setFields(initial());setError("");setNotice("")}}>{tr("复位输入","Reset inputs")}</button>
      <button type="button" disabled={disabled||saving||!canUseCurrentView} title={tr("把当前 Viewer 视角写回该站点引用的命名机位。","Writes the current Viewer view back to the named camera referenced by this stop.")} onClick={onUseCurrentView}>{tr("用当前视角更新站点","Use current view to update station")}</button>
    </div>
    {error&&<ReasonAlert raw={error} fallback={tr("站点位姿未能保存。","The station pose could not be saved.")} testId="capture-station-error"/>}
    {notice&&<p className="lya-help" role="status">{notice}</p>}
  </div>
}

export function ContinuousCapturePanel({session,cameras,routes,videos,captures,api,sceneId,sceneRevision,tr,perform,readOnly,replayActive,viewerVisible,worldReady=true,saveRoutes,onTrail,onRouteOverview,onTrailCurrent,currentView,onUpdateCameraPose,onSelectStop,onTakeImage,takeImageBusy,onSaveView,viewSaving,onSelectView,onDeleteView}:{
  session: ContinuousCaptureSession
  cameras: readonly NamedCamera[]
  routes: readonly CaptureRoute[]
  videos: readonly CaptureVideoRecord[]
  captures: readonly CaptureRecord[]
  api: ReturnType<typeof workbenchAPI>
  sceneId?: string
  /** 当前场景版本：保存路线时作为**源快照版本**写进路线记录，不硬编码 0。 */
  sceneRevision?: number
  tr: Translate
  perform: (fn: () => Promise<unknown>) => void
  readOnly: boolean
  replayActive: boolean
  viewerVisible: boolean
  /** 路线预览/录制必须先有真实物理世界：没有世界时按钮禁用并给原因。 */
  worldReady?: boolean
  saveRoutes: (next: readonly CaptureRoute[]) => Promise<unknown>
  /** 把草稿/录制路线站点的真实相机位姿交给 Viewer 画轨迹；不改 cameraRigs owner。 */
  onTrail?: (stations: CaptureTrailStation[], selected: number) => void
  /** 路线总览：把真实站点相机与场景主体一起框进主视口；只移查看相机，不 pilot、不选站。 */
  onRouteOverview?: (stations: CaptureTrailStation[]) => void
  /** 路线预览/录制中当前运动相机的实时 pose/前向；`undefined` 隐藏。 */
  onTrailCurrent?: (pose?: CaptureCurrentView) => void
  /** 当前 Viewer 机位（用于把站点姿态更新回持久命名机位）。 */
  currentView?: () => CaptureCurrentView | undefined
  /** 把某站点的命名机位姿态写回 Scene 的 viewerCamera owner。 */
  onUpdateCameraPose?: (cameraName: string, state: CaptureCurrentView) => Promise<unknown> | unknown
  /** 选中站点时同步高亮它在 Viewer 里的真实机位视锥。 */
  onSelectStop?: (cameraName?: string) => void
  /** 画布上的拍照主动作（真实 `capture()` 路径由 workbench 提供）。 */
  onTakeImage?: () => void
  takeImageBusy?: boolean
  /** 收藏视角的保存/恢复/删除仍走 Scene 的 viewerCamera owner。 */
  onSaveView?: (name: string) => Promise<unknown> | void
  viewSaving?: boolean
  onSelectView?: (name: string) => void
  onDeleteView?: (name: string) => void
}) {
  const [draft,setDraft] = useState<CaptureRoute>(() => emptyRoute(sceneId,sceneRevision))
  const [pick,setPick] = useState("")
  const [routeError,setRouteError] = useState("")
  const [selectedStop,setSelectedStop]=useState(-1)
  const [routeOpen,setRouteOpen]=useState(false)
  const [poseNotice,setPoseNotice]=useState("")
  const [cameraName,setCameraName]=useState("")
  const [stationName,setStationName]=useState("")
  const [quickSaving,setQuickSaving]=useState(false)
  const [viewNotice,setViewNotice]=useState("")
  const [viewError,setViewError]=useState("")
  const [pendingWrite,setPendingWrite]=useState<CaptureWriteKind>()
  const [routeNotice,setRouteNotice]=useState("")
  // 站点与路线都写同一 Scene owner：同步 ref 阻止同批次点击，状态负责可见互锁。
  const writeRef=useRef<object | undefined>(undefined)
  const pendingViewSave=useRef<PendingViewSave|undefined>(undefined)
  const viewSavingRef=useRef(viewSaving)
  const viewFingerprintRef=useRef<Set<string>|undefined>(undefined)
  const viewSaveRequested=useRef(false)
  const ownerRef=useRef({sceneId,api})
  if(ownerRef.current.sceneId!==sceneId||ownerRef.current.api!==api)ownerRef.current={sceneId,api}
  const writeBusy=pendingWrite!==undefined
  const active = session.phase !== "idle"
  const blocked = readOnly || replayActive || !viewerVisible || !sceneId
  const blockedReason = readOnly ? tr("当前场景只读。","This scene is read-only.") : replayActive ? tr("录制回放只读；返回实时视图后才能拍摄。","Replay is read-only; return to the live view before capturing.") : !viewerVisible ? tr("Viewer 未显示。","The Viewer is hidden.") : !sceneId ? tr("先选择场景。","Choose a scene first.") : ""
  const stopViews = draft.stops.map((stop,index) => stopViewOf(stop,index,cameras))
  const selectedView = selectedStop >= 0 ? stopViews[selectedStop] : undefined
  const current = (()=>{try{return currentView?.()}catch{return undefined}})()
  const plan = planCaptureRoute(draft,cameras)
  const draftCheck = prepareCaptureRouteForSave(draft,sceneId,sceneRevision,draft.savedAt)
  const draftHint = draftCheck.route ? "" : draftCheck.reason
  const planReason = plan.ok ? "" : plan.reason
  const allStopsAvailable = stopViews.length >= 2 && stopViews.every(view => view.available)
  const canOverview = stopViews.some(view => view.available)
  const canRun = Boolean(!active && !writeBusy && !blocked && worldReady && draftCheck.route && plan.ok && allStopsAvailable)
  const canSave = Boolean(!active && !writeBusy && !blocked && draftCheck.route && allStopsAvailable)
  const nextLetter = draft.stops.length < MAX_ROUTE_STOPS ? String.fromCharCode(65+draft.stops.length) : "—"
  const quickBlocked = Boolean(active||writeBusy||blocked||viewSaving||quickSaving||!onSaveView||draft.stops.length>=MAX_ROUTE_STOPS)
  const quickBlockedReason = !onSaveView ? tr("此工作区没有保存视角的入口。","Saved views are unavailable in this workspace.") : draft.stops.length>=MAX_ROUTE_STOPS ? tr(`最多 ${MAX_ROUTE_STOPS} 个机位。`,`A route supports at most ${MAX_ROUTE_STOPS} stops.`) : blocked ? blockedReason : viewSaving||quickSaving ? tr("正在写入命名机位。","A saved view is being written.") : undefined
  const writeReason = pendingWrite==="station" ? (quickSaving ? tr("正在保存当前视角为站点…","Saving current view as station…") : tr("正在保存站点…","Saving station…")) : pendingWrite==="route-delete" ? tr("正在删除路线…","Deleting route…") : pendingWrite==="route-save" ? tr("正在保存路线…","Saving route…") : ""
  const runReason = writeReason || planReason || draftHint || (!worldReady ? tr("先准备物理世界：路线预览/录制需要一个已运行的物理世界。","Prepare a physics world first: route preview/recording needs a running world.") : "") || (!allStopsAvailable ? tr("有站点机位不可用：请重选或删除该站。","A stop camera is unavailable; reselect or remove that stop.") : "")
  const totalSeconds = seconds(draft.segmentMs.reduce((sum,value)=>sum+value,0)+draft.stops.reduce((sum,stop)=>sum+stop.holdMs,0))

  const load = (route: CaptureRoute) => { setDraft({ ...route, stops: route.stops.map(row => ({ ...row })), segmentMs: route.segmentMs.map(value => value) }); setSelectedStop(-1); setPick(""); setRouteError("");setPoseNotice("");setRouteNotice("");setStationName("");onSelectStop?.(undefined) }
  const addStop = () => {
    if (!pick) return
    setRouteError("")
    // 先同步验证纯转换，再交给 React；不能把可能抛错的转换留到 updater/render 阶段。
    guard(() => setDraft(addRouteStop(draft, { cameraName: pick, holdMs: 200 }, 2000)))
  }
  const guard = (run: () => void) => { try { run() } catch (failure) { setRouteError(failure instanceof Error ? failure.message : String(failure)) } }
  /**
   * 保存路线：先把草稿的 sceneId/版本钉到**当前**来源快照，再走与读入同一份 `normalizeCaptureRoute` 校验。
   * 空名、少于两站、非法段时长/停留一律不提交，也不显示"已保存"；草稿不属于当前场景时拒绝写旧 Scene。
   */
  const write = async(kind:CaptureWriteKind,save:()=>Promise<unknown>,success?:()=>void):Promise<boolean> => {
    if(writeRef.current||active||blocked)return false
    const token={},owner=ownerRef.current
    writeRef.current=token;setPendingWrite(kind)
    try{
      await save()
      if(ownerRef.current!==owner)return false
      success?.()
      return true
    }catch(failure){
      if(ownerRef.current!==owner)return false
      throw failure
    }finally{
      if(writeRef.current===token){writeRef.current=undefined;setPendingWrite(undefined)}
    }
  }
  const persist = (next: CaptureRoute) => {
    if(writeRef.current||active||blocked)return
    const prepared = prepareCaptureRouteForSave(next, sceneId, sceneRevision, new Date().toISOString())
    if (!prepared.route) { setRouteError(prepared.reason ?? tr("路线无效","Invalid route")); return }
    setRouteError("");setRouteNotice("")
    perform(async()=>{
      try{await write("route-save",()=>saveRoutes([prepared.route!, ...routes.filter(row => row.routeId !== prepared.route!.routeId)]),()=>{setDraft(prepared.route!);setRouteNotice(tr("路线已保存。","Route saved."))})}
      catch(failure){setRouteError(String(failure))}
    })
  }
  const deleteRoute = (route:CaptureRoute) => {
    if(writeRef.current||active||blocked)return
    setRouteError("");setRouteNotice("")
    perform(async()=>{
      try{await write("route-delete",()=>saveRoutes(routes.filter(row=>row.routeId!==route.routeId)),()=>setRouteNotice(tr("路线已删除。","Route deleted.")))}
      catch(failure){setRouteError(String(failure))}
    })
  }
  const saveStation = (name:string,state:CaptureCurrentView) => onUpdateCameraPose ? write("station",async()=>{await onUpdateCameraPose(name,state)}) : Promise.resolve(false)
  const startRoute = (mode:"preview"|"record") => {
    if(writeRef.current||!canRun)return
    setRouteError("");session.startRoute(draft,cameras,mode)
  }
  const newRoute = () => { setDraft(emptyRoute(sceneId,sceneRevision)); setSelectedStop(-1); setPick(""); setRouteError(""); setPoseNotice("");setRouteNotice("");setStationName("");onSelectStop?.(undefined) }
  /** 保存当前视角（自由视角任务）。没有 Promise 回执的宿主由 viewSaving + cameras 清单确认落盘。 */
  const saveCurrentView = () => {
    if(blocked||viewSaving||!onSaveView)return
    setViewError("");setViewNotice("");viewSaveRequested.current=true
    try{
      const result=onSaveView(cameraName)
      if(result&&typeof result.then==="function")result.catch(failure=>{viewSaveRequested.current=false;setViewError(failure instanceof Error?failure.message:String(failure))})
    }catch(failure){viewSaveRequested.current=false;setViewError(failure instanceof Error?failure.message:String(failure))}
  }
  // 宿主保存视角时没有返回 Promise：用 viewSaving 开始/结束 + 权威 cameras 清单确认"真的落盘"。
  // 成功才提示并追加站点；失败/超时保留草稿，错误原因在折叠详情里给原始码。
  useEffect(()=>{
    const was=viewSavingRef.current
    viewSavingRef.current=viewSaving
    const pending=pendingViewSave.current
    if(!pending)return
    if(cameras.some(camera=>camera.name===pending.name)){
      pendingViewSave.current=undefined
      if(pending.timer!==undefined)clearTimeout(pending.timer)
      pending.resolve()
      return
    }
    if(viewSaving&&!was)pending.started=true
    else if(pending.started&&was&&!viewSaving){
      pendingViewSave.current=undefined
      if(pending.timer!==undefined)clearTimeout(pending.timer)
      pending.reject(Error("VIEW_SAVE_NOT_CONFIRMED"))
    }
  },[cameras,viewSaving])
  useEffect(()=>{
    if(!viewSaveRequested.current)return
    const fingerprint=(camera:NamedCamera)=>JSON.stringify([camera.name,camera.savedAt,camera.state])
    if(viewSaving){if(viewFingerprintRef.current===undefined)viewFingerprintRef.current=new Set(cameras.map(fingerprint));return}
    const before=viewFingerprintRef.current
    if(before===undefined)return
    viewFingerprintRef.current=undefined;viewSaveRequested.current=false
    const changed=cameras.find(camera=>!before.has(fingerprint(camera)))
    if(changed){setViewError("");setViewNotice(tr(`已保存视角「${changed.name}」，现在在清单中。`,`Saved view “${changed.name}” is now in the list.`))}
    else setViewError("SAVED_VIEW_NOT_CONFIRMED")
  },[viewSaving,cameras])
  useEffect(()=>()=>{const pending=pendingViewSave.current;if(!pending)return;pendingViewSave.current=undefined;if(pending.timer!==undefined)clearTimeout(pending.timer);pending.reject(Error("VIEW_SAVE_CANCELLED"))},[])
  /**
   * 一步把当前 Viewer 视角存成命名机位，成功后再按既有 addRouteStop 追加为下一站。
   * 不新建相机类型/API：写回仍走 onSaveView -> Scene viewerCamera owner；失败不追加、草稿不变。
   */
  const saveCurrentViewAsStation = () => {
    if(quickBlocked)return
    const requested=stationName.trim().slice(0,60)
    const letter=String.fromCharCode(65+draft.stops.length)
    const name=requested||uniqueViewName(`Station ${letter}`,cameras)
    if(requested&&cameras.some(camera=>camera.name===requested)){
      setRouteNotice("")
      setRouteError(tr(`已有同名视角「${name}」。请换一个站点名称，或先从清单删除它。`,`A saved view named “${name}” already exists. Choose another station name or delete that view first.`))
      return
    }
    setRouteError("");setRouteNotice("");setQuickSaving(true)
    perform(async()=>{
      try{
        await write("station",()=>new Promise<void>((resolve,reject)=>{
          const pending:PendingViewSave={name,started:false,resolve,reject}
          pending.timer=setTimeout(()=>{
            if(pendingViewSave.current!==pending)return
            pendingViewSave.current=undefined
            reject(Error("VIEW_SAVE_TIMEOUT"))
          },15000)
          pendingViewSave.current=pending
          try{
            const result=onSaveView!(name)
            if(result&&typeof result.then==="function")result.then(()=>{/* cameras 清单确认落盘 */},failure=>{
              if(pendingViewSave.current!==pending)return
              pendingViewSave.current=undefined
              if(pending.timer!==undefined)clearTimeout(pending.timer)
              reject(failure instanceof Error?failure:Error(String(failure)))
            })
          }catch(failure){
            if(pendingViewSave.current!==pending)return
            pendingViewSave.current=undefined
            if(pending.timer!==undefined)clearTimeout(pending.timer)
            reject(failure instanceof Error?failure:Error(String(failure)))
          }
        }),()=>{
          const index=draft.stops.length
          setDraft(addRouteStop(draft,{cameraName:name,holdMs:200},2000))
          setSelectedStop(index)
          onSelectStop?.(name)
          setStationName("")
          setRouteNotice(tr(`已把当前视角保存为站点 ${String.fromCharCode(65+index)}：${name}。`,`Saved current view as station ${String.fromCharCode(65+index)}: ${name}.`))
        })
      }catch(failure){
        setRouteError(failure instanceof Error?failure.message:String(failure))
      }finally{setQuickSaving(false)}
    })
  }

  // 路线轨迹只在路线二级打开、或路线正在预览/录制时出现；切走立即清掉，不影响机器人已挂载机位。
  const trailStations = stopViews.map(view => ({key: view.camera?.name ?? `stop:${view.index}`, ...(view.position ? {position:view.position} : {}), ...(view.quaternion ? {quaternion:view.quaternion} : {}), ...(view.fovDeg === undefined ? {} : {fovDeg:view.fovDeg}), ...(view.near === undefined ? {} : {near:view.near}), ...(view.far === undefined ? {} : {far:view.far}), ...(view.intrinsics === undefined ? {} : {intrinsics:view.intrinsics}), available:view.available, ...(view.reason ? {unavailableReason:view.reason} : {})}))
  const trailKey = JSON.stringify(trailStations)
  useEffect(()=>{
    if(!onTrail)return
    const show=routeOpen||session.phase==="route-preview"||session.phase==="route-record"
    onTrail(show?trailStations:[],show?selectedStop:-1)
    return ()=>{onTrail([],-1)}
    // trailKey 是站点位姿/可用性的稳定签名；数组本身每次渲染都是新对象。
  },[onTrail,routeOpen,selectedStop,session.phase,trailKey])
  const currentPose = session.currentPose
  const currentKey = currentPose ? JSON.stringify([currentPose.position,currentPose.quaternion,currentPose.fovDeg??null,currentPose.near??null,currentPose.far??null,currentPose.intrinsics??null]) : ""
  useEffect(()=>{
    if(!onTrailCurrent)return
    const show=session.phase==="route-preview"||session.phase==="route-record"
    onTrailCurrent(show?currentPose:undefined)
    return ()=>{onTrailCurrent(undefined)}
  },[onTrailCurrent,session.phase,currentKey])

  const updatePose=()=>{
    const name=draft.stops[selectedStop]?.cameraName
    if(writeRef.current||active||blocked||!name||!onUpdateCameraPose||!currentView)return
    setPoseNotice("");setRouteError("")
    perform(async()=>{
      try{
        const state=currentView();if(!state)throw Error('CAPTURE_VIEW_UNAVAILABLE')
        if(await saveStation(name,state))setPoseNotice(tr("站点姿态与镜头已保存回命名机位。","Station pose and lens saved to the named camera."))
      }catch(failure){setRouteError(String(failure))}
    })
  }

  const feedback=<>
    {session.error&&<ReasonAlert raw={session.error} fallback={tr("拍摄报告了错误。","Capture reported an error.")} testId="capture-session-error"/>}
    {session.notice&&<p className="lya-help" role="status">{session.notice}</p>}
    {session.orphan&&<div className="lya-row" data-testid="capture-orphan"><span className="lya-help lya-error">{session.orphan.bytes} B · {session.orphan.mimeType||"unknown"}</span><a href={session.orphan.url} download={session.orphan.fileName}>{tr("下载已录字节","Download recorded bytes")}</a></div>}
  </>
  if(active)return <div className="lya-capture-home" data-testid="capture-active">
    <PanelSection label={session.phase==="free"?tr("自由视角","Free view"):tr("相机路线","Camera route")}>
      <p className="lya-help" role="status">{session.phase==="cancelling"?tr("正在取消…","Cancelling…"):session.saving?tr("正在保存…","Saving…"):session.phase==="route-preview"?tr("预览路线中","Previewing route"):tr("拍摄中","Capturing")}</p>
      {/* 设计稿 V8-24：拍摄态只有状态与画布浮条；停/取消的位置由浮条自身表达，不再用文字复述。 */}
    </PanelSection>
    {feedback}
  </div>

  if(routeOpen)return <PanelPage title={tr("相机路线","Camera route")} back={tr("‹ 拍摄","‹ Capture")} onBack={()=>{if(!writeRef.current)setRouteOpen(false)}}>
   <div className="lya-capture-route" data-testid="capture-route">
    {feedback}
    <div className="lya-field-row"><span className="lya-field-label" style={{flex:"0 0 auto"}}>{tr("名称","Name")}</span><input style={{flex:"1 1 120px",minWidth:0}} aria-label={tr("路线名","Route name")} value={draft.name} disabled={active||writeBusy} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} placeholder={tr("路线名称","Route name")}/><button type="button" className="lya-chip" data-testid="capture-route-save" aria-label={tr("保存路线","Save route")} disabled={!canSave} onClick={()=>persist(draft)}>{tr("保存","Save")}</button></div>
    <div className="lya-section"><span>{tr("从当前视角加站","Add station from current view")}</span><span className="lya-section-side">{tr(`下一站 ${nextLetter}`,`Next stop ${nextLetter}`)}</span></div>
    <div className="lya-row" data-testid="capture-quick-station">
      <input aria-label={tr("新站名称","Station name")} placeholder={tr(`可选名称；默认 Station ${nextLetter}`,`Name (optional); default Station ${nextLetter}`)} value={stationName} disabled={active||writeBusy} onChange={event=>setStationName(event.target.value)}/>
      <button type="button" data-testid="capture-save-current-as-station" disabled={quickBlocked} title={quickBlockedReason} onClick={saveCurrentViewAsStation}>{quickSaving?tr("正在保存当前视角…","Saving current view…"):tr("保存当前视角为站点","Save current view as station")}</button>
    </div>
    <div className="lya-section"><span>{tr("站点","Waypoints")}</span><span className="lya-section-side">{draft.stops.length} · {totalSeconds} s</span></div>
    <ol className="lya-route-stops">
      {stopViews.map(view => {
        const stop=view.stop,index=view.index
        return <li key={`${stop.cameraName}:${index}`} data-testid={`route-stop-${index}`} data-selected={selectedStop===index||undefined} data-unavailable={!view.available||undefined}>
          <button type="button" className="lya-route-pin" aria-label={tr(`选择第 ${index+1} 站`,`Select stop ${index+1}`)} aria-pressed={selectedStop===index} disabled={writeBusy} onClick={()=>{setSelectedStop(index);onSelectStop?.(view.available?stop.cameraName:undefined)}}>{String.fromCharCode(65+index)}</button>
          <button type="button" className="lya-row-main" aria-label={tr(`查看第 ${index+1} 站`,`Inspect stop ${index+1}`)} disabled={writeBusy} onClick={()=>{setSelectedStop(index);onSelectStop?.(view.available?stop.cameraName:undefined)}}>
            <span className="lya-row-title">{stop.cameraName}</span>
            {(!view.available||stop.holdMs>0)&&<span className="lya-row-subtitle">{view.available?`${tr("停留","Hold")} ${seconds(stop.holdMs)} s`:(view.reason??tr("机位不可用","Camera unavailable"))}</span>}
          </button>
          <span className="lya-row-side">{index < draft.stops.length - 1 ? `${seconds(draft.segmentMs[index] ?? 0)} s` : ""}</span>
          <details className="lya-route-stop-menu"><summary aria-label={tr("站点设置","Stop options")} title={tr("站点设置","Stop options")}>⋯</summary>
            <div className="lya-route-stop-editor">
              <label>{tr("停留秒","Hold s")}<input type="number" min={0} max={MAX_ROUTE_HOLD_MS / 1000} step={0.1} aria-label={tr("停留秒","Hold seconds")} value={seconds(stop.holdMs)} disabled={active||writeBusy} onChange={event => guard(() => setDraft(setRouteStopHold(draft, index, Number(event.target.value) * 1000)))}/></label>
              {index < draft.stops.length - 1 && <label>{tr("段时长秒","Segment s")}<input type="number" min={0.1} max={MAX_ROUTE_SEGMENT_MS / 1000} step={0.1} aria-label={tr("段时长秒","Segment seconds")} value={seconds(draft.segmentMs[index] ?? 0)} disabled={active||writeBusy} onChange={event => guard(() => setDraft(setRouteSegment(draft, index, Number(event.target.value) * 1000)))}/></label>}
              <div className="lya-row"><button type="button" disabled={active || writeBusy || index === 0} aria-label={tr("上移","Move up")} onClick={() => setDraft(current => moveRouteStop(current, index, -1))}>↑</button><button type="button" disabled={active || writeBusy || index === draft.stops.length - 1} aria-label={tr("下移","Move down")} onClick={() => setDraft(current => moveRouteStop(current, index, 1))}>↓</button><button type="button" disabled={active || writeBusy || draft.stops.length <= 2} aria-label={tr("删除该站","Remove stop")} onClick={() => guard(() => setDraft(removeRouteStop(draft, index)))}>{tr("删除","Remove")}</button></div>
            </div>
          </details>
        </li>
      })}
    </ol>
    {/* 设计稿 capture-route：行尾是一个 “+ Add saved view” 入口；选择器放在其折叠内。 */}
    <details className="lya-advanced" data-testid="capture-route-add"><summary>+ {tr("添加已保存视角","Add saved view")}</summary>
    <div className="lya-row">
      <select aria-label={tr("添加机位","Add camera")} value={pick} disabled={active||writeBusy} onChange={event => setPick(event.target.value)}>
        <option value="">{cameras.length ? tr("添加已保存视角","Add saved view") : tr("还没有已保存的视角","No saved views yet")}</option>
        {cameras.map(camera => <option key={camera.name} value={camera.name}>{camera.name}</option>)}
      </select>
      <button disabled={active || writeBusy || !pick || draft.stops.length >= MAX_ROUTE_STOPS} title={draft.stops.length >= MAX_ROUTE_STOPS ? tr(`最多 ${MAX_ROUTE_STOPS} 个机位`,`Maximum ${MAX_ROUTE_STOPS} stops`) : undefined} onClick={addStop}>{tr("加入路线","Add stop")}</button>
      {/* 清空草稿是真动作，但设计稿首屏不放第二个同级文字入口：降级为 chip，与「路线总览」同一视觉层级。 */}
      <button type="button" className="lya-chip" data-testid="capture-route-new" disabled={active||writeBusy} onClick={newRoute}>{tr("新建路线","New route")}</button>
    </div>
    </details>
    {routes.length > 0 && <details className="lya-advanced" data-testid="capture-saved-routes">
      <summary>{tr("已保存路线","Saved routes")} · {routes.length}</summary>
      <div className="lya-list">{routes.map(route => <div className="lya-list-row" key={route.routeId}>
        <button type="button" className="lya-row-main" aria-label={route.name} aria-pressed={draft.routeId === route.routeId} disabled={active||writeBusy} onClick={() => load(route)}>
          <span className="lya-row-title">{route.name}</span>
          <span className="lya-row-subtitle">{route.stops.map((stop, index) => `${String.fromCharCode(65 + index)} · ${stop.cameraName}`).join(" → ")}</span>
        </button>
        <span className="lya-row-side">{route.stops.length} {tr("站","stops")}</span>
        <button type="button" className="lya-icon-button" aria-label={tr(`删除路线 ${route.name}`,`Delete route ${route.name}`)} disabled={active||blocked||writeBusy} onClick={() => deleteRoute(route)}>×</button>
      </div>)}</div>
    </details>}
    {/* 设计稿 capture-route：站点列表 + 双动作即止；位姿编辑是技术细节，默认折叠。 */}
    {selectedView&&<details className="lya-advanced" data-testid="capture-route-pose-panel"><summary>{tr("站点","Stop")} {String.fromCharCode(65+selectedView.index)} · {tr("位姿与镜头","Pose and lens")}</summary><div className="lya-route-pose" data-testid="capture-route-pose">
      <div className="lya-section"><span>{tr("站点","Stop")} {String.fromCharCode(65+selectedView.index)} · {tr("位姿","Pose")}</span><span className="lya-section-side">{selectedView.available?tr("可编辑","editable"):tr("不可用","unavailable")}</span></div>
      {selectedView.available?<div data-testid="capture-route-pose-details">
        <StationPoseEditor key={`${selectedView.index}:${selectedView.camera?.name}:${JSON.stringify(selectedView.camera?.state)}`} view={selectedView} tr={tr} disabled={blocked||writeBusy||!onUpdateCameraPose} onSave={state=>saveStation(selectedView.stop.cameraName,state)} onUseCurrentView={updatePose} canUseCurrentView={Boolean(currentView&&onUpdateCameraPose)}/>
        <div className="lya-field-row"><span className="lya-field-label">{tr("镜头","Lens")}</span><span className="lya-field-value">{selectedView.intrinsics?`${(selectedView.intrinsics as any).width}×${(selectedView.intrinsics as any).height} · fovy ${Number.isFinite(selectedView.fovDeg)?selectedView.fovDeg!.toFixed(1):"—"}°`:`fovy ${selectedView.fovDeg?.toFixed(1)??"—"}°`}</span></div>
        <p className="lya-help">{tr("这个站点按名字引用已保存机位。应用位姿或用当前视角更新，只会更新该命名机位；站点名称与 A/B/C 顺序不变。","This stop references a saved named camera. Applying a pose or using the current view updates that named camera; the stop name and A/B/C order stay the same.")}</p>
      </div>:<p className="lya-help lya-error" role="alert">{tr("该站点机位不可用：","This stop camera is unavailable: ")}{selectedView.reason??tr("机位已不存在","camera missing")}</p>}
      {poseNotice&&<p className="lya-help" role="status">{poseNotice}</p>}
    </div></details>}
    {routeNotice&&<p className="lya-help" role="status">{routeNotice}</p>}
    {routeError && <ReasonAlert raw={routeError} fallback={tr("路线操作未完成。","The route action did not complete.")} testId="capture-route-error"/>}
    {/* 路线预览/录制失败时把会话错误就地显示，而不是只丢到全局状态栏。 */}
    {!routeError&&session.error&&<p className="lya-help lya-error" role="alert" data-testid="capture-route-session-error">{session.error}</p>}
    {!routeError&&runReason&&(writeBusy||draft.stops.length>=2)&&<p className="lya-help" role="status">{runReason}</p>}
    <details className="lya-advanced" data-testid="capture-route-settings">
      <summary>{tr("路线设置","Route settings")}</summary>
      <p className="lya-help">{tr("按顺序引用已保存视角；每段时长与每站停留具名、可校验。路线只驱动镜头，不执行机器人动作、不推进物理时钟。","References saved views in order; each segment duration and stop hold is named and validated. A route only drives the camera: it runs no robot action and advances no physics clock.")}</p>
      {/* 设计稿 capture-route 首屏只留「+ Add saved view / Route settings / 双动作」；路线总览是查看动作，收进设置折叠。 */}
      <div className="lya-row">
       <button type="button" className="lya-chip" data-testid="capture-route-overview" disabled={!canOverview} title={tr("把全部真实站点相机与场景主体框进总览；只移动查看相机。","Frame every real stop camera and the scene subject in an overview; only the viewing camera moves.")} onClick={()=>onRouteOverview?.(trailStations)}>{tr("路线总览","Route overview")}</button>
      </div>
    </details>
    <FooterActions note={<span data-testid="capture-route-duration">{draft.stops.length} {tr("站","stops")} · {totalSeconds} s</span>} primary={<>
      <button disabled={!canRun} title={runReason||undefined} onClick={() => startRoute("preview")}>{tr("预览路线","Preview route")}</button>
      <button type="button" className="lya-primary" disabled={!canRun} title={runReason||undefined} onClick={() => startRoute("record")}>{tr("录制路线","Record route")}</button>
    </>}/>
   </div>
  </PanelPage>

  return <div className="lya-capture-home" data-testid="continuous-capture">
    <PanelSection label={tr("自由视角","Free view")} side={viewerVisible?tr("实时","Live"):tr("已隐藏","Hidden")}>
      <details className="lya-advanced" data-testid="capture-view-details"><summary>{tr("视图详情","View details")}</summary>
       <div className="lya-field-row"><span className="lya-field-label">{tr("机位 XYZ","Camera XYZ")}</span><span className="lya-field-value" title={current?poseText(current.position,3):undefined}>{current?poseText(current.position,3):tr("Viewer 未显示","Viewer hidden")}</span></div>
       <div className="lya-field-row"><span className="lya-field-label">{tr("镜头","Lens")}</span><span className="lya-field-value">{current?.fovDeg!==undefined?`fovy ${current.fovDeg.toFixed(1)}°`:tr("当前机位","current view")}</span></div>
      </details>
      <div className="lya-row"><button type="button" className="lya-primary" data-testid="capture-start-free" disabled={Boolean(blocked)||session.saving} onClick={session.startFree}>{tr("开始拍摄","Start capture")}</button><button type="button" data-testid="capture-take-image" disabled={Boolean(blocked)||takeImageBusy||!onTakeImage} onClick={()=>onTakeImage?.()}>{takeImageBusy?tr("正在拍照…","Taking image…"):tr("拍照","Take image")}</button></div>
      {!active&&blockedReason&&<p className="lya-help" data-testid="capture-blocked-reason">{blockedReason}</p>}
    </PanelSection>
    <PanelSection label={tr("已保存视角","Saved views")} side={cameras.length}>
      <div className="lya-row" data-testid="capture-save-view">
        <span className="lya-field-label" style={{flex:"0 0 auto"}}>{tr("保存当前视角","Save current view")}</span>
        <input aria-label={tr("相机名","Camera name")} placeholder={tr("机位名称（可选）","View name (optional)")} value={cameraName} onChange={event=>setCameraName(event.target.value)} style={{flex:"1 1 80px",minWidth:0}}/>
        <button type="button" data-testid="capture-save-view-button" disabled={readOnly||replayActive||!viewerVisible||!sceneId||viewSaving||!onSaveView} onClick={saveCurrentView}>{viewSaving?tr("正在保存…","Saving…"):tr("保存视角","Save view")}</button>
      </div>
      {viewNotice&&<p className="lya-help" role="status" data-testid="capture-view-notice">{viewNotice}</p>}
      {viewError&&<ReasonAlert raw={viewError} fallback={tr("当前视角未能保存。","The current view could not be saved.")} testId="capture-view-error"/>}
      {cameras.length?<div className="lya-list" data-testid="capture-saved-views">{cameras.map((camera,index)=><div className="lya-list-row" key={camera.name}>
        <span className="lya-row-icon" aria-hidden="true"><WorkbenchIcon id="camera" size={15}/></span>
        <button type="button" className="lya-row-main" onClick={()=>onSelectView?.(camera.name)}><span className="lya-row-title" title={camera.name}>{camera.name}</span>{index===0&&<span className="lya-row-subtitle">{tr("命名机位","Named camera")}</span>}</button>
        <button type="button" className="lya-icon-button" aria-label={tr(`删除相机 ${camera.name}`,`Delete camera ${camera.name}`)} disabled={blocked||!onDeleteView} onClick={()=>onDeleteView?.(camera.name)}>×</button>
      </div>)}</div>:<p className="lya-help" data-testid="capture-saved-views-empty">{tr("还没有保存的视角。","No saved views yet.")}</p>}
      <details className="lya-advanced" data-testid="capture-views-section"><summary>{tr("保存视角包含什么","What a saved view stores")}</summary>
        <p className="lya-help">{tr("保存的是当前完整机位（含 roll/视场/裁剪面/内参），恢复时回到同一台相机。它不会新建机器人挂载相机。","Saves the complete current view (including roll, field of view, clip planes and intrinsics); restoring returns to the same camera. It does not create a robot-mounted camera.")}</p>
      </details>
    </PanelSection>
    <ListRow icon="capture" title={tr("相机路线","Camera route")} subtitle={routes.length?tr(`${routes.length} 条已存路线`,`${routes.length} saved route${routes.length===1?"":"s"}`):tr("A→B→C 运镜","A→B→C camera move")} side={draft.stops.length?`${draft.stops.length} ${tr("站","stops")}`:undefined} onClick={()=>setRouteOpen(true)} testId="capture-route-entry"/>
    {feedback}
    <details className="lya-advanced" data-testid="capture-videos-section"><summary>{tr("拍摄结果","Captured media")}{(videos.length+captures.length)?` · ${videos.length+captures.length}`:""}</summary>
      <div data-testid="capture-videos">
        {videos.length===0?<p className="lya-help">{tr("还没有视频。","No videos yet")}</p>:videos.map(record=><div key={record.videoId} className="lya-list-row"><span className="lya-row-main"><span className="lya-row-title">{record.source==="route"?tr("路线视频","Route video"):tr("自由视角视频","Free view video")}</span><span className="lya-row-subtitle">{(record.durationMs/1000).toFixed(2)} s · {record.width}×{record.height} · {record.bytes} B</span></span><a href={api.videoURL(record.videoId)} download={`${record.videoId}.${record.container==="unknown"?"bin":record.container}`}>{tr("下载","Download")}</a></div>)}
      </div>
      {captures.length>0&&<div className="lya-captures" data-testid="capture-images">{captures.map(record=><figure key={record.captureId}><img src={api.captureURL(record.captureId)} alt={record.captureId} width={record.attachment.width} height={record.attachment.height}/><figcaption className="lya-help">{record.capturedAt} · rev {record.sceneRevision}{record.worldId?` · ${record.worldId.slice(0,8)}`:""}</figcaption></figure>)}</div>}
    </details>
  </div>
}

/**
 * 画布底部的拍摄小浮条：自由/路线共用，只读 session 的真实时状态；停止/取消仍走既有会话。
 * 路线预览/录制时额外显示一块**真实 POV 小预览**：画面来自 Viewer 同一 scene 的临时 capture camera，
 * 主视口保持可交互总览；预览只读取，不另建相机/状态。
 */
export function CaptureSessionBar({session,tr,previewFrame}:{session:ContinuousCaptureSession;tr:Translate;previewFrame?:(canvas:HTMLCanvasElement)=>boolean}){
  const previewRef=useRef<HTMLCanvasElement>(null)
  const previewFrameRef=useRef(previewFrame)
  previewFrameRef.current=previewFrame
  const routeActive=session.phase==="route-preview"||session.phase==="route-record"
  useEffect(()=>{
    if(!routeActive)return
    const draw=()=>{const canvas=previewRef.current;if(canvas)try{previewFrameRef.current?.(canvas)}catch{/* 临时 POV 已清理 */}}
    draw()
    const timer=setInterval(draw,100)
    return()=>clearInterval(timer)
  },[routeActive])
  if(session.phase==="idle")return null
  const cancelling=session.phase==="cancelling"
  const title=cancelling?tr("正在取消…","Cancelling…"):session.phase==="free"?tr("自由视角","Free view"):session.phase==="route-preview"?tr("路线预览","Route preview"):tr("路线","Route")
  return <div className="lya-capture-session-bar" data-testid="capture-recording-bar" role="status" aria-label={cancelling?tr("正在取消","Cancelling"):tr("拍摄进行中","Capture in progress")}>
    <span className="lya-live-dot" aria-hidden="true"/>
    <span className="lya-capture-session-main"><strong>{title}</strong><span data-testid="capture-elapsed" title={session.currentPose?poseText(session.currentPose.position,4):undefined}>{cancelling?tr("等待编码器关闭…","Waiting for the encoder to close…"):`${session.currentSegment?`${String.fromCharCode(65+session.currentSegment.index)}${session.currentSegment.phase==="move"?" → "+String.fromCharCode(66+session.currentSegment.index):""} · `:""}${seconds(session.elapsedMs)} s${session.totalMs ? ` / ${seconds(session.totalMs)} s` : ""}`}</span></span>
    {routeActive&&previewFrame&&<canvas ref={previewRef} className="lya-capture-pov" aria-label={tr("路线相机预览","Route camera preview")}/>}
    {!cancelling&&session.phase!=="route-preview"&&<button className="lya-stop" disabled={session.saving} onClick={session.stop}>{session.saving?tr("正在保存…","Saving…"):tr("停止","Stop")}</button>}
    {!cancelling&&<button disabled={session.saving} onClick={session.cancel}>{tr("取消","Cancel")}</button>}
  </div>
}

/**
 * 新路线的初值：名字与 sceneId 明确；`sceneRevision` 是**创建时的源快照版本**（保存时会再钉当刻版本），
 * 段时长/停留由用户填写，不补假值。绝不硬编码 0 冒充"某次源快照"。
 */
export function emptyRoute(sceneId?: string, sceneRevision = 0): CaptureRoute {
  return { routeId: crypto.randomUUID(), name: "", sceneId: sceneId ?? "", sceneRevision, stops: [], segmentMs: [], savedAt: new Date().toISOString() }
}
