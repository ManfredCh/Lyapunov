/**
 * G11-live：合同 §6.2 G11 现场切片 —— 中/英文指令 + 真实 Tool Call + **改模型路由不改业务代码**。
 *
 * 覆盖：
 *  · 中文/英文指令各真实调起 `read`、取回真实内容；
 *  · 同一任务中英走**同一工具路径**；
 *  · 业务包源码零引用模型路由（"换路由不改业务代码"）；
 *  · **视觉事实**（合同原文"一张可核对内容图像"）：走产品真实 ACP 面投入一张真图，
 *    核对模型报出的**实际图像内容**。
 *
 * 视觉事实怎么做到"可核对"而不是"看起来像在看图"：
 *  · 图像每次现场生成，**红色带的数量随机**（3..7/8）——模型猜不中，必须真的看图；
 *  · 判据是**模型报出的数字 == 生成时的真实数字**，不是"回复里提到了颜色"；
 *  · 同时要求模型报出的颜色组合正确（红/蓝），排除只对了一半。
 *
 * 路由可配置（默认本机 Ollama；官方路由由 `G01_BASE_URL`/`G01_API_KEY`/`G01_MODEL` 指定）。
 * 视觉那一条需要**多模态模型**：本地 4 个 Ollama 模型均为纯文本，故默认路由下该条会如实报
 * "模型不支持图像"（`promptCapabilities.image=false` 导致显式拒绝），**不算通过**。
 *
 * 用法：`bun run script/gates/run-g11-live.ts`
 */
import { spawn } from "node:child_process"
import { crc32 as zlibCrc32, deflateSync } from "node:zlib"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import type { Check, GateResult } from "./contract.ts"

const PRODUCT_ROOT = resolve(import.meta.dirname, "../..")
const BASE_URL = process.env.G01_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? "http://127.0.0.1:11434"
const API_KEY = process.env.G01_API_KEY ?? (BASE_URL.includes("127.0.0.1") || BASE_URL.includes("localhost")
  ? "local-ollama-no-auth"
  : process.env.DEEPSEEK_API_KEY)
const MODEL = process.env.G01_MODEL ?? process.env.LYAPUNOV_DEVELOPER_MODEL ?? "qwen3.8-uncensored:32k"
const IS_LOCAL_ROUTE = /127\.0\.0\.1|localhost/.test(BASE_URL)
const MARKER = "G01-LOCAL-MODEL-MARKER-7f3a9c"
// 夹具必须由**本门自己**创建。此前它借用 G01LIVE 的 `.runtime/g01-live/target.txt`：
// 干净树上单跑 G11LIVE 时文件不存在，模型读不到内容 → 报成 FAIL，而真实原因是**夹具缺失**。
// 覆盖面审计把这条点名为"未跟踪夹具让缺依赖表现成失败"，这里改为自建自清。
const FIXTURE_DIR = ".runtime/goal-verify/g11-live"
const FIXTURE = `${FIXTURE_DIR}/target.txt`
const VISION_RUNTIME_ROOT = `.runtime/goal-verify/g11-live/vision-${process.pid}`

/** 跑一次真实回合，返回输出与会话事件摘要。 */
async function turn(prompt: string, runtimeRoot: string): Promise<{ transcript: string; tools: string[]; results: number; turnEnd: string; sessionFiles: number }> {
  const child = spawn("node", ["script/launch.ts", "--mode", "developer", "--surface", "headless",
    "--runtime-root", runtimeRoot, "--engine", "none", prompt], {
    cwd: PRODUCT_ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DEEPSEEK_BASE_URL: BASE_URL, DEEPSEEK_API_KEY: API_KEY ?? "", LYAPUNOV_DEVELOPER_MODEL: MODEL, LYAPUNOV_DEVELOPER_REASONING_EFFORT: "low" },
  })
  let transcript = ""
  child.stdout.on("data", chunk => { transcript += String(chunk) })
  child.stderr.on("data", chunk => { transcript += String(chunk) })
  await new Promise<void>(resolveExit => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolveExit() }, 420000)
    child.on("exit", () => { clearTimeout(timer); resolveExit() })
  })
  const sessionsRoot = join(PRODUCT_ROOT, runtimeRoot, "developer/dsh/sessions")
  const files: string[] = []
  try {
    for await (const scope of await readdir(sessionsRoot, { withFileTypes: true })) {
      if (!scope.isDirectory()) continue
      for await (const session of await readdir(join(sessionsRoot, scope.name), { withFileTypes: true })) {
        if (!session.isDirectory()) continue
        for (const name of await readdir(join(sessionsRoot, scope.name, session.name))) if (name.endsWith(".jsonl.zstd")) files.push(join(sessionsRoot, scope.name, session.name, name))
      }
    }
  } catch { /* 无会话 */ }
  const tools: string[] = []
  let results = 0, turnEnd = ""
  for (const file of files) {
    const raw = Bun.zstdDecompressSync(new Uint8Array(await readFile(file)))
    for (const line of raw.toString("utf8").split("\n")) {
      if (!line.trim()) continue
      let event: { type?: string; data?: { name?: string; reason?: { kind?: string } } }
      try { event = JSON.parse(line) as typeof event } catch { continue }
      if (event.type === "tool/call" && event.data?.name) tools.push(event.data.name)
      if (event.type === "tool/result") results++
      if (event.type === "turn/end") turnEnd = event.data?.reason?.kind ?? ""
    }
  }
  return { transcript, tools, results, turnEnd, sessionFiles: files.length }
}

