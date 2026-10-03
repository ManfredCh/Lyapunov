/**
 * DEV-004：同 session 多窗口的**选择事实**与 **UI 动作目标**归属。
 *
 * 修前事实（plugin.ts）：`selections` 是每个会话**一份**记录（原 L130），`sequence` 的单调边界只在
 * “同一个 clientId”时才生效；别的窗口一写就把这份记录换成它自己的（`selections.set(scope,…)`）。模型上下文
 * （`systemPrompt` 的 `lyapunov-scene-selection` 段）读的就是这一份，于是 A 窗口的选择被 B 窗口覆盖。
 * UI 动作队列按会话键（原 L135）保存且**条目没有目标窗口**，state 路由把整条队列投给每个窗口，
 * 谁先轮询谁执行——两个窗口会抢同一条动作。
 *
 * 本文件钉住修复后的归属规则（跑的是真实 `plugin.ts` 的注册面）：
 *   ① 选择事实按 clientId 各存一份：两窗口各选不同实体互不覆盖，`sequence` 只约束自己那一份；
 *   ② 模型上下文只跟**活动窗口**（最近一次写入事实的窗口），不把两个窗口的事实混在一起；
 *   ③ world 生命周期结果只写回**发起命令的那个窗口**的选择槽；
 *   ④ 定向 UI 动作只投递给目标窗口，别的窗口确认也不出队；省略目标时目标＝活动窗口。
 *
 * 边界：这是宿主侧的进程内行为测试（真实 cordis + 最薄服务替身，与 `environment-routing.test.ts` 同一手法），
 * **不是**真实浏览器验收；“两个真实窗口里各点一次是不是真的互不干扰”由 `.runtime/cu` 的双窗口 computer-use 证据负责。
 */
import { describe, expect, test } from "bun:test"
import { Context } from "@deepseek-ai/cordis"
import JobsLocal from "@deepseek-ai/dsh-jobs-local"
import { createScope, scopeOf, type ScopeKey } from "@deepseek-ai/dsh-scope"
import { SessionId } from "@deepseek-ai/dsh-session"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isolateProviderInstaller } from "./fixtures/isolated-provider-installer.ts"

const SESSION = "session-dev004"
const SCENE_A = "scene-alpha"
const SCENE_B = "scene-beta"
const WINDOW_A = "window-a"
const WINDOW_B = "window-b"

interface StubScene { sceneId: string; revision: number; entities: Array<{ entityId: string; name: string }> }
type UiActionRow = { id: string; action: string; args: Record<string, unknown> }
type StateBody = { selection?: { clientId: string; facts: Record<string, unknown> }; uiActions?: UiActionRow[] }

