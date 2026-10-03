import {useEffect,useRef,useState} from "react"
import {workbenchAPI,type CaptureRecord} from "./workbench-api.ts"
import type {WorldHandle} from "../../lyapunov-contracts/src/types.ts"
import type {Translate} from "./entity-editor.tsx"
import { frustumFromReceipt, type FrustumSpec } from "../../viewer/src/camera-frustum.ts"
import { fovYFromIntrinsics } from "../../viewer/src/camera-view.ts"
// 面板自渲染的回执详情走同一份人类公共面（不整份 JSON 上屏）；判据与命令卡片共用。
import { publicCommandFace } from "../../lyapunov-contracts/src/command-privacy.ts"
/**
 * 一台相机能不能用＝**合同完整**（`frustumFromReceipt`：可用位姿＋K）**且引擎没把它标成不可用**。
 * UI 不另立第二套可用性口径，也不因为条目恰好带着完整位姿/K 就把引擎明确拒掉的相机画进 3D——
 * 引擎的拒绝优先于数据齐全。不可用条目如实显示原因：引擎拒的（`available:false`）用回执 `reason`，
 * 位姿/K 缺失的用合同给的拒绝原因。
 *
 * 放在模块作用域（而不是组件体内）是为了**能被跑着测**：本仓没有浏览器 DOM 夹具，面板整体渲染不在这里跑
 * （真机 computer-use 验收见回执的未验证项），但"哪一条能勾、原因怎么显示"是判据本身，不该只靠读代码。
 */
export function cameraStatus(row:any){const rig=frustumFromReceipt(row),rejected=row?.available===false;return {rig,ok:!rejected&&rig.ok,reason:rejected?(row.reason||"引擎明确报告该相机不可用"):rig.ok?undefined:(typeof row?.reason==="string"&&row.reason?row.reason:(rig as unknown as {unavailable:string}).unavailable)}}
/**
 * 一条清单条目**唯一的**可用判据（勾选与画锥都必须走这一条，不各写一份）：
 * 引擎没拒（`available!==false`；缺字段＝引擎没表态，如 MuJoCo 形状）**且**合同完整（`cameraStatus`）。
 * 返回要画的视锥 spec；不可用回 `undefined`。
 */
export function usableCameraSpec(row:any):FrustumSpec|undefined{if(row?.available===false)return undefined;const rig=cameraStatus(row).rig;return rig.ok?rig.spec:undefined}
/** 可勾选采集＝`usableCameraSpec` 说了算：不可用条目不能被勾选，也不进多视角采集。 */
export function selectableCameras(rows:any[]){return rows.filter(row=>usableCameraSpec(row)!==undefined)}
/**
 * 面板所指的 world 身份四元组：场景、场景修订、世界 id、世界代次。换任一项就是**另一个 world**——
 * 相机清单/勾选/回执/视锥全都是那个 world 的事实，不能跨身份复用（本合同里 `generation` 就是世界代次）。
 */
export type CameraWorldIdentity={sceneId?:string;sceneRevision?:number;worldId?:string;worldGeneration?:number}
/** 身份键：四字段拼成一条可比较的串（`\0` 分隔，任一段为空也不会与另一段混淆）。 */
export function cameraWorldKey(identity:CameraWorldIdentity):string{return [identity.sceneId??"",identity.sceneRevision??"",identity.worldId??"",identity.worldGeneration??""].join("\u0000")}
/**
 * 回执**自报**的来源身份：`camera_list_ui` 报 `generation`、adjust/multi/dataset 报 `worldGeneration`——
 * 同一件事的两个键名，两处都认，不猜成两套语义。四字段缺一即"无身份"（不是"匹配任何 world"）。
 */
export function receiptWorldKey(receipt:any):string|undefined{
 const row=receipt&&typeof receipt==="object"&&!Array.isArray(receipt)?receipt as Record<string,unknown>:undefined
 if(!row)return undefined
 const generation=row.worldGeneration??row.generation
 if(typeof row.sceneId!=="string"||typeof row.worldId!=="string"||typeof row.sceneRevision!=="number"||typeof generation!=="number")return undefined
 return cameraWorldKey({sceneId:row.sceneId,sceneRevision:row.sceneRevision,worldId:row.worldId,worldGeneration:generation})
}
/** 回执是不是这个身份的：四字段全等才算；没有当前 world 时任何回执都不是"当前"。 */
export function receiptMatchesWorld(receipt:any,identity:CameraWorldIdentity):boolean{return Boolean(identity.worldId)&&identity.sceneId!==undefined&&identity.sceneRevision!==undefined&&identity.worldGeneration!==undefined&&receiptWorldKey(receipt)===cameraWorldKey(identity)}
/** 请求发出时的身份是否仍是当前身份（回执不带身份的命令用这一条：迟到的旧请求一律作废）。 */
export function stillCurrentWorld(request:CameraWorldIdentity,currentKey:string):boolean{return cameraWorldKey(request)===currentKey}
/** 回执能不能写回面板：①自报身份＝请求时的身份（别的 world 的回执不要）②请求时的身份仍＝当前身份（迟到作废）。 */
export function adoptableReceipt(receipt:any,request:CameraWorldIdentity,currentKey:string):boolean{return receiptMatchesWorld(receipt,request)&&stillCurrentWorld(request,currentKey)}
/**
 * 一次清单回执 → 勾选：**首次加载**（`selectionInitialized=false`：这个身份下还没读过清单）默认勾上全部可用相机；
 * 之后一律**保留用户的选择**、只滤掉已不可用的——用户显式取消全部勾选后重读仍是空选，不被重新全选。
 * 判据与画锥同一条（`usableCameraSpec`）。
 */
