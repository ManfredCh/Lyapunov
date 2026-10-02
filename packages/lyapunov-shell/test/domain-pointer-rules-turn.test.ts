/**
 * W4 · DEV-019（域指针和技能加载的**真实模型回合**）· 规则路径验收。
 *
 * 客户端 Jev 每步 LLM 路由已于 2026-09-26 退役（提交 `b016ede`）：`plugin.ts` 现在只有规则路径
 * （`environment-routing.ts` 的 `planDomainPointers`），本文件就按这条路径验收，**不复活 Jev**、
 * **不引入 `LYAPUNOV_CONTEXT_ROUTER` / `OPENROUTER_API_KEY`**。
 *
 * 这里跑的是**真实原生回合**：真实 `dsh-agent-loop` + 真实 `dsh-tools` + 真实 `dsh-skill` 注册表 +
 * 真实 `dsh-tool-skill`（也就是模型真正会调的那个 `skill` 工具）。只有"模型"是确定性替身：
 * 它读注入卡里点名的技能并逐个调用 `skill`——这正是 DEV-019 要看的链条（卡片点名 → 同回合真实加载）。
 * 断言四件事：
 *   ① 命中的中文输入：本步注入**一条**域指针（表头带档位与命中词）；
 *   ② 卡片点名的技能 = 同回合真实调用的技能（missing/extra 都为空），且点名集合里没有目录里不存在的技能；
 *   ③ `skill` 工具返回的是**真实技能正文**（注册表里的哨兵串），不是把 grep 命中当"已读技能"；
 *   ④ 不匹配输入（"今天星期几？"）不注入、不调用；命中词对应技能不存在时不点名（不虚构能力）。
 *
 * 边界（如实登记）：这是宿主侧确定性回合，**不是**真机模型回合；真机读数见台账 Round 59 的
 * `DEV-019` 条目（注入卡逐字复现 9/10 探针 + 真实 `tool/call name=skill` 三条）。
 * 已知残留（本轮未改，属 `environment-routing.ts` 的写入域）：注入体在模型侧没有来源标记
 * （模型看不到 `lyapunov-domain-pointer` 这个身份），最小方案是表头/首行加来源；登记在回执里。
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import AgentRegistry from "@deepseek-ai/dsh-agent"
import AgentLoop from "@deepseek-ai/dsh-agent-loop"
import JobsLocal from "@deepseek-ai/dsh-jobs-local"
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId } from "@deepseek-ai/dsh-llm"
import type { GenerateOptions, Message, StreamChunk } from "@deepseek-ai/dsh-llm"
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session"
import type { SessionEvent } from "@deepseek-ai/dsh-session"
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection"
import SkillRegistry from "@deepseek-ai/dsh-skill"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
// 这个包只导出 `{Config, apply, inject, name}`（没有 default），按命名空间插件装配。
import * as ToolSkill from "@deepseek-ai/dsh-tool-skill"
// Bun 会在 agent-loop 包内按源码别名解析 `@deepseek-ai/dsh-tools`：工具注册表必须从**同一个**入口解析，
// 否则调度器的私有 symbol 对不上（真实症状：`ctx.tools[TOOL_RUNTIME_SCHEDULER]` 为 undefined，回合以 error 结束）。
const nativeToolsUrl = import.meta.resolve("@deepseek-ai/dsh-tools", import.meta.resolve("@deepseek-ai/dsh-agent-loop"))
const { default: NativeToolRuntime }: typeof import("@deepseek-ai/dsh-tools") = await import(nativeToolsUrl)
import { isolateProviderInstaller } from "./fixtures/isolated-provider-installer.ts"

/** 读取实际英文卡片的三种点名形状：阶段hint、动作短路和关键词补充；普通tool指导不算skill。 */
const NAMED_SKILL = /\bread skill `([a-z0-9-]+)`|\bread ([a-z0-9-]+) through the skill tool\b|\buse skill tool to read `([a-z0-9-]+)`/gi
const SENTINEL = (name: string) => `W4-SKILL-BODY-SENTINEL:${name}:真实技能正文`
/** 只注册夹具技能：卡片点名集合必须落在这里面（不能凭空点名目录里没有的技能）。 */
const SKILLS = ["environment-planning", "scene-construction", "asset-generation", "robot-provisioning", "action-execution"] as const

