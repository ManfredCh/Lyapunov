/**
 * 第 3 级「搜索 + 下载」的门（DOWN-SEARCH／2026-09-26）。
 *
 * 这一族要证明的只有一件事：**"去网上搜到哪儿有这个文件"不等于"谁先应答谁算数"**。
 * 全部用例**离线**（`globalThis.fetch` 替身），**一次都不打 GitHub**（匿名配额 60/h 已被打满过一次），
 * 也不打任何真网络。
 *
 * 五组判据：
 *  A. **判据门**：没有 sha256／gitBlob 就不许开始搜（"同名 + 同大小"不是身份）；
 *  B. **候选生成与排序**：同一发行方 → 配置镜像 → 搜索发现；归档默认不喂给下载器；packs 源不开后门；
 *  C. **主机纪律**：https／无凭据／非 IP 字面量／非内网名／非官方 HF／白名单；
 *  D. **端到端字节门**（核心）：错字节的候选被拒、对字节的候选被接受、"字节由哪个端点提供"留痕、
 *     跨端点残片不混用、读数缺摘要时回盘重算；
 *  E. **发现请求**：搜的是**指纹**，并且把"不接受什么"写成明文。
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadFile, hashFile, type SourceFile } from '../src/source.ts'
import {
  acceptDiscoveredCandidate, fetchFromMirrors, identityStrength, knownMirrorCandidates,
  mirrorDiscoveryRequest, mirrorHostPolicy, mirrorSourceFile, rankMirrorCandidates,
  requireMirrorIdentity, verifyMirrorReading, type DeclaredIdentity,
} from '../src/mirror-search.ts'

const REPO = 'unitreerobotics/unitree_rl_gym'
const COMMIT = 'b'.repeat(40)
const PATH = 'policy/params/parameters.pkl'
/** 声明字节（真实感：484,076 B 那一档，但内容由本文件造，不来自网络）。 */
const BYTES = Buffer.from('lyapunov-policy-bytes-'.repeat(64))
const GIT_BLOB = createHash('sha1').update(`blob ${BYTES.length}\0`).update(BYTES).digest('hex')
const SHA256 = createHash('sha256').update(BYTES).digest('hex')
/** 同长度、不同内容的"顶包"字节：`bytes` 声明完全一致，`gitBlob`/`sha256` 必不同。 */
const IMPOSTOR = Buffer.from(BYTES.toString('latin1').replace(/^l/, 'L'))

const declaredGit = (over: Partial<DeclaredIdentity['identity']> = {}): DeclaredIdentity => ({
  identity: { path: PATH, bytes: BYTES.length, gitBlob: GIT_BLOB, ...over },
  provenance: 'source-snapshot',
  note: 'sourceSnapshot 的 github tree（本用例自造，与网络无关）',
})
const declaredSha = (): DeclaredIdentity => ({
  identity: { path: PATH, bytes: BYTES.length, sha256: SHA256 },
  provenance: 'local-manifest',
  note: '上一次核对通过的 manifest.sourceFiles[]',
})
const COORDS = { provider: 'github' as const, modelId: REPO, revision: COMMIT }

interface Call { url: string; headers: Record<string, string> }
/** 记录每次请求的 URL 与请求头；`handler` 决定应答（沿用 `policy-source-github-quota.test.ts` 的替身风格）。 */
function stubFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [], original = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init: any = {}) => {
    const call: Call = { url: String(input), headers: { ...(init?.headers ?? {}) } }
    calls.push(call)
    return handler(call)
  }) as unknown as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}
const bytesResponse = (body: Buffer, status = 200) => new Response(body, { status, headers: { 'content-length': String(body.length) } })
const workdir = () => mkdtempSync(join(tmpdir(), 'mirror-search-'))

