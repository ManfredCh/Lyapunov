/**
 * `world.py` 的**本地化依赖**回归：节点 `.name` 随界面语言变，查找必须按 `node.type`/`socket.identifier`。
 *
 * 缺陷（L385 §1「发现 A」实测）：`material()` 写死 `nodes.get('Principled BSDF')`。`--factory-startup`
 * （无 `source_blend` 的形状）不加载用户偏好 ⇒ 界面英语 ⇒ 自动命名的节点叫 'Principled BSDF'；
 * 打开既有工程（带 `source_blend` 的形状）会加载用户偏好，中文界面下同一节点叫 '原理化 BSDF'
 * ⇒ 查找落空成 `None` ⇒ `.inputs` 抛 `AttributeError`、Blender 退出码 1。
 *
 * 这条测试跑**真机**：`packages/blender/test/test_world_locale.py` 在真实 Blender 里把
 * `bpy.context.preferences.view.language` 依次设成 `en_US` / `zh_HANS`（运行期切换会改变**新建**
 * 节点的默认名，本机 5.2.2 实测），再对 `world.py` 的真实函数做断言。这里只负责起进程、核对
 * 退出码，并把探针的原始读数（`PROBE_RESULT=` 行）再断言一遍——包括"旧写法在中文下真的抛
 * AttributeError、在英语下不抛"这条负向对照。
 *
 * 跑法：`node --test packages/blender/test/world-locale.test.ts`（`BLENDER_EXECUTABLE`，其次 `BLENDER`
 * 环境变量，最后 PATH 上的 `blender`；不需要 `LYAPUNOV_CAD_PYTHON`，没有 Blender 时如实跳过，不伪造成通过）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * 可执行文件解析：显式 `BLENDER_EXECUTABLE` 优先，其次 `BLENDER` 环境变量，最后才回落 PATH 上的
 * `blender`。闸门（`skipWithoutBlender`）与真实执行用**同一个已解析的可执行文件**，做法同
 * `blender-run.test.ts:70`。
 */
const BLENDER = process.env.BLENDER_EXECUTABLE ?? process.env.BLENDER ?? 'blender'
const PROBE = fileURLToPath(new URL('./test_world_locale.py', import.meta.url))
const PREFIX = 'PROBE_RESULT='

/**
 * 真实 Blender 是否可用。除退出码外还要求 `--version` **真的打印 Blender 版本**：本机 PATH 上的
 * `blender` 是 `/snap/bin/blender` 包装器（缺 session DBus 时以 DBus 错失败；套件内实测探针
 * `actual: 46`、`cannot create transient scope`，见 `.runtime/lane-rid399/bun-test-final.log:6-18`），
 * 只认退出码的闸门分不出"真 Blender"与"恰好返回 0 的包装器"。不可用就如实跳过（注册方式见文件末尾）。
 */
const blenderAvailable = (() => {
  try {
    const probe = spawnSync(BLENDER, ['--version'], { encoding: 'utf8' })
    return probe.status === 0 && /Blender\s+\d/.test(`${probe.stdout ?? ''}`)
  } catch { return false }
})()
const skipWithoutBlender = !blenderAvailable
const skipReason = blenderAvailable ? '' : `Blender 不可用：${BLENDER}`

interface ProbeRow { name: string; ok: boolean; detail: string }
interface LocaleFacts {
  language_now: string
  auto_node_name: string
  auto_node_type: string
  legacy_lookup_found: boolean
  legacy_error: string | null
  base_color_identifier: string
  identifiers_textured: Record<string, { inputs: string[]; outputs: string[] }>
  wired: boolean
  linked: Record<string, boolean>
}
interface ProbeResult { rows: ProbeRow[]; locales: Record<string, LocaleFacts> }

const TEST_NAME = '世界脚本的节点/插槽查找与界面语言无关（真机 Blender，en_US 与 zh_HANS 两种界面）'