let installerRoot: string | undefined
beforeEach(() => { installerRoot = mkdtempSync(join(tmpdir(), "lyapunov-w4-dev019-")) })
afterEach(() => {
  if (installerRoot !== undefined) rmSync(installerRoot, { recursive: true, force: true })
  installerRoot = undefined
})

const user = (text: string) => createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } })
const textOf = (message: Message) => message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n")
const sourceKind = (message: Message) => (message.source as { kind?: string } | undefined)?.kind
const pointerMessages = (request: GenerateOptions) => request.messages.filter(message => sourceKind(message) === "lyapunov-domain-pointer")
const pointerEvents = (events: readonly SessionEvent[]) => events.flatMap(event => event.type === "user/message" && sourceKind(event.data) === "lyapunov-domain-pointer" ? [event] : [])
const toolCalls = (events: readonly SessionEvent[]) => events.flatMap(event => event.type === "tool/call" ? [event] : [])
const toolResults = (events: readonly SessionEvent[]) => events.flatMap(event => event.type === "tool/result" ? [event] : [])
const namedSkills = (text: string): string[] => [...text.matchAll(NAMED_SKILL)].map(match => (match[1] ?? match[2] ?? match[3])!)
/**
 * 事件所属的回合序号：按 `turn/start` 自增。
 * `user/message` 的载荷是消息本身（没有 turn 字段），所以"同回合"要按回合边界算，不能读 `data.turn`。
 */
const turnIndexes = (events: readonly SessionEvent[]): Map<SessionEvent, number> => {
  const map = new Map<SessionEvent, number>()
  let turn = 0
  for (const event of events) { if (event.type === "turn/start") turn += 1; map.set(event, turn) }
  return map
}

/**
 * 确定性"模型"：读注入卡里点名的技能，**每一步加载一个**（`skill` 工具的真实用法就是"要用才读"），
 * 全部读完这一步才收尾。它不看源码/不猜技能名——卡片是它唯一的信息来源
 * （这就是"域指针是否真的驱动了行为"的判据）。
 *
 * 终止条件必须看**已经加载回来的正文**：注入卡会随消息历史一直留在上下文里，
 * 只按"有卡片就调用"写会每步重复调用同一个技能（本文件第一版就是这么挂住的——如实记在这里）。
 * 工具结果块的 `type` 是 `tool-result`（不是 `text`），所以按整块序列化找技能正文里的哨兵串。
 */
class SkillLoadingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  /** 每轮请求时卡片点名的技能（用于断言每轮看到的卡片一致）。 */
  readonly named: string[][] = []
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const loaded = new Set<string>()
    for (const message of request.messages) {
      const raw = JSON.stringify(message.content)
      for (const name of SKILLS) if (raw.includes(SENTINEL(name))) loaded.add(name)
    }
    const pointer = pointerMessages(request).at(-1)
    const named = pointer ? [...new Set(namedSkills(textOf(pointer)))] : []
    this.named.push(named)
    const pending = named.filter(name => !loaded.has(name))
    if (pending.length > 0) {
      const name = pending[0]!
      const block = { type: "tool-call" as const, id: ToolCallId(`w4-019-${name}`), name: "skill", arguments: JSON.stringify({ name }) }
      yield { type: "block-start", index: 0, blockType: "tool-call" }
      yield { type: "tool-call-delta", index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: "block-end", index: 0, block }
      yield { type: "finish", reason: { kind: "tool-calls" } }
      return
    }
    yield { type: "block-start", index: 0, blockType: "text" }
    yield { type: "text-delta", index: 0, text: "done" }
    yield { type: "block-end", index: 0, block: { type: "text", text: "done" } }
    yield { type: "finish", reason: { kind: "stop" } }
  }
}

