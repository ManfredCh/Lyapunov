/**
 * Notes：画布底部的一条紧凑浮条（RC v4 R-007 / 用户批注 6、14、15、16）。
 *
 * 与旧版"右侧整列教程 + 多个编辑器 + Start annotating/Capture for the model 大按钮"的区别：
 * - 只占画布底部一行：没有选中标记时给一句短状态；有标记时只放当前正文输入与发送/更多/结束小图标。
 * - 列表、世界/局部坐标、历史截图与"将要发给模型的说明"都收进按需打开的具名小菜单，默认不铺开。
 * - 标记本身是与三维视口、截图同源的 SVG 图形（圆弧 + 短圆角矩形尾部，见 viewer 的 annotations.ts）。
 *
 * 组件不持有第二份批注状态：文字、选中、删除、发送都走既有回调，由 workbench 的唯一 annotations
 * 持有者落盘与提交。
 */
import {useEffect,useRef,useState} from "react"
import type {KeyboardEvent} from "react"
import type {ViewerAnnotation} from "@lyapunov/viewer/client"
import type {Translate} from "./entity-editor.tsx"
import {WorkbenchIcon} from "./vendor/tabler/icons.tsx"

/** 带批注的采集回执：真图 + 逐条编号/文字/锚点，交给模型的那一份就是它。 */
export interface AnnotatedCapture{index:number;annotationId:string;entityId:string;entity?:string;text:string;anchor:ViewerAnnotation["anchor"]}

/** 浮条上用到的小图标；都是 24 网格、1.7 线宽的原生 SVG，与 Tabler 主稿同一套几何。 */
function NotesIcon({name,size=16}:{name:"send"|"trash"|"list"|"more"|"close";size?:number}){
 const common={width:size,height:size,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:1.7,strokeLinecap:"round" as const,strokeLinejoin:"round" as const,focusable:"false" as const,"aria-hidden":true}
 switch(name){
  case "send":return <svg {...common}><path d="M10 14l11 -11"/><path d="M21 3l-6.5 18a.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a.55 .55 0 0 1 0 -1l18 -6.5"/></svg>
  case "trash":return <svg {...common}><path d="M4 7l16 0"/><path d="M10 11l0 6"/><path d="M14 11l0 6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"/><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"/></svg>
  case "list":return <svg {...common}><path d="M9 6l11 0"/><path d="M9 12l11 0"/><path d="M9 18l11 0"/><path d="M5 6l0 .01"/><path d="M5 12l0 .01"/><path d="M5 18l0 .01"/></svg>
  // 与设计稿 notes-edit 对齐：更多选项是三点（⋯），不是清单图标。
  case "more":return <svg {...common}><path d="M5 12l0 .01"/><path d="M12 12l0 .01"/><path d="M19 12l0 .01"/></svg>
  case "close":return <svg {...common}><path d="M18 6l-12 12"/><path d="M6 6l12 12"/></svg>
 }
}

