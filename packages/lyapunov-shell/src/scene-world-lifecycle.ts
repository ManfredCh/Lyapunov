import type {SceneSnapshot,WorldHandle,Frame} from '../../lyapunov-contracts/src/types.ts'
import type {RobotDescription,WorldOptions} from '../../sim-contract/src/index.ts'
import {uncontrolledFreeRootEntityIds} from './physics-test-space.ts'

export type SceneWorldPhase='idle'|'initializing'|'syncing'|'ready'|'running'|'paused'|'unsynced'|'failed'|'blocked'|'closed'
export interface SceneWorldState {phase:SceneWorldPhase;sceneId?:string;sceneRevision?:number;worldId?:string;generation?:number;engine?:string;code?:string;detail?:string;missing?:string[];worldPhysics?:WorldHandle['worldPhysics'];clock?:WorldHandle['clock']}
export interface SceneWorldReconciliation {snapshot:SceneSnapshot;pending:boolean;issues:Array<{entityId:string;resourceId?:string;version?:number;reason:string}>}
export interface SceneWorldPort {
 list():Promise<WorldHandle[]>
 open(scene:SceneSnapshot,signal:AbortSignal,options?:Pick<WorldOptions,'startPaused'>):Promise<WorldHandle>
 observe(worldId:string):Promise<Frame>
 close(worldId:string):Promise<unknown>
 /** 使用已有world，不创建另一物理owner；真实首帧仍由observe确认。 */
 sync?(scene:SceneSnapshot,world:WorldHandle,signal:AbortSignal):Promise<WorldHandle>
 /** 自动同步新自由根前先暂停既有 owner，仍按原代次核对；不会创建另一世界。 */
 setPaused?(world:WorldHandle,paused:boolean,signal:AbortSignal):Promise<WorldHandle>
 reconcile?(scene:SceneSnapshot,signal:AbortSignal):Promise<SceneWorldReconciliation>
 /** 仅首次建立世界；地面准备必须由Scene CAS持久化，并返回实际新revision。 */
 prepareWorld?(scene:SceneSnapshot,signal:AbortSignal):Promise<SceneSnapshot>
 acceptScene?(scene:SceneSnapshot):void
}
/** 只检查已有声明；不会补坐标、派生碰撞或搜索本地文件。 */
export function sceneWorldPreflight(scene:SceneSnapshot,options:{allowEmpty?:boolean}={}):{code:string;detail:string;missing:string[]}|undefined {
 const missing:string[]=[]
 for(const e of scene.entities)for(const r of e.resources){
  const source=r.source
  if(!source||!source.units||!['X','Y','Z'].includes(source.upAxis)||!['left','right'].includes(source.handedness))missing.push(`${e.name||e.entityId}: ${r.resourceId}@${r.version} source`)
 }
 if(missing.length)return {code:'SCENE_RESOURCE_SOURCE_REQUIRED',detail:'资源来源坐标尚不完整；先从已登记原件恢复，不能猜轴或把视觉场景当作物理就绪。',missing}
 const physical=scene.entities.some(e=>Boolean(e.components.collision||e.components.rigidBody||e.components.articulation||e.components.mujoco||e.components.isaac||e.components.newton))
 if(!physical&&!options.allowEmpty)return {code:'SCENE_PHYSICS_REQUIRED',detail:'当前场景只有视觉资源，尚无已声明碰撞或原生物理模型；物理世界未启动。',missing:['collision/native physics source']}
}
/** 自动物理意图只取已保存的模板/实体声明；视觉与默认重力不是启动请求。 */
export function sceneRequestsPhysics(scene:SceneSnapshot):boolean{
 return scene.physics?.template==='physics-workspace-v1'||scene.physics?.template==='physics-workspace-v2'||scene.entities.some(e=>Boolean(e.components.collision||e.components.rigidBody||e.components.articulation||e.components.mujoco||e.components.isaac||e.components.newton||e.components.physicsBinding))
}
/** 无Provider只阻断确有物理意图/既有world的场景；视觉显示保持可用。 */
export function sceneWorldWithoutProvider(scene:SceneSnapshot,world:WorldHandle|undefined,detail:string):SceneWorldState{
 return sceneRequestsPhysics(scene)||world?.sceneId===scene.sceneId?{phase:'blocked',sceneId:scene.sceneId,code:'PROVIDER_UNAVAILABLE',detail}:{phase:'idle',sceneId:scene.sceneId,sceneRevision:scene.revision}
}
export function intentionalBlankScene(scene:SceneSnapshot):boolean{
 const noPhysics=!scene.entities.some(e=>e.components.collision||e.components.rigidBody||e.components.mujoco||e.components.isaac||e.components.articulation)
 const noVisual=scene.entities.every(e=>!e.resources.length&&!e.components.visual)
 return noPhysics&&noVisual&&(scene.entities.length===0||scene.physics?.template==='blank'||scene.entities.every(e=>e.components.camera||e.components.viewerCamera))
}
export function worldLifecycleState(world:WorldHandle,frame?:Frame):SceneWorldState {
 const same=frame?.worldId===world.worldId&&frame.generation===world.worldGeneration&&frame.sceneRevision===world.appliedSceneRevision
 const status=['ready','running','paused'].includes(world.status)&&same&&frame?.worldStatus?frame.worldStatus:world.status,phase:SceneWorldPhase=status==='unavailable'?'failed':status
 return {phase,sceneId:world.sceneId,sceneRevision:world.appliedSceneRevision,worldId:world.worldId,generation:world.worldGeneration,engine:world.engineId,clock:world.clock,worldPhysics:same&&frame?.worldPhysics?frame.worldPhysics:world.worldPhysics,...phase==='failed'?{code:'WORLD_UNAVAILABLE'}:{}}
}
/** 目标按会话/Host/Scene隔离。每版本自动尝试一次；失败只能显式重试，关闭不自动重开。 */
export class SceneWorldLifecycle {
 private key?:string
 private attempt?:{key:string;attemptKey:string;operation?:'sync'|'open';controller:AbortController;promise:Promise<WorldHandle|undefined>}
 private attempted=new Set<string>()
 private closed=new Set<string>()
 constructor(private publish:(state:SceneWorldState)=>void){}
 ensure(session:string,host:string,scene:SceneSnapshot,port:SceneWorldPort,explicit=false):Promise<WorldHandle|undefined>{
  const key=JSON.stringify([session,host,scene.sceneId]),attemptKey=JSON.stringify([key,scene.revision])
  if(this.key!==key){this.attempt?.controller.abort();this.key=key}
  if(this.attempt?.attemptKey===attemptKey&&!this.attempt.controller.signal.aborted)return this.attempt.promise
  const previous=this.attempt
  if(previous&&!previous.controller.signal.aborted)previous.controller.abort()
  if(explicit){this.closed.delete(key);this.attempted.delete(attemptKey)}
  if(this.closed.has(key)||this.attempted.has(attemptKey))return Promise.resolve(undefined)
  this.attempted.add(attemptKey)
  const controller=new AbortController(),current=()=>this.key===key&&!controller.signal.aborted
  const promise=(async()=>{
   let owned:WorldHandle|undefined
   try{
    // 新版本/Scene的冷启动先等旧自有open完成真实收尾；既有world的sync取消仍沿原队列处理。
    if(previous?.operation==='open'){await previous.promise;if(!current())return}
    // 未声明物理且没有旧world时，只显示场景；不通过reconcile/地面准备暗中改变意图。
    // 已有world清空或转为纯视觉仍沿原reconcile→sync，不关闭用户owner。
    if(!explicit&&!sceneRequestsPhysics(scene)){
     const existing=(await port.list()).filter(world=>world.sceneId===scene.sceneId&&world.status!=='closed')
     if(!current())return
     if(!existing.length){this.publish({phase:'idle',sceneId:scene.sceneId,sceneRevision:scene.revision,detail:'场景可显示和编辑；未请求创建物理世界。'});return}
    }
    let resourceIssue:{code:string;detail:string;missing:string[]}|undefined
    if(port.reconcile){
     const reconciliation=await port.reconcile(scene,controller.signal),prepared=reconciliation.snapshot
     if(!current())return
     if(prepared.sceneId!==scene.sceneId||prepared.revision<scene.revision)throw Error('WORLD_RECONCILE_BINDING_MISMATCH')
     if(prepared.revision!==scene.revision){
      scene=prepared;const reconciledKey=JSON.stringify([key,scene.revision]);this.attempted.add(reconciledKey)
      if(this.attempt?.controller===controller)this.attempt.attemptKey=reconciledKey
      port.acceptScene?.(prepared)
     }
     if(reconciliation.pending||reconciliation.issues.length){
      const missing=reconciliation.issues.map(issue=>`${issue.entityId}${issue.resourceId?` · ${issue.resourceId}@${issue.version??'?'}`:''}: ${issue.reason}`)
      resourceIssue={code:reconciliation.pending?'SCENE_PHYSICS_PENDING':'SCENE_PHYSICS_NOT_READY',detail:reconciliation.pending?'场景碰撞派生尚未完成；已保存编辑保留，完成后明确应用场景修改。':'场景碰撞来源需要修复；已保存编辑保留，未把旧碰撞交给物理世界。',missing}
     }
    }
    const preparation=!explicit&&uncontrolledFreeRootEntityIds(scene).length>0
    const worlds=(await port.list()).filter(w=>w.sceneId===scene.sceneId&&w.status!=='closed')
    if(!current())return
    if(worlds.length>1)throw new Error('WORLD_SELECTION_REQUIRED: 当前Scene有多个世界，请明确选择；未自动新建。')
    if(resourceIssue){
     const bound=worlds[0]
     this.publish({phase:bound?'unsynced':'blocked',sceneId:scene.sceneId,sceneRevision:scene.revision,...bound?{worldId:bound.worldId,generation:bound.worldGeneration,engine:bound.engineId}:{},...resourceIssue})
     return bound?{...bound,status:'unsynced' as const}:undefined
    }
    if(worlds.length===1){
     let w=worlds[0]!,synced=false
     if(w.appliedSceneRevision!==scene.revision&&port.sync){
      const issue=sceneWorldPreflight(scene,{allowEmpty:true})
      if(issue){this.publish({phase:'blocked',sceneId:scene.sceneId,sceneRevision:scene.revision,worldId:w.worldId,...issue});return {...w,status:'unsynced' as const}}
      const worldId=w.worldId
      if(this.attempt?.controller===controller)this.attempt.operation='sync'
      this.publish({phase:'syncing',sceneId:scene.sceneId,sceneRevision:scene.revision,worldId,generation:w.worldGeneration,engine:w.engineId})
      if(preparation&&w.status!=='paused'){
       if(w.supportsPause!==true||!port.setPaused)throw Error('CLOCK_CONTROL_UNSUPPORTED: 当前Provider不能在自动同步自由根前暂停；可明确选择被动物理。')
       const generation=w.worldGeneration,paused=await port.setPaused(w,true,controller.signal)
       if(!current())return
       if(paused.worldId!==worldId||paused.sceneId!==scene.sceneId||paused.worldGeneration!==generation||paused.status!=='paused')throw Error('WORLD_PREPARATION_PAUSE_MISMATCH: 未收到当前世界/代次的暂停确认，未同步自由根。')
       w=paused
      }
      w=await port.sync(scene,w,controller.signal);synced=true
      if(!current())return
      if(w.worldId!==worldId||w.sceneId!==scene.sceneId)throw new Error('WORLD_SYNC_BINDING_MISMATCH: 同步返回了另一Scene或世界；当前场景编辑已保留。')
      if(w.appliedSceneRevision!==scene.revision)throw new Error(`WORLD_SYNC_REVISION_MISMATCH: Scene rev ${scene.revision}，原生世界仍为 rev ${w.appliedSceneRevision}；读取当前版本后重试同步。`)
      if(preparation&&(w.status!=='paused'||w.supportsPause!==true))throw Error('WORLD_PREPARATION_NOT_PAUSED: 同步自由根后未保持已确认的暂停，未交付。')
     }
     const frame=await port.observe(w.worldId)
     if(!current())return
     if(frame.worldId!==w.worldId||frame.generation!==w.worldGeneration)throw new Error('STALE_WORLD_GENERATION: 世界帧与句柄代次不一致。')
     if(synced&&frame.sceneRevision!==scene.revision)throw new Error('WORLD_SYNC_FRAME_STALE: 同步后的首帧不是当前Scene版本；已提交编辑保留。')
     if(preparation&&synced&&frame.worldStatus!==undefined&&frame.worldStatus!=='paused')throw Error('WORLD_PREPARATION_NOT_PAUSED: 同步后的原生帧未确认暂停，未交付。')
     if(w.appliedSceneRevision!==scene.revision||frame.sceneRevision!==undefined&&frame.sceneRevision!==scene.revision){const stale={...w,status:'unsynced' as const};this.publish({...worldLifecycleState(stale,frame),code:'WORLD_SCENE_UNSYNCED',detail:'Scene已更新，当前物理世界仍为旧版本；同步当前场景后再执行动作，已提交编辑保留。'});return stale}
     this.publish(worldLifecycleState(w,frame));return w
    }
    if(!explicit&&!sceneRequestsPhysics(scene)){this.publish({phase:'idle',sceneId:scene.sceneId,sceneRevision:scene.revision,detail:'场景可显示和编辑；未请求创建物理世界。'});return}
    if(port.prepareWorld){
     const prepared=await port.prepareWorld(scene,controller.signal)
     if(!current())return
     if(prepared.sceneId!==scene.sceneId||prepared.revision<scene.revision)throw Error('WORLD_GROUND_PREPARATION_BINDING_MISMATCH')
     if(prepared.revision!==scene.revision){scene=prepared;const preparedKey=JSON.stringify([key,scene.revision]);this.attempted.add(preparedKey);if(this.attempt?.controller===controller)this.attempt.attemptKey=preparedKey;port.acceptScene?.(prepared)}
    }
    const issue=sceneWorldPreflight(scene,{allowEmpty:explicit&&intentionalBlankScene(scene)})
    if(issue){this.publish({phase:'blocked',sceneId:scene.sceneId,sceneRevision:scene.revision,...issue});return}
    this.publish({phase:'initializing',sceneId:scene.sceneId,sceneRevision:scene.revision})
    if(this.attempt?.controller===controller)this.attempt.operation='open'
    owned=await port.open(scene,controller.signal,preparation?{startPaused:true}:undefined)
    if(!current()){await port.close(owned.worldId);return}
    if(owned.sceneId!==scene.sceneId)throw new Error('WORLD_SCENE_MISMATCH: 引擎返回了其他Scene的世界。')
    if(owned.appliedSceneRevision!==scene.revision)throw new Error('WORLD_OPEN_REVISION_MISMATCH: 首次建立的原生世界没有加载本次场景版本；读取当前场景后重试。')
    const frame=await port.observe(owned.worldId)
    if(!current()){await port.close(owned.worldId);return}
    if(frame.worldId!==owned.worldId||frame.generation!==owned.worldGeneration||frame.sceneRevision!==undefined&&frame.sceneRevision!==owned.appliedSceneRevision)throw new Error('STALE_WORLD_GENERATION: 首帧与世界绑定不一致。')
    if(preparation&&(owned.status!=='paused'||owned.supportsPause!==true||frame.worldStatus!==undefined&&frame.worldStatus!=='paused'||frame.stepIndex!==0||frame.simTime!==0))throw Error('WORLD_PREPARATION_NOT_PAUSED: 自由根准备世界未确认暂停的第0步，未交付。')
    this.publish(worldLifecycleState(owned,frame));return owned
   }catch(error){
    if(owned)try{await port.close(owned.worldId)}catch(cleanup){
     const detail='WORLD_START_CLEANUP_FAILED: 自有初始化世界尚未确认关闭；'+String(error)+'；关闭回执：'+String(cleanup)
     if(current())this.publish({phase:'failed',sceneId:scene.sceneId,sceneRevision:scene.revision,worldId:owned.worldId,code:'WORLD_START_CLEANUP_FAILED',detail})
     throw Error(detail)
    }
    // provider精确自报未交付worker的收尾失败时，不能让后继初始化冒充已结束。
    if((error as {details?:{orphanedWorker?:unknown}}|undefined)?.details?.orphanedWorker)throw error
    if(current()){const detail=error instanceof Error?error.message:String(error);this.publish({phase:'failed',sceneId:scene.sceneId,sceneRevision:scene.revision,code:detail.match(/^([A-Z][A-Z0-9_]+)/)?.[1]??'WORLD_INITIALIZATION_FAILED',detail})}
   }finally{if(this.attempt?.controller===controller)this.attempt=undefined}
  })()
  this.attempt={key,attemptKey,controller,promise};return promise
 }
 cancel(){const key=this.key,syncing=this.attempt?.operation==='sync';if(key)this.closed.add(key);this.attempt?.controller.abort();this.publish(syncing?{phase:'unsynced',code:'WORLD_SYNC_WAIT_CANCELLED',detail:'已取消等待同步，已提交编辑保留；原生状态由后续读回确定，可点击同步当前场景重新核对。'}:{phase:'closed',code:'WORLD_START_CANCELLED',detail:'已取消本次初始化；不会自动重试。'})}
 markClosed(){if(this.key)this.closed.add(this.key);this.attempt?.controller.abort();this.publish({phase:'closed',detail:'物理世界已关闭；场景保留，重新启动需明确操作。'})}
 leave(){this.attempt?.controller.abort();this.key=undefined}
}
/** 手调初值来自当前物理帧；缺测量不生成零关节目标。 */
export function measuredJointTargets(description:RobotDescription,frame:Frame,entityId:string):Record<string,number>{
 const joints=frame.entities.find(e=>e.entityId===entityId)?.joints,values:Record<string,number>={},missing:string[]=[]
 for(const name of description.controlledJointNames){const index=joints?.names.indexOf(name)??-1,value=index>=0?joints?.positions[index]:undefined;if(value===undefined||!Number.isFinite(value))missing.push(name);else values[name]=Number(value.toFixed(4))}
 if(missing.length)throw new Error('ROBOT_JOINT_OBSERVATION_REQUIRED: 缺少真实关节位置 '+missing.join(', '))
 return values
}
