/**
 * G10 的一次性自证驱动（临时文件，不进产品链）。
 *
 * 用法：`bun run script/gates/run-g10.ts`
 * 退出码语义与合同 §6.4 一致：0 全部通过；1 实际失败；2 必需依赖未完成（BLOCKED）。
 */
import { gateG10 } from "./g10.ts"

const result = await gateG10()
for (const check of result.checks) console.log(`${check.ok ? "PASS" : "FAIL"}  ${result.gate}/${check.name}  ${check.detail}`)
const failed = result.checks.filter(check => !check.ok)
if (failed.length) { console.log(`${result.gate}: ${result.checks.length - failed.length}/${result.checks.length} 通过，${failed.length} 失败`); process.exit(1) }
if (result.blocked) { console.log(`BLOCKED  ${result.gate}  ${result.blocked}`); process.exit(2) }
if (result.checks.length === 0) { console.log(`BLOCKED  ${result.gate}  该门没有已接线的真实入口`); process.exit(2) }
console.log(`${result.gate}: ${result.checks.length}/${result.checks.length} 通过`)
process.exit(0)
