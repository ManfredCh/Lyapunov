/**
 * 机制 2（`script/gate-drivers.ts`）自身的用例。
 *
 * ## 为什么有这个文件
 *
 * 2026-09-26 验收队实测：机制报「实现 **14** 个，全部有驱动」，而 `script/gates/` 里
 * **真实实现文件是 15 个** —— `g10b.mts` 因发现集合用 `f.endsWith(".ts")` 而**无声消失**。
 *
 * > **一个检查报"全部通过"，而它根本看不见其中一个对象。**
 * > 而这个盲区在机制自己身上 —— 它被造出来正是为了防止"门空转"。
 *
 * 2026-09-27 验收队又实测一次（`bugfixHistory/VERIFY2-LANDED-FIXES-20260926.md` 第 ② 条），
 * 同一个形状的第三次：
 *
 *   (a) `g08g09.ts` **一举实现 2 个门身份**，被算成 1 ⇒ 「门身份合计 22」口径不严密（真 ≥23）；
 *   (b) `script/gates/domain-pointers.ts` 是**真门禁**（`package.json` 有 `gate:domain-pointers`），
 *       在输出里 **0 次出现**；同类的还有 `blender-mcp-live.ts` / `computer-use-blender.ts` /
 *       `viewer-play.ts` / `anim-glb.mjs`；
 *   (c) `contract.ts` / `g03-clock.ts` / `g07-calibration.ts` / `g12-exit.ts` /
 *       `probe-launch-chain.ts` 五个文件既非实现也非审计对象，**全部不可见**，
 *       而其中两个**承 G03/G07 的判定谓词**；另有 `G16` 有 `--gate` 路由也不在 22 里。
 *
 * 所以这里钉的性质是**四条**（不是"跑起来了吗"）：
 *
 *   1. **发现集合不许漏对象**：收全扩展名；实现个数必须等于盘上真实的那个数。
 *   2. **看不见的东西必须被报出来**：分「已审计」/「未纳入审计」/「汇总器路由但本仓无实现」三类，
 *      数字加得上；每一类都必须出现在输出里。
 *   3. **审计面本身要完整**（本文件新增）：`script/gates/` 下**每一个文件**都要落进一个具名类别，
 *      判据是**等式**「清单文件数 == 目录文件数」—— 分母用测试自己 `readdirSync` 数出来的数，
 *      **不信任机制自己的函数**。
 *   4. **门身份按身份计数、文件数另给**：15 个实现文件 = 16 个身份（`g08g09.ts` 给 2 个），
 *      16 个驱动文件 = 15 条门（`g19` 有 2 条）—— 三组数字必须同时出现，不许互相冒充。
 *
 * 负对照（都用**真夹具**跑）：
 *   · 藏掉驱动 ⇒ 必须报 `NO-DRIVER`；
 *   · 例外表过期 ⇒ 必须报 `RUNNER-STALE`；
 *   · **藏掉 `domain-pointers.ts`（`package.json` 脚本留着）⇒ 必须报 `GATE-SCRIPT-DANGLING`**；
 *   · **换一个 CODE_EXTENSIONS 之外的扩展名 ⇒ 必须仍进清单**（不许重演 g10b 那次"表外即消失"）；
 *   · **一个落不进任何类的空文件 ⇒ 必须报 `UNCLASSIFIED`**；
 *   · **子目录里藏文件 ⇒ 必须报 `SUB-DIR-CONTENT`**。
 *
 * 以及一条 `release-gate` 的机器契约（`--json` 的 `stdout+stderr` 拼接后仍可解析）。
 */
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import {
  CODE_EXTENSIONS, GATE_FILE_KINDS, allFilesInGates, discover, filesInGates, identityOf,
} from "./gate-drivers.ts"

const ROOT = resolve(import.meta.dirname, "..")
const GATES = join(ROOT, "script", "gates")

/** 临时夹具根：按 `相对路径 → 内容` 铺出一棵最小树，用完删掉。 */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "lyaup-gate-drivers-"))
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, body)
  }
  return root
}

