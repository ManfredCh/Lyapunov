import { existsSync, mkdirSync, statSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PRODUCT_ROOT } from './profile.ts'

/** 当前包 src 内文件与目录的最新修改时间；目录时间包含新增和删除，不沿子目录符号链接递归。 */
function sourceTreeTime(directory: string): number {
  let latest = statSync(directory).mtimeMs
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry), info = lstatSync(path)
    latest = Math.max(latest, info.mtimeMs, info.isDirectory() ? sourceTreeTime(path) : 0)
  }
  return latest
}

/** Bun 源码启动按本包 src 变化更新产物；Node 发行启动只读取预编译文件。跨包依赖变化由显式构建处理。 */
export async function ensurePluginModule(packageName: string) {
  const dir = join(PRODUCT_ROOT, 'packages', packageName)
  const entry = join(dir, 'src/plugin.ts')
  const destDir = join(dir, 'dist')
  const dest = join(destDir, 'plugin.js')
  if (!process.versions.bun) {
    if (existsSync(dest)) return dest
    throw new Error('PLUGIN_MODULE_MISSING: Node 发行包缺少预编译插件 ' + dest)
  }
  if (!existsSync(entry)) throw new Error('PLUGIN_ENTRY_MISSING: ' + entry)
  const sourceTime = Math.max(statSync(entry).mtimeMs, sourceTreeTime(join(dir, 'src')))
  if (existsSync(dest) && statSync(dest).mtimeMs >= sourceTime) return dest
  mkdirSync(destDir, { recursive: true })
  const build = await Bun.build({
    entrypoints: [entry],
    outdir: destDir,
    target: 'node',
    format: 'esm',
    external: ['@deepseek-ai/*', 'three', 'fast-xml-parser'],
    minify: false,
  })
  if (!build.success) throw new AggregateError(build.logs, '插件构建失败：' + packageName)
  if (!existsSync(dest)) throw new Error('PLUGIN_MODULE_MISSING: ' + dest)
  return dest
}

export function pluginModulePath(packageName: string) {
  return join(PRODUCT_ROOT, 'packages', packageName, 'dist/plugin.js')
}
