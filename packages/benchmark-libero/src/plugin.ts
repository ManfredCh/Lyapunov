import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { benchmarkToolParameters } from './tool-schema.ts'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '../../sim-contract/src/index.ts'
import { requireSessionId } from '../../lyapunov-contracts/src/session-scope.ts'
import { SessionSimFactory } from '../../sim-contract/src/session-provider.ts'
import { BenchmarkAdapter, type AdapterConfig } from './operations.ts'

export const name = 'lyapunov-benchmark-libero'
export const inject = ['tools', 'commands']
export type Config = AdapterConfig

function lossless(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(item => item === undefined ? null : lossless(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, lossless(item)]))
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('BENCHMARK_OUTPUT_NOT_FINITE')
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return value
  throw new Error('BENCHMARK_OUTPUT_NOT_JSON')
}

/**
 * Commit the exact official agentview as a durable attachment when the
 * optional attachment service is mounted. This enriches only the tool-result
 * content; official success/evaluator fields remain untouched.
 */
async function attachAgentview(ctx: Context, value: unknown): Promise<any> {
  if (!value || typeof value !== 'object') return value
  const result = value as any
  const path = result.observation?.agentviewPath
  const attachments = ctx.get('attachments')
  if (!attachments || typeof path !== 'string' || !existsSync(path)) return value
  const data = await readFile(path)
  const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: 'agentview.png' })
  return { ...result, __agentviewAttachment: ref }
}

function renderToolValue(toolName: string, value: any): ContentBlock[] {
  if (toolName !== 'bench_result' || !value?.__agentviewAttachment) {
    return [{ type: 'text', text: JSON.stringify(value) }]
  }
  const { __agentviewAttachment: attachment, ...visible } = value
  return [
    { type: 'text', text: JSON.stringify(visible) },
    { type: 'image', attachment },
  ]
}

const descriptions: Record<string, string> = {
  bench_catalog: "List official suite task IDs and language instructions, without solution action sequences.",
  bench_prepare: "Check the official SDK in the isolated directory. Return BLOCKED when it is missing; never fabricate success.",
  bench_load: "Load a task using official reset and set_init_state as the single currently active world.",
  bench_step: "Execute official controller actions through env.step in the active world. Success comes only from check_success/done/horizon.",
  bench_result: "Read the current episode's official terminal state and receipt.",
  bench_close: "Close the current official suite world and release the SDK.",
  bench_run_suite: "For each task in the official catalog, run bench_load/step/result/close until termination. Do not inject solution actions.",
}

