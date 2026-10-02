import { createInterface, type Interface } from 'node:readline'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswer, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import type {} from '@deepseek-ai/dsh-session-title'
import { eventText, highestReasoningEffort, terminalText } from './format.ts'
import { firstFrame } from './workspace-actions.ts'
import { FullscreenTerminal, type FullscreenRuntime, type FullscreenStatus, type NavigationWorkspace } from './fullscreen-terminal.ts'
import { historyPage, type TerminalHistoryOptions } from './history.ts'
import { readTerminalClipboard } from './clipboard.ts'
import { forkTerminalSession, startTerminalSession, TerminalStartupSchema, type TerminalStartupConfig } from './startup.ts'
import { handleTerminalAction } from './actions.ts'
import { completeTerminalInput } from './completion.ts'
import { openTerminalEditor } from './editor.ts'
import { BRACKETED_PASTE_DISABLE, BRACKETED_PASTE_ENABLE, BracketedPasteDecoder, decodeTerminalInput, TerminalInputDrafts, type TerminalInputSegment } from './input.ts'

/** readline仍负责编辑和快捷键；只在其前面标记粘贴来源。 */
class TerminalReadlineStream extends PassThrough {
  readonly isTTY = Boolean(process.stdin.isTTY)
  get isRaw(): boolean { return Boolean(process.stdin.isTTY && process.stdin.isRaw) }
  setRawMode(enabled: boolean): this { if (process.stdin.isTTY) process.stdin.setRawMode(enabled); return this }
}

export const name = 'lyapunov-terminal'
export const inject = ['sessionController', 'sessionProjections', 'commands', 'agents', 'sessions', 'agentDefaultModel', 'attachments', 'fileUploads', 'workspaceController', 'appReady', 'appExit']
export interface Config { enabled?: boolean; cwd?: string; resume?: string; fullscreen?: boolean; startup?: TerminalStartupConfig }
export const Config = Schema.object({ enabled: Schema.boolean().default(false), cwd: Schema.string(), resume: Schema.string(), fullscreen: Schema.boolean().default(false), startup: TerminalStartupSchema })

const help = `Lyapunov 交互终端（开发原型）
普通文本交给原生 SessionController；/命令原样交给 DSH commands。
:new [目录]  :sessions  :open <会话ID>  :history [更早seq|all]  :commands
:begin  :send  :cancel-input  :draft  :discard  :editor（或 /editor）
:attach <文件路径>  :attachments  :detach <附件ID或序号>  :fork [事件序号]
:paste [text|image]（读取系统剪贴板到草稿，:send确认）
:actions（改名/归档/队列/Jobs/Goal/Todo/原生导出）
:workspaces（原生顺序）  :workspace <#序号|ID> [top|end|up|down|before <锚点>]
:models  :model <provider> <model> [effort]  :status
:stop（或 Ctrl+C）  :allow <审批ID>  :deny <审批ID>
:answer <问答ID> <原生答案JSON>  :quit（或 Ctrl+D）
粘贴内容是字面草稿，回车发送；:begin中逐行输入后用:send提交。
--fullscreen：顶部会话状态、左侧Workspace/会话导航、右侧内容、底部多行编辑器；
Tab/Shift+Tab切焦点，导航内↑↓选择、Enter打开，内容区↑↓/PgUp/PgDn/Home/End滚动；编辑器内Tab仍是原生补全。
Tab补全当前会话的/命令和@文件。
冒号命令仅控制终端；未知斜杠命令不会作为提示词发送。`

