import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseTerminalOptions, mergeTerminalPrompt, terminalEngineChoice } from './terminal-options.ts'
import { ENGINE_CHOICES, pinEnginePreferenceFile } from './engine-preference.ts'
import { backendEnvironment, DSH_BIN, prepareProfile, PRODUCT_ROOT } from './profile.ts'
import { runtimePatch } from './runtime-patch.ts'
import { ensurePluginModule } from './ensure-plugin.ts'
import { pathToFileURL } from 'node:url'
import { remoteScopePlugin } from './terminal-build.ts'
import { verifyFormalAccount } from '../packages/lyapunov-product-bundle/src/account/formal.ts'
import { resolveAccountApiUrl } from '../packages/lyapunov-product-bundle/src/account/url.ts'
import { readRuntimeEnv } from '../packages/lyapunov-product-bundle/src/runtime-paths.ts'

const options = parseTerminalOptions(process.argv.slice(2), { cwd: process.cwd(), pwd: process.env.PWD })
if (options.help) {
  const invocation = process.versions.bun ? 'npm exec bun@1.3.13 -- script/terminal.ts' : './lyapunov terminal'
  console.log(`用法：${invocation} [project] [--cwd <目录>] [-c | -s <会话ID> | --resume <会话ID>] [--fork]\n  [--mode formal|developer] [-m <provider/model>] [--reasoning-effort <档位>] [--agent <preset>]\n  [--prompt <文本>] [--prompt-mode <send|prefill>] [--runtime-root <私有根>] [--fullscreen]\n  [--engine <${ENGINE_CHOICES.join('|')}>]\n  [--attach <DSH Web URL> [--token <启动token>]]\n正式模式使用 LYAPUNOV_API_URL 与已登录的 LYAPUNOV_ACCOUNT_TOKEN，身份由账户 API 验证。\n远端鉴权也可使用 LYAPUNOV_ATTACH_TOKEN/LYAPUNOV_ATTACH_COOKIE；连接远端时项目路径属于远端，附件路径属于本地。\n--fullscreen 本地与 --attach 远端共用同一全屏呈现；stdin/stdout 不是真实终端时明确拒绝并保持行式终端。\n本地引擎默认 none（不装配仿真）：显式 --engine、LYAPUNOV_SIM_ENGINE 或界面里选过的偏好会为本次 Host 装配对应 Provider；引擎在 Host 启动时装配，远端 --attach 的引擎归远端 Host，本地 --engine 会被拒绝。`)
} else {
  let piped: string | undefined
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding('utf8')
    piped = ''
    for await (const chunk of process.stdin) piped += chunk
  }
  const startup = { ...options.startup, prompt: mergeTerminalPrompt(piped, options.startup.prompt) }
  if (options.attach) {
    const module = join(PRODUCT_ROOT, 'packages/lyapunov-terminal/dist/remote-terminal.js')
    if (process.versions.bun) {
      const built = await Bun.build({ entrypoints: [join(PRODUCT_ROOT, 'packages/lyapunov-terminal/src/remote-terminal.ts')], outdir: join(PRODUCT_ROOT, 'packages/lyapunov-terminal/dist'), target: 'node', format: 'esm', external: ['@deepseek-ai/*'], plugins: [remoteScopePlugin()] })
      if (!built.success) throw new AggregateError(built.logs, '远端终端构建失败')
    }
    if (!existsSync(module)) throw new Error('REMOTE_TERMINAL_MISSING: 需要构建包含远端终端的完整软件。')
    const { runRemoteTerminal } = await import(pathToFileURL(module).href)
    process.exitCode = await runRemoteTerminal({ url: options.attach, token: options.token ?? process.env.LYAPUNOV_ATTACH_TOKEN, cookie: process.env.LYAPUNOV_ATTACH_COOKIE, startup, ...(options.fullscreen ? { fullscreen: true } : {}) })
  } else {
  const mode = options.mode ?? 'developer'
  // 与 Web/Desktop 共用账户验证和身份目录，不以开发者凭据替代正式账户。
  const account = mode === 'formal' ? await verifyFormalAccount({
    apiUrl: resolveAccountApiUrl({ configured: readRuntimeEnv(process.env, 'apiUrl'), dev: false }),
    token: readRuntimeEnv(process.env, 'accountToken') ?? '',
  }) : undefined
  // 便携入口由Node执行，直接使用随包dist，不以复制后的源码时间戳触发Bun构建。
  if (process.versions.bun) await ensurePluginModule('lyapunov-terminal')
  else if (!existsSync(join(PRODUCT_ROOT, 'packages/lyapunov-terminal/dist/plugin.js'))) throw new Error('TERMINAL_PLUGIN_MISSING: 终端预编译插件不存在，请使用完整便携包。')
  const runtimeRoot = resolve(options.runtimeRoot ?? join(PRODUCT_ROOT, '.runtime/terminal'))
  // 引擎在 Host 启动时装配（运行中的 Host 换不了引擎），所以本次会话的引擎必须在起 Host 前定下来。
  const engine = terminalEngineChoice(options.engine)
  // 与 launch.ts 同一条可见性规则：显式参数不重复播报，隐式解析出来的引擎必须说明来源，
  // 否则"界面上写着 Isaac、实际跑的是 MuJoCo"没人能发现。
  if (options.engine === undefined && engine.source !== 'default') console.log(`物理引擎：${engine.engine}（来源：${engine.source === 'preference' ? '用户偏好' : 'LYAPUNOV_SIM_ENGINE'}）`)
  const runtime = await prepareProfile({ mode, surface: 'web', runtimeRoot, accountId: account?.me.user.id })
  const patch = await runtimePatch({ dir: runtime.dir, mode, surface: 'web', sceneRoot: runtime.paths.sceneRoot, domains: runtime.paths, benchmarkOutputRoot: engine.engine === 'benchmark' ? join(runtime.paths.root, 'bench-runs') : undefined, engine: engine.engine, grasp: 'none', accountApiUrl: account?.apiUrl, accountId: account?.me.user.id })
  const manifest = JSON.parse(await readFile(join(runtime.dir, 'package.json'), 'utf8'))
  // 旧原型可能已经持久装配此bundle；保留原件，避免本次再插入同一节点。
  const terminalBundle = manifest.dsh.profile.bundles.includes('@lyapunov/terminal') ? [] : ['--patch', join(PRODUCT_ROOT, 'packages/lyapunov-terminal/cordis.patch.yml')]
  // 终端UI只属于本次调用；持久developer-web Profile仍可供普通Web/桌面使用。
  const launchDir = await mkdtemp(join(runtime.dir, '.terminal-launch-'))
  try {
    const optionsPatch = join(launchDir, 'options.patch.yml')
    await writeFile(optionsPatch, [
      { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: false } },
      { id: 'lyapunov-terminal-client', config: { enabled: true, ...(options.fullscreen ? { fullscreen: true } : {}), startup } },
    ].map(row => '- ' + JSON.stringify(row)).join('\n') + '\n')
    const env = await backendEnvironment(mode, runtime.paths, { isolated: true, account })
    // 把**解析后的**引擎回写给 Host：界面按它显示"当前跑的是哪个引擎"（与 launch.ts 同一口径）。
    env.LYAPUNOV_SIM_ENGINE = engine.engine
    // 终端**总是**隔离（`isolated: true` ⇒ HOME/XDG 换成私有根），所以偏好文件必须钉成
    // 本入口刚读过的那个绝对路径；否则 Host 里的引擎切换与偏好读回落在另一个文件上，
    // "保存偏好、重启生效"在终端入口失效（与 launch.ts:41／host.ts:54 同一行钉子）。
    pinEnginePreferenceFile(env)
    if (engine.engine === 'benchmark') env.LYAPUNOV_BENCH_OUTPUT = join(runtime.paths.root, 'bench-runs')
    // 编辑器与终端能力只属于此交互入口，不扩大正式/普通Web Host的环境继承。
    for (const key of ['VISUAL', 'EDITOR', 'TERM', 'COLORTERM', 'XAUTHORITY', 'LYAPUNOV_CLIPBOARD_XCLIP', 'LYAPUNOV_CLIPBOARD_XSEL', 'LYAPUNOV_CLIPBOARD_WL_PASTE']) if (process.env[key]) env[key] = process.env[key]
    const child = spawn(process.versions.bun ? 'node' : process.execPath, [DSH_BIN, '--profile', runtime.profile, '--patch', patch, ...terminalBundle, '--patch', optionsPatch, '--no-open', '--port', '0'], { cwd: PRODUCT_ROOT, env, stdio: 'inherit' })
    // 前台TTY的SIGINT已由内核送达同组Host，不能再次转发导致原生强制退出。
    // 非TTY进程仍需显式转发；SIGTERM始终用于启动器的进程管理关闭。
    process.on('SIGINT', () => { if (!process.stdin.isTTY) child.kill('SIGINT') })
    process.once('SIGTERM', () => child.kill('SIGTERM'))
    process.exitCode = await new Promise<number>(done => { child.once('error', error => { console.error(error.message); done(1) }); child.once('exit', code => done(code ?? 1)) })
  } finally {
    await rm(launchDir, { recursive: true, force: true })
  }
  }
}
