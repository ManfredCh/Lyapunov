import { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import * as Connection from '@deepseek-ai/dsh-client-connection/node'
import * as Gateway from '@deepseek-ai/dsh-api-gateway/node'
import session from '@deepseek-ai/dsh-api-session-controller/remote'
import commands from '@deepseek-ai/dsh-commands/remote'
import workspace from '@deepseek-ai/dsh-api-workspace-controller/remote'
import workspaceFiles from '@deepseek-ai/dsh-api-workspace-files/remote'
import goals from '@deepseek-ai/dsh-goal/remote'
import fileUploads from '@deepseek-ai/dsh-client-file-upload/remote'
import subagents from '@deepseek-ai/dsh-subagent/remote'
import agentPresets from '@deepseek-ai/dsh-agent-preset-registry/remote'
import llm from '@deepseek-ai/dsh-llm/remote'
import settings from '@deepseek-ai/dsh-api-settings-controller/remote'
import jobs from '@deepseek-ai/dsh-api-job-controller/remote'
import type {} from '@deepseek-ai/dsh-api-remotes/types'
import type {} from '@deepseek-ai/dsh-user-approval/types'
import type {} from '@deepseek-ai/dsh-user-questions/types'
import { createScope, scopeOf, type AgentContext, type AgentScopeHandle } from '@deepseek-ai/dsh-api-session-controller/src/client/scope.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

interface NodeSocket extends globalThis.WebSocket { once(event: 'close', listener: () => void): unknown }

// ws 已是原生 Gateway 的运行依赖，复用其安装实例，不另装传输库。
const WebSocket = createRequire(import.meta.resolve('@deepseek-ai/dsh-api-gateway'))('ws') as {
  new(url: URL, options: { headers: Record<string, string> }): NodeSocket
  readonly CLOSED: number
}

export interface TerminalRemoteOptions {
  readonly url: string
  readonly token?: string
  readonly cookie?: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export interface TerminalRemoteConnection {
  /** 不含启动token、查询参数或cookie的服务器origin。 */
  readonly origin: string
  readonly ctx: Context
  readonly connection: Connection.ConnectionHandle
  readonly remote: Gateway.ClientRemote
  /** 原生Client Cordis身份scope，只用于请求路由，不创建Host Agent或Session镜像。 */
  scope(sessionId: SessionId): AgentContext
  sessionIdOf(ctx: Context): SessionId | undefined
  /** 同一服务器的已鉴权HTTP请求，用于原生上传/导出等现成路由。 */
  fetch(path: string | URL, init?: RequestInit): Promise<Response>
  /** 只关闭当前客户端的原生流、socket与Context，不退出Host。 */
  dispose(): Promise<void>
}

/** 相对 RPC 路径与 URL 共用同一鉴权 origin；外站目标在携带凭据前拒绝。 */
export function terminalRemoteUrl(path: string | URL, origin: string): URL {
  const target = new URL(String(path), origin)
  if (target.origin !== origin) throw new Error('REMOTE_ORIGIN_MISMATCH: 已鉴权请求只能发送到当前 DSH 服务器。')
  return target
}

/** 连接现成DSH Web Host；Session、Agent、Goal等领域仍由远端原生服务拥有。 */
export async function connectTerminalRemote(options: TerminalRemoteOptions): Promise<TerminalRemoteConnection> {
  options.signal?.throwIfAborted()
  const launch = new URL(options.url)
  if (!['http:', 'https:'].includes(launch.protocol)) throw new Error('REMOTE_URL_INVALID: 需要 DSH Web 的 http 或 https URL。')
  if (launch.username || launch.password) throw new Error('REMOTE_AUTH_INVALID: 请使用 DSH 原生启动 token 或 cookie。')
  if (options.token !== undefined) launch.searchParams.set('token', options.token)
  const origin = launch.origin
  launch.pathname = '/'; launch.hash = ''
  const deadline = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 15000), ...(options.signal ? [options.signal] : [])])
  let cookie = options.cookie ?? ''
  const admission = await fetch(launch, { redirect: 'manual', signal: deadline, headers: cookie ? { cookie } : {} })
  const issued = admission.headers.getSetCookie().map(value => value.split(';', 1)[0]!).filter(Boolean)
  if (issued.length) cookie = issued.join('; ')
  launch.search = ''
  if (admission.status === 303) {
    const target = new URL(admission.headers.get('location') ?? '/', origin)
    if (target.origin !== origin) throw new Error('REMOTE_AUTH_INVALID: DSH 鉴权跳转离开当前服务器。')
    const response = await fetch(target, { redirect: 'manual', signal: deadline, headers: { cookie } })
    await response.body?.cancel()
    if (response.status !== 200) throw new Error(`REMOTE_AUTH_REQUIRED: DSH 鉴权后返回 HTTP ${response.status}。`)
  } else if (admission.status !== 200) {
    await admission.body?.cancel()
    throw new Error(`REMOTE_AUTH_REQUIRED: DSH 返回 HTTP ${admission.status}，需要有效启动 token 或 cookie。`)
  }
  await admission.body?.cancel()
  const ctx = new Context(), lifetime = new AbortController(), sockets = new Set<NodeSocket>(), scopes = new Map<SessionId, AgentScopeHandle>()
  let disposing: Promise<void> | undefined
  const authenticatedFetch = async (path: string | URL, init: RequestInit = {}): Promise<Response> => {
    lifetime.signal.throwIfAborted()
    const target = terminalRemoteUrl(path, origin)
    const headers = new Headers(init.headers)
    if (cookie) headers.set('cookie', cookie)
    headers.set('origin', origin)
    const signal = AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : []), ...(init.signal ? [init.signal] : [])])
    return fetch(target, { ...init, headers, signal, redirect: 'manual' })
  }
  const dispose = (): Promise<void> => disposing ??= (async () => {
    lifetime.abort(new Error('远端终端连接已关闭'))
    options.signal?.removeEventListener('abort', aborted)
    try { await ctx.fiber.dispose() }
    finally {
      await Promise.all([...sockets].map(socket => new Promise<void>(done => {
        if (socket.readyState === WebSocket.CLOSED) { done(); return }
        socket.once('close', done); socket.close(1000, 'terminal detached')
      })))
      cookie = ''
      scopes.clear()
    }
  })()
  const aborted = (): void => { void dispose().catch(() => {}) }
  options.signal?.addEventListener('abort', aborted, { once: true })
  try {
    await ctx.plugin(TypertRegistry)
    await ctx.plugin({ name: 'terminal-native-identities', inject: ['typert'], apply(inner: Context) {
      inner.typert.contexts.registerClient('agent', {
        identity: candidate => scopeOf(candidate),
        resolve: id => scopes.get(id)?.ctx as Context | undefined,
      })
    } })
    await ctx.plugin({ name: 'terminal-native-connection', inject: [], apply(inner: Context) {
      Connection.installConnection(inner, { transport: { fetch: authenticatedFetch }, location: { hostname: new URL(origin).hostname } })
    } })
    await ctx.plugin({ name: 'terminal-native-gateway', inject: Gateway.inject, apply(inner: Context) {
      Gateway.apply(inner, { createWebSocket: path => {
        lifetime.signal.throwIfAborted()
        const nativePath = new URL(path), target = new URL(nativePath.pathname + nativePath.search, origin)
        target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
        const socket = new WebSocket(target, { headers: { cookie, origin } })
        sockets.add(socket); socket.once('close', () => sockets.delete(socket))
        return socket as unknown as globalThis.WebSocket
      } })
    } })
    await ctx.plugin({ name: 'terminal-native-remotes', inject: ['remote'], async apply(inner: Context) {
      for (const contribution of [session, commands, workspace, workspaceFiles, goals, fileUploads, subagents, agentPresets, llm, settings, jobs]) await inner.remote.$mount(contribution)
    } })
    const connection = ctx.get('connection') as unknown as Connection.ConnectionHandle
    const remote = ctx.get('remote') as Gateway.ClientRemote
    await connected(connection, deadline)
    options.signal?.throwIfAborted()
    return {
      origin, ctx, connection, remote, fetch: authenticatedFetch, dispose,
      scope(id) {
        lifetime.signal.throwIfAborted()
        let handle = scopes.get(id)
        if (!handle) { handle = createScope(ctx, id); scopes.set(id, handle) }
        return handle.ctx
      },
      sessionIdOf: scopeOf,
    }
  } catch (error) {
    await dispose()
    throw error
  }
}

async function connected(connection: Connection.ConnectionHandle, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (connection.generation.getSnapshot()) return
  await new Promise<void>((resolve, reject) => {
    const check = () => { if (connection.generation.getSnapshot()) { cleanup(); resolve() } }
    const abort = () => { cleanup(); reject(signal.reason) }
    const unsubscribe = connection.generation.subscribe(check)
    const cleanup = () => { unsubscribe(); signal.removeEventListener('abort', abort) }
    signal.addEventListener('abort', abort, { once: true })
    check()
    if (signal.aborted) abort()
  })
}
