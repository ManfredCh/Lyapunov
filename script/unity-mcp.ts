/**
 * Unity MCP 接线（ENV-03/25 第一片）：把**显式配置**的 Unity MCP 服务端接成上游
 * `@deepseek-ai/dsh-mcp-client` 的**一条实例**。
 *
 * 本模块只做三件事：
 *   1. 解析显式配置（`LYAPUNOV_UNITY_MCP_COMMAND` 或 `LYAPUNOV_UNITY_MCP_URL`，二选一）；
 *   2. 做必要校验（互斥、JSON 形状、URL scheme、transport 取值）——非法就抛，不静默挑一个；
 *   3. 产出装配行（`unityMcpPluginEntry()`），由 `script/runtime-patch.ts` 插进插件表。
 *
 * 明确**不做**的事：
 *   - 不实现、不复制 MCP 客户端：连接/握手/工具注册/重连/资源读取全归上游那一条实例；
 *   - 不安装、不启动 Unity，也不替用户拉起 MCP 服务端；
 *   - 不做可达性探测：`TCP 连上了` ≠ `MCP 握手成功` ≠ `Unity 工具可用`。
 *     真实连接状态在宿主里用原生 `list_mcp_servers`（`@lyapunov/mcp-extras`，同一连接）读，
 *     本模块不伪造第二次读数；
 *   - 未配置 = 返回 `undefined`：不插行、不建连接、不阻塞其他插件。
 *
 * 错误信息只报**变量名 + 期望格式**，不回显解析器原文，也不回显 URL（URL 的 query/userinfo 可能带 token）。
 */
import { resolve } from 'node:path'
import { PRODUCT_ROOT } from './profile.ts'

/** 连接器插件名：与 Blender 实例同一个上游包，产品不新建第二个 MCP 客户端。 */
export const MCP_CLIENT_PLUGIN = '@deepseek-ai/dsh-mcp-client'
/** 固定 namespace：模型侧工具名形如 `mcp__unity__<原名>`，与 Blender 的 `mcp__blender__*` 互不遮蔽。 */
export const UNITY_SERVER_NAME = 'unity'
/** 固定单次工具调用超时：Unity 编辑器操作在主线程排队，给足余量。 */
export const UNITY_TOOL_CALL_TIMEOUT_MS = 180_000

/** 显式配置用的环境变量名（唯一出处：文档与体检都引用这里）。 */
export const UNITY_MCP_ENV = {
  command: 'LYAPUNOV_UNITY_MCP_COMMAND',
  args: 'LYAPUNOV_UNITY_MCP_ARGS',
  env: 'LYAPUNOV_UNITY_MCP_ENV',
  cwd: 'LYAPUNOV_UNITY_MCP_CWD',
  url: 'LYAPUNOV_UNITY_MCP_URL',
  transport: 'LYAPUNOV_UNITY_MCP_TRANSPORT',
  headers: 'LYAPUNOV_UNITY_MCP_HEADERS',
} as const

/** 全部 Unity MCP 环境变量名。 */
export const UNITY_MCP_ENV_NAMES: readonly string[] = Object.values(UNITY_MCP_ENV)

export type UnityMcpTransport = 'stdio' | 'streamable-http' | 'sse'

/** stdio 目标：字段与上游 `StdioConfig` 对应。 */
export interface UnityMcpStdioConfig {
  transport: 'stdio'
  serverName: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  toolCallTimeoutMs: number
  failOnStartupError: boolean
}

/** http 目标：字段与上游 `StreamableHttpConfig` 对应。 */
export interface UnityMcpHttpConfig {
  transport: 'streamable-http' | 'sse'
  serverName: string
  url: string
  headers: Record<string, string>
  toolCallTimeoutMs: number
  failOnStartupError: boolean
}

export type UnityMcpConfig = UnityMcpStdioConfig | UnityMcpHttpConfig

/** 与 `runtime-patch.ts` 的 `RuntimePluginInsert` 同形（不反向 import，避免装配表与解析互相依赖）。 */
export interface UnityMcpPluginEntry { id: string; name: string; config: Record<string, unknown> }

/**
 * `failOnStartupError` 固定 false，与 Blender 实例（true）刻意不同：Blender 是产品自己拉起的进程；
 * Unity 编辑器由用户持有、随时可能关闭，绑成致命错误等于「用户关掉 Unity，产品就起不来」。
 * 代价是连不上时 `mcp__unity__*` 工具不出现（能力如实缺失，不给替身），上游按默认策略重连。
 */
