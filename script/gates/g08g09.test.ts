/**
 * DEV-014 计数口径的局部测试：`export PATH="$HOME/.bun/bin:$PATH"; bun test script/gates/g08g09.test.ts`。
 *
 * 测的是**计数与退出码**，不是复述源码：
 *  · 负对照 1（构造 removed 行）：移出范围行即使以 `ok:true` 留在 `checks` 里，也不计入 passed；
 *    正式路径里它们更已移出 `checks`，只登记在返回结构的 `removed` 列表；
 *  · 负对照 2（真实执行）：一条真实失败经**真实子进程退出码**返回 1（且高于同场的阻断），不是纸面断言；
 *  · 移出范围（`REMOVED_BY_USER`）与未覆盖（`contract/` 前缀 + `UNCOVERED`）分开计数；
 *  · 退出码优先级与薄入口一致：1 实际失败 > 2 阻断/未覆盖 > 0 全部通过；
 *  · 驱动原件（`run-g08g09.ts` 的 `report()`）把 `removed`／四类计数／`exitCode` 真的打出来：
 *    `PASS` 行数=passed、`FAIL` 行数=failed、`REMOVED` 行数=removed、`UNCOVERED` 行数=uncovered，
 *    逐行可复算；真实失败经真实子进程退出码返回 1。
 *  · **薄入口 `script/refactor-verify.ts` 由真实子进程观测**（DEV-014 收口）：此前"与薄入口逐项一致"
 *    是假测试——本文件只 import 门与驱动，把薄入口 `report()` 的算式抄进测试自己算，所以薄入口真的丢了
 *    `removed`／`tally` 也照样全绿。现在改为跑 `refactor-verify.ts --gate G08/G09` 并逐行解析 stdout，
 *    与**门的返回原件**（另一个真实子进程 import `g08g09.ts` 调 `gateG08()/gateG09()` 打出的 JSON）比对，
 *    测试里不再复制薄入口的任何算式。
 *
 * 门本体在薄入口子进程里真实执行；本文件的自建子进程只用来取门返回的原件，不另行断言引擎行为。
 * 为让结构确定，子进程环境固定 `LYAPUNOV_GRASPGENX_AUTOSTART=0` 且把 `LYAPUNOV_ISAAC_PYTHON` 指向
 * 不存在的解释器（Isaac 行走"外部运行时缺失"的确定分支，避免 120s 探测抖动）：这只固定引擎可用性，
 * 不代表 Isaac 引擎实测；MuJoCo 行仍真实执行。
 */
import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { Check } from "./contract.ts"
import { tallyGate, type G08G09Result, type RemovedScope } from "./g08g09.ts"
import { report, aggregateExit } from "./run-g08g09.ts"

/** 与 `g08g09.ts` 里登记的名字/状态/文案逐字一致的移出范围行（负对照的构造输入）。 */
const removedRows: RemovedScope[] = [
  {
    name: "row_mujoco_anygrasp_removed_by_user",
    status: "REMOVED_BY_USER",
    detail: "非通过项（范围说明）：MuJoCo+AnyGrasp 行按用户明确指示 removed_by_user，本轮不安装 SDK/权重/许可、不推理、不计入 G09 主动分母，也不作为阻断项。",
  },
  {
    name: "row_isaac_anygrasp_removed_by_user",
    status: "REMOVED_BY_USER",
    detail: "非通过项（范围说明）：Isaac+AnyGrasp 行按用户明确指示 removed_by_user；该行不计入主动分母，也不伪造成通过。",
  },
]

const realPass: Check = { name: "mujoco_graspgenx_pick_contact_and_hold", ok: true, detail: "真实接触抓取闭环（实测抬升 0.108m、保持 0.5s、放置支撑接触>0）" }
const realFail: Check = { name: "mujoco_graspgenx_pick_contact_and_hold", ok: false, detail: "真实执行未闭环（实测抬升 0.000m，判据 ≥0.08m）" }
const uncoveredRow: Check = { name: "contract/isaac_provider_real_load_step", ok: true, detail: "UNCOVERED（不计入通过分子，不代表通过）—— 缺外部运行时，非产品失败" }

