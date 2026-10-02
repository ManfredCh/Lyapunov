/**
 * 采集/导出工具 `outputDir` 的会话解析（70 §6.5 的真实缺陷：相对 outputDir 被 worker 按宿主进程 cwd
 * 解析，18 个帧文件写进产品根 `derived/`，会话 sandbox=workspace-write 全程 0 次审批）。
 *
 * 这里走**真实 ToolRegistry 与真实 Command 服务**（`@deepseek-ai/dsh-agent-loop-testkit` 建的生产
 * AgentLoop agent：真 Session / 真 Inbox），不是直接函数调用：
 *   1. 相对路径按**会话任务 cwd** 解析后才交给 SimService（探针 sim 记录它实际收到的 outputDir）；
 *   2. 绝对路径与被明确指定的目录**原样透传**（旧行为保持，回执不额外加字段）；
 *   3. 没有会话 cwd 时明确报 ROBOT_CWD_UNRESOLVED，且**根本不调用** SimService（不落宿主根）；
 *   4. Tool 与 Command 两个来源同一条解析。
 *
 * 运行：bun test packages/robot-tools/test/output-path.test.ts
 * （node --test 走不了：`sim-contract/src/index.ts` 用了 TS 参数属性，Node 24 的 strip-only 直接拒收。）
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Commands from '@deepseek-ai/dsh-commands'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionSimFactory } from '../../sim-contract/src/session-provider.ts'
import { SimError } from '../../sim-contract/src/index.ts'
import { publicCommandError } from '../../lyapunov-contracts/src/command-privacy.ts'
import { apply } from '../src/plugin.ts'
import { outputDirTools, resolveCallerOutputDir, sessionPath } from '../src/output-path.ts'

/** SimService 探针：只实现被这三个工具调到的入口，记录**实际收到**的 options。 */
interface SimCall { method: 'capture' | 'captureMulti' | 'exportCameraDataset'; worldId: string; options: Record<string, any> }

interface Harness {
  ctx: Context
  agent: Agent
  /** 没有会话 cwd 的会话（CLI/SDK 场景），用来证明缺 cwd 的判据。 */
  bareAgent: Agent
  calls: SimCall[]
  call(name: string, args: Record<string, unknown>, caller?: Agent): Promise<{ isError: boolean; value: any; text: string }>
  command(line: string, caller?: Agent): Promise<{ kind: string; text: string }>
  close(): Promise<void>
}

