/**
 * 共享生成客户端（`client/generation.ts`）与原生授权说明（`client/generation-approval.ts`）的合同测试：
 * `bun test packages/lyapunov-api-client/test/generation-client.test.ts`
 *
 * 这里驱动的是真实客户端函数：报价校验、统一入口改写、以及原生授权问题的实际文案。
 * 断言的是**给用户看的内容**（实际模型、计费口径），不是复述源码里的字符串常量。
 */
import { describe, expect, test } from "bun:test"
import type { Context } from "@deepseek-ai/cordis"
import type { Agent } from "@deepseek-ai/dsh-agent"
import { formalGenerationRoute, generationPublicError } from "../src/generation.ts"
import { generationAuthorizer } from "../src/generation-approval.ts"

const API = "https://api.test"

function stubFetcher(handlers: Record<string, () => Response>) {
  const calls: string[] = []
  const headers: Array<[string, Headers]> = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    calls.push(`${init?.method ?? "GET"} ${url.href}`)
    headers.push([url.pathname, new Headers(init?.headers)])
    const handler = handlers[url.pathname]
    return handler ? handler() : new Response("not found", { status: 404 })
  }) as typeof fetch
  return { calls, headers, fetcher }
}

const me = () => Response.json({ user: { id: "user-1" } })
const quoteBody = (extra: Record<string, unknown> = {}) =>
  Response.json({
    product: "image",
    accountId: "user-1",
    quoteId: "a".repeat(64),
    points: 300,
    unit: "points",
    pricing: "configured-fixed",
    reservationCreated: false,
    model: "operator-supplied-model-id",
    ...extra,
  })
const route = (handlers: Record<string, () => Response>) => {
  const stub = stubFetcher({ "/v1/me": me, ...handlers })
  return { stub, open: () => formalGenerationRoute({ mode: "formal", accountApiUrl: API, accountToken: "session-token", fetcher: stub.fetcher }, "image", "image-1") }
}

describe("image 客户端合同", () => {
  test("报价必须带服务端实际模型；提交与查询按产品改写成本服务的中央路径", async () => {
    const { stub, open } = route({
      "/v1/generation-quotes/image": quoteBody,
      "/v1/images/generations": () =>
        Response.json({ request_id: "req-1", output: { task_id: "task-1", task_status: "PENDING" } }),
      "/v1/images/tasks/task-1": () => Response.json({ output: { task_id: "task-1", task_status: "SUCCEEDED" } }),
    })
    const client = (await open())!
    // 非 marble 产品的 providerBaseUrl 就是账户服务地址：供应商真实入口路径由服务端配置，客户端不拼。
    expect(client.providerBaseUrl).toBe(API)
    const value = await client.quote()
    expect(value).toMatchObject({ model: "operator-supplied-model-id", points: 300, unit: "points", reservationCreated: false })

    client.useQuote(value)
    // 插件发的是**供应商形状**的官方异步路径：提交 `/api/v1/services/aigc/image-generation/generation`。
    const response = await client.fetcher(
      `${client.providerBaseUrl}/api/v1/services/aigc/image-generation/generation?x=1`,
      { method: "POST", body: JSON.stringify({ input: { messages: [{ role: "user", content: [{ text: "一座石桥" }] }] } }) },
    )
    expect(await response.json()).toEqual({ request_id: "req-1", output: { task_id: "task-1", task_status: "PENDING" } })
    expect(stub.calls).toContain(`POST ${API}/v1/images/generations?x=1`)
    // 请求带的是账户会话与刚拿到的报价，供应商密钥与真实入口都在服务端。
    const sent = stub.headers.find(([path]) => path === "/v1/images/generations")![1]
    expect(sent.get("authorization")).toBe("Bearer session-token")
    expect(sent.get("x-lyapunov-generation-quote")).toBe(value.quoteId)
    expect(sent.get("x-lyapunov-request-id")).toBe("image-1")

    // 查询走与 tripo **同名**的供应商路径 `/api/v1/tasks/{id}`，客户端改写成本服务的 image 独立入口。
    const queried = await client.fetcher(`${client.providerBaseUrl}/api/v1/tasks/task-1`)
    expect(await queried.json()).toEqual({ output: { task_id: "task-1", task_status: "SUCCEEDED" } })
    expect(stub.calls).toContain(`GET ${API}/v1/images/tasks/task-1`)
    expect(stub.calls).not.toContain(`GET ${API}/api/v1/tasks/task-1`)
    // 不在白名单里的路径一律不发，避免客户端自己造一条绕过网关的供应商路由（含旧的同步图像路径）。
    for (const blocked of ["/v1/compatible-mode/images/generations", "/api/v1/services/aigc/image-generation/generation-legacy"]) {
      await expect(client.fetcher(`https://api.test${blocked}`)).rejects.toThrow("CENTRAL_GENERATION_ROUTE_REQUIRED")
    }
  })

  test("tripo 的查询路径原样保留：只有 image 会被改写到产品独立的中央入口", async () => {
    const stub = stubFetcher({
      "/v1/me": me,
      "/api/v1/tasks/task-1": () => Response.json({ output: { task_id: "task-1", task_status: "PENDING" } }),
    })
    const client = (await formalGenerationRoute(
      { mode: "formal", accountApiUrl: API, accountToken: "session-token", fetcher: stub.fetcher },
      "tripo",
      "tripo-1",
    ))!
    const response = await client.fetcher(`${client.providerBaseUrl}/api/v1/tasks/task-1`)
    expect(await response.json()).toEqual({ output: { task_id: "task-1", task_status: "PENDING" } })
    expect(stub.calls).toContain(`GET ${API}/api/v1/tasks/task-1`)
  })

  test("恢复读的是服务端记录：lookup 的 model 为空就是未知", async () => {
    const stub = stubFetcher({
      "/v1/me": me,
      "/v1/generation-requests/image/image-1": () =>
        Response.json({
          requestId: "image-1",
          serverRequestId: "row-1",
          product: "image",
          status: "succeeded",
          operationId: "task-1",
          model: null,
          estimatedPoints: 300,
          chargedPoints: 300,
          error: null,
          response: { output: { task_id: "task-1", task_status: "SUCCEEDED" } },
        }),
    })
    const client = (await formalGenerationRoute(
      { mode: "formal", accountApiUrl: API, accountToken: "session-token", fetcher: stub.fetcher },
      "image",
      "image-1",
    ))!
    expect(await client.lookup()).toMatchObject({ status: "succeeded", chargedPoints: 300, model: null })
  })

  test("报价里的模型字段不可信就直接拒绝整份报价", async () => {
    for (const broken of [{ model: "" }, { model: 5 }, { model: null }]) {
      const { open } = route({ "/v1/generation-quotes/image": () => quoteBody(broken) })
      const client = (await open())!
      await expect(client.quote()).rejects.toThrow("CENTRAL_GENERATION_QUOTE_INVALID")
    }
  })
})