/** 最薄宿主：真实 cordis + 真实 scope；只装配插件真正会碰到的服务面（替身不复制领域语义）。 */
async function boot() {
  const root = await mkdtemp(join(tmpdir(), "lyapunov-target-window-"))
  const ctx = new Context() as any
  // Provider installer registration attaches a native Jobs controller; no installer job is started here.
  await ctx.plugin(JobsLocal)
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const prompts: Array<{ name: string; text: (args: { scope?: ScopeKey }) => string }> = []
  const tools = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
  const commands = new Map<string, { handler: (invocation: any) => any }>()
  const scenes = new Map<string, Map<string, StubScene>>([
    [SESSION, new Map<string, StubScene>([
      [SCENE_A, { sceneId: SCENE_A, revision: 3, entities: [{ entityId: "entity-a1", name: "甲" }, { entityId: "entity-a2", name: "乙" }] }],
      [SCENE_B, { sceneId: SCENE_B, revision: 1, entities: [{ entityId: "entity-b1", name: "丙" }] }],
    ])],
  ])
  // 真实会话记录的最小形状：view-selection 会 append 一条 last-scene 书签，state 会读回事件流。
  const events: Array<{ type: string; data: Record<string, unknown> }> = []
  const agent = {
    id: SessionId(SESSION), ctx: undefined as unknown,
    steer() {}, inject() {},
    session: { id: SESSION, header: { id: SESSION }, append: (type: string, data: Record<string, unknown>) => { events.push({ type, data }) }, snapshotEvents: () => events },
  }
  const scope = createScope(ctx, { session: SESSION } as never).ctx
  agent.ctx = scope

  ctx.provide("connection", { fetch: { register: (entry: { path: string; fetch: (request: Request) => Promise<Response> }) => { routes.set(entry.path, entry.fetch); return () => routes.delete(entry.path) } } })
  // settings 替身按真实形状：`register` 进命名空间表，`describe` 读回它（preferences-host 依赖这条链）。
  const namespaces = new Set<string>()
  ctx.provide("settings", { register: (ns: string) => { namespaces.add(ns); return () => namespaces.delete(ns) }, describe: () => [...namespaces].map(ns => ({ ns, user: undefined, revision: 1, value: {} })), mutate: async () => undefined, replace: async () => undefined })
  ctx.provide("scene", { forSession: (key: string) => ({
    scene: { snapshot: async (sceneId: string) => { const found = scenes.get(key)?.get(sceneId); if (!found) throw new Error(`SCENE_NOT_FOUND: ${sceneId}`); return found } },
    repairResourceSources: async (sceneId:string)=>{const found=scenes.get(key)?.get(sceneId);if(!found)throw new Error(`SCENE_NOT_FOUND: ${sceneId}`);return found},
    completeResourceSources: async (scene:StubScene)=>scene,
    list: async () => [...(scenes.get(key)?.values() ?? [])].map(scene => ({ sceneId: scene.sceneId })),
    create: async () => { throw new Error("SCENE_CREATE_UNUSED") },
  }) })
  ctx.provide("agents", { get: (id: unknown) => String(id) === SESSION ? agent : undefined })
  ctx.provide("sessions", { flush: async () => undefined })
  ctx.provide("sessionController", { resolveAgent: async (id: unknown) => String(id) === SESSION ? { agent } : { error: new Error(`SESSION_NOT_FOUND: ${String(id)}`) } })
  ctx.provide("commands", {
    register: (definition: { name: string; handler: (invocation: any) => any }) => { commands.set(definition.name, definition); return () => commands.delete(definition.name) },
    execute: async (target: unknown, line: string, _attachments: unknown, signal: AbortSignal) => {
      const match = /^\/([a-zA-Z0-9_]+)([\s\S]*)$/.exec(line)
      const definition = match ? commands.get(match[1]!) : undefined
      if (!definition) return undefined
      try { return { commandId: "stub-1", result: await definition.handler({ commandId: "stub-1", agent: target, rawInput: match![2]!, attachments: [], signal }) } }
      catch (error) { return { commandId: "stub-1", result: { kind: "error", text: error instanceof Error ? error.message : String(error) } } }
    },
  })
  ctx.provide("systemPrompt", {
    section: (section: { name: string; text: string }) => { prompts.push({name: section.name, text: () => section.text}) },
    context: (section: { name: string; text: (args: { scope?: ScopeKey }) => string }) => { prompts.push(section) },
  })
  ctx.provide("tools", { register: (definition: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) }, get: (name: string) => tools.get(name) })
  ctx.provide("attachments", { saveImage: async () => ({}), readImage: async () => ({ data: new Uint8Array() }) })

  // sim 域命令由 Provider 插件注册；本测试只关心命令结果写回**哪个窗口**的选择槽，用最小替身。
  commands.set("sim_open", { handler: async () => ({ kind: "success", text: JSON.stringify({ worldId: "world-1", sceneId: SCENE_A, engineId: "stub", status: "ready", worldGeneration: 1, appliedSceneRevision: 3 }) }) })

  const dispose = async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } }
  const routerMode = process.env.LYAPUNOV_CONTEXT_ROUTER
  let installerIsolation: ReturnType<typeof isolateProviderInstaller> | undefined
  try {
    installerIsolation = isolateProviderInstaller(root)
    // These are rule-routing unit tests; never select an ambient model router.
    process.env.LYAPUNOV_CONTEXT_ROUTER = "rules"
    const { apply } = await import("../src/plugin.ts")
    await apply(ctx as never, { captureRoot: join(root, "captures"), recordingRoot: join(root, "recordings") } as never)
    installerIsolation.assertCalled()
  } catch (error) {
    await dispose()
    throw error
  } finally {
    installerIsolation?.restore()
    if (routerMode === undefined) delete process.env.LYAPUNOV_CONTEXT_ROUTER
    else process.env.LYAPUNOV_CONTEXT_ROUTER = routerMode
  }

  const route = (path: string) => {
    const handler = routes.get(`/api/lyapunov/${path}`)
    if (!handler) throw new Error(`ROUTE_NOT_REGISTERED: ${path}`)
    return handler
  }
  /** 一次 state 轮询：真实前端就是带 clientId + displaySceneId/displayRevision 来问的（顺带上报在场）。 */
  const state = async (clientId: string): Promise<StateBody> => {
    const query = new URLSearchParams({ sessionId: SESSION, clientId, displaySceneId: SCENE_A, displayRevision: "3" })
    const response = await route("state")(new Request(`http://test/api/lyapunov/state?${query.toString()}`))
    return await response.json() as StateBody
  }
  const select = async (clientId: string, body: Record<string, unknown>) => {
    const response = await route("view-selection")(new Request("http://test/api/lyapunov/view-selection", { method: "POST", body: JSON.stringify({ sessionId: SESSION, clientId, ...body }) }))
    const value = await response.json() as { updated?: boolean; facts?: Record<string, unknown>; error?: string }
    if (!response.ok) throw new Error(value.error ?? "VIEW_SELECTION_FAILED")
    return value
  }
  const sendCommand = async (name: string, input: unknown, selection?: Record<string, unknown>) => {
    const response = await route("command")(new Request("http://test/api/lyapunov/command", { method: "POST", body: JSON.stringify({ sessionId: SESSION, name, input, ...selection ? { selection } : {} }) }))
    // 出站只有两个消费者面：`text` = 人类公共面，`ui` = 机器面（工作台续链读的就是它）。
    const body = await response.json() as { kind?: string; text?: string; ui?: unknown; error?: string }
    if (body.kind !== "success") throw new Error(body.text ?? body.error ?? "COMMAND_FAILED")
    return (body.ui ?? null) as never
  }
  const runTool = async <T>(name: string, args: unknown): Promise<T> => {
    const definition = tools.get(name)
    if (!definition) throw new Error(`TOOL_NOT_REGISTERED: ${name}`)
    return await definition.execute(args, { agent }) as T
  }
  /** 真实的模型侧选择上下文文本（plugin 注册的那一段，按 scope 取值）。 */
  const modelContext = (): string => {
    const section = prompts.find(item => item.name === "lyapunov-scene-selection")
    if (!section) throw new Error("SCENE_SELECTION_PROMPT_MISSING")
    return section.text({ scope: scopeOf(scope) })
  }
  return { state, select, sendCommand, runTool, modelContext, dispose }
}

