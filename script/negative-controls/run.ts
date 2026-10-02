#!/usr/bin/env bun
/**
 * 负对照统一执行器（`script/negative-controls/run.ts`）
 * ============================================================================
 *
 * ## 它解决的是什么
 *
 * `bugfixHistory/NEGATIVE-CONTROL-NOOP-SWEEP-20260926.md` §4 查出：全仓 25 个模式变异型负对照里，
 * **只有 18 个**带"命中次数断言"，写法各不相同（`assert count==1` / `!=1→exit` / `throw` / `sys.exit`
 * / 只查"文件变了"），而**唯一那条真 no-op（P8 变异 B）恰好就是没有断言的那一档**。
 * 结论：P8 不是偶然，是**缺一条强制规矩**。这个文件把那条规矩落成**可跑的执行器** ——
 * 规矩写在执行器里，就不必指望每个写脚本的人自己记得。
 *
 * ## 八条规矩（与 `NEGATIVE-CONTROL-NOOP-SWEEP` §4 逐条对应，编号一致）
 *
 * | # | 规矩 | 本执行器怎么落 |
 * | --- | --- | --- |
 * | 1 | 每个变异**恰好 1 次**命中（或显式 N）；**0 或 ≥2 拒绝执行**，非零退出 | `stage1_anchorCheck()`。命中数 ≠ want ⇒ `exit 3`，**一个字节都不改**（先全验后改） |
 * | 2 | **锚版本**：开头打印目标文件 `sha256`；跑完**逐字节还原**并复核同一 `sha256` | `sha256Hex()` + 开头 `[NC] target=… sha256=…` + 收尾 `逐字节还原：一致 ✓` |
 * | 3 | 失败必须响：每个变异打印 `命中次数=` / `还原=一致/不一致`；任一项不满足 ⇒ **非零退出**（不许 `\|\| true`） | `MUST()` 抛错即 `exit 1`；每条变异一行读数 |
 * | 4 | **no-op 判据 = 「目标文件在它跑的那一版里命中 0」**；跨版本判定必须附**版本哈希**；**禁止用"某处 grep 得到"当命中证据** | 命中数只在**目标文件当前字节**上数；`--show-noop` 模式专门演示"全仓 grep 命中 1，目标文件命中 0" |
 * | 5 | **一次运行一行读数**：`pass/fail` + `Ran …[..s]` + 日志路径必须来自**同一次运行** | `runTests()` 一次子进程调用同时产出这三个数，`reading()` 只从这一个对象取 |
 * | 6 | **负对照跑的那一版 = 交付的那一版**：给**三文件 sha256 对照**（改前 / 交付 / 负对照用） | 收尾打 `三版对照` 三行 + 与 `git rev-parse HEAD` 的 `blob` 对照 |
 * | 7 | **只做"去掉/还原"**：变异改**产品代码**，**用例一个字不动** | `--test-file` 只读；执行器**拒绝**把 `.test.`/`.spec.` 当 target；跑完核 test 文件 sha 未变 |
 * | 8 | **负对照脚本进库**：`.runtime/**` 是 gitignored ⇒ 不进库 = 不可复算的声称 | 本目录在 `script/negative-controls/**`（受版本控制）；`.runtime/**` 只允许**只读**引用 |
 *
 * ## 用法
 *
 * ```bash
 * export PATH="$HOME/.bun/bin:$PATH"
 * bun run script/negative-controls/run.ts script/negative-controls/controls/<name>.control.json
 * bun run script/negative-controls/run.ts <spec> --dry-run    # 只核锚点、不改任何字节
 * bun run script/negative-controls/run.ts --show-noop         # 演示"目标文件命中 0"怎么被抓住
 * ```
 *
 * `spec` 为 JSON（`ControlSpec`）。**规格进库**也是规矩 8 的一部分：脚本正文会被 rot，
 * 而"锚点是什么、期望哪几条用例变红"进库之后，下一个复算的人不必去猜。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

export interface Anchor {
  /** 人读的名字（会打进读数行） */
  name: string
  /** 要**去掉**的那一段（逐字节，含缩进与换行） */
  find: string
  /** 换成什么。空串 = 直接删掉 */
  replace: string
  /** 目标文件里应该命中几次。**默认 1**；写别的值必须在 `note` 里说明理由 */
  want?: number
  note?: string
  /** 期望这条变异会让哪些用例名（子串）变红 —— 空数组 = 脚本自己也不知道 ⇒ 判失败（"只红不看红在哪，等于没证"） */
  expectFailed: string[]
}

