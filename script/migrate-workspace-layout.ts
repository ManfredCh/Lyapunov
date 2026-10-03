/**
 * 运行根存储分治迁移：把旧单根 `scene/{scenes,assets,resources}` 搬进
 * worlds（场景/环境）、cache（派生/CAS/下载）、catalog（唯一目录索引）。
 *
 * 规则：
 * - 幂等：目标已存在且同名文件也在时跳过并登记冲突，不覆盖任何一边。
 * - 不改写 source 之外的字节：只搬移 + 改写 JSON 里指向旧路径的绝对字符串引用。
 * - 不删除用户内容：迁移后 `scene/` 如有残留就原样保留并报告。
 * - 仅在停止写入的运行根执行：此函数不是并发事务，不提供跨进程写入锁。
 * 用法：node script/migrate-workspace-layout.ts [--root <运行根>] [--dry-run]
 */
import { lstat, mkdir, readdir, readFile, rename, rmdir, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { parseArgs } from "node:util"
import { fileURLToPath, pathToFileURL } from "node:url"
import { runtimePaths, RUNTIME_ENV, readRuntimeEnv, type RuntimePaths } from "../packages/lyapunov-product-bundle/src/runtime-paths.ts"

type Move = { from: string; to: string }
type Report = { root: string; moved: string[]; merged: string[]; conflicts: string[]; rewrote: string[]; leftovers: string[]; skipped: string[] }

async function pathInfo(path: string) {
  try { return await lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error // 无法读取不等于不存在，不能因此覆盖目标。
  }
}

/** 在任何写入前拒绝运行根内的符号链接祖先；叶子链接只可原样移动，不追踪目标。 */
async function checkDirectories(root: string, directories: string[], report: Report): Promise<boolean> {
  const checked = new Set<string>()
  for (const directory of directories) {
    const rel = relative(root, directory)
    if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== resolve(directory)) {
      report.conflicts.push(`${directory}（目录越过运行根，未迁移）`)
      return false
    }
    let current = resolve(root)
    for (const part of ["", ...rel.split(sep).filter(Boolean)]) {
      if (part) current = join(current, part)
      if (checked.has(current)) continue
      checked.add(current)
      const info = await pathInfo(current)
      if (info && !info.isDirectory()) {
        report.conflicts.push(`${current}（目录为符号链接或非目录，未迁移）`)
        report.leftovers.push(current)
        return false
      }
    }
  }
  return true
}

/** 旧绝对路径 → 新绝对路径的字符串替换对（长的先替换，避免前缀互相吃掉）。 */
function rewriters(paths: RuntimePaths): [string, string][] {
  const legacy = paths.sceneRoot
  const pairs: [string, string][] = [
    [`${legacy}/assets/derived`, `${paths.cacheRoot}/derived`],
    [`${legacy}/assets/cas`, `${paths.cacheRoot}/cas`],
    [`${legacy}/assets/environments`, `${paths.worldsRoot}/environments`],
    [`${legacy}/resources/network`, `${paths.cacheRoot}/download`],
    ...["index.json", "missing.json", "operations.json", "tombstones"].map(name => [join(legacy, "resources", name), join(paths.catalogRoot, name)] as [string, string]),
    [`${legacy}/scenes`, join(paths.worldsRoot, "scenes")],
    [`${legacy}/provider-jobs`, join(paths.cacheRoot, "provider-jobs")],
    [`${legacy}/share-previews`, join(paths.cacheRoot, "share-previews")],
    [`${legacy}/recordings`, join(paths.cacheRoot, "..", "recordings")],
  ]
  return pairs.sort((a, b) => b[0].length - a[0].length)
}

async function mergeDirectory(from: string, to: string, report: Report, conflicts: Move[]): Promise<void> {
  const entries = await readdir(from, { withFileTypes: true })
  await mkdir(to, { recursive: true })
  for (const entry of entries) {
    const source = join(from, entry.name), target = join(to, entry.name)
    const targetInfo = await pathInfo(target)
    if (targetInfo) {
      if (entry.isDirectory() && targetInfo.isDirectory()) {
        await mergeDirectory(source, target, report, conflicts)
        report.merged.push(`${source} → ${target}`)
        continue
      }
      report.conflicts.push(`${source}（目标已存在，未覆盖）`)
      conflicts.push({ from: source, to: target })
      continue
    }
    await rename(source, target)
    report.moved.push(`${source} → ${target}`)
  }
  if ((await readdir(from)).length === 0) await rmdir(from)
}

