/**
 * G1：材质/贴图事实进入收件元数据（`parsed.metadata.materials`），供"材质整理"核对。
 *
 * 修前 `scene_import`/`asset_list` 的 `parsed.metadata` 只有 `{aabb, meshCount, nodes, scene, scenes}`，
 * 材质/贴图读数只在获取链出现（asset-acquisition 的 modelFacts），"材质整理→原生收件"在回执里不可核。
 *
 * 两个夹具：
 * ① ENV-19 真机样本 `Dev/.runtime/lane-env19/out/model.glb`（**只读复用**，1,062,928 B /
 *    sha256 `be27e29052cac9bb…`）：材质 **1** 条 `tripo_material_b47949d7-d5b3-45d3-82d0-df51d5d537b7`、
 *    贴图 **3** 张（baseColor=texture0、metallicRoughness=texture1、normal=texture2，image 名
 *    Color_/ORM_/NormalGL_…、均 image/jpeg）——断言名字与贴图槽位**如实**进元数据；
 * ② 测试自己拼的最小 glTF 2.0 二进制：无材质 GLB ⇒ `materials` 为空数组、不崩、不编造；
 *    有材质无贴图/槽位指空 ⇒ 只记真实存在的槽位，无名材质不带 `name` 字段。
 *
 * 收件面（④）走**真实 ToolRegistry 派发** `scene_import`：断言落在回执 `resource.parsed.metadata` 上，
 * 不是只在解析函数里成立。样本不在盘上时①/④跳过（与 hdri-payload 真件复核同一做法），其余用例照常。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Context } from "@deepseek-ai/cordis"
import type { Agent } from "@deepseek-ai/dsh-agent"
import Commands from "@deepseek-ai/dsh-commands"
import { ToolCallId } from "@deepseek-ai/dsh-llm"
import Sessions, { SessionId } from "@deepseek-ai/dsh-session"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import Tools from "@deepseek-ai/dsh-tools"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseAsset, type GlbMaterialFact } from "../src/formats.ts"
import * as scenePlugin from "../src/plugin.ts"

/** ENV-19 真机样本（只读复用；lane 回执 `Dev/bugfixHistory/ENV19-TRIPO-IMAGE23D-20260922.md` 记录了它的读数）。 */
const SAMPLE = "/home/s18/WS/Lyapunov/Dev/.runtime/lane-env19/out/model.glb"

/** 最小合法 GLB：只有 JSON chunk（parseAsset 只核对 glTF 2.0 头与 chunk 长度自洽），不带 materials。 */
function glbOf(json: Record<string, unknown>): Buffer {
  const payload = Buffer.from(JSON.stringify({ asset: { version: "2.0", generator: "glb-material-facts.test" }, ...json }), "utf8")
  const chunk = Buffer.concat([payload, Buffer.alloc((4 - payload.length % 4) % 4, 0x20)])
  const header = Buffer.alloc(12), chunkHeader = Buffer.alloc(8), total = 12 + 8 + chunk.length
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8)
  chunkHeader.writeUInt32LE(chunk.length, 0); chunkHeader.writeUInt32LE(0x4e4f534a, 4)
  return Buffer.concat([header, chunkHeader, chunk])
}

const fixture = async (base: string, name: string, json: Record<string, unknown>): Promise<string> => {
  const path = join(base, name)
  await writeFile(path, glbOf(json))
  return path
}

const materialsOf = (parsed: { metadata: Record<string, unknown> }): GlbMaterialFact[] => parsed.metadata.materials as GlbMaterialFact[]

