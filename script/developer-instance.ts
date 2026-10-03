/** 开发者通道多实例协调：端口自动让位 + 运行根目录认领。桌面通道的单实例锁在 packages/desktop，与这里无关。 */
import { createServer } from 'node:net'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 从首选端口起递增探测空闲端口（至多 +limit，且不超过 65535）。
 * preferred 为 0 时保持操作系统随机分配语义，直接返回 0。
 */
export async function findAvailablePort(preferred: number, limit = 100): Promise<number> {
  if (preferred === 0) return 0
  const last = Math.min(preferred + limit, 65_535)
  for (let port = preferred; port <= last; port++) {
    if (await portFree(port)) return port
  }
  throw new Error(`端口 ${preferred}–${last} 都被占用；请在 YAML 里换一个首选端口，或把 port 改为 0 交给操作系统分配`)
}

function portFree(port: number): Promise<boolean> {
  return new Promise(done => {
    const probe = createServer()
    probe.once('error', () => done(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)))
  })
}

export type InstanceClaim = {
  /** 实际认领的运行根目录。 */
  root: string
  /** 1 表示默认根；N>1 表示退到 <base>-N。 */
  sequence: number
  /** 占位的兄弟实例（仅退让时给出，用于启动提示）。 */
  holder?: { pid: number; root: string }
}

/**
 * 认领一个开发者运行根：依次尝试 base、base-2 …、base-max。
 * 候选根里的 instance.json 指向活进程则跳过；指向死进程或内容损坏则视为 stale 删除后认领。
 * 认领用 wx 旗标原子写入，并发冲突自动试下一个候选；全部候选被活实例占用时报错。
 */
export function claimRuntimeRoot(input: { base: string; port: number; productRoot: string; max?: number }): InstanceClaim {
  const max = input.max ?? 16
  const base = resolve(input.base)
  let holder: InstanceClaim['holder']
  for (let sequence = 1; sequence <= max; sequence++) {
    const root = sequence === 1 ? base : `${base}-${sequence}`
    const file = join(root, 'instance.json')
    const occupant = readClaimPid(file)
    if (occupant === 'stale') rmSync(file, { force: true })
    else if (occupant !== 'none') {
      if (pidAlive(occupant)) { holder ??= { pid: occupant, root }; continue }
      rmSync(file, { force: true })
    }
    mkdirSync(root, { recursive: true })
    try {
      const receipt = { pid: process.pid, port: input.port, startedAt: new Date().toISOString(), productRoot: input.productRoot }
      writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
      registerRelease(file)
      return { root, sequence, holder }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const rival = readClaimPid(file)
      holder ??= { pid: typeof rival === 'number' ? rival : 0, root }
    }
  }
  throw new Error(`开发者运行根 ${base} 及 -2 到 -${max} 后缀目录都被运行中的实例占用；若确认这些实例已经退出，删除对应目录下的 instance.json 后重试`)
}

/** 读候选根的 instance.json：'none' 无文件，'stale' 内容不可信，数字为认领者 pid。 */
function readClaimPid(file: string): number | 'stale' | 'none' {
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch { return 'none' }
  try {
    const pid = Number((JSON.parse(raw) as { pid?: unknown }).pid)
    return Number.isInteger(pid) && pid > 0 ? pid : 'stale'
  } catch { return 'stale' }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/** 退出时只删除自己写的那份 instance.json：删除前再读一次比对 pid，避免误删继任者的认领。 */
function registerRelease(file: string) {
  let released = false
  const release = () => {
    if (released) return
    released = true
    try { if (readClaimPid(file) === process.pid) rmSync(file, { force: true }) } catch { /* 退出阶段的清理失败不掩盖原退出码 */ }
  }
  process.once('exit', release)
  process.once('SIGINT', release)
  process.once('SIGTERM', release)
}
