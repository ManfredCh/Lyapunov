/**
 * 全屏终端的纯呈现层：布局、换行/截断、滚动、焦点与按键路由、ANSI 帧生成。
 *
 * 这里只有计算，不读写 TTY、不接触任何 DSH 服务：运行 owner 仍由插件层的现有闭包
 * （SessionController/Agent/commands/Workspace/审批/草稿）承担，因此全屏与行式终端
 * 共用同一份操作实现。屏幕内容来自行式终端已经渲染好的文本，本模块只负责把它摆到
 * 真实的全屏画布上（会话/Workspace 导航、内容滚动、底部多行编辑器、状态与运行中任务）。
 * @module @lyapunov/terminal/fullscreen
 */

export interface ScreenSize { readonly columns: number; readonly rows: number }

/** 焦点环：导航（会话/Workspace）/ 内容（转录）/ 编辑器（草稿与输入行）。 */
export type FullscreenFocus = 'nav' | 'transcript' | 'editor'

export interface NavigationSession {
  readonly id: string
  readonly title?: string
  readonly archived: boolean
  readonly current: boolean
}

export interface NavigationWorkspace {
  /** 原生 Workspace ID；始终等于原生注册表里的值，不是本地序号。 */
  readonly id: string
  readonly title: string
  readonly sessions: readonly NavigationSession[]
}

export interface FullscreenStatus {
  readonly sessionId?: string
  readonly agentStatus?: string
  readonly model?: string
  readonly focus: FullscreenFocus
  /** 从底部往上滚动的行数；0 表示跟随最新输出。 */
  readonly scrollBack: number
  readonly draftLines: number
  readonly attachments: number
  readonly pendingApprovals: readonly string[]
  readonly pendingQuestions: readonly string[]
  readonly jobs?: number
  /** 最近一次用户可见的全屏提示（例如焦点切换）。 */
  readonly note?: string
}

export interface FullscreenEditorView {
  /** 原生草稿全文（多行输入时为多行）。 */
  readonly draft: string
  /** readline 当前编辑行与其光标列。 */
  readonly line: string
  readonly cursor: number
}

export interface FullscreenView {
  readonly size: ScreenSize
  readonly status: FullscreenStatus
  readonly workspaces: readonly NavigationWorkspace[]
  /** 当前选中的导航行下标（navRows 的顺序）。 */
  readonly navIndex: number
  /** 转录的逻辑行（已由终端清洗掉控制转义）。 */
  readonly transcript: readonly string[]
  /** 尚未换行的当前增量行（模型流尾部）：参与折行与滚动，但不进入转录历史。 */
  readonly partial?: string
  readonly editor: FullscreenEditorView
}

/** 导航面板里可选中的会话行；Workspace 标题只是分组行。 */
export interface NavRow {
  readonly kind: 'workspace' | 'session'
  readonly workspaceId: string
  readonly sessionId?: string
  readonly label: string
}

export interface FullscreenLayout {
  readonly header: number
  readonly body: number
  readonly navWidth: number
  readonly transcriptWidth: number
  readonly editorRows: number
  readonly footer: number
  readonly bodyTop: number
  readonly editorTop: number
}

const FOCUS_LABELS: Readonly<Record<FullscreenFocus, string>> = { nav: '导航', transcript: '内容', editor: '编辑器' }
const FOCUS_ORDER: readonly FullscreenFocus[] = ['nav', 'transcript', 'editor']

export function focusLabel(focus: FullscreenFocus): string { return FOCUS_LABELS[focus] }
export function nextFocus(focus: FullscreenFocus, step: 1 | -1): FullscreenFocus {
  return FOCUS_ORDER[(FOCUS_ORDER.indexOf(focus) + step + FOCUS_ORDER.length) % FOCUS_ORDER.length]!
}

/** 东亚宽字符占两列；其余按一列计。全屏截断必须与实际显示宽度一致。 */
export function displayWidth(text: string): number {
  let width = 0
  for (const character of text) {
    const code = character.codePointAt(0)!
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) continue
    width += isWide(code) ? 2 : 1
  }
  return width
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0x303e) || (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1f9ff)
  )
}

