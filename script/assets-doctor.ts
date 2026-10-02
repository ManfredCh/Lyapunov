/** 运行根磁盘占用体检：只读统计各缓存目录并给出清理建议，不删除任何文件。 */
import { lstat, readdir, readlink } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { PRODUCT_ROOT } from './profile.ts'

const { values } = parseArgs({ options: { root: { type: 'string' }, keep: { type: 'string', default: '3' } } })
const root = resolve(values.root ?? join(PRODUCT_ROOT, '.runtime'))
const keep = Number(values.keep)
if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep 必须是正整数')

const CACHE_ADVICE: Record<string, string> = {
  'derived-assets': '派生缓存，可整目录删除，下次运行自动重建',
  'bench-runs': `benchmark 输出，建议保留最近 ${keep} 个 world/run，其余可删`,
  'recordings': '录制数据；确认已导出或不再需要回放后可整目录删除',
  'captures': '采集回执与截图，随录制一起评估，可删',
  'provider-jobs': '生成/分割任务缓存，已完成的任务目录可删',
}
const ROOT_ADVICE: Record<string, string> = {
  'hosts': '实验 Host 运行根；不再使用的 <id> 可整目录删除',
  'product-benchmark': '基准 Host 运行根；含 bench-runs/derived-assets，见下方分项',
  'desktop': '桌面端数据（缓存为主），删除后重启桌面端重建',
  'bench': 'benchmark 隔离环境；内部软链指向 DSH 侧目标，只删链接不删目标',
  'sim-python': 'Python 环境链接，目标不在本运行根',
  'product': '默认 Host 运行根；删除即清空该账号场景/资源库，谨慎',
}

interface Row { path: string; bytes?: number; note?: string; breakdown?: boolean }

/** du 语义：符号链接只算链接本身（0），硬链按 inode 去重，块大小优先。 */
async function usage(path: string, seen: Set<string>): Promise<number> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) return 0
  if (!info.isDirectory()) {
    if (info.nlink > 1) {
      const key = `${info.dev}:${info.ino}`
      if (seen.has(key)) return 0
      seen.add(key)
    }
    return info.blocks ? info.blocks * 512 : info.size
  }
  let total = 0
  for (const entry of await readdir(path)) total += await usage(join(path, entry), seen)
  return total
}

async function findNamed(path: string, names: ReadonlySet<string>, depth: number, found: string[]): Promise<void> {
  if (depth < 0) return
  const info = await lstat(path).catch(() => undefined)
  if (!info?.isDirectory() || info.isSymbolicLink()) return
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue
    const full = join(path, entry.name)
    if (names.has(entry.name)) found.push(full)
    await findNamed(full, names, depth - 1, found)
  }
}

function human(bytes: number): string {
  const units = ['B', 'K', 'M', 'G', 'T']
  let value = bytes, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return (unit === 0 ? String(bytes) : value.toFixed(1)) + units[unit]
}

const topInfo = await lstat(root).catch(() => undefined)
if (!topInfo?.isDirectory()) {
  console.log(`运行根不存在：${root}`)
  process.exit(0)
}

const rows: Row[] = []
const topEntries = await readdir(root, { withFileTypes: true })
for (const entry of topEntries.sort((a, b) => a.name.localeCompare(b.name))) {
  const full = join(root, entry.name)
  if (entry.isSymbolicLink()) {
    rows.push({ path: entry.name, note: `链接 -> ${await readlink(full)}（目标不计入本运行根）` })
    continue
  }
  if (!entry.isDirectory()) { rows.push({ path: entry.name, bytes: await usage(full, new Set()) }); continue }
  if (entry.name === 'hosts') {
    for (const host of await readdir(full, { withFileTypes: true })) {
      const hostPath = join(full, host.name)
      if (host.isSymbolicLink()) rows.push({ path: `hosts/${host.name}`, note: `链接 -> ${await readlink(hostPath)}（目标不计入本运行根）` })
      else if (host.isDirectory()) rows.push({ path: `hosts/${host.name}`, bytes: await usage(hostPath, new Set()), note: ROOT_ADVICE['hosts'] })
    }
    continue
  }
  rows.push({ path: entry.name, bytes: await usage(full, new Set()), note: ROOT_ADVICE[entry.name] })
  // 顶层目录内的直接软链单独标注，目标不重复计入（如 bench/libero-* -> DSH/.runtime/...）。
  for (const child of await readdir(full, { withFileTypes: true })) {
    if (child.isSymbolicLink()) rows.push({ path: `${entry.name}/${child.name}`, note: `链接 -> ${await readlink(join(full, child.name))}（目标不计入本运行根）` })
  }
}

const named: string[] = []
await findNamed(root, new Set(Object.keys(CACHE_ADVICE)), 5, named)
const seen = new Set<string>()
for (const full of named.sort()) {
  const rel = relative(root, full)
  if (seen.has(rel)) continue
  seen.add(rel)
  rows.push({ path: rel, bytes: await usage(full, new Set()), note: CACHE_ADVICE[relative(root, full).split('/').at(-1)!], breakdown: true })
}

const sizeWidth = Math.max(4, ...rows.map(row => (row.bytes === undefined ? '' : human(row.bytes)).length))
let total = 0
console.log(`运行根：${root}`)
for (const row of rows) {
  const size = row.bytes === undefined ? '' : human(row.bytes)
  if (row.bytes !== undefined && !row.breakdown) total += row.bytes
  console.log(`${size.padStart(sizeWidth)}  ${row.path}${row.note ? `  # ${row.note}` : ''}`)
}
console.log(`${human(total).padStart(sizeWidth)}  总计（细分项不重复计入；链接目标未计入）`)
console.log('\n清理建议（只提示，不执行删除）：')
for (const [name, advice] of Object.entries(CACHE_ADVICE)) console.log(`  ${name}: ${advice}`)
for (const [name, advice] of Object.entries(ROOT_ADVICE)) console.log(`  ${name}: ${advice}`)
console.log('  assets/cas: 资源库内容寻址存储，被 asset_list 记录引用；不要手工删除，移除资源请用 asset_trash')
