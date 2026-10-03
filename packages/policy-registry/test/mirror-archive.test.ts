/**
 * 第 3 级的**整仓归档**形态（U1，`codeload.github.com/{id}/tar.gz/{sha}`）的门。
 *
 * 归档是 T0 里唯一**零 API 配额、零凭据、且换了一整族主机**的通道（配额正是 P13/G1 那格的卡点），
 * 所以它的价值最高；也正因为它换了一整族主机、拿回来的是**一整包别人打包好的字节**，
 * 这一族用例要钉的是同一句话：
 *
 *   > **只能换 URL，不能换判据。** 归档里那条"名字对上了"的条目，必须与可信声明**逐字**相符才许落地。
 *
 * 四组判据：
 *  G. **解析即校验**：路径穿越（含 PAX 路径覆盖）／软链与硬链／权限位／截断／坏校验和；
 *  H. **命中是逐字的**：有顶层目录与无顶层目录两种形态、歧义即拒、缺条目即拒、非普通文件即拒；
 *  I. **取件与两块门**：端到端成功、★同长不同内容必须被拒且坏字节不落地、逐跳主机纪律、上限（gzip 炸弹）；
 *  J. **纪律面**：归档候选默认不启用、`mirrorSourceFile` 依旧拒归档、搜索发现的第三方归档仍然拒。
 *
 * 全部用例**离线**：字节由 `gzipSync` 现场造，网络走 `globalThis.fetch` 替身或 `archive.fetch` 接缝，
 * **一次都不打 GitHub、不打任何真网络**（匿名配额 60/h 已打满过一次）。
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  acceptDiscoveredCandidate, fetchFromMirrors, knownMirrorCandidates, locateArchiveEntry, mirrorSourceFile,
  parseTarEntries, safeArchiveEntryPath, unpackMirrorArchive, type DeclaredIdentity, type MirrorCandidate,
} from '../src/mirror-search.ts'

const REPO = 'unitreerobotics/unitree_rl_gym'
const COMMIT = 'b'.repeat(40)
const PATH = 'policy/params/parameters.pkl'
/** 声明字节（内容由本文件造，不来自网络）。 */
const BYTES = Buffer.from('lyapunov-policy-bytes-'.repeat(64))
const GIT_BLOB = createHash('sha1').update(`blob ${BYTES.length}\0`).update(BYTES).digest('hex')
const SHA256 = createHash('sha256').update(BYTES).digest('hex')
/** 同长度、不同内容的"顶包"字节：`bytes` 声明完全一致，摘要必不同。 */
const IMPOSTOR = Buffer.from(BYTES.toString('latin1').replace(/^l/, 'L'))
const COORDS = { provider: 'github' as const, modelId: REPO, revision: COMMIT }
/** GitHub codeload 的顶层目录形态：`{repo}-{sha}/`。 */
const ROOT = `unitree_rl_gym-${COMMIT}`

const declaredGit = (over: Partial<DeclaredIdentity['identity']> = {}): DeclaredIdentity => ({
  identity: { path: PATH, bytes: BYTES.length, gitBlob: GIT_BLOB, ...over },
  provenance: 'source-snapshot',
  note: 'sourceSnapshot 的 github tree（本用例自造，与网络无关）',
})

