#!/usr/bin/env node
// doctor-env：按 docs/ENVIRONMENT_SPEC.md §6 对表自检，输出 PASS/PARTIAL/BLOCKED/UNVERIFIED/SKIP。
// 用法：node script/doctor-env.ts [--json] [--strict]
// 用途：安装后自检 + 环境回执附件。任何不符即在安装回执记「差异：项/实测/原因/影响范围」。
// 纪律：本脚本不打印任何凭据值；网络检查只取状态码与耗时。
//
// 2026-09-26（W14）两处结构性变化，都不改既有行 id（收敛清单 §2 逐字引用了 1a…5、7a、7b）：
//  · §2 GPU 从两态（可用/不可用）升为**分型**：无卡／驱动没装／驱动挂了／设备被会话隐藏／显存不足／
//    驱动过旧／读不到 —— 判据与话术来自 `packages/lyapunov-shell/src/environment-readiness.ts`，
//    和产品界面用的是**同一份**（D1 预检 + D2 降级 + D3 处置，界面上的一屏见 §7）。
//  · §7 新增：环境就绪面板总评 + D1–D4 契约自检（声明↔面板行↔判定三者的漂移会被这条抓住）。
//    行 id 取 7c/7d：7a/7b 是规格 §6 第 7 行的既有 id（端口/运行根），沿用同一 7 系列编号保持输出连续。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ENVIRONMENT_DECLARATIONS, environmentPanel, environmentRowById, environmentPanelWording, evaluateEnvironment,
  gpuRuntimeDecision, probeEnvironmentFacts,
  type EnvironmentPanel, type EnvironmentReport, type EnvironmentRow, type EnvironmentStatus,
} from '../packages/lyapunov-shell/src/environment-readiness.ts'

const DEV_ROOT = join(fileURLToPath(import.meta.url), '..', '..')
type Status = 'PASS' | 'PARTIAL' | 'BLOCKED' | 'UNVERIFIED' | 'SKIP'
interface Check { id: string; title: string; status: Status; reading: string; note?: string }
const results: Check[] = []
const push = (c: Check) => { results.push(c); return c }

function sh(cmd: string, args: string[], timeoutMs = 8000): { out: string; code: number } {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })
    return { out: out.trim(), code: 0 }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number }
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim(), code: err.status ?? 1 }
  }
}

async function httpHead(url: string, timeoutMs: number): Promise<{ code: number; ms: number } | { error: string }> {
  const t0 = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(url, { method: 'GET', signal: controller.signal })
    clearTimeout(timer)
    return { code: res.status, ms: Date.now() - t0 }
  } catch (e) {
    return { error: `${(e as Error).name}: ${(e as Error).message}` }
  }
}

/** 面板状态 → 对表状态：unknown 归 UNVERIFIED（**不是** PASS），missing/broken 才 BLOCKED。 */
const toStatus = (status: EnvironmentStatus): Status =>
  status === 'ready' ? 'PASS' : status === 'unknown' ? 'UNVERIFIED' : status === 'degraded' ? 'PARTIAL' : 'BLOCKED'

// 宿主读数只探测一次，§2 与 §7 共用（避免同一件事读两遍、也避免两份读数互相打架）。
const facts = probeEnvironmentFacts({ productRoot: DEV_ROOT })

