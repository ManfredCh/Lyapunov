import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {hasConfirmation,requestConfirmation,type ConfirmationRef} from './confirmation.ts'
import {PRIVATE_PREVIEW_PATH} from './preview-route.ts'
import {SessionId} from '@deepseek-ai/dsh-session'
import {flushLiveSessionLog,readSessionLogText,sessionLogExportDeps,streamSessionLogZip} from '@deepseek-ai/dsh-session-log-export'
import {boundedShareFetch,isShareFetchError,isTransientShareFailure,isTransientShareStatus,readBoundedText,ShareFetchError,SHARE_FETCH_STALL_MS,SHARE_FETCH_TIMEOUT_MS,type ShareFetchAttempt,type ShareFetchStep} from './fetch.ts'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {join,relative} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import {parseArchive,renderSnapshot,MAX_ARCHIVE_BYTES} from './snapshot.ts'
export interface ShareConfig {mode:'formal'|'developer';privateRoot:string;serviceUrl?:string;previewOrigin?:string;accountId?:string;accountApiUrl?:string;tokenEnv?:string}
export interface Preview {previewId:string;owner:string;digest:string;sessionId:string;title:string;createdAt:string;includeDescendants:boolean;confirmation?:ConfirmationRef}
/** 失败原因压成一行（换行/超长会毁掉"一条消息说清"的可读性）；请求头与正文从不进来。 */
const errorMessage=(error:unknown)=>String((error as Error)?.message??error).replace(/\s+/g,' ').trim().slice(0,240)||'未知错误'
/** 分享服务管理接口的步骤名：与 fetch 点一一对应，出现在错误与落盘诊断里（"走到哪一步"）。 */
const shareRequestStep=(init:RequestInit):ShareFetchStep=>init.method==='POST'?'发布分享':init.method==='DELETE'?'撤销分享':'列出分享'
/**
 * **调用方取消原样传播**（R-fix#7 修的行为回归）：取消是调用方的正常动作，**不是**取件故障 ——
 * 既不能被改写成 `SHARE_AUTH_REQUIRED`（那会让 `preview-route` 把"取消"回成 401「要重新登录」，
 * 而改前 404 是对的），也不能被改写成"应答读不完/解析不了"。取消时不写故障诊断（取消不是故障）。
 */