describe('A. 判据门：没有密码学摘要就不构成身份', () => {
  test('只有"同名 + 同大小"⇒ POLICY_MIRROR_IDENTITY_WEAK，且候选一条都不产出', () => {
    const weak: DeclaredIdentity = { identity: { path: PATH, bytes: BYTES.length }, provenance: 'caller-pin', note: '只有文件大小' }
    expect(identityStrength(weak.identity)).toBe('none')
    expect(() => requireMirrorIdentity(weak)).toThrow(/POLICY_MIRROR_IDENTITY_WEAK/)
    // 关键：门在**候选生成之前**——判据缺席时连"去哪儿找"都不该展开。
    expect(() => knownMirrorCandidates(COORDS, weak)).toThrow(/POLICY_MIRROR_IDENTITY_WEAK/)
    expect(() => mirrorDiscoveryRequest({ declared: weak, coordinates: COORDS, reason: '全部端点不通' })).toThrow(/POLICY_MIRROR_IDENTITY_WEAK/)
  })

  test('身份强度按摘要种类分级：gitBlob(40) / sha256(64)；畸形摘要一律不算', () => {
    expect(identityStrength({ path: PATH, bytes: 1, gitBlob: GIT_BLOB })).toBe('gitBlob')
    expect(identityStrength({ path: PATH, bytes: 1, sha256: SHA256 })).toBe('sha256')
    expect(identityStrength({ path: PATH, bytes: 1, gitBlob: 'ZZZ' })).toBe('none')
    expect(identityStrength({ path: PATH, bytes: 1, sha256: SHA256.slice(0, 63) })).toBe('none')
    // 两者都在 ⇒ 以 sha256 为准（内容寻址更强），但 gitBlob 仍然要核（见 D 组）。
    expect(identityStrength({ path: PATH, bytes: 1, sha256: SHA256, gitBlob: GIT_BLOB })).toBe('sha256')
  })

  test('完全没声明 ⇒ POLICY_MIRROR_IDENTITY_UNDECLARED（这是拒绝执行，不是能力缺口）', () => {
    expect(() => requireMirrorIdentity(undefined as unknown as DeclaredIdentity)).toThrow(/POLICY_MIRROR_IDENTITY_UNDECLARED/)
  })

  test('坏声明当场拒：bytes 非非负整数、path 越界（沿用 policyFile 的既有校验）', () => {
    expect(() => requireMirrorIdentity(declaredGit({ bytes: -1 }))).toThrow(/POLICY_MIRROR_IDENTITY_INVALID/)
    expect(() => requireMirrorIdentity(declaredGit({ bytes: 1.5 }))).toThrow(/POLICY_MIRROR_IDENTITY_INVALID/)
    expect(() => requireMirrorIdentity(declaredGit({ path: '../escape.pkl' }))).toThrow(/INVALID_POLICY_FILE/)
    expect(() => requireMirrorIdentity(declaredGit({ path: '/abs.pkl' }))).toThrow(/INVALID_POLICY_FILE/)
  })
})