// 1. 运行时
{
  const nodeMajor = Number(process.versions.node.split('.')[0])
  push({ id: '1a', title: 'Node.js ≥24', status: nodeMajor >= 24 ? 'PASS' : 'BLOCKED', reading: process.versions.node })
  const bunPath = ['/usr/local/bin/bun', `${process.env.HOME}/.bun/bin/bun`].find((p) => existsSync(p))
  const bun = bunPath ? sh(bunPath, ['--version']) : sh('bun', ['--version'])
  push({ id: '1b', title: 'Bun 1.3.x（应在 PATH）', status: bun.code === 0 ? (sh('bun', ['--version']).code === 0 ? 'PASS' : 'PARTIAL') : 'BLOCKED',
    reading: bun.code === 0 ? `bun ${bun.out}` : '未安装', note: bun.code === 0 && sh('bun', ['--version']).code !== 0 ? `已安装但不在 PATH（${bunPath}），安装方需加入 PATH 或申报差异` : undefined })
  const py = sh('python3', ['--version'])
  const pyOk = py.code === 0 && /3\.10\./.test(py.out)
  push({ id: '1c', title: 'Python 3.10.x（Provider 前缀同源）', status: pyOk ? 'PASS' : py.code === 0 ? 'PARTIAL' : 'BLOCKED', reading: py.out || '未安装', note: pyOk ? undefined : '版本偏离 3.10.x 须申报差异' })
  const mm = sh('micromamba', ['--version'])
  const mmPath = mm.code === 0 ? sh('which', ['micromamba']).out : ''
  push({ id: '1d', title: 'micromamba（install-provider 前置）', status: mm.code === 0 ? 'PASS' : 'BLOCKED', reading: mm.code === 0 ? mm.out : '未安装', note: mm.code === 0 ? undefined : '装 MuJoCo/Isaac Provider 前必须先备（面板行 tool.micromamba 同此判据）' })
  if (mmPath) facts.micromamba = mmPath   // 面板行与 §1d 用同一个判据，不让两处读数漂移
  push({ id: '1e', title: 'CPU/内存基线（≥8核/≥32G）', status: cpus().length >= 8 && totalmem() >= 32 * 2 ** 30 ? 'PASS' : 'PARTIAL', reading: `${cpus().length} 核 / ${(totalmem() / 2 ** 30).toFixed(0)}G` })
}

// 2. GPU/驱动（分型；判据与话术来自环境契约，与产品面板是同一份）
// W21：这里同时是**运行时决策**的读数源——`device-hidden` 必须说清"卡和驱动都好、只是本会话看不见设备"。
const gpuDecision = gpuRuntimeDecision(facts.gpu)
{
  const row = environmentRowById(panelOf(), 'gpu')!   // 见下方 panelOf：§4-5 的端点读数还没测，先只取 GPU 行
  const footnote = row.uncertain ? '（本条带 uncertain：这是**本会话**的可见性读数，不是客户机故障）' : ''
  push({
    id: '2', title: `GPU/驱动（${row.state}）`, status: toStatus(row.status), reading: row.reading,
    note: `一句话结论：${gpuDecision.headline}｜CPU 替代：${gpuDecision.cpuFallback.reason}｜处置：${row.remedy.summary}${footnote}`,
  })
}

// 3. Provider 就绪（只给指针，不冒充已验）+ 运行时存在性（3a/3b/3c：只说"在不在"，不冒充验收）
push({ id: '3', title: '物理 Provider', status: 'UNVERIFIED', reading: '需逐 Provider 验证', note: '运行 ./lyapunov doctor mujoco（发行包）或 distribution/linux/install-provider <name>；本脚本不冒充引擎验收' })
{
  const letters = ['3a', '3b', '3c'] as const
  facts.runtimes.forEach((runtime, index) => {
    const present = runtime.interpreter && runtime.sdk
    const title = `运行时存在性：${runtime.engine}`
    const reading = `${present ? '就位' : runtime.interpreter ? '解释器在但 SDK 未装入（装了一半）' : '未安装'} — ${runtime.python}（${runtime.source === 'env-override' ? '环境变量覆盖' : '包内落点'}）`
    push({ id: letters[index]!, title, status: present ? 'PASS' : 'PARTIAL', reading,
      note: present ? '仅存在性：**不等于**引擎验收（同上 §3）' : '缺该运行时不属本机故障；要它就 `./lyapunov install-provider <engine>`（前置见 §1d）' })
  })
}