describe("DEV-004 多窗口：选择事实按窗口归属", () => {
  test("两窗口各选不同实体：各自的记录互不覆盖，模型上下文只跟活动窗口", async () => {
    const host = await boot()
    try {
      await host.select(WINDOW_A, { sceneId: SCENE_A, entityId: "entity-a1", sequence: 1 })
      expect((await host.state(WINDOW_A)).selection?.facts.entityId).toBe("entity-a1")
      expect(host.modelContext()).toContain("entity-a1")

      await host.select(WINDOW_B, { sceneId: SCENE_A, entityId: "entity-a2", sequence: 1 })
      // 修前：B 这一次写入会把 A 的记录整份换掉，A 再读就是 entity-a2。
      expect((await host.state(WINDOW_A)).selection?.facts.entityId).toBe("entity-a1")
      expect((await host.state(WINDOW_B)).selection?.facts.entityId).toBe("entity-a2")
      const context = host.modelContext()
      expect(context).toContain("entity-a2")
      expect(context).not.toContain("entity-a1")

      // A 再操作一次 → 活动窗口回到 A；B 自己那一份事实不受影响。
      await host.select(WINDOW_A, { sceneId: SCENE_A, entityId: "entity-a1", sequence: 2 })
      expect(host.modelContext()).toContain("entity-a1")
      expect((await host.state(WINDOW_B)).selection?.facts.entityId).toBe("entity-a2")
    } finally { await host.dispose() }
  })

  test("sequence 单调边界只约束同一个窗口：A 的迟到旧选择写不回，B 的同序号选择照常生效", async () => {
    const host = await boot()
    try {
      await host.select(WINDOW_A, { sceneId: SCENE_A, entityId: "entity-a1", sequence: 5 })
      expect((await host.select(WINDOW_A, { sceneId: SCENE_A, entityId: "entity-a2", sequence: 3 })).updated).toBe(false)
      expect((await host.state(WINDOW_A)).selection?.facts.entityId).toBe("entity-a1")
      // B 是另一个窗口：它的序号空间与 A 无关，sequence 1 就该写进去。
      expect((await host.select(WINDOW_B, { sceneId: SCENE_A, entityId: "entity-a2", sequence: 1 })).updated).toBe(true)
      expect((await host.state(WINDOW_B)).selection?.facts.entityId).toBe("entity-a2")
    } finally { await host.dispose() }
  })

  test("world 生命周期结果只写回发起命令的那个窗口的选择槽", async () => {
    const host = await boot()
    try {
      await host.select(WINDOW_A, { sceneId: SCENE_A, entityId: "entity-a1", sequence: 1 })
      await host.select(WINDOW_B, { sceneId: SCENE_A, entityId: "entity-a2", sequence: 1 })
      // 命令体里的 selection 带本窗口 clientId（workbench-api 的 command 就是这么做）＝ B 发起的 sim_open。
      await host.sendCommand("sim_open", { sceneId: SCENE_A }, { sceneId: SCENE_A, clientId: WINDOW_B })
      expect((await host.state(WINDOW_B)).selection?.facts.worldId).toBe("world-1")
      // A 的选择仍是它自己的事实：没有被 B 的 world 生命周期写过。
      const a = (await host.state(WINDOW_A)).selection?.facts
      expect(a?.entityId).toBe("entity-a1")
      expect(a?.worldId).toBeUndefined()
    } finally { await host.dispose() }
  })
})