/* ── 造归档：一个够用的 ustar 写入器（只写本族用例要的那几个字段，不引第三方 tar 库） ───────────── */
interface Spec { name: string; content?: Buffer | string; type?: string; mode?: number; linkname?: string; prefix?: string }
const BLOCK = 512
function tarEntry(spec: Spec): Buffer {
  const content = spec.content === undefined ? Buffer.alloc(0) : Buffer.isBuffer(spec.content) ? spec.content : Buffer.from(spec.content)
  const typeflag = spec.type ?? '0'
  const header = Buffer.alloc(BLOCK)
  header.write(spec.name.slice(0, 100), 0, 100, 'latin1')
  header.write((spec.mode ?? 0o644).toString(8).padStart(7, '0') + '\0', 100, 8, 'latin1')
  header.write('0000000\0', 108, 8, 'latin1')
  header.write('0000000\0', 116, 8, 'latin1')
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'latin1')
  header.write('00000000000\0', 136, 12, 'latin1')
  header.write('        ', 148, 8, 'latin1')
  header.write(typeflag, 156, 1, 'latin1')
  header.write((spec.linkname ?? '').slice(0, 100), 157, 100, 'latin1')
  header.write('ustar\0', 257, 6, 'latin1')
  header.write('00', 263, 2, 'latin1')
  header.write('lyapunov', 265, 32, 'latin1')
  header.write('lyapunov', 297, 32, 'latin1')
  header.write('0000000\0', 329, 8, 'latin1')
  header.write('0000000\0', 337, 8, 'latin1')
  header.write((spec.prefix ?? '').slice(0, 155), 345, 155, 'latin1')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1')
  if (typeflag === '1' || typeflag === '2' || typeflag === '5') return header // 链接与目录没有正文
  const padded = Buffer.alloc(Math.ceil(content.length / BLOCK) * BLOCK)
  content.copy(padded)
  return Buffer.concat([header, padded])
}
/** 条目名超过 100 字节时 `git archive` 走 PAX 记录；这里按同一格式造（长度前缀是**整条记录**的字节数）。 */
const paxEntry = (records: Record<string, string>): Spec => {
  let payload = ''
  for (const [key, value] of Object.entries(records)) {
    const body = `${key}=${value}\n`
    let size = body.length + 2
    for (;;) { const candidate = String(size).length + 1 + body.length; if (candidate === size) break; size = candidate }
    payload += `${size} ${body}`
  }
  return { name: 'PaxHeaders/entry', content: Buffer.from(payload, 'utf8'), type: 'x' }
}
const makeTar = (specs: Spec[]) => Buffer.concat([...specs.map(tarEntry), Buffer.alloc(1024)])
const tarGz = (specs: Spec[]) => gzipSync(makeTar(specs))
/** 最常用的一份：顶层目录 + 目标文件（内容＝声明字节）。 */
const goodArchive = (content: Buffer = BYTES) => tarGz([{ name: `${ROOT}/Readme.md`, content: 'readme' }, { name: `${ROOT}/${PATH}`, content }])
const codeload = (): MirrorCandidate => knownMirrorCandidates(COORDS, declaredGit()).find(row => row.host === 'codeload.github.com')!
const workdir = () => mkdtempSync(join(tmpdir(), 'mirror-archive-'))

interface Call { url: string; headers: Record<string, string> }
function stubFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [], original = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init: any = {}) => {
    const call: Call = { url: String(input), headers: { ...(init?.headers ?? {}) } }
    calls.push(call)
    return handler(call)
  }) as unknown as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}
const gzResponse = (body: Buffer, status = 200) => new Response(body, { status, headers: { 'content-length': String(body.length) } })

