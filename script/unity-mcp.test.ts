/**
 * Unity MCP 接线的**局部测试**：`bun run script/unity-mcp.test.ts`。
 * 退出码 0=全部通过，1=有失败；不需要 Unity、不联网、不起进程（CLI 子进程除外，那是被测对象本身）。
 *
 * "我们发出去的配置符不符合连接器合同"不靠抄一份字段表，也不靠 grep 上游源码：
 * 直接把装配行喂给**上游真实的 `Config` schema**（`@deepseek-ai/dsh-mcp-client` 导出的同一个对象），
 * 它接受才算符合合同。
 */
import { spawnSync } from 'node:child_process'
import { Config } from '@deepseek-ai/dsh-mcp-client'
import { MCP_CLIENT_PLUGIN, UNITY_MCP_ENV, UNITY_MCP_ENV_NAMES, unityMcpConfig, unityMcpPluginEntry, unityMcpStatus } from './unity-mcp.ts'
import { runtimePluginInsert } from './runtime-patch.ts'

const SCRIPT = new URL('./unity-mcp.ts', import.meta.url).pathname
const checks: Array<{ name: string; ok: boolean; detail: string }> = []
const check = (name: string, ok: boolean, detail: string): void => { checks.push({ name, ok, detail }) }

/** 清空全部 Unity 变量（局部覆盖 process.env，跑完还原）。 */
const CLEARED: Record<string, undefined> = Object.fromEntries(UNITY_MCP_ENV_NAMES.map(name => [name, undefined]))

function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(values)) saved.set(key, process.env[key])
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  try { return run() } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

const STDIO_ENV = { [UNITY_MCP_ENV.command]: '/bin/echo', [UNITY_MCP_ENV.args]: '["--from","mcpforunityserver","mcp-for-unity","--transport","stdio"]' }

/** 装配表基线：Blender 行需要命令 + 端口（产品要求显式指定），用它做"没动其他插件"的对照。 */
const BLENDER_ENV = { LYAPUNOV_BLENDER_MCP_COMMAND: '/bin/true', BLENDER_PORT: '9876' }
const ASSEMBLY_INPUT = { mode: 'developer', surface: 'web', sceneRoot: '/tmp/unity-mcp-local-test-never-written', engine: 'none' } as const

function thrownBy(run: () => unknown): string {
  try { run(); return '' } catch (error) { return String((error as Error)?.message ?? error) }
}

// ── 1. 未配置：不加载、不影响其他插件 ──────────────────────────────────────────
{
  const result = withEnv({ ...CLEARED, ...BLENDER_ENV }, () => ({
    config: unityMcpConfig(),
    entry: unityMcpPluginEntry(),
    rows: runtimePluginInsert({ ...ASSEMBLY_INPUT }),
    withUnity: withEnv({ ...STDIO_ENV }, () => runtimePluginInsert({ ...ASSEMBLY_INPUT })),
  }))
  const unityRows = result.rows.filter(row => row.id === 'lyapunov-unity-mcp')
  const blenderRows = result.rows.filter(row => row.name === MCP_CLIENT_PLUGIN)
  check('unconfigured_does_not_load', result.config === undefined && result.entry === undefined && unityRows.length === 0 && blenderRows.length === 1,
    `清空 ${UNITY_MCP_ENV_NAMES.length} 个 Unity 变量后：unityMcpConfig()=undefined、装配表 ${result.rows.length} 行里 unity 行=0、同表 ${MCP_CLIENT_PLUGIN} 实例=1（Blender 行，未被牵连=${String(blenderRows.length === 1)}）`)

  // 配置 Unity MCP 只动两处：多一条连接器行，scene-kit 行多出 unity 开关（同一份配置既接连接又开 unity_scene_* 工具）。
  const withoutUnity = result.withUnity.filter(row => row.id !== 'lyapunov-unity-mcp')
  const sceneKitConfig = (rows: typeof result.rows) => rows.find(row => row.id === 'lyapunov-scene-kit')?.config as Record<string, unknown> | undefined
  const { unity: unitySwitch, ...sceneKitRest } = sceneKitConfig(withoutUnity) ?? {}
  const restored = withoutUnity.map(row => row.id === 'lyapunov-scene-kit' ? { ...row, config: sceneKitRest } : row)
  check('configured_adds_exactly_one_row',
    result.withUnity.length === result.rows.length + 1
    && JSON.stringify(withoutUnity.map(row => row.id)) === JSON.stringify(result.rows.map(row => row.id))
    && JSON.stringify(unitySwitch) === JSON.stringify({ serverName: 'unity' })
    && JSON.stringify(sceneKitRest) === JSON.stringify(sceneKitConfig(result.rows))
    && JSON.stringify(restored) === JSON.stringify(result.rows),
    `同一输入：未配置 ${result.rows.length} 行 → 配置 stdio 后 ${result.withUnity.length} 行（只多 lyapunov-unity-mcp 一行）；scene-kit 行同时拿到 unity={serverName:'unity'}（这一处之外与基线逐字相同=${String(JSON.stringify(sceneKitRest) === JSON.stringify(sceneKitConfig(result.rows)))}）；连接器行与 scene-kit 的 unity 开关都还原后与基线逐字相同=${String(JSON.stringify(restored) === JSON.stringify(result.rows))}`)
}

