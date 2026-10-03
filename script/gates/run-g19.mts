/**
 * G19 驱动：`node script/gates/run-g19.mts`
 *
 * 必须用 **node**：bun 下 `dsh-tools` 的模块图会因 `node:util` 缺 `getSystemErrorMessage` 而崩
 * （与 G10b 同理，已实测）。退出码语义同合同 §6.4：0 全过 / 1 实测失败 / 2 有未覆盖或依赖缺失。
 */
import { gateG19 } from "./g19.ts"

const result = await gateG19()
// 未覆盖行（`g19.ts:255` 约定：`contract/` 前缀 + `ok:true` 报成 UNCOVERED，"不参与退出码分子"）必须
// **单独成类**：判据与算式镜像 DEV-014 收口的唯一计数入口 `tallyGate`（`g08g09.ts:101/113`）。此前本驱动
// 只看 `check.ok`，于是 `contract/browser_viewer_probe_environment`（正文自述"不代表通过"）被打印成 PASS
// 并计入通过分子 ⇒ 断网跑的 10/10 与"真有 WebGL 浏览器"的 10/10 不等价（2026-09-22 R228 登记，
// 缺陷回执 DEV011-G19-COVERAGE-20260922.md Round 8）。
// 不能直接 `import { tallyGate } from "./g08g09.ts"`：该文件用了 TS 参数属性，而本驱动必须用 node
// （见文件头），node 的 strip-only 模式会以 "TypeScript parameter property is not supported in
// strip-only mode" 直接崩 —— 已实测。故这里镜像同一判据，改口径时两处必须同改。
const isUncovered = (check: { name: string; detail: string }): boolean =>
  check.name.startsWith("contract/") || check.detail.includes("UNCOVERED")
const stripped = result.checks.filter(check => isUncovered(check) && check.ok)
const failed = result.checks.filter(check => !stripped.includes(check) && !check.ok)
const passed = result.checks.length - stripped.length - failed.length
const uncovered = stripped.length
// 失败永远优先于"未覆盖/阻断"：1 实际失败 > 2 未覆盖或依赖缺失 > 0 全过（与 `tallyGate` 同一优先级）。
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
