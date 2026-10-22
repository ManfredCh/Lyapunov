/**
 * Campaign 持久化：`<session 工作目录>/.lyapunov/campaigns/<campaignId>/`
 *   · campaign.json          — Campaign 全量（含 tasks/used 预算读数），整体重写，tmp+rename 原子落位；
 *   · runs/<runId>/calls.jsonl — 每次工具调用追加一行 RunCallArtifact（append-only 证据轨迹）；
 *   · runs/<runId>/run.json    — CampaignRun 汇总：open 时写 calls:[]，record_run 关闭时嵌入完整 calls。
 *
 * 全部对象经 JSON.stringify/parse 往返可重建（契约 §0.7：禁 Map/Set/class 实例进文件）。
 * "session 工作目录" 与 scene-kit 同一事实：原生会话 `session.header.cwd`（工具 exec.agent、
 * 命令 invocation.agent 都能取）；取不到就明确失败，不落宿主进程 cwd。
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SESSION_SCOPE_UNAVAILABLE } from '../../lyapunov-contracts/src/session-scope.ts'
import type { Campaign, CampaignRun, RunCallArtifact } from '../../lyapunov-contracts/src/agent-graph.ts'

export const CAMPAIGN_NOT_FOUND = 'CAMPAIGN_NOT_FOUND'
export const CAMPAIGN_INVALID_ID = 'CAMPAIGN_INVALID_ID'
export const CAMPAIGN_ALREADY_EXISTS = 'CAMPAIGN_ALREADY_EXISTS'

const ID_PATTERN = /^[A-Za-z0-9._-]+$/

/** campaignId/runId 直接进文件路径：拒绝空白、路径分隔符与 . / ..，防目录逃逸。 */
export function assertSafeId(value: unknown, label: string): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id || id === '.' || id === '..' || !ID_PATTERN.test(id)) {
    throw new Error(`${CAMPAIGN_INVALID_ID}: ${label} 只接受 [A-Za-z0-9._-]（收到 ${describeId(value)}）`)
  }
  return id
}

function describeId(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  return typeof value
}

/**
 * session 工作目录的默认解析：原生会话 header.cwd（与 bash/终端/scene 同一事实）。
 * 无会话（CLI/SDK 无 agent）→ SESSION_SCOPE_UNAVAILABLE，绝不落到宿主进程 cwd。
 */
export function defaultSessionWorkDir(owner: unknown): string {
  const cwd = (owner as { session?: { header?: { cwd?: unknown } } } | undefined)?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.trim()) return resolve(cwd)
  throw new Error(`${SESSION_SCOPE_UNAVAILABLE}: campaign 持久化需要会话工作目录（session.header.cwd），当前执行上下文没有可核实的会话`)
}

/** 文件写入统一走"临时文件 + rename"：读到的要么是完整旧版要么是完整新版，没有半写 JSON。 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${randomUUID()}`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(temporary, path)
}

/** JSONL 追加一行（calls.jsonl 的 append-only 证据轨迹）。 */
export async function appendJsonl(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, JSON.stringify(value) + '\n', 'utf8')
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  let text: string
  try { text = await readFile(path, 'utf8') } catch { return [] }
  return text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as T)
}

/** CampaignStore：所有路径都从 owner 的会话工作目录推出，调用方不自己拼路径。 */
export class CampaignStore {
  constructor(private readonly workDirFor: (owner: unknown) => string) {}

  campaignsRoot(owner: unknown): string {
    return join(this.workDirFor(owner), '.lyapunov', 'campaigns')
  }

  campaignDirFor(owner: unknown, campaignId: string): string {
    return join(this.campaignsRoot(owner), assertSafeId(campaignId, 'campaignId'))
  }

  runDirFor(owner: unknown, campaignId: string, runId: string): string {
    return join(this.campaignDirFor(owner, campaignId), 'runs', assertSafeId(runId, 'runId'))
  }

  campaignPath(dir: string): string { return join(dir, 'campaign.json') }
  callsPath(runDir: string): string { return join(runDir, 'calls.jsonl') }
  runPath(runDir: string): string { return join(runDir, 'run.json') }

  /** 目录内是否存在 campaign.json（init 判重）。 */
  async campaignExists(dir: string): Promise<boolean> {
    try { await readFile(this.campaignPath(dir), 'utf8'); return true } catch { return false }
  }

  async saveCampaignAt(dir: string, campaign: Campaign): Promise<void> {
    await writeJsonAtomic(this.campaignPath(dir), campaign)
  }

  async saveCampaign(owner: unknown, campaign: Campaign): Promise<void> {
    await this.saveCampaignAt(this.campaignDirFor(owner, campaign.campaignId), campaign)
  }

  async loadCampaign(owner: unknown, campaignId: string): Promise<Campaign> {
    const dir = this.campaignDirFor(owner, campaignId)
    let text: string
    try { text = await readFile(this.campaignPath(dir), 'utf8') } catch {
      throw new Error(`${CAMPAIGN_NOT_FOUND}: ${dir} 下没有 campaign.json`)
    }
    return JSON.parse(text) as Campaign
  }

  /** 开 run：建 runs/<runId>/、写初始 run.json（calls 空、无 summary）、落空 calls.jsonl。 */
  async openRunAt(runDir: string, run: CampaignRun): Promise<void> {
    await mkdir(runDir, { recursive: true })
    await writeJsonAtomic(this.runPath(runDir), { ...run, calls: [], summary: undefined })
    await appendFile(this.callsPath(runDir), '', 'utf8')
  }

  async appendCallTo(runDir: string, artifact: RunCallArtifact): Promise<void> {
    await appendJsonl(this.callsPath(runDir), artifact)
  }

  /** 关闭/刷新 run.json：把 calls.jsonl 重新读出并整体嵌入，使 run.json 自含可重建。 */
  async writeRunAt(runDir: string, run: CampaignRun): Promise<void> {
    const calls = await readJsonl<RunCallArtifact>(this.callsPath(runDir))
    await writeJsonAtomic(this.runPath(runDir), { ...run, calls })
  }

  async loadRunAt(runDir: string): Promise<CampaignRun | undefined> {
    try {
      const run = JSON.parse(await readFile(this.runPath(runDir), 'utf8')) as CampaignRun
      run.calls = await readJsonl<RunCallArtifact>(this.callsPath(runDir))
      return run
    } catch { return undefined }
  }
}
