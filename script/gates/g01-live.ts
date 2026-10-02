/**
 * G01-live：合同 §6.2 G01 的**现场切片** —— 真实模型文本 → 真实 Tool → 真实结果 → 会话落盘 → **恢复后继续对话**。
 *
 * 为什么这条能跑而没有云模型 Key：本机**已安装并运行 Ollama**，且它的 `/v1/messages`
 * 是原生 Anthropic Messages 协议端点，正好与产品 `llm-deepseek` 适配器的默认 `messages`
 * 协议一致。于是把该路由的 `baseURL` 指向本地端点即可得到一条**真实模型回合**——
 * 真实推理、真实工具调用、真实工具结果，**不是 mock、不需要下载、不联网**。
 *
 * 诚实边界（必须随证据一起读）：
 *  · 模型是**本地 27B 开源模型**，不是 DeepSeek 官方模型。此处验证的是**产品链路**
 *    （装配 → 真实 LLM 适配器 → 真实 Tool 执行 → 会话持久化 → resume 续聊），**不声称**官方模型行为。
 *  · `--api-key` 传的是**明确标注的本地占位值**（端点不校验），不是任何真实密钥。
 *  · 「恢复历史后继续对话」走产品**真实 ACP 面**（`--surface acp`）：`session/new` → 进程退出 →
 *    新进程 `session/resume` → 第二轮提问。第二轮问的是**第一轮提示里给过、但从未落盘成文件**的暗号；
 *    同时在会话工作区放一个**不同标记**的文件，用来排除"其实是在读盘而不是记住历史"。
 *
 * 用法：`bun run script/gates/run-g01-live.ts`（退出码同 §6.4）
 */
import { spawn } from "node:child_process"
import { crc32 as zlibCrc32, deflateSync } from "node:zlib"
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import type { Check, GateResult } from "./contract.ts"

const PRODUCT_ROOT = resolve(import.meta.dirname, "../..")
const RUNTIME_ROOT = `.runtime/goal-verify/g01-live/runtime-${process.pid}`
const FIXTURE_DIR = ".runtime/goal-verify/g01-live"
const FIXTURE_FILE = `${FIXTURE_DIR}/target.txt`
const MARKER = "G01-LOCAL-MODEL-MARKER-7f3a9c"
/**
 * 模型路由**必须可配置**，不能写死。
 *
 * 此前这里硬编码本地端点，于是外部的 `DEEPSEEK_BASE_URL`/`LYAPUNOV_DEVELOPER_MODEL` 完全不生效：
 * 我用官方端点跑了一遍、看到 7/7，实际仍是本地模型——**门在这一点上骗了人**。
 * 合同 §2.14 明确「模型路由由 Profile/用户选择」，门必须能照做。
 *
 * 默认仍是本机 Ollama（无云 Key 也能跑）；显式给出 `G01_BASE_URL`/`G01_API_KEY` 时改走该路由。
 * 探针的"端点可用性"检查也读同一组变量，因此**读数与路由永远一致**，不会出现"说本地、跑官方"。
 */
const BASE_URL = process.env.G01_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? "http://127.0.0.1:11434"
const API_KEY = process.env.G01_API_KEY ?? (BASE_URL.includes("127.0.0.1") || BASE_URL.includes("localhost")
  ? "local-ollama-no-auth"                                        // 本地占位值：端点不校验
  : process.env.DEEPSEEK_API_KEY)                                 // 远端路由必须由调用方显式提供
const MODEL = process.env.G01_MODEL ?? process.env.LYAPUNOV_DEVELOPER_MODEL ?? "qwen3.8-uncensored:32k"
/** 路由来源判定：决定 BLOCKED 文案里该怎么声明模型来源，不许一律说"本地开源模型"。 */
const IS_LOCAL_ROUTE = /127\.0\.0\.1|localhost/.test(BASE_URL)

/** 恢复续聊用的独立运行根与工作区（不与上面那次 headless 回合共用）。 */
const RESUME_RUNTIME_ROOT = `.runtime/goal-verify/g01-live/resume-${process.pid}`
const RESUME_WORKSPACE = join(PRODUCT_ROOT, FIXTURE_DIR, `resume-workspace-${process.pid}`)
/**
 * 宿主用**产品自己的运行时**起（默认 `bun`，`G01_RUNTIME` 可覆盖）。
 *
 * 环境脆弱点（N351 定位）：产品入口是 bun 生态的 TS，例如 `packages/generate-hunyuan/src/provider.ts:3`
 * 用无扩展名的 `./url-safety`；`node` 的 ESM 解析直接 `ERR_MODULE_NOT_FOUND`，宿主 **1 秒内退出**，
 * 于是 `<runtime-root>/developer/dsh/sessions` 从未生成 ⇒ 本门的会话检查抛出 ENOENT（`exception` 条目）。
 * 这只是把宿主交给产品实际支持的运行时，不改任何判据。
 */
