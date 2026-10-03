/**
 * 产物转存回归（marble 侧接线）：世界产物的链接（主产物 `.spz`、场景网格 `.glb`、缩略图、全景）
 * 都是**限时外部链接**，而本包此前只把链接写进 `{requestId}.json` → 链接过期即死链，收件链
 * （`scene_import` 拿 URL 收件）就再也取不到字节。本用例钉住本轮接线——
 * `runGeneration` 终态落盘**前**调共享模块的 `transferWorldArtifacts`
 * （`generate-hunyuan/src/artifact-transfer.ts`），四件各下载一次写进 `dataDirectory`（0600），
 * 并把带 `localPath/bytes/sha256/downloadedAt` 的那一份写进 JobRecord.result。
 *
 * 两个本包特有的口径**有意**在这里钉住：
 *  ① `worldURL`（供应商在线查看页）**不转存** —— 它是页面，不是产物字节；
 *  ② 本包**不传 `allowPrivate`** —— marble 不读 `OBJECT_GENERATOR_*`（见 `test/env-forwarding.test.ts`），
 *     缺省 `false`（禁私网/localhost）就是本包要的语义，也没有新增环境键。
 *
 * 下载语义本身（超时 / 重定向 / 公网守卫 / 扩展名判定优先级）由共享实现的既有用例覆盖；这里只覆盖接线。
 * 全部替身：**不发真实请求、不产生任何费用、不做 DNS**（产物 URL 用公网段 IP 字面量 `203.0.113.7`）。
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runGeneration, type TransferredResult } from "../src/operations.ts"
import type { WorldAsset } from "../src/provider.ts"

const API = "https://api.test"
const REQUEST_ID = "marble-transfer-1"
const OPERATION_ID = "990000000000000123"
const SPZ_URL = "https://203.0.113.7/artifacts/world.spz"
const MESH_URL = "https://203.0.113.7/artifacts/world-collider.glb"
const THUMB_URL = "https://203.0.113.7/artifacts/world-thumb.png"
const PANO_URL = "https://203.0.113.7/artifacts/world-pano.jpg"
/** 供应商的**在线查看页**：本轮有意不下载（断言里点名它一次 fetch 都没发）。 */
const WORLD_PAGE_URL = "https://203.0.113.7/view/world-1"
const SPZ_BYTES = Buffer.from("NGSP-fake-splat-bytes-0123456789")
const MESH_BYTES = Buffer.from("glTF-fake-collider-bytes")
const THUMB_BYTES = Buffer.from("\x89PNG-fake-thumb")
const PANO_BYTES = Buffer.from("\xff\xd8\xff\xe0fake-jpeg-pano")

/** 本包的终态结果 = 世界产物 + 转存读数。 */
type WorldResult = TransferredResult<WorldAsset>

const ENV = { WORLDLABS_POLL_INTERVAL_MS: "10", WORLDLABS_POLL_ATTEMPTS: "2" } as const

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
  const directory = mkdtempSync(join(tmpdir(), "marble-transfer-"))
  return body(directory).finally(() => rmSync(directory, { recursive: true, force: true }))
}

/** 供应商 world 形状（照 `provider.extractWorldAsset` 的读取处）：四件产物齐 + 一个查看页链接。 */
function worldResponse() {
  return {
    id: "world-1",
    model: "marble-1.1",
    assets: {
      splats: { spz_urls: { "500k": SPZ_URL } },
      mesh: { collider_mesh_url: MESH_URL },
      thumbnail_url: THUMB_URL,
      imagery: { pano_url: PANO_URL },
      caption: "marble transfer test world",
    },
    world_marble_url: WORLD_PAGE_URL,
  }
}

type CentralStub = { calls: string[]; fn: typeof fetch }
/** 中央服务（`/v1/me`、请求行）与供应商状态查询的替身；产物下载另走 `artifactFetch`。 */
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
        product: "marble",
        status: "succeeded",
        operationId: OPERATION_ID,
        model: "marble-1.1",
        requestFingerprint: null,
        estimatedPoints: 2000,
        chargedPoints: 2000,
        error: null,
        response: worldResponse(),
      })
    if (/\/marble\/v1\/operations\/[^/]+$/.test(url.pathname))
      return Response.json({ operation_id: OPERATION_ID, status: "COMPLETED", response: worldResponse() })
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

/** 四件产物都能取到时的替身（`spz` 用 octet-stream 逼出"URL 后缀"这条判据）。 */
function fullArtifacts() {
  return artifactStub({
    "/artifacts/world.spz": okBody(SPZ_BYTES, "application/octet-stream"),
    "/artifacts/world-collider.glb": okBody(MESH_BYTES, "model/gltf-binary"),
    "/artifacts/world-thumb.png": okBody(THUMB_BYTES, "image/png"),
    "/artifacts/world-pano.jpg": okBody(PANO_BYTES, "image/jpeg"),
  })
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
    result?: WorldResult
  }
}

