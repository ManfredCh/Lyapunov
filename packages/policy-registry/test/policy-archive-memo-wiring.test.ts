/**
 * **产品侧接线**：`source.ts` 的 `fetchPolicyFileViaArchive()` 把归档记忆化真正接上（2026-09-27）。
 *
 * 回执：`bugfixHistory/SOURCE-MEMO-WIRING-AND-SENTINEL-20260927.md`。
 *
 * ## 它钉的是哪一条
 *
 * `mirror-search.ts` 的记忆化（ARCHIVE-FETCH-MEMOIZATION）**没钉时默认不缓存**：
 * `resolveMirrorArchiveCache` = `options.cache ?? (options.expectedSha256 ? defaultMirrorArchiveCache : undefined)`。
 * 产品侧既没有钉、也没有交实例 ⇒ 一次取件里 68 件同属一棵树时仍然是 **68 次取字节 + 68 次解包**
 * （G1 实测 509.8 s；本单同口径重测两轮 **160.3 s / 136 次取字节 / 136 次解包**）。
 *
 * 接线后（本文件钉住的三句话）：
 *   1. **同一进程内第二次取同一个归档：不再下载、不再解包**（`memoized === true` 逐件可见）；
 *   2. **判据一件都不省**：命中之后每一件仍然命中条目、写 `.part`、过**门①**（与声明逐字核对）、
 *      过**门②**（`verifyMirrorReading`）—— 声明对不上照样**当场拒**，缓存不是"绕过判据"的入口；
 *   3. **失败不进缓存**：同一次失败（错钉）取两次 ⇒ 真的取两次字节（不会被记住成"这个 URL 不可用"）。
 *
 * ## 边界（如实登记）
 *
 * 全部用例**离线**：归档字节由 `gzipSync` 现场造（3 件的小归档），网络只有 `archive.fetch` 接缝
 * —— **0 次真实网络、0 次真实配额、不打 GitHub**。读数一律取**增量**（共享实例是进程级的，
 * 用例之间不许互相把计数当断言）。
 *
 * **未覆盖（如实登记）**：**有钉那条路**（`expectedSha256` 给了 ⇒ 走 `mirror-search.ts` 的
 * **模块默认缓存**）在本文件里只有**静态**接线守卫、没有行为用例 —— 原因是那个模块默认缓存是
 * **进程级、计数不可重置**的共享状态，而同进程的 `mirror-archive-memo.test.ts` 有 3 条**绝对计数**
 * 断言（`{downloads:1, unpacks:1, hits:1}`）：本文件一碰它就会把那 3 条染色（实测整目录
 * 313 pass/2 fail；把本文件移出去 310 pass/0 fail）。该路由的行为读数由回执 §3 的探针给
 * （真树、真字节、零出网：`mirrorArchiveCacheStats()` = `{downloads:1, unpacks:1, hits:135}`）。
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fetchPolicyFileViaArchive, policyArchiveCache, policyArchiveCacheStats } from '../src/source.ts'
import { resetMirrorArchiveCache, type DeclaredIdentity } from '../src/mirror-search.ts'

const REPO = 'unitreerobotics/unitree_rl_gym'
const PATH_A = 'policy/params/parameters.pkl'
const PATH_B = 'deploy/deploy_mujoco/configs/g1.yaml'
const PATH_C = 'resources/robots/g1_description/g1_12dof.xml'
const BODY_A = Buffer.from('lyapunov-policy-bytes-'.repeat(64))
const BODY_B = Buffer.from('num_obs: 47\nnum_actions: 12\n')
const BODY_C = Buffer.from('<mujoco/>\n'.repeat(40))
const ROWS = [{ path: PATH_A, content: BODY_A }, { path: PATH_B, content: BODY_B }, { path: PATH_C, content: BODY_C }]
const gitBlob = (content: Buffer) => createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
const workdir = () => mkdtempSync(join(tmpdir(), 'policy-archive-wiring-'))
const declaredFor = (path: string, content: Buffer, over: Partial<DeclaredIdentity['identity']> = {}): DeclaredIdentity =>
  ({ identity: { path, bytes: content.length, gitBlob: gitBlob(content), ...over }, provenance: 'source-snapshot', note: '本用例自造（与网络无关）' })

/* ── 造归档：一个够用的 ustar 写入器（与 `mirror-archive-memo.test.ts` 同形，独立一份） ── */
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