describe("DEV-004 多窗口：UI 动作只在目标窗口消费一次", () => {
  test("定向动作只投递给目标窗口；别的窗口拿同一个 id 确认也不出队", async () => {
    const host = await boot()
    try {
      await host.state(WINDOW_A); await host.state(WINDOW_B) // 两个窗口都在场（真实前端靠 state 轮询上报）
      const queued = await host.runTool<{ queued: string; target?: string }>("ui_action", { input: { action: "openTool", tool: "scene", clientId: WINDOW_A } })
      expect(queued.target).toBe(WINDOW_A)
      expect((await host.state(WINDOW_A)).uiActions?.map(item => item.id)).toContain(queued.queued)
      // 非目标窗口连看都看不到这条动作 —— 不可能抢先执行/确认。
      expect((await host.state(WINDOW_B)).uiActions ?? []).toEqual([])
      // 别的窗口硬发一条确认：不出队（条目还在目标窗口那里等着）。
      await host.sendCommand("ui_action_ack", { ids: [queued.queued], clientId: WINDOW_B })
      expect((await host.state(WINDOW_A)).uiActions?.map(item => item.id)).toContain(queued.queued)
      // 目标窗口确认才出队，且只出队一次。
      await host.sendCommand("ui_action_ack", { ids: [queued.queued], clientId: WINDOW_A })
      expect((await host.state(WINDOW_A)).uiActions ?? []).toEqual([])
    } finally { await host.dispose() }
  })

  test("省略目标时目标＝活动窗口（最近有操作的窗口）", async () => {
    const host = await boot()
    try {
      await host.state(WINDOW_A); await host.state(WINDOW_B)
      await host.select(WINDOW_B, { sceneId: SCENE_A, entityId: "entity-a2", sequence: 1 })
      const queued = await host.runTool<{ queued: string; target?: string }>("ui_action", { input: { action: "focus", entityId: "entity-a2" } })
      expect(queued.target).toBe(WINDOW_B)
      expect((await host.state(WINDOW_B)).uiActions?.map(item => item.id)).toContain(queued.queued)
      expect((await host.state(WINDOW_A)).uiActions ?? []).toEqual([])
    } finally { await host.dispose() }
  })

  test("指定不存在的窗口明确失败，不静默排给别的窗口", async () => {
    const host = await boot()
    try {
      await host.state(WINDOW_A)
      await expect(host.runTool("ui_action", { input: { action: "openTool", tool: "scene", clientId: "window-ghost" } }))
        .rejects.toThrow(/UI_ACTION_CLIENT_NOT_LIVE/)
    } finally { await host.dispose() }
  })

  test("没有目标的旧条目（没有在场窗口时排队）仍投给所有窗口：保持既有回退", async () => {
    const host = await boot()
    try {
      // 没有任何窗口轮询过 → 没有在场事实，也没有活动窗口。
      const queued = await host.runTool<{ queued: string; target?: string }>("ui_action", { input: { action: "openFiles" } })
      expect(queued.target).toBeUndefined()
      expect((await host.state(WINDOW_A)).uiActions?.map(item => item.id)).toContain(queued.queued)
      expect((await host.state(WINDOW_B)).uiActions?.map(item => item.id)).toContain(queued.queued)
    } finally { await host.dispose() }
  })
})
