import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loginAdministrator, logoutAdministrator, type VerifiedAdministrator } from '../packages/lyapunov-product-bundle/src/account/administrator.ts'
import { ENGINE_CHOICES, isEngineChoice, type EngineChoice } from './engine-preference.ts'
import { startWebHost, type HostHandle, type HostInput } from './host.ts'
import { PRODUCT_ROOT } from './profile.ts'

export type AdministratorIdentity = Omit<VerifiedAdministrator, 'cookieHeader'>
export interface AdministratorHostInput {
  credentialsFile?: string
  modelAuthFile?: string
  apiUrl?: string
  /** 管理员运行目录的父目录；始终在其下按服务端 admin.id 隔离。 */
  runtimeRoot?: string
  port?: number
  engine?: HostInput['engine']
  grasp?: HostInput['grasp']
  nodeExecutable?: string
  signal?: AbortSignal
  parentEnvironment?: NodeJS.ProcessEnv
}

async function credentialsFromFile(path: string): Promise<{ username: string; password: string }> {
  const metadata = await stat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('ADMIN_CREDENTIALS_NOT_FOUND: 管理员凭据文件不存在，请用 --credentials-file 指定已有私有文件')
    throw error
  })
  if (process.platform !== 'win32' && (metadata.mode & 0o077)) throw new Error('ADMIN_CREDENTIALS_NOT_PRIVATE: 管理员凭据文件须仅当前用户可读')
  let value: unknown
  try { value = JSON.parse(await readFile(path, 'utf8')) } catch { throw new Error('ADMIN_CREDENTIALS_INVALID: 管理员凭据文件不是有效 JSON') }
  if (!value || typeof value !== 'object' || !('username' in value) || !('password' in value) || typeof value.username !== 'string' || typeof value.password !== 'string') throw new Error('ADMIN_CREDENTIALS_INVALID: 管理员凭据文件缺少用户名或密码')
  return { username: value.username, password: value.password }
}