const IMPL = (fn: string): string => `export async function ${fn}(): Promise<void> {\n  return\n}\n`
const DRIVER = (fn: string, from: string): string => `import { ${fn} } from "${from}"\nawait ${fn}()\nprocess.exit(0)\n`

/**
 * 夹具的公共底座：`g10b.mts` + 它那条 **node-only** 驱动。
 *
 * 为什么要它：`NODE_ONLY_DRIVERS` 的自校验要求 `run-g10b.mts` 在驱动集合里，
 * 否则夹具会先撞上 `RUNNER-STALE`（那是**另一条**判据在正确工作），
 * 把本文件要测的那几条（覆盖面）盖住。
 */
const BASE: Record<string, string> = {
  "script/gates/g10b.mts": IMPL("gateG10b"),
  "script/gates/run-g10b.mts": `// 用法：node script/gates/run-g10b.ts\nimport { gateG10b } from "./g10b.mts"\n`
    + `await gateG10b()\nprocess.exit(0)\n`,
}

/** 调 CLI（真命令行，不是内部函数）—— 退出码与 stdout/stderr 都是判据的一部分。 */
function cli(args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, ["run", "script/gate-drivers.ts", ...args], {
    cwd: ROOT, encoding: "utf8",
  })
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" }
}

/**
 * 目录下**文件**数的独立读数 —— 故意不用 `allFilesInGates()`。
 * 用机制自己的函数去核机制自己的判据，等于没核。
 */
function countFilesOnDisk(dir: string = GATES): number {
  return readdirSync(dir).filter(n => statSync(join(dir, n)).isFile()).length
}

