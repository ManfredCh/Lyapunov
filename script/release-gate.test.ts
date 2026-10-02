#!/usr/bin/env bun
/**
 * P9 · `script/release-gate.ts` 的测试（2026-09-26）。
 *
 * 分两层，**两层都是负对照**：
 *
 * 1. **纯函数层**（同进程，秒级）：喂**人造读数**给出**人造结论**。这一层证明判定逻辑本身分得清
 *    "绿 / 红 / 没量到"，包括本仓踩过的两类假绿：plain 脚本被当成 `bun test` 跑（exit 0 / 0 读数）、
 *    汇总行与逐条记号行对不上（解析错却看着像通过）。
 * 2. **端到端层**（真起子进程）：用 `--selftest --cases <夹具> --expect <green|red|unproven>` 让**真的
 *    gate 进程**去跑夹具用例，断言它给出的裁决与点名。四条夹具：
 *      · 红夹具（真失败的 bun:test）      ⇒ 必须判 RED 并点名该用例
 *      · 绿夹具（真通过的 bun:test）      ⇒ 必须判 GREEN
 *      · 空夹具（exit 0 但什么都不输出）  ⇒ 必须判 **UNPROVEN**，不得当通过
 *      · **真实用例 + 人为抬高下限**      ⇒ 必须判 RED 并点名是哪一条（等价于"把某个回归用例改红"，
 *        但不改仓库里的任何文件 —— 本单写入域只有 gate 与其测试）
 *
 * `--cases` 这个口子只能与 `--selftest` 同用（否则退出码 4）：所以它**没法用来把发布门刷绿**，
 * 这里也把这条守卫本身测了。
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  aggregate,
  ARGS_EXIT,
  CASES,
  collectOfflineCi,
  COVERAGE_WAIVERS,
  countAssertSites,
  coverageAttribution,
  deriveRoundCandidates,
  detectRunnerStyle,
  EPIPE_EXIT,
  EPIPE_NOTICE,
  evalCase,
  evalCaseIntegrity,
  evalClaimConsistency,
  evalCoverage,
  evalFloorDrift,
  evalGateDriversCriterion,
  evalManifestGap,
  evalOfflineCiCriterion,
  evalPreflightCriterion,
  evalSelfCheck,
  evalSkipAccounting,
  evalTheme,
  evalTscCriterion,
  FLOOR_BASELINE_FROZEN,
  floorBaselineDigest,
  GREEN_EXIT,
  MANIFEST_GAP_FROZEN,
  manifestGapDigest,
  manifestGateGap,
  NEGATIVE_CONTROL,
  offlineCiEvidenceParent,
  offlineCiNeededFor,
  parseCaseOutput,
  parseGateDrivers,
  parseOfflineCiReport,
  parsePreflight,
  parseTscOutput,
  PARTIAL_EXIT,
  readManifest,
  readManifestFull,
  RED_EXIT,
  run,
  runPackageScript,
  SELFTEST_EXIT,
  sourceSha256,
  UNPROVEN_EXIT,
  validateOfflineCiReport,
  type CaseReading,
  type CaseSpec,
  type CriterionResult,
  type ManifestEntryFull,
  type OfflineCiEvidence,
  type OfflineCiReport,
  type TscReading,
} from './release-gate.ts'

const ROOT = join(import.meta.dirname, '..')
const GATE = join(import.meta.dirname, 'release-gate.ts')

// ── 夹具 ─────────────────────────────────────────────────────────────────────

function spec(over: Partial<CaseSpec> = {}): CaseSpec {
  return {
    id: 'fixture',
    path: 'fixture.test.ts',
    theme: 'other-round',
    runner: 'bun:test',
    ci: 'run',
    purpose: '夹具',
    minPass: 1,
    minAssert: 1,
    minSites: 0,
    citedBy: 0,
    ...over,
  }
}

function reading(raw: string, over: Partial<CaseReading> = {}): CaseReading {
  return {
    spec: spec(),
    ran: true,
    exit: 0,
    counts: parseCaseOutput(raw),
    staticSites: 10,
    ms: 1,
    ...over,
  }
}

// ── 1. 输出解析：三种格式都要认，认不出就得是"没量到" ────────────────────────

describe('parseCaseOutput · 三种输出格式', () => {
  test('bun:test 汇总（数在前）', () => {
    const raw = ['(pass) 甲', '(pass) 乙', '(skip) 丙', '', ' 2 pass', ' 1 skip', ' 0 fail', ' 12 expect() calls'].join('\n')
    const c = parseCaseOutput(raw)
    expect(c.format).toBe('bun-summary')
    expect([c.pass, c.fail, c.skip]).toEqual([2, 0, 1])
    expect(c.assertions).toBe(12)
    expect(c.markerPass).toBe(2)
    expect(c.markerSkip).toBe(1)
  })

  test('node:test / TAP 汇总（词在前）', () => {
    const raw = ['# tests 4', '# pass 4', '# fail 0', '# skipped 1'].join('\n')
    const c = parseCaseOutput(raw)
    expect(c.format).toBe('tap')
    expect([c.pass, c.fail, c.skip]).toEqual([4, 0, 1])
  })

  test('plain 脚本的本仓约定：`N/M 通过` + 逐行 ok/PASS', () => {
    const raw = ['ok   甲', 'ok   乙', 'PASS 丙', '', '3/3 通过'].join('\n')
    const c = parseCaseOutput(raw)
    expect(c.format).toBe('plain-cn')
    expect(c.pass).toBe(3)
    expect(c.fail).toBe(0)
  })

  test('**假绿**：exit 0 但一个数都没有 ⇒ format=null（没量到，不是 0 通过）', () => {
    const c = parseCaseOutput('')
    expect(c.format).toBeNull()
    expect(c.pass).toBe(0)
    // 这正是"把 plain 脚本按 bun test 跑"得到的输出：0 pass / 0 fail / exit 0。
  })

  test('plain 收尾行与逐行记号对不上 ⇒ 不采信（宁可不判，也不猜）', () => {
    const c = parseCaseOutput(['ok 甲', 'ok 乙', '', '30/29 通过'].join('\n'))
    expect(c.format).toBeNull()
  })

  test('汇总行与 (pass) 记号行对不上 ⇒ evalCase 判 UNPROVEN（读数不可信）', () => {
    const raw = ['(pass) 甲', '', ' 3 pass', ' 0 fail'].join('\n')
    const c = parseCaseOutput(raw)
    expect(c.format).toBe('bun-summary')
    expect(c.pass).toBe(3)
    expect(c.markerPass).toBe(1)
    expect(evalCase(reading(raw)).status).toBe('UNPROVEN')
  })
})

describe('parsePreflight / parseGateDrivers / parseTscOutput', () => {
  // 夹具必须与 `test-ci.ts` 的真实输出**同形**：纳入行的 tag 是 `'RUN '`（RUN 后有一个空格再接 tab，
  // 见 `test-ci.ts:446`）。写成 `RUN\t` 的"看起来对"的夹具，正是"单帧夹具 vs 多帧现实"那一类坑 ——
  // 本单第一版探针就按 `RUN\t` 数过，恒得 0，把"整段列表都在"读成"一条都没有"。
  const preflightFixture = (include: number, exclude: number, missing: number) => [
    ...Array.from({ length: include }, (_, i) => `RUN \tbun:test\tpackages/a/test/x-${i}.test.ts\t理由`),
    ...Array.from({ length: exclude }, (_, i) => `SKIP\tplain\tdistribution/skip-${i}.test.ts\t理由`),
    ...Array.from({ length: missing }, (_, i) => `MISSING\t已纳入但磁盘上没有：script/gone-${i}.test.ts`),
    `# include=${include} exclude=${exclude} missing=${missing}`,
  ].join('\n')

  test('preflight 正常读数：四个数字 + 缺件点名（收尾行与逐行列表两条独立读数互相印证）', () => {
    const raw = [
      ...Array.from({ length: 165 }, (_, i) => `RUN \tbun:test\tpackages/a/test/x-${i}.test.ts\t理由`),
      ...Array.from({ length: 84 }, (_, i) => `SKIP\tplain\tdistribution/skip-${i}.test.ts\t理由`),
      'MISSING\t已纳入但磁盘上没有：script/release-gate.test.ts',
      'UNCLASSIFIED\t发现规则扫到但清单未覆盖：packages/b/test/y.test.ts',
      '# include=165 exclude=84 missing=1',
    ].join('\n')
    const p = parsePreflight(raw, 2)!
    expect([p.include, p.exclude, p.missing]).toEqual([165, 84, 1])
    expect(p.missingNames).toEqual(['script/release-gate.test.ts'])
    expect(p.unclassified).toEqual(['packages/b/test/y.test.ts'])
  })

  test('preflight 收尾行缺失 ⇒ null（无读数，不拿"没有 UNCLASSIFIED 行"冒充干净）', () => {
    expect(parsePreflight('RUN \tbun:test\tx\t理由', 0)).toBeNull()
  })

  test('preflight 收尾行与列表不一致 ⇒ null（汇总说 include=165、列表只有 1 行：宁可不判，也不猜）', () => {
    expect(parsePreflight('RUN \tbun:test\tpackages/a/test/x.test.ts\t理由\n# include=165 exclude=84 missing=0', 0)).toBeNull()
    // 反向：列表整段都在、收尾行的 missing 被写小 ⇒ 一样不采信
    expect(parsePreflight(preflightFixture(2, 1, 1).replace('missing=1', 'missing=0'), 0)).toBeNull()
  })

  test('preflight 判据：读不到读数 ⇒ UNPROVEN，并说清"末尾停在半行上"这个形状（管道截断）', () => {
    const truncated = 'RUN \tbun:test\tpackages/a/test/x.test.ts\t理由\nSKIP\tplain\tdistribution/x.test.ts\t理由；需要 Isaac'
    const c = evalPreflightCriterion(truncated, 0, 45, 'file')
    expect(c.status).toBe('UNPROVEN')
    expect(c.metrics.capture).toBe('file')
    expect(c.metrics.outputComplete).toBe(0)
    expect(c.findings.join('\n')).toContain('收尾行')
    expect(c.findings.join('\n')).toContain('停在半行')
  })

  test('preflight 判据：读到了就带数字（GREEN）；UNCLASSIFIED 仍然判 RED（不因为改了取数路径而放松）', () => {
    const good = evalPreflightCriterion(preflightFixture(3, 2, 0), 0, 30, 'file')
    expect(good.status).toBe('GREEN')
    expect(good.metrics).toMatchObject({ include: 3, exclude: 2, missing: 0, unclassified: 0, capture: 'file' })
    const bad = evalPreflightCriterion(
      `${preflightFixture(3, 2, 0)}\nUNCLASSIFIED\t发现规则扫到但清单未覆盖：packages/b/test/y.test.ts`,
      2,
      30,
      'file',
    )
    expect(bad.status).toBe('RED')
    expect(bad.findings.join('\n')).toContain('UNCLASSIFIED')
  })

  test('gate:drivers --json 正常读数 / 脚本名写错时的 `Script not found` ⇒ null', () => {
    const rows = JSON.stringify([
      { id: 'g17', implementation: 'script/gates/g17.ts', driver: 'script/gates/run-g17.ts' },
      { id: 'g99', implementation: 'script/gates/g99.ts', driver: null },
    ])
    const g = parseGateDrivers(rows, 0)!
    expect(g.implementations).toBe(2)
    expect(g.withDriver).toBe(1)
    expect(g.withoutDriver).toEqual(['script/gates/g99.ts'])
    // 本 gate 首版把 `gate:drivers` 写成 `gate-drivers`，拿到的就是这个：
    expect(parseGateDrivers('error: Script not found "gate-drivers"', 1)).toBeNull()
  })

  test('机器结果与诊断分离：JSON 在 stdout、方括号诊断在 stderr ⇒ 只读 stdout 可解析（旧混合 out 被切坏）', () => {
    const stdout = `${JSON.stringify([{ id: 'g01', implementation: 'script/gates/g01.ts', driver: 'script/gates/run-g01.ts' }])}\n`
    // 真实 `bun run gate:drivers --json` 的 stderr 就是这一行（package.json 脚本前缀）：
    const stderr = '$ [ -x "$npm_execpath" ] && PATH="$(dirname "$npm_execpath"):$PATH"; bun run script/gate-drivers.ts --json\n'
    // 旧口径（out=stdout+stderr，indexOf('[')..lastIndexOf(']')）：stderr 的 `[ ]` 把 JSON 收尾切走 ⇒ 解不开。
    expect(parseGateDrivers(`${stdout}${stderr}`, 0)).toBeNull()
    // 新口径（只读 stdout）：一条合法 JSON 照样可读。
    expect(parseGateDrivers(stdout, 0)).toMatchObject({ implementations: 1, withDriver: 1, withoutDriver: [], exit: 0 })
  })

  test('gate:drivers 判据三态：解不开 ⇒ UNPROVEN；缺驱动 / exit≠0 / 0 实现 ⇒ RED；齐了 ⇒ GREEN', () => {
    const unproven = evalGateDriversCriterion(null, 0, 12, '[ {"broken": ', '$ [ -x ] diag', undefined)
    expect(unproven.status).toBe('UNPROVEN')
    expect(unproven.metrics.exit).toBe(0)
    expect(unproven.findings.join('\n')).toContain('stdout')
    expect(unproven.findings.join('\n')).toContain('stderr')
    const green = evalGateDriversCriterion({ implementations: 15, withDriver: 15, withoutDriver: [], exit: 0 }, 0, 30, '[...]', '$ [ -x ]')
    expect(green.status).toBe('GREEN')
    const missing = evalGateDriversCriterion({ implementations: 2, withDriver: 1, withoutDriver: ['script/gates/g99.ts'], exit: 0 }, 0, 30, '[...]', '')
    expect(missing.status).toBe('RED')
    expect(missing.findings.join('\n')).toContain('NO-DRIVER')
    // 无驱动仍 RED（不许因为"解开了 JSON"就放过缺驱动这件事）
    expect(evalGateDriversCriterion({ implementations: 15, withDriver: 15, withoutDriver: [], exit: 1 }, 1, 30, '[...]', '').status).toBe('RED')
    expect(evalGateDriversCriterion({ implementations: 0, withDriver: 0, withoutDriver: [], exit: 0 }, 0, 30, '[]', '').status).toBe('RED')
  })

  test('tsc 读数：errors/files/出错文件；空输出 ⇒ null', () => {
    const raw = [
      `${ROOT}/packages/a/src/x.ts`,
      `${ROOT}/packages/b/src/y.ts`,
      `${ROOT}/packages/b/src/y.ts(3,1): error TS2322: 类型不对`,
    ].join('\n')
    const t = parseTscOutput(raw, 2, ROOT)!
    expect(t.errors).toBe(1)
    expect(t.files).toBe(2)
    expect(t.errorFiles).toEqual([`${ROOT}/packages/b/src/y.ts`])
    expect(parseTscOutput('', 0, ROOT)).toBeNull()
  })

  // ── ② `tsc-*` 必须看退出码（GATE-TSC-EXIT-CODE）─────────────────────────────
  /**
   * 负对照就是验收报告 §4-N3 那条纯函数实证：`--listFiles` 的清单在**类型检查之前**就写出来了，
   * 之后 V8 OOM / 被信号杀死 / 被超时掐断 ⇒ `exit=null`、stderr 里一条 `error TS` 都没有。
   * 改前的判定式（`errors===0 && files>0`）把它读成 **GREEN**。**还原那一行 ⇒ 第一条断言精确变红。**
   */
  test('② 「崩溃但没报错」的形状：文件清单在、`exit=null`、零 error TS ⇒ **RED**（不许判绿）', () => {
    const raw = [`${ROOT}/packages/a/src/x.ts`, `${ROOT}/packages/b/src/y.ts`, 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'].join('\n')
    const t = parseTscOutput(raw, null, ROOT)!
    // 先钉住"读数本身没坏"：文件数与错误数都读到了（所以旧判定式才会判绿）
    expect(t).toMatchObject({ errors: 0, files: 2, exit: null })
    const c = evalTscCriterion('tsc-product', 'tsc', t, 12, 'SIGKILL')
    expect(c.status).toBe('RED')
    expect(c.metrics.exit).toBe(-1)
    expect(c.metrics.signal).toBe('SIGKILL')
    expect(c.findings.join('\n')).toContain('崩溃假绿')
    expect(c.findings.join('\n')).toContain('SIGKILL')
  })

  test('② 非 0 退出码（编译器自己报失败）⇒ RED；`exit=0` 且零 error ⇒ GREEN', () => {
    const clean: TscReading = { errors: 0, files: 2, errorFiles: [], exit: 0 }
    expect(evalTscCriterion('tsc-product', 'tsc', clean, 1, null).status).toBe('GREEN')
    const bad = evalTscCriterion('tsc-product', 'tsc', { ...clean, exit: 2 }, 1, null)
    expect(bad.status).toBe('RED')
    expect(bad.findings.join('\n')).toContain('编译闭包没有被量到')
    // 有 error TS 的老形状照旧红（不是"改了退出码就放松了错误数"）
    const errs = evalTscCriterion('tsc-gates', 'tsc', { errors: 3, files: 9, errorFiles: ['/x/y.ts'], exit: 2 }, 1, null)
    expect(errs.status).toBe('RED')
    expect(errs.findings.join('\n')).toContain('3 条 error TS')
  })

  test('② 静态不变式：tsc 判定式里带 `exit`（还原那一行 ⇒ 上面两条断言变红）', () => {
    const src = readFileSync(GATE, 'utf8')
    expect(src.includes('const crashed = t.exit !== 0')).toBe(true)
    expect(src.includes('status: crashed || t.errors > 0 || t.files === 0 ?')).toBe(true)
    // 旧判定式不许再出现在 `tsc-*` 的判据构造里（只允许出现在注释/回执引文里）
    const codeOnly = src
      .split('\n')
      .filter((l) => {
        const t = l.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    expect(codeOnly.includes("status: t.errors === 0 && t.files > 0 ? 'GREEN' : 'RED'")).toBe(false)
  })
})

// ── 1a. 机器结果与诊断分离：stdout / stderr 两条流（GATE-AB-20260927）─────────────

/**
 * 本组钉的是 `run()` 的**取数口径**（不是判定逻辑），负对照全部现场驱动：
 *  · 一条夹具同时写合法 JSON 到 stdout、写带方括号的 shell 诊断到 stderr ⇒ 只读 stdout 可解析，
 *    `out = stdout + stderr` 的旧口径被方括号切坏（上面纯函数层那条已用合成串钉住，这里走真进程）；
 *  · **file capture 与 pipe capture 两条路径**都要给同样的三个字段（把 TMPDIR 指到不存在的目录
 *    即可让 `mkdtempSync` 失败、退回管道 —— 实测可行，见 GATE-AB 回执 §A）；
 *  · 真实 `runPackageScript('gate:drivers', ['--json'])`：stdout 合法 JSON、stderr 带方括号诊断。
 */
describe('机器结果与诊断分离 · run() 的 stdout/stderr（GATE-AB-20260927）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-ab-streams-'))
  const fixture = join(dir, 'streams.ts')
  writeFileSync(
    fixture,
    [
      "process.stdout.write(JSON.stringify([{ id: 'g01', implementation: 'script/gates/g01.ts', driver: 'script/gates/run-g01.ts' }]))",
      "process.stdout.write('\\n')",
      "process.stderr.write('$ [ -x \"$npm_execpath\" ] && PATH=\"$(dirname \"$npm_execpath\"):$PATH\"; bun run script/gate-drivers.ts --json\\n')",
      "process.stderr.write('# 实现文件 15 个\\n')",
      '',
    ].join('\n'),
  )

  test('file capture：stdout 可解析 JSON、stderr 保留方括号诊断、out 仍是两者拼接', () => {
    const r = run(process.execPath, ['--no-env-file', fixture], ROOT, 120_000)
    expect(r.capture).toBe('file')
    expect(r.code).toBe(0)
    expect(r.stdout.startsWith('[')).toBe(true)
    expect(r.stderr).toContain('[ -x "$npm_execpath" ]')
    expect(r.out).toBe(`${r.stdout}${r.stderr}`)
    expect(parseGateDrivers(r.stdout, r.code)!.implementations).toBe(1)
    // 旧口径把 stderr 拼进去再解析 ⇒ 被方括号切坏（这正是本单修的那条，负对照非空）。
    expect(parseGateDrivers(r.out, r.code)).toBeNull()
  })

  test('pipe capture（TMPDIR 不可用 ⇒ 退回管道）：stdout/stderr/out 与 file 路径同口径', () => {
    const saved = process.env.TMPDIR
    try {
      process.env.TMPDIR = join(dir, 'not-a-directory', 'nested')
      const r = run(process.execPath, ['--no-env-file', fixture], ROOT, 120_000)
      expect(r.capture).toBe('pipe')
      expect(r.code).toBe(0)
      expect(r.stdout.startsWith('[')).toBe(true)
      expect(r.stderr).toContain('[ -x "$npm_execpath" ]')
      expect(r.out).toBe(`${r.stdout}${r.stderr}`)
      expect(parseGateDrivers(r.stdout, r.code)!.implementations).toBe(1)
    } finally {
      if (saved === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = saved
    }
  })

  test('真实 runPackageScript("gate:drivers", ["--json"])：只读 stdout 就拿到合法读数，stderr 诊断不丢', () => {
    const r = runPackageScript('gate:drivers', ['--json'], ROOT, 300_000)
    expect(r.code).toBe(0)
    expect(r.stdout.trimStart().startsWith('[')).toBe(true)
    // 真实 stderr 里就有方括号（package.json 脚本前缀）——旧口径坏在这上面。
    expect(r.stderr).toContain('[')
    const g = parseGateDrivers(r.stdout, r.code)!
    expect(g.implementations).toBe(15)
    expect(g.withoutDriver).toEqual([])
    expect(g.exit).toBe(0)
    // out 仍保留 stderr：既有混合日志消费者与诊断一个字都没丢。
    expect(r.out).toContain(r.stderr)
  })

  test('坏 JSON / 空 stdout ⇒ 判据 UNPROVEN（不拿 stderr 里的 `[` 兜底）', () => {
    const bad = evalGateDriversCriterion(parseGateDrivers('not json [', 0), 0, 5, 'not json [', '$ [ -x ]', undefined)
    expect(bad.status).toBe('UNPROVEN')
    const empty = evalGateDriversCriterion(parseGateDrivers('', 0), 0, 5, '', '$ [ -x ] diag', undefined)
    expect(empty.status).toBe('UNPROVEN')
    expect(empty.findings.join('\n')).toContain('(空)')
  })
})

