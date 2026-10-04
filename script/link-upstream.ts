import { readdir, readFile, mkdir, symlink, readlink, rename, rm, lstat, realpath, unlink } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve, relative, dirname, isAbsolute, basename, sep } from "node:path"
import { randomUUID } from "node:crypto"

type Manifest = {
  name?: string
  version?: string
  private?: boolean
  workspaces?: string[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}
type PackageTarget = { name: string; directory: string; version?: string }
type Owner = { directory: string; manifest: Manifest }
type LinkChange = { destination: string; target?: string; previous?: string; kind: "create" | "replace" | "prune" }
const dependencySections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const
const scopes = ["@deepseek-ai", "@lyapunov"] as const

function contains(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === "" || path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path)
}
async function manifest(directory: string): Promise<Manifest | undefined> {
  try { return JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as Manifest }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error }
}
async function localDirectory(directory: string): Promise<void> {
  try {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`UPSTREAM_LINK_CONFLICT: 保留自定义父路径 ${directory}`)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
}

/** 仅展开产品清单的实体 workspace，拒绝指向用户外部目录的 workspace。 */
async function workspaceOwners(root: string, config: Manifest): Promise<Owner[]> {
  const owners = new Map<string, Owner>()
  for (const pattern of config.workspaces ?? []) {
    if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) throw new Error(`UPSTREAM_LINK_CONFLICT: workspace 超出安装目录 ${pattern}`)
    const directory = resolve(root, pattern.endsWith("/*") ? pattern.slice(0, -2) : pattern)
    if (/[*?\[\]]/.test(relative(root, directory))) throw new Error(`UPSTREAM_LINK_CONFLICT: 不支持的 workspace 模式 ${pattern}`)
    if (!existsSync(directory)) continue
    await localDirectory(directory)
    const candidates = pattern.endsWith("/*")
      ? (await readdir(directory, { withFileTypes: true })).filter(item => item.isDirectory() || item.isSymbolicLink()).map(item => join(directory, item.name))
      : [directory]
    for (const candidate of candidates) {
      await localDirectory(candidate)
      const pkg = await manifest(candidate)
      if (pkg) owners.set(candidate, { directory: candidate, manifest: pkg })
    }
  }
  return [...owners.values()]
}

/** 原生 Bun lock 中已登记的 registry 包，结合本安装 .bun 路径核实替换归属。 */
async function registeredBunPackages(root: string): Promise<Set<string>> {
  if (!existsSync(join(root, "bun.lock"))) return new Set()
  const lock = Bun.JSONC.parse(await readFile(join(root, "bun.lock"), "utf8")) as { packages?: Record<string, unknown> }
  return new Set(Object.values(lock.packages ?? {}).flatMap(entry =>
    Array.isArray(entry) && typeof entry[0] === "string" ? [entry[0]] : []))
}

async function ownedPrevious(root: string, name: string, previous: string, registered: Set<string>): Promise<boolean> {
  const pkg = await manifest(previous)
  if (contains(join(root, ".upstream"), previous)) {
    if (pkg === undefined && !existsSync(previous)) return true
    return pkg?.name === name && contains(join(root, ".upstream"), await realpath(previous))
  }
  if (pkg?.name !== name) return false
  const physical = await realpath(previous)
  if (contains(join(root, "node_modules", ".bun"), previous)
    && contains(join(root, "node_modules", ".bun"), physical)
    && previous.endsWith(join("node_modules", name))
    && typeof pkg.version === "string" && registered.has(`${name}@${pkg.version}`)) return true
  if (name.startsWith("@lyapunov/") && basename(dirname(previous)) === "packages") {
    const installation = resolve(previous, "../..")
    const product = await manifest(installation)
    if (!["lyapunov", "lyapunov-dsh"].includes(product?.name ?? "") || product?.private !== true) return false
    try {
      const lock = JSON.parse(await readFile(join(installation, "UPSTREAM_LOCK.json"), "utf8")) as { commit?: string }
      return typeof lock.commit === "string" && lock.commit.length > 0
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error }
  }
  return false
}

/**
 * 将固定上游与当前产品 workspace 链接为唯一运行实例。
 * 已声明或已存在的本地 aliases 都接受同一归属检查；未知外部链接不接管。
 */
