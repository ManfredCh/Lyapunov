import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

export type TerminalClipboardBackend = 'wl-paste' | 'xclip' | 'xsel'
export type TerminalClipboardContent =
  | { readonly kind: 'text'; readonly text: string; readonly backend: TerminalClipboardBackend }
  | { readonly kind: 'image'; readonly data: Uint8Array; readonly mediaType: ImageMediaType; readonly name: string; readonly backend: TerminalClipboardBackend }

export interface TerminalClipboardOptions {
  /** auto优先读取原生支持的图片；text/image可由用户显式选择。 */
  readonly kind?: 'auto' | 'text' | 'image'
  readonly signal: AbortSignal
  /** 使用调用者的显示会话；测试传独立DISPLAY，绝不回退到其他显示会话。 */
  readonly env?: NodeJS.ProcessEnv
  /** 明确指定现成工具路径；缺省从PATH查找，不下载或安装工具。 */
  readonly tools?: Partial<Record<TerminalClipboardBackend, string>>
  /** 命令输出上限；调用者可传入原生图片大小限制。 */
  readonly maxBytes?: number
}

const imageTypes: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const imageExtension: Readonly<Record<ImageMediaType, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const textTypes = ['text/plain;charset=utf-8', 'text/plain;charset=UTF-8', 'UTF8_STRING', 'text/plain', 'TEXT', 'STRING']

async function executable(name: TerminalClipboardBackend, options: TerminalClipboardOptions, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const configured = options.tools?.[name]
  const paths = configured ? [configured] : (env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, name))
  for (const path of paths) {
    options.signal.throwIfAborted()
    try { await access(path, constants.X_OK); return path } catch {}
  }
  if (configured) throw new Error(`CLIPBOARD_TOOL_UNAVAILABLE: 指定的 ${name} 工具不可执行。`)
  return undefined
}

/** 只有用户显式请求时才调用；结果仍由现有UI草稿/原生附件服务接收。 */
export async function readTerminalClipboard(options: TerminalClipboardOptions): Promise<TerminalClipboardContent> {
  options.signal.throwIfAborted()
  const env = options.env ?? process.env, kind = options.kind ?? 'auto'
  let backend: TerminalClipboardBackend | undefined, path: string | undefined
  if (env.WAYLAND_DISPLAY) {
    path = await executable('wl-paste', options, env)
    if (path) backend = 'wl-paste'
  }
  if (!path && env.DISPLAY) {
    path = await executable('xclip', options, env)
    if (path) backend = 'xclip'
    else if (kind !== 'image') {
      path = await executable('xsel', options, env)
      if (path) backend = 'xsel'
    }
  }
  if (!backend || !path) throw new Error('CLIPBOARD_UNAVAILABLE: 当前显示会话缺少可用剪贴板工具；Wayland需要wl-paste，X11图片需要xclip，文本也可使用xsel。')
  const program = path, selected = backend
  const run = (args: readonly string[]): Promise<Buffer> => new Promise((resolve, reject) => {
    options.signal.throwIfAborted()
    execFile(program, [...args], { env, encoding: 'buffer', signal: options.signal, timeout: 15000, maxBuffer: options.maxBytes ?? 64 * 1024 * 1024 }, (error, stdout) => {
      if (options.signal.aborted) reject(options.signal.reason ?? new Error('CLIPBOARD_CANCELLED: 剪贴板读取已取消。'))
      else if (error) reject(new Error(`CLIPBOARD_READ_FAILED: ${selected} 读取失败（${error.code ?? error.message}）。`))
      else resolve(stdout)
    })
  })
  if (backend === 'xsel') return { kind: 'text', text: (await run(['--clipboard', '--output'])).toString('utf8'), backend }
  const advertised = (await run(backend === 'wl-paste' ? ['--list-types'] : ['-selection', 'clipboard', '-out', '-target', 'TARGETS'])).toString('utf8').split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  const imageType = kind !== 'text' ? imageTypes.find(type => advertised.includes(type)) : undefined
  const target = imageType ?? (kind !== 'image' ? textTypes.find(type => advertised.includes(type)) : undefined)
  if (!target) throw new Error(`CLIPBOARD_CONTENT_UNAVAILABLE: 剪贴板没有${kind === 'image' ? '受支持的图片' : kind === 'text' ? '文本' : '受支持的文本或图片'}。`)
  const data = await run(backend === 'wl-paste' ? ['--no-newline', '--type', target] : ['-selection', 'clipboard', '-out', '-target', target])
  options.signal.throwIfAborted()
  return imageType ? { kind: 'image', data, mediaType: imageType, name: `clipboard.${imageExtension[imageType]}`, backend } : { kind: 'text', text: data.toString('utf8'), backend }
}
