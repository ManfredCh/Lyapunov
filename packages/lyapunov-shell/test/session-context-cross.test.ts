/**
 * 原生离线回合覆盖：environment-routing 的真实规则注入、跨会话隔离和Sim归属，
 * 以及当前快照替换、迟到工具、技能正文复用、JSONL恢复与checkout可见性。
 *
 * Jev 每步 LLM 路由（OpenRouter `~typesafe/jev-latest`）已于 2026-09-26 退役：这两个用例原先桩掉决策
 * 端点、断言 decisions 载荷与 Jev 选中的可选上下文。现在插件恒走规则路径，随之变了两件事：
 *   · 注入与否由**本步消息是否命中环境路由/关键词表**决定（技能类指针还要求目录里真的有该技能），
 *     不再有"每步问一次、include 才注入"的逐步机制；
 *   · 稳定产品正文进入原生 system section；界面/相机/computer-use 等可选段按需保留，不进入常驻正文。
 * 2026-10-01 当前事实改为同owner快照：当前请求只见最新事实，raw日志仍保留旧快照。
 * 原两个用例保留并加强；新用例通过真实原生skill工具和JSONL seed验证实际消费者。
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import LlmRuntime, { createUserMessage, createSystemMessage, createToolResultMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { simWorldsFor, type SimWorlds } from '../../sim-contract/src/index.ts'
import { SessionSimFactory } from '../../sim-contract/src/session-provider.ts'
import { apply } from '../src/plugin.ts'
import { isolateProviderInstaller } from './fixtures/isolated-provider-installer.ts'
import { productIdentityText } from '../src/product-context.ts'
import { formalModelMessageProjection, SKILL_DISCOVERY_GUIDANCE } from '../src/product-input-projection.ts'
import { summarizeWithLlm } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'

// Bun applies the pinned loop's source aliases inside its package. Resolve tools from
// that same importer so the loop and fixture share the scheduler's unique symbol.
// Keep the public package declarations as the fixture's compile-time interface.
const nativeToolsUrl = import.meta.resolve('@deepseek-ai/dsh-tools', import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { default: ToolRuntime, defineContentToolFixture }: typeof import('@deepseek-ai/dsh-tools') = await import(nativeToolsUrl)

let installerRoot: string | undefined
beforeEach(() => { installerRoot = mkdtempSync(join(tmpdir(), 'lyapunov-context-installer-')) })
afterEach(() => {
  // Each test disposes its native Context before this directory is removed.
  if (installerRoot !== undefined) rmSync(installerRoot, { recursive: true, force: true })
  installerRoot = undefined
})
async function applyOfflineShell(shell: Parameters<typeof apply>[0]) {
  if (installerRoot === undefined) throw new Error('Missing context fixture installer root')
  const installer = isolateProviderInstaller(installerRoot)
  try {
    await apply(shell)
    installer.assertCalled()
  } finally { installer.restore() }
}

const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const textOf = (message: Message) => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const sourceOf = (message: Message) => message.source as { kind: string; plugin?: string; form?: string }
const systemText = (request: GenerateOptions) => [request.system ?? '', ...request.messages.filter(message => message.role === 'system').map(textOf)].join('\n')
const userMessages = (events: readonly SessionEvent[]) => events.flatMap(event => event.type === 'user/message' ? [event] : [])
/** 原始日志中的域指针；被新快照替换的旧事实仍在日志中。 */
const pointerEvents = (events: readonly SessionEvent[]) => userMessages(events).filter(event => sourceOf(event.data).kind === 'lyapunov-domain-pointer')
const pointers = (request: GenerateOptions) => request.messages.filter(message => sourceOf(message).kind === 'lyapunov-domain-pointer')
const turnErrors = (events: readonly SessionEvent[]) => events.flatMap(event => event.type === 'turn/end' && event.data.reason.kind === 'error' ? [event] : [])
/** 可选实施回执只写受控夹具的 owner/hash/体量，不导出消息正文、附件或令牌。 */
function captureInputEvidence(label:string,request:GenerateOptions):void{
  const path=process.env.LYAPUNOV_PROMPT_EVIDENCE_PATH
  if(!path)return
  const images=(blocks:readonly ContentBlock[]):number=>blocks.reduce((n,b)=>n+(b.type==='image'?1:b.type==='tool-result'?images(b.content):0),0)
  const digest=(value:string):string=>createHash('sha256').update(value).digest('hex')
  const messages=request.messages.map(message=>{const source=sourceOf(message);return {role:message.role,source:{kind:source.kind,...source.plugin===undefined?{}:{plugin:source.plugin},...source.form===undefined?{}:{form:source.form}},hash:digest(JSON.stringify(message.content)),bytes:Buffer.byteLength(JSON.stringify(message.content)),imageCount:images(message.content)}})
  const tools=JSON.stringify(request.tools??[])
  appendFileSync(path,JSON.stringify({label,purpose:request.purpose??'main',messages,totalContentBytes:messages.reduce((n,m)=>n+m.bytes,0),imageCount:messages.reduce((n,m)=>n+m.imageCount,0),toolCount:request.tools?.length??0,toolBytes:Buffer.byteLength(tools),toolHash:digest(tools)})+'\n')
}
/** 规则路径注入正文的固定抬头（`renderEnvironmentPointer`）：本用例的档位=新建/整体重构。 */
const ENV_ROUTE_HEADER = 'Environment task route: [Create/rebuild]'
const RETIRED_CAMERA_GUIDANCE = /相机与照片同机位：|camera and photo at the same (?:pose|viewpoint)/i

