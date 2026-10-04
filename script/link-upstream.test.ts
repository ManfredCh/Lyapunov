import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { spawnSync } from "node:child_process"
import { linkUpstream } from "./link-upstream.ts"

const temporaryRoots: string[] = []
afterEach(async () => { for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function json(path: string, value: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value) + "\n")
}
async function pkg(directory: string, name: string, version: string, extra: object = {}): Promise<void> {
  await json(join(directory, "package.json"), { name, version, private: true, type: "module", exports: { ".": "./index.ts" }, ...extra })
  await writeFile(join(directory, "index.ts"), "export const identity = {}; export class Context {}\n")
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lyapunov-sdk-link-")); temporaryRoots.push(root)
  const sdk = join(root, ".upstream", "sdk"), consumer = join(root, "packages", "consumer"), viewer = join(root, "packages", "viewer")
  await json(join(root, "UPSTREAM_LOCK.json"), { directory: ".upstream/sdk", commit: "fixture" })
  await json(join(root, "package.json"), { name: "lyapunov", private: true, workspaces: ["packages/*"] })
  await mkdir(join(sdk, "apps"), { recursive: true })
  await pkg(join(sdk, "vendor", "cordis"), "@deepseek-ai/cordis", "4.0.4")
  await pkg(join(sdk, "packages", "core", "tools"), "@deepseek-ai/dsh-tools", "0.2.0-rc.2")
  await pkg(consumer, "@lyapunov/consumer", "0.1.0", {
    dependencies: { "@lyapunov/viewer": "workspace:*" },
    peerDependencies: { "@deepseek-ai/cordis": "4.0.4", "@deepseek-ai/dsh-tools": "0.2.0-rc.2" },
    peerDependenciesMeta: { "@deepseek-ai/cordis": { optional: true }, "@deepseek-ai/dsh-tools": { optional: true } },
  })
  await pkg(viewer, "@lyapunov/viewer", "0.1.0")
  return { root, sdk, consumer, viewer }
}
async function alias(owner: string, name: string, target: string): Promise<string> {
  const link = join(owner, "node_modules", name); await mkdir(dirname(link), { recursive: true }); await symlink(target, link, "dir"); return link
}
function probe(root: string, consumer: string) {
  return spawnSync(process.execPath, ["--no-env-file", "-e", `
    import {realpathSync} from "node:fs";
    const owners = ${JSON.stringify([root, consumer])};
    const paths = owners.map(owner => realpathSync(Bun.resolveSync("@deepseek-ai/cordis", owner)));
    const values = await Promise.all(paths.map(path => import(path)));
    console.log(JSON.stringify({ paths, same: values[0].identity === values[1].identity,
      viewer: realpathSync(Bun.resolveSync("@lyapunov/viewer", ${JSON.stringify(consumer)})) }));
  `], { cwd: root, encoding: "utf8", timeout: 15_000 })
}

test("root与每个workspace使用同一固定SDK及本安装产品包，重复链接不改动", async () => {
  const { root, sdk, consumer, viewer } = await fixture()
  await linkUpstream(root)
  expect(await realpath(join(consumer, "node_modules/@deepseek-ai/cordis"))).toBe(join(sdk, "vendor/cordis"))
  expect(await realpath(join(consumer, "node_modules/@deepseek-ai/dsh-tools"))).toBe(join(sdk, "packages/core/tools"))
  const result = probe(root, consumer)
  expect(result.status).toBe(0)
  const observed = JSON.parse(result.stdout)
  expect(observed.same).toBe(true)
  expect(observed.paths).toEqual([join(sdk, "vendor/cordis/index.ts"), join(sdk, "vendor/cordis/index.ts")])
  expect(observed.viewer).toBe(join(viewer, "index.ts"))
  expect(await linkUpstream(root)).toMatchObject({ linked: 0, updated: 0, pruned: 0 })
})

test("核Bun登记name/version与本安装cache归属后只改peer alias，不删除cache", async () => {
  const { root, sdk, consumer } = await fixture()
  const cache = join(root, "node_modules/.bun/@deepseek-ai+cordis@4.0.2/node_modules/@deepseek-ai/cordis")
  await pkg(cache, "@deepseek-ai/cordis", "4.0.2")
  await json(join(root, "bun.lock"), { packages: { "@deepseek-ai/cordis": ["@deepseek-ai/cordis@4.0.2"] } })
  const link = await alias(consumer, "@deepseek-ai/cordis", cache)
  await expect(linkUpstream(root)).rejects.toThrow("UPSTREAM_LINK_CONFLICT")
  expect(await readlink(link)).toBe(cache)
  expect(await linkUpstream(root, { replaceOwned: true })).toMatchObject({ updated: 1 })
  expect(await realpath(link)).toBe(join(sdk, "vendor/cordis"))
  expect(await readFile(join(cache, "package.json"), "utf8")).toContain('"version":"4.0.2"')
})

