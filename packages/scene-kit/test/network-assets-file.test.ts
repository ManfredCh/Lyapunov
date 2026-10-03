/**
 * 流式落地传输层（fetchPublicHttpsFileWithRetry）的**真实行为**测试：本机 HTTP 夹具 + 手写脚本传输。
 *
 * 与 network-assets-retry.test.ts 同一条恢复语义，只是字节落点变成文件：短暂断流重连、声明长度不符重试、
 * verifyFile 校验失败删除未完成件并按短暂/永久分类、永久失败不重试、中途取消删件并原样上抛取消对象、
 * 失败尝试的字节照样计费且重试只拿剩余额度。另用慢体证明目标文件在传输完成前就已在增长（流式，不是整块 Buffer）。
 * 运行：`bun test packages/scene-kit/test/network-assets-file.test.ts`
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchPublicHttpsFileWithRetry, type NetworkAssetTransport } from '../src/network-assets.ts'

const HOST = 'https://assets.example.org'
const URL_FOR = `${HOST}/asset.bin`
const fullBody = (size = 512): Buffer => Buffer.alloc(size, 0xab)

type Fault = { kind: 'ok'; body?: Buffer } | { kind: 'cut'; keep: number; body?: Buffer } | { kind: 'status'; status: number } | { kind: 'slow'; chunks: number; delayMs: number }
let plan: Map<string, Fault[]>
let hits: Map<string, number>
let server: Server
let workspace: string
let port = 0

const fixtureTransport: NetworkAssetTransport = (url, options, listener) => httpRequest({
  method: options.method ?? 'GET', hostname: '127.0.0.1', port, path: url.pathname + url.search, headers: options.headers,
}, listener)
const resolvePublic = async (): Promise<Array<{ address: string; family: number }>> => [{ address: '93.184.216.34', family: 4 }]
const hitCount = (path: string): number => hits.get(path) ?? 0
const faultFor = (path: string, index: number): Fault => (plan.get(path) ?? [{ kind: 'ok' } as Fault])[Math.min(index, (plan.get(path)?.length ?? 1) - 1)]!
/** 本次下载独占的临时件（`.名称.<uuid>.part`）：await 返回后必须一条不剩。 */
const partFiles = async (): Promise<string[]> => (await readdir(workspace)).filter(name => name.endsWith('.part')).sort()

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'scene-kit-file-'))
  plan = new Map()
  hits = new Map()
  server = createServer((request, response) => {
    response.on('error', () => { /* 取消会打断响应 */ })
    const path = (request.url ?? '').split('?')[0]!
    const fault = faultFor(path, hitCount(path))
    hits.set(path, hitCount(path) + 1)
    if (fault.kind === 'status') { response.writeHead(fault.status, { 'content-type': 'text/plain', 'content-length': '0' }); response.end(); return }
    if (fault.kind === 'cut') {
      const body = fault.body ?? fullBody()
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) })
      response.write(body.subarray(0, fault.keep), () => { setTimeout(() => response.socket?.end(), 5) })
      return
    }
    if (fault.kind === 'slow') {
      const body = fullBody()
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) })
      let sent = 0
      const step = (): void => { if (sent >= fault.chunks) { response.end(); return } sent += 1; response.write(body.subarray(0, Math.floor(body.length / fault.chunks))); setTimeout(step, fault.delayMs) }
      step()
      return
    }
    const body = fault.body ?? fullBody()
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) })
    response.end(body)
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  port = (server.address() as { port: number }).port
})

afterEach(async () => {
  server.closeAllConnections?.()
  await new Promise<void>(ready => server.close(() => ready()))
  await rm(workspace, { recursive: true, force: true })
})

const messageOf = async (work: Promise<unknown>): Promise<string> => { try { await work; return '（没有抛错）' } catch (error) { return error instanceof Error ? error.message : String(error) } }

/** 按第几次命中给"声明长度 = declared、实际只给 chunks"的响应；脚本用完按最后一条重复。 */
const scriptedTransport = (script: Array<{ declared: number; chunks: Buffer[] }>): NetworkAssetTransport => {
  let call = 0
  return (_url, _options, listener) => {
    const step = script[Math.min(call, script.length - 1)]!
    call += 1
    const response = {
      statusCode: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(step.declared) },
      once: () => response, on: () => response, removeListener: () => response, destroy: () => undefined, resume: () => undefined,
      async * [Symbol.asyncIterator]() { for (const chunk of step.chunks) yield chunk },
    }
    setTimeout(() => listener(response as never), 0)
    return { on: () => undefined, end: () => undefined, destroy: () => undefined } as never
  }
}

