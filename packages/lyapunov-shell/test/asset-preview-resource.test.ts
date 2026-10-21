/**
 * V10-08 放置预览媒体鉴权：只认当前 session 已登记的 resourceId/version，再用该版本自己的
 * 原件/表示/依赖闭包做等值授权；不接受任意 path，不扩大既有 Scene resource 路由。
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { boot } from "./resource-route-harness.ts"
import { resourceToken } from "../../lyapunov-contracts/src/product-paths.ts"

const ROOT = resolve(import.meta.dir, "..", "..", "..")
const GLB = resolve(ROOT, "materials/mcp-env/assets/kenney-props/visual/prop_10_traffic-light.glb")
const PANDA = resolve(ROOT, "materials/robots/franka_panda/franka_emika_panda/panda.xml")
const firstToken = (value: unknown): string | undefined => { if (typeof value === "string") return value.startsWith("res:") ? value : undefined; if (Array.isArray(value)) for (const row of value) { const hit = firstToken(row); if (hit) return hit } if (value && typeof value === "object") for (const row of Object.values(value)) { const hit = firstToken(row); if (hit) return hit } }

async function fetchPreview(harness: Awaited<ReturnType<typeof boot>>, params: { sessionId?: string; resourceId: string; version: number | string; uri: string }) {
  const route = harness.routes.get("/api/lyapunov/asset-preview-resource")
  if (!route) throw new Error("asset-preview-resource 路由没注册")
  const query = new URLSearchParams({ sessionId: params.sessionId ?? "session-route-base", resourceId: params.resourceId, version: String(params.version), uri: params.uri })
  // 与浏览器 mediaURL 同形：sessionId 由宿主注入，uri 是资源标记/相对引用。
  const response = await route(new Request(`http://host/api/lyapunov/asset-preview-resource?${query.toString()}`))
  const bytes = Buffer.from(await response.arrayBuffer())
  if (response.ok) return { status: response.status, bytes }
  let error: string
  try { error = (JSON.parse(bytes.toString("utf8")) as { error?: string }).error ?? bytes.toString("utf8") } catch { error = bytes.toString("utf8") }
  return { status: response.status, bytes, error }
}

describe("V10 放置预览媒体路由", () => {
  test("已登记版本的原件标记可读回同一份字节；越界/错误版本/跨会话拒绝", async () => {
    const harness = await boot()
    try {
      const imported = await harness.operations.import({ path: GLB, resourceId: "preview-resource", physicalize: false })
      const record = imported.resource
      const token = resourceToken(record.ref.original.uri)
      const ok = await fetchPreview(harness, { resourceId: record.ref.resourceId, version: record.ref.version, uri: token })
      expect(ok.status).toBe(200)
      expect(createHash("sha256").update(ok.bytes).digest("hex")).toBe(createHash("sha256").update(await readFile(GLB)).digest("hex"))
      // 同一件也可以按已登记的原件 URI 取；仍然只在这一条版本候选集里匹配。
      expect((await fetchPreview(harness, { resourceId: record.ref.resourceId, version: record.ref.version, uri: record.ref.original.uri })).status).toBe(200)
      // 越界/未登记件。
      const outside = await fetchPreview(harness, { resourceId: record.ref.resourceId, version: record.ref.version, uri: "../../outside.glb" })
      expect(outside.error).toContain("ASSET_PREVIEW_RESOURCE_NOT_AUTHORIZED")
      // 错误版本。
      const wrongVersion = await fetchPreview(harness, { resourceId: record.ref.resourceId, version: record.ref.version + 99, uri: token })
      expect(wrongVersion.status).not.toBe(200)
      // 跨会话：同一 resourceId 不能串用别的 session。
      const crossSession = await fetchPreview(harness, { sessionId: "other-session", resourceId: record.ref.resourceId, version: record.ref.version, uri: token })
      expect(crossSession.status).not.toBe(200)
      // 机器人预览文档里的 mesh 标记也必须能在同一份依赖闭包里取回。
      const panda = await harness.operations.import({ path: PANDA, resourceId: "preview-panda-route", physicalize: false })
      const preview = await harness.operations.previewMount({ sceneId: "preview-scene", resourceId: panda.resource.ref.resourceId, version: panda.resource.ref.version, token: "t", transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, alignBottomToSurface: false })
      const meshToken = firstToken((preview.entities?.[0]?.components.visual as any)?.robot)
      expect(meshToken).toBeDefined()
      expect((await fetchPreview(harness, { resourceId: panda.resource.ref.resourceId, version: panda.resource.ref.version, uri: meshToken! })).status).toBe(200)
    } finally { await harness.dispose() }
  })
})
