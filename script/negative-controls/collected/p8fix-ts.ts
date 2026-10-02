/**
 * R-fix#7 负对照：**逐处还原修改点** ⇒ 用例必须**精确变红**；逐字节还原后全绿。
 *
 * 纪律：只改工作树里的三个交付文件，每次改完**从备份逐字节还原**（sha256 必须相同）；
 * **不执行任何 git 写命令**；不跑 `bun run test:ci`；不碰网络（全部 fetch 桩）。
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const ROOT = '/home/s18/WS/Lyapunov/Dev'
const LANE = join(ROOT, '.runtime/lane-p8fix')
const FILES = {
  fetch: 'packages/lyapunov-share/src/fetch.ts',
  operations: 'packages/lyapunov-share/src/operations.ts',
  test: 'packages/lyapunov-share/test/operations-bounded-fetch.test.ts',
} as const
type FileKey = keyof typeof FILES

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const absolute = (key: FileKey) => join(ROOT, FILES[key])
mkdirSync(join(LANE, 'backup'), { recursive: true })

const pristine: Record<FileKey, string> = { fetch: readFileSync(absolute('fetch'), 'utf8'), operations: readFileSync(absolute('operations'), 'utf8'), test: readFileSync(absolute('test'), 'utf8') }
for (const key of Object.keys(FILES) as FileKey[]) copyFileSync(absolute(key), join(LANE, 'backup', `${key}.ts`))

interface Mutation { name: string; file: FileKey; from: string; to: string; expect: string[] }
const MUTATIONS: Mutation[] = [
  {
    name: 'N1 取消守卫整个失效（throwIfCancelled 空实现）',
    file: 'operations', from: 'const throwIfCancelled=(signal:AbortSignal)=>{if(signal.aborted)throw signal.reason??new Error(\'SHARE_CANCELLED\')}',
    to: 'const throwIfCancelled=(_signal:AbortSignal)=>{}',
    expect: ['取消**原样传播**', 'preview-route'],
  },
  {
    name: 'N1b 只摘掉 identity() 里那一处取消守卫（P8 的原始回归点）',
    file: 'operations', from: 'catch(error){\n   throwIfCancelled(signal)\n   if(isShareFetchError(error))throw error',
    to: 'catch(error){\n   if(isShareFetchError(error))throw error',
    expect: ['取消**原样传播**', 'preview-route'],
  },
  {
    name: 'N2 5xx/429 不再算瞬时（还原"一次即失败 + 可否重试：false"）',
    file: 'fetch', from: 'export function isTransientShareStatus(status: number): boolean { return TRANSIENT_STATUS.has(status) }',
    to: 'export function isTransientShareStatus(status: number): boolean { return false }',
    expect: ['5xx/429 是**瞬时**的', 'preview-route'],
  },
  {
    name: 'N3 落盘诊断忽略调用点传入的 url/attempts（还原 url:"" + attempts:[]）',
    file: 'operations', from: "url:isShareFetchError(error)?error.url:(input.url??''),",
    to: "url:isShareFetchError(error)?error.url:'',",
    expect: ['**非瞬时路径**的落盘诊断'],
  },
  {
    name: 'N3b 落盘诊断忽略调用点传入的 attempts',
    file: 'operations', from: 'attempts:isShareFetchError(error)?[...error.attempts]:[...(input.attempts??[])]}',
    to: 'attempts:isShareFetchError(error)?[...error.attempts]:[]}',
    expect: ['**非瞬时路径**的落盘诊断'],
  },
  {
    name: 'N4 尝试上限不可解除（还原 P8 的 AbortSignal.timeout：正文也被掐断）',
    file: 'fetch', from: 'return { signal: controller.signal, clear: () => clearTimeout(timer) }',
    to: 'return { signal: controller.signal, clear: () => {} }',
    expect: ['尝试上限只覆盖'],
  },
  {
    name: 'N5 凭据泄漏：把请求头拼进每次尝试的原因',
    file: 'fetch', from: 'record(describeError(error), retryable, attempt, Date.now() - started)',
    to: "record(describeError(error) + ' headers=' + JSON.stringify(rest.headers ?? {}), retryable, attempt, Date.now() - started)",
    expect: ['凭据不进错误与诊断'],
  },
  {
    name: 'N6 正文泄漏：把上游应答正文拼进错误消息',
    file: 'operations', from: "先修正账户/服务地址/入参再试）'",
    to: "先修正账户/服务地址/入参再试）' + '\\n  上游正文：' + text.slice(0, 200)",
    expect: ['上游**正文**不进错误与诊断'],
  },
]

const restore = (key: FileKey) => writeFileSync(absolute(key), pristine[key])
const restoreAll = () => { for (const key of Object.keys(FILES) as FileKey[]) restore(key) }

const runTests = async () => {
  const child = Bun.spawn([process.execPath, '--no-env-file', 'test', FILES.test], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  await child.exited
  const output = stdout + stderr
  // bun 打印两次（逐条 + 收尾汇总），且有的条目没有 `[Nms]` 后缀 ⇒ 两种形态都要收，再按名字去重。
  const failed = [...new Set([...output.matchAll(/^\(fail\) (.+?)(?: \[\d+(?:\.\d+)?ms\])?$/gm)].map(match => match[1]!.trim()))]
  const pass = Number(output.match(/^\s*(\d+) pass$/m)?.[1] ?? -1)
  const fail = Number(output.match(/^\s*(\d+) fail$/m)?.[1] ?? -1)
  return { output, failed, pass, fail, exit: child.exitCode }
}

const report: string[] = []
const line = (text = '') => { report.push(text); console.log(text) }
const baseline = await runTests()
line('===== 基线（未变异）=====')
line(`pass=${baseline.pass} fail=${baseline.fail} exit=${baseline.exit}`)
line(`sha256 fetch=${sha256(pristine.fetch).slice(0, 16)} operations=${sha256(pristine.operations).slice(0, 16)} test=${sha256(pristine.test).slice(0, 16)}`)
line()

for (const mutation of MUTATIONS) {
  const source = pristine[mutation.file]
  const occurrences = source.split(mutation.from).length - 1
  line('='.repeat(78))
  line(`变异 ${mutation.name}`)
  line(`  文件 ${FILES[mutation.file]} · 命中次数 ${occurrences}${occurrences === 1 ? '' : '  ⚠️ 不是 1 ⇒ 该变异不可信'}`)
  if (occurrences !== 1) { line('  ⇒ 跳过（变异点不唯一）'); continue }
  writeFileSync(absolute(mutation.file), source.replace(mutation.from, mutation.to))
  try {
    const result = await runTests()
    const matched = mutation.expect.filter(fragment => result.failed.some(name => name.includes(fragment)))
    line(`  pass=${result.pass} fail=${result.fail} exit=${result.exit}`)
    line(`  失败用例（${result.failed.length}）:`)
    for (const name of result.failed) line(`    - ${name}`)
    line(`  期望变红的组命中：${matched.length}/${mutation.expect.length}${matched.length === mutation.expect.length ? ' ✓' : ' ✗'}`)
    for (const fragment of mutation.expect) line(`    ${matched.includes(fragment) ? '✓' : '✗'} ${fragment}`)
    writeFileSync(join(LANE, 'logs', `negative-${mutation.name.split(' ')[0]}.log`), result.output)
  } finally {
    restoreAll()
    const same = (Object.keys(FILES) as FileKey[]).every(key => sha256(readFileSync(absolute(key), 'utf8')) === sha256(pristine[key]))
    line(`  逐字节还原：${same ? '一致 ✓' : '不一致 ✗✗✗'}`)
  }
  line()
}

line('===== 收尾（逐字节还原后全绿）=====')
const after = await runTests()
line(`pass=${after.pass} fail=${after.fail} exit=${after.exit}`)
line(`sha256 fetch=${sha256(readFileSync(absolute('fetch'), 'utf8')).slice(0, 16)} operations=${sha256(readFileSync(absolute('operations'), 'utf8')).slice(0, 16)} test=${sha256(readFileSync(absolute('test'), 'utf8')).slice(0, 16)}`)
writeFileSync(join(LANE, 'logs', 'negative-control-console.log'), report.join('\n') + '\n')
console.log('\n报告写入 .runtime/lane-p8fix/logs/negative-control-console.log')