export interface ControlSpec {
  /** 这条负对照在证明什么（一句话） */
  claim: string
  /** 相对仓库根的**产品**文件路径（不许是 `.test.`/`.spec.`：规矩 7） */
  target: string
  /** 跑哪条用例（相对仓库根） */
  testFile: string
  /** 执行器：与 `release-gate.ts` 的 `caseExec` 同口径 */
  runner?: 'bun:test' | 'node:test' | 'plain' | 'python'
  /** 基线读数（单跑实测）。写进来之后，基线对不上就报错 —— 防"基线本身已经红了还在做对照" */
  baseline: { pass: number; fail: number; assertions: number }
  anchors: Anchor[]
  /** 出处：这条负对照第一次出现在哪份回执 / 哪个 lane */
  origin: string
}

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.env.NC_ROOT ?? resolve(import.meta.dirname, '../..')
const sha256Hex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
const id16 = (s: string | Buffer) => sha256Hex(s).slice(0, 16)
const TEST_LIKE = /\.(test|spec)\.(ts|tsx|mts|cts|js|mjs|cjs)$/

let exitCode = 0
const out: string[] = []
function say(line = ''): void {
  out.push(line)
  process.stdout.write(line + '\n')
}
/** 规矩 3：任一项不满足 ⇒ 抛错 ⇒ 非零退出。**没有 `|| true` 这个选项。** */
function MUST(cond: unknown, why: string): asserts cond {
  if (!cond) {
    say(`[NC][ABORT] ${why}`)
    exitCode = 1
    throw new Error(why)
  }
}

interface TestRun {
  pass: number
  fail: number
  assertions: number
  failedNames: string[]
  /** 规矩 5：这三个数与下面两项**必须来自同一次运行** */
  ranLine: string
  logPath: string
  exit: number | null
}

function execFor(spec: ControlSpec): { cmd: string; args: (f: string) => string[] } {
  const bun = join(process.env.HOME ?? '/root', '.bun/bin/bun')
  const cmd = existsSync(bun) ? bun : 'bun'
  switch (spec.runner ?? 'bun:test') {
    case 'plain':
      return { cmd, args: (f) => ['--no-env-file', f] }
    case 'python':
      return { cmd: process.env.TESTCI_PYTHON ?? 'python3', args: (f) => [f] }
    default:
      return { cmd, args: (f) => ['--no-env-file', 'test', f] }
  }
}

