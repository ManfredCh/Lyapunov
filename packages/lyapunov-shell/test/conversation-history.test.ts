/**
 * `conversation-history.ts` 的单元覆盖。
 *
 * 这些函数原先住在 `jev-context-routing.ts` 里、由其 380 行测试顺带覆盖。Jev 退役时它们被提取成
 * 独立模块（引擎安装授权与规则路由都用它们取真实输入，与"用不用 LLM 路由"无关），
 * 原测试随 Jev 一起删除 ⇒ 提取出来的模块失去覆盖。本文件补上这一块。
 */
import { expect, test } from 'bun:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { isCompactionSummary, isRoutingInput, isTaskIntent, isUserIntent, latestUserText, routingHistory } from '../src/conversation-history.ts'

const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const annotation = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'lyapunov-annotation' } as never })
const assistant = (text: string): Message => ({ role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } as never)
const pointerHint = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'lyapunov-domain-pointer' } as never })
const promptSnapshot = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } as never })
const compaction = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'compact' } as never })
const systemMessage = (text: string): Message => ({ role: 'system', content: [{ type: 'text', text }], source: { kind: 'user' } } as never)

/** 最小 Session 替身：只提供本模块读的两个成员（surface.nodes 与 eventAt）。 */
function sessionOf(events: Array<Message | undefined>): Session {
  return {
    surface: { nodes: events.map((_, index) => index) },
    eventAt: (seq: number) => {
      const message = events[seq]
      return message === undefined ? undefined : { type: 'user/message', data: message }
    },
  } as unknown as Session
}

test('意图判定：普通用户消息与视口批注都算用户意图，模型回复不算', () => {
  expect(isUserIntent(user('你好'))).toBe(true)
  expect(isUserIntent(annotation('这里放大一点'))).toBe(true)
  expect(isUserIntent(assistant('好的'))).toBe(false)
  expect(isUserIntent(pointerHint('域指针'))).toBe(false)
})

test('压缩摘要判定：认 compact 插件来源，其余 plugin 来源不算', () => {
  expect(isCompactionSummary(compaction('压缩后的任务摘要'))).toBe(true)
  expect(isCompactionSummary(promptSnapshot('系统提示快照'))).toBe(false)
  expect(isCompactionSummary(user('普通消息'))).toBe(false)
})

test('任务意图 = 用户意图 ∪ 压缩摘要', () => {
  expect(isTaskIntent(user('a'))).toBe(true)
  expect(isTaskIntent(annotation('b'))).toBe(true)
  expect(isTaskIntent(compaction('c'))).toBe(true)
  expect(isTaskIntent(assistant('d'))).toBe(false)
})

test('判定输入排除：不认自己注入的域指针与 system-prompt 快照，system 角色也不认', () => {
  expect(isRoutingInput(user('x'))).toBe(true)
  expect(isRoutingInput(assistant('x'))).toBe(true)
  expect(isRoutingInput(compaction('x'))).toBe(true)
  expect(isRoutingInput(pointerHint('x'))).toBe(false)
  expect(isRoutingInput(promptSnapshot('x'))).toBe(false)
  expect(isRoutingInput(systemMessage('x'))).toBe(false)
})

test('routingHistory：只留可作判定的消息，并保住被挤出窗口的任务意图', () => {
  const history = routingHistory(sessionOf([
    user('第一条意图'),
    assistant('回复'),
    pointerHint('旧的路由提示：不该进历史'),
    promptSnapshot('快照：不该进历史'),
    ...Array.from({ length: 20 }, (_, index) => assistant(`工具回执 ${index}`)),
  ]))
  expect(history.some(message => message.content.some(block => block.type === 'text' && block.text === '旧的路由提示：不该进历史'))).toBe(false)
  expect(history.some(message => message.content.some(block => block.type === 'text' && block.text === '快照：不该进历史'))).toBe(false)
  // 第一条意图被 20 条工具回执挤出 16 条窗口，但因是最近一条用户意图而被保住。
  expect(history.some(message => message.content.some(block => block.type === 'text' && block.text === '第一条意图'))).toBe(true)
  expect(history.length).toBeLessThanOrEqual(17)
})

test('latestUserText：本步消息优先于历史，压缩摘要可作为当前意图，都没有就是空串', () => {
  expect(latestUserText({ messages: [assistant('回复')], history: [user('历史意图')] })).toBe('历史意图')
  expect(latestUserText({ messages: [user('本步意图')], history: [user('历史意图')] })).toBe('本步意图')
  expect(latestUserText({ messages: [assistant('回复')], history: [compaction('压缩摘要')] })).toBe('压缩摘要')
  expect(latestUserText({ messages: [assistant('回复')], history: [assistant('另一条回复')] })).toBe('')
})

test('负对照：只有域指针/快照时，取不到任何意图文本（不把注入内容当用户意图）', () => {
  expect(latestUserText({ messages: [pointerHint('域指针')], history: [promptSnapshot('快照')] })).toBe('')
  expect(routingHistory(sessionOf([pointerHint('a'), promptSnapshot('b')]))).toEqual([])
})
