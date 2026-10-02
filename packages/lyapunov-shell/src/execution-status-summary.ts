/** 模型默认读少量公开事实；完整图仍由唯一projection/UI或显式full请求提供。 */
import type {applyExecutionGraph} from './execution-graph-host.ts'
type Snapshot=ReturnType<ReturnType<typeof applyExecutionGraph>>
export const EXECUTION_STATUS_SUMMARY_MAX_BYTES=4096

/** @returns 有界summary字符串；不丢身份后假称完成，裁剪始终保计数与明确遗漏。 */
export function executionStatusSummary(value:Snapshot):string{
 const graph=value.graph,model=value.model
 const outcomes=graph.nodes.filter(node=>['tool','model','service','handoff'].includes(node.kind)&&node.status!=='running').slice(-4).map(node=>({seq:node.seq,kind:node.kind,name:node.label,status:node.status,code:node.code,diagnostic:node.diagnostic}))
 const current=[...value.stop.jobs].sort((a,b)=>Number(['running','stopping'].includes(b.status))-Number(['running','stopping'].includes(a.status))).slice(0,8)
 const old=value.jobs.filter(job=>!job.matched).slice(-4).map(job=>({jobId:job.jobId,registryId:job.registryId,startedAt:job.startedAt,currentStatus:'unknown',matched:false}))
 const unknown=graph.recovery.unknown.slice(-4).map(item=>({name:item.name,callId:item.callId,seq:item.seq}))
 const summary={version:1,detail:'summary',sessionId:graph.sessionId,hostInstanceId:value.hostInstanceId,asOfSeq:graph.asOfSeq,turn:graph.turn,step:graph.step,
  model:model?{phase:model.phase,code:model.phaseFailureCode??model.finishCode,retry:model.retry,maxRetries:model.maxRetries,requestId:model.requestId,diagnostic:model.diagnostic,noProgressWaitMs:model.noProgressWaitMs,partialToolCount:model.partialTools.length}:null,
  jobs:{currentCount:value.stop.jobs.length,activeCount:value.liveJobCount,current,unmatchedCount:value.jobs.filter(job=>!job.matched).length,unmatched:old,omittedCurrent:Math.max(0,value.stop.jobs.length-current.length),omittedUnmatched:Math.max(0,value.jobs.filter(job=>!job.matched).length-old.length)},
  recovery:{handoff:graph.recovery.handoffSeq!==null,lastCode:graph.recovery.lastCode,stagnant:graph.recovery.stagnant,waitingQueries:graph.recovery.waitingQueries,unknownCount:graph.recovery.unknown.length,unknown,omittedUnknown:Math.max(0,graph.recovery.unknown.length-unknown.length)},
  recentOutcomes:outcomes,omittedOutcomes:Math.max(0,graph.nodes.filter(node=>['tool','model','service','handoff'].includes(node.kind)&&node.status!=='running').length-outcomes.length),nodeCount:graph.nodes.length,omittedNodes:graph.omittedNodes,
  stop:{agentStatus:value.stop.agentStatus,physicalStop:value.stop.physicalStop},more:'Use detail="full" only when the complete graph is needed; read the original owner to verify an unconfirmed operation.'}
 while(Buffer.byteLength(JSON.stringify(summary))>EXECUTION_STATUS_SUMMARY_MAX_BYTES){
  if(outcomes.length){outcomes.shift();summary.omittedOutcomes++;continue}
  if(old.length){old.shift();summary.jobs.omittedUnmatched++;continue}
  if(current.length>1){current.pop();summary.jobs.omittedCurrent++;continue}
  if(unknown.length>1){unknown.shift();summary.recovery.omittedUnknown++;continue}
  throw Error('EXECUTION_STATUS_SUMMARY_LIMIT_EXCEEDED')
 }
 return JSON.stringify(summary)
}
