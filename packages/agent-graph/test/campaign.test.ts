/**
 * campaign-store 持久化往返 + plugin 四工具 + tools/execute waterfall 拦截器（tmpdir 夹具）。
 *
 * 最小 cordis ctx：只提供被测代码真正用到的面——ctx.on（捕获 waterfall handler）、
 * ctx.tools.register / ctx.commands.register（捕获定义后直接驱动 execute/handler）、ctx.get。
 * waterfall handler 用假 exec + 假 next 驱动，断言真实落盘文件而不是假桩行为。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { apply } from '../src/plugin.ts'
import { CampaignRuntime, extractReceipt, CAMPAIGN_BUDGET_EXCEEDED } from '../src/artifacts.ts'
import { CampaignStore } from '../src/campaign-store.ts'
import type { Campaign, RunCallArtifact } from '../../lyapunov-contracts/src/agent-graph.ts'

let workDir: string
beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), 'lyapunov-agent-graph-')) })
afterEach(() => { rmSync(workDir, { recursive: true, force: true }) })

const agentOf = (sessionId: string) => ({ id: sessionId, session: { header: { id: sessionId, cwd: workDir } } })
const agent = agentOf('session-a')

interface FakeToolResult { isError: boolean; value?: unknown; error?: { message: string }; content: unknown[] }
const ok = (value: unknown): FakeToolResult => ({ isError: false, value, content: [] })

function fakeCtx() {
  const handlers: Array<(exec: any, next: () => Promise<FakeToolResult>) => Promise<FakeToolResult>> = []
  const tools = new Map<string, { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
  const commands = new Map<string, { name: string; handler: (invocation: { rawInput: string; agent: unknown; signal?: AbortSignal }) => Promise<{ kind: string; text: string }> }>()
  const ctx = {
    on: (event: string, handler: any) => { if (event === 'tools/execute') handlers.push(handler); return () => {} },
    tools: {
      register: (definition: any) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) },
      // 命令别名 → tools.execute 的同一条 dispatch：穿 waterfall 链后落工具本体，回执形状对齐 cordis。
      execute: async (request: { name: string; arguments: unknown; callId: string; agent: unknown; signal: AbortSignal }) => {
        const exec = { name: request.name, arguments: request.arguments, callId: request.callId, agent: request.agent, signal: request.signal }
        const terminal = async (): Promise<FakeToolResult> => {
          const tool = tools.get(request.name)
          if (tool === undefined) return { isError: true, content: [{ type: 'text', text: `UNKNOWN_TOOL: ${request.name}` }], error: { message: `UNKNOWN_TOOL: ${request.name}` } }
          try {
            const value = await tool.execute(request.arguments, exec)
            const content = (tool as any).output?.render?.(request.arguments, value) ?? [{ type: 'text', text: JSON.stringify(value) }]
            return { isError: false, value, content }
          } catch (error) {
            return { isError: true, error: { message: String(error) }, content: [{ type: 'text', text: String(error) }] }
          }
        }
        let next = terminal
        for (const handler of [...handlers].reverse()) { const inner = next; next = () => handler(exec, inner) }
        return next()
      },
    },
    commands: { register: (definition: any) => { commands.set(definition.name, definition); return () => commands.delete(definition.name) } },
    get: () => undefined,
  }
  return { ctx: ctx as any, handlers, tools, commands }
}

function boot(config: { now?: () => number } = {}) {
  const host = fakeCtx()
  apply(host.ctx, { workDirFor: () => workDir, ...config })
  let seq = 0
  /** 走 waterfall 派一次工具调用；next 是工具体本身（返回固定结果并计 dispatch 次数）。 */
  const dispatch = async (toolName: string, args: unknown, result: FakeToolResult, owner: unknown = agent) => {
    const exec = { name: toolName, arguments: args, callId: `call-${++seq}`, agent: owner, signal: new AbortController().signal }
    let dispatched = 0
    const out = await host.handlers[0]!(exec, async () => { dispatched++; return result })
    return { out, dispatched }
  }
  const call = (toolName: string, input: unknown, owner: unknown = agent) =>
    host.tools.get(toolName)!.execute({ input }, { agent: owner, signal: new AbortController().signal })
  const command = (commandName: string, input: unknown, owner: unknown = agent) =>
    host.commands.get(commandName)!.handler({ rawInput: JSON.stringify(input), agent: owner, signal: new AbortController().signal })
  return { ...host, dispatch, call, command }
}

const TASKS = [
  { taskId: 'dev-1', sceneId: 'scene-1', partition: 'dev', goal: { kind: 'contact-exists' } },
  { taskId: 'heldout-1', sceneId: 'scene-1', partition: 'heldout', goal: { kind: 'settled' } },
]
const BUDGET = { maxToolCalls: 100, maxSimSteps: 10000, maxWallSeconds: 3600 }