/** 跑一次用例，**一次**产出规矩 5 要的那几个数。 */
function runTests(spec: ControlSpec, tag: string): TestRun {
  const { cmd, args } = execFor(spec)
  const t0 = Date.now()
  const r = spawnSync(cmd, args(spec.testFile), {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
    env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:` + process.env.PATH, NO_COLOR: '1', CI: '1' },
  })
  const raw = (r.stdout || '') + (r.stderr || '')
  const ms = Date.now() - t0
  const num = (re: RegExp) => {
    const m = re.exec(raw)
    return m ? Number(m[1]) : -1
  }
  const pass = num(/^\s*(\d+) pass$/m)
  const fail = num(/^\s*(\d+) fail$/m)
  const assertions = num(/^\s*(\d+) expect\(\) calls$/m)
  const failedNames = [...new Set([...raw.matchAll(/^\(fail\) (.+?)(?: \[\d+(?:\.\d+)?ms\])?$/gm)].map((m) => m[1]!.trim()))]
  const ranLine = raw.match(/^Ran \d+ tests? across \d+ files?\. \[[^\]]+\]$/m)?.[0] ?? '(没有 Ran 收尾行)'
  const logDir = join(ROOT, 'bugfixHistory/negative-controls/_logs')
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
  const logPath = join(logDir, `${spec.target.replace(/[^\w.-]/g, '_')}__${tag}.log`)
  writeFileSync(logPath, raw)
  // 一行读数：规矩 5 —— 同一行的三个数来自同一次运行
  say(
    `[NC] reading tag=${tag} pass=${pass} fail=${fail} assert=${assertions} exit=${String(r.status)} ms=${ms} ` +
      `ran="${ranLine}" log=${logPath.replace(ROOT + '/', '')}`,
  )
  return { pass, fail, assertions, failedNames, ranLine, logPath, exit: r.status }
}

/** 规矩 2 的打印口径：目标文件名的简写 + sha256 前 16 + 全量。 */
function printTargetIdentity(label: string, path: string, text: string): void {
  say(`[NC] ${label} ${path} sha256=${sha256Hex(text)} (${id16(text)}) bytes=${Buffer.byteLength(text)}`)
}

/** 规矩 6：与 git HEAD 的 blob 对照 —— **只读** git 命令。 */
function gitBlobSha(path: string): string {
  const r = spawnSync('git', ['hash-object', `--path=${path}`, '--stdin'], {
    cwd: ROOT,
    encoding: 'utf8',
    input: readFileSync(join(ROOT, path)),
  })
  return (r.stdout || '').trim() || '(git 不可用)'
}

// ─────────────────────────────────────────────────────────────────────────────
// `--show-noop`：专门演示规矩 4 的陷阱
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P8 那个 8 空格模式：`bugfixHistory/NEGATIVE-CONTROL-NOOP-SWEEP-20260926.md` §2.1 记的原文。
 * 它在**交付版** `fetch.ts` 里命中 0，在**今天重建的** `dist/plugin.js` 里命中 1
 * ⇒ 「某处 grep 得到」正是**看不到**这条 no-op 的原因。
 */
function showNoopDemo(): number {
  const pattern = '        timer = setTimeout(() => reject(stalled()), timeoutMs)'
  const target = 'packages/lyapunov-share/src/fetch.ts'
  const dist = 'packages/lyapunov-share/dist/plugin.js'
  say('# `--show-noop`：规矩 4 的陷阱（"某处 grep 得到" ≠ "目标文件命中"）')
  say('')
  say(`模式（P8 变异 B 写的那一条，前导 8 空格）：${JSON.stringify(pattern)}`)
  const t = join(ROOT, target)
  if (existsSync(t)) {
    const text = readFileSync(t, 'utf8')
    printTargetIdentity('目标文件', target, text)
    const hits = text.split(pattern).length - 1
    say(`[NC] 目标文件命中次数 = ${hits}${hits === 0 ? '  ⇒ **这条变异是 no-op**（P8 的坑）' : ''}`)
    say(`[NC] 目标文件里"裸子串"（无 8 空格）命中 = ${text.split('timer = setTimeout(() => reject(stalled()), timeoutMs)').length - 1}  ⇒ 代码在，只是形态不同`)
  } else {
    say(`[NC] ${target} 不存在 ⇒ 无法在目标文件上数命中`)
  }
  const d = join(ROOT, dist)
  if (existsSync(d)) {
    const dtext = readFileSync(d, 'utf8')
    say(`[NC] 全仓某处（${dist}）命中的次数 = ${dtext.split(pattern).length - 1}  ⇒ **这就是"grep 得到"的来源**`)
    say(`[NC] 但 ${dist} 不是这条脚本的目标文件、也不是它跑的那一版 ⇒ 不能当命中证据（规矩 4）`)
  } else {
    say(`[NC] ${dist} 不在盘上（未重建）⇒ 这一半无读数`)
  }
  say('')
  say('结论：判 no-op 只能写成 `命中次数(目标文件 @ 版本哈希) == 0`。')
  return 0
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

function runControl(specPath: string, dryRun: boolean): number {
  const spec = JSON.parse(readFileSync(resolve(specPath), 'utf8')) as ControlSpec
  const targetAbs = join(ROOT, spec.target)
  const testAbs = join(ROOT, spec.testFile)

  say(`# 负对照：${spec.claim}`)
  say('')
  say(`[NC] root=${ROOT}`)
  say(`[NC] spec=${specPath}`)
  say(`[NC] origin=${spec.origin}`)
  say()

  // ── 规矩 7：用例一个字不动 ────────────────────────────────────────────────
  MUST(!TEST_LIKE.test(spec.target), `规矩 7：target 是测试文件（${spec.target}）⇒ 负对照只许改产品代码`)
  MUST(existsSync(targetAbs), `目标文件不存在：${spec.target}`)
  MUST(existsSync(testAbs), `用例文件不存在：${spec.testFile}`)

  const pristine = readFileSync(targetAbs, 'utf8')
  const testPristine = readFileSync(testAbs, 'utf8')

  // ── 规矩 2：开头打印目标文件 sha256 ──────────────────────────────────────
  printTargetIdentity('目标文件', spec.target, pristine)
  printTargetIdentity('用例文件', spec.testFile, testPristine)
  say(`[NC] 目标文件 git-blob=${gitBlobSha(spec.target)}  ⇒ 与 HEAD 的差异从这里看`)
  say()

  // ── 规矩 1：**先全验后改**。0 或 ≥2 一律拒绝执行，一个字节都不改 ─────────
  say('## 阶段 1 · 锚点命中次数（规矩 1：恰好 N，0 或 ≥2 拒绝执行）')
  const hits = spec.anchors.map((a) => pristine.split(a.find).length - 1)
  let bad = 0
  spec.anchors.forEach((a, i) => {
    const want = a.want ?? 1
    const ok = hits[i] === want
    if (!ok) bad++
    say(
      `[NC] 锚点 ${a.name}: 命中次数=${hits[i]} 要求=${want} ${ok ? '✓' : '✗ ⇒ 拒绝执行'}${a.note ? `  （${a.note}）` : ''}`,
    )
  })
  MUST(bad === 0, `${bad} 个锚点命中次数不符 ⇒ 拒绝执行（**不改任何字节**；这正是 P8 no-op 的防线）`)
  say(`[NC] 全部 ${spec.anchors.length} 个锚点命中次数符合要求 ⇒ 允许进入阶段 2`)
  say()

  if (dryRun) {
    say('## --dry-run：只核锚点，不改任何字节（规矩 1 的"验"与"改"分离）')
    say(`[NC] 目标文件未改动 sha256=${sha256Hex(readFileSync(targetAbs, 'utf8'))}  ⇒ 与上面逐字节相同`)
    return 0
  }

  // ── 基线 ────────────────────────────────────────────────────────────────
  say('## 阶段 2 · 基线（未变异必须绿；基线自己红 ⇒ 对照无意义）')
  const base = runTests(spec, 'baseline')
  MUST(base.fail === 0 && base.pass > 0, `基线不绿（pass=${base.pass} fail=${base.fail}）⇒ 先修基线，别做对照`)
  MUST(
    base.pass === spec.baseline.pass && base.fail === spec.baseline.fail && base.assertions === spec.baseline.assertions,
    `基线与 spec 声明不符：spec=${spec.baseline.pass}/${spec.baseline.fail}/${spec.baseline.assertions} ` +
      `实测=${base.pass}/${base.fail}/${base.assertions} ⇒ 用例已经漂了，spec 要重冻（**不许把实测抄进 spec 就算过**）`,
  )
  say()

  // ── 逐变异 ──────────────────────────────────────────────────────────────
  let mutatedRuns = 0
  const summary: { name: string; hits: number; pass: number; fail: number; matched: string[]; expect: string[] }[] = []
  try {
    for (const [i, a] of spec.anchors.entries()) {
      const tag = `M${i + 1}-${a.name.replace(/[^\w.-]+/g, '_')}`
      say(`## 阶段 3.${i + 1} · 变异 ${a.name}`)
      const next = pristine.split(a.find).join(a.replace)
      MUST(sha256Hex(next) !== sha256Hex(pristine), `变异 ${a.name} 改完字节没变 ⇒ 这是 **no-op**（拒绝登记）`)
      writeFileSync(targetAbs, next)
      printTargetIdentity('变异态', spec.target, next)
      try {
        const m = runTests(spec, tag)
        mutatedRuns++
        MUST(m.fail > 0, `变异 ${a.name} 之后**用例没红**（pass=${m.pass} fail=${m.fail}）⇒ 这条负对照**不成立**`)
        MUST(
          a.expectFailed.length > 0,
          `变异 ${a.name} 没声明 expectFailed ⇒ "只红不看红在哪，等于没证"（规矩 3 末段）`,
        )
        const matched = a.expectFailed.filter((f) => m.failedNames.some((n) => n.includes(f)))
        say(`[NC] 变红用例（${m.failedNames.length}）：`)
        for (const n of m.failedNames) say(`[NC]   - ${n}`)
        say(`[NC] 期望变红的组命中：${matched.length}/${a.expectFailed.length}${matched.length === a.expectFailed.length ? ' ✓' : ' ✗'}`)
        for (const f of a.expectFailed) say(`[NC]   ${matched.includes(f) ? '✓' : '✗'} ${f}`)
        MUST(matched.length === a.expectFailed.length, `期望变红的组没全中 ⇒ 红的不是声称的那条链`)
        summary.push({ name: a.name, hits: hits[i]!, pass: m.pass, fail: m.fail, matched, expect: a.expectFailed })
      } finally {
        writeFileSync(targetAbs, pristine)
        const same = sha256Hex(readFileSync(targetAbs, 'utf8')) === sha256Hex(pristine)
        say(`[NC] 还原 sha256=${sha256Hex(readFileSync(targetAbs, 'utf8'))}`)
        say(`[NC] 逐字节还原：${same ? '一致 ✓' : '不一致 ✗✗✗'}`)
        MUST(same, `还原后与 run 前不一致（${spec.target}）⇒ 停下报 Lead，不许继续`)
      }
      say()
    }
  } finally {
    // 收尾兜底：任何异常路径都必须把文件放回去
    if (sha256Hex(readFileSync(targetAbs, 'utf8')) !== sha256Hex(pristine)) writeFileSync(targetAbs, pristine)
  }

  // ── 收尾 ────────────────────────────────────────────────────────────────
  say('## 阶段 4 · 收尾（还原后必须回到基线；规矩 2 / 6 的对照）')
  const after = runTests(spec, 'restored')
  MUST(
    after.pass === base.pass && after.fail === base.fail && after.assertions === base.assertions,
    `还原后读数与基线不同：基线 ${base.pass}/${base.fail}/${base.assertions} vs 收尾 ${after.pass}/${after.fail}/${after.assertions}`,
  )
  const testUnchanged = sha256Hex(readFileSync(testAbs, 'utf8')) === sha256Hex(testPristine)
  say(`[NC] 用例文件未改动：${testUnchanged ? '是 ✓' : '否 ✗✗✗'}（规矩 7：变异只许动产品代码）`)
  MUST(testUnchanged, '用例文件被改动了 ⇒ 违反规矩 7')
  say()
  say('## 三版对照（规矩 6）')
  say(`[NC] 改前 / 交付版（= 本次 run 前的工作树）  ${spec.target} sha256=${sha256Hex(pristine)}`)
  say(`[NC] 负对照用的那一版（逐条变异态见 ${mutatedRuns} 条 reading 行）`)
  say(`[NC] 交付版（= 收尾还原后）            ${spec.target} sha256=${sha256Hex(readFileSync(targetAbs, 'utf8'))}`)
  say(`[NC] git HEAD blob                          ${gitBlobSha(spec.target)}`)
  say()
  say('## 逐条读数（一次运行一行，规矩 5）')
  for (const s of summary)
    say(`[NC] ${s.name} 命中次数=${s.hits} 变异态 pass=${s.pass} fail=${s.fail} 期望组命中=${s.matched.length}/${s.expect.length}`)
  say()
  say(`## 结论：${spec.anchors.length} 个变异全部成立（每个都精确变红、且红的正是声明的用例）`)
  say(`##       逐字节还原：一致 ✓`)
  return 0
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.length === 0) {
  say('用法：')
  say('  bun run script/negative-controls/run.ts <spec.control.json> [--dry-run]')
  say('  bun run script/negative-controls/run.ts --show-noop     # 演示规矩 4 的陷阱（只读）')
  say('')
  say('退出码：0 全部成立且逐字节还原 / 1 任一规矩不满足 / 3 锚点命中次数不符（拒绝执行）/ 4 用法错')
  say('八条规矩的正文见本文件头注释与 README.md。')
  process.exit(0)
}
if (argv.includes('--show-noop')) process.exit(showNoopDemo())

const specPath = argv.find((a) => !a.startsWith('--'))
if (!specPath) {
  say('[NC][ABORT] 没给 spec 路径（用法见 --help）')
  process.exit(4)
}
try {
  exitCode = runControl(specPath, argv.includes('--dry-run'))
} catch (error) {
  say(`[NC][FAIL] ${(error as Error).message}`)
  exitCode = exitCode === 0 ? 1 : exitCode
}
process.exit(exitCode)
