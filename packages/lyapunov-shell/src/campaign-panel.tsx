/**
 * Campaign 面板卡片（纯展示组件，`docs/AGENT_GRAPH_CONTRACT.md` §6）。
 *
 * 读 `campaign-projection.ts` 折叠出的 `CampaignCard[]`，渲染：
 * - task 状态矩阵（一行一个 task：状态图标 + taskId/sceneId + partition/status 徽标）；
 * - 预算用量条（tool calls / sim steps / 墙钟，`used / max`，越界如实标 `--lya-bad`）。
 *
 * 本文件不持有状态、不发请求；数据由宿主经 `campaignsOf(ctx, session)` 或
 * 投影快照喂入。颜色一律走 workbench design token（`--lya-*`），不硬编码色值/透明度。
 */
import type {CSSProperties} from 'react'
import {EmptyState, FieldRow, ListRow, MetaBadge, PanelSection} from './panel-chrome.tsx'
import {WorkbenchIcon, type WorkbenchIconId} from './vendor/tabler/icons.tsx'
import type {Translate} from './entity-editor.tsx'
import type {CampaignCard, CampaignTaskRow, CampaignTaskStatus} from './campaign-projection.ts'

/** task 状态 → 矩阵行图标（纯展示映射，状态机真值仍在 agent-graph）。 */
export const TASK_STATUS_ICON: Record<CampaignTaskStatus, WorkbenchIconId> = {
  pending: 'recording',
  exploring: 'scene',
  debugging: 'terminal',
  verifying: 'physics',
  'heldout-eval': 'capture',
  done: 'deliverable',
  blocked: 'annotation',
  rejected: 'engine',
}

/** task 状态 → 徽标类名（沿用 `lya-badge`/`lya-badge-*`/`lya-warning`/`lya-error`/`lya-muted` 既有 token 类）。 */
export const TASK_STATUS_BADGE: Record<CampaignTaskStatus, string> = {
  pending: 'lya-badge lya-muted',
  exploring: 'lya-badge lya-badge-accent',
  debugging: 'lya-badge lya-badge-accent',
  verifying: 'lya-badge lya-badge-accent',
  'heldout-eval': 'lya-badge lya-badge-accent',
  done: 'lya-badge lya-badge-ok',
  blocked: 'lya-badge lya-warning',
  rejected: 'lya-badge lya-error',
}

/** campaign 状态 → 徽标类名。 */
export const CAMPAIGN_STATUS_BADGE: Record<CampaignCard['status'], string> = {
  running: 'lya-badge lya-badge-accent',
  completed: 'lya-badge lya-badge-ok',
  blocked: 'lya-badge lya-warning',
  aborted: 'lya-badge lya-error',
}

const STATUS_LABELS: Record<CampaignTaskStatus, [string, string]> = {
  pending: ['待启动', 'Pending'],
  exploring: ['探索', 'Exploring'],
  debugging: ['调试', 'Debugging'],
  verifying: ['验证', 'Verifying'],
  'heldout-eval': ['留出评测', 'Heldout eval'],
  done: ['完成', 'Done'],
  blocked: ['受阻', 'Blocked'],
  rejected: ['拒绝', 'Rejected'],
}

const CAMPAIGN_STATUS_LABELS: Record<CampaignCard['status'], [string, string]> = {
  running: ['运行中', 'Running'],
  completed: ['已完成', 'Completed'],
  blocked: ['受阻', 'Blocked'],
  aborted: ['已中止', 'Aborted'],
}

export function campaignStatusLabel(status: CampaignCard['status'], tr: Translate): string {
  const pair = CAMPAIGN_STATUS_LABELS[status]
  return pair === undefined ? status : tr(pair[0], pair[1])
}

export function taskStatusLabel(status: CampaignTaskStatus, tr: Translate): string {
  const pair = STATUS_LABELS[status]
  return pair === undefined ? status : tr(pair[0], pair[1])
}

/** 一条预算读数：用量、上限与越界判定——panel 的纯函数，便于测试。 */
export interface BudgetMeter {
  readonly key: 'toolCalls' | 'simSteps' | 'wall'
  readonly label: string
  readonly used: number
  readonly max: number
  /** `max<=0` 视为不设上限：`null` 表示不出用量条，只显读数。 */
  readonly fraction: number | null
  readonly exhausted: boolean
}

