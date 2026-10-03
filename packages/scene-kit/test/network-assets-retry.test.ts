/**
 * 网络层有界恢复（ENV-49/51 的薄切片）的行为测试。
 *
 * **这是本机故障夹具，不是公网故障**：服务器只监听 127.0.0.1，按脚本决定这一次请求是
 * 正常回体、中途断流、慢体、5xx 还是 4xx；不模拟真实公网故障，也不发往公网。
 * 覆盖：中途断流后第二次成功（attempts/retries 可核对）；永久失败（4xx/格式/上限）不重试；
 * 退避期间取消与读体期间取消都原样上抛同一个取消对象且不再发下一次请求；
 * 重试不重置字节额度（失败尝试取回的字节照样计费，额度按剩余量收窄）；
 * 字节"读完但内容不对"（file 校验失败）按短暂故障重试，且同样受次数上限约束。
 * 运行：`bun test packages/scene-kit/test/network-assets-retry.test.ts`
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createServer, request as httpRequest, type Server } from 'node:http'
import {
  fetchPublicHttpsBytesWithRetry,
  NETWORK_ASSET_RETRY_DEFAULTS,
  permanentNetworkFailure,
  transientNetworkFailure,
  type NetworkAssetTransport,
} from '../src/network-assets.ts'

const FIXTURE_HOST = 'https://assets.example.org'

/** 每一条请求要做什么：正常回体 / 中途断流（声明全长但只给一部分）/ 只给状态码 / 慢体。 */
type Fault = { kind: 'ok'; body?: Buffer } | { kind: 'cut'; keep: number; body?: Buffer } | { kind: 'status'; status: number } | { kind: 'slow'; chunks: number; delayMs: number }
let plan: Map<string, Fault[]>
let hits: Map<string, number>
let server: Server
let port = 0

const fullBody = (size = 512): Buffer => Buffer.alloc(size, 0xab)
const URL_FOR = `${FIXTURE_HOST}/asset.bin`

/** 传输钩子是既有注入口径：URL 仍按公网地址解析，真实连接打到本机夹具端口。 */
const fixtureTransport: NetworkAssetTransport = (url, options, listener) => httpRequest({
  method: options.method ?? 'GET',
  hostname: '127.0.0.1',
  port,
  path: url.pathname + url.search,
  headers: options.headers,
}, listener)

const resolvePublic = async (): Promise<Array<{ address: string; family: number }>> => [{ address: '93.184.216.34', family: 4 }]
const hitCount = (path: string): number => hits.get(path) ?? 0
/** 第 index 次（0 起）请求的剧本；剧本用完后按最后一条重复。 */
const faultFor = (path: string, index: number): Fault => {
  const script = plan.get(path) ?? [{ kind: 'ok' } as Fault]
  return script[Math.min(index, script.length - 1)]!
}

beforeEach(async () => {
  plan = new Map()
  hits = new Map()
  server = createServer((request, response) => {
    response.on('error', () => { /* 客户端取消会打断响应，夹具不因此失败 */ })
    const path = (request.url ?? '').split('?')[0]!
    // 先按"这是第几次命中"取剧本，再计数：脚本序号就是命中序号（同一条 URL 的第 1、2、… 次）。
    const fault = faultFor(path, hitCount(path))
    hits.set(path, hitCount(path) + 1)
    if (fault.kind === 'status') { response.writeHead(fault.status, { 'content-type': 'text/plain', 'content-length': '0' }); response.end(); return }
    if (fault.kind === 'cut') {
      const body = fault.body ?? fullBody()
      // 声明全长，只写前 fault.keep 字节；等这些字节真的刷出去（write 回调）后再优雅 FIN。
      // 这样客户端确定性地"收到 keep 字节 + 报文未读完的读体错误"：字节数不随 socket 缓冲漂移，
      // 也不是 Node 那种声明与实际不符就直接挂住的响应（那条路客户端等到超时都等不到 FIN）。
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) })
      response.write(body.subarray(0, fault.keep), () => { setTimeout(() => response.socket?.end(), 5) })
      return
    }
    if (fault.kind === 'slow') {
      const body = fullBody()
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) })
      let sent = 0
      const step = (): void => {
        if (sent >= fault.chunks) { response.end(); return }
        sent += 1
        response.write(body.subarray(0, Math.floor(body.length / fault.chunks)))
        setTimeout(step, fault.delayMs)
      }
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
})

