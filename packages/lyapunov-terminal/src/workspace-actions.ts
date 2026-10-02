/**
 * 行式终端的 Workspace 顺序与选择交互（本地终端与远端 attach 共用同一实现）。
 *
 * 查看顺序、选择目标与会话清单都来自同一个原生 Workspace owner
 * （`ctx.workspaceController` / WorkspaceRegistry）：终端不缓存第二份 Workspace
 * 状态、不读写任何本地 workspace 文件；顺序改动一律交回原生 `insertBefore`，
 * 呈现的顺序总是原生重新读出的顺序，而不是终端自己的副本。
 * 本地进程内由 `ctx.workspaceController` 满足 {@link WorkspaceOrderService}，
 * 远端连接由同一原生控制器生成的 `remote.workspace` 命名空间适配成同一结构，
 * 因此两条入口调用的是同一个 `handleWorkspaceAction`，没有第二份排序器。
 * @module @lyapunov/terminal/workspace-actions
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {
  WorkspaceFollowFrame,
  WorkspaceInsertBeforeRequest,
  WorkspaceOrderValue,
  WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller'

/**
 * 原生 Workspace owner 的最小结构接口：只声明本模块用到的两个动词。
 * Host 进程内 `ctx.workspaceController` 直接满足；远端连接用 `remote.workspace`
 * 的同名方法适配（流原样透传，RPC 结果由调用方解包）。
 */
export interface WorkspaceOrderService {
  follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame>
  insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue>
}

export interface WorkspaceActionInput {
  readonly order: WorkspaceOrderService
  readonly sessionId?: SessionId
  readonly argument: string
  readonly signal: AbortSignal
}

/** 顺序动作；与原生 insertBefore 的 DOM 语义一致（缺省锚点即追加到末尾）。 */
export type WorkspaceMotion =
  | { readonly kind: 'top' | 'end' | 'up' | 'down' }
  | { readonly kind: 'before'; readonly anchor: WorkspaceId }

/** 目标解析：命中某个 Workspace，或给出一条可读的未命中/歧义说明。 */
export type WorkspaceTargetResolution =
  | { readonly found: true; readonly workspace: WorkspaceView }
  | { readonly found: false; readonly kind: 'not-found' | 'usage'; readonly message: string }

/** `:workspace <目标> [顺序动作]` 的解析结果。 */
export type WorkspaceArgumentResolution =
  | { readonly kind: 'select'; readonly workspace: WorkspaceView; readonly position: number }
  | { readonly kind: 'move'; readonly workspace: WorkspaceView; readonly position: number; readonly motion: WorkspaceMotion }
  | { readonly kind: 'not-found'; readonly message: string }
  | { readonly kind: 'usage'; readonly message: string }

/** 只消费原生首次快照，随即关闭订阅；终端不建立 Workspace 状态仓库。 */
export async function firstFrame<Frame>(stream: AsyncIterable<Frame>): Promise<Frame> {
  const iterator = stream[Symbol.asyncIterator]()
  try {
    const result = await iterator.next()
    if (result.done) throw new Error('原生状态流没有返回初始快照。')
    return result.value
  } finally {
    await iterator.return?.()
  }
}

/** `#序号`（1 起，按原生注册顺序）、完整 ID、唯一 ID 前缀或唯一标题；歧义与未知都不替用户猜。 */
export function resolveWorkspaceTarget(items: readonly WorkspaceView[], token: string): WorkspaceTargetResolution {
  // 空 token 会让前缀匹配命中所有 ID；它不可能来自已解析的参数，这里明确拒绝而不是替用户猜。
  if (!token.trim()) return { found: false, kind: 'not-found', message: missingMessage(items, token) }
  const numbered = /^#(\d+)$/.exec(token)
  if (numbered !== null) {
    const workspace = items[Number(numbered[1]) - 1]
    return workspace ? { found: true, workspace } : { found: false, kind: 'not-found', message: missingMessage(items, token) }
  }
  const exact = items.find(item => item.workspaceId === token)
  if (exact) return { found: true, workspace: exact }
  const prefixed = items.filter(item => item.workspaceId.startsWith(token))
  if (prefixed.length === 1) return { found: true, workspace: prefixed[0]! }
  if (prefixed.length > 1) return { found: false, kind: 'usage', message: ambiguousMessage(token, '标识', prefixed) }
  const titled = items.filter(item => item.title === token)
  if (titled.length === 1) return { found: true, workspace: titled[0]! }
  if (titled.length > 1) return { found: false, kind: 'usage', message: ambiguousMessage(token, '标题', titled) }
  return { found: false, kind: 'not-found', message: missingMessage(items, token) }
}

/**
 * 解析 `:workspace` 的参数：先按整串选目标（标题可含空格），再识别尾部的顺序动作词。
 * 选择与移动共用同一个原生目标解析，不另建一套语法。
 * `before` 的锚点同样按词边界定位，因此含空格的目标与锚点都能直接书写。
 */
