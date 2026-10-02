/**
 * 百炼图像异步协议的**行为测试**（不是源码复述）：真的发 HTTP、真的收响应、真的下载字节、
 * 真的把作业记录写进磁盘。夹具是本地 HTTP 服务（`support/dashscope-stub.ts`），
 * 它只按官方文档的响应形状回答，**不代表供应商行为**（真实出图未验证，见回执）。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rm } from "node:fs/promises"
import { generateImages, preflightImageGeneration, taskFromServerResponse, ImageError, REMOTE_JOB_LOST_CODE, type GenerateImageInput } from "../src/provider.ts"
import { runImageGeneration, isPreparedOnly } from "../src/operations.ts"
import { startDashScopeStub, tinyPng, type DashScopeStub } from "../support/dashscope-stub.ts"

/** 测试用假 key：真 key 不进源码、不进测试输出（断言它只出现在 Authorization 头里）。 */
const TEST_KEY = "test-key-not-real-49"

async function withStub<T>(body: (stub: DashScopeStub, directory: string) => Promise<T>): Promise<T> {
  const stub = await startDashScopeStub()
  const directory = await mkdtemp(join(tmpdir(), "generate-image-"))
  try {
    return await body(stub, directory)
  } finally {
    await stub.close()
    await rm(directory, { recursive: true, force: true })
  }
}

function options(stub: DashScopeStub, directory: string, extra: Record<string, unknown> = {}) {
  return { dataDirectory: directory, apiKey: TEST_KEY, baseURL: stub.baseURL, model: "qwen-image-3.0", pollIntervalMs: 5, allowPaidSubmission: true, ...extra }
}

/** 等到条件成立（夹具服务是并发的，不能靠固定 sleep 猜时序）。 */
async function waitFor(condition: () => boolean, message: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("等待超时：" + message)
}

test("文生图：提交形状（路径/异步头/请求体）、轮询、真下载字节与官方用量字段", async () => {
  await withStub(async (stub, directory) => {
    const png = tinyPng()
    stub.behavior.imageBytes = png
    const result = await runImageGeneration(
      { requestId: "yard-1", input: { prompt: "北方四合院的院落概念图，灰砖影壁，正房三开间", size: "1024x1024", n: 1, seed: 7 } },
      options(stub, directory),
    )
    assert.equal(isPreparedOnly(result), false)
    if (isPreparedOnly(result)) return
    // —— 我们真的发了什么
    assert.equal(stub.submits.length, 1)
    const submit = stub.submits[0]
    assert.equal(submit.method, "POST")
    assert.equal(submit.path, "/api/v1/services/aigc/image-generation/generation")
    assert.equal(submit.headers["x-dashscope-async"], "enable")
    assert.equal(submit.headers.authorization, `Bearer ${TEST_KEY}`)
    assert.equal(submit.headers["content-type"], "application/json")
    const body = submit.body as { model: string; input: { messages: Array<{ role: string; content: unknown[] }> }; parameters: Record<string, unknown> }
    assert.equal(body.model, "qwen-image-3.0")
    assert.deepEqual(body.input.messages, [{ role: "user", content: [{ text: "北方四合院的院落概念图，灰砖影壁，正房三开间" }] }])
    // size 归一化成官方协议的星号写法（模型给 x 也接受）
    assert.deepEqual(body.parameters, { n: 1, size: "1024*1024", seed: 7 })
    // key 不出现在请求体里
    assert.equal(JSON.stringify(body).includes(TEST_KEY), false)
    // —— 轮询两次：先 RUNNING 再 SUCCEEDED
    assert.equal(stub.queries.length, 2)
    assert.equal(stub.queries[0].path, "/api/v1/tasks/task-stub-1")
    assert.equal(stub.queries[0].headers.authorization, `Bearer ${TEST_KEY}`)
    // —— 真下载：URL 来自响应体，字节落盘
    assert.equal(stub.images.length, 1)
    assert.equal(result.taskId, "task-stub-1")
    assert.equal(result.model, "qwen-image-3.0")
    assert.deepEqual(result.requestIds, { submit: "req-submit-1", query: "req-query-success" })
    assert.deepEqual(result.usage, {
      output_height: 1024,
      output_width: 1024,
      input_image_count: 0,
      input_image_type: "qima_input_1k",
      output_image_count: 1,
      output_image_type: "qima_output_1k",
    })
    assert.equal(result.images.length, 1)
    assert.equal(result.images[0].path, join(directory, "yard-1", "yard-1-1.png"))
    assert.equal(result.images[0].mediaType, "image/png")
    assert.equal(result.images[0].bytes, png.byteLength)
    assert.deepEqual(await readFile(result.images[0].path), png)
    // —— 作业记录：远端 task_id 落盘（重启后据它恢复，不重新提交）
    const record = JSON.parse(await readFile(join(directory, "yard-1.json"), "utf8")) as { status: string; operationId?: string; model?: string }
    assert.equal(record.status, "completed")
    assert.equal(record.operationId, "task-stub-1")
    assert.equal(record.model, "qwen-image-3.0")
  })
})

