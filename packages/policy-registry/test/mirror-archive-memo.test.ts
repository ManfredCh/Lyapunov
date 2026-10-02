/**
 * 归档这条路的**两条真缺口**（U3／U4 · 2026-09-27）的门：
 *
 *   K. **记忆化**：同一个归档 URL **只取一次字节、只解一次包**，其余件从那份解包结果里取
 *      —— 但**判据一步不省**（每件各自命中、各自写盘、各自过门①、各自过门②）；
 *   L. **只放宽归档这一跳**：归档那一跳有自己的上限（30 min），其它每一跳的 30 s **逐字不变**。
 *
 * 为什么这两条要单独成族：G1 实测（一次取件 68 件）里，**68 次取字节 + 68 次解包**＝509.8 s 全花在
 * 重复解包上，而默认取字节路径的 30 s（含读正文）在 59.8 MB / 1400.4 s 的链路上**连一次都跑不完**
 * —— 也就是说这条路"能算出来，但默认路径取不完"。这里的 3 件用例是那 68 件的同形缩小版；
 * 真字节那 68 件的读数在 `bugfixHistory/ARCHIVE-FETCH-MEMOIZATION-20260926.md`（`.runtime/archive-memo/**`）。
 *
 * 全部用例**离线**：归档字节由 `gzipSync` 现场造，"网络"要么是 `archive.fetch` 接缝，要么是
 * `globalThis.fetch` 替身（连出网与否都要在本文件里看得见）；**一次都不打 GitHub**。
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  MIRROR_ARCHIVE_FETCH_TIMEOUT_MS, MirrorArchiveCache, fetchFromMirrors, knownMirrorCandidates,
  mirrorArchiveCacheStats, resetMirrorArchiveCache, unpackMirrorArchive, type DeclaredIdentity,
} from '../src/mirror-search.ts'
import { POLICY_FETCH_TIMEOUT_MS } from '../src/source.ts'
import type { SourceFile } from '../src/source.ts'

const REPO = 'unitreerobotics/unitree_rl_gym'
const PATH_A = 'policy/params/parameters.pkl'
const PATH_B = 'deploy/deploy_mujoco/configs/g1.yaml'
const PATH_C = 'resources/robots/g1_description/g1_12dof.xml'
const BODY_A = Buffer.from('lyapunov-policy-bytes-'.repeat(64))
const BODY_B = Buffer.from('num_obs: 47\nnum_actions: 12\n')
const BODY_C = Buffer.from('<mujoco/>\n'.repeat(40))
const gitBlob = (content: Buffer) => createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
const IMPOSTOR_A = Buffer.from(BODY_A.toString('latin1').replace(/^l/, 'L')) // 同长度、不同内容
const workdir = () => mkdtempSync(join(tmpdir(), 'mirror-archive-memo-'))
const declaredFor = (path: string, content: Buffer, over: Partial<DeclaredIdentity['identity']> = {}): DeclaredIdentity =>
  ({ identity: { path, bytes: content.length, gitBlob: gitBlob(content), ...over }, provenance: 'source-snapshot', note: '本用例自造（与网络无关）' })

/* ── 造归档：一个够用的 ustar 写入器（只写本族用例要的字段；与 mirror-archive.test.ts 同形，独立一份） ── */
const BLOCK = 512
function tarEntry(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(BLOCK)
  header.write(name.slice(0, 100), 0, 100, 'latin1')
  header.write('0000644\0', 100, 8, 'latin1')
  header.write('0000000\0', 108, 8, 'latin1')
  header.write('0000000\0', 116, 8, 'latin1')
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'latin1')
  header.write('00000000000\0', 136, 12, 'latin1')
  header.write('        ', 148, 8, 'latin1')
  header.write('0', 156, 1, 'latin1')
  header.write('ustar\0', 257, 6, 'latin1')
  header.write('00', 263, 2, 'latin1')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1')
  const padded = Buffer.alloc(Math.ceil(content.length / BLOCK) * BLOCK)
  content.copy(padded)
  return Buffer.concat([header, padded])
}
const tarGz = (revision: string, rows: Array<{ path: string; content: Buffer }>) =>
  gzipSync(Buffer.concat([...rows.map(row => tarEntry(`unitree_rl_gym-${revision}/${row.path}`, row.content)), Buffer.alloc(1024)]))