describe('G. 解析即校验：归档不是可信输入', () => {
  test('路径穿越条目（`..`）⇒ 整份归档丢弃；且逃逸目标一个字节都没被创建', async () => {
    const root = workdir(), target = join(root, 'nested/parameters.pkl'), escape = join(root, '..', `escape-${process.pid}.pkl`)
    const hostile = makeTar([{ name: `${ROOT}/${PATH}` , content: BYTES }, { name: `${ROOT}/../../../${escape}`, content: 'owned' }])
    // 解析器当场拒（不是"解析完了再检查"——没有那个窗口）。
    let parseMessage = ''
    try { parseTarEntries(hostile) } catch (error) { parseMessage = String((error as Error).message) }
    // 端到端：整份归档被丢弃，命中那条好条目也**不**例外（恶意归档没有"跳过它继续用"的余地）。
    // 读数与断言**分开**收：负对照打掉这道闸时要能同时答出两件事——归档有没有被丢、逃逸有没有发生。
    const message = await unpackMirrorArchive({ declared: declaredGit(), candidate: codeload(), target, signal: new AbortController().signal, options: { fetch: async () => gzipSync(hostile) } })
      .then(() => '（没抛 ⇒ 这份归档被当成正常的用了）', (error: Error) => String(error.message))
    expect(existsSync(escape)).toBe(false)   // 逃逸目标：结构上就不可能生成（只物化命中的那**一条**条目）
    expect(existsSync(target)).toBe(false)   // 恶意归档整份丢弃 ⇒ 连那条好条目也不落地
    expect(parseMessage).toMatch(/POLICY_MIRROR_ARCHIVE_UNSAFE_PATH/)
    expect(message).toMatch(/POLICY_MIRROR_ARCHIVE_UNSAFE_PATH/)
  })

  test('静态闸逐条：绝对路径／反斜杠／空段／点段／双点段／NUL；干净的相对路径放行', () => {
    expect(safeArchiveEntryPath('a/b/c.pkl')).toBe('a/b/c.pkl')
    expect(() => safeArchiveEntryPath('/etc/passwd')).toThrow(/POLICY_MIRROR_ARCHIVE_UNSAFE_PATH/)
    expect(() => safeArchiveEntryPath('..\\windows\\x')).toThrow(/POLICY_MIRROR_ARCHIVE_UNSAFE_PATH/)
    expect(() => safeArchiveEntryPath('a//b')).toThrow(/POLICY_MIRROR_ARCHIVE_UNSAFE_PATH/)
    expect(() => safeArchiveEntryPath('./a')).toThrow(/POLICY_MIRROR_ARCHIVE_UNSAFE_PATH/)
    expect(() => safeArchiveEntryPath('a/../b')).toThrow(/POLICY_MIRROR_ARCHIVE_UNSAFE_PATH/)
    expect(() => safeArchiveEntryPath('')).toThrow(/POLICY_MIRROR_ARCHIVE_UNSAFE_PATH/)
    expect(() => safeArchiveEntryPath('a\0b')).toThrow(/POLICY_MIRROR_ARCHIVE_UNSAFE_PATH/)
  })

  test('PAX 路径覆盖也过同一道闸：超长路径认得、带 `..` 的照样拒', () => {
    const longPath = `${'deep/'.repeat(20)}parameters.pkl`
    const entries = parseTarEntries(makeTar([paxEntry({ path: `${ROOT}/${longPath}` }), { name: `${ROOT}/truncated-name`, content: BYTES }]))
    expect(entries.map(entry => entry.path)).toEqual([`${ROOT}/${longPath}`])
    expect(() => parseTarEntries(makeTar([paxEntry({ path: `../../etc/passwd` }), { name: `${ROOT}/x`, content: 'x' }]))).toThrow(/POLICY_MIRROR_ARCHIVE_UNSAFE_PATH/)
    // PAX 的 size 覆盖不认（按头部大小读会把后面的条目读歪）⇒ fail-closed。
    expect(() => parseTarEntries(makeTar([paxEntry({ size: String(BYTES.length + 1) }), { name: `${ROOT}/x`, content: BYTES }]))).toThrow(/POLICY_MIRROR_ARCHIVE_MALFORMED/)
  })

  test('软链**不跟随、不物化**：落在目标坐标上的软链被拒，落别处的软链只记账', () => {
    const symlinkAtTarget = makeTar([{ name: `${ROOT}/${PATH}`, type: '2', linkname: '/etc/passwd' }])
    expect(() => parseTarEntries(symlinkAtTarget)).not.toThrow() // 解析能过：链接条目本身没被拒绝
    const entries = parseTarEntries(symlinkAtTarget)
    expect(entries.filter(entry => entry.type === 'symlink').length).toBe(1)
    expect(() => locateArchiveEntry(entries, PATH)).toThrow(/POLICY_MIRROR_ARCHIVE_TARGET_NOT_REGULAR/)
  })

  test('硬链同软链一档：不跟随、不物化', () => {
    const entries = parseTarEntries(makeTar([{ name: `${ROOT}/${PATH}`, type: '1', linkname: `${ROOT}/other.pkl` }]))
    expect(() => locateArchiveEntry(entries, PATH)).toThrow(/POLICY_MIRROR_ARCHIVE_TARGET_NOT_REGULAR/)
  })

  test('截断的归档 ⇒ TRUNCATED；坏头部校验和 ⇒ MALFORMED（都不静默当成"没有这个文件"）', () => {
    const full = makeTar([{ name: `${ROOT}/${PATH}`, content: BYTES }])
    expect(() => parseTarEntries(full.subarray(0, full.length - 1024))).toThrow(/POLICY_MIRROR_ARCHIVE_TRUNCATED/)
    expect(() => parseTarEntries(full.subarray(0, BLOCK))).toThrow(/POLICY_MIRROR_ARCHIVE_TRUNCATED/)
    const corrupted = Buffer.from(full)
    corrupted[0] = 'X'.charCodeAt(0) // 改条目名 ⇒ 头部校验和对不上
    expect(() => parseTarEntries(corrupted)).toThrow(/POLICY_MIRROR_ARCHIVE_MALFORMED/)
  })
})