/** 按显示宽度截断；超宽时保留省略号，保证结果宽度不超过 limit。 */
export function truncate(text: string, limit: number): string {
  if (limit <= 0) return ''
  if (displayWidth(text) <= limit) return text
  let width = 0
  let out = ''
  for (const character of text) {
    const cost = isWide(character.codePointAt(0)!) ? 2 : 1
    if (width + cost > limit - 1) break
    out += character; width += cost
  }
  return out + '…'
}

/** 按显示宽度换行；不拆分宽字符，超长单词硬切。 */
export function wrapLine(text: string, limit: number): string[] {
  if (limit <= 0) return ['']
  if (!text) return ['']
  const lines: string[] = []
  let current = ''
  let width = 0
  for (const character of text) {
    const cost = isWide(character.codePointAt(0)!) ? 2 : 1
    if (width + cost > limit) { lines.push(current); current = ''; width = 0 }
    current += character; width += cost
  }
  lines.push(current)
  return lines
}

/** 转录折行后的总行数，含尚未换行的当前增量行；可见窗口与滚动夹紧必须用同一笔账。 */
export function transcriptRows(transcript: readonly string[], width: number, tail = ''): number {
  let total = 0
  for (const line of transcript) total += wrapLine(line, width).length
  return tail ? total + wrapLine(tail, width).length : total
}

/** 转录全部折行后，从底部往上 scrollBack 行开始的可见窗口；未换行的当前增量行接在最后。 */
export function visibleTranscriptLines(transcript: readonly string[], width: number, height: number, scrollBack: number, tail = ''): string[] {
  const rows = Math.max(1, height)
  if (width <= 0) return Array.from({ length: rows }, () => '')
  const wrapped = transcript.flatMap(line => wrapLine(line, width))
  const tailLines = tail ? wrapLine(tail, width) : []
  const total = wrapped.length + tailLines.length
  const back = clampScroll(total, rows, scrollBack)
  const start = Math.max(0, total - rows - back)
  const window: string[] = []
  for (let index = start; index < start + rows; index++) {
    if (index < wrapped.length) window.push(wrapped[index]!)
    else if (index - wrapped.length < tailLines.length) window.push(tailLines[index - wrapped.length]!)
    else window.push('')
  }
  return window
}

export function clampScroll(total: number, height: number, scrollBack: number): number {
  const max = Math.max(0, total - Math.max(1, height))
  if (!Number.isFinite(scrollBack)) return 0
  return Math.min(Math.max(0, Math.trunc(scrollBack)), max)
}

/** 导航行：Workspace 分组 + 其原生会话（顺序就是原生 sessionIds 顺序）。 */
export function navRows(workspaces: readonly NavigationWorkspace[]): NavRow[] {
  return workspaces.flatMap(workspace => [
    { kind: 'workspace' as const, workspaceId: workspace.id, label: `${workspace.title} (${workspace.sessions.length})` },
    ...workspace.sessions.map(session => ({
      kind: 'session' as const, workspaceId: workspace.id, sessionId: session.id,
      label: `${session.title ? session.title + '  ' : ''}${session.id}${session.current ? ' ←当前' : ''}${session.archived ? '（已归档）' : ''}`,
    })),
  ])
}

/** 会话行末尾的原生标记：会话 ID 长度恒定（44列），不保住标记就永远看不见当前会话。 */
const NAV_SUFFIXES = [' ←当前', '（已归档）'] as const

/** 导航列里按宽度截断，但先剪身份后剪标记：`> session-… ←当前` 比丢掉标记有用。 */
export function fitNavLabel(text: string, limit: number): string {
  let suffix = '', body = text
  for (;;) {
    const hit = NAV_SUFFIXES.find(item => body.endsWith(item) && !suffix.includes(item))
    if (hit === undefined) break
    suffix = hit + suffix
    body = body.slice(0, -hit.length)
  }
  const room = limit - displayWidth(suffix)
  if (suffix.length === 0 || room <= 0 || displayWidth(body) <= room) return truncate(text, limit)
  return truncate(body, room) + suffix
}