describe("generation recovery lookup", () => {
  const lookupPath = "/v1/generation-requests/image/image-1"
  const valid = { requestId: "image-1", product: "image", serverRequestId: "row-1", status: "running", operationId: "task-1" }

  test("only an explicit missing-request response allows a new request", async () => {
    const { open } = route({ [lookupPath]: () => Response.json({ error: "generation_request_not_found" }, { status: 404 }) })
    expect(await (await open())!.lookup()).toBeUndefined()
    const unavailable = route({ [lookupPath]: () => new Response("not found", { status: 404 }) })
    await expect((await unavailable.open())!.lookup()).rejects.toThrow("CENTRAL_GENERATION_RECOVERY_UNAVAILABLE")
  })

  test("malformed successful responses cannot masquerade as an absent request", async () => {
    for (const value of [null, false, [], {}, { ...valid, status: "" }, { ...valid, serverRequestId: "" },
      { ...valid, operationId: "" }, { ...valid, operationId: 12 }]) {
      const { open } = route({ [lookupPath]: () => Response.json(value) })
      await expect((await open())!.lookup()).rejects.toThrow("CENTRAL_GENERATION_LOOKUP_INVALID")
    }
  })

  test("recovery must match the original request and product", async () => {
    for (const value of [{ ...valid, requestId: "another-request" }, { ...valid, product: "hunyuan" }]) {
      const { open } = route({ [lookupPath]: () => Response.json(value) })
      await expect((await open())!.lookup()).rejects.toThrow("CENTRAL_GENERATION_LOOKUP_INVALID")
    }
  })

  test("an uncertain request without a job ID remains a record, not permission to submit", async () => {
    const value = { ...valid, status: "submitting", operationId: null }
    const { open } = route({ [lookupPath]: () => Response.json(value) })
    expect(await (await open())!.lookup()).toMatchObject(value)
  })
})

type Asked = {
  questions: Array<{
    id: string
    header?: string
    question: string
    detail: string
    options: Array<{ label: string; description: string }>
  }>
}

