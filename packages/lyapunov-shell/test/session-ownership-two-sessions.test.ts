/**
 * W4 · DEV-003（多 session 共享世界的控制归属）+ ISAAC-21（多会话场景隔离）的**宿主侧**回归。
 *
 * 判据四条，本文件逐条钉住（跑真实 `plugin.ts` 的注册面：HTTP 路由 / 命令桥 / 原生工具注册表）：
 *   ① 隔离       = 两会话各自 world/scene 互不可见（`forSession` 门面只按调用方会话取用）；
 *   ② 不误写     = A 的动作不改 B 的选择/世界/会话日志；别人的 sceneId/worldId 只得到结构化错误；
 *   ③ 并发不丢不重 = 同刻并发写入两侧各自成立、不丢条目、不重复、不跨会话混入；
 *   ④ 结构化错误 = 非法目标操作给稳定错误码，且文本不含绝对路径。
 *
 * 边界（如实登记）：这是宿主侧进程内证据，**不是**两条真实 CU 会话的真机读数（真机读数见
 * `bugfixHistory/DEV003-ISOLATION-RECHECK-20260922.md` 与 `DEV003-CLOSURE-REPROBE-20260923.md`）。
 * 本文件补的是自动化回归：真机回执会过期，代码路径不会自己守住自己。
 * 会话/场景/世界服务用最薄替身（只保留被测代码用到的调用形状：`forSession` / `list` / `snapshot` /
 * `listWorlds` / `observe` / `close`），sim 侧用真实的 `SessionSimFactory`（按会话建实例的那份实现）。
 * 场景存储与 sim Provider 各自的领域语义由 scene-kit / sim-contract 自己的测试与 W1/W3 的域负责，本文件不冒充。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import JobsLocal from "@deepseek-ai/dsh-jobs-local"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import ToolRuntime from "@deepseek-ai/dsh-tools"
import { ToolCallId } from "@deepseek-ai/dsh-llm"
import { createScope, scopeOf } from "@deepseek-ai/dsh-scope"
import { SessionId } from "@deepseek-ai/dsh-session"
import { SessionSimFactory } from "../../sim-contract/src/session-provider.ts"
import type { SimWorlds } from "../../sim-contract/src/index.ts"
import { isolateProviderInstaller } from "./fixtures/isolated-provider-installer.ts"

const SESSION_A = "w4-session-a"
const SESSION_B = "w4-session-b"
const WINDOW_A = "w4-window-a"
const WINDOW_B = "w4-window-b"
const WINDOW_B2 = "w4-window-b2"
/** 两个会话里**同名**的场景：同名不等于同一份文档（这正是隔离要证明的事）。 */
const SHARED_SCENE = "w4-shared-scene"
const WORLD_A = "w4-world-a"
const WORLD_B = "w4-world-b"

interface StubScene { sceneId: string; revision: number; entities: Array<{ entityId: string; name: string }> }
interface WorldRow { worldId: string; sceneId: string; engineId: string; engineVersion: string; worldGeneration: number; appliedSceneRevision: number; status: string }
interface ToolCallResult { isError: boolean; content?: Array<{ type: string; text?: string }>; error?: { message?: string } }
type CommandBody = { kind?: string; text?: string; ui?: unknown; error?: string }
type StateBody = { worlds?: WorldRow[]; scene?: { sceneId: string; revision: number }; selection?: { clientId: string; facts: Record<string, unknown> }; uiActions?: Array<{ id: string; action: string }> }

/** 结构化错误的两种合法形状：`CODE: 人话` 或裸 `CODE`（内部码经公开面投影后见 `P###: 人话`）。 */
const CODE = /^[A-Z][A-Z0-9_]*(?::|$)/
/** 路径泄露的判据是"出现绝对路径根"，不是"出现斜杠"：`scene_open/scene_create` 里的斜杠是工具名分隔符。 */
const LEAKS_PATH = /\/(?:home|tmp|root|Users|var|mnt|opt|srv|etc|proc|dev)\//
const failureText = (result: ToolCallResult): string => result.error?.message ?? result.content?.find(block => block.type === "text")?.text ?? ""
const textValue = (result: ToolCallResult): Record<string, unknown> => JSON.parse(result.content?.find(block => block.type === "text")?.text ?? "{}") as Record<string, unknown>

let installerRoot: string | undefined
beforeEach(() => { installerRoot = mkdtempSync(join(tmpdir(), "lyapunov-w4-ownership-")) })
afterEach(() => {
  if (installerRoot !== undefined) rmSync(installerRoot, { recursive: true, force: true })
  installerRoot = undefined
})

/**
 * 每会话一套场景文档 + 每会话一套世界（真实 `SessionSimFactory`）。
 * 服务面**只暴露 `forSession`**：修前所有会话共用一份 `SceneOperations` 与一个 Provider，
 * 于是 A 加载环境会覆盖 B 的场景——这里从形状上就没有共享入口。
 */
