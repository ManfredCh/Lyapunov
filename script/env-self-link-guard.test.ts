#!/usr/bin/env bun
/**
 * SELFLINK-READONLY-GUARD · `script/env-self-link-guard.ts` 的测试（2026-09-26）
 *
 * ## 这一份测什么（三层，每层都是负对照）
 *
 * 1. **纯函数层**（同进程，毫秒级）：判据本身分得清"自指 / 正向链接 / 环 / 断链 / 作用域归属"。
 *    这一层不需要磁盘，也**不写任何东西**。
 * 2. **临时树层**（`mkdtempSync` 造的沙箱树，**只在系统临时目录里**，测完 `rmSync`）：
 *    真的建软链、真的跑 `scan()`，断言 D2 判据在真实文件系统上的行为 ——
 *    自指链被抓到并点名、正向链接不被误报、**删掉之后数字归零**（这就是负对照的"造链/删链/复查"三步）。
 * 3. **接线层**：`release-gate.ts` 的 `parseSelfLinkGuard()` 能吃下守卫的 `--json`，
 *    并且**类 1 与类 2 两个数都进 metrics**（"只报一个数 ⇒ 得出相反结论"是本单要防的那件事）。
 *
 * ## 纪律
 *
 * - **只读**：本文件不碰仓库工作树里的任何文件；所有建/删都发生在 `mkdtempSync` 造的系统临时目录里，
 *   退出前 `rmSync` 清掉。**不触碰 `node_modules/**` 与 `.upstream/**`**。
 * - **不跑 `test:ci`**；`bun test script/env-self-link-guard.test.ts` 即可。
 * - 本文件是**新增测试文件**，路径已单列在回执里（`bugfixHistory/SELFLINK-READONLY-GUARD-20260926.md`）。
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSelfLinkGuard, evalSelfLinkCriterion, run } from './release-gate.ts'
import { CRITERION, NOT_COVERED, buildRemediation, renderText, resolveLink, makeGraph, scan, scopeOf, selftest, GUARD_VERSION } from './env-self-link-guard.ts'
import type { GuardReport } from './env-self-link-guard.ts'

// ─────────────────────────────────────────────────────────────────────────────
// 沙箱树：一切建/删都在系统临时目录里，仓库工作树一个字节都不动
// ─────────────────────────────────────────────────────────────────────────────

/** 造一棵最小沙箱树：`node_modules/` + `.upstream/<cand>/packages/<组>/<名>`。返回根与清理函数。 */
function sandbox(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'selflink-guard-'))
  mkdirSync(join(root, 'node_modules/@lyapunov'), { recursive: true })
  mkdirSync(join(root, '.upstream/deepseek-harness-test/packages/core/tools'), { recursive: true })
  // 上游里的一个"包目录"（自指链的落点）：物理目录。
  writeFileSync(join(root, '.upstream/deepseek-harness-test/packages/core/tools/package.json'), '{"name":"dsh-tools"}\n')
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** 把 D2 判据的结论压成一行，供断言用（`path -> real`）。 */
function linesOf(r: GuardReport): string[] {
  return r.hits.map((h) => h.path)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) 纯函数层
// ─────────────────────────────────────────────────────────────────────────────

