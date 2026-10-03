/**
 * 会话事件**出站**投影（消费者面）——不是会话持久化真值。
 *
 * 服务端保留模型所需全量：`session.append` 落盘的 `tool/result`、`command/done` 一字不改，
 * `sessionQuery`／`inspect`／模型上下文重建都读同一份全量日志。只有**发往浏览器**的 wire 面
 * （`sessionController` 的 `page`/`follow`）按消费者裁剪。
 *
 * 判据是上游补丁 `dsh-session-outbound-projection` 暴露的通用钩子（见
 * `packages/lyapunov-shell/patches/dsh-session-outbound-projection.patch`）；产品实现只提供这一份投影。
 *
 * 三条硬约束（上游 `history.ts` 对 seq 密度强校验，删一条直接抛）：
 *  1. **永不删事件**，只换 `data` 载荷；
 *  2. `type/seq/time/sourceEventSeqs/surfaceOp/ignorable` 原样保留；
 *  3. 投影必须幂等、纯函数、无 IO。
 */

import {
  displayPath,
  humanEventFace,
  humanTextOf,
  isInternalFieldName,
  publicCommandError,
  redactSecretsText,
  stripInternal,
} from "./command-privacy.ts"
import { productRelativePath, type ProductPathRoots } from "./product-paths.ts"

/** wire 事件信封（与上游 `SessionWireEvent` 同形；这里不引上游类型，纯合同）。 */
export interface WireEventEnvelope {
  type: string
  seq: number
  time: number
  data: unknown
  ignorable?: true
  sourceEventSeqs?: unknown
  surfaceOp?: unknown
}

/** 产品侧出站投影的最小面：上游钩子只调这两个方法。 */
export interface SessionOutboundProjection {
  projectEvent(event: unknown): unknown
  projectBlock(block: unknown): unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Display correlation is public metadata, never an arbitrary payload channel. */
function projectCommandDisplay(value:unknown):Record<string,unknown>|undefined {
 if(!isRecord(value)||value.kind!=='control-gesture'||!['update','final','stop'].includes(String(value.phase))||!Number.isSafeInteger(value.generation)||Number(value.generation)<0||!Number.isSafeInteger(value.sequence)||Number(value.sequence)<0)return
 const strings=['clientId','gestureId','worldId','entityId','jointName']
 if(strings.some(key=>typeof value[key]!=='string'||!value[key]||String(value[key]).length>256||/[\u0000-\u001f]/u.test(String(value[key]))))return
 return {kind:'control-gesture',...Object.fromEntries(strings.map(key=>[key,redactSecretsText(String(value[key]))])),generation:value.generation,phase:value.phase,sequence:value.sequence}
}

/** 入参原文摘要：只留键名 + 短值／引用，绝不出整份 JSON（含路径与可能的令牌）。 */
export function summarizeArgs(raw: string, roots?: ProductPathRoots): string {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return "参数已隐藏" }
  if (!isRecord(parsed)) return "参数已隐藏"
  const rows = Object.entries(parsed).filter(([key]) => !isInternalFieldName(key)).map(([key, value]) => {
    if (typeof value === "string") return `${key}=${productRelativePath(value, roots ?? {}) ?? displayPath(value)}`
    if (typeof value === "number" || typeof value === "boolean") return `${key}=${String(value)}`
    return `${key}=${Array.isArray(value) ? `[${value.length}]` : "{…}"}`
  })
  return rows.join(" ").slice(0, 200)
}

/** `command/done`：人类面只有净化后的公共字段摘要（机器面走 HTTP 白名单，不走事件）。 */
function projectCommandDone(data: Record<string, unknown>, roots?: ProductPathRoots): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data }
  const display=projectCommandDisplay(data.display);if(display)out.display=display;else delete out.display
  delete out.ui
  const text = typeof data.text === "string" ? data.text : undefined
  if (data.kind === "error") {
    const publicError = publicCommandError(text)
    out.text = `${publicError.code}: ${publicError.message}`
    out.publicCode = publicError.code
    return out
  }
  if (text === undefined) return out
  // 人类面：字段形状（卡片摘要读它）。完整结果仍留在服务端 session 日志——模型上下文由日志重建，
  // `sessionQuery`/`inspect` 读的是持久化真值，不经这条 wire 投影。
  out.text = humanEventFace(typeof data.name === "string" ? data.name : "", safeParse(text), roots)
  return out
}

function safeParse(text: string): unknown {
  try {
    const value = JSON.parse(text)
    return value === null ? undefined : value
  } catch { return undefined }
}

