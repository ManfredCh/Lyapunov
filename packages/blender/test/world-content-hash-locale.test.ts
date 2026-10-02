/**
 * L402 验收判据：内容指纹（`blender:content.contentHash` / `material_hash` / `mesh_hash`）必须与**界面语言**无关。
 *
 * 缺陷（改前实测，`packages/blender/src/world_incremental.py`）：指纹把**会随界面语言本地化的名字**哈希进去 ——
 * 网格属性名（`primitive_cube_add` 自建的 UV 层：en_US `UVMap` / zh_HANS `UV贴图`）、着色器节点名
 * （`Principled BSDF` / `原理化 BSDF`）、连线两端节点名。于是同一逻辑工程在中/英之间来回导出会互相判成
 * "内容变了"：`contentHash` 逐条不同 ⇒ **不断铸新版本**（id 不变、版本抖动），GLB 的
 * `extras.lyapunov_source_state` 也跟着变。
 *
 * 这条测试把**界面语言当自变量**：同一个真机 Blender、同一份 `world.py`、同一次场景构造（`--fixture`），
 * 只在 `--factory-startup`（不加载用户偏好 ⇒ en_US）与默认模式（加载用户偏好 ⇒ 本机 zh_HANS）之间切换；
 * 两种模式注入**同一个** `lyapunov_resource_namespace`（否则差异被随机 uuid 淹没，见 world-resource-id-locale.test.ts）。
 * 判据四条：① `scene.json` 归一化后逐字节相同；② `contentHash`/`material_hash`/`mesh_hash` 逐条相同；
 * ③ GLB 的 JSON chunk 逐字节相同（BIN 的运行间抖动与本单无关，按 L399 §5-R6 不计）；④ 同一输出目录先 en
 * 再 zh **不得铸新版本**。另有两条反向钉：同语言两次逐位相同（哈希没抖），真改内容必变（哈希没改废）。
 *
 * 跑法：`node --test packages/blender/test/world-content-hash-locale.test.ts`
 * （`BLENDER_EXECUTABLE` 或 `BLENDER` 或 PATH 上的 `blender`；没有 Blender / 两种模式语言相同 时如实跳过）。
 * 负向对照：`LYAPUNOV_INCREMENTAL_BEFORE=<改前的 world_incremental.py>` 指向改前模块 ⇒ 追加一条测试，
 * 断言"改前口径真的语言相关"，并逐字打出差异。
 * `LYAPUNOV_WORLD_SCRIPT` 指向要测的 `world.py`（默认 `../src/world.py`）。
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BLENDER = process.env.BLENDER_EXECUTABLE ?? process.env.BLENDER ?? 'blender'
const WORLD_SCRIPT = process.env.LYAPUNOV_WORLD_SCRIPT ?? fileURLToPath(new URL('../src/world.py', import.meta.url))
const PROBE = fileURLToPath(new URL('./test_world_content_hash_locale.py', import.meta.url))
const BEFORE_MODULE = process.env.LYAPUNOV_INCREMENTAL_BEFORE
/** 两种模式注入同一个命名空间：否则差异被随机 uuid 淹没，比对没有证据力。 */
const NAMESPACE = 'lane-hash402-acceptance'
const LANG_PREFIX = 'LANG_PROBE='
const PROBE_PREFIX = 'HASH_PROBE='
const PRELUDE = `import bpy; print('${LANG_PREFIX}' + bpy.context.preferences.view.language); bpy.context.scene['lyapunov_resource_namespace']=${JSON.stringify(NAMESPACE)}`
const ROOT = mkdtempSync(join(tmpdir(), 'lyapunov-hash402-'))
after(() => rmSync(ROOT, { recursive: true, force: true }))

const blenderAvailable = (() => {
  try { return spawnSync(BLENDER, ['--version'], { stdio: 'ignore' }).status === 0 } catch { return false }
})()

function modeArgs(factory: boolean): string[] {
  return [...(factory ? ['--factory-startup'] : []), '--background', '--python-exit-code', '1']
}

/** 只探语言（快），用来在测试注册时判断本机两种模式是否真的有语言差。 */
function probeLanguage(factory: boolean): string | null {
  try {
    const run = spawnSync(BLENDER, [...modeArgs(factory), '--python-expr', PRELUDE], { encoding: 'utf8' })
    if (run.status !== 0) return null
    const line = (run.stdout ?? '').split('\n').find((item) => item.startsWith(LANG_PREFIX))
    return line ? line.slice(LANG_PREFIX.length).trim() : null
  } catch { return null }
}