// ── 1b. 取数路径：尾部不许丢（preflight "读不到收尾行" 的真因） ─────────────────

/**
 * 这两条钉的是**取数路径本身**，不是判定逻辑：
 *  · 放大版夹具：先写一大块（8MB）、再写收尾行、然后**立刻 `process.exit(0)`** —— 与
 *    `script/test-ci.ts` 的收尾同形（`main(...).then((code) => process.exit(code))`）。
 *  · Bun 的 stdout 在**管道**上是异步刷写，`process.exit()` 不会等它 ⇒ 尾部丢；
 *    丢掉的正好是最后一行（真 preflight 的 `# include=…` 就在最后一行）。
 *  实测（同机、同夹具）：管道 8/8 丢；本门的 `run()`（落文件）8/8 不丢。
 *  改回管道 ⇒ 第 2 条会红（这就是本单那条修复的负对照）。
 */
describe('取数路径 · 子进程尾部（preflight UNPROVEN 的真因）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-tail-'))
  const fixture = join(dir, 'tail.ts')
  const MARK = '# include=1 exclude=0 missing=0'
  writeFileSync(
    fixture,
    [
      "process.stdout.write('x'.repeat(8_000_000))",
      "process.stdout.write('# include=1 exclude=0 missing=0\\n')",
      'process.exit(0)',
      '',
    ].join('\n'),
  )

  test('放大版夹具经**裸管道** ⇒ 尾部确实会丢（本门为什么不用管道取数）', () => {
    let lost = 0
    for (let i = 0; i < 8; i++) {
      const r = spawnSync(process.execPath, ['--no-env-file', fixture], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
      if (!`${r.stdout ?? ''}${r.stderr ?? ''}`.includes(MARK)) lost++
    }
    expect(lost).toBeGreaterThan(0)
  })

  test('同一条夹具经本门的 run()（落文件）⇒ 8 次一次不丢，且读数里写明采集面', () => {
    const outs = Array.from({ length: 8 }, () => run(process.execPath, ['--no-env-file', fixture], ROOT, 120_000))
    // 先验**数据**（尾部在不在），再验采集面标签：还原成管道时先红的是"丢了几次"这条实质断言。
    expect(outs.filter((r) => !r.out.includes(MARK)).length).toBe(0)
    expect(outs.map((r) => r.capture)).toEqual(Array.from({ length: 8 }, () => 'file'))
  })

  test('preflight 的取数不被 PATH 绑架：PATH 里没有 bun 时，本门写法照样拿到读数（裸 `bun run` **若拿不到读数**则必须是 127/零输出）', () => {
    // 现场（本机 bun 1.3.13，**package.json 修好之前**的读数）：门用 `process.execPath` 的绝对路径起
    // `bun run preflight`，而 package.json 里那一行又是 `bun run script/test-ci.ts --list` —— **嵌套那次靠 PATH 解析**。
    // PATH 里没有 bun 时它当时是：
    //   `$ bun run script/test-ci.ts --list` / `/usr/bin/bash: 行 1: bun: 未找到命令` / `error: script "preflight" exited with code 127`
    // ⇒ 零输出、exit 127 ⇒ preflight 判据 UNPROVEN（不是红，也不是绿）。本机 PATH 正是这种（无 ~/.bun/bin）。
    // **2026-09-27 起**：package.json 里 13 条嵌套脚本都带上 `[ -x "$npm_execpath" ] && PATH="$(dirname "$npm_execpath"):$PATH";` 前缀
    // ⇒ 同一条裸 `bun run` 现在**拿得到读数**（本机实测 exit=2 + 完整可解析读数）⇒ 下面按「拿不拿得到读数」分叉，
    // 不再把「127/零读数」当不变式 —— 那是 bug 的形状，不是本门的要求。
    const bare = { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' }
    const naive = run(process.execPath, ['run', 'preflight'], ROOT, 300_000, bare)
    const fixed = runPackageScript('preflight', [], ROOT, 300_000)
    // 核心不变式（与 bun 的 shell 解析行为无关）：本门的写法必须拿到读数。
    expect(parsePreflight(fixed.out, fixed.code)).not.toBeNull()
    expect(fixed.capture).toBe('file')
    if (naive.code === 0 || parsePreflight(naive.out, naive.code) !== null) {
      // 如实登记：裸 `bun run` 这一路拿到读数有两种成因 —— ① bun 自己解析成功（exit=0）；
      // ② package.json 的嵌套前缀已落地（exit≠0，但 stdout 是完整可解析读数）。两者都不是本门的回归。
      process.stdout.write(`  · 说明：本机裸 \`bun run preflight\` 拿到了读数（naive code=${String(naive.code)}），该确定性成因在本版本不复现\n`)
    } else {
      // 拿不到读数时，它必须仍是「非零退出 + 无读数」这条根因的形状 —— 核心两条断言原样保留。
      expect(naive.code).not.toBe(0)
      expect(parsePreflight(naive.out, naive.code)).toBeNull()
    }
  })

  test('取数路径夹具清场', () => {
    rmSync(dir, { recursive: true, force: true })
  })
})

// ── 2. 判定：每条非绿都要说清是哪一条、差多少 ────────────────────────────────

