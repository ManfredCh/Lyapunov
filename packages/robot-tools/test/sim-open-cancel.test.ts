/**
 * `sim_open` 的取消接线测试（91_isaac_startup_lifecycle，载体按联合候选改写）：**真实 ToolRegistry /
 * CommandRegistry** → 真实 robot-tools 插件 → 真实 Provider → 真实子进程传输。
 *
 * 不 mock 注册表、不 mock Provider，也不 mock 传输：只有“引擎进程”本身由 `sim-contract/test/fixtures/
 * fake-worker.py` 顶替（真实 Kit 冷启动分钟级、且 83 那次挂起无法按需复现），它只实现行协议，
 * 因此本文件证明的是**接线与生命周期**：调用方的 `exec.signal`（用户取消）真的走到了 worker 启动，
 * 取消结束的是“本次尚未交付的 open”，并且不会自动重启。
 *
 * **载体改写（联合候选的范围）**：110 原文件用 `IsaacProvider` 当载体。本候选按任务要求把 Isaac adapter
 * 钉在 113 版本（后续真 Kit 验收仍基于它），而 113 版的 `IsaacProvider.open` 不接收/不转发取消信号、
 * 也没有显式启动预算——所以以 Isaac 为载体的用例在此**无法成立**，它们改用同一个工具面 + **真 MuJoCoProvider**
 * + 同一个假 worker：被验的仍是「工具面 signal → Provider → 传输层 → 子进程」这条链，而这正是本候选的
 * 验收引擎。Isaac 载体上的两条（`kit-app-start` 归因的启动期取消、`IsaacConfig.startupBudgetMs` 显式预算）
 * 登记为缺口，待 Isaac adapter 合入后恢复；传输层的预算语义本身由 `sim-contract/test/startup-lifecycle.test.ts`
 * 的假 worker 用例覆盖。
 *
 * 它不证明任何引擎的物理/渲染行为，也不替代真实 Kit / 真实 MuJoCo 复核（真实 MuJoCo 的取消与清场见
 * 110 任务 `evidence/mujoco-cancel-probe.ts`）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Commands from '@deepseek-ai/dsh-commands'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {} from '../../sim-contract/src/index.ts'
import { SessionSimFactory } from '../../sim-contract/src/session-provider.ts'
import { MuJoCoProvider } from '../../sim-mujoco/src/provider.ts'
import * as scenePlugin from '../../scene-kit/src/plugin.ts'
import * as robotTools from '../src/plugin.ts'

const FAKE_WORKER = new URL('../../sim-contract/test/fixtures/fake-worker.py', import.meta.url).pathname
const PYTHON = ['/usr/bin/python3', '/usr/local/bin/python3', '/bin/python3'].find(candidate => existsSync(candidate))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/** 用真实 MuJoCoProvider 挂 `sim` 服务（一个 worker 复用多个 world）；引擎进程同样换成假 worker。
 *  装配口径与产品 `sim-mujoco` 插件一致：`sim` 是**按会话映射的工厂**（一个会话一个 provider 实例/worker），
 *  不是裸 provider —— 工具面取世界服务只按会话取（`simWorldsFor`），缺会话即明确失败。 */
function simWithFakeMuJoCoWorker() {
  return {
    name: 'test-sim-mujoco-fake-worker',
    apply(ctx: Context) {
      if (ctx.get('sim')) throw new Error('同一 realm 只能启用一个模拟 Provider')
      const sim = new SessionSimFactory({ create: () => new MuJoCoProvider({ pythonPath: PYTHON!, workerPath: FAKE_WORKER }) })
      ctx.reflect.provide('sim', sim)
      ctx.effect(() => () => sim.dispose())
    },
  }
}

/** 本文件的会话 id（= `agent.session.header.id`，也就是世界服务的归属键）。 */
const SESSION_ID = 'sim-open-cancel', MUJOCO_SESSION_ID = 'sim-open-cancel-mujoco'

