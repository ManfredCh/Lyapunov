import { randomUUID } from 'node:crypto'
import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult } from '@deepseek-ai/dsh-web'
import {searchReadinessFromMe,centralDiagnostic,SEARCH_READINESS_REASONS,type SearchReadiness,type SearchReadinessReason,type CentralDiagnostic} from './service-contract.ts'

export type SearchFetch = (input: string | URL, init?: RequestInit) => Promise<Response>
export interface SearchAvailability {readiness:SearchReadiness|null;status:number|null;publicCode:string;reason:SearchReadinessReason|'capability_unknown'|'authentication_required'|'transport'|null}
export interface CentralSearchReceipt {intentKey:string;diagnostic:CentralDiagnostic}
/** 中央公开失败身份；reason为白名单JSON，可由原生工具错误metadata保存。 */
export class CentralSearchError extends WebError {
 readonly reason:string
 constructor(message:string,code:string,readonly diagnostic:CentralDiagnostic|undefined,readonly intentKey:string){super(message,code);this.reason=JSON.stringify({diagnostic:diagnostic??null,intentKey})}
}
export class PeiriSearchProvider implements WebSearchProvider {
  readonly id = 'peiri'
  private readonly apiUrl: string
  private availability:SearchAvailability={readiness:null,status:null,publicCode:'CENTRAL_SEARCH_CAPABILITY_UNKNOWN',reason:'capability_unknown'}
  private checkedToken:string|undefined
  private readonly intents=new WeakMap<WebSearchRequest,string>()
  constructor(private readonly options: { apiUrl: string; sessionToken(): string | undefined; fetcher?: SearchFetch; intentKey?:(request:WebSearchRequest)=>string|undefined; initialMe?:unknown;onFailure?:(record:{code:string;intentKey:string;diagnostic:CentralDiagnostic|undefined})=>void;onReceipt?:(record:CentralSearchReceipt)=>void }) {
    const base = new URL(options.apiUrl)
    if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) || base.username || base.password || base.search || base.hash)
      throw new Error('INVALID_ACCOUNT_API_URL')
    this.apiUrl = options.apiUrl.replace(/\/$/, '')
    if(options.initialMe){this.availability={readiness:searchReadinessFromMe(options.initialMe)??null,status:200,publicCode:'CENTRAL_SEARCH_CAPABILITY_UNKNOWN',reason:'capability_unknown'};this.checkedToken=options.sessionToken()}
  }
  /** 原生available是同步本地检查；没有已认证v1事实就返回false，绝不发网络。 */
  available(){return Boolean(this.options.sessionToken()&&this.checkedToken===this.options.sessionToken()&&this.availability.readiness?.ready)}
  /** @returns 当前已确认的非秘密就绪事实，不读环境或触发请求。 */
  cachedReadiness():SearchAvailability{if(!this.options.sessionToken()||this.checkedToken!==this.options.sessionToken())return {readiness:null,status:null,publicCode:this.options.sessionToken()?'CENTRAL_SEARCH_CAPABILITY_UNKNOWN':'CENTRAL_SEARCH_AUTH_REQUIRED',reason:this.options.sessionToken()?'capability_unknown':'authentication_required'};return this.available()?{...this.availability,publicCode:'CENTRAL_SEARCH_READY',reason:null}:{...this.availability}}
  /** 显式只读/me；配置ready与供应商/计量实测分开。 */
  async refreshReadiness(signal?:AbortSignal):Promise<SearchAvailability>{
    signal?.throwIfAborted()
    const token=this.options.sessionToken()
    if(!token){this.checkedToken=undefined;return this.availability={readiness:null,status:null,publicCode:'CENTRAL_SEARCH_AUTH_REQUIRED',reason:'authentication_required'}}
    let response:Response
    try{response=await(this.options.fetcher??fetch)(this.apiUrl+'/v1/me',{method:'GET',redirect:'error',signal,headers:{authorization:`Bearer ${token}`}})}
    catch{if(signal?.aborted)throw new WebError('搜索状态读取已取消。','WEB_ABORTED');this.checkedToken=token;return this.availability={readiness:null,status:null,publicCode:'CENTRAL_SEARCH_TRANSPORT',reason:'transport'}}
    if(this.options.sessionToken()!==token)return this.availability={readiness:null,status:null,publicCode:'CENTRAL_SEARCH_AUTH_REQUIRED',reason:'authentication_required'}
    this.checkedToken=token
    let value:unknown
    try{value=await response.json()}catch(error){if(signal?.aborted)throw new WebError('搜索状态读取已取消。','WEB_ABORTED');if(!(error instanceof SyntaxError))return this.availability={readiness:null,status:response.status,publicCode:'CENTRAL_SEARCH_TRANSPORT',reason:'transport'}}
    const readiness=response.ok?searchReadinessFromMe(value):undefined
    return this.availability={readiness:readiness??null,status:response.status,publicCode:response.status===401?'CENTRAL_SEARCH_AUTH_REQUIRED':readiness?.ready?'CENTRAL_SEARCH_READY':readiness?'CENTRAL_SEARCH_UNAVAILABLE':'CENTRAL_SEARCH_CAPABILITY_UNKNOWN',reason:response.status===401?'authentication_required':readiness?.reason??(readiness?.ready?null:'capability_unknown')}
  }
  private intent(request:WebSearchRequest):string{
    const existing=this.intents.get(request);if(existing)return existing
    const key=this.options.intentKey?.(request)??'search-'+randomUUID();this.intents.set(request,key);return key
  }
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    try{return await this.searchOnce(request,signal)}catch(error){
      if(error instanceof CentralSearchError){try{this.options.onFailure?.({code:error.code,intentKey:error.intentKey,diagnostic:error.diagnostic})}catch{/* 观察失败不能改变原搜索/取消结果。 */}}
      throw error
    }
  }
  private async searchOnce(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    signal?.throwIfAborted()
    const token = this.options.sessionToken()
    if (!token) throw new WebError('Peiri 网页搜索需要当前正式账号会话，请在应用中重新连接账户。', 'CENTRAL_SEARCH_AUTH_REQUIRED')
    if (typeof request.query !== 'string' || !request.query.trim() || request.query.length > 4096 ||
        (request.maxResults !== undefined && (!Number.isSafeInteger(request.maxResults) || request.maxResults < 1 || request.maxResults > 30)))
      throw new WebError('搜索参数无效，未发送请求。', 'WEB_INVALID_QUERY')
    if(!this.available()){
      const availability=await this.refreshReadiness(signal)
      if(!availability.readiness?.ready||!this.available())throw new CentralSearchError(`Peiri 搜索配置尚未确认可用（${availability.reason??'capability_unknown'}${availability.status?`；HTTP ${availability.status}`:''}）；停止本次尝试，先查询中央服务状态，不要循环换词。`,availability.publicCode,undefined,this.intent(request))
    }
    const intentKey=this.intent(request)
    let response: Response
    try {
      response = await (this.options.fetcher ?? fetch)(this.apiUrl + '/v1/web/search', {
        method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': intentKey },
        body: JSON.stringify({ query: request.query, ...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }) }),
      })
    } catch {
      if (signal?.aborted) throw new WebError('网页搜索已取消。', 'WEB_ABORTED')
      throw new CentralSearchError('Peiri 搜索传输失败，结果与费用状态尚未确认；保留本次请求身份，不要循环重发同一查询。', 'CENTRAL_SEARCH_TRANSPORT',undefined,intentKey)
    }
    let value: WebSearchResult | undefined
    try {
      const text=await response.text(),declared=response.headers.get('content-length')
      if(declared!==null&&/^\d+$/.test(declared)&&Buffer.byteLength(text)!==Number(declared))
        throw new CentralSearchError('Peiri 搜索响应字节未完整到达；保留本次请求身份，不重新查询。','CENTRAL_SEARCH_TRANSPORT',undefined,intentKey)
      value=JSON.parse(text) as WebSearchResult
    }
    catch (error) {
      if (signal?.aborted) throw new WebError('网页搜索已取消。', 'WEB_ABORTED')
      if(error instanceof CentralSearchError)throw error
      // 不完整连接与完整但非法 JSON 属于不同事实；不要把真实断流吞成结构错误。
      if (!(error instanceof SyntaxError)) throw new CentralSearchError('Peiri 搜索响应读取中断，结果与费用状态尚未确认；不要循环重发同一查询。', 'CENTRAL_SEARCH_TRANSPORT',undefined,intentKey)
    }
    if (!response.ok) {
      const reason = value && typeof value === 'object' && !Array.isArray(value) ? (value as unknown as { error?: unknown }).error : undefined
      const diagnostic=centralDiagnostic(value)
      const failure=(message:string,code:string)=>new CentralSearchError(message,code,diagnostic,intentKey)
      if (['central_search_reservation_unknown', 'central_search_reconciliation_required', 'central_search_pending', 'central_search_configuration_changed','central_search_usage_unknown'].includes(String(reason)))
        throw failure('Peiri 搜索请求或账务结果尚未确认；保留原请求等待对账，不要循环重新查询。', 'CENTRAL_SEARCH_RECONCILIATION_REQUIRED')
      if (reason === 'central_search_identity_conflict') throw failure('Peiri 搜索请求身份或参数已变化，不能复用该请求。', 'CENTRAL_SEARCH_CONFLICT')
      if (reason === 'central_search_transport_error') throw failure('Peiri 搜索上游连接失败，本次没有完整搜索结果；保留失败原因，不要循环重发同一查询。', 'CENTRAL_SEARCH_TRANSPORT')
      if (reason === 'central_search_invalid_response') throw failure('Peiri 搜索没有完整原生结果，不能当作已搜索。', 'CENTRAL_SEARCH_INVALID_RESPONSE')
      if (reason === 'central_search_upstream_rejected' || response.status === 400) throw failure('Peiri 搜索参数被拒绝，不要重复相同查询。', 'CENTRAL_SEARCH_INVALID_QUERY')
      if(response.status===503&&value&&typeof value==='object'&&SEARCH_READINESS_REASONS.includes((value as unknown as {reason:SearchReadinessReason}).reason))this.availability={readiness:null,status:503,publicCode:'CENTRAL_SEARCH_UNAVAILABLE',reason:(value as unknown as {reason:SearchReadinessReason}).reason}
      const code = response.status === 401 ? 'CENTRAL_SEARCH_AUTH_REQUIRED' : response.status === 499 ? 'WEB_ABORTED' : response.status === 504 ? 'CENTRAL_SEARCH_TIMEOUT' : 'CENTRAL_SEARCH_UNAVAILABLE'
      throw failure(`Peiri 搜索未完成（HTTP ${response.status}）；中央入口、供应商或报价配置需由服务端处理，不需要客户端供应商密钥。`, code)
    }
    if (!value || !Array.isArray(value.sources) || typeof value.truncated !== 'boolean' ||
        (value.content !== undefined && typeof value.content !== 'string') ||
        value.sources.some(source => !source || typeof source.url !== 'string' || !publicSourceUrl(source.url) ||
          (source.title !== undefined && typeof source.title !== 'string') || (source.snippet !== undefined && typeof source.snippet !== 'string') ||
          (source.publishedAt !== undefined && typeof source.publishedAt !== 'string')))
      throw new WebError('Peiri 搜索响应不是结构化来源结果，不能当作已搜索。', 'CENTRAL_SEARCH_INVALID_RESPONSE')
    const meta=(value as WebSearchResult&{lyapunov?:unknown}).lyapunov
    if(meta!==undefined){
      const row=meta!==null&&typeof meta==='object'&&!Array.isArray(meta)?meta as Record<string,unknown>:{},charge=row.charge!==null&&typeof row.charge==='object'&&!Array.isArray(row.charge)?row.charge as Record<string,unknown>:{}
      const requestId=typeof row.requestId==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(row.requestId)&&!/^sk-/i.test(row.requestId)?row.requestId:null
      const integer=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0
      if(!requestId||row.protocol!=='openai-responses-web-search-v1'||!integer(row.reservedPoints)||!integer(charge.chargedPoints)||Number(charge.chargedPoints)>Number(row.reservedPoints)||typeof charge.priceVersion!=='string'||!/^[A-Za-z0-9._:-]{1,160}$/.test(charge.priceVersion)||typeof charge.providerTariffVerified!=='boolean')
        throw new CentralSearchError('Peiri 搜索完成回执不完整，结果与费用状态待核；保留原请求身份，不重新查询。','CENTRAL_SEARCH_RECONCILIATION_REQUIRED',{version:1,domain:'search',code:'central_search_receipt_invalid',stage:'result_decode',fieldPath:'lyapunov',retryable:false,effect:'unknown',requestId},intentKey)
      try{this.options.onReceipt?.({intentKey,diagnostic:{version:1,domain:'search',code:'central_search_completed',stage:'complete',fieldPath:null,retryable:false,effect:'charged',requestId}})}catch{/* 只读观察不得改变已确认的服务回执。 */}
    }
    return value
  }
}

function publicSourceUrl(value: string): boolean {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password }
  catch { return false }
}
