/**
 * ENV-29 第二层接线测试：`scene_replace_resource` 在**真实 ToolRegistry / CommandRegistry**上的行为。
 *
 * 不 mock 注册表：Context + dsh-system-prompt + dsh-tools + dsh-session + dsh-commands + lyapunov-scene
 * 都是真的，参数 schema 校验、输出 schema 校验、`command/run`-`command/done` 记账都发生在真实运行时里；
 * 场景与资源同样是真 SceneStore / ResourceLibrary（临时 dataRoot、真文件、真 CAS）。夹具是测试自己写的
 * 最小 GLB（只有 JSON chunk），只用于证明「引用被换掉 / 该拒的拒 / 其它一切不变」，不代表真实模型的几何或渲染。
 *
 * 本文件只覆盖 Tool 与 Command 两层的行为，不重复 operations 层的拒绝矩阵（那在 replace-resource.test.ts）。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Context } from "@deepseek-ai/cordis"
import type { Agent } from "@deepseek-ai/dsh-agent"
import Commands from "@deepseek-ai/dsh-commands"
import { ToolCallId } from "@deepseek-ai/dsh-llm"
import Sessions, { SessionId } from "@deepseek-ai/dsh-session"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import Tools, { type ToolExecutionResult } from "@deepseek-ai/dsh-tools"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Entity, SceneSnapshot } from "../../lyapunov-contracts/src/types.ts"
import { identityTransform } from "../../lyapunov-contracts/src/types.ts"
import * as scenePlugin from "../src/plugin.ts"
import { box, solidGlb, split } from "./glb-geometry-fixture.ts"

const TOOL = "scene_replace_resource"
const signal = new AbortController().signal

let base: string, dataRoot: string, fixtures: string, ctx: Context, agent: Agent, calls = 0
const sessionKey = "scene-replace-tool"

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "lyapunov-scene-tool-"))
  dataRoot = join(base, "data")
  fixtures = join(base, "fixtures")
  await mkdir(fixtures, { recursive: true })
  calls = 0
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Sessions)
  await ctx.plugin(Commands)
  await ctx.plugin(scenePlugin, { dataRoot })
  // 真实会话：命令运行时把 command/run、command/done 记在 agent.session 上。
  const session = ctx.sessions.create(SessionId(sessionKey))
  agent = { id: session.id, session } as Agent
})

afterEach(async () => { await rm(base, { recursive: true, force: true }) })

/** 真实 ToolRegistry 调用：参数按 schema 的 input 包装（与模型调用同一形状）。 */
async function callTool(name: string, input: unknown): Promise<ToolExecutionResult> {
  return await ctx.tools.execute({ callId: ToolCallId(`${name}-${++calls}`), name, arguments: { input }, signal, agent })
}

function valueOf(result: ToolExecutionResult): any {
  if (result.isError) throw new Error(`期望成功但工具失败：${result.error.message}`)
  return result.value
}

function failureOf(result: ToolExecutionResult): ToolExecutionResult & { isError: true } {
  if (!result.isError) throw new Error("期望失败但工具成功了")
  return result
}

/** 模型真正看到的那段文本（output.render 的投影）。 */
function textOf(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === "text").map(block => block.text).join("")
}

async function ok(name: string, input: unknown): Promise<any> {
  return valueOf(await callTool(name, input))
}

/** 与 lyapunov-shell HTTP 桥完全相同的调用行：`/${name} ${JSON.stringify(input)}`。 */
async function bridge(name: string, input: unknown) {
  return await ctx.commands.execute(agent, `/${name} ${JSON.stringify(input ?? {})}`, [], signal)
}

function snapshot(sceneId: string): Promise<SceneSnapshot> {
  // 场景按**测试会话**取（与工具/命令同一条会话规则）：ctx.scene 是 Host 级 facade，
  // 直接问它要快照已经不是公开取法了。
  return ctx.scene.forSession(sessionKey).scene.snapshot(sceneId)
}

function entityOf(value: SceneSnapshot, entityId: string): Entity {
  const entity = value.entities.find(item => item.entityId === entityId)
  if (!entity) throw new Error(`夹具缺少实体 ${entityId}`)
  return entity
}

/** 组根及其 `${groupId}:*` 派生节点以外的全部实体（用于核对"其它实例逐字不变"）。 */
function outsideGroup(value: SceneSnapshot, groupId: string): Entity[] {
  return value.entities.filter(item => item.entityId !== groupId && !item.entityId.startsWith(`${groupId}:`))
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}