async function boot() {
  const root = installerRoot!
  const ctx = new Context() as any
  await ctx.plugin(JobsLocal as never)
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const definitions = new Map<string, { handler: (invocation: any) => any }>()
  const namespaces = new Set<string>()
  const sceneCalls: string[] = []
  const simCalls: string[] = []
  const sceneStores = new Map<string, Map<string, StubScene>>()
  const storeOf = (key: string) => {
    const existing = sceneStores.get(key)
    if (existing) return existing
    const created = new Map<string, StubScene>([[SHARED_SCENE, { sceneId: SHARED_SCENE, revision: key === SESSION_A ? 3 : 1, entities: [{ entityId: `entity-${key}`, name: `实体-${key}` }] }]])
    sceneStores.set(key, created)
    return created
  }
  ctx.provide("scene", {
    forSession: (key: string) => {
      sceneCalls.push(key)
      return {
        scene: { snapshot: async (sceneId: string) => { const found = storeOf(key).get(sceneId); if (!found) throw new Error(`SCENE_NOT_FOUND: ${sceneId}`); return found } },
        repairResourceSources: async (sceneId:string)=>{const found=storeOf(key).get(sceneId);if(!found)throw new Error(`SCENE_NOT_FOUND: ${sceneId}`);return found},
        completeResourceSources: async (scene: {sceneId:string;revision:number})=>scene,
        list: async () => [...storeOf(key).values()].map(scene => ({ sceneId: scene.sceneId })),
        create: async () => { throw new Error("SCENE_CREATE_UNUSED") },
      }
    },
  })
  const worlds = new Map<string, WorldRow[]>([[SESSION_A, [{ worldId: WORLD_A, sceneId: SHARED_SCENE, engineId: "offline-fixture", engineVersion: "test", worldGeneration: 1, appliedSceneRevision: 3, status: "ready" }]], [SESSION_B, [{ worldId: WORLD_B, sceneId: SHARED_SCENE, engineId: "offline-fixture", engineVersion: "test", worldGeneration: 1, appliedSceneRevision: 1, status: "ready" }]]])
  const stepIndex = new Map<string, number>([[WORLD_A, 10], [WORLD_B, 20]])
  const factory = new SessionSimFactory({ create: key => ({
    listWorlds: async () => worlds.get(key) ?? [],
    observe: async (worldId: string) => {
      const found = (worlds.get(key) ?? []).find(row => row.worldId === worldId)
      if (!found) throw new Error(`WORLD_NOT_FOUND: ${worldId}`)
      const step = stepIndex.get(worldId) ?? 0
      return { worldId, stepIndex: step, sceneRevision: found.appliedSceneRevision, frameId: `frame-${worldId}-${String(step)}` }
    },
    close: async (worldId: string) => {
      const rows = worlds.get(key) ?? []
      if (!rows.some(row => row.worldId === worldId)) throw new Error(`WORLD_NOT_FOUND: ${worldId}`)
      worlds.set(key, rows.filter(row => row.worldId !== worldId))
      return { closed: true }
    },
    dispose: async () => {},
  } as unknown as SimWorlds) })
  // 只读路径（`existingSimFor`）要求"该会话已经有实例"：先在两侧各起一个自己的实例，
  // 再由服务面 Spy 记录**运行期**的取用键（这一次预热不算取用）。
  factory.forSession(SESSION_A)
  factory.forSession(SESSION_B)
  const simService = { forSession: (key: string) => { simCalls.push(key); return factory.forSession(key) }, has: (key: string) => factory.has(key), sessions: () => factory.sessions() }
  ctx.provide("sim", simService as never)

  const events = new Map<string, Array<{ type: string; data: Record<string, unknown> }>>()
  const displayed:Array<{sessionId:string;name:string;display:unknown}>=[]
  const sent = new Map<string, unknown[]>()
  const agentFor = (sessionId: string) => ({
    id: SessionId(sessionId), ctx: createScope(ctx, { session: sessionId }).ctx,
    steer() {}, inject() {},
    send(message: unknown) { sent.set(sessionId, [...sent.get(sessionId) ?? [], message]) },
    session: {
      id: sessionId, header: { id: sessionId },
      append: (type: string, data: Record<string, unknown>) => { events.set(sessionId, [...events.get(sessionId) ?? [], { type, data }]) },
      snapshotEvents: () => events.get(sessionId) ?? [],
    },
  })
  const agents = new Map<string, unknown>([[SESSION_A, agentFor(SESSION_A)], [SESSION_B, agentFor(SESSION_B)]])

  ctx.provide("connection", { fetch: { register: (entry: { path: string; fetch: (request: Request) => Promise<Response> }) => { routes.set(entry.path, entry.fetch); return () => routes.delete(entry.path) } } })
  ctx.provide("settings", { register: (ns: string) => { namespaces.add(ns); return () => namespaces.delete(ns) }, describe: () => [...namespaces].map(ns => ({ ns, user: undefined, revision: 1, value: {} })), mutate: async () => undefined, replace: async () => undefined })
  ctx.provide("agents", { get: (id: unknown) => agents.get(String(id)) })
  ctx.provide("sessions", { flush: async () => undefined })
  ctx.provide("sessionController", { resolveAgent: async (id: unknown) => { const agent = agents.get(String(id)); return agent ? { agent } : { error: new Error(`SESSION_NOT_FOUND: ${String(id)}`) } } })
  // 历史会话核实链的最后一步：本文件没有历史存储，缺会话就明确失败（不落回全局共享状态）。
  ctx.provide("sessionQuery", { observeSession: async () => undefined })
  ctx.provide("commands", {
    register: (definition: { name: string; handler: (invocation: any) => any }) => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) },
    execute: async (agent: unknown, line: string, _attachments: unknown, signal: AbortSignal) => {
      const match = /^\/([a-zA-Z0-9_]+)([\s\S]*)$/.exec(line)
      const definition = match ? definitions.get(match[1]!) : undefined
      if (!definition) return undefined
      try { return { commandId: "w4-stub-1", result: await definition.handler({ commandId: "w4-stub-1", agent, rawInput: match![2]!, attachments: [], signal }) } }
      catch (error) { return { commandId: "w4-stub-1", result: { kind: "error", text: error instanceof Error ? error.message : String(error) } } }
    },
    // 只替换命令 I/O；窗口 / Session / Scene / world 归属判据走下面真实 plugin 注册路由。
    executeDisplayed:async(agent:any,line:string,attachments:unknown,display:unknown,signal:AbortSignal)=>{
      const name=/^\/([a-zA-Z0-9_]+)/.exec(line)?.[1]??'',commandId='displayed-'+String(displayed.length+1)
      displayed.push({sessionId:agent.session.header.id,name,display})
      agent.session.append('command/run',{commandId,name,source:{kind:'user'},display})
      const result=await ctx.get('commands').execute(agent,line,attachments,signal)
      if(result)agent.session.append('command/done',{commandId,...result.result,display})
      return result
    },
  })
  ctx.provide("attachments", { saveImage: async () => ({}), readImage: async () => ({ data: new Uint8Array() }) })
  await ctx.plugin(SystemPrompt as never, { personaPrefix: "", personaSuffix: "" } as never)
  await ctx.plugin(ToolRuntime as never)

  const installerIsolation = isolateProviderInstaller(root)
  try {
    const { apply } = await import("../src/plugin.ts")
    await apply(ctx as never, { captureRoot: join(root, "captures"), recordingRoot: join(root, "recordings") } as never)
    installerIsolation.assertCalled()
  } finally {
    installerIsolation.restore()
  }

  const sessionKeyOfInvocation = (invocation: unknown): string => {
    const value = invocation as { agent?: { session?: { header?: { id?: string } } } }
    const id = value.agent?.session?.header?.id
    if (!id) throw new Error("SESSION_SCOPE_UNAVAILABLE: 测试命令拿不到调用方会话")
    return id
  }
  /** sim 域命令（真实产品里由 Provider 插件注册）：按**调用方会话**取世界服务，供本文件观察归属跳。 */
  definitions.set("sim_close", { handler: async invocation => {
    const sim = simService.forSession(sessionKeyOfInvocation(invocation))
    const input = JSON.parse(invocation.rawInput || "{}") as { worldId?: string }
    if (typeof input.worldId !== "string") throw new Error("SIM_CLOSE_WORLD_REQUIRED")
    await sim.close(input.worldId)
    return { kind: "success", text: JSON.stringify({ closed: true, worldId: input.worldId }) }
  } })
  definitions.set("scene_list", { handler: async invocation => {
    const sim = simService.forSession(sessionKeyOfInvocation(invocation))
    return { kind: "success", text: JSON.stringify({ worlds: await sim.listWorlds() }) }
  } })
  definitions.set('joint_move',{handler:async invocation=>{const input=JSON.parse(invocation.rawInput);return {kind:'success',text:JSON.stringify({actionId:input.action.actionId,worldId:input.worldId,generation:input.action.expectedGeneration,status:'completed',effect:{motions:[{targetReached:false}]}})}}})
  definitions.set('sim_stop',{handler:async()=>({kind:'success',text:JSON.stringify({stopped:true,stepIndex:10})})})

  const route = (path: string) => {
    const handler = routes.get(`/api/lyapunov/${path}`)
    if (!handler) throw new Error(`ROUTE_NOT_REGISTERED: ${path}`)
    return handler
  }
  const state = async (sessionId: string, clientId: string): Promise<StateBody> => {
    const query = new URLSearchParams({ sessionId, clientId, sceneId: SHARED_SCENE, displaySceneId: SHARED_SCENE, displayRevision: "3" })
    const response = await route("state")(new Request(`http://test/api/lyapunov/state?${query.toString()}`))
    return await response.json() as StateBody
  }
  const stateRaw = async (query: Record<string, string>): Promise<{ status: number; body: StateBody & { error?: string } }> => {
    const response = await route("state")(new Request(`http://test/api/lyapunov/state?${new URLSearchParams(query).toString()}`))
    return { status: response.status, body: await response.json() as never }
  }
  const scenesRaw = async (sessionId?: string): Promise<{ status: number; body: unknown }> => {
    const suffix = sessionId === undefined ? "" : `?${new URLSearchParams({ sessionId }).toString()}`
    const response = await route("scenes")(new Request(`http://test/api/lyapunov/scenes${suffix}`))
    return { status: response.status, body: await response.json() }
  }
  const select = async (sessionId: string, clientId: string, body: Record<string, unknown>) => {
    const response = await route("view-selection")(new Request("http://test/api/lyapunov/view-selection", { method: "POST", body: JSON.stringify({ sessionId, clientId, ...body }) }))
    return { status: response.status, body: await response.json() as { updated?: boolean; facts?: Record<string, unknown>; error?: string } }
  }
  const command = async (sessionId: string, name: string, input: unknown, selection?: Record<string, unknown>,display?:unknown) => {
    const response = await route("command")(new Request("http://test/api/lyapunov/command", { method: "POST", body: JSON.stringify({ sessionId, name, input, ...selection ? { selection } : {},...display?{display}:{} }) }))
    return { status: response.status, body: await response.json() as CommandBody }
  }
  let callSeq = 0
  const tool = async (sessionId: string, name: string, args: unknown): Promise<ToolCallResult> =>
    await ctx.get("tools").execute({ callId: ToolCallId(`w4-${String(++callSeq)}`), name, agent: agents.get(sessionId), arguments: args, signal: new AbortController().signal }) as ToolCallResult
  const dispose = async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } }
  return { state, stateRaw, scenesRaw, select, command, tool, dispose, sceneCalls, simCalls, events, sent, worlds, stepIndex, agents,displayed }
}

