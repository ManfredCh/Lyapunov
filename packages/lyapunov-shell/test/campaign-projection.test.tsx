/**
 * campaign 会话投影（`src/campaign-projection.ts`）+ 面板卡片（`src/campaign-panel.tsx`）。
 *
 * 真实 Cordis 装配（与产品同一契约）：agent-graph 插件 + `sessionProjections` 注册表 +
 * 真实 Agent/Session（header.cwd = tmpdir）。驱动真 `ctx.tools.execute` 走完整
 * tools/result 管线，断言：
 *   1. `campaign_init`/`campaign_status` 回执自带完整 campaign → 直接落卡；
 *   2. `campaign_transition` 增量回执 → 投影自补一次 `campaign_status` 读数后落整卡
 *      （`settle()` 是本观察者异步补读数的唯一等待点）；
 *   3. 具名拒绝 → 同一 campaign 卡片 `lastError` 如实记录错误码，状态不回退猜中间态；
 *   4. 面板渲染 task 状态矩阵 + `used/max` 预算条（token 类名，不硬编码颜色）。
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter } from '../../../.upstream/deepseek-harness-20260911-candidate/packages/core/agent-loop/tests/mock-adapter.ts'
import * as agentGraphPlugin from '@lyapunov/agent-graph/plugin'
import {
  applyCampaignProjection,
  campaignCardOf,
  campaignIdOf,
  campaignsOf,
  foldCampaigns,
  initCampaigns,
  type CampaignCard,
  type CampaignsProjection,
} from '../src/campaign-projection.ts'
import { budgetMetersOf, CampaignsPanel } from '../src/campaign-panel.tsx'
import type { Campaign } from '../../lyapunov-contracts/src/agent-graph.ts'

const BUDGET = { maxToolCalls: 100, maxSimSteps: 10000, maxWallSeconds: 3600 }
const TASKS = [
  { taskId: 'dev-1', sceneId: 'scene-1', partition: 'dev', goal: { kind: 'contact-exists' } },
  { taskId: 'held-1', sceneId: 'scene-1', partition: 'heldout', goal: { kind: 'settled' } },
]
const tr = (zh: string, en: string) => zh

async function boot() {
  const workDir = mkdtempSync(join(tmpdir(), 'lyapunov-campaign-shell-'))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(CommandRuntime)
    ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
    // 真实插件装载：inject(tools/commands) 缺服务时这一步就失败。
    await ctx.plugin(agentGraphPlugin)
    const projection = applyCampaignProjection(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    const createAgent = (id: string, cwd: string) => harness.create(SessionId(id), { provider: 'mock', model: 'mock' }, { cwd })
    const agent = await createAgent('session-a', workDir)
    let seq = 0
    const call = (name: string, input: unknown, owner: Agent = agent) =>
      ctx.tools.execute({ name, arguments: { input }, callId: ToolCallId(`campaign-shell-${++seq}`), signal: AbortSignal.timeout(10_000), agent: owner })
    /** tools/result 观察是异步补读数：等到卡片满足谓词或如实超时。 */
    const waitCard = async (predicate: (card: CampaignCard) => boolean, campaignId: string): Promise<CampaignCard> => {
      const deadline = Date.now() + 5_000
      for (;;) {
        await projection.settle()
        const card = projection.stateOf(agent.session)?.campaigns.find(row => row.campaignId === campaignId)
        if (card !== undefined && predicate(card)) return card
        if (Date.now() > deadline) throw new Error(`campaign 投影未等到目标卡片状态：${JSON.stringify(card ?? null)}`)
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    }
    return {
      ctx, agent, call, waitCard, projection, createAgent,
      close: async () => { await ctx.fiber.dispose(); rmSync(workDir, { recursive: true, force: true }) },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    rmSync(workDir, { recursive: true, force: true })
    throw error
  }
}

function cardFixture(over: Partial<CampaignCard> = {}): CampaignCard {
  return {
    campaignId: 'campaign-fixture',
    createdAt: '2026-10-15T00:00:00.000Z',
    status: 'running',
    tasks: [
      { taskId: 'dev-1', sceneId: 'scene-1', partition: 'dev', status: 'done' },
      { taskId: 'held-1', sceneId: 'scene-1', partition: 'heldout', status: 'blocked', blockedReason: 'verifier unavailable' },
    ],
    budget: BUDGET,
    used: { toolCalls: 7, simSteps: 120, startedAt: '2026-10-15T00:00:00.000Z' },
    openRunIds: [],
    ...over,
  }
}

