import { describe, expect, test } from "bun:test"
import { AttachmentId } from "@deepseek-ai/dsh-attachment"
import { Context } from "@deepseek-ai/cordis"
import Timer from "@deepseek-ai/cordis-plugin-timer"
import AttachmentLocal from "@deepseek-ai/dsh-attachment-local"
import AgentLoop from "@deepseek-ai/dsh-agent-loop"
import { mountAgentLoopTestDependencies } from "@deepseek-ai/dsh-agent-loop-testkit"
import { SessionId } from "@deepseek-ai/dsh-session"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MockAdapter, textResponse } from "../../../.upstream/deepseek-harness-20260911-candidate/packages/core/agent-loop/tests/mock-adapter.ts"
import { toPiContext } from "../../../.upstream/deepseek-harness-20260911-candidate/packages/llm/llm-pi-ai/src/context.ts"
import { isolateProviderInstaller } from "./fixtures/isolated-provider-installer.ts"
import { sessionNamespace } from "../../lyapunov-contracts/src/session-scope.ts"
import { defaultPreferences } from "../src/preferences.ts"
import { captureFeedbackContent, capturePins, requireCaptureFeedbackOwner, type FeedbackCapture } from "../src/capture-content.ts"

const attachment = { attachmentId: AttachmentId("sha256:" + "a".repeat(64)), mediaType: "image/png" as const, bytes: 128, width: 800, height: 600 }
const base: FeedbackCapture = {
  captureId: "capture-1", sessionKey: "session-a", clientId: "window-a", sceneId: "scene-a", sceneRevision: 3,
  capturedAt: "2026-09-29T00:00:00.000Z", imagePath: "/not-used-by-message", attachment,
  originalImage: { path: "/not-used-by-message", bytes: 512, width: 1600, height: 1200, mediaType: "image/png", storage: "verbatim", attachmentId: attachment.attachmentId },
  camera: { position: [1, 2, 3], quaternion: [0, 0, 0, 1], fov_y: 45 },
  annotations: [{ index: 1, annotationId: "pin-1", sceneId: "scene-a", entityId: "entity-a", text: "缺少门", anchor: { entityId: "entity-a", local: [0.1, 0.2, 0.3], world: [1, 2, 3] } }],
  prompt: "请检查第 1 条批注",
  worldId: "world-a", generation: 2, worldSceneRevision: 3, frameSceneRevision: 3, frameId: "frame-1", stepIndex: 4, simTime: 0.4,
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAY0lEQVR42g3JoREAMQgAQSwSbBwTG8UMFkMLmOu/kP+1KyKo4MIRrvCEEloQMdRw4xjXeEYZbX8EGnhwghu8oIKOPxJNPDnJTV5SSecfgw4+nOEOb6ih549FF1/Ocpe31NLLB/VHHsGuXpwoAAAAAElFTkSuQmCC", "base64")

// Shell commands and scene/window inputs use thin fixtures; Inbox, attachment admission and request conversion are native.
async function boot() {
  const root = await mkdtemp(join(tmpdir(), "viewer-feedback-"))
  const ctx = new Context()
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const handlers = new Map<string, { handler: (invocation: any) => Promise<any> }>()
  const snapshot = { sceneId: "scene-a", revision: 3, entities: [{ entityId: "entity-a", name: "door" }] }
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Timer)
    await ctx.plugin(AttachmentLocal, { dshHome: join(root, "dsh") })
    const adapter = new MockAdapter(Array.from({ length: 10 }, () => textResponse("received")))
    ctx.llm.registerAdapter(["mock"], adapter)
    const agent = await ctx.agentLoop.create(SessionId("session-a"), { provider: "mock", model: "mock" }, { cwd: root })
    const other = await ctx.agentLoop.create(SessionId("session-b"), { provider: "mock", model: "mock" }, { cwd: root })
    // These host services are outside the feedback slice; their fixtures do not implement image or inbox logic.
    ctx.provide("connection", { fetch: { register: (entry: { path: string; fetch: (request: Request) => Promise<Response> }) => { routes.set(entry.path, entry.fetch); return () => routes.delete(entry.path) } } } as never)
    const namespaces = new Set<string>()
    ctx.provide("settings", { register: (ns: string) => { namespaces.add(ns); return () => namespaces.delete(ns) }, describe: () => [...namespaces].map(ns => ({ ns, user: undefined, revision: 1, value: { ...defaultPreferences } })), mutate: async () => undefined, replace: async () => undefined } as never)
    // 无缺源引用的薄夹具沿新版repair/complete读场景；不伪造资源迁移/改revision。
    ctx.provide("scene", { forSession: () => ({ repairResourceSources: async (sceneId:string) => { expect(sceneId).toBe(snapshot.sceneId);return {...snapshot} }, completeResourceSources: async (scene:typeof snapshot)=>scene, scene: { snapshot: async () => ({ ...snapshot }) }, list: async () => [{ sceneId: snapshot.sceneId }] }) } as never)
    ctx.provide("commands", { register: (entry: { name: string; handler: (invocation: any) => Promise<any> }) => { handlers.set(entry.name, entry); return () => handlers.delete(entry.name) } } as never)
    ctx.provide("sessionController", { resolveAgent: async (id: unknown) => ({ agent: String(id) === "session-a" ? agent : other }) } as never)
    ctx.provide("sessionQuery", { observeSession: async () => undefined } as never)
    ctx.provide("jobs", { attachController: () => () => {} } as never)
    ctx.provide("subprocess", {} as never)
    const installer = isolateProviderInstaller(root)
    try { const { apply } = await import("../src/plugin.ts"); await apply(ctx, { captureRoot: join(root, "captures") }); installer.assertCalled() }
    finally { installer.restore() }
    const presence = async (sessionId = "session-a", clientId = "window-a", revision = snapshot.revision) => {
      const response = await routes.get("/api/lyapunov/state")!(new Request(`http://fixture/api/lyapunov/state?sessionId=${sessionId}&clientId=${clientId}&displaySceneId=scene-a&displayRevision=${revision}`))
      expect(response.ok).toBe(true)
    }
    await presence()
    const command = async (name: string, input: unknown, caller = agent, signal = new AbortController().signal) => {
      const result = await handlers.get(name)!.handler({ agent: caller, rawInput: JSON.stringify(input), signal })
      return JSON.parse(result.text)
    }
    const payload = { sessionId: "session-a", sceneId: "scene-a", sceneRevision: 3, clientId: "window-a", dataURL: `data:image/png;base64,${PNG.toString("base64")}`, camera: base.camera, prompt: base.prompt, annotations: base.annotations, pins: [{ annotationId: "pin-1", index: 1, text: "缺少门", entityId: "entity-a", point: [2, 3], normalized: [0.25, 0.5], local: [0.1, 0.2, 0.3], world: [1, 2, 3] }] }
    return { ctx, root, agent, other, adapter, snapshot, presence, command, payload, close: async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) } }
  } catch (error) { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); throw error }
}

