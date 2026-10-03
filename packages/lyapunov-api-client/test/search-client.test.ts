import { expect, test } from 'bun:test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import Web from '@deepseek-ai/dsh-web'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { PeiriSearchProvider } from '../src/search.ts'
const READY_ME={user:{id:'fixture-user'},capabilities:{version:1,search:{ready:true,reason:null,provider:'peiri',protocol:'anthropic-native-v1',basis:'configuration',pricing:{points:1,unit:'points',billing:'per_request'}}}}
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'

type RecordedRequest = { method?: string; path?: string; headers: IncomingMessage['headers']; body: unknown }
async function localHttp(handler: (request: RecordedRequest, response: ServerResponse) => void) {
 const requests: RecordedRequest[]=[]
 const server=createServer((incoming,response)=>{
  let body=''; incoming.setEncoding('utf8'); incoming.on('data',chunk=>{body+=chunk}); incoming.on('end',()=>{
   const request={method:incoming.method,path:incoming.url,headers:incoming.headers,body:body?JSON.parse(body):undefined};requests.push(request);handler(request,response)
  })
 })
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address()
 if(!address||typeof address==='string')throw new Error('缺少本地夹具端口')
 return {apiUrl:`http://127.0.0.1:${address.port}`,requests,async close(){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error&&(error as NodeJS.ErrnoException).code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve()))}}
}
function jsonResponse(response: ServerResponse, status: number, body: unknown) { response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(body)) }
async function sdk(apiUrl: string, options: { ptc?: boolean; searchTimeoutMs?: number }={}) {
 const ctx=new Context();await ctx.plugin(SystemPrompt);await ctx.plugin(Tools,{mode:options.ptc?'both':'native'})
 if(options.ptc)await ctx.plugin(SearchBindingRuntime)
 await ctx.plugin(Web,{searchProvider:'peiri'});ctx.web.registerSearchProvider(new PeiriSearchProvider({initialMe:READY_ME,apiUrl,sessionToken:()=> 'fixture-account-session'}))
 await ctx.plugin(ToolWeb,{fetch:false,searchTimeoutMs:options.searchTimeoutMs??1000})
 return ctx
}
class SearchBindingRuntime extends PtcRuntime {
 readonly language='typescript';readonly isolation='fixture';static query='查询 18446744073709551615\n"原样" \\路径'
 constructor(ctx: Context){super(ctx)}
 resolve(request:PtcRunRequest):PtcRunSpec{return {...request,cwd:request.cwd??process.cwd(),timeoutMs:request.timeoutMs??1000}}
 async run(request:PtcRunRequest):Promise<PtcRunResult>{
  const functions=request.bindings[0]!.functions
  let invalid='';try{await functions.web_search!({queries:[18446744073709551615n]})}catch(error){invalid=(error as Error).message}
  const value=await functions.web_search!({queries:[SearchBindingRuntime.query]})
  return {logs:[],value:{invalid,result:value}}
 }
}

