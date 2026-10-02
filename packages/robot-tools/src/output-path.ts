import { isAbsolute, resolve } from 'node:path'

/** 工具执行上下文（ToolExecution）与命令调用（CommandInvocation）里取会话工作目录所需的最小形状。 */
export type SessionScope = { agent?: { session?: { header?: { cwd?: string } } } | undefined }

/**
 * 带 `outputDir` 的采集/导出工具：Provider 会在这个目录里落真实产物。
 * 只有这三个入口收调用方给的目录；其余机器人工具不收路径。
 */
export const outputDirTools = ['sensor_capture', 'camera_capture_multi', 'camera_dataset_export'] as const

/**
 * 报错里只说"收到了什么形状"，不把值本身写进去：值可能带着调用方自己的路径，回执不该反吐路径。
 * （`undefined`/`null`/`"  "` 逐字给出，其余只给类型名。）
 */
function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return value.trim() === '' ? JSON.stringify(value) : 'string'
  return typeof value
}

/**
 * 调用方给的相对目录 → 会话工作区绝对路径（与 bash/终端/scene_open/scene_import 同一事实：原生会话
 * header.cwd）。绝对路径原样透传；没有会话工作目录就明确报错，既不退回进程 cwd、也不逼调用方改用法。
 *
 * 为什么必须在这一层解析：worker 侧落盘是 `Path(outputDir).resolve()`，基准是**宿主进程 cwd**（产品安装根），
 * 模型给相对路径时 18 个帧文件会写进产品根 `derived/`（70 报告 §6.5 实测，会话 sandbox=workspace-write
 * 全程 0 次审批）。SimWorlds/Provider 不感知会话，也不改运行目录、不放宽沙箱：这里只把参数变成绝对路径。
 *
 * 参数本身缺失/类型不对/空白**必须在这里就报结构化错**：`isAbsolute(undefined)` 抛的是原生
 * `TypeError: The "path" argument must be of type string. Received undefined`（真机 CU 会话 B 的
 * `scene_open` 缺 path 就是这样漏出去的），那是实现细节不是回执。消息只带 label，不带任何路径。
 */
export function sessionPath(scope: SessionScope | undefined, value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`ROBOT_PATH_INVALID: ${label} 必须是非空字符串路径（收到 ${describeValue(value)}）；相对路径按当前会话的任务工作区解析`)
  if (isAbsolute(value)) return value
  const cwd = scope?.agent?.session?.header?.cwd
  if (!cwd) throw new Error(`ROBOT_CWD_UNRESOLVED: ${label} 是相对路径（${value}），但当前执行上下文没有会话工作目录；请传绝对路径`)
  return resolve(cwd, value)
}

/**
 * 把调用方入参里的 outputDir 解析成绝对路径再交给 operation。
 * 返回 `outputDir` 只在**真的发生了改写**时给出（相对路径被解析）——绝对路径与明确给出的目录行为保持不变，
 * 回执里回报的正是本次产物真实落盘的那个绝对目录。
 */
export function resolveCallerOutputDir(name: string, input: unknown, scope: SessionScope | undefined): { value: unknown; outputDir?: string } {
  if (!(outputDirTools as readonly string[]).includes(name) || input === null || typeof input !== 'object') return { value: input }
  const outputDir = (input as { outputDir?: unknown }).outputDir
  // 缺失或类型不对留给原 schema/operation 自己的报错，这里不替它判。
  if (typeof outputDir !== 'string') return { value: input }
  const resolved = sessionPath(scope, outputDir, 'outputDir')
  if (resolved === outputDir) return { value: input }
  return { value: { ...(input as Record<string, unknown>), outputDir: resolved }, outputDir: resolved }
}
