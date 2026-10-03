/**
 * ENV-24 导出侧：**UV / PBR / 文字曲线 / 共享资产**的真实导出 + **独立解码回验**。
 *
 * 入口必须是 node（bun 1.3.13 下 `dsh-subprocess-local` 加载不了）：
 *   BLENDER_EXECUTABLE=<blender> node --experimental-transform-types --test packages/blender/test/export-uv-pbr.test.ts
 * 没装 Blender 就整组 skip（不静默当通过）。
 *
 * 判据分两层，都用**真事实**：
 *   · 导出层：经真实 ToolRegistry 调 `blender_run`（world.py 真导出 GLB/scene.json/source.blend）；
 *   · 回读层：本文件自带的 GLB 解析器（读 JSON chunk + BIN chunk + accessor 字节）独立解码导出物，
 *     不复用导出器任何代码——断言 TEXCOORD_0 存在且**非退化**、PBR 通道与贴图引用、贴图**真的随
 *     导出物存在**（embedded bufferView 字节 + PNG 魔数）、文字/曲线**明确被转换**（convertedFrom +
 *     派生网格顶点数）、**共享资产只导出一次**（两个实体引用同一 resourceId@version）。
 *   · 负对照：同一场景只去掉 UV 层 → 回读必须看到 TEXCOORD_0 **缺失**（判定不是恒真），
 *     并且资源回执里必须出现"有贴图但没 UV"的损失说明（world.py 的最小修复）。
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/plugin.ts'

const BLENDER = process.env.BLENDER_EXECUTABLE ?? 'blender'
const blenderWorks = (() => {
  const probe = spawnSync(BLENDER, ['--version'], { encoding: 'utf8', timeout: 60_000 })
  return probe.status === 0
})()

/** 真实 PNG 写盘（不引第三方库）：4×4 逐像素 + zlib deflate + CRC32，文件名与内容都不撒谎。 */
function pngBytes(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (buffer: Buffer) => {
    let c = 0xffffffff
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (kind: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(kind, 'ascii'), data])
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, checksum])
  }
  const raw = Buffer.concat(Array.from({ length: height }, (_, y) =>
    Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: width }, (_, x) => Buffer.from(pixel(x, y))))])))
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** 场景脚本：立方体（写一条盒式投影 UV）+ PBR 三贴图 + TEXT + CURVE + 共享网格数据块。 */
function sceneScript(drop: '' | 'uv', texDir: string): string {
  return `import bpy
for obj in list(bpy.data.objects): bpy.data.objects.remove(obj, do_unlink=True)
bpy.ops.mesh.primitive_cube_add(size=2.0)
cube = bpy.context.active_object; cube.name = "ENV24_Cube"; mesh = cube.data; mesh.name = "ENV24_CubeMesh"
if ${JSON.stringify(drop)} == "uv":
    while mesh.uv_layers: mesh.uv_layers.remove(mesh.uv_layers[0])
else:
    layer = mesh.uv_layers[0] if mesh.uv_layers else mesh.uv_layers.new(name="UVMap")
    for polygon in mesh.polygons:
        for loop_index in polygon.loop_indices:
            co = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            layer.data[loop_index].uv = ((co.x + 1.0) / 2.0, (co.z + 1.0) / 2.0)
material = bpy.data.materials.new("ENV24_PBR"); material.use_nodes = True
nodes = material.node_tree.nodes; links = material.node_tree.links
bsdf = nodes.get("Principled BSDF")
base = nodes.new("ShaderNodeTexImage"); base.name = "base"
base.image = bpy.data.images.load(${JSON.stringify(join(texDir, 'basecolor.png'))}, check_existing=True)
links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
orm = nodes.new("ShaderNodeTexImage"); orm.name = "orm"
orm.image = bpy.data.images.load(${JSON.stringify(join(texDir, 'metalrough.png'))}, check_existing=True)
orm.image.colorspace_settings.name = "Non-Color"
split = nodes.new("ShaderNodeSeparateColor")
links.new(orm.outputs["Color"], split.inputs["Color"])
links.new(split.outputs["Blue"], bsdf.inputs["Metallic"])
links.new(split.outputs["Green"], bsdf.inputs["Roughness"])
mesh.materials.append(material)
shared = bpy.data.objects.new("ENV24_Cube_Shared", mesh); shared.location = (3.0, 0.0, 0.0)
bpy.context.scene.collection.objects.link(shared)
bpy.ops.object.text_add(location=(0.0, 3.0, 0.0)); text = bpy.context.active_object
text.name = "ENV24_Text"; text.data.body = "ENV24"
bpy.ops.curve.primitive_bezier_circle_add(radius=1.0, location=(3.0, 3.0, 0.0))
curve = bpy.context.active_object; curve.name = "ENV24_Curve"; curve.data.bevel_depth = 0.08
`
}

