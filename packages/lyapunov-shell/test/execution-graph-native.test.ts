/** @tier L1 @cap cpu_fixture：真实原生Loop、Tools、Jobs与Session，只有模型输入由夹具供给。 */
import {describe,expect,test} from 'bun:test'
import {Context} from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import {mountAgentLoopTestDependencies} from '@deepseek-ai/dsh-agent-loop-testkit'
import {SessionId,SessionLogOffset} from '@deepseek-ai/dsh-session'
import {createUserMessage,createToolResultMessage,ToolCallId} from '@deepseek-ai/dsh-llm'
import {defineTool} from '@deepseek-ai/dsh-tools'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import {JobId,type JobOutcome} from '@deepseek-ai/dsh-jobs'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {AttachmentId} from '@deepseek-ai/dsh-attachment'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {MockAdapter,textResponse,toolCallResponse} from '../../../.upstream/deepseek-harness-20260911-candidate/packages/core/agent-loop/tests/mock-adapter.ts'
import {applyExecutionGraph} from '../src/execution-graph-host.ts'
import {emptyExecutionGraph,foldExecutionGraph} from '../src/execution-graph.ts'
import {EXECUTION_STATUS_SUMMARY_MAX_BYTES} from '../src/execution-status-summary.ts'

async function setup(script:ConstructorParameters<typeof MockAdapter>[0]){
 const ctx=new Context()
 try{
  await mountAgentLoopTestDependencies(ctx);await ctx.plugin(JobsLocal);await ctx.plugin(ToolJobs,{completionDelivery:'quiet'})
  await ctx.plugin(AgentLoop,{agents:[]})
  const adapter=new MockAdapter(script);ctx.llm.registerAdapter(['mock'],adapter)
  const read=applyExecutionGraph(ctx,'host-fixture',{recoveryBudget:3})
  const agent=await ctx.agentLoop.create(SessionId('session-a'),{provider:'mock',model:'mock'})
  const other=await ctx.agentLoop.create(SessionId('session-b'),{provider:'mock',model:'mock'})
  const send=async()=>{agent.followup(createUserMessage({content:[{type:'text',text:'隔离目标'}],source:{kind:'user'}}));await agent.whenIdle()}
  return {ctx,adapter,agent,other,read,send,close:()=>ctx.fiber.dispose()}
 }catch(error){await ctx.fiber.dispose();throw error}
}
function jobNotices(agent:Agent){
 return agent.session.snapshotEvents().flatMap(event=>event.type==='agent/inbox/spliced'?event.data.inserted:[]).filter(message=>message.source.kind==='tool-jobs')
}
const output={schema:{type:'object' as const,additionalProperties:false as const,properties:{result:{type:'string' as const,required:true as const}}},render:(_args:unknown,value:{result?:unknown})=>[{type:'text' as const,text:String(value.result)}]}

