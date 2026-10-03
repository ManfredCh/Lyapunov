/**
 * N55 / ENV-33 + DEV-021 余项：**迁移自身**也必须能"搬家后重开"。
 *
 * 真实复现（`.runtime/lane-env33/migrate-real.ts`，旧数据只读副本 0444）：
 *   第 1 次迁移 PASS，第 2 次（恢复 BLOCKED 资源后的重跑）在旧资源索引原件保留处崩：
 *   `EACCES: permission denied, copyfile … resource-original-library.json`。
 *   原因：`copyFile` 把源索引的 0444 权限带到目标上（新目标能写，已存在的 0444 目标打不开）。
 *
 * 这里钉住的性质（都是"位置无关"性质，不依赖某台机器的绝对路径）：
 *   1. 旧资源索引是只读文件也能迁，原件副本内容逐字节一致、权限为属主可写（可重跑）；
 *   2. 旧工作区**整体搬走**后，按新位置重跑仍然成功（相对路径解析，不依赖旧绝对路径）；
 *   3. 旧数据里写死的绝对路径找不到原件时，必须显式 BLOCKED 并报出**那一条绝对路径**，
 *      且在 Scene 资源库里留下 missing 记录——不允许静默成功/静默空结果；
 *   4. 同一个新装目录换了旧源位置时，显式报错而不是静默再导入一遍（不产生重复会话）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { migrateLegacy } from '../src/index.ts'

/** 夹具必须落在平台临时区之外（临时区常被策略设为只读或不稳定），同时本机真的写得进去。 */
const BASE = (() => {
  const inside = (base: string, candidate: string) => {
    const rest = relative(base, candidate)
    return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest))
  }
  for (const candidate of ['/var/tmp', '/dev/shm', process.cwd()]) {
    if (inside('/tmp', candidate) || inside(tmpdir(), candidate)) continue
    try {
      const probe = mkdtempSync(join(candidate, 'lyaup-migration-probe-'))
      rmSync(probe, { recursive: true, force: true })
      return candidate
    } catch { /* 只读或不存在：试下一个候选 */ }
  }
  throw new Error('TEST_NO_WRITABLE_BASE: 候选基目录都落在平台临时区内或不可写')
})()

const sha256 = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')

/** 用产品自身的 JSONL 持久化后端重开一个迁移会话；存储契约不满足就抛错，不是"文件在不在"的弱检查。 */
async function reopenNative(installRoot: string, id: string) {
  const ctx = new Context()
  const fiber = await ctx.plugin(JsonlSessionPersistence as any, { root: join(installRoot, 'dsh', 'sessions'), compression: 'zstd' } as any)
  try {
    const handle = await (ctx as any).sessionPersistence.open(SessionId(id), 'read')
    try { const log = await handle.read() as any; return { ...log, header: handle.header } } finally { await handle.close() }
  } finally { await fiber.dispose() }
}

interface LegacyMessage { id: string; role: string; created: number; parts: Array<Record<string, unknown>> }
interface LegacySession { id: string; title?: string; messages: LegacyMessage[] }

/** 按 `json-source.ts` 的兼容布局写一份旧 JSON 存储（project/ + session/info + session/message + session/part）。 */
async function writeLegacyStore(storeRoot: string, spaceRoot: string, sessions: LegacySession[]) {
  await writeJSON(join(storeRoot, 'project/legacy-project.json'), { worktree: spaceRoot })
  for (const session of sessions) {
    await writeJSON(join(storeRoot, `session/info/${session.id}.json`), { projectID: 'legacy-project', title: session.title ?? session.id, time: { created: 1, updated: 2 }, path: { root: spaceRoot } })
    for (const message of session.messages) {
      await writeJSON(join(storeRoot, `session/message/${session.id}/${message.id}.json`), { role: message.role, time: { created: message.created } })
      for (const [index, part] of message.parts.entries()) {
        // part 文件名即 part id，必须在整个旧存储内唯一（真实旧布局如此）。
        await writeJSON(join(storeRoot, `session/part/${session.id}/${message.id}/${message.id}-part-${index + 1}.json`), part)
      }
    }
  }
}

