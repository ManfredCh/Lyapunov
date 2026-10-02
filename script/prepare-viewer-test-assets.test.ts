/** 真字节离线准备回归：复用既有固定 Go1 测试夹具，不下载模型、不调用 Viewer/GUI。 */
import { test, expect } from "bun:test"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const sourceRoot = resolve(import.meta.dirname, "..")
const script = join(sourceRoot, "script/prepare-viewer-test-assets.ts")
const manifest = JSON.parse(readFileSync(join(sourceRoot, "script/prepare-viewer-test-assets.manifest.json"), "utf8")) as {
  destination: string; files: Array<{ destinationPath: string; bytes: number; sha256: string }>
  license: { destinationPath: string; bytes: number; sha256: string }
}
const specs = [...manifest.files, manifest.license]
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const run = (root: string, cacheRoot: string) => spawnSync(process.execPath,
  ["--no-env-file", script, "--root", root, "--cache-root", cacheRoot], { encoding: "utf8", timeout: 15_000 })
function withTemporary(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "lyapunov-viewer-fixture-"))
  try { run(root) } finally { rmSync(root, { recursive: true, force: true }) }
}
function copyCache(cacheRoot: string): void {
  for (const spec of specs) {
    const target = join(cacheRoot, manifest.destination, spec.destinationPath)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(sourceRoot, manifest.destination, spec.destinationPath), target)
  }
}

test("离线缓存只复制固定7件，逐字节校验来源并可重复复用", () => withTemporary(root => {
  const sourceHashes = specs.map(spec => hash(readFileSync(join(sourceRoot, manifest.destination, spec.destinationPath))))
  const first = run(root, sourceRoot)
  expect(first.status).toBe(0)
  expect(first.stdout).toContain("reuse=0 copy=7 download=0")
  for (const [index, spec] of specs.entries()) {
    const bytes = readFileSync(join(root, manifest.destination, spec.destinationPath))
    expect(bytes.byteLength).toBe(spec.bytes)
    expect(hash(bytes)).toBe(spec.sha256)
    expect(hash(readFileSync(join(sourceRoot, manifest.destination, spec.destinationPath)))).toBe(sourceHashes[index]!)
  }
  const second = run(root, sourceRoot)
  expect(second.status).toBe(0)
  expect(second.stdout).toContain("reuse=7 copy=0 download=0")
}))

test("显式缓存缺件在写目标之前失败，不转网络", () => withTemporary(root => {
  const target = join(root, "target")
  const result = run(target, join(root, "missing-cache"))
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("离线缓存缺件")
  expect(result.stderr).toContain("未复制、未下载任何文件")
  expect(existsSync(join(target, manifest.destination))).toBe(false)
}))

test("缓存末件LICENSE损坏也不先复制前面的正确件", () => withTemporary(root => {
  const cache = join(root, "cache"), target = join(root, "target")
  copyCache(cache)
  writeFileSync(join(cache, manifest.destination, manifest.license.destinationPath), "错误许可证")
  const result = run(target, cache)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("离线缓存与固定版本不符")
  expect(result.stderr).toContain("LICENSE")
  expect(existsSync(join(target, manifest.destination))).toBe(false)
}))

test("目标已有坏件保持原字节，正确缓存也不能覆盖", () => withTemporary(root => {
  const target = join(root, manifest.destination, specs[0]!.destinationPath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, "用户现有字节")
  const result = run(root, sourceRoot)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("拒绝覆盖")
  expect(readFileSync(target, "utf8")).toBe("用户现有字节")
  expect(existsSync(join(root, manifest.destination, manifest.license.destinationPath))).toBe(false)
}))