describe('原生Graph/恢复hook',()=>{
 test('真实Loop未知操作后重复原生状态read有界等待，保原unknown/Job身份且不读输出或取消',async()=>{
  const h=await setup([toolCallResponse('u0','uncertain',{}),...Array.from({length:6},(_,i)=>toolCallResponse('status-'+i,'execution_status',i%2?{detail:'full'}:{})),textResponse('不应到达')])
  let settle!:(value:JobOutcome)=>void,cancels=0
  const done=new Promise<JobOutcome>(resolve=>settle=resolve),values:string[]=[]
  h.ctx.tools.register(defineTool({name:'uncertain',description:'Unknown outcome fixture',parameters:{},output,async execute(){throw Error('TOOL_OUTCOME_UNKNOWN')}}))
  try{
   const jobId=h.ctx.jobs.start({kind:'bash',label:'PRIVATE_LABEL',owner:h.agent.id,run:job=>{job.append('PRIVATE_OUTPUT');return {done,cancel(){cancels++;settle({status:'killed'})}}}}),before=h.ctx.jobs.get(jobId,h.agent.id)
   h.ctx.on('tools/result',(exec,result)=>{if(exec.agent===h.agent&&exec.name==='execution_status'&&!result.isError)values.push(String((result.value as {result:string}).result))})
   await h.send()
   const events=h.agent.session.snapshotEvents(),graph=h.read(h.agent).graph,current=h.ctx.jobs.get(jobId,h.agent.id)
   expect(h.adapter.requests).toHaveLength(3);expect(events.filter(row=>row.type==='lyapunov/recovery-handoff')).toHaveLength(1);expect(graph.recovery.waitingQueries).toBe(2)
   expect(graph.recovery.unknown).toContainEqual({callId:'u0',argumentsHash:expect.any(String),name:'uncertain',seq:expect.any(Number)})
   expect(current).toMatchObject({registryId:before.registryId,startedAt:before.startedAt,status:'running'});expect(cancels).toBe(0)
   const polls=events.filter(row=>row.type==='lyapunov/tool-observation'&&row.data.name==='execution_status')
   expect(polls).toHaveLength(2);expect(polls.every(row=>row.type==='lyapunov/tool-observation'&&row.data.facts.ownerProgress===false)).toBe(true)
   expect(Buffer.byteLength(values[0]!)).toBeLessThanOrEqual(EXECUTION_STATUS_SUMMARY_MAX_BYTES);expect(JSON.parse(values[1]!).graph.sessionId).toBe(String(h.agent.id));expect(JSON.stringify(values)).not.toContain('PRIVATE_OUTPUT')
   const count=events.length,window=JSON.stringify(graph.recovery)
   for(let i=0;i<3;i++)await h.ctx.tools.execute({name:'execution_status',arguments:{},agent:h.agent,callId:ToolCallId('direct-status-'+i),signal:AbortSignal.timeout(1000)})
   expect(h.agent.session.snapshotEvents()).toHaveLength(count);expect(JSON.stringify(h.read(h.agent).graph.recovery)).toBe(window);expect(h.read(h.other).graph.nodes).toHaveLength(0);expect(h.ctx.jobs.read(jobId,h.agent.id).chunks.map(chunk=>chunk.text).join('')).toBe('PRIVATE_OUTPUT')
  }finally{settle({status:'killed'});await h.close()}
 })
 test('真实Loop没有Job时交替summary/full不由自身step/phase/读取节点伪造进展',async()=>{
  const h=await setup([...Array.from({length:6},(_,i)=>toolCallResponse('idle-'+i,'execution_status',i%2?{detail:'full'}:{})),textResponse('不应继续')])
  try{
   await h.send();const events=h.agent.session.snapshotEvents(),graph=h.read(h.agent).graph
   expect(h.adapter.requests).toHaveLength(3);expect(graph.recovery.stagnant).toBe(3);expect(graph.recovery.waitingQueries).toBe(0);expect(events.filter(row=>row.type==='lyapunov/recovery-handoff')).toHaveLength(1)
   const observations=events.filter(row=>row.type==='lyapunov/tool-observation'&&row.data.name==='execution_status')
   expect(observations).toHaveLength(3);expect(new Set(observations.map(row=>row.type==='lyapunov/tool-observation'?row.data.facts.ownerStateHash:null)).size).toBe(1);expect(observations.every(row=>row.type==='lyapunov/tool-observation'&&row.data.facts.ownerProgress===false)).toBe(true)
  }finally{await h.close()}
 })
 test('真实Loop夹入无新事实的工具不能洗掉既有状态等待水位',async()=>{
  const h=await setup([toolCallResponse('s0','execution_status',{}),toolCallResponse('n0','no_new_facts',{}),toolCallResponse('s1','execution_status',{}),toolCallResponse('n1','no_new_facts',{}),textResponse('不应到达')])
  let settle!:(value:JobOutcome)=>void
  const done=new Promise<JobOutcome>(resolve=>settle=resolve)
  h.ctx.tools.register(defineTool({name:'no_new_facts',description:'No owner progress fixture',parameters:{},output,async execute(){return {result:''}}}))
  try{
   h.ctx.jobs.start({kind:'bash',label:'PRIVATE_LABEL',owner:h.agent.id,run:()=>({done,cancel(){settle({status:'killed'})}})})
   await h.send();expect(h.adapter.requests).toHaveLength(3);expect(h.read(h.agent).graph.recovery.waitingQueries).toBe(2);expect(h.agent.session.snapshotEvents().filter(row=>row.type==='lyapunov/recovery-handoff')).toHaveLength(1)
  }finally{settle({status:'killed'});await h.close()}
 })
 test('真实Job owner终态变化可推进一次，原unknown保留且之后相同status读仍不续预算',async()=>{
  const h=await setup([toolCallResponse('u0','uncertain',{}),...Array.from({length:4},(_,i)=>toolCallResponse('transition-'+i,'execution_status',{})),textResponse('Job已结束；原unknown仍需读回')])
  let settle!:(value:JobOutcome)=>void,cancels=0,polls=0
  const done=new Promise<JobOutcome>(resolve=>settle=resolve)
  h.ctx.tools.register(defineTool({name:'uncertain',description:'Unknown outcome fixture',parameters:{},output,async execute(){throw Error('TOOL_OUTCOME_UNKNOWN')}}))
  try{
   const jobId=h.ctx.jobs.start({kind:'bash',label:'PRIVATE_LABEL',owner:h.agent.id,run:job=>{job.append('PRIVATE_OUTPUT');return {done,cancel(){cancels++;settle({status:'killed'})}}}})
   h.ctx.on('tools/result',(exec)=>{if(exec.agent===h.agent&&exec.name==='execution_status'&&++polls===1)settle({status:'completed'})})
   await h.send();const events=h.agent.session.snapshotEvents(),graph=h.read(h.agent).graph
   expect(h.adapter.requests).toHaveLength(6);expect(events.filter(row=>row.type==='lyapunov/recovery-handoff')).toHaveLength(0);expect(h.ctx.jobs.get(jobId,h.agent.id).status).toBe('completed');expect(h.ctx.jobs.read(jobId,h.agent.id).chunks.map(chunk=>chunk.text).join('')).toBe('PRIVATE_OUTPUT');expect(cancels).toBe(0);expect(graph.recovery.unknown).toHaveLength(1);expect(graph.recovery.stagnant).toBe(2)
   expect(events.filter(row=>row.type==='lyapunov/tool-observation'&&row.data.name==='execution_status').map(row=>row.type==='lyapunov/tool-observation'?row.data.facts.ownerProgress:null)).toEqual([false,true,false,false])
  }finally{settle({status:'killed'});await h.close()}
 })
 test('真实Loop连续失败三次后一次handoff，保原错误/图片通路且不创建Goal',async()=>{
  const h=await setup([toolCallResponse('c1','failing',{}),toolCallResponse('c2','alternate',{}),toolCallResponse('c3','failing',{}),toolCallResponse('c4','failing',{})])
  let executions=0
  for(const name of ['failing','alternate'])h.ctx.tools.register(defineTool({name,description:'隔离失败',parameters:{},output,async execute(){executions++;throw Error('PROVIDER_UNAVAILABLE: fixture')}}))
  try{await h.send();expect(executions).toBe(3);expect(h.adapter.requests).toHaveLength(3);expect(h.read(h.agent).graph.recovery.handoffSeq).not.toBeNull();expect(h.agent.session.snapshotEvents().filter(x=>x.type==='lyapunov/recovery-handoff')).toHaveLength(1);expect(h.agent.session.snapshotEvents().filter(x=>x.type==='tool/result')).toHaveLength(3);expect(h.read(h.other).graph.nodes).toHaveLength(0);expect(h.ctx.get('goals')).toBeUndefined()}
  finally{await h.close()}
 })
 test('实际人工annotation来源与图片在handoff后重开完整请求，原unknown/Scope保留而自动反馈不重开',async()=>{
  const h=await setup([toolCallResponse('u','uncertain',{}),toolCallResponse('f2','failing',{}),toolCallResponse('f3','failing',{}),textResponse('处理新的人工批注')])
  h.ctx.tools.register(defineTool({name:'uncertain',description:'未知副作用夹具',parameters:{},output,async execute(){throw Error('TOOL_OUTCOME_UNKNOWN')}}))
  h.ctx.tools.register(defineTool({name:'failing',description:'失败夹具',parameters:{},output,async execute(){throw Error('PROVIDER_UNAVAILABLE')}}))
  const image={type:'image' as const,attachment:{attachmentId:AttachmentId('sha256:'+'a'.repeat(64)),mediaType:'image/png' as const,width:8,height:8,bytes:64}}
  try{
   await h.send();expect(h.adapter.requests).toHaveLength(3);expect(h.read(h.agent).graph.recovery.unknown).toHaveLength(1)
   for(const source of [{kind:'lyapunov-orientation',form:'notice',summary:'导入方向检查'},{kind:'lyapunov-engine-install',form:'notice',summary:'引擎安装授权状态'},{kind:'lyapunov-domain-pointer',form:'snapshot'}]){
    h.agent.followup(createUserMessage({content:[{type:'text',text:'自动反馈，不代表新人工意图'},image],source:source as never}));await h.agent.whenIdle();expect(h.adapter.requests).toHaveLength(3)
   }
   // 与feedbackMessage实际producer相同的source对象，不改写为kind=user。
   const annotation=createUserMessage({content:[{type:'text',text:'人工确认的截图批注与原授权'},image],source:{kind:'lyapunov-annotation'} as never})
   h.agent.followup(annotation);await h.agent.whenIdle();expect(h.adapter.requests).toHaveLength(4)
   const transmitted=h.adapter.requests.at(-1)!.messages.find(message=>message.id===annotation.id)
   expect(transmitted).toEqual(annotation);expect(transmitted?.content).toContainEqual(image)
   expect(h.read(h.agent).graph.recovery).toMatchObject({stagnant:0,handoffSeq:null});expect(h.read(h.agent).graph.recovery.unknown).toHaveLength(1);expect(h.read(h.other).graph.nodes).toHaveLength(0)
  }finally{await h.close()}
 })
 test('原生V4工具图片与同一结果进入下一模型步，Graph不改原内容',async()=>{
  const h=await setup([toolCallResponse('observe-v4','image_observation',{}),textResponse('已读取原工具观察')])
  const image={type:'image' as const,attachment:{attachmentId:AttachmentId('sha256:'+'e'.repeat(64)),mediaType:'image/png' as const,width:8,height:8,bytes:64}}
  h.ctx.tools.register(defineTool({name:'image_observation',description:'原工具图像夹具',parameters:{},output:{schema:output.schema,render:(_args,value)=>[{type:'text',text:String(value.result)},image]},async execute(){return {result:'PRIVATE_IMAGE_TOOL_RESULT'}}}))
  try{
   await h.send()
   const result=h.agent.session.snapshotEvents().find(row=>row.type==='tool/result'&&row.data.message.toolCallId===ToolCallId('observe-v4'))
   if(result?.type!=='tool/result')throw Error('missing native tool result')
   expect(result.data.message).toMatchObject({role:'tool',toolCallId:ToolCallId('observe-v4'),isError:false})
   expect(result.data.message.content).toContainEqual(image)
   const transmitted=h.adapter.requests[1]!.messages.find(message=>message.id===result.data.message.id)
   expect(transmitted).toEqual(result.data.message);expect(transmitted?.content).toContainEqual(image)
   expect(h.read(h.agent).graph.nodes.find(node=>node.id==='tool:observe-v4')).toMatchObject({status:'success',images:1})
   expect(h.read(h.agent).graph.request?.imageCount).toBe(1);expect(JSON.stringify(h.read(h.agent))).not.toContain('PRIVATE_IMAGE_TOOL_RESULT')
  }finally{await h.close()}
 })
 test('原生人工Stop投影为取消，已有Job与Sim停止仍需各owner确认',async()=>{
  const h=await setup([toolCallResponse('stop-active','pending_operation',{}),textResponse('不应再执行')])
  const started=Promise.withResolvers<void>();let settle!:(value:JobOutcome)=>void,jobCancels=0
  const done=new Promise<JobOutcome>(resolve=>settle=resolve)
  h.ctx.tools.register(defineTool({name:'pending_operation',description:'等待原生取消的夹具',parameters:{},output,async execute(_args,exec){
   started.resolve()
   await new Promise<void>((_resolve,reject)=>{if(exec.signal.aborted)reject(exec.signal.reason);else exec.signal.addEventListener('abort',()=>reject(exec.signal.reason),{once:true})})
   return {result:'UNREACHABLE'}
  }}))
  try{
   const id=h.ctx.jobs.start({kind:'bash',label:'独立已有Job',owner:h.agent.id,run:()=>({done,cancel(){jobCancels++;settle({status:'killed'})}})})
   h.agent.followup(createUserMessage({content:[{type:'text',text:'仅测试当前原生Stop'}],source:{kind:'user'}}))
   await started.promise;h.agent.cancel({kind:'user'});await h.agent.whenIdle()
   const value=h.read(h.agent)
   expect(value.graph.nodes.find(node=>node.id==='turn:1')?.status).toBe('cancelled')
   expect(h.agent.session.snapshotEvents().findLast(row=>row.type==='turn/end')).toMatchObject({data:{reason:{kind:'aborted',reason:{kind:'user'}}}})
   expect(value.stop.agentStatus).toBe('idle');expect(h.ctx.jobs.get(id,h.agent.id).status).toBe('running');expect(jobCancels).toBe(0)
   expect(value.stop.physicalStop).toBe('Requires separate confirmation by the Sim owner');expect(h.adapter.requests).toHaveLength(1)
  }finally{settle({status:'killed'});await h.close()}
 })
 test('真实资源/Scene水位变化允许同参数多次操作，手动关闭观察不改变执行',async()=>{
  const h=await setup([toolCallResponse('c1','progress',{}),toolCallResponse('c2','progress',{}),toolCallResponse('c3','progress',{}),toolCallResponse('c4','progress',{}),textResponse('完成')])
  let revision=0
  h.ctx.tools.register(defineTool({name:'progress',description:'实际新水位夹具',parameters:{},output,async execute(){return {result:JSON.stringify({sceneId:'scene-a',sceneRevision:++revision,artifactAvailable:true})}}}))
  try{await h.send();expect(revision).toBe(4);const before=h.agent.session.snapshotEvents().length;expect(h.read(h.agent).graph.recovery.handoffSeq).toBeNull();h.read(h.agent);h.read(h.agent);expect(h.agent.session.snapshotEvents()).toHaveLength(before);expect(h.adapter.requests).toHaveLength(5);expect(h.read(h.agent).graph.request?.contexts.every(x=>x.hash.length===64)).toBe(true)}
  finally{await h.close()}
 })
 test('真实Loop交替静态Scene/World快照只观察一次新事实，三次无新水位后单交接',async()=>{
  const h=await setup([toolCallResponse('a1','scene_static',{}),toolCallResponse('b1','world_static',{}),toolCallResponse('a2','scene_static',{}),toolCallResponse('b2','world_static',{}),toolCallResponse('a3','scene_static',{}),textResponse('不应继续')])
  let reads=0
  for(const [name,facts] of [['scene_static',{sceneRevision:1}],['world_static',{worldGeneration:1}]] as const)h.ctx.tools.register(defineTool({name,description:'静态owner回执夹具',parameters:{},output,async execute(){reads++;return {result:JSON.stringify(facts)}}}))
  try{await h.send();expect(reads).toBe(5);expect(h.adapter.requests).toHaveLength(5);expect(h.agent.session.snapshotEvents().filter(row=>row.type==='lyapunov/recovery-handoff')).toHaveLength(1);expect(h.read(h.agent).graph.recovery.stagnant).toBe(3)}finally{await h.close()}
 })
 test('Job只接收，实时代次匹配；快照不消费输出/不认领通知；模型完成不杀Job',async()=>{
  const h=await setup([toolCallResponse('start','launch',{}),textResponse('后台已受理')])
  let settle!:(value:JobOutcome)=>void,cancels=0
  const done=new Promise<JobOutcome>(resolve=>settle=resolve)
  h.ctx.tools.register(defineTool({name:'launch',description:'原生Job夹具',parameters:{},output:{schema:{type:'object',additionalProperties:false,properties:{jobId:{type:'string',required:true}}},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},async execute(_a,exec){const jobId=h.ctx.jobs.start({kind:'bash',label:'PRIVATE_COMMAND',owner:exec.agent?.id,run:job=>{job.append('PRIVATE_OUTPUT');return {done,cancel(){cancels++;settle({status:'killed'})}}}});return {jobId}}}))
  try{await h.send();const first=h.read(h.agent);expect(first.jobs[0]).toMatchObject({matched:true,currentStatus:'running'});expect(first.jobs[0]?.registryId).toBeString();expect(h.ctx.jobs.read(JobId(first.jobs[0]!.jobId),h.agent.id).chunks.map(chunk=>chunk.text).join('')).toBe('PRIVATE_OUTPUT');expect(cancels).toBe(0);expect(jobNotices(h.agent)).toHaveLength(0);expect(JSON.stringify(first)).not.toContain('PRIVATE_COMMAND');expect(JSON.stringify(first)).not.toContain('PRIVATE_OUTPUT');expect(h.read(h.other).jobs).toHaveLength(0);settle({status:'completed'});await Promise.resolve();await Promise.resolve();expect(h.read(h.agent).jobs[0]?.currentStatus).toBe('completed');expect(jobNotices(h.agent)).toHaveLength(1)}
  finally{settle({status:'killed'});await h.close()}
 })
 test('已记录unknown同操作先读回，guard不调用工具；不同会话不受影响',async()=>{
  const h=await setup([toolCallResponse('first','uncertain',{}),toolCallResponse('second','uncertain',{}),textResponse('读回交接')])
  let sends=0
  h.ctx.tools.register(defineTool({name:'uncertain',description:'未知结果夹具',parameters:{},output,async execute(){sends++;throw Error('TOOL_OUTCOME_UNKNOWN: 原操作结果未知')}}))
  try{await h.send();expect(sends).toBe(1);const errors=h.agent.session.snapshotEvents().filter(x=>x.type==='tool/result');expect(errors).toHaveLength(2);expect(JSON.stringify(errors[1])).toContain('RECOVERY_READBACK_REQUIRED');expect(h.read(h.agent).graph.recovery.unknown).toHaveLength(1)}
  finally{await h.close()}
 })
 test('全局与owner两个真实controller对六条终态各认领一次；不同Job不被正文合并',async()=>{
  const h=await setup([])
  const child=await h.agent.ctx.plugin(ToolJobs,{completionDelivery:'quiet'})
  const setters:Array<(value:JobOutcome)=>void>=[]
  try{
   for(let i=0;i<6;i++){let settle!:(value:JobOutcome)=>void;const done=new Promise<JobOutcome>(resolve=>settle=resolve);setters.push(settle);h.ctx.jobs.start({kind:'bash',label:'同正文',owner:h.agent.id,run:()=>({done,cancel(){settle({status:'killed'})}})})}
   for(const settle of setters)settle({status:'completed',detail:'同终态'})
   await Promise.resolve();await Promise.resolve()
   const notices=h.agent.session.snapshotEvents().filter(x=>x.type==='agent/inbox/spliced').flatMap(x=>x.type==='agent/inbox/spliced'?x.data.inserted:[]).filter(x=>x.source.kind==='tool-jobs')
   expect(notices).toHaveLength(6);expect(new Set(notices.map(x=>(x.source as unknown as {job:{id:string}}).job.id)).size).toBe(6)
   expect(h.ctx.jobs.list(h.agent.id).every(x=>x.status==='completed')).toBe(true);h.read(h.agent);expect(jobNotices(h.agent)).toHaveLength(6)
   await child.dispose();expect(h.ctx.jobs.list(h.agent.id)).toHaveLength(6)
  }finally{for(const settle of setters)settle({status:'killed'});await h.close()}
 })
 test('重启旧bash-1未知句柄不能读/停止当前同名Job，明确当前代次才允许只读输出',async()=>{
  const h=await setup([]);let cancels=0,settle!:(value:JobOutcome)=>void
  const done=new Promise<JobOutcome>(resolve=>settle=resolve)
  try{
   const jobId=h.ctx.jobs.start({kind:'bash',label:'隔离当前Job',owner:h.agent.id,run:job=>{job.append('隔离输出');return {done,cancel(){cancels++;settle({status:'killed'})}}}})
   const old=ToolCallId('old-before-restart')
   h.agent.session.append('tool/call',{turn:1,step:1,callId:old,name:'bash',arguments:'{}'})
   h.agent.session.append('tool/result',{turn:1,step:1,message:createToolResultMessage({callId:old,isError:false,content:[{type:'text',text:'started background job '+jobId}]})},{surfaceOp:'append'})
   for(const name of ['job_output','job_kill']){
    const value=await h.ctx.tools.execute({name,arguments:{job_id:jobId},agent:h.agent,callId:ToolCallId('deny-'+name),signal:AbortSignal.timeout(1000)})
    expect(value.isError).toBe(true);if(value.isError)expect(value.error.info?.code).toBe('JOB_INSTANCE_UNKNOWN')
   }
   expect(cancels).toBe(0);expect(h.read(h.agent).jobs[0]).toMatchObject({currentStatus:'unknown',matched:false})
   const registryId=h.ctx.jobs.get(jobId,h.agent.id).registryId
   const value=await h.ctx.tools.execute({name:'job_output',arguments:{job_id:jobId,registry_id:registryId},agent:h.agent,callId:ToolCallId('current-read'),signal:AbortSignal.timeout(1000)})
   expect(value.isError).toBe(false);if(value.isError)throw Error('current instance read failed');expect(value.value).toMatchObject({text:'隔离输出'});expect(h.ctx.jobs.read(jobId,h.agent.id).chunks).toHaveLength(0);expect(cancels).toBe(0);expect(h.ctx.jobs.get(jobId,h.agent.id).status).toBe('running')
  }finally{settle({status:'killed'});await h.close()}
 })
 test('实际Loader+Include由配置装配原生Loop/Jobs及Shell图贡献，恢复预算按配置生效',async()=>{
  const scratch=await mkdtemp(join(tmpdir(),'lyapunov-graph-loader-')),ctx=new Context()
  const adapter=new MockAdapter([toolCallResponse('l1','loader_failure',{}),toolCallResponse('l2','loader_failure',{}),toolCallResponse('l3','loader_failure',{})])
  let executions=0
  // 仅测试专用服务行提供testkit；运行与恢复仍为实际AgentLoop/Jobs/Graph实现。
  const prerequisites={name:'test-native-services',async apply(child:Context){await mountAgentLoopTestDependencies(child)}}
  const routes={name:'test-native-routes',inject:['llm','tools'],apply(child:Context){child.llm.registerAdapter(['mock'],adapter);child.tools.register(defineTool({name:'loader_failure',description:'Loader隔离失败',parameters:{},output,async execute(){executions++;throw Error('PROVIDER_UNAVAILABLE: fixture')}}))}}
  const graphContribution={name:'test-shell-graph-contribution',inject:['sessionProjections','agents','tools','llm','jobs'],apply(child:Context,config:{recoveryBudget:number;maxNodes:number}){applyExecutionGraph(child,'loader-host',config)}}
  try{
   const configPath=join(scratch,'cordis.yml');await writeFile(configPath,"- name: test-native-services\n- name: test-native-routes\n- name: '@deepseek-ai/dsh-jobs-local'\n- name: '@deepseek-ai/dsh-tool-jobs'\n  config:\n    completionDelivery: quiet\n- name: '@deepseek-ai/dsh-agent-loop'\n  config:\n    agents: []\n- name: test-shell-graph-contribution\n  config:\n    recoveryBudget: 2\n    maxNodes: 40\n")
   ctx.baseUrl=pathToFileURL(scratch).href+'/'
   await ctx.plugin(Loader);ctx.loader.builtins.include=Include
   const modules=new Map<string,unknown>([['test-native-services',prerequisites],['test-native-routes',routes],['@deepseek-ai/dsh-jobs-local',JobsLocal],['@deepseek-ai/dsh-tool-jobs',ToolJobs],['@deepseek-ai/dsh-agent-loop',AgentLoop],['test-shell-graph-contribution',graphContribution]])
   ctx.loader.internal={version:'v2',async import(specifier:string){if(!modules.has(specifier))throw Error('unexpected fixture module');return modules.get(specifier)}} as unknown as NonNullable<typeof ctx.loader.internal>
   await ctx.loader.create({name:'cordis:include',config:{path:pathToFileURL(configPath).href}});await ctx.loader.await()
   for(const entry of Object.values(ctx.loader.store))for(const child of Object.values(entry.subtree?.store??{}))await child.fiber?.await()
   const agent=await ctx.agentLoop.create(SessionId('loader-graph'),{provider:'mock',model:'mock'})
   agent.followup(createUserMessage({content:[{type:'text',text:'隔离Loader目标'}],source:{kind:'user'}}));await agent.whenIdle()
   expect(executions).toBe(2);expect(adapter.requests).toHaveLength(2);expect(agent.session.snapshotEvents().filter(row=>row.type==='lyapunov/recovery-handoff')).toHaveLength(1)
   const read=await ctx.tools.execute({name:'execution_status',arguments:{},agent,callId:ToolCallId('loader-read'),signal:AbortSignal.timeout(1000)})
   expect(read.isError).toBe(false);expect(JSON.stringify(read.content)).toContain('loader-host')
  }finally{await ctx.fiber.dispose();await rm(scratch,{recursive:true,force:true})}
 })
 test('真实原生projection ver1/ver2/ver3坏旧缓存按ver4从完整事件重建，checkout不改原事件且回到准确前缀',async()=>{
  const h=await setup([toolCallResponse('cache','progress',{}),textResponse('完成')])
  h.ctx.tools.register(defineTool({name:'progress',description:'原生缓存回执',parameters:{},output,async execute(){return {result:JSON.stringify({sceneRevision:1})}}}))
  try{
   await h.send();const events=h.agent.session.snapshotEvents(),before=JSON.stringify(events),rows=h.ctx.sessionProjections.checkpoint(h.agent.session)
   expect(rows.lyapunovGraph?.ver).toBe(4)
   for(const ver of [1,2,3]){
    const old={...rows,lyapunovGraph:{ver,seq:events.at(-1)!.seq,val:{oldSchema:true,stagnant:-999}}}
    expect(h.ctx.sessionProjections.restoreFloor(old)).toBe(SessionLogOffset(0))
    const rebuilt=h.ctx.sessionProjections.restore(old,events,SessionLogOffset(0),h.agent.session.header,h.agent.session.inheritedEventCount)
    expect(rebuilt.checkpoint.lyapunovGraph?.ver).toBe(4);expect(rebuilt.checkpoint.lyapunovGraph?.val).toEqual(h.read(h.agent).graph);expect(JSON.stringify(h.agent.session.snapshotEvents())).toBe(before)
   }
   const anchor=events.find(row=>row.type==='step/end')!.seq
   const changed=h.agent.session.checkout(anchor)
   const prefix=events.filter(row=>row.seq<=anchor).reduce((graph,row)=>foldExecutionGraph(graph,row),emptyExecutionGraph(h.agent.session.header))
   expect(h.read(h.agent).graph).toEqual({...prefix,asOfSeq:Number(changed.seq)})
   expect(JSON.stringify(h.agent.session.snapshotEvents().slice(0,events.length))).toBe(before)
  }finally{await h.close()}
 })
 test('真实execution_status默认summary有界/原Job身份与unknown可读，full显式取全图且轮询不自造进展',async()=>{
  const h=await setup([]);let settle!:(value:JobOutcome)=>void,cancels=0
  const done=new Promise<JobOutcome>(resolve=>settle=resolve)
  try{
   const id=h.ctx.jobs.start({kind:'bash',label:'PRIVATE_JOB_LABEL',owner:h.agent.id,run:job=>{job.append('PRIVATE_OUTPUT');return {done,cancel(){cancels++}}}})
   for(let i=0;i<220;i++)h.agent.session.append('lyapunov/service-diagnostic',{callId:'c'+i,intentKey:'intent-'+i,code:'CENTRAL_SEARCH_RECONCILIATION_REQUIRED',outcome:'error',diagnostic:{version:1,domain:'search',code:'central_search_usage_unknown',stage:'upstream_response',fieldPath:null,retryable:false,effect:'unknown',requestId:'original-request-'+i}},{ignorable:true})
   h.ctx.tools.register(defineTool({name:'uncertain',description:'unknown夹具',parameters:{},output,async execute(){throw Error('TOOL_OUTCOME_UNKNOWN')}}))
   await h.ctx.tools.execute({name:'uncertain',arguments:{},agent:h.agent,callId:ToolCallId('unknown-status'),signal:AbortSignal.timeout(1000)})
   const before=JSON.stringify(h.read(h.agent).graph.recovery),events=h.agent.session.snapshotEvents().length
   const call=async(detail?:'summary'|'full')=>h.ctx.tools.execute({name:'execution_status',arguments:detail?{detail}:{},agent:h.agent,callId:ToolCallId('status-'+(detail??'default')),signal:AbortSignal.timeout(1000)})
   const compact=await call();expect(compact.isError).toBe(false)
   if(compact.isError)throw Error('status failed')
   const compactString=(compact.value as {result:string}).result,value=JSON.parse(compactString),live=h.ctx.jobs.get(id,h.agent.id)
   expect(Buffer.byteLength(compactString)).toBeLessThanOrEqual(EXECUTION_STATUS_SUMMARY_MAX_BYTES);expect(value.detail).toBe('summary');expect(value.graph).toBeUndefined()
   expect(value.jobs.current).toContainEqual({id,registryId:live.registryId,startedAt:live.startedAt,status:'running'})
   expect(value.recovery.unknownCount).toBe(1);expect(value.recovery.unknown).toContainEqual({name:'uncertain',callId:'unknown-status',seq:expect.any(Number)})
   expect(value.recentOutcomes.some((row:{diagnostic?:{requestId?:string}})=>row.diagnostic?.requestId==='original-request-219')).toBe(true)
   const full=await call('full');expect(full.isError).toBe(false);if(full.isError)throw Error('full failed')
   const fullString=(full.value as {result:string}).result;expect(JSON.parse(fullString).graph.nodes).toHaveLength(400);expect(Buffer.byteLength(fullString)).toBeGreaterThan(Buffer.byteLength(compactString))
   await call();expect(h.agent.session.snapshotEvents()).toHaveLength(events);expect(JSON.stringify(h.read(h.agent).graph.recovery)).toBe(before);expect(h.ctx.jobs.read(id,h.agent.id).chunks.map(chunk=>chunk.text).join('')).toBe('PRIVATE_OUTPUT');expect(cancels).toBe(0);expect(compactString).not.toContain('PRIVATE')
   const denied=await h.ctx.tools.execute({name:'execution_status',arguments:{},callId:ToolCallId('no-session'),signal:AbortSignal.timeout(1000)});expect(denied.isError).toBe(true)
  }finally{settle({status:'killed'});await h.close()}
 })
})
