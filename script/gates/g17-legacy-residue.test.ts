/**
 * DEV-027 F17 负对照（N233）：`legacy_owner_residue_readonly` 从常量 `ok:true` 改成真判据后，
 * 必须**有失败能力**——构造"生产路径里出现旧 owner 名字"的夹具 ⇒ 判据必须不为 ok:true。
 *
 * 这条单测只钉判据本身（纯函数），门内的真实读数由 `--gate G17` 的干净树检索提供；
 * 不用"总门通过"代替单条证据。
 */
import { describe, expect, test } from "bun:test"
import { allowedProductionResidue, documentedLegacyCompatExceptions, LEGACY_OWNER_PATTERNS, legacyResidueVerdict, probeOutcome } from "./g17.ts"

describe("G17 旧 owner 残留判据（F17）", () => {
  test("负对照：生产路径出现未预期的旧 owner 命中 ⇒ ok:false 并列出该路径", () => {
    const verdict = legacyResidueVerdict([
      "packages/lyapunov-shell/src/preferences-theme-sources/opencode.json",
      "packages/lyaup-migrations/src/index.ts",
      "packages/lyapunov-shell/src/legacy-opencode-bridge.ts",
    ])
    expect(verdict.ok).toBe(false)
    expect(verdict.unexpected).toEqual(["packages/lyapunov-shell/src/legacy-opencode-bridge.ts"])
  })

  test("只有允许集内的生产命中（主题来源标记 + 迁移器读码）⇒ ok:true", () => {
    const verdict = legacyResidueVerdict([
      "packages/lyapunov-shell/src/preferences-theme-sources/opencode.json",
      "packages/lyaup-migrations/src/index.ts",
    ])
    expect(verdict.ok).toBe(true)
    expect(verdict.unexpected).toEqual([])
  })

  test("零生产命中 ⇒ ok:true（与干净树无残留一致）", () => {
    expect(legacyResidueVerdict([]).ok).toBe(true)
  })

  test("允许集判定逐条可读：主题来源/迁移器为真，其它生产路径为假", () => {
    expect(allowedProductionResidue("packages/lyapunov-shell/src/preferences-theme-sources/opencode.json")).toBe(true)
    expect(allowedProductionResidue("packages/lyaup-migrations/src/json-source.ts")).toBe(true)
    expect(allowedProductionResidue("packages/lyapunov-shell/src/plugin.ts")).toBe(false)
    expect(allowedProductionResidue("packages/scene-kit/src/SceneBridge.ts")).toBe(false)
  })
})

// ── N238 Round 4：两条 11 残留的处置机制 ─────────────────────────────────────────
describe("G17 残留判据的收窄与明文例外（N238 Round 4）", () => {
  const opencodePattern = LEGACY_OWNER_PATTERNS.find(probe => probe.owner.includes("opencode-session-loop"))!.pattern

  test("误报收窄：主题数据 id 与注释不再命中 opencode 组，真实平台引用仍命中", () => {
    const pattern = new RegExp(opencodePattern)
    // 11 条残留里的两条误报原文（preferences-theme-data.ts:2854 / workbench-style.ts:121）
    expect(pattern.test('    "id": "opencode",')).toBe(false)
    expect(pattern.test("/* 小节头：小字 uppercase 弱色标签 + 右侧计数/状态（opencode 小节头语义，无窗口标题栏）。 */")).toBe(false)
    // 真实退役平台引用必须仍被抓住（否则收窄就成了放行）
    expect(pattern.test('import { Server } from "@opencode/server-sdk"')).toBe(true)
    expect(pattern.test("packages/opencode/src/session/processor.ts")).toBe(true)
    expect(pattern.test('opencode-local.db')).toBe(true)
  })

  test("明文例外：已登记路径进 exceptions、不进 unexpected（计数行与通过判据分开）", () => {
    const paths = documentedLegacyCompatExceptions.map(entry => entry.path)
    // 条数写死是**故意的**：防止有人整类放行式地扩白名单。曾在 2026-09-26 由 9 → 6：
    // services/lyapunov-api/src/{app,config,identity}.ts 三条随服务端源码移出本仓库
    // （归 LyapunovOM backend/dev-server/），本门只扫产品面，故不再登记它们。
    expect(paths.length).toBe(6)
    const verdict = legacyResidueVerdict([...paths, "packages/lyapunov-migrations-check/src/other.ts"])
    expect(verdict.exceptions).toEqual([...paths].sort())
    expect(verdict.unexpected).toEqual(["packages/lyapunov-migrations-check/src/other.ts"])
    expect(verdict.ok).toBe(false)
  })

  test("负对照（真残留）：未登记的旧 owner 生产命中 ⇒ 必须 FAIL", () => {
    const verdict = legacyResidueVerdict(["packages/lyapunov-shell/src/legacy-opencode-bridge.ts"])
    expect(verdict.ok).toBe(false)
    expect(verdict.exceptions).toEqual([])
  })

  test("例外清单每条都有理由与依据（不许整类放行）", () => {
    for (const entry of documentedLegacyCompatExceptions) {
      expect(entry.reason.length).toBeGreaterThan(8)
      expect(entry.evidence).toMatch(/:\d+/)
    }
  })
})

// ── W24（2026-09-26）：探针**执行错误**必须显式失败，不得折算成"0 命中" ──────────────
describe("G17 残留探针的退出码判定（W24）", () => {
  test("退出码 0 ⇒ 有命中（stdout 逐行作为路径）", () => {
    const outcome = probeOutcome(0, "packages/a/src/x.ts\npackages/b/src/y.ts\n", "")
    expect(outcome.ok).toBe(true)
    expect(outcome.paths).toEqual(["packages/a/src/x.ts", "packages/b/src/y.ts"])
  })

  test("退出码 1 ⇒ 无命中，属正常读数（不是错误）", () => {
    const outcome = probeOutcome(1, "", "")
    expect(outcome.ok).toBe(true)
    expect(outcome.paths).toEqual([])
  })

  test("负对照：非 0/1 退出码（正则无效）⇒ ok:false 且带回 stderr 原文", () => {
    const broken = probeOutcome(128, "", "fatal: -e option, 'opencode[-/.](?:server…)': 前面的正则表达式无效")
    expect(broken.ok).toBe(false)
    expect(broken.paths).toEqual([])
    expect(broken.error).toContain("正则表达式无效")

    // 空 stderr 也不能静默通过：仍然 ok:false，并报出退出码。
    const silent = probeOutcome(2, "", "")
    expect(silent.ok).toBe(false)
    expect(silent.error).toContain("退出码=2")

    // spawn 失败（exit=null）同样算执行错误。
    expect(probeOutcome(null, "", "").ok).toBe(false)
  })

  test("探针模式必须用 PCRE 语法时不得退回 POSIX ERE（第一组含 `(?:…)`）", () => {
    const opencodePattern = LEGACY_OWNER_PATTERNS.find(probe => probe.owner.includes("opencode-session-loop"))!.pattern
    // 该组只有在 PCRE 下才合法：POSIX ERE 会报"正则表达式无效"（g17 已改用 `git grep -P`）。
    expect(opencodePattern).toContain("(?:")
    expect(new RegExp(opencodePattern).test('import { Server } from "@opencode/server-sdk"')).toBe(true)
  })
})