/**
 * 工具事件：**服务端模型真值不动**（模型面由 `output.render` 生成，仍读全量）。
 * wire 面裁掉内部字段与逐字入参／结果 JSON，只留模型与人类都需要的形状。
 */
function projectToolEvent(data: Record<string, unknown>, roots?: ProductPathRoots, toolOutput = false): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data }
  if (typeof out.arguments === "string") out.arguments = summarizeArgs(out.arguments, roots)
  const message = isRecord(data.message) ? data.message : undefined
  if (!message) return out
  out.message = { ...message, content: projectContent(message.content, roots, toolOutput) }
  if (isRecord(data.error)) {
    out.error = { ...data.error, reason: stripInternal(redactSecretsText(String(data.error.reason ?? ""))) }
  }
  return out
}

function projectContent(content: unknown, roots?: ProductPathRoots, toolOutput = false): unknown {
  if (!Array.isArray(content)) return content
  return content.map(block => {
    if (!isRecord(block)) return block
    if (Array.isArray(block.content)) return { ...block, content: projectContent(block.content, roots, toolOutput || block.type === "tool-result") }
    if (block.type === "tool-call" && typeof block.arguments === "string") {
      return { ...block, arguments: summarizeArgs(block.arguments, roots) }
    }
    // 工具结果按结构投影；普通助手回复保留公开引用和正文，不能当作内部工具回执裁剪。
    if (typeof block.text === "string") return { ...block, text: toolOutput ? humanTextOf(block.text, roots) : redactSecretsText(block.text) }
    return block
  })
}

/**
 * 一条 wire 事件的消费者投影（`ui` 机器字段一律不随事件下发）。
 * `formal` 时连 `command/run` 的入参摘要都不发（发行态浏览器连键名都不必知道）；
 * `developer` 只发摘要（键名 + 短值／引用），仍不发整份 JSON 原文。
 */
export function projectWireEvent(event: unknown, roots?: ProductPathRoots, formal = true): unknown {
  if (!isRecord(event)) return event
  const type = typeof event.type === "string" ? event.type : ""
  const data = isRecord(event.data) ? event.data : event.data
  let projected: unknown = data
  if (type === "command/done") projected = projectCommandDone(data as Record<string, unknown>, roots)
  else if (type === "tool/call" || type === "tool/result") projected = projectToolEvent(data as Record<string, unknown>, roots, type === "tool/result")
  else if (type === "assistant/message" || type === "assistant/attempt") {
    const source = data as Record<string, unknown>
    projected = Array.isArray(source.content)
      ? { ...source, content: projectContent(source.content, roots) }
      : isRecord(source.message) && Array.isArray(source.message.content)
        ? { ...source, message: { ...source.message, content: projectContent(source.message.content, roots) } }
        : source
  }
  // command/run 的 args 已由上游 `recordInput:false` 决定不入库（产品域命令一律不记录）；
  // 旧日志仍可能带 args，这里按同一份入参摘要规则裁剪，不删事件。
  else if (type === "command/run") {
    const source = data as Record<string, unknown>
    const out: Record<string, unknown> = { ...source }
    const display=projectCommandDisplay(source.display);if(display)out.display=display;else delete out.display
    if (typeof out.args === "string") out.args = formal ? undefined : summarizeArgs(out.args, roots)
    if (formal) delete out.args
    projected = out
  }
  return { ...event, data: projected }
}

/** 助手流块：`tool-call.arguments` / `tool-result` 与事件同一份判据。 */
export function projectStreamBlock(block: unknown, roots?: ProductPathRoots): unknown {
  if (!isRecord(block)) return block
  if (block.type === "tool-call" && typeof block.arguments === "string") {
    return { ...block, arguments: summarizeArgs(block.arguments, roots) }
  }
  if (Array.isArray(block.content)) return { ...block, content: projectContent(block.content, roots, block.type === "tool-result") }
  return block
}

/**
 * 产品装配：按 Host 进程的可信 profile（`LYAPUNOV_MODE`）与登记产品域根产出投影器。
 * `developer` 与 `formal` 在这里同一条判据（任何模式 secret 都不裸露）；差别只在机器面 `ui`
 * 是否随命令 HTTP 响应下发（由 shell 路由决定，不经事件）。
 */
export function createSessionOutboundProjection(mode: string, roots: ProductPathRoots = {}): SessionOutboundProjection {
  const formal = mode !== "developer"
  return {
    projectEvent: (event) => projectWireEvent(event, roots, formal),
    projectBlock: (block) => projectStreamBlock(block, roots),
  }
}
