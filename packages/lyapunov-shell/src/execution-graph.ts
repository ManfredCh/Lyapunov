/** 原生日志的只读执行图和恢复水位；不持有执行器、Goal或领域可变状态。 */
import {createHash} from 'node:crypto'
import type {ContentBlock,GenerateOptions} from '@deepseek-ai/dsh-llm'
import type {SessionEvent,SessionHeader} from '@deepseek-ai/dsh-session'
import type {JobView} from '@deepseek-ai/dsh-jobs'
import {isHumanDirectedSource} from './conversation-history.ts'

export type PublicFact=string|number|boolean
export interface PublicDiagnostic {code:string;stage:string|null;fieldPath:string|null;retryable:boolean|null;effect:'none'|'committed'|'released'|'reserved'|'charged'|'unknown';requestId:string|null;upstreamHttpStatus?:number;upstreamFailureCode?:string}
export interface GraphNode {id:string;parent:string|null;kind:string;label:string;seq:number;at:number;status:'running'|'success'|'failed'|'cancelled'|'unknown'|'waiting';code:string|null;images:number;facts:Record<string,PublicFact>;diagnostic:PublicDiagnostic|null}
export interface JobReceipt {jobId:string;registryId:string|null;hostInstanceId:string|null;startedAt:number|null;callId:string|null;callSeq:number|null;seq:number;status:string}
export interface ToolObservation {callId:string;rootCallId:string;name:string;turn:number;step:number;argumentsHash:string;target:Record<string,PublicFact>;facts:Record<string,PublicFact>;diagnostic:PublicDiagnostic|null;images:string[];job:JobReceipt|null;isError:boolean;late:boolean;waited:boolean}
export interface RequestContextFact {owner:string;form:string;bytes:number;hash:string;images:number;sections:{name:string;bytes:number;hash:string}[]}
export interface RequestDiagnostics {turn:number;step:number;provider:string;model:string;messageCount:number;imageCount:number;toolCount:number;toolsBytes:number;toolsHash:string;contexts:RequestContextFact[];basis:'harness-before-adapter'}
export interface RecoveryWindow {userSeq:number;stagnant:number;waitingQueries:number;factsHash:string;factsSeen?:string[];goalBest?:Record<string,number>;goalError:number|null;lastCode:string|null;handoffSeq:number|null;unknown:{callId:string;argumentsHash:string;name:string;seq:number}[]}
export interface ExecutionGraph {version:1;sessionId:string;asOfSeq:number;turn:number;step:number;nodes:GraphNode[];omittedNodes:number;jobs:JobReceipt[];recovery:RecoveryWindow;request:RequestDiagnostics|null}

declare module '@deepseek-ai/dsh-session/types' {
 interface SessionEventMap {
  'lyapunov/tool-observation':ToolObservation
  'lyapunov/request-diagnostics':RequestDiagnostics
  'lyapunov/recovery-handoff':{turn:number;step:number;code:string;stagnant:number;waiting:boolean}
 }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
 interface SessionProjectionStateMap {lyapunovGraph:ExecutionGraph}
}

const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}
const digest=(value:unknown)=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex')
const publicId=(value:unknown):string|null=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value)&&!/^sk-/i.test(value)?value:null
const number=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)?value:null
const identityKeys=new Set(['sceneId','worldId','entityId','resourceId','clientId','resourceVersion','version'])
const progressKeys=new Set(['sceneRevision','revision','registryRevision','resourceVersion','worldGeneration','generation','stepIndex','jobStatus','phase','artifactAvailable','targetReached','taskAchieved','goalError','positionError','jointError','complete','verified','bytes','sha256','status'])

/** 仅提取领域公开水位，忽略时间戳、随机request/actionId、URL、路径及正文。 */
export function publicFacts(value:unknown,identity=false):Record<string,PublicFact>{
 const out:Record<string,PublicFact>={}
 const visit=(input:unknown,depth:number)=>{
  if(depth>5)return
  if(Array.isArray(input)){for(const row of input.slice(0,32))visit(row,depth+1);return}
  const record=object(input)
  for(const [key,item] of Object.entries(record)){
   if((identity?identityKeys:progressKeys).has(key)){
    if(typeof item==='boolean')out[key]=item
    else if(typeof item==='number'&&Number.isFinite(item))out[key]=item
    else if(typeof item==='string'&&item.length<=128&&/^[A-Za-z0-9_.:-]+$/.test(item)&&!/^sk-/i.test(item))out[key]=item
   }
   if(['input','progress','artifact','diagnostic','job','world','frame','resource','result','value','data'].includes(key)){
    if(typeof item==='string'&&item.length<=65536){try{visit(JSON.parse(item),depth+1)}catch{/* 非JSON正文不作为结构水位。 */}}
    else if(Array.isArray(item)){for(const child of item.slice(0,32))visit(child,depth+1)}
    else visit(item,depth+1)
   }
  }
 }
 visit(value,0)
 return Object.fromEntries(Object.entries(out).sort(([a],[b])=>a.localeCompare(b)))
}