/**
 * 按剧本给出"声明长度 = declared、实际只给 chunks"的响应，**且不报任何错**。
 * 用途有二：一是"干净结束的短体"——客户端自身的重发与 HTTP/2 都能把截断藏成这样（39 号那次重试
 * 写出的坏图就是这种），要保证"没有错误、只是短了"确定发生；二是让"第几次尝试拿到多少字节"完全可控，
 * 从而确定性地验证重试拿到的额度是剩余量。脚本用完按最后一条重复。
 */
const scriptedTransport = (script: Array<{ declared: number; chunks: Buffer[] }>, contentType = 'application/octet-stream'): NetworkAssetTransport => {
  let call = 0
  return (_url, _options, listener) => {
    const step = script[Math.min(call, script.length - 1)]!
    call += 1
    const response = {
      statusCode: 200,
      headers: { 'content-type': contentType, 'content-length': String(step.declared) },
      once: () => response,
      on: () => response,
      removeListener: () => response,
      destroy: () => undefined,
      resume: () => undefined,
      async * [Symbol.asyncIterator]() { for (const chunk of step.chunks) yield chunk },
    }
    setTimeout(() => listener(response as never), 0)
    return { on: () => undefined, end: () => undefined, destroy: () => undefined } as never
  }
}

const messageOf = async (work: Promise<unknown>): Promise<string> => {
  try { await work; return '（没有抛错）' } catch (error) { return error instanceof Error ? error.message : String(error) }
}

