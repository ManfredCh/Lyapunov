/**
 * L384：命令面与工具面用**同一条入参校验**。
 *
 * L381 的决定性实验（`bugfixHistory/TOOL-INPUT-VALIDATION-20260922.md`）证到：`required` 的强制力
 * 只住在 `defineTool` 生成的 execute 包装里（上游 `core/tools/src/schema.ts:566-568,585-589`），
 * 派发管线本身不校验；命令桥（`commands.register` 的 handler 直接 `JSON.parse(rawInput)` 后交给
 * operation）完全不在那条链上。于是同一个"缺必填"的调用，工具面得到 `INVALID_ARGS`，命令面把
 * 原生 `TypeError` 漏成 400。
 *
 * 本文件盯的就是这条：`packages/scene-kit/src/plugin.ts` 的 `invoke`（工具与命令**唯一**共用的
 * dispatch）用框架导出的 `validateArgs(spec,args)` 判同一份 `parameters`，非空即抛框架自己的
 * `ToolArgsError`（code `INVALID_ARGS`）——两侧的错误码与错误文本逐字相同。
 *
 * **L391 取消了这里的例外清单**：`scene_open`/`scene_save` 的 `path` 在两面也走同一条
 * `validateArgs`——缺 `path`/非字符串 ⇒ `INVALID_ARGS`；`""`/纯空白这类 schema 表达不了的
 * **值语义**仍由 L379/L380 落地的 `sessionPath` 判，给 `SCENE_PATH_INVALID`（见第 3 组用例）。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Context } from "@deepseek-ai/cordis"
import type { Agent } from "@deepseek-ai/dsh-agent"
import Commands from "@deepseek-ai/dsh-commands"
import { ToolCallId } from "@deepseek-ai/dsh-llm"
import Sessions, { SessionId } from "@deepseek-ai/dsh-session"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import Tools, { type ToolExecutionResult } from "@deepseek-ai/dsh-tools"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as scenePlugin from "../src/plugin.ts"

const SCENE_ID = "lane384-scene"
const signal = new AbortController().signal

let base: string, ctx: Context, agent: Agent

async function composeSession(dataRoot: string): Promise<{ ctx: Context; agent: Agent }> {
  const composed = new Context()
  await composed.plugin(SystemPrompt)
  await composed.plugin(Tools)
  await composed.plugin(Sessions)
  await composed.plugin(Commands)
  await composed.plugin(scenePlugin, { dataRoot })
  const session = composed.sessions.create(SessionId(`scene-args-lane384-${Math.trunc(Date.now() % 1e9)}`), { meta: { cwd: join(base, "workspace") } })
  return { ctx: composed, agent: { id: session.id, session } as Agent }
}

/** 工具面：模型唯一的入参形状是 `{input: …}`（defineTool 校验外层对象）。 */
async function callTool(name: string, input: unknown): Promise<ToolExecutionResult & { error?: { message?: string } }> {
  return await ctx.tools.execute({ callId: ToolCallId(`lane384-${name}`), name, arguments: { input }, signal, agent }) as ToolExecutionResult & { error?: { message?: string } }
}

function textOf(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === "text").map(block => (block as { text: string }).text).join("")
}

/** 工具面那一条错误的**逐字文本**（工具运行时把 message 放在 `error.message`；退化时用回执文本）。 */
const toolErrorText = (result: ToolExecutionResult & { error?: { message?: string } }): string => result.error?.message ?? textOf(result)

/** 命令桥：真机 `POST /api/lyapunov/command` 的同一条（handler 抛错原样上抛）。 */
async function bridge(name: string, input: Record<string, unknown>): Promise<{ kind: string; text: string } | { thrown: { name?: string; code?: string; message: string } }> {
  try {
    const execution = await ctx.commands.execute(agent, `/${name} ${JSON.stringify(input)}`, [], signal)
    if (!execution) return { kind: "unresolved", text: "" }
    const result = execution.result as { kind: string; text?: string }
    return { kind: result.kind, text: result.text ?? "" }
  } catch (error) {
    const thrown = error as { name?: string; code?: string; message: string }
    return { thrown: { name: thrown.name, code: thrown.code, message: thrown.message } }
  }
}

