import type {Entity,SceneCommit,SceneSnapshot} from "../../lyapunov-contracts/src/types.ts"
import type {Translate} from "./entity-editor.tsx"

/** 当前文档的节点范围；只按实体身份/父子关系，不按名称或素材路径推断。 */
export function sceneSubtreeIds(scene:SceneSnapshot,entityId:string):string[]{
 if(!scene.entities.some(entity=>entity.entityId===entityId))throw new Error(`ENTITY_NOT_FOUND: ${entityId}`)
 const ids=new Set([entityId]);let changed=true
 while(changed){changed=false;for(const entity of scene.entities)if(entity.parentId&&ids.has(entity.parentId)&&!ids.has(entity.entityId)){ids.add(entity.entityId);changed=true}}
 return [...ids]
}
export function entityVisible(entity:Entity):boolean{return entity.components.visual?.visible!==false}
export function entityEffectivelyVisible(scene:SceneSnapshot,entity:Entity):boolean{
 const byId=new Map(scene.entities.map(value=>[value.entityId,value])),seen=new Set<string>()
 let current:Entity|undefined=entity
 while(current){if(seen.has(current.entityId)||!entityVisible(current))return false;seen.add(current.entityId);current=current.parentId?byId.get(current.parentId):undefined}
 return true
}
/** 库条目可能有多个版本/实例；当前场景里仍保留各自原版本，只控制这些实例根的显示。 */
export function assetSceneInstances(scene:SceneSnapshot|undefined,resourceId:string):Entity[]{
 if(!scene)return []
 const matches=scene.entities.filter(entity=>entity.resources.some(ref=>ref.resourceId===resourceId)),ids=new Set(matches.map(entity=>entity.entityId)),byId=new Map(scene.entities.map(entity=>[entity.entityId,entity]))
 return matches.filter(entity=>{let parent=entity.parentId;const seen=new Set<string>();while(parent&&!seen.has(parent)){if(ids.has(parent))return false;seen.add(parent);parent=byId.get(parent)?.parentId}return true})
}
export function visibilityCommit(scene:SceneSnapshot,entityId:string,visible:boolean):SceneCommit{
 const entity=scene.entities.find(value=>value.entityId===entityId)
 if(!entity)throw new Error(`ENTITY_NOT_FOUND: ${entityId}`)
 return {sceneId:scene.sceneId,expectedRevision:scene.revision,patch:[{op:"update",entityId,changes:{components:{...entity.components,visual:{...entity.components.visual,visible}}}}]}
}
export function removeSceneNodeCommit(scene:SceneSnapshot,entityId:string):SceneCommit{
 sceneSubtreeIds(scene,entityId)
 return {sceneId:scene.sceneId,expectedRevision:scene.revision,patch:[{op:"remove",entityId,cascade:true}]}
}

export function SceneNodeVisibility({entity,scene,disabled,onChange,tr}:{entity:Entity;scene:SceneSnapshot;disabled?:boolean;onChange:(visible:boolean)=>void;tr:Translate}){
 const visible=entityVisible(entity),inherited=visible&&!entityEffectivelyVisible(scene,entity)
 return <button type="button" className="lya-icon-button lya-node-visibility" aria-label={(visible?tr("隐藏节点 ","Hide node "):tr("显示节点 ","Show node "))+entity.name} aria-pressed={visible} disabled={disabled} title={inherited?tr("本节点设为显示，但上层节点已隐藏；先显示上层节点。","This node is shown locally but a parent is hidden. Show the parent first."):tr("仅控制显示；子节点随上层隐藏，模拟不会停止。","Display only. Children follow a hidden parent; simulation keeps running.")} onClick={()=>onChange(!visible)}>
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>{(!visible||inherited)&&<path d="m3 3 18 18"/>}</svg>
 </button>
}

export interface SceneRemovalTarget {sessionId:string;sceneId:string;revision:number;entityId:string;name:string;nodeCount:number}
export function SceneRemovalConfirmation({target,busy,error,tr,onConfirm,onCancel}:{target:SceneRemovalTarget;busy:boolean;error?:string;tr:Translate;onConfirm:()=>void;onCancel:()=>void}){
 return <div className="lya-modal" role="dialog" aria-modal="true" aria-label={tr("从场景移除","Remove from scene")}><div className="lya-floating-panel lya-inspector">
  <div className="lya-panel-title"><strong>{tr("从当前场景移除","Remove from current scene")}</strong><button type="button" disabled={busy} aria-label={tr("取消移除","Cancel removal")} onClick={onCancel}>×</button></div>
  <p>{tr(`移除「${target.name}」${target.nodeCount>1?`及其 ${target.nodeCount-1} 个子节点`:""}？`,`Remove “${target.name}”${target.nodeCount>1?` and its ${target.nodeCount-1} child nodes`:""}?`)}</p>
  <p className="lya-help">{tr("仅移除当前场景中的实例。素材库、原文件与其他会话保留，可从场景历史恢复。","Only the instance in the current scene is removed. Library assets, original files and other sessions remain. Scene history can restore it.")}</p>
  {error&&<p className="lya-error" role="alert">{error}</p>}
  <div className="lya-row"><button type="button" autoFocus disabled={busy} onClick={onCancel}>{tr("取消","Cancel")}</button><button type="button" className="lya-stop" disabled={busy} onClick={onConfirm}>{busy?tr("移除中…","Removing…"):tr("确认移除","Confirm removal")}</button></div>
 </div></div>
}