test("负对照 1：removed 行不进通过数（正式路径：登记在 removed，不在 checks）", () => {
  const tally = tallyGate({ checks: [realPass], blocked: null, removed: removedRows })
  expect(tally.checks).toBe(1) // 分母里没有 removed 行
  expect(tally.judged).toBe(1)
  expect(tally.passed).toBe(1) // 只有真实通过项
  expect(tally.failed).toBe(0)
  expect(tally.removed).toBe(2) // removed 行单独计数
  expect(tally.uncovered).toBe(0)
  expect(tally.exitCode).toBe(0) // 移出范围不导致门失败，也不抬高通过数
})

test("负对照 1b：removed 行就算以 ok:true 留在 checks 里，也只算移出范围、不算通过", () => {
  // 修复前形态（原第 727/755 行）：范围说明行以 ok:true 混进 checks，于是被算成通过。
  const legacyShape: Check = { name: "row_mujoco_anygrasp_removed_by_user", ok: true, detail: "非通过项（范围说明）：修复前它以 ok:true 混进 checks" }
  const tally = tallyGate({ checks: [realPass, legacyShape], blocked: null, removed: [] })
  expect(tally.passed).toBe(1) // 修复前这里是 2（把范围说明算成通过）
  expect(tally.removed).toBe(1) // 现在单独计入移出范围
  expect(tally.judged).toBe(1)
  expect(tally.exitCode).toBe(0) // 既不算失败，也不改退出码
})

test("负对照 2：真实失败经真实子进程退出码返回 1（真实执行，且优先于同场阻断）", () => {
  const modulePath = join(import.meta.dirname, "g08g09.ts")
  const child = spawnSync(process.execPath, ["-e", [
    `import { tallyGate } from ${JSON.stringify(modulePath)}`,
    `const removed = ${JSON.stringify(removedRows)}`,
    `const checks = [{ name: "mujoco_graspgenx_pick_contact_and_hold", ok: false, detail: "真实失败：实测抬升 0.000m（判据 ≥0.08m）" }]`,
    `const tally = tallyGate({ checks, blocked: "GraspGenX worker：未配置真实 worker", removed })`,
    `console.log(JSON.stringify({ passed: tally.passed, failed: tally.failed, removed: tally.removed, exitCode: tally.exitCode }))`,
    `process.exit(tally.exitCode)`,
  ].join("\n")], { encoding: "utf8" })
  expect(child.status).toBe(1) // 非 0：真实失败没有被阻断/移出范围吞掉
  expect(child.stdout.trim()).toBe(JSON.stringify({ passed: 0, failed: 1, removed: 2, exitCode: 1 }))
})

test("移出范围与未覆盖分开计数：未覆盖仍让门不宣称全通过（退出 2），移出范围不改变退出码", () => {
  const tally = tallyGate({ checks: [realPass, uncoveredRow], blocked: null, removed: removedRows })
  expect(tally.passed).toBe(1)
  expect(tally.uncovered).toBe(1)
  expect(tally.judged).toBe(1)
  expect(tally.removed).toBe(2)
  expect(tally.exitCode).toBe(2)
})

test("退出码优先级与薄入口一致：1 实际失败 > 2 阻断/未覆盖 > 0 全部通过", () => {
  expect(tallyGate({ checks: [realPass, realFail], blocked: "缺 GraspGenX worker", removed: removedRows }).exitCode).toBe(1)
  expect(tallyGate({ checks: [realPass], blocked: "缺 GraspGenX worker", removed: removedRows }).exitCode).toBe(2)
  expect(tallyGate({ checks: [realPass, uncoveredRow], blocked: null, removed: removedRows }).exitCode).toBe(2)
  expect(tallyGate({ checks: [realPass], blocked: null, removed: removedRows }).exitCode).toBe(0)
})

/* ------------------------------------------------- 薄入口（真实子进程）观测，DEV-014 收口 */

const SCRIPT_ROOT = join(import.meta.dirname, "..")
const THIN_ENTRY = join(SCRIPT_ROOT, "refactor-verify.ts")
const GATE_MODULE = join(import.meta.dirname, "g08g09.ts")

