/**
 * fileTransaction 的收尾语义：一次已经把内容写进文件的交易，不许因为**清理锁**失败而被报成失败。
 * 真实撞到过：dataRoot 整个被删/搬走（测试 teardown、运行根收尾）时 rm 锁目录会 ENOENT，此时
 * `fn()` 里的写入早已生效——调用方若把这次当失败，会去清掉刚写下的产物，用 failed 覆盖成功的回执。
 */
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileTransaction } from "../src/persistence.ts"

describe("fileTransaction 锁收尾", () => {
  test("正常路径：内容落盘、锁被清掉、返回 fn 的结果", async () => {
    const base = await mkdtemp(join(tmpdir(), "lyapunov-transaction-"))
    try {
      const path = join(base, "resources/index.json")
      const value = await fileTransaction(path, async () => {
        await writeFile(path, JSON.stringify({ ok: true }))
        return "done"
      })
      expect(value).toBe("done")
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ok: true })
      // 锁目录已清：同一路径能再开一次事务（残留锁会 SCENE_BUSY）。
      await fileTransaction(path, async () => writeFile(path, JSON.stringify({ ok: false })))
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ok: false })
    } finally { await rm(base, { recursive: true, force: true }) }
  })

  test("目录在交易中途整个消失：内容已生效就不报失败（清锁失败只记日志）", async () => {
    const base = await mkdtemp(join(tmpdir(), "lyapunov-transaction-"))
    const path = join(base, "resources/index.json")
    const value = await fileTransaction(path, async () => {
      await writeFile(path, JSON.stringify({ status: "ok" }))
      // 模拟调用方在交易收尾前把整棵树删掉（测试 teardown、运行根收尾）。
      await rm(join(base, "resources"), { recursive: true, force: true })
      return "written"
    })
    // 交易 resolve（不抛），写入是真的发生过——"成功"不因收尾噪声被改写成"失败"。
    expect(value).toBe("written")
    await rm(base, { recursive: true, force: true })
  })

  test("fn 自己抛错照旧传播（收尾容错不掩盖真实失败）", async () => {
    const base = await mkdtemp(join(tmpdir(), "lyapunov-transaction-"))
    try {
      const path = join(base, "resources/index.json")
      await mkdir(join(base, "resources"), { recursive: true })
      expect(fileTransaction(path, async () => { throw new Error("BOOM") })).rejects.toThrow("BOOM")
    } finally { await rm(base, { recursive: true, force: true }) }
  })
})