test("图生图：本地参考图按任务路径读成 Base64 data URL（不要求公网 URL），指令与图同行", async () => {
  await withStub(async (stub, directory) => {
    const reference = join(directory, "yard.png")
    await writeFile(reference, tinyPng())
    const result = await runImageGeneration(
      {
        requestId: "edit-1",
        input: { prompt: "只把石材换成浅灰花岗岩，门窗开口位置与数量完全不变", referenceImages: [reference], size: "1024*1024" },
      },
      options(stub, directory),
    )
    if (isPreparedOnly(result)) throw new Error("unexpected prepared")
    const body = stub.submits[0].body as { input: { messages: Array<{ content: Array<{ image?: string; text?: string }> }> } }
    const content = body.input.messages[0].content
    assert.equal(content.length, 2)
    assert.equal(content[0].image, `data:image/png;base64,${tinyPng().toString("base64")}`)
    assert.equal(content[1].text, "只把石材换成浅灰花岗岩，门窗开口位置与数量完全不变")
    assert.deepEqual(result.referenceImages, [{ source: reference, kind: "file", bytes: tinyPng().byteLength, mediaType: "image/png" }])
  })
})

test("输入校验在**发请求之前**失败：尺寸/张数/种子/提示词都不产生任何 HTTP 请求", async () => {
  await withStub(async (stub, directory) => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["empty-prompt", { prompt: "   " }],
      ["too-small", { prompt: "x", size: "256*256" }],
      ["too-large", { prompt: "x", size: "4096*4096" }],
      // 4096×256：像素数合法（1M）但长宽比 16 > 8
      ["aspect", { prompt: "x", size: "4096*256" }],
      ["n-range", { prompt: "x", n: 7 }],
      ["seed-range", { prompt: "x", seed: -1 }],
      ["too-many-refs", { prompt: "x", referenceImages: ["a", "b", "c", "d"] }],
      ["refs-not-array", { prompt: "x", referenceImages: "a.png" }],
    ]
    for (const [slug, input] of cases) {
      await assert.rejects(
        () => runImageGeneration({ requestId: "bad-" + slug, input: input as unknown as GenerateImageInput }, options(stub, directory)),
        (error: unknown) => {
          assert.ok(error instanceof Error, slug + " 应当抛错")
          assert.match(error.message, /^GENERATION_BLOCKED: /, slug + " 的报错应当是提交前拦截：" + error.message)
          return true
        },
      )
    }
    assert.equal(stub.requests.length, 0, "校验失败的输入一个请求都不该发出去")
  })
})

test("读不到的参考图与非图像文件：如实报错，不发请求", async () => {
  await withStub(async (stub, directory) => {
    const text = join(directory, "notes.txt")
    await writeFile(text, "这不是图像")
    for (const [slug, reference] of [
      ["missing-file", join(directory, "missing.png")],
      ["not-an-image", text],
    ] as Array<[string, string]>) {
      await assert.rejects(
        () => runImageGeneration({ requestId: "ref-" + slug, input: { prompt: "x", referenceImages: [reference] } }, options(stub, directory)),
        (error: unknown) => {
          assert.match((error as Error).message, /GENERATION_BLOCKED/)
          return true
        },
      )
    }
    assert.equal(stub.requests.length, 0)
  })
})

