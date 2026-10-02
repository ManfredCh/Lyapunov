import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { credentialKey, credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { scopeOf, scopeChainOf } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { McpOAuthBridgeRequest, OAuthClientProvider, OAuthClientMetadata, OAuthClientInformationMixed, OAuthTokens, OAuthDiscoveryState } from '@deepseek-ai/dsh-mcp-client'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'

interface StoredAuth {
  serverUrl: string
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  expiresAt?: number
  discovery?: OAuthDiscoveryState
}
interface PendingAuth { state: string; verifier?: string; url?: string; expiresAt: number }

/** 每个真实 MCP owner 仅提供 SDK 所需凭据；Client、transport、重连和工具仍归原生 DSH。 */
class McpOAuthAdapter implements OAuthClientProvider {
  pending?: PendingAuth
  lastError?: string
  private loggedOut=false
  private authEpoch=0
  readonly key
  readonly binding: McpOAuthBridgeRequest
  private credentials: CredentialProvider
  readonly redirectUrl: string
  private states: Map<string, McpOAuthAdapter>
  constructor(binding: McpOAuthBridgeRequest, credentials: CredentialProvider, redirectUrl: string, identity: string, states: Map<string, McpOAuthAdapter>) {
    this.binding=binding;this.credentials=credentials;this.redirectUrl=redirectUrl;this.states=states
    const id=createHash('sha256').update(JSON.stringify([identity,binding.serverName,binding.serverUrl,binding.config.clientId??''])).digest('hex')
    this.key=credentialKey('lyapunov-mcp-extras','oauth-'+id)
  }
  get clientMetadata(): OAuthClientMetadata {
    return {redirect_uris:[this.redirectUrl],client_name:'Lyapunov',grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:this.binding.config.clientSecretEnv?'client_secret_post':'none',...(this.binding.config.scope?{scope:this.binding.config.scope}:{})}
  }
  private async read(): Promise<StoredAuth> {
    const record=await this.credentials.readRecord(this.key)
    const payload=record?.kind==='grant'?record.payload as StoredAuth:undefined
    return payload?.serverUrl===this.binding.serverUrl?payload:{serverUrl:this.binding.serverUrl}
  }
  private async update(change:(value:StoredAuth)=>StoredAuth): Promise<void> {
    const epoch=this.authEpoch
    await this.credentials.modifyRecord(this.key,async record=>{if(epoch!==this.authEpoch)throw new Error('MCP_OAUTH_AUTHORIZATION_REPLACED');return {kind:'grant',payload:JSON.parse(JSON.stringify(change(record?.kind==='grant'&&(record.payload as StoredAuth)?.serverUrl===this.binding.serverUrl?record.payload as StoredAuth:{serverUrl:this.binding.serverUrl})))}})
  }
  forTransport():OAuthClientProvider {
    const epoch=this.authEpoch,owner=this
    return new Proxy(this,{get(target,key){const value=Reflect.get(target,key,target);return typeof value==='function'?((...args:unknown[])=>{if(epoch!==owner.authEpoch)throw new Error('MCP_OAUTH_AUTHORIZATION_REPLACED');return Reflect.apply(value,target,args)}):value}})
  }
  async clientInformation(): Promise<OAuthClientInformationMixed|undefined> {
    const config=this.binding.config
    if(config.clientId){
      const secret=config.clientSecretEnv?(await this.credentials.resolve(credentialRef(config.clientSecretEnv)))?.value:undefined
      if(config.clientSecretEnv&&!secret)throw new Error('MCP_OAUTH_CLIENT_SECRET_UNAVAILABLE: '+config.clientSecretEnv)
      return {client_id:config.clientId,...(secret?{client_secret:secret}:{})}
    }
    const client=(await this.read()).client
    if(client?.client_secret_expires_at&&client.client_secret_expires_at<Date.now()/1000)return undefined
    return client
  }
  async saveClientInformation(client:OAuthClientInformationMixed){await this.update(value=>({...value,client}))}
  async tokens():Promise<OAuthTokens|undefined>{const record=await this.read();return record.tokens?{...record.tokens,...(record.expiresAt!==undefined?{expires_in:Math.max(0,Math.floor((record.expiresAt-Date.now())/1000))}:{})}:undefined}
  async saveTokens(tokens:OAuthTokens){
    await this.update(value=>{if(this.loggedOut)throw new Error('MCP_OAUTH_LOGGED_OUT');return {...value,tokens:{...tokens,...(!tokens.refresh_token&&value.tokens?.refresh_token?{refresh_token:value.tokens.refresh_token}:{})},...(tokens.expires_in!==undefined?{expiresAt:Date.now()+tokens.expires_in*1000}:{expiresAt:undefined})}})
    this.clearPending();this.lastError=undefined
  }
  async discoveryState(){return (await this.read()).discovery}
  async saveDiscoveryState(discovery:OAuthDiscoveryState){await this.update(value=>({...value,discovery}))}
  state():string {
    this.clearPending()
    const state=randomBytes(32).toString('base64url')
    this.pending={state,expiresAt:Date.now()+10*60*1000};this.states.set(state,this)
    return state
  }
  saveCodeVerifier(verifier:string){if(!this.pending)this.state();this.pending!.verifier=verifier}
  codeVerifier():string{if(!this.pending?.verifier||this.pending.expiresAt<Date.now())throw new Error('MCP_OAUTH_VERIFIER_EXPIRED');return this.pending.verifier}
  redirectToAuthorization(url:URL){if(!this.pending)throw new Error('MCP_OAUTH_STATE_REQUIRED');this.pending.url=url.href}
  clearPending(){if(this.pending)this.states.delete(this.pending.state);this.pending=undefined}
  async invalidateCredentials(part:'all'|'client'|'tokens'|'verifier'|'discovery'){
    if(part==='all'){await this.credentials.deleteRecord(this.key);this.clearPending();return}
    if(part==='verifier'){this.clearPending();return}
    await this.update(value=>{const next={...value};if(part==='tokens'){delete next.tokens;delete next.expiresAt}else if(part==='client')delete next.client;else delete next.discovery;return next})
  }
  async status(){
    if(this.pending&&this.pending.expiresAt<Date.now())this.clearPending()
    const stored=await this.read()
    return {serverName:this.binding.serverName,serverUrl:this.binding.serverUrl,authenticated:Boolean(stored.tokens),...(stored.expiresAt!==undefined?{expiresAt:stored.expiresAt}:{}),...(this.pending?.url?{authorizationUrl:this.pending.url,redirectUri:this.redirectUrl}:{}),...(this.lastError?{error:this.lastError}:{})}
  }
  async login(refresh=false){
    this.loggedOut=false
    if(!refresh&&this.pending?.url&&this.pending.expiresAt>Date.now())return this.status()
    if(refresh&&!(await this.read()).tokens?.refresh_token)throw new Error('MCP_OAUTH_REFRESH_TOKEN_UNAVAILABLE')
    const epoch=this.authEpoch,result=await this.binding.authorize(this.forTransport())
    if(epoch!==this.authEpoch)throw new Error('MCP_OAUTH_AUTHORIZATION_REPLACED')
    if(result==='AUTHORIZED')await this.binding.control('reconnect')
    return this.status()
  }
  async complete(code:string,state:string){
    if(!this.pending||this.pending.state!==state||this.pending.expiresAt<Date.now())throw new Error('MCP_OAUTH_STATE_INVALID')
    // 从索引先移除，一次性回调不能并发兑换同一授权码；PKCE保留到SDK交换结束。
    this.states.delete(state)
    const epoch=this.authEpoch,pending=this.pending
    try{
      const result=await this.binding.authorize(this.forTransport(),code)
      if(epoch!==this.authEpoch)throw new Error('MCP_OAUTH_AUTHORIZATION_REPLACED')
      if(result!=='AUTHORIZED')throw new Error('MCP_OAUTH_EXCHANGE_INCOMPLETE')
      await this.binding.control('reconnect')
    }catch(error){if(epoch===this.authEpoch)this.lastError='授权未完成，请重新登录';throw error}
    finally{if(this.pending===pending)this.clearPending()}
  }
  async logout(){this.authEpoch++;this.loggedOut=true;this.clearPending();await this.binding.control('pause');await this.invalidateCredentials('all');return {serverName:this.binding.serverName,authenticated:false,disconnected:true}}
}

/** 原生凭据记录按根Profile、稳定Agent/预设scope或不持久匿名scope隔离。 */
function scopeIdentity(scope:object|undefined,anonymous:WeakMap<object,string>):string {
  if(!scope)return 'root'
  const value=scope as {id?:string;session?:{id?:string};agentPreset?:string}
  if(value.id&&value.session?.id===value.id)return 'session:'+value.id
  if(typeof value.agentPreset==='string')return 'preset:'+value.agentPreset
  let id=anonymous.get(scope);if(!id){id=randomUUID();anonymous.set(scope,id)}return 'scope:'+id
}

export function applyOAuth(ctx:Context):void {
  const bindings=new Map<object|undefined,Map<string,McpOAuthAdapter>>(),states=new Map<string,McpOAuthAdapter>(),anonymous=new WeakMap<object,string>()
  const servers=new Map<string,Promise<{server:Server;redirectUri:string}>>()
  const callbackServer=(configured?:string)=>{
    const wanted=new URL(configured??'http://127.0.0.1:0/mcp/oauth/callback')
    if(wanted.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(wanted.hostname)||wanted.username||wanted.password||wanted.search||wanted.hash)throw new Error('MCP_OAUTH_LOOPBACK_REDIRECT_REQUIRED')
    const key=wanted.href
    let current=servers.get(key)
    if(!current){
      current=new Promise((resolve,reject)=>{
        const server=createServer((request,response)=>{
          void(async()=>{
            const url=new URL(request.url??'/',wanted)
            response.setHeader('content-type','text/html; charset=utf-8');response.setHeader('cache-control','no-store')
            if(request.method!=='GET'||url.pathname!==wanted.pathname){response.writeHead(404);response.end('未找到授权回调');return}
            const state=url.searchParams.get('state'),adapter=state?states.get(state):undefined
            if(!adapter){response.writeHead(400);response.end('授权请求已过期或不匹配，请返回应用重新登录。');return}
            if(url.searchParams.has('error')){adapter.clearPending();adapter.lastError='用户取消或服务器拒绝授权';response.writeHead(400);response.end('授权已取消，可以返回应用。');return}
            const code=url.searchParams.get('code');if(!code){response.writeHead(400);response.end('缺少授权码');return}
            await adapter.complete(code,state!)
            response.end('授权已完成，MCP 已连接。可以关闭此页并返回 Lyapunov。')
          })().catch(()=>{response.writeHead(400);response.end('授权未完成，请返回应用重新登录。')})
        })
        server.once('error',reject)
        server.listen(Number(wanted.port||80),wanted.hostname==='[::1]'?'::1':wanted.hostname,()=>{
          const address=server.address();if(!address||typeof address==='string'){reject(new Error('MCP_OAUTH_CALLBACK_LISTEN_FAILED'));return}
          wanted.port=String(address.port);resolve({server,redirectUri:wanted.href})
        })
      })
      servers.set(key,current)
    }
    return current
  }
  ctx.on('mcp/oauth-provider',async(binding,next)=>{
    const credentials=binding.owner.get('credentials');if(!credentials)throw new Error('MCP_OAUTH_CREDENTIAL_STORE_UNAVAILABLE')
    const scope=scopeOf(binding.owner),callback=await callbackServer(binding.config.redirectUri)
    const adapter=new McpOAuthAdapter(binding,credentials,callback.redirectUri,scopeIdentity(scope,anonymous),states)
    let entries=bindings.get(scope);if(!entries){entries=new Map();bindings.set(scope,entries)}
    entries.set(binding.serverName,adapter)
    binding.owner.effect(()=>()=>{adapter.clearPending();if(entries!.get(binding.serverName)===adapter)entries!.delete(binding.serverName)},'lyapunov MCP OAuth adapter')
    return adapter
  })
  ctx.effect(()=>async()=>{for(const value of bindings.values())for(const adapter of value.values())adapter.clearPending();await Promise.all([...servers.values()].map(async pending=>{const {server}=await pending;server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()))}))},'lyapunov MCP OAuth callbacks')
  const resolveAdapter=(target:Context,serverName:string)=>{
    for(const scope of [...scopeChainOf(scopeOf(target)),undefined]){const adapter=bindings.get(scope)?.get(serverName);if(adapter)return adapter}
    throw new Error('MCP_OAUTH_SERVER_UNAVAILABLE: '+serverName)
  }
  for(const [name,description,method] of [
    ['mcp_login','Get a browser authorization link for an MCP server configured for OAuth. After the user authorizes, restore the same native connection.','login'],
    ['mcp_auth_status','Read MCP authorization state in the current scope without returning tokens or client secrets.','status'],
    ['mcp_refresh_auth','Refresh current authorization through the native MCP SDK and restore the same connection.','refresh'],
    ['mcp_logout','Clear local OAuth authorization for this scope\'s server and disconnect its MCP connection.','logout'],
  ] as const){
    const run=async(input:any,signal:AbortSignal,agent?:Agent)=>{signal.throwIfAborted();if(typeof input?.serverName!=='string'||!input.serverName.trim())throw new Error('MCP_SERVER_NAME_REQUIRED');const adapter=resolveAdapter(agent?.ctx??ctx,input.serverName);return method==='status'?adapter.status():method==='logout'?adapter.logout():adapter.login(method==='refresh')}
    ctx.tools.register(defineTool({name,description,parameters:{input:{type:'json',required:true,description:'{serverName: name of an MCP server configured in the current scope}'}},output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)+((value as any).authorizationUrl?'\n\n[打开浏览器授权页面](<'+(value as any).authorizationUrl+'>)':'')}]},execute:(args,exec)=>run(args.input,exec.signal,exec.agent)}))
    ctx.commands.register({name,description,input:{hint:'{"serverName":"server-name"}'},async handler(invocation){try{return {kind:'success',text:JSON.stringify(await run(JSON.parse(invocation.rawInput||'{}'),invocation.signal,invocation.agent))}}catch(error){return {kind:'error',text:error instanceof Error?error.message:String(error)}}}})
  }
}