export function apply(ctx: Context, config: Config = {}) {
  if (ctx.get('sim')) throw new Error('同一 realm 只能启用一个模拟 Provider；请先关闭旧 Provider')
  // 每会话一个官方套件适配器实例（各自一个官方 SDK worker 进程）：一个会话的 episode、
  // 代次与取消不落到别人的 bench_result/bench_step 上。适配器配置（解释器/隔离根/协议）仍是共享的不可变依赖。
  const sim = new SessionSimFactory({ create: sessionId => new BenchmarkAdapter({ ...config, sessionId }) })
  ctx.reflect.provide('sim', sim)
  // 自动载入是 Host 级引导：它没有模型回合，归属会话只能由装配方显式给出；缺了就明确失败，
  // 不把这份 episode 塞进某个"默认"实例（那等于所有会话共享一个世界）。
  if (config.autoload) {
    const sessionId = config.autoload.sessionId?.trim()
    if (!sessionId) throw new Error('BENCHMARK_AUTOLOAD_SESSION_REQUIRED: config.autoload 必须给出 sessionId —— 没有模型回合可推断归属，拒绝落到共享实例')
    void (sim.forSession(sessionId) as BenchmarkAdapter).startAutoload(config.autoload)
  }
  const systemPrompt = ctx.get('systemPrompt') as { context?: (input: { name: string; order: number; text: () => string }) => unknown } | undefined
  systemPrompt?.context?.({
    name: 'lyapunov-benchmark-agent-loop',
    order: 8470,
    text: () => `Benchmark Agent loop：先 bench_prepare→bench_catalog→bench_load；每轮读取 bench_result 的当前 Frame（EEF、夹爪、对象 world position、placementRegions 和官方图像），再决定动作。Frame 的 entities 已是官方模型的真实投影：official-robot 实体带真实关节名/角度（其余实体是各官方对象 body 的世界位姿），sensors 挂在 official-robot 上；bench_result 的 projection 会给出实体清单与 frame 对齐状态，status=UNAVAILABLE 表示只有视觉降级、物理仍是官方环境。使用最新 worldId/expectedGeneration 和任务声明的动作 kind/units/bounds。任务成功只接受官方 check_success；动作结束、几何接近和视觉猜测都不能覆盖 evaluator。
LIBERO 当前前三维是 world-frame Cartesian delta 的归一化输入 [-1,1]，每次更新的尺度为 0.05 m。位移的符号始终是 targetEEFPositionM - eefPositionM；toEefPositionM 已是 object world position - EEF world position，不要再次旋转、反号或使用 rawToEefPositionM。不要仅按方向输出 ±1。可用 valuesXYZ = clamp(剩余位移 / (0.05 × stepCount), -1, 1)，每次最多 3 步；距目标小于 3 cm 时只走 1 步并减小幅度。每次 bench_step 后必须重新 bench_result，误差增大时先重读目标与当前坐标，不通过反复轴向探针猜坐标系。
抓取时先在物体上方对准 XY，再下降，使 EEF 位于物体中心上方约 1–2 cm；水平误差约 1 cm 才闭合。闭合后读夹爪间隙，短距离抬升并确认物体随 EEF 移动；未抓稳不得开始搬运。持物时每轮保留实际 offset = objectPositionM - eefPositionM，目标 EEF = desiredObjectPositionM - offset，不把 EEF 直接移到物体目标中心。
放置目标使用 Provider 声明的 placementRegions，优先读取当前 Frame 中 worldPose（worldId/generation/stepIndex 必须匹配），不能固定初始容器位置或猜它与 body 原点重合。先把持物中心抬到目标区域顶部以上并留出物体尺寸余量，保持高度完成水平对齐，再垂直下降到区域内部后打开夹爪。用 geometry.halfExtentsM 和 quaternion 判断区域边界；没有区域几何时明确缺失，不虚构常数。容器发生移动或碰撞时重新定位；持物滑脱则停止搬运并重新抓取。释放后立即读取 evaluator，再处理下一物体。
不使用 Bash、源码或 subagent 代替当前 benchmark 的观测与控制；不要反复探测已声明的动作轴。预算耗尽、官方终态或不可恢复失败时 bench_close，保留真实失败结果。`,
  })
  // 插件退出必须等待适配器真正释放（worker 回收、世界关闭）：cordis 只在 disposer
  // 返回 promise 时才 await；`void sim.dispose()` 会让卸载先于进程回收完成。
  ctx.effect(() => () => sim.dispose())
  // Tool/Command 的取消信号按 dsh-tools 执行契约（forward exec.signal 并等到静止）一路传到
  // step/load/runSuite：取消请求由此到达运行时，而不是被工具层丢弃。
  /** 官方套件的操作只认本次调用的会话：取不到会话时明确失败，并说清是哪个操作。 */
  const worldOf = (agent: unknown, label: string): BenchmarkAdapter => sim.forSession(requireSessionId(agent, label)) as BenchmarkAdapter
  // 每个操作按**发起它的会话**取自己的适配器（同一个 agent 推出来的会话键）；没有会话就明确失败。
  const operations: Record<string, (input: any, signal?: AbortSignal, agent?: unknown) => Promise<unknown> | unknown> = {
    bench_catalog: (input, _signal, agent) => worldOf(agent, 'bench_catalog 无法归属会话').catalog(input ?? {}),
    bench_prepare: (_input, _signal, agent) => worldOf(agent, 'bench_prepare 无法归属会话').prepare(),
    bench_load: (input, signal, agent) => worldOf(agent, 'bench_load 无法归属会话').load(input ?? {}, signal),
    bench_step: (input, signal, agent) => worldOf(agent, 'bench_step 无法归属会话').step(input, signal),
    bench_result: (input, _signal, agent) => worldOf(agent, 'bench_result 无法归属会话').result(input ?? {}),
    bench_close: async (input, _signal, agent) => { await worldOf(agent, 'bench_close 无法归属会话').close(input.worldId); return { status: 'closed', worldId: input.worldId } },
    bench_run_suite: (input, signal, agent) => worldOf(agent, 'bench_run_suite 无法归属会话').runSuite(input ?? {}, signal),
  }
  // 官方世界只通知发起会话切换视口；其它会话不得从全局world列表自动认领它。
  const revealLoadedWorld = async (value: any, execution: any) => {
    if (!value?.worldId || !value?.sceneId || !execution?.agent || !ctx.tools.get('ui_action', execution.agent)) return
    const result = await ctx.tools.execute({ name: 'ui_action', arguments: { input: { action: 'selectScene', sceneId: value.sceneId } }, callId: ToolCallId('benchmark-view-' + crypto.randomUUID()), agent: execution.agent, signal: execution.signal })
    if (result.isError) console.warn('官方世界已载入，但会话视口选择未排队')
  }
  for (const [toolName, operation] of Object.entries(operations)) {
    ctx.tools.register(defineTool({
      name: toolName,
      description: descriptions[toolName]!,
      parameters: benchmarkToolParameters[toolName]!,
      output: { schema: { type: 'json' }, render: (_args: unknown, value: unknown) => renderToolValue(toolName, value) },
      execute: async (args: any, exec: any) => {
        const value = await operation(args.input ?? {}, exec.signal, exec.agent)
        if (toolName === 'bench_load') await revealLoadedWorld(value, exec)
        return lossless(toolName === 'bench_result' ? await attachAgentview(ctx, value) : value)
      },
    }))
    ctx.commands.register({
      name: toolName,
      description: descriptions[toolName]!,
      input: { hint: "Official suite arguments as JSON." },
      handler: async (invocation: any) => {
        try {
          const value = await operation(JSON.parse(invocation.rawInput || '{}'), invocation.signal, invocation.agent)
          if (toolName === 'bench_load') await revealLoadedWorld(value, invocation)
          return { kind: 'success' as const, text: JSON.stringify(lossless(value)) }
        } catch (error) {
          return { kind: 'error' as const, text: error instanceof Error ? error.message : String(error) }
        }
      },
    })
  }
}
