import type { ConversationCommandSettled, DraftAttachmentId, SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'

interface HistoryDraftResult { sessionId: string; userSeq: number; content: Array<{ type: 'text'; text: string } | { type: 'image' | 'file'; name: string; data: string; mediaType?: string }> }
/** 最小可注入的取回调用面：只用到 URL 字符串与 RequestInit，不绑定宿主运行时的扩展 fetch 签名。 */
export type HistoryDraftFetch = (input: string, init: RequestInit) => Promise<Response>
export interface HistoryDraftClient {
  readonly input: SessionInput
  readonly createDrafts: (files: readonly File[]) => readonly { id: DraftAttachmentId }[]
  readonly release: (id: DraftAttachmentId) => void
  readonly fetch?: HistoryDraftFetch | undefined
}

/** 仅处理这个客户端自己提交的控制命令，不消费别的客户端的日志通知。 */
export async function restoreHistoryComposer(event: ConversationCommandSettled, client: HistoryDraftClient): Promise<boolean> {
  if (event.outcome.kind !== 'success' || !['/undo', '/redo'].includes(event.token.trim())) return false
  const settled = event.outcome.commandResult ?? event.outcome
  if (settled.kind !== 'success' || !settled.text) return false
  let result: { schema?: string; action?: string; changed?: boolean; sessionId?: string; restoreUserSeq?: number | null; files?: { mode?: string } }
  try { result = JSON.parse(settled.text) } catch { return false }
  if (result.schema !== 'lyapunov-history-v1' || !result.changed) return false
  if (result.sessionId !== event.sessionId || event.token.trim() !== '/' + result.action) throw new Error('历史恢复结果与发起命令的会话不匹配。')
  const sequence = result.restoreUserSeq
  if (sequence === undefined || (sequence !== null && (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0))) throw new Error('历史恢复结果缺少有效的原用户消息位置。')
  // 命令生命周期已经结束（会话销毁/发起命令被释放）时，迟到的恢复既不写入输入框，也不该报成业务失败。
  if (event.signal.aborted) return true
  const original = client.input.state.getSnapshot()
  // 命令已经提交；命令完成后的新文字或附件不能被迟到的恢复覆盖。
  if (original.draft || original.attachmentIds.length) { client.input.notify('info', '会话操作已完成；当前草稿有新内容，未覆盖。'); return true }
  let text = '', files: File[] = []
  if (sequence !== null) {
    let response: Response
    try {
      response = await (client.fetch ?? globalThis.fetch)('/api/lyapunov/history-draft', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: event.sessionId, userSeq: sequence }), signal: event.signal })
    } catch (error) {
      if (event.signal.aborted) return true
      throw error
    }
    if (!response.ok) throw new Error(`读取原输入失败：HTTP ${response.status}`)
    const restored = await response.json() as HistoryDraftResult
    if (restored.sessionId !== event.sessionId || restored.userSeq !== sequence || !Array.isArray(restored.content)) throw new Error('原输入响应不属于当前会话与消息。')
    for (const part of restored.content) {
      if (part.type === 'text') text += part.text
      else if (part.type === 'file' || part.type === 'image') {
        const binary = atob(part.data), bytes = Uint8Array.from(binary, value => value.charCodeAt(0))
        files.push(new File([bytes], part.name, { type: part.type === 'image' ? part.mediaType : 'application/octet-stream' }))
      }
    }
  }
  if (event.signal.aborted) return true
  const current = client.input.state.getSnapshot()
  if (current.draftRev !== original.draftRev || current.attachmentIds.length !== original.attachmentIds.length || current.attachmentIds.some((id, index) => id !== original.attachmentIds[index])) {
    client.input.notify('info', '会话操作已完成；读取期间草稿已编辑，未覆盖新内容。')
    return true
  }
  // 全有或全无：附件先入草稿，失败即释放全部新建对象并放弃（不留下只恢复文字的假成功），文字最后写入。
  const created = client.createDrafts(files)
  if (created.length > 0 && !client.input.addAttachments(created.map(item => item.id))) {
    for (const item of created) client.release(item.id)
    throw new Error('输入框正在提交，恢复附件未加入草稿。')
  }
  client.input.setDraft(text)
  const suffix = result.files?.mode === 'not-git' ? ' 此目录不是Git工作树，文件未恢复。' : result.files?.mode === 'disabled' ? ' 文件快照未启用。' : ''
  client.input.notify('info', (sequence === null ? '已重做，输入草稿已清空。' : '原提示词和附件已恢复到草稿，确认后再发送。') + suffix)
  return true
}
