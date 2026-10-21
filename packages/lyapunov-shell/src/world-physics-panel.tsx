import {useEffect,useState,type ReactNode} from 'react'
import type {SceneSnapshot,WorldHandle,Frame,Vec3} from '../../lyapunov-contracts/src/types.ts'
import {DEFAULT_WORLD_GRAVITY} from '../../lyapunov-contracts/src/world-physics.ts'
import {SceneWorldStatus,sceneWorldPhaseLabel} from './scene-world-status.tsx'
import type {SceneWorldState} from './scene-world-lifecycle.ts'
import type {Translate} from './entity-editor.tsx'
import {uncontrolledFreeRootEntityIds} from './physics-test-space.ts'
import {ListRow} from './panel-chrome.tsx'

export function WorldPhysicsPanel({scene,world,frame,state,worlds,disabled,tr,start,sync,pause,stop,close,prepare,saveGravity,selectWorld,cancel,diagnostics,runtimeDiagnostics,enginePreference}:{
 scene?:SceneSnapshot;world?:WorldHandle;frame?:Frame;state:SceneWorldState;worlds:WorldHandle[];disabled:boolean;tr:Translate
 /** 偏好文件里的下一世界引擎；与当前运行中的 `world.engineId` 分开显示，不把偏好冒充实测。 */
 enginePreference?:string|null
 start:()=>void;sync:()=>void;pause:(paused:boolean)=>void;stop:()=>void;close:()=>void;prepare:()=>void;saveGravity:(gravity:Vec3)=>void;selectWorld:(world:WorldHandle)=>void;cancel:()=>void
 diagnostics?:ReactNode
 runtimeDiagnostics?:ReactNode
}){
 const configured=scene?.physics?.gravityWorldMps2??DEFAULT_WORLD_GRAVITY
 const [draft,setDraft]=useState<string[]>(configured.map(String))
 useEffect(()=>setDraft(configured.map(String)),[scene?.sceneId,configured.join(',')])
 const sameFrame=world&&frame?.worldId===world.worldId&&frame.generation===world.worldGeneration&&frame.sceneRevision===world.appliedSceneRevision
 const actual=sameFrame&&frame?.worldPhysics?frame.worldPhysics:world?.worldPhysics
 const valid=draft.length===3&&draft.every(v=>v.trim()!==''&&Number.isFinite(Number(v)))
 const active=Boolean(world&&['ready','running','paused'].includes(world.status)),busy=['initializing','syncing'].includes(state.phase)
 const paused=state.phase==='paused'
 return <div data-testid="world-physics-panel" className="lya-panel-page">
  <div className="lya-page-head"><div className="lya-page-heading"><h2 className="lya-page-title">{tr('物理','Physics')}</h2></div></div>
  <div className="lya-field-row"><span className="lya-field-label">{tr('引擎','Engine')}</span><span className="lya-field-value">{world?.engineId??tr('未启动','Not started')}</span></div>
  <div className="lya-field-row" data-testid="world-engine-preference"><span className="lya-field-label">{tr('下一世界','Next world')}</span><span className="lya-field-value">{enginePreference??'—'}</span></div>
  {/* idle 只留短状态；failed/blocked/unsynced 的短原因与恢复动作仍在这里可见。 */}
  <SceneWorldStatus compact prefix={tr('世界','World')} state={state} tr={tr} retry={start} cancel={cancel} disabled={disabled}/>
  {/* 世界事实（编译告警/设备降级）是安全信息，仍在任何折叠之前可见；运行期技术细节按需展开。 */}
  <div data-testid="world-visible-diagnostics">{diagnostics}</div>
  {runtimeDiagnostics&&<details className="lya-advanced" data-testid="world-technical-details"><summary>{tr('技术状态','Technical state')}</summary>{runtimeDiagnostics}</details>}
  {paused&&world?.sceneId===scene?.sceneId&&world?.appliedSceneRevision===scene?.revision&&uncontrolledFreeRootEntityIds(scene).length>0&&<div data-testid="world-controller-preparation" className="lya-help">
   <p className="lya-help" data-testid="world-controller-preparation-line">{tr('自由根模型未绑定控制器 · 已暂停准备','Free-root model has no controller binding · paused for preparation')}</p>
   <details className="lya-advanced"><summary>{tr('完整说明','Full explanation')}</summary>
    <p className="lya-help">{tr('自由根模型尚未绑定控制器，世界已暂停准备。激活匹配策略先完成配套初态与控制器准备；再显式执行策略动作，才受控推进。也可明确点击“继续物理”进行被动仿真，模型会按真实重力运动。倒地后先复位再初始化；行走策略不等于自起身。','The free-root model has no controller binding and physics is paused for preparation. Activate a matched policy to prepare its paired initial state and controller; explicitly execute policy actions to begin controlled stepping. You can also explicitly resume passive physics under real gravity. Reset before reinitializing after a fall; locomotion does not imply get-up capability.')}</p>
   </details>
  </div>}
  {!actual&&<p data-testid="world-readback-missing" className="lya-help">{tr('世界尚未读回重力与碰撞状态。','World gravity and collision state have not been read back.')}</p>}
  <div className="lya-row" data-testid="world-main-actions">
   <button type="button" className={active?'lya-stop':'lya-primary'} disabled={disabled||!scene||busy} onClick={active?stop:start}>{active?tr('停止物理','Stop physics'):tr('启动物理','Start physics')}</button>
   {/* V11-P31：暂停时“继续物理”是当前下一步，不再藏进“更多世界动作”。 */}
   {world?.supportsPause&&active&&paused&&<button type="button" data-testid="world-resume-physics" disabled={disabled} onClick={()=>pause(false)}>{tr('继续物理','Resume physics')}</button>}
  </div>
  <div className="lya-section"><span>{tr('重力','Gravity')}</span><span className="lya-section-side">m/s²</span></div>
  <div className="lya-values" data-testid="world-gravity-inputs">{['X','Y','Z'].map((axis,index)=><label key={axis}>{axis}<input aria-label={`${tr('世界重力','World gravity')} ${axis}`} type="number" step="0.1" disabled={disabled} value={draft[index]??''} onChange={e=>setDraft(v=>v.map((old,i)=>i===index?e.target.value:old))}/></label>)}</div>
  <div className="lya-row"><button className="lya-chip" disabled={disabled||!scene||!valid} title={tr('保存的是下一次世界装配的配置；实际读回见“读取详情”。','This saves the next world setup; actual readback is under Readback details.')} onClick={()=>saveGravity(draft.map(Number)as Vec3)}>{tr('保存重力','Save gravity')}</button></div>
  <div className="lya-field-row" data-testid="world-timestep"><span className="lya-field-label">{tr('世界时间步','World time step')}</span><span className="lya-field-value">{world?.timestepS?`${world.timestepS} s`:tr('世界未启动','World not started')}</span></div>
  {/* 设计稿 physics：地面/碰撞是首屏两条折叠行（不是躲在读取详情里）。 */}
  <details className="lya-advanced" data-testid="world-ground-fold"><summary>{tr('地面','Ground')} · {scene?.physics?.groundState==='removed'||scene?.physics?.groundState==='disabled'?tr('已删除或禁用','Removed or disabled'):tr('场景地面','Scene ground')}</summary><p className="lya-help">{tr('地面碰撞来源与细节在“读取详情”中列出。','Ground collision source and details are listed under Readback details.')}</p></details>
  <details className="lya-advanced" data-testid="world-collisions-fold"><summary>{tr('碰撞','Collisions')} · {actual?(actual.collisionCoverage.status==='COMPLETE'?tr('已确认','Confirmed'):actual.collisionCoverage.status==='PARTIAL'?tr('部分实例','Partial'):tr('无碰撞对象','None')):tr('等待读回','Awaiting readback')}</summary><p className="lya-help">{tr('完整碰撞覆盖与纯视觉实例在“读取详情”中列出。','Full collision coverage and visual-only instances are listed under Readback details.')}</p></details>
  <details className="lya-advanced" data-testid="world-more-actions"><summary>{tr('更多世界动作','More world actions')}</summary>
   <div className="lya-row">
    {world?.supportsPause&&active&&<button type="button" disabled={disabled} onClick={()=>pause(!paused)}>{paused?tr('继续物理','Resume physics'):tr('暂停物理','Pause physics')}</button>}
    {world&&world.appliedSceneRevision!==scene?.revision&&<button disabled={disabled||busy} onClick={sync}>{tr('应用场景修改','Apply scene changes')}</button>}
    {!['physics-workspace-v1','physics-workspace-v2'].includes(scene?.physics?.template??'')&&!['removed','disabled'].includes(scene?.physics?.groundState??'')&&<button disabled={disabled||!scene} onClick={prepare}>{tr('添加默认无限地面','Add default infinite ground')}</button>}
    {world&&<button type="button" disabled={disabled} onClick={close}>{tr('关闭物理世界','Close physics world')}</button>}
   </div>
   {worlds.length>1&&<select className="lya-wide" aria-label={tr('运行世界选择','Select world')} value={world?.worldId??''} onChange={e=>{const chosen=worlds.find(w=>w.worldId===e.target.value);if(chosen)selectWorld(chosen)}}>{worlds.map(w=><option key={w.worldId} value={w.worldId}>{w.sceneId} · {w.engineId} · {sceneWorldPhaseLabel(w.status==='unavailable'?'failed':w.status,tr)} · g{w.worldGeneration}</option>)}</select>}
  </details>
  <details className="lya-advanced" data-testid="world-readback-details">
   <summary>{tr('读取详情','Readback details')}</summary>
   {world&&<p data-testid="world-runtime-identity" className="lya-help">{world.engineId} {world.engineVersion} · {tr('世界','World')} {world.worldId} · {tr('已应用场景','Applied scene')} rev {world.appliedSceneRevision} · {tr('当前场景','Current scene')} rev {scene?.revision??'—'} · g{world.worldGeneration}{world.clock==='manual'?` · ${tr('手动时钟，等待动作推进','Manual clock, waiting for actions')}`:''}</p>}
   {actual?<>
    <p data-testid="world-readback-source" className="lya-help">{sameFrame&&frame?.worldPhysics?tr(`来自物理帧 step ${frame.stepIndex} · rev ${frame.sceneRevision} · g${frame.generation}`,`From physics frame step ${frame.stepIndex} · rev ${frame.sceneRevision} · g${frame.generation}`):tr(`来自世界句柄 rev ${world?.appliedSceneRevision??'—'} · g${world?.worldGeneration??'—'}`,`From world handle rev ${world?.appliedSceneRevision??'—'} · g${world?.worldGeneration??'—'}`)}</p>
    <p data-testid="world-gravity-readback" className="lya-help">{active?tr('实际世界重力','World gravity'):tr('上次世界重力读回（当前世界不可用）','Last gravity readback (world unavailable)')}: [{actual.gravityWorldMps2.map(v=>Number(v)).join(', ')}] m/s² · {actual.gravityEnabled?tr('已启用','Enabled'):tr('已关闭','Disabled')}</p>
    <p data-testid="world-ground-source" className="lya-help">{tr('地面来源：','Ground source: ')}{actual.groundSources.length?actual.groundSources.map(source=>`${source.source==='scene'?tr('场景实体','Scene entity'):source.source==='native-plane'?tr('原生无限平面','Native infinite plane'):tr('明确请求的兼容平面','Explicit legacy plane')}${source.entityId?` · ${source.entityId}`:''}`).join('；'):tr('当前世界没有地面碰撞体','No ground collider in this world')}</p>
    <p data-testid="world-collision-coverage" className="lya-help">{actual.collisionCoverage.status==='NONE'?tr('当前世界没有可用碰撞对象','No collision objects in this world'):actual.collisionCoverage.status==='PARTIAL'?tr('部分实例还没有碰撞；地面就绪不代表整个环境可碰撞。','Some instances lack collision; a ready ground does not make the whole environment collidable.'):tr('已装配的实例碰撞已确认','Collision confirmed for the assembled instances')}{actual.collisionCoverage.visualOnlyEntityIds.length?` · ${actual.collisionCoverage.visualOnlyEntityIds.join(' · ')}`:''}</p>
   </>:<p className="lya-help">{tr('世界尚未读回重力与碰撞状态。','World gravity and collision state have not been read back.')}</p>}
  </details>
  <details className="lya-advanced" data-testid="world-physics-advanced">
   <summary>{tr('高级','Advanced')}</summary>
   {scene?.physics?.groundState==='removed'||scene?.physics?.groundState==='disabled'?<p data-testid="world-ground-removed" className="lya-help">{tr('默认地面已删除或禁用；这是场景保存的选择，同步与重开不会自动补回。','Default ground was removed or disabled. This choice is saved in the scene and will survive synchronization and reopening.')}</p>:scene?.physics?.template==='physics-workspace-v2'?<p data-testid="world-infinite-ground" className="lya-help">{tr('默认地面是零厚度无限碰撞平面；场景层级可锁定、隐藏或删除。隐藏只改变显示。','Default ground is a zero-thickness infinite collision plane. Lock, hide or delete it in the scene hierarchy. Hiding changes display only.')}</p>:null}
  </details>
 </div>
}
