import { expect, test } from "bun:test"
import { formalModelRows } from "../src/account/formal.ts"
import { resolveAccountApiUrl } from "../src/account/url.ts"
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import {Context} from '@deepseek-ai/cordis'
import Llm from '@deepseek-ai/dsh-llm'
import {resolveRetryPolicy} from '@deepseek-ai/dsh-llm'

// The server remaps public IDs. An operator's upstream model ID is not a native
// client provider/model ID; changing one must not invent a second client default.
//
// 边界：这里只断言**客户端**事实——默认模型能在原生 provider 目录里解析、口径字段正确。
// 「该 default 也存在于服务端公开目录且 selectable」属服务端契约，随服务端源码归 OM
// （见 LyapunovOM backend/dev-server/services/lyapunov-api/config/model-catalog.example.json）。
test("formal default resolves inside the native provider catalog", () => {
  const rows = formalModelRows({ apiUrl: "https://account.example.invalid" })
  const defaultRow = rows.find((row) => row.id === "agent-default-model")!
  const providerRow = rows.find((row) => row.id === "llm-pi-ai")!
  const selection = defaultRow.config!
  const providers = providerRow.config!.providers!
  const provider = providers[selection.provider]!
  expect(provider.models!.some((model) => model.id === selection.model)).toBe(true)
  expect(provider.api).toBe("openai-completions")
  expect(provider.apiKeyEnv).toBe("LYAPUNOV_ACCOUNT_TOKEN")
  expect(provider.baseURL).toBe("https://account.example.invalid/v1")
  expect(provider.managedBaseURL).toBe(provider.baseURL)
  expect(selection).toEqual({ provider: "lyapunov-plans", model: "peiri" })
  expect(provider.displayName).toBe('Pontryagin')
  expect(provider.models!.map(model=>({id:model.id,name:model.name}))).toEqual([{id:'peiri',name:'Pontryagin'}])
})

test("formal default provider baseURL uses the unified production entry", () => {
  // 正式无配置时，模型 provider 必须落在统一入口的 /v1 前缀下（与实际请求解析同源）。
  const rows = formalModelRows({ apiUrl: resolveAccountApiUrl({ dev: false }) })
  const providerRow = rows.find((row) => row.id === "llm-pi-ai")!
  const provider = providerRow.config!.providers!["lyapunov-plans"]!
  expect(provider.baseURL).toBe("https://vorynel.com/lyaup-unified/v1")
  expect(provider.managedBaseURL).toBe(provider.baseURL)
})

test('正式模型保留原生idle默认与有界重试，不对持续有进度的流强加整阶段截止',async()=>{
  const rows=formalModelRows({apiUrl:'https://account.example.invalid'})
  const raw=rows.find(row=>row.id==='llm-pi-ai')!.config!
  const ctx=new Context()
  try{
  await ctx.plugin(Llm)
  const fiber=ctx.plugin(PiAi,raw)
  await fiber
  const config:PiAi.Config=fiber.config
  const provider=config.providers.get()['lyapunov-plans']!
  expect(ctx.llm.listProviders().find(provider=>provider.id==='lyapunov-plans')?.name).toBe('Pontryagin')
  expect((await ctx.llm.listModels('lyapunov-plans')).map(model=>({id:model.id,name:model.name}))).toEqual([{id:'peiri',name:'Pontryagin'}])
  expect((await ctx.llm.resolveModelInfo('lyapunov-plans','peiri')).name).toBe('Pontryagin')
  const retry=resolveRetryPolicy(raw.providers!['lyapunov-plans']!.retryPolicy,'formal.provider.retryPolicy')
  expect(retry).toMatchObject({mode:'normal',maxRetries:5})
  expect(retry).not.toHaveProperty('requestPhaseTimeoutMs')
  expect(provider.managedBaseURL).toBe('https://account.example.invalid/v1')
  expect(provider.streamIdleTimeoutMs).toBe(300_000)
  expect(provider).not.toHaveProperty('timeoutMs')
  }finally{await ctx.fiber.dispose()}
})
