/**
 * L399 验收判据：同一逻辑场景在**中/英界面**下必须产出**逐字相同**的 `resourceId` 集合。
 *
 * 缺陷机制（改前实测）：`box()` 走 `bpy.ops.mesh.primitive_cube_add` 后只写 `o.name`，从不写
 * `o.data.name`。Blender 给新建网格数据块起的默认名**随界面语言本地化**（en_US `Cube` /
 * zh_HANS `立方体`），而 `visual_resource_id()` 的 slug 与 hash **都取自 `obj.data.name`**：
 *
 *   en: `<ns>-mesh-Cube.001-79e5da79-mesh`
 *   zh: `<ns>-mesh----.001-3ecaa9a4-mesh`      ← slug 被消毒成 `----`，hash 也不同
 *
 * 于是同一逻辑场景在两台机器上得到两套 `resourceId`，`scene.json`／GLB 节点名／
 * ENV-57「保持场景/参考」的可断言性全被破坏。
 *
 * 这条测试把**界面语言当自变量**：同一个真机 Blender、同一份 `world.py`、同一次场景构造
 * （`--fixture`），只在 `--factory-startup`（不加载用户偏好 ⇒ en_US）与默认模式（加载用户偏好
 * ⇒ 本机 zh_HANS）之间切换，然后逐字比对两份 `scene.json`。
 *
 * 关于 `namespace`：`world.py` 对**新建输出目录**默认铸一个新 uuid 作资源命名空间，因此
 * 「同一目录跑两次」之外的任何两次全新运行都必然 namespace 不同。这里在两种模式下注入
 * **同一个** `lyapunov_resource_namespace`——这正是产品"重新打开 `output/source.blend` 继续导出"
 * 的形状（`world.py` 从场景属性读回既有 namespace），否则比对的差异会被随机 uuid 淹没。
 *
 * 跑法：`node --test packages/blender/test/world-resource-id-locale.test.ts`
 * （`BLENDER_EXECUTABLE` 或 PATH 上的 `blender`；没有 Blender 时如实跳过，不伪造成通过）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BLENDER = process.env.BLENDER_EXECUTABLE ?? 'blender'
/** `LYAPUNOV_WORLD_SCRIPT` 允许指向改前的 world.py 做负向对照（同 test_world_locale.py 的口径）。 */
const WORLD_SCRIPT = process.env.LYAPUNOV_WORLD_SCRIPT ?? fileURLToPath(new URL('../src/world.py', import.meta.url))
/** 两种模式注入同一个命名空间：否则差异被随机 uuid 淹没，比对没有证据力。 */
const NAMESPACE = 'lane-rid399-acceptance'
const LANG_PREFIX = 'LANG_PROBE='
const PRELUDE = `import bpy; print('${LANG_PREFIX}' + bpy.context.preferences.view.language); bpy.context.scene['lyapunov_resource_namespace']=${JSON.stringify(NAMESPACE)}`

const blenderAvailable = (() => {
  try { return spawnSync(BLENDER, ['--version'], { stdio: 'ignore' }).status === 0 } catch { return false }
})()

interface SceneFacts {
  resourceIds: string[]
  versions: Record<string, number | undefined>
  byteSizes: Record<string, number | undefined>
  glbNames: string[]
  glbSizes: number[]
}

function modeArgs(factoryStartup: boolean): string[] {
  return [...(factoryStartup ? ['--factory-startup'] : []), '--background']
}

/** 只探语言（快），用来在测试注册时判断本机两种模式是否真的有语言差。 */
function probeLanguage(factoryStartup: boolean): string | null {
  try {
    const run = spawnSync(BLENDER, [...modeArgs(factoryStartup), '--python-exit-code', '1', '--python-expr', PRELUDE], { encoding: 'utf8' })
    if (run.status !== 0) return null
    const line = (run.stdout ?? '').split('\n').find((item) => item.startsWith(LANG_PREFIX))
    return line ? line.slice(LANG_PREFIX.length).trim() : null
  } catch { return null }
}

const LANGUAGE_FACTORY = blenderAvailable ? probeLanguage(true) : null
const LANGUAGE_DEFAULT = blenderAvailable ? probeLanguage(false) : null

