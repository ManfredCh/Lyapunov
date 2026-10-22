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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createHash } from 'node:crypto'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter } from '../../../.upstream/deepseek-harness-20260911-candidate/packages/core/agent-loop/tests/mock-adapter.ts'
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

async function boot() {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(CommandRuntime)
    ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
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