test('F5真实注册command路由核本Session窗口槽；缺槽/别会话/声明不符/旧代次拒绝，清选择后原gesture Stop可执行',async()=>{
 const host=await boot(),entityId='entity-'+SESSION_A
 const selection={clientId:WINDOW_A,sceneId:SHARED_SCENE,worldId:WORLD_A}
 const display={kind:'control-gesture',clientId:WINDOW_A,gestureId:'route-gesture',worldId:WORLD_A,generation:1,entityId,jointName:'j1',phase:'update',sequence:1}
 const input={worldId:WORLD_A,action:{kind:'joint',actionId:'route-action',expectedGeneration:1,entityId,jointNames:['j1'],positions:[.2],durationS:.08}}
 try{
  await host.state(SESSION_A,WINDOW_A)
  expect((await host.command(SESSION_A,'joint_move',input,selection,display)).body.kind).not.toBe('success');expect(host.displayed).toHaveLength(0)
  await host.select(SESSION_B,WINDOW_B,{sceneId:SHARED_SCENE,entityId:'entity-'+SESSION_B,worldId:WORLD_B,sequence:1});await host.state(SESSION_B,WINDOW_B)
  expect((await host.command(SESSION_A,'joint_move',input,{...selection,clientId:WINDOW_B},{...display,clientId:WINDOW_B})).body.kind).not.toBe('success');expect(host.displayed).toHaveLength(0)
  await host.select(SESSION_A,WINDOW_A,{sceneId:SHARED_SCENE,entityId,worldId:WORLD_A,sequence:1})
  expect((await host.command(SESSION_A,'joint_move',input,selection,display)).body.kind).toBe('success');expect(host.displayed).toHaveLength(1)
  await host.select(SESSION_A,WINDOW_B2,{sceneId:SHARED_SCENE,entityId,worldId:WORLD_A,sequence:1});await host.state(SESSION_A,WINDOW_B2)
  expect((await host.command(SESSION_A,'joint_move',input,{...selection,clientId:WINDOW_B2},display)).body.kind).not.toBe('success');expect(host.displayed).toHaveLength(1)
  await host.select(SESSION_A,WINDOW_A,{sequence:2})
  expect((await host.command(SESSION_A,'joint_move',input,selection,{...display,phase:'final',sequence:2})).body.kind).not.toBe('success');expect(host.displayed).toHaveLength(1)
  const stop={worldId:WORLD_A,expectedGeneration:1,entityIds:[entityId]}
  expect((await host.command(SESSION_A,'sim_stop',stop,selection,{...display,phase:'stop',sequence:3})).body.kind).toBe('success');expect(host.displayed).toHaveLength(2)
  expect((await host.command(SESSION_A,'sim_stop',stop,selection,{...display,gestureId:'unrecorded',phase:'stop',sequence:4})).body.kind).toBe('success');expect(host.displayed).toHaveLength(2)
  await host.select(SESSION_A,WINDOW_A,{sceneId:SHARED_SCENE,entityId,worldId:WORLD_A,sequence:3})
  expect((await host.command(SESSION_A,'joint_move',{...input,action:{...input.action,expectedGeneration:9}},selection,{...display,generation:9})).body.kind).not.toBe('success');expect(host.displayed).toHaveLength(2)
  host.worlds.get(SESSION_A)![0]!.appliedSceneRevision=2
  await host.select(SESSION_A,WINDOW_A,{sceneId:SHARED_SCENE,entityId,worldId:WORLD_A,sequence:4})
  expect((await host.command(SESSION_A,'joint_move',input,selection,display)).body.kind).not.toBe('success');expect(host.displayed).toHaveLength(2)
  expect((await host.command(SESSION_A,'joint_move',input,selection)).body.kind).toBe('success');expect(host.displayed).toHaveLength(2)
 }finally{await host.dispose()}
})

