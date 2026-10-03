/**
 * 失败可恢复（ENV-49/51）在**上层两条真实路径**上的行为测试：环境资产导入与公开模型获取。
 *
 * **这是本机故障夹具，不是公网故障**：服务器只监听 127.0.0.1，按脚本决定每一条请求是正常回体、
 * 中途断流、慢体还是 404；URL 用真来源主机名（api.polyhaven.com / dl.polyhaven.org），
 * 字节全部来自本机合成夹具，不发往公网、也不冒充真实公网故障。
 * 覆盖：中途断流后第二次成功；已成功取回的依赖不因别的文件重试而重下（复用）；
 * 查询字节与下载字节分列且失败尝试的字节照样计费；404 这类永久失败不重试且不登记资源；
 * 字节"读完但内容不对"（md5/字节不符）按短暂故障重试；asset-acquisition 的 attempts/retries 读数。
 * 运行：`bun test packages/scene-kit/test/fault-recovery.test.ts`
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { acquireAsset, type AssetAcquisitionDependencies } from '../src/asset-acquisition.ts'
import { environmentAssetDetail, importEnvironmentAsset, type EnvironmentAssetDependencies } from '../src/environment-assets.ts'
import { SceneOperations } from '../src/operations.ts'

const API_HOST = 'https://api.polyhaven.com'
const DL_HOST = 'https://dl.polyhaven.org'
const ASSET_ID = 'test_wall'
const GLTF_PATH = `/${ASSET_ID}/1k/wall.gltf`
const BIN_PATH = `/${ASSET_ID}/1k/wall.bin`
const PNG_PATH = `/${ASSET_ID}/1k/textures/albedo.png`

const md5Of = (bytes: Buffer): string => createHash('md5').update(bytes).digest('hex')

/** 一枚按 PNG 容器规范拼装的真实 PNG（不依赖图片库）。 */
function pngOf(width: number, height: number, seed: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * (1 + width * 3) + 1 + x * 3
    raw[at] = (x + seed) % 256
    raw[at + 1] = (y + seed) % 256
    raw[at + 2] = seed % 256
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateRawSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** 真 glTF 2.0：POSITION 带 min/max（detail 的尺度口径要它），buffer 与一张纹理走相对依赖。 */
function wallFixture(): { json: any; bin: Buffer; png: Buffer } {
  const png = pngOf(4, 3, 7)
  const positions = Buffer.alloc(36)
  for (const [index, xyz] of [[-2, 0, -0.1], [2, 0, -0.1], [0, 3, 0.1]].entries()) for (const [axis, value] of xyz.entries()) positions.writeFloatLE(value, index * 12 + axis * 4)
  const bin = positions
  const json = {
    asset: { version: '2.0', generator: 'fault-recovery.test' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: '墙' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ name: '墙材质', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }],
    samplers: [{}],
    textures: [{ source: 0, sampler: 0 }],
    images: [{ uri: 'textures/albedo.png' }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-2, 0, -0.1], max: [2, 3, 0.1] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }],
    buffers: [{ uri: 'wall.bin', byteLength: bin.length }],
  }
  return { json, bin, png }
}

/** 每一条请求要做什么：正常回体 / 中途断流（声明全长只给一部分）/ 只给状态码 / 换一份"完整但不对"的字节。 */
type Fault = { kind: 'ok'; body?: Buffer } | { kind: 'cut'; keep: number } | { kind: 'status'; status: number } | { kind: 'swap'; body: Buffer }

let workspace: string
let operations: SceneOperations
let server: Server
let routes: Map<string, Buffer>
let plan: Map<string, Fault[]>
let hits: Map<string, number>
let port = 0
let fixture: ReturnType<typeof wallFixture>
let gltfBytes: Buffer

const resolvePublic = async (): Promise<Array<{ address: string; family: number }>> => [{ address: '93.184.216.34', family: 4 }]

/** 传输钩子是既有注入口径：URL 仍按公网地址解析，真实连接打到本机夹具端口。 */
const fixtureTransport = (url: URL, options: any, listener: any) =>
  httpRequest({ method: options.method ?? 'GET', hostname: '127.0.0.1', port, path: url.pathname + url.search, headers: options.headers }, listener)