describe("viewer feedback content", () => {
  test("capture inject reaches the native Inbox and the next pi-ai request as actual PNG bytes", async () => {
    const host = await boot()
    try {
      const saved = await host.command("viewer_capture", { ...host.payload, inject: true })
      expect(saved.injectionError).toBeUndefined()
      expect(saved.injectedSession).toBe("session-a")
      await host.agent.whenIdle()
      expect(host.adapter.requests).toHaveLength(1)
      const message = host.adapter.requests[0]!.messages.find(row => row.id === saved.injectedMessageId)!
      expect(message.content.some(block => block.type === "image")).toBe(true)
      const spliced = host.agent.session.snapshotEvents().find(event => event.type === "agent/inbox/spliced" && event.data.inserted.some(row => row.id === saved.injectedMessageId))
      expect(spliced?.type).toBe("agent/inbox/spliced")
      expect(host.other.session.snapshotEvents().some(event => event.type === "agent/inbox/spliced")).toBe(false)
      const converted = await toPiContext({ ...host.adapter.requests[0]!, messages: [message] }, { attachments: host.ctx.attachments, resolveImageAccess: () => undefined })
      const user = converted.messages[0]!
      expect(user.role).toBe("user")
      const content = user.content as Array<{ type: string; data?: string; text?: string }>
      expect(Buffer.from(content.find(block => block.type === "image")!.data!, "base64")).toEqual(PNG)
      expect(content.map(block => block.text ?? "").join("\n")).toContain('"point":[2,3]')
      expect(content.map(block => block.text ?? "").join("\n")).toContain('"sceneRevision":3')
      expect(content.map(block => block.text ?? "").join("\n")).toContain('"quaternion":[0,0,0,1]')
      await expect(toPiContext({ ...host.adapter.requests[0]!, messages: [message] }, { attachments: host.ctx.attachments, resolveImageAccess: () => undefined, maxRequestImageBytes: 1 })).rejects.toMatchObject({ code: "IMAGE_OFFLOAD_REQUIRED" })
      expect(() => toPiContext({ ...host.adapter.requests[0]!, messages: [message] })).toThrow("durable attachment service")
    } finally { await host.close() }
  })

  test("annotation send reuses the saved frame and rejects text/image, session, window and revision mismatches", async () => {
    const host = await boot()
    try {
      const saved = await host.command("viewer_capture", host.payload)
      const input = { sessionId: "session-a", clientId: "window-a", captureId: saved.captureId }
      const sent = await host.command("viewer_annotation_send_ui", input)
      await host.agent.whenIdle()
      expect(sent.injected).toBe(true)
      expect(host.adapter.requests[0]!.messages.find(row => row.id === sent.messageId)?.content.find(block => block.type === "image")).toEqual({ type: "image", attachment: saved.attachment })
      await expect(host.command("viewer_annotation_send_ui", { ...input, prompt: "different annotation" })).rejects.toThrow("ANNOTATION_PROMPT_MISMATCH")
      await expect(host.command("viewer_annotation_send_ui", { ...input, sessionId: "session-b" })).rejects.toThrow("ANNOTATION_SESSION_MISMATCH")
      await expect(host.command("viewer_annotation_send_ui", { ...input, clientId: "window-b" })).rejects.toThrow("CAPTURE_FEEDBACK_WINDOW_MISMATCH")
      await expect(host.command("viewer_annotation_send_ui", { ...input, sessionId: "session-b" }, host.other)).rejects.toThrow()
      await expect(host.command("viewer_annotation_send_ui", { sessionId: "session-a", prompt: "text only" })).rejects.toThrow("ANNOTATION_CAPTURE_REQUIRED")
      host.snapshot.revision = 4
      await expect(host.command("viewer_annotation_send_ui", input)).rejects.toThrow("CAPTURE_FEEDBACK_SCENE_STALE")
      expect(host.adapter.requests).toHaveLength(1)
    } finally { await host.close() }
  })

  test("capture without explicit window uses only a unique live target; failed injection is saved as a fact", async () => {
    const host = await boot()
    try {
      const saved = await host.command("viewer_capture", { ...host.payload, clientId: undefined, inject: true })
      await host.agent.whenIdle()
      expect(saved.clientId).toBe("window-a")
      expect(saved.injectedMessageId).toBeString()
      await host.presence("session-a", "window-b")
      const ambiguous = await host.command("viewer_capture", { ...host.payload, clientId: undefined, inject: true })
      expect(ambiguous.injectedMessageId).toBeUndefined()
      expect(ambiguous.injectionError).toContain("VIEWER_OBSERVE_TARGET_AMBIGUOUS")
      const record = JSON.parse(await readFile(join(sessionNamespace(join(host.root, "captures"), "session-a"), ambiguous.captureId + ".json"), "utf8"))
      expect(record.injectionError).toBe(ambiguous.injectionError)
      expect(host.adapter.requests).toHaveLength(1)
    } finally { await host.close() }
  })

  test("cancelled sends and mismatched capture injection targets do not wake an agent", async () => {
    const host = await boot()
    try {
      const cancelled = new AbortController(); cancelled.abort(new Error("FEEDBACK_CANCELLED"))
      const saved = await host.command("viewer_capture", { ...host.payload, inject: true }, host.agent, cancelled.signal)
      expect(saved.injectionError).toContain("FEEDBACK_CANCELLED")
      const foreign = await host.command("viewer_capture", { ...host.payload, sessionId: "session-b", inject: true })
      expect(foreign.injectionError).toContain("CAPTURE_INJECT_SESSION_MISMATCH")
      expect(host.adapter.requests).toHaveLength(0)
    } finally { await host.close() }
  })

  test("keeps image, text, coordinates, camera and scene provenance in one native message", () => {
    const pins = capturePins([{ annotationId: "pin-1", index: 1, text: "缺少门", entityId: "entity-a", point: [400, 300], normalized: [0.25, 0.25], local: [0.1, 0.2, 0.3], world: [1, 2, 3] }], base)
    const blocks = captureFeedbackContent({ ...base, pins })
    expect(blocks.map(block => block.type)).toEqual(["text", "image"])
    const text = blocks[0]
    expect(text.type).toBe("text")
    if (text.type !== "text") throw new Error("TEXT_BLOCK_EXPECTED")
    expect(text.text).toContain("capture-1")
    expect(text.text).toContain("缺少门")
    expect(text.text).toContain("sceneRevision")
    expect(text.text).toContain("1600")
    expect(blocks[1]).toEqual({ type: "image", attachment })
  })

  test("rejects pins whose pixels or annotations are not from the saved frame", () => {
    expect(() => capturePins([{ annotationId: "pin-1", index: 1, text: "伪造", entityId: "entity-a", point: [400, 300], normalized: [0.25, 0.25], local: [0.1, 0.2, 0.3], world: [1, 2, 3] }], base)).toThrow("CAPTURE_PIN_ANNOTATION_MISMATCH")
    expect(() => capturePins([{ annotationId: "pin-1", index: 1, text: "缺少门", entityId: "entity-a", point: [1601, 300], normalized: [0.25, 0.25], local: [0.1, 0.2, 0.3], world: [1, 2, 3] }], base)).toThrow("CAPTURE_PIN_PIXEL_MISMATCH")
  })

  test("rejects a foreign session, window or revision before sending", () => {
    expect(() => requireCaptureFeedbackOwner(base, { sessionKey: "session-b", clientId: "window-a", sceneId: "scene-a", revision: 3 })).toThrow("CAPTURE_FEEDBACK_SESSION_MISMATCH")
    expect(() => requireCaptureFeedbackOwner(base, { sessionKey: "session-a", clientId: "window-b", sceneId: "scene-a", revision: 3 })).toThrow("CAPTURE_FEEDBACK_WINDOW_MISMATCH")
    expect(() => requireCaptureFeedbackOwner(base, { sessionKey: "session-a", clientId: "window-a", sceneId: "scene-a", revision: 4 })).toThrow("CAPTURE_FEEDBACK_SCENE_STALE")
  })
})
