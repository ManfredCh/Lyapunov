/** Native Cordis/Session behavior for the compiled, isolated outbound patch. */
import {test, expect, describe} from 'bun:test'
import {spawnSync} from 'node:child_process'
import {join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import SessionStore, {type Session, type SessionEvent} from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import {AssistantStreamAccumulator, expandAssistantStream, createMessage, createUserMessage, ToolCallId, LlmAttemptId, type StreamChunk, type AssistantStreamRecord} from '@deepseek-ai/dsh-llm'
import type {Agent, AssistantStreamFrame} from '@deepseek-ai/dsh-agent'
import type {SessionPage, SessionFollowFrame, SessionFollowRequest, SessionPageRequest} from '@deepseek-ai/dsh-api-session-controller/types'
import {createSessionOutboundProjection, type SessionOutboundProjection} from '../packages/lyapunov-contracts/src/session-event-projection.ts'

const compiled = process.env.LYAPUNOV_OUTBOUND_COMPILED
const isolatedTestTimeoutMs = 120_000
if (!compiled) {
  test('build and execute candidate in an isolated source copy', () => {
    // 用**跑本文件的那个解释器**（`process.execPath`）起子文件，不按名字 spawn `'node'`：这里要的只是
    // "一个能跑 `script/upstream-patches.test.mjs` 的进程"，而该子文件只用 `node:test` 的 API——bun 同样执行它。
    // 但**参数形状随运行器而变**（实测三态：`node --test <f>` exit 0 / `bun --test <f>` exit 1 / `bun test <f>` exit 0）
    // ⇒ 运行器感知：bun 下 `[execPath, 'test', f]`，node 下 `[execPath, '--test', f]`。
    // 按名字 spawn `'node'` ⇒ 本用例依赖调用方 PATH（CI 镜像没有 node 时红，净化 PATH 实测 exit 1）。
    // `BUN_BIN` 仍交给子进程：子文件用它拉起内层 `bun --no-env-file test script/outbound-projection.test.ts`
    // 来跑本文件真正的那 7 条投影断言——**父、子分工是刻意的**（父=bun:test 入口，子=node:test 构建/隔离）。
    const runnerArguments = process.versions.bun
      ? ['test', join(import.meta.dir, 'upstream-patches.test.mjs')]
      : ['--test', join(import.meta.dir, 'upstream-patches.test.mjs')]
    const result = spawnSync(process.execPath, runnerArguments, {
      cwd: resolve(import.meta.dir, '..'), encoding: 'utf8', timeout: isolatedTestTimeoutMs,
      env: {...process.env, BUN_BIN: process.execPath},
    })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  }, isolatedTestTimeoutMs)
} else {
  interface History {
    page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage>
    follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame>
  }
  const {SessionHistoryController} = await import(pathToFileURL(join(compiled, 'history.js')).href) as {
    SessionHistoryController: new (ctx: Context, promote: () => void) => History
  }
  class Query extends SessionQueryEngine {
    override searchSessions(): Promise<never> { return Promise.reject(new Error('search is not used')) }
    override searchEvents(): Promise<never> { return Promise.reject(new Error('search is not used')) }
  }
  const secret = '/private/root/SECRET_INTERNAL_TOKEN'
  const args = JSON.stringify({token: secret, path: '/private/root/model.bin', label: 'public'})
  const callId = ToolCallId('privacy-call')
  const attemptId = LlmAttemptId('privacy-attempt')
  const block = {type: 'tool-call' as const, id: callId, name: 'inspect', arguments: args}
  const chunks: StreamChunk[] = [
    {type: 'block-start', index: 0, blockType: 'tool-call'},
    {type: 'tool-call-delta', index: 0, id: callId, name: 'inspect', argumentsDelta: args.slice(0, 25)},
    {type: 'tool-call-delta', index: 0, id: callId, argumentsDelta: args.slice(25)},
    {type: 'block-end', index: 0, block},
    {type: 'text-delta', index: 1, text: 'public answer'},
    {type: 'reasoning-delta', index: 2, text: 'public reasoning'},
    {type: 'usage', usage: {inputTokens: 4, outputTokens: 2}},
  ]
  const stream = (): AssistantStreamRecord[] => {
    const accumulator = new AssistantStreamAccumulator()
    chunks.forEach((chunk, index) => accumulator.push({time: 100 + index * 7, chunk}))
    return structuredClone(accumulator.snapshot()) as AssistantStreamRecord[]
  }
  const envelope = (event: object) => {
    const {data: _data, ...metadata} = event as SessionEvent
    return metadata
  }
  const wireText = (value: unknown) => JSON.stringify(value)
  const equalWire = (actual: unknown, expected: unknown) => expect(wireText(actual)).toBe(wireText(expected))
  const install = async (ctx: Context, service: SessionOutboundProjection) => {
    const fiber = ctx.plugin({
      name: `outbound-test-provider`,
      apply(inner: Context) {
        inner.effect(() => inner.provide('sessionOutboundProjection', service), 'outbound-test-provider')
      },
    })
    await fiber
    expect(ctx.get('sessionOutboundProjection', false)).toBe(service)
    return fiber
  }
  async function harness() {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    new SessionProjectionRegistry(ctx)
    new Query(ctx)
    const session = ctx.sessions.create(undefined, {meta: {cwd: '/workspace'}})
    const history = new SessionHistoryController(ctx, () => { throw new Error('live Session must not promote') })
    const agent = {id: session.id, session, ctx, status: 'running'} as Agent
    const emit = (frame: AssistantStreamFrame) => ctx.emit('agent/assistant-stream', {agent, frame})
    const address = {kind: 'session' as const, sessionId: session.id}
    const page = () => history.page({address, throughSeq: session.seq - 1}, new AbortController().signal)
    const follows: {abort: AbortController; iterator: AsyncIterator<SessionFollowFrame>}[] = []
    async function follow(assistantStream = true) {
      const abort = new AbortController()
      const iterator = history.follow({address, ...assistantStream ? {assistantStream: true as const} : {}}, abort.signal)[Symbol.asyncIterator]()
      follows.push({abort, iterator})
      const first = await iterator.next()
      if (first.done || first.value.type !== 'snapshot') throw new Error('missing initial snapshot')
      return {snapshot: first.value, iterator, abort}
    }
    function start() {
      emit({type: 'start', attemptId, revision: 1, turn: 1, step: 1})
      chunks.forEach((chunk, index) => emit({type: 'chunk', attemptId, revision: index + 2, index, time: 100 + index * 7, chunk}))
    }
    async function dispose() {
      for (const {abort, iterator} of follows) { abort.abort(); await iterator.return?.() }
      await ctx.fiber.dispose()
    }
    return {ctx, session, history, emit, start, page, follow, dispose}
  }
  function appendCall(session: Session) {
    return session.append('tool/call', {turn: 1, step: 1, callId, name: 'inspect', arguments: args})
  }
  function appendAssistant(session: Session) {
    return session.append('assistant/message', {
      turn: 1, step: 1, stream: stream(),
      message: createMessage({role: 'assistant', content: [block], source: {kind: 'model', provider: 'p', model: 'm'}}),
    }, {surfaceOp: 'append'})
  }
  async function next(iterator: AsyncIterator<SessionFollowFrame>): Promise<SessionFollowFrame> {
    const value = await iterator.next()
    if (value.done) throw new Error('follow ended before expected frame')
    return value.value
  }
  function assertProjected(value: unknown) {
    expect(wireText(value)).not.toContain('SECRET_INTERNAL_TOKEN')
    expect(wireText(value)).not.toContain('/private/root')
    expect(wireText(value)).not.toContain('token=')
  }
  const marked = (marker: string): SessionOutboundProjection => ({
    projectEvent: (event: unknown) => ({...(event as SessionEvent), data: {marker}}),
    projectBlock: (value: unknown) => {
      const input = value as Record<string, unknown>
      return {...input, ...typeof input.arguments === 'string' ? {arguments: marker} : {}, ...typeof input.text === 'string' ? {text: marker} : {}}
    },
  })

  describe('compiled native outbound projection', () => {
    test('absent provider rejects page, follow, and reconnect rather than exposing native values', async () => {
      const h = await harness()
      try {
        appendCall(h.session); appendAssistant(h.session); h.start()
        await expect(h.page()).rejects.toThrow('missing active sessionOutboundProjection service')
        await expect(h.follow()).rejects.toThrow('missing active sessionOutboundProjection service')
      } finally { await h.dispose() }
    })

    test('real product provider projects page, snapshot, live durable and embedded streams without editing Session truth', async () => {
      const h = await harness()
      try {
        appendCall(h.session); appendAssistant(h.session)
        h.session.append('assistant/attempt', {turn: 1, step: 1, stream: stream()})
        const before = structuredClone(h.session.snapshotEvents())
        const modelBefore = structuredClone(h.session.deriveMessages())
        await install(h.ctx, createSessionOutboundProjection('formal'))
        const page = await h.page()
        assertProjected(page)
        expect(page.records.map(record => envelope(record.event))).toEqual(before.map(envelope))
        const {snapshot, iterator} = await h.follow()
        expect(snapshot.records).toEqual(page.records)
        const event = appendCall(h.session)
        const frame = await next(iterator)
        expect(frame.type).toBe('event')
        assertProjected(frame)
        if (frame.type === 'event') expect(envelope(frame.event)).toEqual(envelope(event))
        equalWire(h.session.snapshotEvents().slice(0, before.length), before)
        equalWire(h.session.deriveMessages(), modelBefore)
        expect(wireText((await h.ctx.sessionQuery.observeSession(h.session.id)).events)).toContain(secret)
        expect(wireText(h.session.snapshotEvents())).toContain(secret)
      } finally { await h.dispose() }
    })

    test('projects live chunks and actual packed reconnect stream while keeping all times and indexes', async () => {
      const h = await harness()
      try {
        await install(h.ctx, createSessionOutboundProjection('formal'))
        const {iterator} = await h.follow()
        h.start()
        const start = await next(iterator)
        expect(start).toEqual({type: 'assistant-stream', frame: {type: 'start', attemptId, revision: 1, turn: 1, step: 1, startedAfterSeq: -1}})
        for (let index = 0; index < chunks.length; index++) {
          const frame = await next(iterator)
          assertProjected(frame)
          expect(frame).toMatchObject({type: 'assistant-stream', frame: {type: 'chunk', attemptId, revision: index + 2, index, time: 100 + index * 7}})
        }
        const {snapshot} = await h.follow()
        const attempt = snapshot.assistantStream?.activeAttempt
        expect(attempt).toMatchObject({attemptId, turn: 1, step: 1, startedAfterSeq: -1, nextIndex: chunks.length})
        assertProjected(attempt)
        const records = attempt!.stream as unknown as AssistantStreamRecord[]
        expect(records.map(record => record.type)).toEqual(stream().map(record => record.type))
        expect(expandAssistantStream(records).map(({time}) => time)).toEqual(chunks.map((_, i) => 100 + i * 7))
        expect(wireText(chunks)).toContain(secret)
      } finally { await h.dispose() }
    })

    test('late load, dispose, and reload affect existing controller and queued outbound frames', async () => {
      const h = await harness()
      try {
        appendCall(h.session); h.start()
        const first = await install(h.ctx, marked('first'))
        const {iterator} = await h.follow()
        expect(wireText(await h.page())).toContain('first')
        expect(wireText((await h.follow()).snapshot.assistantStream)).toContain('first')
        appendCall(h.session)
        h.emit({type: 'chunk', attemptId, revision: chunks.length + 2, index: chunks.length, time: 200, chunk: chunks[1]!})
        await first.dispose()
        expect(h.ctx.get('sessionOutboundProjection', false)).toBeUndefined()
        await expect(h.page()).rejects.toThrow('missing active sessionOutboundProjection service')
        const replacement = await install(h.ctx, marked('replacement'))
        const replacementFollow = await h.follow()
        expect(wireText(replacementFollow.snapshot)).toContain('replacement')
        expect(wireText(await next(iterator))).toContain('replacement')
        expect(wireText(await h.page())).toContain('replacement')
        expect(wireText((await h.follow()).snapshot.assistantStream)).toContain('replacement')
        await replacement.dispose()
        expect(h.ctx.get('sessionOutboundProjection', false)).toBeUndefined()
        await expect(h.page()).rejects.toThrow('missing active sessionOutboundProjection service')
        await expect(h.follow()).rejects.toThrow('missing active sessionOutboundProjection service')
        await install(h.ctx, marked('reloaded'))
        expect(wireText(await h.page())).toContain('reloaded')
        expect(wireText((await h.follow()).snapshot.assistantStream)).toContain('reloaded')
      } finally { await h.dispose() }
    })

    test('detaches projector inputs and preserves every native envelope field', async () => {
      const h = await harness()
      try {
        const source = h.session.append('user/message', createUserMessage({content: [{type: 'text', text: 'first'}], source: {kind: 'user'}}), {surfaceOp: 'append'})
        h.session.append('user/message', createUserMessage({content: [{type: 'text', text: secret}], source: {kind: 'user'}}), {
          surfaceOp: {op: 'replace', startSeq: source.seq, endSeq: source.seq}, sourceEventSeqs: [source.seq],
        })
        // Seed an ignorable extension via native restore/create, preserving its envelope.
        const seed = structuredClone(h.session.snapshotEvents())
        seed[1]!.ignorable = true
        const other = h.ctx.sessions.create(undefined, {seed, meta: {cwd: '/workspace'}})
        const before = structuredClone(other.snapshotEvents())
        await install(h.ctx, {
          projectEvent(value) {
            const event = value as unknown as Record<string, unknown>
            event.type = 'changed'; event.seq = 999; event.time = 0
            event.sourceEventSeqs = []; event.surfaceOp = 'append'; delete event.ignorable
            event.data = {redacted: true}
            return event
          },
          projectBlock(value) { return value },
        })
        const page = await h.history.page({address: {kind: 'session', sessionId: other.id}, throughSeq: other.seq - 1}, new AbortController().signal)
        expect(page.records.map(record => envelope(record.event))).toEqual(before.map(envelope))
        expect(page.records.every(record => wireText(record.event.data) === '{"redacted":true}')).toBe(true)
        expect(other.snapshotEvents()).toEqual(before)
      } finally { await h.dispose() }
    })

    test('mixed live FIFO ordering, cancellation, and Agent disposal keep native lifecycle semantics', async () => {
      const h = await harness()
      try {
        await install(h.ctx, createSessionOutboundProjection('formal'))
        const {iterator, abort} = await h.follow()
        h.emit({type: 'start', attemptId, revision: 1, turn: 1, step: 1})
        const chunk = {type: 'chunk' as const, attemptId, revision: 2, index: 0, time: 100, chunk: chunks[1]!}
        h.emit(chunk)
        const committed = appendAssistant(h.session)
        const end = {type: 'end' as const, attemptId, revision: 3, index: 1, outcome: {kind: 'committed' as const, eventType: 'assistant/message' as const, seq: committed.seq}}
        h.emit(end)
        const frames = [await next(iterator), await next(iterator), await next(iterator), await next(iterator)]
        expect(frames.map(frame => frame.type)).toEqual(['assistant-stream', 'assistant-stream', 'event', 'assistant-stream'])
        expect(frames[3]).toEqual({type: 'assistant-stream', frame: end})
        frames.forEach(assertProjected)
        h.ctx.emit('agent/disposed', {agent: {session: h.session} as Agent})
        expect((await h.follow()).snapshot.assistantStream).toEqual({revision: 0})
        abort.abort()
        expect((await iterator.next()).done).toBe(true)
      } finally { await h.dispose() }
    })

    test('provider exceptions reject outbound reads rather than exposing unprojected events', async () => {
      const h = await harness()
      try {
        appendCall(h.session)
        await install(h.ctx, {projectEvent() { throw new Error('projector unavailable') }, projectBlock(value) { return value }})
        await expect(h.page()).rejects.toThrow('projector unavailable')
        await expect(h.follow()).rejects.toThrow('projector unavailable')
        expect(wireText(h.session.snapshotEvents())).toContain(secret)
      } finally { await h.dispose() }
    })
  })
}
