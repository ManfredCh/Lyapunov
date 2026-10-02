import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Frame, WorldHandle } from '../../lyapunov-contracts/src/types.ts'
import type { SimWorlds } from '../../sim-contract/src/index.ts'
import { assertIdentity, confirmStop } from './workflow-evidence.ts'
import { assertFlightProfile, flightControl, flightState, yawOf, type FlightTarget, type FlightVec3 } from './flight-controller.ts'

export interface FlightInput {
  worldId:string;entityId:string;expectedGeneration:number;expectedSceneRevision:number
  operation:'hover'|'goto'|'land';positionM?:FlightVec3;yawRad?:number;maxDurationS?:number;landingSurfaceZ?:number
}
export interface FlightSample { step:number;timeS:number;positionM:FlightVec3;yawRad:number;errorM:number;yawErrorRad:number;tiltRad:number;thrustN:number;torqueNm:FlightVec3;measuredActuatorForce?:unknown;contacts:number }
export interface FlightResult { status:'completed'|'failed'|'cancelled';taskAchieved:boolean;reason?:string;worldId:string;generation:number;sceneRevision:number;operation:string;target:FlightTarget;before:Frame;after:Frame;stop:Awaited<ReturnType<typeof confirmStop>>;samples:FlightSample[];actions:number;clock:string;maxTiltRad:number;source:'native-body-wrench-pid' }
const running=new WeakMap<SimWorlds,Map<string,{controller:AbortController;done:Promise<FlightResult>;generation:number}>>()
const recent=new WeakMap<SimWorlds,Map<string,ReturnType<typeof summarizeFlight>>>()
function key(worldId:string,entityId:string){return JSON.stringify([worldId,entityId])}
export function summarizeFlight(result:FlightResult){return {status:result.status,taskAchieved:result.taskAchieved,reason:result.reason,operation:result.operation,worldId:result.worldId,generation:result.generation,sceneRevision:result.sceneRevision,target:result.target,actions:result.actions,maxTiltRad:result.maxTiltRad,source:result.source,stop:result.stop,after:{frameId:result.after.frameId,step:result.after.stepIndex,position:result.after.entities[0]?.transform.position}}}
export function flightStatus(sim:SimWorlds,worldId:string,entityId:string,generation:number){
  const active=running.get(sim)?.get(key(worldId,entityId));if(active?.generation===generation)return {status:'running',worldId,generation}
  const last=recent.get(sim)?.get(key(worldId,entityId));return last?.generation===generation?last:{status:'idle',worldId,generation}
}
export function isFlightRunning(sim:SimWorlds,worldId:string,entityId:string){return running.get(sim)?.has(key(worldId,entityId))??false}
function assertFrame(frame:Frame,input:FlightInput){
  assertIdentity('飞控实测帧',frame,{worldId:input.worldId,generation:input.expectedGeneration})
  if(frame.sceneRevision!==input.expectedSceneRevision)throw new Error('FLIGHT_SCENE_CHANGED: 本次飞控的 Scene revision 已改变')
  if(frame.executionMode!=='physical-contact')throw new Error('FLIGHT_PHYSICAL_FRAME_REQUIRED: 不能在辅助视觉位移帧上执行飞控')
}
function entityState(frame:Frame,input:FlightInput){const entity=frame.entities.find(e=>e.entityId===input.entityId);if(!entity)throw new Error('FLIGHT_ENTITY_UNAVAILABLE');return flightState(entity)}
export function validateFlightInput(input:FlightInput){
  if(!input||typeof input.worldId!=='string'||!input.worldId||typeof input.entityId!=='string'||!input.entityId||!Number.isSafeInteger(input.expectedGeneration)||input.expectedGeneration<1||!Number.isSafeInteger(input.expectedSceneRevision)||input.expectedSceneRevision<0)throw new Error('FLIGHT_INVALID_IDENTITY')
  if(!['hover','goto','land'].includes(input.operation))throw new Error('FLIGHT_INVALID_OPERATION')
  if(input.positionM!==undefined&&(!Array.isArray(input.positionM)||input.positionM.length!==3||!input.positionM.every(Number.isFinite)))throw new Error('FLIGHT_INVALID_TARGET')
  if(input.operation==='goto'&&!input.positionM)throw new Error('FLIGHT_TARGET_REQUIRED')
  if(input.yawRad!==undefined&&!Number.isFinite(input.yawRad))throw new Error('FLIGHT_INVALID_TARGET')
  if(input.operation==='land'&&(!Number.isFinite(input.landingSurfaceZ)))throw new Error('FLIGHT_LANDING_SURFACE_REQUIRED: 请明确当前世界地面高度（米）')
  if(input.maxDurationS!==undefined&&(!Number.isFinite(input.maxDurationS)||input.maxDurationS<1||input.maxDurationS>30))throw new Error('FLIGHT_DURATION_OUT_OF_RANGE: 单次须 1..30 秒')
}

