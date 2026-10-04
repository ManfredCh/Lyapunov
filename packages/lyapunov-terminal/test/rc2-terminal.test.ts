import { expect, test } from 'bun:test'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { JobId } from '@deepseek-ai/dsh-jobs/brand'
import { RemoteStream, RemoteStreamCarrierError, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/node'
import type { ConnectionGeneration } from '@deepseek-ai/dsh-client-connection/node'
import type { JobListFrame, JobView } from '@deepseek-ai/dsh-api-job-controller/types'
import { handleTerminalAction } from '../src/actions.ts'
import { eventText, historyLines } from '../src/format.ts'
import { terminalRemoteUrl } from '../src/remote-connection.ts'
import { firstTerminalJobRows, followTerminalJobRows } from '../src/remote-terminal.ts'
import { renderFrame, type FullscreenView } from '../src/fullscreen.ts'

const sid = SessionId('terminal-rc2')
const memoryGeneration = (id: number): ConnectionGeneration => ({ id, host: { home: '/home/terminal-fixture' } })
const abort = () => new AbortController().signal
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('terminal fixture did not settle')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}
const hold = (signal: AbortSignal): Promise<void> => new Promise(resolve => {
  if (signal.aborted) resolve()
  else signal.addEventListener('abort', () => resolve(), { once: true })
})
function job(rawId: string): JobView {
  return { id: JobId(rawId), kind: 'bash', label: rawId, owner: sid, status: 'running', startedAt: 1, output: { total: 0, earliest: 0 } }
}
function jobsRemote(list: (request: { sessionId: SessionId }, signal?: AbortSignal) => AsyncIterable<JobListFrame>, connection: ConstructorParameters<typeof RemoteStream>[0]) {
  return {
    job: { list },
    $stream<Item>(options: RemoteStreamOptions<Item>) { return new RemoteStream(connection, options) },
  } as unknown as Parameters<typeof followTerminalJobRows>[0]
}

test(':queue preserves both native Inbox lanes and does not fabricate an empty capability', async () => {
  const inbox = { 'next-turn': [{ role: 'user', content: [{ type: 'text', text: 'later' }] }], 'next-step': [{ role: 'user', content: [{ type: 'text', text: 'now' }] }] }
  let closed = 0, current: unknown = { [sid]: { asOfSeq: 4, values: { inbox } } }
  const ctx = { sessionController: { async *control(signal: AbortSignal) {
    signal.throwIfAborted()
    try { yield { type: 'baseline', value: { projections: current } } } finally { closed++ }
  } } } as unknown as Context
  const call = () => handleTerminalAction({ ctx, sessionId: sid, text: ':queue', signal: abort() })
  const present = await call()
  expect(present.handled).toBe(true)
  if (present.handled) expect(present.lines.join('\n')).toContain('next-step')
  if (present.handled) expect(JSON.parse(present.lines[0]!.slice(present.lines[0]!.indexOf('\n') + 1))).toEqual(inbox)
  current = { [sid]: { asOfSeq: 5, values: {} } }
  const absent = await call()
  if (absent.handled) expect(absent.lines).toEqual(['当前会话的原生 Inbox 投影尚未就绪。'])
  current = { [sid]: { asOfSeq: 6, values: { inbox: { 'next-turn': [], 'next-step': [] } } } }
  const empty = await call()
  if (empty.handled) expect(empty.lines.join('\n')).toContain('"next-turn": []')
  expect(closed).toBe(3)
})

test('V4 tool-role results retain call identity, content, and error outcome in live and history output', () => {
  const session = Session.create(sid)
  const failed = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('call-error'), isError: true, content: [{ type: 'text', text: 'failure details' }] }) }, { surfaceOp: 'append' })
  const success = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('call-ok'), isError: false, content: [{ type: 'text', text: 'done' }] }) }, { surfaceOp: 'append' })
  expect(eventText(failed)).toBe('[工具结果 call-error 错误] failure details')
  expect(eventText(success)).toBe('[工具结果 call-ok] done')
  expect(historyLines([failed, success])).toEqual([eventText(failed)!, eventText(success)!])
})

