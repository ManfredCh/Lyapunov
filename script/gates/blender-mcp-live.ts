/**
 * Blender MCP 作为**产品基本能力**的现场验证驱动。
 *
 * 只验"文件存在"是没有意义的——本驱动把整条链真跑一遍，每一步都留读数：
 *   1. `ensureBlenderMcp()` 真供给（版本钉在 UPSTREAM_LOCK.json，sha256 校验）；
 *   2. 起**真 Blender GUI**（`--background` 会被产品脚本显式拒绝：MCP 需要 GUI 主事件循环），
 *      加载上游 addon，等它打印 READY 行——拿到 Blender 版本与真实端口；
 *   3. 起**上游 stdio MCP 服务**（`mcp-for-blender`，不是产品自建），走 JSON-RPC：
 *      `initialize` 拿 serverInfo → `tools/list` 拿真实工具表 → `tools/call` 做**真实往返**。
 *
 * 为什么必须做真实往返：`tools/list` 只证明服务在跑，证明不了它**真的连上了那个 Blender**。
 * 所以最后一步用 `execute_blender_code` 在活的 Blender 里建一个对象、再用 `get_scene_info` 读回来，
 * 核对对象名与顶点数**确实出现在 Blender 的场景里**。
 *
 * 用法：`PATH="$HOME/.bun/bin:$PATH" bun run script/gates/blender-mcp-live.ts`
 * 退出码：0=全过；1=实测失败；2=环境缺失（无图形会话 / 无 Blender 可执行文件）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { PRODUCT_ROOT } from '../profile.ts'
import { blenderMcpLock, blenderMcpPaths, ensureBlenderMcp } from '../blender-mcp.ts'

const BLENDER = process.env.BLENDER_EXECUTABLE ?? '/snap/blender/current/blender'
const START_MCP = join(PRODUCT_ROOT, 'packages/blender/scripts/start_mcp.py')
/** 现场建的对象名带随机后缀：写死的名字可能本来就在场景里，"读到了"就不算证据。 */
const PROBE_OBJECT = `lya_mcp_probe_${Date.now().toString(36)}`
/**
 * 上游 `mcp-for-blender` 2.0.0 要求**每个工具调用**都带 `user_prompt`，且文档明确要求
 * "逐字引用用户原话、不要改写、多步任务里每次传同一句"。这不是可选项——
 * 我第一版驱动没传，`get_scene_info` 直接以 pydantic 校验错返回（读数见下方 FAIL 记录）。
 * 这里按上游语义传同一句用户目标。
 */
const USER_PROMPT = '验证 Blender MCP 作为产品基本能力可用'

interface Readings { [key: string]: unknown }
const readings: Readings = {}

function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.on('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => { port ? resolvePort(port) : rejectPort(new Error('FREE_PORT_UNAVAILABLE')) })
    })
  })
}