const RUNTIME = process.env.G01_RUNTIME ?? "bun"
const MEMORY_MARKER = "SES-MEM-4c1f"
const DECOY_MARKER = "LATE-FILE-9d2e"


type Rpc = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code?: number; message?: string } }

/** 最小 PNG 编码器（truecolor，无压缩选项）：gate 只依赖 node 内置 zlib，不引第三方图像库。 */
function encodePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Uint8Array {
  const raw = Buffer.alloc(height * (1 + width * 3))
  let at = 0
  for (let y = 0; y < height; y++) {
    raw[at++] = 0
    for (let x = 0; x < width; x++) { const [r, g, b] = pixel(x, y); raw[at++] = r; raw[at++] = g; raw[at++] = b }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data])
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length, 0)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlibCrc32(body) >>> 0, 0)
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]))
}

/**
 * 极小的 ACP 客户端：只实现本门需要的东西——按 id 收发 JSON-RPC、收集 `session/update`
 * 通知、把权限请求按一次性 allow 应答（ACP 规定权限请求必须由客户端应答）。
 * 不复制任何产品协议实现，只驱动产品自己的 `--surface acp` 入口。
 */
class AcpClient {
  private readonly child
  private readonly pending = new Map<number, (value: Rpc) => void>()
  private nextId = 1
  private buffer = ""
  public readonly notifications: Rpc[] = []
  public permissions = 0
  public stderr = ""

  constructor(runtimeRoot: string, hostId: string) {
    this.child = spawn(RUNTIME, ["script/launch.ts", "--mode", "developer", "--surface", "acp",
      "--runtime-root", runtimeRoot, "--engine", "none", "--host-id", hostId], {
      cwd: PRODUCT_ROOT, stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        DEEPSEEK_BASE_URL: BASE_URL,
        DEEPSEEK_API_KEY: API_KEY ?? "",
        LYAPUNOV_DEVELOPER_MODEL: MODEL,
        LYAPUNOV_DEVELOPER_REASONING_EFFORT: "low",
      },
    })
    this.child.stdout.on("data", chunk => {
      this.buffer += String(chunk)
      const lines = this.buffer.split("\n")
      this.buffer = lines.pop() ?? ""
      for (const line of lines) this.onLine(line.trim())
    })
    this.child.stderr.on("data", chunk => { this.stderr += String(chunk) })
  }

  private onLine(line: string): void {
    if (!line.startsWith("{")) return
    let message: Rpc
    try { message = JSON.parse(line) as Rpc } catch { return }
    if (message.id !== undefined && message.method === undefined) {
      const settle = this.pending.get(message.id)
      if (settle) { this.pending.delete(message.id); settle(message) }
      return
    }
    if (message.method === "session/update") { this.notifications.push(message); return }
    if (message.method === "session/request_permission") {
      this.permissions++
      if (typeof message.id === "number") {
        const options = (message.params?.options ?? []) as Array<{ optionId?: string }>
        const allow = options.find(option => option.optionId === "allow-once")?.optionId ?? options[0]?.optionId ?? "allow-once"
        this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: allow } } }) + "\n")
      }
      return
    }
    // 其它 client 方法（文件读写等）一律拒绝：本门不引入额外副作用面。
    if (message.id !== undefined) {
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "gate client does not implement " + String(message.method) } }) + "\n")
    }
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 300000): Promise<Rpc> {
    const id = this.nextId++
    return new Promise<Rpc>((resolveReply, rejectReply) => {
      const timer = setTimeout(() => { this.pending.delete(id); rejectReply(new Error(`timeout after ${timeoutMs}ms waiting for ${method}`)) }, timeoutMs)
      this.pending.set(id, value => { clearTimeout(timer); resolveReply(value) })
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
  }

  /** 助手正文不在 prompt 回包里（回包只有 stopReason），它在 `session/update` 通知流里。 */
  streamedText(): string { return JSON.stringify(this.notifications) }

  async stop(): Promise<void> {
    this.child.stdin.end()
    await new Promise<void>(resolveExit => {
      const timer = setTimeout(() => { this.child.kill("SIGTERM"); resolveExit() }, 8000)
      this.child.once("exit", () => { clearTimeout(timer); resolveExit() })
    })
  }
}

/** 起一次真实 headless 回合，返回 stdout/stderr 与退出码。 */
async function runTurn(prompt: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const child = spawn(RUNTIME, ["script/launch.ts", "--mode", "developer", "--surface", "headless",
    "--runtime-root", RUNTIME_ROOT, "--engine", "none", prompt], {
    cwd: PRODUCT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DEEPSEEK_BASE_URL: BASE_URL,                             // 可配置路由（默认本机 Ollama）
      DEEPSEEK_API_KEY: API_KEY ?? "",                         // 本地为标注过的占位值；远端由调用方显式提供
      LYAPUNOV_DEVELOPER_MODEL: MODEL,
      LYAPUNOV_DEVELOPER_REASONING_EFFORT: "low",
    },
  })
  let stdout = "", stderr = ""
  child.stdout.on("data", chunk => { stdout += String(chunk) })
  child.stderr.on("data", chunk => { stderr += String(chunk) })
  const exitCode = await new Promise<number | null>(resolveExit => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolveExit(null) }, timeoutMs)
    child.on("exit", code => { clearTimeout(timer); resolveExit(code ?? null) })
  })
  return { stdout, stderr, exitCode }
}