/** 自带 GLB 解析：GLB 容器（header + JSON chunk + BIN chunk）→ accessor 字节解码。 */
interface Glb { json: Record<string, any>; bin: Uint8Array }
function parseGlb(bytes: Uint8Array): Glb {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert.equal(view.getUint32(0, true), 0x46546c67, 'GLB 魔数应为 "glTF"')
  assert.equal(view.getUint32(4, true), 2, 'GLB 版本应为 2')
  let offset = 12, json: Record<string, any> | undefined, bin: Uint8Array | undefined
  while (offset < bytes.byteLength) {
    const length = view.getUint32(offset, true), kind = view.getUint32(offset + 4, true)
    const chunk = bytes.subarray(offset + 8, offset + 8 + length)
    if (kind === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk))
    else if (kind === 0x004e4942) bin = chunk
    offset += 8 + length
  }
  assert.ok(json, 'GLB 应含 JSON chunk')
  return { json: json!, bin: bin ?? new Uint8Array() }
}

/** 解 SCALAR/VEC2/VEC3 的 float 访问器（本用例只需要 float）。 */
function readAccessor(glb: Glb, index: number): number[][] {
  const accessor = glb.json.accessors[index]
  const bufferView = glb.json.bufferViews[accessor.bufferView]
  const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }
  const count = components[accessor.type]!
  assert.equal(accessor.componentType, 5126, '本解析器只解 float 访问器')
  const base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  const stride = bufferView.byteStride ?? count * 4
  const view = new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength)
  return Array.from({ length: accessor.count }, (_, item) =>
    Array.from({ length: count }, (_, c) => view.getFloat32(base + item * stride + c * 4, true)))
}

async function boot(config: { executable: string; workspace: string }) {
  const ctx = new Context()
  const fibers = [await ctx.plugin(SystemPrompt), await ctx.plugin(ToolRuntime), await ctx.plugin(LocalSubprocessRuntime)]
  apply(ctx, config)
  return {
    ctx,
    async close() { for (const fiber of fibers.reverse()) await fiber.dispose() },
  }
}

async function exportScene(ctx: Context, output: string, script: string): Promise<Record<string, unknown>> {
  const result: ToolExecutionResult = await ctx.tools.execute({
    callId: ToolCallId(`env24-test:${output}`), name: 'blender_run',
    arguments: { output_directory: output, python_script: script, operation: 'export' },
    signal: new AbortController().signal,
  })
  if (result.isError) throw new Error(`blender_run 失败：${JSON.stringify(result.content).slice(0, 600)}`)
  return (result.value ?? {}) as Record<string, unknown>
}

