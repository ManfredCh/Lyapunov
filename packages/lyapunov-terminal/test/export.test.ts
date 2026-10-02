import { expect, test } from "bun:test"
import { WorkspaceId } from "@deepseek-ai/dsh-workspace"
import { plannedWorkspaceOrder } from "../src/workspace-actions.ts"
test("plannedWorkspaceOrder 把工作区上移一格", () => {
  const a = WorkspaceId("a")
  const b = WorkspaceId("b")
  const c = WorkspaceId("c")
  expect(plannedWorkspaceOrder([a, b, c], c, { kind: "up" })).toEqual([a, c, b])
})