describe('B. 候选生成与排序：档位决定顺序，不决定是否核对', () => {
  test('github 只列"同一发行方"的另两条通道；api.github.com 内容接口**不列**（那是第 2 级 W4 的地盘）', () => {
    const rows = knownMirrorCandidates(COORDS, declaredGit())
    expect(rows.map(row => row.host)).toEqual(['github.com', 'codeload.github.com'])
    expect(rows.some(row => row.host === 'api.github.com')).toBe(false)
    expect(rows.some(row => row.url.startsWith('https://raw.githubusercontent.com/'))).toBe(false)
    // codeload 是零配额整仓归档：列出来，但形态是 archive（默认不喂给下载器）。
    expect(rows.find(row => row.host === 'codeload.github.com')!.shape).toBe('archive')
  })

  test('排序：同一发行方(0) → 配置镜像(1) → 搜索发现(2)；archive 默认被过滤，显式要才给', () => {
    const configured = knownMirrorCandidates(COORDS, declaredGit(), { configured: [{ template: `https://mirror.example.test/gh/{id}/{revision}/{path}`, label: 'ops-mirror' }] })
    const discovered = acceptDiscoveredCandidate({ url: 'https://cache.example.test/blob', admittedBy: 'policy-download:level3', declared: declaredGit() }, {})
    const ranked = rankMirrorCandidates([discovered, ...configured, ...knownMirrorCandidates(COORDS, declaredGit())])
    expect(ranked.map(row => row.trust)).toEqual(['same-publisher', 'configured-mirror', 'discovered'])
    expect(ranked.some(row => row.shape === 'archive')).toBe(false)
    expect(rankMirrorCandidates([...knownMirrorCandidates(COORDS, declaredGit())], { includeArchive: true }).some(row => row.shape === 'archive')).toBe(true)
  })

  test('排序确定性 + 去重：同档保持声明顺序，重复 URL 只留一条', () => {
    const a = acceptDiscoveredCandidate({ url: 'https://a.example.test/x', admittedBy: 'l3', declared: declaredGit() })
    const b = acceptDiscoveredCandidate({ url: 'https://b.example.test/x', admittedBy: 'l3', declared: declaredGit() })
    expect(rankMirrorCandidates([a, b, a]).map(row => row.host)).toEqual(['a.example.test', 'b.example.test'])
  })

  test('配置模板要 {sha256} 而声明只有 gitBlob ⇒ 跳过该候选（不降级成别的内容寻址）', () => {
    const rows = knownMirrorCandidates(COORDS, declaredGit(), { configured: [{ template: 'https://cas.example.test/{sha256}', label: 'cas' }] })
    expect(rows.some(row => row.host === 'cas.example.test')).toBe(false)
    // 声明带 sha256 时它才出现，且占位符逐字替换。
    const withSha = knownMirrorCandidates(COORDS, declaredSha(), { configured: [{ template: 'https://cas.example.test/{sha256}', label: 'cas' }] })
    expect(withSha.find(row => row.host === 'cas.example.test')!.url).toBe(`https://cas.example.test/${SHA256}`)
  })

  test('packs 源不开公开后门：候选生成与发现请求都拒', () => {
    const packs = { provider: 'packs' as const, modelId: 'packs/go2', revision: COMMIT }
    expect(() => knownMirrorCandidates(packs, declaredGit())).toThrow(/POLICY_MIRROR_PACKS_FORBIDDEN/)
    expect(() => mirrorDiscoveryRequest({ declared: declaredGit(), coordinates: packs, reason: '端点不通' })).toThrow(/POLICY_MIRROR_PACKS_FORBIDDEN/)
  })

  test('archive 形态不喂给第 1 级下载器：明确报"解包不在本单范围"', () => {
    const archive = rankMirrorCandidates(knownMirrorCandidates(COORDS, declaredGit()), { includeArchive: true }).find(row => row.shape === 'archive')!
    expect(() => mirrorSourceFile(declaredGit(), archive, COMMIT)).toThrow(/POLICY_MIRROR_ARCHIVE_UNSUPPORTED/)
  })
})