/** ↑/↓ 只在会话行之间移动：跳过 Workspace 分组行，到边界不循环。 */
export function moveNavIndex(rows: readonly NavRow[], index: number, step: 1 | -1): number {
  const selectable = rows.flatMap((row, at) => (row.kind === 'session' ? [at] : []))
  if (!selectable.length) return -1
  const current = selectable.findIndex(at => at === index)
  if (current < 0) return step === 1 ? selectable[0]! : selectable.at(-1)!
  const next = current + step
  if (next < 0 || next >= selectable.length) return selectable[current]!
  return selectable[next]!
}

export function navSelectionId(rows: readonly NavRow[], index: number): string | undefined {
  return rows[index]?.sessionId
}

/** 导航局部视窗起点：让 navIndex 始终落在可见的 body 行里；清单不超过 body 时恒为 0（小列表不回归）。 */
export function navWindowStart(rows: readonly NavRow[], index: number, height: number): number {
  if (index < 0) return 0
  const body = Math.max(1, height)
  return Math.min(Math.max(0, index - body + 1), Math.max(0, rows.length - body))
}

/** 从尺寸算出四个区域；行高不足时先压缩编辑器和折叠底部状态，绝不为负数。 */
export function layout(size: ScreenSize): FullscreenLayout {
  const columns = Math.max(24, size.columns)
  const rows = Math.max(6, size.rows)
  const navWidth = Math.min(38, Math.max(18, Math.floor(columns * 0.28)))
  const editorRows = rows >= 18 ? 4 : rows >= 12 ? 3 : 1
  const footer = rows >= 12 ? 2 : 1
  const body = Math.max(1, rows - 1 - editorRows - footer)
  const bodyTop = 1
  const editorTop = bodyTop + body
  return { header: 1, body, navWidth, transcriptWidth: Math.max(4, columns - navWidth - 1), editorRows, footer, bodyTop, editorTop }
}

const BOLD = '\x1b[1m'
const REVERSE = '\x1b[7m'
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'

/** 先按显示宽度补齐/截断（纯文本），再决定是否叠加 SGR，保证宽度账目不被转义序列污染。 */
function fill(text: string, width: number): string {
  const value = truncate(text, width)
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)))
}
function highlight(text: string, on: boolean): string { return on ? REVERSE + text + RESET : text }

/** 用户输入可能带控制字节（Tab、ESC 转义等）；进入画布前一律替换成空格，逐字符保持长度与光标位。 */
export function sanitizeInput(text: string): string { return text.replace(/[\x00-\x1f\x7f]/g, ' ') }

/** 显示列到字符串下标：宽字符不能从中间切开，光标必须落在字符边界上。 */
function columnIndex(text: string, column: number): number {
  let width = 0, at = 0
  for (const character of text) {
    const cost = isWide(character.codePointAt(0)!) ? 2 : 1
    if (width + cost > column) break
    width += cost; at += character.length
  }
  return at
}

