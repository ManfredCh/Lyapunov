/**
 * 包内回归：`runGeneration` 的 requestId 输入身份（冷重开重放 / 纯恢复）。
 *
 * 用替身 fetcher 驱动真实 `runGeneration`（真状态机、真 JobRecord 落盘、真共享中央客户端），
 * 供应商与中央服务都是本地确定性应答：**不发真实请求、不产生任何费用**。
 * 身份判据与 `packages/generate-image/src/operations.ts` 同口径（本地记录输入指纹 + 服务端请求体指纹）。
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runGeneration } from "../src/operations.ts"
import { preflightGeneration } from "../src/provider.ts"

const API = "https://api.test"
const OLD_MESH = "https://cdn.example.test/old.glb"
const OLD_REQUEST_ID = "tripo-identity-1"
const OLD_INPUT = { input: { mode: "text-to-3d" as const, prompt: "上一次那次请求的提示词" } }
const NEW_INPUT = { input: { mode: "text-to-3d" as const, prompt: "完全不同的新提示词" } }

/** 与中央 `generation-gateway.fingerprint()` 同一口径，独立重算一遍，避免拿实现自己的函数自证。 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}

function payloadFingerprint(payload: Record<string, unknown>) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(JSON.parse(JSON.stringify(payload)))))
    .digest("hex")
}

/** 服务端保存的指纹 = 那次真正提交的请求体（provider `callAPI` 发出去的就是 `JSON.stringify(request)`）。 */
async function fingerprintOf(input: Record<string, unknown>) {
  const prepared = await preflightGeneration(input as never, { apiKey: "test-key", baseURL: API })
  return payloadFingerprint(prepared.request as Record<string, unknown>)
}

function serverRow(overrides: Record<string, unknown> = {}) {
  return {
    requestId: OLD_REQUEST_ID,
    serverRequestId: "row-1",
    product: "tripo",
    status: "succeeded",
    operationId: null,
    model: null,
    requestFingerprint: "a".repeat(64),
    estimatedPoints: 700,
    chargedPoints: 700,
    error: null,
    response: {
      output: { task_id: "task-old", task_status: "SUCCEEDED", results: [{ pbr_model_url: OLD_MESH }] },
    },
    ...overrides,
  }
}