describe("GLB 材质事实进收件元数据", () => {
  let base: string
  beforeEach(async () => { base = await mkdtemp(join(tmpdir(), "lyapunov-glb-material-")) })
  afterEach(async () => { await rm(base, { recursive: true, force: true }) })

  test("① 真机样本：1 材质 / 3 贴图，名字与贴图槽位如实进 parsed.metadata.materials", async () => {
    if (!existsSync(SAMPLE)) { console.log("跳过：lane 真件不在盘上", SAMPLE); return }
    const parsed = await parseAsset(SAMPLE)
    const materials = materialsOf(parsed)
    expect(materials).toHaveLength(1)
    // 名字与贴图槽位逐字节如实：材质名、槽位名、texture/image 索引、image 名与 mimeType 全来自 glTF 原文。
    expect(materials[0]).toEqual({
      baseColorFactor: [1,1,1,1], metallicFactor: 1, roughnessFactor: 1,
      name: "tripo_material_b47949d7-d5b3-45d3-82d0-df51d5d537b7",
      textures: {
        baseColor: { index: 0, source: 0, name: "Color_b47949d7-d5b3-45d3-82d0-df51d5d537b7", mimeType: "image/jpeg" },
        metallicRoughness: { index: 1, source: 1, name: "ORM_b47949d7-d5b3-45d3-82d0-df51d5d537b7", mimeType: "image/jpeg" },
        normal: { index: 2, source: 2, name: "NormalGL_b47949d7-d5b3-45d3-82d0-df51d5d537b7", mimeType: "image/jpeg" },
      },
    })
    const slots = Object.values(materials[0]!.textures)
    expect(slots).toHaveLength(3)                                                  // 贴图 3 张
    expect(new Set(slots.map(slot => slot.index)).size).toBe(3)                    // 三个不同贴图（texture0/1/2）
    expect(slots.map(slot => slot.mimeType)).toEqual(["image/jpeg", "image/jpeg", "image/jpeg"])  // JPEG×3
    // 既有字段不受影响（只加字段）。
    expect(parsed.metadata.meshCount).toBe(1)
    expect(parsed.metadata.aabb).toBeDefined()
  })

  test("② 无材质 GLB：materials 空数组、不崩、不编造", async () => {
    const parsed = await parseAsset(await fixture(base, "bare.glb", { scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: "空件" }], meshes: [{ primitives: [] }] }))
    expect(parsed.kind).toBe("mesh")
    expect(materialsOf(parsed)).toEqual([])
  })

  test("③ 有材质：只记真实存在的槽位/名字，指空的槽位只留索引，不补不猜", async () => {
    const parsed = await parseAsset(await fixture(base, "partial.glb", {
      scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [] }],
      materials: [
        { name: "夹具材质", pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [1, 1, 1, 1] } },
        { pbrMetallicRoughness: { roughnessFactor: 1 }, normalTexture: { index: 5, scale: 2 } },
      ],
      textures: [{ source: 0 }],
      images: [{ name: "albedo", mimeType: "image/png", bufferView: 0 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
      buffers: [{ byteLength: 4 }],
    }))
    const materials = materialsOf(parsed)
    expect(materials).toHaveLength(2)
    // 只有 baseColor 一个槽位：不因为 pbr 里有 baseColorFactor 就编出 baseColor 贴图，也不补 metallicRoughness/normal。
    expect(materials[0]).toEqual({ name: "夹具材质", baseColorFactor:[1,1,1,1], textures: { baseColor: { index: 0, source: 0, name: "albedo", mimeType: "image/png" } } })
    // 第二个材质：glTF 里没名字就不给 name 字段；normalTexture 指向不存在的 texture 表条目 ⇒ 只留它自己的索引读数。
    expect(materials[1]).toEqual({ roughnessFactor:1, textures: { normal: { index: 5 } } })
    expect(Object.hasOwn(materials[1]!, "name")).toBe(false)
  })

  test("④ scene_import 真实派发回执：resource.parsed.metadata.materials 在回执里可核", async () => {
    if (!existsSync(SAMPLE)) { console.log("跳过：lane 真件不在盘上", SAMPLE); return }
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(Sessions)
    await ctx.plugin(Commands)
    await ctx.plugin(scenePlugin, { dataRoot: join(base, "data") })
    const session = ctx.sessions.create(SessionId("glb-material-facts"))
    const agent = { id: session.id, session } as Agent
    const result = await ctx.tools.execute({ callId: ToolCallId("scene-import-materials"), name: "scene_import", arguments: { input: { path: SAMPLE, name: "tripo", physicalize: false } }, signal: new AbortController().signal, agent })
    if (result.isError) throw new Error(`期望成功但工具失败：${result.error.message}`)
    // 回执（模型/调用方真正看到的那一份）里就能核材质事实，不必另跑解析器。
    expect(materialsOf((result.value as { resource: { parsed: { metadata: Record<string, unknown> } } }).resource.parsed)).toEqual(materialsOf(await parseAsset(SAMPLE)))
  })
})
