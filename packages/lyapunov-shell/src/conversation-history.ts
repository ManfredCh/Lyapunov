/**
 * 会话历史投影：从原生会话事件里取出**参与判定**的那部分对话，以及"本步用户到底要什么"的纯文本。
 *
 * 从 `jev-context-routing.ts` 提取（2026-09-26，Jev 路由器退役时）：这几个函数不是 Jev 专有的——
 * `plugin.ts` 的引擎安装授权（`engineInstallAuthorization.observe`）与规则路由都用它们取真实输入。
 * 抽出来之后，Jev 相关的取件（OpenRouter 调用、候选集、结构化选择题）可以整块删除，而输入侧不变。
 */
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

/** 用户意图来源：普通用户消息与 3D 视口批注都是"用户这一步要什么"，不能只认 `user`。 */
export function isUserIntent(message: Message): boolean {
  return isHumanDirectedSource(message.source)
}

/** 只认原生人工消息与受原窗口/采集归属校验的人工批注producer；自动反馈/快照不重开意图。 */
export function isHumanDirectedSource(source: unknown): boolean {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return false
  const kind = (source as {kind?:unknown}).kind
  return kind === 'user' || kind === 'lyapunov-annotation'
}

/**
 * 原生压缩摘要（`dsh-compaction-basic` 的 `compactCheckpointSource`）：它是压缩后**唯一**的任务
 * 真值，与自己注入的路由提示、插件装配的动态快照不是一回事，必须参与判定。
 */
export function isCompactionSummary(message: Message): boolean {
  const source = message.source as { kind: string; plugin?: string; compactionId?: unknown }
  return source.kind === 'plugin' && (source.plugin === 'compact' || typeof source.compactionId === 'string')
}

/** 任务意图：用户消息/批注，或压缩后唯一的任务摘要（摘要后没有新的用户消息时它就是当前意图）。 */
export function isTaskIntent(message: Message): boolean {
  return isUserIntent(message) || isCompactionSummary(message)
}

/**
 * 只把**对话**当判定历史：用户输入、视口批注、模型回复、工具回执、原生压缩摘要/召回。
 * 排除两类确实不该参与判定的消息：自己注入的路由提示（`lyapunov-domain-pointer`，
 * 旧提示不代表当前意图）与 system-prompt 快照（里面带**当时**的 todo/选择投影，
 * 留在历史里会被当成"当前状态"）。其余 `plugin` 来源（compact 等）原样保留。
 */
export function isRoutingInput(message: Message): boolean {
  const source = message.source as { kind: string; plugin?: string }
  return message.role !== 'system' && source.kind !== 'lyapunov-domain-pointer'
    && !(source.kind === 'plugin' && source.plugin === '@deepseek-ai/dsh-system-prompt')
}

export function routingHistory(session: Session): Message[] {
  const messages: Message[] = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event && (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result')) {
      const message = event.type === 'user/message' ? event.data : event.data.message
      if (isRoutingInput(message)) messages.push(message)
    }
  }
  // 保住任务意图：最近一条用户意图（含视口批注）与最近一份原生压缩摘要，
  // 哪怕一轮工具结果把它们挤出 16 条窗口（摘要尤其容易被挤掉——它出现在批次开头）。
  const recent = messages.slice(-16)
  const intents = [messages.findLast(isCompactionSummary), messages.findLast(isUserIntent)]
    .filter((message): message is Message => message !== undefined)
  const pinned = intents.filter((message, index) => intents.indexOf(message) === index && !recent.includes(message))
  return [...messages.filter(message => pinned.includes(message)), ...recent]
}

/** 最新任务意图的纯文本（本步消息优先，其次有效历史）；无则空串。 */
export function latestUserText(input: { messages: readonly Message[]; history: readonly Message[] }): string {
  const message = [...input.history, ...input.messages].findLast(isTaskIntent)
  return message?.content.map(block => (block.type === 'text' ? block.text : '')).join('\n').trim() ?? ''
}