/** 中央服务（/v1/me、请求行查询）与供应商（任务查询）的确定性替身。 */
function stubFetch(row: Record<string, unknown> | undefined) {
  const calls: string[] = []
  const fn = (async (input: any, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`)
    if (url.pathname === "/v1/me") return Response.json({ user: { id: "user-1" } })
    if (url.pathname.startsWith("/v1/generation-requests/"))
      return row ? Response.json(row) : Response.json({ error: "generation_request_not_found" }, { status: 404 })
    if (url.pathname.startsWith("/api/v1/tasks/"))
      return Response.json({
        output: { task_id: "task-old", task_status: "SUCCEEDED", results: [{ pbr_model_url: OLD_MESH }] },
      })
    return new Response("not found", { status: 404 })
  }) as unknown as typeof fetch
  return { calls, fn }
}

function withDirectory(body: (directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "tripo-identity-"))
  return body(directory).finally(() => rmSync(directory, { recursive: true, force: true }))
}

function run(input: Record<string, unknown>, directory: string, fetcher: typeof fetch) {
  return runGeneration(input as never, {
    dataDirectory: directory,
    mode: "formal",
    accountApiUrl: API,
    accountToken: "session-token",
    fetcher,
    allowPaidSubmission: false,
    artifactFetch: (async()=>new Response('fixture-model-bytes',{headers:{'content-type':'model/gltf-binary'}})) as unknown as typeof fetch,
  })
}

function readRecord(directory: string) {
  return JSON.parse(readFileSync(join(directory, OLD_REQUEST_ID + ".json"), "utf8")) as Record<string, unknown>
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("期望抛错，但调用成功返回了")
}

describe("tripo requestId 输入身份", () => {
  test("真实生成入口缺配置或正价：报价一次后停止，不确认、不提交、不写任务记录", async () => {
    await withDirectory(async directory=>{
      const calls:string[]=[]
      let confirmations=0
      const fetcher=(async(url:string|URL|Request,init?:RequestInit)=>{
        const path=new URL(typeof url==='string'?url:url instanceof URL?url.href:url.url).pathname
        calls.push(`${init?.method??'GET'} ${path}`)
        if(path==='/v1/me')return Response.json({user:{id:'user-1'}})
        if(path.includes('/generation-requests/'))return Response.json({error:'generation_request_not_found'},{status:404})
        if(path==='/v1/generation-quotes/tripo')return Response.json({error:'unavailable',message:'tripo generation is not configured'},{status:503})
        throw new Error('不允许生成提交或其他请求')
      }) as typeof fetch
      const message=await rejection(runGeneration({requestId:OLD_REQUEST_ID,...OLD_INPUT,pbr:true,texture:true} as never,{dataDirectory:directory,mode:'formal',accountApiUrl:API,accountToken:'session-token',fetcher,authorizeSubmission:async()=>{confirmations++}}))
      expect(message).toContain('Pontryagin 3D')
      expect(message).toContain('正积分报价未就绪')
      expect(confirmations).toBe(0)
      expect(calls.filter(call=>call.includes('/generation-quotes/'))).toHaveLength(1)
      expect(calls.some(call=>call.startsWith('POST'))).toBe(false)
      expect(()=>readRecord(directory)).toThrow()
    })
  })

  test("新产物显式 PBR/纹理字段实际传入请求体，false 不会被默认值吞掉", async () => {
    for (const flags of [{pbr:true,texture:true},{pbr:false,texture:false}]) {
      const prepared=await preflightGeneration({...OLD_INPUT,...flags} as never,{apiKey:'test-key',baseURL:API})
      expect(prepared.request).toMatchObject({parameters:flags})
    }
    for (const broken of [{pbr:'true'},{texture:1}])
      await expect(preflightGeneration({...OLD_INPUT,...broken} as never,{apiKey:'test-key',baseURL:API})).rejects.toThrow('必须是布尔值')
  })

  test("更改旧请求的材质要求必须冲突，不能回放旧白模", async () => {
    await withDirectory(async directory=>{
      const original=stubFetch(serverRow({requestFingerprint:await fingerprintOf(OLD_INPUT)}))
      await run({requestId:OLD_REQUEST_ID,...OLD_INPUT},directory,original.fn)
      const before=readRecord(directory)
      const changed=stubFetch(undefined)
      const message=await rejection(run({requestId:OLD_REQUEST_ID,...OLD_INPUT,pbr:true,texture:true},directory,changed.fn))
      expect(message).toContain('GENERATION_REQUEST_ID_CONFLICT')
      expect(readRecord(directory)).toEqual(before)
      expect(changed.calls.filter(call=>call.includes('generation-requests')||call.includes('/api/v1/'))).toEqual([])
    })
  })

  test("冷恢复核对真实 PBR/纹理请求指纹，相同参数仍可恢复", async () => {
    await withDirectory(async directory=>{
      const input={...OLD_INPUT,pbr:true,texture:true}
      const stub=stubFetch(serverRow({requestFingerprint:await fingerprintOf(input)}))
      const result=await run({requestId:OLD_REQUEST_ID,...input},directory,stub.fn)
      expect(result).toMatchObject({meshURL:OLD_MESH})
      expect(stub.calls.some(call=>call.startsWith('POST'))).toBe(false)
    })
  })

  test("冷重开（本地无记录）：服务端那条是另一次输入 → 显式冲突，不查供应商、不回放旧模型", async () => {
    await withDirectory(async (directory) => {
      const stub = stubFetch(serverRow()) // 指纹是"上一次那次请求"的
      const message = await rejection(run({ requestId: OLD_REQUEST_ID, ...NEW_INPUT }, directory, stub.fn))
      expect(message).toMatch(/GENERATION_REQUEST_ID_CONFLICT/)
      expect(message).toMatch(/GENERATION_REQUEST_ID_CONFLICT.*只给 requestId/s)
      expect(stub.calls).toContain(`GET /v1/generation-requests/tripo/${OLD_REQUEST_ID}`)
      // 冲突发生在任何供应商调用之前：既不查旧作业、也不提交
      expect(stub.calls.filter((call) => call.includes("/api/v1/"))).toEqual([])
    })
  })

  test("冷重开：服务端那行没有保存请求指纹（null / 非 64 位 hex）→ 明确拒绝，不回放", async () => {
    for (const requestFingerprint of [null, "not-a-fingerprint"]) {
      await withDirectory(async (directory) => {
        const stub = stubFetch(serverRow({ requestFingerprint }))
        const message = await rejection(run({ requestId: OLD_REQUEST_ID, ...NEW_INPUT }, directory, stub.fn))
        expect(message).toMatch(/GENERATION_INPUT_UNVERIFIED/)
        expect(stub.calls.filter((call) => call.includes("/api/v1/"))).toEqual([])
      })
    }
  })

  test("冷重开：同一份输入（指纹对得上）→ 照旧恢复，不被判成冲突", async () => {
    await withDirectory(async (directory) => {
      const stub = stubFetch(serverRow({ requestFingerprint: await fingerprintOf(OLD_INPUT), operationId: "task-old" }))
      const result = (await run({ requestId: OLD_REQUEST_ID, ...OLD_INPUT }, directory, stub.fn)) as {
        meshURL?: string
      }
      expect(result.meshURL).toBe(OLD_MESH)
      expect(stub.calls.some((call) => call === "GET /api/v1/tasks/task-old")).toBe(true)
      expect(stub.calls.some((call) => call.startsWith("POST "))).toBe(false)
    })
  })

  test("本地记录是另一次输入 → 冲突判定在回放之前（不查中央、不查供应商）", async () => {
    await withDirectory(async (directory) => {
      writeFileSync(
        join(directory, OLD_REQUEST_ID + ".json"),
        JSON.stringify({
          mode: "formal",
          accountId: "user-1",
          apiUrl: API,
          status: "completed",
          result: { meshURL: OLD_MESH },
          requestFingerprint: await fingerprintOf(OLD_INPUT),
          updatedAt: new Date().toISOString(),
        }),
      )
      const stub = stubFetch(serverRow())
      const message = await rejection(run({ requestId: OLD_REQUEST_ID, ...NEW_INPUT }, directory, stub.fn))
      expect(message).toMatch(/GENERATION_REQUEST_ID_CONFLICT/)
      expect(message).toMatch(/这份本地记录/)
      expect(stub.calls.filter((call) => call.includes("/api/v1/") || call.includes("/v1/generation-requests/"))).toEqual(
        [],
      )
    })
  })

  test("本地记录身份未知（只给 resumeJobId 建立）：带输入明确拒绝，纯恢复照常", async () => {
    await withDirectory(async (directory) => {
      writeFileSync(
        join(directory, OLD_REQUEST_ID + ".json"),
        JSON.stringify({
          mode: "formal",
          accountId: "user-1",
          apiUrl: API,
          status: "completed",
          result: { meshURL: OLD_MESH },
          updatedAt: new Date().toISOString(),
        }),
      )
      const stub = stubFetch(serverRow())
      const message = await rejection(run({ requestId: OLD_REQUEST_ID, ...NEW_INPUT }, directory, stub.fn))
      expect(message).toMatch(/GENERATION_INPUT_UNVERIFIED/)
      expect(message).toMatch(/只给 requestId/)
      // 纯恢复（只给 requestId）不受影响：直接取回那份记录的结果，不查中央请求行、也不打供应商
      // （正式路由本来就要先过 /v1/me 验会话，这里只断言没有恢复/供应商调用）。
      const recovered = (await run({ requestId: OLD_REQUEST_ID }, directory, stub.fn)) as { meshURL?: string }
      expect(recovered.meshURL).toBe(OLD_MESH)
      expect(stub.calls.filter((call) => call.includes("/api/v1/") || call.includes("/v1/generation-requests/"))).toEqual(
        [],
      )
    })
  })

  test("形状写错（prompt 写在顶层）也算带了输入：明确拒绝，不当纯恢复回放旧模型", async () => {
    await withDirectory(async (directory) => {
      const stub = stubFetch(serverRow())
      const message = await rejection(
        run({ requestId: OLD_REQUEST_ID, prompt: "完全不同的新提示词" }, directory, stub.fn),
      )
      expect(message).toMatch(/GENERATION_INPUT_UNVERIFIED/)
      expect(stub.calls.filter((call) => call.includes("/api/v1/"))).toEqual([])
    })
  })

  test("冷重开纯恢复：回放服务端那份成功应答，且不拿空输入伪造身份", async () => {
    await withDirectory(async (directory) => {
      const stub = stubFetch(serverRow())
      const result = (await run({ requestId: OLD_REQUEST_ID }, directory, stub.fn)) as { meshURL?: string }
      expect(result.meshURL).toBe(OLD_MESH)
      expect(stub.calls.filter((call) => call.includes("/api/v1/"))).toEqual([])
      expect("requestFingerprint" in readRecord(directory)).toBe(false)
    })
  })

  test("纯恢复不覆盖记录里原有的身份指纹", async () => {
    await withDirectory(async (directory) => {
      const identity = await fingerprintOf(OLD_INPUT)
      writeFileSync(
        join(directory, OLD_REQUEST_ID + ".json"),
        JSON.stringify({
          mode: "formal",
          accountId: "user-1",
          apiUrl: API,
          status: "interrupted",
          operationId: "task-old",
          requestFingerprint: identity,
          updatedAt: new Date().toISOString(),
        }),
      )
      const stub = stubFetch(undefined) // 中央那行不存在：恢复完全靠本地记录 + 供应商既有作业
      const result = (await run({ requestId: OLD_REQUEST_ID }, directory, stub.fn)) as { meshURL?: string }
      expect(result.meshURL).toBe(OLD_MESH)
      expect(readRecord(directory).requestFingerprint).toBe(identity)
      expect(readRecord(directory).status).toBe("completed")
    })
  })
})
