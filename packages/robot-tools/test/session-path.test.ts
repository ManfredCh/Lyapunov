/**
 * L380：路径参数**缺失/非字符串/空白**时必须是结构化回执，不能漏原生内部 TypeError。
 *
 * 真机证据（.runtime/lane-dev003c/replay-B.jsonl / iso-B.jsonl 的 `crossOpen`）——命令桥
 * `POST /api/lyapunov/command {name:'scene_open', input:{sceneId:'…'}}` 回 body
 * `{"error":"The \"path\" argument must be of type string. Received undefined"}`：`isAbsolute(undefined)`
 * 的原生 TypeError 直接漏成回执。本文件盯 `packages/robot-tools/src/output-path.ts` 这一半
 * （`sessionPath` 的薄层判据 + 同一条解析在真实 Command 面上的表现）；
 * `scene-kit` 那一半（`scene_open`/`scene_save` 命令桥）见
 * `packages/scene-kit/test/scene-open-path-argument.test.ts`。
 *
 * 负对照要求：消息里带 label、**不带 `/`**（不反吐任何文件系统路径）。
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
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionSimFactory } from '../../sim-contract/src/session-provider.ts'
import { apply } from '../src/plugin.ts'
import { sessionPath } from '../src/output-path.ts'

const scoped = (cwd: string) => ({ agent: { session: { header: { cwd } } } })

/** 结构化：以 ROBOT_ 前缀的错误码开头（不是 Node 的 `The "path" argument…`）。 */
function invalidFrom(run: () => unknown, label: string): string {
  let thrown: unknown
  try { run() } catch (error) { thrown = error }
  assert.ok(thrown instanceof Error, `${label} 必须抛 Error（不是放行/不是裸字符串）`)
  assert.match(thrown.message, /^ROBOT_PATH_INVALID: /, `${label} 必须是结构化错误码：${thrown.message}`)
  assert.ok(thrown.message.includes(label), `${label} 的消息必须点名 label：${thrown.message}`)
  assert.ok(!thrown.message.includes('/'), `${label} 的消息不得含文件系统路径分隔符：${thrown.message}`)
  assert.ok(!/argument must be of type string/.test(thrown.message), `${label} 漏了原生 TypeError 文案：${thrown.message}`)
  return thrown.message
}

describe('sessionPath：参数缺失/非字符串/空白 → 结构化错误（不带路径）', () => {
  test('undefined（必填参数没给）报 ROBOT_PATH_INVALID，消息含 label、不含 `/`', () => {
    const message = invalidFrom(() => sessionPath(undefined, undefined as never, 'path'), 'path')
    assert.match(message, /收到 undefined/)
  })

  test('null / 数字 / 布尔 / 对象 / 数组一律同样报错（逐个都用 string 值逃不掉）', () => {
    for (const value of [null, 7, true, { path: '/abs/frames' }, ['/abs/frames']]) {
      invalidFrom(() => sessionPath(scoped('/work/session'), value as never, 'outputDir'), 'outputDir')
    }
  })

  test('空字符串与纯空白（含制表/换行）同样被拒：不落到 isAbsolute/resolve', () => {
    for (const value of ['', ' ', '   ', '\t', '\n', ' \t\n ']) {
      const message = invalidFrom(() => sessionPath(scoped('/work/session'), value, 'path'), 'path')
      assert.match(message, /收到 /)
    }
  })

  test('校验先于会话 cwd：没有会话工作目录时，缺失参数报的是 PATH_INVALID 而不是 CWD_UNRESOLVED', () => {
    invalidFrom(() => sessionPath(undefined, undefined as never, 'path'), 'path')
    assert.throws(() => sessionPath(undefined, 'derived/frames', 'outputDir'), /ROBOT_CWD_UNRESOLVED/)
  })

  test('正例零变化：绝对路径原样返回、相对路径按会话 cwd 解析、file: 不是本函数的绝对路径', () => {
    const scope = scoped('/work/session')
    assert.equal(sessionPath(scope, '/abs/frames', 'outputDir'), '/abs/frames')
    assert.equal(sessionPath(scope, 'derived/frames', 'outputDir'), resolve('/work/session/derived/frames'))
    assert.equal(sessionPath(scope, './derived/./frames', 'outputDir'), resolve('/work/session/derived/frames'))
    // 带空白的路径是**合法字符串**：不做 trim 改写（既有行为：原样交给 resolve）。
    assert.equal(sessionPath(scope, ' derived/frames ', 'outputDir'), resolve('/work/session/ derived/frames '))
    assert.equal(sessionPath(scope, 'file:///a/b', 'outputDir'), resolve('/work/session/file:/a/b'), 'file: URI 在本模块本来就不是"绝对路径"（既有行为，未改）')
  })
})

