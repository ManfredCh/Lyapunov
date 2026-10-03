import type { Context } from '@deepseek-ai/cordis'
import { env } from './env.ts'
import { PeiriSearchProvider } from './search.ts'
import {AsyncLocalStorage} from 'node:async_hooks'
import {createHash} from 'node:crypto'
import type {WebSearchRequest} from '@deepseek-ai/dsh-web'
import {createCentralReadOnlyDiagnostic,type CentralReadOnlyInput} from './read-only-diagnostic.ts'
import {requireSessionId} from '../../lyapunov-contracts/src/session-scope.ts'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {CentralDiagnostic} from './service-contract.ts'
declare module '@deepseek-ai/dsh-session/types' {interface SessionEventMap {'lyapunov/service-diagnostic':{callId:string;intentKey:string;code:string;diagnostic:CentralDiagnostic|null;outcome?:'success'|'error'}}}
declare module '@deepseek-ai/cordis' {interface Context {peiriSearchReadiness:{available():boolean;cached():ReturnType<PeiriSearchProvider['cachedReadiness']>;refresh(signal?:AbortSignal):ReturnType<PeiriSearchProvider['refreshReadiness']>}}}
export const name = 'lyapunov-peiri-search'
export const inject = ['web']
export function apply(ctx: Context, config: { apiUrl: string; search?: boolean }) {
  const sessionToken=()=>env(process.env,'LYAPUNOV_MODE')==='formal'?env(process.env,'LYAPUNOV_ACCOUNT_TOKEN'):undefined
  const intents=new AsyncLocalStorage<{identity:string;callId:string;agent?:Agent;requests:WeakMap<WebSearchRequest,string>;ordinal:number}>()
  // 只有明确装配中央搜索且处于正式认证模式才注册；环境或模型名称不能启用此能力。
  const provider=config.search===true&&env(process.env,'LYAPUNOV_MODE')==='formal'?new PeiriSearchProvider({apiUrl:config.apiUrl,sessionToken,onFailure:record=>{
    const scope=intents.getStore();if(!scope?.agent)return
    scope.agent.session.append('lyapunov/service-diagnostic',{callId:scope.callId,intentKey:record.intentKey,code:record.code,diagnostic:record.diagnostic??null,outcome:'error'},{ignorable:true})
  },onReceipt:record=>{
    const scope=intents.getStore();if(!scope?.agent)return
    scope.agent.session.append('lyapunov/service-diagnostic',{callId:scope.callId,intentKey:record.intentKey,code:record.diagnostic.code,diagnostic:record.diagnostic,outcome:'success'},{ignorable:true})
  },intentKey:request=>{
    const scope=intents.getStore();if(!scope)return undefined
    const known=scope.requests.get(request);if(known)return known
    const key='search-'+createHash('sha256').update(scope.identity+':'+scope.ordinal++).digest('hex')
    scope.requests.set(request,key);return key
  }}):undefined
  if(provider){
    ctx.web.registerSearchProvider(provider)
    ctx.effect(()=>ctx.provide('peiriSearchReadiness',{available:()=>provider.available(),cached:()=>provider.cachedReadiness(),refresh:(signal?:AbortSignal)=>provider.refreshReadiness(signal)}),'显式Peiri搜索公开状态')
    // 只保中央provider实际被调用时的原生意图；不对其它provider作readiness请求或全局deny。
    ctx.on('tools/execute',(exec,next)=>exec.name==='web_search'?intents.run({identity:String(exec.agent?.id??'native-call')+':'+exec.callId,callId:String(exec.callId),agent:exec.agent,requests:new WeakMap(),ordinal:0},next):next())
  }
  const diagnostic=createCentralReadOnlyDiagnostic({apiUrl:config.apiUrl,sessionToken,mode:()=>env(process.env,'LYAPUNOV_MODE'),...(provider?{searchProvider:provider}:{})})
  ctx.inject(['commands'],child=>{
    child.commands.register({name:'central_service_status',description:'Read-only formal service identity, generation quotes, or the original model/search/generation request status. Search readiness is read only when legacy search is explicitly configured. This Command does not submit generation or read usage and ledgers.',recordInput:false,input:{hint:'{"action":"me|quote|lookup","domain":"generation|model|search","product":"marble|hunyuan|tripo|image","requestId":"original request ID required for lookup"}'},handler:async invocation=>{
      requireSessionId(invocation.agent,'中央服务诊断')
      const input=JSON.parse(invocation.rawInput||'{}') as CentralReadOnlyInput
      const value=await diagnostic(input,invocation.signal)
      return {kind:'success',text:JSON.stringify(value)}
    }})
  })
}