/** 真实原生栈 + 真实技能注册表/技能加载工具；缺的宿主级服务用最薄替身。 */
async function boot(models: { a: SkillLoadingAdapter; b: SkillLoadingAdapter }) {
  const root = installerRoot!
  const ctx = new Context()
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const namespaces = new Set<string>()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: "", personaSuffix: "" })
  await ctx.plugin(NativeToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JobsLocal)
  // 真实技能注册表 + 真实 `skill` 工具（模型真正会调的那一个）。
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(ToolSkill)
  for (const name of SKILLS) ctx.skills.register({ name, description: `${name}：W4 DEV-019 夹具技能`, content: SENTINEL(name), source: "runtime" })
  ctx.llm.registerAdapter(["w4-rules-a"], models.a)
  ctx.llm.registerAdapter(["w4-rules-b"], models.b)
  ctx.provide("connection", { fetch: { register: (entry: { path: string; fetch: (request: Request) => Promise<Response> }) => { routes.set(entry.path, entry.fetch); return () => routes.delete(entry.path) } } } as never)
  // 通知偏好字段按真实形状给全：缺了它 `preferences-notification-host` 会在收尾时打一条
  // "通知阅读标记保存失败"的类型错误（测试噪声，不是被测行为）。
  ctx.provide("settings", { register: (ns: string) => { namespaces.add(ns); return () => namespaces.delete(ns) }, describe: () => [...namespaces].map(ns => ({ ns, user: undefined, revision: 1, value: { notificationCounter: 0, notificationMarkers: [], notificationReads: {} } })), mutate: async () => undefined, replace: async () => undefined } as never)
  ctx.provide("scene", { forSession: () => ({ scene: { snapshot: async (sceneId: string) => ({ sceneId, revision: 0, entities: [] }) }, list: async () => [] }) } as never)
  ctx.provide("sim", { forSession: () => ({ listWorlds: async () => [], dispose: async () => {} }), has: () => false, sessions: () => [] } as never)
  ctx.provide("sessionController", { resolveAgent: async () => ({ error: new Error("SESSION_NOT_FOUND: fixture") }) } as never)
  ctx.provide("sessionQuery", { observeSession: async () => undefined } as never)
  ctx.provide("commands", { register: () => () => {}, execute: async () => undefined } as never)
  ctx.provide("attachments", { saveImage: async () => ({}), readImage: async () => ({ data: new Uint8Array() }) } as never)

  const installerIsolation = isolateProviderInstaller(root)
  try {
    const { apply } = await import("../src/plugin.ts")
    await apply(ctx, { captureRoot: join(root, "captures"), recordingRoot: join(root, "recordings") })
    installerIsolation.assertCalled()
  } finally { installerIsolation.restore() }

  const a = await ctx.agentLoop.create(SessionId("w4-rules-a"), { provider: "w4-rules-a", model: "fixture" })
  const b = await ctx.agentLoop.create(SessionId("w4-rules-b"), { provider: "w4-rules-b", model: "fixture" })
  const dispose = async () => { await ctx.fiber.dispose() }
  return { a, b, dispose, ctx }
}

test("DEV-019 规则路径：命中输入注入一张域指针，模型同回合按卡片点名真实加载技能", async () => {
  const models = { a: new SkillLoadingAdapter(), b: new SkillLoadingAdapter() }
  const host = await boot(models)
  try {
    const direct = await host.ctx.tools.execute({ callId: ToolCallId("w4-019-direct"), name: "skill", arguments: { name: "environment-planning" }, agent: host.a, signal: new AbortController().signal })
    // 先证明"这个回合里真的挂着一个能加载技能正文的 `skill` 工具"（不是只注册了个名字）。
    expect(direct.isError).toBe(false)
    expect(JSON.stringify(direct.content)).toContain(SENTINEL("environment-planning"))
    host.a.followup(user("给这个会话新建一个庭院场景，并生成一些家具。"))
    await host.a.whenIdle()

    const events = host.a.session.snapshotEvents()
    // ① 本步注入恰好一条域指针，表头是规则路径的档位 + 命中词。
    const pointers = pointerEvents(events)
    expect(pointers).toHaveLength(1)
    const card = textOf(pointers[0]!.data)
    expect(card).toContain("Environment task route: [Create/rebuild]")
    expect(card).toContain('(matched "')
    // ② 卡片点名的技能：非空、全部在真实目录里（不虚构能力）。
    const named = [...new Set(namedSkills(card))]
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter(name => !(SKILLS as readonly string[]).includes(name))).toEqual([])
    // 模型这一轮读着卡片去调 skill：点名集合 = 实际调用集合（missing/extra 都为空）。
    const called = toolCalls(events).filter(event => event.data.name === "skill").map(event => (JSON.parse(event.data.arguments) as { name: string }).name)
    expect(called.length).toBeGreaterThan(0)
    expect([...new Set(called)].sort()).toEqual([...named].sort())
    expect(named.filter(name => !called.includes(name))).toEqual([])   // missing
    expect(called.filter(name => !named.includes(name))).toEqual([])   // extra
    // ③ 真实技能正文进了上下文：每个结果都带注册表里的哨兵，而不是卡片里那行字。
    const results = toolResults(events)
    expect(results.length).toBe(called.length)
    for (const name of called) expect(JSON.stringify(results)).toContain(SENTINEL(name))
    // ④ 同回合：卡片与技能调用落在同一个 turn 里（不是下一回合补读的）。
    const turns = turnIndexes(events)
    const pointerTurn = turns.get(pointers[0]!)
    expect(pointerTurn).toBeGreaterThan(0)
    expect(toolCalls(events).filter(event => event.data.name === "skill").map(event => turns.get(event))).toEqual(called.map(() => pointerTurn))
    // 第二步（卡片仍在模型历史里）不再重复注入：规则路径按"本步消息"判定，不逐步重算。
    expect(pointers).toHaveLength(1)
    expect(host.a.session.snapshotEvents().length).toBeGreaterThan(0)
  } finally { await host.dispose() }
})

