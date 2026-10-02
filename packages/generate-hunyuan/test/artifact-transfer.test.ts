/**
 * 产物转存回归（hunyuan 侧接线）：**产品只落 `{requestId}.json`、字节不落地**时，供应商链接一过期
 * `result.meshURL/thumbnailURL` 就是死链。本用例钉住本轮接线——
 * `runGeneration` 终态落盘**前**调 `transferArtifacts`（共享模块
 * `generate-hunyuan/src/artifact-transfer.ts`），把 mesh/预览各下载一次写进 `dataDirectory`（0600），
 * 并把带 `localPath/bytes/sha256/downloadedAt` 的那一份写进 JobRecord.result。
 *
 * 下载语义本身（超时 / 公网守卫 / 重定向 / 扩展名判定 / 部分失败）已由
 * `packages/generate-tripo/test/artifact-transfer.test.ts` 的 9 个用例覆盖（同一份实现），这里只覆盖
 * **本包的接线**：终态走不走转存口、落盘的是哪一份、失败降级、以及冷重开不再下第二遍。
 *
 * 全部替身（**不发真实请求、不产生任何费用、不做 DNS**）：正式路由 `/v1/me` + 请求行查询走 `fetcher`，
 * 供应商查询 `/v1/ai3d/query` 经同一替身，产物字节走注入的 `artifactFetch`；产物 URL 用公网段 IP
 * 字面量（`203.0.113.7`），既有公网守卫照常执行。
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runGeneration, type TransferredResult } from "../src/operations.ts"

const API = "https://api.test"
const REQUEST_ID = "hunyuan-transfer-1"
const JOB_ID = "job-hunyuan-transfer-1"
const MESH_URL = "https://203.0.113.7/artifacts/hunyuan-model.glb"
const THUMB_URL = "https://203.0.113.7/artifacts/hunyuan-preview.png"
const MESH_BYTES = Buffer.from("glTF-hunyuan-fake-bytes-0123456789")
const THUMB_BYTES = Buffer.from("\x89PNG-hunyuan-fake-preview")
const QUERY_PATH = "/v1/ai3d/query"

/** 轮询：让产品不要真等 5 s（本包 provider 的 `OBJECT_GENERATOR_POLL_INTERVAL_MS`）。 */
const ENV = { OBJECT_GENERATOR_POLL_INTERVAL_MS: "10", OBJECT_GENERATOR_POLL_ATTEMPTS: "2" } as const

function withEnvironment<T>(body: () => Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(ENV).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(ENV)) process.env[key] = value
  return body().finally(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete (process.env as Record<string, string | undefined>)[key]
      else process.env[key] = value
    }
  })
}

function withDirectory<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "hunyuan-transfer-"))
  return body(directory).finally(() => rmSync(directory, { recursive: true, force: true }))
}

/** 供应商终态应答（`ResultFile3Ds` 里一条 glb + 预览，形状照 `provider.selectedFile` 的读取处）。 */
function doneResponse(results: Array<Record<string, unknown>> = [{ Type: "glb", Url: MESH_URL, PreviewImageUrl: THUMB_URL }]) {
  return { Response: { Status: "DONE", JobId: JOB_ID, ResultFile3Ds: results } }
}