/**
 * 该会话**已经存在**的 provider 实例：`ctx.get('sim')` 现在拿到的是按会话映射的工厂（不是实例）。
 * 只读取证 —— 实例还不存在（该会话还没调用过世界服务）时返回 undefined，绝不替它起一个 worker。
 */
function instanceOf(target: Context, sessionId: string): { lifecyclePhases(): { name: string }[] } | undefined {
  const sim = target.get('sim') as unknown as { has(key: string): boolean; forSession(key: string): { lifecyclePhases(): { name: string }[] } }
  return sim.has(sessionId) ? sim.forSession(sessionId) : undefined
}

let base: string, ctx: Context, agent: Agent, calls = 0, marker: string
const savedEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'lyapunov-sim-open-cancel-'))
  calls = 0
  marker = join(base, 'marker.log')
  closeSync(openSync(marker, 'a'))
  for (const key of ['FAKE_SCENARIO', 'FAKE_MARKER']) savedEnv[key] = process.env[key]
  process.env.FAKE_MARKER = marker
  process.env.FAKE_SCENARIO = scenario({ ready: 'never', phases: true, stderr: 'FAKE_KIT_STDERR 停在 carb 初始化' })
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Sessions)
  await ctx.plugin(Commands)
  await ctx.plugin(scenePlugin, { dataRoot: join(base, 'data') })
  // 载体是候选里的真 MuJoCoProvider；引擎进程由假 worker 顶替（scenario/marker 经 env 传入）。
  await ctx.plugin(simWithFakeMuJoCoWorker())
  await ctx.plugin(robotTools)
  const session = ctx.sessions.create(SessionId(SESSION_ID))
  agent = { id: session.id, session } as Agent
})

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  await rm(base, { recursive: true, force: true })
})

function scenario(plan: Record<string, unknown>): string {
  const path = join(base, 'scenario.json')
  writeFileSync(path, JSON.stringify(plan))
  return path
}

const markerText = () => readFileSync(marker, 'utf8')
const startedPids = () => [...markerText().matchAll(/started pid=(\d+)/g)].map(match => Number(match[1]))

async function until(check: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`等待超时：${what}`)
}

/**
 * **传输层自己的**阶段轨迹（候选里 MuJoCoProvider 既是 Provider 也是传输层，一个 worker 服务多个 world）。
 * 取消的时序必须同步在传输层状态上：只看假 worker 的 marker 文件会有竞态——marker 先落盘、那一行还没被
 * 传输层解析，取消就会被归因到更早的阶段（实测在机器有负载时偶发：marker 里已有 `phase kit-app-start`，
 * 传输层轨迹只有 `spawned`）。这里只读它的阶段轨迹做取证，不写任何状态。
 */
function transportPhases(): string[] {
  return instanceOf(ctx, SESSION_ID)?.lifecyclePhases().map(phase => phase.name) ?? []
}

async function callTool(name: string, input: unknown, signal: AbortSignal): Promise<ToolExecutionResult> {
  return await ctx.tools.execute({ callId: ToolCallId(`${name}-${++calls}`), name, arguments: { input }, signal, agent })
}

/** 真实场景（临时 dataRoot 上的 SceneStore）：sim_open 要读的是真 Scene 文档，不是测试造的替身。 */
async function newScene(sceneId: string): Promise<string> {
  const created = await callTool('scene_create', { sceneId }, new AbortController().signal)
  if (created.isError) throw new Error(`创建夹具场景失败：${created.error.message}`)
  return (created.value as { sceneId: string }).sceneId
}

