/**
 * 终端 `--engine` 入口的局部测试：`node script/terminal-options.test.ts`（也可 `bun run`）。
 * 退出码 0=全部通过，1=有失败。不联网、不起 Host（除被 spawn 的子进程本身就是被测对象）。
 *
 * 测的是**真实差异**，不是复述源码：
 *  · 参数解析：`--engine` 合法值进选项对象、非法值与 `--attach` 冲突被拒、未给时选项对象形状不变；
 *  · 解析链：显式 > `LYAPUNOV_SIM_ENGINE`（含旧名）> 偏好文件 > `none`，偏好文件用**真实 owner**
 *    `writeEnginePreference` 写入临时文件（`LYAPUNOV_ENGINE_PREFERENCE_FILE` 覆盖，不碰用户主目录）；
 *  · 进程级：`--help` 真的列出 `--engine`、坏环境值在起 Host 前就退出非 0。
 *
 * 边界：真 Host 装配与原生 Agent 行为要在产品会话里另验（本文件只能证明"参数被正确解析与拒绝"）。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENGINE_CHOICES, resolveEngine, writeEnginePreference } from './engine-preference.ts'
import { parseTerminalOptions, terminalEngineChoice, type TerminalEngine } from './terminal-options.ts'

const HERE = import.meta.dirname
const checks: Array<{ name: string; ok: boolean; detail: string }> = []
const check = (name: string, ok: boolean, detail: string): void => { checks.push({ name, ok, detail }) }
const throws = (run: () => unknown): string => { try { run(); return '' } catch (error) { return error instanceof Error ? error.message : String(error) } }

const ENVIRONMENT = { cwd: '/tmp', pwd: '/tmp' }
const directory = mkdtempSync(join(tmpdir(), 'terminal-engine-'))
const preferenceFile = join(directory, 'engine.json')
/**
 * 每个用例都用这份环境：偏好文件钉到临时路径，绝不读用户 ~/.config/lyapunov/engine.json。
 * 传 `undefined` 表示**显式清空**该键（覆盖默认值），未传的键不影响默认。
 */
const env = (values: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const merged: NodeJS.ProcessEnv = { ...values, LYAPUNOV_ENGINE_PREFERENCE_FILE: values.LYAPUNOV_ENGINE_PREFERENCE_FILE ?? preferenceFile }
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key]
  return merged
}