const LANGUAGE_FACTORY = blenderAvailable ? probeLanguage(true) : null
const LANGUAGE_DEFAULT = blenderAvailable ? probeLanguage(false) : null
const localeSkip = !blenderAvailable
  ? `Blender 不可用：${BLENDER}`
  : LANGUAGE_FACTORY === null || LANGUAGE_DEFAULT === null
    ? `语言探针没跑通（${BLENDER}）：factory=${LANGUAGE_FACTORY} default=${LANGUAGE_DEFAULT}`
    : LANGUAGE_FACTORY === LANGUAGE_DEFAULT
      // 本机默认界面语言与 --factory-startup 相同 ⇒ 自变量取不到两个值，如实跳过而不是伪通过。
      ? `两种模式的界面语言相同（都是 ${LANGUAGE_FACTORY}）：没有语言差就构不成对照`
      : false

function languageOf(log: string): string {
  return (log.split('\n').find((item) => item.startsWith(LANG_PREFIX)) ?? '').slice(LANG_PREFIX.length).trim()
}

const RUNS = new Map<string, string>()

/** 真机导出一次 `--fixture`；同一 (脚本, 模式, 目录) 只跑一次，多个判据共用读数。 */
function runFixture(worldScript: string, factory: boolean, output: string): string {
  const key = `${worldScript}|${factory}|${output}`
  const cached = RUNS.get(key)
  if (cached !== undefined) return cached
  mkdirSync(output, { recursive: true })
  const run = spawnSync(BLENDER, [...modeArgs(factory), '--python-expr', PRELUDE, '--python', worldScript,
    '--', '--fixture', '--output', output], { encoding: 'utf8', timeout: 900000 })
  const log = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
  assert.equal(run.status, 0, `真机导出必须成功（world=${worldScript}）：${log.slice(-1500)}`)
  RUNS.set(key, log)
  return log
}

const PROBES = new Map<string, ProbeHashes>()

interface ProbeHashes {
  language: string
  materialNames: string[]
  materials: Record<string, string>
  meshes: Record<string, string>
  contents: Record<string, string>
}

/** `--mode hashes` 探针：`scene.json` 里只有 contentHash，material_hash/mesh_hash 要真机重算。 */
function probeHashes(worldScript: string, factory: boolean): ProbeHashes {
  const key = `${worldScript}|${factory}`
  const cached = PROBES.get(key)
  if (cached !== undefined) return cached
  const run = spawnSync(BLENDER, [...modeArgs(factory), '--python', PROBE, '--',
    '--world', worldScript, '--mode', 'hashes'], { encoding: 'utf8', timeout: 900000 })
  assert.equal(run.status, 0, `hash 探针必须成功：${`${run.stdout}\n${run.stderr}`.slice(-1500)}`)
  const line = (run.stdout ?? '').split('\n').find((item) => item.startsWith(PROBE_PREFIX))
  assert.ok(line, `探针必须打印 ${PROBE_PREFIX}：${(run.stdout ?? '').slice(-400)}`)
  const parsed = JSON.parse(line.slice(PROBE_PREFIX.length)) as ProbeHashes
  PROBES.set(key, parsed)
  return parsed
}

interface ProbeRow { name: string; changed: boolean | null; expect: string; detail: string }
interface ProbeDiscrimination { language: string; rows: ProbeRow[]; failed: ProbeRow[]; passed: boolean }

function probeDiscrimination(worldScript: string): ProbeDiscrimination {
  const run = spawnSync(BLENDER, [...modeArgs(true), '--python', PROBE, '--', '--world', worldScript,
    '--mode', 'discrimination'], { encoding: 'utf8', timeout: 900000 })
  const log = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
  assert.equal(run.status, 0, `区分力探针必须跑通：${log.slice(-1500)}`)
  const line = (run.stdout ?? '').split('\n').find((item) => item.startsWith(PROBE_PREFIX))
  assert.ok(line, `探针必须打印 ${PROBE_PREFIX}：${(run.stdout ?? '').slice(-400)}`)
  return JSON.parse(line.slice(PROBE_PREFIX.length)) as ProbeDiscrimination
}