const contractOptions = (storeRoot: string, home: string, label = 'legacy', accountKey = 'tester') => ({
  sourceJsonDirectory: storeRoot, sourceLabel: label, accountKey,
  dshHome: join(home, 'dsh'), sceneRoot: join(home, 'scenes'),
})
const readLedger = async (home: string, label = 'legacy') => JSON.parse(await readFile(join(home, 'dsh', 'migrations', label, 'ledger.json'), 'utf8')) as any
const readSessionEvents = (log: any): any[] => log.events
const contentOf = (event: any): any[] => event.type === 'user/message' ? event.data.content
  : event.type === 'assistant/message' ? event.data.message.content
  : event.type === 'tool/result' ? (event.data.message.content as any[]).flatMap((wrapper: any) => wrapper.content ?? []) : []

let root = ''
beforeEach(async () => { root = await mkdtemp(join(BASE, 'lyaup-migration-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function writeJSON(path: string, value: unknown, mode?: number) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value), mode === undefined ? {} : { mode })
}

/** 旧 JSON 存储布局：session/info + session/message + session/part（与 json-source.ts 的兼容布局一致）。 */
async function legacyStore(storeRoot: string, spaceRoot: string) {
  await writeJSON(join(storeRoot, 'project/legacy-project.json'), { worktree: spaceRoot })
  await writeJSON(join(storeRoot, 'session/info/ses-old-1.json'), { projectID: 'legacy-project', title: '旧会话', time: { created: 1, updated: 2 }, path: { root: spaceRoot } })
  await writeJSON(join(storeRoot, 'session/message/ses-old-1/msg-1.json'), { role: 'user', time: { created: 1 } })
  await writeJSON(join(storeRoot, 'session/part/ses-old-1/msg-1/part-1.json'), { type: 'text', text: '搬家前写入的旧内容' })
}

/** 最小合法 GLB：资源导入会校验 GLB 头，夹具不能用随便的字节冒充模型。 */
function minimalGLB() {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }], nodes: [] }))
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])
  const header = Buffer.alloc(12)
  header.write('glTF', 0, 'ascii'); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + padded.length, 8)
  const chunk = Buffer.alloc(8)
  chunk.writeUInt32LE(padded.length, 0); chunk.write('JSON', 4, 'ascii')
  return Buffer.concat([header, chunk, padded])
}

async function oldSpace(spaceRoot: string, name = 'part.glb') {
  await mkdir(join(spaceRoot, 'assets'), { recursive: true })
  await writeFile(join(spaceRoot, 'assets', name), minimalGLB())
  const library = join(spaceRoot, '..', 'old-library.json')
  await writeJSON(library, { resources: [{ resource_id: 'res_old_part', path: `assets/${name}`, displayName: '旧零件', aliases: ['旧零件'] }], tombstones: [] })
  chmodSync(library, 0o444) // 旧资源索引来自只读备份：0444
  return library
}

const options = (storeRoot: string, spaceRoot: string, library: string) => ({
  sourceJsonDirectory: storeRoot,
  sourceLabel: 'legacy',
  accountKey: 'tester',
  dshHome: join(root, 'new-dsh'),
  sceneRoot: join(root, 'new-scenes'),
  resourceLibraries: [{ path: library, workspaceRoot: spaceRoot }],
})

