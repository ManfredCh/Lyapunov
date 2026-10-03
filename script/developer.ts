import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { authenticateDeveloperAccount, defaultDeveloperAccountFile } from './developer-account.ts'
import { loadDeveloperConfig } from './developer-config.ts'
import { ENGINE_CHOICES } from './engine-preference.ts'
import { claimRuntimeRoot, findAvailablePort } from './developer-instance.ts'

const { values, positionals } = parseArgs({
  args: process.argv.slice(2), allowPositionals: true,
  options: { config: { type: 'string' }, 'account-file': { type: 'string' }, username: { type: 'string' }, engine: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
})
if (values.help) {
  console.log('开发者通道：先验证包外开发者账号，再按 YAML 选择 provider 和仿真 Provider。')
  console.log('用法：node script/developer.ts [--config config/developer.yaml] [--engine <引擎>] [--account-file <路径>] [--username <用户名>]')
  console.log(`引擎：--engine > YAML engine > LYAPUNOV_SIM_ENGINE > 用户偏好 > 默认（Isaac 优先，未就绪回退 MuJoCo 并打印理由）；可选 ${ENGINE_CHOICES.join('|')}。`)
  process.exit(0)
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configPath = resolve(root, values.config ?? process.env.LYAPUNOV_DEV_CONFIG ?? 'config/developer.yaml')
const config = await loadDeveloperConfig(configPath)
if (config.auth.required) {
  const accountFile = resolve((values['account-file'] ?? process.env.LYAPUNOV_DEVELOPER_ACCOUNT_FILE ?? config.auth.accountFile ?? defaultDeveloperAccountFile()).replace(/^~(?=\/|$)/, homedir()))
  await authenticateDeveloperAccount(accountFile, values.username)
}
const env = { ...process.env, LYAPUNOV_DEVELOPER_PROVIDER: config.route.provider, LYAPUNOV_DEVELOPER_MODEL: config.route.model, LYAPUNOV_DEVELOPER_REASONING_EFFORT: config.route.reasoningEffort }
// 多实例并行：端口被占自动让位（port 0 保持操作系统分配），运行根被占自动认领 -2…-16 后缀目录。
const port = await findAvailablePort(config.port)
if (config.port !== 0 && port !== config.port) console.log(`首选端口 ${config.port} 被占用，本实例改用 ${port}`)
const claim = claimRuntimeRoot({ base: resolve(root, config.runtimeRoot), port, productRoot: root })
if (claim.holder) console.log(`检测到另一开发者实例正在运行（pid ${claim.holder.pid}，运行根 ${claim.holder.root}），本实例改用 ${claim.root}`)
console.log(`开发者实例：运行根 ${claim.root}，端口 ${port === 0 ? '由操作系统分配' : port}`)
// 引擎的真实优先级（**声明必须与行为逐字一致**，独立复核就是按这一段核对的）：
//   CLI `--engine` ＞ YAML `engine` ＞ LYAPUNOV_SIM_ENGINE ＞ 用户偏好 ＞ 代码默认。
// YAML 的 `engine` 与 CLI 一样是**显式覆盖**：它被转交给 launch 的 `--engine`，因此**压过环境变量**；
// 只有 CLI 与 YAML 都没给时，才落到共享解析的环境／偏好／默认三层。
// 这里**不自己判优先级、不自己填默认**：取值合法性与非法值拒绝仍归唯一 owner `engine-preference.ts`。
const engine = values.engine ?? config.engine
const args = ['script/launch.ts', '--mode', 'developer', '--surface', config.surface, ...(engine === undefined ? [] : ['--engine', engine]), '--grasp', config.grasp, '--port', String(port), '--runtime-root', claim.root, ...positionals]
const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' })
child.once('error', error => { console.error(`开发者通道启动失败：${error.message}`); process.exitCode = 1 })
process.once('SIGINT', () => child.kill('SIGINT'))
process.once('SIGTERM', () => child.kill('SIGTERM'))
const code = await new Promise<number>(done => child.once('exit', value => done(value ?? 1)))
process.exitCode = code
