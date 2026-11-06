/**
 * 共享夹具：把「OSTN15 格网缺失」做成**真实**环境，而不是跳测。
 *
 * 背景：`EPSG:27700 → EPSG:4326` 的判据假定 `uk_os_OSTN15_NTv2_OSGBtoETRS.tif` 本机缺失
 * （Debian/Ubuntu `proj-bin` 不带它，判据作者与云 CI 都是这个环境）；而 Homebrew 的 `proj`
 * 把整个 proj-data（含 OSTN15）打进包里 ⇒ macOS 上该前提不成立，`--grid-check discard_missing`
 * 的丢弃与 "Grid … needed but not found" 诊断都看不到。
 *
 * 做法：探测系统 PROJ 的数据目录（含 proj.db 的那个），建一个逐项 symlink、唯独删掉 OSTN15
 * 的影子目录，再用 `PROJ_DATA` 指过去——对 PROJ 来说这就是"格网真的没装"。恢复函数还原环境。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const MISSING_GRID = 'uk_os_OSTN15_NTv2_OSGBtoETRS.tif'

/** `projinfo --searchpaths` 的实读数：与本仓 `runProjCommand` 同一条 PATH/MAP_CONSTRAINTS_PROJ_BIN_DIR 解析。 */
function projDataDirs(): string[] {
  const binDir = process.env.MAP_CONSTRAINTS_PROJ_BIN_DIR
  const projinfo = binDir ? join(binDir, 'projinfo') : 'projinfo'
  const out = spawnSync(projinfo, ['--searchpaths'], { encoding: 'utf8' })
  if (out.status !== 0) throw new Error(`PROJ 数据目录探测失败：projinfo --searchpaths 退出 ${out.status}（${(out.stderr ?? '').trim().slice(0, 200)}）`)
  return out.stdout.split('\n').map(line => line.trim()).filter(Boolean)
}

/**
 * 返回一个恢复函数。若 OSTN15 本就不装（如 Debian proj-bin），不改环境、返回空恢复；
 * 若装了（如 Homebrew proj），设 PROJ_DATA 为剔除该格网的影子目录，恢复时还原并清理。
 */
export function installMissingOstn15Grid(): () => void {
  const source = projDataDirs().find(dir => existsSync(join(dir, 'proj.db')))
  if (!source) throw new Error('找不到含 proj.db 的 PROJ 数据目录（请先用 MAP_CONSTRAINTS_PROJ_BIN_DIR 或 PATH 指向可用 PROJ）')
  if (!existsSync(join(source, MISSING_GRID))) return () => {}
  const shadow = mkdtempSync(join(tmpdir(), 'proj-no-ostn15-'))
  for (const entry of readdirSync(source)) {
    if (entry === MISSING_GRID) continue
    symlinkSync(join(source, entry), join(shadow, entry))
  }
  const previous = process.env.PROJ_DATA
  process.env.PROJ_DATA = shadow
  return () => {
    if (previous === undefined) delete process.env.PROJ_DATA
    else process.env.PROJ_DATA = previous
    rmSync(shadow, { recursive: true, force: true })
  }
}