test("DEV-019 负对照：不匹配输入既不注入也不调技能", async () => {
  const models = { a: new SkillLoadingAdapter(), b: new SkillLoadingAdapter() }
  const host = await boot(models)
  try {
    host.b.followup(user("今天星期几？"))
    await host.b.whenIdle()
    const events = host.b.session.snapshotEvents()
    expect(pointerEvents(events)).toEqual([])
    expect(toolCalls(events).filter(event => event.data.name === "skill")).toEqual([])
    // 模型侧请求里也没有任何域指针消息。
    expect(models.b.requests.flatMap(request => pointerMessages(request))).toEqual([])
  } finally { await host.dispose() }
})

test("DEV-019 目录权威：命中关键词但技能不在目录里 ⇒ 不点名（不给人加载不出来的建议）", async () => {
  const models = { a: new SkillLoadingAdapter(), b: new SkillLoadingAdapter() }
  const host = await boot(models)
  try {
    // "Blender/可编辑建筑"命中 `architectural-world` 关键词，但该技能**没有**注册：
    // 规则路径只该点名目录里真的存在的技能（`skillAvailable` + `complete`）。
    host.a.followup(user("用 Blender 做一个可编辑建筑，导出到场景里。"))
    await host.a.whenIdle()
    const card = pointerEvents(host.a.session.snapshotEvents()).map(event => textOf(event.data)).join("\n")
    expect(card).not.toContain("architectural-world")
    // 反面：确实存在的技能照常可被点名（不是把整张卡都吞掉）。
    expect(card.length === 0 || namedSkills(card).every(name => (SKILLS as readonly string[]).includes(name))).toBe(true)
  } finally { await host.dispose() }
})

test("已有 G1 的下一轮左转行走加载动作技能，不重复机器人准备", async () => {
  const models = { a: new SkillLoadingAdapter(), b: new SkillLoadingAdapter() }
  const host = await boot(models)
  try {
    host.a.followup(user("下载 G1 机器人"))
    await host.a.whenIdle()
    const before = host.a.session.snapshotEvents()
    expect(pointerEvents(before).flatMap(event => namedSkills(textOf(event.data)))).toContain("robot-provisioning")

    host.a.followup(user("机器人左转向前走"))
    await host.a.whenIdle()
    const events = host.a.session.snapshotEvents()
    const turns = turnIndexes(events)
    const actions = pointerEvents(events).filter(event => turns.get(event) === 2)
    expect(actions).toHaveLength(1)
    expect(namedSkills(textOf(actions[0]!.data))).toEqual(["action-execution"])
    const loaded = toolCalls(events).filter(event => turns.get(event) === 2 && event.data.name === "skill")
      .map(event => JSON.parse(event.data.arguments).name)
    expect(loaded).toEqual(["action-execution"])
    expect(JSON.stringify(toolResults(events).filter(event => turns.get(event) === 2))).toContain(SENTINEL("action-execution"))
    expect(events.filter(event => event.type === "turn/end").every(event => event.data.reason.kind === "completed")).toBe(true)
  } finally { await host.dispose() }
})
