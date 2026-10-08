import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionSeq, selectActiveHistoryEvents, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import type { CommandId } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { openWorktreeSnapshots, RestoreError, type RestoreTransaction, type WorktreeSnapshots, type SnapshotRef } from './worktree.ts'
import type { HistoryOperationMetadata, HistoryOperationResult, RedoPoint } from './types.ts'

type CheckpointEvent = SessionEvent<'worktree/checkpoint'>
interface StoreState { store?: WorktreeSnapshots; mode: 'git' | 'not-git' | 'disabled'; cwd: string }
const human = (event: SessionEvent): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.surfaceOp === 'append' && event.data.source.kind === 'user'
const enteredBranch = (event: SessionEvent): boolean =>
  event.type === 'step/start' ||
  (event.surfaceOp === 'append' && ['user/message', 'assistant/message', 'tool/result'].includes(event.type)) ||
  (event.type === 'agent/inbox/spliced' && event.data.inserted.length > 0)
/**
 * 原生 `Session.checkout` 只接受**稳定边界**：前缀里不能有未闭合的 turn／step／compaction
 * （`dsh-session` 的 `assertStableHistoryBoundary`，实测错误原文
 * `history checkout requires a stable boundary outside turn, step and compaction`）。
 *
 * 为什么需要它：撤销的目标原来直接取 `user.seq - 1`，但这只在"用户消息落在回合之外"时成立。
 * 用户在**回合进行中**发消息时（steer / inbox 拼接，`agent/inbox/spliced`），该消息是在本回合
 * 内部的一个 step 边界被接纳的，`user.seq - 1` 就落在 `step/start` 上——原生 checkout 当场拒绝，
 * 这次撤销永远做不成（真机复现：整段五步插件开发之后 `/undo` 报上面那句错误，文件一个字节没回退）。
 * 这里用与原生**同一台状态机**从目标位置往前退到最近的稳定边界；退到 `-1`（日志开头就是开放回合）
 * 也合法（原生允许 `-1`）。只读重放，不改任何事件。
 *
 * 参数按**结构**取 `type`/`seq`：`compaction/*` 与 `session/end-seed` 在原生运行时存在，但不在公开的
 * `SessionEventMap` 里；判据要跟原生逐字对齐，不能被公开类型的覆盖面缩小。
 * @param events - 完整原生日志（按 seq 升序，`agent.session.snapshotEvents()`）。
 * @param at - 期望的截断位置（含）。
 * @returns 不大于 `at` 的最大稳定 seq；一个都没有时 `-1`。
 */
export function stableHistoryBoundary(events: readonly { readonly type: string; readonly seq: number }[], at: number): number {
  let turn = false, step = false, compaction = false, boundary = -1
  for (const event of events) {
    if (event.seq > at) break
    if (event.type === 'turn/start') turn = true
    else if (event.type === 'turn/end') turn = false
    else if (event.type === 'step/start') step = true
    else if (event.type === 'step/end') step = false
    else if (event.type === 'compaction/start') compaction = true
    else if (event.type === 'compaction/end' || event.type === 'session/end-seed') compaction = false
    if (!turn && !step && !compaction) boundary = event.seq
  }
  return boundary
}

/** 操作仅持有短期互斥和Git对象库句柄；Session自身的原生日志是唯一历史事实。 */
export class SessionUndoController {
  private readonly stores = new Map<string, Promise<StoreState>>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private readonly blocked = new Set<string>()
  private readonly blockedWorktrees = new Set<string>()
  constructor(private readonly ctx: Context, private readonly config: { dataRoot: string; snapshots?: boolean; excludedRoots?: readonly string[] }) {}

