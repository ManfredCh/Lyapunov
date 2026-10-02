import type { SimWorlds } from '../../sim-contract/src/index.ts'
import type { ActionReceipt, Frame } from '../../lyapunov-contracts/src/types.ts'
import { ActionReceiptError, assertIdentity, confirmStop, executionModeOf, type ObservationFreshness, type RequestIdentity, type StopOutcome } from './workflow-evidence.ts'
import { randomUUID } from 'node:crypto'
/** 货物低层组合；所有车辆与升降继续使用同一SI动作实现，支持状态由真实接触决定。
 *  停止必须带本次 expectedGeneration 且结果显式记录；失败用最后实际帧时注明 last-known。 */
export async function transportCargo(sim:SimWorlds,input:{worldId:string;vehicleId:string;cargoId:string;travelSpeedMps:number;travelDurationS:number;carryLiftM:number;releaseLiftM:number;minimumLiftM:number;withdrawDurationS:number;expectedPlacementZ:number;placementToleranceM:number;actionPrefix?:string},signal?:AbortSignal){
 const prefix=input.actionPrefix??randomUUID(),before=await sim.observe(input.worldId,{contacts:true}),initial=before.entities.find(e=>e.entityId===input.cargoId)!,actions:ActionReceipt[]=[]
 const identity:RequestIdentity={worldId:input.worldId,generation:before.generation}
 const seen:Frame[]=[before];let last=before
 // 每个回执/观测的 world 与 generation 必须与本次请求一致；跨代次证据不能拼成成功。
 const execute=async(action:any)=>{const result=await sim.execute(input.worldId,{...action,entityId:input.vehicleId,expectedGeneration:identity.generation},signal);actions.push(result);if(result.worldId!==input.worldId||result.generation!==identity.generation)throw new Error('STALE_GENERATION: 动作回执来源与本次请求不一致');if(result.status!=='completed')throw new ActionReceiptError(result);return result}
 const observe=async()=>{const frame=await sim.observe(input.worldId,{contacts:true});assertIdentity('观测',frame,identity);seen.push(frame);last=frame;return frame}
 let outcome:{status:'completed'|'failed'|'cancelled';taskAchieved:boolean;reason?:string;executionMode:ReturnType<typeof executionModeOf>;actions:ActionReceipt[];before:Frame;after:Frame;afterSource:ObservationFreshness;observationError?:string;effect:Record<string,unknown>}|undefined
 try{
  await execute({kind:'lift',actionId:prefix+'-raise',positionM:input.carryLiftM,durationS:2})
  const raised=await observe(),dz=raised.entities.find(e=>e.entityId===input.cargoId)!.transform.position[2]-initial.transform.position[2]
  if(dz<input.minimumLiftM)outcome={status:'failed',taskAchieved:false,reason:'CARGO_NOT_SUPPORTED',executionMode:executionModeOf(actions,seen),actions,before,after:raised,afterSource:'fresh',effect:{liftM:dz}}
  else{
   await execute({kind:'vehicle',actionId:prefix+'-transport',speedMps:input.travelSpeedMps,steeringAngleRad:0,durationS:input.travelDurationS})
   await execute({kind:'lift',actionId:prefix+'-release',positionM:input.releaseLiftM,durationS:2})
   await execute({kind:'vehicle',actionId:prefix+'-withdraw',speedMps:-Math.abs(input.travelSpeedMps),steeringAngleRad:0,durationS:input.withdrawDurationS})
   const after=await observe(),cargo=after.entities.find(e=>e.entityId===input.cargoId)!,contacts=((after as any).contacts as any[]).filter(c=>c.geom1.startsWith(input.cargoId+'/')||c.geom2.startsWith(input.cargoId+'/'))
   const carrierContacts=contacts.filter(c=>c.geom1.startsWith(input.vehicleId+'/')||c.geom2.startsWith(input.vehicleId+'/')),supportContacts=contacts.filter(c=>!carrierContacts.includes(c))
   const executionMode=executionModeOf(actions,seen)
   const achieved=executionMode==='physical-contact'&&Math.abs(cargo.transform.position[2]-input.expectedPlacementZ)<=input.placementToleranceM&&supportContacts.length>0&&carrierContacts.length===0
   const reason=achieved?undefined:executionMode==='assisted-teleport'?'ASSISTED_EXECUTION_NOT_PHYSICAL':executionMode==='unknown'?'EXECUTION_MODE_UNKNOWN':'PLACEMENT_NOT_ACHIEVED'
   outcome={status:achieved?'completed':'failed',taskAchieved:achieved,reason,executionMode,actions,before,after,afterSource:'fresh',effect:{liftM:dz,displacementM:cargo.transform.position.map((x,i)=>x-initial.transform.position[i]!),supportContactCount:supportContacts.length,carrierContactCount:carrierContacts.length}}
  }
 }catch(error){
  // 失败收尾保留已收集回执与最后一个有来源的观察；stop 结果与观察来源都如实记录，不覆盖真实错误。
  const cancelled=signal?.aborted===true||error instanceof ActionReceiptError&&error.receipt.status==='cancelled'
  outcome={status:cancelled?'cancelled':'failed',taskAchieved:false,executionMode:executionModeOf(actions,seen),reason:String(error),actions,before,after:last,afterSource:'last-known',effect:{}}
 }
 // 一次调用只发一次停止请求：带本次 expectedGeneration；未确认不得被当作已停止，成功也不能靠吞 stop 错误。
 const stop:StopOutcome=await confirmStop(sim,input.worldId,{entityIds:[input.vehicleId],expectedGeneration:identity.generation})
 const result=!stop.confirmed&&outcome.status==='completed'?{...outcome,status:'failed' as const,taskAchieved:false,reason:'STOP_NOT_CONFIRMED'}:outcome
 return{...result,stop}
}
