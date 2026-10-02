import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TerminalEditorInput {
  readonly text: string
  readonly cwd: string
  readonly signal: AbortSignal
  /** 缺省沿用 VISUAL，然后 EDITOR；命令仅拆为 argv，不经过 shell。 */
  readonly editor?: string
  /** 暂停当前终端输入并移交 TTY，返回恢复函数；部分失败由调用方恢复。 */
  readonly suspend: () => (() => void | Promise<void>) | Promise<() => void | Promise<void>>
}

/** 解析编辑器程序和固定参数，允许引号与反斜杠；不展开环境变量或执行 shell 表达式。 */
export function editorArgv(command: string): string[] {
  const words: string[] = []
  let word = '', quote = '', started = false
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (char === '\\' && quote !== "'") {
      const next = command[++index]
      if (next === undefined) throw new Error('EDITOR_INVALID: 编辑器命令以不完整转义结束。')
      word += next; started = true
    } else if (quote) {
      if (char === quote) quote = ''
      else word += char
    } else if (char === '"' || char === "'") { quote = char; started = true }
    else if (/\s/u.test(char)) {
      if (started) { words.push(word); word = ''; started = false }
    } else { word += char; started = true }
  }
  if (quote) throw new Error('EDITOR_INVALID: 编辑器命令的引号未闭合。')
  if (started) words.push(word)
  if (!words[0]) throw new Error('EDITOR_NOT_CONFIGURED: 请设置 VISUAL 或 EDITOR 后使用外部编辑器。')
  return words
}

/** 成功时返回完整编辑结果；失败/取消不发布文本，调用方保留原草稿和附件。 */
export async function openTerminalEditor(input: TerminalEditorInput): Promise<string> {
  input.signal.throwIfAborted()
  const argv = editorArgv(input.editor ?? (process.env.VISUAL || process.env.EDITOR || ''))
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('INPUT_REQUIRES_TTY: 外部编辑器需要交互终端。')
  const directory = await mkdtemp(join(tmpdir(), 'lyapunov-draft-'))
  const path = join(directory, 'draft.md')
  let restore: (() => void | Promise<void>) | undefined
  try {
    await writeFile(path, input.text, { encoding: 'utf8', mode: 0o600, flag: 'wx', signal: input.signal })
    input.signal.throwIfAborted()
    restore = await input.suspend()
    input.signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const child = spawn(argv[0]!, [...argv.slice(1), path], { cwd: input.cwd, stdio: 'inherit', shell: false })
      let failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined
      const cancel = (): void => {
        child.kill('SIGTERM')
        killTimer ??= setTimeout(() => { child.kill('SIGKILL') }, 1000)
      }
      child.once('error', error => { failure = error })
      child.once('close', (code, signal) => {
        input.signal.removeEventListener('abort', cancel)
        if (killTimer) clearTimeout(killTimer)
        if (input.signal.aborted) reject(input.signal.reason ?? new Error('EDITOR_CANCELLED: 外部编辑已取消。'))
        else if (failure) reject(failure)
        else if (code !== 0) reject(new Error(`EDITOR_FAILED: 编辑器退出 ${signal ?? code}，草稿未变。`))
        else resolve()
      })
      input.signal.addEventListener('abort', cancel, { once: true })
      if (input.signal.aborted) cancel()
    })
    input.signal.throwIfAborted()
    return await readFile(path, { encoding: 'utf8', signal: input.signal })
  } finally {
    try { await restore?.() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
}
