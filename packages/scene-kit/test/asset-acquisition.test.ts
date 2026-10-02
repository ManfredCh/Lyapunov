/**
 * scene_asset_acquire / acquireAsset 的真实行为测试：真 Cordis Context + 真 ToolRuntime +
 * 真 SceneOperations/ResourceLibrary（真落盘、真登记、真解析）+ 本机 HTTP 夹具服务器
 * （传输钩子注入口径与 network-assets 的既有注入点相同）+ 真 ZIP 夹具（按 ZIP 规范自己拼装，
 * 用 node:zlib 的 crc32/deflateRawSync，不引 ZIP 库）。
 *
 * 覆盖：.gltf 的相对 bin/纹理依赖、dataURI 与 bufferView 纹理真的被整理进自包含 GLB；
 * 本地/已下载 ZIP 取成员与包内相对依赖（含包内兄弟目录 `../textures/a.png` 与单字段 Zip64 哨兵）；
 * 复用已登记字节（传输直接抛错也命中、不新建落地/清单、仍可挂载，且如实标注没碰网络）；refresh 强制重新下载；
 * 缺件/越界/多候选/嵌套包/体积上限/取消（含依赖枚举中途取消保留取消类别）的行为；physicalize:false 真的落成 skipped；
 * 相对 path 按会话 header.cwd 解析（进程 cwd 里放同名诱饵反证）；工具与命令在真实 ToolRuntime/CommandRegistry 上注册与结构化返回。
 * 夹具是合成资产生成的：它证明本操作的行为，不替代"真实公网资产"——那部分在 .runtime 的验收里跑真源。
 * 运行：`bun test packages/scene-kit/test/asset-acquisition.test.ts`
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Commands from '@deepseek-ai/dsh-commands'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { acquireAsset, registerAssetAcquisitionTools, type AssetAcquisitionDependencies } from '../src/asset-acquisition.ts'
import { SceneOperations } from '../src/operations.ts'
import type { ResourceRecord } from '../src/resources.ts'

const SHA = (bytes: Buffer | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const ASSET_HOST = 'https://assets.example.org'

/** 一枚按 PNG 容器规范拼装的真实 PNG（与 reference-image-fetch 夹具同法，不依赖图片库）。 */
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

/**
 * 一个真实可解析的 glTF 2.0：POSITION 访问器带 min/max（源坐标 AABB，用来验证尺度口径）；
 * buffers[0] 与一张纹理走**相对依赖**，另两张纹理分别走 dataURI 与 bufferView。
 * 顶点范围 min=(-0.5,-0.25,-0.75) max=(0.5,0.75,1.25)：Y-up 转内部 Z-up 后尺度应为 (1,2,1)，
 * 三轴各不相同——忘记换算或换错轴这个断言就会失败。
 */
function gltfFixture(options: { binUri?: string; textureUri?: string; omitEmbedded?: boolean; noTexture?: boolean; selfContained?: boolean } = {}): { json: any; bin: Buffer; pngs: Buffer[] } {
  const texture = pngOf(4, 3, 11)
  const embeddedURI = pngOf(2, 2, 22)
  const inBuffer = pngOf(3, 1, 33)
  const positions = Buffer.alloc(36)
  for (const [index, xyz] of [[-0.5, -0.25, -0.75], [0.5, -0.25, -0.75], [0.5, 0.75, 1.25]].entries()) for (const [axis, value] of xyz.entries()) positions.writeFloatLE(value, index * 12 + axis * 4)
  const bin = Buffer.concat([positions, inBuffer])
  const dataURI = (png: Buffer): string => `data:image/png;base64,${png.toString('base64')}`
  // selfContained：buffer 数据在 BIN 块里（无 uri）、纹理全内嵌——就是磁盘上 .glb 文件的样子。
  const images: any[] = options.noTexture ? [] : options.selfContained
    ? [{ uri: dataURI(texture) }, { bufferView: 1, mimeType: 'image/png' }]
    : options.omitEmbedded
      ? [{ uri: options.textureUri ?? 'textures/albedo.png' }]
      : [{ uri: options.textureUri ?? 'textures/albedo.png' }, { uri: dataURI(embeddedURI) }, { bufferView: 1, mimeType: 'image/png' }]
  const material: any = options.noTexture ? { name: '夹具材质' } : { name: '夹具材质', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }
  const json = {
    asset: { version: '2.0', generator: 'asset-acquisition.test' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: '夹具节点' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [material],
    samplers: [{}],
    ...(options.noTexture ? {} : { textures: images.map((_image, index) => ({ source: index, sampler: 0 })) }),
    images,
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.5, -0.25, -0.75], max: [0.5, 0.75, 1.25] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }, { buffer: 0, byteOffset: positions.length, byteLength: inBuffer.length }],
    buffers: [options.selfContained ? { byteLength: bin.length } : { uri: options.binUri ?? 'chair.bin', byteLength: bin.length }],
  }
  return { json, bin, pngs: [texture, embeddedURI, inBuffer] }
}

/** 真自包含 GLB：buffer 无 uri（数据在 BIN 块）、纹理全内嵌，可用于"本地 GLB / 包内 GLB"输入。 */
function selfContainedGLB(): Buffer {
  const fixture = gltfFixture({ selfContained: true })
  return glbOf(fixture.json, fixture.bin)
}

/** 自包含 GLB（真容器：头 + JSON 块 + BIN 块），用来做"本地 GLB / 包内 GLB"输入。 */
function glbOf(json: any, bin: Uint8Array = Buffer.alloc(0)): Buffer {
  const text = Buffer.from(JSON.stringify(json), 'utf8')
  const jsonChunk = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)])
  const binChunk = bin.length ? Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]) : Buffer.alloc(0)
  const total = 12 + 8 + jsonChunk.length + (binChunk.length ? 8 + binChunk.length : 0)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(total, 8)
  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(jsonChunk.length, 0)
  jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  const pieces = [header, jsonHeader, jsonChunk]
  if (binChunk.length) {
    const binHeader = Buffer.alloc(8)
    binHeader.writeUInt32LE(binChunk.length, 0)
    binHeader.writeUInt32LE(0x004e4942, 4)
    pieces.push(binHeader, binChunk)
  }
  return Buffer.concat(pieces, total)
}