describe("marble 产物转存接线（限时链接 → 本地字节）", () => {
  test("终态转存四件：spz/mesh/thumbnail/pano 四读数齐全、落盘 0600，worldURL 一次都不下", async () => {
    await withDirectory(async (directory) => {
      const central = centralStub()
      const artifacts = fullArtifacts()
      const result = (await withEnvironment(() => run(directory, central.fn, artifacts.fn))) as WorldResult

      // 只查询既有作业（没有第二次 submit）；中央只有会话校验 + 请求行两跳。
      // 状态查询的中央落点带 `/v1` 前缀（`formalGenerationRoute` 对 marble 的映射：`apiUrl + "/v1" + "/marble/v1/operations/…"`）
      // —— 这是**既有**路由形状，本用例只是如实记录它。
      expect(central.calls).toEqual([
        "GET /v1/me",
        `GET /v1/generation-requests/marble/${REQUEST_ID}`,
        `GET /v1/marble/v1/operations/${OPERATION_ID}`,
      ])
      expect(result.artifactsFetched).toBe(true)
      expect(result.artifactsFetchError).toBeUndefined()
      // 原链接照常保留（转存是增量）。
      expect(result.spzURL).toBe(SPZ_URL)
      expect(result.worldURL).toBe(WORLD_PAGE_URL)
      for (const [kind, bytes, suffix] of [
        ["spz", SPZ_BYTES, ".spz"],
        ["mesh", MESH_BYTES, ".glb"],
        ["thumbnail", THUMB_BYTES, ".png"],
        ["pano", PANO_BYTES, ".jpg"],
      ] as const) {
        const artifact = result.artifacts[kind]!
        expect(artifact.localPath.endsWith(`${REQUEST_ID}-${kind}${suffix}`)).toBe(true)
        expect(artifact.bytes).toBe(bytes.length)
        expect(artifact.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
        expect(Number.isFinite(Date.parse(artifact.downloadedAt))).toBe(true)
        expect(readFileSync(artifact.localPath).equals(bytes)).toBe(true)
        expect(statSync(artifact.localPath).mode & 0o777).toBe(0o600)
      }
      // 各下载一次，且**只**下这四件：worldURL（查看页）不在其中。
      expect(artifacts.calls).toEqual([SPZ_URL, MESH_URL, THUMB_URL, PANO_URL])
      expect(artifacts.calls).not.toContain(WORLD_PAGE_URL)
      // 终态 JobRecord.result 记的就是带转存读数的这一份（主产物 spz 也在里面）。
      const record = readRecord(directory)
      expect(record.status).toBe("completed")
      expect(record.result?.artifactsFetched).toBe(true)
      expect(record.result?.artifacts.spz?.localPath).toBe(result.artifacts.spz?.localPath)
      expect(record.result?.artifacts.pano?.sha256).toBe(result.artifacts.pano?.sha256)
    })
  })

  test("主产物链接已过期（403）：降级 false 并点名 spz，其余三件照常落盘，任务仍 completed", async () => {
    await withDirectory(async (directory) => {
      const central = centralStub()
      const artifacts = artifactStub({
        "/artifacts/world.spz": () => new Response("signature expired", { status: 403, statusText: "Forbidden" }),
        "/artifacts/world-collider.glb": okBody(MESH_BYTES, "model/gltf-binary"),
        "/artifacts/world-thumb.png": okBody(THUMB_BYTES, "image/png"),
        "/artifacts/world-pano.jpg": okBody(PANO_BYTES, "image/jpeg"),
      })
      const result = (await withEnvironment(() => run(directory, central.fn, artifacts.fn))) as WorldResult
      // 没取全 = 如实 false；失败的只有 spz，另外三件的字节仍然留在盘上。
      expect(result.artifactsFetched).toBe(false)
      expect(result.artifactsFetchError).toContain("spz")
      expect(result.artifactsFetchError).toContain("HTTP 403")
      expect(result.artifacts.spz).toBeUndefined()
      expect(readFileSync(result.artifacts.mesh!.localPath).equals(MESH_BYTES)).toBe(true)
      expect(readFileSync(result.artifacts.thumbnail!.localPath).equals(THUMB_BYTES)).toBe(true)
      expect(readFileSync(result.artifacts.pano!.localPath).equals(PANO_BYTES)).toBe(true)
      // 生成本身没失败：记录仍是 completed（原链接也保留，可供人工重试）。
      expect(readRecord(directory).status).toBe("completed")
      expect(result.spzURL).toBe(SPZ_URL)
    })
  })

  test("冷重开：completed + result 直接回放，0 次新转存、0 次新查询，本地字节不重下", async () => {
    await withDirectory(async (directory) => {
      const central = centralStub()
      const artifacts = fullArtifacts()
      const first = (await withEnvironment(() => run(directory, central.fn, artifacts.fn))) as WorldResult
      const callsAfterFirst = [...central.calls]
      const downloadsAfterFirst = [...artifacts.calls]
      expect(first.artifactsFetched).toBe(true)

      const second = (await withEnvironment(() => run(directory, central.fn, artifacts.fn))) as WorldResult
      expect(central.calls.slice(callsAfterFirst.length)).toEqual(["GET /v1/me"])
      expect(artifacts.calls).toEqual(downloadsAfterFirst)
      expect(second.artifacts.spz?.sha256).toBe(first.artifacts.spz?.sha256)
      expect(readFileSync(second.artifacts.spz!.localPath).equals(SPZ_BYTES)).toBe(true)
    })
  })
})