/** 一个屏幕帧：恰好 size.rows 行，每行显示宽度不超过 size.columns。 */
export function renderFrame(view: FullscreenView): string[] {
  const { size } = view
  const plan = layout(size)
  const rows: string[] = []
  const focus = view.status.focus
  const nav = navRows(view.workspaces)
  // 草稿是逐行文本：先按换行拆开再各自折行，控制字节不进画布。
  const draftLines = view.editor.draft
    ? view.editor.draft.split('\n').flatMap(row => wrapLine(sanitizeInput(row), Math.max(1, size.columns - 6)))
    : []

  // 第 1 行：身份、会话、运行中任务与焦点标签（全屏固定区域，不是行式重画）。
  const running = [
    view.status.agentStatus ?? '无会话',
    view.status.jobs === undefined ? 'Jobs ?' : `Jobs ${view.status.jobs}`,
    view.status.pendingApprovals.length ? `待审批 ${view.status.pendingApprovals.length}` : '',
    view.status.pendingQuestions.length ? `待问答 ${view.status.pendingQuestions.length}` : '',
  ].filter(Boolean).join(' · ')
  const focusTag = `[焦点 ${focusLabel(focus)}]`
  const head = truncate(`lyapunov 全屏  ${view.status.sessionId ?? '未选择会话'}  ${running}`, Math.max(0, size.columns - displayWidth(focusTag)))
  rows.push(fill(head, Math.max(0, size.columns - displayWidth(focusTag))) + highlight(focusTag, focus === 'nav'))

  // 中部：左侧会话/Workspace 导航，右侧转录窗口（含滚动）。
  const transcript = visibleTranscriptLines(view.transcript, plan.transcriptWidth, plan.body, view.status.scrollBack, view.partial ?? '')
  const navStart = navWindowStart(nav, view.navIndex, plan.body)
  for (let index = 0; index < plan.body; index++) {
    const row = nav[navStart + index]
    const selected = row !== undefined && row.kind === 'session' && navStart + index === view.navIndex && focus === 'nav'
    const plain = row === undefined ? '' : fitNavLabel(`${row.kind === 'workspace' ? '▍' : row.kind === 'session' && navStart + index === view.navIndex ? '>' : ' '} ${row.label}`, plan.navWidth - 1)
    const navCell = highlight(fill(plain, plan.navWidth - 1), selected)
    rows.push(navCell + DIM + '│' + RESET + ' ' + fill(transcript[index] ?? '', plan.transcriptWidth))
  }

  // 底部：多行编辑器（草稿尾部 + 当前输入行与光标）。
  const draftTail = draftLines.slice(-Math.max(0, plan.editorRows > 1 ? plan.editorRows - 2 : 1))
  for (let index = 0; index < plan.editorRows; index++) {
    const isInput = index === plan.editorRows - 1
    if (isInput) {
      const prefix = `[编辑器] 草稿 ${view.status.draftLines} 行 · 附件 ${view.status.attachments} > `
      const text = sanitizeInput(view.editor.line)
      const filled = fill(prefix + text, size.columns)
      // 光标列按显示宽度算，再换成字符串下标；前缀与草稿都可能含宽字符。
      const column = Math.max(0, Math.min(size.columns - 1, displayWidth(truncate(prefix + text.slice(0, view.editor.cursor), size.columns))))
      const at = columnIndex(filled, column)
      // 光标下取完整码点（BMP 宽字符 1 个 UTF-16 单元、emoji 2 个）：整字反显，尾部按码点跨度跳过。
      // 不能用 displayWidth 当跳步——那是显示列：宽字符多跳一格会把光标后的字删掉，代理对会被拆开。
      const under = filled.codePointAt(at) === undefined ? '' : String.fromCodePoint(filled.codePointAt(at)!)
      rows.push(filled.slice(0, at) + highlight(under || ' ', focus === 'editor') + filled.slice(at + under.length))
      continue
    }
    const draftRow = draftTail[index - 1]
    // 宽度先按纯文本算；DIM 只叠在已经定宽的整行外层，不参与列数。
    const content = draftRow === undefined ? (index === 0 ? `[草稿 ${view.status.draftLines} 行 · 附件 ${view.status.attachments}]` : '') : `草稿 ${draftRow}`
    rows.push(draftRow === undefined ? fill(content, size.columns) : DIM + fill(content, size.columns) + RESET)
  }

  // 状态行：会话、运行状态、模型、待处理审批/问答与滚动位置。
  const statusRow = [
    view.status.sessionId ? `会话 ${view.status.sessionId}` : '未选择会话',
    `状态 ${view.status.agentStatus ?? '-'}`,
    view.status.model ? `模型 ${view.status.model}` : '',
    view.status.pendingApprovals.length ? `审批 ${view.status.pendingApprovals.join(',')}` : '',
    view.status.pendingQuestions.length ? `问答 ${view.status.pendingQuestions.join(',')}` : '',
    view.status.scrollBack ? `滚动 -${view.status.scrollBack}` : '跟随最新',
  ].filter(Boolean).join(' | ')
  rows.push(fill(statusRow, size.columns))
  const hint = view.status.note ?? 'Tab 切换焦点 | ↑↓ 选择/滚动 | PgUp/PgDn 翻页 | Home/End 顶/底 | 导航焦点 Enter 打开会话 | 编辑器 Enter 发送 | Ctrl+C 取消 | :quit 退出'
  rows.push(fill(hint, size.columns))
  // 每一行在上面都已经按纯文本定宽；这里只补齐缺失行，不能再对含 SGR 的整行做二次截断。
  while (rows.length < size.rows) rows.push(' '.repeat(size.columns))
  return rows.slice(0, size.rows)
}

