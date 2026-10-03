import {useEffect,useRef,useState} from "react"
import type {Entity,SceneCommit,SceneSnapshot,ScenePatch} from "../../lyapunov-contracts/src/types.ts"
export type Translate=(cn:string,en:string)=>string
export interface NumericProps {label:string;value:number;set:(value:number)=>void;min?:number;max?:number;step?:number;disabled?:boolean}
export function NumericInput({label,value,set,min,max,step=.1,disabled}:NumericProps){
 const [text,setText]=useState(String(value)),focused=useRef(false)
 useEffect(()=>{if(!focused.current)setText(String(value))},[value])
 return <input type="number" aria-label={label} value={text} disabled={disabled} min={min} max={max} step={step} onFocus={()=>{focused.current=true}} onChange={event=>{const text=event.target.value;setText(text);if(text.trim()&&Number.isFinite(Number(text)))set(Number(text))}} onBlur={()=>{focused.current=false;setText(String(value))}}/>
}
export function NumberField(props:NumericProps){return <label>{props.label}<NumericInput {...props}/></label>}
interface Draft {sceneId:string;baseRevision:number;base:Entity;name:string;position:[number,number,number];quaternion:[number,number,number,number];scale:[number,number,number];parent:string;visible:boolean;dirty:boolean}
function createDraft(sceneId:string,revision:number,entity:Entity):Draft{return {sceneId,baseRevision:revision,base:structuredClone(entity),name:entity.name,position:[...entity.transform.position],quaternion:[...entity.transform.quaternion],scale:[...entity.transform.scale],parent:entity.parentId??"",visible:entity.components.visual?.visible!==false,dirty:false}}
export function EntityEditor({sceneId,revision,entity,entities,tr,commit}:{sceneId:string;revision:number;entity:Entity;entities:Entity[];tr:Translate;commit:(input:SceneCommit)=>Promise<SceneSnapshot>}){
 const key=sceneId+":"+entity.entityId,drafts=useRef(new Map<string,Draft>()),activeKey=useRef(key)
 const [draft,setDraft]=useState(()=>createDraft(sceneId,revision,entity)),[saving,setSaving]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("")
 const visible=useRef({key,sceneId,revision,entity});visible.current={key,sceneId,revision,entity}
 useEffect(()=>{
  if(activeKey.current!==key){activeKey.current=key;const cached=drafts.current.get(key);setDraft(cached?.dirty?cached:createDraft(sceneId,revision,entity));setError("");setNotice("");return}
  setDraft(current=>current.dirty?current:createDraft(sceneId,revision,entity))
 },[key,entity,revision])
 const edit=(changes:Partial<Draft>)=>{setNotice("");setDraft(current=>{const next={...current,...changes};next.dirty=next.name!==next.base.name||next.parent!==(next.base.parentId??"")||next.visible!==(next.base.components.visual?.visible!==false)||next.position.some((value,index)=>value!==next.base.transform.position[index])||next.quaternion.some((value,index)=>value!==next.base.transform.quaternion[index])||next.scale.some((value,index)=>value!==next.base.transform.scale[index]);drafts.current.set(key,next);return next})}
 const reload=()=>{const next=createDraft(sceneId,revision,entity);drafts.current.set(key,next);setDraft(next);setError("");setNotice("")}
 const descendant=(candidate:Entity)=>{let id=candidate.parentId;while(id){if(id===entity.entityId)return true;id=entities.find(value=>value.entityId===id)?.parentId}return false}
 const submit=async()=>{
  const pending=structuredClone(draft),patch:ScenePatch=[],changes:Record<string,unknown>={}
  if(pending.name!==pending.base.name)changes.name=pending.name
  if(pending.position.some((value,index)=>value!==pending.base.transform.position[index])||pending.quaternion.some((value,index)=>value!==pending.base.transform.quaternion[index])||pending.scale.some((value,index)=>value!==pending.base.transform.scale[index]))changes.transform={...pending.base.transform,position:pending.position,quaternion:pending.quaternion,scale:pending.scale}
  if(pending.visible!==(pending.base.components.visual?.visible!==false))changes.components={...pending.base.components,visual:{...pending.base.components.visual,visible:pending.visible}}
  if(Object.keys(changes).length)patch.push({op:"update",entityId:pending.base.entityId,changes})
  if(pending.parent!==(pending.base.parentId??""))patch.push({op:"reparent",entityId:pending.base.entityId,...pending.parent?{parentId:pending.parent}:{}})
  setSaving(true);setError("");setNotice("")
  try{
   // 版本来自这份草稿的起点；外部刷新永远不能把它改成最新 revision。
   const snapshot=await commit({sceneId:pending.sceneId,expectedRevision:pending.baseRevision,patch})
   const updated=snapshot.entities.find(value=>value.entityId===pending.base.entityId)
   if(updated){
    const current=visible.current,superseded=current.key===key&&current.revision>snapshot.revision
    const next=superseded?createDraft(current.sceneId,current.revision,current.entity):createDraft(snapshot.sceneId,snapshot.revision,updated)
    drafts.current.set(key,next)
    if(visible.current.key===key){setDraft(next);if(superseded)setNotice(tr("编辑已提交，场景随后又有更新；已显示当前版本。","Your edit was committed, then the scene changed again. Showing the current version."))}
   }
  }catch(value){if(visible.current.key===key)setError(tr("提交未成功，草稿已保留。 ","The draft was preserved. ")+(value instanceof Error?value.message:String(value)))}
  finally{setSaving(false)}
 }
 return <fieldset className="lya-property-editor"><legend>{tr("属性","Properties")}</legend>
  <label className="lya-field-label">{tr("名称","Name")}<input className="lya-entity-name" aria-label={tr("实体名称","Entity name")} value={draft.name} disabled={saving} onChange={event=>edit({name:event.target.value})}/></label>
  <div className="lya-values" style={{marginTop:7}}>{draft.position.map((value,index)=><NumberField key={key+index} label={["X m","Y m","Z m"][index]!} value={value} disabled={saving} step={.01} set={next=>edit({position:draft.position.map((value,i)=>i===index?next:value) as [number,number,number]})}/>)}</div>
  <details><summary>{tr('方向与比例','Orientation and scale')}</summary><div className="lya-values">{draft.quaternion.map((value,index)=><NumberField key={key+'q'+index} label={['Qx','Qy','Qz','Qw'][index]!} value={value} disabled={saving} step={.01} set={next=>edit({quaternion:draft.quaternion.map((value,i)=>i===index?next:value) as [number,number,number,number]})}/>)}</div><div className="lya-values">{draft.scale.map((value,index)=><NumberField key={key+'s'+index} label={['Scale X','Scale Y','Scale Z'][index]!} value={value} disabled={saving||Boolean(entity.components.mujoco||entity.components.isaac||entity.components.articulation)} step={.1} set={next=>edit({scale:draft.scale.map((value,i)=>i===index?next:value) as [number,number,number]})}/>)}</div></details>
  <div className="lya-row"><button type="button" disabled={saving} onClick={()=>{const [x,y,z,w]=draft.quaternion;edit({quaternion:[w,-z,y,-x]})}} title={tr("绕父坐标系 X 轴翻转 180°；保存后随场景保留。适用于没有上方向声明、显示颠倒的模型。","Rotate 180° around parent X. Save to keep the correction in the scene.")}>{tr("上下翻转","Flip upright")}</button></div>
  <select className="lya-wide" aria-label={tr("父实体","Parent entity")} value={draft.parent} disabled={saving} onChange={event=>edit({parent:event.target.value})} style={{marginTop:7}}><option value="">{tr("场景根","Scene root")}</option>{entities.filter(candidate=>candidate.entityId!==entity.entityId&&!descendant(candidate)).map(candidate=><option key={candidate.entityId} value={candidate.entityId}>{candidate.name}</option>)}</select>
  <label style={{marginTop:8}}><input type="checkbox" disabled={saving} checked={draft.visible} onChange={event=>edit({visible:event.target.checked})}/>{tr("显示实体","Visible")}</label>
  {draft.dirty&&revision!==draft.baseRevision&&<p className="lya-warning lya-help" data-testid="draft-revision-warning">{tr(`场景已更新到 rev ${revision}；这份草稿仍基于 rev ${draft.baseRevision}。`,`The scene is at rev ${revision}; this draft is based on rev ${draft.baseRevision}.`)}</p>}
  {error&&<p className="lya-error lya-help" role="alert">{error}</p>}
  {notice&&<p className="lya-help" role="status">{notice}</p>}
  <div className="lya-row" style={{marginTop:8}}><button className="lya-primary" disabled={saving||!draft.dirty} onClick={()=>void submit()}>{saving?tr("保存中…","Saving…"):tr("提交编辑","Apply edit")}</button><button disabled={saving} onClick={reload}>{tr("读取当前版本","Reload current")}</button></div>
  <p className="lya-help" data-testid="draft-base-revision">rev {draft.baseRevision} · {entity.resources.length} {tr("资源引用","resource references")}{draft.dirty?tr(" · 草稿未保存"," · Unsaved draft"):""}</p>
 </fieldset>
}