describe('判据函数（内存夹具，不落盘）', () => {
  test('自指链：链解析回自己的父目录 ⇒ D2 命中', () => {
    const g = makeGraph()
    const link = '/x/node_modules/@lyapunov/@lyapunov'
    const parent = '/x/node_modules/@lyapunov'
    g.targets.set(link, parent)
    g.result.set(parent, { real: parent, error: null })
    expect(resolveLink(g, link, '/x')).toEqual({ real: parent, error: null })
  })

  test('反向对照：正向链接（scope 落点 → 上游包目录）不是 D2', () => {
    const g = makeGraph()
    const link: string = '/x/node_modules/@deepseek-ai/x'
    const pkg: string = '/x/.upstream/c/packages/a/b'
    g.targets.set(link, pkg)
    g.result.set(pkg, { real: pkg, error: null })
    const r = resolveLink(g, link, '/x')
    expect(r.real).toBe(pkg)
    expect(r.real).not.toBe('/x/node_modules/@deepseek-ai')
  })

  test('环 ⇒ ELOOP（不是 0、也不是命中）', () => {
    const g = makeGraph()
    g.targets.set('/x/a', '/x/b')
    g.targets.set('/x/b', '/x/a')
    expect(resolveLink(g, '/x/a', '/x')).toEqual({ real: null, error: 'ELOOP' })
  })

  test('断链 ⇒ ENOENT（与"退化"分开）', () => {
    const g = makeGraph()
    g.targets.set('/x/a', '/x/nope')
    expect(resolveLink(g, '/x/a', '/x')).toEqual({ real: null, error: 'ENOENT' })
  })

  test('作用域归属：一个链只算一次（nested node_modules 归 node_modules）', () => {
    expect(scopeOf('node_modules/@lyapunov/@lyapunov')).toBe('node_modules')
    expect(scopeOf('.upstream/.upstream')).toBe('.upstream')
    expect(scopeOf('.upstream/c/packages/core/tools/dsh-tools')).toBe('.upstream')
    expect(scopeOf('.upstream/c/packages/x/node_modules/@deepseek-ai/y/y')).toBe('node_modules')
  })

  test('判据原文就是 P10 用过的 D2（不新造）', () => {
    expect(CRITERION).toBe('realpath(L) === realpath(dirname(L))')
  })

  test('脚本自带 selftest 全过（它是 CLI 的 --selftest 同一份）', () => {
    const rows = selftest()
    expect(rows.length).toBeGreaterThan(5)
    expect(rows.filter((r) => !r.ok)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2) 临时树层：造链 → 报出并点名 → 删链 → 归零
// ─────────────────────────────────────────────────────────────────────────────

describe('临时树上的负对照（造链 / 删链 / 复查）', () => {
  test('零命中时也必须有数字（不是"通过"两个字）', () => {
    const s = sandbox()
    try {
      const r = scan(s.root)
      expect(r.scanOk).toBe(true)
      expect(r.totals.selfReferential).toBe(0)
      expect(r.totals.links).toBeGreaterThanOrEqual(0)
      // 渲染出来的文本里必须带数字，而且必须拦住"环境基本干净"的读法。
      const txt = renderText(r)
      expect(txt).toContain('类 1（自指链）本次 0 条')
      expect(txt).toContain('不等于')
      expect(txt).not.toMatch(/^\s*通过\s*$/m)
    } finally {
      s.cleanup()
    }
  })

  test('造一条自指链 ⇒ 被抓到、点名、数字 +1', () => {
    const s = sandbox()
    try {
      const before = scan(s.root)
      expect(before.totals.selfReferential).toBe(0)

      const link = join(s.root, 'node_modules/@lyapunov/@lyapunov')
      symlinkSync(join(s.root, 'node_modules/@lyapunov'), link, 'dir')

      const after = scan(s.root)
      expect(after.totals.selfReferential).toBe(1)
      expect(linesOf(after)).toContain('node_modules/@lyapunov/@lyapunov')
      const hit = after.hits.find((h) => h.path === 'node_modules/@lyapunov/@lyapunov')!
      expect(hit.selfReferential).toBe(true)
      // 点名要给出两侧 realpath，读的人才能自己复核判据。
      expect(hit.real).toBe(hit.parentReal)
      // 用户看到的那段原文里必须有这条路径。
      expect(renderText(after)).toContain('node_modules/@lyapunov/@lyapunov')
      // 命中时的处置指引必须是"报告不删 + bootstrap 复建"。
      expect(after.remediation.join('\n')).toContain('不自动删')
      expect(after.remediation.join('\n')).toContain('bootstrap')
      expect(after.remediation.join('\n')).toContain('不要逐条')
    } finally {
      s.cleanup()
    }
  })

  test('删掉之后数字归零（不残留、不缓存）', () => {
    const s = sandbox()
    try {
      const link = join(s.root, 'node_modules/@lyapunov/@lyapunov')
      symlinkSync(join(s.root, 'node_modules/@lyapunov'), link, 'dir')
      expect(scan(s.root).totals.selfReferential).toBe(1)

      // 守卫自己**不会**删它（只读）—— 删是调用方的动作，这正是 P10 §5 要求的形状。
      expect(existsSync(link)).toBe(true)
      rmSync(link)

      const after = scan(s.root)
      expect(after.totals.selfReferential).toBe(0)
      expect(linesOf(after)).toEqual([])
    } finally {
      s.cleanup()
    }
  })

  test('守卫绝不删东西：扫完之后链还在（只读性断言）', () => {
    const s = sandbox()
    try {
      const link = join(s.root, 'node_modules/@lyapunov/@lyapunov')
      symlinkSync(join(s.root, 'node_modules/@lyapunov'), link, 'dir')
      const before = readFileSync(join(s.root, '.upstream/deepseek-harness-test/packages/core/tools/package.json'), 'utf8')
      scan(s.root)
      expect(existsSync(link)).toBe(true)
      expect(readFileSync(join(s.root, '.upstream/deepseek-harness-test/packages/core/tools/package.json'), 'utf8')).toBe(before)
      // 沙箱里除了我们自己建的链，不该多出任何东西。
      expect(scan(s.root).totals.links).toBe(1)
    } finally {
      s.cleanup()
    }
  })

  test('作用域分开报：同一个形状落在 .upstream 里就归 .upstream', () => {
    const s = sandbox()
    try {
      // `<包目录>/<包名>`：上游包目录吃下自己的名字 —— P10 台账里的那 21 条同形。
      const pkgDir = join(s.root, '.upstream/deepseek-harness-test/packages/core/tools')
      symlinkSync(pkgDir, join(pkgDir, 'dsh-tools'), 'dir')

      const r = scan(s.root)
      expect(r.totals.selfReferential).toBe(1)
      expect(linesOf(r)).toContain('.upstream/deepseek-harness-test/packages/core/tools/dsh-tools')
      expect(r.scopes.find((x) => x.id === '.upstream')!.selfReferential).toBe(1)
      expect(r.scopes.find((x) => x.id === 'node_modules')!.selfReferential).toBe(0)
    } finally {
      s.cleanup()
    }
  })

  test('扫描根都不存在 ⇒ scanOk=false（无读数，不冒充 0）', () => {
    const r = scan(join(tmpdir(), 'selflink-guard-does-not-exist-0000'))
    expect(r.scanOk).toBe(false)
    expect(r.scopes.every((s) => !s.exists)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3) 接线层：release-gate 能吃到守卫的 --json，且两类数字都进 metrics
// ─────────────────────────────────────────────────────────────────────────────

describe('release-gate 接线', () => {
  test('parseSelfLinkGuard：吃下真守卫的 --json，两类数字都在', () => {
    const s = sandbox()
    try {
      const pkgDir = join(s.root, '.upstream/deepseek-harness-test/packages/core/tools')
      symlinkSync(pkgDir, join(pkgDir, 'dsh-tools'), 'dir')
      const script = join(import.meta.dir, 'env-self-link-guard.ts')
      const r = spawnSync(process.execPath, ['run', script, '--root', s.root, '--json'], { encoding: 'utf8', cwd: import.meta.dir })
      expect(r.status).toBe(0)
      const g = parseSelfLinkGuard(r.stdout, r.status)
      expect(g).not.toBeNull()
      expect(g!.scanOk).toBe(true)
      expect(g!.selfReferential).toBe(1)
      expect(g!.hits).toContain('.upstream/deepseek-harness-test/packages/core/tools/dsh-tools')
      // 类 2 是"遍历"读数：沙箱里 `find -L` 必须真的把这条自指链报成环（否则类 2 就没在量东西）。
      expect(g!.grid.some((x) => x.cycleDiagnosticLines > 0)).toBe(true)
    } finally {
      s.cleanup()
    }
  })

  test('parseSelfLinkGuard：不是守卫的输出 ⇒ null（无读数，不退回猜）', () => {
    expect(parseSelfLinkGuard('', 0)).toBeNull()
    expect(parseSelfLinkGuard('{"tool":"something-else","totals":{}}', 0)).toBeNull()
    expect(parseSelfLinkGuard('not json at all', 0)).toBeNull()
  })

  test('evalSelfLinkCriterion：有读数 ⇒ GREEN，且 metrics 里两类数字都在、点名到路径', () => {
    const s = sandbox()
    try {
      const pkgDir = join(s.root, '.upstream/deepseek-harness-test/packages/core/tools')
      symlinkSync(pkgDir, join(pkgDir, 'dsh-tools'), 'dir')
      const script = join(import.meta.dir, 'env-self-link-guard.ts')
      const run1 = run(process.execPath, ['run', script, '--root', s.root, '--json'], import.meta.dir, 120_000)
      const c = evalSelfLinkCriterion(run1.out, run1.code, run1.ms, run1.capture)
      expect(c.id).toBe('env-self-link-guard')
      expect(c.status).toBe('GREEN')
      // 类 1 的数字
      expect(c.metrics.selfReferential).toBe(1)
      // 类 2 的数字（环诊断行数）—— 两个数少一个就会得出相反的结论。
      expect(c.metrics.gridRoots).toBeGreaterThan(0)
      expect(Number(c.metrics.gridDiagnostics)).toBeGreaterThan(0)
      // 命中要点名到路径，并且必须写明"不自动删"。
      expect(c.findings.some((f) => f.includes('dsh-tools') && f.includes('不自动删'))).toBe(true)
      // 豁免是**明面上**的（不是静默通过）。
      expect(c.waivers.length).toBeGreaterThan(0)
    } finally {
      s.cleanup()
    }
  })

  test('evalSelfLinkCriterion：解不开的读数 ⇒ UNPROVEN（不冒充"没有退化链接"）', () => {
    const c = evalSelfLinkCriterion('boom', 1, 5, 'pipe')
    expect(c.status).toBe('UNPROVEN')
    expect(c.findings.join('\n')).toContain('无读数')
  })

  test('命中不退门（环境读数 ≠ 产品缺陷），但 --strict 会 exit 1', () => {
    const s = sandbox()
    try {
      const pkgDir = join(s.root, '.upstream/deepseek-harness-test/packages/core/tools')
      symlinkSync(pkgDir, join(pkgDir, 'dsh-tools'), 'dir')
      const script = join(import.meta.dir, 'env-self-link-guard.ts')
      const normal = spawnSync(process.execPath, ['run', script, '--root', s.root], { encoding: 'utf8', cwd: import.meta.dir })
      expect(normal.status).toBe(0)
      const strict = spawnSync(process.execPath, ['run', script, '--root', s.root, '--strict'], { encoding: 'utf8', cwd: import.meta.dir })
      expect(strict.status).toBe(1)
    } finally {
      s.cleanup()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4) 边界登记：NOT_COVERED 必须说得出"我没做什么"
// ─────────────────────────────────────────────────────────────────────────────

describe('边界与版本', () => {
  test('schema 版本与判据原文都进了 JSON（读数自带身份）', () => {
    const s = sandbox()
    try {
      const r = scan(s.root)
      expect(r.schema).toBe(GUARD_VERSION)
      expect(r.criterion).toBe(CRITERION)
      expect(r.readOnly).toBe(true)
    } finally {
      s.cleanup()
    }
  })

  test('NOT_COVERED 非空，且每条都写明"不做"', () => {
    expect(NOT_COVERED.length).toBeGreaterThanOrEqual(4)
    expect(NOT_COVERED.join('\n')).toContain('不自动删')
  })

  test('零命中时的指引带数字（悬空链数也进文字）', () => {
    const rem = buildRemediation({ links: 3, selfReferential: 0, dangling: 5 })
    expect(rem[0]).toContain('0')
    expect(rem.join('\n')).toContain('5')
  })
})