describe('短暂网络失败：有界重试与可核对读数', () => {
  it('中途断流后第二次成功：字节是完整的那份，attempts=2、retries=1', async () => {
    plan.set('/asset.bin', [{ kind: 'cut', keep: 128 }, { kind: 'ok' }])
    const charged: number[] = []
    const result = await fetchPublicHttpsBytesWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, {
      transport: fixtureTransport, retry: { backoffMs: 5 }, onBytes: count => charged.push(count),
    })
    expect(result.bytes.equals(fullBody())).toBe(true)
    expect(result.attempts).toBe(2)
    expect(result.retries).toBe(1)
    // 服务端看到的次数不少于本层的重试次数：客户端在检测到提前关闭时还可能自行重发同一条请求，
    // 那不是本层的重试（本层的重试以 attempts/retries 读数为准，见上）。
    expect(hitCount('/asset.bin')).toBeGreaterThanOrEqual(2)
    // 失败尝试已到达的 128 字节只要被读到就照样计费（transferredBytes 是各次尝试的合计，不是最后一次的长度）；
    // 这半截体是否**交付到读者**取决于分片与 FIN 的到达时序（高负载下客户端可能直接丢掉已缓冲的那点体），
    // 所以这里只钉"不少于成功那份、不超过每个被切断的到达各 128 字节"，上界跟着服务端实际次数走；
    // "恰好 = 两次合计"的确定性断言放在 scriptedTransport 的额度用例里（那才是要证的那条）。
    expect(result.transferredBytes).toBeGreaterThanOrEqual(fullBody().length)
    expect(result.transferredBytes).toBeLessThanOrEqual(fullBody().length + 128 * (hitCount('/asset.bin') - 1))
    expect(charged.reduce((sum, count) => sum + count, 0)).toBe(result.transferredBytes)
  })

  it('5xx 重试到底仍是 5xx：次数用满就如实抛出，不做无限重试', async () => {
    plan.set('/asset.bin', [{ kind: 'status', status: 503 }])
    const attempts: number[] = []
    const failure = await messageOf(fetchPublicHttpsBytesWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, {
      transport: fixtureTransport, retry: { retries: 2, backoffMs: 5 }, onAttempt: attempt => attempts.push(attempt),
    }))
    expect(failure).toContain('NETWORK_ASSET_HTTP_503')
    expect(attempts).toEqual([1, 2, 3])
    expect(hitCount('/asset.bin')).toBe(3)
  })

  it('默认策略就是有界的：attempts 不超过 1 + retries', async () => {
    plan.set('/asset.bin', [{ kind: 'status', status: 500 }])
    const attempts: number[] = []
    await messageOf(fetchPublicHttpsBytesWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, {
      transport: fixtureTransport, retry: { backoffMs: 1 }, onAttempt: attempt => attempts.push(attempt),
    }))
    expect(attempts.length).toBe(1 + NETWORK_ASSET_RETRY_DEFAULTS.retries)
  })

  it('永久失败不盲重试：404 只请求一次', async () => {
    plan.set('/asset.bin', [{ kind: 'status', status: 404 }])
    const attempts: number[] = []
    const failure = await messageOf(fetchPublicHttpsBytesWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, {
      transport: fixtureTransport, retry: { backoffMs: 5 }, onAttempt: attempt => attempts.push(attempt),
    }))
    expect(failure).toContain('NETWORK_ASSET_HTTP_404')
    expect(attempts).toEqual([1])
    expect(hitCount('/asset.bin')).toBe(1)
  })

  it('永久失败不盲重试：403 与格式拒绝也各只请求一次', async () => {
    plan.set('/asset.bin', [{ kind: 'status', status: 403 }])
    expect(await messageOf(fetchPublicHttpsBytesWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, { transport: fixtureTransport, retry: { backoffMs: 5 } })))
      .toContain('NETWORK_ASSET_HTTP_403')
    expect(hitCount('/asset.bin')).toBe(1)
  })

  it('尺寸上限是永久失败：超限不重试，且不会因为重试而把上限绕开', async () => {
    const attempts: number[] = []
    const failure = await messageOf(fetchPublicHttpsBytesWithRetry(new URL(URL_FOR), resolvePublic, 100, {
      transport: fixtureTransport, retry: { backoffMs: 5 }, onAttempt: attempt => attempts.push(attempt),
    }))
    expect(failure).toContain('NETWORK_ASSET_SIZE_LIMIT')
    expect(attempts).toEqual([1])
  })

  it('重试不重置字节额度：失败尝试的字节照样计费，合计正好用满上限', async () => {
    const body = fullBody(700)
    // 第一次只给 300 字节（短体，报长度不符），第二次给满 700；两次尝试共 1000 字节额度。
    const charged: number[] = []
    const result = await fetchPublicHttpsBytesWithRetry(new URL(URL_FOR), resolvePublic, 1000, {
      transport: scriptedTransport([{ declared: 700, chunks: [body.subarray(0, 300)] }, { declared: 700, chunks: [body] }]),
      retry: { backoffMs: 5 }, onBytes: count => charged.push(count),
    })
    expect(result.bytes.equals(body)).toBe(true)
    expect(result.attempts).toBe(2)
    // 300（短体那次真的下来了）+ 700（成功那次）= 1000 = maxBytes：第二次拿到的正是"剩下那 700"，不是新的 1000 或 1200。
    expect(result.transferredBytes).toBe(1000)
    expect(charged.reduce((sum, count) => sum + count, 0)).toBe(1000)
  })

  it('额度不够再下一次时，重试被预算挡住而不是再拿一份完整额度', async () => {
    const body = fullBody(700)
    const charged: number[] = []
    // 上限 900：短体那次已用掉 300，第二次只剩 600 < 声明 700 → 直接判超限（而不是把 700 又下一次）。
    const failure = await messageOf(fetchPublicHttpsBytesWithRetry(new URL(URL_FOR), resolvePublic, 900, {
      transport: scriptedTransport([{ declared: 700, chunks: [body.subarray(0, 300)] }, { declared: 700, chunks: [body] }]),
      retry: { backoffMs: 5 }, onBytes: count => charged.push(count),
    }))
    expect(failure).toContain('NETWORK_ASSET_SIZE_LIMIT')
    // 预算挡住时只花掉了短体那 300 字节：第二次尝试的声明长度已超过剩余额度，一个字节都没读。
    expect(charged.reduce((sum, count) => sum + count, 0)).toBe(300)
  })

  it('字节"读完但内容不对"（调用方校验失败）按短暂故障重试，并用成功的字节收尾', async () => {
    const good = fullBody(400)
    // 第一次回的是"完整但内容不同"的字节（content-length 自洽），第二次才是真字节：
    // 这正是 39 号那次重试写出坏图（154038 vs 97499）的场景——只看长度看不出来，要靠校验。
    plan.set('/asset.bin', [{ kind: 'ok', body: fullBody(300) }, { kind: 'ok', body: good }])
    const verified: number[] = []
    const result = await fetchPublicHttpsBytesWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, {
      transport: fixtureTransport, retry: { backoffMs: 5 },
      verify: bytes => { verified.push(bytes.length); if (bytes.length !== good.length) throw new Error('ENVIRONMENT_ASSET_SIZE_MISMATCH: asset.bin') },
    })
    expect(result.bytes.equals(good)).toBe(true)
    expect(result.attempts).toBe(2)
    expect(verified).toEqual([300, 400])
  })

  it('声明长度与实际不符（截断但客户端不报错）也算失败：靠长度对照揭穿，随后重试成功', async () => {
    const full = fullBody()
    const charged: number[] = []
    const result = await fetchPublicHttpsBytesWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, {
      transport: scriptedTransport([{ declared: full.length, chunks: [full.subarray(0, 40)] }, { declared: full.length, chunks: [full] }]),
      retry: { backoffMs: 5 }, onBytes: count => charged.push(count),
    })
    expect(result.bytes.equals(full)).toBe(true)
    expect(result.attempts).toBe(2)
    expect(result.transferredBytes).toBe(full.length + 40)
  })

  it('短体连来两次就用满次数抛出，不把截断字节当成品交出去', async () => {
    const short = fullBody().subarray(0, 40)
    const attempts: number[] = []
    const failure = await messageOf(fetchPublicHttpsBytesWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, {
      transport: scriptedTransport([{ declared: 512, chunks: [short] }]), retry: { retries: 1, backoffMs: 5 }, onAttempt: attempt => attempts.push(attempt),
    }))
    expect(failure).toContain('NETWORK_ASSET_SIZE_MISMATCH')
    expect(failure).toContain('声明 512 字节，实际读到 40')
    expect(attempts).toEqual([1, 2])
  })

  it('校验失败同样受次数上限约束：连坏两次就用满次数抛出', async () => {
    plan.set('/asset.bin', [{ kind: 'ok', body: fullBody(300) }])
    const attempts: number[] = []
    const failure = await messageOf(fetchPublicHttpsBytesWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, {
      transport: fixtureTransport, retry: { retries: 1, backoffMs: 5 }, onAttempt: attempt => attempts.push(attempt),
      verify: bytes => { if (bytes.length !== 999) throw new Error('ENVIRONMENT_ASSET_SIZE_MISMATCH: asset.bin') },
    }))
    expect(failure).toContain('ENVIRONMENT_ASSET_SIZE_MISMATCH')
    expect(attempts).toEqual([1, 2])
    expect(hitCount('/asset.bin')).toBe(2)
  })
})

