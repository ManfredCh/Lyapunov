/**
 * L404 / 发现 J：A5 恢复轮的贴图接线。
 *
 * 事实（`bugfixHistory/ENV57-TEXTURE-REUSE-20260923.md` §发现 J，本文件把它变成判据）：
 *   `bpy.ops.object.delete()` 只删对象，材质/网格数据块留在工程里；A5 恢复打开的是本作业自己写出的
 *   `output/source.blend`，于是重跑 `--fixture` 时 `materials.new('墙面')` 只能拿到 `墙面.001`。
 *   旧实现按 `bpy.data.materials` 全集按名匹配 ⇒ 贴图接在 users=0 的孤儿 `墙面` 上，导出走对象材质槽
 *   拿到没有贴图的 `墙面.001`，而结果行 `materialTextures` 照样非空（假成功）。
 *
 * 本文件只驱动**真实 Blender CLI**（与 `plugin.ts` 的 argv 同形，不使用网络：textures.json 与图都在
 * 临时目录里现造），断言三件事：
 *   ① 恢复轮不再出现"users=0 同名孤儿 + 在用 `.001`"的名字漂移（resourceId 里没有 `.001` 数据块名）；
 *   ② 被使用的材质真的接上了贴图，且恢复轮被实体引用的 GLB 真的内嵌了图；
 *   ③ 清单里没人用的材质 ⇒ 结果行如实报失败，不许静默/假成功。
 * 运行：`node --test packages/blender/test/world-orphan-material-wiring.test.ts`（bun 1.3.13 忽略 skip，判据一律以 node --test 为准）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BLENDER = process.env.BLENDER_EXECUTABLE ?? 'blender'
const WORLD_SCRIPT = fileURLToPath(new URL('../src/world.py', import.meta.url))
/** 结果行前缀：与产品源里的 `RESULT_PREFIX` 同一个字面量（协议漂移要失败）。 */
const PREFIX = 'LYAPUNOV_RESULT='
const blenderAvailable = (() => {
  try { return spawnSync(BLENDER, ['--version'], { stdio: 'ignore' }).status === 0 } catch { return false }
})()
const skipWithoutBlender = blenderAvailable ? false : `Blender 不可用：${BLENDER}`

/** 最小合法 PNG（1×1，RGBA）：Blender 真的会解码它，随便写几个字节过不了。 */
function tinyPng(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = (() => { let value = 0xffffffff; for (const byte of body) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)) } return (value ^ 0xffffffff) >>> 0 })()
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc)
    return Buffer.concat([length, body, checksum])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 真实 Blender 跑一次（argv 形状与 plugin.ts 的 blenderArgv 同形：`--python-exit-code 1` 在任何 `--python` 之前）。 */
