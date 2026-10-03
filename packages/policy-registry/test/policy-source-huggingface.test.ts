/**
 * `huggingface` 源（经 hf-mirror）的取件纪律：**凭据只进请求头、身份只用内容 sha256、跨域不转送令牌**。
 *
 * 三条事实各有一组用例：
 *  1. **凭据来源与作用域**：显式 `HF_TOKEN` 优先，其次 `HF_TOKEN_PATH` / `$HF_HOME/token`；只发给配置的
 *     HF 端点自己的 origin；镜像跳到它自己的签名 CDN（另一个 origin）时**丢掉** Authorization；
 *     缺凭据 / 凭据被拒分开报（POLICY_HF_AUTH_REQUIRED / POLICY_HF_AUTH_REJECTED），不匿名拼假身份、
 *     不回落官方端点。凭据值绝不写进 URL、manifest、错误文本或任何返回值。
 *  2. **文件级身份**：LFS 行只能用 `lfs.oid`/`lfs.sha256`（内容 sha256）；匿名访问被掩码成 64 个 `*` 时
 *     **照实报错**（POLICY_SOURCE_IDENTITY_MASKED）——行里的 `oid` 是百来字节**指针文件**的 git blob，
 *     拿它当十 GB 权重的身份是伪造。普通文件的 tree `oid` 才是 git blob sha1。
 *  3. **来源唯一**：所有请求都打在配置的镜像上（本例 `HF_ENDPOINT`），传进来的 `endpoint` 参数（ModelScope
 *     端点）与 `huggingface.co` 都不参与 HF 取件。
 *
 * 网络用 global fetch 桩（同 `pack-plugin.test.ts`），不打真实网络；令牌是测试自造的假值。
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { downloadFile, downloadPolicy, huggingfaceEndpoint, huggingfaceToken, selectSourceFiles, sourceSnapshot, type SourceFile } from '../src/source.ts'

const MIRROR = 'http://127.0.0.1:9472' // 测试用本地镜像；镜像本身另由部署侧钉 https
const MODELSCOPE_ENDPOINT = 'https://modelscope.cn' // 传进来的 endpoint 参数：HF 源**不得**用它
const TOKEN = 'test-hf-credential-not-real' // 假令牌：测试注入用，断言它不出现在任何产物里
const COMMIT = 'e312be81e90c56a55bcb26b57429bd39a335b449'
const MODEL = 'OpenGalaxea/G05'
const encoder = new TextEncoder()
const sha256hex = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const emptyDir = () => mkdtempSync(join(tmpdir(), 'policy-hf-'))

interface Call { url: string; authorization?: string; range: string | null; redirect: RequestRedirect | undefined }
/** 在给定环境变量下跑一段（HF_TOKEN 等会泄漏进其他用例：必须逐条还原）。 */
async function withEnv(env: Record<string, string | undefined>, run: () => Promise<void>) {
  const keys = ['HF_ENDPOINT', 'HF_TOKEN', 'HF_HOME', 'HF_TOKEN_PATH'] as const
  const saved = keys.map(key => [key, process.env[key]] as const)
  for (const key of keys) { const value = env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value }
  try { await run() } finally { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
}
function stubFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [], original = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init: any = {}) => {
    const header = init?.headers ?? {}
    const call: Call = { url: String(input), authorization: header.authorization, range: header.range ?? header.Range ?? null, redirect: init?.redirect }
    calls.push(call)
    return handler(call)
  }) as unknown as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}
/** 内容根的固定 revision 信息 + 树：`tree` 由用例给，`/revision/` 与 `/tree/` 两个形状一次装好。 */
const mirror = (rows: unknown[] | (() => unknown[]), status = 200) => (call: Call) => {
  const path = new URL(call.url).pathname
  if (path.endsWith('/revision/' + COMMIT) || /\/revision\/[^/]+$/.test(path)) {
    return status === 200 ? Response.json({ id: MODEL, sha: COMMIT }) : new Response('', { status })
  }
  if (path.endsWith('/tree/' + COMMIT)) {
    return status === 200 ? Response.json(typeof rows === 'function' ? rows() : rows) : new Response('', { status })
  }
  return new Response('unexpected ' + call.url, { status: 500 })
}
const lfsRow = (path: string, sha256: string, bytes: number) => ({ type: 'file', path, oid: 'b'.repeat(40), size: 136, lfs: { oid: sha256, size: bytes, pointerSize: 136 } })
const plainRow = (path: string, oid: string, size: number) => ({ type: 'file', path, oid, size })

