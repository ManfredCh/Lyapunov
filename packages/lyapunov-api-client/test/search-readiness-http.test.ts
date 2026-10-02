/** @tier L1 @cap cpu_fixture：真实localhost/me/搜索身份/免费诊断，不访问生产或账本。 */
import {afterEach,expect,test} from 'bun:test'
import {createServer,type ServerResponse} from 'node:http'
import {promisify} from 'node:util'
import {execFile} from 'node:child_process'
import {resolve} from 'node:path'
import {PeiriSearchProvider} from '../src/search.ts'
import {createCentralReadOnlyDiagnostic} from '../src/read-only-diagnostic.ts'
import {centralDiagnostic} from '../src/service-contract.ts'
const close:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const release of close.splice(0).reverse())await release()})
const READY={user:{id:'fixture-user'},capabilities:{version:1,search:{ready:true,reason:null,provider:'peiri',protocol:'anthropic-native-v1',basis:'configuration',pricing:{points:7,unit:'points',billing:'per_request'}}}} as const
const json=(r:ServerResponse,value:unknown,status=200)=>{r.writeHead(status,{'content-type':'application/json'});r.end(JSON.stringify(value))}
async function http(handler:(request:{path:string;method:string;body:unknown;key:string|undefined},response:ServerResponse)=>void){
 const requests:Array<{path:string;method:string;body:unknown;key:string|undefined}>=[]
 const server=createServer((incoming,response)=>{let text='';incoming.setEncoding('utf8');incoming.on('data',part=>text+=part);incoming.on('end',()=>{const request={path:incoming.url??'',method:incoming.method??'',body:text?JSON.parse(text):undefined,key:incoming.headers['idempotency-key'] as string|undefined};requests.push(request);handler(request,response)})})
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw Error('port missing')
 close.push(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()))})
 return {apiUrl:`http://127.0.0.1:${address.port}`,requests}
}