/** 最小 ctx：只提供授权流程真正用到的 credentials / userQuestions，以及 pending 去重用的 root。 */
function authorizer(selected = "提交生成") {
  const store = new Map<string, unknown>()
  const asked: Asked[] = []
  const credentials = {
    readRecord: async (key: string) => store.get(key),
    modifyRecord: async (key: string, update: (prior: unknown) => unknown) => {
      const next = await update(store.get(key))
      store.set(key, next)
      return next
    },
  }
  const questions = {
    ask: async (input: Asked) => {
      asked.push(input)
      return { answers: [{ id: input.questions[0]!.id, selected: selected ? [selected] : [] }] }
    },
  }
  const ctx = {
    root: {},
    get: (name: string) =>
      name === "credentials" ? credentials : name === "userQuestions" ? questions : undefined,
  } as unknown as Context
  return { authorize: generationAuthorizer(ctx, {} as Agent), asked, store, ctx }
}

const imageQuote = {
  product: "image" as const,
  accountId: "user-1",
  quoteId: "b".repeat(64),
  points: 300,
  unit: "points" as const,
  pricing: "configured-fixed" as const,
  reservationCreated: false as const,
  model: "operator-supplied-model-id",
}

describe("原生授权说明", () => {
  test("正式图像提交使用中性功能名与真实报价，供应商实际模型仅保留授权审计", async () => {
    const { authorize, asked, store } = authorizer()
    await authorize({
      product: "image",
      requestId: "image-1",
      mode: "formal",
      accountId: "user-1",
      apiUrl: API,
      request: { model: "model-from-the-client", prompt: "一座石桥的概念图" },
      quote: imageQuote,
    })
    const question = asked[0]!.questions[0]!
    expect(question.header).toBe("图像生成 / Image generation")
    expect(question.detail).toContain("生成服务：图像生成 / Image generation")
    expect(question.detail).not.toContain("operator-supplied-model-id")
    expect(question.detail).not.toContain("model-from-the-client")
    expect(question.detail).toContain("中央服务报价：**300 点/次**")
    expect(question.detail).toContain("按请求固定计费")
    expect(question.detail).toContain("一座石桥的概念图")
    // 授权记录绑定真实报价：quoteId 与积分数落到原生 grant 里。
    const grant = [...store.values()][0] as { kind: string; payload: Record<string, unknown> }
    expect(grant).toMatchObject({ kind: "grant", payload: { decision: "submit", quoteId: imageQuote.quoteId, points: 300 } })
  })

  test("开发直连没有服务端模型：照实展示请求模型并标出供应商入口，不冒充服务端固定", async () => {
    const { authorize, asked } = authorizer()
    await authorize({
      product: "image",
      requestId: "image-dev-1",
      mode: "developer",
      accountId: "user-1",
      apiUrl: "https://dashscope.test",
      request: { model: "model-from-the-client", prompt: "一座石桥的概念图" },
    })
    const question = asked[0]!.questions[0]!
    expect(question.detail).toContain("模型：model-from-the-client")
    expect(question.detail).not.toContain("模型（服务端固定）")
    expect(question.detail).toContain("供应商入口：https://dashscope.test")
    expect(question.detail).toContain("无法精确报价")
  })
})