test('真实web_search SDK使用中央账号入口，一次查询，供应商credentials不参与', async () => {
 const ctx=new Context();let calls=0
 await ctx.plugin(SystemPrompt);await ctx.plugin(Tools);await ctx.plugin(Web,{searchProvider:'peiri'})
 ctx.web.registerSearchProvider(new PeiriSearchProvider({initialMe:READY_ME,apiUrl:'https://central.fixture/lyaup-unified',sessionToken:()=> 'fixture-account-session',fetcher:async(url,init)=>{
  calls++;expect(String(url)).toBe('https://central.fixture/lyaup-unified/v1/web/search');expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-account-session');expect(new Headers(init?.headers).get('x-api-key')).toBeNull();expect(init?.redirect).toBe('error')
  expect(JSON.parse(String(init?.body))).toEqual({query:'公开小文件隔离夹具',maxResults:8})
  return Response.json({sources:[{url:'https://public.fixture/robots.txt',title:'公开来源'}],truncated:false})
 }}));await ctx.plugin(ToolWeb,{fetch:false})
 try{const result=await ctx.tools.execute({name:'web_search',arguments:{queries:['公开小文件隔离夹具']},signal:new AbortController().signal,callId:ToolCallId('isolated-search')});expect(result.isError).toBe(false);expect(calls).toBe(1)}finally{await ctx.fiber.dispose()}
})
test('缺后台配置/超时/错响应不假成功，无会话/坏参数不发送；不索取客户端API key', async()=>{
 for(const status of [404,503,504]){let calls=0;const provider=new PeiriSearchProvider({initialMe:READY_ME,apiUrl:'https://central.fixture',sessionToken:()=> 'fixture-account-session',fetcher:async()=>{calls++;return Response.json({error:'central_search_unavailable'},{status})}});await expect(provider.search({query:'隔离查询'})).rejects.toThrow(`HTTP ${status}`);expect(calls).toBe(1)}
 let calls=0;const missing=new PeiriSearchProvider({initialMe:READY_ME,apiUrl:'https://central.fixture',sessionToken:()=>undefined,fetcher:async()=>{calls++;throw new Error('不应请求')}});await expect(missing.search({query:'隔离查询'})).rejects.toThrow('当前正式账号会话');expect(calls).toBe(0)
 const bad=new PeiriSearchProvider({initialMe:READY_ME,apiUrl:'https://central.fixture',sessionToken:()=> 'fixture-account-session',fetcher:async()=>Response.json({content:'仅模型散文'})});await expect(bad.search({query:'隔离查询'})).rejects.toThrow('不是结构化来源')
 await expect(bad.search({query:''})).rejects.toThrow('参数无效')
})
test('中央账务未知/结构拒绝/无原生结果按白名单分类，不透传内部供应商正文', async()=>{
 for(const [error,status,code] of [['central_search_reconciliation_required',409,'CENTRAL_SEARCH_RECONCILIATION_REQUIRED'],['central_search_pending',409,'CENTRAL_SEARCH_RECONCILIATION_REQUIRED'],['central_search_reservation_unknown',409,'CENTRAL_SEARCH_RECONCILIATION_REQUIRED'],['central_search_upstream_rejected',422,'CENTRAL_SEARCH_INVALID_QUERY'],['central_search_invalid_response',502,'CENTRAL_SEARCH_INVALID_RESPONSE'],['central_search_identity_conflict',409,'CENTRAL_SEARCH_CONFLICT']] as const){
  let calls=0
  const provider=new PeiriSearchProvider({initialMe:READY_ME,apiUrl:'https://central.fixture',sessionToken:()=> 'fixture-account-session',fetcher:async()=>{calls++;return Response.json({error,message:'PRIVATE_FIXTURE_PROVIDER_MESSAGE',apiKey:'PRIVATE_FIXTURE_KEY'},{status})}})
  try{await provider.search({query:'隔离查询'});throw new Error('必须明确失败')}catch(value){expect(value).toMatchObject({code});expect(String(value)).not.toContain('PRIVATE_FIXTURE')}
  expect(calls).toBe(1)
 }
})

test('真实HTTP中央provider与ToolRegistry：账号令牌只发中央，query无损/重复去重，返回完整来源',async()=>{
 const query='查询 18446744073709551615\n"原样" \\路径';let fixture:Awaited<ReturnType<typeof localHttp>>
 fixture=await localHttp((request,response)=>{
  if(request.path==='/v1/web/search')jsonResponse(response,200,{sources:[{url:fixture.apiUrl+'/public.txt',title:'同源公开小文件',publishedAt:'2026-10-01'}],truncated:false})
  else{response.writeHead(200,{'content-type':'text/plain'});response.end('真实小型公开文件字节')}
 })
 const ctx=await sdk(fixture.apiUrl)
 try{
  const result=await ctx.tools.execute({name:'web_search',arguments:{queries:[query,query]},signal:AbortSignal.timeout(2000),callId:ToolCallId('http-search')})
  expect(result.isError).toBe(false);expect(fixture.requests).toHaveLength(1);expect(fixture.requests[0]!.body).toEqual({query,maxResults:8})
  expect(fixture.requests[0]!.method).toBe('POST');expect(fixture.requests[0]!.headers.authorization).toBe('Bearer fixture-account-session')
  expect(fixture.requests[0]!.headers['x-api-key']).toBeUndefined();expect(fixture.requests[0]!.headers['idempotency-key']).toMatch(/^search-[0-9a-f-]+$/)
  if(result.isError)throw new Error('有效中央结果不可失败');expect(result.value).toMatchObject({sources:[{url:fixture.apiUrl+'/public.txt',title:'同源公开小文件',publishedAt:'2026-10-01'}],truncated:false})
 }finally{await ctx.fiber.dispose();await fixture.close()}
})

test('真实HTTP/PTC边界：字符串64位身份、换行和反斜线无损；BigInt schema拒绝而不出站',async()=>{
 const fixture=await localHttp((_,response)=>jsonResponse(response,200,{sources:[{url:'https://public.fixture/file.txt'}],truncated:false}));const ctx=await sdk(fixture.apiUrl,{ptc:true})
 try{
  const result=await ctx.tools.execute({name:RUN_CODE_NAME,arguments:{code:'await tools.web_search({queries})',description:'隔离PTC协议验证'},signal:AbortSignal.timeout(2000),callId:ToolCallId('ptc-search')})
  expect(result.isError).toBe(false);if(result.isError)throw new Error('合法PTC查询应通过')
  expect(result.value).toMatchObject({logs:[],result:{invalid:'tool arguments must be lossless JSON (call the tool with an arguments object, e.g. `{}`)',result:{sources:[{url:'https://public.fixture/file.txt'}],truncated:false}}})
  expect(fixture.requests).toHaveLength(1);expect(fixture.requests[0]!.body).toEqual({query:SearchBindingRuntime.query,maxResults:8})
 }finally{await ctx.fiber.dispose();await fixture.close()}
})

