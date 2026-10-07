/**
 * blender_run / blender_texture_search / blender_job_images 的真实行为测试
 * （前台 / 后台 DSH Jobs / 结果判定 / 参数透传 / 图片附件化与投递 / 取消 / 任务工作区 cwd）。
 *
 * 运行器口径（**实测，不是照抄历史**）：文件用 `node:test`。本机 `node v24.20.0` 直接支持类型剥离，
 *   `node --test packages/blender/test/blender-run.test.ts` 可跑（本单实测 exit=0）；而
 *   `bun test` 在**加载期**就崩：`@deepseek-ai/dsh-subprocess-local` 静态
 *   `import { getSystemErrorMessage } from 'node:util'`，bun 1.3.13 的 `node:util` 没有该导出
 *   （`SyntaxError: Export named 'getSystemErrorMessage' not found`，0 pass / 1 error）——
 *   与产品源码无关的环境事实，改动前后逐字相同（日志见 `.runtime/lane-env57c/`）。
 *   命令：（可用）`node --test packages/blender/test/blender-run.test.ts`
 *
 * 覆盖面与诚实边界：
 *  - 单元部分不碰进程：结果行判定（含"退出码 0 但没有结果行"、"旧产物存在"、非法 JSON、取消）、
 *    多图路径读取、argv 形状（`--operation` / `--cameras` JSON / `--resolution` JSON / `--samples` /
 *    `--python-exit-code 1` 出现在任何 `--python` 之前）。
 *  - 真实程序部分：真实 Blender（`BLENDER_EXECUTABLE` 或 PATH 上的 `blender`）跑 `world.py --fixture`
 *    （+ `--render`），经**真实 ToolRegistry** 调用 `blender_run`，断言结果行、产物文件、图像附件与
 *    真实失败路径（用户脚本抛异常）。
 *  - **真实 Agent**：owner 是 `@deepseek-ai/dsh-agent-loop-testkit` 创建的**生产 AgentLoop agent**
 *    （真 Session、真 Inbox）。后台作业完成时投递的那条附图消息，是在这个真 agent 的 inbox 上
 *    (`claim('next-step')`) 读出来断言的——不是自建存根里的数组。
 *    有一条测试额外装**原生 `@deepseek-ai/dsh-tool-jobs`**（默认 wakeup 投递），用来核对唤醒账目：
 *    空闲 owner 的驱动被完成通知唤醒一次，在同一次 claim 里同时取走"本插件的附图消息（inject，
 *    next-step 车道）"和"原生完成通知（followup，next-turn 车道）"——图片投递不额外开轮。
 *    诚实声明：这里**不发起任何模型请求**（没有 LLM adapter），所以本文件证明的是
 *    "图片作为 ContentBlock 进了真实会话的下一步消息"，**不是**"某个模型真的看懂了图"。
 *  - 假可执行文件（一个打印日志的 sh 脚本）只用于"进程层事实"的负路径：退出码 0 但没有结果行、
 *    非零退出码带 stderr、取消。它**不**代表 Blender 行为，只验证产品判据。
 *  - 贴图联网路径用**本地夹具 HTTP 服务**（`config.textureApiBase`）验证：本机沙箱无外网出口，
 *    "真实 api.polyhaven.com 未验证"。
 *  - 本文件不覆盖 world.py 的 `--operation preview|export` 语义（由另一份任务在 world.py 内实现，
 *    本工作树的 world.py 尚无该 CLI）；这里验证的是插件把参数**逐字**传下去。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { deflateSync } from 'node:zlib'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { apply, blenderArgv, resumeArgv } from '../src/plugin.ts'
import { compareFacts, type DrawingReport } from '../src/drawing-input.ts'
import { attachResultImages, finishBlenderRun, lastResultLine, resultImagePaths, sniffImageMediaType } from '../src/result.ts'
import type { BlenderFinish } from '../src/result.ts'

const BLENDER = process.env.BLENDER_EXECUTABLE ?? 'blender'
const WORLD_SCRIPT = fileURLToPath(new URL('../src/world.py', import.meta.url))
/** 结果行前缀：与产品源文件里的 `RESULT_PREFIX` 同一个字面量（这里独立写一次，协议漂移要失败）。 */
const PREFIX = 'LYAPUNOV_RESULT='

/** 真实 Blender 是否可用：不可用时只跳过"真实程序"那几条，单元判据必须照跑。 */
const blenderAvailable = (() => {
  try { return spawnSync(BLENDER, ['--version'], { stdio: 'ignore' }).status === 0 } catch { return false }
})()
const skipWithoutBlender = blenderAvailable ? false : `Blender 不可用：${BLENDER}`

interface ToolCall { isError?: boolean; value?: { result?: string }; content?: Array<{ type: string; text?: string }> }
interface JobCall { jobId: string; outputDirectory?: string; cwd?: string }
/** 注入/落进会话的一条消息（只读这里断言要用到的部分）。 */
interface InboxMessage { content: Array<{ type: string; text?: string; attachment?: unknown }>; source?: { kind?: string; plugin?: string; form?: string; summary?: string } }
interface Harness {
  ctx: Context
  /** **生产 AgentLoop agent**（真 Session / 真 Inbox）：后台作业的 owner 就是它。 */
  agent: Agent
  /** 经真实工具注册表调用产品工具；返回模型看到的规范化结果。 */
  call(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolCall>
  /** 同上，但用别的工具名/别的调用者（用于 blender_texture_search / blender_job_images 与 owner 隔离）。 */
  callTool(name: string, args: Record<string, unknown>, options?: { caller?: Agent; signal?: AbortSignal }): Promise<ToolCall>
  /** 把 owner 的下一步待处理消息按真实 Inbox 的 claim 取出来（投递是否真的进了会话，看这里）。 */
  claimNextStep(agent?: Agent): InboxMessage[]
  /** 还没被取走的下一步 / 下一轮消息条数（用来证明没有额外唤醒）。 */
  pending(agent?: Agent): { nextStep: number; nextTurn: number }
  /** 创建第二个 agent（另一个会话）：用于 owner 隔离测试。 */
  createAgent(id: string, cwd?: string): Promise<Agent>
  /** 真实附件服务实际保存的图片名（真图才存得下，假图会被它解码拒绝）。 */
  images: string[]
  /** 重载实际产品插件，原生 Registry 与 owner 生命周期保持。 */
  reloadPlugin(): Promise<void>
  dispose(): Promise<void>
}

async function createHarness(options: { executable?: string; workspace?: string; sessionCwd?: string; textureApiBase?: string; attachments?: boolean; toolJobs?: boolean; onSaveImage?: (name: string) => Promise<void> | void }): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(SubprocessLocal)
  // 真实前置服务：LlmRuntime / SessionStore / SessionProjection / SystemPrompt / ToolRuntime(工具注册表) / AgentRegistry。
  // 本文件**不注册任何 LLM adapter**：不发起模型请求，测试只驱动工具与消息投递。
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JobsLocal)
  // 原生 tool-jobs：它自己订阅 settled 事件，是"作业完成后唤醒 owner"的**唯一**来源。
  // 只在这条测试里装，用来证明本插件投递图片时没有重复唤醒（默认 wakeup 投递）。
  if (options.toolJobs === true) await ctx.plugin(ToolJobs as never, undefined as never)
  ctx.jobs.attachController('blender-run-test')
  const dshHome = await mkdtemp(join(tmpdir(), 'blender-run-attachments-'))
  // 附件服务是**真实实现**（saveImage 会真的解码并落盘），只在外面记一笔"存了哪几张"。
  // attachments:false 用来验证"没装配附件服务时结果里如实报失败"，而不是静默没有图。
  if (options.attachments !== false) await ctx.plugin(AttachmentLocal, { dshHome } as never)
  const images: string[] = []
  const attachments = ctx.get('attachments') as { saveImage(input: { name: string }): Promise<unknown> } | undefined
  if (attachments) {
    const saveImage = attachments.saveImage.bind(attachments)
    // onSaveImage 在**真保存之前**跑：测试用它把"附件保存是慢的"这一事实摆到台面上
    // （例如在保存途中 job_kill），验证取消不会被"图已经附件化好了"抢先。
    attachments.saveImage = async (input: { name: string }) => {
      if (options.onSaveImage) await options.onSaveImage(input.name)
      const ref = await saveImage(input); images.push(input.name); return ref
    }
  }
  const mountPlugin = () => ctx.plugin({
    name: 'test-blender',
    inject: ['tools', 'subprocess', 'jobs'],
    apply: (scoped: Context) => { apply(scoped, { executable: options.executable ?? BLENDER, workspace: options.workspace, textureApiBase: options.textureApiBase }) },
  } as never, undefined as never)
  let pluginFiber = await mountPlugin()
  const tools = ctx.get('tools') as { execute(input: unknown): Promise<ToolCall> }
  // 生产 AgentLoop：agent/session 由它创建并注册，后台作业的 owner 因此是**注册表里的活 agent**
  // （jobs-local 的 ensureOwnerCleanup 要求的正是这一条）。
  const loop = await mountAgentLoopTestHarness(ctx)
  const createAgent = async (id: string, cwd?: string): Promise<Agent> => await loop.create(SessionId(id), {}, cwd === undefined ? {} : { cwd })
  const agent = await createAgent('blender-run-test', options.sessionCwd)
  let callId = 0
  const run = async (name: string, caller: Agent, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolCall> =>
    await tools.execute({ signal: signal ?? new AbortController().signal, callId: ToolCallId(`blender-test-${++callId}`), name, agent: caller, arguments: args })
  const inbox = (target: Agent): { nextStep: InboxMessage[]; nextTurn: InboxMessage[] } => (target as unknown as { inbox: { nextStep: InboxMessage[]; nextTurn: InboxMessage[] } }).inbox
  return {
    ctx,
    agent,
    images,
    async reloadPlugin() { await pluginFiber.dispose(); pluginFiber = await mountPlugin() },
    async call(args, signal) { return await run('blender_run', agent, args, signal) },
    async callTool(name, args, callInfo) { return await run(name, callInfo?.caller ?? agent, args, callInfo?.signal) },
    claimNextStep(caller = agent) { return loop.claim(caller, 'next-step', 1) as unknown as InboxMessage[] },
    pending(caller = agent) { const box = inbox(caller); return { nextStep: box.nextStep.length, nextTurn: box.nextTurn.length } },
    createAgent,
    async dispose() {
      await ctx.fiber.dispose().catch(() => undefined)
      await rm(dshHome, { recursive: true, force: true })
    },
  }
}

/** 成功调用从 `value.result` 取结果文本，失败调用从错误内容取（用于读失败原因）。 */
function resultText(call: ToolCall): string {
  return call.isError === true ? (call.content ?? []).map(block => block.text ?? '').join('\n') : String(call.value?.result ?? '')
}

/** 假可执行文件：只造"进程层事实"，用来验证判据本身（不代表 Blender 行为）。 */
async function fakeExecutable(directory: string, body: string): Promise<string> {
  const path = join(directory, 'fake-blender.sh')
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return path
}

test('blender_run：模型多行代码误填python_script时在实际SDK边界明确拒绝，不按文件名执行', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-inline-shape-'))
  const executable = await fakeExecutable(directory, `echo '${PREFIX}{"unexpected":true}'`)
  const harness = await createHarness({ executable, workspace: directory, attachments: false })
  try {
    const call = await harness.call({ output_directory: 'ground', python_script: 'import bpy\nbpy.ops.mesh.primitive_cube_add()\n', render: false })
    assert.equal(call.isError, true)
    assert.match(resultText(call), /BLENDER_SCRIPT_PATH_EXPECTED/)
    assert.doesNotMatch(resultText(call), /File name too long/)
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('blender_run：相对python_script/source_blend不存在时在执行前明确拒绝，不创建任何作业记录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-missing-input-'))
  const executable = await fakeExecutable(directory, `echo '${PREFIX}{"unexpected":true}'`)
  const harness = await createHarness({ executable, workspace: directory, attachments: false })
  const jobsOf = (): unknown[] => (harness.ctx as unknown as { jobs: { list(owner?: string): unknown[] } }).jobs.list(harness.agent.id)
  try {
    // 相对路径按真实会话任务工作区解析；这里 workspace=directory，缺失脚本必须在起进程前被拒。
    const missingScript = await harness.call({ output_directory: 'out', python_script: 'missing-script.py', background: true })
    assert.equal(missingScript.isError, true)
    assert.match(resultText(missingScript), /BLENDER_INPUT_MISSING/)
    assert.match(resultText(missingScript), /python_script/)
    assert.deepEqual(jobsOf(), [], '缺失输入不得创建后台作业记录（否则会留下永远 running 的作业）')

    const missingBlend = await harness.call({ output_directory: 'out', source_blend: 'missing.blend' })
    assert.equal(missingBlend.isError, true)
    assert.match(resultText(missingBlend), /BLENDER_INPUT_MISSING/)
    assert.match(resultText(missingBlend), /source_blend/)
    assert.deepEqual(jobsOf(), [])
    const directoryInput=await harness.call({output_directory:'out',python_script:directory,background:true})
    assert.equal(directoryInput.isError,true)
    assert.match(resultText(directoryInput),/BLENDER_INPUT_MISSING/)
    assert.deepEqual(jobsOf(),[],'目录不是可执行的Python输入文件')
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('blender_run：原生Job在进程运行期间可读实际stdout/stderr，render=false不承诺PNG',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'blender-stream-'))
 const executable=await fakeExecutable(directory,`printf 'modelling-started\\n'\nprintf 'script-diagnostic\\n' >&2\nsleep 1\nprintf '${PREFIX}{"scene":"ok"}\\n'`)
 const harness=await createHarness({executable,workspace:directory,attachments:false})
 try{
  const call=await harness.call({output_directory:'out',background:true,render:false})
  assert.equal(call.isError,false)
  const receipt=JSON.parse(String(call.value?.result))
  assert.equal(receipt.worldRenderRequested,false);assert.equal(receipt.previewExpected,false)
  assert.match(receipt.note,/Python script may render on its own/)
  assert.match(receipt.note,/Pausing a Goal does not pause/)
  await new Promise(r=>setTimeout(r,400))
  const jobs=harness.ctx.jobs,view=jobs.get(receipt.jobId,harness.agent.id)
  assert.equal(view.status,'running')
  const output=jobs.readAt(receipt.jobId,0,harness.agent.id)
  assert.ok(output.chunks.some(c=>c.channel==='stdout'&&c.text.includes('modelling-started')))
  assert.ok(output.chunks.some(c=>c.channel==='stderr'&&c.text.includes('script-diagnostic')))
  await jobs.wait(receipt.jobId,3000,harness.agent.id)
  assert.equal(jobs.get(receipt.jobId,harness.agent.id).status,'completed')
 }finally{await harness.dispose();await rm(directory,{recursive:true,force:true})}
})

/** 最小合法 PNG（1×1）：附件服务会真的解码，随便写几个字节过不了。 */
function tinyPng(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = (() => { let value = 0xffffffff; for (const byte of body) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)) } return (value ^ 0xffffffff) >>> 0 })()
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc)
    return Buffer.concat([length, body, checksum])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 真实的 2×2 JPEG（用 PIL 离线生成后内嵌，632 字节）。
 * 为什么需要一个**真 JPEG**：Poly Haven 的预览图常常就是 JPEG，而 textures.ts 侧把缩略图一律写成
 * `<assetId>.thumb.png`——按扩展名声明类型会被附件服务的解码器拒绝，必须按魔数识别。
 */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCaiiivlT6Y/9k=',
  'base64',
)

// ── 1. 结束判定：前台与后台共用同一份 ──────────────────────────────────────────/** 取"完成"分支；不是完成就带着真实判定文本失败（顺带做类型收窄）。 */
function completed(finish: BlenderFinish): Extract<BlenderFinish, { status: 'completed' }> {
  if (finish.status !== 'completed') assert.fail(`期望 completed，实际 ${finish.status}：${finish.error}`)
  return finish
}

/** 取"失败"分支（killed/failed 都算），并断言具体状态。 */
function failed(finish: BlenderFinish, status: 'killed' | 'failed'): Extract<BlenderFinish, { error: string }> {
  if (finish.status === 'completed') assert.fail(`期望 ${status}，实际 completed：${finish.result}`)
  assert.equal(finish.status, status)
  return finish
}

test('finishBlenderRun：退出码 0 + 结果行才算完成，取最后一条并容忍 CRLF', () => {
  const stdout = `Blender 5.2.2 LTS\nFra:1 Mem:10M\n${PREFIX}{"scene":"/w/scene.json","entities":19}\r\n`
  const finish = completed(finishBlenderRun({ exitCode: 0, signal: null, stdout, stderr: 'Blender quit' }, PREFIX))
  assert.equal(finish.value.entities, 19)
  assert.equal(finish.result, '{"scene":"/w/scene.json","entities":19}')

  const twoLines = `${PREFIX}{"entities":1}\nlog\n${PREFIX}{"entities":2}\n`
  assert.equal(lastResultLine(twoLines, PREFIX), `${PREFIX}{"entities":2}`)
})

test('finishBlenderRun：退出码 0 但没有结果行 → failed', () => {
  const finish = failed(finishBlenderRun({ exitCode: 0, signal: null, stdout: 'Blender quit\n', stderr: '' }, PREFIX), 'failed')
  assert.match(finish.error, /BLENDER_OUTPUT_MISSING/)
})

test('finishBlenderRun：非零退出码 → failed，并保留 stderr 里的 traceback', () => {
  const finish = failed(finishBlenderRun({ exitCode: 1, signal: null, stdout: 'noise', stderr: 'Traceback (most recent call last):\nRuntimeError: 脚本炸了' }, PREFIX), 'failed')
  assert.match(finish.error, /BLENDER_FAILED/)
  assert.match(finish.error, /退出码 1/)
  assert.match(finish.error, /RuntimeError: 脚本炸了/)
})

