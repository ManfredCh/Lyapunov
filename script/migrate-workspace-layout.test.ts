/**
 * DEV-020 回归：`script/migrate-workspace-layout.ts` 的库入口与 CLI 入口必须可区分。
 *
 * 缺陷条件：该模块原先用 `import.meta.url === `file://${process.argv[1]}`` 判定“直接运行”。`script/profile.ts`
 * 以库方式导入本模块，`script/package-linux.ts` 又把 `script/administrator.ts` 打成单文件 bundle；bundle 内每个
 * 来源模块共享同一个 `import.meta.url`，判定恒成立，于是管理员 `--help` 先落进迁移 CLI 的 `parseArgs`，
 * 以 `ERR_PARSE_ARGS_UNKNOWN_OPTION` 退出 1。
 *
 * 覆盖三条验收：库导入无副作用、单独运行仍出报告、管理员 bundle `--help` 退出 0。
 */
import { afterAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { curatedRewriters, migrateRuntimeLayout } from "./migrate-workspace-layout.ts"
import { runtimePaths } from "../packages/lyapunov-product-bundle/src/runtime-paths.ts"

const repoRoot = resolve(import.meta.dirname, "..")
const modulePath = join(repoRoot, "script/migrate-workspace-layout.ts")
const temporaries: string[] = []
function temporary(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `dev020-${label}-`))
  temporaries.push(directory)
  return directory
}
function fixtureFile(path: string, contents: string): void {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, contents)
}
afterAll(() => { for (const directory of temporaries) rmSync(directory, { recursive: true, force: true }) })

test("库导入本模块只暴露函数：不解析 argv、不写迁移报告、不设 exitCode", async () => {
  // 本测试文件是入口，上面的静态 import 已完成模块求值；CLI 分支若能触发，会按 argv 解析或写报告。
  expect(typeof migrateRuntimeLayout).toBe("function")
  expect(typeof curatedRewriters).toBe("function")
  expect(process.exitCode ?? 0).toBe(0)
  for (const directory of [repoRoot, join(repoRoot, "developer")]) {
    if (!existsSync(directory)) continue
    expect(readdirSync(directory).filter(name => name.startsWith("migration-report-"))).toEqual([])
  }
  // 与 script/profile.ts 相同的库调用方式：dry-run 返回报告，且不写任何文件。
  const root = temporary("library-call")
  const report = await migrateRuntimeLayout(runtimePaths({ mode: "developer", root }), { dryRun: true })
  expect(report.root).toBe(join(root, "developer"))
  expect(report.skipped.length).toBe(1)
  expect(readdirSync(root)).toEqual([])
})

test("argv[1] 指向迁移模块本身时，作为库被 import 也不得触发迁移 CLI", () => {
  const wrapper = join(temporary("lib-entry"), "wrapper.ts")
  writeFileSync(wrapper, [
    `process.argv[1] = ${JSON.stringify(modulePath)}`,
    `await import(${JSON.stringify(modulePath)})`,
    'console.log("LIB-IMPORT-OK")',
  ].join("\n") + "\n")
  const run = spawnSync(process.execPath, ["--no-env-file", wrapper, "--help"], { encoding: "utf8" })
  expect(run.stderr).not.toContain("ERR_PARSE_ARGS_UNKNOWN_OPTION")
  expect(run.status).toBe(0)
  expect(run.stdout).toContain("LIB-IMPORT-OK")
})

test("单独运行迁移命令仍输出报告 JSON 并写出证据文件", () => {
  const root = temporary("cli-run")
  const run = spawnSync(process.execPath, ["--no-env-file", "run", "script/migrate-workspace-layout.ts", "--root", root, "--dry-run"], { cwd: repoRoot, encoding: "utf8" })
  expect(run.status).toBe(0)
  const report = JSON.parse(run.stdout) as { root: string; moved: string[]; evidence: string }
  expect(report.root).toBe(join(root, "developer"))
  expect(report.moved).toEqual([])
  expect(existsSync(report.evidence)).toBe(true)
})