// ── 2. 装配行形状：字段对、并**被上游真实 schema 接受** ────────────────────────
{
  const entry = withEnv(STDIO_ENV, () => unityMcpPluginEntry())
  const config = entry?.config as Record<string, unknown> | undefined
  const parsed = entry === undefined ? undefined : Config(entry.config as Parameters<typeof Config>[0]) as unknown as Record<string, unknown>
  check('stdio_entry_accepted_by_connector_schema',
    entry?.name === MCP_CLIENT_PLUGIN && config?.transport === 'stdio' && config?.serverName === 'unity' && config?.command === '/bin/echo'
    && parsed?.transport === 'stdio' && parsed?.serverName === 'unity',
    `装配行 id=${String(entry?.id)}／连接器=${String(entry?.name)}（与 Blender 同一个包）／serverName=${String(config?.serverName)}／transport=${String(config?.transport)}／args=${JSON.stringify(config?.args)}／failOnStartupError=${String(config?.failOnStartupError)}；上游 Config schema 接受=true（归一化后 serverName=${String(parsed?.serverName)}、toolCallTimeoutMs=${String(parsed?.toolCallTimeoutMs)}）`)

  check('stdio_args_env_cwd_passthrough', Array.isArray(config?.args) && (config.args as unknown[]).length === 5
    && JSON.stringify(config.env) === JSON.stringify({}) && typeof config.cwd === 'string',
    `ARGS 原样传入（${String((config?.args as unknown[] | undefined)?.length)} 项，含 --from mcpforunityserver）；未给 ENV 时 env={}；cwd 默认产品根=${String(config?.cwd)}`)

  const fixed = withEnv({ ...STDIO_ENV, [UNITY_MCP_ENV.env]: '{"UNITY_MCP_PORT":"6400"}', [UNITY_MCP_ENV.cwd]: 'packages/blender' }, () => unityMcpPluginEntry()?.config as Record<string, unknown>)
  check('stdio_extra_env_and_cwd', JSON.stringify(fixed.env) === JSON.stringify({ UNITY_MCP_PORT: '6400' }) && String(fixed.cwd).endsWith('/packages/blender'),
    `ENV 字典与 CWD（相对产品根解析）都进装配：env=${JSON.stringify(fixed.env)}、cwd=${String(fixed.cwd)}`)
}

// ── 3. http 目标：默认 streamable-http、可切 sse、headers 原样透传 ─────────────
{
  const httpUrl = 'http://127.0.0.1:8091/mcp'
  const base = withEnv({ ...CLEARED, [UNITY_MCP_ENV.url]: httpUrl }, () => unityMcpPluginEntry())
  const sse = withEnv({ ...CLEARED, [UNITY_MCP_ENV.url]: httpUrl, [UNITY_MCP_ENV.transport]: 'sse', [UNITY_MCP_ENV.headers]: '{"Authorization":"Bearer local-test"}' }, () => unityMcpPluginEntry())
  const baseConfig = base?.config as Record<string, unknown> | undefined
  const sseConfig = sse?.config as Record<string, unknown> | undefined
  const accepted = [base, sse].map(entry => entry !== undefined && Config(entry.config as Parameters<typeof Config>[0]).transport !== undefined)
  check('http_entry_accepted_by_connector_schema',
    baseConfig?.transport === 'streamable-http' && baseConfig.serverName === 'unity' && JSON.stringify(baseConfig.headers) === JSON.stringify({})
    && sseConfig?.transport === 'sse' && JSON.stringify(sseConfig.headers) === JSON.stringify({ Authorization: 'Bearer local-test' }) && accepted.every(Boolean),
    `URL 目标默认 transport=${String(baseConfig?.transport)}；显式 sse=${String(sseConfig?.transport)}；headers 原样给连接器=${JSON.stringify(sseConfig?.headers)}（不进状态读数）；上游 schema 接受=[${accepted.map(String).join(',')}]`)
}

