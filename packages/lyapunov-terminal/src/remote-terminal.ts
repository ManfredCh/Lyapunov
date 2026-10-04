import { createInterface, type Interface } from 'node:readline'
import { open, unlink } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionAssistantStreamBaseline, SessionControlFrame, SessionFollowFrame, SessionRequestId, SessionWireHeader } from '@deepseek-ai/dsh-api-session-controller/types'
import type { JobListFrame, JobView } from '@deepseek-ai/dsh-api-job-controller/types'
import { expandAssistantStream, joinAssistantStreamText, type AssistantStreamRecord } from '@deepseek-ai/dsh-llm/assistant-stream'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/node'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/node'
import { activeAtToken, formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import { connectTerminalRemote, type TerminalRemoteOptions } from './remote-connection.ts'
import { RemoteTerminalDrafts } from './remote-draft.ts'
import { firstFrame, handleWorkspaceAction, type WorkspaceOrderService } from './workspace-actions.ts'
import { FullscreenTerminal, type FullscreenRuntime, type FullscreenStatus, type NavigationWorkspace } from './fullscreen-terminal.ts'
import { BRACKETED_PASTE_DISABLE, BRACKETED_PASTE_ENABLE, BracketedPasteDecoder, decodeTerminalInput } from './input.ts'
import { eventText, historyLines, highestReasoningEffort, terminalText } from './format.ts'
import { openTerminalEditor } from './editor.ts'
import { readTerminalClipboard } from './clipboard.ts'
import { historyPage } from './history.ts'
import type { TerminalStartupConfig } from './startup.ts'

/** 行式终端对进行中助手流的短期输出游标：本 attempt 已写出的正文与已消费的稠密下标。 */
interface LiveAttempt { readonly attemptId: string; next: number; text: string }

class InputStream extends PassThrough {
  readonly isTTY = Boolean(process.stdin.isTTY)
  get isRaw() { return Boolean(process.stdin.isRaw) }
  setRawMode(raw: boolean) { if (process.stdin.isTTY) process.stdin.setRawMode(raw); return this }
}
function value<T>(result: RemoteResult<T>): T { if (!result.ok) throw result.error; return result.value }
const unquote = (text: string) => /^("[\s\S]*"|'[\s\S]*')$/.test(text) ? text.slice(1, -1) : text

/** Jobs 展示只跟随原生全量 rows 流；缺锚点/断流为未知，不制造空列表或新 owner。 */
export function followTerminalJobRows(remote: Pick<ClientRemote, '$stream' | 'job'>, sessionId: SessionId, changed: (jobs: readonly JobView[] | undefined) => void) {
  const { job } = remote
  changed(undefined)
  const stream = remote.$stream<JobListFrame>({
    name: '终端原生 Jobs ' + sessionId,
    open: signal => job.list({ sessionId }, signal),
    ended: accepted => accepted ? new RemoteStreamCarrierError('Jobs 连接结束，等待原生重连') : new Error('原生 Jobs 流没有返回初始列表。'),
    carrierFailed: () => changed(undefined),
  })
  const task = (async () => {
    try {
      for await (const item of stream) { changed(item.value.jobs); item.accept() }
    } catch (reason) { changed(undefined); throw reason }
    finally { await stream.dispose() }
  })()
  return { task, dispose: () => stream.dispose() }
}

/** :jobs 只读原生第一份实际列表；流未给锚点时失败，不以空值冒充。 */
export async function firstTerminalJobRows(remote: Pick<ClientRemote, 'job'>, sessionId: SessionId, signal: AbortSignal): Promise<readonly JobView[]> {
  const frame = await firstFrame(remote.job.list({ sessionId }, signal))
  if (frame.type !== 'rows') throw new Error('原生 Jobs 流缺少 rows 锚点。')
  return frame.jobs
}

/** 连接已有Host的终端表面；不启动Host，不持有远端Agent/Session/Goal，退出只断开客户端。 */
export async function runRemoteTerminal(options: TerminalRemoteOptions & { startup?: TerminalStartupConfig; fullscreen?: boolean }): Promise<number> {
  const lifetime = new AbortController(), drafts = new RemoteTerminalDrafts(), pending = new Set<AbortController>()
  const linked = await connectTerminalRemote({ ...options, signal: AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])]) })
  const { remote } = linked, owned = new Set<SessionId>()
  // 远端 Workspace 命名空间适配成本地同款的最小结构接口：流原样透传，RPC 结果解包后仍是原生值。
  const workspaceOrder: WorkspaceOrderService = {
    follow: signal => remote.workspace.follow(signal),
    insertBefore: async request => value(await remote.workspace.insertBefore(request)),
  }
  // 归属规则与本地同一份：在远端原生 Workspace owner 里按实际 cwd 定位/复用或创建，再走原生 attach 通道。
  const ensureWorkspace = async (path: string) => value(await remote.workspace.create({ path })).workspace
  const attachWorkspace = async (sessionId: SessionId, workspaceId: WorkspaceId) => { value(await remote.session.create({ sessionId, workspaceId })) }
  // 没有显式目录时以服务端默认事实为准：会话建好后从原生快照读回它自己的 cwd，再按同一规则挂进 Workspace，
  // 不拿本地 cwd 冒充远端目录。
  const adoptWorkspace = async (sessionId: SessionId, signal?: AbortSignal) => {
    const directory = views.get(sessionId)?.header.cwd
    if (directory === undefined) throw new Error('远端会话没有 cwd，无法归属 Workspace。')
    signal?.throwIfAborted()
    await attachWorkspace(sessionId, (await ensureWorkspace(directory)).workspaceId)
    signal?.throwIfAborted()
  }
  const views = new Map<SessionId, { header: SessionWireHeader; cursor: number; before?: number; hasMore: boolean; projections: Record<string, unknown> }>()
  const streams = new Map<SessionId, ReturnType<typeof remote.$stream<SessionFollowFrame>>>()
  const tasks: Promise<unknown>[] = [], approvals = new Map<string, (outcome: 'allowed-once' | 'rejected' | 'cancelled') => void>(), questions = new Map<string, { answer(value: unknown): void; cancel(): void }>()
  let selected: SessionId | undefined, input: Interface | undefined, serial = 0, chain = Promise.resolve(), closing = false, editing = false, editorAbort: AbortController | undefined
  let ended = false, pipeline = false, pipelineResult: number | undefined, started = false
  // 流水线一旦受理就记住那次提交所属的会话与回合：之后 :open 切换 selected 也不能丢失结果归属。
  let pipelineRequest: SessionRequestId | undefined, pipelineAdmitted = false, pipelineTurn: number | undefined
  let pipelineSession: SessionId | undefined
  // 全屏与本地入口共用同一个 FullscreenTerminal：这里只提供远端投影与远端动作，不持有第二份会话状态。
  let screen: FullscreenTerminal | undefined
  const activeTurns = new Map<SessionId, number>()
  const running = new Map<SessionId, boolean>()
  const jobsBySession = new Map<SessionId, readonly JobView[]>(), jobStreams = new Map<SessionId, ReturnType<typeof followTerminalJobRows>>()
  const liveTexts = new Map<SessionId, LiveAttempt>()
  // 观察通道（跟随流）已终态失败的会话：失败后没有任何事件源能再产生 turn/end，
  // 用于在“输入已结束”的时刻判定结果未知；真的 :open 恢复出新流时清账。
  const observationLost = new Map<SessionId, unknown>()
  const finished = Promise.withResolvers<number>(), deferredOutput: string[] = [], decoder = new BracketedPasteDecoder(), tty = new InputStream()
  let pasteAt: { id?: SessionId; text: string; cursor: number } | undefined
  const write = (text: string) => { if (!closing) { const safe = terminalText(text); if (editing) deferredOutput.push(safe); else if (screen) screen.write(safe); else process.stdout.write(safe) } }
  const line = (text: string) => {
    if (screen) { screen.line(terminalText(text)); return }
    write('\n' + text + '\n'); if (!editing && !ended && !closing) input?.prompt(true)
  }
  const error = (reason: unknown) => line('[错误] ' + (reason instanceof Error ? reason.message : String(reason)))
  const id = () => { if (!selected) throw new Error('请先选择会话。'); return selected }
  const quit = (code = 0) => { if (!closing) { closing = true; lifetime.abort(); finished.resolve(code) } }
  const stop = async () => {
    for (const controller of pending) controller.abort(new Error('用户取消输入'))
    editorAbort?.abort(new Error('EDITOR_CANCELLED'))
    if (selected) line('[取消已受理 ' + selected + '] ' + JSON.stringify(value(await remote.session.cancel({ sessionId: selected }))))
  }
  // 用快照基线（跟随流 opt-in 后宿主每次开流都会下发）补写本 attempt 尚未写出的增量：
  // 成员下标与稠密 chunk 下标一一对应，nextIndex 就是宿主已发布的位置，所以只写 [已消费, nextIndex)。
  const adoptAssistantBaseline = (sessionId: SessionId, baseline: SessionAssistantStreamBaseline | undefined) => {
    const opening = baseline?.activeAttempt
    if (opening === undefined) { liveTexts.delete(sessionId); return }
    const previous = liveTexts.get(sessionId)
    const attempt = previous !== undefined && previous.attemptId === String(opening.attemptId)
      ? previous
      : { attemptId: String(opening.attemptId), next: 0, text: '' }
    for (const [index, member] of expandAssistantStream(opening.stream as unknown as readonly AssistantStreamRecord[]).entries()) {
      if (index < attempt.next) continue
      if (index >= opening.nextIndex) break
      if (member.chunk.type === 'text-delta') { attempt.text += member.chunk.text; write(member.chunk.text) }
    }
    attempt.next = Math.max(attempt.next, opening.nextIndex)
    liveTexts.set(sessionId, attempt)
  }
  const render = (event: SessionEvent, sessionId: SessionId) => {
    if (event.type === 'turn/start') {
      activeTurns.set(sessionId, event.data.turn)
      if (pipeline && sessionId === pipelineSession && pipelineAdmitted && pipelineTurn === undefined) pipelineTurn = event.data.turn
    }
    if (pipeline && sessionId === pipelineSession && pipelineRequest) {
      if (event.type === 'agent/inbox/spliced' && event.data.inserted?.some(message => message.source.kind === 'user' && 'rpcId' in message.source && message.source.rpcId === pipelineRequest)) pipelineAdmitted = true
      if (event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === pipelineRequest) pipelineTurn = activeTurns.get(sessionId)
    }
    // 只有“已写出的正文恰好等于这一步结算的正文”才收行；否则按完整正文补齐，行式终端不缺段。
    const settled = event.type === 'assistant/message' ? liveTexts.get(sessionId) : undefined
    if (event.type === 'assistant/message') liveTexts.delete(sessionId)
    const complete = event.type === 'assistant/message' && settled !== undefined && settled.text.length > 0
      && Array.isArray(event.data.stream) && settled.text === joinAssistantStreamText(event.data.stream)
    if (complete) line('[模型已保存 ' + sessionId + ' seq=' + event.seq + ']')
    else { const text = eventText(event); if (text) line('[' + sessionId + ' seq=' + event.seq + '] ' + text) }
    if (event.type === 'turn/end' && pipeline && sessionId === pipelineSession && event.data.turn === pipelineTurn) { pipelineResult ??= event.data.reason.kind === 'completed' ? 0 : 1; if (ended) quit(pipelineResult) }
  }
  // “观察通道已终态失败”与“输入已结束”只要同时成立，就没有任何流能再产生 turn/end：不能假装回合结束，
  // 也不能去终止远端Host，只能带非零码退出并说明结果未知；两种先后顺序都在这里收敛。
  const quitUnknown = (): boolean => {
    if (!pipeline || !ended || pipelineResult !== undefined || pipelineSession === undefined || !observationLost.has(pipelineSession)) return false
    line('[结果未知] 跟随流已终态失败，无法确认 ' + pipelineSession + ' 的回合结果；仅断开本客户端，不终止远端Host。可用 :history 查看远端已保存的正文。')
    quit(3)
    return true
  }
  const history = async (sessionId: SessionId, before?: number, all = false, signal = lifetime.signal) => {
    const view = views.get(sessionId); if (!view) throw new Error('会话历史尚未就绪。')
    let cursor: number | undefined
    const pages: SessionEvent[][] = []
    let more = false, selectedPage: ReturnType<typeof historyPage>
    do {
      const page = value(await remote.session.page({ address: { kind: 'session', sessionId }, throughSeq: view.cursor, ...(cursor === undefined ? {} : { beforeSeq: cursor }), maxMessages: 100 }, signal))
      const events = page.records.map(row => row.event as unknown as SessionEvent)
      pages.unshift(events); more = page.hasMore; cursor = events[0]?.seq
      if (more && cursor === undefined) throw new Error('远端历史缺少下一页游标。')
      // 从当前窗口向前读，保留checkout所需上下文；不能把一页旧raw记录单独当活动分支。
      selectedPage = historyPage(pages.flat(), { beforeSeq: before, all, limit: 100 })
    } while (more && (all || selectedPage.entries.length < 100))
    line('[历史 ' + sessionId + ']')
    for (const entry of selectedPage.entries) line('[seq=' + entry.seq + '] ' + entry.text)
    line('[历史结束 ' + sessionId + ']')
    if (more || selectedPage.hasMore) line('[更早历史] :history ' + (selectedPage.entries[0]?.seq ?? cursor) + '；:history all显示全部。')
  }
  const selectSession = async (sessionId: SessionId, signal = lifetime.signal) => {
    signal.throwIfAborted(); linked.scope(sessionId); owned.add(sessionId)
    if (!streams.has(sessionId)) {
      const ready = Promise.withResolvers<void>()
      const stream = remote.$stream<SessionFollowFrame>({ name: '终端会话', open: signal => remote.session.follow({ address: { kind: 'session', sessionId }, maxMessages: 100, assistantStream: true }, signal), ended: () => new RemoteStreamCarrierError('会话连接结束，等待原生重连'), carrierFailed: () => line('[连接暂断] 等待原生连接恢复。') })
      streams.set(sessionId, stream)
      // 真的恢复出了新流（:open 重新挂载）：旧的终态失败状态不再成立，不能据此误报“结果未知”。
      observationLost.delete(sessionId)
      tasks.push((async () => {
        for await (const item of stream) {
          const frame = item.value
          if (frame.type === 'snapshot') {
            const previous = views.get(sessionId)
            views.set(sessionId, { header: frame.header, cursor: frame.cursor, before: frame.records[0]?.event.seq, hasMore: frame.hasMore, projections: { ...frame.projections.values } })
            item.accept(); ready.resolve()
            if (previous) { line('[连接恢复 ' + sessionId + '] 已重新同步原生历史。'); for (const row of frame.records) if (row.event.seq > previous.cursor) render(row.event as unknown as SessionEvent, sessionId); if (frame.hasMore) line(':history all可查看完整历史。') }
            adoptAssistantBaseline(sessionId, frame.assistantStream)
          } else if (frame.type === 'event') {
            const view = views.get(sessionId)
            if (view && frame.event.seq > view.cursor) {
              view.cursor = frame.event.seq; render(frame.event as unknown as SessionEvent, sessionId)
              if (frame.event.type === 'session/history-checkout') stream.restart()
            }
          } else if (frame.frame.type === 'start') liveTexts.set(sessionId, { attemptId: String(frame.frame.attemptId), next: 0, text: '' })
          else if (frame.frame.type === 'chunk') {
            const attemptId = String(frame.frame.attemptId), previous = liveTexts.get(sessionId)
            const attempt = previous !== undefined && previous.attemptId === attemptId ? previous : { attemptId, next: 0, text: '' }
            attempt.next = frame.frame.index + 1
            const chunk = frame.frame.chunk
            if (chunk && typeof chunk === 'object' && !Array.isArray(chunk) && chunk.type === 'text-delta' && typeof chunk.text === 'string') { attempt.text += chunk.text; write(chunk.text) }
            liveTexts.set(sessionId, attempt)
          }
        }
      })().catch(reason => {
        if (streams.get(sessionId) === stream) streams.delete(sessionId)
        ready.reject(reason)
        if (closing) return
        error(reason)
        // 明确的跟随流终态失败：该会话不会再有事件到达。先记账，再在“输入已结束”的时刻统一判定：
        // 失败先到或 EOF 先到都能收场，且不假装回合结束、不去终止远端Host（TTY仍按原生重连语义等待）。
        observationLost.set(sessionId, reason)
        quitUnknown()
      }))
      await Promise.race([ready.promise, new Promise<never>((_, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })])
    }
    signal.throwIfAborted(); if (!views.has(sessionId)) throw new Error('远端会话没有可用快照。'); selected = sessionId; input?.setPrompt('lyapunov-remote:' + sessionId + '> ')
    if (!jobStreams.has(sessionId)) {
      const jobs = followTerminalJobRows(remote, sessionId, rows => { if (rows === undefined) jobsBySession.delete(sessionId); else jobsBySession.set(sessionId, rows) })
      jobStreams.set(sessionId, jobs)
      tasks.push(jobs.task.catch(reason => { if (jobStreams.get(sessionId) === jobs) { jobStreams.delete(sessionId); jobsBySession.delete(sessionId) }; if (!closing) error(reason) }))
    }
    line('[会话] ' + sessionId + ' [远端] ' + linked.origin)
  }
  // 全屏只读远端原生状态：导航来自 Workspace baseline，Jobs 计数来自每会话 job.list 全量流。
  const fullscreenRuntime: FullscreenRuntime = {
    navigation: async signal => {
      const frame = await firstFrame(remote.workspace.follow(signal))
      if (frame.type !== 'baseline') throw new Error('远端 Workspace 状态流缺少 baseline。')
      const listed = value(await remote.session.list({}, signal)).items
      for (const row of listed) running.set(row.sessionId, row.running)
      const archived = new Set(frame.value.archivedSessionIds.map(String))
      return frame.value.items.map<NavigationWorkspace>(item => ({
        id: String(item.workspaceId), title: item.title,
        sessions: item.sessionIds.map(sessionId => {
          // 远端只有会话行事实：标题用原生会话自己的 cwd 末段，没有 cwd 就不编标题。
          const row = listed.find(candidate => candidate.sessionId === sessionId)
          const title = row?.cwd === undefined ? undefined : basename(row.cwd)
          return {
            id: String(sessionId), ...(title === undefined ? {} : { title }),
            archived: archived.has(String(sessionId)), current: sessionId === selected,
          }
        }),
      }))
    },
    status: (): Omit<FullscreenStatus, 'focus' | 'scrollBack' | 'note'> => {
      const draft = selected === undefined ? undefined : drafts.get(selected)
      const view = selected === undefined ? undefined : views.get(selected)
      const selection = view?.projections.modelSelection as { next?: { provider?: string; model?: string } } | undefined
      const jobs = selected === undefined ? undefined : jobsBySession.get(selected)
      const state = selected === undefined ? undefined : running.get(selected)
      return {
        ...(selected === undefined ? {} : { sessionId: String(selected) }),
        ...(state === undefined ? {} : { agentStatus: state ? 'running' : 'idle' }),
        model: selection?.next?.provider && selection.next.model ? selection.next.provider + '/' + selection.next.model : '远端默认',
        draftLines: draft?.text ? draft.text.split('\n').length : 0,
        attachments: draft?.attachments.length ?? 0,
        pendingApprovals: [...approvals.keys()],
        pendingQuestions: [...questions.keys()],
        ...(jobs === undefined ? {} : { jobs: jobs.length }),
      }
    },
    editor: () => ({
      draft: selected === undefined ? '' : drafts.get(selected).text,
      line: input?.line ?? '', cursor: input?.cursor ?? 0,
    }),
    openSession: async id => { const target = SessionId(id); await selectSession(target); await history(target, undefined, false) },
    note: text => line(text),
  }
  const control = remote.$stream<SessionControlFrame>({ name: '终端原生控制', open: signal => remote.session.control(signal), ended: () => new RemoteStreamCarrierError('控制连接结束') })
  tasks.push((async () => { for await (const item of control) {
    const frame = item.value
    if (frame.type === 'baseline') { item.accept(); for (const [sessionId, projection] of Object.entries(frame.value.projections)) { const view = views.get(SessionId(sessionId)); if (view) view.projections = { ...projection.values } } }
    else if (frame.type === 'projection') { const view = views.get(frame.sessionId); if (view) view.projections[frame.key] = frame.value }
  } })().catch(reason => { if (!closing) error(reason) }))
  const removeApproval = remote.$on('approval/request', (request, next) => {
    const sessionId = request.agent ? linked.sessionIdOf(request.agent) : undefined
    if (!sessionId || !owned.has(sessionId)) return next()
    if (!process.stdin.isTTY) {
      // 同一Session可有多个客户端；无TTY的排队调用不能取消其他客户端当前回合的审批。
      if (!pipeline || sessionId !== pipelineSession || pipelineTurn === undefined || activeTurns.get(sessionId) !== pipelineTurn) return next()
      line('[INPUT_REQUIRES_TTY] 当前提交需要交互终端审批。'); pipelineResult = 2
      void remote.session.cancel({ sessionId }); return Promise.resolve('cancelled' as const)
    }
    const key = 'a' + ++serial
    return new Promise<'allowed-once' | 'rejected' | 'cancelled'>(done => {
      const finish = (answer: 'allowed-once' | 'rejected' | 'cancelled') => { approvals.delete(key); request.signal?.removeEventListener('abort', abort); done(answer) }
      const abort = () => finish('cancelled'); approvals.set(key, finish); request.signal?.addEventListener('abort', abort, { once: true })
      if (request.signal?.aborted) { abort(); return }
      line('[审批 ' + key + ' 会话=' + sessionId + '] ' + request.toolName + '\n' + (request.reason ?? '') + '\n:allow ' + key + ' 或 :deny ' + key)
    })
  })
  const removeQuestion = remote.$on('user-questions/request', (request, next) => {
    const sessionId = request.agent ? linked.sessionIdOf(request.agent) : undefined
    if (!sessionId || !owned.has(sessionId)) return next()
    if (!process.stdin.isTTY) {
      if (!pipeline || sessionId !== pipelineSession || pipelineTurn === undefined || activeTurns.get(sessionId) !== pipelineTurn) return next()
      line('[INPUT_REQUIRES_TTY] 当前提交需要交互终端回答问题。'); pipelineResult = 2
      void remote.session.cancel({ sessionId }); throw new Error('INPUT_REQUIRES_TTY')
    }
    const key = 'q' + ++serial
    return new Promise<any>((done, fail) => {
      const cleanup = () => { questions.delete(key); request.signal?.removeEventListener('abort', abort) }
      const abort = () => { cleanup(); fail(new Error('问答已取消')) }
      questions.set(key, { answer: answer => { cleanup(); done(answer) }, cancel: abort }); request.signal?.addEventListener('abort', abort, { once: true })
      if (request.signal?.aborted) { abort(); return }
      line('[问答 ' + key + '] ' + JSON.stringify(request.questions) + '\n:answer ' + key + ' <原生answers JSON>')
    })
  })
  const submit = async (sessionId: SessionId, signal: AbortSignal) => {
    const draft = drafts.get(sessionId); if (!draft.text.trim() && !draft.attachments.length) return
    const requestId = drafts.requestId(sessionId)
    if (pipeline) { pipelineRequest = requestId; pipelineSession = sessionId }
    const prepared = await drafts.prepare(linked, sessionId, signal)
    signal.throwIfAborted()
    value(await remote.session.prompt({ sessionId, requestId, mode: 'queue', content: prepared.content }, signal))
    prepared.commit(); line('[输入已交给远端原生会话 ' + sessionId + ']')
  }
  const chooseModel = async (sessionId: SessionId, startup: TerminalStartupConfig, fresh: boolean, signal = lifetime.signal) => {
    signal.throwIfAborted()
    if (!fresh && !startup.provider && !startup.model && !startup.reasoningEffort) return
    const catalog = value(await remote.session.modelCatalog()), existing = views.get(sessionId)?.projections.modelSelection as { next?: { provider: string; model: string } } | undefined
    const route = startup.provider && startup.model ? { provider: startup.provider, model: startup.model } : existing?.next ?? catalog.default
    if(!route)throw new Error("MODEL_NOT_CONFIGURED: 当前工作台未配置模型，终端手动命令仍可用")
    signal.throwIfAborted()
    value(await remote.session.selectModel({ sessionId, ...route, reasoningEffort: startup.reasoningEffort ?? highestReasoningEffort(catalog, route.provider, route.model) }))
  }
  const execute = async (raw: string, signal: AbortSignal) => {
    signal.throwIfAborted(); const text = raw.trim()
    const workspaces = /^:(workspaces?)(?:\s+([\s\S]*))?$/.exec(text)
    // 没有已选会话时也允许查询 Workspace（命令在 id() 之前）；但已选会话的多行草稿优先于新命令，
    // 此时 `:workspace` 与其它普通行一样积入草稿，需先 :send/:discard（例外表与下面完全一致）。
    if (workspaces && !(selected !== undefined && drafts.get(selected).multiline)) {
      // 原生命令解析与本地终端共用同一个 handleWorkspaceAction；这里只提供远端最小结构接口。
      const verb = workspaces[1] === 'workspaces' ? 'workspaces' : 'workspace'
      line((await handleWorkspaceAction(verb, { order: workspaceOrder, sessionId: selected, argument: workspaces[2] ?? '', signal })).join('\n'))
      return
    }
    const sessionId = id(), draft = drafts.get(sessionId)
    if (draft.multiline && !/^:(send|draft|discard|cancel-input|attach|attachments|detach|editor|paste)(\s|$)/.test(text)) { drafts.append(sessionId, raw); return }
    if (text === ':help' || text === ':actions') { line(':new [远端目录] :sessions :open <ID> :fork [seq] :history [seq|all]\n:begin :send :draft :discard :cancel-input :attach <本地路径> :detach <ID或序号> :attachments\n:editor :paste [text|image] :commands :models :model <provider> <model> [effort]\n:status :rename <标题> :archive :queue :jobs :goal :todos :export <本地ZIP>\n:workspaces :workspace <#序号|ID|前缀|标题> [top|end|up|down|before <锚点>]（原生顺序）\n:stop :allow/:deny <ID> :answer <ID> <JSON> :quit（只断开客户端）'); return }
    if (text === ':sessions') { line(JSON.stringify(value(await remote.session.list({}, signal)), null, 2)); return }
    if (text === ':new' || text.startsWith(':new ')) {
      // 与本地同一份归属规则，只是 owner 换成远端：给了目录就按它定位/复用 Workspace，再让原生 create 走
      // workspaceId 分支（该分支自带 attachSession）；没给目录就用服务端默认目录建，再按同一规则归属。
      const directory = text.slice(4).trim()
      const created = directory === ''
        ? value(await remote.session.create({}))
        : value(await remote.session.create({ workspaceId: (await ensureWorkspace(directory)).workspaceId }))
      await selectSession(created.sessionId, signal)
      if (directory === '') await adoptWorkspace(created.sessionId, signal)
      await chooseModel(created.sessionId, {}, true, signal); return
    }
    if (text.startsWith(':open ')) { await selectSession(SessionId(text.slice(6).trim()), signal); await history(id(), undefined, false, signal); return }
    if (text === ':fork' || text.startsWith(':fork ')) { const anchor = text.slice(5).trim(); if (anchor && !/^\d+$/.test(anchor)) throw new Error(':fork [非负seq]'); const created = value(await remote.session.fork({ sessionId, ...(anchor ? { atSeq: Number(anchor) } : {}) })); await selectSession(created.sessionId, signal); await history(id(), undefined, false, signal); return }
    if (text === ':history' || text.startsWith(':history ')) { const anchor = text.slice(8).trim(); if (anchor && anchor !== 'all' && !/^\d+$/.test(anchor)) throw new Error(':history [seq|all]'); await history(sessionId, anchor && anchor !== 'all' ? Number(anchor) : undefined, anchor === 'all', signal); return }
    if (/^[:/](undo|redo|undo_status)$/.test(text)) {
      const execution = value(await remote.commands.execute(sessionId, '/' + text.slice(1), [], signal))
      if (!execution) throw new Error('原生撤销命令未注册。')
      line(execution.result.text ?? execution.result.kind)
      if (execution.result.kind !== 'success' || !execution.result.text) return
      const result = JSON.parse(execution.result.text) as import('../../lyapunov-session-undo/src/types.ts').HistoryOperationResult
      if (result.schema !== 'lyapunov-history-v1' || !result.changed) return
      if (result.restoreUserSeq === null) drafts.clear(sessionId)
      else if (result.restoreUserSeq !== undefined) {
        const response = await linked.fetch('/api/lyapunov/history-draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, userSeq: result.restoreUserSeq }), signal })
        if (!response.ok) throw new Error('撤销已完成，但原草稿读取失败 HTTP ' + response.status)
        const restored = await response.json() as { content: Array<{ type: 'text'; text: string } | { type: 'image' | 'file'; data: string; name: string; mediaType?: import('@deepseek-ai/dsh-attachment/types').ImageMediaType }> }
        drafts.clear(sessionId)
        drafts.setText(sessionId, restored.content.filter(part => part.type === 'text').map(part => part.text).join(''))
        for (const part of restored.content) if (part.type !== 'text') drafts.get(sessionId).attachments.push({ id: globalThis.crypto.randomUUID(), name: part.name, data: Buffer.from(part.data, 'base64'), mediaType: part.mediaType })
      }
      await history(sessionId, undefined, false, signal)
      line(result.restoreUserSeq === null ? '[撤销草稿] 重做已完成，草稿已清空。' : '[撤销草稿] 已恢复，:send确认。'); return
    }
    if (text === ':begin') { drafts.begin(sessionId); line('[多行输入] :send确认'); return }
    if (text === ':cancel-input') { drafts.cancelMultiline(sessionId); line('[多行输入已取消]'); return }
    if (text === ':discard') { drafts.clear(sessionId); line('[草稿已清除]'); return }
    if (text === ':draft') { line('[草稿 ' + sessionId + ']\n' + draft.text + '\n' + draft.attachments.length + ' 个附件'); return }
    if (text === ':attachments') { line(JSON.stringify(draft.attachments.map((item, index) => ({ index: index + 1, id: item.id, name: item.name, kind: item.mediaType ? 'image' : 'file', bytes: item.data.byteLength })), null, 2)); return }
    if (text.startsWith(':attach ')) { const attached = await drafts.addFile(sessionId, unquote(text.slice(8).trim()), signal); line('[附件已加入] ' + attached.name); return }
    if (text.startsWith(':detach ')) { const key = text.slice(8).trim(), item = /^\d+$/.test(key) ? draft.attachments[Number(key) - 1] : draft.attachments.find(item => item.id === key); if (!item) throw new Error('附件不存在。'); draft.attachments = draft.attachments.filter(row => row !== item); line('[附件已移除]'); return }
    if (text === ':paste' || text.startsWith(':paste ')) { const kind = text.slice(6).trim() || 'auto'; if (!['auto', 'text', 'image'].includes(kind)) throw new Error(':paste [text|image]'); const clip = await readTerminalClipboard({ kind: kind as 'auto' | 'text' | 'image', signal, tools: { xclip: process.env.LYAPUNOV_CLIPBOARD_XCLIP, xsel: process.env.LYAPUNOV_CLIPBOARD_XSEL, 'wl-paste': process.env.LYAPUNOV_CLIPBOARD_WL_PASTE } }); if (clip.kind === 'text') drafts.setText(sessionId, draft.text + clip.text); else drafts.addImage(sessionId, clip); line('[剪贴板已加入草稿] :send确认'); return }
    if (text === ':editor' || text === '/editor') {
      editorAbort = new AbortController()
      try {
        const updated = await openTerminalEditor({ text: draft.text, cwd: process.cwd(), signal: AbortSignal.any([signal, editorAbort.signal]), suspend: () => {
          const raw = Boolean(process.stdin.isRaw); editing = true; input?.pause(); process.stdin.off('data', onData); process.stdin.pause(); tty.setRawMode(false); process.stdout.write(BRACKETED_PASTE_DISABLE)
          // 外部编辑器独占终端：全屏退出备用屏幕暂停绘制，返回后再整帧重画。
          screen?.pause()
          return () => { editing = false; if (!closing) { tty.setRawMode(raw); process.stdin.on('data', onData); input?.resume(); process.stdin.resume(); process.stdout.write(BRACKETED_PASTE_ENABLE); screen?.resume(); for (const text of deferredOutput) { if (screen) screen.write(text); else process.stdout.write(text) } }; deferredOutput.length = 0 }
        } }); drafts.setText(sessionId, updated); line('[编辑器已返回] :send确认')
      } finally { editorAbort = undefined }
      return
    }
    if (text === ':commands') { line(value(await remote.commands.list(sessionId)).map(row => '/' + row.name + ' ' + row.description).join('\n')); return }
    if (text === ':models') { line(JSON.stringify(value(await remote.session.modelCatalog()), null, 2)); return }
    if (text.startsWith(':model ')) { const [, provider, model, reasoningEffort] = text.split(/\s+/); if (!provider || !model) throw new Error(':model <provider> <model> [effort]'); await chooseModel(sessionId, { provider, model, reasoningEffort }, false, signal); line('[模型选择已更新]'); return }
    if (text === ':status') { const row = value(await remote.session.list({}, signal)).items.find(row => row.sessionId === sessionId); line(JSON.stringify({ sessionId, status: row?.running ? 'running' : 'idle', seq: views.get(sessionId)?.cursor, modelSelection: views.get(sessionId)?.projections.modelSelection, remote: linked.origin })); return }
    if (text.startsWith(':rename ')) { line(JSON.stringify(value(await remote.session.rename({ sessionId, title: text.slice(8) })))); return }
    if (text === ':archive') { line(JSON.stringify(value(await remote.workspace.archiveSession({ sessionId })))); return }
    if (text === ':goal') { line(JSON.stringify(value(await remote.goals.get(sessionId))) ?? '当前没有Goal。'); return }
    if (text === ':todos' || text === ':todo') { line(JSON.stringify(views.get(sessionId)?.projections.todos) ?? '当前没有Todo。'); return }
    if (text === ':queue') {
      const frame = await firstFrame(remote.session.control(signal))
      if (frame.type !== 'baseline') throw new Error('控制流没有 baseline。')
      const inbox = frame.value.projections[sessionId]?.values.inbox
      line(inbox === undefined ? '当前会话的原生 Inbox 投影尚未就绪。' : JSON.stringify(inbox, null, 2)); return
    }
    if (text === ':jobs') { line(JSON.stringify(await firstTerminalJobRows(remote, sessionId, signal), null, 2)); return }
    if (text === ':export' || text.startsWith(':export ')) { const path = resolve(unquote(text.slice(7).trim()) || sessionId + '.zip'); const response = await linked.fetch('/api/session.export?' + new URLSearchParams({ sessionId, includeDescendants: 'true' }), { signal }); if (!response.ok || !response.body) throw new Error('远端导出失败 HTTP ' + response.status); const file = await open(path, 'wx', 0o600); let complete = false; try { await response.body.pipeTo(new WritableStream({ async write(chunk) { await file.writeFile(chunk) } }), { signal }); complete = true } finally { await file.close(); if (!complete) await unlink(path) }; line('[ZIP 已导出] ' + path); return }
    if (text.startsWith('/') || /^:(compact|undo|redo)(\s|$)/.test(text)) { const prepared = await drafts.prepare(linked, sessionId, signal, ''); const result = value(await remote.commands.execute(sessionId, text.startsWith(':') ? '/' + text.slice(1) : raw, prepared.content.filter(part => part.type !== 'text'), signal)); if (!result) throw new Error('原生命令不存在，未发送模型。'); if (result.result.kind === 'success') prepared.commit(); return }
    if (text.startsWith(':') && text !== ':send') throw new Error('未知终端操作，输入 :help。')
    if (text && text !== ':send') drafts.setText(sessionId, draft.text + raw)
    await submit(sessionId, signal)
  }
  const onLine = (raw: string) => {
    if (raw.trim() === ':quit') { quit(); return }
    if (raw.trim() === ':stop') { void stop().catch(error); return }
    const decision = /^:(allow|deny)\s+(\S+)$/.exec(raw.trim())
    if (decision) { const settle = approvals.get(decision[2]!); if (settle) settle(decision[1] === 'allow' ? 'allowed-once' : 'rejected'); else error('审批ID不存在'); return }
    const answer = /^:answer\s+(\S+)\s+([\s\S]+)$/.exec(raw.trim())
    if (answer) { try { const pending = questions.get(answer[1]!); if (!pending) throw new Error('问答ID不存在'); pending.answer(JSON.parse(answer[2]!)) } catch (reason) { error(reason) }; return }
    const controller = new AbortController(); pending.add(controller); const signal = AbortSignal.any([controller.signal, lifetime.signal])
    chain = chain.then(() => execute(raw, signal)).catch(reason => { if (!signal.aborted) error(reason); else if (!closing) line('[输入已取消]') }).finally(() => pending.delete(controller))
  }
  const onData = (chunk: Buffer | string) => {
    // 先由原生 decoder 判定 literal（粘贴标记跨 chunk 由它保留），全屏只截走 typed 片段里的按键：
    // 粘贴正文里的 Tab/CR 不进按键路由，不会切焦点或触发会话动作。
    for (const part of decodeTerminalInput(decoder, screen, chunk)) {
      if (part.type === 'typed') tty.write(part.text)
      else if (part.type === 'paste-start') { pasteAt = { id: selected, text: input?.line ?? '', cursor: input?.cursor ?? 0 }; input?.write(null, { name: 'e', ctrl: true }); input?.write(null, { name: 'u', ctrl: true }) }
      else { const target = pasteAt; pasteAt = undefined; chain = chain.then(() => { const targetId = target?.id ?? id(); const typed = target?.text ?? '', cursor = target?.cursor ?? typed.length; drafts.append(targetId, typed.slice(0, cursor) + part.text + typed.slice(cursor)); line('[粘贴草稿] 回车或:send发送。') }).catch(error) }
    }
    // 光标移动、补全候选等只改 readline 内部状态；这里统一触发一次重绘。
    screen?.invalidate()
  }
  const onEnd = () => tty.end()
  const interrupt = () => { if (editing) editorAbort?.abort(new Error('EDITOR_CANCELLED')); else void stop().catch(error) }
  const terminate = () => quit(0)
  try {
    // 与本地入口同一判定与文案：非 TTY 不进入备用屏幕，保持已经验证过的行式终端。
    if (options.fullscreen) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) line('[全屏不可用] --fullscreen 需要 stdin 与 stdout 都是真实终端；本次保持行式终端。')
      else screen = new FullscreenTerminal(fullscreenRuntime, { stdout: process.stdout })
    }
    input = createInterface({ input: tty, output: screen?.readlineSink ?? process.stdout, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY), completer: (text, done) => {
      const selectedAt = selected, before = input?.line
      void (async (): Promise<[string[], string]> => {
        if (!selectedAt) return [[], text]
        if (/^\/[a-z0-9_-]*$/.test(text)) return [value(await remote.commands.list(selectedAt)).map(row => '/' + row.name).filter(name => name.startsWith(text)), text]
        const token = activeAtToken(text, text.length); if (!token) return [[], text]
        return [value(await remote.fileReferences.list(selectedAt, token.query, lifetime.signal)).flatMap(row => { const value = formatFileMention(row, token.quoted); return value ? [value] : [] }), token.prefix]
      })().then(result => done(null, selected === selectedAt && input?.line === before ? result : [[], text]), reason => { error(reason); done(null, [[], text]) })
    } })
    input.on('line', onLine); input.on('SIGINT', interrupt); input.on('close', () => { ended = true; if (quitUnknown()) return; if (started && (!pipeline || pipelineResult !== undefined)) quit(pipelineResult ?? 0) })
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate); process.stdin.on('data', onData); process.stdin.on('end', onEnd)
    if (process.stdin.readableEnded) onEnd()
    if (process.stdin.isTTY && process.stdout.isTTY) process.stdout.write(BRACKETED_PASTE_ENABLE)
    screen?.start(lifetime.signal)
    const startup = options.startup ?? {}
    const startupAbort = new AbortController(), startupSignal = AbortSignal.any([startupAbort.signal, lifetime.signal]); pending.add(startupAbort)
    chain = (async () => {
      let selectedId = startup.sessionId ? SessionId(startup.sessionId) : undefined, fresh = false
      if (!selectedId && startup.continueLast) {
        const iterator = remote.workspace.follow(startupSignal)[Symbol.asyncIterator](); let archived: readonly SessionId[] = []
        try { const first = (await iterator.next()).value; if (first?.type === 'baseline') archived = first.value.archivedSessionIds } finally { await iterator.return?.() }
        // 指定了目录就按远端原生 Workspace 的记账筛会话：不用本地路径去猜远端路径。
        const accounted = startup.cwd === undefined ? undefined : new Set((await ensureWorkspace(startup.cwd)).sessionIds.map(String))
        const rows = value(await remote.session.list({}, startupSignal)).items.filter(row => row.origin !== 'subagent' && !archived.includes(row.sessionId) && (accounted === undefined || accounted.has(String(row.sessionId))))
        selectedId = [...rows].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.sessionId
        if (!selectedId) throw new Error('远端项目没有可继续的会话。')
      }
      startupSignal.throwIfAborted()
      if (startup.fork) { if (!selectedId) throw new Error('--fork需要源会话'); selectedId = value(await remote.session.fork({ sessionId: selectedId })).sessionId }
      if (!selectedId) {
        // 与本地同一份归属规则，owner 换成远端：给了目录就按它定位/复用 Workspace，再让原生 create 的
        // workspaceId 分支带 cwd 并 attachSession；没给目录就先按服务端默认目录建，稍后按服务端事实归属。
        const workspaceId = startup.cwd === undefined ? undefined : (await ensureWorkspace(startup.cwd)).workspaceId
        const created = value(await remote.session.create({ ...(workspaceId === undefined ? {} : { workspaceId }), ...(startup.agentPreset ? { agentPreset: startup.agentPreset } : {}) }))
        selectedId = created.sessionId; fresh = true
      }
      await selectSession(selectedId, startupSignal)
      // 未归属的会话按它自己的实际 cwd 走同一条远端 attach 通道；已归属的（含刚建的、含原生 fork 的）保持原样。
      const current = selectedId
      const before = await firstFrame(remote.workspace.follow(startupSignal))
      if (!(before.type === 'baseline' && before.value.items.some(item => item.sessionIds.includes(current)))) await adoptWorkspace(current, startupSignal)
      if (startup.agentPreset && !fresh) { startupSignal.throwIfAborted(); value(await remote.agentPresets.select(selectedId, startup.agentPreset)) }
      await chooseModel(selectedId, startup, fresh, startupSignal)
      if (!fresh) await history(selectedId, undefined, false, startupSignal)
      startupSignal.throwIfAborted()
      line('[就绪] 远端DSH原生终端；:help查看操作。退出仅断开客户端。')
      if (startup.prompt?.trim()) {
        drafts.setText(selectedId, startup.prompt)
        if ((startup.promptMode ?? (fresh ? 'send' : 'prefill')) === 'send') { pipeline = !process.stdin.isTTY; await submit(selectedId, startupSignal) }
        else if (!process.stdin.isTTY) throw new Error('INPUT_REQUIRES_TTY: 恢复默认预填；用--prompt-mode send显式发送。')
        else line('[启动草稿] :send确认。')
      }
      started = true; if (ended && !quitUnknown() && (!pipeline || pipelineResult !== undefined)) quit(pipelineResult ?? 0)
    })().catch(reason => { error(reason); if (!startupSignal.aborted || !selected || !process.stdin.isTTY) quit(1); else { started = true; line('[启动输入已取消] 当前会话仍可继续。') } }).finally(() => pending.delete(startupAbort))
    return await finished.promise
  } finally {
    closing = true; lifetime.abort(); for (const pending of approvals.values()) pending('cancelled'); for (const pending of questions.values()) pending.cancel()
    editorAbort?.abort(); input?.close(); screen?.dispose(); process.stdin.off('data', onData); process.stdin.off('end', onEnd); process.stdin.pause(); process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); tty.destroy()
    if (process.stdin.isTTY && process.stdout.isTTY) process.stdout.write(BRACKETED_PASTE_DISABLE)
    removeApproval(); removeQuestion(); await Promise.allSettled([control.dispose(), ...[...streams.values()].map(stream => stream.dispose()), ...[...jobStreams.values()].map(stream => stream.dispose())]); await chain; await Promise.allSettled(tasks); await linked.dispose()
  }
}