describe('H. 命中是逐字的：不归一化、不猜', () => {
  const entriesOf = (specs: Spec[]) => parseTarEntries(makeTar(specs))
  test('两种归档形态：有唯一顶层目录（codeload）与无顶层目录（某些镜像自打包）', () => {
    expect(locateArchiveEntry(entriesOf([{ name: `${ROOT}/${PATH}`, content: BYTES }]), PATH)).toEqual({ entry: expect.anything(), root: ROOT })
    expect(locateArchiveEntry(entriesOf([{ name: PATH, content: BYTES }]), PATH).root).toBe('')
    // 只有一条条目时也能定顶层目录（目录条目以 `/` 结尾，去掉尾斜杠再校）。
    expect(locateArchiveEntry(entriesOf([{ name: `${ROOT}/`, type: '5' }, { name: `${ROOT}/${PATH}`, content: BYTES }]), PATH).root).toBe(ROOT)
  })

  test('缺条目 ⇒ TARGET_MISSING（报文里带条目数与顶层目录，便于回答"这个归档里到底有什么"）', () => {
    let message = ''
    try { locateArchiveEntry(entriesOf([{ name: `${ROOT}/other.pkl`, content: 'x' }]), PATH) } catch (error) { message = String((error as Error).message) }
    expect(message).toMatch(/POLICY_MIRROR_ARCHIVE_TARGET_MISSING/)
    expect(message).toMatch(/归档条目 1 条/)
    expect(message).toMatch(new RegExp(ROOT))
  })

  test('两种拼法同时命中 ⇒ 歧义即拒（不猜哪个"更像"）；调用方钉死 root 时只认那一个', () => {
    const both = entriesOf([{ name: `${ROOT}/${PATH}`, content: BYTES }, { name: PATH, content: BYTES }])
    expect(() => locateArchiveEntry(both, PATH)).toThrow(/POLICY_MIRROR_ARCHIVE_TARGET_AMBIGUOUS/)
    expect(locateArchiveEntry(both, PATH, ROOT).root).toBe(ROOT)
    expect(() => locateArchiveEntry(both, PATH, 'other-root')).toThrow(/POLICY_MIRROR_ARCHIVE_TARGET_MISSING/)
    expect(() => locateArchiveEntry(both, PATH, '../escape')).toThrow(/POLICY_MIRROR_ARCHIVE_UNSAFE_PATH/)
  })

  test('"文件名一样"不构成命中：路径不同就是不命中（后缀/改名匹配一律没有）', () => {
    const renamed = entriesOf([{ name: `${ROOT}/params/parameters.pkl`, content: BYTES }, { name: `${ROOT}/policy/parameters.pkl`, content: BYTES }])
    expect(() => locateArchiveEntry(renamed, PATH)).toThrow(/POLICY_MIRROR_ARCHIVE_TARGET_MISSING/)
  })
})

