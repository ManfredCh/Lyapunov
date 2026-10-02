/** Offline execution of the candidate against pinned native Controller/Session code. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import ts from "typescript"
import { Context } from "@deepseek-ai/cordis"
import type { Agent, AssistantStreamFrame } from "@deepseek-ai/dsh-agent"
import type { SessionFollowFrame, SessionFollowRequest, SessionPage, SessionPageRequest } from "@deepseek-ai/dsh-api-session-controller/types"
import {
  AssistantStreamAccumulator, LlmAttemptId, ToolCallId, createMessage, createUserMessage,
  expandAssistantStream, type AssistantStreamRecord, type ContentBlock, type StreamChunk,
} from "@deepseek-ai/dsh-llm"
import SessionStore, { type Session, type SessionEvent } from "@deepseek-ai/dsh-session"
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection"
import SessionQueryEngine from "@deepseek-ai/dsh-session-query"
import { createSessionOutboundProjection, type SessionOutboundProjection } from "../../lyapunov-contracts/src/session-event-projection.ts"

const root = resolve(import.meta.dirname, "../../..")
const upstream = join(root, ".upstream/deepseek-harness-20260911-candidate")
const pinned = "7c3f05885033aa3aed74904d59a94692d12a47f7"
const packagePath = "packages/api/session-controller"
const patchPath = join(root, "packages/lyapunov-shell/patches/dsh-session-outbound-projection.patch")
const serviceName = "sessionOutboundProjection"
const missingProvider = "missing active sessionOutboundProjection service"
const MARKERS = [
  // 合成标记按片段拼接：正文不出现完整 key 形状（g17 `no_secrets_in_clean_tree` 抓的是形状）；拼接结果不变。
  "sk-" + "CANDIDATE_MARKER_0123456789abcdef",
  "/home/alice/.lyapunov-dev/private/model.onnx",
  "nextSteps: invoke internal billing continuation",
  "https://api.vorynel.com/private",
]
const argumentsText = JSON.stringify({
  token: MARKERS[0], path: MARKERS[1], nextSteps: MARKERS[2], endpoint: MARKERS[3], label: "public",
})
const callId = ToolCallId("candidate-call")
const attemptId = LlmAttemptId("candidate-attempt")
const callBlock: ContentBlock = { type: "tool-call", id: callId, name: "inspect", arguments: argumentsText }
const chunks: StreamChunk[] = [
  { type: "block-start", index: 0, blockType: "tool-call" },
  { type: "tool-call-delta", index: 0, id: callId, name: "inspect", argumentsDelta: argumentsText.slice(0, 31) },
  { type: "tool-call-delta", index: 0, id: callId, argumentsDelta: argumentsText.slice(31) },
  { type: "block-end", index: 0, block: callBlock },
  { type: "text-delta", index: 1, text: "public answer" },
  { type: "text-delta", index: 1, text: " continues" },
  { type: "reasoning-delta", index: 2, text: "public reasoning" },
  { type: "reasoning-delta", index: 2, text: " continues" },
  { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } },
  { type: "finish", reason: { kind: "stop" } },
]

interface History {
  page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage>
  follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame>
}
interface NativeProjectors {
  event(event: SessionEvent): SessionEvent
  block(chunk: StreamChunk): StreamChunk
  stream(records: readonly AssistantStreamRecord[]): readonly AssistantStreamRecord[]
}
let Controller: new (ctx: Context, promote: () => void) => History
let projectorsFor: (ctx: Context) => NativeProjectors
let scratch: string | undefined

function run(command: string, args: string[], cwd = root): string {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" },
  })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")}\n${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

beforeAll(async () => {
  scratch = mkdtempSync(join(root, ".tmp-host-projection-candidate-"))
  const files = [
    `${packagePath}/src/types.ts`,
    `${packagePath}/src/assistant-stream.ts`,
    `${packagePath}/src/history.ts`,
    `${packagePath}/src/outbound-projection.ts`,
    `${packagePath}/tsconfig.host.json`,
  ]
  for (const file of files) {
    const target = join(scratch, file)
    mkdirSync(dirname(target), { recursive: true })
    if (!file.endsWith("/outbound-projection.ts")) writeFileSync(target, run("git", ["show", `${pinned}:${file}`], upstream))
  }
  run("git", ["init", "--quiet", scratch])
  run("git", ["apply", "--check", patchPath], scratch)
  run("git", ["apply", patchPath], scratch)
  symlinkSync(join(upstream, "node_modules"), join(scratch, "node_modules"), "dir")
  symlinkSync(join(upstream, packagePath, "node_modules"), join(scratch, packagePath, "node_modules"), "dir")
  const host = JSON.parse(readFileSync(join(scratch, packagePath, "tsconfig.host.json"), "utf8")) as { files: string[] }
  expect(host.files).toContain("src/outbound-projection.ts")
  const compileFiles = ["src/types.ts", "src/history.ts", "src/outbound-projection.ts", "src/assistant-stream.ts"]
  const base = ts.parseConfigFileTextToJson("tsconfig.base.json", run("git", ["show", `${pinned}:tsconfig.base.json`], upstream))
  if (base.error) throw new Error(ts.flattenDiagnosticMessageText(base.error.messageText, "\n"))
  const paths = Object.fromEntries(Object.entries(base.config.compilerOptions.paths as Record<string, string[]>).map(([key, values]) => [
    key, values.map(value => resolve(upstream, value.replace(/\/src(?=\/|$)/, "/lib/types").replace(/\.ts$/, ".d.ts"))),
  ]))
  const outDir = join(scratch, "compiled")
  writeFileSync(join(scratch, "tsconfig.compile.json"), JSON.stringify({
    compilerOptions: {
      ...base.config.compilerOptions, paths, rootDir: join(scratch, packagePath, "src"), outDir,
      tsBuildInfoFile: join(scratch, "tsconfig.compile.tsbuildinfo"), noEmitOnError: true,
    },
    files: compileFiles.map(file => join(scratch!, packagePath, file)),
  }))
  run(process.execPath, ["--no-env-file", join(root, "node_modules/typescript/bin/tsc"), "-p", join(scratch, "tsconfig.compile.json"), "--pretty", "false"])
  for (const name of ["history.js", "outbound-projection.js", "assistant-stream.js"]) expect(existsSync(join(outDir, name))).toBe(true)
  Controller = (await import(pathToFileURL(join(outDir, "history.js")).href)).SessionHistoryController
  projectorsFor = (await import(pathToFileURL(join(outDir, "outbound-projection.js")).href)).sessionOutboundProjection
}, 120_000)

afterAll(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
})

class Query extends SessionQueryEngine {
  override searchSessions(): Promise<never> { return Promise.reject(new Error("search is outside this test")) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error("search is outside this test")) }
}
function packed(): AssistantStreamRecord[] {
  const accumulator = new AssistantStreamAccumulator()
  chunks.forEach((chunk, index) => accumulator.push({ time: 100 + index * 7, chunk }))
  return structuredClone(accumulator.snapshot()) as AssistantStreamRecord[]
}
function envelope(event: object): object {
  const { data: _data, ...metadata } = event as SessionEvent
  return metadata
}
function expectNoMarkers(value: unknown): void {
  for (const marker of MARKERS) expect(JSON.stringify(value)).not.toContain(marker)
}
function appendCall(session: Session): SessionEvent {
  return session.append("tool/call", { turn: 3, step: 4, callId, name: "inspect", arguments: argumentsText })
}
function appendAssistant(session: Session): SessionEvent {
  return session.append("assistant/message", {
    turn: 3, step: 4, stream: packed(),
    message: createMessage({ role: "assistant", content: [callBlock], source: { kind: "model", provider: "p", model: "m" } }),
  }, { surfaceOp: "append" })
}
async function install(ctx: Context, service: unknown) {
  const fiber = ctx.plugin({
    name: "candidate-projection-provider",
    apply(inner: Context) { inner.effect(() => inner.provide(serviceName, service), "candidate-projection-provider") },
  })
  await fiber
  expect(ctx.get(serviceName)).toBe(service)
  return fiber
}
function tagged(tag: string): SessionOutboundProjection {
  return {
    projectEvent: event => ({ ...(event as SessionEvent), data: { tag } }),
    projectBlock: value => {
      const block = value as Record<string, unknown>
      return {
        ...block,
        ...typeof block.arguments === "string" ? { arguments: tag } : {},
        ...typeof block.text === "string" ? { text: tag } : {},
      }
    },
  }
}
async function next(iterator: AsyncIterator<SessionFollowFrame>): Promise<SessionFollowFrame> {
  const result = await iterator.next()
  if (result.done) throw new Error("follow ended before the expected frame")
  return result.value
}
async function harness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  new SessionProjectionRegistry(ctx)
  new Query(ctx)
  const session = ctx.sessions.create(undefined, { meta: { cwd: "/workspace" } })
  const history = new Controller(ctx, () => { throw new Error("live Session must not promote") })
  const agent = { id: session.id, session, ctx, status: "running" } as Agent
  const emit = (frame: AssistantStreamFrame) => ctx.emit("agent/assistant-stream", { agent, frame })
  const address = { kind: "session" as const, sessionId: session.id }
  const page = (options: Partial<SessionPageRequest> = {}) => history.page({ address, throughSeq: session.seq - 1, ...options }, new AbortController().signal)
  const followers: { abort: AbortController; iterator: AsyncIterator<SessionFollowFrame> }[] = []
  async function follow() {
    const abort = new AbortController()
    const iterator = history.follow({ address, assistantStream: true }, abort.signal)[Symbol.asyncIterator]()
    followers.push({ abort, iterator })
    const snapshot = await next(iterator)
    if (snapshot.type !== "snapshot") throw new Error("opening frame must be a snapshot")
    return { snapshot, iterator, abort }
  }
  function start() {
    emit({ type: "start", attemptId, revision: 1, turn: 3, step: 4 })
    chunks.forEach((chunk, index) => emit({ type: "chunk", attemptId, revision: index + 2, index, time: 100 + index * 7, chunk }))
  }
  async function dispose() {
    for (const follower of followers) { follower.abort.abort(); await follower.iterator.return?.() }
    await ctx.fiber.dispose()
  }
  return { ctx, session, history, agent, emit, start, page, follow, dispose }
}

describe("native outbound projection candidate", () => {
  test("projects page, opening follow, durable live events and embedded streams without changing Session truth", async () => {
    const h = await harness()
    try {
      appendCall(h.session)
      appendAssistant(h.session)
      h.session.append("assistant/attempt", { turn: 3, step: 4, stream: packed() })
      const before = structuredClone(h.session.snapshotEvents())
      const modelBefore = structuredClone(h.session.deriveMessages())
      await install(h.ctx, createSessionOutboundProjection("formal"))
      const page = await h.page()
      expectNoMarkers(page)
      expect(page.records.map(record => envelope(record.event))).toEqual(before.map(envelope))
      expect(page.hasMore).toBe(false)
      const { snapshot, iterator } = await h.follow()
      expect(snapshot.cursor).toBe(h.session.seq - 1)
      expect(snapshot.records).toEqual(page.records)
      expectNoMarkers(snapshot)
      const event = appendCall(h.session)
      const frame = await next(iterator)
      expect(frame.type).toBe("event")
      if (frame.type === "event") expect(envelope(frame.event)).toEqual(envelope(event))
      expectNoMarkers(frame)
      expect(h.session.snapshotEvents().slice(0, before.length)).toEqual([...before])
      expect(h.session.deriveMessages()).toEqual(modelBefore)
      using observation = await h.ctx.sessionQuery.observeSession(h.session.id)
      for (const marker of MARKERS) expect(JSON.stringify(observation.events)).toContain(marker)
    } finally { await h.dispose() }
  })

  test("projects live chunks and packed reconnect records while preserving every time, index and revision", async () => {
    const h = await harness()
    try {
      await install(h.ctx, createSessionOutboundProjection("formal"))
      const { iterator } = await h.follow()
      const source = structuredClone(chunks)
      h.start()
      expect(await next(iterator)).toEqual({ type: "assistant-stream", frame: { type: "start", attemptId, revision: 1, turn: 3, step: 4, startedAfterSeq: -1 } })
      for (let index = 0; index < chunks.length; index++) {
        const frame = await next(iterator)
        expect(frame).toMatchObject({ type: "assistant-stream", frame: { type: "chunk", attemptId, revision: index + 2, index, time: 100 + index * 7 } })
        expectNoMarkers(frame)
      }
      const { snapshot } = await h.follow()
      expect(snapshot.assistantStream?.revision).toBe(chunks.length + 1)
      const attempt = snapshot.assistantStream?.activeAttempt
      expect(attempt).toMatchObject({ attemptId, startedAfterSeq: -1, turn: 3, step: 4, nextIndex: chunks.length })
      expectNoMarkers(attempt)
      const records = attempt!.stream as unknown as AssistantStreamRecord[]
      expect(records.map(record => record.type)).toEqual(packed().map(record => record.type))
      const expanded = expandAssistantStream(records)
      expect(expanded.map(value => value.time)).toEqual(chunks.map((_, index) => 100 + index * 7))
      expect(expanded.map(value => {
        const { block: _block, text: _text, argumentsDelta: _arguments, ...metadata } = value.chunk as StreamChunk & { block?: unknown; text?: string; argumentsDelta?: string }
        return metadata
      })).toEqual(chunks.map(chunk => {
        const { block: _block, text: _text, argumentsDelta: _arguments, ...metadata } = chunk as StreamChunk & { block?: unknown; text?: string; argumentsDelta?: string }
        return metadata
      }))
      expect(chunks).toEqual(source)
    } finally { await h.dispose() }
  })

  test("fails closed before provider load and recovers on the same controller after late registration", async () => {
    const h = await harness()
    try {
      appendCall(h.session)
      h.start()
      const before = structuredClone(h.session.snapshotEvents())
      await expect(h.page()).rejects.toThrow(missingProvider)
      await expect(h.follow()).rejects.toThrow(missingProvider)
      await install(h.ctx, createSessionOutboundProjection("formal"))
      expectNoMarkers(await h.page())
      expectNoMarkers((await h.follow()).snapshot)
      expect(h.session.snapshotEvents()).toEqual(before)
    } finally { await h.dispose() }
  })

  test("replaces the provider for queued durable events, live chunks and cached reconnect baselines", async () => {
    const h = await harness()
    try {
      appendCall(h.session)
      const first = await install(h.ctx, tagged("first"))
      h.start()
      const { snapshot, iterator } = await h.follow()
      expect(JSON.stringify(snapshot)).toContain("first")
      appendCall(h.session)
      h.emit({ type: "chunk", attemptId, revision: chunks.length + 2, index: chunks.length, time: 300, chunk: chunks[1]! })
      await first.dispose()
      expect(h.ctx.get(serviceName)).toBeUndefined()
      await install(h.ctx, tagged("replacement"))
      for (let i = 0; i < 2; i++) {
        const frame = await next(iterator)
        expect(JSON.stringify(frame)).toContain("replacement")
        expect(JSON.stringify(frame)).not.toContain("first")
        expectNoMarkers(frame)
      }
      const replacement = (await h.follow()).snapshot
      expect(JSON.stringify(replacement)).toContain("replacement")
      expect(JSON.stringify(replacement)).not.toContain("first")
      expectNoMarkers(replacement)
      expect(JSON.stringify(await h.page())).toContain("replacement")
    } finally { await h.dispose() }
  })

  test("disposal rejects queued live outputs and new reads instead of releasing native values", async () => {
    const h = await harness()
    try {
      const provider = await install(h.ctx, createSessionOutboundProjection("formal"))
      appendCall(h.session)
      h.start()
      const events = await h.follow()
      const live = await h.follow()
      h.emit({ type: "chunk", attemptId, revision: chunks.length + 2, index: chunks.length, time: 300, chunk: chunks[1]! })
      await next(events.iterator)
      appendCall(h.session)
      await provider.dispose()
      expect(h.ctx.get(serviceName)).toBeUndefined()
      await expect(next(events.iterator)).rejects.toThrow(missingProvider)
      await expect(next(live.iterator)).rejects.toThrow(missingProvider)
      await expect(h.page()).rejects.toThrow(missingProvider)
      await expect(h.follow()).rejects.toThrow(missingProvider)
      await install(h.ctx, createSessionOutboundProjection("formal"))
      expectNoMarkers((await h.follow()).snapshot)
    } finally { await h.dispose() }
  })

  test("rejects incomplete providers and provider exceptions on real native reads", async () => {
    const h = await harness()
    try {
      const event = appendCall(h.session)
      const projectors = projectorsFor(h.ctx)
      for (const provider of [{}, { projectEvent: (value: unknown) => value }, { projectBlock: (value: unknown) => value }]) {
        const fiber = await install(h.ctx, provider)
        await expect(h.page()).rejects.toThrow(missingProvider)
        await expect(h.follow()).rejects.toThrow(missingProvider)
        expect(() => projectors.event(event)).toThrow(missingProvider)
        expect(() => projectors.block(chunks[1]!)).toThrow(missingProvider)
        expect(() => projectors.stream(packed())).toThrow(missingProvider)
        await fiber.dispose()
      }
      await install(h.ctx, {
        projectEvent() { throw new Error("candidate projector failed") },
        projectBlock() { throw new Error("candidate projector failed") },
      })
      await expect(h.page()).rejects.toThrow("candidate projector failed")
      await expect(h.follow()).rejects.toThrow("candidate projector failed")
      expect(() => projectors.block(chunks[1]!)).toThrow("candidate projector failed")
      expect(() => projectors.stream(packed())).toThrow("candidate projector failed")
      for (const marker of MARKERS) expect(JSON.stringify(h.session.snapshotEvents())).toContain(marker)
    } finally { await h.dispose() }
  })

  test("detaches projector inputs and preserves envelopes, pagination cuts and model values", async () => {
    const h = await harness()
    try {
      const source = h.session.append("user/message", createUserMessage({ content: [{ type: "text", text: "first" }], source: { kind: "user" } }), { surfaceOp: "append" })
      h.session.append("user/message", createUserMessage({ content: [{ type: "text", text: argumentsText }], source: { kind: "user" } }), {
        surfaceOp: { op: "replace", startSeq: source.seq, endSeq: source.seq }, sourceEventSeqs: [source.seq],
      })
      const seed = structuredClone(h.session.snapshotEvents())
      seed[1]!.ignorable = true
      const restored = h.ctx.sessions.create(undefined, { seed, meta: { cwd: "/workspace" } })
      const before = structuredClone(restored.snapshotEvents())
      await install(h.ctx, {
        projectEvent(value: unknown) {
          const event = value as Record<string, unknown>
          event.type = "changed"; event.seq = 999; event.time = 0
          event.sourceEventSeqs = []; event.surfaceOp = "append"; delete event.ignorable
          event.data = { public: true }
          return event
        },
        projectBlock(value: unknown) { return value },
      })
      const page = await h.history.page({ address: { kind: "session", sessionId: restored.id }, throughSeq: restored.seq - 1 }, new AbortController().signal)
      expect(page.records.map(record => envelope(record.event))).toEqual(before.map(envelope))
      expect(page.records.every(record => JSON.stringify(record.event.data) === '{"public":true}')).toBe(true)
      expect(restored.snapshotEvents()).toEqual(before)
      h.session.append("user/message", createUserMessage({ content: [{ type: "text", text: "second" }], source: { kind: "user" } }), { surfaceOp: "append" })
      const pageOne = await h.page({ maxMessages: 1 })
      expect(pageOne.hasMore).toBe(true)
      expect(pageOne.records.map(record => record.event.seq)).toEqual([2])
      const older = await h.page({ beforeSeq: 2, maxMessages: 1 })
      expect(older.records.map(record => record.event.seq)).toEqual([0, 1])
      expect(older.hasMore).toBe(false)
    } finally { await h.dispose() }
  })

  test("retains mixed FIFO ordering, terminal frames, cancellation and Agent disposal behavior", async () => {
    const h = await harness()
    try {
      await install(h.ctx, createSessionOutboundProjection("formal"))
      const { iterator, abort } = await h.follow()
      h.emit({ type: "start", attemptId, revision: 1, turn: 3, step: 4 })
      h.emit({ type: "chunk", attemptId, revision: 2, index: 0, time: 100, chunk: chunks[1]! })
      const event = appendAssistant(h.session)
      const end: AssistantStreamFrame = { type: "end", attemptId, revision: 3, index: 1, outcome: { kind: "committed", eventType: "assistant/message", seq: event.seq } }
      h.emit(end)
      const frames = [await next(iterator), await next(iterator), await next(iterator), await next(iterator)]
      expect(frames.map(frame => frame.type)).toEqual(["assistant-stream", "assistant-stream", "event", "assistant-stream"])
      expect(frames[3]).toEqual({ type: "assistant-stream", frame: end })
      frames.forEach(expectNoMarkers)
      h.ctx.emit("agent/disposed", { agent: h.agent })
      expect((await h.follow()).snapshot.assistantStream).toEqual({ revision: 0 })
      abort.abort()
      expect((await iterator.next()).done).toBe(true)
    } finally { await h.dispose() }
  })

  test("keeps the candidate unregistered and declares its new Host source without a compiler suppression", () => {
    expect(readFileSync(join(root, "script/upstream-patches.mjs"), "utf8")).not.toContain("dsh-session-outbound-projection.patch")
    const patch = readFileSync(patchPath, "utf8")
    expect(patch).toContain("ctx.get(SESSION_OUTBOUND_PROJECTION)")
    expect(patch).not.toContain("ctx.get(SESSION_OUTBOUND_PROJECTION, false)")
    expect(patch).not.toContain("@ts-ignore")
    expect(patch).not.toContain("@ts-expect-error")
    expect(patch).toContain('"src/outbound-projection.ts"')
  })
})
