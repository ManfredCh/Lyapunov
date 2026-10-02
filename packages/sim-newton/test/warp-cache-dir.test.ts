/**
 * N49 / task-82：Warp JIT 缓存目录的解析与"不可写"行为（离线，只起 worker 模块，不步进引擎）。
 *
 * 真机读数在 `bugfixHistory/NEWTON-CACHE-WRITABLE-20260922.md`：宿主里旧实现回落到只读的
 * `~/.cache/warp`，第一次 JIT 编译抛 EROFS 让世界静默死亡。这里钉的是**判据**：
 *  · 显式可写 → 用它；
 *  · 显式不可写但会话里另有可写位置 → 改用可写位置并写进 note（不静默、也不硬失败）；
 *  · 一个可写候选都没有 → 结构化 fatal（PROVIDER_DEPENDENCY_MISSING，退出码 2），不是静默死亡。
 *
 * 只 import worker 模块（`if __name__ == '__main__'` 之外的部分），不启动协议循环；
 * 需要 Newton 环境（`.runtime/newton-env/bin/python`），缺失即 skip。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const PYTHON = resolve(HERE, "../../../.runtime/newton-env/bin/python")
const WORKER_DIR = resolve(HERE, "../python")
const available = existsSync(PYTHON)

/** 只导入 worker 模块并回读它实际选中的缓存目录（不跑 tick、不阻塞）。 */
function resolveWith(env: Record<string, string>, cwd?: string) {
  // worker 导入时会把 sys.stdout 让给协议通道（普通 print 落到 stderr），所以直接写 fd 1。
  const script = "import json, os, worker; os.write(1, (json.dumps({'dir': worker._CACHE_ROOT, 'source': worker._CACHE_SOURCE}) + chr(10)).encode())"
  return spawnSync(PYTHON, ["-c", script], {
    cwd: cwd ?? WORKER_DIR,
    env: { ...process.env, PYTHONPATH: WORKER_DIR, ...env },
    encoding: "utf8",
    timeout: 300_000,
  })
}

let scratch: string | undefined
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); scratch = undefined })
const newScratch = () => (scratch = mkdtempSync(join(tmpdir(), "n49-cache-")))
/** 只读目录：chmod 0555；root 下 chmod 拦不住写入时返回 undefined 让该用例 skip。 */
function readOnlyDir(root: string, name: string): string | undefined {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  chmodSync(path, 0o555)
  return spawnSync(PYTHON, ["-c", `import os,sys
try:
    open(os.path.join(sys.argv[1], '.probe'), 'w').close(); os.remove(os.path.join(sys.argv[1], '.probe')); print('WRITABLE')
except Exception: print('READONLY')`, path], { encoding: "utf8" }).stdout.includes("READONLY") ? path : undefined
}

describe.skipIf(!available)("N49：Warp 内核缓存目录解析（Newton worker）", () => {
  test("显式可写目录：直接采用，来源记 LYAPUNOV_NEWTON_CACHE_ROOT", () => {
    const root = newScratch()
    const target = join(root, "explicit")
    const run = resolveWith({ LYAPUNOV_NEWTON_CACHE_ROOT: target })
    expect(run.status).toBe(0)
    const value = JSON.parse(run.stdout.split("\n").find(line => line.includes('"dir"'))!)   // warp 自己也会往 stdout 写内核缓存提示行，别取最后一行
    expect(value.dir).toBe(target)
    expect(value.source).toContain("LYAPUNOV_NEWTON_CACHE_ROOT")
  }, 120_000)

  test("显式目录不可写但会话里有可写位置：改用可写位置并在来源里写明（不静默、不硬失败）", () => {
    const root = newScratch()
    const readOnly = readOnlyDir(root, "ro")
    if (!readOnly) return                                   // root 下 chmod 无效：本机不适用
    const fallback = join(root, "tmp")
    mkdirSync(fallback, { recursive: true })
    const run = resolveWith({ LYAPUNOV_NEWTON_CACHE_ROOT: readOnly, TMPDIR: fallback, XDG_CACHE_HOME: "" })
    expect(run.status).toBe(0)
    const value = JSON.parse(run.stdout.split("\n").find(line => line.includes('"dir"'))!)   // warp 自己也会往 stdout 写内核缓存提示行，别取最后一行
    expect(value.dir.startsWith(fallback)).toBe(true)
    expect(value.source).toContain("不可写，已改用")
  }, 120_000)

  test("负对照：所有候选都不可写时结构化 fatal（退出码 2，不再静默死亡）", () => {
    const root = newScratch()
    const readOnly = readOnlyDir(root, "all-ro")
    if (!readOnly) return
    const run = resolveWith({
      LYAPUNOV_NEWTON_CACHE_ROOT: join(readOnly, "explicit"),
      LYAPUNOV_SIM_RUNTIME_ROOT: join(readOnly, "runtime"),
      XDG_CACHE_HOME: join(readOnly, "xdg"),
      TMPDIR: join(readOnly, "tmp"),
    }, readOnly)
    expect(run.status).toBe(2)
    const fatal = JSON.parse(run.stdout.trim().split("\n").find(line => line.includes("fatal"))!)
    expect(fatal.error.code).toBe("PROVIDER_DEPENDENCY_MISSING")
    expect(fatal.error.message).toContain("找不到可写的 Warp 内核缓存目录")
    expect(fatal.error.message).toContain("explicit")        // 报错里带出试过的路径
  }, 120_000)
})
