/**
 * CCMM-07：CI 行为入口 `script/test-ci.ts` 自己的判据。
 *
 * 只测 harness 的**分类与失败传播**，不重跑产品用例：引号/扩展名全谱识别、"发现到但没审过"
 * 的 fail-closed、不跑 ≠ 通过 的理由、以及子进程真实非 0 退出码不被吞。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MAX_ENTRY_TIMEOUT_MS,
  SAFE_DEFAULT_REASON,
  classifyMarkers,
  detectDeclaredRunner,
  effectiveTimeoutMs,
  executorProblem,
  findMissingIncluded,
  findUnclassified,
  homeCandidates,
  isTestLikeName,
  parseCounts,
  parseImportSpecifiers,
  resolveBun,
  resolvePython,
  runEntry,
  timeoutProblems,
  whichBun,
} from "./test-ci.ts"

const root = process.cwd()
const originalTestciBun = process.env.TESTCI_BUN

beforeAll(() => {
  process.env.TESTCI_BUN ||= process.execPath
})

afterAll(() => {
  if (originalTestciBun === undefined) delete process.env.TESTCI_BUN
  else process.env.TESTCI_BUN = originalTestciBun
})

describe("测试执行器环境覆盖", () => {
  test("TESTCI_BUN/TESTCI_PYTHON 优先，空值不再回退成名字 `bun`", () => {
    expect(resolveBun({ TESTCI_BUN: "/opt/tooling/bun" })).toBe("/opt/tooling/bun")
    expect(resolvePython("/definitely/missing-root", { TESTCI_PYTHON: "/opt/tooling/python" })).toBe("/opt/tooling/python")
    expect(resolvePython("/definitely/missing-root", { TESTCI_PYTHON: "  " })).toBe("python3")
  })
})

/**
 * NESTED-BUN-127：执行器解析**不许依赖调用方 shell 的 PATH**。
 *
 * 为什么这条要有自己的用例：改前 `resolveBun()` 是 `env.TESTCI_BUN?.trim() || 'bun'` —— 一个
 * 与 PATH 无关的分支都没有。bun 不在 PATH 时（非登录 shell 的常态：node 在 PATH、bun 不在）
 * `spawn('bun')` 得到 ENOENT，而 harness 旧代码把它记成 `exitCode 127`、报告里写成
 * 「真实非 0 退出码 127」⇒ 假红 + 判据说假话。下面每条钉一个分支，或钉"返回值不是名字"本身。
 */
