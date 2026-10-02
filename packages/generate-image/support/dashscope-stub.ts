/**
 * 百炼图像**异步协议**的本地夹具服务（真实 HTTP，不是 fetch 替身）。
 *
 * 本机沙箱无外网出口，所以真实 `dashscope.aliyuncs.com` 调用在测试里跑不了；这里按官方文档里
 * 的**响应形状**回答（提交 `{output:{task_id,task_status:PENDING},request_id}`；查询
 * `output.choices[].message.content[].image` + 顶层 `usage` + 顶层 `request_id`，见
 * `docs/IMAGE_GENERATION.md` 的记录），并如实记录收到的每个请求（方法/路径/头/体），
 * 让"我们真的发了什么"可以被断言，而不是复述源码。
 *
 * 它**不**代表供应商行为：真实模型出图、真实计费、真实 24 小时链接都未验证（见回执"剩余范围"）。
 */
import { createServer } from "node:http"
import type { IncomingMessage, Server } from "node:http"
import type { AddressInfo } from "node:net"
import { deflateSync } from "node:zlib"

export interface RecordedRequest {
  method: string
  path: string
  headers: Record<string, string | undefined>
  body?: unknown
}

export interface StubBehavior {
  /** 前几次查询返回 RUNNING（默认 1 次），之后返回 SUCCEEDED。 */
  runningQueries: number
  /** 提交响应状态码（默认 200）；非 2xx 时用 submitBody 当错误体。 */
  submitStatus: number
  /** 提交响应体覆盖（不设则用官方成功形状）。 */
  submitBody?: unknown
  /** 查询响应状态码（默认 200）；404 用来验证"任务不存在"。 */
  queryStatus: number
  /** 查询响应体覆盖（不设则按 runningQueries 自动推进）。 */
  queryBody?: (input: { attempt: number; taskId: string }) => unknown
  /** SUCCEEDED 时返回的图片张数（默认 1）。 */
  imageCount: number
  /** 生成图 URL 指向的字节（默认一张真实 1×1 PNG）。 */
  imageBytes?: Buffer
  /** 生成图 URL 的响应状态码（默认 200）；404 用来验证下载失败不落盘。 */
  imageStatus: number
  /** 每张结果的 URL 是否指向一个不可达端口（默认 false）。 */
  deadImageHost?: boolean
  /**
   * 中央账户网关不是单纯透传：它会在供应商原样应答之外附一块 `lyapunov`
   * （`{request_id,client_request_id,model,estimated_points,actual_points,error,...}`）。
   * 这里按"服务端怎么判"注入，用来验证客户端**以服务端判定为准**：`error` 只在失败终态出现，
   * 此时供应商字段可能仍写着 SUCCEEDED；`model` 是服务端实际生效的模型快照（历史行没有这一项）。
   * 返回 undefined = 本次应答不带 `lyapunov` 块（模拟直连供应商的开发模式）。
   */
  serverLyapunov?: (input: { kind: "submit" | "query"; attempt: number; taskId: string }) => Record<string, unknown> | undefined
}

export interface DashScopeStub {
  baseURL: string
  requests: RecordedRequest[]
  submits: RecordedRequest[]
  queries: RecordedRequest[]
  images: RecordedRequest[]
  behavior: StubBehavior
  /** 提交响应里返回的 task_id（可改，用来验证记录里存的是哪个）。 */
  taskId: string
  close(): Promise<void>
}

/** 一张真实的 1×1 PNG（附件服务会真的解码它，假字节过不了）。 */
export function tinyPng(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data])
    const crc = (() => {
      let value = 0xffffffff
      for (const byte of body) {
        value ^= byte
        for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
      }
      return (value ^ 0xffffffff) >>> 0
    })()
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc)
    return Buffer.concat([length, body, checksum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]))),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

const SUBMIT_PATH = "/api/v1/services/aigc/image-generation/generation"
const QUERY_PREFIX = "/api/v1/tasks/"