/** 标准 ZIP（store/deflate 混用、UTF-8 名、无 Zip64）：喂给 zip-archive 读取路径的真夹具。 */
function zipOf(files: Array<{ name: string; bytes: Buffer; store?: boolean }>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const method = file.store === true ? 0 : 8
    const data = method === 0 ? file.bytes : deflateRawSync(file.bytes)
    const checksum = crc32(file.bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(file.bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)
    const row = Buffer.alloc(46)
    row.writeUInt32LE(0x02014b50, 0)
    row.writeUInt16LE(20, 4)
    row.writeUInt16LE(20, 6)
    row.writeUInt16LE(0x800, 8)
    row.writeUInt16LE(method, 10)
    row.writeUInt16LE(0x21, 14)
    row.writeUInt32LE(checksum, 16)
    row.writeUInt32LE(data.length, 20)
    row.writeUInt32LE(file.bytes.length, 24)
    row.writeUInt16LE(name.length, 28)
    row.writeUInt32LE(offset, 42)
    central.push(row, name)
    offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

let workspace: string
let operations: SceneOperations
let server: Server
let routes: Map<string, { bytes: Buffer; contentType: string }>
let served: string[]
let port = 0
let context: Context | undefined

/** 传输钩子是既有注入口径：URL 仍按公网地址解析，真实连接打到本机夹具端口。 */
const fixtureTransport: AssetAcquisitionDependencies['transport'] = (url, options, listener) => httpRequest({
  method: options.method ?? 'GET',
  hostname: '127.0.0.1',
  port,
  path: url.pathname + url.search,
  headers: options.headers,
}, listener)

const fixtureDependencies = (overrides: AssetAcquisitionDependencies = {}): AssetAcquisitionDependencies => ({
  resolve: async () => [{ address: '93.184.216.34', family: 4 }],
  transport: fixtureTransport,
  ...overrides,
})

/** 按 .gltf 的相对布局把夹具资产挂到服务器上，返回主文件 URL。 */
const serveFixture = (root = '/models/chair', options: Parameters<typeof gltfFixture>[0] = {}): { url: string; fixture: ReturnType<typeof gltfFixture> } => {
  const fixture = gltfFixture(options)
  routes.set(`${root}/chair.gltf`, { bytes: Buffer.from(JSON.stringify(fixture.json, null, 2)), contentType: 'model/gltf+json; charset=utf-8' })
  routes.set(`${root}/chair.bin`, { bytes: fixture.bin, contentType: 'application/octet-stream' })
  routes.set(`${root}/textures/albedo.png`, { bytes: fixture.pngs[0]!, contentType: 'image/png' })
  return { url: `${ASSET_HOST}${root}/chair.gltf`, fixture }
}

const landedUnder = async (root: string): Promise<string[]> => (await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []))
  .filter(entry => entry.isFile())
  .map(entry => join((entry as { parentPath: string }).parentPath, entry.name))

/** 一组文件的总字节数：比"文件个数"更能看出"整份大资产被复制了几遍"。 */
const totalBytes = async (paths: string[]): Promise<number> => (await Promise.all(paths.map(path => stat(path).then(info => info.size, () => 0)))).reduce((sum, size) => sum + size, 0)

/** 手拼一个 Zip64 夹具 ZIP：被点名的那条中央目录记录**只有**一个字段被 0xffffffff 截断，extra（0x0001）只放那个真实值。 */
function zipWithZip64Sentinel(files: Array<{ name: string; bytes: Buffer }>, sentinel: { name: string; field: 'uncompressed' | 'compressed' | 'offset' }): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const data = deflateRawSync(file.bytes)
    const checksum = crc32(file.bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(file.bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)
    const flagged = sentinel.name === file.name
    // extra 只在被截断的那个字段上出现，顺序按 APPNOTE 4.5.3（uncompressed → compressed → offset）。
    const field = flagged ? sentinel.field : undefined
    const extra = Buffer.alloc(field === undefined ? 0 : 12)
    if (field !== undefined) {
      extra.writeUInt16LE(0x0001, 0)
      extra.writeUInt16LE(8, 2)
      extra.writeBigUInt64LE(BigInt(field === 'uncompressed' ? file.bytes.length : field === 'compressed' ? data.length : offset), 4)
    }
    const row = Buffer.alloc(46)
    row.writeUInt32LE(0x02014b50, 0)
    row.writeUInt16LE(20, 4)
    row.writeUInt16LE(20, 6)
    row.writeUInt16LE(0x800, 8)
    row.writeUInt16LE(8, 10)
    row.writeUInt16LE(0x21, 14)
    row.writeUInt32LE(checksum, 16)
    row.writeUInt32LE(field === 'compressed' ? 0xffffffff : data.length, 20)
    row.writeUInt32LE(field === 'uncompressed' ? 0xffffffff : file.bytes.length, 24)
    row.writeUInt16LE(name.length, 28)
    row.writeUInt16LE(extra.length, 30)
    row.writeUInt32LE(field === 'offset' ? 0xffffffff : offset, 42)
    central.push(row, name, extra)
    offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const glbJSONOf = (bytes: Buffer): any => JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'))
/** 组装后 GLB 的 BIN 块（JSON 块之后）；布局取自真字节，不看实现。 */
const glbBinOf = (bytes: Buffer): Buffer => bytes.subarray(20 + bytes.readUInt32LE(12) + 8)
const textOf = (result: ToolExecutionResult): string => result.content.map(block => block.type === 'text' ? (block as { text: string }).text : '').join('\n')

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'scene-kit-asset-'))
  operations = new SceneOperations(join(workspace, 'data'))
  routes = new Map()
  served = []
  server = createServer((request, response) => {
    response.on('error', () => { /* 客户端取消会打断响应，夹具不因此失败 */ })
    const path = (request.url ?? '').split('?')[0]!
    served.push(path)
    const found = routes.get(path)
    if (!found) { response.writeHead(404, { 'content-type': 'text/plain' }); response.end('not found'); return }
    response.writeHead(200, { 'content-type': found.contentType, 'content-length': String(found.bytes.length) })
    response.end(found.bytes)
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  port = (server.address() as { port: number }).port
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  server.closeAllConnections?.()
  await new Promise<void>(ready => server.close(() => ready()))
  await rm(workspace, { recursive: true, force: true })
})

