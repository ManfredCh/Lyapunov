/**
 * `scene_save(portable, projectFiles)` / `scene_open` 在**真实 ToolRegistry**上的接线行为。
 *
 * 不 mock 注册表：Context + dsh-system-prompt + dsh-tools + dsh-session + dsh-commands + lyapunov-scene
 * 都是真的，参数 schema 校验与模型看到的那段 render 文本都发生在真实运行时里；场景与资源同样是真
 * SceneStore / ResourceLibrary（临时 dataRoot、真文件、真 CAS）。**没有改 plugin.ts**：这里验的正是
 * 共享入口对这一新参数已经能收、能转、能给回执。
 *
 * 夹具是测试自己写的最小 GLB，只用于证明"引用随包、重开还在"，不代表真实模型的几何。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Context } from "@deepseek-ai/cordis"
import type { Agent } from "@deepseek-ai/dsh-agent"
import Commands from "@deepseek-ai/dsh-commands"
import { ToolCallId } from "@deepseek-ai/dsh-llm"
import Sessions, { SessionId } from "@deepseek-ai/dsh-session"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import Tools, { type ToolExecutionResult } from "@deepseek-ai/dsh-tools"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import type { SceneSnapshot } from "../../lyapunov-contracts/src/types.ts"
import { localPath } from "../src/formats.ts"
import * as scenePlugin from "../src/plugin.ts"

const signal = new AbortController().signal

let base: string, ctx: Context, agent: Agent, calls = 0

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "lyapunov-save-tool-"))
  calls = 0
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Sessions)
  await ctx.plugin(Commands)
  await ctx.plugin(scenePlugin, { dataRoot: join(base, "catalog") })
  // agent 带上自己的原生会话：场景工具按会话说事（`agent.session.header.id` 就是归属键），
  // 只给一个 id 的替身没有可核实的会话，工具会按 SESSION_SCOPE_UNAVAILABLE 明确失败。
  const session = ctx.sessions.create(SessionId("scene-save-tool"))
  agent = { id: session.id, session } as Agent
})

afterEach(async () => { await rm(base, { recursive: true, force: true }) })

async function callTool(name: string, input: unknown): Promise<ToolExecutionResult> {
  return await ctx.tools.execute({ callId: ToolCallId(`${name}-${++calls}`), name, arguments: { input }, signal, agent })
}
function valueOf(result: ToolExecutionResult): any {
  if (result.isError) throw new Error(`期望成功但工具失败：${result.error.message}`)
  return result.value
}
/** 模型真正看到的那段文本（output.render 的投影）。 */
function textOf(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === "text").map(block => block.text).join("")
}
async function ok(name: string, input: unknown): Promise<any> { return valueOf(await callTool(name, input)) }

/** 最小合法 GLB：只有 JSON chunk（parseAsset 只核对 glTF 2.0 头与 chunk 长度自洽）。 */
function glbBytes(generator: string): Buffer {
  const json = { asset: { version: "2.0", generator }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: generator }], meshes: [{ primitives: [] }] }
  const payload = Buffer.from(JSON.stringify(json), "utf8")
  const chunk = Buffer.concat([payload, Buffer.alloc((4 - payload.length % 4) % 4, 0x20)])
  const header = Buffer.alloc(12), chunkHeader = Buffer.alloc(8), total = 12 + 8 + chunk.length
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8)
  chunkHeader.writeUInt32LE(chunk.length, 0); chunkHeader.writeUInt32LE(0x4e4f534a, 4)
  return Buffer.concat([header, chunkHeader, chunk])
}

