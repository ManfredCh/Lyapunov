import { expect, test } from "bun:test"
import { inject, name } from "../src/plugin.ts"
test("插件名和注入面是产品登记的那一组", () => {
  expect(name).toBe("lyapunov-segment-sam3")
  expect(inject).toEqual(["tools", "jobs", "subprocess", "commands"])
})