describe('I. 取件与两块门：解包出来的字节仍然要过指纹', () => {
  test('端到端：blob 那条 404 + codeload 归档给出声明字节 ⇒ 成功，且"字节由归档提供"逐字留痕', async () => {
    const root = workdir(), target = join(root, 'nested/parameters.pkl')
    const stub = stubFetch(call => call.url.startsWith('https://github.com/') ? new Response('nope', { status: 404, headers: { 'content-length': '4' } }) : gzResponse(goodArchive()))
    try {
      const result = await fetchFromMirrors({
        declared: declaredGit(), coordinates: COORDS, target, signal: new AbortController().signal,
        candidates: knownMirrorCandidates(COORDS, declaredGit()), includeArchive: true,
      })
      expect(result.servedBy.host).toBe('codeload.github.com')
      expect(result.servedBy.shape).toBe('archive')
      expect(result.reading.gitBlob).toBe(GIT_BLOB)
      expect(readFileSync(target).equals(BYTES)).toBe(true)
      // 失败的那一条也留痕；归档那条说明它是**从归档里解出来的**，不是"下到了整包就完事"。
      expect(result.attempts.map(row => `${row.host}:${row.outcome}`)).toEqual(['github.com:rejected', 'codeload.github.com:served'])
      expect(result.attempts[1]!.reason).toMatch(/字节身份通过/)
      // 归档这一层的读数（压了多少／解出多少／几条条目）随读数一起走。
      const archive = (result.reading as { archive?: { entries: number; compressedBytes: number; uncompressedBytes: number; root: string } }).archive
      expect(archive?.entries).toBe(2)
      expect(archive?.root).toBe(ROOT)
      expect(archive!.compressedBytes).toBeGreaterThan(0)
      expect(archive!.uncompressedBytes).toBeGreaterThanOrEqual(1024)
    } finally { stub.restore() }
  })

  test('★核心负对照：归档里那条**同长度不同内容**的条目 ⇒ 丢弃该候选，坏字节不落地', async () => {
    const root = workdir(), target = join(root, 'parameters.pkl')
    const failure = fetchFromMirrors({
      declared: declaredGit(), coordinates: COORDS, target, signal: new AbortController().signal,
      candidates: [codeload()], includeArchive: true, archive: { fetch: async () => goodArchive(IMPOSTOR) },
    })
    const message = await failure.then(() => '（没抛 ⇒ 顶包被当成目标文件收下了）', (error: Error) => String(error.message))
    // **先答"坏字节有没有落地"**（这两条是门①的存在理由：它是**写盘之前**那一关）——
    // 负对照打掉门①时，先炸的就是这一条，读数会是"Expected: false, Received: true"：
    // 门②照旧把候选判死，但盘上**已经**有一份顶包了。
    expect(existsSync(target)).toBe(false)
    expect(existsSync(target + '.part')).toBe(false)
    expect(message).toMatch(/POLICY_MIRROR_EXHAUSTED/)
    expect(message).toMatch(/POLICY_MIRROR_ARCHIVE_IDENTITY_MISMATCH/)
    expect(message).toMatch(/gitBlob 不符/)
  })

  test('sha256 口径的声明走同一道门（内容寻址不因形态而分叉）', async () => {
    const root = workdir(), target = join(root, 'parameters.pkl')
    const declared: DeclaredIdentity = { identity: { path: PATH, bytes: BYTES.length, sha256: SHA256 }, provenance: 'local-manifest', note: '上一次核对通过的 manifest.sourceFiles[]' }
    const ok = await unpackMirrorArchive({ declared, candidate: codeload(), target, signal: new AbortController().signal, options: { fetch: async () => goodArchive() } })
    expect(ok.sha256).toBe(SHA256)
    expect(ok.bytes).toBe(BYTES.length)
    // 顶包：长度一样、sha256 不一样 ⇒ 当场拒。
    const bad = unpackMirrorArchive({ declared, candidate: codeload(), target: join(root, 'bad.pkl'), signal: new AbortController().signal, options: { fetch: async () => goodArchive(IMPOSTOR) } })
    await expect(bad).rejects.toThrow(/POLICY_MIRROR_ARCHIVE_IDENTITY_MISMATCH: .*sha256 不符/)
  })

  test('取归档字节不带任何凭据；逐跳重过主机纪律（302 到官方 HF / 内网 / 明文 http 一律拒）', async () => {
    const target = join(workdir(), 'parameters.pkl')
    const stub = stubFetch(() => gzResponse(goodArchive()))
    try {
      await unpackMirrorArchive({ declared: declaredGit(), candidate: codeload(), target, signal: new AbortController().signal })
      expect(stub.calls.length).toBe(1)
      expect(stub.calls[0]!.url).toBe(`https://codeload.github.com/${REPO}/tar.gz/${COMMIT}`)
      // P18：凭据只发 api.github.com。codeload 这一跳连 Accept 都不该有，更不该有授权头。
      const keys = Object.keys(stub.calls[0]!.headers).map(key => key.toLowerCase())
      expect(keys).toEqual(['user-agent'])
      expect(JSON.stringify(stub.calls[0]!.headers)).not.toMatch(/ghp_|Bearer |authorization|token=/i)
    } finally { stub.restore() }
  })

  test('重定向逐跳校验：跳到官方 HF／IP 字面量／http ⇒ 拒（"镜像把我们 302 走"这条路是堵死的）', async () => {
    const target = join(workdir(), 'parameters.pkl')
    for (const location of ['https://huggingface.co/x/tar.gz', 'https://127.0.0.1/x.tar.gz', 'http://mirror.example.test/x.tar.gz']) {
      const stub = stubFetch(() => new Response(null, { status: 302, headers: { location } }))
      try {
        const failure = unpackMirrorArchive({ declared: declaredGit(), candidate: codeload(), target, signal: new AbortController().signal })
        await expect(failure).rejects.toThrow(/POLICY_MIRROR_(OFFICIAL_HF_FORBIDDEN|URL_IP_LITERAL_FORBIDDEN|URL_MUST_BE_HTTPS)/)
        expect(existsSync(target)).toBe(false)
      } finally { stub.restore() }
    }
  })

  test('归档端点本身的 5xx／404 ⇒ 拒绝该候选（报文带状态），不重试成别的判据', async () => {
    const target = join(workdir(), 'parameters.pkl')
    const stub = stubFetch(() => new Response('boom', { status: 404, headers: { 'content-length': '4' } }))
    try {
      await expect(unpackMirrorArchive({ declared: declaredGit(), candidate: codeload(), target, signal: new AbortController().signal })).rejects.toThrow(/POLICY_MIRROR_ARCHIVE_404/)
    } finally { stub.restore() }
  })

  test('上限：压缩字节与解压字节各有硬卡（gzip 炸弹在解压时就炸不出来）', async () => {
    const target = join(workdir(), 'parameters.pkl')
    const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024, 7)) // 4 MiB 的零字节，压完只有几 KB
    await expect(unpackMirrorArchive({ declared: declaredGit(), candidate: codeload(), target, signal: new AbortController().signal, options: { fetch: async () => bomb, maxUncompressedBytes: 64 * 1024 } }))
      .rejects.toThrow(/POLICY_MIRROR_ARCHIVE_OVERSIZED/)
    await expect(unpackMirrorArchive({ declared: declaredGit(), candidate: codeload(), target, signal: new AbortController().signal, options: { fetch: async () => goodArchive(), maxBytes: 8 } }))
      .rejects.toThrow(/POLICY_MIRROR_ARCHIVE_OVERSIZED/)
    await expect(unpackMirrorArchive({ declared: declaredGit(), candidate: codeload(), target, signal: new AbortController().signal, options: { fetch: async () => Buffer.from('not a gzip at all') } }))
      .rejects.toThrow(/POLICY_MIRROR_ARCHIVE_UNREADABLE/)
    expect(existsSync(target)).toBe(false)
  })

  test('权限位不来自归档：条目写 4755（setuid+可执行）落地仍是 0600，只把 mode 记账下来', async () => {
    const root = workdir(), target = join(root, 'parameters.pkl')
    const reading = await unpackMirrorArchive({
      declared: declaredGit(), candidate: codeload(), target, signal: new AbortController().signal,
      options: { fetch: async () => tarGz([{ name: `${ROOT}/${PATH}`, content: BYTES, mode: 0o4755 }]) },
    })
    expect(reading.entry.mode).toBe(0o4755) // 记账：归档里确实写着 4755
    const mode = statSync(target).mode & 0o7777
    expect(mode & 0o777).toBe(0o600)   // 落地权限
    expect(mode & 0o111).toBe(0)       // 没有可执行位
    expect(mode & 0o4000).toBe(0)      // 没有 setuid
    expect(mode & 0o2000).toBe(0)      // 没有 setgid
  })

  test('"整树物化才有的洞"结构上没有：软链指向目录 + 真文件在同名下 ⇒ 仍然服务，且一个字节都没写到软链那一侧', async () => {
    const root = workdir(), outside = join(root, 'outside'), target = join(root, 'tree', 'policy/params/parameters.pkl')
    mkdirSync(outside, { recursive: true })
    const archive = tarGz([
      { name: `${ROOT}/policy`, type: '2', linkname: outside },
      { name: `${ROOT}/${PATH}`, content: BYTES },
    ])
    const reading = await unpackMirrorArchive({ declared: declaredGit(), candidate: codeload(), target, signal: new AbortController().signal, options: { fetch: async () => archive } })
    expect(readFileSync(target).equals(BYTES)).toBe(true)
    // 目标文件在**本次运行的目录**里（不是顺着软链写到了 outside）。
    expect(realpathSync(dirname(target)).startsWith(realpathSync(root))).toBe(true)
    expect(existsSync(join(outside, 'params'))).toBe(false)
    // 软链被跳过并记账（U10 的"软链未处理"在这里有了明确处置：**不物化**）。
    expect(reading.archive.skipped).toEqual([{ path: `${ROOT}/policy`, type: 'symlink' }])
  })
})

