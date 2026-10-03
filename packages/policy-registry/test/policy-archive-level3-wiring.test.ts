/**
 * **第 3 级（整仓归档）在产品路径上的接线** —— 判据门（2026-09-27）。
 *
 * 缺口（`bugfixHistory/ARCHIVE-REACHABILITY-AND-MEMO-20260927.md` §1 的实测形态）：唯一的取字节产品入口
 * `policy_download` → `downloadPolicy` → `downloadFile` 的端点链**最多两跳**（raw → 内容接口），
 * 两个端点都传输层失败之后**没有第 3 跳** —— `codeload.github.com` 接触次数 **0**。
 * 本文件把"补上那一跳"的**四条换级判据 + 八条落地判据**逐条钉住：
 *
 *  ① 只有**传输层失败**才换级（校验不符／4xx／状态类一律不换）；② 换的是取字节的方式，不是判据；
 *  ③ 身份不够强（`none`）不走；④ 门①／门②逐件不省；⑤ `archive.root` 给对才有命中（给错当场拒）；
 *  ⑥ 不许编钉（走共享实例那条路，模块默认实例不动）；⑦ 只补在 `downloadPolicy`（不许补进 `downloadFile`）；
 *  ⑧ 取消不换级；⑨ 第 3 级也失败要留痕（`transfers` 记 attempt-failed ＋ 五要素错挂 `cause`）；
 *  ⑩ 换级成功写明 `shape:'archive'`／`servedByEndpoint`；⑪ packs 源不适用；⑫ 读数用 `policyArchiveCacheStats()`。
 *
 * 全部用例**离线**：归档字节由 `tarGz` 现场造，网络是 `globalThis.fetch` 替身，**未登记的 host 一律当场抛**
 * （不是放行）——一次都不打 GitHub。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { downloadFile, downloadPolicy, fetchPolicyFileViaArchive, policyArchiveCacheStats, type PolicySource, type SourceFile } from '../src/source.ts'
import { knownMirrorCandidates, mirrorArchiveCacheStats } from '../src/mirror-search.ts'

const ID = 'unitreerobotics/unitree_rl_gym'
const REPO = 'unitree_rl_gym'
const SPECS = [
  { path: 'policy/params/parameters.pkl', content: Buffer.from('lyapunov-policy-bytes-'.repeat(64)) },
  { path: 'deploy/deploy_mujoco/configs/g1.yaml', content: Buffer.from('num_obs: 47\nnum_actions: 12\n') },
  { path: 'resources/robots/g1_description/g1_12dof.xml', content: Buffer.from('<mujoco/>\n'.repeat(40)) },
]
const gitBlob = (content: Buffer) => createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')

/* ── 造归档：够用的 ustar 写入器（与 mirror-archive-memo.test.ts 同形，独立一份） ───────────── */
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
const tarGz = (root: string, rows: Array<{ path: string; content: Buffer }>) =>
  gzipSync(Buffer.concat([...rows.map(row => tarEntry(`${root}/${row.path}`, row.content)), Buffer.alloc(1024)]))

/* ── 替身 fetch（零出网：未登记 host 当场抛） ─────────────────────────────────────────── */
interface Plan {
  /** 第 1 级（raw）：默认传输层失败。 */
  raw?: 'transport' | '404' | 'wrong-bytes'
  /** 第 2 级（api contents）：默认传输层失败。 */
  contents?: 'transport' | 'rate-limit'
  /** 第 3 级（codeload 归档）：默认喂真 gzip 字节。 */
  archive?: 'serve' | 'transport' | 'impostor'
  /** 清单里那一行的 git blob：默认真值；给 `''` ⇒ 身份强度 `none`（判据③）。 */
  blobSha?: (path: string) => string
  /** 归档里放什么（默认＝真字节；`impostor` 用同名同长不同内容）。 */
  entries?: Array<{ path: string; content: Buffer }>
}

const realFetch = globalThis.fetch
const undo: Array<() => void> = []
afterEach(() => { for (const fn of undo.splice(0)) fn() })
const workdir = () => mkdtempSync(join(tmpdir(), 'level3-wiring-'))

