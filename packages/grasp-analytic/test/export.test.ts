import { expect, test } from "bun:test"
import { proposeAnalytic } from "../src/index.ts"
test("proposeAnalytic 对放得下的盒给出 analytic 候选", () => {
  const rows = proposeAnalytic({ entityId: "box", frameId: "f", centerM: [0, 0, 0.1], sizeM: [0.04, 0.05, 0.06], maxWidthM: 0.08 })
  expect(rows.length).toBeGreaterThan(0)
  expect(rows[0]!.provider).toBe("analytic")
  expect(rows[0]!.entityId).toBe("box")
  expect(() => proposeAnalytic({ entityId: "box", frameId: "f", centerM: [0, 0, 0], sizeM: [0, 1, 1], maxWidthM: 1 })).toThrow("INVALID_GEOMETRY")
})
