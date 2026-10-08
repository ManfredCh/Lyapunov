/**
 * 产品接线回归（任务1）：`src/plugin.ts` 操作面的 packs 分支必须真正走到 `downloadPack()`：
 *
 * 1. `policy_download`（工具入口）接受 provider:'packs' + 模型 id `packs/<packId>`，可选 pieces 原样进 open 请求；
 * 2. 全部网络流量只打我们的能力包端点（catalog/open/stream），鉴权 Bearer $PACK_TOKEN，无任何公开源回落；
 * 3. 错误码（PACK_UNAUTHORIZED/PACK_NOT_FOUND/PACK_MOUNT_EXPIRED/PACK_INTEGRITY_MISMATCH/PACK_PAYMENT_REQUIRED…）
 *    **原样上抛**（同一个 code，不吞不译）；background Jobs 路径同样走到 downloadPack；
 * 4. `policy_search`/`policy_metadata` 只出 catalog 元数据（无字节、无资产 URL）；`policy_files` 读 open mount
 *    快照（manifest.sourceFiles），未下载过给明确 NOT_DOWNLOADED 回执（不为列清单虚开计费 mount）；
 * 5. 既有导出（searchPolicies/matchPolicy/name/inject）保持兼容。
 *
 * fetch mock 沿用 pack-source.test.ts 的 downloadPack fetcher 注入风格；工具入口经 defineTool 的真实
 * execute（含参数 schema 校验）调用，ctx 是最小桩（tools/commands/jobs/effect）。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply, matchPolicy, name, inject, searchPacks, searchPolicies, POLICY_INPUT_INVALID_JSON, POLICY_INPUT_MUST_BE_OBJECT, toolInput } from '../src/plugin.ts'
import { SceneOperations } from '../../scene-kit/src/operations.ts'
import { hashFile, policyDirectory } from '../src/source.ts'
import type { PackFetcher, PackRequestInit } from '../src/pack-source.ts'
import { JobId, type JobHandle, type JobOutcome, type JobSpec } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'

const ENDPOINT = 'http://127.0.0.1:9472/packs/v1' // 合同允许 http://127.0.0.1|localhost 便于测试
const TOKEN = 'test-pack-token' // 假 token（测试注入用；实现不把任何 token 写进文件）
const encoder = new TextEncoder()
const sha256hex = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
const bytesOf = (text: string) => encoder.encode(text)
const emptyDir = () => mkdtempSync(join(tmpdir(), 'policy-pack-plugin-'))
afterEach(() => { delete process.env.PACK_TOKEN })

const PACK_FILES = [
  { path: 'asset/go2.xml', text: '<mujoco model="go2"><worldbody/></mujoco>' },
  { path: 'policy/adapter.json', text: '{"adapter":"pack-plugin-test","frequencyHz":50}' },
]
const defaultListing = () => PACK_FILES.map(file => { const bytes = bytesOf(file.text); return { path: file.path, bytes: bytes.byteLength, sha256: sha256hex(bytes) } })
const streamBytes = (path: string) => {
  const file = PACK_FILES.find(row => row.path === path)
  if (!file) throw new Error('清单外路径: ' + path)
  return bytesOf(file.text)
}
const CATALOG_ENTRY = {
  packId: 'unitree_go2', version: '2026.09.22', family: 'quadruped',
  capabilities: { channels: ['joint', 'gait', 'control'], directControl: 'requiresPolicy' },
  pieces: { asset: true, context: true, policy: true, vla: true },
  status: 'USABLE', licenseSummary: 'Apache-2.0 (model) / see provenance',
  // 别名表（与 packs/aliases.json 同形状的确定性子集）：检索靠它，不靠 JSON 字符串撞运气。
  aliases: [
    { alias: 'Go2', priority: 10, kind: 'model' },
    { alias: '宇树Go2', priority: 10, kind: 'model' },
    { alias: '机器狗', priority: 20, kind: 'family' },
    { alias: 'quadruped', priority: 30, kind: 'family' },
  ],
}

interface Recorded { method: string; url: string; authorization?: string; body?: string }
interface MockOptions {
  packs?: unknown[]
  listing?: unknown[]
  mountId?: string
  streamBytes?: (path: string) => Uint8Array
  fail?: { phase: 'catalog' | 'open' | 'stream'; status: number; code?: string }
}
function mockPackServer(options: MockOptions = {}) {
  const calls: Recorded[] = []
  const fetcher: PackFetcher = async (url: string, init: PackRequestInit) => {
    const recorded: Recorded = { method: init.method ?? 'GET', url, authorization: init.headers?.authorization, body: init.body }
    calls.push(recorded)
    const route = new URL(url).pathname
    const phase: 'catalog' | 'discovery' | 'open' | 'stream' = route.endsWith('/catalog') ? 'catalog' : route.endsWith('/discovery') ? 'discovery' : route.endsWith('/open') ? 'open' : 'stream'
    if (options.fail?.phase === phase) {
      const { status, code } = options.fail
      return new Response(code ? JSON.stringify({ code }) : '', { status })
    }
    if (phase === 'catalog' || phase === 'discovery') return new Response(JSON.stringify({ packs: options.packs ?? [CATALOG_ENTRY] }), { status: 200 })
    if (phase === 'open') {
      const body = JSON.parse(init.body ?? '{}')
      return new Response(JSON.stringify({ mountId: options.mountId ?? 'mnt-77', packId: body.packId, expiresAt: '2026-09-22T00:02:00Z', files: options.listing ?? defaultListing(), budget: { maxBytes: 10_000_000 } }), { status: 200 })
    }
    const path = new URL(url).searchParams.get('path') ?? ''
    return new Response((options.streamBytes ?? streamBytes)(path), { status: 200 })
  }
  return { fetcher, calls }
}

/** 最小 cordis/dsh 桩：只装 apply() 真正用到的面（tools/commands/jobs/effect/reflect）。 */
function fakeCtx() {
  const tools = new Map<string, any>()
  const commands = new Map<string, any>()
  const jobs: JobSpec[] = []
  const provided = new Map<string, any>()
  const ctx = {
    tools: { register: (tool: any) => void tools.set(tool.name, tool) },
    commands: { register: (command: any) => void commands.set(command.name, command) },
    jobs: {
      start: (spec: JobSpec) => { jobs.push(spec); return JobId('job-' + jobs.length) },
      kill: () => {}, wait: async () => undefined,
    },
    effect: () => () => {},
    // 服务面：apply() 现在会 provide `policyModels`（模型路由条目服务），桩如实收下便于断言。
    reflect: { provide: (name: string, service: any) => void provided.set(name, service) },
    get: () => undefined,
  }
  return { ctx, tools, commands, jobs, provided }
}
function boot(mock: ReturnType<typeof mockPackServer>, dataDirectory = emptyDir()) {
  const harness = fakeCtx()
  apply(harness.ctx as any, { dataDirectory, packEndpoint: ENDPOINT, packFetcher: mock.fetcher })
  const id = SessionId('test-agent')
  const exec = { agent: { id, session: { id } }, signal: new AbortController().signal }
  const call = (toolName: string, input: Record<string, unknown>) => {
    const tool = harness.tools.get(toolName)
    expect(tool).toBeDefined()
    return tool.execute({ input }, exec as any)
  }
  // 原始 args 透传（形状归一化用例要能传字符串/数组等**非对象**的 `input`，`call` 只覆盖对象这条腿）。
  const callRaw = (toolName: string, args: unknown) => {
    const tool = harness.tools.get(toolName)
    expect(tool).toBeDefined()
    return tool.execute(args, exec as any)
  }
  return { ...harness, dataDirectory, exec, call, callRaw }
}
const capture = async (run: () => Promise<unknown>): Promise<any> => { try { await run(); return undefined } catch (error) { return error } }
/** 公开来源探针：`provider:"packs"` 的合同是**绝不回落公开源**，故任何打到全局 fetch（ModelScope/GitHub/HF）
 *  的请求都会被记下（返回 599，绝不伪装成功）。与 packFetcher 注入面正交：那条腿只打能力包端点。 */
