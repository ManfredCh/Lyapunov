import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { TerminalStartupConfig } from '../packages/lyapunov-terminal/src/startup.ts'
import { ENGINE_CHOICES, isEngineChoice, resolveEngine, type EngineChoice, type EngineSource } from './engine-preference.ts'
import { PRODUCT_ROOT } from './profile.ts'

export interface TerminalOptions {
  help: boolean
  mode?: 'formal' | 'developer'
  attach?: string
  token?: string
  runtimeRoot?: string
  /** 只有显式 --engine 时才出现；未给时选项对象保持原有形状（本地终端默认不装配仿真）。 */
  engine?: EngineChoice
  /** 只有显式 --fullscreen 时才出现，未给时选项对象保持原有形状。 */
  fullscreen?: boolean
  startup: TerminalStartupConfig
}

/**
 * 终端本次要装配的引擎与它的**来源**。
 *
 * 终端自己不维护引擎表与优先级：取值与合法性都用 `engine-preference.ts` 的既有键与既有解析。
 */
export interface TerminalEngine { engine: EngineChoice; source: '--engine' | 'LYAPUNOV_SIM_ENGINE' | 'preference' | 'default' }

/**
 * owner 的来源标签 → 终端对外的来源标签（终端对外沿用既有四个字符串，不改调用方契约）。
 */
const TERMINAL_SOURCE: Record<EngineSource, TerminalEngine['source']> = { explicit: '--engine', environment: 'LYAPUNOV_SIM_ENGINE', preference: 'preference', default: 'default' }

/**
 * 终端引擎解析：**整条优先级复用唯一 owner** `resolveEngine()`
 * （显式 `--engine` > `LYAPUNOV_SIM_ENGINE` > 用户偏好文件 > `defaultEngine()`）。
 *
 * 终端与启动器的**唯一**差别在最后一级，而且那是入口语义、不是第二份实现：交互终端不替用户
 * 拉起仿真 Provider（Isaac 还占 GPU），所以当 owner 说"没有任何配置来源"（`source === 'default'`）时，
 * 终端取 `none`＝本次不装配。这条由 `script/terminal.ts` 的帮助文本与
 * `packages/sim-isaac/test/engine-selection-consistency.test.ts` 逐字声明。
 *
 * 此前这里自己重写了一整条链：与 launch/arch/desktop 的口径分叉，并且把
 * `LYAPUNOV_SIM_ENGINE=""`（旧入口用 `||` 跳过、owner 也当未配置）误判成非法值直接抛错。
 * 现在三层的取值、合法性与非法值拒绝都只有 owner 一处。
 */
export function terminalEngineChoice(explicit: EngineChoice | undefined, env: NodeJS.ProcessEnv = process.env, productRoot: string = PRODUCT_ROOT): TerminalEngine {
  const selection = resolveEngine({ explicit, env, productRoot })
  if (selection.source === 'default') return { engine: 'none', source: 'default' }
  return { engine: selection.engine, source: TERMINAL_SOURCE[selection.source] }
}

/** 与旧线程入口一致：显式项目从调用者 PWD 解析，未给项目则沿用实际 cwd。 */
export function terminalProjectDirectory(project: string | undefined, cwd: string, pwd?: string): string {
  const canonical = (path: string) => {
    const absolute = resolve(path)
    try { return realpathSync(absolute) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absolute
      throw error
    }
  }
  return project === undefined ? canonical(cwd) : canonical(isAbsolute(project) ? project : resolve(canonical(pwd ?? cwd), project))
}

/** 非 TTY 的完整输入位于显式 --prompt 之前，保留原始换行。 */
export function mergeTerminalPrompt(piped: string | undefined, prompt: string | undefined): string | undefined {
  if (!prompt) return piped
  if (!piped) return prompt
  return piped + '\n' + prompt
}

