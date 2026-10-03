/**
 * DEV-027 F31 负对照（N245）：`acp_process_exited_cleanly` 的判据必须拒绝 `null`。
 *
 * 旧判据 `exitCode === 0 || exitCode === null` 把"被本门超时杀掉"当成"进程自行干净退出"。
 * 这条单测钉住收紧后的判据：`null` ⇒ 必须失败（负对照），只有真实 `0` 才算通过。
 */
import { describe, expect, test } from "bun:test"
import { acpExitedCleanly } from "./g13-acp.ts"

describe("G13-ACP 退出判据（F31）", () => {
  test("负对照：exitCode=null（被超时收尾杀掉）⇒ 必须判失败", () => {
    expect(acpExitedCleanly(null)).toBe(false)
  })

  test("未取到退出码（undefined）⇒ 判失败，不默认通过", () => {
    expect(acpExitedCleanly(undefined)).toBe(false)
  })

  test("真实干净退出（0）⇒ 通过；非零退出码 ⇒ 失败", () => {
    expect(acpExitedCleanly(0)).toBe(true)
    expect(acpExitedCleanly(1)).toBe(false)
    expect(acpExitedCleanly(143)).toBe(false)
  })
})
