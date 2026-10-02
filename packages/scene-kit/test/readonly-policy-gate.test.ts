/**
 * 有效策略落到**实际操作边界**（138 缺口 1）：场景/资产工具与命令在只读会话里不得再落盘。
 *
 * 修前这些入口是「绕过沙箱的另一条写路径」：场景存储由 Host 用 node fs 直接写，worker 的沙箱管不到，
 * 于是 read-only 会话照样 scene_create / scene_import / scene_save。这里钉的就是这件事在**真实工具派发
 * 路径**上已经关掉，同时合法读取/预览不受影响。
 *
 * 原生 side 用**真的** `@deepseek-ai/dsh-sandbox-policy`（不是自造的策略替身）：模式与授权根按会话解析
 * 这条链是上游拥有的，本包只消费它。场景存储也是真 SceneStore + 真文件 + 真临时 dataRoot。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Commands from '@deepseek-ai/dsh-commands'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathWithin } from '../../lyapunov-contracts/src/writable-boundary.ts'
import * as scenePlugin from '../src/plugin.ts'

const signal = new AbortController().signal
/**
 * "授权根之外"的目标基目录：原生 `writableRoots(policy)` 就是「工作区根 + `/tmp` + `tmpdir()`」
 * （`@deepseek-ai/dsh-sandbox` 的 roots.ts），产品门用的是同一份判定（`pathWithin`），所以目标必须落在
 * 平台临时区**之外**；同时这个目录本机得真的写得进去。写死 `/var/tmp` 时，`/var/tmp` 只读的环境里整组
 * 用例必然 EROFS——这里要表达的性质是"在授权根之外"，不是"必须在 /var/tmp"。
 * 候选按顺序探测：落在临时区里的跳过、真建不出目录的跳过，第一个可用的胜出（不跳过用例、不放宽断言）。
 */
const OUTSIDE_ROOT = (() => {
  for (const candidate of ['/var/tmp', '/dev/shm', process.cwd()]) {
    if (['/tmp', tmpdir()].some(temporary => pathWithin(temporary, candidate))) continue
    try {
      const probe = mkdtempSync(join(candidate, 'lyapunov-outside-probe-'))
      rmSync(probe, { recursive: true, force: true })
      return candidate
    } catch { /* 只读、不存在或没有权限：试下一个候选 */ }
  }
  throw new Error('TEST_NO_WRITABLE_OUTSIDE_ROOT: 候选基目录都落在平台临时区内或不可写，构造不出"授权根之外"的目标')
})()
/** 既不在会话授权根、也不在原生可写临时区里的目标：用来验"工作区外"这条边界真的被挡住。 */
const OUTSIDE = join(OUTSIDE_ROOT, `lyapunov-out-of-bounds-${process.pid}-${Date.now()}`)

type Mode = 'read-only' | 'workspace-write' | 'danger-full-access'
let base: string, workspace: string, dataRoot: string, calls = 0

async function runtime(mode: Mode, dataRootAt: string): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Sessions)
  await ctx.plugin(SessionProjection)
  await ctx.plugin(Commands)
  // 部署默认模式就是这次会话的有效模式（会话没有 sandboxMode 覆盖时按它生效，与产品里同一条链）。
  await ctx.plugin(SandboxPolicy, { mode, workspaceRoot: workspace })
  await ctx.plugin(scenePlugin, { dataRoot: dataRootAt })
  const session = ctx.sessions.create(SessionId(`scene-policy-${mode}-${++calls}`), { meta: { cwd: workspace } })
  return { ctx, agent: { id: session.id, session } as Agent }
}
async function callTool(ctx: Context, agent: Agent, name: string, input: unknown): Promise<ToolExecutionResult> {
  return await ctx.tools.execute({ callId: ToolCallId(`${name}-${++calls}`), name, arguments: { input }, signal, agent })
}
function textOf(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === "text").map(block => block.text).join("")
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'lyapunov-scene-policy-'))
  workspace = join(base, 'workspace')          // 会话授权根（session.header.cwd）
  dataRoot = join(workspace, 'catalog')        // 场景存储：授权根之下，产品自己的目录
  await mkdir(workspace, { recursive: true })
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
  await rm(OUTSIDE, { recursive: true, force: true })
})

/** 最小合法 GLB：只有 JSON chunk（parseAsset 只核对 glTF 2.0 头与 chunk 长度自洽）。 */
function glbBytes(generator: string): Buffer {
  const json = { asset: { version: "2.0", generator }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: generator }], meshes: [{ primitives: [] }] }
  const payload = Buffer.from(JSON.stringify(json), "utf8")
  const chunk = Buffer.concat([payload, Buffer.alloc((4 - payload.length % 4) % 4, 0x20)])
  const header = Buffer.alloc(12), chunkHeader = Buffer.alloc(8), total = 12 + 8 + chunk.length
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8)
  chunkHeader.writeUInt32LE(chunk.length, 0); chunkHeader.writeUInt32LE(0x4e4f534a, 4)
  return Buffer.concat([header, chunkHeader, chunk])
}