describe('C. 主机纪律：搜来的 URL 先过静态闸', () => {
  test('https / 无 userinfo / 非 IP 字面量 / 非内网名 / 非官方 HF', () => {
    expect(mirrorHostPolicy('https://m.example.test/a').hostname).toBe('m.example.test')
    expect(() => mirrorHostPolicy('http://m.example.test/a')).toThrow(/POLICY_MIRROR_URL_MUST_BE_HTTPS/)
    expect(() => mirrorHostPolicy('https://u:p@m.example.test/a')).toThrow(/POLICY_MIRROR_URL_MUST_NOT_INCLUDE_CREDENTIALS/)
    expect(() => mirrorHostPolicy('https://127.0.0.1/a')).toThrow(/POLICY_MIRROR_URL_IP_LITERAL_FORBIDDEN/)
    expect(() => mirrorHostPolicy('https://[::1]/a')).toThrow(/POLICY_MIRROR_URL_IP_LITERAL_FORBIDDEN/)
    expect(() => mirrorHostPolicy('https://localhost/a')).toThrow(/POLICY_MIRROR_URL_PRIVATE_HOST_FORBIDDEN/)
    expect(() => mirrorHostPolicy('https://cache.internal/a')).toThrow(/POLICY_MIRROR_URL_PRIVATE_HOST_FORBIDDEN/)
    // 沿用 source.ts:48 的既有纪律：镜像失败后静默回退官方端点是破约。
    expect(() => mirrorHostPolicy('https://huggingface.co/x/resolve/main/y')).toThrow(/POLICY_MIRROR_OFFICIAL_HF_FORBIDDEN/)
    expect(() => mirrorHostPolicy('https://cdn-lfs.huggingface.co/x')).toThrow(/POLICY_MIRROR_OFFICIAL_HF_FORBIDDEN/)
    expect(() => mirrorHostPolicy('not a url')).toThrow(/POLICY_MIRROR_URL_INVALID/)
  })

  test('白名单：给了 admittedHosts 就只认名单内（精确或 . 后缀）', () => {
    const options = { admittedHosts: ['example.test'] }
    expect(mirrorHostPolicy('https://cdn.example.test/a', options).hostname).toBe('cdn.example.test')
    expect(() => mirrorHostPolicy('https://evil.test/a', options)).toThrow(/POLICY_MIRROR_HOST_NOT_ADMITTED/)
  })

  test('放行第三方候选必须留痕：admittedBy 空 ⇒ 拒', () => {
    expect(() => acceptDiscoveredCandidate({ url: 'https://m.example.test/a', admittedBy: '  ', declared: declaredGit() })).toThrow(/POLICY_MIRROR_ADMITTED_BY_REQUIRED/)
    const row = acceptDiscoveredCandidate({ url: 'https://m.example.test/a', admittedBy: 'policy-download:level3', declared: declaredGit() })
    expect(row.trust).toBe('discovered')
    // 候选结构里**没有**任何摘要字段：类型层面就堵住"候选自带判据"。
    expect(Object.keys(row).filter(key => ['sha256', 'sha', 'gitBlob', 'digest', 'checksum'].includes(key))).toEqual([])
  })
})