test("恢复已有远端任务：只查询、不重新提交，结果照常下载", async () => {
  await withStub(async (stub, directory) => {
    const result = await runImageGeneration(
      { requestId: "resume-1", resumeTaskId: "task-existing-9", input: { prompt: "任意" } },
      options(stub, directory),
    )
    if (isPreparedOnly(result)) throw new Error("unexpected prepared")
    assert.equal(stub.submits.length, 0, "恢复路径不能重新提交收费任务")
    assert.equal(stub.queries.length >= 1, true)
    assert.equal(stub.queries[0].path, "/api/v1/tasks/task-existing-9")
    assert.equal(result.taskId, "task-existing-9")
    // 恢复路径没有提交过，也就没有"本次实际生效的模型"：供应商应答里没有模型快照，
    // 配置里的 qwen-image-3.0 只是本机当前设置，拿它当历史任务的模型就是冒充。
    assert.equal(result.model, undefined)
    assert.equal(result.images.length, 1)
    const record = JSON.parse(await readFile(join(directory, "resume-1.json"), "utf8")) as { status: string; operationId?: string; model?: string }
    assert.equal(record.status, "completed")
    assert.equal(record.operationId, "task-existing-9")
    assert.equal(record.model, undefined, "记录里也不该出现一个本机配置的模型名")
  })
})

test("已完成且结果还在：同 requestId 再跑不重提交、不重查询，直接返回本地结果", async () => {
  await withStub(async (stub, directory) => {
    const first = await runImageGeneration({ requestId: "twice-1", input: { prompt: "同一张图" } }, options(stub, directory))
    if (isPreparedOnly(first)) throw new Error("unexpected prepared")
    const submitsBefore = stub.submits.length
    const queriesBefore = stub.queries.length
    const second = await runImageGeneration({ requestId: "twice-1", input: { prompt: "同一张图" } }, options(stub, directory))
    if (isPreparedOnly(second)) throw new Error("unexpected prepared")
    assert.deepEqual(second.images, first.images)
    assert.equal(stub.submits.length, submitsBefore, "已完成的 requestId 不该再提交一次（那就是重复收费）")
    assert.equal(stub.queries.length, queriesBefore)
  })
})

test("轮询中取消：本地等待停止并如实报告远端可能仍在运行，记录落 cancelled-local", async () => {
  await withStub(async (stub, directory) => {
    stub.behavior.runningQueries = 100_000
    const controller = new AbortController()
    const promise = runImageGeneration({ requestId: "cancel-1", input: { prompt: "长时间任务" } }, options(stub, directory, { signal: controller.signal }))
    await waitFor(() => stub.queries.length >= 1, "第一次查询到达")
    controller.abort()
    const error = (await promise.then(
      () => undefined,
      (reason: unknown) => reason as Error & { cancellation?: Record<string, unknown>; code?: string },
    ))!
    assert.equal(error.code, "GENERATION_CANCELLED_LOCAL")
    assert.deepEqual(error.cancellation, { scope: "local", remoteStopRequested: false, remoteMayStillRun: true, submissionConfirmed: true, operationId: "task-stub-1" })
    const record = JSON.parse(await readFile(join(directory, "cancel-1.json"), "utf8")) as { status: string; operationId?: string; cancellation?: Record<string, unknown> }
    assert.equal(record.status, "cancelled-local")
    assert.equal(record.operationId, "task-stub-1")
    assert.equal(record.cancellation?.remoteMayStillRun, true)
    // 取消后不再继续轮询
    const queriesAtCancel = stub.queries.length
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(stub.queries.length, queriesAtCancel)
  })
})

