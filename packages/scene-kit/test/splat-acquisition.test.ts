/**
 * 3DGS 直链获取（scene_asset_acquire 的 .spz/.ply/.splat 及 .sog 分派）的**真实行为**测试：
 * 真 Cordis 无关、真 SceneOperations/ResourceLibrary（真落盘、真登记、真解析）+ 本机 HTTP 夹具 +
 * 按格式规范手拼的 SPZ/PLY 字节。
 *
 * 覆盖：SPZ 与高斯 PLY 流式落地并登记为 splat（不是 mesh/GLB）、预算用 splatMaxBytes（64 MiB 不是通用上限）、
 * 下载过程中目标文件已在增长（流式证据，不是整份 Buffer 后一次性写）、HTML 伪装（头/体两种）都拒绝且不留件、
 * 中途取消删未完成件、永久 404 只请求一次、302 重定向拒绝、复用命中不联网；.sog 真内容用 streamed-sog-acquisition.test.ts 覆盖。
 * 运行：`bun test packages/scene-kit/test/splat-acquisition.test.ts`
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { acquirePublicAsset, acquireSplatAsset, type AssetAcquisitionDependencies } from '../src/asset-acquisition.ts'
import { SceneOperations } from '../src/operations.ts'
import { splatBounds } from '../src/splat-bounds.ts'
import type { ResourceRecord } from '../src/resources.ts'

const SHA = (bytes: Buffer | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const HOST = 'https://assets.example.org'

/** 规格合法的 SPZ（v3、裸流 NGSP 头 + 24 位定点位置），够 splatBounds 读出真实包围盒。 */
function spzOf(count = 3): Buffer {
  const buf = Buffer.alloc(16 + count * 9)
  buf.writeUInt32LE(0x5053474e, 0)
  buf.writeUInt32LE(3, 4)
  buf.writeUInt32LE(count, 8)
  buf[13] = 12
  for (let i = 0; i < count; i++) {
    const value = i + 1
    const at = 16 + i * 9
    buf[at] = value & 0xff
    buf[at + 1] = (value >> 8) & 0xff
    buf[at + 2] = (value >> 16) & 0xff
  }
  return buf
}

/** 指定 24 位定点坐标（fractionalBits=12）的 SPZ：用于验证流式包围盒跨读取块/gzip 容器的正确性。 */
function spzWithPoints(points: Array<[number, number, number]>): Buffer {
  const buf = Buffer.alloc(16 + points.length * 9)
  buf.writeUInt32LE(0x5053474e, 0)
  buf.writeUInt32LE(3, 4)
  buf.writeUInt32LE(points.length, 8)
  buf[13] = 12
  const scale = 4096
  points.forEach((point, i) => {
    point.forEach((value, axis) => {
      const fixed = Math.round(value * scale)
      const at = 16 + i * 9 + axis * 3
      buf[at] = fixed & 0xff
      buf[at + 1] = (fixed >> 8) & 0xff
      buf[at + 2] = (fixed >> 16) & 0xff
    })
  })
  return buf
}

/** 二进制小端高斯 PLY：含位置与 f_dc_/opacity/scale_/rot_ 属性（parseAsset 认成高斯）。 */
function gaussianPlyOf(count = 3): Buffer {
  const header = ['ply', 'format binary_little_endian 1.0', `element vertex ${count}`,
    'property float x', 'property float y', 'property float z',
    'property float f_dc_0', 'property float opacity', 'property float scale_0', 'property float rot_0',
    'end_header', ''].join('\n')
  const stride = 7 * 4
  const body = Buffer.alloc(count * stride)
  for (let i = 0; i < count; i++) {
    const at = i * stride
    body.writeFloatLE(i, at); body.writeFloatLE(-i, at + 4); body.writeFloatLE(i * 2, at + 8)
    body.writeFloatLE(0.5, at + 12); body.writeFloatLE(0.9, at + 16); body.writeFloatLE(-1, at + 20); body.writeFloatLE(1, at + 24)
  }
  return Buffer.concat([Buffer.from(header, 'latin1'), body])
}

