import {useCallback,useEffect,useRef,useState,type RefObject} from "react"
import {createPortal} from "react-dom"
import type {SceneSnapshot,WorldHandle} from "../../lyapunov-contracts/src/types.ts"
import {adoptableReceipt,cameraWorldKey,type CameraWorldIdentity} from "./capture-panel.tsx"
import type {Translate} from "./entity-editor.tsx"
import type {workbenchAPI} from "./workbench-api.ts"
import {CAMERA_DEPTH_COLOR_RULE,LIDAR_RANGE_COLOR_RULE,NPY_INVALID_RGBA,colorizeNpy,decodeNpy,npyStats,type NpyColorRule,type NpyDtype,type NpyImage,type NpyStats} from "./npy-preview.ts"

const finiteNumber=(text:string):number|undefined=>{const value=Number(text);return Number.isFinite(value)?value:undefined}
/**
 * 一条 LiDAR 回执能不能显示：**世界身份匹配**（`adoptableReceipt`：Scene/world/代次，迟到的旧 world 回执作废）
 * **且**它属于当前选中的那台机位（相机身份）。换机位时 world 身份不变，所以必须显式核对相机名，
 * 否则旧机位 A 的 range 会在切到机位 B 后继续显示，冒充 B 的当前量测。
 */
export function visibleLidarResult(receipt:any,identity:CameraWorldIdentity,cameraName?:string){if(!receipt||!cameraName)return undefined;if(receipt.cameraName!==cameraName&&receipt.resolvedCameraName!==cameraName)return undefined;return adoptableReceipt(receipt,identity,cameraWorldKey(identity))?receipt:undefined}

/**
 * P7A2：比较区显示用的相机采集身份。
 *
 * RGB 与相机 Depth 必须来自**同一次原生 capture**（同一个 `captureId`+`cameraName`），所以这里只承载
 * 一次已完成的 `camera-preview` 回执；扫描时把它连同 capture/frame/step/generation 一起钉住，
 * 之后不再被直播轮询替换，避免"RGB 在动、LiDAR 不动却标同帧"。
 */
export interface CameraCaptureRef {
  captureId?:string
  cameraName?:string
  frameId?:string
  stepIndex?:number
  simTime?:number
  worldGeneration?:number
  sceneRevision?:number
  /** 原生 depth 回执自报的范围（米）；画图仍从 NPY 复算，这里只用于对照。 */
  depthRangeM?:[number,number]
  /** native / scene camera 身份，来自回执条目。 */
  resolvedCameraName?:string
  /** 这次采集是否真的带 RGB / 深度字节；`false` 时必须诚实标 Unavailable，不能用 RGB 冒充深度。 */
  rgbAvailable?:boolean
  depthAvailable?:boolean
}

export type FrameVerdict =
  |{status:'same-frame';frameId:string;stepIndex:number;worldGeneration:number}
  |{status:'different-frame';reason:'world'|'frame'|'step';cameraFrameId?:string;lidarFrameId?:string;cameraStep?:number;lidarStep?:number;stepDelta?:number;timeDeltaS?:number}
  |{status:'incomplete';reason:'missing-source'|'generation-missing'|'frame-missing'|'step-missing'}

/**
 * 只有 frame、step、world 代次三者**真实相同**才判同帧；缺一个就判"身份不完整"，绝不拿相近的 step 冒充同帧。
 * 时间差只作辅助（物理是否在走），不参与同帧判定。
 */
export function compareFrameIdentity(camera:any,lidar:any):FrameVerdict {
  if(!camera||!lidar)return {status:'incomplete',reason:'missing-source'}
  const cameraGeneration=camera.worldGeneration??camera.generation,lidarGeneration=lidar.worldGeneration??lidar.generation
  const cameraFrameId=camera.frameId,lidarFrameId=lidar.frameId
  const cameraStep=camera.stepIndex,lidarStep=lidar.stepIndex
  const common={cameraFrameId,lidarFrameId,cameraStep,lidarStep,...(typeof camera.simTime==='number'&&typeof lidar.simTime==='number'?{timeDeltaS:camera.simTime-lidar.simTime}:{})}
  if(cameraGeneration===undefined||lidarGeneration===undefined)return {status:'incomplete',reason:'generation-missing'}
  if(cameraGeneration!==lidarGeneration)return {status:'different-frame',reason:'world',...common}
  if(cameraFrameId===undefined||lidarFrameId===undefined)return {status:'incomplete',reason:'frame-missing'}
  if(cameraFrameId!==lidarFrameId)return {status:'different-frame',reason:'frame',...common}
  if(cameraStep===undefined||lidarStep===undefined)return {status:'incomplete',reason:'step-missing'}
  if(cameraStep!==lidarStep)return {status:'different-frame',reason:'step',...common,stepDelta:cameraStep-lidarStep}
  return {status:'same-frame',frameId:cameraFrameId,stepIndex:cameraStep,worldGeneration:cameraGeneration}
}