const envDependencies = (overrides: EnvironmentAssetDependencies = {}): EnvironmentAssetDependencies => ({
  resolve: resolvePublic, transport: fixtureTransport as never, retry: { backoffMs: 5 }, ...overrides,
})
const assetDependencies = (overrides: AssetAcquisitionDependencies = {}): AssetAcquisitionDependencies => ({
  resolve: resolvePublic, transport: fixtureTransport as never, retry: { backoffMs: 5 }, ...overrides,
})

const hitsOf = (path: string): number => hits.get(path) ?? 0
const failureOf = async (work: Promise<unknown>): Promise<string> => {
  try { await work; return '（没有抛错）' } catch (error) { return error instanceof Error ? error.message : String(error) }
}
const recordCount = async (): Promise<number> => (await operations.resources.authoritySnapshot()).records.length

/** 目录：与 PolyHaven 目录同形的 `assets?t=models` 响应。 */
function manifestOf(): Buffer {
  return Buffer.from(JSON.stringify({
    [ASSET_ID]: { name: '测试墙', categories: ['Facades & Modules'], tags: ['wall', 'modular'], authors: { '夹具作者': 'CC0' }, download_count: 5 },
  }), 'utf8')
}
/** 清单：主 .gltf + 一个 .bin + 一张纹理，size/md5 都是夹具真字节的值。 */
function filesOf(): Buffer {
  const entry = (path: string, body: Buffer): Record<string, unknown> => ({ url: `${DL_HOST}${path}`, size: body.length, md5: md5Of(body) })
  return Buffer.from(JSON.stringify({
    gltf: { '1k': { gltf: { ...entry(GLTF_PATH, gltfBytes), include: { 'wall.bin': entry(BIN_PATH, fixture.bin), 'textures/albedo.png': entry(PNG_PATH, fixture.png) } } } },
  }), 'utf8')
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'scene-kit-fault-'))
  operations = new SceneOperations(join(workspace, 'data'))
  fixture = wallFixture()
  gltfBytes = Buffer.from(JSON.stringify(fixture.json, null, 2), 'utf8')
  routes = new Map([
    ['/assets', manifestOf()],
    [`/files/${ASSET_ID}`, filesOf()],
    [GLTF_PATH, gltfBytes],
    [BIN_PATH, fixture.bin],
    [PNG_PATH, fixture.png],
  ])
  plan = new Map()
  hits = new Map()
  server = createServer((request, response) => {
    response.on('error', () => { /* 客户端取消会打断响应，夹具不因此失败 */ })
    const path = (request.url ?? '').split('?')[0]!
    const body = routes.get(path)
    const script = plan.get(path)
    const index = hitsOf(path)
    hits.set(path, index + 1)
    const fault: Fault = script ? script[Math.min(index, script.length - 1)]! : { kind: 'ok' }
    if (process.env.FAULT_TRACE) console.log('[trace]', path, 'hit', index + 1, fault.kind)
    if (fault.kind === 'status') { response.writeHead(fault.status, { 'content-type': 'text/plain', 'content-length': '0' }); response.end(); return }
    if (!body) { response.writeHead(404, { 'content-type': 'text/plain', 'content-length': '0' }); response.end(); return }
    if (fault.kind === 'cut') {
      // 声明全长、只写前 keep 字节，等刷出去再优雅 FIN：客户端确定性地收到 keep 字节 + 读体未完成的失败。
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) })
      response.write(body.subarray(0, fault.keep), () => { setTimeout(() => response.socket?.end(), 5) })
      return
    }
    const payload = fault.kind === 'swap' ? fault.body : body
    const type = path.endsWith('.gltf') ? 'model/gltf+json' : path.endsWith('.png') ? 'image/png' : path === '/assets' || path.startsWith('/files/') ? 'application/json' : 'application/octet-stream'
    response.writeHead(200, { 'content-type': type, 'content-length': String(payload.length) })
    response.end(payload)
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  port = (server.address() as { port: number }).port
})