function harness(plan: Plan = {}) {
  // ★ 每个用例一份**自己的** revision ⇒ 归档 URL 与 `archive.root` 都不同 ⇒ 共享缓存不串味。
  const revision = createHash('sha1').update(`${Math.random()}-${Date.now()}-${Math.random()}`).digest('hex')
  const commit = createHash('sha1').update(revision).digest('hex')
  const root = `${REPO}-${commit}` // ＝接线里 `archive.root` 的取值（判据⑤）
  const entries = plan.entries ?? SPECS.map(row => ({ ...row, content: plan.archive === 'impostor' ? Buffer.alloc(row.content.length, 0x58) : row.content }))
  const archive = tarGz(root, entries)
  const contacts: Record<string, number> = {}
  const urls: string[] = []
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  const transport = (host: string): never => { throw new TypeError(`fetch failed: ${host}（用例替身：按传输层失败）`) }
  const stub = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const parsed = new URL(url)
    contacts[parsed.host] = (contacts[parsed.host] ?? 0) + 1
    urls.push(`${parsed.host}${parsed.pathname}${parsed.search}`)
    if (parsed.host === 'raw.githubusercontent.com') {
      if (plan.raw === '404') return new Response('Not Found', { status: 404 })
      if (plan.raw === 'wrong-bytes') {
        const spec = SPECS.find(row => parsed.pathname.endsWith(row.path))
        return new Response(Buffer.alloc(spec?.content.length ?? 64, 0x58), { status: 200 }) // 同长度、不同内容
      }
      return transport(parsed.host)
    }
    if (parsed.host === 'codeload.github.com') {
      if (plan.archive === 'transport') return transport(parsed.host)
      return new Response(archive, { status: 200, headers: { 'content-type': 'application/gzip' } })
    }
    if (parsed.host === 'api.github.com') {
      if (parsed.pathname.includes('/contents/')) {
        if (plan.contents === 'rate-limit') return new Response('rate limited', { status: 429, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) } })
        return transport(parsed.host)
      }
      if (/\/commits\//.test(parsed.pathname)) return json({ sha: commit, commit: { message: 'case' } })
      if (/\/git\/trees\//.test(parsed.pathname)) {
        return json({ truncated: false, tree: SPECS.map(row => ({ type: 'blob', mode: '100644', path: row.path, size: row.content.length, sha: plan.blobSha ? plan.blobSha(row.path) : gitBlob(row.content) })) })
      }
      if (parsed.pathname === `/repos/${ID}`) return json({ full_name: ID, default_branch: 'main' })
      throw new Error(`CASE_UNREGISTERED_API_URL: ${url}`)
    }
    throw new Error(`CASE_UNREGISTERED_HOST: ${parsed.host}（本文件零出网）`)
  }
  ;(globalThis as { fetch: unknown }).fetch = stub
  undo.push(() => { (globalThis as { fetch: unknown }).fetch = realFetch })
  const run = (dataDirectory: string, files: string[], over: { signal?: AbortSignal; provider?: PolicySource } = {}) =>
    downloadPolicy({ dataDirectory, endpoint: '', provider: over.provider ?? 'github', modelId: ID, revision, files, signal: over.signal ?? new AbortController().signal })
  const manifestOf = (dataDirectory: string) => {
    const root = join(dataDirectory, 'policies', 'github', ID.replace('/', '__'), revision)
    return { ...JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')), path: root } as {
      status: string; error?: string; transfers: Array<Record<string, any>>
      files: Array<{ path: string; sha256: string; bytes: number }>; path: string
    }
  }
  return { revision, commit, root, archive, contacts, urls, run, manifestOf, plan }
}

const transferRows = (manifest: { transfers: Array<Record<string, any>> }) => manifest.transfers
type Stats = ReturnType<typeof policyArchiveCacheStats>
/** ★ `policyArchiveCache()` 是**进程唯一**的共享实例 ⇒ 同文件里前面的用例已经动过它，读数只能取增量。 */
const delta = (before: Stats, after: Stats) => ({ downloads: after.downloads - before.downloads, unpacks: after.unpacks - before.unpacks, hits: after.hits - before.hits })