function stubPublicFetch() {
  const urls: string[] = [], original = globalThis.fetch
  globalThis.fetch = (async (input: any) => { urls.push(String(input)); return new Response('', { status: 599 }) }) as unknown as typeof fetch
  return { urls, restore: () => { globalThis.fetch = original } }
}

describe('plugin 操作面 × packs 源（工具入口 → downloadPack）', () => {
  test('目录命中只给metadata与官方来源检索指引，不反馈行为或自动取整包',async()=>{
    const mock=mockPackServer(),result=await searchPacks({packEndpoint:ENDPOINT,packFetcher:mock.fetcher},{query:'Go2'},new AbortController().signal)
    expect(result.models).toHaveLength(1);expect(result.endpoint).toBe(ENDPOINT)
    expect(mock.calls.map(call=>new URL(call.url).pathname)).toEqual(['/packs/v1/discovery'])
    expect(result.nextSteps[0]).toContain('declared metadata only');expect(result.nextSteps[0]).toContain('Do not inject remote capability context')
    expect(result.nextSteps[0]).toContain('actual missing requirements')
    expect(result.nextSteps[0]).toContain("body's official website or official repository")
    expect(result.nextSteps[0]).toContain('Browser Use keyword search');expect(result.nextSteps[0]).toContain('WebFetch for a known URL')
    expect(result.nextSteps[0]).toContain('no regional, proxy, or adapted endpoint is required')
    expect(result.nextSteps[0]).toContain('client simulation readback')
    expect(result.nextSteps[0]).not.toContain('用 policy_download')
    expect(mock.calls.some(call=>new URL(call.url).pathname.endsWith('/open'))).toBe(false)
  })
  test('policy_download 工具入口 → downloadPack：catalog/open/stream 全走我们的端点，落盘+manifest 无 URL', async () => {
    process.env.PACK_TOKEN = TOKEN
    const mock = mockPackServer()
    const { call, dataDirectory } = boot(mock)
    const result = await call('policy_download', { provider: 'packs', modelId: 'packs/unitree_go2' })

    // 走到 downloadPack 的证据：三端点序列 + mount 快照 revision + 同族布局
    expect(mock.calls.map(row => new URL(row.url).pathname)).toEqual(['/packs/v1/catalog', '/packs/v1/open', '/packs/v1/stream', '/packs/v1/stream'])
    for (const row of mock.calls) { expect(row.url.startsWith(ENDPOINT)).toBe(true); expect(row.authorization).toBe(`Bearer ${TOKEN}`) }
    expect(JSON.parse(mock.calls[1]!.body!)).toEqual({ packId: 'unitree_go2', pieces: ['asset', 'context', 'policy', 'vla'] })
    expect(result.status).toBe('DOWNLOADED')
    expect(result.provider).toBe('packs')
    expect(result.resolvedRevision).toBe('mnt-77')
    expect(result.path.endsWith(join('policies', 'packs', 'packs__unitree_go2', 'master'))).toBe(true)
    for (const file of PACK_FILES) expect(readFileSync(join(result.path, file.path), 'utf8')).toBe(file.text)

    // 负面清单第 2 条：结果与落盘 manifest 不含任何 URL
    expect(JSON.stringify(result.sourceFiles)).not.toContain('http')
    const manifest = JSON.parse(readFileSync(join(result.path, 'manifest.json'), 'utf8'))
    expect(manifest.provider).toBe('packs')
    for (const file of manifest.sourceFiles) expect(file.url).toBeUndefined()
  })

  test('可选 pieces 参数原样进 open 请求；非法 piece ⇒ INVALID_PACK_PIECE 原样上抛', async () => {
    process.env.PACK_TOKEN = TOKEN
    const mock = mockPackServer()
    const { call } = boot(mock)
    await call('policy_download', { provider: 'packs', modelId: 'packs/unitree_go2', pieces: ['asset', 'policy'] })
    expect(JSON.parse(mock.calls[1]!.body!)).toEqual({ packId: 'unitree_go2', pieces: ['asset', 'policy'] })

    const bad = mockPackServer()
    const error = await capture(() => boot(bad).call('policy_download', { provider: 'packs', modelId: 'packs/unitree_go2', pieces: ['assets'] }))
    expect(error?.code).toBe('INVALID_PACK_PIECE')
    expect(bad.calls).toHaveLength(0) // 入口校验先行，不打网络
  })

  test('错误码原样上抛：401→PACK_UNAUTHORIZED、410→PACK_MOUNT_EXPIRED、open 402→PACK_PAYMENT_REQUIRED、404→PACK_NOT_FOUND', async () => {
    process.env.PACK_TOKEN = TOKEN
    const cases: [{ phase: 'catalog' | 'open' | 'stream'; status: number }, string][] = [
      [{ phase: 'catalog', status: 401 }, 'PACK_UNAUTHORIZED'],
      [{ phase: 'stream', status: 410 }, 'PACK_MOUNT_EXPIRED'],
      [{ phase: 'open', status: 402 }, 'PACK_PAYMENT_REQUIRED'],
      [{ phase: 'open', status: 404 }, 'PACK_NOT_FOUND'],
    ]
    for (const [fail, code] of cases) {
      const mock = mockPackServer({ fail })
      const error = await capture(() => boot(mock).call('policy_download', { provider: 'packs', modelId: 'packs/unitree_go2' }))
      expect(error?.code).toBe(code) // 同一个 code 对象上抛，不吞不译
    }
  })

  test('篡改字节 ⇒ PACK_INTEGRITY_MISMATCH 原样上抛，派生件删除（工具入口同 downloadPack 纪律）', async () => {
    process.env.PACK_TOKEN = TOKEN
    const tampered = bytesOf('<mujoco model="go2"><worldbody/></mujoco>'.replace('go2', 'GO2'))
    const mock = mockPackServer({ streamBytes: (path) => path === 'policy/adapter.json' ? tampered : streamBytes(path) })
    const { call, dataDirectory } = boot(mock)
    const error = await capture(() => call('policy_download', { provider: 'packs', modelId: 'packs/unitree_go2' }))
    expect(error?.code).toBe('PACK_INTEGRITY_MISMATCH')
    const root = join(dataDirectory, 'policies', 'packs', 'packs__unitree_go2', 'master')
    expect(readFileSync(join(root, 'manifest.json'), 'utf8')).toContain('PACK_INTEGRITY_MISMATCH')
  })

  test('background=true 走原生 Jobs 仍到 downloadPack（成功与失败两个方向）', async () => {
    process.env.PACK_TOKEN = TOKEN
    const mock = mockPackServer()
    const { call, jobs } = boot(mock)
    const accepted = await call('policy_download', { provider: 'packs', modelId: 'packs/unitree_go2', background: true })
    expect(accepted).toEqual({ status: 'RUNNING', jobId: 'job-1' })
    expect(jobs[0].kind).toBe('policy_download')
    expect(jobs[0].owner).toBe(SessionId('test-agent'))
    const handle = jobs[0].run(valueJob(accepted.jobId))
    expect(typeof handle.cancel).toBe('function')
    const outcome = await handle.done
    expect(outcome.status).toBe('completed')
    expect(JSON.parse(resultOf(outcome)).status).toBe('DOWNLOADED')
    expect(outcome).not.toHaveProperty('output')
    expect(mock.calls.map(row => new URL(row.url).pathname)).toEqual(['/packs/v1/catalog', '/packs/v1/open', '/packs/v1/stream', '/packs/v1/stream'])

    const failing = mockPackServer({ fail: { phase: 'catalog', status: 401 } })
    const { call: call2, jobs: jobs2 } = boot(failing)
    await call2('policy_download', { provider: 'packs', modelId: 'packs/unitree_go2', background: true })
    expect(jobs2[0].owner).toBe(SessionId('test-agent'))
    const failed = await jobs2[0].run(valueJob('job-1')).done
    expect(failed.status).toBe('failed')
    expect(resultOf(failed)).toContain('PACK_UNAUTHORIZED') // 失败也保留错误码
    expect(failed).not.toHaveProperty('output')
  })

  test('policy_search → 只打 catalog（元数据 only），模型 id 投影成 packs/<packId>，无资产 URL', async () => {
    process.env.PACK_TOKEN = TOKEN
    const mock = mockPackServer()
    const { call } = boot(mock)
    const result = await call('policy_search', { provider: 'packs', query: 'go2 quadruped' })
    expect(mock.calls.map(row => new URL(row.url).pathname)).toEqual(['/packs/v1/catalog'])
    expect(result.provider).toBe('packs')
    expect(result.plane).toBe('authenticated-catalog')
    expect(result.status).toBe('MATCHES')
    expect(result.models).toHaveLength(1)
    expect(result.models[0].id).toBe('packs/unitree_go2')
    expect(result.models[0].displayName).toBe('unitree_go2')
    expect(result.models[0].pieces).toEqual(CATALOG_ENTRY.pieces)
    expect(JSON.stringify(result.models)).not.toContain('http')

    const none = await call('policy_search', { provider: 'packs', query: '不存在的包' })
    expect(none.status).toBe('NO_MATCH')
  })

  test('policy_search → 中文说法/别名真能命中（旧实现只做 JSON 字符串匹配，『宇树Go2』必然 NO_MATCH）', async () => {
    process.env.PACK_TOKEN = TOKEN
    const mock = mockPackServer()
    const { call } = boot(mock)
    for (const [query, field] of [['宇树Go2', 'alias:宇树go2'], ['机器狗', 'alias:机器狗'], ['go2', 'alias:go2'], ['quadruped', 'alias:quadruped']] as const) {
      const result = await call('policy_search', { provider: 'packs', query })
      expect(result.status).toBe('MATCHES')
      expect(result.models[0].id).toBe('packs/unitree_go2')
      expect(result.models[0].matchedBy).toContain(field)
    }
    // 空 query = 列出全部条目（发现用途）；多词 = 全部词都要命中（每个词独立归一化，不再被拼成一整串）
    expect((await call('policy_search', { provider: 'packs', query: '' })).models).toHaveLength(1)
    expect((await call('policy_search', { provider: 'packs', query: '宇树 Go2 四足' })).status).toBe('NO_MATCH')
  })

  test('policy_search → 无 PACK_TOKEN 走公开 discovery 面（不带任何凭据，只出元数据）', async () => {
    delete process.env.PACK_TOKEN
    const mock = mockPackServer()
    const { call } = boot(mock)
    const result = await call('policy_search', { provider: 'packs', query: '宇树Go2' })
    expect(mock.calls.map(row => new URL(row.url).pathname)).toEqual(['/packs/v1/discovery'])
    expect(mock.calls.every(row => row.authorization === undefined)).toBe(true)
    expect(result.plane).toBe('public-discovery')
    expect(result.status).toBe('MATCHES')
    expect(result.models[0].id).toBe('packs/unitree_go2')
  })

  test('policy_metadata → catalog 条目（含来源字段不丢失）；无该 packId ⇒ PACK_NOT_FOUND', async () => {
    process.env.PACK_TOKEN = TOKEN
    const mock = mockPackServer()
    const { call } = boot(mock)
    const entry = await call('policy_metadata', { provider: 'packs', modelId: 'packs/unitree_go2' })
    expect(entry.family).toBe('quadruped')
    expect(entry.capabilities).toEqual(CATALOG_ENTRY.capabilities)
    expect(entry.licenseSummary).toBe(CATALOG_ENTRY.licenseSummary)
    expect(entry.id).toBe('packs/unitree_go2')

    const missing = mockPackServer({ packs: [{ packId: 'other_pack', pieces: { asset: true } }] })
    const error = await capture(() => boot(missing).call('policy_metadata', { provider: 'packs', modelId: 'packs/unitree_go2' }))
    expect(error?.code).toBe('PACK_NOT_FOUND')
    expect(missing.calls.map(row => new URL(row.url).pathname)).toEqual(['/packs/v1/catalog'])
  })

  test('未知 pack 的 metadata/search 不借同族 T0 机型或 ready 字段返回成功', async () => {
    process.env.PACK_TOKEN = TOKEN
    const mock = mockPackServer({ packs: [{ ...CATALOG_ENTRY, tier: 'T0', contentReady: true, adapterReady: true, behaviorVerified: true }] })
    const { call } = boot(mock)
    const error = await capture(() => call('policy_metadata', { provider: 'packs', modelId: 'packs/unitree_go3' }))
    expect(error?.code).toBe('PACK_NOT_FOUND')
    const result = await call('policy_search', { provider: 'packs', query: 'unitree_go3' })
    expect(result.status).toBe('NO_MATCH')
    expect(result.models).toEqual([])
    expect(mock.calls.map(row => new URL(row.url).pathname)).toEqual(['/packs/v1/catalog', '/packs/v1/catalog'])
  })

  test('policy_files → open mount 快照（manifest.sourceFiles）；未下载 ⇒ NOT_DOWNLOADED 回执（不虚开计费 mount）', async () => {
    process.env.PACK_TOKEN = TOKEN
    const mock = mockPackServer()
    const { call } = boot(mock)

    const before = await call('policy_files', { provider: 'packs', modelId: 'packs/unitree_go2' })
    expect(before.status).toBe('NOT_DOWNLOADED')
    expect(before.files).toEqual([])
    expect(before.nextSteps.length).toBeGreaterThan(0)
    expect(mock.calls.map(row => new URL(row.url).pathname)).toEqual([]) // 不为列清单打 open

    await call('policy_download', { provider: 'packs', modelId: 'packs/unitree_go2' })
    const after = await call('policy_files', { provider: 'packs', modelId: 'packs/unitree_go2' })
    expect(after.status).toBe('LISTED_FROM_MOUNT_SNAPSHOT')
    expect(after.resolvedRevision).toBe('mnt-77')
    expect(after.files.map((file: any) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 }))).toEqual(defaultListing())
    for (const file of after.files) expect(file.revision).toBe('mnt-77') // mount 快照句柄，无 URL
  })

  test('模型 id 约定校验：provider:packs 必须配 packs/<packId>；缺 PACK_TOKEN ⇒ PACK_TOKEN_MISSING', async () => {
    const mock = mockPackServer()
    const badId = await capture(() => boot(mock).call('policy_download', { provider: 'packs', modelId: 'unitree_go2' }))
    expect(String(badId?.message)).toContain('INVALID_POLICY_MODEL_ID')

    process.env.PACK_TOKEN = TOKEN
    const wrongPrefix = await capture(() => boot(mock).call('policy_download', { provider: 'packs', modelId: 'huggingface/unitree_go2' }))
    expect(wrongPrefix?.code).toBe('INVALID_PACK_MODEL_ID')
    delete process.env.PACK_TOKEN

    const noToken = await capture(() => boot(mock).call('policy_download', { provider: 'packs', modelId: 'packs/unitree_go2' }))
    expect(noToken?.code).toBe('PACK_TOKEN_MISSING')
  })

  test('既有导出保持兼容：name/inject、searchPolicies、matchPolicy 原样可导入', () => {
    expect(name).toBe('lyapunov-policy-registry')
    expect(inject).toEqual(['tools', 'commands', 'jobs'])
    expect(typeof searchPolicies).toBe('function')
    expect(typeof searchPacks).toBe('function')
    expect(typeof matchPolicy).toBe('function')
  })
})
describe('本地策略来源与工具参数边界',()=>{
 test('正规bundle未满足许可时只读检查保留具体阻断与全部缺项，不联网',async()=>{
  const mock=mockPackServer(),h=boot(mock)
  const s=await h.call('policy_load_state',{manifest:{schema:'robot-download/v1',downloadReady:false,missingFiles:['POLICY_LICENSE'],missingLicense:['fixed-policy-weight-source']}})
  expect(s.ready).toBe(false);expect(s.missing[0].code).toBe('ROBOT_DOWNLOAD_NOT_READY');expect(s.missing[0].detail).toContain('POLICY_LICENSE');expect(s.missing[0].detail).toContain('fixed-policy-weight-source');expect(mock.calls).toHaveLength(0)
 })
 test('同一固定身份的flat与nested工具输入都保留modelId/provider/revision，缺权重不联网',async()=>{
  const mock=mockPackServer(),h=boot(mock),id={provider:'github',modelId:'jloganolson/g1_23dof_locomotion_isaac',revision:'fbfa38706b817e2d4b19e444db95ae7fb2537b46'},probe=stubPublicFetch()
  try{
   const flat=await h.callRaw('policy_load_state',id),nested=await h.callRaw('policy_load_state',{input:{identity:id}})
   expect(flat.modelId).toBe(id.modelId);expect(nested.modelId).toBe(id.modelId);expect(flat.evidence.adapterImplemented).toBe(true);expect(nested.evidence.adapterImplemented).toBe(true);expect(flat.ready).toBe(false);expect(nested.ready).toBe(false)
   const verified=await h.call('policy_verify',{identity:id});expect(verified.status).toBe('MISSING');expect(verified.root).toContain(id.revision)
   expect(mock.calls).toHaveLength(0);expect(probe.urls).toEqual([])
  }finally{probe.restore()}
 })
 test('冲突来源身份与混合input包装明确拒绝，不静默选一个来源',async()=>{
  const h=boot(mockPackServer()),id={provider:'github',modelId:'x/y',revision:'fixed'}
  const conflict=await capture(()=>h.call('policy_load_state',{identity:id,modelId:'other/model'}));expect(String(conflict)).toContain('POLICY_IDENTITY_CONFLICT')
  const mixed=await capture(()=>h.callRaw('policy_prepare',{input:id,sceneId:'s'}));expect(String(mixed)).toContain('mixed flat and nested input')
 })
 test('真实机器人导入保存冷重开后，原prepare入口把当前同策略派生路径绑定回已登记本体，不接纳改写或其它本体',async()=>{
  const box=emptyDir(),identity={provider:'github' as const,modelId:'Improbable-AI/walk-these-ways',revision:'0e7236bdc81ce855cbe3d70345a7899452bdeb1c'},cache=join(box,'cache'),sceneRoot=join(box,'scene')
  try{
   const original=join(box,'robot','go1.xml');mkdirSync(dirname(original),{recursive:true})
   writeFileSync(original,'<mujoco model="test-go1"><worldbody><body name="trunk"><freejoint/><geom type="box" size="0.1 0.05 0.03"/></body></worldbody></mujoco>')
   const ops=new SceneOperations(sceneRoot),scene=await ops.create({template:'blank'}),imported=await ops.import({path:original,sceneId:scene.sceneId,entityId:'go1',alignBottomToSurface:false,storage:'reference'})
   const registered=(await ops.inspect(scene.sceneId)).entities.find(e=>e.entityId==='go1')!,modelPath=join(policyDirectory(cache,identity.provider,identity.modelId,identity.revision),'derived','wtw-go1-torchscript-v1','go1-position-pd.xml')
   mkdirSync(dirname(modelPath),{recursive:true});writeFileSync(modelPath,readFileSync(original,'utf8').replace('test-go1','test-go1-adapter'))
   const adapter={adapter:'wtw-go1-torchscript-v1',modelPath,modelSourcePath:original,modelSha256:(await hashFile(modelPath)).sha256,sourceProvider:identity.provider,sourceModelId:identity.modelId,sourceRevision:identity.revision,jointNames:[],config:{},observations:{},frequencyHz:50}
   const adapterFile=join(dirname(dirname(modelPath)),'adapter.json');writeFileSync(adapterFile,JSON.stringify(adapter))
   await ops.scene.commit({sceneId:scene.sceneId,expectedRevision:imported.snapshot!.revision,patch:[{op:'update',entityId:'go1',changes:{components:{...registered.components,mujoco:{sourcePath:modelPath},controller:{policyAdapter:adapter.adapter}}}}]})
   const saved=join(box,'saved','scene.json');await ops.save(scene.sceneId,saved)
   const cold=new SceneOperations(sceneRoot),reopened=await cold.open(saved),entity=reopened.entities.find(e=>e.entityId==='go1')!
   expect(entity.resources).toEqual(registered.resources);expect(entity.components.mujoco).toMatchObject({sourcePath:modelPath})
   expect(await cold.resources.verifyReference(entity.resources[0]!)).toEqual({valid:true,missing:[],changed:[]})
   const h=fakeCtx();h.ctx.get=((name:string)=>name==='scene'?{forSession:()=>cold}:undefined) as any;apply(h.ctx as any,{dataDirectory:cache})
   const tool=h.tools.get('policy_prepare'),exec={agent:{session:{id:'cold-go1',header:{id:'cold-go1',cwd:box}}},signal:new AbortController().signal}
   const call=(extra:Record<string,unknown>={})=>tool.execute({input:{identity,sceneId:scene.sceneId,entityId:'go1',...extra}},exec)
   // 无权重的离线夹具到达原下一阶段；不把来源通过冒充真实 PREPARED 或运动。
   expect(String(await capture(()=>call()))).toContain('POLICY_FILES_NOT_VERIFIED')
   expect(String(await capture(()=>call({robotModelPath:original})))).toContain('POLICY_FILES_NOT_VERIFIED')
   const other=join(box,'another.xml');writeFileSync(other,readFileSync(original));expect(String(await capture(()=>call({robotModelPath:other})))).toContain('POLICY_ROBOT_SOURCE_MISMATCH')
   writeFileSync(modelPath,readFileSync(modelPath,'utf8')+'<!-- changed -->');expect(String(await capture(()=>call()))).toContain('POLICY_ROBOT_SOURCE_NOT_AUTHORIZED')
   expect(h.jobs).toHaveLength(0);expect(entity.resources[0]!.resourceId).toBe(imported.resource.ref.resourceId)
  }finally{rmSync(box,{recursive:true,force:true})}
 })
 test('只读会话policy_execute先拒绝，不创建Jobs或查询/改变世界',async()=>{
  const h=fakeCtx();h.ctx.get=((name:string)=>name==='sandboxPolicy'?{resolve:()=>({mode:'read-only',workspaceRoot:'/fixture'})}:undefined) as any
  apply(h.ctx as any,{dataDirectory:emptyDir()})
  const tool=h.tools.get('policy_execute'),exec={agent:{session:{id:'readonly'}},signal:new AbortController().signal}
  const error=await capture(()=>tool.execute({input:{identity:{provider:'github',modelId:'x/y',revision:'pin'},sceneId:'s',worldId:'w',entityId:'r',expectedGeneration:1}},exec))
  expect(String(error)).toContain('SCENE_POLICY_READ_ONLY');expect(h.jobs).toHaveLength(0)
 })
})