// 4-5. 网络端点
const endpointReports: EnvironmentReport[] = []
const endpoints: Array<[string, string, number, (c: number) => Status, (c: number, ms: number) => string | undefined]> = [
  ['4', 'https://api.vorynel.com/health', 12000, (c) => (c === 200 ? 'PASS' : 'BLOCKED'), (c) => (c === 200 ? undefined : `期望 200 实得 ${c}`)],
  ['5', 'https://hf-mirror.com/', 30000, (c) => (c === 200 ? 'PASS' : 'PARTIAL'), (_c, ms) => (ms > 30000 ? '响应 >30s：大件下载需有界重试' : undefined)],
]
for (const [id, url, timeout, toStatusOf, note] of endpoints) {
  const r = await httpHead(url, timeout)
  if ('error' in r) {
    push({ id, title: `端点 ${url}`, status: 'BLOCKED', reading: r.error })
    endpointReports.push({ status: 'broken', reading: `${url} 不可达：${r.error}`, evidence: [`GET ${url} → ${r.error}`] })
  } else {
    const status = toStatusOf(r.code)
    push({ id, title: `端点 ${url}`, status, reading: `HTTP ${r.code} ${r.ms}ms`, note: note?.(r.code, r.ms) })
    endpointReports.push({ status: status === 'PASS' ? 'ready' : status === 'PARTIAL' ? 'degraded' : 'broken', reading: `${url} → HTTP ${r.code} ${r.ms}ms`, evidence: [`GET ${url} → HTTP ${r.code}（${r.ms}ms）`] })
  }
}
// 面板的"出网能力"行用上面两条真实读数，不另做一次出网探测。
facts.network = endpointReports.some((report) => report.status === 'broken') ? { ...endpointReports.find((report) => report.status === 'broken')! }
  : endpointReports.some((report) => report.status === 'degraded') ? { ...endpointReports.find((report) => report.status === 'degraded')! }
  : { status: 'ready', reading: endpointReports.map((report) => report.reading).join('；'), evidence: endpointReports.flatMap((report) => report.evidence ?? []) }
// 付费额度**不探测**：本脚本无凭据、也不打印凭据（旧 openrouter 端点已退役，不复活）。面板行会如实报 unknown。

// 6. 端口/磁盘
{
  const ss = sh('ss', ['-ltn'])
  const busy = ['4180', '8787'].filter((p) => new RegExp(`:${p}\\b`).test(ss.out))
  push({ id: '7a', title: '端口 4180/8787 无冲突', status: busy.length === 0 ? 'PASS' : 'PARTIAL', reading: busy.length ? `占用中: ${busy.join(',')}` : '空闲', note: busy.length ? '被既有实例占用属正常，部署时申报' : undefined })
  const df = sh('df', ['-Pm', DEV_ROOT])
  const line = df.out.split('\n')[1] ?? ''
  const availMb = Number(line.split(/\s+/)[3])
  const ok = Number.isFinite(availMb) && availMb >= 200 * 1024
  push({ id: '7b', title: '运行盘 ≥200G 空闲', status: ok ? 'PASS' : 'PARTIAL', reading: Number.isFinite(availMb) ? `${(availMb / 1024).toFixed(0)}G @ ${DEV_ROOT}` : df.out.slice(0, 120) })
}