test("迁移合并保留文件冲突、目录类型冲突，并只移动无冲突项", async () => {
  const root = temporary("merge-conflicts")
  const paths = runtimePaths({ mode: "developer", root })
  const sourceScenes = join(paths.sceneRoot, "scenes")
  const targetScenes = join(paths.worldsRoot, "scenes")
  const outside = join(root, "outside-target")

  fixtureFile(join(sourceScenes, "same.txt"), "source-bytes")
  fixtureFile(join(sourceScenes, "nested", "same.txt"), "nested-source-bytes")
  fixtureFile(join(sourceScenes, "nested", "moved.txt"), "moved-bytes")
  fixtureFile(join(sourceScenes, "nested", "moved-only", "deep.txt"), "deep-moved-bytes")
  fixtureFile(join(sourceScenes, "directory-collision", "source.txt"), "source-dir-bytes")
  fixtureFile(join(targetScenes, "same.txt"), "destination-bytes")
  fixtureFile(join(targetScenes, "nested", "same.txt"), "nested-destination-bytes")
  fixtureFile(join(targetScenes, "directory-collision"), "destination-file-bytes")
  mkdirSync(outside, { recursive: true })
  fixtureFile(join(outside, "untouched.json"), `${paths.sceneRoot}/must-not-be-rewritten`)
  symlinkSync(outside, join(sourceScenes, "outside-link"), "dir")

  const first = await migrateRuntimeLayout(paths)
  expect(readFileSync(join(targetScenes, "same.txt"), "utf8")).toBe("destination-bytes")
  expect(readFileSync(join(targetScenes, "nested", "same.txt"), "utf8")).toBe("nested-destination-bytes")
  expect(readFileSync(join(targetScenes, "nested", "moved.txt"), "utf8")).toBe("moved-bytes")
  expect(readFileSync(join(targetScenes, "nested", "moved-only", "deep.txt"), "utf8")).toBe("deep-moved-bytes")
  expect(readFileSync(join(targetScenes, "directory-collision"), "utf8")).toBe("destination-file-bytes")
  expect(readFileSync(join(sourceScenes, "same.txt"), "utf8")).toBe("source-bytes")
  expect(readFileSync(join(sourceScenes, "nested", "same.txt"), "utf8")).toBe("nested-source-bytes")
  expect(readFileSync(join(sourceScenes, "directory-collision", "source.txt"), "utf8")).toBe("source-dir-bytes")
  expect(lstatSync(join(targetScenes, "outside-link")).isSymbolicLink()).toBe(true)
  expect(readlinkSync(join(targetScenes, "outside-link"))).toBe(outside)
  expect(readFileSync(join(outside, "untouched.json"), "utf8")).toBe(`${paths.sceneRoot}/must-not-be-rewritten`)
  expect(first.conflicts.some(path => path.includes("same.txt"))).toBe(true)
  expect(first.conflicts.some(path => path.includes("directory-collision"))).toBe(true)
  expect(existsSync(join(sourceScenes, "nested", "moved.txt"))).toBe(false)
  expect(existsSync(join(sourceScenes, "nested", "moved-only"))).toBe(false)

  const second = await migrateRuntimeLayout(paths)
  expect(readFileSync(join(targetScenes, "same.txt"), "utf8")).toBe("destination-bytes")
  expect(readFileSync(join(targetScenes, "nested", "same.txt"), "utf8")).toBe("nested-destination-bytes")
  expect(readFileSync(join(sourceScenes, "same.txt"), "utf8")).toBe("source-bytes")
  expect(second.conflicts.some(path => path.includes("same.txt"))).toBe(true)
  expect(second.conflicts.some(path => path.includes("directory-collision"))).toBe(true)
})

test("catalog 悬空目标链接也算冲突，不覆盖链接或源索引", async () => {
  const root = temporary("dangling-catalog")
  const paths = runtimePaths({ mode: "developer", root })
  const source = join(paths.sceneRoot, "resources/index.json")
  const target = join(paths.catalogRoot, "index.json")
  fixtureFile(source, '{"records":[]}')
  mkdirSync(paths.catalogRoot, { recursive: true })
  const missing = join(root, "missing-target")
  symlinkSync(missing, target)
  for (let index = 0; index < 2; index++) {
    const report = await migrateRuntimeLayout(paths)
    expect(report.conflicts.some(value => value.includes(source))).toBe(true)
    expect(readFileSync(source, "utf8")).toBe('{"records":[]}')
    expect(lstatSync(target).isSymbolicLink()).toBe(true)
    expect(readlinkSync(target)).toBe(missing)
    expect(existsSync(missing)).toBe(false)
  }
})

test("拒绝运行根和源/目标祖先链接，写入前退出且不触碰链接目标", async () => {
  for (const part of ["", "scene", "scene/assets", "scene/resources", "worlds", "cache", "catalog"]) {
    const root = temporary("ancestor-link")
    const paths = runtimePaths({ mode: "developer", root })
    const outside = join(root, "outside")
    const sentinel = join(outside, "scenes/sentinel.json")
    const content = JSON.stringify({ path: join(paths.sceneRoot, "scenes/source.bin") })
    fixtureFile(sentinel, content)
    const link = part ? join(paths.root, part) : paths.root
    mkdirSync(join(link, ".."), { recursive: true })
    symlinkSync(outside, link, "dir")
    const report = await migrateRuntimeLayout(paths, { productRoot: join(root, "product") })
    expect(report.conflicts.length).toBeGreaterThan(0)
    expect(report.moved).toEqual([])
    expect(report.rewrote).toEqual([])
    expect(readlinkSync(link)).toBe(outside)
    expect(readFileSync(sentinel, "utf8")).toBe(content)
    expect(readdirSync(outside)).toEqual(["scenes"])
  }
})