/** 最小合法 GLB：只有 JSON chunk（parseAsset 只核对 glTF 2.0 头与 chunk 长度自洽）。 */
function glbBytes(options: { nodes: Array<Record<string, unknown>>; generator: string }): Buffer {
  const json = {
    asset: { version: "2.0", generator: options.generator },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: options.nodes,
    meshes: options.nodes.map(() => ({ primitives: [] })),
  }
  const payload = Buffer.from(JSON.stringify(json), "utf8")
  const chunk = Buffer.concat([payload, Buffer.alloc((4 - payload.length % 4) % 4, 0x20)])
  const header = Buffer.alloc(12), chunkHeader = Buffer.alloc(8), total = 12 + 8 + chunk.length
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8)
  chunkHeader.writeUInt32LE(chunk.length, 0); chunkHeader.writeUInt32LE(0x4e4f534a, 4)
  return Buffer.concat([header, chunkHeader, chunk])
}

/** 同一节点结构、不同字节的两个版本（内容去重不会把 v2 当成 v1）。 */
const treeV1 = () => glbBytes({ generator: "tool-tree-v1", nodes: [{ name: "树干", children: [1] }, { name: "树冠" }] })
const treeV2 = () => glbBytes({ generator: "tool-tree-v2", nodes: [{ name: "树干", children: [1] }, { name: "树冠" }] })

async function fixture(name: string, content: Buffer): Promise<string> {
  const path = join(fixtures, name)
  await writeFile(path, content)
  return path
}

/** 场景 + 一个无关父实体（site），返回空场景之后的最新 revision。 */
async function sceneWithSite(sceneId: string): Promise<void> {
  await ok("scene_create", { sceneId })
  await ok("scene_edit", {
    sceneId, expectedRevision: 0,
    patch: [{ op: "add", entity: { entityId: "site", name: "场地", transform: identityTransform(), resources: [], components: { annotation: { note: "无关实体" } } } }],
  })
}

/** 组根与它 `${root}:*` 命名空间下的全部派生节点（`source`/`node:N` 由导入布局决定，不写死）。 */
const groupIds = (value: SceneSnapshot, root: string): string[] =>
  value.entities.map(item => item.entityId).filter(entityId => entityId === root || entityId.startsWith(`${root}:`))