describe('evalCase · 门槛与豁免', () => {
  const ok = '(pass) 甲\n\n 1 pass\n 0 fail\n 5 expect() calls'

  test('达标 ⇒ GREEN', () => {
    expect(evalCase(reading(ok)).status).toBe('GREEN')
  })

  test('退出码非 0 / fail>0 ⇒ RED', () => {
    const r = reading('(fail) 甲\n\n 0 pass\n 1 fail', { exit: 1 })
    const e = evalCase(r)
    expect(e.status).toBe('RED')
    expect(e.finding).toContain('fail=1')
  })

  test('通过数低于冻结下限 ⇒ RED，且点名差多少', () => {
    const r = reading(ok, { spec: spec({ minPass: 9 }) })
    const e = evalCase(r)
    expect(e.status).toBe('RED')
    expect(e.finding).toContain('pass=1 < minPass=9')
  })

  test('断言读数低于冻结下限 ⇒ RED（"绿"但断言被掏空）', () => {
    const r = reading(ok, { spec: spec({ minAssert: 99 }) })
    expect(evalCase(r).status).toBe('RED')
    expect(evalCase(r).finding).toContain('assert=5 < minAssert=99')
  })

  test('skip 不算通过：未登记的 skip ⇒ RED；登记过的 ⇒ GREEN 但读数里带 skip', () => {
    const raw = '(pass) 甲\n(skip) 乙\n\n 1 pass\n 1 skip\n 0 fail'
    expect(evalCase(reading(raw)).status).toBe('RED')
    const waived = reading(raw, { spec: spec({ waiveSkip: 1, waiveSkipReason: '环境门控（夹具）' }) })
    const e = evalCase(waived)
    expect(e.status).toBe('GREEN')
    expect(e.note).toContain('skip=1(登记)')
  })

  test('文件缺失 / 起进程失败 ⇒ UNPROVEN（不是通过，也不是"失败"）', () => {
    expect(evalCase(reading('', { ran: false, infra: '用例文件缺失' })).status).toBe('UNPROVEN')
    expect(evalCase(reading('', { infra: '超时 600000ms' })).status).toBe('UNPROVEN')
  })
})

describe('主题判据 / 声明一致 / skip 记账 / 完整性 / 自检', () => {
  test('主题判据给的是"绿/总 + Σpass/Σ下限"，并点名红的那条', () => {
    const a = reading('(pass) 甲\n\n 1 pass\n 0 fail', { spec: spec({ id: 'a', minPass: 1 }) })
    const b = reading('(fail) 乙\n\n 0 pass\n 1 fail', { spec: spec({ id: 'b', minPass: 1 }), exit: 1 })
    const c = evalTheme('other-round', [a, b])
    expect(c.status).toBe('RED')
    expect(c.metrics.cases).toBe('1/2')
    expect(c.metrics.pass).toBe('1/2')
    expect(c.findings.join()).toContain('b 实测失败')
  })

  test('回执声明 vs 实测：短少 ⇒ RED 点名；超额 ⇒ 绿并记 WAIVED', () => {
    const short = reading('(pass) 甲\n\n 1 pass\n 0 fail', { spec: spec({ id: 'w', claimPass: 6, minPass: 1 }) })
    const c1 = evalClaimConsistency([short])
    expect(c1.status).toBe('RED')
    expect(c1.findings[0]).toContain('回执声明 pass=6，实测 pass=1')

    const grew = reading(' 7 pass\n 0 fail', { spec: spec({ id: 'g', claimPass: 5, minPass: 1 }) })
    const c2 = evalClaimConsistency([grew])
    expect(c2.status).toBe('GREEN')
    expect(c2.metrics.grew).toBe(1)
    expect(c2.waivers[0]).toContain('+2')
  })

  test('没有可核对声明 ⇒ UNPROVEN（不是"全对"）', () => {
    expect(evalClaimConsistency([reading(' 1 pass\n 0 fail')]).status).toBe('UNPROVEN')
  })

  test('skip 记账：未登记的 skip 让这条判据红', () => {
    const r = reading('(pass) 甲\n(skip) 乙\n\n 1 pass\n 1 skip\n 0 fail', { spec: spec({ waiveSkip: 0 }) })
    const c = evalSkipAccounting([r])
    expect(c.status).toBe('RED')
    expect(c.metrics).toEqual({ skips: 1, waived: 0, unwaived: 1 })
  })

  test('用例完整性：执行器写错（plain 当成 bun:test）会被抓出来', () => {
    const plainSource = 'const checks = []\nfor (const c of [1,2]) { checks.push(c) }\nconsole.log("2/2 通过")'
    expect(detectRunnerStyle(plainSource, 'x.test.ts')).toBe('plain')
    expect(detectRunnerStyle("import { test } from 'bun:test'", 'x.test.ts')).toBe('bun:test')
    const bad = reading('2/2 通过', { spec: spec({ id: 'p', path: 'script/engine-preference.test.ts', runner: 'plain' }) })
    // 表说 plain、文件形态也是 plain ⇒ 一致；反过来把 runner 写成 bun:test 就必须红。
    const wrongRunner = { ...bad, spec: { ...bad.spec, runner: 'bun:test' as const } }
    const c = evalCaseIntegrity([wrongRunner], ROOT)
    expect(c.status).toBe('RED')
    expect(c.findings.join()).toContain('执行器选错会得到空转的 exit 0')
  })

  test('自检：判绿但没有任何数字 / 声明数与执行数不符 ⇒ RED', () => {
    const noNumber: CriterionResult = { id: 'x', title: 'x', status: 'GREEN', metrics: {}, findings: [], waivers: [] }
    expect(evalSelfCheck([noNumber], [reading(' 1 pass\n 0 fail')], 1).status).toBe('RED')
    expect(evalSelfCheck([], [], 3).status).toBe('RED') // 声明 3 条、执行 0 条
    const good: CriterionResult = { id: 'y', title: 'y', status: 'GREEN', metrics: { n: 1 }, findings: [], waivers: [] }
    expect(evalSelfCheck([good], [reading(' 1 pass\n 0 fail')], 1).status).toBe('GREEN')
  })

  test('裁决优先级：RED > UNPROVEN > GREEN；PARTIAL 永不为 0', () => {
    const g: CriterionResult = { id: 'g', title: '', status: 'GREEN', metrics: { n: 1 }, findings: [], waivers: [] }
    const u: CriterionResult = { ...g, id: 'u', status: 'UNPROVEN' }
    const r: CriterionResult = { ...g, id: 'r', status: 'RED' }
    expect(aggregate([g], false)).toBe('GREEN')
    expect(aggregate([g, u], false)).toBe('UNPROVEN')
    expect(aggregate([g, u, r], false)).toBe('RED')
    expect(aggregate([g], true)).toBe('PARTIAL')
  })
})

describe('evalCoverage · 集合反查', () => {
  const manifest = new Map<string, 'include' | 'exclude'>([
    ['packages/a/test/wired.test.ts', 'include'],
    ['packages/b/test/loose.test.ts', 'include'],
    ['packages/c/test/excluded.test.ts', 'exclude'],
  ])

  test('清单认得、门里没接 ⇒ DRIFT 判红并点名', () => {
    const c = evalCoverage({
      derived: ['packages/a/test/wired.test.ts', 'packages/b/test/loose.test.ts'],
      declared: ['packages/a/test/wired.test.ts'],
      manifest,
      staleCitation: [],
      waivers: [],
    })
    expect(c.status).toBe('RED')
    expect(c.metrics.drift).toBe(1)
    expect(c.findings[0]).toContain('packages/b/test/loose.test.ts')
  })

  test('显式豁免 + 理由 ⇒ 绿，且豁免以 WAIVED 露出（不是悄悄消失）', () => {
    const c = evalCoverage({
      derived: ['packages/b/test/loose.test.ts'],
      declared: [],
      manifest,
      staleCitation: [],
      waivers: [{ path: 'packages/b/test/loose.test.ts', reason: '这是门自己的测试，接进来会自我递归' }],
    })
    expect(c.status).toBe('GREEN')
    expect(c.metrics.waived).toBe(1)
    expect(c.waivers[0]).toContain('有意不接进门')
  })

  test('豁免没写理由 ⇒ 红（无理由的豁免等于静默漏掉）', () => {
    const c = evalCoverage({
      derived: ['packages/b/test/loose.test.ts'],
      declared: [],
      manifest,
      staleCitation: [],
      waivers: [{ path: 'packages/b/test/loose.test.ts', reason: '   ' }],
    })
    expect(c.status).toBe('RED')
    expect(c.findings.join()).toContain('WAIVER-NO-REASON')
  })

  test('清单里根本没有 ⇒ 只报数（那条红归 preflight），不重复判红', () => {
    const c = evalCoverage({
      derived: ['packages/z/test/new.test.ts'],
      declared: [],
      manifest,
      staleCitation: [],
      waivers: [],
    })
    expect(c.status).toBe('GREEN')
    expect(c.metrics.unregistered).toBe(1)
    expect(c.findings.join()).toContain('UNREGISTERED')
  })

  test('派生为空 ⇒ UNPROVEN（"反查不出"不许冒充"没 drift"）', () => {
    const c = evalCoverage({ derived: [], declared: [], manifest, staleCitation: [], waivers: [] })
    expect(c.status).toBe('UNPROVEN')
  })

  // ── GATE-C：候选必须落到"实跑过"或"显式排除/豁免"，不能靠旧文档引用变绿 ──────────
  test('本次完整离线 CI 实跑成功 ⇒ 归 offlineExecuted（不是 drift），并给逐类计数', () => {
    const c = evalCoverage({
      derived: ['packages/b/test/loose.test.ts'],
      declared: [],
      offlineExecuted: ['packages/b/test/loose.test.ts'],
      manifest,
      staleCitation: [],
      waivers: [],
    })
    expect(c.status).toBe('GREEN')
    expect(c.metrics).toMatchObject({ derived: 1, offlineExecuted: 1, drift: 0 })
  })

  test('清单显式 exclude + 外部条件理由 ⇒ 归 externalExcluded（不计通过，也不判 drift）', () => {
    const input = {
      derived: ['packages/c/test/excluded.test.ts'],
      declared: [] as string[],
      manifest,
      excludeReasons: new Map([['packages/c/test/excluded.test.ts', 'not-run：需要真实 GPU 设备']]),
      staleCitation: [],
      waivers: [],
    }
    const a = coverageAttribution(input)
    expect(a.externalExcluded).toEqual(['packages/c/test/excluded.test.ts'])
    expect(a.drift).toEqual([])
    const c = evalCoverage(input)
    expect(c.status).toBe('GREEN')
    expect(c.metrics).toMatchObject({ externalExcluded: 1, drift: 0 })
    // 它**没有**被当成通过：归的是"外部验收/未运行"
    expect(c.waivers.join()).toContain('不计通过')
  })

  test('清单 exclude 但没写理由 ⇒ 判红（无理由排除 = 静默漏掉）', () => {
    const c = evalCoverage({
      derived: ['packages/c/test/excluded.test.ts'],
      declared: [],
      manifest,
      excludeReasons: new Map([['packages/c/test/excluded.test.ts', '   ']]),
      staleCitation: [],
      waivers: [],
    })
    expect(c.status).toBe('RED')
    expect(c.metrics.excludeNoReason).toBe(1)
    expect(c.findings.join()).toContain('EXCLUDE-NO-REASON')
  })

  test('清单判 include、本次没实跑成功 ⇒ 仍是 drift（旧文档引用过不算覆盖）', () => {
    // 只有 derived 里的**文档引用**（回执提到过），但本次离线 CI 没有实测成功（passed 里没有它）
    const c = evalCoverage({
      derived: ['packages/b/test/loose.test.ts'],
      declared: [],
      offlineExecuted: [],
      manifest,
      staleCitation: [],
      waivers: [],
    })
    expect(c.status).toBe('RED')
    expect(c.metrics.drift).toBe(1)
    expect(c.findings.join()).toContain('旧文档引用过不算覆盖')
  })
})

// ── ③ 清单 include 里有多少条没进门（GATE-MANIFEST-GAP）──────────────────────

/**
 * 验收报告 §4-N2/§4-N5⑥：门已经读了清单，`manifest.include − CASES − WAIVERS` 是**零成本**可算的，
 * 但改前**既不报这个数、也没有任何判据守着它** —— 而"门绿 ⇒ CI 那套也绿"正是最容易读出来的错觉。
 *
 * 负对照：**删掉 `manifest-gate-gap` 这条判据的 push（或去掉冻结值比较）⇒ 本块全红**，
 * 且门自己的读数行上再也不会有 `includeTestLike / gateRuns / notRun` 这三个数字。
 */