const FAIL_ON_STARTUP_ERROR = false

function configError(code: string, message: string): Error {
  return new Error(`${code}: ${message}`)
}

function readVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

/** JSON 字符串字典，如 `{"KEY":"value"}`：拒绝数组、null、非字符串值；错误不回显原文。 */
function parseStringDict(raw: string, name: string, code: string): Record<string, string> {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw configError(code, `${name} 必须是 JSON 字符串字典，如 {"KEY":"value"}`) }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw configError(code, `${name} 必须是 JSON 字符串字典，如 {"KEY":"value"}`)
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') throw configError(code, `${name} 的每个值都必须是字符串（键 "${key}" 不是）`)
    out[key] = value
  }
  return out
}

/** JSON 字符串数组，如 `["--transport","stdio"]`：原样传给子进程，不经 shell 展开。 */
function parseStringArray(raw: string, name: string, code: string): string[] {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw configError(code, `${name} 必须是 JSON 字符串数组，如 ["--transport","stdio"]`) }
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw configError(code, `${name} 必须是 JSON 字符串数组，如 ["--transport","stdio"]`)
  return parsed as string[]
}

/** 已设置但当前目标用不到的变量名（只报名字）：半配置要 fail-closed，不静默挑一个。 */
function unusedVariables(env: NodeJS.ProcessEnv, used: readonly string[]): string[] {
  return UNITY_MCP_ENV_NAMES.filter(name => !used.includes(name) && readVar(env, name) !== undefined)
}

/**
 * 解析显式配置。`undefined` = 未配置（不加载、不阻塞其他功能）；
 * 冲突/非法/半配置一律抛错，绝不静默降级。
 */
export function unityMcpConfig(env: NodeJS.ProcessEnv = process.env): UnityMcpConfig | undefined {
  const command = readVar(env, UNITY_MCP_ENV.command)
  const url = readVar(env, UNITY_MCP_ENV.url)
  const transportVar = readVar(env, UNITY_MCP_ENV.transport)
  if (command !== undefined && url !== undefined) {
    throw configError('UNITY_MCP_CONFIG_CONFLICT', `${UNITY_MCP_ENV.command} 与 ${UNITY_MCP_ENV.url} 不能同时设置：二选一（stdio 命令或 http 端点）`)
  }
  if (command === undefined && url === undefined) {
    const leftovers = unusedVariables(env, [])
    if (leftovers.length) {
      throw configError('UNITY_MCP_CONFIG_INCOMPLETE', `${leftovers.join('、')} 已设置但没有给出 ${UNITY_MCP_ENV.command} 或 ${UNITY_MCP_ENV.url}：补上目标，或清掉这些变量`)
    }
    return undefined
  }

  if (command !== undefined) {
    if (transportVar !== undefined && transportVar !== 'stdio') {
      throw configError('UNITY_MCP_CONFIG_TRANSPORT', `${UNITY_MCP_ENV.transport} 只对 http 目标有意义；stdio 目标不要设置它`)
    }
    const argsVar = readVar(env, UNITY_MCP_ENV.args)
    const envVar = readVar(env, UNITY_MCP_ENV.env)
    const cwdVar = readVar(env, UNITY_MCP_ENV.cwd)
    return {
      transport: 'stdio',
      serverName: UNITY_SERVER_NAME,
      command,
      args: argsVar === undefined ? [] : parseStringArray(argsVar, UNITY_MCP_ENV.args, 'UNITY_MCP_CONFIG_ARGS'),
      env: envVar === undefined ? {} : parseStringDict(envVar, UNITY_MCP_ENV.env, 'UNITY_MCP_CONFIG_ENV'),
      // 默认产品根：不猜用户工程目录，也不继承宿主 cwd（宿主 cwd 不是配置）。
      cwd: cwdVar === undefined ? PRODUCT_ROOT : resolve(PRODUCT_ROOT, cwdVar),
      toolCallTimeoutMs: UNITY_TOOL_CALL_TIMEOUT_MS,
      failOnStartupError: FAIL_ON_STARTUP_ERROR,
    }
  }

  // 解析失败**不回显 URL**：query 或 userinfo 里可能带 token。
  let protocol: string
  try { protocol = new URL(url as string).protocol } catch { throw configError('UNITY_MCP_CONFIG_URL', `${UNITY_MCP_ENV.url} 必须是可解析的 http/https URL`) }
  if (protocol !== 'http:' && protocol !== 'https:') throw configError('UNITY_MCP_CONFIG_URL', `${UNITY_MCP_ENV.url} 的 scheme 必须是 http 或 https`)
  if (transportVar !== undefined && transportVar !== 'streamable-http' && transportVar !== 'sse') {
    throw configError('UNITY_MCP_CONFIG_TRANSPORT', `${UNITY_MCP_ENV.transport} 只能是 streamable-http 或 sse`)
  }
  const headersVar = readVar(env, UNITY_MCP_ENV.headers)
  return {
    transport: transportVar === 'sse' ? 'sse' : 'streamable-http',
    serverName: UNITY_SERVER_NAME,
    url: url as string,
    headers: headersVar === undefined ? {} : parseStringDict(headersVar, UNITY_MCP_ENV.headers, 'UNITY_MCP_CONFIG_HEADERS'),
    toolCallTimeoutMs: UNITY_TOOL_CALL_TIMEOUT_MS,
    failOnStartupError: FAIL_ON_STARTUP_ERROR,
  }
}