/** 真实管理员认证只控制启动授权；模型仍使用既有 DSH developer 原生直连配置。 */
export async function startAdministratorHost(input: AdministratorHostInput = {}): Promise<{ administrator: AdministratorIdentity; host: HostHandle; runtimeRoot: string }> {
  input.signal?.throwIfAborted()
  const credentialsFile = resolve(input.credentialsFile ?? join(PRODUCT_ROOT, '.runtime/session-secrets/aliyun-admin-bootstrap/credentials.json'))
  const modelAuthFile = resolve(input.modelAuthFile ?? join(PRODUCT_ROOT, '.runtime/session-secrets/deepseek-auth.json'))
  const credentials = await credentialsFromFile(credentialsFile)
  await stat(modelAuthFile).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('ADMIN_MODEL_AUTH_NOT_FOUND: 模型凭据文件不存在，请用 --auth-file 指定已有私有文件')
    throw error
  })
  const verified = await loginAdministrator({ ...credentials, apiUrl: input.apiUrl })
  const administrator: AdministratorIdentity = { source: verified.source, apiUrl: verified.apiUrl, admin: { ...verified.admin } }
  // 编码服务端稳定ID，避免不同管理员共享既有 developer 的资产与配置。
  const runtimeRoot = join(resolve(input.runtimeRoot ?? join(PRODUCT_ROOT, '.runtime/administrators')), Buffer.from(verified.admin.id).toString('base64url'))
  let logout: Promise<void> | undefined
  const revokeSession = () => logout ??= logoutAdministrator({ apiUrl: verified.apiUrl, cookieHeader: verified.cookieHeader })
  try {
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 })
    const parentEnvironment = { ...(input.parentEnvironment ?? process.env), DEEPSEEK_API_KEY: undefined, LYAPUNOV_DEVELOPER_AUTH_FILE: modelAuthFile }
    // 省略引擎＝原样交给 `startWebHost` 的共享解析（显式 > LYAPUNOV_SIM_ENGINE > 偏好 > 默认）；
    // 管理员入口不再自带第二个默认，否则省略选择会被这里固定成 MuJoCo、跳过偏好。
    const current = await startWebHost({ mode: 'developer', runtimeRoot, port: input.port, engine: input.engine, grasp: input.grasp ?? 'analytic', nodeExecutable: input.nodeExecutable, signal: input.signal, parentEnvironment, administrator: administrator.admin, modelBilling: 'own-key' })
    const exited = current.exited.then(async code => { await revokeSession(); return code })
    void exited.catch(() => {})
    const host: HostHandle = { ...current, exited, stop: async () => { await current.stop(); await revokeSession() } }
    return { administrator, host, runtimeRoot }
  } catch (error) {
    await revokeSession()
    throw error
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, 'credentials-file': { type: 'string' }, 'auth-file': { type: 'string' }, 'api-url': { type: 'string' }, 'runtime-root': { type: 'string' }, port: { type: 'string', default: '0' }, engine: { type: 'string' }, grasp: { type: 'string', default: 'analytic' } } })
  if (values.help) {
    console.log([
      '超级管理员原生模型直连工作台',
      '用法：./lyapunov administrator [参数]',
      '  --credentials-file <路径>  现有管理员用户名与密码 JSON，权限须为私有',
      '  --auth-file <路径>         现有 DeepSeek 模型凭据 JSON',
      '  --api-url <地址>           管理员 API，默认 https://vorynel.com/admin/api',
      '  --runtime-root <目录>      管理员私有运行目录的父目录',
      '  --port <端口>              0–65535，默认 0 自动分配',
      `  --engine ${ENGINE_CHOICES.join('|')}  省略时按环境变量与用户偏好解析，默认 Isaac 优先、未就绪回退 MuJoCo`,
      '  --grasp none|analytic|graspgenx|anygrasp  默认 analytic',
      '  -h, --help                显示帮助并退出，不读取凭据或发起登录',
    ].join('\n'))
    process.exit(0)
  }
  const port = Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口无效')
  // 引擎的可选值与唯一 owner 同源（不再手抄一份）；省略＝交给共享解析，因此只在给了值时校验。
  // 这里在 `startAdministratorHost` 之前，非法值不会先读到管理员凭据。
  const engine = values.engine
  if (engine !== undefined && !isEngineChoice(engine)) throw new Error(`未知 Provider：${engine}（可选 ${ENGINE_CHOICES.join('/')}）`)
  if (!['none', 'analytic', 'graspgenx', 'anygrasp'].includes(values.grasp!)) throw new Error('未知 Provider')
  const { administrator, host, runtimeRoot } = await startAdministratorHost({ credentialsFile: values['credentials-file'], modelAuthFile: values['auth-file'], apiUrl: values['api-url'], runtimeRoot: values['runtime-root'], port, engine: engine as EngineChoice | undefined, grasp: values.grasp as HostInput['grasp'] })
  const connectionFile = join(runtimeRoot, 'administrator-host.json')
  const publicState = { administrator, mode: 'developer', modelBilling: 'own-key', pid: host.pid, origin: host.origin, dshHome: host.dshHome, runtimeRoot }
  await writeFile(connectionFile, JSON.stringify({ ...publicState, status: 'running', url: host.url, time: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ ...publicState, status: 'running', connectionFile }))
  const stop = () => { void host.stop().catch(error => { console.error(String(error.message ?? error)); process.exitCode = 1 }) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  let exitCode: number, exitError: string | undefined
  try { exitCode = await host.exited } catch (error) {
    exitCode = 1
    exitError = error instanceof Error ? error.message : '管理员会话撤销失败'
  }
  const diagnostics = exitCode !== 0 ? host.diagnostics() : undefined
  if (diagnostics) console.error(JSON.stringify({ event: 'host-exit', administrator: administrator.admin, pid: host.pid, exitCode, diagnostics, error: exitError }))
  await writeFile(connectionFile, JSON.stringify({ ...publicState, status: 'stopped', exitCode, diagnostics, error: exitError, time: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })
  process.exitCode = exitCode
}