describe('公开 https .gltf：相对依赖真整理进自包含 GLB', () => {
  it('下载 .bin 与相对纹理、保留 dataURI/bufferView 纹理，登记资源并解析出材质/纹理/尺度', async () => {
    const { url, fixture } = serveFixture()
    const result = await acquireAsset(operations, {
      url, name: '夹具椅子', sourcePage: 'https://assets.example.org/models/chair', license: 'CC-BY-4.0', author: '夹具作者', physicalize: false,
    }, fixtureDependencies())

    // 依赖是按 .gltf 里的相对 URI 真取回来的：地址、字节数、哈希逐条对得上夹具原件。
    // ENV-21：夹具没有 NORMAL 法线数据，原型检查如实点名；除此之外没有别的告警（许可由调用方给出）。
    expect(result.warnings).toEqual(['原型检查：1/1 个网格图元没有 NORMAL 法线数据（光照会走实现缺省，造型本身仍可判）。可采取的动作：在源工具里补算法线后重新获取。'])
    expect(result.acquisition.container).toBe('gltf')
    expect(result.acquisition.dependencies.map(item => [item.uri, item.source, item.origin, item.bytes])).toEqual([
      ['chair.bin', 'network', `${ASSET_HOST}/models/chair/chair.bin`, fixture.bin.length],
      ['textures/albedo.png', 'network', `${ASSET_HOST}/models/chair/textures/albedo.png`, fixture.pngs[0]!.length],
    ])
    expect(result.acquisition.dependencies[0]!.sha256).toBe(SHA(fixture.bin))
    expect(result.acquisition.embedded).toEqual({ dataURIBuffers: 0, dataURIImages: 1, bufferViewImages: 1 })
    // 预算是本次从远端取回的全部字节（含主文件本身），不只是依赖。
    expect(result.acquisition.budget.networkBytes).toBe(routes.get('/models/chair/chair.gltf')!.bytes.length + fixture.bin.length + fixture.pngs[0]!.length)

    // 落地的是真 GLB：三张纹理各占一个 bufferView、字节长度与原件一致，buffer 不再有外部 uri。
    const glb = await readFile(result.acquisition.glb.path)
    expect(SHA(glb)).toBe(result.acquisition.glb.sha256)
    expect(glb.readUInt32LE(0)).toBe(0x46546c67)
    const json = glbJSONOf(glb)
    expect(json.buffers).toHaveLength(1)
    expect(json.buffers[0].uri).toBeUndefined()
    expect(json.images.every((image: any) => image.uri === undefined && typeof image.bufferView === 'number')).toBe(true)
    expect(json.images.map((image: any) => json.bufferViews[image.bufferView].byteLength)).toEqual(fixture.pngs.map(png => png.length))
    expect(json.images[0]!.mimeType).toBe('image/png')
    expect(json.materials[0].name).toBe('夹具材质')
    // 相对纹理与内嵌纹理的字节真的在 BIN 里（不是文档里只留个名字）。
    const bin = glbBinOf(glb)
    expect(bin.includes(fixture.pngs[0]!)).toBe(true)
    expect(bin.includes(fixture.pngs[1]!)).toBe(true)
    expect(bin.includes(fixture.pngs[2]!)).toBe(true)

    // 尺度按资源声明的源坐标（Y-up）换算到内部 Z-up 世界帧：(1,2,1)，不是源坐标的 (1,1,2)。
    expect(result.model).toEqual({
      nodes: 1, meshes: 1, materials: 1, images: 3, sizeM: [1, 2, 1],
      // ENV-21 原型检查读数：造型范围/底面/法线/材质通道都取自组装结果本身（夹具没有 NORMAL）。
      bounds: { min: [-0.5, -1.25, -0.25], max: [0.5, 0.75, 0.75] }, bottomM: -0.25,
      normals: { primitives: 1, withNormals: 0, missing: 1 },
      materialChannels: [['baseColorTexture', 'metallicFactor', 'roughnessFactor']],
    })

    // 资源真的登记进资源库：原件指向落地 GLB，来源事实与标签按传入内容记录。
    const record: ResourceRecord = await operations.resources.get(result.resource.ref.resourceId)
    expect(record.ref.original.uri).toBe(`file://${result.acquisition.glb.path}`)
    expect(record.tags).toContain('许可:CC-BY-4.0')
    expect(record.tags).toContain('来源页:https://assets.example.org/models/chair')
    expect(record.tags).toContain('作者:夹具作者')
    expect(record.tags).toContain('来源:assets.example.org')
    expect(record.folder).toBe('获取资产/assets.example.org')
    expect(record.physicalization?.status).toBe('skipped')
    expect(result.provenance?.sourceUrl).toBe(url)
    expect(result.provenance?.contentType).toBe('model/gltf+json')
    expect(result.provenance?.redirectsFollowed).toBe(0)
    expect(result.verification.valid).toBe(true)

    // 网络字节在落地目录里留了原件副本；清单记录了依赖、来源事实与体积预算。
    expect(result.sourceFiles.every(file => file.copied)).toBe(true)
    expect(result.sourceFiles.map(file => file.origin)).toContain(`${ASSET_HOST}/models/chair/chair.bin`)
    const manifest = JSON.parse(await readFile(result.manifestPath!, 'utf8'))
    expect(manifest.glb.sha256).toBe(result.acquisition.glb.sha256)
    expect(manifest.sourceFacts).toEqual({ sourcePage: 'https://assets.example.org/models/chair', license: 'CC-BY-4.0', author: '夹具作者' })
    expect(manifest.dependencies).toHaveLength(2)
    expect(manifest.model.sizeM).toEqual([1, 2, 1])
    // 只取主文件与两个依赖，没有抓别的地址（来源页也只是一个事实，不会去抓）。
    expect(served).toEqual(['/models/chair/chair.gltf', '/models/chair/chair.bin', '/models/chair/textures/albedo.png'])
  })

  it('没给 license 时不猜许可证：给出 warnings、不写许可标签，其余照常登记', async () => {
    const { url } = serveFixture()
    const result = await acquireAsset(operations, { url, physicalize: false }, fixtureDependencies())
    expect(result.warnings.join('\n')).toContain('未提供 license')
    expect(result.sourceFacts.license).toBeUndefined()
    expect(result.resource.tags?.some(tag => tag.startsWith('许可:'))).toBe(false)
    expect(result.resource.tags?.join(' ')).not.toContain('CC-')
    expect(result.verification.valid).toBe(true)
  })

  it('同一 URL 二次获取复用已登记字节：传输直接抛错也成功，并如实标注没有访问远端', async () => {
    const { url } = serveFixture()
    const first = await acquireAsset(operations, { url, license: 'CC-BY-4.0', physicalize: false }, fixtureDependencies())
    const second = await acquireAsset(operations, { url, license: 'CC-BY-4.0', physicalize: false }, fixtureDependencies({
      transport: () => { throw new Error('本次不应发起网络请求') },
    }))

    expect(second.acquisition.download.requested).toBe(false)
    expect(second.acquisition.download.reusedFromCache).toBe(true)
    expect(second.acquisition.download.reusedFrom?.resourceId).toBe(first.resource.ref.resourceId)
    expect(second.acquisition.download.reusedFrom?.verified).toBe('sha256-recomputed')
    expect(second.acquisition.glb.sha256).toBe(first.acquisition.glb.sha256)
    expect(second.warnings.join('\n')).toContain('没有')
    expect(second.warnings.join('\n')).toContain('远端内容未变')
    expect(second.provenance?.fetchedAt).toBe(first.provenance?.fetchedAt)
    // 复用命中：沿既有记录返回（不新增版本、不重写标签、不是"再整理一遍后登记"）。
    expect(second.alreadyPresent).toBe(true)
    expect(second.resource.ref.resourceId).toBe(first.resource.ref.resourceId)
    expect(second.resource.ref.version).toBe(first.resource.ref.version)
    expect(second.verification.valid).toBe(true)
  })

  it('复用命中不新建落地/清单：连续两次调用后大资产文件数与总字节不增、第二次 networkBytes=0，可选挂载仍生效', async () => {
    const { url, fixture } = serveFixture()
    const scene = await operations.create({ sceneId: 'scene_asset_reuse' })
    const first = await acquireAsset(operations, { url, physicalize: false, sceneId: 'scene_asset_reuse', license: 'CC-BY-4.0' }, fixtureDependencies())
    // 只看资产落地根（挂载会正常写场景历史，那不是"又复制了一份资产"）。
    const dataRoot = operations.resources.downloadRoot
    const before = await landedUnder(dataRoot)
    const beforeBytes = await totalBytes(before)
    expect(before.length).toBeGreaterThan(0)
    expect(first.snapshot?.revision).toBe(scene.revision + 1)

    // 第二次：同一 URL、同一份内容，调用方还带 sceneId 要求挂载；传输一律抛错（不该发任何请求）。
    const second = await acquireAsset(operations, { url, physicalize: false, sceneId: 'scene_asset_reuse', license: 'CC-BY-4.0' },
      fixtureDependencies({ transport: () => { throw new Error('复用不该联网') } }))
    const after = await landedUnder(dataRoot)

    // 文件数量与路径、总字节都不增：整份 GLB 与全部原件没有被再复制一遍。
    expect(second.acquisition.budget.networkBytes).toBe(0)
    expect(second.acquisition.budget.reusedBytes).toBe(first.acquisition.glb.bytes)
    expect(second.acquisition.download.requested).toBe(false)
    expect([...after].sort()).toEqual([...before].sort())
    expect(await totalBytes(after)).toBe(beforeBytes)
    expect(after.filter(path => path.endsWith('asset.glb'))).toEqual([first.acquisition.glb.path])
    expect(second.acquisition.glb.path).toBe(first.acquisition.glb.path)
    // 事实沿旧清单读回，不因为"没写新文件"就缺斤少两。
    expect(second.acquisition.dependencies).toEqual(first.acquisition.dependencies)
    expect(second.model).toEqual(first.model)
    expect(second.manifestPath).toBe(first.manifestPath)
    expect(second.sourceFiles).toEqual(first.sourceFiles)
    expect(second.resource.ref.resourceId).toBe(first.resource.ref.resourceId)
    expect(second.resource.ref.version).toBe(first.resource.ref.version)

    // 可选挂载仍生效：快照恰好 +1 个 revision，本次返回的实体真的引用同一个资源版本，且首次挂载的实体还在。
    expect(second.snapshot!.revision).toBe(first.snapshot!.revision + 1)
    const carriesResource = (entityId: string): boolean => second.snapshot!.entities.some(entity => entity.entityId === entityId
      && entity.resources.some(ref => ref.resourceId === first.resource.ref.resourceId && ref.version === first.resource.ref.version))
    expect(second.entityId).not.toBe(first.entityId)
    expect(carriesResource(second.entityId!)).toBe(true)
    expect(carriesResource(first.entityId!)).toBe(true)
    // 只取过一次夹具（首次下载），第二次一个请求都没发。
    expect(served).toEqual(['/models/chair/chair.gltf', '/models/chair/chair.bin', '/models/chair/textures/albedo.png'])

    // 显式改标签/目录仍沿原记录更新（不新建任务表、不新建资源版本），标签事实取并集。
    const renamed = await acquireAsset(operations, { url, physicalize: false, folder: '我的模型', tags: ['复用标记'] },
      fixtureDependencies({ transport: () => { throw new Error('复用不该联网') } }))
    expect(renamed.resource.ref.resourceId).toBe(first.resource.ref.resourceId)
    expect(renamed.resource.ref.version).toBe(first.resource.ref.version)
    expect(renamed.resource.folder).toBe('我的模型')
    expect(renamed.resource.tags).toContain('复用标记')
    expect(renamed.resource.tags).toContain('许可:CC-BY-4.0')
    expect(renamed.resource.tags).toContain('来源:assets.example.org')
    expect([...(await landedUnder(dataRoot))].sort()).toEqual([...after].sort())
    // 复用的落地 GLB 就是首次那份：第一次拿到的原件字节仍在同一个文件里（没被"再整理一遍"换掉）。
    expect(glbBinOf(await readFile(second.acquisition.glb.path)).includes(fixture.pngs[0]!)).toBe(true)
  })

  it('refresh:true 强制重新下载并重新核对远端字节', async () => {
    const { url } = serveFixture()
    await acquireAsset(operations, { url, physicalize: false }, fixtureDependencies())
    const before = served.length
    const again = await acquireAsset(operations, { url, physicalize: false, refresh: true }, fixtureDependencies())
    expect(again.acquisition.download.requested).toBe(true)
    expect(again.acquisition.download.reusedFromCache).toBe(false)
    expect(again.acquisition.download.reusedFrom).toBeUndefined()
    expect(served.length).toBe(before + 3)
  })

  it('依赖缺件时聚合报错、不登记资源、不留下落地目录', async () => {
    const { url } = serveFixture()
    routes.delete('/models/chair/textures/albedo.png')
    await expect(acquireAsset(operations, { url, physicalize: false }, fixtureDependencies())).rejects.toThrow(/ASSET_ACQUISITION_DEPENDENCY_UNAVAILABLE[\s\S]*textures\/albedo\.png/)
    expect((await operations.resources.authoritySnapshot()).records).toHaveLength(0)
    expect(await landedUnder(join(workspace, 'data'))).toEqual([])
  })
})

