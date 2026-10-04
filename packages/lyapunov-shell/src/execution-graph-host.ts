/** Shell在原生hook上的观察、只读恢复与有界交接；工具内容及取消均留给原owner。 */
import type {Context} from '@deepseek-ai/cordis'
import type {Agent,AssistantStreamFrame} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'
import {createUserMessage,type ContentBlock} from '@deepseek-ai/dsh-llm'
import {SessionId,type Session} from '@deepseek-ai/dsh-session'
import type {ToolExecution,ToolExecutionResult} from '@deepseek-ai/dsh-tools'
import {defineTool} from '@deepseek-ai/dsh-tools'
import {z} from 'zod'
import {isHumanDirectedSource} from './conversation-history.ts'
import {executionStatusSummary} from './execution-status-summary.ts'
import {emptyExecutionGraph,foldExecutionGraph,rebuildExecutionGraph,imageFacts,observationHash,publicCodeFromText,publicDiagnostic,publicFacts,reconcileJobs,recoveryDecision,requestDiagnostics,type ToolObservation,type PublicDiagnostic} from './execution-graph.ts'

declare module '@deepseek-ai/dsh-llm' {
 interface MessageSourceMap {
  'lyapunov-recovery':{kind:'lyapunov-recovery';form:'notice';summary:string}
 }
}

const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}
export interface GraphConfig {recoveryBudget?:number;maxNodes?:number}
export interface ModelProgress {attemptId:string;turn:number;step:number;phase:'request'|'stream'|'retry-wait'|'terminal'|'abandoned';phaseStartedAt:number;startedAt:number;lastProgressAt:number;chunks:number;textChars:number;argumentChars:number;partialTools:string[];finishCode:string|null;phaseFailureCode:string|null;usagePresent:boolean;retry:number;maxRetries:number|null;upstreamStatus:number|null;requestId:string|null;diagnostic:PublicDiagnostic|null}

/** 单次副作用观察从最终结果派生；不改变原ContentBlock或读Job输出。 */
export function toolObservation(exec:Readonly<ToolExecution>,result:Readonly<ToolExecutionResult>,hostInstanceId:string,ctx:Context):ToolObservation{
 const agent=exec.agent!,events=agent.session.snapshotEvents(),boundary=events.findLast(event=>event.type==='step/start')
 const args=typeof exec.arguments==='string'?parseJson(exec.arguments):exec.arguments,value=result.isError?{}:result.value
 const info=result.isError?result.error.info:undefined
 const processUnknown=exec.name==='bash'&&(object(value).timedOut===true||object(value).aborted===true||typeof object(value).signal==='string')
 const diagnostic=processUnknown?publicDiagnostic({code:object(value).timedOut===true?'PROCESS_TIMEOUT':'PROCESS_INTERRUPTED',stage:'process_execution',effect:'unknown',retryable:false}):publicDiagnostic(value,info?.code??(result.isError?publicCodeFromText(result.error.message):undefined))
 const raw=object(value),nested=object(typeof raw.result==='string'?parseJson(raw.result):raw.result),jobId=typeof raw.jobId==='string'?raw.jobId:typeof nested.jobId==='string'?nested.jobId:null
 const live=jobId?ctx.jobs.list(agent.id).find(row=>row.id===jobId):undefined
 const call=events.findLast(event=>event.type==='tool/call'&&event.data.callId===exec.callId)
 return {callId:String(exec.callId),rootCallId:String(exec.rootCallId),name:exec.name,turn:boundary?.type==='step/start'?boundary.data.turn:0,step:boundary?.type==='step/start'?boundary.data.step:0,
  argumentsHash:observationHash(typeof exec.arguments==='string'?exec.arguments:JSON.stringify(exec.arguments)),target:publicFacts(args,true),facts:{...publicFacts(value,true),...publicFacts(value)},diagnostic,
  images:imageFacts(result.content),job:live?{jobId:String(live.id),registryId:live.registryId??null,hostInstanceId,startedAt:live.startedAt,callId:String(exec.callId),callSeq:call?Number(call.seq):null,seq:call?Number(call.seq):0,status:live.status}:null,
  isError:result.isError||processUnknown,late:exec.signal.aborted||ctx.agents.get(agent.id)!==agent,waited:object(args).wait===true}
}
function parseJson(value:string):unknown{try{return JSON.parse(value)}catch{return {}}}