describe('① 只有传输层失败才换级；且换级之后**真的取到了字节**', () => {
  test('★两个端点都传输层失败 ⇒ 第 3 级被走到：codeload 接触 1 次，三件全部落地且逐件 gitBlob 相符', async () => {
    const h = harness()
    const dir = workdir()
    const before = policyArchiveCacheStats(), mirrorBefore = mirrorArchiveCacheStats()
    const manifest = await h.run(dir, SPECS.map(row => row.path))
    expect(manifest.status).toBe('DOWNLOADED')
    expect(h.contacts['codeload.github.com']).toBe(1) // ★改前是 0（负对照见 receipt ④）
    expect(h.contacts['raw.githubusercontent.com']).toBe(3 * SPECS.length)
    expect(h.contacts['api.github.com']).toBe(3 * SPECS.length + 3) // 3 元数据 + 每件 3 次内容接口
    // ⑩ 换级成功必须写明：逐件 shape:'archive' ＋ servedByEndpoint
    const third = transferRows(manifest).filter(row => row.shape === 'archive')
    expect(third.map(row => row.path)).toEqual(SPECS.map(row => row.path))
    for (const row of third) expect(row.servedByEndpoint).toBe('codeload.github.com')
    // 字节真的对（不是"没抛错"）
    for (const spec of SPECS) expect(readFileSync(join(manifest.path, spec.path)).equals(spec.content)).toBe(true)
    // ⑫ 读数从现成导出取（增量：3 件 ⇒ 取字节 1 次、解包 1 次、命中 2 件）
    expect(policyArchiveCacheStats().capacity).toBe(2)
    expect(delta(before, policyArchiveCacheStats())).toEqual({ downloads: 1, unpacks: 1, hits: 2 })
    // ⑥ 没编钉 ⇒ 走共享实例那条路：模块默认实例（有钉那条路）一次都没动
    expect(delta(mirrorBefore, mirrorArchiveCacheStats())).toEqual({ downloads: 0, unpacks: 0, hits: 0 })
  })

  test('② 同进程第 2 次取同一归档（另一个新目录）⇒ 不再取字节、不再解包，codeload 接触不再增加', async () => {
    const h = harness()
    const zero = policyArchiveCacheStats()
    const first = await h.run(workdir(), SPECS.map(row => row.path))
    expect(first.status).toBe('DOWNLOADED')
    const after1 = policyArchiveCacheStats()
    const second = await h.run(workdir(), SPECS.map(row => row.path))
    expect(second.status).toBe('DOWNLOADED')
    const after2 = policyArchiveCacheStats()
    expect(delta(zero, after1)).toEqual({ downloads: 1, unpacks: 1, hits: 2 })
    expect(delta(after1, after2)).toEqual({ downloads: 0, unpacks: 0, hits: 3 }) // ＋3 命中；取字节/解包计数一个都不动
    expect(h.contacts['codeload.github.com']).toBe(1) // 第 3 级一次都没再被接触
    for (const spec of SPECS) expect(readFileSync(join(second.path, spec.path)).equals(spec.content)).toBe(true)
  })

  test('①负例 a：校验不符（字节到过、不是那一批）⇒ 不换级：内容接口与 codeload 接触都是 0', async () => {
    const h = harness({ raw: 'wrong-bytes' })
    const dir = workdir()
    await expect(h.run(dir, [SPECS[0]!.path])).rejects.toThrow('POLICY_FETCH_FAILED')
    expect(h.contacts['codeload.github.com'] ?? 0).toBe(0)
    expect(h.contacts['api.github.com']).toBe(3) // 只有元数据三件；第 2 级一跳都没试
    expect(h.manifestOf(dir).error).toContain('POLICY_SOURCE_CHECKSUM_MISMATCH') // 报文里给的是"哪一批不对"，不是"网络抖动"
  })

  test('①负例 b：第 1 级 4xx ⇒ 不换级（codeload 0）', async () => {
    const h = harness({ raw: '404' })
    const dir = workdir()
    await expect(h.run(dir, [SPECS[0]!.path])).rejects.toThrow(/POLICY_DOWNLOAD_404/)
    expect(h.contacts['codeload.github.com'] ?? 0).toBe(0)
    expect(h.contacts['raw.githubusercontent.com']).toBe(1) // 确定性应答 ⇒ 一次都不重试
  })

  test('①负例 c：状态类（429 限流）⇒ 不换级；而且 429 只打 1 次（不烧 3 倍配额）', async () => {
    const h = harness({ contents: 'rate-limit' })
    const dir = workdir()
    await expect(h.run(dir, [SPECS[0]!.path])).rejects.toThrow(/POLICY_DOWNLOAD|GITHUB|限流|配额/i)
    expect(h.contacts['codeload.github.com'] ?? 0).toBe(0)
    expect(h.contacts['api.github.com']).toBe(4) // 3 元数据 + contents **1 次**
    expect(h.manifestOf(dir).error).toMatch(/限流|配额|rate/i)
  })

  test('③ 身份强度 none（清单里那一行没有可用的 gitBlob）⇒ 不换级', async () => {
    const h = harness({ blobSha: () => '' })
    const dir = workdir()
    await expect(h.run(dir, [SPECS[0]!.path])).rejects.toThrow('POLICY_FETCH_FAILED')
    expect(h.contacts['codeload.github.com'] ?? 0).toBe(0) // 没有判据 ⇒ 不去搜，也不降级成"随便取"
  })
})

