/**
 * V8-13：Robot Library 资源详情里的**只读**模型预览。
 *
 * 边界（刻意很窄，不复制原生 `packages/lyapunov-workspace/src/model-preview.tsx`）：
 *  · 宿主 RPC 复用既有 `POST /api/lyapunov/workspace {action:'model-preview',input:{path}}`；
 *  · 网格/材质字节复用既有 `GET /api/lyapunov/model-preview?sessionId=&path=`（支持 Range）；
 *  · 渲染复用产品自带 `createViewer` 与机器人装配路径；
 *  · 只合成一个 `sceneId:'lyapunov-model-preview'` 的**只读 SceneSnapshot** 交给 Viewer。
 *
 * 这里没有 SceneStore 写入、没有 `scene_mount`、没有 instances/selection/world/revision 变更；
 * 资源尚未加入场景也能看原件。关闭资源详情或换机型时 abort 请求并 dispose 这个 Viewer。
 */
import {useEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {createViewer,type SceneViewer} from '@lyapunov/viewer/client'
import {SCENE_COORDINATES,identityTransform,type Entity,type ResourceRef,type SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'
import type {Translate} from './entity-editor.tsx'

/** 宿主 `model-preview` 的最小响应面（与原生预览链同一契约）。 */
export interface RobotModelPreviewPayload {
  kind?:string
  reason?:string
  robot?:Record<string,unknown>
  error?:string
}
/** 读宿主预览 RPC；session 由调用方（workbench-api）绑定。 */
export type RobotPreviewRequest=(path:string,signal:AbortSignal)=>Promise<RobotModelPreviewPayload>
/** 原生字节路由：path 已过宿主同一份工作区/产品根校验。 */
export type RobotPreviewBytesURL=(path:string)=>string

const messageOf=(reason:unknown)=>String((reason as Error)?.message??reason)
const dirOf=(path:string)=>{const at=path.lastIndexOf('/');return at<0?'':path.slice(0,at)}
const nameOf=(path:string)=>path.split('/').pop()??path
/** 与工作区路径同构的 POSIX 拼接：处理 `./` 与 `../`。 */
function joinPath(dir:string,relative:string):string{
 const parts=dir?dir.split('/'):[]
 for(const part of relative.split('/')){
  if(!part||part==='.')continue
  if(part==='..'){parts.pop();continue}
  parts.push(part)
 }
 return parts.join('/')
}
/**
 * 把机器人文档里的引用映射回**真实文件路径**，再交给原生字节路由。
 * 与原生 `robotResolver` 同一条候选顺序；不认识的网络 scheme 明确拒绝，避免预览偷偷下载。
 */
export function robotPreviewResourcePath(uri:string,sourcePath:string,baseUri?:string):string{
 if(/^https?:/i.test(uri))throw Error(`预览不访问网络模型引用：${uri}`)
 const dir=dirOf(sourcePath)
 const candidates:string[]=[]
 if(/^file:/i.test(uri)){
  try{candidates.push(decodeURIComponent(new URL(uri).pathname))}catch{/* 非法 file: URL 落到相对候选 */}
 }
 if(!candidates.length){
  if(/^[a-z][a-z\d+.-]*:\/\//i.test(uri)){
   const parsed=new URL(uri)
   candidates.push(joinPath(dir,parsed.pathname),joinPath(dir,`${parsed.hostname}${parsed.pathname}`))
  }else if(uri.startsWith('/')){
   candidates.push(uri)
  }else{
   if(!/^(?:data:|blob:)/i.test(uri))candidates.push(joinPath(dir,uri))
   if(baseUri){
    try{candidates.push(decodeURIComponent(new URL(uri,baseUri).pathname))}catch{/* baseUri 不可用时只剩相对候选 */}
   }
   if(!candidates.length)candidates.push(uri)
  }
 }
 const candidate=candidates[0]
 if(!candidate)throw Error(`无法解析模型引用：${uri}`)
 if(/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)&&!/^file:/i.test(candidate))throw Error(`预览不访问网络模型引用：${uri}`)
 return candidate
}
/**
 * 与原生 `robotScene()` 同形的只读快照：一个资源、一份机器人视觉声明。
 * 身份固定为预览专用 id/revision，和用户当前 Scene 完全分开。
 */
export function robotPreviewScene(robot:Record<string,unknown>,name:string):SceneSnapshot{
 const representation={uri:name,mimeType:'model/mjcf',role:'visual'}
 const resource:ResourceRef={resourceId:'lyapunov-model-preview',version:1,original:representation,representations:[representation],source:{units:'m',upAxis:'Z',handedness:'right',metersPerUnit:1}}
 const entity:Entity={entityId:'lyapunov-model-preview',name,transform:identityTransform(),resources:[resource],components:{visual:{kind:'robot',robot}}}
 return{sceneId:'lyapunov-model-preview',revision:1,coordinates:SCENE_COORDINATES,entities:[entity]}
}

const style=`
.lya-robot-resource-preview{position:relative;display:flex;flex-direction:column;gap:4px;margin:2px 0 8px}
.lya-robot-resource-preview .lya-rrp-head{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);min-height:16px}
.lya-robot-resource-preview .lya-rrp-head strong{font-weight:600;color:var(--dsw-alias-label-primary)}
.lya-robot-resource-preview .lya-rrp-head .lya-spacer{flex:1}
.lya-robot-resource-preview .lya-rrp-stage{position:relative;height:220px;min-height:200px;border:1px solid var(--lya-line);border-radius:6px;overflow:hidden;background:radial-gradient(circle at 52% 44%,#29323c,#1a2129)}
.lya-robot-resource-preview .lya-rrp-stage canvas{display:block;width:100%;height:100%}
.lya-robot-resource-preview .lya-viewer-navigation{display:none!important}
.lya-robot-resource-preview .lya-rrp-hint{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:8px;text-align:center;font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary);background:inherit}
/* P13：随包官方预览图作为 stage 真图底衬——实时渲染就绪前/失败时它仍是真实资产，不是占位造图。 */
.lya-robot-resource-preview .lya-rrp-poster{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;padding:8px;box-sizing:border-box}
.lya-robot-resource-preview[data-status=ready] .lya-rrp-poster{display:none}
.lya-robot-resource-preview[data-poster] .lya-rrp-hint{background:none;justify-content:flex-end;align-items:stretch;text-align:left}
.lya-robot-resource-preview[data-poster] .lya-rrp-hint p{background:color-mix(in srgb,#10151b 82%,transparent);border-radius:4px;padding:3px 6px}
.lya-robot-resource-preview[data-poster] .lya-rrp-hint button{align-self:flex-start}
.lya-robot-resource-preview .lya-rrp-hint[data-status=ready]{display:none}
.lya-robot-resource-preview .lya-rrp-hint p{margin:0;max-height:72px;overflow:auto;overflow-wrap:anywhere}
.lya-robot-resource-preview .lya-rrp-hint button{font-size:11px;padding:2px 8px;min-height:24px}
.lya-robot-resource-preview[data-status=failed] .lya-rrp-stage{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--lya-line))}
`

/**
 * 真实模型预览：只读、可重试、可清理；不接收任何 Scene 写入回调。
 * @param path 库行真实 `modelPath`（不是 pack 图片猜测）
 * @param identity 仅作重新加载/清理归属（`modelSha256`），不参与渲染内容
 */
export function RobotResourcePreview({tr,path,identity,load,bytesURL,host,scopeKey,poster}:{
  tr:Translate
  path:string
  identity?:string
  load?:RobotPreviewRequest
  bytesURL?:RobotPreviewBytesURL
  /** 真实 Native 主画布宿主（Main Viewer 的兄弟）；缺省时保留右栏 220px 内联回退。 */
  host?:HTMLElement|null
  /** 当前 Session:Scene 座位；切 Scene/会话时清理本次 Viewer 与在途 abort。 */
  scopeKey?:string
  /** 随包官方预览位图（已复核的字节路由 URL）；实时预览就绪前/失败时如实显示，绝不拿它冒充渲染结果。 */
  poster?:string
}){
 const stage=useRef<HTMLDivElement|null>(null)
 const viewer=useRef<SceneViewer|null>(null)
 // 父层每次轮询都会换一个 `tr` 函数；预览只应随 path/identity 重载，语言用最新 ref 读。
 const trRef=useRef(tr);trRef.current=tr
 const [attempt,setAttempt]=useState(0)
 const [status,setStatus]=useState<'loading'|'ready'|'failed'>(path&&load&&bytesURL?'loading':'failed')
 const [error,setError]=useState('')
 const [detail,setDetail]=useState('')
 useEffect(()=>{
  const node=stage.current
  const abort=new AbortController()
  const previousFocus=typeof document!=='undefined'?document.activeElement as HTMLElement|null:null
  let disposed=false
  viewer.current?.dispose();viewer.current=null
  setDetail('')
  if(!path||!load||!bytesURL){
   setStatus('failed')
   setError(path?trRef.current('预览接口不可用。','Preview API is unavailable.'):trRef.current('模型原件未随包提供。','Model bytes are not bundled.'))
   return
  }
  if(!node){
   setStatus('failed')
   setError(trRef.current('预览容器尚未就绪。','Preview container is not ready.'))
   return
  }
  setStatus('loading');setError('')
  const start=async()=>{
   const payload=await load(path,abort.signal)
   if(disposed||abort.signal.aborted)return
   if(payload.kind==='unsupported')throw Error(payload.reason??trRef.current('宿主不支持这个模型。','The host does not support this model.'))
   if(payload.kind!=='robot'||!payload.robot)throw Error(payload.reason??trRef.current('宿主没有返回机器人预览。','The host did not return a robot preview.'))
   const robot=payload.robot,baseUri=typeof robot.baseUri==='string'?robot.baseUri:undefined
   const snapshot=robotPreviewScene(robot,nameOf(path))
   const instance=createViewer({
    container:node,
    translate:(zh,en)=>trRef.current(zh,en),
    resolveResource:uri=>bytesURL(robotPreviewResourcePath(uri,path,baseUri)),
    onError:reason=>{if(!disposed&&!abort.signal.aborted){setError(messageOf(reason));setStatus('failed')}},
   })
   viewer.current=instance
   // 缩略模型只做局部 Orbit 预览，不继承主视口的 Roam，也不改用户导航偏好。
   instance.setNavigationMode('orbit',false)
   instance.setDisplaySettings({grid:false,axes:false,background:'#1a2129'})
   await instance.setScene(snapshot)
   if(disposed||abort.signal.aborted)return
   // V10-13：资源未放置也要看清模型。预览只框机器人自身，不并入场外地面/未挂接手，也不写 Scene。
   try{instance.focus('lyapunov-model-preview')}catch{instance.openDefaultView()}
   // 输入归属：真实主画布宿主上把焦点交给预览 canvas；隐藏的主 Viewer canvas 仍是 tabIndex=-1，不参与 Tab。
   if(host){
    const canvas=node.querySelector('canvas') as HTMLCanvasElement|null
    if(canvas){canvas.tabIndex=0;try{canvas.focus({preventScroll:true})}catch{canvas.focus()}}
   }
   setDetail(`${robot.format==='urdf'?'URDF':'MJCF'} · ${trRef.current('只读预览 · 未加入场景','read-only · not placed')}`)
   setStatus(current=>current==='failed'?current:'ready')
  }
  void start().catch(reason=>{
   if(disposed||abort.signal.aborted)return
   setError(messageOf(reason));setStatus('failed')
  })
  return()=>{
   disposed=true;abort.abort()
   viewer.current?.dispose();viewer.current=null
   // 只恢复此前真实焦点；预览 canvas 已随 Viewer disposal 移除。
   if(previousFocus?.isConnected)try{previousFocus.focus({preventScroll:true})}catch{/* 焦点恢复不是预览成败判据 */}
  }
 },[path,identity,load,bytesURL,attempt,host,scopeKey])
 const section=<section className="lya-robot-resource-preview" data-testid="robot-resource-preview" data-status={status} data-model-sha={identity??''} data-poster={poster?'true':undefined} data-main-canvas-preview={host?'true':undefined} aria-label={tr('资源模型预览','Resource model preview')}>
  <style>{style}</style>
  <div className="lya-rrp-head"><strong>{tr('预览','Preview')}</strong><span className="lya-spacer"/><button type="button" className="lya-chip" data-testid="robot-resource-preview-frame" disabled={status!=='ready'} aria-label={tr('框选模型','Frame model')} title={tr('把资源模型框满预览区域','Frame the resource model in the preview')} onClick={()=>{try{viewer.current?.focus('lyapunov-model-preview')}catch{/* 预览已清理时不抢视图 */}}}>{tr('框选','Frame')}</button><span data-testid="robot-resource-preview-detail">{detail||tr('读取随包原件','reading bundled bytes')}</span></div>
  <div ref={stage} className="lya-rrp-stage" data-status={status}>
   {poster&&<img className="lya-rrp-poster" data-testid="robot-resource-preview-poster" src={poster} alt={tr('随包官方预览图','Bundled official preview')} onError={event=>{(event.target as HTMLImageElement).style.display='none'}}/>}
   {status!=='ready'&&<div className="lya-rrp-hint" data-status={status} role={status==='failed'?'alert':undefined}>
    {status==='failed'?<><p>{error||tr('模型没有渲染出来。','The model is not rendered.')}</p><button type="button" data-testid="robot-resource-preview-retry" onClick={()=>setAttempt(value=>value+1)}>{tr('重试','Retry')}</button></>:<p role="status">{tr('正在读取真实网格并渲染…','Reading real mesh bytes and rendering…')}</p>}
   </div>}
  </div>
 </section>
 // 只读资源 Viewer 挂到 Lyapunov 自有主画布宿主；没有宿主（测试/嵌入）保留 220px 内联回退。
 return host?createPortal(section,host):section
}