test("远端任务不存在：查询 404 与 task_status UNKNOWN 都记终态 remote-lost，重开不重查", async () => {
  await withStub(async (stub, directory) => {
    stub.behavior.queryStatus = 404
    const error = (await runImageGeneration({ requestId: "lost-1", input: { prompt: "x" } }, options(stub, directory)).then(
      () => undefined,
      (reason: unknown) => reason as Error & { code?: string },
    ))!
    assert.equal(error.code, REMOTE_JOB_LOST_CODE)
    assert.match(error.message, /已被供应商确认为不存在/)
    assert.match(error.message, /task-stub-1/)
    // 供应商给的 request_id 细节不往产品文案里带
    assert.equal(error.message.includes("req-query-error"), false)
    const record = JSON.parse(await readFile(join(directory, "lost-1.json"), "utf8")) as { status: string; operationId?: string }
    assert.equal(record.status, "remote-lost")
    assert.equal(record.operationId, "task-stub-1")
    // 重开同 requestId：直接按终态报错，一个远端请求都不发
    const queriesBefore = stub.queries.length
    const reopened = (await runImageGeneration({ requestId: "lost-1", input: { prompt: "x" } }, options(stub, directory)).then(
      () => undefined,
      (reason: unknown) => reason as Error & { code?: string },
    ))!
    assert.equal(reopened.code, REMOTE_JOB_LOST_CODE)
    assert.match(reopened.message, /记录已是终态 remote-lost/)
    assert.equal(stub.queries.length, queriesBefore)
  })
  await withStub(async (stub, directory) => {
    stub.behavior.queryBody = ({ taskId }) => ({ output: { task_id: taskId, task_status: "UNKNOWN" }, request_id: "req-unknown" })
    const error = (await runImageGeneration({ requestId: "lost-2", input: { prompt: "x" } }, options(stub, directory)).then(
      () => undefined,
      (reason: unknown) => reason as Error & { code?: string },
    ))!
    assert.equal(error.code, REMOTE_JOB_LOST_CODE)
  })
})

test("生成图下载失败：报错且不落盘（不留半张图当结果）", async () => {
  await withStub(async (stub, directory) => {
    stub.behavior.imageStatus = 404
    await assert.rejects(
      () => runImageGeneration({ requestId: "download-1", input: { prompt: "x" } }, options(stub, directory)),
      (error: unknown) => {
        assert.match((error as Error).message, /下载生成图失败：HTTP 404/)
        return true
      },
    )
    const record = JSON.parse(await readFile(join(directory, "download-1.json"), "utf8")) as { status: string; operationId?: string }
    assert.equal(record.status, "interrupted", "下载失败是可重试中断，operId 保留以便恢复而不是重提交")
    assert.equal(record.operationId, "task-stub-1")
    await assert.rejects(() => readFile(join(directory, "download-1", "download-1-1.png")), /ENOENT/)
  })
})

test("供应商明确失败（FAILED）：把官方错误码与信息如实带出，不编造成功", async () => {
  await withStub(async (stub, directory) => {
    stub.behavior.queryBody = ({ taskId }) => ({
      output: { task_id: taskId, task_status: "FAILED", code: "InternalError", message: "An internal error has occurred." },
      request_id: "req-failed",
    })
    await assert.rejects(
      () => runImageGeneration({ requestId: "failed-1", input: { prompt: "x" } }, options(stub, directory)),
      (error: unknown) => {
        assert.match((error as Error).message, /\[InternalError\] An internal error has occurred\./)
        return true
      },
    )
    assert.equal(stub.images.length, 0)
  })
})

test("正式路由（协议层）：本机没有供应商 key 也照常提交，实际模型以服务端快照为准", async () => {
  await withStub(async (stub, directory) => {
    // 服务端把请求体里的 model 覆盖成运维配置的模型：应答里的 lyapunov.model 才是实际生效的那个。
    stub.behavior.serverLyapunov = ({ kind }) => ({
      request_id: "srv-row-1",
      client_request_id: "formal-1",
      model: "operator-supplied-model-id",
      estimated_points: 300,
      unit: "points",
      billing: "per_request",
      ...(kind === "query" ? { actual_points: 300 } : {}),
    })
    // 这一层就是 operations 在正式路由下真正调的那一次（mode/baseURL/无本机 key），
    // 区别只在没有中央账户 fetcher（账户侧由 chain 的全链测试覆盖）。
    const result = await generateImages(
      { input: { prompt: "北方四合院概念图", size: "1024*1024" } },
      { mode: "formal", baseURL: stub.baseURL, model: "qwen-image-3.0", pollIntervalMs: 5 },
    )
    assert.equal(stub.submits.length, 1, "正式路由不能因为本机没有 IMAGE_API_KEY 就拦下提交")
    assert.equal(stub.submits[0].headers.authorization, undefined, "本机没有 key 时不该凭空造一个 Authorization")
    // 请求体里那个模型名只是形状占位（服务端会覆盖），不是实际模型
    assert.equal((stub.submits[0].body as { model: string }).model, "qwen-image-3.0")
    // —— 展示与记账用服务端快照
    assert.equal(result.model, "operator-supplied-model-id")
    assert.equal(result.usage?.output_image_count, 1)
    assert.equal(result.images.length, 1)
  })
})

