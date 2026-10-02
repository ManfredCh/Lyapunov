/**
 * DEV-027 Round 7 裁决 (b) 负对照：G12 驱动/"只有未覆盖"必须判 2，且**失败永远优先**。
 *
 * 靶心用例是 driving 里那条曾经"碰巧成立"的不变式：
 *   `failed=0, blocked=null, covered=16, uncovered=6` ⇒ **exitCode 2**（不是 0）。
 * 也就是说：把 `gateG12()` 的 blocked 文案去掉（模拟"blocked 变了"）也不能让未覆盖退回 0。
 */
import { describe, expect, test } from "bun:test"
import { g12ExitVerdict } from "./g12-exit.ts"

const clean = { checks: 22, covered: 16, failed: 0, uncovered: 0, blocked: null }

describe("G12 退出码判决（Round 7 裁决 b）", () => {
  test("靶心：只有未覆盖、且 blocked 为 null ⇒ 必须 2（不得 0）", () => {
    const verdict = g12ExitVerdict({ ...clean, uncovered: 6 })
    expect(verdict.exitCode).toBe(2)
    expect(verdict.why).toContain("未完成")
  })

  test("真实读数形态（blocked 非空）⇒ 2，与薄入口 tallyGate 一致", () => {
    expect(g12ExitVerdict({ checks: 22, covered: 16, failed: 0, uncovered: 6, blocked: "以下合同条件本机未覆盖（非失败，但本门不据此记完成）：…" }).exitCode).toBe(2)
  })

  test("负对照：有真实失败时失败优先 ⇒ 1（不被阻断/未覆盖盖成 2）", () => {
    expect(g12ExitVerdict({ ...clean, failed: 2, uncovered: 6, blocked: "blocked" }).exitCode).toBe(1)
  })

  test("负对照：没有已接线入口 / 没有任何已覆盖判定 ⇒ 2", () => {
    expect(g12ExitVerdict({ checks: 0, covered: 0, failed: 0, uncovered: 0, blocked: null }).exitCode).toBe(2)
    expect(g12ExitVerdict({ checks: 6, covered: 0, failed: 0, uncovered: 6, blocked: "…" }).exitCode).toBe(2)
  })

  test("覆盖项全过且无未覆盖 ⇒ 0（唯一允许报 0 的形态）", () => {
    expect(g12ExitVerdict(clean).exitCode).toBe(0)
    expect(g12ExitVerdict(clean).why).toContain("无未覆盖")
  })
})