/** 只有当前原生call归属的状态读计入恢复；UI/directctx轮询不追加事件。 */
function nativeStatusObservation(exec:Readonly<ToolExecution>,result:Readonly<ToolExecutionResult>,ctx:Context,graph:ReturnType<typeof emptyExecutionGraph>):ToolObservation|null{
 const agent=exec.agent!
 if(agent.status!=='running'||ctx.agents.get(agent.id)!==agent)return null
 const events=agent.session.snapshotEvents(),started=events.findLast(event=>event.type==='tool/call'&&event.data.callId===exec.callId&&event.data.name===exec.name||event.type==='tool/ptc-dispatch-start'&&event.data.subCallId===exec.callId&&event.data.name===exec.name&&event.data.rootCallId===exec.rootCallId)
 if(!started)return null
 const call=started.type==='tool/call'?started:events.findLast(event=>event.type==='tool/call'&&event.data.callId===exec.rootCallId)
 const node=graph.nodes.find(row=>row.id===`tool:${exec.callId}`)
 if(call?.type!=='tool/call'||call.data.turn!==graph.turn||call.data.step!==graph.step||node?.status!=='running'||node.seq!==Number(started.seq))return null
 const jobs=ctx.jobs.list(agent.id),ownerStateHash=observationHash(jobs.map(job=>({id:String(job.id),registryId:job.registryId??null,startedAt:job.startedAt,status:job.status})).sort((a,b)=>a.id.localeCompare(b.id)))
 const prior=graph.nodes.findLast(row=>row.kind==='tool'&&row.label==='execution_status'&&row.seq>=graph.recovery.userSeq&&typeof row.facts.ownerStateHash==='string')
 // 不从summary/full读取phase/asOf/step/recentOutcomes；首次只建立owner基线，不能伪造目标进展。
 return {callId:String(exec.callId),rootCallId:String(exec.rootCallId),name:exec.name,turn:graph.turn,step:graph.step,argumentsHash:observationHash(typeof exec.arguments==='string'?exec.arguments:JSON.stringify(exec.arguments)),target:{},facts:{status:jobs.some(job=>job.status==='running'||job.status==='stopping')?'running':'idle',ownerStateHash,ownerProgress:prior!==undefined&&prior.facts.ownerStateHash!==ownerStateHash},diagnostic:result.isError?publicDiagnostic({},result.error.info?.code??publicCodeFromText(result.error.message)??undefined):null,images:[],job:null,isError:result.isError,late:exec.signal.aborted,waited:false}
}