describe('campaign 投影：真实 ctx 装配下的 tools/result → sessionProjection', () => {
  test('init/status 回执直接落整卡；transition 增量回执经补读数落卡；拒绝写 lastError', async () => {
    const host = await boot()
    try {
      const initResult = await host.call('campaign_init', { tasks: TASKS, budget: BUDGET })
      expect(initResult.isError).toBe(false)
      const campaignId = (initResult.value as { campaignId: string }).campaignId
      const card = await host.waitCard(row => row.campaignId === campaignId, campaignId)
      expect(card.tasks.map(task => task.status)).toEqual(['pending', 'pending'])
      expect(card.used.toolCalls).toBe(0)
      expect(card.openRunIds).toEqual([])
      // 会话日志里真的有这张卡（ignorable 事件，回放可重建投影）。
      expect(host.agent.session.snapshotEvents().some(event => event.type === 'lyapunov/campaign-state')).toBe(true)
      // 状态矩阵正确折叠：transition 回执不含 campaign，投影必须靠补发的读数得到完整卡。
      const transition = await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'exploring' })
      expect(transition.isError).toBe(false)
      const runId = (transition.value as { runId: string }).runId
      const moved = await host.waitCard(row => row.tasks[0]?.status === 'exploring' && row.openRunIds.length === 1, campaignId)
      expect(moved.openRunIds).toEqual([runId])
      expect(moved.tasks[1]?.status).toBe('pending')
      expect(moved.lastError).toBeUndefined()
      // 具名拒绝：pending→done 非法，卡片状态不动、lastError 如实记录错误码。
      const denied = await host.call('campaign_transition', { campaignId, taskId: 'dev-1', to: 'done' })
      expect(denied.isError).toBe(true)
      const refused = await host.waitCard(row => row.lastError !== undefined, campaignId)
      expect(refused.lastError).toContain('CAMPAIGN_ILLEGAL_TRANSITION')
      expect(refused.tasks[0]?.status).toBe('exploring')
      // 成功读数清掉 lastError。
      await host.call('campaign_status', { campaignId })
      const cleared = await host.waitCard(row => row.lastError === undefined && row.openRunIds.length === 1, campaignId)
      expect(cleared.tasks[0]?.status).toBe('exploring')
    } finally {
      await host.close()
    }
  })

  test('别的会话不共享投影状态；无 agent 的调用不被观察', async () => {
    const host = await boot()
    try {
      const initResult = await host.call('campaign_init', { tasks: TASKS, budget: BUDGET })
      const campaignId = (initResult.value as { campaignId: string }).campaignId
      await host.waitCard(row => row.campaignId === campaignId, campaignId)
      const otherCwd = mkdtempSync(join(tmpdir(), 'lyapunov-campaign-shell-b-'))
      const other = await host.createAgent('session-b', otherCwd)
      try {
        // session-b 没有任何 campaign 回执 → 它的投影是空表。
        expect(campaignsOf(host.ctx, other.session)?.campaigns).toEqual([])
        expect(campaignsOf(host.ctx, host.agent.session)?.campaigns).toHaveLength(1)
      } finally {
        rmSync(otherCwd, { recursive: true, force: true })
      }
    } finally {
      await host.close()
    }
  })
})

