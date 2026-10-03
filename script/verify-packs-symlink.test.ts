import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { resolveAssetPath, verifyAssetManifest, walkFiles } from "./verify-packs.ts"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "verify-packs-symlink-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeFixture(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

describe("verify-packs symlink-safe traversal", () => {
  test("walks ordinary files and verifies their recorded checksums", () => {
    const assetRoot = join(root, "asset")
    const first = join(assetRoot, "first.txt")
    const second = join(assetRoot, "nested", "second.txt")
    writeFixture(first, "first")
    writeFixture(second, "second")

    expect(walkFiles(assetRoot).sort()).toEqual([first, second].sort())
    expect(verifyAssetManifest(assetRoot, [
      { path: "first.txt", bytes: 5, sha256: sha256(first) },
      { path: "nested/second.txt", bytes: 6, sha256: sha256(second) },
    ])).toEqual({ problems: [], diskFiles: 2 })
  })

  test("reports a checksum mismatch without changing the fixture", () => {
    const assetRoot = join(root, "asset")
    const file = join(assetRoot, "model.bin")
    writeFixture(file, "payload")

    const result = verifyAssetManifest(assetRoot, [{ path: "model.bin", bytes: 7, sha256: "0".repeat(64) }])
    expect(result.problems.some(problem => problem.includes("sha256 不符 model.bin"))).toBe(true)
    expect(result.diskFiles).toBe(1)
  })

  test("rejects directory symlinks pointing outside and inside the root", () => {
    const assetRoot = join(root, "asset")
    const outside = join(root, "outside-dir")
    const inside = join(assetRoot, "real-dir")
    mkdirSync(outside, { recursive: true })
    mkdirSync(inside, { recursive: true })

    symlinkSync(outside, join(assetRoot, "outside-link"), "dir")
    expect(() => walkFiles(assetRoot)).toThrow(/symlink rejected/)

    rmSync(join(assetRoot, "outside-link"))
    symlinkSync(inside, join(assetRoot, "inside-link"), "dir")
    expect(() => walkFiles(assetRoot)).toThrow(/symlink rejected/)
  })

  test("rejects a directory root that is itself a symlink to an outside root", () => {
    const outside = join(root, "outside-dir")
    const linkedRoot = join(root, "linked-root")
    mkdirSync(outside, { recursive: true })
    writeFixture(join(outside, "payload.txt"), "outside")
    symlinkSync(outside, linkedRoot, "dir")

    expect(() => walkFiles(linkedRoot)).toThrow(/symlink rejected/)
  })

  test("rejects file symlinks pointing outside and inside the root", () => {
    const assetRoot = join(root, "asset")
    const outside = join(root, "outside.txt")
    const inside = join(assetRoot, "real.txt")
    writeFixture(outside, "outside")
    writeFixture(inside, "inside")

    symlinkSync(outside, join(assetRoot, "outside-link.txt"), "file")
    expect(() => walkFiles(assetRoot)).toThrow(/symlink rejected/)

    rmSync(join(assetRoot, "outside-link.txt"))
    symlinkSync(inside, join(assetRoot, "inside-link.txt"), "file")
    expect(() => walkFiles(assetRoot)).toThrow(/symlink rejected/)
  })

  test("rejects manifest file targets that are symlinks, regardless of target location", () => {
    const assetRoot = join(root, "asset")
    const outside = join(root, "outside.txt")
    const inside = join(assetRoot, "real.txt")
    writeFixture(outside, "outside")
    writeFixture(inside, "inside")

    const outsideLink = join(assetRoot, "outside-link.txt")
    symlinkSync(outside, outsideLink, "file")
    const outsideResult = verifyAssetManifest(assetRoot, [{ path: "outside-link.txt", bytes: 7, sha256: sha256(outside) }])
    expect(outsideResult.problems.some(problem => problem.includes("symlink rejected"))).toBe(true)

    rmSync(outsideLink)
    const insideLink = join(assetRoot, "inside-link.txt")
    symlinkSync(inside, insideLink, "file")
    const insideResult = verifyAssetManifest(assetRoot, [{ path: "inside-link.txt", bytes: 6, sha256: sha256(inside) }])
    expect(insideResult.problems.some(problem => problem.includes("symlink rejected"))).toBe(true)
  })

  test("rejects manifest targets with symlink ancestors before hashing", () => {
    const assetRoot = join(root, "asset")
    const outsideDir = join(root, "outside-dir")
    writeFixture(join(outsideDir, "payload.txt"), "outside")
    mkdirSync(assetRoot, { recursive: true })
    symlinkSync(outsideDir, join(assetRoot, "linked-dir"), "dir")

    const result = verifyAssetManifest(assetRoot, [{ path: "linked-dir/payload.txt", bytes: 7, sha256: sha256(join(outsideDir, "payload.txt")) }])
    expect(result.problems.some(problem => problem.includes("symlink rejected"))).toBe(true)
  })

  test("rejects lexical manifest escapes before filesystem access", () => {
    const assetRoot = join(root, "asset")
    const outside = join(root, "outside.txt")
    writeFixture(outside, "outside")
    mkdirSync(assetRoot, { recursive: true })

    expect(() => resolveAssetPath(assetRoot, "../outside.txt")).toThrow(/escapes asset root/)
    expect(() => resolveAssetPath(assetRoot, outside)).toThrow(/escapes asset root/)
  })
})
