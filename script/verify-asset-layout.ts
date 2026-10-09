#!/usr/bin/env bun
/**
 * verify-asset-layout.ts —— 存储分治（worlds/assets/robots/cache/catalog）验收脚本。
 *
 * 用途
 *   `~/.bun/bin/bun run script/verify-asset-layout.ts [--root .runtime/developer] [--product-root .] [--keep]`
 *   一次跑完两组检查，逐项打印 `[PASS]/[FAIL]/[SKIP] 名称 → 证据`：
 *     · 静态检查（25 项）：L0 策展库分域、运行根五域、旧 `scene/` 已迁移、引用无旧前缀、
 *       workspace 映射软链、接线（runtime-paths / launch / runtime-patch / scene-kit layout.ts / plugin.ts）、
 *       scene-kit dist 已重建。
 *     · 集成检查（20 项）：用 `packages/scene-kit/src/operations.ts` 的 SceneOperations 在临时根上真建库，
 *       断言场景落 `worlds/scenes`、机器人/小物件/环境三类 materialized 落点、
 *       reference 不落域目录、运行根之外原件走 `cache/cas`、唯一索引在 `catalog/index.json`、旧单根不复活。
 *   末尾打印 `汇总：PASS=n FAIL=n SKIP=n`；有 FAIL 时退出码 1，否则 0。
 *
 * 为什么存在
 *   这两组检查原先分散在两个一次性脚本里：`.runtime/goal-verify/check-asset-layout.sh`（25 项静态）
 *   与 `.runtime/goal-verify/layout-integration-check.ts`（20 项集成）。`.runtime/` 不入库，
 *   脚本会随临时目录一起消失；shell 版还依赖 python3、写死仓库绝对路径、且部分 grep 判定过弱
 *   （详见下方“已知修正”）。本文件是两者的合并与可入库版本：同一套判定、同一套证据格式，
 *   只用 node 内置模块 + 通过相对路径 import 仓库源码，仓库演进导致路径改名时按 FAIL 报出期望路径。
 *
 * 边界（重要）
 *   **这不是产品运行路径**：产品启动 / 导入 / 迁移都不经过本文件，它只是验收。
 *   静态检查只读；集成检查只在临时根里建库，跑完删除（`--keep` 保留并打印路径）。
 *
 * 参数
 *   --root <dir>          运行根的父目录，默认 `<产品根>/.runtime/developer`；真正运行根 = `<root>/developer`
 *                         （developer 模式，直接由产品 `runtimePaths()` 推导，不在这里另写一套规则）。
 *                         该目录不存在时，运行根相关检查标 SKIP 而不是 FAIL。
 *   --product-root <dir>  产品仓库根，默认本文件所在目录的上一级（`import.meta.dirname/..`）。
 *   --ci                  在唯一临时树中用原生路径/映射/场景操作建立布局夹具，不读取已有开发运行根。
 *                         夹具缺失计 FAIL；与 --root 互斥。不构成已有用户数据或 profile 启动验收。
 *   --keep                保留集成检查的临时根并打印路径。
 *   --help                打印用法。
 *   相对路径一律按产品根解析，因此从任意 cwd 调用等价。
 *
 * 已知修正（原脚本里的“假通过”，合并时已修）
 *   1. 集成检查「索引内无旧根路径」原写 `index.resources ?? index.items`，而目录索引的真实顶层键是
 *      `records` → 永远迭代空数组、永远 PASS。现改为读 `records`（兼容旧键），并在证据里打印扫描条数；
 *      索引结构不识别时直接 FAIL，不再静默通过。原判定的通配正则 `/\/scene\//` 也匹配不到它声称要抓的
 *      旧单根复数目录 `scenes/`，现补上锚定在运行根下的 `{scene,scenes,resources,provider-jobs}/` 前缀。
 *   2. 静态检查「runtime-patch 传 layout」原判定是 `grep -q "layout"`，注释里出现 layout 即通过。
 *      现要求 `domains?: RuntimeDomains` + `layout: { worlds: d.worldsRoot, … }` + `defaultStorage: "materialized"`。
 *   3. 静态检查「catalog/worlds 内无旧 scene/ 绝对路径」原用 `grep -rl … | wc -l`，目录不存在时 grep 报错、
 *      计数为 0，于是“扫不到”被当成“没有旧引用”。现要求两个扫描目录必须存在，否则 FAIL。
 *   4. 集成检查「运行根之外原件走 CAS」原件其实在 `.runtime/goal-verify/layout-it-external`（产品根内，
 *      默认规则会判成 reference），只有显式 `storage:"cas"` 才落 CAS。现在夹具放在临时根、产品根之外，
 *      检查名与语义一致；同时保留显式 `storage:"cas"` 入参，验证同一件事：CAS 归口 `<cache>/cas`。
 *   5. 集成检查原会在夹具缺失 / 目录缺失时直接抛异常（如 `readdirSync` 出现在断言外），使 FAIL 变成崩溃。
 *      现所有取数都先做安全读取，缺件判 FAIL 或 SKIP，脚本始终能打出汇总。
 *   6. 原集成脚本在 `.runtime/` 下（tsconfig 的 exclude 里），从不参与 `tsc`；它给 `SceneOperations.import`
 *      传的 `category` 其实不在该方法的形参类型里（运行期透传给 `ResourceLibrary.import`，产品工具链正是
 *      从那一层传类别的）。本文件在 `script/**` 下会被类型检查，因此用显式交叉类型标注 category，
 *      调用路径与落点判定完全不变，也不改产品源码。
 */
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, extname, join, relative, resolve, sep } from "node:path"
import { gzipSync } from "node:zlib"
import { createHash } from "node:crypto"
import { parseAsset } from "../packages/scene-kit/src/formats.ts"

// 唯一的产品源码依赖：验收直接用产品实现真建库，不复制产品逻辑。
import { SceneOperations } from "../packages/scene-kit/src/operations.ts"
// 运行根位置也走产品自己的解析规则（developer 模式 = <root>/developer）。
import { ensureWorkspaceMapping, runtimePaths, sceneLayout } from "../packages/lyapunov-product-bundle/src/runtime-paths.ts"