describe("DEV-003 ① 隔离：两会话的 scene/world 互不可见", () => {
  test("state/scenes 只返回本会话那份；同名 sceneId 在两个会话里是两份文档", async () => {
    const host = await boot()
    try {
      const a = await host.state(SESSION_A, WINDOW_A)
      const b = await host.state(SESSION_B, WINDOW_B)
      // 世界只在各自会话里出现：A 看不到 B 的 world，反之亦然。
      expect(a.worlds?.map(row => row.worldId)).toEqual([WORLD_A])
      expect(b.worlds?.map(row => row.worldId)).toEqual([WORLD_B])
      // 同名场景：A 读到的是 A 的那份（rev 3），B 读到的是 B 的（rev 1）。
      expect(a.scene?.revision).toBe(3)
      expect(b.scene?.revision).toBe(1)
      expect((await host.scenesRaw(SESSION_A)).body).toEqual([{ sceneId: SHARED_SCENE }])
      expect((await host.scenesRaw(SESSION_B)).body).toEqual([{ sceneId: SHARED_SCENE }])
      // 服务面取用只出现调用方那个会话键：没有"Host 级唯一实例"的兜底。
      expect(host.sceneCalls.every(key => key === SESSION_A || key === SESSION_B)).toBe(true)
      expect(host.simCalls.every(key => key === SESSION_A || key === SESSION_B)).toBe(true)
    } finally { await host.dispose() }
  })
})