const skipReason = !blenderAvailable
  ? `Blender 不可用：${BLENDER}`
  : LANGUAGE_FACTORY === null || LANGUAGE_DEFAULT === null
    ? `语言探针没跑通（${BLENDER}）：factory=${LANGUAGE_FACTORY} default=${LANGUAGE_DEFAULT}`
    : LANGUAGE_FACTORY === LANGUAGE_DEFAULT
      // 本机默认界面语言与 --factory-startup 相同 ⇒ 自变量取不到两个值，如实跳过而不是伪通过。
      ? `两种模式的界面语言相同（都是 ${LANGUAGE_FACTORY}）：没有语言差就构不成对照`
      : false

function runFixture(factoryStartup: boolean, output: string) {
  const run = spawnSync(BLENDER, [...modeArgs(factoryStartup), '--python-exit-code', '1', '--python-expr', PRELUDE,
    '--python', WORLD_SCRIPT, '--', '--fixture', '--output', output], { encoding: 'utf8', timeout: 600000 })
  return `${run.stdout ?? ''}\n${run.stderr ?? ''}`
}

function sceneFacts(output: string): SceneFacts {
  const scene = JSON.parse(readFileSync(join(output, 'scene.json'), 'utf8')) as {
    entities?: { resources?: { resourceId: string; version?: number; 'blender:content'?: { byteSize?: number } }[] }[]
  }
  const versions: Record<string, number | undefined> = {}
  const byteSizes: Record<string, number | undefined> = {}
  for (const entity of scene.entities ?? []) {
    for (const resource of entity.resources ?? []) {
      versions[resource.resourceId] = resource.version
      byteSizes[resource.resourceId] = resource['blender:content']?.byteSize
    }
  }
  const visuals = join(output, 'visuals')
  const glbNames = existsSync(visuals) ? readdirSync(visuals).filter((name) => name.endsWith('.glb')).sort() : []
  return {
    resourceIds: Object.keys(versions).sort(),
    versions,
    byteSizes,
    glbNames,
    glbSizes: glbNames.map((name) => statSync(join(visuals, name)).size).sort((a, b) => a - b),
  }
}

test('同一逻辑场景在中/英界面下的 resourceId 集合逐字相同（真机 Blender，L399 验收判据）',
  { skip: skipReason, timeout: 900000 }, () => {
    const root = mkdtempSync(join(tmpdir(), 'lyapunov-rid-locale-'))
    const enDir = join(root, 'en')
    const zhDir = join(root, 'zh')
    try {
      const enLog = runFixture(true, enDir)
      const zhLog = runFixture(false, zhDir)

      // 自变量：两种模式真的跑在不同的界面语言下（否则下面的相等断言没有意义）。
      const languageIn = (log: string) => (log.split('\n').find((item) => item.startsWith(LANG_PREFIX)) ?? '').slice(LANG_PREFIX.length).trim()
      assert.equal(languageIn(enLog), LANGUAGE_FACTORY, `--factory-startup 侧界面语言：${enLog.slice(-400)}`)
      assert.equal(languageIn(zhLog), LANGUAGE_DEFAULT, `默认模式侧界面语言：${zhLog.slice(-400)}`)
      assert.notEqual(LANGUAGE_FACTORY, LANGUAGE_DEFAULT)

      const en = sceneFacts(enDir)
      const zh = sceneFacts(zhDir)
      assert.ok(en.resourceIds.length > 0, `必须真的导出资源：${enDir}`)

      // 本单验收判据：resourceId 集合逐字相同。
      assert.deepEqual(zh.resourceIds, en.resourceIds,
        `中/英界面的 resourceId 集合必须逐字相同。en=${JSON.stringify(en.resourceIds)} zh=${JSON.stringify(zh.resourceIds)}`)
      // 身份不止 id：同一 id 的版本号也必须落在同一号上。
      assert.deepEqual(zh.versions, en.versions, '同一 resourceId 的 version 必须相同')
      assert.deepEqual(zh.byteSizes, en.byteSizes, '同一 resourceId 的 GLB 字节数必须相同')
      // 顺序：GLB 文件名由 resourceId 拼出，字节数向量是"还有没有别的语言泄漏"的量尺。
      assert.deepEqual(zh.glbNames, en.glbNames, 'GLB 文件名集合（由 resourceId 拼出）必须逐字相同')
      assert.deepEqual(zh.glbSizes, en.glbSizes, 'GLB 字节数向量必须相同（不同即说明还有别的语言泄漏）')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