export function nextCameraSelection(previous:string[],rows:any[],selectionInitialized=false):string[]{const selectable=selectableCameras(rows);return selectionInitialized?previous.filter(name=>selectable.some((item:any)=>item.cameraName===name)):selectable.map((item:any)=>item.cameraName)}
/** 清单条目 → 要画的视锥：**与勾选同一条判据**（`usableCameraSpec`）——引擎标了不可用、或缺位姿/K 的条目
 *  一条都不进 3D，哪怕它恰好带着完整 K 与位姿；空清单＝撤掉全部锥。 */
export function cameraRigSpecs(rows:any[]|undefined):FrustumSpec[]{return (rows??[]).flatMap((row:unknown)=>{const spec=usableCameraSpec(row);return spec?[spec]:[]})}
/**
 * 面板的 world 作用域快照：**整块**只对 `key` 那个身份有效（清单、勾选、多视角采集、标注、导出、调整回执同属一份事实）。
 * 身份不符时整块作废（`visibleCameraScope` 给空快照），不逐项挑——否则就会把旧 world 的读数当成新 world 的当前事实。
 */
export type CameraScope={key:string;rows?:any[];/** 这个身份下**读过**清单没有：只有首次加载才默认全选（之后用户显式空选也算"用户的选择"）。 */selectionInitialized:boolean;selected:string[];multiResult?:any;annotations:Record<string,any>;datasetResult?:any;adjustResult?:any}
export function emptyCameraScope(key=""):CameraScope{return {key,rows:undefined,selectionInitialized:false,selected:[],multiResult:undefined,annotations:{},datasetResult:undefined,adjustResult:undefined}}
const EMPTY_CAMERA_SCOPE=emptyCameraScope()
/** 当前身份下能用的快照：身份不符＝空快照（渲染即判据，不靠"等一下 effect 来清"）。 */
export function visibleCameraScope(scope:CameraScope,key:string):CameraScope{return scope.key===key?scope:EMPTY_CAMERA_SCOPE}
/** 在某个身份下改快照：身份换了就从空快照起算（不会把旧 world 的字段带过来）。`update` 可以是要合并的字段，也可以是"按当前快照算字段"的函数。 */
export function scopedPatch(scope:CameraScope,key:string,update:Partial<Omit<CameraScope,"key">>|((base:CameraScope)=>Partial<Omit<CameraScope,"key">>)):CameraScope{const base=visibleCameraScope(scope,key);return {...base,...(typeof update==="function"?update(base):update),key}}
/**
 * 清单读取的**单调请求序号**（同 world 内的先来后到）：`begin()` 发号并记成"最后发出的"，`accept(seq)`
 * 只在该号仍是最后发出的那次读取时为真。用户连着点两次读取、或调整成功后的重读（同走 `begin()`，自然成为
 * 最新一次）都在这一条上排队——先发后到的旧回执一律不写回，不覆盖调整后的较新清单。
 * world 身份核对（`adoptableReceipt`）另有一条，两者都过才写回：顺序管"同 world 内的新旧"，身份管"跨 world"。
 */
export type CameraListSequencer={begin:()=>number;accept:(seq:number)=>boolean}
export function cameraListSequencer():CameraListSequencer{let latest=0;return {begin:()=>++latest,accept:(seq:number)=>seq===latest}}
/**
 * 调整**已生效**、但随后重读清单失败时的快照：保留那条已生效的调整回执，只清空清单（视锥随空清单撤下，
 * 不把调整前的旧读数继续当"当前"摆着），勾选保留（下次读取按用户的选择过滤）。
 * 只在这次读取所指的 world **仍是当前 world** 时清（`key===currentKey`）：否则这次失败属于另一个身份，
 * 与本文件"身份不符就不写回"同一条——不在迟到的失败分支里把新 world 刚读到的清单抹掉。
 */
export function scopeAfterFailedListRefresh(scope:CameraScope,key:string,currentKey:string):CameraScope{return key===currentKey?scopedPatch(scope,key,{rows:undefined}):scope}
/**
 * 调整读数卡上的代次：回执两个键名都认（`worldGeneration` 优先，其次是 `camera_list_ui` 那套 `generation`），
 * 都没有就如实显示 `—`——绝不把 `undefined` 摆给用户看。
 */
export function receiptGenerationText(receipt:any):string{const value=receipt?.worldGeneration??receipt?.generation;return typeof value==="number"&&Number.isFinite(value)?String(value):"—"}
/**
 * 调整已生效、清单刷新失败时的用户可见文案（走既有的 `perform` 错误通路显示）。**不许**写成"调整失败"——
 * 调整确实已经生效，失败的只是随后的清单重读；也不许默不作声（旧视锥已撤下，用户需要知道要重读）。
 */