/** 本用例只消费生产者的结束正文；若改成流式生产者，必须补对应原生Ring验收。 */
const valueJob = (id: string): JobHandle => ({
  id: JobId(id),
  append() { throw new Error('PACK_FIXTURE_UNEXPECTED_STREAM') },
  updateProgress() { throw new Error('PACK_FIXTURE_UNEXPECTED_PROGRESS') },
})
const resultOf = (outcome: JobOutcome): string => {
  if (typeof outcome.result !== 'string') throw new Error('PACK_FIXTURE_TERMINAL_RESULT_MISSING')
  return outcome.result
}

/**
 * 工具入参归一化（回执 §6.1/§7.1）：`parameters.input` 是 `type:'json'` ⇒ **JSON 字符串也是合法形状**，
 * 真实模型正是这么传的。此前执行体直传 `args.input`，字符串时 `input.provider` 读不到 ⇒ 静默回落 ModelScope
 * （`policy_search` 回 `provider:"modelscope"`）或抛 `INVALID_POLICY_MODEL_ID`（`policy_download`）。
 * 这里钉死三件事：字符串与对象**落同一条路径**、`provider:"packs"` 时**没有任何请求发往公开源**、
 * 坏 JSON 或非对象形状**明确报错**（不得悄悄用默认 provider）。
 */