describe("scene_save(portable) 的 Tool 接线（真实 ToolRegistry，未改 plugin.ts）", () => {
  test("工具层收下 portable/projectFiles：包落盘、模型回执含随包清单；projectFiles 形状被 schema 真的卡住", async () => {
    const sceneId = "scene_tool_portable"
    await ok("scene_create", { sceneId })
    const glb = join(base, "fixtures", "塔.glb")
    await mkdir(dirname(glb), { recursive: true })
    await writeFile(glb, glbBytes("tool-tower-v1"))
    await ok("scene_import", { path: glb, sceneId, entityId: "tower", resourceId: "res_tower", physicalize: false })
    const script = join(base, "scripts", "build.py")
    await mkdir(dirname(script), { recursive: true })
    await writeFile(script, "print('build')\n")
    const notes = join(base, "notes.md")
    await writeFile(notes, "# 笔记\n")

    const bundle = join(base, "portable", "scene.json")
    const result = await callTool("scene_save", { sceneId, path: bundle, portable: true, projectFiles: [relative(dirname(bundle), script), relative(dirname(bundle), notes)] })
    const value = valueOf(result)
    expect(value.path).toBe(bundle)
    // 两个文件保留彼此的相对层级一起随包（单文件时 common 就是它自己的目录）。
    expect(value.projectFiles).toEqual(["project/notes.md", "project/scripts/build.py"])
    expect(value.packagedFileCount).toBe(3)
    expect(existsSync(join(dirname(bundle), "project", "scripts", "build.py"))).toBe(true)
    // 模型读到的回执里带着随包事实（不是只有 path）。
    const text = textOf(result)
    expect(text).toContain("project/scripts/build.py")
    expect(text).toContain(String(value.packagedFileCount))

    // 参数 schema 是真实的闸门：类型不对、字段不认识的都必须被拒，且不留半个包。
    for (const bad of [{ projectFiles: "scripts/build.py" }, { projectFiles: [1] }, { unknownField: true }]) {
      const rejected = await callTool("scene_save", { sceneId, path: join(base, "rejected", "scene.json"), portable: true, ...bad })
      expect(rejected.isError).toBe(true)
    }
    expect(existsSync(join(base, "rejected"))).toBe(false)
  })

  test("搬到新目录、另一个 catalog 的运行时用 scene_open 工具重开：sceneId/实体不变、引用都在包内", async () => {
    const sceneId = "scene_tool_move"
    await ok("scene_create", { sceneId })
    const glb = join(base, "fixtures", "灯.glb")
    await mkdir(dirname(glb), { recursive: true })
    await writeFile(glb, glbBytes("tool-lamp-v1"))
    await ok("scene_import", { path: glb, sceneId, entityId: "lamp", resourceId: "res_lamp", physicalize: false })
    const authored = join(base, "authored", "scene.json")
    const before: SceneSnapshot = await ok("scene_inspect", { sceneId })
    await ok("scene_save", { sceneId, path: authored, portable: true })
    await rm(join(base, "fixtures"), { recursive: true, force: true })
    const moved = join(base, "moved")
    await rename(dirname(authored), moved)

    const fresh = new Context()
    await fresh.plugin(SystemPrompt)
    await fresh.plugin(Tools)
    await fresh.plugin(Sessions)
    await fresh.plugin(Commands)
    await fresh.plugin(scenePlugin, { dataRoot: join(base, "另一台机器", "catalog") })
    const reopened: SceneSnapshot = valueOf(await fresh.tools.execute({ callId: ToolCallId("open-moved"), name: "scene_open", arguments: { input: { path: join(moved, "scene.json") } }, signal, agent }))
    expect(reopened.sceneId).toBe(sceneId)
    expect(reopened.entities.map(entity => entity.entityId)).toEqual(before.entities.map(entity => entity.entityId))
    for (const entity of reopened.entities) for (const ref of entity.resources) for (const rep of [ref.original, ...ref.representations]) {
      const path = localPath(rep.uri)
      expect(path.startsWith(moved)).toBe(true)
      expect(existsSync(path)).toBe(true)
    }
    // 重开之后包内副本本身没被改写。
    const packaged = (await readFile(join(moved, "scene.json"), "utf8"))
    expect(packaged).not.toContain(base)
  })
})