/**
 * 从一次 `camera-preview` 回执与其中的相机条目投影出比较用的身份。
 * RGB 与 Depth 位于同一条目、同一 `captureId`；缺 `captureId` 或相机名就不是一次可用的原生采集，返回 undefined。
 */
export function cameraCaptureRef(receipt:any,image:any):CameraCaptureRef|undefined {
 const captureId=receipt?.captureId,cameraName=image?.cameraName??image?.resolvedCameraName
 if(!captureId||!cameraName)return undefined
 const depthRangeM=Array.isArray(image?.depthRangeM)&&image.depthRangeM.length===2?[Number(image.depthRangeM[0]),Number(image.depthRangeM[1])] as [number,number]:undefined
 // 只有回执明确给出 null/对象时才判通道可得；字段缺失保持 undefined（旧回执兼容），仍按相机采集可用处理。
 const rgbAvailable=image?.rgb===null?false:image?.rgb===undefined?undefined:true
 const depthAvailable=image?.depth===null?false:image?.depth===undefined?undefined:true
 return {captureId,cameraName,resolvedCameraName:image?.resolvedCameraName,frameId:receipt?.frameId??image?.frameId,stepIndex:receipt?.stepIndex??image?.stepIndex,simTime:receipt?.simTime??image?.simTime,worldGeneration:receipt?.worldGeneration??receipt?.generation??image?.worldGeneration,sceneRevision:receipt?.sceneRevision,depthRangeM,...rgbAvailable!==undefined?{rgbAvailable}:{},...depthAvailable!==undefined?{depthAvailable}:{}}
}

/** 三种量各自的真实可得性；缺件时**不画**占位图，只显示缺件原因。 */
export function compareSources(camera:CameraCaptureRef|undefined,lidar:any){
  const cameraReady=Boolean(camera?.captureId&&(camera.cameraName||camera.resolvedCameraName))
  const lidarReady=Boolean(lidar?.captureId&&lidar?.range)
  return {cameraReady,lidarReady,rgb:Boolean(cameraReady&&camera?.rgbAvailable!==false),cameraDepth:Boolean(cameraReady&&camera?.depthAvailable!==false),lidarRange:lidarReady}
}

/**
 * 比较区用哪一次相机采集：扫描时钉住的采集优先；换机位/换 world 后旧 key 的钉子一律作废，
 * 退回当前直播采集（并标成未钉住），绝不让旧成功盖住新状态。
 */
export function comparisonCaptureOf(pinned:{key:string;capture?:CameraCaptureRef}|undefined,key:string,live?:CameraCaptureRef):{capture?:CameraCaptureRef;pinned:boolean}{
  if(pinned&&pinned.key===key&&pinned.capture)return {capture:pinned.capture,pinned:true}
  return {capture:live,pinned:false}
}

type NpyCanvasState =
  |{key:string;status:'missing'}
  |{key:string;status:'loading'}
  |{key:string;status:'error';message:string}
  |{key:string;status:'ready';image:NpyImage;dtype:NpyDtype;shape:string;stats:NpyStats}

/**
 * 只有与当前 scope key 相同的 NPY 状态才可见：换机位/换 world/卸载后，
 * 旧请求的**成功与失败**都不显示（新状态不会被旧回执覆盖，页面也不会闪回旧图）。
 */
export function visibleNpyState<T extends {key:string}>(state:T|undefined,scopeKey:string):T|undefined{return state&&state.key===scopeKey?state:undefined}

/**
 * 窄 NPY→Canvas 显示：按 key（世界身份+机位+captureId）取一次 NPY，异步结果只写回**同 key** 的状态；
 * 换机位/换 world/卸载会 abort 并使旧成功、旧失败一并作废。失败如实显示，不留上一张图。
 */
