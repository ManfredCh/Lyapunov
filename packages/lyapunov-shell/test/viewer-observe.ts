/**
 * 定向测试：原生 Viewer「模型主动观察」的最小闭环（ENV-28 / ENV-05 的 `viewer_observe` 切片）。
 *
 * **这份测试不是真实页面验收。** 前端是 Node 侧的**模拟窗口**：它按 `workbench.tsx` 的消费逻辑
 * 调用同一份 `workbench-observe.ts`、同一个 `viewer_capture` / `viewer_observe` / `ui_action_ack`
 * 通路，但没有真实浏览器、没有真实 Three/Spark 画布、没有真实 WebGL 像素。它证明的是
 * **宿主侧闭环**（队列、目标窗口、等待/超时/取消、资源就绪判定、归属核对、原生附件）与**前端判定逻辑**；
 * 「真实页面里点得到、拍得准」那一半必须由独立 Host + 新页面的真实验收补上（见 REPORT.md）。
 * 唯一直接跑产品类内部逻辑的地方是第 13/14/15 节：那里用**真实的 `SceneViewer.setScene`**
 * （`Object.create` 造实例 + Viewer 既有的 `options.resolveResource` 注入点）跑实体加载生命周期，
 * 画布与像素仍是替身——它证明"什么时候算加载完、失败能不能重试"是产品代码回答的，不证明像素长什么样。
 *
 * 跑的是**产品源码**（`packages/lyapunov-shell/src/*.ts`），不是 dist 产物；上游用真实
 * cordis / dsh-tools / dsh-system-prompt / dsh-attachment-local，只有宿主整体才有的服务
 * （settings / connection / scene / agents / sessions / sessionController / commands）用最薄替身，
 * 替身只保留被测代码用到的调用形状，不复制领域语义。
 *
 * 用法：`bun run packages/lyapunov-shell/test/viewer-observe.ts`
 * 退出码：0=全部通过；1=有失败。
 */
import { Context } from "@deepseek-ai/cordis"
import Timer from "@deepseek-ai/cordis-plugin-timer"
import AttachmentLocal from "@deepseek-ai/dsh-attachment-local"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools"
import { agentEvents } from "@deepseek-ai/dsh-agent"
import { ToolCallId, createUserMessage } from "@deepseek-ai/dsh-llm"
import { SessionId } from "@deepseek-ai/dsh-session"
import { createScope } from "@deepseek-ai/dsh-scope"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeSessionKey, sessionNamespace } from "../../lyapunov-contracts/src/session-scope.ts"
import { deflateSync } from "node:zlib"
import * as THREE from "three"

import {applyCameraNavigation} from '../src/camera-navigation-actions.ts'
import { captureForObserver, createObserverActionGuard, type ObservableViewer } from "../src/workbench-observe.ts"
// 面板点击的坐标换算：`capture-panel.tsx` 调的就是这个纯函数（回执里的 pixelMapping 与它同一份）。
import { framePixelOfBoxPoint } from "../src/workbench-api.ts"
// 第 23 节走的是真实前端的相机判定模块（`workbench-camera.ts`：窗口支不支持相机、显示的是不是这一版、
// 命名相机存取），它依赖的相机数学来自 `viewer/src/camera-view.ts`（纯计算、无 three 依赖）。
import { applyCameraToWindow, sceneCameraDraftOf, composeViewerCameraComponent, namedCamerasOfScene, observeCameraForAgent as observeCameraForAgentAction, renderCameraForAgent as renderCameraForAgentAction, withoutNamedCamera, type NamedCamera } from "../src/workbench-camera.ts"
import {
  assertRenderSize, cameraRequestFromState, cameraStateFromView, describeCameraView, fovXFromIntrinsics, fovYFromIntrinsics, isPlainLens, normalizeCameraRequest,
  parseViewerCameraComponent, projectionMatrixFromIntrinsics, scaleIntrinsics, setCameraIntrinsics, worldFromCameraOf, writeViewToCamera,
  quaternionAngleDeg,
  type ViewerCameraIntrinsics, type ViewerCameraRequest, type ViewerCameraStateLike, type ViewerQuat, type ViewerVec3,
} from "../../viewer/src/camera-view.ts"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
// 第 13/14 节要对**真实的** `SceneViewer.setScene` 跑加载生命周期：这里直接引产品源码（见 BareViewer 注释）。
// `ViewerCameraRenderRequest`（出图请求 = 相机请求 + 像素尺寸）定义在 Viewer 这一层，不在纯数学模块里。
import { SceneViewer, type ViewerCameraRenderRequest } from "../../viewer/src/index.ts"
import { FrameProjection } from "../../viewer/src/projection.ts"
import type { Entity, SceneSnapshot } from "../../lyapunov-contracts/src/types.ts"

const SESSION_A = "session-a"
const SESSION_B = "session-b"
/** 从来没有窗口的会话：用来验证"没有前端"这条失败路径不被别的会话的窗口影响。 */
const SESSION_C = "session-c"
const SCENE_A = "scene-alpha"
const SCENE_B = "scene-beta"
/** 宿主当前场景版本：rev 4。窗口可以停留在更旧的 rev 上（那正是"旧版本"要测的情形）。 */
const REVISION = 4
/** 真实 PNG（8×6，8bit RGB）：附件存储要真的解码它，所以不能是随便一段 base64。 */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAY0lEQVR42g3JoREAMQgAQSwSbBwTG8UMFkMLmOu/kP+1KyKo4MIRrvCEEloQMdRw4xjXeEYZbX8EGnhwghu8oIKOPxJNPDnJTV5SSecfgw4+nOEOb6ih549FF1/Ocpe31NLLB/VHHsGuXpwoAAAAAElFTkSuQmCC"
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64")
/** 附件库可能交回 webp/jpeg（缩图）或 png（原样入库）：文件头是"这个 path 上到底是什么格式"的最小实证。 */
const FILE_MAGIC: Record<string, number[]> = { "image/png": [0x89, 0x50, 0x4e, 0x47], "image/jpeg": [0xff, 0xd8, 0xff], "image/webp": [0x52, 0x49, 0x46, 0x46] }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
interface ContentBlock { type: string; text?: string; attachment?: { attachmentId: string; mediaType: string; bytes: number; width: number; height: number } }
interface ToolCallResult { isError: boolean; content?: ContentBlock[]; value?: any; error?: { message?: string; info?: { code?: string } } }

const checks: Array<{ name: string; ok: boolean; detail: string }> = []
/** 逐条立即打印：某一节把整份测试炸掉时，日志里仍然留着此前每条断言的结论（不藏在结尾的汇总里）。 */
const check = (name: string, ok: boolean, detail: string) => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  viewer-observe/${name}  ${detail}`)
}
const failureMessage = (result: ToolCallResult) => result.isError ? (result.error?.message ?? JSON.stringify(result.error ?? {})) : ""
/** `drive()` 超时路径没有工具结果（undefined）：失败文案与成功载荷统一走这两个，省得每处再写一遍。 */
const failureOf = (result: ToolCallResult | undefined): string => result?.isError ? failureMessage(result) : ""
const textValueOf = (result: ToolCallResult | undefined): any => result ? textValue(result) : {}
/** 成功结果的文本块是 JSON；失败结果的文本块是人话（错误码），不该假装能解析。 */
const textValue = (result: ToolCallResult): any => {
  const text = result.content?.find(block => block.type === "text")?.text ?? "{}"
  try { return JSON.parse(text) } catch { return { __text: text } }
}
const imageBlock = (result: ToolCallResult) => result.content?.find(block => block.type === "image")
/** 测试用的会话代理：真实上游按 `agent.ctx` 上的 scope 标记区分会话，这里给每个会话铸一个真 scope。 */
const agentFor = (sessionId: string, scoped: unknown) => ({ id: SessionId(sessionId), ctx: scoped, steer() {}, inject() {}, session: { id: sessionId, header: { id: sessionId }, snapshotEvents: () => [] } }) as never

/** 最小宿主：真实 cordis + 真实上游注册表/附件存储，缺的宿主级服务用替身。 */
async function boot() {
  const root = await mkdtemp(join(tmpdir(), "lyapunov-observe-"))
  const captureRoot = join(root, "captures")
  const ctx = new Context() as any
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  ctx.provide("connection", { fetch: { register: (entry: { path: string; fetch: (request: Request) => Promise<Response> }) => { routes.set(entry.path, entry.fetch); return () => routes.delete(entry.path) } } })
  const namespaces = new Set<string>()
  ctx.provide("settings", { register: (ns: string) => { namespaces.add(ns); return () => namespaces.delete(ns) }, describe: () => [...namespaces].map(ns => ({ ns, user: undefined, revision: 1, value: {} })), mutate: async () => undefined, replace: async () => undefined })
  type StubScene = { sceneId: string; revision: number; entities: Array<{ entityId: string; components?: Record<string, unknown> }> }
  /**
   * 场景服务的**按会话门面**（与真实 scene-kit 同一形状：除了 `forSession` 没有别的入口）。
   * 一个会话一套场景文档：同名 sceneId 在两个会话里是两份存储，谁都不可能读到别人的那份——
   * 修前这里是一个共享的 `scenes` Map，正是 P0「A 加载环境覆盖 B 的场景」的形状。
   * 初始夹具按会话各建一份（本文件关心的是 observe/队列/媒体判定，不是场景内容本身），
   * 写入只进**调用方那个会话**的存储；请求方拿不出会话就没有场景可读（不落回共享表）。
   */
  const sceneStores = new Map<string, Map<string, StubScene>>()
  const storeOf = (sessionKey: string) => {
    const existing = sceneStores.get(sessionKey)
    if (existing) return existing
    const created = new Map<string, StubScene>([[SCENE_A, { sceneId: SCENE_A, revision: REVISION, entities: [] }], [SCENE_B, { sceneId: SCENE_B, revision: 1, entities: [] }]])
    sceneStores.set(sessionKey, created)
    return created
  }
  /** 场景快照闸门：默认放行；卡住时"宿主正在 await 场景快照"这段在途时间由测试掌握（P2-1/P2-2 两条反例都要在这期间做动作）。 */
  let sceneGate: { gate: Promise<void>; arrived: () => void } | undefined
  /** 该会话SceneOperations夹具：本批资源源信息已完整，repair/complete必须保持原snapshot/CAS，不冒充真实资源修复。 */
  const operationsOf = (sessionKey: string) => ({
    repairResourceSources: async (sceneId: string) => { const held=sceneGate; if(held){held.arrived();await held.gate} const scene=storeOf(sessionKey).get(sceneId);if(!scene)throw new Error(`SCENE_NOT_FOUND: ${sceneId}`);return scene },
    completeResourceSources: async (scene: StubScene) => scene,
    scene: { snapshot: async (sceneId: string) => { const held = sceneGate; if (held) { held.arrived(); await held.gate } const scene = storeOf(sessionKey).get(sceneId); if (!scene) throw new Error(`SCENE_NOT_FOUND: ${sceneId}`); return scene },
      commit: async (input: { sceneId: string; expectedRevision: number; patch: any[] }) => commitScene(sessionKey, input.sceneId, input.expectedRevision, input.patch) },
    list: async () => [...storeOf(sessionKey).values()].map(scene => ({ sceneId: scene.sceneId })),
    create: async (input: { sceneId?: string } = {}) => {
      const sceneId = input.sceneId ?? `scene_${String(Math.random()).slice(2)}`
      const store = storeOf(sessionKey)
      if (store.has(sceneId)) throw new Error(`SCENE_ALREADY_EXISTS: ${sceneId}`)
      const created: StubScene = { sceneId, revision: 0, entities: [] }
      store.set(sceneId, created)
      return created
    },
  })
  ctx.provide("scene", { forSession: operationsOf })
  /**
   * 场景提交的**替身**（真实宿主里这一步是 scene-kit 的 `SceneStore.commit`，由 `scene_edit`/`scene_mount` 命令用它）：
   * 只实现本测试用到的 `add`/`update` 两种补丁，但**保留 CAS 语义**——`expectedRevision` 与当前不符就拒、提交成功就推进 rev。
   * 命名相机写场景文档走的就是它：于是"存进文档 / 从文档读回来 / 版本过期被拒"这几条判定是真的跑过一遍的。
   * 边界：真实 SceneStore 的完整补丁语法与并发语义由 scene-kit 自己的测试 + root 的真实页面验收覆盖，这里不冒充。
   */
  const commitScene = async (sessionKey: string, sceneId: string, expectedRevision: number, patch: Array<{ op: "add"; entity: { entityId: string; [key: string]: unknown } } | { op: "update"; entityId: string; changes: Record<string, unknown> }>) => {
    const scenes = storeOf(sessionKey)
    const scene = scenes.get(sceneId)
    if (!scene) throw new Error(`SCENE_NOT_FOUND: ${sceneId}`)
    if (scene.revision !== expectedRevision) throw new Error(`SCENE_REVISION_CONFLICT: 场景 ${sceneId} 当前是 rev ${String(scene.revision)}，这次提交基于 rev ${String(expectedRevision)}`)
    let entities = (scene.entities ?? []) as Array<{ entityId: string; components?: Record<string, unknown> }>
    for (const op of patch) {
      if (op.op === "add") entities = [...entities, op.entity as { entityId: string; components?: Record<string, unknown> }]
      else {
        if (!entities.some(entity => entity.entityId === op.entityId)) throw new Error(`SCENE_ENTITY_UNKNOWN: ${op.entityId}`)
        entities = entities.map(entity => entity.entityId === op.entityId ? { ...entity, ...op.changes } : entity)
      }
    }
    scenes.set(sceneId, { ...scene, revision: scene.revision + 1, entities })
    return scenes.get(sceneId)!
  }
  const agents = new Map<string, unknown>([SESSION_A, SESSION_B, SESSION_C].map(sessionId => [sessionId, agentFor(sessionId, createScope(ctx, { session: sessionId }).ctx)]))
  ctx.provide("agents", { get: (id: unknown) => agents.get(String(id)) })
  ctx.provide("sessions", { flush: async () => undefined })
  // 发行装配的 Provider 安装器现在在 apply 时取这两项；本文件只测 Viewer，不会启动安装作业。
  ctx.provide("jobs", { attachController: () => () => {} })
  ctx.provide("subprocess", {})
  ctx.provide("sessionController", { resolveAgent: async (id: unknown) => { const agent = agents.get(String(id)); return agent ? { agent } : { error: new Error(`SESSION_NOT_FOUND: ${String(id)}`) } } })
  // commands：DSH 自身的命令运行时由上游保证（不在本切片范围），这里只保留被测代码用到的调用形状。
  const definitions = new Map<string, { handler: (invocation: any) => any }>()
  let commandSeq = 0
  ctx.provide("commands", {
    register: (definition: { name: string; handler: (invocation: any) => any }) => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) },
    execute: async (agent: unknown, line: string, _attachments: unknown, signal: AbortSignal) => {
      const match = /^\/([a-zA-Z0-9_]+)([\s\S]*)$/.exec(line)
      const definition = match ? definitions.get(match[1]!) : undefined
      if (!definition) return undefined
      const commandId = `stub-${String(++commandSeq)}`
      try { return { commandId, result: await definition.handler({ commandId, agent, rawInput: match![2]!, attachments: [], signal }) } }
      catch (error) { return { commandId, result: { kind: "error", text: error instanceof Error ? error.message : String(error) } } }
    },
  })
  await ctx.plugin(Timer as never)
  await ctx.plugin(SystemPrompt as never)
  await ctx.plugin(AttachmentLocal as never, { dshHome: join(root, "dsh") } as never)
  // 附件闸门：真实的 `saveImage` 要解码/压缩这张图（sharp），这段时间是"取消/超时可能发生在附件化期间"的现场。
  // 只在本测试的宿主上做实例级替换（`saveImage` 是普通方法），被卡住之后走的仍是**真实实现**，不造附件替身。
  const attachmentsService = ctx.get("attachments") as { saveImage: (input: any) => Promise<any> }
  const saveImageReal = attachmentsService.saveImage.bind(attachmentsService)
  let imageGate: { gate: Promise<void>; arrived: () => void } | undefined
  attachmentsService.saveImage = async (input: any) => { const held = imageGate; if (held) { held.arrived(); await held.gate } return await saveImageReal(input) }
  await ctx.plugin(ToolRuntime as never)
  const { apply } = await import("../src/plugin.ts")
  await ctx.plugin({
    name: "lyapunov-shell-under-test", inject: ["connection", "commands", "agents", "scene", "sessions", "attachments", "systemPrompt", "sessionController", "tools", "jobs", "subprocess"],
    apply: (scoped: any) => apply(scoped, { captureRoot, recordingRoot: join(root, "recordings") }),
  } as never, undefined as never)

  const stateRoute = routes.get("/api/lyapunov/state")!, commandRoute = routes.get("/api/lyapunov/command")!
  const state = async (sessionId: string, clientId: string, display: { sceneId?: string; revision?: number }, fetchSceneId?: string) => {
    const query = new URLSearchParams({ sessionId, clientId })
    // fetchSceneId：真实前端 refreshState(id) 也会把目标场景 id 带上（state 路由据此返回该场景当前的身份）。
    if (fetchSceneId) query.set("sceneId", fetchSceneId)
    if (display.sceneId) query.set("displaySceneId", display.sceneId)
    if (display.revision !== undefined) query.set("displayRevision", String(display.revision))
    const response = await stateRoute(new Request(`http://test/api/lyapunov/state?${query.toString()}`))
    const body = await response.text()
    if (!response.ok) throw new Error(`STATE_ROUTE_${String(response.status)}: ${body}`)
    return JSON.parse(body) as { uiActions?: Array<{ id: string; action: string; args: Record<string, unknown> }>; scene?: { sceneId: string; revision: number; entities?: Array<{ entityId: string }> } }
  }
  const command = async (sessionId: string, name: string, input: unknown): Promise<any> => {
    const response = await commandRoute(new Request("http://test/api/lyapunov/command", { method: "POST", body: JSON.stringify({ sessionId, name, input }) }))
    // 出站只有两个消费者面：`text` = 人类公共面，`ui` = 机器面（工作台续链读的就是它）。
    const body = await response.json() as { kind?: string; text?: string; ui?: unknown; error?: string }
    if (body.kind !== "success") throw new Error(body.text ?? body.error ?? "COMMAND_FAILED")
    return (body.ui ?? null) as never
  }
  let callSeq = 0
  /** arguments 原样透传：调用点的形状与模型真实调用一致（例如 `{input:{sceneId,expectedRevision}}`）。 */
  const tool = async (sessionId: string, name: string, args: unknown, options?: { signal?: AbortSignal }) =>
    await ctx.get("tools").execute({ callId: ToolCallId(`t-${String(++callSeq)}`), name, agent: agents.get(sessionId), arguments: args, signal: options?.signal ?? new AbortController().signal }) as ToolCallResult
  const attachmentBytes = async (attachment: { attachmentId: string }) => Buffer.from((await ctx.get("attachments").readImage(attachment)).data)
  /**
   * 采集产物按会话落盘：`<captureRoot>/sessions/<会话键>`（与 shell 读取侧同一份 `sessionNamespace`）。
   * 这两个辅助函数按同一规则列/读，**不手拼会话前缀**——于是"另一个会话里同名 captureId 是另一份产物"
   * 这件事在测试里也是真的。根目录下的旧布局（如果有）仍被列出，只作兼容读取。
   */
  const sessionDirectories = async (): Promise<string[]> => (await readdir(join(captureRoot, "sessions")).catch(() => [] as string[])).map(name => join(captureRoot, "sessions", name))
  const capturePath = (sessionId: string, name: string) => join(sessionNamespace(captureRoot, sessionId), name)
  const listCaptureDir = async (): Promise<string[]> => {
    const names = (await readdir(captureRoot).catch(() => [] as string[])).filter(name => name.endsWith(".json"))
    for (const directory of await sessionDirectories()) {
      const session = await readdir(directory).catch(() => [] as string[])
      for (const name of session.filter(item => item.endsWith(".json"))) names.push(join(directory.slice(captureRoot.length + 1), name))
    }
    return names
  }
  const storedCaptures = async () => (await listCaptureDir()).filter(name => name.endsWith(".json") && !name.endsWith(".camera.json"))
  /**
   * 卡住下一次场景快照读取：返回的 `arrived` 会在真的有调用方进到这次 await 时 resolve
   * （用它把"宿主已经停在快照 await 里"钉成事实，而不是靠 sleep 猜），`release` 放行。
   */
  const holdSceneSnapshot = () => {
    let arrive!: () => void
    const arrived = new Promise<void>(resolve => { arrive = resolve })
    let open!: () => void
    const gate = new Promise<void>(resolve => { open = resolve })
    sceneGate = { gate, arrived: arrive }
    return { arrived, release: () => { sceneGate = undefined; open() } }
  }
  /** 卡住下一次附件入库（形状与 `holdSceneSnapshot` 一致）：`arrived`＝宿主真的停在那次 `saveImage` 里了。 */
  const holdSaveImage = () => {
    let arrive!: () => void
    const arrived = new Promise<void>(resolve => { arrive = resolve })
    let open!: () => void
    const gate = new Promise<void>(resolve => { open = resolve })
    imageGate = { gate, arrived: arrive }
    return { arrived, release: () => { imageGate = undefined; open() } }
  }
  /** 直接拿某个已注册路由的处理函数：会话归属那几节要按**原始请求**试"不带/带错会话标识"（不经封装）。 */
  const route = (path: string) => { const handler = routes.get("/api/lyapunov/" + path); if (!handler) throw new Error(`ROUTE_NOT_REGISTERED: ${path}`); return handler }
  /** 往**替身自己那套**会话存储里放一个场景（不是产品工具，产品工具 scene_create 由 scene-kit 装，本宿主没装）。 */
  const stubSceneCreate = (sessionId: string, sceneId: string) => operationsOf(sessionId).create({ sceneId })
  return { ctx, agents, root, captureRoot, recordingRoot: join(root, "recordings"), state, command, tool, route, commitScene, stubSceneCreate, attachmentBytes, storedCaptures, listCaptures: listCaptureDir, capturePath, holdSceneSnapshot, holdSaveImage }
}
type Harness = Awaited<ReturnType<typeof boot>>

/**
 * 模拟前端窗口：状态对齐 `workbench.tsx` 的 `drainUiActions`（目标窗口才执行、失败也确认出队），
 * 采集判定与载荷复用产品自己的 `workbench-observe.ts`。**不是浏览器**：`viewer` 是数据替身。
 */
class SimWindow {
  sceneId: string
  revision: number
  viewerVisible = true
  /** 采集载荷里声称的版本（默认与显示版本一致；用于构造"窗口拍到了别的版本"）。 */
  captureRevision?: number
  captureSceneId?: string
  readonly captures: string[] = []
  /** 与真实页面同一份去重器：同一条动作在确认前被重复投递时只执行一次。 */
  readonly guard = createObserverActionGuard()
  readonly observedFailures: string[] = []
  /** Viewer 自己的资源加载失败台账（真实 Viewer 有公开的 `loadingErrors`：实体 id → 原因）。 */
  readonly loadingErrors = new Map<string, string>()
  /** Viewer 自己的**缺件警告**表（真实 Viewer 有公开的 `visualWarnings`：实体 id → 警告文本）。 */
  readonly visualWarnings = new Map<string, string[]>()
  /** 可选：把**真实 Viewer** 的台账接进来（第 13/14 节用它，判定读的就是真 View 的那张表）。 */
  ledger?: ReadonlyMap<string, string>
  /** 可选：把**真实 Viewer** 的缺件警告表接进来（与 `ledger` 同理，各接各的表）。 */
  warningLedger?: ReadonlyMap<string, readonly string[]>
  /**
   * 可选探针：采集那一刻读一次现场（第 13 节用它读真实 Viewer 场景图里该实体的子对象数）。
   * 存在的意义：把"这张图拍的时候模型到底在不在画面里"钉成事实，而不是只看工具报成功。
   */
  probe?: () => number
  readonly probes: number[] = []
  /** 当前画面里应当存在的实体（真实值来自 workbench 的 `sceneRef.current.entities`）。 */
  entityIds: string[] = ["entity-a", "entity-b"]
  /** 模拟"用户在这个窗口里选中的实体 / 绑定的世界"：换场景时随 `loadScene` 一起清掉（对齐 workbench 的 loadScene）。 */
  selectedEntityId?: string
  worldId?: string
  /**
   * "本窗口已确认加载完成"的场景身份（真实值由 workbench 在 `await setScene` 的消费者处登记）。
   * 默认：显示的版本早就加载完了——相当于"用户一直看着这个场景"。
   */
  loadState: { sceneId: string; revision: number; settled: boolean; failed?: boolean }
  /** 渲染/采集次数：真实 Viewer 的 `capture()` 会先同步 render 再 toDataURL，所以一次采集=一帧。 */
  frames = 0
  frameTimes: number[] = []
  /** 上一次"加载完成"的时刻：用来断言截图发生在加载之后，而不是之前。 */
  loadedAt = 0
  /** 等待加载完成的上限（真实前端用默认值；测试调小以便快速跑到"还在加载"的分支）。 */
  readyTimeoutMs: number | undefined
  /** 上一次轮询看到的队列快照（调试用：分清"没排队"和"排了但没消费"）。 */
  lastSeen: string[] = []
  polls = 0
  /**
   * 第 23 节：下一次把命名相机写进场景文档时就按这个原因失败（真实产品里对应"场景只读/官方场景、
   * 连接断了、存储失败"这类**提交被拒**）。用完即清——它只用来钉住"写不进去就绝不许回 savedAs"。
   */
  writeRefusal?: string
  /**
   * 第 23 节：本窗口的相机能力。**默认没有**（`undefined` = 这个窗口里的 Viewer 没有相机方法，
   * 即"旧版本/别的实现"），只有相机那几节显式 `window.camera = new SimCamera(window)`。
   * 于是"旧窗口收到 viewer_camera_apply 会怎样"就是默认情形，不需要另造一个窗口类型。
   */
  camera?: SimCamera
  /**
   * 本窗口的 Viewer 实例（真实前端是 `viewer.current`：JSX 里那个 `SceneViewer`，或 `null`）。
   * 相机能力从 `this.camera` 来；没有它就是"只会截图的老 Viewer"——相机工具在调用点就会明确失败。
   */
  viewerInstance(): ObservableViewer | undefined {
    if (!this.viewerVisible) return undefined
    const base = { capture: () => this.frame(), loadingErrors: this.ledger ?? this.loadingErrors, visualWarnings: this.warningLedger ?? this.visualWarnings }
    if (!this.camera) return base
    const camera = this.camera
    return {
      ...base,
      applyCameraView: (request: unknown) => camera.applyCameraView(request),
      cameraView: () => camera.cameraView(),
      renderCameraImage: (request: unknown) => camera.renderCameraImage(request as ViewerCameraRenderRequest),
      getViewState: () => camera.getViewState(),
      setViewState: (state: unknown) => { camera.setViewState(state as ViewerCameraStateLike) },
    }
  }
  /** 相机出图/应用落在本窗口上的次数（与 `frames` 一样是现场证据：拒绝路径上一次都不该有）。 */
  get cameraApplies(): number { return this.camera?.applies.length ?? 0 }
  get cameraRenders(): number { return this.camera?.renders.length ?? 0 }
  constructor(readonly harness: Harness, readonly sessionId: string, readonly clientId: string, options: { sceneId?: string; revision?: number } = {}) {
    this.sceneId = options.sceneId ?? SCENE_A
    this.revision = options.revision ?? REVISION
    this.loadState = { sceneId: this.sceneId, revision: this.revision, settled: true }
  }
  /**
   * 一次真实 `@lyapunov/viewer` `capture()` 的形状：PNG dataURL + 场景/版本 + 相机（position/quaternion/
   * target/up/fov_y/near/far/projection）+ 时间戳。`withCamera=false` 用来验证"最小载荷不带相机"时仍然拿得到图。
   */
  withCamera = true
  /** 这一帧交回的图：默认那张 8×6 的真实 PNG；大图观察那节换成"尺寸正确的大 PNG"（附件库会把它缩成预览）。 */
  frameDataURL?: string
  frame() {
    this.frames++; this.frameTimes.push(Date.now())
    if (this.probe) this.probes.push(this.probe())
    return {
      dataURL: this.frameDataURL ?? `data:image/png;base64,${PNG_BASE64}`,
      sceneId: this.captureSceneId ?? this.sceneId,
      sceneRevision: this.captureRevision ?? this.revision,
      capturedAt: "2026-09-20T00:00:00.000Z",
      ...this.withCamera ? { camera: { position: [0, 0, 1], quaternion: [0, 0, 0, 1], projectionMatrix: Array.from({ length: 16 }, (_value, index) => index % 5 === 0 ? 1 : 0), target: [0, 0, 0], up: [0, 1, 0], fov_y: 45, near: 0.1, far: 100, projection: "perspective" } } : {},
    }
  }
  /**
   * 模拟一次"版本已经变了、资源还在异步加载"的 `setScene`：**显示身份立刻**是新版本
   * （真实 workbench 的 `sceneRef`/Viewer 的 snapshot 就是这样），加载完成事实要等 delayMs 之后才登记。
   */
  async switchScene(sceneId: string, revision: number, delayMs: number, outcome: "ok" | "fail" = "ok") {
    this.sceneId = sceneId; this.revision = revision
    this.loadState = { sceneId, revision, settled: false, failed: false }
    await sleep(delayMs)
    if (this.loadState.sceneId !== sceneId || this.loadState.revision !== revision) return
    this.loadedAt = Date.now()
    this.loadState = outcome === "ok" ? { sceneId, revision, settled: true } : { sceneId, revision, settled: false, failed: true }
  }
  /**
   * 与 `workbench.tsx` 那处 `await instance.setScene(scene)` 消费者**逐句对应**的登记：
   * 先登记"这次还没完成"，再由这次 promise 的落地结果改写 `settled`/`failed`（换版本时旧登记对象被整个替换）。
   * 第 13/14 节用它把**真实的 setScene** 接进观察判定——不再由测试自己写"多久之后算加载完"。
   */
  trackScene(sceneId: string, revision: number, loaded: Promise<void>) {
    this.sceneId = sceneId; this.revision = revision
    const ready: { sceneId: string; revision: number; settled: boolean; failed?: boolean } = { sceneId, revision, settled: false, failed: false }
    this.loadState = ready
    void loaded.then(() => { this.loadedAt = Date.now(); ready.settled = true }, () => { ready.failed = true })
  }
  /** 只上报在场、不消费动作：模拟"页面在轮询但这次采集没人执行"（旧前端/标签页被挂起）。 */
  async heartbeat() { this.polls++; await this.harness.state(this.sessionId, this.clientId, { sceneId: this.sceneId, revision: this.revision }) }
  /**
   * 模拟 workbench.tsx 里 `selectScene` 取走动作后那一句 `loadScene(id)` 的**可观察效果**：
   * 向宿主 state 路由要这个场景现在的身份（真实 loadScene 里就是 `refreshState(id)` 回来后的 `value.scene`），
   * 然后换掉本窗口的显示身份，并清掉旧的实体/world 选择、作废相机视图缓存。
   *
   * 边界（这条测试证明不了什么）：这里没有 React、也没有 `await setScene` 的资源加载，所以
   * "真实 loadScene 内部到底清了哪些 state""Viewer 是不是真的把新场景画出来"由 root 的真实 UI 复验负责；
   * 本节真正跑的是产品代码里**工具注册/校验、队列、ack 与 viewer_observe 采集判定**这几段。
   */
  async loadScene(sceneId: string) {
    const value = await this.harness.state(this.sessionId, this.clientId, { sceneId }, sceneId)
    const scene = value.scene
    if (!scene || scene.sceneId !== sceneId) throw new Error(`SCENE_NOT_FOUND: ${sceneId}`)
    this.sceneId = scene.sceneId; this.revision = scene.revision
    this.entityIds = (scene.entities ?? []).map(entity => entity.entityId)
    this.selectedEntityId = undefined; this.worldId = undefined
    // 换场景后本窗口"登记过一次加载完成"的身份：模拟窗口没有异步资源，切换即完成（真实页面里由 setScene 决定）。
    this.loadState = { sceneId: scene.sceneId, revision: scene.revision, settled: true }
  }
  async poll(): Promise<string[]> {
    this.polls++
    const value = await this.harness.state(this.sessionId, this.clientId, { sceneId: this.sceneId, revision: this.revision })
    this.lastSeen = (value.uiActions ?? []).map(item => `${item.action}:${String(item.args.clientId ?? "-")}`)
    // `done` 是出队的 id；`results` 是逐条的结果行（失败原因，或相机应用那种"没有别的通道可交付"的读数）。
    const done: string[] = [], results: Array<{ id: string; ok: boolean; clientId: string; error?: string; value?: unknown }> = []
    for (const item of value.uiActions ?? []) {
      // 对齐 workbench.tsx 的 `selectScene` 分支（那一句 `perform(()=>loadScene(id))`）：本窗口取走它、
      // 走已有的换场景效果，然后确认出队；失败也确认出队（避免同一条动作每 250ms 被反复重试）。
      if (item.action === "selectScene" && typeof item.args.sceneId === "string") {
        if (!this.guard(item.id)) continue
        try { await this.loadScene(item.args.sceneId) }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          done.push(item.id); results.push({ id: item.id, ok: false, error: message, clientId: this.clientId }); this.observedFailures.push(message); continue
        }
        done.push(item.id)
        continue
      }
      if (item.action !== "captureViewer" && item.action !== "applyCameraViewer" && item.action !== "renderCameraViewer") continue
      // 目标窗口不是本窗口：不执行、不确认，留给真正的目标窗口。
      if (item.args.clientId && item.args.clientId !== this.clientId) continue
      if (!this.guard(item.id)) continue
      try {
        const record: any = await this.runCameraAction(item)
        // 应用相机不是采集：没有图，回执就是"摆到哪台相机上了"（`workbench.tsx` 的 `applyCameraViewer` 分支）。
        // 它与 `viewer_capture` 是两条交付通道：读数走确认里的成功行 `value`，**必须**带上，
        // 否则工具那边一直在等一个到不了的读数（这正是本节的闭环要抓的那类"看起来成功了"）。
        if (item.action === "applyCameraViewer") { done.push(item.id); results.push({ id: item.id, ok: true, clientId: this.clientId, value: record }); continue }
        this.captures.push(record?.captureId ?? "(no captureId)")
        done.push(item.id)
      } catch (error) {
        // 失败也要确认出队（否则同一张没拍成的图会被每次轮询反复重试），并带上本窗口 id 供服务端核对归属。
        const message = error instanceof Error ? error.message : String(error)
        done.push(item.id); results.push({ id: item.id, ok: false, error: message, clientId: this.clientId }); this.observedFailures.push(message)
      }
    }
    // 与 workbench.tsx 的确认一致：顶层带本窗口 clientId——定向观察请求只认目标窗口自己的确认。
    if (done.length) await this.harness.command(this.sessionId, "ui_action_ack", { ids: done, clientId: this.clientId, ...results.length ? { results } : {} })
    return this.observedFailures
  }
  /**
   * 执行一条相机/采集动作：与 `workbench.tsx` 的 `drainUiActions` 三个分支逐句对应
   * （`applyCameraViewer` → `applyCameraToWindow`；`renderCameraViewer` → `renderCameraForAgentAction`；
   * `captureViewer` 带 `camera`/`name` → `observeCameraForAgentAction`，不带则仍是原来的采集）。
   * 判定本身就是产品代码（`workbench-camera.ts` / `workbench-observe.ts`），这里只把窗口现场递进去。
   */
  private async runCameraAction(item: { id: string; action: string; args: Record<string, any> }): Promise<any> {
    const viewer = this.viewerInstance()
    const common = {
      sceneId: String(item.args.sceneId ?? ""), expectedRevision: Number(item.args.expectedRevision),
      observeId: item.id, clientId: this.clientId, sessionId: this.sessionId,
      viewerVisible: this.viewerVisible, viewer,
      displayed: { sceneId: this.sceneId, revision: this.revision, entityIds: this.entityIds },
      loadState: () => this.loadState,
      ...this.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: this.readyTimeoutMs },
      capture: (payload: unknown) => this.harness.command(this.sessionId, "viewer_capture", payload),
    }
    const request = item.args.camera ?? item.args.request
    const name = typeof item.args.name === "string" ? item.args.name : undefined
    const saveAs = typeof item.args.saveAs === "string" ? item.args.saveAs : undefined
    // 命名相机：从这个窗口**显示的那份场景文档**里读，写回也走同一条原生命令（见 SimWindow.writeNamedCameras）。
    const namedCameras = namedCamerasOfScene((await this.sceneDocument()).entities).cameras
    const saveNamedCameras = async (next: NamedCamera[]) => { await this.writeNamedCameras(next) }
    if (item.action === "applyCameraViewer") return await applyCameraToWindow({ ...common, request, name, saveAs, namedCameras, saveNamedCameras })
    if (item.action === "renderCameraViewer") {
      return await renderCameraForAgentAction({
        ...common, request, name, saveAs, namedCameras,
        ...item.args.width === undefined ? {} : { width: Number(item.args.width) },
        ...item.args.height === undefined ? {} : { height: Number(item.args.height) },
      })
    }
    if (request !== undefined || name !== undefined) return await observeCameraForAgentAction({ ...common, request, name, saveAs, namedCameras, saveNamedCameras })
    return await captureForObserver(common)
  }
  /** 这个窗口**显示的那份场景文档**（真实前端是 `sceneRef.current`）：命名相机就是从这里读的。 */
  async sceneDocument(): Promise<{ sceneId: string; revision: number; entities: Array<{ entityId: string; components?: Record<string, unknown> }> }> {
    const value = await this.harness.state(this.sessionId, this.clientId, { sceneId: this.sceneId, revision: this.revision }, this.sceneId)
    const scene = value.scene as { sceneId: string; revision: number; entities?: Array<{ entityId: string; components?: Record<string, unknown> }> } | undefined
    if (!scene) throw new Error(`SCENE_NOT_FOUND: ${this.sceneId}`)
    return { ...scene, entities: scene.entities ?? [] }
  }
  /**
   * 把整张命名相机表写进场景文档：与真实前端 `writeNamedCameras` **同一条原生命令**
   * （`scene_edit` + CAS，提交后本窗口跟着新 rev——真实前端是 `applySceneIfCurrent` 把新快照放进 `sceneRef`）。
   */
  async writeNamedCameras(cameras: NamedCamera[]): Promise<void> {
    // 场景写入**可能被拒**（真实产品里：场景只读/官方场景、连接断了、存储错误）。这里就是那一下失败。
    if (this.writeRefusal) { const reason = this.writeRefusal; this.writeRefusal = undefined; throw new Error(reason) }
    const document = await this.sceneDocument()
    const carrierId = namedCamerasOfScene(document.entities).carrier
    const component = composeViewerCameraComponent(cameras)
    const patch = carrierId
      ? [{ op: "update" as const, entityId: carrierId, changes: { components: { ...(document.entities.find(entity => entity.entityId === carrierId)?.components ?? {}), viewerCamera: component } } }]
      : [{ op: "add" as const, entity: { entityId: `entity-cameras-${this.clientId}`, components: { viewerCamera: component } } }]
    await this.harness.commitScene(this.sessionId, this.sceneId, document.revision, patch)
    this.revision = (await this.sceneDocument()).revision
    // 与真实前端逐句对应：提交成功后 `applyScene` 把新快照放进 `sceneRef` ⇒ 那条 `setScene` effect 重跑，
    // 登记的"已加载完成"身份也跟着到新 rev（`readyScene.current`）。不跟着走的话，下一次采集会以
    // "窗口确认完成的还是上一版"被正确拒掉——那是假象，不是产品行为。
    this.loadState = { sceneId: this.sceneId, revision: this.revision, settled: true }
  }
  /** 绕过产品前端判定、直接投递一次采集：模拟"别的窗口/旧前端把图送上来"。 */
  async postCapture(payload: Record<string, unknown>) {
    return await this.harness.command(this.sessionId, "viewer_capture", { dataURL: `data:image/png;base64,${PNG_BASE64}`, camera: { position: [0, 0, 1], quaternion: [0, 0, 0, 1] }, ...payload })
  }
}
/**
 * 用**产品源码里的真实 `SceneViewer.setScene`** 驱动实体加载生命周期（第 13/14 节）。
 *
 * 为什么不是 `new SceneViewer(...)`：构造函数要真实 WebGLRenderer + PMREM + OrbitControls/DOM，Node 里没有画布。
 * 这里用 `Object.create(SceneViewer.prototype)` 造实例，只补上 `setScene` 真正读到的字段；资源交付走 Viewer
 * 本来就有的注入点 `options.resolveResource`（GLB 只给一棵"能挂上去"的树，不解析真几何）。
 * 因此被测的仍是 `setScene` / `startLoad` / `loadVisual` 与那两处守卫这些**产品代码本身**——
 * "同资源的下一次 setScene 会不会提前 resolve""失败后还会不会重试""废弃结果会不会挂到新对象上"都由真代码回答；
 * 测试只提供外部条件（资源慢、资源失败），不替 setScene 决定什么时候算加载完。
 * 没有覆盖的是像素：真实 GLB 的解析与画面由 root 的真实页面验收负责。
 */