type CentralStub = { calls: string[]; fn: typeof fetch }
/** 中央服务（`/v1/me` + 请求行）与供应商查询的确定性替身；产物下载另走 `artifactFetch`。 */
function centralStub(): CentralStub {
  const calls: string[] = []
  const fn = (async (input: any, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`)
    if (url.pathname === "/v1/me") return Response.json({ user: { id: "user-1" } })
    if (url.pathname.startsWith("/v1/generation-requests/"))
      return Response.json({
        requestId: REQUEST_ID,
        serverRequestId: "row-1",
        product: "hunyuan",
        status: "succeeded",
        operationId: JOB_ID,
        model: null,
        requestFingerprint: null,
        estimatedPoints: 1000,
        chargedPoints: 1000,
        error: null,
        response: doneResponse(),
      })
    if (url.pathname === QUERY_PATH) return Response.json(doneResponse())
    return new Response("not found", { status: 404 })
  }) as unknown as typeof fetch
  return { calls, fn }
}

type ArtifactStub = { calls: string[]; fn: typeof fetch }
function artifactStub(handlers: Record<string, () => Response>): ArtifactStub {
  const calls: string[] = []
  const fn = (async (input: any) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    calls.push(url.href)
    const handler = handlers[url.pathname]
    if (!handler) return new Response("not found", { status: 404 })
    return handler()
  }) as unknown as typeof fetch
  return { calls, fn }
}

function okBody(bytes: Buffer, contentType: string) {
  return () => new Response(bytes, { status: 200, headers: { "content-type": contentType } })
}

/** 产品通路：正式路由 + 纯恢复（只给 requestId，不重新提交收费任务）→ 终态 persist → 产物转存。 */
function run(directory: string, central: typeof fetch, artifactFetch: typeof fetch) {
  return runGeneration({ requestId: REQUEST_ID } as never, {
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
  return JSON.parse(readFileSync(join(directory, REQUEST_ID + ".json"), "utf8")) as {
    status: string
    result?: TransferredResult
  }
}

describe("hunyuan 产物转存接线（限时链接 → 本地字节）", () => {
  test("终态转存：mesh/预览四读数齐全、字节与替身逐字一致、落盘 0600，且写进 JobRecord.result", async () => {
    await withDirectory(async (directory) => {
      const central = centralStub()
      const artifacts = artifactStub({
        "/artifacts/hunyuan-model.glb": okBody(MESH_BYTES, "application/octet-stream"),
        "/artifacts/hunyuan-preview.png": okBody(THUMB_BYTES, "image/png"),
      })
      const result = (await withEnvironment(() => run(directory, central.fn, artifacts.fn))) as TransferredResult

      // 中央已有成功结果：直接转存，不重复 submit，也不重查供应商。
      expect(central.calls).toEqual(["GET /v1/me", `GET /v1/generation-requests/hunyuan/${REQUEST_ID}`])
      expect(result.artifactsFetched).toBe(true)
      expect(result.artifactsFetchError).toBeUndefined()
      // 原链接照常保留（转存是增量，不替换供应商读数）。
      expect(result.meshURL).toBe(MESH_URL)
      for (const [kind, bytes, suffix] of [
        ["mesh", MESH_BYTES, ".glb"],
        ["thumbnail", THUMB_BYTES, ".png"],
      ] as const) {
        const artifact = result.artifacts[kind]!
        expect(artifact.localPath.endsWith(`${REQUEST_ID}-${kind}${suffix}`)).toBe(true)
        expect(artifact.bytes).toBe(bytes.length)
        expect(artifact.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
        expect(Number.isFinite(Date.parse(artifact.downloadedAt))).toBe(true)
        expect(readFileSync(artifact.localPath).equals(bytes)).toBe(true)
        expect(statSync(artifact.localPath).mode & 0o777).toBe(0o600)
      }
      // 各下载一次（不多次重试）
      expect(artifacts.calls).toEqual([MESH_URL, THUMB_URL])
      // 终态 JobRecord.result 记的就是带转存读数的这一份：冷重开拿到的是本地路径。
      const record = readRecord(directory)
      expect(record.status).toBe("completed")
      expect(record.result?.artifactsFetched).toBe(true)
      expect(record.result?.artifacts.mesh?.localPath).toBe(result.artifacts.mesh?.localPath)
      expect(record.result?.artifacts.mesh?.sha256).toBe(result.artifacts.mesh?.sha256)
      expect(record.result?.artifacts.thumbnail?.sha256).toBe(result.artifacts.thumbnail?.sha256)
    })
  })

  test("冷重开：completed + result 直接回放，0 次新转存、0 次新查询，本地字节不重下", async () => {
    await withDirectory(async (directory) => {
      const central = centralStub()
      const artifacts = artifactStub({
        "/artifacts/hunyuan-model.glb": okBody(MESH_BYTES, "application/octet-stream"),
        "/artifacts/hunyuan-preview.png": okBody(THUMB_BYTES, "image/png"),
      })
      const first = (await withEnvironment(() => run(directory, central.fn, artifacts.fn))) as TransferredResult
      const callsAfterFirst = [...central.calls]
      const downloadsAfterFirst = [...artifacts.calls]
      expect(first.artifactsFetched).toBe(true)

      const second = (await withEnvironment(() => run(directory, central.fn, artifacts.fn))) as TransferredResult
      // 只有会话校验打了中央；请求行查询与供应商查询都没有再发，产物也没有再下。
      expect(central.calls.slice(callsAfterFirst.length)).toEqual(["GET /v1/me"])
      expect(artifacts.calls).toEqual(downloadsAfterFirst)
      expect(second.artifactsFetched).toBe(true)
      expect(second.artifacts.mesh?.sha256).toBe(first.artifacts.mesh?.sha256)
      expect(readFileSync(second.artifacts.mesh!.localPath).equals(MESH_BYTES)).toBe(true)
    })
  })

  test("转存失败如实降级：artifactsFetched:false + 原因原文，生成任务仍 completed、原链接保留", async () => {
    await withDirectory(async (directory) => {
      const central = centralStub()
      const artifacts = artifactStub({
        "/artifacts/hunyuan-model.glb": () => new Response("backend exploded", { status: 500, statusText: "Internal Server Error" }),
        "/artifacts/hunyuan-preview.png": () => new Response("backend exploded", { status: 500, statusText: "Internal Server Error" }),
      })
      const result = (await withEnvironment(() => run(directory, central.fn, artifacts.fn))) as TransferredResult
      expect(result.artifactsFetched).toBe(false)
      expect(result.artifactsFetchError).toContain("HTTP 500")
      expect(result.artifactsFetchError).toContain("Internal Server Error")
      expect(result.artifacts).toEqual({})
      expect(result.meshURL).toBe(MESH_URL)
      expect(readRecord(directory).status).toBe("completed")
    })
  })
})
