/**
 * `resource` 媒体路由的**真实宿主**夹具（2026-09-26，RESOURCE-ROUTE-BASE-TOKEN）。
 *
 * 起点是 `test/viewer-observe.ts` 的最小宿主：真 cordis + 真上游注册表/附件存储 + 真 `lyapunov-shell` 插件，
 * 只有宿主整体才有的服务（agents / settings / commands / …）用最薄替身。
 * 这里唯一的加强是**场景服务换成真的 `SceneOperations`**：本工作面要的就是"真场景文档 + 真磁盘资产 +
 * 真依赖闭包"，替身场景服务会把被测的那一环（`parseAsset` 的依赖闭包）整个换成假的。
 *
 * 用法（均从仓库根跑）：
 *   bun test packages/lyapunov-shell/test/resource-route-base-token.test.ts   # 聚焦用例
 *   bun run .runtime/lane-base-token/real-corpus.ts                           # 真实资产盘读数
 */
import { Context } from "@deepseek-ai/cordis"
import Timer from "@deepseek-ai/cordis-plugin-timer"
import AttachmentLocal from "@deepseek-ai/dsh-attachment-local"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import ToolRuntime from "@deepseek-ai/dsh-tools"
import { createScope } from "@deepseek-ai/dsh-scope"
import { SessionId } from "@deepseek-ai/dsh-session"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { SceneOperations } from "../../scene-kit/src/operations.ts"
import { projectPathsOnly, type ProductPathRoots } from "../../lyapunov-contracts/src/product-paths.ts"
import { documentReferenceLocator } from "../../viewer/src/asset-locator.ts"
import type { SceneSnapshot } from "../../lyapunov-contracts/src/types.ts"

export const SESSION = "session-route-base"

/**
 * 与 `workbench.tsx:127` 的 `viewerResourceURI` **逐字同一句**。
 * 那个文件是浏览器面：import 它会拉 `@lyapunov/viewer/client` 的 dist 包，而那份包在 Node 里
 * `window is not defined`（实测），所以宿主侧夹具只能复刻这一句。**产品那一句本身**由
 * `test/workbench-import-surface.test.tsx` 用 `mock.module` 把那个包换成桩、真的 import 进来跑一遍来钉住
 * （不是文本比对）。
 */
export const viewerResourceURI = (uri: string): string => /^(res:[^?#]+)\?ext=\.[A-Za-z0-9]+$/.exec(uri)?.[1] ?? uri

export interface Harness {
  routes: Map<string, (request: Request) => Promise<Response>>
  root: string
  operations: SceneOperations
  dispose: () => Promise<void>
}

export async function boot(options: { root?: string; sceneRoot?: string } = {}): Promise<Harness> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), "lyapunov-route-base-"))
  const sceneRoot = options.sceneRoot ?? root
  const ctx = new Context() as any
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  ctx.provide("connection", { fetch: { register: (entry: { path: string; fetch: (request: Request) => Promise<Response> }) => { routes.set(entry.path, entry.fetch); return () => routes.delete(entry.path) } } })
  const namespaces = new Set<string>()
  ctx.provide("settings", { register: (ns: string) => { namespaces.add(ns); return () => namespaces.delete(ns) }, describe: () => [...namespaces].map(ns => ({ ns, user: undefined, revision: 1, value: {} })), mutate: async () => undefined, replace: async () => undefined })
  // 真 SceneOperations：真场景存储 + 真资源库（真 index.json、真 sha256 核对）。
  const operations = new SceneOperations(sceneRoot)
  ctx.provide("scene", { forSession: () => operations })
  const agent = { id: SessionId(SESSION), ctx: createScope(ctx, { session: SESSION }).ctx, steer() {}, inject() {}, session: { id: SESSION, header: { id: SESSION }, snapshotEvents: () => [] } }
  const agents = new Map<string, unknown>([[SESSION, agent]])
  ctx.provide("agents", { get: (id: unknown) => agents.get(String(id)) })
  ctx.provide("sessions", { flush: async () => undefined })
  ctx.provide("sessionController", { resolveAgent: async (id: unknown) => agents.has(String(id)) ? { agent } : { error: new Error("SESSION_NOT_FOUND") } })
  ctx.provide("sessionQuery", { observeSession: async (id: unknown) => ({ header: { id: String(id) }, dispose: () => undefined }) })
  ctx.provide("commands", { register: () => () => undefined, execute: async () => undefined })
  // jobs/subprocess 本夹具不碰（provider 安装、后台作业）；只提供建路由期会调到的那个形状。
  ctx.provide("jobs", { attachController: () => () => undefined, start: async () => ({ jobId: "job-stub" }), get: () => undefined })
  ctx.provide("subprocess", { spawn: async () => { throw new Error("SUBPROCESS_NOT_AVAILABLE_IN_TEST") } })
  await ctx.plugin(Timer as never)
  await ctx.plugin(SystemPrompt as never)
  await ctx.plugin(AttachmentLocal as never, { dshHome: join(root, "dsh") } as never)
  await ctx.plugin(ToolRuntime as never)
  const { apply } = await import("../src/plugin.ts")
  await ctx.plugin({
    name: "lyapunov-shell-route-base",
    inject: ["connection", "commands", "agents", "scene", "sessions", "attachments", "systemPrompt", "sessionController", "sessionQuery", "tools", "jobs", "subprocess"],
    apply: (scoped: any) => apply(scoped, { captureRoot: join(root, "captures"), recordingRoot: join(root, "recordings"), dataRoot: root, catalogRoot: join(root, "catalog") }),
  } as never, undefined as never)
  return { routes, root, operations, dispose: async () => { await rm(root, { recursive: true, force: true }) } }
}