export function parseWorkspaceArgument(items: readonly WorkspaceView[], argument: string): WorkspaceArgumentResolution {
  const positionOf = (workspace: WorkspaceView) => items.indexOf(workspace) + 1
  const whole = resolveWorkspaceTarget(items, argument)
  if (whole.found) return { kind: 'select', workspace: whole.workspace, position: positionOf(whole.workspace) }
  const words = argument.split(/\s+/)
  const tail = words.at(-1)!
  const motions = ['top', 'end', 'up', 'down']
  if (words.length > 1 && motions.includes(tail)) {
    const target = resolveWorkspaceTarget(items, words.slice(0, -1).join(' '))
    if (!target.found) return { kind: target.kind, message: target.message }
    return { kind: 'move', workspace: target.workspace, position: positionOf(target.workspace), motion: { kind: tail as 'top' | 'end' | 'up' | 'down' } }
  }
  const marker = lastBeforeWord(argument)
  if (marker >= 0) {
    const targetText = argument.slice(0, marker).trim(), anchorText = argument.slice(marker + 'before'.length).trim()
    if (!targetText || !anchorText) return { kind: 'usage', message: '用法：:workspace <目标> before <锚点>。' }
    // `before` 两侧都按整串解析：标题里的空格不影响目标与锚点的识别。
    const target = resolveWorkspaceTarget(items, targetText)
    if (!target.found) return { kind: target.kind, message: target.message }
    const anchor = resolveWorkspaceTarget(items, anchorText)
    if (!anchor.found) return { kind: anchor.kind, message: anchor.message }
    if (anchor.workspace.workspaceId === target.workspace.workspaceId) return { kind: 'usage', message: '锚点不能是被移动的 Workspace 自身。' }
    return { kind: 'move', workspace: target.workspace, position: positionOf(target.workspace), motion: { kind: 'before', anchor: anchor.workspace.workspaceId } }
  }
  if (words.length > 1) return { kind: 'usage', message: `未知顺序操作：${words.slice(1).join(' ')}；可用 top（置顶）、end（置底）、up/down（上下移一格）、before <锚点>。` }
  return { kind: whole.kind, message: whole.message }
}

/**
 * 纯计算：移动后的完整注册顺序。语义与原生 insertBefore 相同
 * （up/down 越界、before 自身都保持原顺序），便于逐条核对再交给原生执行。
 */
export function plannedWorkspaceOrder(order: readonly WorkspaceId[], workspaceId: WorkspaceId, motion: WorkspaceMotion): WorkspaceId[] {
  const from = order.indexOf(workspaceId)
  const without = order.filter(candidate => candidate !== workspaceId)
  let to = 0
  switch (motion.kind) {
    case 'end': to = without.length; break
    case 'up': to = Math.max(0, from - 1); break
    case 'down': to = Math.min(order.length - 1, from + 1); break
    case 'before': {
      const anchor = without.indexOf(motion.anchor)
      to = anchor < 0 ? without.length : anchor
      break
    }
  }
  return [...without.slice(0, to), workspaceId, ...without.slice(to)]
}

/** 原生 insertBefore 只需要一个锚点：目标位置的后继；目标落在末尾则省略锚点。 */
export function workspaceMoveAnchor(planned: readonly WorkspaceId[], workspaceId: WorkspaceId): WorkspaceId | undefined {
  const at = planned.indexOf(workspaceId)
  return at >= 0 && at + 1 < planned.length ? planned[at + 1] : undefined
}

/** 原生注册顺序的人可读清单：序号、稳定 ID、标题、路径与会话数。 */
export function workspaceOrderLines(items: readonly WorkspaceView[], archivedSessionIds: readonly SessionId[]): string[] {
  const archived = new Set<string>(archivedSessionIds)
  if (!items.length) return ['[Workspace 顺序] 当前没有已注册的 Workspace。', '用 :new <目录> 创建会话时由原生 SessionController 归属 Workspace。']
  return [
    `[Workspace 顺序（原生注册顺序，共 ${items.length} 个）]`,
    ...items.flatMap((item, index) => {
      const gone = item.sessionIds.filter(sessionId => archived.has(sessionId)).length
      return [`#${index + 1} ${item.workspaceId}  ${item.title}`, `   ${item.path} · 会话 ${item.sessionIds.length}${gone ? `（已归档 ${gone}）` : ''}`]
    }),
    '选择：:workspace #1；移动：:workspace #1 top|end|up|down 或 :workspace #1 before #2。',
  ]
}