export function AnnotationPanel({annotations,activeId,annotating,readOnly,replayActive,viewerVisible,sceneReady,hasEntities,entityName,sceneId,focusRequest,onToggleMode,onSelect,onText,onRemove,onCapture,inject,onInject,prompt,captures,tr}:{
 annotations:ViewerAnnotation[]
 activeId?:string
 annotating:boolean
 readOnly:boolean
 replayActive:boolean
 viewerVisible:boolean
 /** 是否已有场景；没有场景时给"先建/开场景"的短状态，不制造假锚点。 */
 sceneReady:boolean
 /** 场景里是否有可落点的实体；空场景也照实说。 */
 hasEntities:boolean
 entityName:(entityId:string)=>string|undefined
 /** 当前批注所属场景；焦点请求只在身份一致时生效。 */
 sceneId?:string
 /**
  * 明确的正文编辑焦点请求（workbench 每次落点/选标记各发一次，带自增 token）。
  * 不用"activeId 变了"当副作用：同一条标记 blur 后再点，activeId 不变也必须重新聚焦；
  * 删除/切工具/换场景后还没消费的迟到请求在此身份不符时自然失效，不去抢 Chat/文件/终端。
  */
 focusRequest?:{annotationId:string;sceneId?:string;token:number}
 onToggleMode:()=>void
 onSelect:(annotationId:string)=>void
 onText:(annotationId:string,text:string)=>void
 onRemove:(annotationId:string)=>void
 onCapture:()=>void|Promise<unknown>
 /** 是否在截图后把说明直接投进当前对话。 */
 inject:boolean
 onInject:(value:boolean)=>void
 /** 上一次采集实际送出的说明全文（菜单里可核对/复制）。 */
 prompt?:string
 captures:Array<{captureId:string;capturedAt:string;imageURL:string;annotations:AnnotatedCapture[]}>
 tr:Translate
}){
 const editor=useRef<HTMLTextAreaElement>(null)
 const more=useRef<HTMLDetailsElement>(null)
  const endControl=useRef<HTMLButtonElement>(null)
  const [removalFocusRequest,setRemovalFocusRequest]=useState(0)
 const consumedFocusToken=useRef<number>()
 const [sending,setSending]=useState(false)
 // 每个显式请求只消费一次；批注增删/重渲染不能重放旧请求抢回键盘焦点。
 useEffect(()=>{
  if(!focusRequest||focusRequest.token===consumedFocusToken.current)return
  consumedFocusToken.current=focusRequest.token
  if(focusRequest.annotationId!==activeId)return
  if(focusRequest.sceneId!==undefined&&focusRequest.sceneId!==sceneId)return
  if(!annotations.some(item=>item.annotationId===activeId))return
  editor.current?.focus()
 },[focusRequest,activeId,annotations.length,sceneId])
 const active=annotations.find(item=>item.annotationId===activeId)
 const blocked=readOnly||replayActive
 const closeMore=()=>{if(more.current)more.current.open=false}
 const select=(annotationId:string)=>{onSelect(annotationId);closeMore()}
 const remove=(annotationId:string)=>{
  onRemove(annotationId)
  closeMore()
  setRemovalFocusRequest(value=>value+1)
 }
 // 删除可能让编辑栏改为空态并重新挂载控件；等本次提交后再取仍可见的焦点目标。
 // 仅由删除动作触发一次，列表更新或其他重渲染不重放这次焦点恢复。
 useEffect(()=>{
  if(removalFocusRequest===0)return
  const menu=more.current
  if(menu)menu.open=false
  ;(menu?.querySelector("summary")??endControl.current)?.focus()
 },[removalFocusRequest])
 const send=async()=>{
  if(sending)return
  setSending(true)
  try{await onCapture()}catch{/* workbench 的 perform 已把具体原因写进状态栏；草稿仍由 annotations 持有 */}
  finally{setSending(false)}
 }
 /** 输入法组合期间的回车是选字，不是提交；Escape 只收起焦点，不丢草稿、不冒泡到原生对话。 */
 const onKeyDown=(event:KeyboardEvent<HTMLTextAreaElement>)=>{
  if(event.key==="Escape"){
    if(event.nativeEvent.isComposing)return
    event.preventDefault();event.stopPropagation();event.nativeEvent.stopImmediatePropagation?.();editor.current?.blur();return
   }
  if(event.key==="Enter"&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();editor.current?.blur()}
 }
 const hint=(()=>{
  if(replayActive)return tr("回放中的批注为只读。","Replay notes are read-only.")
  if(readOnly)return tr("只读世界中的批注为只读。","Notes are read-only in this world.")
  if(!viewerVisible)return tr("Viewer 已关闭。","Viewer is closed.")
  if(!sceneReady)return tr("先创建或打开场景。","Create or open a scene first.")
  if(!hasEntities)return tr("添加物体以留下批注。","Add an object to leave a note.")
  if(!active)return annotations.length?tr("选择批注或物体表面。","Select a note or a surface."):tr("点击物体表面以留下批注。","Click a surface to leave a note.")
  return undefined
 })()
 // 菜单里保留旧版按需内容：逐条列表、坐标、将发给模型的说明、历史截图。默认全部收起。
 const moreMenu=(<details className="lya-notes-more" ref={more}>
  <summary aria-label={tr("更多批注选项","More note options")} title={tr("列表、坐标、说明与截图","List, coordinates, description and captures")}><NotesIcon name="more" size={15}/></summary>
  <div className="lya-notes-menu">
   {annotations.length>0&&<div className="lya-notes-section">
    <strong>{tr(`批注（${annotations.length}）`,`Notes (${annotations.length})`)}</strong>
    <ol className="lya-annotation-list">
     {annotations.map(item=><li key={item.annotationId} data-active={item.annotationId===activeId||undefined} data-orphan={entityName(item.anchor.entityId)?undefined:true}>
      <button type="button" className="lya-annotation-pin" aria-label={tr(`编辑第 ${item.index} 条批注`,`Edit annotation ${item.index}`)} onClick={()=>select(item.annotationId)}>{item.index}</button>
      <div className="lya-annotation-body">
       <span className="lya-annotation-target" title={item.anchor.entityId}>{entityName(item.anchor.entityId)??tr("实体已不在当前场景","Entity is not in this scene")}{item.text.trim()?` · ${item.text.trim().slice(0,32)}`:""}</span>
      </div>
      <button type="button" className="lya-annotation-remove" disabled={blocked} aria-label={tr(`删除第 ${item.index} 条批注`,`Delete annotation ${item.index}`)} onClick={()=>remove(item.annotationId)}>×</button>
     </li>)}
    </ol>
   </div>}
   {active&&<div className="lya-notes-section">
    <strong>{tr("坐标","Coordinates")}</strong>
    <p className="lya-help">{tr(`世界坐标 ${active.anchor.world.map(value=>value.toFixed(2)).join(", ")} m（下单时刻）；渲染始终用实体局部坐标重算。`,`World ${active.anchor.world.map(value=>value.toFixed(2)).join(", ")} m at drop time; rendering always recomputes from the entity-local anchor.`)}</p>
   </div>}
   <div className="lya-notes-section">
    <label className="lya-help"><input type="checkbox" checked={inject} disabled={blocked} onChange={event=>onInject(event.target.checked)}/>{tr("截图后直接投进对话","Inject into the conversation right after capture")}</label>
    <p className="lya-help">{tr("每条批注的像素 xy、归一化 xy、所属实体与实体局部坐标，加一段相机位姿背景；只在你按发送时交给模型。","Per annotation: pixel xy, normalized xy, the entity and its local coordinates, plus one camera-pose background block. It reaches the model only when you press Send.")}</p>
    {prompt?<><textarea className="lya-wide" readOnly rows={6} value={prompt} aria-label={tr("批注说明全文","Full annotation description")}/><button type="button" onClick={()=>{void navigator.clipboard?.writeText(prompt)}}>{tr("复制说明","Copy description")}</button></>:<p className="lya-help">{tr("发送一次后，这里会显示实际送出的说明全文。","After one send, the exact text sent appears here.")}</p>}
   </div>
   {captures.length>0&&<div className="lya-notes-section">
    <strong>{tr(`截图（${captures.length}）`,`Captures (${captures.length})`)}</strong>
    {captures.slice(0,4).map(item=><figure className="lya-annotation-shot" key={item.captureId}>
     <img src={item.imageURL} alt={tr("带批注标记的截图","Screenshot with annotation markers")}/>
     <figcaption className="lya-help">{item.capturedAt} · {item.annotations.length} {tr("条批注","annotations")}</figcaption>
    </figure>)}
    <p className="lya-help">{tr("模型侧工具 viewer_annotation_read 能取回同一张图与逐条文字。","The model-side tool viewer_annotation_read returns the same image with the per-item text.")}</p>
   </div>}
  </div>
 </details>)
 const endButton=<button ref={endControl} type="button" className="lya-notes-icon" aria-label={tr("结束批注","End notes")} title={tr("结束批注（已写内容保留）","End notes (what you wrote is kept)")} onClick={onToggleMode}><NotesIcon name="close" size={15}/></button>
 // 注入开关决定这次是"发送给模型"还是"只保存"：措辞与实际行为一致（图标按钮的可读名在 aria-label/title），不把仅保存说成已发送。
 const sendAria=inject?tr("发送截图与说明给模型","Send capture and description to the model"):tr("保存截图与说明","Save capture and description")
 const sendTitle=inject?tr("把带标记的截图与坐标说明交给模型","Hand the marked screenshot and coordinates to the model"):tr("保存带标记的截图与坐标说明","Save the marked screenshot and coordinates")
 return <div className="lya-notes-bar" role="region" aria-label={tr("批注浮条","Notes bar")} data-active={Boolean(active)||undefined} onKeyDown={event=>{
  event.stopPropagation()
  if(event.key==="Escape"&&!event.nativeEvent.isComposing&&more.current?.open){
   event.preventDefault();closeMore();more.current.querySelector("summary")?.focus()
  }
 }} onKeyUp={event=>event.stopPropagation()}>
  <span className="lya-notes-mark" aria-hidden="true"><WorkbenchIcon id="annotation" size={16}/></span>
  {hint?<span className="lya-notes-hint" data-state={blocked?"blocked":!viewerVisible?"closed":undefined} role="status">{hint}</span>
  :active?<>
   <textarea ref={editor} className="lya-notes-input" rows={1} aria-label={tr(`第 ${active.index} 条批注文字`,`Text of note ${active.index}`)} title={tr("Enter 提交并收起，Shift+Enter 换行，Escape 收起不丢草稿","Enter commits and dismisses, Shift+Enter adds a line break, Escape dismisses without losing the draft")} placeholder={tr("这条批注要说明什么？","What should this note say?")} value={active.text} disabled={blocked} onKeyDown={onKeyDown} onChange={event=>onText(active.annotationId,event.target.value)} onFocus={()=>onSelect(active.annotationId)}/>
   <div className="lya-notes-actions">
    {/* 与设计稿 notes-edit 对齐：发送是图标按钮（纸飞机），不再用白底带字主按钮；文字含义放进 aria-label/title。 */}
    <button type="button" className="lya-notes-send" disabled={blocked||sending} aria-label={sendAria} title={sendTitle} onClick={()=>void send()}>{sending?"…":<NotesIcon name="send" size={15}/>}</button>
    {moreMenu}
    {endButton}
   </div>
  </>:<div className="lya-notes-actions">{annotations.length>0&&moreMenu}{endButton}</div>}
  {hint&&<div className="lya-notes-actions">{(annotations.length>0||captures.length>0)&&moreMenu}{endButton}</div>}
 </div>
}
