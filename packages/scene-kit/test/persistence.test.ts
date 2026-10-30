/**
 * fileTransaction 的收尾语义：一次已经把内容写进文件的交易，不许因为**清理锁**失败而被报成失败。
 * 真实撞到过：dataRoot 整个被删/搬走（测试 teardown、运行根收尾）时 rm 锁目录会 ENOENT，此时
 * `fn()` 里的写入早已生效——调用方若把这次当失败，会去清掉刚写下的产物，用 failed 覆盖成功的回执。
 */
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ResourceLibrary, type ResourceAuthorityFaultStage } from "../src/resources.ts"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { fileTransaction } from "../src/persistence.ts"

describe("fileTransaction 锁收尾", () => {
  test("正常路径：内容落盘、锁被清掉、返回 fn 的结果", async () => {
    const base = await mkdtemp(join(tmpdir(), "lyapunov-transaction-"))
    try {
      const path = join(base, "resources/index.json")
      const value = await fileTransaction(path, async () => {
        await writeFile(path, JSON.stringify({ ok: true }))
        return "done"
      })
      expect(value).toBe("done")
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ok: true })
      // 锁目录已清：同一路径能再开一次事务（残留锁会 SCENE_BUSY）。
      await fileTransaction(path, async () => writeFile(path, JSON.stringify({ ok: false })))
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ok: false })
    } finally { await rm(base, { recursive: true, force: true }) }
  })

  test("目录在交易中途整个消失：内容已生效就不报失败（清锁失败只记日志）", async () => {
    const base = await mkdtemp(join(tmpdir(), "lyapunov-transaction-"))
    const path = join(base, "resources/index.json")
    const value = await fileTransaction(path, async () => {
      await writeFile(path, JSON.stringify({ status: "ok" }))
      // 模拟调用方在交易收尾前把整棵树删掉（测试 teardown、运行根收尾）。
      await rm(join(base, "resources"), { recursive: true, force: true })
      return "written"
    })
    // 交易 resolve（不抛），写入是真的发生过——"成功"不因收尾噪声被改写成"失败"。
    expect(value).toBe("written")
    await rm(base, { recursive: true, force: true })
  })

  test("fn 自己抛错照旧传播（收尾容错不掩盖真实失败）", async () => {
    const base = await mkdtemp(join(tmpdir(), "lyapunov-transaction-"))
    try {
      const path = join(base, "resources/index.json")
      await mkdir(join(base, "resources"), { recursive: true })
      expect(fileTransaction(path, async () => { throw new Error("BOOM") })).rejects.toThrow("BOOM")
    } finally { await rm(base, { recursive: true, force: true }) }
  })
})

const payload = '完整大定义、不裁剪骨骼或动作。'.repeat(8192)
/** 最小合法 GLB（同 portable-relocation.test.ts 构造口径）：本组用例只测 journal 语义，
 *  用不触发 Blender 几何探针的 .glb（.obj/.fbx 每次 import 实测要 ~4.4s 的 Blender 子进程）。
 *  `externals` 给出时声明外部 buffer/图片依赖，使 Move 保持多文件 inventory。 */
function glbBytes(generator: string, externals?: { bin: string; image: string; binBytes: number }): Buffer {
  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: generator }],
    meshes: [{ primitives: [] }],
    ...(externals ? { buffers: [{ uri: externals.bin, byteLength: externals.binBytes }], images: [{ uri: externals.image, mimeType: 'image/png' }] } : {}),
  }
  const jsonPayload = Buffer.from(JSON.stringify(json), 'utf8')
  const chunk = Buffer.concat([jsonPayload, Buffer.alloc((4 - jsonPayload.length % 4) % 4, 0x20)])
  const header = Buffer.alloc(12), chunkHeader = Buffer.alloc(8)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + chunk.length, 8)
  chunkHeader.writeUInt32LE(chunk.length, 0); chunkHeader.writeUInt32LE(0x4e4f534a, 4)
  return Buffer.concat([header, chunkHeader, chunk])
}
async function authorityFixture() {
  const root = await mkdtemp(join(tmpdir(), 'resource-journal-')), directory = join(root, 'data'), inputs = join(root, 'input')
  await mkdir(inputs)
  const input = async (id: string, large = false) => {
    const path = join(inputs, id + '.glb')
    await writeFile(path, glbBytes(id))
    return { path, resourceId: id, operationID: 'import-' + id, idempotencyKey: 'key-' + id, physicalizationRequest: false as const, storage: 'reference' as const, ...(large ? { components: { largeDefinition: { payload } } } : {}) }
  }
  return { root, directory, inputs, input, library: new ResourceLibrary(directory), close: () => rm(root, { recursive: true, force: true }) }
}
const journalEntries = async (library: ResourceLibrary): Promise<any[]> => JSON.parse(await readFile(library.journalPath, 'utf8'))
const refFile = (library: ResourceLibrary, ref: {path:string}) => join(library.catalogRoot, ref.path)