/** Each native session calls the same tool once; subsequent requests end normally. */
class OfflineAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly callId: string) { super() }
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    if (this.requests.length === 1) {
      const block = { type: 'tool-call' as const, id: ToolCallId(this.callId), name: 'context_owned_worlds', arguments: '{}' }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

/** Text-only model fixture for observing durable messages without tool-step noise. */
class TextAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('原生循环：两会话当前域指针替换与clear，相同正文不追加；raw用户与快照保留', async () => {
  const ctx = new Context()
  try {
    // 规则路由不出网：不需要 fetch 替身，也不再设置已退役的 Jev 环境变量。
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, personaPrefix: '', personaSuffix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(JobsLocal)
    const aModel = new TextAdapter(), bModel = new TextAdapter()
    ctx.llm.registerAdapter(['context-a'], aModel)
    ctx.llm.registerAdapter(['context-b'], bModel)
    const shell = {
      // Own the installer's controller and cleanup with native effects; no install is invoked.
      inject: async () => {}, effect: ctx.effect.bind(ctx), jobs: ctx.jobs,
      provide: ctx.provide.bind(ctx), on: ctx.on.bind(ctx), systemPrompt: ctx.systemPrompt,
      tools: { register: () => {}, get: ctx.tools.get.bind(ctx.tools) },
      commands: { register: () => {}, execute: async () => undefined }, connection: { fetch: { register: () => {} } },
      get: (name: string) => name === 'skills' ? { snapshot: async () => ({ skills: [], complete: true }) } : ctx.get(name as never),
    }
    await applyOfflineShell(shell as never)
    const a = await ctx.agentLoop.create(SessionId('pointer-cross-a'), { provider: 'context-a', model: 'fixture' })
    const b = await ctx.agentLoop.create(SessionId('pointer-cross-b'), { provider: 'context-b', model: 'fixture' })
    const aFirst = user('A-first-intent：生成一个场景。')
    const aRepeated = user('A-first-intent：生成一个场景。')
    a.followup(aFirst)
    await a.whenIdle()
    a.followup(aRepeated)
    await a.whenIdle()
    b.followup(user('B-only-intent：生成一个场景。'))
    await b.whenIdle()
    a.followup(user('A-second-intent：停止并只回复文字。'))
    await a.whenIdle()
    a.followup(user('A-unrelated：仅回复文字。'))
    await a.whenIdle()

    const aPointerEvents = pointerEvents(a.session.snapshotEvents())
    const bPointerEvents = pointerEvents(b.session.snapshotEvents())
    expect(aModel.requests).toHaveLength(4)
    expect(bModel.requests).toHaveLength(1)
    // 命中首发；重复用户输入仍保留，建议正文相同不再写事件；换出领域明确clear。
    expect(aPointerEvents).toHaveLength(2)
    expect(bPointerEvents).toHaveLength(1)
    expect(textOf(aPointerEvents[0]!.data)).toContain(ENV_ROUTE_HEADER)
    expect(textOf(aPointerEvents[0]!.data)).toContain("Message contains \"场景\"")
    expect(textOf(bPointerEvents[0]!.data)).toContain(ENV_ROUTE_HEADER)
    expect(aPointerEvents[0]!.surfaceOp).toBe('append')
    expect(aPointerEvents[1]!.surfaceOp).toEqual({ op: 'replace', startSeq: aPointerEvents[0]!.seq, endSeq: aPointerEvents[0]!.seq })
    expect(aPointerEvents[1]!.sourceEventSeqs).toEqual([aPointerEvents[0]!.seq])
    expect(a.session.surface.nodes).not.toContain(aPointerEvents[0]!.seq)
    expect(a.session.surface.nodes).toContain(aPointerEvents[1]!.seq)
    for (const request of aModel.requests) expect(pointers(request)).toHaveLength(1)
    expect(textOf(pointers(aModel.requests[0]!)[0]!)).toBe(textOf(pointers(aModel.requests[1]!)[0]!))
    expect(textOf(pointers(aModel.requests[2]!)[0]!)).toContain('previous domain pointers are no longer current')
    expect(textOf(pointers(aModel.requests[2]!)[0]!)).not.toContain(ENV_ROUTE_HEADER)
    expect(textOf(pointers(aModel.requests[3]!)[0]!)).toBe(textOf(pointers(aModel.requests[2]!)[0]!))
    // 当前请求的用户输入不被正文去重；同文本两个真实message身份均保留。
    const aInputs = userMessages(a.session.snapshotEvents()).filter(event => sourceOf(event.data).kind === 'user')
    expect(aInputs).toHaveLength(4)
    expect(aInputs.slice(0, 2).map(event => event.data.id)).toEqual([aFirst.id, aRepeated.id])
    expect(aFirst.id).not.toBe(aRepeated.id)
    expect(aModel.requests[3]!.messages.filter(message => sourceOf(message).kind === 'user').map(message => message.id)).toEqual(aInputs.map(event => event.data.id))
    expect(a.session.snapshotEvents().filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1, 2, 3, 4])
    expect(a.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['completed', 'completed', 'completed', 'completed'])
    expect(turnErrors(a.session.snapshotEvents())).toEqual([])
    expect(JSON.stringify(bModel.requests)).not.toContain('A-first-intent')
    expect(JSON.stringify(aModel.requests)).not.toContain('B-only-intent')
    for (const event of [...aPointerEvents, ...bPointerEvents]) {
      expect(sourceOf(event.data)).toEqual({ kind: 'lyapunov-domain-pointer', form: 'snapshot' })
      expect(event.data).not.toHaveProperty('common')
      expect(event.data).not.toHaveProperty('transient')
      expect(JSON.stringify(event.data)).not.toContain('common')
      expect(JSON.stringify(event.data)).not.toContain('transient')
    }
    // 稳定核心由 system section 提供；它不再因 section 变化作为动态用户消息持久化。
    for (const request of [...aModel.requests, ...bModel.requests]) {
      expect(systemText(request).split(productIdentityText())).toHaveLength(2)
      expect(systemText(request)).not.toMatch(RETIRED_CAMERA_GUIDANCE)
      expect(systemText(request)).not.toContain('computer-use')
    }
    const aRequestTexts = aModel.requests.flatMap(request => request.messages.map(textOf)).join('\n')
    const bRequestTexts = bModel.requests.flatMap(request => request.messages.map(textOf)).join('\n')
    expect(aRequestTexts).not.toMatch(RETIRED_CAMERA_GUIDANCE)
    expect(bRequestTexts).not.toMatch(RETIRED_CAMERA_GUIDANCE)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('原生循环：迟到工具后当前事实替换，同名世界、真实用户授权与工具结果按会话隔离', async () => {
  const ctx = new Context()
  const disposed: string[] = []
  const versions = new Map<string, { generation: number; revision: number }>()
  let enterTool!: () => void, releaseTool!: () => void
  const toolEntered = new Promise<void>(resolve => { enterTool = resolve })
  const toolReleased = new Promise<void>(resolve => { releaseTool = resolve })
  let held = false
  const factory = new SessionSimFactory({ create: key => ({
    listWorlds: async () => [{ worldId: 'same-world', sceneId: `scene-${key}`, engineId: 'offline-fixture', engineVersion: 'test', worldGeneration: versions.get(key)?.generation ?? 1, appliedSceneRevision: versions.get(key)?.revision ?? 0, status: 'ready' }],
    dispose: async () => { disposed.push(key) },
  } as unknown as SimWorlds) })
  try {
    // 规则路由不出网：不需要 fetch 替身，也不再设置已退役的 Jev 环境变量。
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, personaPrefix: '', personaSuffix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(JobsLocal)
    ctx.provide('sim', factory)
    const aModel = new OfflineAdapter('call-a'), bModel = new OfflineAdapter('call-b')
    ctx.llm.registerAdapter(['context-a'], aModel)
    ctx.llm.registerAdapter(['context-b'], bModel)
    ctx.systemPrompt.context({ name: 'fixture-current-world', order: 8501, text: ({ scope }) => {
      const key = (scope as Agent | undefined)?.session.header.id
      return key ? JSON.stringify({ sceneId: `scene-${key}`, sceneRevision: versions.get(key)?.revision ?? 0, expectedGeneration: versions.get(key)?.generation ?? 1 }) : ''
    } })
    ctx.tools.register(defineContentToolFixture({ name: 'context_owned_worlds', description: 'Read fixture worlds for the native tool owner', parameters: {}, execute: async (_args, exec) => {
      if (exec.agent?.session.header.id === 'context-cross-a' && !held) { held = true; enterTool(); await toolReleased }
      return [{ type: 'text', text: JSON.stringify(await simWorldsFor(ctx, exec.agent).listWorlds()) }]
    } }))
    // Shell HTTP/command registration is inert. The loop, sessions, tools and prompt assembly are native.
    const shell = {
      // Own the installer's controller and cleanup with native effects; no install is invoked.
      inject: async () => {}, effect: ctx.effect.bind(ctx), jobs: ctx.jobs,
      provide: ctx.provide.bind(ctx), on: ctx.on.bind(ctx), systemPrompt: ctx.systemPrompt,
      tools: { register: () => {}, get: ctx.tools.get.bind(ctx.tools) },
      commands: { register: () => {}, execute: async () => undefined }, connection: { fetch: { register: () => {} } },
      get: (name: string) => name === 'skills' ? { snapshot: async () => ({ skills: [], complete: true }) } : ctx.get(name as never),
    }
    await applyOfflineShell(shell as never)
    const a = await ctx.agentLoop.create(SessionId('context-cross-a'), { provider: 'context-a', model: 'fixture' })
    const b = await ctx.agentLoop.create(SessionId('context-cross-b'), { provider: 'context-b', model: 'fixture' })
    // 两会话读到的是**同一个世界名**（工厂固定返回 worldId=same-world），但说的是不同的环境对象：
    // 规则路径按本步消息判定，注入正文里的对象名因此逐会话可区分（A=庭院 / B=厂房）。
    // 消息里必须有建造意图词（"新建"），否则规则路径一条域指针都不注入，注入隔离就无从观察。
    a.followup(user('A-only-intent：给本会话新建一个庭院场景，读取世界并核对相机。'))
    await toolEntered
    versions.set('context-cross-a', { generation: 2, revision: 1 })
    const authorization = createUserMessage({ content: [{ type: 'text', text: 'A-authorization：仅允许已明确的安装范围，不扩权。' }], source: { kind: 'user' } })
    a.inject(authorization)
    releaseTool()
    await a.whenIdle()
    b.followup(user('B-only-intent：给本会话新建一个厂房场景，读取世界。'))
    await b.whenIdle()
    a.followup(user('A-next-intent：停止相机工作，只回复文字。'))
    await a.whenIdle()

    const errors = [a, b].flatMap(agent => turnErrors(agent.session.snapshotEvents()))
    expect(errors).toEqual([])
    expect(aModel.requests).toHaveLength(3)
    expect(bModel.requests).toHaveLength(2)
    for (const request of [...aModel.requests, ...bModel.requests]) {
      expect(systemText(request)).toContain(productIdentityText())
      expect(systemText(request)).not.toMatch(RETIRED_CAMERA_GUIDANCE)
      expect(systemText(request)).not.toContain('computer-use')
      expect(systemText(request)).not.toMatch(/A-only-intent|B-only-intent/)
      expect(systemText(request)).not.toMatch(/scene-context-cross-a|scene-context-cross-b/)
      expect(systemText(request)).not.toMatch(/objects=庭院|objects=厂房/)
    }
    // 逐会话隔离：各自看得见自己那份世界读取，看不见对方的世界事实与意图文本。
    expect(JSON.stringify(aModel.requests)).toContain('scene-context-cross-a')
    expect(JSON.stringify(bModel.requests)).toContain('scene-context-cross-b')
    expect(JSON.stringify(aModel.requests)).not.toContain('scene-context-cross-b')
    expect(JSON.stringify(bModel.requests)).not.toContain('scene-context-cross-a')
    expect(JSON.stringify(aModel.requests)).not.toContain('B-only-intent')
    expect(JSON.stringify(bModel.requests)).not.toContain('A-only-intent')
    expect(factory.sessions().sort()).toEqual(['context-cross-a', 'context-cross-b'])
    await factory.release('context-cross-a')
    expect(disposed).toEqual(['context-cross-a'])
    expect((await simWorldsFor(ctx, b).listWorlds())[0]!.sceneId).toBe('scene-context-cross-b')

    // 规则路径的注入形状：命中回合一条，正文给出本步判定的档位与对象（逐会话不同）。
    const aPointerEvents = pointerEvents(a.session.snapshotEvents())
    const bPointerEvents = pointerEvents(b.session.snapshotEvents())
    expect(aPointerEvents).toHaveLength(2)
    expect(bPointerEvents).toHaveLength(1)
    expect(textOf(aPointerEvents[0]!.data)).toContain(ENV_ROUTE_HEADER)
    expect(textOf(aPointerEvents[0]!.data)).toContain("objects=庭院")
    expect(textOf(bPointerEvents[0]!.data)).toContain("objects=厂房")
    // 注入的域指针不跨会话：A 的请求里没有 B 那条注入正文里的对象，反之亦然。
    expect(JSON.stringify(aModel.requests)).not.toContain('厂房')
    expect(JSON.stringify(bModel.requests)).not.toContain('庭院')
    // 第三请求只带clear快照；原庭院建议仍在raw日志，用户/授权/工具回执不被替换。
    expect(pointers(aModel.requests[2]!)).toHaveLength(1)
    expect(textOf(pointers(aModel.requests[2]!)[0]!)).toContain('previous domain pointers are no longer current')
    expect(textOf(pointers(aModel.requests[2]!)[0]!)).not.toContain("objects=庭院")
    expect(aPointerEvents[1]!.sourceEventSeqs).toEqual([aPointerEvents[0]!.seq])
    const runtime = (request: GenerateOptions) => request.messages.filter(message => message.role === 'user' && sourceOf(message).plugin === '@deepseek-ai/dsh-system-prompt')
    for (const request of [...aModel.requests, ...bModel.requests]) expect(runtime(request)).toHaveLength(1)
    expect(textOf(runtime(aModel.requests[0]!)[0]!)).toContain('"sceneRevision":0')
    for (const request of aModel.requests.slice(1)) {
      expect(textOf(runtime(request)[0]!)).toContain('"sceneRevision":1')
      expect(textOf(runtime(request)[0]!)).toContain('"expectedGeneration":2')
      expect(textOf(runtime(request)[0]!)).not.toContain('"sceneRevision":0')
      expect(request.messages.filter(message => message.id === authorization.id)).toHaveLength(1)
      expect(request.messages.filter(message => sourceOf(message).kind === 'tool')).toHaveLength(1)
    }
    const aRuntimeRaw = userMessages(a.session.snapshotEvents()).filter(event => sourceOf(event.data).plugin === '@deepseek-ai/dsh-system-prompt')
    expect(aRuntimeRaw).toHaveLength(2)
    expect(aRuntimeRaw[1]!.sourceEventSeqs).toEqual([aRuntimeRaw[0]!.seq])
    expect(textOf(aRuntimeRaw[0]!.data)).toContain('"sceneRevision":0')
    expect(textOf(aRuntimeRaw[1]!.data)).toContain('"sceneRevision":1')
    expect(userMessages(a.session.snapshotEvents()).filter(event => event.data.id === authorization.id)).toHaveLength(1)
    expect(userMessages(a.session.snapshotEvents()).filter(event => sourceOf(event.data).kind === 'user')).toHaveLength(3)
    expect(a.session.snapshotEvents().filter(event => event.type === 'tool/result').map(event => event.data.message.content[0].toolCallId)).toEqual([ToolCallId('call-a')])
    expect(a.session.snapshotEvents().filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1, 2])
    expect(a.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['completed', 'completed'])
    expect(a.session.snapshotEvents().filter(event => event.type === 'step/start').map(event => [event.data.turn, event.data.step])).toEqual([[1, 1], [1, 2], [2, 1]])
    expect(a.session.snapshotEvents().filter(event => event.type === 'step/end').map(event => [event.data.turn, event.data.step])).toEqual([[1, 1], [1, 2], [2, 1]])
    expect(JSON.stringify(bModel.requests)).not.toContain('A-authorization')
  } finally {
    try { await ctx.fiber.dispose() } finally { await factory.dispose() }
  }
})

/** 原生skill与loop实际装配；模型只控制调用序列，不替代技能注册/执行/Session。 */
async function skillContextHost() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JobsLocal)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(ToolSkill)
  const shell = {
    inject: async () => {}, effect: ctx.effect.bind(ctx), jobs: ctx.jobs,
    provide: ctx.provide.bind(ctx), on: ctx.on.bind(ctx), systemPrompt: ctx.systemPrompt,
    tools: { register: () => {}, get: ctx.tools.get.bind(ctx.tools) },
    commands: { register: () => {}, execute: async () => undefined }, connection: { fetch: { register: () => {} } },
    get: (name: string) => ctx.get(name as never),
  }
  await applyOfflineShell(shell as never)
  return ctx
}

