/**
 * 分享页解析（scene_asset_resolve / acquirePublicAsset 的前置）的**真实行为**测试：
 * 本机 HTTP 夹具按 SuperSplat 的真实页面形状提供 HTML/JSON（页面自带的结构化元数据、viewer 的 sse-bootstrap、
 * 公开 LOD 清单），断言解析出的**事实**与"不能导入"的结论，而不是源码字符串存在性。
 *
 * 覆盖：SuperSplat 分享页 → unsupported（format/lodLevels/counts/contentUrl/license/author 都来自公开元数据）；
 * contentUrl 是 .ply/.spz/.splat 时 → direct；非分享页 → undefined；清单返回 HTML 明确报错；
 * 302/404 保持既有安全与永久失败语义；acquirePublicAsset 对不适用分享页给结构化事实而非假装导入。
 * 运行：`bun test packages/scene-kit/test/share-pages.test.ts`
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import Commands from '@deepseek-ai/dsh-commands'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { gzipSync } from 'node:zlib'
import { acquirePublicAsset, registerAssetAcquisitionTools, type AssetAcquisitionDependencies } from '../src/asset-acquisition.ts'
import { resolveAssetSharePage, sharePageTargetOf, type SharePageDependencies } from '../src/share-pages.ts'
import { SceneOperations } from '../src/operations.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HASH = '3eecfd55'
const SOURCE = `https://superspl.at/scene/${HASH}`
const VIEWER = `https://superspl.at/s?id=${HASH}`
const CDN = 'https://cdn.example.org'
const CONTENT = `${CDN}/${HASH}/v1/lod-meta.json`

/** 与真实页面同形状的分享页：og 标题/许可链接 + turbo-stream 里的自报事实。 */
const sceneHtml = `<!doctype html><html><head>
<meta property="og:title" content="Trompetstraat - Delft - SuperSplat"/>
<meta property="og:image" content="https://s3.example.org/${HASH}/v1/xl.webp"/>
<link rel="license" href="https://creativecommons.org/licenses/by-sa/4.0/"/>
</head><body><script>window.__data = "\\"format\\",\\"ssog\\",\\"size\\",371246311,\\"lodCounts\\",[9993739,4996870,2498435,1249218,624609],\\"username\\",\\"roelof\\",\\"fullName\\",\\"Rolf\\",\\"downloadCount\\",35"</script></body></html>`

const viewerHtml = `<!doctype html><html><body>
<script type="application/json" id="sse-bootstrap">{"settings":{"version":2},"contentUrl":"${CONTENT}","posterUrl":"https://s3.example.org/${HASH}/v1/xl.webp","collisionUrl":"https://s3.example.org/${HASH}/v1/scene.voxel.json"}</script>
</body></html>`

const lodMeta = JSON.stringify({
  version: 1,
  asset: { generator: 'splat-transform v3.4.2', chunkGaussians: 524288, chunkExtent: 16, chunkMinGaussians: 8192 },
  count: 19362871, counts: [9993739, 4996870, 2498435, 1249218, 624609], lodLevels: 5, lodErrors: false,
  filenames: ['0_0/meta.json', '1_0/meta.json', '2_0/meta.json', '3_0/meta.json', '4_0/meta.json'],
  tree: { bound: { min: [-101.7, -396.0, -733.9], max: [210.2, 29.3, 686.4] }, children: [] },
})

let server: Server
let routes: Map<string, { status: number; contentType: string; body: string; gzip?: boolean }>
let served: string[]
let port = 0

const transport: SharePageDependencies['transport'] = (url, options, listener) => httpRequest({
  method: options.method ?? 'GET', hostname: '127.0.0.1', port, path: url.pathname + url.search, headers: options.headers,
}, listener)
const deps = (overrides: SharePageDependencies = {}): SharePageDependencies => ({
  resolve: async () => [{ address: '93.184.216.34', family: 4 }], transport, ...overrides,
})

