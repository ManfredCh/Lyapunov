import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ENGINE_CHOICES, type EngineChoice } from './engine-preference.ts'

export type DeveloperConfig = {
  mode: 'developer'
  surface: 'web' | 'sdk' | 'headless' | 'acp'
  /** 省略＝跟随共享解析（`engine-preference.ts` 的 `resolveEngine`）；写了就是用户覆盖。 */
  engine?: EngineChoice
  grasp: 'none' | 'analytic' | 'graspgenx' | 'anygrasp'
  port: number
  runtimeRoot: string
  auth: { required: boolean; accountFile: string }
  route: { provider: string; model: string; reasoningEffort: string }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  return value as Record<string, unknown>
}

function scalar(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必须是非空字符串`)
  return value.trim()
}

function oneOf<T extends string>(value: unknown, label: string, values: readonly T[]): T {
  const result = scalar(value, label)
  if (!values.includes(result as T)) throw new Error(`${label} 无效：${result}`)
  return result as T
}

function integer(value: unknown, label: string): number {
  const result = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(result) || result < 0 || result > 65_535) throw new Error(`${label} 必须是 0–65535 的整数`)
  return result
}

/** 开发者配置只允许两层标量；使用这个小解析器让启动器不依赖已安装的上游包。 */
function parseDeveloperYaml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  let section: Record<string, unknown> | undefined
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue
    if (/\t/.test(raw)) throw new Error(`开发者 YAML 第 ${index + 1} 行不能使用 Tab 缩进`)
    const match = /^( {0,2})([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/.exec(raw)
    if (!match) throw new Error(`开发者 YAML 第 ${index + 1} 行格式无效`)
    const indent = match[1]!.length
    const key = match[2]!
    const rawValue = (match[3] ?? '').replace(/[ \t]+#.*$/, '').trim()
    if (indent === 0) {
      if (!rawValue) { section = {}; root[key] = section }
      else root[key] = parseScalar(rawValue)
    } else if (indent === 2 && section) {
      if (!rawValue) throw new Error(`开发者 YAML 第 ${index + 1} 行不允许更深层对象`)
      section[key] = parseScalar(rawValue)
    } else throw new Error(`开发者 YAML 第 ${index + 1} 行缩进无效`)
  }
  return root
}

function parseScalar(value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?(?:0|[1-9][0-9]*)$/.test(value)) return Number(value)
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1)
  return value
}

export async function loadDeveloperConfig(path: string): Promise<DeveloperConfig> {
  const file = resolve(path)
  const root = parseDeveloperYaml(await readFile(file, 'utf8'))
  const auth = objectValue(root.auth ?? {}, 'auth')
  const route = objectValue(root.route ?? {}, 'route')
  return {
    mode: oneOf(root.mode ?? 'developer', 'mode', ['developer']),
    surface: oneOf(root.surface ?? 'web', 'surface', ['web', 'sdk', 'headless', 'acp']),
    // 缺省不再填一个固定引擎：省略这一行才跟随"Isaac 优先／未就绪回退 MuJoCo"的产品默认。
    engine: root.engine === undefined ? undefined : oneOf(root.engine, 'engine', ENGINE_CHOICES),
    grasp: oneOf(root.grasp ?? 'analytic', 'grasp', ['none', 'analytic', 'graspgenx', 'anygrasp']),
    port: integer(root.port ?? 4180, 'port'), // 0 = 操作系统随机分配
    runtimeRoot: scalar(root.runtime_root ?? 'runtime/developer', 'runtime_root'),
    auth: {
      required: auth.required === undefined ? true : Boolean(auth.required),
      accountFile: scalar(auth.account_file ?? '~/.config/lyapunov/developer-account.json', 'auth.account_file'),
    },
    route: {
      provider: scalar(route.provider ?? 'deepseek-official', 'route.provider'),
      model: scalar(route.model ?? 'deepseek-v4-flash-vision-exp', 'route.model'),
      reasoningEffort: scalar(route.reasoning_effort ?? 'max', 'route.reasoning_effort'),
    },
  }
}