test('RC2 relative RPC strings and same-origin URLs preserve route/query while foreign targets fail', () => {
  const origin = 'https://terminal.example:9443'
  expect(terminalRemoteUrl('rpc/session/list?cursor=4', origin).href).toBe(origin + '/rpc/session/list?cursor=4')
  expect(terminalRemoteUrl(new URL(origin + '/rpc/status?rev=2'), origin).href).toBe(origin + '/rpc/status?rev=2')
  expect(() => terminalRemoteUrl('https://foreign.example/rpc/status', origin)).toThrow('REMOTE_ORIGIN_MISMATCH')
  expect(() => terminalRemoteUrl('//foreign.example/rpc/status', origin)).toThrow('REMOTE_ORIGIN_MISMATCH')
})

test('native Job carrier changes unknown to actual rows, loses the count on disconnect and replaces it on recovery', async () => {
  const listeners = new Set<() => void>(), loss = Promise.withResolvers<void>()
  let generation: ConnectionGeneration | undefined = memoryGeneration(1), opens = 0, closed = 0
  const connection: ConstructorParameters<typeof RemoteStream>[0] = { generation: { getSnapshot: () => generation, subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn) } } }
  const states: Array<readonly JobView[] | undefined> = []
  const first = [job('bash-1')], recovered = [job('bash-2'), job('bash-3')]
  const remote = jobsRemote(async function* (request, signal) {
    expect(request.sessionId).toBe(sid)
    expect(signal).toBeInstanceOf(AbortSignal)
    const generation = ++opens
    try {
      if (generation === 1) { yield { type: 'rows', jobs: first }; await loss.promise; throw new RemoteStreamCarrierError('fixture socket lost') }
      yield { type: 'rows', jobs: [] }
      yield { type: 'rows', jobs: recovered }
      await hold(signal!)
    } finally { closed++ }
  }, connection)
  const observer = followTerminalJobRows(remote, sid, rows => states.push(rows))
  try {
    expect(states).toEqual([undefined])
    await until(() => states.at(-1) === first)
    generation = undefined; loss.resolve()
    await until(() => states.length >= 3 && states.at(-1) === undefined)
    expect(opens).toBe(1)
    generation = memoryGeneration(2); for (const notify of listeners) notify()
    await until(() => states.at(-1) === recovered)
    expect(states.map(rows => rows?.length)).toEqual([undefined, 1, undefined, 0, 2])
    expect(states.at(-1)?.map(row => row.id)).toEqual([JobId('bash-2'), JobId('bash-3')])
  } finally { await observer.dispose(); await observer.task }
  expect(closed).toBe(2)
})

test('Job stream missing its initial anchor rejects rather than reporting zero jobs', async () => {
  const connection: ConstructorParameters<typeof RemoteStream>[0] = { generation: { getSnapshot: () => memoryGeneration(1), subscribe: () => () => {} } }
  const states: Array<readonly JobView[] | undefined> = []
  const remote = jobsRemote(async function* () {}, connection)
  const observer = followTerminalJobRows(remote, sid, rows => states.push(rows))
  await expect(observer.task).rejects.toThrow('原生 Jobs 流没有返回初始列表')
  expect(states).toEqual([undefined, undefined])
})

test(':jobs reads the original Job IDs and closes its one-shot stream; a missing first frame stays an error', async () => {
  const rows = [job('bash-9')]
  let closed = 0
  const remote = { job: { async *list(request: { sessionId: SessionId }, signal?: AbortSignal) {
    expect(request.sessionId).toBe(sid); signal?.throwIfAborted()
    try { yield { type: 'rows' as const, jobs: rows } } finally { closed++ }
  } } } as unknown as Parameters<typeof firstTerminalJobRows>[0]
  expect(await firstTerminalJobRows(remote, sid, abort())).toBe(rows)
  expect(closed).toBe(1)
  const missing = { job: { async *list() {} } } as unknown as Parameters<typeof firstTerminalJobRows>[0]
  await expect(firstTerminalJobRows(missing, sid, abort())).rejects.toThrow('没有返回初始快照')
})

test('fullscreen distinguishes unknown Job state from a real empty roster', () => {
  const view: FullscreenView = { size: { columns: 120, rows: 20 }, navIndex: 0, workspaces: [], transcript: [], editor: { draft: '', line: '', cursor: 0 }, status: { focus: 'editor', scrollBack: 0, draftLines: 0, attachments: 0, pendingApprovals: [], pendingQuestions: [] } }
  expect(renderFrame(view).join('\n')).toContain('Jobs ?')
  expect(renderFrame({ ...view, status: { ...view.status, jobs: 0 } }).join('\n')).toContain('Jobs 0')
})