describe('J. 纪律面：归档是显式开关，且只对同一发行方开', () => {
  test('归档候选默认不启用：不给 includeArchive ⇒ 一条候选都不试（不是"试了才发现不支持"）', async () => {
    const target = join(workdir(), 'parameters.pkl')
    let message = ''
    try {
      await fetchFromMirrors({ declared: declaredGit(), coordinates: COORDS, target, signal: new AbortController().signal, candidates: [codeload()], archive: { fetch: async () => goodArchive() } })
    } catch (error) { message = String((error as Error).message) }
    expect(message).toMatch(/POLICY_MIRROR_EXHAUSTED/)
    expect(message).toMatch(/（无候选）/)
    expect(existsSync(target)).toBe(false)
  })

  test('`mirrorSourceFile` 依旧拒归档形态（那条路径是单文件下载器的，归档的字节不是目标文件的字节）', () => {
    expect(() => mirrorSourceFile(declaredGit(), codeload(), COMMIT)).toThrow(/POLICY_MIRROR_ARCHIVE_UNSUPPORTED/)
  })

  test('搜索发现的**第三方归档**仍然拒：解包器只对同一发行方开（多一份来路不明的 tar ＝ 多一整个解析攻击面）', () => {
    expect(() => acceptDiscoveredCandidate({ url: 'https://mirror.example.test/x.tar.gz', admittedBy: 'l3', declared: declaredGit(), shape: 'archive' }))
      .toThrow(/POLICY_MIRROR_DISCOVERED_ARCHIVE_REFUSED/)
    expect(acceptDiscoveredCandidate({ url: 'https://mirror.example.test/x', admittedBy: 'l3', declared: declaredGit() }).shape).toBe('blob')
  })

  test('形态门：把 blob 候选交到解包器上 ⇒ 当场拒（取字节的路径不许走错）', async () => {
    const blob = knownMirrorCandidates(COORDS, declaredGit()).find(row => row.shape === 'blob')!
    await expect(unpackMirrorArchive({ declared: declaredGit(), candidate: blob, target: join(workdir(), 'p.pkl'), signal: new AbortController().signal, options: { fetch: async () => goodArchive() } }))
      .rejects.toThrow(/POLICY_MIRROR_ARCHIVE_SHAPE_REQUIRED/)
  })

  test('归档那条候选失败后继续下一条：配置镜像仍然接管（不因为归档坏了就整条链断掉）', async () => {
    const root = workdir(), target = join(root, 'parameters.pkl')
    const configured = knownMirrorCandidates(COORDS, declaredGit(), { configured: [{ template: 'https://mirror.example.test/gh/{id}/{revision}/{path}', label: 'test:mirror' }] })
    const stub = stubFetch(call => call.url.startsWith('https://mirror.example.test/') ? gzResponse(BYTES) : gzResponse(goodArchive(IMPOSTOR)))
    try {
      const result = await fetchFromMirrors({
        declared: declaredGit(), coordinates: COORDS, target, signal: new AbortController().signal,
        candidates: [...knownMirrorCandidates(COORDS, declaredGit()), ...configured], includeArchive: true,
      })
      expect(result.servedBy.host).toBe('mirror.example.test')
      expect(result.attempts.map(row => `${row.host}:${row.outcome}`)).toEqual(['github.com:rejected', 'codeload.github.com:rejected', 'mirror.example.test:served'])
      expect(result.attempts[1]!.reason).toMatch(/POLICY_MIRROR_ARCHIVE_IDENTITY_MISMATCH/)
      expect(readFileSync(target).equals(BYTES)).toBe(true)
    } finally { stub.restore() }
  })
})