const nestedText = (blocks: readonly ContentBlock[]): string => blocks.map(block =>
  block.type === 'text' ? block.text : block.type === 'tool-result' ? nestedText(block.content) : '').join('\n')
const requestText = (request: GenerateOptions) => request.messages.map(message => nestedText(message.content)).join('\n')
const jsonlRoundtrip = (events: readonly SessionEvent[], filename: string): SessionEvent[] => {
  const path = join(installerRoot!, filename)
  writeFileSync(path, events.map(event => JSON.stringify(event)).join('\n') + '\n')
  const seed = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)) as SessionEvent[]
  expect(seed).toEqual([...events])
  return seed
}

class SkillReuseAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly actions: Array<'skill' | 'stop'> = []
  constructor(private readonly prefix: string) { super() }
  plan(...actions: Array<'skill' | 'stop'>) { this.actions.push(...actions) }
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    if (this.actions.shift() === 'skill') {
      const block = { type: 'tool-call' as const, id: ToolCallId(`${this.prefix}-${this.requests.length}`), name: 'skill', arguments: JSON.stringify({ name: 'action-execution' }) }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('原生skill消费者：同hash正文复用、跨Session首读、JSONL恢复与checkout后按可见正文重载', async () => {
  const ctx = await skillContextHost()
  type Receipt = { name: string; provider: string; content: string; contentHash: string; reused: boolean }
  const receipts: Array<{ session: string; value: Receipt }> = []
  try {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (exec.name === 'skill' && !result.isError) receipts.push({ session: exec.agent!.session.header.id, value: result.value as unknown as Receipt })
      return decision
    })
    // 加载本候选真实action正文；不以哨兵正文或名称grep冒充实际技能内容。
    const skillPath = join(import.meta.dirname, '../skills/action-execution/SKILL.md')
    const body = readFileSync(skillPath, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '')
    const definition = { name: 'action-execution', description: '本候选动作契约', source: 'runtime', provider: 'context-test-owner', resourceBase: { kind: 'directory' as const, path: join(import.meta.dirname, '../skills/action-execution') }, content: body }
    let remove = ctx.skills.register(definition)
    const aModel = new SkillReuseAdapter('reuse-a'), bModel = new SkillReuseAdapter('reuse-b'), restoredModel = new SkillReuseAdapter('reuse-restored')
    ctx.llm.registerAdapter(['reuse-a'], aModel)
    ctx.llm.registerAdapter(['reuse-b'], bModel)
    ctx.llm.registerAdapter(['reuse-restored'], restoredModel)
    const a = await ctx.agentLoop.create(SessionId('skill-reuse-a'), { provider: 'reuse-a', model: 'fixture' })
    const b = await ctx.agentLoop.create(SessionId('skill-reuse-b'), { provider: 'reuse-b', model: 'fixture' })
    const own = (id: string) => receipts.filter(row => row.session === id).map(row => row.value)
    aModel.plan('skill', 'skill', 'stop')
    a.followup(user('A-skill：读取当前动作契约，只回复检查结果。'))
    await a.whenIdle()
    const firstBoundary = a.session.snapshotEvents().findLast(event => event.type === 'turn/end')!.seq
    expect(aModel.requests).toHaveLength(3)
    expect(own('skill-reuse-a').map(value => value.reused)).toEqual([false, true])
    expect(own('skill-reuse-a')[0]!.content).toBe(body)
    expect(own('skill-reuse-a')[1]!.content).toBe('')
    expect(own('skill-reuse-a')[0]!.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(own('skill-reuse-a')[1]!.contentHash).toBe(own('skill-reuse-a')[0]!.contentHash)
    expect(requestText(aModel.requests[2]!).split('<skill_content name="action-execution">')).toHaveLength(2)
    expect(requestText(aModel.requests[2]!)).toContain('robot_set_tcp')
    expect(requestText(aModel.requests[2]!)).toContain('robot_set_base')
    expect(requestText(aModel.requests[2]!)).toContain("is already visible in this session")
    bModel.plan('skill', 'skill', 'stop')
    b.followup(user('B-skill：读取当前动作契约，只回复检查结果。'))
    await b.whenIdle()
    expect(own('skill-reuse-b').map(value => value.reused)).toEqual([false, true])
    expect(own('skill-reuse-b')[0]!.content).toBe(body)
    expect(JSON.stringify(bModel.requests)).not.toContain('A-skill')
    expect(JSON.stringify(aModel.requests)).not.toContain('B-skill')

    const seed = jsonlRoundtrip(a.session.snapshotEvents(), 'skill-reuse-seed.jsonl')
    const restoredHandle = await ctx.agents.create({ sessionId: SessionId('skill-reuse-restored'), seed, agentOptions: { provider: 'reuse-restored', model: 'fixture' } })
    const restored = restoredHandle.agent
    restoredModel.plan('skill', 'stop')
    restored.followup(user('RESTORED-skill：继续读取同一动作契约。'))
    await restored.whenIdle()
    expect(own('skill-reuse-restored').map(value => value.reused)).toEqual([true])
    expect(own('skill-reuse-restored')[0]!.contentHash).toBe(own('skill-reuse-a')[0]!.contentHash)
    expect(requestText(restoredModel.requests[1]!).split('<skill_content name="action-execution">')).toHaveLength(2)
    expect(restored.session.snapshotEvents().slice(0, seed.length)).toEqual(seed)

    remove()
    const bodyV2 = body + '\n本夹具新增当前版本合同：VERSION-2-BODY。\n'
    remove = ctx.skills.register({ ...definition, content: bodyV2 })
    aModel.plan('skill', 'stop')
    a.followup(user('A-version：继续读取动作契约。'))
    await a.whenIdle()
    const v2Event = a.session.snapshotEvents().findLast(event => event.type === 'tool/result')!
    expect(own('skill-reuse-a')[2]!.reused).toBe(false)
    expect(own('skill-reuse-a')[2]!.content).toBe(bodyV2)
    expect(own('skill-reuse-a')[2]!.contentHash).not.toBe(own('skill-reuse-a')[0]!.contentHash)
    a.session.checkout(firstBoundary)
    expect(a.session.surface.nodes).not.toContain(v2Event.seq)
    aModel.plan('skill', 'stop')
    a.followup(user('A-checkout：读取当前动作契约。'))
    await a.whenIdle()
    expect(own('skill-reuse-a')[3]!.reused).toBe(false)
    expect(own('skill-reuse-a')[3]!.content).toBe(bodyV2)
    expect(own('skill-reuse-a')[3]!.contentHash).toBe(own('skill-reuse-a')[2]!.contentHash)
    // raw的旧V2结果仍在，但不能冒充checkout后当前模型可见正文。
    expect(a.session.snapshotEvents().find(event => event.seq === v2Event.seq)).toEqual(v2Event)
    aModel.plan('stop')
    const slash = user('/action-execution 按已加载契约只回复检查结果。')
    a.followup(slash)
    await a.whenIdle()
    expect(own('skill-reuse-a')).toHaveLength(4)
    expect(userMessages(a.session.snapshotEvents()).filter(event => sourceOf(event.data).kind === 'skill-invocation')).toHaveLength(0)
    expect(requestText(aModel.requests.at(-1)!).split('<skill_content name="action-execution">')).toHaveLength(3)
    // 两个版本各一份；同版本重复加载和显式slash不产生第三份正文。
    expect(requestText(aModel.requests.at(-1)!).split('VERSION-2-BODY')).toHaveLength(2)
    expect(aModel.requests.at(-1)!.messages.some(message => message.id === slash.id)).toBe(true)
    for (const agent of [a, b, restored]) expect(turnErrors(agent.session.snapshotEvents())).toEqual([])
    for (const model of [aModel, bModel, restoredModel]) {
      expect(model.actions).toEqual([])
      for (const request of model.requests) expect(request.messages.filter(message => sourceOf(message).kind === 'skill-catalog')).toHaveLength(1)
    }
    remove()
    await restoredHandle.dispose()
  } finally { await ctx.fiber.dispose() }
})