/** 命令桥那一条错误的逐字文本（没抛错就抛测试失败，避免"断言了别的东西"）。 */
function thrownMessage(receipt: Awaited<ReturnType<typeof bridge>>): string {
  if (!("thrown" in receipt)) throw new Error(`期望命令桥抛错，实际 ${receipt.kind}: ${receipt.text}`)
  return receipt.thrown.message
}

const revisionOf = async (sceneId: string): Promise<number> => {
  const receipt = await bridge("scene_inspect", { sceneId })
  if (!("kind" in receipt) || receipt.kind !== "success") throw new Error(`夹具自检失败：${JSON.stringify(receipt)}`)
  return (JSON.parse(receipt.text) as { revision: number }).revision
}

/** 夹具：建场景 + 一个实体（`scene_align`/`scene_save` 的正例都要它）。返回可提交的 revision。 */
async function sceneWithEntity(sceneId: string, entityId: string): Promise<number> {
  const created = await bridge("scene_create", { sceneId })
  expect("kind" in created && created.kind).toBe("success")
  const revision = await revisionOf(sceneId)
  const edited = await bridge("scene_edit", {
    sceneId, expectedRevision: revision,
    patch: [{ op: "add", entity: { entityId, name: "box", transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [], components: {} } }],
  })
  expect("kind" in edited && edited.kind).toBe("success")
  return await revisionOf(sceneId)
}

/** 最小合法 GLB：只有 JSON chunk（与 `scene-replace-tool.test.ts` 同一手法）。 */
function glbBytes(generator: string): Buffer {
  const json = {
    asset: { version: "2.0", generator },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "prop" }],
    meshes: [{ primitives: [] }],
  }
  const payload = Buffer.from(JSON.stringify(json), "utf8")
  const chunk = Buffer.concat([payload, Buffer.alloc((4 - payload.length % 4) % 4, 0x20)])
  const header = Buffer.alloc(12), chunkHeader = Buffer.alloc(8), total = 12 + 8 + chunk.length
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8)
  chunkHeader.writeUInt32LE(chunk.length, 0); chunkHeader.writeUInt32LE(0x4e4f534a, 4)
  return Buffer.concat([header, chunkHeader, chunk])
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "lyapunov-scene-args-lane384-"))
  await mkdir(join(base, "workspace"), { recursive: true })
  const composed = await composeSession(join(base, "data"))
  ctx = composed.ctx
  agent = composed.agent
})

afterEach(async () => {
  await ctx.fiber.dispose().catch(() => undefined)
  await rm(base, { recursive: true, force: true })
})