/** 每个用例一份**自己的** revision：缓存键里有 URL（含 revision）⇒ 用例之间不许串味。 */
let revision = ''
let root = ''
beforeEach(() => {
  revision = createHash('sha1').update(`${Math.random()}-${Date.now()}`).digest('hex')
  root = workdir()
  policyArchiveCache().clear()   // 只清条目（累计计数是"这个实例干了多少活"的读数，用增量断言）
  resetMirrorArchiveCache()
})
/** 取一轮：3 件各一次 `fetchPolicyFileViaArchive`（＝产品入口），返回逐件的 `memoized` 与身份读数。 */
const round = async (options: { target: string; archive: Record<string, unknown>; rows?: Array<{ path: string; content: Buffer }> }) => {
  const rows = options.rows ?? ROWS
  const out: Array<{ path: string; memoized: boolean | null; gitBlob?: string }> = []
  for (const row of rows) {
    const declared = declaredFor(row.path, row.content)
    const result = await fetchPolicyFileViaArchive({
      coordinates: { provider: 'github', modelId: REPO, revision }, declared,
      target: join(options.target, row.path), signal: new AbortController().signal,
      archive: { root: `unitree_rl_gym-${revision}`, ...options.archive },
    })
    const reading = result.reading as unknown as { archive?: { memoized?: boolean } }
    out.push({ path: row.path, memoized: reading.archive?.memoized ?? null, gitBlob: result.reading.gitBlob })
  }
  return out
}