const throwIfCancelled=(signal:AbortSignal)=>{if(signal.aborted)throw signal.reason??new Error('SHARE_CANCELLED')}
/** 应答**处理**阶段（读正文 / 解析 JSON）的失败也进尝试轨迹：`attempts` 在每条失败路径上都有实质内容。 */
const responseStageAttempt=(input:{step:ShareFetchStep;url:string;index:number;ms:number;reason:string;retryable:boolean}):ShareFetchAttempt=>({at:new Date().toISOString(),step:input.step,url:input.url,attempt:input.index,ms:input.ms,reason:input.reason,retryable:input.retryable})
export class ShareOperations {
 private readonly pending=new Map<string,Promise<any>>()
 /**
  * 超时口径**只有单测会传**（把 30s×3 压到毫秒级来证明机制），生产调用点一律走 `fetch.ts` 的默认值：
  * 与 W16/W25 同一形状，不引入新的配置面（`ShareConfig` 一个字未加）。
  */
 constructor(readonly ctx:Context,readonly config:ShareConfig,private readonly options:{fetchTimeoutMs?:number;fetchAttempts?:number;bodyStallMs?:number}={}){if(!['formal','developer'].includes(config.mode)||!config.privateRoot)throw new Error('SHARE_PROFILE_CONFIG_REQUIRED')}
 /**
  * 账户身份：`/v1/me` 一次有界取件（30s × 3，保留调用方取消）。
  * 401/403 仍是既有的 `SHARE_AUTH_REQUIRED`（`preview-route.ts` 靠它判 401，语义不能挪）；
  * 5xx/429/408/425 在取件层重试到上界后抛五要素齐的 `ShareFetchError`（不再落进"非 2xx ⇒ 要重新登录"）；
  * 其余失败抛五要素齐的 `ShareFetchError`；**调用方取消一路原样传播**（不被改写成上面任何一种）。
  */
 async identity(signal:AbortSignal){
  const env=this.config.tokenEnv??(this.config.mode==='formal'?'LYAPUNOV_ACCOUNT_TOKEN':'LYAPUNOV_SHARE_LOCAL_TOKEN'),token=process.env[env]??''
  if(this.config.mode==='developer')return {owner:'developer:local',token}
  if(!this.config.accountApiUrl||!this.config.accountId||!token)throw new Error('SHARE_AUTH_REQUIRED')
  const base=new URL(this.config.accountApiUrl);if(base.protocol!=='https:'&&!['127.0.0.1','localhost','[::1]'].includes(base.hostname))throw new Error('SHARE_AUTH_API_HTTPS_REQUIRED')
  const url=base.href.replace(/\/$/,'')+'/v1/me'
  let response:Response,attempts:readonly ShareFetchAttempt[]
  try{({response,attempts}=await boundedShareFetch(url,{headers:{authorization:'Bearer '+token},redirect:'error',signal},'账户身份',{timeoutMs:this.options.fetchTimeoutMs,attempts:this.options.fetchAttempts}))}
  catch(error){
   throwIfCancelled(signal)
   if(isShareFetchError(error))throw error
   throw new Error('SHARE_AUTH_REQUIRED: 账户身份校验未完成（'+errorMessage(error)+'）\n  上游 URL：'+url+'\n  可否重试：'+(isTransientShareFailure(error)?'true（瞬时网络故障：重试同一条命令即可）':'false（不是瞬时故障：先修正账户 API 地址/登录状态再试）'))
  }
  if(!response.ok){
   // 取件层对 5xx/429/408/425 已经重试到上界并抛错；这里**再按状态判一次是防御** ——
   // 万一瞬时状态漏到这里，也不能报成"要重新登录"（`preview-route` 会据此回 401）。
   if(isTransientShareStatus(response.status))throw new ShareFetchError({url,step:'账户身份',attempts,retryable:true})
   throw new Error('SHARE_AUTH_REQUIRED')
  }
  let value:any
  try{value=JSON.parse(await readBoundedText(response,signal,this.options.bodyStallMs??SHARE_FETCH_STALL_MS))}
  catch(error){throwIfCancelled(signal);throw new Error('SHARE_ACCOUNT_INVALID_RESPONSE: 账户身份应答无法解析（'+errorMessage(error)+'）\n  上游 URL：'+url+'\n  走到哪一步：账户身份\n  可否重试：false（不是瞬时故障：先确认账户 API 地址指向的是账户服务）')}
  if(value.user?.id!==this.config.accountId)throw new Error('SHARE_ACCOUNT_CHANGED')
  return {owner:'formal:'+base.origin+':'+value.user.id,token}
 }
 private ownerDirectory(owner:string){return join(this.config.privateRoot,createHash('sha256').update(owner).digest('hex').slice(0,32))}
 private previewDirectory(owner:string,id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('SHARE_PREVIEW_ID_INVALID');return join(this.ownerDirectory(owner),'previews',id)}
 async preview(input:{sessionId:string;title?:string;includeDescendants?:boolean},signal:AbortSignal){
  const {owner}=await this.identity(signal),deps=sessionLogExportDeps(this.ctx)
  if(!deps.attachments||!deps.sessionPersistence||!deps.sessionQuery)throw new Error('SHARE_NATIVE_EXPORT_UNAVAILABLE')
  const sessionId=SessionId(input.sessionId)
  await flushLiveSessionLog(deps,sessionId,signal)
  const content=await readSessionLogText(deps.sessionPersistence,sessionId,signal)
  if(content===undefined)throw new Error('SHARE_SESSION_NOT_FOUND')
  const stream=streamSessionLogZip({...deps,attachments:deps.attachments,sessionPersistence:deps.sessionPersistence,sessionQuery:deps.sessionQuery},content,sessionId,input.includeDescendants===true,6,signal)
  const chunks:Uint8Array[]=[];let size=0;const reader=stream.getReader()
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>MAX_ARCHIVE_BYTES){await reader.cancel();throw new Error('SHARE_TOO_LARGE')}chunks.push(part.value)}}finally{reader.releaseLock()}
  const bytes=new Uint8Array(Buffer.concat(chunks)),{snapshot,entries}=parseArchive(bytes)
  const preview:Preview={previewId:randomUUID(),owner,digest:snapshot.digest,sessionId,title:input.title?.trim()||'会话分享',createdAt:new Date().toISOString(),includeDescendants:input.includeDescendants===true}
  if(preview.title.length>200)throw new Error('SHARE_TITLE_TOO_LONG')
  const directory=this.previewDirectory(owner,preview.previewId);await mkdir(directory,{recursive:true,mode:0o700})
  await writeFile(join(directory,'session.zip'),bytes,{mode:0o600,flag:'wx'})
  for(const asset of snapshot.assets){const destination=join(directory,'assets',asset.path);await mkdir(join(destination,'..'),{recursive:true,mode:0o700});await writeFile(destination,entries[asset.path]!,{mode:0o600,flag:'wx'})}
  const previewPath=join(directory,'preview.html')
  await writeFile(previewPath,renderSnapshot(snapshot,{title:preview.title,preview:true,assetUrl:path=>relative(directory,join(directory,'assets',path)),archiveUrl:relative(directory,join(directory,'session.zip'))}),{mode:0o600,flag:'wx'})
  await writeFile(join(directory,'preview.json'),JSON.stringify(preview,null,2),{mode:0o600,flag:'wx'})
  return {previewId:preview.previewId,digest:preview.digest,sessionId,...this.previewUrl(preview)?{previewUrl:this.previewUrl(preview)}:{},previewPath,archivePath:join(directory,'session.zip'),published:false,sessionCount:snapshot.logs.length,eventCount:snapshot.logs.reduce((n,l)=>n+l.events.length,0),attachments:snapshot.assets,notice:'这是完整DSH原生导出预览，包含原始事件、工具输入输出、元数据和附件。调用share_publish后会通过原生用户问题展示发布/取消确认；模型参数不能代替用户回答。后续消息不会自动同步。'}
 }
 private service(){
  if(!this.config.serviceUrl)throw new Error('SHARE_SERVICE_UNAVAILABLE')
  const url=new URL(this.config.serviceUrl),loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname)
  if(this.config.mode==='developer'&&!loopback)throw new Error('SHARE_DEVELOPER_LOOPBACK_REQUIRED')
  if(url.protocol!=='https:'&&!loopback)throw new Error('SHARE_SERVICE_HTTPS_REQUIRED')
  return url.href.replace(/\/$/,'')
 }
 private async request(path:string,init:RequestInit,token:string,signal:AbortSignal,previewId?:string){
  if(!token)throw new Error('SHARE_AUTH_REQUIRED')
  const url=this.service()+path,step=shareRequestStep(init),started=Date.now()
  // 换掉裸 fetch：每次尝试各自 30s 上限、瞬时故障（含 **5xx/429**）重试至 3 次、调用方取消原样传播、失败五要素齐。
  // 重试**不新增语义**：publish 的 POST 复用同一 `x-lyapunov-share-request-id`（该字段本来就是幂等键），
  // GET/DELETE 本身幂等。
  let response:Response,attempts:readonly ShareFetchAttempt[]
  try{({response,attempts}=await boundedShareFetch(url,{...init,headers:{authorization:'Bearer '+token,...init.headers},redirect:'error',signal},step,{timeoutMs:this.options.fetchTimeoutMs,attempts:this.options.fetchAttempts}))}
  catch(error){throwIfCancelled(signal);await this.recordFetchDiagnostic({step,error,previewId});throw error}
  // 应答体读取按**调用方取消 + 无数据到达上限**，不套建连的那 30s：建连一旦返回应答头，
  // 那个上限就已完成使命（正文可能读很久，但每 30s 至少要到达一次数据）。
  let text:string
  try{text=await readBoundedText(response,signal,this.options.bodyStallMs??SHARE_FETCH_STALL_MS)}
  catch(error){
   throwIfCancelled(signal)
   const trail=[...attempts,responseStageAttempt({step,url,index:attempts.length+1,ms:Date.now()-started,reason:errorMessage(error),retryable:true})]
   const failure=new Error('SHARE_SERVICE_INVALID_RESPONSE: 分享服务应答未能读完（'+errorMessage(error)+'）\n  上游 URL：'+url+'\n  走到哪一步：'+step+'\n  可否重试：true（瞬时网络故障：重试同一条命令即可）')
   await this.recordFetchDiagnostic({step,error:failure,previewId,url,attempts:trail,retryable:true});throw failure
  }
  // 该服务对管理接口的应答**恒为 JSON**（含错误）：读不成 JSON 就照实报，不把解析异常冒充成服务错误。
  let result:any
  try{result=JSON.parse(text)}
  catch{
   const trail=[...attempts,responseStageAttempt({step,url,index:attempts.length+1,ms:Date.now()-started,reason:'应答不是 JSON（上游 HTTP '+response.status+'）',retryable:false})]
   const failure=new Error('SHARE_SERVICE_INVALID_RESPONSE: 分享服务应答不是 JSON（上游 HTTP '+response.status+'）\n  上游 URL：'+url+'\n  走到哪一步：'+step+'\n  可否重试：false（不是瞬时故障：先确认服务地址指向的是分享服务）')
   await this.recordFetchDiagnostic({step,error:failure,previewId,url,attempts:trail,retryable:false});throw failure
  }
  if(!response.ok){
   // 到这里的状态只剩**非瞬时**的（5xx/429/408/425 已在取件层重试到上界并抛 ShareFetchError）；但「可否重试」
   // 仍然**按状态算**、不写死 false —— 与取件层用的是同一个判定（`isTransientShareStatus`）。
   const retryable=isTransientShareStatus(response.status)
   const failure=new Error(String(result?.error??'SHARE_SERVICE_ERROR')+'（上游 HTTP '+response.status+'）\n  上游 URL：'+url+'\n  走到哪一步：'+step+'\n  可否重试：'+(retryable?'true（瞬时网络故障：重试同一条命令即可）':'false（不是瞬时故障：先修正账户/服务地址/入参再试）'))
   await this.recordFetchDiagnostic({step,error:failure,previewId,url,attempts,retryable});throw failure
  }
  return result
 }
 /**
  * 取件诊断落盘（`<私有根>/share-fetch-diag.jsonl`）：与 W25 把失败尝试落进 `manifest.transfers` 同一目的
  * —— 会话结束后"为什么没发出去"还查得到（预览 ID + 步骤 + 上游 URL + 每次尝试 + 能否重试），
  * 而工具/命令那边只留一行消息。只记去掉了查询串的上游 URL 与上游**已有的** error 码，
  * 不含 Authorization、不含响应正文。**写不进去不掩盖原故障**（追加写失败就只留错误消息）。
  *
  * `url/attempts/retryable` 由**知道它们的调用点**显式传入（取件层的 `ShareFetchError` 自带这三个字段）：
  * 非瞬时路径（4xx、应答读不完/不是 JSON）的落盘诊断因此同样五要素齐，不再是 `url:""` + `attempts:[]`。
  */
 private async recordFetchDiagnostic(input:{step:ShareFetchStep;error:unknown;previewId?:string;url?:string;attempts?:readonly ShareFetchAttempt[];retryable?:boolean}){
  const error=input.error
  const entry:Record<string,unknown>={at:new Date().toISOString(),step:input.step,url:isShareFetchError(error)?error.url:(input.url??''),error:errorMessage(error),retryable:isShareFetchError(error)?error.retryable:(input.retryable??isTransientShareFailure(error)),attempts:isShareFetchError(error)?[...error.attempts]:[...(input.attempts??[])]}
  if(input.previewId)entry.previewId=input.previewId
  try{await mkdir(this.config.privateRoot,{recursive:true,mode:0o700});await writeFile(join(this.config.privateRoot,'share-fetch-diag.jsonl'),JSON.stringify(entry)+'\n',{mode:0o600,flag:'a'})}catch{}
 }
 previewUrl(preview:Preview){
  if(!this.ctx.get('connection'))return undefined
  const server=this.ctx.get('webServer'),origin=this.config.previewOrigin??(server?`http://127.0.0.1:${server.port}`:undefined)
  if(!origin)return undefined
  const base=new URL(origin);if(!['http:','https:'].includes(base.protocol)||base.username||base.password)throw new Error('SHARE_PREVIEW_ORIGIN_INVALID')
  return base.origin+PRIVATE_PREVIEW_PATH+'?'+new URLSearchParams({previewId:preview.previewId,digest:preview.digest})
 }
 async readPrivatePreview(previewId:string,signal:AbortSignal){
  // 身份校验的取件失败由**调用方**留诊断：publish 链在 `publishOnce` 里按 previewId 落盘；
  // 只读的 `/share-preview` 路由与 share_list/share_revoke 没有预览目录归属，只保留错误消息（见回执"未覆盖"）。
  const {owner,token}=await this.identity(signal),directory=this.previewDirectory(owner,previewId)
  let preview:Preview,bytes:Buffer
  try{preview=JSON.parse(await readFile(join(directory,'preview.json'),'utf8'));bytes=await readFile(join(directory,'session.zip'))}catch{throw new Error('SHARE_PREVIEW_NOT_FOUND')}
  if(preview.owner!==owner||preview.previewId!==previewId)throw new Error('SHARE_PREVIEW_NOT_FOUND')
  const {snapshot,entries}=parseArchive(bytes)
  if(snapshot.digest!==preview.digest)throw new Error('SHARE_PREVIEW_CHANGED')
  return {owner,token,directory,preview,bytes,snapshot,entries}
 }
 async publish(input:{previewId:string;confirmed?:boolean},signal:AbortSignal,agent?:Agent):Promise<any>{
  // confirmed兼容旧调用但始终忽略；只能消费原生问题回答生成的授权grant。
  const key=input.previewId
  const running=this.pending.get(key)
  if(running){const value=await running;signal.throwIfAborted();return value}
  const pending=this.publishOnce(input.previewId,signal,agent)
  this.pending.set(key,pending)
  try{return await pending}finally{this.pending.delete(key)}
 }
 private async publishOnce(previewId:string,signal:AbortSignal,agent?:Agent){
  // 发布链上的取件失败带 previewId 落盘（`<私有根>/share-fetch-diag.jsonl`）；取件层已记过的（`ShareFetchError`
  // 与非 JSON/非 2xx 应答）不在这里重复记，这里只补"取件成功但发布没走完"的其余失败。
  try{
   const state=await this.readPrivatePreview(previewId,signal),{owner,directory,preview,snapshot}=state
   const destination=this.service(),subject={previewId,digest:preview.digest,owner,serviceUrl:destination,title:preview.title}
   if(!state.token)throw new Error('SHARE_AUTH_REQUIRED')
   if(!await hasConfirmation(this.ctx,subject,preview.confirmation,signal)){
    const link=this.previewUrl(preview)??pathToFileURL(join(directory,'preview.html')).href
    const confirmation=await requestConfirmation(this.ctx,agent,subject,link,{sessions:snapshot.logs.length,events:snapshot.logs.reduce((n,l)=>n+l.events.length,0),attachments:snapshot.assets.length},signal)
    if(!confirmation)return {published:false,cancelled:true,previewId}
    preview.confirmation=confirmation
    await writeFile(join(directory,'preview.json'),JSON.stringify(preview,null,2),{mode:0o600})
   }
   // 回答可能经历账户切换或文件变化；再次验证实际身份与同一份预览。
   const current=await this.readPrivatePreview(previewId,signal)
   if(current.owner!==owner||current.preview.digest!==preview.digest||current.preview.title!==preview.title)throw new Error('SHARE_PREVIEW_CHANGED')
   if(!await hasConfirmation(this.ctx,subject,current.preview.confirmation,signal))throw new Error('SHARE_CONFIRMATION_MISSING')
   const receipt=await this.request('/v1/shares',{method:'POST',headers:{'content-type':'application/zip','x-lyapunov-share-request-id':previewId,'x-lyapunov-share-title':encodeURIComponent(preview.title)},body:current.bytes},current.token,signal,previewId)
   await writeFile(join(directory,'receipt.json'),JSON.stringify(receipt,null,2),{mode:0o600})
   return receipt
  }catch(error){
   // 走到这一步之前用户已经为这份快照授权过：发布没走完要把"卡在哪一步"留在盘上，不能只在会话里闪一行。
   // 取件类失败已在取件层按同一 previewId 记过，跳过以免同一次失败落两条。写不进去也不掩盖原故障。
   // 取件层已按同一 previewId 记过**发布分享**（`request` 的 catch）；身份那一步没记，这里补上。
   // 取消不在此列：取消是调用方的正常动作，原样传播、不落故障诊断。
   throwIfCancelled(signal)
   if(!(isShareFetchError(error)&&error.step==='发布分享'))await this.recordFetchDiagnostic({step:isShareFetchError(error)?error.step:'发布分享',error,previewId})
   throw error
  }
 }
 async list(signal:AbortSignal){const {token}=await this.identity(signal);return this.request('/v1/shares',{method:'GET'},token,signal)}
 async revoke(shareId:string,signal:AbortSignal){if(!/^[a-f0-9-]{36}$/.test(shareId))throw new Error('SHARE_ID_INVALID');const {token}=await this.identity(signal);return this.request('/v1/shares/'+shareId,{method:'DELETE'},token,signal)}
}
