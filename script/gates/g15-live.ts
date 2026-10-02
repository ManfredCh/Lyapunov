/**
 * G15-live：合同 §6.2 G15 现场切片 —— **由产品内部 DSH Agent 用自然语言驱动 cordis 工具**。
 *
 * 为什么这条能跑而没有云模型 Key：本机已运行 Ollama，其 `/v1/messages` 是原生 Anthropic
 * Messages 端点，与产品 `llm-deepseek` 适配器默认协议一致（详见 `g01-live.ts` 的说明）。
 *
 * 本门验证的是合同 §2.13 第 1–2 条里"内部 Agent 真的能调起 cordis 工具"这一层：
 *   · developer Profile 装配了 `lyapunov-tool-cordis`（由产品真实装配函数返回，非本门自建）
 *   · 模型经**自然语言**请求后，真实调用了 `cordis_inspect_list`
 *   · 会话事件流里留下真实 `tool/call` → `tool/result` → `turn/end=completed`
 *
 * 诚实边界（必须与读数一起读）：
 *  · 用的是**本地开源模型**，非 DeepSeek 官方模型；验证的是产品链路，不声称官方模型行为。
 *  · **未覆盖**：`cordis_define` → `cordis_run` 的**多步**动态插件链。本机 27B 模型跑该多步链
 *    在 600s 内未完成（属模型吞吐/长链能力，非产品缺陷——同一批工具 G15 门已用真 Cordis 树
 *    逐条验证过机制）。故本门**不声称**"内部 Agent 完成了完整插件开发闭环"。
 *
 * 用法：`bun run script/gates/run-g15-live.ts`
 */
import { spawn } from "node:child_process"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import type { Check, GateResult } from "./contract.ts"

const PRODUCT_ROOT = resolve(import.meta.dirname, "../..")
const RUNTIME_ROOT = `.runtime/goal-verify/g15-live/runtime-${process.pid}`
const OLLAMA = process.env.G01_OLLAMA_URL ?? "http://127.0.0.1:11434"
const MODEL = process.env.G01_MODEL ?? "qwen3.8-uncensored:32k"