  private async persisted(operationId: string, sessionId: string): Promise<boolean> {
    try {
      await using handle = await this.ctx.sessionPersistence.open(SessionId(sessionId), 'read')
      return (await handle.read()).events.some(event => event.type === 'session/history-checkout' && event.data.operationId === operationId)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'SESSION_NOT_FOUND') return false
      throw error
    }
  }
  private async storage(agent: Agent): Promise<StoreState> {
    const cwd = await realpath(agent.session.header.cwd ?? process.cwd())
    let pending = this.stores.get(cwd)
    if (!pending) {
      pending = (async () => {
        if (this.config.snapshots === false) return { cwd, mode: 'disabled' as const }
        const key = createHash('sha256').update(cwd).digest('hex')
        const opened = await openWorktreeSnapshots({ cwd, storageRoot: join(this.config.dataRoot, key), excludedRoots: this.config.excludedRoots })
        if (!opened.supported) return { cwd, mode: 'not-git' as const }
        await opened.store.recover((operationId, sessionId) => this.persisted(operationId, sessionId))
        return { cwd, mode: 'git' as const, store: opened.store }
      })()
      this.stores.set(cwd, pending)
      pending.catch(() => { if (this.stores.get(cwd) === pending) this.stores.delete(cwd) })
    }
    return pending
  }
  private assertHealthy(agent: Agent, state?: StoreState): void {
    if (this.blocked.has(agent.id) || (state?.store && this.blockedWorktrees.has(state.store.worktree))) throw new Error('HISTORY_RECOVERY_REQUIRED: 文件/会话提交尚未确认，请关闭并重开该Host完成恢复。')
  }
  private requireRecovery(agent: Agent, state: StoreState): void { this.blocked.add(agent.id); if (state.store) this.blockedWorktrees.add(state.store.worktree) }
  private canUndo(agent: Agent, state: StoreState): boolean {
    const active = this.active(agent), user = active.filter(human).at(-1)
    return Boolean(user && (!state.store || active.some(event => event.type === 'worktree/checkpoint' && event.data.phase === 'before' && event.data.snapshot !== null && event.data.messageIds.includes(user.data.id))))
  }
  private active(agent: Agent): readonly SessionEvent[] { return selectActiveHistoryEvents(agent.session.snapshotEvents()) }
  private redo(agent: Agent): readonly RedoPoint[] {
    const operations = new Map<string, { event: SessionEvent<'worktree/history-operation'>; acceptedAfter: boolean }>()
    let redo: readonly RedoPoint[] = []
    for (const event of agent.session.snapshotEvents()) {
      if (event.type === 'worktree/history-operation') operations.set(event.data.operationId, { event, acceptedAfter: false })
      else if (enteredBranch(event)) { redo = []; for (const operation of operations.values()) operation.acceptedAfter = true }
      else if (event.type === 'session/history-checkout') {
        const operation = event.data.operationId ? operations.get(event.data.operationId) : undefined
        redo = operation && !operation.acceptedAfter ? operation.event.data.nextRedo : []
        operations.clear()
      }
    }
    return redo
  }
  private pendingBefore(agent: Agent): CheckpointEvent[] {
    const events = this.active(agent), finished = new Set(events.filter(event => event.type === 'worktree/checkpoint' && event.data.phase === 'after').map(event => (event as CheckpointEvent).data.beforeSeq))
    return events.filter((event): event is CheckpointEvent => event.type === 'worktree/checkpoint' && event.data.phase === 'before' && !finished.has(event.seq))
  }
  private async finishPending(agent: Agent, state: StoreState, signal?: AbortSignal): Promise<SnapshotRef | null> {
    const before = this.pendingBefore(agent)
    let snapshot: SnapshotRef | null = null
    if (state.store) {
      // 只有需要整树读取的基线快照才提示，避免每步的增量捕捉刷屏。
      let announced = false
      const result = await state.store.captureReported(async () => {
        announced = true
        agent.session.append('worktree/capture', { version: 1, phase: 'preparing', full: true }, { ignorable: true })
        await this.ctx.sessions.flush(agent.session)
      })
      snapshot = result.ref
      if (announced) {
        const report = result.report
        agent.session.append('worktree/capture', { version: 1, phase: 'ready', full: report.full, files: report.files, hashed: report.hashed, bytesRead: report.bytesRead, elapsedMs: Math.round(report.ms) }, { ignorable: true })
        await this.ctx.sessions.flush(agent.session)
      }
    }
    signal?.throwIfAborted()
    for (const checkpoint of before) {
      const paths = snapshot && checkpoint.data.snapshot && state.store ? await state.store.diff(checkpoint.data.snapshot, snapshot) : []
      signal?.throwIfAborted()
      agent.session.append('worktree/checkpoint', { ...checkpoint.data, phase: 'after', beforeSeq: checkpoint.seq, snapshot, paths }, { ignorable: true })
    }
    if (before.length) await this.ctx.sessions.flush(agent.session)
    return snapshot
  }

  /** 必须在原生awaited pre-step中等待此方法；随后模型与工具才可进入执行。 */
  async beforeStep(agent: Agent, turn: number, step: number, messages: readonly UserMessage[], signal: AbortSignal): Promise<void> {
    this.assertHealthy(agent); signal.throwIfAborted()
    const state = await this.storage(agent)
    this.assertHealthy(agent, state)
    const snapshot = await this.finishPending(agent, state, signal)
    signal.throwIfAborted()
    agent.session.append('worktree/checkpoint', { version: 1, phase: 'before', turn, step, snapshot, messageIds: messages.filter(message => message.source.kind === 'user').map(message => message.id) }, { ignorable: true })
    await this.ctx.sessions.flush(agent.session)
  }
  async turnStopping(agent: Agent, signal: AbortSignal): Promise<void> {
    this.assertHealthy(agent)
    const state = await this.storage(agent)
    this.assertHealthy(agent, state)
    await this.finishPending(agent, state, signal)
  }
  async status(agent: Agent): Promise<HistoryOperationResult> {
    const state = await this.storage(agent)
    const recoveryRequired = this.blocked.has(agent.id) || Boolean(state.store && this.blockedWorktrees.has(state.store.worktree))
    return { schema: 'lyapunov-history-v1', action: 'status', changed: false, sessionId: agent.id, canUndo: !recoveryRequired && this.canUndo(agent, state), canRedo: !recoveryRequired && this.redo(agent).length > 0, files: { mode: state.mode, paths: [] }, pendingInputs: agent.inbox.nextTurn.length + agent.inbox.nextStep.length, recoveryRequired }
  }
  async perform(agent: Agent, action: 'undo' | 'redo', signal: AbortSignal, commandId?: CommandId): Promise<HistoryOperationResult> {
    const previous = this.operations.get(agent.id) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(async () => {
      this.assertHealthy(agent); signal.throwIfAborted()
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      await agent.whenIdle(); signal.throwIfAborted()
      return agent.runMaintenance(async maintenance => {
        const operationSignal = AbortSignal.any([signal, maintenance])
        const state = await this.storage(agent)
        this.assertHealthy(agent, state)
        const current = await this.finishPending(agent, state, operationSignal)
        operationSignal.throwIfAborted()
        const active = this.active(agent), redo = [...this.redo(agent)], users = active.filter(human)
        let throughSeq: number, restoreUserSeq: number | null, target: SnapshotRef | null, paths: readonly string[]
        if (action === 'undo') {
          const user = users.at(-1)
          if (!user) return { ...await this.status(agent), action }
          const checkpoint = active.findLast((event): event is CheckpointEvent => event.type === 'worktree/checkpoint' && event.data.phase === 'before' && event.data.messageIds.includes(user.data.id))
          if (state.store && (!checkpoint || !checkpoint.data.snapshot)) throw new Error('UNDO_SNAPSHOT_UNAVAILABLE: 该历史输入没有可用的原文件快照，不能承诺完整文件撤销。')
          const raw = agent.session.snapshotEvents()
          // 边界取"用户消息之前最近的**稳定**边界"：消息可能是在回合内部被接纳的（见 stableHistoryBoundary）。
          throughSeq = stableHistoryBoundary(raw, user.seq - 1); restoreUserSeq = user.seq; target = checkpoint?.data.snapshot ?? null
          const changes = active.filter((event): event is CheckpointEvent => event.type === 'worktree/checkpoint' && event.data.phase === 'after' && checkpoint !== undefined && (event.data.beforeSeq ?? -1) >= checkpoint.seq)
          paths = [...new Set(changes.flatMap(event => [...(event.data.paths ?? [])]))]
          const command = commandId ? raw.find(event => event.type === 'command/run' && event.data.commandId === commandId) : undefined
          // 空闲调用排除本次控制命令；忙碌取消后必须保留已落地的turn/end。
          const endedAfterCommand = command !== undefined && raw.some(event => event.seq > command.seq && event.type === 'turn/end')
          const head = command && !endedAfterCommand ? command.seq - 1 : agent.session.seq - 1
          // redo 点存的就是**将来要 checkout 的目标**，同样必须是稳定边界，否则重做会撞同一条原生校验。
          redo.push({ throughSeq: stableHistoryBoundary(raw, head), userSeq: user.seq, snapshot: current, paths })
        } else {
          const point = redo.pop()
          if (!point) return { ...await this.status(agent), action }
          // 旧日志里记下的 redo 点可能是修复前写的不稳定边界：读取时同样归一，不让重做撞原生校验。
          throughSeq = stableHistoryBoundary(agent.session.snapshotEvents(), point.throughSeq); restoreUserSeq = redo.at(-1)?.userSeq ?? null; target = point.snapshot; paths = point.paths
        }
        const operationId = randomUUID(), metadata: HistoryOperationMetadata = { version: 1, operationId, action, throughSeq, restoreUserSeq, nextRedo: redo, files: { mode: state.mode, paths } }
        agent.session.append('worktree/history-operation', metadata, { ignorable: true })
        await this.ctx.sessions.flush(agent.session)
        operationSignal.throwIfAborted()
        let transaction: RestoreTransaction | undefined
        try { transaction = state.store && target && paths.length ? await state.store.beginRestore({ operationId, sessionId: agent.id, target, paths: [...paths] }) : undefined }
        catch (error) { if (error instanceof RestoreError && !error.recovered) this.requireRecovery(agent, state); throw error }
        let checkout: SessionEvent<'session/history-checkout'> | undefined
        try {
          operationSignal.throwIfAborted()
          checkout = agent.session.checkout(throughSeq === -1 ? -1 : SessionSeq(throughSeq), { operationId })
          // 文件变更与required原生日志都完成后，才确认删除文件事务journal。
          await this.ctx.sessions.flush(agent.session)
          await transaction?.commit()
        } catch (error) {
          if (!checkout) {
            try { await transaction?.rollback() }
            catch (rollbackError) { this.requireRecovery(agent, state); throw new AggregateError([error, rollbackError], '撤销取消后尚未完成原件恢复。') }
          } else this.requireRecovery(agent, state)
          throw error
        }
        return { schema: 'lyapunov-history-v1', action, changed: true, sessionId: agent.id, checkoutSeq: checkout.seq, throughSeq, operationId, restoreUserSeq, canUndo: this.canUndo(agent, state), canRedo: this.redo(agent).length > 0, files: metadata.files, pendingInputs: agent.inbox.nextTurn.length + agent.inbox.nextStep.length } satisfies HistoryOperationResult
      })
    })
    this.operations.set(agent.id, pending)
    try { return await pending } finally { if (this.operations.get(agent.id) === pending) this.operations.delete(agent.id) }
  }
}
