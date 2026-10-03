/** 真 SceneOperations + 本机 HTTP 夹具；无公网、无用户大文件。 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Context } from "@deepseek-ai/cordis"
import type { Agent } from "@deepseek-ai/dsh-agent"
import Commands from "@deepseek-ai/dsh-commands"
import { ToolCallId } from "@deepseek-ai/dsh-llm"
import Sessions, { SessionId } from "@deepseek-ai/dsh-session"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import ToolRuntime from "@deepseek-ai/dsh-tools"
import { createServer, request as httpRequest, type Server } from "node:http"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { acquirePublicAsset, registerAssetAcquisitionTools, type AssetAcquisitionDependencies } from "../src/asset-acquisition.ts"
import { inspectSogZipFile, writeSogZip } from "../src/sog-zip.ts"
import { SceneOperations } from "../src/operations.ts"

const HASH = "fixture123"
const PAGE = `https://superspl.at/scene/${HASH}`
const CDN = "https://cdn.example.org/fixture/"
const WEBP = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAdQwAIVuP+BiOh/AAA=", "base64")
const CHUNK_WEBPS = [
  WEBP,
  Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAdQqAKXp/+BiOh/AAA=", "base64"),
  Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAdQ5FLUqP+BiOh/AAA=", "base64"),
  Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAdQ+MKXov+BiOh/AAA=", "base64"),
]
const WEBPS = ["means_l.webp", "means_u.webp", "scales.webp", "quats.webp", "sh0.webp"]
const META = (count = 1) => ({
  version: 2, count,
  means: { mins: [0, 0, 0], maxs: [1, 1, 1], files: WEBPS.slice(0, 2) },
  scales: { codebook: Array(256).fill(0), files: [WEBPS[2]] },
  quats: { files: [WEBPS[3]] },
  sh0: { codebook: Array(256).fill(0), files: [WEBPS[4]] },
})
const manifest = () => ({
  version: 1, lodLevels: 2, counts: [2, 1], count: 3,
  filenames: ["tiles/alpha/meta.json", "other/beta/meta.json", "coarse/only/meta.json"],
  environment: "sky/meta.json",
  tree: { bound: { min: [-1, -1, -1], max: [1, 1, 1] }, children: [
    { bound: { min: [-1, -1, -1], max: [0, 1, 1] }, lods: { "0": { file: 0, offset: 0, count: 1 }, "1": { file: 2, offset: 0, count: 1 } } },
    { bound: { min: [0, -1, -1], max: [1, 1, 1] }, lods: { "0": { file: 1, offset: 0, count: 1 } } },
  ] },
})

let server: Server, port: number, workspace: string, operations: SceneOperations
let routes: Map<string, { body: Buffer; type: string; status?: number }>, served: string[]
let holdPath: string | undefined, onHeldRequest: (() => void) | undefined
const transport: AssetAcquisitionDependencies["transport"] = (url, options, listener) => httpRequest({
  method: options.method ?? "GET", hostname: "127.0.0.1", port, path: url.pathname + url.search, headers: options.headers,
}, listener)
const deps = (extra: AssetAcquisitionDependencies = {}): AssetAcquisitionDependencies => ({
  resolve: async () => [{ address: "93.184.216.34", family: 4 }], transport, ...extra,
})

function setupRoutes(top = manifest()): void {
  const scene = `<!doctype html><html><head><meta property="og:title" content="测试街景 - SuperSplat"/><link rel="license" href="https://creativecommons.org/licenses/by-sa/4.0/"/></head><body><script>window.__data="\\"format\\",\\"ssog\\",\\"username\\",\\"artist\\""</script></body></html>`
  routes.set(`/scene/${HASH}`, { body: Buffer.from(scene), type: "text/html" })
  routes.set("/s", { body: Buffer.from(`<script id="sse-bootstrap">{"contentUrl":"${CDN}lod-meta.json"}</script>`), type: "text/html" })
  routes.set("/fixture/lod-meta.json", { body: Buffer.from(JSON.stringify(top)), type: "application/json" })
  for (const [index, name] of [...top.filenames, top.environment].entries()) {
    const prefix = name.slice(0, -"meta.json".length)
    routes.set(`/fixture/${name}`, { body: Buffer.from(JSON.stringify(META())), type: "application/json" })
    for (const image of WEBPS) routes.set(`/fixture/${prefix}${image}`, { body: CHUNK_WEBPS[index]!, type: "image/webp" })
  }
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "ssog-acquire-"))
  operations = new SceneOperations(join(workspace, "data"))
  routes = new Map(); served = []; holdPath = undefined; onHeldRequest = undefined; setupRoutes()
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0]!
    served.push(path)
    const route = routes.get(path)
    if (!route) { res.writeHead(404); res.end("missing"); return }
    res.writeHead(route.status ?? 200, { "content-type": route.type, "content-length": String(route.body.length) })
    if (path === holdPath) { res.write(route.body.subarray(0, 10)); onHeldRequest?.(); return }
    res.end(route.body)
  })
  await new Promise<void>(ready => server.listen(0, "127.0.0.1", ready))
  port = (server.address() as { port: number }).port
})

afterEach(async () => {
  server.closeAllConnections?.()
  await new Promise<void>(ready => server.close(() => ready()))
  await rm(workspace, { recursive: true, force: true })
})

describe("公开 SSOG 只给分享页的真实获取与场景合同", () => {
  it("默认 LOD0 取两块与环境，逐块注册并一次 CAS 挂同组，结果不暴露宿主路径", async () => {
    await operations.create({ sceneId: "scene_ssog" })
    const result = await acquirePublicAsset(operations, { url: PAGE, sceneId: "scene_ssog", splatMaxBytes: 2 * 1024 * 1024 }, deps())
    expect("kind" in result && result.kind).toBe("streamed-sog")
    if (!("kind" in result && result.kind === "streamed-sog")) return
    expect(result.selectedLod).toBe(0)
    expect(result.expectedGaussians).toBe(2)
    expect(result.actualGaussians).toBe(2)
    expect(result.resources.map(item => item.fileIndex)).toEqual([0, 1])
    expect(result.environment?.fileIndex).toBe("environment")
    expect(result.scene).toEqual({ sceneId: "scene_ssog", revision: 1, entityCount: 4 })
    expect(result.groupEntityId).toBeTruthy()
    expect(result.resources.every(item => !!item.entityId)).toBe(true)
    expect(result.sourceFacts.license).toBe("CC-BY-SA-4.0")
    expect(result.budget.networkBytes).toBeGreaterThan(0)
    expect(result.budget.archiveBytes).toBeGreaterThan(0)
    expect(JSON.stringify(result)).not.toContain(operations.resources.downloadRoot)
    const scene = await operations.scene.snapshot("scene_ssog")
    expect(scene.entities.filter(entity => entity.parentId === result.groupEntityId)).toHaveLength(3)
    expect(scene.entities.find(entity => entity.entityId === result.groupEntityId)?.components.visual?.kind).toBe("group")
    for (const item of [...result.resources, result.environment!]) {
      const record = await operations.resources.get(item.resourceId, item.version)
      expect(record.ref.original.mimeType).toBe("application/x-sog")
      expect((await inspectSogZipFile(fileURLToPath(record.ref.original.uri), 1024 * 1024)).count).toBe(item.gaussians)
    }
    expect(served).not.toContain("/fixture/coarse/only/meta.json")
  })

  it("显式较低层仅取该层；不带 sceneId 只登记并明确派生品质", async () => {
    const result = await acquirePublicAsset(operations, { url: PAGE, selectedLod: 1, splatMaxBytes: 2 * 1024 * 1024 }, deps())
    expect("kind" in result && result.kind).toBe("streamed-sog")
    if (!("kind" in result && result.kind === "streamed-sog")) return
    expect(result.selectedLod).toBe(1)
    expect(result.resources.map(item => item.fileIndex)).toEqual([2])
    expect(result.expectedGaussians).toBe(1)
    expect(result.environment?.gaussians).toBe(1)
    expect(result.quality).toBe("public-ssog-derived")
    expect(result.scene).toBeUndefined()
    expect(served).not.toContain("/fixture/tiles/alpha/meta.json")
  })

  it("层预算不足和当前封装法不能表示的部分块均零场景提交，绝不静默降层", async () => {
    await operations.create({ sceneId: "scene_budget" })
    await expect(acquirePublicAsset(operations, { url: PAGE, sceneId: "scene_budget", splatMaxBytes: 4500 }, deps())).rejects.toThrow(/SSOG_BUDGET_INSUFFICIENT.*未自动降级/)
    expect((await operations.scene.snapshot("scene_budget")).revision).toBe(0)
    expect((await readdir(operations.resources.downloadRoot)).length).toBe(0)
    const altered = manifest()
    altered.tree.children[0].lods["0"].offset = 1
    routes.set("/fixture/lod-meta.json", { body: Buffer.from(JSON.stringify(altered)), type: "application/json" })
    await expect(acquirePublicAsset(operations, { url: PAGE, sceneId: "scene_budget", splatMaxBytes: 2 * 1024 * 1024 }, deps())).rejects.toThrow(/SSOG_CHUNK_PARTIAL_METHOD_UNAVAILABLE/)
    expect((await operations.scene.snapshot("scene_budget")).revision).toBe(0)
  })

  it("环境件已登记后校验失败，回执列出全部已登记引用且场景不半挂载", async () => {
    await operations.create({ sceneId: "scene_partial" })
    const original = operations.resources.verify.bind(operations.resources)
    let calls = 0
    operations.resources.verify = async (...args) => {
      calls++
      if (calls === 3) throw new Error("夹具第三件校验失败")
      return original(...args)
    }
    let message = ""
    try { await acquirePublicAsset(operations, { url: PAGE, sceneId: "scene_partial", splatMaxBytes: 2 * 1024 * 1024 }, deps()) }
    catch (error) { message = String(error) }
    expect(message).toContain("SSOG_PARTIAL_IMPORT")
    expect(message).toContain('"fileIndex":"environment"')
    expect((await operations.scene.snapshot("scene_partial")).revision).toBe(0)
    expect((await operations.resources.list()).length).toBe(3)
  })

  it("资源均齐后批量挂载验证期间 Stop，不发 Scene CAS", async () => {
    await operations.create({ sceneId: "scene_stopped" })
    const controller = new AbortController()
    const original = operations.resources.verify.bind(operations.resources)
    let calls = 0
    operations.resources.verify = async (...args) => {
      calls++
      const value = await original(...args)
      if (calls === 4) controller.abort(new Error("用户停止"))
      return value
    }
    await expect(acquirePublicAsset(operations, { url: PAGE, sceneId: "scene_stopped", splatMaxBytes: 2 * 1024 * 1024 }, deps({ signal: controller.signal }))).rejects.toThrow(/SSOG_PARTIAL_IMPORT.*用户停止/)
    expect((await operations.scene.snapshot("scene_stopped")).revision).toBe(0)
    expect(calls).toBe(4)
  })

  it("WebP 流式取件中 Stop，清本次落地目录且不注册资源/改场景", async () => {
    await operations.create({ sceneId: "scene_early_stop" })
    const controller = new AbortController()
    holdPath = "/fixture/tiles/alpha/means_l.webp"
    onHeldRequest = () => queueMicrotask(() => controller.abort(new Error("用户停止取件")))
    await expect(acquirePublicAsset(operations, { url: PAGE, sceneId: "scene_early_stop", splatMaxBytes: 2 * 1024 * 1024 }, deps({ signal: controller.signal }))).rejects.toThrow(/用户停止取件/)
    expect(served).toContain(holdPath)
    expect((await operations.scene.snapshot("scene_early_stop")).revision).toBe(0)
    expect((await operations.resources.list()).length).toBe(0)
    expect((await readdir(operations.resources.downloadRoot)).length).toBe(0)
  })

  it("公开单文件 .sog 直链走独立 splat 结果，假 ZIP/HTML 不能冒充", async () => {
    const source = join(workspace, "sog-source")
    await mkdirFixture(source)
    const zip = join(workspace, "direct.sog")
    await writeSogZip(zip, source, ["meta.json", ...WEBPS])
    routes.set("/fixture/direct.sog", { body: await readFile(zip), type: "application/octet-stream" })
    const result = await acquirePublicAsset(operations, { url: `${CDN}direct.sog`, formatHint: "sog", splatMaxBytes: 1024 * 1024 }, deps())
    expect("kind" in result).toBe(false)
    if ("acquisition" in result && result.acquisition.container === "splat") { expect(result.acquisition.format).toBe("sog"); expect(result.acquisition.gaussianCount).toBe(1) }
    routes.set("/fixture/fake.sog", { body: Buffer.from("PK\x03\x04notsog", "binary"), type: "application/zip" })
    await expect(acquirePublicAsset(operations, { url: `${CDN}fake.sog`, splatMaxBytes: 1024 * 1024 }, deps())).rejects.toThrow(/SOG_ZIP_INVALID|SOG_META_MISSING/)
    routes.set("/fixture/login.sog", { body: Buffer.from("<html>login</html>"), type: "text/html" })
    await expect(acquirePublicAsset(operations, { url: `${CDN}login.sog`, splatMaxBytes: 1024 * 1024 }, deps())).rejects.toThrow(/MIME_REJECTED/)
  })

  it("真实 ToolRuntime schema/调用与 Command 接受 selectedLod、formatHint:sog，额外字段被拒", async () => {
    const source = join(workspace, "tool-sog-source")
    await mkdirFixture(source)
    const zip = join(workspace, "tool-direct.sog")
    await writeSogZip(zip, source, ["meta.json", ...WEBPS])
    routes.set("/fixture/tool-direct.sog", { body: await readFile(zip), type: "application/octet-stream" })
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(Sessions)
    await ctx.plugin(Commands)
    registerAssetAcquisitionTools(ctx, { operationsFor: () => operations, dependencies: deps() })
    try {
      const schemas = ctx.tools.schemas()
      const acquire = schemas.find(item => item.name === "scene_asset_acquire")
      const resolve = schemas.find(item => item.name === "scene_asset_resolve")
      expect(JSON.stringify(acquire)).toContain("selectedLod")
      expect(JSON.stringify(acquire)).toContain('"const":"sog"')
      expect(JSON.stringify(resolve)).toContain("streamed-sog")
      const session = ctx.sessions.create(SessionId("ssog-model-schema"), { meta: { cwd: workspace } })
      const agent = { id: session.id, session } as Agent
      const resolved = await ctx.tools.execute({ callId: ToolCallId("ssog-resolved"), name: "scene_asset_resolve", arguments: { input: { url: PAGE } }, signal: new AbortController().signal, agent })
      if (resolved.isError) throw new Error(JSON.stringify(resolved))
      expect(resolved.isError).toBe(false)
      const resolvedText = resolved.content.filter(block => block.type === "text").map(block => (block as { text: string }).text).join("")
      expect(JSON.parse(resolvedText).kind).toBe("streamed-sog")
      const selected = await ctx.tools.execute({ callId: ToolCallId("ssog-selected"), name: "scene_asset_acquire", arguments: { input: { url: PAGE, selectedLod: 1, splatMaxBytes: 2 * 1024 * 1024 } }, signal: new AbortController().signal, agent })
      expect(selected.isError).toBe(false)
      const selectedText = selected.content.filter(block => block.type === "text").map(block => (block as { text: string }).text).join("")
      expect(JSON.parse(selectedText).selectedLod).toBe(1)
      expect(selectedText).not.toContain(operations.resources.downloadRoot)
      const direct = await ctx.tools.execute({ callId: ToolCallId("sog-direct"), name: "scene_asset_acquire", arguments: { input: { url: `${CDN}tool-direct.sog`, formatHint: "sog" } }, signal: new AbortController().signal, agent })
      expect(direct.isError).toBe(false)
      const directText = direct.content.filter(block => block.type === "text").map(block => (block as { text: string }).text).join("")
      expect(JSON.parse(directText).acquisition.format).toBe("sog")
      const bad = await ctx.tools.execute({ callId: ToolCallId("sog-bad-arg"), name: "scene_asset_acquire", arguments: { input: { url: PAGE, selectedLod: 1, unexpected: true } }, signal: new AbortController().signal, agent })
      expect(bad.isError).toBe(true)
      const command = await ctx.commands.execute(agent, `/scene_asset_acquire ${JSON.stringify({ url: PAGE, selectedLod: 1, splatMaxBytes: 2 * 1024 * 1024 })}`, [], new AbortController().signal)
      expect(command?.result.kind).toBe("success")
      expect(JSON.parse(command!.result.text!).selectedLod).toBe(1)
    } finally { await ctx.fiber.dispose() }
  })
})

async function mkdirFixture(source: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises")
  await mkdir(source)
  await writeFile(join(source, "meta.json"), JSON.stringify(META()))
  for (const image of WEBPS) await writeFile(join(source, image), WEBP)
}