/** 行式终端适配：只持有当前选择、未完成输入与待呈现的交互请求。 */
export function apply(ctx: Context, config: Config = {}): void {
  if (!config.enabled) return
  let input: Interface | undefined, selected: SessionId | undefined, closing = false
  let selectedAgent: Agent | undefined
  // 全屏只替换呈现与按键路由：所有操作仍走下面同一批闭包与原生服务。
  let screen: FullscreenTerminal | undefined
  let inputEnded = false, startupComplete = false, pipelineSent = false, pipelineResult: number | undefined
  let readlineStream: TerminalReadlineStream | undefined
  let pasteTarget: { sessionId?: SessionId; line: string; cursor: number } | undefined
  let chain = Promise.resolve(), interactionId = 0
  let completion: AbortController | undefined
  let editing = false
  const editorOutput: string[] = []
  const queuedInputs = new Set<AbortController>()
  const lifetime = new AbortController(), owned = new Set<SessionId>(), commands = new Map<SessionId, Set<AbortController>>()
  const drafts = new TerminalInputDrafts(ctx), decoder = new BracketedPasteDecoder()
  const approvals = new Map<string, { sessionId: SessionId; settle(outcome: ApprovalOutcome): void }>()
  const questions = new Map<string, { sessionId?: SessionId; settle(answer: AskUserQuestionAnswer): void; cancel(): void }>()
  const textStream = new Set<SessionId>()
  const write = (text: string) => {
    if (closing) return
    const value = terminalText(text)
    if (editing) editorOutput.push(value)
    else if (screen) screen.write(value)
    else process.stdout.write(value)
  }
  const line = (text: string) => {
    if (closing) return
    if (screen) { screen.line(terminalText(text)); return }
    write('\n' + text + '\n')
    if (!inputEnded && !editing) input?.prompt(true)
  }
  const error = (reason: unknown) => line(`[错误] ${reason instanceof Error ? reason.message : String(reason)}`)
  const agentFor = async (id = selected, signal = lifetime.signal): Promise<Agent> => {
    signal.throwIfAborted()
    if (!id) throw new Error('请先 :new 或 :open 一个会话。')
    const result = await ctx.sessionController.resolveAgent(id)
    signal.throwIfAborted()
    if ('error' in result) throw result.error
    return result.agent
  }
  const history = async (signal = lifetime.signal, options: TerminalHistoryOptions = {}) => {
    const agent = await agentFor(selected, signal)
    line(`[历史 ${agent.id}] 原生人类消息与命令日志`)
    const page = historyPage(agent.session.snapshotEvents(), options)
    for (const entry of page.entries) line(`[seq=${entry.seq}] ${entry.text}`)
    line(`[历史结束 ${agent.id}]`)
    if (page.hasMore) line(`[更早历史] :history ${page.nextBeforeSeq}；:history all显示全部。`)
  }
  const select = async (id: SessionId, signal = lifetime.signal) => {
    const agent = await agentFor(id, signal)
    completion?.abort()
    selected = id; selectedAgent = agent; owned.add(id)
    input?.setPrompt(`lyapunov:${id}> `)
    line(`[会话] ${id} [状态] ${agent.status}`)
    const draft = drafts.getSnapshot(id)
    if (draft.text || draft.attachments.length) line(`[草稿 ${id}] ${draft.text.length} 字符，${draft.attachments.length} 个附件；:draft查看，:send发送。`)
  }
  const cancel = () => {
    // 在readline收件时登记的队列也归Stop取消，不能让旧输入在cancel之后才提交。
    for (const pending of queuedInputs) pending.abort(new Error('用户取消输入'))
    completion?.abort()
    if (!selected) return
    for (const controller of commands.get(selected) ?? []) controller.abort(new Error('用户取消命令'))
    for (const pending of approvals.values()) if (pending.sessionId === selected) pending.settle('cancelled')
    for (const pending of questions.values()) if (pending.sessionId === selected) pending.cancel()
    const result = ctx.sessionController.cancel({ sessionId: selected })
    line(`[取消已受理 ${selected}] ${JSON.stringify(result)}`)
  }
  const quit = (code = 0) => { if (!closing) { closing = true; ctx.appExit!(code) } }
  const finishEndedInput = () => {
    if (!inputEnded || !startupComplete || closing) return
    if (process.stdin.isTTY || !pipelineSent) { quit(pipelineResult ?? 0); return }
    if (pipelineResult !== undefined && selectedAgent?.status === 'idle') quit(pipelineResult)
  }
  const operation = async <T>(id: SessionId, work: (signal: AbortSignal) => Promise<T>, inputSignal = lifetime.signal): Promise<T> => {
    inputSignal.throwIfAborted()
    const controller = new AbortController(), active = commands.get(id) ?? new Set<AbortController>()
    active.add(controller); commands.set(id, active)
    try { return await work(AbortSignal.any([controller.signal, inputSignal, lifetime.signal])) }
    finally { active.delete(controller); if (!active.size) commands.delete(id) }
  }
  const hasDraftInput = (id: SessionId) => {
    const snapshot = drafts.getSnapshot(id)
    return Boolean(snapshot.text.trim() || snapshot.attachments.length)
  }
  const submitDraft = async (id: SessionId, mode: 'queue' | 'steer' = 'queue', inputSignal = lifetime.signal) => {
    inputSignal.throwIfAborted()
    if (!hasDraftInput(id)) return
    const result = await operation(id, signal => drafts.submit(id, { signal, mode }), inputSignal)
    if (!result.accepted) throw new Error('原生会话未接收输入，草稿已保留。')
    line(`[输入已交给原生会话 ${id}]`)
  }

  // 全屏只是呈现层：导航/状态/草稿每次读原生 owner，打开会话仍调用上面的 select，
  // 因此不存在第二份会话状态、第二套命令或第二套审批实现。
  const fullscreenRuntime: FullscreenRuntime = {
    navigation: async signal => {
      const controller = ctx.get('workspaceController')
      if (!controller) return []
      const frame = await firstFrame(controller.follow(signal))
      if (frame.type !== 'baseline') throw new Error('原生 Workspace 状态流缺少 baseline。')
      const archived = new Set<string>(frame.value.archivedSessionIds)
      const titles = ctx.get('sessionTitle')
      return frame.value.items.map<NavigationWorkspace>(item => ({
        id: String(item.workspaceId), title: item.title,
        sessions: item.sessionIds.map(sessionId => {
          // 标题来自原生标题服务，且只对仍然在线的会话可读；离线会话说不出标题就不编一个。
          const live = ctx.sessions.get(sessionId)
          const title = live === undefined ? undefined : titles?.get(live)?.title
          return {
            id: String(sessionId), ...(title === undefined ? {} : { title }),
            archived: archived.has(String(sessionId)), current: sessionId === selected,
          }
        }),
      }))
    },
    status: (): Omit<FullscreenStatus, 'focus' | 'scrollBack' | 'note'> => {
      const draft = selected === undefined ? undefined : drafts.getSnapshot(selected)
      const selection = ctx.agentDefaultModel.currentSelection()
      const jobs = ctx.get('jobs')
      return {
        ...(selected === undefined ? {} : { sessionId: String(selected) }),
        ...(selectedAgent === undefined ? {} : { agentStatus: selectedAgent.status }),
        model: `${selection.provider}/${selection.model}`,
        draftLines: draft?.text ? draft.text.split('\n').length : 0,
        attachments: draft?.attachments.length ?? 0,
        pendingApprovals: [...approvals.keys()],
        pendingQuestions: [...questions.keys()],
        jobs: selectedAgent === undefined || !jobs ? 0 : jobs.list(selectedAgent).length,
      }
    },
    editor: () => ({
      draft: selected === undefined ? '' : drafts.getText(selected),
      line: input?.line ?? '',
      cursor: input?.cursor ?? 0,
    }),
    // 与 `:open <ID>` 完全相同的两步：原生 select 之后重放人类历史。
    openSession: async id => { await select(SessionId(id)); await history() },
    note: text => line(text),
  }

  // 真实审批/问答仍由原生服务校验、记账与取消；终端只返回人的明确选择。
  ctx.on('approval/request', (request: ApprovalRequestEvent, next) => {
    if (!owned.has(request.agent.id) || closing) return next()
    if (!process.stdin.isTTY) {
      line('[INPUT_REQUIRES_TTY] 此操作需要人工审批，请在交互终端中重试。')
      pipelineResult = 2; ctx.sessionController.cancel({ sessionId: request.agent.id })
      return Promise.resolve<ApprovalOutcome>('cancelled')
    }
    const id = `a${++interactionId}`
    return new Promise<ApprovalOutcome>(resolveAnswer => {
      const abort = () => settle('cancelled')
      const settle = (outcome: ApprovalOutcome) => { approvals.delete(id); request.signal?.removeEventListener('abort', abort); resolveAnswer(outcome) }
      approvals.set(id, { sessionId: request.agent.id, settle })
      request.signal?.addEventListener('abort', abort, { once: true })
      if (request.signal?.aborted) { abort(); return }
      line(`[审批 ${id} 会话=${request.agent.id}] ${request.toolName}\n${request.reason ?? ''}\n输入 :allow ${id} 或 :deny ${id}`)
    })
  }, { prepend: true })
  ctx.on('user-questions/request', (request: AskUserQuestionRequestEvent, next) => {
    if (!request.agent || !owned.has(request.agent.id) || closing) return next()
    if (!process.stdin.isTTY) {
      line('[INPUT_REQUIRES_TTY] 此操作需要回答问题，请在交互终端中重试。')
      pipelineResult = 2; ctx.sessionController.cancel({ sessionId: request.agent.id })
      throw new Error('INPUT_REQUIRES_TTY')
    }
    const id = `q${++interactionId}`
    return new Promise<AskUserQuestionAnswer>((resolveAnswer, reject) => {
      const cleanup = () => { questions.delete(id); request.signal?.removeEventListener('abort', cancelQuestion) }
      const cancelQuestion = () => { cleanup(); reject(new Error('终端问答已取消')) }
      questions.set(id, { sessionId: request.agent!.id, settle(answer) { cleanup(); resolveAnswer(answer) }, cancel: cancelQuestion })
      request.signal?.addEventListener('abort', cancelQuestion, { once: true })
      if (request.signal?.aborted) { cancelQuestion(); return }
      line(`[问答 ${id}] ${JSON.stringify(request.questions)}\n输入 :answer ${id} {"answers":[{"id":"问题ID","selected":["选项"],"custom":"补充"}]}`)
    })
  }, { prepend: true })
  ctx.on('session/event', (session, event: SessionEvent) => {
    if (!owned.has(session.id)) return
    if (event.type === 'assistant/message' && textStream.delete(session.id)) line(`[模型已保存 ${session.id} seq=${event.seq}]`)
    else { const rendered = eventText(event); if (rendered) line(`[${session.id}] ${rendered}`) }
    if (pipelineSent && session.id === selected && event.type === 'turn/end') {
      pipelineResult ??= event.data.reason.kind === 'completed' ? 0 : 1
    }
  })
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (!owned.has(agent.id)) return
    if (frame.type === 'start') write(`\n[模型流 ${agent.id}]\n`)
    if (frame.type === 'chunk' && (frame.chunk.type === 'text-delta' || frame.chunk.type === 'reasoning-delta')) {
      if (frame.chunk.type === 'text-delta') textStream.add(agent.id)
      write(frame.chunk.text)
    }
    if (frame.type === 'end') write('\n')
  })
  ctx.on('agent/error', ({ agent, error: reason }) => { if (owned.has(agent.id)) error(reason) })
  ctx.on('agent/status', ({ agent, status }) => {
    if (owned.has(agent.id)) line(`[状态 ${agent.id}] ${status}`)
    if (agent.id === selected && status === 'idle') finishEndedInput()
  })

  const execute = async (raw: string, inputSignal: AbortSignal) => {
    inputSignal.throwIfAborted()
    const text = raw.trim(); if (closing) return
    // 多行中的普通文字和斜杠均为内容；只有显式草稿操作在此模式继续解释。
    if (selected && drafts.getSnapshot(selected).multiline && !/^:(?:send|cancel-input|draft|discard|editor|paste(?:\s|$)|attachments|attach(?:\s|$)|detach(?:\s|$))/.test(text)) {
      drafts.appendMultiline(selected, raw); return
    }
    if (!text) {
      if (selected && drafts.getSnapshot(selected).multiline) drafts.appendMultiline(selected, raw)
      else if (selected) await submitDraft(selected, 'queue', inputSignal)
      return
    }
    if (text === ':help') { line(help); return }
    if (text === ':sessions') { line(JSON.stringify(await ctx.sessionController.list({}, inputSignal), null, 2)); return }
    if (text === ':new' || text.startsWith(':new ')) {
      const created = await startTerminalSession(ctx, { cwd: resolve(text.slice(4).trim() || config.startup?.cwd || config.cwd || process.cwd()) }, inputSignal)
      await select(created.sessionId, inputSignal); return
    }
    if (text.startsWith(':open ')) { await select(SessionId(text.slice(6).trim()), inputSignal); await history(inputSignal); return }
    if (text === ':history' || text.startsWith(':history ')) {
      const cursor = text.slice(8).trim()
      if (cursor && cursor !== 'all' && !/^\d+$/.test(cursor)) throw new Error('用法：:history [非负seq|all]')
      await history(inputSignal, cursor === 'all' ? { all: true } : cursor ? { beforeSeq: Number(cursor) } : {}); return
    }
    if (/^[:/](undo|redo|undo_status)$/.test(text)) {
      const agent = await agentFor(selected, inputSignal)
      const result = await operation(agent.id, signal => handleTerminalAction({ ctx, sessionId: agent.id, text: ':' + text.slice(1), signal }), inputSignal)
      if (!result.handled) throw new Error('撤销命令不可用。')
      for (const row of result.lines) line(row)
      if (result.history?.changed) {
        const seq = result.history.restoreUserSeq
        if (seq === null) drafts.clear(agent.id)
        else if (seq !== undefined) {
          const event = agent.session.snapshotEvents().find(event => event.seq === seq)
          if (event?.type !== 'user/message') throw new Error('原用户消息不可读取，未替换草稿。')
          drafts.restoreContent(agent.id, event.data.content)
        }
        await history(inputSignal)
        line(seq === null ? '[撤销草稿] 重做已完成，草稿已清空。' : '[撤销草稿] 已恢复原文字与附件；:draft查看，:send确认。')
      }
      return
    }
    if (text === ':paste' || text.startsWith(':paste ')) {
      const kind = text.slice(6).trim() || 'auto'
      if (!['auto', 'text', 'image'].includes(kind)) throw new Error('用法：:paste [text|image]')
      const agent = await agentFor(selected, inputSignal)
      await operation(agent.id, async signal => {
        const value = await readTerminalClipboard({ kind: kind as 'auto' | 'text' | 'image', signal, tools: {
          'xclip': process.env.LYAPUNOV_CLIPBOARD_XCLIP, 'xsel': process.env.LYAPUNOV_CLIPBOARD_XSEL, 'wl-paste': process.env.LYAPUNOV_CLIPBOARD_WL_PASTE,
        } })
        signal.throwIfAborted()
        if (value.kind === 'text') drafts.setText(agent.id, drafts.getText(agent.id) + value.text)
        else await drafts.addImage(agent.id, value, signal)
        line(`[剪贴板已加入草稿] ${value.kind === 'text' ? value.text.length + ' 字符' : value.name}；:send确认发送。`)
      }, inputSignal)
      return
    }
    if (text === ':editor' || text === '/editor') {
      const agent = await agentFor(selected, inputSignal)
      const activity = new AbortController(), appInterrupt = ctx.get('appInterrupt')
      if (!appInterrupt) throw new Error('EDITOR_INTERRUPT_UNAVAILABLE: 请使用包含终端中断支持的完整软件入口。')
      const edited = await operation(agent.id, signal => openTerminalEditor({
        text: drafts.getText(agent.id), cwd: agent.session.header.cwd ?? process.cwd(), signal: AbortSignal.any([signal, activity.signal]),
        suspend: () => {
          const wasRaw = Boolean(process.stdin.isRaw)
          const releaseInterrupt = appInterrupt.onInterrupt(() => {
            activity.abort(new Error('EDITOR_CANCELLED: 外部编辑已取消，原草稿和附件保留。'))
            return true
          })
          editing = true; completion?.abort()
          input?.pause(); process.stdin.off('data', onData); process.stdin.pause()
          if (process.stdin.isTTY) process.stdin.setRawMode(false)
          if (process.stdout.isTTY) process.stdout.write(BRACKETED_PASTE_DISABLE)
          // 外部编辑器独占终端：全屏退出备用屏幕暂停绘制，返回后再整帧重画。
          screen?.pause()
          return () => {
            editing = false
            if (!closing) {
              if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw)
              process.stdin.on('data', onData); input?.resume(); process.stdin.resume()
              if (process.stdin.isTTY && process.stdout.isTTY) process.stdout.write(BRACKETED_PASTE_ENABLE)
              screen?.resume()
              // 编辑器期间积下的输出回到同一呈现层，不越过全屏直接写 stdout。
              for (const output of editorOutput) { if (screen) screen.write(output); else process.stdout.write(output) }
            }
            releaseInterrupt()
            editorOutput.length = 0
          }
        },
      }), inputSignal)
      inputSignal.throwIfAborted()
      drafts.setText(agent.id, edited)
      line(`[编辑器已返回] ${edited.length} 字符；附件保留，:send发送。`)
      return
    }
    if (text === ':begin' || text === ':send' || text === ':cancel-input' || text === ':draft' || text === ':discard' || text === ':attachments' || text.startsWith(':attach ') || text.startsWith(':detach ') || text === ':fork' || text.startsWith(':fork ')) {
      const agent = await agentFor(selected, inputSignal), id = agent.id
      if (text === ':begin') { drafts.beginMultiline(id); line('[多行输入] 每行按字面保存；:send提交，:cancel-input恢复编辑前草稿。'); return }
      if (text === ':send') { await submitDraft(id, 'queue', inputSignal); return }
      if (text === ':cancel-input') { drafts.cancelMultiline(id); line('[多行输入已取消]'); return }
      if (text === ':discard') { drafts.clear(id); line('[草稿已清除] 源文件和原生附件对象保留。'); return }
      if (text === ':draft') { const value = drafts.getSnapshot(id); line(`[草稿 ${id}]\n${value.text}\n${value.attachments.length} 个附件`); return }
      if (text === ':attachments') { line(JSON.stringify(drafts.getSnapshot(id).attachments.map((item, index) => ({ index: index + 1, id: item.id, name: item.name, kind: item.kind, bytes: item.bytes })), null, 2)); return }
      if (text.startsWith(':attach ')) {
        const value = text.slice(8).trim(), path = /^("[\s\S]*"|'[\s\S]*')$/.test(value) ? value.slice(1, -1) : value
        const attachment = await operation(id, signal => drafts.addAttachment(id, path, agent.session.header.cwd ?? process.cwd(), signal), inputSignal)
        line(`[附件已加入 ${id}] ${JSON.stringify(attachment.name)} ${attachment.kind} ${attachment.bytes} 字节 id=${attachment.id}`); return
      }
      if (text.startsWith(':detach ')) {
        const value = text.slice(8).trim(), index = /^\d+$/.test(value) ? Number(value) - 1 : -1
        const target = index >= 0 ? drafts.getSnapshot(id).attachments[index]?.id : value
        if (!target || !drafts.removeAttachment(id, target)) throw new Error('附件ID或序号不存在。')
        line('[附件已从草稿移除] 原件保留。'); return
      }
      const value = text.slice(5).trim(), atSeq = value ? Number(value) : undefined
      if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || atSeq < 0)) throw new Error('用法：:fork [非负事件序号]')
      const forked = await operation(id, signal => forkTerminalSession(ctx, id, signal, atSeq), inputSignal)
      await select(forked.sessionId, inputSignal); await history(inputSignal); return
    }
    if (text === ':commands') { line(ctx.commands.list(await agentFor(selected, inputSignal)).map(command => `/${command.name} ${command.description}`).join('\n')); return }
    if (text === ':models') { line(JSON.stringify(await ctx.sessionController.modelCatalog(), null, 2)); return }
    if (text.startsWith(':model ')) {
      const [, provider, model, reasoningEffort] = text.split(/\s+/)
      if (!provider || !model) throw new Error('用法：:model <provider> <model> [effort]')
      const effort = reasoningEffort ?? highestReasoningEffort(await ctx.sessionController.modelCatalog(), provider, model)
      line(JSON.stringify(await ctx.sessionController.selectModel({ sessionId: (await agentFor(selected, inputSignal)).id, provider, model, reasoningEffort: effort }))); return
    }
    if (text === ':status') {
      const agent = await agentFor(selected, inputSignal), config = agent.session.requestHeader()?.config
      line(JSON.stringify({ sessionId: agent.id, status: agent.status, defaultModel: ctx.agentDefaultModel.currentSelection(), lastRequestModel: config && { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort }, seq: agent.session.seq })); return
    }
    if (text.startsWith(':')) {
      const result = selected ? await operation(selected, signal => handleTerminalAction({ ctx, sessionId: selected, text: raw, signal }), inputSignal) : await handleTerminalAction({ ctx, text: raw, signal: inputSignal })
      if (!result.handled) throw new Error('未知终端操作；输入 :help。')
      for (const value of result.lines) line(value)
      if (result.selection) await select(result.selection, inputSignal)
      return
    }
    const agent = await agentFor(selected, inputSignal)
    if (drafts.getSnapshot(agent.id).multiline) { drafts.appendMultiline(agent.id, raw); return }
    if (text.startsWith('/')) {
      await operation(agent.id, async signal => {
        const prepared = await drafts.prepareSubmission(agent.id, { signal, text: '' })
        const result = await ctx.commands.execute(agent, raw, [...prepared.commandAttachments], signal)
        if (!result) throw new Error('原生命令不存在；未发送给模型。')
        if (result.result.kind === 'success') prepared.commit()
      }, inputSignal)
      return
    }
    drafts.setText(agent.id, drafts.getText(agent.id) + raw)
    await submitDraft(agent.id, 'queue', inputSignal)
  }
  const onLine = (raw: string) => {
    try {
      if (raw.trim() === ':quit') { quit(); return }
      if (raw.trim() === ':stop') { cancel(); return }
      const decision = /^:(allow|deny)\s+(\S+)\s*$/.exec(raw)
      if (decision) { const pending = approvals.get(decision[2]!); if (!pending) throw new Error('审批已结束或ID不存在。'); pending.settle(decision[1] === 'allow' ? 'allowed-once' : 'rejected'); return }
      const answer = /^:answer\s+(\S+)\s+([\s\S]+)$/.exec(raw)
      if (answer) { const pending = questions.get(answer[1]!); if (!pending) throw new Error('问答已结束或ID不存在。'); pending.settle(JSON.parse(answer[2]!) as AskUserQuestionAnswer); return }
      const controller = new AbortController()
      queuedInputs.add(controller)
      const signal = AbortSignal.any([controller.signal, lifetime.signal])
      chain = chain.then(() => execute(raw, signal)).catch(reason => {
        if (signal.aborted && !closing) line('[输入已取消] 未接收的内容没有继续提交。')
        else error(reason)
      }).finally(() => queuedInputs.delete(controller))
    } catch (reason) { error(reason) }
  }
  const segments = (items: TerminalInputSegment[]) => {
    for (const segment of items) {
      if (segment.type === 'typed') { readlineStream?.write(segment.text); continue }
      if (segment.type === 'paste-start') {
        pasteTarget = { sessionId: selected, line: input?.line ?? '', cursor: input?.cursor ?? 0 }
        input?.write(null, { name: 'e', ctrl: true })
        input?.write(null, { name: 'u', ctrl: true })
        continue
      }
      const target = pasteTarget; pasteTarget = undefined
      // 顺序排在前一次提交之后，避免将已发送文字再次拼进新粘贴草稿。
      chain = chain.then(() => {
        const id = target?.sessionId ?? selected
        if (!id) throw new Error('会话尚未就绪，无法保存粘贴内容。')
        const typed = target?.line ?? '', cursor = target?.cursor ?? typed.length
        const value = typed.slice(0, cursor) + segment.text + typed.slice(cursor)
        if (drafts.getSnapshot(id).multiline) drafts.appendMultiline(id, value)
        else drafts.setText(id, drafts.getText(id) + value)
        line(`[粘贴草稿 ${id}] ${value.length} 字符，${value.split('\n').length} 行；${segment.complete ? '按回车或:send发送，:draft查看。' : '粘贴未闭合，未自动发送。'}`)
      }).catch(error)
    }
  }
  const onData = (chunk: Buffer | string) => {
    // 先由原生 decoder 判定 literal（粘贴标记跨 chunk 由它保留），全屏只路由 typed 片段：
    // 粘贴正文里的 Tab/CR 不进按键路由，不会切焦点或触发 openSession。
    segments(decodeTerminalInput(decoder, screen, chunk))
    // 光标移动、补全候选等只改 readline 内部状态；这里统一触发一次重绘。
    screen?.invalidate()
  }
  const onEnd = () => { segments(decoder.end()); readlineStream?.end() }
  ctx.effect(() => async () => {
    closing = true; lifetime.abort(); input?.close()
    screen?.dispose()
    process.stdin.off('data', onData); process.stdin.off('end', onEnd)
    process.stdin.pause()
    readlineStream?.destroy()
    if (process.stdin.isTTY && process.stdout.isTTY) process.stdout.write(BRACKETED_PASTE_DISABLE)
    for (const pending of approvals.values()) pending.settle('cancelled')
    for (const pending of questions.values()) pending.cancel()
    await chain
    drafts.dispose()
  })
  ctx.effect(() => ctx.appReady!.onReady(() => {
    // 非 TTY 明确拒绝：不进入备用屏幕，保持已经验证过的行式终端。
    if (config.fullscreen) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) line('[全屏不可用] --fullscreen 需要 stdin 与 stdout 都是真实终端；本次保持行式终端。')
      else screen = new FullscreenTerminal(fullscreenRuntime, { stdout: process.stdout })
    }
    readlineStream = new TerminalReadlineStream()
    input = createInterface({
      input: readlineStream, output: screen?.readlineSink ?? process.stdout, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      completer: (text, done) => {
        completion?.abort()
        const controller = new AbortController(), id = selected, before = input?.line, cursor = input?.cursor
        completion = controller
        const signal = AbortSignal.any([controller.signal, lifetime.signal])
        void completeTerminalInput({ ctx, sessionId: id, text, signal }).then(result => {
          done(null, !signal.aborted && selected === id && input?.line === before && input?.cursor === cursor ? result : [[], text])
        }, reason => { if (!signal.aborted) error(reason); done(null, [[], text]) }).finally(() => { if (completion === controller) completion = undefined })
      },
    })
    input.setPrompt('lyapunov> '); input.on('line', onLine); input.on('SIGINT', () => { try { cancel() } catch (reason) { error(reason) } })
    input.on('close', () => { inputEnded = true; finishEndedInput() })
    if (process.stdin.isTTY && process.stdout.isTTY) process.stdout.write(BRACKETED_PASTE_ENABLE)
    process.stdin.on('data', onData); process.stdin.on('end', onEnd)
    if (process.stdin.readableEnded) onEnd()
    screen?.start(lifetime.signal)
    line(help)
    chain = (async () => {
      try {
        const opened = await startTerminalSession(ctx, { cwd: config.cwd, sessionId: config.resume, ...config.startup }, lifetime.signal)
        await select(opened.sessionId)
        if (opened.disposition !== 'created') await history()
        line(`[就绪] DSH原生交互终端；默认 ${JSON.stringify(ctx.agentDefaultModel.currentSelection())}`)
        if (opened.prompt?.trim()) {
          drafts.setText(opened.sessionId, opened.prompt)
          if (opened.promptMode === 'send') {
            pipelineSent = !process.stdin.isTTY && hasDraftInput(opened.sessionId)
            // --prompt是用户内容，不得解释成:quit等终端控制命令。
            await submitDraft(opened.sessionId)
          } else if (!process.stdin.isTTY) {
            pipelineResult = 2
            throw new Error('INPUT_REQUIRES_TTY: 旧会话prompt默认仅预填；请用交互终端确认，或显式 --prompt-mode send。')
          } else line('[启动草稿] 已保留 --prompt；:draft查看，回车或:send发送。')
        }
      } catch (reason) {
        error(reason); pipelineResult ??= 1
        if (!process.stdin.isTTY) pipelineSent = false
      } finally { startupComplete = true; finishEndedInput() }
    })()
  }))
}
