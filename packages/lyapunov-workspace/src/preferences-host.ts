import type {Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
import {LEGACY_WORKSPACE_PREFERENCES,WORKSPACE_PREFERENCES,workspaceDefaults,workspaceActions,validateWorkspaceShortcuts,type WorkspacePreferences} from './preferences.ts'
export const WorkspacePreferencesSchema:Schema<WorkspacePreferences>=Schema.object({autoSave:Schema.boolean().default(workspaceDefaults.autoSave),autoSaveDelayMs:Schema.number().min(250).max(10000).default(workspaceDefaults.autoSaveDelayMs),editorFontFamily:Schema.string().default(''),editorFontSize:Schema.number().min(10).max(28).default(14),terminalFontFamily:Schema.string().default(''),terminalFontSize:Schema.number().min(10).max(28).default(14),shortcuts:Schema.object(Object.fromEntries(workspaceActions.map(action=>[action,Schema.string().default(workspaceDefaults.shortcuts[action])]))).default(workspaceDefaults.shortcuts)}) as Schema<WorkspacePreferences>
export async function applyWorkspacePreferences(ctx: Context) {
 await ctx.inject(['settings'], async owner => {
  owner.settings.register(WORKSPACE_PREFERENCES, WorkspacePreferencesSchema, { validate: value => {
   validateWorkspaceShortcuts(value.shortcuts)
   for (const field of ['editorFontFamily', 'terminalFontFamily'] as const)
    if (value[field].length > 100 || /[\r\n\0]/.test(value[field])) throw new Error('字体名称长度须不超过100且不能包含控制换行')
  } })
  const existing = owner.settings.describe().find(item => item.ns === WORKSPACE_PREFERENCES)!
  if (existing.user !== undefined) return
  // 只借原生 Schema 读取旧段；旧命名空间不再作为运行时设置 owner 保留。
  let legacy: object | undefined
  const reader = owner.plugin({ name: 'lyapunov-workspace-preferences-migration', apply(reader: Context) {
   let reading = true
   reader.settings.register(LEGACY_WORKSPACE_PREFERENCES, WorkspacePreferencesSchema, { validate: () => {
    if (!reading) throw new Error('旧工作区偏好仅可读取迁移，请保存到当前偏好。')
   } })
   reading = false
   legacy = reader.settings.describe().find(item => item.ns === LEGACY_WORKSPACE_PREFERENCES)?.user as object | undefined
  } })
  try { await reader } finally { await reader.dispose() }
  if (legacy !== undefined) await owner.settings.replace(WORKSPACE_PREFERENCES, legacy, existing.revision)
 })
}