/**
 * 真实 Command 面（与真机 `POST /api/lyapunov/command` 同一条 invoke）：命令桥不过工具 schema，
 * 参数缺失/类型不对以前会一路走到 `isAbsolute()` 漏原生 TypeError。探针 sim 在解析失败时**根本不该被调用**。
 */
describe('真实 Command 面：缺 outputDir 类型/值不落盘、报结构化错误', () => {
  async function harness(): Promise<{ call: (line: string) => Promise<{ kind: string; text: string }>; outputDirs: unknown[]; close: () => Promise<void> }> {
    const ctx = new Context()
    await ctx.plugin(Timer)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Commands)
    const outputDirs: unknown[] = []
    const probe = {
      capture: async (_worldId: string, options: Record<string, unknown>) => { outputDirs.push(options.outputDir); return {} },
      captureMulti: async (_worldId: string, options: Record<string, unknown>) => { outputDirs.push(options.outputDir); return { worldId: _worldId, captureId: 'probe', stepIndex: 0, cameras: [] } },
      exportCameraDataset: async (_worldId: string, options: Record<string, unknown>) => { outputDirs.push(options.outputDir); return {} },
      listWorlds: async () => [],
    }
    ctx.reflect.provide('sim', new SessionSimFactory({ create: () => ({ ...probe }) as never }) as never)
    ctx.reflect.provide('scene', { forSession: () => ({ scene: { snapshot: async () => ({}), commit: async () => ({}) } }) } as never)
    await ctx.plugin({ name: 'test-robot-tools-path-invalid', inject: ['tools', 'commands', 'scene', 'sim'], apply: (scopedCtx: Context) => { apply(scopedCtx) } } as never, undefined as never)
    const loop = await mountAgentLoopTestHarness(ctx)
    const workspace = await mkdtemp(join(tmpdir(), 'robot-tools-path-invalid-'))
    const agent = await loop.create(SessionId('robot-tools-path-invalid'), {}, { cwd: workspace })
    return {
      outputDirs,
      async call(line) {
        const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
        if (!execution) throw new Error('命令没有解析成功：' + line)
        return execution.result as { kind: string; text: string }
      },
      async close() { await ctx.fiber.dispose().catch(() => undefined); await rm(workspace, { recursive: true, force: true }) },
    }
  }

  test('outputDir 给了数字：按既有纪律原样透传（sessionPath 根本不接手非字符串）、不落盘、也不漏原生 TypeError', async () => {
    const h = await harness()
    try {
      const command = await h.call('/camera_capture_multi {"worldId":"world-1","outputDir":7,"cameraNames":["probe_cam"]}')
      // `resolveCallerOutputDir` 的既有纪律（output-path.ts:50）：只对 typeof === 'string' 的 outputDir 做会话解析，
      // 类型不对留给原 schema/operation 自己判——命令桥没有 schema，于是模拟服务照旧收到那个数字。
      assert.equal(command.kind, 'success')
      assert.doesNotMatch(command.text, /argument must be of type string/)
      assert.equal(h.outputDirs.length, 1, '透传不等于放行非法路径：仍然只调用一次采集')
      assert.equal(h.outputDirs[0], 7)
    } finally { await h.close() }
  })

  test('outputDir 给了空串：命令报 ROBOT_PATH_INVALID（不是原生 TypeError），且不调用 SimService', async () => {
    const h = await harness()
    try {
      const command = await h.call('/camera_capture_multi {"worldId":"world-1","outputDir":"","cameraNames":["probe_cam"]}')
      assert.equal(command.kind, 'error')
      assert.match(command.text, /ROBOT_PATH_INVALID/)
      assert.doesNotMatch(command.text, /argument must be of type string/)
      assert.equal(h.outputDirs.length, 0, '解析失败不允许发生任何采集调用')
    } finally { await h.close() }
  })
})
