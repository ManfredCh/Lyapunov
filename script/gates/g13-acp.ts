/**
 * G13-ACP：合同 §6.2 G13 里 "CLI / MCP / ACP" 的 **ACP 协议面**（本机可验证的切片）。
 *
 * 背景：G13 主体覆盖了 MCP + commands 的真实装配面，但**没有覆盖 ACP**。
 * 而 ACP 面在本机**不需要模型凭据即可验证协议层**——实测 `initialize` 正常应答。
 *
 * 按合同 §6.4 保持薄：只起产品真实入口（`script/launch.ts --surface acp`）、按 ACP 的 stdio
 * JSON-RPC 发帧、核对真实回包。不复制任何协议实现。
 *
 * 诚实边界（**本轮已更新**）：此前写"`session/new` 需要模型 Provider（本机无凭据）"，现在这句话**说大了**——
 * 本机已有合法真实路由（本地 Ollama 的 Anthropic Messages 端点，见 `g01-live.ts`），
 * 而且 `session/new` + `session/resume` + `session/prompt` **已在 `G01LIVE` 里真实跑通**（第二轮回话证明了历史恢复）。
 * 本门**只做协议握手与能力声明**，是为了让"ACP 协议面"与"会话生命周期"各自有独立、可单独复跑的门；
 * 会话生命周期归 `G01LIVE`。退出码语义同 §6.4。
 */
import { spawn } from "node:child_process"
import { join, resolve } from "node:path"

import type { Check, GateResult } from "./contract.ts"

/**
 * DEV-027 F31：`acp_process_exited_cleanly` 的判据必须是"**自己退出的**干净退出码"。
 * 旧判据 `exitCode === 0 || exitCode === null` 把 `null`（=本门超时收尾杀掉）也算通过——
 * 那等于用"被自己杀掉"证明"进程能自行退出"。现收紧为 `=== 0`；`null` 一律不通过
 * （负对照单测见 `g13-acp-exit.test.ts`）。
 *
 * DEV-027 Round 6（⑤）：收紧之后又定位到这条判据**此前根本没被测过**——`acpExchange`
 * 只 write 帧、不 `end()` stdin，子进程 stdin 始终被父进程持有 ⇒ 没有 EOF ⇒ ACP 面持续监听
 * 是正确行为，实测的 `null` 只是本门自己 60s 超时。现补 `child.stdin.end()`：
 * 关 stdin（EOF）⇒ 0.5s 内自行 `exit 0`（原始时间线见 `.runtime/lane-dev027f/acp-exit-probe.log`）。
 */
export const acpExitedCleanly = (exitCode: number | null | undefined): boolean => exitCode === 0

const PRODUCT_ROOT = resolve(import.meta.dirname, "../..")
const RUNTIME_ROOT = `.runtime/goal-verify/g13-acp/runtime-${process.pid}`
const INITIALIZE = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}'

/** 起 ACP 面，发若干帧，收集真实回包（带超时，绝不无限等待）。 */
async function acpExchange(frames: string[], timeoutMs = 60000): Promise<{ replies: Array<Record<string, unknown>>; stderr: string; exitCode: number | null }> {
  const child = spawn("node", ["script/launch.ts", "--mode", "developer", "--surface", "acp", "--runtime-root", RUNTIME_ROOT, "--engine", "none"],
    { cwd: PRODUCT_ROOT, stdio: ["pipe", "pipe", "pipe"] })
  const replies: Array<Record<string, unknown>> = []
  let stdout = "", stderr = ""
  child.stdout.on("data", chunk => {
    stdout += String(chunk)
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("{")) continue
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>
        if (!replies.some(item => JSON.stringify(item) === JSON.stringify(parsed))) replies.push(parsed)
      } catch { /* 非 JSON-RPC 行（启动日志）忽略 */ }
    }
  })
  child.stderr.on("data", chunk => { stderr += String(chunk) })
  for (const frame of frames) child.stdin.write(frame + "\n")
  // DEV-027 Round 6（⑤ 定位）：**必须真的关掉 stdin**。此前这里只 write 不 end，
  // 于是"stdio 关闭后进程退出码"这条判据从来没被真正测过——子进程 stdin 一直被父进程持有，
  // ACP 面保持监听是**正确行为**，本门却等到 60s 超时后自己 SIGTERM 并记 `null`。
  // 实测（`.runtime/lane-dev027f/acp-exit-probe.mjs` / `acp-alive-control.mjs`）：
  //   保持 stdin 打开 20s ⇒ 仍存活（正确）；EOF ⇒ 0.5s 内自行 `exit 0`。
  // 客户端断开在 stdio 协议里就是 EOF，故这里 end() 才等于"关闭 stdio"。
  child.stdin.end()
  const exitCode = await new Promise<number | null>(resolveExit => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolveExit(null) }, timeoutMs)
    child.on("exit", code => { clearTimeout(timer); resolveExit(code ?? null) })
  })
  return { replies, stderr, exitCode }
}

