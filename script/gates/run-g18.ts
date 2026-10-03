/**
 * G18 驱动：`bun run script/gates/run-g18.ts`（或 `node script/gates/run-g18.ts`）。
 *
 * 与 run-g12 同一套输出与退出码语义：0 全部覆盖项通过 / 1 有真实失败 / 2 依赖未就绪（BLOCKED）。
 * 本门不登记 UNCOVERED 条目：合同三条（附着、文字随采集落盘、模型可取回同源编号）都在真实浏览器里可判定，
 * 凡是没测到的都以 BLOCKED 如实报出，不写成"通过"。
 */
import { gateG18 } from "./g18.ts"

const result = await gateG18()
for (const check of result.checks) console.log(`${check.ok ? "PASS" : "FAIL"}  ${result.gate}/${check.name}  ${check.detail}`)
const failed = result.checks.filter(check => !check.ok)
if (failed.length) {
  console.log(`${result.gate}: ${String(result.checks.length - failed.length)}/${String(result.checks.length)} 通过，${String(failed.length)} 失败`)
  process.exit(1)
}
if (result.blocked) { console.log(`BLOCKED  ${result.gate}  ${result.blocked}`); process.exit(2) }
console.log(`${result.gate}: 覆盖项 ${String(result.checks.length)}/${String(result.checks.length)} 通过`)
process.exit(0)
