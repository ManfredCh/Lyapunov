import type { Context } from "@deepseek-ai/cordis"
import type { Entity } from '../../lyapunov-contracts/src/types.ts'
import { defineTool, ToolArgsError, validateArgs, type ToolExecutionInput } from "@deepseek-ai/dsh-tools"
import { writableRoots } from "@deepseek-ai/dsh-sandbox"
import type {} from "@deepseek-ai/dsh-sandbox-policy"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type {} from "@deepseek-ai/dsh-commands"
import type {} from "@deepseek-ai/dsh-client-connection"
import type { SceneCommit, SceneSnapshot } from "../../lyapunov-contracts/src/types.ts"
import { parseSceneGeometryBinding } from "../../lyapunov-contracts/src/types.ts"
import { SceneOperations } from "./operations.ts"
import { bindSessionId, requireSessionId, safeSessionKey, sessionIdOf, sessionNamespace } from "../../lyapunov-contracts/src/session-scope.ts"
import { canonicalTargetPath, isForeignSessionTarget, pathWithin } from "../../lyapunov-contracts/src/writable-boundary.ts"
import { registerUnityExchangeTools, type UnityExchangeRegistration, type UnityToolExec } from "./unity-exchange.ts"
import { resolveSceneLayout, type SceneLayout } from "./layout.ts"
import type { ResourceStorageKind } from "./resources.ts"
import { importNetworkGlb } from "./network-assets.ts"
import { environmentAssetDetail, importEnvironmentAsset, searchEnvironmentAssets } from "./environment-assets.ts"
import { registerAssetAcquisitionTools } from "./asset-acquisition.ts"
import { registerReferenceImageTools } from "./reference-tools.ts"
import { registerMapConstraintTools } from "./map-constraints.ts"
import { projStatus } from "./proj-cli.ts"
import {assetListParameters,assetVerifyParameters,resourceAuthorityParameters,sceneAlignParameters,sceneEditParameters,sceneImportParameters,sceneCreateParameters,sceneEnvironmentDetailParameters,sceneEnvironmentImportParameters,sceneEnvironmentSearchParameters,sceneInspectParameters,sceneMountParameters,sceneOpenParameters,sceneReplaceResourceParameters,sceneSaveParameters} from './tool-schema.ts'
import {modelSceneView} from './model-view.ts'
import {compatibleToolInput} from '../../lyapunov-contracts/src/tool-input.ts'
import {sceneBindPhysicsParameters,scenePhysicsUpdateParameters,sceneReconcilePhysicsParameters} from './tool-schema.ts'
import {scenePrepareWorkspaceParameters,scenePrepareWorldParameters,sceneConfigurePhysicsParameters} from './tool-schema.ts'
import {physicalizationBudgets} from './physicalization-parameters.ts'
import {resourcePhysicalizationProgress,publicPhysicalizationFacts} from './physicalization-progress.ts'
import {resolveLocalImportPath} from './local-import-entry.ts'

export const name = "lyapunov-scene"
export const inject = ["tools", "commands"]
export interface Config {
  /** 运行根（必填）：省略 layout 时五个域根都等于它，落点与过去的单根行为逐字一致。 */
  dataRoot: string
  productRoot?: string
  /** 存储分治布局：worlds（场景+环境）/assets（可调用小物件）/robots（机器人）/cache（派生+下载+CAS）/catalog（目录索引）。 */
  layout?: SceneLayout
  /** 新导入的默认存储模式：materialized 时按资源类别落进对应域目录（需要 layout）。 */
  defaultStorage?: ResourceStorageKind
  /**
   * 隔离算法解释器（碰撞派生用）：非秘密的显式配置，由装配方（script/runtime-patch.ts）与 sim/其他
   * provider 在同一处解析后传入。隔离/管理员 Host 里 LYAPUNOV_ALGORITHM_PYTHON 不进环境，
   * 不显式传就会变成"工具在、依赖不在"；省略时保持旧行为（asset-bake 自己回落环境变量）。
   */
  algorithmPython?: string
  /** 可选注册 `map_geojson_to_local`（公开 GeoJSON → 局部 ENU 米制约束）。默认关闭。
   * 打开时数值全部交给系统 PROJ 命令行（projinfo 选运算、cct 执行该运算自己的管线、geod 测大地线）：缺 PROJ 时工具调用会明确报
   * MAP_PROJ_UNAVAILABLE 并给出安装动作（不静默降级）；换 PROJ 位置用环境变量
   * MAP_CONSTRAINTS_PROJ_BIN_DIR 指向它的 bin 目录。路径与基准策略见 docs/MAP_CONSTRAINTS.md。
   */
  mapTool?: boolean
  /** Unity 场景交换：**装配方确认 Unity MCP 已显式配置**时才给（给了才注册 unity_scene_status/read/write）。 */
  unity?: UnityExchangeConfig
}

/** Unity 交换的原生接线参数（值由装配方显式给，见 script/runtime-patch.ts 与 script/unity-mcp.ts）。 */
export interface UnityExchangeConfig {
  /** 原生 MCP 实例的 namespace：工具名 `mcp__<serverName>__*`；与 script/unity-mcp.ts 的 UNITY_SERVER_NAME 同值。 */
  serverName: string
  /** 显式实例（Name@hash / hash / 端口）：同一工程多实例时必填；不给时命中多个会报 UNITY_INSTANCE_AMBIGUOUS。 */
  instance?: string
  /** 显式工程根：一般不给——工程根从编辑器自报的 mcpforunity://project/info 读，再与执行回执核对。 */
  projectPath?: string
}
/**
 * 场景服务门面：**场景与可变的资源状态按会话取用**，没有会话就没有场景操作。
 *
 * 一个会话一套 `SceneOperations`（自己的场景文档、版本历史、资源索引、派生与下载目录），
 * 即使两个会话用同一个本地 sceneId/resourceId/worldId，也各自成立、互不覆盖。
 * 跨会话共享的只有两样**不可变**的东西：内容寻址的 CAS 字节（同名即同内容、原子落位）与
 * 产品只读的内置素材库（materials/）。
 */
export interface SceneService {
  forSession(sessionKey: string): SceneOperations
}
declare module "@deepseek-ai/cordis" { interface Context { scene: SceneService } }

/**
 * 工具/命令侧取会话场景操作的唯一入口：会话身份只来自执行上下文里的原生 agent
 * （`exec.agent` / `invocation.agent`），与 sim 侧 `simWorldsFor` 同一份会话规则；取不到就明确失败。
 */
