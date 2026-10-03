/**
 * reference_image_fetch 的真实行为测试：真 Cordis Context + 真 ToolRuntime + 真附件服务
 * （`@deepseek-ai/dsh-attachment-local`，sharp 真实解码）+ 本机 HTTP 夹具服务器
 * （传输钩子注入口径，与 network-assets 的既有注入点相同）。
 *
 * 覆盖：工具真实注册、合法图片取得并进入工具 ContentBlock、来源页与图片 URL 分开、
 * 原图按 sha256 落盘与重复取回复用、体积上限、网页/404/重定向等错误内容、取消、
 * 未挂载附件服务、以及缩略图信号。夹具服务器是**合成夹具**：它证明工具行为，不替代"真实公网抓图"，
 * 真实公网只跑 REFERENCE_IMAGE_LIVE_URL 指定的少量小图（见文件末尾）。
 * 运行：`bun test packages/scene-kit/test/reference-image-fetch.test.ts`
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { registerReferenceImageTools, REFERENCE_IMAGE_HARD_MAX_BYTES, type ReferenceImageDependencies } from '../src/reference-tools.ts'

/** 一枚真实可解码的 PNG（自己按 PNG 容器规范拼装，不依赖任何图片库）——sharp 解码通过才算合法。 */
function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const byte of bytes) { c ^= byte; for (let bit = 0; bit < 8; bit++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1) }
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}
function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3)
    raw[row] = 0
    for (let x = 0; x < width; x++) { const pixel = row + 1 + x * 3; raw[pixel] = x % 256; raw[pixel + 1] = y % 256; raw[pixel + 2] = 128 }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}

const SHA = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const IMAGE_HOST = 'https://images.example.org'

let server: Server
let fixture: (request: IncomingMessage, response: ServerResponse) => void
let port = 0
let workspace: string
let context: Context | undefined
let callCounter = 0

const body = (response: ServerResponse, bytes: Buffer, contentType = 'image/png'): void => {
  response.writeHead(200, { 'content-type': contentType, 'content-length': String(bytes.length) })
  response.end(bytes)
}

async function mount(overrides: Partial<ReferenceImageDependencies> = {}, withAttachments = true): Promise<{ ctx: Context; downloadRoot: string; call: (input: unknown, signal?: AbortSignal) => Promise<ToolExecutionResult> }> {
  const ctx = new Context()
  // ToolRuntime 声明 inject: ["systemPrompt"]，缺 SystemPrompt 时工具注册表根本不会出现（与上游测试同一装配）。
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (withAttachments) await ctx.plugin(LocalAttachmentStore, { dshHome: join(workspace, 'dsh-home') })
  const downloadRoot = join(workspace, withAttachments ? 'download' : 'download-no-attachments')
  registerReferenceImageTools(ctx, {
    // 夹具固定一份下载域；会话解析由 scene-kit 的会话隔离测试覆盖。
    downloadRootFor: () => downloadRoot,
    dependencies: {
      // 解析器按公网地址口径注入（SSRF 预检用得到），真实连接由本机夹具传输完成。
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: (url, options, listener) => httpRequest({
        method: options.method ?? 'GET',
        hostname: '127.0.0.1',
        port,
        path: url.pathname + url.search,
        headers: options.headers,
      }, listener),
      now: () => new Date('2026-09-20T00:00:00.000Z'),
      newId: () => `fixed-${++callCounter}`,
      ...overrides,
    },
  })
  context = ctx
  return {
    ctx,
    downloadRoot,
    call: (input, signal) => ctx.tools.execute({
      signal: signal ?? new AbortController().signal,
      callId: ToolCallId(`call-${++callCounter}`),
      name: 'reference_image_fetch',
      arguments: { input },
    }),
  }
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'scene-kit-reference-'))
  fixture = (_request, response) => body(response, makePng(320, 200))
  server = createServer((request, response) => {
    response.on('error', () => { /* 客户端取消会打断响应，夹具不因此失败 */ })
    fixture(request, response)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  server.closeAllConnections?.()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(workspace, { recursive: true, force: true })
})