describe('ZIP：本地与已下载压缩包', () => {
  it('包内单个候选自动选中，主资产与包内相对依赖（按成员目录解析）整理成 GLB', async () => {
    const fixture = gltfFixture({ binUri: 'box.bin', textureUri: 'textures/skin.png' })
    const zipPath = join(workspace, 'chair-pack.zip')
    const archive = zipOf([
      { name: 'models/chair/chair.gltf', bytes: Buffer.from(JSON.stringify(fixture.json)), store: true },
      { name: 'models/chair/box.bin', bytes: fixture.bin },
      { name: 'models/chair/textures/skin.png', bytes: fixture.pngs[0]! },
      { name: 'README.txt', bytes: Buffer.from('夹具压缩包') },
    ])
    await writeFile(zipPath, archive)

    const result = await acquireAsset(operations, { path: zipPath, physicalize: false, license: 'CC0-1.0' }, fixtureDependencies())
    expect(result.acquisition.container).toBe('zip')
    expect(result.acquisition.entry).toBe('models/chair/chair.gltf')
    // 依赖按成员所在目录解析：models/chair/box.bin，而不是包根的 box.bin。
    expect(result.acquisition.dependencies.map(item => [item.uri, item.source, item.origin])).toEqual([
      ['box.bin', 'archive', `压缩包 ${zipPath}:models/chair/box.bin`],
      ['textures/skin.png', 'archive', `压缩包 ${zipPath}:models/chair/textures/skin.png`],
    ])
    expect(result.acquisition.dependencies.map(item => item.sha256)).toEqual([SHA(fixture.bin), SHA(fixture.pngs[0]!)])
    expect(result.acquisition.download.requested).toBe(false)
    expect(result.acquisition.budget.networkBytes).toBe(0)

    // 包内字节复制进了落地目录；本地压缩包原件保留原位，只记路径与哈希。
    expect(SHA(await readFile(join(dirname(result.manifestPath!), 'source', 'models/chair/box.bin')))).toBe(SHA(fixture.bin))
    const archiveFile = result.sourceFiles.find(file => !file.copied && file.path === zipPath)
    expect(archiveFile?.sha256).toBe(SHA(archive))
    const manifest = JSON.parse(await readFile(result.manifestPath!, 'utf8'))
    expect(manifest.archive).toEqual({ origin: zipPath, path: zipPath, bytes: archive.length, sha256: SHA(archive), retained: false })
    expect(SHA(await readFile(result.acquisition.glb.path))).toBe(result.acquisition.glb.sha256)
    expect(result.model.sizeM).toEqual([1, 2, 1])
    expect(result.provenance).toBeUndefined()
    expect(result.resource.tags).toContain('来源:本地文件')
  })

  it('从 URL 下载的压缩包：按成员取资产、压缩包原件留在落地目录并算进 provenance', async () => {
    const fixture = gltfFixture({ binUri: 'box.bin', textureUri: 'textures/skin.png', omitEmbedded: true })
    const archive = zipOf([
      { name: 'pack/chair.gltf', bytes: Buffer.from(JSON.stringify(fixture.json)) },
      { name: 'pack/box.bin', bytes: fixture.bin },
      { name: 'pack/textures/skin.png', bytes: fixture.pngs[0]! },
    ])
    routes.set('/downloads/chair-pack.zip', { bytes: archive, contentType: 'application/zip' })
    const url = `${ASSET_HOST}/downloads/chair-pack.zip`
    const result = await acquireAsset(operations, { url, physicalize: false }, fixtureDependencies())
    expect(result.acquisition.container).toBe('zip')
    expect(result.acquisition.entry).toBe('pack/chair.gltf')
    expect(result.acquisition.download.requested).toBe(true)
    expect(result.provenance?.contentType).toBe('application/zip')
    // 已下载压缩包不重新打包：成员被取出后与依赖一起整理成自包含 GLB。
    expect(result.acquisition.dependencies.map(item => item.source)).toEqual(['archive', 'archive'])
    const manifest = JSON.parse(await readFile(result.manifestPath!, 'utf8'))
    expect(manifest.archive).toEqual({ origin: url, path: null, bytes: archive.length, sha256: SHA(archive), retained: true })
    const kept = result.sourceFiles.find(file => file.origin === url)
    expect(kept?.copied).toBe(true)
    expect(SHA(await readFile(kept!.path))).toBe(SHA(archive))
    expect(served).toEqual(['/downloads/chair-pack.zip'])
  })

  it('同一份字节先经网络、后经本地 ZIP：同一条记录保留两侧来源事实，目录沿用首次获取的来源', async () => {
    const { url, fixture } = serveFixture()
    const first = await acquireAsset(operations, {
      url, sourcePage: 'https://assets.example.org/models/chair', license: 'CC-BY-4.0', physicalize: false,
    }, fixtureDependencies())
    const zipPath = join(workspace, 'chair-pack.zip')
    await writeFile(zipPath, zipOf([
      { name: 'chair.gltf', bytes: Buffer.from(JSON.stringify(fixture.json, null, 2)), store: true },
      { name: 'chair.bin', bytes: fixture.bin },
      { name: 'textures/albedo.png', bytes: fixture.pngs[0]! },
    ]))
    const second = await acquireAsset(operations, { path: zipPath, entry: 'chair.gltf', author: '夹具作者', physicalize: false },
      fixtureDependencies({ transport: () => { throw new Error('本地 ZIP 不应发起网络请求') } }))

    // 同一份字节 → 资源库按内容去重：还是那条记录、还是那个版本。
    expect(second.alreadyPresent).toBe(true)
    expect(second.resource.ref.resourceId).toBe(first.resource.ref.resourceId)
    const record: ResourceRecord = await operations.resources.get(first.resource.ref.resourceId)
    expect(record.ref.version).toBe(1)
    // 事实是并集：网络那次记下的来源/来源页/许可没有被本地那次覆盖掉，本地来源也留了下来。
    expect(record.tags).toContain('来源:assets.example.org')
    expect(record.tags).toContain('来源:本地文件')
    expect(record.tags).toContain('许可:CC-BY-4.0')
    expect(record.tags).toContain('来源页:https://assets.example.org/models/chair')
    expect(record.tags).toContain('作者:夹具作者')
    // 每次获取都写一份新清单：清单指针只留最近一次，不随重复获取越堆越长。
    expect(record.tags.filter(tag => tag.startsWith('清单:'))).toEqual([`清单:${second.manifestPath}`])
    // 目录由首次获取的来源决定；显式传 folder 才改。
    expect(record.folder).toBe('获取资产/assets.example.org')
    const moved = await acquireAsset(operations, { path: zipPath, entry: 'chair.gltf', folder: '我的模型', physicalize: false },
      fixtureDependencies({ transport: () => { throw new Error('本地 ZIP 不应发起网络请求') } }))
    expect(moved.resource.folder).toBe('我的模型')
  })

  it('包内放自包含 GLB 时按成员字节原样落地', async () => {
    const glb = selfContainedGLB()
    const zipPath = join(workspace, 'glb-pack.zip')
    await writeFile(zipPath, zipOf([{ name: 'asset/model.glb', bytes: glb }]))
    const result = await acquireAsset(operations, { path: zipPath, physicalize: false }, fixtureDependencies())
    expect(result.acquisition.entry).toBe('asset/model.glb')
    expect(result.acquisition.dependencies).toEqual([])
    // 自包含 GLB 原样落地：字节与包内成员逐字节一致，不重新打包。
    expect(SHA(await readFile(result.acquisition.glb.path))).toBe(SHA(glb))
    expect(result.model).toEqual({
      nodes: 1, meshes: 1, materials: 1, images: 2, sizeM: [1, 2, 1],
      // ENV-21 原型检查读数：造型范围/底面/法线/材质通道都取自组装结果本身（夹具没有 NORMAL）。
      bounds: { min: [-0.5, -1.25, -0.25], max: [0.5, 0.75, 0.75] }, bottomM: -0.25,
      normals: { primitives: 1, withNormals: 0, missing: 1 },
      materialChannels: [['baseColorTexture', 'metallicFactor', 'roughnessFactor']],
    })
  })

  it('多候选要求 entry（错误列出候选），给出 entry 后成功；越界成员名与嵌套压缩包明确拒绝', async () => {
    const one = gltfFixture({ omitEmbedded: true, noTexture: true, binUri: 'one.bin' })
    const two = gltfFixture({ omitEmbedded: true, noTexture: true, binUri: 'two.bin' })
    const multi = join(workspace, 'multi.zip')
    await writeFile(multi, zipOf([
      { name: 'a/one.gltf', bytes: Buffer.from(JSON.stringify(one.json)) },
      { name: 'a/one.bin', bytes: one.bin },
      { name: 'b/two.gltf', bytes: Buffer.from(JSON.stringify(two.json)) },
      { name: 'b/two.bin', bytes: two.bin },
    ]))
    await expect(acquireAsset(operations, { path: multi }, fixtureDependencies())).rejects.toThrow(/ASSET_ACQUISITION_ENTRY_REQUIRED[\s\S]*a\/one\.gltf[\s\S]*b\/two\.gltf/)
    const chosen = await acquireAsset(operations, { path: multi, entry: 'b/two.gltf', physicalize: false }, fixtureDependencies())
    expect(chosen.acquisition.entry).toBe('b/two.gltf')
    expect(chosen.acquisition.dependencies.map(item => item.origin)).toEqual([`压缩包 ${multi}:b/two.bin`])
    await expect(acquireAsset(operations, { path: multi, entry: 'c/none.gltf' }, fixtureDependencies())).rejects.toThrow(/ASSET_ACQUISITION_ENTRY_NOT_FOUND/)

    const slip = join(workspace, 'slip.zip')
    await writeFile(slip, zipOf([
      { name: '../escape.gltf', bytes: Buffer.from(JSON.stringify(one.json)) },
      { name: '../escape.bin', bytes: one.bin },
    ]))
    await expect(acquireAsset(operations, { path: slip, entry: '../escape.gltf' }, fixtureDependencies())).rejects.toThrow(/ASSET_ACQUISITION_PATH_UNSAFE/)
    await expect(acquireAsset(operations, { path: slip }, fixtureDependencies())).rejects.toThrow(/ASSET_ACQUISITION_PATH_UNSAFE/)

    const nested = join(workspace, 'nested.zip')
    await writeFile(nested, zipOf([{ name: 'inner.zip', bytes: zipOf([{ name: 'a.gltf', bytes: Buffer.from(JSON.stringify(one.json)) }]) }]))
    await expect(acquireAsset(operations, { path: nested, entry: 'inner.zip' }, fixtureDependencies())).rejects.toThrow(/ASSET_ACQUISITION_NESTED_ARCHIVE_UNSUPPORTED/)
  })

  it('包内兄弟目录依赖：source/model.gltf 引 ../textures/a.png 仍在包内就取到；真正越出包根的引用才拒绝', async () => {
    const fixture = gltfFixture({ omitEmbedded: true, binUri: 'model.bin', textureUri: '../textures/a.png' })
    const sibling = join(workspace, 'sibling.zip')
    await writeFile(sibling, zipOf([
      { name: 'source/model.gltf', bytes: Buffer.from(JSON.stringify(fixture.json)), store: true },
      { name: 'source/model.bin', bytes: fixture.bin },
      { name: 'textures/a.png', bytes: fixture.pngs[0]! },
    ]))
    const result = await acquireAsset(operations, { path: sibling, physicalize: false }, fixtureDependencies())
    expect(result.acquisition.entry).toBe('source/model.gltf')
    // `../textures/a.png` 是包内兄弟目录：按成员目录 source/ 归一后是 textures/a.png，仍在包根内 → 必须取到。
    expect(result.acquisition.dependencies.map(item => [item.uri, item.source, item.origin])).toEqual([
      ['model.bin', 'archive', `压缩包 ${sibling}:source/model.bin`],
      ['../textures/a.png', 'archive', `压缩包 ${sibling}:textures/a.png`],
    ])
    // 依赖字节真的进了自包含 GLB；dataURI/bufferView 的内嵌纹理也照旧保留（不被路径归一化破坏）。
    const bin = glbBinOf(await readFile(result.acquisition.glb.path))
    expect(bin.includes(fixture.bin)).toBe(true)
    expect(bin.includes(fixture.pngs[0]!)).toBe(true)
    expect(result.model).toEqual({
      nodes: 1, meshes: 1, materials: 1, images: 1, sizeM: [1, 2, 1],
      // ENV-21 原型检查读数：造型范围/底面/法线/材质通道都取自组装结果本身（夹具没有 NORMAL）。
      bounds: { min: [-0.5, -1.25, -0.25], max: [0.5, 0.75, 0.75] }, bottomM: -0.25,
      normals: { primitives: 1, withNormals: 0, missing: 1 },
      materialChannels: [['baseColorTexture', 'metallicFactor', 'roughnessFactor']],
    })

    // 成员目录优先于包根：同名时取成员目录里那份，不去拿包根的另一份。
    const fixture2 = gltfFixture({ omitEmbedded: true, binUri: 'model.bin', textureUri: 'textures/a.png' })
    const prefer = join(workspace, 'prefer.zip')
    await writeFile(prefer, zipOf([
      { name: 'source/model.gltf', bytes: Buffer.from(JSON.stringify(fixture2.json)) },
      { name: 'source/model.bin', bytes: fixture2.bin },
      { name: 'source/textures/a.png', bytes: fixture2.pngs[0]! },
      { name: 'textures/a.png', bytes: fixture.pngs[0]! },
    ]))
    const preferred = await acquireAsset(operations, { path: prefer, physicalize: false }, fixtureDependencies())
    expect(preferred.acquisition.dependencies.map(item => [item.uri, item.origin])).toEqual([
      ['model.bin', `压缩包 ${prefer}:source/model.bin`],
      ['textures/a.png', `压缩包 ${prefer}:source/textures/a.png`],
    ])
    // 成员目录里没有时回退包根同名成员（真实包常见布局：.gltf 在子目录、纹理在包根）。
    const flat = join(workspace, 'flat.zip')
    await writeFile(flat, zipOf([
      { name: 'nested/model.gltf', bytes: Buffer.from(JSON.stringify(fixture2.json)) },
      { name: 'nested/model.bin', bytes: fixture2.bin },
      { name: 'textures/a.png', bytes: fixture.pngs[0]! },
    ]))
    const fell = await acquireAsset(operations, { path: flat, physicalize: false }, fixtureDependencies())
    expect(fell.acquisition.dependencies.map(item => [item.uri, item.origin])).toEqual([
      ['model.bin', `压缩包 ${flat}:nested/model.bin`],
      ['textures/a.png', `压缩包 ${flat}:textures/a.png`],
    ])

    // 真的越出包根才拒绝：`../../` 逃逸与绝对路径都算越界（不看 `..` 这个字面，看归一后的落点）。
    // 反例文件在包内是**存在的**（outside.bin / source/etc/hostname）：被拒是因为落点在包根之外，不是因为找不到。
    const before = (await operations.resources.authoritySnapshot()).records.length
    const filesBefore = await landedUnder(join(workspace, 'data'))
    const escaped = join(workspace, 'escaped.zip')
    await writeFile(escaped, zipOf([
      { name: 'source/model.gltf', bytes: Buffer.from(JSON.stringify(gltfFixture({ omitEmbedded: true, binUri: '../../outside.bin', noTexture: true }).json)) },
      { name: 'outside.bin', bytes: fixture.bin },
    ]))
    await expect(acquireAsset(operations, { path: escaped }, fixtureDependencies())).rejects.toThrow(/ASSET_ACQUISITION_DEPENDENCY_UNAVAILABLE[\s\S]*PATH_UNSAFE/)
    const absolute = join(workspace, 'absolute.zip')
    await writeFile(absolute, zipOf([
      { name: 'source/model.gltf', bytes: Buffer.from(JSON.stringify(gltfFixture({ omitEmbedded: true, binUri: '/etc/hostname', noTexture: true }).json)) },
      { name: 'source/etc/hostname', bytes: fixture.bin },
    ]))
    await expect(acquireAsset(operations, { path: absolute }, fixtureDependencies())).rejects.toThrow(/ASSET_ACQUISITION_DEPENDENCY_UNAVAILABLE[\s\S]*PATH_UNSAFE/)
    expect((await operations.resources.authoritySnapshot()).records).toHaveLength(before)
    expect([...(await landedUnder(join(workspace, 'data')))].sort()).toEqual([...filesBefore].sort()) // 两次被拒没有留下任何落地目录
  })

  it('Zip64：只有单个字段被 0xffffffff 截断时也按字段取值（小文件即可，不需要 4 GiB）', async () => {
    const fixture = gltfFixture({ omitEmbedded: true, binUri: 'model.bin', textureUri: 'textures/a.png' })
    const files = [
      { name: 'source/model.gltf', bytes: Buffer.from(JSON.stringify(fixture.json)) },
      { name: 'source/model.bin', bytes: fixture.bin },
      { name: 'source/textures/a.png', bytes: fixture.pngs[0]! },
    ]
    // 参照物：同一份内容、无 Zip64 扩展字段的标准 ZIP。
    const reference = join(workspace, 'zip64-reference.zip')
    await writeFile(reference, zipOf(files))
    const baseline = await acquireAsset(operations, { path: reference, physicalize: false }, fixtureDependencies())
    for (const field of ['uncompressed', 'compressed', 'offset'] as const) {
      const zipPath = join(workspace, `zip64-${field}.zip`)
      await writeFile(zipPath, zipWithZip64Sentinel(files, { name: 'source/model.gltf', field }))
      const result = await acquireAsset(operations, { path: zipPath, physicalize: false }, fixtureDependencies())
      // 主文件按包内成员目录解析依赖，组装出的 GLB 与无 Zip64 的同一份包逐字节一致。
      expect(result.acquisition.entry).toBe('source/model.gltf')
      expect(result.acquisition.dependencies.map(item => [item.uri, item.origin])).toEqual([
        ['model.bin', `压缩包 ${zipPath}:source/model.bin`],
        ['textures/a.png', `压缩包 ${zipPath}:source/textures/a.png`],
      ])
      expect(result.acquisition.glb.sha256).toBe(baseline.acquisition.glb.sha256)
      expect(SHA(await readFile(result.acquisition.glb.path))).toBe(baseline.acquisition.glb.sha256)
      expect(result.model).toEqual(baseline.model)
    }
    // 四份内容相同的包 → 内容去重成同一条记录（Zip64 与标准 ZIP 得到的是同一份字节）。
    expect((await operations.resources.authoritySnapshot()).records).toHaveLength(1)
  })
})

