/**
 * G12 驱动的退出码判决（DEV-027 Round 7 裁决 (b)）。
 *
 * 背景：G12 有**两个入口**——薄入口 `bun run script/refactor-verify.ts --gate G12`（走 `tallyGate`）
 * 与独立驱动 `bun run script/gates/run-g12.ts`。Round 6 我按源码结构登记过一条"口径分歧"：
 * "只有未覆盖时驱动 exit 0、薄入口 exit 2"。**Round 7 真机复跑证实该分歧不存在**：
 * 驱动在这一情形下由 `result.blocked`（`gateG12()` 有未覆盖时必给非空 blocked）顺带 exit 2
 * （`run-g12-before.log`：16 PASS / 0 FAIL / 6 UNCOVERED / **exit 2**；薄入口同读数同退出码）。
 *
 * 但"顺带成立"不等于"有判据"：blocked 文案哪天变了，未覆盖就会静默退回 exit 0。裁决 (b) 要求
 * **统一为 2**，故这里把判决写成**纯函数**（可单测、可负对照），驱动只负责打印：
 *   失败(1) 优先于 阻断/未覆盖(2)；未覆盖即"未完成"，不得报 0。
 */

export interface G12ExitCounts {
  /** `gateG12()` 返回的 checks 总数（含未覆盖项）。 */
  checks: number
  /** 覆盖到并真实判定的 check 数。 */
  covered: number
  /** 覆盖项里真实失败的条数。 */
  failed: number
  /** 未覆盖合同条件条数。 */
  uncovered: number
  /** 门返回的 BLOCKED 文案（无则 null）。 */
  blocked: string | null
}

export interface G12ExitVerdict {
  exitCode: 0 | 1 | 2
  /** 判决理由（用于回执/排查，不影响打印）。 */
  why: string
}

/**
 * 判决顺序（与 `tallyGate` 的优先级一致，失败永远优先）：
 *   1. 有真实失败 ⇒ 1（失败不得被阻断/未覆盖盖成 2）；
 *   2. 门 BLOCKED ⇒ 2；
 *   3. 没有已接线的 check ⇒ 2；没有任何已覆盖的真实判定 ⇒ 2；
 *   4. **只有未覆盖** ⇒ 2（未完成，不是通过）——裁决 (b) 的靶心情形；
 *   5. 覆盖项全过且无未覆盖 ⇒ 0。
 */
export function g12ExitVerdict(counts: G12ExitCounts): G12ExitVerdict {
  if (counts.failed > 0) return { exitCode: 1, why: `覆盖项有 ${counts.failed} 条真实失败（失败优先于阻断/未覆盖）` }
  if (counts.blocked !== null) return { exitCode: 2, why: "门返回 BLOCKED" }
  if (counts.checks === 0) return { exitCode: 2, why: "没有已接线的真实入口" }
  if (counts.covered === 0) return { exitCode: 2, why: "没有任何已覆盖的真实判定" }
  if (counts.uncovered > 0) return { exitCode: 2, why: `只有未覆盖条件 ${counts.uncovered} 条：未完成，不是通过` }
  return { exitCode: 0, why: "覆盖项全过且无未覆盖" }
}