describe('HF 凭据：显式环境变量优先，其次本机标准登录缓存', () => {
  test('HF_TOKEN 优先于缓存文件；HF_TOKEN_PATH 优先于 $HF_HOME/token；都没有 ⇒ null', async () => {
    const home = emptyDir()
    writeFileSync(join(home, 'token'), 'cached-token\n', { mode: 0o600 })
    await withEnv({ HF_HOME: home, HF_TOKEN_PATH: undefined, HF_TOKEN: 'env-token' }, async () => {
      expect(await huggingfaceToken()).toBe('env-token')
    })
    await withEnv({ HF_HOME: home, HF_TOKEN_PATH: undefined, HF_TOKEN: '' }, async () => {
      expect(await huggingfaceToken()).toBe('cached-token') // 文件里的换行要修掉，否则请求头会烂
    })
    const elsewhere = emptyDir()
    writeFileSync(join(elsewhere, 'token'), 'path-token\n', { mode: 0o600 })
    await withEnv({ HF_HOME: home, HF_TOKEN_PATH: join(elsewhere, 'token'), HF_TOKEN: undefined }, async () => {
      expect(await huggingfaceToken()).toBe('path-token')
    })
    await withEnv({ HF_HOME: emptyDir(), HF_TOKEN_PATH: undefined, HF_TOKEN: undefined }, async () => {
      expect(await huggingfaceToken()).toBeNull() // 读不到就是没有凭据，不编一个
    })
  })

  test('HF 端点必须 https（本机回环除外），且不得是官方 Hub：不给静默回落留出口', () => {
    expect(huggingfaceEndpoint('https://hf-mirror.example')).toBe('https://hf-mirror.example')
    expect(huggingfaceEndpoint('http://127.0.0.1:9472/')).toBe('http://127.0.0.1:9472')
    expect(() => huggingfaceEndpoint('http://mirror.example')).toThrow('POLICY_ENDPOINT_MUST_BE_HTTPS')
    for (const host of ['https://huggingface.co', 'https://www.huggingface.co', 'https://cdn-lfs.huggingface.co'])
      expect(() => huggingfaceEndpoint(host)).toThrow('POLICY_HF_ENDPOINT_FORBIDDEN')
  })
})

