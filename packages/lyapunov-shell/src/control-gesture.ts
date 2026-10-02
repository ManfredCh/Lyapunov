import type {CommandDisplayMetadata} from '@deepseek-ai/dsh-commands/types'
export type ControlGestureDisplay=Omit<CommandDisplayMetadata,'clientId'>
function controlDisplay(value:unknown):CommandDisplayMetadata|undefined {
 const v=value as CommandDisplayMetadata
 if(v?.kind!=='control-gesture'||!['update','final','stop'].includes(v.phase)||!Number.isSafeInteger(v.generation)||v.generation<0||!Number.isSafeInteger(v.sequence)||v.sequence<0||[v.clientId,v.gestureId,v.worldId,v.entityId,v.jointName].some(s=>typeof s!=='string'||!s||s.length>256||/[\u0000-\u001f]/u.test(s)))return
 return {kind:v.kind,clientId:v.clientId,gestureId:v.gestureId,worldId:v.worldId,generation:v.generation,entityId:v.entityId,jointName:v.jointName,phase:v.phase,sequence:v.sequence}
}
export function validateControlDisplay(value:unknown,name:string,input:any,selection:any,clientId:string):CommandDisplayMetadata|undefined {
 if(value===undefined)return
 const v=controlDisplay(value),action=input?.action
 if(!v||v.clientId!==clientId||!['joint_move','sim_stop'].includes(name)||selection?.worldId!==v.worldId||input?.worldId!==v.worldId)throw Error('INVALID_CONTROL_GESTURE_SCOPE')
 if(name==='joint_move'&&(v.phase!=='update'&&v.phase!=='final'||action?.kind!=='joint'||action.expectedGeneration!==v.generation||action.entityId!==v.entityId||action.jointNames?.length!==1||action.jointNames[0]!==v.jointName))throw Error('INVALID_CONTROL_GESTURE_SCOPE')
 if(name==='sim_stop'&&(v.phase!=='stop'||input.expectedGeneration!==v.generation||input.entityIds?.length!==1||input.entityIds[0]!==v.entityId))throw Error('INVALID_CONTROL_GESTURE_SCOPE')
 return v
}
export const controlGestureKey=(v:CommandDisplayMetadata)=>JSON.stringify([v.clientId,v.gestureId,v.worldId,v.generation,v.entityId,v.jointName])
export interface RegisteredControlOwner {clientId:string;facts:Readonly<Record<string,unknown>>;live:boolean}
/** 使用既有 Session 的窗口槽 / 在场事实；不会把请求中两份相同声明当作宿主事实。 */
export function validateRegisteredControlDisplay(value:unknown,name:string,input:unknown,selection:any,owner:RegisteredControlOwner|undefined,events:readonly any[]):CommandDisplayMetadata|undefined {
 if(value===undefined)return
 if(!owner?.live)throw Error('CONTROL_WINDOW_NOT_REGISTERED')
 const display=validateControlDisplay(value,name,input,selection,owner.clientId)!
 if(display.phase==='stop'){
  const accepted=events.some(event=>{const previous=controlDisplay(event.data?.display);return event.type==='command/run'&&event.data.name==='joint_move'&&previous&&previous.sequence<display.sequence&&controlGestureKey(previous)===controlGestureKey(display)})
  // Stop 本身仍由原 sim_stop 处理；没有真实手势 run 就不把它挂到请求声称的卡上。
  if(!accepted)return
 }else if(owner.facts.sceneId!==selection?.sceneId||owner.facts.entityId!==display.entityId||owner.facts.worldId!==display.worldId||owner.facts.expectedGeneration!==display.generation||owner.facts.sceneRevision!==owner.facts.appliedSceneRevision){
  throw Error('CONTROL_SELECTION_CHANGED')
 }
 return display
}
/** 同一手势更新原位置；新动作才插入最近动作列表。 */
export function upsertControlActionRow<T extends {id:string}>(rows:readonly T[],next:T,max=8):T[]{
 return rows.some(row=>row.id===next.id)?rows.map(row=>row.id===next.id?next:row):[next,...rows].slice(0,max)
}
/** Existing Session command events remain the only history owner. */
export function projectControlActionRows(events:readonly any[],face:(receipt:unknown,name?:string)=>unknown,error:(value:unknown)=>unknown){
 const done=new Map(events.filter(e=>e.type==='command/done').map(e=>[e.data.commandId,e])),groups=new Map<string,any>()
 for(const event of events){
  if(event.type!=='command/run'||!['robot_move','sim_execute_batch','vehicle_drive','joint_move','robot_gripper','sim_stop'].includes(event.data.name))continue
  const display=controlDisplay(event.data.display)
  if(event.data.name==='sim_stop'&&!display)continue
  const settled=done.get(event.data.commandId),key=display?'gesture:'+controlGestureKey(display):event.data.commandId
  let actionId:unknown;if(!display)try{actionId=JSON.parse(event.data.args??'{}')?.action?.actionId}catch{}
  let receipt:unknown;if(settled?.data.kind==='success')try{receipt=JSON.parse(settled.data.text)}catch{}
  const row={id:display?key:typeof actionId==='string'?actionId:key,label:display?'joint_move':event.data.name,waiting:!settled,...display?{display}:{},...receipt!==undefined?{receipt:face(receipt,event.data.name)}:{},...settled?.data.kind==='error'?{error:error(settled.data.text)}:{}}
  const old=groups.get(key),history=old?.history??[]
  history.push({commandId:event.data.commandId,phase:display?.phase??'final',waiting:row.waiting,...row.receipt?{receipt:row.receipt}:{},...row.error?{error:row.error}:{}})
  if(!old||!display||display.sequence>=(old.display?.sequence??-1))groups.set(key,{...row,history})
 }
 return [...groups.values()].slice(-8).reverse()
}