const textOf = (result: ToolExecutionResult): string => result.content.map(block => block.type === 'text' ? (block as { text: string }).text : '').join('\n')
const metadata = (result: ToolExecutionResult): any => JSON.parse(textOf(result))
const imageBlocks = (result: ToolExecutionResult): any[] => result.content.filter(block => block.type === 'image')
/** 落盘清单只看文件（bun 的 recursive readdir 会把子目录本身也算一条）。 */
const landedFiles = async (downloadRoot: string): Promise<string[]> => (await readdir(join(downloadRoot, 'reference'), { recursive: true, withFileTypes: true }).catch(() => []))
  .filter(entry => entry.isFile())
  .map(entry => join((entry as { parentPath: string }).parentPath, entry.name))

describe('reference_image_fetch 注册与成功路径', () => {
  it('工具在真实 ToolRuntime 上注册，返回真实图像附件 + 分开的来源元数据 + 按 sha256 落盘的原图', async () => {
    // 640x480：URL 无缩略图形态、实测尺寸也不小，thumbnailSignals 必须是空的（否则信号就是在乱报）。
    const png = makePng(640, 480)
    fixture = (_request, response) => body(response, png)
    const { ctx, downloadRoot, call } = await mount()
    expect(ctx.tools.get('reference_image_fetch')).toBeDefined()

    const url = `${IMAGE_HOST}/files/cathedral-facade.png`
    const result = await call({ url, sourcePage: 'https://example.org/church/history', object: '某教堂正立面', viewpoint: '正立面' })
    expect(result.isError).toBe(false)

    const value = metadata(result)
    expect(value.image.url).toBe(url)
    expect(value.image.sha256).toBe(SHA(png))
    expect(value.image.byteLength).toBe(png.length)
    expect(value.image.mediaType).toBe('image/png')
    expect(value.image.width).toBe(640)
    expect(value.image.height).toBe(480)
    // 来源页与图片 URL 是两个字段，且各自仍是完整 URL。
    expect(value.source.page).toBe('https://example.org/church/history')
    expect(value.source.page).not.toBe(value.image.url)
    expect(value.source.sameOriginAsSourcePage).toBe(false)
    expect(value.annotations).toEqual({ object: '某教堂正立面', viewpoint: '正立面' })
    expect(value.thumbnailSignals).toEqual([])
    expect(value.redirectsFollowed).toBe(0)
    expect(value.credentialsUsed).toBe(false)

    // 图片真的进了工具内容块，且是附件服务里那张（字节与来源一致）。
    const images = imageBlocks(result)
    expect(images).toHaveLength(1)
    expect(images[0].attachment.attachmentId).toBe(value.attachment.attachmentId)
    expect(images[0].attachment.mediaType).toBe('image/png')
    expect(images[0].attachment.width).toBe(640)
    expect(images[0].attachment.bytes).toBe(png.length)
    expect(value.attachment.normalized).toBe(false)

    // 原图字节按 sha256 命名落盘，内容逐字节相同；来源记录里图片 URL 与来源页分开、不含凭据字段。
    expect(value.original.saved).toBe(true)
    expect(value.original.reusedExistingOriginal).toBe(false)
    expect(value.original.path).toContain(SHA(png))
    expect(SHA(await readFile(value.original.path))).toBe(SHA(png))
    const record = JSON.parse(await readFile(value.original.recordPath, 'utf8'))
    expect(record.imageUrl).toBe(url)
    expect(record.sourcePage).toBe('https://example.org/church/history')
    expect(record.sha256).toBe(SHA(png))
    expect(record.object).toBe('某教堂正立面')
    // 来源记录只写 URL/来源页/字节事实：没有任何请求头、cookie、token 或口令字段。
    expect(record.credentialsUsed).toBe(false)
    expect(JSON.stringify(record)).not.toMatch(/authorization|cookie|token|secret|password/i)
    expect(await landedFiles(downloadRoot)).toHaveLength(2)
  })

  it('同一原图重复取回：复用同一内容寻址文件，仍各自留一份来源记录', async () => {
    const png = makePng(320, 200)
    fixture = (_request, response) => body(response, png)
    const { downloadRoot, call } = await mount()
    const first = metadata(await call({ url: `${IMAGE_HOST}/a/photo.png`, sourcePage: 'https://example.org/one' }))
    const second = metadata(await call({ url: `${IMAGE_HOST}/a/photo.png`, sourcePage: 'https://example.org/two' }))
    expect(second.original.path).toBe(first.original.path)
    expect(second.original.reusedExistingOriginal).toBe(true)
    expect(second.attachment.attachmentId).toBe(first.attachment.attachmentId)
    expect(second.original.recordPath).not.toBe(first.original.recordPath)
    const records = (await readdir(join(downloadRoot, 'reference', 'records'))).sort()
    expect(records).toHaveLength(2)
    const pages = await Promise.all(records.map(async name => JSON.parse(await readFile(join(downloadRoot, 'reference', 'records', name), 'utf8')).sourcePage))
    expect(pages.sort()).toEqual(['https://example.org/one', 'https://example.org/two'])
  })

  it('缩略图形态的直链给出信号，且元数据不把任何图片宣告为原图', async () => {
    fixture = (_request, response) => body(response, makePng(150, 150))
    const { call } = await mount()
    const value = metadata(await call({ url: `${IMAGE_HOST}/thumbs/photo-150x150.png?w=150` }))
    expect(value.thumbnailSignals.map((signal: { code: string }) => signal.code)).toEqual(['filename-size-token', 'thumbnail-path-token', 'resize-query-param', 'measured-small'])
    expect(value.signalsNote).toContain('不是结论')
    expect(value.original.saved).toBe(true)
  })

  it('saveOriginal=false 时不落盘，只返回附件与元数据', async () => {
    const { downloadRoot, call } = await mount()
    const value = metadata(await call({ url: `${IMAGE_HOST}/files/photo.png`, saveOriginal: false }))
    expect(value.original.saved).toBe(false)
    expect(value.original.reason).toContain('saveOriginal=false')
    await expect(stat(join(downloadRoot, 'reference'))).rejects.toThrow()
  })
})