function NpyCanvas({url,scopeKey,rule,spanM,label,tr,compact=false}:{url?:string;scopeKey:string;rule:NpyColorRule;spanM?:number;label:string;tr:Translate;compact?:boolean}){
  const [state,setState]=useState<NpyCanvasState>(()=>({key:scopeKey,status:url?'loading':'missing'}))
  const canvasRef=useRef<HTMLCanvasElement|null>(null)
  useEffect(()=>{
    if(!url){setState({key:scopeKey,status:'missing'});return}
    const controller=new AbortController()
    let live=true
    setState({key:scopeKey,status:'loading'})
    void (async()=>{
      try{
        const response=await fetch(url,{signal:controller.signal,cache:'no-store'})
        if(!response.ok)throw new Error(`HTTP ${response.status} ${response.statusText}`)
        const array=decodeNpy(await response.arrayBuffer())
        const image=colorizeNpy(array,rule,spanM!==undefined?{spanM}:{})
        if(!live)return
        setState({key:scopeKey,status:'ready',image,dtype:array.dtype,shape:array.declaredShape,stats:npyStats(array.values)})
      }catch(failure){
        if(controller.signal.aborted||!live)return
        setState({key:scopeKey,status:'error',message:failure instanceof Error?failure.message:String(failure)})
      }
    })()
    return()=>{live=false;controller.abort()}
  },[url,scopeKey,rule,spanM])
  useEffect(()=>{
    const canvas=canvasRef.current
    if(!canvas||state.key!==scopeKey||state.status!=='ready')return
    const {image}=state
    canvas.width=image.width;canvas.height=image.height
    const context=canvas.getContext('2d')
    if(!context)return
    const pixels=context.createImageData(image.width,image.height)
    pixels.data.set(image.rgba)
    context.putImageData(pixels,0,0)
  },[state,scopeKey])
  const current=visibleNpyState(state,scopeKey)
  if(current?.status==='ready'){
    const {image,stats,dtype,shape}=current
    const range=image.spanMin!==undefined&&image.spanMax!==undefined?`${image.spanMin.toFixed(3)}–${image.spanMax.toFixed(3)} m`:'—'
    const facts=<>
      <p className="lya-help" data-testid="npy-summary">{dtype} {shape} · {tr('范围','range')} {range} · {tr('无返回/无效','no-return/invalid')} {image.invalid} · {tr('有限','finite')} {stats.finiteCount}/{stats.count}{stats.mean!==undefined?` · ${tr('均值','mean')} ${stats.mean.toFixed(3)} m`:''}</p>
      <p className="lya-help" data-testid="npy-rule">{rule.id} · {tr(rule.zh,rule.en)}{image.invalid>0?` · ${tr('无返回像素色','no-return pixel color')} rgba(${NPY_INVALID_RGBA.join(',')})`:''}</p>
    </>
    return <div>
      <canvas ref={canvasRef} role="img" aria-label={label} style={{width:'100%',height:'auto',imageRendering:'pixelated',background:'var(--lya-line-2)'}}/>
      {compact?<><p className="lya-help">{range}</p><details data-testid="npy-data-details"><summary>{tr('数据详情','Data details')}</summary>{facts}</details></>:facts}
    </div>
  }
  if(current?.status==='error')return <p className="lya-help lya-error" role="alert" style={{overflowWrap:'anywhere'}}>{tr('NPY 读取/解码失败','NPY fetch/decode failed')}：{current.message}</p>
  if(current?.status==='loading')return <p className="lya-help" role="status">{tr('正在解码原生 NPY…','Decoding native NPY…')}</p>
  return <p className="lya-help">{tr('缺件：尚无该来源的原生产物','missing: no native artifact for this source yet')}</p>
}

const compareDialogStyle=`
.lya-compare-overlay-host{position:absolute;inset:0;z-index:25;display:flex;align-items:flex-end;justify-content:center;padding:0 14px 42px;pointer-events:none}
.lya-compare-overlay-host>.lya-compare-dialog{pointer-events:auto}
.lya-compare-dialog{width:min(640px,100%);max-height:min(72vh,540px);overflow:auto;background:var(--lya-bg,#20262e);border:1px solid var(--lya-line-2,#39414c);border-radius:10px;box-shadow:0 18px 48px #0008;padding:10px;display:flex;flex-direction:column;gap:8px;font-size:12px;color:var(--lya-text,#e6e9ed);pointer-events:auto}
.lya-compare-dialog[hidden]{display:none}
/* V11-P21 兜底：没有 overlay host 时内联显示，入口不会变成“点了没反应”。 */
.lya-compare-inline-host{position:fixed;right:18px;bottom:58px;z-index:40;width:min(640px,calc(100vw - 300px));pointer-events:auto}
/* 设计稿 camera-compare：Compare channels 是满宽次要按钮 */
.lya-compare-entry .lya-compare-open{width:100%}
.lya-compare-dialog .lya-compare-head{display:flex;align-items:flex-start;gap:8px}
.lya-compare-dialog .lya-compare-head>div{min-width:0;display:flex;flex-direction:column;gap:1px}
.lya-compare-dialog .lya-compare-head strong{font-size:12px}
.lya-compare-dialog .lya-compare-head span{font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.lya-compare-dialog .lya-compare-head button{margin-left:auto;flex:0 0 auto}
.lya-compare-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.lya-compare-figure{display:flex;flex-direction:column;gap:4px;min-width:0;margin:0}
.lya-compare-figure figcaption{display:flex;flex-direction:column;gap:1px;font-size:11px;line-height:1.35;color:var(--dsw-alias-label-secondary)}
.lya-compare-figure figcaption strong{font-size:11px;color:var(--dsw-alias-label-primary)}
.lya-compare-thumb{display:flex;align-items:center;justify-content:center;min-height:108px;padding:4px;border:1px solid var(--lya-line);border-radius:6px;background:#121a24;overflow:hidden}
.lya-compare-thumb img{display:block;width:100%;height:auto;max-height:150px;object-fit:contain}
.lya-compare-thumb .lya-help{font-size:11px;margin:0;text-align:center}
.lya-compare-figure .lya-help{font-size:11px;line-height:1.4;margin:0;overflow-wrap:anywhere}
.lya-compare-figure a{font-size:11px;color:var(--dsw-alias-link)}
.lya-compare-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.lya-compare-actions [data-testid=frame-verdict]{flex:1 1 100%;font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.lya-compare-dialog details{font-size:11px}
.lya-compare-dialog details .lya-row{flex-wrap:wrap}
@media (max-width:760px){.lya-compare-grid{grid-template-columns:1fr}.lya-compare-thumb{min-height:92px}.lya-compare-thumb img{max-height:130px}}
`
/**
 * P7A2：Camera 选定机位后的 RGB / 相机Depth / LiDAR 轻量比较。
 *
 * 三种量来源分行标明、不共用一个图例：RGB 是相机原生 PNG；相机Depth 是沿光轴 Z 的轴向米制 NPY（灰度）；
 * LiDAR range 是沿射线的欧氏米制 NPY（红→绿比例色，无返回独立洋红）。扫描时把参与比较的相机采集
 * 连同 capture/frame/step/generation 钉住，只有与 LiDAR 回执真实同帧才显示"同帧"。
 */