/** 只有 x/y/z 的普通点云 PLY：必须判成非高斯，不能冒充 3DGS。 */
function plainPlyOf(count = 3): Buffer {
  const header = ['ply', 'format binary_little_endian 1.0', `element vertex ${count}`,
    'property float x', 'property float y', 'property float z', 'end_header', ''].join('\n')
  const body = Buffer.alloc(count * 12)
  for (let i = 0; i < count; i++) {
    body.writeFloatLE(i, i * 12); body.writeFloatLE(i, i * 12 + 4); body.writeFloatLE(i, i * 12 + 8)
  }
  return Buffer.concat([Buffer.from(header, 'latin1'), body])
}

type Route = { bytes: Buffer; contentType: string; status?: number; disposition?: string; slow?: { chunks: number; delayMs: number } }
let workspace: string
let operations: SceneOperations
let server: Server
let routes: Map<string, Route>
let served: string[]
let port = 0

const fixtureTransport: AssetAcquisitionDependencies['transport'] = (url, options, listener) => httpRequest({
  method: options.method ?? 'GET', hostname: '127.0.0.1', port, path: url.pathname + url.search, headers: options.headers,
}, listener)
const deps = (overrides: AssetAcquisitionDependencies = {}): AssetAcquisitionDependencies => ({
  resolve: async () => [{ address: '93.184.216.34', family: 4 }], transport: fixtureTransport, ...overrides,
})
const landedFiles = async (root: string): Promise<string[]> => (await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []))
  .filter(entry => entry.isFile()).map(entry => join((entry as { parentPath: string }).parentPath, entry.name))

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'scene-kit-splat-'))
  operations = new SceneOperations(join(workspace, 'data'))
  routes = new Map()
  served = []
  server = createServer((request, response) => {
    response.on('error', () => { /* 客户端取消会打断响应，夹具不因此失败 */ })
    const path = (request.url ?? '').split('?')[0]!
    served.push(path)
    const route = routes.get(path)
    if (!route) { response.writeHead(404, { 'content-type': 'text/plain' }); response.end('not found'); return }
    if (route.status !== undefined) { response.writeHead(route.status, { 'content-type': route.contentType }); response.end(); return }
    if (route.slow) {
      response.writeHead(200, { 'content-type': route.contentType, 'content-length': String(route.bytes.length) })
      const step = Math.max(1, Math.ceil(route.bytes.length / route.slow.chunks))
      let sent = 0
      const push = (): void => {
        if (sent >= route.bytes.length) { response.end(); return }
        response.write(route.bytes.subarray(sent, sent + step))
        sent += step
        setTimeout(push, route.slow!.delayMs)
      }
      push()
      return
    }
    response.writeHead(200, { 'content-type': route.contentType, ...(route.disposition ? { 'content-disposition': route.disposition } : {}), 'content-length': String(route.bytes.length) })
    response.end(route.bytes)
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  port = (server.address() as { port: number }).port
})

afterEach(async () => {
  server.closeAllConnections?.()
  await new Promise<void>(ready => server.close(() => ready()))
  await rm(workspace, { recursive: true, force: true })
})