export async function gateG13Acp(): Promise<GateResult> {
  const checks: Check[] = []
  try {
    const { replies, stderr, exitCode } = await acpExchange([INITIALIZE])
    const initialized = replies.find(reply => reply.id === 1) as { result?: { protocolVersion?: number; agentInfo?: { name?: string; version?: string }; agentCapabilities?: Record<string, unknown> } } | undefined
    const capabilities = initialized?.result?.agentCapabilities ?? {}
    checks.push({
      name: "acp_initialize_over_stdio_jsonrpc",
      ok: initialized?.result?.protocolVersion === 1 && Boolean(initialized?.result?.agentInfo?.name),
      detail: `真实 ACP 入口（\`--surface acp\`）应答 initialize：protocolVersion=${String(initialized?.result?.protocolVersion)} agentInfo=${String(initialized?.result?.agentInfo?.name)}@${String(initialized?.result?.agentInfo?.version)}；HTTP 无关，纯 stdio JSON-RPC`,
    })
    checks.push({
      name: "acp_declares_real_capabilities",
      ok: Object.keys(capabilities).length > 0,
      detail: `能力声明（来自产品真实回包，非手写）：${JSON.stringify(capabilities).slice(0, 400)}`,
    })
    // 这条是**协议层的事实**，与模型无关，值得单独记录：ACP 声明的图片提示能力为 false。
    const promptCapabilities = capabilities.promptCapabilities as { image?: boolean } | undefined
    checks.push({
      name: "acp_prompt_capability_is_declared",
      ok: promptCapabilities !== undefined && typeof promptCapabilities.image === "boolean",
      detail: `promptCapabilities=${JSON.stringify(promptCapabilities)}；其中 image=${String(promptCapabilities?.image)}（协议层声明，与模型是否支持视觉无关）`,
    })
    checks.push({
      name: "acp_startup_has_no_credential_error",
      ok: !/MISSING_CREDENTIAL/.test(stderr),
      detail: `启动期 stderr 是否出现 MISSING_CREDENTIAL=${/MISSING_CREDENTIAL/.test(stderr)}（协议握手本身不需要模型凭据）；stderr 尾部=${JSON.stringify(stderr.trim().slice(-200))}`,
    })
    checks.push({
      name: "acp_process_exited_cleanly",
      ok: acpExitedCleanly(exitCode),
      detail: `stdin EOF（=客户端断开）后进程退出码=${String(exitCode)}（判据=**自行退出且为 0**；null=由本门的超时收尾杀掉，**不算自行退出**，本项按未通过计；本项不据此声称会话功能可用）`,
    })
  } catch (error) {
    checks.push({ name: "exception", ok: false, detail: String((error as Error)?.message ?? error) })
  }
  // 未覆盖部分汇入 BLOCKED（与 G12 同一口径：未覆盖不等于失败，也不等于通过）。
  return {
    gate: "G13-ACP",
    checks,
    blocked: "本门**只覆盖 ACP 协议握手与能力声明**（`initialize` 的真实应答与能力字段）；"
      + "会话生命周期（`session/new` → 进程退出 → `session/resume` → 继续对话 → `session/prompt`）**已由 `--gate G01LIVE` 在真实模型上跑通**，不在此门重复。"
      + "本门未覆盖：prompt **取消**（`session/cancel`）与 ACP 客户端文件/终端方法的真实往返。",
  }
}