describe('evalManifestGap · 清单 include vs 发布门', () => {
  const man = new Map<string, 'include' | 'exclude'>([
    ['packages/a/test/runs.test.ts', 'include'],
    ['packages/b/test/loose.test.ts', 'include'],
    ['packages/c/test/excluded.test.ts', 'exclude'],
    ['packages/a/test/waived.test.ts', 'include'],
    ['packages/a/python/not-test-like.py', 'include'],
  ])
  const frozen = { count: 1, digest: manifestGapDigest(['packages/b/test/loose.test.ts']) }

  test('只数 test-like 的 include；CASES 与 WAIVERS 都减掉；条数 + 摘要都在 metrics 上', () => {
    const g = manifestGateGap(man, ['packages/a/test/runs.test.ts'], [{ path: 'packages/a/test/waived.test.ts' }])
    expect(g.includeTestLike).toEqual(['packages/a/test/runs.test.ts', 'packages/a/test/waived.test.ts', 'packages/b/test/loose.test.ts'])
    expect(g.declared).toEqual(['packages/a/test/runs.test.ts'])
    expect(g.waived).toEqual(['packages/a/test/waived.test.ts'])
    expect(g.notRun).toEqual(['packages/b/test/loose.test.ts'])
    const c = evalManifestGap(man, ['packages/a/test/runs.test.ts'], [{ path: 'packages/a/test/waived.test.ts', reason: '夹具' }], frozen)
    expect(c.status).toBe('GREEN')
    expect(c.metrics).toMatchObject({ includeTestLike: 3, gateRuns: 1, waived: 1, notRun: 1, frozen: 1, delta: 0 })
  })

  test('**新增**一条没进门的用例 ⇒ RED，点名条数与摘要，并把要抄回去的冻结值印出来', () => {
    const c = evalManifestGap(man, [], [], frozen)
    expect(c.status).toBe('RED')
    expect(c.metrics.notRun).toBe(3)
    const f = c.findings.join('\n')
    expect(f).toContain('MANIFEST-GAP')
    expect(f).toContain(`没进门的 3 条`)
    // 可复算：点名行里直接给出重冻要抄的两个值
    const nowDigest = manifestGapDigest(['packages/a/test/runs.test.ts', 'packages/a/test/waived.test.ts', 'packages/b/test/loose.test.ts'])
    expect(f).toContain(`{ count: 3, digest: '${nowDigest}' }`)
  })

  test('条数不变、成员换了一个 ⇒ 也 RED（摘要那一维；只冻条数会漏掉这条）', () => {
    const man2 = new Map<string, 'include' | 'exclude'>([
      ['packages/a/test/one.test.ts', 'include'],
      ['packages/b/test/two.test.ts', 'include'],
    ])
    // 条数都是 2，但冻结的集合里有一条不是现在这两条 ⇒ 只有摘要这一维能抓到
    const c = evalManifestGap(man2, [], [], { count: 2, digest: manifestGapDigest(['packages/a/test/one.test.ts', 'packages/x/test/other.test.ts']) })
    expect(c.status).toBe('RED')
    expect(c.metrics.notRun).toBe(2)
    expect(c.metrics.delta).toBe(0)
  })

  test('清单读不到 ⇒ UNPROVEN（不拿"数不出"冒充"没缺口"）', () => {
    const c = evalManifestGap(null, [], [], frozen)
    expect(c.status).toBe('UNPROVEN')
    expect(c.findings.join()).toContain('数不出')
  })

  test('冻结值只在**长**的方向判红：缺口变小不判红（收紧方向），只记 frozenGone', () => {
    const c = evalManifestGap(man, ['packages/a/test/runs.test.ts', 'packages/a/test/waived.test.ts', 'packages/b/test/loose.test.ts'], [], frozen)
    expect(c.status).toBe('GREEN')
    expect(c.metrics.notRun).toBe(0)
    expect(c.metrics.frozenGone).toBe(1)
  })

  test('真仓不变式：无执行证据时静态缺口如实登记（不许拿 manifest include 当 declared 填平）', () => {
    const m = readManifest(ROOT)
    expect(m).not.toBeNull()
    const g = manifestGateGap(
      m!,
      CASES.map((c) => c.path),
      COVERAGE_WAIVERS,
    )
    const c = evalManifestGap(m!, CASES.map((x) => x.path), COVERAGE_WAIVERS, MANIFEST_GAP_FROZEN)
    // 数字必须**报出来**（这三个字段就是"没进门多少条"的答案）
    expect(c.metrics.includeTestLike).toBe(g.includeTestLike.length)
    expect(c.metrics.notRun).toBe(g.notRun.length)
    expect(c.metrics.gateRuns).toBe(g.declared.length)
    // **无证据**：gateRuns 只能来自 CASES，绝不能等于 includeTestLike（那正是"拿清单当跑过"那条捷径）
    expect(g.declared.length).toBeLessThan(g.includeTestLike.length)
    // 缺口**不是 0**：门静态跑不到的 CI 用例这件事仍然登记在明面上
    expect(g.notRun.length).toBeGreaterThan(0)
    // 冻结值**不许上调**：静态缺口一旦超过冻结点 ⇒ 判据必须 RED（这正是"新增了没进门用例"的形状）
    if (g.notRun.length > MANIFEST_GAP_FROZEN.count) expect(c.status).toBe('RED')
    else expect(c.status).toBe('GREEN')
  })

  test('真仓不变式：本次离线 CI **实跑**证据接入后 notRun 缩到 0（纯函数形状；真实门里这个集合来自 test-ci --json）', () => {
    const m = readManifest(ROOT)
    expect(m).not.toBeNull()
    // ⚠️ 这里**只是纯函数不变式**：模拟"本次完整离线 CI 把每条 include 都真跑了"的结果集合。
    // 真实门里 declared 的"离线"那一半来自 `collectOfflineCi` 收到的 test-ci --json 报告逐条 status，
    // 且只在"报告解得开 + 与清单逐条一致"时才采信（见 `validateOfflineCiReport`）——不拿清单 include 顶替。
    const allInclude = [...m!.entries()].filter(([, d]) => d === 'include').map(([p]) => p)
    const c = evalManifestGap(m!, [...CASES.map((x) => x.path), ...allInclude], COVERAGE_WAIVERS, MANIFEST_GAP_FROZEN)
    expect(c.status).toBe('GREEN')
    expect(c.metrics.notRun).toBe(0)
    expect(c.metrics.delta).toBeLessThan(0) // 缺口缩小（收紧方向），冻结值不上调
  })

  test('③ 真的接进门：`main()` 里 push 了这条判据（删掉那行 ⇒ 本条精确变红）', () => {
    // 只扫**代码行**（注释里的逐字引文不算接线；`toContain` 失败时会把整份源码打出来，故用布尔断言）
    const code = readFileSync(GATE, 'utf8')
      .split('\n')
      .filter((l) => {
        const t = l.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    expect(code.includes('criteria.push(evalManifestGap(manifest,')).toBe(true)
    // 光有函数不算接进门：明细还要进 `--json` 报告（`manifestGap.notRun` 给全量清单）
    expect(code.includes('manifestGap: manifestGapForReport')).toBe(true)
  })
})

// ── GATE-C：offline-ci（同一次运行真跑 test-ci 完整默认集）─────────────────────

/**
 * 新语义的真正风险面（不堆同义用例）：
 *  · **只跑子集 / 报告缺行·重复·runner 或 decision 对不上 / pass 却退出码非 0** 都不许冒充覆盖；
 *  · **失败、缺件、include 却是 skip** 一律不许变绿；
 *  · **显式 exclude 有理由 = 外部验收/未运行（不计通过）**，无理由判红；
 *  · `--only` 的选择：命中依赖判据才真跑完整 CI，`--only gate-drivers` 不跑（避免递归）；
 *  · 夹具模式不跑真仓 CI，且退出码仍是 6。
 */
describe('offline-ci · 同一次运行真跑 test-ci 完整默认集', () => {
  const manifestFull = (): Map<string, ManifestEntryFull> =>
    new Map([
      ['packages/a/test/one.test.ts', { decision: 'include', declaredRunner: 'bun:test', reason: '夹具 include' }],
      ['packages/a/test/two.test.ts', { decision: 'include', declaredRunner: 'bun:test', reason: '夹具 include' }],
      ['packages/b/test/off.test.ts', { decision: 'exclude', declaredRunner: 'bun:test', reason: 'not-run：需要真实 GPU' }],
    ])
  const file = (over: Partial<OfflineCiReport['results'][number]> = {}): OfflineCiReport['results'][number] => ({
    path: 'packages/a/test/one.test.ts',
    declaredRunner: 'bun:test',
    executedBy: '/bun',
    command: 'bun test',
    decision: 'include',
    status: 'pass',
    exitCode: 0,
    timeoutMs: 120_000,
    pass: 1,
    fail: 0,
    skip: 0,
    logTail: '',
    ...over,
  })
  const report = (results: OfflineCiReport['results'], filter: string | null = null): OfflineCiReport => ({
    schema: 1,
    generatedAt: 'fixture',
    manifest: 'script/test-ci.manifest.json',
    timeoutMs: 120_000,
    filter,
    summary: {
      manifestEntries: results.length,
      included: results.filter((r) => r.decision === 'include').length,
      excludedNotRun: results.filter((r) => r.decision === 'exclude').length,
      ran: results.filter((r) => r.decision === 'include' && r.status !== 'skip' && r.status !== 'missing').length,
      passed: results.filter((r) => r.status === 'pass').length,
      failed: results.filter((r) => r.status === 'fail' || r.status === 'timeout').length,
      skipped: results.filter((r) => r.status === 'skip').length,
      missing: results.filter((r) => r.status === 'missing').length,
      harnessExitCode: 0,
    },
    excludedReasons: [],
    results,
  })
  const evidence = (r: OfflineCiReport, exit = 0): OfflineCiEvidence => ({
    reportRaw: JSON.stringify(r),
    reportPath: '/tmp/fixture-report.json',
    logDir: '/tmp/fixture-logs',
    exit,
    ms: 1,
    stdout: '',
    stderr: '',
    capture: 'file',
  })
  /** 一条合法且底噪干净的完整报告：两条 include 通过 + 一条 exclude 带理由。 */
  const cleanReport = (): OfflineCiReport =>
    report([
      file(),
      file({ path: 'packages/a/test/two.test.ts' }),
      file({ path: 'packages/b/test/off.test.ts', decision: 'exclude', status: 'skip', exitCode: null, reason: 'not-run：需要真实 GPU' }),
    ])

  test('offlineCiNeededFor：全量发布跑；--only gate-drivers 不跑（避免递归）；只有依赖判据才跑', () => {
    expect(offlineCiNeededFor(undefined)).toBe(true)
    expect(offlineCiNeededFor('gate-drivers')).toBe(false)
    expect(offlineCiNeededFor('tsc-product')).toBe(false)
    expect(offlineCiNeededFor('caseset-coverage')).toBe(true)
    expect(offlineCiNeededFor('offline-ci')).toBe(true)
    expect(offlineCiNeededFor('manifest-gate-gap')).toBe(true)
  })

  test('offlineCiEvidenceParent：显式目录优先，其次 RELEASE_GATE_CI_EVIDENCE_DIR，最后 tmpdir（证据落点，不改判定）', () => {
    expect(offlineCiEvidenceParent('/explicit/dir', '/fallback')).toBe('/explicit/dir')
    expect(offlineCiEvidenceParent('/from/env', '/fallback')).toBe('/from/env')
    // 传空串 = "没有显式目录"：走环境变量/兜底（传 `undefined` 会触发默认形参、等同于"没传"，测不到这一支）
    expect(offlineCiEvidenceParent('   ', '/fallback')).toBe('/fallback')
    expect(offlineCiEvidenceParent('', '/fallback')).toBe('/fallback')
  })

  test('parseOfflineCiReport：合法报告解得开；坏 JSON / 缺 schema / 缺 filter 字段 ⇒ null（无读数）', () => {
    expect(parseOfflineCiReport(JSON.stringify(cleanReport()))).not.toBeNull()
    expect(parseOfflineCiReport('{ not json')).toBeNull()
    expect(parseOfflineCiReport(JSON.stringify({ schema: 2, results: [], summary: {} }))).toBeNull()
    const noFilter = { ...cleanReport() } as Record<string, unknown>
    delete noFilter.filter
    expect(parseOfflineCiReport(JSON.stringify(noFilter))).toBeNull()
  })

  test('validateOfflineCiReport：完整且一致 ⇒ 无问题，逐类计数正确（exclude 不进 passed）', () => {
    const v = validateOfflineCiReport(cleanReport(), manifestFull(), 0)
    expect(v.problems).toEqual([])
    expect(v.passed).toEqual(['packages/a/test/one.test.ts', 'packages/a/test/two.test.ts'])
    expect(v.ran.length).toBe(2)
    expect(v.excluded).toEqual(['packages/b/test/off.test.ts'])
    expect(v.failed).toEqual([])
    expect(v.missing).toEqual([])
  })

  test('validateOfflineCiReport：缺行 / 重复 / decision·runner 不一致 / filter 非 null / exit-status 对不上 都记问题', () => {
    const missing = validateOfflineCiReport(report([file()]), manifestFull(), 0)
    expect(missing.problems.join()).toContain('缺行')

    const dup = validateOfflineCiReport(report([file(), file()]), manifestFull(), 0)
    expect(dup.problems.join()).toContain('重复')

    const badDecision = report([
      file(),
      file({ path: 'packages/a/test/two.test.ts' }),
      file({ path: 'packages/b/test/off.test.ts', decision: 'include', status: 'pass', exitCode: 0 }),
    ])
    expect(validateOfflineCiReport(badDecision, manifestFull(), 0).problems.join()).toContain('decision=')

    const badRunner = report([
      file({ declaredRunner: 'plain' }),
      file({ path: 'packages/a/test/two.test.ts' }),
      file({ path: 'packages/b/test/off.test.ts', decision: 'exclude', status: 'skip', exitCode: null, reason: 'r' }),
    ])
    expect(validateOfflineCiReport(badRunner, manifestFull(), 0).problems.join()).toContain('runner=')

    const filtered = report([...cleanReport().results], 'one')
    expect(validateOfflineCiReport(filtered, manifestFull(), 0).problems.join()).toContain('filter=')

    const passBadExit = report([
      file({ exitCode: 1 }),
      file({ path: 'packages/a/test/two.test.ts' }),
      file({ path: 'packages/b/test/off.test.ts', decision: 'exclude', status: 'skip', exitCode: null, reason: 'r' }),
    ])
    expect(validateOfflineCiReport(passBadExit, manifestFull(), 1).problems.join()).toContain('status=pass 但 exitCode=1')

    const failBadExit = report([
      file({ status: 'fail', exitCode: 0 }),
      file({ path: 'packages/a/test/two.test.ts' }),
      file({ path: 'packages/b/test/off.test.ts', decision: 'exclude', status: 'skip', exitCode: null, reason: 'r' }),
    ])
    expect(validateOfflineCiReport(failBadExit, manifestFull(), 1).problems.join()).toContain('却 exitCode=0')
  })

  test('validateOfflineCiReport：include 却 skip ⇒ 问题；exclude 无理由 ⇒ excludedNoReason（不许当通过）', () => {
    const incSkip = report([
      file({ status: 'skip', exitCode: null }),
      file({ path: 'packages/a/test/two.test.ts' }),
      file({ path: 'packages/b/test/off.test.ts', decision: 'exclude', status: 'skip', exitCode: null, reason: 'r' }),
    ])
    expect(validateOfflineCiReport(incSkip, manifestFull(), 0).problems.join()).toContain('include 条目却是 skip')

    const noReason = report([
      file(),
      file({ path: 'packages/a/test/two.test.ts' }),
      file({ path: 'packages/b/test/off.test.ts', decision: 'exclude', status: 'skip', exitCode: null, reason: '   ' }),
    ])
    const v = validateOfflineCiReport(noReason, manifestFull(), 0)
    expect(v.excludedNoReason).toEqual(['packages/b/test/off.test.ts'])
    expect(v.passed.length).toBe(2)
  })

  test('evalOfflineCiCriterion：无证据 / 报告读不到 / 报告坏了 ⇒ UNPROVEN；全过 ⇒ GREEN；失败或报告问题 ⇒ RED', () => {
    expect(evalOfflineCiCriterion({ evidence: null, manifest: manifestFull() }).status).toBe('UNPROVEN')
    const noReport: OfflineCiEvidence = { reportRaw: null, reportPath: '/x', logDir: '/y', exit: 0, ms: 1, stdout: '', stderr: '', capture: 'file' }
    expect(evalOfflineCiCriterion({ evidence: noReport, manifest: manifestFull() }).status).toBe('UNPROVEN')
    expect(evalOfflineCiCriterion({ evidence: { ...noReport, reportRaw: '{oops' }, manifest: manifestFull() }).status).toBe('UNPROVEN')

    const green = evalOfflineCiCriterion({ evidence: evidence(cleanReport(), 0), manifest: manifestFull() })
    expect(green.status).toBe('GREEN')
    expect(green.metrics).toMatchObject({ passed: 2, excluded: 1, validationProblems: 0, exit: 0 })

    const failReport = report([
      file({ status: 'fail', exitCode: 1 }),
      file({ path: 'packages/a/test/two.test.ts' }),
      file({ path: 'packages/b/test/off.test.ts', decision: 'exclude', status: 'skip', exitCode: null, reason: 'r' }),
    ])
    const red = evalOfflineCiCriterion({ evidence: evidence(failReport, 1), manifest: manifestFull() })
    expect(red.status).toBe('RED')
    expect(red.findings.join()).toContain('OFFLINE-CI-FAIL')

    // 只跑子集（filter 非 null）即使每条都 pass 也判 RED：不许冒充完整离线 CI 覆盖
    const subset = evalOfflineCiCriterion({ evidence: evidence(report([file()], 'one'), 0), manifest: manifestFull() })
    expect(subset.status).toBe('RED')
    expect(subset.findings.join()).toContain('REPORT-INVALID')
  })

  test('端到端：collectOfflineCi 在小私有项目上真起 test-ci ⇒ 报告与执行消费相接', () => {
    const proj = mkdtempSync(join(tmpdir(), 'gate-offline-ci-proj-'))
    mkdirSync(join(proj, 'script'), { recursive: true })
    mkdirSync(join(proj, 'packages/a/test'), { recursive: true })
    // 复制**既有** test-ci.ts（不新造另一套执行器），配一份最小清单 + 一条真用例。
    writeFileSync(join(proj, 'script', 'test-ci.ts'), readFileSync(join(ROOT, 'script', 'test-ci.ts'), 'utf8'))
    writeFileSync(
      join(proj, 'packages/a/test/pass.test.ts'),
      "import { expect, test } from 'bun:test'\ntest('ok', () => { expect(1).toBe(1) })\n",
    )
    const miniManifest: Map<string, ManifestEntryFull> = new Map([
      ['packages/a/test/pass.test.ts', { decision: 'include', declaredRunner: 'bun:test', reason: 'gate-c 私有夹具' }],
    ])
    writeFileSync(
      join(proj, 'script', 'test-ci.manifest.json'),
      JSON.stringify({
        schema: 1,
        note: 'gate-c 私有夹具',
        safeDefault: '夹具',
        runnerNotes: {},
        entries: [{ path: 'packages/a/test/pass.test.ts', declaredRunner: 'bun:test', markers: [], decision: 'include', reason: 'gate-c 私有夹具' }],
      }),
    )
    try {
      // 证据父目录**故意不存在**：collectOfflineCi 要自己建出来（否则设了 RELEASE_GATE_CI_EVIDENCE_DIR 就会 UNPROVEN）。
      const ev = collectOfflineCi(proj, 60_000, join(proj, 'nested', 'evidence'))
      expect(existsSync(ev.logDir)).toBe(true)
      expect(ev.exit).toBe(0)
      expect(ev.reportRaw).not.toBeNull()
      const rep = parseOfflineCiReport(ev.reportRaw!)
      expect(rep).not.toBeNull()
      const v = validateOfflineCiReport(rep!, miniManifest, ev.exit)
      expect(v.problems).toEqual([])
      expect(v.passed).toEqual(['packages/a/test/pass.test.ts'])
      const c = evalOfflineCiCriterion({ evidence: ev, manifest: miniManifest })
      expect(c.status).toBe('GREEN')
      expect(c.metrics).toMatchObject({ include: 1, passed: 1, failed: 0 })
    } finally {
      rmSync(proj, { recursive: true, force: true })
    }
  })

  test('夹具模式（--selftest --cases）不跑真仓 CI：offlineCi / coverageAttribution / manifestGap 都是 null，退出码仍是 6', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-offline-ci-fixture-'))
    const f = join(dir, 'green.test.ts')
    const casesFile = join(dir, 'cases.json')
    const reportPath = join(dir, 'report.json')
    writeFileSync(f, "import { expect, test } from 'bun:test'\ntest('绿', () => { expect(1).toBe(1) })\n")
    writeFileSync(
      casesFile,
      JSON.stringify([{ id: 'fixture', path: f, theme: 'other-round', runner: 'bun:test', ci: 'run', purpose: '夹具', minPass: 1, minAssert: 1, minSites: 0, claimPass: 1 }]),
    )
    try {
      const r = spawnSync(process.execPath, [GATE, '--root', ROOT, '--selftest', '--cases', casesFile, '--expect', 'green', '--json', reportPath], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 120_000,
      })
      expect(r.status).toBe(SELFTEST_EXIT)
      const rep = JSON.parse(readFileSync(reportPath, 'utf8')) as { offlineCi: unknown; coverageAttribution: unknown; manifestGap: unknown }
      expect(rep.offlineCi).toBe(null)
      expect(rep.coverageAttribution).toBe(null)
      expect(rep.manifestGap).toBe(null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    // 真实子进程会加载整仓门配置；外层沿用子进程的有界预算，避免慢 CI 触发 Bun 默认 5 秒超时。
  }, 120_000)
})

// ── ④ 冻结下限漂移（GATE-FLOOR-DRIFT）────────────────────────────────────────

/**
 * 验收报告 §4-N8：`viewer-texture-and-autoframe` 下限写 15、文件现有 22、实测 22
 * ⇒ **删掉 7 条仍然绿**，而门里没有任何判据能发现下限被下调。
 *
 * 负对照：**把 `evalFloorDrift` 的 push 去掉（或把 `>` 改成不可能成立）⇒ 本块前两条断言精确变红。**
 */
describe('evalFloorDrift · 冻结下限漂移', () => {
  test('实测 pass > minPass ⇒ RED，点名"删掉 N 条仍然绿"', () => {
    const r = reading(' 22 pass\n 0 fail\n 42 expect() calls', { spec: spec({ id: 'viewer-x', minPass: 15, minAssert: 42, minSites: 10 }) })
    const c = evalFloorDrift([r])
    expect(c.status).toBe('RED')
    expect(c.metrics).toMatchObject({ checked: 1, drift: 1 })
    expect(c.findings[0]).toContain('minPass 低于实测：下限 15 < 实测 pass=22（差 7）')
    expect(c.findings[0]).toContain('删掉 7 条用例仍然绿')
  })

  test('实测 == 下限 ⇒ GREEN（这条判据不是"永远红"）', () => {
    const r = reading(' 22 pass\n 0 fail\n 42 expect() calls', { spec: spec({ id: 'viewer-x', minPass: 22, minAssert: 42, minSites: 10 }) })
    expect(evalFloorDrift([r]).status).toBe('GREEN')
  })

  test('用例本身是红的 ⇒ 不参与（下限低于实测在红用例上既无意义也无危害）', () => {
    const r = reading(' 0 pass\n 5 fail', { exit: 1, spec: spec({ minPass: 1 }) })
    expect(evalCase(r).status).toBe('RED')
    expect(evalFloorDrift([r]).status).toBe('UNPROVEN') // 一条绿的都没有 ⇒ 没读数
  })

  test('没产出读数的用例不参与；`minAssert`/`minSites` 的缺口**只报数不判红**（如实登记）', () => {
    const blank = reading('', { spec: spec({ id: 'blank' }) })
    const loose = reading(' 5 pass\n 0 fail\n 99 expect() calls', { staticSites: 77, spec: spec({ id: 'loose', minPass: 5, minAssert: 1, minSites: 1 }) })
    const c = evalFloorDrift([blank, loose])
    expect(c.status).toBe('GREEN') // minPass 没漂（5 == 5）
    expect(c.metrics).toMatchObject({ checked: 1, drift: 0, assertGapReported: 1, sitesGapReported: 1 })
    expect(c.waivers.join()).toContain('minAssert 1 条 / minSites 1 条')
  })

  // ── 定版单（GATE-FINALIZATION）：④ 的**冻结基线**半场 ───────────────────────
  /**
   * 验收报告 §4-X4：④ 原来只有"下限 vs **本次实测**"的相对比较 ⇒ `minPass=15 / 实测=15` 判 GREEN，
   * 也就是"**先删用例、再把下限调到新实测**"这条路当时是通的。冻结基线（`FLOOR_BASELINE_FROZEN`）
   * 堵的就是这条路：交付那一刻的实测值冻在源码里，删用例 ⇒ 实测跌到基线之下 ⇒ 红，**下限跟着降也没用**。
   *
   * 负对照：把 `evalFloorDrift` 里 `r.counts.pass < base` 那一段去掉（或把 `base` 写死成 0）
   * ⇒ 本块第 1 条"先删用例 ⇒ 仍 RED"精确变红（见回执 §负对照）。
   */
  const frozenOf = (pass: Record<string, number>) => ({ at: '夹具', digest: floorBaselineDigest(pass), pass })

  test('**先删用例、再把下限调到新实测** ⇒ 仍然 RED（实测低于冻结基线，下限跟着降也没用）', () => {
    // 交付态：22 条通过 / 下限 22 / 基线 22（三处一致）⇒ 绿
    const before = reading(' 22 pass\n 0 fail\n 42 expect() calls', { spec: spec({ id: 'viewer-x', minPass: 22, minAssert: 42, minSites: 10 }) })
    expect(evalFloorDrift([before], frozenOf({ 'viewer-x': 22 })).status).toBe('GREEN')
    // 攻击：删掉 7 条 ⇒ 实测 15，**下限也降到 15**（相对比较因此看不见任何东西）
    const after = reading(' 15 pass\n 0 fail\n 30 expect() calls', { spec: spec({ id: 'viewer-x', minPass: 15, minAssert: 30, minSites: 10 }) })
    const c = evalFloorDrift([after], frozenOf({ 'viewer-x': 22 }))
    expect(c.status).toBe('RED')
    expect(c.metrics).toMatchObject({ checked: 1, drift: 0, shrink: 1, staleBaseline: 0, gone: 0 })
    expect(c.findings[0]).toContain('实测 pass=15 **低于冻结基线 22**（差 7）')
    expect(c.findings[0]).toContain('有人删了用例')
  })

  test('基线没跟着下限一起抬 ⇒ RED（否则过期的低基线会变成"天花板下的暗格"）', () => {
    const r = reading(' 25 pass\n 0 fail\n 50 expect() calls', { spec: spec({ id: 'viewer-x', minPass: 25, minAssert: 50, minSites: 10 }) })
    const c = evalFloorDrift([r], frozenOf({ 'viewer-x': 22 }))
    expect(c.status).toBe('RED')
    expect(c.metrics).toMatchObject({ drift: 0, shrink: 0, staleBaseline: 1 })
    expect(c.findings.join()).toContain('基线没跟着下限一起抬')
  })

  test('用例整条消失：**全量跑法**判 RED（`gone`）；子集/夹具跑法不报（防假红）', () => {
    const frozen = frozenOf({ 'viewer-x': 22, 'other-y': 5 })
    const one = reading(' 22 pass\n 0 fail\n 42 expect() calls', { spec: spec({ id: 'viewer-x', minPass: 22 }) })
    const full = evalFloorDrift([one], frozen, true)
    expect(full.status).toBe('RED')
    expect(full.metrics.gone).toBe(1)
    expect(full.findings.join()).toContain('other-y 在冻结基线里、本次**一个读数都没有**')
    // `--only` 子集 / `--selftest --cases` 夹具跑的不是同一批用例 ⇒ 拿它们报"用例没了"是假红
    const subset = evalFloorDrift([one], frozen, false)
    expect(subset.status).toBe('GREEN')
    expect(subset.metrics.gone).toBe(0)
  })

  test('增长（实测高于基线、**且下限与基线一起抬到位**）不判红；新增用例只进 `unfrozen` 计数', () => {
    // 注意：增长本身不是"覆盖被砍"，判据不因它记红 —— 但**下限抬了、基线没跟着抬**是另一回事
    // （那是上一条 `staleBaseline` 的形状）。所以这里给的基线是**跟着抬到位**的那一份（30）。
    const grown = reading(' 30 pass\n 0 fail\n 60 expect() calls', { spec: spec({ id: 'viewer-x', minPass: 30, minAssert: 60 }) })
    const brandNew = reading(' 3 pass\n 0 fail\n 3 expect() calls', { spec: spec({ id: 'brand-new', minPass: 3, minAssert: 3 }) })
    const c = evalFloorDrift([grown, brandNew], frozenOf({ 'viewer-x': 30 }))
    expect(c.metrics).toMatchObject({ drift: 0, shrink: 0, staleBaseline: 0, unfrozen: 1 })
    expect(c.status).toBe('GREEN')
    expect(c.waivers.join()).toContain('brand-new')
  })

  test('真仓不变式：冻结基线自洽（digest 复算一致 / 每条 ≥ 下限 / id 都还在 CASES 里）', () => {
    expect(FLOOR_BASELINE_FROZEN.digest).toBe(floorBaselineDigest(FLOOR_BASELINE_FROZEN.pass))
    expect(FLOOR_BASELINE_FROZEN.at.length).toBeGreaterThan(8)
    expect(Object.keys(FLOOR_BASELINE_FROZEN.pass).length).toBeGreaterThan(50)
    const byId = new Map(CASES.map((c) => [c.id, c]))
    for (const [id, pass] of Object.entries(FLOOR_BASELINE_FROZEN.pass)) {
      const c = byId.get(id)
      // 基线里的 id 必须还在 CASES 表里（用例被改名/删掉 ⇒ 这条红 ⇒ 必须走一次 review 重冻）
      expect(c).toBeDefined()
      expect(Number.isInteger(pass) && pass > 0).toBe(true)
      // 基线不许低于下限：低了说明"下限抬了但基线没抬"（门里那条 `staleBaseline` 判红同一件事）
      expect(pass).toBeGreaterThanOrEqual(c!.minPass)
    }
  })

  test('真仓不变式：66 条内建用例的 `minPass` 都不低于实测（否则门会判红并点名）', () => {
    // 只核**表自身**的结构：每条都写了正的 minPass；漂移由门每次跑用例时实测判定（见 `floor-drift` 判据）。
    expect(CASES.length).toBeGreaterThan(50)
    for (const c of CASES) expect(Number.isInteger(c.minPass) && c.minPass > 0).toBe(true)
  })

  test('④ 真的接进门：`main()` 里 push 了这条判据（删掉那行 ⇒ 本条精确变红）', () => {
    const code = readFileSync(GATE, 'utf8')
      .split('\n')
      .filter((l) => {
        const t = l.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    // 定版单起，第四个判据多带两个参数：冻结基线 + "这次是不是全量内建用例表"（子集/夹具不判 `gone`）
    expect(code.includes('criteria.push(evalFloorDrift(readings, FLOOR_BASELINE_FROZEN, !opts.only && !fixtureMode))')).toBe(true)
    // 冻结基线必须**接在判据里**（光有常量不算接线）：判据函数里要读到 frozen.pass
    expect(code.includes('r.counts.pass < base')).toBe(true)
    // 判据必须真在跑：`floor-drift` 的 id 不许被改名（回执与读数行都按这个 id 引用）
    expect(code.includes("id: 'floor-drift'")).toBe(true)
  })
})

// ── 3. 端到端负对照：真的 gate 进程 ──────────────────────────────────────────

interface SelftestRun {
  code: number | null
  out: string
}

function runGate(args: string[]): SelftestRun {
  const r = spawnSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

describe('端到端负对照（真 gate 进程 + 真夹具用例）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-gate-selftest-'))
  const casesFile = join(dir, 'cases.json')
  const withFixture = (body: string, name: string, runner: 'bun:test' | 'plain', over: Record<string, unknown> = {}) => {
    const f = join(dir, name)
    writeFileSync(f, body)
    const cases = [
      {
        id: 'fixture-case',
        path: f,
        theme: 'other-round',
        runner,
        ci: 'run',
        purpose: '端到端负对照夹具',
        minPass: 1,
        minAssert: 1,
        minSites: 0,
        // 夹具也声明一个读数，好让 `claim-consistency` 这条判据在自检里**可量**
        // （没有可核对声明时它会判 UNPROVEN，绿夹具就永远到不了 GREEN）。
        claimPass: 1,
        ...over,
      },
    ]
    writeFileSync(casesFile, JSON.stringify(cases))
    return casesFile
  }

  test('红夹具（真失败的 bun:test）⇒ 判 RED 并点名该用例；夹具模式的"自检通过"码是 6，**不是 0**', () => {
    const f = withFixture("import { expect, test } from 'bun:test'\ntest('必红', () => { expect(1).toBe(2) })\n", 'red.test.ts', 'bun:test')
    const r = runGate(['--selftest', '--cases', f, '--expect', 'red'])
    expect(r.code).toBe(SELFTEST_EXIT)
    expect(r.code).not.toBe(GREEN_EXIT)
    expect(r.out).toContain('SELFTEST')
    expect(r.out).toContain('mode=fixture')
    expect(r.out).toContain('actual=RED')
    expect(r.out).toContain('fixture-case 实测失败')
  })

  test('绿夹具 ⇒ 判 GREEN（证明自检不是"永远红"）；退出码仍是 6 —— 夹具跑的不是发布用例表', () => {
    const f = withFixture("import { expect, test } from 'bun:test'\ntest('必绿', () => { expect(1).toBe(1) })\n", 'green.test.ts', 'bun:test')
    const r = runGate(['--selftest', '--cases', f, '--expect', 'green'])
    expect(r.code).toBe(SELFTEST_EXIT)
    expect(r.code).not.toBe(GREEN_EXIT)
    expect(r.out).toContain('actual=GREEN')
    expect(r.out).toContain('这不是发布通过')
  })

  test('空夹具（exit 0、什么都不输出）⇒ 判 UNPROVEN，不当通过', () => {
    const f = withFixture('// 什么都不做，也不输出：空转 exit 0\n', 'empty.test.ts', 'plain')
    const r = runGate(['--selftest', '--cases', f, '--expect', 'unproven'])
    expect(r.code).toBe(SELFTEST_EXIT)
    expect(r.out).toContain('actual=UNPROVEN')
    expect(r.out).toContain('产出不了读数')
    expect(r.out).not.toContain('actual=GREEN')
  })

  test('把一条**真实回归用例**的下限抬高 ⇒ 判 RED 并点名是哪一条（等价于"改红一条"，但不改仓库文件）', () => {
    const real = CASES.find((c) => c.id === 'render-failure')!
    const f = join(dir, 'real.json')
    writeFileSync(f, JSON.stringify([{ ...real, minPass: 999 }]))
    const r = runGate(['--selftest', '--cases', f, '--expect', 'red'])
    expect(r.code).toBe(SELFTEST_EXIT)
    expect(r.out).toContain('actual=RED')
    expect(r.out).toContain('render-failure')
    expect(r.out).toContain('minPass=999')
  })

  test('自检"不通过"时退 1（**不是 0**）：期望与实测不符', () => {
    const f = withFixture("import { expect, test } from 'bun:test'\ntest('必绿', () => { expect(1).toBe(1) })\n", 'mismatch.test.ts', 'bun:test')
    const r = runGate(['--selftest', '--cases', f, '--expect', 'red'])
    expect(r.code).toBe(RED_EXIT)
    expect(r.out).toContain('自检不通过')
  })

  test('`--cases` 单独用（不带 --selftest）⇒ 退出 4：这个口子没法把发布门刷绿', () => {
    const f = withFixture("import { expect, test } from 'bun:test'\ntest('绿', () => { expect(1).toBe(1) })\n", 'guard.test.ts', 'bun:test')
    const r = runGate(['--cases', f])
    expect(r.code).toBe(4)
    expect(r.out).toContain('只用于负对照自检')
  })

  // ── ① 的两条新守门：`--selftest` 不许成为"退 0 的口" ─────────────────────────
  test('`--selftest` 缺 `--expect` ⇒ 参数守卫 4（改前是"碰巧不通过"，现在是参数错误）', () => {
    const f = withFixture("import { expect, test } from 'bun:test'\ntest('必绿', () => { expect(1).toBe(1) })\n", 'noexpect.test.ts', 'bun:test')
    const r = runGate(['--selftest', '--cases', f])
    expect(r.code).toBe(ARGS_EXIT)
    expect(r.out).toContain('必须与 `--expect')
  })

  test('`--expect` 单独用（不带 --selftest）⇒ 参数守卫 4（写了期望却没人比）', () => {
    const r = runGate(['--expect', 'green'])
    expect(r.code).toBe(ARGS_EXIT)
    expect(r.out).toContain('只用于 `--selftest`')
  })

  test(
    '`--selftest` **不带** `--cases`（= full 模式）⇒ 结构性判据真跑，且子集永不为绿',
    () => {
      // 负对照：还原"自检模式跳过 execCriteria" ⇒ `gate-drivers` 判据行不存在、`--only` 的 filtered 为空
      // 而旧 partial 定义让裁决变 GREEN ⇒ 两条断言都会红。
      // 超时给到 180s：full 模式**真的会跑** preflight + gate:drivers + 两个 tsc（本机实测 ~22s，
      // 默认 5s 不够 —— 这本身就是"它真跑了判据"的旁证）。
      const r = runGate(['--selftest', '--expect', 'PARTIAL', '--only', 'gate-drivers'])
      expect(r.code).toBe(PARTIAL_EXIT) // 子集在**自检模式下**也判 PARTIAL（子集永不为绿）
      expect(r.code).not.toBe(GREEN_EXIT)
      expect(r.out).toMatch(/^gate-drivers\s+(GREEN|RED|UNPROVEN)\s/m)
      expect(r.out).toContain('mode=full')
      // 机制 13（门绿 ≠ CI 绿）：结构性判据跑了 ⇒ 收尾区**必须有** CI-GAP 行，而且 notRun 要有数。
      // 这条断言要的就是"这个数**一直印着**"：只 `| tail` 的人也必须看得到它。
      // GATE-C 起末尾多一个 `offlineExecuted=`（本次离线 CI 的实跑成功数；本跑法不依赖它 ⇒ `n/a`）。
      expect(r.out).toMatch(/^CI-GAP  includeTestLike=\d+  gateRuns=\d+  waived=\d+  notRun=\d+  digest=[0-9a-f]{12}  offlineExecuted=\S+$/m)
      expect(r.out).toContain('门绿只覆盖本门范围')
      // `--only gate-drivers` **不依赖**离线 CI 证据 ⇒ 本次没有起完整 test-ci（这正是避免递归的那条选择）。
      // 反证：CI-GAP 行上的 `offlineExecuted=n/a`，且输出里没有 offline-ci 判据行。
      expect(r.out).toContain('offlineExecuted=n/a')
      expect(r.out).not.toMatch(/^offline-ci\s+(GREEN|RED|UNPROVEN)\s/m)
      // `--only` 会把**判据行**滤掉（这一跑只印 gate-drivers），但 CI-GAP 行仍然在 ——
      // 这正是"这个数**一直**印着"的意思：连子集/调试跑法也不许把它藏起来。
      expect(r.out).not.toMatch(/^manifest-gate-gap\s/m)
    },
    180_000,
  )

  test('夹具用例跑完后清场', () => {
    rmSync(dir, { recursive: true, force: true })
    expect(true).toBe(true)
  })
})

// ── 4. 门自身的静态不变式（防止用例表被悄悄改坏） ────────────────────────────

describe('CASES 表的不变式', () => {
  test('每条都有量什么（purpose）/ 非零下限 / 来源计数，且路径唯一', () => {
    expect(CASES.length).toBeGreaterThan(50)
    for (const c of CASES) {
      expect(c.purpose.length).toBeGreaterThan(4)
      expect(c.minPass).toBeGreaterThan(0)
      expect(c.minAssert).toBeGreaterThan(0)
      expect(c.minSites).toBeGreaterThan(0)
    }
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length)
    expect(new Set(CASES.map((c) => c.path)).size).toBe(CASES.length)
  })

  test('豁免表中的每一条都写了理由', () => {
    for (const w of COVERAGE_WAIVERS) expect(w.reason.trim().length).toBeGreaterThan(10)
  })

  test('断言站点计数器认得三种写法', () => {
    expect(countAssertSites('expect(1).toBe(1)')).toBe(1)
    expect(countAssertSites('assert.equal(a, b)')).toBe(1)
    expect(countAssertSites('check("x", true, "d")')).toBe(1)
  })

  test('派生器在真仓上给得出候选（否则 caseset-coverage 会一直是 UNPROVEN）', () => {
    const c = deriveRoundCandidates(ROOT)
    expect(c).not.toBeNull()
    expect(c!.derived.length).toBeGreaterThan(0)
  })
})

// ── 5. 门自己的收尾：不许硬切（GATE-EXIT-FLUSH 单） ──────────────────────────

/**
 * 与 P23 在 `script/test-ci.ts` 上修掉的是**同一形状**：`main(...)` 的收尾写完之后紧跟一次
 * `process.exit(...)`，而 Bun 的 stdout 在**管道**上是异步刷写 ⇒ 没冲刷出去的那一截被切掉，
 * **退出码仍是 0**（`bun run release-gate | grep …`、CI 抓输出、任何解析它的脚本都会偶发
 * "少一截却看起来成功"）。
 *
 * 两条判据：
 *  · **静态**（确定性）：入口只许 `process.exitCode = main(...)`，门源码里不许出现 `process.exit(`。
 *  · **动态**（放大夹具）：单条用例的 id 撑到 8MB ⇒ `runCases` 那一行就是**一次 ~8MB 的 write**，
 *    然后走门的收尾与退出点。经**裸管道**跑 4 次，收尾行/末尾换行/长度三条都不许丢。
 *    实测（bun 1.3.13 / 2026-09-26）：硬切版 **20/20 丢尾**（输出停在 0.8–2.3MB、`exit=0`），
 *    `process.exitCode` 版 **0/20**（25,166,868 字符逐字节完整）。⇒ 去掉 `process.exit(` 这条静态
 *    判据是**确定性地**红，动态那条在硬切版下 4 次里必红（单次丢尾概率实测 100%）。
 * 注：本文件本身因"会再 spawn 本门"被 `COVERAGE_WAIVERS` 挡在 CASES 表外（见该表理由），
 * 它是 CI 清单里的用例，由 `bun run test:ci` 跑。
 */
describe('门自己的收尾 · 不许硬切（GATE-EXIT-FLUSH）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-exit-flush-'))
  /** 8MB：与 P23 的 drain-probe、以及本文件 §1b 的"放大版夹具"同一量级。 */
  const GIANT = 8 * 1024 * 1024
  const giantCases = join(dir, 'giant.json')
  writeFileSync(
    giantCases,
    JSON.stringify([
      {
        id: 'x'.repeat(GIANT),
        path: '/nonexistent-gate-fixture/giant.test.ts',
        theme: 'other-round',
        runner: 'bun:test',
        ci: 'unregistered',
        purpose: '放大夹具（单行 8MB）',
        minPass: 1,
        minAssert: 1,
        minSites: 0,
      },
    ]),
  )

  test('静态不变式：入口用 `process.exitCode`（不硬切），**代码里**没有 `process.exit(`', () => {
    const src = readFileSync(GATE, 'utf8')
    // 入口形状：`main(...)` 的结果进 `process.exitCode`，且输出层有机会在退出前问一次"读端还在不在"
    // （GATE-EPIPE-EXIT-CODE 单把这一行从单表达式改成收尾块，断言随之落到块的两个不变式上）。
    expect(src).toContain('const code = main(process.argv.slice(2))')
    expect(src).toContain('process.exitCode = stdoutPipeClosed ? EPIPE_EXIT : code')
    // 只扫**代码行**：门里那几段解释这条缺陷的注释（` * … process.exit() …`）本身就是"形状"的说明，
    // 把它们一并算进去会把一条正确的实现判红（本判据第一版就踩了）。
    const code = src
      .split('\n')
      .filter((l) => {
        const t = l.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    // `process.exitCode = …` 不是 `process.exit(`：这条正则会漏掉前者、抓到后者。
    expect(/process\.exit\(/.test(code)).toBe(false)
    // 收尾探针必须在**最后一次真写之后**（探针本身就是 `writeSync(1, '')` 那次系统调用）
    expect(code).toContain('flushCheck()')
  })

  test('放大夹具经裸管道 ×4 ⇒ 收尾行、末尾换行、长度三条都不许丢（硬切版必红）', () => {
    for (let i = 0; i < 4; i++) {
      const r = spawnSync(process.execPath, [GATE, '--root', ROOT, '--selftest', '--cases', giantCases, '--expect', 'red'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 300_000,
        maxBuffer: 512 * 1024 * 1024,
      })
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
      // 夹具模式的自检通过码是 6（**不是 0**，见 GATE-SELFTEST-EXIT-DOOR）：这里断言的仍是
      // "自检通过 + 收尾行/换行/长度三条都不许丢"，只是通过码换了。
      expect(r.status).toBe(SELFTEST_EXIT)
      expect(out.includes('⇒ 自检通过')).toBe(true)
      expect(out.endsWith('\n')).toBe(true)
      // 硬切版停在 0.8–2.3MB（连夹具那一行都没写完）；完整版 2500 万字符左右。
      expect(out.length).toBeGreaterThan(GIANT)
    }
  })

  test('放大夹具清场', () => {
    rmSync(dir, { recursive: true, force: true })
    expect(true).toBe(true)
  })
})

// ── 6. PROVENANCE：门自己与被量对象都带身份（GATE-PROVENANCE 单） ──────────────

/**
 * R3（`bugfixHistory/GATE-NONDETERMINISM-20260926.md` §7.R3）：读数必须自带**门的版本**，否则
 * "同一棵树两次两样"里"门文件在两次运行之间被改过"这一档只能靠 mtime 之类的外部证据倒推 ——
 * `cases=58→62` 就是这么变成孤证的。
 *
 * 四条断言，其中第二条是**负对照**：
 *  · `gate=` 就是**执行中那份源文件**的 sha256（测试侧用 `node:crypto` 独立重算，不信任门的算术）；
 *  · **门多一个字节 ⇒ 唯一变化的字段就是 `gate=`**（其它身份字段逐字相同）——
 *    这正是"没有这个字段就分不出门变了"的机器可读版本，也是本单要买的那条可诊断性；
 *  · `gate=` 对同一份门是确定的（同夹具两次 ⇒ 整行逐字相同；树在动的极端情况下只保证 gate 那段）；
 *  · 被量对象的身份打全（HEAD 12 位 / dirty 条数 / worktree 摘要）且与测试侧独立读的 git 快照一致。
 */
describe('PROVENANCE · 门自己与被量对象都带身份（GATE-PROVENANCE）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-provenance-'))
  const fixture = join(dir, 'green.test.ts')
  const casesFile = join(dir, 'cases.json')
  writeFileSync(fixture, "import { expect, test } from 'bun:test'\ntest('必绿', () => { expect(1).toBe(1) })\n")
  writeFileSync(
    casesFile,
    JSON.stringify([
      {
        id: 'fixture-case',
        path: fixture,
        theme: 'other-round',
        runner: 'bun:test',
        ci: 'run',
        purpose: 'PROVENANCE 夹具',
        minPass: 1,
        minAssert: 1,
        minSites: 0,
        claimPass: 1,
      },
    ]),
  )

  /** 测试侧的独立摘要：不经过门的任何函数。 */
  const indep = (b: string | Uint8Array): string => createHash('sha256').update(b).digest('hex')

  const provenanceOf = (out: string): string => {
    const l = out.split('\n').find((x) => x.startsWith('PROVENANCE  '))
    expect(l).toBeDefined()
    return l!
  }
  const fieldOf = (line: string, key: string): string => {
    const m = line.match(new RegExp(`(?:^|\\s)${key}=(\\S+)`))
    expect(m).not.toBeNull()
    return m![1]
  }
  const selftestArgs = ['--selftest', '--cases', casesFile, '--expect', 'green']
  /** 树快照：HEAD + porcelain 原文。两次快照相同 ⇒ 门取的那一次快照必须落在同一个值上。 */
  const gitSnapshot = (): { head: string; porcelain: string } => {
    const g = (args: string[]): string => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout ?? ''
    return { head: g(['rev-parse', 'HEAD']).trim(), porcelain: g(['status', '--porcelain']) }
  }

  test('`gate=` 就是执行中那份门源文件的 sha256 前 12 位（独立重算）', () => {
    const r = runGate(selftestArgs)
    expect(r.code).toBe(SELFTEST_EXIT)
    const want = indep(readFileSync(GATE))
    expect(fieldOf(provenanceOf(r.out), 'gate')).toBe(want.slice(0, 12))
    expect(fieldOf(provenanceOf(r.out), 'gateFile')).toBe('script/release-gate.ts')
  })

  test('负对照：门源文件多一个字节 ⇒ **只有 `gate=` 变**，其余身份字段逐字相同', () => {
    const src = readFileSync(GATE, 'utf8')
    // 模拟的就是那条真实现场：**同一个路径**的门文件在两次运行之间被改（`cases=58→62` 的成因）。
    // 同一个 `--root`、同一个 `gateFile=`，差异被逼到只剩 `gate=` 一个字段。
    const root = join(dir, 'copy')
    const gatePath = join(root, 'script/release-gate.ts')
    mkdirSync(join(root, 'script'), { recursive: true })
    const runCopy = (): string => {
      const r = spawnSync(process.execPath, [gatePath, '--root', root, ...selftestArgs], {
        cwd: root,
        encoding: 'utf8',
        timeout: 300_000,
      })
      expect(r.status).toBe(SELFTEST_EXIT)
      return provenanceOf(`${r.stdout ?? ''}${r.stderr ?? ''}`)
    }
    writeFileSync(gatePath, src)
    const lineA = runCopy()
    writeFileSync(gatePath, `${src}\n`) // 两次运行之间：门文件多了一个换行字节
    const lineB = runCopy()
    // ① 两次读数自报的版本，就是各自那一刻那份源文件的 sha256
    expect(fieldOf(lineA, 'gate')).toBe(indep(src).slice(0, 12))
    expect(fieldOf(lineB, 'gate')).toBe(indep(`${src}\n`).slice(0, 12))
    // ② 唯一变化的字段就是 `gate=`：把它归一之后整行逐字相同
    expect(lineA).not.toBe(lineB)
    expect(lineA.replace(/gate=\S+/, 'gate=X')).toBe(lineB.replace(/gate=\S+/, 'gate=X'))
  })

  test('`gate=` 是确定的：同一份门跑两次，`gate=`/`gateFile=` 逐字相同', () => {
    const before = gitSnapshot()
    const l1 = provenanceOf(runGate(selftestArgs).out)
    const l2 = provenanceOf(runGate(selftestArgs).out)
    const after = gitSnapshot()
    expect(fieldOf(l1, 'gate')).toBe(fieldOf(l2, 'gate'))
    expect(fieldOf(l1, 'gateFile')).toBe(fieldOf(l2, 'gateFile'))
    // 树没动 ⇒ 整行必须逐字相同；树在动（别人在写）⇒ 只保证 gate 那一段（门取的是单次快照）
    if (before.head === after.head && before.porcelain === after.porcelain) expect(l1).toBe(l2)
  })

  test('被量对象的身份打全：HEAD 12 位 / dirty 条数 / worktree 摘要，与测试侧独立读数一致', () => {
    const before = gitSnapshot()
    const line = provenanceOf(runGate(selftestArgs).out)
    const after = gitSnapshot()
    expect(line).toMatch(/(?:^|\s)HEAD=[0-9a-f]{12,40}(?:\s|$)|(?:^|\s)HEAD=unknown(?:\s|$)/)
    expect(line).toMatch(/(?:^|\s)dirty=-1(?:\s|$)|(?:^|\s)dirty=\d+(?:\s|$)/)
    expect(line).toMatch(/(?:^|\s)worktree=[0-9a-f]{12}(?:\s|$)|(?:^|\s)worktree=unknown(?:\s|$)/)
    // worktree 与 dirty 必须出自同一次快照：一个读到了、另一个不能是"读不到"
    expect(fieldOf(line, 'worktree') === 'unknown').toBe(fieldOf(line, 'dirty') === '-1')
    const snap = before.head === after.head && before.porcelain === after.porcelain ? before : null
    if (snap !== null) {
      expect(fieldOf(line, 'HEAD')).toBe(snap.head.slice(0, 12))
      expect(fieldOf(line, 'dirty')).toBe(String(snap.porcelain.split('\n').filter(Boolean).length))
      expect(fieldOf(line, 'worktree')).toBe(indep(snap.porcelain).slice(0, 12))
    } else {
      // 树在动：读数只对它运行时那一刻负责，但必须与前后两次快照之一逐字对上
      const ok = [before, after].filter(
        (s) =>
          fieldOf(line, 'HEAD') === s.head.slice(0, 12) &&
          fieldOf(line, 'dirty') === String(s.porcelain.split('\n').filter(Boolean).length) &&
          fieldOf(line, 'worktree') === indep(s.porcelain).slice(0, 12),
      )
      expect(ok.length).toBeGreaterThan(0)
    }
  })

  test('机器可读报告里带同一份身份（全文 sha256，不是前 12 位）；`sourceSha256` 读不到 ⇒ null', () => {
    const jsonPath = join(dir, 'report.json')
    const r = runGate([...selftestArgs, '--json', jsonPath])
    expect(r.code).toBe(SELFTEST_EXIT)
    const rep = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
      exit: number
      verdictExit: number
      selftestMode: string
      provenance: { gate: { path: string; sha256: string | null }; worktreeSha256: string | null; head: string; dirty: number }
    }
    // 报告里的 `exit=` 是**进程实际退的码**（夹具模式 = 6），`verdictExit=` 才是裁决码 —— 两者都打出来，
    // 免得读报告的人把"自检通过"读成"发布通过"。
    expect(rep.exit).toBe(SELFTEST_EXIT)
    expect(rep.verdictExit).toBe(GREEN_EXIT)
    expect(rep.selftestMode).toBe('fixture')
    expect(rep.provenance.gate.path).toBe(GATE)
    expect(rep.provenance.gate.sha256).toBe(indep(readFileSync(GATE)))
    expect(rep.provenance.gate.sha256!.slice(0, 12)).toBe(fieldOf(provenanceOf(r.out), 'gate'))
    expect(rep.provenance.head.length).toBeGreaterThan(0)
    expect(typeof rep.provenance.dirty).toBe('number')
    // 读不到就 null：身份不是判据，读不到不许把门判红
    expect(sourceSha256(join(dir, 'no-such-file.ts'))).toBeNull()
  })

  test('PROVENANCE 夹具清场', () => {
    rmSync(dir, { recursive: true, force: true })
    expect(true).toBe(true)
  })
})