describe('HF 来源清单：带凭据取固定 revision；LFS 身份只认内容 sha256', () => {
  test('授权快照：两个请求都带 Bearer、都打在镜像上；LFS 给 sha256、普通文件给 gitBlob', async () => {
    const weight = 'f'.repeat(64)
    const stub = stubFetch(mirror([{ type: 'directory', path: 'params' }, lfsRow('params/model_state_dict.pt', weight, 11_440_372_444), plainRow('README.md', 'c'.repeat(40), 312)]))
    try {
      await withEnv({ HF_ENDPOINT: MIRROR, HF_TOKEN: TOKEN, HF_HOME: emptyDir() }, async () => {
        const snapshot = await sourceSnapshot('huggingface', MODEL, 'main', MODELSCOPE_ENDPOINT, new AbortController().signal)
        expect(snapshot.resolvedRevision).toBe(COMMIT)
        expect(snapshot.files.map(file => file.path)).toEqual(['params/model_state_dict.pt', 'README.md'])
        const [big, readme] = snapshot.files
        // LFS 大件：身份是内容 sha256（下载时按它核对），bytes 取真实大小而不是指针文件长度。
        expect(big!.sha256).toBe(weight)
        expect(big!.bytes).toBe(11_440_372_444)
        expect(big!.gitBlob).toBeUndefined()
        expect(big!.url).toBe(`${MIRROR}/${MODEL}/resolve/${COMMIT}/params/model_state_dict.pt`)
        // 普通文件：tree 的 oid 就是 git blob sha1，内容侧没有 sha256 声明。
        expect(readme!.gitBlob).toBe('c'.repeat(40))
        expect(readme!.sha256).toBeUndefined()
        expect(readme!.bytes).toBe(312)
        // 目录行不是文件，不进展平清单。
        expect(snapshot.files.some(file => file.path === 'params')).toBe(false)
      })
      // 请求全打在镜像上：不回落官方端点、不吃传进来的 ModelScope endpoint。
      expect(stub.calls.length).toBe(2)
      for (const call of stub.calls) expect(new URL(call.url).origin).toBe(MIRROR)
      for (const call of stub.calls) expect(call.authorization).toBe(`Bearer ${TOKEN}`)
      expect(JSON.stringify(stub.calls.map(call => call.url))).not.toContain('huggingface.co')
    } finally { stub.restore() }
  })

  test('身份掩码：匿名/受限时 lfs.oid 是 64 个 * ⇒ 照实报错，绝不拿指针文件的 git blob 顶替权重 sha256', async () => {
    const masked = 'b'.repeat(40) // 行里的 oid：那是 136 字节指针文件的 git blob
    const stub = stubFetch(mirror([lfsRow('params/model_state_dict.pt', '*'.repeat(64), 11_440_372_444)]))
    try {
      await withEnv({ HF_ENDPOINT: MIRROR, HF_TOKEN: TOKEN, HF_HOME: emptyDir() }, async () => {
        const error = await sourceSnapshot('huggingface', MODEL, 'main', MODELSCOPE_ENDPOINT, new AbortController().signal).then(() => null, (reason: Error) => reason)
        expect(String(error)).toContain('POLICY_SOURCE_IDENTITY_MASKED')
        // 掩码行没有产出任何"文件"：一个字节日志都不给上游留——拒绝比伪造身份好。
        expect(String(error)).not.toContain(masked)
        expect(String(error)).not.toContain(TOKEN)
      })
    } finally { stub.restore() }
  })

  test('身份缺失：既无合法 sha256 也无合法 git blob ⇒ POLICY_SOURCE_IDENTITY_MISSING，不静默降级', async () => {
    const stub = stubFetch(mirror([plainRow('params/model_state_dict.pt', 'not-a-blob', 11_440_372_444)]))
    try {
      await withEnv({ HF_ENDPOINT: MIRROR, HF_HOME: emptyDir(), HF_TOKEN: TOKEN }, async () => {
        expect(String(await sourceSnapshot('huggingface', MODEL, 'main', MODELSCOPE_ENDPOINT, new AbortController().signal).then(() => null, (reason: Error) => reason))).toContain('POLICY_SOURCE_IDENTITY_MISSING')
      })
    } finally { stub.restore() }
  })

  test('凭据缺失/被拒分开报：403 匿名 ⇒ POLICY_HF_AUTH_REQUIRED；带凭据仍 403 ⇒ POLICY_HF_AUTH_REJECTED', async () => {
    const denied = stubFetch(mirror([], 403))
    try {
      await withEnv({ HF_ENDPOINT: MIRROR, HF_HOME: emptyDir(), HF_TOKEN: undefined, HF_TOKEN_PATH: undefined }, async () => {
        expect(String(await sourceSnapshot('huggingface', MODEL, 'main', MODELSCOPE_ENDPOINT, new AbortController().signal).then(() => null, (reason: Error) => reason))).toContain('POLICY_HF_AUTH_REQUIRED')
      })
      for (const call of denied.calls) expect(call.authorization).toBeUndefined() // 没有凭据就不发请求头，也不冒充身份
      denied.calls.length = 0
      await withEnv({ HF_ENDPOINT: MIRROR, HF_HOME: emptyDir(), HF_TOKEN: TOKEN }, async () => {
        expect(String(await sourceSnapshot('huggingface', MODEL, 'main', MODELSCOPE_ENDPOINT, new AbortController().signal).then(() => null, (reason: Error) => reason))).toContain('POLICY_HF_AUTH_REJECTED')
      })
      expect(denied.calls[0]!.authorization).toBe(`Bearer ${TOKEN}`)
    } finally { denied.restore() }
  })

  test('非鉴权类状态码保持原前缀（不把 404 说成授权问题）', async () => {
    const stub = stubFetch(mirror([], 404))
    try {
      await withEnv({ HF_ENDPOINT: MIRROR, HF_HOME: emptyDir(), HF_TOKEN: undefined }, async () => {
        expect(String(await sourceSnapshot('huggingface', MODEL, 'main', MODELSCOPE_ENDPOINT, new AbortController().signal).then(() => null, (reason: Error) => reason))).toContain('POLICY_REMOTE_404')
      })
    } finally { stub.restore() }
  })
})