/** 被选中 Workspace 的原生会话清单（手工顺序），可直接用 :open 选择。 */
export function workspaceSelectionLines(workspace: WorkspaceView, position: number, archivedSessionIds: readonly SessionId[]): string[] {
  const archived = new Set<string>(archivedSessionIds)
  const lines = [`[Workspace #${position}] ${workspace.workspaceId}`, `${workspace.title}  ${workspace.path}`]
  if (!workspace.sessionIds.length) {
    lines.push('该 Workspace 还没有会话；在该目录 :new 一个会话即由原生归属。')
    return lines
  }
  lines.push(`[会话 ${workspace.sessionIds.length} 个（原生手工顺序）]`)
  workspace.sessionIds.forEach((sessionId, index) => lines.push(`${index + 1}. ${sessionId}${archived.has(sessionId) ? '（已归档）' : ''}`))
  lines.push('用 :open <会话ID> 选择会话；:archive <会话ID> 归档。')
  return lines
}

/** `:workspaces` 与 `:workspace <目标> [顺序动作]` 的实现：只组合原生 Workspace 服务（本地与远端同一条路径）。 */
export async function handleWorkspaceAction(verb: 'workspace' | 'workspaces', input: WorkspaceActionInput): Promise<string[]> {
  const controller = input.order
  if (verb === 'workspaces' && input.argument.trim()) throw new Error('用法：:workspaces（查看原生状态）。')
  const frame = await firstFrame(controller.follow(input.signal))
  if (frame.type !== 'baseline') throw new Error('原生 Workspace 状态流缺少 baseline。')
  const { items, archivedSessionIds } = frame.value
  if (verb === 'workspaces') return workspaceOrderLines(items, archivedSessionIds)
  const argument = input.argument.trim()
  if (!argument) {
    const own = input.sessionId === undefined ? undefined : items.find(item => item.sessionIds.includes(input.sessionId!))
    if (own) return workspaceSelectionLines(own, items.indexOf(own) + 1, archivedSessionIds)
    return [input.sessionId === undefined ? '当前没有选择会话；以下是原生注册顺序。' : '当前会话尚未归属已注册的 Workspace；以下是原生注册顺序。', ...workspaceOrderLines(items, archivedSessionIds)]
  }
  const parsed = parseWorkspaceArgument(items, argument)
  if (parsed.kind === 'select') return workspaceSelectionLines(parsed.workspace, parsed.position, archivedSessionIds)
  if (parsed.kind === 'not-found') return [parsed.message, ...workspaceOrderLines(items, archivedSessionIds)]
  if (parsed.kind === 'usage') throw new Error(parsed.message)
  const order = items.map(item => item.workspaceId)
  const planned = plannedWorkspaceOrder(order, parsed.workspace.workspaceId, parsed.motion)
  const anchor = workspaceMoveAnchor(planned, parsed.workspace.workspaceId)
  input.signal.throwIfAborted()
  await controller.insertBefore({
    workspaceId: parsed.workspace.workspaceId,
    ...(anchor === undefined ? {} : { beforeWorkspaceId: anchor }),
  })
  input.signal.throwIfAborted()
  // 移动后重新读取原生 baseline：呈现的顺序是原生当前顺序，不是终端计划的副本。
  const refreshed = await firstFrame(controller.follow(input.signal))
  if (refreshed.type !== 'baseline') throw new Error('原生 Workspace 状态流缺少 baseline。')
  const moved = order.join(' ') !== refreshed.value.items.map(item => item.workspaceId).join(' ')
  const at = refreshed.value.items.findIndex(item => item.workspaceId === parsed.workspace.workspaceId) + 1
  const outcome = !moved
    ? `[未移动] ${parsed.workspace.workspaceId} 已在 #${parsed.position}；原生顺序未变。`
    : at > 0
      ? `[已移动] ${parsed.workspace.workspaceId} 从 #${parsed.position} 到 #${at}（原生 insertBefore）。`
      : `[已移动] ${parsed.workspace.workspaceId} 已不在原生顺序中（其它客户端同时改动）。`
  return [outcome, ...workspaceOrderLines(refreshed.value.items, refreshed.value.archivedSessionIds)]
}

function missingMessage(items: readonly WorkspaceView[], token: string): string {
  return items.length
    ? `没有找到 Workspace：${token}；当前顺序只有 #1..#${items.length}（:workspaces 查看）。`
    : `没有找到 Workspace：${token}；当前没有已注册的 Workspace。`
}

function ambiguousMessage(token: string, kind: string, candidates: readonly WorkspaceView[]): string {
  return `Workspace ${kind} ${token} 不唯一：${candidates.map(item => `${item.workspaceId}（${item.title}）`).join('、')}；请用 #序号或完整 ID。`
}

/**
 * 最后一个独立成词的 `before` 的词首下标（没有则 -1）。
 * 标题可含空格，所以按词边界而不是按空格切分取倒数第二个词；标题里恰好含有
 * 独立词 `before` 时取最后一次出现，仍无法区分时用 #序号或完整 ID。
 */
function lastBeforeWord(argument: string): number {
  const pattern = /(^|\s)before(?=\s|$)/g
  let found = -1, match: RegExpExecArray | null = null
  while ((match = pattern.exec(argument)) !== null) found = match.index + match[1]!.length
  return found
}
