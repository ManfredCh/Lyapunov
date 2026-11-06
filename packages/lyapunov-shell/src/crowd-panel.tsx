/**
 * 右侧「人群」面板：创建/世界状态/分组列表/全部控制。
 * 所有按钮走既有 crowd_* 与同步 command——与 Agent 工具调用同一条 operation，不新增状态机或轮询。
 * 人群行为的运动学预设由 crowd_configure.preset 生成；不提供跑步预设（Run clip 未经接地/步幅校准）。
 */
import { useState } from 'react'
import { HumanCrowdCreate } from './human-crowd-panel.tsx'
import type { Entity, Frame, SceneSnapshot, WorldHandle } from '../../lyapunov-contracts/src/types.ts'
type Props={scene:SceneSnapshot;world?:WorldHandle;frame?:Frame;disabled:boolean;command(name:string,input:unknown):Promise<unknown>;onSaved(snapshot:SceneSnapshot):void;sync():Promise<unknown>;chooseFile?():Promise<string|undefined>;tr(zh:string,en:string):string}
const PRESETS=[{kind:'back-and-forth',zh:'来回走',en:'Back and forth'},{kind:'square-loop',zh:'绕圈（方块）',en:'Square loop'},{kind:'idle',zh:'原地站立',en:'Stand in place'}] as const
type PresetKind=typeof PRESETS[number]['kind']
export function CrowdPanel({scene,world,frame,disabled,command,onSaved,sync,chooseFile,tr}:Props){
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[duration,setDuration]=useState('60'),[preset,setPreset]=useState<Record<string,PresetKind>>({}),[distance,setDistance]=useState<Record<string,string>>({})
 // crowd_start 要等整段动作结束才返回：开始/停止不走全局 busy，只按作用范围记 pending，
 // 同范围重复「开始」禁用并显示“运行中…”，其它组/停止照常可用。busy 仅留给写 Scene 的操作。
 const [pending,setPending]=useState<ReadonlySet<string>>(new Set())
 const runStart=(key:string,fn:()=>Promise<unknown>)=>{if(pending.has(key))return;setPending(s=>new Set(s).add(key));setMessage('');void fn().then(value=>{const v=value as {text?:string;status?:string};setMessage(tr(`「${key==='all'?'全部':key}」动作已结束：${v?.status??'completed'}`,`Action on "${key==='all'?'all':key}" ended: ${v?.status??'completed'}`))}).catch(error=>setMessage(String(error))).finally(()=>setPending(s=>{const n=new Set(s);n.delete(key);return n}))}
 const run=async(fn:()=>Promise<unknown>,format?:(value:unknown)=>string)=>{setBusy(true);setMessage('');try{const value=await fn()as {snapshot?:SceneSnapshot;status?:string;error?:string};if(value?.snapshot){onSaved(value.snapshot);setMessage(tr('已保存；请同步到物理世界后生效。','Saved; synchronize the physics world for it to take effect.'))}else setMessage(format?.(value)??tr('操作已返回，请查看物理状态与回执。','Operation returned; inspect the physical state and receipt.'))}catch(error){setMessage(String(error))}finally{setBusy(false)}}
 const people=scene.entities.filter(e=>e.components.human)
 const groupIds=[...new Set(people.map(e=>(e.components.humanGroup as {groupId?:string}|undefined)?.groupId).filter((g):g is string=>Boolean(g)))]
 const rows:Array<{key:string;name:string;members:Entity[];scope:{groupId?:string;entityIds?:string[]}}>=[
  ...groupIds.map(groupId=>{const members=people.filter(e=>(e.components.humanGroup as {groupId?:string})?.groupId===groupId);const groupEntity=scene.entities.find(e=>!e.components.human&&(e.components.humanGroup as {groupId?:string}|undefined)?.groupId===groupId);return{key:groupId,name:groupEntity?.name??groupId,members,scope:{groupId}}}),
  ...(people.some(e=>!(e.components.humanGroup as {groupId?:string}|undefined)?.groupId)?[{key:'ungrouped',name:tr('其他人物','Other people'),members:people.filter(e=>!(e.components.humanGroup as {groupId?:string}|undefined)?.groupId),scope:{entityIds:people.filter(e=>!(e.components.humanGroup as {groupId?:string}|undefined)?.groupId).map(e=>e.entityId)}}]:[]),
 ]
 const frameOk=frame&&world&&frame.worldId===world.worldId&&frame.generation===world.worldGeneration&&frame.sceneRevision===scene.revision
 const counts=(members:Entity[])=>{if(!frameOk)return tr('（无当前物理帧）',' (no current frame)');let walk=0,blocked=0,still=0;for(const m of members){const motion=frame!.entities.find(e=>e.entityId===m.entityId)?.humanPose?.motion;if(!motion){still++;continue}if(motion.blockedByGeom!==undefined&&motion.blockedByGeom!==null||motion.blockedS)blocked++;else if(motion.behavior==='walk'||motion.behavior==='run')walk++;else still++}return tr(`（行走 ${walk} · 停障 ${blocked} · 停止 ${still}）`,` (walking ${walk} · blocked ${blocked} · stopped ${still})`)}
 const synced=Boolean(world&&world.appliedSceneRevision===scene.revision)
 const ready=Boolean(world&&['mujoco','isaac'].includes(world.engineId)&&synced&&['ready','running','paused'].includes(world.status))
 const readyReason=!world?tr('没有物理世界','No physics world'):!['mujoco','isaac'].includes(world.engineId)?tr('当前引擎不支持人群物理','Current engine does not support crowd physics'):!synced?tr('场景未同步到物理世界','Scene is not synchronized to the physics world'):!['ready','running','paused'].includes(world.status)?tr(`世界状态为 ${world.status}，不能开始`,`World status is ${world.status}; cannot start`):''
 const scopeBase={sceneId:scene.sceneId}
 const start=(key:string,scope:{groupId?:string;entityIds?:string[]},durationS:number)=>runStart(key,()=>command('crowd_start',{...scopeBase,...scope,worldId:world!.worldId,expectedGeneration:world!.worldGeneration,durationS}))
 const stop=(scope:{groupId?:string;entityIds?:string[]})=>run(()=>command('crowd_stop',{...scopeBase,...scope,worldId:world!.worldId,expectedGeneration:world!.worldGeneration}),value=>{const v=value as {affectedEntityIds?:string[];alreadyIdleEntityIds?:string[]};return tr(`已停止 ${v?.affectedEntityIds?.length??0} 人，另有 ${v?.alreadyIdleEntityIds?.length??0} 人本来未在运动`,`Stopped ${v?.affectedEntityIds?.length??0}; another ${v?.alreadyIdleEntityIds?.length??0} were not moving`)})
 const applyPreset=(key:string,scope:{groupId?:string;entityIds?:string[]})=>run(()=>command('crowd_configure',{...scopeBase,...scope,expectedRevision:scene.revision,preset:{kind:preset[key]??'back-and-forth',distanceM:Number(distance[key]??'2')}}))
 return <div data-testid="crowd-panel">
  <details className="lya-advanced" data-testid="crowd-create" open><summary>{tr('创建或导入人体','Create or import people')}</summary><HumanCrowdCreate scene={scene} disabled={disabled} command={command} onSaved={onSaved} chooseFile={chooseFile} tr={tr}/></details>
  <div className="lya-row" data-testid="crowd-world-status"><span className="lya-help">{world?synced?tr(`物理世界已同步（rev ${scene.revision} · ${world.status}）`,`Physics world synced (rev ${scene.revision} · ${world.status})`):tr('场景尚未同步到物理世界','Scene is not yet synchronized to the physics world'):tr('还没有物理世界','No physics world yet')}</span>{(!world||!synced)&&<button type="button" disabled={disabled||busy} onClick={()=>void run(sync)}>{tr('同步物理世界','Synchronize physics')}</button>}</div>
  {rows.map(row=><div key={row.key} className="lya-list" data-testid={`crowd-group-${row.key}`}>
   <div className="lya-row"><strong>{row.name}</strong><span className="lya-help">{tr(`${row.members.length} 人`,`${row.members.length} people`)}{counts(row.members)}</span></div>
   <div className="lya-row"><button type="button" disabled={disabled||!ready||pending.has(row.key)} title={ready?'':readyReason} onClick={()=>start(row.key,row.scope,Number(duration))}>{pending.has(row.key)?tr('运行中…','Running…'):tr('开始','Start')}</button><button type="button" disabled={disabled||!ready} title={ready?'':readyReason} onClick={()=>void stop(row.scope)}>{tr('停止','Stop')}</button></div>
   <div className="lya-row"><label>{tr('行为','Behavior')}<select aria-label={tr('行为','Behavior')} value={preset[row.key]??'back-and-forth'} disabled={disabled||busy} onChange={e=>setPreset(v=>({...v,[row.key]:e.target.value as PresetKind}))}>{PRESETS.map(p=><option key={p.kind} value={p.kind}>{tr(p.zh,p.en)}</option>)}</select></label><label>{tr('距离（米）','Distance (m)')}<input type="number" min=".5" max="20" step=".5" value={distance[row.key]??'2'} disabled={disabled||busy} onChange={e=>setDistance(v=>({...v,[row.key]:e.target.value}))}/></label><button type="button" disabled={disabled||busy} onClick={()=>void applyPreset(row.key,row.scope)}>{tr('应用','Apply')}</button></div>
  </div>)}
  {people.length>0&&<div data-testid="crowd-all">
   <label className="lya-field-label">{tr('持续秒数','Duration in seconds')}<input type="number" min=".01" max="300" value={duration} onChange={e=>setDuration(e.target.value)}/></label>
   <div className="lya-row"><button type="button" disabled={disabled||!ready||pending.has('all')} title={ready?'':readyReason} onClick={()=>start('all',{entityIds:people.map(e=>e.entityId)},Number(duration))}>{pending.has('all')?tr('运行中…','Running…'):tr('全部开始','Start all')}</button><button type="button" disabled={disabled||!ready} title={ready?'':readyReason} onClick={()=>void stop({entityIds:people.map(e=>e.entityId)})}>{tr('全部停止','Stop all')}</button></div>
  </div>}
  {people.length===0&&<p className="lya-help">{tr('场景里还没有人物；先在上方创建，或在对话中描述要调出的人群。','No people in the scene yet; create them above, or describe the crowd you want in the conversation.')}</p>}
  <p className="lya-help">{tr('不提供跑步预设：Run 动作未经接地/步幅校准，不能保证不滑步。开始按钮要求已同步的 MuJoCo 或 Isaac 世界；本面板不替你自动同步。','No running preset: the Run clip is not ground/stride-calibrated and cannot be guaranteed slip-free. Start requires a synchronized MuJoCo or Isaac world; this panel does not synchronize for you.')}</p>
  {message&&<p className="lya-help" role="status">{message}</p>}
 </div>
}

export function countCrowdStarts(command:(name:string,input:unknown)=>Promise<unknown>,running:{current:number}){return (name:string,input:unknown)=>{if(name!=='crowd_start')return command(name,input);running.current++;return command(name,input).finally(()=>{running.current--})}}
