/** G01-live 驱动：bun run script/gates/run-g01-live.ts */
import { gateG01Live } from "./g01-live.ts"
const result = await gateG01Live()
for (const check of result.checks) console.log(`${check.ok ? "PASS" : "FAIL"}  ${result.gate}/${check.name}  ${check.detail}`)
if (result.blocked) console.log(`BLOCKED  ${result.gate}  ${result.blocked}`)
if (!result.checks.length) process.exit(2)
if (result.checks.some(check => !check.ok)) { console.log(`${result.gate}: ${result.checks.filter(c => c.ok).length}/${result.checks.length} 通过`); process.exit(1) }
console.log(`${result.gate}: ${result.checks.length}/${result.checks.length} 通过`)
process.exit(result.blocked ? 2 : 0)