const USAGE = `存储分治验收（静态 + 集成）

用法：
  bun run script/verify-asset-layout.ts [--root .runtime/developer] [--product-root .] [--keep]

  --root <dir>          运行根的父目录（默认 <产品根>/.runtime/developer），真正运行根 = <root>/developer
  --product-root <dir>  产品仓库根（默认本文件所在目录的上一级）
  --ci                  创建并检查临时布局夹具，不读取已有运行根；夹具缺失计 FAIL，与 --root 互斥
  --keep                保留集成检查的临时根并打印路径
  --help                打印本用法
`

type Status = "PASS" | "FAIL" | "SKIP"
interface Result { status: Status; name: string; evidence: string }

/**
 * `SceneOperations.import` 的形参类型没有声明 `category`，但运行期会把整个入参透传给
 * `ResourceLibrary.import`（那里 `category: "robot" | "object" | "background"` 是正式入参，产品工具链也从那层传类别）。
 * 这里显式交叉出带 category 的输入类型：不写 `as any`，也不改产品源码，落点判定走的仍是产品实现。
 */
type SceneImportInput = Parameters<SceneOperations["import"]>[0]
type CategorizedImportInput = SceneImportInput & { category: "robot" | "object" | "background" }

const results: Result[] = []

function emit(status: Status, name: string, evidence: string): void {
  results.push({ status, name, evidence })
  console.log(`[${status}] ${name}${evidence ? ` → ${evidence}` : ""}`)
}
const pass = (name: string, evidence = "") => emit("PASS", name, evidence)
const fail = (name: string, evidence = "") => emit("FAIL", name, evidence)
const skip = (name: string, evidence = "") => emit("SKIP", name, evidence)
function check(name: string, ok: boolean, okEvidence: string, failEvidence?: string): void {
  if (ok) pass(name, okEvidence)
  else fail(name, failEvidence ?? okEvidence)
}
function section(title: string): void { console.log(`\n== ${title} ==`) }
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function isFile(path: string): boolean { try { return statSync(path).isFile() } catch { return false } }
/** 只读文本；缺文件返回空串（调用点据此判 FAIL）。 */
function readText(path: string): string { try { return readFileSync(path, "utf8") } catch { return "" } }
function isDir(path: string): boolean { try { return statSync(path).isDirectory() } catch { return false } }
function isLink(path: string): boolean { try { return lstatSync(path).isSymbolicLink() } catch { return false } }
/** 人类可读的路径状态，用于 FAIL 证据；任何异常都降级成“不存在”，绝不让检查本身抛错。 */
function describePath(path: string): string {
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink()) return `软链 → ${readlinkSync(path)}`
    return info.isDirectory() ? "真实目录" : "普通文件"
  } catch { return "不存在" }
}
/** 递归列出普通文件（不跟随软链，避免环与跨域重复计数）。 */
function walkFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}
function safeReaddir(directory: string): string[] {
  try { return readdirSync(directory) } catch { return [] }
}
/** 分块按字节查子串：引用检查要能扫二进制原件，且不把大文件整块读进内存。 */
function containsBytes(path: string, needle: Buffer): boolean {
  const size = statSync(path).size
  const descriptor = openSync(path, "r")
  try {
    const chunkSize = 1 << 20
    let carry = Buffer.alloc(0)
    let position = 0
    while (position < size) {
      const buffer = Buffer.allocUnsafe(Math.min(chunkSize, size - position))
      const read = readSync(descriptor, buffer, 0, buffer.length, position)
      if (read <= 0) break
      position += read
      const head = buffer.subarray(0, read)
      const data = carry.length ? Buffer.concat([carry, head]) : head
      if (data.includes(needle)) return true
      carry = data.subarray(Math.max(0, data.length - needle.length + 1))
    }
    return false
  } finally { closeSync(descriptor) }
}

interface Options { productRoot: string; rootParent: string; keep: boolean; ci: boolean }

