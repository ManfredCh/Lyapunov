import {createAccountClient,normalizeAccountApiUrl,type AccountMe} from "./client.ts"
import type {Options as PiAiOptions} from "@deepseek-ai/dsh-llm-pi-ai"

export interface VerifiedAccount {
  apiUrl:string
  token:string
  me:AccountMe
}

/** 使用现有账户API的真实身份响应选择本地目录，不能信任调用方填写的账号ID。 */
export async function verifyFormalAccount(input:{apiUrl:string;token:string;fetcher?:(input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>;signal?:AbortSignal}):Promise<VerifiedAccount>{
  const apiUrl=normalizeAccountApiUrl(input.apiUrl)
  if(!input.token)throw new Error("AUTH_REQUIRED: 正式模式需要已登录的账户会话")
  const client=createAccountClient({baseUrl:apiUrl,fetcher:input.fetcher})
  input.signal?.throwIfAborted()
  const signal=input.signal?AbortSignal.any([input.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)
  const me=await client.me(input.token,signal)
  signal.throwIfAborted()
  if(!me?.user||typeof me.user.id!=="string"||!me.user.id.trim())throw new Error("INVALID_ACCOUNT_IDENTITY: 账户API没有返回有效身份")
  return {apiUrl,token:input.token,me}
}

/** 使用 DSH 原生 OpenAI-compatible Provider；Key仍是可撤销的用户会话，计费留在中央服务。 */
export function formalModelRows(account:Pick<VerifiedAccount,"apiUrl">){
  const llm:PiAiOptions={providers:{"lyapunov-plans":{
    displayName:"peiri",apiKeyEnv:"LYAPUNOV_ACCOUNT_TOKEN",api:"openai-completions",baseURL:account.apiUrl+"/v1",
    compat:{supportsStore:false,supportsUsageInStreaming:true,supportsReasoningEffort:false},
    retryPolicy:{mode:'normal',maxRetries:5},
    models:[{id:"peiri",name:"Peiri",input:["text","image"],contextWindow:262144,maxTokens:8192}],
  }}}
  return [
    {id:"llm-deepseek" as const,disabled:true},
    {id:"agent-default-model" as const,config:{provider:"lyapunov-plans",model:"peiri"}},
    {id:"llm-pi-ai" as const,config:llm},
  ]
}
