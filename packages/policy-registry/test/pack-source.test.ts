/**
 * `packs` 源回归测试（能力包端点合同 Dev/docs/PACK_ENDPOINT_CONTRACT.md）：
 *
 * 1. 客户端**只经我们服务器的能力包端点**（catalog/open/stream）取件，绝不回落公开源下载；
 * 2. open→stream 逐文件 sha256/bytes 核对，篡改即 PACK_INTEGRITY_MISMATCH 并删除派生件；
 * 3. HTTP 状态错误映射（401/402/403/404/410/未知）按合同 §2；
 * 4. manifest 与落盘目录**不得含 http 字符串**（负面清单第 2 条：无裸文件直链）；
 * 5. AbortSignal 取消传播（checkCancelled 风格）。
 *
 * fetch 通过 downloadPack 的 fetcher 注入点 mock（与 match.ts 传桩对象同思路），不打真实网络。
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { downloadPack, packEndpoint, packModelId, PACK_PIECES, type PackFetcher, type PackRequestInit } from '../src/pack-source.ts'
import { downloadPolicy, sourceSnapshot } from '../src/source.ts'

const ENDPOINT = 'http://127.0.0.1:9471/packs/v1' // 合同允许 http://127.0.0.1|localhost 便于测试
const TOKEN = 'test-pack-token' // 假 token（测试注入用；实现不得把任何 token 写进文件）
const encoder = new TextEncoder()
const sha256hex = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
const bytesOf = (text: string) => encoder.encode(text)
const emptyDir = () => mkdtempSync(join(tmpdir(), 'policy-pack-'))

const PACK_FILES = [
  { path: 'asset/panda.xml', text: '<mujoco model="panda"><worldbody/></mujoco>' },
  { path: 'policy/adapter.json', text: '{"adapter":"pack-test","frequencyHz":50}' },
]
const defaultListing = () => PACK_FILES.map(file => { const bytes = bytesOf(file.text); return { path: file.path, bytes: bytes.byteLength, sha256: sha256hex(bytes) } })
const streamBytes = (path: string) => {
  const file = PACK_FILES.find(row => row.path === path)
  if (!file) throw new Error('清单外路径: ' + path)
  return bytesOf(file.text)
}

interface Recorded { method: string; url: string; authorization?: string; body?: string }
interface MockOptions {
  packs?: unknown[]
  listing?: unknown[]
  mountId?: string
  maxBytes?: number
  streamBytes?: (path: string) => Uint8Array
  fail?: { phase: 'catalog' | 'open' | 'stream'; status: number; code?: string }
  onCall?: (recorded: Recorded, phase: 'catalog' | 'open' | 'stream', index: number) => void
}
function mockPackServer(options: MockOptions = {}) {
  const calls: Recorded[] = []
  const fetcher: PackFetcher = async (url: string, init: PackRequestInit) => {
    const recorded: Recorded = { method: init.method ?? 'GET', url, authorization: init.headers?.authorization, body: init.body }
    calls.push(recorded)
    const phase: 'catalog' | 'open' | 'stream' = url.endsWith('/catalog') ? 'catalog' : url.endsWith('/open') ? 'open' : 'stream'
    options.onCall?.(recorded, phase, calls.length)
    if (options.fail?.phase === phase) {
      const { status, code } = options.fail
      return new Response(code ? JSON.stringify({ code }) : '', { status })
    }
    if (phase === 'catalog') {
      return new Response(JSON.stringify({ packs: options.packs ?? [{ packId: 'unitree_go2', version: '2026.09.22', family: 'quadruped', pieces: { asset: true, context: true, policy: true, vla: true }, status: 'USABLE' }] }), { status: 200 })
    }
    if (phase === 'open') {
      const body = JSON.parse(init.body ?? '{}')
      return new Response(JSON.stringify({ mountId: options.mountId ?? 'mnt-42', packId: body.packId, expiresAt: '2026-09-22T00:02:00Z', files: options.listing ?? defaultListing(), budget: { maxBytes: options.maxBytes ?? 10_000_000 } }), { status: 200 })
    }
    const path = new URL(url).searchParams.get('path') ?? ''
    return new Response((options.streamBytes ?? streamBytes)(path), { status: 200 })
  }
  return { fetcher, calls }
}
const capture = async (run: () => Promise<unknown>): Promise<any> => { try { await run(); return undefined } catch (error) { return error } }
const readManifest = (root: string) => JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
function walkFiles(dir: string, base = dir): Array<{ path: string; text: string }> {
  const rows: Array<{ path: string; text: string }> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) rows.push(...walkFiles(full, base))
    else rows.push({ path: relative(base, full), text: readFileSync(full, 'utf8') })
  }
  return rows
}

const baseInput = (dataDirectory: string, mock: ReturnType<typeof mockPackServer>, extra: Record<string, unknown> = {}) =>
  ({ dataDirectory, modelId: 'packs/unitree_go2', endpoint: ENDPOINT, token: TOKEN, signal: new AbortController().signal, fetcher: mock.fetcher, ...extra })

describe('packs 源：只经能力包端点 catalog/open/stream 取件', () => {
  test('happy path：open→2 文件→sha256 校验→manifest 落盘（同族布局，provider 段 packs）', async () => {
    const dataDirectory = emptyDir()
    const mock = mockPackServer()
    const result = await downloadPack(baseInput(dataDirectory, mock) as any)

    // 三端点各打一次，且**全部**指向我们的端点（无任何公开源回落）
    expect(mock.calls.map(call => new URL(call.url).pathname)).toEqual(['/packs/v1/catalog', '/packs/v1/open', '/packs/v1/stream', '/packs/v1/stream'])
    for (const call of mock.calls) expect(call.url.startsWith(ENDPOINT)).toBe(true)
    for (const call of mock.calls) expect(call.authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(mock.calls[1]!.body!)).toEqual({ packId: 'unitree_go2', pieces: [...PACK_PIECES] })
    expect(new URL(mock.calls[2]!.url).searchParams.get('mount')).toBe('mnt-42')

    // policyDirectory 同族布局：policies/packs/<packs__id>/<revision>
    expect(result.path.endsWith(join('policies', 'packs', 'packs__unitree_go2', 'master'))).toBe(true)
    expect(result.status).toBe('DOWNLOADED')
    expect(result.provider).toBe('packs')
    expect(result.resolvedRevision).toBe('mnt-42')
    for (const file of PACK_FILES) {
      expect(readFileSync(join(result.path, file.path), 'utf8')).toBe(file.text)
    }

    // manifest：sourceFiles 只记 path/bytes/sha256/revision（revision＝mount 快照），无 url 键
    const manifest = readManifest(result.path)
    expect(manifest.status).toBe('DOWNLOADED')
    expect(manifest.modelId).toBe('packs/unitree_go2')
    expect(manifest.sourceFiles).toHaveLength(2)
    for (const [index, file] of manifest.sourceFiles.entries()) {
      expect(Object.keys(file).sort()).toEqual(['bytes', 'path', 'revision', 'sha256'])
      expect(file).toEqual({ ...defaultListing()[index]!, revision: 'mnt-42' })
      expect(file.url).toBeUndefined()
    }
    expect(manifest.files.map((file: any) => file.sha256)).toEqual(defaultListing().map(file => file.sha256))
    expect(manifest.execution.status).toBe('BLOCKED')
  })

  test('manifest 与落盘目录不得含 http 字符串（负面清单第 2 条：无裸文件直链）', async () => {
    const dataDirectory = emptyDir()
    const mock = mockPackServer()
    const result = await downloadPack(baseInput(dataDirectory, mock) as any)
    const rows = walkFiles(result.path)
    expect(rows.length).toBeGreaterThanOrEqual(3) // manifest + 2 文件
    for (const row of rows) {
      expect(row.path).not.toContain('http')
      expect(row.text).not.toContain('http')
    }
    expect(JSON.stringify(readManifest(result.path))).not.toContain('http')
  })

  test('篡改字节（sha256 不符）⇒ PACK_INTEGRITY_MISMATCH 并删除派生件（含已落盘与 .part）', async () => {
    const dataDirectory = emptyDir()
    const tampered = bytesOf('<mujoco model="panda"><worldbody/></mujoco>'.replace('panda', 'PANDA'))
    const mock = mockPackServer({ streamBytes: (path) => path === 'policy/adapter.json' ? tampered : streamBytes(path) })
    const error = await capture(() => downloadPack(baseInput(dataDirectory, mock) as any))
    expect(error?.code).toBe('PACK_INTEGRITY_MISMATCH')

    const root = join(dataDirectory, 'policies', 'packs', 'packs__unitree_go2', 'master')
    // 派生件全部删除：已核对通过的第一件、篡改件、.part 均不得留存
    expect(existsSync(join(root, 'asset', 'panda.xml'))).toBe(false)
    expect(existsSync(join(root, 'policy', 'adapter.json'))).toBe(false)
    expect(existsSync(join(root, 'policy', 'adapter.json.part'))).toBe(false)
    expect(walkFiles(root).map(row => row.path)).toEqual(['manifest.json'])
    const manifest = readManifest(root)
    expect(manifest.status).toBe('FAILED')
    expect(String(manifest.error)).toContain('PACK_INTEGRITY_MISMATCH')
  })

  test('篡改字节数（bytes 不符）⇒ 同样 PACK_INTEGRITY_MISMATCH', async () => {
    const mock = mockPackServer({ streamBytes: (path) => path === 'asset/panda.xml' ? bytesOf('short') : streamBytes(path) })
    const error = await capture(() => downloadPack(baseInput(emptyDir(), mock) as any))
    expect(error?.code).toBe('PACK_INTEGRITY_MISMATCH')
  })

  test('错误映射：401→PACK_UNAUTHORIZED（catalog 阶段即拒）', async () => {
    const mock = mockPackServer({ fail: { phase: 'catalog', status: 401 } })
    const error = await capture(() => downloadPack(baseInput(emptyDir(), mock) as any))
    expect(error?.code).toBe('PACK_UNAUTHORIZED')
  })

  test('错误映射：404→PACK_NOT_FOUND（open 阶段）；catalog 无该 packId 也报 PACK_NOT_FOUND', async () => {
    const mock = mockPackServer({ fail: { phase: 'open', status: 404 } })
    const error = await capture(() => downloadPack(baseInput(emptyDir(), mock) as any))
    expect(error?.code).toBe('PACK_NOT_FOUND')

    const missing = mockPackServer({ packs: [{ packId: 'other_pack', pieces: { asset: true } }] })
    const error2 = await capture(() => downloadPack(baseInput(emptyDir(), missing) as any))
    expect(error2?.code).toBe('PACK_NOT_FOUND')
    expect(missing.calls.map(call => new URL(call.url).pathname)).toEqual(['/packs/v1/catalog'])
  })

  test('未知机型不能借同族 T0 包或 ready 元数据回落，拒绝发生在 open/stream 前', async () => {
    const mock = mockPackServer({ packs: [{
      packId: 'unitree_go2', family: 'quadruped', tier: 'T0',
      pieces: { asset: true, context: true, policy: true, vla: true },
      contentReady: true, adapterReady: true, behaviorVerified: true,
    }] })
    const error = await capture(() => downloadPack({ ...baseInput(emptyDir(), mock), modelId: 'packs/unitree_go3' } as any))
    expect(error?.code).toBe('PACK_NOT_FOUND')
    expect(mock.calls.map(call => new URL(call.url).pathname)).toEqual(['/packs/v1/catalog'])
  })

  test('错误映射：410 由服务端定夺——默认 PACK_MOUNT_EXPIRED，body code=PACK_MOUNT_SPENT 时报 SPENT（客户端不自行延寿）', async () => {
    const expired = mockPackServer({ fail: { phase: 'stream', status: 410 } })
    const error = await capture(() => downloadPack(baseInput(emptyDir(), expired) as any))
    expect(error?.code).toBe('PACK_MOUNT_EXPIRED')

    const spent = mockPackServer({ fail: { phase: 'stream', status: 410, code: 'PACK_MOUNT_SPENT' } })
    const error2 = await capture(() => downloadPack(baseInput(emptyDir(), spent) as any))
    expect(error2?.code).toBe('PACK_MOUNT_SPENT')
  })

  test('错误映射：402/403/未知状态 → PACK_PAYMENT_REQUIRED、PACK_BUDGET_EXCEEDED、PACK_FORBIDDEN、PACK_ENDPOINT_ERROR', async () => {
    const open402 = mockPackServer({ fail: { phase: 'open', status: 402 } })
    expect((await capture(() => downloadPack(baseInput(emptyDir(), open402) as any)))?.code).toBe('PACK_PAYMENT_REQUIRED')

    const stream402 = mockPackServer({ fail: { phase: 'stream', status: 402 } })
    expect((await capture(() => downloadPack(baseInput(emptyDir(), stream402) as any)))?.code).toBe('PACK_BUDGET_EXCEEDED')

    const stream402Payment = mockPackServer({ fail: { phase: 'stream', status: 402, code: 'PACK_PAYMENT_REQUIRED' } })
    expect((await capture(() => downloadPack(baseInput(emptyDir(), stream402Payment) as any)))?.code).toBe('PACK_PAYMENT_REQUIRED')

    const forbidden = mockPackServer({ fail: { phase: 'catalog', status: 403 } })
    expect((await capture(() => downloadPack(baseInput(emptyDir(), forbidden) as any)))?.code).toBe('PACK_FORBIDDEN')

    const unknown = mockPackServer({ fail: { phase: 'catalog', status: 500 } })
    expect((await capture(() => downloadPack(baseInput(emptyDir(), unknown) as any)))?.code).toBe('PACK_ENDPOINT_ERROR')
  })

  test('取消传播：stream 中 abort ⇒ 按 checkCancelled 语义抛出 reason，manifest 记 CANCELLED', async () => {
    const dataDirectory = emptyDir()
    const controller = new AbortController()
    const reason = new Error('USER_CANCELLED')
    const mock = mockPackServer({
      onCall: (_recorded, phase, index) => {
        if (phase === 'stream' && index === 3) { controller.abort(reason); throw new Error('fetch aborted') }
      },
    })
    const error = await capture(() => downloadPack(baseInput(dataDirectory, mock, { signal: controller.signal }) as any))
    expect(error).toBe(reason)
    const root = join(dataDirectory, 'policies', 'packs', 'packs__unitree_go2', 'master')
    const manifest = readManifest(root)
    expect(manifest.status).toBe('CANCELLED')
    expect(String(manifest.error)).toContain('USER_CANCELLED')
  })

  test('open 预算不足 ⇒ PACK_BUDGET_EXCEEDED（不进入 stream）', async () => {
    const mock = mockPackServer({ maxBytes: 1 })
    const error = await capture(() => downloadPack(baseInput(emptyDir(), mock) as any))
    expect(error?.code).toBe('PACK_BUDGET_EXCEEDED')
    expect(mock.calls.map(call => new URL(call.url).pathname)).toEqual(['/packs/v1/catalog', '/packs/v1/open'])
  })

  test('catalog 只作 packId 与 pieces 校验：piece 不可用 ⇒ PACK_PIECE_UNAVAILABLE', async () => {
    const mock = mockPackServer({ packs: [{ packId: 'unitree_go2', pieces: { asset: true, context: true, policy: true, vla: false } }] })
    const error = await capture(() => downloadPack(baseInput(emptyDir(), mock, { pieces: ['asset', 'vla'] }) as any))
    expect(error?.code).toBe('PACK_PIECE_UNAVAILABLE')
  })

  test('鉴权头取自 PACK_TOKEN 环境变量；模型 id 校验沿用 policyId 风格；endpoint 只放行 https 与本机 http', async () => {
    process.env.PACK_TOKEN = 'env-pack-token'
    try {
      const mock = mockPackServer()
      await downloadPack({ dataDirectory: emptyDir(), modelId: 'packs/unitree_go2', endpoint: ENDPOINT, signal: new AbortController().signal, fetcher: mock.fetcher } as any)
      expect(mock.calls[0]!.authorization).toBe('Bearer env-pack-token')
    } finally { delete process.env.PACK_TOKEN }

    const noToken = mockPackServer()
    expect((await capture(() => downloadPack({ dataDirectory: emptyDir(), modelId: 'packs/unitree_go2', endpoint: ENDPOINT, signal: new AbortController().signal, fetcher: noToken.fetcher } as any)))?.code).toBe('PACK_TOKEN_MISSING')

    expect((await capture(async () => packModelId('unitree_go2'))) ).toBeInstanceOf(Error)
    expect((await capture(async () => packModelId('packs/../etc'))) ).toBeInstanceOf(Error)
    let wrongPrefix: any
    try { packModelId('modelscope/unitree_go2') } catch (error) { wrongPrefix = error }
    expect(wrongPrefix?.code).toBe('INVALID_PACK_MODEL_ID')
    let badEndpoint: any
    try { packEndpoint('http://evil.example.com/packs/v1') } catch (error) { badEndpoint = error }
    expect(badEndpoint?.code).toBe('PACK_ENDPOINT_MUST_BE_HTTPS')
    expect(packEndpoint('https://api.vorynel.com/packs/v1/')).toBe('https://api.vorynel.com/packs/v1')
    expect(packEndpoint(ENDPOINT)).toBe(ENDPOINT)
  })

  test('负面：packs 源禁止回落公开源下载（sourceSnapshot/downloadPolicy 直接拒绝，且不打任何网络）', async () => {
    const fallback = await capture(() => sourceSnapshot('packs', 'packs/unitree_go2', 'master', 'https://modelscope.cn'))
    expect(String(fallback?.message)).toContain('PACK_PUBLIC_FALLBACK_FORBIDDEN')

    const viaDownload = await capture(() => downloadPolicy({ dataDirectory: emptyDir(), endpoint: 'https://modelscope.cn', provider: 'packs', modelId: 'packs/unitree_go2', files: ['pack.json'], signal: new AbortController().signal }))
    expect(String(viaDownload?.message)).toContain('PACK_PUBLIC_FALLBACK_FORBIDDEN')
  })
})
