import {useEffect,useRef} from 'react'
import type {Entity,SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'
import type {ReferenceInsert} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {formatFileMention} from '@deepseek-ai/dsh-file-reference/grammar'
export interface ViewerContextRequest {clientX:number;clientY:number;sceneId:string;sceneRevision:number;entityId:string;annotate:()=>void}
export type InsertViewerReference=(reference:ReferenceInsert)=>boolean
export function viewerEntityReferenceDocument(scene:SceneSnapshot,entityId:string){
 const entity=scene.entities.find(value=>value.entityId===entityId)
 if(!entity)throw Error('VIEWER_REFERENCE_ENTITY_MISSING')
 // 完整实体与资源声明是当前场景版本的权威快照，不能由显示名称推断源件。
 const ancestors:Entity[]=[],seen=new Set([entityId]);let parentId=entity.parentId
 while(parentId){if(seen.has(parentId))throw Error('VIEWER_REFERENCE_PARENT_CYCLE');seen.add(parentId);const parent=scene.entities.find(value=>value.entityId===parentId);if(!parent)throw Error('VIEWER_REFERENCE_PARENT_MISSING');ancestors.push(structuredClone(parent));parentId=parent.parentId}
 return {ancestors,resourceOwners:[entity,...ancestors].filter(value=>value.resources.length>0).map(value=>({entityId:value.entityId,resources:structuredClone(value.resources)})),schema:'lyapunov.scene-entity-reference.v1' ,sceneId:scene.sceneId,sceneRevision:scene.revision,coordinates:structuredClone(scene.coordinates),entity:structuredClone(entity) as Entity}
}
export async function writeViewerReference(sessionId:string,scene:SceneSnapshot,entityId:string,request:(action:string,input:unknown)=>Promise<any>){
 const document={sessionId,...viewerEntityReferenceDocument(scene,entityId)},path=`lyapunov-selection-${crypto.randomUUID()}.json`,content=JSON.stringify(document,null,2)+'\n'
 const written=await request('write',{path,content})
 if(written.path!==path||!written.version)throw Error('VIEWER_REFERENCE_WRITE_UNVERIFIED')
 const read=await request('read',{path})
 if(read.path!==path||read.version!==written.version||read.content!==content)throw Error('VIEWER_REFERENCE_READBACK_MISMATCH')
 const mention=formatFileMention({path,kind:'file'},false)
 if(!mention)throw Error('VIEWER_REFERENCE_PATH_UNSUPPORTED')
 return {source:'reference',ref:mention,label:document.entity.name,appearance:'file',clipboardText:mention} satisfies ReferenceInsert
}
export function ViewerContextMenu({request,tr,addToChat,annotate,close,busy=false}:{request:ViewerContextRequest;tr:(zh:string,en:string)=>string;addToChat:()=>void;annotate:()=>void;close:()=>void;busy?:boolean}){
 const root=useRef<HTMLDivElement>(null)
 useEffect(()=>{root.current?.querySelector<HTMLButtonElement>('button')?.focus();const down=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))close()};const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();close()}else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const buttons=[...root.current!.querySelectorAll<HTMLButtonElement>('button')];buttons[(buttons.indexOf(document.activeElement as HTMLButtonElement)+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus()}};document.addEventListener('pointerdown',down);document.addEventListener('keydown',key);return()=>{document.removeEventListener('pointerdown',down);document.removeEventListener('keydown',key)}},[close])
 return <div ref={root} role="menu" aria-label={tr('所选资产','Selected asset')} className="lya-viewer-context-menu" style={{position:'fixed',left:Math.max(8,Math.min(request.clientX,window.innerWidth-220)),top:Math.max(8,Math.min(request.clientY,window.innerHeight-110)),zIndex:1000,minWidth:200,padding:6,border:'1px solid var(--dsw-alias-border,#526170)',borderRadius:8,background:'var(--dsw-alias-bg-l1,#222)',boxShadow:'0 8px 28px #0006',display:'grid',gap:4}} onContextMenu={event=>event.preventDefault()}>
  <button type="button" role="menuitem" disabled={busy} onClick={addToChat} title={tr('将实体及其资源来源作为文件引用加入当前聊天草稿','Add the entity and resource provenance as a file reference to this chat draft')}>{tr('添加到聊天','Add to chat')}</button>
  <button type="button" role="menuitem" disabled={busy} onClick={annotate} title={tr('在当前命中表面创建批注','Create an annotation on the current hit surface')}>{tr('批注','Annotate')}</button>
 </div>
}
