/**
 * G15 一次性驱动：跑 `gateG15()` 并打印真实读数与退出码。
 *
 * 退出码语义与 `script/refactor-verify.ts` 的 `report()` 一致：
 * 0 全部通过；1 实际失败；2 必需依赖未完成（BLOCKED，例如本机无模型凭据）。
 *
 * 用法：bun run script/gates/run-g15.ts
 */
import { gateG15 } from "./g15.ts"

const result = await gateG15()
const failed = result.checks.filter(check => !check.ok)
for (const check of result.checks) console.log(`${check.ok ? "PASS" : "FAIL"}  ${result.gate}/${check.name}  ${check.detail}`)

let code = 0
if (failed.length) { console.log(`${result.gate}: ${result.checks.length - failed.length}/${result.checks.length} 通过，${failed.length} 失败`); code = 1 }
else if (result.blocked) { console.log(`BLOCKED  ${result.gate}  ${result.blocked}`); code = 2 }
else if (result.checks.length === 0) { console.log(`BLOCKED  ${result.gate}  该门没有已接线的真实入口`); code = 2 }
else console.log(`${result.gate}: ${result.checks.length}/${result.checks.length} 通过`)

console.log(`exit=${code}`)
process.exit(code)