describe('流式落地：有界重试、内容校验、取消与预算', () => {
  it('中途断流后第二次成功：文件是完整那份、attempts=2、失败接的残件被清掉', async () => {
    plan.set('/asset.bin', [{ kind: 'cut', keep: 128 }, { kind: 'ok' }])
    const destination = join(workspace, 'asset.bin')
    const result = await fetchPublicHttpsFileWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, destination, { transport: fixtureTransport, retry: { backoffMs: 5 } })
    expect(result.attempts).toBe(2)
    expect(result.retries).toBe(1)
    expect(result.bytes).toBe(fullBody().length)
    expect((await stat(destination)).size).toBe(fullBody().length)
  })

  it('verifyFile 失败：删除未完成件并按短暂故障重试，成功那份才留下', async () => {
    plan.set('/asset.bin', [{ kind: 'ok', body: fullBody(300) }, { kind: 'ok', body: fullBody(512) }])
    const destination = join(workspace, 'verified.bin')
    const verified: number[] = []
    const result = await fetchPublicHttpsFileWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, destination, {
      transport: fixtureTransport, retry: { backoffMs: 5 },
      verifyFile: path => { verified.push(path.includes('verified.bin') ? 1 : 0); /* 读尺寸校验（收到的是本次独占临时件） */ return stat(path).then(info => { if (info.size !== 512) throw new Error('NETWORK_ASSET_SIZE_MISMATCH: 夹具内容不对') }) },
    })
    expect(result.bytes).toBe(512)
    expect(result.attempts).toBe(2)
    expect(verified).toEqual([1, 1])
    expect((await stat(destination)).size).toBe(512)
  })

  it('verifyFile 的永久失败不重试：只尝试一次且删掉刚落地的件', async () => {
    plan.set('/asset.bin', [{ kind: 'ok', body: fullBody(300) }])
    const destination = join(workspace, 'html.bin')
    const attempts: number[] = []
    const failure = await messageOf(fetchPublicHttpsFileWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, destination, {
      transport: fixtureTransport, retry: { backoffMs: 5 }, onAttempt: attempt => attempts.push(attempt),
      verifyFile: () => { throw new Error('NETWORK_ASSET_MIME_REJECTED: text/html') },
    }))
    expect(failure).toContain('NETWORK_ASSET_MIME_REJECTED')
    expect(attempts).toEqual([1])
    expect(hitCount('/asset.bin')).toBe(1)
    expect(existsSync(destination)).toBe(false)
    expect(await partFiles()).toEqual([])
  })

  it('声明长度与实际不符（短体）触发重试；再次短体用满次数后抛错且不留件', async () => {
    const failure = await messageOf(fetchPublicHttpsFileWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, join(workspace, 'short.bin'), {
      transport: scriptedTransport([{ declared: 512, chunks: [fullBody().subarray(0, 40)] }]), retry: { retries: 1, backoffMs: 5 },
    }))
    expect(failure).toContain('NETWORK_ASSET_SIZE_MISMATCH')
    expect(failure).toContain('实际读到 40')
    expect(existsSync(join(workspace, 'short.bin'))).toBe(false)
  })

  it('中途取消：原样抛调用方的取消对象，并删掉未完成件与不再发请求（等待清理完成后才返回）', async () => {
    plan.set('/asset.bin', [{ kind: 'slow', chunks: 50, delayMs: 30 }])
    const destination = join(workspace, 'cancel.bin')
    const controller = new AbortController()
    const reason = new Error('用户停止了本次下载'); reason.name = 'AbortError'
    const work = fetchPublicHttpsFileWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, destination, { transport: fixtureTransport, signal: controller.signal, retry: { backoffMs: 5 } })
    setTimeout(() => controller.abort(reason), 90)
    let thrown: unknown
    try { await work } catch (error) { thrown = error }
    expect(thrown).toBe(reason)
    expect(existsSync(destination)).toBe(false)
    // 取消返回时清理已经完成：立刻查也一条 .part 都不该有（不是 fire-and-forget）。
    expect(await partFiles()).toEqual([])
    expect(hitCount('/asset.bin')).toBe(1)
  })

  it('重试不重置字节额度：失败尝试的字节照样计费，成功那次只拿剩余额度', async () => {
    const body = fullBody(400)
    const charged: number[] = []
    // 第一次短体给 100（声明 400），第二次给满 400；上限 500，两次合计正好用满。
    const result = await fetchPublicHttpsFileWithRetry(new URL(URL_FOR), resolvePublic, 500, join(workspace, 'budget.bin'), {
      transport: scriptedTransport([{ declared: 400, chunks: [body.subarray(0, 100)] }, { declared: 400, chunks: [body] }]),
      retry: { backoffMs: 5 }, onBytes: count => charged.push(count),
    })
    expect(result.bytes).toBe(400)
    expect(result.attempts).toBe(2)
    expect(result.transferredBytes).toBe(500)
    expect(charged.reduce((sum, count) => sum + count, 0)).toBe(500)
  })

  it('目标文件在传输完成前已开始增长（流式落盘，不是整份 Buffer 后再写）', async () => {
    plan.set('/asset.bin', [{ kind: 'slow', chunks: 32, delayMs: 20 }])
    const destination = join(workspace, 'stream.bin')
    const work = fetchPublicHttpsFileWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, destination, { transport: fixtureTransport, retry: { retries: 0 } })
    let sawPartial = false
    for (let attempt = 0; attempt < 60 && !sawPartial; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 15))
      // 写入的是本次独占的 .part；它在提交前已在增长就证明是流式落盘。
      let size = 0
      for (const part of await partFiles()) size += await stat(join(workspace, part)).then(info => info.size, () => 0)
      if (size > 0 && size < fullBody().length) sawPartial = true
    }
    const result = await work
    expect(sawPartial).toBe(true)
    expect(result.bytes).toBe(fullBody().length)
    expect(await partFiles()).toEqual([])
  })

  it('已有目标文件在下载失败时绝不被删除：HTTP 500 与连接失败都保留原文件', async () => {
    const destination = join(workspace, 'keep.bin')
    await writeFile(destination, '原有内容')
    plan.set('/asset.bin', [{ kind: 'status', status: 500 }])
    await expect(fetchPublicHttpsFileWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, destination, { transport: fixtureTransport, retry: { retries: 0 } })).rejects.toThrow(/NETWORK_ASSET_HTTP_500/)
    expect(await readFile(destination, 'utf8')).toBe('原有内容')
    // 连接层在创建任何文件之前就失败：旧实现会对目标 rm，把这份已有文件误删。
    await expect(fetchPublicHttpsFileWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, destination, { transport: () => { throw new Error('ECONNREFUSED') }, retry: { retries: 0 } })).rejects.toThrow(/ECONNREFUSED/)
    expect(await readFile(destination, 'utf8')).toBe('原有内容')
    expect(await partFiles()).toEqual([])
  })

  it('目标已存在时按不覆盖契约失败：不动已有文件，也不留临时件', async () => {
    const destination = join(workspace, 'exists.bin')
    await writeFile(destination, 'sentinel')
    const failure = await messageOf(fetchPublicHttpsFileWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, destination, { transport: fixtureTransport, retry: { retries: 0 } }))
    expect(failure).toContain('NETWORK_ASSET_DESTINATION_EXISTS')
    expect(await readFile(destination, 'utf8')).toBe('sentinel')
    expect(await partFiles()).toEqual([])
  })

  it('有限重试每次尝试用独占临时件：残件不碰后续尝试，成功后无 .part 残留', async () => {
    plan.set('/asset.bin', [{ kind: 'cut', keep: 20 }, { kind: 'cut', keep: 40 }, { kind: 'ok' }])
    const destination = join(workspace, 'retry.bin')
    const result = await fetchPublicHttpsFileWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, destination, { transport: fixtureTransport, retry: { retries: 2, backoffMs: 5 } })
    expect(result.attempts).toBe(3)
    expect(result.retries).toBe(2)
    expect((await stat(destination)).size).toBe(fullBody().length)
    expect(await partFiles()).toEqual([])
  })
})

// 文件校验可能耗时；取消发生在校验期间时，不得在校验返回后再提交最终文件。
it('校验期间取消不提交最终文件，返回前清理独占临时件', async () => {
  const controller = new AbortController(), reason = new Error('验证期间停止')
  const destination = join(workspace, 'cancel-verify.bin')
  await expect(fetchPublicHttpsFileWithRetry(new URL(URL_FOR), resolvePublic, 64000, destination, {
    transport: fixtureTransport, signal: controller.signal, retry: { retries: 0 },
    verifyFile: async () => { controller.abort(reason) },
  })).rejects.toBe(reason)
  expect(existsSync(destination)).toBe(false)
  expect(await partFiles()).toEqual([])
})