export interface FlightRunOptions { paceManual?:boolean;sample?:(sample:FlightSample)=>void;onAction?:(actionId:string)=>void }
export async function runFlight(sim:SimWorlds,input:FlightInput,signal?:AbortSignal,options:FlightRunOptions={}):Promise<FlightResult>{
  validateFlightInput(input)
  let entries=running.get(sim);if(!entries){entries=new Map();running.set(sim,entries)}
  const id=key(input.worldId,input.entityId)
  if(entries.has(id))throw new Error('FLIGHT_ALREADY_RUNNING: 先停止当前飞控或更新已运行目标')
  const controller=new AbortController(),abort=()=>controller.abort(signal?.reason)
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true})
  let currentAction:string|undefined
  const detach=sim.subscribeStops?.(input.worldId,selection=>{
    if(selection.expectedGeneration!==undefined&&selection.expectedGeneration!==input.expectedGeneration)return
    if(selection.entityIds?.length&&!selection.entityIds.includes(input.entityId))return
    if(selection.actionId&&selection.actionId!==currentAction)return
    controller.abort('native-stop-confirmed')
  })
  const done=performFlight(sim,input,controller.signal,{...options,onAction:actionId=>{currentAction=actionId;options.onAction?.(actionId)}})
  entries.set(id,{controller,done,generation:input.expectedGeneration})
  try{const result=await done;let history=recent.get(sim);if(!history){history=new Map();recent.set(sim,history)}history.delete(id);history.set(id,summarizeFlight(result));while(history.size>32)history.delete(history.keys().next().value!);return result}finally{detach?.();signal?.removeEventListener('abort',abort);if(entries.get(id)?.done===done)entries.delete(id)}
}