/** 每个用例一份**自己的** revision：模块默认缓存按 URL 键，用例之间不许串味。 */
let revision = ''
let root = ''
beforeEach(() => {
  revision = createHash('sha1').update(`${Math.random()}-${Date.now()}`).digest('hex')
  root = workdir()
  resetMirrorArchiveCache()
})
const archiveCandidate = (declared: DeclaredIdentity) => knownMirrorCandidates({ provider: 'github', modelId: REPO, revision }, declared).find(row => row.shape === 'archive')!
/** blob（raw）那条路一律关掉 ⇒ served 的每一件**只可能**来自归档。 */
const blobDisabled = async (_file: SourceFile) => { throw new Error('BLOB_PATH_DISABLED_BY_CASE') }

describe('K. 记忆化：同一个归档 URL 只取一次字节、只解一次包（判据一件不省）', () => {
  test('★3 件共用一份解包结果：取字节 1 次、解包 1 次，三件各自过门落地（`memoized` 逐件可见）', async () => {
    const rows = [{ path: PATH_A, content: BODY_A }, { path: PATH_B, content: BODY_B }, { path: PATH_C, content: BODY_C }]
    const archive = tarGz(revision, rows)
    const cache = new MirrorArchiveCache()
    let calls = 0
    const seam = async () => { calls += 1; return archive }
    const readings: Array<{ path: string; gitBlob?: string; memoized: boolean }> = []
    for (const row of rows) {
      const declared = declaredFor(row.path, row.content)
      const result = await fetchFromMirrors({
        declared, coordinates: { provider: 'github', modelId: REPO, revision }, candidates: [archiveCandidate(declared)],
        target: join(root, row.path), signal: new AbortController().signal, includeArchive: true,
        download: blobDisabled, archive: { root: `unitree_rl_gym-${revision}`, fetch: seam, cache },
      })
      const archiveReading = (result.reading as unknown as { archive: { memoized: boolean } }).archive
      readings.push({ path: row.path, gitBlob: result.reading.gitBlob, memoized: archiveReading.memoized })
      expect(result.servedBy.shape).toBe('archive')
    }
    // 判据①：**取字节 1 次、解包 1 次**（而不是 3 件各来一遍）
    expect(calls).toBe(1)
    expect(cache.stats()).toMatchObject({ downloads: 1, unpacks: 1, hits: 2, size: 1 })
    // 第一件是真取真解，后两件是复用（读数里逐件可见，不是靠推断）
    expect(readings.map(row => row.memoized)).toEqual([false, true, true])
    // 判据一步没省：三件各自的字节身份都在（门①/门②逐件做过），文件也都在
    expect(readings.map(row => row.gitBlob)).toEqual([gitBlob(BODY_A), gitBlob(BODY_B), gitBlob(BODY_C)])
    for (const row of rows) expect(readFileSync(join(root, row.path)).equals(row.content)).toBe(true)
  })

  test('键＝URL＋期望 sha：换钉不复用、换 URL 不复用；**没钉时记住的那份不会被有钉的调用复用**', async () => {
    const archive = tarGz(revision, [{ path: PATH_A, content: BODY_A }])
    const other = tarGz(revision, [{ path: PATH_A, content: IMPOSTOR_A }])
    const pin = createHash('sha256').update(archive).digest('hex')
    const cache = new MirrorArchiveCache()
    const declared = declaredFor(PATH_A, BODY_A)
    const candidate = archiveCandidate(declared)
    const run = (options: Record<string, unknown>, bytes: () => Buffer, target: string) => unpackMirrorArchive({
      declared, candidate, target, signal: new AbortController().signal,
      options: { root: `unitree_rl_gym-${revision}`, fetch: async () => bytes(), cache, ...options },
    })
    // ① 没钉 ⇒ 键是 `unpinned`：记住第一份
    await run({}, () => archive, join(root, 'a1.pkl'))
    await run({}, () => other, join(root, 'a2.pkl')) // 同一个 URL 的第二份字节：命中第一份（该实例内"首次见到即记住"）
    expect(readFileSync(join(root, 'a2.pkl')).equals(BODY_A)).toBe(true)
    // ② 有钉 ⇒ 键里带 sha，**不复用**上面那份没钉的（拿不准的东西不冒充核对过的）
    await run({ expectedSha256: pin }, () => archive, join(root, 'a3.pkl'))
    expect(cache.stats()).toMatchObject({ downloads: 2, unpacks: 2, hits: 1 })
    // ③ 同一个钉的第二次取件 ⇒ 复用（这才是 68 件要的那条路）
    await run({ expectedSha256: pin }, () => { throw new Error('RE_FETCH_IS_NOT_EXPECTED') }, join(root, 'a4.pkl'))
    expect(cache.stats()).toMatchObject({ downloads: 2, unpacks: 2, hits: 2 })
  })

  test('钉不符 ⇒ PIN_MISMATCH：字节不落地、也不进缓存（下一次拿对钉仍要真取）', async () => {
    const archive = tarGz(revision, [{ path: PATH_A, content: BODY_A }])
    const cache = new MirrorArchiveCache()
    const declared = declaredFor(PATH_A, BODY_A)
    const wrong = 'f'.repeat(64)
    const target = join(root, 'pinned.pkl')
    const failure = unpackMirrorArchive({
      declared, candidate: archiveCandidate(declared), target, signal: new AbortController().signal,
      options: { root: `unitree_rl_gym-${revision}`, fetch: async () => archive, cache, expectedSha256: wrong },
    })
    await expect(failure).rejects.toThrow(/POLICY_MIRROR_ARCHIVE_PIN_MISMATCH/)
    expect(existsSync(target)).toBe(false)
    expect(existsSync(target + '.part')).toBe(false)
    expect(cache.stats()).toMatchObject({ downloads: 1, unpacks: 0, size: 0 }) // 钉在解压之前就核；失败不留表
    const right = createHash('sha256').update(archive).digest('hex')
    await unpackMirrorArchive({
      declared, candidate: archiveCandidate(declared), target, signal: new AbortController().signal,
      options: { root: `unitree_rl_gym-${revision}`, fetch: async () => archive, cache, expectedSha256: right },
    })
    expect(cache.stats()).toMatchObject({ downloads: 2, unpacks: 1 })
  })

  test('钉的形状不对 ⇒ PIN_INVALID：**不**静默降级成"没有钉"（那会把一次核对悄悄变成不核对）', async () => {
    const archive = tarGz(revision, [{ path: PATH_A, content: BODY_A }])
    const declared = declaredFor(PATH_A, BODY_A)
    await expect(unpackMirrorArchive({
      declared, candidate: archiveCandidate(declared), target: join(root, 'bad-pin.pkl'), signal: new AbortController().signal,
      options: { root: `unitree_rl_gym-${revision}`, fetch: async () => archive, expectedSha256: 'not-a-sha256' },
    })).rejects.toThrow(/POLICY_MIRROR_ARCHIVE_PIN_INVALID/)
  })

  test('没钉时默认**不缓存**（只按 URL 记的键分不清同一个 URL 先后吐了什么）；`cache:null` 关得掉', async () => {
    const archive = tarGz(revision, [{ path: PATH_A, content: BODY_A }])
    const declared = declaredFor(PATH_A, BODY_A)
    let calls = 0
    const once = (options: Record<string, unknown>, target: string) => unpackMirrorArchive({
      declared, candidate: archiveCandidate(declared), target, signal: new AbortController().signal,
      options: { root: `unitree_rl_gym-${revision}`, fetch: async () => { calls += 1; return archive }, ...options },
    })
    await once({}, join(root, 'n1.pkl'))
    await once({}, join(root, 'n2.pkl'))
    expect(calls).toBe(2) // 默认：没钉 ⇒ 每次都真取（模块默认缓存不掺和）
    expect(mirrorArchiveCacheStats().downloads).toBe(0)
    await once({ cache: null }, join(root, 'n3.pkl'))
    expect(calls).toBe(3)
    // 显式交实例 ⇒ 没钉也复用（可信边界归调用方：一次取件的 68 件共用**同一个**实例）
    const cache = new MirrorArchiveCache()
    await once({ cache }, join(root, 'n4.pkl'))
    await once({ cache }, join(root, 'n5.pkl'))
    expect(calls).toBe(4)
    expect(cache.stats()).toMatchObject({ downloads: 1, unpacks: 1, hits: 1 })
  })

  test('模块默认缓存：**有钉**时进程内共享（68 件这种"同一个 URL、同一个钉"的形态走的就是它）', async () => {
    const archive = tarGz(revision, [{ path: PATH_A, content: BODY_A }, { path: PATH_B, content: BODY_B }])
    const pin = createHash('sha256').update(archive).digest('hex')
    let calls = 0
    for (const [path, content] of [[PATH_A, BODY_A], [PATH_B, BODY_B]] as const) {
      const declared = declaredFor(path, content)
      const result = await fetchFromMirrors({
        declared, coordinates: { provider: 'github', modelId: REPO, revision }, candidates: [archiveCandidate(declared)],
        target: join(root, path), signal: new AbortController().signal, includeArchive: true, download: blobDisabled,
        archive: { root: `unitree_rl_gym-${revision}`, fetch: async () => { calls += 1; return archive }, expectedSha256: pin },
      })
      expect(result.servedBy.shape).toBe('archive')
    }
    expect(calls).toBe(1)
    expect(mirrorArchiveCacheStats()).toMatchObject({ downloads: 1, unpacks: 1, hits: 1 })
  })

  test('缓存有界：capacity=1 的两份归档交替 ⇒ LRU 淘汰（不许无声长成"进程里堆满 150 MB"）', async () => {
    const archive = tarGz(revision, [{ path: PATH_A, content: BODY_A }])
    const cache = new MirrorArchiveCache(1)
    const declaredA = declaredFor(PATH_A, BODY_A)
    await unpackMirrorArchive({ declared: declaredA, candidate: archiveCandidate(declaredA), target: join(root, 'l1.pkl'), signal: new AbortController().signal, options: { root: `unitree_rl_gym-${revision}`, fetch: async () => archive, cache } })
    // 第二个 URL（换 revision ⇒ 换 URL，候选也跟着换），归档的顶层目录与之一致
    const other = revision.replace(/^./, char => (char === 'a' ? 'b' : 'a'))
    const otherArchive = tarGz(other, [{ path: PATH_A, content: BODY_A }])
    const declaredB = declaredFor(PATH_A, BODY_A)
    const candidateB = knownMirrorCandidates({ provider: 'github', modelId: REPO, revision: other }, declaredB).find(row => row.shape === 'archive')!
    await unpackMirrorArchive({ declared: declaredB, candidate: candidateB, target: join(root, 'l2.pkl'), signal: new AbortController().signal, options: { root: `unitree_rl_gym-${other}`, fetch: async () => otherArchive, cache } })
    expect(cache.stats()).toMatchObject({ capacity: 1, size: 1, downloads: 2, evictions: 1 })
  })

  test('命中**不省判据**：第二件声明与归档内容不符 ⇒ 照样被拒（门①仍然逐件做）', async () => {
    const archive = tarGz(revision, [{ path: PATH_A, content: BODY_A }])
    const cache = new MirrorArchiveCache()
    const seam = async () => archive
    const good = declaredFor(PATH_A, BODY_A)
    const result = await fetchFromMirrors({
      declared: good, coordinates: { provider: 'github', modelId: REPO, revision }, candidates: [archiveCandidate(good)],
      target: join(root, 'ok.pkl'), signal: new AbortController().signal, includeArchive: true, download: blobDisabled,
      archive: { root: `unitree_rl_gym-${revision}`, fetch: seam, cache },
    })
    expect(result.reading.gitBlob).toBe(gitBlob(BODY_A))
    // 第二件：同一条目、同一份（已缓存的）解包结果，但**声明**要的是另一份字节 ⇒ 门①当场拒，坏字节不落地
    const impostor = declaredFor(PATH_A, IMPOSTOR_A)
    const bad = fetchFromMirrors({
      declared: impostor, coordinates: { provider: 'github', modelId: REPO, revision }, candidates: [archiveCandidate(impostor)],
      target: join(root, 'impostor.pkl'), signal: new AbortController().signal, includeArchive: true, download: blobDisabled,
      archive: { root: `unitree_rl_gym-${revision}`, fetch: seam, cache },
    })
    await expect(bad).rejects.toThrow(/POLICY_MIRROR_ARCHIVE_IDENTITY_MISMATCH/)
    expect(existsSync(join(root, 'impostor.pkl'))).toBe(false)
    expect(existsSync(join(root, 'impostor.pkl.part'))).toBe(false)
    expect(cache.stats()).toMatchObject({ downloads: 1, unpacks: 1, hits: 1 })
  })

  test('上限进键：同一个 URL、更严的 maxBytes 不复用已缓存的材料（尺子不同就不是同一份材料）', async () => {
    const archive = tarGz(revision, [{ path: PATH_A, content: BODY_A }])
    const cache = new MirrorArchiveCache()
    const declared = declaredFor(PATH_A, BODY_A)
    const run = (options: Record<string, unknown>, target: string) => unpackMirrorArchive({
      declared, candidate: archiveCandidate(declared), target, signal: new AbortController().signal,
      options: { root: `unitree_rl_gym-${revision}`, fetch: async () => archive, cache, ...options },
    })
    await run({}, join(root, 'm1.pkl'))
    await expect(run({ maxBytes: 8 }, join(root, 'm2.pkl'))).rejects.toThrow(/POLICY_MIRROR_ARCHIVE_OVERSIZED/)
    expect(cache.stats()).toMatchObject({ downloads: 2, unpacks: 1 })
  })
})