describe('迁移的搬家与重跑边界', () => {
  test('只读旧索引：原件副本逐字节保留，且恢复原件后可重跑（重跑不再 EACCES）', async () => {
    const storeRoot = join(root, 'old-store'), spaceRoot = join(root, 'old-space')
    await legacyStore(storeRoot, spaceRoot)
    const library = await oldSpace(spaceRoot)

    const first = await migrateLegacy(options(storeRoot, spaceRoot, library) as any)
    expect(first.status).toBe('PASS')
    expect(first.created).toBe(1)
    expect(first.resources).toBe(1)
    expect(first.scenes).toBe(0)
    expect(first.missing).toEqual([])

    const preserved = join(root, 'new-dsh/migrations/legacy/resource-original-old-library.json')
    expect(await readFile(preserved)).toEqual(await readFile(library)) // 原件逐字节保留
    expect((await stat(preserved)).mode & 0o777).toBe(0o600) // 属主可写：不会把只读权限带进迁移目录

    // 第二次运行 = 找回原件后的重跑：修前这里 EACCES（copyFile 目标已存在且为 0444）。
    const second = await migrateLegacy(options(storeRoot, spaceRoot, library) as any)
    expect(second.status).toBe('PASS')
    expect(second.created).toBe(0)
    expect(second.unchanged).toBe(1)
    expect(second.missing).toEqual([])
    expect(await readFile(preserved)).toEqual(await readFile(library))
  })

  test('旧工作区整体搬走后按新位置重跑仍成功：相对资源路径不依赖旧绝对路径', async () => {
    const storeRoot = join(root, 'old-store'), spaceRoot = join(root, 'old-space')
    await legacyStore(storeRoot, spaceRoot)
    const library = await oldSpace(spaceRoot)
    const first = await migrateLegacy(options(storeRoot, spaceRoot, library) as any)
    expect(first.status).toBe('PASS')

    const movedSpace = join(root, 'moved-space')
    await rename(spaceRoot, movedSpace)
    const moved = await migrateLegacy(options(storeRoot, movedSpace, library) as any)
    expect(moved.status).toBe('PASS') // 只读索引原件保留在迁移目录里，重跑读的是老副本，不靠旧工作区路径
    expect(moved.resources).toBe(0)
    expect(moved.missing).toEqual([])

    // 迁移产物里不应记下旧工作区绝对路径作为依赖（历史来源只保留 resourceId/sourceRef 一类标识）。
    const ledger = await readFile(join(root, 'new-dsh/migrations/legacy/ledger.json'), 'utf8')
    expect(ledger.includes(spaceRoot)).toBe(false)
    expect(ledger.includes('res_old_part')).toBe(true)
  })

  test('负对照：写死的旧绝对路径找不到原件时显式 BLOCKED 并报出该路径，资源库留下 missing 记录', async () => {
    const storeRoot = join(root, 'old-store'), spaceRoot = join(root, 'old-space')
    await legacyStore(storeRoot, spaceRoot)
    await mkdir(join(spaceRoot, 'assets'), { recursive: true })
    const gone = join(root, 'moved-away-space', 'assets', 'missing.glb') // 旧数据里写死的绝对路径，原件已不在
    const library = join(root, 'old-library.json')
    await writeJSON(library, { resources: [{ resource_id: 'res_old_abs', path: gone, displayName: '旧绝对路径资源' }], tombstones: [] })
    chmodSync(library, 0o444)

    const result = await migrateLegacy(options(storeRoot, spaceRoot, library) as any)
    expect(result.status).toBe('BLOCKED')
    expect(result.exitCode).toBe(2)
    const blocked = result.missing.filter((item: any) => item.kind === 'resource')
    expect(blocked).toHaveLength(1)
    expect(blocked[0]!.id).toBe('res_old_abs')
    expect(blocked[0]!.path).toBe(gone)
    expect(blocked[0]!.reason).toContain(gone) // 报的是那一条绝对路径，不是"未知资源"

    const missingFile = JSON.parse(await readFile(join(root, 'new-scenes/resources/missing.json'), 'utf8'))
    const records = Array.isArray(missingFile) ? missingFile : missingFile.missing ?? missingFile.records ?? []
    expect(JSON.stringify(records)).toContain(gone)
  })

  test('旧源位置变了：新装目录里显式报错，不静默再导入一遍', async () => {
    const storeRoot = join(root, 'old-store'), spaceRoot = join(root, 'old-space')
    await legacyStore(storeRoot, spaceRoot)
    const library = await oldSpace(spaceRoot)
    expect((await migrateLegacy(options(storeRoot, spaceRoot, library) as any)).created).toBe(1)

    const movedStore = join(root, 'moved-store')
    await rename(storeRoot, movedStore)
    await expect(migrateLegacy(options(movedStore, spaceRoot, library) as any)).rejects.toThrow('MIGRATION_ACCOUNT_OR_SOURCE_MISMATCH')

    // 换一个干净的新装目录，从搬走后的旧源迁移仍应成功（旧数据可移动、可重开）。
    const fresh = { ...options(movedStore, spaceRoot, library), dshHome: join(root, 'fresh-dsh'), sceneRoot: join(root, 'fresh-scenes') }
    const result = await migrateLegacy(fresh as any)
    expect(result.status).toBe('PASS')
    expect(result.created).toBe(1)
  })
})