async function performFlight(sim:SimWorlds,input:FlightInput,signal:AbortSignal,options:FlightRunOptions):Promise<FlightResult>{
  const world=(await sim.listWorlds()).find(w=>w.worldId===input.worldId)
  if(!world||world.worldGeneration!==input.expectedGeneration||world.appliedSceneRevision!==input.expectedSceneRevision)throw new Error('FLIGHT_WORLD_MISMATCH')
  if(world.engineId!=='mujoco'||!['manual','realtime'].includes(world.clock??'')||!world.timestepS)throw new Error('FLIGHT_ENGINE_PROFILE_UNVERIFIED: 当前已验证控制器需要 MuJoCo 真实时钟/步长；其它引擎单列验证')
  const description=await sim.describe(input.worldId,input.entityId)
  if(description.expectedGeneration!==input.expectedGeneration)throw new Error('STALE_GENERATION')
  const mapping=assertFlightProfile(description.bodyWrench)
  const selection={entityIds:[input.entityId],sensors:true,contacts:true}
  const before=await sim.observe(input.worldId,selection);assertFrame(before,input)
  const start=entityState(before,input)
  const target:FlightTarget={positionM:input.positionM??[...start.positionM],yawRad:input.yawRad??yawOf(start.quaternionXyzw)}
  if(input.operation==='land')target.positionM=[start.positionM[0],start.positionM[1],input.landingSurfaceZ!+.005]
  if(Math.hypot(target.positionM[0]-start.positionM[0],target.positionM[1]-start.positionM[1])>1||target.positionM[2]>1||target.positionM[2]<-.1)throw new Error('FLIGHT_TARGET_OUT_OF_RANGE: 已验证小范围为水平≤1m、高度−.1..1m')
  // 实时窗结束必须撤力，IPC 两窗之间存在真实零力间隙。100ms 使其占比较小；高度 PI 补偿剩余偏差，不能假设连续 mg。
  const duration=input.maxDurationS??(input.operation==='hover'?8:20),steps=Math.max(1,Math.round((world.clock==='realtime'?.1:.02)/world.timestepS)),period=steps*world.timestepS
  const maxCycles=Math.min(1500,Math.ceil(duration/period)),samples:FlightSample[]=[]
  let after=before,stableSince:number|undefined,achieved=false,reason:string|undefined,status:FlightResult['status']='failed',actions=0,maxTilt=0,integralZ=0,lastTime=before.simTime
  const ground=new Set(world.groundGeomNames??[]),prefix=randomUUID()
  const stopSelection={entityIds:[input.entityId],expectedGeneration:input.expectedGeneration}
  let stop:FlightResult['stop']|undefined
  try{
    for(let i=0;i<maxCycles;i++){
      if(signal.aborted)throw new Error('FLIGHT_CANCELLED')
      const frame=await sim.observe(input.worldId,selection);assertFrame(frame,input);after=frame
      const state=entityState(frame,input),dt=Math.min(.25,Math.max(0,frame.simTime-lastTime));lastTime=frame.simTime
      integralZ=Math.min(.8,Math.max(-.8,integralZ+(target.positionM[2]-state.positionM[2])*dt))
      const control=flightControl(state,target,mapping,integralZ)
      maxTilt=Math.max(maxTilt,control.tiltRad)
      if(control.tiltRad>.5||Math.hypot(...state.velocityWorldMps)>3||Math.hypot(...state.omegaBodyRadps)>8||state.positionM[2]<-.1||state.positionM[2]>1.5)throw new Error('FLIGHT_STATE_LIMIT: 真实飞行姿态/速度/高度超出已验证窗口')
      const contacts=(frame.contacts??[]).filter(c=>ground.has(c.geom1)||ground.has(c.geom2))
      const sample:FlightSample={step:frame.stepIndex,timeS:frame.simTime,positionM:[...state.positionM],yawRad:yawOf(state.quaternionXyzw),errorM:control.errorM,yawErrorRad:control.yawErrorRad,tiltRad:control.tiltRad,thrustN:control.thrustN,torqueNm:control.torqueNm,contacts:contacts.length}
      const stable=control.errorM<=(input.operation==='hover'?.05:.10)&&Math.abs(control.yawErrorRad)<=.15&&control.tiltRad<=.25&&Math.hypot(...state.velocityWorldMps)<=.10
      if(stable&&(input.operation!=='land'||contacts.length>0)){stableSince??=frame.simTime;if(frame.simTime-stableSince>=.5)achieved=true}else{stableSince=undefined;achieved=false}
      if(input.operation!=='hover'&&achieved){status='completed';samples.push(sample);options.sample?.(sample);break}
      const action={kind:'thrust' as const,entityId:input.entityId,thrustN:control.thrustN,torqueNm:control.torqueNm,actionId:prefix+'-'+i,expectedGeneration:input.expectedGeneration,...world.clock==='manual'?{stepCount:steps}:{durationS:period}}
      options.onAction?.(action.actionId)
      const receipt=await sim.execute(input.worldId,action,signal);actions++
      assertIdentity('飞控动作回执',receipt,{worldId:input.worldId,generation:input.expectedGeneration})
      sample.measuredActuatorForce=receipt.effect?.measuredActuatorForce;samples.push(sample);options.sample?.(sample)
      if(receipt.status!=='completed')throw new Error('FLIGHT_ACTION_'+receipt.status.toUpperCase()+': '+(receipt.reason??''))
      if(world.clock==='manual'&&options.paceManual!==false)await delay(period*1000,undefined,{signal})
    }
    after=await sim.observe(input.worldId,selection);assertFrame(after,input)
    if(input.operation==='hover'&&achieved){status='completed'}
    else if(status!=='completed')reason='FLIGHT_TARGET_NOT_REACHED'
  }catch(error){status=signal.aborted?'cancelled':'failed';achieved=false;reason=String(error)}
  finally{stop=await confirmStop(sim,input.worldId,stopSelection)}
  try{const settled=await sim.observe(input.worldId,selection);assertFrame(settled,input);after=settled}catch(error){status='failed';achieved=false;reason='FLIGHT_FINAL_OBSERVATION_FAILED: '+String(error)}
  if(status==='completed'){
    const finalControl=flightControl(entityState(after,input),target,mapping,integralZ)
    if(finalControl.errorM>(input.operation==='hover'?.05:.10)||Math.abs(finalControl.yawErrorRad)>.15||finalControl.tiltRad>.25){status='failed';achieved=false;reason='FLIGHT_FINAL_TARGET_NOT_REACHED'}
  }
  if(!stop?.confirmed){status='failed';achieved=false;reason='FLIGHT_STOP_NOT_CONFIRMED'}
  return {status,taskAchieved:status==='completed'&&achieved,reason,worldId:input.worldId,generation:input.expectedGeneration,sceneRevision:input.expectedSceneRevision,operation:input.operation,target,before,after,stop:stop!,samples,actions,clock:world.clock!,maxTiltRad:maxTilt,source:'native-body-wrench-pid'}
}

/** 先取消本控制器，等待其同代次停止收尾；不存在控制器时只撤本实体原生动作。 */
export async function stopFlight(sim:SimWorlds,worldId:string,entityId:string,expectedGeneration:number){
  const current=running.get(sim)?.get(key(worldId,entityId))
  if(current&&current.generation!==expectedGeneration)throw new Error('STALE_GENERATION')
  if(current){current.controller.abort('flight-stop');const result=await current.done;return {stopped:result.stop.confirmed,controllerStatus:result.status,actions:result.actions,after:result.after,stop:result.stop}}
  const stop=await confirmStop(sim,worldId,{entityIds:[entityId],expectedGeneration});return {stopped:stop.confirmed,controllerStatus:'idle',actions:0,stop}
}