/** @param ctx - 已装配原生Session/Loop/Tools的Shell。 @param hostInstanceId - 本Shell Host代次。 @param config - 部署恢复预算及图裁剪。 @returns 同owner的只读诊断读取函数。 */
export function applyExecutionGraph(ctx:Context,hostInstanceId:string,config:GraphConfig={}){
 const budget=config.recoveryBudget??3,maxNodes=config.maxNodes??400
 if(!Number.isSafeInteger(budget)||budget<1||!Number.isSafeInteger(maxNodes)||maxNodes<10||maxNodes>5000)throw Error('INVALID_GRAPH_CONFIGURATION')
 const registry=ctx.get('sessionProjections')
 if(!registry)throw Error('SESSION_PROJECTION_REQUIRED: 执行图需要原生会话投影')
 const factsSchema=z.record(z.string(),z.union([z.string().max(128),z.number().finite(),z.boolean()]))
 const jobSchema=z.object({jobId:z.string(),registryId:z.string().nullable(),hostInstanceId:z.string().nullable(),startedAt:z.number().nullable(),callId:z.string().nullable(),callSeq:z.number().nullable(),seq:z.number(),status:z.string()}).strict()
 const contextSchema=z.object({owner:z.string().max(128),form:z.string(),bytes:z.number().nonnegative(),hash:z.string().length(64),images:z.number().nonnegative(),sections:z.array(z.object({name:z.string().max(128),bytes:z.number().nonnegative(),hash:z.string().length(64)}).strict())}).strict()
 const diagnosticSchema=z.object({code:z.string(),stage:z.string().nullable(),fieldPath:z.string().nullable(),retryable:z.boolean().nullable(),effect:z.enum(['none','committed','released','reserved','charged','unknown']),requestId:z.string().nullable(),upstreamHttpStatus:z.number().int().min(100).max(599).optional(),upstreamFailureCode:z.string().max(128).optional()}).strict().nullable()
 const requestSchema=z.object({turn:z.number(),step:z.number(),provider:z.string(),model:z.string(),messageCount:z.number(),imageCount:z.number(),toolCount:z.number(),toolsBytes:z.number(),toolsHash:z.string().length(64),contexts:z.array(contextSchema),basis:z.literal('harness-before-adapter')}).strict()
 const schema=z.object({version:z.literal(1),sessionId:z.string(),asOfSeq:z.number(),turn:z.number(),step:z.number(),omittedNodes:z.number(),nodes:z.array(z.object({id:z.string(),parent:z.string().nullable(),kind:z.string(),label:z.string(),seq:z.number(),at:z.number(),status:z.enum(['running','success','failed','cancelled','unknown','waiting']),code:z.string().nullable(),images:z.number(),facts:factsSchema,diagnostic:diagnosticSchema}).strict()).max(maxNodes),jobs:z.array(jobSchema).max(128),request:requestSchema.nullable(),recovery:z.object({userSeq:z.number(),stagnant:z.number(),waitingQueries:z.number(),factsHash:z.string(),factsSeen:z.array(z.string().length(64)).max(128).optional(),goalBest:z.record(z.string().length(64),z.number().finite()).optional(),goalError:z.number().nullable(),lastCode:z.string().nullable(),handoffSeq:z.number().nullable(),unknown:z.array(z.object({callId:z.string(),argumentsHash:z.string(),name:z.string(),seq:z.number()}).strict()).max(128)}).strict()}).strict()
 ctx.effect(()=>registry.register({key:'lyapunovGraph',stateVersion:4,stateSchema:schema,init:header=>emptyExecutionGraph(header),apply:(state,event,checkout)=>{
  if(event.type==='session/history-checkout'&&checkout)return rebuildExecutionGraph({id:SessionId(state.sessionId)},checkout,maxNodes)
  return foldExecutionGraph(state,event,maxNodes)
 }}),'执行图投影注册')
 const modelProgress=new WeakMap<Agent,ModelProgress>()
 const graphOf=(session:Session)=>{const value=registry.stateOf(session,'lyapunovGraph');if(!value)throw Error('GRAPH_PROJECTION_REQUIRED');return value}
 const snapshot=(agent:Agent)=>{
  const graph=graphOf(agent.session),progress=modelProgress.get(agent),currentJobs=ctx.jobs.list(agent.id)
  return {graph,hostInstanceId,jobs:reconcileJobs(graph.jobs,currentJobs),model:progress?{...progress,noProgressWaitMs:Math.max(0,Date.now()-progress.lastProgressAt),basis:'native-stream' as const}:null,
   liveJobCount:currentJobs.filter(job=>job.status==='running'||job.status==='stopping').length,stop:{agentStatus:agent.status,jobs:currentJobs.map(job=>({id:job.id,registryId:job.registryId??null,startedAt:job.startedAt,status:job.status})),physicalStop:'Requires separate confirmation by the Sim owner',unknownEffects:graph.recovery.unknown.length}}
 }
 const handoff=(agent:Agent,turn:number,step:number,waiting:boolean)=>{
  const graph=graphOf(agent.session)
  if(graph.recovery.handoffSeq!==null)return
  const code=waiting?'ASYNC_WAIT_PENDING':'RECOVERY_NO_PROGRESS'
  agent.session.append('lyapunov/recovery-handoff',{turn,step,code,stagnant:graph.recovery.stagnant,waiting},{ignorable:true})
  agent.session.append('user/message',createUserMessage({content:[{type:'text',text:waiting?'The Job is still running. Repeated polling has stopped. Read the terminal result using the original Job identity; do not resubmit an operation with unconfirmed effects.':`Automatic recovery stopped (${graph.recovery.lastCode??'NO_NEW_FACTS'}). Read the current state from the original resource, world, or Job owner, then continue from new facts within the existing authorization.`}],source:{kind:'lyapunov-recovery',form:'notice',summary:waiting?'Job waiting':'Recovery handoff'}}),{surfaceOp:'append'})
  // disarm只撤自动续轮，不改变Goal phase或伪造完成；工具/Jobs/Sim各自清理。
  ctx.get('goals')?.disarm(agent)
  agent.cancel({kind:'hook',reason:code},{keepInbox:true})
 }
 ctx.on('agent/pre-step',async(payload,next)=>{
  const decision=await next()
  if(decision.kind==='reject'||payload.messages.some(message=>isHumanDirectedSource(message.source)))return decision
  const action=recoveryDecision(graphOf(payload.agent.session),budget)
  if(action!=='continue'){handoff(payload.agent,payload.turn,payload.step,action==='waiting');return {kind:'reject'}}
  return decision
 })
 ctx.on('tools/pre-execute',async(exec,next)=>{
  if(exec.agent){
   if(exec.name==='job_output'||exec.name==='job_kill'){
    const args=object(typeof exec.arguments==='string'?parseJson(exec.arguments):exec.arguments),jobId=String(args.job_id??'')
    const live=ctx.jobs.list(exec.agent.id).find(job=>job.id===jobId),receipt=graphOf(exec.agent.session).jobs.findLast(job=>job.jobId===jobId)
    const explicitlyCurrent=typeof args.registry_id==='string'&&args.registry_id===live?.registryId
    if(!explicitlyCurrent&&(!live||!receipt||receipt.registryId===null||receipt.registryId!==live.registryId||receipt.startedAt!==live.startedAt))return {kind:'deny',reason:'The recorded Job identity does not match the current instance. Use execution_status to check the identity before reading or stopping a Job with the same name.',info:{name:'JobInstanceUnknown',code:'JOB_INSTANCE_UNKNOWN'}}
   }
   const hash=observationHash(typeof exec.arguments==='string'?exec.arguments:JSON.stringify(exec.arguments))
   const unknown=graphOf(exec.agent.session).recovery.unknown.find(row=>row.name===exec.name&&row.argumentsHash===hash)
   if(unknown)return {kind:'deny',reason:'The effects of the earlier identical operation are unconfirmed. Read its status from the original owner before resubmitting it.',info:{name:'RecoveryReadbackRequired',code:'RECOVERY_READBACK_REQUIRED'}}
  }
  return next()
 })
 ctx.on('tools/result',(exec,result)=>{
  if(!exec.agent)return
  const value=exec.name==='execution_status'?nativeStatusObservation(exec,result,ctx,graphOf(exec.agent.session)):toolObservation(exec,result,hostInstanceId,ctx)
  if(!value)return
  exec.agent.session.append('lyapunov/tool-observation',value,{ignorable:true})
 })
 ctx.on('llm/stream',async function*(request,next){
  const agent=request.sessionId?ctx.agents.get(SessionId(String(request.sessionId))):undefined
  if(agent){const graph=graphOf(agent.session);agent.session.append('lyapunov/request-diagnostics',requestDiagnostics(request,graph.turn,graph.step),{ignorable:true})}
  yield* next()
 })
 ctx.on('agent/assistant-stream',({agent,frame})=>{
  if(ctx.agents.get(agent.id)!==agent)return
  updateModelProgress(modelProgress,agent,frame)
 })
 ctx.on('session/event',(session,event)=>{
  const agent=ctx.agents.get(session.id),value=agent?modelProgress.get(agent):undefined
  if(!value)return
  if(event.type==='llm/retry'){value.phase='retry-wait';value.retry=event.data.retry;value.maxRetries=event.data.mode==='normal'?event.data.maxRetries:null}
  else if(event.type==='turn/end'&&event.data.turn===value.turn){value.phase='terminal';value.phaseFailureCode=event.data.reason.kind==='error'?event.data.reason.error.code:null}
 })
 ctx.tools.register(defineTool({name:'execution_status',description:'Read-only status of the current session model phase, existing Job identities, and execution results. Acceptance does not imply completion. The default summary is bounded; request detail="full" only when the complete graph is needed. Operations with unconfirmed effects on an earlier Host are not resubmitted.',parameters:{detail:{type:'string',enum:['summary','full'],description:'Optional detail level. The default summary contains bounded status and original operation identities.'}},
  output:{schema:{type:'object',additionalProperties:false,properties:{result:{type:'string',required:true}}},render:(_args,value)=>[{type:'text',text:String(value.result)}]},
  async execute(args,exec){if(!exec.agent)throw Error('SESSION_REQUIRED');const value=snapshot(exec.agent);return {result:args.detail==='full'?JSON.stringify(value):executionStatusSummary(value)}}}))
 return snapshot
}