test('JSONL旧日志实际恢复：多份legacy当前事实与目录只投影最新，raw授权/用户/批注逐字保留', async () => {
  const ctx = await skillContextHost()
  try {
    ctx.skills.register({ name: 'fresh-skill', description: '当前真实目录', source: 'runtime', content: '当前技能正文。' })
    const model = new TextAdapter()
    ctx.llm.registerAdapter(['legacy-restored'], model)
    const legacy = Session.create(SessionId('legacy-context-source'))
    const owner = '@deepseek-ai/dsh-system-prompt'
    legacy.append('system/message', { turn: 1, step: 1, message: createSystemMessage('You are a coding agent powered by the legacy model.\n\nThe DeepSeek Harness implementation checkout is at /fixture/install. Use this checkout only to inspect or extend DSH itself.\n\n' + productIdentityText(), owner) }, { surfaceOp: 'append' })
    for (const revision of [0, 1]) {
      legacy.append('user/message', createUserMessage({ content: [{ type: 'text', text: `LEGACY_RUNTIME_REVISION_${revision}` }], source: { kind: 'plugin', plugin: owner } }), { surfaceOp: 'append' })
      legacy.append('user/message', createUserMessage({ content: [{ type: 'text', text: `LEGACY_DOMAIN_${revision}` }], source: { kind: 'lyapunov-domain-pointer' } as never }), { surfaceOp: 'append' })
      legacy.append('user/message', createUserMessage({ content: [{ type: 'text', text: `LEGACY_CATALOG_${revision}` }], source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: `legacy-${revision}`, description: '旧目录' }] } }), { surfaceOp: 'append' })
    }
    const authorization = createUserMessage({ content: [{ type: 'text', text: 'LEGACY-AUTH：授权范围仍是原用户明确的范围。' }], source: { kind: 'user' } })
    const retiredNotice = createUserMessage({content:[{type:'text',text:'请明确要安装哪个物理引擎：mujoco、isaac、newton。我不会猜测，也不会自动安装。'}], source:{kind:'plugin',plugin:'lyapunov-engine-install',form:'notice',summary:'旧合成提醒'}})
    legacy.append('user/message',retiredNotice,{surfaceOp:'append'})
    const preservedUser = user('LEGACY-USER：禁止额外下载，保留这一约束。')
    const annotation = createUserMessage({ content: [{ type: 'text', text: 'LEGACY-ANNOTATION：保留这个视口批注。' }], source: { kind: 'lyapunov-annotation' } as never })
    for (const message of [authorization, preservedUser, annotation]) legacy.append('user/message', message, { surfaceOp: 'append' })
    const seed = jsonlRoundtrip(legacy.snapshotEvents(), 'legacy-context-seed.jsonl')
    ctx.systemPrompt.context({ name: 'fixture-current-selection', order: 8501, text: 'FRESH_RUNTIME_REVISION_2' })
    const handle = await ctx.agents.create({ sessionId: SessionId('legacy-context-restored'), seed, agentOptions: { provider: 'legacy-restored', model: 'fixture' } })
    handle.agent.followup(user('RESTORE-current：仅回复当前状态。'))
    await handle.agent.whenIdle()
    expect(model.requests).toHaveLength(1)
    const request = model.requests[0]!
    captureInputEvidence('legacy-formal-main',request)
    const runtime = request.messages.filter(message => message.role === 'user' && sourceOf(message).plugin === owner)
    expect(runtime).toHaveLength(1)
    expect(textOf(runtime[0]!)).toContain('FRESH_RUNTIME_REVISION_2')
    expect(requestText(request)).not.toContain('LEGACY_RUNTIME_REVISION_')
    expect(pointers(request)).toHaveLength(1)
    expect(textOf(pointers(request)[0]!)).toContain('previous domain pointers are no longer current')
    expect(requestText(request)).not.toContain('LEGACY_DOMAIN_')
    const catalogs = request.messages.filter(message => sourceOf(message).kind === 'skill-catalog')
    expect(catalogs).toHaveLength(1)
    expect(textOf(catalogs[0]!)).toContain('fresh-skill')
    expect(textOf(catalogs[0]!)).toContain(SKILL_DISCOVERY_GUIDANCE)
    expect(textOf(catalogs[0]!)).not.toContain('call the `skill` tool with the exact name before acting')
    expect(requestText(request)).not.toContain('LEGACY_CATALOG_')
    for (const preserved of [authorization, preservedUser, annotation]) expect(request.messages.find(message => message.id === preserved.id)).toEqual(preserved)
    expect(request.messages.some(message=>message.id===retiredNotice.id)).toBe(false)
    expect(systemText(request)).not.toContain('coding agent')
    expect(systemText(request)).not.toContain('/fixture/install')
    const raw = handle.agent.session.snapshotEvents()
    expect(userMessages(raw).some(event=>event.data.id===retiredNotice.id)).toBe(true)
    expect(raw.slice(0, seed.length)).toEqual(seed)
    expect(pointerEvents(raw)).toHaveLength(3)
    expect(userMessages(raw).filter(event => sourceOf(event.data).plugin === owner)).toHaveLength(3)
    expect(userMessages(raw).filter(event => sourceOf(event.data).kind === 'skill-catalog')).toHaveLength(3)
    expect(turnErrors(raw)).toEqual([])
    expect(systemText(request).split(productIdentityText())).toHaveLength(2)
    await handle.dispose()
  } finally { await ctx.fiber.dispose() }
})