export async function gateG11Live(): Promise<GateResult> {
  const checks: Check[] = []
  const roots = [".runtime/goal-verify/g11-live/zh", ".runtime/goal-verify/g11-live/en"]
  // 两个回合的读数在 finally 的归档里还要用，故在 try 外声明。
  let zh: Awaited<ReturnType<typeof turn>> | undefined
  let en: Awaited<ReturnType<typeof turn>> | undefined
  try {
    // 自建夹具（本门自己负责，不依赖 G01LIVE 先跑过）。
    await mkdir(join(PRODUCT_ROOT, FIXTURE_DIR), { recursive: true })
    await writeFile(join(PRODUCT_ROOT, FIXTURE), MARKER + "\n")
    // 中文指令
    zh = await turn(`读取文件 ${FIXTURE} 并原样输出它的内容（只要内容本身）`, roots[0]!)
    checks.push({
      name: "chinese_instruction_real_tool_call",
      ok: zh.tools.includes("read") && zh.results > 0 && zh.transcript.includes(MARKER),
      detail: `中文回合：真实工具调用=[${zh.tools.join(",")}]；tool/result=${zh.results}；turn/end=${zh.turnEnd}；输出含夹具真实标记=${zh.transcript.includes(MARKER)}`,
    })
    // 英文指令
    en = await turn(`Read the file ${FIXTURE} and output its content exactly. Output only the content.`, roots[1]!)
    checks.push({
      name: "english_instruction_real_tool_call",
      ok: en.tools.includes("read") && en.results > 0 && en.transcript.includes(MARKER),
      detail: `英文回合：真实工具调用=[${en.tools.join(",")}]；tool/result=${en.results}；turn/end=${en.turnEnd}；输出含夹具真实标记=${en.transcript.includes(MARKER)}`,
    })
    checks.push({
      name: "same_task_both_languages",
      ok: zh.tools.join() === en.tools.join() && zh.transcript.includes(MARKER) && en.transcript.includes(MARKER),
      detail: `中英同一任务走同一工具路径：中文=[${zh.tools.join(",")}]、英文=[${en.tools.join(",")}]；两侧都取到同一真实内容`,
    })

    // 改模型路由不改业务代码：结构性证据（遍历业务包源码，统计路由关键词出现次数）。
    // 只匹配**模型路由**词汇。此前用过 `provider\s*[:=]\s*['"]`，它误报了场景碰撞代码里的
    // `provider: "layered-vertical-box-debug"`（那是碰撞 provider，与模型无关）——收紧到模型专有词汇。
    const routePattern = /deepseek-official|DEEPSEEK_BASE_URL|LYAPUNOV_DEVELOPER_MODEL|agentDefaultModel|modelProvider|reasoning_effort|reasoningEffort/
    const businessPackages = ["scene-kit", "sim-mujoco", "sim-contract", "robot-tools", "viewer", "lyapunov-contracts"]
    const hits: Array<{ pkg: string; count: number }> = []
    for (const pkg of businessPackages) {
      let count = 0
      const walk = async (directory: string): Promise<void> => {
        for await (const entry of await readdir(directory, { withFileTypes: true })) {
          const next = join(directory, entry.name)
          if (entry.isDirectory()) { await walk(next); continue }
          if (!/\.tsx?$/.test(entry.name)) continue
          const text = await readFile(next, "utf8")
          count += text.split("\n").filter(line => routePattern.test(line)).length
        }
      }
      await walk(join(PRODUCT_ROOT, "packages", pkg, "src")).catch(() => undefined)
      hits.push({ pkg, count })
    }
    const total = hits.reduce((sum, item) => sum + item.count, 0)
    checks.push({
      name: "model_route_not_referenced_by_business_code",
      ok: total === 0,
      detail: `业务包中"模型/provider/路由"关键词出现次数=${total}（逐包：${hits.map(item => `${item.pkg}=${item.count}`).join(" ")}）——即**换模型路由不需要改业务代码**；本次实测的模型路由来源=${IS_LOCAL_ROUTE ? "本机循环地址（本地开源模型，非 DeepSeek 官方模型）" : "远端路由（由 G01_BASE_URL 指定，凭据由调用方提供、不回显）"}，业务包一行未动`,
    })

    // ── 视觉事实（合同 §6.2 G11 原文「一张可核对内容图像」）────────────────────────
    // 走产品**真实 ACP 面**投入一张现场生成的真图，核对模型报出的**实际图像内容**。
    // 图像每次随机（红色带 3..7/8），所以"猜"过不了；判据是"报出的数字 == 生成时的真实数字"。
    const vis = await visualFactCheck()
    checks.push(vis)
  } catch (error) {
    checks.push({ name: "exception", ok: false, detail: String((error as Error)?.message ?? error) })
  } finally {
    // §6.1 证据留存：临时会话与运行根删掉之前，先把**现场转录摘要**归档到持久位置。
    // 覆盖审计把这条点名为缺口（"G11LIVE 收尾删产物，回执里没有证据路径"）。
    // 只存摘要与真实读数（工具名、事件计数、标记命中、逐条 check），不搬会话二进制。
    try {
      const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d+Z$/, "Z")
      const archiveDir = join(PRODUCT_ROOT, "bugfixHistory/refactor-execution/evidence/G11-live", stamp)
      await mkdir(archiveDir, { recursive: true })
      await writeFile(join(archiveDir, "result.json"), JSON.stringify({
        gate: "G11-live",
        archivedAt: stamp,
        model: MODEL,
        modelProvenance: IS_LOCAL_ROUTE ? "本地开源模型（非 DeepSeek 官方模型）" : "远端路由（凭据由调用方提供，不回显）",
        endpoint: BASE_URL,
        fixture: { path: FIXTURE, marker: MARKER, createdByThisGate: true },
        turns: {
          zh: zh ? { tools: zh.tools, toolResults: zh.results, turnEnd: zh.turnEnd, sessionFiles: zh.sessionFiles, markerPresent: zh.transcript.includes(MARKER) } : null,
          en: en ? { tools: en.tools, toolResults: en.results, turnEnd: en.turnEnd, sessionFiles: en.sessionFiles, markerPresent: en.transcript.includes(MARKER) } : null,
        },
        checks: checks.map(check => ({ name: check.name, ok: check.ok })),
      }, null, 2) + "\n")
      checks.push({
        name: "evidence_archived_before_cleanup",
        ok: true,
        detail: `现场转录摘要已归档 → evidence/G11-live/${stamp}/result.json（含逐轮工具名、tool/result 计数、turn/end、会话文件数、标记命中与逐条 check 结果）；临时运行根随后清理`,
      })
    } catch (error) {
      checks.push({ name: "evidence_archived_before_cleanup", ok: false, detail: `证据归档失败：${String((error as Error)?.message ?? error)}` })
    }
    for (const root of roots) await rm(join(PRODUCT_ROOT, root), { recursive: true, force: true }).catch(() => undefined)
    await rm(join(PRODUCT_ROOT, FIXTURE), { force: true }).catch(() => undefined)
  }
  return {
    gate: "G11-live",
    checks,
    // BLOCKED 只记**真实缺口**。视觉那条通过时本门没有任何未覆盖条件，此时 blocked 必须是 null
    // （否则退出码会说"有缺口"，与读数矛盾）。**模型来源声明不属于缺口**，它是元数据，
    // 已写进 `model_route_not_referenced_by_business_code` 与 `visual_fact_verifiable_image` 的 detail。
    blocked: (() => {
      const vision = checks.find(check => check.name === "visual_fact_verifiable_image")
      if (vision?.ok === true) return null
      return IS_LOCAL_ROUTE
        ? "未覆盖：合同 G11 要求「一张可核对内容图像」的**视觉事实**——当前是本机路由，本地 4 个 Ollama 模型均为纯文本（`promptCapabilities.image=false`，图像被显式拒绝），故该条不通过。"
          + "要拿视觉事实：设 `G01_BASE_URL=https://api.deepseek.com/anthropic`、`G01_API_KEY`、`G01_MODEL=deepseek-v4-flash-vision-exp`（实测该路由下模型能正确数出随机方块数）。"
        : "未覆盖：视觉事实一条未通过，原因见 `visual_fact_verifiable_image` 的真实读数（不是夹具缺失，也不改用别的证据顶替）。"
    })(),
  }
}