export async function linkUpstream(root = resolve(import.meta.dirname, ".."), options: { replaceOwned?: boolean } = {}) {
  root = await realpath(root)
  const lock = JSON.parse(await readFile(join(root, "UPSTREAM_LOCK.json"), "utf8")) as { directory: string }
  const upstream = resolve(root, lock.directory)
  const config = await manifest(root) ?? {}
  const workspaces = await workspaceOwners(root, config)
  const targets = new Map<string, PackageTarget>()
  const groups = [join(upstream, "vendor"), join(upstream, "apps")]
  const nativePackages = join(upstream, "native/system/packages")
  if (existsSync(nativePackages)) groups.push(nativePackages)
  for (const item of await readdir(join(upstream, "packages"), { withFileTypes: true })) {
    if (item.isDirectory()) groups.push(join(upstream, "packages", item.name))
  }
  for (const group of groups) for (const item of await readdir(group, { withFileTypes: true })) {
    if (!item.isDirectory()) continue
    const directory = join(group, item.name), pkg = await manifest(directory)
    if (!pkg?.name?.startsWith("@deepseek-ai/")) continue
    if (!/^@deepseek-ai\/[a-z0-9][a-z0-9._-]*$/.test(pkg.name)) throw new Error(`UPSTREAM_PACKAGE_MISSING: SDK 包名不合法 ${pkg.name}`)
    if (targets.has(pkg.name)) throw new Error(`UPSTREAM_PACKAGE_MISSING: SDK 包名重复 ${pkg.name}`)
    targets.set(pkg.name, { name: pkg.name, directory, ...pkg.version === undefined ? {} : { version: pkg.version } })
  }
  for (const workspace of workspaces) if (workspace.manifest.name?.startsWith("@lyapunov/")) {
    const name = workspace.manifest.name
    if (!/^@lyapunov\/[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`UPSTREAM_PACKAGE_MISSING: 产品包名不合法 ${name}`)
    if (targets.has(name)) throw new Error(`UPSTREAM_PACKAGE_MISSING: 产品包名重复 ${name}`)
    targets.set(name, { name, directory: workspace.directory })
  }
  const registered = await registeredBunPackages(root)
  const changes: LinkChange[] = []
  // 所有名称、父目录和归属先检查完，再创建或替换任何链接。
  for (const owner of [{ directory: root, manifest: config }, ...workspaces]) {
    const names = new Set(owner.directory === root ? targets.keys() : [])
    for (const section of dependencySections) for (const [name, version] of Object.entries(owner.manifest[section] ?? {})) {
      if (!scopes.some(scope => name.startsWith(scope + "/"))) continue
      const target = targets.get(name)
      if (!target) throw new Error(`UPSTREAM_PACKAGE_MISSING: ${owner.directory} 声明的包不存在于当前安装 ${name}`)
      if (name.startsWith("@deepseek-ai/") && target.version !== undefined && version !== target.version) {
        throw new Error(`UPSTREAM_PACKAGE_MISSING: ${owner.directory} 的 ${name} 声明 ${version}，固定 SDK 实际为 ${target.version}`)
      }
      names.add(name)
    }
    await localDirectory(join(owner.directory, "node_modules"))
    for (const scope of scopes) {
      const directory = join(owner.directory, "node_modules", scope)
      await localDirectory(directory)
      if (!existsSync(directory)) continue
      for (const entry of await readdir(directory)) {
        const name = scope + "/" + entry, destination = join(directory, entry)
        if (targets.has(name)) { names.add(name); continue }
        const info = await lstat(destination)
        const previous = info.isSymbolicLink() ? await readlink(destination) : undefined
        if (scope === "@deepseek-ai" && previous !== undefined && !existsSync(destination)
          && contains(upstream, resolve(dirname(destination), previous))) {
          changes.push({ kind: "prune", destination, previous })
          continue
        }
        throw new Error(`UPSTREAM_LINK_CONFLICT: 保留当前安装无目标的外部 alias ${destination}`)
      }
    }
    for (const name of names) {
      const target = targets.get(name)!, destination = join(owner.directory, "node_modules", name)
      let info
      try { info = await lstat(destination) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        changes.push({ kind: "create", destination, target: target.directory }); continue
      }
      if (!info.isSymbolicLink()) throw new Error(`UPSTREAM_LINK_CONFLICT: 保留非链接目录 ${destination}`)
      const previous = await readlink(destination), previousDirectory = resolve(dirname(destination), previous)
      if (previousDirectory === target.directory) continue
      if (existsSync(destination) && await realpath(destination) === await realpath(target.directory)) continue
      if (!options.replaceOwned) throw new Error(`UPSTREAM_LINK_CONFLICT: ${name} 已有不同安装；关闭活动 Host 后通过 bootstrap 更新链接`)
      if (!await ownedPrevious(root, name, previousDirectory, registered)) {
        throw new Error(`UPSTREAM_LINK_CONFLICT: 保留非本安装包管理的链接 ${destination}（原链接：${previous}）`)
      }
      changes.push({ kind: "replace", destination, target: target.directory, previous })
    }
  }
  let count = 0, updated = 0, pruned = 0
  for (const change of changes) {
    const modules = dirname(dirname(change.destination))
    await mkdir(modules, { recursive: true }); await localDirectory(modules)
    await mkdir(dirname(change.destination), { recursive: true }); await localDirectory(dirname(change.destination))
    if (change.kind === "create") {
      await symlink(change.target!, change.destination, "dir"); count++; continue
    }
    if (await readlink(change.destination) !== change.previous) throw new Error(`UPSTREAM_LINK_CONFLICT: 链接在更新期间改变 ${change.destination}`)
    if (change.kind === "prune") {
      if (existsSync(change.destination)) throw new Error(`UPSTREAM_LINK_CONFLICT: 悬空链接在更新期间恢复 ${change.destination}`)
      await unlink(change.destination); pruned++; continue
    }
    const temporary = change.destination + ".upstream-next-" + randomUUID()
    try {
      await symlink(change.target!, temporary, "dir")
      if (await readlink(change.destination) !== change.previous) throw new Error(`UPSTREAM_LINK_CONFLICT: 链接在更新期间改变 ${change.destination}`)
      await rename(temporary, change.destination)
    }
    finally { await rm(temporary, { force: true }) }
    updated++
  }
  return { upstream, linked: count, updated, pruned }
}
if (import.meta.main) console.log(await linkUpstream(undefined, { replaceOwned: process.argv.includes("--replace-owned") }))