describe('取消语义：退避与读体都及时结束', () => {
  it('退避期间取消：抛的就是调用方的取消对象，且不再发第二次请求', async () => {
    plan.set('/asset.bin', [{ kind: 'status', status: 500 }])
    const controller = new AbortController()
    const reason = new Error('用户停止了本次下载')
    reason.name = 'AbortError'
    const work = fetchPublicHttpsBytesWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, {
      transport: fixtureTransport, signal: controller.signal, retry: { retries: 2, backoffMs: 5_000 },
    })
    // 退避窗口很长，确保取消发生在退避中而不是请求中。
    setTimeout(() => controller.abort(reason), 50)
    let thrown: unknown
    try { await work } catch (error) { thrown = error }
    expect(thrown).toBe(reason)
    expect(hitCount('/asset.bin')).toBe(1)
  })

  it('读体期间取消：中途内容不落地，原样抛取消对象', async () => {
    plan.set('/asset.bin', [{ kind: 'slow', chunks: 20, delayMs: 40 }])
    const controller = new AbortController()
    const reason = new Error('用户停止了本次下载')
    reason.name = 'AbortError'
    const work = fetchPublicHttpsBytesWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, {
      transport: fixtureTransport, signal: controller.signal, retry: { backoffMs: 5 },
    })
    setTimeout(() => controller.abort(reason), 120)
    let thrown: unknown
    try { await work } catch (error) { thrown = error }
    expect(thrown).toBe(reason)
    expect(hitCount('/asset.bin')).toBe(1)
  })

  it('取消不会被当成"短暂故障"重试，也不发任何请求', async () => {
    plan.set('/asset.bin', [{ kind: 'status', status: 500 }])
    const controller = new AbortController()
    const reason = new Error('已经取消')
    controller.abort(reason)
    let thrown: unknown
    try {
      await fetchPublicHttpsBytesWithRetry(new URL(URL_FOR), resolvePublic, 64 * 1024, {
        transport: fixtureTransport, signal: controller.signal, retry: { backoffMs: 5 },
      })
    } catch (error) { thrown = error }
    // 取消按调用方给的对象原样上抛（network-assets 既有口径），既不是网络故障也不是重试后的错误。
    expect(thrown).toBe(reason)
    expect(hitCount('/asset.bin')).toBe(0)
  })
})