describe('本地文件与边界', () => {
  it('本地自包含 GLB 原样通过（字节一致），physicalize:false 真实落成 skipped', async () => {
    const glb = selfContainedGLB()
    const path = join(workspace, 'chair.glb')
    await writeFile(path, glb)
    const result = await acquireAsset(operations, { path, physicalize: false, license: 'CC-BY-4.0' }, fixtureDependencies())
    expect(SHA(await readFile(result.acquisition.glb.path))).toBe(SHA(glb))
    expect(result.sourceFiles).toEqual([{ path, source: 'file', origin: path, bytes: glb.length, sha256: SHA(glb), copied: false }])
    const record: ResourceRecord = await operations.resources.get(result.resource.ref.resourceId)
    expect(record.physicalization?.status).toBe('skipped')
  })

  it('本地 .gltf 的相对依赖只允许 .gltf 自己目录树内的路径：树内允许，越出与绝对路径都拒绝', async () => {
    const fixture = gltfFixture({ binUri: 'deps/chair.bin', textureUri: 'textures/skin.png' })
    const assetRoot = join(workspace, 'assets')
    const gltfPath = join(assetRoot, 'sub', 'chair.gltf')
    await mkdir(join(assetRoot, 'sub', 'deps'), { recursive: true })
    await mkdir(join(assetRoot, 'sub', 'textures'), { recursive: true })
    await writeFile(join(assetRoot, 'sub', 'deps', 'chair.bin'), fixture.bin)
    await writeFile(join(assetRoot, 'sub', 'textures', 'skin.png'), fixture.pngs[0]!)
    await writeFile(join(assetRoot, 'outside.bin'), fixture.bin)
    await writeFile(gltfPath, JSON.stringify(fixture.json))
    const ok = await acquireAsset(operations, { path: gltfPath, physicalize: false }, fixtureDependencies())
    expect(ok.acquisition.dependencies.map(item => [item.uri, item.source, item.origin])).toEqual([
      ['deps/chair.bin', 'file', join(assetRoot, 'sub', 'deps', 'chair.bin')],
      ['textures/skin.png', 'file', join(assetRoot, 'sub', 'textures', 'skin.png')],
    ])

    // '../outside.bin' 从 sub/ 出发会走出 .gltf 自己的目录树 → 与 environment-assets 的 include 规则同一口径拒绝。
    await writeFile(gltfPath, JSON.stringify(gltfFixture({ binUri: '../outside.bin' }).json))
    await expect(acquireAsset(operations, { path: gltfPath }, fixtureDependencies())).rejects.toThrow(/ASSET_ACQUISITION_DEPENDENCY_UNAVAILABLE[\s\S]*PATH_UNSAFE/)
    await writeFile(gltfPath, JSON.stringify(gltfFixture({ binUri: '/etc/hostname' }).json))
    await expect(acquireAsset(operations, { path: gltfPath }, fixtureDependencies())).rejects.toThrow(/ASSET_ACQUISITION_DEPENDENCY_UNAVAILABLE[\s\S]*hostname/)
    expect((await operations.resources.authoritySnapshot()).records).toHaveLength(1)
  })

  it('体积上限：本地文件超过 maxBytes 明确拒绝；maxBytes 只能收紧不能放宽', async () => {
    const glb = selfContainedGLB()
    const path = join(workspace, 'chair.glb')
    await writeFile(path, glb)
    await expect(acquireAsset(operations, { path, maxBytes: 64 }, fixtureDependencies())).rejects.toThrow(new RegExp(`ASSET_ACQUISITION_SIZE_LIMIT: ${path} 有 ${glb.length} 字节，超过本次上限 64`))
    const wide = await acquireAsset(operations, { path, maxBytes: 100 * 1024 * 1024, physicalize: false }, fixtureDependencies())
    expect(wide.acquisition.budget.limitBytes).toBe(64 * 1024 * 1024)
    expect(SHA(await readFile(wide.acquisition.glb.path))).toBe(SHA(glb))
  })

  it('取消后不下载、不落文件、不登记资源；url 与 path 必须二选一', async () => {
    const { url } = serveFixture()
    const controller = new AbortController()
    controller.abort()
    await expect(acquireAsset(operations, { url }, fixtureDependencies({ signal: controller.signal }))).rejects.toThrow(/abort/i)
    expect(served).toEqual([])
    await expect(acquireAsset(operations, { path: join(workspace, 'x.glb'), url }, fixtureDependencies())).rejects.toThrow(/ASSET_ACQUISITION_SOURCE_REQUIRED/)
    expect((await operations.resources.authoritySnapshot()).records).toHaveLength(0)
    expect(await landedUnder(join(workspace, 'data'))).toEqual([])
  })

  it('依赖枚举期间取消：立刻抛取消错误（保留取消类别），不把用户停止当成依赖缺失，也不再枚举剩下的依赖', async () => {
    const { url } = serveFixture()
    const controller = new AbortController()
    const stop = new Error('用户停止了本次获取'); stop.name = 'AbortError'
    // 第一个依赖（chair.bin）的响应体读完那一刻取消：现场是"枚举下一个依赖之前用户按了停止"。
    const abortAfterFirstDependency = (target: URL, options: any, listener: any) => {
      const request = fixtureTransport(target, options, listener)
      if (target.pathname.endsWith('chair.bin')) request.on('response', (response: any) => response.on('end', () => controller.abort(stop)))
      return request
    }
    const error = await acquireAsset(operations, { url, physicalize: false }, fixtureDependencies({
      transport: abortAfterFirstDependency, signal: controller.signal,
    })).catch((thrown: unknown) => thrown)

    // 取消类别原样上抛：同一个 reason 对象，不是被包成"依赖缺失"、也不是被当成网络故障。
    expect(error).toBe(stop)
    expect((error as Error).name).toBe('AbortError')
    expect(String((error as Error).message)).not.toContain('ASSET_ACQUISITION_DEPENDENCY_UNAVAILABLE')
    // 剩下的依赖没有被枚举（纹理一个请求都没发），也没有留下资源或落地目录。
    expect(served).toEqual(['/models/chair/chair.gltf', '/models/chair/chair.bin'])
    expect((await operations.resources.authoritySnapshot()).records).toHaveLength(0)
    expect(await landedUnder(join(workspace, 'data'))).toEqual([])
  })
})