describe("DEV-003 ② 不误写：A 的动作不改动 B", () => {
  test("B 写自己的选择不覆盖 A 的选择；A 读回的事实逐字不变", async () => {
    const host = await boot()
    try {
      await host.select(SESSION_A, WINDOW_A, { sceneId: SHARED_SCENE, entityId: "entity-w4-session-a", sequence: 1 })
      const before = (await host.state(SESSION_A, WINDOW_A)).selection?.facts
      const bWrite = await host.select(SESSION_B, WINDOW_B, { sceneId: SHARED_SCENE, entityId: "entity-w4-session-b", sequence: 1 })
      expect(bWrite.body.updated).toBe(true)
      expect((await host.state(SESSION_A, WINDOW_A)).selection?.facts).toEqual(before)
      // 反向同样成立：B 的选择只包含 B 的实体。
      expect((await host.state(SESSION_B, WINDOW_B)).selection?.facts.entityId).toBe("entity-w4-session-b")
    } finally { await host.dispose() }
  })

  test("用未知/别人的 sceneId 写选择：结构化 SCENE_NOT_FOUND，且不改动任何一侧", async () => {
    const host = await boot()
    try {
      await host.select(SESSION_A, WINDOW_A, { sceneId: SHARED_SCENE, entityId: "entity-w4-session-a", sequence: 1 })
      const before = (await host.state(SESSION_A, WINDOW_A)).selection?.facts
      // 本会话的 store 里没有这个 sceneId ⇒ 结构性错误，而不是静默生效。
      const missing = await host.select(SESSION_A, WINDOW_A, { sceneId: "scene-owned-by-nobody", sequence: 2 })
      expect(missing.status).toBe(400)
      expect(missing.body.error ?? "").toMatch(CODE)
      expect(missing.body.error ?? "").toContain("SCENE_NOT_FOUND: scene-owned-by-nobody")
      expect(missing.body.error ?? "").not.toContain("/")
      expect((await host.state(SESSION_A, WINDOW_A)).selection?.facts).toEqual(before)
    } finally { await host.dispose() }
  })

  test("A 关不掉 B 的 world：结构化错误 + B 的 world 与 stepIndex 原样", async () => {
    const host = await boot()
    try {
      await host.state(SESSION_A, WINDOW_A); await host.state(SESSION_B, WINDOW_B)
      const beforeB = await host.state(SESSION_B, WINDOW_B)
      const closed = await host.command(SESSION_A, "sim_close", { worldId: WORLD_B })
      expect(closed.body.kind).toBe("error")
      // 出站只发公开码 + 人话（内部 `WORLD_NOT_FOUND` 只进 Host 日志，属隐私边界）：
      // 结构化体现在稳定 `P###` 码上，且不泄露路径/内部细节。
      expect(closed.body.text ?? "").toMatch(/^P\d+: /)
      expect(closed.body.text ?? "").toContain("没有找到")
      expect(closed.body.text ?? "").not.toContain("/")
      // B 侧读数与执行推进完全不受 A 这次非法目标操作影响。
      const afterB = await host.state(SESSION_B, WINDOW_B)
      expect(afterB.worlds?.map(row => row.worldId)).toEqual([WORLD_B])
      expect(afterB.worlds).toEqual(beforeB.worlds)
      expect(host.stepIndex.get(WORLD_B)).toBe(20)
      // 反向正例：A 关自己的 world 成功，B 依旧在。
      const own = await host.command(SESSION_A, "sim_close", { worldId: WORLD_A })
      expect(own.body.kind).toBe("success")
      expect((await host.state(SESSION_A, WINDOW_A)).worlds ?? []).toEqual([])
      expect((await host.state(SESSION_B, WINDOW_B)).worlds?.map(row => row.worldId)).toEqual([WORLD_B])
    } finally { await host.dispose() }
  })

  test("跨会话投递被拒：批注说明投不到别的会话，别的会话日志一条不多", async () => {
    const host = await boot()
    try {
      const injected = await host.command(SESSION_A, "viewer_annotation_send_ui", { sessionId: SESSION_B, prompt: "给 B 会话塞一条说明" })
      expect(injected.body.kind).toBe("error")
      // 公开面是稳定 `P###` 码 + 具体人话（内部码 `ANNOTATION_SESSION_MISMATCH` 不外发）。
      expect(injected.body.text ?? "").toMatch(/^P\d+: /)
      expect(injected.body.text ?? "").toContain("不是本次调用所在的会话")
      expect(injected.body.text ?? "").not.toContain("/")
      expect(host.sent.get(SESSION_B) ?? []).toEqual([])
      // 纯文字不能冒充已保存的图像反馈；真实正例由 viewer-feedback-content.test.ts 覆盖。
      const own = await host.command(SESSION_A, "viewer_annotation_send_ui", { sessionId: SESSION_A, prompt: "本会话的说明" })
      expect(own.body.kind).toBe("error")
      expect(own.body.text ?? "").toContain("需要已保存的 captureId")
      expect(host.sent.get(SESSION_A) ?? []).toEqual([])
      expect(host.sent.get(SESSION_B) ?? []).toEqual([])
    } finally { await host.dispose() }
  })

  test("B 窗口拿 A 队列里的 id 确认：A 的队列一条不出（跨会话不误出队）", async () => {
    const host = await boot()
    try {
      await host.state(SESSION_A, WINDOW_A); await host.state(SESSION_B, WINDOW_B)
      const queued = await host.tool(SESSION_A, "ui_action", { input: { action: "openTool", tool: "scene", clientId: WINDOW_A } })
      expect(queued.isError).toBe(false)
      const id = String(textValue(queued).queued)
      expect((await host.state(SESSION_A, WINDOW_A)).uiActions?.map(item => item.id)).toContain(id)
      const foreign = await host.command(SESSION_B, "ui_action_ack", { ids: [id], clientId: WINDOW_B })
      expect(foreign.body.kind).toBe("success")
      // 出队键取的是**已解析的调用方**会话：B 的确认只可能在 B 的队列上生效。
      expect((await host.state(SESSION_A, WINDOW_A)).uiActions?.map(item => item.id)).toContain(id)
      // 目标窗口自己确认才出队。
      await host.command(SESSION_A, "ui_action_ack", { ids: [id], clientId: WINDOW_A })
      expect((await host.state(SESSION_A, WINDOW_A)).uiActions ?? []).toEqual([])
    } finally { await host.dispose() }
  })

  test("跨会话的窗口身份不被采信：A 的模型不能把动作排给只在 B 在场的窗口", async () => {
    const host = await boot()
    try {
      await host.state(SESSION_B, WINDOW_B)
      const result = await host.tool(SESSION_A, "ui_action", { input: { action: "openTool", tool: "scene", clientId: WINDOW_B } })
      expect(result.isError).toBe(true)
      expect(failureText(result)).toContain("UI_ACTION_CLIENT_NOT_LIVE")
    } finally { await host.dispose() }
  })
})