class BareViewer {
  /** 每次 `loadVisual` 走到资源读取口时登记一次：交付/失败都由测试控制。 */
  readonly reads: Array<{ uri: string; deliver: (url: string) => void; fail: (error: Error) => void }> = []
  /** 真实发起过多少次资源读取（失败后是否**重新读了一次**要看它，而不是看在途队列）。 */
  readStarts = 0
  /** 真实 Viewer 的 `onError` 回执（失败台账之外的第二条事实）。 */
  readonly errors: string[] = []
  readonly viewer: any
  constructor() {
    const viewer: any = Object.create(SceneViewer.prototype)
    viewer.options = {
      resolveResource: (uri: string) => new Promise<string>((deliver, fail) => { this.readStarts++; this.reads.push({ uri, deliver, fail }) }),
      onError: (error: Error) => { this.errors.push(error.message) },
    }
    viewer.scene = new THREE.Scene()
    // Object.create不运行构造字段；保留setScene的真实相机投影依赖。
    viewer.cameraRigs = new Map()
    viewer.cameraRigRoot = new THREE.Group()
    viewer.scene.add(viewer.cameraRigRoot)
    viewer.scene.environmentIntensity = 1
    viewer.projection = new FrameProjection()
    // 实体换了资源（签名变了）时 `setScene` 会 `release()` 旧对象，而 `release()` 顺带刷新一次批注标记，
    // 那里要量一次 DOM 与遍历批注集合。这里只给"量测 + 空集合"的替身，**不是渲染替身**（本文件不测像素）。
    viewer.renderer = {
      toneMappingExposure: 1, shadowMap: { enabled: false, type: 0 },
      // render/compile 是渲染器行为（本进程没有 WebGL）；capture() 的同步 render 与 PMREM 构造会用到。
      render: () => {}, compile: () => {},
      domElement: { getBoundingClientRect: () => ({ width: 0, height: 0 }), width: 0, height: 0, toDataURL: () => "data:image/png;base64,AAAA" },
    }
    viewer.controls = { target: new THREE.Vector3(), update: () => {} }
    viewer.camera = new THREE.PerspectiveCamera()
    // 环境光照那一串（`setSceneEnvironment`/`applyEnvironment`/`releaseEnvironmentMap`，58 合入）：没有
    // `components.environment` 的普通场景也会走这条路径（写回组件出现之前那组硬编码读数），
    // 所以这些**构造时就存在**的对象必须在替身里显式给出来——少了 `materialEnvironment.texture`
    // 之类就会在 setScene 里直接抛（本文件曾经因此把两次 setScene 的 promise 判成"已落地"）。
    viewer.materialEnvironment = { texture: new THREE.Texture() }
    viewer.grid = new THREE.Object3D()
    viewer.axes = new THREE.Object3D()
    viewer.hemisphere = new THREE.HemisphereLight(0xe7efff, 0x47515c, 2.4)
    viewer.sun = new THREE.DirectionalLight(0xffffff, 3)
    viewer.environmentClock = { playing: false, offsetHours: 0, advancedSeconds: 0 }
    viewer.environmentDiagnostics = []
    viewer.sunDistance = 50
    viewer.backgroundDaylight = 1
    viewer.geometryRevision = 1
    viewer.annotations = []
    viewer.markers = new Map()
    viewer.objects = new Map()
    viewer.gltfs = new Map()
    // LOD 与共享缓存（95 合入）：`loadGltfObject` 每次读取都记账到 `gltfStats`，少它就在加载路径上直接抛
    // （本文件曾经因此把"模型进画面"那一节判成加载失败）。与上面一样，Object.create 不跑字段初始化器。
    viewer.gltfStats = new Map()
    viewer.lodSwitches = 0
    viewer.lodProbe = new THREE.Vector3()
    viewer.lodCamera = new THREE.Vector3()
    viewer.mixers = new Map()
    viewer.splatBounds = new WeakMap()
    viewer.loadingErrors = new Map()
    // 缺件警告是**另一张表**（viewer/src/index.ts 的 `visualWarnings`）：Object.create 造的实例不会跑字段初始化，
    // 与 loadingErrors 一样由测试补齐；判定读的就是真 Viewer 的这两张表。
    viewer.visualWarnings = new Map()
    viewer.display = { grid: true, axes: true, background: "#121a24", wireframe: false, splats: true, collision: false }
    viewer.disposed = false
    viewer.generation = 0
    viewer.snapshot = undefined
    viewer.world = undefined
    viewer.sceneLightsVisible = true
    viewer.animationClock = 0
    viewer.selected = undefined
    this.viewer = viewer
  }
  /** 交付一个可用的 GLB：真实的 `loadVisual` 会把它的 scene 挂到该实体的组里。 */
  deliverModel(uri: string) {
    const model = new THREE.Group()
    model.name = "plant-model"
    model.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()))
    this.viewer.gltfs.set(uri, Promise.resolve({ scene: model, animations: [] }))
    this.takeRead(uri, "交付").deliver(uri)
  }
  /** 让在途的那次资源读取失败（真实 Viewer 会把它记进 `loadingErrors` 并回报 `onError`）。 */
  failRead(uri: string, reason: string) { this.takeRead(uri, "失败").fail(new Error(reason)) }
  /**
   * 按 uri 指名取一次在途读取：同一个实体换资源时队列里会同时有两次读取（A 还没回来、B 刚起），
   * "谁先完成"必须由测试点名，不能用队列顺序假装。
   */
  private takeRead(uri: string, action: string) {
    const index = this.reads.findIndex(read => read.uri === uri)
    const read = index < 0 ? undefined : this.reads.splice(index, 1)[0]
    if (!read) throw new Error(`NO_RESOURCE_READ: 没有在途的资源读取可以${action}（uri=${uri}；在途=${this.reads.map(item => item.uri).join("、") || "无"}）`)
    return read
  }
  /** 实体的组（真实 Viewer `objects` 里那一个）：子对象数就是"模型在不在这个画面里"。 */
  group(entityId: string): THREE.Group { return this.viewer.objects.get(entityId)?.group as THREE.Group }
  childCount(entityId: string): number { return (this.viewer.objects.get(entityId)?.group.children.length ?? -1) as number }
  /** 该实体组的当前位移 x（用来核对"复用的是同一个对象、但变换已经换成新版本"）。 */
  positionX(entityId: string): number { return (this.viewer.objects.get(entityId)?.group.position.x ?? Number.NaN) as number }
}
/**
 * 同一个实体、同一份资源，只有 transform 不同：Viewer 的 signature 不变 ⇒ 复用同一个 Loaded。
 * 换 `resourceUri` 就是"同一实体换成另一份资源"（signature 变 ⇒ 新 Loaded、旧的被释放）。
 */
const plantScene = (sceneId: string, revision: number, position: [number, number, number], resourceUri = "glb://plant"): SceneSnapshot => ({
  sceneId, revision,
  coordinates: { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" },
  entities: [{
    entityId: "plant", name: "plant",
    transform: { position, quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    resources: [{
      resourceId: resourceUri, version: 1,
      original: { uri: resourceUri, mimeType: "model/gltf-binary" },
      representations: [{ uri: resourceUri, mimeType: "model/gltf-binary", role: "visual" }],
      source: { units: "m", upAxis: "Z", handedness: "right", metersPerUnit: 1 },
    }],
    components: { visual: { kind: "mesh", sourceTransformApplied: true } },
  }],
})

/**
 * 一个会**真实产生缺件警告**的机器人实体：MJCF 里引用了未声明的 mesh（`robot.ts:105` 的 `MESH_ASSET_MISSING`）。
 * 这条路径不抛错、不写 `loadingErrors`，画面照画——只是少了那个网格。`mesh:false` 给的是同一个实体的
 * "没有缺件"版本（纯图元，不带 mesh 引用），用来验证旧警告会随这次重载消失。
 */
const robotScene = (sceneId: string, revision: number, options: { mesh?: boolean; position?: [number, number, number] } = {}): SceneSnapshot => ({
  sceneId, revision,
  coordinates: { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" },
  entities: [{
    entityId: "robot-1", name: "robot",
    transform: { position: options.position ?? [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    resources: [{
      resourceId: "mjcf://robot", version: 1,
      original: { uri: "mjcf://robot", mimeType: "application/xml" },
      representations: [{ uri: "mjcf://robot", mimeType: "application/xml", role: "visual" }],
      source: { units: "m", upAxis: "Z", handedness: "right", metersPerUnit: 1 },
    }],
    components: {
      visual: {
        kind: "robot",
        robot: {
          format: "mjcf",
          document: {
            ...options.mesh === false ? {} : { asset: { mesh: [{ name: "link0_vis" }] } },
            worldbody: { body: [{ name: "base", geom: options.mesh === false ? [{ type: "sphere", size: "0.1" }] : [{ mesh: "link0_vis" }] }] },
          },
        },
      },
    },
  }],
})

/**
 * 一边等工具结果，一边按前端节拍轮询窗口（真实前端是 250ms 定时器；这里 20ms 一档）。
 * 到点仍未结束不会抛异常，而是合成一条"工具没回来"的结果并附上各窗口的现场——
 * 这样失败会落到具体断言上（谁没消费、谁报了什么错），而不是把整份测试炸掉。
 */
async function drive(pending: Promise<ToolCallResult>, windows: SimWindow[], options: { maxMs?: number; beatMs?: number } = {}): Promise<{ settled: true; value?: ToolCallResult; error?: unknown } | { settled: false; value: ToolCallResult }> {
  const deadline = Date.now() + (options.maxMs ?? 4000)
  const rounds: string[] = []
  for (;;) {
    const raced = await Promise.race([
      pending.then(value => ({ settled: true as const, value })).catch((error: unknown) => ({ settled: true as const, error })),
      sleep(options.beatMs ?? 20).then(() => ({ settled: false as const })),
    ])
    if (raced.settled) return raced
    if (Date.now() > deadline) {
      const message = `DRIVE_TIMEOUT: 工具既没结束也没有可消费的动作。窗口现场：${rounds.slice(-3).join(" | ") || "（没有任何一轮轮询）"}`
      return { settled: false, value: { isError: true, content: [{ type: "text", text: message }], error: { message } } }
    }
    for (const window of windows) {
      const failures = await window.poll()
      rounds.push(`${window.clientId}@${window.sessionId} 轮询${String(window.polls)}次 队列[${window.lastSeen.join(" ")}] 采集${String(window.captures.length)}件 失败${JSON.stringify(failures)}`)
    }
  }
}

// ── 第 23 节：相机路径的窗口替身 ─────────────────────────────────────────────
/**
 * Node 里既没有浏览器也没有 WebGL，但真实 `OrbitControls` 的构造要几个 DOM 形状。
 * 这里只补到"能构造出真控件"为止（事件监听器不接任何事件——本文件不模拟用户拖鼠标）：
 * 控件本身仍是产品在页面里用的那一个，`controls.target.set` + `update()` 对 `camera.up` 的处理
 * 就是真实浏览器里的行为（roll 保不保得住正是靠它回答的）。
 */
const stubDocument = { addEventListener() {}, removeEventListener() {}, documentElement: { style: {} } } as unknown as Document
;(globalThis as { document?: unknown }).document ??= stubDocument
function stubElement(): HTMLElement {
  const element = {
    style: {}, clientWidth: 1280, clientHeight: 720,
    addEventListener() {}, removeEventListener() {}, setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720, x: 0, y: 0 }),
    // three r180 的 OrbitControls 会沿事件目标回溯到根节点判断文档级监听（`getRootNode`）。
    getRootNode: () => stubDocument,
  }
  return { ...element, ownerDocument: stubDocument } as unknown as HTMLElement
}
/**
 * 一张 **真实 PNG**，像素尺寸就是要出图的尺寸（纯色、filter 0、zlib 压缩）。
 *
 * 为什么自己编码而不是复用那张 8×6 的测试 PNG：相机出图的载荷里有"这张图是几像素"这一个事实，
 * 宿主落盘时还会拿**附件解码后的真实宽高**再核一次。用小图冒充大图会让这条核对根本走不到，
 * 也就测不出"内参/图片宽高与输出投影一致"。自己编码只依赖 node:zlib，没有引入新的图像库。
 */
function pngOfSize(width: number, height: number): string {
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let row = 0; row < height; row++) {
    const start = row * (1 + width * 3)
    raw[start] = 0                                                    // filter: none
    for (let column = 0; column < width; column++) {
      const at = start + 1 + column * 3
      raw[at] = (column * 255 / Math.max(1, width - 1)) | 0           // 每行都不同 ⇒ 压缩比不会异常到看不出问题
      raw[at + 1] = (row * 255 / Math.max(1, height - 1)) | 0
      raw[at + 2] = 0x80
    }
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, "ascii")
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0   // 8bit、truecolor RGB、无隔行
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ])
  return `data:image/png;base64,${png.toString("base64")}`
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
/**
 * 一个具备相机能力的 Viewer 替身（第 23 节）：**相机那几个方法本身就是 `SceneViewer.prototype` 上的产品代码**，
 * 只有画布是假的（Node 里没有真实 WebGL 画布，像素由 `pngOfSize` 现编一张**尺寸正确**的 PNG）。
 *
 * 为什么改成"真原型 + 假画布"（与第 13/14 节的 BareViewer 同一手法）：手写替身会把产品这一版新增的东西
 * 悄悄漏掉——这里就漏过 `cameraCurrent()` 里的姿态与相机 up，于是"只改 fov/near 时沿用当前 roll"这条
 * 在替身里永远测不出来（替身没有姿态可沿用，只会按 target 重新 lookAt、roll 归零）。现在
 * `applyCameraView` / `cameraView` / `getViewState` / `setViewState` / `renderCameraImage` / `resizeCanvas`
 * 乃至渲染出图时的环境读数（`environmentCaptureFace`）都走产品那一份，替身只提供外部条件。
 *
 * 替身只在两处，且都写在明处：
 *   · 画布是固定像素尺寸、`toDataURL` 交回的是本测试现编的同尺寸 PNG（**不是这个场景的像素**）——
 *     它证明的是"按指定相机出图会带出哪份读数/尺寸/来源/环境事实"以及宿主对这些读数的逐项核对；
 *     像素本身由 root 在真浏览器里按 40 的相机验收。
 *   · 场景是空的（没有实体要渲染、没有资源要解析）。
 * `lie` 是**故意的坏行为**（反例专用）：让替身像"没按请求摆相机的旧实现"那样报读数/交图，
 * 宿主必须拒绝，而不是把这样一张图当成同机位参考图收下。
 */
function fakeCanvasViewer(size: { width: number; height: number }) {
  const viewer: any = Object.create(SceneViewer.prototype)
  const canvas = { width: size.width, height: size.height, toDataURL: () => pngOfSize(viewer.renderer.domElement.width, viewer.renderer.domElement.height) }
  viewer.renderer = {
    domElement: canvas, toneMappingExposure: 1, pixelRatio: 1,
    getPixelRatio() { return viewer.renderer.pixelRatio as number },
    setPixelRatio(value: number) { viewer.renderer.pixelRatio = value },
    // 与 three 的 `setSize` 同一件事：改的是**着色缓冲**像素（`canvasPixels()` 读的就是它）。
    setSize(width: number, height: number) { canvas.width = Math.round(width * viewer.renderer.pixelRatio); canvas.height = Math.round(height * viewer.renderer.pixelRatio) },
    render() {},
  }
  viewer.options = {
    container: { clientWidth: size.width, clientHeight: size.height },
    resolveResource: () => Promise.reject(new Error("FAKE_VIEWER_NO_RESOURCES: 这个替身没有资源可解析")),
    onError() {},
  }
  viewer.scene = new THREE.Scene()
  viewer.scene.environmentIntensity = 1
  viewer.projection = new FrameProjection()
  viewer.objects = new Map()
  viewer.camera = new THREE.PerspectiveCamera(50, size.width / size.height, 0.1, 1000)
  viewer.camera.up.set(0, 0, 1)
  viewer.camera.position.set(5, -6, 4)
  viewer.controls = new OrbitControls(viewer.camera, stubElement())
  viewer.controls.target.set(0, 0, 0.7)
  viewer.controls.update()
  viewer.disposed = false
  viewer.editing = false
  // LOD/共享缓存那几个字段：`Object.create(SceneViewer.prototype)` 不跑字段初始化器，出图前那次
  // `updateLod(camera, {settle:true})` 会读它们（每一帧的定级也读），所以按产品构造里的初值补上。
  viewer.gltfStats = new Map()
  viewer.lodSwitches = 0
  viewer.lodProbe = new THREE.Vector3()
  viewer.lodCamera = new THREE.Vector3()
  // 显示设置（环境读数里的背景色从这里取；与 `SceneViewer` 构造时同一份默认值）。
  viewer.display = { grid: true, axes: true, background: "#121a24", wireframe: false, splats: true, collision: false }
  viewer.environmentDiagnostics = []
  viewer.environmentClock = { playing: false, offsetHours: 0, advancedSeconds: 0 }
  // `environmentStatus()` 会读这三项（回执里的环境窄面由它折出来）：给"内置光、无阴影变化"的初值。
  viewer.hemisphere = { intensity: 1 }
  viewer.sun = { castShadow: true, intensity: 1 }
  return viewer
}
class SimCamera {
  /** 真原型实例：下面每个方法都只是它的转发 + 测试自己的现场记录。 */
  readonly viewer = fakeCanvasViewer({ width: 1280, height: 720 })
  /** 每次应用/出图留下的现场（测试用它核对"量到的"与"请求的"）。 */
  readonly applies: unknown[] = []
  readonly renders: Array<{ imageWidth: number; imageHeight: number; camera: ReturnType<typeof describeCameraView> }> = []
  lie: "none" | "size" | "intrinsics" | "canvas" = "none"
  /** 环境现场（见 `setEnvironment`）：摆过一次就一直带着，直到再摆一次。 */
  private environmentComponent?: { component: Record<string, unknown>; resource: Record<string, unknown> }
  constructor(private readonly owner: { sceneId: string; revision: number; captureSceneId?: string; captureRevision?: number; frame(): Record<string, unknown> }) {}
  get camera(): THREE.PerspectiveCamera { return this.viewer.camera }
  get controls(): OrbitControls { return this.viewer.controls }
  get size() { return { width: this.viewer.renderer.domElement.width, height: this.viewer.renderer.domElement.height } }
  /** 应用相机＝产品那一份（`SceneViewer.applyCameraView`：归一化 → 写相机 + 转心 + `controls.update()` → 当场核对）。 */
  applyCameraView(request: unknown) {
    const measured = this.viewer.applyCameraView(request)
    this.applies.push(request)
    return measured
  }
  cameraView() { return this.viewer.cameraView() }
  /** resize＝产品那一份（`SceneViewer.resizeCanvas`：改画布尺寸 + 按应用时那份 K 缩放）。 */
  resize(width: number, height: number) {
    this.viewer.options.container.clientWidth = width
    this.viewer.options.container.clientHeight = height
    this.viewer.resizeCanvas()
    return this.cameraView()
  }
  getViewState() { return this.viewer.getViewState() }
  setViewState(state: ViewerCameraStateLike) { return this.viewer.setViewState(state) }
  /**
   * 摆一个"环境光照事实"的现场：文档里请求了一份 HDRI，而它**还在途**或**已经失败**。
   *
   * 替身只把文档与在途状态摆出来（承载实体 + 资源表 + 组件 + 在途登记），回执里的 `environment` 窄面
   * 由产品那一份 `environmentCaptureFace()` 自己折——于是"指定相机出的图会不会如实带出 HDRI 失败/在途"
   * 这个问题问的是产品代码，不是测试自己填的一段说明。
   */
  setEnvironment(spec: { resourceId: string; version: number; state: "in-flight" | "failed"; error?: string }) {
    const uri = `hdri://${spec.resourceId}@${String(spec.version)}.hdr`
    const component = {
      kind: "scene/environment", environmentIntensity: 1, hemisphereIntensity: 1, exposure: 1, background: "color" as const,
      shadows: true, sun: { azimuthDeg: 0, elevationDeg: 45, intensity: 1 },
      dayNight: { enabled: false, timeHours: 12, cycleSeconds: 600 }, hdri: { resourceId: spec.resourceId, version: spec.version },
    }
    this.environmentComponent = { component, resource: { resourceId: spec.resourceId, version: spec.version, original: { mimeType: "image/vnd.radiance" }, representations: [{ uri, mimeType: "image/vnd.radiance" }] } }
    this.viewer.environment = { carrier: "entity-env", component, warnings: [] }
    this.viewer.environmentDiagnostics = []
    this.viewer.environmentError = spec.state === "failed" ? spec.error ?? "HDR_LOAD_FAILED: 取不到这份 HDRI" : undefined
    this.viewer.environmentLoad = spec.state === "in-flight" ? { key: `${spec.resourceId}@${String(spec.version)}:${uri}`, promise: new Promise<void>(() => {}) } : undefined
  }
  /**
   * 把"这个窗口此刻显示的文档"同步进产品实例（出图回执里的 sceneId/sceneRevision 与环境读数都读它）。
   * 相机那个替身没有真实快照源，所以每次出图前按窗口现在的身份摆一次——与前端 `sceneRef.current` 同一个角色。
   */
  private syncSnapshot() {
    this.viewer.snapshot = {
      sceneId: this.owner.captureSceneId ?? this.owner.sceneId, revision: this.owner.captureRevision ?? this.owner.revision,
      entities: this.environmentComponent ? [{ entityId: "entity-env", resources: [this.environmentComponent.resource], components: { environment: this.environmentComponent.component } }] : [],
    }
  }
  /**
   * 出图＝产品那一份（`SceneViewer.renderCameraImage`：同一台 scene、另一台相机、另一套像素尺寸），
   * 只有两处是替身自己的：`toDataURL` 交回现编的同尺寸 PNG、`captureSceneId/captureRevision` 用来造假回执。
   * 三种 `lie` 是**故意的坏行为**：坏前端会在"读数/尺寸/来源"上撒谎，宿主必须当场抓住。
   */
  renderCameraImage(request: ViewerCameraRenderRequest) {
    // 坏样子之一：这次请求根本不是按相机出图，而是拿窗口里那一帧顶替（旧前端会这样）。
    // 相机是应用了，但送上去的像素是画布截图——`viewer_render_camera` 的等待者必须把它判失败。
    if (this.lie === "canvas") return this.owner.frame() as never
    this.syncSnapshot()
    const record = this.viewer.renderCameraImage(request) as Record<string, any>
    const imageWidth = Number(record.imageWidth), imageHeight = Number(record.imageHeight)
    if (this.lie === "size") record.imageWidth = imageWidth + 2
    if (this.lie === "intrinsics") {
      // "相机没按 K 摆"的坏样子：像素照请求画，但读数里的 fx 差了 1%（投影矩阵跟着读数一起自洽，
      // 于是能过"矩阵 vs 内参"的自洽检查，只能靠"请求 K 与实测 K"那一项抓住）。
      const k = { ...record.camera.intrinsics, fx: record.camera.intrinsics.fx * 1.01 }
      record.camera = { ...record.camera, intrinsics: k, projectionMatrix: projectionMatrixFromIntrinsics(k, record.camera.near, record.camera.far) }
    }
    this.renders.push({ imageWidth, imageHeight, camera: record.camera })
    return record
  }
}

const DEG = Math.PI / 180
/**
 * 一台"照片相机"的请求（`camera_fit` 输出的形状）：位置/四元数/target，roll 是绕**相机后方轴**（+z）
 * 转 +θ 得到的（+θ 读出来就是 +roll，与 `rollDegrees` 的口径一致）。
 */
function photoRequest(rollDeg: number, intrinsics?: ViewerCameraIntrinsics, target: ViewerVec3 = [0.4, 0.2, 0.6]) {
  const position = new THREE.Vector3(4.2, -3.6, 2.4), focus = new THREE.Vector3(...target)
  const back = position.clone().sub(focus).normalize()
  const base = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(position, focus, new THREE.Vector3(0, 0, 1)))
  const quaternion = new THREE.Quaternion().setFromAxisAngle(back, rollDeg * DEG).multiply(base)
  return { position: position.toArray(), quaternion: quaternion.toArray() as ViewerQuat, target, near: 0.05, far: 500, ...intrinsics ? { intrinsics } : {} }
}
/** 内参逐项比：尺寸必须相等，fx/fy/cx/cy 的像素差要在容差内（不相等时不给通过，也不假装差很小）。 */
function intrinsicsDelta(actual: unknown, expected: ViewerCameraIntrinsics): { ok: boolean; text: string } {
  const k = actual as ViewerCameraIntrinsics | undefined
  if (!k || typeof k.fx !== "number") return { ok: false, text: "（没有内参读数）" }
  const worst = Math.max(Math.abs(k.fx - expected.fx), Math.abs(k.fy - expected.fy), Math.abs(k.cx - expected.cx), Math.abs(k.cy - expected.cy))
  const sizeOk = k.width === expected.width && k.height === expected.height
  return { ok: sizeOk && worst < 1e-6, text: `量到 ${k.fx.toFixed(4)}/${k.fy.toFixed(4)} @${k.cx.toFixed(4)},${k.cy.toFixed(4)} ${String(k.width)}×${String(k.height)}（应为 ${expected.fx.toFixed(4)}/${expected.fy.toFixed(4)} @${expected.cx.toFixed(4)},${expected.cy.toFixed(4)} ${String(expected.width)}×${String(expected.height)}）：尺寸相符=${String(sizeOk)}、最大像素差 ${worst.toExponential(2)}` }
}