/** 固定引擎可用性的子进程环境：不启动 GraspGenX worker，Isaac 解释器指向不存在路径。 */
function gateEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LYAPUNOV_GRASPGENX_AUTOSTART: "0", LYAPUNOV_ISAAC_PYTHON: join(SCRIPT_ROOT, "gates", "no-such-isaac-python") }
  delete env.GRASPGENX_ENDPOINT
  delete env.LYAPUNOV_GRASPGENX_CONTAINER
  return env
}

/** 门返回的原件（不是驱动输出，也不是薄入口输出）：真实执行 `gateG08()/gateG09()` 后序列化。 */
interface GateSnapshot {
  gate: string
  checks: Array<{ name: string; ok: boolean }>
  removed: Array<{ name: string; status: string }>
  tally: { checks: number; judged: number; passed: number; failed: number; removed: number; uncovered: number; exitCode: number }
}

let snapshots: Record<string, GateSnapshot> | undefined

function gateSnapshots(): Record<string, GateSnapshot> {
  if (snapshots) return snapshots
  const child = spawnSync(process.execPath, ["-e", [
    `import { gateG08, gateG09 } from ${JSON.stringify(GATE_MODULE)}`,
    `const out = {}`,
    `for (const [gate, run] of [["G08", gateG08], ["G09", gateG09]]) { const r = await run(); out[gate] = { gate: r.gate, checks: r.checks.map(c => ({ name: c.name, ok: c.ok })), removed: r.removed.map(x => ({ name: x.name, status: x.status })), tally: r.tally } }`,
    `console.log("__GATE_SNAPSHOT__" + JSON.stringify(out))`,
  ].join("\n")], { encoding: "utf8", env: gateEnv(), timeout: 300000 })
  const line = (child.stdout ?? "").split("\n").find(row => row.startsWith("__GATE_SNAPSHOT__"))
  if (child.status !== 0 || !line) throw new Error(`门返回快照子进程失败 status=${child.status} stderr=${(child.stderr ?? "").slice(-800)}`)
  snapshots = JSON.parse(line.slice("__GATE_SNAPSHOT__".length)) as Record<string, GateSnapshot>
  return snapshots
}

/** 真实运行薄入口并对每个门只跑一次（两个用例共用同一份薄入口输出）。 */
const thinEntryRuns = new Map<string, { status: number | null; lines: string[] }>()

function thinEntry(gate: "G08" | "G09"): { status: number | null; lines: string[] } {
  const cached = thinEntryRuns.get(gate)
  if (cached) return cached
  const child = spawnSync(process.execPath, [THIN_ENTRY, "--gate", gate], { encoding: "utf8", env: gateEnv(), timeout: 300000 })
  const run = { status: child.status, lines: (child.stdout ?? "").split("\n").filter(line => line.length > 0) }
  thinEntryRuns.set(gate, run)
  return run
}

/** 某个标签下出现的 check 名（行格式 `LABEL  G08/<name>  <detail>`）。 */
const namesWith = (lines: string[], label: string, gate: string): string[] =>
  lines.filter(line => line.startsWith(`${label}  ${gate}/`)).map(line => line.slice(`${label}  ${gate}/`.length).split("  ")[0]!)
const labelCount = (lines: string[], label: string): number => lines.filter(line => line.startsWith(`${label}  `)).length

/** 汇总行必须是四类计数 + exitCode；解析失败即薄入口没有补齐（而不是测试自己算）。 */
function summaryOf(lines: string[], gate: string) {
  const line = lines.find(row => row.startsWith(`${gate}: `))
  if (!line) throw new Error(`薄入口没有 ${gate} 汇总行:\n${lines.join("\n")}`)
  const match = /^\S+: (\d+)\/(\d+) 通过，(\d+) 失败，移出范围 (\d+)，未覆盖 (\d+)（exitCode=(\d+)）$/.exec(line)
  if (!match) throw new Error(`薄入口 ${gate} 汇总行不是四类计数格式：${line}`)
  return { passed: Number(match[1]), judged: Number(match[2]), failed: Number(match[3]), removed: Number(match[4]), uncovered: Number(match[5]), exitCode: Number(match[6]) }
}