describe('reference_image_fetch 失败路径', () => {
  it('网页 URL（text/html）给出可采取的错误，且不落盘', async () => {
    fixture = (_request, response) => body(response, Buffer.from('<html>page</html>'), 'text/html; charset=utf-8')
    const { downloadRoot, call } = await mount()
    const result = await call({ url: `${IMAGE_HOST}/page.html` })
    expect(result.isError).toBe(true)
    expect((result as any).error.message).toContain('REFERENCE_IMAGE_NOT_AN_IMAGE_LINK')
    expect(textOf(result)).toContain('web_fetch')
    expect(textOf(result)).toContain('可采取的动作')
    expect(await landedFiles(downloadRoot)).toEqual([])
  })

  it('Content-Type 声明图片但字节不是：如实拒绝', async () => {
    fixture = (_request, response) => body(response, Buffer.from('<html>fake</html>'), 'image/png')
    const { call } = await mount()
    const result = await call({ url: `${IMAGE_HOST}/fake.png` })
    expect(result.isError).toBe(true)
    expect((result as any).error.message).toContain('REFERENCE_IMAGE_BYTES_NOT_IMAGE')
  })

  it('HTTP 404 说明直链失效并让人回来源页，而不是拿别的东西顶替', async () => {
    fixture = (_request, response) => { response.writeHead(404, { 'content-type': 'text/plain' }); response.end('missing') }
    const { call } = await mount()
    const result = await call({ url: `${IMAGE_HOST}/gone.png` })
    expect(result.isError).toBe(true)
    expect((result as any).error.message).toContain('NETWORK_ASSET_HTTP_404')
    expect((result as any).error.message).toContain('来源页')
  })

  it('重定向被拒绝，并给出"取最终直链再调用"的动作', async () => {
    fixture = (_request, response) => { response.writeHead(302, { location: `${IMAGE_HOST}/real.png` }); response.end() }
    const { call } = await mount()
    const result = await call({ url: `${IMAGE_HOST}/moved.png` })
    expect(result.isError).toBe(true)
    expect((result as any).error.message).toContain('NETWORK_ASSET_REDIRECT_REJECTED')
    expect((result as any).error.message).toContain('再调用一次')
  })

  it('超过体积上限：错误里带生效上限与调 maxBytes 的动作；请求超过硬上限时被夹紧', async () => {
    fixture = (_request, response) => {
      const png = makePng(320, 200)
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) })
      response.end(png)
    }
    const { call } = await mount()
    const tooSmall = await call({ url: `${IMAGE_HOST}/files/photo.png`, maxBytes: 128 })
    expect(tooSmall.isError).toBe(true)
    expect((tooSmall as any).error.message).toContain('NETWORK_ASSET_SIZE_LIMIT')
    expect((tooSmall as any).error.message).toContain('128')
    expect((tooSmall as any).error.message).toContain('maxBytes')

    const clamped = metadata(await call({ url: `${IMAGE_HOST}/files/photo.png`, maxBytes: 8 * 1024 * 1024 * 1024 }))
    expect(clamped.limits.effectiveMaxBytes).toBe(REFERENCE_IMAGE_HARD_MAX_BYTES)
    expect(clamped.limits.clamped).toBe(true)
  })

  it('最大体积上限受附件服务图片上限约束（20 MiB 默认值内）', async () => {
    const { call } = await mount()
    const value = metadata(await call({ url: `${IMAGE_HOST}/files/photo.png`, maxBytes: REFERENCE_IMAGE_HARD_MAX_BYTES }))
    expect(value.limits.attachmentImageMaxBytes).toBe(20 * 1024 * 1024)
    expect(value.limits.effectiveMaxBytes).toBe(REFERENCE_IMAGE_HARD_MAX_BYTES)
    expect(value.limits.clamped).toBe(false)
  })

  it('非 https、内网地址、带凭据的 URL 都在发请求前被拒', async () => {
    const { call } = await mount()
    const http = await call({ url: 'http://images.example.org/a.png' })
    expect(http.isError).toBe(true)
    expect((http as any).error.message).toContain('NETWORK_URL_MUST_USE_HTTPS')
    const privateAddress = await call({ url: 'https://127.0.0.1/a.png' })
    expect((privateAddress as any).error.message).toContain('NETWORK_URL_PRIVATE_ADDRESS')
    const credentials = await call({ url: 'https://user:secret@images.example.org/a.png' })
    expect((credentials as any).error.message).toContain('NETWORK_URL_MUST_NOT_INCLUDE_CREDENTIALS')
    const badSource = await call({ url: `${IMAGE_HOST}/a.png`, sourcePage: 'http://example.org/page' })
    expect((badSource as any).error.message).toContain('REFERENCE_IMAGE_SOURCE_PAGE_INVALID')
    expect(await landedFiles(join(workspace, 'download'))).toEqual([])
  })

  it('传输停顿超时给出可采取的原因（缩短的等待预算，不依赖真实 30 秒）', async () => {
    fixture = (_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': '1048576' })
      response.write(makePng(320, 200).subarray(0, 64))
    }
    const { call } = await mount({ timeouts: { stallMs: 150, totalMs: 5000 } })
    const result = await call({ url: `${IMAGE_HOST}/slow.png` })
    expect(result.isError).toBe(true)
    expect((result as any).error.message).toContain('NETWORK_ASSET_TIMEOUT')
    expect((result as any).error.message).toContain('可采取的动作')
  })

  it('未挂载附件服务时明确报错，不假装取回了图片', async () => {
    const { call } = await mount({}, false)
    const result = await call({ url: `${IMAGE_HOST}/files/photo.png` })
    expect(result.isError).toBe(true)
    expect((result as any).error.message).toContain('REFERENCE_IMAGE_ATTACHMENTS_UNAVAILABLE')
  })
})