async function moveIfPresent(moves: Move[], report: Report, conflicts: Move[]): Promise<void> {
  for (const move of moves) {
    if (!(await pathInfo(move.from))) { report.skipped.push(`${move.from}（不存在）`); continue }
    await mkdir(dirname(move.to), { recursive: true })
    const targetInfo = await pathInfo(move.to)
    if (targetInfo) {
      const sourceInfo = await lstat(move.from)
      if (sourceInfo.isDirectory() && targetInfo.isDirectory()) {
        await mergeDirectory(move.from, move.to, report, conflicts)
        continue
      }
      report.conflicts.push(`${move.from}（目标已存在，未覆盖）`)
      conflicts.push(move)
      continue
    }
    await rename(move.from, move.to)
    report.moved.push(`${move.from} → ${move.to}`)
  }
}

const atOrInside = (path: string, root: string) => path === root || path.startsWith(root + sep)

/** 只改 JSON 字符串中的绝对路径；冲突源引用、冲突目标字节及符号链接保持原样。 */
async function rewriteJsonReferences(dir: string, pairs: [string, string][], report: Report, conflicts: Move[] = []): Promise<void> {
  if (conflicts.some(conflict => atOrInside(dir, conflict.to))) return
  const directoryInfo = await pathInfo(dir)
  if (!directoryInfo?.isDirectory()) return
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink() || conflicts.some(conflict => atOrInside(path, conflict.to))) continue
    if (entry.isDirectory()) { await rewriteJsonReferences(path, pairs, report, conflicts); continue }
    if (!entry.isFile() || !/\.(json|jsonl)$/.test(entry.name)) continue
    const text = await readFile(path, "utf8")
    const next = text.replace(/"(?:[^"\\]|\\.)*"/g, token => {
      let value: unknown
      try { value = JSON.parse(token) } catch { return token }
      if (typeof value !== "string") return token
      let path = value
      let fileUrl: URL | undefined
      if (/^file:/i.test(value)) {
        try { fileUrl = new URL(value); path = fileURLToPath(fileUrl) }
        catch { return token } // 无效或远程主机 URL 不猜测成运行根文件。
      }
      if (conflicts.some(conflict => atOrInside(path, conflict.from))) return token
      for (const [from, to] of pairs) {
        if (!atOrInside(path, from)) continue
        const nextPath = to + path.slice(from.length)
        if (!fileUrl) return JSON.stringify(nextPath)
        const nextUrl = pathToFileURL(nextPath)
        nextUrl.search = fileUrl.search
        nextUrl.hash = fileUrl.hash
        return JSON.stringify(nextUrl.href)
      }
      return token
    })
    if (next !== text) { await writeFile(path, next); report.rewrote.push(path) }
  }
}

/** 策展库（随包 L0）拆分后的路径改写对：机器人/小物件/世界分家。 */
export function curatedRewriters(productRoot: string): [string, string][] {
  const pairs: [string, string][] = [
    [`${productRoot}/materials/assets/resource-library/robot`, `${productRoot}/materials/robots`],
    [`${productRoot}/materials/assets/resource-library/background`, `${productRoot}/materials/worlds/background`],
    [`${productRoot}/materials/assets/resource-library/object`, `${productRoot}/materials/assets/objects`],
    [`${productRoot}/materials/assets/tearoom`, `${productRoot}/materials/worlds/tearoom`],
  ]
  return pairs.sort((a, b) => b[0].length - a[0].length)
}