/** 薄入口 stdout 的每一行都必须与门返回的原件对得上：分类、名字、四类计数、removed 行、exitCode。 */
function expectThinEntryMatchesGate(gate: "G08" | "G09") {
  const snapshot = gateSnapshots()[gate]!
  const { status, lines } = thinEntry(gate)
  // 1) 每条 check 都出现且分类正确：FAIL 集合 = 门里 ok:false 的 check；ok:true 的必须落在 PASS 或 UNCOVERED。
  expect(namesWith(lines, "FAIL", gate).sort()).toEqual(snapshot.checks.filter(check => !check.ok).map(check => check.name).sort())
  expect([...namesWith(lines, "PASS", gate), ...namesWith(lines, "UNCOVERED", gate)].sort()).toEqual(snapshot.checks.filter(check => check.ok).map(check => check.name).sort())
  // 2) 四类计数逐行数出来必须等于门的 tally（薄入口不得自己重算成别的数）。
  expect(labelCount(lines, "PASS")).toBe(snapshot.tally.passed)
  expect(labelCount(lines, "FAIL")).toBe(snapshot.tally.failed)
  expect(labelCount(lines, "REMOVED")).toBe(snapshot.tally.removed)
  expect(labelCount(lines, "UNCOVERED")).toBe(snapshot.tally.uncovered)
  // 3) removed 行的名字与 RowStatus 逐条来自门的 removed（不进通过分子、也不打成 PASS）。
  expect(namesWith(lines, "REMOVED", gate)).toEqual(snapshot.removed.map(row => row.name))
  expect(lines.filter(line => line.startsWith(`REMOVED  ${gate}/`)).map(line => line.split("  ")[2])).toEqual(snapshot.removed.map(row => row.status))
  expect(lines.filter(line => line.startsWith(`PASS  ${gate}/`) && line.includes("removed_by_user"))).toEqual([])
  // 4) 汇总行 = 门 tally；真实进程退出码 = 打印的 exitCode = tally.exitCode。
  expect(summaryOf(lines, gate)).toEqual({
    passed: snapshot.tally.passed, judged: snapshot.tally.judged, failed: snapshot.tally.failed,
    removed: snapshot.tally.removed, uncovered: snapshot.tally.uncovered, exitCode: snapshot.tally.exitCode,
  })
  expect(status).toBe(snapshot.tally.exitCode)
  // 5) 判别力前提：本次真实运行确实同时出现未覆盖与移出范围两类，且 contract/* 未覆盖行不得打 PASS。
  expect(snapshot.tally.uncovered).toBeGreaterThan(0)
  expect(snapshot.tally.removed).toBeGreaterThan(0)
  expect(lines.filter(line => line.startsWith(`PASS  ${gate}/contract/`))).toEqual([])
}

// G08 要真实起子进程跑门（含 GraspGenX 存在性探测），实测约 6.0s，超过 bun 默认 5s 上限；
// 给显式预算，避免把它误报成"薄入口不一致"。G09 实测 0.4s，保持默认。
test("薄入口真实子进程：G08 的 removed 行与四类计数与门返回逐项一致", () => {
  expectThinEntryMatchesGate("G08")
}, 30_000)

test("薄入口真实子进程：G09 的 removed 行与四类计数与门返回逐项一致", () => {
  expectThinEntryMatchesGate("G09")
})

/** 捕获 `console.log` 的行（驱动把原件打在 stdout；测试直接读这些行，不复制一份打印逻辑）。 */
function capture(run: () => number): { code: number; lines: string[] } {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => { lines.push(args.map(value => String(value)).join(" ")) }
  try { return { code: run(), lines } } finally { console.log = original }
}
/** 按驱动行标签复算某一类的条数（`PASS`／`FAIL`／`REMOVED`／`UNCOVERED`）。 */
const counted = (lines: string[], label: string): number => lines.filter(line => line.startsWith(`${label}  `)).length

