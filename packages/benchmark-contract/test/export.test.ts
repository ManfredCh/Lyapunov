import { expect, test } from "bun:test"
import { isBenchmarkUnavailable } from "../src/index.ts"
test("isBenchmarkUnavailable 只认带 code 与 message 的 BLOCKED", () => {
  expect(isBenchmarkUnavailable({ status: "BLOCKED", code: "NO_SDK", message: "缺解释器" })).toBe(true)
  expect(isBenchmarkUnavailable({ status: "BLOCKED", code: 1, message: "x" })).toBe(false)
  expect(isBenchmarkUnavailable({ status: "READY" })).toBe(false)
})
