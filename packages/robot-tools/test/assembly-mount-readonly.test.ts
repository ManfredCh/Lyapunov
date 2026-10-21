/**
 * `robot_assembly_mount` 的真实工具派发门禁（不是函数级替身）：
 *  · save/clear 是用户请求的持久修改 → read-only 会话在操作边界被 `SCENE_POLICY_READ_ONLY` 拒绝，零落盘；
 *  · 不带 save/clear 的纯读查询保持会话归属与 expectedRevision 检查，在 read-only 会话里照常返回。
 *
 * 原生侧用真 `@deepseek-ai/cordis` ToolRegistry + 真 scene-kit 插件 + 真 SceneStore（临时 dataRoot）；
 * 只有 `sandboxPolicy` 与会话归属按产品同一条 `requireWritableScene` 链注入模式。这里不证明原生挂接。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Commands from '@deepseek-ai/dsh-commands'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as scenePlugin from '../../scene-kit/src/plugin.ts'
import * as robotTools from '../src/plugin.ts'

let base: string, ctx: Context, agent: Agent, calls = 0, mode: 'read-only' | 'workspace-write'

async function runtime(dataRoot: string): Promise<{ ctx: Context; agent: Agent }> {
  const target = new Context()
  await target.plugin(SystemPrompt)
  await target.plugin(Tools)
  await target.plugin(Sessions)
  await target.plugin(Commands)
  target.reflect.provide('sandboxPolicy', { resolve: () => ({ mode, workspaceRoot: base }) } as never)
  await target.plugin(scenePlugin, { dataRoot, productRoot: join(base, 'no-bundled-product') })
  // 会话世界服务只在本用例里被 mount 读取路径按需取；只读查询不触碰它。
  target.reflect.provide('sim', { forSession: () => ({ listWorlds: async () => [] }) } as never)
  await target.plugin(robotTools)
  const session = target.sessions.create(SessionId(`mount-readonly-${++calls}`))
  return { ctx: target, agent: { id: session.id, session } as Agent }
}
async function callTool(target: Context, owner: Agent, name: string, input: unknown): Promise<ToolExecutionResult> {
  return await target.tools.execute({ callId: ToolCallId(`${name}-${++calls}`), name, arguments: { input }, signal: new AbortController().signal, agent: owner })
}
const textOf = (result: ToolExecutionResult) => result.content.filter(block => block.type === 'text').map(block => block.text).join('')

beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'lyapunov-mount-ro-')); calls = 0 })
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

describe('robot_assembly_mount 的读写门禁', () => {
  test('save/clear 在 read-only 被拒且零落盘；纯读查询在 read-only 照常（含 revision 检查）', async () => {
    mode = 'workspace-write'
    const { ctx: writeCtx, agent: writeAgent } = await runtime(join(base, 'write'))
    expect((await callTool(writeCtx, writeAgent, 'scene_create', { sceneId: 's' })).isError).toBe(false)
    const added = await callTool(writeCtx, writeAgent, 'scene_edit', {
      sceneId: 's', expectedRevision: 0,
      patch: [{ op: 'add', entity: { entityId: 'hand', name: 'hand', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [{ resourceId: 'hand', version: 1, original: { uri: 'file:///tmp/hand.xml', mimeType: 'application/x-mjcf+xml' }, representations: [], source: { units: 'm', upAxis: 'Z', handedness: 'right' } }], components: {} } }],
    })
    expect(added.isError).toBe(false)
    mode = 'read-only'
    // 纯读：无保存点时返回空读事实，而不是 SCENE_POLICY_READ_ONLY。
    const emptyRead = await callTool(writeCtx, writeAgent, 'robot_assembly_mount', { sceneId: 's', entityId: 'hand', expectedRevision: 1 })
    expect(emptyRead.isError).toBe(false)
    expect(JSON.parse(textOf(emptyRead))).toMatchObject({ saved: true, changed: false, revision: 1 })
    // 纯读也保持 revision 检查：过期请求明确失败，且不是策略门禁。
    const staleRead = await callTool(writeCtx, writeAgent, 'robot_assembly_mount', { sceneId: 's', entityId: 'hand', expectedRevision: 0 })
    expect(staleRead.isError).toBe(true)
    expect(textOf(staleRead)).toContain('SCENE_REVISION_MISMATCH')
    // save 是持久写：read-only 直接拒绝，且磁盘无新版本。
    const denied = await callTool(writeCtx, writeAgent, 'robot_assembly_mount', { sceneId: 's', entityId: 'hand', expectedRevision: 1, save: { kind: 'body-origin', bodyName: 'palm' }, rootBodyName: 'palm' })
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('SCENE_POLICY_READ_ONLY')
    const stillOne = await callTool(writeCtx, writeAgent, 'scene_inspect', { sceneId: 's' })
    expect(JSON.parse(textOf(stillOne)).revision).toBe(1)

    // 可写会话保存成功后，只读会话仍能读到已保存点（不是"只读什么都读不到"）。
    mode = 'workspace-write'
    const saved = await callTool(writeCtx, writeAgent, 'robot_assembly_mount', { sceneId: 's', entityId: 'hand', expectedRevision: 1, save: { kind: 'body-origin', bodyName: 'palm' }, rootBodyName: 'palm' })
    expect(saved.isError).toBe(false)
    expect(JSON.parse(textOf(saved))).toMatchObject({ changed: true, revision: 2, mount: { rootBodyName: 'palm', mount: { kind: 'body-origin', bodyName: 'palm' } } })
    mode = 'read-only'
    const read = await callTool(writeCtx, writeAgent, 'robot_assembly_mount', { sceneId: 's', entityId: 'hand', expectedRevision: 2 })
    expect(read.isError).toBe(false)
    expect(JSON.parse(textOf(read))).toMatchObject({ changed: false, revision: 2, mount: { rootBodyName: 'palm' } })
    // clear 同样是持久写：read-only 拒绝。
    const clearDenied = await callTool(writeCtx, writeAgent, 'robot_assembly_mount', { sceneId: 's', entityId: 'hand', expectedRevision: 2, clear: true })
    expect(clearDenied.isError).toBe(true)
    expect(textOf(clearDenied)).toContain('SCENE_POLICY_READ_ONLY')
    expect(JSON.parse(textOf(await callTool(writeCtx, writeAgent, 'scene_inspect', { sceneId: 's' }))).revision).toBe(2)
  }, 20_000)

  test('会话归属：同一 Host 的另一会话不能读到本会话的保存点（各自 SceneStore 归属）', async () => {
    mode = 'workspace-write'
    const { ctx: shared, agent: agentA } = await runtime(join(base, 'owner'))
    expect((await callTool(shared, agentA, 'scene_create', { sceneId: 's' })).isError).toBe(false)
    await callTool(shared, agentA, 'scene_edit', { sceneId: 's', expectedRevision: 0, patch: [{ op: 'add', entity: { entityId: 'hand', name: 'hand', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [{ resourceId: 'hand', version: 1, original: { uri: 'file:///tmp/hand.xml', mimeType: 'application/x-mjcf+xml' }, representations: [], source: { units: 'm', upAxis: 'Z', handedness: 'right' } }], components: {} } }] })
    const saved = await callTool(shared, agentA, 'robot_assembly_mount', { sceneId: 's', entityId: 'hand', expectedRevision: 1, save: { kind: 'body-origin', bodyName: 'palm' }, rootBodyName: 'palm' })
    expect(saved.isError).toBe(false)
    // 同一 Host 的另一会话：读不到 A 的 scene/save point，明确失败而不是读到别人的点。
    const sessionB = shared.sessions.create(SessionId(`mount-readonly-other-${++calls}`))
    const agentB = { id: sessionB.id, session: sessionB } as Agent
    const other = await callTool(shared, agentB, 'robot_assembly_mount', { sceneId: 's', entityId: 'hand', expectedRevision: 2 })
    expect(other.isError).toBe(true)
    // A 自己仍然读得到。
    expect((await callTool(shared, agentA, 'robot_assembly_mount', { sceneId: 's', entityId: 'hand', expectedRevision: 2 })).isError).toBe(false)
  }, 20_000)
})
