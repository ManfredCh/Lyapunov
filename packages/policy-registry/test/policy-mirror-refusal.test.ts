/**
 * D4 回归：`mirrorDiscoveryRequest()` 的 **refuses 明文真的送进了模型的失败报文**。
 *
 * 缺陷（只读审计 `ZERO-CONSUMER-FIELD-AUDIT-20260926.md` D4）：`mirror-search.ts:361` 的
 * `mirrorDiscoveryRequest()` 是第 3 级（产品自己不搜，把发现请求交给模型的 `web_search`／`web_fetch`）的产出，
 * 文件注释自称"`refuses` 把这条写成了**给模型看的明文**"——但产品 src **零调用**，唯一调用方是它自己的单测。
 * ⇒ 端点全不通时，模型永远看不到"搜到一个同名文件就用"在协议层面是被明文拒绝的。
 *
 * 本文件钉三件事：
 *  ① **有强身份就有 refuses 原文**：本机 manifest 里已落下 sha256（上一次取件静默留下的来源声明）
 *     ⇒ 取件全不通的失败报文里出现 `mirrorDiscoveryRequest().refuses` 的**逐条原文**与指纹判据；
 *  ② **没身份就如实说出不了**：不编一份没有指纹的拒绝清单（"看起来像"正是这份明文要挡的东西）；
 *  ③ **packs 源走它自己那条拒绝原文**（`POLICY_MIRROR_PACKS_FORBIDDEN`：字节只经能力包端点，不回落公开源）。
 *
 * 端点一律用"全部拒绝连接"的 fetch 桩（真·端点全不通），不联网、不打 GitHub。
 * 运行：`bun test packages/policy-registry/test/policy-mirror-refusal.test.ts`
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, declaredIdentityFromManifest, mirrorRefusalNote } from '../src/plugin.ts'
import { policyDirectory } from '../src/source.ts'
import type { PackFetcher, PackRequestInit } from '../src/pack-source.ts'

/** sha256("abc")：形状与真实指纹一致（64 位小写 hex；`identityStrength` 只认这个形状）。 */
const SHA = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
/** gitBlob 形状：40 位小写 hex。 */
const BLOB = 'f2ba8f84ab5c1bce84a7b441cb1959cfc7093b7f'
const REVISION = 'master'
const MODEL = 'unitree/go2'
const emptyDir = () => mkdtempSync(join(tmpdir(), 'policy-mirror-refusal-'))
afterEach(() => { delete process.env.PACK_TOKEN })

/** 最小 dsh 桩（与 `pack-plugin.test.ts` 同一手法）：只装 `apply()` 真正用到的面。 */
function boot(config: Record<string, unknown>) {
  const tools = new Map<string, any>()
  const ctx = {
    tools: { register: (tool: any) => void tools.set(tool.name, tool) },
    commands: { register: () => {} },
    jobs: { start: () => 'job-1', kill: () => {}, wait: async () => undefined },
    effect: () => () => {},
    reflect: { provide: () => {} },
    get: () => undefined,
  }
  apply(ctx as any, config as any)
  const call = (toolName: string, input: Record<string, unknown>) => tools.get(toolName)!.execute({ input }, { agent: 'test-agent', signal: new AbortController().signal } as any)
  return { call }
}
const failed = async (run: () => Promise<unknown>): Promise<string> => { try { await run(); return '' } catch (error) { return String(error) } }
/** 端点全不通：每一次 fetch 都是"连接被拒"。 */
function stubDeadNetwork() {
  const urls: string[] = [], original = globalThis.fetch
  globalThis.fetch = (async (input: any) => { urls.push(String(input)); throw new TypeError('fetch failed: ECONNREFUSED') }) as unknown as typeof fetch
  return { urls, restore: () => { globalThis.fetch = original } }
}
/** 把一个"上一次取件留下的来源声明"写进本机 manifest（downloadPolicy 在来源解析成功后就是写这里）。 */
function seedManifest(dataDirectory: string, provider: 'modelscope' | 'packs', modelId: string, row: { path: string; bytes: number; sha256?: string; gitBlob?: string }) {
  const directory = policyDirectory(dataDirectory, provider, modelId, REVISION)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ status: 'FAILED', provider, modelId, revision: REVISION, resolvedRevision: REVISION, metadata: {}, sourceFiles: [{ ...row, revision: REVISION }], files: [], transfers: [], execution: { status: 'BLOCKED', reason: 'x' }, error: 'POLICY_FETCH_FAILED', updatedAt: '2026-09-26T18:00:00.000Z' }, null, 2))
  return directory
}