describe("授权与取消边界", () => {
  const tripoQuote = {
    product: "tripo" as const,
    accountId: "user-1",
    quoteId: "c".repeat(64),
    points: 700,
    unit: "points" as const,
    pricing: "configured-fixed" as const,
    reservationCreated: false as const,
  }
  const tripoRequest = { model: "Tripo/Tripo-P1.0", prompt: "一个木箱" }
  const approval = (requestId = "tripo-1") => ({
    product: "tripo" as const,
    requestId,
    mode: "formal" as const,
    accountId: "user-1",
    apiUrl: API,
    request: tripoRequest,
    quote: tripoQuote,
  })

  test("用户取消：明确报取消，且不写 grant（后面不会有提交）", async () => {
    const { authorize, asked, store } = authorizer("取消")
    await expect(authorize(approval())).rejects.toThrow("GENERATION_CANCELLED_BY_USER")
    expect(asked.length).toBe(1)
    // 取消不落凭据：同一请求再走一次仍要重新确认，不能被"取消"变成一次静默授权。
    expect(store.size).toBe(0)
  })

  test("正式模式没有报价时不弹窗：先拿到报价再谈授权", async () => {
    const { authorize, asked, store } = authorizer()
    await expect(
      authorize({ product: "tripo", requestId: "tripo-2", mode: "formal", accountId: "user-1", apiUrl: API, request: tripoRequest }),
    ).rejects.toThrow("CENTRAL_GENERATION_QUOTE_UNAVAILABLE")
    expect(asked.length).toBe(0)
    expect(store.size).toBe(0)
  })

  test("正式三维报价确认保留真实材质参数和内部审计，正文按世界模型角色显示 Pontryagin", async () => {
    const { authorize,asked,store } = authorizer()
    await authorize({...approval(),request:{model:'Tripo/Tripo-P1.0',input:{mode:'text-to-3d',prompt:'真实三维香蕉'},parameters:{pbr:true,texture:true,texture_quality:'detailed'}}})
    const question=asked[0]!.questions[0]!
    expect(question.header).toBe('Pontryagin 3D')
    expect(question.question).toBe('提交这次 Pontryagin 3D 生成请求？')
    expect(question.detail).toContain('材质：PBR')
    expect(question.detail).toContain('纹理：生成纹理')
    expect(question.detail).toContain('质量：detailed')
    expect(question.detail).toContain('生成类型：text-to-3d')
    expect(JSON.stringify(question)).not.toMatch(/tripo|阿里云|百炼/i)
    expect([...store.values()][0]).toMatchObject({payload:{product:'tripo',points:700}})
  })

  test("中央缺正价/配置：只取一次报价，既不提交也不弹收费问题", async () => {
    const stub=stubFetcher({'/v1/me':me,'/v1/generation-quotes/tripo':()=>Response.json({error:'unavailable',message:'tripo generation is not configured'},{status:503})})
    const client=(await formalGenerationRoute({mode:'formal',accountApiUrl:API,accountToken:'session-token',fetcher:stub.fetcher},'tripo','new-textured'))!
    let message=''
    try{await client.quote()}catch(error){message=(error as Error).message}
    expect(message).toContain('CENTRAL_GENERATION_QUOTE_UNAVAILABLE')
    expect(message).toContain('Pontryagin 3D')
    expect(message).toContain('正积分报价未就绪')
    expect(message).toContain('停止本次尝试')
    expect(message).not.toMatch(/tripo|百炼|aliyun/i)
    expect(stub.calls.filter(call=>call.includes('generation-quotes'))).toHaveLength(1)
    expect(stub.calls.some(call=>call.startsWith('POST'))).toBe(false)
  })

  test("供应商错误只投影到正式产品，原始原因保留供审计", () => {
    const original=Object.assign(new Error('本地取消：已停止等待 Tripo 生成'),{code:'GENERATION_CANCELLED_LOCAL'})
    const projected=generationPublicError(original,'tripo')
    expect(projected.message).toContain('Pontryagin 3D')
    expect(projected.message).not.toContain('Tripo')
    expect(projected.cause).toBe(original)
    const upstream=generationPublicError(new Error('Tripo request failed: 502 Bad Gateway'),'tripo')
    expect(upstream.message).toContain('不重新提交或循环重试')
    expect(upstream.message).not.toMatch(/Tripo|Bad Gateway/)
  })

  test("同一报价同一请求只确认一次；报价变了必须重新确认", async () => {
    const { authorize, asked, store } = authorizer()
    await authorize(approval())
    await authorize(approval())
    expect(asked.length).toBe(1)

    // 单价变了（新的 quoteId 与积分数）：指纹不同，必须再问一次，不能拿旧确认提交新价格。
    await authorize({ ...approval(), quote: { ...tripoQuote, quoteId: "d".repeat(64), points: 800 } })
    expect(asked.length).toBe(2)
    const grant = [...store.values()][0] as { payload: Record<string, unknown> }
    expect(grant.payload).toMatchObject({ points: 800, quoteId: "d".repeat(64) })
  })

  test("后台确认没有既有 grant 就拒绝；前台确认过的同一请求可在后台复用", async () => {
    const { authorize, asked, store, ctx } = authorizer()
    const background = generationAuthorizer(ctx, undefined, false)
    await expect(background(approval("tripo-3"))).rejects.toThrow("GENERATION_CONFIRMATION_CHANGED")
    expect(store.size).toBe(0)
    expect(asked.length).toBe(0)

    // 前台确认后，同一请求在后台（不再弹窗）可以复用同一份确认。
    await authorize(approval("tripo-4"))
    await background(approval("tripo-4"))
    expect(asked.length).toBe(1)
    expect(store.size).toBe(1)
  })
})