/** 诊断的严格公开字段；未知费用/副作用不被归一成成功。 */
export function publicDiagnostic(value:unknown,fallbackCode?:unknown):PublicDiagnostic|null{
 const record=object(value),d=object(record.diagnostic??record),code=publicId(d.code??fallbackCode)
 if(!code)return null
 const path=typeof d.fieldPath==='string'&&d.fieldPath.length<=128&&/^[A-Za-z_][A-Za-z0-9_.\[\]]*$/.test(d.fieldPath)?d.fieldPath:null
 const effect=typeof d.effect==='string'&&['none','committed','released','reserved','charged','unknown'].includes(d.effect)?d.effect as PublicDiagnostic['effect']:'unknown'
 return {code,stage:publicId(d.stage),fieldPath:path,retryable:typeof d.retryable==='boolean'?d.retryable:null,effect,requestId:publicId(d.requestId),
  ...typeof d.upstreamHttpStatus==='number'&&Number.isSafeInteger(d.upstreamHttpStatus)&&d.upstreamHttpStatus>=100&&d.upstreamHttpStatus<=599?{upstreamHttpStatus:d.upstreamHttpStatus}:{},
  ...publicId(d.upstreamFailureCode)?{upstreamFailureCode:publicId(d.upstreamFailureCode)!}:{}}
}

/** 原始内容块只读；图仅保留图像身份，原图仍由Session/Attachment owner传给模型。 */
export function imageFacts(content:readonly ContentBlock[]):string[]{
 const out:string[]=[]
 for(const block of content){
  if(block.type==='image')out.push(String(block.attachment.attachmentId))
 }
 return out
}

/** 当前真实模型请求的来源/hash/体量摘要，不留任何文本或工具参数。 */
export function requestDiagnostics(request:GenerateOptions,turn:number,step:number):RequestDiagnostics{
 const contexts=request.messages.filter(message=>message.role==='system'||(message.role==='user'&&message.source!==undefined&&message.source.kind!=='user'&&message.source.kind!=='tool')).map(message=>{
  const source=object(message.source),owner=String(source.plugin??source.kind??'native-system')
  const content=message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')
  const sections=Array.isArray(source.sections)?source.sections.flatMap(item=>{const s=object(item);return typeof s.name==='string'&&typeof s.text==='string'?[{name:s.name.slice(0,128),bytes:Buffer.byteLength(s.text),hash:digest(s.text)}]:[]}):[]
  return {owner:owner.slice(0,128),form:String(source.form??message.role),bytes:Buffer.byteLength(content),hash:digest(content),images:imageFacts(message.content).length,sections}
 })
 const tools=JSON.stringify(request.tools??[])
 return {turn,step,provider:request.provider,model:request.model,messageCount:request.messages.length,imageCount:request.messages.reduce((sum,message)=>sum+imageFacts(message.content).length,0),toolCount:request.tools?.length??0,toolsBytes:Buffer.byteLength(tools),toolsHash:digest(tools),contexts,basis:'harness-before-adapter'}
}

/** 只有同provider代次、同startedAt的句柄才能关联实时Job；无关联的旧记录保持未知。 */
export function reconcileJobs(receipts:readonly JobReceipt[],snapshots:readonly JobView[]){
 return receipts.map(receipt=>{
  const live=snapshots.find(job=>job.id===receipt.jobId&&receipt.registryId!==null&&job.registryId===receipt.registryId&&job.startedAt===receipt.startedAt)
  return {...receipt,currentStatus:live?.status??'unknown',finishedAt:live?.finishedAt??null,matched:live!==undefined}
 })
}

/** @param header - 原生不可变Session头。 @returns 空日志图。 */
export function emptyExecutionGraph(header:Pick<SessionHeader,'id'>):ExecutionGraph{
 return {version:1,sessionId:String(header.id),asOfSeq:-1,turn:0,step:0,nodes:[],omittedNodes:0,jobs:[],request:null,recovery:{userSeq:-1,stagnant:0,waitingQueries:0,factsHash:'',factsSeen:[],goalBest:{},goalError:null,lastCode:null,handoffSeq:null,unknown:[]}}
}