describe('④ 门①／门②逐件不省；⑤ `archive.root` 给对才有命中，给错当场拒', () => {
  test('④ 归档里那条条目**名字对上了、内容不是**⇒ 逐件拒（门①）且不把坏字节留在盘上', async () => {
    const h = harness({ archive: 'impostor' })
    const dir = workdir()
    await expect(h.run(dir, SPECS.map(row => row.path))).rejects.toThrow('POLICY_MIRROR_EXHAUSTED')
    const manifest = h.manifestOf(dir)
    expect(manifest.status).toBe('FAILED')
    for (const spec of SPECS) expect(existsSync(join(manifest.path, spec.path))).toBe(false)
    expect(readdirSync(manifest.path).filter(name => name.endsWith('.part'))).toEqual([]) // 门① 连 .part 都不留
    expect(String(manifest.error)).toContain('POLICY_MIRROR_ARCHIVE_IDENTITY_MISMATCH')
  })

  test('⑤ root 给对 ⇒ 命中；给错 ⇒ 当场拒（不会静默取错字节）', async () => {
    const h = harness()
    const target = join(workdir(), SPECS[0]!.path)
    const declared = { identity: { path: SPECS[0]!.path, bytes: SPECS[0]!.content.length, gitBlob: gitBlob(SPECS[0]!.content) }, provenance: 'source-snapshot' as const, note: '用例' }
    await expect(fetchPolicyFileViaArchive({
      coordinates: { provider: 'github', modelId: ID, revision: h.revision }, declared, target,
      signal: new AbortController().signal, archive: { root: 'not-the-repo-name-' + h.commit },
    })).rejects.toThrow('POLICY_MIRROR_ARCHIVE_TARGET_MISSING')
  })
})

describe('⑦ 只补在 `downloadPolicy`：`downloadFile` 仍是两跳链（否则第 3 级会递归回第 1 级）', () => {
  test('动态：直接调 `downloadFile`，两个端点都失败 ⇒ 只有 raw/api 两个 host，codeload 接触 0', async () => {
    const h = harness()
    const file: SourceFile = {
      path: SPECS[0]!.path, bytes: SPECS[0]!.content.length, revision: h.commit, gitBlob: gitBlob(SPECS[0]!.content),
      url: `https://raw.githubusercontent.com/${ID}/${h.commit}/${SPECS[0]!.path}`,
      fallbackUrl: `https://api.github.com/repos/${ID}/contents/${SPECS[0]!.path}?ref=${h.commit}`,
    }
    await expect(downloadFile(file, join(workdir(), SPECS[0]!.path), new AbortController().signal)).rejects.toThrow('POLICY_FETCH_FAILED')
    expect(h.contacts['raw.githubusercontent.com']).toBe(3)
    expect(h.contacts['api.github.com']).toBe(3)
    expect(h.contacts['codeload.github.com'] ?? 0).toBe(0)
  })

  test('静态（机器守卫）：`fetchPolicyFileViaArchive` 全文件恰好一个调用点，且落在 `downloadPolicy` 里', () => {
    const source = readFileSync(new URL('../src/source.ts', import.meta.url), 'utf8')
    const lines = source.split('\n')
    const at = (needle: string) => lines.findIndex(line => line.includes(needle))
    const downloadPolicy = at('export async function downloadPolicy(')
    const definition = at('export async function fetchPolicyFileViaArchive(')
    const downloadFile = at('export async function downloadFile(')
    const wiring = lines.map((line, index) => ({ line, index })).filter(row => row.line.includes('await fetchPolicyFileViaArchive({'))
    expect(downloadPolicy).toBeGreaterThan(0)
    expect(definition).toBeGreaterThan(downloadPolicy)
    expect(downloadFile).toBeGreaterThan(0)
    expect(wiring.length).toBe(1) // ★只有一个调用点
    expect(wiring[0]!.index).toBeGreaterThan(downloadPolicy) // ……且在 downloadPolicy 里
    expect(wiring[0]!.index).toBeLessThan(definition)
    // `downloadFile` / `downloadFileOnce` 的函数体里一处都没有（补在那里会递归）
    const body = lines.slice(downloadFile, downloadPolicy).join('\n')
    expect(body.includes('fetchPolicyFileViaArchive')).toBe(false)
    // 四条换级判据都在接线处（防"悄悄放宽"）：不放宽 ⇒ 这四个锚点必须都在
    const region = lines.slice(wiring[0]!.index - 40, wiring[0]!.index + 40).join('\n')
    for (const anchor of ['input.signal.aborted', "provider !== 'github'", "identityStrength(file) === 'none'", 'endpointFallbackAllowed(error)']) {
      expect(region.includes(anchor)).toBe(true)
    }
  })
})