describe("scene_replace_resource 的 Tool 接线（真实 ToolRegistry）", () => {
  test("共同物理更新穿过真实Tool/Command，固定/解固定同CAS且拒坏参数",async()=>{
    await ok("scene_create",{sceneId:"physics"})
    await ok("scene_edit",{sceneId:"physics",expectedRevision:0,patch:[{op:"add",entity:{entityId:"object",name:"物体",transform:identityTransform(),resources:[],components:{collision:{shape:"box",halfExtents:[.1,.2,.3]},rigidBody:{type:"dynamic",massKg:2}}}}]})
    const fixed=await ok("scene_physics_update",{sceneId:"physics",entityId:"object",expectedRevision:1,type:"static",gravityEnabled:false,collisionEnabled:false})
    expect(fixed.snapshot.revision).toBe(2);expect(fixed.snapshot.entities[0].components.rigidBody.type).toBe("static")
    await bridge("scene_physics_update",{sceneId:"physics",entityId:"object",expectedRevision:2,type:"dynamic"})
    expect((await snapshot("physics")).entities[0]!.components.rigidBody?.type).toBe("dynamic")
    expect(failureOf(await callTool("scene_physics_update",{sceneId:"physics",entityId:"object",expectedRevision:3,type:"fixed"})).error.message).toContain("type")
  })
  test("正例：纯视觉 GLB 组整体换版；原始副本、位姿/父子/用户组件与无关实体都不变", async () => {
    const sceneId = "scene_tool_ok"
    await sceneWithSite(sceneId)
    const v1Path = await fixture("tool-tree-v1.glb", treeV1())
    const v2Path = await fixture("tool-tree-v2.glb", treeV2())
    await ok("scene_import", { path: v1Path, sceneId, resourceId: "res_tree", entityId: "tree-1", name: "树", physicalize: false, components: { annotation: { note: "保留我" } } })
    await ok("scene_import", { path: v2Path, resourceId: "res_tree", physicalize: false })
    const before = await snapshot(sceneId)
    const v1Hash = await sha256(v1Path), v2Hash = await sha256(v2Path)
    const target = entityOf(before, "tree-1")
    // 组内真正承载引用的实体（`:source` 节点是空的坐标声明节点，没有引用可换）。
    const carriers = groupIds(before, "tree-1").filter(id => entityOf(before, id).resources.length > 0)
    const carriersUnchanged = groupIds(before, "tree-1").filter(id => !carriers.includes(id))
    expect(carriers).toContain("tree-1")
    expect(carriers.length).toBeGreaterThan(1)
    expect(carriersUnchanged).toEqual(["tree-1:source"])

    const result = await callTool(TOOL, { sceneId, entityId: "tree-1", expectedRevision: before.revision, resourceId: "res_tree", version: 2 })
    const value = valueOf(result)

    // 返回值描述的是"这次替换"：哪条引用换到了哪条，换了哪些实体，场景新 revision。
    expect(value.changed).toBe(true)
    expect(value.revision).toBe(before.revision + 1)
    expect([...value.entityIds].sort()).toEqual([...carriers].sort())
    expect(value.from).toMatchObject({ resourceId: "res_tree", version: 1 })
    expect(value.to).toMatchObject({ resourceId: "res_tree", version: 2 })
    // 模型看到的是替换结果本身（含 changed/from/to/warnings）加上投影后的场景摘要 snapshot。
    const text = textOf(result)
    const shown = JSON.parse(text)
    expect(shown).toMatchObject({ changed: true, from: { resourceId: "res_tree", version: 1 }, to: { resourceId: "res_tree", version: 2 }, warnings: [] })
    expect(shown.snapshot).toMatchObject({ kind: "scene-summary", sceneId, revision: before.revision + 1, entityCount: before.entities.length })
    // 摘要里的实体引用已经指向新版本，模型不必再 scene_inspect 一次才知道换没换成。
    expect(JSON.stringify(shown.snapshot.entities)).toContain('"version":2')

    // 文档结果：只有本组的引用换了版本，身份/位姿/父子/用户组件与无关实体逐字不变。
    const after = await snapshot(sceneId)
    expect(after.entities.map(item => item.entityId)).toEqual(before.entities.map(item => item.entityId))
    expect(after.entities.map(item => item.parentId)).toEqual(before.entities.map(item => item.parentId))
    const replaced = entityOf(after, "tree-1")
    expect({ ...replaced, resources: [] }).toEqual({ ...target, resources: [] })
    expect(replaced.resources).toEqual([expect.objectContaining({ resourceId: "res_tree", version: 2 })])
    for (const id of carriers) {
      expect(entityOf(after, id).resources).toEqual([expect.objectContaining({ resourceId: "res_tree", version: 2 })])
    }
    // 组内没有引用的坐标声明节点（`:source`）连 transform 一起逐字不变。
    for (const id of carriersUnchanged) expect(entityOf(after, id)).toEqual(entityOf(before, id))
    expect(entityOf(after, "site")).toEqual(entityOf(before, "site"))
    // 原始副本（两个版本的夹具文件）字节不变；旧版本仍可核对。
    expect(await sha256(v1Path)).toBe(v1Hash)
    expect(await sha256(v2Path)).toBe(v2Hash)
    expect(await ok("asset_verify", { resourceId: "res_tree", version: 1 })).toMatchObject({ valid: true })
    expect(await ok("asset_verify", { resourceId: "res_tree", version: 2 })).toMatchObject({ valid: true })
    // 资源库里两个版本都还在（v1 没有被替换动作清掉或改写）。
    const versions = await ok("asset_list", { allVersions: true })
    const treeVersions = versions.filter((record: any) => record.ref.resourceId === "res_tree").map((record: any) => record.ref.version).sort()
    expect(treeVersions).toEqual([1, 2])
  })

  test("共享同一资源的多个实例：只改目标实例，平级与嵌套实例逐字不变", async () => {
    const sceneId = "scene_tool_instances"
    await sceneWithSite(sceneId)
    const v1Path = await fixture("tool-tree-v1.glb", treeV1())
    const v2Path = await fixture("tool-tree-v2.glb", treeV2())
    await ok("scene_import", { path: v1Path, sceneId, resourceId: "res_tree", entityId: "tree-a", name: "树A", physicalize: false })
    await ok("scene_mount", { sceneId, resourceId: "res_tree", version: 1, entityId: "tree-b" })
    await ok("scene_mount", { sceneId, resourceId: "res_tree", version: 1, entityId: "tree-c", parentId: "tree-a" })
    await ok("scene_import", { path: v2Path, resourceId: "res_tree", physicalize: false })
    const before = await snapshot(sceneId)

    const value = await ok(TOOL, { sceneId, entityId: "tree-a", expectedRevision: before.revision, resourceId: "res_tree", version: 2 })

    const after = await snapshot(sceneId)
    const carriers = groupIds(before, "tree-a").filter(id => entityOf(before, id).resources.length > 0)
    expect([...value.entityIds].sort()).toEqual([...carriers].sort())
    // 被替换的组：整组引用指向新版本。
    for (const id of carriers) {
      expect(entityOf(after, id).resources).toEqual([expect.objectContaining({ resourceId: "res_tree", version: 2 })])
    }
    // 同一资源@1 的其它实例（平级 tree-b、挂在被替换组根下面的 tree-c）连派生节点一起原样保留。
    expect(outsideGroup(after, "tree-a")).toEqual(outsideGroup(before, "tree-a"))
    expect(entityOf(after, "tree-b").resources[0]).toMatchObject({ resourceId: "res_tree", version: 1 })
    expect(entityOf(after, "tree-c").resources[0]).toMatchObject({ resourceId: "res_tree", version: 1 })
    expect(JSON.stringify(value.warnings)).toContain("tree-b")
  })

  test("旧 revision：Tool 结果 isError（场景已是版本 N，请求基于 M），场景零写入", async () => {
    const sceneId = "scene_tool_stale"
    await sceneWithSite(sceneId)
    const v1Path = await fixture("tool-tree-v1.glb", treeV1())
    const v2Path = await fixture("tool-tree-v2.glb", treeV2())
    await ok("scene_import", { path: v1Path, sceneId, resourceId: "res_tree", entityId: "tree-1", name: "树", physicalize: false })
    await ok("scene_import", { path: v2Path, resourceId: "res_tree", physicalize: false })
    const observed = await snapshot(sceneId)
    // 先做一次真实替换把 revision 推进，手里这个 observed.revision 就过期了。
    await ok(TOOL, { sceneId, entityId: "tree-1", expectedRevision: observed.revision, resourceId: "res_tree", version: 2 })
    const current = await snapshot(sceneId)
    expect(current.revision).toBeGreaterThan(observed.revision)

    const stale = await callTool(TOOL, { sceneId, entityId: "tree-1", expectedRevision: observed.revision, resourceId: "res_tree", version: 1 })
    // SceneConflict 是普通 Error（非 HarnessError），工具层只有它的原始文案：当下版本与请求基准都写清了。
    expect(failureOf(stale).error.message).toContain(`已是版本 ${current.revision}，请求基于 ${observed.revision}`)
    // 过期写入没有落地：仍是并发后的当前版本，引用仍是刚换上的 v2。
    expect(await snapshot(sceneId)).toEqual(current)
  })

  test("带 collision/rigidBody 的实体换材质版本：主入口直接成功，派生组件与用户批注都保留", async () => {
    const sceneId = "scene_tool_physical"
    await sceneWithSite(sceneId)
    const solid = box(1)
    const collision = { shape: "convex_hull", frame: "mujoco-z-up-meters", boundSize: [1, 1, 1] }
    const rigidBody = { mass: 2 }
    // v1/v2 是同一份几何的两次导出（v2 只是改了材质，网格被拆成两个 primitive）。
    const v1Path = await fixture("tool-box-v1.glb", solidGlb({ generator: "tool-box-v1", nodes: [{ name: "箱体", mesh: solid }] }))
    const v2Path = await fixture("tool-box-v2.glb", solidGlb({ generator: "tool-box-v2", nodes: [{ name: "箱体", mesh: split(solid, 2) }] }))
    const components = { collision, rigidBody, annotation: { note: "保留我" } }
    await ok("scene_import", { path: v1Path, sceneId, resourceId: "res_box", entityId: "box-1", name: "箱", physicalize: false, components })
    // 目标版本带同一份派生默认（真实物理化/挂载路径写的 componentDefaults）。
    await ok("scene_import", { path: v2Path, resourceId: "res_box", physicalize: false, components: { collision, rigidBody } })
    const before = await snapshot(sceneId)
    const carriers = groupIds(before, "box-1").filter(id => entityOf(before, id).resources.length > 0)

    const result = await callTool(TOOL, { sceneId, entityId: "box-1", expectedRevision: before.revision, resourceId: "res_box", version: 2 })
    const value = valueOf(result)

    expect(value.changed).toBe(true)
    expect([...value.entityIds].sort()).toEqual([...carriers].sort())
    expect(value.geometry).toMatchObject({ status: "identical", nodes: 1, vertices: 8, triangles: 12 })
    expect(value.physics).toMatchObject({ mode: "kept", components: ["collision", "rigidBody"] })
    // 模型看到的文本里就有这次替换的几何依据与物理处置，不必再自己推断。
    const shown = JSON.parse(textOf(result))
    expect(shown).toMatchObject({ changed: true, warnings: [], geometry: { status: "identical" }, physics: { mode: "kept" } })
    expect(JSON.stringify(shown.snapshot.entities)).toContain('"version":2')

    const after = await snapshot(sceneId)
    const entity = entityOf(after, "box-1")
    expect(entity.resources).toEqual([expect.objectContaining({ resourceId: "res_box", version: 2 })])
    // 引用换了，身份/位姿/父子/派生组件/用户批注一个都没动。
    expect(entity.components).toEqual(entityOf(before, "box-1").components)
    expect({ ...entity, resources: [] }).toEqual({ ...entityOf(before, "box-1"), resources: [] })
    expect(entityOf(after, "site")).toEqual(entityOf(before, "site"))
  })

  test("带 collision/rigidBody 但几何读不出（无网格节点）：Tool 结果 isError（GEOMETRY_UNVERIFIABLE），场景零写入", async () => {
    const sceneId = "scene_tool_unverifiable"
    await sceneWithSite(sceneId)
    const v1Path = await fixture("tool-tree-v1.glb", treeV1())
    const v2Path = await fixture("tool-tree-v2.glb", treeV2())
    await ok("scene_import", { path: v1Path, sceneId, resourceId: "res_tree", entityId: "tree-1", name: "树", physicalize: false, components: { collision: { shape: "convex_hull" }, rigidBody: { mass: 1 } } })
    await ok("scene_import", { path: v2Path, resourceId: "res_tree", physicalize: false })
    const before = await snapshot(sceneId)

    const rejected = await callTool(TOOL, { sceneId, entityId: "tree-1", expectedRevision: before.revision, resourceId: "res_tree", version: 2 })

    const message = failureOf(rejected).error.message
    expect(message).toContain("REPLACE_RESOURCE_GEOMETRY_UNVERIFIABLE")
    expect(message).toContain("GEOMETRY_NO_MESH_NODE")
    expect(message).toContain("collision")
    expect(message).toContain("rigidBody")
    expect(message).toContain("重建挂载")
    expect(await snapshot(sceneId)).toEqual(before)
  })

  test("多引用实体：fromResourceId/fromVersion 缺席时报歧义，给出后只换那一条（参数确实送达 operation）", async () => {
    const sceneId = "scene_tool_multi_ref"
    await sceneWithSite(sceneId)
    const a1 = await fixture("street-a.splat", Buffer.alloc(32, 1))
    const b1 = await fixture("street-b.splat", Buffer.alloc(32, 2))
    const a2 = await fixture("street-a2.splat", Buffer.alloc(32, 3))
    const refA = (await ok("scene_import", { path: a1, resourceId: "res_a", physicalize: false })).resource.ref
    const refB = (await ok("scene_import", { path: b1, resourceId: "res_b", physicalize: false })).resource.ref
    await ok("scene_import", { path: a2, resourceId: "res_a", physicalize: false })
    await ok("scene_edit", { sceneId, expectedRevision: 1, patch: [
      { op: "add", entity: { entityId: "multi-1", name: "多引用", transform: identityTransform(), resources: [refA, refB], components: { annotation: { note: "多引用实体" } } } },
      { op: "add", entity: { entityId: "other-1", name: "独立引用", transform: identityTransform(), resources: [refA], components: {} } },
    ] })
    const before = await snapshot(sceneId)

    // 两条不同引用、没给 from*：不能替模型猜，明确报歧义。
    const ambiguous = failureOf(await callTool(TOOL, { sceneId, entityId: "multi-1", expectedRevision: before.revision, resourceId: "res_a", version: 2 }))
    expect(ambiguous.error.message).toContain("REPLACE_RESOURCE_TARGET_REQUIRED")

    const value = await ok(TOOL, { sceneId, entityId: "multi-1", expectedRevision: before.revision, resourceId: "res_a", version: 2, fromResourceId: "res_a", fromVersion: 1 })
    const after = await snapshot(sceneId)
    const multi = entityOf(after, "multi-1")
    expect(value.entityIds).toEqual(["multi-1"])
    expect(multi.resources.map(ref => `${ref.resourceId}@${ref.version}`)).toEqual(["res_a@2", "res_b@1"])
    expect(multi.components).toEqual({ annotation: { note: "多引用实体" } })
    // 别的实体引用同一条 res_a@1 时不会被"顺手"升级，且如实报出来。
    expect(entityOf(after, "other-1").resources.map(ref => `${ref.resourceId}@${ref.version}`)).toEqual(["res_a@1"])
    expect(JSON.stringify(value.warnings)).toContain("REPLACE_RESOURCE_OTHER_REFERENCES_UNCHANGED")
    expect(JSON.stringify(value.warnings)).toContain("other-1")
  })

  test("模板错误不被 mock 掩盖：字段类型错、拼错字段名都由真实 schema 在 operation 之前挡下", async () => {
    const sceneId = "scene_tool_schema"
    await sceneWithSite(sceneId)
    const v1Path = await fixture("tool-tree-v1.glb", treeV1())
    await ok("scene_import", { path: v1Path, sceneId, resourceId: "res_tree", entityId: "tree-1", name: "树", physicalize: false })
    const before = await snapshot(sceneId)

    // 1) 类型错：resourceId 必须是字符串。
    const wrongType = failureOf(await callTool(TOOL, { sceneId, entityId: "tree-1", expectedRevision: before.revision, resourceId: 42, version: 2 }))
    expect(wrongType.error.message).toContain("invalid arguments")
    expect(wrongType.error.message).toContain("resourceId")
    expect((wrongType.error as { info?: { code?: string } }).info?.code).toBe("INVALID_ARGS")

    // 2) 拼错字段名：expectedRevision 缺失 + additionalProperties:false 拒绝多出来的键。
    const typo = failureOf(await callTool(TOOL, { sceneId, entityId: "tree-1", expectedrevision: before.revision, resourceId: "res_tree", version: 2 }))
    expect(typo.error.message).toContain("expectedRevision")
    expect(typo.error.message).toContain("expectedrevision")

    expect(await snapshot(sceneId)).toEqual(before)
  })
})

