/**
 * 负对照统一口径库（`script/negative-controls/` 的共用件）
 *
 * 口径来源：`bugfixHistory/NEGATIVE-CONTROL-NOOP-SWEEP-20260926.md` §4（八条），
 * 已由 Lead 采纳为规矩（`docs/REMAINING_WORK_PLAN.md` §五 负对照纪律）。
 *
 * 它替每个驱动强制八件事：
 *   ① 每个变异断言**命中次数恰好 1**；0 或 ≥2 ⇒ 拒绝执行该变异，脚本非零退出（不许 `|| true`）
 *   ② 跑之前打印**目标文件 sha256**（同一行给路径 + 字节数）
 *   ③ no-op 判据 = **目标文件在它跑的那一版里命中 0**（禁止用"某处 grep 得到"当命中证据）
 *   ④ **一次运行一行读数**：每个读数自带同一次运行的 pass/fail/expect + 变红用例名
 *   ⑤ 跑的那一版 = 交付版（sha256 锚定；跑完复核）
 *   ⑥ 只做"去掉/还原"：变异只碰**产品代码**，用例一个字不动（本库不提供"删断言"的入口）
 *   ⑦ 负对照脚本**进库**（本目录即落点；不依赖 `.runtime/**`）
 *   ⑧ 跑完打印 `逐字节还原：一致 ✓`，并做收尾复跑（还原后必须回到基线）
 *
 * **不提供的入口（有意）**：修改测试文件、放宽判据、跳过用例。本库只有"改产品代码 → 期望精确变红 → 逐字节还原"。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const ROOT = '/home/s18/WS/Lyapunov/Dev'

export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export interface CaseReading {
  pass: number
  fail: number
  expect: number
  failed: string[]
  exit: number
  ms: number
}

export interface Mutation {
  /** 变异名（会原样打进读数行） */
  name: string
  /** 目标文件（仓库相对路径） */
  file: string
  /** 锚点（**交付版里的字面量**） */
  from: string
  /** 还原成什么（"改前"的形状） */
  to: string
  /** 必须变红的用例名**片段**（每片段至少命中一条） */
  expect: string[]
  /** 该变异**应当**变红的用例条数（不写 = expect.length）。写它才算"只红不看红在哪，等于没证"的反面 */
  expectCount?: number
}

export interface Target {
  /** 目标文件（仓库相对路径） */
  file: string
  /** 该变异跑哪条用例（仓库相对路径；只跑聚焦用例） */
  test: string
  /** 用例执行器：`bun:test` ⇒ `bun --no-env-file test <file>`；`plain` ⇒ `bun --no-env-file <file>` */
  runner?: 'bun:test' | 'plain'
}