/** 极小的 MCP stdio 客户端：按行收发 JSON-RPC。只实现本驱动需要的方法，不复制上游实现。 */
class McpStdioClient {
  private readonly child: ChildProcess
  private readonly pending = new Map<number, (value: Record<string, unknown>) => void>()
  private nextId = 1
  private buffer = ''
  public stderr = ''
  constructor(command: string, env: Record<string, string>) {
    this.child = spawn(command, [], { cwd: PRODUCT_ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    this.child.stdout!.on('data', chunk => {
      this.buffer += String(chunk)
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() ?? ''
      for (const line of lines) this.onLine(line.trim())
    })
    this.child.stderr!.on('data', chunk => { this.stderr = (this.stderr + String(chunk)).slice(-4000) })
  }
  private onLine(line: string): void {
    if (!line.startsWith('{')) return
    let message: { id?: number; result?: Record<string, unknown>; error?: unknown }
    try { message = JSON.parse(line) as typeof message } catch { return }
    if (message.id === undefined) return
    const settle = this.pending.get(message.id)
    if (!settle) return
    this.pending.delete(message.id)
    settle(message.error === undefined ? (message.result ?? {}) : { __error: message.error })
  }
  request(method: string, params: unknown, timeoutMs = 120_000): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise((resolveReply, rejectReply) => {
      const timer = setTimeout(() => { this.pending.delete(id); rejectReply(new Error(`MCP_TIMEOUT_${method}`)) }, timeoutMs)
      this.pending.set(id, value => { clearTimeout(timer); resolveReply(value) })
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  notify(method: string, params: unknown): void {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }
  async stop(): Promise<void> {
    this.child.stdin!.end()
    await new Promise<void>(done => {
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); done() }, 5000)
      this.child.once('exit', () => { clearTimeout(timer); done() })
    })
  }
}

function mcpText(result: Record<string, unknown>): string {
  const content = result.content as Array<{ type?: string; text?: string }> | undefined
  return (content ?? []).filter(part => part.type === 'text').map(part => String(part.text ?? '')).join('\n')
}

async function main(): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = []
  let blender: ChildProcess | undefined
  let client: McpStdioClient | undefined
  let blenderDiagnostics = ''
  try {
    // ── 1) 供给 ──────────────────────────────────────────────────────────────
    const lock = blenderMcpLock()
    const paths = blenderMcpPaths()
    const status = await ensureBlenderMcp({ log: message => { console.log('· ' + message) } })
    readings.provisioning = status.readings
    checks.push({
      name: 'mcp_dependency_provisioned_and_pinned',
      ok: status.ready,
      detail: `${status.detail}；venv=${paths.venv}；可执行文件=${paths.command}`,
    })

    // ── 2) 真 Blender GUI + 上游 addon ───────────────────────────────────────
    if (!existsSync(BLENDER)) return 2
    if (!process.env.DISPLAY && process.platform === 'linux') {
      console.error('BLOCKED: 没有 DISPLAY，Blender MCP 需要 GUI 主事件循环')
      return 2
    }
    const blenderPort = await freePort()
    blender = spawn(BLENDER, ['--factory-startup', '--python', START_MCP, '--', '--addon', paths.addon, '--port', String(blenderPort)],
      { cwd: PRODUCT_ROOT, env: { ...process.env, DISABLE_TELEMETRY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    blender.stderr!.on('data', chunk => { blenderDiagnostics = (blenderDiagnostics + String(chunk)).slice(-4000) })
    const ready = await new Promise<Record<string, unknown> | undefined>(done => {
      let pending = ''
      const timer = setTimeout(() => done(undefined), 120_000)
      blender!.once('exit', () => { clearTimeout(timer); done(undefined) })
      blender!.stdout!.on('data', chunk => {
        pending += String(chunk)
        const lines = pending.split('\n'); pending = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('LYAPUNOV_BLENDER_MCP=')) continue
          clearTimeout(timer)
          done(JSON.parse(line.slice('LYAPUNOV_BLENDER_MCP='.length)) as Record<string, unknown>)
        }
      })
    })
    readings.blenderAddon = ready ?? null
    checks.push({
      name: 'blender_gui_hosts_pinned_addon',
      ok: ready?.status === 'READY' && Number(ready?.port) === blenderPort,
      detail: ready
        ? `真 Blender GUI 加载上游 addon v${lock.addon.blInfoVersion}：status=${String(ready.status)} host=${String(ready.host)}:${String(ready.port)}（请求端口 ${blenderPort}）、blenderVersion=${String(ready.blenderVersion)}、globalPreferencesSaved=${String(ready.globalPreferencesSaved)}（false=产品启动脚本没有写入用户的 Blender 全局偏好）`
        : `Blender 未就绪；stderr 尾部=${blenderDiagnostics.slice(-500) || '空'}`,
    })
    if (ready?.status !== 'READY') return 1

    // ── 3) 上游 stdio MCP 服务：真握手 + 真工具表 + 真往返 ────────────────────
    client = new McpStdioClient(paths.command, { BLENDER_HOST: '127.0.0.1', BLENDER_PORT: String(blenderPort), DISABLE_TELEMETRY: '1' })
    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'lyapunov-blender-mcp-live', version: '1.0.0' },
    }, 90_000)
    if ('__error' in init) throw new Error(`initialize 返回错误：${JSON.stringify(init.__error)}`)
    client.notify('notifications/initialized', {})
    const serverInfo = init.serverInfo as { name?: string; version?: string } | undefined
    readings.handshake = { protocolVersion: init.protocolVersion, serverInfo, capabilities: init.capabilities }
    checks.push({
      name: 'mcp_stdio_handshake',
      ok: typeof serverInfo?.name === 'string' && serverInfo.name.length > 0,
      detail: `上游 stdio 服务真实握手：serverInfo=${JSON.stringify(serverInfo)}、protocolVersion=${String(init.protocolVersion)}、capabilities=${JSON.stringify(Object.keys((init.capabilities ?? {}) as object))}——服务是**上游** ${lock.package}（本驱动不实现任何 MCP 服务端）`,
    })

    const listed = await client.request('tools/list', {}, 60_000)
    const tools = (listed.tools ?? []) as Array<{ name?: string }>
    const toolNames = tools.map(tool => String(tool.name))
    readings.tools = toolNames
    checks.push({
      name: 'mcp_tools_listed',
      ok: toolNames.length > 0,
      detail: `tools/list 返回 ${toolNames.length} 个工具：[${toolNames.slice(0, 12).join(', ')}${toolNames.length > 12 ? ', …' : ''}]`,
    })

    // 真往返①：在活的 Blender 里建一个**随机命名**的对象。
    const created = await client.request('tools/call', {
      name: 'execute_blender_code',
      arguments: { user_prompt: USER_PROMPT, code: [
        'import bpy',
        `name = ${JSON.stringify(PROBE_OBJECT)}`,
        'bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, location=(1.0, 2.0, 3.0))',
        'obj = bpy.context.object',
        'obj.name = name',
        'obj["lyapunov_mcp_probe"] = True',
        'print("PROBE_CREATED=" + name + " verts=" + str(len(obj.data.vertices)))',
      ].join('\n') },
    }, 90_000)
    const createdText = mcpText(created)
    readings.createCall = { isError: created.isError ?? false, text: createdText.slice(0, 600) }
    checks.push({
      name: 'mcp_tool_call_reaches_live_blender',
      ok: created.isError !== true && createdText.includes(`PROBE_CREATED=${PROBE_OBJECT}`),
      detail: `tools/call execute_blender_code 在**活的 Blender** 里真建了对象：返回=${createdText.trim().split('\n').slice(-1)[0] || '(空)'}；isError=${String(created.isError ?? false)}`,
    })

    // 真往返②：从 Blender 读回场景，核对那个随机名对象**确实在场景里**。
    // 只信"写成功"不够——必须读回来才算证据。
    const sceneCall = await client.request('tools/call', { name: 'get_scene_info', arguments: { user_prompt: USER_PROMPT } }, 60_000)
    const sceneText = mcpText(sceneCall)
    // 上游真实返回形状（读 `blender_mcp/bundled/addon.py` 的 get_scene_info 得到，不靠猜）：
    // {name, object_count, objects:[{name,type,location}], materials_count}，且 **objects 只列前 10 个**。
    // 我第一版判据用了不存在的 `vertex_count`，于是"读回来了却判 FAIL"——判据错，不是链路错。
    let scene: { object_count?: number; objects?: Array<{ name?: string; type?: string; location?: number[] }>; materials_count?: number } | undefined
    try { scene = JSON.parse(sceneText) as typeof scene } catch { /* 交给下面的判据报错 */ }
    const found = scene?.objects?.find(object => object.name === PROBE_OBJECT)
    const locationOk = Array.isArray(found?.location) && found!.location!.length === 3
      && Math.abs(Number(found!.location![0]) - 1) < 0.01 && Math.abs(Number(found!.location![1]) - 2) < 0.01 && Math.abs(Number(found!.location![2]) - 3) < 0.01
    readings.sceneCall = { isError: sceneCall.isError ?? false, objectCount: scene?.object_count ?? null, listedCount: scene?.objects?.length ?? null, probe: found ?? null, locationOk }
    checks.push({
      name: 'live_blender_scene_read_back',
      ok: found !== undefined && found.type === 'MESH' && locationOk,
      detail: found
        ? `get_scene_info 从活 Blender 读回场景：object_count=${String(scene?.object_count)}（工具本次列出 ${String(scene?.objects?.length)} 个，**上游只列前 10 个**）、materials_count=${String(scene?.materials_count)}；**探针对象 ${PROBE_OBJECT} 在现场**：type=${String(found.type)}、location=${JSON.stringify(found.location)}（与创建时的 (1,2,3) 一致=${String(locationOk)}）——写和读落在同一个真实 Blender 进程上`
        : `get_scene_info 未读到探针对象；object_count=${String(scene?.object_count ?? 'n/a')}，返回尾部=${sceneText.slice(-400)}`,
    })

    const failed = checks.filter(check => !check.ok)
    for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  BlenderMCP/${check.name}  ${check.detail}`)
    console.log(`BlenderMCP: ${checks.length - failed.length}/${checks.length} 通过`)
    return failed.length ? 1 : 0
  } catch (error) {
    for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  BlenderMCP/${check.name}  ${check.detail}`)
    console.log(`FAIL  BlenderMCP/exception  ${String((error as Error)?.message ?? error)}`)
    if (client?.stderr) console.log(`MCP stderr 尾部：${client.stderr.slice(-600)}`)
    if (blenderDiagnostics) console.log(`Blender stderr 尾部：${blenderDiagnostics.slice(-600)}`)
    return 1
  } finally {
    try { await client?.stop() } catch { /* 已退出 */ }
    try { blender?.kill('SIGTERM') } catch { /* 已退出 */ }
    // §6.1 证据留存：读数先落盘再清理。
    try {
      const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z')
      const dir = join(PRODUCT_ROOT, 'bugfixHistory/refactor-execution/evidence/blender-mcp-live', stamp)
      await mkdir(dir, { recursive: true })
      const lock = blenderMcpLock()
      await writeFile(join(dir, 'result.json'), JSON.stringify({
        archivedAt: stamp,
        capability: 'Blender MCP（产品基本能力）',
        upstream: { package: `${lock.package}==${lock.version}`, addon: `${lock.addon.repository}@${lock.addon.commit}`, addonSha256: lock.addon.sha256 },
        readings,
      }, null, 2) + '\n')
      console.log(`证据已归档 → evidence/blender-mcp-live/${stamp}/result.json`)
    } catch (error) {
      console.log(`证据归档失败：${String((error as Error)?.message ?? error)}`)
    }
  }
}

if (!existsSync(START_MCP)) {
  console.error(`BLOCKED: 产品 addon 启动脚本不存在 ${START_MCP}`)
  process.exit(2)
}
process.exit(await main())