describe('会话 cwd 与相对路径', () => {
  /**
   * 会话目录里放一份正常相对名 `model.zip`；产品根（进程 cwd）放同名诱饵。
   * 两者内容不同（主成员与纹理都是合成夹具）、装配结果也不同，取错文件一眼能看出来。
   */
  const plantSessionAndDecoy = async (): Promise<{ sessionDir: string; decoy: string; decoyZipSHA: string; decoyGLBSHA: string }> => {
    const fixture = gltfFixture({ omitEmbedded: true, binUri: 'model.bin', textureUri: 'textures/a.png' })
    const sessionDir = join(workspace, 'session')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'model.zip'), zipOf([
      { name: 'source/model.gltf', bytes: Buffer.from(JSON.stringify(fixture.json)) },
      { name: 'source/model.bin', bytes: fixture.bin },
      { name: 'source/textures/a.png', bytes: fixture.pngs[0]! },
    ]))
    const decoy = join(process.cwd(), 'model.zip')
    expect(await stat(decoy).then(() => true, () => false)).toBe(false) // 不覆盖进程 cwd 里已有的东西
    const decoyZip = zipOf([{ name: 'decoy/model.glb', bytes: selfContainedGLB() }])
    await writeFile(decoy, decoyZip)
    return { sessionDir, decoy, decoyZipSHA: SHA(decoyZip), decoyGLBSHA: SHA(selfContainedGLB()) }
  }

  it('operation 显式 cwd、Tool 与 Command 都按 agent.session.header.cwd 解析相对 path：产品根同名诱饵不会被取到', async () => {
    const { sessionDir, decoy, decoyZipSHA, decoyGLBSHA } = await plantSessionAndDecoy()
    try {
      // ① 独立调用 operation：明确给 cwd。
      const direct = await acquireAsset(operations, { path: 'model.zip', physicalize: false }, { ...fixtureDependencies(), cwd: sessionDir })
      expect(direct.acquisition.input).toEqual({ kind: 'path', path: join(sessionDir, 'model.zip') })
      expect(direct.acquisition.entry).toBe('source/model.gltf')
      // 主成员是会话目录那份（gltf+bin+纹理），不是诱饵里的 decoy/model.glb。
      expect(direct.acquisition.glb.sha256).not.toBe(decoyGLBSHA)

      // ② Tool：会话 header.cwd 决定基准（真实 Sessions/Commands 服务 + 真实 ToolRegistry）。
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(Sessions)
      await ctx.plugin(Commands)
      context = ctx
      registerAssetAcquisitionTools(ctx, { operationsFor: () => operations, dependencies: fixtureDependencies() })
      const session = ctx.sessions.create(SessionId('asset-cwd'), { meta: { cwd: sessionDir } })
      const agent = { id: session.id, session } as Agent
      const viaTool = await ctx.tools.execute({
        callId: ToolCallId('asset-cwd-tool'), name: 'scene_asset_acquire', arguments: { input: { path: 'model.zip', physicalize: false } },
        signal: new AbortController().signal, agent,
      })
      expect(viaTool.isError).toBe(false)
      const toolValue = JSON.parse(textOf(viaTool))
      expect(toolValue.acquisition.input.path).toBe(join(sessionDir, 'model.zip'))
      expect(toolValue.acquisition.entry).toBe('source/model.gltf')

      // ③ Command：与 Tool 同一条口径。
      const execution = await ctx.commands.execute(agent, `/scene_asset_acquire ${JSON.stringify({ path: 'model.zip', physicalize: false })}`, [], new AbortController().signal)
      expect(execution!.result.kind).toBe('success')
      const commandValue = JSON.parse(execution!.result.text!)
      expect(commandValue.acquisition.input.path).toBe(join(sessionDir, 'model.zip'))
      expect(commandValue.acquisition.entry).toBe('source/model.gltf')
      expect(commandValue.acquisition.glb.sha256).toBe(direct.acquisition.glb.sha256)

      // 诱饵一直没被读到，也没被改写。
      expect(SHA(await readFile(decoy))).toBe(decoyZipSHA)

      // ④ 反证：没有会话 cwd 时才回落进程 cwd（老行为）——正是因为它会落到产品根，工具/命令才必须传会话 cwd。
      const fallback = await ctx.tools.execute({
        callId: ToolCallId('asset-cwd-fallback'), name: 'scene_asset_acquire', arguments: { input: { path: 'model.zip', physicalize: false } },
        signal: new AbortController().signal,
      })
      expect(fallback.isError).toBe(false)
      const fallbackValue = JSON.parse(textOf(fallback))
      expect(fallbackValue.acquisition.input.path).toBe(decoy)
      expect(fallbackValue.acquisition.entry).toBe('decoy/model.glb')
      expect(fallbackValue.acquisition.glb.sha256).toBe(decoyGLBSHA)
      expect(SHA(await readFile(decoy))).toBe(decoyZipSHA)
    } finally {
      await rm(decoy, { force: true })
    }
  })
})

