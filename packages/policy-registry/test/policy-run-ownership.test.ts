/**
 * F05/F07 回归：执行 owner key 必须带原生会话身份；两个会话的同名 world/entity 不能互相顶掉或停止；
 * 插件释放要 abort 并等待本插件创建的任务真正 done，而不是只发 abort 或等待无关 Jobs。
 *
 * 场景/匹配/执行只用于隔离调度语义，所有真实算法入口都被受控替身替代；本用例不启动引擎或模型。
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'

type Run = { signal: AbortSignal; resolve: (status: string) => void }
type DownloadRun = { signal: AbortSignal; settle: (result?: unknown, error?: Error) => void }
let executeRuns: Run[] = []
let downloadRuns: DownloadRun[] = []
let matchGate: Promise<void> | undefined
let matchCalls = 0
mock.module('../src/match.ts', () => ({
  matchPolicy: async () => { matchCalls++; if (matchGate) await matchGate; return { status: 'MATCHED' } },
  resolvePolicyWorldBinding: async (binding: unknown) => binding,
}))
const realSource = await import('../src/source.ts')
mock.module('../src/source.ts', () => ({
  ...realSource,
  downloadPolicy: async (options: { signal: AbortSignal }) => {
    const gate = Promise.withResolvers<unknown>()
    downloadRuns.push({ signal: options.signal, settle: (result, error) => error ? gate.reject(error) : gate.resolve(result) })
    return gate.promise
  },
}))
mock.module('../src/execution.ts', () => ({
  executePolicy: async (_config: unknown, _input: unknown, _scene: unknown, _sim: unknown, signal: AbortSignal) => {
    const run = Promise.withResolvers<string>()
    executeRuns.push({ signal, resolve: run.resolve })
    return { status: await run.promise, runId: 'fixture-run' }
  },
}))
const { apply } = await import('../src/plugin.ts')

type JobRecord = { cancel: () => void; done: Promise<{ status: string }>; outcome?: { status: string }; waiters: Array<(outcome: { status: string }) => void> }
function harness() {
  const tools = new Map<string, any>(), commands = new Map<string, any>(), jobs = new Map<string, JobRecord>()
  let cleanup: (() => Promise<void>) | undefined
  let sequence = 0
  const ctx = {
    tools: { register: (tool: any) => void tools.set(tool.name, tool) },
    commands: { register: (command: any) => void commands.set(command.name, command) },
    jobs: {
      start: (spec: any) => {
        const id = JobId('job-' + (++sequence))
        const { cancel, done } = spec.run()
        const record: JobRecord = { cancel, done, waiters: [] }
        jobs.set(id, record)
        void (done as Promise<{ status: string }>).then((outcome: { status: string }) => {
          record.outcome = outcome
          for (const waiter of record.waiters.splice(0)) waiter(outcome)
        })
        return id
      },
      kill: (id: string) => { jobs.get(id)?.cancel(); return 'requested' as const },
      wait: (id: string) => {
        const record = jobs.get(id)
        if (!record) return Promise.reject(new Error('FIXTURE_JOB_NOT_FOUND'))
        if (record.outcome) return Promise.resolve(record.outcome)
        return new Promise(resolve => record.waiters.push(resolve))
      },
    },
    effect: (fn: () => () => Promise<void>) => { cleanup = fn(); return () => {} },
    reflect: { provide: () => {} },
    logger: { warn: () => {}, error: () => {} },
    get: (name: string) => {
      if (name === 'sim') return { forSession: () => ({ listWorlds: async () => [] }) }
      if (name === 'scene') return { forSession: () => ({}) }
      return undefined
    },
  }
  return { ctx, tools, jobs, get cleanup() { return cleanup } }
}
const signal = () => new AbortController().signal
function agent(session: string, cwd: string) {
  return { id: session as SessionId, session: { id: session as SessionId, header: { id: session as SessionId, cwd } } }
}
function executeInput() {
  return { identity: { provider: 'github', modelId: 'fixture/model', revision: 'pin' }, sceneId: 'scene', worldId: 'world', entityId: 'robot', expectedGeneration: 1 }
}

const roots: string[] = []
afterEach(async () => { executeRuns = []; downloadRuns = []; matchGate = undefined; matchCalls = 0; await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('policy 执行的会话 owner 与释放', () => {
  test('两个会话可同时运行相同 world/entity；停止只作用于传入会话自己的 owner', async () => {
    const h = harness(), dataDirectory = await mkdtemp(join(tmpdir(), 'policy-run-owner-')); roots.push(dataDirectory)
    apply(h.ctx as any, { dataDirectory })
    const a = agent('session-a', dataDirectory), b = agent('session-b', dataDirectory)
    const tool = h.tools.get('policy_execute')
    const runA = await tool.execute({ input: executeInput() }, { agent: a, signal: signal() })
    const runB = await tool.execute({ input: executeInput() }, { agent: b, signal: signal() })
    expect(runA.status).toBe('RUNNING'); expect(runB.status).toBe('RUNNING')
    expect(h.jobs.size).toBe(2)

    // 跨会话停止：B 用同名 world/entity 只停到 B 自己的任务，A 的仍活着。
    const stop = h.tools.get('policy_stop')
    const stopB = stop.execute({ input: { worldId: 'world', entityId: 'robot' } }, { agent: b, signal: signal() })
    await new Promise(resolve => setTimeout(resolve, 10))
    executeRuns[1]!.resolve('CANCELLED')
    expect(await stopB).toMatchObject({ status: 'STOPPING', runId: runB.runId })
    expect(h.jobs.get(runA.jobId)?.outcome).toBeUndefined()
    // A 自己的停止仍按 owner key 命中。
    const stopA = stop.execute({ input: { worldId: 'world', entityId: 'robot' } }, { agent: a, signal: signal() })
    await new Promise(resolve => setTimeout(resolve, 10))
    executeRuns[0]!.resolve('CANCELLED')
    expect(await stopA).toMatchObject({ status: 'STOPPING', runId: runA.runId })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(h.jobs.get(runA.jobId)?.outcome?.status).toBe('killed')
    expect(h.jobs.get(runB.jobId)?.outcome?.status).toBe('killed')
    await h.cleanup?.()
  })

  test('下载 Job 释放时 abort 并等待原始下载 Promise 真正结束', async () => {
    const h = harness(), dataDirectory = await mkdtemp(join(tmpdir(), 'policy-download-cleanup-')); roots.push(dataDirectory)
    apply(h.ctx as any, { dataDirectory })
    const a = agent('session-a', dataDirectory)
    const response = await h.tools.get('policy_download').execute({ input: { provider: 'github', modelId: 'fixture/model', revision: 'pin', background: true } }, { agent: a, signal: signal() })
    expect(response.status).toBe('RUNNING')
    expect(downloadRuns).toHaveLength(1)
    let cleanupSettled = false, cleanupError: unknown
    const cleanup = h.cleanup!()
    void cleanup.then(() => { cleanupSettled = true }, error => { cleanupSettled = true; cleanupError = error })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(downloadRuns[0]!.signal.aborted).toBe(true)
    expect(cleanupSettled).toBe(false)
    // 正常取消：原始下载以 AbortError 结束，释放应成功而不是把取消报成清理失败。
    downloadRuns[0]!.settle(undefined, Object.assign(new Error('aborted'), { name: 'AbortError' }))
    await cleanup
    expect(cleanupSettled).toBe(true); expect(cleanupError).toBeUndefined()
    expect(h.jobs.get(response.jobId)?.outcome?.status).toBe('killed')
  })

  test('清理阶段的真实错误传播为 POLICY_PLUGIN_CLEANUP_FAILED，不吞成成功', async () => {
    const h = harness(), dataDirectory = await mkdtemp(join(tmpdir(), 'policy-download-failure-')); roots.push(dataDirectory)
    apply(h.ctx as any, { dataDirectory })
    const a = agent('session-a', dataDirectory)
    const response = await h.tools.get('policy_download').execute({ input: { provider: 'github', modelId: 'fixture/model', revision: 'pin', background: true } }, { agent: a, signal: signal() })
    expect(response.status).toBe('RUNNING')
    const cleanup = h.cleanup!()
    await new Promise(resolve => setTimeout(resolve, 20))
    downloadRuns[0]!.settle(undefined, new Error('cleanup exploded'))
    await expect(cleanup).rejects.toThrow('POLICY_PLUGIN_CLEANUP_FAILED')
    expect(h.jobs.get(response.jobId)?.outcome?.status).toBe('failed')
  })

  test('匹配期间卸载：迟到的 MATCHED 不再新建 Job', async () => {
    const h = harness(), dataDirectory = await mkdtemp(join(tmpdir(), 'policy-match-unload-')); roots.push(dataDirectory)
    apply(h.ctx as any, { dataDirectory })
    const a = agent('session-a', dataDirectory)
    let release!: () => void
    matchGate = new Promise<void>(resolve => { release = resolve })
    const pending = h.tools.get('policy_execute').execute({ input: executeInput() }, { agent: a, signal: signal() })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(matchCalls).toBe(1)
    await h.cleanup?.()
    release()
    await expect(pending).rejects.toThrow('POLICY_PLUGIN_DISPOSED')
    expect(h.jobs.size).toBe(0)
    expect(executeRuns).toHaveLength(0)
  })

  test('插件释放 abort 并等待自己创建的任务 done，不等待无关 Job', async () => {
    const h = harness(), dataDirectory = await mkdtemp(join(tmpdir(), 'policy-run-cleanup-')); roots.push(dataDirectory)
    apply(h.ctx as any, { dataDirectory })
    const a = agent('session-a', dataDirectory)
    const run = await h.tools.get('policy_execute').execute({ input: executeInput() }, { agent: a, signal: signal() })
    // 无关 Job：插件没有创建它，释放不得等它。
    let unrelatedSettled = false
    h.jobs.set('unrelated', { cancel: () => {}, done: new Promise(() => {}), waiters: [] })

    let cleanupSettled = false
    const cleanup = h.cleanup!()
    void cleanup.then(() => { cleanupSettled = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(cleanupSettled).toBe(false)
    expect(executeRuns[0]!.signal.aborted).toBe(true)
    executeRuns[0]!.resolve('CANCELLED')
    await cleanup
    expect(cleanupSettled).toBe(true)
    expect(h.jobs.get(run.jobId)?.outcome?.status).toBe('killed')
    expect(unrelatedSettled).toBe(false)
  })

  test('原生 Job 准入拒绝时不起跑执行或下载；恢复准入后同一会话/world/entity 可复用占位', async () => {
    const h = harness(), dataDirectory = await mkdtemp(join(tmpdir(), 'policy-admission-')); roots.push(dataDirectory)
    apply(h.ctx as any, { dataDirectory })
    const a = agent('session-admission', dataDirectory)
    const originalStart = h.ctx.jobs.start
    // 主控负对照：admission 在 run 之前失败，原始执行/下载函数不得被调用。
    h.ctx.jobs.start = () => { throw new Error('NATIVE_JOB_ADMISSION_REFUSED') }
    await expect(h.tools.get('policy_execute').execute({ input: executeInput() }, { agent: a, signal: signal() })).rejects.toThrow('NATIVE_JOB_ADMISSION_REFUSED')
    await expect(h.tools.get('policy_download').execute({ input: { provider: 'github', modelId: 'fixture/model', revision: 'pin', background: true } }, { agent: a, signal: signal() })).rejects.toThrow('NATIVE_JOB_ADMISSION_REFUSED')
    expect(executeRuns).toHaveLength(0)
    expect(downloadRuns).toHaveLength(0)
    expect(h.jobs.size).toBe(0)

    // 恢复正常准入：同一 owner/world/entity 的 starting 占位已释放，可真正创建 Job 并起跑。
    h.ctx.jobs.start = originalStart
    const run = await h.tools.get('policy_execute').execute({ input: executeInput() }, { agent: a, signal: signal() })
    expect(run.status).toBe('RUNNING')
    expect(executeRuns).toHaveLength(1)
    expect(h.jobs.size).toBe(1)
    executeRuns[0]!.resolve('CANCELLED')
    await h.cleanup?.()
  })
})