export function adjustAppliedRefreshFailedMessage(tr:Translate):string{return tr("相机调整已生效，但清单刷新失败：请点“读取命名相机位姿与视场”重读（调整回执保留，调整前的旧视锥已撤下）。","Camera adjustment applied, but refreshing the camera list failed: click “List named camera poses and FOV” to reload (the adjustment receipt is kept; pre-adjust frustums were removed).")}
export function CapturePanel({api,captures,capture,sceneId,sceneRevision,world,readOnly=false,tr,select,perform,onCameraRigs,cameraReceipt,refreshCameraList}:{api:ReturnType<typeof workbenchAPI>;captures:CaptureRecord[];capture?:CaptureRecord;sceneId?:string;sceneRevision?:number;world?:WorldHandle;readOnly?:boolean;select:(value:CaptureRecord)=>void;tr:Translate;perform:(fn:()=>Promise<unknown>)=>void;onCameraRigs?:(specs:FrustumSpec[])=>void;cameraReceipt?:any;refreshCameraList?:()=>Promise<any>}){
 const english=tr("中","en")==="en"
 const [prompt,setPrompt]=useState(""),[result,setResult]=useState<any>(),[overlay,setOverlay]=useState(true),[cameraName,setCameraName]=useState(""),[sensorWidth,setSensorWidth]=useState(320),[sensorHeight,setSensorHeight]=useState(240),[sensorResult,setSensorResult]=useState<any>(),[sensorBusy,setSensorBusy]=useState(false)
 // 多视角相机面板状态：相机清单只来自 camera_list_ui 回执（真实位姿/视场），不在这里保存任何相机物理量。
 // 清单/勾选/多视角回执/标注/导出/调整回执是**同一个 world 的事实**，因此整块带身份保存（`CameraScope`）：
 // 身份（场景＋修订＋world＋代次）一变，渲染当场就按身份键折成空快照——不留旧 world 的一帧，也不等 effect 来清。
 const [cameraScope,setCameraScope]=useState<CameraScope>(()=>emptyCameraScope()),[multiBusy,setMultiBusy]=useState(false)
 const [adjustName,setAdjustName]=useState(""),[adjustFrame,setAdjustFrame]=useState<"world"|"parent">("parent"),[adjustXYZ,setAdjustXYZ]=useState(""),[adjustQuat,setAdjustQuat]=useState(""),[adjustFovy,setAdjustFovy]=useState("")
 const worldIdentity:CameraWorldIdentity={sceneId,sceneRevision,worldId:world?.worldId,worldGeneration:world?.worldGeneration}
 const worldKey=cameraWorldKey(worldIdentity)
 const scope=visibleCameraScope(cameraScope,worldKey)
 const cameras=scope.rows,selectedCameras=scope.selected,multiResult=scope.multiResult,annotations=scope.annotations,datasetResult=scope.datasetResult,adjustResult=scope.adjustResult
 /** 在途回执的核对基准：回执回来时必须仍等于当前身份（换 world/场景/代次后旧请求一律作废）。 */
 const worldKeyRef=useRef(worldKey)
 /** 清单读取的顺序号（同 world 内先来后到）：先发后到的旧 `camera_list_ui` 回执不写回，见 `cameraListSequencer`。 */
 const listOrders=useRef(cameraListSequencer())
 // 身份一变：整块快照作废（清单、勾选、多视角、标注、导出、调整回执一次清干净），并把新身份推进 ref。
 useEffect(()=>{worldKeyRef.current=worldKey;setCameraScope(old=>old.key===worldKey?old:emptyCameraScope(worldKey))},[worldKey])
 // 产品创建/挂载面板与采集面板共享同一次原生清单读取，勾选仍归当前作用域投影。
 useEffect(()=>{if(!refreshCameraList)return;const rows=receiptMatchesWorld(cameraReceipt,worldIdentity)?cameraReceipt.cameras??[]:undefined;setCameraScope(old=>scopedPatch(old,worldKey,base=>({rows,...rows?{selected:nextCameraSelection(base.selected,rows,base.selectionInitialized),selectionInitialized:true}:{}})))},[cameraReceipt,worldKey])
 // 3D 视锥只从**当前身份下有效的清单**推（`setCameraRigs` 是全量替换：空清单＝撤掉旧锥并清读数卡）。
 // 挂在派生物上而不是写进各条异步分支：迟到的回执无论怎么写回，都推不出旧 world 的锥。
 useEffect(()=>{onCameraRigs?.(cameraRigSpecs(cameras))},[cameras])
 useEffect(()=>{setResult(undefined)},[capture?.captureId])
 // 面板里的**像素坐标空间一律是原帧**（`originalImage` 只在附件库缩过图时才有）：显示的是预览附件，
 // 但 SAM3 mask 框与尺寸标签都按原帧给——下游拿到的是 `capture.imagePath` 那个原帧文件，坐标必须同口径。
 const frameWidth=capture?.originalImage?.width??capture?.attachment.width??0,frameHeight=capture?.originalImage?.height??capture?.attachment.height??0
 // 官方套件世界没有自由 RGB-D 采集：观测只随 bench_step 返回的官方 observation 提供。
 // 之前这里只看 replay/同步状态，官方 world 上会给出一个永远不可能成功的采集按钮。
 // Gymnasium 同样没有自由采集：episode 观测来自官方 env.render 帧（adapter.ts 的 capture 明示 UNSUPPORTED），
 // 按钮在 Gym world 上同样可达，所以这里一并按能力边界禁用并解释，不新增能力注册表或 Viewer 适配。
 const officialWorld=world?.engineId==="official-suite"
 const gymWorld=world?.engineId==="gymnasium"
 const freeCaptureUnsupported=officialWorld||gymWorld
 const sensorReady=Boolean(!readOnly&&!freeCaptureUnsupported&&world&&sceneId&&world.sceneId===sceneId&&world.appliedSceneRevision===sceneRevision&&["ready","running","paused"].includes(world.status))
 const visibleSensorResult=receiptMatchesWorld(sensorResult,worldIdentity)?sensorResult:undefined
 const captureSensor=async()=>{
  if(!sensorReady||!world)throw new Error("SENSOR_CAPTURE_REQUIRES_LIVE_SYNCED_WORLD")
  setSensorBusy(true)
  try{
   const value=await api.command<any>("sensor_capture_ui",{sceneId,sceneRevision,worldId:world.worldId,expectedGeneration:world.worldGeneration,...cameraName.trim()?{cameraName:cameraName.trim()}: {},width:sensorWidth,height:sensorHeight})
   setSensorResult(value);return value
  }finally{setSensorBusy(false)}
 }
 const numbers=(text:string):number[]|undefined=>{const parts=text.trim().split(/[\s,]+/).filter(Boolean).map(Number);return parts.length&&parts.every(Number.isFinite)?parts:undefined}

 /** 勾选一台相机：写进**当前身份**的快照（复选框只可能出现在当前身份的清单里）。 */
 const toggleCamera=(name:string,checked:boolean)=>setCameraScope(old=>scopedPatch(old,worldKey,base=>({selected:checked?[...base.selected,name]:base.selected.filter(item=>item!==name)})))
 const loadCameras=async()=>{if(!sensorReady||!world)throw new Error("CAMERA_LIST_REQUIRES_LIVE_SYNCED_WORLD");const request=worldIdentity;const seq=listOrders.current.begin();const value=refreshCameraList?await refreshCameraList():await api.command<any>("camera_list_ui",{sceneId,worldId:world.worldId,expectedGeneration:world.worldGeneration});if(!listOrders.current.accept(seq))return undefined;if(!adoptableReceipt(value,request,worldKeyRef.current))return undefined;const rows:any[]=value.cameras??[];setCameraScope(old=>scopedPatch(old,cameraWorldKey(request),base=>({rows,selected:nextCameraSelection(base.selected,rows,base.selectionInitialized),selectionInitialized:true})));return value}
 /** 调整成功后**必须**用同一身份重读一次清单（只读一次）：面板读数与 3D 视锥都换成引擎的新回执。
  * 重读失败（`loadCameras` 抛）不撤销上面那条**已生效**的调整回执，但也不把调整前的旧读数继续当"当前"摆着——
  * 清单置空（视锥随之撤下），并把"调整已生效、清单刷新失败"经既有 `perform` 错误通路告诉用户（不写成"调整失败"）。 */
 const refreshCamerasAfterAdjust=async(key:string)=>{try{await loadCameras()}catch{setCameraScope(old=>scopeAfterFailedListRefresh(old,key,worldKeyRef.current));throw new Error(adjustAppliedRefreshFailedMessage(tr))}}
 const captureMulti=async()=>{if(!sensorReady||!world)throw new Error("CAMERA_CAPTURE_REQUIRES_LIVE_SYNCED_WORLD");setMultiBusy(true);try{const request=worldIdentity;const value=await api.command<any>("camera_capture_multi_ui",{sceneId,sceneRevision,worldId:world.worldId,expectedGeneration:world.worldGeneration,cameraNames:selectedCameras,width:sensorWidth,height:sensorHeight});if(!adoptableReceipt(value,request,worldKeyRef.current))return value;setCameraScope(old=>scopedPatch(old,cameraWorldKey(request),{multiResult:value,annotations:{}}));return value}finally{setMultiBusy(false)}}
 /** 位姿/视场是 Provider 侧临时 override：这里只把用户输入与所选参考系原样转发，不缓存、也不写源文档。
  * 参考系默认 parent（相机所属 body 局部，腕部/头部挂载相机安装偏移推荐）；world=世界位姿（明确固定视角）。
  * 成功后按回执归位读数卡与视锥：**先认回执再重读**——命令失败时既不显示成功，也不动仍有效的那条回执。 */
 const adjustCamera=async(clear:boolean)=>{if(!sensorReady||!world)throw new Error("CAMERA_ADJUST_REQUIRES_LIVE_SYNCED_WORLD");if(!adjustName.trim())throw new Error("CAMERA_NAME_REQUIRED");const positionM=numbers(adjustXYZ),quaternionXyzw=numbers(adjustQuat),fovyDeg=adjustFovy.trim()===""?undefined:Number(adjustFovy);if(!clear&&positionM===undefined&&quaternionXyzw===undefined&&fovyDeg===undefined)throw new Error("CAMERA_ADJUST_REQUIRES_VALUE");const request=worldIdentity;const value=await api.command<any>("camera_adjust_ui",{sceneId,worldId:world.worldId,cameraName:adjustName.trim(),expectedGeneration:world.worldGeneration,clear,...clear?{}:{referenceFrame:adjustFrame,...positionM===undefined?{}:{positionM},...quaternionXyzw===undefined?{}:{quaternionXyzw},...fovyDeg===undefined?{}:{fovyDeg}}});const key=cameraWorldKey(request);if(!adoptableReceipt(value,request,worldKeyRef.current))return value;setCameraScope(old=>scopedPatch(old,key,{adjustResult:value}));await refreshCamerasAfterAdjust(key);return value}
 /** 点击像素 → 用该次真实采集的米制深度与标定得到世界点；返回的标注 JSON 也由 Shell 落盘，不只画一个 SVG 点。
  * 该回执不带 world 字段，只核"请求时的身份仍是当前身份"（迟到的旧请求不写进新 world 的标注）。 */
 const annotatePixel=async(camera:string,pixel:[number,number])=>{if(!multiResult||!world)throw new Error("CAMERA_ANNOTATION_REQUIRES_CAPTURE");const request=worldIdentity;const value=await api.command<any>("camera_annotation_ui",{sceneId,worldId:world.worldId,cameraName:camera,pixel,captureId:multiResult.captureId});if(!stillCurrentWorld(request,worldKeyRef.current))return value;setCameraScope(old=>scopedPatch(old,cameraWorldKey(request),base=>({annotations:{...base.annotations,[camera]:value}})));return value}
 const exportDataset=async()=>{if(!multiResult||!world||!sceneId)throw new Error("CAMERA_DATASET_EXPORT_REQUIRES_CAPTURE");const request=worldIdentity;const value=await api.command<any>("camera_dataset_export_ui",{sceneId,worldId:world.worldId,expectedGeneration:world.worldGeneration,captureIds:[multiResult.captureId]});if(!adoptableReceipt(value,request,worldKeyRef.current))return value;setCameraScope(old=>scopedPatch(old,cameraWorldKey(request),{datasetResult:value}));return value}
 // 媒体 URL 也按会话寻址（同一个 captureId 在别的会话里是另一份产物）：统一走 api.mediaURL，不手拼前缀。
 const cameraMedia=(name:string,sensor:"rgb"|"depth")=>api.mediaURL("capture",{captureId:multiResult?.captureId??"",camera:name,sensor})
 const source=()=>({sceneId:capture!.sceneId,sceneRevision:capture!.sceneRevision,frameId:capture!.frameId??capture!.captureId,...capture!.worldId?{worldId:capture!.worldId,worldGeneration:capture!.generation,worldSceneRevision:capture!.worldSceneRevision,frameSceneRevision:capture!.frameSceneRevision,stepIndex:capture!.stepIndex}:{},camera:capture!.camera})
 const invoke=async(name:string,request:any)=>{const raw=await api.command<any>(name,{request_json:JSON.stringify(request)});const parsed=typeof raw?.result==="string"?JSON.parse(raw.result):raw;setResult(parsed);return parsed}
 const image=(uri:string)=>api.mediaURL("segmentation-resource",{sceneId:capture?.sceneId??"",uri})
 return <><p className="lya-help">{tr("采集保留相机、场景版本和运行帧来源；2D 分割不会自动改变三维资产。","Captures retain camera, scene revision and frame provenance. 2D masks do not automatically modify 3D assets.")}</p><fieldset><legend>{tr("相机 RGB-D / 标定","Camera RGB-D / calibration")}</legend><div className="lya-row"><input className="lya-wide" aria-label={tr("原生相机名","Named camera")} placeholder={tr("原生相机名（可选）","Named camera (optional)")} value={cameraName} onChange={event=>setCameraName(event.target.value)}/><input type="number" aria-label={tr("宽度","Width")} min={16} max={4096} value={sensorWidth} onChange={event=>setSensorWidth(Number(event.target.value))} style={{width:70}}/><input type="number" aria-label={tr("高度","Height")} min={16} max={4096} value={sensorHeight} onChange={event=>setSensorHeight(Number(event.target.value))} style={{width:70}}/></div><button className="lya-wide" disabled={!sensorReady||sensorBusy} onClick={()=>perform(captureSensor)}>{sensorBusy?tr("正在采集…","Capturing…"):tr("采集 RGB-D 并读取标定","Capture RGB-D and read calibration")}</button>{!sensorReady&&<p className="lya-help">{officialWorld?tr("官方套件不提供自由 RGB-D 采集；请用上方“官方视角”查看该 world 随 bench_step 记录的官方观察。","The official suite has no free RGB-D capture; use Official camera above for the observations recorded with bench_step."):gymWorld?tr("Gymnasium 不提供自由 RGB-D 采集；观测只随该 episode 的官方 env.render 帧提供。","Gymnasium has no free RGB-D capture; observations come only from the episode's official env.render frames."):tr("请返回实时视图并同步模拟后采集。","Return to the live view and sync the simulation before capturing.")}</p>}{visibleSensorResult&&<><img className="lya-capture-image" style={{width:"100%",height:"auto"}} alt={tr("当前模拟相机 RGB 采集","Current simulation camera RGB capture")} src={api.mediaURL("capture",{captureId:visibleSensorResult.captureId,sensor:"rgb"})}/><a href={api.mediaURL("capture",{captureId:visibleSensorResult.captureId,sensor:"depth"})} download>{tr("下载深度 NPY（米）","Download depth NPY (meters)")}</a><p className="lya-help">{visibleSensorResult.calibration?tr(`pinhole · ${visibleSensorResult.calibration.intrinsics.width}×${visibleSensorResult.calibration.intrinsics.height} · fx ${Number(visibleSensorResult.calibration.intrinsics.fx).toFixed(2)} · fy ${Number(visibleSensorResult.calibration.intrinsics.fy).toFixed(2)}`,`pinhole · ${visibleSensorResult.calibration.intrinsics.width}×${visibleSensorResult.calibration.intrinsics.height} · fx ${Number(visibleSensorResult.calibration.intrinsics.fx).toFixed(2)} · fy ${Number(visibleSensorResult.calibration.intrinsics.fy).toFixed(2)}`):tr("自由相机未提供稳定标定；请填写原生相机名。","Free camera has no stable calibration; enter a named camera.")}</p><details><summary>{tr("RGB-D 与标定来源","RGB-D and calibration provenance")}</summary>{publicCommandFace("sensor_capture_ui",visibleSensorResult,english).map((row:string)=><div key={row}>{row}</div>)}</details></>}</fieldset>
 <fieldset><legend>{tr("多视角相机（同帧采集）","Multi-view cameras (one step)")}</legend>
  <button className="lya-wide" disabled={!sensorReady} onClick={()=>perform(loadCameras)}>{tr("读取命名相机位姿与视场","List named camera poses and FOV")}</button>
  {cameras&&<p className="lya-help">{cameras.length?cameras.flatMap((item:any)=>{const status=cameraStatus(item);return status.rig.ok?[`${item.cameraName} · fovy ${fovYFromIntrinsics(status.rig.spec.intrinsics).toFixed(1)}`]:[]}).join(" | ")||tr("该 world 的命名相机都不可用（原因见下）。","No named camera in this world is usable (reasons below)."):tr("该 world 没有命名相机。","This world has no named cameras.")}</p>}
  {cameras&&cameras.length>0&&<div className="lya-row" style={{flexWrap:"wrap"}}>{cameras.map((item:any)=>{const status=cameraStatus(item);return <label key={item.cameraName} title={status.reason} style={{display:"flex",gap:4,alignItems:"center"}}><input type="checkbox" disabled={!usableCameraSpec(item)} checked={selectedCameras.includes(item.cameraName)} onChange={event=>toggleCamera(item.cameraName,event.target.checked)}/>{String(item.cameraName).split("/").pop()}{status.ok?null:tr("（不可用，未采集）"," (unavailable, not captured)")}</label>})}</div>}
  {cameras&&cameras.length>0&&<ul className="lya-help" style={{margin:0,paddingLeft:16}}>{cameras.map((item:any)=>{const status=cameraStatus(item);return <li key={item.cameraName}>{item.cameraName}{status.ok?` · ${tr("可用","available")} · ${tr("挂载","mount")} ${item.parentBodyName??"—"} · ${tr("位姿来源","pose source")}=${item.poseSource??"—"}`:` · ${tr("不可用","unavailable")}：${status.reason}`}</li>})}</ul>}
  <div className="lya-row"><input type="number" aria-label={tr("多视角宽度","Multi-view width")} min={16} max={4096} value={sensorWidth} onChange={event=>setSensorWidth(Number(event.target.value))} style={{width:70}}/><input type="number" aria-label={tr("多视角高度","Multi-view height")} min={16} max={4096} value={sensorHeight} onChange={event=>setSensorHeight(Number(event.target.value))} style={{width:70}}/></div>
  <button className="lya-wide" disabled={!sensorReady||multiBusy||selectedCameras.length===0} onClick={()=>perform(captureMulti)}>{multiBusy?tr("正在同帧采集…","Capturing one step…"):tr("同一物理步采集全部所选相机","Capture all selected cameras in one step")}</button>
  {!sensorReady&&<p className="lya-help">{tr("请返回实时视图并同步模拟后再采集多视角。","Return to the live view and sync the simulation before multi-view capture.")}</p>}
  {multiResult&&<><p className="lya-help">{tr(`同帧 ${multiResult.cameras.length} 台相机 · ${multiResult.width}×${multiResult.height} · step ${multiResult.stepIndex}` ,`${multiResult.cameras.length} cameras in one step · ${multiResult.width}×${multiResult.height} · step ${multiResult.stepIndex}`)}</p>
   {multiResult.cameras.map((entry:any)=>{const annotation=annotations[entry.cameraName];const intrinsics=entry.calibration?.intrinsics;return <div key={entry.cameraName}><p className="lya-help">{entry.cameraName} · fovy {Number(intrinsics?.fovyDeg).toFixed(1)} · fx {Number(intrinsics?.fx).toFixed(2)} · cx {Number(intrinsics?.cx).toFixed(2)} / cy {Number(intrinsics?.cy).toFixed(2)}{entry.override?tr(" · 临时 override"," · temporary override"):""}</p><div className="lya-image-panel" style={{position:"relative"}} onClick={event=>{const box=event.currentTarget.getBoundingClientRect();void annotatePixel(entry.cameraName,[Math.floor((event.clientX-box.left)/box.width*multiResult.width),Math.floor((event.clientY-box.top)/box.height*multiResult.height)])}}><img style={{display:"block",width:"100%",height:"auto"}} src={cameraMedia(entry.cameraName,"rgb")} alt={tr(`${entry.cameraName} 同帧 RGB，可点击标注像素`,`${entry.cameraName} RGB in the same step; click to annotate a pixel`)}/><svg style={{position:"absolute",inset:0,width:"100%",height:"100%",pointerEvents:"none"}} viewBox={`0 0 ${multiResult.width} ${multiResult.height}`}>{annotation&&<circle cx={annotation.pixel[0]} cy={annotation.pixel[1]} r={Math.max(multiResult.width/100,3)} fill="#ffbb35" stroke="#111" strokeWidth={2}/>}</svg></div><a href={cameraMedia(entry.cameraName,"depth")} download>{tr("下载该相机深度 NPY（米）","Download this camera depth NPY (meters)")}</a>{annotation&&<p className="lya-help">{tr(`世界点 [${annotation.worldPointM.map((value:number)=>value.toFixed(4)).join(", ")}] m · 深度 ${Number(annotation.depthM).toFixed(4)} m`,`World point [${annotation.worldPointM.map((value:number)=>value.toFixed(4)).join(", ")}] m · depth ${Number(annotation.depthM).toFixed(4)} m`)}<br/>{tr("标注已保存：","Annotation saved:")}{annotation.annotationPath}</p>}</div>})}
   <details><summary>{tr("多视角采集回执与标注","Multi-view receipt and annotations")}</summary>{publicCommandFace("camera_capture_multi_ui",{captureId:multiResult.captureId,frameId:multiResult.frameId,stepIndex:multiResult.stepIndex,override:multiResult.cameras.some((entry:any)=>entry.override),annotations},english).map((row:string)=><div key={row}>{row}</div>)}</details><button className="lya-wide" disabled={!sensorReady} onClick={()=>perform(exportDataset)}>{tr("导出当前多视角训练数据集","Export current multi-view training dataset")}</button>{datasetResult&&<p className="lya-help">{tr(`训练数据已导出：${datasetResult.outputDir??datasetResult.result?.outputDir??"—"}`,`Training dataset exported: ${datasetResult.outputDir??datasetResult.result?.outputDir??"—"}`)}</p>}</>}
 </fieldset>
 <details className="lya-advanced"><summary>{tr("临时位姿 / 视场调整（高级）","Temporary pose / FOV overrides (advanced)")}</summary>
 <fieldset><legend>{tr("相机位姿 / 视场临时调整","Temporary camera pose / FOV")}</legend>
  <div className="lya-row"><input className="lya-wide" aria-label={tr("被调整的相机名","Camera to adjust")} placeholder={tr("相机名（如 wrist）","Camera name (for example wrist)")} value={adjustName} onChange={event=>setAdjustName(event.target.value)}/><select aria-label={tr("位姿参考系","Pose reference frame")} value={adjustFrame} onChange={event=>setAdjustFrame(event.target.value==="world"?"world":"parent")} style={{width:120}}><option value="parent">{tr("parent（body 局部）","parent (body local)")}</option><option value="world">{tr("world（世界）","world")}</option></select><input type="number" aria-label={tr("竖直视场角","Vertical FOV")} min={1} max={179} step={1} value={adjustFovy} onChange={event=>setAdjustFovy(event.target.value)} style={{width:70}}/></div>
  <p className="lya-help">{tr("参考系：parent=相对相机所属 body 的局部安装位姿（腕部/头部挂载相机推荐，每帧随父 body FK 更新）；world=世界位姿（明确固定的视角，不随关节运动改变）。FOV-only 不冻结挂载相机位姿。","Reference frame: parent = local mount pose relative to the camera's body (recommended for wrist/head-mounted cameras; follows parent FK every frame); world = world pose (explicitly fixed, does not move with joints). FOV-only never freezes a mounted camera.")}</p>
  <div className="lya-row"><input className="lya-wide" aria-label={tr("参考系位置 XYZ","Frame position XYZ")} placeholder={tr("位置 x y z（米，按所选参考系，留空不改）","position x y z (meters, in the selected frame, blank keeps)")} value={adjustXYZ} onChange={event=>setAdjustXYZ(event.target.value)}/><input className="lya-wide" aria-label={tr("四元数 xyzw","Quaternion xyzw")} placeholder={tr("四元数 x y z w（留空不改）","quaternion x y z w (blank keeps)")} value={adjustQuat} onChange={event=>setAdjustQuat(event.target.value)}/></div>
  <div className="lya-row"><button className="lya-wide" disabled={!sensorReady||!adjustName.trim()} onClick={()=>perform(()=>adjustCamera(false))}>{tr("应用临时调整（不改源文档）","Apply temporary override (source untouched)")}</button><button disabled={!sensorReady||!adjustName.trim()} onClick={()=>perform(()=>adjustCamera(true))}>{tr("清除临时调整","Clear override")}</button></div>
  {adjustResult&&<p className="lya-help">{tr(`override=${String(adjustResult.override)} · 代次 ${receiptGenerationText(adjustResult)} · clearOn ${(adjustResult.clearsOn??[]).join("/")} · 参考系 ${adjustResult.referenceFrame??"—"} · 所属body ${adjustResult.parentBodyName??"—"} · 最终世界位置 ${adjustResult.worldFromCamera?.positionM?adjustResult.worldFromCamera.positionM.map((value:number)=>Number(value).toFixed(3)).join(", "):"—"}`,`override=${String(adjustResult.override)} · generation ${receiptGenerationText(adjustResult)} · clearsOn ${(adjustResult.clearsOn??[]).join("/")} · frame ${adjustResult.referenceFrame??"—"} · parentBody ${adjustResult.parentBodyName??"—"} · final world position ${adjustResult.worldFromCamera?.positionM?adjustResult.worldFromCamera.positionM.map((value:number)=>Number(value).toFixed(3)).join(", "):"—"}`)}</p>}
 </fieldset>
 </details>
 <div className="lya-captures">{captures.map(item=><button key={item.captureId} onClick={()=>select(item)}><img src={api.captureURL(item.captureId)} alt={tr("场景采集","Scene capture")}/><small>rev {item.sceneRevision} · step {item.stepIndex??"—"}</small></button>)}</div>
 {/* mask 框按原帧坐标叠在预览上，所以盒子必须**就是 <img> 显示出来的那块**：预览图铺满盒宽（`width:100%`，
     高度按比例），叠层图与 SVG 都绝对定位到同一块——否则大图按原始像素溢出盒子，框就对不上。 */}
 {capture&&<><div className="lya-image-panel" style={{position:"relative"}}><img style={{display:"block",width:"100%",height:"auto"}} src={api.captureURL(capture.captureId)} alt={tr("当前采集","Selected capture")}/>{result?.overlay?.uri&&overlay&&<img className="lya-overlay" style={{position:"absolute",inset:0,width:"100%",height:"100%",pointerEvents:"none"}} src={image(result.overlay.uri)} alt="SAM3 mask overlay"/>}<svg style={{position:"absolute",inset:0,width:"100%",height:"100%",pointerEvents:"none"}} viewBox={`0 0 ${frameWidth} ${frameHeight}`}>{overlay&&result?.masks?.map((mask:any)=>{const b=mask.boxXYXY;return b&&<rect key={mask.id} x={b[0]} y={b[1]} width={b[2]-b[0]} height={b[3]-b[1]} stroke="#44e5b4" fill="none" strokeWidth={Math.max(frameWidth/300,2)}/>})}</svg></div>
 <p className="lya-help">{frameWidth} × {frameHeight} · rev {capture.sceneRevision}{capture.originalImage?tr(`（原帧；这里显示的是 ${capture.attachment.width}×${capture.attachment.height} 预览，mask 框已按同一份换算回到原帧像素）`,` (original frame; the ${capture.attachment.width}×${capture.attachment.height} shown here is a preview — mask boxes are mapped back to original-frame pixels)`):""}<br/>{capture.worldId?`g${capture.generation} · world rev ${capture.worldSceneRevision??"?"} · frame rev ${capture.frameSceneRevision??"?"} · step ${capture.stepIndex} · ${capture.simTime?.toFixed(3)} s`:tr("场景相机","Scene camera")}</p>
 <fieldset><legend>SAM3 · {tr("图像分割","Image segmentation")}</legend><input className="lya-wide" aria-label={tr("分割对象描述","Segmentation text prompt")} placeholder={tr("例如：蓝色方块","For example: blue cube")} value={prompt} onChange={event=>setPrompt(event.target.value)}/><button className="lya-wide" disabled={!prompt} onClick={()=>perform(()=>invoke("segment_sam3",{requestId:crypto.randomUUID(),imagePath:capture.imagePath,textPrompt:prompt,source:source()}))}>{tr("用 SAM3 分割图像","Segment image with SAM3")}</button></fieldset>
 {result&&<><label><input type="checkbox" checked={overlay} onChange={event=>setOverlay(event.target.checked)}/>{tr("显示 mask 与边界框","Show masks and boxes")}</label><p>{result.emptyResult?tr("未找到匹配对象","No matching objects"):`${result.masks?.length??0} masks`}</p>{result.masks?.map((mask:any)=><div className="lya-row" key={mask.id}><span>{mask.label??mask.id}</span><span>{typeof mask.score==="number"?mask.score.toFixed(3):""}</span><a href={image(mask.uri)} target="_blank" rel="noreferrer">{tr("打开 mask","Open mask")}</a></div>)}<details><summary>{tr("来源","Source")}</summary>{publicCommandFace("segment_sam3",result,english).map((row:string)=><div key={row}>{row}</div>)}</details></>}
 </>}
 </>
}