function updateModelProgress(values:WeakMap<Agent,ModelProgress>,agent:Agent,frame:AssistantStreamFrame){
 if(frame.type==='start'){const prior=values.get(agent);values.set(agent,{attemptId:String(frame.attemptId),turn:frame.turn,step:frame.step,phase:'request',phaseStartedAt:prior?.turn===frame.turn&&prior.step===frame.step?prior.phaseStartedAt:Date.now(),startedAt:Date.now(),lastProgressAt:Date.now(),chunks:0,textChars:0,argumentChars:0,partialTools:[],finishCode:null,phaseFailureCode:null,usagePresent:false,retry:prior?.turn===frame.turn&&prior.step===frame.step?prior.retry:0,maxRetries:prior?.maxRetries??null,upstreamStatus:null,requestId:null,diagnostic:null});return}
 const value=values.get(agent);if(!value||value.attemptId!==String(frame.attemptId))return
 if(frame.type==='end'){value.phase=frame.outcome.kind==='abandoned'?'abandoned':'terminal';return}
 value.chunks+=1
 const chunk=frame.chunk
 let advanced=false
 if(chunk.type==='text-delta'||chunk.type==='reasoning-delta'){value.textChars+=chunk.text.length;advanced=chunk.text.length>0}
 else if(chunk.type==='tool-call-delta'){value.argumentChars+=chunk.argumentsDelta.length;if(chunk.name&&!value.partialTools.includes(chunk.name)){value.partialTools.push(chunk.name);advanced=true}advanced||=chunk.argumentsDelta.length>0}
 else if(chunk.type==='usage')value.usagePresent=true
 else if(chunk.type==='finish'){value.phase='terminal';value.finishCode=chunk.reason.kind==='error'||chunk.reason.kind==='aborted'?chunk.reason.failure.code:null;if(chunk.reason.kind==='error'||chunk.reason.kind==='aborted'){const failure=object(chunk.reason.failure);value.diagnostic=publicDiagnostic(failure.diagnostic);value.upstreamStatus=typeof failure.status==='number'?failure.status:null;value.requestId=value.diagnostic?.requestId??(typeof failure.requestId==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(failure.requestId)?failure.requestId:null)}}
 if(advanced){value.phase='stream';value.lastProgressAt=frame.time}
}