describe('L. 超时：**只**放宽归档这一跳（其它每一跳的 30 s 逐字不变）', () => {
  test('L1 常量：归档那一跳 30 min；全局默认仍是 30 s（一个字没改）', () => {
    expect(MIRROR_ARCHIVE_FETCH_TIMEOUT_MS).toBe(1_800_000)
    expect(POLICY_FETCH_TIMEOUT_MS).toBe(30_000)
    // 30 min 的出处：G1 那条链路实测 1400.4 s（59,810,743 B ÷ 1400.4 s ≈ 42.7 KB/s）⇒ 上限必须盖得住它
    expect(MIRROR_ARCHIVE_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(1_400_400)
  })

  test('L2 源码守卫：本文件只有一处联网取字节（归档那一跳）且它才带 `timeoutMs`；放宽的值进不了别的跳', () => {
    const src = join(import.meta.dir, '..', 'src')
    const code = (text: string) => text.split('\n').filter(line => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*'))
    })
    const search = code(readFileSync(join(src, 'mirror-search.ts'), 'utf8'))
    // ① 全局默认的字面仍在 source.ts 里（"其它跳的字面逐字不变"是这一条）
    //    用 `/re/.test(...)` + `toBe(true)` 而不是 `toMatch` —— 断言失败时不要把 77 KB 源码整份打到读数里
    expect(/export const POLICY_FETCH_TIMEOUT_MS = 30_000/.test(readFileSync(join(src, 'source.ts'), 'utf8'))).toBe(true)
    // ② 本文件里 `boundedFetch` 只出现一次 ⇒ 只有归档这一跳能被打到，也就没有"第二跳被顺手放宽"的余地
    const hops = search.filter(line => line.includes('boundedFetch('))
    expect(hops).toHaveLength(1)
    // ③ 而且那一处正是带 `timeoutMs` 的那一处
    expect(hops[0]).toContain("step: '建连', trace, timeoutMs")
    // ④ 全文件没有任何**数字字面量**的 timeoutMs（放宽的值只能来自那条常量或调用方的覆写）
    expect(search.filter(line => /timeoutMs:\s*\d/.test(line))).toHaveLength(0)
    // ⑤ 本文件根本不引用全局默认常量 ⇒ 它连"被改"的机会都没有
    expect(search.some(line => line.includes('POLICY_FETCH_TIMEOUT_MS'))).toBe(false)
  })

  test('L3 `timeoutMs` 真的就是这一跳的实际上限（不是个摆设读数）：同一条慢链路，短上限死、默认上限活', async () => {
    const archive = tarGz(revision, [{ path: PATH_A, content: BODY_A }])
    const declared = declaredFor(PATH_A, BODY_A)
    const slot = (delayMs: number) => {
      const original = globalThis.fetch
      const urls: string[] = []
      globalThis.fetch = (async (input: unknown, init: any = {}) => {
        urls.push(String(input))
        const signal: AbortSignal | undefined = init?.signal
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const timer = setTimeout(() => { try { controller.enqueue(new Uint8Array(archive)); controller.close() } catch { /* aborted */ } }, delayMs)
            signal?.addEventListener('abort', () => { clearTimeout(timer); try { controller.error(signal.reason ?? new Error('POLICY_CANCELLED')) } catch { /* already closed */ } }, { once: true })
          },
        })
        return new Response(stream, { status: 200, headers: { 'content-length': String(archive.length) } })
      }) as unknown as typeof fetch
      return { urls, restore: () => { globalThis.fetch = original } }
    }
    // ① 注入的上限就是这一跳的天花板：300 ms 的正文，80 ms 上限 ⇒ 当场死（且是超时那条形状）
    const short = slot(300)
    try {
      const failure = unpackMirrorArchive({
        declared, candidate: archiveCandidate(declared), target: join(root, 'short.pkl'), signal: new AbortController().signal,
        options: { root: `unitree_rl_gym-${revision}`, timeoutMs: 80, cache: null },
      })
      await expect(failure).rejects.toThrow(/timed out|timeout/i)
      expect(existsSync(join(root, 'short.pkl'))).toBe(false)
      expect(short.urls).toHaveLength(1) // 死在读正文上（与 G1 那两次真实尝试同形），没有"再取一遍"
    } finally { short.restore() }
    // ② 默认上限（30 min）下，同一条 300 ms 链路跑完 ⇒ 59.8 MB 那一跳能跑完的**机制**在这里被钉住
    const slow = slot(300)
    try {
      const reading = await unpackMirrorArchive({
        declared, candidate: archiveCandidate(declared), target: join(root, 'slow.pkl'), signal: new AbortController().signal,
        options: { root: `unitree_rl_gym-${revision}`, cache: null },
      })
      expect(reading.archive.fetchTimeoutMs).toBe(MIRROR_ARCHIVE_FETCH_TIMEOUT_MS)
      expect(reading.archive.compressedBytes).toBe(archive.length)
      expect(readFileSync(join(root, 'slow.pkl')).equals(BODY_A)).toBe(true)
      expect(slow.urls).toEqual([`https://codeload.github.com/${REPO}/tar.gz/${revision}`])
    } finally { slow.restore() }
  })

  test('L4 读数如实：`fetchTimeoutMs`／`archiveSha256`／`expectedSha256`／`memoized` 四样都在读数里', async () => {
    const archive = tarGz(revision, [{ path: PATH_A, content: BODY_A }])
    const pin = createHash('sha256').update(archive).digest('hex')
    const declared = declaredFor(PATH_A, BODY_A)
    const reading = await unpackMirrorArchive({
      declared, candidate: archiveCandidate(declared), target: join(root, 'reading.pkl'), signal: new AbortController().signal,
      options: { root: `unitree_rl_gym-${revision}`, fetch: async () => archive, expectedSha256: pin },
    })
    expect(reading.archive).toMatchObject({ archiveSha256: pin, expectedSha256: pin, memoized: false, fetchTimeoutMs: MIRROR_ARCHIVE_FETCH_TIMEOUT_MS, entries: 1 })
    // 没钉的形态如实写 `null`（不是悄悄写个空串）
    const bare = await unpackMirrorArchive({
      declared, candidate: archiveCandidate(declared), target: join(root, 'bare.pkl'), signal: new AbortController().signal,
      options: { root: `unitree_rl_gym-${revision}`, fetch: async () => archive, cache: null },
    })
    expect(bare.archive.expectedSha256).toBeNull()
    expect(bare.archive.archiveSha256).toBe(pin)
  })
})
