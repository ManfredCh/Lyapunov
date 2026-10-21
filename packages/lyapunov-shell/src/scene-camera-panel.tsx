import {useCallback,useEffect,useRef,useState,type RefObject} from "react"
import type {Entity,SceneCommit,SceneSnapshot,WorldHandle} from "../../lyapunov-contracts/src/types.ts"
import {type FrustumSpec} from "../../viewer/src/camera-frustum.ts"
import {adoptableReceipt,cameraWorldKey,receiptMatchesWorld,usableCameraSpec,type CameraWorldIdentity} from "./capture-panel.tsx"
import {cameraMountBodies,cameraMountLabel,recommendedCameraMount,sceneCameraDraftOf,sceneCamerasOfScene,type SceneCameraDraft} from "./workbench-camera.ts"
import {cameraDraftFromSample,type CameraAuthoringSnapshot,type CameraExitBridge} from './camera-authoring.ts'
import {cameraDraftOfScene,type CameraSceneSaveInput} from './camera-installation.ts'
import {cameraQuaternionFromNormal,installationVector} from './camera-installation-input.ts'
import {cameraForward,fovYFromIntrinsics} from '../../viewer/src/camera-view.ts'
import {nativeCameraPreset,registeredCameraPresets,type RobotCameraPreset} from '../../robot-tools/src/presets.ts'
import {cameraListFingerprint,queryNativeCameraList} from "./camera-ui-query.ts"
import {LidarScanPanel,cameraCaptureRef,type CameraCaptureRef} from "./lidar-scan-panel.tsx"
import type {SceneWorldState} from "./scene-world-lifecycle.ts"
import {EmptyState,FieldRow,FooterActions,ListRow} from "./panel-chrome.tsx"
import type {Translate} from "./entity-editor.tsx"
import {workbenchAPI} from "./workbench-api.ts"

/** 局部位置摘要：首屏只给 3 位小数；完整原始值仍留在 Edit local pose，不把长浮点摊到首屏。 */
/** 首屏身份只给可读短名：`entity_<uuid>` 这类长 ID 一律折叠成短标签，完整身份留在 Camera details。
 * 设计规则 7 明确要求首屏不出现 UUID/长 ID；这里不改变底层数据，只改展示。 */
export function readableIdentity(value:string|undefined):string{
 const raw=(value??'').trim()
 if(!raw)return ''
 // `entity_<uuid>/bodyName` 形态：保留 bodyName，去掉长 uuid 段。
 const uuid=/^entity_[0-9a-f-]{8,}(?:\/(.+))?$/i.exec(raw)
 if(uuid)return uuid[1]??'本机相机'
 // 任意长 hex/id 片段压到 8 位。
 return raw.replace(/[0-9a-f]{12,}/gi, token=>token.slice(0,8)+'…')
}

function localPoseSummary(raw:string,fallback:string):string{
 const parts=(raw??"").trim().split(/[\s,]+/).filter(Boolean)
 if(!parts.length)return fallback
 const numbers=parts.map(value=>Number(value))
 if(numbers.length!==3||numbers.some(value=>!Number.isFinite(value)))return raw
 return numbers.map(value=>value.toFixed(3)).join(" ")
}

/** 出口只消费Viewer-owned mode；原生读回或清单刷新不决定用户能否返回主视图。 */
export function CameraReturnControl({mode,returnView,tr}:{mode?:'free'|'pilot'|'camera-edit';returnView:()=>void;tr:Translate}){
 if(!mode||mode==='free')return null
 return <div className="lya-row"><button type="button" aria-label={tr('返回主视图','Return to main view')} onClick={returnView}>{tr('返回主视图','Return to main view')}</button></div>
}

export function CameraAimControl({positionLocked,spec,tr,setFov}:{positionLocked?:boolean;spec?:FrustumSpec;tr:Translate;setFov:(value:number)=>void}){
 const [fov,setValue]=useState('50')
 useEffect(()=>{if(spec)setValue(String(fovYFromIntrinsics(spec.intrinsics)))},[spec?.key,positionLocked])
 if(!positionLocked)return null
 return <div data-testid="camera-origin-aim"><p className="lya-help">{tr('安装原点已锁定。右键拖动调整视线；移动按键不会改变位置。运动时仍跟随真实连杆。保存并结束编辑后返回主视图，Esc 放弃草稿并返回。','The installation origin is locked. Right-drag to aim; movement keys keep the position fixed. The camera follows the real body during motion. Save and finish returns to the main view; Esc discards the draft and returns.')}</p><div className="lya-row"><label>{tr('竖直 FOV 度','Vertical FOV deg')}<input type="number" min="0.01" max="179.99" aria-label={tr('原点调姿 FOV','Aim camera FOV')} value={fov} onChange={e=>setValue(e.target.value)}/></label><button onClick={()=>setFov(Number(fov))}>{tr('预览 FOV','Preview FOV')}</button></div></div>
}

/** 现有 camera_list 的当前作用域投影，两个相机面板共享；不会创建或保存第二份相机。 */
export function useNativeCameraList({api,scene,world,active}:{api:ReturnType<typeof workbenchAPI>;scene?:SceneSnapshot;world?:WorldHandle;active:boolean}){
 const identity:CameraWorldIdentity={sceneId:scene?.sceneId,sceneRevision:scene?.revision,worldId:world?.worldId,worldGeneration:world?.worldGeneration}
 const key=cameraWorldKey(identity),current=useRef<{key:string;api:typeof api;sequence:number;controller?:AbortController;pending?:Promise<any>}>({key,api,sequence:0})
 const activeRef=useRef(active);activeRef.current=active
 if(current.current.key!==key||current.current.api!==api){current.current.controller?.abort();current.current={key,api,sequence:current.current.sequence+1}}
 const [readback,setReadback]=useState<{key:string;api:typeof api;receipt:any;fingerprint:string}>(),[failure,setFailure]=useState<{key:string;api:typeof api;message:string}>()
 const ready=Boolean(scene&&world&&world.sceneId===scene.sceneId&&world.appliedSceneRevision===scene.revision&&["ready","running","paused"].includes(world.status))
 const refresh=useCallback(async(force=true)=>{
  // 旧闭包不能借新 scope 的 pending/controller 发旧 Scene/world 请求。
  if(!activeRef.current||current.current.api!==api||current.current.key!==key)return undefined
  if(!ready||!scene||!world)throw new Error("相机需要当前场景已同步的物理世界")
  if(current.current.pending)return await current.current.pending
  const scope=current.current,sequence=++scope.sequence,controller=new AbortController();scope.controller=controller
  const pending=(async()=>{
   try{
    const value=await queryNativeCameraList(api,identity,controller.signal,force)
    if(!activeRef.current||controller.signal.aborted||current.current!==scope||scope.sequence!==sequence||!adoptableReceipt(value,identity,current.current.key))return undefined
    const fingerprint=cameraListFingerprint(value)
    setReadback(old=>old?.key===key&&old.api===api&&old.fingerprint===fingerprint?old:{key,api,receipt:value,fingerprint});setFailure(old=>old?undefined:old)
    return value
   }catch(error){if(controller.signal.aborted)return undefined;if(current.current===scope&&scope.sequence===sequence)setFailure({key,api,message:String(error)});throw error}
   finally{if(scope.controller===controller){scope.pending=undefined;scope.controller=undefined}}
  })()
  scope.pending=pending;return await pending
 },[api,key,ready])
 useEffect(()=>{
  const scope=current.current
  if(!active||!ready){scope.controller?.abort();return}
  let cancelled=false,timer:ReturnType<typeof setTimeout>|undefined
  const read=async()=>{let delay=750;try{await refresh(false)}catch{delay=1500}if(!cancelled)timer=setTimeout(read,delay)}
  void read();return()=>{cancelled=true;if(timer)clearTimeout(timer);scope.controller?.abort();scope.sequence++}
 },[active,ready,refresh])
 return {receipt:readback?.key===key&&readback.api===api?readback.receipt:undefined,error:failure?.key===key&&failure.api===api?failure.message:undefined,refresh,ready,key}
}