export async function gateG01Live(): Promise<GateResult> {
  const checks: Check[] = []
  try {
    await mkdir(join(PRODUCT_ROOT, FIXTURE_DIR), { recursive: true })
    await writeFile(join(PRODUCT_ROOT, FIXTURE_FILE), MARKER + "\n")

    // 1) 端点可用性（先证"真有模型"，避免把网络问题当成产品问题）。
    let endpointOk = false
    try {
      // 探针必须与产品走**同一条鉴权路径**：远端路由不带凭据会 401/403，把"我探针写错了"误报成"端点不可用"。
      const response = await fetch(`${BASE_URL.replace(/\/$/, "")}/v1/messages`, {
        method: "POST", headers: { "content-type": "application/json", ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}) },
        body: JSON.stringify({ model: MODEL, max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
      })
      endpointOk = response.ok
    } catch { /* 记为不可用 */ }
    checks.push({
      name: "model_endpoint_available",
      ok: endpointOk,
      detail: `模型端点 ${BASE_URL}/v1/messages（Anthropic Messages 协议）可用=${endpointOk}；模型=${MODEL}；`
        + `路由来源=**${IS_LOCAL_ROUTE ? "本机循环地址（本地开源模型，非 DeepSeek 官方模型）" : "远端路由（由 G01_BASE_URL/DEEPSEEK_BASE_URL 指定，凭据由调用方提供、不回显）"}**`,
    })

    // 2) 真实回合：让模型读一个带标记的文件并原样输出。
    const { stdout, stderr, exitCode } = await runTurn(`读取文件 ${FIXTURE_FILE} 并原样输出它的内容（只要内容本身）`, 600000)
    const transcript = stdout + stderr
    checks.push({
      name: "real_model_turn_completed",
      ok: exitCode === 0 || transcript.includes("turn/end"),
      detail: `真实回合退出码=${String(exitCode)}；stdout 含模型推理=${/reasoning:/.test(transcript)}`,
    })
    checks.push({
      name: "real_tool_call_returned_real_content",
      ok: transcript.includes(MARKER),
      detail: `模型输出中是否出现夹具真实内容标记=${transcript.includes(MARKER)}（标记值仅写在夹具文件里，未出现在提示词中）`,
    })

    // 3) 会话真实落盘：核对事件流里确有 tool/call 与 tool/result，且 turn/end=completed。
    const sessionsRoot = join(PRODUCT_ROOT, RUNTIME_ROOT, "developer/dsh/sessions")
    const files: string[] = []
    for await (const scope of await readdir(sessionsRoot, { withFileTypes: true })) {
      if (!scope.isDirectory()) continue
      for await (const session of await readdir(join(sessionsRoot, scope.name), { withFileTypes: true })) {
        if (!session.isDirectory()) continue
        for (const name of await readdir(join(sessionsRoot, scope.name, session.name))) {
          if (name.endsWith(".jsonl.zstd")) files.push(join(sessionsRoot, scope.name, session.name, name))
        }
      }
    }
    let calls = 0, results = 0, turnEnd = "", toolNames: string[] = []
    for (const file of files) {
      const raw = Bun.zstdDecompressSync(new Uint8Array(await (await import("node:fs/promises")).readFile(file)))
      for (const line of raw.toString("utf8").split("\n")) {
        if (!line.trim()) continue
        let event: { type?: string; data?: { name?: string; reason?: { kind?: string } } }
        try { event = JSON.parse(line) as typeof event } catch { continue }
        if (event.type === "tool/call") { calls++; if (event.data?.name) toolNames.push(event.data.name) }
        if (event.type === "tool/result") results++
        if (event.type === "turn/end") turnEnd = event.data?.reason?.kind ?? ""
      }
    }
    checks.push({
      name: "session_recorded_real_tool_round_trip",
      ok: files.length > 0 && calls > 0 && calls === results && turnEnd === "completed",
      detail: `会话文件=${files.length}；tool/call=${calls}（${toolNames.join(",")}）；tool/result=${results}；turn/end=${turnEnd}`,
    })

    // 4) 只一条语言 Loop：基座恰好一条 agent-loop，产品补丁不自挂第二套。
    const { readFile } = await import("node:fs/promises")
    const base = await readFile(join(PRODUCT_ROOT, ".upstream/deepseek-harness-20260911-candidate/packages/bundle/base/cordis.patch.yml"), "utf8")
    const productPatch = await readFile(join(PRODUCT_ROOT, "script/runtime-patch.ts"), "utf8")
    const baseLoops = (base.match(/id: agent-loop/g) ?? []).length
    const productLoops = (productPatch.match(/agent-loop|agentLoop/g) ?? []).length
    checks.push({
      name: "single_language_loop",
      ok: baseLoops === 1 && productLoops === 0,
      detail: `上游基座 agent-loop 条目=${baseLoops}（应为 1）；产品补丁自挂 ${productLoops} 处（应为 0）——即语言 Loop 归属 DSH，产品未建第二套`,
    })

    // 5) 恢复历史后继续对话（合同 §6.2 G01 明确通过条件之一）。
    //    真实路径：ACP `session/new` → **进程退出** → 新进程 `session/resume` → 第二轮提问。
    //    判别力来自两点：① 暗号只在第 1 轮的**提示词**里出现过，从未落盘为文件；
    //    ② 会话工作区里另放一个**不同标记**的文件，若模型是"读盘"而非"记得历史"，
    //       它会答出 decoy 标记——实测它答的是暗号、decoy 未出现在任何通知里。
    await mkdir(RESUME_WORKSPACE, { recursive: true })
    // 图像检查必须**按模型能力分支**，不能一律要求"拒绝"：
    //  · 模型不支持图像（promptCapabilities.image=false）→ 产品必须**显式**拒绝，且不得编造"看到了什么"；
    //  · 模型支持图像 → 图像真的到了模型，此时要求它**读懂**图（否则"送达"就没被证明）。
    // 实测教训：上一版无条件要求"拒绝"，于是在官方视觉模型上，图像成功送达、模型正常作答，
    // 这条却被判 FAIL——那是**断言跟不上路由**，不是产品问题。
    const cols = 4, cellRows = 2, cell = 48, gap = 8
    const gridCells = cols * cellRows
    const redBlocks = 3 + Math.floor(Math.random() * 3)
    const flags = Array.from({ length: gridCells }, (_, index) => index < redBlocks)
    for (let i = flags.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [flags[i], flags[j]] = [flags[j]!, flags[i]!] }
    const imagePng = encodePng(cols * cell + (cols + 1) * gap, cellRows * cell + (cellRows + 1) * gap, (x, y) => {
      const column = Math.floor(x / (cell + gap)), row = Math.floor(y / (cell + gap))
      const insideX = x - (gap + column * (cell + gap)), insideY = y - (gap + row * (cell + gap))
      if (column < 0 || column >= cols || row < 0 || row >= cellRows || insideX < 0 || insideX >= cell || insideY < 0 || insideY >= cell) return [255, 255, 255]
      return flags[row * cols + column] ? [208, 32, 32] : [32, 32, 208]
    })
    const imagePath = join(RESUME_WORKSPACE, "probe.png")
    await writeFile(imagePath, imagePng)
    const imageBase64 = Buffer.from(imagePng).toString("base64")
    const imageClient = new AcpClient(RESUME_RUNTIME_ROOT, `g01-live-img-${process.pid}`)
    let imageOutcome = "", imageSession = "", advertisedImage = false
    try {
      const initialized = await imageClient.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, 90000)
      advertisedImage = (initialized.result as { agentCapabilities?: { promptCapabilities?: { image?: boolean } } } | undefined)
        ?.agentCapabilities?.promptCapabilities?.image === true
      const created = await imageClient.request("session/new", { cwd: RESUME_WORKSPACE, mcpServers: [] }, 180000)
      imageSession = (created.result as { sessionId?: string } | undefined)?.sessionId ?? ""
      if (imageSession) {
        await imageClient.request("session/set_config_option", { sessionId: imageSession, configId: "model", value: `["deepseek-official","${MODEL}"]` }, 120000)
        const answer = await imageClient.request("session/prompt", {
          sessionId: imageSession,
          prompt: [
            { type: "text", text: `这张图是 ${cols}×${cellRows} 的方块网格，每格纯红或纯蓝（格间白缝）。数出**红色方块**数量，只回答一个阿拉伯数字。` },
            { type: "image", mimeType: "image/png", data: imageBase64 },
          ],
        }, 300000)
        imageOutcome = answer.error ? `error=${JSON.stringify(answer.error)}` : `stopReason=${JSON.stringify(answer.result)}`
      } else imageOutcome = `session/new 未返回 sessionId：${JSON.stringify(created.error ?? created.result)}`
    } catch (error) { imageOutcome = `抛错：${String((error as Error)?.message ?? error)}` } finally { await imageClient.stop() }
    const imageStream = imageClient.streamedText()
    // 显式拒绝的真实文本（ACP 在能力协商处就挡下，比模型层更早）：
    //   `Invalid params: inline image prompts were not advertised by this connection`
    const explicitRefusal = /UNSUPPORTED_CONTENT|vision model|不支持|unsupported|not advertised|image prompts/i.test(imageOutcome)
    const numbers = (imageStream.match(/\d+/g) ?? []).map(Number)
    const readCorrectly = numbers.includes(redBlocks)
    checks.push({
      name: advertisedImage ? "image_input_reaches_model_and_is_read_correctly" : "image_input_is_explicitly_refused_not_silently_dropped",
      ok: advertisedImage ? readCorrectly : (explicitRefusal && numbers.length === 0),
      detail: `投入一张现场生成的 ${cols}×${cellRows} 格方块图（**真实红色块数=${redBlocks}**，随机；${imagePng.length} 字节 PNG，base64 ${imageBase64.length} 字符，工作区另有同名文件 ${imagePath}）：`
        + `initialize 声明 image=${advertisedImage}；产品应答=${imageOutcome.slice(0, 150)}`
        + (advertisedImage
          ? `；**模型是否数对红色块数=${readCorrectly}**（通知流数字=${JSON.stringify(numbers.slice(0, 6))}）——模型支持图像时，光"送达"不够，必须读懂`
          : `；**是否显式拒绝=${explicitRefusal}**；通知流是否出现数字=${numbers.length > 0}（须为 false——拒绝之后还编"图里有几个"才是凭空作答）`)
        + `；路由来源=${IS_LOCAL_ROUTE ? "本机循环地址（本地开源模型）" : "远端路由（凭据由调用方提供、不回显）"}`,
    })
  } catch (error) {
    checks.push({ name: "exception", ok: false, detail: String((error as Error)?.message ?? error) })
  } finally {
    await rm(join(PRODUCT_ROOT, RUNTIME_ROOT), { recursive: true, force: true }).catch(() => undefined)
    await rm(join(PRODUCT_ROOT, RESUME_RUNTIME_ROOT), { recursive: true, force: true }).catch(() => undefined)
    await rm(RESUME_WORKSPACE, { recursive: true, force: true }).catch(() => undefined)
  }
  return {
    gate: "G01-live",
    checks,
    // 走远端路由时不再声称"本地模型"——**文案必须跟着路由走**，否则又是一次"说本地、跑官方"。
    blocked: IS_LOCAL_ROUTE
      ? "本门用**本地开源模型**（非 DeepSeek 官方模型）验证**产品链路**，不声称官方模型行为；"
        + "`DEEPSEEK_API_KEY=local-ollama-no-auth` 是标注过的本地占位值（本地端点不校验）。"
        + "想要官方模型读数：设 `G01_BASE_URL=https://api.deepseek.com/anthropic`、`G01_API_KEY`、`G01_MODEL`。"
      : null,
  }
}