/**
 * 装配行：纯函数、不连接、不落盘——装配不依赖 Unity 是否在运行（连接与重连归上游实例）。
 */
export function unityMcpPluginEntry(env: NodeJS.ProcessEnv = process.env): UnityMcpPluginEntry | undefined {
  const config = unityMcpConfig(env)
  return config === undefined ? undefined : { id: 'lyapunov-unity-mcp', name: MCP_CLIENT_PLUGIN, config: { ...config } }
}

/** 状态读数：只回答"配置是否被接上"，不含值、不含可达性（后者归 `list_mcp_servers`）。 */
export interface UnityMcpStatus {
  configured: boolean
  serverName: string
  transport: UnityMcpTransport | null
  toolCallTimeoutMs: number
  argsCount: number | null
  extraEnvNames: string[]
  cwd: string | null
  headerNames: string[]
}

/** 只读状态：零副作用（不建连接、不起进程、不读文件系统）。配置非法时抛出，与装配同一份校验。 */
export function unityMcpStatus(env: NodeJS.ProcessEnv = process.env): UnityMcpStatus {
  const config = unityMcpConfig(env)
  if (config === undefined) {
    return { configured: false, serverName: UNITY_SERVER_NAME, transport: null, toolCallTimeoutMs: UNITY_TOOL_CALL_TIMEOUT_MS, argsCount: null, extraEnvNames: [], cwd: null, headerNames: [] }
  }
  return config.transport === 'stdio'
    ? { configured: true, serverName: config.serverName, transport: 'stdio', toolCallTimeoutMs: config.toolCallTimeoutMs, argsCount: config.args.length, extraEnvNames: Object.keys(config.env), cwd: config.cwd, headerNames: [] }
    : { configured: true, serverName: config.serverName, transport: config.transport, toolCallTimeoutMs: config.toolCallTimeoutMs, argsCount: null, extraEnvNames: [], cwd: null, headerNames: Object.keys(config.headers) }
}

if (import.meta.main) {
  /**
   * 用法：`bun run script/unity-mcp.ts [--help]`
   * 输出**严格 JSON**（状态读数，无其他行）；退出码 0=配置合法（configured 真或假），1=配置非法。
   * 这里只回答"接线配置能不能加载"——连接状态请用宿主里的原生 `list_mcp_servers`。
   */
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('用法：bun run script/unity-mcp.ts\n'
      + `  stdio 目标：${UNITY_MCP_ENV.command}（+ ${UNITY_MCP_ENV.args} / ${UNITY_MCP_ENV.env} / ${UNITY_MCP_ENV.cwd}）\n`
      + `  http 目标：${UNITY_MCP_ENV.url}（+ ${UNITY_MCP_ENV.transport}=streamable-http|sse / ${UNITY_MCP_ENV.headers}）\n`
      + '  两者都不给=未配置（不加载、不阻塞其他功能）；同时给=配置冲突。\n'
      + '  本脚本只报告接线配置，不连接、不探测、不启动任何进程。')
    process.exit(0)
  }
  try {
    console.log(JSON.stringify(unityMcpStatus()))
    process.exit(0)
  } catch (error) {
    console.error(String((error as Error)?.message ?? error))
    process.exit(1)
  }
}