/** 启动参数只生成临时配置，不修改 Profile、默认模型或 Session。 */
export function parseTerminalOptions(args: string[], environment: { cwd: string; pwd?: string }): TerminalOptions {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: {
      cwd: { type: 'string' }, resume: { type: 'string' }, 'runtime-root': { type: 'string' },
      attach: { type: 'string' }, token: { type: 'string' },
      mode: { type: 'string' },
      model: { type: 'string', short: 'm' }, continue: { type: 'boolean', short: 'c' },
      session: { type: 'string', short: 's' }, fork: { type: 'boolean' }, prompt: { type: 'string' },
      engine: { type: 'string' },
      fullscreen: { type: 'boolean' },
      agent: { type: 'string' }, 'prompt-mode': { type: 'string' }, 'reasoning-effort': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) return { help: true, startup: {} }
  if (values.mode !== undefined && values.mode !== 'formal' && values.mode !== 'developer') throw new Error('--mode 只接受 formal 或 developer。')
  if (values.attach && values.mode !== undefined) throw new Error('--attach 使用远端 Host 的身份，不接受本地 --mode。')
  if (values.attach !== undefined && !values.attach.trim()) throw new Error('--attach URL 不能为空。')
  // 引擎在 Host 启动时就装配进 Provider，远端 Host 不可能被本地参数换掉：
  // 接受它会变成"本地参数生效了"的谎报，所以直接拒绝，让调用方去改远端 Host 的启动参数。
  if (values.attach && values.engine !== undefined) throw new Error('--attach 连接现成Host，不接受本地 --engine；远端引擎由远端 Host 自己决定。')
  if (values.engine !== undefined && !isEngineChoice(values.engine)) throw new Error(`--engine 只接受 ${ENGINE_CHOICES.join('|')}。`)
  if (positionals.length > 1) throw new Error('终端启动只接受一个项目目录。')
  const project = positionals[0]
  const explicitCwd = values.cwd === undefined ? undefined : values.attach ? values.cwd : terminalProjectDirectory(values.cwd, environment.cwd)
  const positionalCwd = project === undefined ? undefined : values.attach ? project : terminalProjectDirectory(project, environment.cwd, environment.pwd)
  if (explicitCwd !== undefined && positionalCwd !== undefined && explicitCwd !== positionalCwd) throw new Error('[project] 与 --cwd 指向不同目录。')
  if (values.session !== undefined && values.resume !== undefined && values.session !== values.resume) throw new Error('--session 与 --resume 必须指向同一会话。')
  const sessionId = values.session ?? values.resume
  if (sessionId !== undefined && !sessionId.trim()) throw new Error('会话 ID 不能为空。')
  if (values.fork && !sessionId && !values.continue) throw new Error('--fork 需要 --continue、--session 或 --resume。')
  if (values['prompt-mode'] !== undefined && values['prompt-mode'] !== 'send' && values['prompt-mode'] !== 'prefill') throw new Error('--prompt-mode 只接受 send 或 prefill。')
  let route: Pick<TerminalStartupConfig, 'provider' | 'model'> = {}
  if (values.model !== undefined) {
    const slash = values.model.indexOf('/')
    if (slash <= 0 || slash === values.model.length - 1) throw new Error('--model 格式为 provider/model。')
    route = { provider: values.model.slice(0, slash), model: values.model.slice(slash + 1) }
  }
  if (values.agent !== undefined && !values.agent.trim()) throw new Error('--agent 不能为空。')
  if (values['reasoning-effort'] !== undefined && !values['reasoning-effort'].trim()) throw new Error('--reasoning-effort 不能为空。')
  if (values.attach && values['runtime-root']) throw new Error('--attach 连接现成Host，不接受本地 --runtime-root。')
  if (values.token && !values.attach) throw new Error('--token 仅用于 --attach。')
  return {
    help: false,
    ...(values.fullscreen ? { fullscreen: true } : {}),
    ...(values.mode === undefined ? {} : { mode: values.mode }),
    ...(values.attach === undefined ? {} : { attach: values.attach }),
    ...(values.token === undefined ? {} : { token: values.token }),
    ...(values['runtime-root'] === undefined ? {} : { runtimeRoot: resolve(environment.cwd, values['runtime-root']) }),
    ...(values.engine === undefined ? {} : { engine: values.engine }),
    startup: {
      ...(values.attach ? (explicitCwd ?? positionalCwd ? { cwd: explicitCwd ?? positionalCwd } : {}) : { cwd: explicitCwd ?? positionalCwd ?? terminalProjectDirectory(undefined, environment.cwd, environment.pwd) }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(values.continue ? { continueLast: true } : {}),
      ...(values.fork ? { fork: true } : {}),
      ...route,
      ...(values.agent === undefined ? {} : { agentPreset: values.agent }),
      ...(values.prompt === undefined ? {} : { prompt: values.prompt }),
      ...(values['prompt-mode'] === undefined ? {} : { promptMode: values['prompt-mode'] }),
      ...(values['reasoning-effort'] === undefined ? {} : { reasoningEffort: values['reasoning-effort'] }),
    },
  }
}