describe("L384 命令面与工具面同一条入参校验（scene-kit invoke）", () => {
  test('scene_inspect 完整flat/nested输入返回相同Scene，mixed和缺sceneId仍拒绝',async()=>{
    await bridge('scene_create',{sceneId:SCENE_ID})
    const call=async(arguments_:unknown)=>ctx.tools.execute({callId:ToolCallId('shape-inspect'),name:'scene_inspect',arguments:arguments_,signal,agent})
    const flat=await call({sceneId:SCENE_ID}),nested=await call({input:{sceneId:SCENE_ID}})
    expect(flat.isError).toBe(false);expect(nested.isError).toBe(false);expect(flat.value).toEqual(nested.value)
    expect((await call({input:{sceneId:SCENE_ID},sceneId:'other'})).isError).toBe(true)
    expect((await call({})).isError).toBe(true)
    expect((await call({sceneId:SCENE_ID,unknown:'extra'})).isError).toBe(true)
    const other=ctx.sessions.create(SessionId('shape-isolated'),{meta:{cwd:join(base,'workspace')}})
    const foreign=await ctx.tools.execute({callId:ToolCallId('shape-foreign'),name:'scene_inspect',arguments:{sceneId:SCENE_ID},signal,agent:{id:other.id,session:other} as Agent})
    expect(foreign.isError).toBe(true)
  })
  test("零参数工具的模型合法空对象进入实际SDK与命令桥，不制造input:undefined", async () => {
    for (const name of ["scene_list", "asset_missing", "asset_missing_rescan", "asset_authority_snapshot"]) {
      const call = await ctx.tools.execute({ callId: ToolCallId(`noarg-${name}`), name, arguments: {}, signal, agent })
      expect(call.isError).toBe(false)
      const command = await bridge(name, {})
      expect("kind" in command && command.kind).toBe("success")
    }
  })
  test("scene_align 缺必填：命令面与工具面逐字同形，且不再是原生 TypeError", async () => {
    const toolEmpty = await callTool("scene_align", {})
    expect(toolEmpty.isError).toBe(true)
    expect(toolErrorText(toolEmpty)).toContain('invalid arguments: missing required property "input.sceneId"')
    expect(toolErrorText(toolEmpty)).toContain('missing required property "input.sourcePoints"')
    expect(toolErrorText(toolEmpty)).toContain('missing required property "input.targetPoints"')
    expect(toolErrorText(toolEmpty)).not.toContain("is not an object")

    const commandEmpty = await bridge("scene_align", {})
    expect("thrown" in commandEmpty).toBe(true)
    if (!("thrown" in commandEmpty)) throw new Error("unreachable")
    expect(commandEmpty.thrown.name).toBe("ToolArgsError")
    expect(commandEmpty.thrown.code).toBe("INVALID_ARGS")
    // 逐字同形：命令面 message === 工具面 message（工具面只多工具运行时加的 `Error: ` 前缀）。
    expect(commandEmpty.thrown.message).toBe(toolErrorText(toolEmpty))
    // 负对照硬要求：消息里不得出现任何路径分隔符。
    expect(commandEmpty.thrown.message).not.toContain("/")

    const partial = { sceneId: SCENE_ID, entityId: "e384", expectedRevision: 0 }
    const toolPartial = await callTool("scene_align", partial)
    expect(toolErrorText(toolPartial)).toBe('invalid arguments: missing required property "input.sourcePoints"; missing required property "input.targetPoints"')
    expect(thrownMessage(await bridge("scene_align", partial))).toBe(toolErrorText(toolPartial))
  })

  test("scene_import 缺 path / path 非字符串：命令面同样被 schema 拦（与工具面逐字相同）", async () => {
    const toolMissing = await callTool("scene_import", { sceneId: "s" })
    const missing = toolErrorText(toolMissing)
    expect(missing).toBe('invalid arguments: missing required property "input.path"')
    expect(thrownMessage(await bridge("scene_import", { sceneId: "s" }))).toBe(missing)

    const toolNumber = await callTool("scene_import", { path: 42 })
    const number = toolErrorText(toolNumber)
    expect(number).toBe('invalid arguments: "input.path" must be a string')
    const bridgedNumber = await bridge("scene_import", { path: 42 })
    expect(thrownMessage(bridgedNumber)).toBe(number)
    // 修前这一条命令面漏的是 `TypeError: undefined is not an object (evaluating 'uri.startsWith')`。
    expect(thrownMessage(bridgedNumber)).not.toContain("uri.startsWith")
    expect(thrownMessage(bridgedNumber)).not.toContain("/")
  })

  test("统一判据（L391 取消例外）：scene_open/scene_save 的 path 缺/非字符串走框架 INVALID_ARGS，值语义仍由 sessionPath 判", async () => {
    // 命令面：缺 path/非字符串与工具面**同一条**判据（框架 ToolArgsError/INVALID_ARGS）。
    const missing = await bridge("scene_open", { sceneId: SCENE_ID })
    if (!("thrown" in missing)) throw new Error(`期望抛错，实际 ${JSON.stringify(missing)}`)
    expect(missing.thrown.name).toBe("ToolArgsError")
    expect(missing.thrown.code).toBe("INVALID_ARGS")
    expect(missing.thrown.message).toContain('missing required property "input.path"')
    expect(missing.thrown.message).not.toContain("/")
    // `""`/纯空白是 schema 表达不了的**值语义**，仍由 sessionPath 给 `SCENE_PATH_INVALID`。
    for (const [input, expected] of [
      [{ path: 7 }, 'invalid arguments: "input.path" must be a string'],
      [{}, 'invalid arguments: missing required property "input.path"'],
      [{ path: "" }, "SCENE_PATH_INVALID"],
      [{ path: "   " }, "SCENE_PATH_INVALID"],
    ] as Array<[Record<string, unknown>, string]>) {
      const receipt = await bridge("scene_open", input)
      if (!("thrown" in receipt)) throw new Error(`期望抛错，实际 ${JSON.stringify(receipt)}`)
      expect(receipt.thrown.message).toContain(expected)
      expect(receipt.thrown.message).not.toContain("/")
    }
    // 工具面（模型直呼）与命令面现在是同一条判据、同一段文本。
    expect(toolErrorText(await callTool("scene_open", { sceneId: SCENE_ID }))).toBe('invalid arguments: missing required property "input.path"')
  })

  test("正例：scene_align 工具面与命令面各自成功，结果一致", async () => {
    // 两条面各用一套全新的场景（同一份入参、同一起点），结果必须逐字相同。
    const points = { sourcePoints: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], targetPoints: [[0, 1, 0], [0, 0, 0], [1, 0, 0]] }
    const toolRevision = await sceneWithEntity("lane384-align-tool", "e384")
    const commandRevision = await sceneWithEntity("lane384-align-cmd", "e384")

    const tool = await callTool("scene_align", { sceneId: "lane384-align-tool", entityId: "e384", expectedRevision: toolRevision, ...points })
    expect(tool.isError).toBe(false)
    const toolSnapshot = JSON.parse(textOf(tool)) as { revision: number; entities: Array<{ entityId: string; transform: { quaternion: number[] } }> }
    expect(toolSnapshot.revision).toBe(toolRevision + 1)

    const bridged = await bridge("scene_align", { sceneId: "lane384-align-cmd", entityId: "e384", expectedRevision: commandRevision, ...points })
    if (!("kind" in bridged)) throw new Error(`命令面不该抛错：${JSON.stringify(bridged)}`)
    expect(bridged.kind).toBe("success")
    const commandSnapshot = JSON.parse(bridged.text) as { revision: number; entities: Array<{ entityId: string; transform: { quaternion: number[] } }> }
    expect(commandSnapshot.revision).toBe(commandRevision + 1)
    // 同一个操作、同一份入参：两条面给出同一份位姿（90° 绕 Z）。
    expect(commandSnapshot.entities.find(entity => entity.entityId === "e384")!.transform.quaternion)
      .toEqual(toolSnapshot.entities.find(entity => entity.entityId === "e384")!.transform.quaternion)
  })

  test("正例：scene_import 工具面与命令面各自成功（最小 GLB，physicalize:false）", async () => {
    await sceneWithEntity(SCENE_ID, "e384")
    await writeFile(join(base, "workspace", "prop.glb"), glbBytes("lane384-args"))
    // 第二份字节不同（内容寻址下才是另一个资源），两条面各自导入自己的那份。
    await writeFile(join(base, "workspace", "prop-cmd.glb"), glbBytes("lane384-args-bridge"))
    const path = join(base, "workspace", "prop.glb")

    const tool = await callTool("scene_import", { path, sceneId: SCENE_ID, resourceId: "res384-tool", name: "prop-tool", physicalize: false })
    expect(tool.isError).toBe(false)
    const toolValue = JSON.parse(textOf(tool)) as { resource: { ref: { resourceId: string } }; snapshot: { revision: number } }
    expect(toolValue.resource.ref.resourceId).toBe("res384-tool")

    const bridged = await bridge("scene_import", { path: join(base, "workspace", "prop-cmd.glb"), sceneId: SCENE_ID, resourceId: "res384-cmd", name: "prop-cmd", physicalize: false })
    if (!("kind" in bridged)) throw new Error(`命令面不该抛错：${JSON.stringify(bridged)}`)
    expect(bridged.kind).toBe("success")
    const commandValue = JSON.parse(bridged.text) as { resource: { ref: { resourceId: string } }; snapshot: { revision: number } }
    expect(commandValue.resource.ref.resourceId).toBe("res384-cmd")
    expect(commandValue.snapshot.revision).toBeGreaterThan(toolValue.snapshot.revision)
  })

  test("其它合法命令零变化：没有参数的读命令与带 sceneId 的读命令照旧成功", async () => {
    const revision = await sceneWithEntity(SCENE_ID, "e384")
    expect(revision).toBeGreaterThan(0)
    for (const [name, input] of [["scene_list", {}], ["asset_authority_snapshot", {}], ["scene_history", { sceneId: SCENE_ID }], ["asset_missing", {}]] as Array<[string, Record<string, unknown>]>) {
      const receipt = await bridge(name, input)
      if (!("kind" in receipt)) throw new Error(`/${name} 不该抛错：${JSON.stringify(receipt)}`)
      expect(receipt.kind).toBe("success")
    }
  })
})
