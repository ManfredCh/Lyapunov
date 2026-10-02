/**
 * 全屏终端控制器：真实 TTY 上的备用屏幕、键盘路由、resize 与帧刷新。
 *
 * 它不实现任何会话/Agent/命令/审批语义：导航数据、状态与草稿都从运行层读取，
 * 打开会话、取消、审批与发送仍走行式终端已经在用的同一批闭包与原生服务。
 * 屏幕内容与布局在 {@link ./fullscreen.ts} 里按纯函数计算，这里只负责与 TTY 交互。
 * @module @lyapunov/terminal/fullscreen-terminal
 */

import { PassThrough } from 'node:stream'
import {
  ALT_SCREEN_ENTER, ALT_SCREEN_LEAVE, clampScroll, displayWidth, focusLabel, frameText, keySequence, layout,
  moveNavIndex, navRows, navSelectionId, nextFocus, renderFrame, routeSegments, transcriptRows,
  type FullscreenFocus, type FullscreenKey, type FullscreenStatus, type FullscreenView, type NavigationWorkspace, type ScreenSize,
} from './fullscreen.ts'

// 本模块的公开接口用这些类型（FullscreenRuntime.status 的返回、navigation 的产出），
// 所以从纯呈现层原样再导出一次：调用方只 import 本模块，不必知道布局模块的内部分区。
export type {
  FullscreenEditorView, FullscreenFocus, FullscreenKey, FullscreenStatus, FullscreenView,
  NavigationSession, NavigationWorkspace, ScreenSize,
} from './fullscreen.ts'

/** 全屏只读取运行层的投影、只调用运行层已有的动作。 */
export interface FullscreenRuntime {
  /** 会话/Workspace 导航；每次都读原生 owner，全屏层不缓存第二份状态。 */
  navigation(signal: AbortSignal): Promise<readonly NavigationWorkspace[]>
  /** 运行中任务与待处理交互的实时快照。 */
  status(): Omit<FullscreenStatus, 'focus' | 'scrollBack' | 'note'>
  /** 编辑器数据：原生草稿全文 + readline 的当前行与光标。 */
  editor(): { readonly draft: string; readonly line: string; readonly cursor: number }
  /** 打开导航选中的会话；实现必须复用既有 select 动作。 */
  openSession(id: string): Promise<void>
  /** 全屏提示行（焦点切换等），仍进同一份转录历史。 */
  note(text: string): void
}

/** 全屏只需要写字节与读取窗口尺寸：真实 TTY 与测试替身都满足这个最小结构。 */
export interface FullscreenOutput {
  write(text: string): unknown
  readonly columns?: number
  readonly rows?: number
}

export interface FullscreenTerminalOptions {
  readonly stdout: FullscreenOutput
  /** 帧刷新周期；每次按键与事件都会另外合并触发一次。 */
  readonly refreshMs?: number
  /** 导航数据的自动重读周期。 */
  readonly navigationMs?: number
}

/** readline 的输出在真实终端上被全屏接管：它的回显写入这个丢弃流，画面只由本控制器绘制。 */
class FullscreenReadlineSink extends PassThrough {
  constructor(private readonly size: () => ScreenSize) { super() }
  get columns(): number { return this.size().columns }
  get rows(): number { return this.size().rows }
  get isTTY(): boolean { return false }
}

export class FullscreenTerminal {
  private readonly transcript: string[] = []
  private partial = ''
  private focus: FullscreenFocus = 'transcript'
  private navIndex = -1
  private scrollBack = 0
  private noteText: string | undefined
  private workspaces: readonly NavigationWorkspace[] = []
  private active = false
  private paused = false
  private dirty = false
  private lastFrame = ''
  private timer: NodeJS.Timeout | undefined
  private navigationTimer: NodeJS.Timeout | undefined
  private scheduled: NodeJS.Timeout | undefined
  private tick = 0
  private readonly sizeProvider = () => this.size()
  readonly readlineSink: PassThrough

  constructor(private readonly runtime: FullscreenRuntime, private readonly options: FullscreenTerminalOptions) {
    this.readlineSink = new FullscreenReadlineSink(this.sizeProvider)
  }

  get started(): boolean { return this.active }
  get currentFocus(): FullscreenFocus { return this.focus }
  get scroll(): number { return this.scrollBack }
  size(): ScreenSize {
    const stdout = this.options.stdout
    return { columns: Math.max(24, stdout.columns ?? 80), rows: Math.max(6, stdout.rows ?? 24) }
  }