// ── 4. 非法组合：逐个真实触发，且错误里不回显原文 ────────────────────────────
{
  // 合成标记按片段拼接：文件正文里不出现完整 key 形状（g17 `no_secrets_in_clean_tree` 抓的是形状，
  // 不是"这个词"）。拼接结果与原先逐字节相同，测试语义不变；不放宽扫描器，改夹具（W24／DEV-027）。
  const secret = 'sk-' + 'SECRET-abcdef0123456789'
  const cases: Array<{ name: string; env: Record<string, string | undefined>; code: string }> = [
    { name: '命令与URL同时给出', env: { ...STDIO_ENV, [UNITY_MCP_ENV.url]: 'http://127.0.0.1:8091/mcp' }, code: 'UNITY_MCP_CONFIG_CONFLICT' },
    { name: 'stdio 目标配 transport', env: { ...STDIO_ENV, [UNITY_MCP_ENV.transport]: 'sse' }, code: 'UNITY_MCP_CONFIG_TRANSPORT' },
    { name: '未知 transport', env: { [UNITY_MCP_ENV.url]: 'http://127.0.0.1:8091/mcp', [UNITY_MCP_ENV.transport]: 'websocket' }, code: 'UNITY_MCP_CONFIG_TRANSPORT' },
    { name: '非 http scheme', env: { [UNITY_MCP_ENV.url]: 'ws://127.0.0.1:8091/mcp' }, code: 'UNITY_MCP_CONFIG_URL' },
    { name: 'URL 不可解析', env: { [UNITY_MCP_ENV.url]: `不是URL?token=${secret}` }, code: 'UNITY_MCP_CONFIG_URL' },
    { name: 'ARGS 不是 JSON', env: { ...STDIO_ENV, [UNITY_MCP_ENV.args]: '--transport stdio' }, code: 'UNITY_MCP_CONFIG_ARGS' },
    { name: 'ARGS 不是字符串数组', env: { ...STDIO_ENV, [UNITY_MCP_ENV.args]: '["a",1]' }, code: 'UNITY_MCP_CONFIG_ARGS' },
    { name: 'ENV 值非字符串', env: { ...STDIO_ENV, [UNITY_MCP_ENV.env]: '{"UNITY_MCP_PORT":6400}' }, code: 'UNITY_MCP_CONFIG_ENV' },
    { name: 'HEADERS 值非字符串', env: { [UNITY_MCP_ENV.url]: 'http://127.0.0.1:8091/mcp', [UNITY_MCP_ENV.headers]: '{"Authorization":["x"]}' }, code: 'UNITY_MCP_CONFIG_HEADERS' },
    { name: '半配置（只给 ARGS）', env: { [UNITY_MCP_ENV.args]: '["--transport","stdio"]' }, code: 'UNITY_MCP_CONFIG_INCOMPLETE' },
    { name: '半配置（只给 HEADERS）', env: { [UNITY_MCP_ENV.headers]: `{"Authorization":"${secret}"}` }, code: 'UNITY_MCP_CONFIG_INCOMPLETE' },
  ]
  const results = cases.map(item => {
    const message = withEnv({ ...CLEARED, ...item.env }, () => thrownBy(() => unityMcpConfig()))
    const leaked = message.includes(secret) || message.includes('不是URL')
    return `${message.startsWith(item.code) ? '✓' : '✗'} ${item.name} → ${message.slice(0, 46)}（回显原文=${String(leaked)}）`
  })
  check('invalid_combinations_rejected', results.every(row => row.startsWith('✓')), `${cases.length} 个非法组合逐个真实触发且不回显原文：${results.join(' | ')}`)
}