describe('D4 · 端点全不通时，refuses 明文进模型的失败报文', () => {
  test('本机已有强身份（上次落下的 sha256）⇒ 报文里有 refuses 逐条原文 + 指纹判据', async () => {
    const dataDirectory = emptyDir()
    seedManifest(dataDirectory, 'modelscope', MODEL, { path: 'README.md', bytes: 128841, sha256: SHA })
    const network = stubDeadNetwork()
    try {
      const message = await failed(() => boot({ dataDirectory }).call('policy_download', { provider: 'modelscope', modelId: MODEL }))
      // ① 真的"端点全不通"：失败仍是既有五要素报文（没被本单改写）
      expect(message).toContain('POLICY_FETCH_FAILED')
      expect(network.urls.length).toBeGreaterThan(0)
      // ② 第 3 级发现请求的**判据**（指纹来自本机 manifest 的声明）
      expect(message).toContain('第 3 级发现请求')
      expect(message).toContain(`sha256 = ${SHA}`)
      expect(message).toContain('取回后逐字核对')
      // ③ refuses 逐条原文（与 mirror-search.ts:387 的清单同源，不是重抄的第二份）
      expect(message).toContain('refuses 原文，共 5 条')
      expect(message).toContain('不接受"文件名相同"或"字节数相同"作为同一份文件的依据')
      expect(message).toContain('不接受候选自己声明的 sha256／gitBlob 当判据')
      expect(message).toContain('不接受非 https、URL 里带凭据、IP 字面量、localhost/内网主机名')
      expect(message).toContain('不接受形态不是单个文件的候选')
      expect(message).toContain('不接受 packs 源的公开回退')
      // ④ 身份是从哪来的，如实写在报文里（本机声明，不是本次访问来源拿到的）
      expect(message).toContain('本机 manifest.json 里 README.md 的声明')
    } finally { network.restore() }
  })

  test('本机没有任何身份 ⇒ 如实说"出不了发现请求"，不编一份没有指纹的拒绝清单', async () => {
    const network = stubDeadNetwork()
    try {
      const message = await failed(() => boot({ dataDirectory: emptyDir() }).call('policy_download', { provider: 'modelscope', modelId: MODEL }))
      expect(message).toContain('本次出不了发现请求：没有可核实的文件身份')
      expect(message).toContain('逐字相同')
      expect(message).not.toContain('refuses 原文')
    } finally { network.restore() }
  })

  test('packs 端点错误保留原错误，不注入镜像发现或缺哈希指引', async () => {
    const dataDirectory = emptyDir()
    seedManifest(dataDirectory, 'packs', 'packs/unitree_go2', { path: 'asset/go2.xml', bytes: 4096, sha256: SHA })
    // 能力包端点也不通：catalog 回 503 ⇒ downloadPack 抛 PACK_*
    const fetcher: PackFetcher = async (_url: string, _init: PackRequestInit) => new Response('', { status: 503 })
    const message = await failed(() => boot({ dataDirectory, packEndpoint: 'http://127.0.0.1:9472/packs/v1', packFetcher: fetcher }).call('policy_download', { provider: 'packs', modelId: 'packs/unitree_go2' }))
    expect(message).toContain('PACK_')
    expect(message).not.toContain('第 3 级发现请求')
    expect(message).not.toContain('先取到固定 revision')
    expect(message).not.toContain('refuses 原文')
  })

  test('检索面失败也走同一条通道（没有文件坐标 ⇒ 明说形不成发现请求）', async () => {
    const network = stubDeadNetwork()
    try {
      const message = await failed(() => boot({ dataDirectory: emptyDir() }).call('policy_search', { provider: 'github', query: 'unitree go2' }))
      expect(message).toContain('fetch failed')
      expect(message).toContain('第 3 级发现请求')
      expect(message).toContain('本次出不了发现请求：没有可核实的文件身份')
      expect(message).toContain('policy_search 失败（provider=github')
    } finally { network.restore() }
  })
})