describe('Resource authority journal：大定义不再重复内联，原事务与恢复语义不变', () => {
  test('12个大默认定义同库保全；日志是小引用，重放/CAS/幂等冲突均走真实operation', async () => {
    const f = await authorityFixture()
    try {
      const inputs = [], imported = []
      for (let i = 0; i < 12; i++) { const input = await f.input('asset-' + i, true); inputs.push(input); imported.push(await f.library.import(input)) }
      expect((await f.library.authoritySnapshot()).records).toHaveLength(12)
      expect((await stat(f.library.journalPath)).size).toBeLessThan(64 * 1024)
      const entries = await journalEntries(f.library)
      expect(entries).toHaveLength(12)
      for (const entry of entries) {
        expect(entry.beforeCatalog).toBeUndefined(); expect(entry.afterCatalog).toBeUndefined(); expect(entry.result).toBeUndefined()
        for (const key of ['beforeCatalogRef', 'afterCatalogRef', 'resultRef']) expect(entry[key].path).toBe('operations/objects/' + entry[key].sha256 + '.json')
      }
      for (const record of imported) expect((await f.library.get(record.ref.resourceId)).componentDefaults?.largeDefinition).toEqual({ payload })
      const revision = await f.library.getRegistryRevision(), replay = await new ResourceLibrary(f.directory).import(inputs[0]!)
      expect(replay.replayed).toBe(true); expect(replay.componentDefaults?.largeDefinition).toEqual({ payload }); expect(await f.library.getRegistryRevision()).toBe(revision)
      await expect(f.library.import({ ...inputs[0]!, name: 'different command' })).rejects.toThrow('RESOURCE_IDEMPOTENCY_CONFLICT')
      await expect(f.library.update('asset-0', { name: 'stale', expectedRegistryRevision: 'sha256:stale' })).rejects.toThrow('RESOURCE_REGISTRY_CAS_MISMATCH')
      expect((await f.library.authoritySnapshot()).records).toHaveLength(12)
    } finally { await f.close() }
  })

  for (const stage of ['prepared_journal', 'index_published', 'journal_applied'] as ResourceAuthorityFaultStage[]) test(`原${stage}故障点可恢复；已应用回执可幂等重放`, async () => {
    const f = await authorityFixture()
    try {
      const input = await f.input('fault-asset', true), broken = new ResourceLibrary(f.directory, { faultInjector: point => { if (point === stage) throw Error('INJECTED_' + stage) } })
      await expect(broken.import(input)).rejects.toThrow('INJECTED_' + stage)
      const library = new ResourceLibrary(f.directory)
      await library.recoverResourceAuthorityOperations()
      expect((await library.authoritySnapshot()).records).toHaveLength(stage === 'journal_applied' ? 1 : 0)
      const restored = await library.import(input)
      expect(restored.replayed).toBe(stage === 'journal_applied'); expect(restored.componentDefaults?.largeDefinition).toEqual({ payload })
      expect((await library.authoritySnapshot()).records).toHaveLength(1)
    } finally { await f.close() }
  })

  for (const missing of [false, true]) test(`最后applied快照恢复${missing ? '缺失' : '损坏'}索引，字段与registryRevision完整`, async () => {
    const f = await authorityFixture()
    try {
      await f.library.import(await f.input('restore-index', true)); const before = await f.library.authoritySnapshot()
      if (missing) await rm(f.library.indexPath); else await writeFile(f.library.indexPath, '{broken')
      expect(await new ResourceLibrary(f.directory).recoverResourceAuthorityOperations()).toContain('import-restore-index')
      expect(await f.library.authoritySnapshot()).toEqual(before)
    } finally { await f.close() }
  })

  test('旧inline日志仍重放/恢复，下一次写入外置而不丢原快照或结果', async () => {
    const f = await authorityFixture()
    try {
      const input = await f.input('legacy', true); await f.library.import(input)
      const entries = await journalEntries(f.library), row = entries[0]
      for (const [key, refKey] of [['beforeCatalog', 'beforeCatalogRef'], ['afterCatalog', 'afterCatalogRef'], ['result', 'resultRef']]) { row[key!] = JSON.parse(await readFile(refFile(f.library, row[refKey!]), 'utf8')); delete row[refKey!] }
      await writeFile(f.library.journalPath, JSON.stringify(entries))
      expect((await new ResourceLibrary(f.directory).import(input)).replayed).toBe(true)
      await rm(f.library.indexPath); await f.library.recoverResourceAuthorityOperations()
      expect((await f.library.get('legacy')).componentDefaults?.largeDefinition).toEqual({ payload })
      await f.library.update('legacy', { name: 'renamed', operationID: 'rename-legacy', idempotencyKey: 'rename-key' })
      const converted = await journalEntries(f.library)
      expect(converted[0].result).toBeUndefined(); expect(converted[0].resultRef).toBeDefined(); expect((await f.library.get('legacy')).name).toBe('renamed')
    } finally { await f.close() }
  })

  test('历史结果引用lazy读取：不物化无关旧结果；对应重放才具名报告缺失', async () => {
    const f = await authorityFixture()
    try {
      const first = await f.input('lazy-a'); await f.library.import(first)
      const entry = (await journalEntries(f.library))[0]; await rm(refFile(f.library, entry.resultRef))
      await f.library.import(await f.input('lazy-b'))
      expect((await f.library.authoritySnapshot()).records).toHaveLength(2)
      await expect(f.library.import(first)).rejects.toThrow('RESOURCE_AUTHORITY_VALUE_MISSING')
    } finally { await f.close() }
  })

  test('结果SHA损坏与快照路径越界均具名拒绝，不改索引或外部原件', async () => {
    const f = await authorityFixture()
    try {
      const input = await f.input('bad-ref'); await f.library.import(input)
      const entries = await journalEntries(f.library), result = refFile(f.library, entries[0].resultRef), index = await readFile(f.library.indexPath)
      await writeFile(result, 'changed')
      await expect(f.library.import(input)).rejects.toThrow('RESOURCE_AUTHORITY_VALUE_HASH_MISMATCH')
      expect(await readFile(f.library.indexPath)).toEqual(index)
      entries[0].afterCatalogRef.path = '../../outside.json'; await writeFile(f.library.journalPath, JSON.stringify(entries)); await writeFile(f.library.indexPath, '{broken')
      await expect(f.library.recoverResourceAuthorityOperations()).rejects.toThrow('RESOURCE_AUTHORITY_VALUE_REF_INVALID')
      expect(await readFile(input.path, 'utf8')).toContain('"generator":"bad-ref"')
    } finally { await f.close() }
  })

  test('快照目录软链越界在写入前拒绝；旧损坏日志保原件且具名阻断', async () => {
    const f = await authorityFixture()
    try {
      const outside = join(f.root, 'outside'); await mkdir(outside); await mkdir(f.library.catalogRoot, { recursive: true }); await symlink(outside, join(f.library.catalogRoot, 'operations'), 'dir')
      await expect(f.library.import(await f.input('escape'))).rejects.toThrow('RESOURCE_AUTHORITY_VALUE_PATH_ESCAPE')
      expect(await readdir(outside)).toEqual([])
      const bad = '{not-json'; await writeFile(f.library.journalPath, bad)
      await expect(f.library.recoverResourceAuthorityOperations()).rejects.toThrow('RESOURCE_AUTHORITY_JOURNAL_UNREADABLE')
      expect(await readFile(f.library.journalPath, 'utf8')).toBe(bad)
    } finally { await f.close() }
  })

  for (const stage of ['after_file_moved', 'after_transition_journal', 'index_published'] as ResourceAuthorityFaultStage[]) test(`多文件Move在${stage}故障后按inventory完整回滚`, async () => {
    const f = await authorityFixture()
    try {
      const path = join(f.inputs, 'model.glb'), bin = join(f.inputs, 'geometry.bin'), texture = join(f.inputs, 'texture.png')
      const binBytes = Buffer.alloc(36)
      await writeFile(path, glbBytes('move-model', { bin: 'geometry.bin', image: 'texture.png', binBytes: binBytes.length })); await writeFile(bin, binBytes); await writeFile(texture, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aST8AAAAASUVORK5CYII=', 'base64'))
      const before = new Map(await Promise.all([path, bin, texture].map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')] as const)))
      await f.library.import({ path, resourceId: 'move-asset', storage: 'reference', physicalizationRequest: false })
      const target = join(f.root, 'moved', 'renamed.glb'), broken = new ResourceLibrary(f.directory, { faultInjector: point => { if (point === stage) throw Error('INJECTED_' + stage) } })
      await expect(broken.move({ resourceId: 'move-asset', targetPath: target, operationID: 'move-operation', idempotencyKey: 'move-key' })).rejects.toThrow('INJECTED_' + stage)
      await f.library.recoverResourceAuthorityOperations()
      for (const [file, hash] of before) expect(createHash('sha256').update(await readFile(file)).digest('hex')).toBe(hash)
      expect(fileURLToPath((await f.library.get('move-asset')).ref.original.uri)).toBe(path)
      expect(await stat(target).then(() => true, () => false)).toBe(false)
    } finally { await f.close() }
  })

  test('正常Move与rollback都保留依赖与幂等结果，不二次搬文件', async () => {
    const f = await authorityFixture()
    try {
      const input = await f.input('move-normal'); await f.library.import(input)
      const move = { resourceId: 'move-normal', targetPath: join(f.root, 'moved', 'renamed.glb'), operationID: 'move-normal-operation', idempotencyKey: 'move-normal-key' }
      const moved = await f.library.move(move); expect((await f.library.move(move)).ref).toEqual(moved.ref)
      expect(fileURLToPath(moved.ref.original.uri)).toBe(move.targetPath)
      const rollback = { resourceId: 'move-normal', operationID: 'rollback-operation', idempotencyKey: 'rollback-key' }
      expect(fileURLToPath((await f.library.rollbackMove(rollback)).ref.original.uri)).toBe(input.path)
      expect(fileURLToPath((await f.library.rollbackMove(rollback)).ref.original.uri)).toBe(input.path)
      expect((await f.library.verify('move-normal')).valid).toBe(true)
    } finally { await f.close() }
  })
})