describe('reference_image_fetch 取消', () => {
  it('执行前已取消：不发起请求、不落盘', async () => {
    let requests = 0
    fixture = (_request, response) => { requests++; body(response, makePng(320, 200)) }
    const { downloadRoot, call } = await mount()
    const controller = new AbortController()
    controller.abort()
    const result = await call({ url: `${IMAGE_HOST}/files/photo.png` }, controller.signal)
    expect(result.isError).toBe(true)
    expect(['ABORTED', 'ABORTED_BEFORE_DISPATCH']).toContain((result as any).error.info?.code)
    expect(imageBlocks(result)).toHaveLength(0)
    expect(requests).toBe(0)
    expect(await landedFiles(downloadRoot)).toEqual([])
  })

  it('取回途中取消：立即结束、不落盘、不提交附件', async () => {
    let firstChunk: () => void = () => undefined
    const chunkArrived = new Promise<void>(resolve => { firstChunk = resolve })
    fixture = (_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': '1048576' })
      response.write(makePng(320, 200).subarray(0, 256))
      firstChunk()
    }
    const { downloadRoot, call } = await mount()
    const controller = new AbortController()
    const pending = call({ url: `${IMAGE_HOST}/slow.png` }, controller.signal)
    await chunkArrived
    controller.abort(new Error('用户取消参考图取回'))
    const result = await pending
    expect(result.isError).toBe(true)
    // 取消走注册表自己的收尾：机器码 ABORTED，而不是被当成"取图失败"或"成功但没图"。
    expect((result as any).error.info).toEqual({ name: 'AbortError', code: 'ABORTED' })
    expect((result as any).error.message).not.toContain('REFERENCE_IMAGE_FETCH_FAILED')
    // 取消结果里既没有图片块，也没有把取消说成取到了图。
    expect(imageBlocks(result)).toHaveLength(0)
    expect(textOf(result)).not.toContain('"ok":true')
    expect(await landedFiles(downloadRoot)).toEqual([])
  })
})