export function sceneOperationsFor(ctx: Context, owner: unknown, label = "场景服务"): SceneOperations {
  const scene = ctx.get("scene") as SceneService | undefined
  if (!scene?.forSession) throw new Error("SCENE_SERVICE_UNAVAILABLE: 当前 Profile 未启用场景服务")
  return scene.forSession(requireSessionId(owner, label))
}

/** 场景/资产入口实际取得的会话策略（原生 `sandboxPolicy.resolve` 的结果，不是本地另立的一份规则）。 */
type SceneFilePolicy = { mode: "read-only" | "workspace-write" | "danger-full-access"; workspaceRoot: string }

/**
 * 本次调用所属会话的**有效文件效果策略**：场景与资源的写入由宿主进程的 node fs 完成（不经过 worker 沙箱），
 * 所以策略必须在这些入口的实际操作边界上落实，不能因为"写入不在 worker 里"就绕过去。
 * 本部署没有策略服务、或执行上下文没有会话（CLI/SDK 等无策略部署）时返回 undefined——那里没有"模式"这回事；
 * 但只要有策略，就必须照它执行。
 */
export function scenePolicyOf(ctx: Context, owner: unknown): SceneFilePolicy | undefined {
  const policy = ctx.get("sandboxPolicy") as { resolve?: (request: { session: unknown }) => SceneFilePolicy } | undefined
  const session = (owner as { session?: unknown } | undefined)?.session
  if (typeof policy?.resolve !== "function" || session === undefined) return undefined
  return policy.resolve({ session })
}

/**
 * 用户请求的持久修改（创建/导入/编辑/删除/派生/挂载/保存…）在 **read-only** 会话里拒绝，且不产生任何落盘。
 * 只读的读与预览（清单、结构、历史、校验、投影）不走这条，照常可用。整个入口只在这一处判定，
 * 每个工具不再各自复制一份校验，也不另建权限框架。
 * @param action - 出现在错误里的动作名（哪个工具/命令被拒）。
 */
export function requireWritableScene(ctx: Context, owner: unknown, action: string): void {
  const policy = scenePolicyOf(ctx, owner)
  if (policy === undefined) return
  if (policy.mode !== "read-only") return
  throw new Error(`SCENE_POLICY_READ_ONLY: 本会话的有效策略是 read-only，${action} 属于用户请求的持久修改，已拒绝且没有写入任何文件；要修改请先把该会话切回可写模式`)
}

/**
 * 用户显式指定的**写入目标**（导出目录）也按同一策略判定：`workspace-write` 的可写范围就是原生
 * `writableRoots`（工作区根 + 平台临时区），工作区外的目标不再由宿主代写绕过策略；`danger-full-access`
 * 与无策略部署按既有行为放行。读路径不经这里——策略不限制读。
 *
 * 判定用**规范路径**而不是词法拼写（`lyapunov-contracts/writable-boundary`，与原生 fs 同一条规则）：
 * 端点是符号链接时按真实目标比较，末端路径还不存在时按缺失后缀规则回填。词法的 `relative` 会把
 * "工作区里的链接指向工作区外"当成工作区内，宿主 `node fs` 就照着链接替会话写到授权根外去了。
 * 授权根之内也**不是处处可写**：`<工作区根>/.lyapunov/sessions/<会话键>` 是**每条会话自己的**私有运行目录，
 * 只有本会话的键与工作区共享层放行，别人的会话目录一律拒绝（同一个工作区里的 A 不该替 B 落盘）。
 *
 * 这两件事（**文件效果**与**会话归属**）不是同一条：`danger-full-access` 放开的是前者，因此它在放行
 * 普通根外目标的同时，**不**解除跨会话私有目录这条应用层归属约束——所以归属判定排在模式提前返回之前。
 * @param target - 已按会话工作区解析过的目标（绝对路径或 file: URI）。
 */
export function requireWritableTarget(ctx: Context, owner: unknown, target: string, action: string): void {
  const policy = scenePolicyOf(ctx, owner)
  if (policy === undefined) return
  if (policy.mode === "read-only") return requireWritableScene(ctx, owner, action)
  const resolved = canonicalTargetPath(target.startsWith("file:") ? fileURLToPath(target) : target)
  if (isForeignSessionTarget(resolved, policy.workspaceRoot, sessionIdOf(owner))) {
    throw new Error(`SCENE_POLICY_CROSS_SESSION: ${action} 的目标 ${target} 落在同工作区里**另一条会话**的私有运行目录（${policy.workspaceRoot}/.lyapunov/sessions/<该会话>），已拒绝且没有写入任何文件；会话归属不随文件效果权限放开（danger-full-access 放开的只是文件效果），要交出产物请写到本会话自己的目录或工作区共享路径`)
  }
  if (policy.mode === "danger-full-access") return
  const inside = writableRoots(policy).some(root => pathWithin(root, resolved))
  if (!inside) {
    throw new Error(`SCENE_POLICY_OUTSIDE_WRITABLE: ${action} 的目标 ${target} 不在本次策略的可写范围内（工作区根 ${policy.workspaceRoot} 与平台临时区），已拒绝且没有写入任何文件`)
  }
}

interface BuiltinLibraryEntry { resource_id?: string; assetId?: string; category?: string; kind?: string; path?: string; displayName?: string; size_bytes?: number; sceneGeometryBinding?: unknown; transform?: unknown; components?:Entity['components'] }

/** 工具执行上下文/命令调用里取会话工作目录所需的最小形状（原生会话 header.cwd）。 */
type SessionScope = { agent?: { session?: { header?: { cwd?: string } } } | undefined }

/** 产品根优先取装配方显式传入;未传时从本文件向上找 UPSTREAM_LOCK.json(与 script/profile.ts 同一约定)。 */
function productRoot(configured?: string): string {
  if (configured) return configured
  let directory = resolve(import.meta.dirname)
  while (!existsSync(join(directory, "UPSTREAM_LOCK.json"))) {
    const parent = dirname(directory)
    if (parent === directory) throw new Error("找不到LyapunovDSH安装根目录")
    directory = parent
  }
  return directory
}