describe('HF 取件：跨域跳签名 CDN 时丢掉 Bearer，身份仍逐件核对', () => {
  const content = encoder.encode('g05-so101 权重占位内容（测试用）')
  const weight = sha256hex(content)
  const file: SourceFile = { path: 'params/model_state_dict.pt', bytes: content.byteLength, revision: COMMIT, sha256: weight, url: `${MIRROR}/${MODEL}/resolve/${COMMIT}/params/model_state_dict.pt` }

  test('镜像 302 到它自己的 CDN：只第一跳带凭据，第二跳不带；落盘字节与 sha256 逐项核对', async () => {
    const cdn = 'https://us.aws.cdn.hf.test/signed/params?token=presigned'
    const stub = stubFetch(call => call.url.startsWith(MIRROR) ? new Response('', { status: 302, headers: { location: cdn } }) : new Response(content, { status: 200 }))
    try {
      await withEnv({ HF_ENDPOINT: MIRROR, HF_HOME: emptyDir(), HF_TOKEN: TOKEN }, async () => {
        const target = join(emptyDir(), 'params', 'model_state_dict.pt')
        const result = await downloadFile(file, target, new AbortController().signal, false)
        expect(result.sha256).toBe(weight)
        expect(result.bytes).toBe(content.byteLength)
        expect(readFileSync(target)).toEqual(Buffer.from(content))
      })
      expect(stub.calls.map(call => new URL(call.url).origin)).toEqual([MIRROR, 'https://us.aws.cdn.hf.test'])
      // 自己跟跳（manual）：否则 fetch 会自动把 Authorization 一起带过去。
      for (const call of stub.calls) expect(call.redirect).toBe('manual')
      expect(stub.calls[0]!.authorization).toBe(`Bearer ${TOKEN}`)
      expect(stub.calls[1]!.authorization).toBeUndefined() // 令牌不离开配置的那一处 origin
      expect(stub.calls[1]!.url).toContain('presigned') // 中转 URL 自带签名，不需要也不该带我们的令牌
    } finally { stub.restore() }
  })

  test('镜像把字节 308 甩回官方 Hub：**不跟随**（一次请求都不发过去），如实报阻断', async () => {
    // 实测 hf-mirror 在 LFS `/resolve/` 上会回 308 → https://huggingface.co/…：跟着走就是"静默回退官方端点"。
    const official = 'https://huggingface.co/OpenGalaxea/G05/resolve/' + COMMIT + '/params/model_state_dict.pt'
    const stub = stubFetch(call => call.url.startsWith(MIRROR) ? new Response('', { status: 308, headers: { location: official } }) : new Response(content, { status: 200 }))
    try {
      await withEnv({ HF_ENDPOINT: MIRROR, HF_HOME: emptyDir(), HF_TOKEN: TOKEN }, async () => {
        const error = await downloadFile(file, join(emptyDir(), 'params', 'x.pt'), new AbortController().signal, false).then(() => null, (reason: Error) => reason)
        expect(String(error)).toContain('POLICY_HF_REDIRECT_FORBIDDEN')
        expect(String(error)).toContain('huggingface.co') // 报出被拒的目标 host（是"哪一站"，不含凭据）
      })
      expect(stub.calls.length).toBe(1) // 只打了镜像那一跳；官方端点**一次都没打**
      expect(stub.calls.every(call => !call.url.includes('huggingface.co/'))).toBe(true)
    } finally { stub.restore() }
  })

  test('元数据接口被 308 到官方 Hub：同样不跟随（列清单也不行）', async () => {
    const stub = stubFetch(call => call.url.startsWith(MIRROR) ? new Response('', { status: 308, headers: { location: 'https://huggingface.co/api/models/OpenGalaxea/G05/revision/main' } }) : Response.json({ sha: COMMIT }))
    try {
      await withEnv({ HF_ENDPOINT: MIRROR, HF_HOME: emptyDir(), HF_TOKEN: TOKEN }, async () => {
        expect(String(await sourceSnapshot('huggingface', MODEL, 'main', MODELSCOPE_ENDPOINT, new AbortController().signal).then(() => null, (reason: Error) => reason))).toContain('POLICY_HF_REDIRECT_FORBIDDEN')
      })
      expect(stub.calls.length).toBe(1)
      expect(stub.calls.every(call => !call.url.includes('huggingface.co/'))).toBe(true)
    } finally { stub.restore() }
  })

  test('内容与声明身份不符 ⇒ POLICY_SOURCE_CHECKSUM_MISMATCH 且不留半成品', async () => {
    const tampered = encoder.encode('被改过的内容')
    const stub = stubFetch(() => new Response(tampered, { status: 200 }))
    try {
      await withEnv({ HF_ENDPOINT: MIRROR, HF_HOME: emptyDir(), HF_TOKEN: TOKEN }, async () => {
        const target = join(emptyDir(), 'params', 'model_state_dict.pt')
        const error = await downloadFile(file, target, new AbortController().signal, false).then(() => null, (reason: Error) => reason)
        expect(String(error)).toContain('POLICY_SOURCE_CHECKSUM_MISMATCH')
        // .part 留着供续传核对（身份不符时不得改名成正式文件）。
        expect(() => readFileSync(target)).toThrow()
      })
    } finally { stub.restore() }
  })

  test('下载 403 也按"有没有凭据"分：镜像上无凭据 ⇒ REQUIRED；镜像上的签名 CDN 403 ⇒ 原有前缀，不冒充授权问题', async () => {
    const mirrorDenied = stubFetch(() => new Response('', { status: 403 }))
    try {
      await withEnv({ HF_ENDPOINT: MIRROR, HF_HOME: emptyDir(), HF_TOKEN: undefined, HF_TOKEN_PATH: undefined }, async () => {
        expect(String(await downloadFile(file, join(emptyDir(), 'params', 'x.pt'), new AbortController().signal, false).then(() => null, (reason: Error) => reason))).toContain('POLICY_HF_AUTH_REQUIRED')
      })
    } finally { mirrorDenied.restore() }
    const cdnDenied = stubFetch(call => call.url.startsWith(MIRROR) ? new Response('', { status: 302, headers: { location: 'https://cdn.hf.test/signed/x' } }) : new Response('', { status: 403 }))
    try {
      await withEnv({ HF_ENDPOINT: MIRROR, HF_HOME: emptyDir(), HF_TOKEN: TOKEN }, async () => {
        expect(String(await downloadFile(file, join(emptyDir(), 'params', 'x.pt'), new AbortController().signal, false).then(() => null, (reason: Error) => reason))).toContain('POLICY_DOWNLOAD_403')
      })
    } finally { cdnDenied.restore() }
  })
})