describe('工具注册', () => {
  it('scene_asset_acquire 在真实 ToolRuntime 上注册，返回结构化 JSON 并真的登记资源', async () => {
    const path = join(workspace, 'tool.glb')
    await writeFile(path, selfContainedGLB())
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    registerAssetAcquisitionTools(ctx, { operationsFor: () => operations, dependencies: fixtureDependencies() })
    context = ctx
    expect(ctx.tools.get('scene_asset_acquire')).toBeDefined()

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('call-asset-1'),
      name: 'scene_asset_acquire',
      arguments: { input: { path, physicalize: false, license: 'CC-BY-4.0', tags: ['夹具'] } },
    })
    expect(result.isError).toBe(false)
    const value = JSON.parse(textOf(result))
    expect(value.acquisition.container).toBe('glb')
    expect(String(value.resource.ref.resourceId).startsWith('res_')).toBe(true)
    expect(value.model.materials).toBe(1)
    expect(value.resource.tags).toContain('夹具')
    expect((await operations.resources.authoritySnapshot()).records.map(record => record.ref.resourceId)).toEqual([value.resource.ref.resourceId])

    // 坏的参数走同一条工具边界：错误可读、不是崩溃，也不产生半条资源。
    const failed = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('call-asset-2'),
      name: 'scene_asset_acquire',
      arguments: { input: { path: join(workspace, 'nope.glb') } },
    })
    expect(failed.isError).toBe(true)
    expect(textOf(failed)).toContain('ASSET_ACQUISITION_FILE_NOT_FOUND')
    expect((await operations.resources.authoritySnapshot()).records).toHaveLength(1)
  })
})
