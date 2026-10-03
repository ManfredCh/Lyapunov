/**
 * 包内回归：`runGeneration` 的**作业记录状态机**（本包此前只有环境搬运用例，这条路径零覆盖）。
 *
 * 用替身 fetch 驱动真实 `runGeneration`（真状态机、真 JobRecord 落盘、真共享记录写入器
 * `generate-hunyuan/src/job-record.ts`）：**不发真实请求、不产生任何费用**。
 * 三个场景正好覆盖三次不同的落盘：提交前（submitting）→ 拿到 operationId（submitted/running）
 * → 失败终态（interrupted，必须保留作业ID，否则冷重开会变成第二次收费提交）。
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runGeneration } from "../src/operations.ts"

const API = "https://marble.test"
const REQUEST_ID = "marble-record-1"
const OPERATION_ID = "990000000000000009"
const PERSISTED_WORLD = { spzURL: "https://cdn.example.test/world.spz", operationID: OPERATION_ID }

const ENV = {
  WORLDLABS_API_KEY: "marble-record-test-key",
  WORLDLABS_API_BASE_URL: API,
  WORLDLABS_POLL_ATTEMPTS: "1",
  WORLDLABS_POLL_INTERVAL_MS: "10",
} as const

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
  const directory = mkdtempSync(join(tmpdir(), "marble-record-"))
  return body(directory).finally(() => rmSync(directory, { recursive: true, force: true }))
}

/** 任何一次真实 HTTP 尝试都抛这个哨兵：用例据此断言"没有联网"，也证明走到哪一步。 */
function withSentinelFetch<T>(attempts: string[], body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    attempts.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    throw new Error("MARBLE_RECORD_TEST_NO_NETWORK")
  }) as unknown as typeof fetch
  return body().finally(() => {
    globalThis.fetch = original
  })
}

/** 供应商替身：提交回 operation_id，状态查询永远"还在跑"（本机确定性应答，不联网）。 */
function withProviderStub<T>(attempts: string[], body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    attempts.push(`${init?.method ?? "GET"} ${url.pathname}`)
    if (url.pathname.endsWith("/worlds:generate")) return Response.json({ operation_id: OPERATION_ID })
    if (url.pathname.startsWith("/marble/v1/operations/")) return Response.json({ status: "PROCESSING" })
    return new Response("not found", { status: 404 })
  }) as unknown as typeof fetch
  return body().finally(() => {
    globalThis.fetch = original
  })
}

function run(directory: string, options: Record<string, unknown> = {}) {
  return runGeneration({ requestId: REQUEST_ID, prompt: "marble record test" }, { dataDirectory: directory, ...options })
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("期望抛错，但调用成功返回了")
}

function readRecord(directory: string) {
  return JSON.parse(readFileSync(join(directory, REQUEST_ID + ".json"), "utf8")) as Record<string, any>
}

function modeOf(path: string) {
  return (statSync(path).mode & 0o777).toString(8)
}

function tempResidue(directory: string) {
  return readdirSync(directory).filter((name) => name.endsWith(".tmp"))
}

describe("marble 作业记录状态机", () => {
  test("提交拿到 operationId 后落盘，轮询超时落 interrupted 且保留作业ID（冷重开不会二次提交）", async () => {
    await withDirectory(async (directory) => {
      const attempts: string[] = []
      const message = await rejection(
        withEnvironment(() =>
          withProviderStub(attempts, () => run(directory, { allowPaidSubmission: true })),
        ),
      )
      const record = readRecord(directory)
      // 真实提交了一次、只查询既有作业（没有第二次 submit）；作业ID落在记录里。
      expect(attempts).toEqual([
        `POST /marble/v1/worlds:generate`,
        `GET /marble/v1/operations/${OPERATION_ID}`,
      ])
      expect(record.operationId).toBe(OPERATION_ID)
      expect(record.status).toBe("interrupted")
      expect(typeof record.error).toBe("string")
      expect((record.error as string).length).toBeGreaterThan(0)
      expect(message.length).toBeGreaterThan(0)
      // 落盘走共享写入器：0600、JSON 缩进形状、没有临时文件残留。
      const path = join(directory, REQUEST_ID + ".json")
      expect(modeOf(path)).toBe("600")
      expect(readFileSync(path, "utf8")).toBe(JSON.stringify(record, null, 2))
      expect(tempResidue(directory)).toEqual([])
    })
  })

  test("本地取消：落 cancelled-local + 取消报告，且一次 HTTP 都没有发出", async () => {
    await withDirectory(async (directory) => {
      const attempts: string[] = []
      const controller = new AbortController()
      controller.abort()
      const message = await rejection(
        withEnvironment(() =>
          withSentinelFetch(attempts, () =>
            run(directory, { allowPaidSubmission: true, signal: controller.signal }),
          ),
        ),
      )
      const record = readRecord(directory)
      expect(attempts).toEqual([])
      expect(message).toMatch(/本地取消/)
      expect(record.status).toBe("cancelled-local")
      expect(record.mode).toBe("developer")
      expect(record.operationId).toBeUndefined()
      // 提交结果未确认：报告不能声称远端已停止。
      expect(record.cancellation).toMatchObject({
        scope: "local",
        remoteStopRequested: false,
        remoteMayStillRun: true,
        submissionConfirmed: false,
      })
      expect(tempResidue(directory)).toEqual([])
    })
  })

  test("冷重开：completed + result 直接复用，0 次 HTTP，记录逐字节不变", async () => {
    await withDirectory(async (directory) => {
      writeFileSync(
        join(directory, REQUEST_ID + ".json"),
        JSON.stringify(
          {
            mode: "developer",
            status: "completed",
            result: PERSISTED_WORLD,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          null,
          2,
        ),
        { mode: 0o600 },
      )
      const before = readFileSync(join(directory, REQUEST_ID + ".json"), "utf8")
      const attempts: string[] = []
      const result = (await withEnvironment(() =>
        withSentinelFetch(attempts, () => run(directory)),
      )) as { spzURL?: string }
      expect(result.spzURL).toBe(PERSISTED_WORLD.spzURL)
      expect(attempts).toEqual([])
      expect(readFileSync(join(directory, REQUEST_ID + ".json"), "utf8")).toBe(before)
    })
  })
})