describe("DEV-003 ③ 并发不丢不重", () => {
  test("两会话同刻并发写界面动作：各自 N 条全部落地、id 唯一、无跨会话混入", async () => {
    const host = await boot()
    try {
      await host.state(SESSION_A, WINDOW_A); await host.state(SESSION_B, WINDOW_B)
      const N = 6
      const writes = await Promise.all([
        ...Array.from({ length: N }, () => host.tool(SESSION_A, "ui_action", { input: { action: "focus", entityId: "entity-w4-session-a", clientId: WINDOW_A } })),
        ...Array.from({ length: N }, () => host.tool(SESSION_B, "ui_action", { input: { action: "focus", entityId: "entity-w4-session-b", clientId: WINDOW_B } })),
      ])
      expect(writes.filter(result => result.isError)).toEqual([])
      const ids = writes.map(result => String(textValue(result).queued))
      expect(new Set(ids).size).toBe(2 * N)
      const a = (await host.state(SESSION_A, WINDOW_A)).uiActions ?? []
      const b = (await host.state(SESSION_B, WINDOW_B)).uiActions ?? []
      expect(a).toHaveLength(N)
      expect(b).toHaveLength(N)
      const aIds = new Set(a.map(item => item.id)), bIds = new Set(b.map(item => item.id))
      expect(aIds.size).toBe(N); expect(bIds.size).toBe(N)
      expect(ids.filter(id => aIds.has(id))).toHaveLength(N)
      expect(ids.filter(id => bIds.has(id))).toHaveLength(N)
      expect([...aIds].some(id => bIds.has(id))).toBe(false)
    } finally { await host.dispose() }
  })

  test("同刻并发写选择：两侧各自成立（没有丢失的写、没有把别人的写算进来）", async () => {
    const host = await boot()
    try {
      const N = 8
      const results = await Promise.all([
        ...Array.from({ length: N }, (_, index) => host.select(SESSION_A, WINDOW_A, { sceneId: SHARED_SCENE, entityId: "entity-w4-session-a", sequence: index + 1 })),
        ...Array.from({ length: N }, (_, index) => host.select(SESSION_B, WINDOW_B, { sceneId: SHARED_SCENE, entityId: "entity-w4-session-b", sequence: index + 1 })),
      ])
      expect(results.filter(result => result.status === 200).length).toBe(2 * N)
      expect((await host.state(SESSION_A, WINDOW_A)).selection?.facts.entityId).toBe("entity-w4-session-a")
      expect((await host.state(SESSION_B, WINDOW_B)).selection?.facts.entityId).toBe("entity-w4-session-b")
      // 场景取用全部落在两个会话键上（没有跨会话写入）。
      expect(host.sceneCalls.filter(key => key !== SESSION_A && key !== SESSION_B)).toEqual([])
    } finally { await host.dispose() }
  })

  test("同一会话两个窗口：各写各的槽，互不覆盖（并发不串槽）", async () => {
    const host = await boot()
    try {
      await Promise.all([
        host.select(SESSION_B, WINDOW_B, { sceneId: SHARED_SCENE, entityId: "entity-w4-session-b", sequence: 1 }),
        host.select(SESSION_B, WINDOW_B2, { sceneId: SHARED_SCENE, entityId: "entity-w4-session-b", sequence: 1 }),
      ])
      expect((await host.state(SESSION_B, WINDOW_B)).selection?.clientId).toBe(WINDOW_B)
      expect((await host.state(SESSION_B, WINDOW_B2)).selection?.clientId).toBe(WINDOW_B2)
    } finally { await host.dispose() }
  })
})

