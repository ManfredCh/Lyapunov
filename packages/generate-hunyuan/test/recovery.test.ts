import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runGeneration, type GenerationOptions, type JobRecord } from "../src/operations.ts"

const API = "https://api.test"
const REQUEST_ID = "recovery-1"
const JOB_ID = "original-job"
const LOOKUP = `/v1/generation-requests/hunyuan/${REQUEST_ID}`
const QUERY = "/v1/ai3d/query"
const SUBMIT = "/v1/ai3d/submit"
const MESH_URL = "https://203.0.113.7/model.glb"
const done = { Response: { JobId: JOB_ID, Status: "DONE", ResultFile3Ds: [{ Type: "GLB", Url: MESH_URL }] } }
const input = { requestId: REQUEST_ID, input: { mode: "text-to-3d" as const, prompt: "a box", referenceImageUri: "" } }

function row(overrides: Record<string, unknown> = {}) {
  return { requestId: REQUEST_ID, product: "hunyuan", serverRequestId: "row-1", status: "running",
    operationId: JOB_ID, response: null, ...overrides }
}

function local(overrides: Record<string, unknown> = {}) {
  return { status: "interrupted", mode: "formal", accountId: "user-1", apiUrl: API,
    updatedAt: "2026-01-01T00:00:00.000Z", ...overrides }
}

function withDirectory(body: (directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "hunyuan-recovery-"))
  return body(directory).finally(() => rmSync(directory, { recursive: true, force: true }))
}

function seed(directory: string, value: unknown) {
  writeFileSync(join(directory, REQUEST_ID + ".json"), JSON.stringify(value))
}

function readRecord(directory: string): JobRecord {
  return JSON.parse(readFileSync(join(directory, REQUEST_ID + ".json"), "utf8"))
}

