import { join, resolve } from "node:path"

/**
 * 会话身份与命名空间的**唯一规则**（scene/resource/robot/sim/HTTP/媒体/异步回调共用这一份）。
 *
 * 原生会话就是运行态归属：`agent.session.header.id`（= SessionId）是场景存储、资源索引、机器人、
 * 世界与 worker 的归属键。修前所有会话共用一套 Host 级 `SceneOperations` 与一个 sim Provider，
 * 于是 A 加载环境会覆盖 B 的 3D 场景——根因不是命名冲突，而是**没有归属维度**。
 *
 * 两条硬约束：
 *   · 取不到会话（工具没有 agent、HTTP 没有可核实的会话）一律**明确失败**，绝不落回全局共享命名空间；
 *   · 会话键只来自原生会话本身，不从请求体自报的身份直接采信（HTTP 走 `bindSessionId` 的核实链）。
 */
export const SESSION_SCOPE_UNAVAILABLE = "SESSION_SCOPE_UNAVAILABLE"
export const SESSION_NOT_BOUND = "SESSION_NOT_BOUND"

/** agent（`agent.session.header.id`）或 session（`session.header.id`）都能取；取不到返回 undefined。 */
export function sessionIdOf(value: unknown): string | undefined {
  const record = value as { session?: { header?: { id?: unknown } }; header?: { id?: unknown } } | undefined
  for (const candidate of [record?.session?.header?.id, record?.header?.id]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim()
  }
  return undefined
}

/** 取不到就报错（不带默认值、不带全局回退）：调用方要么有会话，要么明确失败。 */
export function requireSessionId(value: unknown, label: string): string {
  const id = sessionIdOf(value)
  if (!id) throw new Error(`${SESSION_SCOPE_UNAVAILABLE}: ${label} 没有可核实的原生会话（拒绝落到全局共享状态）`)
  return id
}

/** 目录名安全化：会话 id 通常直接可用，异常字符换成 `_` 并附短哈希，保证不同会话不会撞到同一目录。 */
export function safeSessionKey(sessionKey: string): string {
  const trimmed = sessionKey.trim()
  const safe = trimmed.replace(/[^A-Za-z0-9._-]/g, "_")
  if (safe === trimmed && safe !== "" && safe !== "." && safe !== "..") return safe
  let hash = 0
  for (const character of trimmed) hash = (hash * 31 + character.codePointAt(0)!) >>> 0
  return `${safe.slice(0, 48) || "session"}-${hash.toString(16).padStart(8, "0")}`
}

/** 会话命名空间：`<域根>/sessions/<会话键>`。同一个本地 id 在不同会话里各自成立，互不覆盖。 */
export function sessionNamespace(root: string, sessionKey: string): string {
  return join(resolve(root), "sessions", safeSessionKey(sessionKey))
}

/** 只读上下文面：用于在不引入上游类型依赖的前提下核实一个会话是否存在。 */
export interface SessionLookup { get(name: string): unknown }

interface ResolvedAgent { agent?: unknown; error?: unknown }

/**
 * HTTP/异步入口的会话核实链（缺一不可的顺序，任何一步失败都不回退到"全局"）：
 *   1. 活着的 agent（原生 AgentRegistry）；
 *   2. `sessionController.resolveAgent`（原生会话控制器的解析，含从持久化恢复）；
 *   3. `sessionQuery.observeSession` 证其存在（没有模型 turn 的请求也走这条：只读历史会话仍可归属）。
 * 请求体里的 sessionId 只在这三步里被核实一次，之后一律以核实结果为准。
 */
export async function bindSessionId(ctx: SessionLookup, sessionId: unknown, label: string): Promise<string> {
  const value = typeof sessionId === "string" ? sessionId.trim() : ""
  if (!value) throw new Error(`${SESSION_NOT_BOUND}: ${label} 没有带会话标识（拒绝落到全局共享状态）`)
  const agents = ctx.get("agents") as { get?: (id: unknown) => unknown } | undefined
  const live = agents?.get?.(value)
  if (sessionIdOf(live)) return sessionIdOf(live)!
  const controller = ctx.get("sessionController") as { resolveAgent?: (id: unknown) => Promise<ResolvedAgent> } | undefined
  if (controller?.resolveAgent) {
    const resolved = await controller.resolveAgent(value).catch(() => undefined)
    const id = resolved && !("error" in resolved) ? sessionIdOf(resolved.agent) : undefined
    if (id) return id
  }
  const query = ctx.get("sessionQuery") as { observeSession?: (id: unknown, options: unknown) => Promise<unknown> } | undefined
  if (query?.observeSession) {
    const observation = await query.observeSession(value, { projectionMode: "none" }).catch(() => undefined)
    if (observation !== undefined) {
      const id = sessionIdOf(observation) ?? value
      const disposeAsync = (observation as { [Symbol.asyncDispose]?: () => Promise<void> })[Symbol.asyncDispose]
      const disposeSync = (observation as { [Symbol.dispose]?: () => void })[Symbol.dispose]
      const disposePlain = (observation as { dispose?: () => unknown }).dispose
      try {
        if (disposeAsync) await disposeAsync.call(observation)
        else if (disposeSync) disposeSync.call(observation)
        else await disposePlain?.call(observation)
      } catch { /* 只读核实：收尾失败不影响归属结论 */ }
      return id
    }
  }
  throw new Error(`${SESSION_NOT_BOUND}: ${label} 指定的会话 ${value} 在本 Host 不可核实（拒绝落到全局共享状态）`)
}