describe("DEV-003 ④ 结构化错误：非法目标操作给稳定错误码、不泄露路径", () => {
  test("负例逐条：码稳定、文本不含绝对路径、都不静默生效", async () => {
    const host = await boot()
    try {
      const failures: Array<{ label: string; text: string }> = []
      const push = (label: string, text: string) => failures.push({ label, text })

      const noSession = await host.stateRaw({})
      expect(noSession.status).toBe(400); push("state 缺会话", noSession.body.error ?? "")
      const ghostSession = await host.stateRaw({ sessionId: "w4-session-ghost" })
      expect(ghostSession.status).toBe(400); push("state 会话不可核实", ghostSession.body.error ?? "")
      const scenesNoSession = await host.scenesRaw()
      expect(scenesNoSession.status).toBe(400); push("scenes 缺会话", String((scenesNoSession.body as { error?: string }).error ?? ""))

      const unknownCommand = await host.command(SESSION_A, "hack_thing", {})
      expect(unknownCommand.status).toBe(400); push("域外命令", unknownCommand.body.error ?? unknownCommand.body.text ?? "")
      const ghostCommand = await host.command("w4-session-ghost", "scene_list", {})
      expect(ghostCommand.status).toBe(400); push("命令的会话不可核实", ghostCommand.body.error ?? ghostCommand.body.text ?? "")

      const staleWorld = await host.select(SESSION_A, WINDOW_A, { sceneId: SHARED_SCENE, entityId: "entity-w4-session-a", worldId: "world-that-does-not-exist", sequence: 1 })
      expect(staleWorld.status).toBe(400); push("worldId 不属于本会话", staleWorld.body.error ?? "")
      const badEntity = await host.select(SESSION_A, WINDOW_A, { sceneId: SHARED_SCENE, entityId: "entity-nobody", sequence: 1 })
      expect(badEntity.status).toBe(400); push("实体不在本会话场景里", badEntity.body.error ?? "")
      const clearConflict = await host.select(SESSION_A, WINDOW_A, { entityId: "entity-w4-session-a", sequence: 1 })
      expect(clearConflict.status).toBe(400); push("清除与赋值同发", clearConflict.body.error ?? "")

      const unknownSceneAction = await host.tool(SESSION_A, "ui_action", { input: { action: "selectScene", sceneId: "scene-not-in-this-session", clientId: WINDOW_A } })
      expect(unknownSceneAction.isError).toBe(true); push("selectScene 未知场景", failureText(unknownSceneAction))
      const invalidClient = await host.tool(SESSION_A, "ui_action", { input: { action: "focus", clientId: "" } })
      expect(invalidClient.isError).toBe(true); push("clientId 形状非法", failureText(invalidClient))

      // 所有负例都是"结构化错误 + 不含 `/`"（路径不泄露给浏览器/模型面）。
      // 所有负例都是"结构化错误（稳定码打头）+ 不泄露绝对路径"。
      // 合成一张表逐条比对，失败时能直接看出是哪一条不达标。
      expect(failures.map(failure => ({ label: failure.label, structured: CODE.test(failure.text), leaksPath: LEAKS_PATH.test(failure.text) })))
        .toEqual(failures.map(failure => ({ label: failure.label, structured: true, leaksPath: false })))
      // 反面对照：正例照常 200 success（修复没有把合法操作一起拒掉）。
      expect((await host.select(SESSION_A, WINDOW_A, { sceneId: SHARED_SCENE, entityId: "entity-w4-session-a", sequence: 9 })).status).toBe(200)
      expect((await host.command(SESSION_A, "scene_list", {})).body.kind).toBe("success")
    } finally { await host.dispose() }
  })
})