test("正式路由（协议层）：服务端没给模型快照（模型为 NULL 的历史行）时保持未知，不拿本地配置顶替", async () => {
  await withStub(async (stub, directory) => {
    // lyapunov 块照常有（结算、request_id 都在），但没有 model 字段 —— 正是 v9 迁移前那些历史行的形状。
    stub.behavior.serverLyapunov = () => ({ request_id: "srv-row-old", client_request_id: "formal-old", estimated_points: 300, actual_points: 300, unit: "points", billing: "per_request" })
    const result = await generateImages(
      { input: { prompt: "旧请求", size: "1024*1024" } },
      { mode: "formal", baseURL: stub.baseURL, model: "qwen-image-3.0", pollIntervalMs: 5 },
    )
    assert.equal(result.model, undefined, "服务端说未知就是未知，配置里的 qwen-image-3.0 不是这次实际用的模型")
    // 反向对照：同样的应答在开发直连（本机就是实际调用方）下，本地模型就是实际模型。
    const local = await generateImages({ input: { prompt: "本地直连", size: "1024*1024" } }, { mode: "developer", apiKey: TEST_KEY, baseURL: stub.baseURL, model: "qwen-image-3.0", pollIntervalMs: 5 })
    assert.equal(local.model, "qwen-image-3.0")
  })
})

test("服务端判定的失败优先于供应商字段：lyapunov.error 在提交与查询两侧都算数", async () => {
  await withStub(async (stub, directory) => {
    // ① 提交侧：供应商应答是正常的 PENDING + task_id，但中央服务已判本次提交失败。
    stub.behavior.serverLyapunov = ({ kind }) => (kind === "submit" ? { request_id: "srv-rej", client_request_id: "rejected-1", error: "submit_rejected", estimated_points: 300, actual_points: 0, unit: "points", billing: "per_request" } : undefined)
    await assert.rejects(
      () => generateImages({ input: { prompt: "x" } }, { mode: "formal", baseURL: stub.baseURL, pollIntervalMs: 5 }),
      (error: unknown) => {
        assert.match((error as Error).message, /\[submit_rejected\] 中央服务判定本次图像生成失败/)
        return true
      },
    )
    assert.equal(stub.queries.length, 0, "服务端已判失败就不该再去轮询供应商")
    assert.equal(stub.images.length, 0)
  })
  await withStub(async (stub, directory) => {
    // ② 查询侧：供应商应答照旧写 SUCCEEDED 且带图（官方异步口就是这样回报的），
    // 但中央服务判"成功却一张图都没有" → provider_result_empty。客户端必须认服务端的判定。
    stub.behavior.runningQueries = 0
    stub.behavior.serverLyapunov = ({ kind }) => (kind === "query" ? { request_id: "srv-empty", client_request_id: "empty-1", error: "provider_result_empty", estimated_points: 300, actual_points: 0, unit: "points", billing: "per_request" } : { request_id: "srv-empty", client_request_id: "empty-1", model: "operator-supplied-model-id", estimated_points: 300, unit: "points", billing: "per_request" })
    await assert.rejects(
      () => generateImages({ input: { prompt: "x" } }, { mode: "formal", baseURL: stub.baseURL, pollIntervalMs: 5 }),
      (error: unknown) => {
        assert.match((error as Error).message, /provider_result_empty/)
        return true
      },
    )
    assert.equal(stub.images.length, 0, "服务端判失败后不该再去下载结果图")
  })
})