/** 只对 JSON 对象应答附加 `lyapunov`；服务端判定的字段与供应商字段同级并存（供应商字段原样保留）。 */
function withServerBlock(payload: unknown, block: Record<string, unknown> | undefined): unknown {
  if (!block) return payload
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload
  return { ...(payload as Record<string, unknown>), lyapunov: block }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  if (!chunks.length) return undefined
  const text = Buffer.concat(chunks).toString("utf8")
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function startDashScopeStub(): Promise<DashScopeStub> {
  const behavior: StubBehavior = { runningQueries: 1, submitStatus: 200, queryStatus: 200, imageCount: 1, imageStatus: 200 }
  const requests: RecordedRequest[] = []
  let taskId = "task-stub-1"
  let queryAttempts = 0
  let port = 0
  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = request.url ?? "/"
      const kind: "submit" | "query" | "image" | "other" = path.startsWith(SUBMIT_PATH)
        ? "submit"
        : path.startsWith(QUERY_PREFIX)
          ? "query"
          : path.startsWith("/results/")
            ? "image"
            : "other"
      const body = await readBody(request)
      const headers: Record<string, string | undefined> = {}
      for (const [key, value] of Object.entries(request.headers)) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : value
      const recorded: RecordedRequest = { method: request.method ?? "GET", path, headers, ...(body === undefined ? {} : { body }) }
      requests.push(recorded)
      if (kind === "image" && behavior.imageStatus !== 200) {
        response.writeHead(behavior.imageStatus, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: "image gone" }))
        return
      }
      const json = (payload: unknown, status = 200) => {
        response.writeHead(status, { "content-type": "application/json" })
        response.end(JSON.stringify(payload))
      }
      if (kind === "submit") {
        if (behavior.submitStatus !== 200) {
          json(behavior.submitBody ?? { code: "InvalidApiKey", message: "No API-key provided.", request_id: "req-submit-error" }, behavior.submitStatus)
          return
        }
        const submitted = behavior.submitBody ?? { output: { task_status: "PENDING", task_id: taskId }, request_id: "req-submit-1" }
        json(withServerBlock(submitted, behavior.serverLyapunov?.({ kind: "submit", attempt: 0, taskId })))
        return
      }
      if (kind === "query") {
        if (behavior.queryStatus !== 200) {
          json({ code: "InvalidTaskId", message: "task not found", request_id: "req-query-error" }, behavior.queryStatus)
          return
        }
        queryAttempts += 1
        const attempt = queryAttempts
        const queried = path.slice(QUERY_PREFIX.length)
        if (behavior.queryBody) {
          json(withServerBlock(behavior.queryBody({ attempt, taskId: queried }), behavior.serverLyapunov?.({ kind: "query", attempt, taskId: queried })))
          return
        }
        if (attempt <= behavior.runningQueries) {
          json({ output: { task_id: queried, task_status: "RUNNING" }, request_id: `req-query-${attempt}` })
          return
        }
        const base = behavior.deadImageHost ? "http://127.0.0.1:1" : `http://127.0.0.1:${port}`
        const content = Array.from({ length: behavior.imageCount }, (_unused, index) => ({
          image: `${base}/results/${queried}-${index + 1}.png`,
          type: "image",
        }))
        json(withServerBlock({
          output: {
            task_id: queried,
            task_status: "SUCCEEDED",
            submit_time: "2026-09-20 00:00:00.000",
            scheduled_time: "2026-09-20 00:00:01.000",
            end_time: "2026-09-20 00:00:09.000",
            rewrite_status: "not_use",
            choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
          },
          usage: {
            output_height: 1024,
            output_width: 1024,
            input_image_count: 0,
            input_image_type: "qima_input_1k",
            output_image_count: content.length,
            output_image_type: "qima_output_1k",
          },
          request_id: "req-query-success",
        }, behavior.serverLyapunov?.({ kind: "query", attempt, taskId: queried })))
        return
      }
      if (kind === "image") {
        const bytes = behavior.imageBytes ?? tinyPng()
        response.writeHead(200, { "content-type": "image/png" })
        response.end(bytes)
        return
      }
      json({ code: "UnexpectedPath", message: path }, 404)
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" })
      response.end(JSON.stringify({ message: String(error) }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
  return {
    baseURL: `http://127.0.0.1:${port}`,
    requests,
    get submits() {
      return requests.filter((item) => item.method === "POST" && item.path.startsWith(SUBMIT_PATH))
    },
    get queries() {
      return requests.filter((item) => item.method === "GET" && item.path.startsWith(QUERY_PREFIX))
    },
    get images() {
      return requests.filter((item) => item.path.startsWith("/results/"))
    },
    behavior,
    get taskId() {
      return taskId
    },
    set taskId(value: string) {
      taskId = value
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