describe("执行器解析：与调用方 shell 的 PATH 无关（NESTED-BUN-127）", () => {
  /** 造一个真能执行的 `bun`（内容无所谓，判据只看"能不能解析出绝对路径"）。 */
  async function fakeBunAt(file: string) {
    await mkdir(join(file, ".."), { recursive: true })
    await writeFile(file, "#!/bin/sh\nexit 0\n")
    await chmod(file, 0o755)
  }

  test("① TESTCI_BUN 优先；② execPath 就是 bun ⇒ 返回 execPath", () => {
    expect(resolveBun({ TESTCI_BUN: "/opt/tooling/bun" }, "/usr/bin/node", null)).toBe("/opt/tooling/bun")
    expect(resolveBun({}, "/home/dev/.bun/bin/bun", "/nonexistent")).toBe("/home/dev/.bun/bin/bun")
    expect(resolveBun({}, "C:\\Users\\dev\\.bun\\bin\\bun.exe", "Z:\\nope")).toBe("C:\\Users\\dev\\.bun\\bin\\bun.exe")
  })

  test("③ PATH 上有真 bun ⇒ 返回它的绝对路径（纯查找，不起子进程）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "testci-which-"))
    try {
      const bin = join(dir, "bun")
      await fakeBunAt(bin)
      expect(whichBun(dir)).toBe(bin)
      expect(resolveBun({ PATH: dir }, "/usr/bin/node", null)).toBe(bin)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("③ 的反面：同名但不可执行的文件**不算**执行器（否则会起一个假货）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "testci-which-noexec-"))
    try {
      await writeFile(join(dir, "bun"), "not executable\n")
      await chmod(join(dir, "bun"), 0o644)
      expect(whichBun(dir)).toBeNull()
      expect(resolveBun({ PATH: dir }, "/usr/bin/node", null)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("④ HOME 与 passwd 库两种 home 都能兜住 ~/.bun/bin/bun（env -i 下 HOME 是空的）", async () => {
    const empty = await mkdtemp(join(tmpdir(), "testci-empty-path-"))
    const home = await mkdtemp(join(tmpdir(), "testci-home-"))
    try {
      const bun = join(home, ".bun/bin/bun")
      await fakeBunAt(bun)
      // HOME 在：走 env.HOME
      expect(resolveBun({ PATH: empty, HOME: home }, "/usr/bin/node", null)).toBe(bun)
      // HOME 缺（`env -i` 的常态）：靠 passwd 库那条兜住 —— 这正是门那边 bunBin() 只用 $HOME 会漏掉的一格
      expect(resolveBun({ PATH: empty }, "/usr/bin/node", home)).toBe(bun)
      expect(homeCandidates({ PATH: empty }, home)).toEqual([home])
    } finally {
      await rm(empty, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  test("⑤ 负对照：四路都认不出 ⇒ 返回 null，**不许返回名字 `bun`**", async () => {
    const empty = await mkdtemp(join(tmpdir(), "testci-empty2-"))
    try {
      // 改前这里返回的是 'bun' —— 然后 spawn('bun') 得到 ENOENT/127，被读成"用例失败"。
      const got = resolveBun({ PATH: empty }, "/usr/bin/node", "/nonexistent-home")
      expect(got).toBeNull()
      expect(got).not.toBe("bun")
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  test("executorProblem：配置错/认不出 ⇒ 点名（不是跳过）；非 js 条目不受影响", () => {
    const saved = process.env.TESTCI_BUN
    try {
      const jsEntry = { path: "a.test.ts", declaredRunner: "bun:test" as const, markers: [], decision: "include" as const, reason: "x" }
      const pyEntry = { path: "test_a.py", declaredRunner: "python" as const, markers: [], decision: "include" as const, reason: "x" }
      // 指向不存在的绝对路径 = 执行器配置错（真实 spawn 之前就点名）
      process.env.TESTCI_BUN = "/definitely/missing/bun"
      expect(executorProblem([jsEntry])).toContain("TESTCI_BUN 指向的执行器在磁盘上不存在")
      expect(executorProblem([{ ...jsEntry, decision: "exclude" }])).toBeNull()
      expect(executorProblem([pyEntry])).toBeNull()
      // 当前进程的 execPath 就是 bun ⇒ 分支② 命中 ⇒ 无问题（这正是 CI / 门 / `bun run …` 走的那条）
      delete process.env.TESTCI_BUN
      expect(executorProblem([jsEntry])).toBeNull()
    } finally {
      if (saved === undefined) delete process.env.TESTCI_BUN
      else process.env.TESTCI_BUN = saved
    }
  })

  test("runEntry：起不来执行器时点名「起不了执行器」，**不许**谎报 `真实非 0 退出码 127`", async () => {
    const dir = await mkdtemp(join(tmpdir(), "testci-noexec-"))
    const saved = process.env.TESTCI_BUN
    try {
      await writeFile(join(dir, "ok.test.ts"), `import { test } from "bun:test"\ntest("ok", () => {})\n`)
      process.env.TESTCI_BUN = "/definitely/missing/bun"
      const r = await runEntry(
        { path: "ok.test.ts", declaredRunner: "bun:test", markers: [], decision: "include", reason: "sample" },
        dir,
        30_000,
      )
      // 这一格真的起了一次进程并拿到 ENOENT：判据必须是"起不了执行器"，不是"用例失败"
      expect(r.status).toBe("fail") // fail-closed：不是 pass，也不是 skip
      expect(r.status).not.toBe("skip")
      expect(r.exitCode).toBeNull() // 没起得来 ⇒ 没有退出码（旧代码谎报 127）
      expect(r.reason).toContain("起不了执行器")
      expect(r.reason).not.toContain("真实非 0 退出码")
    } finally {
      if (saved === undefined) delete process.env.TESTCI_BUN
      else process.env.TESTCI_BUN = saved
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("发现规则：双单引号与扩展名全谱", () => {
  test("isTestLikeName 认 .ts/.tsx/.mts/.js/.mjs/.py 全谱", () => {
    for (const p of [
      "packages/x/test/a.test.ts",
      "packages/x/test/a.test.tsx",
      "packages/x/test/a.test.mts",
      "packages/x/test/a.test.js",
      "packages/x/test/a.spec.mjs",
      "packages/x/test/a.smoke.ts",
      "packages/x/python/test_worker_protocol.py",
      "packages/x/python/world_test.py",
    ]) {
      expect(isTestLikeName(p), p).toBe(true)
    }
    for (const p of ["packages/x/src/a.ts", "packages/x/test/helper.ts", "packages/x/test/fixture.json", "script/build-plugins.ts"]) {
      expect(isTestLikeName(p), p).toBe(false)
    }
  })

  test("parseImportSpecifiers 双引号/单引号/反引号都抽得到（只认一种会漏一半）", () => {
    const specs = parseImportSpecifiers([
      `import { test } from "bun:test"`,
      `import { test } from 'node:test'`,
      `const t = require(\`node:test\`)`,
      `import x from 'unrelated'`,
    ].join("\n"))
    expect(specs).toContain("bun:test")
    expect(specs).toContain("node:test")
    expect(specs).toContain("unrelated")
  })

  test("detectDeclaredRunner：声明 API / .py / 无 runner 脚本", () => {
    expect(detectDeclaredRunner(`import { test } from 'bun:test'`, "a.test.ts")).toBe("bun:test")
    expect(detectDeclaredRunner(`import { test } from "node:test"`, "a.test.ts")).toBe("node:test")
    expect(detectDeclaredRunner(`import numpy as np`, "test_worker_protocol.py")).toBe("python")
    // 无 runner import ⇒ plain 脚本（自行 main，退出码即结果）
    expect(detectDeclaredRunner(`export default function main() {}`, "x.smoke.ts")).toBe("plain")
    // 反引号形态同样要认成 node:test，否则会被误当 plain
    expect(detectDeclaredRunner("const t = require(`node:test`)", "a.test.ts")).toBe("node:test")
  })
})

describe("安全默认：不跑 ≠ 通过", () => {
  test("无标记 ⇒ include，理由是默认安全集合", () => {
    const r = classifyMarkers([])
    expect(r.decision).toBe("include")
    expect(r.reason).toBe(SAFE_DEFAULT_REASON)
  })

  test("realmodel/net_fetch ⇒ exclude 且带 not-run 理由", () => {
    const r = classifyMarkers(["net_fetch", "realmodel"])
    expect(r.decision).toBe("exclude")
    expect(r.reason).toContain("not-run")
    expect(r.reason).toContain("realmodel")
    expect(r.reason).toContain("net_fetch")
  })

  test("未知标记按不安全处理（fail-closed，不假装绿）", () => {
    const r = classifyMarkers(["unheard-of"])
    expect(r.decision).toBe("exclude")
    expect(r.reason).toContain("未知标记 unheard-of")
  })
})

describe("结果计数：不吞失败", () => {
  test("parseCounts 认 bun 的 `N pass/fail/skip` 与 TAP 的 `# pass N`", () => {
    expect(parseCounts(" 3 pass\n 1 fail\n 2 skip\n")).toEqual({ pass: 3, fail: 1, skip: 2 })
    expect(parseCounts("# pass 4\n# fail 0\n# skipped 5\n")).toEqual({ pass: 4, fail: 0, skip: 5 })
  })
})

describe("失败传播与 fail-closed 分类", () => {
  test("所有 Bun 子进程禁止自动加载工作目录 dotenv", async () => {
    const dir = await mkdtemp(join(tmpdir(), "testci-dotenv-"))
    const key = `TESTCI_SYNTHETIC_DOTENV_${Date.now()}`
    try {
      await writeFile(join(dir, ".env"), `${key}=public-fixture-only\n`)
      const files = [
        { path: "plain.smoke.ts", declaredRunner: "plain" as const, text: `if (process.env[${JSON.stringify(key)}] !== undefined) process.exit(9)\n` },
        { path: "bun.test.ts", declaredRunner: "bun:test" as const, text: `import {test, expect} from 'bun:test'\ntest('no dotenv', () => expect(process.env[${JSON.stringify(key)}]).toBeUndefined())\n` },
        { path: "node.test.ts", declaredRunner: "node:test" as const, text: `import {test} from 'node:test'\nimport assert from 'node:assert/strict'\ntest('no dotenv', () => assert.equal(process.env[${JSON.stringify(key)}], undefined))\n` },
      ]
      for (const file of files) {
        await writeFile(join(dir, file.path), file.text)
        const result = await runEntry({ ...file, markers: [], decision: "include", reason: "synthetic dotenv fixture" }, dir, 30_000)
        expect(result.status).toBe("pass")
        expect(result.exitCode).toBe(0)
        expect(result.command).toContain("--no-env-file")
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("失败用例经真实子进程跑完 ⇒ status=fail 且带真实退出码", async () => {
    const dir = await mkdtemp(join(tmpdir(), "testci-"))
    const file = join(dir, "boom.test.ts")
    await writeFile(file, `import { expect, test } from "bun:test"\ntest("boom", () => { expect(1).toBe(2) })\n`)
    const r = await runEntry(
      { path: file, declaredRunner: "bun:test", markers: [], decision: "include", reason: "sample" },
      root,
      30_000,
    )
    expect(r.status).toBe("fail")
    expect(r.exitCode).not.toBe(0)
    expect(r.reason).toContain("真实非 0 退出码")
    await rm(dir, { recursive: true, force: true })
  })

  test("plain 脚本退出码非 0 同样传播成 fail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "testci-"))
    const file = join(dir, "boom.smoke.ts")
    await writeFile(file, `process.exit(3)\n`)
    const r = await runEntry(
      { path: file, declaredRunner: "plain", markers: [], decision: "include", reason: "sample" },
      root,
      30_000,
    )
    expect(r.status).toBe("fail")
    expect(r.exitCode).toBe(3)
    await rm(dir, { recursive: true, force: true })
  })

  test("发现规则扫到、清单没有的文件被点名（不许顺手跑绿）", async () => {
    // 布局照真仓：发现规则只看 packages/*/test 等根（根外文件不在它的职责内）。
    const dir = await mkdtemp(join(tmpdir(), "testci-"))
    const testDir = join(dir, "packages/demo/test")
    await mkdir(testDir, { recursive: true })
    await writeFile(join(testDir, "unreviewed.test.ts"), `import { test } from "bun:test"\ntest("x", () => {})\n`)
    const found = await findUnclassified(dir, new Set<string>())
    expect(found).toContain("packages/demo/test/unreviewed.test.ts")
    const stillOpen = await findUnclassified(dir, new Set(["packages/demo/test/unreviewed.test.ts"]))
    expect(stillOpen).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })
})

/**
 * CCMM-09 反例：**已纳入**（`decision=include`）的测试文件缺失时，CI 必须失败。
 *
 * 前态缺陷（主控已复现）：这种条目被记成 `skip` 并让 harness 退出 0——"说要跑、又没得跑"被当成
 * "不跑所以没红"，CI 假通过。判据有三条，缺一条就等于没修：
 *   ① 记账分开：`status=missing`（配置错误）而不是 `skip`（有意不跑）；
 *   ② 点名文件：`MISSING` 行写出是哪一个，`--list` 与 run 模式都有；
 *   ③ 退出码 2，且 **`--filter` 盖不住**（存在性看的是整个纳入集，不是本次子集）。
 * exclude 条目不在此列：有意不跑是清单说清楚了的，与"该跑的不在"两回事。
 */
describe("已纳入文件缺失必须失败（CCMM-09）", () => {
  const entry = (path: string, decision: "include" | "exclude" = "include") => ({
    path,
    declaredRunner: "bun:test" as const,
    markers: [],
    decision,
    reason: decision === "include" ? "无外部标记" : "not-run：样本",
  })

  test("runEntry：纳入缺件记 missing（不是 skip），并点名文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "testci-missing-"))
    const path = join(dir, "packages/demo/test/missing.test.ts")
    const r = await runEntry(entry(path), dir, 30_000)
    expect(r.status).toBe("missing")
    expect(r.status).not.toBe("skip")
    expect(r.reason).toContain("清单里有、磁盘上没有")
    expect(r.reason).toContain("missing.test.ts")
    // 缺件不是"跑过了但结果是 skip"：它根本没起进程，退出码无从谈起
    expect(r.exitCode).toBeNull()
    await rm(dir, { recursive: true, force: true })
  })

  test("runEntry：exclude 缺文件仍是 skip（有意不跑，不借缺件误伤排除集）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "testci-missing-"))
    const r = await runEntry(entry(join(dir, "packages/demo/test/absent.test.ts"), "exclude"), dir, 30_000)
    expect(r.status).toBe("skip")
    await rm(dir, { recursive: true, force: true })
  })

  test("findMissingIncluded 只点名纳入集里的缺件（与 --filter 无关）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "testci-missing-"))
    const testDir = join(dir, "packages/demo/test")
    await mkdir(testDir, { recursive: true })
    await writeFile(join(testDir, "ok.test.ts"), `import { test } from "bun:test"\ntest("ok", () => {})\n`)
    const entries = [
      entry("packages/demo/test/ok.test.ts"),
      entry("packages/demo/test/missing.test.ts"),
      entry("packages/demo/test/excluded-absent.test.ts", "exclude"),
    ]
    // 相对路径条目按 root 解析（与 runEntry 同一口径）
    expect(await findMissingIncluded(dir, entries)).toEqual(["packages/demo/test/missing.test.ts"])
    await rm(dir, { recursive: true, force: true })
  })

  /** 真 CLI（不是替身）：私有 tmp 树 + 同一条 `main()` 路径，只认退出码与报告里那一行。 */
  async function runHarnessCli(root: string, extra: string[], env: NodeJS.ProcessEnv = {}) {
    const script = join(import.meta.dir, "test-ci.ts")
    const child = spawn(process.execPath, [script, "--root", root, "--manifest", "manifest.json", ...extra], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    })
    let out = ""
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")))
    child.stderr.on("data", (b: Buffer) => (out += b.toString("utf8")))
    const code = await new Promise<number | null>((res) => child.on("close", res))
    return { code, out }
  }

  /** 造一个真能跑的最小树：一个真用例 + 一个**清单里有、磁盘上没有**的纳入条目。 */
  async function scaffoldMissingRoot() {
    const dir = await mkdtemp(join(tmpdir(), "testci-cli-missing-"))
    const testDir = join(dir, "packages/demo/test")
    await mkdir(testDir, { recursive: true })
    await writeFile(join(testDir, "ok.test.ts"), `import { expect, test } from "bun:test"\ntest("ok", () => { expect(1).toBe(1) })\n`)
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        schema: 1,
        note: "CCMM-09 缺件反例样本（只写 temp）",
        safeDefault: SAFE_DEFAULT_REASON,
        runnerNotes: { "bun:test": "bun test <file>" },
        entries: [
          entry("packages/demo/test/ok.test.ts"),
          entry("packages/demo/test/missing.test.ts"),
        ],
      }),
    )
    return dir
  }

  test("真 CLI：纳入缺件 ⇒ 退出码 2 并点名文件（同树另一个用例照常 pass，也不救它）", async () => {
    const dir = await scaffoldMissingRoot()
    try {
      const { code, out } = await runHarnessCli(dir, ["--json", "report.json"])
      expect(code).toBe(2)
      expect(out).toContain("MISSING\t已纳入但磁盘上没有：packages/demo/test/missing.test.ts")
      expect(out).toContain("纳入集缺件")
      // 存在性不被当成"测试成功"：真用例确实跑过且通过，但整体仍是配置错误
      expect(out).toContain("PASS\tbun:test\tpackages/demo/test/ok.test.ts")
      const report = JSON.parse(await readFile(join(dir, "report.json"), "utf8")) as {
        summary: { missing: number; passed: number; skipped: number; harnessExitCode: number }
        results: Array<{ path: string; status: string; command: string }>
      }
      expect(report.summary.missing).toBe(1)
      expect(report.summary.passed).toBe(1)
      expect(report.summary.harnessExitCode).toBe(2)
      // 报告里的 command 要照着能敲：固定 token（`test`）不得被当路径渲染成 ../../…/test
      expect(report.results.find((r) => r.path.endsWith("ok.test.ts"))!.command).toBe(
        `${process.env.TESTCI_BUN?.trim() || "bun"} --no-env-file test packages/demo/test/ok.test.ts`,
      )
      // 缺件不能被记成 skipped（那是"有意不跑"的账）
      const missingRow = report.results.find((r) => r.path.endsWith("missing.test.ts"))!
      expect(missingRow.status).toBe("missing")
      expect(missingRow.status).not.toBe("skip")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("真 CLI：--filter 只跑子集也盖不住缺件（存在性看的是整个纳入集）", async () => {
    const dir = await scaffoldMissingRoot()
    try {
      // --filter 命中的只有 ok.test.ts，missing.test.ts 本次根本不会被跑到——但它仍必须让 CI 红
      const { code, out } = await runHarnessCli(dir, ["--filter", "ok.test"])
      expect(code).toBe(2)
      expect(out).toContain("MISSING\t已纳入但磁盘上没有：packages/demo/test/missing.test.ts")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("真 CLI：--list 同样点名且非 0（列表模式不许把缺件说成 SKIP）", async () => {
    const dir = await scaffoldMissingRoot()
    try {
      const { code, out } = await runHarnessCli(dir, ["--list"])
      expect(code).toBe(2)
      expect(out).toContain("MISSING\t已纳入但磁盘上没有：packages/demo/test/missing.test.ts")
      expect(out).toContain("# include=2 exclude=0 missing=1")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/**
 * NESTED-BUN-127 的真 CLI 面。两条判据缺一条就等于没修：
 *   ① **PATH 上没有 bun 也照样跑**（execPath 分支兜住）——改前这里每条用例各撞一次 ENOENT；
 *   ② 执行器**真起不来**时点名 + 退出码 2，**不许**把"没有执行器"写成"用例失败"
 *      （改前：每一条都写「真实非 0 退出码 127」、harness exit=1 —— 假红 + 判据说假话）。
 * 用真 CLI + 真子进程，不注入替身；"起不来"那一格用 `TESTCI_BUN` 指向不存在的绝对路径制造（可注入、与 PATH 无关）。
 */
describe("真 CLI：执行器与 PATH 无关，且起不来时点名（NESTED-BUN-127）", () => {
  async function scaffoldRoot() {
    const dir = await mkdtemp(join(tmpdir(), "testci-cli-exec-"))
    const testDir = join(dir, "packages/demo/test")
    await mkdir(testDir, { recursive: true })
    await writeFile(join(testDir, "ok.test.ts"), `import { expect, test } from "bun:test"\ntest("ok", () => { expect(1).toBe(1) })\n`)
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        schema: 1,
        note: "NESTED-BUN-127 执行器样本（只写 temp）",
        safeDefault: SAFE_DEFAULT_REASON,
        runnerNotes: { "bun:test": "bun test <file>" },
        entries: [
          { path: "packages/demo/test/ok.test.ts", declaredRunner: "bun:test", markers: [], decision: "include", reason: SAFE_DEFAULT_REASON },
        ],
      }),
    )
    return dir
  }

  async function runCli(root: string, extra: string[], env: NodeJS.ProcessEnv) {
    const script = join(import.meta.dir, "test-ci.ts")
    const child = spawn(process.execPath, [script, "--root", root, "--manifest", "manifest.json", ...extra], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    })
    let out = ""
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")))
    child.stderr.on("data", (b: Buffer) => (out += b.toString("utf8")))
    const code = await new Promise<number | null>((res) => child.on("close", res))
    return { code, out }
  }

  test("run 模式：PATH/HOME 上都没有 bun 也照样跑（execPath 分支）——改前这里红成 `真实非 0 退出码 127`", async () => {
    const dir = await scaffoldRoot()
    const bare = await mkdtemp(join(tmpdir(), "testci-bare-"))
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: bare, HOME: bare }
      delete env.TESTCI_BUN
      const { code, out } = await runCli(dir, [], env)
      expect(code).toBe(0)
      expect(out).toContain("PASS\tbun:test\tpackages/demo/test/ok.test.ts")
      expect(out).not.toContain("真实非 0 退出码 127")
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(bare, { recursive: true, force: true })
    }
  })

  test("run 模式：执行器配置错 ⇒ exit 2 且**一条用例都不起**（不许写成一串「用例失败」）", async () => {
    const dir = await scaffoldRoot()
    try {
      const { code, out } = await runCli(dir, ["--json", "report.json"], {
        ...process.env,
        TESTCI_BUN: "/definitely/missing/bun",
      })
      expect(code).toBe(2)
      expect(out).toContain("CONFIG-ERROR\tTESTCI_BUN 指向的执行器在磁盘上不存在")
      expect(out).toContain("fail-closed")
      // 关键：不许把"没有执行器"写成"用例失败"（改前 195 条 `真实非 0 退出码 127`）
      expect(out).not.toContain("真实非 0 退出码")
      expect(out).not.toContain("FAIL\t")
      // 一条都没跑 ⇒ 没有报告文件（不拿空报告冒充读数）
      expect(await Bun.file(join(dir, "report.json")).exists()).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("--list：执行器起不来也点名 + exit 2（列表照给，门读得到 include 行，但判据非绿）", async () => {
    const dir = await scaffoldRoot()
    try {
      const { code, out } = await runCli(dir, ["--list"], { ...process.env, TESTCI_BUN: "/definitely/missing/bun" })
      expect(code).toBe(2)
      expect(out).toContain("CONFIG-ERROR\tTESTCI_BUN 指向的执行器在磁盘上不存在")
      // 列表本身仍在：门的两条独立读数（收尾行 + 逐行数）依旧成立 ⇒ 不会被读成"没量到"
      expect(out).toContain("# include=1 exclude=0 missing=0")
      expect(out).toContain("RUN \tbun:test\tpackages/demo/test/ok.test.ts")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/**
 * **per-entry 超时**（STALL-CAP-TIMEOUT）的判据。
 *
 * 在场理由：`policy-source-stall-cap.test.ts` 自己的判据就是"真实默认常量下的 30s trickle"
 * （不许 skip、不许缩短），单跑约 55s；全局 `TESTCI_TIMEOUT_MS` 默认 120s，机器忙时会把它撞成
 * `TIMEOUT`（**假红**：把"机器忙"记成"用例失败"）。修法是给 `ManifestEntry` 加 per-entry 超时字段。
 *
 * 但一个"可以随便加的超时"就是"把挂住的用例等成绿的"那条捷径 ⇒ 这里两条都钉：
 *  ① **字段真的生效**：单列 30s（比全局 120s 宽）时，1.6s 的用例必须跑完并记 `pass`；
 *  ② **不许拿它掩盖挂住**：单列 1s 时，同一个 1.6s 的用例必须记 `timeout` + 退出码 1；
 *  ③ **写前纪律**：非正整数／超上界／reason 没写明 ⇒ `timeoutProblems()` 报出来，
 *     且 `--list` 必须**退出码 2**（不是"照跑"）。
 */
describe("per-entry 超时：单列真的生效，且不许拿它掩盖挂住（STALL-CAP-TIMEOUT）", () => {
  /** 1.6s 的用例：比"收紧"的 1s 长、比"放宽"的 30s 短 ⇒ 两个方向都能被这**一个**文件证明。 */
  const SLEEPER = `import { test } from "bun:test"\ntest("慢", async () => { await Bun.sleep(1600) })\n`
  const entryOf = (over: Record<string, unknown> = {}) => ({
    path: "packages/demo/test/slow.test.ts",
    declaredRunner: "bun:test" as const,
    markers: [],
    decision: "include" as const,
    reason: SAFE_DEFAULT_REASON,
    ...over,
  })

  /** 私有 tmp 树 + 真 CLI（与上面的 NESTED-BUN-127 样本同一做法：`runCli` 是那个 describe 的局部函数，
   *  这里不能用，所以本块自备一份——**不复制被测逻辑**，只复制"起子进程"这层壳）。 */
  async function scaffold(entry: Record<string, unknown>) {
    const dir = await mkdtemp(join(tmpdir(), "testci-entrytimeout-"))
    const testDir = join(dir, "packages/demo/test")
    await mkdir(testDir, { recursive: true })
    await writeFile(join(testDir, "slow.test.ts"), SLEEPER)
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        schema: 1,
        note: "per-entry 超时样本（只写 temp）",
        safeDefault: SAFE_DEFAULT_REASON,
        runnerNotes: { "bun:test": "bun test <file>" },
        entries: [entry],
      }),
    )
    return dir
  }

  async function runCliHere(root: string, extra: string[]) {
    const script = join(import.meta.dir, "test-ci.ts")
    const child = spawn(process.execPath, [script, "--root", root, "--manifest", "manifest.json", ...extra], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
    let out = ""
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")))
    child.stderr.on("data", (b: Buffer) => (out += b.toString("utf8")))
    const code = await new Promise<number | null>((res) => child.on("close", res))
    return { code, out }
  }

  test("effectiveTimeoutMs：没写 ⇒ 全局值（默认行为一个字不变）；写了 ⇒ 以条目值为准（放宽/收紧都显式）", () => {
    expect(effectiveTimeoutMs({}, 120_000)).toBe(120_000)
    expect(effectiveTimeoutMs({ timeoutMs: 600_000 }, 120_000)).toBe(600_000) // 放宽
    expect(effectiveTimeoutMs({ timeoutMs: 1_000 }, 120_000)).toBe(1_000) // 收紧
    // 非法值不生效（回落到全局）——但它**不是静默放行**：timeoutProblems 会把它记成配置错误
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(effectiveTimeoutMs({ timeoutMs: bad }, 120_000)).toBe(120_000)
  })

  test("timeoutProblems：只有 include 能写、正整数、有上界、reason 必须写明（缺一条就报）", () => {
    expect(timeoutProblems([entryOf()], 120_000)).toEqual([])
    expect(timeoutProblems([entryOf({ timeoutMs: 600_000, reason: "per-entry 超时：真实 30s 常量" })], 120_000)).toEqual([])
    // ① exclude 不许写
    expect(timeoutProblems([entryOf({ decision: "exclude", timeoutMs: 600_000 })], 120_000).join("\n")).toContain("只有 decision=include")
    // ② 非正整数
    expect(timeoutProblems([entryOf({ timeoutMs: 0 })], 120_000).join("\n")).toContain("必须是正整数")
    // ③ 上界（再长就不是"留余量"，是"把挂住藏起来"）
    expect(timeoutProblems([entryOf({ timeoutMs: MAX_ENTRY_TIMEOUT_MS + 1 })], 120_000).join("\n")).toContain("超过上界")
    // ④ reason 里必须写明：缺了 ⇒ 报出来（不许偷偷单列）
    expect(timeoutProblems([entryOf({ timeoutMs: 600_000 })], 120_000).join("\n")).toContain("per-entry 超时")
  })

  test("真 CLI：单列 30s（比全局 120s 宽）⇒ 1.6s 用例跑完记 pass，报告里读到的是条目值", async () => {
    const dir = await scaffold(entryOf({ timeoutMs: 30_000, reason: `${SAFE_DEFAULT_REASON}；per-entry 超时：1.6s 的慢用例` }))
    try {
      const { code, out } = await runCliHere(dir, ["--json", "report.json"])
      expect(code).toBe(0)
      expect(out).toContain("PASS\tbun:test\tpackages/demo/test/slow.test.ts")
      const report = JSON.parse(await readFile(join(dir, "report.json"), "utf8"))
      expect(report.timeoutMs).toBe(120_000) // 全局缺省值没被改
      expect(report.perEntryTimeouts).toEqual([
        { path: "packages/demo/test/slow.test.ts", decision: "include", timeoutMs: 30_000, globalTimeoutMs: 120_000 },
      ])
      expect(report.results[0].status).toBe("pass")
      expect(report.results[0].timeoutMs).toBe(30_000) // 报告里能直接读到"这条的上限是哪个数"
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("真 CLI：单列 1s（收紧）⇒ 同一个 1.6s 用例精确变成 timeout + 退出码 1（字段不是装饰）", async () => {
    const dir = await scaffold(entryOf({ timeoutMs: 1_000, reason: `${SAFE_DEFAULT_REASON}；per-entry 超时：单列 1s 做负对照` }))
    try {
      const { code, out } = await runCliHere(dir, ["--json", "report.json"])
      expect(code).toBe(1)
      expect(out).toContain("TIMEOUT\tbun:test\tpackages/demo/test/slow.test.ts")
      expect(out).toContain("超时 1000ms（SIGKILL；本条单列 per-entry 超时，全局 120000ms）")
      const report = JSON.parse(await readFile(join(dir, "report.json"), "utf8"))
      expect(report.results[0].status).toBe("timeout")
      expect(report.results[0].timeoutMs).toBe(1_000)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("真 CLI：不写 reason ⇒ --list 退出码 2 且点名（单列这件事必须在清单里可读）", async () => {
    const dir = await scaffold(entryOf({ timeoutMs: 600_000 })) // reason 里没有「per-entry 超时」
    try {
      const { code, out } = await runCliHere(dir, ["--list"])
      expect(code).toBe(2)
      expect(out).toContain("CONFIG-ERROR\tper-entry 超时字段不合纪律")
      expect(out).toContain("reason 里必须写明 per-entry 超时的理由")
      expect(out).toContain("fail-closed")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