test('原生辅助压缩实际输入：旧系统与安装合成提醒退役，用户授权/批注图片/真实工具图片保留', async () => {
  const ctx = await skillContextHost()
  try {
    expect(ctx.get('modelMessageProjection')).toBe(formalModelMessageProjection)
    const model = new TextAdapter()
    ctx.llm.registerAdapter(['compact-prompt-fixture'], model)
    const agent = await ctx.agentLoop.create(SessionId('prompt-compaction'), {provider:'compact-prompt-fixture',model:'fixture'})
    const oldSystem = createSystemMessage('You are a coding agent powered by the old model.\n\nThe client-plugin HMR receiver is active.', '@deepseek-ai/dsh-system-prompt')
    const authorization = user('明确授权本次已有动作；预算与来源不可变。')
    const image = {type:'image' as const, attachment:{attachmentId:'sha256:'+ 'a'.repeat(64),mediaType:'image/png',bytes:1,width:1,height:1}} as ContentBlock
    const annotation = createUserMessage({content:[{type:'text',text:'用户批注：保持当前物体。'},image],source:{kind:'lyapunov-annotation'} as never})
    const notice = createUserMessage({content:[{type:'text',text:'请明确要安装哪个物理引擎：mujoco、isaac、newton。我不会猜测，也不会自动安装。'}],source:{kind:'plugin',plugin:'lyapunov-engine-install',form:'notice',summary:'旧提醒'}})
    const toolImage = createToolResultMessage({callId:ToolCallId('fixture-observation'),isError:false,content:[{type:'text',text:'原生观察工具回执夹具'},image]})
    const messages=[oldSystem,authorization,annotation,notice,toolImage]
    const tools=[{name:'fixture_read_only',description:'原生工具目录保持',parameters:{type:'object'}}]
    const rawBefore=JSON.stringify(agent.session.snapshotEvents())
    await summarizeWithLlm(ctx,{summarizationProvider:'compact-prompt-fixture',summarizationModel:'fixture',maxTokens:1000},{messages,tools},agent)
    expect(model.requests).toHaveLength(1)
    const request=model.requests[0]!
    captureInputEvidence('formal-compaction',request)
    expect(request.purpose).toBe('compaction')
    expect(request.tools).toEqual(tools)
    expect(systemText(request)).toBe('\n'+productIdentityText())
    expect(requestText(request)).not.toContain('coding agent')
    expect(requestText(request)).not.toContain('HMR receiver')
    expect(request.messages.some(message=>message.id===notice.id)).toBe(false)
    for(const preserved of [authorization,annotation,toolImage])expect(request.messages.find(message=>message.id===preserved.id)).toEqual(preserved)
    const images=(blocks:readonly ContentBlock[]):number=>blocks.reduce((count,block)=>count+(block.type==='image'?1:block.type==='tool-result'?images(block.content):0),0)
    expect(request.messages.reduce((count,message)=>count+images(message.content),0)).toBe(2)
    const instruction=textOf(request.messages.at(-1)!)
    expect(instruction).toContain("Use the user's language.")
    expect(instruction).toContain('resource versions')
    expect(instruction).toContain('authorization from facts')
    expect(JSON.stringify(agent.session.snapshotEvents())).toBe(rawBefore)
    expect(JSON.stringify(messages)).toContain('HMR receiver')
  } finally {await ctx.fiber.dispose()}
})