/** 场景文档写进真 `SceneStore` 读的那条路径（`SceneOperations(directory)` 省略 layout ⇒ worlds=directory）。 */
export async function writeScene(harness: Harness, snapshot: SceneSnapshot): Promise<void> {
  const directory = join(harness.root, "scenes")
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${snapshot.sceneId}.json`), JSON.stringify(snapshot, null, 1))
}

export interface ResourceRead { status: number; bytes: Buffer; error?: string }

/** 浏览器实际发出的那个请求（与 `workbench` 的 `resolveResource` → `viewerResourceURI` → `mediaURL` 同一形状）。 */
export async function fetchResource(harness: Harness, sceneId: string, uri: string): Promise<ResourceRead> {
  const route = harness.routes.get("/api/lyapunov/resource")
  if (!route) throw new Error("resource 路由没注册")
  const query = new URLSearchParams({ sessionId: SESSION, sceneId, uri: viewerResourceURI(uri) })
  const response = await route(new Request(`http://host/api/lyapunov/resource?${query.toString()}`))
  const bytes = Buffer.from(await response.arrayBuffer())
  if (response.ok) return { status: response.status, bytes }
  // 路由的错误面：JSON `{error}`（产品口径）。
  let error: string
  try { error = (JSON.parse(bytes.toString("utf8")) as { error?: string }).error ?? bytes.toString("utf8") } catch { error = bytes.toString("utf8") }
  return { status: response.status, bytes, error }
}

export interface MeshSubmission { file: string; locator: string; base: string }

/**
 * 一条文档内引用从"场景文档"走到"Viewer 交给 `resolveResource` 的定位符"。
 *
 * 真出站投影（`projectPathsOnly`）只在这里用一次：它证明 `visual.robot.baseUri` 到了浏览器手里
 * 已经是不可逆标记，而文档引用仍是相对串 —— 也就是路由侧必须自己找回基址的那条事实链。
 * `compiler.meshdir` 前缀按 `viewer/src/asset-locator.ts:composeAssetReference` 的规则合成
 * （有前缀的引用在接线层**不**换成标记，见 `workbench.tsx:104-107`）。
 */
export function viewerSubmissions(raw: SceneSnapshot, roots: ProductPathRoots = {}): Array<{ entityId: string; meshes: MeshSubmission[]; textures: MeshSubmission[] }> {
  const projected = projectPathsOnly(raw, roots) as SceneSnapshot
  const rows = (value: unknown): Array<{ file?: unknown }> => value === undefined || value === null ? [] : Array.isArray(value) ? value as Array<{ file?: unknown }> : [value as { file?: unknown }]
  const out: Array<{ entityId: string; meshes: MeshSubmission[]; textures: MeshSubmission[] }> = []
  for (const entity of projected.entities) {
    const robot = (entity.components.visual as { kind?: string; robot?: any } | undefined)?.robot
    if (!robot) continue
    const compiler = robot.document?.compiler ?? {}
    const base = typeof robot.baseUri === "string" ? robot.baseUri : ""
    const collect = (key: "mesh" | "texture", prefix: unknown): MeshSubmission[] =>
      rows(robot.document?.asset?.[key]).flatMap(row => {
        const file = typeof row.file === "string" ? row.file : ""
        if (!file) return []
        const composed = typeof prefix === "string" && prefix && !/^[a-z][a-z+.-]*:/i.test(file) ? `${prefix}/${file}` : file
        return [{ file, locator: documentReferenceLocator(composed, base).locator, base }]
      })
    out.push({
      entityId: entity.entityId,
      meshes: collect("mesh", compiler.meshdir ?? compiler.assetdir),
      textures: collect("texture", compiler.texturedir ?? compiler.assetdir),
    })
  }
  return out
}