// ─────────────────────────────────────────────────────────────────────────────
describe("发现集合：不许漏对象（2026-09-26 盲区的正对照）", () => {
  test("收全扩展名：真实 script/gates/ 里每个实现都被发现，g10b.mts 在内", () => {
    const d = discover(ROOT)
    const ids = d.gates.map(g => g.id)
    // 收全扩展名前这里是 14 —— 少的正是 g10b.mts。
    expect(d.gates.length).toBe(15)
    expect(ids).toContain("g10b")
    const g10b = d.gates.find(g => g.id === "g10b")!
    expect(g10b.implementation).toBe("script/gates/g10b.mts")
    expect(g10b.exported).toEqual(["gateG10b"])
    // 扩展名过滤这一条本身：`.mts` 必须真的进得了发现集合（旧的 endsWith(".ts") 在这里是 false）。
    expect(filesInGates(ROOT)).toContain("g10b.mts")
    expect("g10b.mts".endsWith(".ts")).toBe(false)
  })

  test("两类数字加得上，且各自对得上盘上真实的清单；判据未放宽（缺驱动 ⇒ exit 2）", () => {
    const d = discover(ROOT)
    expect(d.totals.auditedFiles).toBe(15)
    expect(d.totals.unaudited).toBe(7)
    // ⚠️ 22 是**旧的错口径**（见下一条用例）；现在按身份计数。
    expect(d.totals.identities).not.toBe(22)
    expect(d.totals.identities)
      .toBe(d.totals.auditedIdentities + d.totals.unaudited + d.totals.routedNoImplementation)
    expect(d.totals.withoutDriver).toBe(0)
    expect(d.gates.filter(g => g.driver === null)).toEqual([])
    for (const g of d.gates) {
      expect(existsSync(join(ROOT, g.implementation))).toBe(true)
      expect(existsSync(join(ROOT, g.driver!))).toBe(true)
    }
  })

  test("收全扩展名后，扩展名清单本身是可见的（不是让读者去猜）", () => {
    const d = discover(ROOT)
    expect(d.present[".ts"]).toBeGreaterThan(0)
    expect(d.present[".mts"]).toBe(3) // g10b.mts / run-g10b.mts / run-g19.mts
    expect(d.present[".mjs"]).toBe(1) // anim-glb.mjs
    // `.parked/` 是目录、不是扩展名 —— 只数文件。
    expect(Object.keys(d.present)).not.toContain(".parked")
    expect(CODE_EXTENSIONS).toContain(".mts")
  })

  test("夹具：.mts/.cts/.js/.mjs 都收得进；.test.*/.spec.* 排除", () => {
    const root = fixture({
      ...BASE,
      "script/gates/ga.mts": IMPL("gateGa"),
      "script/gates/gb.cts": IMPL("gateGb"),
      "script/gates/gc.js": IMPL("gateGc"),
      "script/gates/gd.mjs": IMPL("gateGd"),
      "script/gates/ge.test.mts": IMPL("gateGe"),
      "script/gates/gf.spec.js": IMPL("gateGf"),
      "script/gates/notes.md": "不是脚本，但**也不许消失**（进「非脚本」这一类）\n",
    })
    try {
      expect(filesInGates(root)).toEqual(["g10b.mts", "ga.mts", "gb.cts", "gc.js", "gd.mjs", "run-g10b.mts"])
      const ids = discover(root).gates.map(g => g.id)
      for (const id of ["g10b", "ga", "gb", "gc", "gd"]) expect(ids).toContain(id)
      for (const excluded of ["ge", "gf"]) expect(ids).not.toContain(excluded)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("看不见的东西必须被报出来（未纳入审计那一类）", () => {
  test("G01–G07：定义在汇总器内部、逐个给定义位置与单跑命令", () => {
    const unaudited = discover(ROOT).unaudited
    expect(unaudited.map(g => g.id)).toEqual(["G01", "G02", "G03", "G04", "G05", "G06", "G07"])
    for (const g of unaudited) {
      expect(g.reason).toContain("无独立实现文件")
      expect(g.definedAt[0]).toMatch(/^script\/refactor-verify\.ts:\d+$/)
      // 定义位置必须是**真的**（读回来核对那一行），不能是手写的印象。
      const [file, line] = g.definedAt[0]!.split(":")
      const text = readFileSync(join(ROOT, file!), "utf8").split("\n")[Number(line) - 1]!
      expect(text).toContain(`function gate${g.id}`)
      expect(g.command).toBe(`bun run script/refactor-verify.ts --gate ${g.id}`)
    }
  })

  test("未纳入审计 ≠ 缺陷：它不把退出码推成 2（但已审计缺驱动会）", () => {
    const d = discover(ROOT)
    expect(d.unaudited.length).toBe(7)
    expect(d.runnerProblems).toEqual([])
    expect(cli([]).code).toBe(0)
  })

  test("人类可读输出里三类都在，且合计行在", () => {
    const r = cli([])
    expect(r.out).toContain("已审计 15 个实现")
    expect(r.out).toContain("未纳入审计 7 个")
    expect(r.out).toContain("g10b")
    expect(r.out).toContain("G05")
    expect(r.out).toContain("script/refactor-verify.ts:584")
    expect(r.out).toContain("── 文件清单：script/gates/ 下每一个文件")
    expect(r.out).toContain("── 覆盖面自校验")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("审计面本身不完整（验收队 VERIFY2 ② 的正对照）", () => {
  test("(a) 一个文件实现两个身份 ⇒ 按身份计数，同时给文件数", () => {
    const d = discover(ROOT)
    const g = d.gates.find(x => x.id === "g08g09")!
    expect(g.exported).toEqual(["gateG08", "gateG09"])
    expect(g.identities).toEqual(["G08", "G09"])
    // 15 个实现文件 / 16 个身份 —— 这两个数**必须同时出现**，不许拿一个冒充另一个。
    expect(d.totals.auditedFiles).toBe(15)
    expect(d.totals.auditedIdentities).toBe(16)
    // 驱动文件也另算：g19 有两条驱动 ⇒ 16 个驱动文件 / 15 条门。
    expect(d.totals.driverFiles).toBe(16)
    expect(d.gates.find(x => x.id === "g19")!.alternates).toEqual(["script/gates/run-g19.mts"])
    // 身份合计：16 + 7 + 1(G16) = 24；"本仓有实现或定义"的 23 个（验收队算的就是这个 ≥23）。
    expect(d.totals.routedNoImplementation).toBe(1)
    expect(d.totals.identitiesPresentInRepo).toBe(23)
    expect(d.totals.identities).toBe(24)
    // 人类可读输出里三组数字都看得见。
    const out = cli([]).out
    expect(out).toContain("实现【文件】15 个 / 门【身份】16 个")
    expect(out).toContain("g08g09.ts 一举实现 G08+G09")
    expect(out).toContain("驱动【文件】16 个")
    expect(out).toContain("门身份合计 24 个")
  })

  test("identityOf：gateG08/gateG01Live/gateG13Acp/gateG10b 都认，认不出的返回 null（不猜）", () => {
    expect(identityOf("gateG08")).toBe("G08")
    expect(identityOf("gateG01Live")).toBe("G01LIVE")
    expect(identityOf("gateG13Acp")).toBe("G13ACP")
    expect(identityOf("gateG10b")).toBe("G10B")
    expect(identityOf("gateOurs")).toBeNull()
    expect(identityOf("gateGa")).toBeNull()
  })

  test("(b) 之前 0 次出现的文件，现在一个都在清单里", () => {
    const d = discover(ROOT)
    const files = new Set(d.ledger.map(r => r.file))
    for (const name of ["domain-pointers.ts", "blender-mcp-live.ts", "computer-use-blender.ts",
      "viewer-play.ts", "anim-glb.mjs", "contract.ts", "g03-clock.ts", "g07-calibration.ts",
      "g12-exit.ts", "probe-launch-chain.ts"]) {
      expect(files).toContain(`script/gates/${name}`)
    }
    // 交叉核对：验收队点名的那 5 个文件确实是"既非实现也非审计对象"，现在各有类别。
    const kindOf = (n: string): string => d.ledger.find(r => r.file === `script/gates/${n}`)!.kind
    expect(kindOf("domain-pointers.ts")).toBe("目录级门禁")
    expect(kindOf("contract.ts")).toBe("共享谓词")
    expect(kindOf("g03-clock.ts")).toBe("共享谓词")
    expect(kindOf("g07-calibration.ts")).toBe("共享谓词")
    expect(kindOf("g12-exit.ts")).toBe("共享谓词")
    expect(kindOf("probe-launch-chain.ts")).toBe("子探针")
    expect(kindOf("anim-glb.mjs")).toBe("子探针")
    expect(kindOf("viewer-play.ts")).toBe("子探针")
    expect(kindOf("blender-mcp-live.ts")).toBe("子探针")
    expect(kindOf("computer-use-blender.ts")).toBe("独立现场驱动")
    // 全量输出里，每个文件都真的出现（不是只在 JSON 里）。
    const out = cli([]).out
    for (const r of d.ledger) expect(out).toContain(r.file)
  })

  test("(c) G03/G07 的判定谓词被点名（'无独立实现文件'那句话只对一半）", () => {
    const d = discover(ROOT)
    const g03 = d.unaudited.find(g => g.id === "G03")!
    const g07 = d.unaudited.find(g => g.id === "G07")!
    expect(g03.relatedFiles).toContain("script/gates/g03-clock.ts")
    expect(g07.relatedFiles).toContain("script/gates/g07-calibration.ts")
    // 而被点名的那个关系必须是真的：汇总器确实 import 了它（行号逐条核）。
    for (const [file, rel] of [["script/refactor-verify.ts", "script/gates/g03-clock.ts"],
      ["script/refactor-verify.ts", "script/gates/g07-calibration.ts"]] as const) {
      const text = readFileSync(join(ROOT, file), "utf8")
      expect(text).toContain(rel.replace("script/gates/", "./gates/"))
    }
    // 没有谓词的门不许凭空多出相关文件。
    expect(d.unaudited.find(g => g.id === "G01")!.relatedFiles).toEqual([])
    expect(cli(["--gate", "G03"]).out).toContain("script/gates/g03-clock.ts")
  })

  test("(c) G16：有 --gate 路由、本仓无实现 ⇒ 单列一类，不许静默不算", () => {
    const d = discover(ROOT)
    expect(d.routedOnly.map(g => g.id)).toEqual(["G16"])
    const g16 = d.routedOnly[0]!
    expect(g16.blocked).toBe(true)
    expect(g16.reason).toContain("服务端计价链")
    expect(g16.command).toBeNull() // 给不出命令就不给，不许拿别的命令顶替
    expect(d.aggregator.routes).toContain("G16")
    const r = cli(["--gate", "G16"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("本仓无实现")
  })

  test("判据是一条等式：清单文件数 == 目录文件数（分母由测试自己数）", () => {
    const d = discover(ROOT)
    const onDisk = countFilesOnDisk()
    expect(d.coverage.filesInDir).toBe(onDisk)
    expect(d.coverage.ledgerFiles).toBe(onDisk)
    expect(d.ledger.length).toBe(onDisk)
    expect(allFilesInGates(ROOT).length).toBe(onDisk)
    expect(d.coverage.unclassified).toEqual([])
    expect(d.coverage.problems).toEqual([])
    // 每个类别加起来必须等于文件总数（不许有类别之外的第四种状态）。
    const sum = GATE_FILE_KINDS.reduce((n, k) => n + (d.totals.byKind[k] ?? 0), 0)
    expect(sum).toBe(onDisk)
    // 本次的真实分布（改动前这些文件里有一批根本不在输出里）。
    expect(d.totals.byKind).toEqual({
      实现: 15, 驱动: 16, 子探针: 4, 目录级门禁: 1, 共享谓词: 4, 独立现场驱动: 1, 测试: 8, 非脚本: 0, 未知: 0,
    })
  })

  test("每一行都带一条可复算的「为什么」；子目录也被报出来（不许当藏东西的地方）", () => {
    const d = discover(ROOT)
    for (const row of d.ledger) {
      expect(row.why.length).toBeGreaterThan(10)
    }
    // `.parked/` 是**空目录**：Git 不保存空目录，冷 checkout 里没有它。所以子目录可见性
    // 用本测试自建的临时夹具显式 `mkdir` 之后，跑**真** `discover()` 与**真** CLI
    // （`--root <fixture>`）来钉；不往产品 `script/gates/` 塞占位文件，也不删这条判据。
    const root = fixture({ ...BASE })
    try {
      mkdirSync(join(root, "script", "gates", ".parked"), { recursive: true })
      const sub = discover(root)
      expect(sub.coverage.subdirectories).toEqual([{ name: ".parked/", files: 0 }])
      expect(cli(["--root", root]).out).toContain(".parked/")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("汇总器里 GATE_DRIVERS 的指路命令与机制的「正确命令」一致（同一份知识不许漂）", () => {
    const d = discover(ROOT)
    const hints = d.aggregator.driverHints
    expect(Object.keys(hints).sort()).toEqual(["G10B", "G18", "G19"])
    for (const [id, command] of Object.entries(hints)) {
      const mech = d.gates.flatMap(g => g.identities).includes(id)
        ? d.gates.find(g => g.identities.includes(id))!.command
        : null
      expect(mech).toBe(command)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("负对照 0 · 藏掉 domain-pointers.ts ⇒ 机制必须报出来（不许静默）", () => {
  test("真树副本上删掉它：清单数字仍然对得上，但 package.json 锚点把它抓出来 ⇒ exit 2", () => {
    const root = mkdtempSync(join(tmpdir(), "lyaup-gate-drivers-dp-"))
    try {
      cpSync(GATES, join(root, "script", "gates"), { recursive: true })
      cpSync(join(ROOT, "script", "refactor-verify.ts"), join(root, "script", "refactor-verify.ts"))
      cpSync(join(ROOT, "package.json"), join(root, "package.json"))

      const before = discover(root)
      expect(before.coverage.dangling).toEqual([])
      expect(before.ledger.find(r => r.file.endsWith("domain-pointers.ts"))!.kind).toBe("目录级门禁")
      expect(cli(["--root", root]).code).toBe(0)

      rmSync(join(root, "script", "gates", "domain-pointers.ts"))
      const after = discover(root)
      // ⚠️ 这一格是本用例的重点：**"文件数 == 清单数"这条等式自己抓不到它**
      //    （两边同时少 1，等式照样成立）—— 抓它的是 package.json 这个**外部锚点**。
      expect(after.coverage.ledgerFiles).toBe(after.coverage.filesInDir)
      expect(after.coverage.unclassified).toEqual([])
      expect(after.coverage.dangling.map(d => d.name)).toEqual(["gate:domain-pointers"])
      expect(after.coverage.problems.join()).toContain("GATE-SCRIPT-DANGLING")

      const r = cli(["--root", root])
      expect(r.out).toContain("GATE-SCRIPT-DANGLING")
      expect(r.out).toContain("gate:domain-pointers")
      expect(r.out).toContain("script/gates/domain-pointers.ts")
      expect(r.out).toContain("挂空 1 条")
      expect(r.code).toBe(2)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("夹具：门脚本指向的文件不存在同样被点名（不依赖真树）", () => {
    const root = fixture({
      ...BASE,
      "package.json": JSON.stringify({ scripts: { "gate:ghost": "bun run script/gates/ghost.ts" } }),
    })
    try {
      const d = discover(root)
      expect(d.coverage.gateScripts).toEqual([{ name: "gate:ghost", target: "script/gates/ghost.ts", exists: false }])
      const r = cli(["--root", root])
      expect(r.code).toBe(2)
      expect(r.out).toContain("GATE-SCRIPT-DANGLING")
      expect(r.out).toContain("gate:ghost")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("未覆盖边界（如实登记）：文件与它的 package.json 脚本**同时**删掉 ⇒ 本机制无从知道它存在过", () => {
    // 这是**没有修好**的一格，写出来是为了不让它被当成"已覆盖"：
    // 本机制没有一份独立于工作树的门清单，锚点只有 package.json（与汇总器）。
    const root = fixture({ ...BASE })
    try {
      expect(discover(root).coverage.problems).toEqual([])
      expect(cli(["--root", root]).code).toBe(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("负对照 0b · 换个扩展名 / 空文件 / 子目录：都不许静默消失", () => {
  test("CODE_EXTENSIONS 之外的扩展名照样进清单（不然就是 g10b.mts 那次的翻版）", () => {
    const root = fixture({ ...BASE, "script/gates/helper.py": "print('hi')\n" })
    try {
      const d = discover(root)
      const row = d.ledger.find(r => r.file === "script/gates/helper.py")!
      expect(row.kind).toBe("非脚本")
      expect(row.why).toContain(".py")
      // 判据仍是等式：清单里的文件数 == 目录里的文件数（覆盖已满，所以**不**因它 exit 2）。
      expect(d.coverage.ledgerFiles).toBe(countFilesOnDisk(join(root, "script", "gates")))
      expect(d.coverage.unclassified).toEqual([])
      expect(cli(["--root", root]).out).toContain("script/gates/helper.py")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("落不进任何一类的文件 ⇒ UNCLASSIFIED + exit 2（宁可报「我不知道」，也不跳过）", () => {
    const root = fixture({ ...BASE, "script/gates/ghost.ts": "// 只有注释：没有导出、没有顶层语句\n" })
    try {
      const d = discover(root)
      expect(d.coverage.unclassified).toEqual(["script/gates/ghost.ts"])
      expect(d.ledger.find(r => r.file === "script/gates/ghost.ts")!.kind).toBe("未知")
      expect(d.coverage.ledgerFiles).toBe(countFilesOnDisk(join(root, "script", "gates")))
      const r = cli(["--root", root])
      expect(r.code).toBe(2)
      expect(r.out).toContain("UNCLASSIFIED")
      expect(r.out).toContain("script/gates/ghost.ts")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("子目录里有文件 ⇒ SUB-DIR-CONTENT + exit 2（子目录不许当藏东西的地方）", () => {
    const root = fixture({ ...BASE, "script/gates/.parked/gx.ts": "export type X = 1\n" })
    try {
      const d = discover(root)
      expect(d.coverage.subdirectories).toEqual([{ name: ".parked/", files: 1 }])
      expect(d.coverage.problems.join()).toContain("SUB-DIR-CONTENT")
      const r = cli(["--root", root])
      expect(r.code).toBe(2)
      expect(r.out).toContain("SUB-DIR-CONTENT")
      expect(r.out).toContain(".parked/")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("负对照 1 · 藏掉驱动 ⇒ 机制必须报出来（这条判据不能退化）", () => {
  test("真树副本上删掉 run-g10b.mts ⇒ g10b 被点名 NO-DRIVER，exit 2", () => {
    const root = mkdtempSync(join(tmpdir(), "lyaup-gate-drivers-real-"))
    try {
      cpSync(GATES, join(root, "script", "gates"), { recursive: true })
      cpSync(join(ROOT, "script", "refactor-verify.ts"), join(root, "script", "refactor-verify.ts"))
      expect(discover(root).totals.withoutDriver).toBe(0)

      rmSync(join(root, "script", "gates", "run-g10b.mts"))
      const d = discover(root)
      expect(d.totals.withoutDriver).toBe(1)
      const g10b = d.gates.find(g => g.id === "g10b")!
      expect(g10b.driver).toBeNull()
      expect(g10b.command).toBeNull()

      const r = cli(["--root", root])
      expect(r.out).toContain("NO-DRIVER")
      expect(r.out).toContain("script/gates/g10b.mts")
      expect(r.out).toContain("缺驱动 1 个")
      expect(r.code).toBe(2)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("夹具：无驱动的实现被点名（含把它的驱动藏掉这一半）", () => {
    const files = {
      ...BASE,
      "script/gates/ga.mts": IMPL("gateGa"),
      "script/gates/run-ga.mts": DRIVER("gateGa", "./ga.mts"),
      "script/gates/gb.ts": IMPL("gateGb"),
    }
    const kept = fixture(files)
    const hidden = fixture(files)
    try {
      // 只留 gb 无驱动 ⇒ 恰好 1 个
      expect(discover(kept).totals.withoutDriver).toBe(1)
      expect(discover(kept).gates.find(g => g.id === "gb")!.driver).toBeNull()
      // 再把 ga 的驱动也藏掉 ⇒ 变 2 个（藏一个必须多报一个，不能"少报"）
      rmSync(join(hidden, "script", "gates", "run-ga.mts"), { force: true })
      const d = discover(hidden)
      expect(d.totals.withoutDriver).toBe(2)
      expect(d.gates.filter(g => g.driver === null).map(g => g.id)).toEqual(["ga", "gb"])
      expect(cli(["--root", hidden]).code).toBe(2)
    } finally {
      rmSync(kept, { recursive: true, force: true })
      rmSync(hidden, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("运行器例外：只补扩展名会新造一条假命令，所以要显式登记 + 自校验", () => {
  test("g10b 的推荐命令是 node（bun 下 dsh-tools 模块图崩），且用同扩展名的那个驱动", () => {
    const g10b = discover(ROOT).gates.find(g => g.id === "g10b")!
    expect(g10b.driver).toBe("script/gates/run-g10b.mts")
    // 不是 `bun run …`：run-g10b.mts 没有 bun→node 自切，bun 下会假失败。
    expect(g10b.command).toBe("node script/gates/run-g10b.mts")
    expect(g10b.runner).toBe("node")
  })

  test("收全扩展名不会让 G19 的推荐命令退化成 node-only 的 run-g19.mts（它没有自切）", () => {
    const g19 = discover(ROOT).gates.find(g => g.id === "g19")!
    expect(g19.driver).toBe("script/gates/run-g19.ts") // 约定名 run-<id>.ts 优先
    expect(g19.command).toBe("bun run script/gates/run-g19.ts")
    // 另一条驱动不许被静默丢掉 —— 它必须作为备用被报出来。
    expect(g19.alternates).toEqual(["script/gates/run-g19.mts"])
    expect(cli(["--gate", "G19"]).out).toContain("DUP-DRIVER")
  })

  test("例外表过期必须报 RUNNER-STALE + exit 2（驱动已自带自切 / 已不在驱动集合里）", () => {
    // (a) 驱动已经自己切到 node ⇒ 例外该删掉，不能继续推荐 node
    const selfSwitched = fixture({
      "script/gates/g10b.mts": IMPL("gateG10b"),
      "script/gates/run-g10b.mts": `import { gateG10b } from "./g10b.mts"\n`
        + `if (process.versions.bun) process.exit(0)\nawait gateG10b()\n`,
    })
    // (b) 登记的文件在夹具里根本不存在
    const absent = fixture({ "script/gates/g10b.mts": IMPL("gateG10b") })
    try {
      expect(discover(selfSwitched).runnerProblems.join()).toContain("已自带 bun→node 自切")
      expect(discover(absent).runnerProblems.join()).toContain("已不在驱动集合里")
      const r = cli(["--root", selfSwitched])
      expect(r.out).toContain("RUNNER-STALE")
      expect(r.code).toBe(2)
    } finally {
      rmSync(selfSwitched, { recursive: true, force: true })
      rmSync(absent, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("机器可读契约：release-gate 的 parseGateDrivers()", () => {
  test("--json 的 stdout+stderr 拼接后仍解析成自足数组：15 行、0 缺驱动、exit 0", () => {
    const r = cli(["--json"])
    expect(r.code).toBe(0)
    // 这里调的是**直连 CLI**（`bun run script/gate-drivers.ts --json`，不经过 package.json 的 shell 前缀），
    // 所以 stderr 里没有 shell 的 `$ [ -x "$npm_execpath" ]` 诊断、拼接后仍可解析。
    // ⚠️ GATE-AB-20260927：真实的 `bun run gate:drivers --json`（`release-gate.ts` 的 `run()` 口径）
    //    stderr **带着**那对方括号 —— 机器结果只读 stdout 的那条契约（以及"拼接会被切坏"的负对照）
    //    在 `script/release-gate.test.ts` 的「机器结果与诊断分离」一组里用真 `runPackageScript` 钉住。
    const out = `${r.out}${r.err}`
    const rows = JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1)) as
      { id: string; implementation: string; driver: string | null; identities: string[] }[]
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBe(15)
    expect(rows.filter(x => !x.driver)).toEqual([])
    expect(rows.map(x => x.id)).toContain("g10b")
    // 新增的 identities 也在这条机器面上（g08g09 两行身份数不许在 JSON 里退化）。
    expect(rows.find(x => x.id === "g08g09")!.identities).toEqual(["G08", "G09"])
    expect(/[[\]]/.test(r.err)).toBe(false)
  })

  test("--json 只给已审计那一类；完整面看 --json-all（机器消费者别把 15 当门身份总数）", () => {
    const r = cli(["--json-all"])
    expect(r.code).toBe(0)
    const d = JSON.parse(r.out) as {
      audited: unknown[]; unaudited: unknown[]; routedOnly: unknown[]
      ledger: { file: string; kind: string }[]; coverage: { filesInDir: number; ledgerFiles: number }
      totals: Record<string, number>
    }
    expect(d.audited.length).toBe(15)
    expect(d.unaudited.length).toBe(7)
    expect(d.routedOnly.length).toBe(1)
    // 文件清单在机器面上也在，且判据（等式）跟着一起给。
    expect(d.ledger.length).toBe(countFilesOnDisk())
    expect(d.coverage.filesInDir).toBe(d.coverage.ledgerFiles)
    expect(d.totals.auditedFiles).toBe(15)
    expect(d.totals.auditedIdentities).toBe(16)
    expect(d.totals.driverFiles).toBe(16)
    expect(d.totals.unaudited).toBe(7)
    expect(d.totals.routedNoImplementation).toBe(1)
    expect(d.totals.identities).toBe(24)
    expect(d.totals.ledgerFiles).toBe(d.totals.filesInDir)
    expect(d.totals.unclassified).toBe(0)
  })

  test("单个门的查询：未纳入审计的门也答得出来（不再谎称「未找到实现」）", () => {
    const r = cli(["--gate", "G05"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("未纳入审计")
    expect(r.out).toContain("bun run script/refactor-verify.ts --gate G05")
    expect(r.out).not.toContain("未找到门")
    // 真的不存在的门号仍然 fail-closed
    expect(cli(["--gate", "G99"]).code).toBe(2)
  })
})