test("Bun cache未登记或包名不同即拒绝，所有原alias保持且没有半创建root链接", async () => {
  for (const foreignName of ["@deepseek-ai/cordis", "@deepseek-ai/foreign"]) {
    const { root, consumer } = await fixture()
    const cache = join(root, "node_modules/.bun/@deepseek-ai+cordis@4.0.2/node_modules/@deepseek-ai/cordis")
    await pkg(cache, foreignName, "4.0.2")
    await json(join(root, "bun.lock"), { packages: foreignName === "@deepseek-ai/cordis" ? {} : { installed: ["@deepseek-ai/cordis@4.0.2"] } })
    const link = await alias(consumer, "@deepseek-ai/cordis", cache)
    await expect(linkUpstream(root, { replaceOwned: true })).rejects.toThrow("保留非本安装包管理")
    expect(await readlink(link)).toBe(cache)
    expect(existsSync(join(root, "node_modules/@deepseek-ai/cordis"))).toBe(false)
  }
})

test("同名外部包及用户自定义node_modules父链接均拒绝且不写外部目录", async () => {
  const { root, consumer } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), "lyapunov-user-dependency-")); temporaryRoots.push(outside)
  await pkg(join(outside, "cordis"), "@deepseek-ai/cordis", "4.0.4")
  const link = await alias(consumer, "@deepseek-ai/cordis", join(outside, "cordis"))
  await expect(linkUpstream(root, { replaceOwned: true })).rejects.toThrow("保留非本安装包管理")
  expect(await readlink(link)).toBe(join(outside, "cordis"))
  await rm(join(consumer, "node_modules"), { recursive: true })
  await symlink(outside, join(consumer, "node_modules"), "dir")
  await expect(linkUpstream(root, { replaceOwned: true })).rejects.toThrow("保留自定义父路径")
  expect(existsSync(join(outside, "@deepseek-ai"))).toBe(false)
})

test("经.upstream中用户自定义软链指向外部同名包仍拒绝接管", async () => {
  const { root, consumer } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), "lyapunov-user-sdk-")); temporaryRoots.push(outside)
  await pkg(outside, "@deepseek-ai/cordis", "4.0.4")
  const indirect = join(root, ".upstream/user-custom"); await symlink(outside, indirect, "dir")
  const link = await alias(consumer, "@deepseek-ai/cordis", indirect)
  await expect(linkUpstream(root, { replaceOwned: true })).rejects.toThrow("保留非本安装包管理")
  expect(await readlink(link)).toBe(indirect)
  expect(await readlink(indirect)).toBe(outside)
  expect(existsSync(join(root, "node_modules/@deepseek-ai/cordis"))).toBe(false)
})

test("当前source的产品alias只替换可核实旧产品安装，未知同名目录拒绝", async () => {
  const { root, consumer, viewer } = await fixture()
  const old = join(root, "old-installation")
  await json(join(old, "package.json"), { name: "lyapunov", private: true })
  await json(join(old, "UPSTREAM_LOCK.json"), { commit: "old-verified" })
  await pkg(join(old, "packages/viewer"), "@lyapunov/viewer", "0.1.0")
  const link = await alias(consumer, "@lyapunov/viewer", join(old, "packages/viewer"))
  await linkUpstream(root, { replaceOwned: true })
  expect(await realpath(link)).toBe(viewer)
  expect(existsSync(join(old, "packages/viewer/index.ts"))).toBe(true)
  await rm(link)
  const external = join(root, "custom/viewer"); await pkg(external, "@lyapunov/viewer", "0.1.0")
  await symlink(external, link, "dir")
  await expect(linkUpstream(root, { replaceOwned: true })).rejects.toThrow("保留非本安装包管理")
  expect(await readlink(link)).toBe(external)
})

test("声明缺失SDK包会阻断，旧dangling SDK链接只按当前上游范围清理", async () => {
  const { root, sdk, consumer } = await fixture()
  const file = join(consumer, "package.json"), config = JSON.parse(await readFile(file, "utf8"))
  config.peerDependencies["@deepseek-ai/dsh-missing"] = "0.2.0-rc.2"; await json(file, config)
  await expect(linkUpstream(root, { replaceOwned: true })).rejects.toThrow("UPSTREAM_PACKAGE_MISSING")
  expect(existsSync(join(root, "node_modules/@deepseek-ai/cordis"))).toBe(false)
  delete config.peerDependencies["@deepseek-ai/dsh-missing"]; await json(file, config)
  const removed = await alias(root, "@deepseek-ai/dsh-retired", join(sdk, "packages/retired/gone"))
  expect(await linkUpstream(root)).toMatchObject({ pruned: 1 })
  await expect(readlink(removed)).rejects.toMatchObject({ code: "ENOENT" })
})

test("真实Bun冷安装与frozen复装后使用正式link脚本闭合workspace解析", async () => {
  const { root, sdk, consumer } = await fixture()
  for (const args of [["install", "--ignore-scripts"], ["install", "--frozen-lockfile", "--ignore-scripts"]]) {
    const result = spawnSync(process.execPath, ["--no-env-file", ...args], { cwd: root, encoding: "utf8", timeout: 30_000 })
    expect(result.status).toBe(0)
    await linkUpstream(root, { replaceOwned: true })
    const observed = probe(root, consumer)
    expect(observed.status).toBe(0)
    expect(JSON.parse(observed.stdout)).toMatchObject({ same: true, paths: [join(sdk, "vendor/cordis/index.ts"), join(sdk, "vendor/cordis/index.ts")] })
  }
})