async function createHarness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await mountAgentLoopTestDependencies(ctx)
  // 插件的 inject 契约里有 commands（产品 Host 由 @deepseek-ai/dsh-commands 提供），缺它插件不会激活。
  await ctx.plugin(Commands)
  const calls: SimCall[] = []
  const rgb = (dir: string) => ({ uri: `file://${join(dir, 'frame.png')}`, mimeType: 'image/png' })
  const depth = (dir: string) => ({ uri: `file://${join(dir, 'frame-depth.npy')}`, mimeType: 'application/x-npy' })
  // 探针只回答被调到的入口；未实现的方法不造替身读数（调用即抛，测试里能看到）。
  const probe = {
    close: async () => { throw new SimError('WORLD_NOT_FOUND', 'worldId 不存在') },
    capture: async (worldId: string, options: Record<string, any>) => {
      calls.push({ method: 'capture', worldId, options })
      return { worldId, cameraName: options.cameraName ?? 'free', rgb: rgb(options.outputDir), depth: depth(options.outputDir), generation: 1, stepIndex: 7 }
    },
    captureMulti: async (worldId: string, options: Record<string, any>) => {
      calls.push({ method: 'captureMulti', worldId, options })
      return { worldId, captureId: 'capture-probe', stepIndex: 7, cameras: options.cameraNames.map((name: string) => ({ cameraName: name, rgb: rgb(options.outputDir), depth: depth(options.outputDir) })) }
    },
    exportCameraDataset: async (worldId: string, options: Record<string, any>) => {
      calls.push({ method: 'exportCameraDataset', worldId, options })
      return { worldId, datasetId: 'dataset-probe', directory: options.outputDir }
    },
    listWorlds: async () => [],
  }
  const sceneProbe = () => ({ scene: { snapshot: async (sceneId: string) => ({ sceneId, revision: 0, entities: [] }), commit: async () => ({ sceneId: 'probe', revision: 1, entities: [] }) } })
  // 世界服务按会话说事（产品装配一律是 `SessionSimFactory`）：探针本身按会话各建一份，`calls` 只做汇总。
  ctx.reflect.provide('sim', new SessionSimFactory({ create: () => ({ ...probe }) as never }) as never)
  // 场景服务同样按会话取（产品 `ctx.scene.forSession` 那一份规则）：探针按会话各给一份。
  ctx.reflect.provide('scene', { forSession: () => sceneProbe() } as never)
  // 产品插件按自己的 inject 契约装进来（tools/commands/scene/sim 全就位），不是测试自己塞注册表。
  await ctx.plugin({ name: 'test-robot-tools', inject: ['tools', 'commands', 'scene', 'sim'], apply: (scoped: Context) => { apply(scoped) } } as never, undefined as never)
  const loop = await mountAgentLoopTestHarness(ctx)
  const workspace = await mkdtemp(join(tmpdir(), 'robot-tools-output-path-'))
  const agent = await loop.create(SessionId('robot-tools-output-path'), {}, { cwd: workspace })
  const bareAgent = await loop.create(SessionId('robot-tools-output-path-bare'), {})
  // 失败结果（ToolExecutionFailure）没有 value：与 blender 测试同一口径，value 可选。
  const fields = (executed: { isError?: boolean; value?: unknown; content?: readonly any[] }) => ({
    isError: executed.isError === true,
    value: executed.value,
    text: (executed.content ?? []).map((block: any) => block.text ?? '').join('\n'),
  })
  return {
    ctx, agent, bareAgent, calls,
    async call(name, args, caller = agent) {
      return fields(await ctx.tools.execute({ callId: ToolCallId(`robot-tools-test:${name}`), name, arguments: args, agent: caller, signal: new AbortController().signal }))
    },
    async command(line, caller = agent) {
      const execution = await ctx.commands.execute(caller, line, [], new AbortController().signal)
      if (!execution) throw new Error('命令没有解析成功：' + line)
      return execution.result as { kind: string; text: string }
    },
    async close() { await ctx.fiber.dispose().catch(() => undefined); await rm(workspace, { recursive: true, force: true }) },
  }
}

describe('outputDir 的会话解析（薄层判据）', () => {
  test('相对路径 → 会话工作区；绝对路径原样；没有会话 cwd 明确报错', () => {
    assert.equal(sessionPath({ agent: { session: { header: { cwd: '/work/session' } } } }, 'derived/frames', 'outputDir'), resolve('/work/session/derived/frames'))
    assert.equal(sessionPath({ agent: { session: { header: { cwd: '/work/session' } } } }, '/abs/frames', 'outputDir'), '/abs/frames')
    assert.throws(() => sessionPath(undefined, 'derived/frames', 'outputDir'), /ROBOT_CWD_UNRESOLVED/)
    assert.throws(() => sessionPath({ agent: { session: { header: {} } } }, 'derived/frames', 'outputDir'), /ROBOT_CWD_UNRESOLVED/)
  })

  test('只有带 outputDir 的三个工具受影响；缺字段/类型不对留给原 schema', () => {
    assert.deepEqual([...outputDirTools], ['sensor_capture', 'camera_capture_multi', 'camera_dataset_export'])
    const scope = { agent: { session: { header: { cwd: '/work/session' } } } }
    assert.equal(resolveCallerOutputDir('camera_list', { outputDir: 'derived' }, scope).outputDir, undefined)
    assert.deepEqual(resolveCallerOutputDir('camera_capture_multi', { worldId: 'w' }, scope), { value: { worldId: 'w' } })
    assert.deepEqual(resolveCallerOutputDir('camera_capture_multi', { worldId: 'w', outputDir: 7 }, scope), { value: { worldId: 'w', outputDir: 7 } })
    const absolute = resolveCallerOutputDir('camera_capture_multi', { worldId: 'w', outputDir: '/abs/dir' }, scope)
    assert.equal(absolute.outputDir, undefined, '绝对路径不发生解析：入参原样、回执不加字段')
  })
})

