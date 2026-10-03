import { expect, test } from "bun:test"
import { pathWithin } from "../src/writable-boundary.ts"
test("pathWithin 只接受根目录自身及其后代", () => {
  expect(pathWithin("/tmp/lya-root", "/tmp/lya-root")).toBe(true)
  expect(pathWithin("/tmp/lya-root", "/tmp/lya-root/sessions/a")).toBe(true)
  expect(pathWithin("/tmp/lya-root", "/tmp/lya-other")).toBe(false)
})
