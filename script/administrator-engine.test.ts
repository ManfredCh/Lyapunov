/**
 * 管理员入口的引擎选择合同测试：`node script/administrator-engine.test.ts`
 * 退出码 0=全部通过，1=有失败。
 *
 * 测的是 DEV-001 在本入口上的**真实差异**：`startAdministratorHost` 不再自带
 * `?? 'mujoco'`、CLI 的 `--engine` 不再有 `default: 'mujoco'`，省略选择原样进入
 * `startWebHost` 的共享解析（显式 > `LYAPUNOV_SIM_ENGINE` > 用户偏好 > `defaultEngine()`）。
 *
 * **边界（必须如实读）**：本文件不登录真实管理员账号、不联网、不起真实 Host。
 * 管理员身份（`loginAdministrator`）与 Web Host（`startWebHost`）只在**被 spawn 的子进程内**
 * 被替身替换（`node --import` 注册的解析钩子只作用于那个子进程，不进本测试进程、不改仓库
 * 运行实现、不影响其它测试）。因此这里验证的是**参数传递与生命周期合同**：省略时 `engine`
 * 原样为 `undefined`、显式值原样透传、Host 退出与 SIGTERM 各撤销一次会话。
 * 它**不等价于**"正式管理员账号登录成功"或"Isaac 真的装配进了 Host"。
 * 替身里的解析结果来自**真实 owner** `resolveEngine()`，本文件不复述优先级。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ENGINE_CHOICES, writeEnginePreference } from './engine-preference.ts'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..')
const checks: Array<{ name: string; ok: boolean; detail: string }> = []
const check = (name: string, ok: boolean, detail: string): void => { checks.push({ name, ok, detail }) }

const directory = mkdtempSync(join(tmpdir(), 'administrator-engine-'))
const preferenceFile = join(directory, 'engine.json')
const logFile = join(directory, 'stub-log.jsonl')
// 假凭据：只为让入口走完"读凭据 → 登录"这一步；登录本身在子进程里被替身接走，不出网。
const credentialsFile = join(directory, 'probe-credentials.json')
const authFile = join(directory, 'probe-auth.json')
const runtimeRootParent = join(directory, 'administrators')
const stubHost = join(directory, 'stub-host.mjs')
const stubAccount = join(directory, 'stub-account.mjs')
const loader = join(directory, 'loader.mjs')

writeFileSync(credentialsFile, JSON.stringify({ username: 'probe-admin', password: 'probe-not-a-real-credential' }) + '\n', { mode: 0o600 })
writeFileSync(authFile, '{}\n', { mode: 0o600 })
// 就绪的假 Isaac：判据看 `site-packages/isaacsim`；只有 `bin/python` 的不算（另有下例）。
const readyIsaac = join(directory, 'isaac-ready')
mkdirSync(join(readyIsaac, 'bin'), { recursive: true })
mkdirSync(join(readyIsaac, 'lib/python3.12/site-packages/isaacsim'), { recursive: true })
writeFileSync(join(readyIsaac, 'bin/python'), '')

writeFileSync(loader, [
  "import { registerHooks } from 'node:module'",
  'const entries = JSON.parse(process.env.ADMIN_STUB_MAP)',
  'registerHooks({',
  '  resolve(specifier, context, nextResolve) {',
  '    const hit = entries.find(entry => specifier === entry.suffix || specifier.endsWith(entry.suffix))',
  '    return hit ? { url: hit.url, format: "module", shortCircuit: true } : nextResolve(specifier, context)',
  '  },',
  '})',
].join('\n') + '\n')

// 替身报告 `startWebHost` 实际收到的 `engine`（参数传递合同），并用真实 `resolveEngine()` 算出解析结果。
writeFileSync(stubHost, [
  "import { appendFileSync } from 'node:fs'",
  `import { resolveEngine } from ${JSON.stringify(pathToFileURL(join(HERE, 'engine-preference.ts')).href)}`,
  "const log = value => appendFileSync(process.env.ADMIN_STUB_LOG, JSON.stringify(value) + '\\n')",
  // 自动判定事实可由测试注入（合成 GPU/许可），这样不必依赖运行测试的机器是否真有卡。
  "const auto = process.env.ADMIN_STUB_ENGINE_FACTS ? JSON.parse(process.env.ADMIN_STUB_ENGINE_FACTS) : {}",
  'export async function startWebHost(input) {',
  '  log({ event: "startWebHost", mode: input.mode, receivedEngine: input.engine ?? null, resolved: resolveEngine({ explicit: input.engine, env: input.parentEnvironment, productRoot: process.env.ADMIN_STUB_PRODUCT_ROOT, auto }), runtimeRoot: input.runtimeRoot, grasp: input.grasp, administrator: input.administrator, modelBilling: input.modelBilling })',
  '  let finish',
  '  const exited = new Promise(resolve => { finish = resolve })',
  // 真实 `startWebHost` 手里有子进程句柄，会一直把事件循环撑住；纯 pending 的 promise 撑不住，
  // 因此这里在"不自动退出"模式下用一个定时器顶替那个句柄，否则进程会以 unsettled TLA(13) 提前退出、收不到信号。
  '  const keepAlive = process.env.ADMIN_STUB_HOLD === "1" ? setInterval(() => {}, 1000) : setImmediate(() => finish(0))',
  '  return { pid: 4242, url: "http://127.0.0.1:1/?token=stub", origin: "http://127.0.0.1:1", dshHome: process.env.ADMIN_STUB_LOG + ".dsh", identity: "stub", engine: { engine: "none", source: "explicit", reason: "替身" }, exited, diagnostics: () => ({ exitCode: 0, signal: null, stderr: "" }), stop: async () => { log({ event: "stop" }); clearInterval(keepAlive); finish(0) } }',
  '}',
].join('\n') + '\n')

writeFileSync(stubAccount, [
  "import { appendFileSync } from 'node:fs'",
  "const log = value => appendFileSync(process.env.ADMIN_STUB_LOG, JSON.stringify(value) + '\\n')",
  'export async function loginAdministrator(input) {',
  '  log({ event: "loginAdministrator", username: input.username, passwordProvided: typeof input.password === "string" && input.password.length > 0 })',
  '  return { source: "vorynel-admin", apiUrl: input.apiUrl ?? "http://127.0.0.1:1", admin: { id: "probe-admin", username: input.username, role: "super_admin" }, cookieHeader: "admin_session=stub" }',
  '}',
  'export async function logoutAdministrator(input) {',
  '  log({ event: "logoutAdministrator", apiUrl: input.apiUrl })',
  '}',
].join('\n') + '\n')

const readLog = (): Array<Record<string, unknown>> => {
  if (!existsSync(logFile)) return []
  return readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) as Record<string, unknown> } catch { return { event: 'unparsable', line } } })
}
const startEntry = (log: Array<Record<string, unknown>>): Record<string, unknown> | undefined => log.find(entry => entry.event === 'startWebHost')
/** 每个用例都用这份环境：偏好文件、假解释器与替身都钉到临时目录，不读用户主目录、不出网。传 `undefined` 表示显式清空该键。 */
const childEnv = (values: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    LYAPUNOV_SIM_ENGINE: undefined,
    LYAUP_SIM_ENGINE: undefined,
    LYAPUNOV_ENGINE_PREFERENCE_FILE: preferenceFile,
    LYAPUNOV_ISAAC_PYTHON: join(directory, 'isaac-missing/bin/python'),
    LYAPUNOV_NEWTON_PYTHON: join(directory, 'newton-missing/bin/python'),
    ADMIN_STUB_LOG: logFile,
    ADMIN_STUB_PRODUCT_ROOT: directory,
    ADMIN_STUB_MAP: JSON.stringify([
      { suffix: './host.ts', url: pathToFileURL(stubHost).href },
      { suffix: '/account/administrator.ts', url: pathToFileURL(stubAccount).href },
    ]),
    ...values,
  }
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key]
  return merged
}
const entry = join(HERE, 'administrator.ts')
const adminArgs = ['--credentials-file', credentialsFile, '--auth-file', authFile, '--runtime-root', runtimeRootParent]
const run = (args: string[], values: Record<string, string | undefined> = {}): { status: number | null; stdout: string; stderr: string; log: Array<Record<string, unknown>> } => {
  rmSync(logFile, { force: true })
  const result = spawnSync('node', ['--import', loader, entry, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: childEnv(values) })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', log: readLog() }
}