/** 内置物料库是产品自带的只读清单；path 相对 materials/ 登记，投影时解析为绝对路径。 */
async function builtinAssets(configuredRoot?: string) {
  const root = productRoot(configuredRoot)
  let library: { resources?: BuiltinLibraryEntry[] }
  try { library = JSON.parse(await readFile(join(root, "materials/library.json"), "utf8")) }
  catch { return { resources: [] } }
  const resources = (library.resources ?? []).filter((item): item is BuiltinLibraryEntry & { assetId: string; path: string } => Boolean(item?.assetId && item?.path)).map(item => {
    // 绑定的权威解析在合同侧；解析不过的脏数据静默丢弃，与只读投影风格一致。
    const sceneGeometryBinding = parseSceneGeometryBinding(item.sceneGeometryBinding)
    return {
      resourceId: item.resource_id ?? item.assetId,
      assetId: item.assetId,
      category: item.category ?? "object",
      kind: item.kind ?? "",
      path: resolve(join(root, "materials"), item.path),
      displayName: item.displayName ?? item.assetId,
      sizeBytes: item.size_bytes,
      ...(sceneGeometryBinding ? { sceneGeometryBinding } : {}),
      ...(item.transform !== undefined ? { transform: item.transform } : {}),
      ...(item.components && typeof item.components === 'object' && !Array.isArray(item.components) ? { components: structuredClone(item.components) } : {}),
    }
  })
  return { resources }
}

/** 产品根参与导入判定（内置素材引用不复制）；找不到安装根时退化为“全部按外部原件入 CAS”。 */
function detectedProductRoot(configured?: string): string | undefined {
  try { return productRoot(configured) } catch { return undefined }
}

/**
 * 参数校验失败时回执里说“收到了什么形状”，不反吐值本身（值可能带调用方自己的路径）。
 * `undefined`/`null`/空白串逐字给出，其余只给类型名。
 */
function describePathArgument(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string") return value.trim() === "" ? JSON.stringify(value) : "string"
  return typeof value
}