describe('read-only：用户请求的持久修改被拒在操作边界上，磁盘无变化；合法读取照常', () => {
  test('scene_create / scene_import / scene_save / 资产持久操作全部被拒，且一条都没落盘', async () => {
    const { ctx, agent } = await runtime('read-only', dataRoot)
    const glb = join(workspace, 'fixtures', '塔.glb')
    await mkdir(dirname(glb), { recursive: true })
    await writeFile(glb, glbBytes('readonly-tower'))

    const attempts: [string, unknown][] = [
      ['scene_create', { sceneId: 'ro_scene' }],
      ['scene_import', { path: glb, sceneId: 'ro_scene', entityId: 'tower', resourceId: 'res_tower' }],
      ['scene_save', { sceneId: 'ro_scene', path: join(workspace, 'out', 'scene.json') }],
      ['asset_trash', { resourceId: 'res_tower' }],
    ]
    for (const [name, input] of attempts) {
      const result = await callTool(ctx, agent, name, input)
      expect(`${name}:${result.isError}`).toBe(`${name}:true`)
      expect(textOf(result)).toContain('SCENE_POLICY_READ_ONLY')
      // 拒绝发生在任何写入之前：不改已有文件、也不新建半个产物。
      expect(existsSync(join(workspace, 'out'))).toBe(false)
    }
    expect(existsSync(join(dataRoot, 'sessions'))).toBe(false)
    // 授权根之外的目标同样一条都没写。
    expect(existsSync(OUTSIDE)).toBe(false)
  })

  test('读取与预览不受影响：scene_list / scene_inspect 这类只读入口照常返回（不是"只读会话什么都干不了"）', async () => {
    const { ctx, agent } = await runtime('read-only', dataRoot)
    const listed = await callTool(ctx, agent, 'scene_list', {})
    expect(listed.isError).toBe(false)
    expect(JSON.parse(textOf(listed))).toEqual([])
    // 资产清单同样是只读入口：没有任何场景/资产时也照常说话，不被策略拦成"未授权"。
    const assets = await callTool(ctx, agent, 'asset_list', {})
    expect(assets.isError).toBe(false)
  })
})

describe('workspace-write：授权根之内的正常导入/编辑/保存照旧', () => {
  test('scene_create → scene_import → scene_save 全部成功并真的落盘', async () => {
    const { ctx, agent } = await runtime('workspace-write', dataRoot)
    const glb = join(workspace, 'fixtures', '灯.glb')
    await mkdir(dirname(glb), { recursive: true })
    await writeFile(glb, glbBytes('writable-lamp'))
    expect((await callTool(ctx, agent, 'scene_create', { sceneId: 'rw_scene' })).isError).toBe(false)
    const imported = await callTool(ctx, agent, 'scene_import', { path: glb, sceneId: 'rw_scene', entityId: 'lamp', resourceId: 'res_lamp', physicalize: false })
    expect(imported.isError).toBe(false)
    const bundle = join(workspace, 'out', 'scene.json')
    const saved = await callTool(ctx, agent, 'scene_save', { sceneId: 'rw_scene', path: bundle, portable: true })
    expect(saved.isError).toBe(false)
    expect(existsSync(bundle)).toBe(true)
    expect(JSON.parse(textOf(saved)).packagedFileCount).toBeGreaterThan(0) // 随包确实打进去了
  })

  test('授权根之外的用户目标被明确拒绝（原生可写根才是这次会话的写边界），且不落半个文件', async () => {
    const { ctx, agent } = await runtime('workspace-write', dataRoot)
    expect((await callTool(ctx, agent, 'scene_create', { sceneId: 'rw_scene2' })).isError).toBe(false)
    const result = await callTool(ctx, agent, 'scene_save', { sceneId: 'rw_scene2', path: join(OUTSIDE, 'scene.json'), portable: true })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('SCENE_POLICY_OUTSIDE_WRITABLE')
    expect(existsSync(OUTSIDE)).toBe(false)
  })
})

describe('danger-full-access：策略自己说"本次不受文件效果约束"，就不替它设文件效果边界（会话归属另说，见下）', () => {
  test('会话内建场景、往授权根外保存都不被本层拦（照实执行，不假装有沙箱）', async () => {
    const { ctx, agent } = await runtime('danger-full-access', dataRoot)
    expect((await callTool(ctx, agent, 'scene_create', { sceneId: 'full_scene' })).isError).toBe(false)
    const result = await callTool(ctx, agent, 'scene_save', { sceneId: 'full_scene', path: join(base, 'outside-workspace.json'), portable: true })
    expect(result.isError).toBe(false)
    expect(existsSync(join(base, 'outside-workspace.json'))).toBe(true)
  })
})

