/**
 * 产物转存回归（修复"Tripo 只存 2 小时有效 provider 链接、没有下载转存"）：
 * 终态拿到 `results[]` 后**各下载一次** mesh/预览，写 `dataDirectory`（0600）并在 result 补
 * `artifacts.mesh|thumbnail.{localPath,bytes,sha256,downloadedAt}`；下载失败如实降级
 * `artifactsFetched:false` + `artifactsFetchError`（原因原文），**不让生成任务失败**。
 *
 * 全部用替身 fetch（**不发真实请求、不产生任何费用**）：中央/供应商走 `recovery-identity.test.ts`
 * 同款替身，产物下载走注入的 `artifactFetch`。产物 URL 用公网段 IP 字面量（如 `203.0.113.7`），
 * 既有公网守卫（`generate-hunyuan/src/url-safety.ts`）的判定照常执行且不需要 DNS。
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runGeneration, transferArtifacts, type TransferredResult } from "../src/operations.ts"

const API = "https://api.test"
const MESH_URL = "https://203.0.113.7/artifacts/model.glb"
const THUMB_URL = "https://203.0.113.7/artifacts/preview.webp"
const MESH_BYTES = Buffer.from("glTF-fake-bytes-0123456789")
const THUMB_BYTES = Buffer.from("RIFF-fake-webp-bytes")
const TASK_ID = "task-transfer-1"

function withDirectory(body: (directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "tripo-transfer-"))
  return body(directory).finally(() => rmSync(directory, { recursive: true, force: true }))
}

/** 中央服务（/v1/me、请求行查询）与供应商任务查询的确定性替身；产物下载另走 artifactFetch。 */
function stubCentral(results: Array<Record<string, unknown>> | undefined, resultsField = "results") {
  const row = {
    requestId: "tripo-transfer-1",
    serverRequestId: "row-1",
    product: "tripo",
    status: "succeeded",
    operationId: TASK_ID,
    model: null,
    requestFingerprint: null,
    estimatedPoints: 700,
    chargedPoints: 700,
    error: null,
    response: { output: { task_id: TASK_ID, task_status: "SUCCEEDED", [resultsField]: results } },
  }
  return (async (input: any) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname === "/v1/me") return Response.json({ user: { id: "user-1" } })
    if (url.pathname.startsWith("/v1/generation-requests/")) return Response.json(row)
    if (url.pathname.startsWith("/api/v1/tasks/"))
      return Response.json({ output: { task_id: TASK_ID, task_status: "SUCCEEDED", [resultsField]: results } })
    return new Response("not found", { status: 404 })
  }) as unknown as typeof fetch
}

type ArtifactStub = { calls: string[]; fn: typeof fetch }
function artifactStub(handlers: Record<string, () => Response>): ArtifactStub {
  const calls: string[] = []
  const fn = (async (input: any, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    calls.push(url.href)
    const handler = handlers[url.pathname]
    if (!handler) return new Response("not found", { status: 404 })
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError")
    return handler()
  }) as unknown as typeof fetch
  return { calls, fn }
}

function okBody(bytes: Buffer, contentType: string) {
  return () => new Response(bytes, { status: 200, headers: { "content-type": contentType } })
}

/** 产品通路：正式路由替身 + 纯恢复（只给 requestId）→ 终态 persist → 产物转存。 */
function run(directory: string, central: typeof fetch, artifactFetch: typeof fetch) {
  return runGeneration({ requestId: "tripo-transfer-1" } as never, {
    dataDirectory: directory,
    mode: "formal",
    accountApiUrl: API,
    accountToken: "session-token",
    fetcher: central,
    allowPaidSubmission: false,
    artifactFetch,
  })
}

function readRecord(directory: string) {
  return JSON.parse(readFileSync(join(directory, "tripo-transfer-1.json"), "utf8")) as {
    status: string
    result?: TransferredResult
  }
}