describe('D. 端到端字节门：换端点不换判据', () => {
  const MIRROR_TEMPLATE = 'https://mirror.example.test/gh/{id}/{revision}/{path}'
  /** 一条配置镜像候选（T1）。**用产品自己的候选生成器造**，不手搓 trust 字段。 */
  const configuredMirror = () => knownMirrorCandidates(COORDS, declaredGit(), { configured: [{ template: MIRROR_TEMPLATE, label: 'test:configured-mirror' }] }).find(row => row.host === 'mirror.example.test')!
  const discovered = (url: string) => acceptDiscoveredCandidate({ url, admittedBy: 'test:discovered', declared: declaredGit(), rationale: '测试候选' })

  test('第 1 级主机不通 + 镜像给出声明字节 ⇒ 成功，且"字节由哪个端点提供"逐字留痕', async () => {
    const target = join(workdir(), 'parameters.pkl')
    // 同一发行方那条（github.com/…/raw/…）在这一轮照旧 302 到故障主机 ⇒ 先失败；配置镜像随后成功。
    const stub = stubFetch(call => {
      if (call.url.startsWith('https://github.com/')) throw new Error('socket connection was closed unexpectedly')
      return bytesResponse(BYTES)
    })
    try {
      const candidates = knownMirrorCandidates(COORDS, declaredGit(), { configured: [{ template: MIRROR_TEMPLATE, label: 'test:configured-mirror' }] })
      const result = await fetchFromMirrors({ declared: declaredGit(), coordinates: COORDS, candidates, target, signal: new AbortController().signal })
      expect(result.servedBy.host).toBe('mirror.example.test')
      expect(result.servedBy.trust).toBe('configured-mirror')
      expect(result.servedBy.admittedBy).toBe('test:configured-mirror')
      expect(result.reading.gitBlob).toBe(GIT_BLOB)
      expect(readFileSync(target).equals(BYTES)).toBe(true)
      // 失败的那一条也留痕（裁决 (a)：字节从哪来必须答得出来）。
      expect(result.attempts.map(row => `${row.host}:${row.outcome}`)).toEqual(['github.com:rejected', 'mirror.example.test:served'])
      expect(result.attempts[0]!.reason).toMatch(/socket connection was closed unexpectedly/)
    } finally { stub.restore() }
  })

  test('★核心负对照：镜像返回**同长度不同内容**的字节 ⇒ 丢弃该候选（不是"下到了就算"）', async () => {
    const target = join(workdir(), 'parameters.pkl')
    const stub = stubFetch(() => bytesResponse(IMPOSTOR))
    try {
      const failure = fetchFromMirrors({ declared: declaredGit(), coordinates: COORDS, candidates: [configuredMirror()], target, signal: new AbortController().signal })
      await expect(failure).rejects.toThrow(/POLICY_MIRROR_EXHAUSTED/)
      await expect(failure).rejects.toThrow(/POLICY_SOURCE_CHECKSUM_MISMATCH/)
      // 判据不降级：顶包字节连"改名留下"都不行——坏字节不得落地成目标文件。
      expect(() => readFileSync(target)).toThrow()
    } finally { stub.restore() }
  })

  test('第一条候选是顶包、第二条是真的 ⇒ 拒绝并继续，最终由第二条服务（判据一个字不放宽）', async () => {
    const target = join(workdir(), 'parameters.pkl')
    const stub = stubFetch(call => call.url.includes('bad.example.test') ? bytesResponse(IMPOSTOR) : bytesResponse(BYTES))
    try {
      const candidates = [discovered('https://bad.example.test/x'), discovered('https://good.example.test/x')]
      const result = await fetchFromMirrors({ declared: declaredGit(), coordinates: COORDS, candidates, target, signal: new AbortController().signal })
      expect(result.servedBy.host).toBe('good.example.test')
      expect(result.attempts.map(row => `${row.host}:${row.outcome}`)).toEqual(['bad.example.test:rejected', 'good.example.test:served'])
      expect(result.attempts[0]!.reason).toMatch(/POLICY_SOURCE_CHECKSUM_MISMATCH/)
      expect(readFileSync(target).equals(BYTES)).toBe(true)
    } finally { stub.restore() }
  })

  test('候选自称的摘要不是判据：响应头声明 sha256=X，而声明是 Y ⇒ 照样拒', async () => {
    const target = join(workdir(), 'parameters.pkl')
    const impostorSha = createHash('sha256').update(IMPOSTOR).digest('hex')
    const stub = stubFetch(() => new Response(IMPOSTOR, { status: 200, headers: { 'content-length': String(IMPOSTOR.length), 'x-declared-sha256': impostorSha, 'x-checksum-sha256': impostorSha } }))
    try {
      const failure = fetchFromMirrors({ declared: declaredGit(), coordinates: COORDS, candidates: [discovered('https://liar.example.test/x')], target, signal: new AbortController().signal })
      await expect(failure).rejects.toThrow(/POLICY_MIRROR_EXHAUSTED/)
    } finally { stub.restore() }
  })

  test('跨端点残片不混用：第 1 级留下的 .part 不会被镜像候选当成续传起点（从 0 重下）', async () => {
    const root = workdir(), target = join(root, 'parameters.pkl')
    const part = target + '.part'
    mkdirSync(root, { recursive: true })
    // 手工造一份"第 1 级（raw URL）"的半截：identity 里的 url 与镜像候选不同 ⇒ 不得复用。
    const level1: SourceFile = { path: PATH, bytes: BYTES.length, revision: COMMIT, gitBlob: GIT_BLOB, url: `https://raw.githubusercontent.com/${REPO}/${COMMIT}/${PATH}` }
    writeFileSync(part, BYTES.subarray(0, 40))
    writeFileSync(part + '.json', JSON.stringify(level1))
    const stub = stubFetch(() => bytesResponse(BYTES))
    try {
      const result = await fetchFromMirrors({ declared: declaredGit(), coordinates: COORDS, candidates: [configuredMirror()], target, signal: new AbortController().signal })
      expect(stub.calls.length).toBe(1)
      // 没有 Range 头 ⇒ 没有把别人的半截当自己的续传起点。
      expect(stub.calls[0]!.headers.Range ?? stub.calls[0]!.headers.range).toBeUndefined()
      expect(result.reading.gitBlob).toBe(GIT_BLOB)
      expect(readFileSync(target).equals(BYTES)).toBe(true)
    } finally { stub.restore() }
  })

  test('独立复核缺项不算通过：读数没有声明要的那一项摘要时**回盘重算**', async () => {
    const root = workdir(), path = join(root, 'file.bin')
    writeFileSync(path, IMPOSTOR)
    // 读数谎报"字节数对、sha256 有值"，但盘上是另一份内容 ⇒ 回盘重算后 gitBlob 不符。
    const faked = { bytes: IMPOSTOR.length, sha256: SHA256 }
    const verdict = await verifyMirrorReading(declaredGit(), path, faked)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toMatch(/gitBlob 不符/)
    // 负对照另一侧：盘上就是声明字节 ⇒ 通过（证明上一条不是"永远为假"）。
    const good = join(root, 'good.bin'); writeFileSync(good, BYTES)
    expect((await verifyMirrorReading(declaredGit(), good, { bytes: BYTES.length, sha256: SHA256 })).ok).toBe(true)
    // sha256 口径：读数缺 sha256 ⇒ 回盘重算；重算对得上才通过。
    const read = await hashFile(good)
    expect((await verifyMirrorReading(declaredSha(), good, { bytes: BYTES.length, sha256: '' })).ok).toBe(true)
    expect(read.sha256).toBe(SHA256)
  })

  test('全部候选都不合格 ⇒ POLICY_MIRROR_EXHAUSTED，报文里带齐每条候选的裁决与"可否重试=false"', async () => {
    const target = join(workdir(), 'parameters.pkl')
    const stub = stubFetch(call => call.url.includes('down.example.test') ? new Response('gone', { status: 502, headers: { 'content-length': '4' } }) : bytesResponse(IMPOSTOR))
    try {
      const candidates = [discovered('https://down.example.test/x'), discovered('https://bad.example.test/x')]
      const failure = fetchFromMirrors({ declared: declaredGit(), coordinates: COORDS, candidates, target, signal: new AbortController().signal })
      await expect(failure).rejects.toThrow(/可否重试：false/)
      await expect(failure).rejects.toThrow(/down\.example\.test/)
      await expect(failure).rejects.toThrow(/bad\.example\.test/)
    } finally { stub.restore() }
  })

  test('接缝可注入：下载器换成替身时，复核仍然独立发生（不靠下载器自带的门）', async () => {
    const root = workdir(), target = join(root, 'parameters.pkl')
    let called: SourceFile | undefined
    const result = await fetchFromMirrors({
      declared: declaredGit(), coordinates: COORDS, target, signal: new AbortController().signal,
      candidates: [configuredMirror()],
      // 一个"没有字节门"的下载器：把顶包写进盘、并回报一份自认为正确的读数。
      download: async (file, path) => { called = file; writeFileSync(path, IMPOSTOR); return { bytes: BYTES.length, sha256: SHA256 } },
    }).catch(error => String(error))
    expect(called!.url).toBe(`https://mirror.example.test/gh/${REPO}/${COMMIT}/${PATH}`)
    expect(called!.gitBlob).toBe(GIT_BLOB)
    // 下载器没拦住的，被本模块的独立复核拦住了 —— 这正是"两道门互不替代"的证据。
    expect(String(result)).toMatch(/POLICY_MIRROR_EXHAUSTED/)
    expect(String(result)).toMatch(/POLICY_MIRROR_IDENTITY_MISMATCH/)
  })
})