beforeEach(async () => {
  routes = new Map()
  served = []
  routes.set(`/scene/${HASH}`, { status: 200, contentType: 'text/html; charset=utf-8', body: sceneHtml })
  routes.set('/s', { status: 200, contentType: 'text/html; charset=utf-8', body: viewerHtml })
  routes.set(`/${HASH}/v1/lod-meta.json`, { status: 200, contentType: 'application/json', body: lodMeta })
  server = createServer((request, response) => {
    response.on('error', () => { /* 取消/重定向时客户端可能打断响应 */ })
    const path = (request.url ?? '').split('?')[0]!
    served.push(path)
    const route = routes.get(path)
    if (!route) { response.writeHead(404, { 'content-type': 'text/plain' }); response.end('not found'); return }
    const payload = route.gzip ? gzipSync(Buffer.from(route.body)) : Buffer.from(route.body)
    response.writeHead(route.status, { 'content-type': route.contentType, ...(route.gzip ? { 'content-encoding': 'gzip' } : {}), 'content-length': String(payload.length) })
    response.end(payload)
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  port = (server.address() as { port: number }).port
})

afterEach(async () => {
  server.closeAllConnections?.()
  await new Promise<void>(ready => server.close(() => ready()))
})

describe('SuperSplat 分享页：只按公开元数据解析', () => {
  it('识别 /scene/<id> 与 /s?id=<id>，其它主机不认', () => {
    expect(sharePageTargetOf(SOURCE)).toEqual({ provider: 'supersplat', hash: HASH })
    expect(sharePageTargetOf(VIEWER)).toEqual({ provider: 'supersplat', hash: HASH })
    expect(sharePageTargetOf('https://example.org/model.glb')).toBeUndefined()
    expect(sharePageTargetOf('http://superspl.at/scene/x')).toBeUndefined()
  })

  it('LOD 多文件表示返回 unsupported：事实来自页面/viewer/公开清单，动作可执行', async () => {
    const resolution = await resolveAssetSharePage(SOURCE, deps())
    expect(resolution?.kind).toBe('unsupported')
    if (resolution?.kind !== 'unsupported') throw new Error('unreachable')
    expect(resolution.provider).toBe('supersplat')
    expect(resolution.facts.title).toBe('Trompetstraat - Delft')
    expect(resolution.facts.license).toBe('CC-BY-SA-4.0')
    expect(resolution.facts.author).toBe('Rolf (roelof)')
    expect(resolution.facts.format).toBe('ssog')
    expect(resolution.facts.byteLength).toBe(371246311)
    expect(resolution.facts.contentUrl).toBe(CONTENT)
    expect(resolution.facts.lodLevels).toBe(5)
    expect(resolution.facts.lodCounts).toEqual([9993739, 4996870, 2498435, 1249218, 624609])
    expect(resolution.facts.lodChunkFiles).toBe(5)
    expect(resolution.facts.bounds?.min).toEqual([-101.7, -396.0, -733.9])
    // 结论必须点名"多文件 LOD / 不能当模型"，并给出直链/本地导入的可采取动作。
    expect(resolution.reason).toContain('LOD')
    expect(resolution.reason).toContain('9993739')
    expect(resolution.actions.join(' ')).toContain('.ply')
    expect(resolution.actions.join(' ')).toContain('scene_import')
    // 三态区分：只完成解析，没有取得资源、没有导入；且不使用/绕过账号鉴权。
    expect(resolution.resolved).toBe(true)
    expect(resolution.acquirable).toBe(false)
    expect(resolution.imported).toBe(false)
    expect(resolution.warnings.join(' ')).toContain('账号鉴权')
    // 只读了分享页、viewer、公开清单三个公开地址，没有访问任何账号端点。
    expect(served).toEqual([`/scene/${HASH}`, '/s', `/${HASH}/v1/lod-meta.json`])
  })

  it('/s?id= 输入与 /scene/ 输入得到同一事实', async () => {
    const a = await resolveAssetSharePage(SOURCE, deps())
    const b = await resolveAssetSharePage(VIEWER, deps())
    expect(a).toEqual(b)
  })

  it('contentUrl 是 .ply/.spz/.splat 时返回 direct（带来源页事实）', async () => {
    routes.set('/s', { status: 200, contentType: 'text/html', body: viewerHtml.replace('.json', '.spz') })
    const resolution = await resolveAssetSharePage(SOURCE, deps())
    expect(resolution?.kind).toBe('direct')
    if (resolution?.kind !== 'direct') throw new Error('unreachable')
    expect(resolution.directUrl).toBe(`${CDN}/${HASH}/v1/lod-meta.spz`)
    // direct 只表示"解析出了可获取的直链"，不等于已下载/已导入。
    expect(resolution.resolved).toBe(true)
    expect(resolution.acquirable).toBe(true)
    expect(resolution.imported).toBe(false)
    // 直链不再当 JSON 清单读。
    expect(served).toEqual([`/scene/${HASH}`, '/s'])
  })

  it('清单地址返回 HTML 时明确报错，不把 HTML 当清单', async () => {
    routes.set(`/${HASH}/v1/lod-meta.json`, { status: 200, contentType: 'text/html', body: '<html>error</html>' })
    await expect(resolveAssetSharePage(SOURCE, deps())).rejects.toThrow(/ASSET_ACQUISITION_SHARE_PAGE_MANIFEST_NOT_JSON/)
  })

  it('公开 CDN 回 gzip（content-encoding: gzip）时仍能读出真实事实（按魔数解压）', async () => {
    // 真实 CloudFront 对 lod-meta.json 会回 gzip；这里三条公开响应都压一遍。
    routes.set(`/scene/${HASH}`, { status: 200, contentType: 'text/html', body: sceneHtml, gzip: true })
    routes.set('/s', { status: 200, contentType: 'text/html', body: viewerHtml, gzip: true })
    routes.set(`/${HASH}/v1/lod-meta.json`, { status: 200, contentType: 'application/json', body: lodMeta, gzip: true })
    const resolution = await resolveAssetSharePage(SOURCE, deps())
    expect(resolution?.kind).toBe('unsupported')
    if (resolution?.kind !== 'unsupported') throw new Error('unreachable')
    expect(resolution.facts.lodLevels).toBe(5)
    expect(resolution.facts.contentUrl).toBe(CONTENT)
    expect(resolution.facts.title).toBe('Trompetstraat - Delft')
  })

  it('302/404 保持既有语义：重定向拒绝、永久失败不重试', async () => {
    routes.set(`/scene/${HASH}`, { status: 302, contentType: 'text/plain', body: '' })
    await expect(resolveAssetSharePage(SOURCE, deps())).rejects.toThrow(/NETWORK_ASSET_REDIRECT_REJECTED/)

    served = []
    routes.set(`/scene/${HASH}`, { status: 404, contentType: 'text/plain', body: 'not found' })
    await expect(resolveAssetSharePage(SOURCE, deps())).rejects.toThrow(/NETWORK_ASSET_HTTP_404/)
    expect(served).toEqual([`/scene/${HASH}`])
  })
})

describe('统一入口把分享页结论交给调用方，不假装导入', () => {
  it('acquirePublicAsset(分享页) 抛 ASSET_ACQUISITION_SHARE_PAGE_UNSUPPORTED 并带事实', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'scene-kit-share-'))
    try {
      const operations = new SceneOperations(join(workspace, 'data'))
      const failure = await acquirePublicAsset(operations, { url: SOURCE }, {
        resolve: async () => [{ address: '93.184.216.34', family: 4 }], transport,
      } as AssetAcquisitionDependencies).catch((error: unknown) => error)
      expect(String((failure as Error).message)).toContain('ASSET_ACQUISITION_SHARE_PAGE_UNSUPPORTED')
      expect(String((failure as Error).message)).toContain(CONTENT)
      expect(String((failure as Error).message)).toContain('9993739')
      expect((await operations.resources.authoritySnapshot()).records).toHaveLength(0)
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('scene_asset_resolve 在真实 ToolRuntime 上注册并返回结构化结论', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'scene-kit-share-tool-'))
    try {
      const operations = new SceneOperations(join(workspace, 'data'))
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(Commands)
      registerAssetAcquisitionTools(ctx, { operationsFor: () => operations, dependencies: { resolve: async () => [{ address: '93.184.216.34', family: 4 }], transport } as AssetAcquisitionDependencies })
      try {
        expect(ctx.tools.get('scene_asset_resolve')).toBeDefined()
        const result = await ctx.tools.execute({
          signal: new AbortController().signal, callId: ToolCallId('call-resolve-1'), name: 'scene_asset_resolve', arguments: { input: { url: SOURCE } },
        })
        expect(result.isError).toBe(false)
        const text = result.content.map(block => block.type === 'text' ? (block as { text: string }).text : '').join('\n')
        const value = JSON.parse(text)
        expect(value.kind).toBe('unsupported')
        expect(value.facts.contentUrl).toBe(CONTENT)
        expect(value.actions.join(' ')).toContain('scene_import')
      } finally { await ctx.fiber.dispose() }
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })
})