/** 一帧的 ANSI 输出：光标归位后逐行覆盖；不追加换行到最底行以避免滚动。 */
export function frameText(rows: readonly string[]): string {
  return '\x1b[H' + rows.map(row => row + '\x1b[K').join('\r\n')
}

export const ALT_SCREEN_ENTER = '\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H'
export const ALT_SCREEN_LEAVE = '\x1b[?25h\x1b[?1049l'

export type FullscreenKey = 'tab' | 'backtab' | 'up' | 'down' | 'page-up' | 'page-down' | 'home' | 'end' | 'left' | 'right' | 'enter'

const KEY_SEQUENCES: ReadonlyArray<readonly [FullscreenKey, string]> = [
  ['tab', '\t'], ['backtab', '\x1b[Z'],
  ['up', '\x1b[A'], ['down', '\x1b[B'], ['right', '\x1b[C'], ['left', '\x1b[D'],
  ['up', '\x1bOA'], ['down', '\x1bOB'], ['right', '\x1bOC'], ['left', '\x1bOD'],
  ['page-up', '\x1b[5~'], ['page-down', '\x1b[6~'],
  ['home', '\x1b[H'], ['end', '\x1b[F'], ['home', '\x1b[1~'], ['end', '\x1b[4~'],
  ['enter', '\r'],
]
const PASTE_START = '\x1b[200~'

/** 一个输入块里按键与普通字节的原始顺序：未被消费的按键必须回到原位，不能挪到末尾。 */
export type RoutedSegment = { readonly kind: 'key'; readonly key: FullscreenKey } | { readonly kind: 'text'; readonly text: string }

export interface RoutedKeys { readonly keys: readonly FullscreenKey[]; readonly forward: string }

/**
 * 在 bracketed paste 之前只摘出全屏自己用的完整按键序列。
 * 含粘贴起始标记的块整体放行；其余字节保持原顺序，绝不改写用户输入。
 */
export function routeSegments(text: string): RoutedSegment[] {
  if (text.includes(PASTE_START)) return [{ kind: 'text', text }]
  const segments: RoutedSegment[] = []
  let at = 0, pending = ''
  while (at < text.length) {
    const found = KEY_SEQUENCES.find(([, sequence]) => text.startsWith(sequence, at))
    if (found) {
      if (pending) { segments.push({ kind: 'text', text: pending }); pending = '' }
      segments.push({ kind: 'key', key: found[0] })
      at += found[1].length
      continue
    }
    // Home/End 的 CSI H/F 可能与其它参数形式冲突：只认精确序列，其余照原样转发。
    pending += text[at]
    at++
  }
  if (pending) segments.push({ kind: 'text', text: pending })
  return segments
}

export function routeKeys(text: string): RoutedKeys {
  const segments = routeSegments(text)
  const keys: FullscreenKey[] = [], forward: string[] = []
  for (const segment of segments) {
    if (segment.kind === 'key') keys.push(segment.key)
    else forward.push(segment.text)
  }
  return { keys, forward: forward.join('') }
}

export function keySequence(key: FullscreenKey): string {
  return KEY_SEQUENCES.find(([name]) => name === key)?.[1] ?? ''
}
