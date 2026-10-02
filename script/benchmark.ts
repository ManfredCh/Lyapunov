/**
 * Benchmark 工作台入口：先由产品自身调用现有官方套件准备能力，再启动 engine=benchmark 的原生 DSH Host。
 *
 * - 普通入口默认正式模式（--mode formal），复用现有账户验证 verifyFormalAccount 与账户会话来源，
 *   不新建账户 owner；只有显式 --mode developer 才使用调用方 Key 与开发独立运行根。
 * - 准备能力就是各套件插件 bench_prepare 使用的同一 prepareIsolatedSdk/prepareGymnasiumSdk；
 *   本入口不复制第二套检查逻辑，也不安装任何依赖（安装属于显式 ./lyapunov install-provider benchmark-*）。
 * - 不预置任务、不自动运行套件、不调用模型；世界与官方任务由用户在界面里经 bench_* 工具显式选择。
 * - 官方协议与成功判定留在套件插件内，本入口只负责准备与 Host 装配。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { benchmarkPaths, parseBenchmarkOptions } from './benchmark-options.ts'
import { PRODUCT_ROOT, hostRuntimeRoot } from './profile.ts'
import { verifyFormalAccount } from '../packages/lyapunov-product-bundle/src/account/formal.ts'
import { resolveAccountApiUrl } from '../packages/lyapunov-product-bundle/src/account/url.ts'
import { readRuntimeEnv } from '../packages/lyapunov-product-bundle/src/runtime-paths.ts'
import type { HostHandle } from './host.ts'

const usage = [
  'LyapunovDSH benchmark 工作台（可选官方套件，SDK 不随包）',
  './lyapunov benchmark [--provider libero|gymnasium] [--mode formal|developer] [--host-id <私有ID>] [--port 0-65535]',
  './lyapunov benchmark --check [--provider libero|gymnasium]   # 检查隔离 SDK；READY 退出 0，BLOCKED 退出 2（会按官方契约写入/刷新隔离 config.yaml，不安装、不启 Host）',
  '',
  '默认 --mode formal：需要已登录的账户会话 LYAPUNOV_ACCOUNT_TOKEN（与正式桌面同源，经 /me 验证后才启动）。',
  '显式 --mode developer：使用调用方提供的 DEEPSEEK_API_KEY 或 LYAPUNOV_DEVELOPER_AUTH_FILE 与独立开发运行根。',
  '',
  '未安装官方套件时先运行：',
  './lyapunov install-provider benchmark-libero      # 官方 LIBERO 隔离环境（Python 3.8.13）',
  './lyapunov install-provider benchmark-gymnasium   # Gymnasium + MuJoCo 隔离环境（Python 3.12）',
  '',
  '启动后在一个 engine=benchmark 的原生 DSH Host 中工作；本入口不预置任务，也不自动运行任何套件。',
].join('\n')

interface PrepareOutcome {
  status: 'READY' | 'BLOCKED'
  pythonPath: string
  isolatedRoot: string
  code?: string
  message?: string
}

let options
try {
  options = parseBenchmarkOptions(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  console.error(usage)
  process.exit(2)
}

if (options.help) {
  console.log(usage)
  process.exit(0)
}

// 正式模式先验身份：与 script/launch.ts 相同来源、相同 verifyFormalAccount，不新建第二套账户校验。
// 无会话或验证失败时在任何 SDK 检查与 Host 启动之前失败关闭（退出码 2），不隐式降级到开发模式；
// --check 只检查本机隔离环境，不要求登录。
const account = options.check || options.mode === 'developer' ? undefined : await verifyFormalAccount({
  apiUrl: resolveAccountApiUrl({ configured: readRuntimeEnv(process.env, 'apiUrl'), dev: false }),
  token: readRuntimeEnv(process.env, 'accountToken') ?? '',
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  console.error('benchmark 默认正式模式（--mode formal）：需要已登录账户会话 LYAPUNOV_ACCOUNT_TOKEN。')
  console.error('如需调用方自有 Key 的独立开发运行根，请显式传 --mode developer；本入口不会隐式绕过正式登录。')
  process.exit(2)
})

const paths = benchmarkPaths(PRODUCT_ROOT, options.provider)
// 准备能力按套件分属两个包：与 bench_prepare 走同一实现，不在入口里重复检查命令。
const prepared: PrepareOutcome = options.provider === 'libero'
  ? await (await import('../packages/benchmark-libero/src/prepare.ts')).prepareIsolatedSdk(paths)
  : await (await import('../packages/benchmark-gymnasium/src/prepare.ts')).prepareGymnasiumSdk(paths)

if (prepared.status !== 'READY') {
  const blocked = { provider: options.provider, ...prepared, install: './lyapunov install-provider benchmark-' + options.provider }
  console.log(JSON.stringify(blocked, null, 2))
  console.error('官方套件未就绪：' + (prepared.message ?? prepared.code))
  console.error('请在包内运行 ./lyapunov install-provider benchmark-' + options.provider + ' 建立隔离环境；本入口不安装 SDK、不改动系统 Python。')
  process.exit(2)
}

if (options.check) {
  // 检查隔离 SDK：不启动 Host、不开世界、不安装任何依赖；prepare 会按官方契约写入/刷新隔离 config.yaml。
  console.log(JSON.stringify({ provider: options.provider, ...prepared }, null, 2))
  process.exit(0)
}

// Host 装配按同一 provider 选择（runtime-patch 读取 LYAPUNOV_BENCHMARK_PROVIDER，默认 libero）。
process.env.LYAPUNOV_BENCHMARK_PROVIDER = options.provider
const { startWebHost } = await import('./host.ts')
const runtimeRoot = hostRuntimeRoot({ engine: 'benchmark', ...(options.hostId === undefined ? {} : { hostId: options.hostId }) })!
await mkdir(runtimeRoot, { recursive: true })
const receiptPath = join(runtimeRoot, 'benchmark-launch.json')
const benchmarkOutputRoot = join(runtimeRoot, 'bench-runs')
let host: HostHandle | undefined
let stopped: Promise<void> | undefined
const stop = () => stopped ??= (async () => { await host?.stop() })()
const abort = new AbortController()
const interrupt = () => { abort.abort(); void stop() }
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
let hostExit: number | undefined
try {
  host = await startWebHost({
    mode: options.mode, engine: 'benchmark', grasp: 'none', runtimeRoot,
    ...(account === undefined ? {} : { account }),
    ...(options.hostId === undefined ? {} : { hostId: options.hostId }),
    ...(options.port === undefined ? {} : { port: options.port }),
    signal: abort.signal,
  })
  await writeFile(receiptPath, JSON.stringify({
    status: 'running', engine: 'benchmark', mode: options.mode, provider: options.provider,
    accountId: account?.me.user.id ?? null,
    pythonPath: prepared.pythonPath, isolatedRoot: prepared.isolatedRoot,
    hostPid: host.pid, origin: host.origin, runtimeRoot, benchmarkOutputRoot, url: host.url,
  }, null, 2) + '\n')
  console.log('dsh web: ' + host.url)
  console.log('Benchmark 工作台已就绪：engine=benchmark，mode=' + options.mode + '，provider=' + options.provider + '，官方套件 Python=' + prepared.pythonPath + '。本入口不预置任务、不自动运行套件；请在界面里选择官方任务。启动回执：' + receiptPath)
  hostExit = await host.exited
} finally {
  await stop()
  await writeFile(receiptPath, JSON.stringify({
    status: 'stopped', engine: 'benchmark', mode: options.mode, provider: options.provider,
    hostPid: host?.pid, hostExited: hostExit ?? (host ? await host.exited : undefined),
  }, null, 2) + '\n')
}
// Host 自身异常退出时如实转发退出码，不伪造成功。
if (hostExit !== undefined && hostExit !== 0) process.exitCode = hostExit