/**
 * 真实公网小图：默认跳过，只有显式给出 REFERENCE_IMAGE_LIVE_URL 时才跑（不批量抓站）。
 * 例：REFERENCE_IMAGE_LIVE_URL=https://www.python.org/static/img/python-logo.png bun test …
 */
const liveUrl = process.env.REFERENCE_IMAGE_LIVE_URL
const liveTest = liveUrl ? it : it.skip
liveTest('真实公网取回一张小图（真 DNS + 真 https 传输 + 真附件解码）', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalAttachmentStore, { dshHome: join(workspace, 'live-home') })
  const downloadRoot = join(workspace, 'live-download')
  registerReferenceImageTools(ctx, { downloadRootFor: () => downloadRoot })
  context = ctx
  const result = await ctx.tools.execute({
    signal: AbortSignal.timeout(60_000),
    callId: ToolCallId('live-call'),
    name: 'reference_image_fetch',
    arguments: { input: { url: liveUrl, sourcePage: 'https://www.python.org/', object: '公开小图（真实下载验证）' } },
  })
  expect(result.isError).toBe(false)
  const value = metadata(result)
  expect(value.image.sha256).toHaveLength(64)
  expect(value.image.width).toBeGreaterThan(0)
  expect(imageBlocks(result)).toHaveLength(1)
  expect(value.original.saved).toBe(true)
  expect(SHA(await readFile(value.original.path))).toBe(value.image.sha256)
  console.log('[live]', JSON.stringify({ url: value.image.url, mediaType: value.image.mediaType, bytes: value.image.byteLength, width: value.image.width, height: value.image.height, sha256: value.image.sha256, attachmentId: value.attachment.attachmentId, originalPath: value.original.path }))
}, 120_000)