test("供应商写 SUCCEEDED 却没有任何图：本地同样不当成功，不落盘", async () => {
  await withStub(async (stub, directory) => {
    stub.behavior.runningQueries = 0
    stub.behavior.imageCount = 0
    await assert.rejects(
      () => runImageGeneration({ requestId: "empty-local-1", input: { prompt: "x" } }, options(stub, directory)),
      (error: unknown) => {
        assert.match((error as Error).message, /任务成功但结果里没有图片 URL/)
        return true
      },
    )
    assert.equal(stub.images.length, 0)
    const record = JSON.parse(await readFile(join(directory, "empty-local-1.json"), "utf8")) as { status: string; result?: unknown }
    assert.equal(record.status, "interrupted")
    assert.equal(record.result, undefined, "没有图就不该写出一个 completed 结果")
  })
})

test("结果图下载走普通 fetch：账户 fetcher 只放行中央路径，用它下载 CDN 结果会被拒", async () => {
  await withStub(async (stub, directory) => {
    // 中央账户 fetcher 的真实行为：只放行中央入口，跨 origin 直接抛 CENTRAL_GENERATION_ROUTE_REQUIRED
    // （它还会把账号会话带出去）。结果 URL 在供应商 CDN，所以下载通道必须是另一个。
    const accountFetcher = ((url: string | URL | Request, init?: RequestInit) => {
      const target = String(url)
      // 白名单是中央入口路径，不是"同源"：结果图 URL 与账户服务同源（本夹具就同源）也一样被拒。
      if (!target.startsWith(stub.baseURL + "/api/v1/")) throw new Error("CENTRAL_GENERATION_ROUTE_REQUIRED: " + target)
      return fetch(url, init)
    }) as typeof fetch
    const downloaded: string[] = []
    const recordingDownload = ((url: string | URL | Request, init?: RequestInit) => {
      downloaded.push(String(url))
      return fetch(url, init)
    }) as typeof fetch
    const result = await runImageGeneration(
      { requestId: "download-plain-1", input: { prompt: "x" } },
      options(stub, directory, { fetch: accountFetcher, downloadFetch: recordingDownload }),
    )
    if (isPreparedOnly(result)) throw new Error("unexpected prepared")
    assert.equal(downloaded.length, 1, "结果图由独立下载通道取一次")
    assert.match(downloaded[0], /\/results\/task-stub-1-1\.png$/)
    assert.equal(stub.images.length, 1)
    assert.equal(result.images.length, 1)
    // 反向对照：把账户 fetcher 当下载通道，同一个任务会失败——说明两个通道的分工不是可有可无。
    await assert.rejects(
      () => runImageGeneration({ requestId: "download-account-1", input: { prompt: "x" } }, options(stub, directory, { fetch: accountFetcher, downloadFetch: accountFetcher })),
      /CENTRAL_GENERATION_ROUTE_REQUIRED/,
    )
  })
})

test("服务端回放的记录（lookup succeeded 后直接取 response）：只下载、不提交不查询", async () => {
  await withStub(async (stub, directory) => {
    const accountFetcher = (() => {
      throw new Error("CENTRAL_GENERATION_ROUTE_REQUIRED: 回放恢复不该打任何网络接口")
    }) as unknown as typeof fetch
    const replayed = await taskFromServerResponse(
      {
        output: {
          task_id: "task-stub-1",
          task_status: "SUCCEEDED",
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: [{ image: `${stub.baseURL}/results/task-stub-1-1.png`, type: "image" }] } }],
        },
        usage: { output_image_count: 1, output_width: 1024, output_height: 1024 },
        request_id: "req-replay",
        lyapunov: { request_id: "srv-row-9", client_request_id: "replay-1", model: "operator-supplied-model-id", estimated_points: 300, actual_points: 300, unit: "points", billing: "per_request" },
      },
      { fetch: accountFetcher },
    )
    assert.equal(replayed.model, "operator-supplied-model-id")
    assert.equal(replayed.taskId, "task-stub-1")
    assert.deepEqual(replayed.requestIds, { query: "req-replay" })
    assert.equal(replayed.images.length, 1)
    assert.equal(replayed.images[0].bytes, tinyPng().byteLength)
    assert.equal(stub.submits.length, 0, "回放恢复不提交")
    assert.equal(stub.images.length, 1, "回放恢复照常下载结果字节")
    assert.equal(stub.queries.length, 0)
  })
  // 回放里没有图 / 服务端判失败：都不能被当成"有结果可恢复"
  await assert.rejects(() => taskFromServerResponse({ output: { task_status: "SUCCEEDED", choices: [{ message: { content: [] } }] } }), /没有图片 URL/)
  await assert.rejects(() => taskFromServerResponse({ output: { task_status: "SUCCEEDED", choices: [{ message: { content: [{ image: "http://127.0.0.1:1/x.png" }] } }] }, lyapunov: { error: "provider_result_empty" } }), /provider_result_empty/)
})