// 7. 环境就绪面板与 D1–D4 契约（N1/N4）：把"缺了怎么办"从散落的行为变成可对表的一屏
const panel = panelOf(facts.network)
{
  const overall = panel.overall
  const unknowns = panel.unknown
  push({
    id: '7c', title: '环境就绪面板（总评）', status: overall === 'ready' ? 'PASS' : overall === 'unusable' ? 'BLOCKED' : 'PARTIAL',
    reading: panel.summary,
    note: `${panel.rows.length} 项：${panel.rows.map((row) => `${row.id}=${row.status}`).join(' ')}${unknowns.length > 0 ? `｜unknown ≠ ready：${unknowns.join('、')} 必须显示"怎么测清楚"，不许留空` : ''}`,
  })
  // D4 的可判定部分：声明↔面板行↔判定三者不许漂移；每行必须有影响面、处置与回归测试锚点。
  const missingRows = ENVIRONMENT_DECLARATIONS.flatMap((declaration) => declaration.requires.filter((requirement) => environmentRowById(panel, requirement.id) === undefined).map((requirement) => `${declaration.feature}→${requirement.id}`))
  const thinRows = panel.rows.filter((row) => row.impact.trim() === '' || row.remedy.summary.trim() === '' || row.contractTest.trim() === '').map((row) => row.id)
  const verdicts = ENVIRONMENT_DECLARATIONS.map((declaration) => evaluateEnvironment(declaration, panel))
  const tally = (status: string) => verdicts.filter((verdict) => verdict.status === status).length
  push({
    id: '7d', title: 'D1–D4 契约自检（声明↔面板行↔判定）', status: missingRows.length === 0 && thinRows.length === 0 ? 'PASS' : 'BLOCKED',
    reading: `${ENVIRONMENT_DECLARATIONS.length} 条声明 × ${panel.rows.length} 行依赖：就绪 ${tally('ready')}、降级 ${tally('degraded')}、明确拒绝 ${tally('blocked')}`,
    note: missingRows.length === 0 && thinRows.length === 0
      ? '每条依赖都能在面板里找到行、每行都有「状态+影响+处置+回归测试锚点」；D1 预检 / D2 降级可解释 / D3 无替代则明确拒绝 / D4 回归测试（见 packages/lyapunov-shell/test/environment-readiness.test.ts）'
      : `契约漂移：未登记依赖 ${missingRows.join('、') || '无'}；缺要件行 ${thinRows.join('、') || '无'}（必须在 environment-readiness.ts 补登记）`,
  })
}

/** §2 需要 GPU 行、§7 需要整屏：同一个事实集组两次面板，保证两处读数逐字一致。 */
function panelOf(network?: EnvironmentReport): EnvironmentPanel {
  return environmentPanel(network === undefined ? facts : { ...facts, network })
}

const strict = process.argv.includes('--strict')
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ spec: 'docs/ENVIRONMENT_SPEC.md#6', checked_at: new Date().toISOString(), results, readiness: panel, gpuDecision }, null, 1))
} else {
  console.log(`doctor-env 对表（docs/ENVIRONMENT_SPEC.md §6）  ${new Date().toISOString()}`)
  for (const r of results) console.log(`[${r.status.padEnd(9)}] ${r.id.padEnd(3)} ${r.title} — ${r.reading}${r.note ? `  ⚠ ${r.note}` : ''}`)
  // W21：GPU 解释链单列一段（卡 → 驱动 → 设备 → 结论 → 处置），回执里要贴的就是这一段。
  console.log(`\nGPU 解释链（卡 → 驱动 → 设备 → 结论 → 处置）· 运行时结论：${gpuDecision.headline}\n${gpuDecision.explanation.join('\n')}`)
  console.log(`CPU 替代路径：${gpuDecision.cpuFallback.reason}\n怎么改回：${gpuDecision.cpuFallback.restore}${gpuDecision.gpuRequired.blocked ? `\n需要 GPU 的能力将被明确拒绝：${gpuDecision.gpuRequired.code}` : ''}`)
  // 非就绪时把统一话术（四句 + 处置步骤）整段打印出来：回执里要贴的就是这一段。
  const rows = panel.rows.filter((row: EnvironmentRow) => row.status !== 'ready')
  if (rows.length > 0) console.log(`\n环境就绪 · 统一话术（与产品界面同一份，D2/D3）\n${environmentPanelWording(panel).join('\n')}`)
}
const blocked = results.filter((r) => r.status === 'BLOCKED').length
if (strict && blocked > 0) process.exit(1)