describe('3DGS 直链：流式落地、内容校验、登记与挂载', () => {
  it('SPZ 直链：按 splatMaxBytes 流式落地（不受 64 MiB 通用上限），登记为 splat 并可挂载', async () => {
    const spz = spzOf(4)
    routes.set('/models/butterfly.spz', { bytes: spz, contentType: 'application/octet-stream' })
    const scene = await operations.create({ sceneId: 'scene_splat' })
    const result = await acquireSplatAsset(operations, {
      url: `${HOST}/models/butterfly.spz`, sceneId: 'scene_splat', splatMaxBytes: 128 * 1024 * 1024, license: 'CC-BY-4.0',
    }, deps())

    expect(result.acquisition.container).toBe('splat')
    expect(result.acquisition.format).toBe('spz')
    expect(result.acquisition.gaussian).toBe(true)
    expect(result.acquisition.bytes).toBe(spz.length)
    expect(result.acquisition.sha256).toBe(SHA(spz))
    // 64 MiB 不是这条路径的硬上限：预算就是调用方给的 128 MiB。
    expect(result.acquisition.budget.limitBytes).toBe(128 * 1024 * 1024)
    expect(SHA(await readFile(result.acquisition.path))).toBe(SHA(spz))
    expect(result.model.format).toBe('spz')
    expect(result.model.gaussian).toBe(true)

    const record: ResourceRecord = await operations.resources.get(result.resource.ref.resourceId)
    expect(record.parsed.kind).toBe('splat')
    expect(record.parsed.mimeType).toBe('application/x-spz')
    expect(record.tags).toContain('许可:CC-BY-4.0')
    expect(record.tags).toContain('来源:assets.example.org')
    expect(result.snapshot?.revision).toBe(scene.revision + 1)
    expect(result.entityId).toBeDefined()
    expect(result.verification.valid).toBe(true)
    expect(served).toEqual(['/models/butterfly.spz'])
  })

  it('高斯 PLY：gaussian=true 且带真实 vertexCount；普通点云 PLY 判 gaussian=false（不互相冒充）', async () => {
    const gaussian = gaussianPlyOf(5)
    routes.set('/models/gaussian.ply', { bytes: gaussian, contentType: 'application/octet-stream' })
    const first = await acquireSplatAsset(operations, { url: `${HOST}/models/gaussian.ply` }, deps())
    expect(first.acquisition.format).toBe('ply')
    expect(first.acquisition.gaussian).toBe(true)
    expect(first.acquisition.vertexCount).toBe(5)
    expect(first.model.gaussian).toBe(true)

    const plain = plainPlyOf(3)
    routes.set('/models/plain.ply', { bytes: plain, contentType: 'application/octet-stream' })
    const second = await acquireSplatAsset(operations, { url: `${HOST}/models/plain.ply` }, deps())
    expect(second.acquisition.format).toBe('ply')
    expect(second.acquisition.gaussian).toBe(false)
    expect(second.model.gaussian).toBe(false)
    // 两份内容不同 → 两条记录。
    expect((await operations.resources.authoritySnapshot()).records).toHaveLength(2)
  })

  it('HTML 伪装成模型：text/html 头直接在头部拒绝；octet-stream 的 HTML 体也按字节拒绝，且不留件不登记', async () => {
    routes.set('/fake/header.spz', { bytes: Buffer.from('<html><body>login</body></html>'), contentType: 'text/html; charset=utf-8' })
    await expect(acquireSplatAsset(operations, { url: `${HOST}/fake/header.spz` }, deps())).rejects.toThrow(/NETWORK_ASSET_MIME_REJECTED/)

    routes.set('/fake/body.ply', { bytes: Buffer.from('<!doctype html><html>error page</html>'), contentType: 'application/octet-stream' })
    await expect(acquireSplatAsset(operations, { url: `${HOST}/fake/body.ply` }, deps())).rejects.toThrow(/ASSET_ACQUISITION_MIME_REJECTED/)
    // 内容永久错误不重试：体校验失败就该一次结束。
    expect(served.filter(path => path === '/fake/body.ply')).toHaveLength(1)

    expect((await operations.resources.authoritySnapshot()).records).toHaveLength(0)
    expect(await landedFiles(join(workspace, 'data'))).toEqual([])
  })

  it('扩展名与真实内容不一致：.ply 里装 SPZ 明确报 mismatch，不将错就错也不重试', async () => {
    routes.set('/models/mislabeled.ply', { bytes: spzOf(2), contentType: 'application/octet-stream' })
    await expect(acquireSplatAsset(operations, { url: `${HOST}/models/mislabeled.ply` }, deps())).rejects.toThrow(/ASSET_ACQUISITION_SPLAT_FORMAT_MISMATCH/)
    expect(served.filter(path => path === '/models/mislabeled.ply')).toHaveLength(1)
    expect((await operations.resources.authoritySnapshot()).records).toHaveLength(0)
  })

  it('无扩展名带 query 的直链 + formatHint:ply 走 3DGS 流式路径（不落旧 64 MiB GLB 入口）', async () => {
    const ply = gaussianPlyOf(4)
    routes.set('/download', { bytes: ply, contentType: 'application/octet-stream' })
    const result = await acquirePublicAsset(operations, { url: `${HOST}/download?id=abc123`, formatHint: 'ply', splatMaxBytes: 128 * 1024 * 1024 }, deps())
    const splat = result as { acquisition: { container: string; format: string; budget: { limitBytes: number } } }
    expect(splat.acquisition.container).toBe('splat')
    expect(splat.acquisition.format).toBe('ply')
    // 预算走 splatMaxBytes，证明没有落进 GLB 的 64 MiB 硬上限。
    expect(splat.acquisition.budget.limitBytes).toBe(128 * 1024 * 1024)
    expect(served).toEqual(['/download'])
  })

  it('formatHint 不能替代内容校验：无扩展名地址返回 HTML 仍被按字节拒绝且只请求一次', async () => {
    routes.set('/download', { bytes: Buffer.from('<!doctype html><html>login page</html>'), contentType: 'application/octet-stream' })
    await expect(acquirePublicAsset(operations, { url: `${HOST}/download?id=abc123`, formatHint: 'spz' }, deps())).rejects.toThrow(/ASSET_ACQUISITION_MIME_REJECTED/)
    expect(served.filter(path => path === '/download')).toHaveLength(1)
    expect((await operations.resources.authoritySnapshot()).records).toHaveLength(0)
  })

  it('无扩展名直链可从可信 Content-Disposition 的 filename 得到格式提示（字节校验仍是最终判据）', async () => {
    routes.set('/download-cd', { bytes: spzOf(3), contentType: 'application/octet-stream', disposition: 'attachment; filename="capture.spz"' })
    const result = await acquireSplatAsset(operations, { url: `${HOST}/download-cd` }, deps())
    expect(result.acquisition.format).toBe('spz')
    expect(result.acquisition.path.endsWith('asset.spz')).toBe(true)
    expect(result.verification.valid).toBe(true)
  })

  it('非法 formatHint 明确报错，不静默退回 GLB 入口', async () => {
    await expect(acquirePublicAsset(operations, { url: `${HOST}/download?id=x`, formatHint: 'rad' as never }, deps())).rejects.toThrow(/ASSET_ACQUISITION_FORMAT_HINT_INVALID/)
  })

  it('下载过程中目标文件已在增长（流式落盘证据，不是整份 Buffer 后一次写）', async () => {
    const spz = spzOf(512)
    routes.set('/slow/stream.spz', { bytes: spz, contentType: 'application/octet-stream', slow: { chunks: 16, delayMs: 25 } })
    const work = acquireSplatAsset(operations, { url: `${HOST}/slow/stream.spz` }, deps())
    let sawPartial = false
    for (let attempt = 0; attempt < 40 && !sawPartial; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      const files = (await landedFiles(operations.resources.downloadRoot)).filter(path => path.endsWith('.part'))
      for (const path of files) { const size = await stat(path).then(info => info.size, () => 0); if (size > 0) sawPartial = true }
    }
    const result = await work
    expect(sawPartial).toBe(true)
    expect(SHA(await readFile(result.acquisition.path))).toBe(SHA(spz))
  })

  it('中途取消：停止下载、清掉未完成临时件、不登记资源', async () => {
    routes.set('/slow/cancel.spz', { bytes: spzOf(2048), contentType: 'application/octet-stream', slow: { chunks: 200, delayMs: 20 } })
    const controller = new AbortController()
    const stop = new Error('用户停止了本次获取'); stop.name = 'AbortError'
    const work = acquireSplatAsset(operations, { url: `${HOST}/slow/cancel.spz` }, deps({ signal: controller.signal }))
    setTimeout(() => controller.abort(stop), 60)
    let thrown: unknown
    try { await work } catch (error) { thrown = error }
    expect(thrown).toBe(stop)
    expect((await operations.resources.authoritySnapshot()).records).toHaveLength(0)
    expect(await landedFiles(join(workspace, 'data'))).toEqual([])
  })

  it('永久失败不重试：404 只请求一次；302 重定向按既有安全语义拒绝', async () => {
    routes.set('/missing.ply', { bytes: Buffer.alloc(0), contentType: 'text/plain', status: 404 })
    await expect(acquireSplatAsset(operations, { url: `${HOST}/missing.ply` }, deps())).rejects.toThrow(/NETWORK_ASSET_HTTP_404/)
    expect(served).toEqual(['/missing.ply'])

    served = []
    routes.set('/redirected.spz', { bytes: Buffer.alloc(0), contentType: 'text/plain', status: 302 })
    await expect(acquireSplatAsset(operations, { url: `${HOST}/redirected.spz` }, deps())).rejects.toThrow(/NETWORK_ASSET_REDIRECT_REJECTED/)
    expect(served).toEqual(['/redirected.spz'])
    expect((await operations.resources.authoritySnapshot()).records).toHaveLength(0)
  })

  it('同 URL 二次获取复用已登记原件：传输直接抛错也成功，且如实标注没有访问远端', async () => {
    const spz = spzOf(3)
    routes.set('/models/reuse.spz', { bytes: spz, contentType: 'application/octet-stream' })
    const first = await acquireSplatAsset(operations, { url: `${HOST}/models/reuse.spz` }, deps())
    const second = await acquireSplatAsset(operations, { url: `${HOST}/models/reuse.spz` }, deps({ transport: () => { throw new Error('复用不该联网') } }))
    expect(second.acquisition.download.requested).toBe(false)
    expect(second.acquisition.download.reusedFromCache).toBe(true)
    expect(second.acquisition.sha256).toBe(first.acquisition.sha256)
    expect(second.warnings.join('\n')).toContain('复用命中')
    expect(served).toEqual(['/models/reuse.spz'])
  })

  it('预算超限按 NETWORK_ASSET_SIZE_LIMIT 停：splatMaxBytes 可收紧', async () => {
    routes.set('/models/big.spz', { bytes: spzOf(64), contentType: 'application/octet-stream' })
    await expect(acquireSplatAsset(operations, { url: `${HOST}/models/big.spz`, splatMaxBytes: 16 }, deps())).rejects.toThrow(/NETWORK_ASSET_SIZE_LIMIT/)
  })

  it('本地 .ply 入口：按内容判高斯并登记（原件不被改写）', async () => {
    const path = join(workspace, 'local.ply')
    const ply = gaussianPlyOf(2)
    await writeFile(path, ply)
    const result = await acquireSplatAsset(operations, { path, license: 'CC0-1.0' }, deps())
    expect(result.acquisition.container).toBe('splat')
    expect(result.acquisition.format).toBe('ply')
    expect(result.acquisition.path).toBe(path)
    // 用户原件一个字节都不改；库按既有规则把内容收进 CAS（original 指向那份副本）。
    expect(SHA(await readFile(path))).toBe(SHA(ply))
    expect(result.resource.ref.original.uri).toContain('local.ply')
    expect(SHA(await readFile(new URL(result.resource.ref.original.uri)))).toBe(SHA(ply))
    expect(result.verification.valid).toBe(true)
  })
})

