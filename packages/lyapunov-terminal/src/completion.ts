import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-file-reference'
import { activeAtToken, formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import type { SessionId } from '@deepseek-ai/dsh-session'

export interface TerminalCompletionInput {
  readonly ctx: Context
  readonly sessionId?: SessionId
  /** readline 提供的光标前文本；光标后的正文不参与补全。 */
  readonly text: string
  readonly signal: AbortSignal
}

/** 可直接交给 Node readline completer 的 [候选插入文本, 被替换后缀]。 */
export type TerminalCompletionResult = [candidates: string[], replace: string]

/** 只读取当前 Agent 的原生命令表和文件引用服务，不执行命令或读取文件正文。 */
export async function completeTerminalInput(input: TerminalCompletionInput): Promise<TerminalCompletionResult> {
  const { ctx, sessionId, text, signal } = input
  signal.throwIfAborted()
  const command = /^\/[a-z0-9_-]*$/u.test(text)
  const file = command ? undefined : activeAtToken(text, text.length)
  if (!sessionId || (!command && !file)) return [[], text]
  const files = file ? ctx.get('fileReferences') : undefined
  const commands = command ? ctx.get('commands') : undefined
  if (!files && !commands) return [[], file?.prefix ?? text]
  const resolved = await ctx.sessionController.resolveAgent(sessionId)
  signal.throwIfAborted()
  if ('error' in resolved) throw resolved.error
  if (commands) return [commands.list(resolved.agent).map(item => '/' + item.name).filter(name => name.startsWith(text)), text]
  const candidates = await files!.list(resolved.agent, file!.query, signal)
  signal.throwIfAborted()
  return [candidates.flatMap(candidate => {
    const mention = formatFileMention(candidate, file!.quoted)
    return mention === undefined ? [] : [mention]
  }), file!.prefix]
}