export async function migrateRuntimeLayout(paths: RuntimePaths, options: { dryRun?: boolean; productRoot?: string } = {}): Promise<Report> {
  const report: Report = { root: paths.root, moved: [], merged: [], conflicts: [], rewrote: [], leftovers: [], skipped: [] }
  const legacy = paths.sceneRoot
  const curated = options.productRoot ? curatedRewriters(options.productRoot) : []
  if (!(await checkDirectories(paths.root, [legacy, join(legacy, "assets"), join(legacy, "resources"), paths.worldsRoot, paths.cacheRoot, paths.catalogRoot], report))) return report
  const conflicts: Move[] = []
  if (!(await pathInfo(legacy))) {
    // 旧运行根不存在也要跑一次策展库引用改写：随包资产搬过家之后，目录索引里存的绝对路径会失效。
    if (curated.length && !options.dryRun) {
      await rewriteJsonReferences(paths.catalogRoot, curated, report)
      await rewriteJsonReferences(join(paths.worldsRoot, "scenes"), curated, report)
    }
    report.skipped.push(`${legacy}（旧单根不存在，无需迁移）`)
    return report
  }
  const pairs = [...rewriters(paths), ...curated]
  if (options.dryRun) {
    for (const [from, to] of rewriters(paths)) if (await pathInfo(from)) report.moved.push(`${from} → ${to}（dry-run）`)
    return report
  }
  await moveIfPresent([
    { from: join(legacy, "scenes"), to: join(paths.worldsRoot, "scenes") },
    { from: join(legacy, "assets", "derived"), to: join(paths.cacheRoot, "derived") },
    { from: join(legacy, "assets", "cas"), to: join(paths.cacheRoot, "cas") },
    { from: join(legacy, "assets", "environments"), to: join(paths.worldsRoot, "environments") },
    { from: join(legacy, "resources", "network"), to: join(paths.cacheRoot, "download") },
    { from: join(legacy, "provider-jobs"), to: join(paths.cacheRoot, "provider-jobs") },
    { from: join(legacy, "share-previews"), to: join(paths.cacheRoot, "share-previews") },
    { from: join(legacy, "recordings"), to: join(paths.root, "recordings") },
  ], report, conflicts)
  // 目录索引三件套 + 墓碑搬到 catalog（唯一索引真值）。
  await moveIfPresent(["index.json", "missing.json", "operations.json", "tombstones"].map(name => ({
    from: join(legacy, "resources", name), to: join(paths.catalogRoot, name),
  })), report, conflicts)
  // 冲突源的引用仍指向保留的旧文件；绝不能误指向同名但内容不同的目标文件。
  await rewriteJsonReferences(paths.catalogRoot, pairs, report, conflicts)
  await rewriteJsonReferences(join(paths.worldsRoot, "scenes"), pairs, report, conflicts)
  // 旧根若有残留：先递归清掉空目录，剩下真实内容原样保留并报告（不删用户数据）。
  const pruneEmpty = async (dir: string): Promise<boolean> => {
    if (!(await pathInfo(dir))?.isDirectory()) return false
    let empty = true
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !(await pruneEmpty(join(dir, entry.name)))) empty = false
    }
    if (!empty) return false
    await rmdir(dir) // 非递归：并发出现新内容时失败，绝不删掉它。
    return true
  }
  await pruneEmpty(legacy)
  if ((await pathInfo(legacy))?.isDirectory()) report.leftovers.push(...(await readdir(legacy)).map(name => join(legacy, name)))
  return report
}

// 直接运行判定用 import.meta.main：`script/profile.ts` 以库方式导入本模块，`script/package-linux.ts`
// 会把管理员入口打成单文件 bundle。`import.meta.url === file://${process.argv[1]}` 在 bundle 内对每个来源
// 模块都成立，会把管理员 `--help` 落进这里的 parseArgs（ERR_PARSE_ARGS_UNKNOWN_OPTION）；而 import.meta.main
// 按模块求值，Bun.build 对非入口模块直接折叠掉本分支。
if (import.meta.main) {
  const { values } = parseArgs({ options: { root: { type: "string" }, mode: { type: "string", default: "developer" }, "dry-run": { type: "boolean" } } })
  const root = resolve(values.root ?? readRuntimeEnv(process.env, "productRoot") ?? join(import.meta.dirname, ".."))
  const paths = runtimePaths({ mode: values.mode === "formal" ? "formal" : "developer", root, accountId: values.mode === "formal" ? (process.env[RUNTIME_ENV.accountToken] ? "cli" : undefined) : undefined })
  const report = await migrateRuntimeLayout(paths, { dryRun: Boolean(values["dry-run"]) })
  let evidence: string | undefined
  const rootInfo = await pathInfo(paths.root)
  if (!rootInfo || rootInfo.isDirectory()) {
    evidence = join(paths.root, `migration-report-${new Date().toISOString().replaceAll(":", "-")}.json`)
    await mkdir(paths.root, { recursive: true })
    await writeFile(evidence, JSON.stringify(report, null, 2) + "\n")
  } else {
    report.skipped.push(`${paths.root}（运行根非真实目录，迁移报告仅输出到 stdout）`)
  }
  console.log(JSON.stringify({ ...report, evidence }, null, 2))
  if (report.conflicts.length) process.exitCode = 2
}