export function LidarScanPanel({api,scene,world,identity,ready,cameraName,cameraLabel,cameraCapture,captureScopeKey,captureCamera,tr,perform,compareOverlayHost}:{
 api:ReturnType<typeof workbenchAPI>;scene?:SceneSnapshot;world?:WorldHandle;identity:CameraWorldIdentity;ready:boolean;
 cameraName?:string;cameraLabel?:string;cameraCapture?:CameraCaptureRef;tr:Translate;perform:(fn:()=>Promise<unknown>)=>void
 /** 相机 owner 的稳定语义键，包含尺寸和可用性；轮询对象与 Live 开关不改变它。 */
 captureScopeKey?:string
 /** 立刻采一帧 RGB-D；返回 undefined 表示本次作废。明确 LiDAR-only 时不传入口。 */
 captureCamera?:()=>Promise<CameraCaptureRef|undefined>
 /** V8-21：画布内自有浮层宿主；缺省时退化到面板内隐藏的同一份结构（SSR/测试），不做第二套数据。 */
 compareOverlayHost?:RefObject<HTMLElement>
}){
 const [channels,setChannels]=useState('16'),[samples,setSamples]=useState('360'),[rangeM,setRangeM]=useState('20'),[vertical,setVertical]=useState('-15 15')
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<any>()
 const [pinned,setPinned]=useState<{key:string;capture?:CameraCaptureRef}>()
 const [rgbFailure,setRgbFailure]=useState<{key:string;message:string}>()
 const [compareOpen,setCompareOpen]=useState(false),[refreshBusy,setRefreshBusy]=useState(false)
 const key=JSON.stringify([cameraWorldKey(identity),cameraName??'',captureScopeKey??'',Boolean(captureCamera)])
 // 请求归属（request ownership）：仅在 key/API/就绪资格变化时换 scope 并 abort 旧请求。
 // A→B→A 时 key 文字虽重新相同，旧 A 请求持有的仍是旧 scope 对象，`scope.current!==requestScope` 即判其作废；
 // 同一 scope 内再次扫描则用 controller 实例判定。旧成功/旧失败/旧 finally 都不能改写新操作的状态。
 const scope=useRef<{key:string;api:ReturnType<typeof workbenchAPI>;ready:boolean;cameraCapture?:CameraCaptureRef;controller?:AbortController}>({key,api,ready,cameraCapture})
 if(scope.current.key!==key||scope.current.api!==api||scope.current.ready!==ready){scope.current.controller?.abort();scope.current={key,api,ready,cameraCapture}}
 scope.current.cameraCapture=cameraCapture
 // 身份键**或 API 来源**变化都重置状态：只依赖 key 时，"API 对象换了但 world/机位 key 未变"会让 busy 卡在
 // 上一次请求的值（新 API 来源永远 disabled）。api 与 key 同为归属的一部分，必须一起进依赖。
 useEffect(()=>{setResult(undefined);setError('');setPinned(undefined);setRgbFailure(undefined);setBusy(false);setCompareOpen(false);setRefreshBusy(false)},[key,api,ready])
 // 卸载时中止在途请求并作废其归属，迟到回执/旧 finally 不再写已卸载组件的状态。
 useEffect(()=>()=>{scope.current.controller?.abort();scope.current.controller=undefined},[])
 const visible=visibleLidarResult(result,identity,cameraName)
 // 扫描后钉住当次相机采集；缺相机采集时退回直播采集，但身份仍按实际显示，绝不冒充同帧。
 const comparison=comparisonCaptureOf(pinned,key,cameraCapture)
 const comparisonCapture=comparison.capture
 const capturePinned=comparison.pinned
 const sources=compareSources(comparisonCapture,visible)
 const verdict=compareFrameIdentity(comparisonCapture,visible)
 const scan=useCallback(async()=>{
  if(!ready||!scene||!world||!cameraName)throw new Error('LIDAR_REQUIRES_READY_CAMERA: 先选择进入物理世界的真实机位')
  const elevation=vertical.trim().split(/[\s,]+/).filter(Boolean).map(Number)
  if(elevation.length!==2||elevation.some(value=>!Number.isFinite(value))||!(elevation[0]!<elevation[1]!))throw new Error('竖直视场需要 [下界 上界]，下界小于上界（度）')
  const requestScope=scope.current
  if(requestScope.key!==key||requestScope.api!==api||!requestScope.ready||requestScope.controller)return undefined
  const controller=new AbortController();requestScope.controller=controller
  // 归属判据：必须是**同一个 scope 对象**上的**同一个** controller；key 文字重新相同（A→B→A）不算。
  const ownsRequest=()=>scope.current===requestScope&&requestScope.controller===controller
  setBusy(true);setError('')
  try{
   // 扫描开始先固定"用于比较"的相机采集身份；有真实采集入口时现采一帧，否则用当前已显示的采集。
   const comparison=captureCamera?await captureCamera():requestScope.cameraCapture
   if(controller.signal.aborted||!ownsRequest()||(captureCamera&&!comparison))return undefined
   const value=await api.request<any>('camera-lidar',{method:'POST',signal:controller.signal,body:JSON.stringify({sceneId:scene.sceneId,sceneRevision:scene.revision,worldId:world.worldId,expectedGeneration:world.worldGeneration,cameraName,channels:finiteNumber(channels),horizontalSamples:finiteNumber(samples),rangeM:finiteNumber(rangeM),verticalFovDeg:elevation})})
   if(controller.signal.aborted||!ownsRequest())return undefined
   if(!adoptableReceipt(value,identity,cameraWorldKey(identity)))return undefined
   setPinned({key:requestScope.key,capture:comparison})
   setResult(value);return value
  // 旧/取消请求的失败**不再向当前错误消费者传播**：local alert 已按归属抑制，但 `throw` 仍会经 `perform`
  // 把旧机位 A 的失败显示成新机位 B 的全局错误。只有仍归属当前请求的真实失败才 setError 并抛出；
  // 迟到/取消请求如实作废、不冒领当前操作的失败。
  }catch(failure){if(!ownsRequest()||controller.signal.aborted)return undefined;setError(String(failure));throw failure}
  finally{if(ownsRequest()){requestScope.controller=undefined;setBusy(false)}}
 },[key,api,ready,scene?.sceneId,scene?.revision,world?.worldId,world?.worldGeneration,cameraName,captureCamera,channels,samples,rangeM,vertical])
 // 显式 Refresh：只刷新参与比较的相机采集并把它钉住；不触发 LiDAR 扫描，也不改 Camera 草稿/视角。
 const refreshCapture=useCallback(async()=>{
  if(!captureCamera)throw new Error('CAMERA_CAPTURE_UNAVAILABLE: 当前面板没有真实相机采集入口')
  const requestScope=scope.current
  if(requestScope.key!==key||requestScope.api!==api||!requestScope.ready||requestScope.controller)return undefined
  const controller=new AbortController();requestScope.controller=controller
  const ownsRequest=()=>scope.current===requestScope&&requestScope.controller===controller&&!controller.signal.aborted
  setRefreshBusy(true);setError('')
  try{
   const next=await captureCamera()
   if(!ownsRequest())return undefined
   if(next)setPinned({key:requestScope.key,capture:next})
   return next
  }catch(failure){if(!ownsRequest())return undefined;setError(String(failure));throw failure}
  finally{if(ownsRequest()){requestScope.controller=undefined;setRefreshBusy(false)}}
 },[captureCamera,key,api])
 const cameraReady=sources.cameraReady
 const rgb=sources.rgb?api.mediaURL('capture',{captureId:comparisonCapture!.captureId,camera:comparisonCapture!.cameraName??comparisonCapture!.resolvedCameraName,sensor:'rgb'}):undefined
 const depthNpy=sources.cameraDepth?api.mediaURL('capture',{captureId:comparisonCapture!.captureId,camera:comparisonCapture!.cameraName??comparisonCapture!.resolvedCameraName,sensor:'depth'}):undefined
 const rangeNpy=sources.lidarRange?api.mediaURL('lidar-media',{captureId:visible.captureId,channel:'range'}):undefined
 const validNpy=sources.lidarRange?api.mediaURL('lidar-media',{captureId:visible.captureId,channel:'valid'}):undefined
 const hitGeomNpy=sources.lidarRange?api.mediaURL('lidar-media',{captureId:visible.captureId,channel:'hitGeom'}):undefined
 const lidarPreview=sources.lidarRange?api.mediaURL('lidar-media',{captureId:visible.captureId,channel:'preview'}):undefined
 const cameraScope=`${key}|cam|${comparisonCapture?.captureId??''}|${comparisonCapture?.cameraName??''}`
 const lidarScope=`${key}|lidar|${visible?.captureId??''}`
 const lidarSpanM=Number.isFinite(Number(visible?.rayPattern?.rangeM))?Number(visible?.rayPattern?.rangeM):undefined
 const rgbFailed=rgbFailure?.key===cameraScope
 const verdictText=verdict.status==='same-frame'
  ? tr(`同帧 · frame ${verdict.frameId} · step ${verdict.stepIndex} · world g${verdict.worldGeneration}`,`Same frame · frame ${verdict.frameId} · step ${verdict.stepIndex} · world g${verdict.worldGeneration}`)
  : verdict.status==='different-frame'
   ? tr(`非同帧（${verdict.reason}）：相机 step ${verdict.cameraStep??'—'} vs LiDAR step ${verdict.lidarStep??'—'}${verdict.stepDelta!==undefined?` · Δstep ${verdict.stepDelta}`:''}${verdict.timeDeltaS!==undefined?` · Δt ${verdict.timeDeltaS.toFixed(4)} s`:''}`,`Different frames (${verdict.reason}): camera step ${verdict.cameraStep??'—'} vs LiDAR step ${verdict.lidarStep??'—'}${verdict.stepDelta!==undefined?` · Δstep ${verdict.stepDelta}`:''}${verdict.timeDeltaS!==undefined?` · Δt ${verdict.timeDeltaS.toFixed(4)} s`:''}`)
   : tr('身份不完整，不声称同帧','Identity incomplete; same-frame is not claimed')
 // 浮层主区只留短 verdict；完整帧身份/计算说明/下载链接进具名 Data/Downloads 详情。
 const verdictShort=verdict.status==='same-frame'?tr('同帧','Same frame'):verdict.status==='different-frame'?tr('非同帧','Different frames'):tr('身份不完整，不声称同帧','Identity incomplete; same-frame is not claimed')
 const dialog=<div className="lya-compare-dialog" role="dialog" aria-label={tr('RGB / 相机Depth / LiDAR 对照','RGB / camera Depth / LiDAR comparison')} data-testid="camera-compare-dialog" hidden={!compareOpen}>
  <div className="lya-compare-head">
   <div><strong title={cameraName}>{cameraLabel??cameraName?.split('/').at(-1)??tr('相机','Camera')} · {tr('对照','Sample comparison')}</strong></div>
   <button type="button" data-testid="camera-compare-close" aria-label={tr('关闭对照','Close comparison')} title={tr('关闭对照并返回相机详情','Close comparison and return to camera details')} onClick={()=>setCompareOpen(false)}>×</button>
  </div>
  <div className="lya-compare-grid">
   <figure className="lya-compare-figure" data-testid="compare-rgb" data-channel="rgb" data-available={sources.rgb?'true':'false'}>
    <figcaption><strong>RGB</strong><span>{tr('相机原生 PNG','native camera PNG')}</span></figcaption>
    <div className="lya-compare-thumb">
     {rgb&&!rgbFailed?<img alt={tr('选中相机同帧真实 RGB','Selected camera real RGB from the same capture')} src={rgb} onError={()=>setRgbFailure({key:cameraScope,message:`${tr('RGB 媒体请求失败','RGB media request failed')}: ${rgb}`})}/>:<p className="lya-help lya-error" role={rgbFailed?'alert':undefined}>{rgbFailed?rgbFailure!.message:tr('Unavailable · 尚无相机采集','Unavailable · no camera capture yet')}</p>}
    </div>
   </figure>
   <figure className="lya-compare-figure" data-testid="compare-camera-depth" data-channel="camera-depth" data-available={sources.cameraDepth?'true':'false'}>
    <figcaption><strong>{tr('相机 Z 深度（米）','Camera Z-depth (m)')}</strong><span>{tr('沿光轴 Z · 与 RGB 同一次采集','axial Z · same capture as RGB')}</span></figcaption>
    <div className="lya-compare-thumb">
     {sources.cameraDepth?<NpyCanvas compact url={depthNpy} scopeKey={cameraScope} rule={CAMERA_DEPTH_COLOR_RULE} label={tr('相机沿光轴 Z 深度热图（米）','Camera axial Z depth heatmap (m)')} tr={tr}/>:<p className="lya-help">{comparisonCapture?.depthAvailable===false?tr('Unavailable · 这次采集没有深度通道','Unavailable · this capture has no depth channel'):tr('Unavailable · 缺件：尚无该来源的原生产物','Unavailable · missing: no native artifact for this source yet')}</p>}
    </div>
   </figure>
   <figure className="lya-compare-figure" data-testid="compare-lidar-range" data-channel="lidar-range" data-available={sources.lidarRange?'true':'false'}>
    <figcaption><strong>{tr('LiDAR 射线距离（米）','LiDAR ray range (m)')}</strong><span>{tr('沿射线欧氏 · 原生物理射线','Euclidean along ray · native physics rays')}</span></figcaption>
    <div className="lya-compare-thumb">
     {sources.lidarRange?<NpyCanvas compact url={rangeNpy} scopeKey={lidarScope} rule={LIDAR_RANGE_COLOR_RULE} spanM={lidarSpanM} label={tr('LiDAR 沿射线欧氏 range 热图（米）','LiDAR Euclidean range heatmap (m)')} tr={tr}/>:<p className="lya-help">{error?tr('Unavailable · 扫描失败，原因见下','Unavailable · scan failed; reason below'):tr('Unavailable · 缺件：尚无该来源的原生产物','Unavailable · missing: no native artifact for this source yet')}</p>}
    </div>
   </figure>
  </div>
  <div className="lya-compare-actions">
   <button type="button" className="lya-chip" data-testid="compare-refresh" disabled={!captureCamera||refreshBusy||busy} title={tr('重新采集同一次 RGB-D，不改变机位或草稿','Capture a fresh RGB-D from the same mount without changing the draft')} onClick={()=>perform(refreshCapture)}>{refreshBusy?tr('刷新中…','Refreshing…'):tr('刷新采集','Refresh')}</button>
   <button type="button" className="lya-chip lya-chip-accent" data-testid="compare-scan" disabled={!ready||!cameraName||busy||refreshBusy} title={!cameraName?tr('先选择真实机位','Select a real camera mount first'):tr('在此机位发射原生 LiDAR 射线','Cast native LiDAR rays at this mount')} onClick={()=>perform(scan)}>{busy?tr('正在发射原生射线…','Casting native rays…'):tr('扫描 LiDAR','Scan LiDAR')}</button>
  </div>
  {error&&<p className="lya-help lya-error" role="alert" style={{overflowWrap:'anywhere'}}>{error}</p>}
  <details data-testid="compare-settings">
   <summary>{tr('设置 / 详情','Settings / details')}</summary>
   <span className="lya-help" data-testid="frame-verdict" data-status={verdict.status} role={verdict.status==='same-frame'?'status':'note'} title={verdictText}>{verdict.status==='incomplete'?verdictText:verdictShort}{capturePinned?tr(' · 相机采集已钉住',' · camera capture pinned'):cameraReady?tr(' · 相机采集为当前直播',' · camera capture is live'):''}</span>
   <div className="lya-row" data-testid="scan-params"><label>{tr('波束数','Beams')}<input type="number" min={1} max={512} value={channels} onChange={event=>setChannels(event.target.value)} style={{width:64}}/></label><label>{tr('每圈方位采样','Azimuth samples')}<input type="number" min={1} max={4096} value={samples} onChange={event=>setSamples(event.target.value)} style={{width:72}}/></label><label>{tr('量程米','Range m')}<input type="number" min={0.001} step={0.1} value={rangeM} onChange={event=>setRangeM(event.target.value)} style={{width:72}}/></label><label>{tr('竖直视场 下 上','Vertical FOV low high')}<input value={vertical} onChange={event=>setVertical(event.target.value)} style={{width:88}}/></label></div>
   {visible&&<p className="lya-help" data-testid="compare-sensor-details">{tr('世界位姿','World pose')}：[{visible.worldFromSensor?.positionM?.map((value:number)=>Number(value).toFixed(4)).join(', ')}] · {visible.rayPattern?.channels}×{visible.rayPattern?.horizontalSamples} · hfov {visible.rayPattern?.horizontalFovDeg}° · vfov [{visible.rayPattern?.verticalFovDeg?.join(', ')}]° · {visible.rangeSemantics}<br/>{tr('相机对比口径：','Depth comparison: ')}{visible.cameraDepthComparison}<br/>{tr('几何来源：','Geometry source: ')}{visible.geometrySource} · {visible.selfExclusion} · {tr('传感器','sensor')} {visible.sensorId} · {tr('机身','body')} {visible.parentBodyName??'—'} · {tr('有效','valid')} {visible.validCount}/{visible.rayCount} · {tr('无返回','no-return')} {visible.noReturnCount}{visible.rangeMinM!=null?` · ${tr('范围','range')} ${Number(visible.rangeMinM).toFixed(3)}–${Number(visible.rangeMaxM).toFixed(3)} m（${tr('均值','mean')} ${Number(visible.rangeMeanM).toFixed(3)}）`:''}</p>}
   {comparisonCapture&&<p className="lya-help" data-testid="compare-capture-identity">captureId {comparisonCapture.captureId} · {comparisonCapture.cameraName??comparisonCapture.resolvedCameraName} · frame {comparisonCapture.frameId??'—'} · step {comparisonCapture.stepIndex??'—'} · g{comparisonCapture.worldGeneration??'—'} · rev {comparisonCapture.sceneRevision??'—'}{comparisonCapture.depthRangeM?` · depthRangeM ${comparisonCapture.depthRangeM[0]}–${comparisonCapture.depthRangeM[1]}`:''}</p>}
   <p className="lya-help">{tr('相机Depth 沿光轴 Z；LiDAR range 沿射线欧氏；两者单位相同但语义不同，不互相冒充。','Camera depth is axial Z; LiDAR range is Euclidean along the ray; same unit, different quantity.')}</p>
   <details data-testid="compare-data-downloads"><summary>{tr('Data / Downloads 详情','Data / Downloads details')}</summary>
    <p className="lya-help" data-testid="compare-frame-verdict-full" data-status={verdict.status}>{verdictText}</p>
    <p className="lya-help">{tr('RGB：相机原生 PNG；相机 Z 深度：沿光轴 Z 的米制 NPY；LiDAR range：沿射线欧氏米制 NPY（无返回独立颜色）。','RGB: native camera PNG; camera Z-depth: axial Z metre NPY; LiDAR range: Euclidean metre NPY along the ray (no-return has its own colour).')}</p>
    <div className="lya-row" style={{flexWrap:'wrap'}}>{rgb?<a href={rgb} download>{tr('下载原始 PNG','Download original PNG')}</a>:<span className="lya-help">{tr('RGB Unavailable','RGB Unavailable')}</span>}{depthNpy?<a href={depthNpy} download>{tr('下载原始深度 NPY','Download original depth NPY')}</a>:<span className="lya-help">{tr('Depth Unavailable','Depth Unavailable')}</span>}{rangeNpy?<><a href={rangeNpy} download>{tr('下载原始 range NPY','Download original range NPY')}</a>{validNpy&&<a href={validNpy} download>{tr('有效掩码','valid mask')}</a>}{hitGeomNpy&&<a href={hitGeomNpy} download>{tr('命中几何','hit geom')}</a>}{lidarPreview&&<a href={lidarPreview} target="_blank" rel="noreferrer">{tr('原生预览 PNG','native preview PNG')}</a>}</>:<span className="lya-help">{tr('LiDAR Unavailable','LiDAR Unavailable')}</span>}</div>
   </details>
  </details>
 </div>
 /**
  * V11-P21：overlay host 是父层 ref，**不能在 render 里读 `.current`**——首帧必为 null，之后 ref 赋值不触发本组件重渲染，
  * 于是 `overlayHost ? portal : hidden` 会长期走 hidden 分支，表现就是“点了 Compare channels 没反应”。
  * 用 state+effect 在挂载后取一次；取不到时给内联兜底，入口永远可达。
  */
 const [overlayHost,setOverlayHost]=useState<HTMLElement|null>(compareOverlayHost?.current??null)
 useEffect(()=>{setOverlayHost(compareOverlayHost?.current??null)},[compareOverlayHost])
 const compareOpenEntry=overlayHost?(compareOpen?createPortal(dialog,overlayHost):null):<div className="lya-compare-inline-host" hidden={!compareOpen} data-testid="lidar-compare-inline">{dialog}</div>
 return <>
  <style>{compareDialogStyle}</style>
  <div data-testid="lidar-compare" className="lya-compare-entry" data-camera={cameraName??''}>
   {/* V11-P20/21：同一栏里“录制该机位”才是唯一蓝色主按钮；三通道对照是次序要动作，不用主按钮样式抢位。 */}
   <button type="button" className="lya-compare-open" data-testid="camera-compare-open" aria-label={tr('RGB / 相机Depth / LiDAR 比较','RGB / camera Depth / LiDAR comparison')} title={tr('在画布内打开三通道对照','Open the three-channel comparison over the canvas')} onClick={()=>setCompareOpen(true)}>{tr('比较通道','Compare channels')}</button>
   {error?<p className="lya-help lya-error" role="alert" style={{overflowWrap:'anywhere'}}>{error}</p>:!cameraName?<p className="lya-help">{tr('先选择一台真实机位，再扫描它以获取 LiDAR 量测。','Select a real camera mount first, then scan it for a LiDAR measurement.')}</p>:!cameraReady?<p className="lya-help">{tr('尚无相机 RGB-D；可打开对照扫描 LiDAR，但 RGB/Depth 会诚实标 Unavailable。','No camera RGB-D yet; open the comparison to scan LiDAR, but RGB/Depth stay Unavailable.')}</p>:<p className="lya-help">{tr('RGB、相机 Z 深度与 LiDAR 射线距离来自同一次真实采集/扫描。','RGB, camera Z-depth and LiDAR range come from the same real capture/scan.')}</p>}
  </div>
  {compareOpenEntry}
 </>
}