  /** 进入备用屏幕；TTY 状态（raw/bracketed paste）仍由插件层按既有方式管理。 */
  start(signal: AbortSignal): void {
    if (this.active) return
    this.active = true
    this.options.stdout.write(ALT_SCREEN_ENTER)
    process.on('SIGWINCH', this.onResize)
    this.timer = setInterval(() => { this.tick++; void this.tickRender() }, this.options.refreshMs ?? 200)
    this.navigationTimer = setInterval(() => { void this.refreshNavigation(signal) }, this.options.navigationMs ?? 1000)
    void this.refreshNavigation(signal)
    this.dirty = true
    void this.tickRender()
  }

  /** 外部编辑器等独占终端时暂停绘制并退出备用屏幕；恢复时重新进入并整帧重画。 */
  pause(): void {
    if (!this.active || this.paused) return
    this.paused = true
    if (this.scheduled) clearTimeout(this.scheduled)
    this.scheduled = undefined
    this.options.stdout.write(ALT_SCREEN_LEAVE)
  }

  resume(): void {
    if (!this.active || !this.paused) return
    this.paused = false
    this.options.stdout.write(ALT_SCREEN_ENTER)
    this.lastFrame = ''
    this.invalidate()
  }

  dispose(): void {
    if (!this.active) return
    this.active = false
    process.off('SIGWINCH', this.onResize)
    if (this.timer) clearInterval(this.timer)
    if (this.navigationTimer) clearInterval(this.navigationTimer)
    if (this.scheduled) clearTimeout(this.scheduled)
    this.timer = this.navigationTimer = this.scheduled = undefined
    this.options.stdout.write(ALT_SCREEN_LEAVE)
  }

  /** 行式终端的一行输出：整行进入转录，去掉行式终端为分隔打印的首尾空行。 */
  line(text: string): void {
    const rows = (this.partial + text).split('\n')
    this.partial = ''
    while (rows.length && rows[0] === '') rows.shift()
    while (rows.length && rows.at(-1) === '') rows.pop()
    this.transcript.push(...rows)
    if (!this.paused) this.invalidate()
  }

  /** 模型流等无换行输出：保留未完成行，下一块继续。 */
  write(text: string): void { this.append(text) }
  append(text: string): void {
    const value = this.partial + text
    const parts = value.split('\n')
    this.partial = parts.pop() ?? ''
    for (const part of parts) this.transcript.push(part)
    if (this.partial.length > 4096) { this.transcript.push(this.partial); this.partial = '' }
    if (!this.paused) this.invalidate()
  }

  /** 标记需要重画；空闲周期之外再合并调度一次立即重画，按键回显不必等刷新间隔。 */
  invalidate(): void {
    this.dirty = true
    if (this.scheduled || !this.active || this.paused) return
    this.scheduled = setTimeout(() => { this.scheduled = undefined; void this.tickRender() }, 0)
  }

  /** 导航/状态变化后由运行层调用，保证面板不落后于原生 owner。 */
  async refreshNavigation(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    try {
      const workspaces = await this.runtime.navigation(signal)
      if (signal.aborted || this.paused) return
      this.workspaces = workspaces
      const rows = navRows(this.workspaces)
      const current = this.selectedSession()
      const at = rows.findIndex(row => row.kind === 'session' && row.sessionId === current)
      if (at >= 0 && this.navIndex < 0) this.navIndex = at
      else if (this.navIndex >= rows.length) this.navIndex = moveNavIndex(rows, rows.length, -1)
      this.invalidate()
    } catch (reason) {
      if (!signal.aborted) this.runtime.note(`[全屏] 导航读取失败：${reason instanceof Error ? reason.message : String(reason)}`)
    }
  }

  /** 全屏自己消费的按键（Tab/方向/翻页），其余字节按原顺序交回 readline 与粘贴管线。 */
  route(chunk: Buffer): Buffer | undefined {
    // latin1 与字节一一对应：未消费的按键回到原位置，UTF-8 多字节与控制字节都不改写。
    let forward = ''
    for (const segment of routeSegments(chunk.toString('latin1'))) {
      if (segment.kind === 'text') forward += segment.text
      else if (!this.handleKey(segment.key)) forward += keySequence(segment.key)
    }
    return forward.length ? Buffer.from(forward, 'latin1') : undefined
  }