/**
 * 显式写出目标按**规范路径 + 会话归属**判定（138 定向返修，本体已复现两条真实绕过）：
 *   1. A 会话把场景导出到 `<工作区根>/.lyapunov/sessions/<B>/sim/` —— 词法上"在工作区内"就放行了；
 *   2. A 会话经工作区里的符号链接把产物写到授权根外 —— 词法 `relative` 从不解析链接。
 * 两条都由宿主 `node fs` 真写盘（不经 worker 沙箱），所以判定必须落在这条实际写出的边界上：
 * 规范化后判可写根 + 拒绝别人的会话私有目录，同时**不**把合法用法一起挡掉。
 */
describe('显式写出目标：规范化 + 会话归属（138 定向返修）', () => {
  test('A 不能替 B 落盘：跨会话私有目录被拒；本会话私有目录与工作区共享路径照常', async () => {
    const { ctx, agent } = await runtime('workspace-write', dataRoot)
    expect((await callTool(ctx, agent, 'scene_create', { sceneId: 'scope_scene' })).isError).toBe(false)
    const other = ctx.sessions.create(SessionId(`scene-policy-other-${++calls}`), { meta: { cwd: workspace } })
    const foreign = join(workspace, '.lyapunov', 'sessions', other.id, 'sim', 'a-export.json')
    const denied = await callTool(ctx, agent, 'scene_save', { sceneId: 'scope_scene', path: foreign })
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('SCENE_POLICY_CROSS_SESSION')
    expect(existsSync(foreign)).toBe(false)
    // 自己的会话私有运行目录是合法落点（worker 与场景存储共用同一个会话键规则）。
    const own = join(workspace, '.lyapunov', 'sessions', agent.id, 'sim', 'own-export.json')
    const allowed = await callTool(ctx, agent, 'scene_save', { sceneId: 'scope_scene', path: own })
    expect(allowed.isError).toBe(false)
    expect(existsSync(own)).toBe(true)
    // 工作区共享路径同样照常。
    const shared = join(workspace, 'out', 'shared.json')
    expect((await callTool(ctx, agent, 'scene_save', { sceneId: 'scope_scene', path: shared })).isError).toBe(false)
    expect(existsSync(shared)).toBe(true)
  })

  test('工作区里的符号链接指向授权根外（目录已存在 / 悬空）都被拒；指向工作区内部的链接照常', async () => {
    const { ctx, agent } = await runtime('workspace-write', dataRoot)
    expect((await callTool(ctx, agent, 'scene_create', { sceneId: 'link_scene' })).isError).toBe(false)
    await mkdir(OUTSIDE, { recursive: true })
    await symlink(OUTSIDE, join(workspace, 'outside-link'), 'dir')
    const escaped = await callTool(ctx, agent, 'scene_save', { sceneId: 'link_scene', path: join(workspace, 'outside-link', 'escape.json') })
    expect(escaped.isError).toBe(true)
    expect(textOf(escaped)).toContain('SCENE_POLICY_OUTSIDE_WRITABLE')
    expect(existsSync(join(OUTSIDE, 'escape.json'))).toBe(false)
    // 悬空链接（指向还不存在的目录）同样不能当"普通的不存在目录"放行：写入会跟着链接落到链接指向处。
    const ghost = join(OUTSIDE, 'ghost')   // 故意不创建，且在授权根与平台临时区之外
    await symlink(ghost, join(workspace, 'ghost-link'), 'dir')
    const dangling = await callTool(ctx, agent, 'scene_save', { sceneId: 'link_scene', path: join(workspace, 'ghost-link', 'escape.json') })
    expect(dangling.isError).toBe(true)
    expect(textOf(dangling)).toContain('SCENE_POLICY_OUTSIDE_WRITABLE')
    expect(existsSync(ghost)).toBe(false)
    // 指向工作区内部的链接是合法拼写：规范化后仍在授权根内，不能被"链接一律拒绝"误伤。
    await mkdir(join(workspace, 'inside'), { recursive: true })
    await symlink(join(workspace, 'inside'), join(workspace, 'inside-link'), 'dir')
    const inside = await callTool(ctx, agent, 'scene_save', { sceneId: 'link_scene', path: join(workspace, 'inside-link', 'ok.json') })
    expect(inside.isError).toBe(false)
    expect(existsSync(join(workspace, 'inside', 'ok.json'))).toBe(true)
  })

  test('asset_move 的显式目标走同一条边界：跨会话与链接越界被拒，共享工作区照常落位', async () => {
    const { ctx, agent } = await runtime('workspace-write', dataRoot)
    const glb = join(workspace, 'fixtures', '机械臂.glb')
    await mkdir(dirname(glb), { recursive: true })
    await writeFile(glb, glbBytes('movable-arm'))
    expect((await callTool(ctx, agent, 'scene_create', { sceneId: 'move_scene' })).isError).toBe(false)
    const imported = await callTool(ctx, agent, 'scene_import', { path: glb, sceneId: 'move_scene', entityId: 'arm', resourceId: 'res_arm', physicalize: false })
    expect(imported.isError).toBe(false)
    const other = ctx.sessions.create(SessionId(`scene-policy-move-other-${++calls}`), { meta: { cwd: workspace } })
    const foreign = join(workspace, '.lyapunov', 'sessions', other.id, 'sim', 'moved.glb')
    const denied = await callTool(ctx, agent, 'asset_move', { resourceId: 'res_arm', targetPath: foreign })
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('SCENE_POLICY_CROSS_SESSION')
    expect(existsSync(foreign)).toBe(false)
    await mkdir(OUTSIDE, { recursive: true })
    await symlink(OUTSIDE, join(workspace, 'move-link'), 'dir')
    const throughLink = await callTool(ctx, agent, 'asset_move', { resourceId: 'res_arm', path: join(workspace, 'move-link', 'moved.glb') })
    expect(throughLink.isError).toBe(true)
    expect(textOf(throughLink)).toContain('SCENE_POLICY_OUTSIDE_WRITABLE')
    expect(existsSync(join(OUTSIDE, 'moved.glb'))).toBe(false)
    // 合法目标：工作区共享路径照常搬过去，原位置仍登记为 alternateLocation。
    const target = join(workspace, 'moved', 'arm.glb')
    const moved = await callTool(ctx, agent, 'asset_move', { resourceId: 'res_arm', targetPath: target })
    expect(moved.isError).toBe(false)
    expect(existsSync(target)).toBe(true)
    const record = JSON.parse(textOf(moved))
    expect(record.alternateLocations.length).toBeGreaterThan(0)   // 原位置保留为 alternateLocation（既有语义）
    expect(record.ref.original.uri).toContain(target)             // authority 真的指到新位置
  })

  /**
   * full-access 的**次序**（19:00 本体复现）：文件效果与会话归属是两件事——`danger-full-access` 放开的是
   * 前者。修前 `requireWritableTarget` 先按模式提前 return，导致"A 替 B 落盘"在 full-access 部署下照样成立。
   * 这里两条一起钉：普通根外目标必须**继续放行**（放行它是 full-access 的正确行为，不能被误拒），
   * 跨会话私有目录必须被拒且不落盘；本会话私有目录与共享路径照旧放行（不因修归属而收紧合法目标）。
   */
  test('danger-full-access：普通根外目标照常成功，跨会话私有目录仍被会话归属拒绝且不落盘', async () => {
    const { ctx, agent } = await runtime('danger-full-access', dataRoot)
    expect((await callTool(ctx, agent, 'scene_create', { sceneId: 'full_scope' })).isError).toBe(false)
    // 文件效果：授权根外的普通目标在 full-access 下就该成功（这条是本轮修归属时**不能**一起拒掉的）。
    const outside = join(OUTSIDE, 'full.json')
    const allowed = await callTool(ctx, agent, 'scene_save', { sceneId: 'full_scope', path: outside })
    expect(allowed.isError).toBe(false)
    expect(existsSync(outside)).toBe(true)
    // 会话归属：同一个工作区里 A 替 B 落盘与文件效果无关，full-access 也拒。
    const other = ctx.sessions.create(SessionId(`scene-policy-full-other-${++calls}`), { meta: { cwd: workspace } })
    const foreign = join(workspace, '.lyapunov', 'sessions', other.id, 'sim', 'a-export.json')
    const denied = await callTool(ctx, agent, 'scene_save', { sceneId: 'full_scope', path: foreign })
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('SCENE_POLICY_CROSS_SESSION')
    expect(existsSync(foreign)).toBe(false)
    // 合法目标不因这次次序调整被收紧：本会话私有目录、工作区共享路径都照常。
    const own = join(workspace, '.lyapunov', 'sessions', agent.id, 'sim', 'own.json')
    expect((await callTool(ctx, agent, 'scene_save', { sceneId: 'full_scope', path: own })).isError).toBe(false)
    expect(existsSync(own)).toBe(true)
    const shared = join(workspace, 'full-out', 'shared.json')
    expect((await callTool(ctx, agent, 'scene_save', { sceneId: 'full_scope', path: shared })).isError).toBe(false)
    expect(existsSync(shared)).toBe(true)
  })
})