test("驱动原件（负对照）：removed 行出现在输出里，但不计入 passed", () => {
  const checks: Check[] = [realPass]
  const result: G08G09Result = { gate: "G09", checks, removed: removedRows, blocked: null, tally: tallyGate({ checks, blocked: null, removed: removedRows }) }
  const { code, lines } = capture(() => report(result))
  expect(code).toBe(0) // 移出范围既不失败，也不抬高通过数
  expect(lines).toContain(`REMOVED  G09/row_mujoco_anygrasp_removed_by_user  REMOVED_BY_USER  ${removedRows[0]!.detail}`)
  expect(lines.filter(line => line.startsWith("PASS  G09/row_mujoco_anygrasp_removed_by_user"))).toEqual([]) // 不再冒充通过
  expect(lines).toContain("G09: 1/1 通过，0 失败，移出范围 2，未覆盖 0（exitCode=0）")
  expect(counted(lines, "PASS")).toBe(result.tally.passed) // 逐行可复算
  expect(counted(lines, "FAIL")).toBe(result.tally.failed)
  expect(counted(lines, "REMOVED")).toBe(result.tally.removed)
})

test("驱动原件：未覆盖行不打成 PASS，四类计数与 tally 逐项一致", () => {
  const checks: Check[] = [realPass, uncoveredRow]
  const blocked = "GraspGenX worker：未配置真实 worker"
  const result: G08G09Result = { gate: "G09", checks, removed: removedRows, blocked, tally: tallyGate({ checks, blocked, removed: removedRows }) }
  const { code, lines } = capture(() => report(result))
  expect(code).toBe(2) // 未覆盖/阻断：不宣称全通过，也不是失败
  expect(counted(lines, "PASS")).toBe(1)
  expect(counted(lines, "UNCOVERED")).toBe(1)
  expect(counted(lines, "REMOVED")).toBe(2)
  expect(lines.filter(line => line.startsWith("PASS  G09/contract/"))).toEqual([])
  expect(lines).toContain("G09: 1/1 通过，0 失败，移出范围 2，未覆盖 1（exitCode=2）")
  expect(lines).toContain(`BLOCKED  G09  ${blocked}`)
})

test("负对照 3（真实子进程）：真实失败经驱动原件退出码返回 1", () => {
  const driverPath = join(import.meta.dirname, "run-g08g09.ts")
  const gatePath = join(import.meta.dirname, "g08g09.ts")
  const child = spawnSync(process.execPath, ["-e", [
    `import { report } from ${JSON.stringify(driverPath)}`,
    `import { tallyGate } from ${JSON.stringify(gatePath)}`,
    `const removed = ${JSON.stringify(removedRows)}`,
    `const checks = [{ name: "mujoco_graspgenx_pick_contact_and_hold", ok: false, detail: "真实失败：实测抬升 0.000m（判据 ≥0.08m）" }]`,
    `const blocked = "GraspGenX worker：未配置真实 worker"`,
    `process.exit(report({ gate: "G09", checks, removed, blocked, tally: tallyGate({ checks, blocked, removed }) }))`,
  ].join("\n")], { encoding: "utf8" })
  expect(child.status).toBe(1) // 真实失败：非 0，且不被同场阻断改成 2
  expect(child.stdout).toContain("FAIL  G09/mujoco_graspgenx_pick_contact_and_hold")
  expect(child.stdout).toContain("REMOVED  G09/row_mujoco_anygrasp_removed_by_user")
  expect(child.stdout).toContain("G09: 0/1 通过，1 失败，移出范围 2，未覆盖 0（exitCode=1）")
})

test("驱动入口（真实子进程）：import.meta.main 判定下 CLI 仍可用，未知门号退出 2", () => {
  const child = spawnSync(process.execPath, [join(import.meta.dirname, "run-g08g09.ts"), "--gate", "G99"], { encoding: "utf8" })
  expect(child.status).toBe(2)
  expect(child.stdout).toContain("未知门号 G99")
  expect(child.stdout).toContain("EXIT 2")
})

