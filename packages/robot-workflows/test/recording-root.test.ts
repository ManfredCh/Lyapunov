/**
 * 录制根（`recordingRoot`）的越界判据：与采集工具的相对 `outputDir` 是**同一类缺陷**——
 * `recordingDirectory()` 里的 `resolve(root)` 会把相对根锚到**宿主进程 cwd**（产品安装根），
 * 用户录制就落进宿主根。录制根是宿主级配置、没有会话可作基准（不能拿会话 cwd 当口径），
 * 所以这里的修法是**明确拒绝相对根**，不静默回落。
 *
 * 走**真正的产品入口**（`packages/robot-workflows/src/plugin.ts` 的 `apply`，即 runtime-patch
 * 里 `add("robot-workflows", {recordingRoot})` 装的同一个插件），服务按它声明的 inject
 * （tools/commands/jobs/scene）给齐，再从 ToolRegistry / CommandRuntime 调：
 *   1. 相对 recordingRoot：Tool 与 Command 都明确报 RECORDING_ROOT_NOT_ABSOLUTE，
 *      并且**进程 cwd 下真的一个新目录都没有**（不写宿主根）；
 *   2. 绝对 recordingRoot：正常路径不受影响（空目录就是空录制列表，不是报错）。
 * scene 用最小探针：本文件只走录制根判据，不经过场景路径；探针不提供任何"读数"。
 *
 * 运行：bun test packages/robot-workflows/test/recording-root.test.ts
 * （node --test 走不了：`src/recording.ts` 用了 TS 参数属性，Node 24 的 strip-only 直接拒收。）
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Commands from '@deepseek-ai/dsh-commands'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as workflows from '../src/plugin.ts'

const INJECTED_SERVICES = ['tools', 'commands', 'jobs', 'scene'] as const

/** 装真正的产品插件；`recordingRoot` 就是 runtime-patch 传的那一项配置。 */
async function bootProductPlugin(recordingRoot: string | undefined) {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Commands)
  await ctx.plugin(LocalJobRegistry)
  // 场景服务只满足 inject 契约：本文件的判据发生在任何场景访问之前。
  ctx.reflect.provide('scene', { snapshot: async () => { throw new Error('SCENE_NOT_USED_IN_THIS_TEST') } } as never)
  const missing = INJECTED_SERVICES.filter(name => ctx.get(name) === undefined)
  assert.deepEqual(missing, [], `测试装配自己就缺服务：${missing.join(', ')}`)
  const fiber = await ctx.plugin(workflows, recordingRoot === undefined ? {} : { recordingRoot })
  assert.notEqual(ctx.tools.get('recording_list'), undefined, '插件必须真的装上（recording_list 在册）')
  const loop = await mountAgentLoopTestHarness(ctx)
  // CommandRuntime 要真实会话（命令要往会话里追加生命周期事件），所以用生产的真 Agent，不是替身。
  const agent = await loop.create(SessionId('recording-root-test'), {})
  return {
    async call(name: string, args: Record<string, unknown>) {
      const executed = await ctx.tools.execute({ callId: ToolCallId(`recording-root-test:${name}`), name, arguments: args, agent, signal: new AbortController().signal })
      return { isError: executed.isError === true, text: (executed.content ?? []).map((block: any) => block.text ?? '').join('\n') }
    },
    async command(line: string) {
      const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
      if (!execution) throw new Error('命令没有解析成功：' + line)
      return execution.result as { kind: string; text: string }
    },
    async close() { await fiber.dispose().catch(() => undefined); await ctx.fiber.dispose().catch(() => undefined) },
  }
}

describe('录制根的越界判据（相对根明确拒绝）', () => {
  test('相对 recordingRoot 由 Tool 与 Command 明确拒绝，且 cwd 下不新建任何目录', async () => {
    const hostCwd = await mkdtemp(join(tmpdir(), 'recording-root-host-cwd-'))
    const previous = process.cwd()
    process.chdir(hostCwd)
    const plugin = await bootProductPlugin('relative/recordings')
    try {
      const tool = await plugin.call('recording_list', { input: {} })
      assert.equal(tool.isError, true, '相对录制根必须失败：' + tool.text)
      assert.match(tool.text, /RECORDING_ROOT_NOT_ABSOLUTE/)
      const command = await plugin.command('/recording_list {"input":{}}')
      assert.equal(command.kind, 'error')
      assert.match(command.text, /RECORDING_ROOT_NOT_ABSOLUTE/)
      const stop = await plugin.call('recording_stop', { input: { recordingId: 'recording-probe' } })
      assert.equal(stop.isError, true)
      assert.match(stop.text, /RECORDING_ROOT_NOT_ABSOLUTE/)
      assert.deepEqual(await readdir(hostCwd), [], '拒绝之后宿主 cwd 下一个新路径都不该有')
    } finally {
      process.chdir(previous)
      await plugin.close()
      await rm(hostCwd, { recursive: true, force: true })
    }
  })

  test('绝对 recordingRoot 走原路径：空目录就是空录制列表，不报错', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recording-root-abs-'))
    const plugin = await bootProductPlugin(root)
    try {
      const tool = await plugin.call('recording_list', { input: {} })
      assert.equal(tool.isError, false, tool.text)
      assert.deepEqual(JSON.parse(tool.text), [])
      assert.deepEqual(await readdir(root), [], '只读列出不该凭空造目录')
      assert.equal(resolve(root), root)
    } finally {
      await plugin.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