const localeTest = () => {
  const run = spawnSync(BLENDER, ['--background', '--factory-startup', '--python-exit-code', '1', '--python', PROBE], { encoding: 'utf8' })
  const output = `${run.stdout}\n${run.stderr}`
  assert.equal(run.status, 0, `探针必须整体通过；stderr 尾部=${run.stderr.slice(-600)}`)
  const line = run.stdout.split('\n').reverse().find((item) => item.startsWith(PREFIX))
  assert.ok(line, `探针必须打印 ${PREFIX} 结果行；stdout 尾部=${run.stdout.slice(-400)}`)
  const parsed = JSON.parse(line.slice(PREFIX.length)) as ProbeResult

  const failed = parsed.rows.filter((row) => !row.ok)
  assert.deepEqual(failed, [], `探针里每条断言都要通过：${JSON.stringify(failed)}`)
  assert.ok(output.includes('test_world_locale（真机 Blender）:'), '要有人能读的通过计数行')

  const en = parsed.locales.en_US
  const zh = parsed.locales.zh_HANS
  assert.ok(en && zh, `两种界面都要被真的走到：${Object.keys(parsed.locales)}`)
  // 自变量：界面语言真的换了（否则下面的对照没有意义）——节点默认名在不同语言下不同。
  assert.notEqual(en.auto_node_name, zh.auto_node_name, '中英界面下新建节点的默认名必须不同，否则语言没切过去')
  assert.equal(en.auto_node_name, 'Principled BSDF')
  assert.equal(zh.auto_node_name, '原理化 BSDF')
  // 根因与负向对照：旧写法只在英语界面命中，中文界面真的抛 AttributeError。
  assert.equal(en.legacy_lookup_found, true, '英语界面下 nodes.get(\'Principled BSDF\') 命中')
  assert.equal(zh.legacy_lookup_found, false, '中文界面下 nodes.get(\'Principled BSDF\') 必须落空')
  assert.equal(en.legacy_error, null, '英语界面下旧写法不抛异常')
  assert.match(String(zh.legacy_error), /AttributeError: 'NoneType' object has no attribute 'inputs'/, '中文界面下旧写法必须复现线上那条 AttributeError')
  // 修好后的判据：节点按 type 找到、插槽 identifier 两种语言逐字相同、贴图真的接上。
  assert.equal(en.auto_node_type, 'BSDF_PRINCIPLED')
  assert.equal(zh.auto_node_type, 'BSDF_PRINCIPLED')
  assert.equal(en.base_color_identifier, 'Base Color')
  assert.equal(zh.base_color_identifier, 'Base Color')
  assert.deepEqual(Object.keys(en.identifiers_textured).sort(), ['BSDF_PRINCIPLED', 'MIX_RGB', 'NORMAL_MAP', 'OUTPUT_MATERIAL', 'TEX_IMAGE'])
  assert.deepEqual(zh.identifiers_textured, en.identifiers_textured, '五类节点的插槽 identifier 集合必须逐字相同')
  assert.equal(en.wired, true)
  assert.equal(zh.wired, true)
  assert.deepEqual(zh.linked, { 'Base Color': true, Roughness: true, Normal: true })
}

// 不可用时**必须**走 `test.skip`：本仓 bun 1.3.13 的 `node:test` 桥**忽略** `{ skip: … }` 选项
// （实测 `{skip:'原因'}` 与 `{skip:true}` 都照跑 ⇒ 闸门形同不存在、以坏可执行文件跑到一半假红），
// 且 `t.skip()` 直接抛 NotImplementedError；`test.skip(名, 体)` 是 node 与 bun 两个 runner 下
// **都**真的跳过的唯一形式，故按可用性选注册方式（原因写进跳过行的名字里，两种 runner 都读得到）。
if (skipWithoutBlender) test.skip(`${TEST_NAME}｜跳过：${skipReason}`, localeTest)
else test(TEST_NAME, localeTest)