/** 原生checkout引用原始seq前缀；窗口/可见节点回退，已发Job和未知副作用仍从完整日志保留。 */
export function rebuildExecutionGraph(header:Pick<SessionHeader,'id'>,events:readonly SessionEvent[],maxNodes=400):ExecutionGraph{
 let state=emptyExecutionGraph(header)
 const referenced=new Set(events.flatMap(row=>row.type==='session/history-checkout'?[Number(row.data.throughSeq)]:[]))
 const prefixes=new Map<number,ExecutionGraph>()
 for(const row of events){
  if(row.type==='session/history-checkout'){
   const cursor=row.data.throughSeq
   const selected=cursor===-1?emptyExecutionGraph(header):prefixes.get(Number(cursor))
   if(!selected||cursor>=row.seq)throw Error('GRAPH_HISTORY_CHECKOUT_INVALID')
   const jobs=[...state.jobs,...selected.jobs].filter((job,i,all)=>all.findLastIndex(other=>other.callId===job.callId)===i).slice(-128)
   const unknown=[...state.recovery.unknown,...selected.recovery.unknown].filter((fact,i,all)=>all.findLastIndex(other=>other.callId===fact.callId)===i).slice(-128)
   state={...selected,asOfSeq:Number(row.seq),jobs,recovery:{...selected.recovery,unknown}}
  }else state=foldExecutionGraph(state,row,maxNodes)
  if(referenced.has(Number(row.seq)))prefixes.set(Number(row.seq),state)
 }
 return state
}