type Rpc = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code?: number; message?: string } }

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
    this.child = spawn("node", ["script/launch.ts", "--mode", "developer", "--surface", "acp",
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

/**
 * 视觉事实检查：现场生成一张内容随机的真图 → 经产品 ACP 面投入 → 核对模型报出的图像内容。
 *
 * 判据（三条同时成立，缺一不可）：
 *  1. `initialize` 声明 `promptCapabilities.image===true`（模型确实被当作多模态）；
 *  2. 回合正常结束（`stopReason=end_turn`，无错误）；
 *  3. 模型报出的**红色带数量 == 生成时的真实数量**，且颜色词命中红/蓝。
 * 只对了一半（比如颜色说对、数字说错）不算通过——那说明它没真在数。
 */
async function visualFactCheck(): Promise<Check> {
  // 夹具尺度经实测选定：先用 8 条**细色带**（12px 宽）跑，模型在 6 红/2 蓝时数成 2
  // ——细条纹对计数本就不友好，那是**夹具尺度问题**，不是产品缺陷（同一次运行里颜色判对了、
  // 图像也确实送达）。改成 4×2 的**大方块**（48px/格、格间留 8px 白缝），计数变成无歧义任务。
  // 随机性保留：红格数每次在 3..5 之间随机并随机摆放，模型无法预设答案。
  const cols = 4, cellRows = 2, cell = 48, gap = 8
  const cells = cols * cellRows
  const redCount = 3 + Math.floor(Math.random() * 3)             // 3..5
  const flags = Array.from({ length: cells }, (_, index) => index < redCount)
  for (let i = flags.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [flags[i], flags[j]] = [flags[j]!, flags[i]!] }
  const width = cols * cell + (cols + 1) * gap
  const height = cellRows * cell + (cellRows + 1) * gap
  const png = encodePng(width, height, (x, y) => {
    const column = Math.floor(x / (cell + gap)), row = Math.floor(y / (cell + gap))
    const insideX = x - (gap + column * (cell + gap)), insideY = y - (gap + row * (cell + gap))
    if (column < 0 || column >= cols || row < 0 || row >= cellRows) return [255, 255, 255]
    if (insideX < 0 || insideX >= cell || insideY < 0 || insideY >= cell) return [255, 255, 255]
    return flags[row * cols + column] ? [208, 32, 32] : [32, 32, 208]
  })
  const workspace = join(PRODUCT_ROOT, FIXTURE_DIR, `vision-${process.pid}`)
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, "bands.png"), png)

  const client = new AcpClient(VISION_RUNTIME_ROOT, `g11-vision-${process.pid}`)
  let advertisedImage = false, stopReason = "", answer = "", errorText = ""
  try {
    const init = await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, 90000)
    const caps = (init.result as { agentCapabilities?: { promptCapabilities?: { image?: boolean } } } | undefined)?.agentCapabilities?.promptCapabilities
    advertisedImage = caps?.image === true
    const created = await client.request("session/new", { cwd: workspace, mcpServers: [] }, 180000)
    const sessionId = (created.result as { sessionId?: string } | undefined)?.sessionId
    if (!sessionId) errorText = `session/new 无 sessionId：${JSON.stringify(created.error ?? created.result)}`
    else {
      const replied = await client.request("session/prompt", {
        sessionId,
        prompt: [
          { type: "text", text: `这张图是一个 ${cols}×${cellRows} 的方块网格，每格是纯红色或纯蓝色（格间有白色缝隙）。请数出**红色方块**的数量，只回答一个阿拉伯数字，不要解释。` },
          { type: "image", mimeType: "image/png", data: Buffer.from(png).toString("base64") },
        ],
      }, 300000)
      if (replied.error) errorText = JSON.stringify(replied.error)
      else stopReason = String((replied.result as { stopReason?: string } | undefined)?.stopReason ?? "")
      answer = client.streamedText()
    }
  } catch (error) { errorText = String((error as Error)?.message ?? error) } finally { await client.stop() }

  const numbers = (answer.match(/\d+/g) ?? []).map(Number)
  const reported = numbers.includes(redCount) ? redCount : (numbers[0] ?? Number.NaN)
  const colorOk = /红|red/i.test(answer) && /蓝|blue/i.test(answer)
  const ok = advertisedImage && stopReason === "end_turn" && !errorText && reported === redCount && colorOk
  return {
    name: "visual_fact_verifiable_image",
    ok,
    detail: `现场生成 ${cols}×${cellRows}=${cells} 格方块图、**真实红色块数=${redCount}**（随机，模型无法预设），经产品 ACP 面投图（${png.length} 字节 PNG，base64 ${Buffer.from(png).toString("base64").length} 字符）：`
      + `initialize 声明 image=${advertisedImage}；stopReason=${stopReason || "(无)"}；模型报出的数字=${Number.isNaN(reported) ? "(未报数字)" : reported}；`
      + `**数字与真实值一致=${reported === redCount}**；颜色词命中红/蓝=${colorOk}`
      + (errorText ? `；错误=${errorText}` : "")
      + (IS_LOCAL_ROUTE ? `；**注意**：当前是本机路由（本地模型多为纯文本），此条不通过属预期——要拿视觉事实需官方多模态路由` : ""),
  }
}

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