/**
 * DEV-021 / W7 迁移合同：**重复迁移不改变结论，也不改变数据**。
 *
 * 全部用例只写临时目录里的副本；真实旧数据（只读 DB/索引/Scene）不进这些夹具。
 * 前两条钉住本轮修掉的两个真实缺陷（都用副本先复现、后修复）：
 *   1. 首次导入推导出的缺失（`UNSUPPORTED_ROLE` 的 message）在第二次运行被丢掉 ⇒ BLOCKED 被洗成 PASS；
 *   2. 附件原件恢复后重跑走了 surface 修补，账本 eventCount 却停在首次导入值 ⇒ 与真实日志长度不符。
 * 其余三条钉住"冲突保留 / 未知布局留名 / 账号路径与记录逐条不丢"。
 */
describe('迁移合同：幂等、冲突保留、账号路径与记录对账', () => {
  test('首次导入的不支持角色消息在重跑后仍逐条报出：BLOCKED 不会被洗成 PASS', async () => {
    const storeRoot = join(root, 'old-store'), spaceRoot = join(root, 'old-space')
    await writeLegacyStore(storeRoot, spaceRoot, [{
      id: 'ses-1',
      messages: [
        { id: 'msg-1', role: 'user', created: 1, parts: [{ type: 'text', text: 'hi' }] },
        { id: 'msg-2', role: 'system', created: 2, parts: [{ type: 'text', text: 'system note' }] },
      ],
    }])
    const options = contractOptions(storeRoot, root)
    const first = await migrateLegacy(options as any)
    expect(first.status).toBe('BLOCKED')
    expect(first.exitCode).toBe(2)
    const entries = first.missing.filter((item: any) => item.kind === 'message')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: 'msg-2', reason: 'UNSUPPORTED_ROLE: system' })

    // 第二次运行：会话未变 ⇒ 走 repair 分支，不会重新检查角色。缺失条目必须原样保留。
    const second = await migrateLegacy(options as any)
    expect(second.created).toBe(0)
    expect(second.unchanged).toBe(1)
    expect(second.status).toBe('BLOCKED')
    expect(second.exitCode).toBe(2)
    expect(second.missing).toEqual(first.missing)
    expect((await readLedger(root)).missing).toEqual(first.missing)

    // 第三次仍稳定（条目既不消失也不膨胀）。
    const third = await migrateLegacy(options as any)
    expect(third.missing).toEqual(first.missing)
    expect(third.status).toBe('BLOCKED')
  })

  test('附件原件恢复后重跑：surface 修补落盘，账本 eventCount 与真实事件数一致且再跑稳定', async () => {
    const storeRoot = join(root, 'old-store'), spaceRoot = join(root, 'old-space')
    const attachment = join(spaceRoot, 'notes.txt')
    await writeLegacyStore(storeRoot, spaceRoot, [{
      id: 'ses-1',
      messages: [{
        id: 'msg-1', role: 'user', created: 1,
        parts: [{ type: 'text', text: '见附件' }, { type: 'file', url: attachment, filename: 'notes.txt' }],
      }],
    }])
    const options = contractOptions(storeRoot, root)
    const first = await migrateLegacy(options as any)
    expect(first.status).toBe('BLOCKED')
    expect(first.missing.filter((item: any) => item.kind === 'attachment')).toHaveLength(1)
    const firstEntry = (await readLedger(root)).sessions['ses-1']
    expect(firstEntry.eventCount).toBeGreaterThan(0)

    // 找到原件后重跑：这是 DEV-021 的恢复路径（recovery.action=restore-original-at-source-path-and-rerun-migration）。
    await mkdir(spaceRoot, { recursive: true })
    await writeFile(attachment, 'restored-bytes')
    const second = await migrateLegacy(options as any)
    expect(second.status).toBe('PASS')
    expect(second.missing).toEqual([])
    expect(second.repairedAttachments).toBe(1)
    expect(second.repairedSessions).toBe(1)
    expect(second.created).toBe(0)
    expect(second.unchanged).toBe(1)

    const ledger = await readLedger(root)
    const entry = ledger.sessions['ses-1']
    const log = await reopenNative(root, entry.id)
    const events = readSessionEvents(log)
    expect(entry.eventCount).toBe(events.length) // 修补追加事件后账本必须同步，否则"可重开"证据对不上
    expect(entry.eventCount).toBeGreaterThan(firstEntry.eventCount)
    expect(events.filter((event: any) => event.surfaceOp || event.surface).length).toBeGreaterThan(0)
    // 可见消息现在真的带上附件块（不是只在账本里说修好了）。
    const migrated = events.flatMap(contentOf).filter((block: any) => block.type === 'file')
    expect(migrated).toHaveLength(1)

    // 再跑一次：不再修补、事件数不变、账本字节不变（幂等收敛）。
    const third = await migrateLegacy(options as any)
    expect(third.repairedAttachments).toBe(0)
    expect(third.repairedSessions).toBe(0)
    expect(third.status).toBe('PASS')
    const ledgerAfterThird = await readLedger(root)
    expect(ledgerAfterThird.sessions['ses-1'].eventCount).toBe(events.length)
    const reopenedAgain = await reopenNative(root, entry.id)
    expect(readSessionEvents(reopenedAgain).length).toBe(events.length)
  })

  test('旧源在迁移后继续变化：冲突逐条保留，原生会话字节不被覆写', async () => {
    const storeRoot = join(root, 'old-store'), spaceRoot = join(root, 'old-space')
    await writeLegacyStore(storeRoot, spaceRoot, [{
      id: 'ses-1',
      messages: [{ id: 'msg-1', role: 'user', created: 1, parts: [{ type: 'text', text: '第一次' }] }],
    }])
    const options = contractOptions(storeRoot, root)
    const first = await migrateLegacy(options as any)
    expect(first.status).toBe('PASS')
    expect(first.created).toBe(1)

    const sessionId = (await readLedger(root)).sessions['ses-1'].id
    const before = await reopenNative(root, sessionId)
    const beforeEvents = JSON.stringify(readSessionEvents(before))

    // 用户在新装里接着干活之后，旧源又被写入（旧机器还在用）。
    await writeLegacyStore(storeRoot, spaceRoot, [{
      id: 'ses-1',
      messages: [
        { id: 'msg-1', role: 'user', created: 1, parts: [{ type: 'text', text: '第一次' }] },
        { id: 'msg-2', role: 'user', created: 3, parts: [{ type: 'text', text: '旧源后来追加' }] },
      ],
    }])
    const second = await migrateLegacy(options as any)
    expect(second.status).toBe('BLOCKED')
    const conflict = second.missing.filter((item: any) => item.kind === 'session')
    expect(conflict).toHaveLength(1)
    expect(conflict[0]).toMatchObject({ id: 'ses-1' })
    expect(String(conflict[0].reason)).toContain('SOURCE_SESSION_CHANGED_AFTER_MIGRATION')
    expect(second.created).toBe(0)
    expect(second.updated).toBe(0)

    // 冲突保留：原生会话逐字节没被覆写，冲突条目在重跑中稳定不膨胀。
    const after = await reopenNative(root, sessionId)
    expect(JSON.stringify(readSessionEvents(after))).toBe(beforeEvents)
    const third = await migrateLegacy(options as any)
    expect(third.status).toBe('BLOCKED')
    expect(third.missing.filter((item: any) => item.kind === 'session')).toHaveLength(1)
  })

  test('兼容布局之外的一级子目录显式留名：不静默略过，也不自动搬', async () => {
    const storeRoot = join(root, 'old-store'), spaceRoot = join(root, 'old-space')
    await writeLegacyStore(storeRoot, spaceRoot, [{
      id: 'ses-1',
      messages: [{ id: 'msg-1', role: 'user', created: 1, parts: [{ type: 'text', text: 'hi' }] }],
    }])
    await writeJSON(join(storeRoot, 'attachments/blob.json'), { keep: true })
    const options = contractOptions(storeRoot, root)
    const first = await migrateLegacy(options as any)
    expect(first.status).toBe('BLOCKED')
    const unknown = first.missing.filter((item: any) => item.id === 'attachments')
    expect(unknown).toHaveLength(1)
    expect(String(unknown[0].reason)).toContain('UNRECOGNIZED_LAYOUT_DIRECTORY')
    expect(unknown[0].path).toBe(join(storeRoot, 'attachments'))
    // 原目录原样保留，且重跑读数一致。
    expect(JSON.parse(await readFile(join(storeRoot, 'attachments/blob.json'), 'utf8'))).toEqual({ keep: true })
    const second = await migrateLegacy(options as any)
    expect(second.missing.filter((item: any) => item.id === 'attachments')).toHaveLength(1)
    expect(second.status).toBe('BLOCKED')
  })

  test('账号路径兼容：同账号跨安装目录与重复运行 ID 稳定，历史目录原样成为原生 cwd', async () => {
    const storeRoot = join(root, 'old-store'), spaceRoot = join(root, 'old-space')
    await writeLegacyStore(storeRoot, spaceRoot, [{
      id: 'ses-1',
      messages: [{ id: 'msg-1', role: 'user', created: 1, parts: [{ type: 'text', text: 'hi' }] }],
    }])
    const installA = join(root, 'install-a'), installB = join(root, 'install-b'), installC = join(root, 'install-c')
    const first = await migrateLegacy(contractOptions(storeRoot, installA) as any)
    expect(first.status).toBe('PASS')
    const second = await migrateLegacy(contractOptions(storeRoot, installA) as any)
    expect(second.created).toBe(0)
    expect(second.unchanged).toBe(1)
    expect(second.nativeSessions).toEqual(first.nativeSessions)

    // 同一账号 + 同一旧源标签，换一个全新安装目录：ID 必须逐字相同（旧身份按账号稳定，不随新装位置改变）。
    const fresh = await migrateLegacy(contractOptions(storeRoot, installB) as any)
    expect(fresh.created).toBe(1)
    expect(fresh.nativeSessions).toEqual(first.nativeSessions)
    const ledgerA = await readLedger(installA), ledgerB = await readLedger(installB)
    expect(ledgerB.sessions['ses-1'].id).toBe(ledgerA.sessions['ses-1'].id)
    expect(ledgerB.messages).toEqual(ledgerA.messages)
    expect(ledgerB.parts).toEqual(ledgerA.parts)

    // 换账号：新装的同一旧源必须得到不同 ID（不串号、不与别的账号共用原生会话）。
    const other = await migrateLegacy(contractOptions(storeRoot, installC, 'legacy', 'other-account') as any)
    expect(other.nativeSessions[0]).not.toBe(first.nativeSessions[0])

    // 历史路径兼容：旧 session.directory 原样成为原生 cwd，旧目录今天不存在也能重开。
    const log = await reopenNative(installB, ledgerB.sessions['ses-1'].id)
    expect(log.header.cwd).toBe(spaceRoot)
    expect(log.events.length).toBe(ledgerB.sessions['ses-1'].eventCount)

    // 账号键是**产品身份值**，不是登录名：迁移器只接受 safeId 字母表内的 key。
    // 直接把邮箱当 accountKey 会被 fail-closed 拒绝，而不是写出一个含 '@' 的运行目录。
    await expect(migrateLegacy(contractOptions(storeRoot, join(root, 'install-email'), 'legacy', 'user@example.invalid') as any))
      .rejects.toThrow('INVALID_ID')
    expect(await readdir(join(root)).then(names => names.includes('install-email'))).toBe(false)
  })

  test('记录对账：源 message/part 逐条有归属，文本/推理/工具/中断/元数据各归其位', async () => {
    const storeRoot = join(root, 'old-store'), spaceRoot = join(root, 'old-space')
    const attachment = join(spaceRoot, 'out.txt')
    await mkdir(spaceRoot, { recursive: true })
    await writeFile(attachment, 'tool-output-bytes')
    await writeLegacyStore(storeRoot, spaceRoot, [{
      id: 'ses-1',
      messages: [
        { id: 'msg-1', role: 'user', created: 1, parts: [{ type: 'text', text: '用户文本' }, { type: 'file', url: attachment, filename: 'out.txt' }] },
        {
          id: 'msg-2', role: 'assistant', created: 2, parts: [
            { type: 'reasoning', text: '推理链' },
            { type: 'text', text: '助手文本' },
            { type: 'tool', tool: 'scene_open', callID: 'call-1', state: { status: 'completed', input: { path: 'a.json' }, output: '{"ok":true}' } },
            { type: 'tool', tool: 'scene_save', callID: 'call-2', state: { status: 'error', input: { path: 'b.json' }, error: 'boom' } },
            { type: 'tool', tool: 'bash', callID: 'call-3', state: { status: 'running', input: { command: 'ls' } } },
            { type: 'step-start' },
          ],
        },
        { id: 'msg-3', role: 'assistant', created: 3, parts: [{ type: 'algorithm', text: '非内容 part，只记元数据' }] },
      ],
    }])
    const options = contractOptions(storeRoot, root)
    const result = await migrateLegacy(options as any)
    expect(result.status).toBe('PASS')
    expect(result.sourceCounts).toMatchObject({ session: 1, message: 3, part: 9 })
    expect(result.metadataOnlyParts).toBe(2) // step-start + algorithm
    expect(result.interruptedTools).toBe(1)

    // 账本逐条覆盖源记录：没有任何 message/part 无声消失。
    const ledger = await readLedger(root)
    expect(Object.keys(ledger.messages).sort()).toEqual(['msg-1', 'msg-2', 'msg-3'])
    expect(Object.keys(ledger.parts)).toHaveLength(9)

    const log = await reopenNative(root, ledger.sessions['ses-1'].id)
    const blocks = readSessionEvents(log).flatMap(contentOf)
    const text = blocks.filter((block: any) => block.type === 'text').map((block: any) => block.text)
    expect(text).toContain('用户文本')
    expect(text).toContain('助手文本')
    expect(text).toContain('{"ok":true}')      // 完成的旧工具输出逐字保留
    expect(text).toContain('boom')             // 失败原因逐字保留
    expect(text).toContain('迁移前动作结果未知，已标记 interrupted；需重新观察，不会自动重发动作。')
    const reasoning = blocks.filter((block: any) => block.type === 'reasoning').map((block: any) => block.text)
    expect(reasoning).toEqual(['推理链'])
    const calls = blocks.filter((block: any) => block.type === 'tool-call')
    expect(calls.map((block: any) => block.name)).toEqual(['scene_open', 'scene_save', 'bash'])
    expect(calls.map((block: any) => block.arguments)).toEqual(['{"path":"a.json"}', '{"path":"b.json"}', '{"command":"ls"}'])
    // 旧动作不会自动重发：中断的那条在面的事件里没有对应的"已完成"结果。
    const events = readSessionEvents(log)
    const results = events.filter((event: any) => event.type === 'tool/result')
    expect(results).toHaveLength(3)
    expect(results.filter((event: any) => event.data.meta?.migration?.interrupted)).toHaveLength(1)
    // 迁移后重开一次，事件逐字不动（重复迁移稳定）。
    const again = await migrateLegacy(options as any)
    expect(again.created).toBe(0)
    expect(again.unchanged).toBe(1)
    expect(JSON.stringify(readSessionEvents(await reopenNative(root, ledger.sessions['ses-1'].id)))).toBe(JSON.stringify(events))
  })

  test('SQLite 旧库：session_share 行不被静默丢弃，未导入的表逐条留名', async () => {
    const python = Bun.which('python3')
    if (!python) { console.warn('SKIP: python3 不在场，无法构造旧 SQLite 夹具'); return }
    const storeRoot = join(root, 'old-sqlite'), spaceRoot = join(root, 'old-space')
    await mkdir(storeRoot, { recursive: true })
    const database = join(storeRoot, 'opencode-local.db')
    const script = [
      'import json,sqlite3,sys',
      'db,space=sys.argv[1],sys.argv[2]',
      'c=sqlite3.connect(db)',
      'c.execute("create table project(id text primary key, worktree text, name text)")',
      'c.execute("create table session(id text primary key, project_id text, parent_id text, directory text, title text, time_created integer, time_updated integer)")',
      'c.execute("create table message(id text primary key, session_id text, time_created integer, time_updated integer, data text)")',
      'c.execute("create table part(id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text)")',
      'c.execute("create table session_share(session_id text, id text, secret text, url text, time_created integer, time_updated integer)")',
      'c.execute("create table account(id text primary key, email text)")',
      'c.execute("insert into project values(?,?,?)",("p1",space,"旧工程"))',
      'c.execute("insert into session values(?,?,?,?,?,?,?)",("ses-1","p1",None,space,"旧会话",1,2))',
      'c.execute("insert into message values(?,?,?,?,?)",("msg-1","ses-1",1,2,json.dumps({"role":"user"})))',
      'c.execute("insert into part values(?,?,?,?,?,?)",("part-1","msg-1","ses-1",1,2,json.dumps({"type":"text","text":"sqlite 旧文本"})))',
      'c.execute("insert into session_share values(?,?,?,?,?,?)",("ses-1","share-1","s3cret","https://example.invalid/s/share-1",1,2))',
      'c.execute("insert into account values(?,?)",("acc-1","user@example.invalid"))',
      'c.commit();c.close()',
    ].join('\n')
    const child = Bun.spawnSync([python, '-c', script, database, spaceRoot])
    expect(child.exitCode).toBe(0)

    const options = { sourceDatabase: database, sourceLabel: 'legacy', accountKey: 'tester', dshHome: join(root, 'dsh'), sceneRoot: join(root, 'scenes') }
    const first = await migrateLegacy(options as any)
    expect(first.status).toBe('PASS')
    expect(first.created).toBe(1)
    // 迁移器导入的表逐条入账；旧库里有、但迁移器不导入的表也要有名有数（不是"没报错=迁完了"）。
    expect(first.sourceCounts).toMatchObject({ session: 1, message: 1, part: 1, session_share: 1 })
    expect(first.sourceUnmigrated).toMatchObject({ account: 1 })
    // 旧分享引用被保留在旧元数据产物里（此前 SQLite 路径读不到这张表 ⇒ 静默丢）。
    const preserved = JSON.parse(await readFile(join(root, 'dsh/migrations/legacy/projects-and-preferences.json'), 'utf8'))
    expect(preserved.legacyShareReferences).toHaveLength(1)
    expect(preserved.legacyShareReferences[0]).toMatchObject({ session_id: 'ses-1', id: 'share-1', url: 'https://example.invalid/s/share-1' })

    const second = await migrateLegacy(options as any)
    expect(second.created).toBe(0)
    expect(second.unchanged).toBe(1)
    expect(second.sourceUnmigrated).toEqual(first.sourceUnmigrated)
    expect(second.sourceCounts).toEqual(first.sourceCounts)
  })
})