interface ResourceFacts { contentHash?: string; version?: number; byteSize?: number }

function resourceFacts(output: string): Record<string, ResourceFacts> {
  const scene = JSON.parse(readFileSync(join(output, 'scene.json'), 'utf8')) as {
    entities?: { resources?: { resourceId: string; version?: number; 'blender:content'?: ResourceFacts }[] }[]
  }
  const facts: Record<string, ResourceFacts> = {}
  for (const entity of scene.entities ?? []) {
    for (const resource of entity.resources ?? []) {
      const content = resource['blender:content']
      if (content?.contentHash) facts[resource.resourceId] = { ...content, version: resource.version }
    }
  }
  return facts
}

function sceneRevision(output: string): number | undefined {
  const scene = JSON.parse(readFileSync(join(output, 'scene.json'), 'utf8')) as { revision?: number }
  return scene.revision
}

/** `scene.json` 归一化：本目录绝对路径与本次 namespace 换成占位符（语言不是自变量的一部分）。 */
function normalizedScene(output: string): string {
  return readFileSync(join(output, 'scene.json'), 'utf8').split(output).join('<OUT>').split(NAMESPACE).join('<NS>')
}

function firstDifference(left: string, right: string): string {
  const leftLines = left.split('\n'); const rightLines = right.split('\n')
  for (let index = 0; index < Math.max(leftLines.length, rightLines.length); index += 1) {
    if (leftLines[index] !== rightLines[index]) {
      return `第 ${index + 1} 行 en=${JSON.stringify(leftLines[index])} zh=${JSON.stringify(rightLines[index])}`
    }
  }
  return '行相同但字节不同'
}

/** GLB 的 JSON chunk（BIN chunk 不计，见 L399 §5-R6 的运行间抖动）。 */
function glbJsonChunks(output: string): Record<string, Buffer> {
  const visuals = join(output, 'visuals')
  const chunks: Record<string, Buffer> = {}
  for (const name of existsSync(visuals) ? readdirSync(visuals).filter((item) => item.endsWith('.glb')).sort() : []) {
    const raw = readFileSync(join(visuals, name))
    assert.equal(raw.subarray(0, 4).toString('ascii'), 'glTF', `不是 GLB：${name}`)
    const total = raw.readUInt32LE(8)
    let offset = 12
    let body: Buffer | null = null
    while (offset < total) {
      const length = raw.readUInt32LE(offset); const kind = raw.readUInt32LE(offset + 4)
      if (kind === 0x4e4f534a) body = raw.subarray(offset + 8, offset + 8 + length)
      offset += 8 + length
    }
    assert.ok(body, `GLB 没有 JSON chunk：${name}`)
    chunks[name] = body
  }
  return chunks
}

function byteDifference(left: Buffer, right: Buffer): string {
  if (left.equals(right)) return 'IDENTICAL'
  const offsets: number[] = []
  for (let index = 0; index < Math.min(left.length, right.length) && offsets.length < 6; index += 1) {
    if (left[index] !== right[index]) offsets.push(index)
  }
  return `长度 ${left.length} vs ${right.length}；首个不同字节 offsets=${JSON.stringify(offsets)}` +
    ` en=${JSON.stringify(left.subarray(offsets[0] ?? 0, (offsets[0] ?? 0) + 40).toString('utf8'))}` +
    ` zh=${JSON.stringify(right.subarray(offsets[0] ?? 0, (offsets[0] ?? 0) + 40).toString('utf8'))}`
}

function visualFiles(output: string): string[] {
  const visuals = join(output, 'visuals')
  return existsSync(visuals) ? readdirSync(visuals).filter((item) => item.endsWith('.glb')).sort() : []
}

/** 只在"两种模式语言真的不同"时才跑的判据，统一在这里给出两边的目录（首次调用时真机跑）。 */
function localeDirs(): { enDir: string; zhDir: string } {
  const enDir = join(ROOT, 'en'); const zhDir = join(ROOT, 'zh')
  const enLog = runFixture(WORLD_SCRIPT, true, enDir)
  const zhLog = runFixture(WORLD_SCRIPT, false, zhDir)
  // 自变量：两种模式真的跑在不同的界面语言下（否则下面的相等断言没有意义）。
  assert.equal(languageOf(enLog), LANGUAGE_FACTORY, `--factory-startup 侧界面语言：${enLog.slice(-400)}`)
  assert.equal(languageOf(zhLog), LANGUAGE_DEFAULT, `默认模式侧界面语言：${zhLog.slice(-400)}`)
  assert.notEqual(LANGUAGE_FACTORY, LANGUAGE_DEFAULT)
  return { enDir, zhDir }
}

