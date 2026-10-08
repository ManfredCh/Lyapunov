/** @tier L1 @cap cpu_fixture：仅真实localhost HTTP/SSE，实际pi-ai/Retry/AgentLoop；零收费上游。 */
import {afterEach,describe,expect,test} from 'bun:test'
import {createServer,type ServerResponse} from 'node:http'
import {randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import {mountAgentLoopTestDependencies} from '@deepseek-ai/dsh-agent-loop-testkit'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import {SessionId} from '@deepseek-ai/dsh-session'
import {createUserMessage,expandAssistantStream} from '@deepseek-ai/dsh-llm'
import {applyExecutionGraph} from '../src/execution-graph-host.ts'
const releases:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const release of releases.splice(0).reverse())await release()})
const sse=(response:ServerResponse,value:unknown)=>response.write('data: '+JSON.stringify(value)+'\n\n')
const diagnostic=(extra:Record<string,unknown>={})=>({version:1,domain:'model',code:'TIMEOUT',stage:'upstream_stream',fieldPath:null,retryable:false,effect:'unknown',requestId:'fixture-model-request',...extra})
async function harness(handler:(response:ServerResponse,n:number)=>void,mode:'normal'|'always'='normal'){
 const keyName='LYAPUNOV_A08_HTTP_FIXTURE_'+randomUUID().replaceAll('-','_')
 process.env[keyName]='fixture-not-a-secret';releases.push(async()=>{delete process.env[keyName]})
 let requests=0
 const server=createServer((request,response)=>{request.resume();request.on('end',()=>{requests++;handler(response,requests)})})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('local port missing')
 releases.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))})
 const ctx=new Context();releases.push(()=>ctx.fiber.dispose())
 await mountAgentLoopTestDependencies(ctx);await ctx.plugin(JobsLocal);await ctx.plugin(ToolJobs,{completionDelivery:'quiet'})
 await ctx.plugin(AgentLoop,{agents:[]});await ctx.plugin(Retry)
 await ctx.plugin(PiAi,{providers:{'lyapunov-plans':{api:'openai-completions',apiKeyEnv:keyName,baseURL:`http://127.0.0.1:${address.port}/v1`,compat:{supportsStore:false,supportsUsageInStreaming:true},retryPolicy:mode==='always'?{mode:'always'}:{mode:'normal',maxRetries:5,requestPhaseTimeoutMs:600,backoff:{initialDelayMs:1,maxDelayMs:1,jitterRatio:0}},models:[{id:'peiri',name:'Peiri',input:['text'],contextWindow:262144,maxTokens:64}]}}})
 const read=applyExecutionGraph(ctx,'http-fixture')
 const agent=await ctx.agentLoop.create(SessionId('model-http'),{provider:'lyapunov-plans',model:'peiri',maxTokens:32})
 const send=async()=>{const guard=setTimeout(()=>agent.cancel({kind:'user'}),1800);try{agent.followup(createUserMessage({content:[{type:'text',text:'隔离虚构请求'}],source:{kind:'user'}}));await agent.whenIdle();if(requests===0){const end=agent.session.snapshotEvents().findLast(x=>x.type==='turn/end'),error=end?.type==='turn/end'&&end.data.reason.kind==='error'?end.data.reason.error:undefined;console.log(JSON.stringify({fixtureZeroRequests:true,code:error?.code,messageChars:error?.message.length,flags:{adapter:/adapter/i.test(error?.message??''),credential:/credential|key/i.test(error?.message??''),function:/not a function/i.test(error?.message??''),tools:/tool/i.test(error?.message??''),undefined:/undefined/i.test(error?.message??'')}}))}}finally{clearTimeout(guard)}}
 return {ctx,agent,read,send,requests:()=>requests}
}
function streamError(response:ServerResponse,d:Record<string,unknown>){response.writeHead(200,{'content-type':'text/event-stream'});sse(response,{error:{type:'upstream_error',code:'TIMEOUT',message:'PRIVATE_VENDOR_DETAIL timeout',diagnostic:d}});response.end()}