/** 折叠原生提交事件；同seq幂等，history checkout由调用者给准确前缀重建。 */
export function foldExecutionGraph(state:ExecutionGraph,event:SessionEvent,maxNodes=400):ExecutionGraph{
 if(event.seq<=state.asOfSeq)return state
 const data=object(event.data),at=event.time,seq=Number(event.seq),type=String(event.type)
 let next={...state,asOfSeq:seq},node:GraphNode|undefined
 const add=(id:string,parent:string|null,kind:string,label:string,status:GraphNode['status']='success',code:string|null=null,facts:Record<string,PublicFact>={},images=0,diagnostic:PublicDiagnostic|null=null)=>{node={id,parent,kind,label,seq,at,status,code,facts,images,diagnostic}}
 const stepId=`step:${data.turn??next.turn}:${data.step??next.step}`
 if(type==='turn/start'){next.turn=Number(data.turn);next.step=0;add(`turn:${next.turn}`,null,'turn','turn','running')}
 else if(type==='step/start'){next.step=Number(data.step);add(stepId,`turn:${next.turn}`,'step','step','running')}
 else if(type==='user/message'&&isHumanDirectedSource(data.source))next.recovery={...emptyExecutionGraph({id:state.sessionId as SessionHeader['id']}).recovery,userSeq:seq,unknown:state.recovery.unknown}
 else if(type==='lyapunov/request-diagnostics'){next.request=event.data as RequestDiagnostics;add(`request:${seq}`,stepId,'request',String(data.model),'running')}
 else if(type==='tool/call'||type==='tool/ptc-dispatch-start')add(`tool:${data.callId??data.subCallId}`,stepId,'tool',String(data.name),'running',null,{argumentsHash:digest(data.arguments)})
  else if(event.type==='tool/result'){
  const message=event.data.message,content=message.content,callId=String(message.toolCallId),error=object(data.error),code=publicId(error.code)
  const id='tool:'+callId,prior=next.nodes.find(row=>row.id===id)
  const text=content.flatMap(part=>part.type==='text'?[part.text]:[]).join('\n'),timeout=text.match(/\[timed out after (\d+)ms\]/),signal=text.match(/\[killed by signal: (SIG[A-Z0-9]+)\]/),exit=text.match(/\[exit code: (-?\d+)\]/)
  const processFacts={...prior?.facts,...timeout?{timedOut:true,timeoutMs:Number(timeout[1])}:{},...signal?{killedSignal:signal[1]}:{},...exit?{exitCode:Number(exit[1])}:{}}
  add(id,prior?.parent??stepId,'tool',prior?.label??'tool',timeout||signal?'unknown':message.isError===true||exit&&Number(exit[1])!==0?'failed':'success',timeout?'PROCESS_TIMEOUT':code,processFacts,imageFacts(content).length,prior?.diagnostic??null)
  const legacyJob=content.flatMap(part=>part.type==='text'?[part.text]:[]).map(text=>text.match(/^started background job ([A-Za-z]+-\d+)$/)?.[1]).find(Boolean)
  if(legacyJob&&!next.jobs.some(job=>job.callId===callId))next.jobs=[...next.jobs,{jobId:legacyJob,registryId:null,hostInstanceId:null,startedAt:null,callId,callSeq:prior?.seq??null,seq,status:'unknown'}].slice(-128)
  if((code==='TOOL_OUTCOME_UNKNOWN'||(prior?.label==='bash'&&(timeout||signal)))&&prior?.facts.argumentsHash)next.recovery={...next.recovery,unknown:[...next.recovery.unknown.filter(row=>row.callId!==callId),{callId,argumentsHash:String(prior.facts.argumentsHash),name:prior.label,seq}].slice(-128)}
 }
 else if(type==='command/run')add(`command:${data.commandId}`,next.turn?`turn:${next.turn}`:null,'command',String(data.name),'running')
 else if(type==='command/done'){
  const id=`command:${data.commandId}`,prior=next.nodes.find(row=>row.id===id)
  add(id,prior?.parent??null,'command',prior?.label??'command',data.kind==='error'?'failed':'success',data.kind==='error'?publicCodeFromText(data.text):null)
 }
 else if(type==='assistant/message'||type==='assistant/attempt'){
  const stream=Array.isArray(data.stream)?data.stream:[],finish=stream.map(row=>object(object(row).chunk)).findLast(row=>row.type==='finish'),reason=object(finish?.reason),failure=object(reason.failure)
  const partial=stream.filter(row=>object(row).type==='tool-call-chunks').map(row=>object(row))
  const argumentsChars=partial.reduce((sum,row)=>sum+(Array.isArray(row.args)?row.args.reduce((n,x)=>n+String(x).length,0):0),0)
  add(`model:${seq}`,stepId,'model',type==='assistant/message'?'model':'attempt',data.interrupted===true||reason.kind==='aborted'?'cancelled':reason.kind==='error'?'failed':finish?'success':'unknown',publicId(failure.code),{partialCalls:partial.length,argumentsChars},imageFacts((object(data.message).content??[]) as ContentBlock[]).length,publicDiagnostic(failure.diagnostic))
  // 原 llm/stream 每个 attempt 通常有自己的诊断；只匹配当前 step 最近一条，失败旧 attempt 不覆盖。
  // 旧日志若仅记一次诊断，它代表该 step 的整个请求阶段；后续 attempt 仍各自保留终态。
  const request=next.nodes.findLast(row=>row.parent===stepId&&row.kind==='request')
  if(request)next.nodes=next.nodes.map(row=>row.id===request.id?{...row,status:node!.status,code:node!.code,diagnostic:node!.diagnostic}:row)
 }
 else if(type==='llm/retry'){add(`retry:${seq}`,stepId,'retry','retry','waiting',publicId(object(data.failure).code),{retry:Number(data.retry),...typeof data.maxRetries==='number'?{maxRetries:data.maxRetries}:{}})}
 else if(type==='llm/retry-started'){
  const retry=next.nodes.findLast(row=>row.parent===stepId&&row.kind==='retry'&&row.status==='waiting'&&row.facts.retry===data.retry)
  if(retry)next.nodes=next.nodes.map(row=>row.id===retry.id?{...row,status:'success'}:row)
 }
 else if(type==='lyapunov/tool-observation'){
  const observation=event.data as ToolObservation
  next.nodes=next.nodes.map(row=>row.id===`tool:${observation.callId}`?{...row,facts:{...row.facts,...observation.facts},diagnostic:observation.diagnostic??row.diagnostic}:row)
  const recovery=advanceRecovery(next.recovery,observation,seq)
  next.recovery=recovery
  if(observation.job){
   next.jobs=[...next.jobs.filter(job=>job.callId!==observation.job!.callId),observation.job].slice(-128)
   add(`job:${observation.job.registryId??'unknown'}:${observation.job.jobId}:${observation.job.startedAt??seq}`,`tool:${observation.callId}`,'job',observation.job.jobId,'waiting',null,{accepted:true})
  }
 }
 else if(type==='lyapunov/service-diagnostic'){
  const id=`tool:${data.callId}`,prior=next.nodes.find(row=>row.id===id)
  add(id,prior?.parent??stepId,'tool',prior?.label??'service',data.outcome==='success'?'success':'failed',publicId(data.code),prior?.facts??{},prior?.images??0,publicDiagnostic(data.diagnostic))
  next.nodes=replaceNode(next.nodes,node!,maxNodes)
  add(`service:${data.intentKey}`,id,'service','peiri',data.outcome==='success'?'success':'failed',publicId(data.code),{},0,publicDiagnostic(data.diagnostic))
 }
 else if(type==='lyapunov/recovery-handoff'){next.recovery={...next.recovery,handoffSeq:seq};add(`handoff:${seq}`,stepId,'handoff','recovery','waiting',publicId(data.code))}
 else if(type==='step/end'){
  const prior=next.nodes.find(row=>row.id===stepId),result=stepOutcome(next.nodes,stepId)
  add(stepId,prior?.parent??`turn:${data.turn}`,'step','step',result.status,result.code,prior?.facts??{},prior?.images??0,result.diagnostic)
  // 边界只说明结束；没有模型终态的请求保持未知，不能由 step/end 猜测成功。
  next.nodes=next.nodes.map(row=>row.parent===stepId&&(row.kind==='request'||row.kind==='retry')&&['running','waiting'].includes(row.status)?{...row,status:'unknown'}:row)
 }
 else if(type==='turn/end'){
  const reason=object(data.reason)
  add(`turn:${data.turn}`,null,'turn','turn',reason.kind==='error'?'failed':reason.kind==='aborted'||reason.kind==='interrupted'?'cancelled':reason.kind==='completed'?'success':['blocked','forked','max-tokens'].includes(String(reason.kind))?'waiting':'unknown',publicId(object(reason.error).code))
  const ending=node!,ownedSteps=new Set(next.nodes.filter(row=>row.kind==='step'&&row.parent===ending.id).map(row=>row.id)),diagnostic=publicDiagnostic(object(reason.error).diagnostic)
  next.nodes=next.nodes.map(row=>{
   const owned=row.kind==='step'&&row.parent===ending.id||row.kind==='request'&&ownedSteps.has(row.parent??'')
   const unknownEffect=row.diagnostic?.effect==='unknown'||row.kind==='step'&&next.nodes.some(child=>child.parent===row.id&&child.kind==='tool'&&(child.status==='unknown'||child.status==='running'||child.diagnostic?.effect==='unknown'))
   if(owned&&row.status==='running')return {...row,status:unknownEffect||ending.status==='success'?'unknown':ending.status,code:row.code??ending.code,diagnostic:row.diagnostic??diagnostic}
   // step/end 无结果的未知项可由同 turn 的失败/取消原因收口；旧 attempt 或未知副作用不改。
   if(owned&&row.status==='unknown'&&['failed','cancelled'].includes(ending.status)&&!unknownEffect)return {...row,status:ending.status,code:row.code??ending.code,diagnostic:row.diagnostic??diagnostic}
   if(row.kind==='retry'&&ownedSteps.has(row.parent??'')&&row.status==='waiting')return {...row,status:ending.status==='success'?'unknown':ending.status}
   return row
  })
 }
 if(node)next.nodes=replaceNode(next.nodes,node,maxNodes)
 if(next.nodes.length===maxNodes&&state.nodes.length===maxNodes&&node&&!state.nodes.some(row=>row.id===node!.id))next.omittedNodes+=1
 return next
}

