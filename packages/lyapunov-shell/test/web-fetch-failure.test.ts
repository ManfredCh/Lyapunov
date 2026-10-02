import { afterEach, expect, test } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool, RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Web, { WebError } from '@deepseek-ai/dsh-web'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { applyWebFetchFailureAdapter } from '../src/web-fetch-failure.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const sourceUrl = 'https://example.com/fixed-source.txt'
const signal = new AbortController().signal
const call = (ctx: Context, name = 'web_fetch', args: unknown = { url: sourceUrl }) =>
  ctx.tools.execute({ name, arguments: args, signal, callId: ToolCallId('web-adapter-fixture') })

class BindingRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  seenFailure = ''
  constructor(ctx: Context) { super(ctx) }
  resolve(request: PtcRunRequest): PtcRunSpec { return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 1000 } }
  async run(request: PtcRunRequest): Promise<PtcRunResult> {
    try { await request.bindings[0]!.functions.web_fetch!({ url: sourceUrl }) }
    catch (error) { this.seenFailure = (error as Error).message }
    return { logs: [], value: this.seenFailure }
  }
}

async function harness(failureCode?: string, adapt = true, ptc = false, searchReady: boolean | null = true) {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools, { mode: ptc ? 'both' : 'native' })
  if (ptc) await ctx.plugin(BindingRuntime)
  await ctx.plugin(Web)
  ctx.web.registerSearchProvider({id:'authenticated-search-fixture',available:()=>searchReady===true,async search(){throw new Error('搜索建议不能发起搜索副作用')}})
  if(searchReady!==null)ctx.provide('peiriSearchReadiness' as never,{available:()=>searchReady} as never)
  let calls = 0
  ctx.web.registerFetchProvider({ id: 'http-fixture', available: () => true, async fetch() {
    calls++
    if (failureCode) throw new WebError('PRIVATE_NETWORK_DETAIL_MUST_NOT_LEAK', failureCode)
    return { url: sourceUrl, statusCode: 404, body: { kind: 'text' as const, content: '真实404资源响应' }, truncated: false }
  } })
  await ctx.plugin(ToolWeb, { search: true })
  if (adapt) applyWebFetchFailureAdapter(ctx)
  return { ctx, calls: () => calls }
}

test('实际SDK：公网传输失败保留类别/来源，Browser页面与已知URL读取明确不同，只有一次provider调用', async () => {
  for (const code of ['WEB_FETCH_TIMEOUT', 'WEB_PROVIDER_ERROR', 'WEB_REDIRECT_BLOCKED']) {
    const h = await harness(code)
    const result = await call(h.ctx)
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('失败不能伪造成成功')
    expect(result.error.info?.code).toBe(code)
    expect(result.error.message).toContain(`[${code}]`)
    expect(result.error.message).toContain('Browser Use')
    expect(result.error.message).not.toContain('web_search')
    expect(result.error.message).toContain('does not perform keyword search')
    expect(result.error.message).toContain('web_fetch')
    expect(result.error.message).not.toContain('PRIVATE_NETWORK_DETAIL')
    expect(result.content).toEqual([{ type: 'text', text: `Error: ${result.error.message}` }])
    expect(h.calls()).toBe(1)
  }
})

test('中央ready未知/不可用不影响Native fetch和有限客户端指导；不刷新中央网络', async () => {
  for(const ready of [false,null])for(const code of ['WEB_FETCH_TIMEOUT','WEB_PROVIDER_ERROR','WEB_REDIRECT_BLOCKED']){
    const h=await harness(code,true,false,ready),result=await call(h.ctx)
    expect(result.isError).toBe(true)
    if(!result.isError)throw new Error('原读取失败必须保留')
    expect(result.error.info?.code).toBe(code)
    expect(result.error.message).toContain(`[${code}]`)
    expect(result.error.message).not.toContain('web_search')
    expect(result.error.message).toContain('Browser Use')
    expect(result.error.message).not.toContain('PRIVATE_NETWORK_DETAIL')
    expect(h.calls()).toBe(1)
  }
})

test('实际PTC dispatch：旧投影丢类别；产品adapter让程序收到原code与回退指导，不改PTC/权限', async () => {
  const before = await harness('WEB_PROVIDER_ERROR', false, true)
  await call(before.ctx, RUN_CODE_NAME, { code: 'await tools.web_fetch({url})', description: '隔离PTC边界检查' })
  expect((before.ctx.ptcRuntime as BindingRuntime).seenFailure).not.toContain('WEB_PROVIDER_ERROR')
  const after = await harness('WEB_PROVIDER_ERROR', true, true)
  const result = await call(after.ctx, RUN_CODE_NAME, { code: 'await tools.web_fetch({url})', description: '隔离PTC边界检查' })
  expect(result.isError).toBe(false)
  expect((after.ctx.ptcRuntime as BindingRuntime).seenFailure).toContain('[WEB_PROVIDER_ERROR]')
  expect((after.ctx.ptcRuntime as BindingRuntime).seenFailure).toContain('Browser Use')
  expect(after.calls()).toBe(1)
})

