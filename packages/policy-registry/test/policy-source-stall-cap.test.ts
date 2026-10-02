/**
 * 停摆上限（`POLICY_DOWNLOAD_STALL_MS`）必须**按它的名字**工作（W25 缺陷修正，2026-09-26）。
 *
 * W25 把建连时创建的 `AbortSignal.timeout(30s)` 一直挂在 body 上 ⇒ body 阶段的停摆计时器
 * **必然比它晚** ⇒ 读正文永远被总时限掐断，而注释/回执却写「整体耗时不限」。
 * 本文件钉住修好后的三句话：
 *   1. **trickle（每 100ms 到 8 字节）在停摆上限之内必须能收完**，即使整段耗时**超过建连上限**
 *      —— 按比例缩放常量（`connectMs`）与**真实默认常量**（30s/30s）各一条；
 *   2. **只有「一个字节都不来」**才抛 `POLICY_DOWNLOAD_STALL`（应答头必须已经到手）；
 *   3. 中途停摆照样要掐 —— 修的不是"把守卫关掉"。
 *
 * 真实 30s 那一条跑 ~33s（收完）／~90s（还原修改点后变红），它**就是本单的判据**；
 * 另一条回环读数（真 `downloadFile`、真常量、35s 的流 ⇒ 收完）见同名回执 §5。
 * 网络一律是**本机回环**（`Bun.serve` / 裸 TCP + 真 fetch），不打任何外网。
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boundedFetch, downloadFile, NEGATIVE_CONTROL, newPolicyFetchTrace, PolicyFetchError, POLICY_FETCH_ATTEMPTS } from '../src/source.ts'

const CHUNK = 8, EVERY = 100
/** 回环 trickle：先到应答头，再每 100ms 到 8 字节；`silentAfter` 之后停摆（不入队也不关闭）。 */
const trickleServer = (total: number, silentAfter = Number.POSITIVE_INFINITY) => Bun.serve({
  port: 0, hostname: '127.0.0.1',
  fetch() {
    let sent = 0
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent >= total) { controller.close(); return }
        if (sent >= silentAfter) return await new Promise<void>(() => {})
        await Bun.sleep(EVERY)
        const bytes = new Uint8Array(Math.min(CHUNK, total - sent)).fill(7)
        sent += bytes.byteLength
        controller.enqueue(bytes)
      },
    }), { status: 200, headers: { 'content-type': 'application/octet-stream' } })
  },
})
/**
 * 裸 TCP：**只写应答头**（`Content-Length: total`），正文**一个字节都不发**。
 * 为什么不用 `Bun.serve`：应答头必须**立刻**到达，才能把"读正文停摆"与"建连没有应答"分开量。
 */