test('真实HTTP中央错误：400/502传输/504超时/499取消/未配置准确分类，一次查询，不泄露供应商正文',async()=>{
 for(const [status,error,code] of [[400,'invalid_request','CENTRAL_SEARCH_INVALID_QUERY'],[502,'central_search_transport_error','CENTRAL_SEARCH_TRANSPORT'],[502,'central_search_upstream_error','CENTRAL_SEARCH_UNAVAILABLE'],[504,'central_search_timeout','CENTRAL_SEARCH_TIMEOUT'],[499,'central_search_cancelled','WEB_ABORTED'],[503,'central_search_unavailable','CENTRAL_SEARCH_UNAVAILABLE']] as const){
  const fixture=await localHttp((_,response)=>jsonResponse(response,status,{error,message:'PRIVATE_FIXTURE_PROVIDER_BODY',apiKey:'PRIVATE_FIXTURE_KEY'}));const ctx=await sdk(fixture.apiUrl)
  try{const result=await ctx.tools.execute({name:'web_search',arguments:{queries:['隔离查询']},signal:AbortSignal.timeout(2000),callId:ToolCallId('http-error-search')});expect(result.isError).toBe(true);if(!result.isError)throw new Error('中央失败不可伪成功');expect(result.error.info?.code).toBe(code);expect(result.error.message).not.toContain('PRIVATE_FIXTURE');expect(result.error.message).not.toContain('DEEPSEEK_API_KEY');expect(fixture.requests).toHaveLength(1)}finally{await ctx.fiber.dispose();await fixture.close()}
 }
})

test('真实HTTP响应正文取消仍是WEB_ABORTED，断流保留传输未知状态，均有限退出且不重复查询',async()=>{
 for(const mode of ['abort','drop'] as const){
  const fixture=await localHttp((_,response)=>{response.writeHead(200,{'content-type':'application/json'});response.write('{"sources":[');if(mode==='drop')setTimeout(()=>response.destroy(),20)})
  const provider=new PeiriSearchProvider({initialMe:READY_ME,apiUrl:fixture.apiUrl,sessionToken:()=> 'fixture-account-session'})
  try{await expect(provider.search({query:'隔离查询'},AbortSignal.timeout(80))).rejects.toMatchObject({code:mode==='abort'?'WEB_ABORTED':'CENTRAL_SEARCH_TRANSPORT'});expect(fixture.requests).toHaveLength(1)}finally{await fixture.close()}
 }
})

test('真实HTTP非法响应/地址拒绝：不把坏日期、非HTTP账户地址或注入供应商key当作合法查询',async()=>{
 const fixture=await localHttp((_,response)=>jsonResponse(response,200,{sources:[{url:'https://public.fixture/file.txt',publishedAt:{bad:'type'}}],truncated:false}))
 try{const provider=new PeiriSearchProvider({initialMe:READY_ME,apiUrl:fixture.apiUrl,sessionToken:()=> 'fixture-account-session'});await expect(provider.search({query:'隔离查询'})).rejects.toMatchObject({code:'CENTRAL_SEARCH_INVALID_RESPONSE'});expect(fixture.requests).toHaveLength(1)}finally{await fixture.close()}
 for(const apiUrl of ['ftp://localhost','file://localhost/path','http://public.fixture','https://key:secret@public.fixture','https://public.fixture?apiKey=fixture'])expect(()=>new PeiriSearchProvider({initialMe:READY_ME,apiUrl,sessionToken:()=> 'fixture-account-session'})).toThrow('INVALID_ACCOUNT_API_URL')
})

test('真实HTTP搜索重定向不携会话转往供应商，只有一次中央请求',async()=>{
 const forbidden=await localHttp((_,response)=>jsonResponse(response,200,{sources:[],truncated:false}));const central=await localHttp((_,response)=>{response.writeHead(302,{location:forbidden.apiUrl+'/supplier'});response.end()})
 try{const provider=new PeiriSearchProvider({initialMe:READY_ME,apiUrl:central.apiUrl,sessionToken:()=> 'fixture-account-session'});await expect(provider.search({query:'隔离查询'},AbortSignal.timeout(1000))).rejects.toMatchObject({code:'CENTRAL_SEARCH_TRANSPORT'});expect(central.requests).toHaveLength(1);expect(forbidden.requests).toHaveLength(0)}finally{await central.close();await forbidden.close()}
})

test('真实HTTP完整非法JSON归结构错误，和断流分别记录，不循环请求',async()=>{
 const fixture=await localHttp((_,response)=>{response.writeHead(200,{'content-type':'application/json'});response.end('{"sources":[')})
 try{const provider=new PeiriSearchProvider({initialMe:READY_ME,apiUrl:fixture.apiUrl,sessionToken:()=> 'fixture-account-session'});await expect(provider.search({query:'隔离查询'})).rejects.toMatchObject({code:'CENTRAL_SEARCH_INVALID_RESPONSE'});expect(fixture.requests).toHaveLength(1)}finally{await fixture.close()}
})