test("多门聚合：失败 1 优先于阻断/未覆盖 2（负对照：此前 Math.max 会把 [2,1] 报成 2）", () => {
  expect(aggregateExit([0, 0])).toBe(0)
  expect(aggregateExit([0, 2])).toBe(2)
  expect(aggregateExit([2, 1])).toBe(1)
  expect(aggregateExit([1, 2])).toBe(1)
})

/* ------------------ 新判据（`modelVersion` 非空 ＋ 点云夹具必须取到仓内件）的判据级钉法 */

/**
 * 这两条判据由 `UNREDDABLE-CRITERIA-20260926` 新加（其回执 §①／§②，`docs/REMAINING_WORK_PLAN.md` §7.22），
 * 而本文件的子进程夹具把 **GraspGenX 与 Isaac 都关掉**（`LYAPUNOV_GRASPGENX_AUTOSTART=0` ＋ 不存在的 Isaac 解释器）
 * ⇒ 门里那三处 check 一处都走不到：G08 的 Isaac 行与 G09 的 isaac 探针按设计落成 `contract/…` UNCOVERED，
 * 点云那条在 `ensureGraspGenXWorker()` 成功分支内。**⇒ 新判据不在既有 12 条的覆盖内**，故在此单独钉两条。
 *
 * 两条**都不启动任何引擎**（不碰 GraspGenX、不碰 Isaac ⇒ 不会撞上 G08 那条已登记的采样抖动）：
 *   ① 子进程真实 `import` 门模块，直接求值门导出的两个**纯判据**（门自己写"导出（不改判定）"就是为此）；
 *      用子进程而不是顶层 import：导出被删时本文件其余用例照旧跑，**只有这两条精确变红**。
 *   ② 读门源码钉住**调用点**（"函数还在、但没人调"必须也能红）。
 * ② 是这两条判据唯一的静态面：Isaac 真跑的行为面在本文件里取不到 —— **如实登记，不假装覆盖**。
 */
interface CriteriaProbe {
  table: { legacy: boolean[]; real: boolean[]; oldForm: boolean[]; spacedPlaceholder: boolean }
  clouds: Record<"inside" | "outside", { name: string; ok: boolean; detail: string; path: string }>
}

const GATE_SOURCE = join(import.meta.dirname, "g08g09.ts")
const PRODUCT_ROOT = join(import.meta.dirname, "..", "..")
/** 仓内那份真实点云夹具（与门里 `POINT_CLOUD_FIXTURES[0]` 同一布局）。 */
const CLOUD_INSIDE = join(PRODUCT_ROOT, "bugfixHistory/refactor-execution/D-evidence/cube40-cloud.json")
/** 门里 `POINT_CLOUD_FIXTURES[1]` 那条**仓外**回退路径（DEV-027 §3.2 的"静默回退"形状）。 */
const CLOUD_OUTSIDE = join(PRODUCT_ROOT, "..", "DSH/bugfixHistory/refactor-execution/D-evidence/cube40-cloud.json")

let criteria: CriteriaProbe | undefined
function criteriaProbe(): CriteriaProbe {
  if (criteria) return criteria
  const child = spawnSync(process.execPath, ["-e", [
    `import { hasRealModelVersion, pointCloudSourceCheck } from ${JSON.stringify(GATE_SOURCE)}`,
    `const legacy = ["[]", "", "   ", null, undefined, 42, [], {}]`,
    `const real = ["mujoco:/x/franka_emika_panda/panda.xml", "isaac-usd:/World#12res"]`,
    `const clouds = {}`,
    `for (const [key, path] of [["inside", ${JSON.stringify(CLOUD_INSIDE)}], ["outside", ${JSON.stringify(CLOUD_OUTSIDE)}]]) clouds[key] = { ...pointCloudSourceCheck({ path, source: "判据级夹具" }), path }`,
    `console.log("__CRITERIA__" + JSON.stringify({ table: { legacy: legacy.map(v => hasRealModelVersion(v)), real: real.map(v => hasRealModelVersion(v)), oldForm: legacy.map(v => Boolean(v)), spacedPlaceholder: hasRealModelVersion("[ ]") }, clouds }))`,
  ].join("\n")], { encoding: "utf8", timeout: 60_000 })
  const line = (child.stdout ?? "").split("\n").find(row => row.startsWith("__CRITERIA__"))
  if (child.status !== 0 || !line) throw new Error(`判据求值子进程失败 status=${child.status} stderr=${(child.stderr ?? "").slice(-800)}`)
  criteria = JSON.parse(line.slice("__CRITERIA__".length)) as CriteriaProbe
  return criteria
}

