import { expect, test } from "bun:test"
import { resolveAccountApiUrl } from "../src/account/url.ts"

test("resolveAccountApiUrl 正式默认字面命中统一入口", () => {
  // 写死字面值（而不是引用常量）：常量本身被改错时这条必须能红。
  expect(resolveAccountApiUrl({ dev: false })).toBe("https://vorynel.com/lyaup-unified")
})

test("resolveAccountApiUrl 空白配置回落到正式默认，开发默认不变", () => {
  expect(resolveAccountApiUrl({ configured: "", dev: false })).toBe("https://vorynel.com/lyaup-unified")
  expect(resolveAccountApiUrl({ configured: "   ", dev: false })).toBe("https://vorynel.com/lyaup-unified")
  expect(resolveAccountApiUrl({ dev: true })).toBe("http://127.0.0.1:8787")
})

test("resolveAccountApiUrl 显式配置优先于正式/开发默认", () => {
  expect(resolveAccountApiUrl({ configured: " https://example.test/api ", dev: false })).toBe("https://example.test/api")
  expect(resolveAccountApiUrl({ configured: "https://example.test/api", dev: true })).toBe("https://example.test/api")
})
