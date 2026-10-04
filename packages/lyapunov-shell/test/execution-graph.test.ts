/** @tier L0 @cap cpu_fixture：原生事件的纯折叠，不启动模型/GUI/世界。 */
import {describe,expect,test} from 'bun:test'
import {SessionId,type SessionEvent} from '@deepseek-ai/dsh-session'
import {JobId,JobRegistryId,type JobView} from '@deepseek-ai/dsh-jobs'
import {AttachmentId} from '@deepseek-ai/dsh-attachment'
import {createToolResultMessage,ToolCallId} from '@deepseek-ai/dsh-llm'
import {emptyExecutionGraph,foldExecutionGraph,rebuildExecutionGraph,imageFacts,publicDiagnostic,publicFacts,reconcileJobs,recoveryDecision,requestDiagnostics,type ToolObservation} from '../src/execution-graph.ts'
const event=(seq:number,type:string,data:unknown)=>({seq,type,data,time:1000+seq} as SessionEvent)
const empty=()=>emptyExecutionGraph({id:SessionId('session-a')})
const obs=(callId:string,extra:Partial<ToolObservation>={}):ToolObservation=>({callId,rootCallId:callId,name:'operation',turn:1,step:1,argumentsHash:'a'.repeat(64),target:{sceneId:'scene-a'},facts:{},diagnostic:{code:'PROVIDER_UNAVAILABLE',stage:'prepare',fieldPath:null,retryable:false,effect:'none',requestId:null},images:[],job:null,isError:true,late:false,waited:false,...extra})