/** 等一小会儿看工具是否已经结束：用来断言"某个回执没有 settle 等待者"（pending = 还在等）。 */
async function settleState(pending: Promise<unknown>, ms: number): Promise<"settled" | "pending"> {
  return await Promise.race([
    pending.then(() => "settled" as const).catch(() => "settled" as const),
    sleep(ms).then(() => "pending" as const),
  ])
}

const harness = await boot()
try {
  // ─────────────────────────────────────────────────────────────────────────
  // 1) 单窗口：真的拍到、真的落盘、真的以原生附件回到模型
  // ─────────────────────────────────────────────────────────────────────────
  {
    const window = new SimWindow(harness, SESSION_A, "window-1")
    await window.heartbeat()
    const raced = await drive(harness.tool(SESSION_A, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION } }), [window])
    const result = "value" in raced ? raced.value : undefined
    const image = result && imageBlock(result)
    const payload = result ? textValue(result) : {}
    const bytes = image?.attachment ? await harness.attachmentBytes(image.attachment as { attachmentId: string }) : Buffer.alloc(0)
    const stored = (await harness.storedCaptures()).length
    check("single_window_observe_succeeds",
      Boolean(result && !result.isError),
      result ? (result.isError ? failureMessage(result) : `窗口唯一→直接选中：captureId=${String(payload.captureId)}`) : `工具未返回：${String((raced as { error?: unknown }).error)}`)
    check("observe_returns_image_content_block",
      Boolean(image?.attachment?.attachmentId) && image?.attachment?.mediaType === "image/png",
      `content 块类型=${(result?.content ?? []).map(block => block.type).join("+")}；attachmentId=${String(image?.attachment?.attachmentId)}；宽高=${String(image?.attachment?.width)}×${String(image?.attachment?.height)}`)
    check("observe_image_bytes_are_the_real_viewer_payload",
      bytes.length === PNG_BYTES.length && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && bytes.equals(PNG_BYTES),
      `附件字节 ${String(bytes.length)} B，与窗口送出的 PNG（${String(PNG_BYTES.length)} B）逐字节一致=${String(bytes.equals(PNG_BYTES))}`)
    check("observe_reports_camera_revision_and_source",
      payload.sceneId === SCENE_A && payload.sceneRevision === REVISION && payload.expectedRevision === REVISION && payload.source === "native-viewer" && payload.clientId === "window-1" && Boolean(payload.camera) && typeof payload.imagePath === "string",
      `source=${String(payload.source)}；scene=${String(payload.sceneId)}；rev=${String(payload.sceneRevision)}；clientId=${String(payload.clientId)}；camera=${JSON.stringify(payload.camera)}；imagePath=${String(payload.imagePath)}`)
    const files = await harness.listCaptures()
    // 列出的名字是相对 captureRoot 的（按会话命名空间 `sessions/<会话键>/…`）：按后缀比对，不手拼前缀。
    const recorded = (suffix: string) => files.some(name => name.endsWith(`/${String(payload.captureId)}${suffix}`))
    check("observe_reuses_the_capture_save_path",
      stored === 1 && recorded(".json") && recorded(".camera.json"),
      `本会话命名空间下采集记录 ${String(stored)} 份；本次=${String(payload.captureId)}.json + ${String(payload.captureId)}.camera.json（与用户点"采集图像"同一条落盘实现，落在 sessions/<会话键>/ 下）`)
    const onDisk = typeof payload.imagePath === "string" ? await readFile(payload.imagePath).catch(() => undefined) : undefined
    check("observe_image_path_points_at_the_real_png",
      Boolean(onDisk?.equals(PNG_BYTES)),
      `imagePath=${String(payload.imagePath)}（磁盘 ${String(onDisk?.length)} B，与窗口送出的 PNG 逐字节一致=${String(Boolean(onDisk?.equals(PNG_BYTES)))}）`)
    const captured = typeof payload.captureId === "string"
      ? JSON.parse(await readFile(harness.capturePath(window.sessionId, `${payload.captureId}.json`), "utf8")) as { sceneRevision?: number; attachment?: { attachmentId?: string }; camera?: { position?: number[] } }
      : {} as { sceneRevision?: number; attachment?: { attachmentId?: string }; camera?: { position?: number[] } }
    check("observed_capture_is_stamped_with_target_revision",
      captured.sceneRevision === REVISION && captured.attachment?.attachmentId === image?.attachment?.attachmentId && Array.isArray(captured.camera?.position),
      `落盘 sceneRevision=${String(captured.sceneRevision)}；落盘附件 id 与模型看到的一致=${String(captured.attachment?.attachmentId === image?.attachment?.attachmentId)}；落盘相机=${JSON.stringify(captured.camera?.position)}`)
    check("observed_action_is_consumed_once",
      (await harness.state(SESSION_A, "window-1", {})).uiActions?.length === 0,
      `会话 A 队列剩余动作=${String((await harness.state(SESSION_A, "window-1", {})).uiActions?.length ?? 0)} 条`)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2) 多窗口：目标不唯一必须拒绝；给了 clientId 就只有那个窗口消费
  // ─────────────────────────────────────────────────────────────────────────
  {
    const first = new SimWindow(harness, SESSION_A, "window-1")
    const second = new SimWindow(harness, SESSION_A, "window-2")
    await first.heartbeat(); await second.heartbeat()
    const ambiguous = await harness.tool(SESSION_A, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION } })
    check("ambiguous_target_is_refused",
      ambiguous.isError && failureMessage(ambiguous).includes("VIEWER_OBSERVE_TARGET_AMBIGUOUS"),
      failureMessage(ambiguous))

    const pending = harness.tool(SESSION_A, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-2" } })
    // 先让非目标窗口转一圈：它必须看得到这条动作但不执行、也不代它确认。
    await sleep(30)
    await first.poll()
    const stillQueued = (await harness.state(SESSION_A, "window-1", {})).uiActions ?? []
    const raced = await drive(pending, [first, second])
    const result = "value" in raced ? raced.value : undefined
    check("non_target_window_does_not_steal_the_observation",
      first.captures.length === 0 && stillQueued.length === 1 && Boolean(result && !result.isError),
      `window-1 采集次数=${String(first.captures.length)}（应为 0）；window-1 看过之后队列仍留 ${String(stillQueued.length)} 条（应为 1）；window-2 采集次数=${String(second.captures.length)}；结果=${result && !result.isError ? "成功" : failureMessage(result!)}`)
    check("explicit_clientId_selects_that_window",
      second.captures.length === 1 && textValue(result!).clientId === "window-2",
      `回执里的目标窗口=${String(textValue(result!).clientId)}`)

    // 只有唯一窗口显示目标版本时，省略 clientId 也应能选对（不因为"窗口多于一个"就一律拒绝）。
    const stale = new SimWindow(harness, SESSION_A, "window-1", { revision: REVISION - 1 })
    await stale.heartbeat(); await second.heartbeat()
    const raced2 = await drive(harness.tool(SESSION_A, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION } }), [stale, second])
    const result2 = "value" in raced2 ? raced2.value : undefined
    check("unique_window_displaying_the_target_revision_wins",
      Boolean(result2 && !result2.isError) && textValue(result2!).clientId === "window-2",
      `选中窗口=${String(result2 ? textValue(result2).clientId : failureMessage(result2!))}；window-1 仍显示 rev ${String(stale.revision)}`)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3) 无前端 / 别会话的窗口不算 / 版本不存在：排队前就明确失败
  // ─────────────────────────────────────────────────────────────────────────
  {
    // 会话 B 有一个活着的窗口；会话 C 从没有过窗口——"没有前端"的判定必须只看**本会话**。
    const otherSession = new SimWindow(harness, SESSION_B, "window-b")
    await otherSession.heartbeat()
    const noViewer = await harness.tool(SESSION_C, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION } })
    check("no_frontend_window_fails_clearly",
      noViewer.isError && failureMessage(noViewer).includes("VIEWER_OBSERVE_NO_VIEWER"),
      failureMessage(noViewer))
    const unknownRevision = await harness.tool(SESSION_C, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION + 5 } })
    check("revision_that_does_not_exist_fails_before_queueing",
      unknownRevision.isError && failureMessage(unknownRevision).includes("VIEWER_OBSERVE_REVISION_UNKNOWN") && (await harness.state(SESSION_C, "window-c", {})).uiActions?.length === 0,
      failureMessage(unknownRevision))
    check("presence_and_queue_are_per_session",
      (await harness.state(SESSION_C, "window-c", {})).uiActions?.length === 0 && otherSession.captures.length === 0,
      `会话 B 的窗口在场不影响会话 C 的判定（工具报 NO_VIEWER）；会话 C 队列=${String((await harness.state(SESSION_C, "window-c", {})).uiActions?.length ?? 0)} 条；会话 B 窗口采集次数=${String(otherSession.captures.length)}`)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4) 窗口没打开这个场景：失败原因经 ack 回到等待中的工具
  // ─────────────────────────────────────────────────────────────────────────
  {
    const elsewhere = new SimWindow(harness, SESSION_A, "window-1", { sceneId: SCENE_B, revision: 1 })
    await elsewhere.heartbeat()
    const raced = await drive(harness.tool(SESSION_A, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-1" } }), [elsewhere])
    const result = "value" in raced ? raced.value : undefined
    const message = failureMessage(result!)
    check("window_showing_another_scene_fails_with_reason",
      Boolean(result?.isError) && message.includes("VIEWER_OBSERVE_SCENE_NOT_LOADED") && elsewhere.captures.length === 0,
      `工具错误=${message}；窗口采集次数=${String(elsewhere.captures.length)}（应为 0）`)
    check("failed_action_leaves_no_queue_entry",
      (await harness.state(SESSION_A, "window-1", {})).uiActions?.length === 0,
      `失败确认后队列剩余=${String((await harness.state(SESSION_A, "window-1", {})).uiActions?.length ?? 0)} 条`)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 5) 旧 revision 与服务端核对：前端没拦住（别的窗口/旧前端直传）时，宿主必须拒绝这张图
  // ─────────────────────────────────────────────────────────────────────────
  {
    const window = new SimWindow(harness, SESSION_A, "window-1")
    await window.heartbeat()
    const before = (await harness.storedCaptures()).length
    const pending = harness.tool(SESSION_A, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-1" } })
    await sleep(30)
    // 直传一张属于 rev 3 的图，但声称在回答这次观察：宿主不能认。
    const posted = await window.postCapture({ sceneId: SCENE_A, sceneRevision: REVISION - 1, clientId: "window-1", observeId: (await harness.state(SESSION_A, "window-1", {})).uiActions?.[0]?.id }) as { saved?: boolean; observe?: { matched?: boolean; settled?: boolean; refused?: string } }
    const raced = await drive(pending, [])
    const result = "value" in raced ? raced.value : undefined
    check("stale_revision_capture_is_rejected",
      Boolean(result?.isError) && failureMessage(result!).includes("VIEWER_OBSERVE_STALE_REVISION"),
      `工具错误=${failureMessage(result!)}；直传回执 observe=${JSON.stringify(posted?.observe ?? null)}`)
    // 反例（P2-2）：落在核对**之后**的写盘顺序下，这张不对版的图会留在场景采集列表里。
    // 现在核对在落盘之前：过期/不对版的回传不落盘，也不报告"这次等待被它结束了"之外的任何东西。
    check("stale_revision_capture_is_not_written_into_captures",
      posted?.saved === false && posted?.observe?.settled === true && posted?.observe?.matched === false && (await harness.storedCaptures()).length === before,
      `回执 saved=${String(posted?.saved)}（false＝没落盘）；observe=${JSON.stringify(posted?.observe ?? null)}（归属对、图不对版 ⇒ 这次观察判失败）；captureRoot 下新增 ${String((await harness.storedCaptures()).length - before)} 份（应为 0）`)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 6) 别的窗口送图 / 别的场景送图：同样不认
  // ─────────────────────────────────────────────────────────────────────────
  {
    const window = new SimWindow(harness, SESSION_A, "window-1")
    await window.heartbeat()
    const before = (await harness.storedCaptures()).length
    const pending = harness.tool(SESSION_A, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-1" } })
    await sleep(30)
    const observeId = (await harness.state(SESSION_A, "window-1", {})).uiActions?.[0]?.id
    // 同会话的另一窗口拿别人的 observeId 送图：既不认这张图，也**不结束**这次等待（目标窗口仍在轮询、仍会自己送图）。
    const intruder = await window.postCapture({ sceneId: SCENE_A, sceneRevision: REVISION, clientId: "window-9", observeId }) as { captureId?: string; saved?: boolean; observe?: { matched?: boolean; settled?: boolean; refused?: string } }
    // 冒充这张图之后立刻量一次落盘数：接下来真正的目标窗口还会拍一张（那是**这次观察**的图，允许落盘），
    // 所以"别人的图没写盘"必须在这两者之间断定。
    const afterIntruder = (await harness.storedCaptures()).length
    const stillWaiting = await settleState(pending, 200)
    const raced = await drive(pending, [window])
    const result = "value" in raced ? raced.value : undefined
    const payload = result ? textValue(result) : {}
    check("another_windows_capture_neither_settles_nor_is_attributed",
      stillWaiting === "pending" && intruder.observe?.matched === false && intruder.observe?.settled === false && String(intruder.observe?.refused ?? "").includes("VIEWER_OBSERVE_CLIENT_MISMATCH"),
      `冒充者回执 observe=${JSON.stringify(intruder.observe ?? null)}；冒充后工具仍在等=${String(stillWaiting === "pending")}`)
    // 反例（P2-2）：别的窗口的图**不落盘**。从前是"先写盘、再核对归属"，于是别人的图会留在场景采集列表里。
    check("another_windows_capture_is_not_written_into_captures",
      intruder.saved === false && afterIntruder === before,
      `冒充者回执 saved=${String(intruder.saved)}（false＝没落盘）；冒充那一刻 captureRoot 下新增 ${String(afterIntruder - before)} 份（应为 0；随后目标窗口自己那张不算在这一次里）`)
    check("real_target_window_still_wins_after_a_foreign_capture",
      Boolean(result && !result.isError) && payload.clientId === "window-1" && payload.captureId !== intruder.captureId,
      `最终结果=${result && !result.isError ? `成功（clientId=${String(payload.clientId)}，captureId=${String(payload.captureId)}）` : failureMessage(result!)}；冒充者那张图根本没有 captureId=${String(intruder.captureId)}（既不是这次观察的结论，也没有作为采集落盘）`)

    const before2 = (await harness.storedCaptures()).length
    const pending2 = harness.tool(SESSION_A, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-1" } })
    await sleep(30)
    const observeId2 = (await harness.state(SESSION_A, "window-1", {})).uiActions?.[0]?.id
    const other = await window.postCapture({ sceneId: SCENE_B, sceneRevision: 1, clientId: "window-1", observeId: observeId2 }) as { saved?: boolean; observe?: { settled?: boolean } }
    const raced2 = await drive(pending2, [])
    const result2 = "value" in raced2 ? raced2.value : undefined
    check("capture_from_another_scene_is_rejected",
      Boolean(result2?.isError) && failureMessage(result2!).includes("VIEWER_OBSERVE_SCENE_MISMATCH") && other.saved === false && (await harness.storedCaptures()).length === before2,
      `${failureMessage(result2!)}；回执 saved=${String(other.saved)}；captureRoot 下新增 ${String((await harness.storedCaptures()).length - before2)} 份（应为 0）`)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 7) 超时：窗口在轮询但不执行采集，必须给出明确失败并清掉队列
  // ─────────────────────────────────────────────────────────────────────────
  {
    // 独占会话 C：别的用例留下的窗口在场事实（3s TTL）不会让目标变成"歧义"。
    const window = new SimWindow(harness, SESSION_C, "window-1")
    await window.heartbeat()
    const started = Date.now()
    const result = await harness.tool(SESSION_C, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION } })
    const elapsed = Date.now() - started
    check("timeout_fails_with_reason",
      result.isError && failureMessage(result).includes("VIEWER_OBSERVE_TIMEOUT"),
      `${failureMessage(result)}（耗时 ${String(Math.round(elapsed / 1000))} s）`)
    check("timeout_removes_the_queued_action",
      (await harness.state(SESSION_C, "window-1", {})).uiActions?.length === 0 && window.captures.length === 0,
      `超时后队列剩余=${String((await harness.state(SESSION_C, "window-1", {})).uiActions?.length ?? 0)} 条；窗口采集次数=${String(window.captures.length)}（该窗口全程只在轮询，没有执行采集）`)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 8) 取消：调用方中止，立刻结束且不留队列残留
  // ─────────────────────────────────────────────────────────────────────────
  {
    const window = new SimWindow(harness, SESSION_C, "window-1")
    await window.heartbeat()
    const controller = new AbortController()
    const pending = harness.tool(SESSION_C, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION } }, { signal: controller.signal })
    await sleep(60)
    const started = Date.now()
    controller.abort()
    const raced = await drive(pending, [])
    const elapsed = Date.now() - started
    const result = "value" in raced ? raced.value : undefined
    check("cancel_settles_promptly_with_reason",
      Boolean(result?.isError) && failureMessage(result!).includes("VIEWER_OBSERVE_ABORTED") && elapsed < 2000,
      `${failureMessage(result!)}（中止后 ${String(elapsed)} ms 结束）`)
    check("cancel_removes_the_queued_action",
      (await harness.state(SESSION_C, "window-1", {})).uiActions?.length === 0,
      `取消后队列剩余=${String((await harness.state(SESSION_C, "window-1", {})).uiActions?.length ?? 0)} 条`)
    // 迟到的一轮轮询不能再拍到这张图（动作已被撤销）。
    await window.poll()
    check("late_poll_after_cancel_captures_nothing",
      window.captures.length === 0,
      `取消后窗口采集次数=${String(window.captures.length)}`)
  }
  // ─────────────────────────────────────────────────────────────────────────
  // 9) 最小载荷（客户端不带相机位姿）：图照样拿得到，不能因为缺 camera 整次观察作废
  // ─────────────────────────────────────────────────────────────────────────
  {
    const window = new SimWindow(harness, SESSION_B, "window-b2")
    window.withCamera = false
    await window.heartbeat()
    const raced = await drive(harness.tool(SESSION_B, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION } }), [window])
    const result = "value" in raced ? raced.value : undefined
    const payload = result ? textValue(result) : {}
    const image = result && imageBlock(result)
    check("minimal_payload_without_camera_still_returns_the_image",
      Boolean(result && !result.isError) && Boolean(image?.attachment?.attachmentId) && !("camera" in payload) && payload.imagePath === payload.image?.path,
      result?.isError ? failureMessage(result) : `content=${(result?.content ?? []).map(block => block.type).join("+")}；camera 键在用 "camera" in payload 判定下=${String("camera" in payload)}（应为 false）；imagePath=${String(payload.imagePath)}`)
  }
  // ─────────────────────────────────────────────────────────────────────────
  // 10) 确认出队前的重复投递：一次观察只拍一张（250ms 轮询比采集快，真实页面会重叠看到同一条）
  // ─────────────────────────────────────────────────────────────────────────
  {
    const window = new SimWindow(harness, SESSION_B, "window-b3")
    await window.heartbeat()
    // 显式 clientId：上一节在会话 B 里留下的窗口（3s TTL 内）会让"省略即唯一"变成歧义。
    const pending = harness.tool(SESSION_B, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-b3" } })
    await sleep(40)
    const baseline = (await harness.storedCaptures()).length
    await Promise.all([window.poll(), window.poll()])
    const raced = await drive(pending, [])
    const result = "value" in raced ? raced.value : undefined
    const stored = (await harness.storedCaptures()).length - baseline
    check("overlapping_polls_capture_once",
      Boolean(result && !result.isError) && window.captures.length === 1 && stored === 1,
      `两轮重叠轮询后本窗口采集次数=${String(window.captures.length)}（应为 1）；新增落盘记录=${String(stored)} 份（应为 1）；工具结果=${result && !result.isError ? "成功" : failureMessage(result!)}`)
  }
  // ─────────────────────────────────────────────────────────────────────────
  // 11) 版本已更新但资源还没加载完：版本字符串对不上不能放行，加载完成 + 台账为空才拍
  //     （反例：真实 setScene 先改 snapshot 再 await 资源，sceneRef 同样先带上新版本）
  // ─────────────────────────────────────────────────────────────────────────
  {
    const window = new SimWindow(harness, SESSION_B, "window-b4")
    await window.heartbeat()
    // 显示身份**立刻**是 rev 4，异步资源 300ms 后才加载完：只比版本字符串的判据在这里就会放行。
    const loading = window.switchScene(SCENE_A, REVISION, 300)
    const duringLoad = { revision: window.revision, settled: window.loadState.settled }
    const raced = await drive(harness.tool(SESSION_B, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-b4" } }), [window], { maxMs: 6000 })
    const result = "value" in raced ? raced.value : undefined
    await loading
    const payload = result ? textValue(result) : {}
    check("revision_updated_but_resources_loading_is_not_treated_as_ready",
      duringLoad.revision === REVISION && duringLoad.settled === false,
      `观察开始那一刻：显示版本=${String(duringLoad.revision)}（已经等于请求的 rev ${String(REVISION)}，只比版本字符串拦不住）、加载完成事实=${String(duringLoad.settled)}（false＝资源还在加载）`)
    check("capture_waits_for_the_load_then_renders_once",
      Boolean(result && !result.isError) && window.frames === 1 && (window.frameTimes[0] ?? 0) >= window.loadedAt && payload.sceneRevision === REVISION,
      result?.isError ? failureMessage(result) : `采集次数=${String(window.frames)}（应为 1）；截图时刻−加载完成时刻=${String((window.frameTimes[0] ?? 0) - window.loadedAt)} ms（≥0＝确实在加载完成之后才拍）；结果 rev=${String(payload.sceneRevision)}`)
  }
  {
    // 加载一直不完成：等到上限就明确失败，绝不先拍一张缺对象的图。
    const window = new SimWindow(harness, SESSION_B, "window-b5")
    window.readyTimeoutMs = 200
    await window.heartbeat()
    void window.switchScene(SCENE_A, REVISION, 600)
    const raced = await drive(harness.tool(SESSION_B, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-b5" } }), [window], { maxMs: 4000 })
    const result = "value" in raced ? raced.value : undefined
    check("load_that_never_finishes_fails_clearly_without_capturing",
      Boolean(result?.isError) && failureMessage(result!).includes("VIEWER_OBSERVE_SCENE_LOADING") && window.frames === 0,
      `工具错误=${result?.isError ? failureMessage(result) : "（没有报错）"}；采集次数=${String(window.frames)}（应为 0）`)
  }
  {
    // setScene 自己抛错（例如父实体缺失）：不采集。
    const window = new SimWindow(harness, SESSION_B, "window-b6")
    await window.heartbeat()
    await window.switchScene(SCENE_A, REVISION, 30, "fail")
    const raced = await drive(harness.tool(SESSION_B, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-b6" } }), [window], { maxMs: 4000 })
    const result = "value" in raced ? raced.value : undefined
    check("failed_scene_load_is_refused_without_capturing",
      Boolean(result?.isError) && failureMessage(result!).includes("VIEWER_OBSERVE_SCENE_LOAD_FAILED") && window.frames === 0,
      `工具错误=${result?.isError ? failureMessage(result) : "（没有报错）"}；采集次数=${String(window.frames)}（应为 0）`)
  }
  {
    // 加载完成但台账里有失败实体（真实 Viewer 的 loadingErrors：实体 id → 原因）：报出实体名，不采集。
    const window = new SimWindow(harness, SESSION_B, "window-b7")
    window.loadingErrors.set("entity-a", "GLB_READ_FAILED: 资源读取失败")
    await window.heartbeat()
    const raced = await drive(harness.tool(SESSION_B, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-b7" } }), [window], { maxMs: 4000 })
    const result = "value" in raced ? raced.value : undefined
    check("entity_that_failed_to_load_blocks_the_capture",
      Boolean(result?.isError) && failureMessage(result!).includes("VIEWER_OBSERVE_SCENE_LOAD_FAILED") && failureMessage(result!).includes("entity-a") && window.frames === 0,
      `工具错误=${result?.isError ? failureMessage(result) : "（没有报错）"}；采集次数=${String(window.frames)}（应为 0）`)
  }
  {
    // 台账里只有**不在当前画面**的旧实体（已被移出场景）：不该永远挡着观察。
    const window = new SimWindow(harness, SESSION_B, "window-b8")
    window.entityIds = ["entity-a", "entity-b"]
    window.loadingErrors.set("entity-gone", "上一次加载留下的失败")
    await window.heartbeat()
    const raced = await drive(harness.tool(SESSION_B, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-b8" } }), [window], { maxMs: 4000 })
    const result = "value" in raced ? raced.value : undefined
    check("stale_load_error_for_an_entity_outside_the_scene_does_not_block",
      Boolean(result && !result.isError) && window.frames === 1,
      result?.isError ? failureMessage(result) : `采集次数=${String(window.frames)}（应为 1）；台账里那条属于已移出画面的 entity-gone，不是这次画面的内容`)
  }
  // ─────────────────────────────────────────────────────────────────────────
  // 12) 跨会话冒充：别的会话既不能把等待者判失败，也不能把图算成这次观察的结果
  // ─────────────────────────────────────────────────────────────────────────
  {
    const window = new SimWindow(harness, SESSION_A, "window-7")
    await window.heartbeat()
    const pending = harness.tool(SESSION_A, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-7" } })
    await sleep(40)
    const observeId = (await harness.state(SESSION_A, "window-7", {})).uiActions?.[0]?.id ?? ""
    // 会话 B 冒充目标窗口报"这次采集失败"：同样的 observeId、同样的 clientId，只有会话不对。
    const foreignAck = await harness.command(SESSION_B, "ui_action_ack", { ids: [observeId], results: [{ id: observeId, ok: false, error: "VIEWER_OBSERVE_SCENE_NOT_LOADED: 伪造的失败原因", clientId: "window-7" }] }) as { acked?: number }
    const afterAck = await settleState(pending, 200)
    // 会话 B 再冒充一次"成功回填"：图是真的、场景/版本/clientId 也都对，只有会话不对。
    const before = (await harness.storedCaptures()).length
    const forged = await harness.command(SESSION_B, "viewer_capture", { dataURL: `data:image/png;base64,${PNG_BASE64}`, camera: { position: [0, 0, 1], quaternion: [0, 0, 0, 1] }, sceneId: SCENE_A, sceneRevision: REVISION, clientId: "window-7", observeId }) as { captureId?: string; saved?: boolean; observe?: { matched?: boolean; settled?: boolean; refused?: string } }
    const afterCapture = await settleState(pending, 200)
    check("foreign_session_cannot_settle_the_waiter",
      afterAck === "pending" && afterCapture === "pending" && forged.observe?.matched === false && forged.observe?.settled === false && String(forged.observe?.refused ?? "").includes("FOREIGN_SESSION") && forged.saved === false && (await harness.storedCaptures()).length === before,
      `别会话的失败 ack（acked=${String(foreignAck.acked)}）之后工具仍在等=${String(afterAck === "pending")}；别会话的回填 observe=${JSON.stringify(forged.observe ?? null)}（saved=${String(forged.saved)}，captureRoot 下新增 ${String((await harness.storedCaptures()).length - before)} 份）；之后工具仍在等=${String(afterCapture === "pending")}`)
    // 真正的目标窗口（会话 A 的 window-7）随后自己拍：这次观察照样成立，用的是它自己的图。
    const raced = await drive(pending, [window])
    const result = "value" in raced ? raced.value : undefined
    const payload = result ? textValue(result) : {}
    check("owner_window_still_settles_after_foreign_attempts",
      Boolean(result && !result.isError) && payload.captureId !== forged.captureId,
      result?.isError ? failureMessage(result) : `观察成立：captureId=${String(payload.captureId)}；跨会话冒充那张=${String(forged.captureId)}（未被当成结论）`)
  }
  // ─────────────────────────────────────────────────────────────────────────
  // 13) 真实 setScene 的生命周期（Gap A）：资源在途时"同资源、只改 transform"的第二次 setScene 不能提前完成
  //     反例：第二次 setScene 复用同一个 Loaded，只看 `userData.loaded` 就会立刻 resolve——上层把还没进画面的
  //     R1 登记成"已加载完成"，viewer_observe 于是拍到缺对象的 R1。这里用产品源码的 setScene 本身跑这段。
  // ─────────────────────────────────────────────────────────────────────────
  {
    const viewer = new BareViewer()
    const window = new SimWindow(harness, SESSION_B, "window-b9")
    window.readyTimeoutMs = 400
    window.entityIds = ["plant"]
    window.ledger = viewer.viewer.loadingErrors // 判定读的就是真 Viewer 的那张台账
    window.probe = () => viewer.childCount("plant") // 采集那一刻"模型在不在画面里"
    await window.heartbeat()

    // R0（rev 3）先把 GLB 读起来；它还没回来时，同一个实体只挪位置提交 R1（rev 4，资源/visual 签名不变）。
    const r0 = viewer.viewer.setScene(plantScene(SCENE_A, REVISION - 1, [0, 0, 0])) as Promise<void>
    window.trackScene(SCENE_A, REVISION - 1, r0)
    const r1 = viewer.viewer.setScene(plantScene(SCENE_A, REVISION, [2, 0, 0])) as Promise<void>
    window.trackScene(SCENE_A, REVISION, r1)
    const r0State = await settleState(r0, 80), r1State = await settleState(r1, 80)
    check("second_setScene_with_the_same_resources_waits_for_the_in_flight_load",
      r0State === "pending" && r1State === "pending" && viewer.readStarts === 1 && viewer.childCount("plant") === 0,
      `R0=${r0State} R1=${r1State}（都应为 pending：两次 setScene 都在等同一次真实资源读取）；已发起的资源读取=${String(viewer.readStarts)} 次（1＝没有重复下载，也没被提前跳过）；此刻画面里该实体的子对象数=${String(viewer.childCount("plant"))}（0＝模型还没进画面）`)

    // 就在这一刻观察 R1：窗口显示版本**已经**等于请求版本，但那次加载还没完成 ⇒ 必须拒绝采集，绝不给缺对象的图。
    const raced = await drive(harness.tool(SESSION_B, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-b9" } }), [window], { maxMs: 4000 })
    const refused = "value" in raced ? raced.value : undefined
    const r1StillPending = (await settleState(r1, 30)) === "pending"
    check("observation_of_the_still_loading_revision_is_refused_without_capturing",
      Boolean(refused?.isError) && failureMessage(refused!).includes("VIEWER_OBSERVE_SCENE_LOADING") && window.frames === 0 && window.captures.length === 0 && r1StillPending,
      `工具错误=${refused?.isError ? failureMessage(refused!) : "（没有报错）"}；采集次数=${String(window.frames)}（应为 0）；拒绝了这一版之后 R1 的 promise 仍未落地=${String(r1StillPending)}`)

    // 资源真的到位：这一次读取完成后 R0/R1 才落地，模型才进画面（位置是 R1 的 transform）。
    viewer.deliverModel("glb://plant")
    await r0; await r1
    check("resource_arrival_resolves_both_setScene_calls_and_puts_the_model_in_the_scene",
      viewer.childCount("plant") === 1 && viewer.positionX("plant") === 2 && viewer.viewer.loadingErrors.size === 0 && window.loadState.settled === true,
      `子对象数=${String(viewer.childCount("plant"))}（1＝模型进了画面）；位移 x=${String(viewer.positionX("plant"))}（2＝用的是 R1 的 transform 且是同一个复用对象）；失败台账=${String(viewer.viewer.loadingErrors.size)} 条；窗口登记的加载完成事实=${String(window.loadState.settled)}`)

    // 资源完成后，同一版 R1 就能被观察：采集发生在加载完成之后，且采集那一刻画面里确实有模型。
    const raced2 = await drive(harness.tool(SESSION_B, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-b9" } }), [window], { maxMs: 4000 })
    const result = "value" in raced2 ? raced2.value : undefined
    const payload = result ? textValue(result) : {}
    check("that_revision_can_be_observed_after_the_resource_arrives",
      Boolean(result && !result.isError) && window.frames === 1 && window.captures.length === 1 && (window.frameTimes[0] ?? 0) >= window.loadedAt && window.probes[0] === 1 && payload.sceneRevision === REVISION,
      result?.isError ? failureMessage(result) : `采集次数=${String(window.frames)}（应为 1，失败那次没有拍）；截图时刻−加载完成时刻=${String((window.frameTimes[0] ?? 0) - window.loadedAt)} ms（≥0＝在加载完成之后才拍）；采集那一刻该实体的子对象数=${String(window.probes[0])}（1＝画面里真的有模型）；结果 rev=${String(payload.sceneRevision)}`)
  }
  // ─────────────────────────────────────────────────────────────────────────
  // 14) 加载失败后还能重试（Gap A 的另一半）：失败留在台账、结果不落画面、下一次 setScene 重新读资源
  // ─────────────────────────────────────────────────────────────────────────
  {
    const viewer = new BareViewer()
    const r0 = viewer.viewer.setScene(plantScene(SCENE_A, REVISION - 1, [0, 0, 0])) as Promise<void>
    viewer.failRead("glb://plant", "GLB_READ_FAILED: 资源读取失败")
    const r0State = await settleState(r0, 300)
    const failed = viewer.viewer.loadingErrors.get("plant")
    check("failed_load_reports_through_the_ledger_and_leaves_no_visual",
      r0State === "settled" && String(failed ?? "").includes("GLB_READ_FAILED") && viewer.errors.length === 1 && viewer.childCount("plant") === 0 && viewer.viewer.objects.get("plant").group.userData.loaded !== true,
      `这次 setScene 的 promise 正常落地=${String(r0State === "settled")}（既有合同：失败由台账/onError 报告，不是让 setScene 抛）；台账=${String(failed)}；onError 收到=${String(viewer.errors.length)} 次；子对象数=${String(viewer.childCount("plant"))}（0＝失败的结果没有进画面）；userData.loaded=${String(viewer.viewer.objects.get("plant").group.userData.loaded)}（只有成功才置真）`)

    // 下一次 setScene（同资源、只改 transform）：必须**重新发起**读取，而不是拿上次的失败/在途当结果。
    const r1 = viewer.viewer.setScene(plantScene(SCENE_A, REVISION, [1, 0, 0])) as Promise<void>
    const r1Pending = await settleState(r1, 80)
    check("the_next_setScene_retries_the_resource_read",
      r1Pending === "pending" && viewer.readStarts === 2,
      `重试的 setScene 在资源回来前仍未完成=${String(r1Pending === "pending")}；累计发起的资源读取=${String(viewer.readStarts)} 次（2＝失败后确实又读了一次）`)
    viewer.deliverModel("glb://plant")
    await r1
    check("the_retry_can_succeed_and_clears_the_ledger",
      viewer.childCount("plant") === 1 && viewer.viewer.loadingErrors.size === 0 && viewer.viewer.objects.get("plant").group.userData.loaded === true && viewer.positionX("plant") === 1,
      `子对象数=${String(viewer.childCount("plant"))}（1＝这次进画面了）；失败台账=${String(viewer.viewer.loadingErrors.size)} 条（0＝成功即清）；userData.loaded=${String(viewer.viewer.objects.get("plant").group.userData.loaded)}；位移 x=${String(viewer.positionX("plant"))}`)
  }
  // ─────────────────────────────────────────────────────────────────────────
  // 15) 废弃的加载结果不落到新对象上：Viewer 已销毁，或这个 entityId 已经换成别的 Loaded
  // ─────────────────────────────────────────────────────────────────────────
  {
    const disposed = new BareViewer()
    const r0 = disposed.viewer.setScene(plantScene(SCENE_A, REVISION, [0, 0, 0])) as Promise<void>
    disposed.viewer.disposed = true // 等价于"资源还在读的时候 Viewer 被销毁"
    disposed.deliverModel("glb://plant")
    await r0
    check("a_disposed_viewer_does_not_take_the_stale_visual",
      disposed.childCount("plant") === 0 && disposed.viewer.objects.get("plant").group.userData.loaded !== true,
      `销毁后回来的结果没有挂进对象：子对象数=${String(disposed.childCount("plant"))}（应为 0）；userData.loaded=${String(disposed.viewer.objects.get("plant").group.userData.loaded)}`)

    // 真实的"换资源"（不是手工替换 objects 条目）：A 还在读的时候同一个实体换成资源 B，
    // 签名变了 ⇒ 走 setScene 里的 release + 新 Loaded，A 的结果回来时归属已经不符。
    const replaced = new BareViewer()
    const rA = replaced.viewer.setScene(plantScene(SCENE_A, REVISION - 1, [0, 0, 0], "glb://plant-a")) as Promise<void>
    const staleGroup = replaced.group("plant") // 换资源前的那个对象（要被释放的旧 Loaded）
    const rB = replaced.viewer.setScene(plantScene(SCENE_A, REVISION, [1, 0, 0], "glb://plant-b")) as Promise<void>
    const swapped = replaced.viewer.objects.get("plant").group !== staleGroup
    replaced.deliverModel("glb://plant-a") // A 迟到成功：不能挂到新对象上，也不该堆在被释放的旧对象上
    await rA
    check("a_load_that_lost_its_entity_does_not_attach_to_the_replacement",
      swapped && replaced.childCount("plant") === 0 && staleGroup.children.length === 0 && replaced.viewer.objects.get("plant").group.userData.loaded !== true,
      `换资源后确实换了对象=${String(swapped)}；新对象的子对象数=${String(replaced.childCount("plant"))}（应为 0，B 自己的加载还没完成）；被释放的那个旧对象上的子对象数=${String(staleGroup.children.length)}（应为 0：旧结果就地丢弃，不堆在没人渲染、也没人会释放的对象上）；新对象 userData.loaded=${String(replaced.viewer.objects.get("plant").group.userData.loaded)}`)
    void rB // B 的这次读取留作在途（本节只需要"A 的结果被丢弃"这一个事实）
  }
  // ─────────────────────────────────────────────────────────────────────────
  // 16) 定向观察请求的出队只能由目标窗口自己确认（Gap B）
  //     反例：先按 ids 滤队列、再核对 clientId ⇒ 同会话别的窗口一句确认就把请求删了，
  //     目标窗口下一轮再也看不到它：既不会拍、也没有结论，只能一路等到 15s 超时。
  // ─────────────────────────────────────────────────────────────────────────
  {
    const target = new SimWindow(harness, SESSION_A, "window-9")
    /** 同会话的另一个窗口：本节只用到它的 clientId（冒充确认的来源）。 */
    const otherClientId = "window-8"
    await target.heartbeat()
    const readQueue = async () => (await harness.state(SESSION_A, target.clientId, { sceneId: SCENE_A, revision: REVISION })).uiActions ?? []
    const controller = new AbortController()
    const pending = harness.tool(SESSION_A, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: target.clientId } }, { signal: controller.signal })
    await sleep(40)
    const observeId = (await readQueue()).find(item => item.action === "captureViewer")?.id ?? ""
    // 别的窗口用顶层 clientId 确认一次：
    const ackA = await harness.command(SESSION_A, "ui_action_ack", { ids: [observeId], clientId: otherClientId }) as { acked?: number }
    const queuedA = (await readQueue()).some(item => item.id === observeId)
    const pendingA = await settleState(pending, 150)
    // 再用"结果行里带自己的 clientId"（前端报失败的那种形式）确认一次：
    const ackB = await harness.command(SESSION_A, "ui_action_ack", { ids: [observeId], results: [{ id: observeId, ok: false, error: "VIEWER_OBSERVE_SCENE_NOT_LOADED: 伪造的失败原因", clientId: otherClientId }] }) as { acked?: number }
    const queuedB = (await readQueue()).some(item => item.id === observeId)
    const pendingB = await settleState(pending, 150)
    check("another_window_ack_neither_dequeues_nor_settles_the_request",
      queuedA && queuedB && pendingA === "pending" && pendingB === "pending",
      `别的窗口确认后请求仍在队列里=${String(queuedA)}/${String(queuedB)}（都应为 true：目标窗口下一轮还看得见它，ack 回执=${String(ackA.acked)}/${String(ackB.acked)}）；观察仍在等=${String(pendingA === "pending")}/${String(pendingB === "pending")}（都应为 true）`)
    // 目标窗口自己确认（这一次没有采集、也没有任何结论）：请求才出队。
    await harness.command(SESSION_A, "ui_action_ack", { ids: [observeId], clientId: target.clientId })
    const queuedAfterOwner = (await readQueue()).some(item => item.id === observeId)
    const pendingAfterOwner = await settleState(pending, 150)
    check("the_owner_window_ack_dequeues_while_the_observation_keeps_waiting",
      !queuedAfterOwner && pendingAfterOwner === "pending",
      `目标窗口确认后请求已出队=${String(!queuedAfterOwner)}；此刻观察仍在等（没有采集、没有 settle，出队只可能来自这条 ack）=${String(pendingAfterOwner === "pending")}`)
    controller.abort()
    const aborted = await settleState(pending, 1000)
    check("aborting_after_the_owner_ack_still_ends_the_wait_cleanly",
      aborted === "settled",
      `中止后等待结束=${String(aborted === "settled")}（队列里那条已被目标窗口取走，不会留下无人认领的动作）`)
    // 正向路径的另一半：目标窗口**只带结果行**（顶层不带 clientId，旧前端就是这样）也能确认出队。
    const controller2 = new AbortController()
    const pending2 = harness.tool(SESSION_A, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: target.clientId } }, { signal: controller2.signal })
    await sleep(40)
    const observeId2 = (await readQueue()).find(item => item.action === "captureViewer")?.id ?? ""
    await harness.command(SESSION_A, "ui_action_ack", { ids: [observeId2], results: [{ id: observeId2, ok: true, clientId: target.clientId }] })
    const queuedAfterRowForm = (await readQueue()).some(item => item.id === observeId2)
    const pendingAfterRowForm = await settleState(pending2, 150)
    check("owner_window_ack_with_only_a_result_row_also_dequeues",
      !queuedAfterRowForm && pendingAfterRowForm === "pending",
      `目标窗口只用结果行确认后请求已出队=${String(!queuedAfterRowForm)}；观察仍在等（这次没有采集，ok:true 不结束等待）=${String(pendingAfterRowForm === "pending")}`)
    controller2.abort()
    await settleState(pending2, 1000)
    // 普通界面动作的兼容性：同会话里任何一个窗口确认都能出队（既有行为不变）。
    const action = textValue(await harness.tool(SESSION_A, "ui_action", { input: { action: "openTool", tool: "scene" } })) as { queued?: string }
    const actionId = String(action.queued ?? "")
    await harness.command(SESSION_A, "ui_action_ack", { ids: [actionId], clientId: otherClientId })
    const plainGone = actionId !== "" && !(await readQueue()).some(item => item.id === actionId)
    check("plain_ui_action_ack_still_dequeues_from_another_window",
      plainGone,
      `普通界面动作被另一个窗口确认后已出队=${String(plainGone)}（id=${actionId}）`)
  }
  // ─────────────────────────────────────────────────────────────────────────
  // 17) 迟到的失败不许写进新实体的台账：R0 的资源 A 还在读的时候，同一个实体换成资源 B（签名变 ⇒ 新 Loaded，
  //     A 被释放），B 先成功、A 后失败。失败侧若不核对归属，A 的旧错误会落进同一个 entityId 的 loadingErrors；
  //     而 B 已经 loaded=true ⇒ 后续 setScene 直接跳过加载、也就永远不清这条台账 ⇒ viewer_observe 会
  //     **永久拒绝**一个实际已经完整的画面。这一步用真实 setScene 跑完整段，并让窗口真的观察一次 R1。
  // ─────────────────────────────────────────────────────────────────────────
  {
    const viewer = new BareViewer()
    const window = new SimWindow(harness, SESSION_B, "window-b10")
    window.readyTimeoutMs = 400
    window.entityIds = ["plant"]
    window.ledger = viewer.viewer.loadingErrors
    window.probe = () => viewer.childCount("plant")
    await window.heartbeat()

    const r0 = viewer.viewer.setScene(plantScene(SCENE_A, REVISION - 1, [0, 0, 0], "glb://plant-a")) as Promise<void>
    window.trackScene(SCENE_A, REVISION - 1, r0)
    const r1 = viewer.viewer.setScene(plantScene(SCENE_A, REVISION, [1, 0, 0], "glb://plant-b")) as Promise<void>
    window.trackScene(SCENE_A, REVISION, r1)
    // B 先到：这一次加载真的完成——模型进画面、userData.loaded 置真（后面 setScene 会据此跳过加载）。
    viewer.deliverModel("glb://plant-b")
    await r1
    const tookB = viewer.childCount("plant") === 1 && viewer.viewer.objects.get("plant").group.userData.loaded === true
    // A 之后才失败：它属于已经被换掉的那次加载，与新实体无关。
    viewer.failRead("glb://plant-a", "GLB_READ_FAILED: 资源 A 读不起来（这次加载已经被换掉了）")
    await r0
    check("a_late_failure_from_the_replaced_resource_does_not_pollute_the_ledger",
      tookB && viewer.viewer.loadingErrors.size === 0 && viewer.errors.length === 0 && viewer.childCount("plant") === 1,
      `B 先加载成功=${String(tookB)}（模型已进画面、userData.loaded 置真）；随后 A 的旧失败后：失败台账=${String(viewer.viewer.loadingErrors.size)} 条（应为 0：旧结果的失败不记到新实体名下）；onError 回执=${String(viewer.errors.length)} 次（应为 0）；画面里子对象数=${String(viewer.childCount("plant"))}（B 的模型仍在）`)

    // 台账干净 ⇒ 这一版现在真的能观察（正是"永久拒绝"分支的反面）；采集那一刻画面里是 B 的模型。
    const raced = await drive(harness.tool(SESSION_B, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-b10" } }), [window], { maxMs: 4000 })
    const result = "value" in raced ? raced.value : undefined
    const payload = result ? textValue(result) : {}
    check("the_swapped_in_revision_stays_observable_after_the_stale_failure",
      Boolean(result && !result.isError) && window.frames === 1 && window.captures.length === 1 && window.probes[0] === 1 && payload.sceneRevision === REVISION,
      result?.isError ? failureMessage(result) : `观察成立：rev=${String(payload.sceneRevision)}；采集次数=${String(window.frames)}；采集那一刻该实体的子对象数=${String(window.probes[0])}（1＝B 的模型真的在画面里）`)
  }
  // ─────────────────────────────────────────────────────────────────────────
  // 18) ui_action selectScene（带 sceneId）：让模型能切到导入进来的第二个场景，走 workbench 已有的 loadScene
  //     路径（与用户下拉框同源）。本节真正跑产品代码的是**工具注册与校验、队列、ui_action_ack、
  //     viewer_observe 的采集判定**；窗口侧是模拟窗口（对齐 workbench.tsx 的消费分支，见 SimWindow.loadScene
  //     的边界说明），真实页面里"切过去、加载完、画面真的换了"由 root 的真 UI 复验负责。
  // ─────────────────────────────────────────────────────────────────────────
  {
    const window = new SimWindow(harness, SESSION_A, "window-12")
    await window.heartbeat()
    const readQueue = async () => (await harness.state(SESSION_A, window.clientId, { sceneId: window.sceneId, revision: window.revision })).uiActions ?? []

    // ① 参数缺失 / 未知场景：在真实注册的工具上明确失败，不静默排队。
    const missing = await harness.tool(SESSION_A, "ui_action", { input: { action: "selectScene" } })
    const unknown = await harness.tool(SESSION_A, "ui_action", { input: { action: "selectScene", sceneId: "scene-not-imported" } })
    check("selectScene_without_sceneId_or_with_an_unknown_scene_fails_explicitly",
      missing.isError && failureMessage(missing).includes("UI_ACTION_SCENE_REQUIRED") && unknown.isError && failureMessage(unknown).includes("UI_ACTION_SCENE_UNKNOWN") && failureMessage(unknown).includes(SCENE_A) && failureMessage(unknown).includes(SCENE_B),
      `缺 sceneId=${missing.isError ? failureMessage(missing) : "（没有报错）"}；未知 sceneId=${unknown.isError ? failureMessage(unknown) : "（没有报错）"}（应列出清单里真实存在的场景：${SCENE_A}、${SCENE_B}）`)

    // ② 窗口还显示着旧场景时，请求"观察新场景"必须明确失败：排队/界面动作都不是"已经显示"的证据。
    const early = await drive(harness.tool(SESSION_A, "viewer_observe", { input: { sceneId: SCENE_B, expectedRevision: 1, clientId: window.clientId } }), [window], { maxMs: 4000 })
    const earlyResult = "value" in early ? early.value : undefined
    check("the_window_that_still_shows_the_old_scene_is_no_evidence_for_the_new_one",
      Boolean(earlyResult?.isError) && failureMessage(earlyResult!).includes("VIEWER_OBSERVE_SCENE_NOT_LOADED") && failureMessage(earlyResult!).includes(SCENE_A) && window.frames === 0,
      `工具错误=${earlyResult?.isError ? failureMessage(earlyResult!) : "（没有报错）"}；采集次数=${String(window.frames)}（应为 0：窗口显示的还是 ${SCENE_A}，这张图没有被拍）`)

    // ③ 合法场景 id：入队；回执只承认"排进了队列"，不带任何"已显示"字段。
    const queued = await harness.tool(SESSION_A, "ui_action", { input: { action: "selectScene", sceneId: SCENE_B } })
    const receipt = queued.isError ? {} : textValue(queued)
    const entry = (await readQueue()).find(item => item.id === receipt.queued)
    check("selectScene_receipt_only_says_the_action_was_queued",
      !queued.isError && Object.keys(receipt).sort().join() === "action,note,queued" && receipt.action === "selectScene" && String(receipt.note ?? "").includes("viewer_observe") && entry?.action === "selectScene" && entry.args.sceneId === SCENE_B && window.sceneId === SCENE_A,
      `回执键=${Object.keys(receipt).join("/")}（只有 queued/action/note：没有 sceneId/displayed 之类"已显示"的字段，note 指向 viewer_observe）；队列里这条=${JSON.stringify(entry)}；此刻窗口显示的还是 ${window.sceneId}（排队＝还没显示）`)

    // ④ 窗口取走动作（对齐 workbench：与用户下拉框同一条 loadScene 路径）之后，新场景才拍得出来。
    await window.poll()
    const taken = (await readQueue()).some(item => item.id === receipt.queued)
    const raced = await drive(harness.tool(SESSION_A, "viewer_observe", { input: { sceneId: SCENE_B, expectedRevision: 1, clientId: window.clientId } }), [window], { maxMs: 4000 })
    const result = "value" in raced ? raced.value : undefined
    const payload = result ? textValue(result) : {}
    check("after_the_window_takes_the_action_the_new_scene_is_observable",
      !taken && Boolean(result && !result.isError) && payload.sceneId === SCENE_B && payload.sceneRevision === 1 && window.sceneId === SCENE_B && window.frames === 1,
      result?.isError ? failureMessage(result) : `动作已出队=${String(!taken)}；窗口显示=${window.sceneId}；观察成立：sceneId=${String(payload.sceneId)} rev=${String(payload.sceneRevision)}；采集次数=${String(window.frames)}（②里那张没拍）`)

    // ⑤ 与 ACK 相容：普通动作的确认（哪怕带失败行）既不被当成观察的结论、也不结束等待；它只按 id 出队自己那条。
    const switchBack = textValue(await harness.tool(SESSION_A, "ui_action", { input: { action: "selectScene", sceneId: SCENE_A } })) as { queued?: string }
    const pending = harness.tool(SESSION_A, "viewer_observe", { input: { sceneId: SCENE_B, expectedRevision: 1, clientId: window.clientId } })
    await sleep(40)
    await harness.command(SESSION_A, "ui_action_ack", { ids: [String(switchBack.queued ?? "")], results: [{ id: String(switchBack.queued ?? ""), ok: false, error: "UI_ACTION_SCENE_UNKNOWN: 伪造的失败原因", clientId: window.clientId }] })
    const stillPending = await settleState(pending, 150)
    const switchGone = !(await readQueue()).some(item => item.id === switchBack.queued)
    const raced2 = await drive(pending, [window], { maxMs: 4000 })
    const result2 = "value" in raced2 ? raced2.value : undefined
    const payload2 = result2 ? textValue(result2) : {}
    check("a_plain_action_ack_neither_settles_nor_stands_in_for_the_observation",
      stillPending === "pending" && switchGone && Boolean(result2 && !result2.isError) && payload2.sceneId === SCENE_B && window.sceneId === SCENE_B && window.frames === 2,
      `普通动作的失败行之后观察仍在等=${String(stillPending === "pending")}；那条动作按 id 出队了=${String(switchGone)}（既有行为）；随后窗口自己拍到的还是请求的 ${String(payload2.sceneId)}；窗口显示=${window.sceneId}（没被那条确认切走）；采集次数=${String(window.frames)}`)

    // ⑥ 与观察队列相容：同一条队列里"先切场景、再观察"时，观察要么拍到请求的那一版、要么明确失败——
    //    绝不拿切换后的画面顶替（这正是"排队≠显示"在竞争下的形态）。
    const switchAway = textValue(await harness.tool(SESSION_A, "ui_action", { input: { action: "selectScene", sceneId: SCENE_A } })) as { queued?: string }
    const raced3 = await drive(harness.tool(SESSION_A, "viewer_observe", { input: { sceneId: SCENE_B, expectedRevision: 1, clientId: window.clientId } }), [window], { maxMs: 4000 })
    const result3 = "value" in raced3 ? raced3.value : undefined
    const leftOver = (await readQueue()).length
    check("a_scene_switch_in_the_same_batch_cannot_stand_in_for_the_observation",
      Boolean(result3?.isError) && failureMessage(result3!).includes("VIEWER_OBSERVE_SCENE_NOT_LOADED") && failureMessage(result3!).includes(SCENE_A) && window.sceneId === SCENE_A && window.frames === 2 && leftOver === 0,
      `工具错误=${result3?.isError ? failureMessage(result3!) : "（没有报错）"}；窗口被切到=${window.sceneId}；采集次数=${String(window.frames)}（没拿切过去的画面顶替）；队列剩余=${String(leftOver)} 条（切场景与观察两条都被消费；被切走的那条=${String(switchAway.queued) !== "" ? "已出队" : "（没有入队）"}）`)
  }
  // ─────────────────────────────────────────────────────────────────────────
  // 19) 缺件警告 ≠ 加载失败（P1-1）：可用但不完整的画面照样拍得出来，结果里必须写明少了什么；
  //     同一个实体换成"真失败"时仍然是明确拒绝、一次都不拍。
  // ─────────────────────────────────────────────────────────────────────────
  {
    // ① 真实加载生命周期：机器人引用了一个不存在的 mesh ⇒ 成功、画面里有它，缺件记在 `visualWarnings`，失败台账是空的。
    const viewer = new BareViewer()
    const box = new SimWindow(harness, SESSION_A, "window-a1")
    box.entityIds = ["robot-1"]
    box.ledger = viewer.viewer.loadingErrors
    box.warningLedger = viewer.viewer.visualWarnings
    await box.heartbeat()
    const loaded = viewer.viewer.setScene(robotScene(SCENE_A, REVISION)) as Promise<void>
    box.trackScene(SCENE_A, REVISION, loaded)
    await loaded
    const warnings: string[] = viewer.viewer.visualWarnings.get("robot-1") ?? []
    check("a_missing_mesh_is_a_warning_on_a_real_load_not_a_failure",
      viewer.viewer.loadingErrors.size === 0 && warnings.some(warning => warning.includes("MESH_ASSET_MISSING: link0_vis")) && viewer.childCount("robot-1") >= 1,
      `失败台账=${JSON.stringify(Object.fromEntries(viewer.viewer.loadingErrors))}（空＝这次加载是成功的）；缺件警告=${JSON.stringify(warnings)}；实体组子对象数=${String(viewer.childCount("robot-1"))}（机器人确实进了画面）`)

    // ② 有警告的场景**照样能拍**：图给模型，同时显式说明"可用但不完整、缺的是哪一部分"。
    const raced = await drive(harness.tool(SESSION_A, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-a1" } }), [box], { maxMs: 4000 })
    const result = "value" in raced ? raced.value : undefined
    const payload = result ? textValue(result) : {}
    const rows = (payload.visualWarnings ?? []) as Array<{ entityId?: string; warning?: string }>
    check("a_warned_scene_is_still_observable_with_the_warning_attached",
      Boolean(result && !result.isError) && box.frames === 1 && payload.partial === true && rows.some(row => row.entityId === "robot-1" && String(row.warning).includes("MESH_ASSET_MISSING: link0_vis")) && String(payload.note).includes("不完整"),
      result?.isError ? failureMessage(result) : `观察成立（采集次数=${String(box.frames)}）；partial=${String(payload.partial)}；visualWarnings=${JSON.stringify(rows)}；note 里说明了不完整=${String(String(payload.note).includes("不完整"))}`)

    // ③ 对照：同一个实体换成**真加载失败**（台账里有它）⇒ 明确拒绝、一次都不拍、也不落盘。
    const failed = new SimWindow(harness, SESSION_A, "window-a2")
    failed.entityIds = ["robot-1"]
    failed.loadingErrors.set("robot-1", "GLB_READ_FAILED: 资源读取失败")
    failed.visualWarnings.set("robot-1", ["MESH_ASSET_MISSING: link0_vis"])
    await failed.heartbeat()
    const before = (await harness.storedCaptures()).length
    const raced2 = await drive(harness.tool(SESSION_A, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-a2" } }), [failed], { maxMs: 4000 })
    const refused = "value" in raced2 ? raced2.value : undefined
    check("the_same_picture_with_a_real_failure_is_still_refused",
      Boolean(refused?.isError) && failureMessage(refused!).includes("VIEWER_OBSERVE_SCENE_LOAD_FAILED") && failureMessage(refused!).includes("robot-1") && failed.frames === 0 && (await harness.storedCaptures()).length === before,
      `工具错误=${refused?.isError ? failureMessage(refused!) : "（没有报错）"}；采集次数=${String(failed.frames)}（应为 0，失败就是失败）；新增落盘=${String((await harness.storedCaptures()).length - before)} 份（应为 0）`)

    // ④ 警告归属随 `Loaded` 走：换成"没有缺件"的同一实体（签名变了⇒重载）旧警告消失；实体被移出场景也消失。
    const healthy = viewer.viewer.setScene(robotScene(SCENE_A, REVISION + 1, { mesh: false })) as Promise<void>
    await healthy
    check("a_reload_without_missing_parts_clears_the_old_warning",
      viewer.viewer.visualWarnings.size === 0 && viewer.viewer.loadingErrors.size === 0 && viewer.childCount("robot-1") >= 1,
      `重载（同一实体、不再引用缺失 mesh）之后：缺件警告=${JSON.stringify([...viewer.viewer.visualWarnings])}（应为空）；失败台账=${String(viewer.viewer.loadingErrors.size)} 条；实体组子对象数=${String(viewer.childCount("robot-1"))}`)
    const removed = viewer.viewer.setScene({ ...plantScene(SCENE_A, REVISION + 2, [0, 0, 0]), entities: [] } as SceneSnapshot) as Promise<void>
    await removed
    check("a_warning_does_not_outlive_its_entity",
      viewer.viewer.visualWarnings.size === 0 && !viewer.viewer.objects.has("robot-1"),
      `实体被移出场景之后：缺件警告=${JSON.stringify([...viewer.viewer.visualWarnings])}（应为空）；该实体还在物体表里=${String(viewer.viewer.objects.has("robot-1"))}`)
  }
  // ─────────────────────────────────────────────────────────────────────────
  // 20) 取消发生在 `await sceneSnapshot` 期间（P2-1）：那次取消不能漏掉，否则监听登记不上、白等满 15 秒
  // ─────────────────────────────────────────────────────────────────────────
  {
    const window = new SimWindow(harness, SESSION_C, "window-c9")
    await window.heartbeat()
    const held = harness.holdSceneSnapshot()
    const controller = new AbortController()
    const pending = harness.tool(SESSION_C, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-c9" } }, { signal: controller.signal })
    // 有界地等"它真的进到了那次 await"：万一将来改坏成"快照之前就返回"，这里不会把整份测试挂死。
    const reachedSnapshot = await Promise.race([held.arrived.then(() => true), sleep(1000).then(() => false)])
    const duringHold = await settleState(pending, 50)
    controller.abort()                      // 取消就发生在这段在途时间里
    await sleep(30)
    if ((await settleState(pending, 10)) === "settled") throw new Error("取消在快照期间没有生效？")
    held.release()
    const started = Date.now()
    const raced = await drive(pending, [], { maxMs: 2000 })
    const elapsed = Date.now() - started
    const result = "value" in raced ? raced.value : undefined
    const queued = (await harness.state(SESSION_C, "window-c9", {})).uiActions?.length ?? 0
    check("cancel_during_the_scene_snapshot_ends_right_away_without_queueing",
      reachedSnapshot && duringHold === "pending" && Boolean(result?.isError) && failureMessage(result!).includes("VIEWER_OBSERVE_ABORTED") && elapsed < 1000 && queued === 0 && window.captures.length === 0,
      `取消发生在"等场景快照"（已进到那次 await=${String(reachedSnapshot)}）；放行后 ${String(elapsed)} ms 结束（<1000＝没有登记监听白等满 15 秒）：${failureMessage(result!)}；队列剩余=${String(queued)} 条（0＝根本没有排队、没有登记等待者）；该窗口采集次数=${String(window.captures.length)}`)
  }
  // ─────────────────────────────────────────────────────────────────────────
  // 21) 回传迟到 / 在途过期（P2-2）：不落盘，也不报告 settled=true
  // ─────────────────────────────────────────────────────────────────────────
  {
    // ① 观察已经结束（取消）之后才到的回传：同一 observeId，什么都不做。
    const window = new SimWindow(harness, SESSION_C, "window-c8")
    await window.heartbeat()
    const controller = new AbortController()
    const pending = harness.tool(SESSION_C, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-c8" } }, { signal: controller.signal })
    await sleep(60)
    const observeId = (await harness.state(SESSION_C, "window-c8", {})).uiActions?.find(item => item.action === "captureViewer" && item.args.clientId === "window-c8")?.id
    controller.abort()
    await drive(pending, [])
    const before = (await harness.storedCaptures()).length
    const late = await window.postCapture({ sceneId: SCENE_A, sceneRevision: REVISION, clientId: "window-c8", observeId }) as { saved?: boolean; observe?: { matched?: boolean; settled?: boolean; refused?: string } }
    check("a_capture_after_the_observation_is_gone_is_not_written",
      late.saved === false && late.observe?.matched === false && late.observe?.settled === false && String(late.observe?.refused ?? "").includes("VIEWER_OBSERVE_NOT_ACTIVE") && (await harness.storedCaptures()).length === before,
      `迟到回执 saved=${String(late.saved)}（false＝没落盘）；observe=${JSON.stringify(late.observe ?? null)}（settled 必须是 false：请求已经过期）；captureRoot 下新增 ${String((await harness.storedCaptures()).length - before)} 份（应为 0）`)

    // ② 对照：没有 `observeId` 的普通采集（用户在工作台点"采集图像"）一点没变——照常落盘、回执里带 captureId。
    const beforePlain = (await harness.storedCaptures()).length
    const plain = await window.postCapture({ sceneId: SCENE_A, sceneRevision: REVISION, clientId: "window-c8" }) as { captureId?: string; saved?: boolean }
    check("a_plain_capture_without_an_observation_id_is_still_saved",
      typeof plain.captureId === "string" && plain.saved === undefined && (await harness.storedCaptures()).length === beforePlain + 1,
      `普通采集回执 captureId=${String(plain.captureId)}、没有观察专用的 saved/observe 字段=${String(plain.saved === undefined)}；captureRoot 下新增 ${String((await harness.storedCaptures()).length - beforePlain)} 份（应为 1）`)

    // ③ 回传自己在途时观察结束（这里用场景快照的 await 把它卡住）：恢复后仍然不落盘，也绝不报 settled=true。
    const window2 = new SimWindow(harness, SESSION_C, "window-c7")
    await window2.heartbeat()
    const controller2 = new AbortController()
    const pending2 = harness.tool(SESSION_C, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-c7" } }, { signal: controller2.signal })
    await sleep(60)
    const observeId2 = (await harness.state(SESSION_C, "window-c7", {})).uiActions?.find(item => item.action === "captureViewer" && item.args.clientId === "window-c7")?.id
    const held = harness.holdSceneSnapshot()
    const posted = window2.postCapture({ sceneId: SCENE_A, sceneRevision: REVISION, clientId: "window-c7", observeId: observeId2 })
    // 有界地等"回传真的进到了那次 await"：它若在快照之前就被拒（例如队列里混进了别人的动作），这里也不会挂死测试。
    const postedAtSnapshot = await Promise.race([held.arrived.then(() => true), sleep(1000).then(() => false)])
    controller2.abort()                                 // 就在这段在途时间里，观察被取消
    await drive(pending2, [])
    const before2 = (await harness.storedCaptures()).length
    held.release()
    const receipt = await posted.catch((error: unknown) => ({ error: String(error) })) as { saved?: boolean; observe?: { matched?: boolean; settled?: boolean; refused?: string }; error?: string }
    check("a_capture_that_expires_mid_flight_neither_writes_nor_reports_settled",
      postedAtSnapshot && receipt.saved === false && receipt.observe?.settled === false && String(receipt.observe?.refused ?? "").includes("VIEWER_OBSERVE_NOT_ACTIVE") && (await harness.storedCaptures()).length === before2,
      `回传停在了"等场景快照"=${String(postedAtSnapshot)}；回执 saved=${String(receipt.saved)}（false＝在途过期后不落盘）；observe=${JSON.stringify(receipt.observe ?? null)}（settled=false：不能报告"这次等待被它结束了"）；captureRoot 下新增 ${String((await harness.storedCaptures()).length - before2)} 份（应为 0）；回执错误=${String(receipt.error ?? "（无）")}`)
  }
  // ─────────────────────────────────────────────────────────────────────────
  // 22) 取消发生在 `await attachments.saveImage` 期间（2026-09-20 审查报的第三个在途窗口）：
  // 附件化之后还要再核一次观察——记录与位姿一分都不写，回执 saved:false + settled:false。
  // ─────────────────────────────────────────────────────────────────────────
  {
    const window = new SimWindow(harness, SESSION_C, "window-c6")
    await window.heartbeat()
    const controller = new AbortController()
    const pending = harness.tool(SESSION_C, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-c6" } }, { signal: controller.signal })
    await sleep(60)
    const observeId = (await harness.state(SESSION_C, "window-c6", {})).uiActions?.find(item => item.action === "captureViewer" && item.args.clientId === "window-c6")?.id
    const held = harness.holdSaveImage()
    const before = (await harness.listCaptures()).length
    const posted = window.postCapture({ sceneId: SCENE_A, sceneRevision: REVISION, clientId: "window-c6", observeId })
    // 有界地等"回传真的进到了附件化"：万一它更早就被拒（或将来改坏成不落盘），这里也不会把整份测试挂死。
    const atAttachment = await Promise.race([held.arrived.then(() => true), sleep(1000).then(() => false)])
    controller.abort()                      // 取消就发生在这段附件编码的在途时间里
    await drive(pending, [])
    held.release()
    const receipt = await posted.catch((error: unknown) => ({ error: String(error) })) as { saved?: boolean; observe?: { matched?: boolean; settled?: boolean; refused?: string }; error?: string }
    const after = (await harness.listCaptures()).length
    check("cancel_during_the_attachment_step_leaves_no_capture_record",
      atAttachment && receipt.saved === false && receipt.observe?.matched === false && receipt.observe?.settled === false && String(receipt.observe?.refused ?? "").includes("VIEWER_OBSERVE_NOT_ACTIVE") && after === before,
      `回传停在了"附件编码"=${String(atAttachment)}（=真进到了 await saveImage，不是更早的拒绝）；期间取消后：回执 saved=${String(receipt.saved)}（false＝不落盘）；observe=${JSON.stringify(receipt.observe ?? null)}（settled=false：观察已经结束，不能算成本次结果）；captureRoot 下文件数 ${String(before)} → ${String(after)}（含位姿文件，应不变＝没有孤儿记录/位姿）；回执错误=${String(receipt.error ?? "（无）")}`)
  }
  // ─────────────────────────────────────────────────────────────────────────
  // 23) 相机：把一台指定相机（照片机位 + 内参，带 roll）摆进窗口、按它出图，并挡住那些"看起来像"的
  // 替代品（旧前端拿画布截图顶替、读数与像素对不上）。相机数学是产品同一份（`viewer/src/camera-view.ts`），
  // 底下是真实 three 相机 + 真实 OrbitControls；替身只在两处（见 SimCamera 注释）：画布像素固定、
  // 出图是自己编码的同尺寸 PNG。像素本身长什么样由 root 在真浏览器里按 40 的相机验收。
  // ─────────────────────────────────────────────────────────────────────────
  {
    /** 照片相机：主点偏心、fx≠fy，位姿带 roll（`camera_fit` 那类输出的形状）。 */
    const PHOTO: ViewerCameraIntrinsics = { fx: 1380, fy: 1362, cx: 934, cy: 558, width: 1920, height: 1080 }
    const CANVAS = { width: 1280, height: 720 }
    const ROLL = 26.5
    const photoOnCanvas = scaleIntrinsics(PHOTO, CANVAS.width, CANVAS.height)
    const photo = photoRequest(ROLL, PHOTO)
    const window = new SimWindow(harness, SESSION_C, "window-cam1")
    window.camera = new SimCamera(window)
    const other = new SimWindow(harness, SESSION_C, "window-cam2")
    other.camera = new SimCamera(other)
    /**
     * 场景文档的 rev：把命名相机存进文档是**一次提交**，rev 会随之推进（真实产品同样如此）。
     * 后面每条工具调用都按窗口**当前**显示的 rev 发——真实模型也要先读新 rev 再动手，
     * 这里不写死一个"永远 4"的假常量（写死就测不出 CAS 与过期判断）。
     */
    const rev = () => window.revision
    /**
     * 读**任意**场景的文档（`state` 路由的 `sceneId` 参数，与窗口正在显示哪一版无关）：
     * 命名相机是场景内容，所以"它在哪个场景里"要能直接问文档，而不是问某个窗口记了什么。
     */
    const documentOf = async (sceneId: string): Promise<{ sceneId: string; revision: number; entities: Array<{ entityId: string; components?: Record<string, unknown> }> }> => {
      const value = await harness.state(SESSION_C, "window-cam1", { sceneId: window.sceneId, revision: window.revision }, sceneId)
      const scene = value.scene as { sceneId: string; revision: number; entities?: Array<{ entityId: string; components?: Record<string, unknown> }> } | undefined
      if (!scene) throw new Error(`SCENE_NOT_FOUND: ${sceneId}`)
      return { ...scene, entities: scene.entities ?? [] }
    }
    await window.heartbeat()
    await other.heartbeat()

    // —— 应用相机：回执是"应用后当场量到的"，窗口里的相机真的动了，镜头也换成照片 K（按画布尺寸缩放）——
    const applied = (await drive(harness.tool(SESSION_C, "viewer_camera_apply", { input: { sceneId: SCENE_A, expectedRevision: rev(), clientId: "window-cam1", ...photo, saveAs: "photo-A" } }), [window])).value
    const receipt = applied ? textValueOf(applied) as any : {}
    const live = window.camera.cameraView()
    const receiptPose = quaternionAngleDeg((receipt.camera?.quaternion ?? [0, 0, 0, 1]) as ViewerQuat, photo.quaternion)
    check("camera_apply_receipt_is_the_measured_camera",
      Boolean(applied && !applied.isError) && receipt.applied === true && receipt.clientId === "window-cam1" && receipt.sceneId === SCENE_A && receipt.expectedRevision === REVISION
        && Math.abs(Number(receipt.camera?.rollDeg) - ROLL) < 1e-3 && receiptPose < 1e-3 && Array.isArray(receipt.state?.quaternion) && Array.isArray(receipt.state?.position),
      applied?.isError ? failureOf(applied) : `applied=${String(receipt.applied)}；窗口=${String(receipt.clientId)}；场景=${String(receipt.sceneId)} rev ${String(receipt.expectedRevision)}；量到 roll=${Number(receipt.camera?.rollDeg).toFixed(4)}°（请求 ${String(ROLL)}°）；姿态与请求差 ${receiptPose.toExponential(2)}°；state 带 position/quaternion=${String(Array.isArray(receipt.state?.position) && Array.isArray(receipt.state?.quaternion))}`)
    check("camera_apply_moved_the_live_window_camera",
      window.cameraApplies === 1 && other.cameraApplies === 0 && Math.abs(live.rollDeg - ROLL) < 1e-3 && quaternionAngleDeg(live.quaternion, photo.quaternion) < 1e-3,
      `本窗口应用次数=${String(window.cameraApplies)}；窗口里量到 roll=${live.rollDeg.toFixed(4)}°、姿态与请求差 ${quaternionAngleDeg(live.quaternion, photo.quaternion).toExponential(2)}°；另一窗口被牵连=${String(other.cameraApplies !== 0)}（应为 false）`)
    const lens = intrinsicsDelta(receipt.camera?.intrinsics, photoOnCanvas)
    check("camera_apply_puts_the_photo_lens_on_the_canvas", lens.ok,
      applied?.isError ? failureOf(applied) : `照片 K fx=${String(PHOTO.fx)} fy=${String(PHOTO.fy)} @${String(PHOTO.width)}×${String(PHOTO.height)} 放到 ${String(CANVAS.width)}×${String(CANVAS.height)} 画布上：${lens.text}`)
    // saveAs 的落点必须是**场景文档**（不是本窗口的偏好）：回执里的 savedAs 与文档里的那一条同源，
    // 而且这次提交真的推进了 rev（CAS 提交过一次，不是"内存里记了一下"）。
    const savedDocument = namedCamerasOfScene((await window.sceneDocument()).entities)
    check("camera_apply_can_save_a_named_camera_into_the_scene_document",
      receipt.savedAs === "photo-A" && Array.isArray(receipt.savedNames) && receipt.savedNames.includes("photo-A")
        && savedDocument.cameras.some(row => row.name === "photo-A") && Boolean(savedDocument.carrier) && window.revision === REVISION + 1,
      `savedAs=${String(receipt.savedAs)}；savedNames=${JSON.stringify(receipt.savedNames ?? null)}；文档里的命名相机=${JSON.stringify(savedDocument.cameras.map(row => row.name))}（承载实体=${String(savedDocument.carrier)}）；场景 rev ${String(REVISION)}→${String(window.revision)}`)
    // 存不进去就不能回 savedAs：这次提交被场景侧拒绝（场景只读/官方场景/连接断了/存储失败都是这一下），
    // 整条调用就必须失败、文档一字未改——不许出现"相机应用成功、savedAs 也报了，只有文档没变"。
    // 用**另一个窗口**做这件事：本节的计数断言钉的是 window-cam1/cam2 各自的应用/出图次数。
    const refusing = new SimWindow(harness, SESSION_C, "window-cam4")
    refusing.camera = new SimCamera(refusing)
    await refusing.loadScene(SCENE_A)
    const beforeRefusedSave = JSON.stringify((await refusing.sceneDocument()).entities)
    refusing.writeRefusal = "SCENE_WRITE_REFUSED: 这个场景是只读的（提交被拒）"
    const refusedSave = (await drive(harness.tool(SESSION_C, "viewer_camera_apply", { input: { sceneId: SCENE_A, expectedRevision: refusing.revision, clientId: "window-cam4", ...photo, saveAs: "存不上的" } }), [refusing])).value
    const afterRefusedSave = JSON.stringify((await refusing.sceneDocument()).entities)
    const refusedText = refusedSave ? textValueOf(refusedSave) : {}
    check("a_save_that_cannot_be_committed_never_reports_savedAs",
      Boolean(refusedSave?.isError) && failureOf(refusedSave).includes("SCENE_WRITE_REFUSED") && refusedText?.savedAs === undefined && beforeRefusedSave === afterRefusedSave && refusing.cameraApplies === 1,
      refusedSave?.isError ? `提交被拒时：工具错误=${failureOf(refusedSave).slice(0, 130)}（回执里的 savedAs=${String(refusedText?.savedAs ?? "（没有，正确）")}）；文档 ${beforeRefusedSave === afterRefusedSave ? "一字未改" : "被改了"}；相机本身应用过 ${String(refusing.cameraApplies)} 次（失败的是"存"，不是"摆"）` : `没有失败、还回了 savedAs：${JSON.stringify(refusedText).slice(0, 160)}`)

    // —— 按指定相机出图：同一台 Viewer、同一个 scene，另一台相机与另一套像素尺寸 ——
    const beforeRender = (await harness.storedCaptures()).length
    const rendered = (await drive(harness.tool(SESSION_C, "viewer_render_camera", { input: { sceneId: SCENE_A, expectedRevision: rev(), clientId: "window-cam1", width: PHOTO.width, height: PHOTO.height, ...photo } }), [window])).value
    const shot = rendered ? textValueOf(rendered) as any : {}
    const afterRender = (await harness.storedCaptures()).length
    const shotImage = rendered && !rendered.isError ? imageBlock(rendered) : undefined
    const shotBytes = shotImage?.attachment ? await harness.attachmentBytes(shotImage.attachment as { attachmentId: string }) : Buffer.alloc(0)
    const expectedPng = Buffer.from(pngOfSize(PHOTO.width, PHOTO.height).slice("data:image/png;base64,".length), "base64")
    const shotRecord = typeof shot.captureId === "string" ? JSON.parse(await readFile(harness.capturePath(SESSION_C, `${String(shot.captureId)}.json`), "utf8")) as any : {}
    const shotLens = intrinsicsDelta(shot.cameraImage?.intrinsics, PHOTO)
    check("camera_render_is_a_camera_image_not_the_canvas",
      Boolean(rendered && !rendered.isError) && shot.source === "native-viewer-camera" && shot.cameraImage?.verified === true
        && shot.image?.width === PHOTO.width && shot.image?.height === PHOTO.height && shotImage?.attachment?.width === PHOTO.width && shotImage?.attachment?.height === PHOTO.height
        && shotBytes.equals(expectedPng) && shotRecord.source === "native-viewer-camera" && shotRecord.cameraImage?.verified === true && afterRender === beforeRender + 1,
      rendered?.isError ? failureOf(rendered) : `source=${String(shot.source)}；cameraImage.verified=${String(shot.cameraImage?.verified)}；image=${String(shot.image?.width)}×${String(shot.image?.height)}；附件=${String(shotImage?.attachment?.width)}×${String(shotImage?.attachment?.height)}（${String(shotBytes.length)} B，与窗口送出的同尺寸 PNG 逐字节一致=${String(shotBytes.equals(expectedPng))}）；落盘记录 source=${String(shotRecord.source)}、cameraImage.verified=${String(shotRecord.cameraImage?.verified)}；采集记录 ${String(beforeRender)}→${String(afterRender)} 份`)
    check("camera_render_intrinsics_and_pose_match_the_request",
      shotLens.ok && shot.cameraImage?.sourceIntrinsics?.fx === PHOTO.fx && shot.cameraImage?.sourceIntrinsicsScaledDeltaPx === 0 && Math.abs(Number(shot.camera?.rollDeg) - ROLL) < 1e-3,
      rendered?.isError ? failureOf(rendered) : `cameraImage.intrinsics：${shotLens.text}；sourceIntrinsics=${JSON.stringify(shot.cameraImage?.sourceIntrinsics ?? null)}；请求 K 按图片尺寸缩放后的差=${String(shot.cameraImage?.sourceIntrinsicsScaledDeltaPx)}；这张图自己的 roll=${Number(shot.camera?.rollDeg).toFixed(4)}°（请求 ${String(ROLL)}°）`)
    check("camera_render_does_not_screenshot_the_canvas_or_move_the_main_camera",
      window.frames === 0 && window.cameraRenders === 1 && Math.abs(window.camera.cameraView().rollDeg - ROLL) < 1e-3 && quaternionAngleDeg(window.camera.cameraView().quaternion, photo.quaternion) < 1e-3,
      `窗口拍帧次数=${String(window.frames)}（出图不该顺带截一次屏）；出图次数=${String(window.cameraRenders)}；主相机 roll=${window.camera.cameraView().rollDeg.toFixed(4)}°、姿态与请求差 ${quaternionAngleDeg(window.camera.cameraView().quaternion, photo.quaternion).toExponential(2)}°`)

    // —— `viewer_observe` 带相机：拍到的**仍是当前画布**（来源不变），但"摆的是哪台相机"有据可查 ——
    const observed = (await drive(harness.tool(SESSION_C, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: rev(), clientId: "window-cam1", camera: photo } }), [window])).value
    const observedPayload = observed ? textValueOf(observed) as any : {}
    const observedRecord = typeof observedPayload.captureId === "string" ? JSON.parse(await readFile(harness.capturePath(SESSION_C, `${String(observedPayload.captureId)}.json`), "utf8")) as any : {}
    check("observe_with_a_camera_is_still_a_canvas_screenshot",
      Boolean(observed && !observed.isError) && observedPayload.source === "native-viewer" && observedPayload.cameraImage === undefined && Boolean(observedPayload.appliedCamera) && typeof observedPayload.cameraNote === "string"
        && window.frames === 1 && observedRecord.source === "native-viewer",
      observed?.isError ? failureOf(observed) : `source=${String(observedPayload.source)}（应保持 native-viewer）；cameraImage=${String(observedPayload.cameraImage === undefined ? "（没有，正确）" : "出现了")}；appliedCamera=${JSON.stringify(observedPayload.appliedCamera?.cameraName ?? observedPayload.appliedCamera ?? null).slice(0, 120)}；cameraNote=${String(observedPayload.cameraNote ?? "").slice(0, 60)}…；落盘记录 source=${String(observedRecord.source)}；窗口拍帧次数=${String(window.frames)}`)

    // —— 命名相机：应用后存下来的那份状态，换一台相机摆过去之后还能一模一样地恢复 ——
    const away = await drive(harness.tool(SESSION_C, "viewer_camera_apply", { input: { sceneId: SCENE_A, expectedRevision: rev(), clientId: "window-cam1", position: [0, -2.6, 1.4], target: [0, 0, 0.5], fovYDeg: 58 } }), [window])
    const movedAway = window.camera.cameraView()
    const restored = (await drive(harness.tool(SESSION_C, "viewer_camera_apply", { input: { sceneId: SCENE_A, expectedRevision: rev(), clientId: "window-cam1", name: "photo-A" } }), [window])).value
    const restoredPayload = restored ? textValueOf(restored) as any : {}
    const restoredLive = window.camera.cameraView()
    check("a_named_camera_restores_that_exact_view",
      Boolean(restored && !restored.isError) && restoredPayload.usedName === "photo-A" && Math.abs(movedAway.rollDeg - ROLL) > 1
        && Math.abs(restoredLive.rollDeg - ROLL) < 1e-3 && quaternionAngleDeg(restoredLive.quaternion, photo.quaternion) < 1e-3,
      restored?.isError ? failureOf(restored) : `先摆到别处（roll=${movedAway.rollDeg.toFixed(4)}°，与照片相机差 ${Math.abs(movedAway.rollDeg - ROLL).toFixed(2)}°>1）；再用 name 恢复：usedName=${String(restoredPayload.usedName)}；量到 roll=${restoredLive.rollDeg.toFixed(4)}°、姿态与照片相机差 ${quaternionAngleDeg(restoredLive.quaternion, photo.quaternion).toExponential(2)}°`)
    const unknownName = (await drive(harness.tool(SESSION_C, "viewer_camera_apply", { input: { sceneId: SCENE_A, expectedRevision: rev(), clientId: "window-cam1", name: "不存在的相机" } }), [window])).value
    check("an_unknown_named_camera_is_refused",
      Boolean(unknownName?.isError) && failureOf(unknownName).includes("VIEWER_CAMERA_NAME_UNKNOWN") && window.cameraApplies === 5,
      unknownName?.isError ? `工具错误=${failureOf(unknownName).slice(0, 140)}；窗口应用次数=${String(window.cameraApplies)}（5＝只有前五次真的应用了）` : `没有失败：${JSON.stringify(textValueOf(unknownName)).slice(0, 160)}`)

    // —— 定向：别的窗口的请求，本窗口既不执行也不确认；被指定的窗口才做 ——
    // 在场是按 3 秒的有效期算的（`OBSERVE_PRESENCE_TTL_MS`）：不轮询的窗口就等于关了页面。
    // 它下一次轮询就会拿到新 rev（真实前端是 `refreshState` → `setScene`）：这次保存推进过场景版本，
    // 还停在旧版的窗口按同一份判据本就该被拒——所以先让它跟上，测的才是"定向"这件事本身。
    await other.loadScene(SCENE_A)
    await other.heartbeat()
    const targeted = harness.tool(SESSION_C, "viewer_camera_apply", { input: { sceneId: SCENE_A, expectedRevision: rev(), clientId: "window-cam2", position: [2.5, -2.5, 1.8], target: [0, 0, 0.5], fovYDeg: 45 } })
    const notMine = await settleState(targeted.then(() => "done", () => "done"), 200)
    await window.poll()
    check("a_request_for_another_window_is_not_executed_here",
      notMine === "pending" && window.cameraApplies === 5 && other.cameraApplies === 0,
      `等了 200ms 仍是 pending=${String(notMine === "pending")}；window-cam1 应用次数=${String(window.cameraApplies)}（没替 window-cam2 做）；window-cam2 应用次数=${String(other.cameraApplies)}（它还没轮询）`)
    const byTarget = (await drive(targeted, [other])).value
    const targetPayload = byTarget ? textValueOf(byTarget) as any : {}
    check("the_targeted_window_can_apply_it",
      Boolean(byTarget && !byTarget.isError) && targetPayload.clientId === "window-cam2" && other.cameraApplies === 1 && window.cameraApplies === 5 && Math.abs(other.camera.cameraView().rollDeg) < 1e-3,
      byTarget?.isError ? failureOf(byTarget) : `执行窗口=${String(targetPayload.clientId)}；它量到的 roll=${other.camera.cameraView().rollDeg.toFixed(4)}°（只给 target、没给 cameraUp ⇒ 按 up 推导出 roll 0）；另一窗口应用次数=${String(window.cameraApplies)}（没被牵连）`)

    // 取消：请求在窗口动手之前就结束——它既不该被应用，也不该留在队列里等下一次轮询。
    const controller = new AbortController()
    await other.heartbeat()
    const doomed = harness.tool(SESSION_C, "viewer_camera_apply", { input: { sceneId: SCENE_A, expectedRevision: rev(), clientId: "window-cam2", position: [9, 9, 9], target: [0, 0, 0.5], fovYDeg: 45 } }, { signal: controller.signal })
    await sleep(60)
    controller.abort()
    const aborted = failureOf(await doomed)
    await window.poll(); await other.poll()
    check("an_aborted_camera_apply_never_reaches_a_window",
      aborted.includes("VIEWER_CAMERA_ABORTED") && other.cameraApplies === 1 && window.cameraApplies === 5,
      `取消后这次调用=${aborted.slice(0, 110)}；两个窗口都轮询过一次之后：应用次数 ${String(window.cameraApplies)}/${String(other.cameraApplies)}（取消掉的那条既没被应用，也没留在队列里）`)

    // —— 形状与版本：在排队前/动手前就该拒的几类，一次都不该碰到窗口 ——
    await window.heartbeat()
    const offSight = await harness.tool(SESSION_C, "viewer_camera_apply", { input: { sceneId: SCENE_A, expectedRevision: rev(), clientId: "window-cam1", position: [4.2, -3.6, 2.4], quaternion: photo.quaternion, target: [8, 8, 8] } })
    const noCamera = await harness.tool(SESSION_C, "viewer_camera_apply", { input: { sceneId: SCENE_A, expectedRevision: rev(), clientId: "window-cam1" } })
    const noRenderCamera = await harness.tool(SESSION_C, "viewer_render_camera", { input: { sceneId: SCENE_A, expectedRevision: rev(), clientId: "window-cam1", width: 640, height: 480 } })
    const halfSize = await harness.tool(SESSION_C, "viewer_render_camera", { input: { sceneId: SCENE_A, expectedRevision: rev(), clientId: "window-cam1", width: 640, ...photo } })
    const notLive = await harness.tool(SESSION_C, "viewer_camera_apply", { input: { sceneId: SCENE_A, expectedRevision: rev(), clientId: "window-nobody", ...photo } })
    check("camera_requests_that_cannot_hold_are_refused_before_any_window_acts",
      Boolean(offSight.isError) && failureOf(offSight).includes("VIEWER_CAMERA_REQUEST_INVALID")
        && Boolean(noCamera.isError) && failureOf(noCamera).includes("VIEWER_CAMERA_REQUEST_REQUIRED")
        && Boolean(noRenderCamera.isError) && failureOf(noRenderCamera).includes("VIEWER_RENDER_CAMERA_REQUEST_REQUIRED")
        && Boolean(halfSize.isError) && failureOf(halfSize).includes("VIEWER_RENDER_CAMERA_SIZE_INCOMPLETE")
        && Boolean(notLive.isError) && failureOf(notLive).includes("VIEWER_OBSERVE_CLIENT_NOT_LIVE")
        && window.cameraApplies === 5 && window.cameraRenders === 1,
      `target 不在视线上=${failureOf(offSight).slice(0, 60)}；没给相机=${failureOf(noCamera).slice(0, 48)}；出图没给相机=${failureOf(noRenderCamera).slice(0, 58)}；只给一边尺寸=${failureOf(halfSize).slice(0, 58)}；窗口不在场=${failureOf(notLive).slice(0, 60)}；窗口应用/出图次数=${String(window.cameraApplies)}/${String(window.cameraRenders)}（都没动）`)
    // —— 部分更新：只给 fovYDeg/near 时沿用窗口里那台相机现在的姿态（含 roll）——
    // 走的是**完整的**一条路：工具 → 排队 → 前端 `workbench-camera` → `SceneViewer.applyCameraView`
    // （其中"此刻是什么样"由产品自己的 `cameraCurrent()` 读）。所以这条成立 = 模型不必把位置/姿态抄一遍，
    // 也不会因为"没再给 up"而把照片的 roll 抹成 0。
    // 用 window-cam4：本节别处的计数断言钉死了 window-cam1/cam2 的应用/出图次数。
    await refusing.heartbeat()
    const partialPoseBefore = refusing.camera!.cameraView()
    const partialTargetBefore = refusing.camera!.controls.target.clone()
    const partial = (await drive(harness.tool(SESSION_C, "viewer_camera_apply", { input: { sceneId: SCENE_A, expectedRevision: refusing.revision, clientId: "window-cam4", fovYDeg: 30, near: 0.08 } }), [refusing])).value
    const partialValue = partial ? textValueOf(partial) as any : {}
    const partialPoseAfter = refusing.camera!.cameraView()
    check("a_partial_camera_update_keeps_the_current_pose_and_roll",
      Boolean(partial && !partial.isError)
        && Math.abs(Number(partialValue.camera?.fovYDeg) - 30) < 1e-9 && Math.abs(Number(partialValue.camera?.near) - 0.08) < 1e-12
        && Math.abs(Number(partialValue.camera?.rollDeg) - ROLL) < 1e-3
        && quaternionAngleDeg(partialPoseAfter.quaternion, partialPoseBefore.quaternion) < 1e-3
        && Math.abs(partialPoseAfter.rollDeg - partialPoseBefore.rollDeg) < 1e-3
        && refusing.camera!.controls.target.distanceTo(partialTargetBefore) < 1e-9,
      partial?.isError ? failureOf(partial) : `只给了 fovYDeg=30/near=0.08（没给位置/姿态/target）：量到 fov=${Number(partialValue.camera?.fovYDeg).toFixed(6)}°、near=${String(partialValue.camera?.near)}；姿态差 ${quaternionAngleDeg(partialPoseAfter.quaternion, partialPoseBefore.quaternion).toExponential(2)}°；roll ${partialPoseBefore.rollDeg.toFixed(4)}°→${partialPoseAfter.rollDeg.toFixed(4)}°（照片那台是 ${String(ROLL)}°）；转心移动 ${refusing.camera!.controls.target.distanceTo(partialTargetBefore).toExponential(2)} 米`)
    // —— 104 报的那一条：**块形式**里的 `fovYDeg`/`near`/`far` 也要真的生效（工具 schema 推荐的 `camera:{…}`）——
    // 上一次是扁平形式给的 30°（上面那条），这次换块形式要 65°：真链上量到的必须是 65°，不是沿用 30°。
    const blockCamera = { position: [3.5, -4.5, 2.5], target: [0, 0, 0.6], fovYDeg: 65, near: 0.05, far: 500 }
    const blockApply = (await drive(harness.tool(SESSION_C, "viewer_camera_apply", { input: { sceneId: SCENE_A, expectedRevision: refusing.revision, clientId: "window-cam4", camera: blockCamera } }), [refusing])).value
    const blockValue = blockApply ? textValueOf(blockApply) as any : {}
    const blockPose = refusing.camera!.cameraView()
    const blockPositionGap = Math.max(...(Array.isArray(blockValue.camera?.position) ? blockValue.camera.position.map((value: number, index: number) => Math.abs(value - blockCamera.position[index]!)) : [Number.POSITIVE_INFINITY]))
    check("a_camera_block_carries_fovYDeg_near_far_like_the_flat_form",
      Boolean(blockApply && !blockApply.isError)
        && Math.abs(Number(blockValue.camera?.fovYDeg) - 65) < 1e-9 && Math.abs(Number(blockValue.camera?.near) - 0.05) < 1e-12 && Math.abs(Number(blockValue.camera?.far) - 500) < 1e-9
        && Math.abs(blockPose.fovYDeg - 65) < 1e-9 && Math.abs(blockPose.near - 0.05) < 1e-12 && Math.abs(blockPose.far - 500) < 1e-9
        && blockPositionGap < 1e-9,
      blockApply?.isError ? failureOf(blockApply) : `块里的 camera={position,target,fovYDeg:65,near:0.05,far:500}（上一次扁平形式量到的是 30°）：回执量到 fov=${Number(blockValue.camera?.fovYDeg).toFixed(6)}°、near=${String(blockValue.camera?.near)}、far=${String(blockValue.camera?.far)}；窗口里那台相机量到 fov=${blockPose.fovYDeg.toFixed(6)}°、near=${String(blockPose.near)}、far=${String(blockPose.far)}；位置差 ${blockPositionGap.toExponential(2)} 米`)
    // 同一个量两处说法不一致（顶层 40 vs 块里 65）：**排队前**就拒（窗口一次都不被碰），不静默挑一个。
    const appliesBeforeConflict = refusing.cameraApplies
    const conflicting = await harness.tool(SESSION_C, "viewer_camera_apply", { input: { sceneId: SCENE_A, expectedRevision: refusing.revision, clientId: "window-cam4", fovYDeg: 40, camera: blockCamera } })
    check("a_camera_block_that_contradicts_the_top_level_is_refused_before_the_window_acts",
      Boolean(conflicting.isError) && failureOf(conflicting).includes("VIEWER_CAMERA_REQUEST_INVALID") && failureOf(conflicting).includes("两处说法")
        && refusing.cameraApplies === appliesBeforeConflict,
      conflicting.isError ? `${failureOf(conflicting).slice(0, 170)}；窗口应用次数=${String(refusing.cameraApplies - appliesBeforeConflict)}（0＝没被碰过）` : `顶层 fovYDeg=40 与块里 65 不一致却没有被拒：${JSON.stringify(textValueOf(conflicting)).slice(0, 160)}`)
    // 同一条规范化在另两条工具上一样：块形式给 fov 出图，回执里的内参/尺寸必须就是那支镜头画出来的。
    const blockRender = (await drive(harness.tool(SESSION_C, "viewer_render_camera", { input: { sceneId: SCENE_A, expectedRevision: refusing.revision, clientId: "window-cam4", width: 800, height: 600, camera: blockCamera } }), [refusing])).value
    const blockShot = blockRender ? textValueOf(blockRender) as any : {}
    const blockShotImage = blockRender && !blockRender.isError ? imageBlock(blockRender) : undefined
    const blockShotFov = blockShot.cameraImage?.intrinsics ? fovYFromIntrinsics(blockShot.cameraImage.intrinsics) : Number.NaN
    check("a_camera_block_drives_the_render_and_the_receipt_matches_that_lens",
      Boolean(blockRender && !blockRender.isError)
        && Math.abs(Number(blockShot.camera?.fovYDeg) - 65) < 1e-9 && Math.abs(Number(blockShot.camera?.near) - 0.05) < 1e-12
        && Number(blockShot.image?.width) === 800 && Number(blockShot.image?.height) === 600 && blockShotImage?.attachment?.width === 800 && blockShotImage?.attachment?.height === 600
        && Math.abs(blockShotFov - 65) < 1e-6 && Math.abs(Number(blockShot.cameraImage.intrinsics.fx) - Number(blockShot.cameraImage.intrinsics.fy)) < 1e-6
        && blockShot.cameraImage?.verified === true,
      blockRender?.isError ? failureOf(blockRender) : `块里的 camera={position,target,fovYDeg:65,near:0.05,far:500} 出 800×600：回执量到 fov=${Number(blockShot.camera?.fovYDeg).toFixed(6)}°、near=${String(blockShot.camera?.near)}/far=${String(blockShot.camera?.far)}；图 ${String(blockShot.image?.width)}×${String(blockShot.image?.height)}；按 cameraImage.intrinsics 复算的垂直视场角=${blockShotFov.toFixed(6)}°（fx−fy=${(Number(blockShot.cameraImage?.intrinsics?.fx) - Number(blockShot.cameraImage?.intrinsics?.fy)).toExponential(2)}）；verified=${String(blockShot.cameraImage?.verified)}`)
    // 观察带块形式的相机：拍到的仍是当前画布（来源不变），appliedCamera 是应用后量到的读数。
    const blockObserve = (await drive(harness.tool(SESSION_C, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: refusing.revision, clientId: "window-cam4", camera: blockCamera } }), [refusing])).value
    const blockObservePayload = blockObserve ? textValueOf(blockObserve) as any : {}
    check("a_camera_block_drives_the_observe_camera_and_the_measured_readout_follows",
      Boolean(blockObserve && !blockObserve.isError) && blockObservePayload.source === "native-viewer"
        && Math.abs(Number(blockObservePayload.appliedCamera?.fovYDeg) - 65) < 1e-9 && Math.abs(Number(blockObservePayload.appliedCamera?.near) - 0.05) < 1e-12 && Math.abs(Number(blockObservePayload.appliedCamera?.far) - 500) < 1e-9,
      blockObserve?.isError ? failureOf(blockObserve) : `source=${String(blockObservePayload.source)}；appliedCamera 量到 fov=${Number(blockObservePayload.appliedCamera?.fovYDeg).toFixed(6)}°、near=${String(blockObservePayload.appliedCamera?.near)}/far=${String(blockObservePayload.appliedCamera?.far)}（块里给的是 65/0.05/500）`)
    // —— 尺度未定（camera_fit 的 worldUnit=unknown）：位置只有 positionInputUnits，**不是米** ——
    // 这份块按 55 的读数形状拼：位置、转心、焦距都在同一个"输入单位"空间里（本用例 1 单位 = 2 米），
    // 与真夹具的米制读数只差这一个比例。判据：没有换算就**在排队前**拒（一次都不碰窗口），
    // 给了换算才应用，而且应用后量与米制那份**逐位相同**——换算同时落在位置与转心/focusDistance 上。
    const metersPerInputUnit = 2
    const metricPose = worldFromCameraOf(photo.position as ViewerVec3, photo.quaternion)
    const perInputUnits = (values: readonly number[]) => values.map(value => value / metersPerInputUnit)
    const focusDistanceM = new THREE.Vector3(...photo.position as ViewerVec3).distanceTo(new THREE.Vector3(...photo.target as ViewerVec3))
    const unknownScaleCamera = {
      metric: false, positionUnits: "inputUnits",
      worldFromCamera: { positionInputUnits: perInputUnits(metricPose.positionM), rotationMatrix: metricPose.rotationMatrix, quaternionXyzw: metricPose.quaternionXyzw },
      viewer: {
        quaternion: photo.quaternion, target: perInputUnits(photo.target as ViewerVec3), focusDistance: focusDistanceM / metersPerInputUnit,
        fov_y_deg: fovYFromIntrinsics(PHOTO), fov_x_deg: fovXFromIntrinsics(PHOTO), aspect: PHOTO.width / PHOTO.height, intrinsics: PHOTO,
        units: { metric: false, name: "input-units(unknown-scale)", note: "尺度未定：位置不是米。" },
      },
    }
    const appliesBeforeScale = refusing.cameraApplies
    const noConversion = await harness.tool(SESSION_C, "viewer_camera_apply", { input: { sceneId: SCENE_A, expectedRevision: refusing.revision, clientId: "window-cam4", camera: unknownScaleCamera } })
    const scaledApply = (await drive(harness.tool(SESSION_C, "viewer_camera_apply", { input: { sceneId: SCENE_A, expectedRevision: refusing.revision, clientId: "window-cam4", camera: unknownScaleCamera, metersPerInputUnit } }), [refusing])).value
    const scaledValue = scaledApply ? textValueOf(scaledApply) as any : {}
    const scaledPoseGap = quaternionAngleDeg((scaledValue.camera?.quaternion ?? [0, 0, 0, 1]) as ViewerQuat, photo.quaternion)
    const scaledPositionGap = Math.max(...(Array.isArray(scaledValue.camera?.position) ? scaledValue.camera.position.map((value: number, index: number) => Math.abs(value - (photo.position as number[])[index]!)) : [Number.POSITIVE_INFINITY]))
    const scaledLens = intrinsicsDelta(scaledValue.camera?.intrinsics, scaleIntrinsics(PHOTO, CANVAS.width, CANVAS.height))
    check("a_scale_unknown_camera_is_refused_until_the_caller_gives_a_conversion",
      Boolean(noConversion.isError) && failureOf(noConversion).includes("VIEWER_CAMERA_SCALE_UNKNOWN") && failureOf(noConversion).includes("metersPerInputUnit")
        && Boolean(scaledApply && !scaledApply.isError)
        && refusing.cameraApplies === appliesBeforeScale + 1
        && scaledPositionGap < 1e-6 && scaledPoseGap < 1e-3 && Math.abs(Number(scaledValue.camera?.rollDeg) - ROLL) < 1e-3 && scaledLens.ok,
      noConversion.isError
        ? `没有换算时（排队前就拒，窗口没被碰过）=${failureOf(noConversion).slice(0, 150)}；给了 metersPerInputUnit=${String(metersPerInputUnit)}（米/输入单位）之后：位置与米制那份差 ${scaledPositionGap.toExponential(2)} 米、姿态差 ${scaledPoseGap.toExponential(2)}°、roll=${Number(scaledValue.camera?.rollDeg).toFixed(4)}°、${scaledLens.text}；这期间窗口只被应用了 ${String(refusing.cameraApplies - appliesBeforeScale)} 次（被拒的那次没应用）`
        : `没有换算也应用了：${JSON.stringify(textValueOf(noConversion)).slice(0, 160)}`)
    // 版本不符：宿主里 rev 3 是存在的（≤4），但窗口显示的是 rev 4 ⇒ 前端按同一份判据拒绝，工具拿到明确原因。
    await window.heartbeat()
    const stale = (await drive(harness.tool(SESSION_C, "viewer_camera_apply", { input: { sceneId: SCENE_A, expectedRevision: 3, clientId: "window-cam1", ...photo } }), [window])).value
    check("a_window_showing_another_revision_is_refused",
      Boolean(stale?.isError) && failureOf(stale).includes("VIEWER_CAMERA_STALE_REVISION") && window.cameraApplies === 5,
      stale?.isError ? `工具错误=${failureOf(stale).slice(0, 130)}；窗口应用次数=${String(window.cameraApplies)}（这次没应用）` : `没有失败：${JSON.stringify(textValueOf(stale)).slice(0, 160)}`)
    // 不支持相机的窗口：明确失败，不假装应用过（默认的 SimWindow 就是"旧 Viewer"）。
    const plainWindow = new SimWindow(harness, SESSION_C, "window-cam3")
    await plainWindow.heartbeat()
    const unsupported = (await drive(harness.tool(SESSION_C, "viewer_camera_apply", { input: { sceneId: SCENE_A, expectedRevision: rev(), clientId: "window-cam3", ...photo } }), [plainWindow])).value
    check("a_window_without_camera_support_is_refused_not_faked",
      Boolean(unsupported?.isError) && failureOf(unsupported).includes("VIEWER_CAMERA_UNSUPPORTED") && plainWindow.frames === 0,
      unsupported?.isError ? `工具错误=${failureOf(unsupported).slice(0, 150)}；该窗口拍帧次数=${String(plainWindow.frames)}（没出图）` : `没有失败：${JSON.stringify(textValueOf(unsupported)).slice(0, 160)}`)
    // 前端自己那条：视口不可用（Viewer 已关闭/未挂载）在模块层就是同一个明确失败——与产品前端调用点逐句相同。
    const noViewer = await applyCameraToWindow({ clientId: "window-cam1", viewerVisible: false, sceneId: SCENE_A, expectedRevision: rev(), request: photo })
      .then(() => "", (error: unknown) => error instanceof Error ? error.message : String(error))
    check("a_closed_viewer_is_reported_not_papered_over", noViewer.includes("VIEWER_CAMERA_VIEWER_UNAVAILABLE"),
      `前端判定模块给出的原因=${noViewer.slice(0, 120)}`)

    // —— 出图的三道核对（反例专用：让替身像"没按请求摆相机的坏前端"那样报读数/交图）——
    const recordCount = async () => (await harness.storedCaptures()).length
    await window.heartbeat()
    window.camera!.lie = "size"
    const beforeWrongSize = await recordCount()
    const wrongSize = (await drive(harness.tool(SESSION_C, "viewer_render_camera", { input: { sceneId: SCENE_A, expectedRevision: rev(), clientId: "window-cam1", width: PHOTO.width, height: PHOTO.height, ...photo } }), [window])).value
    const afterWrongSize = await recordCount()
    check("a_render_whose_size_contradicts_its_intrinsics_is_refused",
      Boolean(wrongSize?.isError) && failureOf(wrongSize).includes("VIEWER_RENDER_CAMERA_PROVENANCE_INVALID") && afterWrongSize === beforeWrongSize,
      wrongSize?.isError ? `工具错误=${failureOf(wrongSize).slice(0, 160)}；采集记录 ${String(beforeWrongSize)}→${String(afterWrongSize)} 份（没落盘）` : `没有失败：${JSON.stringify(textValueOf(wrongSize)).slice(0, 160)}`)
    window.camera!.lie = "intrinsics"
    const wrongLens = (await drive(harness.tool(SESSION_C, "viewer_render_camera", { input: { sceneId: SCENE_A, expectedRevision: rev(), clientId: "window-cam1", width: PHOTO.width, height: PHOTO.height, ...photo } }), [window])).value
    const afterWrongLens = await recordCount()
    check("a_render_that_is_not_the_requested_lens_is_refused",
      Boolean(wrongLens?.isError) && failureOf(wrongLens).includes("VIEWER_RENDER_CAMERA_INTRINSICS_MISMATCH") && afterWrongLens === beforeWrongSize,
      wrongLens?.isError ? `工具错误=${failureOf(wrongLens).slice(0, 170)}；采集记录仍是 ${String(afterWrongLens)} 份` : `没有失败：${JSON.stringify(textValueOf(wrongLens)).slice(0, 160)}`)
    window.camera!.lie = "canvas"
    const beforeCanvasStand = new Set(await harness.storedCaptures())
    const canvasStand = (await drive(harness.tool(SESSION_C, "viewer_render_camera", { input: { sceneId: SCENE_A, expectedRevision: rev(), clientId: "window-cam1", width: PHOTO.width, height: PHOTO.height, ...photo } }), [window])).value
    const fresh = (await harness.storedCaptures()).filter(name => !beforeCanvasStand.has(name))
    const freshRecord = fresh.length === 1 ? JSON.parse(await readFile(join(harness.captureRoot, fresh[0]!), "utf8")) as any : {}
    check("a_canvas_screenshot_cannot_stand_in_for_a_camera_render",
      Boolean(canvasStand?.isError) && failureOf(canvasStand).includes("VIEWER_RENDER_CAMERA_SOURCE_MISMATCH") && freshRecord.source === "native-viewer" && Boolean(freshRecord.cameraApply),
      canvasStand?.isError ? `工具错误=${failureOf(canvasStand).slice(0, 170)}；这次回传本身作为"当前画布采集"是合法的：新增记录 source=${String(freshRecord.source)}、带着拍前应用的相机=${String(Boolean(freshRecord.cameraApply))}（模型要的是native-viewer-camera，所以不把它当出图结果）` : `没有失败：${JSON.stringify(textValueOf(canvasStand)).slice(0, 160)}`)
    window.camera!.lie = "none"

    // 反方向：按相机出的图不能标成"当前画布截图"（载荷带着出图尺寸/请求内参时，来源必须就是相机出图）。
    const renderShaped = window.camera!.renderCameraImage({ ...photo } as ViewerCameraRenderRequest)
    const beforePassOff = await recordCount()
    const passedOff = await window.postCapture({ ...renderShaped as Record<string, unknown>, source: "native-viewer", sceneId: SCENE_A, sceneRevision: REVISION })
      .then(() => "", (error: unknown) => error instanceof Error ? error.message : String(error))
    check("a_camera_render_may_not_be_passed_off_as_the_current_canvas",
      passedOff.includes("VIEWER_RENDER_CAMERA_PROVENANCE_INVALID") && await recordCount() === beforePassOff,
      `直接投递一份"自洽但来源标成 native-viewer"的出图载荷：回执=${passedOff.slice(0, 170)}；采集记录 ${String(beforePassOff)}→${String(await recordCount())} 份（没被当成画布截图收下）`)
    const bogusSource = await window.postCapture({ source: "blender-preview", sceneId: SCENE_A, sceneRevision: REVISION })
      .then(() => "", (error: unknown) => error instanceof Error ? error.message : String(error))
    check("an_unknown_capture_source_is_refused", bogusSource.includes("CAPTURE_SOURCE_UNKNOWN"),
      `来源写成 blender-preview 时=${bogusSource.slice(0, 130)}`)

    // —— 环境光照事实：**按指定相机出的图**也必须如实说清 HDRI 的失败/在途 ——
    // 这一份 environment 不是测试拼的说明，也不是工具自己算的：它来自产品 Viewer 的
    // `environmentCaptureFace()`（与 `capture()` 同一份 owner），落盘记录里带着同一份事实，
    // 所以"这张图是在没有那份 HDRI 的画面上出的"在回执与台账两处都查得到。
    const environmentRender = async () => {
      const before = new Set(await harness.storedCaptures())
      const result = (await drive(harness.tool(SESSION_C, "viewer_render_camera", { input: { sceneId: SCENE_A, expectedRevision: rev(), clientId: "window-cam1", width: PHOTO.width, height: PHOTO.height, ...photo } }), [window])).value
      const payload = result ? textValueOf(result) as any : {}
      const fresh = (await harness.storedCaptures()).filter(name => !before.has(name))
      return { result, payload, record: fresh.length === 1 ? JSON.parse(await readFile(join(harness.captureRoot, fresh[0]!), "utf8")) as any : {} }
    }
    window.camera!.setEnvironment({ resourceId: "hdri-sky", version: 2, state: "failed", error: "HDR_LOAD_FAILED: 取不到 hdri-sky@2（网络错误）" })
    const failedEnv = await environmentRender()
    const failedFace = window.camera!.viewer.environmentCaptureFace()
    check("a_camera_render_says_the_hdri_failed_instead_of_showing_a_normal_picture",
      Boolean(failedEnv.result && !failedEnv.result.isError) && failedEnv.payload.environment?.source === "builtin"
        && failedEnv.payload.environment?.requested === "hdri-sky@2" && failedEnv.payload.environment?.loaded === false && failedEnv.payload.environment?.loading === false
        && String(failedEnv.payload.environment?.error ?? "").includes("HDR_LOAD_FAILED")
        && JSON.stringify(failedEnv.payload.environment) === JSON.stringify(failedFace)
        && JSON.stringify(failedEnv.record.environment) === JSON.stringify(failedFace) && failedEnv.payload.source === "native-viewer-camera",
      failedEnv.result?.isError ? failureOf(failedEnv.result) : `回执里的 environment=${JSON.stringify(failedEnv.payload.environment ?? null)}；与 Viewer 自己那份（同一帧）逐字相同=${String(JSON.stringify(failedEnv.payload.environment) === JSON.stringify(failedFace))}；落盘记录里也带着同一份=${String(JSON.stringify(failedEnv.record.environment) === JSON.stringify(failedFace))}；来源仍是 ${String(failedEnv.payload.source)}（按相机出图，不是画布截图）`)
    window.camera!.setEnvironment({ resourceId: "hdri-sky", version: 2, state: "in-flight" })
    const loadingEnv = await environmentRender()
    check("a_camera_render_says_the_hdri_is_still_loading",
      Boolean(loadingEnv.result && !loadingEnv.result.isError) && loadingEnv.payload.environment?.loaded === false && loadingEnv.payload.environment?.loading === true
        && loadingEnv.payload.environment?.applied === undefined && loadingEnv.payload.environment?.error === undefined
        && JSON.stringify(loadingEnv.record.environment) === JSON.stringify(loadingEnv.payload.environment),
      loadingEnv.result?.isError ? failureOf(loadingEnv.result) : `在途那一份：environment=${JSON.stringify(loadingEnv.payload.environment ?? null)}（loaded=false、loading=true、没有 applied/error：没装上就不许说"用的是它"）；落盘一致=${String(JSON.stringify(loadingEnv.record.environment) === JSON.stringify(loadingEnv.payload.environment))}`)

    // —— resize：像素尺度换了，姿态与照片镜头按比例跟着走（与 `SceneViewer.resizeCanvas` 同一串）——
    const beforeResize = window.camera!.cameraView()
    window.camera!.resize(1600, 900)
    const afterResize = window.camera!.cameraView()
    const rescaled = intrinsicsDelta(afterResize.intrinsics, scaleIntrinsics(beforeResize.intrinsics, 1600, 900))
    check("a_window_resize_rescales_the_lens_without_losing_the_pose",
      quaternionAngleDeg(afterResize.quaternion, beforeResize.quaternion) < 1e-6 && Math.abs(afterResize.rollDeg - beforeResize.rollDeg) < 1e-6 && rescaled.ok,
      `${String(beforeResize.imageWidth)}×${String(beforeResize.imageHeight)} → 1600×900：姿态差 ${quaternionAngleDeg(afterResize.quaternion, beforeResize.quaternion).toExponential(2)}°、roll ${beforeResize.rollDeg.toFixed(4)}°→${afterResize.rollDeg.toFixed(4)}°；内参 ${rescaled.text}`)
    const afterResizeApply = (await drive(harness.tool(SESSION_C, "viewer_camera_apply", { input: { sceneId: SCENE_A, expectedRevision: rev(), clientId: "window-cam1", name: "photo-A" } }), [window])).value
    const newCanvasLens = intrinsicsDelta(window.camera!.cameraView().intrinsics, scaleIntrinsics(PHOTO, 1600, 900))
    check("a_saved_camera_restores_on_the_resized_canvas",
      Boolean(afterResizeApply && !afterResizeApply.isError) && newCanvasLens.ok && Math.abs(window.camera!.cameraView().rollDeg - ROLL) < 1e-3,
      afterResizeApply?.isError ? failureOf(afterResizeApply) : `resize 之后再用 name 恢复：照片 K 在 1600×900 上应为 ${scaleIntrinsics(PHOTO, 1600, 900).fx.toFixed(4)}/${scaleIntrinsics(PHOTO, 1600, 900).fy.toFixed(4)}：${newCanvasLens.text}；roll=${window.camera!.cameraView().rollDeg.toFixed(4)}°`)

    // —— 换场景：命名相机**按场景分开存**（不串场景、也不被切换清掉——它们本来就在各自的文档里）——
    // `ui_action` 只是排队（回执就说明"动作已排队"，不代表任何窗口已经切过去）：这里自己轮询一次把动作取走。
    await harness.tool(SESSION_C, "ui_action", { input: { action: "selectScene", sceneId: SCENE_B } })
    await window.poll()
    const camerasOf = async (sceneId: string) => namedCamerasOfScene((await documentOf(sceneId)).entities).cameras
    check("a_scene_switch_keeps_each_scene_saved_cameras_separate",
      window.sceneId === SCENE_B && (await camerasOf(SCENE_A)).some(row => row.name === "photo-A") && (await camerasOf(SCENE_B)).length === 0,
      `窗口现在显示 ${String(window.sceneId)} rev ${String(window.revision)}；${SCENE_A} 文档里的命名相机=${JSON.stringify((await camerasOf(SCENE_A)).map(row => row.name))}；${SCENE_B} 的=${JSON.stringify((await camerasOf(SCENE_B)).map(row => row.name))}`)
    const onOtherScene = (await drive(harness.tool(SESSION_C, "viewer_camera_apply", { input: { sceneId: SCENE_B, expectedRevision: 1, clientId: "window-cam1", ...photo } }), [window])).value
    const otherSceneLens = intrinsicsDelta(window.camera!.cameraView().intrinsics, scaleIntrinsics(PHOTO, 1600, 900))
    check("the_same_camera_applies_on_another_scene_and_revision",
      Boolean(onOtherScene && !onOtherScene.isError) && (onOtherScene ? textValueOf(onOtherScene).sceneId === SCENE_B && textValueOf(onOtherScene).expectedRevision === 1 : false) && otherSceneLens.ok && Math.abs(window.camera!.cameraView().rollDeg - ROLL) < 1e-3,
      onOtherScene?.isError ? failureOf(onOtherScene) : `应用在 ${SCENE_B} rev 1 上：量到 roll=${window.camera!.cameraView().rollDeg.toFixed(4)}°；${otherSceneLens.text}（相机实例不随场景重建这点与真实 Viewer 一致——同一个 canvas 一直用同一台相机；场景资源切换的可见效果由 root 的真实页面验收）`)

    // —— 另一个窗口（另一个客户端）读**同一份文档**：这才是"从 localStorage 搬进场景"要达到的效果 ——
    // 这个窗口自己没有存过任何相机，它只是打开了同一个场景。
    await other.loadScene(SCENE_A)
    const crossWindow = (await drive(harness.tool(SESSION_C, "viewer_camera_apply", { input: { sceneId: SCENE_A, expectedRevision: other.revision, clientId: "window-cam2", name: "photo-A" } }), [other])).value
    const crossPayload = crossWindow ? textValueOf(crossWindow) as any : {}
    check("another_window_reads_the_same_named_camera_from_the_scene_document",
      Boolean(crossWindow && !crossWindow.isError) && crossPayload.usedName === "photo-A"
        && Math.abs(other.camera!.cameraView().rollDeg - ROLL) < 1e-3 && quaternionAngleDeg(other.camera!.cameraView().quaternion, photo.quaternion) < 1e-3,
      crossWindow?.isError ? failureOf(crossWindow) : `${String(crossPayload.clientId)} 打开 ${SCENE_A}（rev ${String(other.revision)}）后按名字恢复：usedName=${String(crossPayload.usedName)}；量到 roll=${other.camera!.cameraView().rollDeg.toFixed(4)}°、姿态与照片相机差 ${quaternionAngleDeg(other.camera!.cameraView().quaternion, photo.quaternion).toExponential(2)}°（这台相机是 window-cam1 存进文档的，本窗口自己没存过任何相机）`)

    // —— 命名相机读入的那份校验：文档是**外部输入**（旧版本、手改、别的客户端写的）——
    // 坏一条丢一条、不清空整份；名字去空白。删除走界面那条同源写路径（`withoutNamedCamera` + 一次提交）。
    const handEdited = await documentOf(SCENE_A)
    const carrierId = namedCamerasOfScene(handEdited.entities).carrier!
    const carrier = handEdited.entities.find(entity => entity.entityId === carrierId)!
    const withJunk = { cameras: [
      ...namedCamerasOfScene(handEdited.entities).cameras,
      { name: "  手改的  ", savedAt: "2026-09-20T00:00:00.000Z", state: { position: [1, 2, 3], quaternion: [0, 0, 0, 1], target: [0, 0, 0] } },
      { name: "坏的", state: { position: [1, 2], quaternion: [0, 0, 0, 1], target: [0, 0, 0] } },
      "不是对象",
    ] }
    await harness.commitScene(SESSION_C, SCENE_A, handEdited.revision, [{ op: "update", entityId: carrierId, changes: { components: { ...carrier.components, viewerCamera: withJunk } } }])
    const parsed = parseViewerCameraComponent(withJunk)
    check("named_camera_rows_read_from_the_document_drop_broken_ones_instead_of_clearing_everything",
      parsed.cameras.some(row => row.name === "手改的") && !parsed.cameras.some(row => row.name === "坏的") && parsed.cameras.some(row => row.name === "photo-A") && parsed.warnings.length === 2,
      `读回=${JSON.stringify(parsed.cameras.map(row => row.name))}（名字去了空白；状态坏的那条与非对象各一条警告后丢掉；"photo-A" 仍在）；警告=${JSON.stringify(parsed.warnings)}`)
    const withoutRow = withoutNamedCamera(parsed.cameras, "手改的")
    const removal = await documentOf(SCENE_A)
    const removalCarrier = namedCamerasOfScene(removal.entities).carrier!
    await harness.commitScene(SESSION_C, SCENE_A, removal.revision, [{ op: "update", entityId: removalCarrier, changes: { components: { ...removal.entities.find(entity => entity.entityId === removalCarrier)!.components, viewerCamera: composeViewerCameraComponent(withoutRow) } } }])
    const afterRemoval = await camerasOf(SCENE_A)
    check("a_named_camera_can_be_removed_like_the_panel_does",
      !afterRemoval.some(row => row.name === "手改的") && afterRemoval.some(row => row.name === "photo-A"),
      `删除后文档里=${JSON.stringify(afterRemoval.map(row => row.name))}（走的是与面板按钮同一条写路径：withoutNamedCamera + 一次 scene_edit）`)

    // —— 附件库把大图**缩小入库**时（默认上限 4194304 像素，缩过才带 `originalDimensions`）——
    // 这一节钉住两件事：① 原分辨率帧不许被缩图顶掉（`imagePath`/`originalImage` = 送来的那份 PNG，逐字节、尺寸=出图尺寸）；
    // ② 缩图只能用**它自己的** K（`cameraImage.preview` 记尺寸、逐轴比例、缩图内参与"缩图坐标 → 原图坐标"的换算），
    // 原图的 K 只按原图口径出现一次。真实现场里 4000×3000 的出图曾被这条策略缩到 2364×1773 后被判"尺寸不符"。
    const BIG = { width: 2400, height: 1800 }
    const bigRecordCount = async () => (await harness.storedCaptures()).length
    const beforeBig = new Set(await harness.storedCaptures())
    const bigRender = (await drive(harness.tool(SESSION_C, "viewer_render_camera", { input: { sceneId: window.sceneId, expectedRevision: rev(), clientId: "window-cam1", width: BIG.width, height: BIG.height, ...photo } }), [window])).value
    const bigPayload = bigRender ? textValueOf(bigRender) as any : {}
    const bigFresh = (await harness.storedCaptures()).filter(name => !beforeBig.has(name))
    const bigRecord = bigFresh.length === 1 ? JSON.parse(await readFile(join(harness.captureRoot, bigFresh[0]!), "utf8")) as any : {}
    const bigOnDisk = typeof bigPayload.imagePath === "string" ? await readFile(bigPayload.imagePath).catch(() => undefined) : undefined
    // 这次出图的像素**就是**测试现编的那张 PNG（画布替身交回什么，落盘就该逐字节是什么）：重新编一份来比字节。
    const bigSent = Buffer.from(pngOfSize(BIG.width, BIG.height).split(",", 2)[1]!, "base64")
    const preview = bigPayload.cameraImage?.preview
    const previewLens = preview ? intrinsicsDelta(preview.intrinsics, scaleIntrinsics(bigPayload.cameraImage.intrinsics, preview.width, preview.height)) : { ok: false, text: "（没有 preview.intrinsics）" }
    check("a_store_reduced_frame_keeps_the_original_bytes_and_maps_the_preview",
      Boolean(bigRender && !bigRender.isError)
        && bigPayload.cameraImage?.imageWidth === BIG.width && bigPayload.cameraImage?.imageHeight === BIG.height
        && (bigPayload.image?.width ?? 0) * (bigPayload.image?.height ?? 0) < BIG.width * BIG.height
        && bigRecord.attachment?.originalDimensions?.width === BIG.width && bigRecord.attachment?.originalDimensions?.height === BIG.height
        && bigPayload.originalImage?.width === BIG.width && bigPayload.originalImage?.height === BIG.height
        && bigPayload.originalImage?.bytes === bigSent.length && bigPayload.originalImage?.path === bigPayload.imagePath
        && Boolean(bigOnDisk?.equals(bigSent)) && String(bigPayload.imagePreviewNote ?? "").includes("预览")
        && JSON.stringify(bigRecord.originalImage) === JSON.stringify(bigPayload.originalImage)
        && Boolean(preview) && preview.scaleX === preview.width / BIG.width && preview.scaleY === preview.height / BIG.height && preview.scaleX < 1
        && previewLens.ok && typeof preview.pixelMapping === "string" && preview.pixelMapping.includes("u_orig"),
      bigRender?.isError ? failureOf(bigRender) : `出图 ${String(BIG.width)}×${String(BIG.height)}（${(BIG.width * BIG.height / 1e6).toFixed(2)} MP）→ 附件被缩成 ${String(bigPayload.image?.width)}×${String(bigPayload.image?.height)}（记录里 attachment.originalDimensions=${JSON.stringify(bigRecord.attachment?.originalDimensions ?? null)}）；落盘正本 ${String(bigPayload.imagePath)}＝${String(bigOnDisk?.length)} B、与送来的 PNG 逐字节一致=${String(Boolean(bigOnDisk?.equals(bigSent)))}（回执 originalImage=${JSON.stringify(bigPayload.originalImage ?? null)}，与记录一致=${String(JSON.stringify(bigRecord.originalImage) === JSON.stringify(bigPayload.originalImage))}）；cameraImage 尺寸=${String(bigPayload.cameraImage?.imageWidth)}×${String(bigPayload.cameraImage?.imageHeight)}；预览换算：scaleX/Y=${String(preview?.scaleX)}/${String(preview?.scaleY)}、${previewLens.text}、pixelMapping=${String(preview?.pixelMapping)}；提示语=${String(bigPayload.imagePreviewNote ?? "（没有）").slice(0, 80)}`)

    // 反例：缩的是**别的图**（附件记着缩小前 2400×1800，读数却说 2000×1500）⇒ 仍旧按"尺寸不符"拒、不落盘。
    // 没有这一条，"缩过图就放行"会变成一句空话。
    const forgedShot = { ...(window.camera!.renderCameraImage({ ...photo, ...BIG } as ViewerCameraRenderRequest) as Record<string, any>) }
    delete forgedShot.sourceIntrinsics
    const claimedLens = scaleIntrinsics(PHOTO, 2000, 1500)
    const beforeForged = await bigRecordCount()
    const forged = await window.postCapture({ ...forgedShot, imageWidth: 2000, imageHeight: 1500, source: "native-viewer-camera", sceneId: window.sceneId, sceneRevision: rev(), clientId: "window-cam1", camera: { ...forgedShot.camera, intrinsics: claimedLens, projectionMatrix: projectionMatrixFromIntrinsics(claimedLens, forgedShot.camera.near, forgedShot.camera.far) } })
      .then(() => "", (error: unknown) => error instanceof Error ? error.message : String(error))
    check("a_store_reduced_image_of_another_frame_is_still_refused",
      forged.includes("VIEWER_RENDER_CAMERA_IMAGE_SIZE_MISMATCH") && await bigRecordCount() === beforeForged,
      `把"缩小前 2400×1800"的附件当成 2000×1500 的相机读数提交：回执=${forged.slice(0, 190)}；采集记录 ${String(beforeForged)}→${String(await bigRecordCount())} 份（没落盘）`)

    // —— 高长宽比 / 非整比例的合法缩图（107 那轮 agent-digest3 的真实现场：876×5875 的普通 native 观察
    // 被缩成 791×5302）。整体缩放取整后两轴比例本来就略有出入：按"逐轴比例差 ≤ 1 像素"的等比守卫会算出
    // 约 2.9 像素的差，把**合法**的取整说成图被裁切而错拒。判据收敛为"缩小前尺寸 == 出图尺寸"，
    // 缩图自己的 K 与坐标换算照旧按两轴各自的实际比例记（不同轴比例本来就能正确表达像素 K）。 ——
    const TALL = { width: 876, height: 5875 }
    // 在场按 3 秒有效期算（`OBSERVE_PRESENCE_TTL_MS`）：上一段连着编了两张大 PNG，这一轮先打一次心跳再发工具。
    await window.heartbeat()
    const beforeTall = new Set(await harness.storedCaptures())
    const tallRender = (await drive(harness.tool(SESSION_C, "viewer_render_camera", { input: { sceneId: window.sceneId, expectedRevision: rev(), clientId: "window-cam1", width: TALL.width, height: TALL.height, ...photo } }), [window])).value
    const tallPayload = tallRender ? textValueOf(tallRender) as any : {}
    const tallFresh = (await harness.storedCaptures()).filter(name => !beforeTall.has(name))
    const tallRecord = tallFresh.length === 1 ? JSON.parse(await readFile(join(harness.captureRoot, tallFresh[0]!), "utf8")) as any : {}
    const tallPreview = tallPayload.cameraImage?.preview
    const tallGap = tallPreview ? Math.abs(tallPreview.scaleX - tallPreview.scaleY) * Math.max(TALL.width, TALL.height) : undefined
    const tallLens = tallPreview ? intrinsicsDelta(tallPreview.intrinsics, scaleIntrinsics(tallPayload.cameraImage.intrinsics, tallPreview.width, tallPreview.height)) : { ok: false, text: "（没有 preview.intrinsics）" }
    check("a_tall_frame_that_the_store_downscales_by_uneven_per_axis_rounding_is_still_accepted",
      Boolean(tallRender && !tallRender.isError)
        && tallPayload.cameraImage?.imageWidth === TALL.width && tallPayload.cameraImage?.imageHeight === TALL.height
        && tallRecord.attachment?.originalDimensions?.width === TALL.width && tallRecord.attachment?.originalDimensions?.height === TALL.height
        && (tallPayload.image?.width ?? 0) * (tallPayload.image?.height ?? 0) < TALL.width * TALL.height
        && Boolean(tallPreview) && tallPreview.scaleX === tallPreview.width / TALL.width && tallPreview.scaleY === tallPreview.height / TALL.height
        && tallPreview.scaleX < 1 && tallPreview.scaleY < 1
        && tallGap !== undefined && tallGap > 1
        && tallLens.ok && String(tallPayload.imagePreviewNote ?? "").includes("预览"),
      tallRender?.isError ? failureOf(tallRender) : `出图 ${String(TALL.width)}×${String(TALL.height)}（${(TALL.width * TALL.height / 1e6).toFixed(2)} MP，${(TALL.height / TALL.width).toFixed(2)}:1 竖图）→ 附件被缩成 ${String(tallPayload.image?.width)}×${String(tallPayload.image?.height)}（记录里 originalDimensions=${JSON.stringify(tallRecord.attachment?.originalDimensions ?? null)}）；两轴比例 ${String(tallPreview?.scaleX)}/${String(tallPreview?.scaleY)} 之差折合 ${tallGap?.toFixed(3)} 像素（已删掉的等比守卫按 |Δ|·max(W,H)≤1 会错拒这张合法图）；${tallLens.text}；提示语=${String(tallPayload.imagePreviewNote ?? "（没有）").slice(0, 80)}`)

    // —— `image` 描述对象必须自洽：path 指到哪个文件，attachmentId/媒体类型/字节/宽高就该是**那个文件**的读数。
    // 缩过图时 `imagePath` 是原帧、`image` 指预览，两者不是同一个文件——机器消费者照着 path 解码时不能再拿到另一份尺寸。
    const renderPreview = bigPayload.image ?? {}
    const renderPreviewPath = String(renderPreview.path ?? "")
    const renderPreviewOnDisk = renderPreviewPath ? await readFile(renderPreviewPath).catch(() => undefined) : undefined
    // 用记录里那份完整引用去读：`readImage` 会拿 ref 的媒体类型/字节/宽高与对象文件逐项对（只给 attachmentId 会被它按"引用不自洽"拒）。
    const renderPreviewBytes = renderPreviewPath ? await harness.attachmentBytes(bigRecord.attachment).catch(() => undefined) : undefined
    check("a_render_receipts_image_object_describes_the_file_its_path_points_at",
      Boolean(bigRender && !bigRender.isError)
        && renderPreviewPath !== bigPayload.imagePath && renderPreviewPath === String(harness.ctx.get("attachments").imageHostPath(bigRecord.attachment))
        && Boolean(renderPreviewOnDisk) && renderPreviewOnDisk!.length === renderPreview.bytes && Boolean(renderPreviewBytes?.equals(renderPreviewOnDisk!))
        && (FILE_MAGIC[String(renderPreview.mediaType)] ?? []).every((byte, index) => renderPreviewOnDisk![index] === byte)
        && renderPreview.width === bigRecord.attachment.width && renderPreview.height === bigRecord.attachment.height,
      bigRender?.isError ? failureOf(bigRender) : `image.path=${renderPreviewPath}（${String(renderPreviewOnDisk?.length)} B，magic 与 ${String(renderPreview.mediaType)} 一致=${String((FILE_MAGIC[String(renderPreview.mediaType)] ?? []).every((byte, index) => renderPreviewOnDisk?.[index] === byte))}，与附件附件读出的字节逐字节一致=${String(Boolean(renderPreviewBytes?.equals(renderPreviewOnDisk ?? Buffer.alloc(0))))}）；顶层 imagePath=${String(bigPayload.imagePath)}（原帧，两者不同=${String(renderPreviewPath !== bigPayload.imagePath)}）`)

    // —— 普通 `viewer_observe`（没有 cameraImage）拍到的大图同样会被附件库缩：那句话里的换算必须**写全**，
    // 不能指去读一个这张回执里根本不存在的 `cameraImage.preview`；`image` 指预览、`imagePath`/`originalImage` 指原帧。 ——
    const observeWindow = new SimWindow(harness, SESSION_C, "window-big-observe")
    observeWindow.frameDataURL = pngOfSize(BIG.width, BIG.height)
    await observeWindow.heartbeat()
    const bigObserve = (await drive(harness.tool(SESSION_C, "viewer_observe", { input: { sceneId: SCENE_A, expectedRevision: REVISION, clientId: "window-big-observe" } }), [observeWindow])).value
    const observePayload = bigObserve ? textValueOf(bigObserve) as any : {}
    const observePreview = observePayload.image ?? {}
    const observePreviewDisk = typeof observePreview.path === "string" ? await readFile(observePreview.path).catch(() => undefined) : undefined
    // 预览的宽高/格式不转述回执里的数字：把 path 上那份字节交回**附件库自己解码一遍**，看它读出几乘几。
    const observePreviewDecoded = observePreviewDisk ? await harness.ctx.get("attachments").saveImage({ data: observePreviewDisk, mediaType: observePreview.mediaType, name: "预览复核.png" }) as { width: number; height: number } : undefined
    const observeNote = String(observePayload.imagePreviewNote ?? "")
    check("a_plain_observe_of_a_reduced_frame_maps_the_preview_back_to_the_frame_without_pointing_at_missing_fields",
      Boolean(bigObserve && !bigObserve.isError) && !("cameraImage" in observePayload)
        && observePayload.originalImage?.width === BIG.width && observePayload.originalImage?.height === BIG.height
        && observePayload.imagePath === observePayload.originalImage?.path && observePreview.path !== observePayload.imagePath
        && observePreviewDecoded?.width === observePreview.width && observePreviewDecoded?.height === observePreview.height
        && observeNote.includes("u_orig=") && !observeNote.includes("cameraImage"),
      bigObserve?.isError ? failureOf(bigObserve) : `观察载荷 cameraImage 键=${String("cameraImage" in observePayload)}（应为 false）；原帧=${String(observePayload.originalImage?.width)}×${String(observePayload.originalImage?.height)}（imagePath=${String(observePayload.imagePath)}）；image.path=${String(observePreview.path)}（${String(observePreview.width)}×${String(observePreview.height)}，同一份字节交回附件库解码得到 ${String(observePreviewDecoded?.width)}×${String(observePreviewDecoded?.height)}）；提示语=${observeNote.slice(0, 120)}`)

    // 面板点击走的就是**这份函数**（`capture-panel.tsx` 直接调它）：盒上比例 → 原帧像素索引，半像素约定、整数、夹在画面内。
    const clickBox = { left: 40, top: 20, width: 600, height: 450 }
    const panelPreview = { width: observePreview.width as number, height: observePreview.height as number }
    const clickAt = (fx: number, fy: number) => framePixelOfBoxPoint({ x: clickBox.left + fx * clickBox.width, y: clickBox.top + fy * clickBox.height }, clickBox, { width: BIG.width, height: BIG.height }, panelPreview)
    const centers = [[0, 0], [1, 1], [1199, 899], [2399, 1799]] as const
    const roundTrips = centers.map(([u, v]) => clickAt((u + 0.5) / BIG.width, (v + 0.5) / BIG.height))
    check("the_panel_click_mapping_hands_down_original_frame_pixels_under_the_half_pixel_convention",
      roundTrips.every(([u, v], index) => u === centers[index]![0] && v === centers[index]![1])
        && clickAt(0, 0)[0] === 0 && clickAt(0, 0)[1] === 0
        && clickAt(1, 1)[0] === BIG.width - 1 && clickAt(1, 1)[1] === BIG.height - 1
        && clickAt(0.5, 0.5)[0] === Math.round(BIG.width / 2 - 0.5) && clickAt(0.5, 0.5)[1] === Math.round(BIG.height / 2 - 0.5),
      `盒 ${String(clickBox.width)}×${String(clickBox.height)} 里显示 ${String(panelPreview.width)}×${String(panelPreview.height)} 预览、交出去的是 ${String(BIG.width)}×${String(BIG.height)} 原帧索引：像素中心点击回原索引=${JSON.stringify(roundTrips)}（应为 ${JSON.stringify(centers.map(row => [...row]))}）；正中=${JSON.stringify(clickAt(0.5, 0.5))}；四角夹在画面内=${JSON.stringify(clickAt(0, 0))}/${JSON.stringify(clickAt(1, 1))}`)

    // —— LOD 元数据的**真实采集保存/读回**（95 号点 2）：1001 个合法 LOD 实体走真 `viewer_capture` 写进
    // `captures/*.json`，再从盘上读回来逐条核对；形状不合格的一面则留下**原因**（`lodIssue`），
    // 不能装成"场景里没有 LOD"。这里不渲 1001 株百万面全场（那是 112 原型那一轮的事）：
    // 这条测的是元数据的落盘与读回，而元数据的整形/措辞由 `lod-capture-face.test.ts` 管。 ——
    const lodWindow = new SimWindow(harness, SESSION_C, "window-lod")
    await lodWindow.heartbeat()
    const manyEntries = Array.from({ length: 1001 }, (_, index) => ({ entityId: `plant_${String(index)}`, level: index % 2, requested: index % 2, role: index % 2 ? "lod1" : "base", resource: `res_${String(index % 7)}@1`, triangles: 100 + index, distanceM: 15 + index / 1000, simplified: true }))
    const beforeLod = new Set(await harness.storedCaptures())
    const lodPosted = await lodWindow.postCapture({ sceneId: SCENE_A, sceneRevision: REVISION, clientId: "window-lod", lod: { camera: "window", planned: 1001, entries: manyEntries, skipped: [{ entityId: "rig_0", reason: "LOD_SKIPPED: 带烘焙动画" }] } }) as { saved?: boolean; captureId?: string }
    const lodFresh = (await harness.storedCaptures()).filter(name => !beforeLod.has(name))
    const lodRecord = lodFresh.length === 1 ? JSON.parse(await readFile(join(harness.captureRoot, lodFresh[0]!), "utf8")) as any : {}
    const lodRows: any[] = lodRecord.lod?.entries ?? []
    check("a_thousand_entity_lod_metadata_survives_the_real_capture_write_and_read_back",
      lodFresh.length === 1 && lodRows.length === 1001
        && lodRecord.lod?.camera === "window" && lodRecord.lod?.planned === 1001
        && lodRows[0]?.entityId === "plant_0" && lodRows[1000]?.entityId === "plant_1000"
        && lodRows[1000]?.triangles === 1100 && lodRows[1000]?.resource === `res_${String(1000 % 7)}@1`
        && lodRows[999]?.distanceM === 15.999 && lodRecord.lod?.skipped?.[0]?.entityId === "rig_0",
      `真 viewer_capture 落盘 ${String(lodFresh[0] ?? "（没有新记录）")}：读回 lod.entries=${String(lodRows.length)} 条（首/末=${String(lodRows[0]?.entityId)}/${String(lodRows[1000]?.entityId)}，第 1001 条的 triangles=${String(lodRows[1000]?.triangles)}、resource=${String(lodRows[1000]?.resource)}）、planned=${String(lodRecord.lod?.planned)}、skipped=${String(lodRecord.lod?.skipped?.length)} 条；回执 captureId=${String(lodPosted.captureId)}`)

    const beforeIssue = new Set(await harness.storedCaptures())
    const issuePosted = await lodWindow.postCapture({ sceneId: SCENE_A, sceneRevision: REVISION, clientId: "window-lod", lod: { camera: "window", planned: 2, entries: [{ ...manyEntries[0]! }, { entityId: "plant_1" }] } }) as { saved?: boolean; captureId?: string }
    const issueFresh = (await harness.storedCaptures()).filter(name => !beforeIssue.has(name))
    const issueRecord = issueFresh.length === 1 ? JSON.parse(await readFile(join(harness.captureRoot, issueFresh[0]!), "utf8")) as any : {}
    check("an_unreadable_lod_face_lands_in_the_record_as_a_reason_not_as_absence",
      issueFresh.length === 1 && issueRecord.lod === undefined
        && typeof issueRecord.lodIssue === "string" && issueRecord.lodIssue.includes("lod.entries[1]"),
      `带一条坏读数的 LOD 面照样落盘（${String(issueFresh[0] ?? "（没有新记录）")}）：记录里 lod=${String(issueRecord.lod === undefined ? "（没有这一面）" : "有")}、lodIssue=${String(issueRecord.lodIssue ?? "（缺）")} —— "读不出来"与"没有 LOD"是两件事，记录必须分得开`)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 24) P0 会话归属：每个 HTTP 入口都要能核实"这是哪个会话"，核实不出来就明确失败
  //     （不带会话标识 ≠ 默认会话；请求里写一个 sessionId ≠ 它就是那个会话）
  // ─────────────────────────────────────────────────────────────────────────
  {
    const raw = async (path: string, query: Record<string, string> = {}) => {
      const search = new URLSearchParams(query).toString()
      const response = await harness.route(path)(new Request(`http://test/api/lyapunov/${path}${search ? "?" + search : ""}`))
      const body = await response.json().catch(() => ({})) as { error?: string; scene?: unknown; uiActions?: unknown }
      return { status: response.status, body }
    }
    // (a) 不带会话标识：明确失败，而且**不能**顺手把某个会话的场景/队列交出来。
    const anonymousState = await raw("state"), anonymousScenes = await raw("scenes")
    check("an_http_route_without_a_session_fails_instead_of_answering_from_some_session",
      anonymousState.status === 400 && String(anonymousState.body.error ?? "").includes("SESSION_NOT_BOUND") && anonymousState.body.scene === undefined && anonymousState.body.uiActions === undefined
        && anonymousScenes.status === 400 && String(anonymousScenes.body.error ?? "").includes("SESSION_NOT_BOUND"),
      `state（不带 sessionId）：${String(anonymousState.status)} ${String(anonymousState.body.error ?? "").slice(0, 90)}（scene/队列字段=${String(anonymousState.body.scene === undefined && anonymousState.body.uiActions === undefined ? "没有，正确" : "被交出来了")}）；scenes：${String(anonymousScenes.status)} ${String(anonymousScenes.body.error ?? "").slice(0, 60)}`)
    // (b) 写一个**不存在**的会话标识：同样拒绝（它在别处也许是合法的字符串，但在本 Host 无法核实）。
    const ghost = await raw("state", { sessionId: "session-nobody" })
    check("an_unverifiable_session_id_is_refused_rather_than_trusted",
      ghost.status === 400 && String(ghost.body.error ?? "").includes("SESSION_NOT_BOUND"),
      `state?sessionId=session-nobody：${String(ghost.status)} ${String(ghost.body.error ?? "").slice(0, 120)}`)
    // (c) 场景清单按会话取：只在 B 的存储里出现的场景，不会出现在 A 的清单里——这正是"两个会话同一个 Host、
    // 同名 id 各自成立"在 HTTP 这一层的表现（场景存储本身由替身按会话各给一份，见 files 顶部的说明）。
    await harness.stubSceneCreate(SESSION_B, "b-only-scene")
    const scenesOfA = await raw("scenes", { sessionId: SESSION_A }), scenesOfB = await raw("scenes", { sessionId: SESSION_B })
    const ids = (value: { body: any }) => (Array.isArray(value.body) ? value.body.map((item: any) => item.sceneId) : [])
    check("scene_lists_are_per_session_over_http",
      ids(scenesOfB).includes("b-only-scene") && !ids(scenesOfA).includes("b-only-scene") && ids(scenesOfA).includes(SCENE_A),
      `只在会话 B 里建的 b-only-scene：B 的清单=${JSON.stringify(ids(scenesOfB))}；A 的清单=${JSON.stringify(ids(scenesOfA))}（A 看不到 B 的场景，也仍然只有自己的那份 ${SCENE_A}）`)
    // (d) 采集媒体按会话寻址：同一个 captureId 拿别的会话的标识读不到（它不是"全局 id"，是会话内的 id）。
    const sessionADirectory = harness.capturePath(SESSION_A, "")
    const [first] = (await harness.storedCaptures()).filter(name => join(harness.captureRoot, name).startsWith(sessionADirectory))
    const captureId = first?.slice(first.lastIndexOf("/") + 1).replace(/\.json$/, "") ?? ""
    const mediaOf = async (query: Record<string, string>) => {
      const response = await harness.route("capture")(new Request(`http://test/api/lyapunov/capture?${new URLSearchParams(query).toString()}`))
      if (response.ok) return { status: response.status, bytes: (await response.arrayBuffer()).byteLength, error: "" }
      const text = await response.text()
      try { return { status: response.status, bytes: 0, error: String((JSON.parse(text) as { error?: string }).error ?? text) } } catch { return { status: response.status, bytes: 0, error: text } }
    }
    const own = captureId ? await mediaOf({ captureId, sessionId: SESSION_A }) : { status: 0, bytes: 0, error: "NO_CAPTURE_IN_SESSION_A" }
    const foreign = captureId ? await mediaOf({ captureId, sessionId: SESSION_B }) : { status: 0, bytes: 0, error: "" }
    const anonymous = captureId ? await mediaOf({ captureId }) : { status: 0, bytes: 0, error: "" }
    check("capture_media_is_addressed_per_session",
      own.status === 200 && own.bytes >= PNG_BYTES.length && foreign.status === 400 && foreign.error.length > 0 && anonymous.status === 400 && anonymous.error.includes("SESSION_NOT_BOUND"),
      `同一个 captureId（${captureId || "（会话 A 里没有采集）"}）：本会话读=HTTP ${String(own.status)}/${String(own.bytes)} B；换成会话 B 的标识=HTTP ${String(foreign.status)}（${foreign.error.slice(0, 60)}）；不带会话标识=HTTP ${String(anonymous.status)} ${anonymous.error.slice(0, 60)}`)
    // (e) 录制同样按会话寻址：写在 A 的录制目录里的那份，B 的清单里不能出现，读取也要按会话核实
    //     （录制写入端与读取端共用同一条 `sessionNamespace(recordingRoot, 会话键)` 规则）。
    const recordingId = "recording-iso-a"
    const sessionRecordingDirectory = join(harness.recordingRoot, "sessions", safeSessionKey(SESSION_A))
    await mkdir(join(sessionRecordingDirectory, recordingId), { recursive: true })
    await writeFile(join(sessionRecordingDirectory, recordingId, "recording.json"), JSON.stringify({
      recordingId, sessionRef: SESSION_A, sceneId: SCENE_A, status: "completed", createdAt: "2026-09-20T00:00:00.000Z", runId: "run-iso",
      maxDurationS: 5, frameCount: 3, eventCount: 0, segments: [], resources: [], missing: [],
    }))
    const recordingsOfA = await raw("recordings", { sessionId: SESSION_A }), recordingsOfB = await raw("recordings", { sessionId: SESSION_B })
    const anonymousRecordings = await raw("recordings")
    const idsOf = (value: { body: any }) => Array.isArray(value.body) ? value.body.map((item: any) => item.recordingId) : []
    const replayURL = (Array.isArray(recordingsOfA.body) ? recordingsOfA.body : []).find((item: any) => item.recordingId === recordingId)?.replayURL ?? ""
    const foreignRecording = await raw("recording", { recordingId, sessionId: SESSION_B })
    check("recordings_are_addressed_per_session",
      idsOf(recordingsOfA).includes(recordingId) && !idsOf(recordingsOfB).includes(recordingId)
        && anonymousRecordings.status === 400 && String(anonymousRecordings.body.error ?? "").includes("SESSION_NOT_BOUND")
        && replayURL.includes("sessionId=" + SESSION_A) && foreignRecording.status >= 400,
      `A 的录制 ${recordingId}：A 的清单=${JSON.stringify(idsOf(recordingsOfA))}（replayURL=${replayURL}）；B 的清单=${JSON.stringify(idsOf(recordingsOfB))}；不带会话标识=HTTP ${String(anonymousRecordings.status)} ${String(anonymousRecordings.body.error ?? "").slice(0, 40)}；B 读 A 的录制=HTTP ${String(foreignRecording.status)}`)
  }
  // 25) 自动方向检查的 UI 与 Tool 入口共享真实采集/附件；像素仍由模拟窗口提供。
  {
    const agent=harness.agents.get(SESSION_A) as any
    const sent:Array<{message:any;target:string;wakeup:boolean}>=[]
    const pending:any[]=[]
    let autoClaim=true
    agent.status="idle"
    agent.inbox={remove:(messageId:string)=>{const index=pending.findIndex(message=>message.id===messageId);if(index<0)return false;pending.splice(index,1);return true}}
    agent.send=(message:any,target:string,wakeup:boolean)=>{sent.push({message,target,wakeup});pending.push(message);if(autoClaim){agent.inbox.remove(message.id);harness.ctx.emit("agent/inbox/claimed",{agent,message,turn:1})}}
    let maintenance:AbortController|undefined
    agent.runMaintenance=async(job:(signal:AbortSignal)=>Promise<unknown>)=>{maintenance=new AbortController();try{return await job(maintenance.signal)}finally{maintenance=undefined}}
    agent.cancel=()=>maintenance?.abort(new Error("用户停止"))
    const sceneId="scene-orientation-ui",rootId="orientation-root"
    await harness.stubSceneCreate(SESSION_A,sceneId)
    await harness.commitScene(SESSION_A,sceneId,0,[{op:"add",entity:{entityId:rootId,name:"新环境",transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{visual:{kind:"splat"}}}}])
    const window=new SimWindow(harness,SESSION_A,"orientation-window",{sceneId,revision:1})
    window.entityIds=[rootId];await window.heartbeat()
    const input={sessionId:SESSION_A,clientId:window.clientId,sceneId,revision:1,rootEntityIds:[rootId]}
    const raced=await drive(harness.command(SESSION_A,"viewer_orientation_check_ui",input) as Promise<ToolCallResult>,[window],{maxMs:6000})
    const face=(raced as {value?:{checkId?:string;status?:string}}).value
    const delivered=sent.at(-1),image=delivered?.message?.content?.find((block:any)=>block.type==="image")?.attachment
    const prompt=delivered?.message?.content?.find((block:any)=>block.type==="text")?.text as string|undefined
    const captureId=/初图 captureId ([^，]+)/.exec(prompt??"")?.[1]
    check("orientation_ui_import_sends_image_attachment",
      face?.status==="checking"&&typeof face.checkId==="string"&&delivered?.target==="next-turn"&&delivered.wakeup===true
      &&image?.mediaType==="image/png"&&image.bytes>0&&delivered.message.source.kind==="plugin"&&prompt?.includes(rootId)===true,
      `状态=${JSON.stringify(face)}；目标=${String(delivered?.target)}；图像=${String(image?.mediaType)}/${String(image?.bytes)} B`)
    const duplicate=await harness.command(SESSION_A,"viewer_orientation_check_ui",input) as {checkId?:string}
    check("orientation_one_batch_only_once",duplicate?.checkId===face?.checkId&&sent.length===1&&window.captures.length===1,
      `重复 id=${String(duplicate?.checkId)}；消息=${String(sent.length)}；采集=${String(window.captures.length)}`)
    const statusOf=async(sessionId:string)=>await (await harness.route("orientation-status")(new Request(`http://test/api/lyapunov/orientation-status?${new URLSearchParams({sessionId,checkId:face?.checkId??""})}`))).json() as {status?:string}|null
    const ownStatus=await statusOf(SESSION_A),otherStatus=await statusOf(SESSION_B)
    check("orientation_status_is_session_owned",ownStatus?.status==="checking"&&otherStatus===null,
      `A=${String(ownStatus?.status)}；B=${JSON.stringify(otherStatus)}`)
    const foreign=await harness.command(SESSION_B,"viewer_orientation_check_ui",input).catch(error=>String(error))
    check("orientation_ui_cross_session_refused",typeof foreign==="string"&&foreign.includes("P500")&&sent.length===1,
      `B 冒投=${String(foreign).slice(0,90)}`)
    if(face?.checkId&&captureId){
      const finished=await harness.tool(SESSION_A,"viewer_orientation_finish",{input:{checkId:face.checkId,decision:"correct",captureId}})
      check("orientation_initial_image_can_confirm_without_scene_edit",!finished.isError&&textValue(finished).status==="correct"&&textValue(finished).attempts===0,
        `finish=${JSON.stringify(textValue(finished))}`)
    }
    // Tool 观察者必须先交还原工具；真实图像随后进入该活动任务下一 step。
    harness.ctx.tools.register(defineTool({name:"scene_import",description:"本节用真实 ToolRuntime 发送一次导入回执",parameters:{input:{type:"object",required:true,additionalProperties:false,properties:{sceneId:{type:"string"},entityId:{type:"string"}}}},output:{schema:{type:"json"},render:(_args,value)=>[{type:"text",text:JSON.stringify(value)}]},execute:async(args:any)=>({snapshot:{sceneId:args.input.sceneId,revision:1,entities:[{entityId:args.input.entityId,components:{visual:{kind:"splat"}}}]},entityId:args.input.entityId}) as any}))
    const toolScene="scene-orientation-tool",toolRoot="tool-root"
    await harness.stubSceneCreate(SESSION_A,toolScene)
    await harness.commitScene(SESSION_A,toolScene,0,[{op:"add",entity:{entityId:toolRoot,transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},components:{visual:{kind:"splat"}}}}])
    const toolWindow=new SimWindow(harness,SESSION_A,"orientation-tool-window",{sceneId:toolScene,revision:1})
    toolWindow.entityIds=[toolRoot];await toolWindow.heartbeat();agent.status="running"
    const beforeTool=sent.length,tool=await harness.tool(SESSION_A,"scene_import",{input:{sceneId:toolScene,entityId:toolRoot}})
    for(let i=0;i<100&&sent.length===beforeTool;i++){await toolWindow.poll();await sleep(20)}
    check("orientation_tool_result_joins_current_next_step",!tool.isError&&sent.length===beforeTool+1&&sent.at(-1)?.target==="next-step"&&sent.at(-1)?.message?.content?.some((block:any)=>block.type==="image"),
      `工具先完成=${String(!tool.isError)}；新消息=${String(sent.length-beforeTool)}；目标=${String(sent.at(-1)?.target)}`)
    const toolPrompt=sent.at(-1)?.message?.content?.find((block:any)=>block.type==="text")?.text as string|undefined
    const toolCheckId=/检查 id ([^，]+)/.exec(toolPrompt??"")?.[1]
    if(toolCheckId){
      const adjusted=await harness.tool(SESSION_A,"viewer_orientation_adjust",{input:{checkId:toolCheckId,kind:"asset",expectedRevision:1,quaternion:[1,0,0,0]}})
      const changed=textValue(adjusted)
      await toolWindow.switchScene(toolScene,2,0);await toolWindow.heartbeat()
      const observed=await drive(harness.tool(SESSION_A,"viewer_observe",{input:{sceneId:toolScene,expectedRevision:2,clientId:toolWindow.clientId}}),[toolWindow],{maxMs:6000})
      const recheck=observed.settled?observed.value:undefined
      const captureId=recheck?textValue(recheck).captureId:undefined
      const finished=captureId?await harness.tool(SESSION_A,"viewer_orientation_finish",{input:{checkId:toolCheckId,decision:"corrected",captureId}}):undefined
      check("orientation_asset_edit_requires_new_revision_image_to_finish",
        Boolean(!adjusted.isError&&changed.sceneRevision===2&&recheck&&!recheck.isError&&imageBlock(recheck)!==undefined&&finished&&!finished.isError&&textValue(finished).status==="corrected"),
        `修改=${JSON.stringify(changed)}；复拍=${String(captureId)}；完成=${JSON.stringify(finished?textValue(finished):null)}`)
    }
    const cameraScene="scene-orientation-camera",cameraRoot="camera-root"
    await harness.stubSceneCreate(SESSION_A,cameraScene)
    await harness.commitScene(SESSION_A,cameraScene,0,[{op:"add",entity:{entityId:cameraRoot,transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},components:{visual:{kind:"splat"}}}}])
    const cameraWindow=new SimWindow(harness,SESSION_A,"orientation-camera-window",{sceneId:cameraScene,revision:1})
    cameraWindow.camera=new SimCamera(cameraWindow);cameraWindow.entityIds=[cameraRoot];await cameraWindow.heartbeat();agent.status="idle"
    const cameraUi=await drive(harness.command(SESSION_A,"viewer_orientation_check_ui",{sessionId:SESSION_A,clientId:cameraWindow.clientId,sceneId:cameraScene,revision:1,rootEntityIds:[cameraRoot]}) as Promise<ToolCallResult>,[cameraWindow],{maxMs:6000})
    const cameraCheckId=(cameraUi as {value?:{checkId?:string}}).value?.checkId
    if(cameraCheckId){
      const applied=await drive(harness.tool(SESSION_A,"viewer_orientation_adjust",{input:{checkId:cameraCheckId,kind:"camera",expectedRevision:1,camera:{position:[3.5,-4.5,2.5],target:[0,0,0.6],fovYDeg:65}}}),[cameraWindow],{maxMs:6000})
      const appliedValue=applied.settled&&applied.value?textValue(applied.value):{}
      const newImage=await drive(harness.tool(SESSION_A,"viewer_observe",{input:{sceneId:cameraScene,expectedRevision:1,clientId:cameraWindow.clientId}}),[cameraWindow],{maxMs:6000})
      const imageValue=newImage.settled&&newImage.value?textValue(newImage.value):{}
      const cameraFinished=typeof imageValue.captureId==="string"?await harness.tool(SESSION_A,"viewer_orientation_finish",{input:{checkId:cameraCheckId,decision:"corrected",captureId:imageValue.captureId}}):undefined
      const after=await harness.state(SESSION_A,cameraWindow.clientId,{sceneId:cameraScene,revision:1},cameraScene)
      const rootAfter=after.scene?.entities?.find(entity=>entity.entityId===cameraRoot) as {transform?:{quaternion?:number[]}}|undefined
      check("orientation_camera_adjust_rechecks_without_scene_root_write",
        Boolean(applied.settled&&applied.value&&!applied.value.isError&&appliedValue.kind==="camera"&&appliedValue.sceneRevision===1
          &&newImage.settled&&newImage.value&&!newImage.value.isError&&cameraFinished&&!cameraFinished.isError&&textValue(cameraFinished).status==="corrected"
          &&after.scene?.revision===1&&rootAfter?.transform?.quaternion?.[3]===1),
        `相机应用=${JSON.stringify(appliedValue)}；复拍=${String(imageValue.captureId)}；Scene rev=${String(after.scene?.revision)}`)
    }
    const staleScene="scene-orientation-stale",staleRoot="stale-root"
    await harness.stubSceneCreate(SESSION_A,staleScene)
    await harness.commitScene(SESSION_A,staleScene,0,[{op:"add",entity:{entityId:staleRoot,transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},components:{visual:{kind:"splat"}}}}])
    const staleWindow=new SimWindow(harness,SESSION_A,"orientation-stale-window",{sceneId:staleScene,revision:1})
    await staleWindow.heartbeat()
    const staleReady=await drive(harness.command(SESSION_A,"viewer_orientation_check_ui",{sessionId:SESSION_A,clientId:staleWindow.clientId,sceneId:staleScene,revision:1,rootEntityIds:[staleRoot]}) as Promise<ToolCallResult>,[staleWindow],{maxMs:6000})
    const staleId=(staleReady as {value?:{checkId?:string}}).value?.checkId
    staleWindow.sceneId=SCENE_B;staleWindow.revision=1;staleWindow.loadState={sceneId:SCENE_B,revision:1,settled:true};await staleWindow.heartbeat()
    const staleEdit=staleId?await harness.tool(SESSION_A,"viewer_orientation_adjust",{input:{checkId:staleId,kind:"asset",expectedRevision:1,quaternion:[1,0,0,0]}}):undefined
    const unchanged=await harness.state(SESSION_A,staleWindow.clientId,{sceneId:SCENE_B,revision:1},staleScene)
    check("orientation_window_switch_rejects_old_image_scene_edit",Boolean(staleEdit?.isError&&failureMessage(staleEdit).includes("ORIENTATION_WINDOW_STALE")&&unchanged.scene?.revision===1),
      `改动失败=${String(staleEdit?.isError)} ${staleEdit?failureMessage(staleEdit):"无检查"}；旧 Scene rev=${String(unchanged.scene?.revision)}`)
    // 用户 Stop 后的迟到采集：即使旧窗口 POST，不能再送唤醒消息。
    const stopScene="scene-orientation-stop",stopRoot="stop-root"
    await harness.stubSceneCreate(SESSION_A,stopScene)
    await harness.commitScene(SESSION_A,stopScene,0,[{op:"add",entity:{entityId:stopRoot,components:{visual:{kind:"splat"}}}}])
    const stopWindow=new SimWindow(harness,SESSION_A,"orientation-stop-window",{sceneId:stopScene,revision:1})
    await stopWindow.heartbeat()
    const controller=new AbortController(),beforeStop=sent.length
    const stoppedTool=await harness.tool(SESSION_A,"scene_import",{input:{sceneId:stopScene,entityId:stopRoot}},{signal:controller.signal})
    let observeId:string|undefined
    for(let i=0;i<100&&!observeId;i++){
      observeId=(await harness.state(SESSION_A,stopWindow.clientId,{sceneId:stopScene,revision:1})).uiActions?.find(item=>item.action==="captureViewer"&&item.args.clientId===stopWindow.clientId)?.id
      if(!observeId)await sleep(20)
    }
    controller.abort(new Error("用户停止"))
    const late=observeId?await stopWindow.postCapture({sceneId:stopScene,sceneRevision:1,clientId:stopWindow.clientId,observeId}) as {saved?:boolean;observe?:{settled?:boolean}}:undefined
    await sleep(20)
    check("orientation_stop_discards_late_image_without_wakeup",!stoppedTool.isError&&typeof observeId==="string"&&late?.saved===false&&late.observe?.settled===false&&sent.length===beforeStop,
      `排队=${String(Boolean(observeId))}；迟到保存=${String(late?.saved)}；Stop 后新增消息=${String(sent.length-beforeStop)}`)
    agent.status="idle"
    // UI HTTP 本身未 abort：真正调用当前 Agent.cancel，maintenance signal 必须丢弃迟到图。
    const uiStopScene="scene-orientation-ui-stop",uiStopRoot="ui-stop-root"
    await harness.stubSceneCreate(SESSION_A,uiStopScene)
    await harness.commitScene(SESSION_A,uiStopScene,0,[{op:"add",entity:{entityId:uiStopRoot,components:{visual:{kind:"splat"}}}}])
    const uiStopWindow=new SimWindow(harness,SESSION_A,"orientation-ui-stop-window",{sceneId:uiStopScene,revision:1})
    await uiStopWindow.heartbeat()
    const beforeUiStop=sent.length
    const pendingUiStop=harness.command(SESSION_A,"viewer_orientation_check_ui",{sessionId:SESSION_A,clientId:uiStopWindow.clientId,sceneId:uiStopScene,revision:1,rootEntityIds:[uiStopRoot]})
    let uiObserveId:string|undefined
    for(let i=0;i<100&&!uiObserveId;i++){
      uiObserveId=(await harness.state(SESSION_A,uiStopWindow.clientId,{sceneId:uiStopScene,revision:1})).uiActions?.find(item=>item.action==="captureViewer"&&item.args.clientId===uiStopWindow.clientId)?.id
      if(!uiObserveId)await sleep(20)
    }
    agent.cancel({kind:"user"})
    const lateUi=uiObserveId?await uiStopWindow.postCapture({sceneId:uiStopScene,sceneRevision:1,clientId:uiStopWindow.clientId,observeId:uiObserveId}) as {saved?:boolean;observe?:{settled?:boolean}}:undefined
    const stoppedUi=await pendingUiStop as {status?:string}
    check("orientation_ui_agent_stop_discards_late_image_without_http_abort",typeof uiObserveId==="string"&&lateUi?.saved===false&&lateUi.observe?.settled===false&&stoppedUi?.status==="unchecked"&&sent.length===beforeUiStop,
      `原生Agent取消=true；HTTP未主动abort；迟到保存=${String(lateUi?.saved)}；状态=${String(stoppedUi?.status)}；新消息=${String(sent.length-beforeUiStop)}`)
    // 工作台按钮在 viewer_orientation_check_ui 尚未返回时即可调用停止命令；旧窗口迟到图不能复活。
    const buttonScene="scene-orientation-button-stop",buttonRoot="button-stop-root"
    await harness.stubSceneCreate(SESSION_A,buttonScene)
    await harness.commitScene(SESSION_A,buttonScene,0,[{op:"add",entity:{entityId:buttonRoot,components:{visual:{kind:"splat"}}}}])
    const buttonWindow=new SimWindow(harness,SESSION_A,"orientation-button-window",{sceneId:buttonScene,revision:1})
    await buttonWindow.heartbeat()
    const pendingButton=harness.command(SESSION_A,"viewer_orientation_check_ui",{sessionId:SESSION_A,clientId:buttonWindow.clientId,sceneId:buttonScene,revision:1,rootEntityIds:[buttonRoot]})
    let buttonObserveId:string|undefined
    for(let i=0;i<100&&!buttonObserveId;i++){
      buttonObserveId=(await harness.state(SESSION_A,buttonWindow.clientId,{sceneId:buttonScene,revision:1})).uiActions?.find(item=>item.action==="captureViewer"&&item.args.clientId===buttonWindow.clientId)?.id
      if(!buttonObserveId)await sleep(20)
    }
    const buttonStop=await harness.command(SESSION_A,"viewer_orientation_stop_ui",{sessionId:SESSION_A,sceneId:buttonScene,revision:1}) as {status?:string}
    const buttonLate=buttonObserveId?await buttonWindow.postCapture({sceneId:buttonScene,sceneRevision:1,clientId:buttonWindow.clientId,observeId:buttonObserveId}) as {saved?:boolean}:undefined
    const buttonEnd=await pendingButton as {status?:string}
    const workbenchSource=await readFile(new URL("../src/workbench.tsx",import.meta.url),"utf8")
    check("orientation_workbench_button_stops_pending_capture",typeof buttonObserveId==="string"&&buttonStop.status==="unchecked"&&buttonEnd.status==="unchecked"&&buttonLate?.saved===false
      &&workbenchSource.indexOf("setOrientationStopTarget(stopTarget)")<workbenchSource.indexOf('api.command<{checkId:string;status:string}|null>("viewer_orientation_check_ui"')
      &&workbenchSource.includes('data-testid="orientation-stop"')&&workbenchSource.includes('onClick={()=>void stopOrientationCheck()}')&&workbenchSource.includes('"viewer_orientation_stop_ui"'),
      `按钮停止=${String(buttonStop.status)}；命令结束=${String(buttonEnd.status)}；迟到保存=${String(buttonLate?.saved)}`)
    // 图已投递、模型尚未领取时，Stop 只撤插件图像，用户待处理消息保留。
    autoClaim=false
    const queuedScene="scene-orientation-queued-stop",queuedRoot="queued-stop-root"
    await harness.stubSceneCreate(SESSION_A,queuedScene)
    await harness.commitScene(SESSION_A,queuedScene,0,[{op:"add",entity:{entityId:queuedRoot,components:{visual:{kind:"splat"}}}}])
    const queuedWindow=new SimWindow(harness,SESSION_A,"orientation-queued-window",{sceneId:queuedScene,revision:1})
    await queuedWindow.heartbeat()
    const queuedResult=await drive(harness.command(SESSION_A,"viewer_orientation_check_ui",{sessionId:SESSION_A,clientId:queuedWindow.clientId,sceneId:queuedScene,revision:1,rootEntityIds:[queuedRoot]}) as Promise<ToolCallResult>,[queuedWindow],{maxMs:6000})
    const queuedFace=(queuedResult as {value?:{checkId?:string;status?:string}}).value
    const pluginMessage=sent.at(-1)?.message
    const unrelated={id:"unrelated-user-message",source:{kind:"user"},content:[{type:"text",text:"用户自己的后续消息"}]}
    pending.push(unrelated)
    const queuedStop=await harness.command(SESSION_A,"viewer_orientation_stop_ui",{sessionId:SESSION_A,sceneId:queuedScene,revision:1,checkId:queuedFace?.checkId}) as {status?:string}
    check("orientation_stop_removes_only_unclaimed_plugin_image",queuedFace?.status==="queued"&&queuedStop.status==="unchecked"&&!pending.some(message=>message.id===pluginMessage?.id)&&pending.some(message=>message.id===unrelated.id),
      `排队=${String(queuedFace?.status)}；停止=${String(queuedStop.status)}；插件残留=${String(pending.some(message=>message.id===pluginMessage?.id))}；用户消息保留=${String(pending.some(message=>message.id===unrelated.id))}`)
    const nativeScene="scene-orientation-native-stop",nativeRoot="native-stop-root"
    await harness.stubSceneCreate(SESSION_A,nativeScene)
    await harness.commitScene(SESSION_A,nativeScene,0,[{op:"add",entity:{entityId:nativeRoot,components:{visual:{kind:"splat"}}}}])
    const nativeWindow=new SimWindow(harness,SESSION_A,"orientation-native-stop-window",{sceneId:nativeScene,revision:1})
    await nativeWindow.heartbeat()
    const nativeResult=await drive(harness.command(SESSION_A,"viewer_orientation_check_ui",{sessionId:SESSION_A,clientId:nativeWindow.clientId,sceneId:nativeScene,revision:1,rootEntityIds:[nativeRoot]}) as Promise<ToolCallResult>,[nativeWindow],{maxMs:6000})
    const nativeFace=(nativeResult as {value?:{checkId?:string;status?:string}}).value
    const nativeMessage=sent.at(-1)?.message
    // 原生 Stop 用 keepInbox=true 留下消息；运行回合变 idle 时 Shell 必须单独撤方向图。
    agent.status="running";agent.cancel({kind:"user"},{keepInbox:true});agent.status="idle";harness.ctx.emit("agent/status",{agent,status:"idle"})
    const nativeStatus=await (await harness.route("orientation-status")(new Request(`http://test/api/lyapunov/orientation-status?${new URLSearchParams({sessionId:SESSION_A,checkId:nativeFace?.checkId??""})}`))).json() as {status?:string}|null
    check("orientation_native_stop_keep_inbox_removes_only_own_image",nativeFace?.status==="queued"&&nativeStatus?.status==="unchecked"&&!pending.some(message=>message.id===nativeMessage?.id)&&pending.some(message=>message.id===unrelated.id),
      `原生Stop前=${String(nativeFace?.status)}；后=${String(nativeStatus?.status)}；方向图残留=${String(pending.some(message=>message.id===nativeMessage?.id))}；用户消息保留=${String(pending.some(message=>message.id===unrelated.id))}`)
    const oldScene="scene-orientation-old",oldRoot="old-root"
    await harness.stubSceneCreate(SESSION_A,oldScene)
    await harness.commitScene(SESSION_A,oldScene,0,[{op:"add",entity:{entityId:oldRoot,components:{visual:{kind:"splat"}}}}])
    const oldWindow=new SimWindow(harness,SESSION_A,"orientation-old-window",{sceneId:oldScene,revision:1})
    await oldWindow.heartbeat()
    const oldResult=await drive(harness.command(SESSION_A,"viewer_orientation_check_ui",{sessionId:SESSION_A,clientId:oldWindow.clientId,sceneId:oldScene,revision:1,rootEntityIds:[oldRoot]}) as Promise<ToolCallResult>,[oldWindow],{maxMs:6000})
    const oldFace=(oldResult as {value?:{checkId?:string;status?:string}}).value,oldMessage=sent.at(-1)?.message
    const newerScene="scene-orientation-newer",newerRoot="newer-root"
    await harness.stubSceneCreate(SESSION_A,newerScene)
    await harness.commitScene(SESSION_A,newerScene,0,[{op:"add",entity:{entityId:newerRoot,components:{visual:{kind:"splat"}}}}])
    const newerWindow=new SimWindow(harness,SESSION_A,"orientation-newer-window",{sceneId:newerScene,revision:1})
    await newerWindow.heartbeat()
    const newerResult=await drive(harness.command(SESSION_A,"viewer_orientation_check_ui",{sessionId:SESSION_A,clientId:newerWindow.clientId,sceneId:newerScene,revision:1,rootEntityIds:[newerRoot]}) as Promise<ToolCallResult>,[newerWindow],{maxMs:6000})
    const newerFace=(newerResult as {value?:{checkId?:string;status?:string}}).value
    check("orientation_new_import_retires_old_pending_image",oldFace?.status==="queued"&&newerFace?.status==="queued"&&!pending.some(message=>message.id===oldMessage?.id)&&pending.some(message=>message.id===unrelated.id),
      `旧=${String(oldFace?.status)}；新=${String(newerFace?.status)}；旧图残留=${String(pending.some(message=>message.id===oldMessage?.id))}；用户消息保留=${String(pending.some(message=>message.id===unrelated.id))}`)
    // 产品 Command 只在图像独占新 turn 时调用原生取消；匹配 turn/end 后才确认 Stop。
    const dedicatedScene="scene-orientation-dedicated",dedicatedRoot="dedicated-root"
    await harness.stubSceneCreate(SESSION_A,dedicatedScene)
    await harness.commitScene(SESSION_A,dedicatedScene,0,[{op:"add",entity:{entityId:dedicatedRoot,components:{visual:{kind:"splat"}}}}])
    const dedicatedWindow=new SimWindow(harness,SESSION_A,"orientation-dedicated-window",{sceneId:dedicatedScene,revision:1})
    await dedicatedWindow.heartbeat();agent.status="idle"
    const dedicatedResult=await drive(harness.command(SESSION_A,"viewer_orientation_check_ui",{sessionId:SESSION_A,clientId:dedicatedWindow.clientId,sceneId:dedicatedScene,revision:1,rootEntityIds:[dedicatedRoot]}) as Promise<ToolCallResult>,[dedicatedWindow],{maxMs:6000})
    const dedicatedFace=(dedicatedResult as {value?:{checkId?:string;status?:string}}).value,dedicatedMessage=sent.at(-1)?.message
    const boundaries:any[]=[{type:"turn/start",seq:1,data:{turn:42}}]
    agent.session.snapshotEvents=()=>boundaries
    const running=new AbortController()
    agent.status="running";agent.inbox.remove(dedicatedMessage.id)
    harness.ctx.emit("agent/inbox/claimed",{agent,message:dedicatedMessage,turn:42})
    const internalNotice=createUserMessage({content:[{type:"text",text:"内部工具提示"}],source:{kind:"plugin",plugin:"repeat-tool-reminder",form:"notice",summary:"内部提示"}})
    harness.ctx.emit("agent/inbox/claimed",{agent,message:internalNotice,turn:42})
    await agentEvents(harness.ctx,agent).waterfall("agent/pre-step",{messages:[dedicatedMessage,internalNotice],turn:42,step:1,signal:running.signal},()=>Promise.resolve({kind:"enter",messages:[dedicatedMessage,internalNotice]}))
    const laterInternal=createUserMessage({content:[{type:"text",text:"后续内部提示"}],source:{kind:"plugin",plugin:"repeat-tool-reminder",form:"notice",summary:"后续内部提示"}})
    harness.ctx.emit("agent/inbox/claimed",{agent,message:laterInternal,turn:42})
    await agentEvents(harness.ctx,agent).waterfall("agent/pre-step",{messages:[laterInternal],turn:42,step:2,signal:running.signal},()=>Promise.resolve({kind:"enter",messages:[laterInternal]}))
    let actualCancels=0
    agent.cancel=(cause:any,options:any)=>{
      actualCancels++
      if(agent.status!=="running")return
      running.abort(cause)
      const ended={type:"turn/end",seq:2,data:{turn:42,reason:{kind:"aborted",reason:cause}}}
      boundaries.push(ended);harness.ctx.emit("session/event",agent.session,ended)
      agent.status="idle";harness.ctx.emit("agent/status",{agent,status:"idle"})
      if(options?.keepInbox!==true)pending.length=0
    }
    const dedicatedStop=await harness.command(SESSION_A,"viewer_orientation_stop_ui",{sessionId:SESSION_A,sceneId:dedicatedScene,revision:1,checkId:dedicatedFace?.checkId}) as {status?:string;turnStop?:string}
    const dedicatedSceneAfter=await harness.state(SESSION_A,dedicatedWindow.clientId,{sceneId:dedicatedScene,revision:1},dedicatedScene)
    check("orientation_dedicated_button_stops_exact_claimed_turn",dedicatedFace?.status==="queued"&&dedicatedStop.status==="unchecked"&&dedicatedStop.turnStop==="confirmed"&&actualCancels===1&&running.signal.aborted&&pending.some(message=>message.id===unrelated.id)&&dedicatedSceneAfter.scene?.revision===1,
      `结果=${JSON.stringify(dedicatedStop)}；原生取消=${String(actualCancels)}；用户待办保留=${String(pending.some(message=>message.id===unrelated.id))}`)
    // 同一步混入用户输入时按钮只撤检查；当前用户回合仍由原生 Stop 自己管理。
    const sharedScene="scene-orientation-shared",sharedRoot="shared-root"
    await harness.stubSceneCreate(SESSION_A,sharedScene)
    await harness.commitScene(SESSION_A,sharedScene,0,[{op:"add",entity:{entityId:sharedRoot,components:{visual:{kind:"splat"}}}}])
    const sharedWindow=new SimWindow(harness,SESSION_A,"orientation-shared-window",{sceneId:sharedScene,revision:1})
    await sharedWindow.heartbeat();agent.status="idle"
    const sharedResult=await drive(harness.command(SESSION_A,"viewer_orientation_check_ui",{sessionId:SESSION_A,clientId:sharedWindow.clientId,sceneId:sharedScene,revision:1,rootEntityIds:[sharedRoot]}) as Promise<ToolCallResult>,[sharedWindow],{maxMs:6000})
    const sharedFace=(sharedResult as {value?:{checkId?:string;status?:string}}).value,sharedMessage=sent.at(-1)?.message
    boundaries.push({type:"turn/start",seq:3,data:{turn:43}})
    const sharedSignal=new AbortController()
    agent.status="running";agent.inbox.remove(sharedMessage.id)
    harness.ctx.emit("agent/inbox/claimed",{agent,message:sharedMessage,turn:43})
    await agentEvents(harness.ctx,agent).waterfall("agent/pre-step",{messages:[sharedMessage,unrelated],turn:43,step:1,signal:sharedSignal.signal},()=>Promise.resolve({kind:"enter",messages:[sharedMessage,unrelated]}))
    const sharedStop=await harness.command(SESSION_A,"viewer_orientation_stop_ui",{sessionId:SESSION_A,sceneId:sharedScene,revision:1,checkId:sharedFace?.checkId}) as {status?:string;turnStop?:string}
    check("orientation_shared_button_does_not_cancel_user_turn",sharedFace?.status==="queued"&&sharedStop.status==="unchecked"&&sharedStop.turnStop==="shared"&&actualCancels===1&&agent.status==="running"&&pending.some(message=>message.id===unrelated.id),
      `共享结果=${JSON.stringify(sharedStop)}；原生取消总数=${String(actualCancels)}；用户回合=${String(agent.status)}`)
    // 即使旧检查仍留 checking，只要原生 Session 已进入另一个 turn，按钮也不能误杀新回合。
    const movedScene="scene-orientation-next-turn",movedRoot="next-turn-root"
    await harness.stubSceneCreate(SESSION_A,movedScene)
    await harness.commitScene(SESSION_A,movedScene,0,[{op:"add",entity:{entityId:movedRoot,components:{visual:{kind:"splat"}}}}])
    const movedWindow=new SimWindow(harness,SESSION_A,"orientation-next-turn-window",{sceneId:movedScene,revision:1})
    await movedWindow.heartbeat();agent.status="idle"
    const movedResult=await drive(harness.command(SESSION_A,"viewer_orientation_check_ui",{sessionId:SESSION_A,clientId:movedWindow.clientId,sceneId:movedScene,revision:1,rootEntityIds:[movedRoot]}) as Promise<ToolCallResult>,[movedWindow],{maxMs:6000})
    const movedFace=(movedResult as {value?:{checkId?:string}}).value,movedMessage=sent.at(-1)?.message
    boundaries.push({type:"turn/start",seq:4,data:{turn:44}})
    const movedSignal=new AbortController()
    agent.status="running";agent.inbox.remove(movedMessage.id)
    harness.ctx.emit("agent/inbox/claimed",{agent,message:movedMessage,turn:44})
    await agentEvents(harness.ctx,agent).waterfall("agent/pre-step",{messages:[movedMessage],turn:44,step:1,signal:movedSignal.signal},()=>Promise.resolve({kind:"enter",messages:[movedMessage]}))
    boundaries.push({type:"turn/end",seq:5,data:{turn:44,reason:{kind:"completed"}}},{type:"turn/start",seq:6,data:{turn:45}})
    const movedStop=await harness.command(SESSION_A,"viewer_orientation_stop_ui",{sessionId:SESSION_A,sceneId:movedScene,revision:1,checkId:movedFace?.checkId}) as {status?:string;turnStop?:string}
    check("orientation_old_button_cannot_cancel_new_turn",movedStop.status==="unchecked"&&movedStop.turnStop==="shared"&&actualCancels===1&&agent.status==="running"&&!movedSignal.signal.aborted,
      `旧检查=${JSON.stringify(movedStop)}；原生取消总数=${String(actualCancels)}；新回合=${String(agent.status)}`)
  }
  // A08：保存metadata复用真实Tool/Command、定向队列与ACK；没有像素/GUI/原生动力学冒充。
  {
    const id="scene-a08-camera-save",client="a08-camera-window",foreign="a08-camera-foreign"
    await harness.stubSceneCreate(SESSION_A,id)
    await harness.state(SESSION_A,client,{sceneId:id,revision:0},id)
    const camera=new THREE.PerspectiveCamera(50,800/600,.04,3456)
    camera.position.set(4,5,6);camera.quaternion.setFromEuler(new THREE.Euler(.2,.3,.4))
    const k={fx:850,fy:740,cx:410.5,cy:287.25,width:800,height:600}
    camera.projectionMatrix.fromArray(projectionMatrixFromIntrinsics(k,camera.near,camera.far))
    const measured=describeCameraView(camera,{width:800,height:600}),state=cameraStateFromView(camera,{width:800,height:600},[0,0,0])
    const actionFor=async(revision:number)=>{
      for(let i=0;i<100;i++){
        const value=await harness.state(SESSION_A,client,{sceneId:id,revision},id)
        const action=value.uiActions?.find(row=>row.action==='sampleCameraViewer'&&row.args.sceneId===id)
        if(action)return action
        await sleep(5)
      }
      throw Error('A08 metadata action没有排入当前目标窗口')
    }
    let settled=false
    const pending=harness.tool(SESSION_A,'camera_scene_save',{input:{sceneId:id,expectedRevision:0,mode:'current-view',entityId:'a08-view',clientId:client}}).then(value=>{settled=true;return value})
    const action=await actionFor(0)
    check('a08_camera_save_queues_metadata_only',action.args.clientId===client&&action.action==='sampleCameraViewer'&&!('camera' in action.args),'只读当前相机metadata，不应用另一台相机、不采PNG')
    const face={sceneId:id,sceneRevision:0,view:state,state,camera:measured}
    await harness.command(SESSION_A,'ui_action_ack',{ids:[action.id],clientId:foreign,results:[{id:action.id,ok:true,clientId:foreign,value:face}]})
    const foreignAfter=await harness.state(SESSION_A,client,{sceneId:id,revision:0},id)
    check('a08_camera_save_foreign_ack_keeps_waiter',!settled&&Boolean(foreignAfter.uiActions?.some(row=>row.id===action.id)),'非目标窗口ACK不出队、不完成保存')
    await harness.command(SESSION_A,'ui_action_ack',{ids:[action.id],clientId:client,results:[{id:action.id,ok:true,clientId:client,value:face}]})
    const result=await pending,value=textValue(result),entity=value.snapshot?.entities?.find((row:any)=>row.entityId==='a08-view')
    check('a08_camera_save_tool_persists_actual_metadata',!result.isError&&value.status==='SAVED'&&value.snapshot?.revision===1&&entity?.transform?.position?.join(',')==='4,5,6'&&entity?.components?.camera?.near===.04&&entity?.components?.camera?.far===3456&&Math.abs(entity.components.camera.intrinsics.cx-k.cx)<1e-6,`Tool→metadata→CAS：${JSON.stringify({isError:result.isError,keys:Object.keys(value),position:entity?.transform?.position,near:entity?.components?.camera?.near,far:entity?.components?.camera?.far,cx:entity?.components?.camera?.intrinsics?.cx,error:failureMessage(result)})}`)
    const draft={...sceneCameraDraftOf(entity),position:'7 8 9'}
    const edited=await harness.command(SESSION_A,'camera_scene_save',{sceneId:id,expectedRevision:1,mode:'draft',entityId:'a08-view',draft}) as any
    check('a08_camera_save_command_same_contract',edited.status==='SAVED'&&edited.snapshot?.revision===2&&edited.snapshot.entities[0]?.transform?.position?.join(',')==='7,8,9'&&edited.snapshot.entities[0]?.components?.camera?.installation?.source==='current-view','人工Command与Tool共用操作；编辑保留安装来源和首次基线')
    await harness.state(SESSION_A,client,{sceneId:id,revision:2},id)
    const race=harness.tool(SESSION_A,'camera_scene_save',{input:{sceneId:id,expectedRevision:2,mode:'current-view',entityId:'a08-view',clientId:client}})
    const raceAction=await actionFor(2)
    await harness.commitScene(SESSION_A,id,2,[])
    await harness.command(SESSION_A,'ui_action_ack',{ids:[raceAction.id],clientId:client,results:[{id:raceAction.id,ok:true,clientId:client,value:{...face,sceneRevision:2}}]})
    const rejected=await race,after=await harness.state(SESSION_A,client,{sceneId:id,revision:3},id)
    check('a08_camera_save_inflight_cas_rejects_newer_scene',rejected.isError&&failureMessage(rejected).includes('SCENE_REVISION_CONFLICT')&&after.scene?.revision===3,`在途CAS：isError=${rejected.isError}，rev=${after.scene?.revision}，reason=${failureMessage(rejected)}`)
    ;(harness.ctx as any).provide('sandboxPolicy',{resolve:()=>({mode:'read-only',workspaceRoot:harness.root})})
    const readonly=await harness.tool(SESSION_A,'camera_scene_save',{input:{sceneId:id,expectedRevision:3,mode:'current-view',entityId:'a08-view',clientId:client}})
    const readonlyAfter=await harness.state(SESSION_A,client,{sceneId:id,revision:3},id)
    check('a08_camera_save_readonly_before_sampling',readonly.isError&&failureMessage(readonly).includes('SCENE_POLICY_READ_ONLY')&&!readonlyAfter.uiActions?.some(row=>row.action==='sampleCameraViewer'),'持久写守卫拒绝且没有排metadata操作')
  }

  // 独立102 CI返修：真实ui_action注册/路由→同消费handler，不让后台动作改前台UI或抢焦点。
  {
    const actions=['exitCameraView','locateTcp','locateBase']as const,id='scene-camera-surface',target='camera-surface-target',foreign='camera-surface-foreign'
    // 清掉已有窗口presence租期。没有前端时三个动作均在宿主拒绝，不能先排一个无归属请求。
    await sleep(3100)
    for(const action of actions){
      const result=await harness.tool(SESSION_A,'ui_action',{input:{action,...action==='exitCameraView'?{}:{entityId:'arm'}}})
      check('camera_surface_missing_window_'+action,result.isError&&failureMessage(result).includes('UI_ACTION_CAMERA_WINDOW_REQUIRED'),failureMessage(result))
    }
    await harness.stubSceneCreate(SESSION_A,id)
    const entity:Entity={entityId:'arm',name:'arm',transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{articulation:{}}}
    await harness.commitScene(SESSION_A,id,0,[{op:'add',entity:{...entity}}])
    await harness.state(SESSION_A,target,{sceneId:id,revision:1},id)
    await harness.state(SESSION_A,foreign,{sceneId:id,revision:1},id)
    let front=false;const calls:any[]=[],scene={sceneId:id,revision:1,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[entity]}as SceneSnapshot
    const ports={clientId:target,ownsSurface:()=>front,viewerVisible:()=>true,scene:()=>scene,viewer:()=>({exitCameraMode:(options:any)=>calls.push(['exit',options]),focusRobotAnchor:(entityId:string,kind:string)=>calls.push(['anchor',entityId,kind])}),ui:{showCentre:(value:any)=>calls.push(['centre',value]),openTool:(value:any)=>calls.push(['tool',value])},selectEntity:(value:string)=>calls.push(['select',value])}
    for(const action of actions){
      const ambiguous=await harness.tool(SESSION_A,'ui_action',{input:{action,sceneId:id,...action==='exitCameraView'?{}:{entityId:'arm'}}})
      check('camera_surface_ambiguous_window_'+action,ambiguous.isError&&failureMessage(ambiguous).includes('UI_ACTION_CAMERA_WINDOW_REQUIRED'),failureMessage(ambiguous))
      const wrong=await harness.tool(SESSION_A,'ui_action',{input:{action,clientId:'missing-client',sceneId:id,...action==='exitCameraView'?{}:{entityId:'arm'}}})
      check('camera_surface_wrong_client_'+action,wrong.isError&&failureMessage(wrong).includes('UI_ACTION_CLIENT_NOT_LIVE'),failureMessage(wrong))
      const result=await harness.tool(SESSION_A,'ui_action',{input:{action,clientId:target,sceneId:id,...action==='exitCameraView'?{}:{entityId:'arm'}}}),queued=(result.value??textValue(result))as{queued?:string}
      const read=await harness.state(SESSION_A,target,{sceneId:id,revision:1},id),item=read.uiActions?.find(row=>row.id===queued.queued)
      const other=await harness.state(SESSION_A,foreign,{sceneId:id,revision:1},id)
      if(!item)throw Error('相机导航没有排到真实目标窗口:'+JSON.stringify(result))
      calls.length=0;front=false
      const deferred=applyCameraNavigation({action,clientId:item.args.clientId as string,sceneId:id,entityId:'arm'},ports)
      const retained=await harness.state(SESSION_A,target,{sceneId:id,revision:1},id)
      check('camera_surface_background_retains_'+action,!result.isError&&deferred.disposition==='defer'&&calls.length===0&&Boolean(retained.uiActions?.some(row=>row.id===item.id))&&!other.uiActions?.some(row=>row.id===item.id),'后台未消费/确认，共享UI/焦点调用为零，非目标窗口不接此请求')
      front=true
      const adopted=applyCameraNavigation({action,clientId:item.args.clientId as string,sceneId:id,entityId:'arm'},ports)
      await harness.command(SESSION_A,'ui_action_ack',{ids:[item.id],clientId:target,results:[{id:item.id,ok:true,clientId:target}]})
      const gone=await harness.state(SESSION_A,target,{sceneId:id,revision:1},id)
      const naturalCalls=JSON.stringify(calls);calls.length=0
      const manual=applyCameraNavigation({action,sceneId:id,entityId:'arm'},ports)
      check('camera_surface_foreground_manual_same_'+action,adopted.applied&&manual.applied&&naturalCalls===JSON.stringify(calls)&&!gone.uiActions?.some(row=>row.id===item.id),'目标转前台执行并确认出队；人工/NL调用同一handler且共享UI/Viewer参数相同')
    }
  }

} finally {
  await harness.ctx.lifecycle?.dispose?.()
  await rm(harness.root, { recursive: true, force: true })
}

const failed = checks.filter(item => !item.ok)
console.log(`viewer-observe: ${String(checks.length - failed.length)}/${String(checks.length)} 通过`)
process.exit(failed.length ? 1 : 0)