describe('ENV-24 导出：UV/PBR/文字曲线/共享资产 + 解码回验', { skip: blenderWorks ? false : `没有可用的 Blender（${BLENDER}）` }, () => {
  let dir = ''
  let booted: Awaited<ReturnType<typeof boot>>

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'env24-export-'))
    await mkdir(join(dir, 'textures'), { recursive: true })
    await writeFile(join(dir, 'textures', 'basecolor.png'),
      pngBytes(4, 4, (x, y) => ((x + y) % 2 === 0 ? [200, 90, 60] : [70, 130, 190])))
    await writeFile(join(dir, 'textures', 'metalrough.png'),
      pngBytes(4, 4, (x) => [0, x < 2 ? 60 : 190, x % 2 === 0 ? 255 : 0]))
    booted = await boot({ executable: BLENDER, workspace: dir })
  })
  after(async () => { await booted.close() })

  async function exportVariant(name: string, drop: '' | 'uv') {
    const output = join(dir, name)
    await mkdir(output, { recursive: true })
    const script = join(dir, `${name || 'scene'}.py`)
    await writeFile(script, sceneScript(drop, join(dir, 'textures')))
    const value = await exportScene(booted.ctx, output, script)
    const scene = JSON.parse(await readFile(join(output, 'scene.json'), 'utf8')) as Record<string, any>
    const glbs = (await readdir(join(output, 'visuals'))).filter(file => file.endsWith('.glb'))
    return { output, value, scene, glbs }
  }

  test('正例：UV 非退化 + PBR 三通道 + 贴图随导出物存在', async () => {
    const { output, glbs } = await exportVariant('positive', '')
    const cubeName = glbs.find(file => file.includes('ENV24_CubeMesh'))!
    assert.ok(cubeName, `应导出共享网格的 GLB，实际：${glbs.join(', ')}`)
    const glb = parseGlb(new Uint8Array(await readFile(join(output, 'visuals', cubeName))))
    const primitive = glb.json.meshes[0].primitives[0]
    const uvIndex = primitive.attributes.TEXCOORD_0
    assert.equal(typeof uvIndex, 'number', 'GLB 里必须有 TEXCOORD_0')
    const uv = readAccessor(glb, uvIndex)
    const us = uv.map(pair => pair[0]!), vs = uv.map(pair => pair[1]!)
    const unique = new Set(uv.map(pair => pair.join(','))).size
    const area = (Math.max(...us) - Math.min(...us)) * (Math.max(...vs) - Math.min(...vs))
    assert.ok(unique > 1, `UV 不能退化（唯一值应 >1，实际 ${unique}）`)
    assert.ok(area > 0, `UV 包围盒面积应 >0，实际 ${area}`)
    const pbr = glb.json.materials[0].pbrMetallicRoughness
    assert.equal(typeof pbr.baseColorTexture?.index, 'number', 'baseColorTexture 必须存在')
    assert.equal(typeof pbr.metallicRoughnessTexture?.index, 'number', 'metallicRoughnessTexture 必须存在')
    // glTF 里等于默认值的因子会被导出器**省略**（metallic 默认 1.0、roughness 默认 1.0）：
    // 按规范默认取值判定，而不是要求字段一定出现——"省略"不等于"没有通道"。
    assert.equal(pbr.metallicFactor ?? 1.0, 1.0, 'metallic 因子（省略即默认 1.0）')
    assert.equal(pbr.roughnessFactor ?? 1.0, 1.0, 'roughness 因子（省略即默认 1.0）')
    assert.ok(glb.json.textures.length >= 2, 'textures 里应有贴图引用')
    assert.ok(glb.json.images.length >= 2, 'images 里应有真实贴图')
    for (const image of glb.json.images) {
      const view = glb.json.bufferViews[image.bufferView]
      const raw = glb.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
      assert.ok(view.byteLength > 0, '贴图不能是 0 字节')
      assert.ok(raw[0] === 0x89 && raw[1] === 0x50, '嵌在 GLB 里的贴图应是 PNG（随导出物存在）')
    }
  })

  test('文字/曲线：明确被转换（convertedFrom + 真几何），源工程仍可编辑', async () => {
    const { output, scene } = await exportVariant('text-curve', '')
    const converted = scene.entities
      .filter((entity: Record<string, any>) => entity.components?.visual?.convertedFrom)
      .map((entity: Record<string, any>) => [entity.entityId, entity.components.visual.convertedFrom])
    assert.deepEqual(converted.sort(), [['ENV24_Curve', 'CURVE'], ['ENV24_Text', 'FONT']].sort())
    for (const file of await readdir(join(output, 'visuals'))) {
      if (!/ENV24_(Text|Curve)/.test(file)) continue
      const glb = parseGlb(new Uint8Array(await readFile(join(output, 'visuals', file))))
      const positions = readAccessor(glb, glb.json.meshes[0].primitives[0].attributes.POSITION)
      assert.ok(positions.length > 0, `${file} 的派生网格必须有真顶点`)
    }
    // 源工程里仍是可编辑的 FONT/CURVE（另起一个 Blender 进程读回 source.blend）
    const probe = spawnSync(BLENDER, ['--background', join(output, 'source.blend'), '--python-expr',
      'import bpy;print("TYPES="+",".join(sorted(o.type for o in bpy.data.objects)))'],
    { encoding: 'utf8', timeout: 120_000 })
    assert.equal(probe.status, 0, probe.stderr?.slice(-300))
    const types = /TYPES=([A-Z,]*)/.exec(probe.stdout ?? '')?.[1] ?? ''
    assert.ok(types.includes('FONT'), `source.blend 应保留 FONT 对象，实际 ${types}`)
    assert.ok(types.includes('CURVE'), `source.blend 应保留 CURVE 对象，实际 ${types}`)
  })

  test('共享资产：两个实体引用同一 resourceId@version（只导出一份）', async () => {
    const { output, scene, glbs } = await exportVariant('shared', '')
    const byResource = new Map<string, string[]>()
    for (const entity of scene.entities) {
      for (const ref of entity.resources ?? []) {
        const key = `${ref.resourceId}@${ref.version}`
        byResource.set(key, [...(byResource.get(key) ?? []), entity.entityId])
      }
    }
    const shared = [...byResource.entries()].filter(([, ids]) => ids.length > 1)
    assert.equal(shared.length, 1, `应恰有一份被多个实体共享的资源，实际 ${JSON.stringify([...byResource])}`)
    assert.deepEqual(shared[0]![1].sort(), ['ENV24_Cube', 'ENV24_Cube_Shared'])
    const cubeGlbs = glbs.filter(file => file.includes('ENV24_CubeMesh'))
    assert.equal(cubeGlbs.length, 1, '共享网格只应有一个 GLB 文件')
    const representation = scene.entities
      .find((entity: Record<string, any>) => entity.entityId === 'ENV24_Cube')!.resources[0].representations[0]
    assert.equal(representation.mimeType, 'model/gltf-binary')
    assert.ok(existsSync(join(output, representation.uri)) || existsSync(representation.uri),
      `representation 指向的 GLB 必须真的存在：${representation.uri}`)
  })

  test('负对照：去掉 UV 层 → 回读必须看到 TEXCOORD_0 缺失，且损失说明出现（判定不恒真）', async () => {
    const { output, scene, glbs } = await exportVariant('no-uv', 'uv')
    const cubeName = glbs.find(file => file.includes('ENV24_CubeMesh'))!
    const glb = parseGlb(new Uint8Array(await readFile(join(output, 'visuals', cubeName))))
    const primitive = glb.json.meshes[0].primitives[0]
    assert.equal(primitive.attributes.TEXCOORD_0, undefined, '没有 UV 层的网格不该出现 TEXCOORD_0')
    assert.equal(typeof glb.json.materials[0].pbrMetallicRoughness.baseColorTexture?.index, 'number',
      '这个负对照要保留贴图引用：贴图在、UV 不在，才是"无效 UV"的真实形态')
    // Blender 导出器在没有可用 UV 集时写 `texCoord: -1`——这是"贴图采样不到"的机器可判定标记
    // （glTF 规范里 texCoord 指向 TEXCOORD_n，-1 即没有对应的 UV 集）。
    assert.equal(glb.json.materials[0].pbrMetallicRoughness.baseColorTexture?.texCoord, -1,
      '缺 UV 时贴图引用必须带 texCoord=-1 标记')
    const resource = scene.entities.find((entity: Record<string, any>) => entity.entityId === 'ENV24_Cube')!.resources[0]
    const losses: string[] = resource.representations[0].losses ?? []
    assert.ok(losses.some((line: string) => /UV/.test(line) && /贴图/.test(line)),
      `资源损失回执里必须说明"有贴图但没 UV"，实际：${JSON.stringify(losses)}`)
  })
})