describe('HF 取件清单：目录前缀在真实清单上选出件，manifest 不含凭据', () => {
  test('assets/ + params/ 两个前缀选出全部声明件；manifest 里只有坐标/身份，没有令牌', async () => {
    const rows = [
      { type: 'file', path: 'README.md', oid: 'd'.repeat(40), size: 120 },
      { type: 'file', path: '.gitattributes', oid: 'e'.repeat(40), size: 60 },
      plainRow('assets/ur5e/norm_stats.json', 'a'.repeat(40), 1851),
      plainRow('assets/trossen/norm_stats.json', 'f'.repeat(40), 3394),
      lfsRow('params/model.safetensors', '1'.repeat(64), 12_000_000_000),
    ]
    const stub = stubFetch(call => {
      const path = new URL(call.url).pathname
      if (/\/revision\//.test(path)) return Response.json({ id: 'hairuoliu/pi05_base', sha: COMMIT })
      if (/\/tree\//.test(path)) return Response.json(rows)
      return new Response('unexpected ' + call.url, { status: 500 }) // 本用例只读清单，不取件
    })
    try {
      await withEnv({ HF_ENDPOINT: MIRROR, HF_HOME: emptyDir(), HF_TOKEN: TOKEN }, async () => {
        const snapshot = await sourceSnapshot('huggingface', 'hairuoliu/pi05_base', 'main', MODELSCOPE_ENDPOINT, new AbortController().signal)
        const selected = selectSourceFiles(snapshot.files, ['assets/', 'params/'])
        expect(selected.map(file => file.path)).toEqual(['assets/ur5e/norm_stats.json', 'assets/trossen/norm_stats.json', 'params/model.safetensors'])
        // 前缀选不中任何件（或精确路径不在清单里）⇒ 照实报错，不放宽。
        expect(() => selectSourceFiles(snapshot.files, ['ckpt/'])).toThrow('POLICY_FILE_NOT_IN_SOURCE')
        expect(() => selectSourceFiles(snapshot.files, ['README.md/', 'params/'])).toThrow('POLICY_FILE_NOT_IN_SOURCE')
        // 声明里另有的 README/.gitattributes 不在选择范围内：前缀选择不把清单外的东西带进来。
        expect(selected.some(file => file.path === 'README.md' || file.path === '.gitattributes')).toBe(false)
      })
    } finally { stub.restore() }
  })

  test('downloadPolicy：已存在的合法件不重下，manifest 落盘不含凭据、字节数取自清单', async () => {
    const body = JSON.stringify({ ur5e: { state: { mean: [0, 0, 0, 0, 0, 0] } } })
    const bytes = encoder.encode(body)
    const gitBlob = createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
    const row = plainRow('assets/ur5e/norm_stats.json', gitBlob, bytes.byteLength)
    const stub = stubFetch(call => {
      const path = new URL(call.url).pathname
      if (/\/revision\//.test(path)) return Response.json({ id: 'hairuoliu/pi05_base', sha: COMMIT })
      if (/\/tree\//.test(path)) return Response.json([row, plainRow('assets/aloha/norm_stats.json', '2'.repeat(40), 9)])
      return new Response(body, { status: 200 })
    })
    try {
      await withEnv({ HF_ENDPOINT: MIRROR, HF_HOME: emptyDir(), HF_TOKEN: TOKEN }, async () => {
        const dataDirectory = emptyDir()
        const result = await downloadPolicy({ dataDirectory, endpoint: MODELSCOPE_ENDPOINT, provider: 'huggingface', modelId: 'hairuoliu/pi05_base', revision: 'main', files: ['assets/ur5e/norm_stats.json'], signal: new AbortController().signal })
        expect(result.status).toBe('DOWNLOADED')
        expect(result.files.map(file => file.path)).toEqual(['assets/ur5e/norm_stats.json'])
        expect(result.files[0]!.sha256).toBe(sha256hex(bytes))
        expect(result.resolvedRevision).toBe(COMMIT)
        const manifestText = readFileSync(result.manifestPath, 'utf8')
        expect(manifestText).not.toContain(TOKEN)
        expect(manifestText.toLowerCase()).not.toContain('bearer')
        // 路径坐标落在同族布局：policies/huggingface/<id>/<请求 revision>（解析到的 commit 记在 manifest）
        expect(result.path.endsWith(join('policies', 'huggingface', 'hairuoliu__pi05_base', 'main'))).toBe(true)
        // 第二次调用：件已在盘上且身份对得上 ⇒ 不再打任何网络（取件次数就是证据）。
        const before = stub.calls.length
        const again = await downloadPolicy({ dataDirectory, endpoint: MODELSCOPE_ENDPOINT, provider: 'huggingface', modelId: 'hairuoliu/pi05_base', revision: 'main', files: ['assets/ur5e/norm_stats.json'], signal: new AbortController().signal })
        expect(again.status).toBe('DOWNLOADED')
        expect(again.files[0]!.sha256).toBe(sha256hex(bytes))
        // 只多出"重新解析 revision + 取树"两次元数据请求，**没有**再一次下文件。
        expect(stub.calls.slice(before).every(call => !call.url.includes('/resolve/'))).toBe(true)
      })
    } finally { stub.restore() }
  })
})