/** 跑一条用例，解析 bun 的读数（只认同一次运行的 stdout+stderr）。 */
export function runCase(rel: string, runner: 'bun:test' | 'plain' = 'bun:test'): CaseReading {
  const argv = runner === 'plain' ? [process.execPath, '--no-env-file', rel] : [process.execPath, '--no-env-file', 'test', rel]
  const t0 = Date.now()
  const proc = Bun.spawnSync(argv, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
  const text = proc.stdout.toString() + proc.stderr.toString()
  const num = (re: RegExp, fallback = -1) => Number(re.exec(text)?.[1] ?? fallback)
  // bun 把失败打印两遍（用例行 + 收尾汇总）⇒ 去重。
  const failed = [...new Set([...text.matchAll(/^\(fail\)\s*(.+?)(?:\s*\[\d+(?:\.\d+)?ms\])?$/gm)].map((m) => m[1]!.trim()))]
  return {
    pass: num(/^\s*(\d+) pass$/m),
    fail: num(/^\s*(\d+) fail$/m, 0),
    expect: num(/^\s*(\d+) expect\(\) calls$/m, 0),
    failed,
    exit: proc.exitCode ?? -1,
    ms: Date.now() - t0,
  }
}

class Restorer {
  private readonly saved = new Map<string, string>()
  register(abs: string, text: string): void {
    this.saved.set(abs, text)
  }
  restoreAll(): boolean {
    let ok = true
    for (const [abs, text] of this.saved) {
      writeFileSync(abs, text)
      if (sha256(readFileSync(abs, 'utf8')) !== sha256(text)) ok = false
    }
    return ok
  }
  paths(): string[] {
    return [...this.saved.keys()]
  }
}

/**
 * 跑一组变异。返回 true = 全部符合期望且逐字节还原。
 * 打印的每一行读数格式见 README「读数行」一节。
 */
export function runNegativeControl(title: string, targets: Target[], mutations: readonly Mutation[]): boolean {
  console.log(`# ${title}`)
  const restorer = new Restorer()
  const pristine = new Map<string, string>()
  for (const t of targets) {
    const abs = resolve(ROOT, t.file)
    if (!existsSync(abs)) {
      console.log(`ABORT: 目标文件不在盘上：${t.file}`)
      process.exit(3)
    }
    const text = readFileSync(abs, 'utf8')
    restorer.register(abs, text)
    pristine.set(t.file, text)
    console.log(`# 目标 sha256 ${t.file} ${sha256(text)} bytes=${Buffer.byteLength(text)}`)
  }
  let cleanExit = false
  const cleanup = () => {
    if (cleanExit) return
    const ok = restorer.restoreAll()
    console.log(`# 中断清理：逐字节还原：${ok ? '一致 ✓' : '不一致 ✗✗✗'}`)
  }
  process.on('SIGINT', () => {
    cleanup()
    process.exit(130)
  })
  process.on('uncaughtException', (e) => {
    cleanup()
    console.log(`ABORT: ${String(e)}`)
    process.exit(3)
  })

  // 变异只声明"改哪个产品文件"；跑哪条用例由 `targets` 里该文件的登记决定
  // （这里**不许**让变异自带测试路径 —— 那条路会让"跑错文件"变成静默的空读数）。
  const testOf = (file: string): string => {
    const t = targets.find((x) => x.file === file)
    if (!t) throw new Error(`变异指向未登记的目标文件：${file}`)
    return t.test
  }
  const runnerOf = (file: string) => targets.find((t) => t.test === file)?.runner ?? 'bun:test'
  const testFiles = [...new Set(targets.map((t) => t.test))]

  // 基线：交付版必须**全绿**（否则"变红"没有信息量）
  const base = testFiles.map((f) => ({ f, r: runCase(f, runnerOf(f)) }))
  const baseOk = base.every(({ f, r }) => r.fail === 0 && r.exit === 0)
  for (const { f, r } of base) {
    console.log(`BASELINE test=${f} pass=${r.pass} fail=${r.fail} expect=${r.expect} exit=${r.exit} ${r.ms}ms` + (r.fail === 0 && r.exit === 0 ? '' : '  ← 交付版自己就不是全绿：下面的"变红"不可信'))
  }
  let ok = baseOk

  for (const m of mutations) {
    const before = pristine.get(m.file)!
    const hits = before.split(m.from).length - 1
    if (hits !== 1) {
      // ① 0 或 ≥2 一律拒绝执行，且判失败（非零退出）
      console.log(`MUTATION ${m.name} file=${m.file} 命中次数=${hits}（要求恰好 1）⇒ 拒绝执行 REFUSE`)
      ok = false
      continue
    }
    const abs = resolve(ROOT, m.file)
    const shaBefore = sha256(before)
    try {
      writeFileSync(abs, before.replace(m.from, m.to))
      const test = testOf(m.file)
      const r = runCase(test, runnerOf(test))
      const want = m.expectCount ?? m.expect.length
      const hitAll = m.expect.every((frag) => r.failed.some((n) => n.includes(frag)))
      const exact = r.failed.length === want && hitAll
      if (!exact || r.fail === 0) ok = false
      // ④ 一次运行一行读数（这一行自带同一次运行的三个数与变红用例名）
      console.log(
        `MUTATION ${m.name} file=${m.file} 目标sha256=${shaBefore} 命中次数=1 ` +
          `pass=${r.pass} fail=${r.fail} expect=${r.expect} exit=${r.exit} ${r.ms}ms ` +
          `变红用例(${r.failed.length})[${r.failed.join(' | ')}] 期望组命中=${m.expect.filter((frag) => r.failed.some((n) => n.includes(frag))).length}/${m.expect.length} ` +
          `期望条数=${want} ${exact ? 'MATCH ✓' : 'MISMATCH ✗'}`,
      )
    } finally {
      const restored = restorer.restoreAll()
      // ⑧ 逐字节还原（同一 sha256）
      console.log(`  逐字节还原：${restored && sha256(readFileSync(abs, 'utf8')) === shaBefore ? '一致 ✓' : '不一致 ✗✗✗'} (${m.file})`)
      if (!restored) ok = false
    }
  }

  // 收尾复跑：还原后必须回到基线
  for (const { f, r } of base) {
    const after = runCase(f, runnerOf(f))
    const same = after.pass === r.pass && after.fail === r.fail && after.expect === r.expect
    console.log(`AFTER test=${f} pass=${after.pass} fail=${after.fail} expect=${after.expect} exit=${after.exit} ${after.ms}ms ${same ? '回到基线 ✓' : '未回到基线 ✗'}`)
    if (!same) ok = false
  }
  cleanExit = true
  const finalOk = restorer.restoreAll()
  console.log(`# 终态逐字节还原：${finalOk ? '一致 ✓' : '不一致 ✗✗✗'}`)
  console.log(ok && finalOk ? `RESULT ${title} 全部变异按期望精确变红，且逐字节还原 ✓` : `RESULT ${title} 有变异不符合期望 ✗`)
  return ok && finalOk
}
