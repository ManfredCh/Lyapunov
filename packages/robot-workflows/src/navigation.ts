import type { SimWorlds } from '../../sim-contract/src/index.ts'
import type { ActionReceipt } from '../../lyapunov-contracts/src/types.ts'
import { planFleetNavigation, fleetNavigationStep } from './fleet/fleet-navigation.ts'
import type { FleetPoint, FleetPathObstacle } from './fleet/fleet-path.ts'
import { assertIdentity, confirmStop, settledObservation, type RequestIdentity, type StopOutcome } from './workflow-evidence.ts'
import { randomUUID } from 'node:crypto'
export interface NavigateInput { worldId: string; entityId: string; goal: FleetPoint; bounds: { min: FleetPoint; max: FleetPoint }; obstacles: FleetPathObstacle[]; clearanceM: number; speedMps: number; maxDurationS: number; toleranceM?: number; actionPrefix?: string }
/**
 * 有界确定性导航，轨迹仍由唯一模拟 owner 推进；不创建Fleet Agent/Goal数据库。
 * 到达后的停止必须被确认（吞掉 stop 错误不算完成）；观测/回执与终态追加观测都必须与本次身份一致，
 * 失败用最后实际帧时必须注明 afterSource:'last-known'。
 */
export async function navigate(sim: SimWorlds, input: NavigateInput, signal?: AbortSignal) {
  const before=await sim.observe(input.worldId),robot=before.entities.find(e=>e.entityId===input.entityId)!, description=await sim.describe(input.worldId,input.entityId)
  const controller=description.controller as any
  if(controller?.type!=='vehicle')throw new Error('UNSUPPORTED_CAPABILITY: 需要SI车辆控制配置')
  const plan=planFleetNavigation({start:[robot.transform.position[0],robot.transform.position[1]],goal:input.goal,bounds:input.bounds,obstacles:input.obstacles,clearanceM:input.clearanceM,gridM:.1})
  if(!plan.ok)return {status:'failed',taskAchieved:false,reason:plan.reason,before}
  const identity:RequestIdentity={worldId:input.worldId,generation:before.generation}
  const actions:ActionReceipt[]=[];let waypointIndex=0,last=before;const prefix=input.actionPrefix??randomUUID()
  let stopOutcome:StopOutcome|undefined
  // 一次调用只发一次停止请求；必须携带本次请求的 expectedGeneration，世界已换代时拒绝而不是去停止新一代动作。
  const settle=async()=>stopOutcome??=await confirmStop(sim,input.worldId,{entityIds:[input.entityId],expectedGeneration:identity.generation})
  const observeRequest=async()=>{const frame=await sim.observe(input.worldId);assertIdentity('观测',frame,identity);last=frame;return frame}
  const failureAfter=async()=>{const stop=await settle();return {stop,...await settledObservation(sim,input.worldId,identity,last)}}
  try{
    for(let i=0;i<Math.ceil(input.maxDurationS/.1);i++){
      if(signal?.aborted)throw new Error('CANCELLED')
      const frame=await observeRequest(),state=frame.entities.find(e=>e.entityId===input.entityId)!, [x,y,z,w]=state.transform.quaternion
      const yaw=Math.atan2(2*(w*z+x*y),1-2*(y*y+z*z))
      const step=fleetNavigationStep({pose:{x:state.transform.position[0],y:state.transform.position[1],yaw},goal:input.goal,path:plan.points,waypointIndex,obstacles:input.obstacles,clearanceM:input.clearanceM,speedLimit:1,goalToleranceM:input.toleranceM??.06,minimumTurningRadiusM:controller.steering?controller.wheelbaseM/Math.tan(.55):undefined,minimumArcForward:.3})
      waypointIndex=step.waypointIndex
      if(step.done){
        const stop=await settle()
        if(!stop.confirmed)return {status:'failed',taskAchieved:false,reason:'STOP_NOT_CONFIRMED',stop,before,path:plan.points,actions,...await settledObservation(sim,input.worldId,identity,last)}
        // 终态观测必须仍是本次请求身份：fresh observe 不得自动更换本次目标代次。
        try{const after=await observeRequest();return {status:'completed',taskAchieved:true,stop,before,after,afterSource:'fresh',path:plan.points,actions}}
        catch(error){
          const message=String(error)
          if(message.includes('STALE_GENERATION'))return {status:'failed',taskAchieved:false,reason:'STALE_GENERATION',stop,before,after:last,afterSource:'last-known',observationError:message,path:plan.points,actions}
          return {status:'completed',taskAchieved:true,stop,before,after:last,afterSource:'last-known',observationError:message,path:plan.points,actions}
        }
      }
      if(step.needsReplan)throw new Error('PATH_BLOCKED: '+step.blockedBy)
      const command=controller.steering?{steeringAngleRad:step.turn*(controller.steering.rangeRad?.[1]??.55)}:{yawRateRadps:step.turn}
      const receipt=await sim.execute(input.worldId,{kind:'vehicle',entityId:input.entityId,actionId:prefix+'-'+i,expectedGeneration:identity.generation,speedMps:step.forward*input.speedMps,...command,durationS:.1},signal)
      actions.push(receipt)
      // 回执来源必须与本次请求一致；非 completed（含 cancelled/STOP_CONFIRMED）必须停止后续提交。
      if(receipt.worldId!==input.worldId||receipt.generation!==identity.generation)return {status:'failed',taskAchieved:false,reason:'RECEIPT_SOURCE_MISMATCH',before,path:plan.points,actions,...await failureAfter()}
      if(receipt.status!=='completed')return {status:receipt.status==='cancelled'?'cancelled':'failed',taskAchieved:false,reason:receipt.reason??receipt.status,before,path:plan.points,actions,...await failureAfter()}
    }
    return {status:'failed',taskAchieved:false,reason:'NAVIGATION_TIME_LIMIT',before,actions,path:plan.points,...await failureAfter()}
  }catch(error){
    return {status:signal?.aborted?'cancelled':'failed',taskAchieved:false,reason:String(error),before,path:plan.points,actions,...await failureAfter()}
  }finally{await settle()}
}