try {
  // ── 1. 帮助：可选值来自唯一 owner，且不再宣称默认 mujoco ────────────────────
  const help = run(['--help'])
  check('管理员 --help 列出与唯一 owner 一致的可选引擎', help.status === 0 && help.stdout.includes(ENGINE_CHOICES.join('|')), `status=${help.status} stdout=${help.stdout.trim().slice(0, 300)}`)
  check('帮助不再把 --engine 说成默认 mujoco', !help.stdout.includes('默认 mujoco') && help.stdout.includes('省略时'), help.stdout.trim().slice(0, 300))
  check('--help 不读凭据、不启动 Host', help.log.length === 0 && !help.stderr.includes('ADMIN_CREDENTIALS'), `events=${help.log.map(item => item.event).join(',')} stderr=${help.stderr.trim().slice(0, 160)}`)

  // ── 2. 非法值在读凭据之前拒绝 ──────────────────────────────────────────────
  const rejected = run(['--engine', 'triton', '--credentials-file', join(directory, 'missing-credentials.json')])
  check('非法 --engine 在读取凭据之前被拒', rejected.status === 1 && rejected.stderr.includes('未知 Provider：triton') && rejected.stderr.includes(ENGINE_CHOICES.join('/')), `status=${rejected.status} stderr=${rejected.stderr.trim().slice(0, 240)}`)
  check('非法 --engine 不触碰凭据、不发起登录、不启动 Host', !rejected.stderr.includes('ADMIN_CREDENTIALS') && rejected.log.length === 0, `events=${rejected.log.map(item => item.event).join(',')}`)

  // ── 3. 显式覆盖：五个可选值都原样透传 ─────────────────────────────────────
  writeEnginePreference('isaac', { LYAPUNOV_ENGINE_PREFERENCE_FILE: preferenceFile })
  for (const choice of ENGINE_CHOICES) {
    const explicit = run([...adminArgs, '--engine', choice])
    const start = startEntry(explicit.log)
    check(`显式 --engine ${choice} 原样透传并保持 explicit`, explicit.status === 0 && start?.receivedEngine === choice && (start?.resolved as { engine?: string; source?: string } | undefined)?.engine === choice && (start?.resolved as { source?: string } | undefined)?.source === 'explicit', `status=${explicit.status} start=${JSON.stringify(start)}`)
  }

  // ── 4. 省略：不注入 mujoco，落到共享解析的偏好／环境／默认 ─────────────────
  const omitted = run(adminArgs)
  const omittedStart = startEntry(omitted.log)
  check('省略 --engine 时原样传 undefined（参数传递合同）', omitted.status === 0 && omittedStart?.receivedEngine === null, `status=${omitted.status} start=${JSON.stringify(omittedStart)}`)
  check('省略时落到用户偏好（不再被管理员入口固定成 mujoco）', (omittedStart?.resolved as { engine?: string; source?: string } | undefined)?.engine === 'isaac' && (omittedStart?.resolved as { source?: string } | undefined)?.source === 'preference', JSON.stringify(omittedStart?.resolved))

  const environment = startEntry(run(adminArgs, { LYAPUNOV_SIM_ENGINE: 'newton' }).log)
  check('省略时 LYAPUNOV_SIM_ENGINE 压过偏好', environment?.receivedEngine === null && (environment?.resolved as { engine?: string; source?: string } | undefined)?.engine === 'newton' && (environment?.resolved as { source?: string } | undefined)?.source === 'environment', JSON.stringify(environment?.resolved))

  rmSync(preferenceFile, { force: true })
  const fallback = startEntry(run(adminArgs).log)
  check('省略且无偏好、Isaac 未就绪时按共享默认回退 mujoco', (fallback?.resolved as { engine?: string; source?: string; reason?: string } | undefined)?.engine === 'mujoco' && (fallback?.resolved as { source?: string } | undefined)?.source === 'default' && String((fallback?.resolved as { reason?: string } | undefined)?.reason).includes('未就绪'), JSON.stringify(fallback?.resolved))

  const readyFacts = JSON.stringify({ isaacRuntime: true, isaacLicense: true, gpu: { accelerator: 'available', state: 'ready', headline: 'GPU 可用（合成）' }, mujocoRuntime: false })
  const ready = startEntry(run(adminArgs, { LYAPUNOV_ISAAC_PYTHON: join(readyIsaac, 'bin/python'), ADMIN_STUB_ENGINE_FACTS: readyFacts }).log)
  check('省略且 SDK+许可+GPU 都具备时按共享默认选 isaac', (ready?.resolved as { engine?: string; source?: string } | undefined)?.engine === 'isaac' && (ready?.resolved as { source?: string } | undefined)?.source === 'default', JSON.stringify(ready?.resolved))

  // 同一入口、同一个"Isaac 已装且许可已接受"，但 GPU 在本会话不可见 ⇒ 自动回退 mujoco（不谎报 GPU）。
  const hiddenFacts = JSON.stringify({ isaacRuntime: true, isaacLicense: true, gpu: { accelerator: 'session-hidden', state: 'device-hidden', headline: '本会话看不见 GPU 设备' }, mujocoRuntime: true })
  const hidden = startEntry(run(adminArgs, { LYAPUNOV_ISAAC_PYTHON: join(readyIsaac, 'bin/python'), ADMIN_STUB_ENGINE_FACTS: hiddenFacts }).log)
  check('省略且 GPU 不可用时默认回退 mujoco 并点名 GPU', (hidden?.resolved as { engine?: string; reason?: string } | undefined)?.engine === 'mujoco' && String((hidden?.resolved as { reason?: string } | undefined)?.reason).includes('GPU 未确认可用'), JSON.stringify(hidden?.resolved))

  // ── 5. 保留的既有语义：运行根按管理员 ID 隔离、退出撤销一次会话 ────────────
  const receipt = join(runtimeRootParent, Buffer.from('probe-admin').toString('base64url'), 'administrator-host.json')
  const receiptState = existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) as { status?: string; administrator?: { admin?: { id?: string } } } : undefined
  check('运行根仍按管理员 ID 隔离并写出回执', receiptState?.status === 'stopped' && receiptState.administrator?.admin?.id === 'probe-admin', JSON.stringify(receiptState))
  check('Host 退出后各登录／撤销一次会话', omitted.log.filter(item => item.event === 'loginAdministrator').length === 1 && omitted.log.filter(item => item.event === 'logoutAdministrator').length === 1, `events=${omitted.log.map(item => item.event).join(',')}`)

  // ── 6. SIGTERM：仍走 stop 并只撤销一次会话 ────────────────────────────────
  const held = await new Promise<{ status: number | null; signal: string | null; stderr: string; log: Array<Record<string, unknown>> }>((done, fail) => {
    rmSync(logFile, { force: true })
    const child = spawn('node', ['--import', loader, entry, ...adminArgs], { cwd: ROOT, env: childEnv({ ADMIN_STUB_HOLD: '1' }), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let signaled = false
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error('替身 Host 未在 30 秒内就绪')) }, 30000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', value => { stderr += value })
    child.stdout.on('data', value => {
      stdout += value
      // 回执行打印之后 CLI 才注册 SIGTERM 处理器，等它出现再稍缓一点发信号，避免抢在处理器之前。
      if (!signaled && stdout.includes('"status":"running"')) { signaled = true; setTimeout(() => child.kill('SIGTERM'), 200) }
    })
    child.on('exit', (code, signal) => { clearTimeout(timer); done({ status: code, signal, stderr, log: readLog() }) })
  })
  check('SIGTERM 触发 stop 且只撤销一次会话', held.status === 0 && held.log.filter(item => item.event === 'stop').length === 1 && held.log.filter(item => item.event === 'logoutAdministrator').length === 1, `status=${held.status} signal=${held.signal} events=${held.log.map(item => item.event).join(',')} stderr=${held.stderr.trim().slice(0, 300)}`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}

const failed = checks.filter(item => !item.ok)
for (const item of checks) console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}${item.ok ? '' : ' — ' + item.detail}`)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length) {
  console.log('\n失败明细：')
  for (const item of failed) console.log(`· ${item.name} — ${item.detail}`)
}
process.exit(failed.length ? 1 : 0)