function replaceNode(nodes:GraphNode[],node:GraphNode,maxNodes:number){const old=nodes.findIndex(row=>row.id===node.id);if(old<0)return [...nodes,node].slice(-maxNodes);return nodes.map((row,i)=>i===old?node:row)}

/** step/end 没有成功标志；只用同 step 的真实工具结果和最终模型 attempt 收口。 */
function stepOutcome(nodes:readonly GraphNode[],stepId:string):Pick<GraphNode,'status'|'code'|'diagnostic'>{
 const children=nodes.filter(row=>row.parent===stepId),model=children.findLast(row=>row.kind==='model'),tools=children.filter(row=>row.kind==='tool')
 const uncertain=tools.find(row=>row.status==='unknown'||row.status==='running'||row.diagnostic?.effect==='unknown')
 if(uncertain)return {status:'unknown',code:uncertain.code,diagnostic:uncertain.diagnostic}
 const failed=tools.find(row=>row.status==='failed'),cancelled=tools.find(row=>row.status==='cancelled')
 const outcome=failed??(model?.status==='failed'?model:undefined)??cancelled??(model?.status==='cancelled'?model:undefined)??(children.some(row=>row.kind==='request'&&row.status==='running')?undefined:model)
 return outcome?{status:outcome.status==='running'||outcome.status==='waiting'?'unknown':outcome.status,code:outcome.code,diagnostic:outcome.diagnostic}:{status:'unknown',code:null,diagnostic:null}
}