describe('模型公开diagnostic实际消费',()=>{
 test('SSE未知费用/false阻止normal重发，保原requestId/stage且单终态',async()=>{
  const h=await harness(response=>streamError(response,diagnostic()))
  await h.send();expect(h.requests()).toBe(1)
  const events=h.agent.session.snapshotEvents();expect(events.filter(x=>x.type==='llm/retry')).toHaveLength(0);expect(events.filter(x=>x.type==='turn/end')).toHaveLength(1)
  const view=h.read(h.agent);expect(view.model?.diagnostic).toMatchObject({stage:'upstream_stream',effect:'unknown',retryable:false,requestId:'fixture-model-request'});expect(JSON.stringify(events)).not.toContain('PRIVATE_VENDOR_DETAIL');expect(view.model?.phase).toBe('terminal')
  expect(events.some(x=>x.type==='step/end'&&x.data.turn===1&&x.data.step===1)).toBe(true)
  expect(view.graph.nodes.find(row=>row.kind==='request')).toMatchObject({status:'failed',code:'TIMEOUT',diagnostic:{requestId:'fixture-model-request',effect:'unknown'}})
  expect(view.graph.nodes.find(row=>row.id==='step:1:1')).toMatchObject({status:'failed',code:'TIMEOUT'})
  expect(view.graph.nodes.filter(row=>['request','step','model','turn'].includes(row.kind)).every(row=>row.status!=='running')).toBe(true)
 })
 test('相同typed未知门也优先于always策略，不把code TIMEOUT当重新收费许可',async()=>{
  const h=await harness(response=>streamError(response,diagnostic()),'always');await h.send();expect(h.requests()).toBe(1);expect(h.agent.session.snapshotEvents().filter(x=>x.type==='llm/retry')).toHaveLength(0)
 })
 test('旧无diagnostic的实际500保normal maxRetries5，六次请求后唯一终态',async()=>{
  const h=await harness(response=>{response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'fixture temporary 500',type:'server_error'}}))});await h.send();expect(h.requests()).toBe(6);expect(h.agent.session.snapshotEvents().filter(x=>x.type==='llm/retry')).toHaveLength(5);expect(h.agent.session.snapshotEvents().filter(x=>x.type==='turn/end')).toHaveLength(1)
 })
 test('旧无typed诊断always仍可有限夹具重试，图中的无maxRetries事实不是NaN',async()=>{
  const h=await harness((response,n)=>{if(n===1){response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'fixture 500'}}));return}response.writeHead(200,{'content-type':'text/event-stream'});sse(response,{choices:[{index:0,delta:{content:'hello'},finish_reason:null}]});sse(response,{choices:[{index:0,delta:{},finish_reason:'stop'}]});response.write('data: [DONE]\n\n');response.end()},'always')
  await h.send();expect(h.requests()).toBe(2);expect(h.agent.session.snapshotEvents().filter(x=>x.type==='llm/retry')).toHaveLength(1)
  const graph=h.read(h.agent).graph;expect(graph.nodes.filter(row=>row.kind==='retry')).toHaveLength(1);expect(Object.values(graph.nodes.find(row=>row.kind==='retry')!.facts).every(value=>typeof value!=='number'||Number.isFinite(value))).toBe(true)
  const requests=graph.nodes.filter(row=>row.kind==='request'),models=graph.nodes.filter(row=>row.kind==='model')
  expect(requests.map(row=>row.status)).toEqual(['failed','success']);expect(models.map(row=>row.status)).toEqual(['failed','success'])
  expect(requests[0]?.code).toBe(models[0]?.code);expect(graph.nodes.find(row=>row.id==='step:1:1')?.status).toBe('success')
 })
 test('不安全requestId/fieldPath诊断fail-closed且不回显正文或重发',async()=>{
  const h=await harness(response=>streamError(response,diagnostic({requestId:'https://private?token=PRIVATE',fieldPath:'Authorization Bearer PRIVATE'})));await h.send();expect(h.requests()).toBe(1);expect(h.read(h.agent).model?.finishCode).toBe('CENTRAL_DIAGNOSTIC_INVALID');expect(JSON.stringify(h.agent.session.snapshotEvents())).not.toContain('PRIVATE')
 })
 test('真实JSON枚举数组/对象不得coerce成可重试诊断，always下每个意图仅一次HTTP',async()=>{
  for(const extra of [{domain:['model'],retryable:true,effect:'none'},{effect:['unknown'],retryable:true},{domain:{toString:'PRIVATE'},retryable:true,effect:'none'},{effect:{toString:'PRIVATE'},retryable:true}]){
   const h=await harness(response=>streamError(response,diagnostic(extra)),'always');await h.send()
   expect(h.requests()).toBe(1);expect(h.agent.session.snapshotEvents().filter(x=>x.type==='llm/retry')).toHaveLength(0)
   expect(h.read(h.agent).model).toMatchObject({finishCode:'CENTRAL_DIAGNOSTIC_INVALID',diagnostic:{retryable:false,effect:'unknown'}})
   expect(JSON.stringify(h.agent.session.snapshotEvents())).not.toContain('PRIVATE')
  }
 })
 test('同一次网络chunk先valid再invalid，invalid优先且always不得继承旧重试许可',async()=>{
  const h=await harness(response=>{
   response.writeHead(200,{'content-type':'text/event-stream'})
   const wire=[diagnostic({retryable:true,effect:'none'}),diagnostic({effect:['unknown'],retryable:true})].map(d=>'data: '+JSON.stringify({error:{code:'TIMEOUT',message:'fixture timeout',diagnostic:d}})+'\n\n').join('')
   response.end(wire)
  },'always');await h.send();expect(h.requests()).toBe(1);expect(h.agent.session.snapshotEvents().filter(x=>x.type==='llm/retry')).toHaveLength(0)
  expect(h.read(h.agent).model).toMatchObject({finishCode:'CENTRAL_DIAGNOSTIC_INVALID',diagnostic:{effect:'unknown',retryable:false}})
 })
 test('已收到typed未知结果再真实断流，保部分输出与原身份且不得重发',async()=>{
  const h=await harness(response=>{
   response.writeHead(200,{'content-type':'text/event-stream'})
   sse(response,{choices:[{index:0,delta:{content:'可保留的片段'},finish_reason:null}]})
   sse(response,{choices:[],diagnostic:diagnostic()})
   setTimeout(()=>response.destroy(),20)
  });await h.send();expect(h.requests()).toBe(1);expect(h.agent.session.snapshotEvents().filter(x=>x.type==='llm/retry')).toHaveLength(0)
  expect(h.read(h.agent).model?.diagnostic).toMatchObject({requestId:'fixture-model-request',effect:'unknown'})
  // 失败片段归原生assistant/attempt流记录，不能冒充已提交assistant/message成功。
  expect(h.agent.session.snapshotEvents().some(x=>x.type==='assistant/attempt'&&expandAssistantStream(x.data.stream).some(row=>row.chunk.type==='text-delta'&&row.chunk.text==='可保留的片段'))).toBe(true)
 })
 test('真实SSE成功finish/usage完整结束；真实用户取消不重试、图不能改成失败可重发',async()=>{
  const h=await harness(response=>{response.writeHead(200,{'content-type':'text/event-stream'});sse(response,{id:'fixture',object:'chat.completion.chunk',model:'peiri',choices:[{index:0,delta:{role:'assistant',content:'hello'},finish_reason:null}]});sse(response,{id:'fixture',object:'chat.completion.chunk',model:'peiri',choices:[{index:0,delta:{},finish_reason:'stop'}]});sse(response,{choices:[],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});response.write('data: [DONE]\n\n');response.end()});await h.send();expect(h.requests()).toBe(1);expect(h.agent.session.snapshotEvents().filter(x=>x.type==='turn/end')).toHaveLength(1);expect(h.read(h.agent).model).toMatchObject({phase:'terminal',usagePresent:true,finishCode:null})
  const cancel=await harness(response=>{response.writeHead(200,{'content-type':'text/event-stream'});sse(response,{id:'cancel',object:'chat.completion.chunk',model:'peiri',choices:[{index:0,delta:{content:'partial'},finish_reason:null}]})})
  const successEvents=h.agent.session.snapshotEvents().length;h.agent.cancel({kind:'user'});await new Promise(resolve=>setTimeout(resolve,10));expect(h.agent.session.snapshotEvents()).toHaveLength(successEvents)
  cancel.ctx.on('agent/assistant-stream',({agent,frame})=>{if(agent===cancel.agent&&frame.type==='chunk'&&frame.chunk.type==='text-delta')agent.cancel({kind:'user'})})
  await cancel.send();expect(cancel.requests()).toBe(1);expect(cancel.agent.session.snapshotEvents().filter(x=>x.type==='llm/retry')).toHaveLength(0);expect(cancel.agent.session.snapshotEvents().filter(x=>x.type==='turn/end')).toHaveLength(1)
  const cancelled=cancel.read(cancel.agent).graph
  expect(cancelled.nodes.find(row=>row.kind==='request')?.status).toBe('cancelled');expect(cancelled.nodes.find(row=>row.id==='step:1:1')?.status).toBe('cancelled');expect(cancelled.nodes.find(row=>row.id==='turn:1')?.status).toBe('cancelled')
 })
})