describe('真实 ToolRegistry / Command 调用', () => {
  test('camera_capture_multi 相对 outputDir 落到会话 cwd（绝对路径才进 SimService）', async () => {
    const harness = await createHarness()
    try {
      const cwd = harness.agent.session.header.cwd!
      const call = await harness.call('camera_capture_multi', { input: { worldId: 'world-1', outputDir: 'derived/frames/before_push', cameraNames: ['probe_cam'] } })
      assert.equal(call.isError, false, call.text)
      assert.equal(harness.calls.length, 1)
      assert.equal(harness.calls[0]!.method, 'captureMulti')
      assert.equal(harness.calls[0]!.options.outputDir, join(cwd, 'derived/frames/before_push'))
      assert.equal(call.value.outputDir, join(cwd, 'derived/frames/before_push'), '回执回报的必须是真实落盘的绝对目录')
      assert.deepEqual(call.value.cameras.map((camera: any) => camera.cameraName), ['probe_cam'])
    } finally { await harness.close() }
  })

  test('sensor_capture / camera_dataset_export 走同一条解析；Command 与 Tool 一致', async () => {
    const harness = await createHarness()
    try {
      const cwd = harness.agent.session.header.cwd!
      const sensor = await harness.call('sensor_capture', { input: { worldId: 'world-1', outputDir: 'derived/sensor' } })
      assert.equal(sensor.isError, false, sensor.text)
      assert.equal(harness.calls[0]!.options.outputDir, join(cwd, 'derived/sensor'))
      const command = await harness.command(`/sensor_capture {"worldId":"world-1","outputDir":"derived/sensor-cmd"}`)
      assert.equal(command.kind, 'success', command.text)
      assert.equal(harness.calls[1]!.options.outputDir, join(cwd, 'derived/sensor-cmd'))
      assert.equal(JSON.parse(command.text).outputDir, join(cwd, 'derived/sensor-cmd'))
      const dataset = await harness.call('camera_dataset_export', { input: { worldId: 'world-1', outputDir: 'derived/dataset', captureIds: ['capture-probe'] } })
      assert.equal(dataset.isError, false, dataset.text)
      assert.equal(harness.calls[2]!.options.outputDir, join(cwd, 'derived/dataset'))
      assert.equal(dataset.value.outputDir, join(cwd, 'derived/dataset'))
    } finally { await harness.close() }
  })

  test('绝对 outputDir 与明确指定的捕获目录原样透传，回执不多字段', async () => {
    const harness = await createHarness()
    try {
      const explicit = '/tmp/robot-tools-explicit-capture-dir'
      const call = await harness.call('camera_capture_multi', { input: { worldId: 'world-1', outputDir: explicit, cameraNames: ['probe_cam'] } })
      assert.equal(call.isError, false, call.text)
      assert.equal(harness.calls[0]!.options.outputDir, explicit)
      assert.equal(Object.hasOwn(call.value, 'outputDir'), false, '没有发生解析就不加字段')
    } finally { await harness.close() }
  })

  test('没有会话 cwd 时明确报 ROBOT_CWD_UNRESOLVED，且不调用 SimService（不写宿主根）', async () => {
    const harness = await createHarness()
    try {
      const call = await harness.call('camera_capture_multi', { input: { worldId: 'world-1', outputDir: 'derived/frames', cameraNames: ['probe_cam'] } }, harness.bareAgent)
      assert.equal(call.isError, true, '无会话 cwd 的相对路径必须失败')
      assert.match(call.text, /ROBOT_CWD_UNRESOLVED/)
      assert.equal(harness.calls.length, 0, '解析失败不允许发生任何采集调用')
      const command = await harness.command('/camera_capture_multi {"worldId":"world-1","outputDir":"derived/frames","cameraNames":["probe_cam"]}', harness.bareAgent)
      assert.equal(command.kind, 'error')
      assert.match(command.text, /ROBOT_CWD_UNRESOLVED/)
      assert.equal(harness.calls.length, 0)
    } finally { await harness.close() }
  })
})

test('原生命令保留引擎结构化错误码，跨会话不存在的世界公开为 P404', async () => {
  const harness = await createHarness()
  try {
    const result=await harness.command('/sim_close {"worldId":"another-session-world"}')
    assert.equal(result.kind,'error')
    assert.equal(result.text,'WORLD_NOT_FOUND: worldId 不存在')
    assert.equal(publicCommandError(result.text).code,'P404')
  } finally { await harness.close() }
})