describe('E. 发现请求：搜的是指纹，"不接受什么"是明文', () => {
  test('queries 每条都带指纹；locatorQueries 只按坐标/文件名/字节数缩小范围（线索≠判据）', () => {
    const request = mirrorDiscoveryRequest({ declared: declaredGit(), coordinates: COORDS, reason: 'raw 不通、内容 API 配额耗尽' })
    expect(request.status).toBe('SEARCH_REQUIRED')
    expect(request.reason).toBe('raw 不通、内容 API 配额耗尽')
    expect(request.queries[0]).toBe(GIT_BLOB)
    expect(request.queries.some(query => query.includes('parameters.pkl'))).toBe(true)
    // 指纹是主键：**每一条** query 都带它，搜到的任何结果都必须能被它判。
    expect(request.queries.length).toBeGreaterThan(0)
    expect(request.queries.every(query => query.includes(GIT_BLOB))).toBe(true)
    // 线索面：不冒充判据——它自己一条指纹都不带（正是"看起来像"的那一类，所以单独成字段）。
    expect(request.locatorQueries.some(query => query.includes('parameters.pkl'))).toBe(true)
    expect(request.locatorQueries.some(query => query.includes(String(BYTES.length)))).toBe(true)
    expect(request.locatorQueries.every(query => !query.includes(GIT_BLOB))).toBe(true)
  })

  test('verification 与声明逐字一致；acceptance 只说"候选只能是 blob URL"', () => {
    const request = mirrorDiscoveryRequest({ declared: declaredSha(), coordinates: COORDS, reason: '端点全不通', admittedBy: 'user:2026-09-26' })
    expect(request.verification).toEqual({ kind: 'sha256', value: SHA256, bytes: BYTES.length, rule: expect.stringContaining(SHA256) })
    expect(request.acceptance).toEqual({ allowDiscovered: true, admittedBy: 'user:2026-09-26', candidates: 'blob-urls-only', maxBytes: BYTES.length })
    expect(request.identity).toEqual(declaredSha().identity)
  })

  test('refuses 明文覆盖五类"看起来像但其实不是"的接受理由', () => {
    const { refuses } = mirrorDiscoveryRequest({ declared: declaredGit(), coordinates: COORDS, reason: '端点全不通' })
    const text = refuses.join('\n')
    expect(text).toMatch(/文件名相同|字节数相同/)
    expect(text).toMatch(/候选自己声明的 sha256／gitBlob 当判据/)
    expect(text).toMatch(/非 https/)
    expect(text).toMatch(/huggingface\.co/)
    expect(text).toMatch(/整仓归档/)
    expect(text).toMatch(/packs/)
  })

  test('发现请求里不出现任何凭据形状的串（令牌只进请求头，绝不进发现面）', () => {
    const request = mirrorDiscoveryRequest({ declared: declaredGit(), coordinates: COORDS, reason: '端点全不通' })
    const dump = JSON.stringify(request)
    expect(dump).not.toMatch(/ghp_|Bearer |authorization|token=/i)
  })
})

