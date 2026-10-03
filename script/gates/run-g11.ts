/**
 * G11 驱动：跑 `gateG11()` 并打印真实读数与退出码。
 *
 * ## 为什么必须有这个文件（机制 2 · 门的身份与驱动）
 *
 * 本仓的门是**两文件约定**：`script/gates/<id>.ts` 是纯导出实现（顶层零执行），
 * `script/gates/run-<id>.ts` 是驱动。`bun run script/gates/g11.ts` **什么都不做，并且 exit 0** ——
 * 那个空转退出码与"门通过"无法从退出码上区分（Lead 在 G17 上踩过：真驱动当时是 exit=1）。
 * 本文件就是 G11 唯一可单独复跑的入口；查正确命令：`bun run gate:drivers --gate G11`。
 *
 * ## 退出码语义
 *
 * 与 `script/refactor-verify.ts` 的 `report()` 一致：
 * 0 全部通过；1 实际失败；2 必需依赖未完成（BLOCKED）。
 *
 * ## 当前树的读数是 BLOCKED（exit 2），不是"通过"
 *
 * `g11.ts` 只点名缺口、不产出 check：合同 §6.2 G11 的"一张**可核对内容图像**"需要真实多模态通路
 * （图像→模型→核对内容），本机没有可用凭据/Provider ⇒ check 数=0 ⇒ 本驱动按 BLOCKED 收尾（2），
 * **不会**打印成 0 通过。已接线部分（中/英文指令 + 真实 Tool Call + 改模型路由）在 G11LIVE：
 * `bun run script/gates/run-g11-live.ts`，本门不重复跑它。
 *
 * 用法：bun run script/gates/run-g11.ts
 */
import { gateG11 } from "./g11.ts"

const result = gateG11()
const failed = result.checks.filter(check => !check.ok)
for (const check of result.checks) console.log(`${check.ok ? "PASS" : "FAIL"}  ${result.gate}/${check.name}  ${check.detail}`)

let code = 0
if (failed.length) { console.log(`${result.gate}: ${result.checks.length - failed.length}/${result.checks.length} 通过，${failed.length} 失败`); code = 1 }
else if (result.blocked) { console.log(`BLOCKED  ${result.gate}  ${result.blocked}`); code = 2 }
else if (result.checks.length === 0) { console.log(`BLOCKED  ${result.gate}  该门没有已接线的真实入口`); code = 2 }
else console.log(`${result.gate}: ${result.checks.length}/${result.checks.length} 通过`)

// 读数要能直接引用：零 check 的门必须把"0 项"写出来，避免只看到一句 BLOCKED 就把退出码当成通过。
if (result.checks.length === 0) console.log(`${result.gate}: 已接线 check 0 项、失败 0 项（不是通过；已接线部分见 G11LIVE）`)

console.log(`exit=${code}`)
process.exit(code)