function parseArgs(argv: string[]): Options {
  let productRootValue = resolve(import.meta.dirname, "..")
  let rootValue = ".runtime/developer"
  let explicitRoot = false
  let keep = false
  let ci = false
  const valueOf = (index: number, flag: string): string => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} 需要参数值`)
    return value
  }
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token === "--keep") { keep = true; continue }
    if (token === "--ci") { ci = true; continue }
    if (token === "--root") { rootValue = valueOf(index, "--root"); explicitRoot = true; index++; continue }
    if (token === "--product-root") { productRootValue = valueOf(index, "--product-root"); index++; continue }
    if (token === "--help" || token === "-h") { console.log(USAGE); process.exit(0) }
    throw new Error(`未知参数 ${token}\n\n${USAGE}`)
  }
  if (ci && explicitRoot) throw new Error("--ci 不读取已有运行根，不能与 --root 同用")
  // --product-root 相对 cwd 解析；--root 相对产品根解析（默认值本身就是产品根下的相对路径）。
  const productRoot = resolve(process.cwd(), productRootValue)
  return { productRoot, rootParent: resolve(productRoot, rootValue), keep, ci }
}

/** 运行根 = 产品 runtimePaths 在 developer 模式下算出的 root；解析失败时按约定 `<root>/developer` 兜底。 */
function resolveRunRoot(rootParent: string): { runRoot: string; how: string } {
  try {
    return { runRoot: runtimePaths({ mode: "developer", root: rootParent }).root, how: "runtimePaths({mode:'developer'})" }
  } catch (error) {
    return { runRoot: join(rootParent, "developer"), how: `runtimePaths 解析失败（${message(error)}），按 <root>/developer 约定` }
  }
}

/** 源码接线检查：读仓库文件、按正则逐条判定；缺文件或正则不匹配都带上期望路径报 FAIL。 */
function wiringCheck(name: string, productRoot: string, relativePath: string, expectations: { pattern: RegExp; label: string }[], forbidden: { pattern: RegExp; label: string }[] = []): void {
  const path = join(productRoot, relativePath)
  if (!isFile(path)) { fail(name, `缺文件 ${relativePath}（期望路径 ${path}）`); return }
  const text = readFileSync(path, "utf8")
  const missing = expectations.filter(item => !item.pattern.test(text)).map(item => item.label)
  const present = forbidden.filter(item => item.pattern.test(text)).map(item => item.label)
  check(name, missing.length === 0 && present.length === 0,
    `${relativePath}：${expectations.map(item => item.label).join(" + ")}`,
    `${relativePath}：缺 [${missing.join("、")}]${present.length ? `；仍含旧 [${present.join("、")}]` : ""}（期望路径 ${path}）`)
}

/** 运行根不存在时，人工巡检计 SKIP；CI 夹具检查计 FAIL。 */
const runRootMissing = (runRoot: string) => `运行根 ${runRoot} 不存在（--root 的父目录下应有 developer/）；该项依赖运行根`

/** 只接收明确的运行根；调用方在 CI 中必须传临时夹具，不使用开发根兜底。 */
export function verifyRuntimeLayout(productRoot: string, runRoot: string, required = false): Result[] {
  const found: Result[] = []
  const hasRunRoot = isDir(runRoot)
  const record = (name: string, inspect: () => { ok: boolean; evidence: string }): void => {
    if (!hasRunRoot) { found.push({ status: required ? "FAIL" : "SKIP", name, evidence: runRootMissing(runRoot) }); return }
    try {
      const { ok, evidence } = inspect()
      found.push({ status: ok ? "PASS" : "FAIL", name, evidence })
    } catch (error) { found.push({ status: "FAIL", name, evidence: message(error) }) }
  }
  for (const domain of ["worlds", "assets", "robots", "cache", "catalog"]) {
    record(`运行根 ${domain}/ 存在`, () => ({ ok: isDir(join(runRoot, domain)), evidence: join(runRoot, domain) }))
  }
  record("旧单根 scene/ 已迁移", () => ({ ok: !existsSync(join(runRoot, "scene")), evidence: `期望不存在：${join(runRoot, "scene")}` }))
  record("场景文档位于 worlds/scenes/", () => {
    const directory = join(runRoot, "worlds/scenes")
    const documents = safeReaddir(directory).filter(name => name.endsWith(".json") && isFile(join(directory, name)))
    return { ok: documents.length > 0, evidence: `${directory}：${documents.length} 个场景文档` }
  })
  record("catalog/worlds 内无旧 scene/ 绝对路径", () => {
    const roots = ["catalog", "worlds"].map(domain => join(runRoot, domain))
    const absent = roots.filter(directory => !isDir(directory))
    if (absent.length) return { ok: false, evidence: `扫描目录缺失，无法判定：${absent.join("、")}` }
    const files = roots.flatMap(walkFiles)
    const needle = Buffer.from(`${runRoot}/scene/`)
    const hits = files.filter(file => containsBytes(file, needle))
    return { ok: hits.length === 0, evidence: `按字节扫描 ${runRoot}/{catalog,worlds} 共 ${files.length} 个文件；旧路径命中 ${hits.length}${hits.length ? `：${hits.slice(0, 3).join("、")}` : ""}` }
  })
  const mapped = (path: string, target: string) => {
    const ok = isLink(path) && resolve(path, "..", readlinkSync(path)) === resolve(target) && isDir(target)
    return { ok, evidence: `${path}（${describePath(path)}）；期望目标 ${target}` }
  }
  for (const domain of ["worlds", "assets", "robots", "cache"]) {
    record(`workspace/${domain} 软链`, () => mapped(join(runRoot, "workspace", domain), join(runRoot, domain)))
  }
  record("产品根 workspace 映射软链", () => mapped(join(productRoot, "workspace"), join(runRoot, "workspace")))
  return found
}

/** 原生路径解析 + 映射 + 场景写入全部在唯一临时树内，绝不认领真实产品 workspace。 */
/** 保原始引用路径复制真实依赖闭包；不把含assets引用的原XML变成缺依赖的单文件。 */
async function copyFixtureAsset(source: string, target: string): Promise<void> {
  const parsed = await parseAsset(source)
  for (const dependency of parsed.dependencies) {
    const path = relative(dirname(source), dependency.path)
    if (path.startsWith("..") || path.startsWith(sep)) throw new Error(`CI 夹具依赖越出源目录：${dependency.path}`)
    const destination = dependency.path === source ? target : join(dirname(target), path)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(dependency.path, destination)
  }
}

/** 原创128个道路高斯+32个路沿高斯，完整SPZ v2各数据块；不是只有位置头的占位件。 */
function ciStreetSpz(): { bytes: Buffer; minY: number } {
  const points: Array<[number, number, number]> = []
  for (let x = 0; x < 16; x++) for (let z = 0; z < 8; z++) points.push([x * .4 - 3, -2.5 + x * .002, z * .4 - 1.4])
  for (let x = 0; x < 16; x++) for (const z of [-1.8, 1.8]) points.push([x * .4 - 3, -2.3 + x * .002, z])
  const count = points.length, data = Buffer.alloc(16 + count * 19)
  data.writeUInt32LE(0x5053474e, 0); data.writeUInt32LE(2, 4); data.writeUInt32LE(count, 8); data[13] = 12
  points.forEach((point, index) => {
    point.forEach((value, axis) => data.writeUIntLE(Math.round(value * 4096) & 0xffffff, 16 + index * 9 + axis * 3, 3))
    data[16 + count * 9 + index] = 240 // opacity
    data.fill(index < 128 ? 104 : 160, 16 + count * 10 + index * 3, 16 + count * 10 + index * 3 + 3) // RGB DC
    data.set([66, 44, 66], 16 + count * 13 + index * 3) // finite anisotropic scales
    data.set([128, 128, 128], 16 + count * 16 + index * 3) // identity quaternion xyz, positive w
  })
  return { bytes: gzipSync(data), minY: Math.min(...points.map(point => point[1])) }
}

export async function createCiLayoutFixture(sourceRoot = resolve(import.meta.dirname, "..")) {
  const directory = mkdtempSync(join(tmpdir(), "lyapunov-asset-layout-ci-"))
  try {
    const productRoot = join(directory, "product")
    const paths = runtimePaths({ mode: "developer", root: join(directory, "runtime") })
    mkdirSync(productRoot, { recursive: true })
    mkdirSync(paths.catalogRoot, { recursive: true })
    await ensureWorkspaceMapping({ productRoot, workspaceRoot: paths.workspaceRoot, paths })
    const operations = new SceneOperations(paths.catalogRoot, { productRoot, layout: sceneLayout(paths), defaultStorage: "materialized" })
    await operations.create({ sceneId: "asset-layout-ci" })
    // 只复制批准公开的真实模型，材料库是本次CI原生夹具自己的清单，不读已有workspace库。
    const robot = join(productRoot, "materials/robots/ci-arm/arm.xml")
    const object = join(productRoot, "materials/assets/objects/ci-object.glb")
    const world = join(productRoot, "materials/worlds/background/ci-road.spz")
    await copyFixtureAsset(join(sourceRoot, "packages/sim-mujoco/fixtures/arm.xml"), robot)
    await copyFixtureAsset(join(sourceRoot, "materials/mcp-env/assets/kenney-props/visual/prop_13_construction-cone.glb"), object)
    const road = ciStreetSpz()
    mkdirSync(dirname(world), { recursive: true }); writeFileSync(world, road.bytes)
    const sources = { robot, object, world }
    const resources = Object.entries(sources).map(([kind, path]) => ({ kind, path: relative(join(productRoot, "materials"), path).split(sep).join("/"), sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), license: kind === "object" ? "CC0-1.0" : "original-ci-fixture", bytesOrigin: kind === "world" ? "generated complete SPZ v2 road/curb Gaussian model; not the manual street asset" : "unchanged approved public source bytes" }))
    writeFileSync(join(productRoot, "materials/library.json"), JSON.stringify({ schema_version: "2.0", scope: "ci-fixture", resources }, null, 2))
    // 期望取作者原始几何坐标，不取受测decoder；真正parseAsset/assetBounds须独立读回Y→Z。
    return { directory, productRoot, paths, sources, splatCheck: { path: world, expectedLocalMinZ: road.minY } }
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
}

export function verifyMaterialLibrary(productRoot: string, ciFixture = false): Result[] {
  const found: Result[] = []
  const check = (name: string, ok: boolean, evidence: string, failure = evidence) => found.push({ name, status: ok ? "PASS" : "FAIL", evidence: ok ? evidence : failure })
  const skip = (name: string, evidence: string) => found.push({ name, status: ciFixture ? "FAIL" : "SKIP", evidence })
  const fail = (name: string, evidence: string) => found.push({ name, status: "FAIL", evidence })
  const short = (path: string): string => {
    const rel = relative(productRoot, path)
    return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : path
  }

  const libraryPath = join(productRoot, "materials/library.json")
  check("materials/library.json 存在", isFile(libraryPath), short(libraryPath), `缺文件 ${libraryPath}`)
  for (const directory of ["materials/robots", "materials/worlds", "materials/assets/objects"]) {
    const path = join(productRoot, directory)
    check(`${directory} 存在`, isDir(path), short(path), `缺目录 ${path}`)
  }
  const legacyLibrary = join(productRoot, "materials/assets/resource-library")
  check("旧 materials/assets/resource-library 已移除", !existsSync(legacyLibrary), `${short(legacyLibrary)} 不存在`, `旧目录仍在：${legacyLibrary}（期望路径 ${legacyLibrary} 不存在）`)
  if (!isFile(libraryPath)) skip("library 条目全部可解析且原件存在", `缺 ${libraryPath}`)
  else {
    try {
      const parsed = JSON.parse(readFileSync(libraryPath, "utf8")) as { resources?: unknown; scope?: unknown }
      const materials = join(productRoot, "materials")
      const entries = Array.isArray(parsed.resources) ? parsed.resources as { path?: unknown }[] : []
      const missing: string[] = []
      const outside: string[] = []
      for (const entry of entries) {
        const declared = typeof entry?.path === "string" ? entry.path : ""
        const absolute = resolve(materials, declared)
        if (!declared || !(absolute === materials || absolute.startsWith(materials + sep))) { outside.push(declared || "(空)"); continue }
        if (!existsSync(absolute)) missing.push(declared)
      }
      check("library 条目全部可解析且原件存在", entries.length > 0 && missing.length === 0 && outside.length === 0 && (!ciFixture || parsed.scope === "ci-fixture"),
        `条目 ${entries.length}，缺失 0（path 均相对 materials/ 且原件存在）`,
        `条目 ${entries.length}，缺失 ${missing.length}${missing.length ? `（例：${missing.slice(0, 3).join("、")}）` : ""}${outside.length ? `；越界路径 ${outside.length}：${outside.slice(0, 3).join("、")}` : ""}${ciFixture && parsed.scope !== "ci-fixture" ? `；CI材料scope必须为ci-fixture，实际${String(parsed.scope)}` : ""}`)
    } catch (error) {
      fail("library 条目全部可解析且原件存在", `读取/解析 ${short(libraryPath)} 失败：${message(error)}（期望路径 ${libraryPath}）`)
    }
  }
  return found
}

function runStaticChecks(productRoot: string, runRoot: string, runtimeProductRoot = productRoot, requireRunRoot = false): void {
  section("L0 策展库分域")
  for (const result of verifyMaterialLibrary(requireRunRoot ? runtimeProductRoot : productRoot, requireRunRoot)) emit(result.status, result.name, result.evidence)

  section("运行根五域、引用与工作文件夹映射")
  for (const result of verifyRuntimeLayout(runtimeProductRoot, runRoot, requireRunRoot)) {
    emit(result.status, result.name, result.evidence)
  }

  section("接线与实现")
  wiringCheck("runtime-paths 有五个域根与 sceneLayout", productRoot, "packages/lyapunov-product-bundle/src/runtime-paths.ts", [
    { pattern: /worldsRoot/, label: "worldsRoot" },
    { pattern: /assetsRoot/, label: "assetsRoot" },
    { pattern: /robotsRoot/, label: "robotsRoot" },
    { pattern: /cacheRoot/, label: "cacheRoot" },
    { pattern: /catalogRoot/, label: "catalogRoot" },
    { pattern: /export function sceneLayout/, label: "export function sceneLayout" },
  ])
  wiringCheck("launch 传 domains", productRoot, "script/launch.ts", [
    { pattern: /domains\s*:\s*runtime\.paths/, label: "domains: runtime.paths" },
  ])
  wiringCheck("runtime-patch 按 domains 铺五域布局", productRoot, "script/runtime-patch.ts", [
    { pattern: /domains\?:\s*RuntimeDomains/, label: "domains?: RuntimeDomains" },
    { pattern: /layout\s*:\s*\{\s*worlds\s*:\s*d\.worldsRoot/, label: "layout: { worlds: d.worldsRoot, … }" },
    { pattern: /defaultStorage\s*:\s*"materialized"/, label: "defaultStorage: \"materialized\"" },
  ])
  wiringCheck("scene-kit layout.ts 存在且给出域内 home", productRoot, "packages/scene-kit/src/layout.ts", [
    { pattern: /export interface SceneLayout/, label: "export interface SceneLayout" },
    { pattern: /export function resolveSceneLayout/, label: "export function resolveSceneLayout" },
    { pattern: /export function materializedHome/, label: "export function materializedHome" },
  ])
  wiringCheck("scene-kit 读新 library.json", productRoot, "packages/scene-kit/src/plugin.ts", [
    { pattern: /materials\/library\.json/, label: "materials/library.json" },
  ], [
    { pattern: /materials\/assets\/resource-library/, label: "materials/assets/resource-library" },
  ])

  section("构建产物")
  wiringCheck("scene-kit dist 已重建并指向新库", productRoot, "packages/scene-kit/dist/plugin.js", [
    { pattern: /materials\/library\.json/, label: "materials/library.json" },
  ], [
    { pattern: /materials\/assets\/resource-library/, label: "materials/assets/resource-library" },
  ])
}

/** 集成夹具：优先期望路径；改名后先找同类真实文件继续跑（FAIL 照报），实在没有才让相关检查 SKIP。 */
function pickFixture(productRoot: string, canonicalRelative: string, searchRelative: string, extensions: string[], maxBytes: number): string | undefined {
  const canonical = join(productRoot, canonicalRelative)
  if (isFile(canonical)) return canonical
  const searchDirectory = join(productRoot, searchRelative)
  const candidates = isDir(searchDirectory)
    ? walkFiles(searchDirectory).filter(file => extensions.includes(extname(file).toLowerCase()) && statSync(file).size <= maxBytes).sort()
    : []
  if (candidates.length) {
    fail(`集成夹具 ${canonicalRelative} 可用`, `未找到期望路径 ${canonical}；改用同类文件 ${relative(productRoot, candidates[0]!)} 继续跑（检查结果仍有效）`)
    return candidates[0]
  }
  fail(`集成夹具 ${canonicalRelative} 可用`, `未找到期望路径 ${canonical}，且 ${searchDirectory} 下没有可用的 ${extensions.join("/")} 文件；相关检查跳过`)
  return undefined
}

async function runIntegrationChecks(productRoot: string, keep: boolean, fixtureSources?: { robot: string; object: string; world: string }): Promise<void> {
  section("集成检查（scene-kit 真建库，临时根）")
  const workDirectory = mkdtempSync(join(tmpdir(), "lyapunov-verify-asset-layout-"))
  console.log(`[INFO] 集成临时根：${workDirectory}${keep ? "（--keep 保留）" : "（跑完删除）"}`)

  const runRoot = join(workDirectory, "run")
  const layout = {
    worlds: join(runRoot, "worlds"),
    assets: join(runRoot, "assets"),
    robots: join(runRoot, "robots"),
    cache: join(runRoot, "cache"),
    catalog: join(runRoot, "catalog"),
  }
  const staging = join(runRoot, "staging")
  const externalDirectory = join(workDirectory, "external")
  const short = (path: string | undefined): string => (path ? relative(workDirectory, path) || "." : "(无)")
  const inside = (path: string | undefined, directory: string): boolean => Boolean(path && resolve(path).startsWith(resolve(directory) + sep))
  /** 每个导入/建库步骤单独兜错：步骤抛错记 FAIL，依赖它的检查转 SKIP，汇总照常打印。 */
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T | undefined> => {
    try { return await run() } catch (error) { fail(`集成步骤「${name}」`, message(error)); return undefined }
  }
  const stage = async (targetName: string, source: string | undefined): Promise<string | undefined> => {
    if (!source) return undefined
    try {
      const target = join(staging, targetName)
      if (fixtureSources) await copyFixtureAsset(source, target)
      else copyFileSync(source, target) // 手工audit保原暂存行为与原件判据。
      return target
    } catch (error) { fail(`集成夹具暂存 ${targetName}`, `${message(error)}（源 ${source}）`); return undefined }
  }

  try {
    mkdirSync(staging, { recursive: true })
    mkdirSync(externalDirectory, { recursive: true })

    // 夹具都来自产品内置库 materials/：机器人 MJCF、小物件 GLB、环境 SPZ。
    const robotSource = fixtureSources?.robot ?? pickFixture(productRoot, "materials/robots/lyaup-demo-arm/Lyaup演示机械臂.mjcf", "materials/robots", [".mjcf", ".xml"], 4 << 20)
    const objectSource = fixtureSources?.object ?? pickFixture(productRoot, "materials/assets/objects/obj_0689184dc001623LtClbHUMinc/raw/source.glb", "materials/assets/objects", [".glb"], 64 << 20)
    const worldSource = fixtureSources?.world ?? pickFixture(productRoot, "materials/worlds/background/industrial-warehouse-forklift-training.spz", "materials/worlds", [".spz"], 64 << 20)
    const robotFile = await stage("robot.mjcf", robotSource)
    const objectFile = await stage("object.glb", objectSource)
    const worldFile = await stage("world.spz", worldSource)

    // 按产品实际传参建库：layout 五域 + 新导入默认 materialized（script/runtime-patch.ts 的同一组参数）。
    const operations = new SceneOperations(layout.catalog, { productRoot, layout, defaultStorage: "materialized" })

    // 1) 世界域：场景文档
    const sceneName = "场景文档落在 <worlds>/scenes"
    const scene = await step("create 场景", () => operations.create({ name: "分治集成测试世界" }))
    if (!scene) skip(sceneName, "create 未成功（见上）")
    else {
      const path = operations.scene.path(scene.sceneId)
      check(sceneName, inside(path, join(layout.worlds, "scenes")) && isFile(path),
        `${short(path)}（文件存在）`,
        `期望 <worlds>/scenes/**，实际 ${path}${isFile(path) ? "" : "（文件不存在）"}`)
    }

    // 2) 机器人域
    const robotChecks = [
      "机器人 storage=materialized",
      "机器人 home.domain=robots",
      "机器人字节落在 <robots>/<id>/source",
      "机器人 storedEntryPath 指向域内",
      "机器人 <id>/source 目录真实存在且非空",
    ]
    if (!robotFile) for (const name of robotChecks) skip(name, "机器人夹具缺失（见上）")
    else {
      const input: CategorizedImportInput = { path: robotFile, name: "集成测试机器人", category: "robot" }
      const imported = await step("导入机器人（category=robot，默认 materialized）", () => operations.import(input))
      const robot = imported?.resource
      if (!robot) for (const name of robotChecks) skip(name, "导入未成功（见上）")
      else {
        const sourceDirectory = join(layout.robots, robot.ref.resourceId, "source")
        const files = safeReaddir(sourceDirectory)
        check(robotChecks[0]!, robot.storage === "materialized", String(robot.storage), `期望 materialized，实际 ${String(robot.storage)}`)
        check(robotChecks[1]!, robot.home?.domain === "robots", String(robot.home?.domain), `期望 robots，实际 ${String(robot.home?.domain)}`)
        check(robotChecks[2]!, inside(robot.home?.entryPath, layout.robots), short(robot.home?.entryPath), `期望 <robots>/<id>/source/**，实际 ${robot.home?.entryPath ?? "(无 home)"}`)
        check(robotChecks[3]!, inside(robot.storedEntryPath, layout.robots), short(robot.storedEntryPath), `期望 <robots>/**，实际 ${robot.storedEntryPath ?? "(无)"}`)
        check(robotChecks[4]!, files.length > 0, `${files.length} 个文件：${files.slice(0, 3).join("、")}`, `期望非空目录 ${sourceDirectory}，实际 ${files.length} 个文件`)
      }
    }

    // 3) 小物件域（mesh 跳过物理化，避免依赖算法解释器）
    const objectChecks = [
      "小物件 storage=materialized",
      "小物件 home.domain=assets",
      "小物件字节落在 <assets>/<id>/source",
      "小物件 storedEntryPath 指向域内",
    ]
    if (!objectFile) for (const name of objectChecks) skip(name, "小物件夹具缺失（见上）")
    else {
      const input: CategorizedImportInput = { path: objectFile, name: "集成测试小物件", category: "object", physicalize: false }
      const imported = await step("导入小物件（category=object，physicalize=false）", () => operations.import(input))
      const object = imported?.resource
      if (!object) for (const name of objectChecks) skip(name, "导入未成功（见上）")
      else {
        check(objectChecks[0]!, object.storage === "materialized", String(object.storage), `期望 materialized，实际 ${String(object.storage)}`)
        check(objectChecks[1]!, object.home?.domain === "assets", String(object.home?.domain), `期望 assets，实际 ${String(object.home?.domain)}`)
        check(objectChecks[2]!, inside(object.home?.entryPath, layout.assets), short(object.home?.entryPath), `期望 <assets>/<id>/source/**，实际 ${object.home?.entryPath ?? "(无 home)"}`)
        check(objectChecks[3]!, inside(object.storedEntryPath, layout.assets), short(object.storedEntryPath), `期望 <assets>/**，实际 ${object.storedEntryPath ?? "(无)"}`)
      }
    }

    // 4) 世界域：环境（background → worlds/environments/<id>/source）
    const worldChecks = ["环境 home.domain=worlds", "环境字节落在 <worlds>/environments/<id>/source"]
    if (!worldFile) for (const name of worldChecks) skip(name, "环境夹具缺失（见上）")
    else {
      const input: CategorizedImportInput = { path: worldFile, name: "集成测试环境", category: "background" }
      const imported = await step("导入环境（category=background）", () => operations.import(input))
      const environment = imported?.resource
      if (!environment) for (const name of worldChecks) skip(name, "导入未成功（见上）")
      else {
        check(worldChecks[0]!, environment.home?.domain === "worlds", String(environment.home?.domain), `期望 worlds，实际 ${String(environment.home?.domain)}`)
        check(worldChecks[1]!, inside(environment.home?.entryPath, join(layout.worlds, "environments")), short(environment.home?.entryPath), `期望 <worlds>/environments/<id>/source/**，实际 ${environment.home?.entryPath ?? "(无 home)"}`)
      }
    }

    // 5) 显式 reference 仍保持“引用原位置”，不被分治改写
    const referenceCheck = "reference 模式不落域目录"
    if (!robotFile) skip(referenceCheck, "机器人夹具缺失（见上）")
    else {
      const input: CategorizedImportInput = { path: robotFile, resourceId: "res_it_reference", name: "引用模式机器人", category: "robot", storage: "reference" }
      const imported = await step("导入 reference 机器人", () => operations.import(input))
      const reference = imported?.resource
      if (!reference) skip(referenceCheck, "导入未成功（见上）")
      else check(referenceCheck, !inside(reference.storedEntryPath, layout.robots) && reference.home === undefined && reference.storage === "reference",
        `${reference.storage}，落点 ${short(reference.storedEntryPath)}，home 无`,
        `期望 storage=reference 且不落 <robots> 且无 home，实际 ${String(reference.storage)} / ${reference.storedEntryPath ?? "(无)"} / home=${reference.home ? reference.home.domain : "(无)"}`)
    }

    // 6) 索引只在 <catalog>，且旧单根目录不再生成
    const indexPath = join(layout.catalog, "index.json")
    check("索引在 <catalog>/index.json", isFile(indexPath), short(indexPath), `期望文件 ${indexPath}`)
    const staleName = "索引内无旧根路径（scene/resources/assets-raw）"
    if (!isFile(indexPath)) skip(staleName, `缺索引 ${indexPath}`)
    else {
      const index = JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, unknown>
      const raw = index.records ?? index.resources ?? index.items
      if (!Array.isArray(raw)) fail(staleName, `索引结构不识别：期望 records 数组，实际顶层键 [${Object.keys(index).join("、")}]（期望路径 ${indexPath}）`)
      else {
        const records = raw as { storedEntryPath?: string }[]
        // 旧单根落点：<runRoot>/{scene,scenes,resources,provider-jobs}/ 直接位于运行根下（分治后那里只有五个域 + workspace）。
        // 原脚本只用 /\/scene\// 这类通配正则，永远匹配不到它声称要抓的复数 `scenes/`，这里补上锚定前缀。
        const legacyPrefixes = ["scene", "scenes", "resources", "provider-jobs"].map(directory => join(runRoot, directory) + sep)
        const stale = records.filter(record => typeof record.storedEntryPath === "string"
          && (legacyPrefixes.some(prefix => record.storedEntryPath!.startsWith(prefix)) || /\/scene\/|\/resources\/|\/assets\/raw\//.test(record.storedEntryPath)))
        check(staleName, stale.length === 0,
          `扫描 ${records.length} 条记录，旧路径 0（锚定前缀 ${legacyPrefixes.length} 个 + 旧根通配 3 个）`,
          `扫描 ${records.length} 条记录，命中 ${stale.length}：${stale.slice(0, 3).map(record => short(record.storedEntryPath)).join("、")}`)
      }
    }
    for (const legacy of ["scenes", "resources"]) {
      const path = join(runRoot, legacy)
      check(`运行根未生成旧目录 ${legacy}/`, !existsSync(path), `${short(path)} 不存在`, `旧目录仍在：${path}（期望路径 ${path} 不存在）`)
    }

    // 7) 运行根之外（也在产品根之外）的原件走 CAS，必须落进 <cache>/cas
    const casChecks = ["外部原件 storage=cas", "外部原件字节落在 <cache>/cas", "cache/ 域已建立（CAS/派生/下载归口）"]
    if (!objectFile) for (const name of casChecks) skip(name, "小物件夹具缺失（见上，CAS 原件由它复制）")
    else {
      const externalFile = join(externalDirectory, "external-object.glb")
      const input: CategorizedImportInput = { path: externalFile, name: "外部原件", category: "object", storage: "cas", physicalize: false }
      const imported = await step("导入运行根之外原件（storage=cas）", async () => {
        copyFileSync(objectFile, externalFile)
        return operations.import(input)
      })
      const stored = imported?.resource
      if (!stored) for (const name of casChecks) skip(name, "导入未成功（见上）")
      else {
        check(casChecks[0]!, stored.storage === "cas", String(stored.storage), `期望 cas，实际 ${String(stored.storage)}`)
        check(casChecks[1]!, inside(stored.storedEntryPath, join(layout.cache, "cas")), short(stored.storedEntryPath), `期望 <cache>/cas/**，实际 ${stored.storedEntryPath ?? "(无)"}`)
        check(casChecks[2]!, isDir(layout.cache), short(layout.cache), `期望目录 ${layout.cache}`)
      }
    }
  } finally {
    if (keep) console.log(`[INFO] --keep：临时集成根保留在 ${workDirectory}`)
    else rmSync(workDirectory, { recursive: true, force: true })
  }
}

function summarize(): number {
  const counted = (status: Status) => results.filter(result => result.status === status).length
  const failures = counted("FAIL")
  console.log(`\n汇总：PASS=${counted("PASS")} FAIL=${failures} SKIP=${counted("SKIP")}`)
  return failures
}

/**
 * 泼溅件朝向与落地 + 生成入口路由：这几条是 2026-09-17 用户反馈修复后的不变量。
 * 其中"解码包围盒"是**行为检查**（真读内置 .spz 的点云块算 lift），不是 grep。
 */
