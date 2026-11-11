/**
 * 跨包 campaign E2E（docs/AGENT_GRAPH_CONTRACT.md §7）：
 * 真实 Cordis 上下文（原生 Tools/Commands/Session/AgentLoop 测试装配）+ tmpdir 工作目录，
 * 走真 `ctx.tools.execute` 管线验证整条编排链：
 *
 *   campaign_init → transition(pending→exploring→debugging) → 活动 run 内的普通工具调用
 *   被 tools/execute waterfall 记进 runs/<runId>/calls.jsonl → campaign_record_run 关 run
 *   → skill_propose / skill_verify_record / skill_promote（policy-registry 技能库，tmpdir packsRoot）
 *   → transition(...→verifying→heldout-eval→done) 收拢 campaign。
 *
 * 反例：heldout 任务走 worker 管线（partition 越权）与未验证 promote 各被具名拒绝。
 * campaign 落盘根取真实 `session.header.cwd`（tmp 目录），不注入 workDirFor——
 * 与产品装配同一归属路径。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createHash } from 'node:crypto'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { applyOfflineSceneWorkflows } from '../../robot-workflows/src/offline-scene-plugin.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { MockAdapter, textResponse, toolCallResponse } from '../../../.upstream/deepseek-harness-0.2.0-rc.2/packages/core/agent-loop/tests/mock-adapter.ts'
import * as agentGraphPlugin from '../src/plugin.ts'
import { applySkillTools } from '../../policy-registry/src/skill-tools.ts'
import type { Campaign, CampaignRun, RunCallArtifact, SkillProposal } from '../../lyapunov-contracts/src/agent-graph.ts'

let workDir: string
let packsRoot: string
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'lyapunov-campaign-e2e-'))
  packsRoot = mkdtempSync(join(tmpdir(), 'lyapunov-campaign-e2e-packs-'))
})
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  rmSync(packsRoot, { recursive: true, force: true })
})

const BUDGET = { maxToolCalls: 200, maxSimSteps: 10000, maxWallSeconds: 3600 }
const TASKS = [
  { taskId: 'dev-1', sceneId: 'scene-1', partition: 'dev', goal: { kind: 'contact-exists' } },
  { taskId: 'held-1', sceneId: 'scene-1', partition: 'heldout', goal: { kind: 'settled' } },
]

async function boot(script: ConstructorParameters<typeof MockAdapter>[0] = []) {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(CommandRuntime)
    ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
    // 与产品同一装载路径：插件模块经 cordis 装载，inject(tools/commands) 缺服务即失败。
    await ctx.plugin(agentGraphPlugin)
    applySkillTools(ctx, { packsRoot })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('session-e2e'), { provider: 'mock', model: 'mock' }, { cwd: workDir })
    // 一个非 campaign_* 的探测工具：活动 run 下它的调用必须进 calls.jsonl 证据轨迹。
    // seenArguments 记工具体真实收到的归一化入参——calls.jsonl 的 argsDigest 摘的就是这份。
    const seenArguments: unknown[] = []
    ctx.tools.register(defineTool({
      name: 'e2e_probe',
      description: 'fixture probe returning a sim-shaped receipt',
      parameters: { input: { type: 'json', required: true, description: 'fixture input' } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async args => {
        seenArguments.push(args)
        return { startStep: 0, endStep: 4, status: 'completed', taskAchieved: false, generation: 3 }
      },
    }))
    let seq = 0
    const call = (name: string, input: unknown, owner: Agent = agent): Promise<ToolExecutionResult> =>
      ctx.tools.execute({ name, arguments: { input }, callId: ToolCallId(`e2e-${++seq}`), signal: AbortSignal.timeout(10_000), agent: owner })
    return { ctx, agent, call, seenArguments, close: () => ctx.fiber.dispose() }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

function valueOf<T>(result: ToolExecutionResult): T {
  if (result.isError) throw new Error(`工具失败：${result.error.message}`)
  return result.value as T
}

const campaignOf = (campaignId: string): Campaign =>
  JSON.parse(readFileSync(join(workDir, '.lyapunov', 'campaigns', campaignId, 'campaign.json'), 'utf8')) as Campaign
const runOf = (campaignId: string, runId: string): CampaignRun =>
  JSON.parse(readFileSync(join(workDir, '.lyapunov', 'campaigns', campaignId, 'runs', runId, 'run.json'), 'utf8')) as CampaignRun

// 唯一替身是模型响应及e2e_probe读数；真实AgentLoop/Subagent/SessionQuery/事件/计量与落盘均走原SDK。
describe('原生一次性子会话结束后的run收尾', () => {
  test('原生续接子会话的epoch结束不关闭仍可继续的run', async () => {
    const campaignId = 'native-continuable'
    const host = await boot([
      toolCallResponse('native-open', 'campaign_transition', { input: { campaignId, taskId: 'dev-1', to: 'exploring', role: 'worker' } }),
      toolCallResponse('native-probe', 'e2e_probe', { input: {} }),
      textResponse('本轮结束，后续仍可继续'),
    ])
    try {
      await host.ctx.plugin(JsonlSessionPersistence, { root: join(workDir, 'sessions') })
      await host.ctx.plugin(SessionQuery, [])
      await host.ctx.plugin(SubagentRuntime)
      await host.ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
      valueOf(await host.call('campaign_init', { campaignId, tasks: TASKS, budget: BUDGET }))
      const ended = Promise.withResolvers<void>()
      host.ctx.on('subagent/end', () => ended.resolve())
      const child = await host.ctx.subagents.startContinuable({ provider: 'spawn', label: '续接反例', request: { parent: host.agent, prompt: [{ type: 'text', text: '驱动原续接生命周期' }] }, signal: AbortSignal.timeout(2000) })
      await ended.promise
      // 原生命周期监听器异步查询descriptor；留出有界落盘窗口后读原owner状态。
      await new Promise(resolve => setTimeout(resolve, 50))
      const id = campaignOf(campaignId).tasks[0]!.workerRunIds[0]!
      expect(runOf(campaignId, id).summary).toBeUndefined()
      expect(callsOf(campaignId, id)).toHaveLength(1)
      using observed = await host.ctx.sessionQuery.observeSession(child.childId, { projectionMode: 'none' })
      expect(observed.header.id).toBe(child.childId)
    } finally {
      await host.close()
    }
  })

  for (const cancellation of [false, true]) test(cancellation ? '真实取消后按原计量中止，Parent run保留' : '结束但漏记账时按中止收尾，不推断成功', async () => {
    const campaignId = cancellation ? 'native-cancel' : 'native-unclosed'
    const host = await boot([
      toolCallResponse('native-open', 'campaign_transition', { input: { campaignId, taskId: 'dev-1', to: 'exploring', role: 'worker' } }),
      toolCallResponse('native-probe', 'e2e_probe', { input: {} }),
      cancellation ? 'hang' : textResponse('接口夹具结束，故意不调用record_run'),
    ])
    let run: Awaited<ReturnType<typeof host.ctx.subagents.start>> | undefined
    try {
      await host.ctx.plugin(SessionQuery, [])
      await host.ctx.plugin(SubagentRuntime)
      await host.ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
      valueOf(await host.call('campaign_init', { campaignId, tasks: [...TASKS, { taskId: 'parent-dev', sceneId: 'parent-scene', partition: 'dev', goal: { kind: 'settled' } }], budget: BUDGET }))
      const parentRun = valueOf<{ runId: string }>(await host.call('campaign_transition', { campaignId, taskId: 'parent-dev', to: 'exploring', role: 'coordinator' }))
      const controller = new AbortController()
      run = await host.ctx.subagents.start('spawn', { parent: host.agent, prompt: [{ type: 'text', text: '只驱动原生生命周期接口夹具' }], signal: controller.signal })
      const until = async (predicate: () => boolean) => {
        const deadline = Date.now() + 2000
        while (!predicate()) {
          if (Date.now() >= deadline) throw new Error('原生命周期收尾未在2秒内落盘')
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }
      await until(() => {
        const task = campaignOf(campaignId).tasks.find(task => task.taskId === 'dev-1')!
        return task.workerRunIds.length === 1 && callsOf(campaignId, task.workerRunIds[0]!).length === 1
      })
      if (cancellation) controller.abort()
      const result = await run.result
      expect(result.stopReason).toBe(cancellation ? 'aborted' : 'completed')
      const childRunId = campaignOf(campaignId).tasks.find(task => task.taskId === 'dev-1')!.workerRunIds[0]!
      await until(() => runOf(campaignId, childRunId).summary !== undefined)
      expect(runOf(campaignId, childRunId).summary).toMatchObject({ outcome: 'aborted', toolCalls: 1, simSteps: 4 })
      expect(runOf(campaignId, childRunId).summary?.notes).toContain('不代表目标达成')
      expect(runOf(campaignId, parentRun.runId).summary).toBeUndefined()
      expect(campaignOf(campaignId).tasks.find(task => task.taskId === 'dev-1')!.status).toBe('exploring')
      expect(valueOf<{ openRunIds: string[] }>(await host.call('campaign_status', { campaignId })).openRunIds).toEqual([parentRun.runId])
    } finally {
      await run?.dispose()
      await host.close()
    }
  })

  test('一次性子会话已显式完成的run保持原结果', async () => {
    const campaignId = 'native-closed'
    const host = await boot([
      toolCallResponse('native-open', 'campaign_transition', { input: { campaignId, taskId: 'dev-1', to: 'exploring', role: 'worker' } }),
      toolCallResponse('native-probe', 'e2e_probe', { input: {} }),
      toolCallResponse('native-close', 'campaign_record_run', { input: { campaignId, taskId: 'dev-1', role: 'worker', summary: { outcome: 'failed', notes: '原Owner显式结果' } } }),
      textResponse('已记账'),
    ])
    let run: Awaited<ReturnType<typeof host.ctx.subagents.start>> | undefined
    try {
      await host.ctx.plugin(SessionQuery, [])
      await host.ctx.plugin(SubagentRuntime)
      await host.ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
      valueOf(await host.call('campaign_init', { campaignId, tasks: TASKS, budget: BUDGET }))
      run = await host.ctx.subagents.start('spawn', { parent: host.agent, prompt: [{ type: 'text', text: '按原owner显式记账' }], signal: new AbortController().signal })
      await run.result
      const id = campaignOf(campaignId).tasks[0]!.workerRunIds[0]!
      expect(runOf(campaignId, id).summary).toEqual({ outcome: 'failed', toolCalls: 1, simSteps: 4, notes: '原Owner显式结果' })
    } finally {
      await run?.dispose()
      await host.close()
    }
  })
})
function errorOf(result: ToolExecutionResult): string {
  if (!result.isError) throw new Error('期望具名拒绝但调用成功')
  return result.error.message
}
const callsOf = (campaignId: string, runId: string): RunCallArtifact[] =>
  readFileSync(join(workDir, '.lyapunov', 'campaigns', campaignId, 'runs', runId, 'calls.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line) as RunCallArtifact)

const proposal = (runIds: string[]): SkillProposal => ({
  skillId: 'recover-contact-slip',
  packId: 'e2e-pack',
  failureSignature: { reasonCodes: ['CONTACT_MISSING'], description: '抓取接触建立后又滑脱' },
  applicableWhen: { robotKinds: ['arm'], taskShape: 'pick-place', description: '带抓取的多步放置任务' },
  fixStrategy: '重抓前先做 settled 检查并在抬升步降速',
  program: [{ tool: 'e2e_probe', input: { speed: 'slow' } }],
  devEvidence: { runIds, checkedAt: new Date().toISOString() },
})

describe('campaign E2E：真实 Cordis 装配下的全链路', () => {
  test('init→exploring/debugging→证据收集→record_run→propose→verify→promote→done', async () => {
    const host = await boot()
    try {
      // init：campaign.json 落在会话工作目录下，任务全 pending。
      const { campaignId } = valueOf<{ campaignId: string; campaign: Campaign }>(await host.call('campaign_init', { tasks: TASKS, budget: BUDGET }))
      const campaignDir = join(workDir, '.lyapunov', 'campaigns', campaignId)
      expect(existsSync(join(campaignDir, 'campaign.json'))).toBe(true)

      // dev-1 进入 worker 管线；exploring→debugging 复用同一 run。
      const exploring = valueOf<{ runId: string }>(await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'exploring' }))
      const debugging = valueOf<{ runId: string }>(await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'debugging' }))
      expect(debugging.runId).toBe(exploring.runId)

      // 活动 run 内的普通工具调用被 waterfall 收进 calls.jsonl（参数只留 sha256 摘要，
      // 摘的是管线归一化后工具体真实收到的那份入参）。
      const probeArgs = { input: { speed: 'slow' } }
      await host.call('e2e_probe', probeArgs)
      const calls = callsOf(campaignId, exploring.runId)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        seq: 1, tool: 'e2e_probe',
        argsDigest: createHash('sha256').update(JSON.stringify(host.seenArguments[0])).digest('hex'),
        receipt: { startStep: 0, endStep: 4, status: 'completed', taskAchieved: false, generation: 3 },
      })
      const used = (JSON.parse(readFileSync(join(campaignDir, 'campaign.json'), 'utf8')) as Campaign).used
      expect(used.toolCalls).toBe(1)
      expect(used.simSteps).toBe(4)

      // record_run 关 run：run.json 自含 calls + summary。
      const closed = valueOf<{ runId: string; summary: { toolCalls: number; simSteps: number } }>(
        await host.call('campaign_record_run', { campaignId, taskId: 'dev-1', role: 'worker', summary: { outcome: 'success', notes: '复现并修复接触滑脱' } }))
      const runJson = JSON.parse(readFileSync(join(campaignDir, 'runs', closed.runId, 'run.json'), 'utf8')) as CampaignRun
      expect(runJson.calls).toHaveLength(1)
      expect(runJson.summary).toMatchObject({ toolCalls: 1, simSteps: 4, outcome: 'success' })

      // verifier 面：dev-1 进 verifying 开新 run（角色切换）；held-1 走 heldout 复核。
      const verifying = valueOf<{ runId: string }>(await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'verifying' }))
      expect(verifying.runId).not.toBe(exploring.runId)
      const heldEval = valueOf<{ runId: string }>(await host.call('campaign_transition', { campaignId, taskId: 'held-1', to: 'heldout-eval' }))
      valueOf(await host.call('campaign_record_run', { campaignId, taskId: 'held-1', role: 'verifier', summary: { outcome: 'success' } }))

      // 技能库链：提案 → 验证记录 → 晋升（verifierRunId 用真实的 heldout 复核 run）。
      mkdirSync(join(packsRoot, 'e2e-pack'), { recursive: true })
      const proposed = valueOf<{ status: string; admitted: boolean }>(
        await host.call('skill_propose', { packId: 'e2e-pack', proposal: proposal([closed.runId]) }))
      expect(proposed).toMatchObject({ status: 'PROPOSED', admitted: false })
      valueOf(await host.call('skill_verify_record', {
        skillId: 'recover-contact-slip', verifierRunId: heldEval.runId,
        reproducedTaskIds: ['held-1'], attempts: 1, passed: true,
      }))
      const promoted = valueOf<{ status: string; promotion: { verifierRunId: string } }>(
        await host.call('skill_promote', { skillId: 'recover-contact-slip', packId: 'e2e-pack' }))
      expect(promoted.status).toBe('PROMOTED')
      expect(promoted.promotion.verifierRunId).toBe(heldEval.runId)
      expect(existsSync(join(packsRoot, 'e2e-pack', 'skills', 'recover-contact-slip.json'))).toBe(true)

      // 收尾：held-1 复核通过 → done；dev-1 verifying→heldout-eval→done；campaign 收拢 completed。
      valueOf(await host.call('campaign_transition', { campaignId, taskId: 'held-1', to: 'done' }))
      valueOf(await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'heldout-eval' }))
      valueOf(await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'done' }))
      const status = valueOf<{ campaign: Campaign; openRunIds: string[] }>(await host.call('campaign_status', { campaignId }))
      expect(status.campaign.status).toBe('completed')
      expect(status.campaign.tasks.map(task => task.status)).toEqual(['done', 'done'])
    } finally {
      await host.close()
    }
  })

  test('反例：heldout 任务的 worker 管线越权两处被具名拒绝', async () => {
    const host = await boot()
    try {
      const { campaignId } = valueOf<{ campaignId: string }>(await host.call('campaign_init', { tasks: TASKS, budget: BUDGET }))
      // heldout 任务没有 pending→exploring 边（worker 阶段对 heldout 不开放）。
      expect(errorOf(await host.call('campaign_transition', { campaignId, taskId: 'held-1', to: 'exploring' }))).toContain('CAMPAIGN_ILLEGAL_TRANSITION')
      // 显式 worker 角色触碰 heldout 是分区铁律拒绝。
      expect(errorOf(await host.call('campaign_transition', { campaignId, taskId: 'held-1', to: 'heldout-eval', role: 'worker' }))).toContain('CAMPAIGN_PARTITION_VIOLATION')
      // 任务状态未被拒动：仍是 pending，campaign 照常 running。
      const status = valueOf<{ campaign: Campaign }>(await host.call('campaign_status', { campaignId }))
      expect(status.campaign.tasks[1]?.status).toBe('pending')
      expect(status.campaign.status).toBe('running')
    } finally {
      await host.close()
    }
  })

  test('反例：未验证的提案 promote 被 SKILL_NOT_VERIFIED 拒绝', async () => {
    const host = await boot()
    try {
      const { campaignId } = valueOf<{ campaignId: string }>(await host.call('campaign_init', { tasks: TASKS, budget: BUDGET }))
      const exploring = valueOf<{ runId: string }>(await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'exploring' }))
      mkdirSync(join(packsRoot, 'e2e-pack'), { recursive: true })
      valueOf(await host.call('skill_propose', { packId: 'e2e-pack', proposal: proposal([exploring.runId]) }))
      expect(errorOf(await host.call('skill_promote', { skillId: 'recover-contact-slip', packId: 'e2e-pack' }))).toContain('SKILL_NOT_VERIFIED')
      // 失败记录同样不解锁晋升。
      valueOf(await host.call('skill_verify_record', { skillId: 'recover-contact-slip', verifierRunId: exploring.runId, reproducedTaskIds: [], attempts: 1, passed: false }))
      expect(errorOf(await host.call('skill_promote', { skillId: 'recover-contact-slip' }))).toContain('SKILL_NOT_VERIFIED')
      expect(existsSync(join(packsRoot, 'e2e-pack', 'skills', 'recover-contact-slip.json'))).toBe(false)
    } finally {
      await host.close()
    }
  })

  test('命令别名（/skill_propose）经 ctx.tools.execute 同一 dispatch 进入 calls.jsonl 并计预算', async () => {
    const host = await boot()
    try {
      const { campaignId } = valueOf<{ campaignId: string }>(await host.call('campaign_init', { tasks: TASKS, budget: BUDGET }))
      const exploring = valueOf<{ runId: string }>(await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'exploring' }))
      mkdirSync(join(packsRoot, 'e2e-pack'), { recursive: true })
      const cmd = await host.ctx.commands.execute(host.agent, `/skill_propose ${JSON.stringify({ packId: 'e2e-pack', proposal: proposal([exploring.runId]) })}`, [], new AbortController().signal)
      expect(cmd?.result.kind).toBe('success')
      const calls = callsOf(campaignId, exploring.runId)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.tool).toBe('skill_propose')
    } finally {
      await host.close()
    }
  })

  test('Verifier 硬隔离：禁止读取 .lyapunov/campaigns 产物，且禁止用 proposer runId 自审准入', async () => {
    const host = await boot()
    try {
      const { campaignId } = valueOf<{ campaignId: string }>(await host.call('campaign_init', { tasks: TASKS, budget: BUDGET }))
      const exploring = valueOf<{ runId: string }>(await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'exploring' }))
      mkdirSync(join(packsRoot, 'e2e-pack'), { recursive: true })
      valueOf(await host.call('skill_propose', { packId: 'e2e-pack', proposal: proposal([exploring.runId]) }))
      // 1) 拿 proposer 自己的 worker runId 冒充 verifierRunId passed=true → promote 被拒绝
      valueOf(await host.call('skill_verify_record', {
        skillId: 'recover-contact-slip', verifierRunId: exploring.runId, reproducedTaskIds: ['dev-1'], attempts: 1, passed: true,
      }))
      expect(errorOf(await host.call('skill_promote', { skillId: 'recover-contact-slip', packId: 'e2e-pack' }))).toContain('SKILL_NOT_VERIFIED')

      // 2) 进入 verifying 阶段后，verifier 尝试读取 .lyapunov/campaigns 下的 proposer 产物 → 被 waterfall 硬拦截
      await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'debugging' })
      const verifying = valueOf<{ runId: string }>(await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'verifying' }))
      const leak = await host.call('e2e_probe', { path: `.lyapunov/campaigns/${campaignId}/runs/${exploring.runId}/calls.jsonl` })
      expect(errorOf(leak)).toContain('CAMPAIGN_VERIFIER_ISOLATION')
      const vCalls = callsOf(campaignId, verifying.runId)
      expect(vCalls[0]?.error).toContain('CAMPAIGN_VERIFIER_ISOLATION')
    } finally {
      await host.close()
    }
  })

  test('跨分区 Scene 防污染 + Curriculum 确定性下一跳推荐', async () => {
    const host = await boot()
    try {
      host.ctx.tools.register(defineTool({
        name: 'scene_edit',
        description: 'stub scene_edit',
        parameters: { input: { type: 'json', required: true, description: 'in' } },
        output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        execute: async () => ({ status: 'ok' }),
      }))
      const init = valueOf<{ campaignId: string; recommendedNextTaskId?: string }>(await host.call('campaign_init', {
        tasks: [
          { taskId: 'dev-complex', sceneId: 'scene-dev-2', partition: 'dev', goal: { and: [{ kind: 'settled' }, { kind: 'contact-exists' }, { kind: 'no-penetration' }] } },
          { taskId: 'dev-simple', sceneId: 'scene-dev-1', partition: 'dev', goal: { kind: 'settled' } },
          { taskId: 'held-final', sceneId: 'scene-held-1', partition: 'heldout', goal: { kind: 'settled' } },
        ],
        budget: BUDGET,
      }))
      // 1) Curriculum 推荐优先最简 dev 任务（dev-simple 1 个原子 < dev-complex 3 个原子）
      expect(init.recommendedNextTaskId).toBe('dev-simple')

      // 2) worker 在 dev-simple 上运行时，尝试用 scene_edit 修改 heldout 的 scene-held-1 → 被分区守卫拦截
      await host.call('campaign_transition', { campaignId: init.campaignId, taskId: 'dev-simple', to: 'exploring' })
      const contaminate = await host.call('scene_edit', { sceneId: 'scene-held-1' })
      expect(errorOf(contaminate)).toContain('CAMPAIGN_PARTITION_VIOLATION')
    } finally {
      await host.close()
    }
  })
})


test('场景准备工具复用原生 Jobs 与 campaign 留痕', async () => {
  const host = await boot()
  try {
    await host.ctx.plugin(Timer)
    await host.ctx.plugin(Jobs)
    await host.ctx.plugin(ToolJobs, { completionDelivery: 'quiet' })
    // 替换离线算法进程。工具、Job、结果回收和 campaign 都走真实宿主。
    host.ctx.reflect.provide('subprocess', { spawn(spec: { argv: readonly string[]; cwd: string }) {
      expect(spec.argv[1]?.endsWith('/prepare_simfoundry_usd.py')).toBe(true)
      mkdirSync(join(spec.cwd, 'usd'))
      writeFileSync(join(spec.cwd, 'usd', 'asset.usd'), 'fixture')
      writeFileSync(join(spec.cwd, 'result.json'), JSON.stringify({ rootUsd: 'usd/asset.usd', summary: { mass: 0.25 } }))
      return { done: Promise.resolve({ exitCode: 0 }) }
    } } as never)
    writeFileSync(join(workDir, 'object.glb'), 'fixture input')
    applyOfflineSceneWorkflows(host.ctx, { offlineUsdPython: process.execPath })
    for (const name of ['asset_prepare_usd', 'nurec_evaluate', 'lab_mimic_run', 'simfoundry_match_poses']) {
      expect(host.ctx.tools.get(name)).toBeDefined()
    }
    const capabilities = await host.ctx.tools.execute({ name: 'scene_workflow_capabilities', arguments: {}, callId: ToolCallId('offline-capabilities'), signal: AbortSignal.timeout(5000), agent: host.agent })
    expect(valueOf<{ workflows: unknown[] }>(capabilities).workflows).toContainEqual({ tool: 'asset_prepare_usd', interpreter: true })
    expect(valueOf<{ workflows: unknown[] }>(capabilities).workflows).toContainEqual({ tool: 'nurec_evaluate', interpreter: false })
    const campaignId = 'offline-tools'
    valueOf(await host.call('campaign_init', { campaignId, tasks: TASKS, budget: BUDGET }))
    valueOf(await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'exploring', role: 'worker' }))
    const input = { sourcePath: 'object.glb', upAxis: 'y', scale: 0.1, massKg: 0.25, collision: 'convexHull' }
    const started = valueOf<{ jobId: string; outputDir: string }>(await host.call('asset_prepare_usd', input))
    const settled = await host.ctx.jobs.wait(JobId(started.jobId), 5_000, host.agent.id)
    expect(settled.status).toBe('completed')
    const output = valueOf<{ text: string }>(await host.ctx.tools.execute({ name: 'job_output', arguments: { job_id: started.jobId }, callId: ToolCallId('offline-output'), signal: AbortSignal.timeout(5000), agent: host.agent }))
    expect(JSON.parse(output.text)).toMatchObject({ outputDir: started.outputDir, usdPath: join(started.outputDir, 'usd', 'asset.usd'), summary: { mass: 0.25 } })
    const missingRuntime = await host.call('nurec_evaluate', { stagePath: 'scene.usdz', referenceDir: 'refs', camera: 'cam' })
    expect(missingRuntime.isError && missingRuntime.error.message).toContain('OFFLINE_RUNTIME_UNAVAILABLE')
    valueOf(await host.call('campaign_record_run', { campaignId, taskId: 'dev-1', role: 'worker', summary: { outcome: 'success' } }))
    const runs = campaignOf(campaignId).tasks[0]!.workerRunIds
    expect(runs).toHaveLength(1)
    const calls = readFileSync(join(workDir, '.lyapunov', 'campaigns', campaignId, 'runs', runs[0]!, 'calls.jsonl'), 'utf8')
    expect(calls).toContain('asset_prepare_usd')
    expect(calls).toContain('job_output')
    expect(calls).toContain('OFFLINE_RUNTIME_UNAVAILABLE')
  } finally { await host.close() }
})
