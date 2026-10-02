import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationController } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { restoreHistoryComposer, type HistoryDraftClient } from './client-restore.ts'

export const inject = ['sessions', 'conversation']
export function apply(ctx: Context): void {
  ctx.on('conversation/command-settled', async event => {
    const sessions = ctx.get('sessions') as unknown as ISessions
    const scope = sessions.scope(event.sessionId)
    if (!scope || sessions.scopeOf(scope) !== event.sessionId) return
    const conversation = ctx.get('conversation') as unknown as ConversationController
    const client: HistoryDraftClient = {
      input: conversation.input.for(scope),
      createDrafts: files => conversation.createDrafts(event.sessionId, files),
      release: id => conversation.releaseDraftAttachment(id),
    }
    try {
      await restoreHistoryComposer(event, client)
    } catch (error) {
      if (event.signal.aborted) return
      // 本事件由 cordis parallel 广播，抛出的原因会被聚合抹成空消息；失败原因直接落到本会话输入框。
      client.input.notify('error', error instanceof Error && error.message ? error.message : String(error))
    }
  })
}