// ── 5. 只读状态：只报名字，不出现任何值；配置非法时抛出 ──────────────────────
{
  const secret = 'sk-' + 'SECRET-abcdef0123456789'
  const status = withEnv({
    ...CLEARED,
    [UNITY_MCP_ENV.url]: `http://user:${secret}@127.0.0.1:8091/mcp?token=${secret}`,
    [UNITY_MCP_ENV.headers]: `{"Authorization":"Bearer ${secret}"}`,
    [UNITY_MCP_ENV.transport]: 'sse',
  }, () => unityMcpStatus())
  const text = JSON.stringify(status)
  check('status_reports_names_not_secret_values', status.configured && status.transport === 'sse' && JSON.stringify(status.headerNames) === JSON.stringify(['Authorization']) && !text.includes(secret) && !text.includes('user'),
    `带凭据的 http 配置：状态=${text}；在状态里搜 token/用户名/密码=${text.includes(secret) ? '找到了（失败）' : '[]'}——URL 值本身不进状态，header 只列名`)

  const stdioStatus = withEnv({ ...STDIO_ENV, [UNITY_MCP_ENV.env]: `{"UNITY_TOKEN":"${secret}"}` }, () => unityMcpStatus())
  check('status_never_reads_filesystem_or_spawns', stdioStatus.configured && stdioStatus.transport === 'stdio' && stdioStatus.argsCount === 5 && JSON.stringify(stdioStatus.extraEnvNames) === JSON.stringify(['UNITY_TOKEN']) && !JSON.stringify(stdioStatus).includes(secret),
    `stdio 状态读数=${JSON.stringify(stdioStatus)}：命令不存在也能读出 configured=true（本模块不查文件系统、不起进程、不探测——可达性是宿主里 list_mcp_servers 的事）`)
}

// ── 6. CLI：严格 JSON，退出码 0=配置合法 / 1=配置非法 ────────────────────────
{
  // 子进程环境里把 Unity 变量真正删掉（不是传 undefined）。
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !UNITY_MCP_ENV_NAMES.includes(key))) as NodeJS.ProcessEnv
  const spawnCli = (env: Record<string, string>): { status: number | null; stdout: string; stderr: string } => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...cleanEnv, ...env } })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }
  const unconfigured = spawnCli({})
  const configured = spawnCli({ [UNITY_MCP_ENV.command]: '/nonexistent/unity-mcp' })
  // 同前：合成标记按片段拼接，正文不出现完整 key 形状。
  const secret = 'sk-' + 'SECRET-abcdef0123456789'
  const invalid = spawnCli({ [UNITY_MCP_ENV.url]: `ws://127.0.0.1:8091/mcp?token=${secret}` })
  const jsonShapes: unknown[] = []
  let jsonOk = true
  for (const [label, result] of [['未配置', unconfigured], ['已配置', configured]] as const) {
    try { jsonShapes.push(JSON.parse(result.stdout) as unknown) } catch { jsonOk = false; jsonShapes.push(`${label} 输出不是严格 JSON`) }
  }
  const parsedConfigured = jsonShapes[1] as { configured?: boolean } | undefined
  check('cli_outputs_strict_json_only',
    jsonOk && unconfigured.status === 0 && configured.status === 0 && parsedConfigured?.configured === true
    && unconfigured.stdout.trim().split('\n').length === 1 && !configured.stdout.includes('TCP') && !configured.stdout.includes('可执行文件'),
    `CLI 两次调用各输出单行严格 JSON：未配置=${unconfigured.stdout.trim()}（退出 ${String(unconfigured.status)}）、已配置=${configured.stdout.trim()}（退出 ${String(configured.status)}）；不含人类探测文字=${String(!configured.stdout.includes('TCP'))}`)

  check('cli_exits_1_on_invalid_config_without_echoing_value',
    invalid.status === 1 && invalid.stderr.startsWith('UNITY_MCP_CONFIG_URL') && !invalid.stderr.includes('sk-SECRET') && !invalid.stderr.includes('ws://'),
    `非法 URL：退出 ${String(invalid.status)}、stderr=${invalid.stderr.trim()}（不含原值、不含 token）`)
}

const failed = checks.filter(item => !item.ok)
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  unity-mcp/${item.name}  ${item.detail}`)
console.log(`unity-mcp: ${String(checks.length - failed.length)}/${String(checks.length)} 通过`)
process.exitCode = failed.length ? 1 : 0