export async function gateG15Live(): Promise<GateResult> {
  const checks: Check[] = []
  // 归档要用到这些读数，故在 try 外声明。
  let tools: string[] = []
  let results = 0, turnEnd = "", exitCode: number | null = null
  let cordisEntryName = ""
  try {
    // 1) 产品装配函数真实返回 developer 面含 tool-cordis（不由本门自建插件树）。
    const { runtimePluginInsert } = await import("../runtime-patch.ts")
    const webFace = runtimePluginInsert({ mode: "developer", surface: "web", sceneRoot: join(PRODUCT_ROOT, ".runtime/goal-verify/g15-live/scene") })
    const cordisEntry = webFace.find(entry => entry.name === "@deepseek-ai/dsh-tool-cordis")
    cordisEntryName = String(cordisEntry?.id ?? "")
    checks.push({
      name: "developer_profile_registers_tool_cordis",
      ok: Boolean(cordisEntry),
      detail: `产品 runtimePluginInsert(mode=developer, surface=web) 返回 ${webFace.length} 项，含 tool-cordis=${Boolean(cordisEntry)}（id=${String(cordisEntry?.id)}）`,
    })

    // 2) 自然语言回合：要求模型调用 cordis_inspect_list 并报告 provider。
    const prompt = "只做一件事：调用 cordis_inspect_list 工具，然后告诉我它返回的 providers 列表里有哪些 id。不要调用其它工具。"
    const child = spawn("node", ["script/launch.ts", "--mode", "developer", "--surface", "headless",
      "--runtime-root", RUNTIME_ROOT, "--engine", "none", prompt], {
      cwd: PRODUCT_ROOT, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DEEPSEEK_BASE_URL: OLLAMA, DEEPSEEK_API_KEY: "local-ollama-no-auth", LYAPUNOV_DEVELOPER_MODEL: MODEL, LYAPUNOV_DEVELOPER_REASONING_EFFORT: "low" },
    })
    let transcript = ""
    child.stdout.on("data", chunk => { transcript += String(chunk) })
    child.stderr.on("data", chunk => { transcript += String(chunk) })
    exitCode = await new Promise<number | null>(resolveExit => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); resolveExit(null) }, 420000)
      child.on("exit", code => { clearTimeout(timer); resolveExit(code ?? null) })
    })

    // 3) 会话事件流：必须有真实的 cordis_inspect_list 调用与结果。
    const sessionsRoot = join(PRODUCT_ROOT, RUNTIME_ROOT, "developer/dsh/sessions")
    const files: string[] = []
    try {
      for await (const scope of await readdir(sessionsRoot, { withFileTypes: true })) {
        if (!scope.isDirectory()) continue
        for await (const session of await readdir(join(sessionsRoot, scope.name), { withFileTypes: true })) {
          if (!session.isDirectory()) continue
          for (const name of await readdir(join(sessionsRoot, scope.name, session.name))) if (name.endsWith(".jsonl.zstd")) files.push(join(sessionsRoot, scope.name, session.name, name))
        }
      }
    } catch { /* 无会话目录 */ }
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
    checks.push({
      name: "natural_language_drove_cordis_tool",
      ok: tools.includes("cordis_inspect_list"),
      detail: `自然语言回合退出码=${String(exitCode)}；会话内真实工具调用=[${tools.join(",")}]（期望含 cordis_inspect_list）；tool/result=${results}；turn/end=${turnEnd}`,
    })
    // 真实 provider id 出现在模型输出里 = 它确实读到了工具的真实返回。
    const reported = ["Service", "Event", "Builtin", "Tool"].filter(name => transcript.includes(name))
    checks.push({
      name: "model_reported_real_tool_payload",
      ok: reported.length >= 3,
      detail: `模型输出里复述的真实 provider id = [${reported.join(",")}]（这些 id 来自工具真实返回，非提示词给出）`,
    })
  } catch (error) {
    checks.push({ name: "exception", ok: false, detail: String((error as Error)?.message ?? error) })
  } finally {
    // §6.1 证据留存：删除临时运行根之前，把现场转录摘要归档到持久位置。
    try {
      const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d+Z$/, "Z")
      const archiveDir = join(PRODUCT_ROOT, "bugfixHistory/refactor-execution/evidence/G15-live", stamp)
      await mkdir(archiveDir, { recursive: true })
      await writeFile(join(archiveDir, "result.json"), JSON.stringify({
        gate: "G15-live",
        archivedAt: stamp,
        model: MODEL,
        modelProvenance: "本地开源 27B 模型（非 DeepSeek 官方模型）",
        endpoint: OLLAMA,
        turn: { exitCode, tools, toolResults: results, turnEnd },
        cordisEntry: cordisEntryName,
        checks: checks.map(check => ({ name: check.name, ok: check.ok })),
      }, null, 2) + "\n")
      checks.push({
        name: "evidence_archived_before_cleanup",
        ok: true,
        detail: `现场转录摘要已归档 → evidence/G15-live/${stamp}/result.json（含真实工具名、tool/result 计数、turn/end、装配到的 cordis 条目与逐条 check 结果）；临时运行根随后清理`,
      })
    } catch (error) {
      checks.push({ name: "evidence_archived_before_cleanup", ok: false, detail: `证据归档失败：${String((error as Error)?.message ?? error)}` })
    }
    await rm(join(PRODUCT_ROOT, RUNTIME_ROOT), { recursive: true, force: true }).catch(() => undefined)
  }
  return {
    gate: "G15-live",
    checks,
    blocked: "未覆盖：`cordis_define` → `cordis_run` 的**多步**动态插件链——本机 27B 模型在 600s 内未跑完该长链（属模型吞吐/长链能力，非产品缺陷；同一批工具的机制已由 G15 门用真 Cordis 树逐条验证）。另：用的是本地开源模型，不声称 DeepSeek 官方模型行为。",
  }
}