describe('接线：同一进程内第二次取同一个归档 ⇒ 不再下载、不再解包', () => {
  test('★冷启动（没有钉）：3 件 + 再 3 件 ⇒ 取字节 1 次、真解包 1 次、命中 5 次（走共享实例）', async () => {
    const archive = tarGz(revision, ROWS)
    let calls = 0
    const seam = async () => { calls += 1; return archive }
    const before = policyArchiveCacheStats()

    const first = await round({ target: join(root, 'r1'), archive: { fetch: seam } })
    const second = await round({ target: join(root, 'r2'), archive: { fetch: seam } })

    // 判据①：**第二轮一件都没再取、没再解**
    expect(calls).toBe(1)
    expect(first.map(row => row.memoized)).toEqual([false, true, true])
    expect(second.map(row => row.memoized)).toEqual([true, true, true])
    // ★派单要的读数（增量）：downloads:1 / unpacks:1 / hits:5
    const after = policyArchiveCacheStats()
    expect({ downloads: after.downloads - before.downloads, unpacks: after.unpacks - before.unpacks, hits: after.hits - before.hits })
      .toEqual({ downloads: 1, unpacks: 1, hits: 5 })
    // 判据②：命中不省判据 —— 三件的字节身份仍逐件对上（门①/门②照做），两轮都落了盘
    expect(first.map(row => row.gitBlob)).toEqual(ROWS.map(row => gitBlob(row.content)))
    for (const pass of ['r1', 'r2']) for (const row of ROWS) expect(readFileSync(join(root, pass, row.path)).equals(row.content)).toBe(true)
  })

  /**
   * ⚠️ **这条是静态守卫，不是行为用例** —— 有钉那条路必须走 `mirror-search.ts` 的**模块默认缓存**，
   * 而它是**进程级、计数不可重置**的共享状态：同进程里 `mirror-archive-memo.test.ts` 有绝对计数断言
   * （`{downloads:1, unpacks:1, hits:1}`）。本文件一碰它，那几条就被染色（实测整目录 313 pass/2 fail，
   * 去掉本文件 310 pass/0 fail）⇒ 有钉那条路的**读数**由回执 §3 的探针给（真树、真字节、零出网：
   * `mirrorArchiveCacheStats()` = `{downloads:1, unpacks:1, hits:135}`），这里只钉**接线形态**。
   */
  test('接线形态守卫（静态）：没钉 ⇒ 传共享实例；有钉 ⇒ 交给 `mirror-search.ts` 的模块默认实例', () => {
    const text = readFileSync(join(import.meta.dirname, '..', 'src', 'source.ts'), 'utf8')
    expect(text).toContain('const pinned = input.archive?.expectedSha256 !== undefined')
    expect(text).toContain('...(pinned ? {} : { cache: policyArchiveCache() })')
    // 调用方**不能**自己塞一个缓存、也不能把它关掉（否则"一次取件的 68 件各记一份"会重新出现）
    expect(text).toContain("archive?: Omit<MirrorArchiveOptions, 'cache'>")
    expect(text).toContain('export function policyArchiveCache(): MirrorArchiveCache')
  })

  test('★命中不省判据：材料已在缓存里，声明换成**错身份**照样当场拒（门①），且不落地、不新增取字节', async () => {
    const archive = tarGz(revision, ROWS)
    let calls = 0
    const seam = async () => { calls += 1; return archive }
    await round({ target: join(root, 'r1'), archive: { fetch: seam } })   // 先把材料记住

    // 同长度、不同内容 ⇒ 名字对得上、内容不是那一份：这正是门①要拦的形状
    const impostor = Buffer.from(BODY_B.toString('latin1').replace(/^n/, 'N'))
    const wrong = declaredFor(PATH_B, impostor, { bytes: BODY_B.length, gitBlob: gitBlob(impostor) })
    const target = join(root, 'r2', PATH_B)
    const error = await fetchPolicyFileViaArchive({
      coordinates: { provider: 'github', modelId: REPO, revision }, declared: wrong, target,
      signal: new AbortController().signal, archive: { root: `unitree_rl_gym-${revision}`, fetch: seam },
    }).then(() => null, (reason: Error) => reason)

    expect(String(error)).toContain('POLICY_MIRROR_ARCHIVE_IDENTITY_MISMATCH')
    expect(String(error)).toContain('gitBlob 不符')
    expect(calls).toBe(1)                       // 命中 ⇒ **没有**再取字节
    expect(existsSync(target)).toBe(false)      // 坏字节不落地
    expect(existsSync(target + '.part')).toBe(false)  // 门①不留 .part
  })

  test('失败不进缓存：同一个坏归档取两次 ⇒ 真的取两次字节（失败没被记住）', async () => {
    let calls = 0
    const seam = async () => { calls += 1; return Buffer.from('not a gzip at all') }
    const attempt = () => fetchPolicyFileViaArchive({
      coordinates: { provider: 'github', modelId: REPO, revision }, declared: declaredFor(PATH_A, BODY_A),
      target: join(root, 'x', PATH_A), signal: new AbortController().signal,
      archive: { root: `unitree_rl_gym-${revision}`, fetch: seam },
    }).then(() => null, (reason: Error) => reason)

    const first = await attempt(), second = await attempt()
    // `fetchFromMirrors` 把该候选的拒绝原因包进 `POLICY_MIRROR_EXHAUSTED`（原因逐条在报文里）
    expect(String(first)).toContain('POLICY_MIRROR_ARCHIVE_UNREADABLE')
    expect(String(second)).toContain('POLICY_MIRROR_ARCHIVE_UNREADABLE')
    expect(calls).toBe(2)                                  // ①解包失败 ⇒ ②第二次仍要真取（失败不进表）
    expect(existsSync(join(root, 'x', PATH_A))).toBe(false)
  })

  test('形态纪律没动：候选只留归档那一条（blob 候选不试），非 github 源没有归档候选 ⇒ 老实报 EXHAUSTED', async () => {
    const exhausted = await fetchPolicyFileViaArchive({
      coordinates: { provider: 'modelscope', modelId: 'unitreerobotics/unitree_rl_gym', revision },
      declared: declaredFor(PATH_A, BODY_A), target: join(root, 'ms', PATH_A),
      signal: new AbortController().signal, archive: { fetch: async () => tarGz(revision, ROWS) },
    }).then(() => null, (reason: Error) => reason)
    expect(String(exhausted)).toContain('POLICY_MIRROR_EXHAUSTED')
  })
})
