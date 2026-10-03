/**
 * N58 / ENV-35：把"sdf 通道"的**能力事实**钉住——拒绝理由必须是真的。
 *
 * 真机发现（本轮）：`sim-mujoco` worker **已经**把 `shape=sdf` 装配成 `mjGEOM_SDF`
 * （`packages/sim-mujoco/python/worker.py:1021`，真机验证：带 sdf 碰撞的实体真实下落并与地面产生 3 点接触），
 * 但 asset-bake 的环境守卫与注释把拒绝理由写成"SDF 的消费方通道本轮未接"——那是一句**假的能力声明**：
 * 它会让用户以为对象用途的 sdf 也不可用。本文件钉两件事：
 *   1. 环境 + 显式 sdf 仍然被拒（行为不变），但文案必须说明"消费方已接、缺的是环境标定"；
 *   2. 对象用途（dynamic/static）的 sdf **不经过**这条环境守卫（这条守卫只对 usage=environment 生效）。
 *
 * 本文件不需要算法解释器（守卫在任何 provider 调用之前抛错），也不会启动子进程。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { physicalize } from "../src/physicalize.ts"

const temporary: string[] = []
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function workspace() { const directory = await mkdtemp(join(tmpdir(), "env35-sdf-")); temporary.push(directory); return directory }

const failureOf = async (run: () => Promise<unknown>): Promise<Error> => {
  try { await run() } catch (error) { return error as Error }
  throw new Error("期望被拒绝，实际成功")
}

describe("sdf 的拒绝理由必须是能力事实（不是「消费方未接」）", () => {
  test("环境 + 显式 sdf：仍拒绝，但文案说明消费方已接（mjGEOM_SDF）且不再声称通道未接", async () => {
    const directory = await workspace()
    const error = await failureOf(() => physicalize({ sourcePath: join(directory, "missing.glb"), outputDirectory: join(directory, "out"), usage: "environment", strategy: "sdf" }))
    expect(error.message).toContain("环境按独立表面/保空腔表示导出")
    expect(error.message).toContain("mjGEOM_SDF")
    expect(error.message).not.toContain("消费方通道本轮未接")
    expect(error.message).toContain("对象用途可以显式用 sdf")
  })

  test("对象用途的 sdf 不经过环境守卫：同一入参下报的是源文件错误，不是环境策略错误", async () => {
    const directory = await workspace()
    const error = await failureOf(() => physicalize({ sourcePath: join(directory, "missing.glb"), outputDirectory: join(directory, "out"), usage: "dynamic", strategy: "sdf" }))
    expect(error.message).not.toContain("环境按独立表面/保空腔表示导出")
    expect(error.message).not.toContain("消费方通道本轮未接")
  })
})