describe("tripo 产物转存（2 小时链接 → 本地字节）", () => {
  test("成功转存：localPath/bytes/sha256/downloadedAt 齐全，字节与替身逐字一致，落盘 0600", async () => {
    await withDirectory(async (directory) => {
      const stub = artifactStub({
        "/artifacts/model.glb": okBody(MESH_BYTES, "application/octet-stream"),
        "/artifacts/preview.webp": okBody(THUMB_BYTES, "image/webp"),
      })
      const result = (await run(directory, stubCentral([{ pbr_model_url: MESH_URL, rendered_image_url: THUMB_URL }]), stub.fn)) as TransferredResult
      expect(result.artifactsFetched).toBe(true)
      expect(result.artifactsFetchError).toBeUndefined()
      // 每件产物各一组，四个读数齐全
      for (const [kind, bytes] of [["mesh", MESH_BYTES], ["thumbnail", THUMB_BYTES]] as const) {
        const artifact = result.artifacts[kind]!
        expect(artifact.localPath).toBeTruthy()
        expect(artifact.bytes).toBe(bytes.length)
        expect(artifact.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
        expect(Number.isFinite(Date.parse(artifact.downloadedAt))).toBe(true)
        // 文件名带 requestId 前缀；字节与替身逐字一致；{mode:0o600} 沿用本包写法
        expect(artifact.localPath.endsWith(`tripo-transfer-1-${kind}` + (kind === "mesh" ? ".glb" : ".webp"))).toBe(true)
        expect(readFileSync(artifact.localPath).equals(bytes)).toBe(true)
        expect(statSync(artifact.localPath).mode & 0o777).toBe(0o600)
      }
      // 各下载一次（不多次重试）
      expect(stub.calls).toEqual([MESH_URL, THUMB_URL])
      // 终态 JobRecord.result 记的就是带转存读数的这份结果（冷重开回放同一份）
      const record = readRecord(directory)
      expect(record.status).toBe("completed")
      expect(record.result?.artifacts.mesh?.sha256).toBe(result.artifacts.mesh?.sha256)
      expect(record.result?.artifacts.thumbnail?.sha256).toBe(result.artifacts.thumbnail?.sha256)
    })
  })

  test("下载 500：artifactsFetched:false + 原因原文，任务结果仍成功（completed + 链接保留）", async () => {
    await withDirectory(async (directory) => {
      const stub = artifactStub({
        "/artifacts/model.glb": () => new Response("backend exploded", { status: 500, statusText: "Internal Server Error" }),
        "/artifacts/preview.webp": () => new Response("backend exploded", { status: 500, statusText: "Internal Server Error" }),
      })
      const result = (await run(directory, stubCentral([{ pbr_model_url: MESH_URL, rendered_image_url: THUMB_URL }]), stub.fn)) as TransferredResult
      // 生成本身成功：不抛错、终态照常 completed、原链接仍在
      expect(result.meshURL).toBe(MESH_URL)
      expect(result.artifactsFetched).toBe(false)
      expect(result.artifactsFetchError).toContain("HTTP 500")
      expect(result.artifactsFetchError).toContain("Internal Server Error")
      expect(result.artifacts).toEqual({})
      expect(readRecord(directory).status).toBe("completed")
    })
  })

  test("下载超时：artifactsFetched:false + 超时原因原文，任务结果仍成功", async () => {
    await withDirectory(async (directory) => {
      const hang = ((input: any, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
        })) as unknown as typeof fetch
      const result = await transferArtifacts(
        { meshURL: MESH_URL, thumbnailURL: THUMB_URL, response: {} },
        { dataDirectory: directory, requestId: "tripo-transfer-1", fetch: hang, timeoutMs: 50 },
      )
      expect(result.artifactsFetched).toBe(false)
      expect(result.artifactsFetchError).toContain("转存下载超时（50 ms 内未完成）")
    })
  })

  test("无产物链接：如实记「没取到任何字节」，不崩", async () => {
    await withDirectory(async (directory) => {
      const stub = artifactStub({})
      const result = await transferArtifacts(
        { meshURL: "", response: {} },
        { dataDirectory: directory, requestId: "tripo-transfer-1", fetch: stub.fn },
      )
      expect(result.artifactsFetched).toBe(false)
      expect(result.artifactsFetchError).toContain("没有可下载的产物链接")
      expect(stub.calls).toEqual([])
    })
  })

  test("只有 mesh 链接（如 texture:false 时无预览）：mesh 转存成功，thumbnail 组如实缺席", async () => {
    await withDirectory(async (directory) => {
      const stub = artifactStub({ "/artifacts/model.glb": okBody(MESH_BYTES, "application/octet-stream") })
      const result = await transferArtifacts(
        { meshURL: MESH_URL, response: {} },
        { dataDirectory: directory, requestId: "tripo-transfer-1", fetch: stub.fn },
      )
      expect(result.artifactsFetched).toBe(true)
      expect(result.artifacts.mesh?.bytes).toBe(MESH_BYTES.length)
      expect(result.artifacts.thumbnail).toBeUndefined()
    })
  })

  test("部分失败：成功的组保留，整体如实降级并点名失败那件", async () => {
    await withDirectory(async (directory) => {
      const stub = artifactStub({
        "/artifacts/model.glb": okBody(MESH_BYTES, "application/octet-stream"),
        "/artifacts/preview.webp": () => new Response("gone", { status: 404, statusText: "Not Found" }),
      })
      const result = await transferArtifacts(
        { meshURL: MESH_URL, thumbnailURL: THUMB_URL, response: {} },
        { dataDirectory: directory, requestId: "tripo-transfer-1", fetch: stub.fn },
      )
      expect(result.artifactsFetched).toBe(false)
      expect(result.artifactsFetchError).toContain("thumbnail")
      expect(result.artifactsFetchError).toContain("HTTP 404")
      expect(result.artifacts.mesh?.bytes).toBe(MESH_BYTES.length)
      expect(result.artifacts.thumbnail).toBeUndefined()
    })
  })

  test("下载走既有公网守卫：非 https / 私网地址在下载前拒绝（原因原文），一次 fetch 都不发", async () => {
    await withDirectory(async (directory) => {
      const stub = artifactStub({})
      for (const [url, expected] of [
        ["http://203.0.113.7/artifacts/model.glb", "must use https"],
        ["https://127.0.0.1/artifacts/model.glb", "must not target a private address"],
      ] as const) {
        const result = await transferArtifacts(
          { meshURL: url, response: {} },
          { dataDirectory: directory, requestId: "tripo-transfer-1", fetch: stub.fn },
        )
        expect(result.artifactsFetched).toBe(false)
        expect(result.artifactsFetchError).toContain(expected)
      }
      expect(stub.calls).toEqual([])
    })
  })

  test("扩展名判定：content-type 优先，octet-stream 回落 URL 后缀", async () => {
    await withDirectory(async (directory) => {
      const glbURL = "https://203.0.113.7/artifacts/preview.png"
      const stub = artifactStub({ "/artifacts/preview.png": okBody(THUMB_BYTES, "image/webp") })
      const result = await transferArtifacts(
        { meshURL: glbURL, response: {} },
        { dataDirectory: directory, requestId: "tripo-transfer-1", fetch: stub.fn },
      )
      // URL 路径是 .png，但 content-type 是 image/webp ⇒ 以 content-type 为准
      expect(result.artifacts.mesh?.localPath.endsWith("tripo-transfer-1-mesh.webp")).toBe(true)
    })
  })

  test("重定向逐跳过守卫：跳到私网地址即拒绝（不跟随）", async () => {
    await withDirectory(async (directory) => {
      const stub = artifactStub({
        "/artifacts/model.glb": () =>
          new Response(null, { status: 302, headers: { location: "https://127.0.0.1/artifacts/steal.glb" } }),
        "/artifacts/steal.glb": okBody(MESH_BYTES, "application/octet-stream"),
      })
      const result = await transferArtifacts(
        { meshURL: MESH_URL, response: {} },
        { dataDirectory: directory, requestId: "tripo-transfer-1", fetch: stub.fn },
      )
      expect(result.artifactsFetched).toBe(false)
      expect(result.artifactsFetchError).toContain("must not target a private address")
      expect(stub.calls).toEqual([MESH_URL])
    })
  })
})