test('无Native keyword provider准确失败并指客户端页面/已知URL，不把fetch当关键词搜索',async()=>{
  const ctx=new Context();contexts.push(ctx);await ctx.plugin(SystemPrompt);await ctx.plugin(Tools);await ctx.plugin(Web);await ctx.plugin(ToolWeb);applyWebFetchFailureAdapter(ctx)
  let readinessReads=0;ctx.provide('peiriSearchReadiness' as never,{available(){readinessReads++;throw Error('不应访问中央搜索缓存')}} as never)
  const result=await call(ctx,'web_search',{queries:['official source query']})
  expect(result.isError).toBe(true);if(!result.isError)throw Error('无provider不可伪成功')
  expect(result.error.info?.code).toBe('WEB_PROVIDER_UNAVAILABLE');expect(result.error.message).toContain('Browser Use');expect(result.error.message).toContain('known official HTTP(S) URL');expect(result.error.message).toContain('does not perform keyword search');expect(result.error.message).not.toContain('Peiri');expect(readinessReads).toBe(0)
})

test('Native provider选择失败保留配置ID、可用ID及原文本，英文指导只追加且零provider调用',async()=>{
  const cases=[
    {code:'WEB_PROVIDER_CONFIGURED_MISSING',configuredId:'public-missing',ids:[],usable:false,fact:'configured web provider "public-missing" is not registered'},
    {code:'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',configuredId:'public-unavailable',ids:['public-unavailable'],usable:false,fact:'configured web provider "public-unavailable" is registered but unavailable'},
    {code:'WEB_PROVIDER_AMBIGUOUS',configuredId:undefined,ids:['public-alpha','public-beta'],usable:true,fact:'multiple usable web providers are registered (public-alpha, public-beta); configure one explicitly'},
    {code:'WEB_PROVIDER_UNAVAILABLE',configuredId:undefined,ids:[],usable:false,fact:'no usable web provider is registered'},
  ]
  for(const fixture of cases){
    const ctx=new Context();contexts.push(ctx);await ctx.plugin(SystemPrompt);await ctx.plugin(Tools);await ctx.plugin(Web,fixture.configuredId?{searchProvider:fixture.configuredId}:{})
    let providerCalls=0
    for(const id of fixture.ids)ctx.web.registerSearchProvider({id,available:()=>fixture.usable,async search(){providerCalls++;throw Error('选择失败不得调用provider')}})
    await ctx.plugin(ToolWeb)
    const before=await call(ctx,'web_search',{queries:['official fixture source']})
    if(!before.isError)throw Error('Native选择失败必须保留')
    expect(before.error.info?.code).toBe(fixture.code);expect(before.error.message).toContain(fixture.fact)
    applyWebFetchFailureAdapter(ctx)
    const after=await call(ctx,'web_search',{queries:['official fixture source']})
    if(!after.isError)throw Error('指导不能把选择失败转成功')
    expect(after.error.info).toEqual(before.error.info)
    expect(after.error.message.startsWith(before.error.message+'\n\n')).toBe(true)
    expect(after.content.slice(0,before.content.length)).toEqual(before.content)
    expect(after.content).toHaveLength(before.content.length+1)
    const guidance=after.content.at(-1)
    if(guidance?.type!=='text')throw Error('仅允许追加英文文本指导')
    expect(guidance.text).toContain(`[${fixture.code}]`);expect(guidance.text).toContain('Browser Use');expect(guidance.text).toContain('web_fetch');expect(guidance.text).toContain('Bash')
    expect(after.error.message).toBe(before.error.message+'\n\n'+guidance.text)
    expect(providerCalls).toBe(0)
  }
})

