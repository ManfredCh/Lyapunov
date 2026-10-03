import {useEffect,useState,type ReactNode} from 'react'
import type {SceneSnapshot,WorldHandle,Frame,Vec3} from '../../lyapunov-contracts/src/types.ts'
import {DEFAULT_WORLD_GRAVITY} from '../../lyapunov-contracts/src/world-physics.ts'
import {SceneWorldStatus,sceneWorldPhaseLabel} from './scene-world-status.tsx'
import type {SceneWorldState} from './scene-world-lifecycle.ts'
import type {Translate} from './entity-editor.tsx'
import {uncontrolledFreeRootEntityIds} from './physics-test-space.ts'

export function WorldPhysicsPanel({scene,world,frame,state,worlds,disabled,tr,start,sync,pause,stop,close,prepare,saveGravity,selectWorld,cancel,diagnostics}:{
 scene?:SceneSnapshot;world?:WorldHandle;frame?:Frame;state:SceneWorldState;worlds:WorldHandle[];disabled:boolean;tr:Translate
 start:()=>void;sync:()=>void;pause:(paused:boolean)=>void;stop:()=>void;close:()=>void;prepare:()=>void;saveGravity:(gravity:Vec3)=>void;selectWorld:(world:WorldHandle)=>void;cancel:()=>void
 diagnostics?:ReactNode
}){
 const configured=scene?.physics?.gravityWorldMps2??DEFAULT_WORLD_GRAVITY
 const [draft,setDraft]=useState<string[]>(configured.map(String))
 useEffect(()=>setDraft(configured.map(String)),[scene?.sceneId,configured.join(',')])
 const sameFrame=world&&frame?.worldId===world.worldId&&frame.generation===world.worldGeneration&&frame.sceneRevision===world.appliedSceneRevision
 const actual=sameFrame&&frame?.worldPhysics?frame.worldPhysics:world?.worldPhysics
 const valid=draft.length===3&&draft.every(v=>v.trim()!==''&&Number.isFinite(Number(v)))
 const active=Boolean(world&&['ready','running','paused'].includes(world.status)),busy=['initializing','syncing'].includes(state.phase)
 return <section data-testid="world-physics-panel">
  <div className="lya-panel-title"><strong>{tr('物理运行','Physics')}</strong></div>
  <SceneWorldStatus state={state} tr={tr} retry={start} cancel={cancel} disabled={disabled}/>
  {state.phase==='paused'&&world?.sceneId===scene?.sceneId&&world?.appliedSceneRevision===scene?.revision&&uncontrolledFreeRootEntityIds(scene).length>0&&<p data-testid="world-controller-preparation" className="lya-help">{tr('自由根模型尚未绑定控制器，世界已暂停准备。激活匹配策略先完成配套初态与控制器准备；再显式执行策略动作，才受控推进。也可明确点击“继续物理”进行被动仿真，模型会按真实重力运动。倒地后先复位再初始化；行走策略不等于自起身。','The free-root model has no controller binding and physics is paused for preparation. Activate a matched policy to prepare its paired initial state and controller; explicitly execute policy actions to begin controlled stepping. You can also explicitly resume passive physics under real gravity. Reset before reinitializing after a fall; locomotion does not imply get-up capability.')}</p>}
  {world&&<p className="lya-help">{world.engineId} {world.engineVersion} · {tr('已应用场景','Applied scene')} rev {world.appliedSceneRevision} · {tr('当前场景','Current scene')} rev {scene?.revision??'—'} · g{world.worldGeneration}{world.clock==='manual'?` · ${tr('手动时钟，等待动作推进','Manual clock, waiting for actions')}`:''}</p>}
  <div data-testid="world-visible-diagnostics">{diagnostics}</div>
  {actual?<>
   <p data-testid="world-gravity-readback" className="lya-help">{active?tr('实际世界重力','World gravity'):tr('上次世界重力读回（当前世界不可用）','Last gravity readback (world unavailable)')}: [{actual.gravityWorldMps2.map(v=>Number(v.toFixed(5))).join(', ')}] m/s² · {actual.gravityEnabled?tr('已启用','Enabled'):tr('已关闭','Disabled')}</p>
   <p data-testid="world-readback-source" className="lya-help">{sameFrame&&frame?.worldPhysics?tr(`来自物理帧 step ${frame.stepIndex} · rev ${frame.sceneRevision} · g${frame.generation}`,`From physics frame step ${frame.stepIndex} · rev ${frame.sceneRevision} · g${frame.generation}`):tr(`来自世界句柄 rev ${world?.appliedSceneRevision??'—'} · g${world?.worldGeneration??'—'}`,`From world handle rev ${world?.appliedSceneRevision??'—'} · g${world?.worldGeneration??'—'}`)}</p>
   <p data-testid="world-collision-coverage" className="lya-help">{actual.collisionCoverage.status==='NONE'?tr('当前世界没有可用碰撞对象','No collision objects in this world'):actual.collisionCoverage.status==='PARTIAL'?tr('部分实例还没有碰撞；地面就绪不代表整个环境可碰撞。','Some instances lack collision; a ready ground does not make the whole environment collidable.'):tr('已装配的实例碰撞已确认','Collision confirmed for the assembled instances')}{actual.collisionCoverage.visualOnlyEntityIds.length?` · ${actual.collisionCoverage.visualOnlyEntityIds.join(' · ')}`:''}</p>
  </>:<p className="lya-help">{tr('世界尚未读回重力与碰撞状态。','World gravity and collision state have not been read back.')}</p>}
  {worlds.length>1&&<select className="lya-wide" aria-label={tr('运行世界选择','Select world')} value={world?.worldId??''} onChange={e=>{const chosen=worlds.find(w=>w.worldId===e.target.value);if(chosen)selectWorld(chosen)}}>{worlds.map(w=><option key={w.worldId} value={w.worldId}>{w.sceneId} · {w.engineId} · {sceneWorldPhaseLabel(w.status==='unavailable'?'failed':w.status,tr)} · g{w.worldGeneration}</option>)}</select>}
  <div className="lya-row">
   <button disabled={disabled||!scene||busy||active} onClick={start}>{tr('启动物理','Start physics')}</button>
   {world&&world.appliedSceneRevision!==scene?.revision&&<button disabled={disabled||busy} onClick={sync}>{tr('应用场景修改','Apply scene changes')}</button>}
   {world?.supportsPause&&active&&<button disabled={disabled} onClick={()=>pause(state.phase!=='paused')}>{state.phase==='paused'?tr('继续物理','Resume physics'):tr('暂停物理','Pause physics')}</button>}
   <button className="lya-stop" disabled={!active} onClick={stop}>{tr('停止动作','Stop actions')}</button>
   {world&&<button disabled={disabled} onClick={close}>{tr('关闭物理世界','Close physics world')}</button>}
  </div>
  <details><summary>{tr('世界配置','World settings')}</summary>
   <p className="lya-help">{tr('保存到场景；应用场景修改后以原生读回值确认。物体重力开关与固定约束单独设置。','Saved in the scene; apply changes and confirm native readback. Body gravity and fixed constraints are separate.')}</p>
   <div className="lya-row">{['X','Y','Z'].map((axis,index)=><label key={axis}>{axis}<input aria-label={`${tr('世界重力','World gravity')} ${axis}`} type="number" step="0.1" disabled={disabled} value={draft[index]??''} onChange={e=>setDraft(v=>v.map((old,i)=>i===index?e.target.value:old))}/></label>)}</div>
   <button disabled={disabled||!scene||!valid} onClick={()=>saveGravity(draft.map(Number)as Vec3)}>{tr('保存世界重力','Save world gravity')}</button>
   {scene?.physics?.template!=='physics-workspace-v1'&&<button disabled={disabled||!scene} onClick={prepare}>{tr('明确添加标准测试地面','Add standard test ground')}</button>}
  </details>
 </section>
}
