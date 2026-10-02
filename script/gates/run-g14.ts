/**
 * G14 一次性驱动：独立跑 `gateG14()`，打印真实读数与退出码。
 *
 * 与 `script/refactor-verify.ts` 的退出码语义一致：
 * 0 全部通过；1 实际失败；2 因必需依赖未完成（BLOCKED）。
 *
 * 用法：export PATH="$HOME/.bun/bin:$PATH" && bun run script/gates/run-g14.ts
 */
import { gateG14 } from "./g14.ts"

const code = await (async () => {
  const result = await gateG14()
  for (const check of result.checks) console.log(`${check.ok ? "PASS" : "FAIL"}  ${result.gate}/${check.name}  ${check.detail}`)
  const failed = result.checks.filter(check => !check.ok)
  if (failed.length) { console.log(`${result.gate}: ${result.checks.length - failed.length}/${result.checks.length} 通过，${failed.length} 失败`); return 1 }
  if (result.blocked) { console.log(`BLOCKED  ${result.gate}  ${result.blocked}`); return 2 }
  if (!result.checks.length) { console.log(`BLOCKED  ${result.gate}  没有可执行的真实入口`); return 2 }
  console.log(`${result.gate}: ${result.checks.length}/${result.checks.length} 通过`)
  return 0
})()

console.log(`exitCode=${code}`)
process.exit(code)