const init = (host: ReturnType<typeof boot>, budget = BUDGET) =>
  host.call('campaign_init', { tasks: TASKS, budget }) as Promise<{ campaignId: string; campaign: Campaign }>

const readCalls = (campaignId: string, runId: string): RunCallArtifact[] =>
  readFileSync(join(workDir, '.lyapunov', 'campaigns', campaignId, 'runs', runId, 'calls.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line) as RunCallArtifact)

describe('campaign_init / campaign_status / campaign.json 持久化往返', () => {
  test('init 落 campaign.json：任务全 pending、used 清零、JSON 可重建', async () => {
    const host = boot()
    const { campaignId, campaign } = await init(host)
    const path = join(workDir, '.lyapunov', 'campaigns', campaignId, 'campaign.json')
    expect(existsSync(path)).toBe(true)
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as Campaign
    expect(persisted).toEqual(JSON.parse(JSON.stringify(campaign)))
    expect(persisted.tasks.map(task => task.status)).toEqual(['pending', 'pending'])
    expect(persisted.used).toEqual({ toolCalls: 0, simSteps: 0, startedAt: persisted.used.startedAt })
    expect(persisted.status).toBe('running')
    // status 工具读回同一份 + 命令面同签名。
    const status = await host.call('campaign_status', { campaignId }) as { campaign: Campaign; openRunIds: string[] }
    expect(status.campaign.campaignId).toBe(campaignId)
    expect(status.openRunIds).toEqual([])
    const viaCommand = await host.command('campaign_status', { campaignId })
    expect(viaCommand.kind).toBe('success')
    expect(JSON.parse(viaCommand.text).campaign.campaignId).toBe(campaignId)
    // 未知 campaignId 是具名 CAMPAIGN_NOT_FOUND。
    await expect(host.call('campaign_status', { campaignId: 'campaign-none' })).rejects.toThrow('CAMPAIGN_NOT_FOUND')
  })

  test('命令别名经 tools.execute 同一条 dispatch：waterfall 看到 campaign_* 回执', async () => {
    const host = boot()
    // 命令路径必须穿过 tools/execute 链——campaign 投影靠 tools/result 观察；直调 perform 会绕过它。
    const seen: string[] = []
    host.handlers.push(async (exec: { name: string }, next: () => Promise<FakeToolResult>) => { seen.push(exec.name); return next() })
    const viaCommand = await host.command('campaign_init', { tasks: TASKS, budget: BUDGET })
    expect(viaCommand.kind).toBe('success')
    expect(JSON.parse(viaCommand.text).campaignId).toBeTruthy()
    expect(seen).toEqual(['campaign_init'])
  })

  test('init 校验：空 tasks / 非法 partition / 非正预算各自具名拒绝', async () => {
    const host = boot()
    await expect(host.call('campaign_init', { tasks: [], budget: BUDGET })).rejects.toThrow('CAMPAIGN_INVALID_TASK')
    await expect(host.call('campaign_init', { tasks: [{ taskId: 'x', sceneId: 's', partition: 'qa', goal: {} }], budget: BUDGET })).rejects.toThrow('CAMPAIGN_INVALID_TASK')
    await expect(host.call('campaign_init', { tasks: TASKS, budget: { maxToolCalls: 0, maxSimSteps: 1, maxWallSeconds: 1 } })).rejects.toThrow('CAMPAIGN_INVALID_BUDGET')
  })
})

describe('campaign_transition：状态机 + run 生命周期', () => {
  test('pending→exploring 开 worker run：runs/<runId>/{run.json,calls.jsonl} 落盘、workerRunIds 登记', async () => {
    const host = boot()
    const { campaignId } = await init(host)
    const result = await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'exploring' }) as { runId?: string; from: string; to: string }
    expect(result.from).toBe('pending')
    expect(result.runId).toMatch(/^run-/)
    const runDir = join(workDir, '.lyapunov', 'campaigns', campaignId, 'runs', result.runId!)
    expect(existsSync(join(runDir, 'run.json'))).toBe(true)
    expect(existsSync(join(runDir, 'calls.jsonl'))).toBe(true)
    const campaign = JSON.parse(readFileSync(join(workDir, '.lyapunov', 'campaigns', campaignId, 'campaign.json'), 'utf8')) as Campaign
    expect(campaign.tasks[0]!.status).toBe('exploring')
    expect(campaign.tasks[0]!.workerRunIds).toEqual([result.runId!])
  })

  test('非法迁移具名拒绝（pending→done、heldout 任务 pending→exploring）', async () => {
    const host = boot()
    const { campaignId } = await init(host)
    await expect(host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'done' })).rejects.toThrow('CAMPAIGN_ILLEGAL_TRANSITION')
    await expect(host.call('campaign_transition', { campaignId, taskId: 'heldout-1', to: 'exploring' })).rejects.toThrow('CAMPAIGN_ILLEGAL_TRANSITION')
    await expect(host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'nonsense' })).rejects.toThrow('CAMPAIGN_INVALID_STATUS')
    await expect(host.call('campaign_transition', { campaignId, taskId: 'ghost', to: 'exploring' })).rejects.toThrow('CAMPAIGN_TASK_NOT_FOUND')
  })

  test('heldout 任务 worker run → CAMPAIGN_PARTITION_VIOLATION；verifier 放行', async () => {
    const host = boot()
    const { campaignId } = await init(host)
    await expect(host.call('campaign_transition', { campaignId, taskId: 'heldout-1', to: 'heldout-eval', role: 'worker' })).rejects.toThrow('CAMPAIGN_PARTITION_VIOLATION')
    const okResult = await host.call('campaign_transition', { campaignId, taskId: 'heldout-1', to: 'heldout-eval' }) as { runId: string }
    expect(okResult.runId).toMatch(/^run-/)
    // record_run 自报 worker 同样被铁律拒。
    await expect(host.call('campaign_record_run', { campaignId, taskId: 'heldout-1', role: 'worker', summary: { outcome: 'success' } })).rejects.toThrow('CAMPAIGN_PARTITION_VIOLATION')
    const closed = await host.call('campaign_record_run', { campaignId, taskId: 'heldout-1', role: 'verifier', summary: { outcome: 'success' } }) as { runId: string }
    expect(closed.runId).toBe(okResult.runId)
    const campaign = (await host.call('campaign_status', { campaignId }) as { campaign: Campaign }).campaign
    expect(campaign.tasks[1]!.heldoutResult?.taskAchieved).toBe(true)
    expect(campaign.tasks[1]!.heldoutResult?.runId).toBe(okResult.runId)
  })
})

