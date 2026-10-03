/**
 * 3D 批注面板：一轮"在视口里点、在这里写"的最小闭环。
 *
 * 与相机面板里的像素点（SAM3 训练采样）区别：那里的点是给分割器当正样本用的、落在**一张图**上；
 * 这里的点锚在**实体局部坐标**上，换视角、转相机、移动实体都不走位，文字是给人/模型看的说明。
 *
 * 编辑框放在面板里而不是浮动在标记旁：批注模式下面板与视口同时可见（工具面板只遮画布右侧一条），
 * 贴着标记浮一个输入框会挡住用户正在观察的那块几何，也会把"点下一个点"变成"先关掉输入框"。
 */
import {useEffect,useRef} from "react"
import type {ViewerAnnotation} from "@lyapunov/viewer/client"
import type {Translate} from "./entity-editor.tsx"

/** 带批注的采集回执：真图 + 逐条编号/文字/锚点，交给模型的那一份就是它。 */
export interface AnnotatedCapture{index:number;annotationId:string;entityId:string;entity?:string;text:string;anchor:ViewerAnnotation["anchor"]}

export function AnnotationPanel({annotations,activeId,annotating,readOnly,replayActive,viewerVisible,entityName,onToggleMode,onSelect,onText,onRemove,onCapture,inject,onInject,prompt,captures,tr}:{
 annotations:ViewerAnnotation[]
 activeId?:string
 annotating:boolean
 readOnly:boolean
 replayActive:boolean
 viewerVisible:boolean
 entityName:(entityId:string)=>string|undefined
 onToggleMode:()=>void
 onSelect:(annotationId:string)=>void
 onText:(annotationId:string,text:string)=>void
 onRemove:(annotationId:string)=>void
 onCapture:()=>void
 /** 是否在截图后把说明直接投进当前对话。 */
 inject:boolean
 onInject:(value:boolean)=>void
 /** 上一次采集实际送出的说明全文（面板里可核对/复制）。 */
 prompt?:string
 captures:Array<{captureId:string;capturedAt:string;imageURL:string;annotations:AnnotatedCapture[]}>
 tr:Translate
}){
 const editor=useRef<HTMLTextAreaElement>(null)
 // 新点的批注应当**立刻可以打字**：不要求用户再点一次输入框；切换选中的批注同样把光标带过去。
 useEffect(()=>{if(activeId&&annotations.some(item=>item.annotationId===activeId))editor.current?.focus()},[activeId,annotations.length])
 const active=annotations.find(item=>item.annotationId===activeId)
 const blocked=readOnly||replayActive
 return <>
  <p className="lya-help">{tr("批注锚定在实体上：转相机、缩放、移动实体后标记仍在原处，不会跟着屏幕走。","Annotations are anchored to the entity: the marker stays in place when you orbit, zoom or move the entity — it never follows the screen.")}</p>
  <div className="lya-row">
   <button className={annotating?"lya-primary":undefined} disabled={blocked||!viewerVisible} aria-pressed={annotating} onClick={onToggleMode}>{annotating?tr("结束批注","Stop annotating"):tr("开始批注","Start annotating")}</button>
   <button disabled={blocked||!viewerVisible||annotations.length===0} onClick={onCapture}>{tr("截图并发给模型","Capture for the model")}</button>
  </div>
  {annotating&&!blocked&&<p className="lya-help lya-annotation-live">{tr("在视口里点一个物体表面即可落点；点已有标记可以改它的文字。","Click a surface in the viewport to drop a point; click an existing marker to edit its text.")}</p>}
  {blocked&&<p className="lya-help">{replayActive?tr("回放只读取录制帧，批注只读。","Replay reads recorded frames only; annotations are read-only."):tr("当前世界是只读投影，批注只读。","The current world is a read-only projection; annotations are read-only.")}</p>}
  {!viewerVisible&&<p className="lya-help">{tr("先重开 Viewer 才能在场景上落点。","Reopen the viewer to drop points on the scene.")}</p>}
  {annotations.length===0
   ?<p className="lya-help">{tr("还没有批注。","No annotations yet.")}</p>
   :<ol className="lya-annotation-list">{annotations.map(item=><li key={item.annotationId} data-active={item.annotationId===activeId||undefined} data-orphan={entityName(item.anchor.entityId)?undefined:true}>
     <button type="button" className="lya-annotation-pin" aria-label={tr(`第 ${item.index} 条批注`,`Annotation ${item.index}`)} onClick={()=>onSelect(item.annotationId)}>{item.index}</button>
     <div className="lya-annotation-body">
      <span className="lya-annotation-target" title={item.anchor.entityId}>{entityName(item.anchor.entityId)??tr("实体已不在当前场景","Entity is not in this scene")} · {item.anchor.local.map(value=>value.toFixed(2)).join(", ")} m</span>
      <textarea
       ref={item.annotationId===activeId?editor:undefined}
       className="lya-wide"
       aria-label={tr(`第 ${item.index} 条批注文字`,`Text of annotation ${item.index}`)}
       placeholder={tr("这条批注要说明什么？","What should this annotation say?")}
       rows={2}
       disabled={blocked}
       value={item.text}
       onChange={event=>onText(item.annotationId,event.target.value)}
       onFocus={()=>onSelect(item.annotationId)}
      />
     </div>
     <button type="button" className="lya-annotation-remove" disabled={blocked} aria-label={tr(`删除第 ${item.index} 条批注`,`Delete annotation ${item.index}`)} onClick={()=>onRemove(item.annotationId)}>×</button>
    </li>)}</ol>}
  {active&&<p className="lya-help">{tr(`世界坐标 ${active.anchor.world.map(value=>value.toFixed(2)).join(", ")} m（下单时刻）；渲染始终用实体局部坐标重算。`,`World ${active.anchor.world.map(value=>value.toFixed(2)).join(", ")} m at drop time; rendering always recomputes from the entity-local anchor.`)}</p>}
  {annotations.length>0&&<details><summary>{tr("将要发给模型的说明","Description handed to the model")}</summary>
   <p className="lya-help">{tr("每条批注的像素 xy、归一化 xy、所属实体与实体局部坐标，加一段相机位姿背景；点“截图并发给模型”时这份说明直接投进当前对话。","Per annotation: pixel xy, normalized xy, the entity and its local coordinates, plus one camera-pose background block. Capture injects this description straight into the conversation.")}</p>
   <label className="lya-help"><input type="checkbox" checked={inject} onChange={event=>onInject(event.target.checked)}/>{tr("截图后直接投进对话","Inject into the conversation right after capture")}</label>
   {prompt?<><textarea className="lya-wide" readOnly rows={8} value={prompt} aria-label={tr("批注说明全文","Full annotation description")}/><button onClick={()=>{void navigator.clipboard?.writeText(prompt)}}>{tr("复制说明","Copy description")}</button></>:<p className="lya-help">{tr("先截一次图，这里会显示实际送出的说明全文。","Capture once; the exact text sent will appear here.")}</p>}
  </details>}
  {captures.length>0&&<details open><summary>{tr("已发给模型的截图","Captures handed to the model")} ({captures.length})</summary>
   {captures.slice(0,4).map(item=><figure className="lya-annotation-shot" key={item.captureId}>
    <img src={item.imageURL} alt={tr("带编号批注的截图","Screenshot with numbered annotations")}/>
    <figcaption className="lya-help">{item.capturedAt} · {item.annotations.length} {tr("条批注","annotations")}</figcaption>
   </figure>)}
   <p className="lya-help">{tr("模型侧工具 viewer_annotation_read 能取回同一张图与逐条文字。","The model-side tool viewer_annotation_read returns the same image with the per-item text.")}</p>
  </details>}
 </>
}
