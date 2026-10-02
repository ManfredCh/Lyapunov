/**
 * L380（scene-kit 那一半）：命令桥 `scene_open`/`scene_save` 收到**缺失/非字符串/空白** `path` 时，
 * 回执必须是结构化错误 `SCENE_PATH_INVALID`，不能是 `isAbsolute(undefined)` 的原生 TypeError。
 *
 * 真机证据（.runtime/lane-dev003c/iso-B.js:18 → lib.mjs:6 的 `cmdExpr`，真机 CU 双会话会话 B）：
 * `POST /api/lyapunov/command {sessionId, name:'scene_open', input:{sceneId:'l375-a-scene'}}` 回
 * `400 {"error":"The \"path\" argument must be of type string. Received undefined"}`。
 * 为什么工具 schema 挡不住：命令桥走 `commands.register` 的 handler，直接把 `rawInput` 解析后交给
 * operation（plugin.ts 的 invoke），**不过** `ctx.tools.execute` 的 schema 校验；所以同一个错误调用
 * 经工具面被 schema 挡（`invalid arguments: missing required property "input.path"`，本次未改），
 * 经命令桥就漏到 `sessionPath`。本文件只盯后者。
 *
 * 不改的东西：`path` 仍是必填（schema 原样）、成功路径与既有错误语义（SCENE_ALREADY_EXISTS /
 * SCENE_CWD_UNRESOLVED）原样。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Context } from "@deepseek-ai/cordis"
import type { Agent } from "@deepseek-ai/dsh-agent"
import Commands from "@deepseek-ai/dsh-commands"
import { ToolCallId } from "@deepseek-ai/dsh-llm"
import Sessions, { SessionId } from "@deepseek-ai/dsh-session"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import Tools, { type ToolExecutionResult } from "@deepseek-ai/dsh-tools"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as scenePlugin from "../src/plugin.ts"

const SCENE_ID = "lane380-scene"
const signal = new AbortController().signal

let base: string, ctx: Context, agent: Agent

async function composeSession(dataRoot: string): Promise<{ ctx: Context; agent: Agent }> {
  const composed = new Context()
  await composed.plugin(SystemPrompt)
  await composed.plugin(Tools)
  await composed.plugin(Sessions)
  await composed.plugin(Commands)
  await composed.plugin(scenePlugin, { dataRoot })
  const session = composed.sessions.create(SessionId(`scene-path-invalid-${Math.trunc(Date.now() % 1e9)}`), { meta: { cwd: join(base, "workspace") } })
  return { ctx: composed, agent: { id: session.id, session } as Agent }
}

/** 命令桥这一次调用的**完整回执文本**；抛出去的错误文本也照原样收口（真机 body.error 就是它）。 */
async function bridge(name: string, input: Record<string, unknown>): Promise<string> {
  try {
    const execution = await ctx.commands.execute(agent, `/${name} ${JSON.stringify(input)}`, [], signal)
    if (!execution) return "<没有解析成功>"
    const result = execution.result as { kind: string; text?: string }
    return `${result.kind}: ${result.text ?? ""}`
  } catch (error) {
    return `thrown ${(error as { name?: string }).name}: ${(error as Error).message}`
  }
}

function textOf(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === "text").map(block => (block as { text: string }).text).join("")
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "lyapunov-scene-path-invalid-"))
  await mkdir(join(base, "workspace"), { recursive: true })
  const composed = await composeSession(join(base, "data"))
  ctx = composed.ctx
  agent = composed.agent
})

afterEach(async () => {
  await ctx.fiber.dispose().catch(() => undefined)
  await rm(base, { recursive: true, force: true })
})

describe("命令桥 scene_open / scene_save：path 缺失或类型不对 → 结构化 SCENE_PATH_INVALID", () => {
  test("真机同形：scene_open 只给 sceneId（缺必填 path）不再漏原生 TypeError", async () => {
    const receipt = await bridge("scene_open", { sceneId: SCENE_ID })
    expect(receipt).toContain("invalid arguments: ")
    expect(receipt).toContain("path")
    expect(receipt).not.toContain("argument must be of type string")
    expect(receipt).not.toContain("Received undefined")
    // 负对照硬要求：消息里不得出现任何文件系统路径分隔符。
    expect(receipt).not.toContain("/")
  })

  test("scene_save 缺 path、scene_open 给数字/空串/纯空白：同样结构化、同样不带 `/`", async () => {
    for (const [name, input] of [
      ["scene_save", { sceneId: SCENE_ID }],
      ["scene_open", { path: 7 }],
      ["scene_open", { path: "" }],
      ["scene_open", { path: "   " }],
      ["scene_open", {}],
    ] as Array<[string, Record<string, unknown>]>) {
      const receipt = await bridge(name, input)
      expect(receipt).toContain(typeof input.path === "string" && input.path.trim() === "" ? "SCENE_PATH_INVALID" : "invalid arguments: ")
      expect(receipt).not.toContain("argument must be of type string")
      expect(receipt).not.toContain("/")
    }
  })

  test("失败是**零写入**：错误回执之后场景目录里没有生成任何文件", async () => {
    await bridge("scene_open", { sceneId: SCENE_ID })
    await bridge("scene_save", { path: "" })
    const dataRoot = join(base, "data")
    const worlds = join(dataRoot, "worlds", "sessions")
    const entries = await readdir(worlds, { withFileTypes: true }).catch(() => [])
    expect(entries.flatMap(entry => entry.name)).toEqual([])
  })

  test("工具面零变化：path 仍必填，schema 自己先挡（本次没动 schema 必填性）", async () => {
    const result = await ctx.tools.execute({ callId: ToolCallId("lane380-tool-open"), name: "scene_open", arguments: { input: { sceneId: SCENE_ID } }, signal, agent })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('invalid arguments: missing required property "input.path"')
  })

  test("既有语义零变化：绝对/相对成功路径照旧（同一条命令桥）", async () => {
    const document = join(base, "workspace", "world", "scene.json")
    await mkdir(join(base, "workspace", "world"), { recursive: true })
    await writeFile(document, JSON.stringify({ sceneId: SCENE_ID, revision: 0, coordinates: { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" }, entities: [] }), "utf8")

    // 正例（既有行为）：相对路径按会话工作区解析。
    const opened = await bridge("scene_open", { path: join("world", "scene.json"), sceneId: SCENE_ID })
    expect(opened).toContain("success")
    expect(opened).toContain(SCENE_ID)

    // 绝对路径原样可用。
    const absolute = await bridge("scene_open", { path: document, sceneId: SCENE_ID })
    expect(absolute).toContain("success")
  })
})