describe('F. 第 1 级的地盘不被本模块改写（衔接 W4）', () => {
  test('mirrorSourceFile 只换 url：path/bytes/sha256/gitBlob 逐字来自声明', () => {
    const candidate = acceptDiscoveredCandidate({ url: 'https://mirror.example.test/gh/x', admittedBy: 'l3', declared: declaredGit() })
    const file = mirrorSourceFile(declaredGit(), candidate, COMMIT)
    expect(file).toEqual({ path: PATH, bytes: BYTES.length, revision: COMMIT, gitBlob: GIT_BLOB, url: 'https://mirror.example.test/gh/x' })
    // 负对照的靶子：`gitBlob` 一旦不来自声明（例如来自候选或干脆不传），这道门就形同虚设。
    expect(Object.keys(file).sort()).toEqual(['bytes', 'gitBlob', 'path', 'revision', 'url'])
  })

  test('默认下载器就是第 1 级那个（断点续传 + 逐件字节门都在它里面），本模块不另写一份', async () => {
    const root = workdir(), target = join(root, 'nested/dir/parameters.pkl')
    const stub = stubFetch(() => bytesResponse(BYTES))
    try {
      const transfer = await downloadFile(mirrorSourceFile(declaredGit(), acceptDiscoveredCandidate({ url: 'https://mirror.example.test/gh/x', admittedBy: 'l3', declared: declaredGit() }), COMMIT), target, new AbortController().signal, true)
      expect(transfer.gitBlob).toBe(GIT_BLOB)
      expect(readFileSync(target).equals(BYTES)).toBe(true)
    } finally { stub.restore() }
  })
})