test('① scene.json 归一化后逐字节相同（中/英界面，钉住同一 namespace）', { skip: localeSkip, timeout: 900000 }, () => {
  const { enDir, zhDir } = localeDirs()
  const en = normalizedScene(enDir); const zh = normalizedScene(zhDir)
  assert.ok(en.length > 1000, `必须真的导出场景：${enDir}`)
  assert.equal(zh, en, `中/英界面的 scene.json 归一化后必须逐字节相同：${firstDifference(en, zh)}`)
})

test('② contentHash / material_hash / mesh_hash 逐条相同（中/英界面）', { skip: localeSkip, timeout: 900000 }, () => {
  const { enDir, zhDir } = localeDirs()
  const en = resourceFacts(enDir); const zh = resourceFacts(zhDir)
  assert.ok(Object.keys(en).length > 0, `必须真的导出资源：${enDir}`)
  assert.deepEqual(zh, en, `中/英界面的 contentHash（含 version/byteSize）必须逐条相同。\n` +
    `en=${JSON.stringify(en, null, 1)}\nzh=${JSON.stringify(zh, null, 1)}`)

  // material_hash / mesh_hash 不在 scene.json 里：用探针在两种界面下真机重算再比。
  const enProbe = probeHashes(WORLD_SCRIPT, true); const zhProbe = probeHashes(WORLD_SCRIPT, false)
  assert.notEqual(enProbe.language, zhProbe.language, '探针必须真的跑在两种界面语言下')
  assert.deepEqual(zhProbe.materialNames, enProbe.materialNames, '材质名集合必须相同（否则比的是两套场景）')
  assert.deepEqual(zhProbe.materials, enProbe.materials,
    `material_hash 必须逐条相同。en=${JSON.stringify(enProbe.materials, null, 1)} zh=${JSON.stringify(zhProbe.materials, null, 1)}`)
  assert.deepEqual(zhProbe.meshes, enProbe.meshes,
    `mesh_hash 必须逐条相同。en=${JSON.stringify(enProbe.meshes, null, 1)} zh=${JSON.stringify(zhProbe.meshes, null, 1)}`)
  assert.deepEqual(zhProbe.contents, enProbe.contents, 'contentHash（visual_content 口径）必须逐条相同')
})

test('③ GLB 的 JSON chunk 逐字节相同（BIN 按 R6 不计）', { skip: localeSkip, timeout: 900000 }, () => {
  const { enDir, zhDir } = localeDirs()
  const en = glbJsonChunks(enDir); const zh = glbJsonChunks(zhDir)
  assert.ok(Object.keys(en).length > 0, `必须真的导出 GLB：${enDir}`)
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'GLB 文件名集合必须逐字相同')
  for (const name of Object.keys(en)) {
    assert.ok(zh[name].equals(en[name]), `GLB 的 JSON chunk 必须逐字节相同：${name}；${byteDifference(en[name], zh[name])}`)
  }
})

test('④ 同一输出目录先 en 再 zh 不得铸新版本（R3 的决定性验收）', { skip: localeSkip, timeout: 900000 }, () => {
  const sameDir = join(ROOT, 'same')
  runFixture(WORLD_SCRIPT, true, sameDir)
  const beforeFiles = visualFiles(sameDir); const beforeRevision = sceneRevision(sameDir)
  const beforeVersions = Object.fromEntries(Object.entries(resourceFacts(sameDir)).map(([id, facts]) => [id, facts.version]))
  runFixture(WORLD_SCRIPT, false, sameDir)
  const afterFiles = visualFiles(sameDir); const afterRevision = sceneRevision(sameDir)
  const afterVersions = Object.fromEntries(Object.entries(resourceFacts(sameDir)).map(([id, facts]) => [id, facts.version]))
  assert.ok(beforeFiles.length > 0, `第一次导出必须真的产出 GLB：${sameDir}`)
  assert.equal(afterRevision, beforeRevision,
    `换个界面语言再导出同一目录，revision 不得前进：${beforeRevision} → ${afterRevision}`)
  assert.deepEqual(afterFiles, beforeFiles,
    `不得铸新版本文件。新增=${JSON.stringify(afterFiles.filter((name) => !beforeFiles.includes(name)))}`)
  assert.deepEqual(afterVersions, beforeVersions, '同一 resourceId 的 version 不得前进')
})

