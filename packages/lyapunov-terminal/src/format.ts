import { stripVTControlCharacters } from 'node:util'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { isAppendSurfaceEvent, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller'

/** 终端只呈现内容；控制转义不交给终端执行。 */
export function terminalText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

export function contentText(content: readonly ContentBlock[]): string {
  return content.map(block => {
    switch (block.type) {
      case 'text': return block.text
      case 'reasoning': return `[思考] ${block.text}`
      case 'tool-call': return `[工具 ${block.name}] ${block.arguments}`
      default: return `[${block.type}] ${JSON.stringify(block)}`
    }
  }).join('\n')
}

/** 外部log-only事件按原生日志直读，不引入对快照组件的类型依赖。 */
function captureText(event: SessionEvent): string | undefined {
  if ((event.type as string) !== 'worktree/capture') return undefined
  const notice = event.data as unknown as { phase?: unknown; full?: unknown; files?: unknown; hashed?: unknown; bytesRead?: unknown; elapsedMs?: unknown }
  if (notice.phase === 'preparing') return '[文件快照] 正在准备文件撤销基线，需要读取整个工作树，完成前不会开始模型请求…'
  if (notice.phase !== 'ready') return undefined
  const bytes = typeof notice.bytesRead === 'number' ? notice.bytesRead : 0
  const size = bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MiB' : Math.round(bytes / 1024) + ' KiB'
  const seconds = typeof notice.elapsedMs === 'number' ? (notice.elapsedMs / 1000).toFixed(1) + ' 秒' : '未知时长'
  return `[文件快照] 基线已就绪：${notice.files} 个文件，本次读取 ${notice.hashed} 个（${size}），耗时 ${seconds}；撤销可用。`
}
/** 领域事件保持原值；客户端不将命令回执改写为模型回复。 */
export function eventText(event: SessionEvent): string | undefined {
  const capture = captureText(event)
  if (capture !== undefined) return capture
  switch (event.type) {
    case 'user/message': return event.data.source.kind === 'user' ? `[用户] ${contentText(event.data.content)}` : undefined
    case 'assistant/message': return `[模型] ${contentText(event.data.message.content)}`
    case 'tool/call': return `[工具调用 ${event.data.name}] ${event.data.arguments}`
    case 'tool/result': {
      const message = event.data.message
      return `[工具结果 ${message.toolCallId}${message.isError ? ' 错误' : ''}] ${contentText(message.content)}`
    }
    case 'command/done': return `[命令 ${event.data.kind}] ${event.data.text ?? ''}`
    case 'turn/end': return `[轮次结束] ${JSON.stringify(event.data.reason)}`
    case 'approval/decided': return `[审批结果] ${event.data.outcome}`
    case 'request/header': {
      const config = event.data.header.config
      return `[模型请求] ${JSON.stringify({ provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort })}`
    }
    default: return undefined
  }
}

/** 人类历史按原始日志顺序展示；模型专用replacement不删除已出现的对话。 */
export function historyLines(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => {
    if (!isAppendSurfaceEvent(event) && !['command/done', 'tool/call', 'turn/end', 'approval/decided', 'worktree/capture'].includes(event.type)) return []
    const text = eventText(event)
    return text === undefined ? [] : [text]
  })
}
/** 只选择该模型实际公布的最高已知档位；不替未知目录猜测强度。 */
export function highestReasoningEffort(catalog: ModelCatalog, provider: string, model: string): string | undefined {
  const entry = catalog.groups.find(group => group.id === provider)?.models.find(item => item.id === model)
  if (!entry) throw new Error('原生目录没有此模型。')
  const efforts = entry.reasoning?.efforts ?? []
  if (!efforts.length) return undefined
  for (const id of ['ultra', 'max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']) if (efforts.some(effort => effort.id === id)) return id
  if (efforts.length === 1) return efforts[0]!.id
  throw new Error('原生目录的推理等级没有已知强度顺序，请显式指定一个effort。')
}