describe('统一入口的分发与不适用格式', () => {
  it('acquirePublicAsset 把 .spz 送到 3DGS 路径；.sog 已接直链路径，缺源则给真实 404', async () => {
    routes.set('/models/direct.spz', { bytes: spzOf(2), contentType: 'application/octet-stream' })
    const splat = await acquirePublicAsset(operations, { url: `${HOST}/models/direct.spz` }, deps())
    expect((splat as { acquisition: { container: string } }).acquisition.container).toBe('splat')

    await expect(acquirePublicAsset(operations, { url: `${HOST}/models/scene.sog` }, deps())).rejects.toThrow(/NETWORK_ASSET_HTTP_404/)
  })
})

describe('SPZ 包围盒：流式读取（不整份 readFile/gunzipSync）', () => {
  it('跨多个读取块的裸流 SPZ 给出正确 min/max；gzip 容器同样流式解出；截断件返回 undefined', async () => {
    // 200k 点 × 9 字节 ≈ 1.8 MB，必然跨越多个读取块（默认 64 KiB），验证跨 chunk 边界累积。
    const count = 200_000
    const points: Array<[number, number, number]> = Array.from({ length: count }, (_, i) => [i % 100 - 50, Math.floor(i / 100) % 40 - 20, i % 7 - 3])
    const spz = spzWithPoints(points)

    const rawPath = join(workspace, 'bounds-raw.spz')
    await writeFile(rawPath, spz)
    const raw = await splatBounds(rawPath, '.spz')
    expect(raw).toEqual({ min: [-50, -20, -3], max: [49, 19, 3] })

    const gzPath = join(workspace, 'bounds-gzip.spz')
    await writeFile(gzPath, gzipSync(spz))
    expect(await splatBounds(gzPath, '.spz')).toEqual(raw)

    // 头声明 200k 点但体被截断：宁可 undefined，也不猜一个错包围盒。
    const truncated = join(workspace, 'bounds-truncated.spz')
    await writeFile(truncated, spz.subarray(0, 16 + 9 * 3))
    expect(await splatBounds(truncated, '.spz')).toBeUndefined()
  })
})