describe('fold/init/cardOf 纯函数面', () => {
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('session-unit'), createdAt: 0, cwd: '/tmp', isSeeded: false }
  test('init 空表；campaign-state 按 campaignId 整卡替换；别的事件不动状态', () => {
    const init = initCampaigns(header)
    expect(init).toEqual({ sessionId: 'session-unit', campaigns: [] })
    const card = cardFixture()
    const event = (seq: number, data: CampaignCard): SessionEvent<'lyapunov/campaign-state'> => ({ type: 'lyapunov/campaign-state', seq: SessionSeq(seq), time: 0, data, ignorable: true })
    const appended = foldCampaigns(init, event(1, card))
    expect(appended.campaigns).toEqual([card])
    const updated = foldCampaigns(appended, event(2, cardFixture({ status: 'completed' })))
    expect(updated.campaigns).toHaveLength(1)
    expect(updated.campaigns[0]?.status).toBe('completed')
    const untouched = foldCampaigns(updated, { type: 'session/end-seed', seq: SessionSeq(3), time: 0, data: {} })
    expect(untouched).toBe(updated)
  })

  test('campaignCardOf 只留展示字段：goal 谓词与 workerRunIds 不进卡', () => {
    const campaign: Campaign = {
      campaignId: 'c-1', createdAt: 't0', status: 'running',
      tasks: [{ taskId: 't-1', sceneId: 's-1', partition: 'dev', status: 'exploring', goal: { kind: 'contact-exists' }, workerRunIds: ['run-1'] }],
      budget: BUDGET, used: { toolCalls: 3, simSteps: 9, startedAt: 't0' },
    }
    const card = campaignCardOf(campaign, ['run-1'])
    expect(card).toEqual({
      campaignId: 'c-1', createdAt: 't0', status: 'running',
      tasks: [{ taskId: 't-1', sceneId: 's-1', partition: 'dev', status: 'exploring' }],
      budget: BUDGET, used: { toolCalls: 3, simSteps: 9, startedAt: 't0' },
      openRunIds: ['run-1'],
    })
    expect(JSON.stringify(card)).not.toContain('workerRunIds')
    expect(campaignIdOf({ input: { campaignId: 'c-1' } })).toBe('c-1')
    expect(campaignIdOf({ campaignId: 'c-2' })).toBe('c-2')
    expect(campaignIdOf({ input: { other: 1 } })).toBeUndefined()
  })
})

describe('campaign 面板卡片', () => {
  test('矩阵 + 预算条：任务状态徽标、used/max 读数、heldout 徽标都在标记里', () => {
    const card = cardFixture()
    const markup = renderToStaticMarkup(<CampaignsPanel campaigns={[card]} tr={tr} now={Date.parse('2026-10-15T00:01:00.000Z')}/>)
    expect(markup).toContain('campaign-fixture')
    expect(markup).toContain('dev-1')
    expect(markup).toContain('held-1')
    expect(markup).toContain('完成')
    expect(markup).toContain('受阻')
    expect(markup).toContain('留出')
    expect(markup).toContain('verifier unavailable')
    expect(markup).toContain('7 / 100')
    expect(markup).toContain('120 / 10000')
    expect(markup).toContain('60s / 3600s')
    expect(markup).toContain('lya-badge-ok')
    expect(markup).toContain('lya-warning')
    // 颜色一律走 token，不出现硬编码色值。
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).toContain('var(--lya-')
  })

  test('预算越界标 --lya-bad、不设上限不出用量条；空表给如实空态', () => {
    const over = cardFixture({ used: { toolCalls: 100, simSteps: 120, startedAt: '2026-10-15T00:00:00.000Z' } })
    const meters = budgetMetersOf(over, tr, Date.parse('2026-10-15T00:00:30.000Z'))
    expect(meters.find(meter => meter.key === 'toolCalls')?.exhausted).toBe(true)
    expect(meters.find(meter => meter.key === 'wall')?.used).toBe(30)
    const markup = renderToStaticMarkup(<CampaignsPanel campaigns={[over]} tr={tr} now={Date.parse('2026-10-15T00:00:30.000Z')}/>)
    expect(markup).toContain('var(--lya-bad)')
    const unlimited = cardFixture({ budget: { maxToolCalls: 0, maxSimSteps: 0, maxWallSeconds: 0 } })
    expect(budgetMetersOf(unlimited, tr, 0).every(meter => meter.fraction === null)).toBe(true)
    expect(renderToStaticMarkup(<CampaignsPanel campaigns={[]} tr={tr}/>)).toContain('还没有 campaign')
  })

  test('lastError 如实渲染在卡片上', () => {
    const markup = renderToStaticMarkup(<CampaignsPanel campaigns={[cardFixture({ lastError: 'CAMPAIGN_ILLEGAL_TRANSITION: x' })]} tr={tr}/>)
    expect(markup).toContain('CAMPAIGN_ILLEGAL_TRANSITION: x')
    expect(markup).toContain('最近拒绝')
  })
})
