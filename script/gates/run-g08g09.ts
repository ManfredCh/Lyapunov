/**
 * G08 / G09 的一次性驱动：import 门实现并打印真实结果与退出码。
 *
 * 退出码语义与 `script/refactor-verify.ts` 一致：0 全部通过；1 实际失败；2 必需依赖未完成/未覆盖；
 * 两者同时存在时报更严重的那个（实测失败优先于阻断）。**退出码直接取门返回的 `tally.exitCode`**，
 * 与 stdout 里打印的四类计数同源，因此 `EXIT` 可由原件逐项复算（DEV-014）。
 * 用法：
 *   bun run script/gates/run-g08g09.ts --gate G08
 *   bun run script/gates/run-g08g09.ts --gate G09
 *   bun run script/gates/run-g08g09.ts --all
 */
import { gateG08, gateG09, g09Rows, type G08G09Result } from "./g08g09.ts"
import type { Check } from "./contract.ts"

/**
 * 与门内 `tallyGate` 同源的两条判据（未覆盖判据与薄入口 `script/refactor-verify.ts:996` 同一行）：
 * 未覆盖行与移出范围行都不进通过分子，所以**不能**打成 `PASS`，否则逐行数出来的通过数会与汇总不一致。
 */
const isUncovered = (check: Check): boolean => check.name.startsWith("contract/") || check.detail.includes("UNCOVERED")
const isRemoved = (check: Check): boolean => check.name.endsWith("removed_by_user")

/**
 * 打印一个门的原件并返回 `tally.exitCode`：每行标签与四类计数一一对应
 * （`PASS`=passed、`FAIL`=failed、`REMOVED`=removed、`UNCOVERED`=uncovered），汇总行给出四类计数与退出码。
 */
export function report(result: G08G09Result): number {
  const { tally } = result
  for (const check of result.checks) {
    console.log(`${isRemoved(check) ? "REMOVED" : isUncovered(check) && check.ok ? "UNCOVERED" : check.ok ? "PASS" : "FAIL"}  ${result.gate}/${check.name}  ${check.detail}`)
  }
  for (const row of result.removed) console.log(`REMOVED  ${result.gate}/${row.name}  ${row.status}  ${row.detail}`)
  // 没有 check 时不报"0/0 通过"——那行会被读成"有结论"（与薄入口同一处理）。
  if (result.checks.length === 0) { console.log(`BLOCKED  ${result.gate}  ${result.blocked ?? "该门没有已接线的真实入口"}`); return 2 }
  console.log(`${result.gate}: ${tally.passed}/${tally.judged} 通过，${tally.failed} 失败，移出范围 ${tally.removed}，未覆盖 ${tally.uncovered}（exitCode=${tally.exitCode}）`)
  if (result.blocked) console.log(`BLOCKED  ${result.gate}  ${result.blocked}`)
  return tally.exitCode
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const gateIndex = argv.indexOf("--gate")
  const requested = argv.includes("--all") ? ["G08", "G09"] : [gateIndex >= 0 ? (argv[gateIndex + 1] ?? "").toUpperCase() : ""]
  if (!requested[0]) { console.log("用法：bun run script/gates/run-g08g09.ts --gate G08|G09 | --all"); return 2 }

  const codes: number[] = []
  for (const gate of requested) {
    const code = gate === "G08" ? report(await gateG08()) : gate === "G09" ? report(await gateG09()) : (console.log(`未知门号 ${gate}`), 2)
    if (gate === "G09" && g09Rows.length) for (const row of g09Rows) console.log(`ROW  G09  ${row.engine}+${row.grasp}  ${row.status}  ${row.detail}`)
    codes.push(code)
  }
  const exitCode = aggregateExit(codes)
  console.log(`EXIT ${exitCode}`)
  return exitCode
}

/**
 * 多门聚合：**失败(1) 优先于阻断/未覆盖(2)**，与门内 `tallyGate` 及薄入口
 * `script/refactor-verify.ts:1088-1097` 同序。此前用 `Math.max` 取最坏值，于是"某门真失败(1)"
 * 会被"另一门阻断(2)"盖成 2，回执看起来只是"有未覆盖"，实际失败被吞掉。
 */
export function aggregateExit(codes: number[]): number {
  return codes.includes(1) ? 1 : codes.includes(2) ? 2 : 0
}

// `import.meta.main` 判定沿用本仓既有写法（`script/unity-mcp.ts`、`script/migrate-workspace-layout.ts` 等）：
// 被测试以库方式 import 时不跑门，直接执行时行为不变。
if (import.meta.main) process.exit(await main())