/** 仅识别现有公开错误前缀，正文仍保留在原生结果中，不复制至图。 */
export function publicCodeFromText(value:unknown):string|null{
 if(typeof value!=='string')return null
 return value.match(/^(?:Error:\s*)?([A-Z][A-Z0-9_]{2,127})(?::|\s|$)/)?.[1]??null
}

function advanceRecovery(previous:RecoveryWindow,observation:ToolObservation,seq:number):RecoveryWindow{
 const unknown=observation.diagnostic?.effect==='unknown'&&['TOOL_OUTCOME_UNKNOWN','PROCESS_TIMEOUT','PROCESS_INTERRUPTED','ABORTED','TRANSPORT','CENTRAL_SEARCH_TRANSPORT','CENTRAL_SEARCH_RECONCILIATION_REQUIRED'].includes(observation.diagnostic.code)
 const pending=unknown?[...previous.unknown.filter(row=>row.callId!==observation.callId),{callId:observation.callId,argumentsHash:observation.argumentsHash,name:observation.name,seq}]:previous.unknown
 if(observation.late)return unknown?{...previous,unknown:pending.slice(-128)}:previous
 // 参数里的新world/action/request身份不是进展；只认owner回执里的新事实。
 const facts={...observation.facts}
 const statusRead=observation.name==='execution_status'
 delete facts.ownerProgress // 生产者的判据不是owner水位，不让true/false本身产生新事实。
 const blocked=observation.facts.targetReached===false||observation.facts.taskAchieved===false
 const goalError=number(facts.goalError??facts.positionError??facts.jointError)
 if(blocked){delete facts.stepIndex;delete facts.goalError;delete facts.positionError;delete facts.jointError}
 const hash=digest({...facts,images:blocked?[]:observation.images}),hasFacts=Object.keys(facts).length>0||!blocked&&observation.images.length>0
 const seen=previous.factsSeen??(previous.factsHash?[previous.factsHash]:[])
 // 切换回已见的静态owner快照不是进展；受阻误差只认本target窗口里的最佳水位。
 const targetHash=digest({...observation.target,...publicFacts(observation.facts,true)}),best=previous.goalBest??{},priorBest=best[targetHash]
 const improved=blocked&&goalError!==null&&priorBest!==undefined&&goalError<priorBest
 const advanced=statusRead?observation.facts.ownerProgress===true&&hasFacts&&!seen.includes(hash):hasFacts&&!seen.includes(hash)||improved
 const goalBest=blocked&&goalError!==null?Object.fromEntries([...Object.entries(best).filter(([key])=>key!==targetHash),[targetHash,priorBest===undefined?goalError:Math.min(goalError,priorBest)]].slice(-128)):best
 const waiting=observation.facts.jobStatus==='running'||observation.facts.status==='running'||observation.facts.status==='stopping'
 const shouldCount=observation.isError||blocked||hasFacts
 return {...previous,factsHash:advanced?hash:previous.factsHash,factsSeen:hasFacts&&!seen.includes(hash)?[...seen,hash].slice(-128):seen,goalBest,goalError:goalError??previous.goalError,stagnant:waiting?previous.stagnant:advanced?0:shouldCount?previous.stagnant+1:previous.stagnant,waitingQueries:waiting&&!observation.waited&&!advanced?previous.waitingQueries+1:!advanced&&!shouldCount&&!observation.waited?previous.waitingQueries:0,lastCode:observation.diagnostic?.code??previous.lastCode,unknown:pending.slice(-128)}
}

/** 不修改当前Goal状态；只计算已有失败窗口应交接还是继续。 */
export function recoveryDecision(graph:ExecutionGraph,budget:number):'continue'|'waiting'|'handoff'{
 if(graph.recovery.handoffSeq!==null&&graph.recovery.stagnant<budget&&graph.recovery.waitingQueries<2)return 'continue'
 if(graph.recovery.waitingQueries>=2)return 'waiting'
 return graph.recovery.stagnant>=budget?'handoff':'continue'
}

export const observationHash=digest