test('finishBlenderRun：取消（自己的信号已触发 / 被信号杀死）→ killed，即使结果行齐全', () => {
  const stdout = `${PREFIX}{"entities":19}\n`
  failed(finishBlenderRun({ exitCode: 0, signal: null, stdout, stderr: '', cancelled: true }, PREFIX), 'killed')
  const signalled = failed(finishBlenderRun({ exitCode: null, signal: 'SIGTERM', stdout, stderr: '' }, PREFIX), 'killed')
  assert.match(signalled.error, /BLENDER_CANCELLED/)
  assert.match(signalled.error, /SIGTERM/)
})

test('finishBlenderRun：结果行不是合法 JSON 或不是对象 → failed', () => {
  const broken = failed(finishBlenderRun({ exitCode: 0, signal: null, stdout: `${PREFIX}{"entities":\n`, stderr: '' }, PREFIX), 'failed')
  assert.match(broken.error, /BLENDER_RESULT_INVALID/)
  const array = failed(finishBlenderRun({ exitCode: 0, signal: null, stdout: `${PREFIX}[1,2]\n`, stderr: '' }, PREFIX), 'failed')
  assert.match(array.error, /JSON 对象/)
})

// ── 2. 多机位结果：真实路径读取 ────────────────────────────────────────────────
test('resultImagePaths：preview + extraRenders（字符串或带 path 的对象）去重并受上限约束', () => {
  const value = { preview: '/w/preview.png', extraRenders: ['/w/cam-a.png', { camera: 'cam-b', path: '/w/cam-b.png' }, '/w/cam-a.png', 7, {}] }
  assert.deepEqual(resultImagePaths(value, 4), ['/w/preview.png', '/w/cam-a.png', '/w/cam-b.png'])
  assert.deepEqual(resultImagePaths(value, 2), ['/w/preview.png', '/w/cam-a.png'])
  assert.deepEqual(resultImagePaths({}, 4), [])
  assert.deepEqual(resultImagePaths(undefined, 4), [])
})

// ── 3. argv 形状：参数到 world.py CLI 的逐字映射 ───────────────────────────────
test('blenderArgv：默认 build 不加 --operation（world.py 的 CLI 默认就是 build），脚本报错必须非零退出', () => {
  const argv = blenderArgv({ worldScript: WORLD_SCRIPT, output: '/w/out' })
  assert.deepEqual(argv.slice(0, 2), [process.env.BLENDER_EXECUTABLE ?? 'blender', '--background'])
  assert.ok(argv.includes('--factory-startup'))
  assert.equal(argv.includes('--operation'), false)
  assert.deepEqual(argv.slice(argv.indexOf('--')), ['--', '--output', '/w/out'])
  // `--python-exit-code 1` 必须在任何 `--python` 之前，Blender 才会把脚本异常变成非零退出码。
  assert.ok(argv.indexOf('--python-exit-code') < argv.indexOf('--python'))
  assert.equal(argv[argv.indexOf('--python-exit-code') + 1], '1')
})

test('blenderArgv：operation / cameras / resolution / samples 逐字透传，用户脚本在 world.py 之前', () => {
  const argv = blenderArgv({
    worldScript: WORLD_SCRIPT, output: '/w/out', sourceBlend: '/w/source.blend', pythonScript: '/w/user.py',
    operation: 'preview', cameraNames: ['exterior_camera', 'courtyard_camera'], resolution: [1280, 720], samples: 64,
    fixture: true, architecture: true, render: true,materialColors:'{"Yellow":[1,.7,.02,1]}',
  })
  assert.equal(argv.includes('--factory-startup'), false, '有 source_blend 时不能再起空工程')
  assert.ok(argv.includes('/w/source.blend'))
  assert.deepEqual(argv.slice(argv.indexOf('--operation'), argv.indexOf('--operation') + 2), ['--operation', 'preview'])
  assert.deepEqual(argv.slice(argv.indexOf('--cameras'), argv.indexOf('--cameras') + 2), ['--cameras', '["exterior_camera","courtyard_camera"]'])
  assert.deepEqual(argv.slice(argv.indexOf('--resolution'), argv.indexOf('--resolution') + 2), ['--resolution', '[1280,720]'])
  assert.deepEqual(argv.slice(argv.indexOf('--samples'), argv.indexOf('--samples') + 2), ['--samples', '64'])
  assert.deepEqual(argv.slice(argv.indexOf('--material-colors'),argv.indexOf('--material-colors')+2),['--material-colors','{"Yellow":[1,.7,.02,1]}'])
  assert.deepEqual(argv.slice(argv.indexOf('--python'), argv.indexOf('--python') + 2), ['--python', '/w/user.py'])
  assert.ok(argv.indexOf('--python-exit-code') < argv.indexOf('--python'))
  assert.ok(argv.indexOf('/w/user.py') < argv.indexOf(WORLD_SCRIPT), '用户脚本必须先于 world.py 执行')
  for (const flag of ['--fixture', '--architecture', '--render']) assert.ok(argv.includes(flag), `${flag} 应透传`)

  const exporting = blenderArgv({ worldScript: WORLD_SCRIPT, output: '/w/out', operation: 'export' })
  assert.equal(exporting[exporting.length - 2], '--operation')
  assert.equal(exporting[exporting.length - 1], 'export')
  assert.equal(exporting.includes('--render'), false)
})

