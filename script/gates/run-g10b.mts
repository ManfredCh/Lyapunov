/**
 * G10b 驱动。必须在 **node** 下运行（bun 无法加载 dsh-subprocess-local）：
 *   node script/gates/run-g10b.ts
 */
import { gateG10b } from "./g10b.mts"

const result = await gateG10b()
for (const check of result.checks) console.log(`${check.ok ? "PASS" : "FAIL"}  ${result.gate}/${check.name}  ${check.detail}`)
if (result.blocked) { console.log(`BLOCKED  ${result.gate}  ${result.blocked}`); process.exit(2) }
if (!result.checks.length) { console.log(`BLOCKED  ${result.gate}  没有已接线的真实入口`); process.exit(2) }
const failed = result.checks.filter(check => !check.ok)
if (failed.length) { console.log(`${result.gate}: ${result.checks.length - failed.length}/${result.checks.length} 通过，${failed.length} 失败`); process.exit(1) }
console.log(`${result.gate}: ${result.checks.length}/${result.checks.length} 通过`)
process.exit(0)