test("CLI 拒绝软链运行根后仅输出报告，不把证据文件写进链接目标", () => {
  const root = temporary("cli-root-link")
  const outside = join(root, "outside")
  mkdirSync(outside)
  symlinkSync(outside, join(root, "developer"), "dir")
  const run = spawnSync(process.execPath, ["--no-env-file", modulePath, "--root", root], { cwd: repoRoot, encoding: "utf8" })
  expect(run.status).toBe(2)
  const report = JSON.parse(run.stdout)
  expect(report.conflicts.length).toBeGreaterThan(0)
  expect(report.evidence).toBeUndefined()
  expect(readdirSync(outside)).toEqual([])
  expect(readlinkSync(join(root, "developer"))).toBe(outside)
})

test("冲突引用仍指向保留源，非冲突引用迁移，冲突目标 JSON 字节不变", async () => {
  const root = temporary("conflict-references")
  const paths = runtimePaths({ mode: "developer", root })
  const source = join(paths.sceneRoot, "scenes")
  const target = join(paths.worldsRoot, "scenes")
  const oldAsset = join(source, "item.bin")
  fixtureFile(oldAsset, "source-item")
  fixtureFile(join(source, "moved.bin"), "movable-item")
  fixtureFile(join(target, "item.bin"), "different-target-item")
  const unmovedResource = join(paths.sceneRoot, "resources/custom.bin")
  fixtureFile(unmovedResource, "unmapped-resource")
  const reference = JSON.stringify({ conflicted: oldAsset, moved: join(source, "moved.bin"), prefixOnly: source + "-suffix/item.bin", unmovedResource })
  fixtureFile(join(source, "new.json"), reference)
  fixtureFile(join(source, "same.json"), '{"source":true}')
  const destination = `{ "path" : ${JSON.stringify(oldAsset)} }\n`
  fixtureFile(join(target, "same.json"), destination)
  await migrateRuntimeLayout(paths)
  expect(JSON.parse(readFileSync(join(target, "new.json"), "utf8"))).toEqual({
    conflicted: oldAsset, moved: join(target, "moved.bin"), prefixOnly: source + "-suffix/item.bin", unmovedResource,
  })
  expect(readFileSync(unmovedResource, "utf8")).toBe("unmapped-resource")
  expect(readFileSync(oldAsset, "utf8")).toBe("source-item")
  expect(readFileSync(join(target, "item.bin"), "utf8")).toBe("different-target-item")
  expect(readFileSync(join(target, "same.json"), "utf8")).toBe(destination)
  await migrateRuntimeLayout(paths)
  expect(JSON.parse(readFileSync(join(target, "new.json"), "utf8")).conflicted).toBe(oldAsset)
  expect(readFileSync(join(target, "same.json"), "utf8")).toBe(destination)
})