// ── 3b. 工具层直通：模型给的参数真的进了子进程 argv ─────────────────────────────
test('工具层直通：operation / camera_names / resolution / samples 真的进了子进程 argv', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-passthrough-'))
  const capture = join(directory, 'argv.txt')
  // 假可执行文件只干两件事：把收到的 argv 落盘、打一条结果行——验证的是**产品真的传了什么**。
  const executable = await fakeExecutable(directory, `printf '%s\\n' "$@" > '${capture}'\nprintf 'LYAPUNOV_RESULT={"scene":"/w/scene.json"}\\n'`)
  const harness = await createHarness({ executable })
  const readArgv = async (): Promise<string[]> => (await readFile(capture, 'utf8')).split('\n').filter(line => line.length > 0)
  try {
    const output = join(directory, 'world')
    const call = await harness.call({
      output_directory: output, operation: 'preview',
      camera_names: ['exterior_camera', 'courtyard_camera'], resolution: [1280, 720], samples: 64,
    })
    assert.equal(call.isError, false, resultText(call))
    const argv = await readArgv()
    assert.deepEqual(argv.slice(argv.indexOf('--operation'), argv.indexOf('--operation') + 2), ['--operation', 'preview'])
    assert.deepEqual(argv.slice(argv.indexOf('--cameras'), argv.indexOf('--cameras') + 2), ['--cameras', '["exterior_camera","courtyard_camera"]'])
    assert.deepEqual(argv.slice(argv.indexOf('--resolution'), argv.indexOf('--resolution') + 2), ['--resolution', '[1280,720]'])
    assert.deepEqual(argv.slice(argv.indexOf('--samples'), argv.indexOf('--samples') + 2), ['--samples', '64'])
    assert.deepEqual(argv.slice(argv.indexOf('--output'), argv.indexOf('--output') + 2), ['--output', output])

    // 显式 export 同样逐字下去，且不隐式加 --render。
    await harness.call({ output_directory: output, operation: 'export' })
    const exporting = await readArgv()
    assert.deepEqual(exporting.slice(exporting.indexOf('--operation'), exporting.indexOf('--operation') + 2), ['--operation', 'export'])
    assert.equal(exporting.includes('--render'), false)

    // 缺省调用不带 --operation：build 由 world.py 自己的 CLI 默认承担（同一份合同）。
    const defaulted = await harness.call({ output_directory: output })
    assert.equal(defaulted.isError, false, resultText(defaulted))
    assert.equal((await readArgv()).includes('--operation'), false)
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('参数校验：坏形状在起进程之前报 BLENDER_ARGUMENT_INVALID，不把非法值丢给 world.py', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-badargs-'))
  const harness = await createHarness({ executable: await fakeExecutable(directory, `printf 'LYAPUNOV_RESULT={"scene":"/w/scene.json"}\\n'`) })
  try {
    // 形状/类型不对由工具 schema 先拦（工具层合同）……
    const schemaLevel: Record<string, unknown>[] = [{ samples: 1.5 }, { resolution: ['1280', 720] }]
    for (const bad of schemaLevel) {
      const call = await harness.call({ output_directory: join(directory, 'world'), ...bad })
      assert.equal(call.isError, true, `应拒绝 ${JSON.stringify(bad)}：${resultText(call)}`)
      assert.match(resultText(call), /invalid arguments/, `类型问题应在参数合同层拦下：${JSON.stringify(bad)}`)
    }
    // ……类型合法但取值不合约（零/负数/长度不对/空相机名）由本工具的边界校验拦，理由指向参数本身。
    const semanticLevel: Record<string, unknown>[] = [
      { resolution: [0, 480] }, { resolution: [640] }, { resolution: [1280, 720, 1] },
      { samples: 0 }, { samples: -3 },
      { camera_names: [''] }, { camera_names: ['   '] },
    ]
    for (const bad of semanticLevel) {
      const call = await harness.call({ output_directory: join(directory, 'world'), ...bad })
      assert.equal(call.isError, true, `应拒绝 ${JSON.stringify(bad)}：${resultText(call)}`)
      assert.match(resultText(call), /BLENDER_ARGUMENT_INVALID/, `拒绝原因应指向参数本身：${JSON.stringify(bad)}`)
    }
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

/**
 * 尺度自检的读数边界（只报告、不阻断，也不冒充几何验证）：
 *  · 工具描述与读数都不能说"参照一致 ⇒ 标定可信"——参照彼此一致只证明**你给的这几个数内部一致**；
 *  · 每个参照必须同时给出正的 pixels 与 metres，缺一个就跳过并点名，不是"有一个就用一个"；
 *  · 全都不合约时明确报 SCALE_ANCHORS_INVALID，而不是给一个空读数和一句"自洽"。
 */
test('scale_anchors：读数只说"输入自洽、实际尺寸仍待独立核对"，不说标定可信；缺项跳过并点名', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-scale-'))
  const harness = await createHarness({ executable: await fakeExecutable(directory, `printf '${PREFIX}{"scene":"/w/scene.json"}\\n'`) })
  const scaleCheckRaw = async (raw: string): Promise<Record<string, unknown>> => {
    const call = await harness.call({ output_directory: join(directory, 'world'), scale_anchors: raw })
    assert.equal(call.isError, false, resultText(call))
    const parsed = JSON.parse(String(call.value?.result)) as { scaleCheck: Record<string, unknown> }
    return parsed.scaleCheck
  }
  const scaleCheckOf = async (anchors: unknown): Promise<Record<string, unknown>> => await scaleCheckRaw(JSON.stringify(anchors))
  try {
    // 模型看到的那份描述本身也不能许诺"标定可信"：参数说明是模型判断读数含义的唯一依据。
    const schema = (harness.ctx.get('tools') as unknown as { schemas(): Array<{ name: string; description?: string; parameters?: { properties?: Record<string, { description?: string }> } }> }).schemas().find(entry => entry.name === 'blender_run')
    const description = schema?.parameters?.properties?.scale_anchors?.description ?? ''
    assert.match(description, /Every reference must provide positive pixels and metres/, '英文参数说明仍要求 pixels 与 metres 必须同时给且为正')
    assert.match(description, /This does not verify actual dimensions.*Independently check dimensions/, '英文参数说明仍明确这不是几何验证')
    assert.doesNotMatch(description, /calibration is reliable|confirms? (?:the )?dimensions|dimensions are correct/i, '不能把"参照一致"说成标定可信')

    // ① 两个参照彼此一致：读数只声明**输入自洽**，并明确把"实际尺寸"留给独立核对。
    const consistent = await scaleCheckOf([
      { name: '门高', pixels: 500, metres: 2 },
      { name: '层高', pixels: 750, metres: 3 },
    ])
    assert.equal(consistent.disagreementPercent, 0)
    const reading = String(consistent.reading)
    assert.match(reading, /输入参照彼此自洽/)
    assert.match(reading, /实际尺寸仍待独立核对/)
    assert.doesNotMatch(reading, /标定可信|可信|已验证/, '参照一致不等于实际尺寸被验证过')
    assert.equal(consistent.skipped, undefined)

    // ② 缺 metres（只有 pixels）的参照被跳过并点名，剩下的照常给读数——不用半个参照凑数。
    const partial = await scaleCheckOf([
      { name: '门高', pixels: 500, metres: 2 },
      { name: '层高', pixels: 750 },
      { name: '窗宽', pixels: 0, metres: 1.2 },
    ])
    assert.deepEqual(partial.skipped, ['层高', '窗宽'])
    assert.match(String(partial.reading), /只有一个参照：无法互校/)

    // ③ 全部不合约：明确报 SCALE_ANCHORS_INVALID，不装作"自洽"。
    const invalid = await scaleCheckOf([{ name: '比例尺', pixels: -100, metres: 0 }])
    assert.equal(invalid.error, 'SCALE_ANCHORS_INVALID: 没有任何参照同时给出正的 pixels 与 metres')
    assert.deepEqual(invalid.skipped, ['比例尺'])
    // ④ 不是合法 JSON：UNREADABLE，且不阻断本次调用（结果行其余字段照常）。
    const unreadable = await scaleCheckRaw('{不是 JSON')
    assert.match(String(unreadable.error), /SCALE_ANCHORS_UNREADABLE/)
    // 合法 JSON 但不是数组：EMPTY（与上一条分开：解析失败和形状不对不是同一件事）。
    const empty = await scaleCheckRaw('"not json at all"')
    assert.match(String(empty.error), /SCALE_ANCHORS_EMPTY/)
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

// ── 4. 真实 Blender：前台成功路径 + 任务工作区 cwd ─────────────────────────────
test('前台真实 Blender：operation=preview 多机位真的渲染出多张图，全部作为图像附件进上下文（且不导出）', { skip: skipWithoutBlender }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-fg-preview-'))
  const harness = await createHarness({})
  try {
    const output = join(directory, 'world')
    const call = await harness.call({
      output_directory: output,
      architecture: true,
      operation: 'preview',
      camera_names: ['exterior_camera', 'courtyard_camera'],
      resolution: [160, 120],
      samples: 1,
    })
    assert.equal(call.isError, false, resultText(call))
    const parsed = JSON.parse(String(call.value?.result)) as {
      operation: string
      exported: boolean
      renderMode: string
      preview: string
      extraRenders: string[]
      images: { requested: number; attached: number; skipped: string[]; delivery: string; deliveryError?: string }
    }
    // preview 的世界合约：只渲染、不全量导出（scene.json/GLB 不写）。
    assert.equal(parsed.operation, 'preview')
    assert.equal(parsed.exported, false)
    assert.equal(existsSync(join(output, 'scene.json')), false, 'preview 不做全量导出')
    assert.equal(parsed.renderMode, 'multi-camera')
    assert.equal(existsSync(parsed.preview), true, `第一个机位的图必须真实落盘：${parsed.preview}`)
    assert.equal(parsed.extraRenders.length, 1)
    assert.equal(existsSync(parsed.extraRenders[0] as string), true)
    // 两张机位图都进上下文（不是只带一张、也不是只给路径）。
    assert.deepEqual(parsed.images, { requested: 2, attached: 2, failures: [], skipped: [], delivery: 'tool-result' })
    assert.equal((call.content ?? []).filter(block => block.type === 'image').length, 2)
    assert.deepEqual(harness.images.slice().sort(), [parsed.extraRenders[0], parsed.preview].map(path => path?.split('/').pop()).sort())
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('前台真实 Blender：fixture + render 经真实工具注册表产出结果行、产物与图像附件', { skip: skipWithoutBlender }, async () => {
  const harness = await createHarness({})
  const directory = await mkdtemp(join(tmpdir(), 'blender-run-fg-'))
  try {
    const output = join(directory, 'world')
    const call = await harness.call({ output_directory: output, fixture: true, render: true })
    assert.equal(call.isError, false, resultText(call))
    const parsed = JSON.parse(String(call.value?.result)) as { source: string; scene: string; preview?: string; entities: number; visuals: number }
    assert.ok(parsed.entities > 0 && parsed.visuals > 0)
    for (const path of [parsed.source, parsed.scene, join(output, 'physics/world.xml')]) assert.ok(existsSync(path), `${path} 应真实存在`)
    assert.equal(parsed.preview, join(output, 'preview.png'))
    assert.ok((await stat(parsed.preview!)).size > 0)
    // 渲染图真的作为图像块进了模型上下文（真实附件服务解码通过），文本块在前。
    const images = (call.content ?? []).filter(block => block.type === 'image')
    assert.equal(images.length, 1)
    assert.deepEqual(harness.images, ['preview.png'])
    assert.equal((call.content ?? [])[0]?.type, 'text')
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('前台真实 Blender：相对 output_directory / python_script 按会话任务工作区解析并真实执行', { skip: skipWithoutBlender }, async () => {
  const sessionCwd = await mkdtemp(join(tmpdir(), 'blender-session-'))
  const otherRoot = await mkdtemp(join(tmpdir(), 'blender-other-'))
  const harness = await createHarness({ sessionCwd, workspace: otherRoot })
  try {
    await writeFile(join(sessionCwd, 'user-script.py'), [
      'import bpy',
      'bpy.ops.mesh.primitive_cube_add(size=0.5, location=(3, 0, 1))',
      "bpy.context.object.name = 'from_script'",
      '',
    ].join('\n'))
    const call = await harness.call({ output_directory: 'task-world', python_script: 'user-script.py' })
    assert.equal(call.isError, false, resultText(call))
    const parsed = JSON.parse(String(call.value?.result)) as { scene: string }
    // 输出落在**会话工作区**下，而不是插件配置的 workspace（更不是产品根）。
    assert.equal(parsed.scene, join(sessionCwd, 'task-world/scene.json'))
    assert.equal(existsSync(join(otherRoot, 'task-world')), false)
    const scene = JSON.parse(await readFile(parsed.scene, 'utf8')) as { entities: Array<{ name: string }> }
    assert.ok(scene.entities.some(entity => entity.name === 'from_script'), '用户脚本必须真的按任务工作区路径被执行')
  } finally {
    await harness.dispose()
    await rm(sessionCwd, { recursive: true, force: true })
    await rm(otherRoot, { recursive: true, force: true })
  }
})

test('无会话工作区也无 workspace 时，相对路径明确报错而不是悄悄落产品根', async () => {
  const harness = await createHarness({})
  try {
    const call = await harness.call({ output_directory: 'relative-dir' })
    assert.equal(call.isError, true)
    assert.match(resultText(call), /BLENDER_CWD_UNRESOLVED/)
  } finally { await harness.dispose() }
})

test('前台真实 Blender：用户脚本抛异常必须失败（--python-exit-code 1），失败文本带真实 traceback', { skip: skipWithoutBlender }, async () => {
  const sessionCwd = await mkdtemp(join(tmpdir(), 'blender-fail-'))
  const harness = await createHarness({ sessionCwd })
  try {
    await writeFile(join(sessionCwd, 'boom.py'), 'raise RuntimeError("blender-run-test-boom")\n')
    const call = await harness.call({ output_directory: 'failed-world', python_script: 'boom.py' })
    assert.equal(call.isError, true, '脚本挂了不能算成功')
    const text = resultText(call)
    assert.match(text, /BLENDER_FAILED/)
    assert.match(text, /blender-run-test-boom/)
    assert.equal(existsSync(join(sessionCwd, 'failed-world/scene.json')), false, '失败的运行不应留下可被误读的产物')
  } finally {
    await harness.dispose()
    await rm(sessionCwd, { recursive: true, force: true })
  }
})

// ── 5. 进程层负路径（假可执行文件）：旧产物不报成功、stderr 保留 ─────────────────
test('退出码 0 但没有结果行：即使输出目录里已有旧产物也必须失败', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-stale-'))
  const harness = await createHarness({ executable: await fakeExecutable(directory, 'printf "Blender quit\\n"') })
  try {
    const output = join(directory, 'world')
    await mkdir(output, { recursive: true })
    await writeFile(join(output, 'scene.json'), '{"entities":[{"name":"上次的旧场景"}]}')
    await writeFile(join(output, 'preview.png'), tinyPng())
    const call = await harness.call({ output_directory: output, render: true })
    assert.equal(call.isError, true)
    assert.match(resultText(call), /BLENDER_OUTPUT_MISSING/)
    assert.equal(harness.images.length, 0, '旧 preview.png 不能被当成这次的结果带回上下文')
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('非零退出码：失败文本保留 stderr（Blender 的 traceback 只在这里）', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-exit3-'))
  const harness = await createHarness({ executable: await fakeExecutable(directory, 'printf "Traceback (most recent call last):\\nRuntimeError: fake-traceback\\n" >&2\nprintf "partial stdout\\n"\nexit 3') })
  try {
    const call = await harness.call({ output_directory: join(directory, 'world') })
    assert.equal(call.isError, true)
    const text = resultText(call)
    assert.match(text, /BLENDER_FAILED/)
    assert.match(text, /退出码 3/)
    assert.match(text, /RuntimeError: fake-traceback/)
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

// ── 6. 取消 ──────────────────────────────────────────────────────────────────
test('前台取消：工具调用信号一触发就终止子进程并报 BLENDER_CANCELLED', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-fg-cancel-'))
  const harness = await createHarness({ executable: await fakeExecutable(directory, 'sleep 30') })
  try {
    const controller = new AbortController()
    const pending = harness.call({ output_directory: join(directory, 'world') }, controller.signal)
    setTimeout(() => controller.abort(), 300)
    const call = await pending
    assert.equal(call.isError, true)
    assert.match(resultText(call), /BLENDER_CANCELLED/)
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('前台取消：进程已完成、**附件保存期间**信号触发 → 报取消且不返回结果（图也不进上下文）', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-fg-cancel-attach-'))
  const preview = join(directory, 'preview.png')
  await writeFile(preview, tinyPng())
  const controller = new AbortController()
  // 附件保存是收尾的最后一个异步步骤：取消正落在这里时，前面的渲染结果已经齐了、图也真的存下来了，
  // 唯一还能拦住"把图当成本次产出交回去"的就是投递前的那道检查。
  const harness = await createHarness({
    executable: await fakeExecutable(directory, `printf '${PREFIX}%s\\n' '{"scene":"${join(directory, 'scene.json')}","preview":"${preview}"}'`),
    onSaveImage: () => controller.abort(),
  })
  try {
    const call = await harness.call({ output_directory: join(directory, 'world'), render: true }, controller.signal)
    assert.equal(call.isError, true, '已取消的调用不能报成功')
    assert.match(resultText(call), /BLENDER_CANCELLED/)
    assert.match(resultText(call), /附件化阶段/)
    assert.deepEqual(call.content?.filter(block => block.type === 'image'), [], '取消的调用不返回图像块')
    assert.ok(harness.images.includes('preview.png'), '附件确实存下来了（取消发生在附件化之后）——靠的是投递门，不是"碰巧没图"')
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('后台取消：job_kill 真的终止子进程，作业落 killed 而不是 completed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-bg-cancel-'))
  const harness = await createHarness({ executable: await fakeExecutable(directory, 'sleep 30') })
  try {
    const call = await harness.call({ output_directory: join(directory, 'world'), background: true })
    assert.equal(call.isError, false, resultText(call))
    const job = JSON.parse(String(call.value?.result)) as JobCall
    assert.match(job.jobId, /^blender-\d+$/)
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(harness.ctx.jobs.kill(job.jobId as never, harness.agent?.id, '测试取消'), 'requested')
    const snapshot = await harness.ctx.jobs.wait(job.jobId as never, 10_000, harness.agent?.id)
    assert.equal(snapshot.status, 'killed')
    assert.match((harness.ctx.jobs.read(job.jobId as never, harness.agent?.id).result ?? ''), /BLENDER_CANCELLED/)
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

// ── 7. 后台 DSH Jobs：与前台共用同一条结果判据 ─────────────────────────────────
test('后台作业：进程失败必须落 failed，输出保留原因（退出码 0 无结果行 / 非零退出码）', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-bg-fail-'))
  const harness = await createHarness({ executable: await fakeExecutable(directory, 'printf "Blender quit\\n"') })
  try {
    const output = join(directory, 'world')
    await mkdir(output, { recursive: true })
    await writeFile(join(output, 'scene.json'), '{"entities":[{"name":"旧场景"}]}')
    const call = await harness.call({ output_directory: output, background: true })
    assert.equal(call.isError, false, resultText(call))
    const job = JSON.parse(String(call.value?.result)) as JobCall
    const snapshot = await harness.ctx.jobs.wait(job.jobId as never, 15_000, harness.agent?.id)
    assert.equal(snapshot.status, 'failed', '退出码 0 但没有 LYAPUNOV_RESULT 行必须是 failed')
    assert.match((harness.ctx.jobs.read(job.jobId as never, harness.agent?.id).result ?? ''), /BLENDER_OUTPUT_MISSING/)
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }

  const exit3 = await mkdtemp(join(tmpdir(), 'blender-bg-exit3-'))
  const harness3 = await createHarness({ executable: await fakeExecutable(exit3, 'printf "RuntimeError: bg-fail\\n" >&2\nexit 2') })
  try {
    const call = await harness3.call({ output_directory: join(exit3, 'world'), background: true })
    const job = JSON.parse(String(call.value?.result)) as JobCall
    const snapshot = await harness3.ctx.jobs.wait(job.jobId as never, 15_000, harness3.agent?.id)
    assert.equal(snapshot.status, 'failed')
    const text = (harness3.ctx.jobs.read(job.jobId as never, harness3.agent?.id).result ?? '')
    assert.match(text, /BLENDER_FAILED/)
    assert.match(text, /RuntimeError: bg-fail/, '后台失败同样保留 stderr')
  } finally {
    await harness3.dispose()
    await rm(exit3, { recursive: true, force: true })
  }
})

test('后台作业：真实 Blender 小场景完成后，job_output 给出与前台同一条结果行', { skip: skipWithoutBlender }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-bg-real-'))
  const harness = await createHarness({})
  try {
    const output = join(directory, 'world')
    const call = await harness.call({ output_directory: output, fixture: true, background: true, render: false })
    assert.equal(call.isError, false, resultText(call))
    const job = JSON.parse(String(call.value?.result)) as JobCall
    assert.equal(job.outputDirectory, output)
    const snapshot = await harness.ctx.jobs.wait(job.jobId as never, 120_000, harness.agent?.id)
    assert.equal(snapshot.status, 'completed')
    const parsed = JSON.parse((harness.ctx.jobs.read(job.jobId as never, harness.agent?.id).result ?? '')) as { scene: string; entities: number }
    assert.ok(parsed.entities > 0)
    assert.ok(existsSync(parsed.scene))
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

// ── 8. 多机位结果：多张真图都进上下文 ─────────────────────────────────────────
test('多机位结果：preview + extraRenders 按真实路径全部附件化（图像块数与保存名一致）', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-multi-'))
  const names = ['preview.png', 'cam-a.png', 'cam-b.png']
  for (const name of names) await writeFile(join(directory, name), tinyPng())
  const result = JSON.stringify({
    source: join(directory, 'source.blend'),
    scene: join(directory, 'scene.json'),
    preview: join(directory, 'preview.png'),
    extraRenders: [{ camera: 'cam-a', path: join(directory, 'cam-a.png') }, join(directory, 'cam-b.png')],
  })
  const harness = await createHarness({ executable: await fakeExecutable(directory, `printf '${PREFIX}%s\\n' '${result}'`) })
  try {
    const call = await harness.call({ output_directory: directory })
    assert.equal(call.isError, false, resultText(call))
    assert.equal((call.content ?? []).filter(block => block.type === 'image').length, 3, 'preview 与两张机位图都应作为图像块返回')
    // 附件服务是并发的，保存完成次序不保证；这里比的是"保存了哪几张"，不是保存次序。
    assert.deepEqual([...harness.images].sort(), [...names].sort())
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

// ── 9. 图片附件化的**如实读数**：render 跑完 ≠ 模型看见图 ────────────────────────
test('sniffImageMediaType：按魔数识别 PNG/JPEG/WebP/GIF，认不出来就是认不出来', () => {
  assert.equal(sniffImageMediaType(tinyPng()), 'image/png')
  assert.equal(sniffImageMediaType(TINY_JPEG), 'image/jpeg')
  assert.equal(sniffImageMediaType(Buffer.from('RIFF____WEBP', 'latin1')), 'image/webp')
  assert.equal(sniffImageMediaType(Buffer.from('GIF89a....', 'latin1')), 'image/gif')
  assert.equal(sniffImageMediaType(Buffer.from('LYAPUNOV_RESULT={}.png', 'latin1')), undefined)
  assert.equal(sniffImageMediaType(Buffer.alloc(0)), undefined)
})

test('attachResultImages：没有附件服务也如实记失败，不静默返回空数组', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-attach-none-'))
  try {
    const preview = join(directory, 'preview.png')
    await writeFile(preview, tinyPng())
    const { refs, report } = await attachResultImages(undefined, [preview], 4, 'tool-result')
    assert.deepEqual(refs, [])
    assert.equal(report.requested, 1)
    assert.equal(report.attached, 0)
    assert.match(report.failures[0]?.reason ?? '', /没有装配附件服务/)
    assert.equal(report.delivery, 'tool-result')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('attachResultImages：不是图像 / 文件不在 都逐条记因；超过上限的进 skipped', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-attach-bad-'))
  try {
    const real = join(directory, 'preview.png'), text = join(directory, 'not-an-image.png')
    await writeFile(real, tinyPng())
    await writeFile(text, 'LYAPUNOV_RESULT={"scene":"/w/scene.json"}\n')
    const missing = join(directory, 'vanished.png')
    const saveImage = async (input: { name: string }): Promise<unknown> => ({ name: input.name })
    const { refs, report } = await attachResultImages({ saveImage }, [real, text, missing, join(directory, 'fifth.png')], 3, 'tool-result')
    assert.equal(report.requested, 4)
    assert.equal(report.attached, 1)
    assert.equal(refs.length, 1)
    assert.match(report.failures[0]?.reason ?? '', /不是可识别的图像/)
    assert.match(report.failures[1]?.reason ?? '', /ENOENT/)
    assert.deepEqual(report.skipped, [join(directory, 'fifth.png')], '超上限的路径要如实点名，不能假装都带了')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('前台 render：结果里带 images 读数（attached 才是真的进了上下文），图像块数与之一致', { skip: skipWithoutBlender }, async () => {
  const harness = await createHarness({})
  const directory = await mkdtemp(join(tmpdir(), 'blender-fg-images-'))
  try {
    const call = await harness.call({ output_directory: join(directory, 'world'), fixture: true, render: true })
    assert.equal(call.isError, false, resultText(call))
    const parsed = JSON.parse(String(call.value?.result)) as { images: { requested: number; attached: number; failures: unknown[]; skipped: string[]; delivery: string } }
    assert.deepEqual(parsed.images, { requested: 1, attached: 1, failures: [], skipped: [], delivery: 'tool-result' })
    assert.equal((call.content ?? []).filter(block => block.type === 'image').length, 1)
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('前台：结果里的图片路径不是图像时，images 报失败原因且**没有**图像块（不是"渲染完就算视觉通过"）', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-fg-fakeimg-'))
  const fake = join(directory, 'preview.png')
  await writeFile(fake, '这不是图片，只是一段文字\n')
  const harness = await createHarness({ executable: await fakeExecutable(directory, `printf '${PREFIX}%s\\n' '{"scene":"/w/scene.json","preview":"${fake}"}'`) })
  try {
    const call = await harness.call({ output_directory: join(directory, 'world'), render: true })
    assert.equal(call.isError, false, resultText(call))
    const parsed = JSON.parse(String(call.value?.result)) as { images: { requested: number; attached: number; failures: Array<{ path: string; reason: string }> } }
    assert.equal(parsed.images.requested, 1)
    assert.equal(parsed.images.attached, 0)
    assert.match(parsed.images.failures[0]?.reason ?? '', /不是可识别的图像/)
    assert.deepEqual(call.content?.filter(block => block.type === 'image'), [])
    assert.equal(harness.images.length, 0)
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('前台读数：没请求渲染时 requested=0 是正常（不写"没有可附图"），请求了渲染/preview 却没有图才明确报失败', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-fg-norender-'))
  // 结果行里没有任何图片路径：这正是"没渲染"与"渲染了但没有图"两种情形的共同形状。
  const harness = await createHarness({ executable: await fakeExecutable(directory, `printf '${PREFIX}{"scene":"/w/scene.json","entities":3}\\n'`) })
  try {
    // ① 普通 build/export：没请求渲染，requested=0 是正常结果。
    const plain = await harness.call({ output_directory: join(directory, 'world') })
    const plainParsed = JSON.parse(String(plain.value?.result)) as { images: { requested: number; attached: number; delivery: string; deliveryError?: string } }
    // 先读 deliveryError 再做整体比对：assert.deepEqual 的断言签名会把 actual 收窄成 expected 的字面量类型，
    // 之后在同一个属性路径上再访问可选字段就会变成"不存在"（TS2339，与运行时无关）。
    assert.equal(plainParsed.images.deliveryError, undefined, '没请求渲染就不该写"没有可附的渲染图"')
    assert.deepEqual(plainParsed.images, { requested: 0, attached: 0, failures: [], skipped: [], delivery: 'none' })
    assert.deepEqual(plain.content?.filter(block => block.type === 'image'), [])

    // ② 请求了 render 却没有图：这是失败读数，模型必须能判出来。
    const rendered = await harness.call({ output_directory: join(directory, 'world-render'), render: true })
    const renderedParsed = JSON.parse(String(rendered.value?.result)) as { images: { requested: number; attached: number; delivery: string; deliveryError?: string } }
    assert.equal(renderedParsed.images.requested, 0)
    assert.equal(renderedParsed.images.attached, 0)
    assert.equal(renderedParsed.images.delivery, 'none')
    assert.match(renderedParsed.images.deliveryError ?? '', /请求了渲染/)
    assert.match(renderedParsed.images.deliveryError ?? '', /requested=0/)
    assert.deepEqual(rendered.content?.filter(block => block.type === 'image'), [])

    // ③ operation=preview 本身就是"要渲染"（world.py 的合同）：同样要失败读数。
    const preview = await harness.call({ output_directory: join(directory, 'world-preview'), operation: 'preview' })
    const previewParsed = JSON.parse(String(preview.value?.result)) as { images: { deliveryError?: string } }
    assert.match(previewParsed.images.deliveryError ?? '', /请求了渲染/)
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('前台：没装配附件服务时，结果里明确写"没装附件服务"，模型据此知道图没进上下文', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-fg-noattach-'))
  const preview = join(directory, 'preview.png')
  await writeFile(preview, tinyPng())
  const harness = await createHarness({ executable: await fakeExecutable(directory, `printf '${PREFIX}%s\\n' '{"scene":"/w/scene.json","preview":"${preview}"}'`), attachments: false })
  try {
    const call = await harness.call({ output_directory: join(directory, 'world'), render: true })
    const parsed = JSON.parse(String(call.value?.result)) as { images: { attached: number; failures: Array<{ reason: string }> } }
    assert.equal(parsed.images.attached, 0)
    assert.match(parsed.images.failures[0]?.reason ?? '', /没有装配附件服务/)
    assert.deepEqual(call.content?.filter(block => block.type === 'image'), [])
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('前台：超过上限的多机位图只带 4 张，其余在 images.skipped 里点名（路径仍留在结果 JSON）', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-fg-limit-'))
  const names = ['preview.png', 'a.png', 'b.png', 'c.png', 'd.png', 'e.png']
  for (const name of names) await writeFile(join(directory, name), tinyPng())
  const result = JSON.stringify({
    scene: join(directory, 'scene.json'), preview: join(directory, 'preview.png'),
    extraRenders: ['a', 'b', 'c', 'd', 'e'].map(name => ({ camera: name, path: join(directory, `${name}.png`) })),
  })
  const harness = await createHarness({ executable: await fakeExecutable(directory, `printf '${PREFIX}%s\\n' '${result}'`) })
  try {
    const call = await harness.call({ output_directory: directory })
    const parsed = JSON.parse(String(call.value?.result)) as { images: { requested: number; attached: number; skipped: string[] } }
    assert.equal(parsed.images.requested, 6)
    assert.equal(parsed.images.attached, 4)
    assert.deepEqual(parsed.images.skipped.sort(), [join(directory, 'd.png'), join(directory, 'e.png')].sort())
    assert.equal((call.content ?? []).filter(block => block.type === 'image').length, 4)
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

// ── 10. 后台完成时：图片作为**原生 Agent 消息**进会话（不重复唤醒） ──────────────
test('后台真实渲染完成：owner 的下一步收到一条带图消息（真 Agent 的真 Inbox），且没有额外唤醒', { skip: skipWithoutBlender }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-bg-deliver-'))
  const harness = await createHarness({})
  try {
    const output = join(directory, 'world')
    const call = await harness.call({ output_directory: output, fixture: true, render: true, background: true })
    assert.equal(call.isError, false, resultText(call))
    const job = JSON.parse(String(call.value?.result)) as JobCall
    assert.deepEqual(harness.pending(), { nextStep: 0, nextTurn: 0 }, '起作业本身不该往会话里塞消息')
    const snapshot = await harness.ctx.jobs.wait(job.jobId as never, 120_000, harness.agent?.id)
    assert.equal(snapshot.status, 'completed')
    const delivered = harness.pending()
    assert.equal(delivered.nextTurn, 0, 'inject 不唤醒驱动：不能因为带图就多排一轮（唤醒仍由原生完成通知那一次负责）')
    assert.equal(delivered.nextStep, 1, '完成的作业应投递恰好一条下一步消息')
    const messages = harness.claimNextStep()
    assert.equal(messages.length, 1)
    const [notice] = messages
    assert.equal(notice?.source?.kind, 'lyapunov-blender')
    assert.equal(notice?.source?.form, 'notice')
    const blocks = notice?.content ?? []
    assert.equal(blocks[0]?.type, 'text', '文本块在前，模型先看到"这是什么"')
    assert.match(blocks[0]?.text ?? '', new RegExp(`作业 ${job.jobId}`), '通知里写明是哪个作业的图（源版本）')
    assert.match(blocks[0]?.text ?? '', /1 张渲染图/)
    const imageBlocks = blocks.filter(block => block.type === 'image')
    assert.equal(imageBlocks.length, 1, '图必须是 image ContentBlock（附件引用），不是路径文本')
    assert.ok(imageBlocks[0]?.attachment, '图像块带真实附件引用')
    assert.ok(harness.images.includes('preview.png'), '附件服务真的存下了这张图')
    // 结果文本里说明投递走的哪条路：模型能区分"通知里带了图"和"只是路径"。
    const text = (harness.ctx.jobs.read(job.jobId as never, harness.agent?.id).result ?? '')
    const parsed = JSON.parse(text) as { images: { attached: number; delivery: string; deliveryError?: string } }
    assert.equal(parsed.images.attached, 1)
    assert.equal(parsed.images.delivery, 'job-notice')
    assert.equal(parsed.images.deliveryError, undefined)
    assert.equal(harness.pending().nextStep, 0, '取走之后不再积压')
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('原生 tool-jobs 一起装配：作业完成只开一次驱动，图片消息随这次唤醒同批进上下文（不重复唤醒）', { skip: skipWithoutBlender }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-bg-wake-'))
  // 装**原生** @deepseek-ai/dsh-tool-jobs（默认 wakeup 投递）：它是"作业完成唤醒 owner"的唯一来源。
  const harness = await createHarness({ toolJobs: true })
  try {
    // 真 Agent 的驱动在 claim 消息时会发事件：谁在哪个 turn 被取走，从驱动那里听，不靠猜时机。
    const claimed: Array<{ message: InboxMessage; turn: number }> = []
    const offClaimed = harness.agent.ctx.on('agent/inbox/claimed', payload => {
      claimed.push(payload as unknown as { message: InboxMessage; turn: number })
    })
    try {
      const call = await harness.call({ output_directory: join(directory, 'world'), fixture: true, render: true, background: true })
      assert.equal(call.isError, false, resultText(call))
      const job = JSON.parse(String(call.value?.result)) as JobCall
      assert.deepEqual(harness.pending(), { nextStep: 0, nextTurn: 0 }, '起作业本身不往会话里塞消息')
      // 这里**不**用 jobs.wait/job_output 等结果：原生 jobs 的语义是"已读的作业不再发完成通知"
      // （pending wait 先把作业标记为 reported，tool-jobs 的监听据此 return）——真模型也不会去轮询。
      // 于是只看会话：等到消息被驱动取走，或排在队里。
      await waitUntil(() => claimed.length >= 2 || (harness.pending().nextStep === 1 && harness.pending().nextTurn === 1), 120_000)
      // 默认 wakeup 投递 + 空闲 owner：原生完成通知会真的唤醒驱动，驱动随即按真实 Inbox 的 claim
      // 取走这批消息（next-step 全取 + 一条 next-turn）。取不到就说明前提变了，必须响亮地失败。
      assert.ok(claimed.length > 0, `原生完成通知应当唤醒空闲 owner 的驱动，但消息还排在队里：${JSON.stringify(harness.pending())}`)
      const messages = claimed.map(entry => entry.message)
      assert.equal(messages.length, 2, `本批应恰好两条消息，实际 ${messages.length}：${JSON.stringify(messages.map(m => m.source))}`)
      // 批次里只能有一条"唤醒车道"（next-turn）的消息：多出来的那一条就是本插件自己的图片消息，
      // 它走的是 inject（next-step），不新开驱动、不新开 Agent。
      const image = messages.find(message => message.source?.kind === 'lyapunov-blender')
      const native = messages.filter(message => message.source?.kind === 'tool-jobs')
      assert.ok(image, `本插件的图片通知必须在这批里：${JSON.stringify(messages.map(m => m.source))}`)
      assert.equal(native.length, 1, `原生完成通知只发一次：${JSON.stringify(messages.map(m => m.source))}`)
      // Inbox claim 的顺序 = 先 next-step 整批、再一条 next-turn：图片消息排在前面，正说明它在 next-step 车道
      // （inject），而唤醒车道上只有原生那一条。
      assert.equal(messages[0]?.source?.kind, 'lyapunov-blender', `图片消息应走 inject（next-step）车道：${JSON.stringify(messages.map(m => m.source))}`)
      assert.equal(messages[1]?.source?.kind, 'tool-jobs')
      // 真 Agent 的驱动**同一次启动**把两条都取走：turn 只有一个 = 唤醒只有一次。
      assert.equal(new Set(claimed.map(entry => entry.turn)).size, 1, '两条消息必须属于同一个 turn（同一次唤醒）')
      assert.deepEqual(harness.pending(), { nextStep: 0, nextTurn: 0 }, '这条唤醒之后没有再多排一轮（本插件的图没有自己再开一次轮）')
      // 图片消息本身：jobId + 图像块；原生通知：纯文本（它只负责叫醒）。
      const blocks = image?.content ?? []
      assert.match(blocks[0]?.text ?? '', new RegExp(`作业 ${job.jobId}`))
      assert.equal(blocks.filter(block => block.type === 'image').length, 1)
      assert.ok(harness.images.includes('preview.png'), '附件服务真的存下了这张图')
      assert.deepEqual((native[0]?.content ?? []).filter(block => block.type === 'image'), [], '原生完成通知不该带图（图由本插件的消息带）')
      assert.match(String(native[0]?.content[0]?.text ?? ''), new RegExp(`background job ${job.jobId}`))
      // 到此完成通知已经发出，才可以读作业结果（读会把作业标记为 reported，之后再读就没有通知了）。
      const parsed = JSON.parse((harness.ctx.jobs.read(job.jobId as never, harness.agent?.id).result ?? '')) as { images: { attached: number; delivery: string } }
      assert.equal(parsed.images.attached, 1)
      assert.equal(parsed.images.delivery, 'job-notice')
    } finally { offClaimed() }
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('后台取消：Blender 进程已完成、**附件保存期间**被 job_kill → 作业落 killed 且不投图', { skip: skipWithoutBlender }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-bg-cancel-attach-'))
  const output = join(directory, 'world')
  let jobId: string | undefined
  let harness: Harness | undefined
  // 真实的反例：附件服务真在保存这张图（真解码、真落盘），保存途中作业被取消。
  // 这条测试要证明的不是"没有图可发"，而是"图已经附件化好了也必须被投递门拦住"。
  const killDuringSave = (): void => {
    const id = jobId
    jobId = undefined
    if (id !== undefined) harness?.ctx.jobs.kill(id as never, harness!.agent?.id, '附件保存期间取消')
  }
  harness = await createHarness({ onSaveImage: killDuringSave })
  try {
    const call = await harness.call({ output_directory: output, fixture: true, render: true, background: true })
    assert.equal(call.isError, false, resultText(call))
    const job = JSON.parse(String(call.value?.result)) as JobCall
    jobId = job.jobId
    assert.equal((await harness.ctx.jobs.wait(job.jobId as never, 120_000, harness.agent?.id)).status, 'killed', '收尾阶段的取消必须落 killed，不能报 completed')
    assert.deepEqual(harness.pending(), { nextStep: 0, nextTurn: 0 }, '被取消的作业不能把图投进会话')
    assert.ok(harness.images.includes('preview.png'), '附件确实存下来了（取消发生在附件化之后）——所以这里靠的是投递门，不是"碰巧没图"')
    const text = (harness.ctx.jobs.read(job.jobId as never, harness.agent?.id).result ?? '')
    assert.match(text, /BLENDER_CANCELLED/)
    assert.match(text, /附件化阶段/)
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('后台取消：收尾读数（texture_query 取图）期间 job_kill → 落 killed 而不是 failed，且不投图', async () => {
  const fixture = await startPolyHavenFixture({ delayMs: 5000 })
  const directory = await mkdtemp(join(tmpdir(), 'blender-bg-cancel-readings-'))
  const harness = await createHarness({
    textureApiBase: fixture.base,
    executable: await fakeExecutable(directory, `printf '${PREFIX}{"scene":"/w/scene.json","preview":"/w/preview.png"}\\n'`),
  })
  try {
    const call = await harness.call({ output_directory: join(directory, 'world'), texture_query: 'plaster wall', background: true })
    const job = JSON.parse(String(call.value?.result)) as JobCall
    assert.equal(await waitUntil(() => fixture.requests.length > 0), true, '取图请求必须真的发出去')
    assert.equal(harness.ctx.jobs.kill(job.jobId as never, harness.agent?.id, '收尾读数阶段取消'), 'requested')
    assert.equal((await harness.ctx.jobs.wait(job.jobId as never, 60_000, harness.agent?.id)).status, 'killed', '取消不是失败：不能因为收尾抛错就报 failed')
    assert.deepEqual(harness.pending(), { nextStep: 0, nextTurn: 0 })
    assert.match((harness.ctx.jobs.read(job.jobId as never, harness.agent?.id).result ?? ''), /BLENDER_CANCELLED/)
  } finally {
    await harness.dispose()
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
  }
})

/**
 * 后台的两条边界是同一次修复的两半，必须都验到：
 *  ① 启动**前**要尊重已取消的请求——调用方已经撤销了，就不该再起一个还要继续跑的作业；
 *  ② 启动**后**作业的存活期归作业自己（job_kill / owner 释放），**不**跟 `exec.signal` 走——
 *     调用早就返回了，把作业绑在调用信号上会让它在调用结束的瞬间就被打断。
 */
test('后台：调用信号已取消时不启动作业；作业启动后调用信号取消也不打断它', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-bg-precancel-'))
  const preview = join(directory, 'preview.png')
  await writeFile(preview, tinyPng())
  // 进程要活过"后台调用返回 → 调用方取消"这一段，②才有意义（1 秒足够，不拖长本文件的运行时间）。
  const harness = await createHarness({
    executable: await fakeExecutable(directory, `sleep 1\nprintf '${PREFIX}%s\\n' '{"scene":"${join(directory, 'scene.json')}","preview":"${preview}"}'`),
  })
  try {
    // ① 调用信号在派发前就已触发：注册表这条路**先**由运行时拦下——dsh-tools 在 dispatch 前发现
    // 信号已触发就返回 `tool call aborted before dispatch`，工具体根本不会被调用，因此这里读不到
    // 本插件自己的取消文本（插件里那道 `exec.signal.aborted` 门保的是不走注册表调度器的派发路径）。
    // 判据落在"尊重已取消请求"这件事本身：不报成功、不起作业、不往会话里塞消息。
    const before = harness.ctx.jobs.list(harness.agent?.id).length
    const cancelled = new AbortController()
    cancelled.abort()
    const refused = await harness.call({ output_directory: join(directory, 'world-a'), background: true }, cancelled.signal)
    assert.equal(refused.isError, true, '已取消的调用不能报成功')
    assert.match(resultText(refused), /aborted before dispatch/)
    assert.equal(harness.ctx.jobs.list(harness.agent?.id).length, before, '已取消的调用不该起一个还要继续跑的作业')
    assert.deepEqual(harness.pending(), { nextStep: 0, nextTurn: 0 })

    // ② 调用正常返回后，调用方立刻撤销自己的信号：作业照跑、照投图。
    const controller = new AbortController()
    const call = await harness.call({ output_directory: join(directory, 'world-b'), background: true }, controller.signal)
    assert.equal(call.isError, false, resultText(call))
    const job = JSON.parse(String(call.value?.result)) as JobCall
    const running = harness.ctx.jobs.read(job.jobId as never, harness.agent?.id).job.status
    controller.abort()
    assert.equal(running, 'running', '取消要发生在作业**还在跑**的时候，否则这条读数什么也证明不了')
    assert.equal(
      (await harness.ctx.jobs.wait(job.jobId as never, 15_000, harness.agent?.id)).status,
      'completed',
      '调用信号取消不该打断已经启动的后台作业（要停它得用 job_kill）',
    )
    assert.equal(harness.pending().nextStep, 1, '作业照常完成并投图')
    assert.ok(harness.images.includes('preview.png'))
    const parsed = JSON.parse((harness.ctx.jobs.read(job.jobId as never, harness.agent?.id).result ?? '')) as { images: { attached: number; delivery: string } }
    assert.equal(parsed.images.attached, 1)
    assert.equal(parsed.images.delivery, 'job-notice')
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('后台取消/失败：**不发旧图**（磁盘上留着上一轮的 preview.png 也不能当本次结果）', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-bg-noimg-'))
  const output = join(directory, 'world')
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'preview.png'), tinyPng())
  try {
    // ① 被 job_kill 的作业：进程被杀 → 不发图。
    const killing = await createHarness({ executable: await fakeExecutable(directory, 'sleep 30') })
    try {
      const call = await killing.call({ output_directory: output, background: true, render: true })
      const job = JSON.parse(String(call.value?.result)) as JobCall
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.equal(killing.ctx.jobs.kill(job.jobId as never, killing.agent?.id, '测试取消'), 'requested')
      assert.equal((await killing.ctx.jobs.wait(job.jobId as never, 15_000, killing.agent?.id)).status, 'killed')
      assert.deepEqual(killing.pending(), { nextStep: 0, nextTurn: 0 }, '取消的作业不能往会话里投图')
      assert.equal(killing.images.length, 0)
    } finally { await killing.dispose() }

    // ② 失败（旧产物在盘上、退出码 0 但没有结果行）：同样不发图。
    const failing = await createHarness({ executable: await fakeExecutable(directory, 'printf "Blender quit\\n"') })
    try {
      const call = await failing.call({ output_directory: output, background: true, render: true })
      const job = JSON.parse(String(call.value?.result)) as JobCall
      assert.equal((await failing.ctx.jobs.wait(job.jobId as never, 15_000, failing.agent?.id)).status, 'failed')
      assert.deepEqual(failing.pending(), { nextStep: 0, nextTurn: 0 }, '失败的作业不能把上一轮的图当成本次结果投出去')
      assert.equal(failing.images.length, 0)
    } finally { await failing.dispose() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('后台：投递失败要如实记录（owner 已释放 / inject 抛错），不能假装模型看到了图', { skip: skipWithoutBlender }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-bg-deliverfail-'))
  const harness = await createHarness({})
  try {
    // 真实的失败模式：owner 已释放时 inject 会抛。这里让它抛，验证结果文本如实记因。
    const target = harness.agent as unknown as { inject(message: unknown): void }
    const original = target.inject
    target.inject = () => { throw new Error('owner 已释放：blender-run-test-delivery-fail') }
    try {
      const call = await harness.call({ output_directory: join(directory, 'world'), fixture: true, render: true, background: true })
      const job = JSON.parse(String(call.value?.result)) as JobCall
      assert.equal((await harness.ctx.jobs.wait(job.jobId as never, 120_000, harness.agent?.id)).status, 'completed')
      const parsed = JSON.parse((harness.ctx.jobs.read(job.jobId as never, harness.agent?.id).result ?? '')) as { images: { attached: number; delivery: string; deliveryError?: string } }
      assert.equal(parsed.images.delivery, 'none')
      assert.match(parsed.images.deliveryError ?? '', /投递失败/)
      assert.match(parsed.images.deliveryError ?? '', /blender-run-test-delivery-fail/)
      assert.deepEqual(harness.pending(), { nextStep: 0, nextTurn: 0 }, '投递失败时消息根本没进会话')
    } finally { target.inject = original }
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

// ── 11. blender_job_images：复用原生作业输出，不新建任务缓存 ─────────────────────
test('blender_job_images：重复取图不吞一次原生result，结果产物缺件/错代次/破损必须拒绝', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-jobimg-rc2-'))
  const output = join(directory, 'world'), preview = join(directory, 'preview.png')
  await writeFile(preview, tinyPng())
  const result = JSON.stringify({ scene: join(directory, 'scene.json'), preview })
  const harness = await createHarness({ executable: await fakeExecutable(directory, `printf '${PREFIX}%s\\n' '${result}'`) })
  try {
    const started = await harness.call({ output_directory: output, background: true, render: true })
    const job = JSON.parse(String(started.value?.result)) as JobCall
    await harness.ctx.jobs.wait(job.jobId as never, 15_000, harness.agent.id)
    for (let i = 0; i < 2; i++) {
      const pulled = await harness.callTool('blender_job_images', { job_id: job.jobId })
      assert.equal(pulled.isError, false, resultText(pulled))
      assert.equal(pulled.content?.filter(block => block.type === 'image').length, 1)
    }
    const collected = harness.ctx.jobs.read(job.jobId as never, harness.agent.id)
    assert.equal(JSON.parse(collected.result!).preview, preview)
    assert.equal(harness.ctx.jobs.read(job.jobId as never, harness.agent.id).result, undefined)
    const again = await harness.callTool('blender_job_images', { job_id: job.jobId })
    assert.equal(again.isError, false, '模型已经读过result后仍能重复取图')
    await harness.reloadPlugin()
    assert.equal(harness.ctx.jobs.list(harness.agent.id).length, 1)
    const reloaded = await harness.callTool('blender_job_images', { job_id: job.jobId })
    assert.equal(reloaded.isError, false, '插件重载后仍从同一Job结果产物重复取图')
    const path = join(output, `.lyapunov-job-result-${job.jobId}.json`)
    const original = await readFile(path, 'utf8')
    const receipt = JSON.parse(original)
    for (const patch of [{ registryId: 'another-registry' }, { startedAt: receipt.startedAt + 1 }, { result: '{}' }]) {
      await writeFile(path, JSON.stringify({ ...receipt, ...patch }))
      const unavailable = await harness.callTool('blender_job_images', { job_id: job.jobId })
      assert.equal(unavailable.isError, true)
      assert.match(resultText(unavailable), /身份或完整性不匹配/)
      assert.equal(unavailable.content?.filter(block => block.type === 'image').length, 0)
    }
    await rm(path)
    const missing = await harness.callTool('blender_job_images', { job_id: job.jobId })
    assert.equal(missing.isError, true)
    assert.match(resultText(missing), /结果产物不可读取/)
    assert.equal(missing.content?.filter(block => block.type === 'image').length, 0)
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('blender_job_images：已完成作业的图能取回上下文；结果显示 jobId/status/images', { skip: skipWithoutBlender }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-jobimg-'))
  const harness = await createHarness({})
  try {
    const call = await harness.call({ output_directory: join(directory, 'world'), fixture: true, render: true, background: true })
    const job = JSON.parse(String(call.value?.result)) as JobCall
    assert.equal((await harness.ctx.jobs.wait(job.jobId as never, 120_000, harness.agent?.id)).status, 'completed')
    harness.claimNextStep() // 先取走完成通知，避免把两种投递混在一起看
    const pulled = await harness.callTool('blender_job_images', { job_id: job.jobId })
    assert.equal(pulled.isError, false, resultText(pulled))
    const parsed = JSON.parse(String(pulled.value?.result)) as { jobId: string; status: string; result: string; images: { attached: number; requested: number; delivery: string } }
    assert.equal(parsed.jobId, job.jobId)
    assert.equal(parsed.status, 'completed')
    assert.equal(parsed.images.requested, 1)
    assert.equal(parsed.images.attached, 1)
    assert.equal(parsed.images.delivery, 'tool-result')
    // result 就是该作业自己那条结果行（与 job_output 同源），图片路径在里面。
    const world = JSON.parse(parsed.result) as { preview?: string }
    assert.ok(world.preview && existsSync(world.preview))
    assert.equal((pulled.content ?? []).filter(block => block.type === 'image').length, 1)
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('blender_job_images：取消的作业拒绝发图（旧的 preview.png 还在盘上也不行）', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-jobimg-killed-'))
  const output = join(directory, 'world')
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'preview.png'), tinyPng())
  const harness = await createHarness({ executable: await fakeExecutable(directory, 'sleep 30') })
  try {
    const call = await harness.call({ output_directory: output, background: true, render: true })
    const job = JSON.parse(String(call.value?.result)) as JobCall
    await new Promise(resolve => setTimeout(resolve, 300))
    harness.ctx.jobs.kill(job.jobId as never, harness.agent?.id, '测试取消')
    await harness.ctx.jobs.wait(job.jobId as never, 15_000, harness.agent?.id)
    const pulled = await harness.callTool('blender_job_images', { job_id: job.jobId })
    assert.equal(pulled.isError, true, '取消的作业不能发图')
    assert.match(resultText(pulled), /BLENDER_JOB_IMAGES_UNAVAILABLE/)
    assert.match(resultText(pulled), /killed/)
    assert.deepEqual(pulled.content?.filter(block => block.type === 'image'), [])
    assert.equal(harness.images.length, 0)
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

/**
 * 会话里不止本插件在起后台作业（原生 kind 是开放集合：bash / subagent / …）。按 **kind** 认生产者，
 * 而不是"是本会话的作业就当 Blender 结果解析"——否则别的生产者只要输出里恰好有同名形状的 JSON，
 * 就会被当成渲染结果把图发出去。这条测试里的别 kind 作业**故意给出长得一样的结果 JSON**：
 * 少了 kind 判据它就会"成功"，所以断言落在"拒绝 + 一张图都没存"上，而不是解析失败上。
 */
test('blender_job_images：只认本插件产出的作业（kind 不是 blender 就拒绝，哪怕输出长得像结果行）', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-jobimg-kind-'))
  const preview = join(directory, 'preview.png')
  await writeFile(preview, tinyPng())
  const result = JSON.stringify({ scene: join(directory, 'scene.json'), preview })
  const harness = await createHarness({ executable: await fakeExecutable(directory, `printf '${PREFIX}%s\\n' '${result}'`) })
  try {
    // 最小生产者：它代表的是"别的 kind 的作业"这件事本身，判据在 kind 分类上，不在这个生产者的实现里。
    const foreign = harness.ctx.jobs.start({
      kind: 'bash',
      label: 'sleep 30',
      owner: harness.agent?.id,
      run: () => ({ cancel: () => undefined, done: Promise.resolve({ status: 'completed' as const, result: result }) }),
    })
    assert.equal((await harness.ctx.jobs.wait(foreign as never, 15_000, harness.agent?.id)).status, 'completed')
    const call = await harness.callTool('blender_job_images', { job_id: foreign })
    assert.equal(call.isError, true, '别的 kind 的作业不能当 Blender 结果解析')
    assert.match(resultText(call), /BLENDER_JOB_IMAGES_UNAVAILABLE/)
    assert.match(resultText(call), /不是 Blender 生产者/)
    assert.match(resultText(call), /kind=bash/)
    assert.match(resultText(call), /job_output/, '拒绝时要指出正确的读法（原生 job_output）')
    assert.deepEqual(call.content?.filter(block => block.type === 'image'), [])
    assert.equal(harness.images.length, 0, '别的 kind 的作业一张图都不该被附件化')
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('blender_job_images：limit 有界——必须是正整数，传超过上限也按上限截断（其余仍点名）', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-jobimg-limit-'))
  const names = ['preview.png', 'a.png', 'b.png', 'c.png', 'd.png', 'e.png']
  for (const name of names) await writeFile(join(directory, name), tinyPng())
  const result = JSON.stringify({
    scene: join(directory, 'scene.json'), preview: join(directory, 'preview.png'),
    extraRenders: ['a', 'b', 'c', 'd', 'e'].map(name => ({ camera: name, path: join(directory, `${name}.png`) })),
  })
  const harness = await createHarness({ executable: await fakeExecutable(directory, `printf '${PREFIX}%s\\n' '${result}'`) })
  try {
    const call = await harness.call({ output_directory: join(directory, 'world'), background: true, render: true })
    const job = JSON.parse(String(call.value?.result)) as JobCall
    assert.equal((await harness.ctx.jobs.wait(job.jobId as never, 15_000, harness.agent?.id)).status, 'completed')
    // 0 / 负数不是"取几张"的合法说法：参数合同层只保证整数，取值合不合约由本工具判，理由指向 limit 本身。
    for (const limit of [0, -1]) {
      const bad = await harness.callTool('blender_job_images', { job_id: job.jobId, limit })
      assert.equal(bad.isError, true, `limit=${limit} 应当被拒绝`)
      assert.match(resultText(bad), /BLENDER_ARGUMENT_INVALID/)
      assert.match(resultText(bad), /limit/)
    }
    // 小数由参数合同（integer）先拦：这一层是工具 schema 的职责，不是本工具的边界校验。
    const fractional = await harness.callTool('blender_job_images', { job_id: job.jobId, limit: 1.5 })
    assert.equal(fractional.isError, true)
    assert.match(resultText(fractional), /invalid arguments/)
    // 传超过上限的值按**上限**截断（不是"传多少给多少"）：其余路径仍在结果 JSON 与 images.skipped 里。
    const many = await harness.callTool('blender_job_images', { job_id: job.jobId, limit: 99 })
    assert.equal(many.isError, false, resultText(many))
    const parsed = JSON.parse(String(many.value?.result)) as { images: { requested: number; attached: number; skipped: string[] } }
    assert.equal(parsed.images.requested, 6)
    assert.equal(parsed.images.attached, 4)
    assert.deepEqual(parsed.images.skipped.sort(), [join(directory, 'd.png'), join(directory, 'e.png')].sort())
    assert.equal((many.content ?? []).filter(block => block.type === 'image').length, 4)
    // 不传 limit 与上限一致（文档说"默认与上限都是 4"，读数与说明必须对得上）。
    const fallback = await harness.callTool('blender_job_images', { job_id: job.jobId })
    assert.equal((fallback.content ?? []).filter(block => block.type === 'image').length, 4)
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('blender_job_images：别的会话读不到本会话的作业（原生 owner 判权拦住）', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blender-jobimg-owner-'))
  const harness = await createHarness({ executable: await fakeExecutable(directory, 'sleep 30') })
  try {
    const call = await harness.call({ output_directory: join(directory, 'world'), background: true })
    const job = JSON.parse(String(call.value?.result)) as JobCall
    const unfinished = await harness.callTool('blender_job_images', { job_id: job.jobId })
    assert.equal(unfinished.isError, true)
    assert.match(resultText(unfinished), /running/)
    const outsider = await harness.createAgent('blender-run-outsider')
    const foreign = await harness.callTool('blender_job_images', { job_id: job.jobId }, { caller: outsider })
    assert.equal(foreign.isError, true, '别的会话不能读本会话的作业')
    assert.match(resultText(foreign), /belongs to another session/)
    // 未知作业同样是明确错误，不是空结果。
    const unknown = await harness.callTool('blender_job_images', { job_id: 'blender-999999' })
    assert.equal(unknown.isError, true)
    assert.match(resultText(unknown), /blender-999999/)
    harness.ctx.jobs.kill(job.jobId as never, harness.agent?.id, '收尾')
    await harness.ctx.jobs.wait(job.jobId as never, 15_000, harness.agent?.id)
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

// ── 12. 贴图入口：本地夹具 HTTP（本机沙箱无外网出口，真实 api.polyhaven.com 未验证） ──
/**
 * 夹具服务只做一件事：按 textures.ts 真正打的接口返回**真实形状**的响应
 * （`/assets?t=textures` 列表、`/files/{id}` 文件清单、逐图下载、缩略图），
 * 所以走通它证明的是"工具把候选/资产/分辨率/缩略图这条链真的跑通了"，
 * **不是**"官方接口今天可用"。
 */
/** 等一个迟早会成立的条件（服务端的断开通知比客户端的 reject 稍晚到）。 */
async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return predicate()
}

interface PolyHavenFixture {
  base: string
  /** 夹具收到的请求路径（断言真的打了哪些接口）。 */
  requests: string[]
  /** 客户端在响应写完前就断开的请求（证明取消信号真的取消了在途下载）。 */
  aborted: string[]
  close(): Promise<void>
}

async function startPolyHavenFixture(options: { delayMs?: number } = {}): Promise<PolyHavenFixture> {
  const requests: string[] = []
  const aborted: string[] = []
  let base = ''
  const catalog = (): string => JSON.stringify({
    plaster_concrete_wall: {
      name: 'Plaster Concrete Wall', tags: ['plaster', 'concrete', 'wall'], categories: ['walls'], category: 'walls',
      authors: { 'Fixture Author': 'CC0' }, max_resolution: [8192, 4096], dimensions: [4, 4],
      thumbnail_url: `${base}/thumbs/plaster_concrete_wall.png`, description: '夹具：灰泥墙', download_count: 1200,
      date_published: 1600000000, prepaid: false,
    },
    wood_planks_02: {
      name: 'Wood Planks 02', tags: ['wood', 'planks', 'floor'], categories: ['wood'], category: 'wood',
      authors: { 'Fixture Author': 'CC0' }, max_resolution: [4096, 2048], dimensions: [2, 2],
      thumbnail_url: `${base}/thumbs/wood_planks_02.png`, download_count: 900, date_published: 1500000000, prepaid: false,
    },
    premium_marble: {
      name: 'Premium Marble', tags: ['marble'], categories: ['stone'], authors: { 'Fixture Author': 'CC0' },
      max_resolution: [8192, 8192], thumbnail_url: `${base}/thumbs/premium_marble.png`, download_count: 5000, prepaid: true,
    },
  })
  const files = (assetId: string): string => {
    const payload: Record<string, Record<string, { jpg: { url: string; size: number } }>> = {}
    for (const map of ['Diffuse', 'nor_gl', 'Rough', 'AO']) {
      payload[map] = {}
      for (const resolution of ['1k', '2k']) {
        payload[map]![resolution] = { jpg: { url: `${base}/dl/${assetId}/${map}_${resolution}.jpg`, size: TINY_JPEG.length } }
      }
    }
    return JSON.stringify(payload)
  }
  const server = createServer((request, response) => {
    const path = request.url ?? ''
    requests.push(path)
    // 客户端在响应写完前断开 = 请求真的被取消了（服务端的关闭通知比客户端的 reject 稍晚到，断言前要等）。
    // 按**每次请求**记一次（不是按路径去重）：同一个路径被取消两次也要记两次。
    let noted = false
    const noteAbort = (): void => { if (noted || response.writableFinished) return; noted = true; aborted.push(path) }
    request.on('close', noteAbort)
    response.on('close', noteAbort)
    const send = (body: Buffer | string, contentType: string): void => {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': contentType })
        response.end(body)
      }, options.delayMs ?? 0)
    }
    if (path.startsWith('/assets')) { send(catalog(), 'application/json'); return }
    if (path.startsWith('/files/')) { send(files(decodeURIComponent(path.slice('/files/'.length))), 'application/json'); return }
    if (path.startsWith('/thumbs/')) { send(TINY_JPEG, 'image/jpeg'); return }
    if (path.startsWith('/dl/')) { send(TINY_JPEG, 'image/jpeg'); return }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    get base() { return base },
    requests,
    aborted,
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}

test('blender_texture_search：候选来自真实接口响应（含付费标记与分辨率上限），不给目录就不落盘、不附图', async () => {
  const fixture = await startPolyHavenFixture()
  const harness = await createHarness({ textureApiBase: fixture.base })
  try {
    const call = await harness.callTool('blender_texture_search', { query: 'plaster concrete wall' })
    assert.equal(call.isError, false, resultText(call))
    const parsed = JSON.parse(resultText(call)) as {
      query: string
      explanation: { terms: string[]; mapped: Array<{ zh: string; en: string[] }>; unmapped: string[] }
      candidates: Array<{ assetId: string; name: string; license: string; prepaid: boolean; maxResolution?: number[]; thumbnailUrl?: string; thumbnailPath?: string; matchedTerms: string[]; score: number }>
      images: { requested: number; attached: number; failures: unknown[]; skipped: string[]; delivery: string }
    }
    assert.equal(parsed.query, 'plaster concrete wall')
    assert.equal(parsed.candidates[0]?.assetId, 'plaster_concrete_wall', '命中词的候选排前面')
    assert.equal(parsed.candidates[0]?.license, 'CC0-1.0')
    assert.equal(parsed.candidates[0]?.prepaid, false)
    assert.deepEqual(parsed.candidates[0]?.maxResolution, [8192, 4096], '分辨率上限要如实给出来，模型才知道能要 4k')
    assert.ok(parsed.candidates[0]?.thumbnailUrl?.endsWith('/thumbs/plaster_concrete_wall.png'))
    assert.equal(parsed.candidates[0]?.thumbnailPath, undefined, '没给 thumbnail_directory 就不该写文件')
    // 没给 thumbnail_directory 就没有缩略图可附：delivery 如实写 none（"图片最终怎么到模型面前"），
    // 不写 tool-result——那条车道这次没有送过任何图。
    assert.deepEqual(parsed.images, { requested: 0, attached: 0, failures: [], skipped: [], delivery: 'none' })
    assert.deepEqual(parsed.explanation.unmapped, [])
    assert.deepEqual(parsed.explanation.mapped, [])
    assert.ok(fixture.requests.some(path => path.startsWith('/assets')), '真的走了官方列表接口')
    assert.equal(fixture.requests.some(path => path.startsWith('/thumbs/')), false, '没要求缩略图就不去下载')

    // 命中付费素材时如实标出来（prepaid 素材只列候选、不下载）。
    const paid = JSON.parse(resultText(await harness.callTool('blender_texture_search', { query: 'marble' }))) as {
      candidates: Array<{ assetId: string; prepaid: boolean; license: string }>
    }
    assert.equal(paid.candidates[0]?.assetId, 'premium_marble')
    assert.equal(paid.candidates[0]?.prepaid, true, '付费素材仍要列出来（只是不下载）')
    assert.equal(paid.candidates[0]?.license, 'unknown', '付费素材的许可不由本适配器断言')

    // 中文检索词：内置词表命中就报映射，没收录的字如实列出（模型据此改用英文或直接给 assetId）。
    const zh = await harness.callTool('blender_texture_search', { query: '灰泥氛' })
    const zhParsed = JSON.parse(resultText(zh)) as { explanation: { mapped: Array<{ zh: string; en: string[] }>; unmapped: string[] } }
    assert.deepEqual(zhParsed.explanation.mapped[0], { zh: '灰泥', en: ['plaster'] })
    assert.deepEqual(zhParsed.explanation.unmapped, ['氛'], '没收录的字不能瞎猜')
  } finally {
    await harness.dispose()
    await fixture.close()
  }
})

test('blender_texture_search：给了 thumbnail_directory 就把缩略图落盘并作为图像返回（JPEG 字节存成 .thumb.png 也认）', async () => {
  const fixture = await startPolyHavenFixture()
  const harness = await createHarness({ textureApiBase: fixture.base })
  const directory = await mkdtemp(join(tmpdir(), 'blender-texthumbs-'))
  try {
    const thumbs = join(directory, 'thumbs')
    const call = await harness.callTool('blender_texture_search', { query: 'plaster wall', limit: 2, thumbnail_directory: thumbs })
    assert.equal(call.isError, false, resultText(call))
    const parsed = JSON.parse(resultText(call)) as {
      candidates: Array<{ assetId: string; thumbnailPath?: string; thumbnailError?: string }>
      images: { requested: number; attached: number; failures: Array<{ reason: string }>; skipped: string[]; delivery: string }
    }
    const withThumb = parsed.candidates.filter(candidate => candidate.thumbnailPath !== undefined)
    assert.ok(withThumb.length >= 1, '要求了缩略图就应该真的落盘')
    assert.equal(withThumb[0]?.thumbnailPath, join(thumbs, `${withThumb[0]?.assetId}.thumb.png`))
    assert.ok(existsSync(withThumb[0]!.thumbnailPath!))
    assert.equal(parsed.images.requested, withThumb.length)
    assert.equal(parsed.images.attached, withThumb.length)
    assert.deepEqual(parsed.images.failures, [])
    assert.equal(parsed.images.delivery, 'tool-result', '真的附上了图才写投递车道')
    assert.equal((call.content ?? []).filter(block => block.type === 'image').length, withThumb.length)
    // 关键：夹具回的是 JPEG 字节、文件名叫 .thumb.png——按魔数声明 image/jpeg 才过得了附件服务解码。
    assert.equal(sniffImageMediaType(await readFile(withThumb[0]!.thumbnailPath!)), 'image/jpeg')
    assert.deepEqual([...harness.images].sort(), withThumb.map(candidate => `${candidate.assetId}.thumb.png`).sort())
  } finally {
    await harness.dispose()
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('真实 Blender：material_textures 指定的贴图真的接进材质节点（world.py 读插件落的 textures.json），且这次渲染照常出图', { skip: skipWithoutBlender }, async () => {
  const fixture = await startPolyHavenFixture()
  const directory = await mkdtemp(join(tmpdir(), 'blender-texwire-'))
  const harness = await createHarness({ textureApiBase: fixture.base })
  try {
    const output = join(directory, 'world')
    const call = await harness.call({
      output_directory: output,
      fixture: true,
      render: true,
      // 材质名必须是 world.py 在 fixture 场景里真正建出来的那几个（墙面/木材/蓝色方块）
      material_textures: JSON.stringify({ 墙面: 'plaster concrete wall', 木材: { assetId: 'wood_planks_02', resolution: '2k' } }),
    })
    assert.equal(call.isError, false, resultText(call))
    const parsed = JSON.parse(String(call.value?.result)) as {
      materialTextures?: Record<string, { assetId?: string; maps?: string[]; error?: string }>
      images: { requested: number; attached: number; delivery: string }
    }
    // world.py 的接线读数：真的在 Blender 进程里把节点接上了（不是只在插件侧取了图）。
    const wired = parsed.materialTextures ?? {}
    assert.deepEqual(Object.keys(wired).sort(), ['墙面', '木材'], `只有清单里的材质被接线：${JSON.stringify(wired)}`)
    assert.equal(wired['墙面']?.assetId, 'plaster_concrete_wall')
    assert.equal(wired['木材']?.assetId, 'wood_planks_02')
    assert.equal(wired['墙面']?.error, undefined)
    assert.ok((wired['墙面']?.maps ?? []).includes('Diffuse'), 'Diffuse 必须真的接上（缺颜色图就宁可什么都不接）')
    // 明确 assetId + 2k 的那一套，下载的确实是 2k 档；关键词写法沿用默认 1k 档。
    assert.ok(fixture.requests.some(path => path.startsWith('/dl/wood_planks_02/') && path.includes('_2k.')), `明确档位要真的生效：${fixture.requests.join(' ')}`)
    assert.ok(fixture.requests.some(path => path.startsWith('/dl/plaster_concrete_wall/') && path.includes('_1k.')), `关键词写法用默认档：${fixture.requests.join(' ')}`)
    // 接上贴图后渲染照常跑完，图照样作为附件进上下文。
    assert.equal(parsed.images.attached, 1)
    assert.deepEqual(parsed.images.delivery, 'tool-result')
    assert.equal((call.content ?? []).filter(block => block.type === 'image').length, 1)
  } finally {
    await harness.dispose()
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('material_textures：旧关键词写法与新 {assetId,resolution} 写法都真的取到指定素材，坏形状逐条记因', async () => {
  const fixture = await startPolyHavenFixture()
  const directory = await mkdtemp(join(tmpdir(), 'blender-texmaterial-'))
  const harness = await createHarness({
    textureApiBase: fixture.base,
    executable: await fakeExecutable(directory, `printf '${PREFIX}{"scene":"/w/scene.json"}\\n'`),
  })
  try {
    const output = join(directory, 'world')
    const call = await harness.call({
      output_directory: output,
      material_textures: JSON.stringify({ 浅色灰泥: 'plaster concrete wall', 暖木: { assetId: 'wood_planks_02', resolution: '2k' } }),
    })
    assert.equal(call.isError, false, resultText(call))
    const parsed = JSON.parse(String(call.value?.result)) as { textureRequest: { materials: string[]; fetched: string[]; failures: Record<string, string> } }
    assert.deepEqual([...parsed.textureRequest.fetched].sort(), ['暖木', '浅色灰泥'])
    assert.deepEqual(parsed.textureRequest.failures, {})
    const manifest = JSON.parse(await readFile(join(output, 'textures.json'), 'utf8')) as {
      sets: Record<string, { assetId: string; resolution: string; maps: Record<string, string>; complete: boolean }>
    }
    assert.equal(manifest.sets['浅色灰泥']?.assetId, 'plaster_concrete_wall')
    assert.equal(manifest.sets['浅色灰泥']?.resolution, '1k', '关键词写法沿用默认档')
    assert.equal(manifest.sets['暖木']?.assetId, 'wood_planks_02', '明确 assetId 要绕过关键词打分')
    assert.equal(manifest.sets['暖木']?.resolution, '2k', '明确 resolution 要真的生效')
    for (const set of Object.values(manifest.sets)) {
      assert.equal(set.complete, true)
      for (const path of Object.values(set.maps)) assert.ok(existsSync(path), `${path} 应真实落盘`)
    }
    assert.ok(fixture.requests.some(path => path.startsWith('/files/wood_planks_02')))

    // 坏形状：逐条记因，整次调用不崩（world.py 仍然照跑）。
    const bad = await harness.call({
      output_directory: join(directory, 'world2'),
      material_textures: JSON.stringify({
        缺关键词: { resolution: '2k' }, 空id: { assetId: '   ' }, 类型错: 7,
        档位错: { assetId: 'wood_planks_02', resolution: '9k' }, 空串: '',
      }),
    })
    assert.equal(bad.isError, false, resultText(bad))
    const badParsed = JSON.parse(String(bad.value?.result)) as { textureRequest: { fetched: string[]; failures: Record<string, string> } }
    assert.deepEqual(badParsed.textureRequest.fetched, [])
    for (const material of ['缺关键词', '空id', '类型错', '档位错', '空串']) {
      assert.match(badParsed.textureRequest.failures[material] ?? '', /MATERIAL_TEXTURES_INVALID/, `${material} 应逐条报因`)
    }
    assert.match(badParsed.textureRequest.failures['档位错'] ?? '', /resolution 只能是 1k\/2k\/4k\/8k/)

    // 付费素材明确指定 → 只列不下载（POLYHAVEN_PREPAID_ASSET）。
    const prepaid = await harness.call({
      output_directory: join(directory, 'world3'),
      material_textures: JSON.stringify({ 大理石: { assetId: 'premium_marble' } }),
    })
    const prepaidParsed = JSON.parse(String(prepaid.value?.result)) as { textureRequest: { failures: Record<string, string> } }
    assert.match(prepaidParsed.textureRequest.failures['大理石'] ?? '', /POLYHAVEN_PREPAID_ASSET/)
  } finally {
    await harness.dispose()
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('贴图下载的取消信号是真的：在途请求被 abort，不是只把结果丢掉了', async () => {
  const fixture = await startPolyHavenFixture({ delayMs: 5000 })
  const directory = await mkdtemp(join(tmpdir(), 'blender-textabort-'))
  const harness = await createHarness({
    textureApiBase: fixture.base,
    executable: await fakeExecutable(directory, `printf '${PREFIX}{"scene":"/w/scene.json"}\\n'`),
  })
  try {
    // ① 查询工具：调用信号 abort → 在途请求断开。
    const controller = new AbortController()
    const pending = harness.callTool('blender_texture_search', { query: 'plaster wall' }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    const aborted = await pending
    assert.equal(aborted.isError, true, '被取消的调用不能报成功')
    assert.equal(await waitUntil(() => fixture.aborted.length >= 1), true, '客户端必须在响应回来之前断开（信号真的传到了 fetch）')

    // ② blur：material_textures 的取图用同一条信号；abort 之后不把"下载到一半"当成功。
    const before = fixture.aborted.length
    const controller2 = new AbortController()
    const pending2 = harness.call({ output_directory: join(directory, 'world'), material_textures: JSON.stringify({ 灰泥: 'plaster wall' }) }, controller2.signal)
    setTimeout(() => controller2.abort(), 300)
    const call = await pending2
    assert.equal(call.isError, true, '取图阶段被取消的调用不能报成功')
    assert.match(resultText(call), /BLENDER_CANCELLED/, '取图阶段被取消的调用落同一条取消判定')
    assert.equal(await waitUntil(() => fixture.aborted.length > before), true, 'material_textures 的在途下载也必须被取消')
    assert.equal(existsSync(join(directory, 'world/textures.json')), false, '取消的运行不该留下看似可用的贴图清单')
  } finally {
    await harness.dispose()
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('后台作业：贴图取图在作业内进行，job_kill 能取消在途下载（不是只能等它跑完）', async () => {
  const fixture = await startPolyHavenFixture({ delayMs: 5000 })
  const directory = await mkdtemp(join(tmpdir(), 'blender-textbg-'))
  const harness = await createHarness({
    textureApiBase: fixture.base,
    executable: await fakeExecutable(directory, `printf '${PREFIX}{"scene":"/w/scene.json"}\\n'`),
  })
  try {
    const call = await harness.call({ output_directory: join(directory, 'world'), background: true, material_textures: JSON.stringify({ 灰泥: 'plaster wall' }) })
    const job = JSON.parse(String(call.value?.result)) as JobCall
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(harness.ctx.jobs.kill(job.jobId as never, harness.agent?.id, '测试取消'), 'requested')
    const snapshot = await harness.ctx.jobs.wait(job.jobId as never, 15_000, harness.agent?.id)
    assert.equal(snapshot.status, 'killed')
    assert.equal(await waitUntil(() => fixture.aborted.length >= 1), true, 'job_kill 必须把在途的贴图下载一起取消')
    assert.deepEqual(harness.pending(), { nextStep: 0, nextTurn: 0 }, '取消的作业不发完成通知')
  } finally {
    await harness.dispose()
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
  }
})

/**
 * ENV-14 Round 4（N310-R4）：**真实 PBR 材质变更**下的图纸事实不变。
 *
 * 链路（全部经**产品工具**）：
 *   drawning_inspect（真实 DXF，ezdxf）→ blender_texture_search（真实 PolyHaven，挑真 assetId）
 *   → blender_run(architecture, material_textures=<真实贴图>) → 再读同一张图纸 → compareFacts 逐条对照。
 * 负对照：① 不存在的 assetId ⇒ 材质步骤必须如实报"没接上"（且图纸事实不被写坏）；
 *         ② 无基线的 drawing_constraints_check ⇒ CONSTRAINTS_REQUIRED（不得凭空产生"已确认"）。
 * 入口：`node --test --experimental-strip-types packages/blender/test/blender-run.test.ts`（bun 下 dsh-subprocess-local 加载不了）。
 */
test('ENV-14：真实 PBR 材质变更前后图纸的尺寸/开口/合并摘要逐字不变（含两条负对照）', { skip: skipWithoutBlender }, async () => {
  // 产品根 = 本文件向上三级（packages/blender/test → 包根 → packages → 工作树根）
  assert.ok(process.env.LYAPUNOV_CAD_PYTHON, '本用例需要 LYAPUNOV_CAD_PYTHON（装 ezdxf 的隔离解释器）')
  const L_SHAPE = fileURLToPath(new URL('./cad-fixtures/plan-l-shape.dxf', import.meta.url))
  const harness = await createHarness({})
  const reportOf = (call: ToolCall): DrawingReport => (call.value as { report?: DrawingReport } | undefined)?.report as DrawingReport
  try {
    // 图纸工具由 blender 插件自己注册（plugin.ts:478-482 的 registerDrawingTools），这里不再重复注册；
    // CAD 解释器来自 LYAPUNOV_CAD_PYTHON（本用例运行时已设置，见文件头命令口径）。
    // ① 变更前：真实图纸事实
    const baseline = reportOf(await harness.callTool('drawing_inspect', { path: L_SHAPE, detail: 'full' }))
    assert.ok(baseline.factsDigest.length === 64, '基线必须有合并摘要')
    console.log(`[ENV-14] 变更前：尺寸 ${baseline.constraints.length} 条 / 开口 ${baseline.openings.length} 处 / facts ${baseline.factsDigest}`)
    // ② 真实 PolyHaven 候选（真 assetId + 真实分辨率）
    const search = await harness.callTool('blender_texture_search', { query: 'plaster wall', limit: 5 })
    const searchText = resultText(search)
    const candidates = JSON.parse(searchText) as { candidates?: Array<{ assetId?: string; resolutions?: string[]; prepaid?: boolean }> }
    const rows = (candidates.candidates ?? []).filter(row => row.assetId && row.prepaid !== true)
    // 优先挑声明里有 2k 的；没有 resolutions 字段就取第一个（真取不到时 blender_run 会如实报原因）
    const pick = rows.find(row => (row.resolutions ?? []).includes('2k')) ?? rows[0]
    assert.ok(pick?.assetId, `PolyHaven 必须给出可用的 2k 候选：${searchText.slice(0, 300)}`)
    console.log(`[ENV-14] 选中真实贴图 assetId=${pick.assetId} resolutions=${JSON.stringify(pick.resolutions)}`)
    const out = await mkdtemp(join(tmpdir(), 'env14-material-'))
    // ③ 真实材质变更（architecture 工程里存在材质「浅色灰泥」，见 world.py:155）
    const positive = await harness.call({
      output_directory: out, architecture: true,
      material_textures: JSON.stringify({ 浅色灰泥: { assetId: pick.assetId, resolution: '2k' } }),
    })
    const positiveText = resultText(positive)
    console.log(`[ENV-14] blender_run(material_textures) 回执：${positiveText.slice(0, 900)}`)
    const run = JSON.parse(positiveText) as Record<string, unknown>
    const failureOf = (value: unknown): number => {
      if (Array.isArray(value)) return value.filter(row => (row as { ok?: boolean }).ok === false).length
      if (value && typeof value === 'object') return Object.values(value as Record<string, { ok?: boolean }>).filter(row => row?.ok === false).length
      return 0
    }
    // materialTextures 是对象（材质名 → {assetId,license,maps}）或数组，两种都按"真的接上了几个"数
    const applied = Array.isArray(run.materialTextures) ? run.materialTextures.length
      : (run.materialTextures && typeof run.materialTextures === 'object' ? Object.keys(run.materialTextures as object).length : 0)
    const failedRows = failureOf(run.textureRequest)
    console.log(`[ENV-14] materialTextures=${JSON.stringify(run.materialTextures ?? null).slice(0, 400)}`)
    console.log(`[ENV-14] textureRequest=${JSON.stringify(run.textureRequest ?? null).slice(0, 700)}`)
    console.log(`[ENV-14] 真实接上的材质 ${applied} 个；如实报未接上 ${failedRows} 个`)
    assert.ok(applied > 0 || failedRows > 0,
      '材质步骤必须要么真的接上贴图、要么如实报"没接上"——不许静默什么都没有')
    // ④ 变更后：同一张图纸再读一次 ⇒ 尺寸桶/开口桶/合并摘要逐字不变
    const after = reportOf(await harness.callTool('drawing_inspect', { path: L_SHAPE, detail: 'full' }))
    const facts = compareFacts(
      { constraints: baseline.constraints, openings: baseline.openings, openingSkips: baseline.openingSkips },
      { constraints: after.constraints, openings: after.openings, openingSkips: after.openingSkips })
    console.log(`[ENV-14] 变更后：facts ${facts.factsDigestBefore} → ${facts.factsDigestAfter}；unchanged=${facts.unchanged}` +
      `（尺寸 equal=${facts.dimensions.equal.length} changed=${facts.dimensions.changed.length}；开口 equal=${facts.openings.equal.length} changed=${facts.openings.changed.length}）`)
    assert.equal(facts.unchanged, true, '真实材质变更不该改动图纸的已确认事实')
    assert.equal(facts.factsDigestBefore, facts.factsDigestAfter)
    // ⑤ 负对照①：不存在的 assetId ⇒ 必须如实失败（且图纸事实仍未被写坏）
    const negative = await harness.call({
      output_directory: await mkdtemp(join(tmpdir(), 'env14-material-neg-')), architecture: true,
      material_textures: JSON.stringify({ 浅色灰泥: { assetId: 'plaster_concrete_wall', resolution: '2k' } }),
    })
    const negativeText = resultText(negative)
    const neg = JSON.parse(negativeText) as Record<string, unknown>
    console.log(`[ENV-14] 负对照（不存在 assetId）materialTextures=${JSON.stringify(neg.materialTextures ?? null)}`)
    console.log(`[ENV-14] 负对照（不存在 assetId）textureRequest=${JSON.stringify(neg.textureRequest ?? null)}`)
    assert.match(negativeText, /plaster_concrete_wall/, '必须点名那个不存在的 assetId')
    assert.ok(!/"materialTextures":\s*\[[^\]]/.test(negativeText) || /"ok":\s*false|reason/.test(negativeText),
      '不存在资产时不许报成"接上了"')
    const afterNegative = reportOf(await harness.callTool('drawing_inspect', { path: L_SHAPE, detail: 'full' }))
    assert.equal(afterNegative.factsDigest, baseline.factsDigest, '失败路径同样不得写坏图纸事实')
    // ⑥ 负对照②：无基线不得凭空产生"已确认"
    const noBaseline = await harness.callTool('drawing_constraints_check', { path: L_SHAPE })
    assert.equal(noBaseline.isError, true)
    assert.match(resultText(noBaseline), /CONSTRAINTS_BASELINE_REQUIRED/)
    console.log('[ENV-14] 负对照（无基线）⇒ CONSTRAINTS_BASELINE_REQUIRED ✅')
  } finally { await harness.dispose() }
})

// ── 12. ENV-57（P0＋A5）：暂停/恢复保持同一 jobId ──────────────────────────────
/**
 * 判据原文（不改）：`docs/ENVIRONMENT_GENERATION_TODO.md:104`「暂停恢复保持源工程/场景/参考/jobId。」
 *
 * **本实现的能力边界（测试与文案同一份事实）**：
 *  · pause ＝ 在作业输出目录写 `.lyapunov-job-state.json` 请求标记 ＋ 用既有 `terminate()` 停当前
 *    Blender 进程，**不落定作业**；原生 `JobStatus` 闭集没有 `paused` ⇒ 暂停期间原生
 *    `job_list`/`job_output` 照实显示 `running`，产品侧真实状态只在 `blender_job_control` 的 `state`。
 *  · resume ＝ **同一作业重跑（同 jobId）**：已完成的阶段会**重算**，**不是断点续算**。
 *  · 暂停不跨宿主重启（作业记录活在宿主进程内存）。
 *
 * **每条都带负对照**：①jobId 逐字不变且记录数不变 ②终态 resume ⇒ ALREADY_FINISHED 且不得
 * 出现第二个 jobId ③未暂停过 resume ⇒ NOT_PAUSED ④kind≠blender ⇒ NOT_BLENDER（未知/他人会话
 * 用原生错误、不包装）⑤pause 幂等 ⑥检查点不符 ⇒ INPUT_MISMATCH 且作业仍停在暂停。
 */
interface ControlReading { jobId: string; action: string; state: string; nativeStatus: string; resumeCount?: number; completedPhases?: string[]; pausedAt?: string; alreadyRequested?: boolean; alreadyPaused?: boolean; resumedWith?: string; argvDigest?: string; note?: string }
const controlOf = (call: ToolCall): ControlReading => {
  assert.equal(call.isError, false, resultText(call))
  return JSON.parse(String(call.value?.result)) as ControlReading
}
/** 本会话里 blender 作业的 id 集合（负对照"不得出现第二个 jobId"的机器判据）。 */
const blenderJobIds = (harness: Harness): string[] =>
  harness.ctx.jobs.list(harness.agent?.id).filter(job => job.kind === 'blender').map(job => String(job.id)).sort()
/** 假可执行文件：把每次收到的 argv 追加落盘，然后长时间 sleep（好让 pause 有东西可停）。 */
async function recordingExecutable(directory: string, log: string, tail = 'sleep 30'): Promise<string> {
  return await fakeExecutable(directory, `printf '%s\\n' "$*" >> '${log}'\n${tail}`)
}
const argvLines = async (log: string): Promise<string[]> =>
  existsSync(log) ? (await readFile(log, 'utf8')).split('\n').filter(line => line.length > 0) : []
/** 有界轮询：等一个**外部**事实（子进程起来 / 文件落盘），超时即失败，不无限等。 */
async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail(`等待超时（${timeoutMs} ms）：${what}`)
}
const stateFileOf = (output: string): string => join(output, '.lyapunov-job-state.json')
/** 原生 `job_list` 工具**渲染出来的原文**（"暂停期间原生面显示什么"的直接读数，不是我的推断）。 */
const nativeJobListText = (call: ToolCall): string => (call.content ?? []).map(block => block.text ?? '').join('\n')
const listedBlenderIds = (text: string): string[] => [...text.matchAll(/^(blender-\d+) \[/gm)].map(match => match[1]).sort()
const listedBlenderRows = (text: string): number => [...text.matchAll(/^blender-\d+ \[/gm)].length

test('ENV-57①：pause→resume 后 jobId 逐字相同、作业记录数不变；暂停期间原生状态照实是 running', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'env57-jobid-'))
  const log = join(directory, 'argv.log')
  const output = join(directory, 'world')
  const harness = await createHarness({ executable: await recordingExecutable(directory, log), toolJobs: true })
  try {
    const call = await harness.call({ output_directory: output, background: true })
    assert.equal(call.isError, false, resultText(call))
    const jobId = (JSON.parse(String(call.value?.result)) as JobCall).jobId
    assert.match(jobId, /^blender-\d+$/)
    assert.deepEqual(blenderJobIds(harness), [jobId])
    // 起跑时的原生面读数（后面每一步都要与此对照：**只有状态文字变，id 集合不变**）。
    const listedAtStart = nativeJobListText(await harness.callTool('job_list', {}))
    assert.deepEqual(listedBlenderIds(listedAtStart), [jobId])
    assert.match(listedAtStart, new RegExp(`^${jobId} \\[blender\\] running`, 'm'))

    const paused = controlOf(await harness.callTool('blender_job_control', { job_id: jobId, action: 'pause' }))
    assert.equal(paused.state, 'paused')
    assert.equal(paused.jobId, jobId, 'pause 回读的 jobId 必须逐字相同')
    assert.equal(paused.resumeCount, 0)
    // 负对照（本项机制的因果链）：暂停**不落定**记录 ⇒ 原生状态照实是 running。
    assert.equal(paused.nativeStatus, 'running')
    assert.equal(harness.ctx.jobs.read(jobId as never, harness.agent?.id).job.status, 'running', '暂停不落定：原生状态必须仍是 running')
    const onDisk = JSON.parse(await readFile(stateFileOf(output), 'utf8')) as Record<string, unknown>
    assert.equal(onDisk.state, 'paused')
    assert.equal(onDisk.jobId, jobId, '状态文件里的 jobId 必须就是这条作业')
    assert.equal(typeof onDisk.argvDigest, 'string')
    // 负对照：暂停作业仍是"未终态" ⇒ 同输出目录起不了第二个作业（既有 N106 互斥语义更稳）。
    const busy = await harness.call({ output_directory: output, background: true })
    assert.equal(busy.isError, true)
    assert.match(resultText(busy), /BLENDER_OUTPUT_BUSY/)
    assert.deepEqual(blenderJobIds(harness), [jobId], '暂停期间不得出现第二个 blender 作业')

    const status = controlOf(await harness.callTool('blender_job_control', { job_id: jobId, action: 'status' }))
    assert.equal(status.state, 'paused')
    assert.equal(status.nativeStatus, 'running', '原生口径仍是 running：上游 JobStatus 闭集没有 paused')
    // 原生面原文（§5.1 负对照：`job_list` 在 1/2/3/4 各取一次，id **集合**必须恒等于 {jobId}）：
    // 暂停期间原生 `job_list` 照实写 running —— 这正是"暂停只能由产品侧读数表达"的实测证据。
    const listedWhilePaused = nativeJobListText(await harness.callTool('job_list', {}))
    assert.match(listedWhilePaused, new RegExp(`^${jobId} \\[blender\\] running`, 'm'), `暂停期间原生 job_list 仍显示 running：${listedWhilePaused}`)
    assert.deepEqual(listedBlenderIds(listedWhilePaused), [jobId], '暂停期间原生 job_list 的 id 集合不变')
    assert.equal(listedBlenderRows(listedWhilePaused), listedBlenderRows(listedAtStart))

    const resumed = controlOf(await harness.callTool('blender_job_control', { job_id: jobId, action: 'resume' }))
    assert.equal(resumed.jobId, jobId, 'resume 必须逐字沿用同一个 jobId')
    assert.equal(resumed.state, 'running')
    assert.equal(resumed.resumeCount, 1)
    assert.equal(resumed.resumedWith, '原 argv（本作业还没有 source.blend）', '没有 source.blend 时如实回落原 argv，不假装用了源工程')
    assert.deepEqual(blenderJobIds(harness), [jobId], 'resume 不得新铸第二个 jobId')
    assert.equal(harness.ctx.jobs.list(harness.agent?.id).length, 1, '全过程只有一条作业记录')
    assert.equal(harness.ctx.jobs.read(jobId as never, harness.agent?.id).job.status, 'running')
    // 恢复后原生面：同一条 id 还在，仍是 running（这一次是真的在跑），行数不变 ⇒ 没有第二个作业。
    const listedAfterResume = nativeJobListText(await harness.callTool('job_list', {}))
    assert.deepEqual(listedBlenderIds(listedAfterResume), [jobId])
    assert.equal(listedBlenderRows(listedAfterResume), listedBlenderRows(listedAtStart))
    assert.match(listedAfterResume, new RegExp(`^${jobId} \\[blender\\] running`, 'm'))
    await waitFor(async () => (await argvLines(log)).length >= 2, 8000, '恢复后的第二个子进程真的起来了（同一 jobId 的第二次尝试）')
    const [first, second] = await argvLines(log)
    assert.ok(first.includes('--factory-startup'), `第一次尝试用的是调用方原本的输入：${first}`)
    assert.ok(second.includes('--factory-startup'), `没有 source.blend ⇒ 恢复如实回落原 argv：${second}`)

    // 收尾：真终态仍然是 job_kill（暂停/恢复不改变取消语义）
    assert.equal(harness.ctx.jobs.kill(jobId as never, harness.agent?.id, 'ENV-57 测试收尾'), 'requested')
    assert.equal((await harness.ctx.jobs.wait(jobId as never, 15_000, harness.agent?.id)).status, 'killed')
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('ENV-57②：终态作业 resume ⇒ ALREADY_FINISHED，且作业记录数不变（绝不新铸 jobId）', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'env57-finished-'))
  const harness = await createHarness({ executable: await fakeExecutable(directory, `printf 'LYAPUNOV_RESULT={"scene":"/w/scene.json"}\\n'`), toolJobs: true })
  try {
    const call = await harness.call({ output_directory: join(directory, 'world'), background: true })
    assert.equal(call.isError, false, resultText(call))
    const jobId = (JSON.parse(String(call.value?.result)) as JobCall).jobId
    assert.equal((await harness.ctx.jobs.wait(jobId as never, 15_000, harness.agent?.id)).status, 'completed')
    const idsBefore = blenderJobIds(harness)
    const recordsBefore = harness.ctx.jobs.list(harness.agent?.id).length
    // 原生 `job_list` 原文快照（终态：completed）——被拒绝的 resume 之后必须**逐字不变**。
    const listedBefore = nativeJobListText(await harness.callTool('job_list', {}))
    assert.match(listedBefore, new RegExp(`^${jobId} \\[blender\\] completed`, 'm'))

    const resume = await harness.callTool('blender_job_control', { job_id: jobId, action: 'resume' })
    assert.equal(resume.isError, true, '终态作业不能被"恢复"')
    assert.match(resultText(resume), /BLENDER_JOB_RESUME_ALREADY_FINISHED/)
    const pause = await harness.callTool('blender_job_control', { job_id: jobId, action: 'pause' })
    assert.equal(pause.isError, true)
    assert.match(resultText(pause), /BLENDER_JOB_PAUSE_ALREADY_FINISHED/)
    // 核心负对照：两条被拒绝的控制动作都**没有**产生第二条作业记录、也没有新 jobId。
    assert.deepEqual(blenderJobIds(harness), idsBefore, '被拒绝的 resume 不得新铸第二个 jobId')
    assert.equal(harness.ctx.jobs.list(harness.agent?.id).length, recordsBefore, '被拒绝的 resume 不得新增作业记录')
    const listedAfter = nativeJobListText(await harness.callTool('job_list', {}))
    assert.equal(listedAfter, listedBefore, '原生 job_list 必须逐字不变（行数、id、状态都不变）')
    assert.equal(listedBlenderRows(listedAfter), 1, 'job_list 里 blender 作业行数恒为 1（不得出现第二个 jobId）')
    const status = controlOf(await harness.callTool('blender_job_control', { job_id: jobId, action: 'status' }))
    assert.equal(status.state, 'finished', 'status 对终态作业也要能读（不是抛错）')
    assert.equal(status.nativeStatus, 'completed')
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('ENV-57③：从未暂停的 running 作业 resume ⇒ NOT_PAUSED（且不新起作业、不改状态）', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'env57-notpaused-'))
  const log = join(directory, 'argv.log')
  const output = join(directory, 'world')
  const harness = await createHarness({ executable: await recordingExecutable(directory, log) })
  try {
    const call = await harness.call({ output_directory: output, background: true })
    const jobId = (JSON.parse(String(call.value?.result)) as JobCall).jobId
    await waitFor(async () => (await argvLines(log)).length >= 1, 8000, '第一个子进程起来')
    const resume = await harness.callTool('blender_job_control', { job_id: jobId, action: 'resume' })
    assert.equal(resume.isError, true)
    assert.match(resultText(resume), /BLENDER_JOB_RESUME_NOT_PAUSED/)
    assert.deepEqual(blenderJobIds(harness), [jobId], '被拒绝的 resume 不得新铸第二个 jobId')
    assert.equal(harness.ctx.jobs.read(jobId as never, harness.agent?.id).job.status, 'running')
    // 负对照：状态文件不该因为一次被拒绝的 resume 而凭空出现（没有暂停过就没有检查点）
    assert.equal(existsSync(stateFileOf(output)), false, '从未暂停的作业不该有暂停状态文件')
    assert.equal((await argvLines(log)).length, 1, '被拒绝的 resume 不得起第二个子进程')
    assert.equal(harness.ctx.jobs.kill(jobId as never, harness.agent?.id, 'ENV-57 测试收尾'), 'requested')
    assert.equal((await harness.ctx.jobs.wait(jobId as never, 15_000, harness.agent?.id)).status, 'killed')
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('ENV-57④：kind≠blender ⇒ NOT_BLENDER；未知/他人会话 jobId 用原生错误、不包装', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'env57-kind-'))
  const output = join(directory, 'world')
  const harness = await createHarness({ executable: await recordingExecutable(directory, join(directory, 'argv.log')) })
  try {
    // ① kind=bash 的作业（最小生产者）：三种 action 都必须按 kind 拒绝，并指出正确的读法。
    const foreign = harness.ctx.jobs.start({
      kind: 'bash', label: 'sleep 30', owner: harness.agent?.id,
      run: () => ({ cancel: () => undefined, done: Promise.resolve({ status: 'completed' as const, result: 'bash 输出' }) }),
    })
    assert.equal((await harness.ctx.jobs.wait(foreign as never, 15_000, harness.agent?.id)).status, 'completed')
    for (const action of ['pause', 'resume', 'status']) {
      const call = await harness.callTool('blender_job_control', { job_id: foreign, action })
      assert.equal(call.isError, true, `kind=bash 的作业不该接受 ${action}`)
      assert.match(resultText(call), /BLENDER_JOB_CONTROL_NOT_BLENDER/, `action=${action}`)
      assert.match(resultText(call), /kind=bash/)
      assert.match(resultText(call), /job_output/, '拒绝时要指出正确的读法（原生 job_output）')
    }
    // ② 未知 jobId：**不包装**，直接用原生文案，也不该带本插件的错误码前缀。
    const unknown = await harness.callTool('blender_job_control', { job_id: 'blender-99999', action: 'pause' })
    assert.equal(unknown.isError, true)
    assert.match(resultText(unknown), /unknown job blender-99999/)
    assert.doesNotMatch(resultText(unknown), /BLENDER_JOB_CONTROL|BLENDER_JOB_RESUME|BLENDER_JOB_PAUSE/)
    // ③ 他人会话的作业：原生 owner 判权拦住，同样不包装。
    const other = await harness.createAgent('env57-other-session')
    const otherCall = await harness.callTool('blender_run', { output_directory: join(directory, 'world-other'), background: true }, { caller: other })
    assert.equal(otherCall.isError, false, resultText(otherCall))
    const otherJob = (JSON.parse(String(otherCall.value?.result)) as JobCall).jobId
    assert.match(otherJob, /^blender-\d+$/)
    for (const action of ['pause', 'resume', 'status']) {
      const call = await harness.callTool('blender_job_control', { job_id: otherJob, action })
      assert.equal(call.isError, true, `别的会话的作业不该接受 ${action}（本会话的 agent 调用）`)
      assert.match(resultText(call), /belongs to another session/, `action=${action}`)
      assert.doesNotMatch(resultText(call), /BLENDER_JOB_CONTROL|BLENDER_JOB_RESUME|BLENDER_JOB_PAUSE/)
    }
    // 收尾：用**它的 owner** 取消，避免留下活作业
    assert.equal(harness.ctx.jobs.kill(otherJob as never, other?.id, 'ENV-57 测试收尾'), 'requested')
    assert.equal((await harness.ctx.jobs.wait(otherJob as never, 15_000, other?.id)).status, 'killed')
    // 负对照：暂停/恢复拒绝路径不得在本会话里留下任何 blender 作业记录
    assert.deepEqual(blenderJobIds(harness), [])
    assert.equal(existsSync(stateFileOf(output)), false, '被拒绝的控制动作不得写出暂停状态文件')
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('ENV-57⑤：pause 幂等——第二次不重复写状态文件、不重复停进程、jobId 不变', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'env57-idem-'))
  const log = join(directory, 'argv.log')
  const output = join(directory, 'world')
  const harness = await createHarness({ executable: await recordingExecutable(directory, log) })
  try {
    const call = await harness.call({ output_directory: output, background: true })
    const jobId = (JSON.parse(String(call.value?.result)) as JobCall).jobId
    const first = controlOf(await harness.callTool('blender_job_control', { job_id: jobId, action: 'pause' }))
    assert.equal(first.state, 'paused')
    const fileAfterFirst = await readFile(stateFileOf(output), 'utf8')
    const second = controlOf(await harness.callTool('blender_job_control', { job_id: jobId, action: 'pause' }))
    assert.equal(second.state, 'paused')
    assert.equal(second.jobId, jobId)
    assert.equal(second.alreadyRequested, true, '第二次 pause 是幂等 no-op（如实回 alreadyRequested）')
    assert.equal(second.alreadyPaused, true)
    assert.equal(second.pausedAt, first.pausedAt, '幂等：不刷新 pausedAt')
    assert.equal(await readFile(stateFileOf(output), 'utf8'), fileAfterFirst, '幂等：状态文件逐字不变')
    assert.deepEqual(blenderJobIds(harness), [jobId], '幂等：不得出现第二个作业')
    assert.equal((await argvLines(log)).length, 1, '幂等：不得再起一个子进程')
    assert.equal(harness.ctx.jobs.kill(jobId as never, harness.agent?.id, 'ENV-57 测试收尾'), 'requested')
    assert.equal((await harness.ctx.jobs.wait(jobId as never, 15_000, harness.agent?.id)).status, 'killed')
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('ENV-57⑥：resume 时输入源与检查点不符 ⇒ INPUT_MISMATCH，且作业仍停在暂停（不偷跑）', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'env57-mismatch-'))
  const log = join(directory, 'argv.log')
  const output = join(directory, 'world')
  const harness = await createHarness({ executable: await recordingExecutable(directory, log) })
  try {
    const call = await harness.call({ output_directory: output, background: true })
    const jobId = (JSON.parse(String(call.value?.result)) as JobCall).jobId
    assert.equal(controlOf(await harness.callTool('blender_job_control', { job_id: jobId, action: 'pause' })).state, 'paused')

    // ① 摘要对不上（模拟"输出目录里的暂停状态不是这套输入写的"）：如实拒绝，且**不许**恢复。
    const checkpoint = JSON.parse(await readFile(stateFileOf(output), 'utf8')) as Record<string, unknown>
    await writeFile(stateFileOf(output), JSON.stringify({ ...checkpoint, argvDigest: 'sha256:0000' }, null, 2) + '\n')
    const mismatch = await harness.callTool('blender_job_control', { job_id: jobId, action: 'resume' })
    assert.equal(mismatch.isError, true)
    assert.match(resultText(mismatch), /BLENDER_JOB_RESUME_INPUT_MISMATCH/)
    assert.match(resultText(mismatch), /argvDigest/)
    // 负对照：被拒绝的 resume 不得偷跑——作业仍在暂停、没有第二个子进程、没有新作业。
    assert.equal(controlOf(await harness.callTool('blender_job_control', { job_id: jobId, action: 'status' })).state, 'paused')
    assert.equal(harness.ctx.jobs.read(jobId as never, harness.agent?.id).job.status, 'running')
    assert.equal((await argvLines(log)).length, 1, '被拒绝的 resume 不得起第二个子进程')
    assert.deepEqual(blenderJobIds(harness), [jobId])

    // ② 检查点文件被删掉：同样拒绝（无法确认用的还是同一份输入），不静默恢复。
    await rm(stateFileOf(output), { force: true })
    const missing = await harness.callTool('blender_job_control', { job_id: jobId, action: 'resume' })
    assert.equal(missing.isError, true)
    assert.match(resultText(missing), /BLENDER_JOB_RESUME_INPUT_MISMATCH/)
    assert.match(resultText(missing), /检查点文件不存在/)
    assert.equal((await argvLines(log)).length, 1)
    assert.equal(controlOf(await harness.callTool('blender_job_control', { job_id: jobId, action: 'status' })).state, 'paused')

    // 恢复检查点后 resume 照常成立——证明上面两次失败是"判据真的在挡"，不是功能坏了。
    await writeFile(stateFileOf(output), JSON.stringify(checkpoint, null, 2) + '\n')
    const ok = controlOf(await harness.callTool('blender_job_control', { job_id: jobId, action: 'resume' }))
    assert.equal(ok.jobId, jobId)
    await waitFor(async () => (await argvLines(log)).length >= 2, 8000, '恢复后第二个子进程起来')
    assert.equal(harness.ctx.jobs.kill(jobId as never, harness.agent?.id, 'ENV-57 测试收尾'), 'requested')
    assert.equal((await harness.ctx.jobs.wait(jobId as never, 15_000, harness.agent?.id)).status, 'killed')
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('ENV-57：暂停中 job_kill 必须落定（否则 owner 释放会卡在 await job.settled）', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'env57-killpaused-'))
  const log = join(directory, 'argv.log')
  const output = join(directory, 'world')
  const harness = await createHarness({ executable: await recordingExecutable(directory, log) })
  try {
    const call = await harness.call({ output_directory: output, background: true })
    const jobId = (JSON.parse(String(call.value?.result)) as JobCall).jobId
    assert.equal(controlOf(await harness.callTool('blender_job_control', { job_id: jobId, action: 'pause' })).state, 'paused')
    // 暂停中的作业被 kill：有界 wait 必须**返回**（卡住的话这里就超时失败，而不是"看起来通过"）。
    assert.equal(harness.ctx.jobs.kill(jobId as never, harness.agent?.id, '暂停中取消'), 'requested')
    const snapshot = await harness.ctx.jobs.wait(jobId as never, 15_000, harness.agent?.id)
    assert.equal(snapshot.status, 'killed', '暂停中 job_kill 必须落定（不能卡在 await job.settled）')
    assert.match((harness.ctx.jobs.read(jobId as never, harness.agent?.id).result ?? ''), /BLENDER_CANCELLED/)
    // 落定之后：resume 只能 ALREADY_FINISHED（暂停不跨宿主重启的同一条道理）。
    const after = await harness.callTool('blender_job_control', { job_id: jobId, action: 'resume' })
    assert.equal(after.isError, true)
    assert.match(resultText(after), /BLENDER_JOB_RESUME_ALREADY_FINISHED/)
    assert.deepEqual(blenderJobIds(harness), [jobId], '取消路径同样不得新铸 jobId')
    assert.equal((await argvLines(log)).length, 1, '暂停中被取消：不该再起第二个子进程')
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('ENV-57 A5：resume 打开本作业的 output/source.blend（保住工程里的资源身份），不再 --factory-startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'env57-a5-'))
  const log = join(directory, 'argv.log')
  const output = join(directory, 'world')
  const harness = await createHarness({ executable: await recordingExecutable(directory, log) })
  try {
    const call = await harness.call({ output_directory: output, background: true })
    const jobId = (JSON.parse(String(call.value?.result)) as JobCall).jobId
    assert.equal(controlOf(await harness.callTool('blender_job_control', { job_id: jobId, action: 'pause' })).state, 'paused')
    // 本作业已写出的源工程（真机里由 world.py 在内容变化时保存）。
    const source = join(output, 'source.blend')
    await writeFile(source, 'BLENDER-工程占位字节')
    const resumed = controlOf(await harness.callTool('blender_job_control', { job_id: jobId, action: 'resume' }))
    assert.equal(resumed.jobId, jobId)
    assert.equal(resumed.resumedWith, source, 'resume 必须用本作业的 source.blend，而不是空工程')
    await waitFor(async () => (await argvLines(log)).length >= 2, 8000, '恢复后的第二个子进程起来')
    const [first, second] = await argvLines(log)
    // 假可执行文件收到的是 `$*`（**不含** $0 自己那个可执行文件路径），所以：
    // tokens[0]='--background'、tokens[1]=输入源（source.blend 或 --factory-startup）。
    const secondTokens = second.split(' ')
    assert.equal(secondTokens[0], '--background', `恢复的 argv 形状应与原 argv 一致：${second}`)
    assert.equal(secondTokens[1], source, `恢复的 argv 必须打开 source.blend：${second}`)
    assert.equal(secondTokens.includes('--factory-startup'), false, `恢复不得再用 --factory-startup：${second}`)
    assert.equal(first.split(' ')[1], '--factory-startup', '第一次尝试仍是调用方原本的输入（本用例没给 source_blend）')
    assert.deepEqual(blenderJobIds(harness), [jobId], 'A5 不改变 jobId：仍是同一条作业')
    assert.equal(harness.ctx.jobs.kill(jobId as never, harness.agent?.id, 'ENV-57 测试收尾'), 'requested')
    assert.equal((await harness.ctx.jobs.wait(jobId as never, 15_000, harness.agent?.id)).status, 'killed')
  } finally {
    await harness.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('ENV-57：暂停中的作业被 owner 释放（服务卸载）时也必须落定——dispose 不得卡在 await job.settled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'env57-dispose-'))
  const log = join(directory, 'argv.log')
  const output = join(directory, 'world')
  const harness = await createHarness({ executable: await recordingExecutable(directory, log) })
  try {
    const call = await harness.call({ output_directory: output, background: true })
    const jobId = (JSON.parse(String(call.value?.result)) as JobCall).jobId
    assert.equal(controlOf(await harness.callTool('blender_job_control', { job_id: jobId, action: 'pause' })).state, 'paused')
    // owner 释放走 `disposeOwned`：`cancelForTeardown` 之后 `await Promise.all(owned.map(job => job.settled))`
    // （vendored `jobs-local:467-476`；注释 `:505` 明写"cancel 不落定就可能 stall"）。
    // 暂停中的作业若不能被取消唤醒，这一步**永远不返回** ⇒ 用有界 race 取证，超时即失败（不是"看起来通过"）。
    let timer: ReturnType<typeof setTimeout> | undefined
    const bounded = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), 12_000) })
    try {
      const outcome = await Promise.race([harness.dispose().then(() => 'disposed' as const), bounded])
      assert.equal(outcome, 'disposed', '暂停中的作业被 owner 释放时必须落定（否则 disposeOwned 卡在 await job.settled）')
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    assert.equal(existsSync(stateFileOf(output)), true, '暂停状态文件仍在（取消不删别人的状态文件）')
  } finally {
    await harness.dispose().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('ENV-57⑦（缺陷 2）：完整跑完后 completedPhases 反映"真的完成了什么"，不得仍只报 ["textures"]', async () => {
  const fixture = await startPolyHavenFixture()
  const directory = await mkdtemp(join(tmpdir(), 'env57-phases-'))
  const pauseLog = join(directory, 'argv-pause.log')
  const plainLog = join(directory, 'argv-plain.log')
  await mkdir(join(directory, 'exe-pause'), { recursive: true })
  await mkdir(join(directory, 'exe-plain'), { recursive: true })
  // 第一次尝试长睡（好让 pause 真有东西可停），第二次尝试（resume）立刻打出结果行 ⇒ 这个作业真的跑完。
  const pauseExecutable = await fakeExecutable(join(directory, 'exe-pause'), `printf '%s\\n' "$*" >> '${pauseLog}'
if [ "$(wc -l < '${pauseLog}')" -ge 2 ]; then printf '${PREFIX}{"scene":"/w/scene.json"}\\n'; else sleep 30; fi`)
  const plainExecutable = await fakeExecutable(join(directory, 'exe-plain'), `printf '%s\\n' "$*" >> '${plainLog}'
printf '${PREFIX}{"scene":"/w/scene.json"}\\n'`)
  const textures = JSON.stringify({ 墙面: 'plaster concrete wall' })
  const pausedHarness = await createHarness({ textureApiBase: fixture.base, executable: pauseExecutable })
  const plainHarness = await createHarness({ textureApiBase: fixture.base, executable: plainExecutable })
  try {
    // ① pause→resume 完整跑完（缺陷 2 的真机形态：L406 的 blender-6 resume 后仍回 ["textures"]）。
    const jobDir = join(directory, 'world-paused')
    const call = await pausedHarness.call({ output_directory: jobDir, background: true, material_textures: textures })
    assert.equal(call.isError, false, resultText(call))
    const jobId = (JSON.parse(String(call.value?.result)) as JobCall).jobId
    await waitFor(async () => (await argvLines(pauseLog)).length >= 1, 8000, '第一次子进程真的起来了（pause 才有东西可停）')
    const paused = controlOf(await pausedHarness.callTool('blender_job_control', { job_id: jobId, action: 'pause' }))
    assert.equal(paused.state, 'paused')
    // 暂停边界上的读数**不是缺陷**：此刻确实只完成了取图/输入准备（后面的阶段还没跑）。
    assert.deepEqual(paused.completedPhases, ['textures'], '暂停边界如实只记取图完成')
    const resumed = controlOf(await pausedHarness.callTool('blender_job_control', { job_id: jobId, action: 'resume' }))
    assert.equal(resumed.jobId, jobId, 'resume 逐字沿用同一个 jobId')
    assert.equal(resumed.resumeCount, 1)
    assert.equal((await pausedHarness.ctx.jobs.wait(jobId as never, 30_000, pausedHarness.agent?.id)).status, 'completed', '恢复轮必须真的跑完（本用例的前提）')
    const status = controlOf(await pausedHarness.callTool('blender_job_control', { job_id: jobId, action: 'status' }))
    assert.equal(status.nativeStatus, 'completed')
    assert.deepEqual(status.completedPhases, ['textures', 'blender'],
      `终态必须反映 Blender 侧也跑完了（world.py 的建模/导出/渲染）：${JSON.stringify(status.completedPhases)}`)
    assert.notDeepEqual(status.completedPhases, ['textures'], '缺陷 2：resume 跑完后不得仍只报 ["textures"]')
    // 口径说明随终态回执一起给：字段语义写在回执里（模型/页面不必去读源码猜）。
    assert.match(status.note ?? '', /completedPhases/, `终态回执必须带字段口径：${status.note ?? ''}`)
    assert.deepEqual(blenderJobIds(pausedHarness), [jobId], '全程只有一条作业记录')
    // 负对照：磁盘检查点只在 pause/resume 边界写，**不**随终态刷新 ⇒ 终态口径以本条回执为准。
    const onDisk = JSON.parse(await readFile(stateFileOf(jobDir), 'utf8')) as Record<string, unknown>
    assert.equal(onDisk.state, 'resumed')
    assert.deepEqual(onDisk.completedPhases, ['textures'], '磁盘检查点是暂停边界的快照，不冒充终态读数')

    // ② 负对照：从未暂停、一次跑完的作业同样不许在终态只报取图（同一处误读的另一半）。
    const plain = await plainHarness.call({ output_directory: join(directory, 'world-plain'), background: true, material_textures: textures })
    assert.equal(plain.isError, false, resultText(plain))
    const plainId = (JSON.parse(String(plain.value?.result)) as JobCall).jobId
    assert.equal((await plainHarness.ctx.jobs.wait(plainId as never, 30_000, plainHarness.agent?.id)).status, 'completed')
    const plainStatus = controlOf(await plainHarness.callTool('blender_job_control', { job_id: plainId, action: 'status' }))
    assert.deepEqual(plainStatus.completedPhases, ['textures', 'blender'],
      `一次跑完的作业也不许只报取图：${JSON.stringify(plainStatus.completedPhases)}`)
  } finally {
    await pausedHarness.dispose().catch(() => undefined)
    await plainHarness.dispose().catch(() => undefined)
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('resumeArgv（A5 纯函数）：有 output/source.blend 就打开它；没有就原样回落（负对照）', () => {
  // `executable` 必须**显式**给：`blenderArgv` 的解析链是
  // `input.executable ?? process.env.BLENDER_EXECUTABLE ?? 'blender'`（`src/plugin.ts:240`），
  // 而本文件头恰恰教人用 `BLENDER_EXECUTABLE` 跑真机验收。不给的话，设了该变量后 argv[0] 会变成
  // `/snap/blender/current/blender`，下面这条**纯函数**断言就随环境假红——那是测试的环境依赖缺陷，
  // 不是产品缺陷（真机验收本来就要求设这个变量）。显式给 ⇒ 断言在有无 `BLENDER_EXECUTABLE` 时逐字相同。
  // env/兜底那一段解析链由上面的 `blenderArgv` 用例单独覆盖（`:253-255` 逐字用
  // `process.env.BLENDER_EXECUTABLE ?? 'blender'` 对照），这里不重复也不因此失去覆盖。
  const input = { worldScript: '/w/world.py', output: '/o/world', operation: 'build' as const, fixture: true, executable: 'blender' }
  const withSource = resumeArgv(input, () => true)
  assert.deepEqual(withSource.slice(0, 4), ['blender', '--background', join(input.output, 'source.blend'), '--python-exit-code'])
  assert.equal(withSource.includes('--factory-startup'), false)
  assert.deepEqual(blenderArgv(input).slice(0, 3), ['blender', '--background', '--factory-startup'])
  // 负对照：工程文件不在时**不假装**用了源工程，逐字回落原 argv。
  assert.deepEqual(resumeArgv(input, () => false), blenderArgv(input))
  assert.equal(resumeArgv(input, () => false).includes('--factory-startup'), true)
})