/** Tool 与人工 Commands 直接调用同一 operation，来源事件由 DSH 原生服务分别记账。 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!config?.dataRoot) throw new Error("SCENE_DATA_ROOT_REQUIRED")
  /**
   * 会话命名空间：场景与可变的资源状态都落到 `<域根>/sessions/<会话键>`，一个会话一套 SceneOperations。
   * 唯一共享的是**内容寻址的不可变 CAS 字节**（同名即同内容、写入用临时名 + 原子 link 且逐字节核 sha256），
   * 派生件、下载落地、目录索引与版本引用全部随会话走——修前它们共用一套，A 的加载/删除会改到 B。
   */
  const domainRoots = resolveSceneLayout(config.dataRoot, config.layout)
  const sharedCasRoot = domainRoots.split ? join(domainRoots.cache, "cas") : join(resolve(config.dataRoot), "assets", "cas")
  const sessionLayout = (key: string): SceneLayout | undefined => config.layout === undefined ? undefined : {
    worlds: join(domainRoots.worlds, "sessions", safeSessionKey(key)),
    assets: join(domainRoots.assets, "sessions", safeSessionKey(key)),
    robots: join(domainRoots.robots, "sessions", safeSessionKey(key)),
    cache: join(domainRoots.cache, "sessions", safeSessionKey(key)),
    catalog: join(domainRoots.catalog, "sessions", safeSessionKey(key)),
  }
  const sessionOperations = new Map<string, SceneOperations>()
  /** 取该会话的场景/资源操作；同一个会话只建一次。缺会话键明确失败，不落到共享存储。 */
  const operationsFor = (sessionKey: string): SceneOperations => {
    const key = typeof sessionKey === "string" ? sessionKey.trim() : ""
    if (!key) throw new Error("SESSION_SCOPE_UNAVAILABLE: 场景服务必须按会话取用（拒绝落到共享存储）")
    const existing = sessionOperations.get(key)
    if (existing) return existing
    const created = new SceneOperations(sessionNamespace(config.dataRoot, key), {
      productRoot: detectedProductRoot(config.productRoot),
      layout: sessionLayout(key),
      defaultStorage: config.defaultStorage,
      algorithmPython: config.algorithmPython,
      casRoot: sharedCasRoot,
    })
    sessionOperations.set(key, created)
    return created
  }
  /**
   * 传文件路径的工具（scene_open/scene_save/scene_import）共用这一条解析：相对路径的基准是**任务工作区**
   * （原生会话 header.cwd，与 bash/终端/asset_acquire 同一事实），不是宿主进程 cwd——那是产品安装根，
   * `scene_save {path:"deliverable/scene.json"}` 会因此把文件写到安装目录里（48 N2 的真实另一面）。
   * 绝对路径与 file: URI 原样透传（operations 侧 localPath 的同一约定）；没有会话工作目录就明确报错，
   * 不退回进程 cwd、也不逼调用方必须给绝对路径。Tools 的 exec 与 Commands 的 invocation 都带 agent，两个来源同一条解析。
   *
   * 参数缺失/类型不对/空白**必须在这里就报结构化错**：命令桥（`/scene_open {"sceneId":"…"}`）不过工具 schema，
   * `isAbsolute(undefined)` 漏出去的就是原生 `TypeError: The "path" argument must be of type string. Received undefined`
   * （真机 CU 会话 B 实测）。消息只带 label，不带任何路径。
   */
  const sessionPath = (scope: SessionScope | undefined, value: string, label: string): string => {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`SCENE_PATH_INVALID: ${label} 必须是非空字符串路径（收到 ${describePathArgument(value)}）；相对路径按当前会话的任务工作区解析`)
    if (isAbsolute(value) || value.startsWith("file:")) return value
    const cwd = scope?.agent?.session?.header?.cwd
    if (!cwd) throw new Error(`SCENE_CWD_UNRESOLVED: ${label} 是相对路径（${value}），但当前执行上下文没有会话工作目录；请传绝对路径`)
    return resolve(cwd, value)
  }
  // 自动刷新是只读投影，复用同一操作对象，不写入用户的命令时间线。
  // 没有 Web connection 的 CLI/SDK Profile 仍正常注册 Tools 和 Commands。
  ctx.inject(["connection"], host => {
    const readProjection = (path: string, read: (query: URLSearchParams) => Promise<unknown>) => host.effect(() => host.connection.fetch.register({
      path: "/api/lyapunov/" + path,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: async request => {
        try { return Response.json(await read(new URL(request.url).searchParams), { headers: { "cache-control": "private, no-cache" } }) }
        catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }) }
      },
    }))
    // 会话投影必须由请求方给出可核实的会话：缺 sessionId / 会话不存在一律明确失败（400），
    // 不落到某个共享存储去读别人的资源清单。内置素材库是产品只读清单，不随会话变化。
    const projectionOperations = async (query: URLSearchParams): Promise<SceneOperations> =>
      operationsFor(await bindSessionId(ctx, query.get("sessionId"), "场景/资源投影"))
    readProjection("assets", async query => (await projectionOperations(query)).resources.list({ query: query.get("query") ?? undefined, includeDeleted: query.get("includeDeleted") === "true" }))
    readProjection('resource-physics',async query=>{
      const operations=await projectionOperations(query),resourceId=query.get('resourceId'),version=Number(query.get('version'))
      if(!resourceId||!Number.isSafeInteger(version)||version<1)throw Error('RESOURCE_PHYSICS_IDENTITY_REQUIRED')
      const record=await operations.resources.get(resourceId,version),p=record.physicalization
      return {resourceId,version,...p?{physicalization:resourcePhysicalizationProgress(p)}:{}}
    })
    readProjection("builtin-assets", () => builtinAssets(config.productRoot))
    readProjection("scene-history", async query => (await projectionOperations(query)).versions(query.get("sceneId") ?? ""))
    readProjection("missing-assets", async query => (await projectionOperations(query)).resources.listMissing())
  })
  ctx.reflect.provide("scene", { forSession: operationsFor } satisfies SceneService)
  const json = { type: "json" as const, required: true as const, description: "Operation parameters as JSON, using the public Scene interface fields." }
  // 每个定义都接收**本次调用会话**的 operations（不是 Host 级那一套）：同名工具在两个会话里
  // 各自读写自己的场景存储与资源索引。定义表本身与会话无关，只有调用时才解析归属。
  const definitions: Array<{ name: string; description: string; /** 用户请求的持久修改：read-only 会话里在真正执行前被拒（`requireWritableScene`），读/预览不标。 */ persists?: true; operation: (operations: SceneOperations, input: any, signal?: AbortSignal, scope?: SessionScope) => Promise<any> }> = [
    { name: "scene_create", description: "Create a Scene. The default physics-workspace includes a locked, manageable zero-thickness infinite ground plane at z=0 and world gravity. Explicit blank is an editing scene; starting its first physics world prepares ground through Scene CAS. Hidden ground still collides; deletion removes physics and persists across reopening.", persists: true, operation: (operations, input) => operations.create({...input,template:input?.template??'physics-workspace'}) },
    {name:'scene_prepare_workspace',description:"Prepare the current Scene as a physics workspace through Scene CAS, adding a locked zero-thickness infinite ground plane once. Preserve gravity preferences, edited or removed ground, and existing v1 workspaces. Verified native ground replaces the untouched template collider during engine compilation; visual-only assets still lack their own collisions.",persists:true,operation:(operations,input)=>operations.prepareWorkspace(input)},
    {name:'scene_prepare_world',description:"Persist preparation before the first physics world is created. Add manageable infinite ground once through Scene CAS, preserving existing workspaces and explicit removed/disabled ground choices. ground=false records an explicit disabled choice on an unprepared Scene; it never deletes an existing ground entity. Supply the observed expectedRevision.",persists:true,operation:(operations,input)=>operations.prepareWorld(input)},
    {name:'scene_configure_physics',description:"Persist world gravityWorldMps2 through Scene CAS as three finite components in m/s². Synchronize the world and read native values; saving does not prove activation and does not change body gravity switches or fixed constraints.",persists:true,operation:(operations,input)=>operations.configurePhysics(input)},
    { name: "scene_inspect", description: "Read Scene structure, entity summaries and ResourceRefs. Supply sceneId; read original models/geometry from returned resource URIs and use robot_state for live robot state. resourcePhysicalization exposes per-resourceId@version collision receipts: status (pending/ok/failed/skipped) and usage/strategy/nodes/parts/boxes/primitives/interiorPreserved/selection/routed/voxelResolutionM/volumeRatios/cavityLostNodes/policy/attempts. Cavity preservation is inferred from actual unfilled surface voxel boxes (fillInterior=false) or a measured hull-equivalent source surface; a strategy name alone does not prove preserved cavities. Actual pitch limits clearance; passageVerified remains false until a separate spatial check. routed identifies default-strategy reroutes/reasons; cavityLostNodes identifies losses from explicit strategies in the consumer; voxelResolutionM reports actual pitch, volumeRatios decomposition volume ratios, and failures include error. asset_list exposes full records.", operation: async (operations, input) => {
      const snapshot = await operations.inspect(input.sceneId)
      const resourcePhysicalization: Record<string, unknown> = {}
      const seen = new Set<string>()
      for (const ref of snapshot.entities.flatMap(entity => entity.resources)) {
        const key = `${ref.resourceId}@${ref.version}`
        if (seen.has(key)) continue
        seen.add(key)
        const record = await operations.resources.recordFor(ref)
        const receipt = record?.physicalization
        if (!receipt) continue
        // 只透出判定用途/空腔/产出所需的事实字段，展开整条记录会把场景读取变成资源审计。
        resourcePhysicalization[key] = {
          status: receipt.status,
          ...(receipt.usage ? { usage: receipt.usage } : {}),
          ...(receipt.strategy ? { strategy: receipt.strategy } : {}),
          ...(receipt.derivedStrategy ? { derivedStrategy: receipt.derivedStrategy } : {}),
          ...(receipt.nodes !== undefined ? { nodes: receipt.nodes } : {}),
          ...(receipt.parts !== undefined ? { parts: receipt.parts } : {}),
          ...(receipt.boxes !== undefined ? { boxes: receipt.boxes } : {}),
          ...(receipt.primitives !== undefined ? { primitives: receipt.primitives } : {}),
          ...(receipt.interiorPreserved !== undefined ? { interiorPreserved: receipt.interiorPreserved } : {}),
          // 空腔/精度的实测账：逐节点表示计数、被改派的节点与原因、体素实际分辨率、凸分解体积比。
          // usage 只是请求；判断空间到底有没有被保住要看这些实际消费的表示。
          ...(receipt.selection ? { selection: receipt.selection } : {}),
          ...(receipt.routed?.length ? { routed: receipt.routed } : {}),
          ...(receipt.voxelResolutionM?.length ? { voxelResolutionM: receipt.voxelResolutionM } : {}),
          ...(receipt.volumeRatios?.length ? { volumeRatios: receipt.volumeRatios } : {}),
          // 显式策略落在"引擎消费时会失去空腔/开口"的表示上：interiorPreserved 随之 false，节点与原因
          // 在这里点名——请求被如实执行，但结果不假装空间还保着。
          ...(receipt.cavityLostNodes?.length ? { cavityLostNodes: receipt.cavityLostNodes } : {}),
          ...(receipt.policy ? { policy: receipt.policy } : {}),
          ...(receipt.attempts !== undefined ? { attempts: receipt.attempts } : {}),
          ...(receipt.supersedes ? { supersedes: true } : {}),
          ...(receipt.error ? { error: receipt.error } : {}),
          ...physicalizationBudgets(receipt),
          ...receipt.errorDetails?{errorDetails:publicPhysicalizationFacts(receipt.errorDetails)}:{},
          ...receipt.progress?{progress:resourcePhysicalizationProgress(receipt).progress}:{},
          ...receipt.pointCloud?{pointCloud:receipt.pointCloud.map(facts=>publicPhysicalizationFacts(facts))}:{},
          ...receipt.geometryTransport?{geometryTransport:Object.fromEntries(Object.entries({schema:receipt.geometryTransport.schema,version:receipt.geometryTransport.version,verified:receipt.geometryTransport.verified,nodeCount:receipt.geometryTransport.nodeCount,readBytes:receipt.geometryTransport.readBytes,sourceFrame:receipt.geometryTransport.sourceFrame,limits:receipt.geometryTransport.limits}).filter(([,value])=>value!==undefined))}:{},
        }
      }
      return { ...snapshot, resourcePhysicalization }
    } },
    { name: "scene_import_resolve", description: "Read the explicitly selected local file or directory before import. A root bundle.json selects policy import; otherwise require exactly one native URDF/MJCF/XML root. Ambiguous or absent entries report a concrete selection error without registering or mounting anything.", operation: (_operations,input,signal,scope) => resolveLocalImportPath(sessionPath(scope,input.path,"path"),signal) },
    { name: "scene_list", description: "List scenes for the current account.", operation: (operations) => operations.list() },
    { name: "scene_history", description: "List complete Scene history metadata bound to sceneId. Read the current revision before restoring.", operation: (operations, input) => operations.versions(input.sceneId) },
    { name: "scene_restore", persists: true, description: "Restore the complete Scene document using sceneId, revision and expectedRevision. Restoration creates a new revision; stale expectedRevision never overwrites the current version.", operation: (operations, input) => operations.restore(input) },
    { name: "scene_edit", persists: true, description: "Atomically edit hierarchy/entities using sceneId, expectedRevision and patch. Conflicts never overwrite newer revisions.", operation: (operations, input) => operations.scene.commit(input) },
    { name: "scene_import", persists: true, description: "Import local GLB/splat/MJCF/URDF resources, optionally mounting with sceneId. Resolve relative path values against the session task workspace, consistently with bash; absolute paths are also allowed. components declares the asset's own control/sensor/engine mappings and records resource defaults, so later resourceId mounting does not repeat them. Pure visuals need no physics properties. GLB derives collision by default; physicalize:false skips and physicalizeStrategy selects a strategy. physicalizeUsage selects dynamic (default props/dynamic bodies), static (fixed components), or environment (ground/walls/openings/building components): derive source GLB surfaces per node without filling interiors or sealing rooms/passages with convex hulls, assembling static bodies. Static/environment default checks hull equivalence per node; all other triangle surfaces use unfilled surface voxel boxes, including concave, reversed and touching closed shells, recorded in routed. All source triangles participate at the reported voxel precision; budgets fail explicitly. Asynchronous derivation requires asset_list/scene_inspect physicalization.status=ok before collision-bearing mounting.", operation: (operations, input, _signal, scope) => operations.import(typeof input?.path === "string" ? { ...input, path: sessionPath(scope, input.path, "path") } : input) },
    { name: "scene_import_url", persists: true, description: "Download a self-contained GLB with controlled anonymous HTTPS into an isolated dataRoot, then reuse scene_import and asset_verify. Forbid file://, private/loopback networks, credentials, redirects and external dependencies; single-file limit 64 MiB. Only .glb direct URLs are accepted. Use scene_asset_acquire for .gltf/.zip or 3DGS .spz/.ply/.splat; inspect supported share-page facts with scene_asset_resolve first. Do not treat a share page as GLB or HTML as a model. Supply url and optional sceneId/name/resourceId/maxBytes/physicalizeUsage; world environments/buildings use environment.", operation: (operations, input, signal) => importNetworkGlb(operations, input, signal ? { signal } : {}) },
    { name: "scene_environment_search", description: "Search public world-environment assets by natural-language requirements in the PolyHaven CC0-1.0 model catalog without credentials. Return candidate names/categories/tags/authors/licences/source pages/thumbnails; metadata only, no downloads. Check an actual candidate's manifest/category/scale with scene_environment_detail before scene_environment_import. Prioritize environmental requirements such as interiors/buildings/courtyards/terrain over individual small props.", operation: (operations, input, signal) => searchEnvironmentAssets(input, signal ? { signal } : {}) },
    { name: "scene_environment_detail", description: "Inspect a candidate's original download manifest (url/size/md5), total bytes, triangles, meshes, materials/textures, actual category such as Facades & Modules, source tags/author and visual sizeM bounds in metres. These are source-file/catalog facts: sizeM/categories/tags do not establish a complete or directly usable environment. Actual downloaded observation and assembly determine usability.", operation: (operations, input, signal) => environmentAssetDetail(input, signal ? { signal } : {}) },
    { name: "scene_environment_import", persists: true, description: "Download a public environment asset and assemble its .gltf plus dependencies as a self-contained GLB. Enforce cumulative bytes actually received and per-file md5/byte verification. Transient failures get bounded retries with cancellable backoff; completed dependencies are reused and failed-attempt bytes still count. Permanent 404/403/format/size failures stop immediately. Materialize in an isolated dataRoot, then reuse scene_import and asset_verify. Preserve source originals and a manifest containing source page/licence/author/category/file hashes in source/; resource tags record facts only. Collision derivation is disabled by default because dynamic derivation fills cavities. Explicit physicalizeUsage:'environment' enables per-surface cavity-preserving static derivation for environments/buildings/ground; the static/environment default checks hull equivalence and routes every other triangle surface to unfilled surface voxel boxes; all source triangles participate, actual precision is reported and budgets fail explicitly. Wait for physicalization.status=ok before collision-bearing mounting. Modules require purposeful assembly, collision and a minimal Sim/observation check before delivery. Supply assetId and optional sceneId/name/transform/maxBytes/physicalizeUsage.", operation: (operations, input, signal) => importEnvironmentAsset(operations, input, signal ? { signal } : {}) },
    { name: "scene_mount", persists: true, description: "Mount resourceId/version as a Scene entity with optional parentId, transform and components. Omitted components use registered resource defaults, such as a robot controller visible in asset_list. Explicit components replaces defaults by whole component key for this instance only, without changing resource defaults.", operation: (operations, input) => operations.mount(input) },
    { name: "scene_replace_resource", persists: true, description: "Replace one ResourceRef on an existing entity with another registered resource version. Preserve entityId/name/pose/parentage/user components; do not add/remove entities or change other instances/independent references. Read scene_inspect revision and asset_list resourceId/version first; select fromResourceId/fromVersion when multiple references exist. For material/texture visual updates on collision/rigidBody/controller entities, preserve derivations only when both originals have identical per-node static geometry: local metre vertex positions and triangle multisets including node/ancestor transforms and source-coordinate conversion, matching the actual display. Geometry changes, including internal pose/scale, require the target resource's registered derived defaults; missing derivation reports REPLACE_RESOURCE_PHYSICS_NOT_DERIVED rather than reusing stale collision. Unverifiable static geometry such as compression/skinning/driving animation reports REPLACE_RESOURCE_GEOMETRY_UNVERIFIABLE without writes. Native robot articulation/mujoco/isaac/visual.robot is rejected: rebuild with scene_mount. Operate on an expanded GLB group root; unsupported structure/node-local-transform/source-coordinate changes also require rebuilding mounting.", operation: (operations, input) => operations.replaceResource(input) },
    { name: "scene_open", persists: true, description: "Read the original scene.json while preserving hierarchy and ResourceRefs. Supply path, relative to the session task workspace as in bash or absolute; optional sceneId imports it as a new Scene.", operation: (operations, input, _signal, scope) => operations.open(sessionPath(scope, input.path, "path"), input) },
    { name: "scene_package_import", persists: true, description: "Import a self-contained .scene-package.json test project. Preflight originals and all dependencies once, copy through the real ResourceLibrary into this session's CAS, and produce complete source-coordinate refs. Preserve entity dimensions/physics components without expanding extra GLB entities. Return a new Scene without overwriting an existing one. Supply path and optional new sceneId.", operation: (operations, input, _signal, scope) => operations.importPackage(sessionPath(scope, input.path, "path"), input) },
    { name: "scene_save", persists: true, description: "Atomically save the Scene. portable:true copies dependencies to the target, including external textures/linked libraries of .blend originals. Rewrite absolute references only in copies, leaving original bytes unchanged. Register byte-modified copies as new resource versions allocated by the library; old versions/bytes remain. Switch Scene refs to those versions in one native CAS commit advancing revision; byte-identical registered copies reuse their existing version. Reopen locally or after moving the complete package. Supply sceneId/path; resolve relative path against the session task workspace. Incremental export: sinceRevision must name an existing earlier revision and adds changed-entity IDs/counts (added/updated/removed). diffPath writes a changeset JSON containing only changed entities, relative to the scene.json destination directory. The main export remains a complete immutable snapshot readable by scene_open. Without sinceRevision, there is no diff or guessed baseline.", operation: (operations, input, _signal, scope) => {
      const target = sessionPath(scope, input.path, "path")
      // 导出目标也按本次有效策略判定：工作区外的目标不再由宿主代写（读路径不受影响）。
      requireWritableTarget(ctx, scope?.agent, target, "场景导出 scene_save")
      const diff = typeof input?.diffPath === "string" ? sessionPath(scope, input.diffPath, "diffPath") : undefined
      if (diff !== undefined) requireWritableTarget(ctx, scope?.agent, diff, "变更集导出 scene_save")
      return operations.save(input.sceneId, target, { ...input, ...(diff === undefined ? {} : { diffPath: diff }) })
    } },
    { name: "scene_align", persists: true, description: "Align an entity using three noncollinear sourcePoints and three targetPoints, in metres. Supply sceneId/entityId/expectedRevision.", operation: (operations, input) => operations.align(input) },
    { name: "asset_list", description: "Search resources, folders and versions with query/folder/includeDeleted/allVersions. componentDefaults contains registered resource defaults, such as controller, which scene_mount uses when components is omitted.", operation: (operations, input) => operations.resources.list(input) },
    { name: "asset_edit", persists: true, description: "Edit resource names/tags/folders. deleted=true moves to recoverable trash; false restores. Originals are not deleted.", operation: (operations, input) => operations.resources.update(input.resourceId, input) },
    { name: "asset_move", persists: true, description: "Explicitly move resource originals and update authority URIs using targetPath or compatible alias path. Resolve relative paths against the session task workspace, as for scene_save. Record operationID/idempotencyKey/CAS and retain the old location as alternateLocation. Target writes follow the same effective policy boundary as scene_save: the host does not write outside the workspace or into another session's private directories within it.", operation: (operations, input, _signal, scope) => {
      const requested = typeof input?.targetPath === "string" ? input.targetPath : typeof input?.path === "string" ? input.path : undefined
      if (requested === undefined) return operations.resources.move(input)
      const target = sessionPath(scope, requested, "targetPath")
      requireWritableTarget(ctx, scope?.agent, target, "资源移动 asset_move")
      // 校验与真正落盘必须是**同一条**路径：解析后的目标原样传给操作，不让操作再按进程 cwd 解析一遍。
      return operations.resources.move({ ...input, targetPath: target })
    } },
    { name: "asset_trash", persists: true, description: "Soft-trash resources recoverably by changing authority metadata only; never physically delete user originals.", operation: (operations, input) => operations.resources.trash(input) },
    { name: "asset_restore", persists: true, description: "Restore resource authority records previously trashed/unlinked.", operation: (operations, input) => operations.resources.restore(input) },
    { name: "asset_unlink", persists: true, description: "Unlink resource authority associations with recoverable soft removal by default. asset_restore can restore them; retain network provenance and user originals.", operation: (operations, input) => operations.resources.unlink(input) },
    { name: "asset_authority_snapshot", description: "Read the sha256 registry revision and current resource-authority snapshot.", operation: (operations) => operations.resources.authoritySnapshot() },
    { name: "asset_authority_recover", persists: true, description: "Recover a corrupted authority index from its durable operation journal without deleting user originals.", operation: (operations) => operations.resources.recoverResourceAuthorityOperations() },
    {name:'scene_bind_physics',persists:true,description:"Verify the selected mesh or explicitly physicalized splat originals at the same resourceId/version, then generate/reuse actual derivations and bind the complete instance. Single/multi-mesh layouts must be complete and share one representable root transform; normalization preserves visible world matrices. Reject independently edited nodes or existing customized collision. Preserve resource usage/strategy and normal Scene CAS/history. Synchronize the same Scene world after completion.",operation:(operations,input,signal)=>operations.bindPhysics(input,signal)},
    {name:'scene_reconcile_physics',persists:true,description:"Recover this session's registered same-version collision refs and reconcile mounted derivation terminal states. Restore missing successful-cache artifacts in the original variant while preserving history and user settings. Failed resources return BIND_REQUIRED/reasons by default; only explicit retryFailed:true retries. waitForPending:true waits. Return the snapshot's actual revision with pending/issues; world startup must use that revision. pending does not mean collision-ready.",operation:(operations,input,signal)=>operations.reconcilePhysics(input,signal)},
    {name:'scene_physics_update',persists:true,description:"Update the selected instance's actual physics root through normal Scene CAS: type static fixes the body and dynamic unfixes it; massKg declares mass, gravityEnabled controls gravity and collisionEnabled controls physics collision. Fixing retains mass; unfixing needs reliable mass. Preserve collision source/friction/user components. Hiding affects visuals only, not collision. After the snapshot, synchronize the current Scene world and read compiled physics; document changes alone do not prove native activation. Native robot bodies require their dedicated interface; do not overwrite their models.",operation:(operations,input)=>operations.updatePhysics(input)},
    { name: "asset_verify", description: "Check whether the resource's current original and dependencies are missing or changed. Supply resourceId/version.", operation: (operations, input) => operations.resources.verify(input.resourceId, input.version) },
    { name: "asset_missing", description: "List resource refs whose originals could not be found during migration. Return BLOCKED without substitute files; restore the same source path and rerun migration.", operation: (operations) => operations.resources.listMissing() },
    { name: "asset_missing_rescan", description: "Read-only rescan of the same paths for BLOCKED originals. Finding an original only recommends rerunning the same migration; do not automatically import or replace it.", operation: (operations) => operations.resources.rescanMissing() },
  ]
  for (const definition of definitions) {
    const parameters = definition.name==='scene_list'||definition.name==='asset_missing'||definition.name==='asset_missing_rescan'||definition.name==='asset_authority_snapshot'||definition.name==='asset_authority_recover'
      ? {}
      : definition.name==='scene_create'?sceneCreateParameters
      : definition.name==='scene_prepare_workspace'?scenePrepareWorkspaceParameters
      : definition.name==='scene_prepare_world'?scenePrepareWorldParameters
      : definition.name==='scene_configure_physics'?sceneConfigurePhysicsParameters
      : definition.name==='scene_inspect'?sceneInspectParameters
      : definition.name==='scene_bind_physics'?sceneBindPhysicsParameters
      : definition.name==='scene_reconcile_physics'?sceneReconcilePhysicsParameters
      : definition.name==='scene_physics_update'?scenePhysicsUpdateParameters
      : definition.name==='scene_open'||definition.name==='scene_package_import'?sceneOpenParameters
      : definition.name==='scene_import_resolve'?{input:{type:'object',required:true,additionalProperties:false,properties:{path:{type:'string',required:true}}}} as const
      : definition.name==='scene_edit'?sceneEditParameters
      : definition.name==='scene_import'?sceneImportParameters
      : definition.name==='scene_mount'?sceneMountParameters
      : definition.name==='scene_replace_resource'?sceneReplaceResourceParameters
      : definition.name==='scene_save'?sceneSaveParameters
      : definition.name==='scene_align'?sceneAlignParameters
      : definition.name==='asset_verify'?assetVerifyParameters
      : definition.name==='scene_environment_search'?sceneEnvironmentSearchParameters
      : definition.name==='scene_environment_detail'?sceneEnvironmentDetailParameters
      : definition.name==='scene_environment_import'?sceneEnvironmentImportParameters
      : definition.name==='asset_list'?assetListParameters
      : ['asset_edit','asset_move','asset_trash','asset_restore','asset_unlink'].includes(definition.name)?resourceAuthorityParameters
      : { input: json }
    // 命令面判据：**与工具面同一份** `parameters`，不设例外清单（值语义由 `sessionPath` 在其后判，见下）。
    // 工具与命令共用这一次 dispatch：入参判据在这里**只有一条**，持久修改类再按**本会话有效策略**判定
    // （read-only 拒绝、不落盘），读/预览照旧。
    //
    // 为什么入参校验必须落在这一层：强制力只住在 `defineTool` 生成的 execute 包装里
    // （`@deepseek-ai/dsh-tools` 的 `schema.ts:566-568,585-589`），派发管线本身不校验
    // （`index.ts:1418-1423,1554-1559`）。命令桥（`commands.register` 的 handler 直接
    // `JSON.parse(rawInput)` 后交给 operation）完全不在那条链上，所以 `/scene_open {"sceneId":"…"}`
    // 这类缺必填的调用以前会把原生 TypeError 漏成 400（L381 真机反例）。
    // 这里用框架导出的 `validateArgs` 校验**与工具面同一份** `parameters`，并抛框架自己的
    // `ToolArgsError`（code `INVALID_ARGS`）——命令面与工具面因此得到逐字相同的错误码与错误文本；
    // 工具面在 defineTool 包装里已按同一份 spec 校验过一次，这一遍对它是同一判据的复核（合法调用零变化）。
    // 无例外清单：`path` 这类参数的**值语义**（`""`/纯空白/`file:`/跨会话私有目录）schema 表达不了，
    // 仍由 `sessionPath` 抛 `SCENE_PATH_INVALID` 等结构化码——但那发生在"已是字符串"之后；
    // 缺 `path`/非字符串在两面都先由这条 `INVALID_ARGS` 拦下（L391 统一）。
    const invoke = (source: string, owner: unknown, input: any, signal: AbortSignal | undefined, scope: SessionScope | undefined) => {
      // 零参数schema没有input槽；不能把合法{}变成JSON会丢弃的{input:undefined}。
      // 有参数的工具/命令仍共享原判据，值直接传递，不用JSON往返归一化。
      const violations = validateArgs(parameters, Object.keys(parameters).length === 0 ? {} : { input })
      if (violations.length > 0) throw new ToolArgsError(violations)
      const label = `${source} ${definition.name}`
      if (definition.persists) requireWritableScene(ctx, owner, label)
      return definition.operation(sceneOperationsFor(ctx, owner, label), input, signal, scope)
    }
    ctx.tools.register(compatibleToolInput(defineTool({
      name: definition.name,
      description: definition.description,
      parameters,
      output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(modelSceneView(value)) }] },
      execute: (args, exec) => invoke("场景工具", exec?.agent, args.input, exec.signal, exec),
    })))
    ctx.commands.register({
      name: definition.name,
      description: definition.description,
      ...(Object.keys(parameters).length ? { input: { hint: "Scene or resource parameters as JSON." } } : {}),
      async handler(invocation) {
        invocation.signal.throwIfAborted()
        const result = await invoke("场景命令", invocation.agent, JSON.parse(invocation.rawInput.trim() || "{}"), invocation.signal, invocation)
        return { kind: "success", text: JSON.stringify(result) }
      },
    })
  }
  // 公开模型资产获取（`scene_asset_acquire`）与只读分享页解析（`scene_asset_resolve`）：获取入口只做"取回 + 登记"，
  // 登记/挂载/碰撞派生复用上面这个 operations；resolve 只读公开元数据、不写资源库。
  // 相对 path 由工具自己按会话 header.cwd 解析（进程 cwd 是宿主代码根，不是用户的任务目录），这里不传 cwd。
  // 它也是**用户请求的持久修改**（下载 + 登记）：按会话策略判定后才开始取。
  registerAssetAcquisitionTools(ctx, { operationsFor: scope => { requireWritableScene(ctx, scope?.agent, "资产获取 scene_asset_acquire"); return sceneOperationsFor(ctx, scope?.agent, "资产获取") } })
  // Web 参考原图取得：只注册 `reference_image_fetch` 一个工具（搜索/网页读取仍走原生 web_search/web_fetch），
  // 原图与来源记录复用本插件的下载域，图片进模型上下文走原生 attachments。
  registerReferenceImageTools(ctx, { downloadRootFor: owner => { requireWritableScene(ctx, owner, "参考原图落盘"); return sceneOperationsFor(ctx, owner, "参考原图落盘").resources.downloadRoot } })
  // 地图工具是**可选**注册：数值全在系统 PROJ 里，缺 PROJ 的机器不该因为装配它就起不来。
  // 这里只探测一次依赖状态并记一条日志（不是健康检查、不建状态库）；真正缺 PROJ 时的行为是
  // 工具调用明确报 MAP_PROJ_UNAVAILABLE（带安装动作），绝不静默退回自造算法。
  if (config.mapTool) {
    // 探测是异步的（proj-cli 用异步子进程，等待期间事件循环不被占住），所以 apply 也是 async；
    // cordis 支持异步 apply（本仓已有先例：lyapunov-shell / lyapunov-workspace）。
    const status = await projStatus()
    const logger = ctx.logger("lyapunov-scene")
    if (status.available) logger.info(`map_geojson_to_local 已注册；PROJ ${status.version}（${status.binDir ?? "PATH"}）`)
    else logger.warn(`map_geojson_to_local 已注册，但本机 PROJ 命令行不可用：${status.error}`)
    registerMapConstraintTools(ctx)
  }
  // Unity 场景交换（任务 100 接线）：装配方**确认 Unity MCP 已显式配置**时才给 `unity`（见
  // script/runtime-patch.ts），没给就不注册——不猜测、不自己连。
  if (config.unity) registerUnityExchangeTools(ctx, unityExchangeRegistration(ctx, config.unity))
}

