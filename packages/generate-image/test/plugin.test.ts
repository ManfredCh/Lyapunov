/**
 * 工具层**产品行为**测试：真的过原生工具注册表、真的问原生用户问题、真的写原生 grant、
 * 真的起原生后台作业、真的把图作为附件交回模型（前台走工具结果，后台走完成通知）。
 *
 * 供应商侧仍是本地夹具 HTTP 服务：本机沙箱无外网出口，"真实百炼未验证"（见回执）。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startDashScopeStub, tinyPng, type DashScopeStub } from "../support/dashscope-stub.ts"
import { createHarness, resultText, type Harness, type HarnessOptions } from "../support/harness.ts"

async function withHarness<T>(options: Omit<HarnessOptions, "baseURL" | "dataDirectory">, body: (harness: Harness, stub: DashScopeStub, directory: string) => Promise<T>): Promise<T> {
  const stub = await startDashScopeStub()
  const directory = await mkdtemp(join(tmpdir(), "generate-image-plugin-"))
  const harness = await createHarness({ ...options, baseURL: stub.baseURL, dataDirectory: directory, pollIntervalMs: 5 })
  try {
    return await body(harness, stub, directory)
  } finally {
    await harness.dispose()
    await stub.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const request = (input: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({ requestId: "yard-1", input, ...extra })

test("前台文生图：原生问答确认后才提交，结果带图回模型，图落任务目录", async () => {
  await withHarness({}, async (harness, stub, directory) => {
    harness.respondWith("提交生成")
    const call = await harness.call({
      request_json: request({ prompt: "北方四合院的院落概念图", size: "1024*1024", n: 1 }),
    })
    assert.notEqual(call.isError, true, resultText(call))
    const parsed = JSON.parse(resultText(call)) as {
      model: string
      taskId: string
      usage: Record<string, unknown>
      images: Array<{ path: string; bytes: number; mediaType: string }>
      imageDelivery: { requested: number; attached: number; failures: unknown[]; delivery: string }
    }
    // 模型名与官方用量字段如实返回
    assert.equal(parsed.model, "qwen-image-3.0")
    assert.equal(parsed.taskId, "task-stub-1")
    assert.equal(parsed.usage.output_image_type, "qima_output_1k")
    // 生成的图落本任务 dataDirectory
    assert.equal(parsed.images.length, 1)
    assert.equal(parsed.images[0].path, join(directory, "yard-1", "yard-1-1.png"))
    assert.deepEqual(await readFile(parsed.images[0].path), tinyPng())
    // 真的进了模型上下文（前台车道）：读数 + 真附件 + 渲染出的图像块
    assert.deepEqual(parsed.imageDelivery, { requested: 1, attached: 1, failures: [], skipped: [], delivery: "tool-result" })
    assert.deepEqual(harness.images, ["yard-1-1.png"])
    assert.equal((call.content ?? []).filter((block) => block.type === "image").length, 1)
    // 弹窗内容：产品名、请求摘要、供应商入口都如实，且**不回显 Base64 图**
    assert.equal(harness.asked.length, 1)
    // 共享 generation-approval 的原生问句：图像请求的标题与问句不是 3D 那套文案
    assert.equal(harness.asked[0].header, "生成图像")
    assert.equal(harness.asked[0].question, "提交这次图像生成请求？")
    assert.match(harness.asked[0].detail ?? "", /无法精确报价/)
    assert.match(harness.asked[0].detail ?? "", /北方四合院的院落概念图/)
    assert.match(harness.asked[0].detail ?? "", new RegExp(stub.baseURL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    assert.deepEqual(harness.asked[0].options?.map((option) => option.label), ["提交生成", "取消"])
    // 只提交一次
    assert.equal(stub.submits.length, 1)
  })
})

test("用户取消：不提交、不落记录、零上游请求", async () => {
  await withHarness({}, async (harness, stub, directory) => {
    harness.respondWith("取消")
    const call = await harness.call({ request_json: request({ prompt: "x" }) })
    assert.equal(call.isError, true)
    assert.match(resultText(call), /GENERATION_CANCELLED_BY_USER/)
    assert.equal(stub.requests.length, 0)
    assert.equal(existsSync(join(directory, "yard-1.json")), false)
    assert.deepEqual(harness.images, [])
  })
})

test("没有应答方（没有 UI）：明确失败，不静默提交", async () => {
  await withHarness({}, async (harness, stub) => {
    const call = await harness.call({ request_json: request({ prompt: "x" }) })
    assert.equal(call.isError, true)
    assert.match(resultText(call), /no user-questions answerer accepted the request/)
    assert.equal(stub.requests.length, 0)
  })
})

test("没有 grant 存储：拒绝并说明原因，零上游请求", async () => {
  await withHarness({ credentials: false }, async (harness, stub) => {
    harness.respondWith("提交生成")
    const call = await harness.call({ request_json: request({ prompt: "x" }) })
    assert.equal(call.isError, true)
    assert.match(resultText(call), /GENERATION_GRANT_STORE_UNAVAILABLE/)
    assert.equal(stub.requests.length, 0)
  })
})

test("模型 JSON 不能改凭据/入口/模型档位：apiKey、baseURL、endpoint、model 一律拒绝", async () => {
  await withHarness({}, async (harness, stub) => {
    harness.respondWith("提交生成")
    for (const key of ["apiKey", "baseURL", "endpoint", "model"]) {
      const call = await harness.call({ request_json: request({ prompt: "x" }, { [key]: "模型塞进来的值" }) })
      assert.equal(call.isError, true, key)
      assert.match(resultText(call), /GENERATION_CREDENTIAL_REDIRECT_REJECTED/, key)
      assert.match(resultText(call), new RegExp(key), key)
    }
    assert.equal(stub.requests.length, 0)
  })
})

test("相对参考图按会话 cwd 解析：本地文件真读成 Base64 送进同一请求", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "generate-image-cwd-"))
  try {
    await mkdir(join(cwd, "refs"), { recursive: true })
    await writeFile(join(cwd, "refs", "yard.png"), tinyPng())
    await withHarness({ cwd }, async (harness, stub) => {
      harness.respondWith("提交生成")
      const call = await harness.call({
        request_json: request({ prompt: "只把石材换成浅灰花岗岩，开口不变", referenceImages: ["refs/yard.png"] }),
      })
      assert.notEqual(call.isError, true, resultText(call))
      const body = stub.submits[0].body as { input: { messages: Array<{ content: Array<{ image?: string; text?: string }> }> } }
      const content = body.input.messages[0].content
      assert.equal(content[0].image, `data:image/png;base64,${tinyPng().toString("base64")}`)
      assert.equal(content[1].text, "只把石材换成浅灰花岗岩，开口不变")
    })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("恢复已有远端任务：不重复确认、不重新提交，图仍交回模型", async () => {
  await withHarness({}, async (harness, stub) => {
    const call = await harness.call({ request_json: request({ prompt: "x" }, { resumeTaskId: "task-existing-9" }) })
    assert.notEqual(call.isError, true, resultText(call))
    const parsed = JSON.parse(resultText(call)) as { taskId: string; imageDelivery: { delivery: string; attached: number } }
    assert.equal(parsed.taskId, "task-existing-9")
    assert.equal(parsed.imageDelivery.delivery, "tool-result")
    assert.equal(parsed.imageDelivery.attached, 1)
    assert.equal(harness.asked.length, 0, "恢复不需要再问一次")
    assert.equal(stub.submits.length, 0, "恢复不能重新提交收费任务")
    assert.equal(stub.queries[0].path, "/api/v1/tasks/task-existing-9")
  })
})

test("未装配附件服务：如实报「没送到」，但仍给出真实路径（不假装模型看见了图）", async () => {
  await withHarness({ attachments: false }, async (harness, stub, directory) => {
    harness.respondWith("提交生成")
    const call = await harness.call({ request_json: request({ prompt: "x" }) })
    assert.notEqual(call.isError, true, resultText(call))
    const parsed = JSON.parse(resultText(call)) as { images: Array<{ path: string }>; imageDelivery: { attached: number; delivery: string; deliveryError?: string; failures: Array<{ reason: string }> } }
    assert.equal(parsed.imageDelivery.attached, 0)
    assert.equal(parsed.imageDelivery.delivery, "none")
    assert.match(parsed.imageDelivery.deliveryError ?? "", /请求了渲染但没有任何一张图进上下文/)
    assert.match(parsed.imageDelivery.failures[0].reason, /没有装配附件服务/)
    assert.equal((call.content ?? []).filter((block) => block.type === "image").length, 0)
    // 图在磁盘上仍然是真实可用的
    assert.deepEqual(await readFile(parsed.images[0].path), tinyPng())
    const record = JSON.parse(await readFile(join(directory, "yard-1.json"), "utf8")) as { status: string }
    assert.equal(record.status, "completed")
  })
})

test("后台作业：前台问一次，作业内不再问；完成通知把图投进会话", async () => {
  await withHarness({}, async (harness, stub, directory) => {
    harness.respondWith("提交生成")
    const caller = new AbortController()
    const call = await harness.call({ request_json: request({ prompt: "后台出图", size: "1024*1024" }), background: true }, { signal: caller.signal })
    caller.abort(new Error("人工Stop本轮请求，已注册的Job独立继续"))
    assert.notEqual(call.isError, true, resultText(call))
    const started = JSON.parse(resultText(call)) as { jobId: string; requestId: string }
    assert.equal(started.requestId, "yard-1")
    assert.equal(harness.asked.length, 1, "授权只在前后台边界问一次")
    const snapshot = await harness.ctx.jobs.wait(started.jobId as never, 15_000, harness.agent?.id)
    assert.equal(snapshot.status, "completed", snapshot.detail)
    // 读的是**同一条结果行**（原生 jobs 的终态输出），不是另造一份
    const parsed = JSON.parse((harness.ctx.jobs.read(started.jobId as never, harness.agent?.id).result ?? '')) as { imageDelivery: { attached: number; delivery: string }; images: Array<{ path: string }> }
    assert.equal(parsed.imageDelivery.attached, 1)
    assert.equal(parsed.imageDelivery.delivery, "job-notice")
    assert.deepEqual(await readFile(parsed.images[0].path), tinyPng())
    // 完成通知真的进了 owner 的下一步，并且带的是**图像块**
    const messages = harness.claimNextStep()
    assert.equal(messages.length, 1)
    assert.equal(messages[0].source?.kind, "lyapunov-generate-image")
    assert.equal(messages[0].source?.form, "notice")
    assert.match(messages[0].source?.summary ?? "", /生成图 1 张/)
    assert.equal(messages[0].content.filter((block) => block.type === "image").length, 1)
    assert.equal(harness.asked.length, 1, "作业内没有第二次问答")
    assert.equal(stub.submits.length, 1, "只提交一次")
    assert.equal(harness.images.length, 1)
    // 记录仍是 completed，重启后可直接取本地结果
    const record = JSON.parse(await readFile(join(directory, "yard-1.json"), "utf8")) as { status: string; operationId?: string }
    assert.equal(record.status, "completed")
    assert.equal(record.operationId, "task-stub-1")
  })
})

test("后台作业被取消：落 killed、不发图（取消的作业不作为本次产出）", async () => {
  await withHarness({}, async (harness, stub, directory) => {
    stub.behavior.runningQueries = 100_000
    harness.respondWith("提交生成")
    const call = await harness.call({ request_json: request({ prompt: "长时间后台任务" }), background: true })
    const started = JSON.parse(resultText(call)) as { jobId: string }
    // 等第一次查询真的发出去，再取消（否则取消会落在提交之前，读数不同）
    const deadline = Date.now() + 5000
    while (stub.queries.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.ok(stub.queries.length >= 1)
    assert.equal(harness.ctx.jobs.kill(started.jobId as never, harness.agent?.id, "测试取消"), "requested")
    const snapshot = await harness.ctx.jobs.wait(started.jobId as never, 15_000, harness.agent?.id)
    assert.equal(snapshot.status, "killed", snapshot.detail)
    assert.deepEqual(harness.claimNextStep(), [], "取消的作业不发图")
    assert.deepEqual(harness.images, [])
    const record = JSON.parse(await readFile(join(directory, "yard-1.json"), "utf8")) as { status: string; operationId?: string; cancellation?: { remoteMayStillRun?: boolean } }
    assert.equal(record.status, "cancelled-local")
    assert.equal(record.operationId, "task-stub-1", "远端 task_id 保留，供恢复")
    assert.equal(record.cancellation?.remoteMayStillRun, true)
  })
})

test("远端任务已被供应商清掉（查询 404）：前台调用明确报 remote-lost", async () => {
  await withHarness({}, async (harness, stub) => {
    harness.respondWith("提交生成")
    stub.behavior.queryStatus = 404
    const call = await harness.call({ request_json: request({ prompt: "x" }) })
    assert.equal(call.isError, true)
    assert.match(resultText(call), /GENERATION_REMOTE_JOB_LOST/)
    assert.match(resultText(call), /已被供应商确认为不存在/)
  })
})

test("同一个 requestId 换了实际请求：明确冲突，绝不悄悄返回上一次的图", async () => {
  await withHarness({}, async (harness, stub) => {
    harness.respondWith("提交生成")
    const first = await harness.call({ request_json: request({ prompt: "第一张：灰砖影壁" }) })
    assert.notEqual(first.isError, true, resultText(first))
    const submits = stub.submits.length
    const queries = stub.queries.length
    const asked = harness.asked.length
    // 换提示词
    const renamed = await harness.call({ request_json: request({ prompt: "完全不同的第二张：玻璃幕墙" }) })
    assert.equal(renamed.isError, true)
    assert.match(resultText(renamed), /GENERATION_REQUEST_ID_CONFLICT/)
    // 换生成参数（尺寸）同样算换了请求；冲突判定在输入校验之前，报的是冲突而不是参数问题
    const resized = await harness.call({ request_json: request({ prompt: "第一张：灰砖影壁", size: "512*512" }) })
    assert.equal(resized.isError, true)
    assert.match(resultText(resized), /GENERATION_REQUEST_ID_CONFLICT/)
    assert.equal(stub.submits.length, submits, "冲突既不提交也不重新收费")
    assert.equal(stub.queries.length, queries, "冲突不会去重查供应商")
    assert.equal(harness.asked.length, asked, "冲突不弹第二次授权")
    // 原样的输入再跑：直接返回本地结果（同一次身份，不是冲突）
    const again = await harness.call({ request_json: request({ prompt: "第一张：灰砖影壁" }) })
    assert.notEqual(again.isError, true, resultText(again))
    assert.equal(stub.submits.length, submits)
  })
})

test("开发端恢复用记录里那次实际用的模型，不拿当前配置顶替", async () => {
  const stub = await startDashScopeStub()
  const directory = await mkdtemp(join(tmpdir(), "generate-image-record-model-"))
  try {
    // 第一次：提交成功但结果下载失败 → 中断；记录里留下远端 task_id 与本次真正提交的模型
    stub.behavior.imageStatus = 404
    const first = await createHarness({ baseURL: stub.baseURL, dataDirectory: directory, model: "qwen-image-3.0", pollIntervalMs: 5 })
    try {
      first.respondWith("提交生成")
      const call = await first.call({ request_json: request({ prompt: "记模型" }) })
      assert.equal(call.isError, true, resultText(call))
      const record = JSON.parse(await readFile(join(directory, "yard-1.json"), "utf8")) as { status: string; model?: string; operationId?: string }
      assert.equal(record.status, "interrupted")
      assert.equal(record.model, "qwen-image-3.0", "开发直连：本次真正提交的本地模型就是实际模型")
      assert.equal(record.operationId, "task-stub-1")
    } finally {
      await first.dispose()
    }
    // 第二次：当前配置已换成另一个模型，恢复同一条记录
    stub.behavior.imageStatus = 200
    const second = await createHarness({ baseURL: stub.baseURL, dataDirectory: directory, model: "operator-supplied-model-id", pollIntervalMs: 5 })
    try {
      const call = await second.call({ request_json: request({ prompt: "记模型" }) })
      assert.notEqual(call.isError, true, resultText(call))
      const parsed = JSON.parse(resultText(call)) as { model?: string; taskId?: string }
      assert.equal(parsed.model, "qwen-image-3.0", "恢复显示记录里那次实际用的模型，而不是当前配置里的 operator-supplied-model-id")
      assert.equal(parsed.taskId, "task-stub-1")
      assert.equal(second.asked.length, 0, "恢复不重新确认")
      assert.equal(stub.submits.length, 1, "恢复不重新提交")
    } finally {
      await second.dispose()
    }
  } finally {
    await stub.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("显式纯恢复：只给 requestId（不带 input）就取回原结果，不重新确认、不重新提交、不重读输入", async () => {
  const stub = await startDashScopeStub()
  const directory = await mkdtemp(join(tmpdir(), "generate-image-pure-resume-"))
  try {
    // 第一次：提交成功、结果下载失败 → 中断（记录里有远端 task_id）
    stub.behavior.imageStatus = 404
    const first = await createHarness({ baseURL: stub.baseURL, dataDirectory: directory, pollIntervalMs: 5 })
    try {
      first.respondWith("提交生成")
      const call = await first.call({ request_json: request({ prompt: "灰砖影壁" }) })
      assert.equal(call.isError, true, resultText(call))
      assert.equal(JSON.parse(await readFile(join(directory, "yard-1.json"), "utf8")).status, "interrupted")
    } finally {
      await first.dispose()
    }
    stub.behavior.imageStatus = 200
    const second = await createHarness({ baseURL: stub.baseURL, dataDirectory: directory, pollIntervalMs: 5 })
    try {
      // "只恢复原请求"的意图：只给 requestId。用户不需要再交一遍旧提示词。
      const call = await second.call({ request_json: JSON.stringify({ requestId: "yard-1" }) })
      assert.notEqual(call.isError, true, resultText(call))
      const parsed = JSON.parse(resultText(call)) as { requestId?: string; taskId?: string; images: Array<{ path: string }> }
      assert.equal(parsed.requestId, "yard-1")
      assert.equal(parsed.taskId, "task-stub-1", "取回的就是那次真实提交的远端任务结果，不需要调用方补回提示词")
      assert.deepEqual(await readFile(parsed.images[0]!.path), tinyPng())
      assert.equal(second.asked.length, 0, "纯恢复不重新确认")
      assert.equal(stub.submits.length, 1, "纯恢复不重新提交")
      assert.ok(
        stub.queries.length >= 2 && stub.queries.every((entry) => entry.path === "/api/v1/tasks/task-stub-1"),
        "所有查询都只指向那一条既有远端任务：" + JSON.stringify(stub.queries.map((entry) => entry.path)),
      )
      // 零输入也没有被当成"空提示词的新请求"提交出去：供应商只收到过那一次带提示词的提交
      assert.equal(stub.submits.filter((entry) => JSON.stringify(entry.body).includes("灰砖影壁")).length, 1)
    } finally {
      await second.dispose()
    }
  } finally {
    await stub.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("中断 → 纯恢复 → 原输入回来读结果：身份没被恢复擦掉（不冲突、提交仍 1），真改输入仍冲突", async () => {
  const stub = await startDashScopeStub()
  const directory = await mkdtemp(join(tmpdir(), "generate-image-resume-identity-"))
  const original = { prompt: "中断后恢复的同一张图：灰砖影壁", size: "1024*1024", n: 1 }
  try {
    // 第一次：提交成功（上游真的收了这一次）但查询 503 中断 → 记录停在 interrupted，身份=这次输入
    stub.behavior.queryStatus = 503
    const first = await createHarness({ baseURL: stub.baseURL, dataDirectory: directory, pollIntervalMs: 5, pollAttempts: 2 })
    let identity = ""
    try {
      first.respondWith("提交生成")
      const call = await first.call({ request_json: request(original) })
      assert.equal(call.isError, true, resultText(call))
      const record = JSON.parse(await readFile(join(directory, "yard-1.json"), "utf8")) as { status: string; operationId?: string; requestFingerprint?: string }
      assert.equal(record.status, "interrupted")
      assert.equal(record.operationId, "task-stub-1")
      assert.match(String(record.requestFingerprint), /^[a-f0-9]{64}$/)
      identity = String(record.requestFingerprint)
      assert.equal(stub.submits.length, 1)
    } finally {
      await first.dispose()
    }
    // 第二次：只给 requestId 的纯恢复 → 完成，并且**没有**把身份改写成"空输入"的指纹
    stub.behavior.queryStatus = 200
    stub.behavior.runningQueries = 0
    const second = await createHarness({ baseURL: stub.baseURL, dataDirectory: directory, pollIntervalMs: 5 })
    try {
      const resumed = await second.call({ request_json: JSON.stringify({ requestId: "yard-1" }) })
      assert.notEqual(resumed.isError, true, resultText(resumed))
      const after = JSON.parse(await readFile(join(directory, "yard-1.json"), "utf8")) as { status: string; requestFingerprint?: string }
      assert.equal(after.status, "completed")
      assert.equal(after.requestFingerprint, identity, "纯恢复不能拿空输入的指纹覆盖原请求身份")
      assert.equal(second.asked.length, 0, "纯恢复不重新授权")
      assert.equal(stub.submits.length, 1, "纯恢复不重新提交")
      // 第三次：拿**原来那份输入**回来读结果 → 身份仍在，既不冲突也不重新提交/查询
      const queries = stub.queries.length
      const replay = await second.call({ request_json: request(original) })
      assert.notEqual(replay.isError, true, resultText(replay))
      assert.equal(stub.submits.length, 1)
      assert.equal(stub.queries.length, queries, "读回放结果不再查上游")
      assert.deepEqual(await readFile((JSON.parse(resultText(replay)) as { images: Array<{ path: string }> }).images[0]!.path), tinyPng())
      // 真换了提示词/参数仍然冲突：上面那条"保留身份"不是靠放行不同输入换来的
      const renamed = await second.call({ request_json: request({ ...original, prompt: "完全不同的另一张图" }) })
      assert.equal(renamed.isError, true)
      assert.match(resultText(renamed), /GENERATION_REQUEST_ID_CONFLICT/)
      const resized = await second.call({ request_json: request({ ...original, size: "512*512" }) })
      assert.equal(resized.isError, true)
      assert.match(resultText(resized), /GENERATION_REQUEST_ID_CONFLICT/)
      assert.equal(stub.submits.length, 1, "冲突既不提交也不重新收费")
    } finally {
      await second.dispose()
    }
  } finally {
    await stub.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("记录的身份未知时（只给 resumeTaskId 建立记录）：带 input 明确拒绝，不拿这份记录的结果回放", async () => {
  await withHarness({}, async (harness, stub, directory) => {
    // 只给 resumeTaskId（没有输入可算指纹）建立记录：身份**未知**，如实不写 requestFingerprint
    const resumed = await harness.call({ request_json: request({}, { resumeTaskId: "task-stub-1" }) })
    assert.notEqual(resumed.isError, true, resultText(resumed))
    const record = JSON.parse(await readFile(join(directory, "yard-1.json"), "utf8")) as { requestFingerprint?: string }
    assert.equal(record.requestFingerprint, undefined, "没有输入就不写身份：未知就保持未知，不拿空输入顶替")
    const submits = stub.submits.length
    const queries = stub.queries.length
    // 带 input 的调用：这份记录证不了"这次输入=原来那次" → 明确拒绝，并给出"只给 requestId"的出路
    const withInput = await harness.call({ request_json: request({ prompt: "这次想生成的是另一张图" }) })
    assert.equal(withInput.isError, true)
    assert.match(resultText(withInput), /GENERATION_INPUT_UNVERIFIED/)
    assert.match(resultText(withInput), /只给 requestId/)
    assert.equal(stub.submits.length, submits, "拒绝时不提交")
    assert.equal(stub.queries.length, queries, "拒绝时也不去查上游")
    // 纯恢复（不带 input）照常可用：这条路不比对输入，取回的就是那条既有远端任务的结果
    const pure = await harness.call({ request_json: JSON.stringify({ requestId: "yard-1" }) })
    assert.notEqual(pure.isError, true, resultText(pure))
    assert.equal((JSON.parse(resultText(pure)) as { taskId?: string }).taskId, "task-stub-1")
  })
})

test("开发直连恢复带 input 不读参考图文件（身份只在本地记录里，没有中央账本可比）：文件删掉后仍按记录恢复", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "generate-image-resume-cwd-"))
  const stub = await startDashScopeStub()
  const directory = await mkdtemp(join(tmpdir(), "generate-image-resume-data-"))
  try {
    await mkdir(join(cwd, "refs"), { recursive: true })
    await writeFile(join(cwd, "refs", "yard.png"), tinyPng())
    // 第一次：提交成功、结果下载失败 → 中断（原参考图此刻还在）
    stub.behavior.imageStatus = 404
    const first = await createHarness({ baseURL: stub.baseURL, dataDirectory: directory, cwd, pollIntervalMs: 5 })
    try {
      first.respondWith("提交生成")
      const call = await first.call({ request_json: request({ prompt: "只换石材，开口不变", referenceImages: ["refs/yard.png"] }) })
      assert.equal(call.isError, true, resultText(call))
      const record = JSON.parse(await readFile(join(directory, "yard-1.json"), "utf8")) as { status: string; operationId?: string }
      assert.equal(record.status, "interrupted")
      assert.equal(record.operationId, "task-stub-1")
    } finally {
      await first.dispose()
    }
    // 把参考图删掉：恢复只按记录查远端，不该再去读那个文件
    await rm(join(cwd, "refs", "yard.png"))
    stub.behavior.imageStatus = 200
    const second = await createHarness({ baseURL: stub.baseURL, dataDirectory: directory, cwd, pollIntervalMs: 5 })
    try {
      const call = await second.call({ request_json: request({ prompt: "只换石材，开口不变", referenceImages: ["refs/yard.png"] }) })
      assert.notEqual(call.isError, true, resultText(call))
      const parsed = JSON.parse(resultText(call)) as { taskId?: string; images: Array<{ path: string }> }
      assert.equal(parsed.taskId, "task-stub-1")
      assert.equal(stub.submits.length, 1, "恢复不重新提交")
      assert.deepEqual(await readFile(parsed.images[0].path), tinyPng())
    } finally {
      await second.dispose()
    }
  } finally {
    await stub.close()
    await rm(directory, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  }
})