const gateSource = (): string => readFileSync(GATE_SOURCE, "utf8")
const countOf = (text: string, needle: string): number => text.split(needle).length - 1
/**
 * 只留**代码**行（去掉 `//`、`/*`、`*` 开头的注释行）。
 * 旧形态 `Boolean(description.modelVersion)` 出现在注释里是**对的**（那两处正是"此判据为什么不可能红"的登记），
 * 要判的是它在**代码**里不剩一处。
 */
const codeOnly = (text: string): string => text.split("\n").filter(line => !/^\s*(\/\/|\/\*|\*)/.test(line)).join("\n")

test("新判据①（DEV-027 §3.5）：`modelVersion` 的缺陷值必须判红，且门里两个调用点都在", () => {
  const { table } = criteriaProbe()
  // 判据级读数：`"[]"`／空串／纯空白／非字符串一律 false（G08 的 Isaac 行与 G09 的 isaac 探针都用它）。
  expect(table.legacy).toEqual([false, false, false, false, false, false, false, false])
  expect(table.real).toEqual([true, true])
  // 旧判据为什么"永远不可能变红"：`Boolean("[]") === true` —— 这一条就是那一处的判据级证据。
  expect(table.oldForm[0]).toBe(true)
  // 已知边界（如实钉住，不假装它被排除）：判据只排除**逐字** `"[]"`（与 `refactor-verify.ts:776` 同源），
  // 带空格的 `"[ ]"` 会通过。收紧它＝改判定（会破坏"两侧逐字同源"），不在本文件里做。
  expect(table.spacedPlaceholder).toBe(true)
  // 调用点（"函数还在、但没人调"也必须红）：G08 的 Isaac 行 ＋ G09 的 isaac 探针 ＝ 2 处，且都吃 `description.modelVersion`。
  const source = gateSource()
  expect(countOf(source, "hasRealModelVersion(description.modelVersion)")).toBe(2)
  // 旧形态在**代码**里一处都不许剩（注释里引用它是对的：那两处正是"判据为什么不可能红"的登记）。
  expect(countOf(source, "Boolean(description.modelVersion)")).toBe(2) // 都在注释里（:163 与 :576）
  expect(codeOnly(source).includes("Boolean(description.modelVersion)")).toBe(false)
}, 30_000)

test("新判据②（点云夹具必须取到仓内件）：仓外路径必须判红，且门里两处调用点都在", () => {
  const { clouds } = criteriaProbe()
  expect(clouds.inside.name).toBe("point_cloud_fixture_source_inside_repo")
  expect(clouds.inside.ok).toBe(true) // 仓内夹具 ⇒ 不红（判据不得恒红）
  expect(clouds.outside.name).toBe("point_cloud_fixture_source_inside_repo")
  expect(clouds.outside.ok).toBe(false) // ← 静默回退到仓外 `../DSH` 时，这一条必须红
  // 路径与"仓内/仓外"标注都进 detail（"取到的是哪一份"要能从读数里看出来，而不是只写在代码里）。
  expect(clouds.inside.detail).toContain(clouds.inside.path)
  expect(clouds.outside.detail).toContain(clouds.outside.path)
  expect(clouds.inside.detail).toContain("仓内")
  expect(clouds.outside.detail).toContain("仓外")
  // 调用点：G08 一处 ＋ G09 行内一处（`rowGraspGenX` 对 mujoco/isaac **各跑一次** ⇒ 运行期 check 数 +3，与登记一致）。
  const source = gateSource()
  expect(countOf(source, "checks.push(pointCloudSourceCheck(cloud")).toBe(2)
  expect(countOf(source, 'rowGraspGenX("mujoco"') + countOf(source, 'rowGraspGenX("isaac"')).toBe(2)
}, 30_000)
