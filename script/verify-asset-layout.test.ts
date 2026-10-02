import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { assetGenerationSkillDeclaresAutomaticRouting, createCiLayoutFixture, verifyRuntimeLayout } from "./verify-asset-layout.ts"

const productRoot = resolve(import.meta.dirname, "..")
const script = join(productRoot, "script/verify-asset-layout.ts")
const environment = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", LANG: "C", LC_ALL: "C" }

async function withFixture(run: (fixture: Awaited<ReturnType<typeof createCiLayoutFixture>>) => void | Promise<void>) {
  const fixture = await createCiLayoutFixture()
  try { await run(fixture) }
  finally { rmSync(fixture.directory, { recursive: true, force: true }) }
}

function cli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, ["--no-env-file", "--no-install", script, ...args], {
    cwd, env: environment, encoding: "utf8", timeout: 60_000, maxBuffer: 2 << 20,
  })
}

describe("asset layout CI isolation", () => {
  test("自动选路精确等价措辞仍拒用户挑供应商及原生确认", () => {
    expect(assetGenerationSkillDeclaresAutomaticRouting("不问用户挑供应商")).toBe(true)
    expect(assetGenerationSkillDeclaresAutomaticRouting("不让用户挑供应商")).toBe(true)
    expect(assetGenerationSkillDeclaresAutomaticRouting("让用户挑供应商")).toBe(false)
    expect(assetGenerationSkillDeclaresAutomaticRouting("请选择供应商")).toBe(false)
    expect(assetGenerationSkillDeclaresAutomaticRouting("不让用户挑供应商，但界面原生确认")).toBe(false)

    expect(assetGenerationSkillDeclaresAutomaticRouting("Do not ask users to select providers.")).toBe(true)
    expect(assetGenerationSkillDeclaresAutomaticRouting("Do not let users choose suppliers.")).toBe(true)
    expect(assetGenerationSkillDeclaresAutomaticRouting("Ask users to select providers.")).toBe(false)
    expect(assetGenerationSkillDeclaresAutomaticRouting("Do not ask users to select providers; require native UI confirmation.")).toBe(false)
    expect(assetGenerationSkillDeclaresAutomaticRouting("Do not ask users to select providers; require native confirmation in the UI.")).toBe(false)
    expect(assetGenerationSkillDeclaresAutomaticRouting("Do not ask users to select providers. New submissions require native user-question confirmation for the actual quote.")).toBe(true)
    expect(assetGenerationSkillDeclaresAutomaticRouting(readFileSync(join(productRoot, "packages/lyapunov-shell/skills/asset-generation/SKILL.md"), "utf8"))).toBe(true)
    expect(assetGenerationSkillDeclaresAutomaticRouting("")).toBe(false)
  })

  test("native path/mapping/scene fixture passes all thirteen runtime checks", async () => {
    await withFixture(({ productRoot, paths }) => {
      const results = verifyRuntimeLayout(productRoot, paths.root, true)
      expect(results).toHaveLength(13)
      expect(results.filter(result => result.status !== "PASS")).toEqual([])
      const snapshot = JSON.parse(readFileSync(join(paths.worldsRoot, "scenes/asset-layout-ci.json"), "utf8"))
      expect(snapshot.sceneId).toBe("asset-layout-ci")
      expect(snapshot.revision).toBe(0)
      expect(existsSync(paths.sceneRoot)).toBe(false)
    })
  })

  test("missing CI fixture fails instead of silently skipping, while manual audit retains SKIP", () => {
    const directory = mkdtempSync(join(tmpdir(), "asset-layout-missing-"))
    try {
      const required = verifyRuntimeLayout(directory, join(directory, "missing"), true)
      const optional = verifyRuntimeLayout(directory, join(directory, "missing"))
      expect(required).toHaveLength(13)
      expect(required.every(result => result.status === "FAIL")).toBe(true)
      expect(optional).toHaveLength(13)
      expect(optional.every(result => result.status === "SKIP")).toBe(true)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  test("stale scene prefix in catalog is a failure", async () => {
    await withFixture(({ productRoot, paths }) => {
      writeFileSync(join(paths.catalogRoot, "stale.json"), JSON.stringify({ path: join(paths.sceneRoot, "resources/old.json") }))
      const failures = verifyRuntimeLayout(productRoot, paths.root, true).filter(result => result.status === "FAIL")
      expect(failures.map(result => result.name)).toEqual(["catalog/worlds 内无旧 scene/ 绝对路径"])
      expect(failures[0]!.evidence).toContain("stale.json")
    })
  })

  test("a symlink to the wrong existing directory does not satisfy workspace mapping", async () => {
    await withFixture(({ productRoot, paths }) => {
      const domain = join(paths.workspaceRoot, "worlds")
      const entry = join(productRoot, "workspace")
      rmSync(domain)
      rmSync(entry)
      symlinkSync(paths.assetsRoot, domain)
      symlinkSync(paths.assetsRoot, entry)
      const failures = verifyRuntimeLayout(productRoot, paths.root, true).filter(result => result.status === "FAIL")
      expect(failures.map(result => result.name)).toEqual(["workspace/worlds 软链", "产品根 workspace 映射软链"])
    })
  })

  test("missing catalog cannot become a zero-file stale-reference pass", async () => {
    await withFixture(({ productRoot, paths }) => {
      rmSync(paths.catalogRoot, { recursive: true })
      const failures = verifyRuntimeLayout(productRoot, paths.root, true).filter(result => result.status === "FAIL")
      expect(failures.map(result => result.name)).toEqual(["运行根 catalog/ 存在", "catalog/worlds 内无旧 scene/ 绝对路径"])
    })
  })

  test("CLI rejects --ci with explicit --root in either order before creating a fixture", () => {
    for (const args of [["--ci", "--root", "unused"], ["--root", "unused", "--ci"]]) {
      const result = cli(productRoot, args)
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("--ci 不读取已有运行根，不能与 --root 同用")
      expect(result.stdout).not.toContain("运行根：")
    }
  })

  test("CLI runs from another cwd using isolated native fixtures and removes them", () => {
    const cwd = mkdtempSync(join(tmpdir(), "asset-layout-cwd-"))
    try {
      const result = cli(cwd, ["--ci"])
      expect(result.error).toBeUndefined()
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain(`产品根：${productRoot}`)
      expect(result.stdout).toMatch(/汇总：PASS=\d+ FAIL=0 SKIP=0/)
      expect(result.stdout).not.toContain(join(productRoot, ".runtime"))
      const runtime = result.stdout.match(/运行根：(.+?)（--ci：/)
      const integration = result.stdout.match(/\[INFO\] 集成临时根：(.+?)（/)
      expect(runtime).not.toBeNull()
      expect(integration).not.toBeNull()
      expect(existsSync(resolve(runtime![1]!, "../.."))).toBe(false)
      expect(existsSync(integration![1]!)).toBe(false)
      expect(existsSync(join(cwd, ".runtime"))).toBe(false)
      expect(existsSync(join(cwd, "workspace"))).toBe(false)
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  }, 90_000)
})