  private handleKey(key: FullscreenKey): boolean {
    if (key === 'tab') {
      // 编辑器里有内容时 Tab 仍是原生的补全；空行上的 Tab 才切换焦点（Shift+Tab 始终反向切换）。
      if (this.focus === 'editor' && this.runtime.editor().line.length > 0) return false
      this.focus = nextFocus(this.focus, 1)
      this.noteText = `[全屏] 焦点 ${focusLabel(this.focus)}`
      this.invalidate(); return true
    }
    if (key === 'backtab') {
      this.focus = nextFocus(this.focus, -1)
      this.noteText = `[全屏] 焦点 ${focusLabel(this.focus)}`
      this.invalidate(); return true
    }
    if (this.focus === 'nav') {
      if (key === 'up' || key === 'down') {
        const rows = navRows(this.workspaces)
        this.navIndex = moveNavIndex(rows, this.navIndex, key === 'up' ? -1 : 1)
        const id = navSelectionId(rows, this.navIndex)
        this.noteText = id ? `[全屏] 选中 ${id}；Enter 打开` : '[全屏] 当前没有可选择会话'
        this.invalidate(); return true
      }
      if (key === 'enter') {
        const id = navSelectionId(navRows(this.workspaces), this.navIndex)
        if (id) void this.open(id)
        else this.noteText = '[全屏] 当前没有可选择会话'
        this.invalidate(); return true
      }
      return this.scrollKey(key)
    }
    if (this.focus === 'transcript') return this.scrollKey(key)
    // 编辑器焦点：方向键、Home/End、Tab 之外的编辑行为全部留在 readline，全屏不重复实现编辑器。
    return false
  }

  private scrollKey(key: FullscreenKey): boolean {
    const plan = layout(this.size())
    const body = Math.max(1, plan.body)
    const total = this.totalRows(plan.transcriptWidth)
    switch (key) {
      case 'up': this.scrollBack += 1; break
      case 'down': this.scrollBack -= 1; break
      case 'page-up': this.scrollBack += body; break
      case 'page-down': this.scrollBack -= body; break
      case 'home': this.scrollBack = total; break
      case 'end': this.scrollBack = 0; break
      default: return false
    }
    this.scrollBack = clampScroll(total, body, this.scrollBack)
    this.noteText = undefined
    this.invalidate(); return true
  }

  private async open(id: string): Promise<void> {
    this.noteText = `[全屏] 打开会话 ${id}`
    this.invalidate()
    try { await this.runtime.openSession(id) } catch (reason) { this.runtime.note(`[全屏] 打开会话失败：${reason instanceof Error ? reason.message : String(reason)}`) }
    await this.refreshNavigation(new AbortController().signal)
  }

  private selectedSession(): string | undefined { return this.runtime.status().sessionId }

  /** 转录折行后的总行数（含尚未换行的当前增量行）：滚动夹紧与画面窗口用同一笔账。 */
  private totalRows(width: number): number { return transcriptRows(this.transcript, width, this.partial) }

  private view(): FullscreenView {
    const status = this.runtime.status()
    const editor = this.runtime.editor()
    return {
      size: this.size(), workspaces: this.workspaces, navIndex: this.navIndex, transcript: this.transcript,
      partial: this.partial,
      editor: { draft: editor.draft, line: editor.line, cursor: editor.cursor },
      status: { ...status, focus: this.focus, scrollBack: this.scrollBack, ...(this.noteText ? { note: this.noteText } : {}) },
    }
  }

  /** 一帧；内容未变不写终端，避免无意义流量与被测试转录放大。 */
  render(): string[] {
    const rows = renderFrame(this.view())
    const text = frameText(rows)
    if (!this.paused && text !== this.lastFrame) { this.lastFrame = text; this.options.stdout.write(text) }
    return rows
  }

  private async tickRender(): Promise<void> {
    if (!this.active || this.paused) return
    if (!this.dirty && this.tick % 5 !== 0) return
    this.dirty = false
    this.render()
  }

  private readonly onResize = () => {
    const plan = layout(this.size())
    const total = this.totalRows(plan.transcriptWidth)
    this.scrollBack = clampScroll(total, Math.max(1, plan.body), this.scrollBack)
    this.lastFrame = ''
    this.invalidate()
    void this.tickRender()
  }

  /** 仅供无 TTY 的单元测试与 PTY 驱动核对画面。 */
  snapshot(): { rows: string[]; focus: FullscreenFocus; scrollBack: number; width: number } {
    const rows = renderFrame(this.view())
    return { rows, focus: this.focus, scrollBack: this.scrollBack, width: displayWidth(rows[0] ?? '') }
  }
}
