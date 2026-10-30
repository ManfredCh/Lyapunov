/**
 * F01 回归：工作区终端不再自己持有 PTY/backlog/SSE，而是薄适配原生
 * `TerminalController`（Host）与会话 owner。这里用真实 controller + 受控 subprocess 替身
 * 钉住三件事：同名终端身份在两个会话里各自成立、输入只能由当前 attachment 写、
 * 关闭等待真实进程清理且不连带其他会话。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { TerminalController, type Config } from '@deepseek-ai/dsh-api-terminal-controller'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TerminalAttachmentId, WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'

const config: Config = {
  shell: { path: '/bin/bash', name: 'bash', args: ['--noprofile', '--norc', '-i'] },
  shellCandidates: ['bash'], maxTerminals: 4, maxCols: 200, maxRows: 100, scrollback: 100,
  maxBufferedBytes: 100_000, maxInputBytes: 1000, disposeGraceMs: 100,
  unattendedTimeoutMs: 0, activityPollIntervalMs: 30_000, cleanupRetryMs: 60_000,
}
const signal = () => new AbortController().signal
const id = 'same-terminal' as WebTerminalId
const roots: Context[] = []
afterEach(async () => { await Promise.allSettled(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

function owner(ctx: Context, session: string): Agent {
  return { id: session as SessionId, ctx, session: { id: session as SessionId, header: { id: session as SessionId, cwd: '/workspace' } } } as unknown as Agent
}

function fixture() {
  const ctx = new Context()
  roots.push(ctx)
  const handles: Array<{ written: string[]; release: () => void }> = []
  const subprocess = {
    terminalEnvironment: async () => ({ platform: 'posix', defaultShell: '/bin/bash' }),
    resolveExecutable: async (path: string) => path,
    spawnTerminal: async () => {
      const output = new PassThrough()
      const done = Promise.withResolvers<{ exitCode: number; signal: null }>()
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const written: string[] = []
      const handle = {
        pid: handles.length + 1, output, done: done.promise,
        write: async (data: string) => { written.push(data) }, resize: async () => {},
        inspectActivity: async () => ({ state: 'idle', revision: 0 }),
        inspectForeground: async () => undefined, signalForeground: async () => 1,
        terminate: async () => { await gate; output.end(); done.resolve({ exitCode: 0, signal: null }) },
      }
      handles.push({ written, release })
      return handle
    },
  }
  ctx.provide('subprocess', subprocess as never)
  ctx.provide('sandboxPolicy', { defaultMode: 'danger-full-access', workspaceRoot: '/workspace', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '/workspace' }) } as never)
  return { ctx, controller: new TerminalController(ctx, config), handles }
}

describe('工作区终端收敛到原生会话 owner', () => {
  test('两个会话可各自运行同名终端，输入只接受当前 attachment', async () => {
    const { ctx, controller, handles } = fixture()
    const a = owner(ctx, 'session-a'), b = owner(ctx, 'session-b')
    try {
      await controller.create(a, { id, cols: 80, rows: 24 }, signal())
      await controller.create(b, { id, cols: 80, rows: 24 }, signal())
      expect(controller.list(a.id)).toHaveLength(1)
      expect(controller.list(b.id)).toHaveLength(1)

      const streamA = controller.follow(a, id, 'attach-a' as TerminalAttachmentId, signal())[Symbol.asyncIterator]()
      const streamB = controller.follow(b, id, 'attach-b' as TerminalAttachmentId, signal())[Symbol.asyncIterator]()
      expect((await streamA.next()).value).toMatchObject({ type: 'snapshot' })
      expect((await streamB.next()).value).toMatchObject({ type: 'snapshot' })

      await controller.write(a, id, 'attach-a' as TerminalAttachmentId, 'a')
      await controller.write(b, id, 'attach-b' as TerminalAttachmentId, 'b')
      expect(handles[0]!.written).toEqual(['a'])
      expect(handles[1]!.written).toEqual(['b'])
      await expect(controller.write(a, id, 'attach-b' as TerminalAttachmentId, 'cross')).rejects.toThrow('another attachment')
      await streamA.return?.()
      await streamB.return?.()
    } finally {
      handles.forEach(handle => handle.release())
      await Promise.allSettled([controller.close(a, id), controller.close(b, id)])
    }
  })

  test('关闭当前终端等待真实进程清理，其他会话的同名终端保持运行', async () => {
    const { ctx, controller, handles } = fixture()
    const a = owner(ctx, 'session-a'), b = owner(ctx, 'session-b')
    try {
      await controller.create(a, { id, cols: 80, rows: 24 }, signal())
      await controller.create(b, { id, cols: 80, rows: 24 }, signal())
      let closed = false
      const closing = controller.close(a, id).then(() => { closed = true })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(closed).toBe(false)
      handles[0]!.release()
      await closing
      expect(closed).toBe(true)
      expect(controller.list(a.id)).toEqual([])
      expect(controller.list(b.id)).toHaveLength(1)
    } finally {
      handles.forEach(handle => handle.release())
      await Promise.allSettled([controller.close(a, id), controller.close(b, id)])
    }
  })

  test('工作区宿主不再保留第二套 PTY、全局 backlog 或 xterm SSE 通道', () => {
    const source = readFileSync(new URL('../src/plugin.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('node-pty')
    expect(source).not.toContain('xtermSessions')
    expect(source).not.toContain('xterm-output')
    expect(source).not.toContain('xterm-spawn')
  })

  test('客户端终端入口汇入原生侧栏，不再创建产品 TerminalView 或自建 xterm 宿主', () => {
    const client = readFileSync(new URL('../src/client.tsx', import.meta.url), 'utf8')
    const session = readFileSync(new URL('../src/workspace-session.tsx', import.meta.url), 'utf8')
    expect(client).toContain('openTabIn(sessionId as SessionId,"terminal")')
    expect(client).not.toContain('webTerminals')
    expect(client).not.toContain('TerminalPanel')
    expect(session).not.toContain('TerminalXterm')
    expect(session).not.toContain('terminalSlots')
    expect(session).not.toContain('webTerminals')
    // 旧私有 xterm 宿主文件已删除：不存在“只在测试里保留”的第二套实现。
    expect(existsSync(new URL('../src/terminal-xterm.tsx', import.meta.url))).toBe(false)
    expect(existsSync(new URL('../src/xterm-style.ts', import.meta.url))).toBe(false)
  })
})
