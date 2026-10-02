/**
 * DEV-035 呈现边界：初始化说明／工程上下文**不得**作为普通用户消息进展示流。
 *
 * 完成条件里与产品呈现面有关的一条是「初始化说明不作为普通用户消息泄露到展示流」。本文件把它钉成回归：
 *   ① 插件装配（= 会话可用的起点）**一次用户消息都不投递**——初始化说明如果被"发进对话"，这里必然非空；
 *   ② 产品自己的工程上下文（`plugin.ts` 的 `lyapunov-product-agent`）注册在 `ctx.systemPrompt.context`，
 *      是模型侧上下文，不是用户消息；
 *   ③ 全包只有**两处** `agent.send(`，都发生在用户点击后（批注投递／截图发给模型），且都经
 *      `createUserMessage(..., source:{kind:"lyapunov-annotation"})` 标注界面来源——展示流能把它
 *      与"人打的字"分开；新增第三处（例如把调试上下文自动塞进对话）会当场失败。
 *
 * 真实浏览器侧的同一条断言（新会话首屏 + 一次真实交互后的消息流）由 computer-use 证据负责，见
 * `bugfixHistory/DEV035-SURFACE-LINES-20260921.md`；本文件不启动浏览器，也不证明模型回复长短。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { isolateProviderInstaller } from './fixtures/isolated-provider-installer.ts'

const SESSION = 'session-dev035'
const SOURCE_DIR = resolve(import.meta.dirname, '../src')
const PLUGIN_SOURCE = readFileSync(join(SOURCE_DIR, 'plugin.ts'), 'utf8')

/** 最薄宿主：真实 cordis + 真 `plugin.ts`，只装配插件注册期会碰到的服务面（与 target-window.test.ts 同一手法）。 */
async function boot() {
  const root = await mkdtemp(join(tmpdir(), 'lyapunov-dev035-'))
  const ctx = new Context() as any
  // Provider installer registration attaches a native Jobs controller; no installer job is started here.
  await ctx.plugin(JobsLocal)
  const sent: Array<Record<string, unknown>> = []
  const prompts: Array<{ name: string; text: (args: { scope?: unknown }) => string }> = []
  const agent = {
    id: SessionId(SESSION), steer() {}, inject() {},
    /** 模型侧真实接口：任何"投进对话"的用户消息都会经过它。 */
    send: (message: unknown) => { sent.push(message as Record<string, unknown>) },
    session: { id: SESSION, header: { id: SESSION }, append: () => undefined, snapshotEvents: () => [] },
  }
  ctx.provide('connection', { fetch: { register: () => () => undefined } })
  // settings 替身按真实形状：`register` 进命名空间表，`describe` 读回它（preferences-host 依赖这条链）。
  const namespaces = new Set<string>()
  ctx.provide('settings', {
    register: (ns: string) => { namespaces.add(ns); return () => namespaces.delete(ns) },
    describe: () => [...namespaces].map(ns => ({ ns, user: undefined, revision: 1, value: {} })),
    mutate: async () => undefined, replace: async () => undefined,
  })
  ctx.provide('scene', { forSession: () => ({ scene: { snapshot: async () => { throw new Error('SCENE_UNUSED') } }, list: async () => [] }) })
  ctx.provide('agents', { get: () => agent })
  ctx.provide('sessions', { flush: async () => undefined })
  ctx.provide('sessionController', { resolveAgent: async () => ({ agent }) })
  ctx.provide('commands', { register: () => () => undefined, execute: async () => undefined })
  ctx.provide('systemPrompt', {
    section: (section: { name: string; text: string }) => { prompts.push({name: section.name, text: () => section.text}) },
    context: (section: { name: string; text: (args: { scope?: unknown }) => string }) => { prompts.push(section) },
  })
  ctx.provide('tools', { register: () => () => undefined, get: () => undefined })
  ctx.provide('attachments', { saveImage: async () => ({}), readImage: async () => ({ data: new Uint8Array() }) })
  const dispose = async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } }
  const routerMode = process.env.LYAPUNOV_CONTEXT_ROUTER
  let installerIsolation: ReturnType<typeof isolateProviderInstaller> | undefined
  try {
    installerIsolation = isolateProviderInstaller(root)
    // Assert the rules-mode product context without enabling an ambient model router.
    process.env.LYAPUNOV_CONTEXT_ROUTER = 'rules'
    const { apply } = await import('../src/plugin.ts')
    await apply(ctx as never, { captureRoot: join(root, 'captures'), recordingRoot: join(root, 'recordings') } as never)
    installerIsolation.assertCalled()
  } catch (error) {
    await dispose()
    throw error
  } finally {
    installerIsolation?.restore()
    if (routerMode === undefined) delete process.env.LYAPUNOV_CONTEXT_ROUTER
    else process.env.LYAPUNOV_CONTEXT_ROUTER = routerMode
  }
  return { sent, prompts, dispose }
}

describe('DEV-035 初始化说明不进普通消息流', () => {
  test('装配期零投递：初始化说明没有被"发进对话"', async () => {
    const host = await boot()
    try {
      expect(host.sent).toEqual([])
    } finally { await host.dispose() }
  })

  test('工程上下文只走原生 system prompt section（模型侧），同一段文字不作为用户消息出现', async () => {
    const host = await boot()
    try {
      const product = host.prompts.find(section => section.name === 'lyapunov-product-agent')
      expect(product).toBeDefined()
      const text = product!.text({})
      expect(text).toContain("assistant for the Lyapunov workbench")
      // 工程细节（computer-use 投递模式等）确实是模型侧上下文，而不是会话里的用户消息。
      expect(host.sent.some(message => JSON.stringify(message).includes('delivery_mode'))).toBe(false)
      expect(host.sent.some(message => JSON.stringify(message).match(/场内 agent|assistant for the Lyapunov workbench/))).toBe(false)
    } finally { await host.dispose() }
  })

  test('投递面只有两处，且都是用户发起 + 标注界面来源（新增自动投递会失败）', () => {
    const callSites = [...PLUGIN_SOURCE.matchAll(/agent\.send\(/g)]
    expect(callSites.length).toBe(2)
    for (const match of callSites) {
      const before = PLUGIN_SOURCE.slice(Math.max(0, (match.index ?? 0) - 5000), match.index)
      // 共享 feedbackMessage 构造真实界面来源消息；两个发送点都必须位于该路径。
      expect(PLUGIN_SOURCE).toContain('createUserMessage')
      expect(before).toContain('feedbackMessage')
      expect(PLUGIN_SOURCE).toContain('lyapunov-annotation')
    }
    // 投递内容里不得出现工作区约定/初始化说明这类工程台词。
    for (const phrase of ['工作区约定', '不复述初始化要求', 'AGENTS.md']) {
      expect(PLUGIN_SOURCE).not.toContain(phrase)
    }
  })
})
