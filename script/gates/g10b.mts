/**
 * G10b：经**真实 DSH 工具注册表**调用产品的 `blender_run` 工具体（合同 §6.2 G10 的
 * "内部工具调用真实 Blender"那一条的完整形态）。
 *
 * 为什么单独一个门：G10 主体为了让门在 bun 下可跑，按产品工具**同一 argv** 直调了
 * `world.py`，并未经过 `ctx.tools`。本门补上那一步。
 *
 * 为什么必须在 **node** 下跑：本仓 `@deepseek-ai/dsh-subprocess-local` 静态
 * `import { getSystemErrorMessage } from 'node:util'`，而 bun 1.3.13 的 `node:util`
 * 没有该导出（实测 node 有 / bun 无），故 bun 下该包加载即失败。
 * 产品真实路径本身用 node 启动 DSH 主机（`script/launch.ts:27` 的 `spawn("node", …)`），
 * 所以这不是产品缺陷；本门即按产品同一运行器执行。
 *
 * 按 §6.4 保持薄：本文件只做"装配 → 调工具 → 核对产物"，不复制任何 Blender 逻辑。
 *
 * 本门另外会 spawn 一个 **bun** 子探针 `script/gates/blender-mcp-live.ts`（Blender MCP 基本能力的现场验证：
 * 真 Blender GUI + 上游 stdio 服务 + 真工具往返）——**跑门时必须让 bun 在 PATH 上**，
 * 与 G19 同一约束：`export PATH="$HOME/.bun/bin:$PATH"`。缺图形会话时该条按 `contract/` 前缀报 UNCOVERED。
 *
 * 用法：`PATH="$HOME/.bun/bin:$PATH" node script/gates/run-g10b.mts`
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// 仅用于**类型**位置：Context 的运行时值走函数内动态 import（静态 import 会在 bun 解析
// 模块图时被求值并触发 node:util 缺导出）；`import type` 编译期擦除，不产生运行时求值。
import type { Context } from "@deepseek-ai/cordis"
import type { Agent } from "@deepseek-ai/dsh-agent"
import type { SessionId } from "@deepseek-ai/dsh-session/types"

import type { Check, GateResult } from "./contract.ts"

const PRODUCT_ROOT = resolve(import.meta.dirname, "../..")
const BLENDER = process.env.BLENDER_EXECUTABLE ?? "/snap/blender/current/blender"

export async function gateG10b(): Promise<GateResult> {
  const checks: Check[] = []
  let directory = ""
  // 全部经动态 import：静态 import 会在 bun 解析模块图时就被求值并触发 node:util 缺导出的失败，
  // 而本门在 bun 下应当"明确不可用"而不是把整个薄入口带崩。
  const { Context } = await import("@deepseek-ai/cordis")
  const { default: Timer } = await import("@deepseek-ai/cordis-plugin-timer")
  const { default: SystemPrompt } = await import("@deepseek-ai/dsh-system-prompt")
  const { default: ToolRegistry } = await import("@deepseek-ai/dsh-tools")
  const { default: SubprocessLocal } = await import("@deepseek-ai/dsh-subprocess-local")
  const { default: JobsLocal } = await import("@deepseek-ai/dsh-jobs-local")
  const { ToolCallId } = await import("@deepseek-ai/dsh-llm")
  const ctx = new Context()
  try {
    // 装配序列与已验证可用的 G15 门一致（Timer → SystemPrompt → ToolRegistry …）：
    // dsh-tools 的 ToolRuntime 声明 `inject: ["systemPrompt"]`，缺它时工具服务不会真正就绪。
    await ctx.plugin(Timer)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(SubprocessLocal)
    await ctx.plugin(JobsLocal)
    checks.push({ name: "runner_supports_dsh_subprocess_local", ok: true, detail: `运行器=${process.release?.name ?? "node"} ${process.version}；dsh-subprocess-local / dsh-jobs-local / dsh-tools 均已真实装配` })

    // 装配产品自带插件（用构建产物，与产品运行一致）。
    const pluginEntry = join(PRODUCT_ROOT, "packages/blender/dist/plugin.js")
    if (!existsSync(pluginEntry)) return { gate: "G10b", checks, blocked: `产品插件构建产物不存在：${pluginEntry}（先运行 bun run build:plugins）` }
    const blenderPlugin = await import(pluginEntry) as { name?: string; inject?: string[]; apply?: (ctx: Context, config: unknown) => void; default?: { apply?: (ctx: Context, config: unknown) => void } }
    const apply = blenderPlugin.apply ?? blenderPlugin.default?.apply
    if (!apply) return { gate: "G10b", checks, blocked: `${pluginEntry} 未导出 apply（形态与产品装配不符）` }
    // inject 必须由**外层**包装声明：cordis 靠它等待 tools/subprocess/jobs 就绪后才调用 apply。
    // 直接把 inject 挂在动态插件对象上不会让本层 ctx 具备这些服务（实测报 "Cannot read properties of undefined (reading 'schemas')"）。
    const inject = blenderPlugin.inject ?? ["tools", "subprocess", "jobs"]
    await ctx.plugin({ name: "g10b-blender-wrapper", inject, apply: (scoped: Context) => apply(scoped, { executable: BLENDER, workspace: PRODUCT_ROOT }) } as never, undefined as never)

    // cordis 的服务访问器（ctx.tools）只在**当前插件声明 inject 时**才被定义；
    // 脚本主体没有 inject，故按服务名取用（ctx.get 始终可用，实测 ctx.tools 为 undefined）。
    const tools = ctx.get("tools") as { schemas(): Array<{ name: string }>; execute(input: unknown): Promise<unknown> }

    const names = tools.schemas().map(schema => schema.name)
    checks.push({ name: "blender_run_registered_in_real_registry", ok: names.includes("blender_run"), detail: `真实 ToolRegistry 内工具=${names.length}，含 blender_run=${names.includes("blender_run")}` })

    directory = await mkdtemp(join(tmpdir(), "lyaup-g10b-"))
    const output = join(directory, "blender-world")
    const agent = { id: "g10b-agent" as SessionId, steer() { }, inject() { }, session: { header: { cwd: PRODUCT_ROOT } } } as unknown as Agent
    const result = await tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId("g10b-1"),
      name: "blender_run",
      arguments: { output_directory: output, fixture: true },
      agent,
    }) 
    const failedCall = (result as { isError?: boolean }).isError === true
    const text = failedCall ? "" : String((result as { value?: { result?: string } }).value?.result ?? "")
    checks.push({ name: "blender_run_tool_call_succeeded", ok: !failedCall && text.length > 0, detail: `isError=${String((result as { isError?: boolean }).isError)} 结果前缀已由产品工具自己剥离（长度=${text.length}）` })

    let parsed: { entities?: number; visuals?: number; physics?: string } = {}
    try { parsed = JSON.parse(text) as typeof parsed } catch { /* 记为解析失败 */ }
    // 产品的真实结果形状是**计数**（entities/visuals 为数），不是实体数组——按真实形状判，不按我以为的形状判。
    checks.push({ name: "tool_result_is_structured_scene", ok: typeof parsed.entities === "number" && typeof parsed.visuals === "number", detail: `结果可解析=${typeof parsed.entities === "number"} entities=${String(parsed.entities)} visuals=${String(parsed.visuals)} physics=${String(parsed.physics)}` })

    const files = {
      sourceBlend: join(output, "source.blend"),
      sceneJson: join(output, "scene.json"),
      doorPhysics: join(output, "physics/door.xml"),
    }
    const present = Object.entries(files).filter(([, path]) => existsSync(path)).map(([name]) => name)
    checks.push({ name: "tool_produced_real_artifacts", ok: present.length === Object.keys(files).length, detail: `产物存在=${present.join(",")}` })

    // 活动门：物理表示里必须是铰链 articulation，而不是被并进单一凸包。
    let doorXml = ""
    try { doorXml = await readFile(files.doorPhysics, "utf8") } catch { /* 记为缺失 */ }
    const hasHinge = /<joint[^>]*type="hinge"/.test(doorXml)
    checks.push({ name: "door_physics_is_hinge_articulation", ok: hasHinge, detail: `physics/door.xml 含 hinge joint=${hasHinge} 字节=${doorXml.length}` })

    // ── Blender MCP 作为**产品基本能力**：真起 GUI host + 上游 stdio 服务 + 真工具往返 ──────
    // 单独成驱动（`script/gates/blender-mcp-live.ts`，bun）的理由：它要起真 Blender **GUI**
    // （MCP 需要 GUI 主事件循环，产品脚本显式拒绝 `--background`）与上游 stdio 进程，
    // 与本门的 Cordis 树运行条件完全不同。本门只负责调它、读它的结论。
    const mcpRun = await runProbe(["bun", "run", join(PRODUCT_ROOT, "script/gates/blender-mcp-live.ts")], 420_000)
    const mcpLines = mcpRun.stdout.split("\n").filter(line => /^(PASS|FAIL)\s+BlenderMCP\//.test(line))
    if (mcpRun.code === 2) {
      // 环境缺失（无图形会话 / 无 Blender 可执行文件）：按本仓既有约定用 `contract/` 前缀 + ok:true
      // 报 UNCOVERED——既不算通过也不算失败，薄入口会单独成类、不参与退出码分子。
      checks.push({
        name: "contract/blender_mcp_live_environment",
        ok: true,
        detail: `UNCOVERED：本环境起不了 Blender GUI（MCP 需要 GUI 主事件循环，缺 DISPLAY 或 Blender 可执行文件），`
          + `**不代表通过**；MCP 依赖供给本身仍由 doctor:blender-mcp 单独可查。stderr 尾部=${mcpRun.stderr.slice(-200) || "空"}`,
      })
    } else {
      checks.push({
        name: "blender_mcp_is_a_working_baseline_capability",
        ok: mcpRun.code === 0 && mcpLines.length > 0,
        detail: mcpLines.length
          ? `${mcpLines.length} 条实测读数：${mcpLines.map(line => line.replace(/^(PASS|FAIL)\s+BlenderMCP\//, "")).join(" ｜ ")}`
          : `MCP 现场驱动没有给出读数（退出码=${mcpRun.code}）：stdout 尾部=${mcpRun.stdout.slice(-400)} stderr 尾部=${mcpRun.stderr.slice(-400)}`,
      })
    }
  } catch (error) {
    checks.push({ name: "exception", ok: false, detail: String((error as Error)?.message ?? error) })
  } finally {
    // §6.1「每个验收必须留下什么」：临时目录一删，行为证据就只剩回执文本。覆盖审计（DEV-027 F29）
    // 点名 G10b 是**唯一只剩裸 rm、零归档**的门（G10 已先归档 manifest、G11LIVE/G15LIVE 已归档转录摘要）。
    // 这里在**删除之前**归档产物清单（相对路径/字节/sha256）与逐条 check 结果；只存清单与哈希，
    // 不搬 .blend 与场景大件进仓库。
    if (directory) {
      try {
        const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d+Z$/, "Z")
        const archiveDir = join(PRODUCT_ROOT, "bugfixHistory/refactor-execution/evidence/G10b", stamp)
        await mkdir(archiveDir, { recursive: true })
        const files = await listFiles(directory).catch(() => [] as string[])
        const entries: Array<{ relative: string; bytes: number; sha256: string }> = []
        for (const relative of files) {
          const absolute = join(directory, relative)
          try {
            const info = await stat(absolute)
            if (!info.isFile()) continue
            const digest = createHash("sha256").update(await readFile(absolute)).digest("hex")
            entries.push({ relative, bytes: info.size, sha256: digest })
          } catch { /* 竞态：跳过 */ }
        }
        await writeFile(join(archiveDir, "manifest.json"), JSON.stringify({
          gate: "G10b",
          archivedAt: stamp,
          sourceDirectory: "<mkdtemp 已清理>",
          fileCount: entries.length,
          totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
          files: entries,
          checks: checks.map(check => ({ name: check.name, ok: check.ok })),
        }, null, 2) + "\n")
        checks.push({
          name: "evidence_archived_before_cleanup",
          ok: entries.length > 0,
          detail: `产物清单已归档：${entries.length} 个文件 / 共 ${entries.reduce((sum, entry) => sum + entry.bytes, 0)} 字节 → evidence/G10b/${stamp}/manifest.json（含逐文件 sha256）；临时目录随后清理`,
        })
      } catch (error) {
        checks.push({ name: "evidence_archived_before_cleanup", ok: false, detail: `产物归档失败：${String((error as Error)?.message ?? error)}` })
      }
      await rm(directory, { recursive: true, force: true })
    }
    try { await ctx.fiber.dispose() } catch { /* 树销毁失败不影响已记录读数 */ }
  }
  return { gate: "G10b", checks, blocked: null }
}

/** 递归列出目录下所有文件（相对路径，排序稳定）；与 G10 的同类 helper 同形，保持两门的归档口径一致。 */
async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const next = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await listFiles(root, next))
    else files.push(next)
  }
  return files.sort()
}

/** 跑一个子探针并收集输出；用于把运行条件不同的现场验证隔到独立进程里。 */
async function runProbe(argv: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise(resolveProbe => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: PRODUCT_ROOT, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    child.stdout.on("data", chunk => { stdout += String(chunk) })
    child.stderr.on("data", chunk => { stderr += String(chunk) })
    const timer = setTimeout(() => { child.kill("SIGTERM") }, timeoutMs)
    child.on("exit", code => { clearTimeout(timer); resolveProbe({ code: code ?? 1, stdout, stderr }) })
    child.on("error", error => { clearTimeout(timer); resolveProbe({ code: 127, stdout, stderr: stderr + String(error) }) })
  })
}