export function assetGenerationSkillDeclaresAutomaticRouting(skill: string): boolean {
  const automatic = /不(?:问|让)用户挑供应商/.test(skill)
    || /\b(?:do not|don't|never) (?:ask (?:the )?users? to|let (?:the )?users?) (?:choose|pick|select) (?:an? |the )?(?:providers?|suppliers?)\b/i.test(skill)
  const extraUiConfirmation = /界面原生确认/.test(skill)
    || /\b(?:native (?:UI|interface) confirmation|(?:UI|interface) native confirmation|native confirmation (?:in|through) (?:the )?(?:UI|interface))\b/i.test(skill)
  return automatic && !extraUiConfirmation
}

async function runSplatAndRouterChecks(productRoot: string, fixtureWorld?: { path: string; expectedLocalMinZ: number }): Promise<void> {
  section("泼溅件朝向与落地（用户反馈：上下颠倒/沉到地下）")
  const formats = join(productRoot, "packages/scene-kit/src/formats.ts")
  const splatBranch = readText(formats)
  check("splat 分支声明 Y-up（与同帧 glTF/Marble 判据一致）", /kind: "splat"[\s\S]{0,600}?upAxis: "Y"/.test(splatBranch),
    /kind: "splat"[\s\S]{0,600}?upAxis: "Y"/.test(splatBranch) ? "formats.ts splat 分支 upAxis:\"Y\"" : "未在 splat 分支找到 upAxis:\"Y\"")
  check("splat 分支解码自身包围盒", /splatBounds\(/.test(splatBranch), /splatBounds\(/.test(splatBranch) ? "formats.ts 调用 splatBounds" : "未调用 splatBounds")
  const boundsModule = join(productRoot, "packages/scene-kit/src/splat-bounds.ts")
  check("splat-bounds 模块存在且导出 splatBounds", /export async function splatBounds/.test(readText(boundsModule)), boundsModule)
  const operations = readText(join(productRoot, "packages/scene-kit/src/operations.ts"))
  check("落地对齐不再只认 mesh", /const bounds=resource\.physicalization\?\.collisionBounds\?\?assetBounds\(resource\.parsed,resource\.ref\.source,resource\.parsed\.kind==="splat"\?effectiveSplatSourceTransform\(resource\):undefined\)/.test(operations),
    /kind==="mesh"\?assetBounds/.test(operations) ? "仍限定 kind===\"mesh\"" : "collisionBounds ?? assetBounds(...)" )

  // 行为检查：真解码内置街道件，断言换算到实体本地后的底面与抬升量。
  const fixture = fixtureWorld?.path ?? join(productRoot, "materials/worlds/background/clean-outdoor-street-sweeper-test.spz")
  if (!isFile(fixture)) {
    skip("内置街道件解码包围盒", `${fixture} 不存在`)
  } else {
    try {
      const { parseAsset, assetBounds } = await import("../packages/scene-kit/src/formats.ts")
      const parsed = await parseAsset(fixture)
      const local = assetBounds(parsed, parsed.source)
      const minZ = local ? Number(local.min[2].toFixed(3)) : NaN
      const lift = local ? Number((-local.min[2]).toFixed(3)) : NaN
      if (fixtureWorld) {
        const expected = fixtureWorld.expectedLocalMinZ
        check("CI 道路高斯原件解出包围盒及Y到Z抬升", Math.abs(minZ - expected) < 0.05 && Math.abs(lift + expected) < 0.05,
          `CI 道路几何原坐标Y.min=${expected}；实际SPZ读回localZ.min=${minZ}、lift=${lift}，非手工街道原件`)
      } else check("内置街道件解出包围盒且底面/抬升符合实测", Math.abs(minZ + 33.776) < 0.05 && Math.abs(lift - 33.776) < 0.05,
        `localZ.min=${minZ}（期望 ≈ −33.776）、lift=${lift}（期望 ≈ 33.776）`)
    } catch (error) {
      fail("内置街道件解码包围盒", message(error))
    }
  }

  section("生成入口路由（过期来源选择已下线）")
  const workbench = readText(join(productRoot, "packages/lyapunov-shell/src/workbench.tsx"))
  check("环境面板不再有供应商选择/生成提示词", !/Hunyuan|Marble|Tripo|生成提示词/.test(workbench),
    /Hunyuan|Marble|Tripo|生成提示词/.test(workbench) ? "workbench.tsx 仍含供应商/提示词字样" : "workbench.tsx 无供应商与提示词 UI")
  const shellPlugin = readText(join(productRoot, "packages/lyapunov-shell/src/plugin.ts"))
  check("域指针把生成命中路由到 asset-generation", /skill:"asset-generation"[\s\S]{0,400}?pattern:\/[^/]*生成/.test(shellPlugin),
    /skill:"asset-generation"[\s\S]{0,400}?pattern:\/[^/]*生成/.test(shellPlugin) ? "域指针 pattern 覆盖「生成」" : "未在 asset-generation 指针里找到「生成」触发词")
  const skill = readText(join(productRoot, "packages/lyapunov-shell/skills/asset-generation/SKILL.md"))
  check("技能改为自己选路、不问用户挑供应商", assetGenerationSkillDeclaresAutomaticRouting(skill),
    assetGenerationSkillDeclaresAutomaticRouting(skill) ? "SKILL.md 已写明自动选路" : "SKILL.md 未写明自动选路")
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (!isDir(options.productRoot)) throw new Error(`产品根不是目录：${options.productRoot}`)
  const fixture = options.ci ? await createCiLayoutFixture(options.productRoot) : undefined
  try {
    const { runRoot, how } = fixture
      ? { runRoot: fixture.paths.root, how: "--ci：原生操作建立的临时布局夹具；非已有用户运行状态" }
      : resolveRunRoot(options.rootParent)
    console.log("存储分治验收（worlds/assets/robots/cache/catalog）")
    console.log(`产品根：${options.productRoot}`)
    if (fixture) console.log(`CI 材料根：${fixture.productRoot}（scope=ci-fixture；源码和构建检查仍取产品根）`)
    console.log(`运行根：${runRoot}（${how}）`)
    console.log("说明：这不是产品运行路径，只是验收；静态检查只读，集成检查在临时根建库后删除。")
    runStaticChecks(options.productRoot, runRoot, fixture?.productRoot, options.ci)
    await runSplatAndRouterChecks(options.productRoot, fixture?.splatCheck)
    await runIntegrationChecks(fixture?.productRoot ?? options.productRoot, options.keep, fixture?.sources)
    const skipped = results.filter(result => result.status === "SKIP")
    if (options.ci && skipped.length) fail("CI 检查必须全部执行", `${skipped.length} 项未执行：${skipped.map(result => result.name).join("、")}`)
  } finally {
    if (fixture) {
      if (options.keep) console.log(`[INFO] --keep 保留 CI 布局夹具：${fixture.directory}`)
      else rmSync(fixture.directory, { recursive: true, force: true })
    }
  }
}

if (import.meta.main) {
  try {
    await main()
    process.exitCode = summarize() > 0 ? 1 : 0
  } catch (error) {
    fail("验收脚本自身异常", message(error))
    process.exitCode = summarize() > 0 ? 1 : 0
  }
}