function blender(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(BLENDER, args, { encoding: 'utf8', timeout: 900_000 })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function freshArgv(output: string): string[] {
  return ['--background', '--factory-startup', '--python-exit-code', '1', '--python', WORLD_SCRIPT, '--', '--output', output, '--fixture']
}

/** A5 的恢复 argv：打开本作业自己的 output/source.blend（plugin.ts resumeArgv 的等价物）。 */
function resumeArgv(output: string): string[] {
  return ['--background', join(output, 'source.blend'), '--python-exit-code', '1', '--python', WORLD_SCRIPT, '--', '--output', output, '--fixture']
}

function resultLine(run: { stdout: string; stderr: string }): Record<string, unknown> {
  const line = run.stdout.split('\n').filter(row => row.startsWith(PREFIX)).pop()
  assert.ok(line, `必须打出结果行；stderr 末尾：${run.stderr.slice(-800)}`)
  return JSON.parse(line.slice(PREFIX.length)) as Record<string, unknown>
}

interface WiredRow { assetId?: string; license?: string; maps?: string[]; error?: string }

/** 只读解析 GLB 的 JSON chunk（不依赖产品代码）：内嵌图片数 + 引用了贴图的材质名。 */
function glbStats(path: string): { bytes: number; images: number; textured: string[] } {
  const data = readFileSync(path)
  assert.equal(data.subarray(0, 4).toString('latin1'), 'glTF', `${path} 不是 GLB`)
  let offset = 12; let json: Record<string, unknown> | undefined
  while (offset < data.length) {
    const length = data.readUInt32LE(offset); const kind = data.subarray(offset + 4, offset + 8).toString('latin1')
    if (kind === 'JSON') json = JSON.parse(data.subarray(offset + 8, offset + 8 + length).toString('utf8')) as Record<string, unknown>
    offset += 8 + length
  }
  assert.ok(json, `${path} 没有 JSON chunk`)
  const materials = (json.materials ?? []) as Array<{ name?: string; pbrMetallicRoughness?: Record<string, unknown>; normalTexture?: unknown }>
  const textured = materials.filter(material => {
    const pbr = material.pbrMetallicRoughness ?? {}
    return 'baseColorTexture' in pbr || 'metallicRoughnessTexture' in pbr || material.normalTexture !== undefined
  }).map(material => material.name ?? '?')
  return { bytes: data.length, images: ((json.images ?? []) as unknown[]).length, textured }
}

async function writeStubTextures(output: string, materials: string[]): Promise<void> {
  await mkdir(join(output, 'textures'), { recursive: true })
  const diffuse = join(output, 'textures', 'stub_Diffuse_1k.png')
  await writeFile(diffuse, tinyPng())
  const sets: Record<string, unknown> = {}
  for (const material of materials) {
    sets[material] = { assetId: 'stub', license: 'CC0-1.0', maps: { Diffuse: diffuse }, complete: true, resolution: '1k' }
  }
  await writeFile(join(output, 'textures.json'), JSON.stringify({ sets }))
}

test('发现 J：A5 恢复轮的贴图接在"被使用的材质"上，恢复轮产物真的带贴图（不再接到 users=0 孤儿上）', { skip: skipWithoutBlender }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-orphan-wiring-'))
  try {
    const output = join(directory, 'world')
    await writeStubTextures(output, ['墙面'])

    // ── 暂停前那一轮：fresh（--factory-startup）───────────────────────────────
    const fresh = blender(freshArgv(output))
    assert.equal(fresh.status, 0, fresh.stderr.slice(-800))
    assert.equal((resultLine(fresh).materialTextures as Record<string, WiredRow>)['墙面']?.error, undefined)
    assert.ok(readdirSync(output).includes('source.blend'), '暂停前那一轮必须写出 source.blend（A5 的恢复输入）')

    // ── 恢复轮：打开本作业自己的 source.blend 再跑同一 argv ──────────────────
    const resumed = blender(resumeArgv(output))
    assert.equal(resumed.status, 0, resumed.stderr.slice(-800))
    const result = resultLine(resumed)

    // ① 结果行只反映被使用的材质（`Material` 这类 users=0 孤儿不许出现），且真的接上了
    const wired = result.materialTextures as Record<string, WiredRow>
    assert.deepEqual(Object.keys(wired), ['墙面'], `只该有被使用的清单条目：${JSON.stringify(wired)}`)
    assert.equal(wired['墙面']?.error, undefined, `恢复轮必须真的接上（不许报失败也不许报孤儿）：${JSON.stringify(wired)}`)
    assert.ok((wired['墙面']?.maps ?? []).includes('Diffuse'))

    // ② 数据块名不再漂移：恢复轮的 resourceId 里不该出现 Blender 去重后缀（旧行为：`-mesh-floor.001-…`）
    const resources = (result.incremental as { resources: Array<{ resourceId: string; version: number }> }).resources
    assert.ok(resources.length > 0)
    assert.equal(resources.some(row => /-mesh-[^-]*\.\d{3}-/.test(row.resourceId)), false,
      `恢复轮不该带着 .001 数据块名（发现 J 的名字漂移）：${resources.map(row => row.resourceId).join(' ')}`)
    const names = readdirSync(join(output, 'visuals'))
    assert.deepEqual(names.filter(name => /mesh-floor\.\d{3}/.test(name)), [], `不该产出 .001 数据块的 GLB：${names.join(' ')}`)

    // ③ 恢复轮里被实体引用的 floor GLB 必须真的内嵌贴图（旧行为：2248 B、images_count=0）
    const floor = resources.find(row => row.resourceId.includes('-mesh-floor-'))
    assert.ok(floor, `必须有 floor 资源：${JSON.stringify(resources.map(row => row.resourceId))}`)
    const glb = names.filter(name => name.startsWith(floor.resourceId) && name.endsWith('.glb')).sort().pop()
    assert.ok(glb, `资源 ${floor.resourceId} 必须有对应 GLB：${names.join(' ')}`)
    const stats = glbStats(join(output, 'visuals', glb))
    assert.ok(stats.images > 0, `恢复轮的 floor GLB 必须内嵌图片：${glb}（${JSON.stringify(stats)}）`)
    assert.ok(stats.textured.includes('墙面'), `恢复轮的 floor GLB 必须引用贴图：${JSON.stringify(stats)}`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/**
 * 清单里的 Diffuse 指向**不存在的文件**：走的是 `apply_texture_set` 里 `bpy.data.images.load()` 抛异常
 * 那条路（`world.py` 的 `except Exception` 分支）——也就是"Blender 异常原文直传"的缺陷点。
 */
async function writeMissingDiffuseManifest(output: string, material: string): Promise<string> {
  await mkdir(join(output, 'textures'), { recursive: true })
  const missing = join(output, 'textures', 'definitely-missing_Diffuse_1k.png')
  const sets: Record<string, unknown> = {
    [material]: { assetId: 'stub', license: 'CC0-1.0', maps: { Diffuse: missing }, complete: true, resolution: '1k' },
  }
  await writeFile(join(output, 'textures.json'), JSON.stringify({ sets }))
  return missing
}

test('缺陷 1 负对照：Diffuse 指向不存在的文件 ⇒ 结构化码 BLENDER_TEXTURE_MAP_UNREADABLE，且不得报成功', { skip: skipWithoutBlender }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-orphan-unreadable-'))
  try {
    const output = join(directory, 'world')
    const missing = await writeMissingDiffuseManifest(output, '墙面')

    // 首轮形状（`--factory-startup` ⇒ 界面英语）：贴图文件不存在必须给**码**，不是异常原文。
    const fresh = blender(freshArgv(output))
    assert.equal(fresh.status, 0, fresh.stderr.slice(-800))
    const first = (resultLine(fresh).materialTextures as Record<string, WiredRow>)['墙面']
    console.log(`[缺陷 1] 首轮（--factory-startup）原文 materialTextures=${JSON.stringify(first)}`)
    assert.match(first?.error ?? '', /^BLENDER_TEXTURE_MAP_UNREADABLE: /,
      `贴图文件不存在必须给结构化码，而不是 Blender 的界面语言原文：${JSON.stringify(first)}`)
    assert.ok((first?.error ?? '').includes(missing), `码后面必须留下"读不了哪张图"的原因原文：${JSON.stringify(first)}`)
    // 负对照：这一条**绝不是**成功读数——不许出现"接上了"才有的字段。
    assert.equal(first?.assetId, undefined, '失败条目不许带 assetId（不得假成功）')
    assert.equal(first?.maps, undefined, '失败条目不许带 maps（不得假成功）')

    // A5 恢复形状（打开本作业自己的 source.blend ⇒ 会加载用户偏好/界面语言）：机器读数（码）必须逐字相同，
    // 只有码后面的细节原文才允许随语言/路径变——这正是"界面语言不该改变机器读数"的判据形状。
    const resumed = blender(resumeArgv(output))
    assert.equal(resumed.status, 0, resumed.stderr.slice(-800))
    const second = (resultLine(resumed).materialTextures as Record<string, WiredRow>)['墙面']
    console.log(`[缺陷 1] 恢复形状（打开 source.blend）原文 materialTextures=${JSON.stringify(second)}`)
    const codeOf = (row?: WiredRow): string => (row?.error ?? '').split(':')[0]
    assert.equal(codeOf(first), 'BLENDER_TEXTURE_MAP_UNREADABLE')
    assert.equal(codeOf(second), codeOf(first), `机器读数（码）不得随输入源/界面语言变：${JSON.stringify({ first, second })}`)
    assert.equal(second?.assetId, undefined, '失败条目不许带 assetId（不得假成功）')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('发现 J 负对照：清单里没人用的材质 ⇒ 结果行如实报失败，不许静默或假成功', { skip: skipWithoutBlender }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-orphan-unused-'))
  try {
    const output = join(directory, 'world')
    await writeStubTextures(output, ['墙面', '浅色灰泥'])
    const run = blender(freshArgv(output))
    assert.equal(run.status, 0, run.stderr.slice(-800))
    const wired = resultLine(run).materialTextures as Record<string, WiredRow>
    assert.equal(wired['墙面']?.error, undefined, '被使用的材质照常接上')
    assert.match(wired['浅色灰泥']?.error ?? '', /BLENDER_MATERIAL_NOT_USED/,
      `清单里没人用的材质必须点名失败：${JSON.stringify(wired)}`)
    assert.equal(wired['浅色灰泥']?.assetId, undefined, '失败条目不许带"接上了"的读数')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
