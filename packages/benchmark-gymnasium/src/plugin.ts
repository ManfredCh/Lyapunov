import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'
import { requireSessionId } from '../../lyapunov-contracts/src/session-scope.ts'
import { SessionSimFactory } from '../../sim-contract/src/session-provider.ts'
import { GymnasiumAntAdapter, type GymnasiumAdapterConfig } from './adapter.ts'

export const name = 'lyapunov-benchmark-gymnasium'
export const inject = ['tools', 'commands']
export type Config = GymnasiumAdapterConfig

const integer = (description: string) => ({ type: 'integer', description })
const text = (description: string) => ({ type: 'string', description })
const required = (value: any) => ({ ...value, required: true })
const input = (properties: Record<string, unknown>, description: string) => ({ input: required({ type: 'object', properties, additionalProperties: false, description }) })
const schemas: Record<string, any> = {
  bench_prepare: {},
  bench_catalog: {},
  bench_load: input({ taskId: text("Only the official Gymnasium task Ant-v5 is accepted."), seed: integer("Optional reset seed."), worldId: text("Optional world ID.") }, "Create an official Ant-v5 episode."),
  bench_step: input({ worldId: required(text("worldId returned by bench_load.")), actionId: required(text("Unique action ID.")), expectedGeneration: required(integer("worldGeneration returned by bench_load.")), values: required({ type: 'array', items: { type: 'number' }, description: "An 8-dimensional torque vector in [-1,1]; the field name is values." }), stepCount: integer("Positive integer control-step count; defaults to 1.") }, "Execute torque through the official env.step."),
  bench_result: input({ worldId: text("Optional current world ID.") }, "Read the official observation, reward, and termination."),
  bench_close: input({ worldId: required(text("worldId to close.")) }, "Close the episode."),
  bench_run_suite: {},
}

function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => item === undefined ? null : clean(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, clean(v)]))
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('GYMNASIUM_OUTPUT_NOT_FINITE')
  return value
}

const descriptions: Record<string, string> = {
  bench_prepare: "Check the isolated Gymnasium[mujoco] SDK. Return BLOCKED when it is missing; never fabricate benchmark success.",
  bench_catalog: "List the official Gymnasium Ant-v5 action, observation, and evaluator contract.",
  bench_load: "Create the single episode through official gymnasium.make(\"Ant-v5\") and reset(seed).",
  bench_step: "Advance through official env.step(torque). Record only the official reward/terminated/truncated results; Ant-v5 has no binary success criterion.",
  bench_result: "Read the current official observation, cumulative return, terminal state, and episode-record path.",
  bench_close: "Close and normally release the official episode; return its terminal state, cumulative return, recording, and trajectory records.",
  bench_run_suite: "Run a zero-action availability baseline to termination and persist its records. This does not demonstrate that an Agent solved the task.",
}

export function apply(ctx: Context, config: Config = {}) {
  if (ctx.get('sim')) throw new Error('同一 realm 只能启用一个模拟 Provider')
  // 每会话一个官方 Gymnasium 适配器实例（各自一个官方 SDK worker 进程）：同一 Host 下两个会话
  // 各自持有自己的 episode/代次/取消，互不覆盖。适配器配置（解释器/隔离根）仍是共享依赖。
  const sim = new SessionSimFactory({ create: () => new GymnasiumAntAdapter(config) })
  ctx.reflect.provide('sim', sim)
  // Tool/Command 的取消信号按 dsh-tools 执行契约（forward exec.signal 并等到静止）一路传到
  // step/load/runSuite：取消请求由此到达运行时，而不是被工具层丢弃。
  /** 操作只认本次调用的会话：取不到会话明确失败，并说清是哪个操作。 */
  const adapterOf = (agent: unknown, label: string): GymnasiumAntAdapter => sim.forSession(requireSessionId(agent, label)) as GymnasiumAntAdapter
  const ops: Record<string, (input: any, signal?: AbortSignal, agent?: unknown) => Promise<unknown> | unknown> = {
    bench_prepare: (_input, _signal, agent) => adapterOf(agent, 'bench_prepare 无法归属会话').prepare(),
    bench_catalog: (_input, _signal, agent) => adapterOf(agent, 'bench_catalog 无法归属会话').catalog(),
    bench_load: (input, signal, agent) => adapterOf(agent, 'bench_load 无法归属会话').load(input ?? {}, signal),
    bench_step: (input, signal, agent) => adapterOf(agent, 'bench_step 无法归属会话').step(input, signal),
    bench_result: (input, _signal, agent) => adapterOf(agent, 'bench_result 无法归属会话').result(input ?? {}),
    bench_close: (input, _signal, agent) => adapterOf(agent, 'bench_close 无法归属会话').release(input.worldId),
    bench_run_suite: (_input, signal, agent) => adapterOf(agent, 'bench_run_suite 无法归属会话').runSuite(signal),
  }
  for (const [toolName, operation] of Object.entries(ops)) {
    ctx.tools.register(defineTool({ name: toolName, description: descriptions[toolName]!, parameters: schemas[toolName]!, output: { schema: { type: 'json' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(clean(value)) }] }, execute: async (args: any, exec: any) => clean(await operation(args.input ?? {}, exec.signal, exec.agent)) as any }))
    ctx.commands.register({
      name: toolName,
      description: descriptions[toolName]!,
      input: { hint: "Gymnasium benchmark arguments as JSON." },
      handler: async (invocation: any) => {
        try {
          const result = await operation(JSON.parse(invocation.rawInput || '{}'), invocation.signal, invocation.agent)
          return { kind: 'success' as const, text: JSON.stringify(clean(result)) }
        } catch (error) {
          return { kind: 'error' as const, text: error instanceof Error ? error.message : String(error) }
        }
      },
    })
  }
  // 插件退出必须等待适配器真正释放（worker 回收、世界关闭）：cordis 只在 disposer
  // 返回 promise 时才 await；`void sim.dispose()` 会让卸载先于进程回收完成。
  ctx.effect(() => () => sim.dispose())
}
