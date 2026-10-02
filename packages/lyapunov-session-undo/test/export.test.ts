import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openWorktreeSnapshots } from "../src/worktree.ts"
test("openWorktreeSnapshots 对非 git 目录返回 NOT_GIT_WORKTREE", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lya-undo-"))
  const opened = await openWorktreeSnapshots({ cwd, storageRoot: join(cwd, "store") })
  expect(opened).toEqual({ supported: false, reason: "NOT_GIT_WORKTREE" })
})