describe.skipIf(PYTHON === undefined)('sim_open 的取消接线（真实 ToolRegistry → 真 MuJoCoProvider → 假 worker 子进程）', () => {
  test('正常路径：sim_open 返回世界句柄，signal 形参不影响既有调用', async () => {
    process.env.FAKE_SCENARIO = scenario({ ready: 'ok', phases: true })
    const sceneId = await newScene('scene-open-ok')
    const result = await callTool('sim_open', { sceneId, options: { worldId: 'world-91' } }, new AbortController().signal)
    if (result.isError) throw new Error(`期望成功：${result.error.message}`)
    const handle = result.value as { worldId: string; sceneId: string; status: string }
    expect(handle.worldId).toBe('world-91')
    expect(handle.sceneId).toBe('fake')
    // 世界真的登记在同一 Provider 上：world list 里能看到它（不是只回了一个句柄）。
    const listed = await callTool('sim_world_list', {}, new AbortController().signal)
    expect((listed.value as Array<{ worldId: string }>).map(world => world.worldId)).toEqual(['world-91'])
    expect(await callTool('sim_close', { worldId: 'world-91' }, new AbortController().signal).then(value => value.isError)).toBe(false)
  }, 20_000)

  test('启动中显式取消：结束本次尚未 ready 的 sim_open，给出阶段/pid/stderr 摘要，且不自动重启', async () => {
    const sceneId = await newScene('scene-open-cancel')
    const controller = new AbortController()
    // 工具调用排入真实派发后才取消：这正是用户对着一个卡住的 Kit 启动按取消的时序。
    const pending = callTool('sim_open', { sceneId, options: { worldId: 'world-cancel' } }, controller.signal)
    // 等**传输层**已记到 kit-app-start 再取消：下面断言的是“取消发生在哪一阶段”的归因，用 marker 文件
    // 同步会偶发失败（marker 已落盘、传输层还没解析那一行，报错里的最后阶段就会更早）。
    await until(() => transportPhases().includes('kit-app-start'), '传输层已记到 kit-app-start 阶段（取消前必须确有阶段事实）')
    const [pid] = startedPids()
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('期望失败')
    expect(result.error.message).toContain('PROVIDER_START_CANCELLED')
    expect(result.error.message).toContain(`pid=${pid}`)
    expect(result.error.message).toContain('kit-app-start')
    expect(result.error.message).toContain('阶段轨迹=')
    expect(result.error.message).toContain('FAKE_KIT_STDERR')
    // 本次尚未 ready 的操作可靠结束：自己的子进程真的没了（不留孤儿、不留悬空 Promise）。
    await until(() => !alive(pid!), '被取消的 worker 子进程退出')
    // 取消不触发任何自动重启：没有任何新进程被派生。
    expect(startedPids()).toEqual([pid])
    // 只有显式新 open 才是重启入口。
    process.env.FAKE_SCENARIO = scenario({ ready: 'ok', phases: true })
    const restarted = await callTool('sim_open', { sceneId, options: { worldId: 'world-after-cancel' } }, new AbortController().signal)
    if (restarted.isError) throw new Error(`期望显式重开成功：${restarted.error.message}`)
    expect((restarted.value as { worldId: string }).worldId).toBe('world-after-cancel')
    expect(startedPids().length).toBe(2)
  }, 20_000)

  test('命令面取消（HTTP 桥同一条路径）：调用方立刻拿到取消，本次尚未 ready 的 worker 同样被结束', async () => {
    const sceneId = await newScene('scene-open-command')
    const controller = new AbortController()
    const pending = ctx.commands.execute(agent, `/sim_open ${JSON.stringify({ sceneId, options: { worldId: 'world-command' } })}`, [], controller.signal)
    await until(() => transportPhases().includes('kit-app-start'), '传输层已记到 kit-app-start 阶段（本次取消发生在真实的启动期）')
    const [pid] = startedPids()
    controller.abort(new Error('用户取消'))
    const failure = await pending.then(() => undefined, (error: Error) => error)
    expect(failure?.message).toContain('用户取消')
    // 命令面拿到的是调用方自己的取消原因；本次尚未 ready 的子进程仍必须按归属结束。
    await until(() => !alive(pid!), '被取消的 worker 子进程退出')
    expect(startedPids()).toEqual([pid])
  }, 20_000)
})