describe("scene_replace_resource 的 Command 接线（真实 CommandRegistry）", () => {
  test("Command 与 Tool 共用同一份定义：/scene_replace_resource 走真实注册表完成替换并记账", async () => {
    const sceneId = "scene_command_ok"
    await sceneWithSite(sceneId)
    const v1Path = await fixture("tool-tree-v1.glb", treeV1())
    const v2Path = await fixture("tool-tree-v2.glb", treeV2())
    await ok("scene_import", { path: v1Path, sceneId, resourceId: "res_tree", entityId: "tree-1", name: "树", physicalize: false })
    await ok("scene_import", { path: v2Path, resourceId: "res_tree", physicalize: false })
    const before = await snapshot(sceneId)
    const carriers = groupIds(before, "tree-1").filter(id => entityOf(before, id).resources.length > 0)

    // 两个注册表里是同一份定义（同一 description、同一个 operations.replaceResource 出口）。
    const tool = ctx.tools.get(TOOL, agent)
    const command = ctx.commands.find(agent, TOOL)
    expect(tool?.description).toBe(command?.description)
    expect(command?.description).toContain("rebuild with scene_mount")

    const execution = await bridge(TOOL, { sceneId, entityId: "tree-1", expectedRevision: before.revision, resourceId: "res_tree", version: 2 })
    expect(execution).toBeDefined()
    expect(execution!.result.kind).toBe("success")
    const reported = JSON.parse(execution!.result.text!)
    expect(reported.changed).toBe(true)
    expect(reported.revision).toBe(before.revision + 1)
    expect([...reported.entityIds].sort()).toEqual([...carriers].sort())
    expect(reported.to).toMatchObject({ resourceId: "res_tree", version: 2 })
    // 命令路径与工具路径落到同一个 CAS：文档确实换了版本。
    const after = await snapshot(sceneId)
    expect(after.revision).toBe(before.revision + 1)
    for (const id of carriers) expect(entityOf(after, id).resources).toEqual([expect.objectContaining({ resourceId: "res_tree", version: 2 })])

    // 生命周期记账：真实会话里成对的 command/run + command/done(success)。
    const lifecycle = agent.session.snapshotEvents().filter(event => event.type === "command/run" || event.type === "command/done")
    expect(lifecycle.map(event => event.type)).toEqual(["command/run", "command/done"])
    expect(lifecycle[1]!.data).toMatchObject({ kind: "success" })
  })

  test("Command 拒绝路径：过期 revision 与坏模板都抛错，不静默成功、不写场景", async () => {
    const sceneId = "scene_command_reject"
    await sceneWithSite(sceneId)
    const v1Path = await fixture("tool-tree-v1.glb", treeV1())
    const v2Path = await fixture("tool-tree-v2.glb", treeV2())
    await ok("scene_import", { path: v1Path, sceneId, resourceId: "res_tree", entityId: "tree-1", name: "树", physicalize: false })
    await ok("scene_import", { path: v2Path, resourceId: "res_tree", physicalize: false })
    const observed = await snapshot(sceneId)
    await ok(TOOL, { sceneId, entityId: "tree-1", expectedRevision: observed.revision, resourceId: "res_tree", version: 2 })
    const current = await snapshot(sceneId)

    await expect(bridge(TOOL, { sceneId, entityId: "tree-1", expectedRevision: observed.revision, resourceId: "res_tree", version: 1 })).rejects.toThrow(new RegExp(`已是版本 ${current.revision}，请求基于 ${observed.revision}`))
    await expect(ctx.commands.execute(agent, `/${TOOL} {不是 JSON`, [], signal)).rejects.toThrow()
    expect(await snapshot(sceneId)).toEqual(current)
    // 失败也结算成 command/done error，不留下悬挂的 command/run。
    const done = agent.session.snapshotEvents().filter(event => event.type === "command/done")
    expect(done.length).toBeGreaterThan(0)
    expect(done.every(event => (event.data as { kind?: string }).kind === "error")).toBe(true)
  })

  test("HTTP 桥白名单核对：lyapunov-shell 的 scene_ 前缀白名单放行 scene_replace_resource 且命令可解析", async () => {
    // 白名单在 packages/lyapunov-shell/src/plugin.ts 的 command 桥里内联，只能按源码核对（只读）。
    const source = await readFile(join(import.meta.dirname, "../../lyapunov-shell/src/plugin.ts"), "utf8")
    const line = source.split("\n").find(item => item.includes("UNKNOWN_DOMAIN_COMMAND") && item.includes("test(name)"))
    expect(line).toBeDefined()
    const pattern = /\/\^\(([^)]*)\)\//.exec(line!)
    expect(pattern).toBeDefined()
    const whitelist = new RegExp(`^(${pattern![1]})`)
    expect(whitelist.test(TOOL)).toBe(true)
    // 前缀锚定：不是域名前缀的名字不会被放行（这条白名单是真的在做判断，不是恒真）。
    expect(whitelist.test("scene")).toBe(false)
    expect(whitelist.test("x_scene_replace_resource")).toBe(false)

    // 桥在放行后就是 `/${name} ${JSON.stringify(input)}` 这一行，且把 undefined 结果当成 COMMAND_UNAVAILABLE。
    const sceneId = "scene_command_bridge"
    await sceneWithSite(sceneId)
    const v1Path = await fixture("tool-tree-v1.glb", treeV1())
    const v2Path = await fixture("tool-tree-v2.glb", treeV2())
    await ok("scene_import", { path: v1Path, sceneId, resourceId: "res_tree", entityId: "tree-1", name: "树", physicalize: false })
    await ok("scene_import", { path: v2Path, resourceId: "res_tree", physicalize: false })
    const before = await snapshot(sceneId)
    const execution = await bridge(TOOL, { sceneId, entityId: "tree-1", expectedRevision: before.revision, resourceId: "res_tree", version: 2 })
    expect(execution).toBeDefined()
    expect(execution!.result.kind).toBe("success")
  })
})