test('Native搜索成功与未知失败原样返回，不附指导或增加provider调用',async()=>{
  for(const unknown of [false,true]){
    const ctx=new Context();contexts.push(ctx);await ctx.plugin(SystemPrompt);await ctx.plugin(Tools);await ctx.plugin(Web)
    let providerCalls=0
    ctx.web.registerSearchProvider({id:'public-selected',available:()=>true,async search(){providerCalls++;if(unknown)throw new WebError('原始公开失败事实 public-selected','WEB_PUBLIC_CUSTOM_FAILURE');return {sources:[{url:'https://official.example/fixture',title:'官方夹具'}],content:'原始公开资料事实',truncated:false}}})
    await ctx.plugin(ToolWeb)
    const before=await call(ctx,'web_search',{queries:['official fixture source']})
    applyWebFetchFailureAdapter(ctx)
    const after=await call(ctx,'web_search',{queries:['official fixture source']})
    expect(after.isError).toBe(before.isError);expect(after.content).toEqual(before.content)
    if(before.isError&&after.isError)expect(after.error).toEqual(before.error)
    else if(!before.isError&&!after.isError)expect(after.value).toEqual(before.value)
    else throw Error('成功或未知失败类别不可改变')
    expect(providerCalls).toBe(2)
  }
})

test('主动取消、地址限制、依赖/大小/类型错误各有准确下一步，不自动绕过/下载', async () => {
  for (const code of ['WEB_ABORTED', 'WEB_BLOCKED_URL', 'WEB_INVALID_URL', 'WEB_FETCH_TOO_LARGE', 'WEB_UNSUPPORTED_CONTENT_TYPE', 'WEB_PROVIDER_UNAVAILABLE']) {
    const h = await harness(code), result = await call(h.ctx)
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('失败不能伪造成成功')
    expect(result.error.info?.code).toBe(code)
    expect(result.error.message).toContain(`[${code}]`)
    expect(result.error.message).not.toContain('PRIVATE_NETWORK_DETAIL')
    if (code === 'WEB_ABORTED') expect(result.error.message).toContain('Do not start a fallback request')
    if (code === 'WEB_BLOCKED_URL') expect(result.error.message).toContain('do not bypass permissions or address restrictions through a proxy or mirror')
    expect(h.calls()).toBe(1)
  }
})

test('成功的HTTP404保留真实status/value；坏arguments在SDK失败且provider未调用', async () => {
  const h = await harness(), result = await call(h.ctx)
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('正常HTTP资源响应不是传输失败')
  expect(result.value).toEqual({ url: sourceUrl, statusCode: 404, body: { kind: 'text', content: '真实404资源响应' }, truncated: false })
  expect(h.calls()).toBe(1)
  const bad = await call(h.ctx, 'web_fetch', { url: 42 })
  expect(bad.isError).toBe(true)
  if (!bad.isError) throw new Error('坏arguments必须仍失败')
  expect(bad.error.info?.code).toBe('INVALID_ARGS')
  expect(h.calls()).toBe(1)
})

test('未知web错误与其它工具不改文本/类别；64位字符串ID精确保留，BigInt依旧拒绝', async () => {
  const h = await harness('UNRECOGNIZED_WEB_FAILURE'), unknown = await call(h.ctx)
  expect(unknown.isError).toBe(true)
  if (!unknown.isError) throw new Error('未知错误必须失败')
  expect(unknown.error.message).toBe('PRIVATE_NETWORK_DETAIL_MUST_NOT_LEAK')
  h.ctx.tools.register(defineTool({ name: 'other_failure_fixture', description: '隔离其它工具失败检查', parameters: {}, output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] }, async execute() { throw new WebError('OTHER_TOOL_ERROR_UNCHANGED', 'WEB_PROVIDER_ERROR') } }))
  const other = await call(h.ctx, 'other_failure_fixture', {})
  expect(other.isError).toBe(true)
  if (!other.isError) throw new Error('其它工具失败必须原样保留')
  expect(other.error.message).toBe('OTHER_TOOL_ERROR_UNCHANGED')
  expect(other.error.info?.code).toBe('WEB_PROVIDER_ERROR')
  const exactId = '18446744073709551615'
  let identityCalls = 0
  h.ctx.tools.register(defineTool({ name: 'string_identity_fixture', description: '隔离字符串身份检查', parameters: { id: { type: 'string', required: true } }, output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] }, async execute(args) { identityCalls++; return args.id } }))
  const exact = await call(h.ctx, 'string_identity_fixture', { id: exactId })
  expect(exact.isError).toBe(false)
  if (exact.isError) throw new Error('合法字符串身份应进入工具')
  expect(exact.value).toBe(exactId)
  const lossy = await call(h.ctx, 'string_identity_fixture', { id: 18446744073709551615n })
  expect(lossy.isError).toBe(true)
  if (!lossy.isError) throw new Error('非JSON BigInt必须仍被SDK拒绝')
  expect(lossy.error.message).toBe('tool execution arguments must be losslessly JSON-serializable')
  expect(identityCalls).toBe(1)
})