test('同语言两次逐位相同（哈希没被改废的前提）', { skip: localeSkip, timeout: 900000 }, () => {
  const { enDir } = localeDirs()
  const en2Dir = join(ROOT, 'en2')
  runFixture(WORLD_SCRIPT, true, en2Dir)
  assert.equal(normalizedScene(en2Dir), normalizedScene(enDir), '同语言两次的 scene.json 必须逐字节相同')
  assert.deepEqual(resourceFacts(en2Dir), resourceFacts(enDir), '同语言两次的 contentHash 必须逐条相同')
  const first = glbJsonChunks(enDir); const second = glbJsonChunks(en2Dir)
  for (const name of Object.keys(first)) {
    assert.ok(second[name]?.equals(first[name]), `同语言两次的 GLB JSON chunk 也必须相同：${name}`)
  }
})

test('区分力：真改内容必变、改本地化名字不变（真机逐项）', { skip: blenderAvailable ? false : `Blender 不可用：${BLENDER}`, timeout: 900000 }, () => {
  const probe = probeDiscrimination(WORLD_SCRIPT)
  const table = probe.rows.map((row) => `${row.expect === 'info' ? '·' : row.changed === (row.expect === 'change') ? '✔' : '✘'} ` +
    `[${row.expect}] ${row.name} ${row.detail}`).join('\n')
  assert.deepEqual(probe.failed, [], `每一条区分力断言都要成立（✘ 是失败项）：\n${table}`)
  assert.equal(probe.passed, true, `整体判据必须通过：\n${table}`)
})

test('负向对照：指向改前的 world_incremental.py ⇒ 上面的判据必须失败', {
  skip: !blenderAvailable ? `Blender 不可用：${BLENDER}`
    : localeSkip ? localeSkip
      : BEFORE_MODULE === undefined ? '未给 LYAPUNOV_INCREMENTAL_BEFORE（改前模块路径）：不伪通过，如实跳过'
        : !existsSync(BEFORE_MODULE) ? `改前模块不存在：${BEFORE_MODULE}` : false,
  timeout: 900000,
}, () => {
  // 改前的指纹口径在**同一个 world.py** 下跑：把改前模块放到 world.py 旁边，靠 world.py 自己的
  // sys.path 约定（`from world_incremental import …`）加载它。
  const packageDir = join(ROOT, 'before_pkg')
  mkdirSync(packageDir, { recursive: true })
  copyFileSync(WORLD_SCRIPT, join(packageDir, 'world.py'))
  copyFileSync(BEFORE_MODULE as string, join(packageDir, 'world_incremental.py'))
  const legacyWorld = join(packageDir, 'world.py')

  const enDir = join(ROOT, 'legacy-en'); const zhDir = join(ROOT, 'legacy-zh')
  runFixture(legacyWorld, true, enDir)
  runFixture(legacyWorld, false, zhDir)
  const en = resourceFacts(enDir); const zh = resourceFacts(zhDir)
  const differing = Object.keys(en).filter((id) => en[id].contentHash !== zh[id]?.contentHash)
  // 这条是**绿色**的镜像判据：改前口径必须真的语言相关（与 ①/②/③/④ 的相等断言互为反向）。
  assert.ok(differing.length > 0, '改前口径必须在中/英界面下给出不同的 contentHash（否则这条负向对照没有证据力）')
  const probe = probeDiscrimination(legacyWorld)
  assert.ok(probe.failed.length > 0, '改前口径必须在"改本地化名字不算内容变化"这几条上失败：' +
    probe.rows.map((row) => `\n  ✔ [${row.expect}] ${row.name} changed=${row.changed} ${row.detail}`).join(''))
  console.log(`负向对照（改前 world_incremental.py）逐字差异：\n` +
    differing.map((id) => `  ${id} en=${en[id].contentHash} zh=${zh[id]?.contentHash}`).join('\n') + '\n' +
    probe.failed.map((row) => `  ✘ [${row.expect}] ${row.name} changed=${row.changed} ${row.detail}`).join('\n'))
})