// ── 7. EPIPE：消费者提前走了 ⇒ 独立退出码 5（GATE-EPIPE-EXIT-CODE 单） ────────

/**
 * 上一单（P25）把硬切 `process.exit(...)` 改成 `process.exitCode`（见 §5）：**静默丢尾**修掉了，
 * 但引入了一个新的失败形状 —— 消费者提前退出（`bun run release-gate | head -1`）时，
 * Bun 把未捕获的 `EPIPE` 抛出来，门自己 **exit=1**，与 `RED` 逐字同码。
 * CI 里任何 `release-gate | head/grep -q` 都会被**误读成门红了**。
 *
 * 本单的裁定：**不许让 EPIPE 退成 0**，也**不许**让它继续冒充 `RED=1`。EPIPE 意味着
 * **消费者走了、判据没送达** —— 不是绿、不是红，是"没人听"。所以给它独立码 `5`，
 * 并在 stderr 说明白"这不是 RED"。正常情况（读满）退出码语义**一个字不改**。
 *
 * 实测（bun 1.3.13，本文件跑的这两条就是负对照）：
 *  · `| head -1`：改前 **exit=1**（未捕获 EPIPE 打死，3/3）⇒ 改后 **exit=5**（3/3），stderr 有说明行；
 *  · `| head -100000`（读满）：改前改后**都是裁决码**（本夹具没有可核对声明 ⇒ UNPROVEN=2⇒
 *    自检"不通过"确实给 1；读满这一档要断的是"截断没被误判"，不是具体那一位），stderr **0 字节**。
 *
 * `EPIPE=5` 为什么与现有码表不冲突：现有码表是 `0/1/2/3`（裁决）+ `4`（`--cases` 参数守卫），
 * 5 未被占用（本单核过全文，见回执）。
 */