describe('失败分类：只有能判定为短暂故障的才重试', () => {
  it('短暂/永久分类与状态码、套接字码、URL 预检各归各位', () => {
    const socket = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    expect(transientNetworkFailure(socket)).toBe(true)
    expect(transientNetworkFailure(new Error('NETWORK_ASSET_TIMEOUT'))).toBe(true)
    expect(transientNetworkFailure(new Error('NETWORK_ASSET_HTTP_503'))).toBe(true)
    expect(transientNetworkFailure(new Error('NETWORK_ASSET_HTTP_429'))).toBe(true)
    expect(transientNetworkFailure(new Error('NETWORK_ASSET_HTTP_404'))).toBe(false)
    expect(transientNetworkFailure(new Error('NETWORK_ASSET_MIME_REJECTED: text/html'))).toBe(false)
    expect(transientNetworkFailure(new Error('NETWORK_URL_RESOLVES_TO_PRIVATE_ADDRESS'))).toBe(false)
    const abort = new Error('NETWORK_ASSET_TIMEOUT'); abort.name = 'AbortError'
    expect(transientNetworkFailure(abort)).toBe(false)
    expect(permanentNetworkFailure(new Error('NETWORK_ASSET_HTTP_404'))).toBe(true)
    expect(permanentNetworkFailure(new Error('NETWORK_ASSET_HTTP_500'))).toBe(false)
    expect(permanentNetworkFailure(new Error('ENVIRONMENT_ASSET_MD5_MISMATCH: a.png'))).toBe(false)
  })
})

/** 目标 URL 必须在预检里通过：夹具只替换连接目标，URL 本身仍要按公网 https 规则成立。 */
it('夹具 URL 形态与生产一致（https + 公网主机名）', () => {
  expect(URL_FOR.startsWith('https://')).toBe(true)
  expect(new URL(URL_FOR).hostname).toBe('assets.example.org')
})