describe('原生执行图折叠',()=>{
 test('turn/step/tool结果按原身份更新，可重建且同seq不重复',()=>{
  const events=[event(0,'turn/start',{turn:1}),event(1,'step/start',{turn:1,step:1}),event(2,'tool/call',{turn:1,step:1,callId:'call-a',name:'scene_inspect',arguments:'{}'}),event(3,'tool/result',{turn:1,step:1,message:createToolResultMessage({callId:ToolCallId('call-a'),isError:false,content:[{type:'text',text:'PRIVATE_RESULT_BODY'}]})})]
  const graph=events.reduce((state,row)=>foldExecutionGraph(state,row),empty())
  expect(graph.nodes.filter(row=>row.id==='tool:call-a')).toHaveLength(1)
  expect(graph.nodes.find(row=>row.id==='tool:call-a')).toMatchObject({parent:'step:1:1',status:'success'})
  expect(foldExecutionGraph(graph,events.at(-1)!)).toBe(graph)
  expect(JSON.stringify(graph)).not.toContain('PRIVATE_RESULT_BODY')
 })
 test('V4顶层工具错误与图片保留原call身份和正文，图只读摘要',()=>{
  const image={type:'image' as const,attachment:{attachmentId:AttachmentId('sha256:'+'e'.repeat(64)),mediaType:'image/png' as const,width:8,height:8,bytes:80}}
  const message=createToolResultMessage({callId:ToolCallId('image-error'),isError:true,content:[{type:'text',text:'PRIVATE_TOOL_ERROR'},image]})
  const before=JSON.stringify(message)
  let graph=foldExecutionGraph(empty(),event(0,'tool/call',{turn:1,step:1,callId:'image-error',name:'viewer_observe',arguments:'{}'}))
  graph=foldExecutionGraph(graph,event(1,'tool/result',{turn:1,step:1,message,error:{name:'ObservationUnavailable',code:'OBSERVATION_UNAVAILABLE'}}))
  expect(graph.nodes.find(row=>row.id==='tool:image-error')).toMatchObject({status:'failed',code:'OBSERVATION_UNAVAILABLE',images:1})
  expect(JSON.stringify(message)).toBe(before);expect(JSON.stringify(graph)).not.toContain('PRIVATE_TOOL_ERROR')
 })
 test.each([
  ['completed','success'],['aborted','cancelled'],['interrupted','cancelled'],
  ['blocked','waiting'],['forked','waiting'],['max-tokens','waiting'],['future-owner-reason','unknown'],
 ] as const)('原生turn/end %s不伪造目标完成', (kind,status)=>{
  const graph=foldExecutionGraph(empty(),event(0,'turn/end',{turn:1,reason:{kind}}))
  expect(graph.nodes.find(row=>row.id==='turn:1')?.status).toBe(status)
 })
 test('A→B→A、换参数和随机action/request/worldId不重置失败窗口',()=>{
  let graph=empty()
  for(let i=0;i<3;i++)graph=foldExecutionGraph(graph,event(i,'lyapunov/tool-observation',obs('c'+i,{name:i===1?'alternate':'operation',argumentsHash:String(i),target:{worldId:'guessed-'+i}})))
  expect(graph.recovery.stagnant).toBe(3);expect(recoveryDecision(graph,3)).toBe('handoff')
 })
 test('两个未变owner快照A→B→A不能无限续恢复，真的新revision仍可重置',()=>{
  let graph=empty()
  for(let i=0;i<5;i++)graph=foldExecutionGraph(graph,event(i,'lyapunov/tool-observation',obs('s'+i,{isError:false,facts:i%2===0?{sceneRevision:1}:{worldGeneration:1}})))
  expect(graph.recovery.stagnant).toBe(3);expect(recoveryDecision(graph,3)).toBe('handoff')
  graph=foldExecutionGraph(graph,event(5,'lyapunov/tool-observation',obs('real',{isError:false,facts:{sceneRevision:2}})))
  expect(graph.recovery.stagnant).toBe(0)
 })
 test('受阻误差2→1→2→1只认第一次最佳改善，不把重复振荡或新参数当进展',()=>{
  let graph=empty()
  for(const [i,error] of [2,1,2,1,2].entries())graph=foldExecutionGraph(graph,event(i,'lyapunov/tool-observation',obs('b'+i,{isError:false,facts:{targetReached:false,worldGeneration:1,goalError:error}})))
  expect(graph.recovery.stagnant).toBe(3)
  graph=foldExecutionGraph(graph,event(5,'lyapunov/tool-observation',obs('better',{isError:false,facts:{targetReached:false,worldGeneration:1,goalError:0.5}})))
  expect(graph.recovery.stagnant).toBe(0)
 })
 test('taskAchieved=false时step推进与新附件只更新观察，不能续目标改善预算',()=>{
  let graph=empty()
  for(let i=0;i<4;i++)graph=foldExecutionGraph(graph,event(i,'lyapunov/tool-observation',obs('blocked'+i,{isError:false,facts:{taskAchieved:false,worldGeneration:1,stepIndex:i,goalError:2},images:['new-observation-'+i]})))
  expect(graph.recovery.stagnant).toBe(3);expect(recoveryDecision(graph,3)).toBe('handoff')
  graph=foldExecutionGraph(graph,event(4,'user/message',{source:{kind:'user'},content:[{type:'text',text:'新的人工意图'}]}))
  expect(graph.recovery.stagnant).toBe(0);expect(graph.recovery.factsSeen).toEqual([]);expect(graph.recovery.goalBest).toEqual({})
 })
 test('嵌套history checkout按原seq有效前缀重建，但原已发未知副作用不被遗忘',()=>{
  const events=[event(0,'turn/start',{turn:1}),event(1,'lyapunov/tool-observation',obs('unknown',{diagnostic:{code:'TOOL_OUTCOME_UNKNOWN',stage:null,fieldPath:null,effect:'unknown',requestId:null,retryable:false}})),event(2,'command/run',{commandId:'discarded',name:'old-read'}),event(3,'session/history-checkout',{throughSeq:0}),event(4,'command/run',{commandId:'retained',name:'new-read'}),event(5,'session/history-checkout',{throughSeq:4})]
  const graph=rebuildExecutionGraph({id:SessionId('session-a')},events)
  expect(graph.nodes.some(row=>row.id==='command:discarded')).toBe(false);expect(graph.nodes.some(row=>row.id==='command:retained')).toBe(true)
  expect(graph.recovery.unknown).toMatchObject([{callId:'unknown'}]);expect(graph.asOfSeq).toBe(5)
 })
 test('真实resource/revision/产物水位和新图像重置；只同参数不判失败',()=>{
  let graph=foldExecutionGraph(empty(),event(0,'lyapunov/tool-observation',obs('c0')))
  graph=foldExecutionGraph(graph,event(1,'lyapunov/tool-observation',obs('c1',{isError:false,facts:{sceneRevision:2,resourceVersion:'v2',artifactAvailable:true,sha256:'b'.repeat(64)}})))
  expect(graph.recovery.stagnant).toBe(0)
  graph=foldExecutionGraph(graph,event(2,'lyapunov/tool-observation',obs('c2',{isError:false,images:['sha256:'+'c'.repeat(64)]})))
  expect(graph.recovery.stagnant).toBe(0)
 })
 test('受阻Frame stepIndex推进不是目标改善；误差减小时允许继续',()=>{
  let graph=empty()
  for(let i=0;i<4;i++)graph=foldExecutionGraph(graph,event(i,'lyapunov/tool-observation',obs('c'+i,{isError:false,facts:{targetReached:false,worldGeneration:1,stepIndex:i,goalError:2}})))
  expect(graph.recovery.stagnant).toBe(3)
  graph=foldExecutionGraph(graph,event(4,'lyapunov/tool-observation',obs('c4',{isError:false,facts:{targetReached:false,worldGeneration:1,stepIndex:5,goalError:1}})))
  expect(graph.recovery.stagnant).toBe(0)
 })
 test('正常阻塞Job等待不吃恢复预算；不变的即时查询有单独等待交接',()=>{
  let graph=empty()
  for(let i=0;i<8;i++)graph=foldExecutionGraph(graph,event(i,'lyapunov/tool-observation',obs('w'+i,{isError:false,waited:true,facts:{jobStatus:'running'}})))
  expect(graph.recovery.stagnant).toBe(0);expect(recoveryDecision(graph,3)).toBe('continue')
  for(let i=8;i<10;i++)graph=foldExecutionGraph(graph,event(i,'lyapunov/tool-observation',obs('w'+i,{isError:false,facts:{jobStatus:'running'}})))
  expect(recoveryDecision(graph,3)).toBe('waiting')
 })
 test('新真人输入重开窗口但保未知副作用；迟到结果不重置或新增恢复动作',()=>{
  let graph=foldExecutionGraph(empty(),event(0,'lyapunov/tool-observation',obs('unknown',{diagnostic:{code:'TOOL_OUTCOME_UNKNOWN',stage:null,fieldPath:null,retryable:false,effect:'unknown',requestId:null}})))
  expect(graph.recovery.unknown).toHaveLength(1)
  const prior=graph.recovery
  graph=foldExecutionGraph(graph,event(1,'lyapunov/tool-observation',obs('late',{late:true,facts:{sceneRevision:999}})))
  expect(graph.recovery).toBe(prior)
  graph=foldExecutionGraph(graph,event(2,'user/message',{source:{kind:'user'},content:[{type:'text',text:'继续'}]}))
  expect(graph.recovery.stagnant).toBe(0);expect(graph.recovery.unknown).toHaveLength(1)
 })
 test('同名bash-1跨代次不能接管，旧无身份保持未知',()=>{
  const receipt={jobId:'bash-1',registryId:'old',hostInstanceId:'host-old',startedAt:1,callId:'call',callSeq:0,seq:1,status:'running'}
  const live:JobView={id:JobId('bash-1'),registryId:JobRegistryId('new'),kind:'bash',label:'离线夹具',startedAt:1,status:'completed',output:{total:0,earliest:0}}
  expect(reconcileJobs([receipt],[live])[0]).toMatchObject({matched:false,currentStatus:'unknown'})
  expect(reconcileJobs([{...receipt,registryId:null}],[{...live,registryId:JobRegistryId('old')}])[0]?.matched).toBe(false)
  expect(reconcileJobs([receipt],[{...live,registryId:JobRegistryId('old')}])[0]).toMatchObject({matched:true,currentStatus:'completed'})
 })
 test('旧真实bash接收文本只重建unknown，不从同名ID/路径推当前执行',()=>{
  let graph=foldExecutionGraph(empty(),event(0,'tool/call',{turn:1,step:1,callId:'old-call',name:'bash',arguments:'{}'}))
  graph=foldExecutionGraph(graph,event(1,'tool/result',{message:createToolResultMessage({callId:ToolCallId('old-call'),isError:false,content:[{type:'text',text:'started background job bash-1'}]})}))
  expect(graph.jobs).toEqual([{jobId:'bash-1',registryId:null,hostInstanceId:null,startedAt:null,callId:'old-call',callSeq:0,seq:1,status:'unknown'}])
 })
 test('真实Bash timeout/SIGTERM与外层isError=false独立投影，不把下载标成功',()=>{
  let graph=foldExecutionGraph(empty(),event(0,'tool/call',{turn:1,step:1,callId:'download',name:'bash',arguments:'{}'}))
  graph=foldExecutionGraph(graph,event(1,'tool/result',{message:createToolResultMessage({callId:ToolCallId('download'),isError:false,content:[{type:'text',text:'[timed out after 60000ms]\n[killed by signal: SIGTERM]'}]})}))
  expect(graph.nodes[0]).toMatchObject({status:'unknown',code:'PROCESS_TIMEOUT',facts:{timedOut:true,timeoutMs:60000,killedSignal:'SIGTERM'}})
  expect(graph.recovery.unknown).toMatchObject([{callId:'download',name:'bash'}])
 })
 test('ContentBlock图片身份保留，图不改变原块或正文',()=>{
  const image={type:'image' as const,attachment:{attachmentId:'sha256:'+'d'.repeat(64),mediaType:'image/png' as const,width:8,height:8,bytes:80}}
  const content=[{type:'text' as const,text:'PRIVATE_TEXT'},image] as never
  const before=JSON.stringify(content);expect(imageFacts(content)).toEqual([image.attachment.attachmentId]);expect(JSON.stringify(content)).toBe(before)
 })
 test('公开facts与diagnostic不含URL/路径/凭据/随机操作身份',()=>{
  expect(publicFacts({sceneRevision:3,actionId:'random',requestId:'random',token:'PRIVATE',url:'https://private',progress:{stepIndex:7},artifact:{sha256:'e'.repeat(64),bytes:20}})).toEqual({bytes:20,sceneRevision:3,sha256:'e'.repeat(64),stepIndex:7})
  const diagnostic=publicDiagnostic({diagnostic:{code:'TIMEOUT',stage:'upstream_stream',fieldPath:'https://private',retryable:false,effect:'unknown',requestId:'https://private?token=PRIVATE',message:'PRIVATE'}})
  expect(diagnostic).toMatchObject({fieldPath:null,requestId:null,effect:'unknown'});expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE')
 })
 test('实际请求摘要含owner/section/hash/图像数，但不留原文或原工具schema',()=>{
  const request={provider:'mock',model:'mock',messages:[{role:'user',source:{kind:'owner',form:'snapshot',sections:[{name:'current',text:'PRIVATE_SECTION'}]},content:[{type:'text',text:'PRIVATE_SECTION'}]}],tools:[{name:'tool',description:'PRIVATE_TOOL',parameters:{}}]} as never
  const value=requestDiagnostics(request,1,2);expect(value.contexts[0]).toMatchObject({owner:'owner',bytes:15,sections:[{name:'current',bytes:15}]});expect(JSON.stringify(value)).not.toContain('PRIVATE')
 })
 test('有界图明确裁剪，回指seq及Session隔离仍保持',()=>{
  let graph=empty();for(let i=0;i<30;i++)graph=foldExecutionGraph(graph,event(i,'command/run',{commandId:'cmd'+i,name:'manual'}),10)
  expect(graph.nodes).toHaveLength(10);expect(graph.omittedNodes).toBe(20);expect(emptyExecutionGraph({id:SessionId('session-b')}).nodes).toHaveLength(0)
 })
 test('多个真实搜索intent的原ID诊断独立保留，收费回执与未知502不会被一次tool结果抹平',()=>{
  let graph=foldExecutionGraph(empty(),event(0,'tool/call',{callId:'batch',name:'web_search',arguments:'{}'}))
  graph=foldExecutionGraph(graph,event(1,'lyapunov/service-diagnostic',{callId:'batch',intentKey:'search-first',code:'central_search_completed',outcome:'success',diagnostic:{code:'central_search_completed',stage:'complete',requestId:'original-first',effect:'charged',retryable:false}}))
  graph=foldExecutionGraph(graph,event(2,'lyapunov/service-diagnostic',{callId:'batch',intentKey:'search-second',code:'CENTRAL_SEARCH_RECONCILIATION_REQUIRED',outcome:'error',diagnostic:{code:'central_search_usage_unknown',stage:'upstream_response',requestId:'original-second',effect:'unknown',retryable:false,upstreamHttpStatus:502,upstreamFailureCode:'central_search_transport_error'}}))
  expect(graph.nodes.find(row=>row.id==='service:search-first')).toMatchObject({status:'success',diagnostic:{requestId:'original-first',effect:'charged'}})
  expect(graph.nodes.find(row=>row.id==='service:search-second')).toMatchObject({status:'failed',diagnostic:{requestId:'original-second',effect:'unknown',retryable:false,upstreamHttpStatus:502}})
 })
})