afterEach(async () => {
  server.closeAllConnections?.()
  await new Promise<void>(ready => server.close(() => ready()))
  await rm(workspace, { recursive: true, force: true })
})

describe('环境资产导入：中途断流可恢复、配额分列、永久失败不重试', () => {
  it('主文件中途断流后第二次成功：detail 给出真清单，retries 读数如实', async () => {
    plan.set(GLTF_PATH, [{ kind: 'cut', keep: 64 }, { kind: 'ok' }])
    const detail = await environmentAssetDetail({ assetId: ASSET_ID, resolution: '1k' }, envDependencies())
    expect(detail.meshes).toBe(1)
    expect(detail.sizeM).toEqual([4, 3, 0.2])
    // 服务端看到的是"至少重来了一次"：连接被切断时客户端自己也可能重发一次，所以这里不钉死次数，
    // 真正的重试次数以调用方的 attempts/retries 读数为准（下一行）。
    expect(hitsOf(GLTF_PATH)).toBeGreaterThanOrEqual(2)
    // 查询字节（目录 + 清单）与下载字节（主文件）分列，失败尝试已到达的字节也算在下载额度里。
    expect(detail.budget.queryBytes).toBeGreaterThan(0)
    expect(detail.budget.downloadBytes).toBeGreaterThanOrEqual(gltfBytes.length)
    expect(detail.budget.downloadBytes).toBeLessThanOrEqual(detail.budget.limit)
    // 逻辑重试次数以调用方读数为准（服务端可能还看到客户端自己重发的那一次，那不是本层的重试）。
    expect(detail.budget.retries).toBe(1)
  })

  it('导入时一张纹理断流：第二次成功，且已取回的 .bin/纹理不因重试重下（复用）', async () => {
    plan.set(PNG_PATH, [{ kind: 'cut', keep: 20 }, { kind: 'ok' }])
    const result = await importEnvironmentAsset(operations, { assetId: ASSET_ID, resolution: '1k' }, envDependencies())
    // 成功导入、源文件字节与哈希都对上夹具真字节。
    expect(result.sourceFiles.map(file => file.name)).toEqual(['wall.gltf', 'wall.bin', 'textures/albedo.png'])
    expect(result.sourceFiles[1]!.sha256).toBe(createHash('sha256').update(fixture.bin).digest('hex'))
    // 只有出问题的那张纹理被重来：gltf 与 bin 各只请求一次（已完整取回的依赖不因别处的重试重下）。
    expect(hitsOf(PNG_PATH)).toBeGreaterThanOrEqual(2)
    expect(hitsOf(GLTF_PATH)).toBe(1)
    expect(hitsOf(BIN_PATH)).toBe(1)
    expect(result.budget.retries).toBe(1)
    // 下载额度按到达量计费：成功的真字节之外，断流那次已经到达的字节也算（截断那次没有成功交付，
    // 但字节确实从网上下来了）；查询字节另算。上限一分不绕：downloadBytes 始终 ≤ limit。
    const download = gltfBytes.length + fixture.bin.length + fixture.png.length
    expect(result.budget.downloadBytes).toBeGreaterThanOrEqual(download)
    expect(result.budget.queryBytes).toBeGreaterThan(0)
    expect(result.budget.downloadBytes).toBeLessThanOrEqual(result.budget.limit)
  })

  it('404 是永久失败：只请求一次、不重试、不登记资源', async () => {
    const before = await recordCount()
    plan.set(PNG_PATH, [{ kind: 'status', status: 404 }])
    const failure = await failureOf(importEnvironmentAsset(operations, { assetId: ASSET_ID, resolution: '1k' }, envDependencies()))
    expect(failure).toContain('ENVIRONMENT_ASSET_HTTP_404')
    expect(hitsOf(PNG_PATH)).toBe(1)
    expect(await recordCount()).toBe(before)
  })

  it('字节"读完但内容不对"（md5 不符）按短暂故障重试，重试后用的是好字节', async () => {
    // 第一次回一份"长度自洽但内容不对"的 PNG（正是 39 号那次坏图的形态）：只看长度看不出来，靠清单 md5 拦住。
    const wrong = pngOf(4, 3, 99)
    plan.set(PNG_PATH, [{ kind: 'swap', body: wrong }, { kind: 'ok' }])
    const result = await importEnvironmentAsset(operations, { assetId: ASSET_ID, resolution: '1k' }, envDependencies())
    expect(hitsOf(PNG_PATH)).toBe(2)
    expect(result.sourceFiles[2]!.sha256).toBe(createHash('sha256').update(fixture.png).digest('hex'))
    expect(result.budget.downloadBytes).toBe(gltfBytes.length + fixture.bin.length + fixture.png.length + wrong.length)
    expect(result.budget.retries).toBe(1)
  })

  it('坏字节连着来就用满次数抛出：不做无限重试、也不登记资源', async () => {
    const before = await recordCount()
    const wrong = pngOf(4, 3, 99)
    plan.set(PNG_PATH, [{ kind: 'swap', body: wrong }])
    const failure = await failureOf(importEnvironmentAsset(operations, { assetId: ASSET_ID, resolution: '1k' }, envDependencies({ retry: { retries: 1, backoffMs: 5 } })))
    expect(failure).toContain('ENVIRONMENT_ASSET_MD5_MISMATCH')
    expect(hitsOf(PNG_PATH)).toBe(2)
    expect(await recordCount()).toBe(before)
  })
})