function stub(handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  const calls: string[] = []
  const bodies: unknown[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`)
    if (init?.body) bodies.push(JSON.parse(String(init.body)))
    if (url.pathname === "/v1/me") return Response.json({ user: { id: "user-1" } })
    const handler = handlers[url.pathname]
    if (!handler) throw new Error(`UNEXPECTED_REQUEST: ${url.pathname}`)
    return handler(init)
  }) as typeof fetch
  return { fetcher, calls, bodies }
}

const missing = () => Response.json({ error: "generation_request_not_found" }, { status: 404 })
const artifactFetch = (async () => new Response("mock-glb-bytes")) as unknown as typeof fetch
function options(directory: string, fetcher: typeof fetch, extra: Partial<GenerationOptions> = {}): GenerationOptions {
  return { dataDirectory: directory, mode: "formal", accountApiUrl: API, accountToken: "test-token",
    fetcher, artifactFetch, ...extra }
}

// Every HTTP boundary is injected; public IP literals avoid DNS during artifact validation.
describe("hunyuan same-request recovery", () => {
  test("an invalid explicit resume ID never falls through to a paid submission", async () => {
    await withDirectory(async directory => {
      const central = stub({ [LOOKUP]: missing })
      for (const resumeJobId of ["", "   ", null, 12]) {
        await expect(runGeneration({ ...input, resumeJobId } as never, options(directory, central.fetcher, { allowPaidSubmission: true })))
          .rejects.toThrow("INVALID_RESUME_JOB_ID")
      }
      expect(central.calls).toEqual([])
    })
  })

  test("an invalid central lookup cannot fall through to a paid submission", async () => {
    await withDirectory(async directory => {
      const central = stub({ [LOOKUP]: () => Response.json(null) })
      await expect(runGeneration(input, options(directory, central.fetcher, { allowPaidSubmission: true })))
        .rejects.toThrow("CENTRAL_GENERATION_LOOKUP_INVALID")
      expect(central.calls).toEqual(["GET /v1/me", `GET ${LOOKUP}`])
    })
  })

  test("a lost submit response is looked up on restart and never submitted twice", async () => {
    await withDirectory(async directory => {
      let accepted = false
      const central = stub({
        [LOOKUP]: () => accepted ? Response.json(row()) : missing(),
        "/v1/generation-quotes/hunyuan": () => Response.json({ product: "hunyuan", accountId: "user-1",
          quoteId: "a".repeat(64), points: 100, unit: "points", pricing: "configured-fixed", reservationCreated: false }),
        [SUBMIT]: () => { accepted = true; throw new Error("connection lost after acceptance") },
        [QUERY]: () => Response.json(done),
      })
      await expect(runGeneration(input, options(directory, central.fetcher, { allowPaidSubmission: true })))
        .rejects.toThrow("connection lost after acceptance")
      expect(readRecord(directory).status).toBe("interrupted")
      expect(readRecord(directory).operationId).toBeUndefined()
      const result = await runGeneration(input, options(directory, central.fetcher))
      expect(result).toMatchObject({ meshURL: MESH_URL, artifactsFetched: true })
      expect(central.calls.filter(call => call === `POST ${SUBMIT}`)).toHaveLength(1)
      expect(central.calls.slice(-3)).toEqual(["GET /v1/me", `GET ${LOOKUP}`, `POST ${QUERY}`])
      expect(central.bodies.at(-1)).toEqual({ JobId: JOB_ID })
    })
  })

  test("missing central row cannot authorize replay of any existing local record", async () => {
    for (const status of ["submitting", "resuming", "running", "cancelled-local", "interrupted", "legacy-unknown"]) {
      await withDirectory(async directory => {
        seed(directory, local({ status }))
        const central = stub({ [LOOKUP]: missing })
        await expect(runGeneration(input, options(directory, central.fetcher, { allowPaidSubmission: true })))
          .rejects.toThrow("SUBMISSION_UNCERTAIN")
        expect(central.calls).toEqual(["GET /v1/me", `GET ${LOOKUP}`])
        expect(readRecord(directory).status).toBe(status)
      })
    }
  })

  test("corrupt local records fail closed instead of becoming a fresh request", async () => {
    for (const value of [null, false, [], {}, local({ operationId: "" }), local({ operationId: 7 })]) {
      await withDirectory(async directory => {
        seed(directory, value)
        const central = stub({ [LOOKUP]: missing })
        await expect(runGeneration(input, options(directory, central.fetcher, { allowPaidSubmission: true })))
          .rejects.toThrow("GENERATION_RECORD_INVALID")
        expect(central.calls).toEqual(["GET /v1/me"])
      })
    }
  })

  test("central success repairs an uncertain local record even without a job ID", async () => {
    await withDirectory(async directory => {
      seed(directory, local())
      const central = stub({ [LOOKUP]: () => Response.json(row({ status: "succeeded", operationId: null, response: done })) })
      await expect(runGeneration(input, options(directory, central.fetcher))).resolves.toMatchObject({ meshURL: MESH_URL })
      expect(central.calls).toEqual(["GET /v1/me", `GET ${LOOKUP}`])
      expect(readRecord(directory).status).toBe("completed")
    })
  })

  test("central success with a job ID reuses saved results without querying an expired job", async () => {
    await withDirectory(async directory => {
      const central = stub({ [LOOKUP]: () => Response.json(row({ status: "succeeded", response: done })) })
      await expect(runGeneration(input, options(directory, central.fetcher))).resolves.toMatchObject({ meshURL: MESH_URL })
      expect(central.calls).toEqual(["GET /v1/me", `GET ${LOOKUP}`])
      expect(readRecord(directory).operationId).toBe(JOB_ID)
    })
  })

  test("central success without saved results queries only the known job", async () => {
    await withDirectory(async directory => {
      const central = stub({ [LOOKUP]: () => Response.json(row({ status: "succeeded" })), [QUERY]: () => Response.json(done) })
      await runGeneration(input, options(directory, central.fetcher))
      expect(central.calls).toEqual(["GET /v1/me", `GET ${LOOKUP}`, `POST ${QUERY}`])
      expect(central.bodies).toEqual([{ JobId: JOB_ID }])
    })
  })

  test("local job ID survives a missing central row and is queried without authorization", async () => {
    await withDirectory(async directory => {
      seed(directory, local({ operationId: JOB_ID }))
      const central = stub({ [LOOKUP]: missing, [QUERY]: () => Response.json(done) })
      await runGeneration(input, options(directory, central.fetcher))
      expect(central.calls).toEqual(["GET /v1/me", `GET ${LOOKUP}`, `POST ${QUERY}`])
      expect(central.bodies).toEqual([{ JobId: JOB_ID }])
    })
  })

  test("local stop reports unknown remote cancellation and resumes the original job", async () => {
    await withDirectory(async directory => {
      const controller = new AbortController()
      const central = stub({
        [LOOKUP]: () => Response.json(row()),
        [QUERY]: () => { controller.abort(); throw new DOMException("aborted", "AbortError") },
      })
      await expect(runGeneration(input, options(directory, central.fetcher, { signal: controller.signal })))
        .rejects.toThrow("本地取消")
      expect(readRecord(directory)).toMatchObject({ status: "cancelled-local", operationId: JOB_ID,
        cancellation: { scope: "local", remoteStopRequested: false, remoteMayStillRun: true, submissionConfirmed: true, operationId: JOB_ID } })
      const resumed = stub({ [LOOKUP]: () => Response.json(row()), [QUERY]: () => Response.json(done) })
      await runGeneration(input, options(directory, resumed.fetcher))
      expect(resumed.calls).toEqual(["GET /v1/me", `GET ${LOOKUP}`, `POST ${QUERY}`])
      expect(readRecord(directory)).toMatchObject({ status: "completed", cancellation: null, operationId: JOB_ID })
    })
  })

  test("stop during submission preserves uncertainty and never retries after a missing lookup", async () => {
    await withDirectory(async directory => {
      const controller = new AbortController()
      const central = stub({
        [LOOKUP]: missing,
        "/v1/generation-quotes/hunyuan": () => Response.json({ product: "hunyuan", accountId: "user-1",
          quoteId: "a".repeat(64), points: 100, unit: "points", pricing: "configured-fixed", reservationCreated: false }),
        [SUBMIT]: () => { controller.abort(); throw new DOMException("aborted", "AbortError") },
      })
      await expect(runGeneration(input, options(directory, central.fetcher, { signal: controller.signal, allowPaidSubmission: true })))
        .rejects.toThrow("提交结果未确认")
      expect(readRecord(directory)).toMatchObject({ status: "cancelled-local",
        cancellation: { scope: "local", remoteStopRequested: false, remoteMayStillRun: true, submissionConfirmed: false } })
      await expect(runGeneration(input, options(directory, central.fetcher, { allowPaidSubmission: true })))
        .rejects.toThrow("SUBMISSION_UNCERTAIN")
      expect(central.calls.filter(call => call === `POST ${SUBMIT}`)).toHaveLength(1)
    })
  })
})