test("未授权收费提交：在发请求之前拦下，且没有任何 HTTP 请求", async () => {
  await withStub(async (stub, directory) => {
    await assert.rejects(
      () => runImageGeneration({ requestId: "gate-1", input: { prompt: "x" } }, { ...options(stub, directory), allowPaidSubmission: false }),
      (error: unknown) => {
        assert.match((error as Error).message, /^PROVIDER_UNAVAILABLE: 未授权收费提交/)
        return true
      },
    )
    assert.equal(stub.requests.length, 0)
  })
})

test("只做提交前检查（prepareOnly）：不提交、不落记录", async () => {
  await withStub(async (stub, directory) => {
    const prepared = await runImageGeneration(
      { requestId: "prepare-1", input: { prompt: "x" } },
      { ...options(stub, directory), allowPaidSubmission: false, prepareOnly: true, authorizeSubmission: async () => undefined },
    )
    assert.deepEqual(prepared, { prepared: true, requestId: "prepare-1", recovering: false })
    assert.equal(stub.requests.length, 0)
    await assert.rejects(() => readFile(join(directory, "prepare-1.json")), /ENOENT/)
  })
})

test("缺少凭据时明确报错，不静默回落到别的地方", async () => {
  const previous = { IMAGE_API_KEY: process.env.IMAGE_API_KEY, DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY }
  delete process.env.IMAGE_API_KEY
  delete process.env.DASHSCOPE_API_KEY
  try {
    await assert.rejects(
      () => preflightImageGeneration({ input: { prompt: "x" } }),
      (error: unknown) => {
        assert.ok(error instanceof ImageError)
        assert.match(error.message, /IMAGE_API_KEY is required/)
        return true
      },
    )
  } finally {
    if (previous.IMAGE_API_KEY !== undefined) process.env.IMAGE_API_KEY = previous.IMAGE_API_KEY
    if (previous.DASHSCOPE_API_KEY !== undefined) process.env.DASHSCOPE_API_KEY = previous.DASHSCOPE_API_KEY
  }
})

test("默认模型名与默认入口写在 provider 里，不靠调用方记忆", async () => {
  const previous = { IMAGE_MODEL: process.env.IMAGE_MODEL, IMAGE_API_BASE_URL: process.env.IMAGE_API_BASE_URL }
  delete process.env.IMAGE_MODEL
  delete process.env.IMAGE_API_BASE_URL
  try {
    const prepared = await preflightImageGeneration({ input: { prompt: "x" } }, { apiKey: TEST_KEY })
    assert.equal(prepared.model, "qwen-image-3.0")
    assert.equal(prepared.endpoint, "https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation")
    // 显式 baseURL 覆盖（也是测试与正式路由的接入点）
    const overridden = await preflightImageGeneration({ input: { prompt: "x" } }, { apiKey: TEST_KEY, baseURL: "http://127.0.0.1:9" })
    assert.equal(overridden.endpoint, "http://127.0.0.1:9/api/v1/services/aigc/image-generation/generation")
    assert.deepEqual(overridden.referenceImages, [])
  } finally {
    if (previous.IMAGE_MODEL !== undefined) process.env.IMAGE_MODEL = previous.IMAGE_MODEL
    if (previous.IMAGE_API_BASE_URL !== undefined) process.env.IMAGE_API_BASE_URL = previous.IMAGE_API_BASE_URL
  }
})