/** 把卡片的 `budget`/`used` 折成三条用量读数；墙钟按 `now`（epoch ms）从 `used.startedAt` 计。 */
export function budgetMetersOf(card: CampaignCard, tr: Translate, now: number): BudgetMeter[] {
  const elapsed = Math.max(0, Math.floor((now - Date.parse(card.used.startedAt)) / 1000))
  const meter = (key: BudgetMeter['key'], label: string, used: number, max: number): BudgetMeter => ({
    key,
    label,
    used,
    max,
    fraction: max > 0 ? Math.min(1, used / max) : null,
    exhausted: max > 0 && used >= max,
  })
  return [
    meter('toolCalls', tr('工具调用', 'Tool calls'), card.used.toolCalls, card.budget.maxToolCalls),
    meter('simSteps', tr('仿真步数', 'Sim steps'), card.used.simSteps, card.budget.maxSimSteps),
    meter('wall', tr('墙钟', 'Wall time'), elapsed, card.budget.maxWallSeconds),
  ]
}

const meterTrack: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 4,
  borderRadius: 99,
  background: 'var(--lya-line-2)',
  overflow: 'hidden',
}

/** 用量条：>=80% 转 `--lya-warn`、用尽转 `--lya-bad`，全走 token。 */
function MeterBar({meter}: {meter: BudgetMeter}) {
  if (meter.fraction === null) return null
  const tone = meter.exhausted ? '--lya-bad' : meter.fraction >= 0.8 ? '--lya-warn' : '--lya-ok'
  return <span
    role="meter"
    aria-valuemin={0}
    aria-valuemax={meter.max}
    aria-valuenow={meter.used}
    style={meterTrack}
  >
    <span style={{display: 'block', height: '100%', width: `${meter.fraction * 100}%`, background: `var(${tone})`, borderRadius: 99}}/>
  </span>
}

function TaskRow({task, tr}: {task: CampaignTaskRow; tr: Translate}) {
  const subtitle = task.blockedReason === undefined
    ? task.sceneId
    : `${task.sceneId} — ${task.blockedReason}`
  return <ListRow
    icon={TASK_STATUS_ICON[task.status] ?? 'recording'}
    title={task.taskId}
    subtitle={subtitle}
    hint={task.blockedReason}
    side={<span className="lya-row" style={{flexWrap: 'nowrap', gap: 4}}>
      {task.partition === 'heldout' && <span className="lya-badge">{tr('留出', 'heldout')}</span>}
      {task.heldoutResult !== undefined && <span className={task.heldoutResult.taskAchieved ? 'lya-badge lya-badge-ok' : 'lya-badge lya-error'}>{task.heldoutResult.taskAchieved ? tr('达成', 'achieved') : tr('未达', 'missed')}</span>}
      <span className={TASK_STATUS_BADGE[task.status] ?? 'lya-badge'}>{taskStatusLabel(task.status, tr)}</span>
    </span>}
  />
}

/** 单张 campaign 卡：小节头（id + 状态徽标）→ task 矩阵 → 预算用量条。 */
export function CampaignCardView({card, tr, now}: {card: CampaignCard; tr: Translate; now: number}) {
  const openRuns = card.openRunIds.length
  return <PanelSection
    label={card.campaignId}
    side={<span className={CAMPAIGN_STATUS_BADGE[card.status] ?? 'lya-badge'}>{campaignStatusLabel(card.status, tr)}</span>}
  >
    {card.tasks.length === 0
      ? <div className="lya-help">{tr('这个 campaign 还没有任务', 'No tasks in this campaign')}</div>
      : card.tasks.map(task => <TaskRow key={task.taskId} task={task} tr={tr}/>)}
    {budgetMetersOf(card, tr, now).map(meter => <FieldRow
      key={meter.key}
      label={meter.label}
      value={`${meter.used}${meter.key === 'wall' ? 's' : ''} / ${meter.max > 0 ? `${meter.max}${meter.key === 'wall' ? 's' : ''}` : '—'}`}
    >
      <MeterBar meter={meter}/>
    </FieldRow>)}
    {openRuns > 0 && <FieldRow label={tr('打开中的 run', 'Open runs')} value={String(openRuns)}/>}
    {card.lastError !== undefined && <FieldRow label={tr('最近拒绝', 'Last refusal')} value={card.lastError}/>}
  </PanelSection>
}

/**
 * Campaigns 面板主体：多张 `CampaignCard` 依次成节；空态如实说明本会话还没有 campaign。
 * @param now - 当前时刻（epoch ms），用于墙钟用量；默认可由宿主给 `Date.now()`。
 */
export function CampaignsPanel({campaigns, tr, now = Date.now()}: {
  campaigns: readonly CampaignCard[]
  tr: Translate
  now?: number
}) {
  if (campaigns.length === 0) {
    return <EmptyState icon="robot" title={tr('还没有 campaign', 'No campaigns yet')} detail={tr('本会话执行 campaign_init 后会出现在这里', 'campaign_init creates one for this session')}/>
  }
  return <>
    {campaigns.map(card => <CampaignCardView key={card.campaignId} card={card} tr={tr} now={now}/>)}
  </>
}