test("无冲突迁移后旧空根被移除，嵌套 JSONL 路径正确改写", async () => {
  const root = temporary("complete-move")
  const paths = runtimePaths({ mode: "developer", root })
  const oldFile = join(paths.sceneRoot, 'scenes/quote"file.bin')
  fixtureFile(oldFile, "payload")
  fixtureFile(join(paths.sceneRoot, "resources/index.json"), JSON.stringify({ path: oldFile }))
  const environment = join(paths.sceneRoot, "assets/environments/env.bin")
  fixtureFile(environment, "environment")
  fixtureFile(join(paths.sceneRoot, "scenes/nested/records.jsonl"), JSON.stringify({ path: oldFile }) + "\n" + JSON.stringify({ path: environment }) + "\n")
  const report = await migrateRuntimeLayout(paths)
  expect(report.conflicts).toEqual([])
  expect(existsSync(paths.sceneRoot)).toBe(false)
  expect(JSON.parse(readFileSync(join(paths.catalogRoot, "index.json"), "utf8")).path).toBe(join(paths.worldsRoot, 'scenes/quote"file.bin'))
  expect(readFileSync(join(paths.worldsRoot, 'scenes/quote"file.bin'), "utf8")).toBe("payload")
  expect(readFileSync(join(paths.worldsRoot, "environments/env.bin"), "utf8")).toBe("environment")
  expect(readFileSync(join(paths.worldsRoot, "scenes/nested/records.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line).path)).toEqual([
    join(paths.worldsRoot, 'scenes/quote"file.bin'), join(paths.worldsRoot, "environments/env.bin"),
  ])
})

test("原生 ResourceRef 的 file URI 随 CAS 迁移，编码路径和冲突引用保持语义", async () => {
  const root = temporary("file-uri")
  const paths = runtimePaths({ mode: "developer", root })
  const oldCas = join(paths.sceneRoot, "assets/cas")
  const newCas = join(paths.cacheRoot, "cas")
  const oldAsset = join(oldCas, "主 体#1.bin")
  const oldConflict = join(oldCas, "保 留#2.bin")
  const newAsset = join(newCas, "主 体#1.bin")
  fixtureFile(oldAsset, "movable")
  fixtureFile(oldConflict, "original-conflict")
  fixtureFile(join(newCas, "保 留#2.bin"), "destination-conflict")
  const uri = pathToFileURL(oldAsset).href
  const conflictUri = pathToFileURL(oldConflict).href
  const record = {
    ref: { original: { uri }, representations: [{ uri, role: "visual" }] },
    storedEntryPath: oldAsset,
    conflict: { uri: conflictUri, path: oldConflict },
    remote: "https://example.invalid/model.bin",
    invalid: "file:///%ZZ",
    foreignHost: "file://remote-host/asset.bin",
  }
  fixtureFile(join(paths.sceneRoot, "resources/index.json"), JSON.stringify(record))
  fixtureFile(join(paths.sceneRoot, "scenes/uri-scene.json"), JSON.stringify({ uri, conflictUri, qualified: uri + "?version=1#mesh" }))
  const report = await migrateRuntimeLayout(paths)
  expect(report.conflicts.length).toBe(1)
  const migrated = JSON.parse(readFileSync(join(paths.catalogRoot, "index.json"), "utf8"))
  expect(migrated).toEqual({ ...record, ref: {
    original: { uri: pathToFileURL(newAsset).href },
    representations: [{ uri: pathToFileURL(newAsset).href, role: "visual" }],
  }, storedEntryPath: newAsset })
  expect(JSON.parse(readFileSync(join(paths.worldsRoot, "scenes/uri-scene.json"), "utf8"))).toEqual({
    uri: pathToFileURL(newAsset).href, conflictUri, qualified: pathToFileURL(newAsset).href + "?version=1#mesh",
  })
  expect(readFileSync(newAsset, "utf8")).toBe("movable")
  expect(readFileSync(oldConflict, "utf8")).toBe("original-conflict")
  expect(readFileSync(join(newCas, "保 留#2.bin"), "utf8")).toBe("destination-conflict")
  const second = await migrateRuntimeLayout(paths)
  expect(second.rewrote).toEqual([])
  expect(JSON.parse(readFileSync(join(paths.catalogRoot, "index.json"), "utf8"))).toEqual(migrated)
})

test("按 package-linux 配置打成管理员 bundle 后产物运行器（本机 PATH 里的那一个）--help 退出 0（DEV-020 复现条件）", async () => {
  const stage = temporary("stage")
  const built = await Bun.build({
    entrypoints: [join(repoRoot, "script/administrator.ts")],
    target: "node",
    format: "esm",
    external: ["@deepseek-ai/*"],
    minify: false,
    define: { "process.env.NODE_ENV": "process.env.NODE_ENV" },
  })
  expect(built.success).toBe(true)
  const bundle = await built.outputs[0]!.text()
  // 迁移 CLI 分支（含 `migration-report-` 证据文件名）只能留在迁移入口自身，不得进入管理员产物。
  expect(bundle.includes("migration-report-")).toBe(false)
  mkdirSync(join(stage, "distribution/linux"), { recursive: true })
  cpSync(join(repoRoot, "UPSTREAM_LOCK.json"), join(stage, "UPSTREAM_LOCK.json"))
  // bundle 仍保留 @deepseek-ai/* external；发行 stage 由打包器提供 node_modules 布局，这里用开发树依赖代替。
  symlinkSync(join(repoRoot, "node_modules"), join(stage, "node_modules"), "dir")
  const bundlePath = join(stage, "distribution/linux/administrator.js")
  writeFileSync(bundlePath, bundle)
  // 用**跑本用例的那个解释器**（`process.execPath`）起产物，不按名字 spawn `"node"`：
  // 这个 bundle 是 `target:"node"` 构建、由 `script/package-linux.ts:15` 的 `--node`（默认 `'node'`）**随发行包发运**的，
  // 而**发行环境的运行器不保证是 node** ⇒ 判据不该把 node 写死。三条断言逐条不变（前一单已实测 node 与 bun 下全中）。
  const run = spawnSync(process.execPath, [bundlePath, "--help"], { encoding: "utf8" })
  expect(run.stderr).not.toContain("ERR_PARSE_ARGS_UNKNOWN_OPTION")
  expect(run.status).toBe(0)
  expect(run.stdout).toContain("超级管理员原生模型直连工作台")
}, 120_000)