describe('⑧ 取消不换级；⑨ 第 3 级也失败要留痕；⑪ packs 不适用', () => {
  test('⑧ 取消（signal 已 aborted）⇒ 原样抛、codeload 接触 0', async () => {
    const h = harness()
    const controller = new AbortController()
    controller.abort(new Error('CASE_CANCELLED'))
    await expect(h.run(workdir(), SPECS.map(row => row.path), { signal: controller.signal })).rejects.toThrow('CASE_CANCELLED')
    expect(h.contacts['codeload.github.com'] ?? 0).toBe(0)
    expect(h.contacts['raw.githubusercontent.com'] ?? 0).toBe(0)
  })

  test('⑨ 第 3 级也传输层失败 ⇒ transfers 两条 attempt-failed ＋ 抛出的错带 cause（第 1/2 级的五要素）', async () => {
    const h = harness({ archive: 'transport' })
    const dir = workdir()
    const before = policyArchiveCacheStats()
    let thrown: any
    try { await h.run(dir, [SPECS[0]!.path]) } catch (error) { thrown = error }
    expect(String(thrown?.message)).toContain('POLICY_MIRROR_EXHAUSTED')
    expect(h.contacts['codeload.github.com']).toBe(3) // 第 3 级自己那 3 次尝试（有界重试）
    // 五要素错挂 cause
    expect(thrown?.cause?.name).toBe('PolicyFetchError')
    expect(String(thrown.cause.message)).toContain('POLICY_FETCH_FAILED')
    // 五要素里的 URL 是**最后一跳**（内容接口）那条；raw 的失败在同一份 manifest 的 attempts 里可见
    expect(String(thrown.cause.message)).toMatch(/raw\.githubusercontent\.com|api\.github\.com/)
    expect(thrown.cause.attempts.length).toBeGreaterThan(0)
    expect(thrown.cause.retryable).toBe(true) // 传输层失败 ⇒ 换级判据为真
    const manifest = h.manifestOf(dir)
    expect(manifest.status).toBe('FAILED')
    expect(manifest.error).toContain('POLICY_MIRROR_EXHAUSTED')
    const failed = manifest.transfers.filter(row => row.kind === 'attempt-failed')
    expect(failed.some(row => row.path === SPECS[0]!.path && String(row.nextHop).includes('第 3 级'))).toBe(true)
    expect(failed.some(row => row.path === SPECS[0]!.path && row.endpoint === 'codeload.github.com')).toBe(true)
    expect(failed.some(row => row.endpoint === 'raw.githubusercontent.com')).toBe(true)
    // 失败不进缓存（一次瞬时故障不该变成"这个 URL 永久不可用"）
    expect(delta(before, policyArchiveCacheStats())).toEqual({ downloads: 0, unpacks: 0, hits: 0 })
    // ★ 更强的一条：同一个 URL 立刻再来一次、这次归档能取到 ⇒ 必须**真的再取一次字节、再解一次包**
    //   （若上次的失败被记住，这里会是 0/0 的命中）
    h.plan.archive = 'serve'
    const retryBefore = policyArchiveCacheStats()
    const ok = await h.run(workdir(), [SPECS[0]!.path])
    expect(ok.status).toBe('DOWNLOADED')
    expect(delta(retryBefore, policyArchiveCacheStats())).toEqual({ downloads: 1, unpacks: 1, hits: 0 })
  })

  test('⑪ packs 源：连取件都不开始（`PACK_PUBLIC_FALLBACK_FORBIDDEN`），codeload 接触 0', async () => {
    const h = harness()
    await expect(h.run(workdir(), SPECS.map(row => row.path), { provider: 'packs' })).rejects.toThrow('PACK_PUBLIC_FALLBACK_FORBIDDEN')
    expect(h.contacts['codeload.github.com'] ?? 0).toBe(0)
    // 而且第 3 级自己也不会给 packs 开后门（能力包字节只经 pack 端点）
    expect(() => knownMirrorCandidates({ provider: 'packs', modelId: ID, revision: h.revision }, { identity: { path: SPECS[0]!.path, bytes: 1, gitBlob: gitBlob(Buffer.from('x')) }, provenance: 'source-snapshot', note: '用例' })).toThrow('POLICY_MIRROR_PACKS_FORBIDDEN')
  })
})