describe('EPIPE · 消费者提前走了 ⇒ 独立退出码 5（不是 RED，也不是绿）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-epipe-'))
  const fixture = join(dir, 'green.test.ts')
  const casesFile = join(dir, 'cases.json')
  const notices = join(dir, 'gate-notices.txt')
  writeFileSync(fixture, "import { expect, test } from 'bun:test'\ntest('必绿', () => { expect(1).toBe(1) })\n")
  writeFileSync(
    casesFile,
    JSON.stringify([
      {
        id: 'epipe-fixture',
        path: fixture,
        theme: 'other-round',
        runner: 'bun:test',
        ci: 'run',
        purpose: 'EPIPE 负对照夹具',
        minPass: 1,
        minAssert: 1,
        minSites: 0,
        claimPass: 1,
      },
    ]),
  )

  /**
   * **按用户实际敲的那条命令**起真管道：`bun <gate> … | <consumer>`。
   * 读端自己一关，fd 1 就成了断管 —— 与 `bun run release-gate | head -1` 同一条路径。
   * `set -o pipefail` 让 `$?` 就是门自己的退出码（不是管道最后一环的）。
   */
  function pipeRun(consumer: string, opts: { complete: boolean }): { status: number | null; stderrText: string; outText: string } {
    const bin = process.execPath
    const outFile = join(dir, 'pipe-out.txt')
    const errFile = join(dir, 'pipe-err.txt')
    const cmd =
      `set -o pipefail; "${bin}" "${GATE}" --root "${ROOT}" --selftest --cases "${casesFile}" --expect green` +
      ` 2>"${errFile}" | ${consumer} > "${outFile}"; echo "PIPESTATUS=\${PIPESTATUS[*]}"`
    const r = spawnSync('bash', ['-c', cmd], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 })
    // `PIPESTATUS` 那一行是**独立于门输出**的一条读数：它由 shell 打出来，不受消费者截断影响。
    const marker = (r.stdout ?? '').split('\n').find((l) => l.startsWith('PIPESTATUS='))
    expect(marker).toBeDefined()
    const statuses = marker!.replace('PIPESTATUS=', '').trim().split(/\s+/).filter(Boolean)
    expect(statuses.length).toBe(2) // [门, 消费者]
    const stderrText = readFileSync(errFile, 'utf8')
    const outText = readFileSync(outFile, 'utf8')
    writeFileSync(notices, `${notices}-${consumer}\n${stderrText}`)
    // 反向校验：门确实跑起来了 —— 两条读法都必须至少拿到第一行。
    // 读满时还要拿到 SELFTEST 收尾行（证明消费者那一环没把门的输出吞掉）；截断时它**必须不在**（见测试 ①）。
    expect(outText.length).toBeGreaterThan(0)
    if (opts.complete) expect(outText).toContain('SELFTEST')
    return { status: Number(statuses[0]), stderrText, outText }
  }

  test('① `| head -1`（读端提前走）⇒ exit=**5**，stderr 说明"截断、未送达、这不是 RED"', () => {
    const r = pipeRun('head -1', { complete: false })
    expect(r.status).toBe(EPIPE_EXIT)
    // 三个事实都要在 stderr 上说出来：截断 / 未送达 / 不是 RED；且**逐字**就是门导出的那段说明
    expect(r.stderrText).toBe(EPIPE_NOTICE)
    expect(r.stderrText).toContain('EPIPE')
    expect(r.stderrText).toContain('截断')
    expect(r.stderrText).toContain('判据未送达')
    expect(r.stderrText).toContain('这不是 RED')
    // 这一档**必须**与绿、红都可区分
    expect(r.status).not.toBe(GREEN_EXIT)
    expect(r.status).not.toBe(RED_EXIT)
    expect(r.status).not.toBe(UNPROVEN_EXIT)
    expect(r.status).not.toBe(PARTIAL_EXIT)
    expect(r.status).not.toBe(ARGS_EXIT)
    expect(r.status).not.toBe(SELFTEST_EXIT) // 6 是"夹具模式自检通过"，EPIPE 不许冒充它
    // **真截断**：收尾行确实没送到（否则"截断"就只是嘴上说说）
    expect(r.outText).not.toContain('SELFTEST')
  })

  test('② `| head -100000`（读满）⇒ 仍是原语义：夹具模式自检通过码 6 + 不吞读数 + stderr 无截断说明', () => {
    const r = pipeRun('head -100000', { complete: true })
    // 绿夹具 + 声明读数 1=实测 1 + `--expect green` ⇒ 自检通过 ⇒ **6**（夹具模式永不为 0）
    expect(r.status).toBe(SELFTEST_EXIT)
    expect(r.status).not.toBe(GREEN_EXIT)
    expect(r.stderrText).toBe('')
    expect(r.stderrText).not.toContain('EPIPE')
  })

  test('③ `| cat > /dev/null`（读满，不截断任何行）⇒ 退出码与直写文件逐字相同', () => {
    const piped = pipeRun('cat > /dev/null', { complete: true })
    // 对照组：同一条命令**不接管道**（直写文件）
    const direct = spawnSync(process.execPath, [GATE, '--root', ROOT, '--selftest', '--cases', casesFile, '--expect', 'green'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300_000,
    })
    expect(piped.status).toBe(direct.status)
    expect(piped.stderrText).toBe('')
  })

  test('④ 静态不变式：EPIPE 有独立码，且在唯一出口上**覆盖**裁决码；不许吞成 0', () => {
    const src = readFileSync(GATE, 'utf8')
    // 独立码存在且 ≠ 0/1/2/3/4（`EPIPE_EXIT` 导出给测试与外部消费者看）
    expect([GREEN_EXIT, RED_EXIT, UNPROVEN_EXIT, PARTIAL_EXIT, ARGS_EXIT]).toEqual([0, 1, 2, 3, 4])
    expect(EPIPE_EXIT).toBe(5)
    expect([GREEN_EXIT, RED_EXIT, UNPROVEN_EXIT, PARTIAL_EXIT, ARGS_EXIT]).not.toContain(EPIPE_EXIT)
    // 自检通过码 6 与**全部**裁决码都可区分（GATE-SELFTEST-EXIT-DOOR 单）：
    // 夹具模式的"自检通过"不许与"发布裁决是绿的"共用 0。
    expect(SELFTEST_EXIT).toBe(6)
    expect([GREEN_EXIT, RED_EXIT, UNPROVEN_EXIT, PARTIAL_EXIT, ARGS_EXIT, EPIPE_EXIT]).not.toContain(SELFTEST_EXIT)
    // 出口：截断**覆盖**裁决码，且绝不可能是 0
    expect(src).toContain('process.exitCode = stdoutPipeClosed ? EPIPE_EXIT : code')
    expect(src).not.toContain('process.exitCode = stdoutPipeClosed ? GREEN_EXIT')
    // 裁决不因 EPIPE 改动：`EXIT_OF` 仍是四条裁决码，不含 EPIPE
    expect(src).toContain('const EXIT_OF: Record<Verdict, number> = { GREEN: GREEN_EXIT, RED: RED_EXIT, UNPROVEN: UNPROVEN_EXIT, PARTIAL: PARTIAL_EXIT }')
    // 输出口收敛：本门的 stdout/stderr 只能走 `writeTo`（免得多一条绕过 EPIPE 检测的写路径）。
    // 只扫**代码行**（注释里逐字解释这条缺陷，不能算写路径）；正则做空白归一，免得换行把断言弄成"看格式"。
    const codeOnly = src
      .split('\n')
      .filter((l) => {
        const t = l.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    const flat = codeOnly.replace(/\s+/g, ' ')
    const rawWrites = flat.match(/process\.(?:stdout|stderr)\.write\(/g) ?? []
    // 只允许 `writeTo` 自己那一条降级写（`process.stdout.write(s)`）+ 说明行那一条（`process.stderr.write(EPIPE_NOTICE)`）
    expect(rawWrites.length).toBe(2)
    expect(flat).toContain('process.stdout.write(s)')
    expect(flat).toContain('process.stderr.write(EPIPE_NOTICE)')
    // 其余写路径都必须是 `writeTo`：没有旁路的 `process.stdout.write(` 调用点
    expect((flat.match(/writeTo\(/g) ?? []).length).toBeGreaterThanOrEqual(5)
  })

  test('⑤ 清场', () => {
    rmSync(dir, { recursive: true, force: true })
    expect(true).toBe(true)
  })
})

// ── 5. 定版单（GATE-FINALIZATION）· 负对照纪律与"门绿 ≠ CI 绿" ────────────────

/**
 * 两条规矩（`docs/VERIFICATION_MECHANISMS.md` 机制 12 / 13）在这里落成**可跑的断言**：
 *
 * · 机制 12：负对照**改在副本上做**。本块第 3 条就是**照做**的一份实证 —— 副本挂哨兵、`--root` 指真仓、
 *   读数自报 `gateFile=` 是副本、`negctl=` 不是 `none`；**交付文件一个字节都没动**（同时断言）。
 *   兜底是"交付态哨兵必须是 null"那条静态不变式：就地做完负对照忘了撤 ⇒ 它精确变红。
 * · 机制 13：`notRun` 这个数**一直印着**（判据行 + 收尾区 `CI-GAP` 行）。收尾区那一条由
 *   "端到端负对照 · full 模式" 那个用例顺带断言（它本来就要跑一遍结构性判据，零额外成本）。
 */
describe('定版 · 负对照改在副本上做（机制 12）与 notRun 常印（机制 13）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-finalization-'))
  const fixture = join(dir, 'green.test.ts')
  const casesFile = join(dir, 'cases.json')
  const reportPath = join(dir, 'report.json')
  writeFileSync(fixture, "import { expect, test } from 'bun:test'\ntest('必绿', () => { expect(1).toBe(1) })\n")
  writeFileSync(
    casesFile,
    JSON.stringify([
      {
        id: 'fixture-case',
        path: fixture,
        theme: 'other-round',
        runner: 'bun:test',
        ci: 'run',
        purpose: '定版夹具（负对照哨兵 / mode / 报告字段）',
        minPass: 1,
        minAssert: 1,
        minSites: 0,
        // 夹具要能判 GREEN，就必须让 `claim-consistency` 有可核对的声明（否则它是 UNPROVEN ⇒ 裁决 UNPROVEN）。
        claimPass: 1,
      },
    ]),
  )
  const outOf = (r: { stdout: string | null; stderr: string | null }): string => `${r.stdout ?? ''}${r.stderr ?? ''}`

  test('交付态：负对照哨兵必须是 `null`（就地做负对照忘撤 ⇒ 本条精确变红）', () => {
    expect(NEGATIVE_CONTROL).toBe(null)
    // 静态复核：源码里那一行确实是 `= null`（防止"运行时是 null、源码却被人改成别的值再改回来"这档）
    const raw = readFileSync(GATE, 'utf8')
    expect(/^export const NEGATIVE_CONTROL: string \| null = null$/m.test(raw)).toBe(true)
  })

  test('交付态：负对照残留探针不许命中（验收队复算清单里就有这条 grep，交付态 = 0）', () => {
    const raw = readFileSync(GATE, 'utf8')
    const hits = raw.split('\n').filter((l) => /false &&|\/\/ *criteria\.push/.test(l))
    expect(hits).toEqual([])
  })

  test('**负对照改在副本上**：副本挂哨兵 + `--root` 真仓 ⇒ 读数自报 negctl= / NEGATIVE-CONTROL / gateFile=副本；交付文件不动', () => {
    const copyRoot = join(dir, 'copy')
    const gatePath = join(copyRoot, 'script', 'release-gate.ts')
    mkdirSync(join(copyRoot, 'script'), { recursive: true })
    const src = readFileSync(GATE, 'utf8')
    expect(src).toContain('export const NEGATIVE_CONTROL: string | null = null')
    writeFileSync(
      gatePath,
      src.replace(
        'export const NEGATIVE_CONTROL: string | null = null',
        "export const NEGATIVE_CONTROL: string | null = '\u2463-baseline-off（负对照：故意把基线判定关掉）'",
      ),
    )
    const r = spawnSync(process.execPath, [gatePath, '--root', ROOT, '--selftest', '--cases', casesFile, '--expect', 'green', '--json', reportPath], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300_000,
    })
    const out = outOf(r)
    expect(r.status).toBe(SELFTEST_EXIT) // 夹具模式的"自检通过"码是 6，永不为 0
    // ① 三件套都在：跑法 / 哨兵 / 副本路径
    expect(out).toContain('mode=selftest-fixture')
    expect(out).toContain('negctl=')
    expect(out).toContain('这不是交付态')
    expect(out).toContain('NEGATIVE-CONTROL')
    expect(out).not.toContain('gateFile=script/release-gate.ts') // 跑的不是交付那份门
    // ② 机器可读报告里同字段
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { provenance: { mode: string; negativeControl: string | null } }
    expect(report.provenance.mode).toBe('selftest-fixture')
    expect(report.provenance.negativeControl).toBe('\u2463-baseline-off（负对照：故意把基线判定关掉）')
    // ③ **交付文件一个字节都没动** —— 这正是"改在副本上"要买到的东西
    expect(readFileSync(GATE, 'utf8')).toBe(src)
  })

  test('夹具跑完后清场', () => {
    rmSync(dir, { recursive: true, force: true })
    expect(true).toBe(true)
  })
})
