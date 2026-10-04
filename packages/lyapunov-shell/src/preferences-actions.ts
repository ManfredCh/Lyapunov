import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { Preferences, ShortcutAction } from './preferences.ts'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { neighboringUnreadSession } from './preferences-notification-state.ts'
import { legacyThemePresets } from './preferences-theme-data.ts'
import { mainSessionId } from './history-navigation.ts'

/** 有界快捷键调用表；每个操作直接委托已有所有者，不维护另一份选择状态。 */
export async function executePreferenceShortcut(ctx: Context, action: ShortcutAction, preferences?: ConfigForm<Preferences>): Promise<void> {
  const sessions = ctx.get('sessions') as unknown as ISessions, list = sessions.list.getSnapshot(), id = mainSessionId(list)
  if (action === 'newSession') { ctx.uiWorkspace.startSession(); return }
  if (action === 'sidebar') { ctx.layout.toggleSidebar(); return }
  if (action === 'projectOpen' || action === 'projectPrevious' || action === 'projectNext') {
    const workspaces = ctx.get('workspaces') as unknown as IWorkspaces | undefined
    if (!workspaces) throw new Error('工作区功能未启用。')
    if (action === 'projectOpen') {
      const path = await ctx.uiWorkspace.pickDirectory(); if (path === null) return
      const workspace = await workspaces.create({ path })
      ctx.uiWorkspace.openSession(await ctx.uiWorkspace.connectWorkspace(workspace.workspaceId)); return
    }
    const snapshot = workspaces.list.getSnapshot()
    const current = snapshot.items.findIndex(workspace => id && workspace.sessionIds.includes(id))
    const target = snapshot.items[current + (action === 'projectPrevious' ? -1 : 1)]
    if (!target) return
    const recent = target.sessionIds.filter(sessionId => list.byId[sessionId] && !snapshot.archivedSessionIds.includes(sessionId)).sort((a, b) => list.byId[b]!.updatedAt - list.byId[a]!.updatedAt)[0]
    ctx.uiWorkspace.openSession(recent ?? await ctx.uiWorkspace.connectWorkspace(target.workspaceId)); return
  }
  if (action === 'themeCycle') { if (!preferences) throw new Error('主题偏好尚未就绪。'); const ids = ['native', ...legacyThemePresets.map(theme => theme.id)], current = preferences.getSnapshot().value?.themePalette ?? 'native'; await preferences.set('themePalette', ids[(ids.indexOf(current) + 1) % ids.length]); return }
  if (action === 'languageCycle') { const state = ctx.locale.getSnapshot(), index = state.locales.findIndex(locale => locale.id === state.active), next = state.locales[(index + 1) % state.locales.length]; if (next) ctx.locale.setLocale(next.id); return }
  if (!id) throw new Error('请先选择一个会话。')
  if (action === 'archiveSession') { await ctx.uiWorkspace.archiveSession(id); return }
  if (['previousSession', 'nextSession', 'previousCompleted', 'nextCompleted'].includes(action)) {
    const direction = action.startsWith('previous') ? -1 : 1, completedOnly = action.endsWith('Completed')
    if (completedOnly) {
      const reading = preferences?.getSnapshot().value
      if (!reading) throw new Error('未读偏好尚未就绪。')
      const workspaces = ctx.get('workspaces') as unknown as IWorkspaces | undefined, grouping = workspaces?.list.getSnapshot(), workspace = grouping?.items.find(workspace => workspace.sessionIds.includes(id))
      // 与普通导航/原生侧栏同一可见性：归档与子代理（origin === 'subagent'）不参与；
      // parentId 只是 fork 血缘（普通fork也有），不能当作子代理标记，否则普通fork的未读完成标记会被跳过。
      const ids = (workspace?.sessionIds ?? list.ids.filter(candidate => list.byId[candidate]?.cwd === list.byId[id]?.cwd)).filter(candidate => list.byId[candidate] && list.byId[candidate]?.origin !== 'subagent' && !grouping?.archivedSessionIds.includes(candidate))
      const target = neighboringUnreadSession(ids, id, direction, reading)
      if (target) ctx.uiWorkspace.openSession(target as typeof id)
      return
    }
    const workspaces = ctx.get('workspaces') as unknown as IWorkspaces | undefined, grouping = workspaces?.list.getSnapshot()
    const workspace = grouping?.items.find(workspace => workspace.sessionIds.includes(id))
    // 与原生侧栏一致：归档、子代理、非当前空白会话不参与导航；普通fork仍可见。
    const ids = (workspace?.sessionIds ?? list.ids.filter(candidate => list.byId[candidate]?.cwd === list.byId[id]?.cwd)).filter(candidate => {
      const session = list.byId[candidate]
      return session && session.origin !== 'subagent' && (!session.blank || candidate === id) && !grouping?.archivedSessionIds.includes(candidate)
    })
    const start = ids.indexOf(id)
    const next = ids[start < 0 ? (direction > 0 ? 0 : ids.length - 1) : (start + direction + ids.length) % ids.length]
    if (next && next !== id) ctx.uiWorkspace.openSession(next)
    return
  }
  const binding = sessions.binding(id), actx = sessions.scope(id)
  if (!binding || !actx) throw new Error('当前会话已不可用。')
  if (action === 'stopSession') { const result = await binding.session.cancel(); if (!result.ok) throw new Error(result.error.message); return }
  if (action === 'agentNext' || action === 'agentPrevious') {
    if (!list.byId[id]?.blank) throw new Error('Agent 只能在空白会话切换；请先新建会话。')
    const roster = await ctx.remote.agentPresets.list()
    if (!roster.ok) throw new Error(roster.error.message)
    const presets = roster.value.presets
    if (!presets.length) throw new Error('当前 Host 没有可选 Agent。')
    const current = list.byId[id]?.projectionValues?.agentPreset ?? presets.find(preset => preset.isDefault)?.id ?? presets[0]!.id
    const index = presets.findIndex(preset => preset.id === current), direction = action === 'agentNext' ? 1 : -1
    const selected = presets[(index + direction + presets.length) % presets.length]!
    const result = await ctx.remote.agentPresets.select(id, selected.id)
    if (!result.ok) throw new Error(result.error.message)
    return
  }
  if (action === 'modelReasoningCycle') {
    const models = ctx.get('modelDirectories'); if (!models) throw new Error('模型选择功能未启用。')
    const directory = models.directoryFor(id), state = await directory.load(), current = state.current
    const model = state.groups.find(group => group.id === current?.provider)?.models.find(model => model.id === current?.model)
    const efforts = model?.reasoning?.efforts
    if (!current || !efforts?.length) throw new Error('当前模型没有可循环的推理强度选项。')
    const index = efforts.findIndex(effort => effort.id === (current.reasoningEffort ?? model?.reasoning?.defaultEffort))
    await directory.select({ ...current, reasoningEffort: efforts[(index + 1) % efforts.length]!.id })
    return
  }
  const conversation = ctx.get('conversation'), triggers = ctx.get('inputTriggers')
  if (!conversation || !triggers) throw new Error('原生命令输入功能未启用。')
  const input = conversation.input.for(actx), state = input.state.getSnapshot()
  if (state.phase !== 'plain') throw new Error('当前输入正在提交或编辑命令，请先结束该操作。')
  const controller = triggers.sessionOf(actx)
  if (action === 'commandMenu') {
    // 同原生“命令”按钮的显式launcher，使用末尾空选区，保持已有草稿与附件。
    controller.toggleSource('command', { trigger: '/', query: '', quoted: false, position: state.draft.trim() ? 'inline' : 'leading', span: { start: state.draft.length, end: state.draft.length, draftRev: state.draftRev } })
    return
  }
  const command = action === 'modelChoose' ? '/model' : '/permission'
  const result = await controller.adjudicate(command, new AbortController().signal, { attachments: state.attachmentIds.length })
  if (result !== 'handled') throw new Error('当前会话不提供该原生选择器。')
}
