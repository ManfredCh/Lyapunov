/**
 * G12 驱动：`bun run script/gates/run-g12.ts`
 *
 * 输出分三段，便于区分"真失败"与"本环境覆盖不到的合同条件"：
 *   1. 覆盖到并真实判定的 check（PASS/FAIL）
 *   2. 合同条件里本环境无法覆盖的部分（UNCOVERED，既不算通过也不算失败）
 *   3. 汇总与退出码：0 全部覆盖项通过 / 1 有真实失败 / 2 必需依赖未就绪
 *
 * UNCOVERED 在本驱动里**使退出码为 2** —— 与薄入口 `--gate G12` 的 `tallyGate`（`uncovered > 0 ⇒ 2`）
 * 及统一文案「未覆盖条件不计入通过分子，但**使退出码为 2**：未完成，不是通过」同一口径。
 * 既避免把"缺密钥/缺账户"伪装成通过，也不把它伪装成产品缺陷。
 * **Round 6 登记的"本驱动只有未覆盖时 exit 0"经真机复跑证实不成立**（`run-g12-before.log`：16 PASS /
 * 0 FAIL / 6 UNCOVERED / **exit 2**）：那一支当时由下面的 `result.blocked`（`gateG12()` 有未覆盖时
 * 必给非空 blocked）顺带兜住，属"碰巧成立"。DEV-027 Round 7 裁决 (b) 把它写成**显式判据**，
 * 这样 blocked 文案将来若变化，未覆盖也不会静默退回 exit 0。
 */
import { gateG12 } from "./g12.ts"
import { g12ExitVerdict } from "./g12-exit.ts"

const result = await gateG12()
/** 未覆盖项以 `contract/` 前缀登记，与覆盖到的真实判定分开统计。 */
const isUncovered = (name: string): boolean => name.startsWith("contract/")
const covered = result.checks.filter(check => !isUncovered(check.name))
const uncovered = result.checks.filter(check => isUncovered(check.name))

for (const check of covered) console.log(`${check.ok ? "PASS" : "FAIL"}  ${result.gate}/${check.name}  ${check.detail}`)
for (const check of uncovered) console.log(`UNCOVERED  ${result.gate}/${check.name}  ${check.detail}`)
const failed = covered.filter(check => !check.ok)
// 退出码一律由纯函数判决（`g12-exit.ts`，有负对照单测）：失败优先，未覆盖即 2，绝不为未覆盖报 0。
const verdict = g12ExitVerdict({ checks: result.checks.length, covered: covered.length, failed: failed.length, uncovered: uncovered.length, blocked: result.blocked })
if (failed.length) {
  console.log(`${result.gate}: 覆盖项 ${covered.length - failed.length}/${covered.length} 通过，${failed.length} 失败，未覆盖合同条件 ${uncovered.length} 条`)
  process.exit(verdict.exitCode)
}
if (result.blocked) { console.log(`BLOCKED  ${result.gate}  ${result.blocked}`); process.exit(verdict.exitCode) }
if (!result.checks.length) { console.log(`BLOCKED  ${result.gate}  没有已接线的真实入口`); process.exit(verdict.exitCode) }
if (!covered.length) { console.log(`BLOCKED  ${result.gate}  没有任何已覆盖的真实判定`); process.exit(verdict.exitCode) }
// DEV-027 Round 7 裁决 (b)：**只有未覆盖**也必须 exit 2（与薄入口 `tallyGate` 同一口径）。
// 此前靠上面的 `result.blocked` 兜住（"碰巧成立"）；这里写成显式判据，使不变式不依赖 blocked 文案。
if (verdict.exitCode === 2) {
  console.log(`${result.gate}: 覆盖项 ${covered.length}/${covered.length} 通过，未覆盖合同条件 ${uncovered.length} 条（未覆盖条件不计入通过分子，但**使退出码为 2**：未完成，不是通过）`)
  process.exit(verdict.exitCode)
}
console.log(`${result.gate}: 覆盖项 ${covered.length}/${covered.length} 通过，未覆盖合同条件 ${uncovered.length} 条`)
process.exit(verdict.exitCode)