export function SceneCameraPanel({api,scene,world,receipt,error,readOnly,tr,perform,commit,sampleCurrent,saveInstallation,pilot,aim,returnView,piloted,selectCamera,selectedCameraEntityId,selectedRobotEntityId,prepareWorld,worldState,sceneSpecs,refresh,exitBridge,scope="all",recordCamera,compareOverlayHost}:{
 api:ReturnType<typeof workbenchAPI>;scene?:SceneSnapshot;world?:WorldHandle;receipt?:any;error?:string;readOnly:boolean;tr:Translate;
 perform:(fn:()=>Promise<unknown>)=>void;commit:(input:SceneCommit)=>Promise<SceneSnapshot>;sampleCurrent:()=>CameraAuthoringSnapshot;saveInstallation:(input:CameraSceneSaveInput)=>Promise<{snapshot:SceneSnapshot;entityId:string}>;
 pilot:(key:string)=>void;aim?:(key:string)=>void;returnView:()=>void;piloted?:string;selectCamera:(key:string|undefined)=>void;selectedCameraEntityId?:string;selectedRobotEntityId?:string;
 prepareWorld:(sceneId:string)=>Promise<WorldHandle|undefined>;worldState?:SceneWorldState;sceneSpecs:readonly FrustumSpec[];refresh:()=>Promise<any>
 exitBridge?:CameraExitBridge
 /** V8-19/20：保存后可直接把该真实机位交给 Recording（仍走既有 Recording owner，不新建相机源）。 */
 recordCamera?:(key:string)=>void
 /** 来源受控投影（R-005）：`mounted`=只处理随 body 的机器人机位；`world`=只处理世界固定机位。同一份 Scene owner，不各存一份。 */
 scope?:"all"|"world"|"mounted"
 /** V8-21：三通道对照浮层的画布内宿主；只影响呈现位置，不改变采集/同帧判据。 */
 compareOverlayHost?:RefObject<HTMLElement>
}){
 const defaultCameraDraft=()=>({...sceneCameraDraftOf(),name:tr('相机','Camera')})
 const cameras=sceneCamerasOfScene(scene?.entities),[editing,setEditing]=useState(""),[draft,setDraft]=useState<SceneCameraDraft>(defaultCameraDraft)
 // V8-19/20：mounted scope 的清单 / New camera 二级页 / 保存后摘要分开；没有新建或选中机位时不铺旧表单。
 const [mountedNew,setMountedNew]=useState(false),[mountedEdit,setMountedEdit]=useState(false)
 const [draftMode,setDraftMode]=useState<'current-view'|'draft'>('current-view'),[draftDirty,setDraftDirty]=useState(false),[presetId,setPresetId]=useState('')
 // 位置/方向是新建与编辑的首屏步骤；它只展开同一条安装草稿的既有字段，不另建相机状态。
 const [poseOpen,setPoseOpen]=useState(false),poseDetails=useRef<HTMLDetailsElement>(null)
 const [preview,setPreview]=useState<any>(),[previewError,setPreviewError]=useState(""),[livePreview,setLivePreview]=useState(true),[previewBusy,setPreviewBusy]=useState(false)
 const [preparing,setPreparing]=useState(false),[prepareError,setPrepareError]=useState(""),[saving,setSaving]=useState(false)
 const [normalInput,setNormalInput]=useState(''),[upInput,setUpInput]=useState(''),[robotPick,setRobotPick]=useState(''),[nativePick,setNativePick]=useState('')
 const normalOfDraft=()=>{try{return cameraForward(draft.quaternion.trim().split(/[\s,]+/).map(Number) as [number,number,number,number]).map(v=>Number(v.toFixed(6))).join(' ')}catch{return ''}}
 const applyNormal=()=>{const normal=installationVector(normalInput.trim().split(/[\s,]+/).map(Number),'normal'),up=upInput.trim()?installationVector(upInput.trim().split(/[\s,]+/).map(Number),'up'):undefined;const base=draftMode==='current-view'?cameraDraftFromSample(scene!,sampleCurrent(),{name:draft.name,world,mount:draft.parentEntityId?{entityId:draft.parentEntityId,bodyName:draft.bodyName}:undefined}):draft;setDraft({...base,quaternion:cameraQuaternionFromNormal(normal,base.quaternion.trim().split(/[\s,]+/).map(Number) as [number,number,number,number],up).join(' ')});setDraftMode('draft');setDraftDirty(true)}
 // 任务链只展开真实存在的字段：位置是 Local pose XYZ，方向是 normal/up；Aim 右键拖动由宿主的真实模式提供。
 const mountLinkText=(bodyName:string)=>bodyName?`${tr(cameraMountLabel(bodyName).zh,cameraMountLabel(bodyName).en)} · ${bodyName}`:tr('未选择连杆','No link selected')
 const focusPoseTarget=(target:'position'|'normal')=>{const focus=()=>{const input=poseDetails.current?.querySelector<HTMLInputElement>(target==='position'?'[data-testid="camera-position-input"]':'[data-testid="camera-normal-input"]');input?.focus()};setTimeout(focus,0)}
 const openPose=(target:'position'|'normal')=>{setPoseOpen(true);focusPoseTarget(target)}
 const editPose=(target:'position'|'normal')=>{setMountedEdit(true);openPose(target)}
 useEffect(()=>{setNormalInput('');setUpInput('')},[editing,scene?.sceneId])
 const pendingSave=useRef<Promise<void>>()
 const prepareInFlight=useRef<Promise<WorldHandle|undefined>>()
 const identity:CameraWorldIdentity={sceneId:scene?.sceneId,sceneRevision:scene?.revision,worldId:world?.worldId,worldGeneration:world?.worldGeneration},key=cameraWorldKey(identity)
 const current=useRef({key,editing,sceneId:scene?.sceneId,api,sampleCurrent,prepareWorld});current.current={key,editing,sceneId:scene?.sceneId,api,sampleCurrent,prepareWorld}
 const selected=cameras.find(row=>row.entity.entityId===editing)
 // 清单是当前 world 的投影；旧 revision/generation 的 body 不能用于新安装标定。
 const scopedReceipt=receiptMatchesWorld(receipt,identity)?receipt:undefined,bodies=cameraMountBodies(scopedReceipt,scene?.entities??[])
 const rows:any[]=scopedReceipt?.cameras??[],native=selected?rows.find(row=>row.entityId===editing||row.cameraName===`${editing}/${selected.component.name??selected.entity.name}`):undefined
 const pickedNative=rows.find(row=>row.cameraName===nativePick)
 const nativeSpec=usableCameraSpec(native),pickedSpec=usableCameraSpec(pickedNative),spec=native?.available===false?undefined:nativeSpec??sceneSpecs.find(row=>row.entityId===editing)??pickedSpec,nativeKey=nativeSpec?.key??pickedSpec?.key
 // P7B：被选中的**原生挂载相机**（body-mounted）也要按真实挂载身份显示保存入口与目标，不能在二级页显示 "Save world camera"。
 // 判据是相机行自报的真实 body（`parentBodyName`）与归属实体，不是草稿里是否恰好有 parentEntityId。
 const nativeMounted=!editing&&nativePick?rows.find((row:any)=>row.cameraName===nativePick):undefined
 const nativeMountTarget=nativeMounted&&typeof nativeMounted.entityId==="string"&&nativeMounted.entityId&&typeof nativeMounted.parentBodyName==="string"&&nativeMounted.parentBodyName?{entityId:nativeMounted.entityId as string,bodyName:nativeMounted.parentBodyName as string}:undefined
 const mountedIdentity=Boolean(draft.parentEntityId||selected?.component.mount||nativeMountTarget||nativeMounted?.parentBodyName)
 const ready=Boolean(!readOnly&&world&&scene&&world.sceneId===scene.sceneId&&world.appliedSceneRevision===scene.revision&&["ready","running","paused"].includes(world.status))
 const mountEntity=scene?.entities.find(row=>row.entityId===draft.parentEntityId),selectedRobot=scene?.entities.find(row=>row.entityId===selectedRobotEntityId)
 const bodyOwners=Array.from(new Set(bodies.map(body=>body.entityId))),bodyChoices=bodies.filter(body=>body.entityId===draft.parentEntityId)
 const availableBody=(name:string)=>{const matches=bodyChoices.filter(body=>body.bodyName===name);return matches.length===1&&Boolean(matches[0]!.worldFromBody)}
 const recommendations=bodyChoices.filter(body=>availableBody(body.bodyName)&&cameraMountLabel(body.bodyName).priority<4).sort((a,b)=>cameraMountLabel(a.bodyName).priority-cameraMountLabel(b.bodyName).priority).slice(0,3)
 const mountedCameras=cameras.filter(row=>draft.parentEntityId?row.component.mount?.entityId===draft.parentEntityId:!row.component.mount)
 // 来源受控投影：世界固定机位（无 mount）与随 body 的挂载机位分开显示，但读写的仍是同一份 `components.camera`。
 const showMounted=scope!=="world",showWorld=scope!=="mounted"
 const scopedCameras=scope==="world"?cameras.filter(row=>!row.component.mount):scope==="mounted"?cameras.filter(row=>Boolean(row.component.mount)):cameras
 // P7A 入口：首屏先选当前机器人实例，再列它真实原生/Scene 声明的挂载相机（可识别名称 + 所属 body）。
 const robotEntities=(scene?.entities??[]).filter(entity=>{const c=entity.components as any;return Boolean(c.articulation||c.controller||c.isaac||c.mujoco)})
 const activeRobotId=robotPick||selectedRobotEntityId||(robotEntities.length===1?robotEntities[0]!.entityId:'')
 const activeRobot=robotEntities.find(entity=>entity.entityId===activeRobotId)
 const robotCameras=cameras.filter(row=>row.component.mount?.entityId===activeRobotId)
 const nativeRobotCameras=rows.filter(row=>row.cameraSource!=='scene-camera'&&row.available!==false&&(row.entityId===activeRobotId||row.parentEntityId===activeRobotId))
 const addCameraToRobot=async(entityId:string)=>{newCamera(false,entityId);setRobotPick(entityId);if(!ready)await prepare(entityId);else await refresh()}
 const presets:RobotCameraPreset[]=scene?[...rows.flatMap(row=>{try{return [nativeCameraPreset(row,scopedReceipt,scene.entities)]}catch{return []}}),...(draft.parentEntityId?registeredCameraPresets(scene,draft.parentEntityId):[])].filter(row=>!draft.parentEntityId||row.mount?.entityId===draft.parentEntityId):[]
 const previews=rows.filter(row=>row.override&&(!draft.parentEntityId||row.entityId===draft.parentEntityId||row.parentEntityId===draft.parentEntityId||row.entityId===editing))
 const worldIssue=worldState&&scene&&worldState.sceneId===scene.sceneId&&["failed","blocked"].includes(worldState.phase)?worldState:undefined
 const preparationDetail=prepareError||(draft.parentEntityId?(worldIssue?.detail||error):undefined),preparationCode=prepareError.match(/^([A-Z][A-Z0-9_]+)/)?.[1]??(draft.parentEntityId?worldIssue?.code:undefined)
 const prepare=async(mountEntityId=draft.parentEntityId)=>{
  if(!scene||readOnly)throw new Error("CAMERA_SCENE_READ_ONLY: 当前场景不可编辑")
  if(!mountEntityId||!scene.entities.some(entity=>entity.entityId===mountEntityId))throw new Error('CAMERA_MOUNT_INTENT_REQUIRED: 先明确选择当前画面要挂载的实体；世界相机无需启动物理')
  if(prepareInFlight.current)return await prepareInFlight.current
  const sceneId=scene.sceneId,requestAPI=api
  setPreparing(true);setPrepareError("")
  const pending=current.current.prepareWorld(sceneId)
  prepareInFlight.current=pending
  try{return await pending}catch(failure){if(current.current.sceneId===sceneId&&current.current.api===requestAPI)setPrepareError(failure instanceof Error?failure.message:String(failure));throw failure}
  finally{if(prepareInFlight.current===pending)prepareInFlight.current=undefined;if(current.current.sceneId===sceneId&&current.current.api===requestAPI)setPreparing(false)}
 }
 const newCamera=(mountRobot=false,robotEntityId?:string)=>{
  let next=defaultCameraDraft()
  if(scene){try{next=cameraDraftFromSample(scene,sampleCurrent())}catch(value){setPrepareError(value instanceof Error?value.message:String(value))}}
  // 新草稿的名称按**当前语言**生成；用户自定义名称只在既有草稿/已保存机位里保留。
  const parentEntityId=scope==='mounted'?(robotEntityId??activeRobot?.entityId??selectedRobotEntityId??''):mountRobot?selectedRobot?.entityId??'':''
  setEditing('');setNativePick('');setDraft({...next,name:tr('相机','Camera'),parentEntityId});setDraftMode('current-view');setDraftDirty(false);setPresetId('');setPrepareError('');setPreview(undefined);setPreviewError('');setLivePreview(false);setPoseOpen(false)
  setMountedNew(scope==='mounted');setMountedEdit(false)
 }
 const beginMount=async()=>{if(!selectedRobot)throw Error('CAMERA_MOUNT_ENTITY_REQUIRED');newCamera(true);if(!ready)await prepare(selectedRobot.entityId);else await refresh()}
 const cancelMounted=()=>{setMountedNew(false);setMountedEdit(false);setEditing('');setNativePick('');selectCamera(undefined);setDraft(defaultCameraDraft());setDraftMode('current-view');setDraftDirty(false);setPreview(undefined);setPreviewError('');setLivePreview(false);setPoseOpen(false)}
 /** 编辑既有相机时取消回到该机位摘要；新建时取消回到机位清单（都不写 Scene）。 */
 const cancelMountedForm=()=>{if(mountedEdit&&selected&&scene){setMountedEdit(false);setDraft(cameraDraftOfScene(scene,selected.entity));setDraftDirty(false);setDraftMode('draft');setPreviewError('');setPoseOpen(false)}else cancelMounted()}
 const choose=(entity:Entity)=>{const cameraComponent=entity.components.camera as {mount?:unknown}|undefined;if(scope==='mounted'&&!cameraComponent?.mount)return;setMountedNew(false);setMountedEdit(false);setNativePick('');setEditing(entity.entityId);setDraft(cameraDraftOfScene(scene!,entity));setDraftMode('draft');setDraftDirty(false);setPresetId('');setPreview(undefined);setPreviewError("");setLivePreview(true);setPoseOpen(false);const component=entity.components.camera as {name?:string}|undefined;selectCamera(`${entity.entityId}/${component?.name??entity.name}`)}
 useEffect(()=>{setEditing("");setNativePick('');setDraft(defaultCameraDraft());setMountedNew(false);setMountedEdit(false);setDraftMode('current-view');setDraftDirty(false);setPresetId('');setPreview(undefined);setPreviewError("");setPrepareError("");setPreparing(false);setLivePreview(false);setPoseOpen(false)},[scene?.sceneId,api])
 // 选中机器人只给明确挂载入口；不改世界相机草稿，也不从selection effect冷启SDK。
 // 只推荐真实名称；保存时再采同一显示帧，不用轮询位姿预填局部安装。
 useEffect(()=>{
  if(editing||!mountEntity||draft.bodyName||draftDirty||!ready)return
  const body=recommendedCameraMount(bodies,mountEntity.entityId);if(!body)return
  try{
   const next=cameraDraftFromSample(scene!,current.current.sampleCurrent(),{name:draft.name,world,mount:{entityId:mountEntity.entityId,bodyName:body.bodyName}})
   setDraft(old=>old.parentEntityId===mountEntity.entityId&&!old.bodyName?next:old);setPrepareError('')
  }catch(failure){setPrepareError(failure instanceof Error?failure.message:String(failure))}
 },[scopedReceipt,editing,draft.parentEntityId,draft.bodyName,draftDirty,ready])
 // Scene 是声明 owner；重开或外部 scene_edit 后显示文档里的安装标定。
 useEffect(()=>{if(editing&&!draftDirty){const entity=scene?.entities.find(row=>row.entityId===editing);if(entity)setDraft(cameraDraftOfScene(scene!,entity));else{setEditing("");setDraft(defaultCameraDraft());setDraftMode('current-view')}}},[scene?.revision,editing,draftDirty])
 useEffect(()=>{if(draftDirty)return;if(selectedCameraEntityId&&selectedCameraEntityId!==editing){const row=cameras.find(row=>row.entity.entityId===selectedCameraEntityId&&(scope!=='mounted'||Boolean(row.component.mount)));if(row)choose(row.entity)}},[selectedCameraEntityId,draftDirty,scope])
 const field=(name:keyof SceneCameraDraft,value:string)=>{
  let next=draft
  if(name!=='name'&&draftMode==='current-view'){
   try{if(!scene)throw Error('CAMERA_SCENE_REQUIRED');next=cameraDraftFromSample(scene,sampleCurrent(),{name:draft.name,world,mount:draft.parentEntityId?{entityId:draft.parentEntityId,bodyName:draft.bodyName}:undefined})}
   catch(failure){setPrepareError(failure instanceof Error?failure.message:String(failure))}
  }
  // 用户手动输入始终进入草稿并切到 draft（即使采样失败也不吞掉输入）；轮询/推荐效应不得再覆写。
  if(name!=='name')setDraftMode('draft');setDraftDirty(true);setDraft({...next,[name]:value})
 }
 const chooseBody=(bodyName:string)=>{
  if(!mountEntity)throw new Error("CAMERA_MOUNT_ENTITY_REQUIRED: 请先选中当前机器人")
  if(!availableBody(bodyName))throw new Error('CAMERA_MOUNT_BODY_REQUIRED: 选择当前真实唯一连杆')
  const next=cameraDraftFromSample(scene!,sampleCurrent(),{name:draft.name,world,mount:{entityId:mountEntity.entityId,bodyName}})
  // 显式选择 body 后，draft（含换算到该连杆的局部位姿）就是用户草稿 owner：切到 draft 模式，
  // 后续 field 编辑与“保存连杆安装”不再重新采样当前画面而覆盖用户值（R-005）。
  setDraft(next);setDraftMode('draft');setDraftDirty(true);setPrepareError('')
 }
 const fromView=()=>{
  if(!scene)throw new Error('CAMERA_SCENE_REQUIRED')
  const sampled=sampleCurrent(),next=cameraDraftFromSample(scene,sampled,{name:draft.name,world,mount:draft.parentEntityId?{entityId:draft.parentEntityId,bodyName:draft.bodyName}:undefined})
  setDraft(next);setDraftMode('draft');setDraftDirty(true)
 }
 const save=(requested?:CameraSceneSaveInput['mode']):Promise<void>=>{
  if(pendingSave.current)return pendingSave.current
  const pending=(async()=>{
  if(!scene||readOnly)throw new Error("当前场景不可编辑")
  // mounted scope 只能保存到当前机器人的真实 native body；缺 parent/body 时绝不允许落到世界相机分支。
  if(scope==='mounted'&&requested!=='native-preset'){
   if(!draft.parentEntityId||!mountEntity)throw new Error('CAMERA_MOUNT_ENTITY_REQUIRED: 机器人机位必须先绑定当前机器人实例')
   if(!ready||preparing||prepareError||!availableBody(draft.bodyName))throw new Error('CAMERA_MOUNT_BODY_REQUIRED: 需解析到当前机器人唯一的真实安装连杆')
  }
  const entityId=editing||crypto.randomUUID(),sceneId=scene.sceneId,requestAPI=api
  // 主按钮（未显式指定 mode）在挂载相机已被用户草稿拥有时提交**用户草稿**；只有显式
  // “保存当前画面安装”按钮才重新采样当前画面。这样 UI 保存前值、RPC 输入与 Scene 声明一致。
  const mode=requested??(draft.parentEntityId&&(draftDirty||draftMode==='draft')?'draft':draftMode)
  setSaving(true)
  try{
   const saved=await saveInstallation({sceneId,expectedRevision:scene.revision,entityId,mode,name:draft.name,...mode==='draft'?{draft}:mode==='current-view'?(draft.parentEntityId?{mount:{entityId:draft.parentEntityId,bodyName:draft.bodyName}}:nativeMountTarget?{mount:nativeMountTarget}:{}):mode==='native-preset'?{presetId}:{},...(world&&world.sceneId===sceneId?{worldId:world.worldId,expectedGeneration:world.worldGeneration}:{})})
   if(current.current.sceneId!==sceneId||current.current.api!==requestAPI)return
   setEditing(saved.entityId);setDraft(cameraDraftOfScene(saved.snapshot,saved.snapshot.entities.find(row=>row.entityId===saved.entityId)));setDraftMode('draft');setDraftDirty(false);exitDraft.current.dirty=false;setPreview(undefined);setLivePreview(true);setMountedNew(false);setMountedEdit(false);setPoseOpen(false)
   // 保存只写Scene。物理同步经现有World owner，静态世界相机当场可用。
  }finally{if(current.current.sceneId===sceneId&&current.current.api===requestAPI)setSaving(false)}
  })()
  pendingSave.current=pending
  void pending.finally(()=>{if(pendingSave.current===pending)pendingSave.current=undefined}).catch(()=>undefined)
  return pending
 }
 const exitDraft=useRef({dirty:draftDirty,save});exitDraft.current={dirty:draftDirty,save}
 useEffect(()=>exitBridge?.registerExitParticipant?.('camera-form:'+api.clientId,{summary:()=>({dirtyDrafts:exitDraft.current.dirty?1:0,runningActions:0}),flush:async()=>{if(pendingSave.current)await pendingSave.current;if(exitDraft.current.dirty)await exitDraft.current.save()}}),[exitBridge,api.clientId])
 const remove=async()=>{if(!scene||readOnly||!editing)throw new Error("当前没有可删除的场景相机");await commit({sceneId:scene.sceneId,expectedRevision:scene.revision,patch:[{op:"remove",entityId:editing,cascade:true}]});if(current.current.sceneId===scene.sceneId&&current.current.api===api){if(scope==='mounted')cancelMounted();else newCamera()}}
 // 采集归属只取语义身份与镜头尺寸；同 scope 的 Scene/world/清单对象轮询不更换 owner。
 // Live 只拥有下一次调度，不能在 cleanup 中取消手动 Refresh/Scan 共用的这次采集。
 const previewWidth=selected?.component.width??spec?.intrinsics.width??640,previewHeight=selected?.component.height??spec?.intrinsics.height??480
 const previewReady=Boolean(ready&&nativeKey&&spec)
 const previewKey=JSON.stringify([key,editing,nativePick,nativeKey,previewReady,previewWidth,previewHeight])
 type PreviewScope={key:string;api:typeof api;controller?:AbortController;pending?:Promise<CameraCaptureRef|undefined>}
 const previewScope=useRef<PreviewScope>({key:previewKey,api})
 if(previewScope.current.key!==previewKey||previewScope.current.api!==api){previewScope.current.controller?.abort();previewScope.current={key:previewKey,api}}
 const requestScope=previewScope.current
 useEffect(()=>{
  setPreview(undefined);setPreviewError('');setPreviewBusy(false)
  return()=>{requestScope.controller?.abort();requestScope.controller=undefined;requestScope.pending=undefined}
 },[requestScope])
 const capturePreview=useCallback(async():Promise<CameraCaptureRef|undefined>=>{
  if(previewScope.current!==requestScope)return undefined
  if(!ready||!scene||!world||!nativeKey||!spec)throw new Error('CAMERA_PREVIEW_REQUIRES_READY_CAMERA: Select a camera with native pose and intrinsics')
  if(requestScope.pending)return await requestScope.pending
  const controller=new AbortController();requestScope.controller=controller
  const ownsRequest=()=>previewScope.current===requestScope&&requestScope.controller===controller&&!controller.signal.aborted
  setPreviewBusy(true)
  // 延后一拍执行，先登记 Promise；同步失败与立即完成也只能清理这一个请求。
  const pending=Promise.resolve().then(async()=>{
   try{
    if(!ownsRequest())return undefined
    const value=await api.request<any>('camera-preview',{method:'POST',signal:controller.signal,body:JSON.stringify({sceneId:scene.sceneId,sceneRevision:scene.revision,worldId:world.worldId,expectedGeneration:world.worldGeneration,cameraNames:[nativeKey],width:previewWidth,height:previewHeight})})
    if(!ownsRequest()||!adoptableReceipt(value,identity,current.current.key))return undefined
    const image=value.cameras?.find((row:any)=>row.cameraName===nativeKey||row.resolvedCameraName===nativeKey)
    if(!image||!value.captureId)throw new Error('CAMERA_PREVIEW_IMAGE_MISSING: Native capture did not return the selected camera image')
    setPreview({...value,scope:requestScope,camera:image});setPreviewError('')
    return cameraCaptureRef(value,image)
   }catch(failure){if(!ownsRequest())return undefined;setPreviewError(String(failure));throw failure}
   finally{if(ownsRequest()){requestScope.controller=undefined;requestScope.pending=undefined;setPreviewBusy(false)}}
  })
  requestScope.pending=pending
  return await pending
 },[requestScope])
 useEffect(()=>{
  if(!previewReady||!livePreview)return
  let cancelled=false,timer:ReturnType<typeof setTimeout>|undefined
  const capture=async()=>{try{await capturePreview();if(!cancelled)timer=setTimeout(capture,1000)}catch{if(!cancelled)setLivePreview(false)}}
  void capture();return()=>{cancelled=true;if(timer)clearTimeout(timer)}
 },[previewReady,livePreview,capturePreview])
 const visiblePreview=preview?.scope===requestScope&&receiptMatchesWorld(preview,identity)?preview:undefined
 // 比较区只消费真实回执：RGB/Depth 同 capture，身份字段随直播刷新，但扫描时由比较面板钉住。
 const comparisonCapture=visiblePreview?cameraCaptureRef(visiblePreview,visiblePreview.camera):undefined
 const mountReady=Boolean(ready&&!preparing&&!prepareError&&draft.parentEntityId&&availableBody(draft.bodyName))
 const robotPicker=showMounted&&robotEntities.length>0?<div data-testid="camera-robot-picker">
  <div className="lya-row" style={{flexWrap:"wrap"}}>{robotEntities.map(entity=><button key={entity.entityId} aria-pressed={activeRobotId===entity.entityId} disabled={readOnly||saving} onClick={()=>{setRobotPick(entity.entityId);setNativePick("");cancelMounted()}}>{entity.name??entity.entityId}</button>)}</div>
  {activeRobot&&<div className="lya-row"><span className="lya-help">{tr('当前机器人','Current robot')}：{activeRobot.name??activeRobot.entityId} · {tr('真实挂载相机','real mounted cameras')} {robotCameras.length}</span></div>}
 </div>:null
 const cameraList=showMounted?<div className="lya-list" data-testid="camera-mounted-list">
  {robotCameras.length===0&&nativeRobotCameras.length===0&&<p className="lya-help" data-testid="camera-mounted-empty">{tr('这个机器人还没有已安装机位。添加后会跟随真实连杆。','This robot has no installed cameras yet. Add one to follow a real native link.')}</p>}
  {robotCameras.map(row=><ListRow key={row.entity.entityId} icon="camera" title={row.component.name??row.entity.name} subtitle={`${tr('挂载','Mount')} ${row.component.mount?.bodyName??'—'}`} selected={editing===row.entity.entityId} onClick={()=>choose(row.entity)} testId={`camera-mounted-scene-${row.entity.entityId}`} side={tr('已保存','Saved')}/>)}
  {nativeRobotCameras.map((row:any)=><ListRow key={row.cameraName} icon="camera" title={row.localName??row.cameraName} subtitle={`${tr('原生','Native')} · ${readableIdentity(row.parentBodyName??row.bodyName)||'—'}`} selected={nativePick===row.cameraName} disabled={!usableCameraSpec(row)||readOnly} onClick={()=>{setEditing("");setMountedNew(false);setMountedEdit(false);setNativePick(row.cameraName);selectCamera(row.cameraName)}} testId={`camera-mounted-native-${row.cameraName}`} side={usableCameraSpec(row)?undefined:tr('不可用','Unavailable')}/>)}
 </div>:null
 // V8-19：已选机器人且未创建草稿时，只给机位清单/短空态与 Add camera；不铺旧世界相机表单和摘要。
 if(scope==="mounted"&&!mountedNew&&!selected&&!nativePick)return <fieldset className="lya-property-editor" data-testid="robot-camera-panel" data-camera-scope="mounted" aria-label={tr("机器人相机","Robot camera")}><legend style={{position:'absolute',width:1,height:1,overflow:'hidden',clip:'rect(0 0 0 0)'}}>{tr("机器人相机","Robot camera")}</legend>
  {robotEntities.length===0&&<EmptyState icon="robot" title={tr("先选择机器人","Choose a robot first")} detail={tr("场景里还没有机器人；先在 Robots 加入实例，再安装机位。","No robot in this scene. Add one in Robots, then install a camera.")}/>}
  {robotPicker}
  {activeRobot&&cameraList}
  {activeRobot&&<div className="lya-row"><button type="button" className="lya-primary" data-testid="camera-add-to-robot" disabled={readOnly||saving||preparing} onClick={()=>perform(()=>addCameraToRobot(activeRobot.entityId))}>{tr('给这个机器人添加相机','Add camera to this robot')}</button></div>}
  {!activeRobot&&robotEntities.length>1&&<p className="lya-help">{tr('先选择当前机器人实例，再选择或添加它的挂载相机。','Choose the current robot instance, then pick or add its mounted camera.')}</p>}
  {preparationDetail&&<details data-testid="camera-list-preparation"><summary role="alert">{tr("相机准备受阻","Camera preparation blocked")}{preparationCode?` · ${preparationCode}`:""}</summary><p className="lya-help" style={{overflowWrap:"anywhere"}}>{preparationDetail}</p></details>}
 </fieldset>
 const mountedForm=scope==="mounted"&&(mountedNew||mountedEdit)
 // 已保存/原生机位的同栏详情：Back 回清单，详情内不再铺 robot picker/计数/Add 与清单。
 const mountedDetail=scope==="mounted"&&!mountedForm&&Boolean(selected||(nativeKey&&nativePick))
 const detailTitle=mountedNew?tr('新建相机','New camera'):mountedEdit?tr('编辑相机','Edit camera'):selected?(selected.component.name??selected.entity.name):nativeMounted?(nativeMounted.localName??nativePick):tr('相机','Camera')
 const showSummary=scope!=="mounted"||Boolean(selected&&!mountedNew&&!mountedEdit)||Boolean(nativeKey&&nativePick&&!selected)
 return <fieldset className="lya-property-editor" data-testid="robot-camera-panel" data-camera-scope={scope} data-camera-task={mountedForm||mountedDetail?true:undefined} aria-label={scope==="world"?tr("世界固定相机","World cameras"):tr("机器人相机","Robot camera")}><legend style={{position:'absolute',width:1,height:1,overflow:'hidden',clip:'rect(0 0 0 0)'}}>{scope==="world"?tr("世界固定相机","World cameras"):tr("机器人相机","Robot camera")}</legend>
  {showMounted&&robotEntities.length===0&&<EmptyState icon="robot" title={tr("先选择机器人","Choose a robot first")} detail={tr("场景里还没有机器人；先在 Robots 加入实例，再安装机位。","No robot in this scene. Add one in Robots, then install a camera.")}/>}
  {(mountedForm||mountedDetail)&&<div className="lya-row lya-camera-subhead" data-testid={mountedForm?"camera-new-header":"camera-detail-header"} style={{flexWrap:'nowrap'}}><button type="button" className="lya-back" data-testid="camera-back-to-list" disabled={saving} onClick={mountedForm?cancelMountedForm:cancelMounted}>{tr('‹ 机器人机位','‹ Robot cameras')}</button><strong className="lya-camera-subhead-title" title={detailTitle}>{detailTitle}</strong></div>}
  {!mountedForm&&!mountedDetail&&robotPicker}
  {!mountedForm&&!mountedDetail&&activeRobot&&cameraList}
  {showMounted&&!mountedForm&&!mountedDetail&&activeRobot&&<div className="lya-row"><button type="button" disabled={readOnly||saving||preparing} onClick={()=>perform(()=>addCameraToRobot(activeRobot.entityId))}>{tr('添加相机到该机器人','Add camera to this robot')}</button></div>}
  {showMounted&&!activeRobot&&robotEntities.length>1&&!mountedForm&&!mountedDetail&&<p className="lya-help">{tr('先选择当前机器人实例，再选择或添加它的挂载相机。','Choose the current robot instance, then pick or add its mounted camera.')}</p>}
  {showMounted&&!selected&&nativeKey&&nativePick&&!mountedNew&&<>
   <p className="lya-help" role="status">{tr('已选择原生相机','Selected native camera')}：{readableIdentity(nativeMounted?.localName??nativePick)} · {tr('原生相机已就绪，可进入视角或扫描LiDAR。','Native camera ready; enter its view or scan LiDAR.')}</p>
   <div className="lya-row"><button onClick={()=>pickedSpec&&pilot(pickedSpec.key)} disabled={!pickedSpec||readOnly}>{tr("进入相机视角","Enter camera")}</button><button disabled={!piloted} onClick={returnView}>{tr("返回主视图","Return to main view")}</button></div>
   <div className="lya-row"><button type="button" onClick={cancelMounted}>{tr('更多机位','More cameras')}</button></div>
  </>}
  {/* 19～21 的主摘要与主要下一步：在折叠外，默认就能读到并操作。 */}
  {showSummary&&<div className="lya-camera-summary" data-testid="camera-summary">
   {/* V8-20：标题只显示一次真实机位名；摘要只留 Robot / Mount / Local pose / Lens。 */}
   {!mountedDetail&&<FieldRow label={tr("名称","Name")} value={draft.name||tr("未命名","Untitled")}/>}
   <FieldRow label={tr("机器人","Robot")} value={mountEntity?.name??selectedRobot?.name??activeRobot?.name??tr("世界固定","World-fixed")}/>
   <FieldRow label={tr("挂载","Mount")} value={readableIdentity(draft.bodyName||nativeMountTarget?.bodyName)||tr("世界","World")}/>
   <FieldRow label={tr("局部位置","Local pose")} value={localPoseSummary(draft.position,tr("当前画面","Current view"))}/>
   <FieldRow label={tr("镜头","Lens")} value={`${draft.width} × ${draft.height}`}/>
   {/* 正常可用时 preview 本身即入口；只有不可用/等待同步的真实状态才占一行。 */}
   {selected&&(native?.available===false||!nativeSpec)&&<p className="lya-help" role="status">{native?.available===false?`${tr("此相机暂不可用","Camera unavailable")}：${native.reason??tr("引擎未提供原因","No reason reported")}`:!ready?tr("绑定已保存，正在等待物理世界同步。","Mount saved; awaiting physical world synchronization."):tr("绑定已保存，正在读取原生相机。","Mount saved; reading the native camera.")}</p>}
   <div className="lya-row" data-testid={scope==="mounted"&&selected?"camera-detail-actions":undefined}>
    {scope!=="mounted"&&selected&&spec&&<button className="lya-primary" disabled={!spec||readOnly||Boolean(selected.component.mount&&!ready)} onClick={()=>spec&&pilot(spec.key)}>{selected.component.mount?tr("进入并跟随相机视角","Enter and follow camera"):tr("进入相机视角","Enter camera")}</button>}
    {scope!=="mounted"&&selected&&spec&&aim&&<button disabled={!spec||readOnly||Boolean(selected.component.mount&&!ready)} onClick={()=>spec&&aim?.(spec.key)}>{tr('在安装原点调朝向','Aim from installation origin')}</button>}
    {scope!=="mounted"&&selected&&<button disabled={!piloted} onClick={returnView}>{tr("返回主视图","Return to main view")}</button>}
    {scope!=="mounted"&&selected&&<button disabled={!nativeSpec||!ready||previewBusy} onClick={()=>perform(capturePreview)}>{tr("刷新画面","Refresh image")}</button>}
   </div>
   {scope==="mounted"&&selected&&<>
    <details className="lya-advanced" data-testid="camera-detail-pose-explainer"><summary>{tr('位置、方向与操作','Position, direction and actions')}</summary>
     <div className="lya-row" style={{flexWrap:'wrap'}}>
      <button type="button" data-testid="camera-edit-entry" disabled={readOnly} onClick={()=>setMountedEdit(true)}>{tr('编辑','Edit')}</button>
      <button type="button" data-testid="camera-preview-entry" disabled={!spec||readOnly||Boolean(selected.component.mount&&!ready)} onClick={()=>spec&&pilot(spec.key)}>{tr('预览','Preview')}</button>
      {aim&&<button type="button" data-testid="camera-aim-entry" disabled={!spec||readOnly||Boolean(selected.component.mount&&!ready)} onClick={()=>spec&&aim?.(spec.key)}>{tr('调朝向','Aim direction')}</button>}
     </div>
     <p className="lya-help" data-testid="camera-detail-pose-note">{tr('机位跟随 ','Follows ')}{mountLinkText(selected.component.mount?.bodyName??draft.bodyName)}{tr(' 运动，不是世界固定。','; it is not world-fixed.')}</p>
     <div className="lya-row" data-testid="camera-detail-pose"><span className="lya-field-label">{tr('位置与方向','Position & direction')}</span><button type="button" data-testid="camera-edit-pose" disabled={readOnly} onClick={()=>editPose('position')}>{tr('编辑局部位姿','Edit local pose')}</button></div>
     <p className="lya-help">{tr('位置在 Local pose 的 XYZ 字段调整（画布没有拖动手柄），方向可输入 normal/up，或进入 Aim 模式右键拖动。','Edit position XYZ in Local pose (there is no canvas drag handle), and set direction with normal/up or Aim mode right-drag.')}</p>
    </details>
   </>}
   {scope==="mounted"&&selected&&<details className="lya-advanced" data-testid="camera-preview-controls"><summary>{tr('预览控制','Preview controls')}</summary><div className="lya-row"><button disabled={!piloted} onClick={returnView}>{tr("返回主视图","Return to main view")}</button><button disabled={!nativeSpec||!ready||previewBusy} onClick={()=>perform(capturePreview)}>{tr("刷新画面","Refresh image")}</button></div><label><input type="checkbox" aria-label={tr("选中相机实时预览","Selected camera live preview")} checked={livePreview} disabled={!nativeSpec||!ready} onChange={event=>setLivePreview(event.target.checked)}/>{tr("实时预览","Live preview")}</label></details>}
   {scope!=="mounted"&&selected&&<label><input type="checkbox" aria-label={tr("选中相机实时预览","Selected camera live preview")} checked={livePreview} disabled={!nativeSpec||!ready} onChange={event=>setLivePreview(event.target.checked)}/>{tr("实时预览","Live preview")}</label>}
  </div>}
  {/* V8-19：新机位安装的必要可编辑项在首屏；局部姿态与镜头进入具名折叠。 */}
  {(scope!=="mounted"||mountedForm)&&<>
  {mountedForm?<>
   {/* 与设计稿 camera-install 的字段顺序对齐：Name → Robot → Mount location；Local pose/Lens 为带短值的折叠行。 */}
   <label className="lya-field-label">{tr("相机名称","Camera name")}<input aria-label={tr("场景相机名称","Scene camera name")} value={draft.name} disabled={readOnly} onChange={event=>field("name",event.target.value)}/></label>
   <div className="lya-field-row" data-testid="camera-mounted-robot"><span className="lya-field-label">{tr('机器人','Robot')}</span><span className="lya-field-value">{activeRobot?.name??mountEntity?.name??selectedRobot?.name??tr('未选择机器人','No robot selected')}</span></div>
   {showMounted&&draft.parentEntityId&&<label className="lya-field-label">{tr("挂载位置","Mount location")}<select aria-label={tr("挂载位置","Mount location")} value={draft.bodyName} disabled={readOnly||!ready||saving} onChange={event=>{if(event.target.value)perform(async()=>chooseBody(event.target.value))}}><option value="">{preparing?tr("正在读取连杆…","Reading links…"):tr("选择真实连杆","Choose a native link")}</option>{draft.bodyName&&!bodyChoices.some(row=>row.bodyName===draft.bodyName)&&<option value={draft.bodyName}>{draft.bodyName} · {tr("等待读回","awaiting readback")}</option>}{bodyChoices.map((body,index)=>{const label=cameraMountLabel(body.bodyName);return <option key={`${body.bodyName}:${index}`} value={body.bodyName} disabled={!availableBody(body.bodyName)}>{tr(label.zh,label.en)} · {body.bodyName}{availableBody(body.bodyName)?"":tr("（不可用）"," (unavailable)")}</option>})}</select></label>}
   {showMounted&&draft.parentEntityId&&recommendations.length>0&&<div className="lya-row" style={{flexWrap:"wrap"}} data-testid="camera-mount-suggestions">{recommendations.map(body=>{const label=cameraMountLabel(body.bodyName);return <button key={body.bodyName} type="button" disabled={readOnly||saving} title={body.bodyName} aria-pressed={draft.bodyName===body.bodyName} onClick={()=>perform(async()=>chooseBody(body.bodyName))}>{tr(label.zh,label.en)}{label.priority===0?tr("（推荐）"," (suggested)"):""}</button>})}</div>}
   {/* 设计稿 camera-install 首屏只有字段：跟随说明与三个动作全部收进“位置与方向怎么填”折叠。 */}
   <section className="lya-camera-summary" data-testid="camera-position-direction" aria-label={tr('位置与方向','Position and direction')}>
    <details className="lya-advanced" data-testid="camera-pose-how"><summary>{tr('位置与方向怎么填','How to set position and direction')}</summary>
     <p className="lya-help" data-testid="camera-mount-follow-note">{draft.bodyName?<>{tr('这个机位固定在 ','This camera is fixed to ')}{mountLinkText(draft.bodyName)}{tr('，机器人运动时跟随该连杆，不是世界固定。',' and follows that link when the robot moves. It is not world-fixed.')}</>:tr('挂载机位固定在所选真实连杆上，机器人运动时跟随该连杆，不是世界固定。','Mounted cameras are fixed to the chosen real link and follow it when the robot moves; they are not world-fixed.')}</p>
     <div className="lya-row" style={{flexWrap:'wrap'}}>
      <button type="button" data-testid="camera-use-current-view" disabled={readOnly||saving||!mountReady} title={tr('把当前画面姿态复制进这份草稿','Copy the current viewer pose into this draft')} onClick={()=>perform(async()=>fromView())}>{tr('使用当前画面','Use current view')}</button>
      <button type="button" data-testid="camera-move-position" disabled={readOnly||saving} title={tr('展开 Local pose 的 XYZ 字段','Open the Local pose XYZ fields')} onClick={()=>openPose('position')}>{tr('移动位置','Move position')}</button>
      <button type="button" data-testid="camera-rotate-direction" disabled={readOnly||saving} title={tr('展开 normal/up 字段','Open the normal/up fields')} onClick={()=>openPose('normal')}>{tr('旋转方向','Rotate direction')}</button>
     </div>
     <p className="lya-help" data-testid="camera-position-help">{tr('位置：在下方 Local pose 的 XYZ 字段输入；画布没有拖动手柄。','Position: enter XYZ in the Local pose fields below; there is no drag handle on the canvas.')}</p>
     <p className="lya-help" data-testid="camera-direction-help">{tr('方向：在 Local pose 输入 normal/up；保存后可进入 Aim 模式右键拖动。','Direction: enter normal/up in Local pose; after saving, open Aim mode and right-drag.')}</p>
    </details>
   </section>
  </>:<>
   <label className="lya-field-label">{tr("相机名称","Camera name")}<input aria-label={tr("场景相机名称","Scene camera name")} value={draft.name} disabled={readOnly} onChange={event=>field("name",event.target.value)}/></label>
   {scope!=="mounted"&&<label className="lya-field-label">{tr("机器人","Robot")}<select aria-label={tr("挂载实体","Mount entity")} value={draft.parentEntityId} disabled={readOnly} onChange={event=>{setDraft(old=>({...old,parentEntityId:event.target.value,bodyName:""}));setDraftMode('current-view');setDraftDirty(true)}}><option value="">{tr("世界固定相机","World camera")}</option>{draft.parentEntityId&&!bodyOwners.includes(draft.parentEntityId)&&<option value={draft.parentEntityId}>{mountEntity?.name??draft.parentEntityId} · {tr("等待原生读回","awaiting native readback")}</option>}{bodyOwners.map(entityId=><option key={entityId} value={entityId}>{scene?.entities.find(row=>row.entityId===entityId)?.name??entityId}</option>)}</select></label>}
   {showMounted&&draft.parentEntityId&&<label className="lya-field-label">{tr("挂载位置","Mount location")}<select aria-label={tr("挂载位置","Mount location")} value={draft.bodyName} disabled={readOnly||!ready||saving} onChange={event=>{if(event.target.value)perform(async()=>chooseBody(event.target.value))}}><option value="">{preparing?tr("正在读取连杆…","Reading links…"):tr("选择真实连杆","Choose a native link")}</option>{draft.bodyName&&!bodyChoices.some(row=>row.bodyName===draft.bodyName)&&<option value={draft.bodyName}>{draft.bodyName} · {tr("等待读回","awaiting readback")}</option>}{bodyChoices.map((body,index)=>{const label=cameraMountLabel(body.bodyName);return <option key={`${body.bodyName}:${index}`} value={body.bodyName} disabled={!availableBody(body.bodyName)}>{tr(label.zh,label.en)} · {body.bodyName}{availableBody(body.bodyName)?"":tr("（不可用）"," (unavailable)")}</option>})}</select></label>}
   {showMounted&&draft.parentEntityId&&recommendations.length>0&&<div className="lya-row" style={{flexWrap:"wrap"}}>{recommendations.map(body=>{const label=cameraMountLabel(body.bodyName);return <button key={body.bodyName} disabled={readOnly||saving} title={body.bodyName} aria-pressed={draft.bodyName===body.bodyName} onClick={()=>perform(async()=>chooseBody(body.bodyName))}>{tr(label.zh,label.en)}{label.priority===0?tr("（推荐）"," (suggested)"):""}</button>})}</div>}
   {mountReady&&<p className="lya-help">{tr('相机跟随真实连杆。当前画面安装使用同一显示帧的连杆和镜头。','The camera follows the native link. Current-view installation uses the body and camera from one displayed frame.')}</p>}
   <div className="lya-panel-foot"><div className="lya-foot-actions">{draft.parentEntityId&&<button disabled={readOnly||!scene||preparing||saving} onClick={()=>perform(ready?refresh:()=>prepare())}>{preparing?tr("正在读取连杆…","Reading links…"):ready?tr("刷新连杆","Refresh links"):preparationDetail?tr("重试读取真实连杆","Retry native links"):tr("读取真实连杆（需物理）","Read native links (needs physics)")}</button>}<button disabled={readOnly||!scene||saving||Boolean(draft.parentEntityId&&!mountReady)} onClick={()=>perform(()=>save('current-view'))}>{tr('保存当前画面安装','Save current-view installation')}</button><span className="lya-spacer"/><button className="lya-primary" data-testid="camera-save" aria-label={tr("保存相机","Save camera")} title={draft.parentEntityId?tr("保存连杆安装","Save body installation"):nativeMountTarget?tr("保存挂载相机","Save mounted camera"):tr("保存固定相机","Save world camera")} disabled={readOnly||!scene||saving||Boolean(draft.parentEntityId&&!mountReady)||Boolean(scope==='mounted'&&(!draft.parentEntityId||!availableBody(draft.bodyName)))} onClick={()=>perform(save)}>{saving?tr("正在保存…","Saving…"):tr("保存相机","Save camera")}</button></div></div>
  </>}
  {scope==="mounted"&&draft.parentEntityId&&!mountReady&&<p className="lya-help" data-testid="camera-save-blocked">{ready?tr('选择一个当前机器人真实连杆后才能保存。','Choose a real link of this robot before saving.'):tr('物理世界同步后读取真实连杆，才能保存机器人机位。','Sync physics to read the real links before saving this robot camera.')}</p>}
  {mountedForm&&<details className="lya-advanced" data-testid="camera-installation-more"><summary title={tr('刷新连杆、保存当前画面安装与完整安装说明','Refresh links, save the current-view installation and full installation notes')}>{tr('更多 / 安装详情','More / Installation details')}</summary>
   <p className="lya-help" data-testid="camera-authoring-mode">{draftMode==='current-view'?tr('保存时自动采当前完整画面。绑定时保留当前机位，换算到所选连杆；保存后仍留在主视图。','Save samples the complete current view. Mounting preserves that view in the selected body frame; it does not enter camera view.'):tr('当前为已保存安装或人工草稿；保存局部外参与镜头。','This is a saved installation or manual draft; save its local pose and lens.')}</p>
   {draft.parentEntityId&&<div className="lya-row"><button disabled={readOnly||!scene||preparing||saving} onClick={()=>perform(ready?refresh:()=>prepare())}>{preparing?tr("正在读取连杆…","Reading links…"):ready?tr("刷新连杆","Refresh links"):preparationDetail?tr("重试读取真实连杆","Retry native links"):tr("读取真实连杆（需物理）","Read native links (needs physics)")}</button><button disabled={readOnly||!scene||saving||Boolean(draft.parentEntityId&&!mountReady)} onClick={()=>perform(()=>save('current-view'))}>{tr('保存当前画面安装','Save current-view installation')}</button></div>}
   {preparationDetail&&<p className="lya-help" role="alert">{tr("相机准备受阻","Camera preparation blocked")}{preparationCode?` · ${preparationCode}`:""} · {preparationDetail}</p>}
  </details>}
  {nativeMounted&&!nativeMountTarget&&<p className="lya-help lya-error" role="alert">{tr("该原生相机没有可解析的挂载 body，不能按世界相机保存；请刷新连杆读回后再试。","This native camera has no resolvable mount body; it cannot be saved as a world camera. Refresh the native links and retry.")}</p>}
  {/* 设计稿 camera-install 的 Local pose 折叠行带短值（0, 0, 0.2 m），这里同样把当前 XYZ 摘要放在 summary 上。 */}
  <details className="lya-advanced" data-testid="camera-local-pose" ref={poseDetails} open={poseOpen} onToggle={event=>setPoseOpen(event.currentTarget.open)}><summary>{tr("局部姿态","Local pose")} · {draft.parentEntityId?tr("连杆局部","body-local"):tr("世界","world")}{(()=>{const parts=(draft.position??'').trim().split(/[\s,]+/).filter(Boolean).map(Number);return parts.length===3&&parts.every(Number.isFinite)?<span className="lya-field-value" data-testid="camera-local-pose-summary"> {parts.map(value=>value.toFixed(3)).join(' ')} m</span>:null})()}</summary>
   <p className="lya-help">{draft.parentEntityId?tr("位姿为连杆局部系，单位米、四元数 xyzw。","Pose in the link's local frame, meters and xyzw."):tr("位姿为右手 Z-up 世界系，单位米、四元数 xyzw。","Pose in the right-handed Z-up world frame, meters and xyzw.")} {tr("相机 +X 右 / +Y 上 / -Z 前。","Camera axes: +X right / +Y up / -Z forward.")}</p>
   <label className="lya-field-label">{tr("相机位置 XYZ 米","Camera position XYZ m")}<input data-testid="camera-position-input" aria-label={tr("相机位置 XYZ 米","Camera position XYZ m")} value={draft.position} disabled={readOnly} onChange={event=>field("position",event.target.value)}/></label>
   <label className="lya-field-label">{tr("相机旋转 xyzw","Camera rotation xyzw")}<input data-testid="camera-quaternion-input" aria-label={tr("相机旋转 xyzw","Camera rotation xyzw")} value={draft.quaternion} disabled={readOnly} onChange={event=>field("quaternion",event.target.value)}/></label>
   <p className="lya-help">{tr('当前视线法向：','Current viewing normal: ')}{normalOfDraft()||'—'}</p>
   <label className="lya-field-label">{tr('视线法向 XYZ','Viewing normal XYZ')}<input data-testid="camera-normal-input" aria-label={tr('视线法向 XYZ','Viewing normal XYZ')} value={normalInput} placeholder={normalOfDraft()} disabled={readOnly} onChange={e=>setNormalInput(e.target.value)}/></label>
   <label className="lya-field-label">{tr('向上方向 XYZ（可选）','Up direction XYZ (optional)')}<input aria-label={tr('向上方向 XYZ（可选）','Up direction XYZ (optional)')} value={upInput} disabled={readOnly} onChange={e=>setUpInput(e.target.value)}/></label>
   <div className="lya-row"><button disabled={readOnly||!normalInput.trim()} onClick={()=>perform(async()=>applyNormal())}>{tr('按法向调朝向','Aim along normal')}</button><button disabled={readOnly||Boolean(draft.parentEntityId&&!mountReady)} onClick={()=>perform(async()=>fromView())}>{tr("用当前机位标定","Calibrate from current view")}</button></div>
  </details>
  <details className="lya-advanced" data-testid="camera-lens"><summary>{tr("镜头","Lens")} · {draft.width} × {draft.height}</summary>
   <div className="lya-row">{([['fovYDeg','竖直 FOV 度','Vertical FOV deg'],['width','相机宽度像素','Camera width px'],['height','相机高度像素','Camera height px'],['near','near 裁剪声明米','Declared near clip m'],['far','far 裁剪声明米','Declared far clip m']] as const).map(([name,zh,en])=><label key={name}>{tr(zh,en)}<input type="number" aria-label={tr(zh,en)} value={draft[name]} disabled={readOnly} onChange={event=>field(name,event.target.value)} style={{width:78}}/></label>)}</div>
   {native?.clipPlanesPerCameraSupported===false&&<p className="lya-help">{tr("当前引擎使用全局裁剪；实际范围","This engine uses global clipping; actual range")}：{native.nearM??"—"} / {native.farM??"—"} m。</p>}
   {draft.intrinsics&&<p className="lya-help" data-testid="camera-lens-k">K：fx {draft.intrinsics.fx.toFixed(3)} · fy {draft.intrinsics.fy.toFixed(3)} · cx {draft.intrinsics.cx.toFixed(3)} · cy {draft.intrinsics.cy.toFixed(3)} · {draft.intrinsics.width} × {draft.intrinsics.height}</p>}
  </details>
  </>}
  {(scope!=="mounted"||!mountedNew)&&<>
  {previewBusy&&<p className="lya-help" role="status">{tr("正在采集相机画面…","Capturing camera image…")}</p>}
  {previewError&&<details><summary role="alert">{tr("相机画面采集失败","Camera capture failed")}</summary><p className="lya-help" style={{overflowWrap:"anywhere"}}>{previewError}</p></details>}
  {visiblePreview&&<>{/* 设计稿 camera-compare：预览块带 PREVIEW 标签与 RGB/Depth/LiDAR 三通道标签。 */}<div className="lya-section" data-testid="camera-preview-heading"><span>{tr("预览","Preview")}</span></div><img style={{width:"100%",height:"auto"}} alt={tr("选中相机真实图像","Selected camera native image")} src={api.mediaURL("capture",{captureId:visiblePreview.captureId,camera:visiblePreview.camera.cameraName,sensor:"rgb"})}/><div className="lya-row" data-testid="camera-preview-channels" style={{flexWrap:"wrap",gap:8}}><span className="lya-help">RGB</span><span className="lya-help">{tr("深度","Depth")}</span><span className="lya-help">LiDAR</span></div><details><summary>{tr("图像与同帧标定","Image and same-frame calibration")}</summary><p className="lya-help">rev {visiblePreview.sceneRevision} · g{visiblePreview.worldGeneration??visiblePreview.generation} · step {visiblePreview.stepIndex} · frame {visiblePreview.frameId??"—"}<br/>{tr("相机世界位置","Camera world position")}：{visiblePreview.camera.calibration?.worldFromCamera?.positionM?.map((value:number)=>value.toFixed(4)).join(" / ")??"—"}</p></details></>}
  {/* V8-21：对照入口在三通道短浮层之前；长表单/标定另在下方 Camera details（默认折叠）。 */}
  <LidarScanPanel api={api} scene={scene} world={world} identity={identity} ready={ready} cameraName={nativeKey} cameraLabel={selected?.component.name??selected?.entity.name} cameraCapture={comparisonCapture} captureScopeKey={previewKey} captureCamera={previewReady?capturePreview:undefined} tr={tr} perform={perform} compareOverlayHost={compareOverlayHost}/>
  <details className="lya-advanced" data-testid="camera-installation-controls"><summary>{tr("相机详情","Camera details")}</summary>
   {!mountedForm&&<p className="lya-help" data-testid="camera-authoring-mode">{draftMode==='current-view'?tr('保存时自动采当前完整画面。绑定时保留当前机位，换算到所选连杆；保存后仍留在主视图。','Save samples the complete current view. Mounting preserves that view in the selected body frame; it does not enter camera view.'):tr('当前为已保存安装或人工草稿；保存局部外参与镜头。','This is a saved installation or manual draft; save its local pose and lens.')}</p>}
   {showWorld&&<div className="lya-row"><strong>{mountEntity?.name??(draft.parentEntityId?tr("挂载实体已不存在","Mount entity missing"):tr("世界固定相机","World camera"))}</strong><button disabled={readOnly||!scene||saving} onClick={()=>newCamera()}>{tr('从当前视角新建世界相机','New world camera from current view')}</button></div>}
   {showMounted&&mountedCameras.length>0&&<div className="lya-row" style={{flexWrap:"wrap"}}>{mountedCameras.map(row=><button key={row.entity.entityId} aria-pressed={editing===row.entity.entityId} onClick={()=>choose(row.entity)}>{row.component.name??row.entity.name}</button>)}</div>}
   {showMounted&&robotCameras.length>0&&<ul className="lya-help" style={{margin:0,paddingLeft:16}}>{robotCameras.map(row=><li key={row.entity.entityId}><button aria-pressed={editing===row.entity.entityId} onClick={()=>choose(row.entity)}>{row.component.name??row.entity.name}</button> · {tr('所属 body','body')}：{row.component.mount?.bodyName??'—'}</li>)}</ul>}
   {showMounted&&nativeRobotCameras.length>0&&<><p className="lya-help">{tr('此机器人自带/原生的命名相机：','Native named cameras on this robot:')}</p><ul className="lya-help" style={{margin:0,paddingLeft:16}}>{nativeRobotCameras.map((row:any)=><li key={row.cameraName}>{row.cameraName} · {tr('所属 body','body')}：{row.parentBodyName??row.bodyName??'—'} · {usableCameraSpec(row)?tr('可用','available'):tr('不可用','unavailable')} <button aria-pressed={nativePick===row.cameraName} disabled={!usableCameraSpec(row)||readOnly} onClick={()=>{setEditing("");setNativePick(row.cameraName);selectCamera(row.cameraName)}}>{tr('选择','Select')}</button></li>)}</ul></>}
   {showMounted&&selectedRobot&&<div className="lya-row"><span>{selectedRobot.name}</span><button disabled={readOnly||saving||preparing} onClick={()=>perform(beginMount)}>{tr('把当前画面挂到所选机器人','Mount current view on selected robot')}</button></div>}
   <div className="lya-row"><button disabled={readOnly||!selected?.component.installation||saving||Boolean(selected?.component.mount&&!mountReady)} onClick={()=>perform(()=>save('restore'))}>{tr('恢复安装基线','Restore installation baseline')}</button>{showWorld&&<button disabled={readOnly} onClick={()=>newCamera()}>{tr("新建世界固定相机","New world camera")}</button>}<button disabled={readOnly||!editing||saving} onClick={()=>perform(remove)}>{tr("删除场景相机","Delete scene camera")}</button></div>
   {showMounted&&presets.length>0?<div className="lya-row"><select aria-label={tr('真实相机预设','Verified camera preset')} value={presetId} onChange={event=>setPresetId(event.target.value)}><option value="">{tr('选择已存在的安装','Choose an existing installation')}</option>{presets.map(preset=><option key={preset.id} value={preset.id}>{preset.name} · {preset.source==='scene-baseline'?tr('Scene用户基线','Scene user baseline'):preset.source.toUpperCase()}</option>)}</select><button disabled={readOnly||!ready||!presetId||saving} onClick={()=>perform(()=>save('native-preset'))}>{tr('采用此安装','Use this installation')}</button></div>:draft.parentEntityId&&<p className="lya-help">{tr('当前本体没有可用原生相机预设。请选择真实连杆，用当前画面标定，或在高级设置明确编辑局部外参。','This robot has no available native camera preset. Choose a real body and calibrate from the current view, or edit a local installation explicitly.')}</p>}
   {previews.length>0&&<><p className="lya-help">{tr('下列相机正在临时试拍，原件安装预设待清除试拍后重新读取。','These cameras have temporary preview overrides. Clear them to reread their original installations.')}</p><div className="lya-row" style={{flexWrap:'wrap'}}>{previews.map(row=><button key={row.cameraName} disabled={readOnly||!ready||saving} onClick={()=>perform(async()=>{if(!scene||!world)throw Error('CAMERA_WORLD_REQUIRED');const requested=key;await api.command('camera_adjust_ui',{sceneId:scene.sceneId,worldId:world.worldId,expectedGeneration:world.worldGeneration,cameraName:row.cameraName,clear:true});if(current.current.key===requested&&current.current.api===api)await refresh()})}>{tr('清除试拍：','Clear preview: ')}{row.localName??row.cameraName}</button>)}</div></>}
   {preparationDetail&&<><p className="lya-help" role="alert">{tr("相机准备受阻","Camera preparation blocked")}{preparationCode?` · ${preparationCode}`:""}</p><details><summary>{tr("查看原因","Show reason")}</summary><p className="lya-help" style={{overflowWrap:"anywhere"}}>{preparationDetail}</p></details></>}
   {selected?.component.installation&&<p className="lya-help">{tr('安装基线来源：','Installation baseline source: ')}{selected.component.installation.source} {selected.component.installation.sourceCameraName??''}</p>}
   {scopedCameras.length>0&&<div className="lya-row" style={{flexWrap:"wrap"}}>{scopedCameras.map(row=><button key={row.entity.entityId} aria-pressed={editing===row.entity.entityId} onClick={()=>choose(row.entity)}>{row.component.name??row.entity.name}</button>)}</div>}
   {spec&&<p className="lya-help">{nativeKey} · rev {scene?.revision} · g{world?.worldGeneration} · step {spec.measured?.stepIndex??scopedReceipt?.stepIndex??"—"}</p>}
  </details>
  </>}
  {mountedForm&&<FooterActions primary={<button className="lya-primary" data-testid="camera-save" aria-label={tr("保存相机","Save camera")} title={draft.parentEntityId?tr("保存连杆安装","Save body installation"):nativeMountTarget?tr("保存挂载相机","Save mounted camera"):tr("保存固定相机","Save world camera")} disabled={readOnly||!scene||saving||Boolean(draft.parentEntityId&&!mountReady)||Boolean(scope==='mounted'&&(!draft.parentEntityId||!availableBody(draft.bodyName)))} onClick={()=>perform(save)}>{saving?tr("正在保存…","Saving…"):tr("保存相机","Save camera")}</button>}><button type="button" disabled={saving} onClick={cancelMountedForm}>{tr('取消','Cancel')}</button></FooterActions>}
  {mountedDetail&&<FooterActions note={selected&&!spec&&!readOnly?tr('这个挂载机位还没有被引擎读回，暂不能录制；先在 Camera 里确认机位可用，再让物理世界重新同步。','This mounted camera has not been read back by the engine yet, so it cannot record; confirm it in Camera, then re-sync the physics world.'):selected?.component.mount&&!ready?tr('等待物理世界同步后录制真实机位。','Waiting for physics synchronization before recording the real camera.'):tr('Record this camera starts sensor recording; Preview only enters its view.','Record this camera starts sensor recording; Preview only enters its view.')} primary={<button type="button" className="lya-primary" data-testid="camera-record-this" title={selected&&!spec?tr('机位尚未被引擎读回，录制入口先禁用','Camera is not read back by the engine yet; recording stays disabled'):undefined} disabled={readOnly||!recordCamera||(selected?Boolean(!spec||(selected.component.mount&&!ready)):Boolean(!pickedSpec))} onClick={()=>{const key=selected?spec?.key:pickedSpec?.key;if(key)recordCamera?.(key)}}>{tr('录制该机位','Record this camera')}</button>}><button type="button" onClick={cancelMounted}>{tr('返回机位','Back to cameras')}</button></FooterActions>}
 </fieldset>
}