/**
 * MuJoCo 走的是**同一个 worker 多个 world** 的形态：`sim_open` 的取消必须只结束本次 open。
 * 这里仍然只用假 worker 顶替引擎进程（真实 MuJoCo 的一次性验证在 110 任务的
 * `evidence/mujoco-cancel-probe.ts`），证明的是「工具面 signal → 真 MuJoCoProvider → 真传输层」
 * 这条链与清场可达性（普通 `sim_world_list` 轮询不能把取消的世界留在列表里）。
 */
describe.skipIf(PYTHON === undefined)('MuJoCo sim_open 的取消接线（同一个 worker 多 world）', () => {
  test('取消第二个 world 的 sim_open：工具面拿到取消，已交付的 world 仍在列表里，取消的世界被清掉', async () => {
    process.env.FAKE_SCENARIO = scenario({ ready: 'ok', phases: true, openDelayByWorld: { 'world-b': 700 } })
    const mujoco = new Context()
    await mujoco.plugin(SystemPrompt); await mujoco.plugin(Tools); await mujoco.plugin(Sessions); await mujoco.plugin(Commands)
    await mujoco.plugin(scenePlugin, { dataRoot: join(base, 'data-mujoco') })
    await mujoco.plugin(simWithFakeMuJoCoWorker())
    await mujoco.plugin(robotTools)
    const mujocoAgent = { id: SessionId(MUJOCO_SESSION_ID), session: mujoco.sessions.create(SessionId(MUJOCO_SESSION_ID)) } as unknown as Agent
    const call = (name: string, input: unknown, signal: AbortSignal) => mujoco.tools.execute({ callId: ToolCallId(`${name}-mujoco-${++calls}`), name, arguments: { input }, signal, agent: mujocoAgent })
    const created = await call('scene_create', { sceneId: 'scene-mujoco-cancel' }, new AbortController().signal)
    if (created.isError) throw new Error(`创建夹具场景失败：${created.error.message}`)
    const sceneId = (created.value as { sceneId: string }).sceneId
    // 阶段轨迹按该会话自己的实例读（实例在第一次取世界服务时才建，所以这里每次现读）。
    const phases = () => instanceOf(mujoco, MUJOCO_SESSION_ID)?.lifecyclePhases().map(phase => phase.name) ?? []
    const worldList = async () => {
      const listed = await call('sim_world_list', {}, new AbortController().signal)
      if (listed.isError) throw new Error(`列世界失败：${listed.error.message}`)
      return (listed.value as Array<{ worldId: string }>).map(world => world.worldId).sort()
    }

    const first = await call('sim_open', { sceneId, options: { worldId: 'world-a' } }, new AbortController().signal)
    if (first.isError) throw new Error(`第一个 open 应当成功：${first.error.message}`)
    expect(await worldList()).toEqual(['world-a'])

    const controller = new AbortController()
    const pending = call('sim_open', { sceneId, options: { worldId: 'world-b' } }, controller.signal)
    await until(() => phases().includes('opening-world-b'), '传输层已记到 world-b 的 open 阶段')
    const [pid] = startedPids()
    const cancelledAt = Date.now()
    controller.abort()
    const failure = await pending
    expect(failure.isError).toBe(true)
    if (!failure.isError) throw new Error('期望取消失败')
    expect(failure.error.message).toContain('PROVIDER_START_CANCELLED')
    expect(failure.error.message).toContain('阶段轨迹=')
    expect(Date.now() - cancelledAt).toBeLessThan(400)
    // 取消只结束本次 open：同一个 worker 上已交付的 world-a 还在，取消的 world-b 被就地清掉
    // （worker 自己的世界表就是列表来源，所以这里等价于「没有孤儿」）。
    await until(() => markerText().includes('closed world-b'), 'worker 收到了对取消世界的 close')
    expect(await worldList()).toEqual(['world-a'])
    expect(startedPids()).toEqual([pid])
    await call('sim_close', { worldId: 'world-a' }, new AbortController().signal)
  }, 20_000)
})

if (PYTHON === undefined) test('缺少系统 python3', () => { throw new Error('本机没有可用的 python3，取消接线测试无法运行') })