describe('D4 · 身份门的强度：只认密码学摘要', () => {
  test('限流或文件选择失败保持真实原因，不要求再次获取哈希或镜像发现', () => {
    for(const code of ['POLICY_GITHUB_RATE_LIMITED','POLICY_FILE_NOT_IN_SOURCE'])
      expect(mirrorRefusalNote({reason:`policy_download 失败：${code}`,declared:null,coordinates:null})).toBe('')
  })
  test('sha256／gitBlob 任一成立即给身份；路径先按本次请求的文件名匹配', async () => {
    const dataDirectory = emptyDir()
    seedManifest(dataDirectory, 'modelscope', MODEL, { path: 'config.json', bytes: 20, sha256: SHA })
    const declared = await declaredIdentityFromManifest(dataDirectory, 'modelscope', MODEL, REVISION, ['README.md', 'config.json'])
    expect(declared?.identity.path).toBe('config.json')
    expect(declared?.identity.sha256).toBe(SHA)
    expect(declared?.provenance).toBe('local-manifest')
    // 本次请求的文件名一个都不在清单里 ⇒ 仍按清单里第一个强身份给（否则失败报文会退化成"出不了"）
    expect((await declaredIdentityFromManifest(dataDirectory, 'modelscope', MODEL, REVISION, ['nope.bin']))?.identity.path).toBe('config.json')
  })

  test('gitBlob 也认（40 位 hex）；形状不对（弱身份）一律判 null', async () => {
    const dataDirectory = emptyDir()
    seedManifest(dataDirectory, 'modelscope', MODEL, { path: 'README.md', bytes: 20, gitBlob: BLOB })
    expect((await declaredIdentityFromManifest(dataDirectory, 'modelscope', MODEL, REVISION, ['README.md']))?.identity.gitBlob).toBe(BLOB)
    const weak = emptyDir()
    seedManifest(weak, 'modelscope', MODEL, { path: 'README.md', bytes: 20, sha256: 'abc' })
    expect(await declaredIdentityFromManifest(weak, 'modelscope', MODEL, REVISION, ['README.md'])).toBeNull()
    // 没有 manifest／没有清单：null，不抛
    expect(await declaredIdentityFromManifest(emptyDir(), 'modelscope', MODEL, REVISION, ['README.md'])).toBeNull()
  })

  test('`mirrorRefusalNote` 是纯函数：身份/坐标缺一即走"出不了"分支，两者齐才出 refuses 原文', () => {
    const coordinates = { provider: 'modelscope' as const, modelId: MODEL, revision: REVISION }
    const declared = { identity: { path: 'README.md', bytes: 128841, sha256: SHA }, provenance: 'local-manifest' as const, note: 'x' }
    expect(mirrorRefusalNote({ reason: 'r', declared: null, coordinates })).toContain('本次出不了发现请求')
    expect(mirrorRefusalNote({ reason: 'r', declared, coordinates: null })).toContain('本次出不了发现请求')
    const full = mirrorRefusalNote({ reason: 'r', declared, coordinates })
    expect(full).toContain('refuses 原文，共 5 条')
    expect(full).toContain(SHA)
  })
})