test('available只读缓存，初始unknown=false；真实认证/me v1才ready，未知字段不进入状态',async()=>{
 const h=await http((request,response)=>json(response,request.path==='/v1/me'?{...READY,token:'PRIVATE',ledger:'PRIVATE'}:{sources:[],truncated:false}))
 const provider=new PeiriSearchProvider({apiUrl:h.apiUrl,sessionToken:()=> 'fixture'})
 expect(provider.available()).toBe(false);expect(h.requests).toHaveLength(0)
 const status=await provider.refreshReadiness();expect(status.readiness).toEqual(READY.capabilities.search);expect(provider.available()).toBe(true);expect(h.requests).toHaveLength(1);provider.available();expect(h.requests).toHaveLength(1);expect(JSON.stringify(provider.cachedReadiness())).not.toContain('PRIVATE')
})
test('旧/缺DTO、错误protocol/provider/非法价格均fail-closed且不发搜索；guest无token零请求',async()=>{
 for(const body of [{user:{id:'fixture-user'}},{capabilities:{version:2,search:READY.capabilities.search}},{capabilities:{version:1,search:{...READY.capabilities.search,protocol:'model-wrapper'}}},{capabilities:{version:1,search:{...READY.capabilities.search,provider:'direct'}}},{capabilities:{version:1,search:{...READY.capabilities.search,pricing:{points:0,unit:'points',billing:'per_request'}}}}]){
  const h=await http((_,response)=>json(response,body)),provider=new PeiriSearchProvider({apiUrl:h.apiUrl,sessionToken:()=> 'fixture'})
  await expect(provider.search({query:'隔离查询'})).rejects.toMatchObject({code:'CENTRAL_SEARCH_CAPABILITY_UNKNOWN'});expect(provider.available()).toBe(false);expect(h.requests.every(row=>row.method==='GET')).toBe(true)
 }
 const h=await http((_,response)=>json(response,READY)),guest=new PeiriSearchProvider({apiUrl:h.apiUrl,sessionToken:()=>undefined});expect(guest.available()).toBe(false);await guest.refreshReadiness();await expect(guest.search({query:'q'})).rejects.toMatchObject({code:'CENTRAL_SEARCH_AUTH_REQUIRED'});expect(h.requests).toHaveLength(0)
})
test('六种正式reason原样保留，配置ready不冒充provider实测；token切换清旧ready',async()=>{
 for(const reason of ['not_configured','configuration_incomplete','pricing_missing','billing_unavailable','not_assembled','source_unverified'] as const){
  const h=await http((_,response)=>json(response,{capabilities:{version:1,search:{...READY.capabilities.search,ready:false,reason,pricing:null}}}));let token='fixture-a'
  const provider=new PeiriSearchProvider({apiUrl:h.apiUrl,sessionToken:()=>token});expect((await provider.refreshReadiness()).reason).toBe(reason);expect(provider.available()).toBe(false);token='fixture-b';expect(provider.cachedReadiness().readiness).toBeNull()
 }
})
test('实际OpenAI DTO保预留cap/按usage结算来源，缺source回执或未验证不得ready',async()=>{
 const pricing={points:3156,unit:'points',billing:'per_request',settlement:'actual_usage',priceVersion:'fixture-public-20261001',minimumMarginBps:2000,costBasis:'official-public-upper-bound',providerTariffVerified:false}
 const sourceCapability={verified:true,basis:'controlled-native-source-receipt',verifiedAt:'2026-10-01T05:00:00.000Z'}
 const row={...READY.capabilities.search,protocol:'openai-responses-web-search-v1',pricing,sourceCapability}
 for(const input of [row,{...row,ready:false,reason:'source_unverified',sourceCapability:{...sourceCapability,verified:false,verifiedAt:null}},{...row,sourceCapability:undefined},{...row,sourceCapability:{...sourceCapability,verified:false}},{...row,pricing:{...pricing,minimumMarginBps:1999}},{...row,protocol:['openai-responses-web-search-v1']}]){
  const h=await http((_,response)=>json(response,{capabilities:{version:1,search:input}})),provider=new PeiriSearchProvider({apiUrl:h.apiUrl,sessionToken:()=> 'fixture'})
  const availability=await provider.refreshReadiness();expect(h.requests).toHaveLength(1)
  if(input===row){expect(provider.available()).toBe(true);expect(availability.readiness).toMatchObject({pricing,sourceCapability})}
  else{expect(provider.available()).toBe(false);expect(availability.readiness?.reason??'capability_unknown').toBe(input.reason==='source_unverified'?'source_unverified':'capability_unknown')}
 }
})
test('公开诊断严格拒枚举数组/对象与秘密身份，不将错误typed字段coerce为valid',()=>{
 const base={version:1,domain:'search',code:'central_search_pending',stage:'lookup',fieldPath:null,retryable:true,effect:'none',requestId:'fixture-search'} as const
 expect(centralDiagnostic({diagnostic:base})).toEqual(base)
 for(const extra of [{domain:['search']},{effect:['unknown']},{domain:{toString:'PRIVATE'}},{effect:{toString:'PRIVATE'}},{requestId:'sk-PRIVATE'}])expect(centralDiagnostic({diagnostic:{...base,...extra}})).toBeUndefined()
})
test('生产ISO微秒/明确时区与已核价true原样保留，非法日期/数组/未验证不能ready',async()=>{
 const row={...READY.capabilities.search,protocol:'openai-responses-web-search-v1',pricing:{points:3156,unit:'points',billing:'per_request',settlement:'actual_usage',priceVersion:'fixture-current',minimumMarginBps:2000,costBasis:'official-public-upper-bound',providerTariffVerified:true},sourceCapability:{verified:true,basis:'controlled-native-source-receipt',verifiedAt:'2026-10-01T05:00:00.123456+00:00'}}
 for(const source of [row.sourceCapability,{...row.sourceCapability,verifiedAt:'2026-02-30T05:00:00Z'},{...row.sourceCapability,verifiedAt:'2026-10-01T25:00:00Z'},{...row.sourceCapability,verifiedAt:['2026-10-01T05:00:00Z']},{...row.sourceCapability,verifiedAt:''},{...row.sourceCapability,verified:false}]){
  const h=await http((_,response)=>json(response,{capabilities:{version:1,search:{...row,sourceCapability:source}}})),provider=new PeiriSearchProvider({apiUrl:h.apiUrl,sessionToken:()=> 'fixture'})
  const state=await provider.refreshReadiness()
  if(source===row.sourceCapability){expect(provider.available()).toBe(true);expect(state.readiness).toMatchObject({sourceCapability:row.sourceCapability,pricing:{providerTariffVerified:true}})}
  else expect(provider.available()).toBe(false)
 }
})
test('生产POST lyapunov回执不混入Web schema，原ID可读回；outer409费用未知保真实5xx原因与原key',async()=>{
 const ids:Array<string|null>=[];let posts=0
 const meta={requestId:'original-server-request',protocol:'openai-responses-web-search-v1',reservedPoints:3156,charge:{chargedPoints:11,priceVersion:'fixture-current',providerTariffVerified:true}}
 const h=await http((request,response)=>{
  if(request.path==='/v1/me'){json(response,READY);return}
  posts++
  if(posts===1)json(response,{sources:[{url:'https://public.example/source'}],truncated:false,lyapunov:meta})
  else json(response,{error:'central_search_usage_unknown',upstreamHttpStatus:502,upstreamFailureCode:'central_search_transport_error',message:'PRIVATE_VENDOR_BODY',diagnostic:{version:1,domain:'search',code:'central_search_usage_unknown',stage:'upstream_response',fieldPath:null,retryable:false,effect:'unknown',requestId:meta.requestId}},409)
 })
 const provider=new PeiriSearchProvider({apiUrl:h.apiUrl,sessionToken:()=> 'fixture',onReceipt:row=>ids.push(row.diagnostic.requestId)}),intent={query:'同一原意图'}
 expect((await provider.search(intent)).sources).toHaveLength(1);expect(ids).toEqual([meta.requestId])
 await expect(provider.search(intent)).rejects.toMatchObject({code:'CENTRAL_SEARCH_RECONCILIATION_REQUIRED',diagnostic:{effect:'unknown',retryable:false,upstreamHttpStatus:502,upstreamFailureCode:'central_search_transport_error',requestId:meta.requestId}})
 expect(h.requests.filter(row=>row.method==='POST').map(row=>row.key)[0]).toBe(h.requests.filter(row=>row.method==='POST').map(row=>row.key)[1]);expect(posts).toBe(2)
})
test('真实断流→同intent同key恢复409，零新reserve；不同意图不按query全局缓存',async()=>{
 const rows=new Map<string,string>();let reserves=0
 const h=await http((request,response)=>{
  if(request.path==='/v1/me'){json(response,READY);return}
  const body=JSON.stringify(request.body),key=request.key!
  if(rows.has(key)){json(response,{error:rows.get(key)===body?'central_search_pending':'central_search_identity_conflict',diagnostic:{version:1,domain:'search',code:'central_search_pending',stage:'lookup',fieldPath:null,retryable:false,effect:'unknown',requestId:'fixture-search'}},409);return}
  rows.set(key,body);reserves++;response.writeHead(200,{'content-type':'application/json','content-length':'1024'});response.write('{"sources":[');setTimeout(()=>response.destroy(),20)
 })
 const provider=new PeiriSearchProvider({apiUrl:h.apiUrl,sessionToken:()=> 'fixture'}),intent={query:'原样 18446744073709551615\n"中文" \\路径'}
 await expect(provider.search(intent)).rejects.toMatchObject({code:'CENTRAL_SEARCH_TRANSPORT'})
 await expect(provider.search(intent)).rejects.toMatchObject({code:'CENTRAL_SEARCH_RECONCILIATION_REQUIRED',diagnostic:{requestId:'fixture-search',effect:'unknown',retryable:false}})
 expect(reserves).toBe(1);const posts=h.requests.filter(x=>x.method==='POST');expect(posts[0]?.key).toBe(posts[1]?.key)
 intent.query='修改内容';await expect(provider.search(intent)).rejects.toMatchObject({code:'CENTRAL_SEARCH_CONFLICT'});expect(reserves).toBe(1)
 await expect(provider.search({query:'修改内容'})).rejects.toMatchObject({code:'CENTRAL_SEARCH_TRANSPORT'});expect(reserves).toBe(2)
})
test('实际Native ToolRegistry按call identity+query index保key，不从query做全局去重',async()=>{
 const h=await http((request,response)=>json(response,request.path==='/v1/me'?READY:{sources:[{url:'https://public.example/source'}],truncated:false,lyapunov:{requestId:'fixture-production-post',protocol:'openai-responses-web-search-v1',reservedPoints:3156,charge:{chargedPoints:11,priceVersion:'fixture-current',providerTariffVerified:true}}}))
 const root=resolve(import.meta.dirname,'../../..')
 const code=`import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';const require=createRequire(${JSON.stringify(root+'/package.json')});const mod=n=>import(pathToFileURL(require.resolve(n)));const {Context}=await mod('@deepseek-ai/cordis');const {default:System}=await mod('@deepseek-ai/dsh-system-prompt');const {default:Tools}=await mod('@deepseek-ai/dsh-tools');const {default:Web}=await mod('@deepseek-ai/dsh-web');const ToolWeb=await mod('@deepseek-ai/dsh-tool-web');const {ToolCallId}=await mod('@deepseek-ai/dsh-llm');const Api=await import(${JSON.stringify('file://'+root+'/packages/lyapunov-api-client/dist/plugin.js')});const ctx=new Context();try{await ctx.plugin(System);await ctx.plugin(Tools);await ctx.plugin(Web,{searchProvider:'peiri'});await ctx.plugin(Api,{apiUrl:${JSON.stringify(h.apiUrl)},search:true});await ctx.get('peiriSearchReadiness').refresh(AbortSignal.timeout(2000));await ctx.plugin(ToolWeb,{fetch:false});for(const id of ['same','same','new','single']){const r=await ctx.tools.execute({name:'web_search',arguments:{queries:id==='single'?['one query']:['same query','other query']},signal:AbortSignal.timeout(2000),callId:ToolCallId(id)});if(r.isError)throw Error(r.error.info?.code)}console.log(JSON.stringify({ready:ctx.get('peiriSearchReadiness').available()}))}finally{await ctx.fiber.dispose()}`
 const node='/home/s18/WS/Lyapunov/E/release-20261001/a07-readback/lyapunov-dsh-0.1.0-linux-x64/runtime/node/bin/node'
 const result=await promisify(execFile)(node,['--input-type=module','-e',code],{cwd:root,env:{PATH:'/usr/bin:/bin',NODE_ENV:'production',LYAPUNOV_MODE:'formal',LYAPUNOV_ACCOUNT_TOKEN:'fixture-account-session'},timeout:8000})
 expect(JSON.parse(result.stdout.trim()).ready).toBe(true)
 const posts=h.requests.filter(x=>x.method==='POST');expect(posts).toHaveLength(7)
 // HTTP并行到达顺序不是query index；按真实请求正文对应原调用中的query，保同intent同key门。
 const group=(offset:number)=>Object.fromEntries(posts.slice(offset,offset+2).map(row=>[(row.body as {query:string}).query,row.key]))
 expect(group(0)).toEqual(group(2));expect(group(0)['same query']).not.toBe(group(0)['other query']);expect(group(4)['same query']).not.toBe(group(0)['same query']);expect((posts[6]!.body as {query:string}).query).toBe('one query')
})
test('正式默认API插件不因模型/ambient key注册Peiri搜索，没有keyword provider不访问中央',async()=>{
 const h=await http((_,response)=>json(response,{error:'central_search_unavailable'},503)),root=resolve(import.meta.dirname,'../../..')
 const code=`import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';const require=createRequire(${JSON.stringify(root+'/package.json')});const mod=n=>import(pathToFileURL(require.resolve(n)));const {Context}=await mod('@deepseek-ai/cordis');const {default:System}=await mod('@deepseek-ai/dsh-system-prompt');const {default:Tools}=await mod('@deepseek-ai/dsh-tools');const {default:Web}=await mod('@deepseek-ai/dsh-web');const ToolWeb=await mod('@deepseek-ai/dsh-tool-web');const {ToolCallId}=await mod('@deepseek-ai/dsh-llm');const Api=await import(${JSON.stringify('file://'+root+'/packages/lyapunov-api-client/dist/plugin.js')});const ctx=new Context();try{await ctx.plugin(System);await ctx.plugin(Tools);await ctx.plugin(Web);await ctx.plugin(Api,{apiUrl:${JSON.stringify(h.apiUrl)}});await ctx.plugin(ToolWeb);const r=await ctx.tools.execute({name:'web_search',arguments:{queries:['official source']},signal:AbortSignal.timeout(2000),callId:ToolCallId('default-native')});console.log(JSON.stringify({hasCentralProvider:ctx.get('peiriSearchReadiness')!==undefined,isError:r.isError,code:r.isError?r.error.info?.code:null,fetchRegistered:ctx.tools.get('web_fetch')!==undefined}))}finally{await ctx.fiber.dispose()}`
 const node='/home/s18/WS/Lyapunov/E/release-20261001/a07-readback/lyapunov-dsh-0.1.0-linux-x64/runtime/node/bin/node'
 const r=await promisify(execFile)(node,['--input-type=module','-e',code],{cwd:root,env:{PATH:'/usr/bin:/bin',NODE_ENV:'production',LYAPUNOV_MODE:'formal',LYAPUNOV_ACCOUNT_TOKEN:'fixture-account-session',DEEPSEEK_API_KEY:'ambient-fixture-never-use',DSH_MODEL:'peiri'},timeout:8000})
 expect(JSON.parse(r.stdout.trim())).toEqual({hasCentralProvider:false,isError:true,code:'WEB_PROVIDER_UNAVAILABLE',fetchRegistered:true});expect(h.requests).toHaveLength(0)
})
test('显式legacy中央搜索不可用不拦Native自有provider/fetch，guest仍零产品请求',async()=>{
 const h=await http((request,response)=>{
  if(request.path.startsWith('/client-search?'))json(response,{sources:[{url:'https://official.example/source',title:'Native client source'}],truncated:false})
  else if(request.path==='/public-page'){response.writeHead(200,{'content-type':'text/plain'});response.end('native public page bytes')}
  else json(response,{error:'central_search_unavailable'},503)
 }),root=resolve(import.meta.dirname,'../../..'),node='/home/s18/WS/Lyapunov/E/release-20261001/a07-readback/lyapunov-dsh-0.1.0-linux-x64/runtime/node/bin/node'
 for(const mode of ['formal','guest']){
  const code=`import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';const require=createRequire(${JSON.stringify(root+'/package.json')});const mod=n=>import(pathToFileURL(require.resolve(n)));const {Context}=await mod('@deepseek-ai/cordis');const {default:System}=await mod('@deepseek-ai/dsh-system-prompt');const {default:Tools}=await mod('@deepseek-ai/dsh-tools');const {default:Web}=await mod('@deepseek-ai/dsh-web');const ToolWeb=await mod('@deepseek-ai/dsh-tool-web');const {ToolCallId}=await mod('@deepseek-ai/dsh-llm');const Api=await import(${JSON.stringify('file://'+root+'/packages/lyapunov-api-client/dist/plugin.js')});const ctx=new Context();try{await ctx.plugin(System);await ctx.plugin(Tools);await ctx.plugin(Web,{searchProvider:'explicit-native'});await ctx.plugin(Api,{apiUrl:${JSON.stringify(h.apiUrl)},search:true});ctx.web.registerSearchProvider({id:'explicit-native',available:()=>true,async search(request,signal){return(await fetch(${JSON.stringify(h.apiUrl+'/client-search?query=')}+encodeURIComponent(request.query),{signal})).json()}});ctx.web.registerFetchProvider({id:'explicit-http-fixture',available:()=>true,async fetch(request,signal){const r=await fetch(request.url,{signal});return{url:request.url,statusCode:r.status,body:{kind:'text',content:await r.text()},truncated:false}}});await ctx.plugin(ToolWeb);const a=await ctx.tools.execute({name:'web_search',arguments:{queries:['official source']},signal:AbortSignal.timeout(2000),callId:ToolCallId('own-search')});const b=await ctx.tools.execute({name:'web_fetch',arguments:{url:${JSON.stringify(h.apiUrl+'/public-page')}},signal:AbortSignal.timeout(2000),callId:ToolCallId('client-fetch')});console.log(JSON.stringify({searchError:a.isError,fetchError:b.isError,centralReady:ctx.get('peiriSearchReadiness')?.available()??null,content:b.isError?null:b.value.body.content}))}finally{await ctx.fiber.dispose()}`
  const r=await promisify(execFile)(node,['--input-type=module','-e',code],{cwd:root,env:{PATH:'/usr/bin:/bin',NODE_ENV:'production',LYAPUNOV_MODE:mode,LYAPUNOV_ACCOUNT_TOKEN:'synthetic-guest-token-must-not-route',DEEPSEEK_API_KEY:'ambient-fixture-never-use'},timeout:8000})
  expect(JSON.parse(r.stdout.trim())).toEqual({searchError:false,fetchError:false,centralReady:mode==='formal'?false:null,content:'native public page bytes'})
 }
 expect(h.requests.filter(request=>request.path.startsWith('/v1/'))).toHaveLength(0);expect(h.requests.filter(request=>request.path.startsWith('/client-search?'))).toHaveLength(2);expect(h.requests.filter(request=>request.path==='/public-page')).toHaveLength(2)
})
test('默认免费诊断me不创建搜索状态、不重复读取me，原请求lookup仍仅GET',async()=>{
 const h=await http((request,response)=>json(response,request.path==='/v1/me'?{user:{id:'fixture-user'}}:{error:'model_request_not_found'},request.path==='/v1/me'?200:404))
 const read=createCentralReadOnlyDiagnostic({apiUrl:h.apiUrl,sessionToken:()=> 'fixture',mode:()=> 'formal'})
 expect(await read({action:'me'})).toMatchObject({identityMatch:true,pathTemplate:'/v1/me',publicCode:'CENTRAL_IDENTITY_VERIFIED',reservationCreated:false});expect(h.requests).toHaveLength(1)
 const lookup=await read({action:'lookup',domain:'model',requestId:'original-model-request'});expect(lookup).toMatchObject({found:false,publicCode:'model_request_not_found',reservationCreated:false});expect(h.requests.every(row=>row.method==='GET')).toBe(true);expect(h.requests.some(row=>row.path==='/v1/web/search')).toBe(false)
})
test('G8免费me/quote/规范lookup桥复用真实认证与恢复门，仅GET且不输出route/account/token/账本',async()=>{
 let wrong=false
 const h=await http((request,response)=>{if(request.path==='/v1/me')json(response,READY);else if(request.path.includes('/generation-quotes/'))json(response,{product:'tripo',accountId:wrong?'foreign':'fixture-user',quoteId:'a'.repeat(64),points:9,unit:'points',pricing:'configured-fixed',reservationCreated:false});else json(response,{error:'generation_request_not_found'},404)})
 const provider=new PeiriSearchProvider({apiUrl:h.apiUrl,sessionToken:()=> 'fixture'}),read=createCentralReadOnlyDiagnostic({apiUrl:h.apiUrl,sessionToken:()=> 'fixture',mode:()=> 'formal',searchProvider:provider})
 expect(await read({action:'me'})).toMatchObject({identityMatch:true,pathTemplate:'/v1/me',status:200,reservationCreated:false,search:{readiness:{ready:true}}})
 expect(await read({action:'quote',product:'tripo'})).toMatchObject({identityMatch:true,status:200,unit:'points',pricing:'configured-fixed',points:9,reservationCreated:false})
 const lookup=await read({action:'lookup',product:'tripo',requestId:'fresh-fixture-nonce'});expect(lookup).toMatchObject({identityMatch:true,status:404,publicCode:'generation_request_not_found',found:false,reservationCreated:false})
 wrong=true;expect(await read({action:'quote',product:'tripo'})).toMatchObject({identityMatch:false,publicCode:'CENTRAL_GENERATION_QUOTE_INVALID'})
 const before=h.requests.length;const guest=createCentralReadOnlyDiagnostic({apiUrl:h.apiUrl,sessionToken:()=> 'fixture',mode:()=> 'local',searchProvider:provider});await expect(guest({action:'quote'})).rejects.toThrow('游客');expect(h.requests).toHaveLength(before);expect(h.requests.every(row=>row.method==='GET')).toBe(true)
 expect(JSON.stringify(lookup)).not.toContain('fixture-user');expect(JSON.stringify(lookup)).not.toContain('fixture-account-session');expect(JSON.stringify(lookup)).not.toContain(h.apiUrl)
})
test('同认证免费model/search原ID读回只留公开状态，unknown不重提交且foreign/missing404不假成功',async()=>{
 const h=await http((request,response)=>{
  if(request.path==='/v1/me'){json(response,READY);return}
  const domain=request.path.includes('/model-requests/')?'model':'search',id=request.path.split('/').at(-1)
  if(id==='missing'){json(response,{error:domain+'_request_not_found'},404);return}
  json(response,{requestId:id,status:domain==='model'?'reconciliation_required':'searching',effect:'unknown',retryable:false,estimatedPoints:3156,chargedPoints:null,accountId:'PRIVATE',token:'PRIVATE',diagnostic:{version:1,domain,code:domain==='model'?'model_reconciliation_required':'central_search_usage_unknown',stage:domain==='model'?'lookup':'searching',fieldPath:null,retryable:false,effect:'unknown',requestId:id}})
 })
 const provider=new PeiriSearchProvider({apiUrl:h.apiUrl,sessionToken:()=> 'fixture'}),read=createCentralReadOnlyDiagnostic({apiUrl:h.apiUrl,sessionToken:()=> 'fixture',mode:()=> 'formal',searchProvider:provider})
 for(const domain of ['model','search'] as const){
  const original=await read({action:'lookup',domain,requestId:'original-fixture-intent'})
  expect(original).toMatchObject({found:true,operationStatus:domain==='model'?'reconciliation_required':'searching',points:null,reservationCreated:false,diagnostic:{effect:'unknown',retryable:false,requestId:'original-fixture-intent'}})
  expect(JSON.stringify(original)).not.toContain('PRIVATE');expect('chargedPoints' in original).toBe(false);expect('estimatedPoints' in original).toBe(false)
  expect(await read({action:'lookup',domain,requestId:'missing'})).toMatchObject({found:false,status:404,publicCode:domain+'_request_not_found'})
 }
 expect(h.requests.every(row=>row.method==='GET')).toBe(true);expect(h.requests.filter(row=>row.path.endsWith('original-fixture-intent'))).toHaveLength(2)
})