describe('公开模型获取：同一个有界恢复与同一份读数', () => {
  it('纹理断流后成功导入，attempts/retries 记下真实请求次数，依赖不重下', async () => {
    plan.set(PNG_PATH, [{ kind: 'cut', keep: 12 }, { kind: 'ok' }])
    // physicalize:false：本用例只验网络恢复与读数，不派生碰撞。夹具会在用例末尾删掉临时工作区，
    // 默认的自动派生是 fire-and-forget，会在删目录之后才落地并打成 console.debug 噪声（派生策略另有其主，不在本任务范围）。
    const result = await acquireAsset(operations, { url: `${DL_HOST}${GLTF_PATH}`, physicalize: false }, assetDependencies())
    expect(result.acquisition.container).toBe('gltf')
    expect(result.acquisition.dependencies.map(fact => fact.uri).sort()).toEqual(['textures/albedo.png', 'wall.bin'])
    expect(hitsOf(PNG_PATH)).toBeGreaterThanOrEqual(2)
    expect(hitsOf(BIN_PATH)).toBe(1)
    // 主文件 1 次 + 两个依赖各 1 次 + 纹理重试 1 次 = 4 次逻辑请求，其中 1 次是重试。
    expect(result.acquisition.budget.networkAttempts).toBe(4)
    expect(result.acquisition.budget.networkRetries).toBe(1)
    const download = gltfBytes.length + fixture.bin.length + fixture.png.length
    expect(result.acquisition.budget.networkBytes).toBeGreaterThanOrEqual(download)
    expect(result.acquisition.budget.networkBytes).toBeLessThanOrEqual(result.acquisition.budget.limitBytes)
  })

  it('关闭重试（retries:0）时同样的断流直接失败：说明重试是这次成功的原因', async () => {
    plan.set(PNG_PATH, [{ kind: 'cut', keep: 12 }])
    const failure = await failureOf(acquireAsset(operations, { url: `${DL_HOST}${GLTF_PATH}` }, assetDependencies({ retry: { retries: 0 } })))
    expect(failure).toContain('ASSET_ACQUISITION_DEPENDENCY_UNAVAILABLE')
    // 不重试时那张纹理没有被完整取回（已取回的 .bin 也不会因为这次失败被重下）。
    expect(hitsOf(BIN_PATH)).toBe(1)
  })

  it('404 依赖是永久失败：不重试，错误里如实列出缺件', async () => {
    plan.set(BIN_PATH, [{ kind: 'status', status: 404 }])
    const failure = await failureOf(acquireAsset(operations, { url: `${DL_HOST}${GLTF_PATH}` }, assetDependencies()))
    expect(failure).toContain('ASSET_ACQUISITION_DEPENDENCY_UNAVAILABLE')
    expect(failure).toContain('wall.bin')
    expect(hitsOf(BIN_PATH)).toBe(1)
  })
})
