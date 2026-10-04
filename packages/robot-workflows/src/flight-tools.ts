import type {Context} from '@deepseek-ai/cordis'
import {defineTool,validateArgs,ToolArgsError,type ParameterSchemaSpec,type ToolExecution} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-commands'
import {simWorldsFor} from '../../sim-contract/src/index.ts'
import {sceneOperationsFor} from '../../scene-kit/src/plugin.ts'
import {runFlight,stopFlight,flightStatus,summarizeFlight,type FlightInput} from './flight-run.ts'
const parameters:ParameterSchemaSpec={input:{type:'object',required:true,additionalProperties:false,properties:{
  worldId:{type:'string',required:true},entityId:{type:'string',required:true},expectedGeneration:{type:'integer',required:true},expectedSceneRevision:{type:'integer',required:true},
  operation:{oneOf:[{type:'string',const:'hover'},{type:'string',const:'goto'},{type:'string',const:'land'},{type:'string',const:'stop'},{type:'string',const:'reset'},{type:'string',const:'status'}],required:true},
  positionM:{type:'array',items:{type:'number'}},yawRad:{type:'number'},maxDurationS:{type:'number'},landingSurfaceZ:{type:'number'},background:{type:'boolean'},
}}}
type FlightCommandInput=Omit<FlightInput,'operation'>&{operation:FlightInput['operation']|'stop'|'reset'|'status';background?:boolean}
/** 只规范可选缺省字段与有符号零；非finite和数组缺项仍拒绝，不放宽工具无损 JSON 闸。 */
function publicValue(value:unknown){return JSON.parse(JSON.stringify(value,function(_key,item){if(typeof item==='number'){if(!Number.isFinite(item))throw new Error('FLIGHT_NONFINITE_RECEIPT');return item===0?0:item}if(item===undefined&&Array.isArray(this))throw new Error('FLIGHT_MISSING_ARRAY_ITEM');return item}))}
export function flightSummary(value:any){return {status:value.status,taskAchieved:value.taskAchieved,reason:value.reason,operation:value.operation,worldId:value.worldId,generation:value.generation,sceneRevision:value.sceneRevision,target:value.target,actions:value.actions,maxTiltRad:value.maxTiltRad,source:value.source,stopped:value.stopped,controllerStatus:value.controllerStatus,jobId:value.jobId,world:value.world,after:value.after?{frameId:value.after.frameId,step:value.after.stepIndex,position:value.after.entities?.[0]?.transform?.position}:undefined,stop:value.stop}}
export function applyFlight(ctx:Context){
 const description="Local native flight control using the fixed Crazyflie2 physical thrust/torque PID: MuJoCo hover, world-frame XYZ in meters/yaw, and small controlled landings. input contains worldId/entityId/expectedGeneration/expectedSceneRevision and operation. This is not scene_edit translation, a learned policy, or a four-motor RPM/PX4 bridge. hover/goto are limited to 30 seconds and remove thrust on completion; continuous hovering requires maintaining flight-control windows. land requires an explicit landingSurfaceZ, the current world ground height in meters. stop cancels the controller and future output; reset resets the entire same-session physics world without editing the Scene or model. Reject missing real mappings/free roots/verified provenance. Generic and Isaac flight control remain separately unverified."
 const perform=async(input:FlightCommandInput,parent:Partial<ToolExecution>,signal:AbortSignal)=>{
  const errors=validateArgs(parameters,{input});if(errors.length)throw new ToolArgsError(errors)
  const sim=simWorldsFor(ctx,parent.agent)
  const world=(await sim.listWorlds()).find(w=>w.worldId===input.worldId)
  if(!world||world.worldGeneration!==input.expectedGeneration||world.appliedSceneRevision!==input.expectedSceneRevision)throw new Error('FLIGHT_WORLD_MISMATCH')
  if(input.operation==='status')return flightStatus(sim,input.worldId,input.entityId,input.expectedGeneration)
  if(input.operation==='stop')return {operation:'stop',...await stopFlight(sim,input.worldId,input.entityId,input.expectedGeneration)}
  if(input.operation==='reset'){
   // 明确的全世界复位；先从实际 owner 撤控制，不改用户 Scene 原始位姿。
   await sim.stop(input.worldId,{expectedGeneration:input.expectedGeneration})
   await stopFlight(sim,input.worldId,input.entityId,input.expectedGeneration)
   const snapshot=await sceneOperationsFor(ctx,parent.agent).scene.snapshot(world.sceneId)
   if(snapshot.revision!==input.expectedSceneRevision)throw new Error('FLIGHT_SCENE_CHANGED')
   const next=await sim.sync(input.worldId,snapshot,{forceRebuild:true})
   return {operation:'reset',status:'completed',world:next,after:await sim.observe(input.worldId,{entityIds:[input.entityId],sensors:true,contacts:true})}
  }
  const request=input as FlightInput
  if(input.background===false)return summarizeFlight(await runFlight(sim,request,signal))
  if(signal.aborted)throw signal.reason??new Error('Cancelled before background Job registration')
  const controller=new AbortController()
  const jobId=ctx.jobs.start({kind:'lyapunov-provider' as never,label:'Crazyflie 本地飞控',owner:parent.agent?.id,outputLimitBytes:2000000,run:()=>({cancel:()=>controller.abort(),done:runFlight(sim,request,controller.signal).then(value=>({status:value.status==='cancelled'?'killed' as const:value.status==='completed'?'completed' as const:'failed' as const,result:JSON.stringify(flightSummary(value))}),error=>({status:controller.signal.aborted?'killed' as const:'failed' as const,result:String(error)}))})})
  return {operation:input.operation,status:'running',jobId,worldId:input.worldId,generation:input.expectedGeneration,sceneRevision:input.expectedSceneRevision}
 }
 ctx.tools.register(defineTool({name:'robot_flight',description,parameters,output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async(args,exec)=>publicValue(await perform(args.input as unknown as FlightCommandInput,exec,exec.signal))}))
 ctx.commands.register({name:'robot_flight',description,input:{hint:"JSON containing the current world/instance/generation/revision/operation; this is not visual translation."},handler:async invocation=>{
  try{return {kind:'success',text:JSON.stringify(publicValue(await perform(JSON.parse(invocation.rawInput),{agent:invocation.agent},invocation.signal)))}}
  catch(error){return {kind:'error',text:String(error)}}
 }})
}