try {
  // ── 1. 参数解析 ────────────────────────────────────────────────────────────
  for (const choice of ENGINE_CHOICES) {
    const options = parseTerminalOptions(['--engine', choice], ENVIRONMENT)
    check(`--engine ${choice} 进选项对象`, options.engine === choice, `engine=${String(options.engine)}`)
  }
  const plain = parseTerminalOptions([], ENVIRONMENT)
  check('未给 --engine 时选项对象保持原有形状', !Object.hasOwn(plain, 'engine'), `keys=${Object.keys(plain).join(',')}`)

  const withRoute = parseTerminalOptions(['--engine', 'mujoco', '-m', 'deepseek-official/deepseek-v4-flash', '--runtime-root', directory], ENVIRONMENT)
  check('--engine 不挤掉既有参数', withRoute.engine === 'mujoco' && withRoute.startup.provider === 'deepseek-official' && withRoute.startup.model === 'deepseek-v4-flash' && withRoute.runtimeRoot === directory,
    JSON.stringify({ engine: withRoute.engine, provider: withRoute.startup.provider, model: withRoute.startup.model, runtimeRoot: withRoute.runtimeRoot }))
  check('--engine 不写进会话 startup 配置', !Object.hasOwn(withRoute.startup, 'engine'), `startup keys=${Object.keys(withRoute.startup).join(',')}`)

  const badValue = throws(() => parseTerminalOptions(['--engine', 'triton'], ENVIRONMENT))
  check('非法 --engine 被拒', badValue.includes('--engine 只接受'), badValue || '未抛错')

  const attachConflict = throws(() => parseTerminalOptions(['--attach', 'http://127.0.0.1:9/x', '--engine', 'mujoco'], ENVIRONMENT))
  check('--attach 与 --engine 冲突被拒', attachConflict.includes('不接受本地 --engine'), attachConflict || '未抛错')
  const attachConflictReversed = throws(() => parseTerminalOptions(['--engine', 'mujoco', '--attach', 'http://127.0.0.1:9/x'], ENVIRONMENT))
  check('冲突判定与参数顺序无关', attachConflictReversed.includes('不接受本地 --engine'), attachConflictReversed || '未抛错')
  const attachOnly = parseTerminalOptions(['--attach', 'http://127.0.0.1:9/x'], ENVIRONMENT)
  check('--attach 本身不要求引擎参数', attachOnly.attach === 'http://127.0.0.1:9/x' && !Object.hasOwn(attachOnly, 'engine'), `engine=${String(attachOnly.engine)}`)

  // ── 2. 解析链（显式 > 环境 > 偏好 > none） ──────────────────────────────────
  writeEnginePreference('isaac', env())                                  // 真实 owner 写临时偏好文件
  check('偏好文件写入临时路径', env().LYAPUNOV_ENGINE_PREFERENCE_FILE === preferenceFile, String(env().LYAPUNOV_ENGINE_PREFERENCE_FILE))

  const explicitWins = terminalEngineChoice('mujoco', env({ LYAPUNOV_SIM_ENGINE: 'newton' }))
  check('显式 --engine 压过环境与偏好', explicitWins.engine === 'mujoco' && explicitWins.source === '--engine', JSON.stringify(explicitWins))
  const envWins = terminalEngineChoice(undefined, env({ LYAPUNOV_SIM_ENGINE: 'newton' }))
  check('环境变量压过偏好', envWins.engine === 'newton' && envWins.source === 'LYAPUNOV_SIM_ENGINE', JSON.stringify(envWins))
  const legacyName = terminalEngineChoice(undefined, env({ LYAUP_SIM_ENGINE: 'mujoco' }))
  check('旧环境名 LYAUP_SIM_ENGINE 沿用既有规则', legacyName.engine === 'mujoco' && legacyName.source === 'LYAPUNOV_SIM_ENGINE', JSON.stringify(legacyName))
  const fromPreference = terminalEngineChoice(undefined, env())
  check('无参数无环境时用用户偏好', fromPreference.engine === 'isaac' && fromPreference.source === 'preference', JSON.stringify(fromPreference))

  const empty = terminalEngineChoice(undefined, env({ LYAPUNOV_ENGINE_PREFERENCE_FILE: join(directory, 'absent.json') }))
  check('完全未配置时保持默认 none', empty.engine === 'none' && empty.source === 'default', JSON.stringify(empty))
  const badEnv = throws(() => terminalEngineChoice(undefined, env({ LYAPUNOV_SIM_ENGINE: 'triton' })))
  check('非法环境值报错不回退', badEnv.includes('未知 Provider'), badEnv || '未抛错')
  const badPreference = terminalEngineChoice(undefined, env({ LYAPUNOV_ENGINE_PREFERENCE_FILE: join(directory, 'broken.json'), LYAPUNOV_SIM_ENGINE: undefined }))
  check('偏好文件非法时不猜测（回默认 none）', badPreference.engine === 'none' && badPreference.source === 'default', JSON.stringify(badPreference))

  // ── 2′. 终端不再自持优先级：三层与唯一 owner 逐字同结论；空环境值＝未配置 ──────
  // 旧实现在这里把 `LYAPUNOV_SIM_ENGINE=""` 当非法值直接抛错，而 owner（以及 launch/arch/desktop）
  // 一律视为"未配置"——同一个用户在不同入口得到不同结果，正是 DEV-001/002 在终端入口的漏项。
  const emptyEnvValue = terminalEngineChoice(undefined, env({ LYAPUNOV_SIM_ENGINE: '' }))
  check('空环境变量视为未配置，落到偏好（不再抛错）', emptyEnvValue.engine === 'isaac' && emptyEnvValue.source === 'preference', JSON.stringify(emptyEnvValue))
  const blankEnvValue = terminalEngineChoice(undefined, env({ LYAPUNOV_SIM_ENGINE: '   ' }))
  check('空白环境变量同样视为未配置', blankEnvValue.engine === 'isaac' && blankEnvValue.source === 'preference', JSON.stringify(blankEnvValue))
  const emptyEnvNoPreference = terminalEngineChoice(undefined, env({ LYAPUNOV_SIM_ENGINE: '', LYAPUNOV_ENGINE_PREFERENCE_FILE: join(directory, 'absent-2.json') }))
  check('空环境变量 + 无偏好 ⇒ 仍是终端的 none 缺省', emptyEnvNoPreference.engine === 'none' && emptyEnvNoPreference.source === 'default', JSON.stringify(emptyEnvNoPreference))

  const sourceLabels: Record<string, TerminalEngine['source']> = { explicit: '--engine', environment: 'LYAPUNOV_SIM_ENGINE', preference: 'preference', default: 'default' }
  for (const [label, values, explicit] of [
    ['显式', { LYAPUNOV_SIM_ENGINE: 'newton' }, 'benchmark'],
    ['环境', { LYAPUNOV_SIM_ENGINE: 'newton' }, undefined],
    ['偏好', {}, undefined],
    ['空环境+偏好', { LYAPUNOV_SIM_ENGINE: '' }, undefined],
  ] as Array<[string, Record<string, string | undefined>, string | undefined]>) {
    const environment = env(values)
    const terminal = terminalEngineChoice(explicit as never, environment)
    const owner = resolveEngine({ ...(explicit === undefined ? {} : { explicit }), env: environment, productRoot: join(HERE, '..') })
    check(`与 owner 同引擎同来源：${label}`, terminal.engine === owner.engine && terminal.source === sourceLabels[owner.source], JSON.stringify({ terminal, owner: { engine: owner.engine, source: owner.source } }))
  }

  // ── 3. 进程级 ──────────────────────────────────────────────────────────────
  const childEnv: NodeJS.ProcessEnv = env()
  delete childEnv.LYAPUNOV_SIM_ENGINE
  delete childEnv.LYAUP_SIM_ENGINE

  const help = spawnSync(process.execPath, [join(HERE, 'terminal.ts'), '--help'], { encoding: 'utf8', env: childEnv, timeout: 120000 })
  check('--help 列出 --engine 且退出 0', help.status === 0 && help.stdout.includes('--engine <') && help.stdout.includes('默认 none'), `status=${help.status} 含 --engine=${help.stdout.includes('--engine <')}`)

  const conflict = spawnSync(process.execPath, [join(HERE, 'terminal.ts'), '--attach', 'http://127.0.0.1:9/x', '--engine', 'mujoco'], { encoding: 'utf8', env: childEnv, timeout: 120000 })
  check('进程级：--attach + --engine 退出非 0 且说明原因', conflict.status === 1 && conflict.stderr.includes('不接受本地 --engine'), `status=${conflict.status}`)

  const badEnvChild = spawnSync(process.execPath, [join(HERE, 'terminal.ts'), '--runtime-root', join(directory, 'never-used'), '--prompt', 'x'], {
    encoding: 'utf8', env: { ...childEnv, LYAPUNOV_SIM_ENGINE: 'triton' }, timeout: 120000,
  })
  check('进程级：非法 LYAPUNOV_SIM_ENGINE 在起 Host 前失败', badEnvChild.status === 1 && badEnvChild.stderr.includes('未知 Provider：triton'), `status=${badEnvChild.status}`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}

for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name} :: ${item.detail}`)
const failed = checks.filter(item => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
process.exitCode = failed.length === 0 ? 0 : 1