describe('tools/execute waterfall：artifact 收集 + 预算护栏', () => {
  test('活动 run 下每次调用记 RunCallArtifact：seq/callId/tool/sha256 argsDigest/回执转录', async () => {
    const host = boot()
    const { campaignId } = await init(host)
    const { runId } = await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'exploring' }) as { runId: string }
    const args = { worldId: 'w1', steps: 5 }
    await host.dispatch('sim_step', args, ok({ startStep: 0, endStep: 5, status: 'completed', taskAchieved: false, generation: 7 }))
    const calls = readCalls(campaignId, runId)
    expect(calls.length).toBe(1)
    expect(calls[0]).toMatchObject({
      seq: 1, callId: 'call-1', tool: 'sim_step',
      argsDigest: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
      receipt: { startStep: 0, endStep: 5, status: 'completed', taskAchieved: false, generation: 7 },
    })
    // 预算计数：toolCalls+1、simSteps 按 endStep-startStep 增量。
    const campaign = JSON.parse(readFileSync(join(workDir, '.lyapunov', 'campaigns', campaignId, 'campaign.json'), 'utf8')) as Campaign
    expect(campaign.used.toolCalls).toBe(1)
    expect(campaign.used.simSteps).toBe(5)
  })

  test('campaign_* 工具与无 run 会话不进证据轨迹', async () => {
    const host = boot()
    const { campaignId } = await init(host)
    const { runId } = await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'exploring' }) as { runId: string }
    // campaign_* 名字豁免：不计数、不记录。
    await host.dispatch('campaign_status', {}, ok({}))
    // 别的会话没有活动 run：原样放行。
    const other = await host.dispatch('sim_step', {}, ok({}), agentOf('session-b'))
    expect(other.dispatched).toBe(1)
    expect(readCalls(campaignId, runId).length).toBe(0)
  })

  test('预算超限：当次调用放行完成，后续调用被 CAMPAIGN_BUDGET_EXCEEDED 拦截且不再 dispatch', async () => {
    const host = boot()
    const { campaignId } = await init(host, { ...BUDGET, maxToolCalls: 1 })
    const { runId } = await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'exploring' }) as { runId: string }
    const first = await host.dispatch('sim_step', {}, ok({}))
    expect(first.dispatched).toBe(1)
    // 第二次：waterfall 里直接抛，不触达工具体。
    await expect(host.dispatch('sim_step', {}, ok({}))).rejects.toThrow(CAMPAIGN_BUDGET_EXCEEDED)
    const calls = readCalls(campaignId, runId)
    expect(calls.length).toBe(2)
    expect(calls[1]!.error).toContain(CAMPAIGN_BUDGET_EXCEEDED)
    // used 只计真实执行的那一次；campaign_* 工具仍可用（record_run 收尾不被预算闸挡）。
    const campaign = JSON.parse(readFileSync(join(workDir, '.lyapunov', 'campaigns', campaignId, 'campaign.json'), 'utf8')) as Campaign
    expect(campaign.used.toolCalls).toBe(1)
    const closed = await host.call('campaign_record_run', { campaignId, taskId: 'dev-1', role: 'worker', summary: { outcome: 'budget-exceeded' } }) as { summary: { toolCalls: number; outcome: string } }
    expect(closed.summary).toMatchObject({ toolCalls: 1, outcome: 'budget-exceeded' })
  })

  test('simSteps 维度超限同样拦截', async () => {
    const host = boot()
    const { campaignId } = await init(host, { ...BUDGET, maxSimSteps: 5 })
    await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'exploring' })
    await host.dispatch('sim_step', {}, ok({ startStep: 0, endStep: 5 }))
    await expect(host.dispatch('sim_step', {}, ok({}))).rejects.toThrow(CAMPAIGN_BUDGET_EXCEEDED)
  })

  test('失败回执也留证（error 字段），计数不变', async () => {
    const host = boot()
    const { campaignId } = await init(host)
    const { runId } = await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'exploring' }) as { runId: string }
    await host.dispatch('sim_step', {}, { isError: true, error: { message: 'PHYSICS blew up' }, content: [] })
    const calls = readCalls(campaignId, runId)
    expect(calls[0]!.error).toBe('PHYSICS blew up')
    expect(calls[0]!.receipt).toBeUndefined()
  })
})