describe("ISAAC-21 会话侧的交替开关：一个会话失败/关闭不覆盖另一个", () => {
  test("交替开/关：A 关闭自己的 world 后 B 的读数与推进不受影响，两侧 scene 版本各自独立", async () => {
    const host = await boot()
    try {
      const a0 = await host.state(SESSION_A, WINDOW_A)
      const b0 = await host.state(SESSION_B, WINDOW_B)
      expect(a0.worlds?.map(row => row.worldId)).toEqual([WORLD_A])
      expect(b0.worlds?.map(row => row.worldId)).toEqual([WORLD_B])
      // 交替动作：A 关 → B 读 → B 推进 → A 再读。
      expect((await host.command(SESSION_A, "sim_close", { worldId: WORLD_A })).body.kind).toBe("success")
      const bAfterA = await host.state(SESSION_B, WINDOW_B)
      expect(bAfterA.worlds?.map(row => row.worldId)).toEqual([WORLD_B])
      host.stepIndex.set(WORLD_B, 211)
      const bObserved = await host.command(SESSION_B, "scene_list", {})
      expect(bObserved.body.kind).toBe("success")
      expect(host.stepIndex.get(WORLD_B)).toBe(211)
      // A 侧 world 列表空了，B 侧仍然是 ready；两侧 scene 版本各自独立。
      expect((await host.state(SESSION_A, WINDOW_A)).worlds ?? []).toEqual([])
      const bFinal = await host.state(SESSION_B, WINDOW_B)
      expect(bFinal.scene?.revision).toBe(1)
      expect(bFinal.worlds?.[0]?.status).toBe("ready")
      // 全程取用都带会话键；没有一次落到"全局共享实例"。
      expect(host.simCalls.every(key => key === SESSION_A || key === SESSION_B)).toBe(true)
      expect(host.sceneCalls.every(key => key === SESSION_A || key === SESSION_B)).toBe(true)
    } finally { await host.dispose() }
  })
})