describe('plugin 工具入参归一化（JSON 字符串 ≡ 对象；坏形状显式报错）', () => {
  test('policy_search：JSON 字符串与对象逐字等价，且不回落公开源（无任何请求发往 ModelScope）', async () => {
    process.env.PACK_TOKEN = TOKEN
    const mock = mockPackServer(), probe = stubPublicFetch()
    try {
      const { call, callRaw } = boot(mock)
      const fromString = await callRaw('policy_search', { input: '{"provider":"packs","query":"宇树Go2"}' })
      const fromObject = await call('policy_search', { provider: 'packs', query: '宇树Go2' })
      // 两条路径同一份结果（这正是修复点：字符串不得被读成"没给 provider"）。
      expect(fromString).toEqual(fromObject)
      expect(fromString.provider).toBe('packs')
      expect(fromString.query).toBe('宇树Go2')
      expect(fromString.status).toBe('MATCHES')
      expect(fromString.models[0].id).toBe('packs/unitree_go2')
      // 网络痕迹：只有 catalog；公开源 0 次（旧行为会打 https://modelscope.cn/openapi/v1/models）。
      expect(mock.calls.map(row => new URL(row.url).pathname)).toEqual(['/packs/v1/catalog', '/packs/v1/catalog'])
      expect(probe.urls).toEqual([])
      // 注册点统一归一化，其余工具同一条腿（metadata 读 catalog 条目）。
      const entry = await callRaw('policy_metadata', { input: '{"provider":"packs","modelId":"packs/unitree_go2"}' })
      expect(entry.family).toBe('quadruped')
      expect(entry.id).toBe('packs/unitree_go2')
    } finally { probe.restore() }
  })

  test('policy_download：JSON 字符串把来源参数原样交给既有下载器（小夹具全文落盘，不取大权重）', async () => {
    process.env.PACK_TOKEN = TOKEN
    const mock = mockPackServer(), probe = stubPublicFetch()
    try {
      const { callRaw, dataDirectory } = boot(mock)
      const result = await callRaw('policy_download', { input: '{"provider":"packs","modelId":"packs/unitree_go2","pieces":["asset","policy"]}' })
      // 与对象路径同一条 downloadPack 腿：catalog/open/stream×2，且 pieces 原样进 open 请求。
      expect(mock.calls.map(row => new URL(row.url).pathname)).toEqual(['/packs/v1/catalog', '/packs/v1/open', '/packs/v1/stream', '/packs/v1/stream'])
      expect(JSON.parse(mock.calls[1]!.body!)).toEqual({ packId: 'unitree_go2', pieces: ['asset', 'policy'] })
      for (const row of mock.calls) expect(row.authorization).toBe(`Bearer ${TOKEN}`)
      expect(result.status).toBe('DOWNLOADED')
      expect(result.provider).toBe('packs')
      expect(result.path.endsWith(join('policies', 'packs', 'packs__unitree_go2', 'master'))).toBe(true)
      // 落盘的就是夹具里这两个小件（无权重字节、无公开源请求）。
      for (const file of PACK_FILES) expect(readFileSync(join(dataDirectory, 'policies', 'packs', 'packs__unitree_go2', 'master', file.path), 'utf8')).toBe(file.text)
      expect(probe.urls).toEqual([])
    } finally { probe.restore() }
  })

  test('坏 JSON / 非对象形状显式报错：不静默回落默认 provider，也不打任何网络', async () => {
    const cases: [unknown, string][] = [
      ['{not json', POLICY_INPUT_INVALID_JSON],
      ['[]', POLICY_INPUT_MUST_BE_OBJECT],
      ['{"provider":"packs"', POLICY_INPUT_INVALID_JSON], // 截断的 JSON
      ['"packs"', POLICY_INPUT_MUST_BE_OBJECT],          // 解析成标量
      ['123', POLICY_INPUT_MUST_BE_OBJECT],
      [['provider', 'packs'], POLICY_INPUT_MUST_BE_OBJECT], // 直传数组（非字符串路径）
      [true, POLICY_INPUT_MUST_BE_OBJECT],
    ]
    for (const [input, code] of cases) {
      const mock = mockPackServer(), probe = stubPublicFetch()
      try {
        for (const tool of ['policy_search', 'policy_download']) {
          const error = await capture(() => boot(mock).callRaw(tool, { input }))
          expect(String(error?.message)).toContain(code)
          // 「不得悄悄使用默认 provider」的行为面：能力包端点 0 次、公开源 0 次 —— 没有请求就没有回落。
          expect(mock.calls).toHaveLength(0)
          expect(probe.urls).toEqual([])
        }
      } finally { probe.restore() }
    }
    // 纯函数面：对象原样返回（不复制、不改写），缺省沿用既有 `?? {}` 语义。
    const object = { provider: 'packs', query: '宇树Go2' }
    expect(toolInput(object)).toBe(object)
    expect(toolInput(undefined)).toEqual({})
    expect(toolInput(null)).toEqual({})
  })
})