describe('campaign_record_run：关闭 run 写 run.json', () => {
  test('run.json 自含完整 calls + summary（JSON 可重建）', async () => {
    const host = boot()
    const { campaignId } = await init(host)
    const { runId } = await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'exploring' }) as { runId: string }
    await host.dispatch('sim_step', { a: 1 }, ok({ startStep: 0, endStep: 3 }))
    await host.dispatch('sim_step', { a: 2 }, ok({ startStep: 3, endStep: 9 }))
    const closed = await host.call('campaign_record_run', { campaignId, taskId: 'dev-1', role: 'worker', summary: { outcome: 'success', notes: 'done' } }) as { runId: string; summary: { toolCalls: number; simSteps: number } }
    expect(closed.summary).toMatchObject({ toolCalls: 2, simSteps: 9 })
    const runJson = JSON.parse(readFileSync(join(workDir, '.lyapunov', 'campaigns', campaignId, 'runs', runId, 'run.json'), 'utf8'))
    expect(runJson.calls.length).toBe(2)
    expect(runJson.summary.outcome).toBe('success')
    // 关闭后再 record 是具名 CAMPAIGN_NO_ACTIVE_RUN。
    await expect(host.call('campaign_record_run', { campaignId, taskId: 'dev-1', role: 'worker', summary: { outcome: 'success' } })).rejects.toThrow('CAMPAIGN_NO_ACTIVE_RUN')
  })

  test('同任务同角色连续迁移复用 run；角色切换开新 run', async () => {
    const host = boot()
    const { campaignId } = await init(host)
    const first = await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'exploring' }) as { runId: string }
    const second = await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'debugging' }) as { runId: string }
    expect(second.runId).toBe(first.runId)
    const third = await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'verifying' }) as { runId: string }
    expect(third.runId).not.toBe(first.runId)
    const status = await host.call('campaign_status', { campaignId }) as { openRunIds: string[] }
    expect(status.openRunIds.sort()).toEqual([first.runId, third.runId].sort())
  })
})

describe('CampaignRuntime / extractReceipt 单元面', () => {
  test('wall 预算：注入时钟越过 maxWallSeconds → wallSeconds breach', async () => {
    const store = new CampaignStore(() => workDir)
    let now = 1_000_000
    const runtime = new CampaignRuntime(store, () => now)
    const campaign: Campaign = {
      campaignId: 'campaign-wall', createdAt: new Date(now).toISOString(),
      tasks: [], budget: { maxToolCalls: 100, maxSimSteps: 100, maxWallSeconds: 10 },
      used: { toolCalls: 0, simSteps: 0, startedAt: new Date(now).toISOString() }, status: 'running',
    }
    const handle = await runtime.createCampaign(agent, campaign)
    expect(runtime.budgetExceeded(handle)).toBeUndefined()
    now += 10_500
    expect(runtime.budgetExceeded(handle)).toEqual({ limit: 'wallSeconds', used: 10, max: 10 })
  })

  test('extractReceipt：value.result 是 JSON 字符串时解析取字段', () => {
    expect(extractReceipt({ result: JSON.stringify({ startStep: 1, endStep: 4, taskAchieved: true }) }))
      .toEqual({ startStep: 1, endStep: 4, taskAchieved: true })
    expect(extractReceipt({ stepIndex: 3 })).toBeUndefined()
    expect(extractReceipt('plain')).toBeUndefined()
  })
})
