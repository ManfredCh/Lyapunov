/**
 * G19 驱动：`node script/gates/run-g19.ts`（本轮实测 `bun run script/gates/run-g19.ts` 同样可跑，见下）。
 *
 * ## 为什么必须有这个文件（机制 2 · 门的身份与驱动）
 *
 * `script/gates/g19.ts` 是纯导出实现（顶层零执行）：`bun run script/gates/g19.ts` 什么都不做且 exit 0，
 * 与"门通过"无法从退出码区分。机制 2（`bun run gate:drivers`）只认 `script/gates/run-<id>.ts`
 * 这一种驱动文件名——**本门原先只有 `run-g19.mts`**（且 `.mts` 不在机制的发现集合里），
 * 于是被报成 NO-DRIVER，W13 也就无法单独复跑 G19（只能经 `script/refactor-verify.ts` 汇总器跑到）。
 * 本文件补齐这个文件名；查正确命令：`bun run gate:drivers --gate G19`。
 *
 * ## 运行器
 *
 * `g19.ts` 文件头写的是 **node**，本轮两种运行器都实测过（各自完整跑一遍门）：
 *
 * ```
 * node script/gates/run-g19.ts   → G19: 10/10 通过（exitCode=2；exit 2 = 有未覆盖/依赖声明，不是失败）
 * bun  run script/gates/run-g19.ts → FAIL G19/exception  Export named 'getSystemErrorMessage' not found
 *                                    in module 'node:util' → 0/1 失败（exit 1）
 * ```
 *
 * 也就是说 bun 下那 1 是**运行器的假失败**、不是门的判据。而机制 2 的「正确命令」列由
 * `run-<id>.ts` 生成、固定写 `bun run …`——照表执行的人会拿到一个与门无关的 1。
 * 所以本驱动在 bun 下**自己切到 node**（`LYAPUNOV_G19_REEXEC=1` 防递归；node 不可用则明确 BLOCKED/2），
 * 让"表上的命令"与"门自己的运行器要求"一致，而不是把矛盾留给读者。
 * 门自身会 spawn `bun`（导入探针、浏览器播放探针）——**跑门时必须让 bun 在 PATH 上**。
 *
 * ## 计数口径（与 `run-g19.mts` 完全一致，改口径时两处必须同改）
 *
 * 未覆盖行（`contract/` 前缀 + `ok:true`，正文自述"不代表通过"）必须**单独成类**，不参与退出码分子：
 * 否则"断网跑的 10/10"与"真有 WebGL 浏览器"的 10/10 不等价（2026-09-22 R228 / DEV011-G19-COVERAGE
 * Round 8 的收口）。判据镜像 `g08g09.ts` 的唯一计数入口 `tallyGate`（该文件用了 TS 参数属性，
 * strip-only 运行器无法导入，故这里镜像算式）。退出码优先级：**1 实测失败 > 2 未覆盖/依赖缺失 > 0 全过**。
 *
 * 用法：bun run script/gates/run-g19.ts（或 node script/gates/run-g19.ts；`G19_KEEP=1` 保留临时目录）
 */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { gateG19 } from "./g19.ts"

// 运行器切换必须在跑门之前：bun 下 `gateG19()` 会在 dsh-tools 的模块图上崩（见文件头实测）。
if (process.versions.bun && process.env.LYAPUNOV_G19_REEXEC !== "1") {
  const child = spawnSync("node", [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit", env: { ...process.env, LYAPUNOV_G19_REEXEC: "1" },
  })
  if (child.error) {
    console.log(`BLOCKED  G19  本门必须在 node 下运行（bun 的 dsh-tools 模块图缺 node:util 导出），`
      + `而 node 无法启动：${String(child.error.message)}`)
    process.exit(2)
  }
  process.exit(child.status ?? 1)
}

const result = await gateG19()
const isUncovered = (check: { name: string; detail: string }): boolean =>
  check.name.startsWith("contract/") || check.detail.includes("UNCOVERED")
const stripped = result.checks.filter(check => isUncovered(check) && check.ok)
const failed = result.checks.filter(check => !stripped.includes(check) && !check.ok)
const passed = result.checks.length - stripped.length - failed.length
const uncovered = stripped.length
const exitCode = failed.length > 0 ? 1 : result.blocked !== null || uncovered > 0 ? 2 : 0

for (const check of result.checks) {
  if (stripped.includes(check)) { console.log(`UNCOVERED  ${result.gate}/${check.name}  ${check.detail}`); continue }
  console.log(`${check.ok ? "PASS" : "FAIL"}  ${result.gate}/${check.name}  ${check.detail}`)
}
if (result.checks.length === 0) { console.log(`BLOCKED  ${result.gate}  没有已接线的真实入口`); process.exit(2) }
console.log(`${result.gate}: ${passed}/${passed + failed.length} 通过${failed.length ? `，${failed.length} 失败` : ""}${uncovered ? `，另有未覆盖 ${uncovered} 条` : ""}（exitCode=${exitCode}）`)
// 本门恒有"未覆盖"声明（照片真值精度与 WebGL 播放需外部条件），故全过后仍以 2 收尾并打印声明。
if (failed.length === 0 && result.blocked) console.log(`BLOCKED  ${result.gate}  ${result.blocked}`)
process.exit(exitCode)