/**
 * Unity 交换的原生接线：**复用原生 MCP 那一条连接**（工具名 `mcp__<serverName>__*` 由上游 MCP 客户端
 * 注册；资源读走原生 `read_mcp_resource`，同一连接），不新建 JSONRPC、不自己起进程、不探端口。
 * 目标绑定仍然明确：`projectPath`/`instance` 由装配方显式给；工程根一般不给——从编辑器自报的
 * `mcpforunity://project/info` 读，并与执行回执核对（对不上就是 UNITY_PROJECT_MISMATCH，绝不"看起来像"就用）。
 * 缺编辑器/没连上时：原生工具调用会失败或工具名不存在，这里如实翻成 UNITY_MCP_UNAVAILABLE，不装成功。
 */
function unityExchangeRegistration(ctx: Context, unity: UnityExchangeConfig): UnityExchangeRegistration {
  const serverName = unity.serverName?.trim()
  if (!serverName) throw new Error("UNITY_EXCHANGE_CONFIG: unity.serverName（原生 MCP 实例的 namespace）必填——它决定 mcp__<serverName>__* 工具名")
  let counter = 0
  /** 调一次原生工具（与 Agent 用的是同一个工具运行时/同一条连接），带上这次调用的 agent/parent/signal。 */
  const runNative = async (exec: UnityToolExec | undefined, name: string, args: Record<string, unknown>) => {
    const result = await ctx.tools.execute({
      name, arguments: args, callId: `${exec?.callId ?? "lyapunov-unity-exchange"}:${name}:${++counter}` as ToolExecutionInput["callId"],
      ...(exec?.rootCallId ? { rootCallId: exec.rootCallId as ToolExecutionInput["rootCallId"] } : {}),
      // parent token 让嵌套调用在 ptc 模式下不被当成"模型直呼"而拒掉；agent 决定作用域与授权。
      ...(exec?.token !== undefined ? { parent: exec.token as ToolExecutionInput["parent"] } : {}),
      ...(exec?.agent !== undefined ? { agent: exec.agent as ToolExecutionInput["agent"] } : {}),
      signal: exec?.signal ?? new AbortController().signal,
    })
    const text = result.content.filter(block => block.type === "text").map(block => (block as { text?: string }).text ?? "").join("\n")
    // 工具名不在（MCP 没配上/没连上/Unity 编辑器没打开）：如实报"能力不在"，不装成"菜单调用失败"。
    const unavailable = /UNKNOWN_TOOL|unknown tool/i.test(text)
    return { failed: result.isError === true, unavailable, text, value: (result as { value?: unknown }).value }
  }
  return {
    // 交换读写的是**这次调用所在会话**自己的产品场景（Unity 工程仍是宿主级那一个，不按会话复制）。
    sceneFor: exec => sceneOperationsFor(ctx, exec?.agent, "Unity 场景交换"),
    ...(unity.projectPath ? { projectPath: unity.projectPath } : {}),
    ...(unity.instance ? { instance: unity.instance } : {}),
    portFor: exec => ({
      call: async (tool, args) => {
        const name = `mcp__${serverName}__${tool}`
        const call = await runNative(exec, name, args ?? {})
        if (call.unavailable) return { ok: false, text: `UNITY_MCP_UNAVAILABLE: 宿主里没有 ${name}（Unity MCP 未连接或编辑器未打开；真实连接状态看 list_mcp_servers，本模块不另开连接）` }
        const json = (() => { try { return JSON.parse(call.text) } catch { return undefined } })()
        return { ok: !call.failed && (json as { success?: boolean } | undefined)?.success !== false, text: call.text, ...(json !== undefined ? { json } : {}) }
      },
      // 资源读（工程根/实例清单）走产品已有的原生 `read_mcp_resource`（@lyapunov/mcp-extras，同一条连接）。
      // 它的参数是 `{input:{...}}` 一层（lyapunov-mcp-extras/src/plugin.ts 注册 `parameters:{input:{type:'json'}}`，
      // execute 里取 `args.input`）——与 `mcp__<server>__*` 那类上游 MCP 工具的扁平参数不同，别混。
      readResource: async uri => {
        const read = await runNative(exec, "read_mcp_resource", { input: { serverName, uri } })
        if (read.unavailable || read.failed) throw new Error(`UNITY_MCP_UNAVAILABLE: 读不到 ${uri}（${read.text.slice(0, 200)}）`)
        return read.value ?? read.text
      },
    }),
  }
}