const headerOnlyServer = (total: number) => {
  const answered = new WeakSet<object>()
  const server = Bun.listen({
    hostname: '127.0.0.1', port: 0,
    socket: {
      data(socket) {
        if (answered.has(socket)) return
        answered.add(socket)
        socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${total}\r\nContent-Type: application/octet-stream\r\n\r\n`)
      },
    },
  })
  return { port: server.port, stop: () => server.stop(true) }
}
const payloadOf = (total: number) => { const bytes = Buffer.alloc(total); bytes.fill(7); return bytes }
const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const fileOf = (total: number, url: string) => ({ path: 'params/x.bin', bytes: total, revision: 'r', sha256: shaOf(payloadOf(total)), url })
const emptyDir = () => mkdtempSync(join(tmpdir(), 'policy-stall-'))

// ─────────────────────────────────────────────────────────────────────────────
// 机器守卫：让「这个修复**还在不在**」自动可见（本单新增）。
//
// 为什么要它：`source.ts` 被多条 lane 写过（W25 基线 `c8747c78…`/877 行 → 本修 `975f0841…`/922 行），
// 而各 lane 的 `stage/*` 副本是按**旧基线**做的 ⇒ 哪条 lane 把旧副本 `cp` 回树，
// 这个修复会被**静默覆盖**：下面 6 条用例要么超时（真尺度那条要 90s+）要么红得看不出成因。
// 这一条在**毫秒级**给出可读原因，并且**排在最前**（不陪着跑完 34s 才发现文件不对）。
//
// 判据（与 `bugfixHistory/POLICY-STALL-CAP-FIX-20260926.md` §8 同一套）：`timeoutScope` 计数**下限 10**
// ＋「两个 30s 各管各的」这条语义的五个锚点（锚点才是判别性的那半 —— 旧基线上五个全缺、计数为 0）。
//
// ⚠️ 两个**故意**的选择，都是实测逼出来的（`bugfixHistory/STALL-CAP-GUARD-20260926.md` §3）：
//   · **计数取下限，不取等值**：本单执行期间 `source.ts` 被另一条 lane 连续改写（922 → 976 行），
//     其中**一版短暂出现了第 11 处 `timeoutScope`**（而修复五个锚点一个没少）。
//     等值判据会把"别人的合法新增"判成"修复没了" —— 那正是这一轮反复抓的"判据说假话"。
//   · **不锚 sha256**：同一原因（落地值 `975f0841…` 只对应**那一刻**的树，不是不变量）。
//
// ── 被守卫的**文件**可以被指向副本（2026-09-27 追加，机制 12 的"负对照改在副本上做"）──────────
// `POLICY_SOURCE_GUARD_PATH=<副本>` ⇒ **同一条判据**对着副本跑（旧基线 ⇒ 必须红；现盘＋一处合法提及
// ⇒ 必须仍绿），不必把旧基线 `cp` 回树 —— 那正是"在共享产品文件上做就地负对照＝在读数面上投毒"。
// 生效时用例会打印一行 `[guard] sourceFile=… sha256=…`，读数自带出处。交付/CI 下**不设**这个变量。
// ─────────────────────────────────────────────────────────────────────────────
const SOURCE_PATH = process.env.POLICY_SOURCE_GUARD_PATH ?? join(import.meta.dirname, '..', 'src', 'source.ts')
const STALL_CAP_ANCHORS: [string, RegExp][] = [
  ['可撤销的建连上限（`newConnectDeadline` 返回 `disarm`）', /disarm: \(\) => clearTimeout\(timer\)/],
  ['作用域判定：只有 `connect` 用可撤销的上限', /options\.timeoutScope === 'connect' \? newConnectDeadline\(timeoutMs\)/],
  ['**到应答头即撤销**（这一行就是修复本身）', /deadline\?\.disarm\(\)/],
  ['逐件下载那一跳显式传 `timeoutScope: \'connect\'`', /timeoutScope: 'connect', timeoutMs: connectMs/],
  ['口径句「这 30s 是**停摆**上限，不是总时限」', /这 30s 是\*\*停摆\*\*上限，不是总时限/],
]
/**
 * `classifyExhausted`（W26-R2 的**耗尽出口**）的**两处锚点** —— 这条接线被并发 lane 切掉过**两次**：
 *   · 第一次（00:48:16 的 922 行版）把 `boundedFetch` 的**选项类型字段 ＋ 消费点 ＋ 投递点**一起删掉
 *     ⇒ 真类型错 `TS2353`，而它被"**语法错让 `tsc` 整段跳过语义检查**"掩盖了 25 分钟（机制 14）；
 *   · 第二次（01:28:32 前后，**36 秒**窗口，被 F3 那条人造用例抓到）**只切消费点**、选项类型字段留着
 *     ⇒ **单文件 `tsc` exit 0**，编译器**一句话都不说**（`bugfixHistory/SOURCE-TYPE-ERROR-AND-TSC-BLINDNESS-20260926.md` §3.2）。
 * ⇒ 这一条把"这个修复还在不在"变成**毫秒级可读**的读数。计数只用**下限**（`timeoutScope ≥ 10`），
 * 判别性交给下面两个**内容锚点** —— 等值判据会把别条 lane 的合法新增判成"修复没了"（本文件上面那条的注）。
 */
export const EXHAUSTED_ANCHORS: [string, RegExp][] = [
  ['`boundedFetch` 的**选项类型**仍接受分类器（922 行版连它一起删 ⇒ TS2353）', /export async function boundedFetch\([^\n]*classifyExhausted\?: ExhaustedResponseClassifier[^\n]*\): Promise<Response>/],
  ['**消费点**：`boundedFetch` 真的把分类器用上了（只切这一处 ⇒ `tsc` 不说话）', /const classified = options\.classifyExhausted\?\.\(response, url, failures\.length\) \?\? null/],
]
/** 就地负对照哨兵：交付态**必须**是 `export const NEGATIVE_CONTROL: string | null = null`。 */
const SENTINEL_DECLARATION = /^export const NEGATIVE_CONTROL: string \| null = (.+)$/m

export interface SourceInspection {
  sha256: string
  lines: number
  timeoutScope: number
  missingStall: string[]
  missingExhausted: string[]
  sentinelDeclared: boolean
  /** `null`＝交付态；字符串＝**就地负对照态**（这份读数不可当交付读数）。 */
  negativeControl: string | null
  ok: boolean
}
/**
 * 同一份判据的**纯函数**形态（`text` 进、读数出）。
 *
 * 为什么要能从用例里导出：负对照/活性对照要拿**别的**内容跑**同一条**判据
 * （旧基线 `.runtime/lane-stall/source.base.ts` ⇒ 必须红；现盘 ＋ 一处合法提及 ⇒ 必须仍绿），
 * 写死在 `test()` 回调里就只能"再抄一份判据"——那正是"判据有两份、迟早分叉"的形状。
 */
export function inspectSourceFixes(text: string): SourceInspection {
  const sentinel = SENTINEL_DECLARATION.exec(text)
  const raw = sentinel?.[1]?.trim()
  const negativeControl = raw === undefined || raw === 'null' ? null : raw.replace(/^['"]|['"]$/g, '')
  const missingStall = STALL_CAP_ANCHORS.filter(([, pattern]) => !pattern.test(text)).map(([name]) => name)
  const missingExhausted = EXHAUSTED_ANCHORS.filter(([, pattern]) => !pattern.test(text)).map(([name]) => name)
  const timeoutScope = (text.match(/timeoutScope/g) ?? []).length
  const sentinelDeclared = sentinel !== null && raw !== undefined
  return {
    sha256: createHash('sha256').update(text).digest('hex'),
    lines: text.split('\n').length,
    timeoutScope, missingStall, missingExhausted, sentinelDeclared, negativeControl,
    ok: timeoutScope >= 10 && missingStall.length === 0 && missingExhausted.length === 0 && sentinelDeclared && negativeControl === null,
  }
}
/**
 * 判据被指向**副本**时（`POLICY_SOURCE_GUARD_PATH`），把"这份读数出自哪个文件"打进读数
 * —— 与 `release-gate.ts` 的 `gateFile=`／`negctl=` 三件套同一口径：读数自带出处，复核的人不必猜。
 */
const noteSourceFile = (report: SourceInspection) => {
  if (process.env.POLICY_SOURCE_GUARD_PATH) console.log(`[guard] sourceFile=${SOURCE_PATH} sha256=${report.sha256} lines=${report.lines} negctl=${report.negativeControl ?? 'none'}`)
}

describe('机器守卫：这个修复还在 `source.ts` 里吗', () => {
  test('`timeoutScope` 计数 ≥ 10 且五个锚点都在（缺了 ⇒ 报出可读原因，不猜行号）', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8')
    const count = (source.match(/timeoutScope/g) ?? []).length
    const lines = source.split('\n').length
    const sha256 = createHash('sha256').update(source).digest('hex')
    noteSourceFile(inspectSourceFixes(source))
    const missing = STALL_CAP_ANCHORS.filter(([, pattern]) => !pattern.test(source)).map(([name]) => name)
    if (count < 10 || missing.length > 0) {
      throw new Error([
        '「停摆上限」修复（`bugfixHistory/POLICY-STALL-CAP-FIX-20260926.md`）在 `source.ts` 里**不完整**。',
        '  最可能的成因：某条 lane 把**基于旧基线**（`c8747c78…` / 877 行，`timeoutScope` 命中 0、五个锚点全缺）的 `stage/*` 副本 `cp` 回了树。',
        `  实测：sha256=${sha256} · ${lines} 行 · timeoutScope=${count}（落地值 10，判据是**下限**；W25 旧基线 0）`,
        missing.length ? `  缺失的锚点：\n${missing.map(name => `    - ${name}`).join('\n')}` : '  锚点：五个都在',
        '  处置（内容锚点式重放，锚点漂了会**报错退出**、绝不猜行号）：',
        '    python3 .runtime/lane-stall/apply-stall-cap.py <旧基线> <out>   # 产物 sha 应为 975f0841…',
        '    再把产物 `cp` 回 `packages/policy-registry/src/source.ts`，复跑本文件。',
        '  计数 > 10 不算失败（别条 lane 的合法新增）—— 只有 < 10 或锚点缺失才是修复被覆盖。',
      ].join('\n'))
    }
    expect(count).toBeGreaterThanOrEqual(10)
    expect(missing).toEqual([])
  })
})

describe('机器守卫：`classifyExhausted` 接线还在不在 ＋ 就地负对照哨兵（`source.ts` 是全仓并发热点）', () => {
  test('`timeoutScope` 计数 ≥ 10（下限）且 `classifyExhausted` **两处锚点**都在', () => {
    const report = inspectSourceFixes(readFileSync(SOURCE_PATH, 'utf8'))
    noteSourceFile(report)
    if (report.timeoutScope < 10 || report.missingExhausted.length > 0) {
      throw new Error([
        '「429 **耗尽出口**」接线（`bugfixHistory/CLASSIFYEXHAUSTED-RESTORE-20260926.md`）在 `source.ts` 里**不完整**。',
        '  两次历史形态：① 00:48:16 的 922 行版把「选项类型字段 ＋ 消费点 ＋ 投递点」一起切（⇒ 真类型错 TS2353，'
        + '被"语法错让 tsc 跳过语义检查"掩盖，见 docs/VERIFICATION_MECHANISMS.md 机制 14）；',
        '                ② 01:28:32 那一次**只切消费点**（选项类型留着 ⇒ 单文件 tsc exit 0，编译器一句话都不说）。',
        `  实测：sha256=${report.sha256} · ${report.lines} 行 · timeoutScope=${report.timeoutScope}（判据是**下限 10**，> 10 不算失败） · negctl=${report.negativeControl ?? 'none'}`,
        report.missingExhausted.length ? `  缺失的锚点：\n${report.missingExhausted.map(name => `    - ${name}`).join('\n')}` : '  锚点：两处都在',
        '  处置（内容锚点式重放，锚点漂了会报错退出、绝不猜行号）：只恢复被切掉的那两三行 ——',
        '    `const classified = options.classifyExhausted?.(response, url, failures.length) ?? null` 与',
        '    `throw new PolicyFetchError({ …, retryable: classified?.retryable ?? true, …, diagnosis: classified?.diagnosis ?? null })`。',
        '  别动别条 lane 的改动（§7.7 ②：不许撤销别的 lane 的改动）。',
      ].join('\n'))
    }
    expect(report.timeoutScope).toBeGreaterThanOrEqual(10)
    expect(report.missingExhausted).toEqual([])
  })

  test('就地负对照哨兵：交付态必须是 `export const NEGATIVE_CONTROL: string | null = null`（忘了撤 ⇒ 这里红）', () => {
    const report = inspectSourceFixes(readFileSync(SOURCE_PATH, 'utf8'))
    noteSourceFile(report)
    if (!report.sentinelDeclared || report.negativeControl !== null) {
      throw new Error([
        report.sentinelDeclared
          ? `\`source.ts\` 正跑在**就地负对照态**上（negctl=${report.negativeControl}）—— **这不是交付态读数**。`
          : '`source.ts` 里没有就地负对照哨兵（`export const NEGATIVE_CONTROL: string | null = null`）。',
        '  为什么要它（docs/VERIFICATION_MECHANISMS.md 机制 12 的同族）：在**共享产品文件**上就地做负对照'
        + '＝在读数面上投毒；本文件 01:24:44–01:33:50 之间被"切/补"≥4 次，那一窗口里别条 lane 的用例/门/tsc'
        + '读数都需要按"可能中毒"处理，而读数里没有任何字段提示它。',
        `  实测：sha256=${report.sha256} · ${report.lines} 行 · negctl=${report.negativeControl ?? '（哨兵缺失）'}`,
        '  处置：跑完负对照**立刻**把它设回 `null`（交付态），再复跑本文件。',
      ].join('\n'))
    }
    expect(report.negativeControl).toBe(null)
    expect(NEGATIVE_CONTROL).toBe(null)
  })
})

describe('停摆上限：读正文不被建连上限掐断（`timeoutScope: connect`）', () => {
  test('建连上限 300ms，而 3s 的 trickle（8B/100ms）仍能收完', async () => {
    const server = trickleServer(240)
    const started = Date.now()
    let received = 0
    const response = await boundedFetch(`http://127.0.0.1:${server.port}/trickle`, {}, { step: '建连', timeoutMs: 300, timeoutScope: 'connect' })
    for await (const piece of response.body as ReadableStream<Uint8Array>) received += piece.byteLength
    const elapsed = Date.now() - started
    server.stop(true)
    expect(received).toBe(240)
    expect(elapsed).toBeGreaterThanOrEqual(2_400)   // 真的读满了 3s，不是 300ms 就被掐
  }, 25_000)

  test('负对照（默认作用域 = W25 改前行为）：同一个流在 300ms 就被总时限掐断，而字节一直在到', async () => {
    const server = trickleServer(240)
    const started = Date.now()
    let received = 0
    let error: Error | null = null
    try {
      const response = await boundedFetch(`http://127.0.0.1:${server.port}/trickle`, {}, { step: '建连', timeoutMs: 300 })
      for await (const piece of response.body as ReadableStream<Uint8Array>) received += piece.byteLength
    } catch (reason) { error = reason as Error }
    const elapsed = Date.now() - started
    server.stop(true)
    expect(String(error)).toContain('TimeoutError')
    expect(received).toBeLessThan(240)
    expect(elapsed).toBeLessThan(1_500)
  }, 25_000)
})

describe('停摆上限：产品路径（downloadFile）', () => {
  test('4s 的 trickle 超过建连上限（connectMs 300ms）仍收完、落盘、sha256 相符', async () => {
    const server = trickleServer(320)
    const target = join(emptyDir(), 'x.bin')
    const started = Date.now()
    const transfer = await downloadFile(fileOf(320, `http://127.0.0.1:${server.port}/x.bin`), target, new AbortController().signal, false, newPolicyFetchTrace(), { stallMs: 1_000, connectMs: 300 })
    const elapsed = Date.now() - started
    server.stop(true)
    expect(existsSync(target + '.part')).toBe(false)
    expect(readFileSync(target).byteLength).toBe(320)
    expect(transfer.receivedBytes).toBe(320)
    expect(elapsed).toBeGreaterThanOrEqual(3_200)
  }, 25_000)

  test('真·判据：**真实默认常量**（建连 30s / 停摆 30s）下，32.5s 的 trickle 必须收完', async () => {
    const server = trickleServer(2600)
    const target = join(emptyDir(), 'x.bin')
    const started = Date.now()
    const transfer = await downloadFile(fileOf(2600, `http://127.0.0.1:${server.port}/x.bin`), target, new AbortController().signal, false, newPolicyFetchTrace(), {})
    const elapsed = Date.now() - started
    server.stop(true)
    expect(transfer.receivedBytes).toBe(2600)
    expect(readFileSync(target).byteLength).toBe(2600)
    expect(elapsed).toBeGreaterThanOrEqual(30_000)  // 整段**超过建连上限**，仍是一次尝试收完
  }, 120_000)

  test('应答头到手但**一个字节都不来** ⇒ 到点抛 POLICY_DOWNLOAD_STALL，3 次尝试全留痕', async () => {
    const server = headerOnlyServer(4)
    const trace = newPolicyFetchTrace()
    const error = await downloadFile(fileOf(4, `http://127.0.0.1:${server.port}/x.bin`), join(emptyDir(), 'x.bin'), new AbortController().signal, false, trace, { stallMs: 300, connectMs: 5_000 }).then(() => null, (reason: Error) => reason)
    server.stop()
    expect(error).toBeInstanceOf(PolicyFetchError)
    expect(String(error)).toContain('POLICY_DOWNLOAD_STALL')
    expect((error as PolicyFetchError).attempts.length).toBe(POLICY_FETCH_ATTEMPTS)
    expect(trace.attempts.every(attempt => String(attempt.reason).includes('POLICY_DOWNLOAD_STALL'))).toBe(true)
  }, 25_000)

  test('中途停摆一样要掐（不是把守卫关掉）：前 200B 在到，之后没有字节', async () => {
    const server = trickleServer(400, 200)
    const error = await downloadFile(fileOf(400, `http://127.0.0.1:${server.port}/x.bin`), join(emptyDir(), 'x.bin'), new AbortController().signal, false, newPolicyFetchTrace(), { stallMs: 500, connectMs: 5_000 }).then(() => null, (reason: Error) => reason)
    server.stop(true)
    expect(error).toBeInstanceOf(PolicyFetchError)
    expect(String(error)).toContain('POLICY_DOWNLOAD_STALL')
  }, 25_000)
})
